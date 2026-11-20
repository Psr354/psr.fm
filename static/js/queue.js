// ==========================================
// QUEUE & CONTEXT MENU MODULE
// ==========================================
window.createQueueModule = function createQueueModule(app) {
    const { state, el } = app;
    const escapeHtml = (...args) => app.escapeHtml(...args);
    const albumArtUrl = (...args) => app.albumArtUrl(...args);
    const showToast = (...args) => app.showToast(...args);
    const setQueueOpen = (...args) => app.setQueueOpen(...args);
    const triggerDownload = (...args) => app.triggerDownload(...args);
    const triggerLibraryDownload = (...args) => app.triggerLibraryDownload(...args);
    const openDownloadModal = (...args) => app.openDownloadModal(...args);
    const playSong = (...args) => app.playSong(...args);
    const playLibrarySong = (...args) => app.playLibrarySong(...args);

    // Build a fresh shuffled order of ALL songs in the playlist, starting with
    // the current song. Every song appears exactly once, so nothing repeats
    // until the whole playlist has played through (a-c-d-f-b-g-e-a).
    function rebuildShuffleOrder() {
        const rest = [];
        for (let i = 0; i < state.currentPlaylistSongs.length; i++) {
            if (i !== state.currentSongIndex) rest.push(state.currentPlaylistSongs[i]);
        }
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        state.shuffleOrder = [state.currentPlaylistSongs[state.currentSongIndex], ...rest];
        state.shuffleKey = state.currentPlaylistId;
    }

    function buildQueue() {
        state.playQueue = [];
        if (!state.currentPlaylistSongs || state.currentPlaylistSongs.length <= 1) {
            state.shuffleOrder = [];
            updateQueueUI();
            return;
        }

        if (state.isShuffle) {
            // Only reshuffle when the playlist changed or shuffle was just turned
            // on; otherwise reuse the existing order so songs don't repeat.
            const currentSong = state.currentSongMeta || state.currentPlaylistSongs[state.currentSongIndex];
            if (!currentSong) {
                updateQueueUI();
                return;
            }
            const hasCurrent = state.shuffleOrder?.some(s => s.id === currentSong.id);
            if (!state.shuffleOrder?.length || state.shuffleKey !== state.currentPlaylistId || !hasCurrent) {
                rebuildShuffleOrder();
            }
            const pos = state.shuffleOrder.findIndex(s => s.id === currentSong.id);
            state.playQueue = state.shuffleOrder.slice(pos + 1);
            if (el.queueMode) el.queueMode.innerText = '(Shuffled)';
        } else {
            state.shuffleOrder = [];
            state.playQueue = state.currentPlaylistSongs.slice(state.currentSongIndex + 1);
            if (el.queueMode) el.queueMode.innerText = '';
        }
        updateQueueUI();
    }

    function updateQueueUI() {
        if (!el.queueList) return;
        el.queueList.innerHTML = '';
        if (state.playQueue.length === 0) {
            el.queueList.innerHTML = '<p style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 12px;">Queue is empty</p>';
            return;
        }
        state.playQueue.forEach((song, index) => {
            const div = document.createElement('div');
            div.className = 'queue-item';
            div.draggable = true;
            div.dataset.queueIndex = String(index);
            div.innerHTML = `
                <button class="queue-drag-handle" type="button" aria-label="Reorder ${escapeHtml(song.title)}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>
                <img src="${albumArtUrl(song.album_art)}" alt="" loading="lazy" data-fallback="icon">
                <div class="q-info">
                    <div class="q-title">${escapeHtml(song.title)}</div>
                    <div class="q-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                <button class="queue-remove-btn" type="button" aria-label="Remove ${escapeHtml(song.title)}" title="Remove"><i class="fas fa-xmark"></i></button>
            `;
            div.addEventListener('click', () => {
                if (state.currentSongMeta) {
                    if (!state.playbackHistory) state.playbackHistory = [];
                    state.playbackHistory.push(state.currentSongMeta);
                    if (state.playbackHistory.length > 50) state.playbackHistory.shift();
                }
                state.playQueue.splice(index, 1);
                playQueuedSong(song);
                setQueueOpen(false);
            });
            div.querySelector('.queue-remove-btn').addEventListener('click', (event) => {
                event.stopPropagation();
                state.playQueue.splice(index, 1);
                updateQueueUI();
            });
            div.addEventListener('dragstart', (event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
                div.classList.add('is-dragging');
            });
            div.addEventListener('dragend', () => div.classList.remove('is-dragging'));
            div.addEventListener('dragover', (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            });
            div.addEventListener('drop', (event) => {
                event.preventDefault();
                const fromIndex = Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
                if (!Number.isInteger(fromIndex) || fromIndex === index) return;
                const [movedSong] = state.playQueue.splice(fromIndex, 1);
                state.playQueue.splice(index, 0, movedSong);
                updateQueueUI();
            });
            el.queueList.appendChild(div);
        });
    }

    function enqueueSong(song, playNext = false) {
        if (!song || !song.id) return;
        if (playNext) state.playQueue.unshift(song);
        else state.playQueue.push(song);
        updateQueueUI();
        showToast(playNext ? 'Playing next' : 'Added to queue', 'success');
    }

    function playQueuedSong(song) {
        const remainingQueue = state.playQueue.slice();
        const playlistIndex = state.currentPlaylistSongs.findIndex(item => item.id === song.id);
        if (playlistIndex !== -1) playSong(state.currentPlaylistSongs, playlistIndex);
        else playLibrarySong(song);
        state.playQueue = remainingQueue;
        updateQueueUI();
    }

    document.getElementById('queue-clear-btn')?.addEventListener('click', () => {
        state.playQueue = [];
        updateQueueUI();
    });

    let contextSong = null;
    let contextSongPlay = null;
    let contextSongIsLibrary = false;

    function closeSongContextMenu() {
        const menu = document.getElementById('song-context-menu');
        menu?.classList.remove('active');
        menu?.setAttribute('aria-hidden', 'true');
        contextSong = null;
        contextSongPlay = null;
    }

    function openSongContextMenu(song, event, {isLibrary = false, play} = {}) {
        const menu = document.getElementById('song-context-menu');
        if (!menu || !song) return;
        event.preventDefault();
        contextSong = song;
        contextSongPlay = play;
        contextSongIsLibrary = isLibrary;
        menu.querySelector('[data-context-action="add-playlist"]')?.classList.toggle('is-hidden', !isLibrary);
        menu.classList.add('active');
        menu.setAttribute('aria-hidden', 'false');
        const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 12);
        const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 12);
        menu.style.left = `${Math.max(12, left)}px`;
        menu.style.top = `${Math.max(12, top)}px`;
    }

    function addSongLongPress(element, song, options = {}) {
        if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) element.draggable = false;
        let timer = null;
        let startX = 0;
        let startY = 0;
        let longPressTriggered = false;
        const cancel = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };

        element.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1 || event.target.closest('button, a, input')) return;
            const touch = event.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            timer = setTimeout(() => {
                longPressTriggered = true;
                openSongContextMenu(song, {
                    clientX: startX,
                    clientY: startY,
                    preventDefault() {}
                }, options);
            }, 550);
        }, {passive: true});
        element.addEventListener('touchmove', (event) => {
            const touch = event.touches[0];
            if (!touch || Math.hypot(touch.clientX - startX, touch.clientY - startY) > 12) cancel();
        }, {passive: true});
        element.addEventListener('touchend', cancel, {passive: true});
        element.addEventListener('touchcancel', cancel, {passive: true});
        element.addEventListener('click', (event) => {
            if (!longPressTriggered) return;
            longPressTriggered = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
    }

    document.getElementById('song-context-menu')?.addEventListener('click', (event) => {
        const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
        if (!action || !contextSong) return;
        const song = contextSong;
        if (action === 'play') contextSongPlay?.();
        if (action === 'play-next') enqueueSong(song, true);
        if (action === 'queue') enqueueSong(song);
        if (action === 'download') {
            if (contextSongIsLibrary) triggerLibraryDownload(song.id, song.title, song.artist);
            else triggerDownload(song.id);
        }
        if (action === 'add-playlist') openDownloadModal(song);
        closeSongContextMenu();
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('#song-context-menu')) closeSongContextMenu();
    });
    document.addEventListener('scroll', closeSongContextMenu, true);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeSongContextMenu();
    });

    return {
        rebuildShuffleOrder,
        buildQueue,
        updateQueueUI,
        enqueueSong,
        playQueuedSong,
        closeSongContextMenu,
        openSongContextMenu,
        addSongLongPress,
    };
};
