// ==========================================
// LYRICS & SHARE LYRICS CARD MODULE
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const el = window.el || {};
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));
    const escapeHtml = window.escapeHtml || ((s) => s);
    const formatTime = window.formatTime || ((s) => s);
    const mediaUrlName = window.mediaUrlName || ((s) => s);
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
    const loadCanvasImage = window.loadCanvasImage || function(src) {
        return new Promise((resolve) => {
            if (!src) return resolve(null);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    };
    const drawRoundedImage = window.drawRoundedImage || function(ctx, img, x, y, size, radius) {
        ctx.save();
        drawRoundRect(ctx, x, y, size, size, radius);
        ctx.clip();
        const sourceSize = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
        const sx = ((img.naturalWidth || img.width) - sourceSize) / 2;
        const sy = ((img.naturalHeight || img.height) - sourceSize) / 2;
        ctx.drawImage(img, sx, sy, sourceSize, sourceSize, x, y, size, size);
        ctx.restore();
    };
    const drawCoverFallback = window.drawCoverFallback || function(ctx, x, y, size, radius = 18) {
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
    };
    const drawStar = window.drawStar || function(ctx, cx, cy, outerRadius, innerRadius) {
        ctx.beginPath();
        for (let point = 0; point < 10; point += 1) {
            const angle = -Math.PI / 2 + point * Math.PI / 5;
            const radius = point % 2 ? innerRadius : outerRadius;
            const x = cx + Math.cos(angle) * radius;
            const y = cy + Math.sin(angle) * radius;
            point ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
    };
    const fitCanvasText = window.fitCanvasText || function(ctx, text, maxWidth) {
        const value = String(text || '');
        if (ctx.measureText(value).width <= maxWidth) return value;
        let trimmed = value;
        while (trimmed.length > 1 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
            trimmed = trimmed.slice(0, -1);
        }
        return `${trimmed.trim()}...`;
    };
    const wrapCanvasLines = window.wrapCanvasLines || function(ctx, text, maxWidth, maxLines = 2) {
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
    };
    const seekAudio = (pos) => (window.seekAudio ? window.seekAudio(pos) : (el.audio ? el.audio.currentTime = pos : undefined));
    const isOfflineMode = () => (window.isOfflineMode ? window.isOfflineMode() : (state.offlineMode || !navigator.onLine));
    const getOfflinePlaylist = (id) => (window.getOfflinePlaylist ? window.getOfflinePlaylist(id) : Promise.resolve(null));

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
    window.parseLRC = parseLRC;

    function parseWordSyncedLyrics(value) {
        if (!value) return [];
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    window.parseWordSyncedLyrics = parseWordSyncedLyrics;

    function setLyricsStatus(message) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = message;
    }

    function setLyricsEditing(isEditing) {
        state.lyricsEditing = isEditing;
        el.lyricsPanel?.classList.toggle('is-editing', isEditing);
        if (el.lyricsBody) el.lyricsBody.style.display = isEditing ? 'none' : '';
        if (el.lyricsEditor) el.lyricsEditor.style.display = isEditing ? 'flex' : 'none';
        if (el.lyricsEditBtn) el.lyricsEditBtn.style.display = isEditing || !state.currentLyricsSongId ? 'none' : '';
        if (el.lyricsCancelEditBtn) el.lyricsCancelEditBtn.style.display = isEditing ? '' : 'none';
        if (el.lyricsSaveBtn) el.lyricsSaveBtn.style.display = isEditing ? '' : 'none';
        if (el.lyricsRetryBtn) el.lyricsRetryBtn.style.display = isEditing ? 'none' : '';
        if (isEditing) {
            if (el.lyricsPlainInput) {
                el.lyricsPlainInput.value = state.plainLyrics || '';
                el.lyricsPlainInput.scrollTop = 0;
            }
            if (el.lyricsSyncedInput) {
                el.lyricsSyncedInput.value = state.rawSyncedLyrics || '';
                el.lyricsSyncedInput.scrollTop = 0;
            }
            if (el.lyricsEditor) el.lyricsEditor.scrollTop = 0;
            el.lyricsPlainInput?.focus({preventScroll: true});
            if (el.lyricsPlainInput) {
                el.lyricsPlainInput.setSelectionRange(0, 0);
                el.lyricsPlainInput.scrollTop = 0;
            }
            requestAnimationFrame(() => {
                if (!state.lyricsEditing) return;
                if (el.lyricsEditor) el.lyricsEditor.scrollTop = 0;
                if (el.lyricsPlainInput) el.lyricsPlainInput.scrollTop = 0;
                if (el.lyricsSyncedInput) el.lyricsSyncedInput.scrollTop = 0;
            });
            setTimeout(() => {
                if (!state.lyricsEditing) return;
                if (el.lyricsEditor) el.lyricsEditor.scrollTop = 0;
                if (el.lyricsPlainInput) el.lyricsPlainInput.scrollTop = 0;
                if (el.lyricsSyncedInput) el.lyricsSyncedInput.scrollTop = 0;
            }, 120);
            setLyricsStatus('Editing lyrics for this song.');
        }
    }

    function openLyricsPanel() {
        state.lyricsPanelOpen = true;
        document.body.classList.add('lyrics-panel-open');
        el.lyricsPanel?.classList.add('open');
        el.lyricsBtn?.classList.add('active');
        el.lyricsPanel?.setAttribute('aria-hidden', 'false');
        if (state.currentLyricsSongId) {
            renderLyricsPanel();
            updateSyncedLyrics(true);
        }
    }

    function closeLyricsPanel() {
        state.lyricsPanelOpen = false;
        document.body.classList.remove('lyrics-panel-open');
        el.lyricsPanel?.classList.remove('open');
        el.lyricsBtn?.classList.remove('active');
        el.lyricsPanel?.setAttribute('aria-hidden', 'true');
    }

    function renderLyricWords(text, timedWords = []) {
        if (timedWords.length) {
            return timedWords.map((word, index) => (
                `<span class="lyric-word" data-word-index="${index}" data-start="${word.start}" data-end="${word.end}">${[...(word.text || '')].map((character, characterIndex) => (
                    `<span class="lyric-char" data-char-index="${characterIndex}">${escapeHtml(character)}</span>`
                )).join('')}</span>`
            )).join(' ');
        }
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return '&nbsp;';
        return words.map((word, index) => (
            `<span class="lyric-word" data-word-index="${index}">${[...word].map((character, characterIndex) => (
                `<span class="lyric-char" data-char-index="${characterIndex}">${escapeHtml(character)}</span>`
            )).join('')}</span>`
        )).join(' ');
    }

    function updatePlayerLyric(markup, text, progress = 0) {
        if (!el.playerLyric) return;
        if (!text) {
            el.playerLyric.hidden = true;
            el.playerLyric.classList.remove('is-overflowing');
            return;
        }
        let content = el.playerLyric.querySelector('.player-lyric-content');
        if (!content) {
            content = document.createElement('span');
            content.className = 'player-lyric-content';
            el.playerLyric.replaceChildren(content);
        }
        const lyricChanged = content.dataset.lyricText !== text;
        if (lyricChanged) {
            content.innerHTML = markup;
            content.dataset.lyricText = text;
        } else {
            const incoming = document.createElement('template');
            incoming.innerHTML = markup;
            const currentWords = content.querySelectorAll('.lyric-word');
            const incomingWords = incoming.content.querySelectorAll('.lyric-word');
            if (currentWords.length !== incomingWords.length) {
                content.innerHTML = markup;
            } else {
                incomingWords.forEach((word, index) => {
                    const currentWord = currentWords[index];
                    currentWord.className = word.className;
                    currentWord.style.cssText = word.style.cssText;
                    const currentChars = currentWord.querySelectorAll('.lyric-char');
                    word.querySelectorAll('.lyric-char').forEach((character, charIndex) => {
                        if (!currentChars[charIndex]) return;
                        currentChars[charIndex].className = character.className;
                    });
                });
            }
        }
        el.playerLyric.hidden = false;
        const distance = Math.max(0, content.scrollWidth - el.playerLyric.clientWidth);
        if (distance > 4) {
            el.playerLyric.style.setProperty('--player-lyric-distance', `${distance}px`);
            el.playerLyric.style.setProperty('--player-lyric-duration', `${Math.max(7, distance / 18)}s`);
            if (lyricChanged) {
                content.style.animation = 'none';
                content.offsetWidth;
                content.style.animation = '';
            }
            el.playerLyric.classList.add('is-overflowing');
        } else {
            el.playerLyric.classList.remove('is-overflowing');
            el.playerLyric.style.removeProperty('--player-lyric-distance');
            el.playerLyric.style.removeProperty('--player-lyric-duration');
        }
    }

    function resetPlayerLyric() {
        if (!el.playerLyric) return;
        el.playerLyric.replaceChildren();
        el.playerLyric.hidden = true;
        el.playerLyric.classList.remove('is-overflowing');
        el.playerLyric.style.removeProperty('--player-lyric-distance');
        el.playerLyric.style.removeProperty('--player-lyric-duration');
    }

    function renderLyricsPanel() {
        if (!el.lyricsBody || !el.lyricsTitle || !el.lyricsSubtitle) return;

        el.lyricsPanel?.classList.toggle('lyrics-focus-mode', state.lyricsFocusMode);
        el.lyricsPanel?.classList.toggle('lyrics-line-animation', state.lyricsAnimationMode === 'line');
        el.lyricsFocusBtn?.classList.toggle('active', state.lyricsFocusMode);
        el.lyricsFocusBtn?.setAttribute('aria-pressed', String(state.lyricsFocusMode));

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
                const timedWords = state.wordSyncedLyrics[index]?.words || [];
                return `<button type="button" class="lyric-line" data-index="${index}" data-timestamp="${line.timestamp}">${renderLyricWords(line.text, timedWords)}</button>`;
            }).join('');
            el.lyricsBody.innerHTML = `<div class="lyrics-lines">${html}</div>`;
            el.lyricsBody.querySelectorAll('.lyric-line').forEach((lineBtn) => {
                lineBtn.addEventListener('click', () => {
                    const timestamp = Number.parseFloat(lineBtn.dataset.timestamp || '0');
                    if (!Number.isFinite(timestamp)) return;
                    seekAudio(timestamp);
                    updateSyncedLyrics(true);
                });
            });
            setLyricsStatus('Tap a line to seek.');
            updateSyncedLyrics(true);
            return;
        }

        if (hasPlain) {
            el.lyricsBody.innerHTML = `<div class="lyrics-plain">${escapeHtml(state.plainLyrics).replace(/\n/g, '<br>')}</div>`;
            const firstPlainLine = state.plainLyrics.split(/\r?\n/).find((line) => line.trim())?.trim() || '';
            updatePlayerLyric(renderLyricWords(firstPlainLine), firstPlainLine);
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

    let lyricAnimationFrameId = null;

    function stopLyricAnimation() {
        if (lyricAnimationFrameId !== null) {
            cancelAnimationFrame(lyricAnimationFrameId);
            lyricAnimationFrameId = null;
        }
    }

    function animateSyncedLyrics() {
        updateSyncedLyrics();
        if (!el.audio.paused && !el.audio.ended) {
            lyricAnimationFrameId = requestAnimationFrame(animateSyncedLyrics);
        } else {
            lyricAnimationFrameId = null;
        }
    }

    function startLyricAnimation() {
        if (lyricAnimationFrameId === null) {
            lyricAnimationFrameId = requestAnimationFrame(animateSyncedLyrics);
        }
    }

    function updateSyncedLyrics(forceScroll = false) {
        if (!el.lyricsBody || !Array.isArray(state.syncedLyrics) || state.syncedLyrics.length === 0) return;
        if (!el.lyricsBody.querySelector('.lyric-line') && state.currentLyricsSongId) {
            renderLyricsPanel();
        }

        const currentTime = el.audio.currentTime || 0;
        let activeIndex = -1;
        for (let i = 0; i < state.syncedLyrics.length; i += 1) {
            if (state.syncedLyrics[i].timestamp <= currentTime) {
                activeIndex = i;
            } else {
                break;
            }
        }

        const lyricIndexChanged = activeIndex !== state.currentLyricIndex;
        state.currentLyricIndex = activeIndex;

        const lineButtons = el.lyricsBody.querySelectorAll('.lyric-line');
        const activeLine = activeIndex >= 0 ? state.syncedLyrics[activeIndex] : null;
        const activeTimedWords = activeIndex >= 0 ? (state.wordSyncedLyrics[activeIndex]?.words || []) : [];
        const nextTimestamp = activeIndex >= 0 && activeIndex + 1 < state.syncedLyrics.length
            ? state.syncedLyrics[activeIndex + 1].timestamp
            : (el.audio.duration || currentTime + 4);
        const lineDuration = Math.max(0.6, nextTimestamp - (activeLine?.timestamp || currentTime));
        const lyricProgress = activeLine ? Math.max(0, Math.min(1, (currentTime - activeLine.timestamp) / lineDuration)) : 0;

        lineButtons.forEach((btn, index) => {
            const isActive = index === activeIndex;
            const wasActive = btn.classList.contains('active');
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('past', index < activeIndex);

            if (isActive) {
                const words = btn.querySelectorAll('.lyric-word');
                if (activeTimedWords.length && words.length === activeTimedWords.length) {
                    words.forEach((wordEl, wordIndex) => {
                        const word = activeTimedWords[wordIndex];
                        const wordStart = word.start;
                        const wordEnd = word.end;
                        const isPastWord = currentTime >= wordEnd;
                        const isCurrentWord = currentTime >= wordStart && currentTime < wordEnd;
                        wordEl.classList.toggle('active', isCurrentWord);
                        wordEl.classList.toggle('past', isPastWord);
                        const chars = wordEl.querySelectorAll('.lyric-char');
                        const charCount = chars.length;
                        if (!charCount) return;
                        if (isPastWord) {
                            chars.forEach((charEl) => {
                                charEl.classList.add('past');
                                charEl.classList.remove('active');
                            });
                        } else if (isCurrentWord) {
                            const wordDuration = Math.max(0.12, wordEnd - wordStart);
                            const wordProgress = Math.max(0, Math.min(1, (currentTime - wordStart) / wordDuration));
                            const activeCharCount = Math.floor(wordProgress * charCount);
                            chars.forEach((charEl, charIndex) => {
                                charEl.classList.toggle('past', charIndex < activeCharCount);
                                charEl.classList.toggle('active', charIndex === activeCharCount);
                            });
                        } else {
                            chars.forEach((charEl) => {
                                charEl.classList.remove('past', 'active');
                            });
                        }
                    });
                } else if (words.length) {
                    const activeWordCount = Math.floor(lyricProgress * words.length);
                    words.forEach((wordEl, wordIndex) => {
                        const isPastWord = wordIndex < activeWordCount;
                        const isCurrentWord = wordIndex === activeWordCount;
                        wordEl.classList.toggle('past', isPastWord);
                        wordEl.classList.toggle('active', isCurrentWord);
                        const chars = wordEl.querySelectorAll('.lyric-char');
                        const charCount = chars.length;
                        if (!charCount) return;
                        if (isPastWord) {
                            chars.forEach((charEl) => {
                                charEl.classList.add('past');
                                charEl.classList.remove('active');
                            });
                        } else if (isCurrentWord) {
                            const wordSpan = 1 / Math.max(1, words.length);
                            const wordProgress = Math.max(0, Math.min(1, (lyricProgress - (wordIndex * wordSpan)) / wordSpan));
                            const activeCharCount = Math.floor(wordProgress * charCount);
                            chars.forEach((charEl, charIndex) => {
                                charEl.classList.toggle('past', charIndex < activeCharCount);
                                charEl.classList.toggle('active', charIndex === activeCharCount);
                            });
                        } else {
                            chars.forEach((charEl) => {
                                charEl.classList.remove('past', 'active');
                            });
                        }
                    });
                }
            } else if (wasActive) {
                btn.querySelectorAll('.lyric-word').forEach((wordEl) => {
                    wordEl.classList.remove('active');
                    wordEl.classList.toggle('past', index < activeIndex);
                });
                btn.querySelectorAll('.lyric-char').forEach((charEl) => {
                    charEl.classList.remove('active');
                    charEl.classList.toggle('past', index < activeIndex);
                });
            }
        });

        if (activeIndex >= 0) {
            const currentLine = state.syncedLyrics[activeIndex];
            const activeTimedWords = state.wordSyncedLyrics[activeIndex]?.words || [];
            const currentLyricText = currentLine.text || '';
            const currentLyricMarkup = renderLyricWords(currentLyricText, activeTimedWords);
            updatePlayerLyric(currentLyricMarkup, currentLyricText, lyricProgress);
        } else {
            resetPlayerLyric();
        }

        if (activeIndex >= 0 && (lyricIndexChanged || forceScroll)) {
            const activeBtn = lineButtons[activeIndex];
            if (activeBtn) {
                activeBtn.scrollIntoView({
                    behavior: forceScroll ? 'auto' : 'smooth',
                    block: 'center'
                });
            }
        }
    }

    async function loadLyrics(songId, forceRefresh = false) {
        if (!songId) return;
        if (String(state.currentLyricsSongId) === String(songId) && !forceRefresh) {
            if (state.lyricsPanelOpen) renderLyricsPanel();
            updateSyncedLyrics(true);
            return;
        }

        const requestToken = (state.lyricsRequestToken || 0) + 1;
        state.lyricsRequestToken = requestToken;

        state.currentLyricsSongId = songId;
        state.syncedLyrics = [];
        state.wordSyncedLyrics = [];
        state.plainLyrics = '';
        state.rawSyncedLyrics = '';
        state.lyricsStatusValue = 'none';
        state.currentLyricIndex = -1;
        state.lyricsLoading = true;
        resetPlayerLyric();
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
            if (isOfflineMode()) {
                const playlist = await getOfflinePlaylist(state.currentPlaylistId);
                const data = playlist?.lyrics?.[songId];
                if (!data) throw new Error('Lyrics were not saved offline');
                if (requestToken !== state.lyricsRequestToken || String(state.currentPlayingSongId) !== String(songId)) return;
                state.plainLyrics = data.lyrics || '';
                state.rawSyncedLyrics = data.synced_lyrics || '';
                state.syncedLyrics = parseLRC(state.rawSyncedLyrics);
                state.wordSyncedLyrics = parseWordSyncedLyrics(data.word_synced_lyrics);
                state.lyricsStatusValue = data.lyrics_status || 'none';
                const song = state.currentPlaylistSongs.find(item => String(item.id) === String(songId));
                if (el.lyricsTitle) el.lyricsTitle.textContent = song?.title || 'Lyrics';
                if (el.lyricsSubtitle) el.lyricsSubtitle.textContent = song?.artist || 'Saved for offline';
                renderLyricsPanel();
                updateSyncedLyrics(true);
                return;
            }
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
            state.wordSyncedLyrics = parseWordSyncedLyrics(data.word_synced_lyrics);
            state.lyricsStatusValue = data.lyrics_status || 'none';

            const song = state.currentSongMeta && String(state.currentSongMeta.id) === String(songId)
                ? state.currentSongMeta
                : state.currentPlaylistSongs.find(item => String(item.id) === String(songId)) || null;

            if (el.lyricsTitle) el.lyricsTitle.textContent = song?.title || 'Lyrics';
            if (el.lyricsSubtitle) {
                el.lyricsSubtitle.textContent = song?.artist ? `${song.artist}${song.duration_seconds ? ` - ${formatTime(song.duration_seconds)}` : ''}` : 'Cached lyrics';
            }

            renderLyricsPanel();
            updateSyncedLyrics(true);
        } catch (err) {
            if (requestToken !== state.lyricsRequestToken || String(state.currentPlayingSongId) !== String(songId)) {
                return;
            }
            state.syncedLyrics = [];
            state.wordSyncedLyrics = [];
            state.plainLyrics = '';
            state.rawSyncedLyrics = '';
            state.lyricsStatusValue = 'not_found';
            resetPlayerLyric();
            renderLyricsPanel();
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
            if (requestToken === state.lyricsRequestToken) state.lyricsLoading = false;
        }
    }

    async function saveManualLyrics() {
        if (!state.currentLyricsSongId) return;
        if (isOfflineMode()) {
            showToast('Lyrics cannot be edited while offline', 'error');
            return;
        }
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
            state.wordSyncedLyrics = [];
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

    function drawHeart(ctx, cx, cy, size) {
        const top = cy - size * 0.28;
        ctx.beginPath();
        ctx.moveTo(cx, cy + size * 0.46);
        ctx.bezierCurveTo(cx - size * 1.05, cy - size * 0.18, cx - size * 0.56, top - size * 0.55, cx, top);
        ctx.bezierCurveTo(cx + size * 0.56, top - size * 0.55, cx + size * 1.05, cy - size * 0.18, cx, cy + size * 0.46);
        ctx.closePath();
    }

    function drawShareDecoration(ctx, width, height) {
        const image = state.shareLyricsDecorationImage;
        if (state.shareLyricsDecoration === 'custom' && image) {
            ctx.save();
            ctx.globalAlpha = 0.22;
            ctx.drawImage(image, width - 390, 34, 330, 330);
            ctx.drawImage(image, -90, height - 330, 270, 270);
            ctx.restore();
            return;
        }
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.14)';
        if (state.shareLyricsDecoration === 'heart') {
            drawHeart(ctx, width * 0.88, height * 0.14, 190);
            ctx.fill();
            drawHeart(ctx, width * 0.08, height * 0.88, 220);
            ctx.fill();
        } else if (state.shareLyricsDecoration === 'star') {
            drawStar(ctx, width * 0.9, height * 0.12, 240, 106);
            ctx.fill();
            drawStar(ctx, width * 0.08, height * 0.9, 285, 126);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.arc(width * 0.92, height * 0.08, 260, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(width * 0.08, height * 0.92, 320, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function selectCustomDecoration(image) {
        state.shareLyricsDecorationImage = image;
        state.shareLyricsDecoration = 'custom';
        document.querySelectorAll('.share-decoration').forEach(item => item.classList.remove('active'));
        state.shareRenderPromise = renderShareLyricsCanvas();
    }

    function initShareDrawingCanvas() {
        const canvas = el.shareDrawingCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let drawing = false;
        let lastPoint = null;
        const pointFromEvent = (event) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (event.clientX - rect.left) * (canvas.width / rect.width),
                y: (event.clientY - rect.top) * (canvas.height / rect.height)
            };
        };
        const renderDrawing = () => selectCustomDecoration(canvas);
        canvas.addEventListener('pointerdown', (event) => {
            drawing = true;
            canvas.setPointerCapture(event.pointerId);
            lastPoint = pointFromEvent(event);
            ctx.fillStyle = el.shareDrawingColor?.value || '#ffffff';
            ctx.beginPath();
            ctx.arc(lastPoint.x, lastPoint.y, 5, 0, Math.PI * 2);
            ctx.fill();
            renderDrawing();
        });
        canvas.addEventListener('pointermove', (event) => {
            if (!drawing || !lastPoint) return;
            const point = pointFromEvent(event);
            ctx.strokeStyle = el.shareDrawingColor?.value || '#ffffff';
            ctx.lineWidth = 10;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(lastPoint.x, lastPoint.y);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
            lastPoint = point;
            renderDrawing();
        });
        const stopDrawing = () => { drawing = false; lastPoint = null; };
        canvas.addEventListener('pointerup', stopDrawing);
        canvas.addEventListener('pointercancel', stopDrawing);
        el.shareDrawingClear?.addEventListener('click', () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (state.shareLyricsDecorationImage === canvas) {
                state.shareLyricsDecoration = 'circle';
                document.querySelectorAll('.share-decoration').forEach(item => item.classList.toggle('active', item.dataset.decoration === 'circle'));
                state.shareRenderPromise = renderShareLyricsCanvas();
            }
        });
    }

    async function renderShareLyricsCanvas() {
        const canvas = el.shareLyricsCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const colors = state.shareLyricsTheme === 'custom'
            ? state.shareLyricsCustomColors
            : (shareThemes[state.shareLyricsTheme] || shareThemes.verde);
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

        drawShareDecoration(ctx, width, height);

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

    // Export public functions
    window.setLyricsStatus = setLyricsStatus;
    window.setLyricsEditing = setLyricsEditing;
    window.openLyricsPanel = openLyricsPanel;
    window.closeLyricsPanel = closeLyricsPanel;
    window.renderLyricWords = renderLyricWords;
    window.updatePlayerLyric = updatePlayerLyric;
    window.resetPlayerLyric = resetPlayerLyric;
    window.renderLyricsPanel = renderLyricsPanel;
    window.stopLyricAnimation = stopLyricAnimation;
    window.startLyricAnimation = startLyricAnimation;
    window.updateSyncedLyrics = updateSyncedLyrics;
    window.loadLyrics = loadLyrics;
    window.saveManualLyrics = saveManualLyrics;
    window.openShareLyricsModal = openShareLyricsModal;
    window.closeShareLyricsModal = closeShareLyricsModal;
    window.updateShareLyricsText = updateShareLyricsText;
    window.renderShareLyricsCanvas = renderShareLyricsCanvas;
    window.downloadShareLyrics = downloadShareLyrics;
    window.copyShareLyrics = copyShareLyrics;

    // Lyrics panel event listeners
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
    el.lyricsFocusBtn?.addEventListener('click', () => {
        state.lyricsFocusMode = !state.lyricsFocusMode;
        renderLyricsPanel();
        updateSyncedLyrics(true);
    });
    el.lyricsShareBtn?.addEventListener('click', openShareLyricsModal);
    el.lyricsAnimationBtn?.addEventListener('click', () => {
        const isOpen = el.lyricsAnimationMenu?.classList.contains('active');
        el.lyricsAnimationMenu?.classList.toggle('active', !isOpen);
        el.lyricsAnimationMenu?.setAttribute('aria-hidden', String(isOpen));
        el.lyricsAnimationBtn?.setAttribute('aria-expanded', String(!isOpen));
    });
    el.lyricsAnimationMenu?.querySelectorAll('[data-lyrics-animation]').forEach((button) => {
        button.addEventListener('click', () => {
            state.lyricsAnimationMode = button.dataset.lyricsAnimation === 'line' ? 'line' : 'detail';
            el.lyricsAnimationMenu.querySelectorAll('[data-lyrics-animation]').forEach((item) => {
                const selected = item === button;
                item.classList.toggle('active', selected);
                item.setAttribute('aria-checked', String(selected));
            });
            el.lyricsAnimationMenu.classList.remove('active');
            el.lyricsAnimationMenu.setAttribute('aria-hidden', 'true');
            el.lyricsAnimationBtn?.setAttribute('aria-expanded', 'false');
            renderLyricsPanel();
            updateSyncedLyrics(true);
        });
    });
    document.addEventListener('click', (event) => {
        if (el.lyricsAnimationMenu && !event.target.closest('.lyrics-animation-menu-wrap')) {
            el.lyricsAnimationMenu.classList.remove('active');
            el.lyricsAnimationMenu.setAttribute('aria-hidden', 'true');
            el.lyricsAnimationBtn?.setAttribute('aria-expanded', 'false');
        }
    });
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

    // Share lyrics modal event listeners
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
    const applyCustomThemeColor = (value, index) => {
        state.shareLyricsCustomColors[index] = value;
        state.shareLyricsTheme = 'custom';
        document.querySelectorAll('.share-theme').forEach(item => item.classList.remove('active'));
        state.shareRenderPromise = renderShareLyricsCanvas();
    };

    const normalizeHexColor = (value) => {
        const hex = String(value || '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(hex)) {
            return `#${hex.split('').map(char => char + char).join('').toUpperCase()}`;
        }
        return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
    };

    const colorPickers = [el.shareThemeStart, el.shareThemeEnd];
    const hexInputs = [el.shareThemeStartHex, el.shareThemeEndHex];
    colorPickers.forEach((input, index) => {
        input?.addEventListener('input', () => {
            const value = input.value.toUpperCase();
            if (hexInputs[index]) hexInputs[index].value = value;
            applyCustomThemeColor(value, index);
        });
    });
    hexInputs.forEach((input, index) => {
        input?.addEventListener('input', () => {
            const value = normalizeHexColor(input.value);
            input.classList.toggle('invalid', !value);
            input.setAttribute('aria-invalid', String(!value));
            if (!value) return;
            colorPickers[index].value = value;
            applyCustomThemeColor(value, index);
        });
        input?.addEventListener('blur', () => {
            const value = normalizeHexColor(input.value);
            if (value) input.value = value;
        });
    });
    document.querySelectorAll('.share-decoration').forEach((button) => {
        button.addEventListener('click', () => {
            const decoration = button.dataset.decoration;
            if (!decoration) return;
            document.querySelectorAll('.share-decoration').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            state.shareLyricsDecoration = decoration;
            state.shareRenderPromise = renderShareLyricsCanvas();
        });
    });
    el.shareDecorationUpload?.addEventListener('change', () => {
        const file = el.shareDecorationUpload.files?.[0];
        if (!file) return;
        if (state.shareLyricsDecorationImageUrl) URL.revokeObjectURL(state.shareLyricsDecorationImageUrl);
        state.shareLyricsDecorationImageUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            selectCustomDecoration(image);
            el.shareDecorationUpload.closest('.share-decoration')?.classList.add('active');
        };
        image.onerror = () => showToast('Unable to use that image', 'error');
        image.src = state.shareLyricsDecorationImageUrl;
    });
    initShareDrawingCanvas();
});
})();
