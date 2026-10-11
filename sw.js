const SHELL_CACHE = 'wm-shell-v13';
const TILES_CACHE = 'wm-tiles-v1';
const MAX_CACHED_TILES = 1800; // Ограничение на количество тайлов в кэше
const TILE_TIMEOUT_MS = 3200;  // Сниженный таймаут (3.2 сек): мгновенно освобождает сокеты браузера

// Прозрачный 1x1 GIF для мгновенного завершения загрузки упавших тайлов
const EMPTY_TILE_BYTES = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  c => c.charCodeAt(0)
);

function emptyTileResponse() {
  return new Response(EMPTY_TILE_BYTES, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

const ASSETS_TO_CACHE = [
  './',
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
  'js/markers.js',
  'js/measure.js',
  'js/main.js'
];

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

// Запрос с быстрым таймаутом и поддержкой внешней отмены
async function fetchTileWithTimeout(req, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  // Если браузер или Leaflet уже отменили запрос при скролле — прерываем сразу
  if (req.signal) {
    if (req.signal.aborted) {
      clearTimeout(timer);
      ctl.abort();
    } else {
      req.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        ctl.abort();
      }, { once: true });
    }
  }

  try {
    const res = await fetch(req, { 
      signal: ctl.signal,
      priority: 'low'
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Фоновая оптимизированная очистка кэша (не блокирует поток и сеть)
let isTrimming = false;
let lastTrimTime = 0;

async function trimTileCache(cache) {
  const now = Date.now();
  // Запускаем очистку не чаще 1 раза в 45 секунд
  if (isTrimming || (now - lastTrimTime < 45000)) return;
  isTrimming = true;
  lastTrimTime = now;

  try {
    const keys = await cache.keys();
    if (keys.length > MAX_CACHED_TILES) {
      const deleteCount = keys.length - MAX_CACHED_TILES + 150;
      const toDelete = keys.slice(0, deleteCount);
      // Удаляем пачкой через Promise.all, а не в медленном цикле
      await Promise.all(toDelete.map(k => cache.delete(k)));
    }
  } catch (e) {
  } finally {
    isTrimming = false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // 1. Навигация (возврат HTML оффлайн)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (
          (await cache.match('index.html')) ||
          (await cache.match('./index.html')) ||
          (await cache.match('./')) ||
          (await cache.match('/')) ||
          new Response('Оффлайн-режим активен', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        );
      })
    );
    return;
  }

  // 2. Тайлы подложек карт и растровых контуров
  const isTile =
    url.includes('arcgisonline.com') ||
    url.includes('google.com/vt') ||
    url.includes('tile.openstreetmap.fr') ||
    url.includes('opentopomap.org') ||
    url.includes('openrailwaymap.org') ||
    url.includes('tiles.nakarte.me') ||
    url.includes('wikimapia.org/?x=') ||
    url.includes('wikimapia.org/x=');

  if (isTile) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;

        try {
          const res = await fetchTileWithTimeout(req, TILE_TIMEOUT_MS);
          if (res && res.status === 200) {
            cache.put(req, res.clone());
            // Запуск чистки в фоне без ожидания завершения
            trimTileCache(cache);
          }
          return res;
        } catch (e) {
          // Если сеть отвалилась или сработал таймаут 3.2 сек —
          // мгновенно отдаем прозрачный пиксель, освобождая TCP-сокет браузера
          return emptyTileResponse();
        }
      })()
    );
    return;
  }

  // 3. API Wikimapia и геокодеры (кэшируются отдельно в IndexedDB)
  if (url.includes('api.wikimapia.org') || url.includes('nominatim') || url.includes('photon')) {
    return;
  }

  // 4. Оболочка приложения (Cache First)
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
