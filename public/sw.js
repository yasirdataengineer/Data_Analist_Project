// Service worker for the installable app (PWA).
// - Static assets: cache-first, refreshed in the background.
// - Pages: always from the network (they contain personal and financial data, so they are never
//   cached); when offline, show the offline page instead.
const VERSION = 'v1';
const STATIC_CACHE = `onehub-static-${VERSION}`;
const PRECACHE = [
  '/public/style.css',
  '/public/app.js',
  '/public/offline.html',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png',
  '/public/icons/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('onehub-') && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/public/offline.html')));
    return;
  }

  if (url.pathname.startsWith('/public/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
