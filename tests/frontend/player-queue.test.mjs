import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const queueSource = fs.readFileSync(new URL('../../static/js/queue.js', import.meta.url), 'utf8');
const playerSource = fs.readFileSync(new URL('../../static/js/player.js', import.meta.url), 'utf8');
const songs = [1, 2, 3].map(id => ({ id }));
const played = [];
const state = { currentPlaylistSongs: songs, currentPlaylistId: 1, currentSongIndex: 0,
    repeatMode: 0, isShuffle: false, shuffleOrder: [], playQueue: [], playbackHistory: [], shouldBePlaying: true,
    currentSongMeta: songs[0], currentPlayingSongId: '1' };
let audioSeekPos = null;
const audioObj = { currentTime: 0, pause() { state.shouldBePlaying = false; } };
const context = vm.createContext({ state, el: { audio: audioObj },
    updateQueueUI() {}, updatePlayPauseIcon() {}, showToast() {},
    seekAudio(pos) { audioSeekPos = pos; audioObj.currentTime = pos; },
    playSong(list, index) {
        state.currentSongIndex = index;
        state.currentSongMeta = list[index];
        state.currentPlayingSongId = String(list[index].id);
        played.push(list[index].id);
        context.buildQueue();
    },
    playLibrarySong(song) {
        state.currentSongMeta = song;
        state.currentPlayingSongId = String(song.id);
        played.push(song.id);
    },
});
function load(src, start, end) {
    const from = src.indexOf(start);
    const to = src.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(src.slice(from, to), context);
}
load(queueSource, '    function rebuildShuffleOrder()', '    function updateQueueUI()');
load(queueSource, '    function enqueueSong(', "    document.getElementById('queue-clear-btn')");
load(playerSource, '    function playNext(', '    return {');
context.buildQueue();
assert.deepEqual(Array.from(state.playQueue, song => song.id), [2, 3]);
context.playNext(true);
context.playNext(true);
context.playNext(true);
assert.deepEqual(played, [2, 3]);
assert.equal(state.shouldBePlaying, false, 'Repeat off stops after the final queued track');

played.length = 0;
state.currentSongIndex = 0;
state.playQueue = [];
state.shouldBePlaying = true;
context.playNext(true);
assert.deepEqual(played, [2], 'An empty queue still advances within the playlist');

const activeOfflineUrl = { value: 'blob:current' };
const revokedUrls = [];
const offlineContext = vm.createContext({
    state: { playbackRequestId: 2, offlineAudioUrl: activeOfflineUrl.value },
    el: { audio: { load() {} } },
    mediaUrlName: filename => filename,
    URL: { revokeObjectURL(url) { revokedUrls.push(url); }, createObjectURL() { return 'blob:stale'; } },
    releaseOfflineAudioUrl() {},
    isOfflineMode: () => true,
    caches: {
        match: async () => ({ blob: async () => new Blob(['audio']) }),
        open: async () => ({ delete() {} }),
    },
    isUsableAudioResponse: async () => true,
    resumeCurrentSong() {},
});
const loadSongAudioStart = playerSource.indexOf('    async function loadSongAudio(');
const loadSongAudioEnd = playerSource.indexOf('    function playLibrarySong(', loadSongAudioStart);
vm.runInContext(playerSource.slice(loadSongAudioStart, loadSongAudioEnd), offlineContext);
await offlineContext.loadSongAudio({ filename: 'stale.mp3' }, 1);
assert.deepEqual(revokedUrls, ['blob:stale'], 'A stale offline load only revokes its own URL');

played.length = 0;
state.currentSongIndex = 1;
state.shouldBePlaying = true;
context.buildQueue();
assert.deepEqual(Array.from(state.playQueue, song => song.id), [3], 'Starting in the middle must not wrap to earlier tracks');
context.playNext(true);
context.playNext(true);
assert.deepEqual(played, [3]);

state.repeatMode = 1;
context.playNext(true);
assert.equal(played.at(-1), 1, 'Repeat all starts a fresh cycle');
context.enqueueSong({ id: 4 }, true);
context.playNext(false);
assert.equal(played.at(-1), 4);
assert.deepEqual(Array.from(state.playQueue, song => song.id), [2, 3], 'Manual play-next preserves the remaining queue');

played.length = 0;
state.repeatMode = 0;
state.isShuffle = true;
state.currentSongIndex = 0;
state.currentSongMeta = state.currentPlaylistSongs[0];
state.currentPlayingSongId = String(state.currentPlaylistSongs[0].id);
state.shuffleOrder = [];
state.shouldBePlaying = true;
context.buildQueue();
context.playNext(true);
context.playNext(true);
context.playNext(true);
assert.equal(new Set([1, ...played]).size, 3, 'Shuffle plays each track once');
assert.equal(played.length, 2);
assert.equal(state.shouldBePlaying, false);

// Shuffle mode Previous & Next queue order verification
played.length = 0;
state.isShuffle = true;
state.repeatMode = 0;
state.currentSongIndex = 0;
state.currentSongMeta = songs[0];
state.currentPlayingSongId = '1';
state.shuffleOrder = [{ id: 1 }, { id: 3 }, { id: 2 }];
state.shuffleKey = 1;
state.playbackHistory = [];
state.playQueue = [];
context.buildQueue();
assert.deepEqual(Array.from(state.playQueue, s => s.id), [3, 2], 'Initial shuffle queue has remaining tracks in shuffled order');

// Advance to next song (3)
context.playNext(false);
assert.equal(state.currentSongMeta.id, 3, 'playNext advances to first queued song');
assert.deepEqual(Array.from(state.playQueue, s => s.id), [2], 'Queue has remaining song');
assert.deepEqual(Array.from(state.playbackHistory, s => s.id), [1], 'History records previous song');

// Advance to next song (2)
context.playNext(false);
assert.equal(state.currentSongMeta.id, 2, 'playNext advances to song 2');
assert.deepEqual(Array.from(state.playQueue, s => s.id), [], 'Queue is now empty');
assert.deepEqual(Array.from(state.playbackHistory, s => s.id), [1, 3], 'History has both previous songs');

// Click Previous while > 3s into song: must rewind without changing song
audioObj.currentTime = 5;
audioSeekPos = null;
context.playPrev();
assert.equal(audioSeekPos, 0, 'playPrev at >3s rewinds to 0');
assert.equal(state.currentSongMeta.id, 2, 'Song remains unchanged when rewinding');

// Click Previous at <= 3s: must go back to song 3 and restore song 2 to front of queue
audioObj.currentTime = 1;
context.playPrev();
assert.equal(state.currentSongMeta.id, 3, 'playPrev returns to song 3 from history');
assert.deepEqual(Array.from(state.playQueue, s => s.id), [2], 'Song 2 is restored to head of queue');
assert.deepEqual(Array.from(state.playbackHistory, s => s.id), [1], 'History popped song 3');

// Click Previous again: must go back to song 1 and restore song 3 to front of queue
audioObj.currentTime = 0;
context.playPrev();
assert.equal(state.currentSongMeta.id, 1, 'playPrev returns to song 1');
assert.deepEqual(Array.from(state.playQueue, s => s.id), [3, 2], 'Upcoming queue has [3, 2]');
assert.deepEqual(Array.from(state.playbackHistory, s => s.id), [], 'History is now empty');

// Click Next from song 1: must play song 3 and leave [2] in queue
context.playNext(false);
assert.equal(state.currentSongMeta.id, 3, 'Subsequent playNext plays song 3 from queue');
assert.deepEqual(Array.from(state.playQueue, s => s.id), [2], 'Queue has song 2 remaining');

console.log('Queue checks passed: repeat off/all, mid-playlist starts, manual queue, shuffle next & prev queue order.');
