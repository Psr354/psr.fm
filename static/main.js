// ==========================================
// GLOBAL FETCH INTERCEPTOR (SINGLE SOURCE)
// ==========================================
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    // CSRF Token injection untuk POST/PUT/DELETE
    const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
    const csrfToken = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

    const requestMethod = options.method || (url instanceof Request ? url.method : 'GET');
    const headers = new Headers(options.headers || (url instanceof Request ? url.headers : undefined));
    if (csrfToken && ['POST', 'PUT', 'DELETE'].includes(requestMethod.toUpperCase())) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    const requestOptions = {...options, headers};

    try {
        const response = await _originalFetch.call(this, url, requestOptions);

        // Handle 401 Unauthorized (skip untuk auth endpoints)
        if (response.status === 401) {
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
        playbackSessionId: null,
        playbackSessionPromise: null,
        offlineAudioUrl: null
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
        if (liveSocket || !navigator.onLine) return;
        const attach = () => {
            if (liveSocket || typeof window.io !== 'function') return;
            liveSocket = window.io();
            pendingSocketHandlers.forEach(([eventName, handler]) => liveSocket.on(eventName, handler));
        };
        if (typeof window.io === 'function') return attach();
        if (document.querySelector('script[data-realtime-client]')) return;
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.js';
        script.async = true;
        script.dataset.realtimeClient = 'true';
        script.onload = attach;
        script.onerror = () => script.remove();
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

    function parseLRC(lrc) {
        if (!lrc) return [];
        const timestampPattern = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
        const lines = [];
        String(lrc).split(/\r?\n/).forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line) return;
            const matches = [...line.matchAll(timestampPattern)];
            if (!matches.length) return;
            const lastMatch = matches[matches.length - 1];
            const text = line.slice(lastMatch.index + lastMatch[0].length).trim();
            matches.forEach((match) => {
                const minutes = parseInt(match[1], 10);
                const seconds = parseInt(match[2], 10);
                const fraction = (match[3] || '0').padEnd(3, '0').slice(0, 3);
                lines.push({
                    timestamp: minutes * 60 + seconds + parseInt(fraction, 10) / 1000,
                    text
                });
            });
        });
        return lines
            .sort((a, b) => a.timestamp - b.timestamp);
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
        if (typeof window.ensureCapsuleShareElements === 'function') {
            window.ensureCapsuleShareElements();
        }
        if (el.capsuleContent && typeof window.openShareCapsuleModal === 'function') {
            const heroShareBtn = el.capsuleContent.querySelector('.capsule-hero-share-btn');
            if (heroShareBtn) {
                heroShareBtn.onclick = window.openShareCapsuleModal;
            }
        }
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

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to sign out?')) {
                await fetch('/api/logout', { method: 'POST' });
                window.location.href = '/login';
            }
        });
    }
    loadUserInfo();

    // ==========================================
    // USER MANAGEMENT: Extracted to static/user-mgmt.js
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
    // QUEUE MANAGEMENT
    // ==========================================
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
            const currentSong = state.currentPlaylistSongs[state.currentSongIndex];
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" alt="" loading="lazy" onerror="this.onerror=null; this.style.background='#282828'; this.src='/static/icon-192.png';">
                <div class="q-info">
                    <div class="q-title">${escapeHtml(song.title)}</div>
                    <div class="q-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                <button class="queue-remove-btn" type="button" aria-label="Remove ${escapeHtml(song.title)}" title="Remove"><i class="fas fa-xmark"></i></button>
            `;
            div.addEventListener('click', () => {
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
    socket.on('download_progress', (data) => {
        if (el.downloadRetryBtn) el.downloadRetryBtn.hidden = true;
        if (el.downloadWrapper && el.downloadBar) {
            el.downloadWrapper.classList.add('active');
            el.downloadBar.style.width = `${data.percent}%`;
            if (el.downloadLabel) el.downloadLabel.innerText = `${Math.round(data.percent)}%`;
            if (data.percent >= 100) {
                setTimeout(() => {
                    el.downloadWrapper.classList.remove('active');
                    el.downloadBar.style.width = '0%';
                    if (el.downloadLabel) el.downloadLabel.innerText = '0%';
                }, 1000);
            }
        }
    });

    socket.on('song_added', (song) => {
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
    });

    // ==========================================
    // CROSS-DEVICE PLAYBACK SYNC (Socket.IO)
    // ==========================================
    socket.on('playback_sync', (remoteState) => {
        if (!remoteState || !remoteState.songMeta) return;
        if (remoteState.deviceId && remoteState.deviceId === CLIENT_DEVICE_ID) {
            return;
        }
        applySavedPlaybackState(remoteState, remoteState.isPlaying, true);
        try {
            localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(remoteState));
        } catch (_) {}
    });

    // ==========================================
    // PLAYLIST MODAL & COVER (MODULARIZED)
    // ==========================================

    // ==========================================
    // AUDIO CONTROLS
    // ==========================================
    document.getElementById('play-pause-btn')?.addEventListener('click', () => {
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        togglePlay();
    });
    document.getElementById('prev-btn')?.addEventListener('click', () => {
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        playPrev();
    });
    document.getElementById('next-btn')?.addEventListener('click', () => {
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        playNext(false);
    });

    document.getElementById('shuffle-btn')?.addEventListener('click', () => {
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
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
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
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
    // 16-BAND GRAPHIC EQUALIZER: Extracted to static/equalizer.js
    // ==========================================
    function applyMasterVolume(vol, isMuted) {
        if (window.applyMasterVolume) {
            window.applyMasterVolume(vol, isMuted);
        }
    }

    function initAudioGraph() {
        if (window.initAudioGraph) {
            window.initAudioGraph();
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
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.code === 'Space' || e.keyCode === 32) {
            e.preventDefault();
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            togglePlay();
        }
        if (e.code === 'ArrowRight') {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            playNext(false);
        }
        if (e.code === 'ArrowLeft') {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            playPrev();
        }
        if (e.key === 'l' || e.key === 'L') {
            if (state.isLooping) {
                jumpToLoopStart();
            }
        }
    });
        // ==========================================
    // PLAYBACK PERSISTENCE & CROSS-DEVICE SYNC (JAM / MULTI-ROOM)
    // ==========================================
    const PLAYBACK_STATE_KEY = 'psr_playback_state';
    let lastSavePlaybackTime = 0;
    let cachedPlaybackPayload = null;
    let lastServerSyncTime = 0;
    let serverSyncTimer = null;
    let isPrimarySyncLeader = false;
    let isApplyingRemoteSync = false;
    let lastRemoteSyncAppliedAt = 0;
    let remoteSyncTimeout = null;
    let isSyncSeeking = false;
    let followerTrackEndTimer = null;
    let syncPromptActive = false;

    function showSyncAutoplayPrompt(targetTime) {
        if (syncPromptActive) return;
        syncPromptActive = true;
        if (typeof showToast === 'function') {
            showToast('Sedang diputar di perangkat lain. Ketuk layar untuk ikut mendengarkan barengan.', 'info', 7000);
        }

        const unlockAudio = () => {
            syncPromptActive = false;
            if (state.shouldBePlaying && el.audio) {
                try {
                    if (typeof targetTime === 'number' && targetTime > 0) {
                        isSyncSeeking = true;
                        el.audio.currentTime = targetTime;
                    }
                    if (typeof resumeEqContext === 'function') resumeEqContext();
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
        if (!isPrimarySyncLeader) {
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
                    if (isPrimarySyncLeader && cachedPlaybackPayload) {
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

            // Recompute the heavy metadata payload only when track/playlist actually changes
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

            // Do not bounce remote sync events back to server (prevents feedback loops)
            if (isApplyingRemoteSync || (now - lastRemoteSyncAppliedAt < 2500)) {
                return;
            }

            // Only the active leader sends throttled background progress;
            // Explicit user actions (isUserAction === true) always sync immediately.
            if (isPrimarySyncLeader || isUserAction) {
                syncPlaybackToServer(cachedPlaybackPayload, force);
            }
        } catch (_) {}
    }

    function applySavedPlaybackState(saved, startPlaying = false, isRemoteSync = false) {
        if (!saved || !saved.songMeta) return;

        if (followerTrackEndTimer) {
            clearTimeout(followerTrackEndTimer);
            followerTrackEndTimer = null;
        }

        if (isRemoteSync) {
            isApplyingRemoteSync = true;
            lastRemoteSyncAppliedAt = Date.now();
            isPrimarySyncLeader = false;
            if (remoteSyncTimeout) clearTimeout(remoteSyncTimeout);
            remoteSyncTimeout = setTimeout(() => {
                isApplyingRemoteSync = false;
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

        // Update State
        state.currentPlaylistId = saved.playlistId || null;
        state.currentPlaylistSongs = Array.isArray(saved.playlistSongs) && saved.playlistSongs.length ? saved.playlistSongs : [saved.songMeta];
        state.currentSongIndex = typeof saved.songIndex === 'number' ? saved.songIndex : 0;
        state.currentSongMeta = saved.songMeta;
        state.currentPlayingSongId = targetSongId;
        state.playbackStatisticsSongId = saved.songMeta.id;
        state.repeatMode = typeof saved.repeatMode === 'number' ? saved.repeatMode : 0;
        state.isShuffle = Boolean(saved.isShuffle);

        // Update UI
        if (el.playerTitle) el.playerTitle.innerText = saved.songMeta.title || '';
        if (el.playerArtist) el.playerArtist.innerText = saved.songMeta.artist || 'Unknown';
        if (el.playerArt) {
            el.playerArt.src = '/static/album_art/' + mediaUrlName(saved.songMeta.album_art);
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
        if (typeof highlightPlayingSong === 'function') {
            highlightPlayingSong();
        }

        const audioSrc = saved.songMeta.filename
            ? '/audio/' + mediaUrlName(saved.songMeta.filename)
            : '/api/library-songs/' + saved.songMeta.id + '/stream';

        const currentSrc = el.audio ? (el.audio.getAttribute('src') || el.audio.src || '') : '';
        const targetFilename = mediaUrlName(saved.songMeta.filename || '');
        const isDifferentSrc = !currentSrc || (targetFilename && !currentSrc.includes(encodeURI(targetFilename)));

        const triggerPlayback = () => {
            if (shouldPlay) {
                state.shouldBePlaying = true;
                updatePlayPauseIcon(true);
                if (typeof resumeEqContext === 'function') resumeEqContext();
                const p = el.audio.play();
                if (p !== undefined) {
                    p.catch((err) => {
                        if (err?.name === 'NotAllowedError') {
                            showSyncAutoplayPrompt(targetTime);
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
            if (isDifferentSrc || !isSameSong) {
                el.audio.src = audioSrc;
                const onLoaded = () => {
                    isSyncSeeking = true;
                    try { el.audio.currentTime = targetTime; } catch (_) {}
                    updateSyncedLyrics(true);
                    triggerPlayback();
                };
                el.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
            } else {
                // Same song: check drift
                const drift = Math.abs((el.audio.currentTime || 0) - targetTime);
                if (drift > 1.8) {
                    isSyncSeeking = true;
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

            // Don't overwrite if audio is currently playing locally
            if (el.audio && !el.audio.paused) return;

            const localRaw = localStorage.getItem(PLAYBACK_STATE_KEY);
            let localTime = 0;
            if (localRaw) {
                try { localTime = JSON.parse(localRaw).timestamp || 0; } catch (_) {}
            }

            if ((serverState.timestamp || 0) >= localTime) {
                const now = Date.now();
                const isActivelyPlaying = Boolean(serverState.isPlaying && (now - (serverState.timestamp || 0) < 20000));
                applySavedPlaybackState(serverState, isActivelyPlaying, isActivelyPlaying);
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
        if (typeof resumeEqContext === 'function') resumeEqContext();
        if (el.audio.paused) resumeCurrentSong();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            flushListenLog();
            if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
                savePlaybackState(true);
            }
        } else {
            cancelPlaybackRecovery();
            cancelTrackTransitionRecovery();
            state.playbackRecoveryInProgress = false;
            highlightPlayingSong();
            resumePlaybackAfterBackground();
            if (typeof isPrimarySyncLeader !== 'undefined' && !isPrimarySyncLeader) {
                updateSyncedLyrics(true);
            }
        }
    });
    window.addEventListener('pageshow', () => {
        cancelPlaybackRecovery();
        cancelTrackTransitionRecovery();
        state.playbackRecoveryInProgress = false;
        resumePlaybackAfterBackground();
        if (typeof isPrimarySyncLeader !== 'undefined' && !isPrimarySyncLeader) {
            updateSyncedLyrics(true);
        }
    });
    window.addEventListener('pagehide', () => {
        flushListenLog();
        if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
            savePlaybackState(true);
        }
    });
    window.addEventListener('beforeunload', () => {
        if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
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
                if (delta >= 5) {
                    logListenDuration(state.currentPlayingSongId, delta);
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
        if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
            savePlaybackState(true);
        }
    });

    el.audio.addEventListener('playing', () => {
        if (typeof resumeEqContext === 'function') resumeEqContext();
        if (state.currentPlayingSongId && !state.playEventLogged) {
            state.playEventLogged = true;
            state.playbackSessionId = null;
            const songId = state.currentPlayingSongId;
            const playbackRequestId = state.playbackRequestId;
            state.playbackSessionPromise = state.playbackStatisticsSongId
                ? logPlay(state.playbackStatisticsSongId) : Promise.resolve(null);
            state.playbackSessionPromise.then((sessionId) => {
                if (
                    String(state.currentPlayingSongId) === String(songId)
                    && state.playbackRequestId === playbackRequestId
                ) {
                    state.playbackSessionId = sessionId;
                }
            });
        }
    });

    el.audio.addEventListener('pause', () => {
        if (el.nowPlaying) el.nowPlaying.classList.remove('playing');
        stopLyricAnimation();
        flushListenLog();
        if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
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
        if (typeof isSyncSeeking !== 'undefined' && isSyncSeeking) {
            isSyncSeeking = false;
            return;
        }
        if (typeof isPrimarySyncLeader !== 'undefined' && isPrimarySyncLeader && !(typeof isApplyingRemoteSync !== 'undefined' && isApplyingRemoteSync)) {
            savePlaybackState(true, true);
        }
    });

    el.audio.addEventListener('ended', () => {
        cancelPlaybackRecovery();
        stopLyricAnimation();
        flushListenLog();
        const isLeader = typeof isPrimarySyncLeader !== 'undefined' ? isPrimarySyncLeader : true;
        if (isLeader) {
            playNext(true);
            scheduleTrackTransitionRecovery();
        } else {
            if (typeof followerTrackEndTimer !== 'undefined' && followerTrackEndTimer) {
                clearTimeout(followerTrackEndTimer);
                followerTrackEndTimer = null;
            }
            if (typeof followerTrackEndTimer !== 'undefined') {
                followerTrackEndTimer = setTimeout(() => {
                    followerTrackEndTimer = null;
                    if (el.audio && el.audio.ended) {
                        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
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

            // Do not perform destructive source reload while in background tab
            if (document.hidden) return;

            // A stalled media element can remain "playing" while its position
            // stops advancing in a background tab. Reload the same source and
            // restore its position instead of calling play() on a stuck element.
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

    // Mobile browsers can briefly fail a source transition while the screen is
    // locked. Retry the same track after it becomes playable instead of leaving
    // the player stopped until the page is opened again.
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

    // Media Session API: keeps background/locked-screen playback alive so tracks
    // auto-advance when the tab is not focused, and wires OS media controls.
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            playPrev();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            playNext(false);
        });
        navigator.mediaSession.setActionHandler('play', () => {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            state.shouldBePlaying = true;
            resumeCurrentSong();
            updatePlayPauseIcon(true);
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
            state.shouldBePlaying = false;
            el.audio.pause();
            updatePlayPauseIcon(false);
        });
        navigator.mediaSession.setActionHandler('seekto', ({ seekTime }) => {
            if (Number.isFinite(seekTime)) {
                if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
                seekAudio(seekTime);
            }
        });
    }

    function updateMediaSession(song) {
        if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
        const artworkUrl = new URL(`/static/album_art/${mediaUrlName(song.album_art)}`, window.location.origin).href;
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
        } catch (_) {
            // Some browsers expose Media Session but do not support position state.
        }
    }

    function flushListenLog() {
        if (state.currentPlayingSongId) {
            const delta = el.audio.currentTime - state.lastLoggedTime;
            if (delta > 0 && !el.audio.seeking && !state.isSeeking) {
                logListenDuration(state.currentPlayingSongId, delta);
            }
            state.lastLoggedTime = el.audio.currentTime;
        }
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
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        flushListenLog();
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
        } catch (_) {
            // Some mobile range controls manage pointer capture natively.
        }
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
        } catch (_) {
            // The browser may already have released capture after a touch ends.
        }
        state.isSeeking = false;
        if (state.wasPlayingBeforeSeek) el.audio.play().catch(() => {});
    };
    el.progressBar?.addEventListener('pointerup', finishSeek);
    el.progressBar?.addEventListener('pointercancel', finishSeek);

    state.lastNonZeroVolume = 1;
    state.userVolume = 1;
    state.userMuted = false;

    function setAppVolume(vol, isMuted = false, shouldSave = true) {
        if (shouldSave && !isApplyingRemoteSync) {
            if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        }
        const normalized = Math.max(0, Math.min(1, Number(vol)));
        if (!isMuted && normalized > 0) {
            state.lastNonZeroVolume = normalized;
        }
        state.userVolume = normalized;
        state.userMuted = Boolean(isMuted);

        const effective = isMuted ? 0 : normalized;

        if (window.applyMasterVolume && window.isEqPipelineActive?.()) {
            // Web Audio pipeline is active: masterGainNode controls volume attenuation.
            // Keep native audio element unattenuated to prevent double attenuation in Chromium/Firefox.
            try { el.audio.volume = 1; } catch {}
            try { el.audio.muted = Boolean(isMuted); } catch {}
            applyMasterVolume(effective, isMuted);
        } else {
            // Fallback before Web Audio is connected or if unsupported
            if (el.audio) {
                try { el.audio.volume = effective; } catch {}
                try { el.audio.muted = Boolean(isMuted); } catch {}
            }
        }

        // Update desktop volume slider
        const percent = Math.round(effective * 100);
        if (el.volumeBar) el.volumeBar.value = String(percent);
        if (el.volumeFill) el.volumeFill.style.width = `${percent}%`;

        // Update mobile popover controls
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

        // Update volume preset buttons active state
        document.querySelectorAll('.volume-preset-btn').forEach(btn => {
            const btnVal = parseInt(btn.getAttribute('data-vol'), 10);
            btn.classList.toggle('active', !isMuted && btnVal === percent);
        });

        updateVolumeIcon(effective);
        if (shouldSave && isPrimarySyncLeader) savePlaybackState(true, true);
    }
    window.setAppVolume = setAppVolume;

    el.volumeBar?.addEventListener('input', (e) => {
        setAppVolume(Number(e.target.value) / 100, false);
    });

    el.volumeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            const popover = document.getElementById('volume-popover');
            const isOpen = popover?.classList.contains('active');
            setVolumePopoverOpen(!isOpen);
        } else {
            // Desktop: toggle mute inline
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

    // Mobile Volume Popover Event Listeners
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

    // Initialize UI volume state
    setAppVolume(1, false, false);

    // ==========================================
    // SEARCH
    // ==========================================
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.onerror=null; this.style.background='#282828'; this.src='/static/icon-192.png';">
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

    // ==========================================
    // ADD SONGS TO PLAYLIST (MODULARIZED)
    // ==========================================
    const openAddSongsModal = (...args) => window.openAddSongsModal?.(...args);
    const closeAddSongsModal = (...args) => window.closeAddSongsModal?.(...args);
    document.getElementById('save-playlist-offline-btn')?.addEventListener('click', () => {
        if (state.currentPlaylist) saveOfflinePlaylist(state.currentPlaylist);
    });

    // ==========================================
    // PLAYLISTS
    // ==========================================
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
        loadPlaylists();

        const deleteBtn = document.getElementById('delete-playlist-btn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                if (confirm(`Delete playlist "${playlist.name}"? Songs not used by another playlist will also be deleted permanently.`)) {
                    const response = await fetch(`/api/playlists/${playlist.id}`, {method: 'DELETE'});
                    if (!response.ok) {
                        const data = await response.json().catch(() => ({}));
                        throw new Error(data.error || 'Failed to delete playlist');
                    }
                    state.currentPlaylistId = null;
                    loadPlaylists();
                    showView('dashboard');
                    showToast('Playlist deleted');
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

    // ==========================================
    // DASHBOARD
    // ==========================================
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
            const statsResponse = await fetchWithTimeout('/api/dashboard');
            if (!statsResponse.ok) throw new Error('Dashboard request failed');
            const stats = await statsResponse.json();
            const statsGrid = document.getElementById('stats-grid');
            if (statsGrid) {
                statsGrid.innerHTML = `
                    <div class="stat-card stat-playlists"><div class="stat-icon"><i class="fas fa-list"></i></div><div><h4>${stats.total_playlists}</h4><p>Playlists</p></div></div>
                    <div class="stat-card stat-songs"><div class="stat-icon"><i class="fas fa-music"></i></div><div><h4>${stats.total_songs}</h4><p>Songs</p></div></div>
                    <div class="stat-card stat-time"><div class="stat-icon"><i class="fas fa-clock"></i></div><div><h4>${formatTime(stats.total_listened)}</h4><p>Time Listened</p></div></div>
                    <div class="stat-card stat-storage"><div class="stat-icon"><i class="fas fa-hard-drive"></i></div><div><h4>${formatBytes(stats.storage_used)}</h4><p>Storage Used</p></div></div>
                `;
            }

            const recentResponse = await fetchWithTimeout('/api/songs?limit=5');
            if (!recentResponse.ok) throw new Error('Recent songs request failed');
            const recentSongs = await recentResponse.json();
            renderSongs(recentSongs.slice(0, 5), 'recent-songs-list', true);

            const topSongsResponse = await fetchWithTimeout('/api/top-songs');
            if (!topSongsResponse.ok) throw new Error('Top songs request failed');
            const topSongs = await topSongsResponse.json();
            renderTopSongs(topSongs.slice(0, 5), 'top-songs-list');

            const topDurationResponse = await fetchWithTimeout('/api/top-songs-duration');
            if (!topDurationResponse.ok) throw new Error('Top songs duration request failed');
            const topSongsDuration = await topDurationResponse.json();
            renderTopSongs(topSongsDuration.slice(0, 5), 'top-songs-duration-list');
        } catch (error) {
            console.warn('Dashboard unavailable; showing offline fallback.', error);
            setOfflineMode(true);
            renderDashboardFallback();
        }
    }

    // ==========================================
    // RENDER FUNCTIONS
    // ==========================================
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.onerror=null; this.style.background='#282828'; this.src='/static/icon-192.png';">
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.onerror=null; this.style.background='#282828'; this.src='/static/icon-192.png';">
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
                    await fetch(`/api/songs/${e.currentTarget.getAttribute('data-id')}`, {method: 'DELETE'});
                    showToast('Song deleted permanently');
                    loadDashboard();
                }
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

    async function logPlay(songId) {
        if (!songId) return null;
        try {
            return await listeningSync.play(songId);
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
            const cache = await caches.open(OFFLINE_MEDIA_CACHE);
            await cache.delete(audioUrl, { ignoreSearch: true });
            throw new Error('Offline audio is incomplete or corrupted');
        }

        el.audio.src = audioUrl;
        el.audio.load();
        resumeCurrentSong(requestId);
    }

    function playLibrarySong(song) {
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
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
        state.currentPlaylistSongs = [previewSong];
        state.currentSongIndex = 0;
        state.currentSongMeta = previewSong;
        state.currentPlayingSongId = String(previewSong.id);
        // Shared library previews count only if this account owns a copy.
        state.playbackStatisticsSongId = Object.hasOwn(song, 'in_my_library')
            ? song.owned_song_id : song.id;
        state.playEventLogged = false;
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
            el.playerArt.src = `/static/album_art/${mediaUrlName(previewSong.album_art)}`;
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
        if (typeof isPrimarySyncLeader !== 'undefined') isPrimarySyncLeader = true;
        flushListenLog();
        state.currentPlaylistSongs = songs;
        state.currentSongIndex = index;
        const song = songs[index];
        state.currentSongMeta = song;

        state.currentPlayingSongId = String(song.id);
        state.playbackStatisticsSongId = song.id;
        state.playEventLogged = false;
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
            el.playerArt.src = `/static/album_art/${mediaUrlName(song.album_art)}`;
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
        if (el.audio.paused) {
            state.shouldBePlaying = true;
            resumeCurrentSong();
            updatePlayPauseIcon(true);
        } else {
            state.shouldBePlaying = false;
            el.audio.pause();
            updatePlayPauseIcon(false);
        }
    }

    function playNext(isFromSongEnded = true) {
        if (state.repeatMode === 2 && isFromSongEnded) {
            state.playbackRequestId += 1;
            state.playEventLogged = false;
            state.playbackSessionId = null;
            state.playbackSessionPromise = null;
            state.lastLoggedTime = 0;
            el.audio.currentTime = 0;
            state.shouldBePlaying = true;
            resumeCurrentSong();
            return;
        }

        if (state.playQueue.length > 0) {
            const nextSong = state.playQueue.shift();
            playQueuedSong(nextSong);
            return;
        }

        if (state.currentPlaylistSongs.length === 0) return;

        // Queue is empty: the whole playlist has played through once.
        if (state.isShuffle) {
            if (state.repeatMode === 0) {
                state.shouldBePlaying = false;
                el.audio.pause();
                updatePlayPauseIcon(false);
                return;
            }
            // Repeat All: start a fresh shuffle so the next loop has a new order.
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
        if (state.currentPlaylistSongs.length === 0) return;
        if (el.audio.currentTime > 3) {
            seekAudio(0);
            return;
        }
        playSong(state.currentPlaylistSongs, (state.currentSongIndex - 1 + state.currentPlaylistSongs.length) % state.currentPlaylistSongs.length);
    }

    // ==========================================
    // FREQUENCY FOCUS & SHARE CARD: Extracted to static/recap.js
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

            // ==========================================
    // THEME CUSTOMIZATION ENGINE (COHESIVE & HARMONIZED)
    // ==========================================
    // Theme Customization Engine has been modularized into static/theme.js
    if (typeof window.initThemeManager === 'function') {
        try { window.initThemeManager(); } catch (e) { console.warn('initThemeManager failed:', e); }
    }

});
