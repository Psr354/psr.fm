import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../static/js/player.js', import.meta.url), 'utf8');
const listeners = {};
const sessions = new Map();
const errors = [];
let nextSession = 0;
let resolvePlay;
let deferPlay = false;
let rejectListen = false;
const state = {
    currentPlayingSongId: '1', playbackStatisticsSongId: '1', playbackRequestId: 0, playEventLogged: false,
    playbackSessionId: null, playbackSessionPromise: null, lastLoggedTime: 0,
    repeatMode: 2,
};
const audio = {
    currentTime: 0, duration: 338, paused: false,
    addEventListener(name, handler) { listeners[name] = handler; },
};
const context = vm.createContext({
    state, el: { audio }, navigator: {},
    console: { error: (...args) => errors.push(args) },
    isOfflineMode: () => false,
    savePlaybackState: () => {},
    resumeCurrentSong: () => { audio.paused = false; listeners.play(); listeners.playing(); },
    startLyricAnimation() {}, stopLyricAnimation() {}, updateMediaSessionPosition() {},
    updateSyncedLyrics() {},
    fetch: async (url, options) => {
        if (url.endsWith('/play')) {
            const id = `psr354-session-${++nextSession}`;
            sessions.set(id, 0);
            const response = { ok: true, json: async () => ({ playback_session_id: id }) };
            if (deferPlay) return new Promise(resolve => { resolvePlay = () => resolve(response); });
            return response;
        }
        const { seconds, playback_session_id: id } = JSON.parse(options.body);
        assert.ok(sessions.has(id), 'Listening must use an existing session');
        assert.ok(seconds > 0 && seconds <= 30);
        const total = sessions.get(id) + seconds;
        if (rejectListen || total > audio.duration) return { ok: false, status: 409 };
        sessions.set(id, total);
        return { ok: true };
    },
});
const playTimestamps = [];
context.listeningSync = {
    async play(songId, occurredAt) {
        playTimestamps.push(occurredAt);
        return (await (await context.fetch(`/api/songs/${songId}/play`, {})).json()).playback_session_id;
    },
    async listen(songId, sessionId, seconds) {
        const response = await context.fetch('/api/listen', { body: JSON.stringify({ song_id: songId, playback_session_id: sessionId, seconds }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
};

function loadBetween(start, end) {
    const offset = source.indexOf(start);
    assert.ok(offset >= 0);
    const stop = source.indexOf(end, offset);
    assert.ok(stop > offset);
    vm.runInContext(source.slice(offset, stop), context);
}
loadBetween("    el.audio.addEventListener('timeupdate'", "    el.audio.addEventListener('canplay'");
loadBetween('    function flushListenLog()', '    const seekFromPointer');
loadBetween('    async function logPlay(', '    function releaseOfflineAudioUrl');
loadBetween('    function playNext(', '    function playPrev(');
const settle = () => new Promise(resolve => setImmediate(resolve));

// Each full repeat must add 338 seconds to its own session, including the tail.
listeners.play();
listeners.playing();
await settle();
for (let repeat = 0; repeat < 3; repeat++) {
    for (let second = 5; second <= 335; second += 5) {
        audio.currentTime = second;
        listeners.timeupdate();
    }
    audio.currentTime = 338;
    audio.paused = true;
    listeners.pause();
    if (repeat < 2) listeners.ended();
    await settle();
}
assert.deepEqual([...sessions.values()], [338, 338, 338]);
assert.equal(nextSession, 3, 'Exactly one play per repetition');

// Skipping or pausing before 3 seconds of heard audio must NOT count as a play.
state.playbackRequestId++;
state.playEventLogged = false;
state.pendingPlaySeconds = 0;
audio.currentTime = 0;
audio.paused = false;
listeners.play();
listeners.playing();
audio.currentTime = 2.5;
listeners.pause();
await settle();
assert.equal(nextSession, 3, 'Under 3 seconds must not create a play');

// Resuming the same song and crossing 3 total heard seconds counts 1 play and flushes all heard time.
audio.paused = false;
listeners.play();
listeners.playing();
audio.currentTime = 3;
listeners.pause();
listeners.pause();
await settle();
assert.equal(sessions.get('psr354-session-4'), 3);
listeners.play();
listeners.playing();
await settle();
assert.equal(nextSession, 4);

// A slow play response must preserve listening for the old playback even if
// another repetition starts before its response arrives.
deferPlay = true;
audio.paused = false;
state.playEventLogged = false;
state.pendingPlaySeconds = 0;
state.playbackRequestId++;
audio.currentTime = 0;
listeners.play();
listeners.playing();
audio.currentTime = 5;
listeners.timeupdate();
const completeOldPlay = resolvePlay;
deferPlay = false;
context.playNext(true);
audio.currentTime = 3;
listeners.timeupdate();
await settle();
const newestSession = state.playbackSessionId;
completeOldPlay();
await settle();
assert.equal(sessions.get('psr354-session-5'), 5);
assert.equal(state.playbackSessionId, newestSession, 'Old response must not replace new session');

// A seek must save only actual playback, including when pause/timeupdate arrive
// before seeked (mobile pointer controls and keyboard/media-session seeks).
state.playEventLogged = false;
state.pendingPlaySeconds = 0;
state.playbackRequestId++;
audio.currentTime = 0;
audio.paused = false;
listeners.play();
listeners.playing();
audio.currentTime = 3;
context.seekAudio(180);
listeners.timeupdate();
listeners.pause();
listeners.seeked();
await settle();
const seekSession = state.playbackSessionId;
assert.equal(sessions.get(seekSession), 3, 'Skip to 3:00 must not log the skipped 177 seconds');
listeners.play();
audio.currentTime = 185;
listeners.timeupdate();
await settle();
assert.equal(sessions.get(seekSession), 8, 'Listening after seek resumes normally');

// Native seeking can report timeupdate before seeking/seeked; its seeking flag
// protects both the periodic recorder and the delayed pause handler.
audio.seeking = true;
audio.currentTime = 250;
listeners.timeupdate();
listeners.pause();
listeners.seeking();
audio.seeking = false;
listeners.seeked();
audio.currentTime = 255;
listeners.timeupdate();
await settle();
assert.equal(sessions.get(seekSession), 13);
state.isSeeking = true;
audio.currentTime = 300;
listeners.timeupdate();
listeners.pause();
state.isSeeking = false;
listeners.seeked();
audio.currentTime = 305;
listeners.timeupdate();
await settle();
assert.equal(sessions.get(seekSession), 18, 'Dragging the progress bar must not add skipped seconds');

// Background/throttled initial playback (>10s before first timeupdate) must backdate play occurredAt
// so the server's elapsed-time window accepts the full initial listening chunk.
state.playEventLogged = false;
state.pendingPlaySeconds = 0;
state.playbackRequestId++;
audio.currentTime = 0;
audio.paused = false;
listeners.play();
listeners.playing();
const beforeBackgroundPlay = Date.now();
audio.currentTime = 25;
listeners.timeupdate();
await settle();
const backdatedMs = Date.parse(playTimestamps.at(-1));
assert.ok(Number.isFinite(backdatedMs), 'play must receive an ISO occurredAt timestamp');
assert.ok(beforeBackgroundPlay - backdatedMs >= 24000 && beforeBackgroundPlay - backdatedMs <= 26500,
    'play occurredAt must be backdated by the initial heard seconds');

// Preview of another user's library item must not create rejected stats events.
const beforePreview = nextSession;
state.playEventLogged = false;
state.playbackStatisticsSongId = null;
state.playbackRequestId++;
audio.currentTime = 0;
listeners.play();
listeners.playing();
audio.currentTime = 5;
listeners.timeupdate();
await settle();
assert.equal(nextSession, beforePreview);
state.playbackStatisticsSongId = '1';
state.playbackSessionPromise = Promise.resolve(seekSession);

rejectListen = true;
await context.logListen('1', 5);
assert.equal(errors.length, 1, 'HTTP rejection must be reported');
assert.match(errors[0][1].message, /409/);

// Reload mid-song must restore playbackSessionId & playEventLogged instead of logging +1 duplicate play.
rejectListen = false;
const syncSource = fs.readFileSync(new URL('../../static/js/playback-sync.js', import.meta.url), 'utf8');
const localStore = new Map();
const syncFetches = [];
const syncAudio = {
    currentTime: 90, duration: 338, paused: false, volume: 0.8, muted: false, src: '',
    listeners: {},
    getAttribute() { return this.src; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name]; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
};
const syncWindow = {
    location: { origin: 'http://localhost' },
    addEventListener: () => {},
    removeEventListener: () => {},
};
const syncContext = vm.createContext({
    window: syncWindow,
    document: {
        body: { dataset: { userId: '1' } },
        visibilityState: 'visible',
        getElementById: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
    },
    navigator: { onLine: true },
    localStorage: {
        getItem: (k) => localStore.get(k) ?? null,
        setItem: (k, v) => localStore.set(k, String(v)),
    },
    URL,
    setTimeout,
    clearTimeout,
    fetch: (url, opts) => {
        syncFetches.push({ url, opts });
        return Promise.resolve({ ok: true, json: async () => ({}) });
    },
});
vm.runInContext(syncSource, syncContext);

const beforeReloadSession = seekSession;
const tab1State = {
    deviceId: 'dev-1',
    isPrimarySyncLeader: true,
    isApplyingRemoteSync: false,
    lastRemoteSyncAppliedAt: 0,
    currentSongMeta: { id: 1, title: 'Song 1', artist: 'Artist', album_art: '', filename: 'song1.mp3', duration_seconds: 338 },
    currentPlayingSongId: '1',
    currentPlaylistId: 1,
    currentPlaylistSongs: [{ id: 1, title: 'Song 1', artist: 'Artist', album_art: '', filename: 'song1.mp3', duration_seconds: 338 }],
    currentSongIndex: 0,
    repeatMode: 0,
    isShuffle: false,
    userVolume: 0.8,
    userMuted: false,
    playbackSessionId: beforeReloadSession,
    playEventLogged: true,
    pendingPlaySeconds: 0,
};
const noopApp = (st) => ({
    state: st,
    el: { audio: syncAudio },
    showToast() {},
    mediaUrlName: (v) => v,
    albumArtUrl: (v) => v || '',
    formatTime: (v) => String(v),
    updatePlayPauseIcon() {},
    updateSyncedLyrics() {},
    updateMediaSession() {},
    buildQueue() {},
    loadLyrics() {},
    highlightPlayingSong() {},
    flushListenLog() {},
    setAppVolume() {},
    cancelPlaybackRecovery() {},
    cancelTrackTransitionRecovery() {},
    resumeCurrentSong() {},
});
const syncMod1 = syncWindow.createPlaybackSyncModule(noopApp(tab1State));
syncMod1.savePlaybackState(true, true);
const persisted = JSON.parse(localStore.get('psr_playback_state_1'));
assert.equal(persisted.playbackSessionId, beforeReloadSession);
assert.equal(persisted.playEventLogged, true);

// Simulate fresh page reload applying saved state.
const tab2State = {
    deviceId: 'dev-1',
    isPrimarySyncLeader: true,
    isApplyingRemoteSync: false,
    lastRemoteSyncAppliedAt: 0,
    currentPlayingSongId: null,
    playEventLogged: false,
    pendingPlaySeconds: 0,
    playbackSessionId: null,
    playbackSessionPromise: null,
    playbackRequestId: 0,
    lastLoggedTime: 0,
};
const syncMod2 = syncWindow.createPlaybackSyncModule(noopApp(tab2State));
syncMod2.applySavedPlaybackState(persisted, false, false);
assert.equal(tab2State.playEventLogged, true, 'Reload must restore playEventLogged');
assert.equal(tab2State.playbackSessionId, beforeReloadSession, 'Reload must restore playbackSessionId');
syncAudio.listeners.loadedmetadata?.();
assert.equal(tab2State.lastLoggedTime, 90, 'Reload must anchor lastLoggedTime to restored position');

// Continuing playback after reload must reuse beforeReloadSession without firing a new /play.
const sessionsBeforeReloadContinue = nextSession;
const secondsBeforeReloadContinue = sessions.get(beforeReloadSession);
state.playEventLogged = tab2State.playEventLogged;
state.playbackSessionId = tab2State.playbackSessionId;
state.playbackSessionPromise = tab2State.playbackSessionPromise;
state.pendingPlaySeconds = 0;
state.lastLoggedTime = 90;
state.playbackStatisticsSongId = '1';
audio.currentTime = 90;
audio.paused = false;
listeners.play();
listeners.playing();
audio.currentTime = 95;
listeners.timeupdate();
await settle();
assert.equal(nextSession, sessionsBeforeReloadContinue, 'Reload mid-song must NOT log a duplicate play');
assert.equal(sessions.get(beforeReloadSession), secondsBeforeReloadContinue + 5, 'Reload mid-song must continue logging seconds on the same session');

// Changing volume on a follower device must NOT promote it to primary sync leader or log duplicate plays.
const followerSaveCalls = [];
const followerState = {
    isPrimarySyncLeader: false,
    userVolume: 0.8,
    userMuted: false,
    lastNonZeroVolume: 0.8,
};
const followerAudio = { volume: 0.8, muted: false };
const followerCtx = vm.createContext({
    window: {},
    state: followerState,
    el: { audio: followerAudio },
    document: {
        getElementById: () => null,
        querySelectorAll: () => [],
    },
    updateVolumeIcon() {},
    savePlaybackState(force, isUserAction) { followerSaveCalls.push({ force, isUserAction }); },
});
const setAppVolStart = source.indexOf('    function setAppVolume(');
const setAppVolEnd = source.indexOf('    window.setAppVolume = setAppVolume;', setAppVolStart);
assert.ok(setAppVolStart >= 0 && setAppVolEnd > setAppVolStart);
vm.runInContext(source.slice(setAppVolStart, setAppVolEnd), followerCtx);
followerCtx.setAppVolume(0.4, false, true);
assert.equal(followerState.isPrimarySyncLeader, false, 'Follower volume change must NOT claim sync leadership');
assert.equal(followerAudio.volume, 0.4, 'Follower local volume must still update');
assert.deepEqual(followerSaveCalls, [{ force: false, isUserAction: false }], 'Follower volume change must not force server sync');

// Follower timeupdate after volume change must still not log a play.
const sessionsBeforeFollower = nextSession;
state.isPrimarySyncLeader = false;
state.playEventLogged = false;
state.pendingPlaySeconds = 0;
state.playbackSessionId = null;
state.playbackSessionPromise = null;
state.playbackRequestId++;
audio.currentTime = 0;
audio.paused = false;
listeners.play();
listeners.playing();
audio.currentTime = 5;
listeners.timeupdate();
await settle();
assert.equal(nextSession, sessionsBeforeFollower, 'Follower must not log plays while not sync leader');

// Verification: Download progress notification dismiss, close button, and stall timer.
const mainSource = fs.readFileSync(new URL('../../static/js/main.js', import.meta.url), 'utf8');
const dlWrapper = {
    classList: {
        _classes: new Set(['active']),
        contains(c) { return this._classes.has(c); },
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
    },
};
const dlBar = { style: { width: '45%' } };
const dlLabel = { innerText: '45%' };
const dlRetryBtn = { hidden: false };
let dlCloseHandler = null;
const dlCloseBtn = {
    addEventListener(evt, fn) { if (evt === 'click') dlCloseHandler = fn; }
};
const dlSocketHandlers = {};
const dlWindow = {};
const dlCtx = vm.createContext({
    window: dlWindow,
    el: {
        downloadWrapper: dlWrapper,
        downloadBar: dlBar,
        downloadLabel: dlLabel,
        downloadRetryBtn: dlRetryBtn,
        downloadCloseBtn: dlCloseBtn,
    },
    socket: {
        on(event, handler) { dlSocketHandlers[event] = handler; }
    },
    state: {},
    showToast() {},
    loadDashboard() {},
    loadPlaylists() {},
    loadLibrarySongs() {},
    openPlaylist() {},
    setTimeout,
    clearTimeout,
});
const dlWsStart = mainSource.indexOf('    // WEBSOCKET EVENTS');
const dlWsEnd = mainSource.indexOf('    // CROSS-DEVICE PLAYBACK SYNC', dlWsStart);
assert.ok(dlWsStart >= 0 && dlWsEnd > dlWsStart);
vm.runInContext(mainSource.slice(dlWsStart, dlWsEnd), dlCtx);

assert.ok(typeof dlCloseHandler === 'function', 'Close button click handler must be registered');
dlCloseHandler();
assert.equal(dlWrapper.classList.contains('active'), false, 'Clicking close button must remove active class');
assert.equal(dlBar.style.width, '0%', 'Progress bar must reset to 0%');
assert.equal(dlLabel.innerText, '0%', 'Progress label must reset to 0%');
assert.equal(dlRetryBtn.hidden, true, 'Retry button must be hidden');

// Verify song_added hides download progress
dlWrapper.classList.add('active');
dlSocketHandlers.song_added?.({ title: 'Song', playlist_ids: [] });
await new Promise(r => setTimeout(r, 1100));
assert.equal(dlWrapper.classList.contains('active'), false, 'song_added must auto-dismiss download progress');

// Verify showSyncAutoplayPrompt timeout resets syncPromptActive so future events are not blocked
let promptToastCalls = [];
const syncState = { deviceId: 'dev-sync-test', isPrimarySyncLeader: false, isSyncSeeking: false };
const syncEl = { audio: { play: () => Promise.reject(new Error('Blocked')), pause() {}, currentTime: 0 } };
const syncApp = {
    state: syncState,
    el: syncEl,
    showToast(msg, type) { promptToastCalls.push({ msg, type }); },
    mediaUrlName: f => f,
    albumArtUrl: a => a,
    formatTime: t => String(t),
    updatePlayPauseIcon() {},
    updateSyncedLyrics() {},
    updateMediaSession() {},
    buildQueue() {},
    loadLyrics() {},
    highlightPlayingSong() {},
    flushListenLog() {},
    setAppVolume() {},
    cancelPlaybackRecovery() {},
    cancelTrackTransitionRecovery() {},
    resumeCurrentSong() {},
};
const syncModTest = syncWindow.createPlaybackSyncModule(syncApp);
syncModTest.showSyncAutoplayPrompt(10, true);
assert.equal(promptToastCalls.length, 1, 'First prompt must trigger toast');
syncModTest.showSyncAutoplayPrompt(10, true);
assert.equal(promptToastCalls.length, 1, 'Prompt must not duplicate while active');
// After 5s timeout, prompt must be unlocked and able to trigger again
await new Promise(r => setTimeout(r, 5100));
syncModTest.showSyncAutoplayPrompt(15, true);
assert.equal(promptToastCalls.length, 2, 'After timeout, subsequent prompt must not be permanently blocked');

console.log('Listening checks passed: full repeats, early pause, slow session, seek event ordering, HTTP rejection, reload session continuity, follower volume, download dismiss & sync unlock.');
