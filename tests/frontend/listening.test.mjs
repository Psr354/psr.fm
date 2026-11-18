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
console.log('Listening checks passed: full repeats, early pause, slow session, seek event ordering, HTTP rejection.');
