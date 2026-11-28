// ==========================================
// 16-BAND GRAPHIC EQUALIZER MODULE (Web Audio API)
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const el = window.el || {};
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));

    const EQ_FREQUENCIES = [32, 64, 125, 250, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
    const EQ_PRESETS = {
        flat:       [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
        bass:       [8,7,6,5,3,2,1,0,0,0,0,0,0,0,-1,-2],
        treble:     [-2,-1,0,0,0,0,0,0,0,1,2,3,4,6,7,8],
        rock:       [5,4,3,1,0,-1,-1,0,1,2,3,3,2,1,2,3],
        pop:        [-1,0,2,4,4,2,0,-1,-1,0,1,2,2,1,0,-1],
        jazz:       [3,2,1,1,1,1,2,3,2,1,0,0,1,2,3,3],
        classical:  [4,3,2,1,0,0,0,0,0,0,1,2,3,4,4,3],
        vocal:      [-2,-1,0,1,3,4,4,3,2,1,0,-1,0,1,2,1],
        electronic: [5,4,3,1,0,1,2,3,3,2,0,1,2,3,5,6],
        acoustic:   [3,2,1,0,1,2,3,2,1,0,1,2,2,3,2,1],
    };
    const eqUserId = String(document.body?.dataset?.userId || '').trim();
    const EQ_STORAGE_KEY = eqUserId ? `psr_eq_state_v1_${eqUserId}` : 'psr_eq_state_v1';

    // Extend state for EQ, Volume Normalization, and AutoEQ
    state.eqEnabled = false;
    state.eqGains = [...EQ_PRESETS.flat];
    state.eqPreamp = 0;
    state.eqPreset = 'flat';
    state.normEnabled = false;
    state.autoEqEnabled = false;
    state.autoEqPreamp = 0;
    state.autoEqFilters = [];
    state.autoEqRawText = '';

    let eqAudioContext = null;
    let eqSource = null;
    let eqFilters = [];
    let autoEqFilterNodes = [];
    let eqPreampNode = null;
    let eqFilterTail = null;
    let normCompressorNode = null;
    let normMakeupGainNode = null;
    let eqAnalyser = null;
    let masterGainNode = null;

    function parseAutoEqText(rawText) {
        const lines = String(rawText || '').split(/\r?\n/);
        let preamp = 0;
        const filters = [];
        const typeMap = {
            PK: 'peaking',
            PEQ: 'peaking',
            LSC: 'lowshelf',
            LS: 'lowshelf',
            HSC: 'highshelf',
            HS: 'highshelf',
            LP: 'lowpass',
            LPQ: 'lowpass',
            HP: 'highpass',
            HPQ: 'highpass',
        };
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const preampMatch = trimmed.match(/^Preamp:\s*([+-]?\d+(?:\.\d+)?)\s*dB/i);
            if (preampMatch) {
                preamp = Math.max(-24, Math.min(24, parseFloat(preampMatch[1]) || 0));
                continue;
            }
            const filterMatch = trimmed.match(
                /^Filter\s+\d+:\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*Hz(?:\s+Gain\s+([+-]?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+(\d+(?:\.\d+)?))?/i
            );
            if (!filterMatch) continue;
            if (filterMatch[1].toUpperCase() !== 'ON') continue;
            const mappedType = typeMap[filterMatch[2].toUpperCase()];
            if (!mappedType) continue;
            const frequency = Math.max(20, Math.min(20000, parseFloat(filterMatch[3]) || 1000));
            const gain = filterMatch[4] !== undefined ? Math.max(-24, Math.min(24, parseFloat(filterMatch[4]) || 0)) : 0;
            const q = filterMatch[5] !== undefined ? Math.max(0.1, Math.min(20, parseFloat(filterMatch[5]) || 1.0)) : 0.71;
            filters.push({ type: mappedType, frequency, gain, q });
        }
        return { preamp, filters };
    }

    function loadEqState() {
        try {
            const raw = localStorage.getItem(EQ_STORAGE_KEY);
            if (raw) {
                const s = JSON.parse(raw);
                if (Array.isArray(s.gains) && s.gains.length === 16) state.eqGains = s.gains.map(v => Math.max(-12, Math.min(12, Number(v) || 0)));
                if (typeof s.preamp === 'number') state.eqPreamp = Math.max(-12, Math.min(12, s.preamp));
                if (typeof s.enabled === 'boolean') state.eqEnabled = s.enabled;
                if (typeof s.preset === 'string' && EQ_PRESETS[s.preset]) state.eqPreset = s.preset;
                else if (s.preset === 'custom') state.eqPreset = 'custom';
                if (typeof s.normEnabled === 'boolean') state.normEnabled = s.normEnabled;
                if (typeof s.autoEqEnabled === 'boolean') state.autoEqEnabled = s.autoEqEnabled;
                if (typeof s.autoEqRawText === 'string') {
                    state.autoEqRawText = s.autoEqRawText;
                    const parsed = parseAutoEqText(s.autoEqRawText);
                    state.autoEqPreamp = parsed.preamp;
                    state.autoEqFilters = parsed.filters;
                }
            }
        } catch {}
    }
    function saveEqState() {
        try {
            localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify({
                gains: state.eqGains,
                preamp: state.eqPreamp,
                enabled: state.eqEnabled,
                preset: state.eqPreset,
                normEnabled: state.normEnabled,
                autoEqEnabled: state.autoEqEnabled,
                autoEqRawText: state.autoEqRawText,
            }));
        } catch {}
    }
    loadEqState();

    function applyNormalizationState() {
        if (!normCompressorNode || !normMakeupGainNode || !eqAudioContext) return;
        const t = eqAudioContext.currentTime;
        if (state.normEnabled) {
            try {
                normCompressorNode.threshold.setTargetAtTime(-18, t, 0.02);
                normCompressorNode.knee.setTargetAtTime(12, t, 0.02);
                normCompressorNode.ratio.setTargetAtTime(4, t, 0.02);
                normCompressorNode.attack.setTargetAtTime(0.005, t, 0.02);
                normCompressorNode.release.setTargetAtTime(0.15, t, 0.02);
                normMakeupGainNode.gain.setTargetAtTime(1.35, t, 0.02);
            } catch {
                normCompressorNode.threshold.value = -18;
                normCompressorNode.ratio.value = 4;
                normMakeupGainNode.gain.value = 1.35;
            }
        } else {
            try {
                normCompressorNode.threshold.setTargetAtTime(0, t, 0.02);
                normCompressorNode.knee.setTargetAtTime(0, t, 0.02);
                normCompressorNode.ratio.setTargetAtTime(1, t, 0.02);
                normMakeupGainNode.gain.setTargetAtTime(1, t, 0.02);
            } catch {
                normCompressorNode.threshold.value = 0;
                normCompressorNode.ratio.value = 1;
                normMakeupGainNode.gain.value = 1;
            }
        }
    }

    function rebuildAutoEqNodes() {
        if (!eqAudioContext || !eqFilterTail || !normCompressorNode) return;
        try { eqFilterTail.disconnect(); } catch {}
        autoEqFilterNodes.forEach(node => { try { node.disconnect(); } catch {} });
        autoEqFilterNodes = [];

        let last = eqFilterTail;
        if (state.autoEqEnabled && state.autoEqFilters.length > 0) {
            state.autoEqFilters.forEach(spec => {
                const f = eqAudioContext.createBiquadFilter();
                f.type = spec.type;
                f.frequency.value = spec.frequency;
                f.Q.value = spec.q;
                f.gain.value = spec.gain;
                last.connect(f);
                last = f;
                autoEqFilterNodes.push(f);
            });
        }
        last.connect(normCompressorNode);
        applyEqGains();
    }

    function ensureEqContext() {
        if (eqAudioContext) return eqAudioContext;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) { return null; }
        try {
            eqAudioContext = new AudioCtx();
            eqPreampNode = eqAudioContext.createGain();
            const totalPreampDb = (state.eqEnabled ? state.eqPreamp : 0) + (state.autoEqEnabled && state.autoEqFilters.length ? state.autoEqPreamp : 0);
            eqPreampNode.gain.value = Math.pow(10, totalPreampDb / 20);
            eqFilters = EQ_FREQUENCIES.map((freq, i) => {
                const f = eqAudioContext.createBiquadFilter();
                if (i === 0) { f.type = 'lowshelf'; f.frequency.value = freq; }
                else if (i === EQ_FREQUENCIES.length - 1) { f.type = 'highshelf'; f.frequency.value = freq; }
                else { f.type = 'peaking'; f.frequency.value = freq; f.Q.value = 1.2; }
                f.gain.value = state.eqEnabled ? state.eqGains[i] : 0;
                return f;
            });
            normCompressorNode = eqAudioContext.createDynamicsCompressor();
            normMakeupGainNode = eqAudioContext.createGain();
            eqAnalyser = eqAudioContext.createAnalyser();
            eqAnalyser.fftSize = 256;
            masterGainNode = eqAudioContext.createGain();
            const currentVol = typeof state.userVolume === 'number' ? state.userVolume : (el.audio && !el.audio.muted ? el.audio.volume : 1);
            const currentMuted = Boolean(state.userMuted !== undefined ? state.userMuted : (el.audio ? el.audio.muted : false));
            masterGainNode.gain.value = currentMuted ? 0 : currentVol;

            // Chain: source -> preamp -> 16-band filters -> [autoEq filters] -> normCompressor -> normMakeupGain -> analyser -> masterGainNode -> destination
            let last = eqPreampNode;
            eqFilters.forEach(f => { last.connect(f); last = f; });
            eqFilterTail = last;
            normCompressorNode.connect(normMakeupGainNode);
            normMakeupGainNode.connect(eqAnalyser);
            eqAnalyser.connect(masterGainNode);
            masterGainNode.connect(eqAudioContext.destination);
            applyNormalizationState();
            rebuildAutoEqNodes();
            return eqAudioContext;
        } catch (e) {
            console.warn('Web Audio init failed:', e);
            return null;
        }
    }

    function resumeEqContext() {
        if (!eqAudioContext || eqAudioContext.state === 'running') return;
        eqAudioContext.resume().catch(() => {});
    }

    function attachEqSource() {
        if (!eqAudioContext || !el.audio || eqSource) return;
        try {
            eqSource = eqAudioContext.createMediaElementSource(el.audio);
            if (eqPreampNode) {
                eqSource.connect(eqPreampNode);
            }
        } catch (e) {
            console.warn('EQ source attach failed (maybe already connected):', e);
        }
    }

    function applyMasterVolume(vol, isMuted) {
        if (!masterGainNode || !eqAudioContext) return;
        const target = isMuted ? 0 : Math.max(0, Math.min(1, Number(vol)));
        try {
            masterGainNode.gain.setTargetAtTime(target, eqAudioContext.currentTime, 0.015);
        } catch {
            masterGainNode.gain.value = target;
        }
    }

    function initAudioGraph() {
        const ctx = ensureEqContext();
        if (ctx) {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            if (!eqSource) attachEqSource();
            applyEqGains();
            const vol = typeof state.userVolume === 'number' ? state.userVolume : (el.audio ? el.audio.volume : 1);
            const isMuted = Boolean(state.userMuted !== undefined ? state.userMuted : (el.audio ? el.audio.muted : false));
            if (typeof window.setAppVolume === 'function') {
                window.setAppVolume(vol, isMuted, false);
            }
        }
    }

    function applyEqGains() {
        if (!eqFilters.length) return;
        eqFilters.forEach((f, i) => {
            const target = state.eqEnabled ? state.eqGains[i] : 0;
            try { f.gain.setTargetAtTime(target, eqAudioContext.currentTime, 0.02); } catch { f.gain.value = target; }
        });
        if (eqPreampNode) {
            const totalPreampDb = (state.eqEnabled ? state.eqPreamp : 0) + (state.autoEqEnabled && state.autoEqFilters.length ? state.autoEqPreamp : 0);
            const g = Math.pow(10, totalPreampDb / 20);
            try { eqPreampNode.gain.setTargetAtTime(g, eqAudioContext.currentTime, 0.02); } catch { eqPreampNode.gain.value = g; }
        }
        drawEqCanvas();
    }

    function setEqBand(index, value) {
        state.eqGains[index] = Math.max(-12, Math.min(12, Number(value)));
        state.eqPreset = 'custom';
        const sel = document.getElementById('eq-preset-select');
        if (sel) sel.value = 'custom';
        if (eqFilters[index]) {
            const target = state.eqEnabled ? state.eqGains[index] : 0;
            try { eqFilters[index].gain.setTargetAtTime(target, eqAudioContext.currentTime, 0.02); } catch { eqFilters[index].gain.value = target; }
        }
        const valEl = document.querySelector(`[data-eq-value="${index}"]`);
        if (valEl) { valEl.textContent = `${state.eqGains[index] > 0 ? '+' : ''}${state.eqGains[index]} dB`; valEl.classList.toggle('zero', state.eqGains[index] === 0); }
        drawEqCanvas();
        saveEqState();
    }

    function applyEqPreset(name) {
        const preset = EQ_PRESETS[name];
        if (!preset) return;
        state.eqGains = [...preset];
        state.eqPreset = name;
        eqFilters.forEach((f, i) => {
            const target = state.eqEnabled ? state.eqGains[i] : 0;
            try { f.gain.setTargetAtTime(target, eqAudioContext.currentTime, 0.02); } catch { f.gain.value = target; }
        });
        // Update UI sliders
        document.querySelectorAll('.eq-band-slider').forEach((sl, i) => {
            sl.value = state.eqGains[i];
            const valEl = document.querySelector(`[data-eq-value="${i}"]`);
            if (valEl) { valEl.textContent = `${state.eqGains[i] > 0 ? '+' : ''}${state.eqGains[i]} dB`; valEl.classList.toggle('zero', state.eqGains[i] === 0); }
        });
        drawEqCanvas();
        saveEqState();
        showToast(`Preset: ${name}`, 'success');
    }

    function toggleEq(enabled) {
        state.eqEnabled = enabled;
        const btn = document.getElementById('eq-btn');
        const status = document.getElementById('eq-status');
        const toggle = document.getElementById('eq-enable-toggle');
        if (toggle) toggle.checked = enabled;
        if (btn) btn.classList.toggle('active', enabled);
        if (status) { status.textContent = enabled ? 'On' : 'Off'; status.classList.toggle('active', enabled); }
        document.querySelectorAll('.eq-band-slider').forEach(sl => { sl.disabled = !enabled; });
        const preamp = document.getElementById('eq-preamp');
        if (preamp) preamp.disabled = !enabled;
        if (enabled) {
            const ctx = ensureEqContext();
            if (ctx && ctx.state === 'suspended') ctx.resume();
            if (eqSource === null && ctx) attachEqSource();
            applyEqGains();
        } else {
            applyEqGains();
        }
        saveEqState();
        drawEqCanvas();
    }

    function drawEqCanvas() {
        const canvas = document.getElementById('eq-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        // Background grid
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) { const y = (h / 4) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        for (let i = 0; i < 16; i++) { const x = (w / 16) * i; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        // Curve
        const gains = state.eqEnabled ? state.eqGains : EQ_PRESETS.flat;
        const pre = state.eqEnabled ? state.eqPreamp : 0;
        ctx.beginPath();
        ctx.strokeStyle = state.eqEnabled ? '#1db954' : '#555';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.shadowColor = state.eqEnabled ? 'rgba(29,185,84,0.5)' : 'transparent';
        ctx.shadowBlur = 8;
        gains.forEach((g, i) => {
            const x = (i / (EQ_FREQUENCIES.length - 1)) * w;
            const norm = (g + pre + 12) / 24; // 0..1
            const y = h - (norm * h * 0.8 + h * 0.1); // keep in 10%..90%
            if (i === 0) ctx.moveTo(x, y);
            else {
                const prevX = ((i - 1) / (EQ_FREQUENCIES.length - 1)) * w;
                const prevG = gains[i - 1];
                const prevNorm = (prevG + pre + 12) / 24;
                const prevY = h - (prevNorm * h * 0.8 + h * 0.1);
                const cpx = (prevX + x) / 2;
                ctx.quadraticCurveTo(cpx, prevY, x, y);
            }
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
        // Fill under curve
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = state.eqEnabled ? 'rgba(29,185,84,0.12)' : 'rgba(255,255,255,0.04)';
        ctx.fill();
        // Center line
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(29,185,84,0.25)';
        ctx.setLineDash([4, 4]);
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    function buildEqBands() {
        const container = document.getElementById('eq-bands');
        if (!container) return;
        container.innerHTML = '';
        EQ_FREQUENCIES.forEach((freq, i) => {
            const label = freq >= 1000 ? `${(freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1)}k` : `${freq}`;
            const band = document.createElement('div');
            band.className = 'eq-band';
            band.innerHTML = `
                <span class="eq-band-value ${state.eqGains[i] === 0 ? 'zero' : ''}" data-eq-value="${i}">${state.eqGains[i] > 0 ? '+' : ''}${state.eqGains[i]} dB</span>
                <div class="eq-band-slider-wrap">
                    <div class="eq-band-ticks"><span></span><span></span><span class="mid"></span><span></span><span></span></div>
                    <input type="range" class="eq-band-slider" data-eq-band="${i}" min="-12" max="12" value="${state.eqGains[i]}" step="1" orient="vertical" aria-label="${freq} Hz">
                </div>
                <span class="eq-band-label freq">${label}</span>
                <span class="eq-band-label">${freq}Hz</span>
            `;
            container.appendChild(band);
        });
        container.querySelectorAll('.eq-band-slider').forEach(sl => {
            sl.disabled = !state.eqEnabled;
            sl.addEventListener('input', (e) => {
                const idx = parseInt(e.target.getAttribute('data-eq-band'), 10);
                setEqBand(idx, e.target.value);
            });
            sl.addEventListener('dblclick', (e) => {
                const idx = parseInt(e.target.getAttribute('data-eq-band'), 10);
                e.target.value = 0;
                setEqBand(idx, 0);
            });
        });
        // Also double-click on value to reset
        container.querySelectorAll('[data-eq-value]').forEach(el => {
            el.style.cursor = 'pointer';
            el.title = 'Double-click to reset';
            el.addEventListener('dblclick', () => {
                const idx = parseInt(el.getAttribute('data-eq-value'), 10);
                const sl = document.querySelector(`[data-eq-band="${idx}"]`);
                if (sl) sl.value = 0;
                setEqBand(idx, 0);
            });
        });
    }

    // Init EQ UI once
    buildEqBands();
    // Restore UI state
    const eqEnableToggle = document.getElementById('eq-enable-toggle');
    const eqPresetSelect = document.getElementById('eq-preset-select');
    const eqPreamp = document.getElementById('eq-preamp');
    const eqPreampValue = document.getElementById('eq-preamp-value');
    const eqBtn = document.getElementById('eq-btn');
    const eqPopover = document.getElementById('eq-popover');
    if (eqEnableToggle) eqEnableToggle.checked = state.eqEnabled;
    if (eqPresetSelect) eqPresetSelect.value = EQ_PRESETS[state.eqPreset] ? state.eqPreset : 'custom';
    if (eqPreamp) { eqPreamp.value = state.eqPreamp; eqPreamp.disabled = !state.eqEnabled; }
    if (eqPreampValue) eqPreampValue.textContent = `${state.eqPreamp > 0 ? '+' : ''}${state.eqPreamp} dB`;
    if (eqBtn) eqBtn.classList.toggle('active', state.eqEnabled || state.normEnabled || (state.autoEqEnabled && state.autoEqFilters.length > 0));
    const eqStatus = document.getElementById('eq-status');
    if (eqStatus) { eqStatus.textContent = state.eqEnabled ? 'On' : 'Off'; eqStatus.classList.toggle('active', state.eqEnabled); }
    document.querySelectorAll('.eq-band-slider').forEach(sl => sl.disabled = !state.eqEnabled);
    drawEqCanvas();

    // Restore Volume Normalization & AutoEQ UI
    const normToggle = document.getElementById('norm-enable-toggle');
    const autoEqToggle = document.getElementById('autoeq-enable-toggle');
    const autoEqInput = document.getElementById('autoeq-input');
    const autoEqStatus = document.getElementById('autoeq-status');

    function updateAudioExtrasUI() {
        if (normToggle) normToggle.checked = state.normEnabled;
        if (autoEqToggle) autoEqToggle.checked = state.autoEqEnabled;
        if (autoEqStatus) {
            autoEqStatus.textContent = state.autoEqFilters.length
                ? `${state.autoEqFilters.length} filter (${state.autoEqPreamp > 0 ? '+' : ''}${state.autoEqPreamp} dB)`
                : 'Belum ada profil';
        }
        if (eqBtn) {
            eqBtn.classList.toggle('active', state.eqEnabled || state.normEnabled || (state.autoEqEnabled && state.autoEqFilters.length > 0));
        }
    }
    if (autoEqInput && state.autoEqRawText) autoEqInput.value = state.autoEqRawText;
    updateAudioExtrasUI();

    normToggle?.addEventListener('change', (e) => {
        state.normEnabled = e.target.checked;
        if (state.normEnabled) initAudioGraph();
        applyNormalizationState();
        updateAudioExtrasUI();
        saveEqState();
        showToast(state.normEnabled ? 'Volume Normalization ON' : 'Volume Normalization OFF', 'success');
    });

    autoEqToggle?.addEventListener('change', (e) => {
        state.autoEqEnabled = e.target.checked;
        if (state.autoEqEnabled) initAudioGraph();
        rebuildAutoEqNodes();
        updateAudioExtrasUI();
        saveEqState();
        showToast(state.autoEqEnabled ? 'AutoEQ ON' : 'AutoEQ OFF', 'success');
    });

    document.getElementById('autoeq-apply-btn')?.addEventListener('click', () => {
        const rawText = autoEqInput ? autoEqInput.value : '';
        const parsed = parseAutoEqText(rawText);
        if (!parsed.filters.length) {
            showToast('Format AutoEQ tidak valid (tidak ada Filter ON ditemukan)', 'error');
            return;
        }
        state.autoEqRawText = rawText;
        state.autoEqPreamp = parsed.preamp;
        state.autoEqFilters = parsed.filters;
        state.autoEqEnabled = true;
        initAudioGraph();
        rebuildAutoEqNodes();
        updateAudioExtrasUI();
        saveEqState();
        showToast(`AutoEQ diterapkan (${parsed.filters.length} filter)`, 'success');
    });

    document.getElementById('autoeq-clear-btn')?.addEventListener('click', () => {
        state.autoEqRawText = '';
        state.autoEqPreamp = 0;
        state.autoEqFilters = [];
        state.autoEqEnabled = false;
        if (autoEqInput) autoEqInput.value = '';
        rebuildAutoEqNodes();
        updateAudioExtrasUI();
        saveEqState();
        showToast('Profil AutoEQ dihapus', 'success');
    });

    // If EQ/Normalization/AutoEQ was enabled before, prepare context on next user gesture (autoplay policy)
    if (state.eqEnabled || state.normEnabled || (state.autoEqEnabled && state.autoEqFilters.length > 0)) {
        const resumeOnGesture = () => {
            const ctx = ensureEqContext();
            if (ctx) {
                if (ctx.state === 'suspended') ctx.resume();
                if (!eqSource) attachEqSource();
                applyEqGains();
            }
            document.removeEventListener('click', resumeOnGesture);
            document.removeEventListener('keydown', resumeOnGesture);
        };
        document.addEventListener('click', resumeOnGesture, { once: true });
        document.addEventListener('keydown', resumeOnGesture, { once: true });
    }

    // Preamp handler
    eqPreamp?.addEventListener('input', (e) => {
        state.eqPreamp = parseInt(e.target.value, 10);
        if (eqPreampValue) eqPreampValue.textContent = `${state.eqPreamp > 0 ? '+' : ''}${state.eqPreamp} dB`;
        if (eqPreampNode && state.eqEnabled) {
            const g = Math.pow(10, state.eqPreamp / 20);
            try { eqPreampNode.gain.setTargetAtTime(g, eqAudioContext.currentTime, 0.02); } catch { eqPreampNode.gain.value = g; }
        }
        drawEqCanvas();
        saveEqState();
    });

    // Enable toggle
    eqEnableToggle?.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        if (enabled) {
            const ctx = ensureEqContext();
            if (ctx) {
                const doAttach = () => {
                    if (ctx.state === 'suspended') ctx.resume();
                    if (!eqSource) attachEqSource();
                    toggleEq(true);
                };
                if (ctx.state === 'suspended') ctx.resume().then(doAttach).catch(doAttach);
                else doAttach();
            }
        } else {
            toggleEq(false);
        }
        if (enabled) showToast('Equalizer ON', 'success');
        else showToast('Equalizer OFF', 'success');
    });

    // Preset select
    eqPresetSelect?.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === 'custom') return;
        applyEqPreset(v);
    });

    // Reset
    document.getElementById('eq-reset-btn')?.addEventListener('click', () => {
        state.eqGains = [...EQ_PRESETS.flat];
        state.eqPreamp = 0;
        state.eqPreset = 'flat';
        if (eqPresetSelect) eqPresetSelect.value = 'flat';
        if (eqPreamp) eqPreamp.value = 0;
        if (eqPreampValue) eqPreampValue.textContent = '0 dB';
        document.querySelectorAll('.eq-band-slider').forEach((sl, i) => {
            sl.value = 0;
            const valEl = document.querySelector(`[data-eq-value="${i}"]`);
            if (valEl) { valEl.textContent = '0 dB'; valEl.classList.add('zero'); }
        });
        if (eqFilters.length) applyEqGains();
        else drawEqCanvas();
        if (eqPreampNode && state.eqEnabled) {
            try { eqPreampNode.gain.setTargetAtTime(1, eqAudioContext.currentTime, 0.02); } catch { eqPreampNode.gain.value = 1; }
        }
        saveEqState();
        showToast('Equalizer reset', 'success');
    });

    // Popover toggle
    eqBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = eqPopover?.classList.contains('active');
        // Close other popovers
        el.loopPopover?.classList.remove('active');
        document.getElementById('queue-popover')?.classList.remove('active');
        if (typeof window.setVolumePopoverOpen === 'function') {
            window.setVolumePopoverOpen(false);
        }
        if (eqPopover) {
            eqPopover.classList.toggle('active', !isActive);
            eqPopover.setAttribute('aria-hidden', isActive ? 'true' : 'false');
            if (!isActive) drawEqCanvas();
        }
    });
    document.getElementById('eq-close-btn')?.addEventListener('click', () => {
        eqPopover?.classList.remove('active');
        eqPopover?.setAttribute('aria-hidden', 'true');
    });
    document.addEventListener('click', (e) => {
        if (eqPopover && !e.target.closest('#eq-popover') && !e.target.closest('#eq-btn')) {
            eqPopover.classList.remove('active');
            eqPopover.setAttribute('aria-hidden', 'true');
        }
    });

    // Ensure crossOrigin for Web Audio (required for MediaElementSource)
    if (el.audio) el.audio.crossOrigin = 'anonymous';
    // Resume Web Audio context on play (autoplay policy) and ensure source is attached
    el.audio?.addEventListener('play', () => {
        initAudioGraph();
    });

    const unlockAudioGraph = () => {
        initAudioGraph();
        document.removeEventListener('pointerdown', unlockAudioGraph);
        document.removeEventListener('keydown', unlockAudioGraph);
    };
    document.addEventListener('pointerdown', unlockAudioGraph, { once: true });
    document.addEventListener('keydown', unlockAudioGraph, { once: true });

    // Expose functions for main player engine integration
    window.applyMasterVolume = applyMasterVolume;
    window.initAudioGraph = initAudioGraph;
    window.isEqPipelineActive = () => Boolean(eqSource && masterGainNode);
    window.resumeEqContext = resumeEqContext;
});
})();
