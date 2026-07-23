/* StockDesk service worker — network-first shell so updates show immediately */
const CACHE = 'stockdesk-v17';
const ASSETS = ['/', '/css/style.css', '/js/app.js', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // live data: always network, never cached
  if (url.pathname.startsWith('/api/')) return;

  // icons rarely change -> cache-first (fast)
  if (url.pathname.startsWith('/icon-')) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
    return;
  }

  // app shell (html/js/css/manifest) -> NETWORK-FIRST so a single refresh gets updates,
  // cache is only a fallback when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('/')))
  );
});
