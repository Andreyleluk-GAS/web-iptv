// sw.js — Car Web IPTV Service Worker v2
// Кеширует только оболочку (App Shell).
// Потоки, плейлисты, прокси — всегда из сети.

const CACHE_NAME = 'car-iptv-shell-v9';

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

  // 1. Игнорируем не-GET запросы
  if (req.method !== 'GET') return;

  // 2. Игнорируем любые внешние запросы (иконки каналов epg.one, HLS-потоки, CORS-прокси, CDN).
  // Браузер загружает их напрямую через нативный сетевой стек без ошибок SW.
  if (url.origin !== self.location.origin) return;

  // 3. Игнорируем потоковые сегменты и плейлисты
  if (/\.(m3u8?|ts)(\?|$)/i.test(url.pathname)) return;

  // 4. Только для локальных файлов приложения (App Shell): cache-first → network fallback
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
    }).catch(() => {
      // Возвращаем index.html ТОЛЬКО при навигации по сайту, чтобы не ломать скрипты и картинки
      if (req.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});

