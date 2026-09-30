import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../static/main.js', import.meta.url), 'utf8');
const songs = [1, 2, 3].map(id => ({ id }));
const played = [];
const state = { currentPlaylistSongs: songs, currentPlaylistId: 1, currentSongIndex: 0,
    repeatMode: 0, isShuffle: false, shuffleOrder: [], playQueue: [], shouldBePlaying: true };
const context = vm.createContext({ state, el: { audio: { pause() { state.shouldBePlaying = false; } } },
    updateQueueUI() {}, updatePlayPauseIcon() {}, showToast() {},
    playSong(list, index) { played.push(list[index].id); state.currentSongIndex = index; context.buildQueue(); },
    playLibrarySong(song) { played.push(song.id); },
});
function load(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(source.slice(from, to), context);
}
load('    function rebuildShuffleOrder()', '    function updateQueueUI()');
load('    function enqueueSong(', "    document.getElementById('queue-clear-btn')");
load('    function playNext(', '    function playPrev(');
context.buildQueue();
assert.deepEqual(Array.from(state.playQueue, song => song.id), [2, 3]);
context.playNext(true);
context.playNext(true);
context.playNext(true);
assert.deepEqual(played, [2, 3]);
assert.equal(state.shouldBePlaying, false, 'Repeat off stops after the final queued track');

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
state.shuffleOrder = [];
state.shouldBePlaying = true;
context.buildQueue();
context.playNext(true);
context.playNext(true);
context.playNext(true);
assert.equal(new Set([1, ...played]).size, 3, 'Shuffle plays each track once');
assert.equal(played.length, 2);
assert.equal(state.shouldBePlaying, false);
console.log('Queue checks passed: repeat off/all, mid-playlist starts, manual queue, shuffle.');
