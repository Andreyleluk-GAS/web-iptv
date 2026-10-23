// sw.js — Web IPTV Service Worker
// Caches the app shell for instant offline load.
// Live HLS streams are always fetched from the network.

const CACHE_NAME = 'web-iptv-shell-v1';

// App shell: everything needed to render the UI without a network roundtrip
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching app shell');
      return cache.addAll(SHELL_ASSETS);
    })
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── Activate: delete stale caches from previous versions ────────────────────
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
  // Take control of all open clients immediately
  self.clients.claim();
});

// ── Fetch: network-first for streams, cache-first for shell ─────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always bypass the cache for:
  //  • HLS media (.m3u8, .ts segments)
  //  • CORS proxies
  //  • CDN scripts (hls.js)
  //  • Cross-origin requests in general
  const isMediaSegment  = /\.(m3u8?|ts)(\?|$)/i.test(url.pathname);
  const isCorsProxy     = url.hostname.includes('allorigins.win');
  const isCDN           = url.hostname.includes('cdn.jsdelivr.net');
  const isCrossOrigin   = url.origin !== self.location.origin;

  if (isMediaSegment || isCorsProxy || isCDN || isCrossOrigin) {
    // Pure network fetch — no caching
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: cache-first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful same-origin responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
