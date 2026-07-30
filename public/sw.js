// Minimal network-first service worker for /pos and /kds -- exists purely so
// a flaky connection still boots the app shell (HTML/JS/CSS) from cache
// instead of a blank white screen. NEVER caches /api/* responses: the
// existing offline mutation queue (offlineQueue.js) already owns that
// behavior end-to-end, and caching API GETs here would fight it with a
// second, uncoordinated notion of "stale".
//
// Bump CACHE_VERSION on any shell change you want picked up promptly --
// skipWaiting + clients.claim below mean the next reload (not the next
// full app restart) runs the new version.
const CACHE_VERSION = 'cm-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // let offlineQueue.js own this entirely

  event.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then(cached => cached || Promise.reject('offline, no cache')))
  );
});
