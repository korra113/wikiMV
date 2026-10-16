const SHELL_CACHE = 'wm-shell-v47'; // обновляем версию
const FALLBACK_CACHE = 'wm-fallback-v2';
const TILES_CACHE = 'wm-tiles-v1';
const MAX_CACHED_TILES = 15000;
const TILE_TIMEOUT_MS = 7500;

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
  'icon-192.png',
  'icon-512.png',
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
  'js/sharedMarkers.js', // добавлен!
  'js/geocaching.js',
  'js/suncalc.js',
  'js/quickMeasure.js',
  'js/measure.js',
  'js/shadowHeight.js',
  'js/rangeRing.js', // добавлен!
  'js/imageOverlay.js',
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
    }).then(() => self.clients.claim()) // <-- перехватывает все запросы сразу
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
    url.includes('arcgis.com') ||
    url.includes('etomesto.com') ||
    url.includes('etomesto.ru') ||
    url.includes('google.com/vt') ||
    url.includes('openstreetmap.fr') ||
    url.includes('opentopomap.org') ||
    url.includes('tiles.nakarte.me') ||
    url.includes('tile.thunderforest.com') ||
    url.includes('russia3d.ru/maps') ||
    url.includes('maps-for-free.com') ||
    url.includes('virtualearth.net') ||
    url.includes('yandex.net') ||
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
          if (res && (res.status === 200 || res.type === 'opaque')) {
            cache.put(req, res.clone());
            trimTileCache(cache);
          }
          return res;
        } catch (e) {
          // Возвращаем реальную 504 ошибку, чтобы Leaflet знал о сбое и мог повторить попытку
          return new Response(null, { status: 504, statusText: 'Tile Fetch Failed' });
        }
      })()
    );
    return;
  }

  if (
    url.includes('api.wikimapia.org') || 
    url.includes('nominatim') || 
    url.includes('photon') || 
    url.includes('wttr.in') ||    
    url.includes('open-meteo.com') ||
    url.includes('hexlet.app') ||
    url.includes('corsproxy.io') ||
    url.includes('corsproxy.org') ||
    url.includes('allorigins.win') ||
    url.includes('codetabs.com') ||
    url.includes('thingproxy.freeboard.io')
  ) {
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
