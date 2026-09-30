import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Async IndexedDB fixture: records survive new sync instances and writes only
// resolve when the transaction completes, matching the browser outbox contract.
const records = new Map();
let storageFailure = false;
const indexedDB = {
    open() {
        const request = {};
        queueMicrotask(() => {
            request.result = {
                transaction() {
                    const tx = {};
                    tx.objectStore = () => Object.fromEntries(['put', 'getAll', 'delete'].map(operation => [operation, value => {
                        const result = {};
                        queueMicrotask(() => {
                            if (storageFailure) { tx.error = new Error('Quota exceeded'); tx.onerror(); return; }
                            if (operation === 'put') records.set(value.id, structuredClone(value));
                            if (operation === 'delete') records.delete(value);
                            if (operation === 'getAll') result.result = structuredClone([...records.values()]);
                            tx.oncomplete();
                        });
                        return result;
                    }]));
                    return tx;
                },
            };
            request.onsuccess();
        });
        return request;
    },
};
const timers = new Map();
let timerId = 0;
const warnings = [];
const requests = [];
const accepted = new Set();
let serverPlays = 0;
let serverSeconds = 0;
let account = 1;
let authStatus = 200;
let failure = null;
let lostResponse = false;
let extraDuringRequest;
const response = (status, body) => ({ ok: status === 200, status, json: async () => body });
const context = vm.createContext({
    indexedDB, crypto: webcrypto, Uint8Array, Date, AbortController,
    navigator: { onLine: false }, console: { error() {} },
    document: { cookie: 'csrf_token=psr354-token', addEventListener() {} },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    window: {
        addEventListener() {},
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url === '/api/me') return response(authStatus, { id: account });
            if (failure === 'network') throw new Error('Network disconnected');
            if (failure === '503') return response(503, {});
            if (failure === '403') return response(403, {});
            if (failure === '404') return response(404, { error: 'Song deleted' });
            const data = JSON.parse(options.body);
            const id = data.event_id || data.playback_session_id;
            if (!accepted.has(id)) {
                accepted.add(id);
                if (data.event_id) serverSeconds += data.seconds;
                else serverPlays++;
            }
            if (extraDuringRequest) { const enqueue = extraDuringRequest; extraDuringRequest = null; await enqueue(); }
            if (lostResponse) { lostResponse = false; throw new Error('Response lost after commit'); }
            return response(200, { status: 'ok', playback_session_id: data.playback_session_id });
        },
    },
});
vm.runInContext(fs.readFileSync(new URL('../static/listening-sync.js', import.meta.url), 'utf8'), context);
const create = user => new context.window.PsrListeningSync(user, message => warnings.push(message));
const occurredAt = '2020-01-01T00:00:05.000Z';
let sync = create(1);
const session = await sync.play(1);
await sync.listen(1, session, 5, occurredAt);
await sync.flush();
assert.equal(records.size, 2, 'Offline events must remain saved');

// Reload and reconnect: send the play first, then its listening, and remove ACKs.
sync = create(1);
context.navigator.onLine = true;
await sync.flush();
assert.equal(records.size, 0);
assert.equal(serverPlays, 1);
assert.equal(serverSeconds, 5);
assert.ok(requests[1].url.endsWith('/play'));
assert.equal(JSON.parse(requests[2].options.body).occurred_at, occurredAt);
assert.equal(requests[2].options.headers['X-CSRF-Token'], 'psr354-token');

// Response lost after commit, followed by a reload and retry: same ID, one play.
const second = await sync.play(1);
lostResponse = true;
await sync.flush();
assert.equal(records.size, 1);
assert.equal(serverPlays, 2);
sync = create(1);
await sync.flush();
assert.equal(records.size, 0);
assert.equal(serverPlays, 2);
await sync.listen(1, second, 5, occurredAt);
lostResponse = true;
await sync.flush();
await sync.flush();
assert.equal(serverSeconds, 10, 'Lost listening ACK must not double-count');

// Temporary failures retain pending records and back off; login/account changes
// never send another account's records.
await sync.listen(1, second, 5, occurredAt);
for (const mode of ['network', '503', '403']) {
    failure = mode;
    await sync.flush();
    assert.equal([...records.values()][0].status, 'pending');
}
failure = null;
authStatus = 401;
await sync.flush();
assert.equal(records.size, 1);
authStatus = 200;
account = 2;
const beforeMismatch = requests.length;
await sync.flush();
assert.equal(requests.length, beforeMismatch + 1, 'Account mismatch only checks auth');
const otherAccount = create(2);
await otherAccount.flush();
assert.equal(records.size, 1, 'Other account cannot remove pending data');
account = 1;
await sync.flush();
assert.equal(records.size, 0);
assert.equal(serverSeconds, 15);

// New events arriving during a flush must schedule another pass.
await sync.listen(1, second, 5, occurredAt);
extraDuringRequest = () => sync.listen(1, second, 5, occurredAt);
await sync.flush();
assert.equal(records.size, 1);
assert.ok(sync.timer !== null);
await sync.flush();
assert.equal(records.size, 0);

// Permanent rejection is retained for inspection and is not retried endlessly.
const rejected = await sync.play(1);
await sync.listen(1, rejected, 5, occurredAt);
failure = '404';
await sync.flush();
assert.equal(records.size, 2);
assert.ok([...records.values()].every(record => record.status === 'failed'));
const beforeRejectedRetry = requests.length;
const beforeRejectedWarnings = warnings.length;
await sync.flush();
await sync.flush();
assert.equal(requests.length, beforeRejectedRetry);
assert.equal(warnings.length, beforeRejectedWarnings, 'Specific and summary rejection messages must not alternate');
assert.ok(warnings.some(message => message.includes('Song deleted')));

storageFailure = true;
await assert.rejects(sync.play(1), /Quota exceeded/);
assert.ok(warnings.some(message => message.includes('storage')));
console.log('Outbox checks passed: reload, offline, lost ACK, retry, account isolation, permanent rejection, storage failure.');
