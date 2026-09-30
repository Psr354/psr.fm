import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PSR_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PSR_TEST_PYTHON || (process.platform === 'win32' ? path.join(root, 'venv/Scripts/python.exe') : 'python3');
const server = spawn(python, ['tests/browser_fixture.py'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stderr.on('data', data => { serverOutput += data; });
let browser;
try {
    const [ready] = await Promise.race([
        once(server.stdout, 'data'),
        once(server, 'exit').then(([code]) => { throw new Error(`Fixture exited ${code}: ${serverOutput}`); }),
    ]);
    const base = ready.toString().trim();
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await chromium.launch({ headless: true,
        ...(process.env.PSR_TEST_BROWSER ? { executablePath: process.env.PSR_TEST_BROWSER } : {}),
        args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    const rejected = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
        if ((response.url().endsWith('/api/listen') || response.url().endsWith('/play')) && !response.ok()) rejected.push(`${response.status()} ${response.url()}`);
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const stats = async () => (await context.request.get(`${base}/__psr354_test_stats`)).json();
    const readAudio = () => page.locator('#audio-player').evaluate(audio => ({ paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration, ended: audio.ended }));
    const wait = async (predicate, message, timeout = 15000) => {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            if (await predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`${message}: ${JSON.stringify(await stats())}; audio=${JSON.stringify(await readAudio())}; errors=${errors}; rejected=${rejected}`);
    };
    const selectSong = async id => {
        await page.locator('#playlist-list li').first().click();
        await page.locator(`#playlist-songs-list .song-item[data-id="${id}"] .song-title`).click();
        await wait(async () => !(await readAudio()).paused, 'Playback did not start');
    };
    await page.goto(`${base}/login`);
    await page.locator('#username').fill('psr354');
    await page.locator('#password').fill('psr354-browser-password');
    await page.locator('.auth-submit-btn').click();
    await page.waitForURL(`${base}/`);
    await page.locator('#user-name').filter({ hasText: 'psr354' }).waitFor();
    console.log('PASS login and dashboard');

    // Real audio events, IndexedDB and HTTP. No mocked play/listen endpoints.
    await page.locator('#repeat-btn').click();
    await page.locator('#repeat-btn').click();
    await selectSong(1);
    await wait(async () => (await stats()).songs[0].play_count >= 4, 'Repeat one did not produce four plays', 22000);
    await page.locator('#play-pause-btn').click();
    await wait(async () => (await stats()).sessions.filter(s => s.song_id === 1 && Math.abs(s.seconds_listened - 4) < 0.05).length >= 3, 'Full repeats did not record full duration');
    let before = await stats();
    assert.equal(before.songs[0].play_count, 4);
    console.log('PASS repeat one: three full 4-second sessions, four starts');

    await page.locator('#repeat-btn').click(); // Off.
    await selectSong(3);
    await wait(async () => (await readAudio()).currentTime > 1, 'Audio did not advance');
    await page.locator('#play-pause-btn').click();
    await wait(async () => (await stats()).sessions.some(s => s.song_id === 3 && s.seconds_listened > 0), 'Early pause did not flush');
    before = await stats();
    await page.locator('#play-pause-btn').click();
    await page.locator('#progress-bar').focus();
    await page.locator('#progress-bar').evaluate(slider => { slider.value = 75; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('#progress-bar').press('Home');
    await page.locator('#play-pause-btn').click();
    await page.waitForTimeout(500);
    assert.equal((await stats()).plays, before.plays, 'Pause or seeking unexpectedly added a play');
    assert.ok((await stats()).seconds - before.seconds < 3, 'Seek jump counted as listening');
    console.log('PASS pause/resume and keyboard seek');

    await selectSong(1);
    await wait(async () => (await stats()).songs[1].play_count >= 1, 'Auto-next did not play second track');
    await wait(async () => (await stats()).songs[2].play_count > before.songs[2].play_count, 'Auto-next did not play third track');
    await page.locator('#progress-bar').evaluate(slider => { slider.value = 100; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(async () => (await readAudio()).paused, 'Repeat off did not stop at end');
    console.log('PASS auto-next and repeat off');

    await selectSong(3);
    await page.locator('#eq-btn').click();
    await page.locator('#eq-popover .eq-toggle-slider').click();
    assert.equal(await page.locator('#eq-enable-toggle').isChecked(), true);
    await page.locator('#eq-preset-select').selectOption({ label: 'Rock' });
    await page.locator('#eq-btn').click();
    await page.locator('#lyrics-btn').click();
    await page.locator('#lyrics-body').filter({ hasText: 'psr354 lyrics' }).waitFor();
    await page.locator('#lyrics-edit-btn').click();
    await page.locator('#lyrics-plain-input').fill('psr354 edited lyrics');
    await page.locator('#lyrics-save-btn').click();
    await wait(async () => (await (await context.request.get(`${base}/api/songs/3/lyrics`)).json()).lyrics === 'psr354 edited lyrics', 'Lyrics were not saved');
    await page.locator('#lyrics-share-btn').click();
    await page.locator('#share-lyrics-input').fill('psr354 share card');
    const cardDownload = page.waitForEvent('download');
    await page.locator('#share-lyrics-download-btn').click();
    assert.match((await cardDownload).suggestedFilename(), /\.png$/);
    await page.locator('#share-lyrics-close-btn').click();
    await page.locator('#lyrics-close-btn').click();
    await page.locator('#play-pause-btn').click();
    console.log('PASS equalizer, manual lyrics and share-card PNG');

    await selectSong(3);
    await wait(async () => (await stats()).songs[2].play_count >= 4, 'Play was not synced before lost-ACK test');
    const ackSession = (await stats()).sessions.at(-1).id;
    const attempts = new Map();
    let loseAck = true;
    await page.route('**/api/listen', async route => {
        const eventId = route.request().postDataJSON().event_id;
        attempts.set(eventId, (attempts.get(eventId) || 0) + 1);
        if (loseAck) {
            loseAck = false;
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort(); // Server committed, browser never receives ACK.
        } else await route.continue();
    });
    await wait(async () => (await readAudio()).currentTime > 1, 'Audio did not advance before lost ACK');
    await page.locator('#play-pause-btn').click();
    const heard = (await readAudio()).currentTime;
    await wait(async () => [...attempts.values()].some(count => count >= 2), 'Lost ACK was not retried');
    assert.ok(Math.abs((await stats()).sessions.find(s => s.id === ackSession).seconds_listened - heard) < 0.1,
        'Lost ACK doubled listening');
    await page.unroute('**/api/listen');
    console.log('PASS real HTTP response loss and idempotent retry');

    await page.locator('#save-playlist-offline-btn').click();
    await wait(async () => /Saved Offline|Update Offline/.test(await page.locator('#save-playlist-offline-btn').innerText()), 'Playlist offline save failed', 20000);
    await wait(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'Service worker not controlling page');
    before = await stats();
    await context.setOffline(true);
    await selectSong(1);
    await wait(async () => (await readAudio()).currentTime > 1, 'Offline audio did not play');
    await page.locator('#play-pause-btn').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#user-name').waitFor();
    await context.setOffline(false);
    await wait(async () => (await stats()).plays > before.plays, 'Offline outbox did not recover after reload', 20000);
    console.log('PASS offline audio, IndexedDB persistence and reconnection');

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobileContext.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', error => errors.push(error.message));
    mobile.on('response', response => {
        if ((response.url().endsWith('/api/listen') || response.url().endsWith('/play')) && !response.ok()) rejected.push(`${response.status()} ${response.url()}`);
    });
    await mobile.goto(`${base}/login`);
    await mobile.locator('#username').fill('psr354');
    await mobile.locator('#password').fill('psr354-browser-password');
    await mobile.locator('.auth-submit-btn').click();
    await mobile.waitForURL(`${base}/`);
    await mobile.locator('#mobile-menu-btn').click();
    await mobile.locator('#playlist-list li').first().click();
    before = await stats();
    await mobile.locator('#playlist-songs-list .song-item[data-id="3"] .song-title').click();
    await mobile.waitForFunction(() => document.getElementById('audio-player').currentTime > 1);
    await wait(async () => (await stats()).plays === before.plays + 1, 'Mobile playback start was not counted');
    const mobileSession = (await stats()).sessions.at(-1).id;
    const bar = await mobile.locator('#progress-bar').boundingBox();
    const touch = await mobileContext.newCDPSession(mobile);
    for (const [start, end] of [[0.1, 0.7], [0.7, 0.2], [0.2, 0.8]]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bar.x + bar.width * start, y: bar.y + bar.height / 2 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bar.x + bar.width * end, y: bar.y + bar.height / 2 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await mobile.waitForFunction(() => !document.getElementById('audio-player').paused);
    }
    await mobile.locator('#play-pause-btn').click();
    await wait(async () => (await stats()).sessions.find(s => s.id === mobileSession).seconds_listened > 0, 'Mobile listening was not flushed');
    await mobile.waitForTimeout(500);
    assert.equal((await stats()).plays, before.plays + 1, 'Mobile drag or resume added another play');
    assert.ok((await stats()).sessions.find(s => s.id === mobileSession).seconds_listened < 5, 'Mobile drag counted skipped audio');
    await mobileContext.close();
    console.log('PASS mobile touch-drag: one play, actual heard time, no listening rejection');

    await selectSong(3);
    await wait(async () => (await readAudio()).currentTime > 0.5, 'Audio did not start before A-B loop');
    before = await stats();
    await page.locator('#loop-btn').click();
    await page.locator('#loop-start-input').fill('0:00');
    await page.locator('#loop-end-input').fill('0:01');
    await page.locator('#loop-end-input').press('Tab');
    await page.locator('#toggle-loop-btn').click();
    const loopSeeks = [];
    await page.exposeFunction('psr354LoopSeek', value => loopSeeks.push(value));
    await page.locator('#audio-player').evaluate(audio => audio.addEventListener('seeked', () => window.psr354LoopSeek(audio.currentTime)));
    await wait(async () => loopSeeks.filter(time => time < 0.2).length >= 3, 'A-B loop did not repeat');
    await page.locator('#clear-loop-btn').click();
    await page.locator('#play-pause-btn').click();
    await wait(async () => (await stats()).seconds > before.seconds + 2, 'Loop listening was not recorded');
    assert.equal((await stats()).plays, before.plays, 'A-B loop added plays');
    console.log('PASS A-B loop: repeated audio records listening without extra plays');

    const wav = await (await context.request.get(`${base}/api/songs/1/offline-audio`)).body();
    await page.locator('#music-tools-dropdown-btn').click();
    await page.locator('#upload-song-btn').click();
    await page.locator('#upload-file-input').setInputFiles({ name: 'psr354-upload.wav', mimeType: 'audio/wav', buffer: wav });
    await page.locator('#upload-title-input').fill('psr354 Upload');
    await page.locator('#upload-artist-input').fill('psr354');
    await page.locator('#upload-playlist-checkboxes input').first().check();
    const uploaded = page.waitForResponse(response => response.url().endsWith('/api/upload') && response.request().method() === 'POST');
    await page.locator('#save-upload-btn').click();
    const uploadResponse = await uploaded;
    assert.equal(uploadResponse.status(), 201);
    const uploadData = await uploadResponse.json();
    await selectSong(uploadData.song_id);
    await wait(async () => (await readAudio()).currentTime > 0.5, 'Uploaded WAV did not play');
    assert.equal((await readAudio()).duration, 4);
    await page.locator('#play-pause-btn').click();
    console.log('PASS upload WAV, playlist insertion and playback');
    assert.deepEqual(errors, []);
    assert.deepEqual(rejected, []);
    console.log('PASS no JavaScript errors or rejected play/listening requests');
} finally {
    if (browser) await browser.close();
    server.kill();
}
