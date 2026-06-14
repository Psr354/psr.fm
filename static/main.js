document.addEventListener('DOMContentLoaded', () => {
    const views = { dashboard: document.getElementById('dashboard-view'), playlist: document.getElementById('playlist-view'), search: document.getElementById('search-view') };
    const audio = document.getElementById('audio-player');
    const socket = io();

    let playQueue = [];
    let currentPlaylistId = null, currentPlaylistSongs = [], currentSongIndex = -1, isShuffle = false, repeatMode = 0;
    let currentPlayingSongId = null;
    let wasPlayingBeforeSeek = false;
    let lastLoggedTime = 0; 

    const progressFill = document.getElementById('progress-fill');
    const volumeFill = document.getElementById('volume-fill');
    const progressBar = document.getElementById('progress-bar');
    const volumeBar = document.getElementById('volume-bar');

    // --- MOBILE MENU ---
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.querySelector('.sidebar');
    if (mobileMenuBtn && sidebar) {
        mobileMenuBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
        document.querySelectorAll('.nav-item, .playlist-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768) sidebar.classList.remove('open');
            });
        });
    }

    // --- UI NAVIGATION ---
    document.getElementById('home-btn').addEventListener('click', () => showView('dashboard'));
    document.getElementById('search-btn').addEventListener('click', () => showView('search'));

    // --- GLOBAL DOWNLOAD MODAL ---
    const globalDownloadBtn = document.getElementById('global-download-btn');
    const globalDownloadModal = document.getElementById('global-download-modal');
    
    if (globalDownloadBtn) {
        globalDownloadBtn.addEventListener('click', async () => {
            const playlists = await (await fetch('/api/playlists')).json();
            const list = document.getElementById('playlist-checkboxes');
            list.innerHTML = '';
            if (playlists.length === 0) {
                list.innerHTML = '<p style="color: var(--text-secondary); font-size: 13px;">No playlists found. Create one first!</p>';
            } else {
                playlists.forEach(p => {
                    list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; padding:8px 0; cursor:pointer;"><input type="checkbox" value="${p.id}" style="width:18px; height:18px; accent-color: var(--accent-color);"><span>${p.name}</span></label>`;
                });
            }
            globalDownloadModal.style.display = 'flex';
            document.getElementById('global-url-input').focus();
        });
    }

    document.getElementById('cancel-global-download-btn').addEventListener('click', () => {
        globalDownloadModal.style.display = 'none';
    });

    document.getElementById('save-global-download-btn').addEventListener('click', async () => {
        const url = document.getElementById('global-url-input').value.trim();
        const checked = Array.from(document.querySelectorAll('#playlist-checkboxes input:checked')).map(cb => parseInt(cb.value));
        if (!url) return showToast('URL is required', 'error');
        if (checked.length === 0) return showToast('Select at least one playlist', 'error');
        
        await fetch('/api/download', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({url: url, playlist_ids: checked}) 
        });
        
        globalDownloadModal.style.display = 'none';
        document.getElementById('global-url-input').value = '';
        showToast('Downloading to selected playlists!', 'success');
        
        const wrapper = document.getElementById('download-progress-wrapper');
        if (wrapper) wrapper.classList.add('active');
    });

    function buildQueue() {
        playQueue = [];
        if (!currentPlaylistSongs || currentPlaylistSongs.length <= 1) {
            updateQueueUI();
            return;
        }
        let remaining = [...currentPlaylistSongs];
        remaining.splice(currentSongIndex, 1); 

        if (isShuffle) {
            for (let i = remaining.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
            playQueue = remaining;
            document.getElementById('queue-mode').innerText = '(Shuffled)';
        } else {
            for (let i = 1; i < currentPlaylistSongs.length; i++) {
                let nextIdx = (currentSongIndex + i) % currentPlaylistSongs.length;
                playQueue.push(currentPlaylistSongs[nextIdx]);
            }
            document.getElementById('queue-mode').innerText = '';
        }
        updateQueueUI();
    }

    function updateQueueUI() {
        const list = document.getElementById('queue-list');
        if (!list) return;
        list.innerHTML = '';
        if (playQueue.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 12px;">Queue is empty</p>';
            return;
        }
        playQueue.slice(0, 15).forEach(song => {
            const div = document.createElement('div');
            div.className = 'queue-item';
            div.innerHTML = `
                <img src="/static/album_art/${song.album_art}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'36\' height=\'36\' viewBox=\'0 0 24 24\' fill=\'%23555\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
                <div class="q-info">
                    <div class="q-title">${song.title}</div>
                    <div class="q-artist">${song.artist || 'Unknown'}</div>
                </div>
            `;
            div.addEventListener('click', () => {
                const idx = currentPlaylistSongs.findIndex(s => s.id === song.id);
                if (idx !== -1) playSong(currentPlaylistSongs, idx);
                document.getElementById('queue-popover').classList.remove('active');
            });
            list.appendChild(div);
        });
    }

    function showView(viewName) {
        Object.values(views).forEach(v => v.classList.remove('active'));
        views[viewName].classList.add('active');
        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
        if (viewName === 'dashboard') document.getElementById('home-btn').classList.add('active');
        if (viewName === 'search') { document.getElementById('search-btn').classList.add('active'); document.getElementById('search-input').focus(); }
        if (viewName === 'dashboard') loadDashboard();
    }

    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'} toast-icon"></i> ${message}`;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 4000);
    }

    // --- WEBSOCKET EVENTS ---
    socket.on('download_progress', (data) => {
        const wrapper = document.getElementById('download-progress-wrapper');
        const bar = document.getElementById('download-progress-bar');
        if (wrapper && bar) {
            wrapper.classList.add('active');
            bar.style.width = `${data.percent}%`;
            if (data.percent >= 100) setTimeout(() => { wrapper.classList.remove('active'); bar.style.width = '0%'; }, 1000);
        }
    });

    socket.on('song_added', (song) => {
        showToast(`Added: ${song.title}`, 'success');
        if (song.playlist_ids && song.playlist_ids.includes(currentPlaylistId)) {
            currentPlaylistSongs.unshift(song);
            renderSongs(currentPlaylistSongs, 'playlist-songs-list', true);
            updatePlaylistMeta();
        }
        loadDashboard();
        loadPlaylists(); 
    });

    socket.on('download_error', (data) => {
        showToast(`Download failed: ${data.error || 'Unknown error'}`, 'error');
        const wrapper = document.getElementById('download-progress-wrapper');
        if(wrapper) wrapper.classList.remove('active');
    });

    // --- MODAL & PLAYLISTS ---
    const modal = document.getElementById('playlist-modal');
    const modalTitle = document.getElementById('modal-title');
    const saveBtn = document.getElementById('save-playlist-btn');
    const nameInput = document.getElementById('playlist-name-input');
    let isRenaming = false;

    document.getElementById('create-playlist-btn').addEventListener('click', () => {
        isRenaming = false;
        modalTitle.innerText = "Create Playlist";
        saveBtn.innerText = "Create";
        nameInput.value = "";
        modal.style.display = 'flex';
        nameInput.focus();
    });

    document.getElementById('rename-playlist-btn').addEventListener('click', () => {
        isRenaming = true;
        modalTitle.innerText = "Rename Playlist";
        saveBtn.innerText = "Save";
        nameInput.value = document.getElementById('playlist-title').innerText;
        modal.style.display = 'flex';
        nameInput.focus();
    });

    document.getElementById('cancel-modal-btn').addEventListener('click', () => modal.style.display = 'none');

    saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (name) {
            if (isRenaming && currentPlaylistId) {
                await fetch(`/api/playlists/${currentPlaylistId}`, {
                    method: 'PUT', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name})
                });
                document.getElementById('playlist-title').innerText = name;
                showToast('Playlist renamed!');
            } else {
                await createPlaylist(name);
                showToast(`Playlist "${name}" created!`);
            }
            nameInput.value = '';
            modal.style.display = 'none';
            loadPlaylists();
        }
    });

    const coverWrapper = document.getElementById('playlist-cover-wrapper');
    const coverInput = document.getElementById('playlist-cover-input');
    const coverImg = document.getElementById('playlist-cover-img');

    if (coverWrapper && coverInput) {
        coverWrapper.addEventListener('click', () => coverInput.click());
        coverInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file && currentPlaylistId) {
                const formData = new FormData();
                formData.append('cover', file);
                const res = await fetch(`/api/playlists/${currentPlaylistId}/cover`, { method: 'POST', body: formData });
                const data = await res.json();
                if (data.status === 'success') {
                    const timestamp = new Date().getTime();
                    coverImg.src = `/static/album_art/${data.cover_art}?t=${timestamp}`;
                    showToast('Cover updated!');
                    loadPlaylists(); 
                } else {
                    showToast('Failed to upload cover', 'error');
                }
            }
        });
    }

    // --- AUDIO CONTROLS ---
    document.getElementById('play-pause-btn').addEventListener('click', togglePlay);
    document.getElementById('prev-btn').addEventListener('click', playPrev);
    document.getElementById('next-btn').addEventListener('click', playNext);
    document.getElementById('shuffle-btn').addEventListener('click', () => {
        isShuffle = !isShuffle;
        document.getElementById('shuffle-btn').classList.toggle('active', isShuffle);
        buildQueue();
    });

    document.getElementById('queue-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('queue-popover').classList.toggle('active');
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#queue-popover') && !e.target.closest('#queue-btn')) {
            const popover = document.getElementById('queue-popover');
            if (popover) popover.classList.remove('active');
        }
    });

    document.getElementById('repeat-btn').addEventListener('click', () => {
        repeatMode = (repeatMode + 1) % 3;
        const btn = document.getElementById('repeat-btn');
        btn.classList.toggle('active', repeatMode > 0);
        btn.innerHTML = repeatMode === 2 ? '<i class="fas fa-redo"></i><span class="repeat-one">1</span>' : '<i class="fas fa-redo"></i>';
    });

    // --- KEYBOARD SHORTCUTS ---
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.code === 'Space' || e.keyCode === 32) {
            e.preventDefault();
            togglePlay();
        }
        if (e.code === 'ArrowRight') playNext();
        if (e.code === 'ArrowLeft') playPrev();
    });

    // Custom Slider Engine & Listen Tracking
    audio.addEventListener('timeupdate', () => {
        if (audio.duration && !isNaN(audio.duration)) {
            const val = (audio.currentTime / audio.duration) * 100;
            progressBar.value = val;
            progressFill.style.width = `${val}%`;
            document.getElementById('current-time').innerText = formatTime(audio.currentTime);

            if(!audio.paused && currentPlayingSongId) {
                const delta = audio.currentTime - lastLoggedTime;
                if(delta >= 5) { 
                    logListen(currentPlayingSongId, delta);
                    lastLoggedTime = audio.currentTime;
                }
            }
        }
    });

    audio.addEventListener('loadedmetadata', () => {
        document.getElementById('duration').innerText = formatTime(audio.duration);
    });

    audio.addEventListener('play', () => {
        lastLoggedTime = audio.currentTime;
        document.getElementById('now-playing-container').classList.add('playing');
    });

    audio.addEventListener('pause', () => {
        document.getElementById('now-playing-container').classList.remove('playing');
        flushListenLog();
    });

    audio.addEventListener('seeked', () => { lastLoggedTime = audio.currentTime; });

    audio.addEventListener('ended', () => {
        flushListenLog();
        handleSongEnded();
    });

    function flushListenLog() {
        if(currentPlayingSongId && lastLoggedTime > 0) {
            const delta = audio.currentTime - lastLoggedTime;
            if(delta > 0) logListen(currentPlayingSongId, delta);
            lastLoggedTime = 0;
        }
    }

    function logListen(songId, seconds) {
        fetch('/api/listen', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({song_id: songId, seconds: seconds})
        }).catch(e => console.error(e));
    }

    progressBar.addEventListener('input', (e) => {
        if(audio.duration && !isNaN(audio.duration)) {
            audio.currentTime = (e.target.value / 100) * audio.duration;
            progressFill.style.width = `${e.target.value}%`;
        }
    });

    progressBar.addEventListener('mousedown', () => {
        wasPlayingBeforeSeek = !audio.paused;
        if (wasPlayingBeforeSeek) audio.pause();
    });

    progressBar.addEventListener('mouseup', () => {
        if (wasPlayingBeforeSeek) audio.play();
    });

    volumeBar.addEventListener('input', (e) => {
        audio.volume = e.target.value / 100;
        volumeFill.style.width = `${e.target.value}%`;
        updateVolumeIcon(audio.volume);
    });
    volumeFill.style.width = '100%'; 

    function updateVolumeIcon(vol) {
        const icon = document.getElementById('volume-icon');
        if (vol === 0) icon.className = 'fas fa-volume-mute';
        else if (vol < 0.5) icon.className = 'fas fa-volume-down';
        else icon.className = 'fas fa-volume-up';
    }

    document.getElementById('search-input').addEventListener('input', debounce(async (e) => {
        const query = e.target.value.trim();
        if (query.length > 1) renderSongs(await searchSongs(query), 'search-results', false);
        else document.getElementById('search-results').innerHTML = '';
    }, 300));

    async function loadPlaylists() {
        const playlists = await (await fetch('/api/playlists')).json();
        const list = document.getElementById('playlist-list');
        list.innerHTML = '';
        playlists.forEach(p => {
            const li = document.createElement('li');
            li.className = 'playlist-item';
            if (p.id === currentPlaylistId) li.classList.add('active');
            li.setAttribute('data-id', p.id);
            const coverSrc = p.cover_art ? `/static/album_art/${p.cover_art}` : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='%23555'><path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/></svg>";
            li.innerHTML = `<img src="${coverSrc}"> <span>${p.name}</span>`;
            li.addEventListener('click', () => openPlaylist(p));
            list.appendChild(li);
        });
    }

    async function createPlaylist(name) {
        await fetch('/api/playlists', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name}) });
    }

    async function openPlaylist(playlist) {
        currentPlaylistId = playlist.id;
        document.getElementById('playlist-title').innerText = playlist.name;

	if (window.innerWidth <= 768) {
        document.querySelector('.sidebar').classList.remove('open');
    	}

        const timestamp = new Date().getTime();
        const coverSrc = playlist.cover_art ? `/static/album_art/${playlist.cover_art}?t=${timestamp}` : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 24 24' fill='%23333'><path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/></svg>";
        coverImg.src = coverSrc;

        showView('playlist');
        loadPlaylists();

        document.getElementById('delete-playlist-btn').onclick = async () => {
            if(confirm(`Delete playlist "${playlist.name}"? (Songs will remain in other playlists)`)) {
                await fetch(`/api/playlists/${playlist.id}`, {method: 'DELETE'});
                currentPlaylistId = null;
                loadPlaylists();
                showView('dashboard');
                showToast('Playlist deleted');
            }
        };
        currentPlaylistSongs = await (await fetch(`/api/songs?playlist_id=${playlist.id}`)).json();
        renderSongs(currentPlaylistSongs, 'playlist-songs-list', true);
        updatePlaylistMeta();
    }

    function updatePlaylistMeta() {
        const meta = document.getElementById('playlist-meta');
        if(!meta) return;
        const totalSec = currentPlaylistSongs.reduce((acc, s) => acc + (s.duration_seconds || 0), 0);
        meta.innerText = `${currentPlaylistSongs.length} songs • ${formatTime(totalSec)}`;
    }

    async function loadDashboard() {
        const stats = await (await fetch('/api/dashboard')).json();
        document.getElementById('stats-grid').innerHTML = `
            <div class="stat-card"><h4>${stats.total_playlists}</h4><p>Playlists</p></div>
            <div class="stat-card"><h4>${stats.total_songs}</h4><p>Songs</p></div>
            <div class="stat-card"><h4>${formatTime(stats.total_listened)}</h4><p>Time Listened</p></div>
            <div class="stat-card"><h4>${formatBytes(stats.storage_used)}</h4><p>Storage Used</p></div>
        `;
        renderSongs(await (await fetch('/api/songs')).json(), 'recent-songs-list', true);

        // top songs load(play)
        const topSongs = await (await fetch('/api/top-songs')).json();
        renderTopSongs(topSongs, 'top-songs-list');

        // top songs load(duration)
        const topSongsDuration = await (await fetch('/api/top-songs-duration')).json();
        renderTopSongs(topSongsDuration, 'top-songs-duration-list');
    }

    function renderSongs(songs, containerId, showDelete) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (songs.length === 0) { container.innerHTML = '<p class="empty-state">No songs here yet.</p>'; return; }

        songs.forEach((song, index) => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.setAttribute('data-id', song.id);
            if (song.id === currentPlayingSongId) div.classList.add('is-playing');

            div.innerHTML = `
                <img src="/static/album_art/${song.album_art}" class="song-art" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' viewBox=\'0 0 24 24\' fill=\'%23b3b3b3\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
                <div class="eq-container"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
                <div class="song-info"><div class="song-title">${song.title}</div><div class="song-artist">${song.artist || 'Unknown'}</div></div>
                <div class="song-duration">${formatTime(song.duration_seconds)}</div>
                ${showDelete ? `<button class="icon-btn delete-song" data-id="${song.id}"><i class="fas fa-trash"></i></button>` : ''}
            `;
            div.addEventListener('click', (e) => { if (!e.target.closest('.delete-song')) playSong(songs, index); });
            container.appendChild(div);
        });

        if (showDelete) container.querySelectorAll('.delete-song').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if(confirm('Delete this song completely from all playlists and storage?')) {
                    await fetch(`/api/songs/${e.currentTarget.getAttribute('data-id')}`, {method: 'DELETE'});
                    showToast('Song deleted permanently');
                    if(currentPlaylistId) {
                        const p = (await (await fetch('/api/playlists')).json()).find(pl => pl.id === currentPlaylistId);
                        if(p) openPlaylist(p);
                    } else {
                        loadDashboard(); 
                    }
                }
            });
        });
    }

    function renderTopSongs(songs, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (songs.length === 0) { container.innerHTML = '<p class="empty-state">No listening history yet. Play some songs!</p>'; return; }

        songs.forEach((song, index) => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.setAttribute('data-id', song.id);
            if (song.id === currentPlayingSongId) div.classList.add('is-playing');

            const listenedMins = Math.round((song.total_listened || 0) / 60);
            let listenedText = `${listenedMins} mins`;
            if (listenedMins >= 60) {
                const hrs = Math.floor(listenedMins / 60);
                const mins = listenedMins % 60;
                listenedText = `${hrs}h ${mins}m`;
            }

            div.innerHTML = `
                <img src="/static/album_art/${song.album_art}" class="song-art" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' viewBox=\'0 0 24 24\' fill=\'%23b3b3b3\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
                <div class="eq-container"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
                <div class="song-info">
                    <div class="song-title">${song.title}</div>
                    <div class="song-artist">${song.artist || 'Unknown'}</div>
                </div>
                <div class="song-stats" style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-left: 16px; min-width: 90px;">
                    <span style="color: var(--accent-color); font-weight: 600; font-size: 13px;"><i class="fas fa-play-circle"></i> ${song.play_count || 0} plays</span>
                    <span style="color: var(--text-secondary); font-size: 12px;"><i class="fas fa-clock"></i> ${listenedText}</span>
                </div>
                <button class="icon-btn delete-song" data-id="${song.id}"><i class="fas fa-trash"></i></button>
            `;
            div.addEventListener('click', (e) => { if (!e.target.closest('.delete-song')) playSong(songs, index); });
            container.appendChild(div);
        });

        container.querySelectorAll('.delete-song').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if(confirm('Delete this song completely from all playlists and storage?')) {
                    await fetch(`/api/songs/${e.currentTarget.getAttribute('data-id')}`, {method: 'DELETE'});
                    showToast('Song deleted permanently');
                    loadDashboard();
                }
            });
        });
    }

    async function searchSongs(query) { return await (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json(); }

    function playSong(songs, index) {
        flushListenLog(); 
        currentPlaylistSongs = songs; currentSongIndex = index;
        const song = songs[index];
        currentPlayingSongId = song.id;
        fetch(`/api/songs/${song.id}/play`, { method: 'POST' }).catch(e => console.error(e));

        // Path audio sekarang langsung ke library tanpa folder_name
        audio.src = `/audio/${song.filename}`;
        audio.play().catch(e => console.log("Autoplay prevented", e));

        document.getElementById('player-title').innerText = song.title;
        document.getElementById('player-artist').innerText = song.artist || 'Unknown';
        document.getElementById('player-art').src = `/static/album_art/${song.album_art}`;

        updatePlayPauseIcon(true);
        highlightPlayingSong();
        buildQueue(); 
    }

    function highlightPlayingSong() {
        document.querySelectorAll('.song-item').forEach(el => el.classList.remove('is-playing'));
        const activeEl = document.querySelector(`.song-item[data-id="${currentPlayingSongId}"]`);
        if (activeEl) activeEl.classList.add('is-playing');
    }

    function togglePlay() {
        if (!audio.src) return;
        if (audio.paused) { audio.play(); updatePlayPauseIcon(true); }
        else { audio.pause(); updatePlayPauseIcon(false); }
    }
    
    function updatePlayPauseIcon(isPlaying) { 
        const btn = document.querySelector('#play-pause-btn i');
        if(btn) btn.className = isPlaying ? 'fas fa-pause' : 'fas fa-play'; 
    }

    function playNext() {
        if (playQueue.length > 0) {
            const nextSong = playQueue.shift(); 
            const idx = currentPlaylistSongs.findIndex(s => s.id === nextSong.id);
            if (idx !== -1) {
                playSong(currentPlaylistSongs, idx);
                return;
            }
        }
        if (currentPlaylistSongs.length === 0) return;
        if (repeatMode === 2) { audio.currentTime = 0; audio.play(); return; }
        let nextIndex = (currentSongIndex + 1) % currentPlaylistSongs.length;
        if (nextIndex === 0 && repeatMode === 0 && currentSongIndex === currentPlaylistSongs.length - 1) {
            audio.pause(); updatePlayPauseIcon(false); return;
        }
        playSong(currentPlaylistSongs, nextIndex);
    }
    
    function playPrev() {
        if (currentPlaylistSongs.length === 0) return;
        if (audio.currentTime > 3) { audio.currentTime = 0; return; }
        playSong(currentPlaylistSongs, (currentSongIndex - 1 + currentPlaylistSongs.length) % currentPlaylistSongs.length);
    }
    
    function handleSongEnded() { playNext(); }

    function formatTime(s) { if (!s || isNaN(s)) return '0:00'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60); return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}` : `${m}:${sec.toString().padStart(2, '0')}`; }
    function formatBytes(b) { if (!b || b === 0) return '0 Bytes'; const i = Math.floor(Math.log(b) / Math.log(1024)); return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + ' ' + ['Bytes', 'KB', 'MB', 'GB', 'TB'][i]; }
    function debounce(f, w) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), w); }; }

    loadPlaylists();
    loadDashboard();
});
