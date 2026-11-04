// ==========================================
// FREQUENCY FOCUS & SHARE CARD RECAP MODULE
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const el = window.el || {};
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));
    const showView = window.showView || (() => {});
    const escapeHtml = window.escapeHtml || ((s) => s);
    const formatTime = window.formatTime || ((s) => s);
    const mediaUrlName = window.mediaUrlName || ((s) => s);
    const drawRoundRect = window.drawRoundRect;
    const loadCanvasImage = window.loadCanvasImage;
    const drawRoundedImage = window.drawRoundedImage;
    const drawCoverFallback = window.drawCoverFallback;
    const drawStar = window.drawStar;
    const fitCanvasText = window.fitCanvasText;
    const wrapCanvasLines = window.wrapCanvasLines;
    const debounce = window.debounce || ((fn, delay) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; });
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
            const response = await fetch(`/api/recap?period=${period}&month=${month}&year=${year}&tz_offset=${now.getTimezoneOffset()}`);
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
        const topTrack = topPlayed[0];
        const topTrackLabel = topTrack ? escapeHtml(topTrack.title) : 'Not enough data';
        const topTrackArt = topTrack?.album_art ? `/static/album_art/${mediaUrlName(topTrack.album_art)}` : '';
        const focusLabel = data.period?.label || 'this period';

        // Listening vibe
        const peakHourVal = data.peak_hour?.hour;
        const vibe = getListeningVibe(peakHourVal);

        const heroHTML = `
            <section class="capsule-hero">
                <div class="capsule-hero-copy">
                    <span class="capsule-kicker">${escapeHtml(focusLabel)}</span>
                    <h3>Your sound was led by <span>${heroTitle}</span></h3>
                    <p>${heroArtist}</p>
                    <div class="capsule-vibe-badge"><i class="${escapeHtml(vibe.faIcon || 'fas fa-wave-square')}"></i> ${escapeHtml(vibe.tag)}</div>
                    <div class="capsule-hero-metrics" aria-label="Frequency Focus highlights">
                        <div>
                            <strong>${formatCapsuleTime(heroSong ? (heroSong.total_listened || 0) : 0)}</strong>
                            <span>listening time</span>
                        </div>
                        <div>
                            <strong>${heroSong ? (heroSong.play_count || 0) : 0}</strong>
                            <span>plays</span>
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
                    <div><p>Total Time</p><h4>${formatCapsuleTime(data.stats.total_seconds)}</h4></div>
                </div>
                <div class="stat-card stat-songs capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-music"></i></div>
                    <div><p>Unique Songs</p><h4>${data.stats.unique_songs}</h4></div>
                </div>
                <div class="stat-card stat-time capsule-stat-card">
                    <div class="stat-icon"><i class="fas fa-play"></i></div>
                    <div><p>Total Plays</p><h4>${data.stats.total_plays}</h4></div>
                </div>
                <div class="stat-card capsule-stat-card stat-top-track">
                    <div class="stat-icon stat-top-track-art">
                        ${topTrackArt ? `<img src="${topTrackArt}" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                        <div class="stat-top-track-fallback" ${topTrackArt ? 'style="display:none;"' : ''}><i class="fas fa-star"></i></div>
                    </div>
                    <div><p>Top Track</p><h4 title="${topTrackLabel}">${topTrackLabel}</h4></div>
                </div>
            </div>
        `;

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
                    <img src="/static/album_art/${mediaUrlName(s.album_art)}" class="song-art" alt="" loading="lazy" onerror="this.onerror=null; this.style.background='#282828'; this.src='/static/icon-192.png';">
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
    // FREQUENCY FOCUS SHARE CARD GENERATOR (PREMIUM WRAPPED RECAP)
    // ==========================================

    const capsuleShareThemes = {
        emerald:  ['#042f2e', '#065f46', '#059669'],
        sapphire: ['#0f172a', '#1e3a8a', '#2563eb'],
        violet:   ['#1e1035', '#4c1d95', '#7c3aed'],
        sunset:   ['#3b0718', '#881337', '#e11d48'],
        amber:    ['#291505', '#78350f', '#d97706'],
        obsidian: ['#09090b', '#18181b', '#27272a']
    };

    function getListeningVibe(hour) {
        if (hour === null || hour === undefined || isNaN(hour)) {
            return { tag: 'BALANCED GROOVER', subtitle: 'Steady frequency all day', peakHour: 'All Day', faIcon: 'fas fa-headphones' };
        }
        const h = Number(hour);
        const formatH = (val) => {
            const period = val >= 12 ? 'PM' : 'AM';
            const displayH = val % 12 === 0 ? 12 : val % 12;
            return `${displayH} ${period}`;
        };
        const hourLabel = formatH(h);
        if (h >= 5 && h <= 10) {
            return { tag: 'MORNING EXPLORER', subtitle: `Peak groove at ${hourLabel}`, peakHour: hourLabel, faIcon: 'fas fa-sun' };
        } else if (h >= 11 && h <= 15) {
            return { tag: 'MIDDAY GROOVER', subtitle: `Peak groove at ${hourLabel}`, peakHour: hourLabel, faIcon: 'fas fa-cloud-sun' };
        } else if (h >= 16 && h <= 20) {
            return { tag: 'SUNSET LISTENER', subtitle: `Peak groove at ${hourLabel}`, peakHour: hourLabel, faIcon: 'fas fa-sunset' };
        } else {
            return { tag: 'NIGHT OWL', subtitle: `Peak groove at ${hourLabel}`, peakHour: hourLabel, faIcon: 'fas fa-moon' };
        }
    }
    function drawVinylCoverFallback(ctx, x, y, size, radius) {
        ctx.save();
        drawRoundRect(ctx, x, y, size, size, radius);
        ctx.clip();
        const grad = ctx.createLinearGradient(x, y, x + size, y + size);
        grad.addColorStop(0, '#1c1917');
        grad.addColorStop(1, '#292524');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, size, size);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1.5;
        const center = size / 2;
        ctx.beginPath();
        ctx.arc(x + center, y + center, size * 0.38, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + center, y + center, size * 0.22, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.beginPath();
        ctx.arc(x + center, y + center, size * 0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawSoundBars(ctx, cx, cy, width, height, count, color) {
        ctx.save();
        ctx.fillStyle = color;
        const barWidth = Math.max(3, (width / count) * 0.55);
        const gap = (width - barWidth * count) / Math.max(1, count - 1);
        const startX = cx - width / 2;
        const heights = [0.35, 0.65, 0.95, 0.5, 0.8, 1.0, 0.4, 0.85, 0.6, 0.9, 0.75, 0.45, 0.95, 0.6, 0.85, 0.35, 0.7, 1.0, 0.55, 0.8, 0.4, 0.9, 0.65];
        for (let i = 0; i < count; i++) {
            const ratio = heights[i % heights.length];
            const barH = Math.max(6, height * ratio);
            const bx = startX + i * (barWidth + gap);
            const by = cy - barH / 2;
            drawRoundRect(ctx, bx, by, barWidth, barH, barWidth / 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawEqualizerWave(ctx, x, y, width, height, count = 18, color = 'rgba(255, 255, 255, 0.85)') {
        ctx.save();
        ctx.fillStyle = color;
        const barW = Math.max(3, (width / count) * 0.5);
        const gap = (width - barW * count) / (count - 1);
        const pattern = [0.3, 0.55, 0.9, 0.7, 1.0, 0.8, 0.95, 0.45, 0.75, 0.85, 0.6, 0.35, 0.9, 0.65, 0.8, 0.5, 0.7, 0.4];
        for (let i = 0; i < count; i++) {
            const r = pattern[i % pattern.length];
            const bh = Math.max(6, height * r);
            const bx = x + i * (barW + gap);
            const by = y + height - bh;
            drawRoundRect(ctx, bx, by, barW, bh, barW / 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawVinylAcousticTexture(ctx, cx, cy, maxRadius) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.032)';
        ctx.lineWidth = 1.2;
        const rings = 8;
        for (let i = 1; i <= rings; i++) {
            ctx.beginPath();
            ctx.arc(cx, cy, (maxRadius / rings) * i, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    async function renderShareCapsuleCanvas() {
        const canvas = el.shareCapsuleCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const data = state.capsuleData;
        if (!data) return;

        try {
            if (document.fonts?.ready) await document.fonts.ready;
        } catch (_) {}

        const isStory = state.capsuleShareFormat === 'story';
        const width = 1080;
        const height = isStory ? 1920 : 1080;
        canvas.width = width;
        canvas.height = height;
        canvas.classList.toggle('format-square', !isStory);

        const colors = state.capsuleShareTheme === 'custom'
            ? [state.capsuleShareCustomColors[0], state.capsuleShareCustomColors[0], state.capsuleShareCustomColors[1]]
            : (capsuleShareThemes[state.capsuleShareTheme] || capsuleShareThemes.emerald);

        // Rich 3-stop background gradient
        const bgGradient = ctx.createLinearGradient(0, 0, width * 0.35, height);
        bgGradient.addColorStop(0, colors[0]);
        bgGradient.addColorStop(0.52, colors[1]);
        bgGradient.addColorStop(1, colors[2] || colors[1]);
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, height);

        // Soft radial ambient light for depth
        ctx.save();
        const orb1 = ctx.createRadialGradient(width * 0.82, height * 0.16, 0, width * 0.82, height * 0.16, 500);
        orb1.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
        orb1.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = orb1;
        ctx.fillRect(0, 0, width, height);

        const vignette = ctx.createRadialGradient(width / 2, height / 2, width * 0.35, width / 2, height / 2, width * 0.85);
        vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, width, height);

        // Vinyl acoustic concentric groove texture in the background
        drawVinylAcousticTexture(ctx, width * 0.85, height * 0.22, 520);
        ctx.restore();

        const periodLabel = (data.period?.label || 'Listening Journey').toUpperCase();
        const tagline = state.capsuleShareTagline || 'My Listening Journey';
        const topPlayed = data.top_played || [];
        const topListened = data.top_listened || [];
        const heroSong = topListened[0] || topPlayed[0];
        const vibe = getListeningVibe(data.peak_hour?.hour);

        // Preload hero cover
        const heroArtSrc = heroSong?.album_art ? `/static/album_art/${mediaUrlName(heroSong.album_art)}` : '';
        const heroCover = await loadCanvasImage(heroArtSrc);

        if (isStory) {
            // ==================== STORY (9:16 - 1080 x 1920) ====================
            const pad = 64;
            const contentW = width - pad * 2; // 952px

            // Top Bar: psr.fm + Period Badge
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 46px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('psr.fm', pad, 88);

            // Frequency dot
            ctx.fillStyle = '#10b981';
            ctx.beginPath();
            ctx.arc(pad + ctx.measureText('psr.fm').width + 12, 88, 5, 0, Math.PI * 2);
            ctx.fill();

            // Period Badge (top right)
            ctx.font = '700 20px Space Grotesk, Manrope, sans-serif';
            const badgeText = `FOCUS • ${periodLabel}`;
            const badgeW = ctx.measureText(badgeText).width + 36;
            const badgeX = width - pad - badgeW;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
            drawRoundRect(ctx, badgeX, 66, badgeW, 44, 22);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(badgeText, badgeX + badgeW / 2, 88);
            ctx.restore();

            // Tagline & Subtitle
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 42px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(fitCanvasText(ctx, tagline, contentW), pad, 168);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
            ctx.font = '500 22px Manrope, sans-serif';
            ctx.fillText('Personal Frequency Snapshot', pad, 204);
            ctx.restore();

            // ==================== HERO CARD (TOP TRACK) ====================
            const heroCardY = 230;
            const heroCardH = 480;
            ctx.save();
            // Drop shadow
            ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
            ctx.shadowBlur = 28;
            ctx.shadowOffsetY = 12;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
            drawRoundRect(ctx, pad, heroCardY, contentW, heroCardH, 28);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
            ctx.lineWidth = 1.5;
            drawRoundRect(ctx, pad, heroCardY, contentW, heroCardH, 28);
            ctx.stroke();
            ctx.restore();

            // Hero Album Art (380x380)
            const artX = pad + 26;
            const artY = heroCardY + 50;
            const artSize = 380;
            if (heroCover) {
                drawRoundedImage(ctx, heroCover, artX, artY, artSize, 22);
            } else {
                drawVinylCoverFallback(ctx, artX, artY, artSize, 22);
            }

            // Right Column in Hero Card
            const heroInfoX = artX + artSize + 30; // pad + 436
            const heroInfoW = contentW - (heroInfoX - pad) - 26; // ~490px

            ctx.save();
            ctx.textAlign = 'left';

            // 1. Kicker Badge (Pill)
            const kickerText = '#1 TOP ROTATION';
            ctx.font = '700 17px Space Grotesk, Manrope, sans-serif';
            const kickerW = ctx.measureText(kickerText).width + 24;
            const kickerY = heroCardY + 34;
            ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
            drawRoundRect(ctx, heroInfoX, kickerY, kickerW, 32, 16);
            ctx.fill();
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.38)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = '#fbbf24';
            ctx.textBaseline = 'middle';
            ctx.fillText(kickerText, heroInfoX + 12, kickerY + 16);

            // 2. Title (up to 2 lines wrapped)
            const heroTitle = heroSong ? heroSong.title : 'No Top Track';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 30px Space Grotesk, Manrope, sans-serif';
            ctx.textBaseline = 'alphabetic';
            const titleLines = wrapCanvasLines(ctx, heroTitle, heroInfoW, 2);
            let curTitleY = heroCardY + 104;
            titleLines.forEach(line => {
                ctx.fillText(line, heroInfoX, curTitleY);
                curTitleY += 38;
            });

            // 3. Artist
            const heroArtist = heroSong ? (heroSong.artist || 'Unknown Artist') : 'Keep playing music';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.font = '600 19px Manrope, sans-serif';
            ctx.fillText(fitCanvasText(ctx, `BY ${heroArtist.toUpperCase()}`, heroInfoW), heroInfoX, curTitleY + 4);

            // 4. Equalizer Soundwave Visualizer Bars
            const eqY = curTitleY + 20;
            drawEqualizerWave(ctx, heroInfoX, eqY, heroInfoW, 32, 18, 'rgba(255, 255, 255, 0.75)');

            // 5. Dual Mini Metric Tiles (Glass Box)
            const tileY = eqY + 46;
            const tileW = (heroInfoW - 14) / 2;
            const tileH = 74;
            const heroTime = heroSong ? formatCapsuleTime(heroSong.total_listened || 0) : '0m';
            const heroPlays = heroSong ? (heroSong.play_count || 0) : 0;

            // Tile 1: Time
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            drawRoundRect(ctx, heroInfoX, tileY, tileW, tileH, 14);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '700 12px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('TIME LISTENED', heroInfoX + 14, tileY + 24);

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 24px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(heroTime, heroInfoX + 14, tileY + 56);

            // Tile 2: Plays
            const tile2X = heroInfoX + tileW + 14;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            drawRoundRect(ctx, tile2X, tileY, tileW, tileH, 14);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '700 12px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('TOTAL PLAYS', tile2X + 14, tileY + 24);

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 24px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(`${heroPlays} plays`, tile2X + 14, tileY + 56);

            // 6. Listening Share Progress Bar
            const totalSecs = data.stats.total_seconds || 1;
            const songSecs = heroSong?.total_listened || 0;
            const sharePct = Math.min(100, Math.max(1, Math.round((songSecs / totalSecs) * 100)));
            const shareY = tileY + tileH + 18;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
            ctx.font = '600 14px Manrope, sans-serif';
            ctx.fillText(`${sharePct}% of your total listening this period`, heroInfoX, shareY + 12);

            // Progress track
            const trackY = shareY + 22;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
            drawRoundRect(ctx, heroInfoX, trackY, heroInfoW, 6, 3);
            ctx.fill();

            // Progress fill
            const fillW = Math.max(8, (heroInfoW * sharePct) / 100);
            const fillGrad = ctx.createLinearGradient(heroInfoX, trackY, heroInfoX + fillW, trackY);
            fillGrad.addColorStop(0, '#10b981');
            fillGrad.addColorStop(1, '#34d399');
            ctx.fillStyle = fillGrad;
            drawRoundRect(ctx, heroInfoX, trackY, fillW, 6, 3);
            ctx.fill();

            ctx.restore();

            // ==================== LISTENING PERSONA RIBBON ====================
            const ribbonY = heroCardY + heroCardH + 20; // 730
            const ribbonH = 84;

            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            drawRoundRect(ctx, pad, ribbonY, contentW, ribbonH, 20);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Left: Persona Tag
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';

            ctx.fillStyle = '#fbbf24';
            ctx.font = '700 19px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(vibe.tag, pad + 24, ribbonY + 35);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.font = '500 16px Manrope, sans-serif';
            ctx.fillText(vibe.subtitle, pad + 24, ribbonY + 63);

            // Right: Activity Highlight
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 19px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(`PEAK ROTATION • ${vibe.peakHour}`, pad + contentW - 24, ribbonY + 35);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.font = '500 16px Manrope, sans-serif';
            ctx.fillText(`${data.stats.total_plays || 0} total plays recorded`, pad + contentW - 24, ribbonY + 63);
            ctx.restore();

            // ==================== TRIO STATS CARDS ====================
            const statsY = ribbonY + ribbonH + 20; // 834
            const statCardW = (contentW - 32) / 3;
            const statCardH = 135;
            const statsList = [
                { label: 'TOTAL TIME', val: formatCapsuleTime(data.stats.total_seconds || 0), sub: 'listening time' },
                { label: 'UNIQUE TRACKS', val: String(data.stats.unique_songs || 0), sub: 'distinct songs' },
                { label: 'TOTAL PLAYS', val: String(data.stats.total_plays || 0), sub: 'track completions' }
            ];

            ctx.save();
            statsList.forEach((st, i) => {
                const sx = pad + i * (statCardW + 16);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
                drawRoundRect(ctx, sx, statsY, statCardW, statCardH, 18);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';

                ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                ctx.font = '700 15px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(st.label, sx + 22, statsY + 34);

                ctx.fillStyle = '#ffffff';
                ctx.font = '700 44px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(st.val, sx + 22, statsY + 90);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
                ctx.font = '500 15px Manrope, sans-serif';
                ctx.fillText(st.sub, sx + 22, statsY + 118);
            });
            ctx.restore();

            // ==================== TOP TRACKS LEADERBOARD ====================
            const listY = statsY + statCardH + 24; // 993
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.font = '700 20px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('TOP TRACKS LEADERBOARD', pad, listY + 22);
            ctx.restore();

            const tracksToDisplay = topPlayed.slice(0, 5);
            const maxPlays = Math.max(1, tracksToDisplay[0]?.play_count || 1);
            let rowY = listY + 38;
            const rankColors = ['#fbbf24', '#e2e8f0', '#f97316', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.7)'];

            for (let idx = 0; idx < tracksToDisplay.length; idx++) {
                const song = tracksToDisplay[idx];
                const rowH = 94;

                ctx.save();
                ctx.fillStyle = idx % 2 === 0 ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.18)';
                drawRoundRect(ctx, pad, rowY, contentW, rowH, 16);
                ctx.fill();

                // Proportional volume bar in background
                const rowVolW = Math.max(12, (contentW * (song.play_count || 0)) / maxPlays);
                ctx.fillStyle = idx === 0 ? 'rgba(251, 191, 36, 0.08)' : 'rgba(255, 255, 255, 0.05)';
                drawRoundRect(ctx, pad, rowY, rowVolW, rowH, 16);
                ctx.fill();

                ctx.strokeStyle = idx === 0 ? 'rgba(251, 191, 36, 0.35)' : 'rgba(255, 255, 255, 0.08)';
                ctx.lineWidth = 1;
                drawRoundRect(ctx, pad, rowY, contentW, rowH, 16);
                ctx.stroke();

                // Rank Number
                ctx.fillStyle = rankColors[idx] || 'rgba(255, 255, 255, 0.7)';
                ctx.font = '700 28px Space Grotesk, Manrope, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`0${idx + 1}`, pad + 40, rowY + rowH / 2);

                // Thumbnail (66x66 at x = pad + 80)
                const thumbSrc = song.album_art ? `/static/album_art/${mediaUrlName(song.album_art)}` : '';
                const thumbImg = await loadCanvasImage(thumbSrc);
                const thumbX = pad + 78;
                const thumbY = rowY + (rowH - 66) / 2;
                if (thumbImg) {
                    drawRoundedImage(ctx, thumbImg, thumbX, thumbY, 66, 12);
                } else {
                    drawVinylCoverFallback(ctx, thumbX, thumbY, 66, 12);
                }

                // Title & Artist (Starts at x = pad + 162)
                const textX = pad + 162;
                const textMaxW = contentW - 162 - 190;

                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';

                ctx.fillStyle = '#ffffff';
                ctx.font = '700 25px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(fitCanvasText(ctx, song.title, textMaxW), textX, rowY + 40);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                ctx.font = '500 19px Manrope, sans-serif';
                ctx.fillText(fitCanvasText(ctx, song.artist || 'Unknown', textMaxW), textX, rowY + 72);

                // Plays & Time on Right
                ctx.textAlign = 'right';
                ctx.fillStyle = '#ffffff';
                ctx.font = '700 23px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(`${song.play_count || 0} plays`, pad + contentW - 26, rowY + 40);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
                ctx.font = '500 17px Manrope, sans-serif';
                ctx.fillText(formatCapsuleTime(song.total_listened || 0), pad + contentW - 26, rowY + 72);

                ctx.restore();
                rowY += rowH + 14;
            }

            // ==================== ACOUSTIC SIGNATURE & FOOTER ====================
            const footerY = 1620;
            drawSoundBars(ctx, width / 2, footerY + 36, 460, 42, 29, 'rgba(255, 255, 255, 0.7)');

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 36px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('psr.fm', width / 2, footerY + 115);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '500 20px Manrope, sans-serif';
            ctx.fillText('private frequency • sound of your moments', width / 2, footerY + 152);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.font = '500 16px Manrope, sans-serif';
            ctx.fillText(`Frequency Focus • ${periodLabel}`, width / 2, footerY + 184);
            ctx.restore();

        } else {
            // ==================== SQUARE (1:1 - 1080 x 1080) ====================
            const pad = 48;
            const contentW = width - pad * 2; // 984px

            // Top Header
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 40px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('psr.fm', pad, 52);

            ctx.fillStyle = '#10b981';
            ctx.beginPath();
            ctx.arc(pad + ctx.measureText('psr.fm').width + 10, 52, 4.5, 0, Math.PI * 2);
            ctx.fill();

            ctx.font = '700 18px Space Grotesk, Manrope, sans-serif';
            const badgeText = `FOCUS • ${periodLabel}`;
            const badgeW = ctx.measureText(badgeText).width + 30;
            const badgeX = width - pad - badgeW;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
            drawRoundRect(ctx, badgeX, 33, badgeW, 38, 19);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(badgeText, badgeX + badgeW / 2, 52);

            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.font = '700 30px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(fitCanvasText(ctx, tagline, contentW), pad, 108);
            ctx.restore();

            // Left Column: Hero Song (width 430, height 780)
            const heroBoxX = pad;
            const heroBoxY = 132;
            const heroBoxW = 430;
            const heroBoxH = 780;

            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
            drawRoundRect(ctx, heroBoxX, heroBoxY, heroBoxW, heroBoxH, 24);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const artSize = 350;
            const artX = heroBoxX + (heroBoxW - artSize) / 2;
            const artY = heroBoxY + 20;
            if (heroCover) {
                drawRoundedImage(ctx, heroCover, artX, artY, artSize, 20);
            } else {
                drawVinylCoverFallback(ctx, artX, artY, artSize, 20);
            }

            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';

            // Kicker Pill
            const sKickerText = '#1 TOP ROTATION';
            ctx.font = '700 16px Space Grotesk, Manrope, sans-serif';
            const sKickerW = ctx.measureText(sKickerText).width + 22;
            const sKickerY = artY + artSize + 16;
            ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
            drawRoundRect(ctx, heroBoxX + 24, sKickerY, sKickerW, 28, 14);
            ctx.fill();
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = '#fbbf24';
            ctx.textBaseline = 'middle';
            ctx.fillText(sKickerText, heroBoxX + 35, sKickerY + 14);

            // Title (2 lines wrapped)
            const heroTitle = heroSong ? heroSong.title : 'No Top Track';
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 26px Space Grotesk, Manrope, sans-serif';
            ctx.textBaseline = 'alphabetic';
            const sTitleLines = wrapCanvasLines(ctx, heroTitle, heroBoxW - 48, 2);
            let sTitleY = sKickerY + 54;
            sTitleLines.forEach(line => {
                ctx.fillText(line, heroBoxX + 24, sTitleY);
                sTitleY += 32;
            });

            // Artist
            const heroArtist = heroSong ? (heroSong.artist || 'Unknown Artist') : 'Keep playing';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.font = '600 18px Manrope, sans-serif';
            ctx.fillText(fitCanvasText(ctx, `BY ${heroArtist.toUpperCase()}`, heroBoxW - 48), heroBoxX + 24, sTitleY + 2);

            // Equalizer Bars
            const sWaveY = sTitleY + 14;
            drawEqualizerWave(ctx, heroBoxX + 24, sWaveY, heroBoxW - 48, 26, 16, 'rgba(255, 255, 255, 0.75)');

            // Dual metric tiles
            const heroTime = heroSong ? formatCapsuleTime(heroSong.total_listened || 0) : '0m';
            const heroPlays = heroSong ? (heroSong.play_count || 0) : 0;
            const sTileY = sWaveY + 38;
            const sTileW = (heroBoxW - 48 - 12) / 2;
            const sTileH = 64;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            drawRoundRect(ctx, heroBoxX + 24, sTileY, sTileW, sTileH, 12);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '700 11px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('LISTENED', heroBoxX + 36, sTileY + 20);

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 22px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(heroTime, heroBoxX + 36, sTileY + 48);

            const sTile2X = heroBoxX + 24 + sTileW + 12;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            drawRoundRect(ctx, sTile2X, sTileY, sTileW, sTileH, 12);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '700 11px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('PLAYS', sTile2X + 14, sTileY + 20);

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 22px Space Grotesk, Manrope, sans-serif';
            ctx.fillText(`${heroPlays} plays`, sTile2X + 14, sTileY + 48);

            // Listening Share Progress
            const totalSecs = data.stats.total_seconds || 1;
            const songSecs = heroSong?.total_listened || 0;
            const sharePct = Math.min(100, Math.max(1, Math.round((songSecs / totalSecs) * 100)));
            const sShareY = sTileY + sTileH + 14;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
            ctx.font = '600 13px Manrope, sans-serif';
            ctx.fillText(`${sharePct}% of your total period listening`, heroBoxX + 24, sShareY + 8);

            const sTrackY = sShareY + 16;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
            drawRoundRect(ctx, heroBoxX + 24, sTrackY, heroBoxW - 48, 5, 2.5);
            ctx.fill();

            const sFillW = Math.max(6, ((heroBoxW - 48) * sharePct) / 100);
            const sFillGrad = ctx.createLinearGradient(heroBoxX + 24, sTrackY, heroBoxX + 24 + sFillW, sTrackY);
            sFillGrad.addColorStop(0, '#10b981');
            sFillGrad.addColorStop(1, '#34d399');
            ctx.fillStyle = sFillGrad;
            drawRoundRect(ctx, heroBoxX + 24, sTrackY, sFillW, 5, 2.5);
            ctx.fill();

            // Vibe pill at bottom of hero card
            const sVibeY = sTrackY + 14;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            drawRoundRect(ctx, heroBoxX + 24, sVibeY, heroBoxW - 48, 36, 12);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 15px Space Grotesk, Manrope, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${vibe.tag} • ${vibe.peakHour}`, heroBoxX + 38, sVibeY + 18);

            ctx.restore();

            // Right Column: Stats + Top Tracks (width ~528)
            const rightX = pad + heroBoxW + 24;
            const rightW = width - pad - rightX;

            // 2 Stat cards
            const statCardH = 92;
            const miniCardW = (rightW - 14) / 2;
            const statsRow1 = [
                { label: 'TOTAL TIME', val: formatCapsuleTime(data.stats.total_seconds || 0), sub: 'listening time' },
                { label: 'TOTAL PLAYS', val: String(data.stats.total_plays || 0), sub: 'track completions' }
            ];

            ctx.save();
            statsRow1.forEach((st, i) => {
                const sx = rightX + i * (miniCardW + 14);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
                drawRoundRect(ctx, sx, heroBoxY, miniCardW, statCardH, 16);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';

                ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                ctx.font = '700 14px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(st.label, sx + 18, heroBoxY + 26);

                ctx.fillStyle = '#ffffff';
                ctx.font = '700 32px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(st.val, sx + 18, heroBoxY + 64);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
                ctx.font = '500 13px Manrope, sans-serif';
                ctx.fillText(st.sub, sx + 18, heroBoxY + 82);
            });

            // Vibe ribbon on right
            const sVibeRibbonY = heroBoxY + statCardH + 12;
            const sVibeRibbonH = 42;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
            drawRoundRect(ctx, rightX, sVibeRibbonY, rightW, sVibeRibbonH, 14);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.stroke();

            ctx.fillStyle = '#fbbf24';
            ctx.font = '700 15px Space Grotesk, Manrope, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${vibe.tag}`, rightX + 16, sVibeRibbonY + 21);

            ctx.textAlign = 'right';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '600 14px Manrope, sans-serif';
            ctx.fillText(`Peak: ${vibe.peakHour} • ${data.stats.total_plays || 0} plays`, rightX + rightW - 16, sVibeRibbonY + 21);
            ctx.restore();

            // Top Tracks list on right
            const rightListY = sVibeRibbonY + sVibeRibbonH + 14;
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.font = '700 17px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('TOP TRACKS LEADERBOARD', rightX, rightListY + 16);
            ctx.restore();

            const tracksSquare = topPlayed.slice(0, 5);
            const sMaxPlays = Math.max(1, tracksSquare[0]?.play_count || 1);
            let sRowY = rightListY + 26;
            const rankColorsSquare = ['#fbbf24', '#e2e8f0', '#f97316', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.7)'];

            for (let idx = 0; idx < tracksSquare.length; idx++) {
                const song = tracksSquare[idx];
                const rH = 86;

                ctx.save();
                ctx.fillStyle = idx % 2 === 0 ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.18)';
                drawRoundRect(ctx, rightX, sRowY, rightW, rH, 16);
                ctx.fill();

                // Proportional volume bar in background
                const rowVolW = Math.max(10, (rightW * (song.play_count || 0)) / sMaxPlays);
                ctx.fillStyle = idx === 0 ? 'rgba(251, 191, 36, 0.08)' : 'rgba(255, 255, 255, 0.05)';
                drawRoundRect(ctx, rightX, sRowY, rowVolW, rH, 16);
                ctx.fill();

                ctx.strokeStyle = idx === 0 ? 'rgba(251, 191, 36, 0.35)' : 'rgba(255, 255, 255, 0.08)';
                ctx.lineWidth = 1;
                drawRoundRect(ctx, rightX, sRowY, rightW, rH, 16);
                ctx.stroke();

                // Rank
                ctx.fillStyle = rankColorsSquare[idx] || 'rgba(255, 255, 255, 0.7)';
                ctx.font = '700 24px Space Grotesk, Manrope, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`0${idx + 1}`, rightX + 26, sRowY + rH / 2);

                // Thumb
                const tSrc = song.album_art ? `/static/album_art/${mediaUrlName(song.album_art)}` : '';
                const tImg = await loadCanvasImage(tSrc);
                const tX = rightX + 54;
                const tY = sRowY + (rH - 58) / 2;
                if (tImg) {
                    drawRoundedImage(ctx, tImg, tX, tY, 58, 12);
                } else {
                    drawVinylCoverFallback(ctx, tX, tY, 58, 12);
                }

                // Title & Artist
                const sTextX = rightX + 126;
                const sTextW = rightW - 126 - 110;

                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';

                ctx.fillStyle = '#ffffff';
                ctx.font = '700 20px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(fitCanvasText(ctx, song.title, sTextW), sTextX, sRowY + 36);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                ctx.font = '500 16px Manrope, sans-serif';
                ctx.fillText(fitCanvasText(ctx, song.artist || 'Unknown', sTextW), sTextX, sRowY + 62);

                // Plays
                ctx.textAlign = 'right';
                ctx.fillStyle = '#ffffff';
                ctx.font = '700 19px Space Grotesk, Manrope, sans-serif';
                ctx.fillText(`${song.play_count || 0} plays`, rightX + rightW - 18, sRowY + 36);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
                ctx.font = '500 15px Manrope, sans-serif';
                ctx.fillText(formatCapsuleTime(song.total_listened || 0), rightX + rightW - 18, sRowY + 62);

                ctx.restore();
                sRowY += rH + 10;
            }

            // Balanced Full-Width Bottom Section (Y = 940 to 1040)
            const sFooterY = 945;
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pad, sFooterY);
            ctx.lineTo(pad + contentW, sFooterY);
            ctx.stroke();

            // Soundwave bars in center of bottom
            drawSoundBars(ctx, width / 2, sFooterY + 34, 380, 26, 25, 'rgba(255, 255, 255, 0.65)');

            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';

            ctx.fillStyle = '#ffffff';
            ctx.font = '700 20px Space Grotesk, Manrope, sans-serif';
            ctx.fillText('psr.fm', width / 2, sFooterY + 84);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.font = '500 15px Manrope, sans-serif';
            ctx.fillText(`private frequency • sound of your moments • ${periodLabel}`, width / 2, sFooterY + 108);
            ctx.restore();
        }
    }


    async function downloadShareCapsule() {
        if (!el.shareCapsuleCanvas) return;
        await state.capsuleShareRenderPromise;
        const periodCode = (state.capsuleData?.period?.label || 'recap').replace(/\s+/g, '-').toLowerCase();
        const filename = `psr-frequency-focus-${periodCode}-${state.capsuleShareFormat}.png`;
        const a = document.createElement('a');
        a.download = filename;
        a.href = el.shareCapsuleCanvas.toDataURL('image/png');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast('Recap card downloaded!', 'success');
    }

    async function copyShareCapsule() {
        if (!el.shareCapsuleCanvas || !navigator.clipboard?.write || !window.ClipboardItem) {
            await downloadShareCapsule();
            return;
        }
        await state.capsuleShareRenderPromise;
        const blob = await canvasToBlob(el.shareCapsuleCanvas);
        if (!blob) return showToast('Failed to create image', 'error');
        try {
            await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
            showToast('Focus card copied to clipboard!', 'success');
        } catch (err) {
            await downloadShareCapsule();
        }
    }

    function openShareCapsuleModal() {
        if (!state.capsuleData || (!state.capsuleData.stats?.total_plays && !state.capsuleData.stats?.total_seconds)) {
            showToast('No listening history available to share for this period', 'warning');
            return;
        }
        if (el.shareCapsuleModal) {
            el.shareCapsuleModal.style.display = 'flex';
            el.shareCapsuleModal.setAttribute('aria-hidden', 'false');
            state.capsuleShareRenderPromise = renderShareCapsuleCanvas();
        }
    }

    function closeShareCapsuleModal() {
        if (el.shareCapsuleModal) {
            el.shareCapsuleModal.style.display = 'none';
            el.shareCapsuleModal.setAttribute('aria-hidden', 'true');
        }
    }

    function ensureCapsuleShareElements() {
        let shareBtn = document.getElementById('capsule-share-btn');
        if (!shareBtn) {
            const periodControl = document.querySelector('.capsule-period-control');
            if (periodControl && periodControl.parentElement) {
                let controlsWrapper = periodControl.parentElement;
                if (!controlsWrapper.classList.contains('capsule-header-controls')) {
                    controlsWrapper = document.createElement('div');
                    controlsWrapper.className = 'capsule-header-controls';
                    periodControl.parentElement.insertBefore(controlsWrapper, periodControl);
                    controlsWrapper.appendChild(periodControl);
                }
                shareBtn = document.createElement('button');
                shareBtn.id = 'capsule-share-btn';
                shareBtn.className = 'btn-primary compact capsule-share-btn';
                shareBtn.type = 'button';
                shareBtn.setAttribute('aria-label', 'Share Frequency Focus as image card');
                shareBtn.innerHTML = '<i class="fas fa-share-alt"></i> Share Card';
                controlsWrapper.appendChild(shareBtn);
            }
        }
        if (shareBtn) {
            shareBtn.onclick = openShareCapsuleModal;
        }

        let modal = document.getElementById('share-capsule-modal');
        if (!modal) {
            const modalContainer = document.createElement('div');
            modalContainer.id = 'share-capsule-modal';
            modalContainer.className = 'modal';
            modalContainer.setAttribute('aria-hidden', 'true');
            modalContainer.innerHTML = `
                <div class="modal-content share-capsule-modal" role="dialog" aria-modal="true" aria-labelledby="share-capsule-title">
                    <div class="share-modal-header">
                        <div>
                            <p class="lyrics-eyebrow">Frequency Focus</p>
                            <h3 id="share-capsule-title">Share Listening Recap</h3>
                        </div>
                        <button id="share-capsule-close-btn" class="lyrics-close-btn" type="button" aria-label="Close share modal">
                            <i class="fas fa-times" aria-hidden="true"></i>
                        </button>
                    </div>

                    <div class="share-capsule-controls">
                        <div class="share-section">
                            <label>Card Format</label>
                            <div class="share-format-grid" role="radiogroup" aria-label="Card aspect ratio">
                                <button type="button" class="share-format-btn active" data-format="story">
                                    <i class="fas fa-mobile-alt"></i> Story (9:16)
                                </button>
                                <button type="button" class="share-format-btn" data-format="square">
                                    <i class="fas fa-square"></i> Square (1:1)
                                </button>
                            </div>
                        </div>

                        <div class="share-section">
                            <label>Color Theme</label>
                            <div class="share-theme-grid" id="share-capsule-theme-grid" role="listbox" aria-label="Card theme">
                                <button class="share-theme active" type="button" data-theme="emerald" title="Emerald Aurora" style="background: linear-gradient(135deg, #064e3b, #10b981);"></button>
                                <button class="share-theme" type="button" data-theme="sapphire" title="Midnight Sapphire" style="background: linear-gradient(135deg, #0f172a, #3b82f6);"></button>
                                <button class="share-theme" type="button" data-theme="violet" title="Neon Violet" style="background: linear-gradient(135deg, #2e1065, #a855f7);"></button>
                                <button class="share-theme" type="button" data-theme="sunset" title="Sunset Crimson" style="background: linear-gradient(135deg, #4c0519, #f43f5e);"></button>
                                <button class="share-theme" type="button" data-theme="amber" title="Amber Gold" style="background: linear-gradient(135deg, #451a03, #f59e0b);"></button>
                                <button class="share-theme" type="button" data-theme="obsidian" title="Obsidian Black" style="background: linear-gradient(135deg, #09090b, #27272a);"></button>
                            </div>
                            <div class="share-custom-theme" aria-label="Custom card colors">
                                <span>Custom</span>
                                <label class="share-color-control" title="Background start color">Start <input id="share-capsule-start" type="color" value="#064e3b" aria-label="Custom background start color"><input id="share-capsule-start-hex" class="share-hex-input" type="text" value="#064E3B" maxlength="7" spellcheck="false" autocomplete="off"></label>
                                <label class="share-color-control" title="Background end color">End <input id="share-capsule-end" type="color" value="#10b981" aria-label="Custom background end color"><input id="share-capsule-end-hex" class="share-hex-input" type="text" value="#10B981" maxlength="7" spellcheck="false" autocomplete="off"></label>
                            </div>
                        </div>

                        <div class="share-section">
                            <label for="share-capsule-tagline">Card Tagline</label>
                            <input type="text" id="share-capsule-tagline" class="theme-color-input" style="width:100%; height:42px; border-radius:8px; padding:0 12px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#fff; font-size:13px; font-weight:600;" value="My Listening Journey" maxlength="40">
                        </div>
                    </div>

                    <div class="share-section share-capsule-preview-wrap">
                        <label>Preview</label>
                        <div class="share-capsule-canvas-container">
                            <canvas id="share-capsule-canvas" class="share-capsule-canvas" width="1080" height="1920" aria-label="Frequency Focus share card preview"></canvas>
                        </div>
                    </div>

                    <div class="modal-actions share-actions">
                        <button id="share-capsule-copy-btn" class="btn-secondary" type="button"><i class="fas fa-copy"></i> Copy Image</button>
                        <button id="share-capsule-download-btn" class="btn-primary" type="button"><i class="fas fa-download"></i> Download PNG</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modalContainer);
        }
        initShareCapsuleModal();
    }

    function initShareCapsuleModal() {
        el.capsuleShareBtn = document.getElementById('capsule-share-btn');
        el.shareCapsuleModal = document.getElementById('share-capsule-modal');
        el.shareCapsuleCloseBtn = document.getElementById('share-capsule-close-btn');
        el.shareCapsuleCanvas = document.getElementById('share-capsule-canvas');
        el.shareCapsuleCopyBtn = document.getElementById('share-capsule-copy-btn');
        el.shareCapsuleDownloadBtn = document.getElementById('share-capsule-download-btn');
        el.shareCapsuleTagline = document.getElementById('share-capsule-tagline');
        el.shareCapsuleStart = document.getElementById('share-capsule-start');
        el.shareCapsuleEnd = document.getElementById('share-capsule-end');
        el.shareCapsuleStartHex = document.getElementById('share-capsule-start-hex');
        el.shareCapsuleEndHex = document.getElementById('share-capsule-end-hex');

        if (el.capsuleShareBtn) {
            el.capsuleShareBtn.onclick = openShareCapsuleModal;
        }
        if (el.shareCapsuleCloseBtn) {
            el.shareCapsuleCloseBtn.addEventListener('click', closeShareCapsuleModal);
        }
        if (el.shareCapsuleModal) {
            el.shareCapsuleModal.addEventListener('click', (e) => {
                if (e.target === el.shareCapsuleModal) closeShareCapsuleModal();
            });
        }

        // Format selector buttons
        document.querySelectorAll('.share-format-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.share-format-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.capsuleShareFormat = btn.dataset.format || 'story';
                state.capsuleShareRenderPromise = renderShareCapsuleCanvas();
            });
        });

        // Theme selector buttons
        const themeGrid = document.getElementById('share-capsule-theme-grid');
        if (themeGrid) {
            themeGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('.share-theme');
                if (!btn) return;
                themeGrid.querySelectorAll('.share-theme').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.capsuleShareTheme = btn.dataset.theme;
                state.capsuleShareRenderPromise = renderShareCapsuleCanvas();
            });
        }

        // Custom start/end colors
        const handleCustomColors = () => {
            const startColor = el.shareCapsuleStart?.value || '#064e3b';
            const endColor = el.shareCapsuleEnd?.value || '#10b981';
            state.capsuleShareTheme = 'custom';
            state.capsuleShareCustomColors = [startColor, endColor];
            if (el.shareCapsuleStartHex) el.shareCapsuleStartHex.value = startColor.toUpperCase();
            if (el.shareCapsuleEndHex) el.shareCapsuleEndHex.value = endColor.toUpperCase();
            themeGrid?.querySelectorAll('.share-theme').forEach(b => b.classList.remove('active'));
            state.capsuleShareRenderPromise = renderShareCapsuleCanvas();
        };

        el.shareCapsuleStart?.addEventListener('input', handleCustomColors);
        el.shareCapsuleEnd?.addEventListener('input', handleCustomColors);

        // Tagline input
        let taglineDebounce = null;
        el.shareCapsuleTagline?.addEventListener('input', () => {
            clearTimeout(taglineDebounce);
            taglineDebounce = setTimeout(() => {
                state.capsuleShareTagline = el.shareCapsuleTagline.value;
                state.capsuleShareRenderPromise = renderShareCapsuleCanvas();
            }, 250);
        });

        // Actions
        el.shareCapsuleCopyBtn?.addEventListener('click', copyShareCapsule);
        el.shareCapsuleDownloadBtn?.addEventListener('click', downloadShareCapsule);
    }

    try {
        initShareCapsuleModal();
    } catch (err) {
        console.error('Failed to initialize share capsule modal:', err);
    }


    window.loadFrequencyFocus = loadFrequencyFocus;
    window.ensureCapsuleShareElements = ensureCapsuleShareElements;
    window.openShareCapsuleModal = openShareCapsuleModal;
});
})();
