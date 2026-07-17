// ==========================================
// GLOBAL FETCH INTERCEPTOR (SINGLE SOURCE)
// ==========================================
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    // CSRF Token injection untuk POST/PUT/DELETE
    const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
    const csrfToken = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

    options.headers = options.headers || {};
    if (csrfToken && ['POST', 'PUT', 'DELETE'].includes(options.method?.toUpperCase())) {
        options.headers['X-CSRF-Token'] = csrfToken;
    }

    try {
        const response = await _originalFetch.call(this, url, options);

        // Handle 401 Unauthorized (skip untuk auth endpoints)
        if (response.status === 401) {
            const path = typeof url === 'string' ? url : url.toString();
            if (!path.includes('/api/login') &&
                !path.includes('/api/setup') &&
                !path.includes('/api/users')) {
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

    // ==========================================
    // STATE MANAGEMENT (Single Source of Truth)
    // ==========================================
    const state = {
        capsulePeriod: 'month-current',
        capsuleData: null,
        playQueue: [],
        currentPlaylistId: null,
        currentPlaylistSongs: [],
        currentSongIndex: -1,
        isShuffle: false,
        repeatMode: 0, // 0=Off, 1=RepeatAll, 2=RepeatOne
        currentPlayingSongId: null,
        wasPlayingBeforeSeek: false,
        lastLoggedTime: 0,
        loopStart: 0,
        loopEnd: 0,
        isLooping: false,
        isRenaming: false,
        currentPlaylist: null,
        lyricsPanelOpen: false,
        syncedLyrics: [],
        plainLyrics: '',
        rawSyncedLyrics: '',
        lyricsStatusValue: 'none',
        currentLyricsSongId: null,
        currentLyricIndex: -1,
        lyricsLoading: false,
        lyricsEditing: false,
        shareLyricsTheme: 'verde',
        shareLyricsText: '',
        shareRenderPromise: null,
        currentSongMeta: null,
        lyricsRequestToken: 0,
        matchedLibrarySong: null,
        pendingLibrarySong: null,
        librarySongs: []
    };

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
        nowPlaying: document.getElementById('now-playing-container'),
        playerTitle: document.getElementById('player-title'),
        playerArtist: document.getElementById('player-artist'),
        playerArt: document.getElementById('player-art'),
        playPauseBtn: document.getElementById('play-pause-btn'),
        toastContainer: document.getElementById('toast-container'),
        downloadWrapper: document.getElementById('download-progress-wrapper'),
        downloadBar: document.getElementById('download-progress-bar'),
        downloadLabel: document.getElementById('download-progress-label'),
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
        lyricsRetryBtn: document.getElementById('lyrics-retry-btn'),
        lyricsEditBtn: document.getElementById('lyrics-edit-btn'),
        lyricsShareBtn: document.getElementById('lyrics-share-btn'),
        lyricsCancelEditBtn: document.getElementById('lyrics-cancel-edit-btn'),
        lyricsSaveBtn: document.getElementById('lyrics-save-btn'),
        shareLyricsModal: document.getElementById('share-lyrics-modal'),
        shareLyricsCloseBtn: document.getElementById('share-lyrics-close-btn'),
        shareLyricsInput: document.getElementById('share-lyrics-input'),
        shareLyricsCanvas: document.getElementById('share-lyrics-canvas'),
        shareLyricsCopyBtn: document.getElementById('share-lyrics-copy-btn'),
        shareLyricsDownloadBtn: document.getElementById('share-lyrics-download-btn'),
        sidebar: document.querySelector('.sidebar'),
        mobileMenuBtn: document.getElementById('mobile-menu-btn'),
        capsuleView: document.getElementById('capsule-view'),
        capsuleBtn: document.getElementById('capsule-btn'),
        capsuleContent: document.getElementById('capsule-content'),
        capsulePeriodSelect: document.getElementById('capsule-period-select'),
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

    const socket = io();

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

    function setLyricsStatus(message) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = message;
    }

    function setLyricsEditing(isEditing) {
        state.lyricsEditing = isEditing;
        if (el.lyricsBody) el.lyricsBody.style.display = isEditing ? 'none' : '';
        if (el.lyricsEditor) el.lyricsEditor.style.display = isEditing ? 'flex' : 'none';
        if (el.lyricsEditBtn) el.lyricsEditBtn.style.display = isEditing || !state.currentLyricsSongId ? 'none' : '';
        if (el.lyricsCancelEditBtn) el.lyricsCancelEditBtn.style.display = isEditing ? '' : 'none';
        if (el.lyricsSaveBtn) el.lyricsSaveBtn.style.display = isEditing ? '' : 'none';
        if (el.lyricsRetryBtn) el.lyricsRetryBtn.style.display = isEditing ? 'none' : '';
        if (isEditing) {
            if (el.lyricsPlainInput) el.lyricsPlainInput.value = state.plainLyrics || '';
            if (el.lyricsSyncedInput) el.lyricsSyncedInput.value = state.rawSyncedLyrics || '';
            el.lyricsPlainInput?.focus();
            setLyricsStatus('Editing lyrics for this song.');
        }
    }

    function openLyricsPanel() {
        state.lyricsPanelOpen = true;
        el.lyricsPanel?.classList.add('open');
        el.lyricsBtn?.classList.add('active');
        el.lyricsPanel?.setAttribute('aria-hidden', 'false');
        if (state.currentLyricsSongId) {
            renderLyricsPanel();
        }
    }

    function closeLyricsPanel() {
        state.lyricsPanelOpen = false;
        el.lyricsPanel?.classList.remove('open');
        el.lyricsBtn?.classList.remove('active');
        el.lyricsPanel?.setAttribute('aria-hidden', 'true');
    }

    function setQueueOpen(isOpen) {
        const queuePopover = document.getElementById('queue-popover');
        const queueBtn = document.getElementById('queue-btn');
        queuePopover?.classList.toggle('active', isOpen);
        queueBtn?.classList.toggle('active', isOpen);
    }

    function renderLyricsPanel() {
        if (!el.lyricsBody || !el.lyricsTitle || !el.lyricsSubtitle) return;

        const hasSynced = Array.isArray(state.syncedLyrics) && state.syncedLyrics.length > 0;
        const hasPlain = Boolean(state.plainLyrics && state.plainLyrics.trim());
        if (state.lyricsEditing) {
            setLyricsEditing(true);
            return;
        }

        if (!state.currentLyricsSongId) {
            el.lyricsTitle.textContent = 'Select a song';
            el.lyricsSubtitle.textContent = 'Cached lyrics will appear here.';
            el.lyricsBody.innerHTML = `
                <div class="lyrics-empty">
                    <i class="fas fa-music"></i>
                    <p>No lyrics loaded yet.</p>
                </div>
            `;
            setLyricsStatus('Choose a track to load lyrics.');
            if (el.lyricsEditBtn) el.lyricsEditBtn.style.display = 'none';
            return;
        }

        if (hasSynced) {
            const html = state.syncedLyrics.map((line, index) => {
                const text = escapeHtml(line.text || '');
                return `<button type="button" class="lyric-line" data-index="${index}" data-timestamp="${line.timestamp}">${text || '&nbsp;'}</button>`;
            }).join('');
            el.lyricsBody.innerHTML = `<div class="lyrics-lines">${html}</div>`;
            el.lyricsBody.querySelectorAll('.lyric-line').forEach((lineBtn) => {
                lineBtn.addEventListener('click', () => {
                    const timestamp = Number.parseFloat(lineBtn.dataset.timestamp || '0');
                    if (!Number.isFinite(timestamp)) return;
                    el.audio.currentTime = timestamp;
                    state.lastLoggedTime = timestamp;
                    updateSyncedLyrics(true);
                });
            });
            setLyricsStatus('Tap a line to seek.');
            updateSyncedLyrics(true);
            return;
        }

        if (hasPlain) {
            el.lyricsBody.innerHTML = `<div class="lyrics-plain">${escapeHtml(state.plainLyrics).replace(/\n/g, '<br>')}</div>`;
            setLyricsStatus('Plain lyrics only.');
            return;
        }

        el.lyricsBody.innerHTML = `
            <div class="lyrics-empty">
                <i class="fas fa-compact-disc"></i>
                <p>No lyrics found for this song.</p>
            </div>
        `;
        setLyricsStatus(state.lyricsStatusValue === 'not_found'
            ? 'Lyrics were not found. You can add them manually.'
            : 'No lyrics cached yet. Try again to fetch from LRCLIB.');
        if (el.lyricsEditBtn) el.lyricsEditBtn.style.display = '';
    }

    function updateSyncedLyrics(forceScroll = false) {
        if (!el.lyricsBody || !Array.isArray(state.syncedLyrics) || state.syncedLyrics.length === 0) return;

        const currentTime = el.audio.currentTime || 0;
        let activeIndex = -1;
        for (let i = 0; i < state.syncedLyrics.length; i += 1) {
            if (state.syncedLyrics[i].timestamp <= currentTime + 0.2) {
                activeIndex = i;
            } else {
                break;
            }
        }

        if (activeIndex === state.currentLyricIndex && !forceScroll) return;
        state.currentLyricIndex = activeIndex;

        const lyricNodes = el.lyricsBody.querySelectorAll('.lyric-line');
        lyricNodes.forEach((node, index) => {
            node.classList.toggle('past', index < activeIndex);
            node.classList.toggle('active', index === activeIndex && activeIndex !== -1);
        });

        if (activeIndex !== -1) {
            const activeNode = el.lyricsBody.querySelector(`.lyric-line[data-index="${activeIndex}"]`);
            if (activeNode && (forceScroll || state.lyricsPanelOpen)) {
                activeNode.scrollIntoView({ block: 'center', behavior: forceScroll ? 'auto' : 'smooth' });
            }
        }
    }

    async function loadLyrics(songId, forceRefresh = false) {
        if (!songId) return;
        if (state.currentLyricsSongId === songId && !forceRefresh) {
            if (state.lyricsPanelOpen) renderLyricsPanel();
            updateSyncedLyrics(true);
            return;
        }

        const requestToken = state.lyricsRequestToken + 1;
        state.lyricsRequestToken = requestToken;

        state.currentLyricsSongId = songId;
        state.syncedLyrics = [];
        state.plainLyrics = '';
        state.rawSyncedLyrics = '';
        state.lyricsStatusValue = 'none';
        state.currentLyricIndex = -1;
        state.lyricsLoading = true;
        setLyricsEditing(false);

        if (el.lyricsTitle) el.lyricsTitle.textContent = 'Loading...';
        setLyricsStatus('Fetching lyrics cache...');
        if (state.lyricsPanelOpen) {
            el.lyricsBody.innerHTML = `
                <div class="lyrics-empty">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Loading lyrics...</p>
                </div>
            `;
        }

        try {
            const method = forceRefresh ? 'POST' : 'GET';
            const res = await fetch(`/api/songs/${songId}/lyrics`, { method });
            const data = await res.json();

            if (requestToken !== state.lyricsRequestToken || String(state.currentPlayingSongId) !== String(songId)) {
                return;
            }

            if (!res.ok) {
                throw new Error(data.error || 'Lyrics unavailable');
            }

            state.plainLyrics = data.lyrics || '';
            state.rawSyncedLyrics = data.synced_lyrics || '';
            state.syncedLyrics = parseLRC(state.rawSyncedLyrics);
            state.lyricsStatusValue = data.lyrics_status || 'none';

            const song = state.currentSongMeta && String(state.currentSongMeta.id) === String(songId)
                ? state.currentSongMeta
                : state.currentPlaylistSongs.find(item => String(item.id) === String(songId)) || null;

            if (el.lyricsTitle) el.lyricsTitle.textContent = song?.title || 'Lyrics';
            if (el.lyricsSubtitle) {
                el.lyricsSubtitle.textContent = song?.artist ? `${song.artist}${song.duration_seconds ? ` - ${formatTime(song.duration_seconds)}` : ''}` : 'Cached lyrics';
            }

            if (state.lyricsPanelOpen) {
                renderLyricsPanel();
            }
            updateSyncedLyrics(true);
        } catch (err) {
            if (requestToken !== state.lyricsRequestToken || String(state.currentPlayingSongId) !== String(songId)) {
                return;
            }
            state.syncedLyrics = [];
            state.plainLyrics = '';
            state.rawSyncedLyrics = '';
            state.lyricsStatusValue = 'not_found';
            if (el.lyricsTitle) el.lyricsTitle.textContent = 'Lyrics';
            setLyricsStatus('No lyrics found. You can add them manually.');
            if (state.lyricsPanelOpen) {
                el.lyricsBody.innerHTML = `
                    <div class="lyrics-empty">
                        <i class="fas fa-compact-disc"></i>
                        <p>No lyrics found. Add lyrics manually or try again.</p>
                    </div>
                `;
            }
        } finally {
            state.lyricsLoading = false;
        }
    }

    async function saveManualLyrics() {
        if (!state.currentLyricsSongId) return;
        const lyrics = el.lyricsPlainInput?.value || '';
        const syncedLyrics = el.lyricsSyncedInput?.value || '';
        if (el.lyricsSaveBtn) {
            el.lyricsSaveBtn.disabled = true;
            el.lyricsSaveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        }
        try {
            const res = await fetch(`/api/songs/${state.currentLyricsSongId}/lyrics`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({lyrics, synced_lyrics: syncedLyrics})
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to save lyrics');

            state.plainLyrics = data.lyrics || '';
            state.rawSyncedLyrics = data.synced_lyrics || '';
            state.syncedLyrics = parseLRC(state.rawSyncedLyrics);
            state.lyricsStatusValue = data.lyrics_status || 'manual';
            setLyricsEditing(false);
            renderLyricsPanel();
            updateSyncedLyrics(true);
            showToast('Lyrics saved', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to save lyrics', 'error');
        } finally {
            if (el.lyricsSaveBtn) {
                el.lyricsSaveBtn.disabled = false;
                el.lyricsSaveBtn.innerHTML = '<i class="fas fa-check"></i> Save';
            }
        }
    }

    const shareThemes = {
        verde: ['#073b25', '#30d66b'],
        dusk: ['#182848', '#4b6cb7'],
        rose: ['#7f1d1d', '#fb7185'],
        amber: ['#78350f', '#fbbf24'],
        mono: ['#090909', '#3f3f46'],
        cyan: ['#164e63', '#38bdf8']
    };

    function getShareLyricsSource() {
        if (Array.isArray(state.syncedLyrics) && state.syncedLyrics.length) {
            return state.syncedLyrics.map(line => line.text).filter(Boolean).join('\n');
        }
        return state.plainLyrics || '';
    }

    function getShareSong() {
        return state.currentSongMeta
            || state.currentPlaylistSongs.find(song => String(song.id) === String(state.currentPlayingSongId))
            || {};
    }

    function pickInitialShareText(text) {
        return String(text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 7)
            .join('\n');
    }

    async function openShareLyricsModal() {
        if (!state.currentPlayingSongId) {
            showToast('Play a song first', 'error');
            return;
        }
        if (!getShareLyricsSource().trim()) {
            await loadLyrics(state.currentPlayingSongId);
        }

        const lyrics = getShareLyricsSource();
        if (!lyrics.trim()) {
            showToast('No lyrics available to share', 'error');
            return;
        }

        state.shareLyricsText = pickInitialShareText(lyrics);
        if (el.shareLyricsInput) {
            el.shareLyricsInput.value = lyrics;
            el.shareLyricsInput.focus();
            el.shareLyricsInput.setSelectionRange(0, state.shareLyricsText.length);
        }
        if (el.shareLyricsModal) {
            el.shareLyricsModal.style.display = 'flex';
            el.shareLyricsModal.setAttribute('aria-hidden', 'false');
        }
        state.shareRenderPromise = renderShareLyricsCanvas();
    }

    function closeShareLyricsModal() {
        el.shareLyricsModal?.setAttribute('aria-hidden', 'true');
        if (el.shareLyricsModal) el.shareLyricsModal.style.display = 'none';
    }

    function updateShareLyricsText() {
        if (!el.shareLyricsInput) return;
        const start = el.shareLyricsInput.selectionStart ?? 0;
        const end = el.shareLyricsInput.selectionEnd ?? 0;
        const selected = start !== end ? el.shareLyricsInput.value.slice(start, end) : '';
        state.shareLyricsText = (selected || el.shareLyricsInput.value).trim();
        state.shareRenderPromise = renderShareLyricsCanvas();
    }

    function wrapCanvasText(ctx, text, maxWidth) {
        const lines = [];
        String(text || '').split(/\r?\n/).forEach((paragraph) => {
            const words = paragraph.trim().split(/\s+/).filter(Boolean);
            let line = '';
            words.forEach((word) => {
                const next = line ? `${line} ${word}` : word;
                if (ctx.measureText(next).width > maxWidth && line) {
                    lines.push(line);
                    line = word;
                } else {
                    line = next;
                }
            });
            if (line) lines.push(line);
            if (!words.length) lines.push('');
        });
        return lines;
    }

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
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function drawCoverFallback(ctx, x, y, size) {
        drawRoundRect(ctx, x, y, size, size, 26);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 34px Manrope, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('psr', x + size / 2, y + size / 2);
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

    function fitCanvasText(ctx, text, maxWidth) {
        const value = String(text || '');
        if (ctx.measureText(value).width <= maxWidth) return value;
        let trimmed = value;
        while (trimmed.length > 1 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
            trimmed = trimmed.slice(0, -1);
        }
        return `${trimmed.trim()}...`;
    }

    async function renderShareLyricsCanvas() {
        const canvas = el.shareLyricsCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const colors = shareThemes[state.shareLyricsTheme] || shareThemes.verde;
        const song = getShareSong();
        const lyrics = state.shareLyricsText || pickInitialShareText(getShareLyricsSource());
        const coverSrc = song.album_art ? `/static/album_art/${mediaUrlName(song.album_art)}` : '';
        const cover = await loadCanvasImage(coverSrc);

        const pad = 88;
        const maxLyricsWidth = width - pad * 2;
        const fontSize = lyrics.length > 360 ? 42 : lyrics.length > 220 ? 48 : 56;
        ctx.font = `800 ${fontSize}px Space Grotesk, Manrope, Arial, sans-serif`;
        const lineHeight = Math.round(fontSize * 1.32);
        const wrappedLines = wrapCanvasText(ctx, lyrics, maxLyricsWidth);
        const footerHeight = 210;
        const height = Math.max(900, 310 + (Math.min(wrappedLines.length, 14) * lineHeight) + footerHeight);
        canvas.height = height;

        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, colors[0]);
        gradient.addColorStop(1, colors[1]);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = 'rgba(0,0,0,0.14)';
        ctx.beginPath();
        ctx.arc(width * 0.92, height * 0.08, 260, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(width * 0.08, height * 0.92, 320, 0, Math.PI * 2);
        ctx.fill();

        if (cover) {
            drawRoundedImage(ctx, cover, pad, pad, 116, 26);
        } else {
            drawCoverFallback(ctx, pad, pad, 116);
        }

        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 46px Space Grotesk, Manrope, Arial, sans-serif';
        ctx.fillText(fitCanvasText(ctx, song.title || 'Song Title', width - pad * 2 - 142), pad + 142, pad + 42);
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.font = '600 30px Manrope, Arial, sans-serif';
        ctx.fillText(fitCanvasText(ctx, song.artist || 'Unknown Artist', width - pad * 2 - 142), pad + 142, pad + 86);

        ctx.font = `800 ${fontSize}px Space Grotesk, Manrope, Arial, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'top';
        const maxLines = Math.floor((height - 390) / lineHeight);
        const lines = wrappedLines.slice(0, maxLines);
        let y = 310;
        lines.forEach((line) => {
            ctx.fillText(line, pad, y);
            y += lineHeight;
        });
        if (wrappedLines.length > maxLines && lines.length) {
            ctx.fillText('...', pad, y);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.24)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pad, height - 150);
        ctx.lineTo(width - pad, height - 150);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '800 34px Manrope, Arial, sans-serif';
        ctx.fillText('psr.fm', pad, height - 104);
        ctx.font = '600 24px Manrope, Arial, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.68)';
        ctx.fillText('private frequency', pad, height - 68);
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    function shareFilename() {
        const song = getShareSong();
        return `psr.fm-${song.title || 'lyrics'}`.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) + '.png';
    }

    async function downloadShareLyrics() {
        if (!el.shareLyricsCanvas) return;
        await state.shareRenderPromise;
        const blob = await canvasToBlob(el.shareLyricsCanvas);
        if (!blob) return showToast('Failed to create image', 'error');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = shareFilename();
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showToast('Lyrics card downloaded', 'success');
    }

    async function copyShareLyrics() {
        if (!el.shareLyricsCanvas || !navigator.clipboard?.write || !window.ClipboardItem) {
            await downloadShareLyrics();
            return;
        }
        await state.shareRenderPromise;
        const blob = await canvasToBlob(el.shareLyricsCanvas);
        if (!blob) return showToast('Failed to create image', 'error');
        try {
            await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
            showToast('Lyrics card copied', 'success');
        } catch (err) {
            await downloadShareLyrics();
        }
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

        el.audio.currentTime = state.loopStart;

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
        if (!el.volumeIcon) return;
        const muted = el.audio.muted || vol === 0;
        if (muted) el.volumeIcon.className = 'fas fa-volume-mute';
        else if (vol < 0.5) el.volumeIcon.className = 'fas fa-volume-down';
        else el.volumeIcon.className = 'fas fa-volume-up';
        el.volumeBtn?.classList.toggle('active', muted);
        el.volumeBtn?.setAttribute('aria-pressed', String(muted));
        el.volumeBtn?.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
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
// USER MANAGEMENT (Admin Only) - MODERN
// ==========================================
let resetPasswordUserId = null;
let resetPasswordUsername = '';
let roleChangeUserId = null;
let roleChangeUsername = '';
let allUsersCache = [];
let userFilter = 'all';
let userSearchQuery = '';

// Avatar color generator
function getAvatarColor(username) {
    const colors = [
        'linear-gradient(135deg, #f97316, #ea580c)',
        'linear-gradient(135deg, #ec4899, #db2777)',
        'linear-gradient(135deg, #8b5cf6, #7c3aed)',
        'linear-gradient(135deg, #06b6d4, #0891b2)',
        'linear-gradient(135deg, #10b981, #059669)',
        'linear-gradient(135deg, #f59e0b, #d97706)',
        'linear-gradient(135deg, #ef4444, #dc2626)',
        'linear-gradient(135deg, #3b82f6, #2563eb)',
    ];
    const hash = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
}

async function loadUsers() {
    if (!el.usersTableBody) return;
    
    el.usersTableBody.innerHTML = `
        <tr>
            <td colspan="6">
                <div class="users-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading users...</span>
                </div>
            </td>
        </tr>
    `;

    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error('Failed to load users');
        const users = await res.json();
        const currentUser = await (await fetch('/api/me')).json();

        allUsersCache = users;
        updateStats(users);
        renderUsers(users, currentUser);

    } catch (err) {
        el.usersTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="users-empty">
                        <i class="fas fa-exclamation-circle"></i>
                        <h4>Failed to load users</h4>
                        <p>Please check your connection and try again.</p>
                    </div>
                </td>
            </tr>
        `;
    }
}

function updateStats(users) {
    const admins = users.filter(u => u.role === 'admin').length;
    const regular = users.filter(u => u.role === 'user').length;
    const totalSongs = users.reduce((sum, u) => sum + (u.song_count || 0), 0);

    document.getElementById('stat-total-users').textContent = users.length;
    document.getElementById('stat-admins').textContent = admins;
    document.getElementById('stat-regular-users').textContent = regular;
    document.getElementById('stat-total-songs').textContent = totalSongs;
}

function renderUsers(users, currentUser) {
    // Filter
    let filtered = users;
    
    if (userFilter !== 'all') {
        filtered = filtered.filter(u => u.role === userFilter);
    }
    
    if (userSearchQuery) {
        const q = userSearchQuery.toLowerCase();
        filtered = filtered.filter(u => u.username.toLowerCase().includes(q));
    }

    if (filtered.length === 0) {
        el.usersTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="users-empty">
                        <i class="fas fa-search"></i>
                        <h4>No users found</h4>
                        <p>Try adjusting your search or filter criteria.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    el.usersTableBody.innerHTML = filtered.map(user => {
        const isSelf = user.id === currentUser.id;
        const isAdmin = user.role === 'admin';
        const avatarBg = isAdmin 
            ? 'linear-gradient(135deg, #fbbf24, #f59e0b)' 
            : getAvatarColor(user.username);

        return `
            <tr data-user-id="${user.id}">
                <td>
                    <div class="user-cell">
                        <div class="user-avatar-lg ${isAdmin ? 'admin' : ''}" style="background: ${avatarBg};">
                            ${escapeHtml(user.username.charAt(0).toUpperCase())}
                        </div>
                        <div class="user-info-cell">
                            <div class="user-name-cell">
                                ${escapeHtml(user.username)}
                                ${isSelf ? '<span class="self-user-badge">You</span>' : ''}
                            </div>
                            <div class="user-id-cell">ID: ${user.id}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <span class="role-badge ${user.role}">
                        <i class="fas ${isAdmin ? 'fa-shield-alt' : 'fa-user'}"></i>
                        ${escapeHtml(user.role)}
                    </span>
                </td>
                <td>
                    <span class="stat-pill">
                        <i class="fas fa-list"></i>
                        ${user.playlist_count}
                    </span>
                </td>
                <td>
                    <span class="stat-pill">
                        <i class="fas fa-music"></i>
                        ${user.song_count}
                    </span>
                </td>
                <td>
                    <span class="date-cell">${formatDate(user.created_at)}</span>
                </td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn reset-pw" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-tooltip="Reset Password"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-key"></i>
                        </button>
                        <button class="action-btn change-role" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-role="${user.role}"
                                data-tooltip="Change Role"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-user-tag"></i>
                        </button>
                        <button class="action-btn delete-user" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-tooltip="Delete User"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Attach event listeners
    el.usersTableBody.querySelectorAll('.btn-delete-user, .action-btn.delete-user').forEach(btn => {
        btn.addEventListener('click', () => {
            showDeleteConfirm(parseInt(btn.dataset.id), btn.dataset.username);
        });
    });

    el.usersTableBody.querySelectorAll('.btn-reset-pw, .action-btn.reset-pw').forEach(btn => {
        btn.addEventListener('click', () => openResetPasswordModal(parseInt(btn.dataset.id), btn.dataset.username));
    });

    el.usersTableBody.querySelectorAll('.action-btn.change-role').forEach(btn => {
        btn.addEventListener('click', () => openRoleChangeModal(
            parseInt(btn.dataset.id), 
            btn.dataset.username, 
            btn.dataset.role
        ));
    });
}

// Custom Confirm Modal
let confirmCallback = null;
let confirmRequiresInput = false;
let confirmKeyword = '';

function showConfirmModal({ title, message, confirmText = 'Confirm', danger = true, requiresInput = '', callback }) {
    const modal = document.getElementById('confirm-modal');
    const icon = document.getElementById('confirm-modal-icon');
    const titleEl = document.getElementById('confirm-modal-title');
    const messageEl = document.getElementById('confirm-modal-message');
    const inputWrapper = document.getElementById('confirm-modal-input-wrapper');
    const keywordEl = document.getElementById('confirm-modal-keyword');
    const inputEl = document.getElementById('confirm-modal-input');
    const confirmBtn = document.getElementById('confirm-modal-confirm');

    titleEl.textContent = title;
    messageEl.innerHTML = message;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
    icon.className = danger ? 'confirm-modal-icon' : 'confirm-modal-icon warning';

    if (requiresInput) {
        confirmRequiresInput = true;
        confirmKeyword = requiresInput;
        keywordEl.textContent = requiresInput;
        inputWrapper.style.display = 'block';
        inputEl.value = '';
        confirmBtn.disabled = true;
    } else {
        confirmRequiresInput = false;
        inputWrapper.style.display = 'none';
        confirmBtn.disabled = false;
    }

    confirmCallback = callback;
    modal.style.display = 'flex';

    if (requiresInput) {
        setTimeout(() => inputEl.focus(), 100);
    }
}

// Delete user with custom confirm
function showDeleteConfirm(userId, username) {
    showConfirmModal({
        title: 'Delete User Permanently?',
        message: `
            You are about to delete user <strong style="color: var(--danger-color);">${escapeHtml(username)}</strong>.<br><br>
            This will permanently delete:
            <div style="text-align: left; margin-top: 8px; padding-left: 20px;">
                &bull; All their playlists<br>
                &bull; All their songs & MP3 files<br>
                &bull; All listening history
            </div>
            <br><strong>This action cannot be undone.</strong>
        `,
        confirmText: 'Delete User',
        danger: true,
        requiresInput: username,
        callback: async () => {
            try {
                const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
                const data = await res.json();

                if (res.ok) {
                    showToast(`User "${username}" deleted successfully`, 'success');
                    loadUsers();
                } else {
                    showToast(data.error || 'Failed to delete user', 'error');
                }
            } catch (err) {
                showToast('Network error', 'error');
            }
        }
    });
}

function openResetPasswordModal(userId, username) {
    resetPasswordUserId = userId;
    resetPasswordUsername = username;

    document.getElementById('reset-username-display').innerText = username;
    document.getElementById('reset-password-input').value = '';
    document.getElementById('reset-password-confirm').value = '';
    document.getElementById('reset-password-error').style.display = 'none';
    document.getElementById('reset-password-modal').style.display = 'flex';

    setTimeout(() => document.getElementById('reset-password-input').focus(), 100);
}

async function confirmResetPassword() {
    const password = document.getElementById('reset-password-input').value;
    const confirmPw = document.getElementById('reset-password-confirm').value;
    const errorEl = document.getElementById('reset-password-error');

    errorEl.style.display = 'none';

    if (!password) {
        errorEl.textContent = 'Password is required';
        errorEl.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        errorEl.textContent = 'Password must be at least 6 characters';
        errorEl.style.display = 'block';
        return;
    }
    if (password !== confirmPw) {
        errorEl.textContent = 'Passwords do not match';
        errorEl.style.display = 'block';
        return;
    }

    const btn = document.getElementById('confirm-reset-password');
    btn.disabled = true;
    btn.innerText = 'Resetting...';

    try {
        const res = await fetch(`/api/admin/users/${resetPasswordUserId}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();

        if (res.ok) {
            showToast(`Password reset for "${resetPasswordUsername}"`, 'success');
            document.getElementById('reset-password-modal').style.display = 'none';
        } else {
            errorEl.textContent = data.error || 'Failed to reset password';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'Network error';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerText = 'Reset Password';
    }
}

// Role Change Modal
function openRoleChangeModal(userId, username, currentRole) {
    roleChangeUserId = userId;
    roleChangeUsername = username;

    document.getElementById('role-username-display').innerText = username;
    
    // Set current role as selected
    const radios = document.querySelectorAll('input[name="role-choice"]');
    radios.forEach(radio => {
        radio.checked = radio.value === currentRole;
    });

    document.getElementById('role-modal').style.display = 'flex';
}

async function confirmRoleChange() {
    const selected = document.querySelector('input[name="role-choice"]:checked');
    if (!selected) {
        showToast('Please select a role', 'error');
        return;
    }

    const newRole = selected.value;
    const btn = document.getElementById('confirm-role-change');
    btn.disabled = true;
    btn.innerText = 'Saving...';

    try {
        const res = await fetch(`/api/admin/users/${roleChangeUserId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: newRole })
        });
        const data = await res.json();

        if (res.ok) {
            showToast(`Role updated to ${newRole} for "${roleChangeUsername}"`, 'success');
            document.getElementById('role-modal').style.display = 'none';
            loadUsers();
        } else {
            showToast(data.error || 'Failed to update role', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Save Changes';
    }
}

// Event listeners untuk User Management
if (el.usersBtn) {
    el.usersBtn.addEventListener('click', () => {
        // Toggle: jika sudah di users-view, kembali ke dashboard
        const usersViewActive = el.usersView?.classList.contains('active');
        if (usersViewActive) {
            showView('dashboard');
        } else {
            showView('users');
            loadUsers();
        }
    });
}
document.getElementById('close-users-view')?.addEventListener('click', () => {
    showView('dashboard');
    document.getElementById('home-btn')?.focus();
});
if (el.addUserBtnMain) {
    el.addUserBtnMain.addEventListener('click', () => {
        const modal = document.getElementById('add-user-modal');
        if (modal) modal.style.display = 'flex';
    });
}

// Confirm modal events
document.getElementById('cancel-reset-password')?.addEventListener('click', () => {
    document.getElementById('reset-password-modal').style.display = 'none';
});

document.getElementById('confirm-reset-password')?.addEventListener('click', confirmResetPassword);

document.getElementById('confirm-modal-cancel')?.addEventListener('click', () => {
    document.getElementById('confirm-modal').style.display = 'none';
    confirmCallback = null;
});

document.getElementById('confirm-modal-confirm')?.addEventListener('click', () => {
    if (confirmRequiresInput) {
        const input = document.getElementById('confirm-modal-input').value;
        if (input !== confirmKeyword) {
            showToast('Input does not match', 'error');
            return;
        }
    }
    document.getElementById('confirm-modal').style.display = 'none';
    if (confirmCallback) {
        confirmCallback();
        confirmCallback = null;
    }
});

document.getElementById('confirm-modal-input')?.addEventListener('input', (e) => {
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    confirmBtn.disabled = e.target.value !== confirmKeyword;
});

// Role modal events
document.getElementById('cancel-role-change')?.addEventListener('click', () => {
    document.getElementById('role-modal').style.display = 'none';
});

document.getElementById('confirm-role-change')?.addEventListener('click', confirmRoleChange);

// Search & Filter
document.getElementById('user-search-input')?.addEventListener('input', debounce((e) => {
    userSearchQuery = e.target.value.trim();
    if (allUsersCache.length > 0) {
        fetch('/api/me').then(r => r.json()).then(currentUser => {
            renderUsers(allUsersCache, currentUser);
        });
    }
}, 300));

document.querySelectorAll('.user-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.user-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        userFilter = btn.dataset.filter;
        if (allUsersCache.length > 0) {
            fetch('/api/me').then(r => r.json()).then(currentUser => {
                renderUsers(allUsersCache, currentUser);
            });
        }
    });
});



    // ==========================================
    // ADD NEW USER (Admin Only)
    // ==========================================
    const addUserBtn = document.getElementById('add-user-btn');
    const addUserModal = document.getElementById('add-user-modal');
    const addUserError = document.getElementById('add-user-error');
    const newUsernameInput = document.getElementById('new-username');
    const newPasswordInput = document.getElementById('new-password');
    const confirmAddUser = document.getElementById('confirm-add-user');

    if (addUserBtn) {
        addUserBtn.addEventListener('click', () => {
            addUserModal.style.display = 'flex';
            if (newUsernameInput) newUsernameInput.value = '';
            if (newPasswordInput) newPasswordInput.value = '';
            if (addUserError) addUserError.style.display = 'none';
        });
    }

    document.getElementById('cancel-add-user')?.addEventListener('click', () => {
        if (addUserModal) addUserModal.style.display = 'none';
    });

    if (confirmAddUser) {
        confirmAddUser.addEventListener('click', async () => {
            const username = newUsernameInput?.value.trim();
            const password = newPasswordInput?.value;

            if (!username || !password) {
                if (addUserError) {
                    addUserError.innerText = 'Username and password are required';
                    addUserError.style.display = 'block';
                }
                return;
            }

            confirmAddUser.disabled = true;
            confirmAddUser.innerText = 'Creating...';

            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({username, password})
                });
                const data = await res.json();

                if (res.ok && data.status === 'success') {
                    showToast(`Account "${username}" created successfully!`);
                    if (addUserModal) addUserModal.style.display = 'none';
                    loadUsers(); // Refresh user list jika di halaman users
                } else {
                    if (addUserError) {
                        addUserError.innerText = data.error || 'Failed to create user';
                        addUserError.style.display = 'block';
                    }
                }
            } catch (err) {
                if (addUserError) {
                    addUserError.innerText = 'Connection error';
                    addUserError.style.display = 'block';
                }
            } finally {
                confirmAddUser.disabled = false;
                confirmAddUser.innerText = 'Create Account';
            }
        });
    }

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
        document.querySelectorAll('.nav-item, .playlist-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768) setMobileMenu(false);
            });
        });
    }

    // ==========================================
    // NAVIGATION
    // ==========================================
    document.getElementById('home-btn')?.addEventListener('click', () => showView('dashboard'));
    document.getElementById('search-btn')?.addEventListener('click', () => showView('search'));
    document.getElementById('library-btn')?.addEventListener('click', () => showView('library'));

    // ==========================================
    // DOWNLOAD MODAL
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

    document.getElementById('save-global-download-btn')?.addEventListener('click', submitDownload);
    globalUrlInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitDownload();
    });
    globalUrlInput?.addEventListener('input', debounce(async (e) => {
        if (state.pendingLibrarySong) return;
        const url = e.target.value.trim();
        if (!url || !url.includes('youtu')) {
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
    // QUEUE MANAGEMENT
    // ==========================================
    function buildQueue() {
        state.playQueue = [];
        if (!state.currentPlaylistSongs || state.currentPlaylistSongs.length <= 1) {
            updateQueueUI();
            return;
        }
        const remaining = [...state.currentPlaylistSongs];
        remaining.splice(state.currentSongIndex, 1);

        if (state.isShuffle) {
            for (let i = remaining.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
            state.playQueue = remaining;
            if (el.queueMode) el.queueMode.innerText = '(Shuffled)';
        } else {
            for (let i = 1; i < state.currentPlaylistSongs.length; i++) {
                const nextIdx = (state.currentSongIndex + i) % state.currentPlaylistSongs.length;
                state.playQueue.push(state.currentPlaylistSongs[nextIdx]);
            }
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
        state.playQueue.slice(0, 15).forEach(song => {
            const div = document.createElement('div');
            div.className = 'queue-item';
            div.innerHTML = `
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'36\' height=\'36\' viewBox=\'0 0 24 24\' fill=\'%23555\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
                <div class="q-info">
                    <div class="q-title">${escapeHtml(song.title)}</div>
                    <div class="q-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
            `;
            div.addEventListener('click', () => {
                const idx = state.currentPlaylistSongs.findIndex(s => s.id === song.id);
                if (idx !== -1) playSong(state.currentPlaylistSongs, idx);
                setQueueOpen(false);
            });
            el.queueList.appendChild(div);
        });
    }

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

        if (viewName === 'dashboard') {
            document.getElementById('home-btn')?.classList.add('active');
            loadDashboard();
        } else if (viewName === 'search') {
            document.getElementById('search-btn')?.classList.add('active');
            document.getElementById('search-input')?.focus();
        } else if (viewName === 'library') {
            document.getElementById('library-btn')?.classList.add('active');
            document.getElementById('library-search-input')?.focus();
            loadLibrarySongs();
        } else if (viewName === 'users') {
            if (el.usersBtn) el.usersBtn.classList.add('active');
        } else if (viewName === 'capsule') {
            if (el.capsuleBtn) el.capsuleBtn.classList.add('active');
            loadFrequencyFocus(el.capsulePeriodSelect.value);
        }

        highlightPlayingSong();
    }

    // ==========================================
    // WEBSOCKET EVENTS
    // ==========================================
    socket.on('download_progress', (data) => {
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
        if (el.downloadWrapper) el.downloadWrapper.classList.remove('active');
        if (el.downloadLabel) el.downloadLabel.innerText = '0%';
    });

    // ==========================================
    // PLAYLIST MODAL
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
                await fetch(`/api/playlists/${state.currentPlaylistId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name})
                });
                if (el.playlistTitle) el.playlistTitle.innerText = name;
                showToast('Playlist renamed!');
            } else {
                await fetch('/api/playlists', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name})
                });
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

    // ==========================================
    // COVER UPLOAD
    // ==========================================
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
    // AUDIO CONTROLS
    // ==========================================
    document.getElementById('play-pause-btn')?.addEventListener('click', togglePlay);
    document.getElementById('prev-btn')?.addEventListener('click', () => playPrev());
    document.getElementById('next-btn')?.addEventListener('click', () => playNext(false));

    document.getElementById('shuffle-btn')?.addEventListener('click', () => {
        state.isShuffle = !state.isShuffle;
        document.getElementById('shuffle-btn')?.classList.toggle('active', state.isShuffle);
        buildQueue();
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
            btn.classList.toggle('active', state.repeatMode > 0);
            btn.innerHTML = state.repeatMode === 2
                ? '<i class="fas fa-redo"></i><span class="repeat-one">1</span>'
                : '<i class="fas fa-redo"></i>';
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
            el.audio.currentTime = state.loopStart;
            updateLoopIndicator();
            showToast('Loop started', 'success');
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

    el.lyricsBtn?.addEventListener('click', () => {
        if (state.lyricsPanelOpen) {
            closeLyricsPanel();
        } else {
            openLyricsPanel();
            if (state.currentPlayingSongId) {
                loadLyrics(state.currentPlayingSongId);
            }
        }
    });

    el.lyricsCloseBtn?.addEventListener('click', closeLyricsPanel);
    el.lyricsShareBtn?.addEventListener('click', openShareLyricsModal);
    el.lyricsEditBtn?.addEventListener('click', () => {
        if (state.currentLyricsSongId) setLyricsEditing(true);
    });
    el.lyricsCancelEditBtn?.addEventListener('click', () => {
        setLyricsEditing(false);
        renderLyricsPanel();
    });
    el.lyricsSaveBtn?.addEventListener('click', saveManualLyrics);
    el.lyricsRetryBtn?.addEventListener('click', () => {
        setLyricsEditing(false);
        if (state.currentPlayingSongId) {
            loadLyrics(state.currentPlayingSongId, true);
        }
    });
    el.shareLyricsCloseBtn?.addEventListener('click', closeShareLyricsModal);
    el.shareLyricsInput?.addEventListener('input', updateShareLyricsText);
    el.shareLyricsInput?.addEventListener('select', updateShareLyricsText);
    el.shareLyricsInput?.addEventListener('keyup', updateShareLyricsText);
    el.shareLyricsInput?.addEventListener('mouseup', updateShareLyricsText);
    el.shareLyricsDownloadBtn?.addEventListener('click', downloadShareLyrics);
    el.shareLyricsCopyBtn?.addEventListener('click', copyShareLyrics);
    el.shareLyricsModal?.addEventListener('click', (e) => {
        if (e.target === el.shareLyricsModal) closeShareLyricsModal();
    });
    document.querySelectorAll('.share-theme').forEach((button) => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.share-theme').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            state.shareLyricsTheme = button.dataset.theme || 'verde';
            state.shareRenderPromise = renderShareLyricsCanvas();
        });
    });

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
            togglePlay();
        }
        if (e.code === 'ArrowRight') playNext(false);
        if (e.code === 'ArrowLeft') playPrev();
        if (e.key === 'l' || e.key === 'L') {
            if (state.isLooping) {
                jumpToLoopStart();
            }
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) highlightPlayingSong();
    });

    // ==========================================
    // AUDIO EVENT LISTENERS
    // ==========================================
    el.audio.addEventListener('timeupdate', () => {
        if (el.audio.duration && !isNaN(el.audio.duration)) {
            const val = (el.audio.currentTime / el.audio.duration) * 100;
            if (el.progressBar) el.progressBar.value = val;
            if (el.progressFill) el.progressFill.style.width = `${val}%`;
            if (el.currentTime) el.currentTime.innerText = formatTime(el.audio.currentTime);
            updateSyncedLyrics();

            if (state.isLooping && el.audio.currentTime >= state.loopEnd) {
                el.audio.currentTime = state.loopStart;
            }

            if (!el.audio.paused && state.currentPlayingSongId) {
                const delta = el.audio.currentTime - state.lastLoggedTime;
                if (delta >= 5 && delta <= 30) {
                    logListen(state.currentPlayingSongId, delta);
                    state.lastLoggedTime = el.audio.currentTime;
                } else if (delta < 0) {
                    state.lastLoggedTime = el.audio.currentTime;
                }
            }
        }
    });

    el.audio.addEventListener('loadedmetadata', () => {
        if (el.duration) el.duration.innerText = formatTime(el.audio.duration);
        if (state.isLooping || state.loopStart > 0 || state.loopEnd > 0) resetLoop();
        updateLoopIndicator();
    });

    el.audio.addEventListener('play', () => {
        state.lastLoggedTime = el.audio.currentTime;
        if (el.nowPlaying) el.nowPlaying.classList.add('playing');
    });

    el.audio.addEventListener('pause', () => {
        if (el.nowPlaying) el.nowPlaying.classList.remove('playing');
        flushListenLog();
    });

    el.audio.addEventListener('seeked', () => {
        state.lastLoggedTime = el.audio.currentTime;
    });

    el.audio.addEventListener('ended', () => {
        flushListenLog();
        playNext(true);
    });

    function flushListenLog() {
        if (state.currentPlayingSongId && state.lastLoggedTime > 0) {
            const delta = el.audio.currentTime - state.lastLoggedTime;
            if (delta > 0 && delta <= 30) {
                logListen(state.currentPlayingSongId, delta);
            }
            state.lastLoggedTime = 0;
        }
    }

    function logListen(songId, seconds) {
        fetch('/api/listen', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({song_id: songId, seconds})
        }).catch(e => console.error(e));
    }

    el.progressBar?.addEventListener('input', (e) => {
        if (el.audio.duration && !isNaN(el.audio.duration)) {
            el.audio.currentTime = (e.target.value / 100) * el.audio.duration;
            if (el.progressFill) el.progressFill.style.width = `${e.target.value}%`;
        }
    });

    el.progressBar?.addEventListener('mousedown', () => {
        state.wasPlayingBeforeSeek = !el.audio.paused;
        if (state.wasPlayingBeforeSeek) el.audio.pause();
    });

    el.progressBar?.addEventListener('mouseup', () => {
        if (state.wasPlayingBeforeSeek) el.audio.play();
    });

    el.volumeBar?.addEventListener('input', (e) => {
        el.audio.volume = e.target.value / 100;
        el.audio.muted = false;
        if (el.audio.volume > 0) state.lastNonZeroVolume = el.audio.volume;
        if (el.volumeFill) el.volumeFill.style.width = `${e.target.value}%`;
        updateVolumeIcon(el.audio.volume);
    });
    state.lastNonZeroVolume = 1;
    el.volumeBtn?.addEventListener('click', () => {
        if (el.audio.muted || el.audio.volume === 0) {
            el.audio.muted = false;
            if (el.audio.volume === 0) el.audio.volume = state.lastNonZeroVolume || 1;
        } else {
            state.lastNonZeroVolume = el.audio.volume;
            el.audio.muted = true;
        }
        const shownVolume = el.audio.muted ? 0 : el.audio.volume;
        if (el.volumeBar) el.volumeBar.value = String(Math.round(shownVolume * 100));
        if (el.volumeFill) el.volumeFill.style.width = `${shownVolume * 100}%`;
        updateVolumeIcon(el.audio.volume);
    });
    if (el.volumeFill) el.volumeFill.style.width = '100%';

    // ==========================================
    // SEARCH
    // ==========================================
    document.getElementById('search-input')?.addEventListener('input', debounce(async (e) => {
        const query = e.target.value.trim();
        const searchResults = document.getElementById('search-results');
        if (query.length > 1) {
            const results = await (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json();
            renderSongs(results, 'search-results', false);
        } else {
            renderEmptyState(searchResults, {
                icon: 'fa-search',
                title: 'Search your library',
                body: 'Type at least two characters to find a song or artist in this account.'
            });
        }
    }, 300));

    async function loadLibrarySongs(query = '') {
        const libraryList = document.getElementById('library-songs-list');
        if (!libraryList) return;
        try {
            const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
            const songs = await (await fetch(`/api/library-songs${suffix}`)).json();
            state.librarySongs = songs;
            renderLibrarySongs(songs);
        } catch (err) {
            renderEmptyState(libraryList, {
                icon: 'fa-triangle-exclamation',
                title: 'Library unavailable',
                body: 'Try opening Library Songs again in a moment.'
            });
        }
    }

    function renderLibrarySongs(songs) {
        const container = document.getElementById('library-songs-list');
        if (!container) return;

        container.innerHTML = '';
        if (!songs.length) {
            renderEmptyState(container, {
                icon: 'fa-record-vinyl',
                title: 'No songs in Library Songs yet',
                body: 'Downloaded songs from every account will appear here.'
            });
            return;
        }

        songs.forEach((song) => {
            const div = document.createElement('div');
            div.className = 'song-item library-song-item';
            div.setAttribute('data-id', String(song.id));
            div.innerHTML = `
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' viewBox=\'0 0 24 24\' fill=\'%23b3b3b3\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
                <div class="song-info">
                    <div class="song-title">${escapeHtml(song.title)}</div>
                    <div class="song-artist">${escapeHtml(song.artist || 'Unknown')}</div>
                </div>
                <div class="library-song-meta">
                    <span><i class="fas fa-users"></i> Added by ${song.owner_count || 1} user${Number(song.owner_count || 1) === 1 ? '' : 's'}</span>
                    ${song.in_my_library ? '<span class="in-library-pill">Already in your library</span>' : ''}
                </div>
                <div class="song-duration">${formatTime(song.duration_seconds)}</div>
                <button class="icon-btn download-song" data-id="${song.id}" title="Download"><i class="fas fa-download"></i></button>
                <button class="btn-primary compact library-add-btn" data-id="${song.id}"><i class="fas fa-plus"></i> Add</button>
            `;
            div.querySelector('.library-add-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openDownloadModal(song);
            });
            div.querySelector('.download-song')?.addEventListener('click', (e) => {
                e.stopPropagation();
                triggerDownload(song.id);
            });
            container.appendChild(div);
        });
    }

    document.getElementById('library-search-input')?.addEventListener('input', debounce((e) => {
        loadLibrarySongs(e.target.value.trim());
    }, 300));

    // ==========================================
    // PLAYLISTS
    // ==========================================
    async function loadPlaylists() {
        const playlists = await (await fetch('/api/playlists')).json();
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
    }

    async function openPlaylist(playlist) {
        state.currentPlaylistId = playlist.id;
        state.currentPlaylist = playlist;
        if (el.playlistTitle) el.playlistTitle.innerText = playlist.name;

        if (window.innerWidth <= 768) {
            setMobileMenu(false);
        }

        const timestamp = new Date().getTime();
        const coverSrc = playlist.cover_art
            ? `/static/album_art/${mediaUrlName(playlist.cover_art)}?t=${timestamp}`
            : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 24 24' fill='%23333'><path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/></svg>";
        if (el.playlistCoverImg) el.playlistCoverImg.src = coverSrc;

        showView('playlist');
        loadPlaylists();

        const deleteBtn = document.getElementById('delete-playlist-btn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                if (confirm(`Delete playlist "${playlist.name}"? (Songs will remain in other playlists)`)) {
                    await fetch(`/api/playlists/${playlist.id}`, {method: 'DELETE'});
                    state.currentPlaylistId = null;
                    loadPlaylists();
                    showView('dashboard');
                    showToast('Playlist deleted');
                }
            };
        }

        state.currentPlaylistSongs = await (await fetch(`/api/songs?playlist_id=${playlist.id}`)).json();
        renderSongs(state.currentPlaylistSongs, 'playlist-songs-list', true);
        updatePlaylistMeta();
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

        container.querySelectorAll('.song-item.is-reorderable').forEach((item) => {
            item.addEventListener('dragstart', () => {
                draggedItem = item;
                item.classList.add('dragging');
            });

            item.addEventListener('dragend', async () => {
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
    async function loadDashboard() {
        const stats = await (await fetch('/api/dashboard')).json();
        const statsGrid = document.getElementById('stats-grid');
        if (statsGrid) {
            statsGrid.innerHTML = `
                <div class="stat-card stat-playlists"><div class="stat-icon"><i class="fas fa-list"></i></div><div><h4>${stats.total_playlists}</h4><p>Playlists</p></div></div>
                <div class="stat-card stat-songs"><div class="stat-icon"><i class="fas fa-music"></i></div><div><h4>${stats.total_songs}</h4><p>Songs</p></div></div>
                <div class="stat-card stat-time"><div class="stat-icon"><i class="fas fa-clock"></i></div><div><h4>${formatTime(stats.total_listened)}</h4><p>Time Listened</p></div></div>
                <div class="stat-card stat-storage"><div class="stat-icon"><i class="fas fa-hard-drive"></i></div><div><h4>${formatBytes(stats.storage_used)}</h4><p>Storage Used</p></div></div>
            `;
        }
        const recentSongs = await (await fetch('/api/songs?limit=5')).json();
        renderSongs(recentSongs.slice(0, 5), 'recent-songs-list', true);

        const topSongs = await (await fetch('/api/top-songs')).json();
        renderTopSongs(topSongs.slice(0, 5), 'top-songs-list');

        const topSongsDuration = await (await fetch('/api/top-songs-duration')).json();
        renderTopSongs(topSongsDuration.slice(0, 5), 'top-songs-duration-list');
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' viewBox=\'0 0 24 24\' fill=\'%23b3b3b3\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
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
                    if (confirm('Delete this song completely from all playlists and storage?')) {
                        await fetch(`/api/songs/${e.currentTarget.getAttribute('data-id')}`, {method: 'DELETE'});
                        showToast('Song deleted permanently');
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
                <img src="/static/album_art/${mediaUrlName(song.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' viewBox=\'0 0 24 24\' fill=\'%23b3b3b3\'><path d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/></svg>';">
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
    function playSong(songs, index) {
        flushListenLog();
        state.currentPlaylistSongs = songs;
        state.currentSongIndex = index;
        const song = songs[index];
        state.currentSongMeta = song;

        state.currentPlayingSongId = String(song.id);

        fetch(`/api/songs/${song.id}/play`, { method: 'POST' }).catch(e => console.error(e));

        el.audio.src = `/audio/${mediaUrlName(song.filename)}`;
        el.audio.play().catch(e => console.log("Autoplay prevented", e));

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
    }

    function togglePlay() {
        if (!el.audio.src) return;
        if (el.audio.paused) {
            el.audio.play();
            updatePlayPauseIcon(true);
        } else {
            el.audio.pause();
            updatePlayPauseIcon(false);
        }
    }

    function playNext(isFromSongEnded = true) {
        if (state.repeatMode === 2 && isFromSongEnded) {
            el.audio.currentTime = 0;
            el.audio.play();
            return;
        }

        if (state.playQueue.length > 0) {
            const nextSong = state.playQueue.shift();
            const idx = state.currentPlaylistSongs.findIndex(s => s.id === nextSong.id);
            if (idx !== -1) {
                playSong(state.currentPlaylistSongs, idx);
                return;
            }
        }

        if (state.currentPlaylistSongs.length === 0) return;

        let nextIndex = (state.currentSongIndex + 1) % state.currentPlaylistSongs.length;
        if (nextIndex === 0 && state.repeatMode === 0 && state.currentSongIndex === state.currentPlaylistSongs.length - 1) {
            el.audio.pause();
            updatePlayPauseIcon(false);
            return;
        }

        playSong(state.currentPlaylistSongs, nextIndex);
    }

    function playPrev() {
        if (state.currentPlaylistSongs.length === 0) return;
        if (el.audio.currentTime > 3) {
            el.audio.currentTime = 0;
            return;
        }
        playSong(state.currentPlaylistSongs, (state.currentSongIndex - 1 + state.currentPlaylistSongs.length) % state.currentPlaylistSongs.length);
    }

    // ==========================================
    // FREQUENCY FOCUS
    // ==========================================
    function formatCapsuleTime(seconds) {
        if (!seconds) return "0h 0m";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h === 0) return `${m}m`;
        return `${h}h ${m}m`;
    }

    async function loadFrequencyFocus(periodCode = 'month-current') {
        state.capsulePeriod = periodCode;
        const now = new Date();
        let period = 'month';
        let month = now.getMonth() + 1;
        let year = now.getFullYear();

        if (periodCode === 'month-prev') {
            month -= 1;
            if (month === 0) {
                month = 12;
                year -= 1;
            }
        } else if (periodCode === 'year-current') {
            period = 'year';
        } else if (periodCode === 'year-prev') {
            period = 'year';
            year -= 1;
        }

        try {
            const response = await fetch(`/api/recap?period=${period}&month=${month}&year=${year}`);
            if (!response.ok) throw new Error("Failed to fetch recap");
            const data = await response.json();
            state.capsuleData = data;
            renderFrequencyFocus(data);
        } catch (e) {
            console.error(e);
            showToast("Error loading Frequency Focus");
        }
    }

    function renderFrequencyFocus(data) {
        if (!data.stats.total_plays && !data.stats.total_seconds) {
            el.capsuleContent.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon"><i class="fas fa-headphones"></i></div>
                    <h4>No listening history</h4>
                    <p>Start playing some music to see your stats for ${escapeHtml(data.period.label)}!</p>
                </div>
            `;
            return;
        }

        const topPlayed = data.top_played || [];
        const topListened = data.top_listened || [];
        const heroSong = topListened[0] || topPlayed[0];
        const heroArt = heroSong?.album_art ? `/static/album_art/${mediaUrlName(heroSong.album_art)}` : '';
        const heroTitle = heroSong ? escapeHtml(heroSong.title) : 'No top track yet';
        const heroArtist = heroSong ? escapeHtml(heroSong.artist || 'Unknown') : 'Keep listening to build your recap';
        const topPlayedLabel = topPlayed[0] ? escapeHtml(topPlayed[0].title) : 'Not enough data';
        const focusLabel = data.period?.label || 'this period';

        const heroHTML = `
            <section class="capsule-hero">
                <div class="capsule-hero-copy">
                    <span class="capsule-kicker">${escapeHtml(focusLabel)}</span>
                    <h3>Your sound was led by <span>${heroTitle}</span></h3>
                    <p>${heroArtist}</p>
                    <div class="capsule-hero-metrics" aria-label="Frequency Focus highlights">
                        <div>
                            <strong>${formatCapsuleTime(data.stats.total_seconds)}</strong>
                            <span>listening time</span>
                        </div>
                        <div>
                            <strong>${data.stats.total_plays}</strong>
                            <span>plays</span>
                        </div>
                        <div>
                            <strong>${data.stats.unique_songs}</strong>
                            <span>songs</span>
                        </div>
                    </div>
                </div>
                <div class="capsule-hero-art" aria-hidden="true">
                    ${heroArt ? `<img src="${heroArt}" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                    <div class="capsule-hero-fallback" ${heroArt ? 'style="display:none;"' : ''}><i class="fas fa-wave-square"></i></div>
                </div>
            </section>
        `;

        const statsHTML = `
            <div class="stats-grid capsule-stats-grid">
                <div class="stat-card capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-clock"></i></div>
                    <div><h4>${formatCapsuleTime(data.stats.total_seconds)}</h4><p>Total Time</p></div>
                </div>
                <div class="stat-card stat-songs capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-music"></i></div>
                    <div><h4>${data.stats.unique_songs}</h4><p>Unique Songs</p></div>
                </div>
                <div class="stat-card stat-time capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-play"></i></div>
                    <div><h4>${data.stats.total_plays}</h4><p>Total Plays</p></div>
                </div>
                <div class="stat-card capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-star"></i></div>
                    <div><h4>${topPlayedLabel}</h4><p>Top Track</p></div>
                </div>
            </div>
        `;

        // ponytail: reuse .song-item layout from the rest of the app
        const renderSongList = (songs, valueKey, valueLabel, isTime) => {
            if (!songs || !songs.length) {
                return `
                    <div class="capsule-list-empty">
                        <i class="fas fa-compact-disc"></i>
                        <span>No tracks for this ranking yet.</span>
                    </div>
                `;
            }
            return songs.map((s, idx) => `
                <div class="song-item capsule-song-item">
                    <span class="rank-number ${idx < 3 ? 'top-3' : ''}">${idx + 1}</span>
                    <img src="/static/album_art/${mediaUrlName(s.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.style.background='#282828'; this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'48\\' height=\\'48\\' viewBox=\\'0 0 24 24\\' fill=\\'%23b3b3b3\\'><path d=\\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\\'/></svg>';">
                    <div class="song-info">
                        <div class="song-title">${escapeHtml(s.title)}</div>
                        <div class="song-artist">${escapeHtml(s.artist || 'Unknown')}</div>
                    </div>
                    <div class="song-stats">
                        <span class="song-stat-primary">${isTime ? formatCapsuleTime(s[valueKey]) : s[valueKey]}</span>
                        <span class="song-stat-secondary">${isTime ? 'listened' : valueLabel}</span>
                    </div>
                </div>
            `).join('');
        };

        // ponytail: monthly breakdown for year view
        let monthlyHTML = '';
        if (data.monthly_breakdown && data.monthly_breakdown.length) {
            const monthCards = data.monthly_breakdown.map(m => {
                const topSongLine = m.top_song
                    ? `<div class="month-top-song"><i class="fas fa-trophy"></i> ${escapeHtml(m.top_song.title)}</div>`
                    : '';
                return `
                    <div class="month-card">
                        <div class="month-card-header">${escapeHtml(m.month)}</div>
                        <div class="month-card-stats">
                            <span>${formatCapsuleTime(m.total_seconds)}</span>
                            <span>${m.total_plays} plays</span>
                        </div>
                        ${topSongLine}
                    </div>
                `;
            }).join('');
            monthlyHTML = `
                <section class="content-section capsule-section">
                    <div class="section-heading"><h3 class="section-title">Month by Month</h3><span class="section-note">Your year at a glance</span></div>
                    <div class="month-grid">${monthCards}</div>
                </section>
            `;
        }

        el.capsuleContent.innerHTML = `
            ${heroHTML}
            ${statsHTML}
            ${monthlyHTML}
            <div class="capsule-columns">
                <section class="content-section capsule-section">
                    <div class="section-heading"><h3 class="section-title">Most Played</h3><span class="section-note">By play count</span></div>
                    <div class="songs-list">
                        ${renderSongList(topPlayed, 'play_count', 'plays', false)}
                    </div>
                </section>
                <section class="content-section capsule-section">
                    <div class="section-heading"><h3 class="section-title">Most Listened</h3><span class="section-note">By listening time</span></div>
                    <div class="songs-list">
                        ${renderSongList(topListened, 'total_listened', '', true)}
                    </div>
                </section>
            </div>
        `;
    }

    if (el.capsuleBtn) {
        el.capsuleBtn.addEventListener('click', () => {
            showView('capsule');
        });
    }

    if (el.capsulePeriodSelect) {
        el.capsulePeriodSelect.addEventListener('change', (e) => {
            loadFrequencyFocus(e.target.value);
        });
    }

    // ==========================================
    // INITIALIZATION
    // ==========================================
    const dashboardTitle = document.querySelector('#dashboard-view .page-heading h2');
    if (dashboardTitle) dashboardTitle.innerText = getGreeting();

    loadPlaylists();
    loadDashboard();
    renderEmptyState(document.getElementById('search-results'), {
        icon: 'fa-search',
        title: 'Search your library',
        body: 'Type at least two characters to find a song or artist in this account.'
    });
});
