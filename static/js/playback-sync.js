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
    let syncPromptTimeout = null;
    let activeLoadedMetadataHandler = null;
    let serverClockOffset = 0;
    let lastAppliedRemoteVolume = null;
    let lastAppliedRemoteMuted = null;

    function showSyncAutoplayPrompt(targetTime, isRemote = true) {
        if (syncPromptActive) return;
        syncPromptActive = true;
        const promptStartTime = Date.now();
        console.log('[Sync] Autoplay prompt shown: targetTime =', targetTime, 'isRemote =', isRemote);
        showToast(
            isRemote
                ? 'Playing on another device. Tap the screen to listen along.'
                : 'Tap the screen to resume playback.',
            'info'
        );

        const unlockAudio = () => {
            if (syncPromptTimeout) {
                clearTimeout(syncPromptTimeout);
                syncPromptTimeout = null;
            }
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('touchend', unlockAudio);
            syncPromptActive = false;
            if (!isRemote) {
                state.isPrimarySyncLeader = true;
            }
            if (state.shouldBePlaying && el.audio) {
                try {
                    const elapsed = Math.max(0, (Date.now() - promptStartTime) / 1000);
                    const effectiveTarget = typeof targetTime === 'number' && targetTime > 0
                        ? targetTime + (isRemote ? elapsed : 0)
                        : null;

                    console.log('[Sync] Screen tapped, unlocking audio playback at', effectiveTarget);
                    resumeEqContext();
                    const playPromise = el.audio.play();
                    if (playPromise !== undefined) {
                        playPromise.catch((e) => console.warn('[Sync] Play after tap rejected:', e));
                    }
                    updatePlayPauseIcon(true);

                    const applySeek = () => {
                        if (typeof effectiveTarget === 'number' && effectiveTarget > 0) {
                            state.isSyncSeeking = true;
                            try { el.audio.currentTime = effectiveTarget; } catch (_) {}
                            state.lastLoggedTime = el.audio.currentTime || effectiveTarget;
                        }
                        updateSyncedLyrics(true);
                    };

                    if (el.audio.readyState >= 1) {
                        applySeek();
                    } else {
                        el.audio.addEventListener('loadedmetadata', applySeek, { once: true });
                    }
                } catch (_) {}
            }
        };

        if (syncPromptTimeout) clearTimeout(syncPromptTimeout);
        syncPromptTimeout = setTimeout(() => {
            syncPromptTimeout = null;
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('touchend', unlockAudio);
            syncPromptActive = false;
        }, 5000);

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
        if (!immediate && now - lastServerSyncTime < 1800) {
            if (!serverSyncTimer) {
                serverSyncTimer = setTimeout(() => {
                    serverSyncTimer = null;
                    if (state.isPrimarySyncLeader && cachedPlaybackPayload) {
                        syncPlaybackToServer(cachedPlaybackPayload, true);
                    }
                }, 1800);
            }
            return;
        }
        if (serverSyncTimer) {
            clearTimeout(serverSyncTimer);
            serverSyncTimer = null;
        }
        lastServerSyncTime = now;

        let socketSent = false;
        if (window.liveSocket && window.liveSocket.connected) {
            try {
                window.liveSocket.emit('playback_state_sync', payload);
                socketSent = true;
            } catch (_) {}
        }

        if (!socketSent || immediate) {
            try {
                fetch('/api/playback-state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch(() => {});
            } catch (_) {}
        }
    }

    function savePlaybackState(force = false, isUserAction = false) {
        if (!state.currentSongMeta || !state.currentPlayingSongId) return;
        const now = Date.now();
        if (!force && now - lastSavePlaybackTime < 2000) return;
        lastSavePlaybackTime = now;
        try {
            const currentTime = el.audio ? el.audio.currentTime : 0;
            const isPlaying = el.audio ? (!el.audio.paused || Boolean(state.shouldBePlaying)) : Boolean(state.shouldBePlaying);

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

                const slimShuffle = (state.isShuffle && Array.isArray(state.shuffleOrder))
                    ? state.shuffleOrder.slice(0, 80).map(s => ({
                        id: s.id,
                        title: s.title,
                        artist: s.artist,
                        album_art: s.album_art,
                        filename: s.filename,
                        duration_seconds: s.duration_seconds
                    }))
                    : null;

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
                    shuffleOrder: slimShuffle,
                    songIndex: state.currentSongIndex,
                    duration: el.audio ? el.audio.duration : 0,
                    repeatMode: state.repeatMode,
                    isShuffle: state.isShuffle
                };
            }
            if (state.isShuffle && Array.isArray(state.shuffleOrder)) {
                cachedPlaybackPayload.shuffleOrder = state.shuffleOrder.slice(0, 80).map(s => ({
                    id: s.id,
                    title: s.title,
                    artist: s.artist,
                    album_art: s.album_art,
                    filename: s.filename,
                    duration_seconds: s.duration_seconds
                }));
            } else {
                cachedPlaybackPayload.shuffleOrder = null;
            }
            cachedPlaybackPayload.currentTime = currentTime;
            cachedPlaybackPayload.isPlaying = isPlaying;
            cachedPlaybackPayload.timestamp = now;
            cachedPlaybackPayload.deviceId = CLIENT_DEVICE_ID;
            cachedPlaybackPayload.volume = typeof state.userVolume === 'number' ? state.userVolume : (el.audio ? el.audio.volume : 1);
            cachedPlaybackPayload.isMuted = Boolean(state.userMuted !== undefined ? state.userMuted : (el.audio ? el.audio.muted : false));
            cachedPlaybackPayload.playbackSessionId = typeof state.playbackSessionId === 'string' && state.playbackSessionId ? state.playbackSessionId : null;
            cachedPlaybackPayload.playEventLogged = Boolean(state.playEventLogged && cachedPlaybackPayload.playbackSessionId);
            cachedPlaybackPayload.pendingPlaySeconds = cachedPlaybackPayload.playEventLogged ? 0 : Math.max(0, Number(state.pendingPlaySeconds || 0));

            localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(cachedPlaybackPayload));

            if (isUserAction) {
                state.isPrimarySyncLeader = true;
                state.isApplyingRemoteSync = false;
                state.lastRemoteSyncAppliedAt = 0;
            }

            if (state.isApplyingRemoteSync || (now - state.lastRemoteSyncAppliedAt < 2500)) {
                return;
            }

            if (state.isPrimarySyncLeader) {
                syncPlaybackToServer(cachedPlaybackPayload, force);
            }
        } catch (_) {}
    }

    function applySavedPlaybackState(saved, startPlaying = false, isRemoteSync = false) {
        if (!saved) return;
        if (saved.syncAction === 'volume') {
            if (typeof saved.volume === 'number') {
                setAppVolume(saved.volume, Boolean(saved.isMuted), false);
            }
            return;
        }
        if (!saved.songMeta) return;

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
        let transitMs = 0;
        const currentClockOffset = typeof window.serverClockOffset === 'number' ? window.serverClockOffset : serverClockOffset;
        if (typeof saved.server_time === 'number') {
            const estimatedServerNow = now + currentClockOffset;
            transitMs = estimatedServerNow - saved.server_time;
        } else if (typeof saved.timestamp === 'number') {
            transitMs = now - saved.timestamp;
        }
        const transitSec = Math.max(0.01, Math.min(0.10, transitMs / 1000));

        const shouldPlay = Boolean(startPlaying !== false && (startPlaying === true || saved.isPlaying));
        const rawCurrentTime = typeof saved.currentTime === 'number' ? saved.currentTime : 0;
        const targetTime = rawCurrentTime < 1.0 ? 0 : Math.max(0, rawCurrentTime + (shouldPlay ? transitSec : 0));

        const currentPlayingId = state.currentPlayingSongId;
        const targetSongId = String(saved.songId || saved.songMeta.id || '');
        const isSameSong = Boolean(currentPlayingId && targetSongId && currentPlayingId === targetSongId);

        if (!isSameSong && state.currentSongMeta) {
            if (!state.playbackHistory) state.playbackHistory = [];
            state.playbackHistory.push(state.currentSongMeta);
            if (state.playbackHistory.length > 50) state.playbackHistory.shift();
        }

        const savedSessionId = (typeof saved.playbackSessionId === 'string' && saved.playbackSessionId.trim())
            ? saved.playbackSessionId.trim()
            : null;
        const hasSavedLoggedSession = Boolean(saved.playEventLogged && savedSessionId);
        const savedPendingSeconds = (typeof saved.pendingPlaySeconds === 'number' && Number.isFinite(saved.pendingPlaySeconds))
            ? Math.max(0, Math.min(2.99, saved.pendingPlaySeconds))
            : 0;

        if (!isSameSong) {
            flushListenLog();
            if (hasSavedLoggedSession) {
                state.playEventLogged = true;
                state.pendingPlaySeconds = 0;
                state.playbackSessionId = savedSessionId;
                state.playbackSessionPromise = Promise.resolve(savedSessionId);
            } else {
                state.playEventLogged = false;
                state.pendingPlaySeconds = savedPendingSeconds;
                state.playbackSessionId = null;
                state.playbackSessionPromise = null;
            }
            state.playbackRequestId += 1;
        } else if (hasSavedLoggedSession && (!state.playEventLogged || state.playbackSessionId !== savedSessionId)) {
            state.playEventLogged = true;
            state.pendingPlaySeconds = 0;
            state.playbackSessionId = savedSessionId;
            state.playbackSessionPromise = Promise.resolve(savedSessionId);
        } else if (isRemoteSync && !hasSavedLoggedSession && targetTime < 3) {
            state.playEventLogged = false;
            state.pendingPlaySeconds = savedPendingSeconds;
            state.playbackSessionId = null;
            state.playbackSessionPromise = null;
        }

        state.currentPlaylistId = saved.playlistId || null;
        state.currentPlaylistSongs = Array.isArray(saved.playlistSongs) && saved.playlistSongs.length ? saved.playlistSongs : [saved.songMeta];
        state.currentSongIndex = typeof saved.songIndex === 'number' ? saved.songIndex : 0;
        state.currentSongMeta = saved.songMeta;
        state.currentPlayingSongId = targetSongId;
        state.playbackStatisticsSongId = saved.songMeta.id;
        state.repeatMode = typeof saved.repeatMode === 'number' ? saved.repeatMode : 0;
        state.isShuffle = Boolean(saved.isShuffle);

        if (saved.isShuffle && Array.isArray(saved.shuffleOrder) && saved.shuffleOrder.length > 0) {
            state.shuffleOrder = saved.shuffleOrder;
            state.shuffleKey = saved.playlistId || state.currentPlaylistId;
        }

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
            const volumeChanged = lastAppliedRemoteVolume === null || Math.abs(saved.volume - lastAppliedRemoteVolume) > 0.01;
            const muteChanged = lastAppliedRemoteMuted === null || isMuted !== lastAppliedRemoteMuted;
            if (!isRemoteSync || volumeChanged || muteChanged) {
                lastAppliedRemoteVolume = saved.volume;
                lastAppliedRemoteMuted = isMuted;
                setAppVolume(saved.volume, isMuted, false);
            }
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

        if (el.audio) {
            if (activeLoadedMetadataHandler) {
                el.audio.removeEventListener('loadedmetadata', activeLoadedMetadataHandler);
                activeLoadedMetadataHandler = null;
            }

            const triggerPlayback = (playbackPos = targetTime) => {
                if (shouldPlay) {
                    state.shouldBePlaying = true;
                    updatePlayPauseIcon(true);
                    resumeEqContext();
                    if (el.audio.paused) {
                        const p = el.audio.play();
                        if (p !== undefined) {
                            p.catch((err) => {
                                if (err?.name === 'NotAllowedError') {
                                    showSyncAutoplayPrompt(playbackPos, isRemoteSync);
                                }
                            });
                        }
                    }
                } else {
                    state.shouldBePlaying = false;
                    el.audio.pause();
                    updatePlayPauseIcon(false);
                    try { el.audio.playbackRate = 1.0; } catch (_) {}
                }
            };

            if (isDifferentSrc || !isSameSong) {
                try { el.audio.playbackRate = 1.0; } catch (_) {}
                el.audio.src = audioSrc;

                if (targetTime === 0) {
                    state.isSyncSeeking = false;
                    state.lastLoggedTime = 0;
                    updateSyncedLyrics(true);
                    triggerPlayback(0);
                } else {
                    const onLoaded = () => {
                        activeLoadedMetadataHandler = null;
                        state.isSyncSeeking = true;
                        try { el.audio.currentTime = targetTime; } catch (_) {}
                        state.lastLoggedTime = el.audio.currentTime || targetTime;
                        updateSyncedLyrics(true);
                    };
                    if (el.audio.readyState >= 1) {
                        onLoaded();
                    } else {
                        activeLoadedMetadataHandler = onLoaded;
                        el.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
                    }
                    triggerPlayback(targetTime);
                }
            } else {
                const currentPos = el.audio.currentTime || 0;
                const diff = currentPos - targetTime;
                const absDrift = Math.abs(diff);

                if (absDrift > 0.5) {
                    state.isSyncSeeking = true;
                    try { el.audio.currentTime = targetTime; } catch (_) {}
                    try { el.audio.playbackRate = 1.0; } catch (_) {}
                    updateSyncedLyrics(true);
                } else if (absDrift > 0.15 && shouldPlay && !el.audio.paused) {
                    const rate = diff < 0 ? 1.05 : 0.95;
                    try { el.audio.playbackRate = rate; } catch (_) {}
                } else if (absDrift > 0.02 && shouldPlay && !el.audio.paused) {
                    const rate = diff < 0 ? 1.02 : 0.98;
                    try { el.audio.playbackRate = rate; } catch (_) {}
                } else {
                    try { el.audio.playbackRate = 1.0; } catch (_) {}
                }

                triggerPlayback(targetTime);
            }
        }
    }

    async function syncPlaybackStateFromServer() {
        if (!navigator.onLine) return;
        try {
            const t0 = Date.now();
            const res = await fetch('/api/playback-state');
            if (!res.ok) return;
            const t1 = Date.now();
            const data = await res.json();
            if (typeof data.server_time === 'number') {
                const rtt = Math.max(0, t1 - t0);
                serverClockOffset = data.server_time - (t0 + rtt / 2);
            }
            const serverState = data.playback_state;
            if (!serverState || !serverState.songMeta) return;

            if (state.isPrimarySyncLeader && el.audio && !el.audio.paused) return;

            const localRaw = localStorage.getItem(PLAYBACK_STATE_KEY);
            let localTime = 0;
            if (localRaw) {
                try { localTime = JSON.parse(localRaw).timestamp || 0; } catch (_) {}
            }

            const now = Date.now();
            const serverNow = typeof data.server_time === 'number' ? data.server_time : now;
            const stateTimestamp = Number(serverState.timestamp || 0);
            const stateServerTime = typeof serverState.server_time === 'number' ? serverState.server_time : stateTimestamp;
            const isActivelyPlaying = Boolean(
                serverState.isPlaying &&
                (Math.abs(serverNow - stateServerTime) < 180000 || Math.abs(now - stateTimestamp) < 180000)
            );
            const isSameDevice = Boolean(serverState.deviceId && serverState.deviceId === CLIENT_DEVICE_ID);
            const isNewerState = stateTimestamp >= localTime;
            const isDifferentDevicePlaying = !isSameDevice && isActivelyPlaying;

            if (isNewerState || isDifferentDevicePlaying) {
                if (isSameDevice && isActivelyPlaying) {
                    state.isPrimarySyncLeader = true;
                }
                console.log('[Sync] Restoring state from server: song =', serverState.songMeta?.title, 'playing =', isActivelyPlaying, 'differentDevice =', isDifferentDevicePlaying);
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
                syncPlaybackStateFromServer();
                app.connectRealtime?.();
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
            syncPlaybackStateFromServer();
            app.connectRealtime?.();
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
        if (!remoteState) return;
        if (remoteState.deviceId && remoteState.deviceId === CLIENT_DEVICE_ID) {
            console.log('[Sync] Remote event ignored: same deviceId (' + CLIENT_DEVICE_ID + ')');
            return;
        }
        if (remoteState.syncAction === 'volume') {
            if (typeof remoteState.volume === 'number') {
                setAppVolume(remoteState.volume, Boolean(remoteState.isMuted), false);
            }
            return;
        }
        if (!remoteState.songMeta) return;
        console.log('[Sync] Remote state received from another device:', remoteState.deviceId, 'song:', remoteState.songMeta?.title, 'isPlaying:', remoteState.isPlaying);
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
