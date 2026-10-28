// sw.js — Car Web IPTV Service Worker v2
// Кеширует только оболочку (App Shell).
// Потоки, плейлисты, прокси — всегда из сети.

const CACHE_NAME = 'car-iptv-shell-v5';

// Ресурсы App Shell для мгновенного старта
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './epg-worker.js'
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching app shell');
      return cache.addAll(SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Не кешируем:
  // 1. HLS сегменты и плейлисты (.m3u8, .ts)
  // 2. CORS-прокси (codetabs, corsproxy.io, allorigins, workers.dev)
  // 3. CDN-скрипты (hls.js)
  // 4. Любые cross-origin запросы
  const isMediaSegment = /\.(m3u8?|ts)(\?|$)/i.test(url.pathname);
  const isCorsProxy    = /codetabs\.com|corsproxy\.io|allorigins\.win|cors\.sh|workers\.dev/i.test(url.hostname);
  const isCDN          = url.hostname.includes('cdn.jsdelivr.net');
  const isCrossOrigin  = url.origin !== self.location.origin;
  // Не кешируем POST-запросы
  const isNotGet       = req.method !== 'GET';

  if (isMediaSegment || isCorsProxy || isCDN || isCrossOrigin || isNotGet) {
    event.respondWith(fetch(req));
    return;
  }

  // App Shell: cache-first → network fallback
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});

