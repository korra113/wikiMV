/**
 * js/canopyV2.js
 * Модуль источника данных Meta CHM v2 (DINOv3, COG на Source Cooperative / AWS S3)
 * с HTTP Range-стримингом через geotiff.js и цепочкой фоллбэков.
 */
(function () {
  const WM = window.WM = window.WM || {};

  const TILE = 256;
  const HALF_WORLD = 20037508.342789244;
  const DEFAULT_SOURCE_COOP = 'https://data.source.coop/tge-labs/meta-chm-v2/{path}';
  const DEFAULT_AWS_S3 = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/{path}';
  const CF_V2_PROXY = 'https://forests.sylar1907942.workers.dev/v2/{path}';
  const YANDEX_V2_PROXY = 'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?v=2&path={path}';

  const GEOTIFF_CDN_FALLBACKS = [
    'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.min.js',
    'https://unpkg.com/geotiff@2.1.3/dist-browser/geotiff.js'
  ];

  // Палитра Viridis (совпадает с v1 GEE: min=0, max=25)
  const VIRIDIS_STOPS = [
    [68, 1, 84],    // 440154
    [72, 40, 120],  // 482878
    [62, 73, 137],  // 3e4989
    [49, 104, 142], // 31688e
    [38, 130, 142], // 26828e
    [31, 158, 137], // 1f9e89
    [53, 183, 121], // 35b779
    [110, 206, 88], // 6ece58
    [181, 222, 43], // b5de2b
    [253, 231, 37]  // fde725
  ];

  const VIRIDIS_RGBA = new Uint8ClampedArray(256 * 4);
  (function buildViridisLut() {
    for (let h = 1; h < 255; h++) {
      const t = Math.max(0, Math.min(1, h / 25));
      const pos = t * (VIRIDIS_STOPS.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(VIRIDIS_STOPS.length - 1, i0 + 1);
      const f = pos - i0;
      const c0 = VIRIDIS_STOPS[i0];
      const c1 = VIRIDIS_STOPS[i1];
      const off = h * 4;
      VIRIDIS_RGBA[off]     = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      VIRIDIS_RGBA[off + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      VIRIDIS_RGBA[off + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      VIRIDIS_RGBA[off + 3] = 255;
    }
  })();

  // Динамические зеркала, которые можно переопределить через gee-tokens.json на GitHub
  let dynamicDirectMirrors = [DEFAULT_SOURCE_COOP, DEFAULT_AWS_S3];

  // Сетевой менеджер для v2 с Circuit Breaker
  const V2Net = {
    states: [
      { id: 'direct_0', name: 'Source Cooperative v2 (Direct)', fails: 0, openUntil: 0, backoff: 12000, lastOk: 0, lastError: null },
      { id: 'direct_1', name: 'AWS S3 Meta CHM v2 (Direct)', fails: 0, openUntil: 0, backoff: 20000, lastOk: 0, lastError: null },
      { id: 'cf',       name: 'Cloudflare Worker (v2 Range)', fails: 0, openUntil: 0, backoff: 15000, lastOk: 0, lastError: null },
      { id: 'yandex',   name: 'Yandex Cloud (v2 Range)', fails: 0, openUntil: 0, backoff: 20000, lastOk: 0, lastError: null }
    ],
    lastSuccessfulIdx: 0,

    markSuccess(idx) {
      const s = this.states[idx];
      if (!s) return;
      s.fails = 0;
      s.openUntil = 0;
      s.backoff = 12000;
      s.lastOk = Date.now();
      s.lastError = null;
      this.lastSuccessfulIdx = idx;
    },

    markFailure(idx, err) {
      const s = this.states[idx];
      if (!s) return;
      const msg = err ? String(err.message || err) : 'Network error';
      if (msg.includes('404') || (err && err.name === 'AbortError')) return;
      s.fails++;
      s.lastError = msg;
      s.openUntil = Date.now() + Math.min(s.backoff, 120000);
      s.backoff = Math.min(s.backoff * 2, 120000);
    },

    isAlive(idx) {
      return this.states[idx] && Date.now() >= this.states[idx].openUntil;
    },

    resetCircuitBreakers() {
      this.states.forEach(s => {
        s.fails = 0;
        s.openUntil = 0;
        s.backoff = 12000;
      });
    },

    getPreferredOrder() {
      const order = [];
      if (this.isAlive(this.lastSuccessfulIdx)) order.push(this.lastSuccessfulIdx);
      for (let i = 0; i < this.states.length; i++) {
        if (!order.includes(i) && this.isAlive(i)) order.push(i);
      }
      return order.length ? order : [0, 1, 2, 3];
    },

    getDiagnostics() {
      return {
        activeHost: this.states[this.lastSuccessfulIdx]?.name || 'Не выбран',
        deadHosts: this.states.filter((_, i) => !this.isAlive(i)).map(s => s.name),
        allStates: this.states.map(s => ({
          name: s.name,
          alive: Date.now() >= s.openUntil,
          fails: s.fails,
          lastError: s.lastError
        }))
      };
    }
  };

  // Автоподгрузка geotiff.js с CDN, если не подключён локально
  let _geoTiffLoadPromise = null;
  function ensureGeoTiffLib() {
    if (window.GeoTIFF && typeof window.GeoTIFF.fromUrl === 'function') {
      return Promise.resolve(window.GeoTIFF);
    }
    if (_geoTiffLoadPromise) return _geoTiffLoadPromise;

    _geoTiffLoadPromise = (async () => {
      for (const src of GEOTIFF_CDN_FALLBACKS) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => (window.GeoTIFF ? resolve() : reject(new Error('GeoTIFF global missing')));
            s.onerror = () => reject(new Error('Script load error: ' + src));
            document.head.appendChild(s);
          });
          if (window.GeoTIFF) return window.GeoTIFF;
        } catch (e) {
          console.warn('[CanopyV2] Не удалось загрузить geotiff.js с', src, e);
        }
      }
      _geoTiffLoadPromise = null;
      throw new Error('Не удалось загрузить библиотеку geotiff.js');
    })();

    return _geoTiffLoadPromise;
  }

  function tileToQuadkey(x, y, z) {
    let qk = '';
    for (let i = z; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((x & mask) !== 0) digit += 1;
      if ((y & mask) !== 0) digit += 2;
      qk += digit;
    }
    return qk;
  }

  function tileToMercatorBbox(z, x, y) {
    const n = 1 << z;
    const tileSizeM = (HALF_WORLD * 2) / n;
    const minX = -HALF_WORLD + x * tileSizeM;
    const maxX = minX + tileSizeM;
    const maxY = HALF_WORLD - y * tileSizeM;
    const minY = maxY - tileSizeM;
    return [minX, minY, maxX, maxY];
  }

  function buildUrlForMirror(path, pIdx) {
    if (pIdx === 0 || pIdx === 1) {
      const tpl = dynamicDirectMirrors[pIdx];
      if (!tpl) return null;
      // overview/chm_overview_z8.tif есть только на Source Cooperative
      if (path.startsWith('overview/') && tpl.includes('dataforgood-fb-data')) return null;
      return tpl.replace('{path}', path);
    }
    if (pIdx === 2) return CF_V2_PROXY.replace('{path}', path);
    if (pIdx === 3) return YANDEX_V2_PROXY.replace('{path}', path);
    return null;
  }

  // Кэши
  const cogCache = new Map();       // path -> { tiff, image0, bbox, pIdx, url }
  const inFlightCog = new Map();    // path -> Promise
  const missingPaths = new Set();   // 404 (океан/пусто)
  const metersCache = new Map();    // "z/x/y" -> Uint8Array(65536) | ZERO_EMPTY
  const inFlightTiles = new Map();  // "z/x/y" -> Promise
  const ZERO_EMPTY = new Uint8Array(0);

  const MAX_COG_HANDLES = 28;
  const MAX_METERS_TILES = 360;
  let v2CacheGen = 0;

  function awaitWithAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        val => { signal.removeEventListener('abort', onAbort); resolve(val); },
        err => { signal.removeEventListener('abort', onAbort); reject(err); }
      );
    });
  }

  function setMetersCache(key, arr) {
    metersCache.set(key, arr);
    if (metersCache.size > MAX_METERS_TILES) {
      metersCache.delete(metersCache.keys().next().value);
    }
  }

  function setCogCache(path, entry) {
    cogCache.set(path, entry);
    if (cogCache.size > MAX_COG_HANDLES) {
      cogCache.delete(cogCache.keys().next().value);
    }
  }

  // Пробный запрос первых 16 байт для выбора рабочего зеркала и отсечки 404 без нагрузки на прокси
  function openCogHandle(path, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    if (missingPaths.has(path)) return Promise.resolve(null);
    if (cogCache.has(path)) return Promise.resolve(cogCache.get(path));

    let p = inFlightCog.get(path);
    if (!p) {
      const reqGen = v2CacheGen;
      p = (async () => {
        const GeoTIFF = await ensureGeoTiffLib();
        const order = V2Net.getPreferredOrder();

        for (const pIdx of order) {
          const url = buildUrlForMirror(path, pIdx);
          if (!url) continue;

          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 5000);

          try {
            const probe = await fetch(url, {
              method: 'GET',
              mode: 'cors',
              headers: { Range: 'bytes=0-15' },
              signal: ctl.signal
            });
            clearTimeout(tm);

            if (probe.status === 404) {
              if (pIdx === 0 || pIdx === 2 || pIdx === 3) {
                V2Net.markSuccess(pIdx);
                if (reqGen === v2CacheGen) missingPaths.add(path);
                return null;
              }
              continue;
            }

            // На публичном AWS S3 несуществующий ключ часто даёт 403 без ListBucket
            if (probe.status === 403 && pIdx === 1) {
              continue;
            }

            if (probe.status !== 206 && probe.status !== 200) {
              V2Net.markFailure(pIdx, new Error('HTTP ' + probe.status));
              continue;
            }

            const tiff = await GeoTIFF.fromUrl(url, {
              allowFullFile: false,
              blockSize: 65536,
              cacheSize: 200
            });
            const image0 = await tiff.getImage(0);
            const bbox = image0.getBoundingBox();

            V2Net.markSuccess(pIdx);
            const entry = { tiff, image0, bbox, pIdx, url };
            if (reqGen === v2CacheGen) setCogCache(path, entry);
            return entry;
          } catch (err) {
            clearTimeout(tm);
            V2Net.markFailure(pIdx, err);
          }
        }

        return null;
      })();

      inFlightCog.set(path, p);
      p.finally(() => {
        if (inFlightCog.get(path) === p) inFlightCog.delete(path);
      });
    }

    return awaitWithAbort(p, signal);
  }

  function resampleMetersTile(parentArr, parentZ, z, x, y) {
    if (parentArr === ZERO_EMPTY || !parentArr.length) return ZERO_EMPTY;
    const shift = z - parentZ;
    if (shift <= 0) return parentArr;
    const factor = 1 << shift;
    const subX = ((x % factor) + factor) % factor;
    const subY = ((y % factor) + factor) % factor;
    const subW = TILE / factor;
    const startX = subX * subW;
    const startY = subY * subW;

    const out = new Uint8Array(TILE * TILE);
    let hasNonZero = false;
    for (let py = 0; py < TILE; py++) {
      const srcY = Math.min(TILE - 1, Math.floor(startY + (py / TILE) * subW));
      const rowOff = py * TILE;
      const srcRowOff = srcY * TILE;
      for (let px = 0; px < TILE; px++) {
        const v = parentArr[srcRowOff + Math.min(TILE - 1, Math.floor(startX + (px / TILE) * subW))];
        out[rowOff + px] = v;
        if (v > 0 && v < 255) hasNonZero = true;
      }
    }
    return hasNonZero ? out : ZERO_EMPTY;
  }

  // Чтение матрицы высот 256×256 (в целых метрах 0..254) для тайла (z, x, y)
  async function fetchMetersTile(z, x, y, signal) {
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const n = 1 << z;
    if (y < 0 || y >= n) return ZERO_EMPTY;
    x = ((x % n) + n) % n;

    // Нативное разрешение CHM v2: 32768px на z10 = zoom 17
    if (z > 17) {
      const shift = z - 17;
      const parent = await fetchMetersTile(17, x >> shift, y >> shift, signal);
      if (parent === null) return null;
      return resampleMetersTile(parent, 17, z, x, y);
    }

    const cacheKey = `${z}/${x}/${y}`;
    if (metersCache.has(cacheKey)) return metersCache.get(cacheKey);

     if (WM.offlineArea && typeof WM.offlineArea.readCanopyV2Grid === 'function') {
      const decodeQ5ToMeters = (cached) => {
        if (cached === 'ZERO') return ZERO_EMPTY;
        const meters = new Uint8Array(TILE * TILE);
        let hasTrees = false;
        for (let i = 0; i < meters.length; i++) {
          const m = Math.round(cached[i] / 5);
          if (m > 0) { meters[i] = m; hasTrees = true; }
        }
        return hasTrees ? meters : ZERO_EMPTY;
      };

      const directHit = await WM.offlineArea.readCanopyV2Grid(z, x, y);
      if (directHit !== null) {
        const res = decodeQ5ToMeters(directHit);
        setMetersCache(cacheKey, res);
        return res;
      }

      // Если скачан z <= 15, а карта на z16..z17 — пробуем подрезать родительский тайл из кэша
      for (let pz = Math.min(z - 1, 15); pz >= 11; pz--) {
        const sh = z - pz;
        const pHit = await WM.offlineArea.readCanopyV2Grid(pz, x >> sh, y >> sh);
        if (pHit !== null) {
          const pMeters = decodeQ5ToMeters(pHit);
          const resampled = resampleMetersTile(pMeters, pz, z, x, y);
          setMetersCache(cacheKey, resampled);
          return resampled;
        }
      }

      if (navigator.onLine === false) return null;
    }

    let task = inFlightTiles.get(cacheKey);
    if (!task) {
      const reqGen = v2CacheGen;
      task = (async () => {
        let path;
        let targetBbox;

        if (z < 10) {
          path = 'overview/chm_overview_z8.tif';
          targetBbox = tileToMercatorBbox(z, x, y);
        } else {
          const shift = z - 10;
          const qx = x >> shift;
          const qy = y >> shift;
          const qk = tileToQuadkey(qx, qy, 10);
          path = `chm/${qk}.tif`;
        }

        if (missingPaths.has(path)) {
          if (reqGen === v2CacheGen) setMetersCache(cacheKey, ZERO_EMPTY);
          return ZERO_EMPTY;
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          const handle = await openCogHandle(path);
          if (!handle) {
            if (missingPaths.has(path)) {
              if (reqGen === v2CacheGen) setMetersCache(cacheKey, ZERO_EMPTY);
              return ZERO_EMPTY;
            }
            return null;
          }

          try {
            if (z >= 10) {
              const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
              const factor = 1 << (z - 10);
              const subX = ((x % factor) + factor) % factor;
              const subY = ((y % factor) + factor) % factor;
              const spanX = (bMaxX - bMinX) / factor;
              const spanY = (bMaxY - bMinY) / factor;
              targetBbox = [
                bMinX + subX * spanX,
                bMaxY - (subY + 1) * spanY,
                bMinX + (subX + 1) * spanX,
                bMaxY - subY * spanY
              ];
            } else {
              const [iMinX, iMinY, iMaxX, iMaxY] = handle.bbox;
              if (targetBbox[2] <= iMinX || targetBbox[0] >= iMaxX ||
                  targetBbox[3] <= iMinY || targetBbox[1] >= iMaxY) {
                if (reqGen === v2CacheGen) setMetersCache(cacheKey, ZERO_EMPTY);
                return ZERO_EMPTY;
              }
            }

            const rasters = await handle.tiff.readRasters({
              bbox: targetBbox,
              width: TILE,
              height: TILE,
              samples: [0],
              fillValue: 0,
              resampleMethod: 'nearest'
            });

            const band = rasters && rasters[0];
            if (!band || band.length !== TILE * TILE) {
              if (reqGen === v2CacheGen) setMetersCache(cacheKey, ZERO_EMPTY);
              return ZERO_EMPTY;
            }

            const out = new Uint8Array(TILE * TILE);
            let hasTrees = false;
            for (let i = 0; i < out.length; i++) {
              const raw = band[i];
              if (raw > 0 && raw < 255) {
                const v = Math.round(raw);
                if (v > 0 && v < 255) {
                  out[i] = v;
                  hasTrees = true;
                }
              }
            }

            const finalArr = hasTrees ? out : ZERO_EMPTY;
            if (reqGen === v2CacheGen) setMetersCache(cacheKey, finalArr);
            return finalArr;
          } catch (err) {
            cogCache.delete(path);
            V2Net.markFailure(handle.pIdx, err);
          }
        }
        return null;
      })();

      inFlightTiles.set(cacheKey, task);
      task.finally(() => {
        if (inFlightTiles.get(cacheKey) === task) inFlightTiles.delete(cacheKey);
      });
    }

    return awaitWithAbort(task, signal);
  }

  // Генерация PNG Blob для растровых слоёв 'height' (Viridis) и 'mask' (#00ff00)
  async function renderTileBlob(type, z, x, y, signal) {
    const meters = await fetchMetersTile(z, x, y, signal);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (meters === null) return { error: true, blob: null };
    if (meters === ZERO_EMPTY) return { error: false, empty: true, blob: null };

    const cv = document.createElement('canvas');
    cv.width = TILE;
    cv.height = TILE;
    const ctx = cv.getContext('2d');
    const imgData = ctx.createImageData(TILE, TILE);
    const d = imgData.data;

    if (type === 'mask') {
      for (let i = 0, p = 0; i < meters.length; i++, p += 4) {
        if (meters[i] >= 1) {
          d[p] = 0;
          d[p + 1] = 255;
          d[p + 2] = 0;
          d[p + 3] = 255;
        }
      }
    } else {
      for (let i = 0, p = 0; i < meters.length; i++, p += 4) {
        const h = meters[i];
        if (h > 0) {
          const lutOff = h * 4;
          d[p]     = VIRIDIS_RGBA[lutOff];
          d[p + 1] = VIRIDIS_RGBA[lutOff + 1];
          d[p + 2] = VIRIDIS_RGBA[lutOff + 2];
          d[p + 3] = 255;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const blob = await new Promise(resolve => cv.toBlob(resolve, 'image/png'));
    return { error: false, empty: false, blob };
  }

  WM.canopyV2 = {
    applyTokensConfig(v2Cfg) {
      if (!v2Cfg) return;
      if (Array.isArray(v2Cfg.directMirrors) && v2Cfg.directMirrors.length > 0) {
        dynamicDirectMirrors = v2Cfg.directMirrors.slice(0, 2);
        V2Net.markSuccess(0);
      }
    },

    // Возвращает Uint8Array(65536), квантованный с шагом Q (как в TreeEngine)
    async fetchHeightGridQ(z, x, y, Q, signal) {
      const meters = await fetchMetersTile(z, x, y, signal);
      if (meters === null) return null;
      if (meters === ZERO_EMPTY) return 'ZERO';

      const out = new Uint8Array(TILE * TILE);
      for (let i = 0; i < out.length; i++) {
        const m = meters[i];
        if (m > 0) out[i] = Math.min(250, m * Q);
      }
      return out;
    },

    renderTileBlob,

    resetCircuitBreakers() {
      V2Net.resetCircuitBreakers();
    },

    getDiagnostics() {
      return V2Net.getDiagnostics();
    },

    clearCache() {
      v2CacheGen++;
      metersCache.clear();
      inFlightTiles.clear();
      missingPaths.clear();
    },

    clearAll() {
      this.clearCache();
      cogCache.clear();
      inFlightCog.clear();
    }
  };
})();