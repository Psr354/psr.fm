const SHELL_CACHE = 'psr354-shell-v91';
const MEDIA_CACHE = 'psr354-media-v3';
const RUNTIME_CACHE = 'psr354-runtime-v2';
const APP_SHELL_KEY = '/?offline-app-shell=1';
const SHELL_FILES = [
  '/static/offline.html',
  '/static/js/offline-register.js',
  '/static/js/offline-storage.js',
  '/static/js/queue.js',
  '/static/js/playback-sync.js',
  '/static/js/playlist-view.js',
  '/static/js/player.js',
  '/static/js/socket.io.min.js',
  '/static/js/main.js',
  '/static/js/lyrics.js',
  '/static/js/modals.js',
  '/static/js/theme.js',
  '/static/js/user-mgmt.js',
  '/static/js/recap.js',
  '/static/js/equalizer.js',
  '/static/js/poster.js',
  '/static/js/listening-sync.js',
  '/static/css/style.css',
  '/static/css/listening-room.css',
  '/static/css/player-controls.css',
  '/static/css/user-mgmt.css',
  '/static/css/theme.css',
  '/static/css/recap.css',
  '/static/site.webmanifest',
  '/static/img/favicon-32.png',
  '/static/img/apple-touch-icon.png',
  '/static/img/icon-192.png',
  '/static/img/icon-512.png',
  '/static/img/psrfm.png'
];

async function cacheAuthenticatedAppShell() {
  try {
    const response = await fetch('/', { credentials: 'include', cache: 'no-store' });
    // Never persist the login redirect as the offline application. The page
    // asks us to warm this cache only after the authenticated UI has loaded.
    if (response.ok && !response.redirected && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(APP_SHELL_KEY, response.clone());
    }
  } catch (_) {
    // Being offline while a warm-up message arrives is expected.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (
          (key.startsWith('psr354-shell-') && key !== SHELL_CACHE)
          || (key.startsWith('psr354-runtime-') && key !== RUNTIME_CACHE)
        ))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_APP_SHELL') {
    event.waitUntil(cacheAuthenticatedAppShell());
  } else if (event.data?.type === 'CLEAR_APP_SHELL') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('psr354-shell-'))
          .map((key) => caches.open(key).then((cache) => cache.delete(APP_SHELL_KEY)))
      ))
    );
  }
});

async function createRangeResponse(request, response) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader || !response?.ok) return response;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return response;

  const buffer = await response.clone().arrayBuffer();
  const size = buffer.byteLength;
  if (!size) return response;

  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (!suffixLength) return response;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }

  end = Math.min(end, size - 1);
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));

  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

async function serveAudio(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return createRangeResponse(request, cached);

  const response = await fetch(request);
  if (request.headers.has('range') && response.status === 200) {
    return createRangeResponse(request, response);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Third-party fonts/icons are optional enhancements. Cache them after the
  // worker controls a successful online visit, then reuse them offline.
  if (url.origin !== self.location.origin) {
    if (['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
      event.respondWith(
        caches.open(RUNTIME_CACHE).then(async (cache) => {
          const cached = await cache.match(request);
          if (cached && !(request.mode === 'cors' && cached.type === 'opaque')) return cached;
          const response = await fetch(request);
          if (response.ok && !(request.mode === 'cors' && response.type === 'opaque')) {
            await cache.put(request, response.clone());
          }
          return response;
        })
      );
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (url.pathname === '/' && response.ok && !response.redirected && response.type === 'basic') {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(APP_SHELL_KEY, clone));
        }
        return response;
      }).catch(async () => {
        const appShell = await caches.match(APP_SHELL_KEY);
        return appShell || caches.match('/static/offline.html');
      })
    );
    return;
  }

  if (url.pathname.startsWith('/audio/')) {
    event.respondWith(serveAudio(request));
    return;
  }

  if (url.pathname.startsWith('/static/album_art/')) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request)));
    return;
  }

  if (url.pathname.startsWith('/static/js/') || url.pathname.startsWith('/static/css/')) {
    // Always fetch fresh JS/CSS so feature updates reach the browser immediately.
    // Fall back to cache only when offline so the PWA stays usable.
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => (
        caches.match(request, { ignoreSearch: true })
      ))
    );
    return;
  }

  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => caches.match(request, { ignoreSearch: true }));
      })
    );
    return;
  }

});
