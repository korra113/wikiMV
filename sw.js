const SHELL_CACHE = 'wm-shell-v103';
const FALLBACK_CACHE = 'wm-fallback-v2';
const TILES_CACHE = 'wm-tiles-v1';
const MAX_CACHED_TILES = 15000;
const TILE_TIMEOUT_MS = 10000;
const NAVIGATE_TIMEOUT_MS = 3500;

let noTrimTiles = false;

// Слушаем сообщения из настроек приложения и offlineArea.js
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SET_NO_TRIM_TILES') {
    noTrimTiles = !!event.data.value;
  } else if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Полный список ресурсов оболочки приложения (синхронизирован с index.html)
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'css/leaflet.css',
  'css/style.css',
  'js/squad.js',
  'js/leaflet.js',
  'js/tile-retry.js',
  'js/config.js',
  'js/layerInspector.js',
  'js/geo.js',
  'js/cache.js',
  'js/geomag.js',
  'js/tz.js',
  'js/api.js',
  'js/loader.js',
  'js/view.js',
  'js/picker.js',
  'js/ui.js',
  'js/markers.js',
  'js/imageOverlay.js',
  'js/sharedMarkers.js',
  'js/geocaching.js',
  'js/suncalc.js',
  'js/measure.js',
  'js/mapCircles.js',
  'js/quickMeasure.js',
  'js/rangeRing.js',
  'js/shadowHeight.js',
  'js/pdrEngine.js',
  'js/imuLogger.js',
  'js/inaturalist.js',
  'js/soil.js',
  'js/water.js',
  'js/placeInsight.js',
  'js/tracker.js',
  'js/viewshed.js',
  'js/audibility.js',
  'js/demRelief.js',
  'js/demPresets.js',
  'js/demQuickPanel.js',
  'js/clouds.js',
  'js/treePresets.js',
  'js/slice3d.js',
  'js/treePalette.js',
  'js/vectorRoads.js',
  'js/geotiff.js',
  'js/canopyV2.js',
  'js/canopy.js',
  'js/peakView.js',
  'js/emojiSvg.js',
  'js/colorPicker.js',
  'js/offlineArea.js',
  'js/terrainOverlays.js',
  'js/appProfiles.js',
  'js/main.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const BATCH = 6;
      for (let i = 0; i < ASSETS_TO_CACHE.length; i += BATCH) {
        const chunk = ASSETS_TO_CACHE.slice(i, i + BATCH);
        await Promise.all(
          chunk.map(async (url) => {
            try {
              const response = await fetch(url, { cache: 'no-cache' });
              if (response && response.status === 200) {
                await cache.put(url, response);
              }
            } catch (e) {
              console.warn('[SW] Не удалось закэшировать ресурс:', url, e);
            }
          })
        );
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

// Запрос с таймаутом и поддержкой внешней отмены (AbortSignal)
async function fetchWithTimeout(req, timeoutMs, extraInit) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  const onExternalAbort = () => {
    clearTimeout(timer);
    ctl.abort();
  };

  if (req.signal) {
    if (req.signal.aborted) {
      clearTimeout(timer);
      ctl.abort();
    } else {
      req.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(req, Object.assign({ signal: ctl.signal }, extraInit || {}));
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  } finally {
    if (req.signal) {
      req.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// Фоновая оптимизированная очистка кэша тайлов
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

function isTileRequest(url) {
  return (
    // Базовые карты и Wikimapia
    url.includes('arcgisonline.com') ||
    url.includes('arcgis.com') ||
    url.includes('etomesto.com') ||
    url.includes('etomesto.ru') ||
    url.includes('google.com/vt') ||
    url.includes('openstreetmap.') ||
    url.includes('tile.osm.org') ||
    url.includes('opentopomap.org') ||
    url.includes('tiles.nakarte.me') ||
    url.includes('tile.thunderforest.com') ||
    url.includes('russia3d.ru/maps') ||
    url.includes('maps-for-free.com') ||
    url.includes('virtualearth.net') ||
    url.includes('yandex.net') ||
    url.includes('wikimapia.org/?x=') ||
    url.includes('wikimapia.org/x=') ||

    // DEM рельеф и маска воды ESA WorldCover
    url.includes('mapterhorn') ||
    url.includes('elevation-tiles-prod') ||
    url.includes('terrarium') ||
    url.includes('nextzen.org') ||
    url.includes('mapproxy.terrascope.be') ||

    // Векторные POI тайлы (PeakView)
    url.includes('tiles.versatiles.org/tiles/') ||
    url.includes('tiles.openfreemap.org/planet/') ||
    (url.includes('tiles.openfreemap.org/') && /\.(pbf|mvt)(\?|$)/i.test(url)) ||

    // Слои растительности Canopy v1 (высота, маска, породы)
    url.includes('forests.sylar1907942.workers.dev/tiles/') ||
    (url.includes('d4e8q0lca1vlcb5n35hs') && url.includes('type=')) ||
    (url.includes('earthengine.googleapis.com') && url.includes('/tiles/'))
  );
}

function isDynamicApiRequest(url) {
  return (
    url.includes('api.wikimapia.org') ||
    url.includes('firebaseio.com') ||
    url.includes('supabase.co') ||
    url.includes('supabase.in') ||
    url.includes('inaturalist.org') ||
    url.includes('inaturalist-open-data') ||
    url.includes('isric.org') ||
    url.includes('nominatim') ||
    url.includes('photon') ||
    url.includes('overpass') ||
    url.includes('geocaching.su') ||
    url.includes('wttr.in') ||
    url.includes('open-meteo.com') ||
    url.includes('wikipedia.org') ||
    url.includes('wikimedia.org') ||
    url.includes('wikidata.org') ||
    url.includes('korra113.github.io/forests_map') ||
    url.includes('d4e8q0lca1vlcb5n35hs') ||
    url.includes('data.source.coop') ||
    url.includes('dataforgood-fb-data') ||
    url.includes('forests.sylar1907942.workers.dev/v2/') ||
    url === 'https://tiles.openfreemap.org/planet' ||
    url.includes('hexlet.app') ||
    url.includes('corsproxy.io') ||
    url.includes('corsproxy.org') ||
    url.includes('allorigins.win') ||
    url.includes('codetabs.com') ||
    url.includes('thingproxy.freeboard.io')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // Пропускаем не-GET, blob/data/chrome-extension, Range-запросы (GeoTIFF / COG v2) и проверочные пинги карт
  if (req.method !== 'GET' || !url.startsWith('http') || req.headers.has('range') || url.includes('_wmchk=')) {
    return;
  }

  // 1. Навигация: Network-first с коротким таймаутом и фоллбэком на кэш
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
          const networkRes = await fetchWithTimeout(req, NAVIGATE_TIMEOUT_MS);
          if (networkRes && networkRes.status === 200) {
            cache.put('index.html', networkRes.clone()).catch(() => {});
          }
          return networkRes;
        } catch (e) {
          return (
            (await cache.match('index.html')) ||
            (await cache.match('./index.html')) ||
            new Response('Оффлайн-режим активен', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            })
          );
        }
      })()
    );
    return;
  }

  // 2. Картографические, DEM, векторные и лесные тайлы (Cache-First в wm-tiles-v1)
  if (isTileRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES_CACHE);
        const cached = await cache.match(req, { ignoreVary: true });
        if (cached) return cached;

        try {
          const res = await fetchWithTimeout(req, TILE_TIMEOUT_MS, { priority: 'low' });
          if (res && (res.status === 200 || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(() => {});
            trimTileCache(cache);
          }
          return res;
        } catch (e) {
          return new Response(null, { status: 504, statusText: 'Tile Fetch Failed' });
        }
      })()
    );
    return;
  }

  // 3. Внешние динамические API и токены — всегда напрямую в сеть
  if (isDynamicApiRequest(url)) {
    return;
  }

  // 4. Ресурсы оболочки приложения (Stale-While-Revalidate в SHELL_CACHE)
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cachedRes = await cache.match(req);

      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            cache.put(req, networkRes.clone()).catch(() => {});
          }
          return networkRes;
        })
        .catch(() => null);

      if (cachedRes) {
        event.waitUntil(fetchPromise);
        return cachedRes;
      }

      const netRes = await fetchPromise;
      return netRes || new Response('Offline', { status: 504, statusText: 'Offline' });
    })()
  );
});
