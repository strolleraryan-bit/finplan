const CACHE_NAME = 'finplan-v26';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './sync-engine.js'
];
// Cloud sync's only external dependency. Cached best-effort at install time so
// it's available offline after the first successful load; if this particular
// fetch fails (e.g. installing while offline), the app still installs fine —
// sync just stays unavailable until a connection is found, same as any other
// network feature. Every other asset above is same-origin and always required.
const OPTIONAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(ASSETS);
      await Promise.all(OPTIONAL_ASSETS.map((u) => cache.add(u).catch(() => {})));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isAppShell = event.request.mode === 'navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/sync-engine.js') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname === new URL('./', self.location).pathname;

  if (isAppShell) {
    // Network-first for the app shell. The old strategy below (cache-first,
    // background-refresh) was serving whatever HTML/JS happened to already
    // be cached IMMEDIATELY, and only updating the cache for the NEXT load —
    // so right after a new feature was deployed (e.g. Amount/Date becoming
    // editable in the Credit edit modal), the app would inconsistently show
    // the OLD modal (missing those fields) on some loads and the new one on
    // others, depending purely on cache/network timing. That's why it
    // looked random ("kai baar... sab kuchh edit karne ka nahi dikha raha
    // tha" — reported Aug 18, 2026). Network-first means: whenever online,
    // always fetch and show the current deployed version; only fall back to
    // the cached copy if the network request fails (i.e. actually offline).
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first (with background refresh) for everything else — icons and
  // other rarely-changing static assets, where instant-from-cache is fine.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
