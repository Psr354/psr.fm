// ==========================================
// MODALS MANAGEMENT MODULE
// (Download, Upload, Playlist, Add Songs)
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const el = window.el || {};
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));
    const escapeHtml = window.escapeHtml || ((s) => s);
    const formatTime = window.formatTime || ((s) => s);
    const formatBytes = window.formatBytes || ((b) => {
        if (!b || b === 0) return '0 Bytes';
        const i = Math.floor(Math.log(b) / Math.log(1024));
        return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + ' ' + ['Bytes', 'KB', 'MB', 'GB', 'TB'][i];
    });
    const mediaUrlName = window.mediaUrlName || ((s) => s);
    const debounce = window.debounce || ((fn, delay) => {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    });

    const openPlaylist = (p) => window.openPlaylist?.(p);
    const loadDashboard = () => window.loadDashboard?.();
    const loadLibrarySongs = () => window.loadLibrarySongs?.();
    const loadPlaylists = () => window.loadPlaylists?.();

    // ==========================================
    // 1. DOWNLOAD MODAL
    // ==========================================
    const globalDownloadBtn = document.getElementById('global-download-btn');
    const globalDownloadModal = document.getElementById('global-download-modal');
    const globalUrlInput = document.getElementById('global-url-input');
    const libraryWarning = document.getElementById('download-library-warning');
    const downloadModalTitle = globalDownloadModal?.querySelector('h3');
    const downloadSubmitBtn = document.getElementById('save-global-download-btn');

    function setLibraryWarning(song) {
        state.matchedLibrarySong = song || null;
        if (!libraryWarning) return;
        if (!song) {
            libraryWarning.style.display = 'none';
            libraryWarning.innerHTML = '';
            if (!state.pendingLibrarySong && downloadSubmitBtn) downloadSubmitBtn.innerText = 'Download';
            return;
        }
        if (!state.pendingLibrarySong && downloadSubmitBtn) downloadSubmitBtn.innerText = 'Add';
        libraryWarning.style.display = 'flex';
        libraryWarning.innerHTML = `
            <i class="fas fa-circle-info"></i>
            <div>
                <strong>${escapeHtml(song.notice_title || 'This song is already in Library Songs.')}</strong>
                <span>${escapeHtml(song.title)}${song.artist ? ` - ${escapeHtml(song.artist)}` : ''}</span>
            </div>
        `;
    }

    async function openDownloadModal(librarySong = null) {
        state.pendingLibrarySong = librarySong;
        state.matchedLibrarySong = librarySong;
        const playlists = await (await fetch('/api/playlists')).json();
        const list = document.getElementById('playlist-checkboxes');
        if (!list) return;
        list.innerHTML = '';
        if (playlists.length === 0) {
            list.innerHTML = '<p class="empty-compact">No playlists found. Create one first.</p>';
        } else {
            playlists.forEach(p => {
                list.innerHTML += `<label class="checkbox-row"><input type="checkbox" value="${p.id}"><span>${escapeHtml(p.name)}</span></label>`;
            });
        }
        if (downloadModalTitle) downloadModalTitle.innerText = librarySong ? (librarySong.modal_title || 'Add from Library Songs') : 'Download Song';
        if (downloadSubmitBtn) downloadSubmitBtn.innerText = librarySong ? 'Add' : 'Download';
        if (globalUrlInput) {
            globalUrlInput.value = librarySong ? (librarySong.source_url || `${librarySong.title} - ${librarySong.artist || 'Unknown'}`) : '';
            globalUrlInput.disabled = Boolean(librarySong);
        }
        setLibraryWarning(librarySong);
        if (globalDownloadModal) globalDownloadModal.style.display = 'flex';
        if (globalUrlInput) globalUrlInput.focus();
    }

    globalDownloadBtn?.addEventListener('click', () => openDownloadModal());
    document.getElementById('dashboard-download-btn')?.addEventListener('click', () => openDownloadModal());
    document.addEventListener('click', (e) => {
        if (e.target.closest('[data-open-download]')) openDownloadModal();
    });

    document.getElementById('cancel-global-download-btn')?.addEventListener('click', () => {
        if (globalDownloadModal) globalDownloadModal.style.display = 'none';
        if (globalUrlInput) globalUrlInput.disabled = false;
        state.pendingLibrarySong = null;
        setLibraryWarning(null);
    });

    async function submitDownload() {
        const url = globalUrlInput?.value.trim();
        const checked = Array.from(document.querySelectorAll('#playlist-checkboxes input:checked')).map(cb => parseInt(cb.value));
        if (!url && !state.pendingLibrarySong) return showToast('URL is required', 'error');
        if (checked.length === 0) return showToast('Select at least one playlist', 'error');

        const librarySong = state.pendingLibrarySong || state.matchedLibrarySong;
        state.lastDownloadRequest = librarySong ? null : {url, playlist_ids: checked};
        if (el.downloadRetryBtn) el.downloadRetryBtn.hidden = true;
        const downloadBtn = document.getElementById('save-global-download-btn');
        if (downloadBtn) {
            downloadBtn.disabled = true;
            downloadBtn.innerText = 'Starting...';
        }

        let res, data;
        try {
            const endpoint = librarySong ? (librarySong.add_endpoint || `/api/library-songs/${librarySong.id}/add`) : '/api/download';
            res = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(librarySong ? {playlist_ids: checked} : {url, playlist_ids: checked})
            });
            data = await res.json().catch(() => ({}));
        } catch (err) {
            showToast('Connection error', 'error');
            if (el.downloadRetryBtn && state.lastDownloadRequest) {
                el.downloadRetryBtn.hidden = false;
                el.downloadWrapper?.classList.add('active');
            }
            return;
        } finally {
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.innerText = librarySong ? 'Add' : 'Download';
            }
        }

        if (!res.ok) return showToast(data.error || 'Download request failed', 'error');

        if (globalDownloadModal) globalDownloadModal.style.display = 'none';
        if (globalUrlInput) {
            globalUrlInput.value = '';
            globalUrlInput.disabled = false;
        }
        state.pendingLibrarySong = null;
        setLibraryWarning(null);

        if (data.status === 'added_from_library' || librarySong) {
            const skipped = data.skipped_playlist_ids?.length || 0;
            showToast(skipped ? 'Song already existed in some playlists' : 'Added to selected playlists', 'success');
            if (state.currentPlaylist) openPlaylist(state.currentPlaylist);
            loadDashboard();
            loadLibrarySongs();
            return;
        }

        showToast('Downloading to selected playlists!', 'success');
        if (el.downloadWrapper) el.downloadWrapper.classList.add('active');
    }

    async function retryLastDownload() {
        const request = state.lastDownloadRequest;
        if (!request) return;
        if (el.downloadRetryBtn) {
            el.downloadRetryBtn.disabled = true;
            el.downloadRetryBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Retrying...';
        }
        try {
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(request)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Download request failed');
            if (el.downloadRetryBtn) el.downloadRetryBtn.hidden = true;
            if (el.downloadWrapper) el.downloadWrapper.classList.add('active');
            showToast('Download retried successfully', 'success');
        } catch (error) {
            showToast(error.message || 'Retry failed', 'error');
        } finally {
            if (el.downloadRetryBtn) {
                el.downloadRetryBtn.disabled = false;
                el.downloadRetryBtn.innerHTML = '<i class="fas fa-rotate-right"></i> Retry download';
            }
        }
    }

    document.getElementById('save-global-download-btn')?.addEventListener('click', submitDownload);
    el.downloadRetryBtn?.addEventListener('click', retryLastDownload);
    globalUrlInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitDownload();
    });
    globalUrlInput?.addEventListener('input', debounce(async (e) => {
        if (state.pendingLibrarySong) return;
        const url = e.target.value.trim();
        if (!url || !/(?:youtu(?:be\.com|\.be)|music\.youtube\.com|open\.spotify\.com)/i.test(url)) {
            setLibraryWarning(null);
            return;
        }
        try {
            const res = await fetch(`/api/library-songs/check-url?url=${encodeURIComponent(url)}`);
            const data = await res.json().catch(() => ({}));
            setLibraryWarning(res.ok && data.matched ? data.song : null);
        } catch (err) {
            setLibraryWarning(null);
        }
    }, 350));

    // ==========================================
    // 2. UPLOAD MODAL
    // ==========================================
    const uploadModal = document.getElementById('upload-modal');
    const uploadDropzone = document.getElementById('upload-dropzone');
    const uploadFileInput = document.getElementById('upload-file-input');
    const uploadFileInfo = document.getElementById('upload-file-info');
    const uploadFileName = document.getElementById('upload-file-name');
    const uploadFileSize = document.getElementById('upload-file-size');
    const uploadTitleInput = document.getElementById('upload-title-input');
    const uploadArtistInput = document.getElementById('upload-artist-input');
    const uploadPlaylistCheckboxes = document.getElementById('upload-playlist-checkboxes');
    const uploadProgressWrapper = document.getElementById('upload-progress-wrapper');
    const uploadProgressBar = document.getElementById('upload-progress-bar');
    const uploadProgressLabel = document.getElementById('upload-progress-label');
    const uploadSubmitBtn = document.getElementById('save-upload-btn');
    let uploadSelectedFile = null;

    function resetUploadModal() {
        uploadSelectedFile = null;
        if (uploadFileInput) uploadFileInput.value = '';
        if (uploadFileInfo) uploadFileInfo.style.display = 'none';
        if (uploadDropzone) uploadDropzone.style.display = '';
        if (uploadTitleInput) uploadTitleInput.value = '';
        if (uploadArtistInput) uploadArtistInput.value = '';
        if (uploadProgressWrapper) uploadProgressWrapper.style.display = 'none';
        if (uploadProgressBar) uploadProgressBar.style.width = '0%';
        if (uploadProgressLabel) uploadProgressLabel.textContent = '0%';
        if (uploadSubmitBtn) {
            uploadSubmitBtn.disabled = true;
            uploadSubmitBtn.textContent = 'Upload';
        }
    }

    async function openUploadModal() {
        resetUploadModal();
        const playlists = await (await fetch('/api/playlists')).json();
        if (!uploadPlaylistCheckboxes) return;
        uploadPlaylistCheckboxes.innerHTML = '';
        if (playlists.length === 0) {
            uploadPlaylistCheckboxes.innerHTML = '<p class="empty-compact">No playlists found. Create one first.</p>';
        } else {
            playlists.forEach(p => {
                uploadPlaylistCheckboxes.innerHTML += `<label class="checkbox-row"><input type="checkbox" value="${p.id}"><span>${escapeHtml(p.name)}</span></label>`;
            });
        }
        if (uploadModal) uploadModal.style.display = 'flex';
    }

    function setUploadFile(file) {
        const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac'];
        const allowedExts = ['.mp3', '.wav', '.flac', '.ogg', '.m4a'];
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

        if (!allowedTypes.includes(file.type) && !allowedExts.includes(ext)) {
            showToast('Unsupported file format. Use MP3, WAV, FLAC, OGG, or M4A.', 'error');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            showToast('File too large. Maximum size is 50MB.', 'error');
            return;
        }

        uploadSelectedFile = file;
        if (uploadDropzone) uploadDropzone.style.display = 'none';
        if (uploadFileInfo) uploadFileInfo.style.display = 'flex';
        if (uploadFileName) uploadFileName.textContent = file.name;
        if (uploadFileSize) uploadFileSize.textContent = formatBytes(file.size);
        if (!uploadTitleInput.value) {
            uploadTitleInput.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim();
        }
        if (uploadSubmitBtn) uploadSubmitBtn.disabled = false;
    }

    if (uploadDropzone && uploadFileInput) {
        uploadDropzone.addEventListener('click', () => uploadFileInput.click());
        uploadFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) setUploadFile(e.target.files[0]);
        });

        uploadDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadDropzone.classList.add('drag-over');
        });
        uploadDropzone.addEventListener('dragleave', () => {
            uploadDropzone.classList.remove('drag-over');
        });
        uploadDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadDropzone.classList.remove('drag-over');
            if (e.dataTransfer.files[0]) setUploadFile(e.dataTransfer.files[0]);
        });
    }

    document.getElementById('upload-remove-file')?.addEventListener('click', () => {
        uploadSelectedFile = null;
        if (uploadFileInput) uploadFileInput.value = '';
        if (uploadFileInfo) uploadFileInfo.style.display = 'none';
        if (uploadDropzone) uploadDropzone.style.display = '';
        if (uploadSubmitBtn) uploadSubmitBtn.disabled = true;
    });

    document.getElementById('upload-song-btn')?.addEventListener('click', () => openUploadModal());
    document.getElementById('cancel-upload-btn')?.addEventListener('click', () => {
        if (uploadModal) uploadModal.style.display = 'none';
    });

    async function submitUpload() {
        if (!uploadSelectedFile) return showToast('Select a file first', 'error');
        const checked = Array.from(document.querySelectorAll('#upload-playlist-checkboxes input:checked')).map(cb => parseInt(cb.value));
        if (checked.length === 0) return showToast('Select at least one playlist', 'error');

        const formData = new FormData();
        formData.append('file', uploadSelectedFile);
        formData.append('title', uploadTitleInput?.value.trim() || '');
        formData.append('artist', uploadArtistInput?.value.trim() || '');
        formData.append('playlist_ids', JSON.stringify(checked));

        if (uploadSubmitBtn) {
            uploadSubmitBtn.disabled = true;
            uploadSubmitBtn.textContent = 'Uploading...';
        }
        if (uploadProgressWrapper) uploadProgressWrapper.style.display = 'block';

        try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload');

            const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
            if (csrfMatch) xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(csrfMatch[1]));

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    if (uploadProgressBar) uploadProgressBar.style.width = pct + '%';
                    if (uploadProgressLabel) uploadProgressLabel.textContent = pct + '%';
                }
            });

            const result = await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
                        else reject(new Error(data.error || 'Upload failed'));
                    } catch {
                        reject(new Error('Upload failed'));
                    }
                };
                xhr.onerror = () => reject(new Error('Connection error'));
                xhr.send(formData);
            });

            showToast(`Uploaded: ${result.title} - ${result.artist}`, 'success');
            if (uploadModal) uploadModal.style.display = 'none';
            loadDashboard();
            loadLibrarySongs();
            if (state.currentPlaylist) openPlaylist(state.currentPlaylist);
        } catch (err) {
            showToast(err.message || 'Upload failed', 'error');
        } finally {
            if (uploadSubmitBtn) {
                uploadSubmitBtn.disabled = false;
                uploadSubmitBtn.textContent = 'Upload';
            }
        }
    }

    document.getElementById('save-upload-btn')?.addEventListener('click', submitUpload);

    const mainContent = document.getElementById('main-content');
    if (mainContent) {
        mainContent.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer.types.includes('Files')) {
                mainContent.classList.add('global-drag-active');
            }
        });
        mainContent.addEventListener('dragleave', (e) => {
            if (!mainContent.contains(e.relatedTarget)) {
                mainContent.classList.remove('global-drag-active');
            }
        });
        mainContent.addEventListener('drop', (e) => {
            e.preventDefault();
            mainContent.classList.remove('global-drag-active');
            const file = e.dataTransfer.files[0];
            if (file) {
                openUploadModal();
                setTimeout(() => setUploadFile(file), 100);
            }
        });
    }

    // ==========================================
    // 3. PLAYLIST MODAL & COVER
    // ==========================================
    const playlistModal = document.getElementById('playlist-modal');
    const modalTitle = document.getElementById('modal-title');
    const saveBtn = document.getElementById('save-playlist-btn');
    const nameInput = document.getElementById('playlist-name-input');

    document.getElementById('create-playlist-btn')?.addEventListener('click', () => {
        state.isRenaming = false;
        if (modalTitle) modalTitle.innerText = "Create Playlist";
        if (saveBtn) saveBtn.innerText = "Create";
        if (nameInput) {
            nameInput.value = "";
            nameInput.focus();
        }
        if (playlistModal) playlistModal.style.display = 'flex';
    });

    document.getElementById('rename-playlist-btn')?.addEventListener('click', () => {
        state.isRenaming = true;
        if (modalTitle) modalTitle.innerText = "Rename Playlist";
        if (saveBtn) saveBtn.innerText = "Save";
        if (nameInput && el.playlistTitle) {
            nameInput.value = el.playlistTitle.innerText;
            nameInput.focus();
        }
        if (playlistModal) playlistModal.style.display = 'flex';
    });

    document.getElementById('cancel-modal-btn')?.addEventListener('click', () => {
        if (playlistModal) playlistModal.style.display = 'none';
    });

    async function submitPlaylistModal() {
        const name = nameInput?.value.trim();
        if (!name || !saveBtn) return;

        saveBtn.disabled = true;
        try {
            if (state.isRenaming && state.currentPlaylistId) {
                const response = await fetch(`/api/playlists/${state.currentPlaylistId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name})
                });
                if (!response.ok) throw new Error('Failed to rename playlist');
                if (el.playlistTitle) el.playlistTitle.innerText = name;
                showToast('Playlist renamed!');
            } else {
                const response = await fetch('/api/playlists', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name})
                });
                if (!response.ok) throw new Error('Failed to create playlist');
                showToast(`Playlist "${name}" created!`);
            }
            if (nameInput) nameInput.value = '';
            if (playlistModal) playlistModal.style.display = 'none';
            loadPlaylists();
        } catch (err) {
            showToast('Connection error', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    }

    saveBtn?.addEventListener('click', submitPlaylistModal);
    nameInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitPlaylistModal();
    });

    const coverWrapper = document.getElementById('playlist-cover-wrapper');
    const coverInput = document.getElementById('playlist-cover-input');

    if (coverWrapper && coverInput) {
        coverWrapper.addEventListener('click', () => coverInput.click());
        coverInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file && state.currentPlaylistId) {
                const formData = new FormData();
                formData.append('cover', file);
                try {
                    const res = await fetch(`/api/playlists/${state.currentPlaylistId}/cover`, {
                        method: 'POST',
                        body: formData
                    });
                    const data = await res.json();
                    if (data.status === 'success') {
                        const timestamp = new Date().getTime();
                        if (el.playlistCoverImg) {
                            el.playlistCoverImg.src = `/static/album_art/${mediaUrlName(data.cover_art)}?t=${timestamp}`;
                        }
                        showToast('Cover updated!');
                        loadPlaylists();
                    } else {
                        showToast('Failed to upload cover', 'error');
                    }
                } catch (err) {
                    showToast('Connection error', 'error');
                }
            }
        });
    }

    // ==========================================
    // 4. ADD SONGS TO PLAYLIST MODAL
    // ==========================================
    const addSongsModal = document.getElementById('add-songs-modal');
    const addSongsList = document.getElementById('add-songs-list');
    const addSongsSearchInput = document.getElementById('add-songs-search-input');
    const confirmAddSongsBtn = document.getElementById('confirm-add-songs-btn');
    const addSongsCountLabel = document.getElementById('add-songs-count');
    const addSongsSelected = new Set();

    function renderAddSongsList(songs) {
        if (!addSongsList) return;
        const currentSongs = state.currentPlaylistSongs || [];
        const existingIds = new Set(currentSongs.map(s => String(s.source_id || `f:${s.filename}`)));
        addSongsList.innerHTML = '';
        if (!songs.length) {
            addSongsList.innerHTML = '<p class="empty-compact">No songs found in Library Songs.</p>';
            updateAddSongsCount();
            return;
        }
        songs.forEach((song) => {
            const alreadyIn = existingIds.has(String(song.source_id || `f:${song.filename}`));
            const row = document.createElement('label');
            row.className = 'add-song-row' + (alreadyIn ? ' is-added' : '');
            if (addSongsSelected.has(song.id)) row.classList.add('is-selected');
            row.innerHTML = `
                <input type="checkbox" value="${song.id}" ${alreadyIn ? 'disabled' : ''} ${addSongsSelected.has(song.id) ? 'checked' : ''}>
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" alt="" loading="lazy" onerror="this.style.background='#282828'; this.removeAttribute('src');">
                <div class="add-song-info">
                    <div class="add-song-title">${escapeHtml(song.title)}</div>
                    <div class="add-song-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                ${alreadyIn ? '<span class="added-pill">In playlist</span>' : `<span class="add-song-dur">${formatTime(song.duration_seconds)}</span>`}
            `;
            const checkbox = row.querySelector('input');
            if (!alreadyIn) {
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) addSongsSelected.add(song.id);
                    else addSongsSelected.delete(song.id);
                    row.classList.toggle('is-selected', checkbox.checked);
                    updateAddSongsCount();
                });
            }
            addSongsList.appendChild(row);
        });
        updateAddSongsCount();
    }

    function getAddSongsSelectedIds() {
        return [...addSongsSelected];
    }

    function updateAddSongsCount() {
        if (!confirmAddSongsBtn) return;
        const count = getAddSongsSelectedIds().length;
        confirmAddSongsBtn.disabled = count === 0;
        if (addSongsCountLabel) addSongsCountLabel.innerText = count ? `(${count})` : '';
    }

    async function loadAddSongsList(query = '') {
        if (!addSongsList) return;
        addSongsList.innerHTML = '<p class="empty-compact">Loading Library Songs...</p>';
        updateAddSongsCount();
        try {
            const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
            const songs = await (await fetch(`/api/library-songs${suffix}`)).json();
            renderAddSongsList(songs);
        } catch (err) {
            addSongsList.innerHTML = '<p class="empty-compact">Library unavailable. Try again.</p>';
            updateAddSongsCount();
        }
    }

    function openAddSongsModal() {
        if (!state.currentPlaylistId || !addSongsModal) return;
        addSongsSelected.clear();
        updateAddSongsCount();
        const nameEl = document.getElementById('add-songs-playlist-name');
        if (nameEl) nameEl.innerText = state.currentPlaylist?.name || 'this playlist';
        if (addSongsSearchInput) addSongsSearchInput.value = '';
        addSongsModal.style.display = 'flex';
        loadAddSongsList();
        addSongsSearchInput?.focus();
    }

    function closeAddSongsModal() {
        if (addSongsModal) addSongsModal.style.display = 'none';
    }

    document.getElementById('playlist-add-songs-btn')?.addEventListener('click', openAddSongsModal);
    document.getElementById('cancel-add-songs-btn')?.addEventListener('click', closeAddSongsModal);
    addSongsModal?.addEventListener('click', (e) => {
        if (e.target === addSongsModal) closeAddSongsModal();
    });
    addSongsSearchInput?.addEventListener('input', debounce((e) => {
        loadAddSongsList(e.target.value.trim());
    }, 300));

    confirmAddSongsBtn?.addEventListener('click', async () => {
        const playlistId = state.currentPlaylistId;
        const songIds = getAddSongsSelectedIds();
        if (!playlistId || songIds.length === 0) return;

        confirmAddSongsBtn.disabled = true;
        const originalLabel = confirmAddSongsBtn.innerHTML;
        confirmAddSongsBtn.innerText = 'Adding...';

        let addedCount = 0;
        let failedCount = 0;
        for (const songId of songIds) {
            try {
                const res = await fetch(`/api/library-songs/${songId}/add`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({playlist_ids: [playlistId]})
                });
                if (res.ok) addedCount += 1;
                else failedCount += 1;
            } catch (err) {
                failedCount += 1;
            }
        }

        confirmAddSongsBtn.innerHTML = originalLabel;
        closeAddSongsModal();

        if (addedCount) {
            showToast(`Added ${addedCount} song${addedCount === 1 ? '' : 's'} to playlist`, 'success');
            if (state.currentPlaylist) openPlaylist(state.currentPlaylist);
            loadDashboard();
        }
        if (failedCount) showToast(`${failedCount} song${failedCount === 1 ? '' : 's'} could not be added`, 'error');
    });

    // Export to window
    window.openDownloadModal = openDownloadModal;
    window.openUploadModal = openUploadModal;
    window.openAddSongsModal = openAddSongsModal;
    window.closeAddSongsModal = closeAddSongsModal;
    window.setLibraryWarning = setLibraryWarning;
    window.submitDownload = submitDownload;
    window.retryLastDownload = retryLastDownload;
    window.resetUploadModal = resetUploadModal;
    window.setUploadFile = setUploadFile;
    window.submitUpload = submitUpload;
    window.submitPlaylistModal = submitPlaylistModal;
});
})();
