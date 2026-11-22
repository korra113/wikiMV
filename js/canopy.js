/**
 * js/canopy.js
 * Модуль растительности: слои Canopy Height (высота), Canopy Mask (маска)
 * и процедурный генератор 2D-гравюрных деревьев (TreeEngine).
 */
(function () {
  const WM = window.WM = window.WM || {};
  const TILE_DPR = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);

  function isPeakViewForeground() {
    const pv = WM.peakView;
    return !!(
      pv &&
      typeof pv.isOpen === 'function' && pv.isOpen() &&
      !(typeof pv.isMinimized === 'function' && pv.isMinimized())
    );
  }
  const COMMON_TILE_OPTIONS = {
    keepBuffer: 1,
    updateWhenIdle: false,
    updateWhenZooming: false,
    updateInterval: 120
  };

// Оставляем реальные работающие адреса
const CANOPY_HEIGHT_PROVIDERS = [
  'https://forests.sylar1907942.workers.dev/tiles/height/{z}/{x}/{y}',
  'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=height&z={z}&x={x}&y={y}'
];

const CANOPY_MASK_PROVIDERS = [
  'https://forests.sylar1907942.workers.dev/tiles/mask/{z}/{x}/{y}',
  'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=mask&z={z}&x={x}&y={y}'
];

const CANOPY_SPECIES_PROVIDERS = [
  'https://forests.sylar1907942.workers.dev/tiles/species/{z}/{x}/{y}',
  'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=species&z={z}&x={x}&y={y}'
];

// =========================================================================
  // МЕНЕДЖЕР АКТУАЛЬНЫХ ТОКЕНОВ И ШАБЛОНОВ GEE
  // =========================================================================
  const CanopyTokens = {
    templates: {
      height: null,
      mask: null,
      species: null,
      water: null
    },
    isLoaded: false,

    // Мгновенная загрузка из localStorage (чтобы при повторных входах прямой Google работал с 0-й миллисекунды)
    loadFromCache() {
      try {
        const raw = localStorage.getItem('wm_gee_tokens');
        if (raw) {
          const data = JSON.parse(raw);
          if (data.templates && data.expiresAt && Date.now() < data.expiresAt) {
            this.templates = data.templates;
            this.isLoaded = true;
            return true;
          }
        }
      } catch (e) {}
      return false;
    },

    saveToCache(data) {
      try {
        localStorage.setItem('wm_gee_tokens', JSON.stringify(data));
      } catch (e) {}
    },

    async init() {
      this.loadFromCache();

      // Источники для обновления ссылок:
      // 1. Статический GitHub Pages (быстро, бесплатно)
      // 2. Резервный эндпоинт Яндекс.Функции
      const sources = [
        'https://korra113.github.io/forests_map/gee-tokens.json',
        'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?action=tokens'
      ];

      for (const url of sources) {
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 3500);
          const res = await fetch(url, { signal: ctl.signal });
          clearTimeout(tm);

          if (res.ok) {
            const data = await res.json();
            if (data.v2 && WM.canopyV2 && WM.canopyV2.applyTokensConfig) {
              WM.canopyV2.applyTokensConfig(data.v2);
            }
            const t = data.templates || data;
            const changed = !this.templates || this.templates.height !== t.height || this.templates.mask !== t.mask;
            if (t && t.height) {
              this.templates = t;
              this.isLoaded = true;
              this.saveToCache({
                templates: t,
                expiresAt: data.expiresAt || (Date.now() + 20 * 3600 * 1000)
              });
              if (changed) {
                CanopyNet.states[0].fails = 0;
                CanopyNet.states[0].openUntil = 0;
                CanopyNet.states[0].backoff = 10000;
              }
              return;
            }
          }
        } catch (e) {}
      }
    },

    // Получение URL для конкретного типа слоя и уровня зеркала
    getProviderUrl(type, pIdx) {
      if (pIdx === 0) {
        // Уровень 1: Прямой Google Earth Engine (если токены есть)
        return this.templates[type] || null;
      }
      if (pIdx === 1) {
        // Уровень 2: Cloudflare Worker CDN
        return `https://forests.sylar1907942.workers.dev/tiles/${type}/{z}/{x}/{y}`;
      }
      if (pIdx === 2) {
        // Уровень 3: Яндекс.Функция (внутри РФ)
        return `https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=${type}&z={z}&x={x}&y={y}`;
      }
      return null;
    }
  };

  async function readCachedCanopyBlob(type, z, x, y) {
    if (!WM.offlineArea || typeof WM.offlineArea.readCachedBlob !== 'function') return null;
    const candidates = [
      `https://forests.sylar1907942.workers.dev/tiles/${type}/${z}/${x}/${y}`,
      `https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=${type}&z=${z}&x=${x}&y=${y}`
    ];
    const geeTpl = CanopyTokens.getProviderUrl(type, 0);
    if (geeTpl) {
      candidates.push(L.Util.template(geeTpl, { z, x, y, s: 'a' }));
    }
    for (const url of candidates) {
      try {
        const blob = await WM.offlineArea.readCachedBlob(url);
        if (blob) return blob;
      } catch (e) {}
    }
    return null;
  }

  // Запуск фоновой проверки токенов
  CanopyTokens.init();

  // =========================================================================
  // СЕТЕВОЙ МЕНЕДЖЕР ЗЕРКАЛ (CIRCUIT BREAKER)
  // =========================================================================
  const CanopyNet = {
    states: [
      { name: 'Google Earth Engine (Direct)', fails: 0, openUntil: 0, backoff: 10000, lastOk: 0, lastError: null },
      { name: 'Cloudflare Worker CDN', fails: 0, openUntil: 0, backoff: 15000, lastOk: 0, lastError: null },
      { name: 'Yandex Cloud Functions', fails: 0, openUntil: 0, backoff: 15000, lastOk: 0, lastError: null }
    ],
    lastSuccessfulIdx: 0,

    markSuccess(idx) {
      if (!this.states[idx]) return;
      const s = this.states[idx];
      s.fails = 0;
      s.openUntil = 0;
      s.backoff = 10000;
      s.lastOk = Date.now();
      s.lastError = null;
      this.lastSuccessfulIdx = idx;
    },

    markFailure(idx, err) {
      if (!this.states[idx]) return;
      if (err) {
        const msg = String(err.message || err);
        if (msg.includes('404') || (err.name === 'AbortError' && !err.isTimeout)) return;
      }
      const s = this.states[idx];
      s.fails++;
      s.lastError = err ? (err.message || String(err)) : 'Network error';
      const isConnProblem = !!(err && (err.isTimeout || err.name === 'TypeError'));
      const openAfter = isConnProblem ? 1 : 2;
      if (s.fails >= openAfter) {
        if (isConnProblem && s.backoff < 60000) s.backoff = 60000;
        s.openUntil = Date.now() + Math.min(s.backoff, 180000);
        s.backoff = Math.min(s.backoff * 2, 180000);
      }
    },

    isAlive(idx) {
      return this.states[idx] && Date.now() >= this.states[idx].openUntil;
    },

    resetCircuitBreakers() {
      this.states.forEach(s => {
        s.fails = 0;
        s.openUntil = 0;
        s.backoff = 10000;
      });
    },

    getAliveOrder() {
      const order = [];
      if (this.isAlive(this.lastSuccessfulIdx)) {
        order.push(this.lastSuccessfulIdx);
      }
      for (let i = 0; i < this.states.length; i++) {
        if (!order.includes(i) && this.isAlive(i)) {
          order.push(i);
        }
      }
      return order;
    },

    getPreferredOrder() {
      const order = this.getAliveOrder();
      return order.length > 0 ? order : [0, 1, 2];
    },

    getDiagnostics() {
      return {
        activeHost: this.states[this.lastSuccessfulIdx]?.name || 'Не выбран',
        deadHosts: this.states.filter((s, i) => !this.isAlive(i)).map(s => s.name),
        allStates: this.states.map(s => ({
          name: s.name,
          alive: Date.now() >= s.openUntil,
          fails: s.fails,
          lastError: s.lastError
        }))
      };
    }
  };
   WM.canopyTokens = CanopyTokens;
  WM.canopyNet = CanopyNet;


  const CANOPY_MAX_PARALLEL = 10;
  let _canopyActive = 0;
  const _canopyWaiters = [];

  function acquireCanopySlot(signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    if (_canopyActive < CANOPY_MAX_PARALLEL) {
      _canopyActive++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const entry = {
        resolve: () => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject
      };
      if (signal) {
        onAbort = () => {
          const idx = _canopyWaiters.indexOf(entry);
          if (idx !== -1) _canopyWaiters.splice(idx, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      _canopyWaiters.push(entry);
    });
  }

  function releaseCanopySlot() {
    while (_canopyWaiters.length) {
      const next = _canopyWaiters.pop();
      if (next && next.resolve) {
        next.resolve();
        return;
      }
    }
    _canopyActive = Math.max(0, _canopyActive - 1);
  }


  // Безопасный загрузчик тайлов подложки через fetch + blob (без зависания сокетов)
  const TRANSPARENT_1PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  async function decodeBlobToImageOrBitmap(blob) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(blob, { premultiplyAlpha: 'none' });
      } catch (e) {}
    }
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const blobUrl = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(blobUrl); res(img); };
      img.onerror = (e) => { URL.revokeObjectURL(blobUrl); rej(e); };
      img.src = blobUrl;
    });
  }

  async function cropCachedCanopyParent(layerType, z, x, y) {
    for (let pz = z - 1; pz >= Math.max(11, z - 7); pz--) {
      const shift = z - pz;
      const parentBlob = await readCachedCanopyBlob(layerType, pz, x >> shift, y >> shift);
      if (!parentBlob) continue;
      try {
        const bmp = await decodeBlobToImageOrBitmap(parentBlob);
        const factor = 1 << shift;
        const subX = ((x % factor) + factor) % factor;
        const subY = ((y % factor) + factor) % factor;
        const w = bmp.naturalWidth || bmp.width || 256;
        const h = bmp.naturalHeight || bmp.height || 256;
        const subW = w / factor;
        const subH = h / factor;

        const cv = document.createElement('canvas');
        cv.width = 256;
        cv.height = 256;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bmp, subX * subW, subY * subH, subW, subH, 0, 0, 256, 256);
        if (bmp.close) bmp.close();

        return await new Promise(res => cv.toBlob(res, 'image/png'));
      } catch (e) {}
    }
    return null;
  }

  // Безопасный загрузчик тайлов подложки (поддержка v1 GEE и v2 COG)
  const CanopyFallbackLayer = L.TileLayer.extend({
    initialize(options) {
      L.TileLayer.prototype.initialize.call(this, '', options);
      this.layerType = options.layerType || 'height'; // 'height' или 'mask'
    },

    createTile(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');

      let isAborted = false;
      const mainCtl = new AbortController();
      const zoom = this._getZoomForUrl();

      // --- РЕЖИМ v2 (Meta CHM v2 COG через geotiff.js) ---
      if (canopySettings.canopyVersion === 'v2' && WM.canopyV2) {
        (async () => {
          await acquireCanopySlot();
          try {
            if (isAborted) return;
            const res = await WM.canopyV2.renderTileBlob(
              this.layerType, zoom, coords.x, coords.y, mainCtl.signal
            );
            if (isAborted) return;

            if (res && res.blob) {
              const blobUrl = URL.createObjectURL(res.blob);
              tile.onload = () => { URL.revokeObjectURL(blobUrl); done(null, tile); };
              tile.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                done(new Error('V2 blob decode error'), tile);
              };
              tile.src = blobUrl;
              return;
            }
            if (res && res.empty) {
              tile.onload = () => done(null, tile);
              tile.src = TRANSPARENT_1PX;
              return;
            }
            done(new Error('V2 canopy tile unavailable'), tile);
          } catch (e) {
            if (!isAborted) done(e, tile);
          } finally {
            releaseCanopySlot();
          }
        })();

        tile._cleanup = () => { isAborted = true; mainCtl.abort(); };
        return tile;
      }

      // --- РЕЖИМ v1 (GEE / Cloudflare / Yandex PNG) ---
      const order = CanopyNet.getPreferredOrder();

      const applyBlobToTile = (blob, shouldIngest = false) => {
        if (shouldIngest && this.layerType === 'height' && zoom >= 11 && zoom <= 16) {
          TreeEngine.ingestHeightBlob(zoom, coords.x, coords.y, blob);
        }
        const blobUrl = URL.createObjectURL(blob);
        tile.onload = () => { URL.revokeObjectURL(blobUrl); done(null, tile); };
        tile.onerror = () => { URL.revokeObjectURL(blobUrl); done(new Error('Cached blob decode error'), tile); };
        tile.src = blobUrl;
      };

      (async () => {
        const cachedBlob = await readCachedCanopyBlob(this.layerType, zoom, coords.x, coords.y);
        if (isAborted) return;
        if (cachedBlob) {
          applyBlobToTile(cachedBlob, true); // <-- отдаём и кэшированный тайл в TreeEngine
          return;
        }
        if (navigator.onLine === false) {
          const parentBlob = await cropCachedCanopyParent(this.layerType, zoom, coords.x, coords.y);
          if (isAborted) return;
          if (parentBlob) {
            applyBlobToTile(parentBlob, false);
            return;
          }
          done(new Error('Offline and not cached'), tile);
          return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const order = CanopyNet.getAliveOrder();
          if (!order.length) break;

          for (let oi = 0; oi < order.length; oi++) {
            if (isAborted) return;
            const pIdx = order[oi];
            if (!CanopyNet.isAlive(pIdx)) continue;

            const tpl = CanopyTokens.getProviderUrl(this.layerType, pIdx);
            if (!tpl) continue;

            const url = L.Util.template(tpl, {
              z: zoom,
              x: coords.x,
              y: coords.y,
              s: 'a'
            });

            const ctl = new AbortController();
            let timedOut = false;
            const onMainAbort = () => ctl.abort();
            mainCtl.signal.addEventListener('abort', onMainAbort, { once: true });

            const timeoutMs = (oi < order.length - 1) ? 3200 : 5000;
            const tm = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);

            try {
              const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });

              if (!resp.ok) {
                if (resp.status !== 404) CanopyNet.markFailure(pIdx, new Error(`HTTP ${resp.status}`));
                continue;
              }

              const blob = await resp.blob();
              clearTimeout(tm); // Таймер снят ТОЛЬКО после скачивания всего тела
              if (isAborted) return;

              const blobUrl = URL.createObjectURL(blob);

              tile.onload = () => {
                URL.revokeObjectURL(blobUrl);
                CanopyNet.markSuccess(pIdx);
                if (this.layerType === 'height' && zoom >= 11 && zoom <= 16) {
                  TreeEngine.ingestHeightBlob(zoom, coords.x, coords.y, blob);
                }
                done(null, tile);
              };
              tile.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                CanopyNet.markFailure(pIdx);
              };
              tile.src = blobUrl;
              return;
            } catch (e) {
              if (!isAborted || timedOut) {
                CanopyNet.markFailure(pIdx, {
                  name: e.name,
                  message: timedOut ? 'Timeout' : e.message,
                  isTimeout: timedOut
                });
              }
            } finally {
              clearTimeout(tm);
              mainCtl.signal.removeEventListener('abort', onMainAbort);
            }
          }
   
          if (attempt === 0 && !isAborted && CanopyNet.getAliveOrder().length > 0) {
            await new Promise(r => setTimeout(r, 400));
          } else {
            break;
          }
        }

        const parentBlob = await cropCachedCanopyParent(this.layerType, zoom, coords.x, coords.y);
        if (isAborted) return;
        if (parentBlob) {
          applyBlobToTile(parentBlob);
          return;
        }

        done(new Error('All canopy providers failed'), tile);
      })();

      tile._cleanup = () => { isAborted = true; mainCtl.abort(); };
      return tile;
    },
    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile && tile._cleanup) tile._cleanup();
      L.TileLayer.prototype._removeTile.call(this, key);
    }
  });



  // =========================================================================
  // 🎨 ГЛОБАЛЬНЫЕ НАСТРОЙКИ ТЕКСТУРИРОВАНИЯ ДЕРЕВЬЕВ И ХОЛСТА КАРТЫ
  // =========================================================================
  const CANOPY_DEV_CONFIG = {
    // 1. ФАКТУРА БУМАГИ И РАСТВОРЕНИЕ
    paper: {
      fiberScaleX: 1.0,
      fiberScaleY: 1.0,
      crossFiberScaleX: 2.5,
      crossFiberScaleY: 7.0,
      speckleAmount: 0.27,
      darkFiberAlpha: 145,
      erosionContrast: 3.3,
      bleedMultiplier: 1.1
    },

    // 2. ШЕРОХОВАТОСТЬ ЛИСТВЫ (Крапинки)
    roughness: {
      enabled: true,
      density: 3.5,
      dotRadiusMin: 0.45,
      dotRadiusMax: 1.15,
      darkNoiseOpacity: 0.95,
      lightNoiseOpacity: 0.5
    },

    // 3. СОЛНЕЧНЫЕ ПЯТНА И БЛИКИ
    dappledLight: {
      enabled: true,
      spotCount: 12,
      spotRadiusMin: 0.12,
      spotRadiusMax: 0.26,
      spotOpacity: 1.0,
      spotWarmthShift: 0.2,
      coniferSparkles: true,
      coniferSparkleCount: 5
    },

    // 4. СЛЕПЛИВАНИЕ В МАССИВЫ И КУРТИНЫ (TUFT)
    clustering: {
      tuftRadiusRatio: 0.61,
      massifNeighborThreshold: 5,
      massifCovThreshold: 0.80,
      suppressInnerStrokes: true,
      restoreTopArcs: true,
      innerStrokeRate: 0.60,
      innerStrokeAlpha: 0.90,
      innerStrokeScale: 1.6,
      innerTopArcReach: 0.55,
      massifBaseDarkness: 0.58,
      autoDenseThinning: 0.32,
      tuftStrokeScale: 1.1,    // толщина внешнего контура пучков
      tuftStrokeAlpha: 1.0,    // прозрачность внешнего контура пучков
      tuftShadowStroke: 1.4,   // усиление обводки на теневой стороне пучка
    },

    coniferMerge: {
      enabled: true,
      hideRate: 0.64,           // базовая доля скрытых елей (для z>=16; на 11..15 адаптируется в getZoomAdaptiveParams)
      pawRate: 0.04,            // доля низких «лап» среди видимых
      peakHeight: 1.35,         // множитель высоты макушек
      peakWidth: 1.65,          // множитель ширины макушек
      openBottom: true,         // открытый нижний контур у макушек (вплавление в подлесок)
      skirtWidth: 1.05,         // ширина «юбки» под макушкой
      skirtAlpha: 1.0,          // непрозрачность «юбки» под макушкой (0 — убрать)
      carpetDarkness: 0.63,     // тёмность подлеска
      carpetMidMix: 0.80,       // подмешивание светлого тона в подлесок
      carpetSize: 0.58,         // радиус подлеска в долях размера кроны
      carpetAspect: 0.65,       // сплюснутость подлеска по вертикали
      carpetStrokeAlpha: 0.80,  // контур тушью вокруг подлеска (0 — выкл.)
      chevrons: 1.2,            // плотность штриховых «ёлочек» на подлеске (0 — выкл.)
      chevronAlpha: 0.80        // контраст штрихов на подлеске
    },

    conifer: {
      sizeScale: 1.35,          // общий масштаб крон елей (не трогает лиственные)
      heightRatio: 2.05,        // вытянутость ели вверх (yTip = -heightRatio * r)
      widthRatio: 0.66,         // ширина основания ели (hwMax = widthRatio * r)
      tierCountBias: 0,         // сдвиг числа ярусов (-1 .. +2)
      tierOverlap: 0.99,        // шаг/нахлёст ярусов (меньше = плотнее сидят ярусы)
      slopeConcave: 0.30,       // форма боков яруса (0.1 острая, 0.3 вогнутая, 0.7 пушистая)
      scallopDepth: 0.55,       // глубина зубцов/фестонов лап снизу яруса
      strokeWidthMul: 1.45,     // толщина тушевого контура елей
      shadeMul: 1.10,           // плотность тени на теневой стороне хвои
      hatchAlpha: 0.85,         // контраст штриховки на елях
      hueShift: 0,              // сдвиг оттенка хвои (-45 .. +45)
      satMul: 1.0,              // множитель насыщенности хвои
      brightMul: 1.0            // множитель яркости хвои
    },

    // 5. ВЕРОЯТНОСТИ РЕДКИХ ДЕРЕВЬЕВ И ДЕКОРА
    deco: {
      deadRate: 0.028,
      birchRate: 0.026,
      bushRate: 0.026,
      stumpRate: 0.015,
      moundRate: 0.020,
      rocksRate: 0.015,
      grassRate: 0.030,
      logRate: 0.009
    },

    // 6. ГЕОМЕТРИЯ И РАЗМЕР КРОНЫ
    geometry: {
      crownBaseMeters: 6.0,
      crownHeightFactor: 0.22,
      treeJitter: 0.55,
      strokeWidthFactor: 0.03
    }
  };

  WM.canopyDevConfig = CANOPY_DEV_CONFIG;
  WM.canopyTextureConfig = CANOPY_DEV_CONFIG;

  const DEFAULT_CANOPY_SETTINGS = {
    heightEnabled: false,
    heightOpacity: 0.75,
    maskEnabled: false,
    maskOpacity: 0.85,
    maskTint: 'emerald',
    blendMode: 'normal',
    canopyFantasyForest: true,
    canopyVersion: 'v1',

    treeClearRivers: true,
    treeClearRiversDist: 1.0,
    treeClearRiversOpacity: 1.0,
    treeClearRiversSoftness: 0.35,

    treeClearRoads: true,
    treeClearRoadsDist: 1.2,
    treeClearRoadsOpacity: 0.95,
    treeClearRoadsSoftness: 0.7,

    treeVolumetric: 0.35,
    treeStrokeColor: '#0d0a07',
    treePaperBleed: 0.8,
    treeNightBrightness: 2.5,
    treeNightContrast: 0.9,
    treeEdgeScale: 0.7,
    treeMassifScale: 0.9,

    treeOpaqueFill: true,
    treeFillWarmth: 0.66,
    treeFillBrightness: 0.9,
    treeFillSaturation: 0.8,

    customColors: true,
    decidColor1: '#83703a',
    decidColor2: '#5b6a2f',
    coniferColor: '#4a5550',
    decidRatio: 0.64,
    colorScatter: 0.4,

    treeSlopeSuppression: 0.9,
    treeSlopeTolerance: 0.05,

    treeNightTint: '#939feb',
    treeNightStrength: 0.24,

    treeShadeOpacity: 0.44,
    treeShadeDarkness: 0.38,

    treeGroundShadowColor: '#08081b',
    treeGroundShadowCustom: false,

    treeContactShadowOpacity: 0.62,
    treeMassifBaseDarkness: 0.48,

    treesEnabled: true,
    treeStyle: 'real',
    treeDensity: 1.25,
    treeScale: 1.7,
    treeColor: '#0d0a07',
    treeOpacity: 0.95,
    treeShadows: true,
    treeBlendMode: 'darken',
    treeAutoDense: true,
    treeAutoDenseScale: 2.5,
    treeAutoDenseThinning: 0.3,

    treeClustering: true,
    treeMinH: 2.0,
    forestOnlyThreshold: 0.85,

    treeVariety: 0.6,
    treeTerrainLight: true,
    treeTerrainShadows: true,
    treeShadowStrength: 1.34
  };

  const CANOPY_LS_KEYS = {
    heightEnabled: 'wm_canopy_height_on',
    heightOpacity: 'wm_canopy_height_opacity',
    maskEnabled: 'wm_canopy_mask_on',
    maskOpacity: 'wm_canopy_mask_opacity',
    maskTint: 'wm_canopy_mask_tint',
    blendMode: 'wm_canopy_blend',
    treeClearRivers: 'wm_canopy_tree_clear_rivers',
    treeClearRiversDist: 'wm_canopy_tree_clear_rivers_dist',
    treeClearRiversOpacity: 'wm_canopy_tree_clear_rivers_opacity',
    treeClearRiversSoftness: 'wm_canopy_tree_clear_rivers_softness',
    canopyFantasyForest: 'wm_canopy_fantasy_forest',
    canopyVersion: 'wm_canopy_version',
    treeClearRoads: 'wm_canopy_tree_clear_roads',
    treeClearRoadsDist: 'wm_canopy_tree_clear_roads_dist',
    treeClearRoadsOpacity: 'wm_canopy_tree_clear_roads_opacity',
    treeClearRoadsSoftness: 'wm_canopy_tree_clear_roads_softness',
    treeVolumetric: 'wm_canopy_tree_volumetric',
    treeStrokeColor: 'wm_canopy_tree_stroke_color',
    treePaperBleed: 'wm_canopy_tree_paper_bleed',
    treeNightBrightness: 'wm_canopy_night_bright',
    treeNightContrast: 'wm_canopy_night_contrast',
    treeEdgeScale: 'wm_canopy_tree_edge_scale',
    treeMassifScale: 'wm_canopy_tree_massif_scale',
    treeOpaqueFill: 'wm_canopy_tree_opaque_fill',
    treeFillWarmth: 'wm_canopy_tree_fill_warmth',
    treeFillBrightness: 'wm_canopy_tree_fill_brightness',
    treeFillSaturation: 'wm_canopy_tree_fill_saturation',
    customColors: 'wm_canopy_custom_colors_on',
    decidColor1: 'wm_canopy_decid_col1',
    decidColor2: 'wm_canopy_decid_col2',
    coniferColor: 'wm_canopy_conifer_col',
    decidRatio: 'wm_canopy_decid_ratio',
    colorScatter: 'wm_canopy_color_scatter',
    treeSlopeSuppression: 'wm_canopy_tree_slope_suppress',
    treeSlopeTolerance: 'wm_canopy_tree_slope_tol',
    treeNightTint: 'wm_canopy_night_tint',
    treeNightStrength: 'wm_canopy_night_strength',
    treeShadeOpacity: 'wm_canopy_shade_opacity',
    treeShadeDarkness: 'wm_canopy_shade_darkness',
    treeGroundShadowColor: 'wm_canopy_ground_shadow_col',
    treeGroundShadowCustom: 'wm_canopy_ground_shadow_custom',
    treeContactShadowOpacity: 'wm_canopy_contact_shadow_opacity',
    treeMassifBaseDarkness: 'wm_canopy_massif_base_dark',
    treesEnabled: 'wm_canopy_trees_on',
    treeStyle: 'wm_canopy_tree_style',
    treeDensity: 'wm_canopy_tree_density',
    treeScale: 'wm_canopy_tree_scale',
    treeColor: 'wm_canopy_tree_color',
    treeOpacity: 'wm_canopy_tree_opacity',
    treeShadows: 'wm_canopy_tree_shadows',
    treeBlendMode: 'wm_canopy_tree_blend',
    treeAutoDense: 'wm_canopy_tree_autodense',
    treeAutoDenseScale: 'wm_canopy_tree_autodense_scale',
    treeAutoDenseThinning: 'wm_canopy_tree_autodense_thin',
    treeClustering: 'wm_canopy_tree_clustering',
    treeMinH: 'wm_canopy_tree_min_h',
    forestOnlyThreshold: 'wm_canopy_forest_only',
    treeVariety: 'wm_canopy_tree_variety',
    treeTerrainLight: 'wm_canopy_tree_terrain_light',
    treeTerrainShadows: 'wm_canopy_tree_terrain_shadows',
    treeShadowStrength: 'wm_canopy_tree_shadow_strength'
  };

  function saveAllCanopySettings() {
    if (window._wmResetting) return;
    for (const k in CANOPY_LS_KEYS) {
      try {
        localStorage.setItem(CANOPY_LS_KEYS[k], String(canopySettings[k]));
      } catch (e) {}
    }
  }

 let canopySettings = {
    heightEnabled: localStorage.getItem('wm_canopy_height_on') === 'true',
    heightOpacity: parseFloat(localStorage.getItem('wm_canopy_height_opacity') ?? '0.75'),
    maskEnabled: localStorage.getItem('wm_canopy_mask_on') === 'true',
    maskOpacity: parseFloat(localStorage.getItem('wm_canopy_mask_opacity') ?? '0.85'),
    maskTint: localStorage.getItem('wm_canopy_mask_tint') || 'emerald',
    blendMode: localStorage.getItem('wm_canopy_blend') || 'normal',
    canopyFantasyForest: localStorage.getItem('wm_canopy_fantasy_forest') !== 'false',

    treeClearRivers: localStorage.getItem('wm_canopy_tree_clear_rivers') !== 'false',
    treeClearRiversDist: parseFloat(localStorage.getItem('wm_canopy_tree_clear_rivers_dist') ?? '1.0'),
    treeClearRiversOpacity: parseFloat(localStorage.getItem('wm_canopy_tree_clear_rivers_opacity') ?? '1.0'),
    treeClearRiversSoftness: parseFloat(localStorage.getItem('wm_canopy_tree_clear_rivers_softness') ?? '0.35'),

    canopyVersion: localStorage.getItem('wm_canopy_version') || 'v1',

    treeClearRoads: localStorage.getItem('wm_canopy_tree_clear_roads') !== 'false',
    treeClearRoadsDist: parseFloat(localStorage.getItem('wm_canopy_tree_clear_roads_dist') ?? '1.2'),
    treeClearRoadsOpacity: parseFloat(localStorage.getItem('wm_canopy_tree_clear_roads_opacity') ?? '0.95'),
    treeClearRoadsSoftness: parseFloat(localStorage.getItem('wm_canopy_tree_clear_roads_softness') ?? '0.7'),

    treeVolumetric: parseFloat(localStorage.getItem('wm_canopy_tree_volumetric') ?? '0.35'),
    treeStrokeColor: localStorage.getItem('wm_canopy_tree_stroke_color') || '#0d0a07',
    treePaperBleed: parseFloat(localStorage.getItem('wm_canopy_tree_paper_bleed') ?? '0.8'),
    treeNightBrightness: parseFloat(localStorage.getItem('wm_canopy_night_bright') ?? '2.5'),
    treeNightContrast: parseFloat(localStorage.getItem('wm_canopy_night_contrast') ?? '0.9'),
    treeEdgeScale: parseFloat(localStorage.getItem('wm_canopy_tree_edge_scale') ?? '0.7'),
    treeMassifScale: parseFloat(localStorage.getItem('wm_canopy_tree_massif_scale') ?? '0.9'),

    treeOpaqueFill: localStorage.getItem('wm_canopy_tree_opaque_fill') !== 'false',
    treeFillWarmth: parseFloat(localStorage.getItem('wm_canopy_tree_fill_warmth') ?? '0.66'),
    treeFillBrightness: parseFloat(localStorage.getItem('wm_canopy_tree_fill_brightness') ?? '0.9'),
    treeFillSaturation: parseFloat(localStorage.getItem('wm_canopy_tree_fill_saturation') ?? '0.8'),

    customColors: localStorage.getItem('wm_canopy_custom_colors_on') !== 'false',
    decidColor1: localStorage.getItem('wm_canopy_decid_col1') || '#83703a',
    decidColor2: localStorage.getItem('wm_canopy_decid_col2') || '#5b6a2f',
    coniferColor: localStorage.getItem('wm_canopy_conifer_col') || '#4a5550',
    decidRatio: parseFloat(localStorage.getItem('wm_canopy_decid_ratio') ?? '0.64'),
    colorScatter: parseFloat(localStorage.getItem('wm_canopy_color_scatter') ?? '0.4'),

    treeSlopeSuppression: parseFloat(localStorage.getItem('wm_canopy_tree_slope_suppress') ?? '0.9'),
    treeSlopeTolerance: parseFloat(localStorage.getItem('wm_canopy_tree_slope_tol') ?? '0.05'),

    // --- Вшитые параметры ночи и теней кроны ---
    treeNightTint: localStorage.getItem('wm_canopy_night_tint') || '#939feb',
    treeNightStrength: parseFloat(localStorage.getItem('wm_canopy_night_strength') ?? '0.24'),

    treeShadeOpacity: parseFloat(localStorage.getItem('wm_canopy_shade_opacity') ?? '0.44'),
    treeShadeDarkness: parseFloat(localStorage.getItem('wm_canopy_shade_darkness') ?? '0.38'),

    treeGroundShadowColor: localStorage.getItem('wm_canopy_ground_shadow_col') || '#08081b',
    treeGroundShadowCustom: localStorage.getItem('wm_canopy_ground_shadow_custom') === 'true',

    treeContactShadowOpacity: parseFloat(localStorage.getItem('wm_canopy_contact_shadow_opacity') ?? '0.62'),
    treeMassifBaseDarkness: parseFloat(localStorage.getItem('wm_canopy_massif_base_dark') ?? '0.48'),

    treesEnabled: localStorage.getItem('wm_canopy_trees_on') !== 'false',
    treeStyle: localStorage.getItem('wm_canopy_tree_style') || 'real',
    treeDensity: parseFloat(localStorage.getItem('wm_canopy_tree_density') ?? '1.25'),
    treeScale: parseFloat(localStorage.getItem('wm_canopy_tree_scale') ?? '1.7'),
    treeColor: localStorage.getItem('wm_canopy_tree_color') || '#0d0a07',
    treeOpacity: parseFloat(localStorage.getItem('wm_canopy_tree_opacity') ?? '0.95'),
    treeShadows: localStorage.getItem('wm_canopy_tree_shadows') !== 'false',
    treeBlendMode: localStorage.getItem('wm_canopy_tree_blend') || 'darken',
    treeAutoDense: localStorage.getItem('wm_canopy_tree_autodense') !== 'false',
    treeAutoDenseScale: parseFloat(localStorage.getItem('wm_canopy_tree_autodense_scale') ?? '2.5'),
    treeAutoDenseThinning: parseFloat(localStorage.getItem('wm_canopy_tree_autodense_thin') ?? '0.3'),

    treeClustering: localStorage.getItem('wm_canopy_tree_clustering') !== 'false',
    treeMinH: parseFloat(localStorage.getItem('wm_canopy_tree_min_h') ?? '2.0'),
    forestOnlyThreshold: parseFloat(localStorage.getItem('wm_canopy_forest_only') ?? '0.85'),

    // --- вариативность, рельефный свет, тени ---
    treeVariety: parseFloat(localStorage.getItem('wm_canopy_tree_variety') ?? '0.6'),
    treeTerrainLight: localStorage.getItem('wm_canopy_tree_terrain_light') !== 'false',
    treeTerrainShadows: localStorage.getItem('wm_canopy_tree_terrain_shadows') !== 'false',
    treeShadowStrength: parseFloat(localStorage.getItem('wm_canopy_tree_shadow_strength') ?? '1.34')
  };

  let mapInstance = null;
  let canopyHeightLayer = null;
  let canopyMaskLayer = null;
  let canopyTreesLayer = null;

  // =========================================================================
  // ПРОЦЕДУРНЫЙ ДВИЖОК ДЕРЕВЬЕВ (TreeEngine)
  // =========================================================================
  function getTargetTreeZoom() {
    if (canopyTreesLayer && canopyTreesLayer._tileZoom !== undefined) {
      return canopyTreesLayer._tileZoom;
    }
    return mapInstance ? Math.min(16, Math.round(mapInstance.getZoom())) : 16;
  }

  // =========================================================================
  // ПРОЦЕДУРНЫЙ ДВИЖОК ДЕРЕВЬЕВ (TreeEngine)
  // =========================================================================
  const TreeEngine = (() => {
    const TILE = 256;
    const Q = 5;
    const MAX_HEIGHT_Z = 16;
    const MAX_SPECIES_Z = 12; // Предел для 30-метрового растра пород в GEE

    const ZERO = new Uint8Array(TILE * TILE);
    const TWO_PI = Math.PI * 2;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const mix = (a, b, t) => a + (b - a) * clamp(t, 0.0, 1.0);

    const smoothstep = (e0, e1, x) => {
      const t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
      return t * t * (3.0 - 2.0 * t);
    };


    // --- векторная математика для цветов (0..1) ---
    const mix3 = (a, b, t) => {
      if (!a || !b) return a || b || [0, 0, 0];
      return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
    };
    const mul3 = (a, k) => (!a ? [0, 0, 0] : [a[0] * k, a[1] * k, a[2] * k]);
    const clamp3 = (a) => (!a ? [0, 0, 0] : [clamp(a[0], 0, 1), clamp(a[1], 0, 1), clamp(a[2], 0, 1)]);
    const sat3 = (c, k) => {
      if (!c) return [0, 0, 0];
      const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k];
    };
    const css3 = (c, a) => {
      if (!c || c.length < 3) c = [0.1, 0.1, 0.1]; // фоллбэк при undefined
      const r = Math.round(clamp(c[0], 0, 1) * 255);
      const g = Math.round(clamp(c[1], 0, 1) * 255);
      const b = Math.round(clamp(c[2], 0, 1) * 255);
      return a === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
    };

    function clearSpriteCache() {
      for (const sp of spriteCache.values()) {
        if (sp && sp.cv) {
          sp.cv.width = 0;
          sp.cv.height = 0;
        }
      }
      spriteCache.clear();
      spriteBytes = 0;
    }

    function getZoomAdaptiveParams(z) {
      const cl = CANOPY_DEV_CONFIG.clustering;
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      const geo = CANOPY_DEV_CONFIG.geometry;

      let tuftRadiusRatio = cl.tuftRadiusRatio;
      let thinZoomWeight = 0.75;
      let innerStrokeRate = cl.innerStrokeRate;
      let crownBaseMeters = geo.crownBaseMeters;

      const tuftMul = (cl.tuftRadiusRatio || 0.56) / 0.56;
      const rateMul = (cl.innerStrokeRate ?? 0.35) / 0.35;

      if (z <= 12) {
        tuftRadiusRatio = 0.56 * tuftMul;
        thinZoomWeight = 0.75;
      } else if (z === 13) {
        tuftRadiusRatio = 0.49 * tuftMul;
        thinZoomWeight = 0.65;
      } else if (z === 14 || z === 15) {
        tuftRadiusRatio = 0.42 * tuftMul;
        thinZoomWeight = 0.50;
        innerStrokeRate = clamp(0.50 * rateMul, 0, 1);
        crownBaseMeters = 7.0;
      } else if (z >= 16) {
        tuftRadiusRatio = 0.42 * tuftMul;
        thinZoomWeight = 0.40;
        innerStrokeRate = clamp(0.50 * rateMul, 0, 1);
        crownBaseMeters = 5.5;
      }
      // Доля скрытых елей массива по зуму: 11 -> 0.62, 12 -> 0.52, 13 -> 0.42, 16 -> 0.64
      const hideMul = (cm.hideRate ?? 0.64) / 0.64;
      let baseHideRate;
      if (z <= 11) {
        baseHideRate = 0.62;
      } else if (z < 13) {
        baseHideRate = mix(0.62, 0.42, (z - 11) / 2);
      } else if (z < 16) {
        baseHideRate = mix(0.42, 0.64, (z - 13) / 3);
      } else {
        baseHideRate = 0.64;
      }
      const coniferHideRate = clamp(baseHideRate * hideMul, 0.0, 0.92);

      return { tuftRadiusRatio, thinZoomWeight, innerStrokeRate, crownBaseMeters, coniferHideRate };
    }

    function opts() {
      const s = canopySettings;
      const o = {
        style: s.treeStyle || 'mixed',
        density: clamp(s.treeDensity !== undefined ? s.treeDensity : 1.0, 0.2, 2.5),
        scale: clamp(s.treeScale !== undefined ? s.treeScale : 1.0, 0.4, 3.5),
        ink: s.treeStrokeColor || s.treeColor || '#1c1917',
        strokeColor: s.treeStrokeColor || s.treeColor || '#1c1917',
        shadows: s.treeShadows !== false,
        blendMode: s.treeBlendMode || 'multiply',
        autoDense: s.treeAutoDense !== false,
        autoDenseScale: clamp(s.treeAutoDenseScale !== undefined ? s.treeAutoDenseScale : 1.55, 1.0, 3.0),
        autoDenseThinning: clamp(s.treeAutoDenseThinning !== undefined ? s.treeAutoDenseThinning : 0.50, 0.0, 0.85),
        clustering: s.treeClustering !== false,
        minH: clamp(s.treeMinH || 4.0, 1.0, 20.0),
        forestOnlyThreshold: clamp(s.forestOnlyThreshold !== undefined ? s.forestOnlyThreshold : 0.35, 0.05, 0.9),
        fantasyForest: s.canopyFantasyForest === true,
        paper: s.treePaper || '#f7f4ea',

        clearRoads: s.treeClearRoads !== false,
        clearRoadsDist: clamp(s.treeClearRoadsDist !== undefined ? s.treeClearRoadsDist : 1.0, 0.4, 2.5),
        clearRoadsOpacity: clamp(s.treeClearRoadsOpacity !== undefined ? s.treeClearRoadsOpacity : 1.0, 0.0, 1.0),
        clearRoadsSoftness: clamp(s.treeClearRoadsSoftness !== undefined ? s.treeClearRoadsSoftness : 0.35, 0.0, 1.0),

        clearRivers: s.treeClearRivers !== false,
        clearRiversDist: clamp(s.treeClearRiversDist !== undefined ? s.treeClearRiversDist : 1.0, 0.4, 2.5),
        clearRiversOpacity: clamp(s.treeClearRiversOpacity !== undefined ? s.treeClearRiversOpacity : 1.0, 0.0, 1.0),
        clearRiversSoftness: clamp(s.treeClearRiversSoftness !== undefined ? s.treeClearRiversSoftness : 0.35, 0.0, 1.0),

        volumetric: clamp(s.treeVolumetric !== undefined ? s.treeVolumetric : 1.0, 0.0, 1.0),
        paperBleed: clamp(s.treePaperBleed !== undefined ? s.treePaperBleed : 0.35, 0.0, 1.0),
        edgeScale: clamp(s.treeEdgeScale !== undefined ? s.treeEdgeScale : 1.0, 0.4, 2.5),
        massifScale: clamp(s.treeMassifScale !== undefined ? s.treeMassifScale : (s.treeAutoDenseScale || 1.55), 0.5, 3.0),

        opaqueFill: s.treeOpaqueFill === true,
        fillWarmth: clamp(s.treeFillWarmth !== undefined ? s.treeFillWarmth : 0.5, 0.0, 1.0),
        fillBright: clamp(s.treeFillBrightness !== undefined ? s.treeFillBrightness : 0.85, 0.2, 1.5),
        fillSat: clamp(s.treeFillSaturation !== undefined ? s.treeFillSaturation : 0.60, 0.0, 1.5),

        treeNightTint: s.treeNightTint || '#939feb',
        treeNightStrength: clamp(s.treeNightStrength !== undefined ? s.treeNightStrength : 0.15, 0.0, 1.5),
        treeNightBrightness: clamp(s.treeNightBrightness !== undefined ? s.treeNightBrightness : 1.0, 0.2, 2.5),
        treeNightContrast: clamp(s.treeNightContrast !== undefined ? s.treeNightContrast : 1.0, 0.3, 2.5),

        treeShadeOpacity: clamp(s.treeShadeOpacity !== undefined ? s.treeShadeOpacity : 0.14, 0.0, 1.0),
        treeShadeDarkness: clamp(s.treeShadeDarkness !== undefined ? s.treeShadeDarkness : 0.10, 0.1, 1.0),
        treeGroundShadowColor: s.treeGroundShadowColor || '#08081b',
        treeGroundShadowCustom: s.treeGroundShadowCustom === true,
        treeContactShadowOpacity: clamp(s.treeContactShadowOpacity !== undefined ? s.treeContactShadowOpacity : 0.46, 0.0, 1.0),
        treeMassifBaseDarkness: clamp(s.treeMassifBaseDarkness !== undefined ? s.treeMassifBaseDarkness : 0.51, 0.2, 1.0),

        customColors: s.customColors === true,
        decidColor1: s.decidColor1 || '#7fa361',
        decidColor2: s.decidColor2 || '#b89e58',
        coniferColor: s.coniferColor || '#264e36',
        decidRatio: clamp(s.decidRatio !== undefined ? s.decidRatio : 0.5, 0.0, 1.0),
        colorScatter: clamp(s.colorScatter !== undefined ? s.colorScatter : 0.25, 0.0, 1.0),

        slopeSuppression: clamp(s.treeSlopeSuppression !== undefined ? s.treeSlopeSuppression : 0.0, 0.0, 1.0),
        slopeTolerance: clamp(s.treeSlopeTolerance !== undefined ? s.treeSlopeTolerance : 0.25, 0.05, 1.0),

        variety: clamp(s.treeVariety !== undefined ? s.treeVariety : 0.6, 0.0, 1.5),
        terrainLight: s.treeTerrainLight !== false,
        terrShadows: s.treeTerrainShadows !== false,
        shadowStrength: clamp(s.treeShadowStrength !== undefined ? s.treeShadowStrength : 1.34, 0.0, 1.5)
      };

      let colKey;
      if (!o.opaqueFill) colKey = '0';
      else if (o.customColors) colKey = `c_${o.decidColor1}_${o.decidColor2}_${o.coniferColor}_${o.decidRatio.toFixed(2)}_${o.colorScatter.toFixed(2)}`;
      else colKey = `${o.fillWarmth.toFixed(2)}_${o.fillBright.toFixed(2)}_${o.fillSat.toFixed(2)}_${o.colorScatter.toFixed(2)}`;
      o.colKey = colKey;

      o.sprSig = `${o.ink}|${colKey}|${o.shadows ? 1 : 0}|${o.opaqueFill ? 1 : 0}|${o.paper}|${o.treeNightTint}|${o.treeNightStrength}|${o.treeNightBrightness}|${o.treeNightContrast}|vol:${o.volumetric.toFixed(2)}`;
      return o;
    }

    // =========================================================================
    // КЭШ И ДЕКОДЕР ПОРОД ЛЕСА (GLC_FCS30D)
    // 0 = нет данных, 1 = conifer (хвойные), 2 = decid (лиственные), 3 = mixed (смешанный)
    // =========================================================================
    const speciesDataCache = new Map();
    const inFlightSpeciesRequests = new Map();
    const inFlightSpeciesListeners = new Map(); // Очередь ожидающих колбэков для каждого тайла
    const failedSpeciesCooldown = new Map();
    const FAILED_TILE_COOLDOWN_MS = 30000;
    let _speciesSuccessCount = 0;

    function notifySpeciesStateChanged() {
      if (typeof window.renderCanopyHudUI === 'function') {
        window.renderCanopyHudUI();
      }
    }
    function decodeSpeciesPixel(r, g, b, a) {
      // 1. Прозрачность и фоновые нелесные значения
      if (a < 30) return 0;
      if (r < 15 && g < 15 && b < 15) return 0; // Черный фон / nodata
      if (b > 70) return 0; // Вода (210), болота (181, 182, 186, 187), снег (220)
      if (r > 195 && g > 195) return 0; // Пашни (10, 11, 12), голые скалы (200, 201, 202)
      if (g < 35) return 0; // Городская застройка (190)
      if (r > 130 && g < 110 && b < 45) return 0; // Кустарники (120, 121, 122)
      if (g < r * 0.78) return 0; // Травы и сухая растительность (130)

      // Исключаем класс 183 (Flooded flat: 158, 187, 59)
      if (b >= 52 && r >= 145 && g >= 180) return 0;

      // -------------------------------------------------------------------------
      // 2. СМЕШАННЫЕ ЛЕСА (Mixed = 3)
      // -------------------------------------------------------------------------
      // Класс 91: Open mixed leaf forest (#a0b432 -> 160, 180, 50)
      if (r >= 140 && r <= 175 && g >= 165 && g <= 195 && b >= 35 && b <= 58) {
        return 3;
      }
      // Класс 92: Closed mixed leaf forest (#788200 -> 120, 130, 0)
      if (r >= 105 && r <= 135 && g >= 115 && g <= 145 && Math.abs(r - g) <= 25 && b < 25) {
        return 3;
      }

      // -------------------------------------------------------------------------
      // 3. ХВОЙНЫЕ ПОРОДЫ (Conifer = 1)
      // -------------------------------------------------------------------------
      // Классы 81 и 82: Лиственница (#286400 -> 40, 100, 0 и #285000 -> 40, 80, 0)
      if (r >= 25 && r <= 55 && g >= 65 && g <= 115 && b < 25) {
        return 1;
      }
      // Классы 71 и 72: Темнохвойные (#005000 -> 0, 80, 0 и #003c00 -> 0, 60, 0)
      // Строго G < 92, чтобы не захватить класс 52 (#006400, где G=100)!
      if (r < 25 && g >= 45 && g < 92 && b < 25) {
        return 1;
      }

      // -------------------------------------------------------------------------
      // 4. ЛИСТВЕННЫЕ ПОРОДЫ (Deciduous = 2)
      // -------------------------------------------------------------------------
      // Класс 52: Closed evergreen broadleaved (#006400 -> 0, 100, 0)
      if (r < 25 && g >= 92 && g <= 125 && b < 25) {
        return 2;
      }
      // Класс 62: Closed deciduous broadleaved (#00a000 -> 0, 160, 0)
      if (r < 35 && g >= 135 && g <= 185 && b < 30) {
        return 2;
      }
      // Класс 51: Open evergreen broadleaved (#4c7300 -> 76, 115, 0)
      if (r >= 60 && r <= 95 && g >= 100 && g <= 135 && b < 25) {
        return 2;
      }
      // Класс 61: Open deciduous broadleaved (#a8c800 -> 168, 200, 0)
      if (r >= 150 && r <= 185 && g >= 185 && g <= 220 && b < 25) {
        return 2;
      }

      // -------------------------------------------------------------------------
      // 5. РЕЗЕРВНЫЙ ФОЛЛБЭК ДЛЯ ТАЙЛОВ С АНТИАЛИАСИНГОМ / ИНТЕРПОЛЯЦИЕЙ
      // -------------------------------------------------------------------------
      if (g > r && g > b) {
        if (r >= 100 && Math.abs(r - g) <= 30) return 3; // Смешанный
        if (r < 55 && g < 95) return 1;                  // Хвойный
        return 2;                                        // Лиственный
      }

      return 0;
    }

    function decodeToSpeciesGrid(imgData) {
      const out = new Uint8Array(TILE * TILE);
      const d = imgData.data;
      for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = decodeSpeciesPixel(d[p], d[p + 1], d[p + 2], d[p + 3]);
      }
      return out;
    }

    async function fetchNativeSpeciesRaster(z, x, y) {
      const n = 1 << z;
      if (y < 0 || y >= n) return null;
      x = ((x % n) + n) % n;

      const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(TILE, TILE) : document.createElement('canvas');
      cv.width = cv.height = TILE;
      const ctx = cv.getContext('2d', { willReadFrequently: true });

      const cachedBlob = await readCachedCanopyBlob('species', z, x, y);
      if (cachedBlob) {
        try {
          const bmp = await decodeBlobToImageOrBitmap(cachedBlob);
          ctx.clearRect(0, 0, TILE, TILE);
          ctx.drawImage(bmp, 0, 0, TILE, TILE);
          if (bmp.close) bmp.close();
          return decodeToSpeciesGrid(ctx.getImageData(0, 0, TILE, TILE));
        } catch (e) {}
      }
      if (navigator.onLine === false) return null;

      const order = CanopyNet.getAliveOrder();
      if (!order.length) return null;

      let is404Count = 0;
      for (let oi = 0; oi < order.length; oi++) {
        const pIdx = order[oi];
        if (!CanopyNet.isAlive(pIdx)) continue;
        const tpl = CanopyTokens.getProviderUrl('species', pIdx);
        if (!tpl) continue;
        const url = L.Util.template(tpl, { z, x, y, s: 'a' });

        const ctl = new AbortController();
        let timedOut = false;
        const timeoutMs = (oi < order.length - 1) ? 3500 : 5500;
        const tm = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);

        try {
          const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });

          if (resp.status === 404) {
            is404Count++;
            continue;
          }
          if (!resp.ok) {
            CanopyNet.markFailure(pIdx, new Error(`HTTP ${resp.status}`));
            continue;
          }

          const blob = await resp.blob();
          clearTimeout(tm);
          const bmp = await decodeBlobToImageOrBitmap(blob);

          ctx.clearRect(0, 0, TILE, TILE);
          ctx.drawImage(bmp, 0, 0, TILE, TILE);
          if (bmp.close) bmp.close();

          CanopyNet.markSuccess(pIdx);
          return decodeToSpeciesGrid(ctx.getImageData(0, 0, TILE, TILE));
        } catch (e) {
          CanopyNet.markFailure(pIdx, {
            name: e.name,
            message: timedOut ? 'Timeout' : e.message,
            isTimeout: timedOut
          });
        } finally {
          clearTimeout(tm);
        }
      }

      return (is404Count === order.length) ? ZERO : null;
    }


    function tryDownsampleChildrenInRam(z, normTx, ty) {
      if (z < 11 || z >= MAX_HEIGHT_Z) return null;
      const cz = z + 1;
      const cn = 1 << cz;
      const cx0 = (normTx * 2) % cn;
      const cy0 = ty * 2;

      const c00 = dataCache.get(`${cz}/${cx0}/${cy0}`);
      const c10 = dataCache.get(`${cz}/${(cx0 + 1) % cn}/${cy0}`);
      const c01 = dataCache.get(`${cz}/${cx0}/${cy0 + 1}`);
      const c11 = dataCache.get(`${cz}/${(cx0 + 1) % cn}/${cy0 + 1}`);
      if (!c00 || !c10 || !c01 || !c11) return null;

      if (c00 === ZERO && c10 === ZERO && c01 === ZERO && c11 === ZERO) return ZERO;

      const out = new Uint8Array(TILE * TILE);
      const HALF = TILE >> 1; // 128
      const quads = [
        [c00, 0, 0],
        [c10, HALF, 0],
        [c01, 0, HALF],
        [c11, HALF, HALF]
      ];
      for (let q = 0; q < 4; q++) {
        const src = quads[q][0], ox = quads[q][1], oy = quads[q][2];
        if (src === ZERO) continue;
        for (let y = 0; y < HALF; y++) {
          const sy = y << 1;
          const sRow0 = sy * TILE;
          const sRow1 = (sy + 1) * TILE;
          const dRow = (oy + y) * TILE + ox;
          for (let x = 0; x < HALF; x++) {
            const sx = x << 1;
            const m0 = src[sRow0 + sx];
            const m1 = src[sRow0 + sx + 1];
            const m2 = src[sRow1 + sx];
            const m3 = src[sRow1 + sx + 1];
            out[dRow + x] = (m0 + m1 + m2 + m3 + 2) >> 2;
          }
        }
      }
      setDataCacheEntry(`${z}/${normTx}/${ty}`, z, out);
      return out;
    }

    let _fastZ = -1, _fastTx = -1, _fastTy = -1, _fastGrid = null;
    const _candZoomsBase = [13, 14, 12, 15, 11, 16];

    const _candZoomsDesc = [16, 15, 14, 13, 12, 11];
    function getHeightAtNorm(xn, yn) {
      if (dataCache.size === 0 || yn <= 0 || yn >= 1) return 0;
      const xWrap = xn - Math.floor(xn);

      if (_fastZ > 0) {
        const n = 1 << _fastZ;
        const fx = xWrap * n, fy = yn * n;
        const tx = fx | 0, ty = fy | 0;
        if (tx === _fastTx && ty === _fastTy) {
          if (!_fastGrid || _fastGrid === ZERO) return 0;
          const lx = ((fx - tx) * TILE) | 0;
          const ly = ((fy - ty) * TILE) | 0;
          const v = _fastGrid[(ly << 8) + lx];
          return v ? (v / Q) : 0;
        }
      }

      for (let i = 0; i < _candZoomsDesc.length; i++) {
        const z = _candZoomsDesc[i];
        if ((_loadedZoomMask & (1 << z)) === 0) continue;
        const n = 1 << z;
        const fx = xWrap * n, fy = yn * n;
        const tx = fx | 0, ty = fy | 0;
        if (ty < 0 || ty >= n) continue;

        const grid = dataCache.get(`${z}/${tx}/${ty}`);
        if (grid !== undefined) {
          _fastZ = z; _fastTx = tx; _fastTy = ty; _fastGrid = grid;
          if (grid === ZERO) return 0;
          const lx = ((fx - tx) * TILE) | 0;
          const ly = ((fy - ty) * TILE) | 0;
          const v = grid[(ly << 8) + lx];
          return v ? (v / Q) : 0;
        }
      }
      return 0;
    }

    async function ingestHeightBlob(z, x, y, blob) {
      if (z < 11 || z > MAX_HEIGHT_Z || !blob) return;
      const n = 1 << z;
      if (y < 0 || y >= n) return;
      const normTx = ((x % n) + n) % n;
      const key = `${z}/${normTx}/${y}`;
      if (dataCache.has(key)) return;
      const reqGen = cacheGen;
      try {
        const grid = await decodeHeightBlobToGrid(blob);
        if (reqGen === cacheGen && grid) {
          setDataCacheEntry(key, z, grid);
          _fastZ = -1;
        }
      } catch (e) {}
    }

    function requestSpecies(z, x, y, onReady) {
      const n = 1 << z;
      if (y < 0 || y >= n) return ZERO;
      x = ((x % n) + n) % n;

      const key = `${z}/${x}/${y}`;
      if (speciesDataCache.has(key)) {
        const g = speciesDataCache.get(key);
        speciesDataCache.delete(key);
        speciesDataCache.set(key, g);
        return g;
      }

      if (z > MAX_SPECIES_Z) {
        const shift = z - MAX_SPECIES_Z;
        const pX = x >> shift;
        const pY = y >> shift;
        const parentKey = `${MAX_SPECIES_Z}/${pX}/${pY}`;

        if (speciesDataCache.has(parentKey)) {
          const pGrid = speciesDataCache.get(parentKey);
          const resampled = (pGrid === ZERO) ? ZERO : resampleGrid(pGrid, MAX_SPECIES_Z, z, x, y);
          speciesDataCache.set(key, resampled);
          return resampled;
        }

        requestSpecies(MAX_SPECIES_Z, pX, pY, () => {
          if (speciesDataCache.has(parentKey)) {
            const pGrid = speciesDataCache.get(parentKey);
            const resampled = (pGrid === ZERO) ? ZERO : resampleGrid(pGrid, MAX_SPECIES_Z, z, x, y);
            speciesDataCache.set(key, resampled);
            if (onReady) onReady();
          }
        });
        return null;
      }

      const failedAt = failedSpeciesCooldown.get(key);
      if (failedAt && (Date.now() - failedAt < FAILED_TILE_COOLDOWN_MS)) {
        return null;
      }

      if (inFlightSpeciesRequests.has(key)) {
        if (onReady) {
          let list = inFlightSpeciesListeners.get(key);
          if (!list) { list = []; inFlightSpeciesListeners.set(key, list); }
          list.push(onReady);
        }
        return null;
      }

      const listeners = onReady ? [onReady] : [];
      inFlightSpeciesListeners.set(key, listeners);
      const reqGen = cacheGen;

      const p = fetchNativeSpeciesRaster(z, x, y).then(grid => {
        if (inFlightSpeciesRequests.get(key) === p) inFlightSpeciesRequests.delete(key);
        const cbs = inFlightSpeciesListeners.get(key) || [];
        inFlightSpeciesListeners.delete(key);

        if (reqGen === cacheGen) {
          if (grid !== null) {
            failedSpeciesCooldown.delete(key);
            speciesDataCache.set(key, grid);
            if (speciesDataCache.size > CACHE_LIMIT) {
              speciesDataCache.delete(speciesDataCache.keys().next().value);
            }
            if (grid !== ZERO) {
              _speciesSuccessCount++;
              notifySpeciesStateChanged();
            }
            for (let i = 0; i < cbs.length; i++) {
              try { cbs[i](); } catch (e) {}
            }
          } else {
            // Записываем паузу, и НЕ вызываем cbs() чтобы не крутить бесконечный RAF-цикл
            failedSpeciesCooldown.set(key, Date.now());
            if (failedSpeciesCooldown.size > 400) {
              failedSpeciesCooldown.delete(failedSpeciesCooldown.keys().next().value);
            }
          }
        }
        return grid;
      }).catch(() => {
        if (inFlightSpeciesRequests.get(key) === p) inFlightSpeciesRequests.delete(key);
        inFlightSpeciesListeners.delete(key);
        if (reqGen === cacheGen) {
          failedSpeciesCooldown.set(key, Date.now());
          if (failedSpeciesCooldown.size > 400) {
            failedSpeciesCooldown.delete(failedSpeciesCooldown.keys().next().value);
          }
        }
      });

      inFlightSpeciesRequests.set(key, p);
      return null;
    }

    function getBaseCrownSize(z) {
      // z=11 -> 15.4px, z=12 -> 17.0px, z=13 -> 18.6px, z=14 -> 20.2px, z=15+ -> 21.8px
      return clamp(17.0 + (z - 12) * 1.6, 14.0, 23.0);
    }

    function getDeviceVisualScale() {
      const dpr = window.devicePixelRatio || 1;
      const hasTouch = (navigator.maxTouchPoints || 0) > 1;
      const isCoarse = typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : true;
      if (!hasTouch || !isCoarse || dpr < 1.5) return 1.0;

      const minSide = Math.min(window.screen.width || 1024, window.screen.height || 768);
      // Телефоны (~326–460 PPI): крупнее крона и шаг сетки
      if (minSide <= 500) return 1.28;
      // Планшеты / iPad (~264–326 PPI): выравниваем с десктопным монитором (~96–110 PPI)
      if (minSide <= 1100) return 1.22;
      return 1.0;
    }

    function getGridMetric(z, density, ty, scale = 1.0) {
      const tileLat = (ty !== undefined)
        ? Math.atan(Math.sinh(Math.PI - (2.0 * Math.PI * (ty + 0.5)) / (1 << z))) * (180.0 / Math.PI)
        : (WM.map ? WM.map.getCenter().lat : 55.0);
      const mpp = (156543.03392 * Math.cos(tileLat * Math.PI / 180)) / (1 << z);

      const devScale = getDeviceVisualScale();
      const baseCrownSz = getBaseCrownSize(z) * scale * devScale;
      
      // Коэффициент перекрытия 1.20
      const targetPackingRatio = 1.20;
      
      // Шаг ячейки сетки высчитывается от размера кроны и плотности
      const targetCellPx = (baseCrownSz / targetPackingRatio) / Math.sqrt(Math.max(0.2, density));

      // На крупных планшетах/телефонах с devScale > 1.2 на высоких зумах разрешаем N от 9
      const N = clamp(Math.round(TILE / targetCellPx), 9, 21);
      return { N, cell: TILE / N, mpp, baseCrownSz, devScale };
    }

    function hash2(a, b, s) {
      let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function smoothNoise(u, v, s) {
      const iu = Math.floor(u), iv = Math.floor(v);
      const fu = u - iu, fv = v - iv;
      const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
      const a = hash2(iu, iv, s), b = hash2(iu + 1, iv, s);
      const c = hash2(iu, iv + 1, s), d = hash2(iu + 1, iv + 1, s);
      return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
    }

    function decodePixelQ(r, g, b, a) {
      if (a < 35) return 0;
      if (r < 75 && g < 45 && b < 95) return 0;
      if (r < 20 && g < 20 && b < 20) return 0;
      if (g > 80 && (g > r * 1.15 || (r === g && g === b))) return 14 * Q;
      if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
        return clamp(Math.round((r / 255) * 30 * Q), 0, 250);
      }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      return Math.round(clamp((luma / 255) * 32, 0, 45) * Q);
    }

    function decodeToHeightGrid(imgData) {
      const out = new Uint8Array(TILE * TILE);
      const d = imgData.data;
      for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = decodePixelQ(d[p], d[p + 1], d[p + 2], d[p + 3]);
      }
      return out;
    }

    const dataCache = new Map();
    const inFlightRequests = new Map();
    const inFlightListeners = new Map(); // Очередь ожидающих колбэков для высот
    const failedHeightCooldown = new Map();
    const tileTreesCache = new Map();
    const CACHE_LIMIT = 128;
    let cacheGen = 0;
    let _loadedZoomMask = 0;

    function setDataCacheEntry(key, z, grid) {
      dataCache.set(key, grid);
      _loadedZoomMask |= (1 << z);
      if (dataCache.size > CACHE_LIMIT) {
        dataCache.delete(dataCache.keys().next().value);
      }
    }

    let _decodeCv = null, _decodeCtx = null;
    async function decodeHeightBlobToGrid(blob) {
      const bmp = await decodeBlobToImageOrBitmap(blob);
      if (!_decodeCv) {
        _decodeCv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(TILE, TILE) : document.createElement('canvas');
        _decodeCv.width = _decodeCv.height = TILE;
        _decodeCtx = _decodeCv.getContext('2d', { willReadFrequently: true });
      }
      _decodeCtx.clearRect(0, 0, TILE, TILE);
      _decodeCtx.drawImage(bmp, 0, 0, TILE, TILE);
      if (bmp.close) bmp.close();
      return decodeToHeightGrid(_decodeCtx.getImageData(0, 0, TILE, TILE));
    }

    async function fetchNativeRaster(z, x, y, signal) {
      const n = 1 << z;
      if (y < 0 || y >= n) return null;
      x = ((x % n) + n) % n;

      if (canopySettings.canopyVersion !== 'v2') {
        const cachedBlob = await readCachedCanopyBlob('height', z, x, y);
        if (cachedBlob) {
          WM.layerDiag?.log('canopy', 'cache-idb', { z, x, y, bytes: cachedBlob.size, outcome: 'ok' });
          try { return await decodeHeightBlobToGrid(cachedBlob); } catch (e) {}
        }
        if (navigator.onLine === false) {
          return await getCachedParentHeightGrid(z, x, y);
        }
      }
      await acquireCanopySlot(signal);

      try {
        if (canopySettings.canopyVersion === 'v2' && WM.canopyV2) {
          const gridV2 = await WM.canopyV2.fetchHeightGridQ(z, x, y, Q, signal).catch(() => null);
          if (signal && signal.aborted) return null;
          if (gridV2 === 'ZERO') return ZERO;
          if (gridV2) return gridV2;
          return await getCachedParentHeightGrid(z, x, y);
        }

        const order = CanopyNet.getAliveOrder();
        if (!order.length) {
          return await getCachedParentHeightGrid(z, x, y);
        }
        let is404Count = 0;

        for (let oi = 0; oi < order.length; oi++) {
          if (signal && signal.aborted) return null;
          const pIdx = order[oi];
          if (!CanopyNet.isAlive(pIdx)) continue;
          const tpl = CanopyTokens.getProviderUrl('height', pIdx);
          if (!tpl) continue;
          const url = L.Util.template(tpl, { z, x, y, s: 'a' });

          const ctl = new AbortController();
          let timedOut = false;
          const onExtAbort = () => ctl.abort();
          if (signal) signal.addEventListener('abort', onExtAbort, { once: true });

          // Быстрый таймаут при наличии запасных зеркал (3.2 с), чуть больше на последнем (5.5 с)
          const timeoutMs = (oi < order.length - 1) ? 3200 : 5500;
          const tm = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
          const t0 = performance.now();
          const mName = CanopyNet.states[pIdx]?.name || ('Mirror #' + pIdx);

          try {
            const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });

            if (resp.status === 404) {
              WM.layerDiag?.log('canopy', 'net', { z, x, y, url, mirror: mName, status: 404, ms: Math.round(performance.now() - t0), outcome: 'empty-404' });
              is404Count++;
              continue;
            }
            if (!resp.ok) {
              WM.layerDiag?.log('canopy', 'net', { z, x, y, url, mirror: mName, status: resp.status, ms: Math.round(performance.now() - t0), outcome: 'error' });
              CanopyNet.markFailure(pIdx, new Error(`HTTP ${resp.status}`));
              continue;
            }

            const blob = await resp.blob();
            clearTimeout(tm); // Защищаем и чтение тела blob!
            const grid = await decodeHeightBlobToGrid(blob);
            WM.layerDiag?.log('canopy', 'net', { z, x, y, url, mirror: mName, status: 200, bytes: blob.size, ms: Math.round(performance.now() - t0), outcome: 'ok' });
            CanopyNet.markSuccess(pIdx);
            return grid;
          } catch (e) {
            WM.layerDiag?.log('canopy', 'net', { z, x, y, url, mirror: mName, ms: Math.round(performance.now() - t0), error: timedOut ? 'Timeout' : (e?.message || 'NetErr'), outcome: 'error' });
            if (!(signal && signal.aborted && !timedOut)) {
              CanopyNet.markFailure(pIdx, {
                name: e.name,
                message: timedOut ? 'Timeout' : e.message,
                isTimeout: timedOut
              });
            }
          } finally {
            clearTimeout(tm);
            if (signal) signal.removeEventListener('abort', onExtAbort);
          }
        }

        if (is404Count === order.length) {
          WM.layerDiag?.log('canopy', 'fallback', { z, x, y, outcome: 'empty-404', note: 'Нет леса (404 на всех зеркалах)' });
          return ZERO;
        }
        return await getCachedParentHeightGrid(z, x, y);
      } finally {
        releaseCanopySlot();
      }
    }
    async function getCachedParentHeightGrid(z, x, y) {
      for (let pz = z - 1; pz >= 11; pz--) {
        const shift = z - pz;
        const px = x >> shift;
        const py = y >> shift;
        const pKey = `${pz}/${px}/${py}`;

        let pGrid = dataCache.get(pKey);
        if (!pGrid) {
          if (canopySettings.canopyVersion === 'v2' && WM.offlineArea && typeof WM.offlineArea.readCanopyV2Grid === 'function') {
            const gV2 = await WM.offlineArea.readCanopyV2Grid(pz, px, py, Q);
            if (gV2 === 'ZERO') pGrid = ZERO;
            else if (gV2) pGrid = gV2;
          } else {
            const pBlob = await readCachedCanopyBlob('height', pz, px, py);
            if (pBlob) {
              try { pGrid = await decodeHeightBlobToGrid(pBlob); } catch (e) {}
            }
          }
          if (pGrid) {
            setDataCacheEntry(pKey, pz, pGrid);
          }
        }

        if (pGrid) {
          if (pGrid === ZERO) {
            const empty = new Uint8Array(TILE * TILE);
            empty._degraded = true;
            return empty;
          }
          const resampled = resampleGrid(pGrid, pz, z, x, y);
          resampled._degraded = true;
          return resampled;
        }
      }
      return null;
    }


    function resampleGrid(parentGrid, parentZ, z, x, y) {
      const shift = z - parentZ;
      if (shift <= 0) return parentGrid;
      const factor = 1 << shift;
      const subX = ((x % factor) + factor) % factor;
      const subY = ((y % factor) + factor) % factor;
      const subW = TILE / factor;
      const startX = subX * subW;
      const startY = subY * subW;

      const out = new Uint8Array(TILE * TILE);
      for (let py = 0; py < TILE; py++) {
        const srcY = Math.min(TILE - 1, Math.floor(startY + (py / TILE) * subW));
        const rowOff = py * TILE;
        const srcRowOff = srcY * TILE;
        for (let px = 0; px < TILE; px++) {
          const srcX = Math.min(TILE - 1, Math.floor(startX + (px / TILE) * subW));
          out[rowOff + px] = parentGrid[srcRowOff + srcX];
        }
      }
      return out;
    }

    function requestHeights(z, x, y, onReady) {
      const n = 1 << z;
      if (y < 0 || y >= n) return ZERO;
      x = ((x % n) + n) % n;

      const key = `${z}/${x}/${y}`;
      if (dataCache.has(key)) {
        const g = dataCache.get(key);
        dataCache.delete(key);
        dataCache.set(key, g);
        return g;
      }

      if (z > MAX_HEIGHT_Z) {
        const shift = z - MAX_HEIGHT_Z;
        const pX = x >> shift;
        const pY = y >> shift;
        const parentKey = `${MAX_HEIGHT_Z}/${pX}/${pY}`;

        if (dataCache.has(parentKey)) {
          const resampled = resampleGrid(dataCache.get(parentKey), MAX_HEIGHT_Z, z, x, y);
          setDataCacheEntry(key, z, resampled);
          return resampled;
        }

        requestHeights(MAX_HEIGHT_Z, pX, pY, () => {
          if (dataCache.has(parentKey)) {
            setDataCacheEntry(key, z, resampleGrid(dataCache.get(parentKey), MAX_HEIGHT_Z, z, x, y));
            if (onReady) onReady();
          }
        });
        return null;
      }

      const failedAt = failedHeightCooldown.get(key);
      if (failedAt && (Date.now() - failedAt < FAILED_TILE_COOLDOWN_MS)) {
        return null;
      }

      if (inFlightRequests.has(key)) {
        if (onReady) {
          let list = inFlightListeners.get(key);
          if (!list) { list = []; inFlightListeners.set(key, list); }
          list.push(onReady);
        }
        return null;
      }

      const listeners = onReady ? [onReady] : [];
      inFlightListeners.set(key, listeners);
      const reqGen = cacheGen;

      const p = fetchNativeRaster(z, x, y).then(grid => {
        if (inFlightRequests.get(key) === p) inFlightRequests.delete(key);
        const cbs = inFlightListeners.get(key) || [];
        inFlightListeners.delete(key);

        if (reqGen === cacheGen) {
          if (grid !== null) {
            failedHeightCooldown.delete(key);
            setDataCacheEntry(key, z, grid);

            for (let i = 0; i < cbs.length; i++) {
              try { cbs[i](); } catch (e) {}
            }
          } else {
            failedHeightCooldown.set(key, Date.now());
            if (failedHeightCooldown.size > 400) {
              failedHeightCooldown.delete(failedHeightCooldown.keys().next().value);
            }
          }
        }
        return grid;
      }).catch(() => {
        if (inFlightRequests.get(key) === p) inFlightRequests.delete(key);
        inFlightListeners.delete(key);
        if (reqGen === cacheGen) {
          failedHeightCooldown.set(key, Date.now());
          if (failedHeightCooldown.size > 400) {
            failedHeightCooldown.delete(failedHeightCooldown.keys().next().value);
          }
        }
      });

      inFlightRequests.set(key, p);
      return null;
    }


    function sizeBucket(w) {
      const STEP = 0.09;
      const q = Math.exp(Math.round(Math.log(Math.max(w, 1)) / STEP) * STEP);
      return Math.max(5, Math.round(q * 2) / 2);
    }

    const DECO_EDGE = [
      ['grass', 0.022], ['mound', 0.014], ['birch', 0.014], ['bush', 0.016],
      ['dead', 0.010], ['stump', 0.007], ['rocks', 0.007], ['log', 0.004]
    ];
    const DECO_DEEP = [['dead', 0.007], ['birch', 0.010]];

    function pickDeco(cx, cy, isDeep, crownPx, o) {
      if (o.variety <= 0.01 || crownPx < 9.0) return null;
      const r = hash2(cx, cy, 77);
      const d = CANOPY_DEV_CONFIG.deco;

      const table = isDeep
        ? [['dead', d.deadRate * 0.7], ['birch', d.birchRate * 0.7]]
        : [
            ['grass', d.grassRate], ['mound', d.moundRate], ['birch', d.birchRate],
            ['bush', d.bushRate], ['dead', d.deadRate], ['stump', d.stumpRate],
            ['rocks', d.rocksRate], ['log', d.logRate]
          ];

      let acc = 0;
      for (let i = 0; i < table.length; i++) {
        acc += table[i][1] * o.variety;
        if (r < acc) return table[i][0];
      }
      return null;
    }

    const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

    function pointInFlatRings(x, y, rings) {
      let inside = false;
      for (let l = 0; l < rings.length; l++) {
        const ring = rings[l];
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const xi = ring[i], yi = ring[i + 1];
          const xj = ring[j], yj = ring[j + 1];
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) {
            inside = !inside;
          }
        }
      }
      return inside;
    }

    function planTileTrees(z, tx, ty, grid, o, speciesGrid = null, roadSegs = null, riverData = null) {
      if (!grid) return [];

      // Получаем параметры с учётом текущего зума
      const zoomParams = getZoomAdaptiveParams(z);

      const { N, cell, mpp, baseCrownSz, devScale } = getGridMetric(z, o.density, ty, o.scale);
      const minVal = o.minH * Q;

      const effectiveForestThreshold = (z <= 11) ? Math.min(o.forestOnlyThreshold, 0.25) : o.forestOnlyThreshold;

      const occ = new Float32Array(N * N);
      const avgHeights = new Float32Array(N * N);

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x0 = Math.floor(i * cell);
          const y0 = Math.floor(j * cell);
          const x1 = Math.min(TILE, Math.floor((i + 1) * cell));
          const y1 = Math.min(TILE, Math.floor((j + 1) * cell));

          let count = 0, valid = 0, sumH = 0;
          for (let py = y0; py < y1; py += 2) {
            for (let px = x0; px < x1; px += 2) {
              count++;
              const v = grid[py * TILE + px];
              if (v >= minVal) {
                valid++;
                sumH += v;
              }
            }
          }
          occ[j * N + i] = count > 0 ? (valid / count) : 0;
          avgHeights[j * N + i] = valid > 0 ? ((sumH / valid) / Q) : 0;
        }
      }

      const trees = [];

      for (let j = 0; j < N; j++) {
        const rowShift = (j % 2 === 1) ? (cell * 0.5) : 0.0;

        for (let i = 0; i < N; i++) {
          const cov = occ[j * N + i];
          if (cov < effectiveForestThreshold) continue;

          const cx = tx * N + i;
          const cy = ty * N + j;

          let neighborForestCount = 0;
          let emask = 0;
          for (let d = 0; d < 8; d++) {
            const ni = i + DIRS8[d][0];
            const nj = j + DIRS8[d][1];
            if (ni >= 0 && ni < N && nj >= 0 && nj < N) {
              if (occ[nj * N + ni] >= effectiveForestThreshold) neighborForestCount++;
              else emask |= (1 << d);
            } else {
              neighborForestCount++;
            }
          }

          const cl = CANOPY_DEV_CONFIG.clustering;
          const isDeepMassif = (neighborForestCount >= cl.massifNeighborThreshold && cov >= cl.massifCovThreshold);
          const isEdge = !isDeepMassif;

          // --- АДАПТИВНОЕ ПРОРЕЖИВАНИЕ МАССИВА ПО ЗУМУ ---
          if (o.autoDense && isDeepMassif) {
            const thinRate = clamp(o.autoDenseThinning * zoomParams.thinZoomWeight, 0.0, 0.85);
            if (thinRate > 0.005 && hash2(cx, cy, 7) < thinRate) continue;
          }

          const effectiveEdgeScale = o.edgeScale;
          const effectiveMassifScale = o.autoDense ? o.massifScale : o.edgeScale;
          const autoScaleMul = isDeepMassif ? effectiveMassifScale : effectiveEdgeScale;

          const realH = avgHeights[j * N + i] || 12.0;
          const geo = CANOPY_DEV_CONFIG.geometry;

          // --- АДАПТИВНАЯ БАЗОВАЯ КРОНА (crownBaseMeters) ПО ЗУМУ ---
          const baseMeters = zoomParams.crownBaseMeters;
          const sizeRatio = (baseMeters / 6.5) + (realH - 10.0) * (geo.crownHeightFactor * 0.06);
          let crownPx = baseCrownSz * Math.max(0.40, sizeRatio) * autoScaleMul;
          crownPx *= 0.94 + 0.12 * hash2(cx, cy, 11);

          crownPx = clamp(crownPx, 8.0 * o.scale * devScale, 50.0 * o.scale * devScale);

         const baseX = i * cell + rowShift;
          const baseY = j * cell;
          const jx = (hash2(cx, cy, 1) - 0.5) * cell * geo.treeJitter;
          const jy = (hash2(cx, cy, 2) - 0.5) * cell * geo.treeJitter;
          // Разрешаем деревьям естественный вылет на половину ячейки в зону PAD
          const posX = clamp(baseX + cell * 0.5 + jx, -cell * 0.5, TILE + cell * 0.5);
          const posY = clamp(baseY + cell * 0.5 + jy, -cell * 0.5, TILE + cell * 0.5);


          // Проверка расчистки дорожного коридора (просеки):
          if (o.clearRoads && roadSegs && roadSegs.length && WM.vectorRoads.distSqPointToSeg) {
            let onAsphalt = false;
            for (let s = 0; s < roadSegs.length; s++) {
              const seg = roadSegs[s];
              // Проверяем только тонкую осевую линию, чтобы ствол не стоял прямо посреди дороги
              const deadCenterR = seg.r * 0.35;
              if (posX < seg.minX - deadCenterR || posX > seg.maxX + deadCenterR ||
                  posY < seg.minY - deadCenterR || posY > seg.maxY + deadCenterR) continue;

              if (WM.vectorRoads.distSqPointToSeg(posX, posY, seg.x1, seg.y1, seg.x2, seg.y2) <= deadCenterR * deadCenterR) {
                onAsphalt = true;
                break;
              }
            }
            if (onAsphalt) continue; // не ставим ствол прямо на дорогу

          }
          if (o.clearRivers && riverData) {
            let inWater = false;

            if (riverData.polys && riverData.polys.length) {
              for (let p = 0; p < riverData.polys.length; p++) {
                const poly = riverData.polys[p];
                if (posX < poly.minX || posX > poly.maxX || posY < poly.minY || posY > poly.maxY) continue;
                if (pointInFlatRings(posX, posY, poly.rings)) {
                  inWater = true;
                  break;
                }
              }
            }

            if (!inWater && riverData.segs && riverData.segs.length && WM.vectorRoads?.distSqPointToSeg) {
              const rSegs = riverData.segs;
              for (let s = 0; s < rSegs.length; s++) {
                const seg = rSegs[s];
                const deadCenterR = seg.r * 0.45 * Math.min(1.0, o.clearRiversDist);
                if (posX < seg.minX - deadCenterR || posX > seg.maxX + deadCenterR ||
                    posY < seg.minY - deadCenterR || posY > seg.maxY + deadCenterR) continue;

                if (WM.vectorRoads.distSqPointToSeg(posX, posY, seg.x1, seg.y1, seg.x2, seg.y2) <= deadCenterR * deadCenterR) {
                  inWater = true;
                  break;
                }
              }
            }

            if (inWater) continue; // не ставим ствол в реку или водоём
          }

          const worldMX = ((tx * TILE + posX) * mpp) % 100000;
          const worldMY = ((ty * TILE + posY) * mpp) % 100000;

          // ОПРЕДЕЛЕНИЕ ПОРОДЫ ДЕРЕВА
          let kind = 'decid';
          if (o.style === 'conifer') {
            kind = 'conifer';
          } else if (o.style === 'deciduous') {
            kind = 'decid';
          } else if (o.style === 'real') {
            let specCode = 0;
            if (speciesGrid) {
              const spX = clamp(Math.floor(posX), 0, TILE - 1);
              const spY = clamp(Math.floor(posY), 0, TILE - 1);
              specCode = speciesGrid[spY * TILE + spX] || 0;
            }
            if (specCode === 1) {
              kind = 'conifer'; // Реальные хвойные
            } else if (specCode === 2) {
              kind = 'decid';   // Реальные лиственные
            } else if (specCode === 3) {
              // Смешанный лес: ёлки группами (рощицами) + одиночки, а не соль-перец
              const mixScale = Math.max(140, cell * mpp * 3.2);
              const mn = (0.5 + (smoothNoise(worldMX / mixScale, worldMY / mixScale, 61) - 0.5) * 1.6) * 0.72
                       + hash2(cx, cy, 5) * 0.28;
              kind = mn > 0.5 ? 'conifer' : 'decid';
            } else {
              // Резервный процедурный биом, пока нет данных в конкретной точке
              kind = o.clustering ? (smoothNoise(worldMX / 1600, worldMY / 1600, 42) > 0.48 ? 'conifer' : 'decid') : (hash2(cx, cy, 5) > 0.5 ? 'conifer' : 'decid');
            }
          } else if (o.clustering) {
            kind = smoothNoise(worldMX / 1600, worldMY / 1600, 42) > 0.48 ? 'conifer' : 'decid';
          } else {
            kind = hash2(cx, cy, 5) > 0.5 ? 'conifer' : 'decid';
          }

          const tn = smoothNoise(worldMX / 700, worldMY / 700, 77) * 0.78 + hash2(cx, cy, 78) * 0.22;
          const tone = tn < 0.38 ? 0 : (tn < 0.64 ? 1 : 2);

          trees.push({
            x: posX, y: posY, w: crownPx,
            b: sizeBucket(crownPx),
            kind,
            v: Math.floor(hash2(cx, cy, 9) * 4),
            tone,
            deco: pickDeco(cx, cy, isDeepMassif, crownPx, o),
            isDeepMassif, isEdge, emask,
            cx, cy,
            hz: z, htx: tx, hty: ty,
            _lk: null, _pv: -1, _ls: null
          });
        }
      }

      return trees;
    }

    function getTileTrees(z, tx, ty, o, onReady) {
      const n = 1 << z;
      if (ty < 0 || ty >= n) return [];
      tx = ((tx % n) + n) % n;

      let speciesGrid = null;
      let hasRealSpecies = false;
      let roadSegs = null;
      if (o.clearRoads && WM.vectorRoads && WM.vectorRoads.getTileRoadSegments) {
        roadSegs = WM.vectorRoads.getTileRoadSegments(z, tx, ty, onReady);
      }

      let riverData = null;
      if (o.clearRivers && WM.vectorRoads && WM.vectorRoads.getTileRiverData) {
        riverData = WM.vectorRoads.getTileRiverData(z, tx, ty, onReady);
      }

      if (o.style === 'real') {
        speciesGrid = requestSpecies(z, tx, ty, () => {
          // Удаляем все закэшированные варианты деревьев для этих координат тайла
          const prefix = `${z}/${tx}/${ty}|`;
          for (const k of tileTreesCache.keys()) {
            if (k.startsWith(prefix)) {
              tileTreesCache.delete(k);
            }
          }
          if (onReady) onReady();
        });
        hasRealSpecies = !!speciesGrid;
      }

      const cacheKey = `${z}/${tx}/${ty}|${o.style}|${o.density}|${o.scale}|${o.minH}|${o.forestOnlyThreshold}|ad:${o.autoDense}|ads:${o.autoDenseScale}|es:${o.edgeScale}|ms:${o.massifScale}|adt:${o.autoDenseThinning}|cl:${o.clustering}|vr:${o.variety}|species:${hasRealSpecies ? 1 : 0}|cr:${o.clearRoads && roadSegs ? 1 : 0}|crv:${o.clearRivers && riverData ? 1 : 0}`;

      if (tileTreesCache.has(cacheKey)) {
        const cached = tileTreesCache.get(cacheKey);
        tileTreesCache.delete(cacheKey);
        tileTreesCache.set(cacheKey, cached);
        return cached;
      }

      const grid = requestHeights(z, tx, ty, onReady);
      if (!grid) return [];

      // Единственный вызов planTileTrees с передачей полученных grid и roadSegs:
      const list = planTileTrees(z, tx, ty, grid, o, speciesGrid, roadSegs, riverData);
      tileTreesCache.set(cacheKey, list);
      if (tileTreesCache.size > 64) { // было 180
        tileTreesCache.delete(tileTreesCache.keys().next().value);
      }
      return list;
    }

    // =========================================================================
    // РЕЛЬЕФ ТАЙЛА
    // =========================================================================
    const GSTEP = 8;
    const GN = TILE / GSTEP;
    const PAD_N = 4;
    const GW = GN + 1 + PAD_N * 2;
    const packCache = new Map();
    let packVerCounter = 0;

    function tilePxToLatLng(z, X, Y) {
      const n = Math.pow(2, z) * TILE;
      let lng = (X / n) * 360 - 180;
      lng = ((lng + 180) % 360 + 360) % 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / n))) * 180 / Math.PI;
      return [lat, lng];
    }

    function demAvailable() {
      return !!(WM.demRelief && typeof WM.demRelief.getElevation === 'function');
    }

    function sampleGridFromChildDem(dem, z, tx, ty) {
      const cz = z + 1;
      if (cz > 18) return null;
      const cgn = GN >> 1;      // 16
      const cstep = GSTEP * 2;  // 16
      const cgw = cgn + 1 + PAD_N * 2; // 25

      const c00 = dem.sampleTileGrid(cz, tx * 2,     ty * 2,     cstep, cgn, PAD_N);
      const c10 = dem.sampleTileGrid(cz, tx * 2 + 1, ty * 2,     cstep, cgn, PAD_N);
      const c01 = dem.sampleTileGrid(cz, tx * 2,     ty * 2 + 1, cstep, cgn, PAD_N);
      const c11 = dem.sampleTileGrid(cz, tx * 2 + 1, ty * 2 + 1, cstep, cgn, PAD_N);
      if (!c00 || !c10 || !c01 || !c11) return null;

      const H = new Float32Array(GW * GW);
      const half = GW >> 1; // 20 (граница i=20, j=20)
      for (let j = 0; j < GW; j++) {
        const qy = j <= half ? 0 : 1;
        const cj = qy === 0 ? j : (j - cgn);
        const src0 = qy === 0 ? c00 : c01;
        const src1 = qy === 0 ? c10 : c11;
        const dRow = j * GW;
        const sRow = cj * cgw;
        for (let i = 0; i < GW; i++) {
          H[dRow + i] = (i <= half) ? src0[sRow + i] : src1[sRow + (i - cgn)];
        }
      }
      return H;
    }

    function buildPack(z, tx, ty) {
      const p = { ready: false, ver: 0, noDem: false };
      if (!demAvailable()) { p.noDem = true; return p; }
      const dem = WM.demRelief;

      const x0 = tx * TILE, y0 = ty * TILE;
      const mid = tilePxToLatLng(z, x0 + 128, y0 + 128);

      let H = (typeof dem.sampleTileGrid === 'function')
        ? (dem.sampleTileGrid(z, tx, ty, GSTEP, GN, PAD_N) || sampleGridFromChildDem(dem, z, tx, ty))
        : null;

      if (!H) {
        const hMid = dem.getElevation(mid[0], mid[1]);
        if (hMid === null || hMid === undefined || !isFinite(hMid)) return p;

        // Разреженная выборка через каждые 2 узла (21×21 = 441 вызов вместо 1681) + 1D-координаты
        const S = 2;
        const SW = ((GW - 1) >> 1) + 1; // 21
        const lats = new Float64Array(SW);
        const lngs = new Float64Array(SW);
        for (let k = 0; k < SW; k++) {
          const px = (k * S - PAD_N) * GSTEP;
          lats[k] = tilePxToLatLng(z, x0 + 128, y0 + px)[0];
          lngs[k] = tilePxToLatLng(z, x0 + px, y0 + 128)[1];
        }

        const Hs = new Float32Array(SW * SW);
        for (let sj = 0; sj < SW; sj++) {
          const lat = lats[sj];
          const row = sj * SW;
          for (let si = 0; si < SW; si++) {
            const h = dem.getElevation(lat, lngs[si]);
            Hs[row + si] = (h === null || h === undefined || !isFinite(h)) ? hMid : h;
          }
        }

        // Билинейное заполнение до GW × GW
        H = new Float32Array(GW * GW);
        for (let j = 0; j < GW; j++) {
          const sj = j >> 1, oj = j & 1;
          const sj1 = Math.min(SW - 1, sj + oj);
          const dRow = j * GW, sRow0 = sj * SW, sRow1 = sj1 * SW;
          for (let i = 0; i < GW; i++) {
            const si = i >> 1, oi = i & 1;
            const si1 = Math.min(SW - 1, si + oi);
            H[dRow + i] = (Hs[sRow0 + si] + Hs[sRow0 + si1] + Hs[sRow1 + si] + Hs[sRow1 + si1]) * 0.25;
          }
        }
      }

      const mpp = (156543.03392 * Math.cos(mid[0] * Math.PI / 180)) / Math.pow(2, z);
      const stepM = GSTEP * mpp;
      const k = clamp(Math.ceil(22 / stepM), 1, PAD_N);
      const kc = Math.min(PAD_N, k * 2);

      const W = GN + 1;
      const gE = new Float32Array(W * W), gN = new Float32Array(W * W);
      const crv = new Float32Array(W * W), Hc = new Float32Array(W * W);
      let hMin = Infinity, hMax = -Infinity;

      for (let j = 0; j < W; j++) {
        for (let i = 0; i < W; i++) {
          const ci = i + PAD_N, cj = j + PAD_N;
          const h = H[cj * GW + ci];
          const hE = H[cj * GW + ci + k], hWe = H[cj * GW + ci - k];
          const hS = H[(cj + k) * GW + ci], hNn = H[(cj - k) * GW + ci];
          const idx = j * W + i;
          Hc[idx] = h;
          gE[idx] = (hE - hWe) / (2 * k * stepM);
          gN[idx] = (hNn - hS) / (2 * k * stepM);
          const avg4 = (H[cj * GW + ci + kc] + H[cj * GW + ci - kc] + H[(cj + kc) * GW + ci] + H[(cj - kc) * GW + ci]) * 0.25;
          crv[idx] = (h - avg4) / (kc * stepM);
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      }

      p.ready = true;
      p.ver = ++packVerCounter;
      p.gE = gE; p.gN = gN; p.crv = crv; p.Hc = Hc;
      p.hMin = hMin; p.hMax = hMax; p.relief = hMax - hMin;
      p.mpp = mpp; p.lat = mid[0];
      return p;
    }

    function getPack(z, tx, ty) {
      const n = 1 << z;
      tx = ((tx % n) + n) % n;
      const key = z + '/' + tx + '/' + ty;
      const now = Date.now();
      let p = packCache.get(key);
      if (p && (p.ready || now - p.t < 500)) return p;
      p = buildPack(z, tx, ty);
      p.t = now;
      packCache.set(key, p);
      if (packCache.size > 48) packCache.delete(packCache.keys().next().value);
      return p;
    }

    const _smp = { gE: 0, gN: 0, crv: 0, h: 0 };
    function samplePack(p, x, y, out) {
      const fx = clamp(x / GSTEP, 0, GN - 0.001);
      const fy = clamp(y / GSTEP, 0, GN - 0.001);
      const i = fx | 0, j = fy | 0;
      const ax = fx - i, ay = fy - j;
      const W = GN + 1;
      const i00 = j * W + i, i10 = i00 + 1, i01 = i00 + W, i11 = i01 + 1;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      out.gE = p.gE[i00] * w00 + p.gE[i10] * w10 + p.gE[i01] * w01 + p.gE[i11] * w11;
      out.gN = p.gN[i00] * w00 + p.gN[i10] * w10 + p.gN[i01] * w01 + p.gN[i11] * w11;
      out.crv = p.crv[i00] * w00 + p.crv[i10] * w10 + p.crv[i01] * w01 + p.crv[i11] * w11;
      out.h = p.Hc[i00] * w00 + p.Hc[i10] * w10 + p.Hc[i01] * w01 + p.Hc[i11] * w11;
    }

    // =========================================================================
    // ТЕНИ РЕЛЬЕФА
    // =========================================================================
    const SH_N = 12;
    const shadowCache = new Map();
    const SH_DIST = [35, 80, 160, 320, 640, 1280, 2400];

    function buildShadowField(z, tx, ty, pack, P) {
      const hor = Math.hypot(P.sE, P.sN);
      if (hor < 0.05 || pack.relief < 4) return null;
      const dem = WM.demRelief;
      const tanA = P.sZ / hor;
      const hE = P.sE / hor, hN = P.sN / hor;
      const W = SH_N + 1;
      const f = new Float32Array(W * W);
      const x0 = tx * TILE, y0 = ty * TILE;
      const cosLat = Math.cos(pack.lat * Math.PI / 180) || 1;

      for (let j = 0; j < W; j++) {
        for (let i = 0; i < W; i++) {
          const px = (i / SH_N) * TILE, py = (j / SH_N) * TILE;
          samplePack(pack, px, py, _smp);
          const h0 = _smp.h;
          const ll = tilePxToLatLng(z, x0 + px, y0 + py);
          let shade = 0;
          for (let k = 0; k < SH_DIST.length; k++) {
            const d = SH_DIST[k];
            const lat = ll[0] + (d * hN) / 111320;
            const lng = ll[1] + (d * hE) / (111320 * cosLat);
            const ht = dem.getElevation(lat, lng);
            if (ht === null || ht === undefined) continue;
            const occ = (ht - (h0 + d * tanA + 1.5)) / (6 + d * 0.025);
            if (occ > 0) {
              const s = smoothstep(0, 1, occ);
              if (s > shade) shade = s;
              if (shade >= 0.999) break;
            }
          }
          f[j * W + i] = 1 - shade;
        }
      }
      return f;
    }

    function getShadowField(z, tx, ty, pack, P, o) {
      if (!o.terrShadows || !pack || !pack.ready || P.I < 0.12) return null;
      const key = z + '/' + tx + '/' + ty + '|' + P.shKey;
      let f = shadowCache.get(key);
      if (f !== undefined) return f;
      f = buildShadowField(z, tx, ty, pack, P);
      shadowCache.set(key, f);
      if (shadowCache.size > 48) shadowCache.delete(shadowCache.keys().next().value);
      return f;
    }

    function sampleShadow(f, x, y) {
      const W = SH_N + 1;
      const fx = clamp(x / TILE * SH_N, 0, SH_N - 0.001);
      const fy = clamp(y / TILE * SH_N, 0, SH_N - 0.001);
      const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j;
      const a = f[j * W + i], b = f[j * W + i + 1], c = f[(j + 1) * W + i], d = f[(j + 1) * W + i + 1];
      return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
    }

    // =========================================================================
    // ПОДГОТОВКА ОСВЕЩЕНИЯ
    // =========================================================================
    function getTreeLighting(lat, lng) {
      if (WM.demRelief && typeof WM.demRelief.getLighting === 'function') {
        const Lg = WM.demRelief.getLighting(lat, lng);
        if (Lg) return Lg;
      }
      return {
        sunVec: [0.5, -0.5, 0.7],
        lightColor: [1.0, 0.98, 0.94], shadowColor: [0.28, 0.32, 0.41],
        skyColor: [0.45, 0.55, 0.70], valleyColor: [0.20, 0.18, 0.35],
        glowColor: [1.0, 0.45, 0.25], twilightRimColor: [0.9, 0.25, 0.15],
        sunIntensity: 1.0, twilightAmt: 0.0, twilightClimb: -1.0
      };
    }

    const safe3 = (v, d) => (Array.isArray(v) && v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2])) ? v : d;
    const q3 = (c) => Math.round(c[0] * 12) + ',' + Math.round(c[1] * 12) + ',' + Math.round(c[2] * 12);

    function prepareLighting(Lg, o) {
      const sv = safe3(Lg.sunVec, [0.5, -0.5, 0.7]);
      const len = Math.hypot(sv[0], sv[1], sv[2]) || 1;
      const sx = sv[0] / len, sy = sv[1] / len, sz = sv[2] / len;
      const hor = Math.hypot(sx, sy);

      let cfgWrap = 0.35;
      try {
        if (WM.demRelief && WM.demRelief.getConfig) {
          const c = WM.demRelief.getConfig();
          if (c && c.lightWrap !== undefined) cfgWrap = c.lightWrap;
        }
      } catch (e) {}

      let eMin = 0, eSpan = 500;
      try {
        if (WM.demRelief && WM.demRelief.getElevationStats) {
          const s = WM.demRelief.getElevationStats();
          if (s && isFinite(s.minH) && isFinite(s.span)) { eMin = s.minH; eSpan = Math.max(10, s.span); }
        }
      } catch (e) {}

      const P = {
        sE: sx, sN: -sy, sZ: sz,
        U: hor > 0.08 ? { x: sx / hor, y: sy / hor } : { x: -0.5, y: -0.85 },
        I: clamp(Lg.sunIntensity !== undefined ? Lg.sunIntensity : 1.0, 0, 1.5),
        tw: clamp(Lg.twilightAmt || 0, 0, 1),
        climb: Lg.twilightClimb !== undefined ? Lg.twilightClimb : -1.0,
        glowW: clamp(Lg.alpenglowWeight || 0, 0, 1),
        after: clamp(Lg.afterglow || 0, 0, 1),
        reach: clamp(Lg.dayReach !== undefined ? Lg.dayReach : 0.52, 0, 1),
        warmCool: Lg.warmCool !== undefined ? Lg.warmCool : 0.85,
        wrap: cfgWrap,
        lightCol: safe3(Lg.lightColor, [1.0, 0.98, 0.94]),
        shadowCol: safe3(Lg.shadowColor, [0.28, 0.32, 0.41]),
        skyCol: safe3(Lg.skyColor, [0.45, 0.55, 0.70]),
        valleyCol: safe3(Lg.valleyColor, [0.20, 0.18, 0.35]),
        glowCol: safe3(Lg.glowColor, [0.95, 0.35, 0.28]),
        rimCol: safe3(Lg.twilightRimColor, [0.85, 0.30, 0.20]),
        faceCol: safe3(Lg.sunFaceColor, [1.0, 0.9, 0.8]),
        eMin, eSpan
      };

      // --- ДОБАВЬТЕ ЭТУ СТРОКУ (инициализация P.shadowTone): ---
      P.shadowTone = (o && o.treeGroundShadowCustom && o.treeGroundShadowColor)
        ? colorToRgb(o.treeGroundShadowColor).map(v => v / 255)
        : clamp3(mix3(mul3(P.shadowCol, 0.32), mul3(P.valleyCol, 0.35), P.tw * 0.5));
      // ---------------------------------------------------------

      const rawAlt = Lg.sunAltDeg !== undefined ? Lg.sunAltDeg : (Lg.nightWeight !== undefined ? (1.0 - Lg.nightWeight) * 20.0 - 15.0 : 10.0);
      P.sunAltDeg = rawAlt;
      P.night = Lg.nightWeight !== undefined ? Lg.nightWeight : (1.0 - smoothstep(-14.0, -7.0, rawAlt));
      P.dayWeight = smoothstep(-1.0, 4.0, rawAlt);
      P.shKey = Math.round(P.sE * 50) + '_' + Math.round(P.sN * 50) + '_' + Math.round(P.sZ * 50);
      const twActive = P.tw > 0.01 || P.after > 0.01;

      // Ключ ТОЛЬКО для палитр и спрайтов (без eMin/eSpan, climb, reach, wrap)
      P.sprKey = [
        P.shKey,
        Math.round(P.tw * 12),
        Math.round(P.night * 12),
        Math.round(P.dayWeight * 12),
        Math.round(P.warmCool * 10),
        q3(P.lightCol), q3(P.shadowCol), q3(P.skyCol),
        q3(P.valleyCol), q3(P.glowCol), q3(P.rimCol), q3(P.faceCol)
      ].join('|');

      P.key = [
        P.sprKey, Math.round(P.I * 12), Math.round(P.climb * 10),
        Math.round(P.glowW * 10), Math.round(P.after * 10),
        twActive ? Math.round((P.eMin / Math.max(10, P.eSpan * 0.05))) + '~' + Math.round(P.eSpan / Math.max(10, P.eSpan * 0.05)) : 'x',
        o.terrainLight ? 1 : 0, o.terrShadows ? 1 : 0, Math.round(P.reach * 10), Math.round(P.wrap * 10)
      ].join('|');
      return P;
    }

    function computeLight(t, pack, field, P, o) {
      let hN = 0.5, crest = 0, ao = 1, slope = 0, gE = 0, gN = 0;
      if (o.terrainLight && pack && pack.ready) {
        samplePack(pack, t.x, t.y, _smp);
        gE = _smp.gE; gN = _smp.gN;
        slope = Math.hypot(gE, gN);
        hN = clamp((_smp.h - P.eMin) / Math.max(1, P.eSpan), 0, 1);
        crest = clamp(_smp.crv * 3.0, 0, 0.4);
        ao = clamp(1 + _smp.crv * 1.2, 0.72, 1.0);
      }

      const nz = 1 / Math.sqrt(gE * gE + gN * gN + 1);
      const nE = -gE * nz, nN = -gN * nz;
      const d = nE * P.sE + nN * P.sN + nz * P.sZ;

      const wrap = clamp(P.wrap + (P.reach - 0.5) * 0.45, 0.05, 0.85) * mix(1.0, 0.40, P.tw);
      let wl = clamp((d + wrap) / (1 + wrap), 0, 1);
      wl = Math.pow(wl, mix(1.3, 0.7, P.reach));

      let cast = 1;
      if (field) cast = mix(1.0, sampleShadow(field, t.x, t.y), clamp(P.I * 1.15, 0.25, 1.0));

      let direct = wl * cast * P.I;

      const hor = Math.hypot(P.sE, P.sN) || 1;
      const sunDot2D = (-gE) * (P.sE / hor) + (-gN) * (P.sN / hor);
      const sunFacing = smoothstep(-0.05, 0.35, sunDot2D);
      const hEff = hN + (sunFacing - 0.5) * 0.32 + crest * 0.35 * mix(0.25, 1.0, sunFacing);
      const edgeW = mix(0.06, 0.16, P.tw);
      const litMask = smoothstep(P.climb - edgeW, P.climb + edgeW, hEff);

      const directFacing = smoothstep(0, 0.25, d) * cast;
      // Терминатор должен полностью глушить прямой свет ночью и в сумерках,
      // и отключаться ТОЛЬКО полным днем (когда солнце высоко над горизонтом P.dayWeight -> 1)
      direct *= mix(litMask, 1.0, P.dayWeight);

      const sunsetFacing = clamp(sunFacing * 0.75 + directFacing * 0.5, 0, 1);
      const glow = (P.glowW > 0.001 || P.tw > 0.05)
        ? (P.glowW * 0.90 + P.tw * 0.55) * litMask * sunsetFacing * cast
        : 0.0;

      if (glow > 0.001) direct = Math.max(direct, glow * 0.45);

      if (P.after > 0.001) {
        let fg = clamp(d * 0.5 + 0.5, 0, 1);
        fg *= fg;
        // Мягкий свет зари не превышает 0.18, чтобы не срывать крону в яркий дневной желтый цвет
        direct = Math.max(direct, P.after * (0.04 + 0.14 * fg) * mix(0.55, 1.0, ao));
      }

      const termEdge = smoothstep(0.05, 0.45, direct) * (1 - smoothstep(0.40, 0.85, direct));
      const band = smoothstep(P.climb - 0.18, P.climb, hEff) * (1 - smoothstep(P.climb, P.climb + 0.22, hEff));
      const rim = clamp((termEdge * 0.65 + band) * P.tw, 0, 1);

      let cut = -1;
      let lit = clamp(direct * (0.7 + 0.3 * ao), 0, 1);
      lit = clamp(lit + (hash2(t.cx, t.cy, 23) - 0.5) * 0.11, 0, 1);

      return {
        lv: clamp(Math.round(lit * 6), 0, 6),
        gl: clamp(Math.round(glow * 4), 0, 4),
        rm: clamp(Math.round(rim * 3), 0, 3),
        cut,
        slope
      };
    }

    function ensureLight(t, pack, field, P, o) {
      const pv = (pack && pack.ready) ? pack.ver : 0;
      if (t._ls && t._lk === P.key && t._pv === pv) return t._ls;
      t._ls = computeLight(t, pack, field, P, o);
      t._lk = P.key;
      t._pv = pv;
      return t._ls;
    }

    // =========================================================================
    // ЦВЕТА И ПАЛИТРА
    // =========================================================================
    function hexToRgbArr(hex) {
      let h = String(hex || '#1c1917').replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const n = parseInt(h, 16);
      return isNaN(n) ? [28, 25, 23] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;
      if (max === min) {
        h = s = 0;
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          default: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      return [h * 360, s * 100, l * 100];
    }

    function hslStrToRgb(hslStr) {
      const m = /hsl\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)%\s*,\s*(-?[\d.]+)%\s*\)/i.exec(hslStr || '');
      if (!m) return [100, 140, 80];
      let h = (parseFloat(m[1]) % 360) / 360;
      if (h < 0) h += 1.0;
      const s = clamp(parseFloat(m[2]) / 100.0, 0.0, 1.0);
      const l = clamp(parseFloat(m[3]) / 100.0, 0.0, 1.0);
      if (isNaN(h) || isNaN(s) || isNaN(l)) return [100, 140, 80];
      if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const f = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
    }

    function colorToRgb(str) {
      if (!str || typeof str !== 'string') return [100, 140, 80];
      str = str.trim();
      if (str.startsWith('#')) return hexToRgbArr(str);
      if (str.startsWith('hsl')) return hslStrToRgb(str);
      return [100, 140, 80];
    }

    function getCrownFillColor(kind, o, treeSeed, tone) {
      tone = tone === undefined ? 1 : tone;

      let baseH, baseS, baseL;
      if (o.customColors && o.opaqueFill) {
        let baseHex;
        if (kind === 'conifer') {
          baseHex = o.coniferColor || '#264e36';
        } else {
          const rndRatio = hash2(treeSeed, 17, 3);
          baseHex = (rndRatio < o.decidRatio) ? (o.decidColor2 || '#b89e58') : (o.decidColor1 || '#7fa361');
        }
        const c = hexToRgbArr(baseHex);
        [baseH, baseS, baseL] = rgbToHsl(c[0], c[1], c[2]);
      } else {
        // Слайдеры теплоты, яркости и насыщенности теперь работают ВСЕГДА!
        const baseHue = 140 - o.fillWarmth * 75;
        const hueShift = kind === 'decid' ? -12 : 16;
        baseH = clamp(baseHue + hueShift, 40, 180);
        baseS = clamp(o.fillSat * 65, 0, 100);
        baseL = clamp((kind === 'decid' ? 58 : 44) * o.fillBright, 10, 95);

        // Если сплошная заливка выключена — создаём полупрозрачную пергаментную / карандашную основу
        if (!o.opaqueFill) {
          // Мягкое снижение плотности, но сохраняем выбранную цветовую температуру и яркость карандаша
          baseL = clamp(baseL * 1.05 + 15.0 * (1.0 - o.fillSat), 30, 96);
          baseS = clamp(baseS * 0.65, 0, 80);
        }
      }

      if (o.colorScatter > 0.01) {
        const rndH = (hash2(treeSeed, 31, 7) - 0.5) * 2;
        const rndL = (hash2(treeSeed, 43, 9) - 0.5) * 2;
        const rndS = (hash2(treeSeed, 59, 11) - 0.5) * 2;
        baseH = (baseH + rndH * (o.colorScatter * 26) + 360) % 360;
        baseL = baseL + rndL * (o.colorScatter * 14);
        baseS = clamp(baseS + rndS * (o.colorScatter * 20), 0, 100);
        baseH = (baseH + (tone - 1) * 11 * (0.4 + o.colorScatter) + 360) % 360;
        baseL += (tone - 1) * 4.5 * (0.4 + o.colorScatter);
      }

      if (kind === 'conifer' && CANOPY_DEV_CONFIG.conifer) {
        const cc = CANOPY_DEV_CONFIG.conifer;
        baseH = (baseH + (cc.hueShift || 0) + 360) % 360;
        baseS = clamp(baseS * (cc.satMul !== undefined ? cc.satMul : 1.0), 0, 100);
        baseL = baseL * (cc.brightMul !== undefined ? cc.brightMul : 1.0);
      }

      baseL = clamp(baseL, 8, 98);
      return `hsl(${Math.round(baseH)}, ${Math.round(baseS)}%, ${Math.round(baseL)}%)`;
    }

    function getTrunkFillColor(o) {
      if (!o.opaqueFill) return o.ink;
      const h = Math.round(clamp(18 + o.fillWarmth * 22, 10, 45));
      const s = Math.round(clamp(o.fillSat * 38, 0, 85));
      const l = Math.round(clamp(28 * o.fillBright, 8, 75));
      return `hsl(${h}, ${s}%, ${l}%)`;
    }

    const paletteCache = new Map();

    function makePalette(kind, o, seed, tone, st, P, albedoRgb255, trunkOverride) {
      const base = albedoRgb255 || colorToRgb(getCrownFillColor(kind, o, seed, tone));
      const A = [base[0] / 255, base[1] / 255, base[2] / 255];
      const vol = (o.volumetric !== undefined) ? o.volumetric : 1.0;
      const lit = st.lv / 6, gl = (st.gl || 0) / 4, rm = (st.rm || 0) / 3, tw = P.tw;

      const sunsetCol = mix3(P.glowCol, P.rimCol, 0.35);
      const glowEffect = clamp(gl * 1.2 + tw * lit * P.dayWeight * 0.6, 0, 1) * vol;

      let sun = mix3(P.lightCol, P.faceCol, tw * 0.5);
      sun = mix3(sun, sunsetCol, glowEffect * 0.85);

      let amb = mul3(mix3(P.shadowCol, P.skyCol, 0.45 * P.warmCool), mix(1.6, 1.9, tw) * mix(1.0, 0.92, P.night));
      amb = mix3(amb, mul3(P.valleyCol, 1.35), tw * (1 - lit * 0.7) * 0.65);

      const wT = smoothstep(0.0, 0.75, lit) * vol;
      const topL = mix3(amb, mul3(sun, 1.15), wT);
      const midL = mix3(mul3(amb, 0.88), mul3(sun, 0.95), wT * 0.9);

      const satK = 1 + (0.40 * lit * (1 - 0.5 * tw) - 0.18 * (1 - lit) * (1 - P.night)) * vol;
      const tint = (alb, L) => clamp3(sat3([alb[0] * L[0], alb[1] * L[1], alb[2] * L[2]], satK));
      const botL = mix3(mul3(amb, mix(0.9, o.treeShadeDarkness, vol)), mix3(mul3(sun, 0.45), mul3(amb, 0.45), 0.5), lit * 0.7 * vol);

      // Корректировка ночной яркости и контраста деревьев
      const nightMix = (c) => {
        if (P.night < 0.01) return c;
        let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

        // Применяем ночной контраст
        l = clamp((l - 0.45) * o.treeNightContrast + 0.45, 0.02, 1.0);

        const tintCol = hexToRgbArr(o.treeNightTint).map(v => v / 255);
        const nightBase = [
          clamp(l * tintCol[0] * 2.0 * o.treeNightBrightness, 0, 1),
          clamp(l * tintCol[1] * 2.0 * o.treeNightBrightness, 0, 1),
          clamp(l * tintCol[2] * 2.0 * o.treeNightBrightness, 0, 1)
        ];
        return mix3(c, nightBase, P.night * o.treeNightStrength);
      };

      const litAlbedo = mix3(A, mix3([0.96, 0.32, 0.24], sunsetCol, 0.65), glowEffect * 0.70);

      const top = nightMix(mix3(tint(litAlbedo, topL), mul3(sunsetCol, 1.15), glowEffect * 0.72));
      const mid = nightMix(mix3(tint(litAlbedo, midL), mul3(sunsetCol, 0.85), glowEffect * 0.50));
      const bot = nightMix(tint(A, botL));
      const hi  = nightMix(mix3(tint(litAlbedo, mix3(topL, mul3(sun, 1.3), 0.55)), mul3(sunsetCol, 1.4), glowEffect * 0.85));

      const customInk = colorToRgb(o.strokeColor || o.ink).map(v => v / 255);
      const ink = clamp3(mix3(customInk, mul3(P.valleyCol, 0.24), 0.15 * tw));

      const rimRGB = clamp3(mul3(mix3(sun, sunsetCol, 0.75), 1.25));
      const rimA = clamp(glowEffect * 0.75 + rm * 0.35, 0, 0.95) * vol;

      const tb = (trunkOverride || colorToRgb(getTrunkFillColor(o))).map(v => v / 255);
      const trunkL = nightMix(mix3(clamp3([tb[0] * topL[0], tb[1] * topL[1], tb[2] * topL[2]]), mul3(sunsetCol, 0.8), glowEffect * 0.5));
      const trunkS = nightMix(clamp3([tb[0] * botL[0] * 0.85, tb[1] * botL[1] * 0.85, tb[2] * botL[2] * 0.85]));

      const grBase = [0.40, 0.52, 0.26];
      const gr = nightMix(tint(grBase, midL));
      const grHi = nightMix(tint([0.52, 0.64, 0.30], topL));
      const rock = nightMix(clamp3([0.58 * midL[0], 0.57 * midL[1], 0.55 * midL[2]]));
      const rockHi = nightMix(clamp3([0.74 * topL[0], 0.72 * topL[1], 0.68 * topL[2]]));

      return {
        a: { top, mid, bot, hi, ink, rim: rimRGB, trunkL, trunkS, gr, grHi, rock, rockHi },
        hiA: clamp((lit - 0.35) / 0.65, 0, 1) * 0.55 * vol,
        shadeA: o.treeShadeOpacity * (1.0 - lit * 0.3) * vol,
        rimA, lit,
        shadowInk: clamp3(mix3(mul3(amb, 0.30), mul3(P.valleyCol, 0.30), tw * 0.5))
      };
    }

    function getPalette(kind, o, seed, tone, st, P, albedo, trunk, extraKey) {
      const key = `${kind}|${seed}|${tone}|${st.lv}${st.gl}${st.rm}|${P.sprKey}|${o.sprSig}|${extraKey || ''}`;
      let p = paletteCache.get(key);
      if (p) return p;
      p = makePalette(kind, o, seed, tone, st, P, albedo, trunk);
      paletteCache.set(key, p);
      if (paletteCache.size > 1200) paletteCache.delete(paletteCache.keys().next().value);
      return p;
    }

    // =========================================================================
    // РИСОВАЛЬНЫЕ ПРИМИТИВЫ
    // =========================================================================
    function rng(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const lobeCount = (b) => (b < 14 ? 6 : (b < 30 ? 7 : 9));

    function lobedPath(ctx, cx, cy, rx, ry, n, seed, grow, flatBottom) {
      const rnd = rng(seed);
      const a0 = rnd() * TWO_PI;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + ((i + (rnd() - 0.5) * 0.35) / n) * TWO_PI;
        const k = 0.93 + rnd() * 0.14;
        pts.push(cx + Math.cos(a) * (rx * k + grow), cy + Math.sin(a) * (ry * k + grow));
      }
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const px = pts[2 * i], py = pts[2 * i + 1];
        const qx = pts[2 * j], qy = pts[2 * j + 1];
        const mx = (px + qx) / 2, my = (py + qy) / 2;
        const dx = mx - cx, dy = my - cy;
        const d = Math.hypot(dx, dy) || 1;
        const chord = Math.hypot(qx - px, qy - py);
        const low = flatBottom && dy > ry * 0.45;
        const push = chord * (low ? 0.22 : 0.72);
        ctx.quadraticCurveTo(mx + (dx / d) * push, my + (dy / d) * push, qx, qy);
      }
      ctx.closePath();
    }

    function newSprite(L, Rr, Up, D) {
      const cv = document.createElement('canvas');
      const wCss = Math.max(2, Math.ceil(L + Rr));
      const hCss = Math.max(2, Math.ceil(Up + D));
      cv.width = Math.round(wCss * TILE_DPR);
      cv.height = Math.round(hCss * TILE_DPR);
      const ctx = cv.getContext('2d');
      ctx.scale(TILE_DPR, TILE_DPR);
      ctx.translate(L, Up);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      return { cv, ctx, ax: L, ay: Up, wCss, hCss, bytes: cv.width * cv.height * 4 };
    }

    function hatchLines(ctx, cx, cy, R, gap, ang, seed) {
      const rnd = rng(seed + 55);
      const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
      ctx.beginPath();
      for (let s = -R; s <= R; s += gap) {
        if (rnd() < 0.18) continue;
        const j = (rnd() - 0.5) * gap * 0.4;
        const ox = cx + px * (s + j), oy = cy + py * (s + j);
        const l = R * (0.6 + rnd() * 0.4);
        ctx.moveTo(ox - dx * l, oy - dy * l);
        ctx.lineTo(ox + dx * l, oy + dy * l);
      }
      ctx.stroke();
    }

    function halfPlanePath(ctx, cx, cy, U, R) {
      const px = -U.y, py = U.x;
      ctx.moveTo(cx + px * R, cy + py * R);
      ctx.lineTo(cx + px * R + U.x * R, cy + py * R + U.y * R);
      ctx.lineTo(cx - px * R + U.x * R, cy - py * R + U.y * R);
      ctx.lineTo(cx - px * R, cy - py * R);
      ctx.closePath();
    }

    function drawBump(ctx, cx, cy, rx, ry, n, seed, pal, U, op) {
      const a = pal.a;
      const vol = (op.volumetric !== undefined) ? op.volumetric : 1.0;
      lobedPath(ctx, cx, cy, rx, ry, n, seed, 0, !!op.flat);

      // 1. Базовый объем кроны (градиент)
      if (vol <= 0.02) {
        ctx.fillStyle = css3(a.mid);
      } else {
        const g = ctx.createLinearGradient(cx + U.x * rx * vol, cy + U.y * ry * vol, cx - U.x * rx * vol, cy - U.y * ry * vol);
        g.addColorStop(0, css3(mix3(a.mid, a.top, vol)));
        g.addColorStop(0.55, css3(a.mid));
        g.addColorStop(1, css3(mix3(a.mid, a.bot, vol)));
        ctx.fillStyle = g;
      }
      ctx.fill();

      // 2. Внутренние эффекты (свет, тень, фактура)
      if (vol > 0.02) {
        ctx.save();
        ctx.clip(); // Ограничиваем эффекты контуром кроны

        // --- А. БАЗОВЫЙ ОБЪЕМНЫЙ БЛИК (Сначала фоновый купол света!) ---
        if (pal.hiA > 0.03 && rx > 3.0) {
          ctx.fillStyle = css3(a.hi, pal.hiA * vol);
          lobedPath(ctx, cx + U.x * rx * 0.34, cy + U.y * ry * 0.32, rx * 0.54, ry * 0.48, 5, seed + 7, 0, false);
          ctx.fill();
        }

        // --- Б. ТЕНЕВОЙ ПОЛУМЕСЯЦ И ШТРИХОВКА ---
        ctx.beginPath();
        ctx.rect(cx - rx * 2.5, cy - ry * 2.5, rx * 5, ry * 5);
        ctx.ellipse(cx + U.x * rx * 0.30, cy + U.y * ry * 0.26, rx * 0.88, ry * 0.86, 0, 0, TWO_PI);
        ctx.fillStyle = css3(a.ink, pal.shadeA * vol);
        ctx.fill('evenodd');

        if (op.detail && vol > 0.15 && pal.lit > 0.08) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - rx * 2.5, cy - ry * 2.5, rx * 5, ry * 5);
          ctx.ellipse(cx + U.x * rx * 0.30, cy + U.y * ry * 0.26, rx * 0.88, ry * 0.86, 0, 0, TWO_PI);
          ctx.clip('evenodd');
          ctx.strokeStyle = css3(a.ink, 0.7 * vol * pal.lit);
          ctx.lineWidth = Math.max(0.5, op.lw * 0.6);
          hatchLines(ctx, cx, cy, Math.max(rx, ry) * 1.3, Math.max(2.1, rx * 0.2), Math.atan2(U.y, U.x) + Math.PI / 2 + 0.35, seed);
          ctx.restore();
        }

        // --- В. СОЛНЕЧНЫЕ ПЯТНА И ПРОСВЕТЫ (Dappled Light) поверх полутеней ---
        const dCfg = CANOPY_DEV_CONFIG.dappledLight;
        if (dCfg.enabled && rx > 3.0) {
          const spotRnd = rng(seed + 87);
          const count = dCfg.spotCount;
          const warmHi = mix3(a.hi, [1.0, 0.94, 0.70], dCfg.spotWarmthShift);
          const spotAlpha = clamp(dCfg.spotOpacity * (0.35 + pal.lit * 0.65) * vol, 0.05, 0.95);

          ctx.fillStyle = css3(warmHi, spotAlpha);
          for (let s = 0; s < count; s++) {
            const ang = spotRnd() * TWO_PI;
            const dist = (0.1 + spotRnd() * 0.58) * rx;
            const spX = cx + U.x * rx * 0.22 + Math.cos(ang) * dist;
            const spY = cy + U.y * ry * 0.20 + Math.sin(ang) * dist * 0.75;
            const sRadX = rx * (dCfg.spotRadiusMin + spotRnd() * (dCfg.spotRadiusMax - dCfg.spotRadiusMin));
            const sRadY = sRadX * (0.7 + spotRnd() * 0.3);

            ctx.beginPath();
            ctx.ellipse(spX, spY, Math.max(0.8, sRadX), Math.max(0.6, sRadY), spotRnd() * Math.PI, 0, TWO_PI);
            ctx.fill();
          }
        }

        // --- Г. ШЕРОХОВАТОСТЬ / ГРАВЮРНЫЕ ТОЧКИ ЛИСТВЫ (Foliage Stipple) ---
        const rCfg = CANOPY_DEV_CONFIG.roughness;
        if (rCfg.enabled && rx > 3.0) {
          const rRnd = rng(seed + 193);
          const nDots = Math.max(4, Math.floor(rx * 2.2 * rCfg.density));

          // Теневые крапинки тушью (контрастная зернистость гравюры)
          ctx.fillStyle = css3(a.ink, clamp(rCfg.darkNoiseOpacity * 1.35 * vol, 0.05, 0.9));
          ctx.beginPath();
          for (let i = 0; i < nDots; i++) {
            const da = rRnd() * TWO_PI;
            const dr = (0.15 + rRnd() * 0.75) * rx;
            const dotX = cx + Math.cos(da) * dr;
            const dotY = cy + Math.sin(da) * (dr * (ry / rx));
            const rad = Math.max(0.6, rCfg.dotRadiusMin + rRnd() * (rCfg.dotRadiusMax - rCfg.dotRadiusMin));
            ctx.moveTo(dotX + rad, dotY);
            ctx.arc(dotX, dotY, rad, 0, TWO_PI);
          }
          ctx.fill();

          // Световые крупинки фактуры
          ctx.fillStyle = css3(a.hi, clamp(rCfg.lightNoiseOpacity * (0.3 + pal.lit * 0.7) * vol, 0.05, 0.9));
          ctx.beginPath();
          for (let i = 0; i < Math.floor(nDots * 0.7); i++) {
            const da = rRnd() * TWO_PI;
            const dr = (0.1 + rRnd() * 0.6) * rx;
            const dotX = cx + U.x * rx * 0.28 + Math.cos(da) * dr;
            const dotY = cy + U.y * ry * 0.28 + Math.sin(da) * (dr * (ry / rx));
            const rad = Math.max(0.5, rCfg.dotRadiusMin + rRnd() * (rCfg.dotRadiusMax - rCfg.dotRadiusMin));
            ctx.moveTo(dotX + rad, dotY);
            ctx.arc(dotX, dotY, rad, 0, TWO_PI);
          }
          ctx.fill();
        }

        ctx.restore();
      }

      // 3. Внешний контур тушью
      if (!op.noStroke) {
        lobedPath(ctx, cx, cy, rx, ry, n, seed, 0, !!op.flat);
        ctx.strokeStyle = css3(a.ink, op.strokeAlpha);
        ctx.lineWidth = op.lw;
        ctx.stroke();

        const shBoost = op.shadowStrokeBoost !== undefined ? op.shadowStrokeBoost : 0.6;
        if (vol > 0.05 && shBoost > 0.01) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - rx * 2.5, cy - ry * 2.5, rx * 5, ry * 5);
          ctx.ellipse(cx + U.x * rx * 0.30, cy + U.y * ry * 0.26, rx * 0.88, ry * 0.86, 0, 0, TWO_PI);
          ctx.clip('evenodd');
          lobedPath(ctx, cx, cy, rx, ry, n, seed, 0, !!op.flat);
          ctx.lineWidth = op.lw * (1.0 + shBoost * vol);
          ctx.stroke();
          ctx.restore();
        }
      } else if (op.partialStroke) {
        const pCfg = CANOPY_DEV_CONFIG.clustering;
        const alpha = pCfg.innerStrokeAlpha !== undefined ? pCfg.innerStrokeAlpha : 0.65;
        const lwMul = pCfg.innerStrokeScale !== undefined ? pCfg.innerStrokeScale : 1.2;
        const reach = pCfg.innerTopArcReach !== undefined ? pCfg.innerTopArcReach : 0.10;

        ctx.save();
        // Обрезаем так, чтобы рисовалась только ВЕРХНЯЯ дуга кроны.
        // Всё, что ниже середины (внутри массива), будет скрыто.
        ctx.beginPath();
        ctx.rect(cx - rx * 2.5, cy - ry * 2.5, rx * 5, ry * 2.5 + ry * reach);
        ctx.clip();

        lobedPath(ctx, cx, cy, rx, ry, n, seed, 0, !!op.flat);
        ctx.strokeStyle = css3(a.ink, alpha);
        ctx.lineWidth = Math.max(0.6, op.lw * lwMul);
        ctx.stroke();
        ctx.restore();
      }
    }
    function contactShadow(ctx, x, y, r, pal, o) {
      if (!o.shadows) return;
      ctx.fillStyle = css3(pal.a.ink, o.treeContactShadowOpacity !== undefined ? o.treeContactShadowOpacity : 0.46);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.5, r * 0.15, 0, 0, TWO_PI);
      ctx.fill();
    }

    function grassTufts(ctx, xs, y, h, pal, lw, seed) {
      const rnd = rng(seed + 321);
      ctx.strokeStyle = css3(mul3(pal.a.gr, 0.55));
      ctx.lineWidth = Math.max(0.5, lw * 0.6);
      ctx.beginPath();
      for (let k = 0; k < xs.length; k++) {
        const x = xs[k];
        const n = 3 + ((rnd() * 2) | 0);
        for (let i = 0; i < n; i++) {
          const dx = (i - (n - 1) / 2) * h * 0.38 + (rnd() - 0.5) * h * 0.2;
          const hh = h * (0.75 + rnd() * 0.5);
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + dx * 0.4, y - hh * 0.6, x + dx, y - hh);
        }
      }
      ctx.stroke();
    }

    function drawRock(ctx, x, y, s, pal, U, lw, seed) {
      const rnd = rng(seed);
      const pts = [];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TWO_PI + rnd() * 0.5;
        const rr = s * (0.8 + rnd() * 0.35);
        pts.push([x + Math.cos(ang) * rr, y - s * 0.45 + Math.sin(ang) * rr * 0.62]);
      }
      const path = () => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
      path();
      ctx.fillStyle = css3(pal.a.rock);
      ctx.fill();
      ctx.save();
      path(); ctx.clip();
      ctx.fillStyle = css3(pal.a.rockHi, 0.8);
      ctx.beginPath(); halfPlanePath(ctx, x, y - s * 0.45, U, s * 2); ctx.fill();
      ctx.restore();
      path();
      ctx.strokeStyle = css3(pal.a.ink);
      ctx.lineWidth = Math.max(0.6, lw * 0.8);
      ctx.stroke();
    }

    function drawMound(ctx, x, y, mr, mh, pal, U, lw, seed) {
      const a = pal.a;
      ctx.beginPath();
      ctx.ellipse(x, y, mr, mh, 0, Math.PI, TWO_PI);
      ctx.closePath();
      const g = ctx.createLinearGradient(x + U.x * mr, y + U.y * mh, x - U.x * mr, y);
      g.addColorStop(0, css3(a.grHi));
      g.addColorStop(1, css3(a.gr));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = css3(a.ink);
      ctx.lineWidth = Math.max(0.7, lw * 0.9);
      ctx.stroke();
      const rnd = rng(seed + 11);
      ctx.strokeStyle = css3(a.ink, 0.55);
      ctx.lineWidth = Math.max(0.5, lw * 0.55);
      ctx.beginPath();
      const side = U.x >= 0 ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        const sx = x + side * mr * (0.25 + i * 0.22);
        ctx.moveTo(sx, y - mh * (0.55 - i * 0.12));
        ctx.lineTo(sx + side * mr * 0.10, y - mh * (0.15 + rnd() * 0.1));
      }
      ctx.stroke();
    }

    function drawTrunk(ctx, pathFn, pal, U, cx, cy, R, lw) {
      pathFn();
      ctx.fillStyle = css3(pal.a.trunkS);
      ctx.fill();
      ctx.save();
      pathFn(); ctx.clip();
      ctx.fillStyle = css3(pal.a.trunkL);
      ctx.beginPath(); halfPlanePath(ctx, cx, cy, U, R); ctx.fill();
      ctx.restore();
      pathFn();
      ctx.strokeStyle = css3(pal.a.ink);
      ctx.lineWidth = Math.max(0.6, lw * 0.75);
      ctx.stroke();
    }

    // =========================================================================
    // СПРАЙТЫ
    // =========================================================================
    function buildDecid(w, v, o, pal, U, ext, cut, noStroke, partialStroke) {
      const r = w * 0.5;
      const pad = 4;
      const factor = CANOPY_DEV_CONFIG.geometry.strokeWidthFactor || 0.05;
      const lw = clamp(w * factor, 0.7, 3.5);
      const detail = w >= 15;
      const seed = 1000 + v * 131 + Math.round(w) * 7;

      const sp = newSprite(r * 1.25 + pad, r * 1.25 + pad, r * 1.75 + pad, r * (ext === 'mound' ? 1.0 : 0.6) + pad);
      const ctx = sp.ctx;
      const a = pal.a;

      const birch = ext === 'birch';
      const cy = -r * 0.72, rx = r * (birch ? 0.58 : 0.68), ry = r * (birch ? 0.66 : 0.62);
      const topY = cy + ry * 0.55, baseY = r * 0.3;
      const tw = Math.max(0.6, r * (birch ? 0.055 : 0.07)), bw = tw * 1.9;

      contactShadow(ctx, 0, baseY, r, pal, o);

      const trunkPath = () => {
        ctx.beginPath();
        ctx.moveTo(-tw, topY);
        ctx.quadraticCurveTo(-tw * 0.9, (topY + baseY) * 0.5, -bw, baseY);
        ctx.lineTo(bw, baseY);
        ctx.quadraticCurveTo(tw * 0.9, (topY + baseY) * 0.5, tw, topY);
        ctx.closePath();
      };
      if (birch) {
        const tl = [0.90 * a.top[0] + 0.1, 0.88 * a.top[1] + 0.1, 0.82 * a.top[2] + 0.1];
        ctx.save();
        trunkPath();
        ctx.fillStyle = css3(clamp3([tl[0] * 0.8, tl[1] * 0.8, tl[2] * 0.78]));
        ctx.fill();
        ctx.clip();
        ctx.fillStyle = css3(clamp3(tl));
        ctx.beginPath(); halfPlanePath(ctx, 0, (topY + baseY) / 2, U, r * 1.5); ctx.fill();
        ctx.restore();
        trunkPath();
        ctx.strokeStyle = css3(a.ink);
        ctx.lineWidth = Math.max(0.6, lw * 0.75);
        ctx.stroke();
        const rr = rng(seed + 5);
        ctx.strokeStyle = css3(a.ink);
        ctx.lineWidth = Math.max(0.55, lw * 0.7);
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const yy = topY + (baseY - topY) * (0.18 + 0.27 * i + rr() * 0.08);
          ctx.moveTo(-tw * 0.8, yy); ctx.lineTo(-tw * 0.1, yy + 0.4);
        }
        ctx.stroke();
      } else {
        drawTrunk(ctx, trunkPath, pal, U, 0, (topY + baseY) / 2, r * 1.5, lw);
      }

      if (ext === 'mound') drawMound(ctx, 0, baseY + r * 0.02, r * 0.78, r * 0.30, pal, U, lw, seed);
      if (ext === 'rocks') {
        drawRock(ctx, -r * 0.34, baseY + r * 0.06, r * 0.17, pal, U, lw, seed + 1);
        drawRock(ctx, r * 0.30, baseY + r * 0.09, r * 0.12, pal, U, lw, seed + 2);
      }

      // Вызовы drawBump с передачей volumetric: o.volumetric
      if (w >= 28 && !birch) {
        const sgn = hash2(v, Math.round(w), 4) > 0.5 ? 1 : -1;
        drawBump(ctx, sgn * rx * 0.62, cy + ry * 0.28, rx * 0.62, ry * 0.60, lobeCount(w * 0.6), seed + 13, pal, U, { 
          lw, detail, flat: true, cut, volumetric: o.volumetric,
          noStroke: !!noStroke,
          partialStroke: !!partialStroke
        });
      }
      drawBump(ctx, 0, cy, rx, ry, lobeCount(w), seed, pal, U, { 
        lw, detail, flat: true, cut, volumetric: o.volumetric,
        noStroke: !!noStroke,
        partialStroke: !!partialStroke
      });

      if (detail) {
        const rnd = rng(seed + 3);
        ctx.strokeStyle = css3(a.ink);
        ctx.lineWidth = Math.max(0.55, lw * 0.7);
        ctx.beginPath();
        const marks = w >= 28 ? 3 : 2;
        for (let m = 0; m < marks; m++) {
          const rr = rx * (0.26 + rnd() * 0.14);
          const mxp = (rnd() - 0.75) * rx * 0.9;
          const myp = cy - ry * 0.45 + m * ry * 0.5 + rnd() * ry * 0.12;
          const a0 = Math.PI * (0.95 + rnd() * 0.45);
          ctx.moveTo(mxp + Math.cos(a0) * rr, myp + Math.sin(a0) * rr);
          ctx.arc(mxp, myp, rr, a0, a0 + Math.PI * (0.45 + rnd() * 0.2));
        }
        ctx.stroke();
      }

      if (ext === 'grass') {
        grassTufts(ctx, [-r * 0.38, r * 0.34, -r * 0.12], baseY + 1, r * 0.34, pal, lw, seed);
      } else if (detail && r >= 9 && !ext) {
        grassTufts(ctx, [-r * 0.34, r * 0.34], baseY + 1, r * 0.20, pal, lw, seed);
      }
      return sp;
    }

    function drawConifer(ctx, r, T, seed, pal, U, lw, detail, ext, cut, o) {
      const rnd = rng(seed);
      const a = pal.a;
      const cc = CANOPY_DEV_CONFIG.conifer;
      const yTip = -(cc.heightRatio || 1.6) * r, yB = 0.06 * r;
      const span = yB - yTip;
      const hwMax = (cc.widthRatio || 0.74) * r;
      const shadeSign = U.x >= 0 ? -1 : 1;
      const vol = (o && o.volumetric !== undefined) ? o.volumetric : 1.0;
      const curve = cc.slopeConcave !== undefined ? cc.slopeConcave : 0.30;
      const overlap = cc.tierOverlap !== undefined ? cc.tierOverlap : 0.86;
      const scallop = cc.scallopDepth !== undefined ? cc.scallopDepth : 0.32;
      const shadeMul = cc.shadeMul !== undefined ? cc.shadeMul : 1.0;
      const hatchA = cc.hatchAlpha !== undefined ? cc.hatchAlpha : 0.75;

      const trunkPath = () => { ctx.beginPath(); ctx.rect(-r * 0.07, yB - r * 0.1, r * 0.14, r * 0.4); };
      drawTrunk(ctx, trunkPath, pal, U, 0, yB + r * 0.1, r, lw);

      if (ext === 'mound') drawMound(ctx, 0, yB + r * 0.24, r * 0.8, r * 0.30, pal, U, lw, seed);

      const tiers = [];
      for (let i = 0; i < T; i++) {
        const t1 = (i + 1) / T;
        const top = yTip + span * (i / T) * overlap;
        const bot = yTip + span * t1;
        const hwR = hwMax * (0.40 + 0.60 * t1) * (0.94 + rnd() * 0.12);
        const hwL = hwMax * (0.40 + 0.60 * t1) * (0.94 + rnd() * 0.12);
        tiers.push({ top, bot, hwL, hwR, k: (hwL + hwR) > r * 1.1 ? 3 : 2 });
      }

      const tierPath = (t) => {
        const mid = t.top + (t.bot - t.top) * 0.55;
        const depth = ((t.hwL + t.hwR) / t.k) * scallop;
        ctx.beginPath();
        ctx.moveTo(0, t.top);
        ctx.quadraticCurveTo(t.hwR * curve, mid, t.hwR, t.bot);
        const total = t.hwR + t.hwL;
        for (let s = 0; s < t.k; s++) {
          const x0 = t.hwR - total * (s / t.k);
          const x1 = t.hwR - total * ((s + 1) / t.k);
          ctx.quadraticCurveTo((x0 + x1) / 2, t.bot + depth * 1.6, x1, t.bot);
        }
        ctx.quadraticCurveTo(-t.hwL * curve, mid, 0, t.top);
        ctx.closePath();
        return depth;
      };

      for (let i = T - 1; i >= 0; i--) {
        const t = tiers[i];
        const depth = tierPath(t);
        const hw = Math.max(t.hwL, t.hwR);
        const midY = (t.top + t.bot) * 0.5;

        const tierNorm = (i + 0.5) / T;
        const isTierLit = (cut === undefined || cut < 0 || cut === 5)
          ? true
          : (cut === 0 ? false : tierNorm <= (cut / 5.0));

        if (vol <= 0.02) {
          ctx.fillStyle = css3(a.mid);
        } else {
          const g = ctx.createLinearGradient(
            U.x * hw * vol,
            midY + U.y * (t.bot - t.top) * 0.5 * vol,
            -U.x * hw * vol,
            midY - U.y * (t.bot - t.top) * 0.5 * vol
          );
          if (isTierLit) {
            g.addColorStop(0, css3(mix3(a.mid, a.top, vol)));
            g.addColorStop(0.55, css3(a.mid));
            g.addColorStop(1, css3(mix3(a.mid, a.bot, vol)));
          } else {
            g.addColorStop(0, css3(a.mid));
            g.addColorStop(0.55, css3(mix3(a.mid, a.bot, vol)));
            g.addColorStop(1, css3(mul3(a.bot, 0.75)));
          }
          ctx.fillStyle = g;
        }
        ctx.fill();

        if (vol > 0.02) {
          ctx.save();
          ctx.clip();

          if (pal.hiA > 0.03 && isTierLit) {
            ctx.fillStyle = css3(a.hi, pal.hiA * 0.8 * vol);
            ctx.beginPath();
            ctx.moveTo(0, t.top);
            ctx.lineTo(-shadeSign * hw * 0.95, t.bot + depth);
            ctx.lineTo(-shadeSign * hw * 0.25, t.bot + depth);
            ctx.closePath();
            ctx.fill();
          }

          const rx0 = shadeSign > 0 ? hw * 0.04 : -hw * 1.6;
          ctx.fillStyle = css3(a.ink, clamp(pal.shadeA * shadeMul * vol, 0, 0.95));
          ctx.fillRect(rx0, t.top - 2, hw * 1.6, t.bot - t.top + depth * 2 + 4);

          const dCfg = CANOPY_DEV_CONFIG.dappledLight;
          if (dCfg.enabled && dCfg.coniferSparkles && isTierLit) {
            const sparkleAlpha = clamp(dCfg.spotOpacity * 1.1 * vol * (0.4 + pal.lit * 0.6), 0.1, 0.95);
            ctx.fillStyle = css3(a.hi, sparkleAlpha);
            const tRnd = rng(seed + i * 47);
            const nSp = dCfg.coniferSparkleCount;
            for (let k = 0; k < nSp; k++) {
              const spX = (tRnd() - 0.5) * hw * 1.35;
              const spY = t.bot - tRnd() * (t.bot - t.top) * 0.45;
              ctx.beginPath();
              ctx.ellipse(spX, spY, Math.max(0.9, hw * 0.14), Math.max(0.6, (t.bot - t.top) * 0.20), tRnd() * 0.4, 0, TWO_PI);
              ctx.fill();
            }
          }

          const rCfg = CANOPY_DEV_CONFIG.roughness;
          if (rCfg.enabled && hw > 3.0) {
            const rRnd = rng(seed + i * 61);
            const dots = Math.max(2, Math.floor(hw * 1.2 * rCfg.density));
            ctx.fillStyle = css3(a.ink, clamp(rCfg.darkNoiseOpacity * 1.2 * vol, 0.05, 0.8));
            ctx.beginPath();
            for (let k = 0; k < dots; k++) {
              const dx = (rRnd() - 0.5) * hw * 1.5;
              const dy = t.top + rRnd() * (t.bot - t.top + depth);
              ctx.moveTo(dx + 0.7, dy);
              ctx.arc(dx, dy, 0.7, 0, TWO_PI);
            }
            ctx.fill();
          }

          if (detail && vol > 0.15 && pal.lit > 0.08 && hatchA > 0.01) {
            ctx.beginPath();
            ctx.rect(rx0, t.top - 2, hw * 1.6, t.bot - t.top + depth * 2 + 4);
            ctx.clip();
            ctx.strokeStyle = css3(a.ink, clamp(hatchA * vol * pal.lit, 0, 1));
            ctx.lineWidth = Math.max(0.5, lw * 0.6);
            const gap = Math.max(2.1, r * 0.19);
            ctx.beginPath();
            const h = t.bot - t.top + depth * 2;
            for (let d = -h; d < hw * 1.5; d += gap) {
              ctx.moveTo(shadeSign * d, t.top - 1);
              ctx.lineTo(shadeSign * (d + h * 0.9), t.top + h);
            }
            ctx.stroke();
          }

          ctx.restore();
        }

        if (!o.noStroke) {
          tierPath(t);
          ctx.strokeStyle = css3(a.ink);
          ctx.lineWidth = lw;
          ctx.stroke();
        } else if (o.partialStroke) {
          const pCfg = CANOPY_DEV_CONFIG.clustering;
          const alpha = (pCfg.innerStrokeAlpha !== undefined ? pCfg.innerStrokeAlpha : 0.75);
          const lwMul = pCfg.innerStrokeScale !== undefined ? pCfg.innerStrokeScale : 1.1;

          ctx.save();
          ctx.beginPath();
          const clipY = t.top + (t.bot - t.top) * 0.40;
          ctx.rect(-hw * 1.5, clipY, hw * 3.0, (t.bot - clipY) + depth * 2.5);
          ctx.clip();

          tierPath(t);
          ctx.strokeStyle = css3(a.ink, alpha);
          ctx.lineWidth = Math.max(0.7, lw * lwMul);
          ctx.stroke();
          ctx.restore();
        }

        if (pal.rimA > 0.04 && isTierLit && vol > 0.05) {
          ctx.save();
          ctx.beginPath(); halfPlanePath(ctx, 0, midY, U, hw * 1.8); ctx.clip();
          tierPath(t);
          ctx.strokeStyle = css3(a.rim, pal.rimA * vol);
          ctx.lineWidth = Math.max(0.6, lw * 0.7);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    function buildConifer(w, v, o, pal, U, ext, cut, noStroke, partialStroke) {
      const cc = CANOPY_DEV_CONFIG.conifer;
      w = w * (cc.sizeScale || 1.0);
      const r = w * 0.5;
      const T = clamp((r < 6 ? 2 : (r < 12 ? 3 : 4)) + (cc.tierCountBias || 0), 2, 6);
      const pad = 4;
      const factor = CANOPY_DEV_CONFIG.geometry.strokeWidthFactor || 0.05;
      const lw = clamp(w * factor * (cc.strokeWidthMul || 1.0), 0.5, 4.0);
      const detail = w >= 15;
      const seed = 1000 + v * 131 + Math.round(w) * 7;
      const sp = newSprite(r * 1.1 + pad, r * 1.1 + pad, r * 1.75 + pad, r * (ext === 'mound' ? 0.95 : 0.55) + pad);
      const ctx = sp.ctx;

      contactShadow(ctx, 0, r * 0.28, r, pal, o);

      const coniferOpts = Object.assign({}, o, { noStroke: !!noStroke, partialStroke: !!partialStroke });
      drawConifer(ctx, r, T, seed, pal, U, lw, detail, ext, cut, coniferOpts);

      if (ext === 'rocks') {
        drawRock(ctx, -r * 0.40, r * 0.30, r * 0.16, pal, U, lw, seed + 1);
        drawRock(ctx, r * 0.36, r * 0.33, r * 0.11, pal, U, lw, seed + 2);
      }
      if (ext === 'grass') grassTufts(ctx, [-r * 0.42, r * 0.38, r * 0.0], r * 0.3, r * 0.32, pal, lw, seed);
      else if (detail && r >= 9 && !ext) grassTufts(ctx, [-r * 0.34, r * 0.34], r * 0.3, r * 0.20, pal, lw, seed);
      return sp;
    }

    const TUFT_PAT = [
      [[0.00, -0.05, 1.00], [-0.58, 0.20, 0.62], [0.58, 0.22, 0.66], [0.05, -0.52, 0.56]],
      [[-0.30, 0.00, 0.85], [0.38, 0.05, 0.80], [0.00, -0.45, 0.62], [0.70, 0.30, 0.45], [-0.75, 0.30, 0.45]],
      [[0.00, 0.00, 1.00], [-0.65, 0.10, 0.58], [0.62, -0.08, 0.60]],
      [[-0.20, -0.20, 0.80], [0.50, 0.10, 0.75], [-0.50, 0.35, 0.55], [0.10, 0.40, 0.55]]
    ];

    function buildTuft(w, v, o, pal, U, cut, noStroke, partialStroke, z) {
      // Получаем адаптивный радиус куртины для конкретного зума
      const zoomParams = getZoomAdaptiveParams(z !== undefined ? z : 13);
      const R = zoomParams.tuftRadiusRatio * w;
      
      const pad = 6;
      const cl = CANOPY_DEV_CONFIG.clustering;
      const factor = (CANOPY_DEV_CONFIG.geometry.strokeWidthFactor || 0.05) * 0.9;
      const lw = clamp(w * factor * (cl.tuftStrokeScale ?? 1.0), 0.35, 5.0);
      const detail = w >= 13;
      const seed = 5000 + v * 131 + Math.round(w * 2) * 13;

      
      
      const sp = newSprite(R * 2.0 + pad, R * 2.0 + pad, R * 2.1 + pad, R * 1.3 + pad);
      const ctx = sp.ctx;
      const rnd = rng(seed);
      const pat = TUFT_PAT[v & 3];


      const lobes = pat.map((p, i) => ({
        x: p[0] * R,
        y: -R * 0.45 + p[1] * R,
        r: R * p[2] * (0.94 + rnd() * 0.12),
        i
      }));

      const groundY = R * 0.55;
      contactShadow(ctx, 0, groundY, R * 1.4, pal, o);

      const bottomLobes = lobes.slice().sort((a, b) => b.y - a.y);
      const trunkLobes = bottomLobes.slice(0, 2);

      for (let k = 0; k < trunkLobes.length; k++) {
        const lb = trunkLobes[k];
        if (lb.y > -R * 0.35) {
          const tx = lb.x + (rnd() - 0.5) * lb.r * 0.3;
          const tyTop = lb.y + lb.r * 0.3;
          const tyBot = groundY;
          const tw = Math.max(0.9, lb.r * 0.10);

          const trunkPath = () => {
            ctx.beginPath();
            ctx.moveTo(tx - tw * 0.7, tyTop);
            ctx.lineTo(tx - tw * 1.2, tyBot);
            ctx.lineTo(tx + tw * 1.2, tyBot);
            ctx.lineTo(tx + tw * 0.7, tyTop);
            ctx.closePath();
          };
          drawTrunk(ctx, trunkPath, pal, U, tx, (tyTop + tyBot) / 2, lb.r, lw);
        }
      }

      ctx.fillStyle = css3(mul3(pal.a.bot, 0.82));
      for (const l of lobes) {
        lobedPath(ctx, l.x, l.y + l.r * 0.06, l.r * 1.06, l.r * 0.92, lobeCount(l.r * 2.2), seed + l.i * 17, 0, true);
        ctx.fill();
      }

      lobes.sort((p, q) => p.y - q.y);
      for (const l of lobes) {
        drawBump(ctx, l.x, l.y, l.r * 0.95, l.r * 0.82, lobeCount(l.r * 2.2), seed + l.i * 17, pal, U, {
          lw, detail, flat: l.y > -R * 0.2, cut, volumetric: o.volumetric,
          noStroke: !!noStroke,
          partialStroke: !!partialStroke,
          strokeAlpha: cl.tuftStrokeAlpha ?? 1.0,
          shadowStrokeBoost: cl.tuftShadowStroke ?? 0.6
        });
      }

      if (detail) {
        grassTufts(ctx, [-R * 0.5, 0, R * 0.5], groundY, R * 0.22, pal, lw, seed);
      }

      return sp;
    }

    function buildConiferTuft(w, v, o, pal, U, cut, noStroke, partialStroke, z) {
      const cc = CANOPY_DEV_CONFIG.conifer;
      w = w * (cc.sizeScale || 1.0);
      const zoomParams = getZoomAdaptiveParams(z !== undefined ? z : 13);
      const R = zoomParams.tuftRadiusRatio * w;
      const pad = 6;
      const factor = (CANOPY_DEV_CONFIG.geometry.strokeWidthFactor || 0.05) * 0.9;
      const lw = clamp(w * factor * (cc.strokeWidthMul || 1.0), 0.5, 4.0);
      const detail = w >= 13;
      const seed = 6000 + v * 131 + Math.round(w * 2) * 13;
      
      // Увеличиваем высоту спрайта, чтобы верхушки елей не обрезались
      const sp = newSprite(R * 2.2 + pad, R * 2.2 + pad, R * 2.5 + pad, R * 1.5 + pad);
      const ctx = sp.ctx;
      const rnd = rng(seed);
      const groundY = R * 0.55;
      
      contactShadow(ctx, 0, groundY, R * 1.3, pal, o);

      // Композиция из трех деревьев: 
      // 1. Высокая ель (по центру), 2. Сосна с шапкой (сбоку), 3. Маленькая ель (сзади)
      const trees = [
        { type: 'spruce', r: R * 0.85, x: 0, y: groundY, T: 4 },
        { type: 'pine', r: R * 0.65, x: (rnd() - 0.5) * R * 1.2, y: groundY - R * 0.4, T: 7 },
        { type: 'spruce', r: R * 0.6, x: (rnd() - 0.5) * R * 1.2, y: groundY - R * 0.1, T: 3 }
      ];

      // Сортируем по Y, чтобы задние деревья рисовались первыми
      trees.sort((a, b) => a.y - b.y);

      for (const t of trees) {
        ctx.save();
        ctx.translate(t.x, t.y);
        
        if (t.type === 'spruce') {
          // Рисуем ель (ярусное дерево)
          drawConifer(ctx, t.r, t.T, seed + (t.x * 100 | 0), pal, U, lw, detail, null, cut, { noStroke, partialStroke, volumetric: o.volumetric });
        } else {
          // Рисуем сосну (ствол + круглая шапка, как у лиственных)
          const tw = Math.max(1.2, t.r * 0.1);
          const topY = -t.r * 0.4; 
          const baseY = 0;
          
          // Ствол сосны
          const trunkPath = () => {
            ctx.beginPath();
            ctx.moveTo(-tw, baseY);
            ctx.lineTo(tw, baseY);
            ctx.lineTo(tw * 0.7, topY);
            ctx.lineTo(-tw * 0.7, topY);
            ctx.closePath();
          };
          drawTrunk(ctx, trunkPath, pal, U, 0, (topY + baseY) / 2, t.r * 1.5, lw);

          // Шапка сосны (используем drawBump от лиственных, но с хвойной палитрой)
          drawBump(ctx, 0, -t.r * 0.8, t.r * 0.8, t.r * 0.6, t.T, seed + (t.x * 100 | 0), pal, U, { 
              lw, detail, flat: true, cut, volumetric: o.volumetric, noStroke, partialStroke 
          });
        }
        ctx.restore();
      }

      if (detail) {
        grassTufts(ctx, [-R * 0.5, 0, R * 0.5], groundY, R * 0.22, pal, lw, seed);
      }
      return sp;
    }

    function conMergeVariant(t) {
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      const treeZ = t.hz !== undefined ? t.hz : 13;
      const hideRate = getZoomAdaptiveParams(treeZ).coniferHideRate;
      const h = hash2(t.cx, t.cy, 131);
      if (h < hideRate) return -1;                          // только подлесок
      const k = (h - hideRate) / Math.max(0.001, 1 - hideRate);
      if (k < cm.pawRate) return 3;                         // низкая «лапа»
      const q = (k - cm.pawRate) / Math.max(0.001, 1 - cm.pawRate);
      return q < 0.42 ? 0 : (q < 0.80 ? 1 : 2);             // короткая / средняя / высокая
    }

    function carpetColor(pal) {
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      return mul3(mix3(pal.a.bot, pal.a.mid, cm.carpetMidMix), cm.carpetDarkness);
    }

    // Холмик с пилообразной (хвойной) верхней кромкой
    function spikyMassPath(ctx, cx, cy, rx, ry, seed, n, openBottom = false) {
      const rnd = rng(seed);
      const x0 = cx - rx, x1 = cx + rx, step = (x1 - x0) / n;
      const vy = (u) => cy - ry * (0.08 + 0.42 * Math.sin(u * Math.PI));
      ctx.beginPath();
      ctx.moveTo(x0, cy + ry * 0.55);
      for (let i = 0; i < n; i++) {
        const xa = x0 + step * i;
        const xm = xa + step * (0.3 + rnd() * 0.4);
        ctx.lineTo(xa, vy(i / n));
        ctx.lineTo(xm, vy((i + 0.5) / n) - ry * (0.28 + rnd() * 0.40));
      }
      ctx.lineTo(x1, vy(1));
      ctx.lineTo(x1, cy + ry * 0.55);
      if (!openBottom) {
        ctx.quadraticCurveTo(cx, cy + ry * 0.95, x0, cy + ry * 0.55);
        ctx.closePath();
      }
    }

    function drawConiferPeak(ctx, p) {
      const { r, H, hw, T, seed, pal, U, lw, detail, cut, vol } = p;
      const a = pal.a;
      const rnd = rng(seed);
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      const cc = CANOPY_DEV_CONFIG.conifer;
      const yTip = -H, yB = r * 0.12, span = yB - yTip;
      const shadeSign = U.x >= 0 ? -1 : 1;
      const dCfg = CANOPY_DEV_CONFIG.dappledLight;
      const rCfg = CANOPY_DEV_CONFIG.roughness;
      const curve = cc.slopeConcave !== undefined ? cc.slopeConcave : 0.30;
      const overlap = cc.tierOverlap !== undefined ? cc.tierOverlap : 0.80;
      const scallop = cc.scallopDepth !== undefined ? cc.scallopDepth : 0.32;
      const shadeMul = cc.shadeMul !== undefined ? cc.shadeMul : 1.0;
      const hatchA = cc.hatchAlpha !== undefined ? cc.hatchAlpha : 0.75;
      const openBottom = cm.openBottom !== false;

      const tiers = [];
      for (let i = 0; i < T; i++) {
        const t1 = (i + 1) / T;
        const k = 0.40 + 0.60 * t1;
        const hwR = hw * k * (0.92 + rnd() * 0.16);
        const hwL = hw * k * (0.92 + rnd() * 0.16);
        tiers.push({
          top: yTip + span * (i / T) * overlap,
          bot: yTip + span * t1,
          hwL, hwR, k: (hwL + hwR) > r * 1.05 ? 3 : 2
        });
      }

      const tierPath = (t, open) => {
        const mid = t.top + (t.bot - t.top) * 0.55;
        const depth = ((t.hwL + t.hwR) / t.k) * scallop;
        ctx.beginPath();
        if (open) {
          ctx.moveTo(t.hwR, t.bot);
          ctx.quadraticCurveTo(t.hwR * curve, mid, 0, t.top);
          ctx.quadraticCurveTo(-t.hwL * curve, mid, -t.hwL, t.bot);
          return depth;
        }
        ctx.moveTo(0, t.top);
        ctx.quadraticCurveTo(t.hwR * curve, mid, t.hwR, t.bot);
        const total = t.hwR + t.hwL;
        for (let s = 0; s < t.k; s++) {
          const x0 = t.hwR - total * (s / t.k);
          const x1 = t.hwR - total * ((s + 1) / t.k);
          ctx.quadraticCurveTo((x0 + x1) / 2, t.bot + depth * 1.6, x1, t.bot);
        }
        ctx.quadraticCurveTo(-t.hwL * curve, mid, 0, t.top);
        ctx.closePath();
        return depth;
      };

      for (let i = T - 1; i >= 0; i--) {
        const t = tiers[i];
        const depth = tierPath(t, false);
        const hwm = Math.max(t.hwL, t.hwR);
        const midY = (t.top + t.bot) * 0.5;
        const tierNorm = (i + 0.5) / T;
        const isLit = (cut === undefined || cut < 0 || cut === 5) ? true : (cut === 0 ? false : tierNorm <= cut / 5.0);

        if (vol <= 0.02) {
          ctx.fillStyle = css3(a.mid);
        } else {
          const g = ctx.createLinearGradient(
            U.x * hwm * vol, midY + U.y * (t.bot - t.top) * 0.5 * vol,
            -U.x * hwm * vol, midY - U.y * (t.bot - t.top) * 0.5 * vol
          );
          if (isLit) {
            g.addColorStop(0, css3(mix3(a.mid, a.top, vol)));
            g.addColorStop(0.55, css3(a.mid));
            g.addColorStop(1, css3(mix3(a.mid, a.bot, vol)));
          } else {
            g.addColorStop(0, css3(a.mid));
            g.addColorStop(0.55, css3(mix3(a.mid, a.bot, vol)));
            g.addColorStop(1, css3(mul3(a.bot, 0.75)));
          }
          ctx.fillStyle = g;
        }
        ctx.fill();

        if (vol > 0.02) {
          ctx.save();
          ctx.clip();
          if (pal.hiA > 0.03 && isLit) {
            ctx.fillStyle = css3(a.hi, pal.hiA * 0.8 * vol);
            ctx.beginPath();
            ctx.moveTo(0, t.top);
            ctx.lineTo(-shadeSign * hwm * 0.95, t.bot + depth);
            ctx.lineTo(-shadeSign * hwm * 0.25, t.bot + depth);
            ctx.closePath();
            ctx.fill();
          }
          const rx0 = shadeSign > 0 ? hwm * 0.04 : -hwm * 1.6;
          ctx.fillStyle = css3(a.ink, clamp(pal.shadeA * shadeMul * vol, 0, 0.95));
          ctx.fillRect(rx0, t.top - 2, hwm * 1.6, t.bot - t.top + depth * 2 + 4);

          if (dCfg.enabled && dCfg.coniferSparkles && isLit && hwm > 3) {
            const sr = rng(seed + i * 47);
            ctx.fillStyle = css3(a.hi, clamp(dCfg.spotOpacity * vol * (0.4 + pal.lit * 0.6), 0.1, 0.95));
            for (let k = 0; k < Math.min(4, dCfg.coniferSparkleCount); k++) {
              ctx.beginPath();
              ctx.ellipse((sr() - 0.5) * hwm * 1.2, t.bot - sr() * (t.bot - t.top) * 0.45,
                Math.max(0.9, hwm * 0.14), Math.max(0.6, (t.bot - t.top) * 0.20), sr() * 0.4, 0, TWO_PI);
              ctx.fill();
            }
          }
          if (rCfg.enabled && hwm > 3.0) {
            const rr = rng(seed + i * 61);
            const dots = Math.max(2, Math.floor(hwm * 1.0 * rCfg.density));
            ctx.fillStyle = css3(a.ink, clamp(rCfg.darkNoiseOpacity * 1.1 * vol, 0.05, 0.8));
            ctx.beginPath();
            for (let k = 0; k < dots; k++) {
              const dx = (rr() - 0.5) * hwm * 1.5;
              const dy = t.top + rr() * (t.bot - t.top + depth);
              ctx.moveTo(dx + 0.7, dy);
              ctx.arc(dx, dy, 0.7, 0, TWO_PI);
            }
            ctx.fill();
          }
          if (detail && vol > 0.15 && pal.lit > 0.08 && hatchA > 0.01) {
            ctx.beginPath();
            ctx.rect(rx0, t.top - 2, hwm * 1.6, t.bot - t.top + depth * 2 + 4);
            ctx.clip();
            ctx.strokeStyle = css3(a.ink, clamp(hatchA * vol * pal.lit, 0, 1));
            ctx.lineWidth = Math.max(0.5, lw * 0.6);
            const gap = Math.max(2.1, r * 0.19);
            const h = t.bot - t.top + depth * 2;
            ctx.beginPath();
            for (let d = -h; d < hwm * 1.5; d += gap) {
              ctx.moveTo(shadeSign * d, t.top - 1);
              ctx.lineTo(shadeSign * (d + h * 0.9), t.top + h);
            }
            ctx.stroke();
          }
          ctx.restore();
        }

        const isOpen = openBottom && (i === T - 1);
        tierPath(t, isOpen);
        ctx.strokeStyle = css3(a.ink);
        ctx.lineWidth = lw;
        ctx.stroke();

        if (pal.rimA > 0.04 && isLit && vol > 0.05) {
          ctx.save();
          ctx.beginPath(); halfPlanePath(ctx, 0, midY, U, hwm * 1.8); ctx.clip();
          tierPath(t, isOpen);
          ctx.strokeStyle = css3(a.rim, pal.rimA * vol);
          ctx.lineWidth = Math.max(0.6, lw * 0.7);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    function buildConiferMerged(t, variant, o, pal, U, cut) {
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      const cc = CANOPY_DEV_CONFIG.conifer;
      const w = t.b * (cc.sizeScale || 1.0), v = t.v & 3;
      const r = w * 0.5;
      variant = Math.max(0, variant);
      const seed = 7000 + v * 131 + Math.round(t.b * 2) * 13 + variant * 977;
      const jit = 0.90 + rng(seed)() * 0.20;

      let H, hw, T;
      if (variant === 0)      { H = r * 1.30; hw = r * 0.52; T = 2; }
      else if (variant === 1) { H = r * 1.80; hw = r * 0.48; T = 3; }
      else if (variant === 2) { H = r * 2.45; hw = r * 0.44; T = 4; }
      else                    { H = r * 0.95; hw = r * 0.92; T = 2; }
      H *= cm.peakHeight * jit;
      hw *= cm.peakWidth;
      T = clamp(T + (cc.tierCountBias || 0), 2, 6);
      if (r < 5) T = Math.min(T, 2); else if (r < 9) T = Math.min(T, 3);

      const pad = 5;
      const factor = (CANOPY_DEV_CONFIG.geometry.strokeWidthFactor || 0.05) * 0.9;
      const lw = clamp(w * factor * (cc.strokeWidthMul || 1.0), 0.5, 4.0);
      const sp = newSprite(hw * 1.5 + pad, hw * 1.5 + pad, H + pad + 2, r * 0.6 + pad);
      const ctx = sp.ctx;

      if ((cm.skirtAlpha ?? 1.0) > 0.01) {
        ctx.save();
        ctx.globalAlpha = (cm.skirtAlpha ?? 1.0) * 0.72;
        const skirtW = hw * (cm.skirtWidth ?? 1.25);
        const skirtH = r * 0.32;
        const cBase = carpetColor(pal);
        const sg = ctx.createLinearGradient(0, r * 0.02 - skirtH, 0, r * 0.02 + skirtH);
        sg.addColorStop(0, css3(cBase, 0.85));
        sg.addColorStop(0.7, css3(mul3(cBase, 0.75), 0.5));
        sg.addColorStop(1, css3(mul3(cBase, 0.65), 0.0)); // низ плавно растворяется в карту!
        ctx.fillStyle = sg;
        spikyMassPath(ctx, 0, r * 0.02, skirtW, skirtH, seed + 3, 5);
        ctx.fill();

        // Лёгкие отдельные травинки по бокам юбки вместо сплошной толстой обводки
        const sr = rng(seed + 11);
        ctx.strokeStyle = css3(mul3(pal.a.ink, 0.45), clamp(cm.carpetStrokeAlpha * 0.65, 0, 1));
        ctx.lineWidth = Math.max(0.65, t.b * 0.032 * (cc.strokeWidthMul || 1.0));
        ctx.beginPath();
        for (let b = 0; b < 5; b++) {
          const bx = (b / 4 - 0.5) * skirtW * 1.6 + (sr() - 0.5) * skirtW * 0.2;
          const by = r * 0.02 + sr() * skirtH * 0.35;
          const bh = skirtH * (0.45 + sr() * 0.45);
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + (bx < 0 ? -1 : 1) * bh * 0.45, by - bh);
        }
        ctx.stroke();
        ctx.restore();
      }

      drawConiferPeak(ctx, {
        r, H, hw, T, seed, pal, U, lw, detail: w >= 13, cut,
        vol: (o.volumetric !== undefined) ? o.volumetric : 1.0
      });
      return sp;
    }

    

    function buildStump(w, v, o, pal, U) {
      const r = w * 0.5, pad = 4, lw = clamp(w * 0.05, 0.9, 2.0);
      const seed = 7000 + v * 131 + Math.round(w) * 3;
      const sr = Math.max(2.2, r * 0.34), sh = Math.max(2.4, r * 0.40);
      const sp = newSprite(sr * 2.2 + pad, sr * 2.2 + pad, sh + sr * 1.2 + pad, sr * 0.9 + pad);
      const ctx = sp.ctx, a = pal.a;

      contactShadow(ctx, 0, 0, r * 0.9, pal, o);
      const body = () => {
        ctx.beginPath();
        ctx.moveTo(-sr, 0);
        ctx.lineTo(-sr * 0.9, -sh);
        ctx.lineTo(sr * 0.9, -sh);
        ctx.lineTo(sr, 0);
        ctx.ellipse(0, 0, sr, sr * 0.34, 0, 0, Math.PI);
        ctx.closePath();
      };
      drawTrunk(ctx, body, pal, U, 0, -sh * 0.5, sr * 2, lw);

      ctx.beginPath(); ctx.ellipse(0, -sh, sr * 0.9, sr * 0.34, 0, 0, TWO_PI);
      ctx.fillStyle = css3(mix3(a.trunkL, [0.85, 0.72, 0.5], 0.45));
      ctx.fill();
      ctx.strokeStyle = css3(a.ink); ctx.lineWidth = Math.max(0.6, lw * 0.75); ctx.stroke();
      ctx.lineWidth = Math.max(0.45, lw * 0.5);
      ctx.beginPath(); ctx.ellipse(0, -sh, sr * 0.55, sr * 0.2, 0, 0, TWO_PI);
      ctx.moveTo(sr * 0.22, -sh); ctx.ellipse(0, -sh, sr * 0.22, sr * 0.08, 0, 0, TWO_PI);
      ctx.stroke();

      ctx.strokeStyle = css3(a.ink); ctx.lineWidth = Math.max(0.55, lw * 0.7);
      ctx.beginPath();
      ctx.moveTo(-sr, -sh * 0.1); ctx.lineTo(-sr * 1.35, sr * 0.12);
      ctx.moveTo(sr, -sh * 0.1); ctx.lineTo(sr * 1.3, sr * 0.14);
      ctx.stroke();
      grassTufts(ctx, [-sr * 1.5, sr * 1.55], sr * 0.18, sr * 0.9, pal, lw, seed);
      return sp;
    }

    function buildDead(w, v, o, pal, U) {
      const r = w * 0.5, pad = 5;
      const lw = clamp(w * 0.045, 0.9, 2.0);
      const seed = 8000 + v * 131 + Math.round(w) * 5;
      const rnd = rng(seed);
      const sp = newSprite(r * 1.2 + pad, r * 1.2 + pad, r * 1.9 + pad, r * 0.5 + pad);
      const ctx = sp.ctx, a = pal.a;
      const trunkW = Math.max(1.2, r * 0.13);

      contactShadow(ctx, 0, r * 0.2, r * 0.9, pal, o);

      const branch = (x, y, ang, len, wd, depth) => {
        const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
        ctx.strokeStyle = css3(a.ink);
        ctx.lineWidth = wd + Math.max(0.9, lw * 1.1);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = css3(a.trunkS);
        ctx.lineWidth = wd;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
        if (wd > 1.6) {
          ctx.strokeStyle = css3(a.trunkL);
          ctx.lineWidth = wd * 0.4;
          ctx.beginPath();
          ctx.moveTo(x + U.x * wd * 0.2, y + U.y * wd * 0.2);
          ctx.lineTo(x2 + U.x * wd * 0.2, y2 + U.y * wd * 0.2);
          ctx.stroke();
        }
        if (depth <= 0) return;
        const n = depth >= 2 ? 2 : 2;
        for (let i = 0; i < n; i++) {
          const side = i === 0 ? -1 : 1;
          branch(x2 - Math.cos(ang) * len * (0.25 + 0.2 * i), y2 - Math.sin(ang) * len * (0.25 + 0.2 * i),
            ang + side * (0.45 + rnd() * 0.5), len * (0.55 + rnd() * 0.15), Math.max(0.8, wd * 0.55), depth - 1);
        }
      };

      const lean = (rnd() - 0.5) * 0.25;
      branch(0, r * 0.25, -Math.PI / 2 + lean, r * 1.0, trunkW, 0);
      const ty = r * 0.25 - Math.cos(lean) * r * 1.0;
      const tx = Math.sin(lean) * r * 1.0;
      branch(tx, ty, -Math.PI / 2 + lean - 0.55, r * 0.75, trunkW * 0.7, 2);
      branch(tx, ty, -Math.PI / 2 + lean + 0.5, r * 0.65, trunkW * 0.65, 2);
      branch(tx, ty + r * 0.25, -Math.PI / 2 + lean + 0.9, r * 0.45, trunkW * 0.5, 1);
      grassTufts(ctx, [-r * 0.3, r * 0.3], r * 0.28, r * 0.22, pal, lw, seed);
      return sp;
    }

    function buildBush(w, v, o, pal, U) {
      const r = w * 0.5, pad = 4;
      const lw = clamp(w * 0.045, 0.85, 2.0);
      const seed = 9000 + v * 131 + Math.round(w) * 3;
      const detail = w >= 18;
      const sp = newSprite(r * 1.0 + pad, r * 1.0 + pad, r * 0.9 + pad, r * 0.35 + pad);
      const ctx = sp.ctx;
      contactShadow(ctx, 0, r * 0.12, r * 0.8, pal, o);
      const bp = [[-0.34, -0.22, 0.46], [0.36, -0.20, 0.42], [0.0, -0.46, 0.44]];
      for (let i = 0; i < bp.length; i++) {
        const b = bp[i];
        drawBump(ctx, b[0] * r, b[1] * r, b[2] * r * 0.95, b[2] * r * 0.80, 6, seed + i * 11, pal, U, { lw, detail, flat: true });
      }
      grassTufts(ctx, [-r * 0.62, r * 0.6], r * 0.1, r * 0.22, pal, lw, seed);
      return sp;
    }

    function buildLog(w, v, o, pal, U) {
      const r = w * 0.5, pad = 4;
      const lw = clamp(w * 0.045, 0.85, 2.0);
      const seed = 9500 + v * 131 + Math.round(w) * 3;
      const len = r * 1.2, th = Math.max(2.0, r * 0.22);
      const sp = newSprite(len * 0.7 + th + pad, len * 0.7 + th + pad, th * 2 + pad, th * 0.9 + pad);
      const ctx = sp.ctx, a = pal.a;
      const flip = hash2(v, Math.round(w), 6) > 0.5 ? 1 : -1;
      const body = () => {
        ctx.beginPath();
        ctx.moveTo(-len * 0.5, -th * 0.2);
        ctx.quadraticCurveTo(0, -th * 1.15, len * 0.5, -th * 0.2);
        ctx.lineTo(len * 0.5, th * 0.3);
        ctx.quadraticCurveTo(0, th * 0.55, -len * 0.5, th * 0.3);
        ctx.closePath();
      };
      contactShadow(ctx, 0, th * 0.35, len * 0.7, pal, o);
      ctx.save(); ctx.scale(flip, 1);
      drawTrunk(ctx, body, pal, { x: U.x * flip, y: U.y }, 0, 0, len, lw);
      ctx.beginPath(); ctx.ellipse(len * 0.5, 0.05 * th, th * 0.32, th * 0.52, 0, 0, TWO_PI);
      ctx.fillStyle = css3(mix3(a.trunkL, [0.85, 0.72, 0.5], 0.45));
      ctx.fill();
      ctx.strokeStyle = css3(a.ink); ctx.lineWidth = Math.max(0.55, lw * 0.7); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(len * 0.5, 0.05 * th, th * 0.15, th * 0.28, 0, 0, TWO_PI); ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 3; i++) { const xx = -len * 0.3 + i * len * 0.28; ctx.moveTo(xx, -th * 0.55); ctx.lineTo(xx + len * 0.1, -th * 0.5); }
      ctx.stroke();
      ctx.restore();
      grassTufts(ctx, [-len * 0.55, len * 0.12], th * 0.4, th * 0.9, pal, lw, seed);
      return sp;
    }

    // =========================================================================
    // КЭШ СПРАЙТОВ
    // =========================================================================
    const SPRITE_BYTES_LIMIT = 10 * 1024 * 1024 * TILE_DPR * TILE_DPR;
    const MAX_SPRITE_COUNT = 1200;             // не более 1200 <canvas> в памяти
    let spriteBytes = 0;
    const spriteCache = new Map();


  function buildSprite(t, tuft, st, o, P) {
      const U = P.U;
      const w = t.b;
      const v = t.v & 3;
      const tone = o.colorScatter > 0.05 ? t.tone : 1;
      const deco = t.deco;
      const seedCol = 3000 + v * 17 + Math.round(w);
      const kind = t.kind;
      const cut = st ? st.cut : -1;
      const treeZoom = t.hz !== undefined ? t.hz : 13;
      const zoomParams = getZoomAdaptiveParams(treeZoom);

      // Определение режима контуров для внутреннего дерева
      const isInner = t.isDeepMassif && (t.emask === 0);
      const suppress = CANOPY_DEV_CONFIG.clustering.suppressInnerStrokes !== false;
      let noStroke = false;
      let partialStroke = false;

      if (isInner && suppress) {
        if (kind === 'conifer') {
          // Хвойным ВСЕГДА оставляем нижний контур лап, иначе они теряют форму!
          partialStroke = true;
          noStroke = false;
        } else {
          noStroke = true;
          const pCfg = CANOPY_DEV_CONFIG.clustering;
          if (pCfg.restoreTopArcs !== false) {
            const rate = zoomParams.innerStrokeRate;
            if (hash2(t.cx, t.cy, 99) < rate) {
              partialStroke = true;
            }
          }
        }
      }

      if (tuft) {
        if (kind === 'conifer') {
          if (CANOPY_DEV_CONFIG.coniferMerge.enabled) {
            return buildConiferMerged(t, conMergeVariant(t), o, getPalette(kind, o, seedCol, tone, st, P), U, cut);
          }
          // запасной вариант: старая куртина ель + сосна
          return buildConiferTuft(w, v, o, getPalette(kind, o, seedCol, tone, st, P), U, cut, noStroke, partialStroke, treeZoom);
        } else {
          // Для лиственных оставляем всё как было
          return buildTuft(w, v, o, getPalette(kind, o, seedCol, tone, st, P), U, cut, noStroke, partialStroke, treeZoom);
        }
      }
      
      switch (deco) {
        case 'stump': return buildStump(w, v, o, getPalette('decid', o, seedCol, tone, st, P), U);
        case 'dead': return buildDead(w, v, o, getPalette('decid', o, seedCol, tone, st, P, null, [92, 78, 66], 'dead'), U);
        case 'bush': return buildBush(w, v, o, getPalette('decid', o, seedCol, tone, st, P), U);
        case 'log': return buildLog(w, v, o, getPalette('decid', o, seedCol, tone, st, P), U);
        case 'birch': {
          const alb = o.opaqueFill ? [176, 196, 104] : colorToRgb(o.paper);
          return buildDecid(w, v, o, getPalette('decid', o, seedCol, tone, st, P, alb, null, 'birch'), U, 'birch', cut, noStroke, partialStroke);
        }
        default: {
          const ext = (deco === 'mound' || deco === 'grass' || deco === 'rocks') ? deco : null;
          const pal = getPalette(kind, o, seedCol, tone, st, P);
          return kind === 'conifer' 
            ? buildConifer(w, v, o, pal, U, ext, cut, noStroke, partialStroke) 
            : buildDecid(w, v, o, pal, U, ext, cut, noStroke, partialStroke);
        }
      }
    }

    function getSprite(t, tuft, st, o, P) {
      const tone = o.colorScatter > 0.05 ? t.tone : 1;
      const cutKey = (st && st.cut !== undefined && st.cut >= 0) ? `_c${st.cut}` : '';
      const treeZ = t.hz || 13;
      
      let strokeKey = '';
      if (t.isDeepMassif && t.emask === 0) {
        const pCfg = CANOPY_DEV_CONFIG.clustering;
        const zoomParams = getZoomAdaptiveParams(treeZ);
        if (!pCfg.suppressInnerStrokes) {
          strokeKey = '_fs';
        } else if (pCfg.restoreTopArcs && (hash2(t.cx, t.cy, 99) < zoomParams.innerStrokeRate)) {
          strokeKey = `_ps_${Math.round((pCfg.innerStrokeAlpha ?? 0.7) * 10)}_${Math.round((pCfg.innerTopArcReach ?? 0.15) * 10)}`;
        } else {
          strokeKey = '_ns';
        }
      }

      // Добавлен z:${treeZ} в ключ
      const key = `${tuft ? ('T' + (t.kind === 'conifer' ? conMergeVariant(t) : '')) : (t.deco || 'S')}|z:${treeZ}|${t.kind[0]}|${t.v & 3}|${t.b}|${tone}|${st.lv}${st.gl}${st.rm}${cutKey}${strokeKey}|${P.sprKey}|${o.sprSig}`;
      let sp = spriteCache.get(key);
      if (sp) {
        spriteCache.delete(key);
        spriteCache.set(key, sp);
        return sp;
      }
      sp = buildSprite(t, tuft, st, o, P);
      spriteCache.set(key, sp);
      spriteBytes += sp.bytes;
      while ((spriteBytes > SPRITE_BYTES_LIMIT || spriteCache.size > MAX_SPRITE_COUNT) && spriteCache.size > 1) {
        const k0 = spriteCache.keys().next().value;
        const dead = spriteCache.get(k0);
        if (dead) {
          spriteBytes = Math.max(0, spriteBytes - dead.bytes);
          if (dead.cv) {
            dead.cv.width = 0;
            dead.cv.height = 0;
          }
        }
        spriteCache.delete(k0);
      }
      return sp;
    }


    // =========================================================================
    // ТЕНИ ОТ ДЕРЕВЬЕВ
    // =========================================================================
    function drawGroundShadows(ctx, items, o, P) {
      if (!o.shadows || o.shadowStrength <= 0.01) return;
      
      // Ночью длинные дневные тени гаснут, если нет яркой Луны
      const nightDamp = 1.0 - P.night * 0.85;
      if (nightDamp <= 0.02) return;

      const A = { x: -P.U.x, y: -P.U.y };
      const rot = Math.atan2(A.y, A.x);
      const cosR = Math.cos(rot), sinR = Math.sin(rot);
      const sz = clamp(P.sZ, 0.09, 0.999);
      const cot = clamp(Math.sqrt(1 - sz * sz) / sz, 0.35, 4.5);
      const baseA = 0.34 * clamp(P.I, 0.0, 1.0) * o.shadowStrength * nightDamp;
      if (baseA <= 0.01) return;

      let bestD = 0, bestDot = -9;
      for (let d = 0; d < 8; d++) {
        const dl = Math.hypot(DIRS8[d][0], DIRS8[d][1]);
        const dot = (DIRS8[d][0] * A.x + DIRS8[d][1] * A.y) / dl;
        if (dot > bestDot) { bestDot = dot; bestD = d; }
      }
      const edgeBit = 1 << bestD;

      const strong = [], weak = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const t = it.t, st = t._ls;
        if (!st || st.lv <= 0 || it.hidden) continue;
        if (t.isDeepMassif && !(t.emask & edgeBit)) continue;
        (st.lv >= 4 ? strong : weak).push(it);
      }

      const fillGroup = (group, alpha) => {
        if (!group.length || alpha < 0.01) return;
        for (let pass = 0; pass < 2; pass++) {
          ctx.beginPath();
          for (let i = 0; i < group.length; i++) {
            const it = group[i], t = it.t;
            const r = t.b * 0.5;
            const hgt = (t.deco === 'dead' ? 0.95 : (t.kind === 'conifer' ? 0.85 : 0.72)) * t.b * (t.deco === 'bush' ? 0.4 : 1.0);
            const len = Math.min(hgt * cot * 0.8, t.b * 2.2);
            const major = Math.max(r * 0.8, (len + r * 0.9) * 0.5) * (pass === 0 ? 1.12 : 1.0);
            const minor = Math.max(1.2, r * 0.60) * (pass === 0 ? 1.18 : 1.0);
            const off = major - r * 0.55;
            const cx = it.x + A.x * off, cy = it.y + r * 0.22 + A.y * off * 0.85;
            ctx.moveTo(cx + cosR * major, cy + sinR * major);
            ctx.ellipse(cx, cy, major, minor, rot, 0, TWO_PI);
          }
          ctx.fillStyle = css3(P.shadowTone, pass === 0 ? alpha * 0.45 : alpha * 0.55);
          ctx.fill();
        }
      };
      fillGroup(strong, baseA);
      fillGroup(weak, baseA * 0.5);
    }


    function drawMassifBase(ctx, items, o, P) {
      const cm = CANOPY_DEV_CONFIG.coniferMerge;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (let i = 0; i < items.length; i++) {
        const it = items[i], t = it.t;
        if (!t.isDeepMassif || it.hidden || !t._ls) continue;

        const pal = getPalette(t.kind, o, 3000 + t.tone, o.colorScatter > 0.05 ? t.tone : 1, t._ls, P);

        const darkRate = (CANOPY_DEV_CONFIG.clustering.massifBaseDarkness !== undefined)
          ? CANOPY_DEV_CONFIG.clustering.massifBaseDarkness
          : 0.55;

        if (t.kind === 'conifer' && cm.enabled) {
          const cc = CANOPY_DEV_CONFIG.conifer;
          const isEdge = t.emask !== 0;
          const rx = cm.carpetSize * t.b * (cc.sizeScale || 1.0);
          const ry = rx * (cm.carpetAspect !== undefined ? cm.carpetAspect : 0.62);
          const cyy = it.y - ry * 0.2;
          const seed = ((t.cx * 73856093) ^ (t.cy * 19349663)) >>> 0;
          const r = rng(seed);

          const cBase = carpetColor(pal);
          const darkInk = mul3(pal.a.ink, 0.52);
          const strokeMul = cc.strokeWidthMul || 1.0;

          // Еле заметная мягкая тень/подстилка без контура
          ctx.fillStyle = css3(cBase, isEdge ? 0.16 : 0.34);
          ctx.beginPath();
          ctx.ellipse(it.x, cyy, rx * 0.9, ry * 0.75, 0, 0, TWO_PI);
          ctx.fill();

          // Ажурные кустики хвойного лапника (веерные пучки иголок)
          const clusters = isEdge ? 4 : 6;
          ctx.strokeStyle = css3(darkInk, isEdge ? 0.52 : 0.75);
          ctx.lineWidth = Math.max(0.6, t.b * 0.03 * strokeMul);
          ctx.beginPath();

          for (let c = 0; c < clusters; c++) {
            const cx = it.x + (r() - 0.5) * rx * 1.35;
            const cy = cyy + (r() - 0.4) * ry * 1.05;
            const fan = 3 + ((r() * 2) | 0);
            const sz = rx * (0.22 + r() * 0.18);
            for (let f = 0; f < fan; f++) {
              const a = -Math.PI / 2 + (f - (fan - 1) / 2) * 0.45 + (r() - 0.5) * 0.2;
              ctx.moveTo(cx, cy);
              ctx.lineTo(cx + Math.cos(a) * sz, cy + Math.sin(a) * sz);
            }
          }
          ctx.stroke();

          // Короткая горизонтально-диагональная штриховка почвы (эффект офорта)
          const hatches = isEdge ? 4 : 7;
          ctx.strokeStyle = css3(pal.a.ink, isEdge ? 0.28 : 0.42);
          ctx.lineWidth = Math.max(0.5, t.b * 0.022 * strokeMul);
          ctx.beginPath();
          for (let h = 0; h < hatches; h++) {
            const hx = it.x + (r() - 0.5) * rx * 1.5;
            const hy = cyy + (r() - 0.3) * ry * 1.1;
            const hl = rx * (0.2 + r() * 0.25);
            ctx.moveTo(hx - hl * 0.5, hy + hl * 0.12);
            ctx.lineTo(hx + hl * 0.5, hy - hl * 0.12);
          }
          ctx.stroke();
        } else if (t.kind === 'conifer') {
          const R = 0.30 * t.b;
          ctx.fillStyle = css3(mul3(pal.a.bot, darkRate));
          ctx.beginPath();
          ctx.moveTo(it.x, it.y - R * 1.2);
          ctx.lineTo(it.x + R * 0.8, it.y + R * 0.2);
          ctx.lineTo(it.x - R * 0.8, it.y + R * 0.2);
          ctx.closePath();
          ctx.fill();
        } else {
          // Для лиственных оставляем старую круглую подложку БЕЗ ИЗМЕНЕНИЙ
          const R = 0.48 * t.b;
          ctx.fillStyle = css3(mul3(pal.a.bot, darkRate));
          lobedPath(ctx, it.x, it.y - R * 0.35, R * 1.15, R * 0.95, lobeCount(t.b), 5000 + (t.cx * 31 + t.cy * 17 & 1023), 0, true);
          ctx.fill();
        }
      }

      ctx.restore();
    }

    // =========================================================================
    // ЗЕРНО БУМАГИ
    // =========================================================================
     function periodicNoise(x, y, periodX, periodY, s) {
      // Честное деление на период для получения гладкой вещественной координаты
      const u = (x / Math.max(1, periodX));
      const v = (y / Math.max(1, periodY));
      const iu = Math.floor(u), iv = Math.floor(v);
      const fu = u - iu, fv = v - iv;
      const su = fu * fu * (3.0 - 2.0 * fu), sv = fv * fv * (3.0 - 2.0 * fv);
      const a = hash2(iu, iv, s), b = hash2(iu + 1, iv, s);
      const c = hash2(iu, iv + 1, s), d = hash2(iu + 1, iv + 1, s);
      return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
    }

    let GRAIN = null, EROSION = null;
    function ensureGrain() {
      if (GRAIN) return;
      const mk = () => { const c = document.createElement('canvas'); c.width = c.height = TILE; return c; };
      GRAIN = mk(); EROSION = mk();
      const g = GRAIN.getContext('2d'), e = EROSION.getContext('2d');
      const gi = g.createImageData(TILE, TILE), ei = e.createImageData(TILE, TILE);
      const pCfg = CANOPY_DEV_CONFIG.paper;

      // Масштаб волокон в пикселях (теперь чем больше слайдер — тем крупнее и выразительнее волокно)
      const pX1 = Math.max(1.5, pCfg.fiberScaleX * 3.0);
      const pY1 = Math.max(1.5, pCfg.fiberScaleY * 1.5);
      const pX2 = Math.max(1.5, pCfg.crossFiberScaleX * 1.5);
      const pY2 = Math.max(1.5, pCfg.crossFiberScaleY * 3.5);

      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const f1 = periodicNoise(x, y, pX1, pY1, 101);
          const f2 = periodicNoise(x, y, pX2, pY2, 307);
          const speckle = hash2(x, y, 777);
          const grainVal = clamp(f1 * 0.50 + f2 * 0.35 + (speckle - 0.5) * pCfg.speckleAmount * 2.0, 0.0, 1.0);

          const idx = (y * TILE + x) * 4;

          // 1. Впитывание туши в углубления бумаги
          const darkFiber = clamp((0.55 - grainVal) * 2.8, 0.0, 1.0);
          gi.data[idx] = 18;
          gi.data[idx + 1] = 18;
          gi.data[idx + 2] = 18;
          gi.data[idx + 3] = Math.round(darkFiber * pCfg.darkFiberAlpha);

          // 2. Стирание туши на сухих выступах фактуры бумаги
          const tooth = clamp(Math.pow(grainVal, pCfg.erosionContrast) * 255.0, 0.0, 255.0);
          ei.data[idx] = 0;
          ei.data[idx + 1] = 0;
          ei.data[idx + 2] = 0;
          ei.data[idx + 3] = Math.round(tooth);
        }
      }
      g.putImageData(gi, 0, 0);
      e.putImageData(ei, 0, 0);
    }
    

    function stampTiled(ctx, img, ox, oy, canvasW, canvasH) {
      // Честное замощение холста любого размера с учетом смещения
      for (let y = -oy; y < canvasH; y += TILE) {
        for (let x = -ox; x < canvasW; x += TILE) {
          ctx.drawImage(img, x, y);
        }
      }
    }

    function applyPaperGrain(ctx, tx, ty, o, P) {
      if (!o || o.paperBleed <= 0.03) return;

      ensureGrain();
      const pCfg = CANOPY_DEV_CONFIG.paper;
      const bleed = o.paperBleed * pCfg.bleedMultiplier;
      const nightDamp = P ? Math.max(0.15, 1.0 - P.night * 0.6) : 1.0;
      const effectiveBleed = clamp(bleed * nightDamp, 0.0, 1.0);

      // Привязываем фазу зерна бумаги к абсолютным мировым координатам левого верхнего угла холста
      const worldOriginX = tx * TILE - PAD;
      const worldOriginY = ty * TILE - PAD;
      const ox = ((worldOriginX % TILE) + TILE) % TILE;
      const oy = ((worldOriginY % TILE) + TILE) % TILE;

      const logicalSize = TILE + PAD * 2;
      const cW = logicalSize;
      const cH = logicalSize;

      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = clamp(effectiveBleed * 0.85, 0.0, 0.70);
      stampTiled(ctx, GRAIN, ox, oy, cW, cH);

      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = clamp(effectiveBleed * 1.35, 0.05, 0.98);
      stampTiled(ctx, EROSION, ox, oy, cW, cH);
      ctx.restore();
    }

    // =========================================================================
    // РЕНДЕР ТАЙЛА
    // =========================================================================
    let lastAppliedKey = '';

    function currentLighting() {
      const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const lat = Math.round(c.lat * 10) / 10;
      const lng = Math.round(c.lng * 10) / 10;
      return getTreeLighting(lat, lng);
    }

    const _treeRenderQueue = [];
    let _treeRenderRaf = 0;



    function enqueueTreeRender(tile, coords, onLoaded) {
      if (!tile || tile._dead || tile._queued) return;
      tile._queued = true;
      _treeRenderQueue.push({ tile, coords, onLoaded });
      if (!_treeRenderRaf) {
        _treeRenderRaf = requestAnimationFrame(pumpTreeRenderQueue);
      }
    }

    function pumpTreeRenderQueue() {
      _treeRenderRaf = 0;
      if (!_treeRenderQueue.length || !mapInstance) return;

      const targetZoom = getTargetTreeZoom();
      const center = mapInstance.getCenter();
      const cp = mapInstance.project(center, targetZoom);

      const alive = [];
      for (let i = 0; i < _treeRenderQueue.length; i++) {
        const it = _treeRenderQueue[i];
        it.tile._queued = false;
        if (it.tile._dead || it.coords.z !== targetZoom) continue;
        const dx = it.coords.x + 0.5 - cp.x / 256;
        const dy = it.coords.y + 0.5 - cp.y / 256;
        it.d = dx * dx + dy * dy;
        alive.push(it);
      }
      _treeRenderQueue.length = 0;
      if (!alive.length) return;

      // Сначала рисуем тайлы в центре экрана, потом — к краям
      alive.sort((a, b) => a.d - b.d);

      const t0 = performance.now();
      let idx = 0;
      do {
        const item = alive[idx++];
        if (!item.tile._dead && mapInstance) {
          api.render(item.tile, item.coords, item.onLoaded);
        }
      } while (idx < alive.length && (performance.now() - t0) < 6);

      // Остаток переносим на следующий кадр
      for (let i = idx; i < alive.length; i++) {
        alive[i].tile._queued = true;
        _treeRenderQueue.push(alive[i]);
      }
      if (_treeRenderQueue.length) {
        _treeRenderRaf = requestAnimationFrame(pumpTreeRenderQueue);
      }
    }

    function invalidateUnreadyPacks() {
      for (const [k, p] of packCache) {
        if (!p.ready) packCache.delete(k);
      }
    }

    function scheduleTerrainRetry(canvas, coords, onLoaded) {
      // Помечаем тайл для централизованного перерендера по событию 'wm:dem-change'
      canvas._needsDem = true;
      if (canvas._ttFallbackDone || canvas._dead) return;
      canvas._ttFallbackDone = true;
      clearTimeout(canvas._ttTimer);
      // Страховочный одиночный ретрай, если событие по какой-то причине не пришло
      canvas._ttTimer = setTimeout(() => {
        if (!canvas._dead && canvas._needsDem) {
          invalidateUnreadyPacks();
          enqueueTreeRender(canvas, coords, onLoaded);
        }
      }, 2200);
    }
    function drawTreeItem(ctx, it, o, P) {
      const t = it.t, st = t._ls;
      const isSouthEdge = (t.emask & ((1 << 1) | (1 << 2) | (1 << 3))) !== 0;
      const tuft = o.fantasyForest && t.isDeepMassif && !t.deco && !isSouthEdge;
      // «скрытые» ели массива: остаётся только подлесок
      if (tuft && t.kind === 'conifer' && CANOPY_DEV_CONFIG.coniferMerge.enabled && conMergeVariant(t) < 0) return;
      const sp = getSprite(t, tuft, st, o, P);
      ctx.drawImage(sp.cv, Math.round(it.x - sp.ax), Math.round(it.y - sp.ay), sp.wCss, sp.hCss);
    }
    let _isAreaLoading = false;
    let _loadingTilesCount = 0;

    function projectLatLngToPoint(lat, lng, zoom) {
      const sinLat = Math.sin(lat * Math.PI / 180);
      const totalPixels = Math.pow(2, zoom) * TILE;
      const x = ((lng + 180) / 360) * totalPixels;
      const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * totalPixels;
      return { x, y };
    }

    let _roadMaskRaw = null;
    let _roadMaskBlur = null;
    function getRoadMaskCanvases(w, h) {
      if (!_roadMaskRaw) {
        _roadMaskRaw = document.createElement('canvas');
        _roadMaskBlur = document.createElement('canvas');
      }
      if (_roadMaskRaw.width !== w || _roadMaskRaw.height !== h) {
        _roadMaskRaw.width = _roadMaskBlur.width = w;
        _roadMaskRaw.height = _roadMaskBlur.height = h;
      }
      return { raw: _roadMaskRaw, blur: _roadMaskBlur };
    }

    function collectCanopyRingTiles(lat0, lng0, z, dMinM, dMaxM) {
      const n = 1 << z;
      const cosLat = Math.max(0.05, Math.cos(lat0 * Math.PI / 180));
      const dLat = dMaxM / 111195.0;
      const dLng = Math.min(179, dMaxM / (111195.0 * cosLat));
      const latN = Math.min(85.05, lat0 + dLat), latS = Math.max(-85.05, lat0 - dLat);
      const mercYn = (la) => { const s = Math.sin(la * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
      const mercLatN = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

      const xa = Math.floor(((lng0 - dLng + 180) / 360) * n);
      const xb = Math.floor(((lng0 + dLng + 180) / 360) * n);
      const ya = Math.max(0, Math.floor(mercYn(latN) * n));
      const yb = Math.min(n - 1, Math.floor(mercYn(latS) * n));

      const res = [];
      for (let ty = ya; ty <= yb; ty++) {
        const latC = mercLatN((ty + 0.5) / n);
        const wM = 40075016.7 * Math.cos(latC * Math.PI / 180) / n;
        const hd = 0.7072 * wM;
        for (let tx = xa; tx <= xb; tx++) {
          const lngC = ((tx + 0.5) / n) * 360 - 180;
          let dx = lngC - lng0; dx = ((dx + 540) % 360) - 180;
          const ex = dx * 111195.0 * cosLat, ey = (latC - lat0) * 111195.0;
          const dc = Math.sqrt(ex * ex + ey * ey);
          if (dc + hd >= dMinM && dc - hd <= dMaxM) {
            const normTx = ((tx % n) + n) % n;
            res.push({ zoom: z, normTx, ty, key: `${z}/${normTx}/${ty}`, distM: dc });
          }
        }
      }
      return res;
    }

    const api = {
      enqueue: enqueueTreeRender,
      invalidateUnreadyPacks,

// Добавьте этот метод:
      getSpeciesStatus() {
        if (_speciesSuccessCount > 0) return 'loaded';
        if (inFlightSpeciesRequests.size > 0) return 'loading';
        return 'fallback';
      },

      hasTileData(z, x, y) {
        const n = 1 << z;
        if (y < 0 || y >= n) return true;
        const normX = ((x % n) + n) % n;
        const g = dataCache.get(`${z}/${normX}/${y}`);
        return !!g && !g._degraded;
      },
      ensureTileData(z, x, y, onReady) {
        const grid = requestHeights(z, x, y, onReady);
        return !!grid;
      },

      dropDegradedTile(z, x, y) {
        const n = 1 << z;
        if (y < 0 || y >= n) return;
        const normX = ((x % n) + n) % n;
        const key = `${z}/${normX}/${y}`;
        const g = dataCache.get(key);
        if (g && g._degraded) {
          dataCache.delete(key);
          const prefix = `${z}/${normX}/${y}|`;
          for (const k of tileTreesCache.keys()) {
            if (k.startsWith(prefix)) tileTreesCache.delete(k);
          }
        }
      },

      render(canvas, coords, onLoaded) {
        const o = opts();
        const ctx = canvas.getContext('2d');
        const logicalSize = TILE + PAD * 2;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(TILE_DPR, 0, 0, TILE_DPR, 0, 0);

        const z = coords.z, tx = coords.x, ty = coords.y;
        const hx = ((tx % (1 << z)) + (1 << z)) % (1 << z);
        const P = prepareLighting(currentLighting(), o);
        lastAppliedKey = P.key;

        // Запрашиваем деревья ТОЛЬКО своего тайла. Никаких 3x3 циклов!
        const list = getTileTrees(z, tx, ty, o, onLoaded);
        if (!list || !list.length) {
          canvas._lightKey = '';
          canvas._needsDem = false;
          const rawKey = `${z}/${hx}/${ty}`;
          const rawGrid = dataCache.get(rawKey);
          const state = !rawGrid
            ? (inFlightRequests.has(rawKey) ? 'loading' : (failedHeightCooldown.has(rawKey) ? 'cooldown' : 'missing'))
            : (rawGrid === ZERO ? 'empty-zero' : 'filtered-empty');
          canvas._diag = { state, planned: 0, drawn: 0 };
          return false;
        }

        const pack = o.terrainLight ? getPack(z, hx, ty) : null;
        const field = pack ? getShadowField(z, hx, ty, pack, P, o) : null;
        if (pack && !pack.ready && !pack.noDem && o.terrainLight) {
          scheduleTerrainRetry(canvas, coords, onLoaded);
        } else {
          canvas._needsDem = false;
        }

        const items = [];
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          // Смещаем координаты на PAD, так как холст больше логического тайла
          const x = t.x + PAD;
          const y = t.y + PAD;

          const st = ensureLight(t, pack, field, P, o);
          if (o.slopeSuppression > 0.01 && st.slope > o.slopeTolerance) {
            const excess = (st.slope - o.slopeTolerance) / Math.max(0.05, o.slopeTolerance * 0.7);
            if (hash2(t.cx, t.cy, 19) < Math.min(1.0, excess * o.slopeSuppression * 1.6)) continue;
          }
          items.push({ t, x, y });
        }

        if (!items.length) {
          canvas._lightKey = P.key;
          canvas._needsDem = false;
          canvas._diag = { state: 'slope-filtered', planned: list.length, drawn: 0 };
          return false;
        }
        items.sort((a, b) => a.y - b.y);

        // Рисуем базу массива, тени и сами деревья
        drawGroundShadows(ctx, items, o, P);
        if (o.clustering) drawMassifBase(ctx, items, o, P);
        for (let i = 0; i < items.length; i++) drawTreeItem(ctx, items[i], o, P);

        // Вспомогательная вырезка коридоров (дороги и реки) со сдвигом на PAD
        const applyCorridorCutout = (drawRawFn, opacity, softness) => {
          const softPx = softness * 10.0;

          if (softPx <= 0.2 && opacity >= 0.995) {
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = '#000';
            ctx.strokeStyle = '#000';
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            drawRawFn(ctx, 0);
            ctx.restore();
            return;
          }

          const { raw, blur } = getRoadMaskCanvases(logicalSize, logicalSize);
          const rCtx = raw.getContext('2d');
          rCtx.clearRect(0, 0, raw.width, raw.height);
          rCtx.fillStyle = '#000';
          rCtx.strokeStyle = '#000';
          rCtx.lineCap = 'round';
          rCtx.lineJoin = 'round';
          drawRawFn(rCtx, softPx);

          let maskToDraw = raw;
          if (softPx > 0.2) {
            const bCtx = blur.getContext('2d');
            bCtx.clearRect(0, 0, blur.width, blur.height);
            bCtx.save();
            if (typeof bCtx.filter === 'string') {
              bCtx.filter = `blur(${(softPx * 0.5).toFixed(1)}px)`;
              bCtx.drawImage(raw, 0, 0);
              bCtx.filter = 'none';
            } else {
              bCtx.shadowColor = '#000';
              bCtx.shadowBlur = softPx;
              bCtx.drawImage(raw, 0, 0);
            }
            bCtx.restore();
            maskToDraw = blur;
          }

          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.globalAlpha = opacity;
          ctx.drawImage(maskToDraw, 0, 0, logicalSize, logicalSize);
          ctx.restore();
        };

        // 1. Просеки дорог
        const roadSegs = (o.clearRoads && WM.vectorRoads?.getTileRoadSegments)
          ? WM.vectorRoads.getTileRoadSegments(z, tx, ty, onLoaded)
          : null;

        if (o.clearRoads && o.clearRoadsOpacity > 0.005 && roadSegs && roadSegs.length) {
          applyCorridorCutout((mCtx, softPx) => {
            for (let s = 0; s < roadSegs.length; s++) {
              const seg = roadSegs[s];
              mCtx.lineWidth = Math.max(0.8, seg.r * o.clearRoadsDist * 2.0 - softPx * 0.45);
              mCtx.beginPath();
              mCtx.moveTo(seg.x1 + PAD, seg.y1 + PAD);
              mCtx.lineTo(seg.x2 + PAD, seg.y2 + PAD);
              mCtx.stroke();
            }
          }, o.clearRoadsOpacity, o.clearRoadsSoftness);
        }

        // 2. Расчистка русел рек и водоёмов
        const riverData = (o.clearRivers && WM.vectorRoads?.getTileRiverData)
          ? WM.vectorRoads.getTileRiverData(z, tx, ty, onLoaded)
          : null;

        if (o.clearRivers && o.clearRiversOpacity > 0.005 && riverData &&
            ((riverData.segs && riverData.segs.length) || (riverData.polys && riverData.polys.length))) {
          applyCorridorCutout((mCtx, softPx) => {
            // Площадные реки, озёра и водоёмы
            if (riverData.polys && riverData.polys.length) {
              mCtx.beginPath();
              for (let p = 0; p < riverData.polys.length; p++) {
                const rings = riverData.polys[p].rings;
                for (let l = 0; l < rings.length; l++) {
                  const ring = rings[l];
                  if (ring.length < 6) continue;
                  mCtx.moveTo(ring[0] + PAD, ring[1] + PAD);
                  for (let k = 2; k < ring.length; k += 2) {
                    mCtx.lineTo(ring[k] + PAD, ring[k + 1] + PAD);
                  }
                }
              }
              mCtx.fill('evenodd');

              // Расширение расчистки от берегов при ширине > ×1.0 (без швов на границах тайлов)
              if (o.clearRiversDist > 1.0 && riverData.bankSegs && riverData.bankSegs.length) {
                mCtx.lineWidth = Math.max(0.8, (o.clearRiversDist - 1.0) * 10.0 - softPx * 0.45);
                mCtx.beginPath();
                const bs = riverData.bankSegs;
                for (let i = 0; i < bs.length; i += 4) {
                  mCtx.moveTo(bs[i] + PAD, bs[i + 1] + PAD);
                  mCtx.lineTo(bs[i + 2] + PAD, bs[i + 3] + PAD);
                }
                mCtx.stroke();
              }
            }

            // Линейные реки, каналы и ручьи
            if (riverData.segs && riverData.segs.length) {
              const segs = riverData.segs;
              for (let s = 0; s < segs.length; s++) {
                const seg = segs[s];
                mCtx.lineWidth = Math.max(0.8, seg.r * o.clearRiversDist * 2.0 - softPx * 0.45);
                mCtx.beginPath();
                mCtx.moveTo(seg.x1 + PAD, seg.y1 + PAD);
                mCtx.lineTo(seg.x2 + PAD, seg.y2 + PAD);
                mCtx.stroke();
              }
            }
          }, o.clearRiversOpacity, o.clearRiversSoftness);
        }

        // Накладываем текстуру бумаги
        applyPaperGrain(ctx, tx, ty, o, P);
        canvas._lightKey = P.key;
        canvas._diag = { state: 'ok', planned: list.length, drawn: items.length };
        return true;
      },
      currentKey() {
        const o = opts();
        return prepareLighting(currentLighting(), o).key;
      },
      lastKey() { return lastAppliedKey; },

      clearCache() {
        tileTreesCache.clear();
        clearSpriteCache();
        paletteCache.clear();
        shadowCache.clear();
        GRAIN = null;     // <-- Сбрасываем холст волокон бумаги
        EROSION = null;   // <-- Сбрасываем холст эрозии
      },

      clearFailedCooldowns() {
        failedHeightCooldown.clear();
        failedSpeciesCooldown.clear();
      },

      clearAll() {
        cacheGen++;
        dataCache.clear();
        _loadedZoomMask = 0;
        _fastZ = -1;
        _fastTx = -1;
        _fastTy = -1;
        _fastGrid = null;
        inFlightRequests.clear();
        inFlightListeners.clear();
        failedHeightCooldown.clear();
        speciesDataCache.clear();
        inFlightSpeciesRequests.clear();
        inFlightSpeciesListeners.clear();
        failedSpeciesCooldown.clear();
        packCache.clear();
        if (WM.canopyV2 && WM.canopyV2.clearCache) WM.canopyV2.clearCache();
        this.clearCache();
      },

     clearSpritesOnly() {
        clearSpriteCache();
        paletteCache.clear();
        shadowCache.clear();
      },

      trimMemory(aggressive = false) {
        const trimMap = (m, lim) => { while (m.size > lim) m.delete(m.keys().next().value); };
        trimMap(dataCache, aggressive ? 32 : 56);
        trimMap(speciesDataCache, aggressive ? 32 : 56);
        trimMap(tileTreesCache, aggressive ? 16 : 32);
        trimMap(packCache, aggressive ? 16 : 28);
        trimMap(shadowCache, aggressive ? 16 : 28);
        trimMap(paletteCache, aggressive ? 250 : 600);
        const maxB = (aggressive ? (2 * 1024 * 1024) : (4 * 1024 * 1024)) * TILE_DPR * TILE_DPR;
        const maxC = aggressive ? 300 : 600;
        while ((spriteBytes > maxB || spriteCache.size > maxC) && spriteCache.size > 0) {
          const k0 = spriteCache.keys().next().value;
          const dead = spriteCache.get(k0);
          if (dead) {
            spriteBytes = Math.max(0, spriteBytes - dead.bytes);
            if (dead.cv) { dead.cv.width = 0; dead.cv.height = 0; }
          }
          spriteCache.delete(k0);
        }
      },

      // Экспортируем функцию наружу
      projectLatLngToPoint,

      getHeightAt(lat, lng) {
        if (dataCache.size === 0) return 0;
        for (let i = 0; i < _candZoomsDesc.length; i++) {
          const z = _candZoomsDesc[i];
          if ((_loadedZoomMask & (1 << z)) === 0) continue;

          const n = 1 << z;
          const point = projectLatLngToPoint(lat, lng, z);
          const tx = Math.floor(point.x / TILE);
          const ty = Math.floor(point.y / TILE);
          if (ty < 0 || ty >= n) continue;
          const normTx = ((tx % n) + n) % n;

          const grid = dataCache.get(`${z}/${normTx}/${ty}`);
          if (grid) {
            if (grid === ZERO) return 0;
            const localX = Math.floor(((point.x % TILE) + TILE) % TILE);
            const localY = Math.floor(((point.y % TILE) + TILE) % TILE);
            const valQ = grid[localY * TILE + localX];
            return valQ ? (valQ / Q) : 0;
          }
        }
        return 0;
      },

      // ИСПРАВЛЕНО: убрано слово 'function', метод объявлен корректно для ES6-объекта
      getHeightAtNorm,

      ingestHeightBlob,

      getDebugSnapshot() {
        const tZoom = getTargetTreeZoom();
        const tiles = [];
        if (canopyTreesLayer && canopyTreesLayer._tiles) {
          for (const key in canopyTreesLayer._tiles) {
            const entry = canopyTreesLayer._tiles[key];
            const el = entry?.el;
            const c = entry?.coords;
            if (!el || !c) continue;
            const n = 1 << c.z;
            const hx = ((c.x % n) + n) % n;
            const dKey = `${c.z}/${hx}/${c.y}`;
            const g = dataCache.get(dKey);
            tiles.push({
              key,
              coords: { z: c.z, x: c.x, y: c.y },
              dead: !!el._dead,
              queued: !!el._queued,
              needsDem: !!el._needsDem,
              hasGridInRam: !!g,
              isZero: g === ZERO,
              isDegraded: !!(g && g._degraded),
              inCooldown: failedHeightCooldown.has(dKey),
              diag: el._diag || null
            });
          }
        }
        return {
          treesTileZoom: tZoom,
          caches: {
            dataCacheSize: dataCache.size,
            dataCacheLimit: CACHE_LIMIT,
            speciesCacheSize: speciesDataCache.size,
            speciesSuccessCount: _speciesSuccessCount,
            tileTreesCacheSize: tileTreesCache.size,
            spriteCount: spriteCache.size,
            maxSprites: MAX_SPRITE_COUNT,
            spriteBytes,
            spriteBytesLimit: SPRITE_BYTES_LIMIT,
            packCacheSize: packCache.size,
            shadowCacheSize: shadowCache.size,
            failedHeightCooldown: failedHeightCooldown.size,
            failedSpeciesCooldown: failedSpeciesCooldown.size,
            inFlightHeight: inFlightRequests.size,
            inFlightSpecies: inFlightSpeciesRequests.size,
            renderQueue: _treeRenderQueue.length
          },
          tiles
        };
      },

      async loadCanopyArea(lat0, lng0, radiusMeters, zoom = 13, opts = {}) {

        const { signal, onProgress, multiScale = true } = opts || {};

        let candidates;
        if (multiScale && zoom === 13 && radiusMeters > 3000) {
          // Вблизи (<= 2.5 км) — детальный z13 (~11 м/px), дальше — z12 (~22 м/px, в 4 раза меньше тайлов)
          const nearList = collectCanopyRingTiles(lat0, lng0, 13, 0, 2500);
          const farList = collectCanopyRingTiles(lat0, lng0, 12, 2500, radiusMeters);
          candidates = nearList.concat(farList);
        } else {
          candidates = collectCanopyRingTiles(lat0, lng0, zoom, 0, radiusMeters);
        }

        const queue = [];
        let cachedCount = 0;
        for (let i = 0; i < candidates.length; i++) {
          const item = candidates[i];
          if (dataCache.has(item.key) || tryDownsampleChildrenInRam(item.zoom, item.normTx, item.ty)) {
            cachedCount++;
            continue;
          }
          queue.push(item);
        }

        // От центра к краям
        queue.sort((a, b) => a.distM - b.distM);

        const getActiveHostName = () => (canopySettings.canopyVersion === 'v2' && WM.canopyV2)
          ? (WM.canopyV2.getDiagnostics().activeHost || 'Meta CHM v2')
          : (CanopyNet.states[CanopyNet.lastSuccessfulIdx]?.name || 'Yandex Cloud');

        const totalAll = queue.length + cachedCount;
        if (onProgress) onProgress(cachedCount, totalAll);

        if (!queue.length || (signal && signal.aborted)) {
          return { total: totalAll, downloaded: 0, cached: cachedCount, failed: 0, activeHost: getActiveHostName() };
        }

        const CONCURRENCY = 8;
        let cursor = 0;
        let doneCount = cachedCount;
        let loadedSuccessCount = 0;
        let failCount = 0;

        const worker = async () => {
          while (cursor < queue.length) {
            if (signal && signal.aborted) return;
            const item = queue[cursor++];
            if (dataCache.has(item.key)) {
              doneCount++;
              if (onProgress) onProgress(doneCount, totalAll);
              continue;
            }

            if (inFlightRequests.has(item.key)) {
              await inFlightRequests.get(item.key).catch(() => null);
              if (signal && signal.aborted) return;
              const existing = dataCache.get(item.key);
              if (existing && (!existing._degraded || navigator.onLine === false)) {
                loadedSuccessCount++;
              } else {
                failCount++;
              }
            } else {
              const reqGen = cacheGen;
              const p = fetchNativeRaster(item.zoom, item.normTx, item.ty, signal).then(grid => {
                if (inFlightRequests.get(item.key) === p) inFlightRequests.delete(item.key);
                const isUsable = !!(grid && (!grid._degraded || navigator.onLine === false));
                if (reqGen === cacheGen && isUsable) {
                  setDataCacheEntry(item.key, item.zoom, grid);
                  loadedSuccessCount++;
                  _fastZ = -1;
                } else if (!(signal && signal.aborted)) {
                  failCount++;
                }
                return grid;
              }).catch(() => {
                if (inFlightRequests.get(item.key) === p) inFlightRequests.delete(item.key);
                if (!(signal && signal.aborted)) failCount++;
              });
              inFlightRequests.set(item.key, p);
              await p;
            }
            if (signal && signal.aborted) return;
            doneCount++;
            if (onProgress) onProgress(doneCount, totalAll);
          }
        };

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) workers.push(worker());
        const workP = Promise.all(workers);

        if (signal) {
          await Promise.race([
            workP,
            new Promise(res => signal.addEventListener('abort', res, { once: true }))
          ]);
        } else {
          await workP;
        }

        return {
          total: totalAll,
          downloaded: loadedSuccessCount,
          cached: cachedCount,
          failed: failCount,
          activeHost: getActiveHostName()
        };
      }
    };
    
    return api;
  })();

  const PAD = 40; // Вылет кроны за границы тайла

  const CanopyTreesLayer = L.GridLayer.extend({
    // Перехватываем инициализацию Leaflet, чтобы он не сжимал холст обратно в 256x256!
    _initTile(tile) {
      L.GridLayer.prototype._initTile.call(this, tile);
      const size = 256 + PAD * 2;
      tile.style.width = size + 'px';
      tile.style.height = size + 'px';
      tile.style.minWidth = size + 'px';
      tile.style.minHeight = size + 'px';
      tile.style.maxWidth = size + 'px';
      tile.style.maxHeight = size + 'px';
      tile.style.marginLeft = -PAD + 'px';
      tile.style.marginTop = -PAD + 'px';
      tile.style.pointerEvents = 'none';
    },

    createTile(coords, done) {
      const tile = document.createElement('canvas');
      const size = 256 + PAD * 2;
      tile.width = Math.round(size * TILE_DPR);
      tile.height = Math.round(size * TILE_DPR);
      tile.style.zIndex = coords.y;

      const triggerRedraw = () => {
        if (tile._dead || !this._map) return;
        TreeEngine.enqueue(tile, coords, triggerRedraw);
      };

      // Рендерим не синхронно в createTile, а через бюджетную очередь кадров
      TreeEngine.enqueue(tile, coords, triggerRedraw);
      setTimeout(() => done(null, tile), 0);
      return tile;
    }
  });

  function refreshTreeTiles(force = false) {
    if (!canopyTreesLayer || !canopyTreesLayer._tiles || !mapInstance) return;
    const curKey = TreeEngine.currentKey();
    const targetZoom = getTargetTreeZoom();
    for (const key in canopyTreesLayer._tiles) {
      const e = canopyTreesLayer._tiles[key];
      if (!e || !e.el || !e.coords || !e.el.getContext || e.el._dead) continue;
      if (e.coords.z !== targetZoom) continue;
      if (!force && e.el._lightKey === curKey) continue;
      const trigger = () => {
        if (!e.el._dead && mapInstance) TreeEngine.enqueue(e.el, e.coords, trigger);
      };
      TreeEngine.enqueue(e.el, e.coords, trigger);
    }
  }

  function applyCanopyStyles() {
    if (!mapInstance) return;
    const pane = mapInstance.getPane('wm-canopy-pane');
    if (pane) {
      pane.style.zIndex = 320;
      pane.style.mixBlendMode = canopySettings.blendMode || 'normal';
    }

    const treePane = mapInstance.getPane('wm-canopy-trees-pane');
    if (treePane) {
      treePane.style.zIndex = 334; // Перед изолиниями (333), под подписями (335)
      treePane.style.mixBlendMode = canopySettings.treeBlendMode || 'multiply';
    }

    if (canopyHeightLayer) {
      canopyHeightLayer.setOpacity(canopySettings.heightOpacity);
    }
    if (canopyMaskLayer) {
      canopyMaskLayer.setOpacity(canopySettings.maskOpacity);
      const maskContainer = canopyMaskLayer.getContainer();
      if (maskContainer) {
        maskContainer.className = 'leaflet-layer wm-canopy-mask tint-' + canopySettings.maskTint;
      }
    }

    if (canopyTreesLayer) {
      canopyTreesLayer.setOpacity(canopySettings.treeOpacity || 0.85);
      const container = canopyTreesLayer.getContainer();
      if (container) {
        // Режим наложения задаётся только на treePane, чтобы избежать двойного/изолированного смешивания
        container.style.mixBlendMode = '';
      }
    }
  }

  let _demReadyTimer = null;

  function handleDemChangeForTrees() {
    if (isPeakViewForeground()) return;
    if (!canopyTreesLayer || !canopyTreesLayer._tiles || !mapInstance || !canopySettings.treesEnabled) return;
    clearTimeout(_demReadyTimer);
    _demReadyTimer = setTimeout(() => {
      if (isPeakViewForeground()) return;
      TreeEngine.invalidateUnreadyPacks();
      for (const key in canopyTreesLayer._tiles) {
        const e = canopyTreesLayer._tiles[key];
        if (e && e.el && !e.el._dead && e.el._needsDem) {
          const trigger = () => {
            if (!e.el._dead && mapInstance) TreeEngine.enqueue(e.el, e.coords, trigger);
          };
          TreeEngine.enqueue(e.el, e.coords, trigger);
        }
      }
    }, 260);
  }

  // =========================================================================
  // ПУБЛИЧНЫЙ API (WM.canopy)
  // =========================================================================
  WM.canopy = {
    getSettings: () => ({ ...canopySettings }),

    init(map) {
      mapInstance = map;

      if (!map.getPane('wm-canopy-pane')) {
        map.createPane('wm-canopy-pane');
      }
      map.getPane('wm-canopy-pane').style.zIndex = 320;

      if (!map.getPane('wm-canopy-trees-pane')) {
        map.createPane('wm-canopy-trees-pane');
      }
      map.getPane('wm-canopy-trees-pane').style.zIndex = 334;




      canopyHeightLayer = new CanopyFallbackLayer({
        ...COMMON_TILE_OPTIONS,
        layerType: 'height', // <-- передаём тип слоя
        pane: 'wm-canopy-pane',
        maxNativeZoom: 18,
        maxZoom: 20,
        opacity: canopySettings.heightOpacity,
        className: 'wm-canopy-tile wm-canopy-height',
        attribution: '© Meta / WRI Canopy Height'
      });

      canopyMaskLayer = new CanopyFallbackLayer({
        ...COMMON_TILE_OPTIONS,
        layerType: 'mask', // <-- передаём тип слоя
        pane: 'wm-canopy-pane',
        maxNativeZoom: 18,
        maxZoom: 20,
        opacity: canopySettings.maskOpacity,
        className: 'wm-canopy-tile wm-canopy-mask tint-' + canopySettings.maskTint,
        attribution: '© Meta / WRI Canopy Mask'
      });

      canopyTreesLayer = new CanopyTreesLayer({
        ...COMMON_TILE_OPTIONS,
        updateWhenIdle: true,
        pane: 'wm-canopy-trees-pane',
        minZoom: 11,
        maxNativeZoom: 16, // Ключевое: на зумах 17, 18, 19, 20 Leaflet плавно масштабирует готовые тайлы через GPU!
        maxZoom: 20,
        opacity: canopySettings.treeOpacity || 0.85,
        className: 'wm-canopy-tile wm-canopy-trees'
      });
      canopyTreesLayer.on('add', () => {
        applyCanopyStyles();
      });
      canopyTreesLayer.on('tileunload', e => {
        e.tile._dead = true;
        e.tile._needsDem = false;
        clearTimeout(e.tile._ttTimer);
        if (e.tile._rq) cancelAnimationFrame(e.tile._rq);
        e.tile.width = 0;
        e.tile.height = 0;
      });

      // Снимаем предыдущий слушатель (на случай повторного init) и вешаем заново
      window.removeEventListener('wm:dem-change', handleDemChangeForTrees);
      window.addEventListener('wm:dem-change', handleDemChangeForTrees);



      applyCanopyStyles();

      let _moveTimer = null;
      map.on('moveend zoomend', () => {
        clearTimeout(_moveTimer);
        _moveTimer = setTimeout(() => WM.canopy.onLightingChanged(), 250);
      });

      if (canopySettings.heightEnabled) canopyHeightLayer.addTo(map);
      if (canopySettings.maskEnabled) canopyMaskLayer.addTo(map);
      if (canopySettings.treesEnabled) canopyTreesLayer.addTo(map);

      return {
        heightLayer: canopyHeightLayer,
        maskLayer: canopyMaskLayer,
        treesLayer: canopyTreesLayer
      };
    },

    getDebugSnapshot() {
      const te = TreeEngine.getDebugSnapshot();
      return {
        settings: {
          treesEnabled: !!canopySettings.treesEnabled,
          heightEnabled: !!canopySettings.heightEnabled,
          maskEnabled: !!canopySettings.maskEnabled,
          canopyVersion: canopySettings.canopyVersion || 'v1',
          treeStyle: canopySettings.treeStyle,
          treeMinH: canopySettings.treeMinH,
          forestOnlyThreshold: canopySettings.forestOnlyThreshold
        },
        tokens: {
          isLoaded: !!CanopyTokens.isLoaded,
          hasHeight: !!CanopyTokens.templates.height,
          hasMask: !!CanopyTokens.templates.mask,
          hasSpecies: !!CanopyTokens.templates.species
        },
        net: {
          lastSuccessfulIdx: CanopyNet.lastSuccessfulIdx,
          states: CanopyNet.states.map(s => ({
            name: s.name,
            alive: Date.now() >= s.openUntil,
            fails: s.fails,
            lastError: s.lastError
          }))
        },
        parallel: {
          active: _canopyActive,
          max: CANOPY_MAX_PARALLEL,
          waiting: _canopyWaiters.length
        },
        ...te
      };
    },


   reloadMissingTiles() {
      CanopyNet.resetCircuitBreakers();
      TreeEngine.clearFailedCooldowns();
      if (WM.canopyV2 && WM.canopyV2.resetCircuitBreakers) WM.canopyV2.resetCircuitBreakers();
      if (!mapInstance) return 0;

      let reloaded = 0;

      // 1. Проверяем слой процедурных деревьев
      if (canopyTreesLayer && canopyTreesLayer._tiles && canopySettings.treesEnabled) {
        // Берём реальный зум тайлов слоя (на зумах 17..20 он равен maxNativeZoom = 16)
        const treeZoom = canopyTreesLayer._tileZoom !== undefined
          ? canopyTreesLayer._tileZoom
          : Math.min(16, Math.round(mapInstance.getZoom()));

        for (const key in canopyTreesLayer._tiles) {
          const entry = canopyTreesLayer._tiles[key];
          const el = entry?.el;
          const coords = entry?.coords;
          if (!el || !coords || el._dead || coords.z !== treeZoom) continue;

          TreeEngine.dropDegradedTile(coords.z, coords.x, coords.y);

          // Если данных о высоте в кэше нет — ставим тайл в бюджетную очередь
          if (!TreeEngine.hasTileData(coords.z, coords.x, coords.y)) {
            reloaded++;
            const trigger = () => {
              if (!el._dead && mapInstance) TreeEngine.enqueue(el, coords, trigger);
            };
            TreeEngine.enqueue(el, coords, trigger);
          }
        }
      }

      // 2. Проверяем растровые подложки высот и маски (CanopyFallbackLayer)
      [canopyHeightLayer, canopyMaskLayer].forEach(layer => {
        if (layer && layer._tiles && mapInstance.hasLayer(layer)) {
          let hasFailed = false;
          for (const key in layer._tiles) {
            const entry = layer._tiles[key];
            const img = entry?.el;
            if (img && (img.naturalWidth === 0 || img.classList.contains('leaflet-tile-error'))) {
              reloaded++;
              hasFailed = true;
            }
          }
          if (hasFailed) {
            layer.redraw();
          }
        }
      });

      return reloaded;
    }, 

    setTreeVolumetric(val) {
      canopySettings.treeVolumetric = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.0));
      localStorage.setItem('wm_canopy_tree_volumetric', canopySettings.treeVolumetric.toString());
      TreeEngine.clearSpritesOnly();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    getHeightAtNorm(xn, yn) {
      return TreeEngine.getHeightAtNorm(xn, yn);
    },
    ensureTileData(z, x, y, onReady) {
      return TreeEngine.ensureTileData(z, x, y, onReady);
    },
    loadCanopyArea(lat, lng, radiusMeters, zoom = 13, opts) {
      return TreeEngine.loadCanopyArea(lat, lng, radiusMeters, zoom, opts);
    },

    setTreeStrokeColor(color) {
      canopySettings.treeStrokeColor = color;
      canopySettings.treeColor = color;
      localStorage.setItem('wm_canopy_tree_stroke_color', color);
      localStorage.setItem('wm_canopy_tree_color', color);
      TreeEngine.clearSpritesOnly();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreePaperBleed(val) {
      canopySettings.treePaperBleed = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.0));
      localStorage.setItem('wm_canopy_tree_paper_bleed', canopySettings.treePaperBleed.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeEdgeScale(val) {
      canopySettings.treeEdgeScale = Math.max(0.4, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_tree_edge_scale', canopySettings.treeEdgeScale.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeMassifScale(val) {
      canopySettings.treeMassifScale = Math.max(0.5, Math.min(3.0, parseFloat(val) || 1.55));
      localStorage.setItem('wm_canopy_tree_massif_scale', canopySettings.treeMassifScale.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    clearCache() {
      TreeEngine.clearCache();
    },
    trimMemory(aggressive = false) {
      TreeEngine.trimMemory(aggressive);
    },
    clearDataCache() {
      TreeEngine.clearAll();
      if (mapInstance) {
        if (canopyTreesLayer && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
        if (canopyHeightLayer && mapInstance.hasLayer(canopyHeightLayer)) canopyHeightLayer.redraw();
        if (canopyMaskLayer && mapInstance.hasLayer(canopyMaskLayer)) canopyMaskLayer.redraw();
      }
    },

    // --- ДОБАВЬТЕ ЭТИ СТРОКИ ДЛЯ VIEWSHED И ГРАФИКА ВЫСОТ ---
    getHeightAt(lat, lng) {
      return TreeEngine.getHeightAt(lat, lng);
    },
    getTreeHeight(lat, lng) {
      return TreeEngine.getHeightAt(lat, lng);
    },
    getCanopyHeight(lat, lng) {
      return TreeEngine.getHeightAt(lat, lng);
    },
    sampleHeightAt(lat, lng) {
      return TreeEngine.getHeightAt(lat, lng);
    },

    getNetworkDiagnostics() {
      if (canopySettings.canopyVersion === 'v2' && WM.canopyV2) {
        return WM.canopyV2.getDiagnostics();
      }
      return CanopyNet.getDiagnostics();
    },

    getVersion() {
      return canopySettings.canopyVersion || 'v1';
    },

    setVersion(ver, opts = {}) {
      const next = (ver === 'v2') ? 'v2' : 'v1';
      if (canopySettings.canopyVersion === next) return;

      canopySettings.canopyVersion = next;
      try { localStorage.setItem('wm_canopy_version', next); } catch (e) {}

      document.querySelectorAll('input[name="canopy-height-version"]').forEach(r => {
        r.checked = (r.value === next);
      });
      const hudVerSel = document.getElementById('dem-hud-canopy-version');
      if (hudVerSel) hudVerSel.value = next;

      // Полный сброс кэшей высот, чтобы все модули перечитали данные из нового источника
      TreeEngine.clearAll();

      if (mapInstance) {
        if (canopyTreesLayer && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
        if (canopyHeightLayer && mapInstance.hasLayer(canopyHeightLayer)) canopyHeightLayer.redraw();
        if (canopyMaskLayer && mapInstance.hasLayer(canopyMaskLayer)) canopyMaskLayer.redraw();
      }

      // Если открыт Viewshed — запускаем перерасчёт (кроме автопереключения из самого Viewshed)
      if (!opts.skipViewshedSchedule && WM.viewshed && WM.viewshed.isActive && WM.viewshed.isActive() && WM.viewshed.scheduleCompute) {
        WM.viewshed.scheduleCompute();
      }

      window.dispatchEvent(new CustomEvent('wm:canopy-version-change', {
        detail: { version: canopySettings.canopyVersion }
      }));

      this.syncUI();
    },
    getHeight(lat, lng) {
      return TreeEngine.getHeightAt(lat, lng);
    },
    // --------------------------------------------------------

    getHeightLayer: () => canopyHeightLayer,
    getMaskLayer: () => canopyMaskLayer,
    getTreesLayer: () => canopyTreesLayer,

    applyProfile(profileData) {
      if (!profileData || typeof profileData !== 'object') return;
      const prevVersion = canopySettings.canopyVersion;
      const isGlobalDisabled = (profileData.enabled === false && !profileData.settings);
      const s = profileData.settings || profileData;

      const next = {
        ...DEFAULT_CANOPY_SETTINGS,
        canopyVersion: prevVersion
      };

      if (isGlobalDisabled) {
        next.heightEnabled = false;
        next.maskEnabled = false;
        next.treesEnabled = false;
      } else if (s && typeof s === 'object') {
        for (const k in s) {
          if (k in DEFAULT_CANOPY_SETTINGS) {
            next[k] = s[k];
          }
        }
        if (s.treeStrokeColor && !s.treeColor) next.treeColor = s.treeStrokeColor;
        if (s.treeColor && !s.treeStrokeColor) next.treeStrokeColor = s.treeColor;
      }

      Object.assign(canopySettings, next);
      saveAllCanopySettings();

      if (mapInstance) {
        if (canopyHeightLayer) {
          if (canopySettings.heightEnabled && !mapInstance.hasLayer(canopyHeightLayer)) canopyHeightLayer.addTo(mapInstance);
          else if (!canopySettings.heightEnabled && mapInstance.hasLayer(canopyHeightLayer)) mapInstance.removeLayer(canopyHeightLayer);
        }
        if (canopyMaskLayer) {
          if (canopySettings.maskEnabled && !mapInstance.hasLayer(canopyMaskLayer)) canopyMaskLayer.addTo(mapInstance);
          else if (!canopySettings.maskEnabled && mapInstance.hasLayer(canopyMaskLayer)) mapInstance.removeLayer(canopyMaskLayer);
        }
        if (canopyTreesLayer) {
          if (canopySettings.treesEnabled && !mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.addTo(mapInstance);
          else if (!canopySettings.treesEnabled && mapInstance.hasLayer(canopyTreesLayer)) mapInstance.removeLayer(canopyTreesLayer);
        }
      }

      applyCanopyStyles();

      if (prevVersion !== canopySettings.canopyVersion) {
        TreeEngine.clearAll();
        if (mapInstance) {
          if (canopyHeightLayer && mapInstance.hasLayer(canopyHeightLayer)) canopyHeightLayer.redraw();
          if (canopyMaskLayer && mapInstance.hasLayer(canopyMaskLayer)) canopyMaskLayer.redraw();
        }
        window.dispatchEvent(new CustomEvent('wm:canopy-version-change', {
          detail: { version: canopySettings.canopyVersion }
        }));
      } else {
        TreeEngine.clearCache();
      }
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) {
        canopyTreesLayer.redraw();
      }
      this.syncUI();
    },

    setHeightEnabled(val) {
      canopySettings.heightEnabled = !!val;
      localStorage.setItem('wm_canopy_height_on', canopySettings.heightEnabled ? 'true' : 'false');
      if (mapInstance && canopyHeightLayer) {
        if (canopySettings.heightEnabled) {
          if (!mapInstance.hasLayer(canopyHeightLayer)) mapInstance.addLayer(canopyHeightLayer);
        } else {
          if (mapInstance.hasLayer(canopyHeightLayer)) mapInstance.removeLayer(canopyHeightLayer);
        }
      }
      this.syncUI();
    },

    setMaskEnabled(val) {
      canopySettings.maskEnabled = !!val;
      localStorage.setItem('wm_canopy_mask_on', canopySettings.maskEnabled ? 'true' : 'false');
      if (mapInstance && canopyMaskLayer) {
        if (canopySettings.maskEnabled) {
          if (!mapInstance.hasLayer(canopyMaskLayer)) mapInstance.addLayer(canopyMaskLayer);
        } else {
          if (mapInstance.hasLayer(canopyMaskLayer)) mapInstance.removeLayer(canopyMaskLayer);
        }
      }
      this.syncUI();
    },

    setTreeClearRivers(val) {
      canopySettings.treeClearRivers = !!val;
      localStorage.setItem('wm_canopy_tree_clear_rivers', canopySettings.treeClearRivers ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRiversDist(val) {
      canopySettings.treeClearRiversDist = Math.max(0.4, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_tree_clear_rivers_dist', canopySettings.treeClearRiversDist.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRiversOpacity(val) {
      const parsed = parseFloat(val);
      canopySettings.treeClearRiversOpacity = Math.max(0.0, Math.min(1.0, isNaN(parsed) ? 1.0 : parsed));
      localStorage.setItem('wm_canopy_tree_clear_rivers_opacity', canopySettings.treeClearRiversOpacity.toString());
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRiversSoftness(val) {
      const parsed = parseFloat(val);
      canopySettings.treeClearRiversSoftness = Math.max(0.0, Math.min(1.0, isNaN(parsed) ? 0.35 : parsed));
      localStorage.setItem('wm_canopy_tree_clear_rivers_softness', canopySettings.treeClearRiversSoftness.toString());
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRoads(val) {
      canopySettings.treeClearRoads = !!val;
      localStorage.setItem('wm_canopy_tree_clear_roads', canopySettings.treeClearRoads ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRoadsDist(val) {
      canopySettings.treeClearRoadsDist = Math.max(0.4, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_tree_clear_roads_dist', canopySettings.treeClearRoadsDist.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRoadsOpacity(val) {
      const parsed = parseFloat(val);
      canopySettings.treeClearRoadsOpacity = Math.max(0.0, Math.min(1.0, isNaN(parsed) ? 1.0 : parsed));
      localStorage.setItem('wm_canopy_tree_clear_roads_opacity', canopySettings.treeClearRoadsOpacity.toString());
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeClearRoadsSoftness(val) {
      const parsed = parseFloat(val);
      canopySettings.treeClearRoadsSoftness = Math.max(0.0, Math.min(1.0, isNaN(parsed) ? 0.35 : parsed));
      localStorage.setItem('wm_canopy_tree_clear_roads_softness', canopySettings.treeClearRoadsSoftness.toString());
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreesEnabled(val) {
      canopySettings.treesEnabled = !!val;
      localStorage.setItem('wm_canopy_trees_on', canopySettings.treesEnabled ? 'true' : 'false');
      if (mapInstance && canopyTreesLayer) {
        if (canopySettings.treesEnabled) {
          if (!mapInstance.hasLayer(canopyTreesLayer)) mapInstance.addLayer(canopyTreesLayer);
          applyCanopyStyles();
        } else {
          if (mapInstance.hasLayer(canopyTreesLayer)) mapInstance.removeLayer(canopyTreesLayer);
        }
      }
      this.syncUI();
    },

    setHeightOpacity(val) {
      canopySettings.heightOpacity = Math.max(0.05, Math.min(1.0, parseFloat(val) || 0.75));
      localStorage.setItem('wm_canopy_height_opacity', canopySettings.heightOpacity.toString());
      if (canopyHeightLayer) canopyHeightLayer.setOpacity(canopySettings.heightOpacity);
    },

    setMaskOpacity(val) {
      canopySettings.maskOpacity = Math.max(0.05, Math.min(1.0, parseFloat(val) || 0.85));
      localStorage.setItem('wm_canopy_mask_opacity', canopySettings.maskOpacity.toString());
      if (canopyMaskLayer) canopyMaskLayer.setOpacity(canopySettings.maskOpacity);
    },

    setMaskTint(val) {
      canopySettings.maskTint = val || 'emerald';
      localStorage.setItem('wm_canopy_mask_tint', canopySettings.maskTint);
      applyCanopyStyles();
    },

    setBlendMode(val) {
      canopySettings.blendMode = val || 'normal';
      localStorage.setItem('wm_canopy_blend', canopySettings.blendMode);
      applyCanopyStyles();
    },

    setCustomColors(val) {
      canopySettings.customColors = !!val;
      localStorage.setItem('wm_canopy_custom_colors_on', canopySettings.customColors ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setDecidColor1(val) {
      canopySettings.decidColor1 = val;
      localStorage.setItem('wm_canopy_decid_col1', val);
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setDecidColor2(val) {
      canopySettings.decidColor2 = val;
      localStorage.setItem('wm_canopy_decid_col2', val);
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setConiferColor(val) {
      canopySettings.coniferColor = val;
      localStorage.setItem('wm_canopy_conifer_col', val);
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setDecidRatio(val) {
      canopySettings.decidRatio = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.5));
      localStorage.setItem('wm_canopy_decid_ratio', canopySettings.decidRatio.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setColorScatter(val) {
      canopySettings.colorScatter = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.25));
      localStorage.setItem('wm_canopy_color_scatter', canopySettings.colorScatter.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeOpaqueFill(val) {
      canopySettings.treeOpaqueFill = !!val;
      localStorage.setItem('wm_canopy_tree_opaque_fill', canopySettings.treeOpaqueFill ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
      this.syncUI();
    },

    setTreeFillWarmth(val) {
      canopySettings.treeFillWarmth = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.5));
      localStorage.setItem('wm_canopy_tree_fill_warmth', canopySettings.treeFillWarmth.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeFillBrightness(val) {
      canopySettings.treeFillBrightness = Math.max(0.2, Math.min(1.5, parseFloat(val) || 0.85));
      localStorage.setItem('wm_canopy_tree_fill_brightness', canopySettings.treeFillBrightness.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeFillSaturation(val) {
      canopySettings.treeFillSaturation = Math.max(0.0, Math.min(1.5, parseFloat(val) || 0.6));
      localStorage.setItem('wm_canopy_tree_fill_saturation', canopySettings.treeFillSaturation.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeSlopeSuppression(val) {
      canopySettings.treeSlopeSuppression = Math.max(0.0, Math.min(1.0, parseFloat(val) || 0.0));
      localStorage.setItem('wm_canopy_tree_slope_suppress', canopySettings.treeSlopeSuppression.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeSlopeTolerance(val) {
      canopySettings.treeSlopeTolerance = Math.max(0.05, Math.min(1.0, parseFloat(val) || 0.25));
      localStorage.setItem('wm_canopy_tree_slope_tol', canopySettings.treeSlopeTolerance.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setFantasyForest(val) {
      canopySettings.canopyFantasyForest = !!val;
      localStorage.setItem('wm_canopy_fantasy_forest', canopySettings.canopyFantasyForest ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
      this.syncUI();
    },

    setTreeAutoDenseScale(val) {
      canopySettings.treeAutoDenseScale = Math.max(1.0, Math.min(2.5, parseFloat(val) || 1.55));
      localStorage.setItem('wm_canopy_tree_autodense_scale', canopySettings.treeAutoDenseScale.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeNightBrightness(val) {
      canopySettings.treeNightBrightness = Math.max(0.2, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_night_bright', canopySettings.treeNightBrightness.toString());
      TreeEngine.clearSpritesOnly();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeNightContrast(val) {
      canopySettings.treeNightContrast = Math.max(0.3, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_night_contrast', canopySettings.treeNightContrast.toString());
      TreeEngine.clearSpritesOnly();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeAutoDenseThinning(val) {
      canopySettings.treeAutoDenseThinning = Math.max(0.0, Math.min(0.85, parseFloat(val) || 0.50));
      localStorage.setItem('wm_canopy_tree_autodense_thin', canopySettings.treeAutoDenseThinning.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeBlendMode(mode) {
      const ALLOWED_BLEND_MODES = [
        'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
        'color-dodge', 'color-burn', 'hard-light', 'soft-light',
        'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
      ];
      const nextMode = ALLOWED_BLEND_MODES.includes(mode) ? mode : 'multiply';
      canopySettings.treeBlendMode = nextMode;
      localStorage.setItem('wm_canopy_tree_blend', nextMode);
      applyCanopyStyles();
    },

    setTreeStyle(style) {
      canopySettings.treeStyle = style;
      localStorage.setItem('wm_canopy_tree_style', style);
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setTreeColor(color) {
      canopySettings.treeColor = color;
      localStorage.setItem('wm_canopy_tree_color', color);
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setTreeScale(val) {
      canopySettings.treeScale = Math.max(0.4, Math.min(4.0, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_tree_scale', canopySettings.treeScale.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) {
        canopyTreesLayer.redraw();
      }
    },

    setTreeDensity(val) {
      canopySettings.treeDensity = Math.max(0.2, Math.min(2.5, parseFloat(val) || 1.0));
      localStorage.setItem('wm_canopy_tree_density', canopySettings.treeDensity.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) {
        canopyTreesLayer.redraw();
      }
    },

    setTreeOpacity(val) {
      canopySettings.treeOpacity = Math.max(0.1, Math.min(1.0, val));
      localStorage.setItem('wm_canopy_tree_opacity', canopySettings.treeOpacity.toString());
      if (canopyTreesLayer) canopyTreesLayer.setOpacity(canopySettings.treeOpacity);
    },

    setTreeShadows(val) {
      canopySettings.treeShadows = !!val;
      localStorage.setItem('wm_canopy_tree_shadows', canopySettings.treeShadows ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setTreeAutoDense(val) {
      canopySettings.treeAutoDense = !!val;
      localStorage.setItem('wm_canopy_tree_autodense', canopySettings.treeAutoDense ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setTreeClustering(val) {
      canopySettings.treeClustering = !!val;
      localStorage.setItem('wm_canopy_tree_clustering', canopySettings.treeClustering ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setTreeMinH(val) {
      canopySettings.treeMinH = Math.max(1.0, parseFloat(val) || 4.0);
      localStorage.setItem('wm_canopy_tree_min_h', canopySettings.treeMinH.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    setForestOnlyThreshold(val) {
      canopySettings.forestOnlyThreshold = Math.max(0.05, Math.min(0.9, parseFloat(val) || 0.35));
      localStorage.setItem('wm_canopy_forest_only', canopySettings.forestOnlyThreshold.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer) canopyTreesLayer.redraw();
    },

    onLightingChanged(force) {
      if (isPeakViewForeground()) return;
      if (!canopyTreesLayer || !mapInstance || !mapInstance.hasLayer(canopyTreesLayer)) return;
      const curKey = TreeEngine.currentKey();
      const targetZoom = getTargetTreeZoom();
      let needsUpdate = !!force;

      if (!needsUpdate && canopyTreesLayer._tiles) {
        for (const key in canopyTreesLayer._tiles) {
          const e = canopyTreesLayer._tiles[key];
          if (e && e.el && !e.el._dead && e.coords && e.coords.z === targetZoom && e.el._lightKey && e.el._lightKey !== curKey) {
            needsUpdate = true;
            break;
          }
        }
      }

      if (!needsUpdate) return;
      refreshTreeTiles(!!force);
    },

    refresh() { this.onLightingChanged(true); },

    setTreeVariety(val) {
      canopySettings.treeVariety = Math.max(0.0, Math.min(1.5, parseFloat(val) || 0.0));
      localStorage.setItem('wm_canopy_tree_variety', canopySettings.treeVariety.toString());
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeTerrainLight(val) {
      canopySettings.treeTerrainLight = !!val;
      localStorage.setItem('wm_canopy_tree_terrain_light', canopySettings.treeTerrainLight ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeTerrainShadows(val) {
      canopySettings.treeTerrainShadows = !!val;
      localStorage.setItem('wm_canopy_tree_terrain_shadows', canopySettings.treeTerrainShadows ? 'true' : 'false');
      TreeEngine.clearCache();
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    setTreeShadowStrength(val) {
      canopySettings.treeShadowStrength = Math.max(0.0, Math.min(1.5, parseFloat(val) || 0.0));
      localStorage.setItem('wm_canopy_tree_shadow_strength', canopySettings.treeShadowStrength.toString());
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) canopyTreesLayer.redraw();
    },

    syncUI() {
      if (window.renderCanopyHudUI) window.renderCanopyHudUI();
    }
  };



// =========================================================================
  // 🛠 ВРЕМЕННОЕ МЕНЮ ТОНКОЙ НАСТРОЙКИ (DEV HUD)
  // =========================================================================
  // =========================================================================
  // 🛠 ВРЕМЕННОЕ МЕНЮ ТОНКОЙ НАСТРОЙКИ (DEV HUD)
  // =========================================================================
  function initCanopyDevHud() {
    if (typeof document === 'undefined') return;

    // Ждём, пока body точно появится в DOM
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', initCanopyDevHud);
      return;
    }

    const PANEL_ID = 'wm-canopy-dev-tuning-hud';
    if (document.getElementById(PANEL_ID)) return;

    // Вспомогательный триггер перерисовки холста
    function rerenderTrees(full = true) {
      if (full) {
        TreeEngine.clearCache();
      } else {
        TreeEngine.clearSpritesOnly();
      }
      if (canopyTreesLayer && mapInstance && mapInstance.hasLayer(canopyTreesLayer)) {
        canopyTreesLayer.redraw();
      }
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 50px;
      right: 15px;
      width: 340px;
      max-height: 85vh;
      background: rgba(18, 20, 24, 0.94);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      user-select: none;
      backdrop-filter: blur(8px);
    `;

    panel.innerHTML = `
      <div style="padding: 9px 12px; background: rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; cursor: move;" id="wm-dev-header">
        <span style="font-weight: bold; color: #38bdf8;">🌲 Тюнинг леса (CANOPY DEV)</span>
        <div>
          <button id="wm-dev-collapse-btn" style="background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0 4px; font-size: 12px;">−</button>
          <button id="wm-dev-close-btn" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 0 4px; font-size: 12px;">×</button>
        </div>
      </div>
      <div id="wm-dev-content" style="padding: 10px 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;">
        
        <button id="wm-dev-copy-btn" style="width: 100%; padding: 7px; background: #0284c7; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; transition: 0.2s;">
          📋 Скопировать конфиг для кода
        </button>

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">1. ФАКТУРА БУМАГИ И РАСТВОРЕНИЕ</div>
        ${rangeControl('paper.bleedMultiplier', 'Сила растворения (Bleed)', 0.1, 3.0, 0.05, CANOPY_DEV_CONFIG.paper.bleedMultiplier)}
        ${rangeControl('paper.darkFiberAlpha', 'Густота волокон туши', 0, 255, 5, CANOPY_DEV_CONFIG.paper.darkFiberAlpha)}
        ${rangeControl('paper.erosionContrast', 'Контраст эрозии бумаги', 0.2, 4.0, 0.1, CANOPY_DEV_CONFIG.paper.erosionContrast)}
        ${rangeControl('paper.speckleAmount', 'Зерно крапинок бумаги', 0.0, 0.5, 0.01, CANOPY_DEV_CONFIG.paper.speckleAmount)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">2. ШЕРОХОВАТОСТЬ / ТОЧКИ ЛИСТВЫ</div>
        ${checkboxControl('roughness.enabled', 'Включить микро-крапинки', CANOPY_DEV_CONFIG.roughness.enabled)}
        ${rangeControl('roughness.density', 'Плотность точек', 0.2, 5.0, 0.1, CANOPY_DEV_CONFIG.roughness.density)}
        ${rangeControl('roughness.darkNoiseOpacity', 'Плотность тушевых точек', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.roughness.darkNoiseOpacity)}
        ${rangeControl('roughness.lightNoiseOpacity', 'Яркость световых точек', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.roughness.lightNoiseOpacity)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">3. БЛИКИ И СОЛНЕЧНЫЕ ПЯТНА (DAPPLED)</div>
        ${checkboxControl('dappledLight.enabled', 'Включить солнечные пятна', CANOPY_DEV_CONFIG.dappledLight.enabled)}
        ${rangeControl('dappledLight.spotCount', 'Количество пятен', 1, 12, 1, CANOPY_DEV_CONFIG.dappledLight.spotCount)}
        ${rangeControl('dappledLight.spotOpacity', 'Прозрачность пятен', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.dappledLight.spotOpacity)}
        ${rangeControl('dappledLight.spotWarmthShift', 'Теплота бликов', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.dappledLight.spotWarmthShift)}
        ${checkboxControl('dappledLight.coniferSparkles', 'Искорки на ветках елей', CANOPY_DEV_CONFIG.dappledLight.coniferSparkles)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">4. МАССИВЫ, СЛЕПЛИВАНИЕ И КОНТУРЫ</div>
        ${rangeControl('clustering.tuftRadiusRatio', 'Радиус куртины (Tuft)', 0.15, 0.75, 0.01, CANOPY_DEV_CONFIG.clustering.tuftRadiusRatio)}
        ${rangeControl('clustering.massifBaseDarkness', 'Подложка массива (База)', 0.1, 1.0, 0.02, CANOPY_DEV_CONFIG.clustering.massifBaseDarkness)}
        ${checkboxControl('clustering.suppressInnerStrokes', 'Глушить контуры внутри', CANOPY_DEV_CONFIG.clustering.suppressInnerStrokes)}
        ${checkboxControl('clustering.restoreTopArcs', 'Оставлять шапочки крон', CANOPY_DEV_CONFIG.clustering.restoreTopArcs)}
        ${rangeControl('clustering.innerStrokeRate', 'Доля шапочек (Rate)', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.clustering.innerStrokeRate)}
        ${rangeControl('clustering.innerStrokeAlpha', 'Прозрачность шапочек', 0.1, 1.0, 0.05, CANOPY_DEV_CONFIG.clustering.innerStrokeAlpha)}
        ${rangeControl('clustering.innerTopArcReach', 'Охват дуги шапочки', -0.3, 0.5, 0.05, CANOPY_DEV_CONFIG.clustering.innerTopArcReach)}
        ${rangeControl('clustering.autoDenseThinning', 'Прореживание массива', 0.0, 0.6, 0.02, CANOPY_DEV_CONFIG.clustering.autoDenseThinning)}
        ${checkboxControl('coniferMerge.enabled', 'Слепливание елей (макушки)', CANOPY_DEV_CONFIG.coniferMerge.enabled)}
        ${rangeControl('coniferMerge.hideRate', 'Скрытые ели (только подлесок)', 0.0, 0.85, 0.02, CANOPY_DEV_CONFIG.coniferMerge.hideRate)}
        ${rangeControl('coniferMerge.pawRate', 'Доля низких лап', 0.0, 0.6, 0.02, CANOPY_DEV_CONFIG.coniferMerge.pawRate)}
        ${rangeControl('coniferMerge.peakHeight', 'Высота макушек', 0.5, 1.8, 0.05, CANOPY_DEV_CONFIG.coniferMerge.peakHeight)}
        ${rangeControl('coniferMerge.peakWidth', 'Ширина макушек', 0.5, 1.6, 0.05, CANOPY_DEV_CONFIG.coniferMerge.peakWidth)}
        ${rangeControl('coniferMerge.carpetDarkness', 'Тёмность подлеска', 0.3, 1.2, 0.02, CANOPY_DEV_CONFIG.coniferMerge.carpetDarkness)}
        ${rangeControl('coniferMerge.carpetSize', 'Размер подлеска', 0.4, 1.0, 0.02, CANOPY_DEV_CONFIG.coniferMerge.carpetSize)}
        ${rangeControl('coniferMerge.chevrons', 'Шевроны на подлеске', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.coniferMerge.chevrons)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">5. ТЕНИ И ПОДЛОЖКИ (SETTINGS)</div>
        ${rangeControlSetting('treeContactShadowOpacity', 'Контактная тень ствола', 0.0, 1.0, 0.02, canopySettings.treeContactShadowOpacity)}
        ${rangeControlSetting('treeShadeOpacity', 'Теневой полумесяц кроны', 0.0, 0.8, 0.02, canopySettings.treeShadeOpacity)}
        ${rangeControlSetting('treeShadeDarkness', 'Глубина тени листвы', 0.0, 1.0, 0.02, canopySettings.treeShadeDarkness)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">6. НОЧНОЙ РЕЖИМ (SETTINGS)</div>
        ${rangeControlSetting('treeNightStrength', 'Сила ночной тонировки', 0.0, 1.0, 0.02, canopySettings.treeNightStrength)}
        ${rangeControlSetting('treeNightBrightness', 'Ночная яркость деревьев', 0.2, 2.5, 0.05, canopySettings.treeNightBrightness)}
        ${rangeControlSetting('treeNightContrast', 'Ночной контраст', 0.3, 2.0, 0.05, canopySettings.treeNightContrast)}
        ${colorControlSetting('treeNightTint', 'Оттенок ночи', canopySettings.treeNightTint)}

        <div style="font-weight: bold; color: #a78bfa; margin-top: 4px;">7. ГЕОМЕТРИЯ КРОН</div>
        ${rangeControl('geometry.crownBaseMeters', 'Базовая крона (метры)', 3.0, 14.0, 0.5, CANOPY_DEV_CONFIG.geometry.crownBaseMeters)}
        ${rangeControl('geometry.strokeWidthFactor', 'Толщина туши кроны', 0.01, 0.10, 0.005, CANOPY_DEV_CONFIG.geometry.strokeWidthFactor)}
        ${rangeControl('geometry.treeJitter', 'Хаос смещения (Jitter)', 0.0, 1.0, 0.05, CANOPY_DEV_CONFIG.geometry.treeJitter)}

      </div>
    `;

    function rangeControl(path, label, min, max, step, curVal) {
      return `
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="display: flex; justify-content: space-between; color: #cbd5e1;">
            <span>${label}:</span>
            <span id="wm-lbl-${path}" style="color: #38bdf8; font-weight: bold;">${curVal}</span>
          </div>
          <input type="range" data-cfg-path="${path}" min="${min}" max="${max}" step="${step}" value="${curVal}" style="width: 100%; cursor: pointer;">
        </div>
      `;
    }

    function checkboxControl(path, label, checked) {
      return `
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: #cbd5e1;">
          <input type="checkbox" data-cfg-path="${path}" ${checked ? 'checked' : ''}>
          <span>${label}</span>
        </label>
      `;
    }

    function rangeControlSetting(key, label, min, max, step, curVal) {
      return `
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="display: flex; justify-content: space-between; color: #cbd5e1;">
            <span>${label}:</span>
            <span id="wm-lbl-s-${key}" style="color: #f59e0b; font-weight: bold;">${curVal}</span>
          </div>
          <input type="range" data-setting-key="${key}" min="${min}" max="${max}" step="${step}" value="${curVal}" style="width: 100%; cursor: pointer;">
        </div>
      `;
    }

    function colorControlSetting(key, label, curVal) {
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; color: #cbd5e1;">
          <span>${label}:</span>
          <input type="color" data-setting-key="${key}" value="${curVal}" style="width: 45px; height: 22px; cursor: pointer; border: none; background: none;">
        </div>
      `;
    }

    document.body.appendChild(panel);

    // 1. Слушатели слайдеров CANOPY_DEV_CONFIG
    panel.querySelectorAll('input[data-cfg-path]').forEach(input => {
      const path = input.getAttribute('data-cfg-path');
      const [sec, prop] = path.split('.');

      input.addEventListener('input', (e) => {
        let val;
        if (input.type === 'checkbox') {
          val = input.checked;
        } else {
          val = parseFloat(e.target.value);
          const lbl = document.getElementById(`wm-lbl-${path}`);
          if (lbl) lbl.textContent = val;
        }

        CANOPY_DEV_CONFIG[sec][prop] = val;
        rerenderTrees(sec === 'geometry' || sec === 'clustering');
      });
    });

    // 2. Слушатели слайдеров canopySettings
    panel.querySelectorAll('input[data-setting-key]').forEach(input => {
      const key = input.getAttribute('data-setting-key');

      input.addEventListener('input', (e) => {
        let val = e.target.value;
        if (input.type === 'range') {
          val = parseFloat(val);
          const lbl = document.getElementById(`wm-lbl-s-${key}`);
          if (lbl) lbl.textContent = val;
        }
        canopySettings[key] = val;
        rerenderTrees(false);
      });
    });

    // 3. Копирование готового кода в буфер
    const copyBtn = document.getElementById('wm-dev-copy-btn');
    copyBtn.addEventListener('click', () => {
      const exportCode = `
// Скопированная конфигурация CANOPY_DEV_CONFIG:
const CANOPY_DEV_CONFIG = ${JSON.stringify(CANOPY_DEV_CONFIG, null, 2)};

// Вшитые значения в canopySettings:
treeContactShadowOpacity: ${canopySettings.treeContactShadowOpacity},
treeShadeOpacity: ${canopySettings.treeShadeOpacity},
treeShadeDarkness: ${canopySettings.treeShadeDarkness},
treeNightStrength: ${canopySettings.treeNightStrength},
treeNightBrightness: ${canopySettings.treeNightBrightness},
treeNightContrast: ${canopySettings.treeNightContrast},
treeNightTint: '${canopySettings.treeNightTint}',
`.trim();

      navigator.clipboard.writeText(exportCode).then(() => {
        const origText = copyBtn.textContent;
        copyBtn.textContent = '✅ Скопировано в буфер!';
        copyBtn.style.background = '#16a34a';
        setTimeout(() => {
          copyBtn.textContent = origText;
          copyBtn.style.background = '#0284c7';
        }, 2000);
      }).catch(err => {
        console.error('Ошибка копирования:', err);
        alert('Не удалось скопировать, смотрите вывод в консоли F12');
        console.log(exportCode);
      });
    });

    // 4. Сворачивание и закрытие
    const content = document.getElementById('wm-dev-content');
    const collapseBtn = document.getElementById('wm-dev-collapse-btn');
    collapseBtn.addEventListener('click', () => {
      if (content.style.display === 'none') {
        content.style.display = 'flex';
        collapseBtn.textContent = '−';
      } else {
        content.style.display = 'none';
        collapseBtn.textContent = '+';
      }
    });

    document.getElementById('wm-dev-close-btn').addEventListener('click', () => {
      panel.remove();
    });

    // 5. Перетаскивание панели мышью за шапку
    const header = document.getElementById('wm-dev-header');
    let isDragging = false, startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.left = `${startLeft + (e.clientX - startX)}px`;
      panel.style.top = `${startTop + (e.clientY - startY)}px`;
    });

    window.addEventListener('mouseup', () => { isDragging = false; });
  }

  // Экспортируем функцию наружу, чтобы можно было открыть из консоли F12:
  window.openCanopyDevHud = initCanopyDevHud;
  window.addEventListener('online', () => {
    if (isPeakViewForeground()) return;
    if (WM.canopy && WM.canopy.reloadMissingTiles) WM.canopy.reloadMissingTiles();
  });

})();