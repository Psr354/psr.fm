// ==========================================
// GLOBAL FETCH INTERCEPTOR (SINGLE SOURCE)
// ==========================================
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    // CSRF Token injection untuk same-origin POST/PUT/DELETE/PATCH
    const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
    const csrfToken = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

    const requestMethod = options.method || (url instanceof Request ? url.method : 'GET');
    const headers = new Headers(options.headers || (url instanceof Request ? url.headers : undefined));
    let isSameOrigin = false;
    try {
        const resolvedUrl = new URL(url instanceof Request ? url.url : url, window.location.href);
        isSameOrigin = resolvedUrl.origin === window.location.origin;
    } catch (_) {
        isSameOrigin = false;
    }
    if (isSameOrigin && csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(requestMethod.toUpperCase())) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    const requestOptions = {...options, headers};

    try {
        const response = await _originalFetch.call(this, url, requestOptions);

        // Handle 401 Unauthorized (skip untuk auth endpoints & cross-origin)
        if (response.status === 401 && isSameOrigin) {
            const requestUrl = new URL(
                url instanceof Request ? url.url : url,
                window.location.href,
            );
            const path = requestUrl.pathname;
            if (path !== '/api/login' &&
                path !== '/api/setup' &&
                path !== '/api/users' &&
                !path.startsWith('/api/users/')) {
                window.location.href = '/login';
            }
        }

        return response;
    } catch (err) {
        console.error('Fetch error:', err);
        throw err;
    }
};

// ==========================================
// MAIN APPLICATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {

    // Unique device/session identifier for cross-device sync
    let CLIENT_DEVICE_ID = null;
    try {
        CLIENT_DEVICE_ID = sessionStorage.getItem('psr_device_id');
        if (!CLIENT_DEVICE_ID) {
            CLIENT_DEVICE_ID = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
            sessionStorage.setItem('psr_device_id', CLIENT_DEVICE_ID);
        }
    } catch (_) {
        CLIENT_DEVICE_ID = 'dev_' + Date.now();
    }

    // ==========================================
    // STATE MANAGEMENT (Single Source of Truth)
    // ==========================================
    const state = {
        deviceId: CLIENT_DEVICE_ID,
        capsulePeriod: 'month-current',
        capsuleData: null,
        capsuleShareFormat: 'story',
        capsuleShareTheme: 'emerald',
        capsuleShareCustomColors: ['#064e3b', '#10b981'],
        capsuleShareTagline: 'My Listening Journey',
        capsuleShareRenderPromise: null,
        playQueue: [],
        playbackHistory: [],
        currentPlaylistId: null,
        currentPlaylistSongs: [],
        currentSongIndex: -1,
        shuffleOrder: [],
        shuffleKey: null,
        isShuffle: false,
        repeatMode: 0, // 0=Off, 1=RepeatAll, 2=RepeatOne
        currentPlayingSongId: null,
        playbackStatisticsSongId: null,
        wasPlayingBeforeSeek: false,
        isSeeking: false,
        lastLoggedTime: 0,
        loopStart: 0,
        loopEnd: 0,
        isLooping: false,
        isRenaming: false,
        currentPlaylist: null,
        lyricsPanelOpen: false,
        lyricsFocusMode: false,
        lyricsAnimationMode: 'detail',
        syncedLyrics: [],
        wordSyncedLyrics: [],
        plainLyrics: '',
        rawSyncedLyrics: '',
        lyricsStatusValue: 'none',
        currentLyricsSongId: null,
        currentLyricIndex: -1,
        lyricsLoading: false,
        lyricsEditing: false,
        shareLyricsTheme: 'verde',
        shareLyricsCustomColors: ['#5b21b6', '#ec4899'],
        shareLyricsDecoration: 'circle',
        shareLyricsDecorationImage: null,
        shareLyricsDecorationImageUrl: null,
        shareDrawingActive: false,
        shareLyricsText: '',
        shareRenderPromise: null,
        currentSongMeta: null,
        lyricsRequestToken: 0,
        matchedLibrarySong: null,
        pendingLibrarySong: null,
        lastDownloadRequest: null,
        librarySongs: [],
        libraryPage: 1,
        libraryQuery: '',
        offlineMode: false,
        playbackRequestId: 0,
        playbackRetryCount: 0,
        playbackRecoveryTimer: null,
        playbackRecoveryInProgress: false,
        trackTransitionTimer: null,
        shouldBePlaying: false,
        playEventLogged: false,
        pendingPlaySeconds: 0,
        playbackSessionId: null,
        playbackSessionPromise: null,
        offlineAudioUrl: null,
        isPrimarySyncLeader: false,
        isApplyingRemoteSync: false,
        lastRemoteSyncAppliedAt: 0,
        isSyncSeeking: false,
        followerTrackEndTimer: null
    };
    const listeningSync = new window.PsrListeningSync(document.body.dataset.userId,
        message => showToast(message, 'error'), _originalFetch.bind(window));

    // ==========================================
    // DOM ELEMENT CACHING
    // ==========================================
    const el = {
        audio: document.getElementById('audio-player'),
        progressFill: document.getElementById('progress-fill'),
        volumeFill: document.getElementById('volume-fill'),
        progressBar: document.getElementById('progress-bar'),
        volumeBar: document.getElementById('volume-bar'),
        currentTime: document.getElementById('current-time'),
        duration: document.getElementById('duration'),
        volumeIcon: document.getElementById('volume-icon'),
        volumeBtn: document.getElementById('volume-btn'),
        volumePopover: document.getElementById('volume-popover'),
        volumePopoverBar: document.getElementById('volume-popover-bar'),
        volumePopoverFill: document.getElementById('volume-popover-fill'),
        volumePopoverPercent: document.getElementById('volume-popover-percent'),
        volumePopoverMuteBtn: document.getElementById('volume-popover-mute-btn'),
        volumePopoverCloseBtn: document.getElementById('volume-popover-close-btn'),
        nowPlaying: document.getElementById('now-playing-container'),
        playerTitle: document.getElementById('player-title'),
        playerArtist: document.getElementById('player-artist'),
        playerArt: document.getElementById('player-art'),
        playerLyric: document.getElementById('player-lyric'),
        playPauseBtn: document.getElementById('play-pause-btn'),
        toastContainer: document.getElementById('toast-container'),
        downloadWrapper: document.getElementById('download-progress-wrapper'),
        downloadBar: document.getElementById('download-progress-bar'),
        downloadLabel: document.getElementById('download-progress-label'),
        downloadRetryBtn: document.getElementById('download-retry-btn'),
        downloadCloseBtn: document.getElementById('download-close-btn'),
        loopIndicator: document.getElementById('loop-indicator'),
        loopBtn: document.getElementById('loop-btn'),
        loopPopover: document.getElementById('loop-popover'),
        loopStartInput: document.getElementById('loop-start-input'),
        loopEndInput: document.getElementById('loop-end-input'),
        loopStatus: document.getElementById('loop-status'),
        toggleLoopBtn: document.getElementById('toggle-loop-btn'),
        queueMode: document.getElementById('queue-mode'),
        queueList: document.getElementById('queue-list'),
        lyricsBtn: document.getElementById('lyrics-btn'),
        lyricsPanel: document.getElementById('lyrics-panel'),
        lyricsTitle: document.getElementById('lyrics-title'),
        lyricsSubtitle: document.getElementById('lyrics-subtitle'),
        lyricsStatus: document.getElementById('lyrics-status'),
        lyricsBody: document.getElementById('lyrics-body'),
        lyricsEditor: document.getElementById('lyrics-editor'),
        lyricsPlainInput: document.getElementById('lyrics-plain-input'),
        lyricsSyncedInput: document.getElementById('lyrics-synced-input'),
        lyricsCloseBtn: document.getElementById('lyrics-close-btn'),
        lyricsFocusBtn: document.getElementById('lyrics-focus-btn'),
        lyricsRetryBtn: document.getElementById('lyrics-retry-btn'),
        lyricsEditBtn: document.getElementById('lyrics-edit-btn'),
        lyricsShareBtn: document.getElementById('lyrics-share-btn'),
        lyricsAnimationBtn: document.getElementById('lyrics-animation-btn'),
        lyricsAnimationMenu: document.getElementById('lyrics-animation-menu'),
        lyricsCancelEditBtn: document.getElementById('lyrics-cancel-edit-btn'),
        lyricsSaveBtn: document.getElementById('lyrics-save-btn'),
        shareLyricsModal: document.getElementById('share-lyrics-modal'),
        shareLyricsCloseBtn: document.getElementById('share-lyrics-close-btn'),
        shareLyricsInput: document.getElementById('share-lyrics-input'),
        shareThemeStart: document.getElementById('share-theme-start'),
        shareThemeEnd: document.getElementById('share-theme-end'),
        shareThemeStartHex: document.getElementById('share-theme-start-hex'),
        shareThemeEndHex: document.getElementById('share-theme-end-hex'),
        shareDecorationUpload: document.getElementById('share-decoration-upload'),
        shareDrawingCanvas: document.getElementById('share-drawing-canvas'),
        shareDrawingColor: document.getElementById('share-drawing-color'),
        shareDrawingClear: document.getElementById('share-drawing-clear'),
        shareLyricsCanvas: document.getElementById('share-lyrics-canvas'),
        shareLyricsCopyBtn: document.getElementById('share-lyrics-copy-btn'),
        shareLyricsDownloadBtn: document.getElementById('share-lyrics-download-btn'),
        sidebar: document.querySelector('.sidebar'),
        mobileMenuBtn: document.getElementById('mobile-menu-btn'),
        capsuleView: document.getElementById('capsule-view'),
        capsuleBtn: document.getElementById('capsule-btn'),
        capsuleContent: document.getElementById('capsule-content'),
        capsulePeriodSelect: document.getElementById('capsule-period-select'),
        capsuleShareBtn: document.getElementById('capsule-share-btn'),
        shareCapsuleModal: document.getElementById('share-capsule-modal'),
        shareCapsuleCloseBtn: document.getElementById('share-capsule-close-btn'),
        shareCapsuleCanvas: document.getElementById('share-capsule-canvas'),
        shareCapsuleCopyBtn: document.getElementById('share-capsule-copy-btn'),
        shareCapsuleDownloadBtn: document.getElementById('share-capsule-download-btn'),
        shareCapsuleTagline: document.getElementById('share-capsule-tagline'),
        shareCapsuleStart: document.getElementById('share-capsule-start'),
        shareCapsuleEnd: document.getElementById('share-capsule-end'),
        shareCapsuleStartHex: document.getElementById('share-capsule-start-hex'),
        shareCapsuleEndHex: document.getElementById('share-capsule-end-hex'),
        views: {
            dashboard: document.getElementById('dashboard-view'),
            playlist: document.getElementById('playlist-view'),
            search: document.getElementById('search-view'),
            library: document.getElementById('library-view'),
            capsule: document.getElementById('capsule-view')
        },
        playlistCoverImg: document.getElementById('playlist-cover-img'),
        playlistTitle: document.getElementById('playlist-title'),
        playlistMeta: document.getElementById('playlist-meta'),
        usersView: document.getElementById('users-view'),
        usersBtn: document.getElementById('users-btn'),
        usersTableBody: document.getElementById('users-table-body'),
        addUserBtnMain: document.getElementById('add-user-btn-main'),
    };

    // Do not block startup on the external realtime client. Offline playback
    // must initialize immediately even when the CDN cannot be reached.
    const pendingSocketHandlers = [];
    let liveSocket = null;
    const socket = {
        on(eventName, handler) {
            pendingSocketHandlers.push([eventName, handler]);
            if (liveSocket) liveSocket.on(eventName, handler);
        }
    };
    window.socket = socket;
    window.state = state;
    window.el = el;
    window.showToast = showToast;
    window.escapeHtml = escapeHtml;
    window.formatTime = formatTime;
    window.mediaUrlName = mediaUrlName;
    window.albumArtUrl = albumArtUrl;
    window.showView = showView;
    window.drawRoundRect = drawRoundRect;
    window.loadCanvasImage = loadCanvasImage;
    window.drawRoundedImage = drawRoundedImage;
    window.drawCoverFallback = drawCoverFallback;
    window.drawStar = drawStar;
    window.fitCanvasText = fitCanvasText;
    window.wrapCanvasLines = wrapCanvasLines;
    window.debounce = debounce;
    window.formatBytes = (b) => formatBytes(b);
    window.seekAudio = (pos) => seekAudio(pos);
    window.openPlaylist = (p) => openPlaylist(p);
    window.loadDashboard = () => loadDashboard();
    window.loadLibrarySongs = () => loadLibrarySongs();
    window.loadPlaylists = () => loadPlaylists();
    socket.on('theme_sync', (remoteTheme) => {
        if (typeof window.handleThemeSync === 'function') {
            window.handleThemeSync(remoteTheme);
        }
    });

    function connectRealtime() {
        if (!navigator.onLine) return;
        // Jika sudah ada socket yang masih connected, tidak perlu buat baru.
        if (liveSocket && liveSocket.connected) return;
        // Jika ada socket yang disconnected/failed, hapus dulu agar bisa reconnect.
        if (liveSocket && !liveSocket.connected) {
            try { liveSocket.disconnect(); } catch (_) {}
            liveSocket = null;
        }
        const attach = () => {
            if (liveSocket || typeof window.io !== 'function') return;
            try {
                liveSocket = window.io({
                    reconnection: true,
                    reconnectionAttempts: Infinity,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 10000,
                    timeout: 10000,
                });
                pendingSocketHandlers.forEach(([eventName, handler]) => liveSocket.on(eventName, handler));
                liveSocket.on('disconnect', (reason) => {
                    // Jika disconnect bukan karena user logout/server kill,
                    // socket.io akan auto-reconnect. Tapi jika 'io server disconnect',
                    // kita perlu reconnect manual.
                    if (reason === 'io server disconnect') {
                        liveSocket.connect();
                    }
                });
                liveSocket.on('connect_error', () => {
                    // Jika error connect, biarkan auto-reconnect berjalan.
                    // Tidak reset liveSocket agar pendingHandlers tetap terdaftar.
                });
            } catch (err) {
                console.warn('Realtime connection failed:', err);
                liveSocket = null;
            }
        };
        if (typeof window.io === 'function') return attach();
        if (document.querySelector('script[data-realtime-client]')) return;
        const script = document.createElement('script');
        script.src = '/static/js/socket.io.min.js';
        script.async = true;
        script.dataset.realtimeClient = 'true';
        script.onload = attach;
        script.onerror = () => {
            script.remove();
            if (document.querySelector('script[data-realtime-client]')) return;
            const cdnScript = document.createElement('script');
            cdnScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.js';
            cdnScript.integrity = 'sha384-ijk2QwnixVP19l5ENflXHY2/BMo9ANUiTqH6MiVk6i7wp68I6wjNQFOcyayHgClg';
            cdnScript.crossOrigin = 'anonymous';
            cdnScript.async = true;
            cdnScript.dataset.realtimeClient = 'true';
            cdnScript.onload = attach;
            cdnScript.onerror = () => cdnScript.remove();
            document.head.appendChild(cdnScript);
        };
        document.head.appendChild(script);
    }

    // ==========================================
    // HELPER FUNCTIONS
    // ==========================================
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[char]);
    }

    function mediaUrlName(value) {
        const name = String(value || '').split('/').pop().split('\\').pop();
        return encodeURIComponent(name);
    }

    function albumArtUrl(value) {
        const cleaned = String(value || '').trim();
        if (!cleaned) return '/static/img/icon-192.png';
        return `/static/album_art/${mediaUrlName(cleaned)}`;
    }

    // CSP-safe centralized image fallback handler (replaces inline onerror attributes)
    document.addEventListener('error', (event) => {
        const target = event.target;
        if (!target || target.tagName !== 'IMG') return;
        const mode = target.dataset.fallback;
        if (!mode) return;
        delete target.dataset.fallback;
        if (mode === 'icon') {
            target.style.background = '#282828';
            target.src = '/static/img/icon-192.png';
        } else if (mode === 'blank') {
            target.style.background = '#282828';
            target.removeAttribute('src');
        } else if (mode === 'hide') {
            target.style.display = 'none';
            if (target.nextElementSibling) {
                target.nextElementSibling.style.display = 'flex';
            }
        }
    }, true);

    function formatTime(s) {
        if (!s || isNaN(s)) return '0:00';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return h > 0
            ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
            : `${m}:${sec.toString().padStart(2, '0')}`;
    }

    function parseTime(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return 0;
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function formatBytes(b) {
        if (!b || b === 0) return '0 Bytes';
        const i = Math.floor(Math.log(b) / Math.log(1024));
        return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + ' ' + ['Bytes', 'KB', 'MB', 'GB', 'TB'][i];
    }

    function triggerDownload(songId) {
        const a = document.createElement('a');
        a.href = `/api/songs/${songId}/download`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function triggerLibraryDownload(songId, title, artist) {
        const safe = (v) => String(v || '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Unknown';
        const a = document.createElement('a');
        a.href = `/api/library-songs/${songId}/download`;
        a.download = `${safe(title)} - ${safe(artist)}.mp3`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ==========================================
    // OFFLINE STORAGE & PWA CACHE (MODULARIZED)
    // ==========================================
    function isOfflineMode() {
        return window.isOfflineMode ? window.isOfflineMode() : (state.offlineMode || !navigator.onLine);
    }
    function setOfflineMode(enabled) {
        if (typeof window.setOfflineMode === 'function') window.setOfflineMode(enabled);
        else state.offlineMode = enabled;
    }
    const getOfflinePlaylists = () => (window.getOfflinePlaylists ? window.getOfflinePlaylists() : Promise.resolve([]));
    const getOfflinePlaylist = (id) => (window.getOfflinePlaylist ? window.getOfflinePlaylist(id) : Promise.resolve(null));
    const updateOfflineButton = () => (window.updateOfflineButton ? window.updateOfflineButton() : Promise.resolve());
    const saveOfflinePlaylist = (p) => (window.saveOfflinePlaylist ? window.saveOfflinePlaylist(p) : Promise.resolve());
    async function isUsableAudioResponse(response) {
        return window.isUsableAudioResponse ? window.isUsableAudioResponse(response) : true;
    }
    const hasCompleteOfflineAudio = (p) => (window.hasCompleteOfflineAudio ? window.hasCompleteOfflineAudio(p) : Promise.resolve(false));

    async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function debounce(f, w) {
        let t;
        return (...a) => {
            clearTimeout(t);
            t = setTimeout(() => f(...a), w);
        };
    }

    function getGreeting() {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good Morning';
        if (hour < 18) return 'Good Afternoon';
        return 'Good Evening';
    }

    function showToast(message, type = 'success') {
        if (!el.toastContainer) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icon = document.createElement('i');
        icon.className = `fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'} toast-icon`;
        const text = document.createElement('span');
        text.textContent = message;
        toast.append(icon, text);
        el.toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    }

    function renderEmptyState(container, options = {}) {
        if (!container) return;
        const icon = options.icon || 'fa-music';
        const title = options.title || 'No songs here yet';
        const body = options.body || 'Download audio into a playlist to start building this room.';
        const action = options.action
            ? `<button class="btn-primary compact-action empty-action" ${options.actionAttr || ''}>${options.action}</button>`
            : '';
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas ${icon}"></i></div>
                <h4>${escapeHtml(title)}</h4>
                <p>${escapeHtml(body)}</p>
                ${action}
            </div>
        `;
    }

    // ==========================================
    // LYRICS (MODULARIZED - FORWARDERS)
    // ==========================================
    const setLyricsStatus = (...args) => window.setLyricsStatus?.(...args);
    const setLyricsEditing = (...args) => window.setLyricsEditing?.(...args);
    const openLyricsPanel = (...args) => window.openLyricsPanel?.(...args);
    const closeLyricsPanel = (...args) => window.closeLyricsPanel?.(...args);
    const renderLyricWords = (...args) => (window.renderLyricWords ? window.renderLyricWords(...args) : '');
    const updatePlayerLyric = (...args) => window.updatePlayerLyric?.(...args);
    const resetPlayerLyric = (...args) => window.resetPlayerLyric?.(...args);

    function syncMobileViewport() {
        const viewport = window.visualViewport;
        const height = viewport?.height || window.innerHeight;
        const offsetTop = viewport?.offsetTop || 0;
        document.documentElement.style.setProperty('--mobile-viewport-height', `${height}px`);
        document.documentElement.style.setProperty('--mobile-viewport-offset', `${offsetTop}px`);
    }

    syncMobileViewport();
    window.addEventListener('resize', syncMobileViewport);
    window.visualViewport?.addEventListener('resize', syncMobileViewport);
    window.visualViewport?.addEventListener('scroll', syncMobileViewport);

    function setQueueOpen(isOpen) {
        const queuePopover = document.getElementById('queue-popover');
        const queueBtn = document.getElementById('queue-btn');
        if (isOpen) setVolumePopoverOpen(false);
        queuePopover?.classList.toggle('active', isOpen);
        queueBtn?.classList.toggle('active', isOpen);
    }

    function setVolumePopoverOpen(isOpen) {
        const popover = document.getElementById('volume-popover');
        if (!popover) return;
        if (isOpen) {
            if (el.loopPopover) el.loopPopover.classList.remove('active');
            setQueueOpen(false);
            const eqPopover = document.getElementById('eq-popover');
            if (eqPopover) {
                eqPopover.classList.remove('active');
                eqPopover.setAttribute('aria-hidden', 'true');
            }
        }
        popover.classList.toggle('active', isOpen);
        popover.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
        el.volumeBtn?.classList.toggle('active-popover', isOpen);
    }
    window.setVolumePopoverOpen = setVolumePopoverOpen;

    // ==========================================
    // LYRICS & SHARE LYRICS (MODULARIZED - FORWARDERS)
    // ==========================================
    const renderLyricsPanel = (...args) => window.renderLyricsPanel?.(...args);
    const stopLyricAnimation = (...args) => window.stopLyricAnimation?.(...args);
    const startLyricAnimation = (...args) => window.startLyricAnimation?.(...args);
    const updateSyncedLyrics = (...args) => window.updateSyncedLyrics?.(...args);
    const loadLyrics = (...args) => (window.loadLyrics ? window.loadLyrics(...args) : Promise.resolve());
    const saveManualLyrics = (...args) => (window.saveManualLyrics ? window.saveManualLyrics(...args) : Promise.resolve());
    const openShareLyricsModal = (...args) => (window.openShareLyricsModal ? window.openShareLyricsModal(...args) : Promise.resolve());
    const closeShareLyricsModal = (...args) => window.closeShareLyricsModal?.(...args);

    function drawRoundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function loadCanvasImage(src) {
        return new Promise((resolve) => {
            if (!src) return resolve(null);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function drawCoverFallback(ctx, x, y, size, radius = 18) {
        ctx.save();
        drawRoundRect(ctx, x, y, size, size, Math.min(radius, size / 3));
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.font = `700 ${Math.max(12, Math.round(size * 0.32))}px Space Grotesk, Manrope, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('psr', x + size / 2, y + size / 2);
        ctx.restore();
    }

    function drawRoundedImage(ctx, img, x, y, size, radius) {
        ctx.save();
        drawRoundRect(ctx, x, y, size, size, radius);
        ctx.clip();
        const sourceSize = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
        const sx = ((img.naturalWidth || img.width) - sourceSize) / 2;
        const sy = ((img.naturalHeight || img.height) - sourceSize) / 2;
        ctx.drawImage(img, sx, sy, sourceSize, sourceSize, x, y, size, size);
        ctx.restore();
    }

    function drawStar(ctx, cx, cy, outerRadius, innerRadius) {
        ctx.beginPath();
        for (let point = 0; point < 10; point += 1) {
            const angle = -Math.PI / 2 + point * Math.PI / 5;
            const radius = point % 2 ? innerRadius : outerRadius;
            const x = cx + Math.cos(angle) * radius;
            const y = cy + Math.sin(angle) * radius;
            point ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
    }

    function fitCanvasText(ctx, text, maxWidth) {
        const value = String(text || '');
        if (ctx.measureText(value).width <= maxWidth) return value;
        let trimmed = value;
        while (trimmed.length > 1 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
            trimmed = trimmed.slice(0, -1);
        }
        return `${trimmed.trim()}...`;
    }

    function wrapCanvasLines(ctx, text, maxWidth, maxLines = 2) {
        const words = String(text || '').trim().split(/\s+/);
        if (!words.length || !words[0]) return ['Unknown'];
        const lines = [];
        let currentLine = words[0];

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const testLine = `${currentLine} ${word}`;
            if (ctx.measureText(testLine).width <= maxWidth) {
                currentLine = testLine;
            } else {
                lines.push(currentLine);
                if (lines.length === maxLines - 1) {
                    const remaining = words.slice(i).join(' ');
                    lines.push(fitCanvasText(ctx, remaining, maxWidth));
                    return lines;
                }
                currentLine = word;
            }
        }
        if (currentLine && lines.length < maxLines) {
            lines.push(currentLine);
        }
        return lines;
    }

    function updateLoopIndicator() {
        if (!el.loopIndicator || !el.audio.duration) return;

        if (state.loopEnd > state.loopStart && state.loopEnd <= el.audio.duration) {
            const startPercent = (state.loopStart / el.audio.duration) * 100;
            const endPercent = (state.loopEnd / el.audio.duration) * 100;

            el.loopIndicator.style.left = `${startPercent}%`;
            el.loopIndicator.style.width = `${endPercent - startPercent}%`;
            el.loopIndicator.style.display = 'block';
            el.loopIndicator.style.opacity = state.isLooping ? '1' : '0.35';
        } else {
            el.loopIndicator.style.display = 'none';
        }
    }

    function resetLoop() {
        state.isLooping = false;
        state.loopStart = 0;
        state.loopEnd = 0;
        if (el.loopStartInput) el.loopStartInput.value = '0:00';
        if (el.loopEndInput) el.loopEndInput.value = '0:00';
        if (el.loopBtn) el.loopBtn.classList.remove('active');
        if (el.loopStatus) {
            el.loopStatus.innerText = 'Off';
            el.loopStatus.classList.remove('active');
        }
        if (el.toggleLoopBtn) el.toggleLoopBtn.innerHTML = '<i class="fas fa-play"></i> Start Loop';

        const jumpBtn = document.getElementById('jump-loop-btn');
        if (jumpBtn) jumpBtn.disabled = true;

        updateLoopIndicator();
    }

    function jumpToLoopStart() {
        if (!state.isLooping || state.loopStart < 0) return;

        seekAudio(state.loopStart);

        const jumpBtn = document.getElementById('jump-loop-btn');
        if (jumpBtn) {
            jumpBtn.style.transform = 'scale(0.9)';
            setTimeout(() => {
                jumpBtn.style.transform = '';
            }, 150);
        }

        if (el.audio.paused) {
            el.audio.play().catch(e => console.log("Play prevented", e));
        }

        state.lastLoggedTime = el.audio.currentTime;
        showToast('Jumped to loop start', 'success');
    }

    document.getElementById('jump-loop-btn')?.addEventListener('click', jumpToLoopStart);

    function updateVolumeIcon(vol) {
        const isMuted = el.audio ? (el.audio.muted || vol === 0) : (vol === 0);
        const iconClass = isMuted ? 'fas fa-volume-mute' : (vol < 0.5 ? 'fas fa-volume-down' : 'fas fa-volume-up');
        if (el.volumeIcon) el.volumeIcon.className = iconClass;
        el.volumeBtn?.classList.toggle('active', isMuted);
        el.volumeBtn?.setAttribute('aria-pressed', String(isMuted));
        el.volumeBtn?.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');

        const popoverTitleIcon = document.getElementById('volume-popover-title-icon');
        if (popoverTitleIcon) popoverTitleIcon.className = iconClass;
    }

    function updatePlayPauseIcon(isPlaying) {
        const icon = el.playPauseBtn?.querySelector('i');
        if (icon) icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
    }

    // ==========================================
    // USER INFO & AUTH
    // ==========================================
    async function loadUserInfo() {
        try {
            const res = await fetch('/api/me');
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            const data = await res.json();
            const userNameEl = document.getElementById('user-name');
            const userAvatarEl = document.getElementById('user-avatar');
            if (userNameEl) userNameEl.innerText = data.username;
            if (userAvatarEl) userAvatarEl.innerText = data.username.charAt(0).toUpperCase();

            // Show "User Management" nav item for admin only
            if (el.usersBtn) {
                el.usersBtn.style.display = data.can_add_users ? 'flex' : 'none';
            }
            // Hide old "Add User" button (moved to users-view)
            const oldAddUserBtn = document.getElementById('add-user-btn');
            if (oldAddUserBtn) oldAddUserBtn.style.display = 'none';
        } catch (err) {
            console.error('Failed to load user info', err);
        }
    }

    async function clearCachedAppShell() {
        try {
            navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_APP_SHELL' });
        } catch (_) {}
        if ('caches' in window) {
            try {
                const cacheKeys = await caches.keys();
                await Promise.all(
                    cacheKeys
                        .filter((key) => key.startsWith('psr354-shell-'))
                        .map((key) => caches.open(key).then((cache) => cache.delete('/?offline-app-shell=1')))
                );
            } catch (_) {}
        }
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to sign out?')) {
                try {
                    await fetch('/api/logout', { method: 'POST' });
                } finally {
                    await clearCachedAppShell();
                    window.location.href = '/login';
                }
            }
        });
    }

    const changePasswordBtn = document.getElementById('change-password-btn');
    const changePasswordModal = document.getElementById('change-password-modal');
    const currentPasswordInput = document.getElementById('current-password-input');
    const newPasswordInput = document.getElementById('new-password-input');
    const confirmNewPasswordInput = document.getElementById('confirm-new-password-input');
    const changePasswordError = document.getElementById('change-password-error');
    const changePasswordCancelBtn = document.getElementById('change-password-cancel-btn');
    const changePasswordSaveBtn = document.getElementById('change-password-save-btn');

    function closeChangePasswordModal() {
        if (changePasswordModal) changePasswordModal.style.display = 'none';
        if (currentPasswordInput) currentPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (confirmNewPasswordInput) confirmNewPasswordInput.value = '';
        if (changePasswordError) {
            changePasswordError.textContent = '';
            changePasswordError.style.display = 'none';
        }
    }

    if (changePasswordBtn && changePasswordModal) {
        changePasswordBtn.addEventListener('click', () => {
            if (window.innerWidth <= 768) setMobileMenu(false);
            closeChangePasswordModal();
            changePasswordModal.style.display = 'flex';
            currentPasswordInput?.focus();
        });
    }
    if (changePasswordCancelBtn) {
        changePasswordCancelBtn.addEventListener('click', closeChangePasswordModal);
    }
    if (changePasswordSaveBtn) {
        changePasswordSaveBtn.addEventListener('click', async () => {
            const currentPassword = currentPasswordInput?.value || '';
            const newPassword = newPasswordInput?.value || '';
            const confirmPassword = confirmNewPasswordInput?.value || '';
            const showFormError = (msg) => {
                if (changePasswordError) {
                    changePasswordError.textContent = msg;
                    changePasswordError.style.display = 'block';
                } else {
                    showToast(msg, 'error');
                }
            };

            if (!currentPassword || !newPassword) {
                showFormError('Current password and new password are required.');
                return;
            }
            if (newPassword.length < 6) {
                showFormError('New password must be at least 6 characters.');
                return;
            }
            if (newPassword !== confirmPassword) {
                showFormError('New password confirmation does not match.');
                return;
            }

            if (changePasswordError) changePasswordError.style.display = 'none';
            changePasswordSaveBtn.disabled = true;
            try {
                const response = await fetch('/api/user/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        current_password: currentPassword,
                        new_password: newPassword
                    })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    showFormError(result.error || 'Failed to update password.');
                    return;
                }
                closeChangePasswordModal();
                showToast(result.message || 'Password changed successfully', 'success');
            } catch (err) {
                showFormError(err.message || 'Network error while updating password.');
            } finally {
                changePasswordSaveBtn.disabled = false;
            }
        });
    }
    loadUserInfo();

    // ==========================================
    // USER MANAGEMENT: Extracted to static/js/user-mgmt.js
    // ==========================================
    // ==========================================
    // MODAL HANDLERS (Global)
    // ==========================================
    document.querySelectorAll('.modal').forEach(modalEl => {
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) modalEl.style.display = 'none';
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Close all modals
            document.querySelectorAll('.modal').forEach(modalEl => {
                modalEl.style.display = 'none';
            });

            // Close popovers
            if (el.loopPopover) el.loopPopover.classList.remove('active');
            setQueueOpen(false);
            setVolumePopoverOpen(false);

            // Close the lyrics side panel when it is open.
            if (state.lyricsPanelOpen) {
                closeLyricsPanel();
                el.lyricsBtn?.focus();
            }

            // Exit User Management view
            const usersViewActive = el.usersView?.classList.contains('active');
            if (usersViewActive) {
                showView('dashboard');
            }
        }
    });
    // ==========================================
    // MOBILE MENU
    // ==========================================
    let setMobileMenu = () => {};
    if (el.mobileMenuBtn && el.sidebar) {
        const sidebarScrim = document.getElementById('sidebar-scrim');
        setMobileMenu = (open) => {
            el.sidebar.classList.toggle('open', open);
            document.body.classList.toggle('mobile-nav-open', open);
            el.mobileMenuBtn.setAttribute('aria-expanded', String(open));
            el.mobileMenuBtn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
            const icon = el.mobileMenuBtn.querySelector('i');
            icon?.classList.toggle('fa-bars', !open);
            icon?.classList.toggle('fa-xmark', open);
        };
        el.mobileMenuBtn.addEventListener('click', () => setMobileMenu(!el.sidebar.classList.contains('open')));
        sidebarScrim?.addEventListener('click', () => setMobileMenu(false));
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && el.sidebar.classList.contains('open')) {
                setMobileMenu(false);
                el.mobileMenuBtn.focus();
            }
        });
        document.querySelectorAll('.nav-item:not(.nav-dropdown-toggle), .playlist-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768) setMobileMenu(false);
            });
        });
    }

    // ==========================================
    // NAVIGATION
    // ==========================================
    const musicToolsDropdown = document.getElementById('music-tools-dropdown');
    const musicToolsDropdownBtn = document.getElementById('music-tools-dropdown-btn');
    const musicToolsMenu = document.getElementById('music-tools-menu');
    const setMusicToolsDropdown = (open) => {
        if (!musicToolsDropdown || !musicToolsDropdownBtn || !musicToolsMenu) return;
        musicToolsDropdown.classList.toggle('open', open);
        musicToolsDropdownBtn.setAttribute('aria-expanded', String(open));
        musicToolsMenu.hidden = !open;
    };
    musicToolsDropdownBtn?.addEventListener('click', () => {
        setMusicToolsDropdown(!musicToolsDropdown.classList.contains('open'));
    });
    musicToolsDropdownBtn?.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setMusicToolsDropdown(true);
            musicToolsMenu?.querySelector('.nav-item')?.focus();
        } else if (event.key === 'Escape') {
            setMusicToolsDropdown(false);
        }
    });
    musicToolsMenu?.addEventListener('keydown', (event) => {
        const items = [...musicToolsMenu.querySelectorAll('.nav-item')];
        const index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            setMusicToolsDropdown(false);
            musicToolsDropdownBtn?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const nextIndex = event.key === 'ArrowDown'
                ? (index + 1) % items.length
                : (index - 1 + items.length) % items.length;
            items[nextIndex]?.focus();
        } else if (event.key === 'Home') {
            event.preventDefault();
            items[0]?.focus();
        } else if (event.key === 'End') {
            event.preventDefault();
            items[items.length - 1]?.focus();
        }
    });
    document.addEventListener('click', (event) => {
        if (musicToolsDropdown && !musicToolsDropdown.contains(event.target)) setMusicToolsDropdown(false);
    });
    document.getElementById('home-btn')?.addEventListener('click', () => showView('dashboard'));
    document.getElementById('search-btn')?.addEventListener('click', () => showView('search'));
    document.getElementById('library-btn')?.addEventListener('click', () => showView('library'));

    // ==========================================
    // DOWNLOAD & UPLOAD MODALS (MODULARIZED)
    // ==========================================
    const openDownloadModal = (...args) => window.openDownloadModal?.(...args);
    const openUploadModal = (...args) => window.openUploadModal?.(...args);

    // ==========================================
    // MODULAR FEATURE WIRING
    // ==========================================
    const app = {
        state,
        el,
        listeningSync,
        escapeHtml,
        mediaUrlName,
        albumArtUrl,
        formatTime,
        formatBytes,
        debounce,
        showToast,
        renderEmptyState,
        fetchWithTimeout,
        isOfflineMode,
        setOfflineMode,
        getOfflinePlaylists,
        getOfflinePlaylist,
        updateOfflineButton,
        saveOfflinePlaylist,
        isUsableAudioResponse,
        setQueueOpen,
        setVolumePopoverOpen,
        setMobileMenu,
        showView,
        openDownloadModal,
        triggerDownload,
        triggerLibraryDownload,
        updatePlayPauseIcon,
        updateVolumeIcon,
        updateLoopIndicator,
        resetLoop,
        applyMasterVolume,
        startLyricAnimation,
        stopLyricAnimation,
        updateSyncedLyrics,
        loadLyrics,
        connectRealtime,
    };

    const queueMod = window.createQueueModule(app);
    Object.assign(app, queueMod);
    const {
        buildQueue,
        openSongContextMenu,
        addSongLongPress,
        playQueuedSong,
    } = queueMod;

    const syncMod = window.createPlaybackSyncModule(app);
    Object.assign(app, syncMod);
    const {
        savePlaybackState,
        restorePlaybackState,
        handleRemotePlaybackSync,
    } = syncMod;

    const playlistViewMod = window.createPlaylistViewModule(app);
    Object.assign(app, playlistViewMod);
    const {
        loadLibrarySongs,
        loadPlaylists,
        openPlaylist,
        renderDashboardFallback,
        loadDashboard,
        highlightPlayingSong,
    } = playlistViewMod;

    const playerMod = window.createPlayerModule(app);
    Object.assign(app, playerMod);
    const {
        seekAudio,
        playLibrarySong,
        playSong,
        togglePlay,
        playNext,
        playPrev,
    } = playerMod;

    window.PsrApp = app;

    // ==========================================
    // VIEW MANAGEMENT
    // ==========================================
    function showView(viewName) {
        Object.values(el.views).forEach(v => v?.classList.remove('active'));
        if (el.usersView) el.usersView.classList.remove('active');

        if (el.views[viewName]) {
            el.views[viewName].classList.add('active');
        } else if (viewName === 'users' && el.usersView) {
            el.usersView.classList.add('active');
        }

        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.nav-item[aria-current]').forEach(btn => btn.removeAttribute('aria-current'));

        if (viewName === 'dashboard') {
            document.getElementById('home-btn')?.classList.add('active');
            loadDashboard();
        } else if (viewName === 'search') {
            document.getElementById('search-btn')?.classList.add('active');
            document.getElementById('search-input')?.focus();
        } else if (viewName === 'library') {
            setMusicToolsDropdown(true);
            document.getElementById('library-btn')?.classList.add('active');
            document.getElementById('library-btn')?.setAttribute('aria-current', 'page');
            document.getElementById('library-search-input')?.focus();
            loadLibrarySongs();
        } else if (viewName === 'users') {
            if (el.usersBtn) el.usersBtn.classList.add('active');
        } else if (viewName === 'capsule') {
            if (el.capsuleBtn) el.capsuleBtn.classList.add('active');
            if (typeof window.ensureCapsuleShareElements === 'function') {
                window.ensureCapsuleShareElements();
            }
            if (typeof window.loadFrequencyFocus === 'function') {
                window.loadFrequencyFocus(el.capsulePeriodSelect?.value || 'month-current');
            }
        }

        highlightPlayingSong();
    }

    // ==========================================
    // WEBSOCKET EVENTS
    // ==========================================
    let downloadHideTimer = null;
    let downloadStallTimer = null;

    function hideDownloadProgress(delay = 0) {
        if (downloadHideTimer) {
            clearTimeout(downloadHideTimer);
            downloadHideTimer = null;
        }
        if (downloadStallTimer) {
            clearTimeout(downloadStallTimer);
            downloadStallTimer = null;
        }
        const doHide = () => {
            if (el.downloadWrapper) el.downloadWrapper.classList.remove('active');
            if (el.downloadBar) el.downloadBar.style.width = '0%';
            if (el.downloadLabel) el.downloadLabel.innerText = '0%';
            if (el.downloadRetryBtn) el.downloadRetryBtn.hidden = true;
        };
        if (delay > 0) {
            downloadHideTimer = setTimeout(doHide, delay);
        } else {
            doHide();
        }
    }

    function resetDownloadStallTimer() {
        if (downloadStallTimer) clearTimeout(downloadStallTimer);
        downloadStallTimer = setTimeout(() => {
            if (el.downloadWrapper && el.downloadWrapper.classList.contains('active')) {
                hideDownloadProgress(0);
            }
        }, 15000);
    }

    function cancelDownloadHide() {
        if (downloadHideTimer) {
            clearTimeout(downloadHideTimer);
            downloadHideTimer = null;
        }
    }

    el.downloadCloseBtn?.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        hideDownloadProgress(0);
    });

    window.hideDownloadProgress = hideDownloadProgress;
    window.resetDownloadStallTimer = resetDownloadStallTimer;
    window.cancelDownloadHide = cancelDownloadHide;

    socket.on('download_progress', (data) => {
        cancelDownloadHide();
        resetDownloadStallTimer();
        if (el.downloadRetryBtn) el.downloadRetryBtn.hidden = true;
        if (el.downloadWrapper && el.downloadBar) {
            el.downloadWrapper.classList.add('active');
            el.downloadBar.style.width = `${data.percent}%`;
            if (el.downloadLabel) el.downloadLabel.innerText = `${Math.round(data.percent)}%`;
            if (data.percent >= 100) {
                hideDownloadProgress(1000);
            }
        }
    });

    socket.on('song_added', (song) => {
        hideDownloadProgress(1000);
        showToast(`Added: ${song.title}`, 'success');
        if (song.playlist_ids && song.playlist_ids.includes(state.currentPlaylistId)) {
            if (state.currentPlaylist) {
                openPlaylist(state.currentPlaylist);
            }
        }
        loadDashboard();
        loadPlaylists();
        loadLibrarySongs();
    });

    socket.on('download_error', (data) => {
        showToast(`Download failed: ${data.error || 'Unknown error'}`, 'error');
        if (el.downloadWrapper) el.downloadWrapper.classList.add('active');
        if (el.downloadRetryBtn && state.lastDownloadRequest) el.downloadRetryBtn.hidden = false;
        if (el.downloadLabel) el.downloadLabel.innerText = '0%';
        hideDownloadProgress(8000);
    });

    // ==========================================
    // CROSS-DEVICE PLAYBACK SYNC (Socket.IO)
    // ==========================================
    socket.on('playback_sync', (remoteState) => {
        handleRemotePlaybackSync(remoteState);
    });

    // ==========================================
    // PLAYLIST MODAL & COVER (MODULARIZED)
    // ==========================================

    // ==========================================
    // AUDIO CONTROLS
    // ==========================================
    document.getElementById('play-pause-btn')?.addEventListener('click', () => {
        state.isPrimarySyncLeader = true;
        togglePlay();
    });
    document.getElementById('prev-btn')?.addEventListener('click', () => {
        state.isPrimarySyncLeader = true;
        playPrev();
    });
    document.getElementById('next-btn')?.addEventListener('click', () => {
        state.isPrimarySyncLeader = true;
        playNext(false);
    });

    document.getElementById('shuffle-btn')?.addEventListener('click', () => {
        state.isPrimarySyncLeader = true;
        state.isShuffle = !state.isShuffle;
        document.getElementById('shuffle-btn')?.classList.toggle('active', state.isShuffle);
        if (state.isShuffle) {
            state.shuffleOrder = []; // Force a fresh shuffle order when turned on
        }
        buildQueue();
        savePlaybackState(true, true);
    });

    document.getElementById('queue-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const queuePopover = document.getElementById('queue-popover');
        setQueueOpen(!queuePopover?.classList.contains('active'));
    });

    document.addEventListener('click', (e) => {
        const queuePopover = document.getElementById('queue-popover');
        if (queuePopover && !e.target.closest('#queue-popover') && !e.target.closest('#queue-btn')) {
            setQueueOpen(false);
        }
    });

    document.getElementById('repeat-btn')?.addEventListener('click', () => {
        state.repeatMode = (state.repeatMode + 1) % 3;
        const btn = document.getElementById('repeat-btn');
        if (btn) {
            state.isPrimarySyncLeader = true;
            btn.classList.toggle('active', state.repeatMode > 0);
            btn.innerHTML = state.repeatMode === 2
                ? '<i class="fas fa-redo"></i><span class="repeat-one">1</span>'
                : '<i class="fas fa-redo"></i>';
            const label = state.repeatMode === 0 ? 'Repeat off' : state.repeatMode === 1 ? 'Repeat all' : 'Repeat one; each replay counts as a play';
            btn.setAttribute('aria-label', label);
            btn.title = label;
            showToast(label, 'success');
            savePlaybackState(true, true);
        }
    });

    // ==========================================
    // A-B LOOP FEATURE
    // ==========================================
    if (el.loopBtn && el.loopPopover) {
        let clickTimer = null;

        el.loopBtn.addEventListener('click', (e) => {
            e.stopPropagation();

            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;

                if (state.isLooping) {
                    jumpToLoopStart();
                    showToast('Jumped to loop start (double-click)', 'success');
                } else {
                    el.loopPopover.classList.toggle('active');
                }
            } else {
                clickTimer = setTimeout(() => {
                    el.loopPopover.classList.toggle('active');
                    clickTimer = null;
                }, 250);
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (el.loopPopover && !e.target.closest('#loop-popover') && !e.target.closest('#loop-btn')) {
            el.loopPopover.classList.remove('active');
        }
    });

    document.getElementById('set-loop-start-btn')?.addEventListener('click', () => {
        if (el.loopStartInput) {
            el.loopStartInput.value = formatTime(el.audio.currentTime);
            state.loopStart = el.audio.currentTime;
            updateLoopIndicator();
        }
    });

    document.getElementById('set-loop-end-btn')?.addEventListener('click', () => {
        if (el.loopEndInput) {
            el.loopEndInput.value = formatTime(el.audio.currentTime);
            state.loopEnd = el.audio.currentTime;
            updateLoopIndicator();
        }
    });

    el.loopStartInput?.addEventListener('change', () => {
        state.loopStart = parseTime(el.loopStartInput.value);
        updateLoopIndicator();
    });

    el.loopEndInput?.addEventListener('change', () => {
        state.loopEnd = parseTime(el.loopEndInput.value);
        updateLoopIndicator();
    });

    el.toggleLoopBtn?.addEventListener('click', () => {
        const jumpBtn = document.getElementById('jump-loop-btn');

        if (!state.isLooping) {
            if (state.loopEnd <= state.loopStart) {
                showToast('End time must be greater than start time', 'error');
                return;
            }
            state.isLooping = true;
            el.loopBtn?.classList.add('active');
            if (el.loopStatus) {
                el.loopStatus.innerText = 'Active';
                el.loopStatus.classList.add('active');
            }
            if (el.toggleLoopBtn) el.toggleLoopBtn.innerHTML = '<i class="fas fa-pause"></i> Stop';
            if (jumpBtn) jumpBtn.disabled = false;
            seekAudio(state.loopStart);
            updateLoopIndicator();
            showToast('A-B loop started; repeats do not add plays', 'success');
        } else {
            state.isLooping = false;
            el.loopBtn?.classList.remove('active');
            if (el.loopStatus) {
                el.loopStatus.innerText = 'Off';
                el.loopStatus.classList.remove('active');
            }
            if (el.toggleLoopBtn) el.toggleLoopBtn.innerHTML = '<i class="fas fa-play"></i> Start';
            if (jumpBtn) jumpBtn.disabled = true;
            updateLoopIndicator();
            showToast('Loop stopped', 'success');
        }
    });

    document.getElementById('clear-loop-btn')?.addEventListener('click', () => {
        resetLoop();
        showToast('Loop cleared', 'success');
    });

    // ==========================================
    // 16-BAND GRAPHIC EQUALIZER: Extracted to static/js/equalizer.js
    // ==========================================
    function applyMasterVolume(vol, isMuted) {
        if (window.applyMasterVolume) {
            window.applyMasterVolume(vol, isMuted);
        }
    }

    // ==========================================
    // KEYBOARD SHORTCUTS
    // ==========================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && el.shareLyricsModal?.style.display === 'flex') {
            closeShareLyricsModal();
            return;
        }
        const target = e.target;
        const tag = target?.tagName || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
        if (e.code === 'Space' || e.keyCode === 32) {
            if (target?.closest?.('button, a')) return;
            e.preventDefault();
            state.isPrimarySyncLeader = true;
            togglePlay();
        }
        if (e.code === 'ArrowRight') {
            state.isPrimarySyncLeader = true;
            playNext(false);
        }
        if (e.code === 'ArrowLeft') {
            state.isPrimarySyncLeader = true;
            playPrev();
        }
        if (e.key === 'l' || e.key === 'L') {
            if (state.isLooping) {
                jumpToLoopStart();
            }
        }
    });

    // ==========================================
    // PLAYBACK SYNC, PLAYER, PLAYLIST & DASHBOARD VIEWS:
    // Extracted to static/js/playback-sync.js, static/js/player.js,
    // static/js/playlist-view.js, and static/js/queue.js
    // ==========================================

    // ==========================================
    // FREQUENCY FOCUS & SHARE CARD: Extracted to static/js/recap.js
    // ==========================================
    // ==========================================
    // INITIALIZATION
    // ==========================================
    const dashboardTitle = document.querySelector('#dashboard-view .page-heading h2');
    if (dashboardTitle) dashboardTitle.innerText = getGreeting();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js').then(async (registration) => {
            const warmAppShell = () => {
                const worker = registration.active || navigator.serviceWorker.controller;
                worker?.postMessage({ type: 'CACHE_APP_SHELL' });
            };
            navigator.serviceWorker.addEventListener('controllerchange', warmAppShell, { once: true });
            await navigator.serviceWorker.ready;
            warmAppShell();
        }).catch((error) => console.warn('Offline support could not be registered:', error));
    }

    connectRealtime();

    window.addEventListener('offline', () => {
        setOfflineMode(true);
        getOfflinePlaylists().then((offlinePlaylists) => {
            loadPlaylists();
            if (offlinePlaylists.length) openPlaylist(offlinePlaylists[0]);
            else showToast('You are offline and no playlist is saved on this device.', 'error');
        }).catch((error) => console.error('Could not switch to offline mode:', error));
    });

    window.addEventListener('online', () => {
        setOfflineMode(false);
        connectRealtime();
        navigator.serviceWorker?.controller?.postMessage({ type: 'CACHE_APP_SHELL' });
    });

    if (navigator.onLine) {
        loadPlaylists().then((playlists) => {
            if (state.offlineMode && playlists.length) openPlaylist(playlists[0]);
        });
        loadDashboard();
    } else {
        renderDashboardFallback('No offline playlists have been saved on this device yet. Connect to the server, open a playlist, and use Save Offline first.');
        loadPlaylists().then(async () => {
            const offlinePlaylists = await getOfflinePlaylists();
            if (offlinePlaylists.length) openPlaylist(offlinePlaylists[0]);
            else showToast('No playlists have been saved for offline listening yet.', 'error');
        }).catch((error) => console.error('Could not load offline playlists:', error));
    }
    renderEmptyState(document.getElementById('search-results'), {
        icon: 'fa-search',
        title: 'Search your library',
        body: 'Type at least two characters to find a song or artist in this account.'
    });
    restorePlaybackState();

    // Theme Customization Engine is initialized by static/js/theme.js
});
