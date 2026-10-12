const SHELL_CACHE = 'wm-shell-v18'; // <-- подняли версию для гарантированного обновления
const FALLBACK_CACHE = 'wm-fallback-v2';
const TILES_CACHE = 'wm-tiles-v1';
const MAX_CACHED_TILES = 15000; // Увеличено с 1800 до 15 000 тайлов (~200-300 МБ)
const TILE_TIMEOUT_MS = 7500;   // Сниженный таймаут (3.2 сек): мгновенно освобождает сокеты браузера

let noTrimTiles = false;

// Слушаем сообщения из настроек приложения для включения/выключения автоочистки
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_NO_TRIM_TILES') {
    noTrimTiles = !!event.data.value;
  }
});

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
  'js/geocaching.js', // <-- ДОБАВЛЕНО
  'js/suncalc.js',    // <-- ДОБАВЛЕНО
  'js/quickMeasure.js',
  'js/measure.js',
  'js/shadowHeight.js',
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
          if (key !== SHELL_CACHE && key !== TILES_CACHE && key !== FALLBACK_CACHE) {
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

// Фоновая оптимизированная очистка кэша
let isTrimming = false;
let lastTrimTime = 0;

async function trimTileCache(cache) {
  if (noTrimTiles) return;
  const now = Date.now();
  if (isTrimming || (now - lastTrimTime < 90000)) return;
  isTrimming = true;
  lastTrimTime = now;

  try {
    const keys = await cache.keys();
    if (keys.length > MAX_CACHED_TILES) {
      const deleteCount = keys.length - MAX_CACHED_TILES + 400;
      for (let i = 0; i < deleteCount; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) {
  } finally {
    isTrimming = false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  const isFallbackTile = url.includes('tile.openstreetmap.fr/osmfr');

  if (isFallbackTile) {
    event.respondWith(
      caches.open(FALLBACK_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        } catch (e) {
          return emptyTileResponse();
        }
      })
    );
    return;
  }

  // УДАЛЕНЫ повторные строки "const req = event.request;" и "const url = req.url;"

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (
          (await cache.match('index.html')) ||
          (await cache.match('./index.html')) ||
          new Response('Оффлайн-режим активен', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        );
      })
    );
    return;
  }

  const isTile =
    url.includes('arcgisonline.com') ||
    url.includes('google.com/vt') ||
    url.includes('tile.openstreetmap.fr') ||
    url.includes('opentopomap.org') ||
    url.includes('tiles.nakarte.me') ||
    url.includes('tile.thunderforest.com') ||
    url.includes('proxy.nakarte.me') ||
    url.includes('russia3d.ru/maps') ||
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
            // Не ждем очистку кэша через await, пускаем в фоне
            trimTileCache(cache);
          }
          return res;
        } catch (e) {
          // Возвращаем статус ошибки, который Leaflet сможет перехватить и повторить
          return new Response(null, { status: 504, statusText: 'Tile Fetch Failed' });
        }
      })()
    );
    return;
  }

  if (url.includes('api.wikimapia.org') || url.includes('nominatim') || url.includes('photon')) {
    return;
  }

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
