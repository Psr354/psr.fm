// ==========================================
// PLAYBACK PERSISTENCE & CROSS-DEVICE SYNC
// ==========================================
window.createPlaybackSyncModule = function createPlaybackSyncModule(app) {
    const { state, el } = app;
    const CLIENT_DEVICE_ID = state.deviceId;
    const showToast = (...args) => app.showToast(...args);
    const mediaUrlName = (...args) => app.mediaUrlName(...args);
    const albumArtUrl = (...args) => app.albumArtUrl(...args);
    const formatTime = (...args) => app.formatTime(...args);
    const updatePlayPauseIcon = (...args) => app.updatePlayPauseIcon(...args);
    const updateSyncedLyrics = (...args) => app.updateSyncedLyrics(...args);
    const updateMediaSession = (...args) => app.updateMediaSession(...args);
    const buildQueue = (...args) => app.buildQueue(...args);
    const loadLyrics = (...args) => app.loadLyrics(...args);
    const highlightPlayingSong = (...args) => app.highlightPlayingSong(...args);
    const flushListenLog = (...args) => app.flushListenLog(...args);
    const setAppVolume = (...args) => app.setAppVolume(...args);
    const cancelPlaybackRecovery = (...args) => app.cancelPlaybackRecovery(...args);
    const cancelTrackTransitionRecovery = (...args) => app.cancelTrackTransitionRecovery(...args);
    const resumeCurrentSong = (...args) => app.resumeCurrentSong(...args);
    const resumeEqContext = () => window.resumeEqContext?.();

    const playbackUserId = String(document.body?.dataset?.userId || '').trim();
    const PLAYBACK_STATE_KEY = playbackUserId ? `psr_playback_state_${playbackUserId}` : 'psr_playback_state';
    let lastSavePlaybackTime = 0;
    let cachedPlaybackPayload = null;
    let lastServerSyncTime = 0;
    let serverSyncTimer = null;
    let remoteSyncTimeout = null;
    let syncPromptActive = false;
    let activeLoadedMetadataHandler = null;

    function showSyncAutoplayPrompt(targetTime, isRemote = true) {
        if (syncPromptActive) return;
        syncPromptActive = true;
        showToast(
            isRemote
                ? 'Playing on another device. Tap the screen to listen along.'
                : 'Tap the screen to resume playback.',
            'info'
        );

        const unlockAudio = () => {
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('touchend', unlockAudio);
            syncPromptActive = false;
            if (!isRemote) {
                state.isPrimarySyncLeader = true;
            }
            if (state.shouldBePlaying && el.audio) {
                try {
                    if (typeof targetTime === 'number' && targetTime > 0) {
                        state.isSyncSeeking = true;
                        el.audio.currentTime = targetTime;
                    }
                    resumeEqContext();
                    el.audio.play().catch(() => {});
                    updatePlayPauseIcon(true);
                    updateSyncedLyrics(true);
                } catch (_) {}
            }
        };
        document.addEventListener('click', unlockAudio, { once: true });
        document.addEventListener('touchend', unlockAudio, { once: true });
    }

    function syncPlaybackToServer(payload, immediate = false) {
        if (!payload || !navigator.onLine) return;
        if (!state.isPrimarySyncLeader) {
            if (serverSyncTimer) {
                clearTimeout(serverSyncTimer);
                serverSyncTimer = null;
            }
            return;
        }
        const now = Date.now();
        if (!immediate && now - lastServerSyncTime < 3500) {
            if (!serverSyncTimer) {
                serverSyncTimer = setTimeout(() => {
                    serverSyncTimer = null;
                    if (state.isPrimarySyncLeader && cachedPlaybackPayload) {
                        syncPlaybackToServer(cachedPlaybackPayload, true);
                    }
                }, 3500);
            }
            return;
        }
        if (serverSyncTimer) {
            clearTimeout(serverSyncTimer);
            serverSyncTimer = null;
        }
        lastServerSyncTime = now;

        try {
            fetch('/api/playback-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(() => {});
        } catch (_) {}
    }

    function savePlaybackState(force = false, isUserAction = false) {
        if (!state.currentSongMeta || !state.currentPlayingSongId) return;
        const now = Date.now();
        if (!force && now - lastSavePlaybackTime < 2000) return;
        lastSavePlaybackTime = now;
        try {
            const currentTime = el.audio ? el.audio.currentTime : 0;
            const isPlaying = el.audio ? !el.audio.paused : false;

            if (force || !cachedPlaybackPayload || cachedPlaybackPayload.songId !== state.currentPlayingSongId) {
                const slimSongs = Array.isArray(state.currentPlaylistSongs)
                    ? state.currentPlaylistSongs.slice(0, 80).map(s => ({
                        id: s.id,
                        title: s.title,
                        artist: s.artist,
                        album_art: s.album_art,
                        filename: s.filename,
                        duration_seconds: s.duration_seconds
                    }))
                    : [];

                cachedPlaybackPayload = {
                    songId: state.currentPlayingSongId,
                    songMeta: {
                        id: state.currentSongMeta.id,
                        title: state.currentSongMeta.title,
                        artist: state.currentSongMeta.artist,
                        album_art: state.currentSongMeta.album_art,
                        filename: state.currentSongMeta.filename,
                        duration_seconds: state.currentSongMeta.duration_seconds
                    },
                    playlistId: state.currentPlaylistId,
                    playlistSongs: slimSongs,
                    songIndex: state.currentSongIndex,
                    duration: el.audio ? el.audio.duration : 0,
                    repeatMode: state.repeatMode,
                    isShuffle: state.isShuffle
                };
            }
            cachedPlaybackPayload.currentTime = currentTime;
            cachedPlaybackPayload.isPlaying = isPlaying;
            cachedPlaybackPayload.timestamp = now;
            cachedPlaybackPayload.deviceId = CLIENT_DEVICE_ID;
            cachedPlaybackPayload.volume = typeof state.userVolume === 'number' ? state.userVolume : (el.audio ? el.audio.volume : 1);
            cachedPlaybackPayload.isMuted = Boolean(state.userMuted !== undefined ? state.userMuted : (el.audio ? el.audio.muted : false));

            localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(cachedPlaybackPayload));

            if (state.isApplyingRemoteSync || (now - state.lastRemoteSyncAppliedAt < 2500)) {
                return;
            }

            if (state.isPrimarySyncLeader || isUserAction) {
                syncPlaybackToServer(cachedPlaybackPayload, force);
            }
        } catch (_) {}
    }

    function applySavedPlaybackState(saved, startPlaying = false, isRemoteSync = false) {
        if (!saved || !saved.songMeta) return;

        if (state.followerTrackEndTimer) {
            clearTimeout(state.followerTrackEndTimer);
            state.followerTrackEndTimer = null;
        }

        if (isRemoteSync) {
            state.isApplyingRemoteSync = true;
            state.lastRemoteSyncAppliedAt = Date.now();
            state.isPrimarySyncLeader = false;
            if (remoteSyncTimeout) clearTimeout(remoteSyncTimeout);
            remoteSyncTimeout = setTimeout(() => {
                state.isApplyingRemoteSync = false;
                remoteSyncTimeout = null;
            }, 3000);
        }

        const now = Date.now();
        const latencySec = (saved.timestamp && now > saved.timestamp)
            ? Math.min(3, Math.max(0, (now - saved.timestamp) / 1000))
            : 0;

        const shouldPlay = Boolean(startPlaying !== false && (startPlaying === true || saved.isPlaying));
        const targetTime = Math.max(
            0,
            (typeof saved.currentTime === 'number' ? saved.currentTime : 0) + (shouldPlay ? latencySec : 0)
        );

        const currentPlayingId = state.currentPlayingSongId;
        const targetSongId = String(saved.songId || saved.songMeta.id || '');
        const isSameSong = Boolean(currentPlayingId && targetSongId && currentPlayingId === targetSongId);

        if (!isSameSong) {
            flushListenLog();
            state.playEventLogged = false;
            state.pendingPlaySeconds = 0;
            state.playbackSessionId = null;
            state.playbackSessionPromise = null;
            state.playbackRequestId += 1;
        }

        state.currentPlaylistId = saved.playlistId || null;
        state.currentPlaylistSongs = Array.isArray(saved.playlistSongs) && saved.playlistSongs.length ? saved.playlistSongs : [saved.songMeta];
        state.currentSongIndex = typeof saved.songIndex === 'number' ? saved.songIndex : 0;
        state.currentSongMeta = saved.songMeta;
        state.currentPlayingSongId = targetSongId;
        state.playbackStatisticsSongId = saved.songMeta.id;
        state.repeatMode = typeof saved.repeatMode === 'number' ? saved.repeatMode : 0;
        state.isShuffle = Boolean(saved.isShuffle);

        if (el.playerTitle) el.playerTitle.innerText = saved.songMeta.title || '';
        if (el.playerArtist) el.playerArtist.innerText = saved.songMeta.artist || 'Unknown';
        if (el.playerArt) {
            el.playerArt.src = albumArtUrl(saved.songMeta.album_art);
            el.playerArt.alt = (saved.songMeta.title || 'Track') + ' album artwork';
        }
        if (saved.duration && el.duration) {
            el.duration.innerText = formatTime(saved.duration);
        }
        if (typeof targetTime === 'number' && el.currentTime) {
            el.currentTime.innerText = formatTime(targetTime);
            if (saved.duration && saved.duration > 0) {
                const pct = (targetTime / saved.duration) * 100;
                if (el.progressBar) el.progressBar.value = pct;
                if (el.progressFill) el.progressFill.style.width = pct + '%';
            }
        }

        if (typeof saved.volume === 'number') {
            const isMuted = Boolean(saved.isMuted);
            setAppVolume(saved.volume, isMuted, false);
        }

        const shuffleBtn = document.getElementById('shuffle-btn');
        if (shuffleBtn) shuffleBtn.classList.toggle('active', state.isShuffle);

        const repeatBtn = document.getElementById('repeat-btn');
        if (repeatBtn) {
            repeatBtn.classList.toggle('active', state.repeatMode > 0);
            repeatBtn.innerHTML = state.repeatMode === 2
                ? '<i class="fas fa-redo"></i><span class="repeat-one">1</span>'
                : '<i class="fas fa-redo"></i>';
        }

        updateMediaSession(saved.songMeta);
        buildQueue();
        loadLyrics(saved.songMeta.id);
        highlightPlayingSong();

        const audioSrc = saved.songMeta.filename
            ? '/audio/' + mediaUrlName(saved.songMeta.filename)
            : '/api/library-songs/' + saved.songMeta.id + '/stream';

        const currentSrc = el.audio ? (el.audio.getAttribute('src') || el.audio.src || '') : '';
        let currentPath = currentSrc;
        try {
            if (currentSrc) currentPath = new URL(currentSrc, window.location.origin).pathname;
        } catch (_) {}
        const isDifferentSrc = !currentPath || currentPath !== audioSrc;

        const triggerPlayback = () => {
            if (shouldPlay) {
                state.shouldBePlaying = true;
                updatePlayPauseIcon(true);
                resumeEqContext();
                const p = el.audio.play();
                if (p !== undefined) {
                    p.catch((err) => {
                        if (err?.name === 'NotAllowedError') {
                            showSyncAutoplayPrompt(targetTime, isRemoteSync);
                        }
                    });
                }
            } else {
                state.shouldBePlaying = false;
                el.audio.pause();
                updatePlayPauseIcon(false);
            }
        };

        if (el.audio) {
            if (activeLoadedMetadataHandler) {
                el.audio.removeEventListener('loadedmetadata', activeLoadedMetadataHandler);
                activeLoadedMetadataHandler = null;
            }
            if (isDifferentSrc || !isSameSong) {
                el.audio.src = audioSrc;
                const onLoaded = () => {
                    activeLoadedMetadataHandler = null;
                    state.isSyncSeeking = true;
                    try { el.audio.currentTime = targetTime; } catch (_) {}
                    updateSyncedLyrics(true);
                    triggerPlayback();
                };
                activeLoadedMetadataHandler = onLoaded;
                el.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
            } else {
                const drift = Math.abs((el.audio.currentTime || 0) - targetTime);
                if (drift > 1.8) {
                    state.isSyncSeeking = true;
                    try { el.audio.currentTime = targetTime; } catch (_) {}
                    updateSyncedLyrics(true);
                }
                triggerPlayback();
            }
        }
    }

    async function syncPlaybackStateFromServer() {
        if (!navigator.onLine) return;
        try {
            const res = await fetch('/api/playback-state');
            if (!res.ok) return;
            const data = await res.json();
            const serverState = data.playback_state;
            if (!serverState || !serverState.songMeta) return;

            if (el.audio && !el.audio.paused) return;

            const localRaw = localStorage.getItem(PLAYBACK_STATE_KEY);
            let localTime = 0;
            if (localRaw) {
                try { localTime = JSON.parse(localRaw).timestamp || 0; } catch (_) {}
            }

            if ((serverState.timestamp || 0) >= localTime) {
                const now = Date.now();
                const isSameDevice = Boolean(serverState.deviceId && serverState.deviceId === CLIENT_DEVICE_ID);
                const isActivelyPlaying = Boolean(serverState.isPlaying && (now - (serverState.timestamp || 0) < 20000));
                if (isSameDevice && isActivelyPlaying) {
                    state.isPrimarySyncLeader = true;
                }
                applySavedPlaybackState(serverState, isActivelyPlaying, isActivelyPlaying && !isSameDevice);
                localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(serverState));
            }
        } catch (e) {
            console.warn('Could not sync playback state from server:', e);
        }
    }

    function restorePlaybackState() {
        try {
            const raw = localStorage.getItem(PLAYBACK_STATE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved && saved.songMeta && (!el.audio || el.audio.paused)) {
                    applySavedPlaybackState(saved, false);
                }
            }
        } catch (e) {
            console.warn('Could not restore local playback state:', e);
        }
        syncPlaybackStateFromServer();
    }

    function resumePlaybackAfterBackground() {
        if (!state.shouldBePlaying || state.isSeeking || el.audio.ended) return;
        resumeEqContext();
        if (el.audio.paused) resumeCurrentSong();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            flushListenLog();
            if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
                savePlaybackState(true);
            }
        } else {
            cancelPlaybackRecovery();
            cancelTrackTransitionRecovery();
            state.playbackRecoveryInProgress = false;
            highlightPlayingSong();
            resumePlaybackAfterBackground();
            if (!state.isPrimarySyncLeader) {
                updateSyncedLyrics(true);
            }
        }
    });
    window.addEventListener('pageshow', () => {
        cancelPlaybackRecovery();
        cancelTrackTransitionRecovery();
        state.playbackRecoveryInProgress = false;
        resumePlaybackAfterBackground();
        if (!state.isPrimarySyncLeader) {
            updateSyncedLyrics(true);
        }
    });
    window.addEventListener('pagehide', () => {
        flushListenLog();
        if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
            savePlaybackState(true);
        }
    });
    window.addEventListener('beforeunload', () => {
        if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
            savePlaybackState(true);
        }
    });

    if ('launchQueue' in window && 'setConsumer' in window.launchQueue) {
        window.launchQueue.setConsumer(() => {
            cancelPlaybackRecovery();
            cancelTrackTransitionRecovery();
            state.playbackRecoveryInProgress = false;
            highlightPlayingSong();
            resumePlaybackAfterBackground();
        });
    }

    function handleRemotePlaybackSync(remoteState) {
        if (!remoteState || !remoteState.songMeta) return;
        if (remoteState.deviceId && remoteState.deviceId === CLIENT_DEVICE_ID) {
            return;
        }
        applySavedPlaybackState(remoteState, remoteState.isPlaying, true);
        try {
            localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(remoteState));
        } catch (_) {}
    }

    return {
        showSyncAutoplayPrompt,
        syncPlaybackToServer,
        savePlaybackState,
        applySavedPlaybackState,
        syncPlaybackStateFromServer,
        restorePlaybackState,
        resumePlaybackAfterBackground,
        handleRemotePlaybackSync,
    };
};
