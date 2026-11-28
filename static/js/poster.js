// ==========================================
// SONG POSTER GENERATOR MODULE (Canvas 4:5)
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));
    const escapeHtml = window.escapeHtml || ((s) => String(s || ''));
    const loadCanvasImage = window.loadCanvasImage || ((src) => new Promise((resolve) => {
        if (!src) return resolve(null);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    }));
    const drawRoundRect = window.drawRoundRect || function(ctx, x, y, width, height, radius) {
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
    };

    const modal = document.getElementById('poster-modal');
    const openBtn = document.getElementById('open-poster-btn');
    const closeBtn = document.getElementById('poster-close-btn');
    const songListEl = document.getElementById('poster-song-list');
    const countEl = document.getElementById('poster-song-count');
    const selectFirstBtn = document.getElementById('poster-select-first-btn');
    const photoInput = document.getElementById('poster-photo-input');
    const photoClearBtn = document.getElementById('poster-photo-clear-btn');
    const canvas = document.getElementById('poster-canvas');
    const downloadBtn = document.getElementById('poster-download-btn');
    const copyBtn = document.getElementById('poster-copy-btn');

    const layoutSelect = document.getElementById('poster-layout');
    const effectSelect = document.getElementById('poster-effect');
    const cardScaleInput = document.getElementById('poster-card-scale');
    const cardTiltInput = document.getElementById('poster-card-tilt');
    const cardYawInput = document.getElementById('poster-card-yaw');
    const cardPitchInput = document.getElementById('poster-card-pitch');
    const photoScaleInput = document.getElementById('poster-photo-scale');
    const photoXInput = document.getElementById('poster-photo-x');
    const photoYInput = document.getElementById('poster-photo-y');
    const bgDimInput = document.getElementById('poster-bg-dim');
    const fgToggle = document.getElementById('poster-fg-toggle');
    const fgStatusEl = document.getElementById('poster-fg-status');
    const fgRetryBtn = document.getElementById('poster-fg-retry-btn');
    const cutoutLoadingEl = document.getElementById('poster-cutout-loading');
    const resetCardsBtn = document.getElementById('poster-reset-cards-btn');
    const cardInspector = document.getElementById('poster-card-inspector');
    const activeCardNameEl = document.getElementById('poster-active-card-name');
    const cardBehindToggle = document.getElementById('poster-card-behind-toggle');
    const activeCardScaleInput = document.getElementById('poster-active-card-scale');
    const activeCardAngleInput = document.getElementById('poster-active-card-angle');
    const activeCardYawInput = document.getElementById('poster-active-card-yaw');
    const activeCardPitchInput = document.getElementById('poster-active-card-pitch');
    const cardChipsEl = document.getElementById('poster-card-chips');
    const posterTabs = document.querySelectorAll('.poster-tab');
    const posterPanels = document.querySelectorAll('.poster-tab-panel');
    const themeStartInput = document.getElementById('poster-theme-start');
    const themeStartHex = document.getElementById('poster-theme-start-hex');
    const themeEndInput = document.getElementById('poster-theme-end');
    const themeEndHex = document.getElementById('poster-theme-end-hex');
    const cardTextInput = document.getElementById('poster-card-text');
    const cardOpacityInput = document.getElementById('poster-card-opacity');
    const themeSwatches = document.querySelectorAll('[data-poster-theme]');

    const POSTER_THEMES = {
        obsidian: ['#14161c', '#1c202b'],
        verde: ['#073b25', '#30d66b'],
        dusk: ['#182848', '#4b6cb7'],
        rose: ['#7f1d1d', '#fb7185'],
        amber: ['#78350f', '#fbbf24'],
        cyan: ['#164e63', '#38bdf8'],
    };
    let posterCardStart = '#14161c';
    let posterCardEnd = '#1c202b';
    let posterCardText = '#ffffff';

    function normalizeHex(val) {
        const cleaned = String(val || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(cleaned) ? cleaned.toUpperCase() : null;
    }

    function hexToRgba(hex, alpha) {
        const norm = normalizeHex(hex) || '#14161c';
        const r = parseInt(norm.slice(1, 3), 16);
        const g = parseInt(norm.slice(3, 5), 16);
        const b = parseInt(norm.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function syncThemeInputs(start, end) {
        posterCardStart = start;
        posterCardEnd = end;
        if (themeStartInput) themeStartInput.value = start;
        if (themeStartHex) themeStartHex.value = start.toUpperCase();
        if (themeEndInput) themeEndInput.value = end;
        if (themeEndHex) themeEndHex.value = end.toUpperCase();
    }

    themeSwatches.forEach((btn) => {
        btn.addEventListener('click', () => {
            const pair = POSTER_THEMES[btn.dataset.posterTheme];
            if (!pair) return;
            themeSwatches.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            syncThemeInputs(pair[0], pair[1]);
            renderPoster();
        });
    });

    [
        [themeStartInput, themeStartHex, (v) => { posterCardStart = v; }],
        [themeEndInput, themeEndHex, (v) => { posterCardEnd = v; }],
    ].forEach(([picker, hexInput, setter]) => {
        picker?.addEventListener('input', () => {
            themeSwatches.forEach((b) => b.classList.remove('active'));
            setter(picker.value);
            if (hexInput) hexInput.value = picker.value.toUpperCase();
            renderPoster();
        });
        hexInput?.addEventListener('input', () => {
            const valid = normalizeHex(hexInput.value);
            if (!valid) return;
            themeSwatches.forEach((b) => b.classList.remove('active'));
            setter(valid);
            if (picker) picker.value = valid;
            renderPoster();
        });
    });

    cardTextInput?.addEventListener('input', () => {
        posterCardText = normalizeHex(cardTextInput.value) || '#ffffff';
        renderPoster();
    });
    cardOpacityInput?.addEventListener('input', () => {
        updateSliderReadouts();
        renderPoster();
    });

    function setActivePosterTab(tabName) {
        posterTabs.forEach((btn) => {
            const isActive = btn.dataset.posterTab === tabName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });
        posterPanels.forEach((panel) => {
            panel.classList.toggle('active', panel.dataset.posterPanel === tabName);
        });
    }

    posterTabs.forEach((btn) => {
        btn.addEventListener('click', () => setActivePosterTab(btn.dataset.posterTab));
    });

    function syncSliderReadout(input) {
        if (!input || !input.id) return;
        const badge = document.querySelector(`[data-poster-val="${input.id}"]`);
        if (!badge) return;
        const v = Number(input.value);
        if (input.id.includes('scale') || input.id === 'poster-bg-dim') badge.textContent = `${v}%`;
        else if (input.id.includes('photo-x') || input.id.includes('photo-y')) badge.textContent = `${v}px`;
        else badge.textContent = `${v > 0 ? '+' : ''}${v}°`;
    }

    function renderCardChips() {
        if (!cardChipsEl) return;
        if (!renderedCards.length) {
            cardChipsEl.innerHTML = '';
            return;
        }
        cardChipsEl.innerHTML = renderedCards.map((c, idx) => {
            const isActive = c.songId === activeCardId;
            const title = (c.song.title || 'Lagu').slice(0, 14);
            return `<button type="button" class="poster-card-chip ${isActive ? 'active' : ''}" data-chip-id="${escapeHtml(c.songId)}">${idx + 1}. ${escapeHtml(title)}</button>`;
        }).join('');
        cardChipsEl.querySelectorAll('.poster-card-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                activeCardId = chip.dataset.chipId;
                updateCardInspector();
            });
        });
    }

    if (!modal || !canvas) return;

    const MAX_SONGS = 5;
    let selectedIds = new Set();
    let photoImage = null;
    let photoFile = null;
    let foregroundCanvas = null;
    let photoUrl = null;
    const coverCache = new Map();
    const cardOverrides = new Map(); // songId -> { x, y, scaleMul, angleOffset, behindSubject, startColor, endColor, textColor }

    function getCardColors(songId) {
        const override = cardOverrides.get(String(songId)) || {};
        return {
            startColor: override.startColor || posterCardStart,
            endColor: override.endColor || posterCardEnd,
            textColor: override.textColor || posterCardText,
        };
    }

    function resetCardColors(songId) {
        const override = cardOverrides.get(String(songId));
        if (!override) return;
        delete override.startColor;
        delete override.endColor;
        delete override.textColor;
        if (Object.keys(override).length === 0) cardOverrides.delete(String(songId));
    }

    let renderedCards = [];
    let activeCardId = null;
    let dragState = null;
    let renderToken = 0;

    function getCoverUrl(song) {
        if (!song) return '';
        if (song.album_art_url) return song.album_art_url;
        if (song.album_art) {
            const name = typeof window.mediaUrlName === 'function'
                ? window.mediaUrlName(song.album_art)
                : encodeURIComponent(song.album_art);
            return `/static/album_art/${name}`;
        }
        return '';
    }

    async function resizeImageForCutout(img) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const maxDim = 1080;
        const scale = Math.max(w, h) > maxDim ? maxDim / Math.max(w, h) : 1;
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        c.getContext('2d').drawImage(img, 0, 0, tw, th);
        return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
    }

    async function buildForegroundCutout(file, img) {
        if (!file && !img) return null;
        if (fgStatusEl) fgStatusEl.textContent = 'Memotong latar subjek...';
        if (cutoutLoadingEl) cutoutLoadingEl.style.display = 'flex';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        try {
            const resizedBlob = img ? await resizeImageForCutout(img) : null;
            const formData = new FormData();
            formData.append('image', resizedBlob || file, 'photo.jpg');
            const cookieMatch = document.cookie.match(/csrf_token=([^;]+)/);
            const csrfToken = (cookieMatch ? decodeURIComponent(cookieMatch[1]) : '')
                || document.querySelector('meta[name="csrf-token"]')?.content
                || '';
            const headers = {};
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

            const res = await fetch('/api/poster/cutout', {
                method: 'POST',
                headers,
                body: formData,
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const cutoutUrl = URL.createObjectURL(blob);
            const cutoutImg = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = reject;
                im.src = cutoutUrl;
            });
            const off = document.createElement('canvas');
            off.width = cutoutImg.naturalWidth || cutoutImg.width;
            off.height = cutoutImg.naturalHeight || cutoutImg.height;
            off.getContext('2d').drawImage(cutoutImg, 0, 0);
            URL.revokeObjectURL(cutoutUrl);
            if (fgStatusEl) fgStatusEl.textContent = 'Subjek di depan kartu aktif';
            if (fgRetryBtn) fgRetryBtn.style.display = 'none';
            return off;
        } catch (err) {
            console.warn('Segmentasi latar gagal:', err);
            const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'error');
            if (fgStatusEl) fgStatusEl.textContent = `Potong latar gagal (${reason})`;
            if (fgRetryBtn) fgRetryBtn.style.display = '';
            return null;
        } finally {
            clearTimeout(timer);
            if (cutoutLoadingEl) cutoutLoadingEl.style.display = 'none';
        }
    }

    async function getSongBitmap(song) {
        const url = getCoverUrl(song);
        if (!url) return null;
        if (coverCache.has(url)) return coverCache.get(url);
        const img = await loadCanvasImage(url);
        coverCache.set(url, img);
        return img;
    }

    function fitText(ctx, text, maxWidth) {
        const str = String(text || '');
        if (ctx.measureText(str).width <= maxWidth) return str;
        let out = str;
        while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
            out = out.slice(0, -1);
        }
        return `${out.trim()}...`;
    }

    function renderSongList() {
        if (!songListEl) return;
        const songs = Array.isArray(state.currentPlaylistSongs) ? state.currentPlaylistSongs : [];
        if (!songs.length) {
            songListEl.innerHTML = '<div class="poster-empty">Playlist kosong. Tambahkan lagu terlebih dahulu.</div>';
            if (countEl) countEl.textContent = '0 / 5';
            return;
        }
        songListEl.innerHTML = songs.map((song) => {
            const id = String(song.id);
            const checked = selectedIds.has(id);
            return `
                <label class="poster-song-item ${checked ? 'selected' : ''}">
                    <input type="checkbox" value="${escapeHtml(id)}" ${checked ? 'checked' : ''}>
                    <span class="poster-song-meta">
                        <strong>${escapeHtml(song.title || 'Unknown')}</strong>
                        <small>${escapeHtml(song.artist || 'Unknown')}</small>
                    </span>
                </label>
            `;
        }).join('');

        songListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const id = cb.value;
                if (cb.checked) {
                    if (selectedIds.size >= MAX_SONGS) {
                        cb.checked = false;
                        showToast(`Maksimal ${MAX_SONGS} lagu untuk satu poster`, 'error');
                        return;
                    }
                    selectedIds.add(id);
                } else {
                    selectedIds.delete(id);
                }
                cb.closest('.poster-song-item')?.classList.toggle('selected', cb.checked);
                if (countEl) countEl.textContent = `${selectedIds.size} / ${MAX_SONGS}`;
                renderPoster();
            });
        });
        if (countEl) countEl.textContent = `${selectedIds.size} / ${MAX_SONGS}`;
    }

    let cardBuffer = null;
    let pitchBuffer = null;

    function projectHorizontalStrips(srcCanvas, dstCtx, pitchDeg) {
        const rad = (pitchDeg * Math.PI) / 180;
        const cosP = Math.cos(rad);
        const sinP = Math.sin(rad);
        const totalW = srcCanvas.width;
        const totalH = srcCanvas.height;
        const focal = Math.max(totalH * 2.1, 600);
        const strips = 36;
        const srcStripH = totalH / strips;

        for (let i = 0; i < strips; i++) {
            const v0 = (i / strips - 0.5) * totalH;
            const v1 = ((i + 1) / strips - 0.5) * totalH;
            const vMid = (v0 + v1) * 0.5;
            const z0 = v0 * sinP;
            const z1 = v1 * sinP;
            const zMid = vMid * sinP;
            const s0 = focal / Math.max(120, focal + z0);
            const s1 = focal / Math.max(120, focal + z1);
            const sMid = focal / Math.max(120, focal + zMid);

            const dy0 = v0 * cosP * s0;
            const dy1 = v1 * cosP * s1;
            const dh = Math.max(0.8, Math.abs(dy1 - dy0) + 0.6);
            const dw = totalW * sMid;
            const dx = -dw / 2;
            const dy = Math.min(dy0, dy1);

            dstCtx.drawImage(
                srcCanvas,
                0,
                i * srcStripH,
                totalW,
                srcStripH,
                dx,
                dy,
                dw,
                dh
            );
        }
    }

    function projectVerticalStrips(srcCanvas, dstCtx, yawDeg) {
        const rad = (yawDeg * Math.PI) / 180;
        const cosY = Math.cos(rad);
        const sinY = Math.sin(rad);
        const totalW = srcCanvas.width;
        const totalH = srcCanvas.height;
        const focal = Math.max(totalW * 2.1, 500);
        const strips = 36;
        const srcStripW = totalW / strips;

        for (let i = 0; i < strips; i++) {
            const u0 = (i / strips - 0.5) * totalW;
            const u1 = ((i + 1) / strips - 0.5) * totalW;
            const uMid = (u0 + u1) * 0.5;
            const z0 = u0 * sinY;
            const z1 = u1 * sinY;
            const zMid = uMid * sinY;
            const s0 = focal / Math.max(120, focal + z0);
            const s1 = focal / Math.max(120, focal + z1);
            const sMid = focal / Math.max(120, focal + zMid);

            const dx0 = u0 * cosY * s0;
            const dx1 = u1 * cosY * s1;
            const dw = Math.max(0.8, Math.abs(dx1 - dx0) + 0.6);
            const dh = totalH * sMid;
            const dx = Math.min(dx0, dx1);
            const dy = -dh / 2;

            dstCtx.drawImage(
                srcCanvas,
                i * srcStripW,
                0,
                srcStripW,
                totalH,
                dx,
                dy,
                dw,
                dh
            );
        }
    }

    function paintCardContent(ctx, song, coverImg, w, h, colors) {
        const radius = Math.round(w * 0.085);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 32;
        ctx.shadowOffsetY = 14;
        drawRoundRect(ctx, 0, 0, w, h, radius);
        const cardAlpha = Math.max(0.3, Math.min(1, Number(cardOpacityInput?.value || 84) / 100));
        const cardGrad = ctx.createLinearGradient(0, 0, w, h);
        cardGrad.addColorStop(0, hexToRgba(colors.startColor, cardAlpha));
        cardGrad.addColorStop(1, hexToRgba(colors.endColor, cardAlpha));
        ctx.fillStyle = cardGrad;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        // Glass border
        const borderGrad = ctx.createLinearGradient(0, 0, w, h);
        borderGrad.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
        borderGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.10)');
        borderGrad.addColorStop(1, 'rgba(255, 255, 255, 0.30)');
        ctx.strokeStyle = borderGrad;
        ctx.lineWidth = 2;
        drawRoundRect(ctx, 0, 0, w, h, radius);
        ctx.stroke();

        // Cover art
        const pad = Math.round(w * 0.085);
        const artSize = w - pad * 2;
        const artRadius = Math.round(artSize * 0.08);
        ctx.save();
        drawRoundRect(ctx, pad, pad, artSize, artSize, artRadius);
        ctx.clip();
        if (coverImg) {
            const minSide = Math.min(coverImg.naturalWidth || coverImg.width, coverImg.naturalHeight || coverImg.height);
            const sx = ((coverImg.naturalWidth || coverImg.width) - minSide) / 2;
            const sy = ((coverImg.naturalHeight || coverImg.height) - minSide) / 2;
            ctx.drawImage(coverImg, sx, sy, minSide, minSide, pad, pad, artSize, artSize);
        } else {
            const fallbackGrad = ctx.createLinearGradient(pad, pad, pad + artSize, pad + artSize);
            fallbackGrad.addColorStop(0, '#1f2937');
            fallbackGrad.addColorStop(1, '#111827');
            ctx.fillStyle = fallbackGrad;
            ctx.fillRect(pad, pad, artSize, artSize);
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = `700 ${Math.round(artSize * 0.2)}px Space Grotesk, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('psr.fm', pad + artSize / 2, pad + artSize / 2);
        }
        ctx.restore();

        // Brand tag
        let cursorY = pad + artSize + Math.round(w * 0.06);
        ctx.fillStyle = hexToRgba(colors.textColor, 0.65);
        ctx.font = `600 ${Math.round(w * 0.042)}px Manrope, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('~ psr.fm', pad, cursorY);

        // Title + heart
        cursorY += Math.round(w * 0.058);
        ctx.fillStyle = colors.textColor;
        ctx.font = `700 ${Math.round(w * 0.068)}px Manrope, sans-serif`;
        ctx.fillText(fitText(ctx, song.title || 'Unknown', artSize - 26), pad, cursorY);
        ctx.fillStyle = hexToRgba(colors.textColor, 0.85);
        ctx.font = `600 ${Math.round(w * 0.065)}px sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText('♡', pad + artSize, cursorY);

        // Artist
        cursorY += Math.round(w * 0.082);
        ctx.textAlign = 'left';
        ctx.fillStyle = hexToRgba(colors.textColor, 0.72);
        ctx.font = `500 ${Math.round(w * 0.052)}px Manrope, sans-serif`;
        ctx.fillText(fitText(ctx, song.artist || 'Unknown', artSize), pad, cursorY);

        // Progress bar
        cursorY += Math.round(w * 0.088);
        ctx.fillStyle = hexToRgba(colors.textColor, 0.22);
        drawRoundRect(ctx, pad, cursorY, artSize, 4, 2);
        ctx.fill();
        ctx.fillStyle = colors.textColor;
        drawRoundRect(ctx, pad, cursorY, Math.round(artSize * 0.58), 4, 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pad + Math.round(artSize * 0.58), cursorY + 2, 5, 0, Math.PI * 2);
        ctx.fill();

        // Controls row
        cursorY += Math.round(w * 0.075);
        ctx.fillStyle = colors.textColor;
        ctx.font = `700 ${Math.round(w * 0.07)}px sans-serif`;
        ctx.textAlign = 'center';
        const cx = w / 2;
        ctx.fillText('⏮', cx - w * 0.16, cursorY);
        ctx.fillText('⏸', cx, cursorY);
        ctx.fillText('⏭', cx + w * 0.16, cursorY);
    }

    function drawMiniPlayerCard(ctx, song, coverImg, x, y, w, h, angleDeg, yawDeg = 0, pitchDeg = 0, colors) {
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((angleDeg * Math.PI) / 180);

        const hasYaw = Math.abs(yawDeg) >= 0.5;
        const hasPitch = Math.abs(pitchDeg) >= 0.5;
        if (!hasYaw && !hasPitch) {
            ctx.translate(-w / 2, -h / 2);
            paintCardContent(ctx, song, coverImg, w, h, colors);
            ctx.restore();
            return;
        }

        const margin = 44;
        if (!cardBuffer) cardBuffer = document.createElement('canvas');
        cardBuffer.width = w + margin * 2;
        cardBuffer.height = h + margin * 2;
        const bctx = cardBuffer.getContext('2d');
        bctx.clearRect(0, 0, cardBuffer.width, cardBuffer.height);
        bctx.save();
        bctx.translate(margin, margin);
        paintCardContent(bctx, song, coverImg, w, h, colors);
        bctx.restore();

        let sourceForYaw = cardBuffer;
        if (hasPitch) {
            if (!pitchBuffer) pitchBuffer = document.createElement('canvas');
            pitchBuffer.width = cardBuffer.width;
            pitchBuffer.height = cardBuffer.height;
            const pctx = pitchBuffer.getContext('2d');
            pctx.clearRect(0, 0, pitchBuffer.width, pitchBuffer.height);
            pctx.save();
            pctx.translate(pitchBuffer.width / 2, pitchBuffer.height / 2);
            projectHorizontalStrips(cardBuffer, pctx, pitchDeg);
            pctx.restore();
            sourceForYaw = pitchBuffer;
        }

        if (hasYaw) {
            projectVerticalStrips(sourceForYaw, ctx, yawDeg);
        } else {
            ctx.drawImage(sourceForYaw, -sourceForYaw.width / 2, -sourceForYaw.height / 2);
        }

        ctx.restore();
    }

    function getCardPlacements(count, layout, W, H, scalePct, baseTilt, baseYaw = 0, basePitch = 0) {
        const s = scalePct / 100;
        const cardW = Math.round(350 * s);
        const cardH = Math.round(cardW * 1.42);
        const slots = [];

        // Orbit (4-5 cards framing center photo subject with subtle 3D side tilt)
        const orbitCoords = [
            { x: 28, y: 64, a: -6, yaw: 16, pitch: -8 },
            { x: W - cardW - 28, y: 54, a: 6, yaw: -16, pitch: -8 },
            { x: 24, y: H - cardH - 96, a: -5, yaw: 14, pitch: 8 },
            { x: W - cardW - 24, y: H - cardH - 108, a: 5, yaw: -14, pitch: 8 },
            { x: (W - cardW) / 2, y: 40, a: 0, yaw: 0, pitch: -10 },
        ];
        for (let i = 0; i < count; i++) {
            const p = orbitCoords[i % orbitCoords.length];
            slots.push({
                x: p.x,
                y: p.y,
                w: cardW,
                h: cardH,
                angle: p.a + baseTilt,
                yaw: (layout === 'custom' ? 0 : p.yaw) + baseYaw,
                pitch: (layout === 'custom' ? 0 : p.pitch) + basePitch,
            });
        }
        return slots;
    }

    async function renderPoster() {
        const token = ++renderToken;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Dark gradient base
        const bgGrad = ctx.createLinearGradient(0, 0, W, H);
        bgGrad.addColorStop(0, '#0d0f14');
        bgGrad.addColorStop(1, '#151821');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // Effect filter
        const effect = effectSelect?.value || 'clean';
        const filterMap = {
            clean: 'none',
            cinema: 'contrast(1.12) saturate(1.15)',
            film: 'sepia(0.22) contrast(1.06) brightness(0.95)',
            neon: 'saturate(1.45) contrast(1.15)',
        };
        if (photoImage) {
            ctx.save();
            ctx.filter = filterMap[effect] || 'none';
            const scale = (Number(photoScaleInput?.value || 100) / 100);
            const offsetX = Number(photoXInput?.value || 0);
            const offsetY = Number(photoYInput?.value || 0);
            const imgW = photoImage.naturalWidth || photoImage.width;
            const imgH = photoImage.naturalHeight || photoImage.height;
            const coverRatio = Math.max(W / imgW, H / imgH) * scale;
            const drawW = imgW * coverRatio;
            const drawH = imgH * coverRatio;
            const dx = (W - drawW) / 2 + offsetX;
            const dy = (H - drawH) / 2 + offsetY;
            ctx.drawImage(photoImage, dx, dy, drawW, drawH);
            ctx.restore();
        }

        // Background dim overlay
        const dimAlpha = Math.max(0, Math.min(0.85, Number(bgDimInput?.value || 25) / 100));
        if (dimAlpha > 0) {
            ctx.fillStyle = `rgba(0, 0, 0, ${dimAlpha})`;
            ctx.fillRect(0, 0, W, H);
        }

        const songs = (Array.isArray(state.currentPlaylistSongs) ? state.currentPlaylistSongs : [])
            .filter((s) => selectedIds.has(String(s.id)))
            .slice(0, MAX_SONGS);

        const bitmaps = await Promise.all(songs.map(getSongBitmap));
        if (token !== renderToken) return;

        const slots = getCardPlacements(
            songs.length,
            layoutSelect?.value || 'orbit',
            W,
            H,
            Number(cardScaleInput?.value || 92),
            Number(cardTiltInput?.value || 0),
            Number(cardYawInput?.value || 0),
            Number(cardPitchInput?.value || 0)
        );
        const cardsToDraw = songs.map((song, idx) => {
            const sid = String(song.id);
            const base = slots[idx];
            if (!base) return null;
            const ov = cardOverrides.get(sid) || {};
            const scaleMul = typeof ov.scaleMul === 'number' ? ov.scaleMul : 1;
            const w = Math.round(base.w * scaleMul);
            const h = Math.round(base.h * scaleMul);
            const x = typeof ov.x === 'number' ? ov.x : base.x;
            const y = typeof ov.y === 'number' ? ov.y : base.y;
            const angle = base.angle + (typeof ov.angleOffset === 'number' ? ov.angleOffset : 0);
            const yaw = (typeof ov.yawOffset === 'number' ? ov.yawOffset : 0) + base.yaw;
            const pitch = (typeof ov.pitchOffset === 'number' ? ov.pitchOffset : 0) + base.pitch;
            const behindSubject = ov.behindSubject !== undefined ? ov.behindSubject : true;
            return { songId: sid, song, bitmap: bitmaps[idx], x, y, w, h, angle, yaw, pitch, behindSubject, colors: getCardColors(sid) };
        }).filter(Boolean);

        renderedCards = cardsToDraw;
        renderCardChips();
        if (activeCardId && !renderedCards.some((c) => c.songId === activeCardId)) {
            activeCardId = null;
            updateCardInspector();
        }

        // Layer 2: Cards behind subject
        cardsToDraw.filter((c) => c.behindSubject).forEach((c) => {
            drawMiniPlayerCard(ctx, c.song, c.bitmap, c.x, c.y, c.w, c.h, c.angle, c.yaw, c.pitch, c.colors);
        });

        // Layer 3: Foreground subject cutout overlapping behind-cards
        if (foregroundCanvas && (!fgToggle || fgToggle.checked)) {
            ctx.save();
            ctx.filter = filterMap[effect] || 'none';
            const scale = (Number(photoScaleInput?.value || 100) / 100);
            const offsetX = Number(photoXInput?.value || 0);
            const offsetY = Number(photoYInput?.value || 0);
            const imgW = foregroundCanvas.width;
            const imgH = foregroundCanvas.height;
            const coverRatio = Math.max(W / imgW, H / imgH) * scale;
            const drawW = imgW * coverRatio;
            const drawH = imgH * coverRatio;
            const dx = (W - drawW) / 2 + offsetX;
            const dy = (H - drawH) / 2 + offsetY;
            ctx.drawImage(foregroundCanvas, dx, dy, drawW, drawH);
            ctx.restore();
        }

        // Layer 4: Cards in front of subject
        cardsToDraw.filter((c) => !c.behindSubject).forEach((c) => {
            drawMiniPlayerCard(ctx, c.song, c.bitmap, c.x, c.y, c.w, c.h, c.angle, c.yaw, c.pitch, c.colors);
        });

        // Bottom watermark pill
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.52)';
        drawRoundRect(ctx, W / 2 - 80, H - 64, 160, 36, 18);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = '700 18px Space Grotesk, Manrope, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('psr.fm', W / 2, H - 46);
        ctx.restore();
    }

    function updateCardInspector() {
        renderCardChips();
        if (!cardInspector) return;
        const card = renderedCards.find((c) => c.songId === activeCardId);
        if (!card) {
            cardInspector.style.display = 'none';
            return;
        }
        cardInspector.style.display = 'flex';
        const ov = cardOverrides.get(card.songId) || {};
        if (activeCardNameEl) activeCardNameEl.textContent = card.song.title || 'Kartu dipilih';
        if (cardBehindToggle) cardBehindToggle.checked = ov.behindSubject !== undefined ? ov.behindSubject : true;
        if (activeCardScaleInput) {
            activeCardScaleInput.value = Math.round((typeof ov.scaleMul === 'number' ? ov.scaleMul : 1) * 100);
            syncSliderReadout(activeCardScaleInput);
        }
        if (activeCardAngleInput) {
            activeCardAngleInput.value = Math.round(typeof ov.angleOffset === 'number' ? ov.angleOffset : 0);
            syncSliderReadout(activeCardAngleInput);
        }
        if (activeCardYawInput) {
            activeCardYawInput.value = Math.round(typeof ov.yawOffset === 'number' ? ov.yawOffset : 0);
            syncSliderReadout(activeCardYawInput);
        }
        if (activeCardPitchInput) {
            activeCardPitchInput.value = Math.round(typeof ov.pitchOffset === 'number' ? ov.pitchOffset : 0);
            syncSliderReadout(activeCardPitchInput);
        }
    }

    function getCanvasPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: ((e.clientX - rect.left) / rect.width) * canvas.width,
            y: ((e.clientY - rect.top) / rect.height) * canvas.height,
        };
    }

    function hitTestCard(px, py) {
        for (let i = renderedCards.length - 1; i >= 0; i--) {
            const c = renderedCards[i];
            const cx = c.x + c.w / 2;
            const cy = c.y + c.h / 2;
            const rad = (-c.angle * Math.PI) / 180;
            const dx = px - cx;
            const dy = py - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
            if (Math.abs(lx) <= c.w / 2 && Math.abs(ly) <= c.h / 2) {
                return c;
            }
        }
        return null;
    }

    canvas.addEventListener('pointerdown', (e) => {
        const pt = getCanvasPoint(e);
        const hit = hitTestCard(pt.x, pt.y);
        if (!hit) return;
        activeCardId = hit.songId;
        updateCardInspector();
        dragState = {
            songId: hit.songId,
            startX: pt.x,
            startY: pt.y,
            origX: hit.x,
            origY: hit.y,
        };
        canvas.classList.add('dragging');
        if (typeof canvas.setPointerCapture === 'function') {
            try { canvas.setPointerCapture(e.pointerId); } catch {}
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const pt = getCanvasPoint(e);
        const ov = cardOverrides.get(dragState.songId) || {};
        ov.x = dragState.origX + (pt.x - dragState.startX);
        ov.y = dragState.origY + (pt.y - dragState.startY);
        cardOverrides.set(dragState.songId, ov);
        if (layoutSelect && layoutSelect.value !== 'custom') {
            layoutSelect.value = 'custom';
        }
        renderPoster();
    });

    const endDrag = () => {
        if (!dragState) return;
        dragState = null;
        canvas.classList.remove('dragging');
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    cardBehindToggle?.addEventListener('change', () => {
        if (!activeCardId) return;
        const ov = cardOverrides.get(activeCardId) || {};
        ov.behindSubject = cardBehindToggle.checked;
        cardOverrides.set(activeCardId, ov);
        renderPoster();
    });

    activeCardScaleInput?.addEventListener('input', () => {
        if (!activeCardId) return;
        const ov = cardOverrides.get(activeCardId) || {};
        ov.scaleMul = Number(activeCardScaleInput.value) / 100;
        cardOverrides.set(activeCardId, ov);
        renderPoster();
    });

    activeCardAngleInput?.addEventListener('input', () => {
        if (!activeCardId) return;
        const ov = cardOverrides.get(activeCardId) || {};
        ov.angleOffset = Number(activeCardAngleInput.value);
        cardOverrides.set(activeCardId, ov);
        renderPoster();
    });

    activeCardYawInput?.addEventListener('input', () => {
        if (!activeCardId) return;
        const ov = cardOverrides.get(activeCardId) || {};
        ov.yawOffset = Number(activeCardYawInput.value);
        cardOverrides.set(activeCardId, ov);
        renderPoster();
    });

    activeCardPitchInput?.addEventListener('input', () => {
        if (!activeCardId) return;
        const ov = cardOverrides.get(activeCardId) || {};
        ov.pitchOffset = Number(activeCardPitchInput.value);
        cardOverrides.set(activeCardId, ov);
        renderPoster();
    });

    resetCardsBtn?.addEventListener('click', () => {
        cardOverrides.clear();
        activeCardId = null;
        if (layoutSelect) layoutSelect.value = 'orbit';
        updateCardInspector();
        renderPoster();
        showToast('Posisi kartu direset', 'success');
    });

    layoutSelect?.addEventListener('change', () => {
        if (layoutSelect.value === 'orbit') {
            cardOverrides.forEach((ov) => {
                delete ov.x;
                delete ov.y;
            });
        }
    });

    function openPosterModal() {
        const songs = Array.isArray(state.currentPlaylistSongs) ? state.currentPlaylistSongs : [];
        if (selectedIds.size === 0 && songs.length) {
            songs.slice(0, Math.min(4, songs.length)).forEach((s) => selectedIds.add(String(s.id)));
        }
        renderSongList();
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        renderPoster();
    }

    function closePosterModal() {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }

    openBtn?.addEventListener('click', openPosterModal);
    closeBtn?.addEventListener('click', closePosterModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closePosterModal();
    });

    selectFirstBtn?.addEventListener('click', () => {
        const songs = Array.isArray(state.currentPlaylistSongs) ? state.currentPlaylistSongs : [];
        selectedIds = new Set(songs.slice(0, MAX_SONGS).map((s) => String(s.id)));
        renderSongList();
        renderPoster();
    });

    photoInput?.addEventListener('change', () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        photoFile = file;
        if (fgRetryBtn) fgRetryBtn.style.display = 'none';
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        photoUrl = URL.createObjectURL(file);
        foregroundCanvas = null;
        const img = new Image();
        img.onload = async () => {
            photoImage = img;
            await renderPoster();
            const cutout = await buildForegroundCutout(file, img);
            if (photoImage === img) {
                foregroundCanvas = cutout;
                renderPoster();
            }
        };
        img.onerror = () => showToast('Gagal memuat foto', 'error');
        img.src = photoUrl;
    });

    fgRetryBtn?.addEventListener('click', async () => {
        if (!photoImage && !photoFile) return;
        const targetImg = photoImage;
        const cutout = await buildForegroundCutout(photoFile, targetImg);
        if (photoImage === targetImg) {
            foregroundCanvas = cutout;
            renderPoster();
        }
    });

    photoClearBtn?.addEventListener('click', () => {
        photoImage = null;
        photoFile = null;
        foregroundCanvas = null;
        if (fgRetryBtn) fgRetryBtn.style.display = 'none';
        if (fgStatusEl) fgStatusEl.textContent = 'Subjek di depan kartu (potong latar otomatis)';
        if (photoUrl) {
            URL.revokeObjectURL(photoUrl);
            photoUrl = null;
        }
        if (photoInput) photoInput.value = '';
        renderPoster();
    });

    [layoutSelect, effectSelect, cardScaleInput, cardTiltInput, cardYawInput, cardPitchInput, photoScaleInput, photoXInput, photoYInput, bgDimInput, fgToggle].forEach((ctrl) => {
        syncSliderReadout(ctrl);
        ctrl?.addEventListener('input', () => {
            syncSliderReadout(ctrl);
            renderPoster();
        });
        ctrl?.addEventListener('change', () => {
            syncSliderReadout(ctrl);
            renderPoster();
        });
    });
    [activeCardScaleInput, activeCardAngleInput, activeCardYawInput, activeCardPitchInput].forEach((ctrl) => {
        ctrl?.addEventListener('input', () => syncSliderReadout(ctrl));
    });

    downloadBtn?.addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = `psr-fm-poster-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        showToast('Poster berhasil diunduh', 'success');
    });

    copyBtn?.addEventListener('click', async () => {
        if (!navigator.clipboard || !window.ClipboardItem) {
            showToast('Browser tidak mendukung copy gambar langsung', 'error');
            return;
        }
        try {
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showToast('Poster disalin ke clipboard', 'success');
        } catch {
            showToast('Gagal menyalin poster', 'error');
        }
    });
});
})();
