const SHELL_CACHE = 'psr354-shell-v13';
const MEDIA_CACHE = 'psr354-media-v3';
const RUNTIME_CACHE = 'psr354-runtime-v1';
const APP_SHELL_KEY = '/?offline-app-shell=1';
const SHELL_FILES = [
  '/static/offline.html', '/static/offline-register.js',
  '/static/main.js', '/static/main.js?v=11',
  '/static/style.css', '/static/style.css?v=11',
  '/static/site.webmanifest',
  '/static/favicon-32.png', '/static/apple-touch-icon.png',
  '/static/icon-192.png', '/static/icon-512.png', '/static/psrfm.png'
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
        .filter((key) => key.startsWith('psr354-shell-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_APP_SHELL') {
    event.waitUntil(cacheAuthenticatedAppShell());
  }
});

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
          if (cached) return cached;
          const response = await fetch(request);
          await cache.put(request, response.clone());
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

  if (url.pathname.startsWith('/audio/') || url.pathname.startsWith('/static/album_art/')) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request)));
    return;
  }

  if (url.pathname === '/static/main.js' || url.pathname === '/static/style.css') {
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
