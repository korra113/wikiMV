const SHELL_CACHE = 'wm-shell-v10';
const TILES_CACHE = 'wm-tiles-v1';

const ASSETS_TO_CACHE = [
  '/',
  'index.html',
  'manifest.json',
  'css/leaflet.css',
  'css/style.css',
  'js/leaflet.js',
  'js/config.js',
  'js/geo.js',
  'js/cache.js',
  'js/api.js',
  'js/loader.js',
  'js/view.js',
  'js/picker.js',
  'js/ui.js',
  'js/markers.js',  // <-- Добавлено
  'js/measure.js',  // <-- Добавлено
  'js/main.js'
];

// Установка: кэшируем каждый файл независимо
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      for (const url of ASSETS_TO_CACHE) {
        try {
          const response = await fetch(url, { cache: 'no-cache' });
          if (response && response.status === 200) {
            await cache.put(url, response);
          }
        } catch (e) {
          console.warn('[SW] Не удалось закэшировать ресурс:', url, e);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// Активация: удаление старых кэшей
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== SHELL_CACHE && key !== TILES_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // 1. Навигация (открытие приложения / перезагрузка страницы)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        // Если интернета нет — ищем index.html в кэше
        const cache = await caches.open(SHELL_CACHE);
        return (
          (await cache.match('index.html')) ||
          (await cache.match('/')) ||
          (await cache.match('./index.html')) ||
          new Response('Оффлайн-режим активен, но оболочка не найдена', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          })
        );
      })
    );
    return;
  }

  // 2. Тайлы подложек карт (кэшируем в TILES_CACHE)
  const isTile =
    url.includes('arcgisonline.com') ||
    url.includes('google.com/vt') ||
    url.includes('tile.openstreetmap.fr') ||
    url.includes('wikimapia.org/?x=');

  if (isTile) {
    event.respondWith(
      caches.open(TILES_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        } catch (e) {
          return new Response('', { status: 408, statusText: 'Tile Offline' });
        }
      })
    );
    return;
  }

  // 3. Запросы к API (обрабатываются в api.js через IndexedDB, не кэшируем в SW)
  if (url.includes('api.wikimapia.org') || url.includes('nominatim') || url.includes('photon')) {
    return;
  }

  // 4. Статические файлы приложения (Cache First с обновлением в фоне)
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => null);

      return cachedRes || fetchPromise;
    })
  );
});
