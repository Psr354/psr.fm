// ==========================================
// PLAYER, TELEMETRY & AUDIO CONTROLS MODULE
// ==========================================
window.createPlayerModule = function createPlayerModule(app) {
    const { state, el, listeningSync } = app;
    const mediaUrlName = (...args) => app.mediaUrlName(...args);
    const albumArtUrl = (...args) => app.albumArtUrl(...args);
    const formatTime = (...args) => app.formatTime(...args);
    const showToast = (...args) => app.showToast(...args);
    const isOfflineMode = () => app.isOfflineMode();
    const isUsableAudioResponse = (...args) => app.isUsableAudioResponse(...args);
    const updatePlayPauseIcon = (...args) => app.updatePlayPauseIcon(...args);
    const updateVolumeIcon = (...args) => app.updateVolumeIcon(...args);
    const setVolumePopoverOpen = (...args) => app.setVolumePopoverOpen(...args);
    const updateLoopIndicator = () => app.updateLoopIndicator();
    const resetLoop = () => app.resetLoop();
    const applyMasterVolume = (...args) => app.applyMasterVolume(...args);
    const resumeEqContext = () => window.resumeEqContext?.();
    const startLyricAnimation = () => app.startLyricAnimation();
    const stopLyricAnimation = () => app.stopLyricAnimation();
    const updateSyncedLyrics = (...args) => app.updateSyncedLyrics(...args);
    const loadLyrics = (...args) => app.loadLyrics(...args);
    const savePlaybackState = (...args) => app.savePlaybackState(...args);
    const buildQueue = (...args) => app.buildQueue(...args);
    const updateQueueUI = (...args) => app.updateQueueUI(...args);
    const playQueuedSong = (...args) => app.playQueuedSong(...args);
    const highlightPlayingSong = (...args) => app.highlightPlayingSong(...args);

    // ==========================================
    // AUDIO EVENT LISTENERS
    // ==========================================
    el.audio.addEventListener('timeupdate', () => {
        if (el.audio.duration && !isNaN(el.audio.duration)) {
            const val = (el.audio.currentTime / el.audio.duration) * 100;
            if (!state.isSeeking) {
                if (el.progressBar) el.progressBar.value = val;
                if (el.progressFill) el.progressFill.style.width = `${val}%`;
            }
            if (el.currentTime) el.currentTime.innerText = formatTime(el.audio.currentTime);
            updateSyncedLyrics();

            if (state.isLooping && el.audio.currentTime >= state.loopEnd) {
                seekAudio(state.loopStart);
            }

            if (!el.audio.paused && !el.audio.seeking && !state.isSeeking && state.currentPlayingSongId) {
                const delta = el.audio.currentTime - state.lastLoggedTime;
                const chunkThreshold = state.playEventLogged
                    ? 5
                    : Math.max(0.25, getPlayCountThreshold() - (state.pendingPlaySeconds || 0));
                if (delta >= chunkThreshold) {
                    ensurePlayLoggedAndFlush(delta);
                    state.lastLoggedTime = el.audio.currentTime;
                } else if (delta < 0) {
                    state.lastLoggedTime = el.audio.currentTime;
                }
                savePlaybackState(false);
            }
            updateMediaSessionPosition();
        }
    });

    el.audio.addEventListener('loadedmetadata', () => {
        if (el.duration) el.duration.innerText = formatTime(el.audio.duration);
        if (state.isLooping || state.loopStart > 0 || state.loopEnd > 0) resetLoop();
        updateLoopIndicator();
        updateMediaSessionPosition();
    });

    el.audio.addEventListener('play', () => {
        cancelPlaybackRecovery();
        cancelTrackTransitionRecovery();
        if (typeof resumeEqContext === 'function') resumeEqContext();
        state.shouldBePlaying = true;
        state.playbackRetryCount = 0;
        state.lastLoggedTime = el.audio.currentTime;
        if (el.nowPlaying) el.nowPlaying.classList.add('playing');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        startLyricAnimation();
        updateMediaSessionPosition();
        if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
            savePlaybackState(true);
        }
    });

    el.audio.addEventListener('playing', () => {
        if (typeof resumeEqContext === 'function') resumeEqContext();
    });

    el.audio.addEventListener('pause', () => {
        if (el.nowPlaying) el.nowPlaying.classList.remove('playing');
        stopLyricAnimation();
        flushListenLog();
        if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
            savePlaybackState(true);
        }
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        if (state.shouldBePlaying) {
            schedulePlaybackRecovery();
        }
    });

    el.audio.addEventListener('seeking', () => {
        // The browser has already changed currentTime; do not count that jump.
        state.lastLoggedTime = el.audio.currentTime;
    });

    el.audio.addEventListener('seeked', () => {
        state.lastLoggedTime = el.audio.currentTime;
        updateSyncedLyrics(true);
        if (state.isSyncSeeking) {
            state.isSyncSeeking = false;
            return;
        }
        if (state.isPrimarySyncLeader && !state.isApplyingRemoteSync) {
            savePlaybackState(true, true);
        }
    });

    el.audio.addEventListener('ended', () => {
        cancelPlaybackRecovery();
        stopLyricAnimation();
        flushListenLog();
        const isLeader = state.isPrimarySyncLeader !== false;
        if (isLeader) {
            playNext(true);
            scheduleTrackTransitionRecovery();
        } else {
            if (state.followerTrackEndTimer) {
                clearTimeout(state.followerTrackEndTimer);
                state.followerTrackEndTimer = null;
            }
            if (typeof setTimeout === 'function') {
                state.followerTrackEndTimer = setTimeout(() => {
                    state.followerTrackEndTimer = null;
                    if (el.audio && el.audio.ended) {
                        state.isPrimarySyncLeader = true;
                        playNext(true);
                        scheduleTrackTransitionRecovery();
                    }
                }, 4000);
            } else {
                playNext(true);
                scheduleTrackTransitionRecovery();
            }
        }
    });

    el.audio.addEventListener('waiting', schedulePlaybackRecovery);
    el.audio.addEventListener('stalled', schedulePlaybackRecovery);

    function cancelPlaybackRecovery() {
        if (state.playbackRecoveryTimer == null) return;
        clearTimeout(state.playbackRecoveryTimer);
        state.playbackRecoveryTimer = null;
    }

    function cancelTrackTransitionRecovery() {
        if (state.trackTransitionTimer == null) return;
        clearTimeout(state.trackTransitionTimer);
        state.trackTransitionTimer = null;
    }

    function scheduleTrackTransitionRecovery() {
        if (typeof setTimeout !== 'function') return;
        cancelTrackTransitionRecovery();
        const requestId = state.playbackRequestId;
        state.trackTransitionTimer = setTimeout(() => {
            state.trackTransitionTimer = null;
            if (!state.shouldBePlaying || requestId !== state.playbackRequestId) return;
            if (el.audio.paused) resumeCurrentSong(requestId);
        }, 2000);
    }

    function schedulePlaybackRecovery() {
        if (!state.shouldBePlaying || state.isSeeking || state.playbackRecoveryInProgress
            || state.playbackRecoveryTimer !== null) return;
        const requestId = state.playbackRequestId;
        const stalledAt = el.audio.currentTime;
        state.playbackRecoveryTimer = setTimeout(() => {
            state.playbackRecoveryTimer = null;
            if (!state.shouldBePlaying || state.isSeeking || requestId !== state.playbackRequestId) return;
            if (!el.audio.paused && el.audio.currentTime > stalledAt) return;
            if (el.audio.currentTime > stalledAt + 0.25) return;
            if (el.audio.paused) {
                resumeCurrentSong(requestId);
                return;
            }

            if (document.hidden) return;

            state.playbackRecoveryInProgress = true;
            const position = el.audio.currentTime;
            const restorePosition = () => {
                state.playbackRecoveryInProgress = false;
                if (!state.shouldBePlaying || requestId !== state.playbackRequestId) return;
                try { el.audio.currentTime = position; } catch (_) {}
                resumeCurrentSong(requestId);
            };
            el.audio.addEventListener('loadedmetadata', restorePosition, {once: true});
            el.audio.pause();
            cancelPlaybackRecovery();
            el.audio.load();
        }, 3000);
    }

    el.audio.addEventListener('canplay', () => {
        if (state.playbackRecoveryInProgress) return;
        if (state.shouldBePlaying && !state.isSeeking && el.audio.paused && !el.audio.ended) resumeCurrentSong();
    });

    el.audio.addEventListener('error', () => {
        if (!state.shouldBePlaying) return;
        if (state.playbackRetryCount < 2) {
            state.playbackRetryCount += 1;
            const requestId = state.playbackRequestId;
            setTimeout(() => {
                if (!state.shouldBePlaying || requestId !== state.playbackRequestId) return;
                el.audio.load();
                resumeCurrentSong(requestId);
            }, 250);
            return;
        }

        state.playbackRetryCount = 0;
        playNext(true);
    });

    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            state.isPrimarySyncLeader = true;
            playPrev();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            state.isPrimarySyncLeader = true;
            playNext(false);
        });
        navigator.mediaSession.setActionHandler('play', () => {
            state.isPrimarySyncLeader = true;
            state.shouldBePlaying = true;
            resumeCurrentSong();
            updatePlayPauseIcon(true);
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            state.isPrimarySyncLeader = true;
            state.shouldBePlaying = false;
            el.audio.pause();
            updatePlayPauseIcon(false);
        });
        navigator.mediaSession.setActionHandler('seekto', ({ seekTime }) => {
            if (Number.isFinite(seekTime)) {
                state.isPrimarySyncLeader = true;
                seekAudio(seekTime);
            }
        });
    }

    function updateMediaSession(song) {
        if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
        const artworkUrl = new URL(albumArtUrl(song.album_art), window.location.origin).href;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title || 'Unknown',
            artist: song.artist || 'Unknown',
            artwork: [{ src: artworkUrl, sizes: '512x512' }]
        });
    }

    function updateMediaSessionPosition() {
        if (!('mediaSession' in navigator) || !el.audio.duration || !Number.isFinite(el.audio.duration)) return;
        try {
            navigator.mediaSession.setPositionState({
                duration: el.audio.duration,
                position: Math.min(el.audio.currentTime, el.audio.duration),
                playbackRate: el.audio.playbackRate || 1
            });
        } catch (_) {}
    }

    function flushListenLog() {
        if (state.currentPlayingSongId) {
            const delta = el.audio.currentTime - state.lastLoggedTime;
            if (delta > 0 && !el.audio.seeking && !state.isSeeking) {
                ensurePlayLoggedAndFlush(delta);
            }
            state.lastLoggedTime = el.audio.currentTime;
        }
    }

    const PLAY_COUNT_THRESHOLD_SECONDS = 3;

    function canRecordPlaybackStats() {
        return state.isPrimarySyncLeader !== false;
    }

    function getPlayCountThreshold() {
        const dur = el.audio && el.audio.duration;
        if (dur && Number.isFinite(dur) && dur > 0) {
            return Math.min(PLAY_COUNT_THRESHOLD_SECONDS, dur);
        }
        return PLAY_COUNT_THRESHOLD_SECONDS;
    }

    function ensurePlayLoggedAndFlush(seconds) {
        if (!canRecordPlaybackStats() || !state.currentPlayingSongId || !(seconds > 0)) return;
        if (!state.playEventLogged) {
            state.pendingPlaySeconds = (state.pendingPlaySeconds || 0) + seconds;
            if (state.pendingPlaySeconds < getPlayCountThreshold()) {
                return;
            }
            const initialSeconds = state.pendingPlaySeconds;
            state.pendingPlaySeconds = 0;
            state.playEventLogged = true;
            state.playbackSessionId = null;
            const songId = state.currentPlayingSongId;
            const playbackRequestId = state.playbackRequestId;
            const startedAt = new Date(Date.now() - initialSeconds * 1000).toISOString();
            state.playbackSessionPromise = state.playbackStatisticsSongId
                ? logPlay(state.playbackStatisticsSongId, startedAt) : Promise.resolve(null);
            state.playbackSessionPromise.then((sessionId) => {
                if (
                    String(state.currentPlayingSongId) === String(songId)
                    && state.playbackRequestId === playbackRequestId
                ) {
                    state.playbackSessionId = sessionId;
                    if (sessionId && typeof savePlaybackState === 'function') {
                        savePlaybackState(true);
                    }
                }
            });
            logListenDuration(songId, initialSeconds);
            return;
        }
        logListenDuration(state.currentPlayingSongId, seconds);
    }

    async function logListen(songId, seconds) {
        // Capture this playback's session before a track switch or repeat.
        songId = state.playbackStatisticsSongId;
        if (!songId) return;
        const session = state.playbackSessionPromise || state.playbackSessionId;
        const occurredAt = new Date().toISOString();
        try {
            const sessionId = await session;
            if (sessionId) await listeningSync.listen(songId, sessionId, seconds, occurredAt);
        } catch (error) {
            console.error('Listening log could not be sent:', error);
        }
    }

    function logListenDuration(songId, seconds) {
        let remaining = seconds;
        while (remaining > 0) {
            const chunk = Math.min(remaining, 30);
            logListen(songId, chunk);
            remaining -= chunk;
        }
    }

    function seekAudio(position) {
        if (!Number.isFinite(position)) return;
        flushListenLog();
        state.isPrimarySyncLeader = true;
        el.audio.currentTime = position;
        // Reset immediately: pause/timeupdate may arrive before seeked.
        state.lastLoggedTime = el.audio.currentTime;
    }

    const seekFromPointer = (event) => {
        if (!el.progressBar || !el.audio.duration || isNaN(el.audio.duration)) return;
        const rect = el.progressBar.getBoundingClientRect();
        if (!rect.width) return;
        const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const value = percent * 100;
        el.progressBar.value = value;
        seekAudio(percent * el.audio.duration);
        if (el.progressFill) el.progressFill.style.width = `${value}%`;
        if (el.currentTime) el.currentTime.innerText = formatTime(el.audio.currentTime);
    };

    el.progressBar?.addEventListener('input', (e) => {
        if (el.audio.duration && !isNaN(el.audio.duration)) {
            seekAudio((e.target.value / 100) * el.audio.duration);
            if (el.progressFill) el.progressFill.style.width = `${e.target.value}%`;
        }
    });

    el.progressBar?.addEventListener('pointerdown', (event) => {
        flushListenLog();
        state.isSeeking = true;
        state.wasPlayingBeforeSeek = !el.audio.paused;
        if (state.wasPlayingBeforeSeek) el.audio.pause();
        seekFromPointer(event);
        try {
            el.progressBar.setPointerCapture?.(event.pointerId);
        } catch (_) {}
    });
    el.progressBar?.addEventListener('pointermove', (event) => {
        if (state.isSeeking) seekFromPointer(event);
    });

    const finishSeek = (event) => {
        if (!state.isSeeking) return;
        try {
            if (el.progressBar.hasPointerCapture?.(event.pointerId)) {
                el.progressBar.releasePointerCapture(event.pointerId);
            }
        } catch (_) {}
        state.isSeeking = false;
        if (state.wasPlayingBeforeSeek) el.audio.play().catch(() => {});
        state.isPrimarySyncLeader = true;
        savePlaybackState(true, true);
    };
    el.progressBar?.addEventListener('pointerup', finishSeek);
    el.progressBar?.addEventListener('pointercancel', finishSeek);

    state.lastNonZeroVolume = 1;
    state.userVolume = 1;
    state.userMuted = false;

    let volumeLeaderSaveTimer = null;
    function setAppVolume(vol, isMuted = false, shouldSave = true) {
        const normalized = Math.max(0, Math.min(1, Number(vol)));
        if (!isMuted && normalized > 0) {
            state.lastNonZeroVolume = normalized;
        }
        state.userVolume = normalized;
        state.userMuted = Boolean(isMuted);

        const effective = isMuted ? 0 : normalized;

        if (window.applyMasterVolume && window.isEqPipelineActive?.()) {
            try { el.audio.volume = 1; } catch {}
            try { el.audio.muted = Boolean(isMuted); } catch {}
            applyMasterVolume(effective, isMuted);
        } else if (el.audio) {
            try { el.audio.volume = effective; } catch {}
            try { el.audio.muted = Boolean(isMuted); } catch {}
        }

        const percent = Math.round(effective * 100);
        if (el.volumeBar) el.volumeBar.value = String(percent);
        if (el.volumeFill) el.volumeFill.style.width = `${percent}%`;

        const popoverBar = document.getElementById('volume-popover-bar');
        const popoverFill = document.getElementById('volume-popover-fill');
        const popoverPercent = document.getElementById('volume-popover-percent');
        const popoverMuteBtn = document.getElementById('volume-popover-mute-btn');
        if (popoverBar) popoverBar.value = String(percent);
        if (popoverFill) popoverFill.style.width = `${percent}%`;
        if (popoverPercent) popoverPercent.textContent = `${percent}%`;
        if (popoverMuteBtn) {
            popoverMuteBtn.classList.toggle('active', isMuted || effective === 0);
            const muteIcon = popoverMuteBtn.querySelector('i');
            if (muteIcon) {
                muteIcon.className = (isMuted || effective === 0) ? 'fas fa-volume-mute' : (effective < 0.5 ? 'fas fa-volume-down' : 'fas fa-volume-up');
            }
        }

        document.querySelectorAll('.volume-preset-btn').forEach(btn => {
            const btnVal = parseInt(btn.getAttribute('data-vol'), 10);
            btn.classList.toggle('active', !isMuted && btnVal === percent);
        });

        updateVolumeIcon(effective);
        if (shouldSave) {
            if (state.isPrimarySyncLeader) {
                if (volumeLeaderSaveTimer) clearTimeout(volumeLeaderSaveTimer);
                volumeLeaderSaveTimer = setTimeout(() => {
                    volumeLeaderSaveTimer = null;
                    if (state.isPrimarySyncLeader) savePlaybackState(true, true);
                }, 150);
            } else {
                savePlaybackState(false, false);
            }
        }
    }
    window.setAppVolume = setAppVolume;

    const flushVolumeSaveOnRelease = () => {
        if (volumeLeaderSaveTimer) {
            clearTimeout(volumeLeaderSaveTimer);
            volumeLeaderSaveTimer = null;
            if (state.isPrimarySyncLeader) savePlaybackState(true, true);
        }
    };
    el.volumeBar?.addEventListener('change', flushVolumeSaveOnRelease);
    document.getElementById('volume-popover-bar')?.addEventListener('change', flushVolumeSaveOnRelease);

    el.volumeBar?.addEventListener('input', (e) => {
        setAppVolume(Number(e.target.value) / 100, false);
    });

    el.volumeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            const popover = document.getElementById('volume-popover');
            const isOpen = popover?.classList.contains('active');
            setVolumePopoverOpen(!isOpen);
        } else {
            const currentlyMuted = state.userMuted || (el.audio ? el.audio.muted : false) || (state.userVolume === 0);
            if (currentlyMuted) {
                const targetVol = state.lastNonZeroVolume > 0 ? state.lastNonZeroVolume : 1;
                setAppVolume(targetVol, false);
            } else {
                state.lastNonZeroVolume = state.userVolume > 0 ? state.userVolume : 1;
                setAppVolume(state.lastNonZeroVolume, true);
            }
        }
    });

    document.getElementById('volume-popover-bar')?.addEventListener('input', (e) => {
        setAppVolume(Number(e.target.value) / 100, false);
    });

    document.getElementById('volume-popover-mute-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentlyMuted = state.userMuted || (el.audio ? el.audio.muted : false) || (state.userVolume === 0);
        if (currentlyMuted) {
            const targetVol = state.lastNonZeroVolume > 0 ? state.lastNonZeroVolume : 1;
            setAppVolume(targetVol, false);
        } else {
            state.lastNonZeroVolume = state.userVolume > 0 ? state.userVolume : 1;
            setAppVolume(state.lastNonZeroVolume, true);
        }
    });

    document.getElementById('volume-popover-close-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        setVolumePopoverOpen(false);
    });

    document.querySelectorAll('.volume-preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const volVal = parseInt(btn.getAttribute('data-vol'), 10);
            if (isNaN(volVal)) return;
            if (volVal === 0) {
                setAppVolume(state.lastNonZeroVolume || 1, true);
            } else {
                setAppVolume(volVal / 100, false);
            }
        });
    });

    document.addEventListener('click', (e) => {
        const popover = document.getElementById('volume-popover');
        if (popover && popover.classList.contains('active')) {
            if (!e.target.closest('#volume-popover') && !e.target.closest('#volume-btn')) {
                setVolumePopoverOpen(false);
            }
        }
    });

    setAppVolume(1, false, false);

    // ==========================================
    // PLAYBACK CONTROL
    // ==========================================
    function resumeCurrentSong(requestId = state.playbackRequestId) {
        if (!state.shouldBePlaying || requestId !== state.playbackRequestId || !el.audio.src) return;

        if (typeof resumeEqContext === 'function') resumeEqContext();
        el.audio.play().catch((error) => {
            if (!state.shouldBePlaying || requestId !== state.playbackRequestId) return;
            if (error?.name === 'NotAllowedError') {
                console.warn('Playback needs a user gesture', error);
                return;
            }
            if (state.playbackRetryCount >= 2) {
                console.warn('Playback could not resume', error);
                state.playbackRetryCount = 0;
                playNext(true);
                return;
            }

            state.playbackRetryCount += 1;
            const retry = () => resumeCurrentSong(requestId);
            el.audio.addEventListener('canplay', retry, { once: true });
        });
    }

    async function logPlay(songId, occurredAt = undefined) {
        if (!songId) return null;
        try {
            return await listeningSync.play(songId, occurredAt);
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    function releaseOfflineAudioUrl() {
        if (!state.offlineAudioUrl) return;
        URL.revokeObjectURL(state.offlineAudioUrl);
        state.offlineAudioUrl = null;
    }

    async function loadSongAudio(song, requestId) {
        const audioUrl = `/audio/${mediaUrlName(song.filename)}`;
        releaseOfflineAudioUrl();

        if (isOfflineMode()) {
            const cachedResponse = await caches.match(audioUrl, { ignoreSearch: true });
            if (await isUsableAudioResponse(cachedResponse)) {
                const offlineAudioUrl = URL.createObjectURL(await cachedResponse.blob());
                if (requestId !== state.playbackRequestId) {
                    URL.revokeObjectURL(offlineAudioUrl);
                    return;
                }
                releaseOfflineAudioUrl();
                state.offlineAudioUrl = offlineAudioUrl;
                el.audio.src = state.offlineAudioUrl;
                el.audio.load();
                resumeCurrentSong(requestId);
                return;
            }
            const mediaCacheName = window.OFFLINE_MEDIA_CACHE || 'psr354-media-v3';
            const cache = await caches.open(mediaCacheName);
            await cache.delete(audioUrl, { ignoreSearch: true });
            throw new Error('Offline audio is incomplete or corrupted');
        }

        el.audio.src = audioUrl;
        el.audio.load();
        resumeCurrentSong(requestId);
    }

    function playLibrarySong(song) {
        const previewSong = {
            ...song,
            id: Number(song.id),
            filename: song.filename,
            title: song.title,
            artist: song.artist || 'Unknown',
            album_art: song.album_art || '',
            duration_seconds: song.duration_seconds || 0,
        };

        flushListenLog();
        state.isPrimarySyncLeader = true;
        state.currentPlaylistSongs = [previewSong];
        state.currentSongIndex = 0;
        state.currentSongMeta = previewSong;
        state.currentPlayingSongId = String(previewSong.id);
        state.playbackStatisticsSongId = Object.hasOwn(song, 'in_my_library')
            ? song.owned_song_id : song.id;
        state.playEventLogged = false;
        state.pendingPlaySeconds = 0;
        state.playbackSessionId = null;
        state.playbackSessionPromise = null;

        updateMediaSession(previewSong);
        state.playbackRequestId += 1;
        state.playbackRetryCount = 0;
        state.shouldBePlaying = true;
        el.audio.src = `/api/library-songs/${previewSong.id}/stream`;
        el.audio.load();
        resumeCurrentSong(state.playbackRequestId);

        if (el.playerTitle) el.playerTitle.innerText = previewSong.title;
        if (el.playerArtist) el.playerArtist.innerText = previewSong.artist || 'Unknown';
        if (el.playerArt) {
            el.playerArt.src = albumArtUrl(previewSong.album_art);
            el.playerArt.alt = `${previewSong.title} album artwork`;
        }

        updatePlayPauseIcon(true);
        highlightPlayingSong();
        buildQueue();

        if (state.isLooping || state.loopStart > 0 || state.loopEnd > 0) {
            resetLoop();
        }
        savePlaybackState(true, true);
    }

    function playSong(songs, index) {
        flushListenLog();
        state.isPrimarySyncLeader = true;
        state.currentPlaylistSongs = songs;
        state.currentSongIndex = index;
        const song = songs[index];
        state.currentSongMeta = song;

        state.currentPlayingSongId = String(song.id);
        state.playbackStatisticsSongId = song.id;
        state.playEventLogged = false;
        state.pendingPlaySeconds = 0;
        state.playbackSessionId = null;
        state.playbackSessionPromise = null;

        updateMediaSession(song);
        state.playbackRequestId += 1;
        state.playbackRetryCount = 0;
        state.shouldBePlaying = true;
        loadSongAudio(song, state.playbackRequestId).catch((error) => {
            console.error('Offline audio could not be loaded:', error);
            showToast('This song is not available offline. Save the playlist again while online.', 'error');
            if (state.shouldBePlaying && state.currentPlayingSongId === String(song.id)) playNext(true);
        });

        if (el.playerTitle) el.playerTitle.innerText = song.title;
        if (el.playerArtist) el.playerArtist.innerText = song.artist || 'Unknown';
        if (el.playerArt) {
            el.playerArt.src = albumArtUrl(song.album_art);
            el.playerArt.alt = `${song.title} album artwork`;
        }

        updatePlayPauseIcon(true);
        highlightPlayingSong();
        buildQueue();
        loadLyrics(song.id);

        if (state.isLooping || state.loopStart > 0 || state.loopEnd > 0) {
            resetLoop();
        }
        savePlaybackState(true, true);
    }

    function togglePlay() {
        if (!el.audio.src) return;
        state.isPrimarySyncLeader = true;
        if (el.audio.paused) {
            state.shouldBePlaying = true;
            resumeCurrentSong();
            updatePlayPauseIcon(true);
        } else {
            state.shouldBePlaying = false;
            el.audio.pause();
            updatePlayPauseIcon(false);
        }
        savePlaybackState(true, true);
    }

    function playNext(isFromSongEnded = true) {
        if (!isFromSongEnded) {
            state.isPrimarySyncLeader = true;
        }
        try { if (el.audio) el.audio.playbackRate = 1.0; } catch (_) {}
        if (state.repeatMode === 2 && isFromSongEnded) {
            state.playbackRequestId += 1;
            state.playEventLogged = false;
            state.pendingPlaySeconds = 0;
            state.playbackSessionId = null;
            state.playbackSessionPromise = null;
            state.lastLoggedTime = 0;
            el.audio.currentTime = 0;
            state.shouldBePlaying = true;
            savePlaybackState(true);
            resumeCurrentSong();
            return;
        }

        if (state.currentSongMeta) {
            if (!state.playbackHistory) state.playbackHistory = [];
            state.playbackHistory.push(state.currentSongMeta);
            if (state.playbackHistory.length > 50) state.playbackHistory.shift();
        }

        if (state.playQueue.length > 0) {
            const nextSong = state.playQueue.shift();
            playQueuedSong(nextSong);
            return;
        }

        if (state.currentPlaylistSongs.length === 0) return;

        // Queue is empty: the whole playlist has played through once.
        if (state.isShuffle) {
            if (state.repeatMode === 0 && isFromSongEnded) {
                state.shouldBePlaying = false;
                el.audio.pause();
                updatePlayPauseIcon(false);
                return;
            }
            // Repeat All or manual Next click: start a fresh shuffle so the next loop has a new order.
            state.shuffleOrder = [];
            playSong(state.currentPlaylistSongs, Math.floor(Math.random() * state.currentPlaylistSongs.length));
            return;
        }

        let nextIndex = (state.currentSongIndex + 1) % state.currentPlaylistSongs.length;
        if (nextIndex === 0 && state.repeatMode === 0 && state.currentSongIndex === state.currentPlaylistSongs.length - 1) {
            state.shouldBePlaying = false;
            el.audio.pause();
            updatePlayPauseIcon(false);
            return;
        }

        playSong(state.currentPlaylistSongs, nextIndex);
    }

    function playPrev() {
        state.isPrimarySyncLeader = true;
        try { if (el.audio) el.audio.playbackRate = 1.0; } catch (_) {}
        if (!state.currentPlaylistSongs || state.currentPlaylistSongs.length === 0) return;
        if (el.audio && el.audio.currentTime > 3) {
            seekAudio(0);
            return;
        }

        if (state.isShuffle) {
            if (state.playbackHistory && state.playbackHistory.length > 0) {
                const prevSong = state.playbackHistory.pop();
                if (state.currentSongMeta) {
                    state.playQueue.unshift(state.currentSongMeta);
                }
                playQueuedSong(prevSong);
                return;
            }

            if (state.shuffleOrder && state.shuffleOrder.length > 0) {
                const currentId = String(state.currentPlayingSongId || state.currentSongMeta?.id || '');
                const pos = state.shuffleOrder.findIndex(s => String(s.id) === currentId);
                if (pos > 0) {
                    const prevSong = state.shuffleOrder[pos - 1];
                    if (state.currentSongMeta) {
                        state.playQueue.unshift(state.currentSongMeta);
                    }
                    playQueuedSong(prevSong);
                    return;
                }
                if (pos === 0) {
                    if (state.repeatMode === 1) {
                        const prevSong = state.shuffleOrder[state.shuffleOrder.length - 1];
                        if (state.currentSongMeta) {
                            state.playQueue.unshift(state.currentSongMeta);
                        }
                        playQueuedSong(prevSong);
                        return;
                    }
                    seekAudio(0);
                    return;
                }
            }

            seekAudio(0);
            return;
        }

        // Sequential (non-shuffle) mode
        if (state.playbackHistory && state.playbackHistory.length > 0) {
            const prevSong = state.playbackHistory.pop();
            if (state.currentSongMeta) {
                state.playQueue.unshift(state.currentSongMeta);
            }
            playQueuedSong(prevSong);
            return;
        }

        let prevIndex = state.currentSongIndex - 1;
        if (prevIndex < 0) {
            if (state.repeatMode === 1) {
                prevIndex = state.currentPlaylistSongs.length - 1;
            } else {
                seekAudio(0);
                return;
            }
        }
        playSong(state.currentPlaylistSongs, prevIndex);
    }

    return {
        cancelPlaybackRecovery,
        cancelTrackTransitionRecovery,
        scheduleTrackTransitionRecovery,
        schedulePlaybackRecovery,
        updateMediaSession,
        updateMediaSessionPosition,
        flushListenLog,
        seekAudio,
        setAppVolume,
        resumeCurrentSong,
        logPlay,
        releaseOfflineAudioUrl,
        loadSongAudio,
        playLibrarySong,
        playSong,
        togglePlay,
        playNext,
        playPrev,
    };
};
