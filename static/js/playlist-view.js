// ==========================================
// PLAYLIST, LIBRARY & DASHBOARD VIEWS MODULE
// ==========================================
window.createPlaylistViewModule = function createPlaylistViewModule(app) {
    const { state, el } = app;
    const escapeHtml = (...args) => app.escapeHtml(...args);
    const mediaUrlName = (...args) => app.mediaUrlName(...args);
    const albumArtUrl = (...args) => app.albumArtUrl(...args);
    const formatTime = (...args) => app.formatTime(...args);
    const formatBytes = (...args) => app.formatBytes(...args);
    const debounce = (...args) => app.debounce(...args);
    const showToast = (...args) => app.showToast(...args);
    const renderEmptyState = (...args) => app.renderEmptyState(...args);
    const fetchWithTimeout = (...args) => app.fetchWithTimeout(...args);
    const isOfflineMode = () => app.isOfflineMode();
    const setOfflineMode = (enabled) => app.setOfflineMode(enabled);
    const getOfflinePlaylists = () => app.getOfflinePlaylists();
    const getOfflinePlaylist = (id) => app.getOfflinePlaylist(id);
    const updateOfflineButton = () => app.updateOfflineButton();
    const saveOfflinePlaylist = (p) => app.saveOfflinePlaylist(p);
    const showView = (name) => app.showView(name);
    const setMobileMenu = (open) => app.setMobileMenu(open);
    const openDownloadModal = (...args) => app.openDownloadModal(...args);
    const triggerDownload = (...args) => app.triggerDownload(...args);
    const triggerLibraryDownload = (...args) => app.triggerLibraryDownload(...args);
    const playSong = (...args) => app.playSong(...args);
    const playLibrarySong = (...args) => app.playLibrarySong(...args);
    const openSongContextMenu = (...args) => app.openSongContextMenu(...args);
    const addSongLongPress = (...args) => app.addSongLongPress(...args);

    // Search
    let searchRequestId = 0;
    document.getElementById('search-input')?.addEventListener('input', debounce(async (e) => {
        const query = e.target.value.trim();
        const searchResults = document.getElementById('search-results');
        if (query.length > 1) {
            const requestId = ++searchRequestId;
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            if (!response.ok || requestId !== searchRequestId) return;
            const results = await response.json();
            if (requestId !== searchRequestId) return;
            renderSongs(results, 'search-results', false);
        } else {
            searchRequestId += 1;
            renderEmptyState(searchResults, {
                icon: 'fa-search',
                title: 'Search your library',
                body: 'Type at least two characters to find a song or artist in this account.'
            });
        }
    }, 300));

    async function loadLibrarySongs(query = state.libraryQuery, page = state.libraryPage) {
        const libraryList = document.getElementById('library-songs-list');
        if (!libraryList) return;
        const pageSize = 50;
        state.libraryQuery = query;
        state.libraryPage = page;
        try {
            const params = new URLSearchParams({limit: pageSize, offset: (page - 1) * pageSize});
            if (query) params.set('q', query);
            const suffix = `?${params.toString()}`;
            const songs = await (await fetch(`/api/library-songs${suffix}`)).json();
            state.librarySongs = songs;
            renderLibrarySongs(songs, page, pageSize);
        } catch (err) {
            renderEmptyState(libraryList, {
                icon: 'fa-triangle-exclamation',
                title: 'Library unavailable',
                body: 'Try opening Library Songs again in a moment.'
            });
        }
    }

    function renderLibrarySongs(songs, page = state.libraryPage, pageSize = 50) {
        const container = document.getElementById('library-songs-list');
        const pagination = document.getElementById('library-pagination');
        const previousButton = document.getElementById('library-prev-page');
        const nextButton = document.getElementById('library-next-page');
        const pageLabel = document.getElementById('library-page-label');
        if (!container) return;

        container.innerHTML = '';
        if (!songs.length) {
            if (pagination) pagination.hidden = true;
            renderEmptyState(container, {
                icon: 'fa-record-vinyl',
                title: 'No songs in Library Songs yet',
                body: 'Downloaded songs from every account will appear here.'
            });
            return;
        }

        if (pagination) pagination.hidden = false;
        if (previousButton) previousButton.disabled = page === 1;
        if (nextButton) nextButton.disabled = songs.length < pageSize;
        if (pageLabel) pageLabel.textContent = `Page ${page}`;

        songs.forEach((song) => {
            const div = document.createElement('div');
            div.className = 'song-item library-song-item';
            div.setAttribute('data-id', String(song.id));
            div.innerHTML = `
                <img src="${albumArtUrl(song.album_art)}" class="song-art" alt="" loading="lazy" data-fallback="icon">
                <div class="song-info">
                    <div class="song-title">${escapeHtml(song.title)}</div>
                    <div class="song-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                <div class="library-song-meta">
                    <span><i class="fas fa-users"></i> Added by ${song.owner_count || 1} user${Number(song.owner_count || 1) === 1 ? '' : 's'}</span>
                    ${song.in_my_library ? '<span class="in-library-pill">Already in your library</span>' : ''}
                </div>
                <div class="song-duration">${formatTime(song.duration_seconds)}</div>
                <button class="icon-btn play-library-song" data-id="${song.id}" title="Play preview"><i class="fas fa-play"></i></button>
                <button class="icon-btn download-song" data-id="${song.id}" title="Download"><i class="fas fa-download"></i></button>
                <button class="btn-primary compact library-add-btn" data-id="${song.id}"><i class="fas fa-plus"></i> Add</button>
            `;
            div.querySelector('.library-add-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openDownloadModal(song);
            });
            div.querySelector('.play-library-song')?.addEventListener('click', (e) => {
                e.stopPropagation();
                playLibrarySong(song);
            });
            div.querySelector('.download-song')?.addEventListener('click', (e) => {
                e.stopPropagation();
                triggerLibraryDownload(song.id, song.title, song.artist);
            });
            div.addEventListener('contextmenu', (event) => {
                openSongContextMenu(song, event, {isLibrary: true, play: () => playLibrarySong(song)});
            });
            addSongLongPress(div, song, {isLibrary: true, play: () => playLibrarySong(song)});
            container.appendChild(div);
        });
    }

    document.getElementById('library-search-input')?.addEventListener('input', debounce((e) => {
        loadLibrarySongs(e.target.value.trim(), 1);
    }, 300));

    document.getElementById('library-prev-page')?.addEventListener('click', () => {
        if (state.libraryPage > 1) loadLibrarySongs(state.libraryQuery, state.libraryPage - 1);
    });

    document.getElementById('library-next-page')?.addEventListener('click', () => {
        loadLibrarySongs(state.libraryQuery, state.libraryPage + 1);
    });

    document.getElementById('save-playlist-offline-btn')?.addEventListener('click', () => {
        if (state.currentPlaylist) saveOfflinePlaylist(state.currentPlaylist);
    });

    async function loadPlaylists() {
        let playlists;
        if (isOfflineMode()) {
            playlists = await getOfflinePlaylists();
        } else {
            try {
                const response = await fetchWithTimeout('/api/playlists');
                if (!response.ok) throw new Error('Playlist request failed');
                playlists = await response.json();
                setOfflineMode(false);
            } catch (error) {
                console.warn('Server is unreachable; using offline playlists instead.', error);
                setOfflineMode(true);
                playlists = await getOfflinePlaylists();
            }
        }
        const list = document.getElementById('playlist-list');
        if (!list) return;
        list.innerHTML = '';
        playlists.forEach(p => {
            const li = document.createElement('li');
            li.className = 'playlist-item';
            if (p.id === state.currentPlaylistId) li.classList.add('active');
            li.setAttribute('data-id', p.id);
            const coverSrc = p.cover_art
                ? `/static/album_art/${mediaUrlName(p.cover_art)}`
                : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='%23555'><path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/></svg>";
            li.innerHTML = `<img src="${coverSrc}" alt=""> <span>${escapeHtml(p.name)}</span>`;
            li.addEventListener('click', () => openPlaylist(p));
            list.appendChild(li);
        });
        return playlists;
    }

    async function openPlaylist(playlist) {
        state.currentPlaylistId = playlist.id;
        state.currentPlaylist = playlist;
        if (el.playlistTitle) el.playlistTitle.innerText = playlist.name;

        if (window.innerWidth <= 768) {
            setMobileMenu(false);
        }

        const timestamp = isOfflineMode() ? '' : new Date().getTime();
        const coverSrc = playlist.cover_art
            ? `/static/album_art/${mediaUrlName(playlist.cover_art)}?t=${timestamp}`
            : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 24 24' fill='%23333'><path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/></svg>";
        if (el.playlistCoverImg) el.playlistCoverImg.src = coverSrc;

        showView('playlist');
        const playlistListEl = document.getElementById('playlist-list');
        if (playlistListEl) {
            playlistListEl.querySelectorAll('.playlist-item').forEach((item) => {
                item.classList.toggle('active', item.getAttribute('data-id') === String(playlist.id));
            });
        }

        const deleteBtn = document.getElementById('delete-playlist-btn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                if (confirm(`Delete playlist "${playlist.name}"? Songs not used by another playlist will also be deleted permanently.`)) {
                    try {
                        const response = await fetch(`/api/playlists/${playlist.id}`, {method: 'DELETE'});
                        if (!response.ok) {
                            const data = await response.json().catch(() => ({}));
                            throw new Error(data.error || 'Failed to delete playlist');
                        }
                        state.currentPlaylistId = null;
                        loadPlaylists();
                        showView('dashboard');
                        showToast('Playlist deleted');
                    } catch (error) {
                        showToast(error.message || 'Failed to delete playlist', 'error');
                    }
                }
            };
        }

        let offlinePlaylist = isOfflineMode() ? await getOfflinePlaylist(playlist.id) : null;
        if (offlinePlaylist) {
            state.currentPlaylistSongs = offlinePlaylist.songs;
        } else {
            try {
                const response = await fetchWithTimeout(`/api/songs?playlist_id=${playlist.id}`);
                if (!response.ok) throw new Error('Song request failed');
                state.currentPlaylistSongs = await response.json();
                setOfflineMode(false);
            } catch (error) {
                console.warn('Server is unreachable; using the saved playlist instead.', error);
                setOfflineMode(true);
                offlinePlaylist = await getOfflinePlaylist(playlist.id);
                if (!offlinePlaylist) throw error;
                state.currentPlaylistSongs = offlinePlaylist.songs;
            }
        }
        renderSongs(state.currentPlaylistSongs, 'playlist-songs-list', true);
        updatePlaylistMeta();
        updateOfflineButton();
        highlightPlayingSong();
    }

    function updatePlaylistMeta() {
        if (!el.playlistMeta) return;
        const totalSec = state.currentPlaylistSongs.reduce((acc, s) => acc + (s.duration_seconds || 0), 0);
        el.playlistMeta.innerText = `${state.currentPlaylistSongs.length} songs - ${formatTime(totalSec)}`;
    }

    async function savePlaylistSongOrder(songIds) {
        if (!state.currentPlaylistId) return;
        const res = await fetch(`/api/playlists/${state.currentPlaylistId}/songs/order`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({song_ids: songIds})
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to save song order');
        }
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.song-item.is-reorderable:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return {offset, element: child};
            }
            return closest;
        }, {offset: Number.NEGATIVE_INFINITY, element: null}).element;
    }

    function attachPlaylistReorder(container) {
        if (!state.currentPlaylistId) return;
        let draggedItem = null;

        const finishReorder = async (item) => {
            if (!item) return;
            item.classList.remove('dragging');
            draggedItem = null;
            const songIds = [...container.querySelectorAll('.song-item.is-reorderable')]
                .map(row => Number.parseInt(row.dataset.id, 10))
                .filter(Number.isFinite);

            const currentOrder = state.currentPlaylistSongs.map(song => song.id);
            if (songIds.join(',') === currentOrder.join(',')) return;

            const byId = new Map(state.currentPlaylistSongs.map(song => [song.id, song]));
            state.currentPlaylistSongs = songIds.map(songId => byId.get(songId)).filter(Boolean);
            updatePlaylistMeta();

            try {
                await savePlaylistSongOrder(songIds);
                showToast('Playlist order saved', 'success');
                renderSongs(state.currentPlaylistSongs, 'playlist-songs-list', true);
                highlightPlayingSong();
            } catch (err) {
                showToast(err.message || 'Failed to save song order', 'error');
                if (state.currentPlaylist) openPlaylist(state.currentPlaylist);
            }
        };

        container.querySelectorAll('.song-item.is-reorderable').forEach((item) => {
            item.addEventListener('dragstart', () => {
                draggedItem = item;
                item.classList.add('dragging');
            });

            item.addEventListener('dragend', () => finishReorder(item));

            const handle = item.querySelector('.drag-handle');
            if (!handle) return;
            handle.addEventListener('touchstart', (event) => {
                if (event.touches.length !== 1) return;
                event.preventDefault();
                draggedItem = item;
                item.classList.add('dragging');
            }, {passive: false});
            handle.addEventListener('touchmove', (event) => {
                if (draggedItem !== item) return;
                event.preventDefault();
                const touch = event.touches[0];
                if (!touch) return;
                const afterElement = getDragAfterElement(container, touch.clientY);
                if (afterElement == null) container.appendChild(item);
                else container.insertBefore(item, afterElement);
            }, {passive: false});
            handle.addEventListener('touchend', (event) => {
                if (draggedItem !== item) return;
                event.preventDefault();
                finishReorder(item);
            }, {passive: false});
            handle.addEventListener('touchcancel', () => {
                if (draggedItem === item) finishReorder(item);
            });
        });

        container.ondragover = (e) => {
            if (!draggedItem) return;
            e.preventDefault();
            const afterElement = getDragAfterElement(container, e.clientY);
            if (afterElement == null) {
                container.appendChild(draggedItem);
            } else {
                container.insertBefore(draggedItem, afterElement);
            }
        };
    }

    function renderDashboardFallback(message = 'Save a playlist offline while online, then it will appear here when the server is unreachable.') {
        const statsGrid = document.getElementById('stats-grid');
        if (statsGrid) {
            statsGrid.innerHTML = `
                <div class="stat-card stat-playlists"><div class="stat-icon"><i class="fas fa-list"></i></div><div><h4>0</h4><p>Playlists</p></div></div>
                <div class="stat-card stat-songs"><div class="stat-icon"><i class="fas fa-music"></i></div><div><h4>0</h4><p>Songs</p></div></div>
                <div class="stat-card stat-time"><div class="stat-icon"><i class="fas fa-clock"></i></div><div><h4>0:00</h4><p>Time Listened</p></div></div>
                <div class="stat-card stat-storage"><div class="stat-icon"><i class="fas fa-hard-drive"></i></div><div><h4>0 B</h4><p>Storage Used</p></div></div>
            `;
        }

        ['recent-songs-list', 'top-songs-list', 'top-songs-duration-list'].forEach((id) => {
            renderEmptyState(document.getElementById(id), {
                icon: 'fa-wifi',
                title: 'Offline library is empty',
                body: message
            });
        });
    }

    async function loadDashboard() {
        try {
            const [statsResponse, recentResponse, topSongsResponse, topDurationResponse] = await Promise.all([
                fetchWithTimeout('/api/dashboard'),
                fetchWithTimeout('/api/songs?limit=5'),
                fetchWithTimeout('/api/top-songs'),
                fetchWithTimeout('/api/top-songs-duration')
            ]);
            if (!statsResponse.ok) throw new Error('Dashboard request failed');
            if (!recentResponse.ok) throw new Error('Recent songs request failed');
            if (!topSongsResponse.ok) throw new Error('Top songs request failed');
            if (!topDurationResponse.ok) throw new Error('Top songs duration request failed');

            const [stats, recentSongs, topSongs, topSongsDuration] = await Promise.all([
                statsResponse.json(),
                recentResponse.json(),
                topSongsResponse.json(),
                topDurationResponse.json()
            ]);

            const statsGrid = document.getElementById('stats-grid');
            if (statsGrid) {
                statsGrid.innerHTML = `
                    <div class="stat-card stat-playlists"><div class="stat-icon"><i class="fas fa-list"></i></div><div><h4>${stats.total_playlists}</h4><p>Playlists</p></div></div>
                    <div class="stat-card stat-songs"><div class="stat-icon"><i class="fas fa-music"></i></div><div><h4>${stats.total_songs}</h4><p>Songs</p></div></div>
                    <div class="stat-card stat-time"><div class="stat-icon"><i class="fas fa-clock"></i></div><div><h4>${formatTime(stats.total_listened)}</h4><p>Time Listened</p></div></div>
                    <div class="stat-card stat-storage"><div class="stat-icon"><i class="fas fa-hard-drive"></i></div><div><h4>${formatBytes(stats.storage_used)}</h4><p>Storage Used</p></div></div>
                `;
            }

            renderSongs(recentSongs.slice(0, 5), 'recent-songs-list', true);
            renderTopSongs(topSongs.slice(0, 5), 'top-songs-list');
            renderTopSongs(topSongsDuration.slice(0, 5), 'top-songs-duration-list');
        } catch (error) {
            console.warn('Dashboard unavailable; showing offline fallback.', error);
            setOfflineMode(true);
            renderDashboardFallback();
        }
    }

    function renderSongs(songs, containerId, showDelete) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';
        if (songs.length === 0) {
            const isSearch = containerId === 'search-results';
            renderEmptyState(container, {
                icon: isSearch ? 'fa-search' : 'fa-compact-disc',
                title: isSearch ? 'No matching songs' : 'No songs here yet',
                body: isSearch
                    ? 'Try another title or artist from your library.'
                    : 'Download a song into one of your playlists to start listening.',
                action: isSearch ? '' : '<i class="fas fa-download"></i> Download',
                actionAttr: 'data-open-download'
            });
            return;
        }

        const activeView = document.querySelector('.view.active');
        const canReorder = containerId === 'playlist-songs-list' && Boolean(state.currentPlaylistId);
        const canAddToPlaylist = containerId === 'search-results';

        songs.forEach((song, index) => {
            const div = document.createElement('div');
            div.className = 'song-item';
            if (canReorder) {
                div.classList.add('is-reorderable');
                div.setAttribute('draggable', 'true');
            }
            const songIdStr = String(song.id);
            div.setAttribute('data-id', songIdStr);

            div.innerHTML = `
                ${canReorder ? '<button class="drag-handle" type="button" aria-label="Reorder song" title="Drag to reorder"><i class="fas fa-grip-lines"></i></button>' : ''}
                <img src="${albumArtUrl(song.album_art)}" class="song-art" alt="" loading="lazy" data-fallback="icon">
                <div class="eq-container"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
                <div class="song-info"><div class="song-title">${escapeHtml(song.title)}</div><div class="song-artist">${escapeHtml(song.artist || 'Unknown')}</div></div>
                <div class="song-duration">${formatTime(song.duration_seconds)}</div>
                ${canAddToPlaylist ? `<button class="btn-secondary compact song-add-playlist" data-id="${song.id}"><i class="fas fa-plus"></i> Add</button>` : ''}
                ${showDelete ? `
                    <button class="icon-btn download-song" data-id="${song.id}" title="Download"><i class="fas fa-download"></i></button>
                    <button class="icon-btn delete-song" data-id="${song.id}"><i class="fas fa-trash"></i></button>
                ` : ''}
            `;
            div.addEventListener('click', (e) => {
                if (!e.target.closest('.delete-song') && !e.target.closest('.download-song') && !e.target.closest('.drag-handle') && !e.target.closest('.song-add-playlist')) playSong(songs, index);
            });
            div.addEventListener('contextmenu', (event) => {
                openSongContextMenu(song, event, {play: () => playSong(songs, index)});
            });
            addSongLongPress(div, song, {play: () => playSong(songs, index)});
            container.appendChild(div);
        });

        if (canAddToPlaylist) {
            container.querySelectorAll('.song-add-playlist').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const songId = Number.parseInt(e.currentTarget.getAttribute('data-id'), 10);
                    const song = songs.find(item => item.id === songId);
                    if (!song) return;
                    openDownloadModal({
                        ...song,
                        add_endpoint: `/api/songs/${song.id}/playlists`,
                        modal_title: 'Add to Playlist',
                        notice_title: 'Add this song to another playlist.'
                    });
                });
            });
        }

        if (canReorder) {
            attachPlaylistReorder(container);
        }

        if (showDelete) {
            container.querySelectorAll('.delete-song').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const deletingFromPlaylist = canReorder && state.currentPlaylistId;
                    const message = deletingFromPlaylist
                        ? 'Remove this song from this playlist? It will only be deleted permanently if no other playlist uses it.'
                        : 'Delete this song completely from all playlists and storage?';
                    if (confirm(message)) {
                        const songId = e.currentTarget.getAttribute('data-id');
                        const playlistQuery = deletingFromPlaylist
                            ? `?playlist_id=${encodeURIComponent(state.currentPlaylistId)}`
                            : '';
                        const response = await fetch(`/api/songs/${songId}${playlistQuery}`, {method: 'DELETE'});
                        const result = await response.json().catch(() => ({}));
                        if (!response.ok) {
                            showToast(result.error || 'Failed to remove song', 'error');
                            return;
                        }
                        showToast(
                            result.song_deleted ? 'Song deleted permanently' : 'Song removed from this playlist',
                            'success'
                        );
                        if (state.currentPlaylistId) {
                            const p = (await (await fetch('/api/playlists')).json()).find(pl => pl.id === state.currentPlaylistId);
                            if (p) openPlaylist(p);
                        } else {
                            loadDashboard();
                        }
                    }
                });
            });

            container.querySelectorAll('.download-song').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const songId = e.currentTarget.getAttribute('data-id');
                    triggerDownload(songId);
                });
            });
        }
        if (activeView && activeView.contains(container)) highlightPlayingSong();
    }

    function renderTopSongs(songs, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (songs.length === 0) {
            renderEmptyState(container, {
                icon: 'fa-chart-line',
                title: 'No listening history yet',
                body: 'Play songs from your room and this section will fill in automatically.'
            });
            return;
        }

        const activeView = document.querySelector('.view.active');

        songs.forEach((song, index) => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.setAttribute('data-id', String(song.id));

            const listenedMins = Math.round((song.total_listened || 0) / 60);
            let listenedText = `${listenedMins} mins`;
            if (listenedMins >= 60) {
                const hrs = Math.floor(listenedMins / 60);
                const mins = listenedMins % 60;
                listenedText = `${hrs}h ${mins}m`;
            }

            div.innerHTML = `
                <img src="${albumArtUrl(song.album_art)}" class="song-art" alt="" loading="lazy" data-fallback="icon">
                <div class="eq-container"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
                <div class="song-info">
                    <div class="song-title">${escapeHtml(song.title)}</div>
                    <div class="song-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                <div class="song-stats">
                    <span class="song-stat-primary"><i class="fas fa-play-circle"></i> ${song.play_count || 0} plays</span>
                    <span class="song-stat-secondary"><i class="fas fa-clock"></i> ${listenedText}</span>
                </div>
                <button class="icon-btn download-song" data-id="${song.id}" title="Download"><i class="fas fa-download"></i></button>
                <button class="icon-btn delete-song" data-id="${song.id}"><i class="fas fa-trash"></i></button>
            `;
            div.addEventListener('click', (e) => {
                if (!e.target.closest('.delete-song') && !e.target.closest('.download-song')) playSong(songs, index);
            });
            div.addEventListener('contextmenu', (event) => {
                openSongContextMenu(song, event, {play: () => playSong(songs, index)});
            });
            addSongLongPress(div, song, {play: () => playSong(songs, index)});
            container.appendChild(div);
        });

        container.querySelectorAll('.delete-song').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('Delete this song completely from all playlists and storage?')) {
                    try {
                        const response = await fetch(`/api/songs/${e.currentTarget.getAttribute('data-id')}`, {method: 'DELETE'});
                        const result = await response.json().catch(() => ({}));
                        if (!response.ok) {
                            showToast(result.error || 'Failed to delete song', 'error');
                            return;
                        }
                        showToast('Song deleted permanently', 'success');
                        loadDashboard();
                    } catch (err) {
                        showToast(err.message || 'Failed to delete song', 'error');
                    }
                }
            });
        });

        container.querySelectorAll('.download-song').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const songId = e.currentTarget.getAttribute('data-id');
                triggerDownload(songId);
            });
        });
        if (activeView && activeView.contains(container)) highlightPlayingSong();
    }

    function highlightPlayingSong() {
        if (!state.currentPlayingSongId || String(state.currentPlayingSongId) === 'null' || String(state.currentPlayingSongId) === 'undefined') {
            return;
        }

        document.querySelectorAll('.song-item.is-playing').forEach(el => el.classList.remove('is-playing'));

        const targetId = String(state.currentPlayingSongId);
        const activeView = document.querySelector('.view.active');
        if (!activeView) return;

        requestAnimationFrame(() => {
            document.querySelectorAll('.song-item.is-playing').forEach(el => el.classList.remove('is-playing'));
            const activeEl = [...activeView.querySelectorAll('.song-item[data-id]')]
                .find(item => item.dataset.id === targetId);
            if (activeEl) {
                activeEl.classList.add('is-playing');
            }
        });
    }

    return {
        loadLibrarySongs,
        renderLibrarySongs,
        loadPlaylists,
        openPlaylist,
        updatePlaylistMeta,
        savePlaylistSongOrder,
        renderDashboardFallback,
        loadDashboard,
        renderSongs,
        renderTopSongs,
        highlightPlayingSong,
    };
};
