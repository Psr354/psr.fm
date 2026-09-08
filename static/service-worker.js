const SHELL_CACHE = 'psr354-shell-v12';
const MEDIA_CACHE = 'psr354-media-v3';
const SHELL_FILES = [
  '/', '/static/offline.html', '/static/offline-register.js',
  '/static/main.js', '/static/main.js?v=10',
  '/static/style.css', '/static/style.css?v=10',
  '/static/site.webmanifest',
  '/static/icon-192.png', '/static/icon-512.png', '/static/psrfm.png'
];

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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => (
        caches.match(request)
          .then((cached) => cached || caches.match('/'))
          .then((cached) => cached || caches.match('/static/offline.html'))
      ))
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
  }
});
