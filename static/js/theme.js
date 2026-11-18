    (function () {
        const THEME_STORAGE_KEY = 'psr_theme_v2';
        const LEGACY_KEY = 'psr_theme_v1';

        const BG_CONFIGS = {
            dark:     { '--bg-main': '#070908', '--bg-elevated': '#0e110f', '--bg-highlight': '#181d1a', '--bg-soft': '#111512' },
            amoled:   { '--bg-main': '#000000', '--bg-elevated': '#070707', '--bg-highlight': '#111111', '--bg-soft': '#090909' },
            midnight: { '--bg-main': '#0b0f19', '--bg-elevated': '#111726', '--bg-highlight': '#1b243b', '--bg-soft': '#0f1422' },
            charcoal: { '--bg-main': '#131518', '--bg-elevated': '#1a1d22', '--bg-highlight': '#23272e', '--bg-soft': '#17191d' },
            warm:     { '--bg-main': '#140f0c', '--bg-elevated': '#1c1511', '--bg-highlight': '#271e18', '--bg-soft': '#17110d' },
            forest:   { '--bg-main': '#09120c', '--bg-elevated': '#0e1a12', '--bg-highlight': '#15261b', '--bg-soft': '#0c160f' },
        };

        function hexToRgb(hex) {
            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim());
            return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
        }

        function getContrastColor(hex) {
            const rgb = hexToRgb(hex);
            if (!rgb) return '#061109';
            const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
            return lum > 150 ? '#061109' : '#ffffff';
        }

        function lightenHex(hex, amount = 0.22) {
            const rgb = hexToRgb(hex);
            if (!rgb) return hex;
            const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
            const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
            const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
            return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        }

        function darkenHex(hex, amount = 0.2) {
            const rgb = hexToRgb(hex);
            if (!rgb) return hex;
            const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
            const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
            const b = Math.max(0, Math.round(rgb.b * (1 - amount)));
            return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        }

        function mixWithWhite(hex, amount) {
            const rgb = hexToRgb(hex);
            if (!rgb) return hex;
            const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
            const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
            const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
            return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        }

        function bgPaletteFromBase(baseHex) {
            const rgb = hexToRgb(baseHex) || { r: 10, g: 10, b: 10 };
            const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
            if (lum < 120) {
                return {
                    '--bg-main':      baseHex,
                    '--bg-elevated':  mixWithWhite(baseHex, 0.05),
                    '--bg-highlight': mixWithWhite(baseHex, 0.11),
                    '--bg-soft':      mixWithWhite(baseHex, 0.03),
                };
            } else {
                return {
                    '--bg-main':      baseHex,
                    '--bg-elevated':  darkenHex(baseHex, 0.06),
                    '--bg-highlight': darkenHex(baseHex, 0.12),
                    '--bg-soft':      darkenHex(baseHex, 0.03),
                };
            }
        }

        function resolveSidebarColor(theme, bgVars) {
            const mode = theme.sidebarMode || 'harmonize';
            if (mode === 'match') {
                return bgVars['--bg-main'];
            } else if (mode === 'obsidian') {
                return '#000000';
            } else if (mode === 'custom' && theme.sidebarCustom) {
                return theme.sidebarCustom;
            } else {
                // harmonize (default)
                return bgVars['--bg-elevated'];
            }
        }

        function resolveCardColor(theme, bgVars) {
            const mode = theme.cardMode || 'glass';
            if (mode === 'harmonize') {
                const baseHex = bgVars['--bg-main'];
                return mixWithWhite(baseHex, 0.055);
            } else if (mode === 'contrast') {
                return 'rgba(0, 0, 0, 0.55)';
            } else if (mode === 'custom' && theme.cardCustom) {
                return theme.cardCustom;
            } else {
                // 'glass' (default) - translucent frosted glass
                return 'rgba(255, 255, 255, 0.045)';
            }
        }

        function resolveStatusBarColor(theme, bgVars) {
            const mode = theme.statusBarMode || 'accent';
            if (mode === 'accent') {
                return theme.accent || '#30d66b';
            } else if (mode === 'background') {
                return bgVars['--bg-main'] || '#070908';
            } else if (mode === 'black') {
                return '#000000';
            } else if (mode === 'custom' && theme.statusBarCustom) {
                return theme.statusBarCustom;
            }
            return theme.accent || '#30d66b';
        }

        function applyTheme(theme) {
            const root = document.documentElement;

            // --- Accent ---
            const accentHex = theme.accent || '#30d66b';
            const rgb = hexToRgb(accentHex);
            const accentHover = theme.accentHover || lightenHex(accentHex, 0.22);
            const contrast = getContrastColor(accentHex);

            root.style.setProperty('--accent-color', accentHex);
            root.style.setProperty('--accent-hover', accentHover);
            root.style.setProperty('--focus-ring', lightenHex(accentHex, 0.45));
            root.style.setProperty('--accent-contrast', contrast);
            if (rgb) root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);

            // --- Lyrics Highlight Color ---
            const lyricMode = theme.lyricMode || 'accent';
            const lyricHex = (lyricMode === 'custom' && theme.lyricColor) ? theme.lyricColor : accentHex;
            const lyricRgb = hexToRgb(lyricHex) || rgb || { r: 48, g: 214, b: 107 };
            const lyricHover = theme.lyricHover || lightenHex(lyricHex, 0.35);
            const lyricSpoken = lightenHex(lyricHex, 0.82);

            root.style.setProperty('--lyric-color', lyricHex);
            root.style.setProperty('--lyric-hover', lyricHover);
            root.style.setProperty('--lyric-spoken', lyricSpoken);
            root.style.setProperty('--lyric-rgb', `${lyricRgb.r}, ${lyricRgb.g}, ${lyricRgb.b}`);

            // --- Background Palette ---
            let bgVars;
            if (theme.bg === 'custom' && theme.bgCustom) {
                bgVars = bgPaletteFromBase(theme.bgCustom);
            } else {
                bgVars = BG_CONFIGS[theme.bg || 'dark'] || BG_CONFIGS.dark;
            }
            for (const [prop, val] of Object.entries(bgVars)) {
                root.style.setProperty(prop, val);
            }

            // --- Navbar / Sidebar Background ---
            const sidebarColor = resolveSidebarColor(theme, bgVars);
            root.style.setProperty('--bg-sidebar', sidebarColor);

            // --- Cards & Boxes Background ---
            const cardColor = resolveCardColor(theme, bgVars);
            root.style.setProperty('--bg-card', cardColor);

            // --- PWA Status Bar / Frame Color ---
            const statusBarColor = resolveStatusBarColor(theme, bgVars);
            root.style.setProperty('--status-bar-color', statusBarColor);
            let metaTheme = document.querySelector('meta[name="theme-color"]');
            if (!metaTheme) {
                metaTheme = document.createElement('meta');
                metaTheme.name = 'theme-color';
                document.head.appendChild(metaTheme);
            }
            metaTheme.setAttribute('content', statusBarColor);

            // --- Font / Text Color ---
            const textHex = theme.textColor || '#f5f7f5';
            const textRgb = hexToRgb(textHex) || { r: 245, g: 247, b: 245 };
            root.style.setProperty('--text-primary', textHex);
            root.style.setProperty('--text-secondary', `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.72)`);
            root.style.setProperty('--text-muted', `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.48)`);

            // --- Scale (Font & Interface Zoom) ---
            const scale = parseFloat(theme.scale || '1.0');
            root.style.setProperty('--ui-scale', scale);
            root.style.setProperty('--font-scale', scale);
            if ('zoom' in root.style) {
                root.style.zoom = scale !== 1.0 ? scale : '';
            } else {
                root.style.fontSize = scale !== 1.0 ? `${scale * 100}%` : '';
            }
        }

        function getCurrentTheme() {
            try {
                const raw = localStorage.getItem(THEME_STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
                if (raw) return JSON.parse(raw);
            } catch {}
            return {
                accent: '#30d66b',
                accentHover: '#55e584',
                bg: 'dark',
                bgCustom: '#070908',
                sidebarMode: 'harmonize',
                sidebarCustom: '#0e110f',
                cardMode: 'glass',
                cardCustom: '#16181b',
                textColor: '#f5f7f5',
                statusBarMode: 'accent',
                statusBarCustom: '#30d66b',
                lyricMode: 'accent',
                lyricColor: '#30d66b',
                scale: '1.0'
            };
        }

        function saveTheme(theme) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
            } catch {}
            if (navigator.onLine) {
                fetch('/api/user-settings/theme', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(theme)
                }).catch(() => {});
            }
        }

        async function syncThemeFromServer() {
            if (!navigator.onLine) return;
            try {
                const res = await fetch('/api/user-settings/theme');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.theme && typeof data.theme === 'object' && Object.keys(data.theme).length > 0) {
                        localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(data.theme));
                        applyTheme(data.theme);
                    }
                }
            } catch (_) {}
        }

        // Apply theme immediately on startup from local, then sync server
        applyTheme(getCurrentTheme());
        syncThemeFromServer();

        // Listen for real-time theme updates from other devices
        const onThemeSync = (remoteTheme) => {
            if (remoteTheme && typeof remoteTheme === 'object') {
                try {
                    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(remoteTheme));
                } catch (_) {}
                applyTheme(remoteTheme);
            }
        };

        if (typeof window !== 'undefined') {
            window.handleThemeSync = onThemeSync;
            if (window.socket && typeof window.socket.on === 'function') {
                window.socket.on('theme_sync', onThemeSync);
            }
        }
        if (typeof socket !== 'undefined' && socket && typeof socket.on === 'function') {
            socket.on('theme_sync', onThemeSync);
        }

        // Wire Modal and Interactive Logic
        const initThemeManager = () => {
            window.initThemeManager = initThemeManager;
            const modalEl           = document.getElementById('theme-settings-modal');
            const openBtn           = document.getElementById('theme-settings-btn');
            const quickBtn          = document.getElementById('theme-quick-btn');
            const closeBtn          = document.getElementById('theme-modal-close-btn');
            const cancelBtn         = document.getElementById('theme-cancel-btn');
            const applyBtn          = document.getElementById('theme-apply-btn');
            const resetBtn          = document.getElementById('theme-reset-btn');

            const accentPicker      = document.getElementById('theme-accent-picker');
            const accentHexLabel    = document.getElementById('theme-accent-hex');
            const presetsEl         = document.getElementById('theme-presets');

            const sidebarOptionsEl  = document.getElementById('theme-sidebar-options');
            const sidebarPicker     = document.getElementById('theme-sidebar-picker');
            const sidebarHexLabel   = document.getElementById('theme-sidebar-hex');
            const sidebarCustomRow  = document.getElementById('theme-sidebar-custom-row');

            const bgPresetsEl       = document.getElementById('theme-bg-presets');
            const bgPicker          = document.getElementById('theme-bg-picker');
            const bgHexLabel        = document.getElementById('theme-bg-hex');
            const bgCustomRow       = document.getElementById('theme-bg-custom-row');
            const bgCustomPreview   = document.getElementById('theme-bg-custom-preview');

            const cardOptionsEl     = document.getElementById('theme-card-options');
            const cardPicker        = document.getElementById('theme-card-picker');
            const cardHexLabel      = document.getElementById('theme-card-hex');
            const cardCustomRow     = document.getElementById('theme-card-custom-row');

            const textPresetsEl     = document.getElementById('theme-text-presets');
            const textPicker        = document.getElementById('theme-text-picker');
            const textHexLabel      = document.getElementById('theme-text-hex');

            const statusbarOptionsEl = document.getElementById('theme-statusbar-options');
            const statusbarPicker    = document.getElementById('theme-statusbar-picker');
            const statusbarHexLabel  = document.getElementById('theme-statusbar-hex');
            const statusbarCustomRow = document.getElementById('theme-statusbar-custom-row');
            const lyricOptionsEl     = document.getElementById('theme-lyric-options');
            const lyricPresetsEl     = document.getElementById('theme-lyric-presets');
            const lyricPicker        = document.getElementById('theme-lyric-picker');
            const lyricHexLabel      = document.getElementById('theme-lyric-hex');
            const lyricCustomRow     = document.getElementById('theme-lyric-custom-row');
            const prevLyricSpoken    = document.querySelector('.preview-lyric-spoken');
            const prevLyricActive    = document.querySelector('.preview-lyric-active');
            const prevCard           = document.getElementById('theme-preview-card');

            const scaleRow          = document.querySelector('.theme-scale-row');

            // Preview card elements
            const prevSidebar       = document.getElementById('theme-preview-sidebar');
            const prevContent       = document.getElementById('theme-preview-content');
            const prevNavActive     = document.getElementById('theme-preview-nav-active');
            const prevPlayBtn       = document.getElementById('theme-preview-play-btn');
            const prevNowPlaying    = document.getElementById('theme-preview-now-playing');
            const prevPulseDot      = document.getElementById('theme-preview-pulse-dot');
            const prevCardArt       = document.getElementById('theme-preview-card-art');

            if (!modalEl) return;

            let initialTheme = { ...getCurrentTheme() };
            let draft = { ...initialTheme };

            function syncMiniPreview() {
                const contrast = getContrastColor(draft.accent || '#30d66b');
                let bgVars;
                if (draft.bg === 'custom' && draft.bgCustom) {
                    bgVars = bgPaletteFromBase(draft.bgCustom);
                } else {
                    bgVars = BG_CONFIGS[draft.bg || 'dark'] || BG_CONFIGS.dark;
                }
                const sidebarColor = resolveSidebarColor(draft, bgVars);
                const cardColor = resolveCardColor(draft, bgVars);

                if (prevSidebar)    prevSidebar.style.backgroundColor = sidebarColor;
                if (prevContent) {
                    prevContent.style.backgroundColor = bgVars['--bg-main'];
                    prevContent.style.color = draft.textColor || '#f5f7f5';
                }
                if (prevCardArt && prevCardArt.parentElement) {
                    prevCardArt.parentElement.style.backgroundColor = cardColor;
                }
                if (prevNavActive) {
                    prevNavActive.style.backgroundColor = draft.accent;
                    prevNavActive.style.color = contrast;
                }
                if (prevPlayBtn) {
                    prevPlayBtn.style.backgroundColor = draft.accent;
                    prevPlayBtn.style.color = contrast;
                }
                if (prevNowPlaying) prevNowPlaying.style.color = draft.accent;
                if (prevPulseDot)   prevPulseDot.style.backgroundColor = draft.accent;
                if (prevCardArt)    prevCardArt.style.backgroundColor = draft.accent;
                const statusBarColor = resolveStatusBarColor(draft, bgVars);
                if (prevCard) {
                    prevCard.style.borderTop = `4px solid ${statusBarColor}`;
                }
                const lyricMode = draft.lyricMode || 'accent';
                const lyricHex = (lyricMode === 'custom' && draft.lyricColor) ? draft.lyricColor : (draft.accent || '#30d66b');
                const lyricRgb = hexToRgb(lyricHex) || { r: 48, g: 214, b: 107 };
                const lyricSpoken = lightenHex(lyricHex, 0.82);
                if (prevLyricSpoken) prevLyricSpoken.style.color = lyricSpoken;
                if (prevLyricActive) {
                    prevLyricActive.style.textShadow = `0 0 8px rgba(${lyricRgb.r}, ${lyricRgb.g}, ${lyricRgb.b}, 0.65)`;
                }
            }

            function syncUI() {
                // 1. Accent
                accentPicker.value = draft.accent || '#30d66b';
                accentHexLabel.textContent = draft.accent || '#30d66b';
                presetsEl.querySelectorAll('.theme-swatch').forEach(sw => {
                    sw.classList.toggle('active', sw.dataset.accent.toLowerCase() === draft.accent.toLowerCase());
                });

                // 2. Sidebar / Navbar
                const currentSidebarMode = draft.sidebarMode || 'harmonize';
                sidebarOptionsEl.querySelectorAll('.theme-pill-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.sidebarMode === currentSidebarMode);
                });
                const isCustomSidebar = currentSidebarMode === 'custom';
                if (sidebarCustomRow) sidebarCustomRow.style.display = isCustomSidebar ? 'flex' : 'none';
                if (sidebarPicker && draft.sidebarCustom) sidebarPicker.value = draft.sidebarCustom;
                if (sidebarHexLabel && draft.sidebarCustom) sidebarHexLabel.textContent = draft.sidebarCustom;

                // 3. Background
                bgPresetsEl.querySelectorAll('.theme-bg-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.bg === (draft.bg || 'dark'));
                });
                const isCustomBg = draft.bg === 'custom';
                if (bgCustomRow) bgCustomRow.style.display = isCustomBg ? 'flex' : 'none';
                const curBgCustom = draft.bgCustom || '#070908';
                if (bgPicker) bgPicker.value = curBgCustom;
                if (bgHexLabel) bgHexLabel.textContent = curBgCustom;
                if (bgCustomPreview) bgCustomPreview.style.backgroundColor = curBgCustom;

                // 4. Cards & Boxes Style
                const currentCardMode = draft.cardMode || 'glass';
                if (cardOptionsEl) {
                    cardOptionsEl.querySelectorAll('.theme-pill-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.cardMode === currentCardMode);
                    });
                }
                const isCustomCard = currentCardMode === 'custom';
                if (cardCustomRow) cardCustomRow.style.display = isCustomCard ? 'flex' : 'none';
                if (cardPicker && draft.cardCustom) cardPicker.value = draft.cardCustom;
                if (cardHexLabel && draft.cardCustom) cardHexLabel.textContent = draft.cardCustom;

                // 5. Text / Font Color
                const currentText = draft.textColor || '#f5f7f5';
                if (textPicker) textPicker.value = currentText;
                if (textHexLabel) textHexLabel.textContent = currentText;
                if (textPresetsEl) {
                    textPresetsEl.querySelectorAll('.theme-swatch').forEach(sw => {
                        sw.classList.toggle('active', sw.dataset.text.toLowerCase() === currentText.toLowerCase());
                    });
                }

                // 6. PWA Status Bar / Border
                const currentStatusBarMode = draft.statusBarMode || 'accent';
                if (statusbarOptionsEl) {
                    statusbarOptionsEl.querySelectorAll('.theme-pill-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.statusbarMode === currentStatusBarMode);
                    });
                }
                const isCustomStatusBar = currentStatusBarMode === 'custom';
                if (statusbarCustomRow) statusbarCustomRow.style.display = isCustomStatusBar ? 'flex' : 'none';
                const curStatusBarCustom = draft.statusBarCustom || draft.accent || '#30d66b';
                if (statusbarPicker) statusbarPicker.value = curStatusBarCustom;
                if (statusbarHexLabel) statusbarHexLabel.textContent = curStatusBarCustom;

                // 7. Lyrics Highlight Color
                const currentLyricMode = draft.lyricMode || 'accent';
                if (lyricOptionsEl) {
                    lyricOptionsEl.querySelectorAll('.theme-pill-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.lyricMode === currentLyricMode);
                    });
                }
                const isCustomLyric = currentLyricMode === 'custom';
                if (lyricCustomRow) lyricCustomRow.style.display = isCustomLyric ? 'flex' : 'none';
                if (lyricPresetsEl) lyricPresetsEl.style.display = isCustomLyric ? 'flex' : 'none';
                const curLyricColor = draft.lyricColor || draft.accent || '#30d66b';
                if (lyricPicker) lyricPicker.value = curLyricColor;
                if (lyricHexLabel) lyricHexLabel.textContent = curLyricColor;
                if (lyricPresetsEl) {
                    lyricPresetsEl.querySelectorAll('.theme-swatch').forEach(sw => {
                        sw.classList.toggle('active', isCustomLyric && sw.dataset.lyric?.toLowerCase() === curLyricColor.toLowerCase());
                    });
                }

                // 8. Scale
                if (scaleRow) {
                    scaleRow.querySelectorAll('.theme-scale-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.scale === (draft.scale || '1.0'));
                    });
                }

                // 7. Mini Preview & Live Full-App Preview
                syncMiniPreview();
                applyTheme(draft);
            }

            function openModal() {
                initialTheme = { ...getCurrentTheme() };
                draft = { ...initialTheme };
                syncUI();
                modalEl.style.display = 'flex';
                modalEl.setAttribute('aria-hidden', 'false');
            }

            function closeModal(revert = false) {
                if (revert) {
                    applyTheme(initialTheme);
                }
                modalEl.style.display = 'none';
                modalEl.setAttribute('aria-hidden', 'true');
            }

            if (openBtn)  openBtn.addEventListener('click', openModal);
            if (quickBtn) quickBtn.addEventListener('click', openModal);
            if (closeBtn) closeBtn.addEventListener('click', () => closeModal(true));
            if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal(true));

            modalEl.addEventListener('click', e => {
                if (e.target === modalEl) closeModal(true);
            });

            // Accent presets
            presetsEl.addEventListener('click', e => {
                const sw = e.target.closest('.theme-swatch');
                if (!sw) return;
                draft.accent = sw.dataset.accent;
                draft.accentHover = sw.dataset.accentHover || lightenHex(sw.dataset.accent, 0.22);
                syncUI();
            });

            // Accent custom picker
            accentPicker.addEventListener('input', () => {
                draft.accent = accentPicker.value;
                draft.accentHover = lightenHex(accentPicker.value, 0.22);
                accentHexLabel.textContent = accentPicker.value;
                presetsEl.querySelectorAll('.theme-swatch').forEach(sw => sw.classList.remove('active'));
                syncUI();
            });

            // Sidebar / Navbar style pills
            sidebarOptionsEl.addEventListener('click', e => {
                const btn = e.target.closest('.theme-pill-btn');
                if (!btn) return;
                const mode = btn.dataset.sidebarMode;
                draft.sidebarMode = mode;
                if (mode === 'custom' && !draft.sidebarCustom) {
                    draft.sidebarCustom = '#0e110f';
                }
                syncUI();
                if (mode === 'custom' && sidebarPicker) {
                    sidebarPicker.click();
                }
            });

            // Sidebar custom picker
            if (sidebarPicker) {
                sidebarPicker.addEventListener('input', () => {
                    draft.sidebarMode = 'custom';
                    draft.sidebarCustom = sidebarPicker.value;
                    if (sidebarHexLabel) sidebarHexLabel.textContent = sidebarPicker.value;
                    syncUI();
                });
            }

            // Main Background presets
            bgPresetsEl.addEventListener('click', e => {
                const btn = e.target.closest('.theme-bg-btn');
                if (!btn) return;
                draft.bg = btn.dataset.bg;
                if (draft.bg === 'custom') {
                    if (!draft.bgCustom) {
                        draft.bgCustom = BG_CONFIGS['dark']['--bg-main'];
                    }
                    syncUI();
                    if (bgPicker) bgPicker.click();
                } else {
                    syncUI();
                }
            });

            // Main Background custom picker
            if (bgPicker) {
                bgPicker.addEventListener('input', () => {
                    draft.bg = 'custom';
                    draft.bgCustom = bgPicker.value;
                    if (bgHexLabel) bgHexLabel.textContent = bgPicker.value;
                    if (bgCustomPreview) bgCustomPreview.style.backgroundColor = bgPicker.value;
                    syncUI();
                });
            }

            // Cards & Boxes style pills
            if (cardOptionsEl) {
                cardOptionsEl.addEventListener('click', e => {
                    const btn = e.target.closest('.theme-pill-btn');
                    if (!btn) return;
                    const mode = btn.dataset.cardMode;
                    draft.cardMode = mode;
                    if (mode === 'custom' && !draft.cardCustom) {
                        draft.cardCustom = '#16181b';
                    }
                    syncUI();
                    if (mode === 'custom' && cardPicker) {
                        cardPicker.click();
                    }
                });
            }

            // Cards & Boxes custom picker
            if (cardPicker) {
                cardPicker.addEventListener('input', () => {
                    draft.cardMode = 'custom';
                    draft.cardCustom = cardPicker.value;
                    if (cardHexLabel) cardHexLabel.textContent = cardPicker.value;
                    syncUI();
                });
            }

            // Text / Font Color presets
            if (textPresetsEl) {
                textPresetsEl.addEventListener('click', e => {
                    const sw = e.target.closest('.theme-swatch');
                    if (!sw) return;
                    draft.textColor = sw.dataset.text;
                    syncUI();
                });
            }

            // Text / Font Color custom picker
            if (textPicker) {
                textPicker.addEventListener('input', () => {
                    draft.textColor = textPicker.value;
                    if (textHexLabel) textHexLabel.textContent = textPicker.value;
                    if (textPresetsEl) {
                        textPresetsEl.querySelectorAll('.theme-swatch').forEach(sw => sw.classList.remove('active'));
                    }
                    syncUI();
                });
            }

            // PWA Status Bar / Border mode pills
            if (statusbarOptionsEl) {
                statusbarOptionsEl.addEventListener('click', e => {
                    const btn = e.target.closest('.theme-pill-btn');
                    if (!btn) return;
                    const mode = btn.dataset.statusbarMode;
                    draft.statusBarMode = mode;
                    if (mode === 'custom' && !draft.statusBarCustom) {
                        draft.statusBarCustom = draft.accent || '#30d66b';
                    }
                    syncUI();
                    if (mode === 'custom' && statusbarPicker) {
                        statusbarPicker.click();
                    }
                });
            }

            // PWA Status Bar / Border custom picker
            if (statusbarPicker) {
                statusbarPicker.addEventListener('input', () => {
                    draft.statusBarMode = 'custom';
                    draft.statusBarCustom = statusbarPicker.value;
                    if (statusbarHexLabel) statusbarHexLabel.textContent = statusbarPicker.value;
                    syncUI();
                });
            }

            // Lyrics mode pills
            if (lyricOptionsEl) {
                lyricOptionsEl.addEventListener('click', e => {
                    const btn = e.target.closest('.theme-pill-btn');
                    if (!btn) return;
                    const mode = btn.dataset.lyricMode;
                    draft.lyricMode = mode;
                    if (mode === 'custom' && !draft.lyricColor) {
                        draft.lyricColor = draft.accent || '#30d66b';
                    }
                    syncUI();
                });
            }

            // Lyrics presets
            if (lyricPresetsEl) {
                lyricPresetsEl.addEventListener('click', e => {
                    const sw = e.target.closest('.theme-swatch');
                    if (!sw) return;
                    draft.lyricMode = 'custom';
                    draft.lyricColor = sw.dataset.lyric;
                    syncUI();
                });
            }

            // Lyrics custom picker
            if (lyricPicker) {
                lyricPicker.addEventListener('input', () => {
                    draft.lyricMode = 'custom';
                    draft.lyricColor = lyricPicker.value;
                    if (lyricHexLabel) lyricHexLabel.textContent = lyricPicker.value;
                    if (lyricPresetsEl) {
                        lyricPresetsEl.querySelectorAll('.theme-swatch').forEach(sw => sw.classList.remove('active'));
                    }
                    syncUI();
                });
            }

            // Scale buttons
            if (scaleRow) {
                scaleRow.addEventListener('click', e => {
                    const btn = e.target.closest('.theme-scale-btn');
                    if (!btn) return;
                    draft.scale = btn.dataset.scale;
                    syncUI();
                });
            }

            // Save Theme Button
            applyBtn.addEventListener('click', () => {
                applyTheme(draft);
                saveTheme(draft);
                closeModal(false);
                if (typeof showToast === 'function') {
                    showToast('Theme saved successfully!', 'success');
                }
            });

            // Reset Default Button
            resetBtn.addEventListener('click', () => {
                draft = {
                    accent: '#30d66b',
                    accentHover: '#55e584',
                    bg: 'dark',
                    bgCustom: '#070908',
                    sidebarMode: 'harmonize',
                    sidebarCustom: '#0e110f',
                    cardMode: 'glass',
                    cardCustom: '#16181b',
                    textColor: '#f5f7f5',
                    statusBarMode: 'accent',
                    statusBarCustom: '#30d66b',
                    lyricMode: 'accent',
                    lyricColor: '#30d66b',
                    scale: '1.0'
                };
                applyTheme(draft);
                saveTheme(draft);
                syncUI();
                if (typeof showToast === 'function') {
                    showToast('Theme reset to default.', 'info');
                }
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initThemeManager);
        } else {
            initThemeManager();
        }
    })();
