const SHELL_CACHE = 'psr354-shell-v1';
const MEDIA_CACHE = 'psr354-media-v1';
const SHELL_FILES = [
  '/', '/static/main.js', '/static/style.css', '/static/site.webmanifest',
  '/static/icon-192.png', '/static/icon-512.png', '/static/psrfm.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  if (url.pathname.startsWith('/audio/') || url.pathname.startsWith('/static/album_art/')) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request)));
    return;
  }

  if (url.pathname.startsWith('/static/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
