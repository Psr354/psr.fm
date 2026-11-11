// ==========================================
// OFFLINE STORAGE & PWA CACHE MODULE
// ==========================================
(function() {
    const OFFLINE_DB = 'psr354-offline';
    const OFFLINE_STORE = 'playlists';
    const OFFLINE_MEDIA_CACHE = 'psr354-media-v3';
    const OFFLINE_PLAYLIST_BACKUP = 'psr354-offline-playlists';

    const getEl = () => window.el || {};
    const getState = () => window.state || {};
    const getToast = (msg, type) => (typeof window.showToast === 'function' ? window.showToast(msg, type) : console.log(msg));
    const getMediaUrlName = (name) => (typeof window.mediaUrlName === 'function' ? window.mediaUrlName(name) : (name || ''));

    function offlineDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(OFFLINE_DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(OFFLINE_STORE, { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function offlinePlaylistAssets(playlist) {
        const assets = new Set();
        if (!playlist) return assets;
        if (playlist.cover_art) assets.add(`/static/album_art/${getMediaUrlName(playlist.cover_art)}`);
        (playlist.songs || []).forEach((song) => {
            assets.add(`/audio/${getMediaUrlName(song.filename)}`);
            if (song.album_art) assets.add(`/static/album_art/${getMediaUrlName(song.album_art)}`);
        });
        return assets;
    }

    async function isUsableOfflineAudio(cache, audioUrl) {
        const response = await cache.match(audioUrl, { ignoreSearch: true });
        return isUsableAudioResponse(response);
    }

    async function isUsableAudioResponse(response) {
        if (!response || !response.ok || response.status === 206) return false;
        if (!(response.headers.get('content-type') || '').startsWith('audio/')) return false;
        try {
            return (await response.clone().blob()).size > 0;
        } catch (_) {
            return false;
        }
    }

    async function requestPersistentOfflineStorage() {
        if (!navigator.storage?.persist) return false;
        try {
            if (await navigator.storage.persisted?.()) return true;
            return await navigator.storage.persist();
        } catch (_) {
            return false;
        }
    }

    function writeOfflinePlaylistBackup(playlists) {
        try {
            localStorage.setItem(OFFLINE_PLAYLIST_BACKUP, JSON.stringify(playlists));
        } catch (_) {}
    }

    function readOfflinePlaylistBackup() {
        try {
            const value = JSON.parse(localStorage.getItem(OFFLINE_PLAYLIST_BACKUP) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_) {
            return [];
        }
    }

    async function hasCompleteOfflineAudio(playlist) {
        const songs = playlist?.songs || [];
        if (!songs.length) return false;
        const cache = await caches.open(OFFLINE_MEDIA_CACHE);
        for (const song of songs) {
            const audioUrl = `/audio/${getMediaUrlName(song.filename)}`;
            if (!await isUsableOfflineAudio(cache, audioUrl)) return false;
        }
        return true;
    }

    async function saveOfflinePlaylist(playlist) {
        const state = getState();
        const songs = [...(state.currentPlaylistSongs || [])];
        if (!songs.length) return getToast('Add songs before saving this playlist offline', 'error');
        const button = document.getElementById('save-playlist-offline-btn');
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving 0%';
        }
        try {
            await requestPersistentOfflineStorage();
            const cache = await caches.open(OFFLINE_MEDIA_CACHE);
            const savedPlaylists = await getOfflinePlaylists();
            const existingPlaylist = savedPlaylists.find((item) => String(item.id) === String(playlist.id));

            if (playlist.cover_art) {
                const coverUrl = `/static/album_art/${getMediaUrlName(playlist.cover_art)}`;
                const response = await fetch(coverUrl, { cache: 'no-store' });
                if (!response.ok) throw new Error('One or more files could not be downloaded');
                await cache.put(coverUrl, response.clone());
            }

            const missingArtwork = new Set();
            for (const song of songs) {
                if (!song.album_art) continue;
                const artworkUrl = `/static/album_art/${getMediaUrlName(song.album_art)}`;
                if (!await cache.match(artworkUrl, { ignoreSearch: true })) missingArtwork.add(artworkUrl);
            }
            const artworkToDownload = [...missingArtwork];
            for (let i = 0; i < artworkToDownload.length; i += 1) {
                const response = await fetch(artworkToDownload[i]);
                if (!response.ok) throw new Error('One or more covers could not be downloaded');
                await cache.put(artworkToDownload[i], response.clone());
                if (button) button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving covers ${i + 1}/${artworkToDownload.length}`;
            }

            const missingSongs = [];
            for (const song of songs) {
                const audioUrl = `/audio/${getMediaUrlName(song.filename)}`;
                if (!await isUsableOfflineAudio(cache, audioUrl)) missingSongs.push(song);
            }
            for (let i = 0; i < missingSongs.length; i += 1) {
                const song = missingSongs[i];
                const audioUrl = `/audio/${getMediaUrlName(song.filename)}`;
                await cache.delete(audioUrl, { ignoreSearch: true });
                const response = await fetch(`/api/songs/${song.id}/offline-audio`, { cache: 'no-store' });
                if (!response.ok || response.status === 206) throw new Error('Audio file could not be downloaded completely');
                const contentType = response.headers.get('content-type') || '';
                const audioBlob = await response.blob();
                if (!contentType.startsWith('audio/') || !audioBlob.size) {
                    throw new Error('Audio file could not be downloaded completely');
                }
                await cache.put(audioUrl, new Response(audioBlob, {
                    status: 200,
                    headers: {
                        'Content-Type': contentType,
                        'Content-Length': String(audioBlob.size),
                        'X-PSR354-Offline-Complete': '1'
                    }
                }));
                if (button) button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving new audio ${i + 1}/${missingSongs.length}`;
            }

            const incompleteSongs = [];
            for (const song of songs) {
                const audioUrl = `/audio/${getMediaUrlName(song.filename)}`;
                if (!await isUsableOfflineAudio(cache, audioUrl)) incompleteSongs.push(song.title);
            }
            if (incompleteSongs.length) {
                throw new Error(`Offline audio is incomplete for ${incompleteSongs.length} song${incompleteSongs.length === 1 ? '' : 's'}`);
            }

            const lyrics = { ...(existingPlaylist?.lyrics || {}) };
            for (let i = 0; i < songs.length; i += 1) {
                try {
                    const response = await fetch(`/api/songs/${songs[i].id}/lyrics`);
                    if (response.ok) lyrics[songs[i].id] = await response.json();
                } catch (error) {
                    console.warn(`Could not refresh lyrics for song ${songs[i].id}`, error);
                }
                if (button) button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Updating lyrics ${i + 1}/${songs.length}`;
            }
            const currentSongIds = new Set(songs.map((song) => String(song.id)));
            Object.keys(lyrics).forEach((songId) => {
                if (!currentSongIds.has(String(songId))) delete lyrics[songId];
            });
            const savedRecord = { ...playlist, songs, lyrics, saved_at: new Date().toISOString() };
            const db = await offlineDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(OFFLINE_STORE, 'readwrite');
                tx.objectStore(OFFLINE_STORE).put(savedRecord);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            db.close();
            writeOfflinePlaylistBackup(savedPlaylists
                .filter((item) => String(item.id) !== String(savedRecord.id))
                .concat(savedRecord));

            if (existingPlaylist) {
                const futurePlaylists = savedPlaylists
                    .filter((item) => String(item.id) !== String(playlist.id))
                    .concat(savedRecord);
                const referencedAssets = new Set(
                    futurePlaylists.flatMap((item) => [...offlinePlaylistAssets(item)])
                );
                const staleAssets = [...offlinePlaylistAssets(existingPlaylist)]
                    .filter((asset) => !referencedAssets.has(asset));
                await Promise.all(staleAssets.map((asset) => cache.delete(asset, { ignoreSearch: true })));
            }

            const message = missingSongs.length
                ? `Downloaded ${missingSongs.length} new song${missingSongs.length === 1 ? '' : 's'} for "${playlist.name}"`
                : `Offline playlist "${playlist.name}" is up to date`;
            getToast(message, 'success');
        } catch (error) {
            console.error('Offline save failed:', error);
            getToast(error.message || 'Offline save failed. Check your connection and storage.', 'error');
        } finally {
            updateOfflineButton();
        }
    }

    async function getOfflinePlaylists() {
        try {
            const db = await offlineDb();
            const playlists = await new Promise((resolve, reject) => {
                const request = db.transaction(OFFLINE_STORE, 'readonly').objectStore(OFFLINE_STORE).getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
            db.close();
            if (playlists.length) writeOfflinePlaylistBackup(playlists);
            return playlists.length ? playlists : readOfflinePlaylistBackup();
        } catch (error) {
            console.warn('IndexedDB unavailable; using playlist metadata backup.', error);
            return readOfflinePlaylistBackup();
        }
    }

    async function getOfflinePlaylist(id) {
        const playlists = await getOfflinePlaylists();
        return playlists.find((playlist) => String(playlist.id) === String(id));
    }

    function isOfflineMode() {
        const state = getState();
        return state.offlineMode || !navigator.onLine;
    }

    function setOfflineMode(enabled) {
        const state = getState();
        state.offlineMode = enabled;
        const status = document.querySelector('.user-status');
        if (status) status.textContent = enabled ? 'Offline' : 'Online';
        if (enabled) {
            const name = document.getElementById('user-name');
            if (name && name.textContent.trim() === 'Loading...') name.textContent = 'Offline Library';
        }
    }

    async function updateOfflineButton() {
        const state = getState();
        const button = document.getElementById('save-playlist-offline-btn');
        if (!button) return;
        const saved = state.currentPlaylist ? await getOfflinePlaylist(state.currentPlaylist.id) : null;
        const complete = saved ? await hasCompleteOfflineAudio(saved) : false;
        button.disabled = isOfflineMode();
        button.innerHTML = saved && complete
            ? (isOfflineMode()
                ? `<i class="fas fa-check"></i> Saved Offline (${saved.songs?.length || 0})`
                : `<i class="fas fa-sync-alt"></i> Update Offline (${saved.songs?.length || 0})`)
            : saved
                ? `<i class="fas fa-exclamation-triangle"></i> Offline Incomplete (${saved.songs?.length || 0})`
            : '<i class="fas fa-cloud-download-alt"></i> Save Offline';
        button.title = isOfflineMode()
            ? 'Offline downloads cannot be changed without a connection'
            : (saved && !complete ? 'Save again to replace incomplete offline audio' : '');
    }

    // Export to window
    window.offlineDb = offlineDb;
    window.offlinePlaylistAssets = offlinePlaylistAssets;
    window.isUsableOfflineAudio = isUsableOfflineAudio;
    window.isUsableAudioResponse = isUsableAudioResponse;
    window.requestPersistentOfflineStorage = requestPersistentOfflineStorage;
    window.writeOfflinePlaylistBackup = writeOfflinePlaylistBackup;
    window.readOfflinePlaylistBackup = readOfflinePlaylistBackup;
    window.hasCompleteOfflineAudio = hasCompleteOfflineAudio;
    window.saveOfflinePlaylist = saveOfflinePlaylist;
    window.getOfflinePlaylists = getOfflinePlaylists;
    window.getOfflinePlaylist = getOfflinePlaylist;
    window.isOfflineMode = isOfflineMode;
    window.setOfflineMode = setOfflineMode;
    window.updateOfflineButton = updateOfflineButton;
})();
