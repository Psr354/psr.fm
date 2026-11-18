// Durable outbox. IDs are reused on retry; only acknowledged events are removed.
window.PsrListeningSync = class PsrListeningSync {
    constructor(userId, warn, requestFetch = window.fetch.bind(window)) {
        this.userId = Number(userId);
        this.warn = warn;
        this.fetch = requestFetch;
        this.writes = Promise.resolve();
        this.running = false;
        this.dirty = false;
        this.timer = null;
        this.retryDelay = 1000;
        this.warnings = new Set();
        this.db = new Promise((resolve, reject) => {
            const request = indexedDB.open('psr354-listening', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        this.db.catch(() => this.notify('Browser storage is unavailable; listening cannot be saved reliably.'));
        window.addEventListener('online', () => this.schedule(0, true));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.schedule(0, true);
        });
        this.schedule(0);
    }

    notify(message, key = message) {
        if (this.warnings.has(key)) return;
        this.warnings.add(key);
        this.warn(message);
    }

    async storage(operation, value) {
        const db = await this.db;
        return new Promise((resolve, reject) => {
            const tx = db.transaction('outbox', operation === 'getAll' ? 'readonly' : 'readwrite');
            const request = tx.objectStore('outbox')[operation](value);
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Listening storage transaction aborted'));
        });
    }

    enqueue(record) {
        const save = this.writes.then(() => this.storage('put', record));
        this.writes = save.catch(() => this.notify('Listening could not be saved on this device. Check available storage.'));
        save.then(() => this.schedule(0), () => {});
        return save;
    }

    async play(songId) {
        const id = this.eventId();
        await this.enqueue({
            id, type: 'play', userId: this.userId, status: 'pending',
            payload: { user_id: this.userId, song_id: songId, playback_session_id: id, occurred_at: new Date().toISOString() },
        });
        return id;
    }

    listen(songId, sessionId, seconds, occurredAt) {
        const id = this.eventId();
        return this.enqueue({
            id, type: 'listen', userId: this.userId, status: 'pending',
            payload: { user_id: this.userId, song_id: songId, playback_session_id: sessionId,
                event_id: id, seconds, occurred_at: occurredAt },
        });
    }

    eventId() {
        // getRandomValues also works on self-hosted HTTP origins without randomUUID.
        return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    schedule(delay, replace = false) {
        if (this.running) { this.dirty = true; return; }
        if (replace && this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.timer !== null) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
    }

    async request(url, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const token = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1];
        try {
            return await this.fetch(url, {
                ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, keepalive: true,
                headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': decodeURIComponent(token) } : {}) },
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    async flush() {
        if (this.running || navigator.onLine === false) return;
        this.running = true;
        this.dirty = false;
        let retry = false;
        try {
            await this.writes;
            const records = (await this.storage('getAll')).filter(record => record.userId === this.userId);
            const pending = records.filter(record => record.status === 'pending')
                .sort((a, b) => (a.type === 'play' ? 0 : 1) - (b.type === 'play' ? 0 : 1)
                    || a.payload.occurred_at.localeCompare(b.payload.occurred_at));
            if (!pending.length) return;
            // Refresh CSRF and verify the active account before sending its outbox.
            const auth = await this.request('/api/me');
            if (!auth.ok && ![401, 403].includes(auth.status)) {
                throw new Error(`Listening authentication check unavailable: HTTP ${auth.status}`);
            }
            if (!auth.ok || Number((await auth.json()).id) !== this.userId) {
                this.notify('Listening is saved locally. Sign in to the original account to sync it.');
                retry = true;
                this.retryDelay = 60000;
                return;
            }
            const failedSessions = new Set(records.filter(record => record.type === 'play' && record.status === 'failed').map(record => record.id));
            for (const record of pending) {
                if (failedSessions.has(record.payload.playback_session_id)) {
                    await this.storage('put', { ...record, status: 'failed', error: 'Playback was rejected' });
                    continue;
                }
                const url = record.type === 'play' ? `/api/songs/${record.payload.song_id}/play` : '/api/listen';
                const response = await this.request(url, { method: 'POST', body: JSON.stringify(record.payload) });
                if (response.ok) {
                    // A non-JSON proxy/login response is not an acknowledgement.
                    const acknowledgement = await response.json();
                    if (acknowledgement.status !== 'ok'
                        || (record.type === 'play' && acknowledgement.playback_session_id !== record.id)) {
                        throw new Error('Invalid listening acknowledgement');
                    }
                    await this.storage('delete', record.id);
                    this.retryDelay = 1000;
                } else if ([400, 404, 409, 422].includes(response.status)) {
                    const detail = await response.json().catch(() => ({}));
                    await this.storage('put', { ...record, status: 'failed', error: detail.error || `HTTP ${response.status}` });
                    if (record.type === 'play') failedSessions.add(record.id);
                } else {
                    retry = true;
                    if ([401, 403].includes(response.status)) {
                        this.notify('Listening is saved locally. Login or security token renewal is needed before syncing.');
                        this.retryDelay = 60000;
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Listening sync deferred:', error);
            retry = true;
        } finally {
            this.running = false;
            if (retry) {
                this.schedule(this.retryDelay);
                this.retryDelay = Math.min(this.retryDelay * 2, 60000);
            } else if (this.dirty) {
                this.schedule(0);
            }
        }
    }
};
