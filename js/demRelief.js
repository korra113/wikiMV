(function () {
  const WM = window.WM = window.WM || {};

  const DEM_SOURCES = {
    fabdem: {
      id: 'fabdem',
      name: 'FABDEM (GEE 30m без лесов и зданий)',
      urls: [
        'https://forests.sylar1907942.workers.dev/tiles/fabdem/{z}/{x}/{y}',
        'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=fabdem&z={z}&x={x}&y={y}',
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

      ]
    },
    copernicus: {
      id: 'copernicus',
      name: 'Copernicus GLO-30 (GEE 30m)',
      urls: [
        'https://forests.sylar1907942.workers.dev/tiles/copernicus/{z}/{x}/{y}',
        'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=copernicus&z={z}&x={x}&y={y}',
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

      ]
    },
    mapterhorn: {
      id: 'mapterhorn',
      name: 'Mapterhorn (Copernicus 30m + LiDAR)',
      urls: [
        'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

      ]
    },
    aws: {
      id: 'aws',
      name: 'AWS Terrarium (Mapzen / Nextzen)',
      urls: [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

      ]
    }
  };

  let _demHealthNotifyTs = 0;
  let _demHealthState = { degraded: false, fallbackTo: null, primaryDown: false };

  function notifyDemHealth(type, providerId) {
    const now = Date.now();
    if (type === 'ok') {
      _demHealthState = { degraded: false, fallbackTo: null, primaryDown: false };
      return;
    }
    if (type === 'fallback') {
      _demHealthState = { degraded: false, fallbackTo: providerId, primaryDown: true };
      if (now - _demHealthNotifyTs > 60000) {
        _demHealthNotifyTs = now;
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`⚠️ Основной DEM недоступен — временно используется резерв (${providerId.toUpperCase()})`, 3500);
        }
      }
    } else if (type === 'empty') {
      _demHealthState = { degraded: true, fallbackTo: null, primaryDown: true };
      if (now - _demHealthNotifyTs > 45000) {
        _demHealthNotifyTs = now;
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('⚠️ Серверы рельефа (DEM) временно недоступны', 3500);
        }
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('wm:dem-health', { detail: { ..._demHealthState } }));
    } catch (e) {}
  }
  // =========================================================================
  // ПРОВАЙДЕРЫ МАСКИ ВОДЫ (ESA WORLDCOVER 10m / WATER BODIES CLASS 80)
  // =========================================================================
   // =========================================================================
  // ПРОВАЙДЕРЫ МАСКИ ВОДЫ (ESA WORLDCOVER 10m):
  // GEE Direct -> Terrascope Direct (если с VPN) -> Cloudflare -> Yandex
  // =========================================================================
  const WATER_GEE_TOKEN_SOURCES = [
    'https://korra113.github.io/forests_map/gee-tokens.json',
    'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?action=tokens'
  ];

  const WaterTokens = {
    waterTpl: null,
    _initPromise: null,
    _lastRefreshTs: 0,

    getCached() {
      if (this.waterTpl) return this.waterTpl;
      const canopyTpl = WM.canopyTokens?.templates?.water;
      if (canopyTpl) {
        this.waterTpl = canopyTpl;
        return canopyTpl;
      }
      try {
        const raw = localStorage.getItem('wm_gee_tokens');
        if (raw) {
          const data = JSON.parse(raw);
          const t = data?.templates || data;
          if (t?.water && (!data.expiresAt || Date.now() < data.expiresAt)) {
            this.waterTpl = t.water;
            return t.water;
          }
        }
      } catch (e) {}
      return null;
    },

    invalidate() {
      this.waterTpl = null;
      if (WM.canopyTokens?.templates?.water) {
        delete WM.canopyTokens.templates.water;
      }
    },

    async ensure(force = false) {
      if (!force) {
        const cached = this.getCached();
        if (cached) return cached;
      }
      if (force && Date.now() - this._lastRefreshTs < 60000) {
        return this.waterTpl || null;
      }
      if (this._initPromise) return this._initPromise;

      this._initPromise = (async () => {
        this._lastRefreshTs = Date.now();
        for (const url of WATER_GEE_TOKEN_SOURCES) {
          try {
            const ctl = new AbortController();
            const tm = setTimeout(() => ctl.abort(), 3500);
            const res = await fetch(url, { signal: ctl.signal, cache: force ? 'no-store' : 'default' });
            clearTimeout(tm);
            if (!res.ok) {
              WM.layerDiag?.log('water', 'token', { url, status: res.status, outcome: 'error' });
              continue;
            }
            const data = await res.json();
            const t = data?.templates || data;
            if (t?.fabdem) GeeDemTokens.templates.fabdem = t.fabdem;
            if (t?.copernicus) GeeDemTokens.templates.copernicus = t.copernicus;
            if (WM.canopyTokens?.templates && t) {
              Object.assign(WM.canopyTokens.templates, t);
            }
            if (t?.water) {
              this.waterTpl = t.water;
              WM.layerDiag?.log('water', 'token', { url, status: 200, outcome: 'ok' });
              return t.water;
            }
          } catch (e) {}
        }
        return null;
      })();

      try {
        return await this._initPromise;
      } finally {
        this._initPromise = null;
      }
    }
  };

  const GeeDemTokens = {
    templates: { fabdem: null, copernicus: null },
    _initPromise: null,
    _lastRefreshTs: 0,

    getCached(type) {
      const canopyTpl = WM.canopyTokens?.templates?.[type];
      if (canopyTpl) {
        this.templates[type] = canopyTpl;
        return canopyTpl;
      }
      try {
        const raw = localStorage.getItem('wm_gee_tokens');
        if (raw) {
          const data = JSON.parse(raw);
          const t = data?.templates || data;
          if (t?.[type] && (!data.expiresAt || Date.now() < data.expiresAt)) {
            this.templates[type] = t[type];
            return t[type];
          }
        }
      } catch (e) {}
      return this.templates[type] || null;
    },

    invalidate(type) {
      this.templates[type] = null;
      if (WM.canopyTokens?.templates?.[type]) {
        delete WM.canopyTokens.templates[type];
      }
    },

    async ensure(type, force = false) {
      if (!force) {
        const cached = this.getCached(type);
        if (cached) return cached;
      }
      if (force && Date.now() - this._lastRefreshTs < 60000) {
        return this.templates[type] || null;
      }
      if (this._initPromise) return this._initPromise;

      this._initPromise = (async () => {
        this._lastRefreshTs = Date.now();
        for (const url of WATER_GEE_TOKEN_SOURCES) {
          try {
            const ctl = new AbortController();
            const tm = setTimeout(() => ctl.abort(), 3500);
            const res = await fetch(url, { signal: ctl.signal, cache: force ? 'no-store' : 'default' });
            clearTimeout(tm);
            if (!res.ok) continue;
            const data = await res.json();
            const t = data?.templates || data;
            if (t?.fabdem) this.templates.fabdem = t.fabdem;
            if (t?.copernicus) this.templates.copernicus = t.copernicus;
            if (t?.water) WaterTokens.waterTpl = t.water;
            if (WM.canopyTokens?.templates) {
              Object.assign(WM.canopyTokens.templates, t);
            }
            if (t?.[type]) return t[type];
          } catch (e) {}
        }
        return null;
      })();

      try {
        return await this._initPromise;
      } finally {
        this._initPromise = null;
      }
    }
  };

  const WaterNet = {
    states: [
      { name: 'GEE Water Direct', openUntil: 0, backoff: 15000, fails: 0 },
      { name: 'Terrascope WMTS', openUntil: 0, backoff: 30000, fails: 0 },
      { name: 'Cloudflare Worker', openUntil: 0, backoff: 20000, fails: 0 },
      { name: 'Yandex Cloud Function', openUntil: 0, backoff: 15000, fails: 0 }
    ],
    lastSuccessfulIdx: 1, // Terrascope / CF стабильнее, чем протухающие GEE-токены

    markSuccess(idx) {
      const s = this.states[idx];
      if (!s) return;
      s.fails = 0;
      s.openUntil = 0;
      s.backoff = idx === 1 ? 30000 : 15000;
      this.lastSuccessfulIdx = idx;
    },

    markFailure(idx) {
      const s = this.states[idx];
      if (!s) return;
      s.fails = (s.fails || 0) + 1;
      if (s.fails >= 3) {
        s.openUntil = Date.now() + Math.min(s.backoff, 180000);
        s.backoff = Math.min(s.backoff * 2, 180000);
        s.fails = 1;
      }
    },

    reset() {
      this.states.forEach((s, i) => {
        s.fails = 0;
        s.openUntil = 0;
        s.backoff = i === 1 ? 30000 : 15000;
      });
    },

    getAliveOrder() {
      const now = Date.now();
      const order = [];
      if (this.states[this.lastSuccessfulIdx] && now >= this.states[this.lastSuccessfulIdx].openUntil) {
        order.push(this.lastSuccessfulIdx);
      }
      for (let i = 0; i < this.states.length; i++) {
        if (!order.includes(i) && now >= this.states[i].openUntil) {
          order.push(i);
        }
      }
      return order;
    },

    getUrl(idx, z, x, y) {
      if (idx === 0) {
        const tpl = WaterTokens.getCached();
        return tpl ? L.Util.template(tpl, { z, x, y, s: 'a' }) : null;
      }
      if (idx === 1) {
        const padZ = String(z).padStart(2, '0');
        return `https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2021-v2_map/webmercator/${padZ}/${x}/${y}.png`;
      }
      if (idx === 2) {
        return `https://forests.sylar1907942.workers.dev/tiles/water/${z}/${x}/${y}`;
      }
      if (idx === 3) {
        return `https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=water&z=${z}&x=${x}&y=${y}`;
      }
      return null;
    }
  };

 function detectProviderFromUrl(url, preferredSrc = null) {
    if (!url) return 'unknown';
    if (/fabdem/i.test(url)) return 'fabdem';
    if (/copernicus/i.test(url)) return 'copernicus';
    if (/earthengine\.googleapis\.com/i.test(url)) {
      const s = preferredSrc || cfg.demSource;
      return (s === 'copernicus') ? 'copernicus' : 'fabdem';
    }
    if (/mapterhorn\.com/i.test(url)) return 'mapterhorn';
    if (/elevation-tiles-prod/i.test(url)) return 'aws';
    if (/nextzen\.org/i.test(url)) return 'nextzen';
    return 'unknown';
  }
  const baseWaterMaskCache = new Map();     // key: `${targetZ}:${tx}:${ty}` -> Uint8Array(65536)
  const baseWaterMaskInFlight = new Map();  // key: `${targetZ}:${tx}:${ty}` -> Promise<Uint8Array|null>

  const WATER_MASK_MAX_PARALLEL = 4;
  let _waterMaskActive = 0;
  const _waterMaskWaiters = [];

  function acquireWaterMaskSlot() {
    if (_waterMaskActive < WATER_MASK_MAX_PARALLEL) {
      _waterMaskActive++;
      return Promise.resolve();
    }
    return new Promise(res => _waterMaskWaiters.push(res));
  }

  function releaseWaterMaskSlot() {
    const next = _waterMaskWaiters.pop();
    if (next) next();
    else _waterMaskActive--;
  }

  async function decodeRawMaskBlob(blob) {
    let bmp = null;
    if ('createImageBitmap' in window) {
      try { bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' }); } catch (e) {}
    }
    if (!bmp) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const bUrl = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(bUrl); res(img); };
        img.onerror = (e) => { URL.revokeObjectURL(bUrl); rej(e); };
        img.src = bUrl;
      });
    }

    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0, 256, 256);
    if (bmp.close) bmp.close();

    const d = ctx.getImageData(0, 0, 256, 256).data;
    const mask = new Uint8Array(256 * 256);
    let hasWater = false;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
      const isEsaWater = (r < 35 && g > 70 && g < 130 && b > 170) || (b > 180 && r < 55 && g < 140);
      if (isEsaWater && a > 30) {
        mask[i] = 255;
        hasWater = true;
      }
    }
    mask._hasWater = hasWater;
    return mask;
  }

  function sliceMaskForZoom(baseMask, coords, targetZ) {
    const shift = coords.z - targetZ;
    if (shift <= 0) return baseMask;
    const factor = 1 << shift;
    const subX = ((coords.x % factor) + factor) % factor;
    const subY = ((coords.y % factor) + factor) % factor;
    const subSize = 256 >> shift;
    const x0 = subX * subSize;
    const y0 = subY * subSize;

    const out = new Uint8Array(256 * 256);
    let hasWater = false;
    for (let y = 0; y < 256; y++) {
      const srcRow = (y0 + (y >> shift)) * 256 + x0;
      const dstRow = y * 256;
      for (let x = 0; x < 256; x++) {
        const v = baseMask[srcRow + (x >> shift)];
        out[dstRow + x] = v;
        if (v > 0) hasWater = true;
      }
    }
    out._hasWater = hasWater;
    if (baseMask._isEmpty404) out._isEmpty404 = true;
    return out;
  }

  async function tryReadCachedBaseMask(zLevel, tx, ty) {
    if (!WM.offlineArea || typeof WM.offlineArea.readCachedBlob !== 'function') return null;
    const padZ = String(zLevel).padStart(2, '0');
    const candidates = [];
    for (let idx = 0; idx < WaterNet.states.length; idx++) {
      const url = WaterNet.getUrl(idx, zLevel, tx, ty);
      if (url) candidates.push(url);
    }
    // Совместимость с резервным слоем offlineArea (2020-v1)
    candidates.push(`https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2020-v1_map/webmercator/${padZ}/${tx}/${ty}.png`);

    for (const url of candidates) {
      try {
        const cachedBlob = await WM.offlineArea.readCachedBlob(url);
        if (cachedBlob) return await decodeRawMaskBlob(cachedBlob);
      } catch (e) {}
    }
    return null;
  }

  async function fetchBaseWaterMask(targetZ, tx, ty, forceRefresh = false) {
    const baseKey = `${targetZ}:${tx}:${ty}`;
    if (!forceRefresh && baseWaterMaskCache.has(baseKey)) {
      return baseWaterMaskCache.get(baseKey);
    }
    // Всегда дедуплицируем параллельные запросы (например, от 4 дочерних z15-тайлов)
    if (baseWaterMaskInFlight.has(baseKey)) {
      return baseWaterMaskInFlight.get(baseKey);
    }

    const promise = (async () => {
      // 1. Офлайн-кэш проверяем только если не запрошен принудительный перекач
       if (!forceRefresh) {
        const directCached = await tryReadCachedBaseMask(targetZ, tx, ty);
        if (directCached) {
          WM.layerDiag?.log('water', 'cache-idb', {
            z: targetZ, x: tx, y: ty,
            hasWater: !!directCached._hasWater,
            outcome: directCached._hasWater ? 'ok' : 'empty'
          });
          if (baseWaterMaskCache.size > 64) baseWaterMaskCache.delete(baseWaterMaskCache.keys().next().value);
          baseWaterMaskCache.set(baseKey, directCached);
          return directCached;
        }
      }

      // 2. Сеть
      if (navigator.onLine !== false) {
        if (!WaterTokens.getCached()) {
          await WaterTokens.ensure();
        }
        const order = WaterNet.getAliveOrder();
        let sawConfirmed404 = false;
        let hadNetworkOrServerErr = false;

        await acquireWaterMaskSlot();
        try {
          for (let oi = 0; oi < order.length; oi++) {
            const pIdx = order[oi];
            if (!forceRefresh && WaterNet.states[pIdx] && Date.now() < WaterNet.states[pIdx].openUntil) continue;

            const url = WaterNet.getUrl(pIdx, targetZ, tx, ty);
            if (!url) continue;

            const mirrorName = WaterNet.states[pIdx]?.name || ('Mirror #' + pIdx);
            const t0 = performance.now();
            const ctl = new AbortController();
            const timeoutMs = (oi < order.length - 1) ? 5500 : 8000;
            const tm = setTimeout(() => ctl.abort(), timeoutMs);

            try {
              const resp = await fetch(url, {
                mode: 'cors',
                cache: forceRefresh ? 'reload' : 'default',
                signal: ctl.signal
              });
              if (resp.status === 404) {
                WM.layerDiag?.log('water', 'net', {
                  z: targetZ, x: tx, y: ty, url, mirror: mirrorName,
                  status: 404, ms: Math.round(performance.now() - t0),
                  outcome: pIdx === 0 ? 'token-404' : 'empty-404'
                });
                if (pIdx === 0) WaterNet.markFailure(0);
                else sawConfirmed404 = true;
                continue;
              }
              if (!resp.ok) {
                hadNetworkOrServerErr = true;
                WaterNet.markFailure(pIdx);
                WM.layerDiag?.log('water', 'net', {
                  z: targetZ, x: tx, y: ty, url, mirror: mirrorName,
                  status: resp.status, ms: Math.round(performance.now() - t0),
                  outcome: 'error'
                });
                continue;
              }
              const blob = await resp.blob();
              clearTimeout(tm);
              const mask = await decodeRawMaskBlob(blob);
              WaterNet.markSuccess(pIdx);
              WM.layerDiag?.log('water', 'net', {
                z: targetZ, x: tx, y: ty, url, mirror: mirrorName,
                status: 200, bytes: blob.size, ms: Math.round(performance.now() - t0),
                hasWater: !!mask._hasWater, outcome: mask._hasWater ? 'ok' : 'empty'
              });
              if (baseWaterMaskCache.size > 64) baseWaterMaskCache.delete(baseWaterMaskCache.keys().next().value);
              baseWaterMaskCache.set(baseKey, mask);
              return mask;
            } catch (e) {
              hadNetworkOrServerErr = true;
              WaterNet.markFailure(pIdx);
              WM.layerDiag?.log('water', 'net', {
                z: targetZ, x: tx, y: ty, url, mirror: mirrorName,
                ms: Math.round(performance.now() - t0),
                error: e?.name === 'AbortError' ? 'Timeout' : (e?.message || 'NetErr'),
                outcome: 'error'
              });
            } finally {
              clearTimeout(tm);
            }
          }
        } finally {
          releaseWaterMaskSlot();
        }

        if (sawConfirmed404 && !hadNetworkOrServerErr) {
          if (targetZ > 8) {
            const parentMask = await fetchBaseWaterMask(targetZ - 1, tx >> 1, ty >> 1, forceRefresh);
            if (parentMask && !parentMask._isEmpty404) {
              const sliced = sliceMaskForZoom(parentMask, { z: targetZ, x: tx, y: ty }, targetZ - 1);
              if (baseWaterMaskCache.size > 64) baseWaterMaskCache.delete(baseWaterMaskCache.keys().next().value);
              baseWaterMaskCache.set(baseKey, sliced);
              return sliced;
            }
          }
          const empty = new Uint8Array(256 * 256);
          empty._hasWater = false;
          empty._isEmpty404 = true;
          WM.layerDiag?.log('water', 'fallback', {
            z: targetZ, x: tx, y: ty, outcome: 'empty-404', note: 'Подтверждён 404 (воды нет)'
          });
          if (baseWaterMaskCache.size > 64) baseWaterMaskCache.delete(baseWaterMaskCache.keys().next().value);
          baseWaterMaskCache.set(baseKey, empty);
          return empty;
        }
      }

      // 3. Офлайн-резерв: кэш родительских зумов
      for (let pz = targetZ - 1; pz >= 6; pz--) {
        const s = targetZ - pz;
        const parentMask = await tryReadCachedBaseMask(pz, tx >> s, ty >> s);
        if (parentMask) {
          const sliced = sliceMaskForZoom(parentMask, { z: targetZ, x: tx, y: ty }, pz);
          sliced._hasWater = parentMask._hasWater;
          sliced._isFallback = true;
          WM.layerDiag?.log('water', 'fallback', {
            z: targetZ, x: tx, y: ty, fromZ: pz, hasWater: !!sliced._hasWater, outcome: 'fallback-parent',
            note: `Родитель z${pz} из кэша`
          });
          return sliced;
        }
      }

      WM.layerDiag?.log('water', 'error', {
        z: targetZ, x: tx, y: ty, outcome: 'failed',
        note: navigator.onLine === false ? 'Офлайн и нет в кэше' : 'Все зеркала воды недоступны'
      });
      return null;
    })();

    baseWaterMaskInFlight.set(baseKey, promise);
    try {
      return await promise;
    } finally {
      if (baseWaterMaskInFlight.get(baseKey) === promise) {
        baseWaterMaskInFlight.delete(baseKey);
      }
    }
  }
  async function fetchWaterMaskTile(coords, forceRefresh = false) {
    const targetZ = Math.min(coords.z, 14);
    const shift = coords.z - targetZ;
    const tx = coords.x >> shift;
    const ty = coords.y >> shift;

    const baseMask = await fetchBaseWaterMask(targetZ, tx, ty, forceRefresh);
    if (!baseMask) return null;
    return sliceMaskForZoom(baseMask, coords, targetZ);
  }

async function reloadMissingTiles(opts = {}) {
  if (opts.force || !opts.keepBackoff) {
    WaterNet.reset();
    if (!opts.onlyWater) resetDemNet();
    if (opts.force) _waterRetryAttempt = 0;
  }
  if (!WM.map) return 0;

  // При ручном принудительном обновлении полностью сбрасываем кэш и перерисовываем оба слоя DEM,
  // чтобы гарантированно вылечить тайлы с неверным масштабом, откат на резерв или ложный деблокинг.
  if (opts.force && !opts.onlyWater) {
    _bypassCacheUntil = Date.now() + 8000;
    _demCacheGen++;
    globalGeomVersion++;
    _degradedAttempt = 0;

    const visibleKeys = new Set();
    if (hillshadeLayerInstance && hillshadeLayerInstance._tiles && cfg.hillshadeEnabled) {
      for (const k in hillshadeLayerInstance._tiles) {
        const entry = hillshadeLayerInstance._tiles[k];
        if (entry?.el && !entry.el._removed) visibleKeys.add(k);
      }
    }
    if (contoursLayerInstance && contoursLayerInstance._tiles && cfg.contoursEnabled) {
      for (const k in contoursLayerInstance._tiles) {
        const entry = contoursLayerInstance._tiles[k];
        if (entry?.el && !entry.el._removed) visibleKeys.add(k);
      }
    }

    for (const img of demTileMemoryCache.values()) {
      evictDemImg(img);
    }
    demTileMemoryCache.clear();
    demInFlightPromises.clear();
    dem404Set.clear();
    clearPaddedDemCache();
    paddedInFlightPromises.clear();
    failedPrefetchTiles.clear();
    baseWaterMaskCache.clear();
    baseWaterMaskInFlight.clear();
    activeTileElevations.clear();
    lastViewportMinH = null;
    lastViewportMaxH = null;

    if (hillshadeLayerInstance && cfg.hillshadeEnabled && WM.map.hasLayer(hillshadeLayerInstance)) {
      hillshadeLayerInstance.redraw();
    }
    if (contoursLayerInstance && cfg.contoursEnabled && WM.map.hasLayer(contoursLayerInstance)) {
      contoursLayerInstance.redraw();
    }
    if (WM.terrainDecor && WM.terrainDecor.redraw) {
      WM.terrainDecor.redraw();
    }
    notifyDemChange(true, { sourceChanged: true });
    return visibleKeys.size || 1;
  }

  const srcKey = cfg.demSource || 'fabdem';
  const tasks = [];
  let successfullyRestored = 0;

  // 1. Проверяем тайлы отмывки (Hillshade) по реальному _tileZoom слоя
  if (hillshadeLayerInstance && hillshadeLayerInstance._tiles && cfg.hillshadeEnabled) {
    const hsZoom = (typeof hillshadeLayerInstance._tileZoom === 'number')
      ? hillshadeLayerInstance._tileZoom
      : Math.min(Math.round(WM.map.getZoom()), 17);

    const tiles = hillshadeLayerInstance._tiles;
    const pending = [];
    const waterKeysToClear = new Set();

    for (const key in tiles) {
      const entry = tiles[key];
      const el = entry?.el;
      const coords = entry?.coords;
      if (!el || !coords || el._removed || coords.z !== hsZoom) continue;

      const isDemDegraded = !opts.onlyWater && (
        !el._demImg ||
        el._demImg._degraded === true ||
        el._demImg._needsUpgrade === true ||
        (el._demImg._isEmptyFallback === true && el._demImg._degraded !== false)
      );

      // Подтверждённые 404 (_isEmpty404) и пустые маски перепроверяем только при ручном force
      const isWaterMaskMissing =
        !el._waterMaskData ||
        el._waterMaskData._isFallback ||
        el._waterMaskFailed ||
        (opts.force && (!el._waterMaskData._hasWater || el._waterMaskData._isEmpty404) && !el._waterMaskVerified);

      if (!isDemDegraded && !isWaterMaskMissing) continue;

      if (isDemDegraded) {
        const maxCoord = 1 << coords.z;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = (coords.x + dx + maxCoord) % maxCoord;
            const ny = coords.y + dy;
            const k = `${srcKey}:${coords.z}:${nx}:${ny}`;
            const oldImg = demTileMemoryCache.get(k);
            if (oldImg) {
              demTileMemoryCache.delete(k);
              evictDemImg(oldImg);
            }
            deletePaddedDemCache(k);
          }
        }
      }

      if (isWaterMaskMissing) {
        const targetZ = Math.min(coords.z, 14);
        const shift = coords.z - targetZ;
        const baseKey = `${targetZ}:${coords.x >> shift}:${coords.y >> shift}`;
        waterKeysToClear.add(baseKey);
      }

      pending.push({ el, coords, isDemDegraded, isWaterMaskMissing });
    }

    for (const baseKey of waterKeysToClear) {
      baseWaterMaskCache.delete(baseKey);
      baseWaterMaskInFlight.delete(baseKey);
    }

    for (const { el, coords, isDemDegraded, isWaterMaskMissing } of pending) {
      const wasBrokenOrMissing =
        !el._waterMaskData ||
        el._waterMaskData._isFallback ||
        el._waterMaskData._isEmpty404 ||
        el._waterMaskFailed;
      const hadWater = !!(el._waterMaskData && el._waterMaskData._hasWater);

      const maskTask = isWaterMaskMissing
        ? fetchWaterMaskTile(coords, !!opts.force).then(mask => {
            if (mask && !el._removed) {
              el._waterMaskData = mask;
              el._waterMaskFailed = !!mask._isFallback;
              if (opts.force && !mask._isFallback) {
                el._waterMaskVerified = true;
              }
              if (el._waterMaskTex && sharedGl) {
                sharedGl.deleteTexture(el._waterMaskTex);
                el._waterMaskTex = null;
              }
              el._lightSig = null;
              return (wasBrokenOrMissing && !mask._isFallback) || (mask._hasWater && !hadWater);
            }
            if (!el._removed) el._waterMaskFailed = true;
            return false;
          }).catch(() => false)
        : Promise.resolve(false);

      const demTask = isDemDegraded
        ? loadPaddedDemTile(coords).then(img => {
            if (img && !el._removed) {
              if (el._demImg && el._demImg !== img) {
                releasePaddedDem(el._demImg);
              }
              if (el._demImg !== img) {
                retainPaddedDem(img);
              }
              el._demImg = img;
              el._isEmptyFallback = !!img._isEmptyFallback;
              el._geomVersion = -1;
              el._lightSig = null;
              return !img._degraded && !img._isEmptyFallback;
            }
            return false;
          }).catch(() => false)
        : Promise.resolve(false);
      tasks.push(Promise.all([maskTask, demTask]).then(([mOk, dOk]) => {
        if (mOk || dOk) successfullyRestored++;
      }));
    }
  }

  // 2. Проверяем изолинии (Contours)
  if (!opts.onlyWater && contoursLayerInstance && contoursLayerInstance._tiles && cfg.contoursEnabled) {
    const ctZoom = (typeof contoursLayerInstance._tileZoom === 'number')
      ? contoursLayerInstance._tileZoom
      : Math.round(WM.map.getZoom());

    const tiles = contoursLayerInstance._tiles;
    for (const key in tiles) {
      const entry = tiles[key];
      const el = entry?.el;
      const coords = entry?.coords;
      if (!el || !coords || el._removed || coords.z !== ctZoom) continue;

      if (!el._contourRendered || el._demDegraded) {
        const cTask = loadPaddedDemTile(coords).then(img => {
          if (img && !el._removed) {
            retainPaddedDem(img);
            try {
              if (img._isEmptyFallback) {
                el._contourRendered = !img._degraded;
                el._demDegraded = !!img._degraded;
                return;
              }
              const nw = coords.scaleBy(contoursLayerInstance.getTileSize());
              const centerLL = WM.map.unproject(nw.add([128, 128]), coords.z);
              renderTileContours(img, coords.z, coords, centerLL, el);
              el._contourRendered = true;
              el._demDegraded = false;
              successfullyRestored++;
            } finally {
              releasePaddedDem(img);
            }
          }
        }).catch(() => {});
        tasks.push(cTask);
      }
    }
  }

  await Promise.allSettled(tasks);

  if (successfullyRestored > 0) {
    if (!opts.onlyWater && WM.terrainDecor && WM.terrainDecor.redraw) {
      WM.terrainDecor.redraw();
    }
    scheduleLiveHillshade(true);
  }
  return successfullyRestored;
}

  // =========================================================================
  // УМНОЕ РАСШИРЕНИЕ ВРЕМЕНИ (TIME WARP) ВОКРУГ ВОСХОДА И ЗАКАТА
  // =========================================================================
  function erf(x) {
    // Высокоточное приближение функции ошибок (Abramowitz & Stegun)
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  // Все часы здесь — МЕСТНОЕ СОЛНЕЧНОЕ ВРЕМЯ точки на карте: 12.0 = истинный полдень (SunCalc solarNoon).
  // Это не зависит от часового пояса браузера, поэтому восход/закат всегда считаются корректно.
  const _evCache = new Map();

  // tzlookup и Intl.toLocaleString — дорогие; при вращении ползунка времени они вызывались каждый кадр.
  let _tzLookupKey = null, _tzLookupVal = null;
  function tzLookupCached(lat, lng) {
    if (typeof tzlookup !== 'function') return null;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const k = lat + ',' + lng;
    if (k === _tzLookupKey) return _tzLookupVal;
    try {
      const v = tzlookup(lat, lng);
      _tzLookupKey = k;
      _tzLookupVal = v;
      return v;
    } catch (e) {
      return null;
    }
  }
  const _tzOffsetMemo = new Map();

  WM.timeWarp = {
    STEPS: 1440,
    SIGMA_K: 0.55,
    BOOST: 3.5,

    _ymd(date) {
      if (cfg && cfg.manualDateStr && /^\d{4}-\d{2}-\d{2}$/.test(cfg.manualDateStr)) {
        const p = cfg.manualDateStr.split('-').map(Number);
        return { y: p[0], m: p[1] - 1, d: p[2] };
      }
      const n = date instanceof Date ? date : new Date();
      return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
    },

    // Опорная метка: примерно солнечный полдень выбранной даты в точке lng
    _anchor(lng, date) {
      const { y, m, d } = this._ymd(date);
      return new Date(Date.UTC(y, m, d, 12) - (lng / 15) * 3600000);
    },

    getSunEvents(lat, lng, date) {
      lat = isFinite(lat) ? lat : 55.75; lng = isFinite(lng) ? lng : 37.62;
      const { y, m, d } = this._ymd(date);
      const key = `${y}-${m}-${d}|${lat.toFixed(1)}|${lng.toFixed(1)}`;
      if (_evCache.has(key)) return _evCache.get(key);
      let res = { rise: 6, set: 18, sigma: 0.7, valid: false, noon: null };
      if (window.SunCalc) {
        const anchor = this._anchor(lng, date);
        const t = SunCalc.getTimes(anchor, lat, lng);
        const ok = x => x && !isNaN(x.getTime());
        if (ok(t.solarNoon)) {
          const noon = t.solarNoon.getTime();
          res.noon = new Date(noon);
          const toH = x => 12 + (x.getTime() - noon) / 3600000;
          if (ok(t.sunrise) && ok(t.sunset)) {
            let rise = toH(t.sunrise), set = toH(t.sunset);
            let sigma = 0.7;
            if (ok(t.dawn)) sigma = Math.min(1.2, Math.max(0.4, (rise - toH(t.dawn)) * 0.55));
            res = { rise, set, sigma, valid: true, noon: res.noon };
          }
        }
      }
      if (_evCache.size > 200) _evCache.clear();
      _evCache.set(key, res);
      return res;
    },

    // Интеграл плотности: F(t) = t + boost * ∫ (гауссианы у восхода и заката)
    _F(t, ev) {
      const s = ev.sigma, k = this.BOOST * s * Math.sqrt(Math.PI / 2), r2 = s * Math.SQRT2;
      return t + k * (erf((t - ev.rise) / r2) - erf(-ev.rise / r2) + erf((t - ev.set) / r2) - erf(-ev.set / r2));
    },

    hourToSlider(hour, lat, lng, date) {
      const ev = this.getSunEvents(lat, lng, date);
      const h = clamp(hour, 0, 24);
      if (!ev.valid) return Math.round(h / 24 * this.STEPS);
      return clamp(Math.round(this._F(h, ev) / this._F(24, ev) * this.STEPS), 0, this.STEPS);
    },

    sliderToHour(v, lat, lng, date) {
      const ev = this.getSunEvents(lat, lng, date);
      v = clamp(v, 0, this.STEPS);
      if (!ev.valid) return v / this.STEPS * 24;
      const target = v / this.STEPS * this._F(24, ev);
      let lo = 0, hi = 24;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (this._F(mid, ev) < target) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    },

    // Солнечный час -> реальный момент времени
    hourToDate(hour, lat, lng, date) {
      const defaultCenter = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      lat = isFinite(lat) ? lat : defaultCenter.lat;
      lng = isFinite(lng) ? lng : defaultCenter.lng;

      const ev = this.getSunEvents(lat, lng, date);
      if (ev && ev.noon && !isNaN(ev.noon.getTime())) {
        return new Date(ev.noon.getTime() + (hour - 12.0) * 3600000);
      }

      // Резервный расчёт солнечного времени по долготе (если SunCalc недоступен)
      const { y, m, d } = this._ymd(date);
      const solarOffsetHours = lng / 15.0;
      const targetUtcMs = Date.UTC(y, m, d, 12, 0, 0) + (hour - 12.0 - solarOffsetHours) * 3600000;
      return new Date(targetUtcMs);
    }
  };

  let _demCacheGen = 0;
  let _bypassCacheUntil = 0;

  function isForceBypass() {
    return navigator.onLine !== false && Date.now() < _bypassCacheUntil;
  }

  const DEFAULT_CONFIG = {
    demSource: 'fabdem',
    demDeblock: true,
    demDeblockSigmaM: 60,  
    hillshadeEnabled: false, // <-- было true
    blendMode: 'normal',
    contourBlendMode: 'multiply',
    zFactor: 8.5,
    zFactorAuto: false,
    sunMode: 'time',
    manualTimeHour: 6.49233982710939,
    manualDateStr: '2026-10-27',
    sunAzimuth: 215,
    sunAltitude: 50,
    colorTone: 'none',
    smoothMode: 'gauss',
    hypsoMode: 'atlas',
    orenNayarRoughness: 1.05,
    specularDamp: 2.7,
    inkBleed: true,
    waterlining: false,
    waterlineColor: '#1c3d5a',
    waterlineWidth: 1.5,
    waterlineOpacity: 0.8,
    formLinesEnabled: true,
    formLinesSlopeMax: 0.035,

    waterTintEnabled: false,
    waterTintColor: '#2a4d69',
    waterTintOpacity: 0.50,          // 0.0 .. 1.0 (прозрачность, вплоть до 0)
    waterTintCoverage: 1.0,          // 0.05 .. 1.0 (1.0 = сплошная, <1.0 = стянуто к фарватеру/центру)
    waterTintBlendMode: 'multiply',  // 'normal' | 'multiply' | 'overlay' | 'softlight'

    // Окраска рельефа по дорогам и опушкам леса
    roadTintEnabled: false,
    roadTintColor: '#e0a952',
    roadTintOpacity: 0.75,
    roadTintZone: 14,          // ширина зоны, px (2..48)
    roadTintSoftness: 0.75,    // плавность спада (0.05..1.0)
    roadTintBlendMode: 'tint', // 'tint' | 'softlight' | 'overlay' | 'multiply' | 'screen' | 'normal'
    roadTintTypes: 'drive',    // 'drive' | 'major' | 'tracks' | 'all'

    edgeTintEnabled: false,
    edgeTintColor: '#7ca34b',
    edgeTintOpacity: 0.65,
    edgeTintZone: 18,          // ширина зоны, px (2..48)
    edgeTintSoftness: 0.80,    // плавность спада (0.05..1.0)
    edgeTintBlendMode: 'tint', // 'tint' | 'softlight' | 'overlay' | 'multiply' | 'screen' | 'normal'
    edgeTintSide: 'both',      // 'both' | 'outside' | 'inside'

    // =========================================================================
    // СТАРИННЫЕ ГРАВЮРНЫЕ ВОЛНЫ (CARTA MARINA 1539)
    // =========================================================================
    seaWavesEnabled: true,
    seaWaveStyle: 'ripples',       // 'ripples' (ксилография) | 'waves' (непрерывные) | 'woodcut' (клиновидные)
    seaWaveScale: 80.0,           // Длина волны (шаг по горизонтали, px)
    seaWaveSpacing: 5.5,          // Расстояние между параллельными линиями (px)
    seaWaveUndulation: 8.8,       // Амплитуда синусоидального изгиба (px)
    seaWaveThickness: 2.5,        // Толщина штриха резца (px)
    seaWaveRoughness: 1.0,        // Дрожание руки гравёра / резца (0..1)
    seaWaveOpacity: 0.40,         // Плотность чернил (0..1)
    seaWaveColor: '#272e3a',      // Цвет штриховки гравюры
    seaWaveShoreFade: 1.0,        // Мягкое затухание у кромки берега (0..1)
    seaWaveBlendMode: 'multiply', // Режим наложения чернил
    seaWaveFillEnabled: false,    // Винтажная заливка цвета воды
    seaWaveFillColor: '#252428',  // Тон подложки моря
    seaWaveFillOpacity: 0.68,     // Прозрачность тона воды

    opennessEnabled: false,
    opennessRadius: 1.0,
    opennessStrength: 0.85,
    opennessDiff: 0.5, // 0.0 = только тальвеги/овраги, 1.0 = только гребни, 0.5 = баланс

    // 2. Вторичный отскок света в ущельях (1-Bounce Indirect Radiosity)
    bounceEnabled: true,
    bounceStrength: 0.55,

    // 3. Контактное уплотнение и рассеивание теней (Contact Hardening Shadows)
    contactShadowsEnabled: true,
    penumbraScale: 0.65,

    // Художественный дизеринг и гравюра
    ditherEnabled: true,
    ditherType: 'woodcut',
    ditherBlendMode: 'multiply',
    ditherScale: 1.7,
    ditherAngle: 62,
    ditherDensity: 0.55,
    ditherThreshold: 0.3,
    ditherLowCut: 0.35,
    ditherSoftness: 0.95,
    ditherZone: 'shadows',
    ditherStrength: 1.7,
    ditherColor: '#422e00',

    // Усиление света и палитра
    lightBoost: 2.6,
    manualPeakColor: '#fe1691',
    manualScaleMode: 'relative', // 'relative' (по экрану) | 'fixed' (фиксированная в метрах)
    manualElevMin: 0,
    manualElevMax: 1500,
    manualMidColor: '#e8b074',
    manualValleyColor: '#a8863e',
    manualShadowColor: '#456327',
    manualLightBlend: 0.33,
    manualLightSoftness: 0.35,
    manualLightBlend2: 0.68,
    manualLightSoftness2: 0.35,

    // Швейцарская школа и многолучевая отмывка
    imhofDeflection: 1.2,
    mdowEnabled: false,
    mdowStrength: 0.65,

    // Штриховка (hachure)
    hachureEnabled: true,
    hachuring: true,
    hachureType: 'hybrid',
    hachureBlendMode: 'overlay',
    hachureDensity: 1.3,
    hachureLength: 1.0,           // <-- НОВОЕ: коэффициент длины штрихов
    hachureHybridThresh: 0.15,    // <-- НОВОЕ: уклон перехода (~15°)
    hachureHybridSharpness: 0.50, // <-- НОВОЕ: плавность/резкость смены ориентации
    hachureThinning: 0.6,
    hachureOpacity: 0.55,
    hachureSlope: 0.12,
    hachureColor: '#6f4020',
    hachureLightMod: 1,

    hachureStrength: 0.6,

    // Окклюзия окружения и SVF
    ambientOcclusion: true,
    aoStrength: 0.2,
    aoRadius: 0.6,
    aoSlopeBleed: 0,
    svfEnabled: true,
    svfStrength: 0.6,

    // Тени
    castShadows: true,
    shadowReach: 1,
    shadowOpacity: 1.95,

    imhofWarmCool: 0.8,
    lightWrap: 0.5,
    paperGrain: 1.15,
    hillshadeOpacity: 0.95,

    // Изолинии (горизонтали)
    contoursEnabled: false,
    contourStep: 50,
    contourPalette: 'custom',
    contourColor: '#47370a',
    contourMajorColor: '#4a2c17',
    contourOpacity: 0.6,
    contourWidth: 3.5,
    taperWithElevation: true,
    taperDirection: 'crests',
    taperStrength: 1.7,
    cliffHairlines: true,
    showLabels: true,
    contourLabelScope: 'auto',         // 'auto' | 'major' | 'all' | 'all_form'
    contourLabelOrient: 'readable',    // 'readable' | 'uphill' | 'horizontal'
    contourLabelStyle: 'halo',         // 'halo' | 'break' | 'pill'
    contourLabelDensity: 1.0,          // 0.25 .. 2.5
    contourLabelSize: 9.5,             // 7.5 .. 16 px
    contourLabelHaloWidth: 3.0,        // 1.0 .. 5.0 px
    contourLabelColorMode: 'auto',     // 'auto' (цвет линий) | 'custom'
    contourLabelColor: '#3a250b',
    contourLabelHaloColor: '#f7f1e1',
    contourLabelBreak: true,           // разрывать линию горизонтали под текстом
    contourLabelUnit: false,           // добавлять «м»
    contourLabelBold: true,            // жирный шрифт

    // Стили и сглаживание горизонталей
    contourStyle: 'standard',
    contourSmoothing: 'chaikin',
    contourSmoothChaikin: true,
    contourRoughness: 0.45,
    contourHandPressure: 0.1,
    tanakaHighlightColor: '#ffffff',
    tanakaShadowColor: '#3c1806',

    // Карандашная обводка (Outline)
    outlineEnabled: true,
    outlineType: 'valleys',
    outlineBlendMode: 'multiply',
    outlineColor: '#610000',
    outlineWidth: 1.8,
    outlineRoughness: 0.40,
    outlineTexture: 0.60,         // <-- НОВОЕ: фактура крошащегося графита
    outlineDensity: 0.65,         // <-- НОВОЕ: количество/порог выявления микрорельефа
    outlineThreshold: 0.25,
    outlineOpacity: 0.7,
    outlineLightMod: 0.45,

    // Отладка
    debugValley: false
  };




  let cfg = { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(localStorage.getItem('wm_dem_relief') || '{}');
    cfg = { ...DEFAULT_CONFIG, ...saved };
  } catch (e) {}

  if (localStorage.getItem('wm_dem_hillshade_enabled') !== null) {
    cfg.hillshadeEnabled = localStorage.getItem('wm_dem_hillshade_enabled') === 'true';
  }
  if (localStorage.getItem('wm_dem_contours_enabled') !== null) {
    cfg.contoursEnabled = localStorage.getItem('wm_dem_contours_enabled') === 'true';
  }

  // Ревизия конфига: растёт при любом изменении настроек (ключ для кэшей освещения и uniform-ов)
  let cfgRev = 0;
  let saveConfigTimer = null;
  function saveConfig() {
    cfgRev++;
    clearTimeout(saveConfigTimer);
    saveConfigTimer = setTimeout(flushConfig, 200);
  }

  let isResettingApp = false;


  function flushConfig() {
    // Если нажат полный сброс — запрещаем автосохранение
    if (window._wmResetting) return;

    try {
      localStorage.setItem('wm_dem_relief', JSON.stringify(cfg));
      localStorage.setItem('wm_dem_hillshade_enabled', cfg.hillshadeEnabled ? 'true' : 'false');
      localStorage.setItem('wm_dem_contours_enabled', cfg.contoursEnabled ? 'true' : 'false');
    } catch (e) {}
  }

  window.addEventListener('beforeunload', flushConfig);
  window.addEventListener('pagehide', flushConfig);
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * clamp(t, 0.0, 1.0);
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }

  function lerpVec3(a, b, t) {
    const s = clamp(t, 0.0, 1.0);
    return [
      a[0] + (b[0] - a[0]) * s,
      a[1] + (b[1] - a[1]) * s,
      a[2] + (b[2] - a[2]) * s
    ];
  }

  function normalizeVec3(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  const _hexCache = new Map();
  function hexToVec3(hex) {
    const key = hex || '#000000';
    let res = _hexCache.get(key);
    if (res) return res;
    const clean = key.replace('#', '');
    const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
    res = [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    if (_hexCache.size > 200) _hexCache.clear();
    _hexCache.set(key, res);
    return res;
  }

  let currentRegionalSpan = 60.0;

  function getEffectiveContourStep(zoom) {
    if (cfg.contourStep !== 'auto' && typeof cfg.contourStep === 'number' && cfg.contourStep > 0) {
      return cfg.contourStep;
    }
    if (zoom >= 16) return 5;
    if (zoom >= 14) return 10;
    if (zoom >= 12) return 25;
    if (zoom >= 10) return 50;
    return 100;
  }

  // =========================================================================
  // ТРЕКИНГ ДИАПАЗОНА ВЫСОТ
  // =========================================================================
  const activeTileElevations = new Map();
  let lastViewportMinH = null;
  let lastViewportMaxH = null;

  function registerTileElevation(coords, minH, maxH, blockMin = null, blockMax = null) {
    if (!coords || minH === Infinity || maxH === -Infinity) return;
    const key = `${coords.z}:${coords.x}:${coords.y}`;
    activeTileElevations.set(key, {
      minH, maxH, blockMin, blockMax,
      z: coords.z, x: coords.x, y: coords.y
    });
    if (activeTileElevations.size > 96) {
      const oldest = activeTileElevations.keys().next().value;
      activeTileElevations.delete(oldest);
    }
  }

  function computeTileElevationStats(cv) {
    const P = cv.width || 256;
    const S = cv._tileSize || 256;
    const B = cv._pad || 0;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const data = cv._demData || ctx.getImageData(0, 0, P, P).data;
    cv._demData = data;

    const blockMin = new Float32Array(64);
    const blockMax = new Float32Array(64);
    blockMin.fill(Infinity);
    blockMax.fill(-Infinity);

    let tileMin = Infinity;
    let tileMax = -Infinity;
    let validCount = 0;

    const step = S >= 256 ? 2 : 1;
    for (let ly = 0; ly < S; ly += step) {
      const py = B + ly;
      const by = Math.min(7, Math.floor((ly / S) * 8));
      const rowOff = py * P;
      for (let lx = 0; lx < S; lx += step) {
        const px = B + lx;
        const idx = (rowOff + px) * 4;
        if (data[idx + 3] < 30) continue;
        const raw = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
        if (raw < -1000.0) continue;
        const h = raw > 0.0 ? raw : 0.0;

        if (h < tileMin) tileMin = h;
        if (h > tileMax) tileMax = h;
        validCount++;

        const bx = Math.min(7, Math.floor((lx / S) * 8));
        const bi = by * 8 + bx;
        if (h < blockMin[bi]) blockMin[bi] = h;
        if (h > blockMax[bi]) blockMax[bi] = h;
      }
    }

    let paddedMax = tileMax;
    if (B > 0) {
      for (let py = 0; py < P; py += 4) {
        const rowOff = py * P;
        for (let px = 0; px < P; px += 4) {
          const idx = (rowOff + px) * 4;
          if (data[idx + 3] < 30) continue;
          const raw = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
          if (raw > paddedMax) paddedMax = raw;
        }
      }
    }

    if (validCount === 0 || tileMin === Infinity) return null;

    cv._minH = tileMin;
    cv._maxH = tileMax;
    cv._blockMin = blockMin;
    cv._blockMax = blockMax;
    cv._demMaxH = (paddedMax > -1000.0 ? paddedMax : 9000.0) + 5.0;
    return { minH: tileMin, maxH: tileMax, blockMin, blockMax };
  }

  // Внутри одного прохода updateLiveHillshade статистика не меняется — считаем один раз на зум
  let _frameStatsCache = null;
  function getViewportElevationStats(currentZoom) {
    if (_frameStatsCache) {
      const k = currentZoom !== undefined ? currentZoom : -1;
      let s = _frameStatsCache.get(k);
      if (!s) {
        s = _computeViewportElevationStats(currentZoom);
        _frameStatsCache.set(k, s);
      }
      return s;
    }
    return _computeViewportElevationStats(currentZoom);
  }

  function _computeViewportElevationStats(currentZoom) {
    if (!WM.map) {
      return { minH: 0, maxH: 500, span: 500 };
    }

    const bounds = WM.map.getBounds();
    const hasHs = hillshadeLayerInstance && WM.map.hasLayer(hillshadeLayerInstance) && typeof hillshadeLayerInstance._tileZoom === 'number';
    let z;
    if (currentZoom !== undefined) {
      z = Number.isInteger(currentZoom) ? currentZoom : (hasHs ? hillshadeLayerInstance._tileZoom : Math.round(currentZoom));
    } else {
      z = hasHs ? hillshadeLayerInstance._tileZoom : Math.round(WM.map.getZoom());
    }
    const tileSize = 256;

    const nwPoint = WM.map.project(bounds.getNorthWest(), z);
    const sePoint = WM.map.project(bounds.getSouthEast(), z);

    const minTx = Math.floor(nwPoint.x / tileSize);
    const maxTx = Math.floor(sePoint.x / tileSize);
    const minTy = Math.floor(nwPoint.y / tileSize);
    const maxTy = Math.floor(sePoint.y / tileSize);

    let vMin = Infinity;
    let vMax = -Infinity;
    let count = 0;

    for (let x = minTx; x <= maxTx; x++) {
      for (let y = minTy; y <= maxTy; y++) {
        const stat = activeTileElevations.get(`${z}:${x}:${y}`);
        if (!stat) continue;

        if (stat.blockMin && stat.blockMax) {
          const tileLeft = x * tileSize;
          const tileTop = y * tileSize;
          const visX0 = Math.max(0, nwPoint.x - tileLeft);
          const visX1 = Math.min(tileSize - 0.001, sePoint.x - tileLeft);
          const visY0 = Math.max(0, nwPoint.y - tileTop);
          const visY1 = Math.min(tileSize - 0.001, sePoint.y - tileTop);
          if (visX1 < visX0 || visY1 < visY0) continue;

          const bx0 = Math.max(0, Math.min(7, Math.floor((visX0 / tileSize) * 8)));
          const bx1 = Math.max(0, Math.min(7, Math.floor((visX1 / tileSize) * 8)));
          const by0 = Math.max(0, Math.min(7, Math.floor((visY0 / tileSize) * 8)));
          const by1 = Math.max(0, Math.min(7, Math.floor((visY1 / tileSize) * 8)));

          for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {
              const bi = by * 8 + bx;
              const bMin = stat.blockMin[bi];
              const bMax = stat.blockMax[bi];
              if (bMin <= bMax) {
                if (bMin < vMin) vMin = bMin;
                if (bMax > vMax) vMax = bMax;
                count++;
              }
            }
          }
        } else {
          if (stat.minH < vMin) vMin = stat.minH;
          if (stat.maxH > vMax) vMax = stat.maxH;
          count++;
        }
      }
    }

    if (count > 0 && vMin !== Infinity && vMax !== -Infinity) {
      const span = Math.max(1.0, vMax - vMin);
      lastViewportMinH = vMin;
      lastViewportMaxH = vMax;
      currentRegionalSpan = Math.max(5.0, span);
      return { minH: vMin, maxH: vMin + span, span };
    }

    const fallbackMin = (lastViewportMinH !== null) ? lastViewportMinH : 0.0;
    const fallbackSpan = Math.max(10.0, currentRegionalSpan || 400.0);
    return { minH: fallbackMin, maxH: fallbackMin + fallbackSpan, span: fallbackSpan };
  }
  function onMapMoveEnd() {
    if (isPeakViewForeground()) return;
    if (!cfg.contoursEnabled || !contoursLayerInstance || !WM.map || !cfg.taperWithElevation) return;
    const stats = getViewportElevationStats();
    if (stats.minH === Infinity || stats.maxH === -Infinity) return;

    if (lastViewportMinH === null) {
      lastViewportMinH = stats.minH;
      lastViewportMaxH = stats.maxH;
      return;
    }

    const span = Math.max(15, stats.span);
    if (Math.abs(stats.minH - lastViewportMinH) > span * 0.18 || Math.abs(stats.maxH - lastViewportMaxH) > span * 0.18) {
      lastViewportMinH = stats.minH;
      lastViewportMaxH = stats.maxH;
      clearTimeout(contoursRedrawTimer);
      contoursRedrawTimer = setTimeout(() => {
        if (contoursLayerInstance && cfg.contoursEnabled) {
          contoursLayerInstance.redraw();
        }
      }, 150);
    }
  }

  // =========================================================================
  // СГЛАЖИВАНИЕ ЧАЙКИНА И БЫСТРАЯ СБОРКА ПОЛИЛИНИЙ O(N)
  // =========================================================================
  function chaikinSmoothPolyline(points, iterations = 2) {
    if (!points || points.length < 3) return points;
    let current = points;
    const isClosed = Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1.0;

    for (let it = 0; it < iterations; it++) {
      const smoothed = [];
      const len = current.length;

      if (isClosed) {
        for (let i = 0; i < len - 1; i++) {
          const p0 = current[i];
          const p1 = current[i + 1];
          smoothed.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
          smoothed.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
        }
        smoothed.push(smoothed[0]);
      } else {
        smoothed.push(current[0]);
        for (let i = 0; i < len - 1; i++) {
          const p0 = current[i];
          const p1 = current[i + 1];
          smoothed.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
          smoothed.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
        }
        smoothed.push(current[len - 1]);
      }
      current = smoothed;
    }
    return current;
  }

  function buildPolylinesFast(segments) {
    if (!segments.length) return [];

    // Числовой 32-битный ключ (Smi в V8): 0 аллокаций памяти и 0 работы для Garbage Collector!
    const pKey = p => ((Math.round(p[0] * 8) & 0xFFFF) << 16) | (Math.round(p[1] * 8) & 0xFFFF);
    const adj = new Map();

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const k1 = pKey(s.p1);
      const k2 = pKey(s.p2);

      let a1 = adj.get(k1);
      if (!a1) { a1 = []; adj.set(k1, a1); }
      a1.push({ toKey: k2, pt: s.p2, segIdx: i });

      let a2 = adj.get(k2);
      if (!a2) { a2 = []; adj.set(k2, a2); }
      a2.push({ toKey: k1, pt: s.p1, segIdx: i });
    }

    const visitedSegs = new Uint8Array(segments.length);
    const polylines = [];

    for (let i = 0; i < segments.length; i++) {
      if (visitedSegs[i]) continue;
      visitedSegs[i] = 1;

      const poly = [segments[i].p1, segments[i].p2];

      let curKey = pKey(poly[poly.length - 1]);
      while (true) {
        const neighbors = adj.get(curKey);
        let found = false;
        if (neighbors) {
          for (let n = 0; n < neighbors.length; n++) {
            const edge = neighbors[n];
            if (!visitedSegs[edge.segIdx]) {
              visitedSegs[edge.segIdx] = 1;
              poly.push(edge.pt);
              curKey = edge.toKey;
              found = true;
              break;
            }
          }
        }
        if (!found) break;
      }

      curKey = pKey(poly[0]);
      while (true) {
        const neighbors = adj.get(curKey);
        let found = false;
        if (neighbors) {
          for (let n = 0; n < neighbors.length; n++) {
            const edge = neighbors[n];
            if (!visitedSegs[edge.segIdx]) {
              visitedSegs[edge.segIdx] = 1;
              poly.unshift(edge.pt);
              curKey = edge.toKey;
              found = true;
              break;
            }
          }
        }
        if (!found) break;
      }

      polylines.push(poly);
    }

    return polylines;
  }

  // Быстрый детерминированный псевдошум для стабильности тайлов при зуме
  function contourNoise(x, y, seed) {
    const s = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453123;
    return s - Math.floor(s);
  }

  // Применение карандашной текстуры (модификация точек in-place без аллокаций памяти)
  function applyPencilRoughness(points, roughness, iso) {
    if (roughness <= 0.01 || points.length < 2) return points;
    const amp = roughness * 2.2;
    const isoSeed = (iso % 100) * 0.13;
    const len = points.length;

    for (let i = 0; i < len; i++) {
      const p = points[i];
      let dx = 0, dy = 0;
      if (i === 0) {
        dx = points[1][0] - p[0];
        dy = points[1][1] - p[1];
      } else if (i === len - 1) {
        dx = p[0] - points[i - 1][0];
        dy = p[1] - points[i - 1][1];
      } else {
        dx = points[i + 1][0] - points[i - 1][0];
        dy = points[i + 1][1] - points[i - 1][1];
      }

      const dLen = Math.hypot(dx, dy) || 1.0;
      const nx = -dy / dLen;
      const ny = dx / dLen;

      const offset = (contourNoise(p[0] * 2.1, p[1] * 2.1, isoSeed) - 0.5) * 2.0 * amp;
      p[0] += nx * offset;
      p[1] += ny * offset;
    }
    return points;
  }

  // Отрисовка полилинии с переменным нажимом руки (увеличен CHUNK_SIZE, без poly.slice)
  function drawVariablePressurePolyline(ctx, poly, baseWidth, pressure, elevNorm, iso, isClosed) {
    const len = poly.length;
    if (len < 2) return;

    const elevFactor = clamp(1.0 + (1.0 - elevNorm * 2.0) * (pressure * 0.20), 0.8, 1.25);

    if (pressure <= 0.04) {
      ctx.lineWidth = Math.max(0.4, baseWidth * elevFactor);
      ctx.beginPath();
      drawSmoothContourPath(ctx, poly, isClosed);
      ctx.stroke();
      return;
    }

    // CHUNK_SIZE = 10 сокращает число вызовов ctx.stroke() в 3-4 раза без потери плавности
    const CHUNK_SIZE = 24;
    let startIdx = 0;
    let distAlong = 0;
    const isoPhase = (iso % 50) * 0.35;

    while (startIdx < len - 1) {
      const endIdx = Math.min(len - 1, startIdx + CHUNK_SIZE);
      distAlong += Math.hypot(poly[endIdx][0] - poly[startIdx][0], poly[endIdx][1] - poly[startIdx][1]);
      const handWave = Math.sin(distAlong * 0.06 + isoPhase) * 0.45;
      const curWidth = Math.max(0.4, baseWidth * elevFactor * (1.0 + pressure * handWave));

      ctx.lineWidth = curWidth;
      ctx.beginPath();
      // Передаём индексы напрямую, исключая poly.slice(...)
      drawSmoothContourPath(ctx, poly, false, startIdx, endIdx);
      ctx.stroke();

      startIdx = endIdx;
    }
  }



  function drawSmoothContourPath(ctx, points, isClosed, startIdx = 0, endIdx = points.length - 1) {
    const len = endIdx - startIdx + 1;
    if (len < 2) return;

    if (len === 2) {
      ctx.moveTo(points[startIdx][0], points[startIdx][1]);
      ctx.lineTo(points[endIdx][0], points[endIdx][1]);
      return;
    }

    if (isClosed && startIdx === 0 && endIdx === points.length - 1) {
      const startX = (points[endIdx][0] + points[0][0]) * 0.5;
      const startY = (points[endIdx][1] + points[0][1]) * 0.5;
      ctx.moveTo(startX, startY);

      for (let i = 0; i < len; i++) {
        const next = points[(i + 1) % len];
        const midX = (points[i][0] + next[0]) * 0.5;
        const midY = (points[i][1] + next[1]) * 0.5;
        ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
      }
    } else {
      ctx.moveTo(points[startIdx][0], points[startIdx][1]);

      for (let i = startIdx + 1; i < endIdx; i++) {
        const midX = (points[i][0] + points[i + 1][0]) * 0.5;
        const midY = (points[i][1] + points[i + 1][1]) * 0.5;
        ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
      }

      ctx.lineTo(points[endIdx][0], points[endIdx][1]);
    }
  }

  // =========================================================================
  // РЕНДЕР ГОРИЗОНТАЛЕЙ
  // =========================================================================

  function drawRoundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  // Exact 2D OBB Separating Axis Theorem overlap check
  function obbOverlaps(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const maxR = a.maxR + b.maxR;
    if (dx * dx + dy * dy > maxR * maxR) return false;

    const axes = [
      [a.ux, a.uy],
      [-a.uy, a.ux],
      [b.ux, b.uy],
      [-b.uy, b.ux]
    ];
    for (let i = 0; i < 4; i++) {
      const nx = axes[i][0];
      const ny = axes[i][1];
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = a.hw * Math.abs(a.ux * nx + a.uy * ny) + a.hh * Math.abs(-a.uy * nx + a.ux * ny);
      const rB = b.hw * Math.abs(b.ux * nx + b.uy * ny) + b.hh * Math.abs(-b.uy * nx + b.ux * ny);
      if (dist >= rA + rB) return false;
    }
    return true;
  }

  function samplePolyAtArc(poly, cum, s) {
    const n = poly.length;
    if (s <= 0) return { x: poly[0][0], y: poly[0][1] };
    if (s >= cum[n - 1]) return { x: poly[n - 1][0], y: poly[n - 1][1] };
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    const f = segLen > 1e-5 ? (s - cum[lo]) / segLen : 0;
    return {
      x: poly[lo][0] + (poly[hi][0] - poly[lo][0]) * f,
      y: poly[lo][1] + (poly[hi][1] - poly[lo][1]) * f
    };
  }

  function drawSmartContourLabels(ctx, labelTracks, smoothed, cols, rows, cellW, cellH, baseStep, baseStrokeColor, coords) {
    if (!labelTracks || !labelTracks.length) return;

    const scope = cfg.contourLabelScope || 'auto';
    const orient = cfg.contourLabelOrient || 'readable';
    const style = cfg.contourLabelStyle || 'halo';
    const density = clamp(cfg.contourLabelDensity !== undefined ? Number(cfg.contourLabelDensity) : 1.0, 0.25, 2.5);
    const fontSize = clamp(cfg.contourLabelSize !== undefined ? Number(cfg.contourLabelSize) : 9.5, 7, 18);
    const haloW = clamp(cfg.contourLabelHaloWidth !== undefined ? Number(cfg.contourLabelHaloWidth) : 3.0, 0.5, 6.0);
    const bold = cfg.contourLabelBold !== false;
    const addUnit = !!cfg.contourLabelUnit;
    const doBreak = (style === 'break') || (cfg.contourLabelBreak !== false);
    const textColor = (cfg.contourLabelColorMode === 'custom' && cfg.contourLabelColor)
      ? cfg.contourLabelColor
      : baseStrokeColor;
    const haloColor = cfg.contourLabelHaloColor || '#f7f1e1';

    ctx.save();
    ctx.font = `${bold ? '700' : '600'} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Приоритет: сначала основные (утолщённые), потом обычные, потом полугоризонтали
    labelTracks.sort((a, b) => {
      const pa = a.isMajor ? 0 : (a.isHalfStep ? 2 : 1);
      const pb = b.isMajor ? 0 : (b.isHalfStep ? 2 : 1);
      if (pa !== pb) return pa - pb;
      return a.iso - b.iso;
    });

    const stride = cols + 1;
    const sampleGridGrad = (x, y) => {
      const c = Math.max(1, Math.min(cols - 1, Math.round(x / cellW)));
      const r = Math.max(1, Math.min(rows - 1, Math.round(y / cellH)));
      const hL = smoothed[r * stride + (c - 1)];
      const hR = smoothed[r * stride + (c + 1)];
      const hU = smoothed[(r - 1) * stride + c];
      const hD = smoothed[(r + 1) * stride + c];
      if (hL < -1000 || hR < -1000 || hU < -1000 || hD < -1000) {
        return { gx: 0, gy: -1, gradMag: 0 };
      }
      const gx = (hR - hL) / (2 * cellW);
      const gy = (hD - hU) / (2 * cellH);
      return { gx, gy, gradMag: Math.hypot(gx, gy) };
    };

    const widthCache = new Map();
    const getTextWidth = (t) => {
      let w = widthCache.get(t);
      if (w === undefined) {
        w = ctx.measureText(t).width;
        widthCache.set(t, w);
      }
      return w;
    };

    const placedBoxes = [];
    const placedLabels = [];
    const maxTileLabels = Math.round(16 * density);
    const extraGap = lerp(16, 4, clamp((density - 0.3) / 2.2, 0, 1));
    const baseRepeat = 185 / density;

    for (let ti = 0; ti < labelTracks.length; ti++) {
      if (placedLabels.length >= maxTileLabels) break;
      const track = labelTracks[ti];

      // В режиме 'auto' обычные горизонтали подписываются реже, чем основные
      let repeatStep = baseRepeat;
      if (!track.isMajor) {
        if (scope === 'auto') repeatStep = baseRepeat * 1.65;
        else if (track.isHalfStep) repeatStep = baseRepeat * 1.9;
        else repeatStep = baseRepeat * 1.25;
      }

      const labelText = Math.round(track.iso) + (addUnit ? ' м' : '');
      const textW = getTextWidth(labelText);
      const halfSpan = Math.max(11, textW * 0.56);
      const minPolyLen = textW + 16;

      // Отступ от соседних меток (больше для минорных в auto-режиме)
      const clearX = textW * 0.5 + 8 + extraGap * 0.5;
      const clearY = fontSize * 0.5 + 5 + extraGap * (track.isMajor ? 0.45 : 0.7);
      const sameIsoMinDist = repeatStep * 0.65;
      const sameIsoPts = [];

      // Сортируем полилинии по длине (сначала самые длинные и протяжённые)
      const polys = track.polylines;
      for (let pi = 0; pi < polys.length; pi++) {
        if (placedLabels.length >= maxTileLabels) break;
        const poly = polys[pi];
        const n = poly.length;
        if (n < 3) continue;

        const cum = new Float32Array(n);
        for (let k = 1; k < n; k++) {
          cum[k] = cum[k - 1] + Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]);
        }
        const totalLen = cum[n - 1];
        if (totalLen < minPolyLen) continue;

        const usableStart = halfSpan;
        const usableEnd = totalLen - halfSpan;
        if (usableEnd <= usableStart) continue;

        // Детерминированный сдвиг фазы по высоте, чтобы метки на соседних изолиниях не выстраивались в шеренгу
        const usableLen = usableEnd - usableStart;
        const phase = (((Math.round(track.iso) * 37 + (coords ? (coords.x * 13 + coords.y * 29) : 0)) % 97) + 97) % 97 / 97;
        const winCount = Math.max(1, Math.floor(usableLen / repeatStep) + 1);
        const winSize = usableLen / winCount;

        for (let w = 0; w < winCount; w++) {
          if (placedLabels.length >= maxTileLabels) break;
          const wStart = usableStart + w * winSize;
          const wEnd = Math.min(usableEnd, wStart + winSize);
          const stepS = Math.max(6, Math.min(10, (wEnd - wStart) / 6));

          let bestCand = null;
          const offsetS = (phase * 0.35) * Math.min(stepS, (wEnd - wStart) * 0.3);

          for (let s = wStart + offsetS; s <= wEnd; s += stepS) {
            const pt = samplePolyAtArc(poly, cum, s);
            const pBack = samplePolyAtArc(poly, cum, s - halfSpan);
            const pFwd = samplePolyAtArc(poly, cum, s + halfSpan);

            const dx = pFwd.x - pBack.x;
            const dy = pFwd.y - pBack.y;
            const chord = Math.hypot(dx, dy);
            if (chord < 6) continue;

            const straightness = chord / (2 * halfSpan);
            if (straightness < 0.90) continue;

            const midErr = Math.abs(dy * pt.x - dx * pt.y + pFwd.x * pBack.y - pFwd.y * pBack.x) / chord;
            const maxMidErr = 3.8 + (cfg.contourRoughness || 0) * 2.5;
            if (midErr > maxMidErr) continue;

            let ang = 0;
            const grad = sampleGridGrad(pt.x, pt.y);

            if (orient === 'horizontal') {
              ang = 0;
            } else {
              ang = Math.atan2(dy, dx);
              if (orient === 'uphill' && grad.gradMag > 1e-4) {
                const dotUp = Math.sin(ang) * grad.gx - Math.cos(ang) * grad.gy;
                if (dotUp < 0) ang += Math.PI;
              } else {
                // 'readable' (или фоллбэк на ровном плато)
                while (ang > Math.PI) ang -= Math.PI * 2;
                while (ang <= -Math.PI) ang += Math.PI * 2;
                if (ang > Math.PI * 0.5 || ang < -Math.PI * 0.5) ang += Math.PI;
              }
            }

            const cosA = Math.cos(ang);
            const sinA = Math.sin(ang);

            // Проверка отступа от краёв тайла, чтобы подпись не обрезалась
            const halfW = textW * 0.5 + 5;
            const halfH = fontSize * 0.5 + 4;
            const marginX = Math.max(12, halfW * Math.abs(cosA) + halfH * Math.abs(sinA) + 2);
            const marginY = Math.max(12, halfW * Math.abs(sinA) + halfH * Math.abs(cosA) + 2);
            if (pt.x < marginX || pt.x > 256 - marginX || pt.y < marginY || pt.y > 256 - marginY) continue;

            // Дистанция до меток этой же высоты
            let tooCloseSame = false;
            for (let si = 0; si < sameIsoPts.length; si++) {
              if (Math.hypot(pt.x - sameIsoPts[si].x, pt.y - sameIsoPts[si].y) < sameIsoMinDist) {
                tooCloseSame = true;
                break;
              }
            }
            if (tooCloseSame) continue;

            const box = {
              x: pt.x,
              y: pt.y,
              ux: cosA,
              uy: sinA,
              hw: clearX,
              hh: clearY,
              maxR: Math.hypot(clearX, clearY)
            };

            let collides = false;
            for (let bi = 0; bi < placedBoxes.length; bi++) {
              if (obbOverlaps(box, placedBoxes[bi])) {
                collides = true;
                break;
              }
            }
            if (collides) continue;

            // Оценка качества места: ровность линии + ширина зазора до соседних горизонталей
            const gapPx = grad.gradMag > 1e-4 ? (baseStep / grad.gradMag) : 60;
            const gapScore = Math.min(1.0, gapPx / 26.0);
            const edgePref = 1.0 - (Math.hypot(pt.x - 128, pt.y - 128) / 181) * 0.2;
            const score = straightness * 3.0 + gapScore * 1.6 - midErr * 0.25 + edgePref;

            if (!bestCand || score > bestCand.score) {
              bestCand = { x: pt.x, y: pt.y, ang, text: labelText, textW, box, score };
            }
          }

          if (bestCand) {
            placedBoxes.push(bestCand.box);
            sameIsoPts.push({ x: bestCand.x, y: bestCand.y });
            placedLabels.push(bestCand);
          }
        }
      }
    }

    if (!placedLabels.length) {
      ctx.restore();
      return;
    }

    // Проход 1: аккуратный разрыв самих линий горизонталей под метками
    if (doBreak) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = '#000000';
      for (let i = 0; i < placedLabels.length; i++) {
        const lbl = placedLabels[i];
        ctx.save();
        ctx.translate(lbl.x, lbl.y);
        ctx.rotate(lbl.ang);
        const rw = lbl.textW + (style === 'pill' ? 8 : 6);
        const rh = fontSize + (style === 'pill' ? 5 : 3);
        drawRoundedRectPath(ctx, -rw * 0.5, -rh * 0.5, rw, rh, 3.5);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    // Проход 2: отрисовка текста / ореола / плашки
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < placedLabels.length; i++) {
      const lbl = placedLabels[i];
      ctx.save();
      ctx.translate(lbl.x, lbl.y);
      ctx.rotate(lbl.ang);

      if (style === 'pill') {
        const pw = lbl.textW + haloW * 2 + 4;
        const ph = fontSize + haloW + 2;
        ctx.fillStyle = haloColor;
        ctx.globalAlpha = 0.88;
        drawRoundedRectPath(ctx, -pw * 0.5, -ph * 0.5, pw, ph, 4);
        ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = textColor;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      } else if (style === 'halo') {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = haloW;
        ctx.strokeStyle = haloColor;
        ctx.globalAlpha = 0.92;
        ctx.strokeText(lbl.text, 0, 0);
        ctx.globalAlpha = 1.0;
      }

      ctx.fillStyle = textColor;
      ctx.fillText(lbl.text, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }
  function renderTileContours(paddedImg, zoom = 14, coords = null, centerLatLng = null, targetCanvas = null) {
    const canvas = targetCanvas || document.createElement('canvas');
    if (!targetCanvas) {
      canvas.width = 256;
      canvas.height = 256;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);

    const baseStrokeColor = (cfg.contourPalette === 'sepia') ? '#78350f' : (cfg.contourColor || '#b45309');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const P = paddedImg.width || 256;
    const S = paddedImg._tileSize || 256;
    const B = paddedImg._pad || 0;

    const COLS = 64;
    const ROWS = 64;
    const cellW = 256.0 / COLS;
    const cellH = 256.0 / ROWS;

    let smoothed = paddedImg._contourSmoothed;
    let minH = paddedImg._contourMinH;
    let maxH = paddedImg._contourMaxH;

    // Считаем сглаженную сетку высот ТОЛЬКО один раз на тайл:
    if (!smoothed) {
      let data = paddedImg._demData;
      if (!data) {
        const pCtx = paddedImg.getContext('2d', { willReadFrequently: true });
        data = pCtx.getImageData(0, 0, P, P).data;
        paddedImg._demData = data;
      }

      const PAD = 2;
      const gridW = COLS + 1 + PAD * 2;
      const gridH = ROWS + 1 + PAD * 2;
      const rawGrid = new Float32Array(gridW * gridH);

      let rawMin = Infinity, rawMax = -Infinity;
      let validCount = 0;

      for (let r = -PAD; r <= ROWS + PAD; r++) {
        const py = Math.min(P - 1, Math.max(0, Math.round(B + r * (S / ROWS))));
        const gRow = r + PAD;
        const rowOff = gRow * gridW;

        for (let c = -PAD; c <= COLS + PAD; c++) {
          const px = Math.min(P - 1, Math.max(0, Math.round(B + c * (S / COLS))));
          const idx = (py * P + px) * 4;

          if (data[idx + 3] < 30) {
            rawGrid[rowOff + (c + PAD)] = -99999;
            continue;
          }

          const h = (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
          if (h < -1000) {
            rawGrid[rowOff + (c + PAD)] = -99999;
            continue;
          }

          rawGrid[rowOff + (c + PAD)] = h;
          validCount++;
          if (h < rawMin) rawMin = h;
          if (h > rawMax) rawMax = h;
        }
      }

      if (validCount < 16 || rawMin === Infinity) return canvas;

      // Сепарабельное 1D-сглаживание (в 2.5 раза быстрее двумерного цикла 5x5)
      const tempH = new Float32Array((COLS + 1) * gridH);
      for (let r = 0; r < gridH; r++) {
        const rIn = r * gridW;
        const rOut = r * (COLS + 1);
        for (let c = 0; c <= COLS; c++) {
          const cRaw = c + PAD;
          const cVal = rawGrid[rIn + cRaw];
          if (cVal < -1000) {
            tempH[rOut + c] = -99999;
            continue;
          }
          let acc = cVal * 6, wAcc = 6;
          const vL1 = rawGrid[rIn + cRaw - 1], vR1 = rawGrid[rIn + cRaw + 1];
          const vL2 = rawGrid[rIn + cRaw - 2], vR2 = rawGrid[rIn + cRaw + 2];
          if (vL1 > -1000) { acc += vL1 * 4; wAcc += 4; }
          if (vR1 > -1000) { acc += vR1 * 4; wAcc += 4; }
          if (vL2 > -1000) { acc += vL2; wAcc += 1; }
          if (vR2 > -1000) { acc += vR2; wAcc += 1; }
          tempH[rOut + c] = acc / wAcc;
        }
      }

      smoothed = new Float32Array((COLS + 1) * (ROWS + 1));
      minH = Infinity; maxH = -Infinity;
      for (let r = 0; r <= ROWS; r++) {
        const rRaw = r + PAD;
        const outRow = r * (COLS + 1);
        for (let c = 0; c <= COLS; c++) {
          const cVal = tempH[rRaw * (COLS + 1) + c];
          if (cVal < -1000) {
            smoothed[outRow + c] = -99999;
            continue;
          }
          let acc = cVal * 6, wAcc = 6;
          const vU1 = tempH[(rRaw - 1) * (COLS + 1) + c], vD1 = tempH[(rRaw + 1) * (COLS + 1) + c];
          const vU2 = tempH[(rRaw - 2) * (COLS + 1) + c], vD2 = tempH[(rRaw + 2) * (COLS + 1) + c];
          if (vU1 > -1000) { acc += vU1 * 4; wAcc += 4; }
          if (vD1 > -1000) { acc += vD1 * 4; wAcc += 4; }
          if (vU2 > -1000) { acc += vU2; wAcc += 1; }
          if (vD2 > -1000) { acc += vD2; wAcc += 1; }
          const val = acc / wAcc;
          smoothed[outRow + c] = val;
          if (val < minH) minH = val;
          if (val > maxH) maxH = val;
        }
      }

      paddedImg._contourSmoothed = smoothed;
      paddedImg._contourMinH = minH;
      paddedImg._contourMaxH = maxH;
    }

    if (coords) {
      if (paddedImg._blockMin && paddedImg._blockMax) {
        registerTileElevation(coords, paddedImg._minH ?? minH, paddedImg._maxH ?? maxH, paddedImg._blockMin, paddedImg._blockMax);
      } else {
        registerTileElevation(coords, minH, maxH);
      }
    }

    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const baseW = Math.min(5.0, Math.max(0.5, cfg.contourWidth || 1.5));

    // 1. Хранилище траекторий для умной расстановки меток ПОСЛЕ отрисовки всех линий
    const labelTracks = [];
    const labelScope = cfg.contourLabelScope || 'auto';
    const shouldLabelIso = (isMajor, isHalfStep) => {
      if (cfg.showLabels === false) return false;
      if (labelScope === 'major') return isMajor;
      if (labelScope === 'all' || labelScope === 'auto') return !isHalfStep;
      return true; // 'all_form'
    };

    const taperEnabled = !!cfg.taperWithElevation;
    const taperStrength = cfg.taperStrength !== undefined ? cfg.taperStrength : 0.60;
    const taperDir = cfg.taperDirection || 'crests';
    const isTanaka = cfg.contourStyle === 'tanaka';
    const useChaikin = cfg.contourSmoothing === 'chaikin' && !isTanaka;

    const vStats = getViewportElevationStats(zoom);
    const screenMin = (vStats.minH !== Infinity) ? vStats.minH : minH;
    const screenSpan = (vStats.span > 5.0) ? vStats.span : Math.max(40.0, maxH - minH);

    let sunDir2D = null;
    if (isTanaka) {
      const cLat = centerLatLng ? centerLatLng.lat : 55.75;
      const cLng = centerLatLng ? centerLatLng.lng : 37.62;
      const sunLighting = getSunLighting(cLat, cLng);
      sunDir2D = normalizeVec3([sunLighting.sunVec[0], -sunLighting.sunVec[1], 0.0]);
    }

    const baseStep = getEffectiveContourStep(zoom);
    const cellMetersDen = Math.max(1.0, cellW * ((156543.03392 * Math.cos(((centerLatLng ? centerLatLng.lat : 55) * Math.PI) / 180)) / Math.pow(2, zoom)));
    const formSlopeMax = cfg.formLinesSlopeMax || 0.04;
    const useFormLines = !!cfg.formLinesEnabled;
    const loopStep = useFormLines ? (baseStep * 0.5) : baseStep;
    const safeMinH = Math.max(1.5, minH);
    const startIso = Math.ceil(safeMinH / loopStep) * loopStep;
    const firstContour = Math.max(loopStep, startIso);
    if (firstContour > maxH) return canvas;

    const kFirst = Math.round(firstContour / loopStep);
    const kLast  = Math.floor(maxH / loopStep + 1e-9);
    const numBuckets = kLast - kFirst + 1;
    if (numBuckets <= 0) return canvas;

    // Быстрый массив вместо Map() исключает коллизии хэшей и мусор для GC
    const buckets = new Array(numBuckets);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const tl = smoothed[r * (COLS + 1) + c],       tr = smoothed[r * (COLS + 1) + c + 1];
        const bl = smoothed[(r + 1) * (COLS + 1) + c], br = smoothed[(r + 1) * (COLS + 1) + c + 1];
        if (tl < -1000 || tr < -1000 || bl < -1000 || br < -1000) continue;
        const lo = Math.min(tl, tr, bl, br), hi = Math.max(tl, tr, bl, br);
        if (hi - lo < 0.05) continue;
        let k0 = Math.floor(lo / loopStep) + 1; if (k0 < kFirst) k0 = kFirst;
        let k1 = Math.floor(hi / loopStep);     if (k1 > kLast)  k1 = kLast;
        for (let k = k0; k <= k1; k++) {
          const bIdx = k - kFirst;
          if (bIdx >= 0 && bIdx < numBuckets) {
            let a = buckets[bIdx];
            if (!a) { a = []; buckets[bIdx] = a; }
            a.push(r * COLS + c);
          }
        }
      }
    }

    for (let iso = firstContour; iso <= maxH; iso += loopStep) {
      const bIdx = Math.round(iso / loopStep) - kFirst;
      const cells = (bIdx >= 0 && bIdx < numBuckets) ? buckets[bIdx] : null;
      if (!cells || !cells.length) continue;

      const isHalfStep = useFormLines && (Math.abs(iso % baseStep) > 0.001);
      const isMajor = !isHalfStep && (Math.round(iso / baseStep) % 5 === 0);
      let targetWidth = isMajor ? (baseW * 1.6) : (isHalfStep ? baseW * 0.75 : baseW);

      if (taperEnabled && taperStrength > 0.01) {
        const elevNorm = clamp((iso - screenMin) / screenSpan, 0.0, 1.0);
        const factor = (taperDir === 'crests') 
          ? (1.0 - elevNorm * taperStrength) 
          : ((1.0 - taperStrength) + elevNorm * taperStrength);
        targetWidth = Math.max(0.45, Math.min(baseW * 1.8, targetWidth * clamp(factor, 0.25, 1.25)));
      }

      const segments = [];

      for (let ci = 0; ci < cells.length; ci++) {
        const idx = cells[ci];
        const r = (idx / COLS) | 0;
        const c = idx - r * COLS;
        const y0 = r * cellH, y1 = (r + 1) * cellH;
        const x0 = c * cellW, x1 = (c + 1) * cellW;

        const tl = smoothed[r * (COLS + 1) + c];
        const tr = smoothed[r * (COLS + 1) + (c + 1)];
        const bl = smoothed[(r + 1) * (COLS + 1) + c];
        const br = smoothed[(r + 1) * (COLS + 1) + (c + 1)];

        if (tl < -1000 || tr < -1000 || bl < -1000 || br < -1000) continue;

        const cMin = Math.min(tl, tr, bl, br);
        const cMax = Math.max(tl, tr, bl, br);
        if (cMin <= 0.2 && (cMax - cMin) > 2.0 && iso <= cMin + (cMax - cMin) * 0.7) {
          continue;
        }

        let mask = 0;
        if (tl >= iso) mask |= 8;
        if (tr >= iso) mask |= 4;
        if (br >= iso) mask |= 2;
        if (bl >= iso) mask |= 1;

        if (mask === 0 || mask === 15) continue;

        const topX = x0 + ((iso - tl) / (tr - tl || 1e-5)) * cellW;
        const botX = x0 + ((iso - bl) / (br - bl || 1e-5)) * cellW;
        const leftY = y0 + ((iso - tl) / (bl - tl || 1e-5)) * cellH;
        const rightY = y0 + ((iso - tr) / (br - tr || 1e-5)) * cellH;

        const dzdx = ((tr + br) - (tl + bl)) * 0.5;
        const dzdy = ((bl + br) - (tl + tr)) * 0.5;

        const cellSlope = isHalfStep ? Math.hypot(dzdx, dzdy) / cellMetersDen : 0.0;
        const cellDiff = cMax - cMin;

        if (isHalfStep && cellDiff <= 2.05 && cellSlope < (formSlopeMax * 0.3)) {
          continue;
        }

        const addSeg = (pA, pB) => {
          segments.push({ p1: pA, p2: pB, dzdx, dzdy });
        };

        switch (mask) {
          case 1: case 14: addSeg([x0, leftY], [botX, y1]); break;
          case 2: case 13: addSeg([botX, y1], [x1, rightY]); break;
          case 3: case 12: addSeg([x0, leftY], [x1, rightY]); break;
          case 4: case 11: addSeg([topX, y0], [x1, rightY]); break;
          case 5:
            addSeg([x0, leftY], [topX, y0]);
            addSeg([botX, y1], [x1, rightY]);
            break;
          case 6: case 9: addSeg([topX, y0], [botX, y1]); break;
          case 7: case 8: addSeg([x0, leftY], [topX, y0]); break;
          case 10:
            addSeg([topX, y0], [x1, rightY]);
            addSeg([x0, leftY], [botX, y1]);
            break;
        }
        // (Старый примитивный блок рисования меток здесь удалён)
      }

      if (!segments.length) continue;

      ctx.save();
      if (isHalfStep) {
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = (cfg.contourOpacity || 0.85) * 0.55;
      } else {
        ctx.setLineDash([]);
        ctx.globalAlpha = cfg.contourOpacity || 0.85;
      }

      // 2. Сюда сохраним собранные полилинии, если работает сглаживание Chaikin
      let builtPolys = null;

      if (isTanaka) {
        const NUM_BINS = 24;
        const bins = new Array(NUM_BINS);
        for (let b = 0; b < NUM_BINS; b++) bins[b] = [];

        for (let s = 0; s < segments.length; s++) {
          const seg = segments[s];
          const normLen = Math.hypot(seg.dzdx, seg.dzdy) || 1.0;
          const normX = -seg.dzdx / normLen;
          const normY = -seg.dzdy / normLen;
          const dotSun = clamp(normX * sunDir2D[0] + normY * sunDir2D[1], -1.0, 1.0);

          const binIdx = Math.min(NUM_BINS - 1, Math.floor(((dotSun + 1.0) * 0.5) * NUM_BINS));
          bins[binIdx].push(seg);
        }

        for (let b = 0; b < NUM_BINS; b++) {
          const segList = bins[b];
          if (!segList.length) continue;

          const dotSun = ((b + 0.5) / NUM_BINS) * 2.0 - 1.0;
          let strokeCol;
          let w;

          if (dotSun > 0.0) {
            const alpha = 0.4 + 0.6 * dotSun;
            strokeCol = `rgba(255, 250, 230, ${alpha.toFixed(2)})`;
            w = targetWidth * (0.8 + 1.2 * dotSun);
          } else {
            const shadowCos = -dotSun;
            const alpha = 0.4 + 0.6 * shadowCos;
            strokeCol = `rgba(20, 10, 5, ${alpha.toFixed(2)})`;
            w = targetWidth * (0.8 + 1.2 * shadowCos);
          }

          ctx.beginPath();
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = w;
          for (let s = 0; s < segList.length; s++) {
            const seg = segList[s];
            ctx.moveTo(seg.p1[0], seg.p1[1]);
            ctx.lineTo(seg.p2[0], seg.p2[1]);
          }
          ctx.stroke();
        }
      } else if (useChaikin) {
        let polylineList = buildPolylinesFast(segments);
        builtPolys = polylineList; // <-- Сохраняем, чтобы не пересчитывать второй раз

        ctx.strokeStyle = baseStrokeColor;
        ctx.lineWidth = targetWidth;

        const roughness = cfg.contourRoughness || 0.0;
        const pressure = cfg.contourHandPressure || 0.0;
        const elevNorm = clamp((iso - screenMin) / screenSpan, 0.0, 1.0);

        if (roughness > 0.02) {
          ctx.setLineDash([16, 1.2 * roughness, 8, 0.8 * roughness]);
        } else {
          ctx.setLineDash([]);
        }

        for (let p = 0; p < polylineList.length; p++) {
          let poly = polylineList[p];
          if (poly.length < 2) continue;

          if (roughness > 0.01) {
            poly = applyPencilRoughness(poly, roughness, iso);
          }

          const isClosed = Math.hypot(
            poly[0][0] - poly[poly.length - 1][0],
            poly[0][1] - poly[poly.length - 1][1]
          ) < 2.0;

          if (pressure > 0.02) {
            drawVariablePressurePolyline(ctx, poly, targetWidth, pressure, elevNorm, iso, isClosed);
          } else {
            ctx.beginPath();
            drawSmoothContourPath(ctx, poly, isClosed);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      } else {
        ctx.beginPath();
        for (let s = 0; s < segments.length; s++) {
          ctx.moveTo(segments[s].p1[0], segments[s].p1[1]);
          ctx.lineTo(segments[s].p2[0], segments[s].p2[1]);
        }
        ctx.strokeStyle = baseStrokeColor;
        ctx.lineWidth = targetWidth;
        ctx.stroke();
      }
      ctx.restore();

      // 3. Собираем полилинии этой высоты в общий список для последующей расстановки меток
      if (shouldLabelIso(isMajor, isHalfStep)) {
        const labelPolys = builtPolys || buildPolylinesFast(segments);
        if (labelPolys && labelPolys.length) {
          labelTracks.push({ iso, isMajor, isHalfStep, polylines: labelPolys });
        }
      }
    }

    // 4. Все линии на тайле уже нарисованы — теперь красиво и без пересечений рисуем метки
    if (cfg.showLabels !== false && labelTracks.length > 0) {
      drawSmartContourLabels(ctx, labelTracks, smoothed, COLS, ROWS, cellW, cellH, baseStep, baseStrokeColor, coords);
    }

    return canvas;
  }

  function getEffectiveZFactor() {
    if (!cfg.zFactorAuto && typeof cfg.zFactor === 'number') {
      return cfg.zFactor;
    }
    const span = Math.max(5.0, currentRegionalSpan);
    const autoZ = 1.2 + 8.8 * Math.exp(-span / 260.0);
    return Math.max(1.1, Math.min(10.0, Math.round(autoZ * 10) / 10));
  }

  function getEffectiveSunDate(lat, lng) {
    const h = cfg.manualTimeHour !== undefined ? cfg.manualTimeHour : 12;
    return WM.timeWarp.hourToDate(h, lat, lng, new Date());
  }

  // Плавная интерполяция по ступеням палитры (stops отсортированы по возрастанию высоты Солнца)
  function sampleRamp(stops, alt) {
    const n = stops.length;
    if (alt <= stops[0].a) return stops[0];
    if (alt >= stops[n - 1].a) return stops[n - 1];
    for (let i = 0; i < n - 1; i++) {
      const s0 = stops[i], s1 = stops[i + 1];
      if (alt <= s1.a) {
        const lin = (alt - s0.a) / (s1.a - s0.a);
        const t = 0.5 * lin + 0.5 * (lin * lin * (3.0 - 2.0 * lin)); // линейный + ease: без «ступенек»
        return {
          light: lerpVec3(s0.light, s1.light, t),
          shadow: lerpVec3(s0.shadow, s1.shadow, t),
          sky: lerpVec3(s0.sky, s1.sky, t),
          k: lerp(s0.k, s1.k, t)
        };
      }
    }
    return stops[n - 1];
  }

  // =========================================================================
  // РАСЧЕТ ОСВЕЩЕНИЯ
  // =========================================================================
  function getSunLighting(centerLat, centerLng) {
    const TONE_PALETTES = {
      imhof:   { light: [1.00, 0.97, 0.92], shadow: [0.28, 0.32, 0.41], warmCool: 1.0 },
      slate:   { light: [0.96, 0.97, 0.98], shadow: [0.16, 0.20, 0.30], warmCool: 0.5 },
      day:     { light: [1.00, 0.98, 0.94], shadow: [0.30, 0.33, 0.40], warmCool: 0.3 },
      sunrise: { light: [1.02, 0.82, 0.62], shadow: [0.34, 0.22, 0.44], warmCool: 1.1 },
      sunset:  { light: [1.00, 0.60, 0.36], shadow: [0.24, 0.18, 0.42], warmCool: 1.2 },
      moon:    { light: [0.65, 0.82, 1.05], shadow: [0.035, 0.055, 0.12], warmCool: 0.85 },
      neutral: { light: [1.25, 1.20, 1.10], shadow: [0.12, 0.14, 0.22], warmCool: 0.6 }
    };

    const chosenTone = TONE_PALETTES[cfg.colorTone] || TONE_PALETTES.imhof;

    if (cfg.sunMode === 'swiss') {
      return {
        sunVec: normalizeVec3([0.5, -0.5, 0.7]),
        lightColor: chosenTone.light,
        shadowColor: chosenTone.shadow,
        skyColor: [0.45, 0.55, 0.70],
        alpenglowWeight: 0.0,
        sunIntensity: 1.0,
        warmCool: chosenTone.warmCool,
        isSwiss: true
      };
    }

    if (cfg.sunMode === 'manual') {
      const azRad = ((cfg.sunAzimuth || 315) * Math.PI) / 180;
      const altRad = Math.max(0.08, ((cfg.sunAltitude || 45) * Math.PI) / 180);
      const cosAlt = Math.cos(altRad);
      const v = [Math.sin(azRad) * cosAlt, -Math.cos(azRad) * cosAlt, Math.sin(altRad)];

      return {
        sunVec: normalizeVec3(v),
        lightColor: hexToVec3(cfg.manualPeakColor || '#fff8e7'),
        shadowColor: hexToVec3(cfg.manualShadowColor || '#1e2438'),
        skyColor: [0.40, 0.48, 0.65],
        alpenglowWeight: 0.0,
        sunIntensity: 1.0,
        warmCool: 0.5,
        isSwiss: false
      };
    }

    if ((cfg.sunMode === 'time' || cfg.sunMode === 'suncalc') && window.SunCalc) {
      const dateForCalc = (cfg.sunMode === 'time') ? getEffectiveSunDate(centerLat, centerLng) : new Date();

      // 1. Астрономическое положение Солнца
      const sunPos = SunCalc.getPosition(dateForCalc, centerLat, centerLng);
      const sunAltDeg = sunPos.altitude * (180 / Math.PI);
      const sunAz = sunPos.azimuth + Math.PI;

      // Визуальный угол для вектора света
      const visualSunAltRad = (Math.max(5.0, sunAltDeg) * Math.PI) / 180;
      const cosVisualAlt = Math.cos(visualSunAltRad);
      const sunV = [
        Math.sin(sunAz) * cosVisualAlt,
        -Math.cos(sunAz) * cosVisualAlt,
        Math.sin(visualSunAltRad)
      ];

      // 2. Определение половины суток (утро / вечер)
      let isMorning = false;
      try {
        const times = SunCalc.getTimes(dateForCalc, centerLat, centerLng);
        if (times.solarNoon && !isNaN(times.solarNoon.getTime())) {
          isMorning = dateForCalc.getTime() < times.solarNoon.getTime();
        } else {
          isMorning = (dateForCalc.getUTCHours() + centerLng / 15 + 24) % 24 < 12;
        }
      } catch (e) { isMorning = false; }

      // 3. Выбранные вами цвета
      const nightLight  = hexToVec3('#6b7da8'); // слабый лунно-звездный свет
      const nightShadow = hexToVec3('#15133e'); // глубокие ночные тени
      const nightSky    = hexToVec3('#12182b'); // ночной купол
      const nightK      = 0.80;                 // ночная яркость

      const dawnGlow    = hexToVec3('#ff8288'); // розово-коралловые вершины на заре
      const dawnValley  = hexToVec3('#363a78'); // холодные тени низин утром
      const dawnLight   = hexToVec3('#ffc999'); // первые лучи солнца

      const duskGlow    = hexToVec3('#eb4452'); // багровые вершины на закате
      const duskValley  = hexToVec3('#292555'); // фиолетовые тени низин вечером
      const duskLight   = hexToVec3('#ff7733'); // закатный луч

      const dayLight    = hexToVec3('#fff8eb'); // дневной теплый свет
      const dayShadow   = hexToVec3('#485269'); // дневные тени
      const daySky      = [0.45, 0.58, 0.75];

      // Порог отсечки темноты (-30°)
      const cutoff = -30.0;

      // 4. Симметричные градиенты света (Рассвет и Закат)
      const dawnStops = [
        { a: cutoff - 4, light: nightLight, shadow: nightShadow, sky: nightSky, k: nightK },
        { a: cutoff,     light: nightLight, shadow: nightShadow, sky: nightSky, k: nightK },
        { a: cutoff + 6, light: lerpVec3(nightLight, dawnLight, 0.25), shadow: lerpVec3(nightShadow, dawnValley, 0.35), sky: [0.18, 0.20, 0.38], k: 0.45 },
        { a: -1.0,       light: dawnLight,  shadow: dawnValley,  sky: [0.48, 0.44, 0.65], k: 0.70 },
        { a: 3.5,        light: lerpVec3(dawnLight, dayLight, 0.5), shadow: lerpVec3(dawnValley, dayShadow, 0.5), sky: [0.46, 0.54, 0.72], k: 0.88 },
        { a: 12.0,       light: dayLight,   shadow: dayShadow,   sky: daySky, k: 0.96 }
      ];

      const duskStops = [
        { a: cutoff - 4, light: nightLight, shadow: nightShadow, sky: nightSky, k: nightK },
        { a: cutoff,     light: nightLight, shadow: nightShadow, sky: nightSky, k: nightK },
        { a: cutoff + 6, light: lerpVec3(nightLight, duskLight, 0.25), shadow: lerpVec3(nightShadow, duskValley, 0.35), sky: [0.18, 0.16, 0.35], k: 0.45 },
        { a: -1.0,       light: duskLight,  shadow: duskValley,  sky: [0.42, 0.34, 0.60], k: 0.70 },
        { a: 3.5,        light: lerpVec3(duskLight, dayLight, 0.5), shadow: lerpVec3(duskValley, dayShadow, 0.5), sky: [0.46, 0.50, 0.70], k: 0.88 },
        { a: 12.0,       light: dayLight,   shadow: dayShadow,   sky: daySky, k: 0.96 }
      ];

      const ramp = sampleRamp(isMorning ? dawnStops : duskStops, sunAltDeg);

      // 5. Расчет реального положения и фазы Луны через SunCalc
      let moonV = [0.35, -0.45, 0.82];
      let moonIntensity = 0.35; // базовая ночная подсветка

      if (window.SunCalc && SunCalc.getMoonPosition) {
        const moonPos = SunCalc.getMoonPosition(dateForCalc, centerLat, centerLng);
        const moonIllum = SunCalc.getMoonIllumination ? SunCalc.getMoonIllumination(dateForCalc) : { fraction: 0.5 };
        
        const moonAltDeg = moonPos.altitude * (180 / Math.PI);
        const moonAz = moonPos.azimuth + Math.PI;

        // Если Луна над горизонтом: формируем честный динамический вектор
        const effMoonAltRad = (Math.max(4.0, moonAltDeg) * Math.PI) / 180;
        const cosMoonAlt = Math.cos(effMoonAltRad);
        const realMoonDir = [
          Math.sin(moonAz) * cosMoonAlt,
          -Math.cos(moonAz) * cosMoonAlt,
          Math.sin(effMoonAltRad)
        ];

        // Мягкий переход: если Луна садится за горизонт, вектор плавно 
        // уходит в верхний рассеянный звездный купол [0, 0, 1]
        const moonAboveHorizon = smoothstep(-2.0, 5.0, moonAltDeg);
        // Вместо строгого [0.0, 0.0, 1.0]:
        const starlightV = normalizeVec3([0.25, -0.35, 0.90]); // рассеянный свет созвездий под углом
        moonV = normalizeVec3(lerpVec3(starlightV, realMoonDir, moonAboveHorizon));

        // Интенсивность лунного света: зависит от фазы (полнолуние ярче) и высоты Луны
        const phaseFactor = lerp(0.25, 1.0, moonIllum.fraction); // в новолуние слабее, но не в ноль
        moonIntensity = lerp(0.20, 0.85, moonAboveHorizon * phaseFactor);
      }

      // Плавный переход от дневного солнца к ночной луне
      const toNight = isMorning
        ? 1.0 - smoothstep(cutoff + 1.0, cutoff + 9.0, sunAltDeg)
        : smoothstep(cutoff + 9.0, cutoff + 1.0, sunAltDeg);

      const finalLightVec = normalizeVec3(lerpVec3(sunV, moonV, toNight));

      // Корректируем итоговую силу ночного света с учетом фазы и положения Луны
      const finalIntensity = lerp(ramp.k, ramp.k * moonIntensity, toNight);

      // 6. Терминатор, ползущий по рельефу, и подсветка вершин
      let twClimb, twAmt, glowW, glowCol, valleyCol;
      if (!isMorning) {
        const p = smoothstep(3.5, cutoff + 6.0, sunAltDeg);
        twClimb = -0.15 + (1.0 - p) * 1.35;
        twAmt   = smoothstep(5.0, 0.0, sunAltDeg) * smoothstep(cutoff - 2.0, cutoff + 4.0, sunAltDeg);
        glowW   = smoothstep(3.5, -0.5, sunAltDeg) * smoothstep(cutoff + 4.0, cutoff + 9.0, sunAltDeg);
        glowCol   = duskGlow;
        valleyCol = duskValley;
      } else {
        const p = smoothstep(cutoff + 6.0, 1.5, sunAltDeg);
        twClimb = 1.20 - p * 1.35;
        twAmt   = smoothstep(cutoff - 2.0, cutoff + 3.0, sunAltDeg) * smoothstep(6.0, 2.0, sunAltDeg);
        glowW   = smoothstep(cutoff + 4.0, cutoff + 8.5, sunAltDeg) * smoothstep(4.0, 0.5, sunAltDeg);
        glowCol   = dawnGlow;
        valleyCol = dawnValley;
      }

      return {
        sunVec: finalLightVec,
        lightColor: ramp.light,
        shadowColor: ramp.shadow,
        skyColor: ramp.sky,
        alpenglowWeight: glowW,
        sunIntensity: ramp.k,
        warmCool: chosenTone.warmCool,
        isSwiss: false,
        twilightClimb: twClimb,
        twilightAmt: twAmt,
        glowColor: glowCol,
        valleyColor: valleyCol
      };
    }

    return {
      sunVec: normalizeVec3([0.5, -0.5, 0.7]),
      lightColor: chosenTone.light,
      shadowColor: chosenTone.shadow,
      skyColor: [0.45, 0.55, 0.70],
      alpenglowWeight: 0.0,
      sunIntensity: 1.0,
      warmCool: chosenTone.warmCool,
      isSwiss: false
    };
  }

  // =========================================================================
  // ШЕЙДЕРЫ WEBGL 2.0 (GLSL ES 3.00)
  // =========================================================================
  // =========================================================================
  // ШЕЙДЕРЫ WEBGL 2.0 (GLSL ES 3.00)
  // =========================================================================
  const VS_SOURCE = `#version 300 es
    in vec2 a_pos;
    in vec2 a_uv;
    
    uniform vec2 u_uvOrigin;
    uniform vec2 u_uvScale;
    
    out vec2 v_uv;
    out vec2 v_tileLocalPx;

    void main() {
      v_uv = u_uvOrigin + a_uv * u_uvScale;
      v_tileLocalPx = a_uv * 256.0;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // ШЕЙДЕР ПРЕДВАРИТЕЛЬНОГО ПРОХОДА ГЕОМЕТРИИ (G-BUFFER)
  // ШЕЙДЕР ПРЕДВАРИТЕЛЬНОГО ПРОХОДА ГЕОМЕТРИИ (1 ТЕКСТУРА RGBA8)
  const FS_GEOM_SOURCE = `#version 300 es
    precision highp float;
    precision highp int;

    uniform sampler2D u_dem;
    uniform ivec2 u_iRes;
    uniform float u_pad;
    uniform float u_zFactor;
    uniform int u_smooth;
    uniform float u_metersPerPixel;
    uniform float u_useAO;
    uniform float u_aoStrength;
    uniform float u_aoRadius;
    uniform float u_aoSlopeBleed;
    uniform float u_useSVF;
    uniform float u_svfStrength;
    uniform float u_elevMin;
    uniform float u_elevSpan;

    uniform float u_useOpenness;
    uniform float u_opennessRadius;
    uniform float u_opennessStrength;
    uniform float u_opennessDiff;

    in vec2 v_uv;
    in vec2 v_tileLocalPx;

    // Один стандартный буфер вывода (RGBA8)
    out vec4 fragColor;

    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      float h = (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
      return (h < -1000.0) ? h : max(h, 0.0);
    }

    float getRawHPx(ivec2 p, float fallbackH) {
      vec4 c = texelFetch(u_dem, clamp(p, ivec2(0), u_iRes - ivec2(1)), 0);
      float h = decodeH(c);
      return (h < -1000.0) ? fallbackH : h;
    }

    // Вода (<=0.25 м) рядом с сушей не создаёт искусственный обрыв
    float g_landRef = -1.0;
    float getSlopeHPx(ivec2 p, float fallbackH) {
      float h = getRawHPx(p, fallbackH);
      if (g_landRef > 0.25 && h <= 0.25) return g_landRef;
      return h;
    }

    float getGaussianHPx(ivec2 p, float centerH, int rad) {
      float h = getSlopeHPx(p, centerH) * 0.20;
      h += (getSlopeHPx(p + ivec2( rad, 0), centerH) + getSlopeHPx(p - ivec2( rad, 0), centerH)) * 0.12;
      h += (getSlopeHPx(p + ivec2(0,  rad), centerH) + getSlopeHPx(p - ivec2(0,  rad), centerH)) * 0.12;
      h += (getSlopeHPx(p + ivec2( rad,  rad), centerH) + getSlopeHPx(p - ivec2(-rad,  rad), centerH)) * 0.08;
      h += (getSlopeHPx(p + ivec2(-rad,  rad), centerH) + getSlopeHPx(p + ivec2( rad, -rad), centerH)) * 0.08;
      h += (getSlopeHPx(p + ivec2( rad * 2, 0), centerH) + getSlopeHPx(p - ivec2( rad * 2, 0), centerH)) * 0.05;
      h += (getSlopeHPx(p + ivec2(0,  rad * 2), centerH) + getSlopeHPx(p - ivec2(0,  rad * 2), centerH)) * 0.05;
      return h;
    }

    float getBilateralHPx(ivec2 p, float centerH, int rad) {
      float totalWeight = 0.25;
      float sumH = centerH * 0.25;

      ivec2 off[8];
      off[0] = ivec2( rad, 0); off[1] = ivec2(-rad, 0);
      off[2] = ivec2(0,  rad); off[3] = ivec2(0, -rad);
      off[4] = ivec2( rad,  rad); off[5] = ivec2(-rad, -rad);
      off[6] = ivec2(-rad,  rad); off[7] = ivec2( rad, -rad);

      for (int i = 0; i < 8; i++) {
        float sampleH = getSlopeHPx(p + off[i], centerH);
        float diff = abs(sampleH - centerH);
        float spatialW = (i < 4) ? 0.12 : 0.07;
        float d = clamp(diff * 0.2, 0.0, 1.0);
        float rangeW = 1.0 - d * d;
        float w = spatialW * rangeW;
        sumH += sampleH * w;
        totalWeight += w;
      }
      return sumH / totalWeight;
    }

    float computeSkyViewFactorPx(ivec2 p, float h0, float maxSafeR) {
      if (u_useSVF < 0.5) return 1.0;
      int rPx = int(clamp(maxSafeR, 1.0, 12.0));
      float distM = max(1.0, float(rPx) * u_metersPerPixel);
      int diagPx = int(round(float(rPx) * 0.7071));

      float hN  = getSlopeHPx(p + ivec2(0,  rPx), h0);
      float hS  = getSlopeHPx(p - ivec2(0,  rPx), h0);
      float hE  = getSlopeHPx(p + ivec2( rPx, 0), h0);
      float hW  = getSlopeHPx(p - ivec2( rPx, 0), h0);
      float hNE = getSlopeHPx(p + ivec2( diagPx,  diagPx), h0);
      float hNW = getSlopeHPx(p + ivec2(-diagPx,  diagPx), h0);
      float hSE = getSlopeHPx(p + ivec2( diagPx, -diagPx), h0);
      float hSW = getSlopeHPx(p + ivec2(-diagPx, -diagPx), h0);

      float horizonBlock = 0.0;
      horizonBlock += clamp((hN  - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hS  - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hE  - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hW  - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hNE - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hNW - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hSE - h0) / distM, 0.0, 1.5);
      horizonBlock += clamp((hSW - h0) / distM, 0.0, 1.5);
      horizonBlock *= 0.125;

      float ridgeBonus = clamp((h0 - ((hN + hS + hE + hW) * 0.25)) / distM, 0.0, 0.8);
      return clamp(1.0 - horizonBlock * 1.8 * u_svfStrength + ridgeBonus * 1.4 * u_svfStrength, 0.15, 2.4);
    }

    void computeOpenness(ivec2 p, float h0, float maxSafeR, out float posOpen, out float negOpen) {
      if (u_useOpenness < 0.5) {
        posOpen = 0.0;
        negOpen = 0.0;
        return;
      }
      
      // Радиус масштабируется слайдером от 3 px до 36 px
      float maxR = clamp(18.0 * u_opennessRadius, 3.0, min(maxSafeR, 38.0));
      
      ivec2 dirs[8];
      dirs[0] = ivec2( 1,  0); dirs[1] = ivec2(-1,  0);
      dirs[2] = ivec2( 0,  1); dirs[3] = ivec2( 0, -1);
      dirs[4] = ivec2( 1,  1); dirs[5] = ivec2(-1,  1);
      dirs[6] = ivec2( 1, -1); dirs[7] = ivec2(-1, -1);

      // 4 прогрессивных кольца выборки вдаль
      float rSteps[4];
      rSteps[0] = max(1.0, maxR * 0.25);
      rSteps[1] = max(2.0, maxR * 0.50);
      rSteps[2] = max(3.0, maxR * 0.75);
      rSteps[3] = maxR;

      float sumZenith = 0.0;
      float sumNadir  = 0.0;

      for (int i = 0; i < 8; i++) {
        float diagMul = (i >= 4) ? 1.4142 : 1.0;
        float maxTanZ = -99.0;
        float maxTanN = -99.0;

        for (int s = 0; s < 4; s++) {
          int stepPx = int(round(rSteps[s]));
          float distM = max(1.0, float(stepPx) * u_metersPerPixel * diagMul);
          float sampleH = getSlopeHPx(p + dirs[i] * stepPx, h0);

          float tanZ = (sampleH - h0) / distM;
          float tanN = (h0 - sampleH) / distM;

          if (tanZ > maxTanZ) maxTanZ = tanZ;
          if (tanN > maxTanN) maxTanN = tanN;
        }

        sumZenith += atan(max(0.0, maxTanZ));
        sumNadir  += atan(max(0.0, maxTanN));
      }

      // Открытость в радианах: 0 = ровное поле, > 0 = крутые стены/обрывы
      negOpen = sumZenith * 0.125; // Насколько горизонт закрыт горами вокруг (тальвег / овраг)
      posOpen = sumNadir  * 0.125; // Насколько местность обрывается вниз под ноги (гребень / пик)
    }

    void main() {
      ivec2 basePx = ivec2(floor(v_uv * vec2(u_iRes)));
      vec4 centerRaw = texelFetch(u_dem, clamp(basePx, ivec2(0), u_iRes - ivec2(1)), 0);
      float centerH = decodeH(centerRaw);

      if (centerRaw.a < 0.1 || centerH < -1000.0) {
        fragColor = vec4(0.0);
        return;
      }
      g_landRef = (centerH > 0.25) ? centerH : -1.0;



      float maxSafeR = max(1.0, u_pad - 3.0);
      int stepPx = 1;
      float z00, z10, z20, z01, z21, z02, z12, z22;

      if (u_smooth == 0) {
        stepPx = 1;
        z00 = getSlopeHPx(basePx + ivec2(-1, -1), centerH);
        z10 = getSlopeHPx(basePx + ivec2( 0, -1), centerH);
        z20 = getSlopeHPx(basePx + ivec2( 1, -1), centerH);
        z01 = getSlopeHPx(basePx + ivec2(-1,  0), centerH);
        z21 = getSlopeHPx(basePx + ivec2( 1,  0), centerH);
        z02 = getSlopeHPx(basePx + ivec2(-1,  1), centerH);
        z12 = getSlopeHPx(basePx + ivec2( 0,  1), centerH);
        z22 = getSlopeHPx(basePx + ivec2( 1,  1), centerH);
      } else if (u_smooth == 2) {
        int r = int(min(max(1.8, 50.0 / u_metersPerPixel), maxSafeR));
        stepPx = max(1, r);
        z00 = getBilateralHPx(basePx + ivec2(-stepPx, -stepPx), centerH, 1);
        z10 = getBilateralHPx(basePx + ivec2( 0,      -stepPx), centerH, 1);
        z20 = getBilateralHPx(basePx + ivec2( stepPx, -stepPx), centerH, 1);
        z01 = getBilateralHPx(basePx + ivec2(-stepPx,  0),      centerH, 1);
        z21 = getBilateralHPx(basePx + ivec2( stepPx,  0),      centerH, 1);
        z02 = getBilateralHPx(basePx + ivec2(-stepPx,  stepPx), centerH, 1);
        z12 = getBilateralHPx(basePx + ivec2( 0,       stepPx), centerH, 1);
        z22 = getBilateralHPx(basePx + ivec2( stepPx,  stepPx), centerH, 1);
      } else {
        float minMetersRadius = clamp(35.0, u_metersPerPixel * 2.0, 80.0);
        float maxGaussStep = max(1.0, floor(maxSafeR * 0.55));
        float adaptiveBlurRadius = clamp(minMetersRadius / max(0.1, u_metersPerPixel), 1.0, maxGaussStep);
        stepPx = max(1, int(round(adaptiveBlurRadius)));
        int gr = max(1, stepPx / 3);
        z00 = getGaussianHPx(basePx + ivec2(-stepPx, -stepPx), centerH, gr);
        z10 = getGaussianHPx(basePx + ivec2( 0,      -stepPx), centerH, gr);
        z20 = getGaussianHPx(basePx + ivec2( stepPx, -stepPx), centerH, gr);
        z01 = getGaussianHPx(basePx + ivec2(-stepPx,  0),      centerH, gr);
        z21 = getGaussianHPx(basePx + ivec2( stepPx,  0),      centerH, gr);
        z02 = getGaussianHPx(basePx + ivec2(-stepPx,  stepPx), centerH, gr);
        z12 = getGaussianHPx(basePx + ivec2( 0,       stepPx), centerH, gr);
        z22 = getGaussianHPx(basePx + ivec2( stepPx,  stepPx), centerH, gr);
      }

      float deltaMeters = max(0.1, 2.0 * float(stepPx) * u_metersPerPixel);
      float dzdx = ((z20 + 2.0 * z21 + z22) - (z00 + 2.0 * z01 + z02)) / (8.0 * deltaMeters) * u_zFactor;
      float dzdy = ((z02 + 2.0 * z12 + z22) - (z00 + 2.0 * z10 + z20)) / (8.0 * deltaMeters) * u_zFactor;
      
      // --- ФИЛЬТР СТУПЕНЕК КВАНТОВАНИЯ (TERRACE CORING) ---
      if (centerH <= 0.25) {
        dzdx = 0.0;
        dzdy = 0.0;
      } else {
        float rawSlope = length(vec2(dzdx, dzdy));
        float stepThreshold = (2.0 * u_zFactor) / deltaMeters;
        if (rawSlope < stepThreshold) {
          float terraceDamp = smoothstep(0.01, stepThreshold, rawSlope);
          dzdx *= terraceDamp;
          dzdy *= terraceDamp;
        }
      }

      // Мягкий потолок уклона: нормаль не вырождается в горизонталь на обрывах/швах
      {
        float sLen = length(vec2(dzdx, dzdy));
        const float S_MAX = 6.0;
        if (sLen > 1e-4) {
          float k = S_MAX * tanh(sLen / S_MAX) / sLen;
          dzdx *= k;
          dzdy *= k;
        }
      }
      vec3 norm = normalize(vec3(-dzdx, -dzdy, 1.0));

      float curvature = ((z10 + z01 + z21 + z12) * 0.25) - centerH;

      
      // Подавляем ложные блики гребней, если склон пологий:
      float slopeForGlint = length(vec2(dzdx, dzdy));
      float crestGlint = clamp(-curvature * 0.20 * u_zFactor, 0.0, 0.40);
      crestGlint *= smoothstep(0.08, 0.35, slopeForGlint);

      float svf = computeSkyViewFactorPx(basePx, centerH, maxSafeR);

      float aoVal = 1.0;
      if (u_useAO > 0.5) {
        float aoMeterRadius = max(90.0, u_metersPerPixel * 3.5) * u_aoRadius;
        int wideR = int(min(aoMeterRadius / u_metersPerPixel, maxSafeR));
        float avgH = (getSlopeHPx(basePx + ivec2(-wideR,  0), centerH) +
                      getSlopeHPx(basePx + ivec2( wideR,  0), centerH) +
                      getSlopeHPx(basePx + ivec2( 0, -wideR), centerH) +
                      getSlopeHPx(basePx + ivec2( 0,  wideR), centerH)) * 0.25;

        float filteredDiff = max(0.0, (avgH - centerH) - 0.7);
        float slope = length(vec2(dzdx, dzdy));
        float slopeBleedFactor = mix(1.0, clamp(slope * 14.0, 0.5, 3.0), u_aoSlopeBleed);
        float valleyDepth = (filteredDiff * slopeBleedFactor) / max(2.5, u_metersPerPixel * 0.35);
        aoVal = clamp(1.0 - valleyDepth * 0.26 * u_aoStrength, 0.35, 1.0);
      }

      if (u_useOpenness > 0.5) {
        float posO, negO;
        computeOpenness(basePx, centerH, maxSafeR, posO, negO);
        
        // Тальвеги и овраги: плавно углубляет затенение
        float valleyOcc = smoothstep(0.02, 0.38, negO);
        aoVal = mix(aoVal, aoVal * (1.0 - valleyOcc * 0.75), u_opennessStrength * (1.0 - u_opennessDiff * 0.5));
        
        // Хребты и пики: добавляет контрастное свечение вершинам
        float ridgeGlow = smoothstep(0.02, 0.38, posO) * 0.45;
        crestGlint = mix(crestGlint, crestGlint + ridgeGlow, u_opennessStrength * (u_opennessDiff * 0.6 + 0.2));
      }
      if (centerH <= 0.25) {
        aoVal = 1.0;
        svf = 1.0;
        crestGlint = 0.0;
      }

      // --- УПАКОВКА В 1 ТЕКСТУРУ RGBA8 ---
      vec2 encNorm = norm.xy * 0.5 + 0.5;
      float ambVal = clamp(aoVal * min(1.0, svf), 0.0, 1.0);
      float encGlint = clamp(0.5 + crestGlint, 0.5, 1.0);
      fragColor = vec4(encNorm, ambVal, encGlint);
    }
  `;

  // ШЕЙДЕР ОСВЕЩЕНИЯ (РЕАЛЬНОЕ ВРЕМЯ)
  // =========================================================================
  // ДИНАМИЧЕСКИЙ ГЕНЕРАТОР ШЕЙДЕРА ОСВЕЩЕНИЯ (МОДУЛЬНАЯ КОМПИЛЯЦИЯ)
  // =========================================================================
  function buildLightFragmentShader(flags) {
    const defines = [];
    if (flags.mdow) defines.push('#define USE_MDOW');

    if (flags.seaWaves) {
      defines.push('#define USE_SEA_WAVES');
      defines.push(`#define SEA_STYLE_${(flags.seaWaveStyle || 'ripples').toUpperCase()}`);
    }
    if (flags.hachure) {
      defines.push('#define USE_HACHURE');
      defines.push(`#define HACHURE_${(flags.hachureType || 'classic').toUpperCase()}`);
    }
    if (flags.dither) {
      defines.push('#define USE_DITHER');
      defines.push(`#define DITHER_${(flags.ditherType || 'blue').toUpperCase()}`);
    }


    // ДОБАВИТЬ ЭТОТ БЛОК:
    if (flags.outline) {
      defines.push('#define USE_OUTLINE');
      defines.push(`#define OUTLINE_${(flags.outlineType || 'all').toUpperCase()}`);
    }

    if (flags.bounce) defines.push('#define USE_BOUNCE');
    if (flags.contactShadows) defines.push('#define USE_CONTACT_SHADOWS');
    if (flags.featTint) defines.push('#define USE_FEAT_TINT');

    return `#version 300 es
    precision highp float;
    precision highp int;

    ${defines.join('\n')}

    uniform sampler2D u_dem;
    uniform sampler2D u_gbuf;
    uniform sampler2D u_sbuf;       // запечённые статичные слои: штриховка / зерно / ватерлиния
    uniform float u_demMaxH;        // точный максимум высот тайла (ранний выход теневого луча)
    uniform ivec2 u_iRes;
    uniform float u_pad;
    uniform vec3 u_sunDir;
    uniform vec3 u_lightColor;
    uniform vec3 u_shadowColor;
    uniform vec3 u_skyColor;
    uniform float u_alpenglowWeight;
    uniform float u_sunIntensity;
    uniform float u_zFactor;
    uniform int u_mode;
    uniform int u_hypso;
    uniform float u_useSVF;
    uniform float u_svfStrength;
    uniform float u_useCastShadow;
    uniform float u_shadowReach;
    uniform float u_shadowOpacity;
    uniform float u_imhofDeflection;
    uniform float u_imhofWarmCool;
    uniform float u_lightWrap;
    uniform float u_metersPerPixel;
    uniform float u_paperGrain;
    uniform ivec2 u_vpOrigin;
    uniform int u_fastMode; // 1 = быстрый драг слайдера, 0 = высокое качество

    uniform int   u_manualScaleMode;
    uniform float u_manualElevMin;
    uniform float u_manualElevMax;

    uniform int   u_waterTintEnabled;
    uniform vec3  u_waterTintColor;
    uniform float u_waterTintOpacity;
    uniform float u_waterTintCoverage;
    uniform int   u_waterTintBlend;

    uniform vec3  u_waterlineColor;
    uniform float u_waterlineWidth;
    uniform float u_waterlineOpacity;

    #ifdef USE_BOUNCE
    uniform float u_bounceStrength;
    #endif

    #ifdef USE_CONTACT_SHADOWS
    uniform float u_penumbraScale;
    #endif



    uniform int   u_colorTone; 

    uniform vec3  u_sunFaceColor;    // Персональный цвет освещённых граней
    uniform float u_twilightSat;     // Насыщенность освещённых граней (0..1)

    uniform float u_orenNayarRoughness;
    uniform float u_specularDamp;
    uniform float u_inkBleed;
    uniform float u_waterlining;

    #ifdef USE_HACHURE
    uniform int   u_hachureBlend;
    uniform float u_hachureOpacity;
    uniform vec3  u_hachureColor;
    uniform float u_hachureLightMod;
    #endif

    #ifdef USE_DITHER
    uniform vec2  u_ditherWorld;
    uniform int   u_ditherBlend;
    uniform float u_ditherScale;
    uniform float u_ditherAngle;
    uniform float u_ditherDensity;
    uniform float u_ditherThreshold;
    uniform float u_ditherLowCut;
    uniform float u_ditherSoftness;
    uniform vec3  u_ditherColor;
    uniform int   u_ditherZone;
    uniform float u_ditherStrength;
    #endif

    uniform float u_lightBoost;
    uniform int   u_isManualMode;
    uniform int   u_debugValley;
    uniform vec3  u_manualColorPeak;
    uniform vec3  u_manualColorMid;
    uniform vec3  u_manualColorValley;
    uniform float u_manualLightBlend;
    uniform float u_manualLightSoftness;
    uniform float u_manualLightBlend2;
    uniform float u_manualLightSoftness2;
    uniform float u_elevMin;
    uniform float u_elevSpan;

    uniform float u_twilightClimb;
    uniform float u_twilightAmt;
    uniform float u_afterglow;       // 0..1: мягкий направленный отсвет неба ПОСЛЕ ухода прямого солнца
    uniform vec3  u_glowColor;
    uniform vec3  u_valleyColor;

    uniform vec3  u_dayGlowColor;
    uniform float u_dayGlowStrength;
    uniform float u_hazeStrength;

    uniform float u_dayReach;          // Зона доступа лучей (проникновение в низины)
    uniform vec3  u_twilightRimColor;  // Цвет каймы перехода терминатора (убирает серость)
    uniform float u_twilightRimWidth;  // Ширина границы перехода света и тени

    uniform sampler2D u_waterMask;
    #ifdef USE_FEAT_TINT
    uniform sampler2D u_featMask;
    uniform int   u_hasFeatMask;

    uniform int   u_roadTintOn;
    uniform vec3  u_roadTintColor;
    uniform float u_roadTintOpacity;
    uniform float u_roadTintZone;
    uniform float u_roadTintSoftness;
    uniform int   u_roadTintBlend;

    uniform int   u_edgeTintOn;
    uniform vec3  u_edgeTintColor;
    uniform float u_edgeTintOpacity;
    uniform float u_edgeTintZone;
    uniform float u_edgeTintSoftness;
    uniform int   u_edgeTintBlend;
    uniform int   u_edgeTintSide;

    vec3 applyFeatureTint(int mode, vec3 base, vec3 tintCol, float directLight, float sunIntensity) {
      if (mode == 1) return base * tintCol; // Multiply
      if (mode == 2) { // Overlay
        vec3 lo = 2.0 * base * tintCol;
        vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - tintCol);
        return mix(lo, hi, step(vec3(0.5), base));
      }
      if (mode == 3) return (1.0 - 2.0 * tintCol) * base * base + 2.0 * tintCol * base; // Soft-Light
      if (mode == 4) return 1.0 - (1.0 - base) * (1.0 - tintCol); // Screen
      if (mode == 5) return tintCol; // Normal
      // mode == 0: 'tint' — окрашивает рельеф, сохраняя тени, AO и ночное освещение
      float baseLuma = dot(base, vec3(0.299, 0.587, 0.114));
      float shade = clamp(baseLuma * 1.65 + 0.08 * directLight * sunIntensity, 0.04, 1.35);
      return clamp(tintCol * shade, 0.0, 1.0);
    }
    #endif
    uniform int u_hasWaterMask; // 1 = маска загружена, 0 = фоллбэк на DEM


    in vec2 v_uv;
    in vec2 v_tileLocalPx;

    out vec4 fragColor;

    // Базовый хэш должен быть объявлен ДО его вызова в морских волнах и тенях!
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    #ifdef USE_SEA_WAVES
    uniform vec2  u_seaWorld;
    uniform float u_seaWaveScale;
    uniform float u_seaWaveSpacing;
    uniform float u_seaWaveUndulation;
    uniform float u_seaWaveThickness;
    uniform float u_seaWaveRoughness;
    uniform float u_seaWaveOpacity;
    uniform vec3  u_seaWaveColor;
    uniform float u_seaWaveShoreFade;
    uniform int   u_seaWaveBlend;
    uniform int   u_seaWaveFillEnabled;
    uniform vec3  u_seaWaveFillColor;
    uniform float u_seaWaveFillOpacity;

    float getCartaMarinaWaves(vec2 wp, float shoreDistNorm, vec2 flowDir, float riverInfluence) {
      // waterWidthFactor: от 0.22 (узкие реки и протоки) до 1.0 (открытые моря)
      float waterWidthFactor = clamp(shoreDistNorm * 1.6, 0.22, 1.0);

      // Адаптивное масштабирование под ширину водоёма:
      float sc = max(4.0, u_seaWaveScale * mix(0.28, 1.0, waterWidthFactor));
      float sp = max(1.8, u_seaWaveSpacing * mix(0.42, 1.0, waterWidthFactor));
      float thickness = max(0.35, u_seaWaveThickness * mix(0.55, 1.0, waterWidthFactor));
      float undulation = u_seaWaveUndulation * mix(0.25, 1.0, waterWidthFactor);

      // Поворот координат волн вдоль русла реки
      vec2 crossDir = vec2(-flowDir.y, flowDir.x);
      vec2 localWp = vec2(dot(wp, flowDir), dot(wp, crossDir));

      float rough = u_seaWaveRoughness;
      float microJitter = (hash(floor(localWp * 0.75)) - 0.5) * (rough * 1.5 * waterWidthFactor);

      float k = 6.2831853 / sc;
      float waveShift = sin(localWp.x * k) * undulation
                      + sin(localWp.x * (k * 0.41) + 1.6) * (undulation * 0.45)
                      + microJitter;

      float lineCoord = (localWp.y + waveShift) / sp;
      float rowIdx = floor(lineCoord);
      float lineDist = abs(fract(lineCoord) - 0.5) * sp;

      float halfW = max(0.25, thickness * 0.5);
      float stroke = 1.0 - smoothstep(halfW - 0.35, halfW + 0.35, lineDist);

      #if defined(SEA_STYLE_RIPPLES)
      float segFreq = 6.2831853 / (sc * 1.35);
      float rowPhase = rowIdx * 2.39996;
      float dash = sin(localWp.x * segFreq + rowPhase);
      stroke *= smoothstep(-0.25, 0.45, dash);
      #elif defined(SEA_STYLE_WOODCUT)
      float segFreq = 6.2831853 / (sc * 1.7);
      float rowPhase = rowIdx * 1.95;
      float crest = clamp(sin(localWp.x * segFreq + rowPhase) * 1.4, 0.0, 1.0);
      stroke *= smoothstep(0.12, 0.88, crest);
      #endif

      float shoreFade = smoothstep(0.005, max(0.03, u_seaWaveShoreFade), shoreDistNorm);
      return stroke * shoreFade;
    }
    #endif

    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      float h = (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
      return (h < -1000.0) ? h : max(h, 0.0);
    }


    float getRawHPx(ivec2 p, float fallbackH) {
      vec4 c = texelFetch(u_dem, clamp(p, ivec2(0), u_iRes - ivec2(1)), 0);
      float h = decodeH(c);
      return (h < -1000.0) ? fallbackH : h;
    }

    float computeCastShadowPx(ivec2 basePx, vec2 localCoord, float h0, vec3 sunDir, float maxSafeMeters) {
    if (u_useCastShadow < 0.5) return 1.0;
    if (u_shadowOpacity <= 0.01 || u_sunIntensity <= 0.01) return 1.0;
    if (sunDir.z <= 0.001) return 0.0;

    float lenXY = length(sunDir.xy);
    if (lenXY < 0.0001) return 1.0;

    vec2 rayDir = sunDir.xy / lenXY;
    // Допускаем более пологий угол луча при низком солнце для длинных теней
    float sunTan = max(0.04, sunDir.z / max(0.01, lenXY));
    float dither = hash(localCoord * 1.7) * 0.5;

    // Дистанция масштабируется ползунком u_shadowReach (0.0 .. 1.0) 
    // на ВСЮ ширину буфера тайла без искусственного ограничения в 360 метров:
    float maxDistMeters = maxSafeMeters * clamp(u_shadowReach, 0.05, 1.0);
    
    // Количество шагов: в быстром режиме (драг) 8 шагов, в обычном — 16 шагов
    int maxSteps = (u_fastMode == 1) ? 8 : 16;
    
    // Адаптивный шаг: луч гарантированно пройдет всю дистанцию maxDistMeters
    float totalPxTarget = maxDistMeters / max(0.01, u_metersPerPixel);
    float stepPixels = max(1.8, totalPxTarget / (float(maxSteps) * 1.25));
    float stepMeters = stepPixels * u_metersPerPixel;

    float curMeters = (1.0 + dither) * stepMeters;
    vec2 curPxVec = vec2(basePx) + rayDir * ((1.0 + dither) * stepPixels);

    float shadowFactor = 1.0;

    for (int i = 0; i < 16; i++) {
      if (i >= maxSteps || curMeters > maxDistMeters) break;
      float rayH = h0 + (curMeters * sunTan) / u_zFactor;
      if (rayH > u_demMaxH + 0.5) break;

      float terrainH = getRawHPx(ivec2(round(curPxVec)), h0);
      if (h0 <= 0.2 && terrainH < 2.0) continue;
      float diff = terrainH - rayH;
      if (diff > 0.0) {
        float occ = clamp(diff * 0.28, 0.0, 1.0);

        #ifdef USE_CONTACT_SHADOWS
        // Чем дальше препятствие от точки, тем шире и прозрачнее полутень:
        float penumbra = clamp(curMeters / max(1.0, maxDistMeters * u_penumbraScale), 0.0, 1.0);
        occ *= mix(1.0, 0.35, penumbra);
        #endif

        shadowFactor = min(shadowFactor, 1.0 - occ * u_shadowOpacity);
        if (shadowFactor < 0.15) break;
      }

      // Мягкое прогрессивное расширение шага вдаль
      float scale = 1.0 + float(i) * 0.06;
      curMeters += stepMeters * scale;
      curPxVec += rayDir * (stepPixels * scale);
    }

    float horizonFade = smoothstep(0.015, 0.08, sunDir.z);
    return mix(1.0 - u_shadowOpacity * 0.35, shadowFactor, horizonFade);
  }

    vec3 getVintageHypso(float h) {
      float normH = clamp((h + 50.0) / 2500.0, 0.0, 1.0);
      vec3 cLow   = vec3(0.86, 0.88, 0.80);
      vec3 cMid   = vec3(0.92, 0.86, 0.73);
      vec3 cHigh  = vec3(0.78, 0.65, 0.52);
      vec3 cCrest = vec3(0.95, 0.93, 0.90);
      if (normH < 0.35) return mix(cLow, cMid, normH / 0.35);
      if (normH < 0.75) return mix(cMid, cHigh, (normH - 0.35) / 0.40);
      return mix(cHigh, cCrest, (normH - 0.75) / 0.25);
    }

    float getOrenNayarLight(vec3 N, vec3 L, float roughness, float wrap) {
      float sigma2 = roughness * roughness;
      float A = 1.0 - 0.5 * (sigma2 / (sigma2 + 0.33));
      float B = 0.45 * (sigma2 / (sigma2 + 0.09));

      float cos_ti = dot(N, L);
      float wrapped_cos_ti = max(0.0, (cos_ti + wrap) / (1.0 + wrap));
      float cos_tr = max(0.001, N.z);
      float C = max(0.0, L.z - cos_ti * cos_tr) / max(cos_ti, cos_tr);
      return wrapped_cos_ti * (A + B * C);
    }


    // =========================================================================
    // ТОЛЬКО АКТИВНЫЕ ФУНКЦИИ ДИЗЕРИНГА (КОМПИЛИРУЕТСЯ СТРОГО 1 ШТУКА)
    // =========================================================================
    #ifdef USE_DITHER
    vec2 rotate2D(vec2 p, float rad) {
      float c = cos(rad);
      float s = sin(rad);
      return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    }

    vec3 blendDitherColor(int mode, vec3 base, vec3 blend) {
      if (mode == 1) return base * blend;
      if (mode == 2) {
        vec3 lo = 2.0 * base * blend;
        vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
        return mix(lo, hi, step(vec3(0.5), base));
      }
      if (mode == 3) return (1.0 - 2.0 * blend) * base * base + 2.0 * blend * base;
      if (mode == 4) return 1.0 - (1.0 - base) * (1.0 - blend);
      if (mode == 5) return clamp(1.0 - (1.0 - base) / max(vec3(0.001), blend), 0.0, 1.0);
      if (mode == 6) return abs(base - blend);
      return blend;
    }

    #if defined(DITHER_BLUE) || defined(DITHER_STIPPLE) || defined(DITHER_LITHO)
    float getOrganicNoise(vec2 p) {
      vec2 ip = floor(p);
      vec2 u = fract(p);
      u = u * u * (3.0 - 2.0 * u);
      float n00 = fract(sin(dot(ip, vec2(12.9898, 78.233))) * 43758.5453);
      float n10 = fract(sin(dot(ip + vec2(1.0, 0.0), vec2(12.9898, 78.233))) * 43758.5453);
      float n01 = fract(sin(dot(ip + vec2(0.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453);
      float n11 = fract(sin(dot(ip + vec2(1.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453);
      float h = mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
      float fine = fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
      return fract(h * 0.6180339887 + fine * 0.3819660113);
    }
    #endif

    #if defined(DITHER_BAYER)
    float getBayer4(vec2 p) {
      ivec2 b = ivec2(floor(mod(p, 4.0)));
      int b0x = b.x & 1;
      int b0y = b.y & 1;
      int b1x = (b.x >> 1) & 1;
      int b1y = (b.y >> 1) & 1;
      int m0 = 2 * b0x + 3 * b0y - 4 * b0x * b0y;
      int m1 = 2 * b1x + 3 * b1y - 4 * b1x * b1y;
      return float(4 * m0 + m1) / 16.0;
    }
    #endif

    #if defined(DITHER_DOTS)
    float getHalftoneDots(vec2 pRot, float luma, float scale, float density) {
      vec2 grid = fract(pRot / max(1.0, scale * 3.5)) - 0.5;
      float dist = length(grid);
      float targetRadius = sqrt(clamp(1.0 - luma, 0.0, 1.0)) * 0.65 * clamp(density, 0.2, 2.5);
      return smoothstep(targetRadius + 0.08, targetRadius - 0.08, dist);
    }
    #endif

    #if defined(DITHER_HATCH)
    float getLinearHatch(vec2 pRot, float luma, float scale, float density) {
      float coord = pRot.y / max(1.0, scale * 3.2);
      float wave = abs(fract(coord) - 0.5) * 2.0;
      float thickness = clamp((1.0 - luma) * 0.85 * density, 0.02, 0.98);
      return smoothstep(thickness - 0.12, thickness + 0.12, wave);
    }
    #endif

    #if defined(DITHER_WOODCUT)
    float getWoodcutHatch(vec2 pRot, float luma, float scale, float density, vec2 grad, float hNorm, float slope, float angleDeg) {
      float sc = max(1.0, scale * 3.4);
      float angleRad = (angleDeg * 3.14159265) / 180.0;

      // Проекция градиента уклона в локальные координаты штриховки
      vec2 gradRot = rotate2D(grad, -angleRad);

      // Степень выраженности рельефа (0 на равнинах, 1 на заметных холмах и склонах)
      float slFactor = smoothstep(0.005, 0.12, slope);

      // 1. Изгиб вдоль изолиний высот (обтекание объема гор)
      float elevBend = (hNorm - 0.5) * sc * 1.8;

      // 2. Мягкий контролируемый боковой увод по направлению склона
      float slopeBend = clamp(-gradRot.y * 0.40, -1.0, 1.0) * sc;

      // 3. Естественная легкая пластика резца ксилографа вдоль штриха на склонах
      float woodgrain = sin(pRot.x / max(1.0, sc * 3.5) + hNorm * 3.14159) * (sc * 0.16);

      // Непрерывная координата штриха (без фазовых разрывов)
      float coord = (pRot.y + (elevBend + slopeBend + woodgrain) * slFactor) / sc;
      float wave = abs(fract(coord) - 0.5) * 2.0;

      // Толщина штриха: увеличивается в тенях, слегка акцентируется на рельефе
      float darkness = clamp(1.0 - luma, 0.0, 1.0);
      float thickness = clamp(darkness * (0.80 + slFactor * 0.12) * density, 0.0, 0.95);
      if (thickness < 0.01) return 0.0;

      float halfWidth = max(0.06, 0.15 / sc);
      return 1.0 - smoothstep(thickness - halfWidth, thickness + halfWidth, wave);
    }
    #endif

    #if defined(DITHER_CROSS)
    float getCrossHatch(vec2 pRot, float luma, float scale, float density) {
      vec2 d1 = vec2(0.7071, 0.7071);
      vec2 d2 = vec2(-0.7071, 0.7071);
      float w1 = abs(fract(dot(pRot, d1) / (scale * 3.0)) - 0.5) * 2.0;
      float w2 = abs(fract(dot(pRot, d2) / (scale * 3.0)) - 0.5) * 2.0;
      float t1 = clamp(smoothstep(0.75, 0.2, luma) * density, 0.0, 1.0);
      float t2 = clamp(smoothstep(0.40, 0.05, luma) * density, 0.0, 1.0);
      return clamp(t1 * smoothstep(0.4, 0.6, w1) + t2 * smoothstep(0.4, 0.6, w2), 0.0, 1.0);
    }
    #endif

    #if defined(DITHER_WAVY)
    float getWavyHatch(vec2 pRot, float luma, float scale, float density) {
      float sc = max(1.0, scale * 3.5);
      float waveMod = sin(pRot.x / (sc * 1.8)) * 0.8;
      float coord = (pRot.y + waveMod * sc * 0.5) / sc;
      float wave = abs(fract(coord) - 0.5) * 2.0;
      float thickness = clamp((1.0 - luma) * 0.85 * density, 0.02, 0.98);
      return smoothstep(thickness - 0.12, thickness + 0.12, wave);
    }
    #endif

    #if defined(DITHER_HEX)
    float getHexDots(vec2 pRot, float luma, float scale, float density) {
      float s = max(1.0, scale * 3.8);
      vec2 gridCoord = pRot / s;
      vec2 g1 = fract(gridCoord) - 0.5;
      vec2 g2 = fract(gridCoord + vec2(0.5, 0.866025)) - 0.5;
      float dist = min(length(vec2(g1.x, g1.y * 1.1547)), length(vec2(g2.x, g2.y * 1.1547)));
      float targetRadius = sqrt(clamp(1.0 - luma, 0.0, 1.0)) * 0.62 * clamp(density, 0.2, 2.5);
      return smoothstep(targetRadius + 0.08, targetRadius - 0.08, dist);
    }
    #endif

    #if defined(DITHER_CHEVRON)
    float getChevronHatch(vec2 pRot, float luma, float scale, float density) {
      float sc = max(1.0, scale * 3.6);
      float zigzag = abs(fract(pRot.x / (sc * 2.0)) - 0.5) * 2.0;
      float coord = (pRot.y + zigzag * sc * 0.8) / sc;
      float wave = abs(fract(coord) - 0.5) * 2.0;
      float thickness = clamp((1.0 - luma) * 0.85 * density, 0.03, 0.97);
      return smoothstep(thickness - 0.12, thickness + 0.12, wave);
    }
    #endif

    #if defined(DITHER_LITHO)
    float getLithoGrain(vec2 p, float luma, float scale, float density) {
      vec2 sp = p / max(0.5, scale * 1.4);
      float clump = getOrganicNoise(sp) * 0.65 + getOrganicNoise(sp * 2.13 + vec2(17.1, 43.7)) * 0.35;
      float threshold = clamp((1.0 - luma) * 0.9 * density, 0.0, 1.0);
      return smoothstep(1.0 - threshold - 0.1, 1.0 - threshold + 0.1, clump);
    }
    #endif
    #endif

    #ifdef USE_HACHURE
    // Функция расчета режимов наложения цвета штрихов (Multiply, Overlay и т.д.)
    vec3 blendHachureColor(int mode, vec3 base, vec3 blend) {
      if (mode == 1) return base * blend; // Multiply
      if (mode == 2) { // Overlay
        vec3 lo = 2.0 * base * blend;
        vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
        return mix(lo, hi, step(vec3(0.5), base));
      }
      if (mode == 3) return (1.0 - 2.0 * blend) * base * base + 2.0 * blend * base; // Soft-light
      if (mode == 4) return 1.0 - (1.0 - base) * (1.0 - blend); // Screen
      if (mode == 5) return clamp(1.0 - (1.0 - base) / max(vec3(0.001), blend), 0.0, 1.0); // Color burn
      if (mode == 6) return abs(base - blend); // Difference
      return blend; // Normal (0)
    }

    #endif

    #ifdef USE_OUTLINE
    uniform int   u_outlineBlend;
    uniform float u_outlineWidth;
    uniform float u_outlineRoughness;
    uniform float u_outlineTexture;   // <-- НОВОЕ: рыхлость графита
    uniform float u_outlineDensity;   // <-- НОВОЕ: количество/чувствительность линий
    uniform float u_outlineThreshold;
    uniform float u_outlineOpacity;
    uniform float u_outlineLightMod;
    uniform vec3  u_outlineColor;
    uniform vec2  u_outlineWorld;   // начало тайла в «css-пикселях» по модулю 4096

    vec3 blendOutlineColor(int mode, vec3 base, vec3 blend) {
      if (mode == 1) return base * blend; // Multiply
      if (mode == 2) { // Overlay
        vec3 lo = 2.0 * base * blend;
        vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
        return mix(lo, hi, step(vec3(0.5), base));
      }
      if (mode == 3) return (1.0 - 2.0 * blend) * base * base + 2.0 * blend * base; // Soft-light
      if (mode == 4) return 1.0 - (1.0 - base) * (1.0 - blend); // Screen
      if (mode == 5) return clamp(1.0 - (1.0 - base) / max(vec3(0.001), blend), 0.0, 1.0); // Color burn
      if (mode == 6) return abs(base - blend); // Difference
      return blend; // Normal
    }

    // ---- Гладкий шум, непрерывный между тайлами (период 4096; cell — степень двойки) ----
    float olHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float olNoise(vec2 wp, float cell) {
      vec2 q = wp / cell;
      float per = 4096.0 / cell;
      vec2 i = floor(q);
      vec2 f = fract(q);
      f = f * f * (3.0 - 2.0 * f);
      vec2 i0 = mod(i, per);
      vec2 i1 = mod(i + 1.0, per);
      float a = olHash(i0);
      float b = olHash(vec2(i1.x, i0.y));
      float c = olHash(vec2(i0.x, i1.y));
      float d = olHash(i1);
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    #if defined(OUTLINE_RIDGES)
      const float OL_K_RIDGE = 1.0; const float OL_K_VALLEY = 0.0;  const float OL_K_CLIFF = 0.0;
    #elif defined(OUTLINE_VALLEYS)
      const float OL_K_RIDGE = 0.0; const float OL_K_VALLEY = 1.0;  const float OL_K_CLIFF = 0.0;
    #elif defined(OUTLINE_CLIFFS)
      const float OL_K_RIDGE = 1.0; const float OL_K_VALLEY = 0.65; const float OL_K_CLIFF = 1.0;
    #else
      const float OL_K_RIDGE = 1.0; const float OL_K_VALLEY = 0.80; const float OL_K_CLIFF = 0.0;
    #endif

    // Один масштаб анализа: гессиан DEM -> расстояние до оси хребта/тальвега (в текселях)
    // и «сила» линии 0..1 (насколько резко меняется уклон на масштабе r).
    void olLineScale(ivec2 bp, float h0, int r, float thrK,
                     out float rD, out float rS, out float vD, out float vS, out float steep) {
      float rf = float(r);
      float hE  = getRawHPx(bp + ivec2( r,  0), h0);
      float hW  = getRawHPx(bp + ivec2(-r,  0), h0);
      float hN  = getRawHPx(bp + ivec2( 0,  r), h0);
      float hS  = getRawHPx(bp + ivec2( 0, -r), h0);
      float hNE = getRawHPx(bp + ivec2( r,  r), h0);
      float hNW = getRawHPx(bp + ivec2(-r,  r), h0);
      float hSE = getRawHPx(bp + ivec2( r, -r), h0);
      float hSW = getRawHPx(bp + ivec2(-r, -r), h0);

      float rr = rf * rf;
      float Hxx = (2.0 * (hE - 2.0 * h0 + hW) + (hNE - 2.0 * hN + hNW) + (hSE - 2.0 * hS + hSW)) / (4.0 * rr);
      float Hyy = (2.0 * (hN - 2.0 * h0 + hS) + (hNE - 2.0 * hE + hSE) + (hNW - 2.0 * hW + hSW)) / (4.0 * rr);
      float Hxy = (hNE - hNW - hSE + hSW) / (4.0 * rr);
      vec2 g = vec2(2.0 * (hE - hW) + (hNE - hNW) + (hSE - hSW),
                    2.0 * (hN - hS) + (hNE - hSE) + (hNW - hSW)) / (8.0 * rf);

      float mean = 0.5 * (Hxx + Hyy);
      float dd   = sqrt(0.25 * (Hxx - Hyy) * (Hxx - Hyy) + Hxy * Hxy);
      float lMax = mean + dd;                       // поперёк тальвега
      float lMin = mean - dd;                       // поперёк хребта (отрицательная)
      float th   = 0.5 * atan(2.0 * Hxy, Hxx - Hyy);
      vec2 vMax  = vec2(cos(th), sin(th));
      vec2 vMin  = vec2(-vMax.y, vMax.x);

      float kUnit = rf / max(0.01, u_metersPerPixel);
      // штраф за «купола» и «чаши», чтобы вершины/ямы не превращались в пятна
      float kR = -lMin * kUnit - 0.6 * max(0.0, -lMax * kUnit);
      float kV =  lMax * kUnit - 0.6 * max(0.0,  lMin * kUnit);

      rD = (lMin < -1e-5) ? clamp(-dot(g, vMin) / lMin, -4.0 * rf, 4.0 * rf) : 99.0;
      vD = (lMax >  1e-5) ? clamp(-dot(g, vMax) / lMax, -4.0 * rf, 4.0 * rf) : 99.0;
      rS = smoothstep(thrK, thrK * 2.6, kR);
      vS = smoothstep(thrK, thrK * 2.6, kV);

      float sMax = max(max(abs(hE - h0), abs(hW - h0)), max(abs(hN - h0), abs(hS - h0)));
      steep = smoothstep(0.55, 1.35, sMax / (rf * max(0.01, u_metersPerPixel)));
    }

    // Возвращает «вес чернил» 0..1: форма линии + давление руки + зерно графита.
    float getTerrainOutline(ivec2 bp, float h0, float hNorm, vec2 wp, float texPerCss) {
      if (h0 <= 0.25) return 0.0;

      float rough = clamp(u_outlineRoughness, 0.0, 1.0);
      float textureGrain = clamp(u_outlineTexture, 0.0, 1.0);
      float widthTex = max(0.4, u_outlineWidth) * texPerCss;

      // Регулировка количества линий: при высоком u_outlineDensity линии рисуются даже на незаметных складках
      float densityMul = mix(2.6, 0.25, clamp(u_outlineDensity, 0.05, 1.0));
      float thrK = (0.04 + 0.45 * u_outlineThreshold) * densityMul;

      float maxR = max(3.0, u_pad - 4.0);
      float r1f  = clamp(floor(26.0 / max(0.01, u_metersPerPixel) + 0.5), 2.0, min(14.0, maxR));
      float r2f  = clamp(r1f * 3.0, 6.0, min(40.0, maxR));
      int r1 = int(r1f);
      int r2 = int(r2f);

      // Дрожание руки гравёра
      float sway = ((olNoise(wp, 16.0) - 0.5) * 1.6
                 + (olNoise(wp + vec2(57.0, 23.0), 8.0) - 0.5) * 0.7) * rough * texPerCss;
      float press = mix(1.0, 0.68 + 0.60 * olNoise(wp + vec2(311.0, 5.0), 32.0), rough);

      float ink = 0.0;
      float rD, rS, vD, vS, steep;
      for (int s = 0; s < 2; s++) {
        olLineScale(bp, h0, (s == 0) ? r1 : r2, thrK, rD, rS, vD, vS, steep);
        float wMul = (s == 0) ? 0.80 : 1.20;
        float aMul = (s == 0) ? 0.72 : 1.00;
        float gate = mix(1.0, steep, OL_K_CLIFF);

        float hwR  = 0.5 * widthTex * wMul * mix(0.40, 1.0, rS) * (1.0 + 0.45 * steep) * press;
        float covR = smoothstep(0.0, 1.0, hwR + 0.5 - abs(rD + sway));
        float aR   = covR * smoothstep(0.0, 0.25, rS) * mix(0.55, 1.0, rS) * gate * OL_K_RIDGE;

        float hwV  = 0.5 * widthTex * wMul * 0.72 * mix(0.40, 1.0, vS) * mix(1.0, 0.60, hNorm) * press;
        float covV = smoothstep(0.0, 1.0, hwV + 0.5 - abs(vD + sway));
        float aV   = covV * smoothstep(0.0, 0.25, vS) * mix(0.50, 0.90, vS) * gate * OL_K_VALLEY;

        ink = max(ink, max(aR, aV) * aMul);
      }

      // Текстура графита: неравномерные чешуйки графита, застревающие в неровностях бумаги
      if (textureGrain > 0.01 && ink > 0.001) {
        // Микроструктура пор бумаги и крошащихся чешуек грифеля
        float gHash = olHash(floor(wp * 2.2));
        float gTooth = olNoise(wp * 1.5, 1.0);
        float paperTooth = mix(gHash, gTooth, 0.40);

        // При росте textureGrain штрих распадается на пористые чешуйки
        float threshold = mix(0.12, 0.68, textureGrain);
        float crumb = smoothstep(threshold - 0.22, threshold + 0.22, paperTooth + ink * 0.40);
        ink *= mix(1.0, crumb, textureGrain * 0.95);
      }

      return clamp(ink, 0.0, 1.0);
    }
    #endif


    void main() {
      ivec2 tilePx = ivec2(gl_FragCoord.xy) - u_vpOrigin;
      vec4 g = texelFetch(u_gbuf, tilePx, 0);

      if (g.r == 0.0 && g.g == 0.0 && g.b == 0.0 && g.a == 0.0) {
        fragColor = vec4(0.0);
        return;
      }
      vec4 sb = texelFetch(u_sbuf, tilePx, 0);

      // 1. Координата в DEM-текстуре тайла
      ivec2 basePx = ivec2(floor(v_uv * vec2(u_iRes)));
      float centerH = getRawHPx(basePx, -99999.0);
      if (centerH < -1000.0) {
        fragColor = vec4(0.0);
        return;
      }

      // 2. Сначала рассчитываем hNorm, чтобы переменная была доступна дальше
      float hNorm = (u_isManualMode == 1 && u_manualScaleMode == 1)
        ? clamp((centerH - u_manualElevMin) / max(1.0, u_manualElevMax - u_manualElevMin), 0.0, 1.0)
        : clamp((centerH - u_elevMin) / max(1.0, u_elevSpan), 0.0, 1.0);

      // 3. Восстановление нормалей и параметров из G-буфера
      vec2 nxy = g.xy * 2.0 - 1.0;
      float nz = sqrt(max(0.0001, 1.0 - dot(nxy, nxy)));
      vec3 norm = vec3(nxy, nz);

      float aoVal = g.b;
      float svf = aoVal;
      float crestGlint = clamp(g.a - 0.5, 0.0, 0.40);
      float ridgeness = smoothstep(0.35, 0.85, hNorm);

      float safeNz = max(0.001, norm.z);
      float dzdx = -norm.x / safeNz;
      float dzdy = -norm.y / safeNz;
      float slope = length(vec2(dzdx, dzdy));

      float maxSafeR = max(1.0, u_pad - 3.0);
      float maxSafeMeters = maxSafeR * u_metersPerPixel;

      vec3 effectiveSunDir = u_sunDir;

      if (u_imhofDeflection > 0.01 && slope > 0.02) {
        vec2 aspectDir = normalize(vec2(-dzdx, -dzdy));
        float sLen = length(u_sunDir.xy);
        vec2 sunDir2D = (sLen > 0.0001) ? (u_sunDir.xy / sLen) : vec2(0.0, 1.0);
        float sin2A = (aspectDir.x * sunDir2D.y - aspectDir.y * sunDir2D.x) * dot(aspectDir, sunDir2D) * 2.0;
        float rotAngle = sin2A * (u_imhofDeflection * 0.45) * smoothstep(0.02, 0.25, slope);
        float cosR = cos(rotAngle);
        float sinR = sin(rotAngle);
        vec2 deflXY = vec2(sunDir2D.x * cosR - sunDir2D.y * sinR, sunDir2D.x * sinR + sunDir2D.y * cosR);
        effectiveSunDir = normalize(vec3(deflXY * length(u_sunDir.xy), u_sunDir.z));
      }

      float wrappedLight;
      float castShadow = 1.0;

      // 1. Учет зоны проникновения дневного света (u_dayReach):
      // Регулирует доступ лучей на пологие склоны и в складки рельефа
      float reachBias = (u_dayReach - 0.5) * 0.45;
      float adjustedLightWrap = clamp(u_lightWrap + reachBias, 0.05, 0.85);
      // При низком солнце оборачивание света сокращаем: освещённым остаётся только склон, обращённый к Солнцу
      adjustedLightWrap *= mix(1.0, 0.40, u_twilightAmt);

      #ifdef USE_MDOW
        vec3 dir1 = effectiveSunDir;
        vec3 dir2 = normalize(vec3(effectiveSunDir.y, -effectiveSunDir.x, effectiveSunDir.z * 1.1));
        vec3 dir3 = normalize(vec3(-effectiveSunDir.y, effectiveSunDir.x, effectiveSunDir.z * 0.9));
        vec3 dir4 = normalize(vec3(-effectiveSunDir.x * 0.5, -effectiveSunDir.y * 0.5, 0.75));

        float l1 = getOrenNayarLight(norm, dir1, u_orenNayarRoughness, adjustedLightWrap);
        float l2 = getOrenNayarLight(norm, dir2, u_orenNayarRoughness, adjustedLightWrap * 0.7);
        float l3 = getOrenNayarLight(norm, dir3, u_orenNayarRoughness, adjustedLightWrap * 0.7);
        float l4 = max(0.0, dot(norm, dir4));

        wrappedLight = l1 * 0.55 + l2 * 0.20 + l3 * 0.15 + l4 * 0.10;
        // l4 светит с ПРОТИВОПОЛОЖНОЙ стороны, l2/l3 — сбоку: в сумерки оставляем почти чистый l1
        wrappedLight = mix(wrappedLight, l1, clamp(u_twilightAmt * 0.85, 0.0, 0.85));
      #else
        wrappedLight = getOrenNayarLight(norm, effectiveSunDir, u_orenNayarRoughness, adjustedLightWrap);
      #endif

      // Дополнительное проникновение лучей в долины по фактору досягаемости
      wrappedLight = pow(wrappedLight, mix(1.3, 0.7, clamp(u_dayReach, 0.0, 1.0)));

      if (centerH > 0.25 && wrappedLight > 0.005 && u_sunIntensity > 0.01 && u_shadowOpacity > 0.01) {
        castShadow = computeCastShadowPx(basePx, v_tileLocalPx, centerH, effectiveSunDir, maxSafeMeters);
        castShadow = mix(1.0, castShadow, clamp(u_sunIntensity * 1.15, 0.25, 1.0));
      } else {
        castShadow = 1.0;
      }
      float directLight = wrappedLight * castShadow * u_sunIntensity;
      float skyFill = clamp(dot(norm, vec3(0.0, 0.0, 1.0)) * 0.65 + 0.35, 0.0, 1.0);

      float dayLuma = clamp(dot(u_lightColor, vec3(0.299, 0.587, 0.114)), 0.05, 1.0);

      float halfW1 = max(0.01, u_manualLightSoftness * 0.5);
      float halfW2 = max(0.01, u_manualLightSoftness2 * 0.5);
      float b1 = u_manualLightBlend;
      float b2 = max(u_manualLightBlend, u_manualLightBlend2);

      float t1 = smoothstep(b1 - halfW1, b1 + halfW1, hNorm);
      float t2 = smoothstep(b2 - halfW2, b2 + halfW2, hNorm);

      if (u_debugValley == 1) {
        vec3 dbgCol = mix(mix(u_manualColorValley, u_manualColorMid, t1), u_manualColorPeak, t2);
        fragColor = vec4(dbgCol, 1.0);
        return;
      }

      vec3 warmSunCol = u_lightColor;
      vec3 coolShaCol = u_shadowColor;
      float twilightShade = 0.0;
      float hEff = hNorm;
      const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

      if (u_isManualMode == 1) {
        float hLit = clamp(hNorm + crestGlint * 0.25, 0.0, 1.0);
        float t1Lit = smoothstep(b1 - halfW1, b1 + halfW1, hLit);
        float t2Lit = smoothstep(b2 - halfW2, b2 + halfW2, hLit);
        warmSunCol = mix(mix(u_manualColorValley, u_manualColorMid, t1Lit), u_manualColorPeak, t2Lit);

        vec3 lowTint = mix(u_manualColorValley, u_manualColorMid, t1);
        coolShaCol = mix(coolShaCol, lowTint * 0.75, (1.0 - t2) * 0.55);
      } else {
        float effLen = length(effectiveSunDir.xy);
        vec2 sunDir2D = (effLen > 0.0001) ? (effectiveSunDir.xy / effLen) : vec2(0.0, 1.0);
        float sunDot2D = dot(-vec2(dzdx, dzdy), sunDir2D);
        float sunFacing = smoothstep(-0.05, 0.35, sunDot2D);

        float directFacing = smoothstep(0.0, 0.25, dot(norm, effectiveSunDir)) * castShadow;

        float edgeW = mix(0.05, 0.14, u_twilightAmt);
        hEff = hNorm + (sunFacing - 0.5) * 0.32 + crestGlint * 0.35 * mix(0.25, 1.0, sunFacing);
        float litMask = smoothstep(u_twilightClimb - edgeW, u_twilightClimb + edgeW, hEff);

        // Мягкое подмешивание персонального цвета граней вместо дикой сатурации:
        float faceExposure = clamp(directFacing * sunFacing, 0.0, 1.0) * (1.0 - u_afterglow);
        warmSunCol = mix(warmSunCol, u_sunFaceColor, faceExposure * u_twilightAmt);

        // Управление насыщенностью освещенных граней:
        float lumaWarm = dot(warmSunCol, LUMA_W);
        warmSunCol = mix(vec3(lumaWarm), warmSunCol, u_twilightSat);

        // Альпенглоу для самых пиков:
        float glowAmt = u_alpenglowWeight * litMask * sunFacing * clamp(crestGlint * 2.0 + faceExposure * 0.5, 0.0, 1.0);
        warmSunCol = mix(warmSunCol, u_glowColor, glowAmt * 0.75);

        directLight *= mix(litMask, 1.0, 1.0 - u_twilightAmt);
        if (glowAmt > 0.001) {
          directLight = max(directLight, glowAmt * 0.35);
        }

        twilightShade = (1.0 - litMask * sunFacing) * u_twilightAmt;
        coolShaCol = mix(coolShaCol, u_valleyColor, twilightShade * 0.45);
      }

      // --- 2. КАЙМА ТЕРМИНАТОРА (ЗАЩИЩЕНА ОТ ПРОТЕЧКИ В НОЧЬ) ---
      float terminatorEdge = smoothstep(0.05, 0.45, directLight) * (1.0 - smoothstep(0.40, 0.85, directLight));
      float twilightBand = smoothstep(u_twilightClimb - 0.18, u_twilightClimb, hEff) * 
                           (1.0 - smoothstep(u_twilightClimb, u_twilightClimb + 0.22, hEff));
      
      // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: кайма строго масштабируется u_twilightAmt, ночью она = 0.0!
      float rimFactor = clamp((terminatorEdge * 0.65 + twilightBand * 1.0) * u_twilightAmt, 0.0, 1.0);

      // --- АФТЕРГЛОУ: рассеянный свет зари со стороны, где село/встанет Солнце ---
      if (u_isManualMode != 1 && u_afterglow > 0.001) {
        float facingGlow = clamp(dot(norm, effectiveSunDir) * 0.5 + 0.5, 0.0, 1.0);
        facingGlow *= facingGlow;                                  // 1 = лицом к заре, 0 = спиной
        float afterLight = u_afterglow * (0.08 + 0.40 * facingGlow) * mix(0.55, 1.0, svf);
        directLight = max(directLight, afterLight);
      }

      vec3 ambientSky = mix(coolShaCol, u_skyColor, 0.45 * u_imhofWarmCool);
      vec3 ambientTerrain = (u_isManualMode == 1) ? mix(coolShaCol, warmSunCol, 0.35) : ambientSky;

      vec3 litTerrain = mix(coolShaCol, warmSunCol, smoothstep(0.05, 0.95, directLight));
      litTerrain = mix(litTerrain, u_twilightRimColor, rimFactor * 0.70);

      float totalLightWeight = clamp(directLight + skyFill * svf * 0.55 * max(0.3, u_sunIntensity), 0.0, 1.0);
      vec3 finalCol = mix(ambientTerrain, litTerrain, totalLightWeight);

      // --- 3. ДНЕВНОЕ СВЕЧЕНИЕ С УПРАВЛЕНИЕМ ЗОНОЙ ДОСТУПА ---
      // Приглушение пластиковых бликов (спекулярный демпфер)
      float effectiveCrestGlint = crestGlint * (1.0 - u_specularDamp * 0.85);

      // --- 3. ДНЕВНОЕ СВЕЧЕНИЕ С УПРАВЛЕНИЕМ ЗОНОЙ ДОСТУПА (ДУБЛИКАТ УДАЛЕН) ---
      if (u_dayGlowStrength > 0.001) {
        float reachThreshold = mix(0.45, 0.02, clamp(u_dayReach, 0.0, 1.0));
        float dayLit = smoothstep(reachThreshold, 0.85, directLight);
        float ridgeSun = clamp(effectiveCrestGlint * 1.5 + dayLit * 0.75, 0.0, 1.0);
        float sunBloom = mix(ridgeSun * 0.45, pow(dayLit, 1.3), clamp(u_dayReach, 0.0, 1.0));
        
        vec3 glowCol = u_dayGlowColor * (sunBloom * u_dayGlowStrength * (1.0 - u_specularDamp * 0.5));
        finalCol += glowCol * (1.0 - twilightShade);
      }

      // Определение ночного режима и мягкая лунная подсветка рельефа
      float isNight = smoothstep(0.06, 0.30, u_lightColor.b - u_lightColor.r);
      if (isNight > 0.01) {
        // Мягкое лунное серебрение гребней без пересветов
        vec3 moonGlintCol = mix(warmSunCol, vec3(0.70, 0.85, 1.10), 0.50);
        finalCol += moonGlintCol * (effectiveCrestGlint * svf * 0.20 * isNight);

        // Рассеянный ночной скайлайт в складки теней (убирает черноту и жесткость):
        finalCol += u_skyColor * (0.08 * isNight * (1.0 - directLight));
      }

      // Ночью приглушаем агрессивность AO и SVF, чтобы тени не пережигались в 0.0
      float nightAOFactor = mix(1.0, 0.40, isNight); // ночью влияние AO слабее на 60%
      float effAO = mix(1.0, aoVal, nightAOFactor);
      float effSVF = mix(1.0, svf, min(1.0, u_svfStrength * 0.30 * (1.0 - isNight * 0.5)));

      finalCol *= effAO;
      finalCol *= effSVF;

      // Сине-фиолетовый тон низин: меняем цвет, сохраняя яркость и детали рельефа
      if (twilightShade > 0.001) {
        vec3 vc = u_valleyColor / max(0.05, dot(u_valleyColor, LUMA_W));
        finalCol = mix(finalCol, vec3(dot(finalCol, LUMA_W)) * vc, clamp(twilightShade * 0.55, 0.0, 0.6));
      }

      // МЯГКИЙ БУСТ СВЕТА
      float boostDiff = u_lightBoost - 1.0;
      if (abs(boostDiff) > 0.001) {
        float lumB = dot(finalCol, LUMA_W);
        float heightW = mix(0.30, 1.0, smoothstep(0.0, 1.0, hNorm)) + ridgeness * 0.15 + effectiveCrestGlint * 0.4;
        float litW = mix(0.35, 1.0, smoothstep(0.15, 0.85, directLight));
        float twilightDamp = mix(1.0, 0.60, u_alpenglowWeight);
        float k = boostDiff * heightW * litW * twilightDamp;
        if (k > 0.0) {
          float lift = k * 0.28 * (1.0 - smoothstep(0.55, 1.0, lumB));
          finalCol *= 1.0 + lift;
          float lumA = dot(finalCol, LUMA_W);
          finalCol = mix(finalCol, vec3(lumA), clamp(k * 0.12, 0.0, 0.25));
        } else {
          finalCol *= 1.0 + k * 0.35;
        }
      }

      #ifdef USE_HACHURE
      {
        // Не штриховать воду и береговой срез
        if (centerH > 0.25) {
          float sunMod = mix(1.0, clamp(1.25 - directLight, 0.15, 1.0), u_hachureLightMod);
          float hachureDarkness = (floor(sb.r * 255.0 + 0.5) * 256.0 + floor(sb.g * 255.0 + 0.5)) / 65535.0;
          hachureDarkness *= 1.0 - smoothstep(0.05, 0.6, sb.b);

        #if defined(HACHURE_ROCK)
          float ridge = clamp(effectiveCrestGlint * 2.5, 0.0, 1.0);
          finalCol += warmSunCol * (ridge * hachureDarkness * 0.35);
        #endif

        if (u_inkBleed > 0.5 && hachureDarkness > 0.2) {
          finalCol -= vec3(smoothstep(0.2, 0.9, hachureDarkness) * 0.08);
        }

        float hAlpha = clamp(hachureDarkness * u_hachureOpacity * sunMod, 0.0, 1.0);
        vec3 blendedHachColor = blendHachureColor(u_hachureBlend, finalCol, u_hachureColor);
        finalCol = mix(finalCol, blendedHachColor, hAlpha);
        }
      } // <-- Добавьте вторую закрывающую скобку
      #endif


      if (u_hypso > 0) {
        finalCol = mix(finalCol, finalCol * getVintageHypso(centerH), 0.70);
      }

      if (u_inkBleed > 0.5) {
        float edgeBleed = smoothstep(0.3, 0.7, directLight) * (1.0 - smoothstep(0.3, 0.7, directLight));
        finalCol -= vec3(edgeBleed * 0.05);
        finalCol -= vec3(clamp(slope * 0.25, 0.0, 0.09) * (1.0 - directLight * 0.45));
      }

      float paperGrain = (sb.a - 0.5) * (u_paperGrain * 0.22);
      finalCol += vec3(paperGrain * dayLuma);

      #ifdef USE_BOUNCE
      if (u_bounceStrength > 0.001 && u_sunIntensity > 0.05) {
        // Проверяем, смотрит ли теневой склон на противоположную освещенную стену:
        float bounceFacing = max(0.0, dot(norm.xy, -effectiveSunDir.xy));
        // Отражение проявляется только в складках/тальвегах (где низкий SVF/AO) и на реальных склонах:
        float valleyTrap = clamp((1.0 - aoVal) * 1.8 + (1.0 - svf), 0.0, 1.0);
        float bounceFactor = bounceFacing * (1.0 - directLight) * valleyTrap * smoothstep(0.04, 0.35, slope);
        
        vec3 bounceColor = warmSunCol * 0.65 + u_skyColor * 0.15;
        finalCol += bounceColor * (bounceFactor * u_bounceStrength * (1.0 - twilightShade));
      }
      #endif


// Коэффициент воды: 1.0 = море/озеро, 0.0 = берег/суша
      float waterMask = 0.0;

      if (u_hasWaterMask == 1) {
        vec2 maskUv = clamp(v_tileLocalPx / 256.0, 0.0, 1.0);
        waterMask = texture(u_waterMask, maskUv).r;
      } else {
        waterMask = 1.0 - smoothstep(0.1, 0.8, centerH);
        if (sb.b > 0.001) {
          vec2 qW = v_uv * vec2(u_iRes) - 0.5;
          ivec2 i0 = ivec2(floor(qW));
          vec2 fW = fract(qW);
          float wa = 1.0 - smoothstep(0.1, 0.8, getRawHPx(i0, centerH));
          float wb = 1.0 - smoothstep(0.1, 0.8, getRawHPx(i0 + ivec2(1, 0), centerH));
          float wc = 1.0 - smoothstep(0.1, 0.8, getRawHPx(i0 + ivec2(0, 1), centerH));
          float wd = 1.0 - smoothstep(0.1, 0.8, getRawHPx(i0 + ivec2(1, 1), centerH));
          float mW = mix(mix(wa, wb, fW.x), mix(wc, wd, fW.x), fW.y);
          waterMask = smoothstep(0.3, 0.7, mW);
        }
      }

      #ifdef USE_FEAT_TINT
      if (u_hasFeatMask == 1) {
        vec2 featUv = clamp(v_tileLocalPx / 256.0, 0.0, 1.0);
        vec4 feat = texture(u_featMask, featUv);

        if (u_edgeTintOn == 1 && u_edgeTintOpacity > 0.001) {
          float distEdge = (1.0 - feat.g) * 48.0;
          float eZone = max(1.0, u_edgeTintZone);
          float eSoft = clamp(u_edgeTintSoftness, 0.02, 1.0);
          float eInner = eZone * (1.0 - eSoft);
          float edgeAmt = 1.0 - smoothstep(eInner, eZone, distEdge);
          if (u_edgeTintSide == 1) {
            edgeAmt *= (1.0 - smoothstep(0.35, 0.65, feat.b));
          } else if (u_edgeTintSide == 2) {
            edgeAmt *= smoothstep(0.35, 0.65, feat.b);
          }
          edgeAmt *= (1.0 - waterMask);
          float eAlpha = clamp(edgeAmt * u_edgeTintOpacity, 0.0, 1.0);
          if (eAlpha > 0.001) {
            vec3 edgeCol = applyFeatureTint(u_edgeTintBlend, finalCol, u_edgeTintColor, directLight, u_sunIntensity);
            finalCol = mix(finalCol, edgeCol, eAlpha);
          }
        }

        if (u_roadTintOn == 1 && u_roadTintOpacity > 0.001) {
          float distRoad = (1.0 - feat.r) * 48.0;
          float rZone = max(1.0, u_roadTintZone);
          float rSoft = clamp(u_roadTintSoftness, 0.02, 1.0);
          float rInner = rZone * (1.0 - rSoft);
          float roadAmt = 1.0 - smoothstep(rInner, rZone, distRoad);
          float rAlpha = clamp(roadAmt * u_roadTintOpacity, 0.0, 1.0);
          if (rAlpha > 0.001) {
            vec3 roadCol = applyFeatureTint(u_roadTintBlend, finalCol, u_roadTintColor, directLight, u_sunIntensity);
            finalCol = mix(finalCol, roadCol, rAlpha);
          }
        }
      }
      #endif



      #ifdef USE_DITHER
      if (centerH > 0.25) {
        float luma = dot(finalCol, vec3(0.299, 0.587, 0.114));
        vec2 p = u_ditherWorld + v_tileLocalPx;
        float dScale = max(0.4, u_ditherScale);
        vec2 pRot = rotate2D(p, (u_ditherAngle * 3.14159265) / 180.0);
        float ditherMask = 0.0;

        #if defined(DITHER_BLUE)
          ditherMask = (clamp(luma / max(0.1, u_ditherDensity), 0.0, 1.0) < getOrganicNoise(p / dScale)) ? 1.0 : 0.0;
        #elif defined(DITHER_HATCH)
          ditherMask = getLinearHatch(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_DOTS)
          ditherMask = getHalftoneDots(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_BAYER)
          ditherMask = (clamp(luma / max(0.1, u_ditherDensity), 0.0, 1.0) < getBayer4(pRot / dScale)) ? 1.0 : 0.0;
        #elif defined(DITHER_WOODCUT)
          ditherMask = getWoodcutHatch(pRot, luma, dScale, u_ditherDensity, vec2(dzdx, dzdy), hNorm, slope, u_ditherAngle);
        #elif defined(DITHER_CROSS)
          ditherMask = getCrossHatch(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_STIPPLE)
          float stipple = smoothstep(0.25, 0.85, (getOrganicNoise(p / (dScale * 1.5)) * 0.6 + hash(floor(pRot / (dScale * 1.8))) * 0.4));
          ditherMask = (clamp(luma / max(0.1, u_ditherDensity), 0.0, 1.0) < stipple) ? 1.0 : 0.0;
        #elif defined(DITHER_WAVY)
          ditherMask = getWavyHatch(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_HEX)
          ditherMask = getHexDots(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_CHEVRON)
          ditherMask = getChevronHatch(pRot, luma, dScale, u_ditherDensity);
        #elif defined(DITHER_LITHO)
          ditherMask = getLithoGrain(p, luma, dScale, u_ditherDensity);
        #endif

        float halfSoft = max(0.01, u_ditherSoftness * 0.5);
        float highPass = smoothstep(u_ditherThreshold + halfSoft, u_ditherThreshold - halfSoft, luma);
        float lowCutPass = smoothstep(u_ditherLowCut - halfSoft, u_ditherLowCut + halfSoft, luma);
        float zoneWeight = (u_ditherZone == 0) ? (highPass * lowCutPass) :
                           ((u_ditherZone == 1) ? (smoothstep(u_ditherThreshold - halfSoft, u_ditherThreshold + halfSoft, luma) * lowCutPass) : lowCutPass);

        vec3 targetInkColor = blendDitherColor(u_ditherBlend, finalCol, u_ditherColor);
        finalCol = mix(finalCol, targetInkColor, clamp(ditherMask * zoneWeight * u_ditherStrength, 0.0, 1.0));
      } // <-- Оставьте только одну скобку закрытия if (centerH > 0.25)
      #endif

      if (u_waterlining > 0.5) {
        float wlVal = sb.b;
        if (wlVal > 0.001) {
          float dist = (1.0 - wlVal) * 12.0;
          float halfW = max(0.25, u_waterlineWidth * 0.5);
          float lineAlpha = smoothstep(halfW + 0.5, halfW - 0.5, dist) * u_waterlineOpacity;
          finalCol = mix(finalCol, u_waterlineColor, lineAlpha);
        }
      }
     

      // АТМОСФЕРНАЯ ДЫМКА / ВОЗДУШНАЯ ПЕРСПЕКТИВА (Sky Haze)
      if (u_hazeStrength > 0.001) {
        float valleyDepth = clamp((1.0 - hNorm) * 0.70 + (1.0 - svf) * 0.30, 0.0, 1.0);
        finalCol = mix(finalCol, u_skyColor, valleyDepth * u_hazeStrength * 0.42);
      }

      if (u_colorTone > 0) {
        float lum = dot(finalCol, LUMA_W);
        vec3 graded = finalCol;

        if (u_colorTone == 1) {
          // 🇨🇭 Имхоф (Swisstopo Classic):
          // Лазурно-сланцевые прохладные тени, тёплые золотисто-кремовые освещённые склоны
          vec3 sCol = vec3(0.32, 0.44, 0.66);
          vec3 hCol = vec3(1.06, 0.98, 0.86);
          vec3 tint = mix(sCol, hCol, smoothstep(0.12, 0.88, lum));
          graded = mix(finalCol * tint * 1.15, finalCol, 0.22);
          float sLum = dot(graded, LUMA_W);
          graded = mix(vec3(sLum), graded, 1.18);
        } else if (u_colorTone == 2) {
          // 🏔️ Сланец (Nordic Slate):
          // Суровый минеральный гранит, приглушённая насыщенность, глубокий контраст
          vec3 sCol = vec3(0.28, 0.36, 0.50);
          vec3 hCol = vec3(0.94, 0.98, 1.04);
          vec3 tint = mix(sCol, hCol, smoothstep(0.20, 0.80, lum));
          graded = mix(vec3(lum), finalCol * tint * 1.25, 0.55);
          graded = (graded - 0.5) * 1.12 + 0.5;
        } else if (u_colorTone == 3) {
          // 📜 Винтаж (Antique Parchment):
          // Старинная гравюра на пергаменте, тёплая сепия, благородная патина
          vec3 sCol = vec3(0.46, 0.34, 0.24);
          vec3 mCol = vec3(0.90, 0.82, 0.68);
          vec3 hCol = vec3(1.02, 0.96, 0.86);
          vec3 tint = (lum < 0.5) ? mix(sCol, mCol, lum * 2.0) : mix(mCol, hCol, (lum - 0.5) * 2.0);
          graded = mix(finalCol, vec3(lum) * tint * 1.12, 0.72);
        } else if (u_colorTone == 4) {
          // 🌅 Янтарь (Cinematic Teal & Amber):
          // Бирюзово-хвойные тени и насыщенный тёплый золотой свет
          vec3 sCol = vec3(0.16, 0.44, 0.54);
          vec3 hCol = vec3(1.10, 0.86, 0.52);
          vec3 tint = mix(sCol, hCol, smoothstep(0.10, 0.90, lum));
          graded = mix(finalCol * tint * 1.25, finalCol, 0.15);
          float aLum = dot(graded, LUMA_W);
          graded = mix(vec3(aLum), graded, 1.25);
        } else if (u_colorTone == 5) {
          // 🌲 Хвоя (Alpine Pine & Moss):
          // Глубокие изумрудно-моховые тени и свежие серебристо-зелёные склоны
          vec3 sCol = vec3(0.20, 0.42, 0.30);
          vec3 hCol = vec3(0.96, 1.04, 0.92);
          vec3 tint = mix(sCol, hCol, smoothstep(0.15, 0.85, lum));
          graded = mix(finalCol * tint * 1.20, finalCol, 0.28);
          float eLum = dot(graded, LUMA_W);
          graded = mix(vec3(eLum), graded, 1.15);
        } else if (u_colorTone == 6) {
          // ✒️ Монохром (Charcoal Lithography):
          // Контрастный штриховой монохром с лёгким холодным серебряным отливом
          vec3 sCol = vec3(0.14, 0.16, 0.22);
          vec3 hCol = vec3(0.98, 0.99, 1.02);
          vec3 mono = mix(sCol, hCol, smoothstep(0.05, 0.95, lum));
          graded = mix(finalCol, mono, 0.90);
          graded = (graded - 0.5) * 1.15 + 0.5;
        } else if (u_colorTone == 7) {
          // 🏜️ Песчаник (Canyon Sandstone):
          // Тёплые обожжённые терракотовые тени и светящийся золотистый песок
          vec3 sCol = vec3(0.40, 0.22, 0.18);
          vec3 hCol = vec3(1.10, 0.92, 0.72);
          vec3 tint = mix(sCol, hCol, smoothstep(0.12, 0.88, lum));
          graded = mix(finalCol * tint * 1.22, finalCol, 0.18);
          float tLum = dot(graded, LUMA_W);
          graded = mix(vec3(tLum), graded, 1.20);
        } else if (u_colorTone == 8) {
          // ❄️ Ледник (Arctic Glacier):
          // Морозные ультрамариново-кобальтовые тени и хрустальный бирюзово-белый свет
          vec3 sCol = vec3(0.16, 0.24, 0.48);
          vec3 hCol = vec3(0.88, 1.02, 1.12);
          vec3 tint = mix(sCol, hCol, smoothstep(0.15, 0.85, lum));
          graded = mix(finalCol * tint * 1.20, finalCol, 0.20);
          float gLum = dot(graded, LUMA_W);
          graded = mix(vec3(gLum), graded, 1.25);
        } else if (u_colorTone == 9) {
          // 🌋 Базальт (Volcanic Basalt & Copper):
          // Глубокий пепельно-графитовый базальт и тёплые медно-бронзовые гребни
          vec3 sCol = vec3(0.18, 0.15, 0.17);
          vec3 hCol = vec3(1.12, 0.78, 0.52);
          vec3 tint = mix(sCol, hCol, smoothstep(0.10, 0.90, lum));
          graded = mix(finalCol * tint * 1.25, finalCol, 0.22);
          float vLum = dot(graded, LUMA_W);
          graded = mix(vec3(vLum), graded, 1.15);
        }

        finalCol = clamp(graded, 0.0, 1.0);
      }

      #ifdef USE_OUTLINE
      {
        float olTexPerCss = max(0.5, (float(u_iRes.x) - 2.0 * u_pad) / 256.0);
        vec2  olWorld = u_outlineWorld + (vec2(basePx) - vec2(u_pad) + 0.5) / olTexPerCss;
        float inkV = getTerrainOutline(basePx, centerH, hNorm, olWorld, olTexPerCss);
        inkV *= 1.0 - smoothstep(0.05, 0.6, sb.b);
        if (inkV > 0.004) {
          // Ослабление нажима карандаша на ярком свету
          float sunMod = mix(1.0, clamp(1.25 - directLight, 0.18, 1.0), u_outlineLightMod);
          float outlineAlpha = clamp(inkV * u_outlineOpacity * sunMod, 0.0, 1.0);
          vec3 blendedOutline = blendOutlineColor(u_outlineBlend, finalCol, u_outlineColor);
          finalCol = mix(finalCol, blendedOutline, outlineAlpha);
        }
      }
      #endif


      // Легкое подтемнение воды глубоким синеватым тоном (реки, горные озера и моря)
      if (waterMask > 0.01) {
        vec3 deepWaterTint = vec3(0.14, 0.22, 0.32);
        finalCol = mix(finalCol, finalCol * deepWaterTint * 1.6, waterMask * 0.40);
      }

      // --- НАЛОЖЕНИЕ ТОНИРОВКИ ВОДЫ (СТЯЖКА ОТ БЕРЕГОВ К ЦЕНТРУ) ---
      if (waterMask > 0.005 && u_waterTintEnabled == 1 && u_waterTintOpacity > 0.001) {
        float shoreDist = clamp(1.0 - sb.b, 0.0, 1.0); // 0.0 на кромке берега, 1.0 в глубине / центре

        // Стяжка от берегов: чем меньше u_waterTintCoverage, тем дальше от берега начинается цвет
        float fillMask = 1.0;
        if (u_waterTintCoverage < 0.999) {
          float startEdge = 1.0 - u_waterTintCoverage;
          fillMask = smoothstep(startEdge, min(1.0, startEdge + 0.35), shoreDist);
        }

        float tintAlpha = clamp(waterMask * fillMask * u_waterTintOpacity, 0.0, 1.0);

        if (tintAlpha > 0.001) {
          vec3 tintedWater = u_waterTintColor;
          if (u_waterTintBlend == 1) { // Multiply
            tintedWater = finalCol * u_waterTintColor;
          } else if (u_waterTintBlend == 2) { // Overlay
            vec3 lo = 2.0 * finalCol * u_waterTintColor;
            vec3 hi = 1.0 - 2.0 * (1.0 - finalCol) * (1.0 - u_waterTintColor);
            tintedWater = mix(lo, hi, step(vec3(0.5), finalCol));
          } else if (u_waterTintBlend == 3) { // Soft-Light
            tintedWater = (1.0 - 2.0 * u_waterTintColor) * finalCol * finalCol + 2.0 * u_waterTintColor * finalCol;
          }
          finalCol = mix(finalCol, tintedWater, tintAlpha);
        }
      }

      #ifdef USE_SEA_WAVES
      if (waterMask > 0.01) {
        float shoreDistNorm = 1.0 - sb.b; // 0 у кромки берега, 1 вдали

        if (u_seaWaveFillEnabled == 1) {
          finalCol = mix(finalCol, u_seaWaveFillColor, u_seaWaveFillOpacity * waterMask);
        }

        float texPerCss = max(0.5, (float(u_iRes.x) - 2.0 * u_pad) / 256.0);
        vec2 seaWp = u_seaWorld + (vec2(basePx) - vec2(u_pad) + 0.5) / texPerCss;

        // Вычисляем градиент удаленности от берегов для выявления русла
        const ivec2 sbufLimit = ivec2(255);
        float bR = texelFetch(u_sbuf, clamp(tilePx + ivec2(1, 0), ivec2(0), sbufLimit), 0).b;
        float bL = texelFetch(u_sbuf, clamp(tilePx - ivec2(1, 0), ivec2(0), sbufLimit), 0).b;
        float bT = texelFetch(u_sbuf, clamp(tilePx + ivec2(0, 1), ivec2(0), sbufLimit), 0).b;
        float bB = texelFetch(u_sbuf, clamp(tilePx - ivec2(0, 1), ivec2(0), sbufLimit), 0).b;


        vec2 gradShore = vec2(bR - bL, bT - bB);
        float gradLen = length(gradShore);

        // Вектор вдоль русла реки (касательная к изолинии расстояния до берегов)
        vec2 riverTangent = (gradLen > 0.005) ? normalize(vec2(-gradShore.y, gradShore.x)) : vec2(1.0, 0.0);
        float riverInfluence = smoothstep(0.008, 0.08, gradLen) * smoothstep(0.0, 0.7, sb.b);
        vec2 flowDir = normalize(mix(vec2(1.0, 0.0), riverTangent, riverInfluence));

        float waveInk = getCartaMarinaWaves(seaWp, shoreDistNorm, flowDir, riverInfluence);
        if (waveInk > 0.002) {
          float waveAlpha = clamp(waveInk * u_seaWaveOpacity * waterMask, 0.0, 1.0);
          vec3 inkCol = u_seaWaveColor;
          if (u_seaWaveBlend == 1) inkCol = finalCol * u_seaWaveColor;
          else if (u_seaWaveBlend == 2) {
            vec3 lo = 2.0 * finalCol * u_seaWaveColor;
            vec3 hi = 1.0 - 2.0 * (1.0 - finalCol) * (1.0 - u_seaWaveColor);
            inkCol = mix(lo, hi, step(vec3(0.5), finalCol));
          } else if (u_seaWaveBlend == 3) {
            inkCol = (1.0 - 2.0 * u_seaWaveColor) * finalCol * finalCol + 2.0 * u_seaWaveColor * finalCol;
          }
          finalCol = mix(finalCol, inkCol, waveAlpha);
        }
      }
      #endif

      fragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
    }
  `;
  }

  let sharedGl = null;
  let sharedGlId = 0;
  let sharedGeomProg = null;
  let sharedVao = null;
  let sharedFbo = null;
  let geomLocations = null;
  let globalGeomVersion = 1;

  // Кэш программ освещения по ключу флагов
  const lightProgramCache = new Map();

  function getOrCreateLightProgram(gl, flags) {
    const key = [
      flags.mdow ? '1' : '0',
      flags.hachure ? (flags.hachureType || 'classic') : '0',
      flags.dither ? (flags.ditherType || 'blue') : '0',
      flags.outline ? (flags.outlineType || 'all') : '0',
      flags.bounce ? '1' : '0',
      flags.contactShadows ? '1' : '0',
      flags.seaWaves ? (flags.seaWaveStyle || 'ripples') : '0',
      flags.featTint ? '1' : '0'
    ].join('|');

    if (lightProgramCache.has(key)) {
      return lightProgramCache.get(key);
    }

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Light Shader Error:', gl.getShaderInfoLog(s));
      }
      return s;
    }

    const fsSrc = buildLightFragmentShader(flags);
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS_SOURCE));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.bindAttribLocation(prog, 1, 'a_uv');
    gl.linkProgram(prog);



    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Light Program Link Error:', gl.getProgramInfoLog(prog));
    }

    const locs = {
      dem: gl.getUniformLocation(prog, 'u_dem'),
      gbuf: gl.getUniformLocation(prog, 'u_gbuf'),
      sbuf: gl.getUniformLocation(prog, 'u_sbuf'),
      demMaxH: gl.getUniformLocation(prog, 'u_demMaxH'),
      iRes: gl.getUniformLocation(prog, 'u_iRes'),
      pad: gl.getUniformLocation(prog, 'u_pad'),

      uvOrigin: gl.getUniformLocation(prog, 'u_uvOrigin'),
      ditherWorld: gl.getUniformLocation(prog, 'u_ditherWorld'),
      uvScale: gl.getUniformLocation(prog, 'u_uvScale'),
      sunDir: gl.getUniformLocation(prog, 'u_sunDir'),
      lightColor: gl.getUniformLocation(prog, 'u_lightColor'),
      shadowColor: gl.getUniformLocation(prog, 'u_shadowColor'),
      skyColor: gl.getUniformLocation(prog, 'u_skyColor'),
      alpenglowWeight: gl.getUniformLocation(prog, 'u_alpenglowWeight'),
      sunFaceColor: gl.getUniformLocation(prog, 'u_sunFaceColor'),
      twilightSat: gl.getUniformLocation(prog, 'u_twilightSat'),
      sunIntensity: gl.getUniformLocation(prog, 'u_sunIntensity'),
      zFactor: gl.getUniformLocation(prog, 'u_zFactor'),
      mode: gl.getUniformLocation(prog, 'u_mode'),
      hypso: gl.getUniformLocation(prog, 'u_hypso'),
      useSVF: gl.getUniformLocation(prog, 'u_useSVF'),
      svfStrength: gl.getUniformLocation(prog, 'u_svfStrength'),
      waterTintEnabled: gl.getUniformLocation(prog, 'u_waterTintEnabled'),
      waterTintColor: gl.getUniformLocation(prog, 'u_waterTintColor'),
      waterTintOpacity: gl.getUniformLocation(prog, 'u_waterTintOpacity'),
      waterTintCoverage: gl.getUniformLocation(prog, 'u_waterTintCoverage'),
      waterTintBlend: gl.getUniformLocation(prog, 'u_waterTintBlend'),
      useCastShadow: gl.getUniformLocation(prog, 'u_useCastShadow'),
      shadowReach: gl.getUniformLocation(prog, 'u_shadowReach'),
      shadowOpacity: gl.getUniformLocation(prog, 'u_shadowOpacity'),
      imhofDeflection: gl.getUniformLocation(prog, 'u_imhofDeflection'),
      imhofWarmCool: gl.getUniformLocation(prog, 'u_imhofWarmCool'),
      fastMode: gl.getUniformLocation(prog, 'u_fastMode'),
      lightWrap: gl.getUniformLocation(prog, 'u_lightWrap'),
      paperGrain: gl.getUniformLocation(prog, 'u_paperGrain'),
      mpp: gl.getUniformLocation(prog, 'u_metersPerPixel'),
      orenNayarRoughness: gl.getUniformLocation(prog, 'u_orenNayarRoughness'),
      specularDamp: gl.getUniformLocation(prog, 'u_specularDamp'),
      inkBleed: gl.getUniformLocation(prog, 'u_inkBleed'),
      waterlining: gl.getUniformLocation(prog, 'u_waterlining'),
      lightBoost: gl.getUniformLocation(prog, 'u_lightBoost'),

      featMaskTex: gl.getUniformLocation(prog, 'u_featMask'),
      hasFeatMask: gl.getUniformLocation(prog, 'u_hasFeatMask'),
      roadTintOn: gl.getUniformLocation(prog, 'u_roadTintOn'),
      roadTintColor: gl.getUniformLocation(prog, 'u_roadTintColor'),
      roadTintOpacity: gl.getUniformLocation(prog, 'u_roadTintOpacity'),
      roadTintZone: gl.getUniformLocation(prog, 'u_roadTintZone'),
      roadTintSoftness: gl.getUniformLocation(prog, 'u_roadTintSoftness'),
      roadTintBlend: gl.getUniformLocation(prog, 'u_roadTintBlend'),
      edgeTintOn: gl.getUniformLocation(prog, 'u_edgeTintOn'),
      edgeTintColor: gl.getUniformLocation(prog, 'u_edgeTintColor'),
      edgeTintOpacity: gl.getUniformLocation(prog, 'u_edgeTintOpacity'),
      edgeTintZone: gl.getUniformLocation(prog, 'u_edgeTintZone'),
      edgeTintSoftness: gl.getUniformLocation(prog, 'u_edgeTintSoftness'),
      edgeTintBlend: gl.getUniformLocation(prog, 'u_edgeTintBlend'),
      edgeTintSide: gl.getUniformLocation(prog, 'u_edgeTintSide'),

      isManualMode: gl.getUniformLocation(prog, 'u_isManualMode'),
      manualScaleMode: gl.getUniformLocation(prog, 'u_manualScaleMode'),
      manualElevMin: gl.getUniformLocation(prog, 'u_manualElevMin'),
      manualElevMax: gl.getUniformLocation(prog, 'u_manualElevMax'),
      debugValley: gl.getUniformLocation(prog, 'u_debugValley'),

      manualColorPeak: gl.getUniformLocation(prog, 'u_manualColorPeak'),
      manualColorMid: gl.getUniformLocation(prog, 'u_manualColorMid'),
      manualColorValley: gl.getUniformLocation(prog, 'u_manualColorValley'),
      manualLightBlend: gl.getUniformLocation(prog, 'u_manualLightBlend'),
      manualLightSoftness: gl.getUniformLocation(prog, 'u_manualLightSoftness'),
      manualLightBlend2: gl.getUniformLocation(prog, 'u_manualLightBlend2'),
      manualLightSoftness2: gl.getUniformLocation(prog, 'u_manualLightSoftness2'),
      elevMin: gl.getUniformLocation(prog, 'u_elevMin'),
      elevSpan: gl.getUniformLocation(prog, 'u_elevSpan'),

      waterMaskTex: gl.getUniformLocation(prog, 'u_waterMask'),
      hasWaterMask: gl.getUniformLocation(prog, 'u_hasWaterMask'),


      seaWorld: gl.getUniformLocation(prog, 'u_seaWorld'),
      seaWaveScale: gl.getUniformLocation(prog, 'u_seaWaveScale'),
      seaWaveSpacing: gl.getUniformLocation(prog, 'u_seaWaveSpacing'),
      seaWaveUndulation: gl.getUniformLocation(prog, 'u_seaWaveUndulation'),
      seaWaveThickness: gl.getUniformLocation(prog, 'u_seaWaveThickness'),
      seaWaveRoughness: gl.getUniformLocation(prog, 'u_seaWaveRoughness'),
      seaWaveOpacity: gl.getUniformLocation(prog, 'u_seaWaveOpacity'),
      seaWaveColor: gl.getUniformLocation(prog, 'u_seaWaveColor'),
      seaWaveShoreFade: gl.getUniformLocation(prog, 'u_seaWaveShoreFade'),
      seaWaveBlend: gl.getUniformLocation(prog, 'u_seaWaveBlend'),
      seaWaveFillEnabled: gl.getUniformLocation(prog, 'u_seaWaveFillEnabled'),
      seaWaveFillColor: gl.getUniformLocation(prog, 'u_seaWaveFillColor'),
      seaWaveFillOpacity: gl.getUniformLocation(prog, 'u_seaWaveFillOpacity'),

      waterlineColor: gl.getUniformLocation(prog, 'u_waterlineColor'),
      waterlineWidth: gl.getUniformLocation(prog, 'u_waterlineWidth'),
      waterlineOpacity: gl.getUniformLocation(prog, 'u_waterlineOpacity'),

      bounceStrength: gl.getUniformLocation(prog, 'u_bounceStrength'),
      penumbraScale: gl.getUniformLocation(prog, 'u_penumbraScale'),

      // Обводка (только если USE_OUTLINE)
      outlineBlend: gl.getUniformLocation(prog, 'u_outlineBlend'),
      outlineWidth: gl.getUniformLocation(prog, 'u_outlineWidth'),
      outlineRoughness: gl.getUniformLocation(prog, 'u_outlineRoughness'),
      outlineTexture: gl.getUniformLocation(prog, 'u_outlineTexture'),   // <-- НОВОЕ
      outlineDensity: gl.getUniformLocation(prog, 'u_outlineDensity'),   // <-- НОВОЕ
      outlineThreshold: gl.getUniformLocation(prog, 'u_outlineThreshold'),
      outlineOpacity: gl.getUniformLocation(prog, 'u_outlineOpacity'),
      outlineLightMod: gl.getUniformLocation(prog, 'u_outlineLightMod'),

      outlineColor: gl.getUniformLocation(prog, 'u_outlineColor'),
      outlineWorld: gl.getUniformLocation(prog, 'u_outlineWorld'),

      colorTone: gl.getUniformLocation(prog, 'u_colorTone'),

      dayReach: gl.getUniformLocation(prog, 'u_dayReach'),
      twilightRimColor: gl.getUniformLocation(prog, 'u_twilightRimColor'),
      twilightRimWidth: gl.getUniformLocation(prog, 'u_twilightRimWidth'),

      dayGlowColor: gl.getUniformLocation(prog, 'u_dayGlowColor'),
      dayGlowStrength: gl.getUniformLocation(prog, 'u_dayGlowStrength'),
      hazeStrength: gl.getUniformLocation(prog, 'u_hazeStrength'),
      vpOrigin: gl.getUniformLocation(prog, 'u_vpOrigin'),



      twilightClimb: gl.getUniformLocation(prog, 'u_twilightClimb'),
      twilightAmt: gl.getUniformLocation(prog, 'u_twilightAmt'),
      afterglow: gl.getUniformLocation(prog, 'u_afterglow'),
      glowColor: gl.getUniformLocation(prog, 'u_glowColor'),
      valleyColor: gl.getUniformLocation(prog, 'u_valleyColor'),

      // Штриховка (только если USE_HACHURE)
      hachureBlend: gl.getUniformLocation(prog, 'u_hachureBlend'),
      hachureThinning: gl.getUniformLocation(prog, 'u_hachureThinning'),
      hachureDensity: gl.getUniformLocation(prog, 'u_hachureDensity'),
      hachureOpacity: gl.getUniformLocation(prog, 'u_hachureOpacity'),
      hachureSlope: gl.getUniformLocation(prog, 'u_hachureSlope'),
      hachureColor: gl.getUniformLocation(prog, 'u_hachureColor'),
      hachureLightMod: gl.getUniformLocation(prog, 'u_hachureLightMod'),

      // Дизеринг (только если USE_DITHER)
      ditherBlend: gl.getUniformLocation(prog, 'u_ditherBlend'),
      ditherScale: gl.getUniformLocation(prog, 'u_ditherScale'),
      ditherAngle: gl.getUniformLocation(prog, 'u_ditherAngle'),
      ditherDensity: gl.getUniformLocation(prog, 'u_ditherDensity'),
      ditherThreshold: gl.getUniformLocation(prog, 'u_ditherThreshold'),
      ditherLowCut: gl.getUniformLocation(prog, 'u_ditherLowCut'),
      ditherSoftness: gl.getUniformLocation(prog, 'u_ditherSoftness'),
      ditherColor: gl.getUniformLocation(prog, 'u_ditherColor'),
      ditherZone: gl.getUniformLocation(prog, 'u_ditherZone'),
      ditherStrength: gl.getUniformLocation(prog, 'u_ditherStrength')
    };

    const entry = { prog, locs };
    lightProgramCache.set(key, entry);
    return entry;
  }

  function initSharedGl() {
    if (sharedGl) return;
     const isOffscreen = typeof OffscreenCanvas !== 'undefined';
    const canvas = isOffscreen ? new OffscreenCanvas(256, 256) : document.createElement('canvas');
    if (!isOffscreen) {
      canvas.width = 256;
      canvas.height = 256;
    }

    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });
    gl._isOffscreen = isOffscreen;

    if (!gl) {
      console.error('WebGL 2.0 is not supported in this browser.');
      return;
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      sharedGl = null;
      sharedGeomProg = null;
      sharedVao = null;
      sharedFbo = null;
      geomLocations = null;
      glTexturePool.length = 0;
      lightProgramCache.clear();
      bakeProgramCache.clear();
    }, false);

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader Error:', gl.getShaderInfoLog(s));
      }
      return s;
    }

    // 1. Программа запекания геометрии
    const gProg = gl.createProgram();
    gl.attachShader(gProg, compile(gl.VERTEX_SHADER, VS_SOURCE));
    gl.attachShader(gProg, compile(gl.FRAGMENT_SHADER, FS_GEOM_SOURCE));
    gl.bindAttribLocation(gProg, 0, 'a_pos');
    gl.bindAttribLocation(gProg, 1, 'a_uv');
    gl.linkProgram(gProg);

    sharedFbo = gl.createFramebuffer();

    // Настройка VAO для полноэкранного квада
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
      -1,  1, 0, 0,
       1, -1, 1, 1,
       1,  1, 1, 0
    ]), gl.STATIC_DRAW);

    // Привязываем атрибуты к G-программе (слоты 0 и 1 одинаковы во всех программах)
    const aPos = gl.getAttribLocation(gProg, 'a_pos');
    const aUv = gl.getAttribLocation(gProg, 'a_uv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    sharedGl = gl;
    sharedGeomProg = gProg;
    sharedVao = vao;

    geomLocations = {
      dem: gl.getUniformLocation(gProg, 'u_dem'),
      iRes: gl.getUniformLocation(gProg, 'u_iRes'),
      pad: gl.getUniformLocation(gProg, 'u_pad'),
      uvOrigin: gl.getUniformLocation(gProg, 'u_uvOrigin'),
      uvScale: gl.getUniformLocation(gProg, 'u_uvScale'),
      zFactor: gl.getUniformLocation(gProg, 'u_zFactor'),
      smooth: gl.getUniformLocation(gProg, 'u_smooth'),
      mpp: gl.getUniformLocation(gProg, 'u_metersPerPixel'),
      useAO: gl.getUniformLocation(gProg, 'u_useAO'),
      aoStrength: gl.getUniformLocation(gProg, 'u_aoStrength'),
      aoRadius: gl.getUniformLocation(gProg, 'u_aoRadius'),
      aoSlopeBleed: gl.getUniformLocation(gProg, 'u_aoSlopeBleed'),
      useSVF: gl.getUniformLocation(gProg, 'u_useSVF'),
      svfStrength: gl.getUniformLocation(gProg, 'u_svfStrength'),
      elevMin: gl.getUniformLocation(gProg, 'u_elevMin'),
      elevSpan: gl.getUniformLocation(gProg, 'u_elevSpan'),
      useOpenness: gl.getUniformLocation(gProg, 'u_useOpenness'),
      opennessRadius: gl.getUniformLocation(gProg, 'u_opennessRadius'),
      opennessStrength: gl.getUniformLocation(gProg, 'u_opennessStrength'),
      opennessDiff: gl.getUniformLocation(gProg, 'u_opennessDiff'),
    };
  }


  // =========================================================================
  // РЕНДЕР ОТМЫВКИ В ХОЛСТ ТАЙЛА
  // =========================================================================
  // =========================================================================
  // BAKE-ПРОХОД: статичные слои, не зависящие от времени суток
  //   R,G — маска штриховки (16 бит), B — ватерлиния/0.45, A — бумажное зерно + 0.5
  // Выполняется один раз на тайл (и при смене параметров штриховки / z-factor / геометрии).
  // =========================================================================
  const bakeProgramCache = new Map();

  function glCompileShader(gl, type, source, label) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(label + ' Shader Error:', gl.getShaderInfoLog(s));
    }
    return s;
  }

  function buildBakeFragmentShader(hachureType) {
    const defines = [];
    if (hachureType) {
      defines.push('#define USE_HACHURE');
      defines.push(`#define HACHURE_${String(hachureType || 'classic').toUpperCase()}`);
    }

    return `#version 300 es
    precision highp float;
    precision highp int;

    ${defines.join('\n')}

    uniform sampler2D u_dem;
    uniform sampler2D u_gbuf;
    uniform ivec2 u_iRes;
    uniform float u_pad;
    uniform float u_zFactor;
    uniform float u_inkBleed;

    #ifdef USE_HACHURE
    uniform float u_hachureThinning;
    uniform float u_hachureDensity;
    uniform float u_hachureSlope;
    uniform float u_hachureLength;          // <-- НОВОЕ
    uniform float u_hachureHybridThresh;    // <-- НОВОЕ
    uniform float u_hachureHybridSharpness; // <-- НОВОЕ
    #endif

    in vec2 v_uv;
    in vec2 v_tileLocalPx;

    out vec4 fragColor;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }


    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      float h = (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
      return (h < -1000.0) ? h : max(h, 0.0);
    }

    float getRawHPx(ivec2 p, float fallbackH) {
      vec4 c = texelFetch(u_dem, clamp(p, ivec2(0), u_iRes - ivec2(1)), 0);
      float h = decodeH(c);
      return (h < -1000.0) ? fallbackH : h;
    }

    float computeWaterlineDistCoarse(ivec2 p, float h0) {
      bool isLand = (h0 > 0.25);

      ivec2 dirs4[4];
      dirs4[0] = ivec2(1, 0); dirs4[1] = ivec2(-1, 0);
      dirs4[2] = ivec2(0, 1); dirs4[3] = ivec2(0, -1);
      for (int i = 0; i < 4; i++) {
        if ((getRawHPx(p + dirs4[i], h0) > 0.25) != isLand) {
          return 0.35;
        }
      }

      ivec2 dirs8[8];
      dirs8[0] = ivec2( 1,  0); dirs8[1] = ivec2(-1,  0);
      dirs8[2] = ivec2( 0,  1); dirs8[3] = ivec2( 0, -1);
      dirs8[4] = ivec2( 1,  1); dirs8[5] = ivec2(-1,  1);
      dirs8[6] = ivec2( 1, -1); dirs8[7] = ivec2(-1, -1);

      float minDist = 20.0;
      for (int r = 1; r <= 16; r++) {
        float rf = float(r);
        if (rf >= minDist) break;
        for (int i = 0; i < 8; i++) {
          float sampleH = getRawHPx(p + dirs8[i] * r, h0);
          if ((sampleH > 0.25) != isLand) {
            float d = rf * ((i >= 4) ? 1.4142 : 1.0);
            if (d < minDist) minDist = d;
          }
        }
      }
      return minDist;
    }

    float wetAt(ivec2 p, float h0) {
      return 1.0 - smoothstep(0.1, 0.8, getRawHPx(p, h0));
    }
    // тент-фильтр 3x3: гасит одиночные «мигающие» пиксели
    float wetBlur(ivec2 p, float h0) {
      float s = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          float w = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0);
          s += w * wetAt(p + ivec2(i, j), h0);
        }
      }
      return s * (1.0 / 16.0);
    }
    float computeWaterlineDist(ivec2 p, float h0) {
      float dCoarse = computeWaterlineDistCoarse(p, h0);
      if (dCoarse >= 4.0) return dCoarse;

      float m  = wetBlur(p, h0);
      float mx = wetBlur(p + ivec2(1, 0), h0) - wetBlur(p - ivec2(1, 0), h0);
      float my = wetBlur(p + ivec2(0, 1), h0) - wetBlur(p - ivec2(0, 1), h0);
      float g  = max(1e-3, 0.5 * length(vec2(mx, my)));
      float dFine = clamp(abs(m - 0.5) / g, 0.0, 12.0);

      // вблизи берега доверяем субпиксельной оценке, дальше — грубой
      return mix(dFine, max(dCoarse, 1.5), smoothstep(1.0, 1.75, dFine));
    }

    #ifdef USE_HACHURE
    // ---- Штриховка: короткие штрихи вдоль линии стока, привязанные к ячейкам сетки ----
    vec4 hachGBuf(vec2 localPx) {
      float S = float(u_iRes.x) - 2.0 * u_pad;
      int Si = int(S + 0.5);
      vec2 q = clamp(localPx, vec2(0.0), vec2(255.99)) * (S / 256.0);
      ivec2 t = ivec2(int(q.x), Si - 1 - int(q.y));
      return texelFetch(u_gbuf, clamp(t, ivec2(0), ivec2(Si - 1)), 0);
    }

    // Истинный вектор уклона (dz/dx, dz/dy) в координатах изображения, БЕЗ z-factor
    vec2 hachGrad1(vec2 lp) {
      vec4 g = hachGBuf(lp);
      if (g.a < 0.25) return vec2(0.0);
      vec2 nxy = g.xy * 2.0 - 1.0;
      float nz = sqrt(max(0.0001, 1.0 - dot(nxy, nxy)));
      return -nxy / max(0.05, nz) / max(0.1, u_zFactor);
    }
    // Усреднение по 5 точкам: гасит квантование 8 бит и шум на плоской местности
    vec2 hachGrad5(vec2 c, float r) {
      return (hachGrad1(c) * 2.0 + hachGrad1(c + vec2(r, 0.0)) + hachGrad1(c - vec2(r, 0.0))
            + hachGrad1(c + vec2(0.0, r)) + hachGrad1(c - vec2(0.0, r))) / 6.0;
    }

    void hachSeg(vec2 p, vec2 a, vec2 b, out float d, out float t) {
      vec2 ab = b - a;
      t = clamp(dot(p - a, ab) / max(1e-5, dot(ab, ab)), 0.0, 1.0);
      d = length(p - a - ab * t);
    }

    float hachureMask(vec2 p) {
      float density = max(0.3, u_hachureDensity);
      float nCells = max(16.0, floor(256.0 / (7.0 / density)));
      float cell = 256.0 / nCells;
      vec2 cid = floor(p / cell);
      float res = 0.0;

      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 id = cid + vec2(float(i), float(j));
          vec2 idw = mod(id, nCells);
          vec2 rnd = vec2(hash(idw * 1.37 + vec2(3.1, 7.7)), hash(idw * 2.11 + vec2(9.3, 1.9)));
          vec2 c = (id + 0.5 + (rnd - 0.5) * 0.6) * cell;

          vec2 g = hachGrad5(c, cell * 0.5);
          float sl = length(g);
          if (sl < u_hachureSlope) continue;

          // ПРОРЕЖИВАНИЕ ШТРИХОВ (Decimation) без изменения масштаба
          if (u_hachureThinning > 0.001) {
            float dropRand = hash(idw * 4.19 + vec2(17.3, 31.7));
            if (dropRand < u_hachureThinning) continue;
          }

          vec2 dir = -g / sl;                      // «под гору» (градиент)
          vec2 tanDir = vec2(-dir.y, dir.x);       // перпендикулярно (вдоль горизонталей)
          float fadeIn = smoothstep(u_hachureSlope, u_hachureSlope * 2.0, sl);
          float d; float s;
          float w0;
          float steepFactor = 0.0; // Фактор крутизны для гибридного режима

          #if defined(HACHURE_CONTOUR) || defined(HACHURE_CLASSIC)
            float h = cell * 0.85 * max(0.2, u_hachureLength);
            float tt;
            hachSeg(p, c - tanDir * h, c + tanDir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * 0.13 * mix(0.7, 1.3, smoothstep(u_hachureSlope, u_hachureSlope * 5.0, sl));

          #elif defined(HACHURE_HYBRID)
            // Умный настраиваемый переход ориентации штрихов
            float hybT = max(0.02, u_hachureHybridThresh);
            float hybSpan = hybT * mix(1.8, 0.25, clamp(u_hachureHybridSharpness, 0.05, 1.0));
            steepFactor = smoothstep(max(0.01, hybT - hybSpan * 0.5), hybT + hybSpan * 0.5, sl);

            vec2 strokeDir = normalize(mix(tanDir, dir, steepFactor));
            float h = cell * mix(0.85, 0.95, steepFactor) * max(0.2, u_hachureLength);
            float tt;
            hachSeg(p, c - strokeDir * h, c + strokeDir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * mix(
              0.13 * mix(0.7, 1.3, smoothstep(u_hachureSlope, u_hachureSlope * 3.5, sl)),
              0.12 * mix(0.8, 2.2, smoothstep(u_hachureSlope * 2.0, u_hachureSlope * 8.0, sl)),
              steepFactor
            );

          #elif defined(HACHURE_FLOW)
            float h = cell * 0.95 * max(0.2, u_hachureLength);
            vec2 gf = hachGrad1(c + dir * h);
            vec2 gb = hachGrad1(c - dir * h);
            vec2 df = (length(gf) > 1e-5) ? -normalize(gf) : dir;
            vec2 db = (length(gb) > 1e-5) ? -normalize(gb) : dir;
            vec2 pf = c + normalize(dir + df) * h;
            vec2 pb = c - normalize(dir + db) * h;
            float d1, t1, d2, t2;
            hachSeg(p, pb, c, d1, t1);
            hachSeg(p, c, pf, d2, t2);
            if (d1 < d2) { d = d1; s = t1 - 1.0; } else { d = d2; s = t2; }
            w0 = cell * 0.15 * mix(0.7, 1.5, smoothstep(u_hachureSlope, u_hachureSlope * 5.0, sl));
          #elif defined(HACHURE_LEHMANN)
            float h = cell * 0.9 * max(0.2, u_hachureLength);
            float tt;
            hachSeg(p, c - dir * h, c + dir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * 0.10 * mix(0.5, 2.4, smoothstep(u_hachureSlope, u_hachureSlope * 8.0, sl));
          #elif defined(HACHURE_ROCK)
            if (sl < u_hachureSlope * 1.5) continue;
            float ang = (rnd.x - 0.5) * 1.1;
            float ca = cos(ang), sa = sin(ang);
            vec2 rdir = vec2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
            float h = cell * 0.6 * max(0.2, u_hachureLength);
            float tt;
            hachSeg(p, c - rdir * h, c + rdir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * 0.19 * mix(0.7, 1.5, smoothstep(u_hachureSlope, u_hachureSlope * 5.0, sl));
          #endif


          #if defined(HACHURE_CONTOUR) || defined(HACHURE_CLASSIC)
            // Изящное заострение штриха с обоих концов (как пером)
            float w = w0 * (1.0 - 0.45 * (s * s));
          #elif defined(HACHURE_HYBRID)
            // На холмах штрих заострён с двух концов, на обрывах — утолщается у гребня
            float wContour = w0 * (1.0 - 0.45 * (s * s));
            float wFall = w0 * (1.0 - 0.55 * clamp(s * 0.5 + 0.5, 0.0, 1.0));
            float w = mix(wContour, wFall, steepFactor);
          #else
            // Утоньшение штриха к подошве склона (s > 0 — вниз по склону)
            float w = w0 * (1.0 - 0.55 * clamp(s * 0.5 + 0.5, 0.0, 1.0));
          #endif

          float m = 1.0 - smoothstep(w - 0.35, w + 0.35, d);
          res = max(res, m * fadeIn);
        }
      }
      return res;
    }

    #endif

    void main() {
      ivec2 tilePx = ivec2(gl_FragCoord.xy);
      vec4 g = texelFetch(u_gbuf, tilePx, 0);

      if (g.r == 0.0 && g.g == 0.0 && g.b == 0.0 && g.a == 0.0) {
        fragColor = vec4(0.0);
        return;
      }

      ivec2 basePx = ivec2(floor(v_uv * vec2(u_iRes)));
      float centerH = getRawHPx(basePx, -99999.0);
      if (centerH < -1000.0) {
        fragColor = vec4(0.0);
        return;
      }

      vec2 nxy = g.xy * 2.0 - 1.0;
      float nz = sqrt(max(0.0001, 1.0 - dot(nxy, nxy)));
      float safeNz = max(0.001, nz);
      float dzdx = -nxy.x / safeNz;
      float dzdy = -nxy.y / safeNz;
      float slope = length(vec2(dzdx, dzdy));

      float hachMask = 0.0;
      #ifdef USE_HACHURE
      {
        vec2 hp = v_tileLocalPx;
        if (u_inkBleed > 0.5) {
          hp += (hash(hp * 4.0) - 0.5) * 0.35;
        }
        hachMask = hachureMask(hp);
      }
      #endif

      vec2 grainPos = v_tileLocalPx;
      if (u_inkBleed > 0.5) {
        grainPos += vec2(
          hash(grainPos * 3.7 + vec2(1.2, 4.5)) - 0.5,
          hash(grainPos * 3.7 + vec2(8.1, 2.3)) - 0.5
        ) * 1.2;
      }
      float grain = (hash(grainPos * 2.5) - 0.5) * 0.7 + (noise(grainPos * 0.35) - 0.5) * 0.3;

      float wlDist = computeWaterlineDist(basePx, centerH);
      float wl = 1.0 - clamp(wlDist / 20.0, 0.0, 1.0); 
      float mv = floor(clamp(hachMask, 0.0, 1.0) * 65535.0 + 0.5);
      float hi = floor(mv / 256.0);
      float lo = mv - hi * 256.0;

      fragColor = vec4(hi / 255.0, lo / 255.0, clamp(wl, 0.0, 1.0), clamp(grain + 0.5, 0.0, 1.0));
    }
  `;
  }

  function getOrCreateBakeProgram(gl, hachureType) {
    const key = hachureType ? String(hachureType) : '0';
    let entry = bakeProgramCache.get(key);
    if (entry) return entry;

    const prog = gl.createProgram();
    gl.attachShader(prog, glCompileShader(gl, gl.VERTEX_SHADER, VS_SOURCE, 'Bake VS'));
    gl.attachShader(prog, glCompileShader(gl, gl.FRAGMENT_SHADER, buildBakeFragmentShader(hachureType), 'Bake FS'));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.bindAttribLocation(prog, 1, 'a_uv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Bake Program Link Error:', gl.getProgramInfoLog(prog));
    }

    const u = (n) => gl.getUniformLocation(prog, n);
    entry = {
      prog,
      locs: {
        dem: u('u_dem'),
        gbuf: u('u_gbuf'),
        iRes: u('u_iRes'),
        pad: u('u_pad'),
        uvOrigin: u('u_uvOrigin'),
        uvScale: u('u_uvScale'),
        zFactor: u('u_zFactor'),
        inkBleed: u('u_inkBleed'),
        hachureThinning: u('u_hachureThinning'),
        hachureDensity: u('u_hachureDensity'),
        hachureSlope: u('u_hachureSlope'),
        hachureLength: u('u_hachureLength'),                   // <-- НОВОЕ
        hachureHybridThresh: u('u_hachureHybridThresh'),       // <-- НОВОЕ
        hachureHybridSharpness: u('u_hachureHybridSharpness')  // <-- НОВОЕ
      }
    };
    bakeProgramCache.set(key, entry);
    return entry;
  }

  // =========================================================================
  // ПУЛ ТЕКСТУР WEBGL (устраняет микрофризы аллокаций при навигации)
  // =========================================================================
  const glTexturePool = [];

  function acquireTexture(gl, size) {
    for (let i = 0; i < glTexturePool.length; i++) {
      if (glTexturePool[i].size === size) {
        return glTexturePool.splice(i, 1)[0].tex;
      }
    }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    return t;
  }

  function releaseTexture(gl, tex, size) {
    if (!tex || !gl) return;
    if (glTexturePool.length < 24) {
      glTexturePool.push({ tex, size });
    } else {
      gl.deleteTexture(tex);
    }
  }

  function createRgba8Tex(gl, size) {
    return acquireTexture(gl, size);
  }

  // Все uniform-ы, не зависящие от конкретного тайла. Значения живут в программе между вызовами,
  // поэтому заливаются только при смене освещения / настроек / z-factor.
  function uploadLightFrameUniforms(gl, L, lighting, effZ, vStats) {
    const u3 = (loc, v) => { if (loc) gl.uniform3f(loc, v[0], v[1], v[2]); };
    const u1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };

    if (L.dem) gl.uniform1i(L.dem, 0);
    if (L.gbuf) gl.uniform1i(L.gbuf, 1);
    if (L.sbuf) gl.uniform1i(L.sbuf, 2);
    if (L.waterMaskTex) gl.uniform1i(L.waterMaskTex, 3); // <-- ДОБАВИТЬ ЭТУ СТРОКУ

    u3(L.sunFaceColor, lighting.sunFaceColor || [1.0, 0.9, 0.8]);
    u1(L.twilightSat, lighting.twilightSat !== undefined ? lighting.twilightSat : 0.85);
    u3(L.dayGlowColor, lighting.dayGlowColor || [1.0, 0.96, 0.88]);
    u1(L.dayGlowStrength, lighting.dayGlowStrength !== undefined ? lighting.dayGlowStrength : 0.0);
    u1(L.hazeStrength, lighting.hazeStrength !== undefined ? lighting.hazeStrength : 0.0);
    u1(L.dayReach, lighting.dayReach !== undefined ? lighting.dayReach : 0.50);
    u3(L.twilightRimColor, lighting.twilightRimColor || [1.0, 0.45, 0.25]);
    u1(L.twilightRimWidth, lighting.twilightRimWidth || 0.5);
    u1(L.bounceStrength, cfg.bounceStrength !== undefined ? cfg.bounceStrength : 0.55);
    u1(L.penumbraScale, cfg.penumbraScale !== undefined ? cfg.penumbraScale : 0.65);

    if (L.featMaskTex) gl.uniform1i(L.featMaskTex, 4);

    if (cfg.roadTintEnabled || cfg.edgeTintEnabled) {
      const featBlendMap = { tint: 0, multiply: 1, overlay: 2, softlight: 3, screen: 4, normal: 5 };
      const edgeSideMap = { both: 0, outside: 1, inside: 2 };

      if (L.roadTintOn) gl.uniform1i(L.roadTintOn, cfg.roadTintEnabled ? 1 : 0);
      if (L.roadTintColor) u3(L.roadTintColor, hexToVec3(cfg.roadTintColor || '#e0a952'));
      u1(L.roadTintOpacity, cfg.roadTintOpacity !== undefined ? cfg.roadTintOpacity : 0.75);
      u1(L.roadTintZone, cfg.roadTintZone !== undefined ? cfg.roadTintZone : 14.0);
      u1(L.roadTintSoftness, cfg.roadTintSoftness !== undefined ? cfg.roadTintSoftness : 0.75);
      if (L.roadTintBlend) gl.uniform1i(L.roadTintBlend, featBlendMap[cfg.roadTintBlendMode] ?? 0);

      if (L.edgeTintOn) gl.uniform1i(L.edgeTintOn, cfg.edgeTintEnabled ? 1 : 0);
      if (L.edgeTintColor) u3(L.edgeTintColor, hexToVec3(cfg.edgeTintColor || '#7ca34b'));
      u1(L.edgeTintOpacity, cfg.edgeTintOpacity !== undefined ? cfg.edgeTintOpacity : 0.65);
      u1(L.edgeTintZone, cfg.edgeTintZone !== undefined ? cfg.edgeTintZone : 18.0);
      u1(L.edgeTintSoftness, cfg.edgeTintSoftness !== undefined ? cfg.edgeTintSoftness : 0.80);
      if (L.edgeTintBlend) gl.uniform1i(L.edgeTintBlend, featBlendMap[cfg.edgeTintBlendMode] ?? 0);
      if (L.edgeTintSide) gl.uniform1i(L.edgeTintSide, edgeSideMap[cfg.edgeTintSide] ?? 0);
    }



    const toneMap = {
      none: 0, off: 0,
      imhof: 1,
      slate: 2,
      vintage: 3,
      amber: 4,
      emerald: 5,
      monochrome: 6,
      sandstone: 7,
      glacier: 8,
      volcano: 9,
      day: 1, sunrise: 4, sunset: 4, moon: 2 // обратная совместимость
    };
    const toneId = toneMap[cfg.colorTone] !== undefined ? toneMap[cfg.colorTone] : 0;
    if (L.colorTone) gl.uniform1i(L.colorTone, toneId);

    u3(L.sunDir, lighting.sunVec);
    u3(L.lightColor, lighting.lightColor);
    u3(L.shadowColor, lighting.shadowColor);
    u3(L.skyColor, lighting.skyColor);
    u1(L.alpenglowWeight, lighting.alpenglowWeight !== undefined ? lighting.alpenglowWeight : 0.0);
    u1(L.sunIntensity, lighting.sunIntensity !== undefined ? lighting.sunIntensity : 1.0);
    u1(L.zFactor, effZ);
    if (L.mode) gl.uniform1i(L.mode, lighting.isSwiss ? 1 : 0);
    if (L.hypso) gl.uniform1i(L.hypso, { none: 0, atlas: 1 }[cfg.hypsoMode] || 0);

    u1(L.useSVF, cfg.svfEnabled !== false ? 1.0 : 0.0);
    u1(L.svfStrength, cfg.svfStrength !== undefined ? cfg.svfStrength : 0.85);

    u1(L.useCastShadow, cfg.castShadows ? 1.0 : 0.0);
    u1(L.shadowReach, cfg.shadowReach || 1.0);
    const effShadowMul = lighting.shadowMul !== undefined ? lighting.shadowMul : 1.0;
    const finalShadowOp = effShadowMul > 0.02 ? (cfg.shadowOpacity !== undefined ? cfg.shadowOpacity : 0.60) * effShadowMul : 0.0;
    u1(L.shadowOpacity, finalShadowOp);

    if (cfg.seaWavesEnabled) {
      const seaBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3 };
      if (L.seaWaveBlend) gl.uniform1i(L.seaWaveBlend, seaBlendMap[cfg.seaWaveBlendMode] !== undefined ? seaBlendMap[cfg.seaWaveBlendMode] : 1);
      if (L.seaWaveScale) gl.uniform1f(L.seaWaveScale, cfg.seaWaveScale || 80.0);
      if (L.seaWaveSpacing) gl.uniform1f(L.seaWaveSpacing, cfg.seaWaveSpacing || 5.5);
      if (L.seaWaveUndulation) gl.uniform1f(L.seaWaveUndulation, cfg.seaWaveUndulation !== undefined ? cfg.seaWaveUndulation : 8.8);
      if (L.seaWaveThickness) gl.uniform1f(L.seaWaveThickness, cfg.seaWaveThickness || 2.5);
      if (L.seaWaveRoughness) gl.uniform1f(L.seaWaveRoughness, cfg.seaWaveRoughness !== undefined ? cfg.seaWaveRoughness : 1.0);
      if (L.seaWaveOpacity) gl.uniform1f(L.seaWaveOpacity, cfg.seaWaveOpacity !== undefined ? cfg.seaWaveOpacity : 0.40);
      if (L.seaWaveColor) gl.uniform3fv(L.seaWaveColor, hexToVec3(cfg.seaWaveColor || '#272e3a'));
      if (L.seaWaveShoreFade) gl.uniform1f(L.seaWaveShoreFade, cfg.seaWaveShoreFade !== undefined ? cfg.seaWaveShoreFade : 1.0);
      if (L.seaWaveFillEnabled) gl.uniform1i(L.seaWaveFillEnabled, cfg.seaWaveFillEnabled ? 1 : 0);
      if (L.seaWaveFillColor) gl.uniform3fv(L.seaWaveFillColor, hexToVec3(cfg.seaWaveFillColor || '#252428'));
      if (L.seaWaveFillOpacity) gl.uniform1f(L.seaWaveFillOpacity, cfg.seaWaveFillOpacity !== undefined ? cfg.seaWaveFillOpacity : 0.68);

    }
    if (cfg.hachureEnabled) {
      const hachBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3, screen: 4, burn: 5, difference: 6 };
      if (L.hachureBlend) gl.uniform1i(L.hachureBlend, hachBlendMap[cfg.hachureBlendMode] !== undefined ? hachBlendMap[cfg.hachureBlendMode] : 1);
      u1(L.hachureOpacity, cfg.hachureOpacity !== undefined ? cfg.hachureOpacity : 0.75);
      u1(L.hachureLightMod, cfg.hachureLightMod !== undefined ? cfg.hachureLightMod : 0.60);
      if (L.hachureColor) u3(L.hachureColor, hexToVec3(cfg.hachureColor || '#1c1917'));
    }

    if (cfg.outlineEnabled) {
      const outlineBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3, screen: 4, burn: 5, difference: 6 };
      if (L.outlineBlend) gl.uniform1i(L.outlineBlend, outlineBlendMap[cfg.outlineBlendMode] !== undefined ? outlineBlendMap[cfg.outlineBlendMode] : 1);
      u1(L.outlineWidth, cfg.outlineWidth !== undefined ? cfg.outlineWidth : 1.2);
      u1(L.outlineRoughness, cfg.outlineRoughness !== undefined ? cfg.outlineRoughness : 0.40);
      u1(L.outlineTexture, cfg.outlineTexture !== undefined ? cfg.outlineTexture : 0.60); // <-- НОВОЕ
      u1(L.outlineDensity, cfg.outlineDensity !== undefined ? cfg.outlineDensity : 0.65); // <-- НОВОЕ
      u1(L.outlineThreshold, cfg.outlineThreshold !== undefined ? cfg.outlineThreshold : 0.35);
      u1(L.outlineOpacity, cfg.outlineOpacity !== undefined ? cfg.outlineOpacity : 0.85);
      u1(L.outlineLightMod, cfg.outlineLightMod !== undefined ? cfg.outlineLightMod : 0.50);
      if (L.outlineColor) u3(L.outlineColor, hexToVec3(cfg.outlineColor || '#1c1917'));
    }

    u1(L.imhofDeflection, cfg.imhofDeflection !== undefined ? cfg.imhofDeflection : 0.35);
    u1(L.imhofWarmCool, lighting.warmCool !== undefined ? lighting.warmCool : 0.85);
    u1(L.lightWrap, cfg.lightWrap !== undefined ? cfg.lightWrap : 0.35);
    u1(L.paperGrain, cfg.paperGrain !== undefined ? cfg.paperGrain : 0.4);
    u1(L.orenNayarRoughness, cfg.orenNayarRoughness !== undefined ? cfg.orenNayarRoughness : 0.5);
    u1(L.specularDamp, cfg.specularDamp !== undefined ? cfg.specularDamp : 0.65);
    u1(L.inkBleed, cfg.inkBleed !== false ? 1.0 : 0.0);
    u1(L.waterlining, cfg.waterlining !== false ? 1.0 : 0.0);
    if (L.waterlineColor) u3(L.waterlineColor, hexToVec3(cfg.waterlineColor || '#1c3d5a'));
    u1(L.waterlineWidth, cfg.waterlineWidth !== undefined ? cfg.waterlineWidth : 1.5);
    u1(L.waterlineOpacity, cfg.waterlineOpacity !== undefined ? cfg.waterlineOpacity : 0.8);
    if (L.waterTintEnabled) gl.uniform1i(L.waterTintEnabled, cfg.waterTintEnabled ? 1 : 0);
    if (L.waterTintColor) gl.uniform3fv(L.waterTintColor, hexToVec3(cfg.waterTintColor || '#2a4d69'));
    if (L.waterTintOpacity) gl.uniform1f(L.waterTintOpacity, cfg.waterTintOpacity !== undefined ? cfg.waterTintOpacity : 0.50);
    if (L.waterTintCoverage) gl.uniform1f(L.waterTintCoverage, cfg.waterTintCoverage !== undefined ? cfg.waterTintCoverage : 1.0);

    const waterBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3 };
    if (L.waterTintBlend) gl.uniform1i(L.waterTintBlend, waterBlendMap[cfg.waterTintBlendMode] !== undefined ? waterBlendMap[cfg.waterTintBlendMode] : 1);

    if (cfg.ditherEnabled) {
      const ditherBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3, screen: 4, burn: 5, difference: 6 };
      if (L.ditherBlend) gl.uniform1i(L.ditherBlend, ditherBlendMap[cfg.ditherBlendMode] !== undefined ? ditherBlendMap[cfg.ditherBlendMode] : 1);
      u1(L.ditherScale, cfg.ditherScale || 1.0);
      u1(L.ditherAngle, cfg.ditherAngle !== undefined ? cfg.ditherAngle : 45.0);
      u1(L.ditherDensity, cfg.ditherDensity !== undefined ? cfg.ditherDensity : 1.0);
      u1(L.ditherThreshold, cfg.ditherThreshold !== undefined ? cfg.ditherThreshold : 0.60);
      u1(L.ditherLowCut, cfg.ditherLowCut !== undefined ? cfg.ditherLowCut : 0.00);
      u1(L.ditherSoftness, cfg.ditherSoftness !== undefined ? cfg.ditherSoftness : 0.20);
      if (L.ditherColor) u3(L.ditherColor, hexToVec3(cfg.ditherColor || '#1a1614'));
      const ditherZoneMap = { shadows: 0, highlights: 1, all: 2 };
      if (L.ditherZone) gl.uniform1i(L.ditherZone, ditherZoneMap[cfg.ditherZone] !== undefined ? ditherZoneMap[cfg.ditherZone] : 0);
      u1(L.ditherStrength, cfg.ditherStrength !== undefined ? cfg.ditherStrength : 0.85);
    }

    u1(L.lightBoost, cfg.lightBoost !== undefined ? cfg.lightBoost : 1.0);
    if (L.isManualMode) gl.uniform1i(L.isManualMode, (cfg.sunMode === 'manual') ? 1 : 0);
    const isManualFixed = (cfg.sunMode === 'manual' && cfg.manualScaleMode === 'fixed');
    if (L.manualScaleMode) gl.uniform1i(L.manualScaleMode, isManualFixed ? 1 : 0);
    u1(L.manualElevMin, cfg.manualElevMin !== undefined ? Number(cfg.manualElevMin) : 0.0);
    u1(L.manualElevMax, cfg.manualElevMax !== undefined ? Number(cfg.manualElevMax) : 1500.0);
    if (L.debugValley) gl.uniform1i(L.debugValley, cfg.debugValley ? 1 : 0);
    if (L.manualColorPeak) u3(L.manualColorPeak, hexToVec3(cfg.manualPeakColor || '#fff8e7'));
    if (L.manualColorMid) u3(L.manualColorMid, hexToVec3(cfg.manualMidColor || '#e8b074'));
    if (L.manualColorValley) u3(L.manualColorValley, hexToVec3(cfg.manualValleyColor || '#ffd8a8'));
    u1(L.manualLightBlend, cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.33);
    u1(L.manualLightSoftness, cfg.manualLightSoftness !== undefined ? cfg.manualLightSoftness : 0.35);
    u1(L.manualLightBlend2, cfg.manualLightBlend2 !== undefined ? cfg.manualLightBlend2 : 0.68);
    u1(L.manualLightSoftness2, cfg.manualLightSoftness2 !== undefined ? cfg.manualLightSoftness2 : 0.35);

    u1(L.twilightClimb, lighting.twilightClimb !== undefined ? lighting.twilightClimb : -1.0);
    u1(L.twilightAmt, lighting.twilightAmt !== undefined ? lighting.twilightAmt : 0.0);
    u1(L.afterglow, lighting.afterglow !== undefined ? lighting.afterglow : 0.0);
    u3(L.glowColor, lighting.glowColor || [0.92, 0.27, 0.33]);
    u3(L.valleyColor, lighting.valleyColor || [0.20, 0.17, 0.46]);
    const stats = vStats || getViewportElevationStats();
    if (L.elevMin) gl.uniform1f(L.elevMin, stats.minH);
    if (L.elevSpan) gl.uniform1f(L.elevSpan, Math.max(10.0, stats.span));
  }

  function renderTileHillshade(img, lat, zoom, lighting, targetCanvas = null, coords = null, slot = null) {
    initSharedGl();
    if (!sharedGl) return null;
    const gl = sharedGl;

    // Флаги и тайминги для профилировщика WM.perf
    let didGeomPass = false;
    let didBakePass = false;
    let glDrawDuration = 0;
    let blitDuration = 0;

    // Владелец текстур: холст тайла (или временный объект, если холст не передан)
    const owner = targetCanvas || {};

    if (owner._glId !== sharedGlId) {
      owner._demTex = null;
      owner._gBuf = null;
      owner._sBuf = null;
      owner._waterMaskTex = null;
      owner._cachedDemImg = null;
      owner._geomVersion = -1;
      owner._bakeSig = null;
      owner._lightSig = null;
      owner._featMaskTex = null;
      owner._glId = sharedGlId;
    }

    const P = img.width || 256;
    const S = img._tileSize || 256;
    const B = img._pad || 0;


    if (!slot && (gl.canvas.width !== S || gl.canvas.height !== S)) {
      gl.canvas.width = S;
      gl.canvas.height = S;
    }



    const mppBase = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const currentMpp = mppBase / (S / 256.0);
    const effZ = getEffectiveZFactor();
    const vStats = getViewportElevationStats(zoom);
    const elevSpan = Math.max(10.0, vStats.span);

    // 1. Текстура исходного DEM
    let tileTex = owner._demTex;
    if (!tileTex || owner._demTexWidth !== P || owner._demTexHeight !== P) {
      if (tileTex) gl.deleteTexture(tileTex);
      tileTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, P, P);

      owner._demTex = tileTex;
      owner._demTexWidth = P;
      owner._demTexHeight = P;
      owner._cachedDemImg = null;
    }

    if (owner._cachedDemImg !== img) {
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, img);
      owner._cachedDemImg = img;
    }

    // 2. G-Buffer (нормали + AO/SVF) и S-Buffer (запечённые статичные слои)
    if (!owner._gBuf || owner._gBufWidth !== S) {
      if (owner._gBuf) gl.deleteTexture(owner._gBuf);
      owner._gBuf = createRgba8Tex(gl, S);
      owner._gBufWidth = S;
      owner._geomVersion = -1;
      owner._bakeSig = null;
    }
    if (!owner._sBuf || owner._sBufWidth !== S) {
      if (owner._sBuf) gl.deleteTexture(owner._sBuf);
      owner._sBuf = createRgba8Tex(gl, S);
      owner._sBufWidth = S;
      owner._bakeSig = null;
    }

    // 3. ПРОХОД 1: геометрия (1 раз при загрузке или смене рельефа)
    const needGeomPass = owner._geomVersion !== globalGeomVersion || owner._cachedZ !== effZ;
    if (needGeomPass) {
      didGeomPass = true;

      gl.bindFramebuffer(gl.FRAMEBUFFER, sharedFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, owner._gBuf, 0);
      gl.viewport(0, 0, S, S);

      gl.useProgram(sharedGeomProg);
      gl.bindVertexArray(sharedVao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.uniform1i(geomLocations.dem, 0);

      gl.uniform2i(geomLocations.iRes, P, P);
      gl.uniform1f(geomLocations.pad, B);
      gl.uniform2f(geomLocations.uvOrigin, B / P, B / P);
      gl.uniform2f(geomLocations.uvScale, S / P, S / P);
      gl.uniform1f(geomLocations.zFactor, effZ);

      const smoothModesMap = { none: 0, gauss: 1, bilateral: 2 };
      gl.uniform1i(geomLocations.smooth, smoothModesMap[cfg.smoothMode] !== undefined ? smoothModesMap[cfg.smoothMode] : 2);
      gl.uniform1f(geomLocations.mpp, currentMpp);

      gl.uniform1f(geomLocations.useAO, cfg.ambientOcclusion ? 1.0 : 0.0);
      gl.uniform1f(geomLocations.aoStrength, cfg.aoStrength || 1.0);
      gl.uniform1f(geomLocations.aoRadius, cfg.aoRadius !== undefined ? cfg.aoRadius : 1.0);
      gl.uniform1f(geomLocations.aoSlopeBleed, cfg.aoSlopeBleed !== undefined ? cfg.aoSlopeBleed : 0.65);

      gl.uniform1f(geomLocations.useSVF, cfg.svfEnabled !== false ? 1.0 : 0.0);
      gl.uniform1f(geomLocations.svfStrength, cfg.svfStrength !== undefined ? cfg.svfStrength : 0.85);

      gl.uniform1f(geomLocations.useOpenness, cfg.opennessEnabled ? 1.0 : 0.0);
      gl.uniform1f(geomLocations.opennessRadius, cfg.opennessRadius !== undefined ? cfg.opennessRadius : 1.0);
      gl.uniform1f(geomLocations.opennessStrength, cfg.opennessStrength !== undefined ? cfg.opennessStrength : 0.85);
      gl.uniform1f(geomLocations.opennessDiff, cfg.opennessDiff !== undefined ? cfg.opennessDiff : 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      owner._geomVersion = globalGeomVersion;
      owner._cachedZ = effZ;
    }

    // 3b. ПРОХОД 1b: запекание штриховки / зерна / ватерлиний (не зависят от времени суток)
    const wantHach = !!cfg.hachureEnabled;
    const hachType = wantHach ? (cfg.hachureType || 'classic') : null;
    const hachDensity = cfg.hachureDensity || 1.0;
    const hachThin = cfg.hachureThinning !== undefined ? cfg.hachureThinning : 0.0;
    const hachSlope = cfg.hachureSlope !== undefined ? cfg.hachureSlope : 0.08;
    const hachLen = cfg.hachureLength !== undefined ? cfg.hachureLength : 1.0;
    const hachHybT = cfg.hachureHybridThresh !== undefined ? cfg.hachureHybridThresh : 0.15;
    const hachHybS = cfg.hachureHybridSharpness !== undefined ? cfg.hachureHybridSharpness : 0.50;
    const inkBleedOn = cfg.inkBleed !== false;

    const bakeSig = [
      globalGeomVersion,
      effZ,
      inkBleedOn ? 1 : 0,
      cfg.waterlining ? 1 : 0,
      wantHach ? `${hachType}|${hachDensity}|${hachThin}|${hachSlope}|${hachLen}|${hachHybT}|${hachHybS}` : '0'
    ].join('|');
    if (owner._bakeSig !== bakeSig) {
      didBakePass = true;

      const bake = getOrCreateBakeProgram(gl, hachType);
      const BL = bake.locs;

      gl.bindFramebuffer(gl.FRAMEBUFFER, sharedFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, owner._sBuf, 0);
      gl.viewport(0, 0, S, S);

      gl.useProgram(bake.prog);
      gl.bindVertexArray(sharedVao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, owner._gBuf);
      if (BL.dem) gl.uniform1i(BL.dem, 0);
      if (BL.gbuf) gl.uniform1i(BL.gbuf, 1);

      if (BL.iRes) gl.uniform2i(BL.iRes, P, P);
      if (BL.pad) gl.uniform1f(BL.pad, B);
      if (BL.uvOrigin) gl.uniform2f(BL.uvOrigin, B / P, B / P);
      if (BL.uvScale) gl.uniform2f(BL.uvScale, S / P, S / P);
      if (BL.zFactor) gl.uniform1f(BL.zFactor, effZ);
      if (BL.inkBleed) gl.uniform1f(BL.inkBleed, inkBleedOn ? 1.0 : 0.0);
      if (BL.hachureDensity) gl.uniform1f(BL.hachureDensity, hachDensity);
      if (BL.hachureThinning) gl.uniform1f(BL.hachureThinning, hachThin);
      if (BL.hachureSlope) gl.uniform1f(BL.hachureSlope, hachSlope);
      if (BL.hachureLength) gl.uniform1f(BL.hachureLength, cfg.hachureLength !== undefined ? cfg.hachureLength : 1.0);
      if (BL.hachureHybridThresh) gl.uniform1f(BL.hachureHybridThresh, cfg.hachureHybridThresh !== undefined ? cfg.hachureHybridThresh : 0.15);
      if (BL.hachureHybridSharpness) gl.uniform1f(BL.hachureHybridSharpness, cfg.hachureHybridSharpness !== undefined ? cfg.hachureHybridSharpness : 0.50);


      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      owner._bakeSig = bakeSig;
    }

    // 4. ПРОХОД 2: освещение (выполняется каждый кадр при кручении времени)
    if (slot) gl.viewport(slot.x, slot.y, S, S); else gl.viewport(0, 0, S, S);

    const activeProgramEntry = getOrCreateLightProgram(gl, {
      mdow: !!cfg.mdowEnabled,
      hachure: !!cfg.hachureEnabled,
      hachureType: cfg.hachureType,
      dither: !!cfg.ditherEnabled,
      ditherType: cfg.ditherType,
      featTint: !!(cfg.roadTintEnabled || cfg.edgeTintEnabled),
      outline: !!cfg.outlineEnabled,
      outlineType: cfg.outlineType,
      bounce: !!cfg.bounceEnabled,
      contactShadows: !!cfg.contactShadowsEnabled,
      seaWaves: !!cfg.seaWavesEnabled,       // <-- ДОБАВИТЬ
      seaWaveStyle: cfg.seaWaveStyle         // <-- ДОБАВИТЬ
    });

    const L = activeProgramEntry.locs;

    // gl.useProgram ДОЛЖЕН вызываться ДО передачи любых uniform!
    gl.useProgram(activeProgramEntry.prog);
    if (L.vpOrigin) gl.uniform2i(L.vpOrigin, slot ? slot.x : 0, slot ? slot.y : 0);
    gl.bindVertexArray(sharedVao);

    // Общие uniform-ы заливаются только если изменилось освещение / настройки / z-factor
    if (activeProgramEntry._lighting !== lighting ||
        activeProgramEntry._cfgRev !== cfgRev ||
        activeProgramEntry._effZ !== effZ ||
        activeProgramEntry._elevMin !== vStats.minH ||
        activeProgramEntry._elevSpan !== elevSpan) {
      uploadLightFrameUniforms(gl, L, lighting, effZ, vStats);
      activeProgramEntry._lighting = lighting;
      activeProgramEntry._cfgRev = cfgRev;
      activeProgramEntry._effZ = effZ;
      activeProgramEntry._elevMin = vStats.minH;
      activeProgramEntry._elevSpan = elevSpan;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tileTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, owner._gBuf);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, owner._sBuf);

    gl.activeTexture(gl.TEXTURE4);
    let hasFeatMask = 0;
    if ((cfg.roadTintEnabled || cfg.edgeTintEnabled) && owner._featMaskData) {
      const fSize = owner._featMaskSize || 128;
      if (!owner._featMaskTex) {
        owner._featMaskTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, owner._featMaskTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fSize, fSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, owner._featMaskData);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, owner._featMaskTex);
      }
      hasFeatMask = 1;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    if (L.hasFeatMask) gl.uniform1i(L.hasFeatMask, hasFeatMask);

    // СТРОГО СНАЧАЛА переключаемся на слот TEXTURE3, чтобы не перезаписать TEXTURE2 (_sBuf)!
    gl.activeTexture(gl.TEXTURE3);
    let hasMask = 0;
    if (owner._waterMaskData && !owner._waterMaskData._isFallback) {
      if (!owner._waterMaskTex) {
        owner._waterMaskTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, owner._waterMaskTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 256, 0, gl.RED, gl.UNSIGNED_BYTE, owner._waterMaskData);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, owner._waterMaskTex);
      }
      hasMask = 1;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    if (L.hasWaterMask) gl.uniform1i(L.hasWaterMask, hasMask);
    // Параметры конкретного тайла
    if (L.iRes) gl.uniform2i(L.iRes, P, P);
    if (L.pad) gl.uniform1f(L.pad, B);
    if (L.uvOrigin) gl.uniform2f(L.uvOrigin, B / P, B / P);
    if (L.uvScale) gl.uniform2f(L.uvScale, S / P, S / P);
    if (L.mpp) gl.uniform1f(L.mpp, currentMpp);
    if (L.outlineWorld) {
      const WRAP = 4096;
      const ox = coords ? (((coords.x * 256) % WRAP) + WRAP) % WRAP : 0;
      const oy = coords ? (((coords.y * 256) % WRAP) + WRAP) % WRAP : 0;
      gl.uniform2f(L.outlineWorld, ox, oy);
    }

    // === ВСТАВИТЬ СЮДА ===
    if (L.seaWorld) {
      const WRAP = 65536;
      const ox = coords ? (((coords.x * 256) % WRAP) + WRAP) % WRAP : 0;
      const oy = coords ? (((coords.y * 256) % WRAP) + WRAP) % WRAP : 0;
      gl.uniform2f(L.seaWorld, ox, oy);
    }
    if (L.ditherWorld) {
      const WRAP = 4096;
      const ox = coords ? (((coords.x * 256) % WRAP) + WRAP) % WRAP : 0;
      const oy = coords ? (((coords.y * 256) % WRAP) + WRAP) % WRAP : 0;
      gl.uniform2f(L.ditherWorld, ox, oy);
    }
    if (L.demMaxH) gl.uniform1f(L.demMaxH, img._demMaxH !== undefined ? img._demMaxH : 1e5);

    if (L.fastMode) gl.uniform1i(L.fastMode, isSliderScrubbing ? 1 : 0);

    // --- ЗАМЕР ВРЕМЕНИ ВЫЗОВА ОТРИСОВКИ ШЕЙДЕРА ОСВЕЩЕНИЯ ---
    const tDrawStart = performance.now();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    glDrawDuration = performance.now() - tDrawStart;
    if (slot) {
      if (WM.perf && WM.perf.recordTile) WM.perf.recordTile({ geomPass: didGeomPass, bakePass: didBakePass, glDrawMs: glDrawDuration, blitMs: 0 });
      return null;
    }

    // --- ЗАМЕР ВРЕМЕНИ ПЕРЕДАЧИ В ЦЕЛЕВОЙ ХОЛСТ ТАЙЛА (BLIT) ---
    const tBlitStart = performance.now();
    let resultCanvas = null;

    if (targetCanvas) {
      // Zero-copy передача буфера без GPU stall
      if (gl._isOffscreen && 'transferToImageBitmap' in gl.canvas) {
        let ctx = targetCanvas._bmpCtx;
        if (!ctx) {
          ctx = targetCanvas.getContext('bitmaprenderer');
          targetCanvas._bmpCtx = ctx;
        }
        if (ctx) {
          const bmp = gl.canvas.transferToImageBitmap();
          ctx.transferFromImageBitmap(bmp);
          resultCanvas = targetCanvas;
        }
      }

      if (!resultCanvas) {
        const ctx = targetCanvas.getContext('2d');
        ctx.drawImage(gl.canvas, 0, 0, 256, 256);
        resultCanvas = targetCanvas;
      }
    } else {
      const out = document.createElement('canvas');
      out.width = 256;
      out.height = 256;
      out.getContext('2d').drawImage(gl.canvas, 0, 0, 256, 256);
      if (owner._demTex) gl.deleteTexture(owner._demTex);
      if (owner._gBuf) gl.deleteTexture(owner._gBuf);
      if (owner._sBuf) gl.deleteTexture(owner._sBuf);
      resultCanvas = out;
    }

    blitDuration = performance.now() - tBlitStart;

    // Передаем собранные данные в монитор производительности
    if (WM.perf && typeof WM.perf.recordTile === 'function') {
      WM.perf.recordTile({
        geomPass: didGeomPass,
        bakePass: didBakePass,
        glDrawMs: glDrawDuration,
        blitMs: blitDuration
      });
    }

    return resultCanvas;
  }

  // =========================================================================
  // ЗАГРУЗЧИК И КЭШИРОВАНИЕ ДАННЫХ ВЫСОТ
  // =========================================================================
  const demTileMemoryCache = new Map();
  const demInFlightPromises = new Map();
  const dem404Set = new Set();
  const MAX_DEM_CACHE_ENTRIES = 96;   // было 220
  const MAX_PADDED_CACHE_WEIGHT = 48; // было 160 (1 ед. = 256px-тайл ~1.2 МБ, 512px-тайл = 3 ед. ~4.7 МБ)

  const paddedDemMemoryCache = new Map();
  const paddedInFlightPromises = new Map();
  let _paddedCacheWeight = 0;

  function paddedWeight(cv) {
    return (cv && (cv._tileSize || 256) >= 512) ? 3 : 1;
  }

  function getDemMemoryCache(key) {
    if (!demTileMemoryCache.has(key)) return null;
    const val = demTileMemoryCache.get(key);
    demTileMemoryCache.delete(key);
    demTileMemoryCache.set(key, val); // поднимаем в конец (LRU)
    return val;
  }

  function getPaddedDemCache(key) {
    if (!paddedDemMemoryCache.has(key)) return null;
    const val = paddedDemMemoryCache.get(key);
    paddedDemMemoryCache.delete(key);
    paddedDemMemoryCache.set(key, val); // поднимаем в конец (LRU)
    return val;
  }

  const paddedInUse = new Map();

  function disposePaddedCv(cv) {
    if (!cv) return;
    cv._demData = null;
    cv._contourSmoothed = null;
    cv._blockMin = null;
    cv._blockMax = null;
    cv.width = 0;
    cv.height = 0;
  }

  function retainPaddedDem(cv) {
    if (!cv) return cv;
    paddedInUse.set(cv, (paddedInUse.get(cv) || 0) + 1);
    return cv;
  }

  function releasePaddedDem(cv) {
    if (!cv) return;
    const cnt = (paddedInUse.get(cv) || 0) - 1;
    if (cnt > 0) {
      paddedInUse.set(cv, cnt);
      return;
    }
    paddedInUse.delete(cv);
    if (cv._evicted) disposePaddedCv(cv);
  }

  function evictPaddedDem(cv) {
    if (!cv) return;
    cv._evicted = true;
    if (!paddedInUse.has(cv)) disposePaddedCv(cv);
  }

  function deletePaddedDemCache(key) {
    const prev = paddedDemMemoryCache.get(key);
    if (prev) {
      _paddedCacheWeight = Math.max(0, _paddedCacheWeight - paddedWeight(prev));
      paddedDemMemoryCache.delete(key);
      evictPaddedDem(prev);
    }
  }

  function clearPaddedDemCache() {
    for (const cv of paddedDemMemoryCache.values()) {
      evictPaddedDem(cv);
    }
    paddedDemMemoryCache.clear();
    _paddedCacheWeight = 0;
  }

  const demInUse = new Map();

  function disposeDemImg(img) {
    if (!img) return;
    parentHeightCache.delete(img);
    if (typeof img.close === 'function') {
      try { img.close(); } catch (e) {}
    } else if (img instanceof HTMLCanvasElement) {
      img.width = 0;
      img.height = 0;
    }
  }




  function setPaddedDemCache(key, value) {
    if (value) value._evicted = false;
    deletePaddedDemCache(key);
    const w = paddedWeight(value);
    while (_paddedCacheWeight + w > MAX_PADDED_CACHE_WEIGHT && paddedDemMemoryCache.size > 0) {
      const firstKey = paddedDemMemoryCache.keys().next().value;
      deletePaddedDemCache(firstKey);
    }
    paddedDemMemoryCache.set(key, value);
    _paddedCacheWeight += w;
  }

  function retainDemImg(img) {
    if (!img) return img;
    demInUse.set(img, (demInUse.get(img) || 0) + 1);
    return img;
  }

  function releaseDemImg(img) {
    if (!img) return;
    const cnt = (demInUse.get(img) || 0) - 1;
    if (cnt > 0) {
      demInUse.set(img, cnt);
      return;
    }
    demInUse.delete(img);
    if (img._evicted) {
      disposeDemImg(img);
    }
  }

  function evictDemImg(img) {
    if (!img) return;
    img._evicted = true;
    if (!demInUse.has(img)) {
      disposeDemImg(img);
    }
  }

  function setDemMemoryCache(key, value) {
    if (value) value._evicted = false;
    if (demTileMemoryCache.has(key)) {
      const prev = demTileMemoryCache.get(key);
      if (prev && prev !== value) evictDemImg(prev);
      demTileMemoryCache.delete(key);
    } else if (demTileMemoryCache.size >= MAX_DEM_CACHE_ENTRIES) {
      const firstKey = demTileMemoryCache.keys().next().value;
      const evicted = demTileMemoryCache.get(firstKey);
      demTileMemoryCache.delete(firstKey);
      if (evicted && evicted !== value) evictDemImg(evicted);
    }
    demTileMemoryCache.set(key, value);
  }

  const TARGET_SIZE = 256;

   async function decodeDemBlob(blob, fromCache = false) {
    let bmp;
    if ('createImageBitmap' in window) {
      try {
        bmp = await createImageBitmap(blob, {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none'
        });
      } catch (e) {}
    }

    if (!bmp) {
      bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const blobUrl = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(blobUrl);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Decode error'));
        };
        img.src = blobUrl;
      });
    }

    const w = bmp.naturalWidth || bmp.width;
    const h = bmp.naturalHeight || bmp.height;
    if (!w || !h) {
      if (typeof bmp.close === 'function') bmp.close();
      throw new Error('Empty dimensions');
    }

    if (isImageMostlyTransparent(bmp)) {
      if (typeof bmp.close === 'function') bmp.close();
      const err = new Error('Empty transparent tile');
      err.isEmptyTile = true;
      throw err;
    }

    // Сохраняем как 256x256 (AWS), так и нативные 512x512 (Mapterhorn) без прореживания!
    if (w === h && (w === TARGET_SIZE || w === 512)) {
      bmp._fromCache = fromCache;
      return bmp;
    }

    const outSize = w >= 512 ? 512 : TARGET_SIZE;
    const cv = document.createElement('canvas');
    cv.width = outSize;
    cv.height = outSize;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0, outSize, outSize);

    if (typeof bmp.close === 'function') bmp.close();
    cv._fromCache = fromCache;
    return cv;
  }

  // Ограничитель одновременных сетевых запросов (предотвращает троттлинг браузера и забивание очереди)
  const DEM_MAX_PARALLEL = 6;
  let _demActive = 0;
  const _demWaiters = [];

  function acquireDemSlot() {
    if (_demActive < DEM_MAX_PARALLEL) {
      _demActive++;
      return Promise.resolve();
    }
    return new Promise(res => _demWaiters.push(res));
  }

  function releaseDemSlot() {
    const next = _demWaiters.pop(); // LIFO: загружаем в первую очередь тайлы, на которые смотрит пользователь прямо сейчас
    if (next) {
      next();
    } else {
      _demActive--;
    }
  }

  // ===== УМНАЯ ЗАГРУЗКА DEM: здоровье провайдеров, отсутствующие тайлы, потолки зума =====
  // Максимальный нативный зум по хосту. Если ошибся в большую сторону — ничего страшного,
  // потолок дообучится по 404; в меньшую — потеряешь детализацию (проверь по докам).
  const DEM_URL_MAXZ = [
    [/earthengine\.googleapis\.com/i, 14],
    [/\/tiles\/(?:fabdem|copernicus)\//i, 14],
    [/type=(?:fabdem|copernicus)/i, 14],
    [/mapterhorn\.com/i, 17],
    [/elevation-tiles-prod/i, 15],
    [/nextzen\.org/i, 15]
  ];
  function demUrlMaxZ(tpl) {
    for (const [re, z] of DEM_URL_MAXZ) if (re.test(tpl)) return z;
    return 18;
  }

  // --- Circuit breaker на каждый URL-шаблон ---
  const demEp = new Map();
  function epState(tpl) {
    let s = demEp.get(tpl);
    if (!s) { s = { fails: 0, openUntil: 0, backoff: 30000, lastOk: 0 }; demEp.set(tpl, s); }
    return s;
  }
  function epIsOpen(tpl) { return Date.now() < epState(tpl).openUntil; }
  function epOk(tpl) {
    const s = epState(tpl);
    s.fails = 0; s.openUntil = 0; s.backoff = 30000; s.lastOk = Date.now();
  }
  function epFail(tpl, kind) {
    const s = epState(tpl);
    // При сетевой блокировке (ERR_CONNECTION_CLOSED/RESET) не ждём 6 тайлов —
    // отключаем заблокированный хост на 5 минут уже после 2-го сбоя
    s.fails += (kind === 'network') ? 3 : 1;
    if (s.fails >= 6) {
      s.openUntil = Date.now() + (kind === 'network' ? 300000 : s.backoff);
      s.backoff = Math.min(s.backoff * 2, 300000);
      s.fails = 4;
    }
  }

  // --- Отсутствующие тайлы (без вечного Infinity-бана при временных сбоях CDN) ---
  const demAbsent = new Map();
  const demAbsentKey = (tpl, z, x, y) => tpl + '|' + z + '/' + x + '/' + y;
  function demMarkAbsent(tpl, z, x, y, ttlMs = 300000) {
    demAbsent.set(demAbsentKey(tpl, z, x, y), Date.now() + ttlMs);
    if (demAbsent.size > 800) {
      demAbsent.delete(demAbsent.keys().next().value);
    }
  }
  function demIsAbsent(tpl, z, x, y) {
    const now = Date.now();
    for (let k = 0; k <= 6 && z - k >= 0; k++) {
      const key = demAbsentKey(tpl, z - k, x >>> k, y >>> k);
      const exp = demAbsent.get(key);
      if (exp !== undefined) {
        if (exp > now) return true;
        demAbsent.delete(key);
      }
    }
    return false;
  }

  const DEM_CELL_MISS_LIMIT = 4;
  const demCell = new Map();
  function demCellStat(tpl, z, x, y) {
    const k = tpl + '|' + z + '|' + (x >> 3) + '|' + (y >> 3);
    let s = demCell.get(k);
    const now = Date.now();
    if (!s || now - s.t > 180000) {
      s = { miss: 0, hit: 0, t: now };
      demCell.set(k, s);
      if (demCell.size > 400) {
        demCell.delete(demCell.keys().next().value);
      }
    }
    return s;
  }

  function classifyDemError(err) {
    if (!err) return 'transient';
    if (err.isEmptyTile) return 'absent'; // спускаемся на зум ниже!
    const st = err.status;
    if (st === 404 || st === 410) return 'absent';
    if (st === 403 || st === 429 || st >= 500) return 'transient';
    if (err.name === 'AbortError') return 'transient';
    if (err.name === 'TypeError') return 'network';
    return 'bad';
  }

  function resetDemNet() {
    demEp.clear(); demAbsent.clear(); demCell.clear(); _degradedAttempt = 0;
  }
  

  let _waterRetryTimer = 0;
  let _waterRetryAttempt = 0;

  function scheduleWaterMaskRetry() {
    if (_waterRetryTimer || _waterRetryAttempt >= 5 || navigator.onLine === false) return;
    const delay = Math.min(4000 * Math.pow(1.8, _waterRetryAttempt++), 45000);
    _waterRetryTimer = setTimeout(() => {
      _waterRetryTimer = 0;
      if (isPeakViewForeground()) return;
      if (hillshadeLayerInstance && cfg.hillshadeEnabled) {
        reloadMissingTiles({ onlyWater: true });
      }
    }, delay);
  }

  // Повторная попытка для тайлов, собранных из-за сбоя сети (а не из-за отсутствия данных)
  let _degradedTimer = 0, _degradedAttempt = 0;
  function scheduleDegradedRetry() {
    if (_degradedTimer || _degradedAttempt >= 6 || navigator.onLine === false) return;
    const delay = Math.min(20000 * Math.pow(2, _degradedAttempt++), 120000);
    _degradedTimer = setTimeout(() => {
      _degradedTimer = 0;
      if (isPeakViewForeground()) return;
      reloadMissingTiles({ keepBackoff: true });
    }, delay);
  }

  let _probeCv = null, _probeCtx = null;
  function isImageMostlyTransparent(bmp) {
    if (!_probeCv) {
      _probeCv = document.createElement('canvas');
      _probeCv.width = 32; _probeCv.height = 32;
      _probeCtx = _probeCv.getContext('2d', { willReadFrequently: true });
    }
    _probeCtx.imageSmoothingEnabled = false;
    _probeCtx.clearRect(0, 0, 32, 32);
    _probeCtx.drawImage(bmp, 0, 0, 32, 32);
    const d = _probeCtx.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < d.length; i += 4) {
      // Требуем хотя бы один непрозрачный валидный пиксель (иначе в Terrarium ломается R-байт)
      if (d[i + 3] < 250) continue;
      const h = (d[i] * 256 + d[i + 1] + d[i + 2] / 256) - 32768;
      if (h >= -500) return false;
    }
    return true;
  }
  async function fetchSingleTile(url, preferredSrc = null) {
    const provider = detectProviderFromUrl(url, preferredSrc);
    const bypassCache = isForceBypass();

    // 1. Cache-First (при принудительном обновлении онлайн кэш пропускаем)
    if (!bypassCache && WM.offlineArea && typeof WM.offlineArea.readCachedBlob === 'function') {
      try {
        const cachedBlob = await WM.offlineArea.readCachedBlob(url);
        if (cachedBlob) {
          const img = await decodeDemBlob(cachedBlob, true);
          img._demProvider = provider;
          WM.layerDiag?.log('dem', 'cache-idb', { url, provider, bytes: cachedBlob.size, outcome: 'ok' });
          return img;
        }
      } catch (e) {}
    }

    if (navigator.onLine === false) {
      const offErr = new Error('Offline');
      offErr.isOffline = true;
      throw offErr;
    }

    // 2. Сеть
    await acquireDemSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const t0 = performance.now();

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        mode: 'cors',
        cache: bypassCache ? 'reload' : 'default'
      });
      if (!resp.ok) {
        const err = new Error(resp.status === 404 ? '404' : `HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const blob = await resp.blob();
      const img = await decodeDemBlob(blob, false);
      img._demProvider = provider;
      WM.layerDiag?.log('dem', 'net', {
        url, provider, status: 200, bytes: blob.size, ms: Math.round(performance.now() - t0), outcome: 'ok'
      });
      return img;
    } finally {
      clearTimeout(timeout);
      releaseDemSlot();
    }
  }
  const parentHeightCache = new WeakMap();

  function getParentHeightGrid(img) {
    let entry = parentHeightCache.get(img);
    if (entry) return entry;

    const w = img.naturalWidth || img.width || 256;
    const h = img.naturalHeight || img.height || 256;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: !!cfg.contoursEnabled });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;

    const grid = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      if (data[idx + 3] < 250) {
        grid[i] = NaN;
      } else {
        const rawH = (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
        grid[i] = rawH < -500 ? NaN : rawH;
      }
    }

    entry = { grid, w, h };
    parentHeightCache.set(img, entry);
    return entry;
  }


  function bspline1D(p0, p1, p2, p3, t) {
    const mt = 1.0 - t;
    const t2 = t * t;
    const w0 = (mt * mt * mt) / 6.0;
    const w1 = (3.0 * t2 * t - 6.0 * t2 + 4.0) / 6.0;
    const w2 = (-3.0 * t2 * t + 3.0 * t2 + 3.0 * t + 1.0) / 6.0;
    const w3 = (t2 * t) / 6.0;
    return p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3;
  }

  function cropParentTile(parentImg, targetCoords, parentCoords, neighbors = null) {
    const { grid, w, h } = getParentHeightGrid(parentImg);
    const factor = 1 << (targetCoords.z - parentCoords.z);
    const subX = ((targetCoords.x % factor) + factor) % factor;
    const subY = ((targetCoords.y % factor) + factor) % factor;

    const OUT_SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = OUT_SIZE;
    canvas.height = OUT_SIZE;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(OUT_SIZE, OUT_SIZE);
    const out32 = new Uint32Array(imgData.data.buffer);

    const nb = neighbors || {};
    const validNb = (img) => {
      if (!img) return null;
      const g = getParentHeightGrid(img);
      return (g.w === w && g.h === h) ? g.grid : null;
    };
    const gL  = validNb(nb.L),  gR  = validNb(nb.R);
    const gT  = validNb(nb.T),  gB  = validNb(nb.B);
    const gTL = validNb(nb.TL), gTR = validNb(nb.TR);
    const gBL = validNb(nb.BL), gBR = validNb(nb.BR);

    const samplePx = (ix, iy) => {
      let g = grid;
      let sx = ix, sy = iy;
      if (ix < 0) {
        if (iy < 0) {
          if (gTL) { g = gTL; sx = ix + w; sy = iy + h; }
          else if (gT) { g = gT; sx = 0; sy = iy + h; }
          else if (gL) { g = gL; sx = ix + w; sy = 0; }
          else { sx = 0; sy = 0; }
        } else if (iy >= h) {
          if (gBL) { g = gBL; sx = ix + w; sy = iy - h; }
          else if (gB) { g = gB; sx = 0; sy = iy - h; }
          else if (gL) { g = gL; sx = ix + w; sy = h - 1; }
          else { sx = 0; sy = h - 1; }
        } else {
          if (gL) { g = gL; sx = ix + w; }
          else { sx = 0; }
        }
      } else if (ix >= w) {
        if (iy < 0) {
          if (gTR) { g = gTR; sx = ix - w; sy = iy + h; }
          else if (gT) { g = gT; sx = w - 1; sy = iy + h; }
          else if (gR) { g = gR; sx = ix - w; sy = 0; }
          else { sx = w - 1; sy = 0; }
        } else if (iy >= h) {
          if (gBR) { g = gBR; sx = ix - w; sy = iy - h; }
          else if (gB) { g = gB; sx = w - 1; sy = iy - h; }
          else if (gR) { g = gR; sx = ix - w; sy = h - 1; }
          else { sx = w - 1; sy = h - 1; }
        } else {
          if (gR) { g = gR; sx = ix - w; }
          else { sx = w - 1; }
        }
      } else {
        if (iy < 0) {
          if (gT) { g = gT; sy = iy + h; }
          else { sy = 0; }
        } else if (iy >= h) {
          if (gB) { g = gB; sy = iy - h; }
          else { sy = h - 1; }
        }
      }
      sx = sx < 0 ? 0 : (sx >= w ? w - 1 : sx);
      sy = sy < 0 ? 0 : (sy >= h ? h - 1 : sy);
      return g[sy * w + sx];
    };

    const isCopernicusParent = (parentImg._demProvider === 'mapterhorn' && parentCoords.z <= 12);
    const PAD = isCopernicusParent ? 8 : 2;

    const patchX0 = Math.floor((subX / factor) * w) - PAD;
    const patchY0 = Math.floor((subY / factor) * h) - PAD;
    const patchW = Math.ceil(((subX + 1) / factor) * w) + PAD - patchX0;
    const patchH = Math.ceil(((subY + 1) / factor) * h) + PAD - patchY0;
    const patch = new Float32Array(patchW * patchH);

    for (let py = 0; py < patchH; py++) {
      const pOff = py * patchW;
      const iy = patchY0 + py;
      for (let px = 0; px < patchW; px++) {
        patch[pOff + px] = samplePx(patchX0 + px, iy);
      }
    }

    let patchValid = 0;
    for (let i = 0; i < patch.length; i++) if (patch[i] === patch[i]) patchValid++;
    if (patchValid === 0) {
      canvas.width = 0;
      canvas.height = 0;
      return null;
    }

    // Подавляем муар/полосы перепроецирования Copernicus 30m (только Mapterhorn z<=12)
    if (isCopernicusParent) {
      const tmp = new Float32Array(patchW * patchH);
      const boxX = (src, dst, rad) => {
        for (let py = 0; py < patchH; py++) {
          const row = py * patchW;
          for (let px = 0; px < patchW; px++) {
            let sum = 0, cnt = 0;
            for (let d = -rad; d <= rad; d++) {
              const sx = px + d < 0 ? 0 : (px + d >= patchW ? patchW - 1 : px + d);
              const val = src[row + sx];
              if (!isNaN(val)) { sum += val; cnt++; }
            }
            dst[row + px] = cnt > 0 ? sum / cnt : NaN;
          }
        }
      };
      // 2 прохода по X (окна 7 и 5 px вырезают 5–8 px полосы >93%)
      boxX(patch, tmp, 3);
      boxX(tmp, patch, 2);

      // Лёгкое [1, 2, 1]/4 сглаживание по Y, чтобы убрать мелкую ступеньку
      for (let py = 0; py < patchH; py++) {
        const y0 = py > 0 ? py - 1 : 0;
        const y2 = py + 1 < patchH ? py + 1 : patchH - 1;
        for (let px = 0; px < patchW; px++) {
          const c = patch[py * patchW + px];
          if (isNaN(c)) { tmp[py * patchW + px] = NaN; continue; }
          const u = patch[y0 * patchW + px], b = patch[y2 * patchW + px];
          let sum = c * 2, w = 2;
          if (!isNaN(u)) { sum += u; w += 1; }
          if (!isNaN(b)) { sum += b; w += 1; }
          tmp[py * patchW + px] = sum / w;
        }
      }
      patch.set(tmp);
    }

    const invFactor = 1 / factor;
    const invOutSize = 1 / OUT_SIZE;
    let validOutPx = 0;

    for (let y = 0; y < OUT_SIZE; y++) {
      const fy = ((subY + (y + 0.5) * invOutSize) * invFactor) * h - 0.5;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const py1 = y0 - patchY0;
      const r0 = (py1 - 1) * patchW;
      const r1 = py1 * patchW;
      const r2 = (py1 + 1) * patchW;
      const r3 = (py1 + 2) * patchW;
      const rowOffset = y * OUT_SIZE;

      for (let x = 0; x < OUT_SIZE; x++) {
        const fx = ((subX + (x + 0.5) * invOutSize) * invFactor) * w - 0.5;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const px1 = x0 - patchX0;

        const c11 = patch[r1 + px1];
        if (isNaN(c11)) {
          out32[rowOffset + x] = 0;
          continue;
        }

        const p00 = patch[r0 + px1 - 1], p01 = patch[r0 + px1], p02 = patch[r0 + px1 + 1], p03 = patch[r0 + px1 + 2];
        const p10 = patch[r1 + px1 - 1], p11 = c11,               p12 = patch[r1 + px1 + 1], p13 = patch[r1 + px1 + 2];
        const p20 = patch[r2 + px1 - 1], p21 = patch[r2 + px1], p22 = patch[r2 + px1 + 1], p23 = patch[r2 + px1 + 2];
        const p30 = patch[r3 + px1 - 1], p31 = patch[r3 + px1], p32 = patch[r3 + px1 + 1], p33 = patch[r3 + px1 + 2];

        let hMid;
        if (isNaN(p00) || isNaN(p01) || isNaN(p02) || isNaN(p03) ||
            isNaN(p10) ||               isNaN(p12) || isNaN(p13) ||
            isNaN(p20) || isNaN(p21) || isNaN(p22) || isNaN(p23) ||
            isNaN(p30) || isNaN(p31) || isNaN(p32) || isNaN(p33)) {
          hMid = c11;
        } else {
          const v0 = bspline1D(p00, p01, p02, p03, tx);
          const v1 = bspline1D(p10, p11, p12, p13, tx);
          const v2 = bspline1D(p20, p21, p22, p23, tx);
          const v3 = bspline1D(p30, p31, p32, p33, tx);
          hMid = bspline1D(v0, v1, v2, v3, ty);
        }

        const v = Math.max(0, Math.min(65535.996, hMid + 32768.0));
        const q = Math.round(v * 256.0);
        const r = (q >> 16) & 255;
        const g = (q >> 8) & 255;
        const b = q & 255;
        out32[rowOffset + x] = (255 << 24) | (b << 16) | (g << 8) | r;
        validOutPx++;
      }
    }

    if (validOutPx === 0) return null;

    ctx.putImageData(imgData, 0, 0);
    canvas._fromParentCrop = true;
    return canvas;
  }

  const _asmQueue = [];
  let _asmRaf = 0;

  function asmGate() {
    return new Promise(res => {
      _asmQueue.push(res);
      if (!_asmRaf) _asmRaf = requestAnimationFrame(pumpAsm);
    });
  }

  function pumpAsm() {
    _asmRaf = 0;
    // По 1 сборке за кадр — чтобы склейка 384x384 не вызывала микрофризов
    if (_asmQueue.length) {
      _asmQueue.shift()();
    }
    if (_asmQueue.length) {
      _asmRaf = requestAnimationFrame(pumpAsm);
    }
  }

  function destripeMapterhornPadded(cv, coords, centerProvider) {
  if (centerProvider !== 'mapterhorn' || coords.z > 12 || coords.z < 9) return false;
  // Сильнее всего артефакт выражен на 50°+, но лёгкий проход на z=11..12 полезен и шире
  const P = cv.width;
  const S = cv._tileSize || 256;
  const scale = S / 512; // для 512px -> 1, для 256px -> 0.5
  const r1 = Math.max(1, Math.round(3 * scale));
  const r2 = Math.max(1, Math.round(2 * scale));

  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, P, P);
  const d = img.data;
  const N = P * P;

  const hm = new Float32Array(N);
  const lm = new Float32Array(N);
  const tmpH = new Float32Array(N);
  const tmpL = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (d[o + 3] < 30) continue;
    const h = (d[o] * 256 + d[o + 1] + d[o + 2] / 256) - 32768;
    if (h <= 0.25) continue;
    hm[i] = h;
    lm[i] = 1;
  }

  const box1DX = (srcH, srcL, dstH, dstL, r) => {
    const last = P - 1;
    for (let y = 0; y < P; y++) {
      const row = y * P;
      let accH = 0, accL = 0;
      for (let i = -r; i <= r; i++) {
        const idx = row + Math.min(last, Math.max(0, i));
        accH += srcH[idx];
        accL += srcL[idx];
      }
      for (let x = 0; x < P; x++) {
        dstH[row + x] = accH;
        dstL[row + x] = accL;
        const addIdx = row + Math.min(last, x + r + 1);
        const subIdx = row + Math.max(0, x - r);
        accH += srcH[addIdx] - srcH[subIdx];
        accL += srcL[addIdx] - srcL[subIdx];
      }
    }
    for (let i = 0; i < N; i++) {
      const w = 2 * r + 1;
      dstH[i] /= w;
      dstL[i] /= w;
    }
  };

  box1DX(hm, lm, tmpH, tmpL, r1);
  box1DX(tmpH, tmpL, hm, lm, r2);

  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (d[o + 3] < 30 || lm[i] <= 0.45) continue;
    const h = Math.max(0.3, hm[i] / lm[i]);
    const v = Math.max(0, Math.min(65535.996, h + 32768));
    const q = Math.round(v * 256);
    d[o] = (q >> 16) & 255;
    d[o + 1] = (q >> 8) & 255;
    d[o + 2] = q & 255;
  }

  ctx.putImageData(img, 0, 0);
  cv._demData = d;
  return true;
}

  let _dbHm = null, _dbLm = null, _dbTmp = null;

  function deblockPaddedDem(cv, coords) {
    if (cfg.demDeblock === false) return false;
    // Тайлы, полученные B-сплайн интерполяцией из родителя, уже гладкие —
    // повторный per-tile деблокинг создаёт швы на берегах
    if (cv._fromParentCrop) return false;

    const P = cv.width;
    const S = cv._tileSize || 256;
    const B = cv._pad || 0;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, P, P);
    const d = img.data;
    cv._demData = d;

    const isLandPx = (o) => {
      if (d[o + 3] < 30) return false;
      const r = d[o];
      return !(r < 128 || (r === 128 && d[o + 1] === 0 && d[o + 2] <= 64));
    };

    let eq = 0, tot = 0;
    const xStart = B;
    const xEnd = Math.min(P - 1, B + S - 1);
    const yStart = B;
    const yEnd = Math.min(P, B + S);
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x++) {
        const o = (y * P + x) * 4;
        if (!isLandPx(o) || !isLandPx(o + 4)) continue;
        tot++;
        if (d[o] === d[o + 4] && d[o + 1] === d[o + 5] && d[o + 2] === d[o + 6]) eq++;
      }
    }
    if (tot < 64 || eq / tot < 0.75) return false;

    const n = Math.PI - (2 * Math.PI * (coords.y + 0.5)) / Math.pow(2, coords.z);
    const lat = Math.atan(Math.sinh(n));
    const mpp = (156543.03392 * Math.cos(lat)) / Math.pow(2, coords.z) / (S / 256);
    const r = clamp(Math.round((cfg.demDeblockSigmaM || 60) / mpp), 2, 18);

    const N = P * P;
    if (!_dbHm || _dbHm.length !== N) {
      _dbHm = new Float32Array(N);
      _dbLm = new Float32Array(N);
      _dbTmp = new Float32Array(N);
    } else {
      _dbHm.fill(0);
      _dbLm.fill(0);
    }
    const hm = _dbHm, lm = _dbLm, tmp = _dbTmp;

    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (!isLandPx(o)) continue;
      hm[i] = (d[o] * 256 + d[o + 1] + d[o + 2] / 256) - 32768;
      lm[i] = 1;
    }
    _blur3(hm, tmp, P, r);
    _blur3(lm, tmp, P, r);

    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (d[o + 3] < 30) continue;
      const h = lm[i] > 0.45 ? Math.max(0.6, hm[i] / lm[i]) : 0.0;
      const v = h + 32768;
      const R = Math.floor(v / 256);
      const fl = Math.floor(v);
      d[o] = R;
      d[o + 1] = fl - R * 256;
      d[o + 2] = Math.min(255, Math.floor((v - fl) * 256));
    }
    ctx.putImageData(img, 0, 0);
    cv._demData = d;
    cv._deblocked = true;
    return true;
  }

  // =========================================================================
  // ДЕБЛОКИНГ DEM: лечит плоские «плато» с разной высотой на швах тайлов,
  // 1-метровое квантование и ступенчатую береговую линию
  // =========================================================================
  function _boxPass(src, dst, P, r, vertical) {
    const w = 2 * r + 1, last = P - 1;
    const step = vertical ? P : 1;
    for (let a = 0; a < P; a++) {
      const base = vertical ? a : a * P;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[base + Math.min(last, Math.max(0, i)) * step];
      for (let i = 0; i < P; i++) {
        dst[base + i * step] = acc / w;
        acc += src[base + Math.min(last, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
      }
    }
  }

  // 3 прохода box-blur ≈ гауссиан
  function _blur3(a, tmp, P, r) {
    for (let k = 0; k < 3; k++) {
      _boxPass(a, tmp, P, r, false);
      _boxPass(tmp, a, P, r, true);
    }
  }

  async function loadPaddedDemTile(coords) {
    const srcKey = cfg.demSource || 'fabdem';
    const cacheKey = `${srcKey}:${coords.z}:${coords.x}:${coords.y}`;
    const startGen = _demCacheGen;

    const cachedPadded = getPaddedDemCache(cacheKey);
    if (cachedPadded) {
      if (cachedPadded._minH !== undefined && coords) {
        registerTileElevation(coords, cachedPadded._minH, cachedPadded._maxH, cachedPadded._blockMin, cachedPadded._blockMax);
      }
      return cachedPadded;
    }
    if (paddedInFlightPromises.has(cacheKey)) {
      return paddedInFlightPromises.get(cacheKey);
    }

    const promise = (async () => {
      const center = await loadDemTileWithFallback(coords);
      retainDemImg(center);
      const pinned = [center];

      try {
        // ⚡ Ждём разрешения шлюза, чтобы не забивать UI-поток пачкой из 10+ склеек canvas
        await asmGate();

        const S = center.naturalWidth || center.width || 256;
        const B = Math.round(64 * (S / 256));
        const P = S + 2 * B;

        const cv = document.createElement('canvas');
        cv.width = P;
        cv.height = P;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;

        // 1. Рисуем центр и клемпим его крайние 1px полосы на поля B (без растяжения всего тайла!)
        ctx.drawImage(center, B, B, S, S);
        ctx.drawImage(center, 0, 0, 1, S, 0, B, B, S);           // L
        ctx.drawImage(center, S - 1, 0, 1, S, B + S, B, B, S);   // R
        ctx.drawImage(center, 0, 0, S, 1, B, 0, S, B);           // T
        ctx.drawImage(center, 0, S - 1, S, 1, B, B + S, S, B);   // B
        ctx.drawImage(center, 0, 0, 1, 1, 0, 0, B, B);           // TL
        ctx.drawImage(center, S - 1, 0, 1, 1, B + S, 0, B, B);   // TR
        ctx.drawImage(center, 0, S - 1, 1, 1, 0, B + S, B, B);   // BL
        ctx.drawImage(center, S - 1, S - 1, 1, 1, B + S, B + S, B, B); // BR

        const maxCoord = 1 << coords.z;
        const neighbors = [];

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = coords.y + dy;
            if (ny < 0 || ny >= maxCoord) continue;
            const nx = (coords.x + dx + maxCoord) % maxCoord;

            neighbors.push(
              loadDemTileWithFallback({ z: coords.z, x: nx, y: ny })
                .then(img => {
                  retainDemImg(img);
                  pinned.push(img);
                  return { img, dx, dy };
                })
                .catch(() => null)
            );
          }
        }

        const results = await Promise.all(neighbors);
        let degraded = !!center._degraded;
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          if (!res || !res.img) {
            degraded = true;
            continue;
          }
          if (res.img._isEmptyFallback) {
            if (res.img._degraded) degraded = true; // честный 404 соседа — не сбой сети
            continue;
          }
          if (res.img._degraded) degraded = true;
          ctx.clearRect(B + res.dx * S, B + res.dy * S, S, S);
          ctx.drawImage(res.img, B + res.dx * S, B + res.dy * S, S, S);
        }

        cv._pad = B;
        cv._tileSize = S;
        cv._degraded = degraded;
        cv._needsUpgrade = !!center._needsUpgrade;
        cv._demProvider = center._demProvider || null;
        cv._isEmptyFallback = !!center._isEmptyFallback;
        cv._fromParentCrop = !!center._fromParentCrop;

        if (cv._isEmptyFallback) {
          cv._demMaxH = 9000.0;
          if (_demCacheGen === startGen && !degraded) {
            setPaddedDemCache(cacheKey, cv);
          } else {
            cv._evicted = true;
            if (_demCacheGen === startGen && navigator.onLine !== false) scheduleDegradedRetry();
          }
          return cv;
        }

        destripeMapterhornPadded(cv, coords, center._demProvider);

        deblockPaddedDem(cv, coords);

        const stats = computeTileElevationStats(cv);
        if (!stats) {
          cv._demMaxH = 9000.0;
        } else if (coords) {
          registerTileElevation(coords, stats.minH, stats.maxH, stats.blockMin, stats.blockMax);
          if (cfg.hillshadeEnabled && (!hillshadeLayerInstance || typeof hillshadeLayerInstance._tileZoom !== 'number' || coords.z === hillshadeLayerInstance._tileZoom)) {
            scheduleLiveHillshade();
          }
          notifyDemChange(false, { tilesLoaded: true });
        }

        if (_demCacheGen === startGen && !degraded && !center._needsUpgrade) {
          setPaddedDemCache(cacheKey, cv);
        } else {
          cv._evicted = true;
          if (_demCacheGen === startGen && navigator.onLine !== false) scheduleDegradedRetry();
        }
        return cv;
      } finally {
        for (let i = 0; i < pinned.length; i++) {
          releaseDemImg(pinned[i]);
        }
      }
    })();

    paddedInFlightPromises.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (paddedInFlightPromises.get(cacheKey) === promise) {
        paddedInFlightPromises.delete(cacheKey);
      }
    }
  }



  function createEmptyDemTile(size = 256) {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgb(128, 0, 0)';
    ctx.fillRect(0, 0, size, size);
    cv._isEmptyFallback = true;
    cv._demProvider = 'empty';
    return cv;
  }
  // ------------------------------

  async function loadDemTileWithFallback(coords, noBorderFetch = false, srcOverride = null) {
    const srcKey = (srcOverride && DEM_SOURCES[srcOverride]) ? srcOverride : (cfg.demSource || 'fabdem');
    const origKey = `${srcKey}:${coords.z}:${coords.x}:${coords.y}`;
    const startGen = _demCacheGen;

    const cachedOrig = getDemMemoryCache(origKey);
    if (cachedOrig) return cachedOrig;
    if (navigator.onLine === false) {
      const childHit = getCachedDemTileWithChildren(coords, srcKey);
      if (childHit && !childHit._degraded) return childHit;
    }
    if (demInFlightPromises.has(origKey)) return demInFlightPromises.get(origKey);

    const promise = (async () => {
      const srcObj = DEM_SOURCES[srcKey] || DEM_SOURCES.fabdem;
      let templates = srcObj.urls.slice();

      // Для GEE-источников подставляем прямой URL из gee-tokens на 1-е место
      const isGeeSrc = (srcKey === 'fabdem' || srcKey === 'copernicus');
      let geeDirectTpl = null;
      if (isGeeSrc) {
        if (navigator.onLine !== false) {
          geeDirectTpl = await GeeDemTokens.ensure(srcKey);
          if (geeDirectTpl) templates.unshift(geeDirectTpl);
        }

        // FABDEM покрывает только 60°S–80°N: за пределами сразу идём на AWS/Nextzen
        if (srcKey === 'fabdem') {
          const n = Math.PI - (2 * Math.PI * (coords.y + 0.5)) / Math.pow(2, coords.z);
          const tileLat = Math.atan(Math.sinh(n)) * (180 / Math.PI);
          if (tileLat > 80 || tileLat < -60) {
            templates = templates.filter(u => !/earthengine\.googleapis\.com|fabdem/i.test(u));
          }
        }
      }

      const primaryTpl = templates[0];
      const origZ = coords.z;
      const minFallbackZ = 5; // Спуск до любого ближайшего доступного зума (вплоть до z5)

      let degraded = false;
      let hadProviderError = false;

     const finish = async (img, z, x, y, tplTopZ, tpl) => {
        const finalProvider = img._demProvider || detectProviderFromUrl(tpl, srcKey);
        const isLowerZoom = (z < tplTopZ);
        const isFallbackProvider =
          (srcKey === 'fabdem' || srcKey === 'copernicus' || srcKey === 'mapterhorn') &&
          finalProvider !== srcKey &&
          tpl !== primaryTpl;

        if (z === origZ) {
          img._degraded = degraded;
          img._needsUpgrade = isFallbackProvider || hadProviderError;
          return img;
        }

        let borderMissing = false;
        let out = null;
        const factor = 1 << (origZ - z);
        const subX = ((coords.x % factor) + factor) % factor;
        const subY = ((coords.y % factor) + factor) % factor;
        const needL = !noBorderFetch && (subX === 0);
        const needR = !noBorderFetch && (subX === factor - 1);
        const needT = !noBorderFetch && (subY === 0);
        const needB = !noBorderFetch && (subY === factor - 1);

        retainDemImg(img);
        const pinnedNb = [];
        try {
          let neighbors = null;
          if (needL || needR || needT || needB) {
            const maxC = 1 << z;
            const imgW = img.naturalWidth || img.width || 256;
            const grab = async (dx, dy) => {
              const ny = y + dy;
              if (ny < 0 || ny >= maxC) return null;
              const nx = (x + dx + maxC) % maxC;
              const k = `${srcKey}:${z}:${nx}:${ny}`;
              let nb = getDemMemoryCache(k);
              if (!nb) {
                try {
                  nb = await loadDemTileWithFallback({ z, x: nx, y: ny }, true, srcKey);
                } catch (e) {
                  nb = null;
                }
              }
              if (!nb || nb._isEmptyFallback) {
                if (!nb || nb._degraded) borderMissing = true;
                return null;
              }
              const nbW = nb.naturalWidth || nb.width || 256;
              if (nbW !== imgW) return null;
              if (nb._degraded) borderMissing = true;
              retainDemImg(nb);
              pinnedNb.push(nb);
              return nb;
            };

            const [L, R, T, B, TL, TR, BL, BR] = await Promise.all([
              needL ? grab(-1, 0) : null,
              needR ? grab( 1, 0) : null,
              needT ? grab(0, -1) : null,
              needB ? grab(0,  1) : null,
              (needL && needT) ? grab(-1, -1) : null,
              (needR && needT) ? grab( 1, -1) : null,
              (needL && needB) ? grab(-1,  1) : null,
              (needR && needB) ? grab( 1,  1) : null
            ]);
            neighbors = { L, R, T, B, TL, TR, BL, BR };
          }
          out = cropParentTile(img, coords, { z, x, y }, neighbors);
        } finally {
          releaseDemImg(img);
          for (let i = 0; i < pinnedNb.length; i++) releaseDemImg(pinnedNb[i]);
        }

        if (!out) return null;

        out._degraded = degraded || borderMissing;
        out._needsUpgrade = isLowerZoom || isFallbackProvider || hadProviderError;
        out._demProvider = finalProvider;
        out._fromCache = img._fromCache;
        return out;
      };

      for (const tpl of templates) {
        if (epIsOpen(tpl)) {
          WM.layerDiag?.log('dem', 'skip', { z: origZ, x: coords.x, y: coords.y, url: tpl, provider: detectProviderFromUrl(tpl, srcKey), outcome: 'circuit-open', note: 'Провайдер в паузе' });
          hadProviderError = true;
          continue;
        }

        const tplTopZ = Math.min(origZ, demUrlMaxZ(tpl));
        const shift = origZ - tplTopZ;
        let curZ = tplTopZ;
        let curX = Math.floor(coords.x / Math.pow(2, shift));
        let curY = Math.floor(coords.y / Math.pow(2, shift));

        const isLastTpl = (tpl === templates[templates.length - 1]);
        const tplMinZ = (isLastTpl || navigator.onLine === false)
          ? minFallbackZ
          : Math.max(minFallbackZ, tplTopZ - 3);

        // Локальный флаг деградации только для текущего провайдера (не переносится с упавшего Mapterhorn на AWS)
        let tplDegraded = false;

        while (curZ >= tplMinZ) {
          const cacheKey = `${srcKey}:${curZ}:${curX}:${curY}`;

          // 1. Проверка оперативного кэша памяти
          const cachedImg = getDemMemoryCache(cacheKey);
          if (cachedImg && !cachedImg._isEmptyFallback) {
            degraded = tplDegraded;
            const out = await finish(cachedImg, curZ, curX, curY, tplTopZ, tpl);
            if (out) {
              if (tpl === primaryTpl && !tplDegraded) notifyDemHealth('ok');
              else if (hadProviderError) notifyDemHealth('fallback', cachedImg._demProvider || detectProviderFromUrl(tpl));
              return out;
            }
            curZ -= 1; curX = Math.floor(curX / 2); curY = Math.floor(curY / 2);
            continue;
          }

          // 2. Проверка офлайн-кэша для текущего провайдера и зума
          if (WM.offlineArea && typeof WM.offlineArea.readCachedBlob === 'function') {
            const cachedUrl = L.Util.template(tpl, { z: curZ, x: curX, y: curY });
            try {
              const cachedBlob = await WM.offlineArea.readCachedBlob(cachedUrl);
              if (cachedBlob) {
                const loaded = await decodeDemBlob(cachedBlob, true);
                loaded._demProvider = detectProviderFromUrl(tpl, srcKey);
                if (!tplDegraded) setDemMemoryCache(cacheKey, loaded);
                degraded = tplDegraded;
                const out = await finish(loaded, curZ, curX, curY, tplTopZ, tpl);
                if (out) {
                  if (tpl === primaryTpl && !tplDegraded) notifyDemHealth('ok');
                  else if (hadProviderError) notifyDemHealth('fallback', loaded._demProvider);
                  return out;
                }
                curZ -= 1; curX = Math.floor(curX / 2); curY = Math.floor(curY / 2);
                continue;
              }
            } catch (e) {}
          }

          // 3. В офлайне спускаемся по зумам в поисках закэшированного родителя
          if (navigator.onLine === false) {
            hadProviderError = true;
            tplDegraded = true;
            curZ -= 1;
            curX = Math.floor(curX / 2);
            curY = Math.floor(curY / 2);
            continue;
          }

          const cs = demCellStat(tpl, curZ, curX, curY);
          const skipRequest =
            demIsAbsent(tpl, curZ, curX, curY) ||
            (cs.hit === 0 && cs.miss >= DEM_CELL_MISS_LIMIT);

          if (!skipRequest) {
            const url = L.Util.template(tpl, { z: curZ, x: curX, y: curY });
            try {
              const loaded = await fetchSingleTile(url, srcKey);
              epOk(tpl);
              cs.hit++;

              if (!tplDegraded) setDemMemoryCache(cacheKey, loaded);
              degraded = tplDegraded;
              const out = await finish(loaded, curZ, curX, curY, tplTopZ, tpl);
              if (out) {
                if (tpl === primaryTpl && !tplDegraded) {
                  notifyDemHealth('ok');
                } else if (hadProviderError) {
                  notifyDemHealth('fallback', loaded._demProvider || detectProviderFromUrl(tpl, srcKey));
                }
                return out;
              }
            } catch (err) {
              WM.layerDiag?.log('dem', 'net', { z: curZ, x: curX, y: curY, url, provider: detectProviderFromUrl(tpl, srcKey), status: err?.status || null, error: err?.name === 'AbortError' ? 'Timeout' : (err?.message || 'NetErr'), outcome: 'error' });
              if (err && err.isOffline) {
                hadProviderError = true;
                tplDegraded = true;
              } else {
                const kind = classifyDemError(err);
                const isGeeDirect = /earthengine\.googleapis\.com/i.test(tpl);

                // Токен GEE считаем протухшим ТОЛЬКО при 401/403 (а не при 404!)
                if (isGeeDirect && (err?.status === 401 || err?.status === 403)) {
                  epFail(tpl, 'network');
                  GeeDemTokens.invalidate(srcKey);
                  GeeDemTokens.ensure(srcKey, true);
                  hadProviderError = true;
                  break;
                }

                if (kind === 'absent') {
                  // 404/410 или пустой прозрачный тайл: запоминаем и спускаемся на зум ниже
                  demMarkAbsent(tpl, curZ, curX, curY, 300000);
                  cs.miss++;
                } else if (kind === 'bad') {
                  demMarkAbsent(tpl, curZ, curX, curY, 120000);
                  cs.miss++;
                  hadProviderError = true;
                } else {
                  epFail(tpl, kind);
                  hadProviderError = true;
                  break; // при обрыве сети / 5xx сразу переходим к следующему зеркалу/провайдеру
                }
              }
            }
          }

          curZ -= 1;
          curX = Math.floor(curX / 2);
          curY = Math.floor(curY / 2);
        }
      }

      const empty = createEmptyDemTile(256);
      empty._degraded = hadProviderError;
      if (hadProviderError) notifyDemHealth('empty');
      WM.layerDiag?.log('dem', 'fallback', { z: origZ, x: coords.x, y: coords.y, outcome: hadProviderError ? 'failed' : 'empty-404', note: hadProviderError ? 'Все провайдеры отказали' : 'Пустой DEM до z5' });
      return empty;
    })();
    demInFlightPromises.set(origKey, promise);
    try {
      const res = await promise;
      if (_demCacheGen === startGen && !res._degraded && !res._needsUpgrade && !res._isEmptyFallback) {
        setDemMemoryCache(origKey, res);
      }
      return res;
    } finally {
      if (demInFlightPromises.get(origKey) === promise) {
        demInFlightPromises.delete(origKey);
      }
    }
  }
  function renderTilesBatch(items, lighting) {
    initSharedGl();
    if (!sharedGl || !items.length) return;
    const gl = sharedGl;
    const CHUNK = 36;

    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      const s = items[i].img._tileSize || 256;
      let arr = groups.get(s);
      if (!arr) { arr = []; groups.set(s, arr); }
      arr.push(items[i]);
    }

    for (const [S, groupItems] of groups) {
      for (let off = 0; off < groupItems.length; off += CHUNK) {
        const chunk = groupItems.slice(off, off + CHUNK);
        const cols = Math.ceil(Math.sqrt(chunk.length));
        const rows = Math.ceil(chunk.length / cols);
        const W = cols * S, H = rows * S;

        if (gl.canvas.width < W || gl.canvas.height < H) {
          gl.canvas.width = Math.max(gl.canvas.width, W);
          gl.canvas.height = Math.max(gl.canvas.height, H);
        }

        const slots = new Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const it = chunk[i];
          slots[i] = { x: (i % cols) * S, y: Math.floor(i / cols) * S };
          renderTileHillshade(it.img, it.lat, it.z, lighting, it.canvas, it.coords, slots[i]);
        }

        const t0 = performance.now();
        const src = gl.canvas;
        const glCanvasH = gl.canvas.height;

        for (let i = 0; i < chunk.length; i++) {
          const tileCanvas = chunk[i].canvas;
          const ctx = tileCanvas._cachedCtx2d || (tileCanvas._cachedCtx2d = tileCanvas.getContext('2d', { willReadFrequently: false }));

          ctx.globalCompositeOperation = 'copy';
          ctx.drawImage(src, slots[i].x, glCanvasH - slots[i].y - S, S, S, 0, 0, 256, 256);
        }

        if (WM.perf && WM.perf._activeFrame) WM.perf._activeFrame.blitMs += performance.now() - t0;
      }
    }
  }
  // =========================================================================
  // LEAFLET GRID LAYERS
  // =========================================================================
  // Очередь пакетного рендеринга для вновь прибывших тайлов
  let _incomingTileQueue = [];
  let _incomingQueueRaf = 0;

  let _tpf = 2, _prevFlushTs = 0;

  function flushIncomingTiles(ts) {
    _incomingQueueRaf = 0;
    if (!_incomingTileQueue.length || !WM.map) { _prevFlushTs = 0; return; }

    const map = WM.map;
    const layerZoom = (hillshadeLayerInstance && typeof hillshadeLayerInstance._tileZoom === 'number')
      ? hillshadeLayerInstance._tileZoom
      : Math.min(Math.round(map.getZoom()), 17);
    const center = map.getCenter();

    // адаптивный бюджет: если кадры длинные — 1 тайл, если лёгкие — до 3
    const dt = _prevFlushTs ? (ts - _prevFlushTs) : 16;
    _prevFlushTs = ts;
    if (dt > 26) _tpf = 1; else if (dt < 20 && _tpf < 3) _tpf += 0.25;
    const n = Math.max(1, Math.floor(_tpf));

     const alive = [];
    for (const b of _incomingTileQueue) {
      const t = b.item.canvas;
      if (t._removed || b.item.z !== layerZoom) {
        b.done(null, t);
      } else if (b.item.img && b.item.img._isEmptyFallback) {
        const ctx = t.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, 256, 256);
        t._isEmptyFallback = true;
        t._lightSig = null;
        scheduleDegradedRetry();
        WM.layerDiag?.log('dem', 'render', { z: b.item.z, x: b.item.coords?.x, y: b.item.coords?.y, outcome: 'empty-cleared', note: 'Холст очищен (emptyFallback)' });
        b.done(null, t);
      } else {
        t._isEmptyFallback = false;
        alive.push(b);
      }
    }
    if (!alive.length) { _incomingTileQueue = []; _prevFlushTs = 0; return; }

    const d2 = b => {
      const t = b.item.canvas;
      const dy = t._demLat - center.lat, dx = t._demLng - center.lng;
      return dx * dx + dy * dy;
    };
    alive.sort((a, b) => d2(a) - d2(b));

    const currentBatch = alive.slice(0, n);
    _incomingTileQueue = alive.slice(n);
    if (_incomingTileQueue.length) _incomingQueueRaf = requestAnimationFrame(flushIncomingTiles);
    else _prevFlushTs = 0;

    const lighting = getSunLighting(center.lat, center.lng);
    _frameStatsCache = new Map();
    let sig;
    try {
      renderTilesBatch(currentBatch.map(b => b.item), lighting);
      sig = computeLightSig(lighting);
    } finally { _frameStatsCache = null; }

    for (const b of currentBatch) {
      b.item.canvas._lightSig = sig;
      b.item.canvas._renderedFast = isSliderScrubbing;
      b.done(null, b.item.canvas);
    }
  }

  function requestFeatureMaskForTile(tile, coords) {
    if (!tile || tile._removed) return;
    if (!cfg.roadTintEnabled && !cfg.edgeTintEnabled) return;
    if (!WM.vectorRoads || typeof WM.vectorRoads.buildTerrainFeatureMask !== 'function') return;

    const typesKey = cfg.roadTintTypes || 'drive';
    if (tile._featMaskLoadingKey === typesKey) return;
    if (tile._featMaskData && tile._featMaskTypes === typesKey) return;

    tile._featMaskLoadingKey = typesKey;
    WM.vectorRoads.buildTerrainFeatureMask(coords, typesKey).then(maskRes => {
      if (tile._removed) return;
      tile._featMaskLoadingKey = null;
      if ((cfg.roadTintTypes || 'drive') !== typesKey) return;
      if (maskRes && maskRes.data) {
        tile._featMaskData = maskRes.data;
        tile._featMaskSize = maskRes.size || 128;
        tile._featMaskTypes = typesKey;
        if (tile._featMaskTex && sharedGl) {
          sharedGl.deleteTexture(tile._featMaskTex);
          tile._featMaskTex = null;
        }
        tile._lightSig = null;
        scheduleLiveHillshade();
      }
    }).catch(() => {
      if (!tile._removed) tile._featMaskLoadingKey = null;
    });
  }

  function refreshVisibleFeatureMasks(typesChanged = false) {
    if (!hillshadeLayerInstance || !hillshadeLayerInstance._tiles) return;
    const tiles = hillshadeLayerInstance._tiles;
    for (const key in tiles) {
      const entry = tiles[key];
      const el = entry?.el;
      if (!el || el._removed || !entry.coords) continue;
      if (typesChanged) {
        el._featMaskData = null;
        el._featMaskTypes = null;
        if (el._featMaskTex && sharedGl) {
          sharedGl.deleteTexture(el._featMaskTex);
          el._featMaskTex = null;
        }
      }
      requestFeatureMaskForTile(el, entry.coords);
    }
  }

  const WebGLHillshadeLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;

      const nwPoint = coords.scaleBy(this.getTileSize());
      const centerLatLng = this._map.unproject(nwPoint.add([128, 128]), coords.z);
      tile._demCoords = coords;
      tile._demLat = centerLatLng.lat;
      tile._demLng = centerLatLng.lng;

      tile._cleanup = () => {
        if (sharedGl && tile._glId === sharedGlId) {
          if (tile._demTex) { releaseTexture(sharedGl, tile._demTex, tile._demTexWidth); tile._demTex = null; }
          if (tile._gBuf) { releaseTexture(sharedGl, tile._gBuf, tile._gBufWidth); tile._gBuf = null; }
          if (tile._sBuf) { releaseTexture(sharedGl, tile._sBuf, tile._sBufWidth); tile._sBuf = null; }
          if (tile._waterMaskTex) { sharedGl.deleteTexture(tile._waterMaskTex); tile._waterMaskTex = null; }
          if (tile._featMaskTex) { sharedGl.deleteTexture(tile._featMaskTex); tile._featMaskTex = null; } tile._featMaskData = null;
        }
        tile._cachedDemImg = null;
        if (tile._demImg) {
          releasePaddedDem(tile._demImg);
          tile._demImg = null;
        }
        tile._waterMaskData = null;
        tile._bmpCtx = null;
      };
      requestFeatureMaskForTile(tile, coords);

      fetchWaterMaskTile(coords).then(maskData => {
        if (tile._removed) return;
        if (maskData) {
          _waterRetryAttempt = 0;
          tile._waterMaskData = maskData;
          tile._waterMaskFailed = !!maskData._isFallback;
          if (maskData._hasWater) {
            tile._lightSig = null;
            scheduleLiveHillshade();
          }
        } else {
          tile._waterMaskFailed = true;
          scheduleWaterMaskRetry();
        }
      }).catch(() => {
        if (!tile._removed) {
          tile._waterMaskFailed = true;
          scheduleWaterMaskRetry();
        }
      });

      loadPaddedDemTile(coords)
        .then(img => {
          if (tile._removed || (!tile.parentNode && this._tiles && !this._tiles[this._tileCoordsToKey(coords)])) {
            done(null, tile);
            return;
          }
          retainPaddedDem(img);
          tile._demImg = img;
          _incomingTileQueue.push({
            item: { img, lat: centerLatLng.lat, z: coords.z, canvas: tile, coords },
            done: done
          });
          if (!_incomingQueueRaf) {
            _incomingQueueRaf = requestAnimationFrame(flushIncomingTiles);
          }
        })
        .catch(() => {
          done(null, tile);
        });
      // =========================================================================



      return tile;
    },

    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile) {
        tile._removed = true;
        if (tile._cleanup) tile._cleanup();
        tile._cachedCtx2d = null;
        tile.width = 0;
        tile.height = 0;
      }
      L.GridLayer.prototype._removeTile.call(this, key);
    },
  });

  // Очередь с бюджетом времени (Time-Budgeted Scheduler) для изолиний
  let _incomingContourQueue = [];
  let _incomingContourRaf = 0;

  function flushIncomingContours() {
    _incomingContourRaf = 0;
    if (!_incomingContourQueue.length || !WM.map) return;

    const map = WM.map;
    const layerZoom = (contoursLayerInstance && typeof contoursLayerInstance._tileZoom === 'number')
      ? contoursLayerInstance._tileZoom
      : Math.min(Math.round(map.getZoom()), 16);
    const center = map.getCenter();

    const alive = [];
    for (let i = 0; i < _incomingContourQueue.length; i++) {
      const entry = _incomingContourQueue[i];
      if (entry.coords.z !== layerZoom || entry.tile._removed) {
        releasePaddedDem(entry.img);
        entry.done(null, entry.tile);
        continue;
      }
      if (contoursLayerInstance && contoursLayerInstance._tiles) {
        const key = contoursLayerInstance._tileCoordsToKey(entry.coords);
        if (!contoursLayerInstance._tiles[key]) {
          releasePaddedDem(entry.img);
          entry.done(null, entry.tile);
          continue;
        }
      }
      alive.push(entry);
    }

    if (!alive.length) {
      _incomingContourQueue = [];
      return;
    }

    // 2. Сортируем тайлы: сначала рендерится центр экрана
    alive.sort((a, b) => {
      const dya = a.centerLatLng.lat - center.lat, dxa = a.centerLatLng.lng - center.lng;
      const dyb = b.centerLatLng.lat - center.lat, dxb = b.centerLatLng.lng - center.lng;
      return (dxa * dxa + dya * dya) - (dxb * dxb + dyb * dyb);
    });

    // 3. Строго 1 тайл за кадр — гарантирует плавные 60 FPS
    const entry = alive.shift();
    _incomingContourQueue = alive;

    if (_incomingContourQueue.length > 0) {
      _incomingContourRaf = requestAnimationFrame(flushIncomingContours);
    }

    // Рендерим напрямую в холст тайла Leaflet
    try {
      renderTileContours(entry.img, entry.coords.z, entry.coords, entry.centerLatLng, entry.tile);
      entry.tile._contourRendered = true;
    } finally {
      releasePaddedDem(entry.img);
    }
    entry.done(null, entry.tile);
  }

  const DEMContoursLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;

      if (coords.z < 10) {
        setTimeout(() => done(null, tile), 0);
        return tile;
      }

      const nwPoint = coords.scaleBy(this.getTileSize());
      const centerLatLng = this._map.unproject(nwPoint.add([128, 128]), coords.z);

      loadPaddedDemTile(coords)
        .then(img => {
          if (tile._removed) { done(null, tile); return; }
          if (img._isEmptyFallback) {
            tile._contourRendered = !img._degraded;
            tile._demDegraded = !!img._degraded;
            if (img._degraded) scheduleDegradedRetry();
            done(null, tile);
            return;
          }
          if (!tile.parentNode && this._tiles && !this._tiles[this._tileCoordsToKey(coords)]) {
            done(null, tile);
            return;
          }
          retainPaddedDem(img);
          _incomingContourQueue.push({
            img, coords, centerLatLng, tile, done
          });
          if (!_incomingContourRaf) {
            _incomingContourRaf = requestAnimationFrame(flushIncomingContours);
          }
        })
        .catch(() => {
          done(null, tile);
        });

      return tile;
    },

    // Очистка при уходе тайла за пределы экрана
    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile) {
        tile._removed = true;
        tile.width = 0;
        tile.height = 0;
      }
      L.GridLayer.prototype._removeTile.call(this, key);
    }
  });

  let hillshadeLayerInstance = null;
  let contoursLayerInstance = null;
  let contoursRedrawTimer = null;
  let liveHillshadeRaf = 0;



  // =========================================================================
  // ИНТЕРАКТИВНЫЙ РЕЖИМ (ФЛАГ БЫСТРОГО СКРОЛЛИНГА)
  // =========================================================================
  let isSliderScrubbing = false;
  let scrubEndTimer = null;

  function markSliderScrubbing() {
    isSliderScrubbing = true;
    clearTimeout(scrubEndTimer);
    scrubEndTimer = setTimeout(() => {
      isSliderScrubbing = false;
      scheduleLiveHillshade(); // Дорисовать финальный четкий кадр (14 шагов)
    }, 120);
  }

  let isHillshadeRendering = false;

  // ── подпись освещения: тайл перерисовывается только если она изменилась ──
  function computeLightSig(lighting) {
    const q = (v, k) => Math.round((v || 0) * k);
    const a3 = (v, k) => v ? q(v[0], k) + ',' + q(v[1], k) + ',' + q(v[2], k) : '';
    const z = (hillshadeLayerInstance && WM.map && WM.map.hasLayer(hillshadeLayerInstance) && typeof hillshadeLayerInstance._tileZoom === 'number')
      ? hillshadeLayerInstance._tileZoom
      : (WM.map ? Math.round(WM.map.getZoom()) : 0);
    const isFixedManual = (cfg.sunMode === 'manual' && cfg.manualScaleMode === 'fixed');
    const vs = isFixedManual
      ? {
          minH: Number(cfg.manualElevMin) || 0,
          span: Math.max(1, (Number(cfg.manualElevMax) || 1500) - (Number(cfg.manualElevMin) || 0))
        }
      : getViewportElevationStats(z);

    const usesRelElev = !isFixedManual && (
      cfg.sunMode === 'manual' ||
      (lighting.twilightAmt || 0) > 0.001 ||
      Math.abs((cfg.lightBoost !== undefined ? cfg.lightBoost : 1.0) - 1.0) > 0.001 ||
      (cfg.ditherEnabled && cfg.ditherType === 'woodcut') ||
      cfg.outlineEnabled ||
      (lighting.hazeStrength || 0) > 0.001
    );
    const step = Math.max(4, vs.span * 0.05); // допуск 5% диапазона высот (мин. 4 м)
    return [
      cfgRev, globalGeomVersion, getEffectiveZFactor(),
      a3(lighting.sunVec, 1000), q(lighting.sunIntensity, 1000),
      a3(lighting.lightColor, 500), a3(lighting.shadowColor, 500), a3(lighting.skyColor, 500),
      a3(lighting.valleyColor, 500), a3(lighting.glowColor, 500),
      q(lighting.twilightClimb, 500), q(lighting.twilightAmt, 500),
      q(lighting.afterglow, 500), q(lighting.alpenglowWeight, 500),
      q(lighting.shadowMul !== undefined ? lighting.shadowMul : 1, 500),
      q(lighting.dayGlowStrength, 500), q(lighting.hazeStrength, 500),
      usesRelElev ? Math.round(vs.minH / step) : 0,
      usesRelElev ? Math.round(vs.span / step) : 0
    ].join('|');
  }

  let _lastLiveCfgRev = -1;

  function updateLiveHillshade() {
    if (isPeakViewForeground()) return;
    if (!hillshadeLayerInstance || !WM.map || !cfg.hillshadeEnabled) return;
    WM.perf.beginFrame();

    const tiles = hillshadeLayerInstance._tiles;
    if (!tiles) { WM.perf.endFrame(); return; }

    const map = WM.map;
    const center = map.getCenter();
    const lighting = getSunLighting(center.lat, center.lng);
    const bounds = map.getBounds();
    const tileSize = hillshadeLayerInstance.getTileSize();
    WM.perf.markCpuCalcEnd();

    _frameStatsCache = new Map();
    let more = false;
    try {
      const curZoom = (typeof hillshadeLayerInstance._tileZoom === 'number')
        ? hillshadeLayerInstance._tileZoom
        : Math.min(Math.round(map.getZoom()), 16);
      const sig = computeLightSig(lighting);
      const interactive = (cfgRev !== _lastLiveCfgRev);   // менялись настройки/время → обновляем всё сразу
      const dirty = [];

      for (const key in tiles) {
        const tileEntry = tiles[key];
        const el = tileEntry ? tileEntry.el : null;
        if (!el || !el._demImg || !el._demCoords || el._removed) continue;
        if (el._demImg._isEmptyFallback || el._isEmptyFallback) continue;

        let tileBounds = el._demLLB;
        if (!tileBounds) {
          const nwPt = tileEntry.coords.scaleBy(tileSize);
          const sePt = nwPt.add(tileSize);
          tileBounds = L.latLngBounds(
            map.unproject(nwPt, tileEntry.coords.z),
            map.unproject(sePt, tileEntry.coords.z)
          );
          el._demLLB = tileBounds;
        }

        if (!bounds.intersects(tileBounds)) { el._demNeedsRedraw = true; continue; }
        el._demNeedsRedraw = false;

        if (el._lightSig === sig && !el._renderedFast) continue;   // уже актуален

        const dy = (el._demLat || center.lat) - center.lat;
        const dx = (el._demLng || center.lng) - center.lng;
        dirty.push({ el, d: dx * dx + dy * dy });
      }

      dirty.sort((a, b) => a.d - b.d);                  // от центра экрана к краям
      const limit = interactive ? dirty.length : 3;     // без смены настроек — по 3 тайла за кадр
      const part = dirty.slice(0, limit);
      more = dirty.length > limit;

      renderTilesBatch(part.map(({ el }) => ({
        img: el._demImg, lat: el._demLat || center.lat,
        z: el._demCoords.z, canvas: el, coords: el._demCoords
      })), lighting);

      for (const { el } of part) { el._lightSig = sig; el._renderedFast = isSliderScrubbing; }
      if (interactive) _lastLiveCfgRev = cfgRev;
    } finally {
      _frameStatsCache = null;
      WM.perf.endFrame();
    }
    if (more) scheduleLiveHillshade();
  }

  let canopyRedrawTimer = null;
  function scheduleLiveHillshade(bump) {
    if (bump) cfgRev++;
    if (isPeakViewForeground()) return;
    if (liveHillshadeRaf) return;
    liveHillshadeRaf = requestAnimationFrame(() => {
      liveHillshadeRaf = 0;
      if (isHillshadeRendering) { scheduleLiveHillshade(); return; }
      isHillshadeRendering = true;
      try { 
        updateLiveHillshade(); 
      } finally { 
        isHillshadeRendering = false; 
      }
    });
  }
  function applyLayerVisibility() {
    if (!WM.map) return;
    const map = WM.map;

    if (hillshadeLayerInstance) {
      if (cfg.hillshadeEnabled) {
        if (!map.hasLayer(hillshadeLayerInstance)) map.addLayer(hillshadeLayerInstance);
      } else {
        if (map.hasLayer(hillshadeLayerInstance)) map.removeLayer(hillshadeLayerInstance);
      }
    }

    if (contoursLayerInstance) {
      if (cfg.contoursEnabled) {
        if (!map.hasLayer(contoursLayerInstance)) map.addLayer(contoursLayerInstance);
      } else {
        if (map.hasLayer(contoursLayerInstance)) map.removeLayer(contoursLayerInstance);
      }
    }
    notifyDemChange(true);
  }

  function applyBlendModeToPane(mapInstance) {
    const m = mapInstance || WM.map;
    if (!m) return;
    const hsPane = m.getPane('wm-dem-hillshade-pane');
    if (hsPane) {
      hsPane.style.mixBlendMode = cfg.blendMode || 'normal';
    }
    const ctPane = m.getPane('wm-dem-contours-pane');
    if (ctPane) {
      ctPane.style.mixBlendMode = cfg.contourBlendMode || 'normal';
    }
  }

  // =========================================================================
  // ПЛАВАЮЩИЙ HUD ДЛЯ НАСТРОЙКИ С КАРТЫ
  // =========================================================================
  let isHudOpen = false;
  let activeTab = 'light';
  let hudRenderRaf = 0;
  function scheduleHudRender() {
    if (!isHudOpen || hudRenderRaf) return;
    hudRenderRaf = requestAnimationFrame(() => {
      hudRenderRaf = 0;
      renderHudUI();
    });
  }

  function formatHourString(hourVal, lat, lng, date) {
    const totalMinutes = Math.round(hourVal * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    if (WM.timeWarp && lat !== undefined && lng !== undefined) {
      const events = WM.timeWarp.getSunEvents(lat, lng, date);
      if (events.valid) {
        if (Math.abs(hourVal - events.set) < 0.45) return `${timeStr} 🌇 Закат`;
        if (Math.abs(hourVal - events.rise) < 0.45) return `${timeStr} 🌅 Восход`;
        if (hourVal > events.rise && hourVal < events.set) return `${timeStr} ☀️ День`;
        return `${timeStr} 🌙 Ночь`;
      }
    }
    return timeStr;
  }

  function updateManualGradientPreview() {
    const bar = document.getElementById('dem-hud-manual-gradient-bar');
    if (!bar) return;

    const cV = hexToVec3(cfg.manualValleyColor || '#a8863e');
    const cM = hexToVec3(cfg.manualMidColor || '#e8b074');
    const cP = hexToVec3(cfg.manualPeakColor || '#fe1691');

    const b1 = cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.33;
    const hw1 = Math.max(0.01, (cfg.manualLightSoftness !== undefined ? cfg.manualLightSoftness : 0.35) * 0.5);
    const b2 = Math.max(b1, cfg.manualLightBlend2 !== undefined ? cfg.manualLightBlend2 : 0.68);
    const hw2 = Math.max(0.01, (cfg.manualLightSoftness2 !== undefined ? cfg.manualLightSoftness2 : 0.35) * 0.5);

    const isFixed = (cfg.manualScaleMode === 'fixed');
    const minLbl = document.getElementById('dem-hud-manual-scale-min-lbl');
    const maxLbl = document.getElementById('dem-hud-manual-scale-max-lbl');
    const minM = cfg.manualElevMin !== undefined ? Number(cfg.manualElevMin) : 0;
    const maxM = Math.max(minM + 1, cfg.manualElevMax !== undefined ? Number(cfg.manualElevMax) : 1500);

    if (minLbl) minLbl.textContent = isFixed ? `${Math.round(minM)} м` : 'Низ (0%)';
    if (maxLbl) maxLbl.textContent = isFixed ? `${Math.round(maxM)} м` : 'Верх (100%)';
    const stops = [];
    for (let i = 0; i <= 20; i++) {
      const h = i / 20;
      const t1 = smoothstep(b1 - hw1, b1 + hw1, h);
      const t2 = smoothstep(b2 - hw2, b2 + hw2, h);
      const col = lerpVec3(lerpVec3(cV, cM, t1), cP, t2);
      const r = Math.round(col[0] * 255);
      const g = Math.round(col[1] * 255);
      const b = Math.round(col[2] * 255);
      stops.push(`rgb(${r},${g},${b}) ${i * 5}%`);
    }
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;

    const pin1 = document.getElementById('dem-hud-manual-pin1');
    const pin2 = document.getElementById('dem-hud-manual-pin2');
    if (pin1) pin1.style.left = Math.round(b1 * 100) + '%';
    if (pin2) pin2.style.left = Math.round(b2 * 100) + '%';
  }

  // Бейджи, чей текст формируется специально (не просто «Вкл»/«Выкл»)
  const CUSTOM_TEXT_BADGES = new Set([
    'dem-hud-slice3d-status-badge',
    'dem-hud-canopy-status-badge',
    'dem-hud-feat-tint-status-badge',
    'dem-hud-canopy-clear-status-badge'
  ]);

  function syncSpoilerQuickToggles() {
    const hud = document.getElementById('dem-relief-hud');
    if (!hud) return;

    hud.querySelectorAll('.js-hud-spoiler-toggle, .js-hud-tools-toggle').forEach(btn => {
      let isActive = false;

      if (btn.dataset.syncCheckbox) {
        const chk = document.getElementById(btn.dataset.syncCheckbox);
        isActive = !!(chk && chk.checked);
      } else if (btn.dataset.syncRoads === 'true') {
        isActive = (WM.vectorRoads && WM.vectorRoads.isEnabled)
          ? !!WM.vectorRoads.isEnabled()
          : !!document.getElementById('dem-hud-toggle-roads')?.classList.contains('active');
      } else if (btn.dataset.syncBtn) {
        const targetId = btn.dataset.syncBtn;
        if (targetId === 'btn-slice3d-toggle-hud') {
          isActive = !!(WM.slice3d && WM.slice3d.isOpen && WM.slice3d.isOpen());
        } else if (targetId === 'dem-hud-toggle-trees') {
          isActive = !!(WM.canopy && WM.canopy.getSettings().treesEnabled);
        } else if (targetId === 'dem-hud-toggle-ct') {
          isActive = !!cfg.contoursEnabled;
        } else {
          const targetBtn = document.getElementById(targetId);
          isActive = !!(targetBtn && targetBtn.classList.contains('active'));
        }
      }

      btn.textContent = isActive ? 'Выкл' : 'Вкл';
      btn.classList.toggle('active', isActive);

      const badgeId = btn.dataset.syncBadge;
      const badge = badgeId
        ? document.getElementById(badgeId)
        : btn.closest('summary')?.querySelector('.dem-hud-badge-mini');

      if (badge && !CUSTOM_TEXT_BADGES.has(badge.id)) {
        badge.textContent = isActive ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', isActive);
      }
    });
  }
  window.syncDemSpoilerQuickToggles = syncSpoilerQuickToggles;

  function renderHudUI() {
    if (!isHudOpen) return;

    const hud = document.getElementById('dem-relief-hud');
    if (!hud) return;

    const btnHs = document.getElementById('dem-hud-toggle-hs');
    const btnCt = document.getElementById('dem-hud-toggle-ct');
    const btnTrees = document.getElementById('dem-hud-toggle-trees');
    const btnRoads = document.getElementById('dem-hud-toggle-roads');
    const btnCl = document.getElementById('dem-hud-toggle-cl');

    if (btnHs) btnHs.classList.toggle('active', !!cfg.hillshadeEnabled);
    if (btnCt) btnCt.classList.toggle('active', !!cfg.contoursEnabled);
    if (btnTrees && WM.canopy) btnTrees.classList.toggle('active', !!WM.canopy.getSettings().treesEnabled);
    if (btnRoads && WM.vectorRoads) btnRoads.classList.toggle('active', !!WM.vectorRoads.isEnabled());
    if (btnCl && WM.clouds) btnCl.classList.toggle('active', !!WM.clouds.isEnabled());

    document.getElementById('dem-hud-switches')?._updateScrollArrows?.();



    if (WM.terrainOverlays && WM.terrainOverlays.refreshUI) {
      WM.terrainOverlays.refreshUI();
    }

    hud.querySelectorAll('.dem-hud-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });

    if (WM.vectorRoads && WM.vectorRoads.syncUI) {
      WM.vectorRoads.syncUI();
    }

    if (WM.slice3d) {
      const isSliceActive = WM.slice3d.isOpen && WM.slice3d.isOpen();
      const badgeSlice = document.getElementById('dem-hud-slice3d-status-badge');
      if (badgeSlice) {
        badgeSlice.textContent = isSliceActive ? 'Открыт' : 'Закрыт';
        badgeSlice.classList.toggle('active', isSliceActive);
      }
      const btnSliceToggle = document.getElementById('btn-slice3d-toggle-hud');
      if (btnSliceToggle) {
        btnSliceToggle.textContent = isSliceActive ? '✕ Закрыть 3D-срез' : '🧊 Открыть 3D-срез местности';
        btnSliceToggle.classList.toggle('active', isSliceActive);
      }
    }

    const bodyLight = document.getElementById('dem-hud-body-light');
    const bodyTerrain = document.getElementById('dem-hud-body-terrain');
    const bodyTools = document.getElementById('dem-hud-body-tools');
    if (bodyLight) bodyLight.hidden = (activeTab !== 'light');
    if (bodyTerrain) bodyTerrain.hidden = (activeTab !== 'terrain');
    if (bodyTools) bodyTools.hidden = (activeTab !== 'tools');

    

    // Мини-бейдж включённых изолиний во вкладке Рельеф
    const ctBadge = document.getElementById('dem-hud-ct-status-badge');
    if (ctBadge) {
      ctBadge.textContent = cfg.contoursEnabled ? 'Вкл' : 'Выкл';
      ctBadge.classList.toggle('active', !!cfg.contoursEnabled);
    }

    const chkWaterTint = document.getElementById('dem-hud-toggle-water-tint');
    if (chkWaterTint) chkWaterTint.checked = !!cfg.waterTintEnabled;

    const subWaterTint = document.getElementById('dem-hud-water-tint-sub');
    if (subWaterTint) subWaterTint.classList.toggle('is-disabled', !cfg.waterTintEnabled);

    const badgeWaterTint = document.getElementById('dem-hud-water-fill-status-badge');
    if (badgeWaterTint) {
      badgeWaterTint.textContent = cfg.waterTintEnabled ? 'Вкл' : 'Выкл';
      badgeWaterTint.classList.toggle('active', !!cfg.waterTintEnabled);
    }


    const colWaterTint = document.getElementById('dem-hud-water-tint-color');
    if (colWaterTint) colWaterTint.value = cfg.waterTintColor || '#2a4d69';

    const selWaterTintBlend = document.getElementById('dem-hud-water-tint-blend');
    if (selWaterTintBlend) selWaterTintBlend.value = cfg.waterTintBlendMode || 'multiply';


    const sldWaterCov = document.getElementById('dem-hud-water-tint-coverage-slider');
    const valWaterCov = document.getElementById('dem-hud-water-tint-coverage-val');
    if (sldWaterCov && valWaterCov) {
      const covPct = Math.round((cfg.waterTintCoverage !== undefined ? cfg.waterTintCoverage : 1.0) * 100);
      sldWaterCov.value = covPct;
      valWaterCov.textContent = covPct + '%';
    }
    // --- Дизеринг ---
    const chkDither = document.getElementById('dem-hud-toggle-dither');
    if (chkDither) chkDither.checked = !!cfg.ditherEnabled;

    const subDither = document.getElementById('dem-hud-dither-sub');
    if (subDither) {
      subDither.classList.toggle('is-disabled', !cfg.ditherEnabled);
    }

    // Штриховка: видимость блока гибридного режима и слайдеры
    const isHybridHach = (cfg.hachureType === 'hybrid');
    const wrapHyb = document.getElementById('dem-hud-hachure-hybrid-wrap');
    if (wrapHyb) wrapHyb.hidden = !isHybridHach;

    const sldHybT = document.getElementById('dem-hud-hachure-hyb-thresh-slider');
    const valHybT = document.getElementById('dem-hud-hachure-hyb-thresh-val');
    if (sldHybT && valHybT) {
      const degVal = Math.round((cfg.hachureHybridThresh || 0.15) * 100);
      sldHybT.value = degVal;
      valHybT.textContent = degVal + '°';
    }

    const sldHybS = document.getElementById('dem-hud-hachure-hyb-sharp-slider');
    const valHybS = document.getElementById('dem-hud-hachure-hyb-sharp-val');
    if (sldHybS && valHybS) {
      const shPct = Math.round((cfg.hachureHybridSharpness !== undefined ? cfg.hachureHybridSharpness : 0.50) * 100);
      sldHybS.value = shPct;
      valHybS.textContent = shPct + '%';
    }

    const sldHachLen = document.getElementById('dem-hud-hachure-len-slider');
    const valHachLen = document.getElementById('dem-hud-hachure-len-val');
    if (sldHachLen && valHachLen) {
      sldHachLen.value = cfg.hachureLength !== undefined ? cfg.hachureLength : 1.0;
      valHachLen.textContent = '×' + parseFloat(sldHachLen.value).toFixed(1);
    }

    // Обводка: густота и текстура графита
    const sldOutDensity = document.getElementById('dem-hud-outline-density-slider');
    const valOutDensity = document.getElementById('dem-hud-outline-density-val');
    if (sldOutDensity && valOutDensity) {
      const v = Math.round((cfg.outlineDensity !== undefined ? cfg.outlineDensity : 0.65) * 100);
      sldOutDensity.value = v;
      valOutDensity.textContent = v + '%';
    }

    const sldOutTex = document.getElementById('dem-hud-outline-texture-slider');
    const valOutTex = document.getElementById('dem-hud-outline-texture-val');
    if (sldOutTex && valOutTex) {
      const v = Math.round((cfg.outlineTexture !== undefined ? cfg.outlineTexture : 0.60) * 100);
      sldOutTex.value = v;
      valOutTex.textContent = v + '%';
    }

    // Внутри renderHudUI() в секции "if (WM.canopy) { ... }":

    if (WM.canopy) {
      const cSettings = WM.canopy.getSettings();

      // Очистка дорог от растительности (теперь cSettings доступна)
      const roadsClearOn = cSettings.treeClearRoads !== false;
      const riversClearOn = cSettings.treeClearRivers !== false;

      const badgeClear = document.getElementById('dem-hud-canopy-clear-status-badge');
      if (badgeClear) {
        badgeClear.textContent = (roadsClearOn && riversClearOn) ? 'Все' : (roadsClearOn ? 'Дороги' : (riversClearOn ? 'Реки' : 'Выкл'));
        badgeClear.classList.toggle('active', roadsClearOn || riversClearOn);
      }

      const chkClearRoads = document.getElementById('toggle-hud-canopy-clear-roads');
      if (chkClearRoads) chkClearRoads.checked = roadsClearOn;
      document.getElementById('dem-hud-canopy-clear-roads-sub')?.classList.toggle('is-disabled', !roadsClearOn);

      const sldClearRoads = document.getElementById('dem-hud-canopy-clear-roads-slider');
      const valClearRoads = document.getElementById('dem-hud-canopy-clear-roads-val');
      if (sldClearRoads && valClearRoads) {
        sldClearRoads.value = cSettings.treeClearRoadsDist || 1.0;
        valClearRoads.textContent = '×' + parseFloat(sldClearRoads.value).toFixed(1);
      }

      const sldClearRoadsOp = document.getElementById('dem-hud-canopy-clear-roads-opacity-slider');
      const valClearRoadsOp = document.getElementById('dem-hud-canopy-clear-roads-opacity-val');
      if (sldClearRoadsOp && valClearRoadsOp) {
        const pct = Math.round((cSettings.treeClearRoadsOpacity !== undefined ? cSettings.treeClearRoadsOpacity : 1.0) * 100);
        sldClearRoadsOp.value = pct;
        valClearRoadsOp.textContent = pct + '%';
      }

      const sldClearRoadsSoft = document.getElementById('dem-hud-canopy-clear-roads-soft-slider');
      const valClearRoadsSoft = document.getElementById('dem-hud-canopy-clear-roads-soft-val');
      if (sldClearRoadsSoft && valClearRoadsSoft) {
        const pct = Math.round((cSettings.treeClearRoadsSoftness !== undefined ? cSettings.treeClearRoadsSoftness : 0.35) * 100);
        sldClearRoadsSoft.value = pct;
        valClearRoadsSoft.textContent = pct + '%';
      }

      const chkClearRivers = document.getElementById('toggle-hud-canopy-clear-rivers');
      if (chkClearRivers) chkClearRivers.checked = riversClearOn;
      document.getElementById('dem-hud-canopy-clear-rivers-sub')?.classList.toggle('is-disabled', !riversClearOn);

      const sldClearRivers = document.getElementById('dem-hud-canopy-clear-rivers-slider');
      const valClearRivers = document.getElementById('dem-hud-canopy-clear-rivers-val');
      if (sldClearRivers && valClearRivers) {
        sldClearRivers.value = cSettings.treeClearRiversDist || 1.0;
        valClearRivers.textContent = '×' + parseFloat(sldClearRivers.value).toFixed(1);
      }

      const sldClearRiversOp = document.getElementById('dem-hud-canopy-clear-rivers-opacity-slider');
      const valClearRiversOp = document.getElementById('dem-hud-canopy-clear-rivers-opacity-val');
      if (sldClearRiversOp && valClearRiversOp) {
        const pct = Math.round((cSettings.treeClearRiversOpacity !== undefined ? cSettings.treeClearRiversOpacity : 1.0) * 100);
        sldClearRiversOp.value = pct;
        valClearRiversOp.textContent = pct + '%';
      }

      const sldClearRiversSoft = document.getElementById('dem-hud-canopy-clear-rivers-soft-slider');
      const valClearRiversSoft = document.getElementById('dem-hud-canopy-clear-rivers-soft-val');
      if (sldClearRiversSoft && valClearRiversSoft) {
        const pct = Math.round((cSettings.treeClearRiversSoftness !== undefined ? cSettings.treeClearRiversSoftness : 0.35) * 100);
        sldClearRiversSoft.value = pct;
        valClearRiversSoft.textContent = pct + '%';
      }

      const sldHOp = document.getElementById('dem-hud-canopy-height-opacity');
      const valHOp = document.getElementById('dem-hud-canopy-height-opacity-val');
      if (sldHOp && valHOp) {
        const pct = Math.round((cSettings.heightOpacity || 0.75) * 100);
        sldHOp.value = pct;
        valHOp.textContent = pct + '%';
      }

      const sldMOp = document.getElementById('dem-hud-canopy-mask-opacity');
      const valMOp = document.getElementById('dem-hud-canopy-mask-opacity-val');
      if (sldMOp && valMOp) {
        const pct = Math.round((cSettings.maskOpacity || 0.85) * 100);
        sldMOp.value = pct;
        valMOp.textContent = pct + '%';
      }

      const selTint = document.getElementById('dem-hud-canopy-tint');
      if (selTint) selTint.value = cSettings.maskTint || 'emerald';

      const selCBlend = document.getElementById('dem-hud-canopy-blend');
      if (selCBlend) selCBlend.value = cSettings.blendMode || 'normal';

      const chkCustomC = document.getElementById('toggle-hud-canopy-custom-colors');
      const subCustomC = document.getElementById('dem-hud-canopy-colors-sub');
      if (chkCustomC) chkCustomC.checked = !!cSettings.customColors;
      if (subCustomC) subCustomC.classList.toggle('is-disabled', !cSettings.customColors);

      const colD1 = document.getElementById('dem-hud-canopy-decid-color1');
      if (colD1) colD1.value = cSettings.decidColor1 || '#7fa361';
      const colD2 = document.getElementById('dem-hud-canopy-decid-color2');
      if (colD2) colD2.value = cSettings.decidColor2 || '#b89e58';
      const colCon = document.getElementById('dem-hud-canopy-conifer-color');
      if (colCon) colCon.value = cSettings.coniferColor || '#264e36';

      const sldDRatio = document.getElementById('dem-hud-canopy-decid-ratio-slider');
      const valDRatio = document.getElementById('dem-hud-canopy-decid-ratio-val');
      if (sldDRatio && valDRatio) {
        const pct = Math.round((cSettings.decidRatio !== undefined ? cSettings.decidRatio : 0.5) * 100);
        sldDRatio.value = pct;
        valDRatio.textContent = pct + '%';
      }

      const sldScat = document.getElementById('dem-hud-canopy-scatter-slider');
      const valScat = document.getElementById('dem-hud-canopy-scatter-val');
      if (sldScat && valScat) {
        const pct = Math.round((cSettings.colorScatter !== undefined ? cSettings.colorScatter : 0.25) * 100);
        sldScat.value = pct;
        valScat.textContent = pct + '%';
      }



      const chkH = document.getElementById('toggle-hud-canopy-height');
      const chkM = document.getElementById('toggle-hud-canopy-mask');
      const chkT = document.getElementById('toggle-hud-canopy-trees');
      if (chkH) chkH.checked = !!cSettings.heightEnabled;
      if (chkM) chkM.checked = !!cSettings.maskEnabled;
      if (chkT) chkT.checked = !!cSettings.treesEnabled;

      const subTrees = document.getElementById('dem-hud-canopy-trees-sub');
      if (subTrees) subTrees.hidden = !cSettings.treesEnabled;

      const badgeCanopy = document.getElementById('dem-hud-canopy-status-badge');
      if (badgeCanopy) {
        const isAnyOn = cSettings.heightEnabled || cSettings.maskEnabled || cSettings.treesEnabled;
        let badgeText = 'Выкл';
        if (cSettings.treesEnabled) badgeText = '🌲 Деревья';
        else if (cSettings.heightEnabled && cSettings.maskEnabled) badgeText = 'Все';
        else if (cSettings.maskEnabled) badgeText = 'Маска';
        else if (cSettings.heightEnabled) badgeText = 'Высота';

        badgeCanopy.textContent = badgeText;
        badgeCanopy.classList.toggle('active', isAnyOn);
      }

      // Объёмность деревьев
      const sldVol = document.getElementById('dem-hud-canopy-tree-volumetric-slider');
      const valVol = document.getElementById('dem-hud-canopy-tree-volumetric-val');
      if (sldVol && valVol) {
        const pct = Math.round((cSettings.treeVolumetric !== undefined ? cSettings.treeVolumetric : 1.0) * 100);
        sldVol.value = pct;
        valVol.textContent = pct === 0 ? 'Плоские (0%)' : pct + '%';
      }

      // Цвет обводки и контуров
      const colStroke = document.getElementById('dem-hud-canopy-tree-stroke-color');
      if (colStroke) {
        colStroke.value = cSettings.treeStrokeColor || cSettings.treeColor || '#1c1917';
      }

      // Проникание в холст (впитывание туши)
      const sldBleed = document.getElementById('dem-hud-canopy-paper-bleed-slider');
      const valBleed = document.getElementById('dem-hud-canopy-paper-bleed-val');
      if (sldBleed && valBleed) {
        const pct = Math.round((cSettings.treePaperBleed !== undefined ? cSettings.treePaperBleed : 0.35) * 100);
        sldBleed.value = pct;
        valBleed.textContent = pct === 0 ? 'Выкл (0%)' : pct + '%';
      }
    const sldNBright = document.getElementById('dem-hud-canopy-night-bright-slider');
      const valNBright = document.getElementById('dem-hud-canopy-night-bright-val');
      if (sldNBright && valNBright) {
        sldNBright.value = cSettings.treeNightBrightness !== undefined ? cSettings.treeNightBrightness : 1.0;
        valNBright.textContent = '×' + parseFloat(sldNBright.value).toFixed(2);
      }

      const sldNContrast = document.getElementById('dem-hud-canopy-night-contrast-slider');
      const valNContrast = document.getElementById('dem-hud-canopy-night-contrast-val');
      if (sldNContrast && valNContrast) {
        sldNContrast.value = cSettings.treeNightContrast !== undefined ? cSettings.treeNightContrast : 1.0;
        valNContrast.textContent = '×' + parseFloat(sldNContrast.value).toFixed(2);
      }

      // Раздельный авторазмер: Опушки / Одиночные
      const sldEdgeSc = document.getElementById('dem-hud-canopy-edge-scale-slider');
      const valEdgeSc = document.getElementById('dem-hud-canopy-edge-scale-val');
      if (sldEdgeSc && valEdgeSc) {
        sldEdgeSc.value = cSettings.treeEdgeScale !== undefined ? cSettings.treeEdgeScale : 1.0;
        valEdgeSc.textContent = '×' + parseFloat(sldEdgeSc.value).toFixed(2);
      }

      // Раздельный авторазмер: Центр скоплений
      const sldMassifSc = document.getElementById('dem-hud-canopy-massif-scale-slider');
      const valMassifSc = document.getElementById('dem-hud-canopy-massif-scale-val');
      if (sldMassifSc && valMassifSc) {
        sldMassifSc.value = cSettings.treeMassifScale !== undefined ? cSettings.treeMassifScale : 1.55;
        valMassifSc.textContent = '×' + parseFloat(sldMassifSc.value).toFixed(2);
      }

      // Заливка деревьев
      const chkOpaque = document.getElementById('toggle-hud-canopy-opaque-fill');
      if (chkOpaque) chkOpaque.checked = cSettings.treeOpaqueFill === true;

      const subOpaque = document.getElementById('dem-hud-canopy-opaque-sub');
      if (subOpaque) subOpaque.classList.remove('is-disabled');

      const sldWarmth = document.getElementById('dem-hud-canopy-fill-warmth-slider');
      const valWarmth = document.getElementById('dem-hud-canopy-fill-warmth-val');
      if (sldWarmth && valWarmth) {
        const pct = Math.round((cSettings.treeFillWarmth !== undefined ? cSettings.treeFillWarmth : 0.5) * 100);
        sldWarmth.value = pct;
        valWarmth.textContent = pct + '%';
      }

      const sldBright = document.getElementById('dem-hud-canopy-fill-bright-slider');
      const valBright = document.getElementById('dem-hud-canopy-fill-bright-val');
      if (sldBright && valBright) {
        const pct = Math.round((cSettings.treeFillBrightness !== undefined ? cSettings.treeFillBrightness : 0.85) * 100);
        sldBright.value = pct;
        valBright.textContent = pct + '%';
      }

      const sldSat = document.getElementById('dem-hud-canopy-fill-sat-slider');
      const valSat = document.getElementById('dem-hud-canopy-fill-sat-val');
      if (sldSat && valSat) {
        const pct = Math.round((cSettings.treeFillSaturation !== undefined ? cSettings.treeFillSaturation : 0.6) * 100);
        sldSat.value = pct;
        valSat.textContent = pct + '%';
      }

      // Глушение на склонах
      const sldSlopeSupp = document.getElementById('dem-hud-canopy-slope-suppress-slider');
      const valSlopeSupp = document.getElementById('dem-hud-canopy-slope-suppress-val');
      if (sldSlopeSupp && valSlopeSupp) {
        const pct = Math.round((cSettings.treeSlopeSuppression || 0.0) * 100);
        sldSlopeSupp.value = pct;
        valSlopeSupp.textContent = pct === 0 ? '0% (Выкл)' : pct + '%';
      }

      const sldSlopeTol = document.getElementById('dem-hud-canopy-slope-tol-slider');
      const valSlopeTol = document.getElementById('dem-hud-canopy-slope-tol-val');
      if (sldSlopeTol && valSlopeTol) {
        const raw = Math.round((cSettings.treeSlopeTolerance !== undefined ? cSettings.treeSlopeTolerance : 0.25) * 100);
        sldSlopeTol.value = raw;
        const deg = Math.round(Math.atan(raw / 100) * 180 / Math.PI);
        valSlopeTol.textContent = `~${deg}° (${(raw / 100).toFixed(2)})`;
      }

      const chkAutoDense = document.getElementById('toggle-hud-canopy-tree-autodense');
      if (chkAutoDense) chkAutoDense.checked = cSettings.treeAutoDense !== false;

      const subAutoDense = document.getElementById('dem-hud-canopy-autodense-sub');
      if (subAutoDense) subAutoDense.classList.toggle('is-disabled', cSettings.treeAutoDense === false);

      const sldAutoDenseScale = document.getElementById('dem-hud-canopy-autodense-scale-slider');
      const valAutoDenseScale = document.getElementById('dem-hud-canopy-autodense-scale-val');
      if (sldAutoDenseScale && valAutoDenseScale) {
        sldAutoDenseScale.value = cSettings.treeAutoDenseScale || 1.55;
        valAutoDenseScale.textContent = '×' + parseFloat(sldAutoDenseScale.value).toFixed(2);
      }

      const chkFantasy = document.getElementById('toggle-hud-canopy-fantasy-forest');
      if (chkFantasy && WM.canopy) {
        chkFantasy.checked = WM.canopy.getSettings().canopyFantasyForest === true;
      }

      const sldAutoDenseThin = document.getElementById('dem-hud-canopy-autodense-thin-slider');
      const valAutoDenseThin = document.getElementById('dem-hud-canopy-autodense-thin-val');
      if (sldAutoDenseThin && valAutoDenseThin) {
        const pct = Math.round((cSettings.treeAutoDenseThinning !== undefined ? cSettings.treeAutoDenseThinning : 0.50) * 100);
        sldAutoDenseThin.value = pct;
        valAutoDenseThin.textContent = pct + '%';
      }


      const selStyle = document.getElementById('dem-hud-canopy-tree-style');
      const realHint = document.getElementById('dem-hud-canopy-real-hint');
      if (selStyle) {
        selStyle.value = cSettings.treeStyle || 'mixed';
        if (realHint) {
          if (selStyle.value !== 'real') {
            realHint.hidden = true;
          } else {
            realHint.hidden = false;
            const spStatus = WM.canopy && WM.canopy.getSpeciesStatus ? WM.canopy.getSpeciesStatus() : 'fallback';
            if (spStatus === 'loaded') {
              realHint.style.color = '#10b981'; // Зелёный
              realHint.innerHTML = '✅ Данные пород леса (GLC_FCS30D 30м) успешно загружены и применены.';
            } else if (spStatus === 'loading') {
              realHint.style.color = '#38bdf8'; // Голубой
              realHint.innerHTML = '⏳ Загрузка пород леса (GLC_FCS30D 30м)…';
            } else {
              realHint.style.color = '#eab308'; // Жёлтый
              realHint.innerHTML = '⚠️ Данные пород (GLC_FCS30D 30м) могут быть недоступны в некоторых регионах или при сбоях сервиса. В этом случае используется процедурное распределение с автодогрузкой.';
            }
          }
        }
      }

      const selColor = document.getElementById('dem-hud-canopy-tree-color');
      if (selColor) selColor.value = cSettings.treeColor || '#1c1917';

      const selTreeBlend = document.getElementById('dem-hud-canopy-tree-blend');
      if (selTreeBlend) selTreeBlend.value = cSettings.treeBlendMode || 'multiply';

      const selMinH = document.getElementById('dem-hud-canopy-min-height');
      if (selMinH) selMinH.value = Math.round(cSettings.treeMinH || 4).toString();

      const sldForestOnly = document.getElementById('dem-hud-canopy-forest-only-slider');
      const valForestOnly = document.getElementById('dem-hud-canopy-forest-only-val');
      if (sldForestOnly && valForestOnly) {
        const pct = Math.round((cSettings.forestOnlyThreshold !== undefined ? cSettings.forestOnlyThreshold : 0.35) * 100);
        sldForestOnly.value = pct;
        valForestOnly.textContent = pct + '%';
      }


      const chkCluster = document.getElementById('toggle-hud-canopy-tree-clustering');
      if (chkCluster) chkCluster.checked = cSettings.treeClustering !== false;

      const sldDens = document.getElementById('dem-hud-canopy-tree-density-slider');
      const valDens = document.getElementById('dem-hud-canopy-tree-density-val');
      if (sldDens && valDens) {
        const pct = Math.round((cSettings.treeDensity || 1.0) * 100);
        sldDens.value = pct;
        valDens.textContent = pct + '%';
      }

      const sldSc = document.getElementById('dem-hud-canopy-tree-scale-slider');
      const valSc = document.getElementById('dem-hud-canopy-tree-scale-val');
      if (sldSc && valSc) {
        sldSc.value = cSettings.treeScale || 1.0;
        valSc.textContent = '×' + parseFloat(sldSc.value).toFixed(1);
      }

      const sldTOp = document.getElementById('dem-hud-canopy-tree-opacity-slider');
      const valTOp = document.getElementById('dem-hud-canopy-tree-opacity-val');
      if (sldTOp && valTOp) {
        const pct = Math.round((cSettings.treeOpacity || 0.85) * 100);
        sldTOp.value = pct;
        valTOp.textContent = pct + '%';
      }

      const chkSh = document.getElementById('toggle-hud-canopy-tree-shadows');
      if (chkSh) chkSh.checked = cSettings.treeShadows !== false;
    }


    if (WM.viewshed) {
      const vsCfg = WM.viewshed.getSettings ? WM.viewshed.getSettings() : {};
      const isVsActive = WM.viewshed.isActive();

      const badgeVs = document.getElementById('dem-hud-viewshed-status-badge');
      if (badgeVs) {
        badgeVs.textContent = isVsActive ? 'Вкл' : 'Выкл';
        badgeVs.classList.toggle('active', isVsActive);
      }

      const btnQuick = document.getElementById('btn-viewshed-toggle-quick');
      if (btnQuick) {
        btnQuick.textContent = isVsActive ? 'Выкл' : 'Вкл';
        btnQuick.classList.toggle('active', isVsActive);
      }

      const placeholder = document.getElementById('viewshed-disabled-placeholder');
      const container = document.getElementById('viewshed-settings-container');
      if (placeholder) placeholder.hidden = isVsActive;
      if (container) {
        container.hidden = !isVsActive;
        container.classList.toggle('is-disabled', !isVsActive);
      }
      const vsButtons = [
        document.getElementById('btn-viewshed-toggle-quick'),
        document.getElementById('btn-viewshed-toggle-body'),
        document.getElementById('dem-hud-toggle-vs')
      ];
      vsButtons.forEach(btn => {
        if (btn) {
          btn.textContent = (btn.id === 'dem-hud-toggle-vs')
            ? (isVsActive ? '👁️ Обзор (Вкл)' : '👁️ Обзор')
            : (isVsActive ? 'Выкл' : 'Вкл');
          btn.classList.toggle('active', isVsActive);
        }
      });

      // Подсветка активной кнопки источника точки (Центр / GPS / Точка)
      const curOrigin = WM.viewshed.getOriginMode ? WM.viewshed.getOriginMode() : 'center';
      document.querySelectorAll('.viewshed-origin-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.origin === curOrigin);
      });

      // Ползунок радиуса
      const sldRadius = document.getElementById('viewshed-radius-slider');
      const valRadius = document.getElementById('viewshed-radius-val');
      if (sldRadius && valRadius) {
        sldRadius.value = vsCfg.radiusKm || 75;
        valRadius.textContent = sldRadius.value + ' км';
      }

      // Ползунок высоты цели над землей
      const sldTargetH = document.getElementById('viewshed-target-height-slider');
      const valTargetH = document.getElementById('viewshed-target-height-val');
      if (sldTargetH && valTargetH) {
        sldTargetH.value = vsCfg.targetHeight !== undefined ? vsCfg.targetHeight : 15;
        valTargetH.textContent = sldTargetH.value + ' м';
      }

      // Высота глаз наблюдателя
      const sldEyeH = document.getElementById('viewshed-eye-height-slider');
      const valEyeH = document.getElementById('viewshed-eye-height-val');
      if (sldEyeH && valEyeH) {
        sldEyeH.value = vsCfg.eyeHeight || 1.8;
        valEyeH.textContent = parseFloat(vsCfg.eyeHeight || 1.8).toFixed(1) + ' м';
      }

      // Прозрачность
      const sldVsOp = document.getElementById('viewshed-opacity-slider');
      const valVsOp = document.getElementById('viewshed-opacity-val');
      if (sldVsOp && valVsOp) {
        sldVsOp.value = Math.round((vsCfg.opacity || 0.55) * 100);
        valVsOp.textContent = sldVsOp.value + '%';
      }

      // Цвет
      const colVs = document.getElementById('viewshed-color');
      if (colVs) colVs.value = vsCfg.color || '#10b981';

      // Компас
      const chkCompass = document.getElementById('toggle-viewshed-follow-compass');
      if (chkCompass) chkCompass.checked = !!vsCfg.followCompass;
    }

    if (WM.clouds) {
      const cc = WM.clouds.getConfig();
      const chkCl = document.getElementById('dem-hud-toggle-clouds');
      if (chkCl) chkCl.checked = !!cc.enabled;
      
      const subCl = document.getElementById('dem-hud-clouds-sub');
      if (subCl) subCl.classList.toggle('is-disabled', !cc.enabled);

      const badgeCl = document.getElementById('dem-hud-clouds-status-badge');
      if (badgeCl) {
        badgeCl.textContent = cc.enabled ? 'Вкл' : 'Выкл';
        badgeCl.classList.toggle('active', !!cc.enabled);
      }

      const setR = (id, val, text) => {
        const inp = document.getElementById(id); if (inp) inp.value = val;
        const v = document.getElementById(id.replace('-slider', '-val')); if (v) v.textContent = text;
      };

      setR('dem-hud-clouds-scale-slider', cc.scale, '×' + parseFloat(cc.scale).toFixed(2));
      setR('dem-hud-clouds-coverage-slider', Math.round(cc.coverage * 100), Math.round(cc.coverage * 100) + '%');
      const chkW = document.getElementById('dem-hud-toggle-clouds-weather-cover');
      if (chkW) chkW.checked = !!cc.coverageFromWeather;
      setR('dem-hud-clouds-density-slider', cc.density, parseFloat(cc.density).toFixed(2));
      setR('dem-hud-clouds-isolation-slider', cc.clusterIsolation, parseFloat(cc.clusterIsolation).toFixed(2));
      setR('dem-hud-clouds-curl-slider', cc.curl, parseFloat(cc.curl).toFixed(2));

      setR('dem-hud-clouds-bright-slider', cc.cloudBrightness, '×' + parseFloat(cc.cloudBrightness).toFixed(2));
      setR('dem-hud-clouds-contrast-slider', cc.cloudContrast, '×' + parseFloat(cc.cloudContrast).toFixed(2));
      setR('dem-hud-clouds-shadow-slider', Math.round(cc.shadowOpacity * 100), Math.round(cc.shadowOpacity * 100) + '%');
      setR('dem-hud-clouds-shadow-bright-slider', cc.shadowBrightness, '×' + parseFloat(cc.shadowBrightness).toFixed(2));

      // НОВЫЕ СТРОКИ:
      const fmtTemp = v => (v > 0 ? '+' : '') + parseFloat(v).toFixed(2);
      setR('dem-hud-clouds-temp-light-slider', cc.cloudTempLight, fmtTemp(cc.cloudTempLight));
      setR('dem-hud-clouds-temp-shadow-slider', cc.cloudTempShadow, fmtTemp(cc.cloudTempShadow));
      setR('dem-hud-clouds-shadow-height-slider', cc.shadowHeight, parseFloat(cc.shadowHeight).toFixed(1) + ' км');

      const selHatch = document.getElementById('dem-hud-clouds-hatch-style-select');
      if (selHatch) selHatch.value = cc.hatchStyle || 'woodcut';

      setR('dem-hud-clouds-hatch-spacing-slider', cc.hatchSpacing, parseFloat(cc.hatchSpacing).toFixed(1) + ' px');
      setR('dem-hud-clouds-hatch-thick-slider', cc.hatchThickness, parseFloat(cc.hatchThickness).toFixed(2));
      setR('dem-hud-clouds-hatch-len-slider', cc.hatchLength, parseFloat(cc.hatchLength).toFixed(1));
      setR('dem-hud-clouds-hatch-thin-slider', Math.round(cc.hatchThinning * 100), Math.round(cc.hatchThinning * 100) + '%');
      setR('dem-hud-clouds-hatch-curv-slider', cc.hatchCurvature, parseFloat(cc.hatchCurvature).toFixed(2));

      const colInk = document.getElementById('dem-hud-clouds-ink-color');
      if (colInk) colInk.value = cc.inkColor || '#15130e';

      const selWindSrc = document.getElementById('dem-hud-clouds-wind-source-select');
      if (selWindSrc) {
        selWindSrc.value = cc.windSource || 'manual';
        const wrapW = document.getElementById('dem-hud-clouds-manual-wind-wrap');
        if (wrapW) wrapW.hidden = (cc.windSource !== 'manual');
      }

      setR('dem-hud-clouds-speed-slider', cc.speed, '×' + parseFloat(cc.speed).toFixed(2));
      setR('dem-hud-clouds-wind-speed-slider', cc.windSpeed, parseFloat(cc.windSpeed).toFixed(1) + ' м/с');
      setR('dem-hud-clouds-wind-dir-slider', cc.windDir, Math.round(cc.windDir) + '°');

      const chkTerr = document.getElementById('dem-hud-toggle-clouds-terrain');
      if (chkTerr) chkTerr.checked = cc.terrain !== false;
      setR('dem-hud-clouds-deflect-slider', cc.mountainDeflection, parseFloat(cc.mountainDeflection).toFixed(1));
    }

    // --- Карандашная обводка (Outline) ---
    const chkOutline = document.getElementById('dem-hud-toggle-outline');
    if (chkOutline) chkOutline.checked = !!cfg.outlineEnabled;

    const subOutline = document.getElementById('dem-hud-outline-sub');
    if (subOutline) subOutline.classList.toggle('is-disabled', !cfg.outlineEnabled);

    const badgeOutline = document.getElementById('dem-hud-outline-status-badge');
    if (badgeOutline) {
      badgeOutline.textContent = cfg.outlineEnabled ? 'Вкл' : 'Выкл';
      badgeOutline.classList.toggle('active', !!cfg.outlineEnabled);
    }

    const selOutlineType = document.getElementById('dem-hud-outline-type-select');
    if (selOutlineType) selOutlineType.value = cfg.outlineType || 'all';

    const selOutlineBlend = document.getElementById('dem-hud-outline-blend-select');
    if (selOutlineBlend) selOutlineBlend.value = cfg.outlineBlendMode || 'multiply';

    const colOutline = document.getElementById('dem-hud-outline-color');
    if (colOutline) colOutline.value = cfg.outlineColor || '#1c1917';

    const sliderOutWidth = document.getElementById('dem-hud-outline-width-slider');
    const valOutWidth = document.getElementById('dem-hud-outline-width-val');
    if (sliderOutWidth && valOutWidth) {
      sliderOutWidth.value = cfg.outlineWidth || 1.2;
      valOutWidth.textContent = parseFloat(cfg.outlineWidth || 1.2).toFixed(1) + ' px';
    }

    // Открытость Йокоямы
    const chkOpenness = document.getElementById('dem-hud-toggle-openness');
    if (chkOpenness) chkOpenness.checked = !!cfg.opennessEnabled;
    const subOpenness = document.getElementById('dem-hud-openness-sub');
    if (subOpenness) subOpenness.classList.toggle('is-disabled', !cfg.opennessEnabled);

    const sldOpRad = document.getElementById('dem-hud-openness-radius-slider');
    const valOpRad = document.getElementById('dem-hud-openness-radius-val');
    if (sldOpRad && valOpRad) {
      sldOpRad.value = Math.round((cfg.opennessRadius || 1.0) * 100);
      valOpRad.textContent = sldOpRad.value + '%';
    }

    const sldOpStr = document.getElementById('dem-hud-openness-strength-slider');
    const valOpStr = document.getElementById('dem-hud-openness-strength-val');
    if (sldOpStr && valOpStr) {
      sldOpStr.value = Math.round((cfg.opennessStrength !== undefined ? cfg.opennessStrength : 0.85) * 100);
      valOpStr.textContent = sldOpStr.value + '%';
    }

    const sldOpDiff = document.getElementById('dem-hud-openness-diff-slider');
    const valOpDiff = document.getElementById('dem-hud-openness-diff-val');
    if (sldOpDiff && valOpDiff) {
      sldOpDiff.value = Math.round((cfg.opennessDiff !== undefined ? cfg.opennessDiff : 0.5) * 100);
      valOpDiff.textContent = sldOpDiff.value + '%';
    }

    // 1-Bounce Radiosity
    const chkBounce = document.getElementById('dem-hud-toggle-bounce');
    if (chkBounce) chkBounce.checked = !!cfg.bounceEnabled;
    const subBounce = document.getElementById('dem-hud-bounce-sub');
    if (subBounce) subBounce.classList.toggle('is-disabled', !cfg.bounceEnabled);

    const sldBncStr = document.getElementById('dem-hud-bounce-str-slider');
    const valBncStr = document.getElementById('dem-hud-bounce-str-val');
    if (sldBncStr && valBncStr) {
      sldBncStr.value = Math.round((cfg.bounceStrength !== undefined ? cfg.bounceStrength : 0.55) * 100);
      valBncStr.textContent = sldBncStr.value + '%';
    }

    // Contact Hardening
    const chkContact = document.getElementById('dem-hud-toggle-contact-shadows');
    if (chkContact) chkContact.checked = !!cfg.contactShadowsEnabled;
    const subContact = document.getElementById('dem-hud-contact-sub');
    if (subContact) subContact.classList.toggle('is-disabled', !cfg.contactShadowsEnabled);

    const sldPen = document.getElementById('dem-hud-penumbra-slider');
    const valPen = document.getElementById('dem-hud-penumbra-val');
    if (sldPen && valPen) {
      sldPen.value = Math.round((cfg.penumbraScale !== undefined ? cfg.penumbraScale : 0.65) * 100);
      valPen.textContent = sldPen.value + '%';
    }

    const sliderOutRough = document.getElementById('dem-hud-outline-roughness-slider');
    const valOutRough = document.getElementById('dem-hud-outline-roughness-val');
    if (sliderOutRough && valOutRough) {
      const v = Math.round((cfg.outlineRoughness !== undefined ? cfg.outlineRoughness : 0.40) * 100);
      sliderOutRough.value = v;
      valOutRough.textContent = v + '%';
    }

    const sliderOutThresh = document.getElementById('dem-hud-outline-threshold-slider');
    const valOutThresh = document.getElementById('dem-hud-outline-threshold-val');
    if (sliderOutThresh && valOutThresh) {
      const v = Math.round((cfg.outlineThreshold !== undefined ? cfg.outlineThreshold : 0.35) * 100);
      sliderOutThresh.value = v;
      valOutThresh.textContent = v + '%';
    }

    const sliderOutOp = document.getElementById('dem-hud-outline-opacity-slider');
    const valOutOp = document.getElementById('dem-hud-outline-opacity-val');
    if (sliderOutOp && valOutOp) {
      const v = Math.round((cfg.outlineOpacity !== undefined ? cfg.outlineOpacity : 0.85) * 100);
      sliderOutOp.value = v;
      valOutOp.textContent = v + '%';
    }

    const sliderOutLMod = document.getElementById('dem-hud-outline-lightmod-slider');
    const valOutLMod = document.getElementById('dem-hud-outline-lightmod-val');
    if (sliderOutLMod && valOutLMod) {
      const v = Math.round((cfg.outlineLightMod !== undefined ? cfg.outlineLightMod : 0.50) * 100);
      sliderOutLMod.value = v;
      valOutLMod.textContent = v + '%';
    }

    const sliderRough = document.getElementById('dem-hud-roughness-slider');
    const valRough = document.getElementById('dem-hud-roughness-val');
    if (sliderRough && valRough) {
      const rPct = Math.round((cfg.orenNayarRoughness !== undefined ? cfg.orenNayarRoughness : 0.5) * 100);
      sliderRough.value = rPct;
      valRough.textContent = rPct + '%';
    }

    // === ВОТ СЮДА ВСТАВЛЯЕМ НОВЫЕ СЛАЙДЕРЫ ===
    const sliderContourRough = document.getElementById('dem-hud-contour-roughness-slider');
    const valContourRough = document.getElementById('dem-hud-contour-roughness-val');
    if (sliderContourRough && valContourRough) {
      const v = Math.round((cfg.contourRoughness || 0.0) * 100);
      sliderContourRough.value = v;
      valContourRough.textContent = v + '%';
    }

    const sliderPress = document.getElementById('dem-hud-contour-pressure-slider');
    const valPress = document.getElementById('dem-hud-contour-pressure-val');
    if (sliderPress && valPress) {
      const v = Math.round((cfg.contourHandPressure || 0.0) * 100);
      sliderPress.value = v;
      valPress.textContent = v + '%';
    }





    const chkBleed = document.getElementById('dem-hud-toggle-ink-bleed');
    if (chkBleed) chkBleed.checked = cfg.inkBleed !== false;

    const chkWater = document.getElementById('dem-hud-toggle-waterlining');
    if (chkWater) chkWater.checked = cfg.waterlining !== false;

    // Показываем/скрываем блок параметров при включении
    const subWater = document.getElementById('dem-hud-waterline-sub');
    if (subWater) subWater.hidden = !cfg.waterlining;

    const colWater = document.getElementById('dem-hud-waterline-color');
    if (colWater) colWater.value = cfg.waterlineColor || '#1c3d5a';

    const sliderWaterW = document.getElementById('dem-hud-waterline-width-slider');
    const valWaterW = document.getElementById('dem-hud-waterline-width-val');
    if (sliderWaterW && valWaterW) {
      sliderWaterW.value = cfg.waterlineWidth !== undefined ? cfg.waterlineWidth : 1.5;
      valWaterW.textContent = parseFloat(sliderWaterW.value).toFixed(1) + ' px';
    }

    const sliderWaterOp = document.getElementById('dem-hud-waterline-opacity-slider');
    const valWaterOp = document.getElementById('dem-hud-waterline-opacity-val');
    if (sliderWaterOp && valWaterOp) {
      const v = Math.round((cfg.waterlineOpacity !== undefined ? cfg.waterlineOpacity : 0.8) * 100);
      sliderWaterOp.value = v;
      valWaterOp.textContent = v + '%';
    }


    const chkForm = document.getElementById('dem-hud-toggle-formlines');
    if (chkForm) chkForm.checked = cfg.formLinesEnabled !== false;

    const selDitherBlend = document.getElementById('dem-hud-dither-blend-select');
    if (selDitherBlend) selDitherBlend.value = cfg.ditherBlendMode || 'multiply';

    const badgeDither = document.getElementById('dem-hud-dither-status-badge');
    if (badgeDither) {
      badgeDither.textContent = cfg.ditherEnabled ? 'Вкл' : 'Выкл';
      badgeDither.classList.toggle('active', !!cfg.ditherEnabled);
    }

    const selDitherType = document.getElementById('dem-hud-dither-type-select');
    if (selDitherType) selDitherType.value = cfg.ditherType || 'blue';

    const sliderDitherAngle = document.getElementById('dem-hud-dither-angle-slider');
    const valDitherAngle = document.getElementById('dem-hud-dither-angle-val');
    const wrapDitherAngle = document.getElementById('dem-hud-dither-angle-wrap');
    if (sliderDitherAngle && valDitherAngle) {
      sliderDitherAngle.value = Math.round(cfg.ditherAngle !== undefined ? cfg.ditherAngle : 45);
      valDitherAngle.textContent = sliderDitherAngle.value + '°';
    }
    if (wrapDitherAngle) {
      // Прячем слайдер вращения для изотропного синего шума
      wrapDitherAngle.hidden = (cfg.ditherType === 'blue');
    }

    const sliderDitherDensity = document.getElementById('dem-hud-dither-density-slider');
    const valDitherDensity = document.getElementById('dem-hud-dither-density-val');
    if (sliderDitherDensity && valDitherDensity) {
      const densPct = Math.round((cfg.ditherDensity !== undefined ? cfg.ditherDensity : 1.0) * 100);
      sliderDitherDensity.value = densPct;
      valDitherDensity.textContent = densPct + '%';
    }

    const sliderDitherLowCut = document.getElementById('dem-hud-dither-lowcut-slider');
    const valDitherLowCut = document.getElementById('dem-hud-dither-lowcut-val');
    if (sliderDitherLowCut && valDitherLowCut) {
      const v = Math.round((cfg.ditherLowCut !== undefined ? cfg.ditherLowCut : 0.0) * 100);
      sliderDitherLowCut.value = v;
      valDitherLowCut.textContent = v + '%';
    }

    const selDitherZone = document.getElementById('dem-hud-dither-zone-select');
    if (selDitherZone) selDitherZone.value = cfg.ditherZone || 'shadows';

    const colDither = document.getElementById('dem-hud-dither-color');
    if (colDither) colDither.value = cfg.ditherColor || '#1a1614';

    const sliderDitherScale = document.getElementById('dem-hud-dither-scale-slider');
    const valDitherScale = document.getElementById('dem-hud-dither-scale-val');
    if (sliderDitherScale && valDitherScale) {
      sliderDitherScale.value = cfg.ditherScale || 1.0;
      valDitherScale.textContent = '×' + parseFloat(cfg.ditherScale || 1.0).toFixed(1);
    }

    const sliderDitherThresh = document.getElementById('dem-hud-dither-thresh-slider');
    const valDitherThresh = document.getElementById('dem-hud-dither-thresh-val');
    if (sliderDitherThresh && valDitherThresh) {
      const v = Math.round((cfg.ditherThreshold !== undefined ? cfg.ditherThreshold : 0.55) * 100);
      sliderDitherThresh.value = v;
      valDitherThresh.textContent = v + '%';
    }

    const sliderDitherSoft = document.getElementById('dem-hud-dither-soft-slider');
    const valDitherSoft = document.getElementById('dem-hud-dither-soft-val');
    if (sliderDitherSoft && valDitherSoft) {
      const v = Math.round((cfg.ditherSoftness !== undefined ? cfg.ditherSoftness : 0.25) * 100);
      sliderDitherSoft.value = v;
      valDitherSoft.textContent = v + '%';
    }

    const sliderDitherStr = document.getElementById('dem-hud-dither-str-slider');
    const valDitherStr = document.getElementById('dem-hud-dither-str-val');
    if (sliderDitherStr && valDitherStr) {
      const v = Math.round((cfg.ditherStrength !== undefined ? cfg.ditherStrength : 0.85) * 100);
      sliderDitherStr.value = v;
      valDitherStr.textContent = v + '%';
    }

    // -------------------------------------------------------------
    // ВКЛАДКА 1: СВЕТ & СУТКИ
    // -------------------------------------------------------------
    const selSunMode = document.getElementById('dem-hud-sunmode-select');
    if (selSunMode) selSunMode.value = cfg.sunMode || 'time';

    const selBlend = document.getElementById('dem-hud-blendmode-select');
    if (selBlend) selBlend.value = cfg.blendMode || 'normal';

    const sliderHsOp = document.getElementById('dem-hud-hs-opacity');
    const valHsOp = document.getElementById('dem-hud-hs-opacity-val');
    if (sliderHsOp && valHsOp) {
      sliderHsOp.value = Math.round(cfg.hillshadeOpacity * 100);
      valHsOp.textContent = sliderHsOp.value + '%';
    }

    // --- Окраска по дорогам и опушкам ---
    const rOn = !!cfg.roadTintEnabled;
    const eOn = !!cfg.edgeTintEnabled;
    const badgeFeat = document.getElementById('dem-hud-feat-tint-status-badge');
    if (badgeFeat) {
      badgeFeat.textContent = (rOn && eOn) ? 'Все' : (rOn ? 'Дороги' : (eOn ? 'Опушки' : 'Выкл'));
      badgeFeat.classList.toggle('active', rOn || eOn);
    }

    const chkRoadT = document.getElementById('dem-hud-toggle-road-tint');
    if (chkRoadT) chkRoadT.checked = rOn;
    document.getElementById('dem-hud-road-tint-sub')?.classList.toggle('is-disabled', !rOn);
    if (document.getElementById('dem-hud-road-tint-color')) document.getElementById('dem-hud-road-tint-color').value = cfg.roadTintColor || '#e0a952';
    if (document.getElementById('dem-hud-road-tint-blend')) document.getElementById('dem-hud-road-tint-blend').value = cfg.roadTintBlendMode || 'tint';
    if (document.getElementById('dem-hud-road-tint-types')) document.getElementById('dem-hud-road-tint-types').value = cfg.roadTintTypes || 'drive';

    const sldROp = document.getElementById('dem-hud-road-tint-opacity-slider');
    if (sldROp) {
      const v = Math.round((cfg.roadTintOpacity ?? 0.75) * 100);
      sldROp.value = v;
      document.getElementById('dem-hud-road-tint-opacity-val').textContent = v + '%';
    }
    const sldRZone = document.getElementById('dem-hud-road-tint-zone-slider');
    if (sldRZone) {
      const v = Math.round(cfg.roadTintZone ?? 14);
      sldRZone.value = v;
      document.getElementById('dem-hud-road-tint-zone-val').textContent = v + ' px';
    }
    const sldRSoft = document.getElementById('dem-hud-road-tint-softness-slider');
    if (sldRSoft) {
      const v = Math.round((cfg.roadTintSoftness ?? 0.75) * 100);
      sldRSoft.value = v;
      document.getElementById('dem-hud-road-tint-softness-val').textContent = v + '%';
    }

    const chkEdgeT = document.getElementById('dem-hud-toggle-edge-tint');
    if (chkEdgeT) chkEdgeT.checked = eOn;
    document.getElementById('dem-hud-edge-tint-sub')?.classList.toggle('is-disabled', !eOn);
    if (document.getElementById('dem-hud-edge-tint-color')) document.getElementById('dem-hud-edge-tint-color').value = cfg.edgeTintColor || '#7ca34b';
    if (document.getElementById('dem-hud-edge-tint-blend')) document.getElementById('dem-hud-edge-tint-blend').value = cfg.edgeTintBlendMode || 'tint';
    if (document.getElementById('dem-hud-edge-tint-side')) document.getElementById('dem-hud-edge-tint-side').value = cfg.edgeTintSide || 'both';

    const sldEOp = document.getElementById('dem-hud-edge-tint-opacity-slider');
    if (sldEOp) {
      const v = Math.round((cfg.edgeTintOpacity ?? 0.65) * 100);
      sldEOp.value = v;
      document.getElementById('dem-hud-edge-tint-opacity-val').textContent = v + '%';
    }
    const sldEZone = document.getElementById('dem-hud-edge-tint-zone-slider');
    if (sldEZone) {
      const v = Math.round(cfg.edgeTintZone ?? 18);
      sldEZone.value = v;
      document.getElementById('dem-hud-edge-tint-zone-val').textContent = v + ' px';
    }
    const sldESoft = document.getElementById('dem-hud-edge-tint-softness-slider');
    if (sldESoft) {
      const v = Math.round((cfg.edgeTintSoftness ?? 0.80) * 100);
      sldESoft.value = v;
      document.getElementById('dem-hud-edge-tint-softness-val').textContent = v + '%';
    }

    // Усиление света (Light Boost)
    const sliderBoost = document.getElementById('dem-hud-light-boost-slider');
    const valBoost = document.getElementById('dem-hud-light-boost-val');
    if (sliderBoost && valBoost) {
      sliderBoost.value = cfg.lightBoost !== undefined ? cfg.lightBoost : 1.0;
      valBoost.textContent = '×' + parseFloat(sliderBoost.value).toFixed(2);
    }

    // Переключение режимов: Ручные углы vs Время суток
    const isManualMode = (cfg.sunMode === 'manual');
    const timeContainer = document.getElementById('dem-hud-time-container');
    const wrapManualAng = document.getElementById('dem-hud-manual-angles-wrap');
    const spoilerSunTitle = document.getElementById('dem-hud-sun-spoiler-title');

    if (timeContainer) timeContainer.hidden = isManualMode;
    if (wrapManualAng) wrapManualAng.hidden = !isManualMode;
    if (spoilerSunTitle) {
      spoilerSunTitle.textContent = isManualMode ? '📐 Ручные углы и цвета освещения' : '🕒 Время суток и календарь';
    }

    const sliderTime = document.getElementById('dem-hud-time-slider');
    const valTime = document.getElementById('dem-hud-time-val');
    if (sliderTime && valTime) {
      const curH = cfg.manualTimeHour !== undefined ? cfg.manualTimeHour : 15;
      const mapCenter = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const curDate = new Date();
      
      if (WM.timeWarp) {
        const want = WM.timeWarp.hourToSlider(curH, mapCenter.lat, mapCenter.lng, curDate);
        // не дёргаем ползунок, пока пользователь его тянет
        if (document.activeElement !== sliderTime || Math.abs(parseFloat(sliderTime.value) - want) > 2) sliderTime.value = want;
      } else {
        sliderTime.value = Math.round(curH * 60);
      }
      valTime.textContent = formatHourString(curH, mapCenter.lat, mapCenter.lng, curDate);
    }

    const inputDate = document.getElementById('dem-hud-date-input');
    if (inputDate) {
      if (!cfg.manualDateStr) {
        const today = new Date();
        const pad = n => String(n).padStart(2, '0');
        inputDate.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      } else {
        inputDate.value = cfg.manualDateStr;
      }
    }

    const sliderAz = document.getElementById('dem-hud-azimuth-slider');
    const valAz = document.getElementById('dem-hud-azimuth-val');
    if (sliderAz && valAz) {
      sliderAz.value = cfg.sunAzimuth || 315;
      valAz.textContent = (cfg.sunAzimuth || 315) + '°';
    }

    const sliderAlt = document.getElementById('dem-hud-altitude-slider');
    const valAlt = document.getElementById('dem-hud-altitude-val');
    if (sliderAlt && valAlt) {
      sliderAlt.value = cfg.sunAltitude || 45;
      valAlt.textContent = (cfg.sunAltitude || 45) + '°';
    }

    // Ручные цвета освещения

    const colPeak = document.getElementById('dem-hud-manual-color-peak');
    if (colPeak) colPeak.value = cfg.manualPeakColor || '#fe1691';

    const scaleMode = cfg.manualScaleMode || 'relative';
    const selManualScale = document.getElementById('dem-hud-manual-scale-mode');
    if (selManualScale) selManualScale.value = scaleMode;

    const fixedWrap = document.getElementById('dem-hud-manual-fixed-wrap');
    if (fixedWrap) fixedWrap.hidden = (scaleMode !== 'fixed');

    const inpElevMin = document.getElementById('dem-hud-manual-elev-min');
    const inpElevMax = document.getElementById('dem-hud-manual-elev-max');
    const minM = cfg.manualElevMin !== undefined ? Number(cfg.manualElevMin) : 0;
    const maxM = Math.max(minM + 1, cfg.manualElevMax !== undefined ? Number(cfg.manualElevMax) : 1500);
    if (inpElevMin && document.activeElement !== inpElevMin) inpElevMin.value = minM;
    if (inpElevMax && document.activeElement !== inpElevMax) inpElevMax.value = maxM;

    document.querySelectorAll('.dem-manual-elev-chip').forEach(ch => {
      const cMin = parseFloat(ch.dataset.min);
      const cMax = parseFloat(ch.dataset.max);
      ch.classList.toggle('active', scaleMode === 'fixed' && minM === cMin && maxM === cMax);
    });

    const colMid = document.getElementById('dem-hud-manual-color-mid');
    if (colMid) colMid.value = cfg.manualMidColor || '#e8b074';

    const colValley = document.getElementById('dem-hud-manual-color-valley');
    if (colValley) colValley.value = cfg.manualValleyColor || '#a8863e';

    const colShadow = document.getElementById('dem-hud-manual-color-shadow');
    if (colShadow) colShadow.value = cfg.manualShadowColor || '#456327';

    const syncManualSlider = (sId, vId, val, def, showMeters = false) => {
      const s = document.getElementById(sId);
      const v = document.getElementById(vId);
      if (s && v) {
        const num = val !== undefined ? val : def;
        const pct = Math.round(num * 100);
        s.value = pct;
        if (showMeters && scaleMode === 'fixed') {
          const mVal = Math.round(minM + num * (maxM - minM));
          v.textContent = `${pct}% (${mVal} м)`;
        } else {
          v.textContent = pct + '%';
        }
      }
    };
    syncManualSlider('dem-hud-manual-blend-slider', 'dem-hud-manual-blend-val', cfg.manualLightBlend, 0.33, true);
    syncManualSlider('dem-hud-manual-softness-slider', 'dem-hud-manual-softness-val', cfg.manualLightSoftness, 0.35);
    syncManualSlider('dem-hud-manual-blend2-slider', 'dem-hud-manual-blend2-val', cfg.manualLightBlend2, 0.68, true);
    syncManualSlider('dem-hud-manual-softness2-slider', 'dem-hud-manual-softness2-val', cfg.manualLightSoftness2, 0.35);
    updateManualGradientPreview();


    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.classList.toggle('active', ch.dataset.tone === (cfg.colorTone || 'none'));
    });



    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.classList.toggle('active', ch.dataset.tone === (cfg.colorTone || 'imhof'));
    });

    const sliderLightWrap = document.getElementById('dem-hud-light-wrap');
    const valLightWrap = document.getElementById('dem-hud-light-wrap-val');
    if (sliderLightWrap && valLightWrap) {
      sliderLightWrap.value = Math.round((cfg.lightWrap !== undefined ? cfg.lightWrap : 0.35) * 100);
      valLightWrap.textContent = sliderLightWrap.value + '%';
    }

    const chkMdow = document.getElementById('dem-hud-toggle-mdow');
    if (chkMdow) chkMdow.checked = cfg.mdowEnabled !== false;

    const sliderImhofDefl = document.getElementById('dem-hud-imhof-defl-slider');
    const valImhofDefl = document.getElementById('dem-hud-imhof-defl-val');
    if (sliderImhofDefl && valImhofDefl) {
      const v = Math.round((cfg.imhofDeflection !== undefined ? cfg.imhofDeflection : 0.35) * 100);
      sliderImhofDefl.value = v;
      valImhofDefl.textContent = v + '%';
    }

    const chkCastShadow = document.getElementById('dem-hud-toggle-cast-shadows');
    if (chkCastShadow) chkCastShadow.checked = !!cfg.castShadows;

    const subCast = document.getElementById('dem-hud-cast-shadows-sub');
    if (subCast) {
      subCast.hidden = false;
      subCast.classList.toggle('is-disabled', !cfg.castShadows);
    }

    const sliderReach = document.getElementById('dem-hud-shadow-reach');
    const valReach = document.getElementById('dem-hud-shadow-reach-val');
    if (sliderReach && valReach) {
      sliderReach.value = Math.round((cfg.shadowReach || 1.0) * 100);
      valReach.textContent = sliderReach.value + '%';
    }

    const sliderShaOp = document.getElementById('dem-hud-shadow-opacity');
    const valShaOp = document.getElementById('dem-hud-shadow-opacity-val');
    if (sliderShaOp && valShaOp) {
      sliderShaOp.value = Math.round((cfg.shadowOpacity !== undefined ? cfg.shadowOpacity : 0.60) * 100);
      valShaOp.textContent = sliderShaOp.value + '%';
    }

    // -------------------------------------------------------------
    // ВКЛАДКА 2: РЕЛЬЕФ & ТОЧНОСТЬ
    // -------------------------------------------------------------
    const selSource = document.getElementById('dem-hud-source-select');
    if (selSource) selSource.value = cfg.demSource || 'fabdem';

    const btnZAuto = document.getElementById('dem-hud-zfactor-auto-btn');
    if (btnZAuto) btnZAuto.classList.toggle('active', !!cfg.zFactorAuto);

    const sliderZ = document.getElementById('dem-hud-zfactor-slider');
    const valZ = document.getElementById('dem-hud-zfactor-val');
    if (sliderZ && valZ) {
      sliderZ.disabled = !!cfg.zFactorAuto;
      sliderZ.value = cfg.zFactor;
      valZ.textContent = cfg.zFactorAuto ? `Авто (~×${getEffectiveZFactor()})` : '×' + parseFloat(cfg.zFactor).toFixed(1);
    }

    hud.querySelectorAll('.dem-smooth-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.smooth === (cfg.smoothMode || 'bilateral'));
    });

    const selHypso = document.getElementById('dem-hud-hypso-select');
    if (selHypso) selHypso.value = cfg.hypsoMode || 'none';

    const sliderGrain = document.getElementById('dem-hud-paper-grain-slider');
    const valGrain = document.getElementById('dem-hud-paper-grain-val');
    if (sliderGrain && valGrain) {
      const grainPct = Math.round((cfg.paperGrain !== undefined ? cfg.paperGrain : 0.4) * 100);
      sliderGrain.value = grainPct;
      valGrain.textContent = grainPct + '%';
    }

    const chkAO = document.getElementById('dem-hud-toggle-ao');
    if (chkAO) chkAO.checked = !!cfg.ambientOcclusion;

    const subAO = document.getElementById('dem-hud-ao-sub');
    if (subAO) subAO.classList.toggle('is-disabled', !cfg.ambientOcclusion);

    const sliderAoStr = document.getElementById('dem-hud-ao-strength-slider');
    const valAoStr = document.getElementById('dem-hud-ao-strength-val');
    if (sliderAoStr && valAoStr) {
      sliderAoStr.value = Math.round((cfg.aoStrength || 1.0) * 100);
      valAoStr.textContent = sliderAoStr.value + '%';
    }

    const sliderBleed = document.getElementById('dem-hud-ao-bleed-slider');
    const valBleed = document.getElementById('dem-hud-ao-bleed-val');
    if (sliderBleed && valBleed) {
      const bleedPct = Math.round((cfg.aoSlopeBleed !== undefined ? cfg.aoSlopeBleed : 0.65) * 100);
      sliderBleed.value = bleedPct;
      valBleed.textContent = bleedPct + '%';
    }

    const sliderAoRad = document.getElementById('dem-hud-ao-radius-slider');
    const valAoRad = document.getElementById('dem-hud-ao-radius-val');
    if (sliderAoRad && valAoRad) {
      const radPct = Math.round((cfg.aoRadius !== undefined ? cfg.aoRadius : 1.0) * 100);
      sliderAoRad.value = radPct;
      valAoRad.textContent = radPct + '%';
    }

    const chkSvf = document.getElementById('dem-hud-toggle-svf');
    if (chkSvf) chkSvf.checked = cfg.svfEnabled !== false;

    const subSvf = document.getElementById('dem-hud-svf-sub');
    if (subSvf) subSvf.classList.toggle('is-disabled', cfg.svfEnabled === false);

    const sliderSvf = document.getElementById('dem-hud-svf-slider');
    const valSvf = document.getElementById('dem-hud-svf-val');
    if (sliderSvf && valSvf) {
      const svfPct = Math.round((cfg.svfStrength !== undefined ? cfg.svfStrength : 0.85) * 100);
      sliderSvf.value = svfPct;
      valSvf.textContent = svfPct + '%';
    }

    const chkHachure = document.getElementById('dem-hud-toggle-hachure');
    if (chkHachure) chkHachure.checked = !!cfg.hachureEnabled;

    const badgeHach = document.getElementById('dem-hud-hachure-status-badge');
    if (badgeHach) {
      badgeHach.textContent = cfg.hachureEnabled ? 'Вкл' : 'Выкл';
      badgeHach.classList.toggle('active', !!cfg.hachureEnabled);
    }

    const subHach = document.getElementById('dem-hud-hachure-sub');
    if (subHach) {
      subHach.hidden = false;
      subHach.classList.toggle('is-disabled', !cfg.hachureEnabled);
    }

    const selHachType = document.getElementById('dem-hud-hachure-type-select');
    if (selHachType) selHachType.value = cfg.hachureType || 'contour';

    const selHachBlend = document.getElementById('dem-hud-hachure-blend-select');
    if (selHachBlend) selHachBlend.value = cfg.hachureBlendMode || 'multiply';

    const sliderHachThin = document.getElementById('dem-hud-hachure-thinning-slider');
    const valHachThin = document.getElementById('dem-hud-hachure-thinning-val');
    if (sliderHachThin && valHachThin) {
      const v = Math.round((cfg.hachureThinning || 0.0) * 100);
      sliderHachThin.value = v;
      valHachThin.textContent = v + '%';
    }

    const sliderHachDens = document.getElementById('dem-hud-hachure-density-slider');
    const valHachDens = document.getElementById('dem-hud-hachure-density-val');
    if (sliderHachDens && valHachDens) {
      const v = Math.round((cfg.hachureDensity || 1.0) * 100);
      sliderHachDens.value = v;
      valHachDens.textContent = v + '%';
    }

    const sliderHachOp = document.getElementById('dem-hud-hachure-opacity-slider');
    const valHachOp = document.getElementById('dem-hud-hachure-opacity-val');
    if (sliderHachOp && valHachOp) {
      const v = Math.round((cfg.hachureOpacity !== undefined ? cfg.hachureOpacity : 0.75) * 100);
      sliderHachOp.value = v;
      valHachOp.textContent = v + '%';
    }

    const colHach = document.getElementById('dem-hud-hachure-color');
    if (colHach) colHach.value = cfg.hachureColor || '#6f4020';

    const sliderHachSlope = document.getElementById('dem-hud-hachure-slope-slider');
    const valHachSlope = document.getElementById('dem-hud-hachure-slope-val');
    if (sliderHachSlope && valHachSlope) {
      const v = Math.round((cfg.hachureSlope !== undefined ? cfg.hachureSlope : 0.08) * 100);
      sliderHachSlope.value = v;
      valHachSlope.textContent = v + '%';
    }

    const sliderHachLMod = document.getElementById('dem-hud-hachure-lightmod-slider');
    const valHachLMod = document.getElementById('dem-hud-hachure-lightmod-val');
    if (sliderHachLMod && valHachLMod) {
      const v = Math.round((cfg.hachureLightMod !== undefined ? cfg.hachureLightMod : 0.60) * 100);
      sliderHachLMod.value = v;
      valHachLMod.textContent = v + '%';
    }

    // -------------------------------------------------------------
    // ВКЛАДКА 3: ИЗОЛИНИИ (ГОРИЗОНТАЛИ)
    // -------------------------------------------------------------
    const selStep = document.getElementById('dem-hud-step-select');
    if (selStep) selStep.value = cfg.contourStep || 'auto';

    const sliderWidth = document.getElementById('dem-hud-width-slider');
    const valWidth = document.getElementById('dem-hud-width-val');
    if (sliderWidth && valWidth) {
      sliderWidth.value = cfg.contourWidth || 1.5;
      valWidth.textContent = parseFloat(cfg.contourWidth || 1.5).toFixed(1) + ' px';
    }

    const sliderCtOp = document.getElementById('dem-hud-ct-opacity');
    const valCtOp = document.getElementById('dem-hud-ct-opacity-val');
    if (sliderCtOp && valCtOp) {
      sliderCtOp.value = Math.round(cfg.contourOpacity * 100);
      valCtOp.textContent = sliderCtOp.value + '%';
    }



    const selCtStyle = document.getElementById('dem-hud-contour-style-select');
    if (selCtStyle) selCtStyle.value = cfg.contourStyle || 'standard';

    const selCtSmooth = document.getElementById('dem-hud-contour-smooth-select');
    if (selCtSmooth) selCtSmooth.value = cfg.contourSmoothing || 'chaikin';

    const selPalette = document.getElementById('dem-hud-contour-palette');
    const customWrap = document.getElementById('dem-hud-custom-color-wrap');
    if (selPalette) {
      selPalette.value = cfg.contourPalette || 'sepia';
      if (customWrap) customWrap.hidden = (cfg.contourPalette !== 'custom');
    }

    const colCont = document.getElementById('dem-hud-contour-color');
    if (colCont) colCont.value = cfg.contourColor || '#b45309';

    const selCtBlend = document.getElementById('dem-hud-contour-blend-select');
    if (selCtBlend) selCtBlend.value = cfg.contourBlendMode || 'normal';

    const showLbl = cfg.showLabels !== false;
    const chkLabels = document.getElementById('dem-hud-toggle-labels');
    if (chkLabels) chkLabels.checked = showLbl;

    const badgeLabels = document.getElementById('dem-hud-labels-status-badge');
    if (badgeLabels) {
      badgeLabels.textContent = showLbl ? 'Вкл' : 'Выкл';
      badgeLabels.classList.toggle('active', showLbl);
    }

    const subLabels = document.getElementById('dem-hud-labels-sub');
    if (subLabels) subLabels.classList.toggle('is-disabled', !showLbl);

    const selLblScope = document.getElementById('dem-hud-label-scope-select');
    if (selLblScope) selLblScope.value = cfg.contourLabelScope || 'auto';

    const selLblOrient = document.getElementById('dem-hud-label-orient-select');
    if (selLblOrient) selLblOrient.value = cfg.contourLabelOrient || 'readable';

    const selLblStyle = document.getElementById('dem-hud-label-style-select');
    if (selLblStyle) selLblStyle.value = cfg.contourLabelStyle || 'halo';

    const sldLblDens = document.getElementById('dem-hud-label-density-slider');
    const valLblDens = document.getElementById('dem-hud-label-density-val');
    if (sldLblDens && valLblDens) {
      const pct = Math.round((cfg.contourLabelDensity !== undefined ? cfg.contourLabelDensity : 1.0) * 100);
      sldLblDens.value = pct;
      valLblDens.textContent = pct + '%';
    }

    const sldLblSize = document.getElementById('dem-hud-label-size-slider');
    const valLblSize = document.getElementById('dem-hud-label-size-val');
    if (sldLblSize && valLblSize) {
      const sz = cfg.contourLabelSize !== undefined ? cfg.contourLabelSize : 9.5;
      sldLblSize.value = sz;
      valLblSize.textContent = parseFloat(sz).toFixed(1) + ' px';
    }

    const sldLblHalo = document.getElementById('dem-hud-label-halo-width-slider');
    const valLblHalo = document.getElementById('dem-hud-label-halo-width-val');
    const wrapLblHalo = document.getElementById('dem-hud-label-halo-width-wrap');
    if (sldLblHalo && valLblHalo) {
      const hw = cfg.contourLabelHaloWidth !== undefined ? cfg.contourLabelHaloWidth : 3.0;
      sldLblHalo.value = hw;
      valLblHalo.textContent = parseFloat(hw).toFixed(1) + ' px';
    }
    if (wrapLblHalo) {
      wrapLblHalo.classList.toggle('is-disabled', (cfg.contourLabelStyle || 'halo') === 'break');
    }

    const selLblColMode = document.getElementById('dem-hud-label-color-mode');
    const wrapLblCol = document.getElementById('dem-hud-label-color-wrap');
    if (selLblColMode) {
      selLblColMode.value = cfg.contourLabelColorMode || 'auto';
      if (wrapLblCol) wrapLblCol.classList.toggle('is-disabled', selLblColMode.value !== 'custom');
    }

    const colLbl = document.getElementById('dem-hud-label-color');
    if (colLbl) colLbl.value = cfg.contourLabelColor || '#3a250b';

    const colLblHalo = document.getElementById('dem-hud-label-halo-color');
    if (colLblHalo) colLblHalo.value = cfg.contourLabelHaloColor || '#f7f1e1';

    const chkLblBreak = document.getElementById('dem-hud-toggle-label-break');
    if (chkLblBreak) chkLblBreak.checked = cfg.contourLabelBreak !== false;

    const chkLblUnit = document.getElementById('dem-hud-toggle-label-unit');
    if (chkLblUnit) chkLblUnit.checked = !!cfg.contourLabelUnit;

    const chkLblBold = document.getElementById('dem-hud-toggle-label-bold');
    if (chkLblBold) chkLblBold.checked = cfg.contourLabelBold !== false;

    // === ВСТАВИТЬ СЮДА: Синхронизируем селектор пресетов при каждом обновлении HUD ===
    if (WM.demPresets) {
      WM.demPresets.syncSelectUI();
    }

    const chkTaper = document.getElementById('dem-hud-toggle-taper');
    if (chkTaper) chkTaper.checked = !!cfg.taperWithElevation;

    const wrapTaper = document.getElementById('dem-hud-taper-strength-wrap');
    if (wrapTaper) {
      wrapTaper.hidden = false;
      wrapTaper.classList.toggle('is-disabled', !cfg.taperWithElevation);
    }

    const selTaperDir = document.getElementById('dem-hud-taper-dir-select');
    if (selTaperDir) selTaperDir.value = cfg.taperDirection || 'crests';

    const sliderTaperStr = document.getElementById('dem-hud-taper-strength-slider');
    const valTaperStr = document.getElementById('dem-hud-taper-strength-val');
    if (sliderTaperStr && valTaperStr) {
      const strPct = Math.round((cfg.taperStrength !== undefined ? cfg.taperStrength : 0.60) * 100);
      sliderTaperStr.value = strPct;
      valTaperStr.textContent = strPct + '%';
    }

    const chkCliff = document.getElementById('dem-hud-toggle-cliff-hairlines');
    if (chkCliff) chkCliff.checked = cfg.cliffHairlines !== false;
    if (WM.terrainDecor && WM.terrainDecor.syncUI) {
      WM.terrainDecor.syncUI();
    }

    syncSpoilerQuickToggles(); // <--- ДОБАВИТЬ СЮДА
  }

  function initHudEvents() {
    const hud = document.getElementById('dem-relief-hud');
    if (!hud || hud._inited) return;
    hud._inited = true;

    // Единый обработчик для всех кнопок Вкл/Выкл в шапках спойлеров
    hud.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('.js-hud-spoiler-toggle, .js-hud-tools-toggle');
      if (!toggleBtn || !hud.contains(toggleBtn)) return;

      // Не даём <summary> сворачивать/разворачивать <details> при нажатии на кнопку
      e.preventDefault();
      e.stopPropagation();

      if (toggleBtn.dataset.syncCheckbox) {
        const chk = document.getElementById(toggleBtn.dataset.syncCheckbox);
        if (chk) {
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (toggleBtn.dataset.syncRoads === 'true') {
        const topRoadsBtn = document.getElementById('dem-hud-toggle-roads');
        if (topRoadsBtn) topRoadsBtn.click();
        else if (WM.vectorRoads) WM.vectorRoads.toggle();
      } else if (toggleBtn.dataset.syncBtn) {
        const targetBtn = document.getElementById(toggleBtn.dataset.syncBtn);
        if (targetBtn) targetBtn.click();
      }

      syncSpoilerQuickToggles();
    });

    // Синхронизация кнопок в шапках при изменении внутренних чекбоксов вручную
    hud.addEventListener('change', (e) => {
      if (e.target && e.target.matches('input[type="checkbox"]')) {
        syncSpoilerQuickToggles();
      }
    });

    document.getElementById('btn-dem-hud-close')?.addEventListener('click', () => {
      WM.demRelief.closeHud();
    });

    const minBtn = document.getElementById('btn-dem-hud-minimize');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        hud.classList.toggle('collapsed');
        minBtn.textContent = hud.classList.contains('collapsed') ? '▲' : '▼';
      });
    }

    // Прокрутка кнопок шапки стрелками и колесиком мыши
    const switchesEl = document.getElementById('dem-hud-switches');
    const scrollLeftBtn = document.getElementById('dem-hud-scroll-left');
    const scrollRightBtn = document.getElementById('dem-hud-scroll-right');

    if (switchesEl) {
      const updateScrollArrows = () => {
        if (!scrollLeftBtn || !scrollRightBtn) return;
        const maxScroll = switchesEl.scrollWidth - switchesEl.clientWidth;
        const atStart = switchesEl.scrollLeft <= 2;
        const atEnd = switchesEl.scrollLeft >= maxScroll - 2;

        scrollLeftBtn.disabled = atStart;
        scrollRightBtn.disabled = atEnd;
      };
      switchesEl._updateScrollArrows = updateScrollArrows;

      scrollLeftBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        switchesEl.scrollBy({ left: -100, behavior: 'smooth' });
      });

      scrollRightBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        switchesEl.scrollBy({ left: 100, behavior: 'smooth' });
      });

      // Поддержка горизонтальной прокрутки обычным вертикальным колесиком мыши
      switchesEl.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          switchesEl.scrollLeft += e.deltaY;
          updateScrollArrows();
        }
      }, { passive: false });

      switchesEl.addEventListener('scroll', updateScrollArrows, { passive: true });
      window.addEventListener('resize', updateScrollArrows, { passive: true });
      requestAnimationFrame(updateScrollArrows);
    }

    const handleViewshedToggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (WM.viewshed) {
        WM.viewshed.toggle();
        renderHudUI();
      }
    };

    document.getElementById('toggle-hud-canopy-clear-roads')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeClearRoads(e.target.checked);
      renderHudUI();
    });

    document.getElementById('dem-hud-canopy-clear-roads-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-clear-roads-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(1);
      if (WM.canopy) WM.canopy.setTreeClearRoadsDist(v);
    });

    document.getElementById('dem-hud-canopy-clear-roads-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-clear-roads-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy && WM.canopy.setTreeClearRoadsOpacity) WM.canopy.setTreeClearRoadsOpacity(v / 100);
    });


    document.getElementById('toggle-hud-canopy-clear-rivers')?.addEventListener('change', (e) => {
      if (WM.canopy && WM.canopy.setTreeClearRivers) WM.canopy.setTreeClearRivers(e.target.checked);
      renderHudUI();
    });

    document.getElementById('dem-hud-canopy-clear-rivers-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-clear-rivers-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(1);
      if (WM.canopy && WM.canopy.setTreeClearRiversDist) WM.canopy.setTreeClearRiversDist(v);
    });

    document.getElementById('dem-hud-canopy-clear-rivers-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-clear-rivers-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy && WM.canopy.setTreeClearRiversOpacity) WM.canopy.setTreeClearRiversOpacity(v / 100);
    });

    document.getElementById('dem-hud-canopy-clear-rivers-soft-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-clear-rivers-soft-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy && WM.canopy.setTreeClearRiversSoftness) WM.canopy.setTreeClearRiversSoftness(v / 100);
    });
    document.getElementById('btn-viewshed-toggle-quick')?.addEventListener('click', handleViewshedToggle);
    document.getElementById('btn-viewshed-toggle-body')?.addEventListener('click', handleViewshedToggle);
    document.getElementById('dem-hud-toggle-vs')?.addEventListener('click', handleViewshedToggle);

    document.getElementById('dem-hud-canopy-tree-blend')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeBlendMode(e.target.value);
    });

    document.getElementById('toggle-hud-canopy-fantasy-forest')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setFantasyForest(e.target.checked);
    });

    // --- Окраска по дорогам и опушкам ---
    document.getElementById('dem-hud-toggle-road-tint')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ roadTintEnabled: e.target.checked });
    });
    document.getElementById('dem-hud-road-tint-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({ roadTintColor: e.target.value, _skipHud: true });
    });
    document.getElementById('dem-hud-road-tint-blend')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ roadTintBlendMode: e.target.value });
    });
    document.getElementById('dem-hud-road-tint-types')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ roadTintTypes: e.target.value });
    });
    document.getElementById('dem-hud-road-tint-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-road-tint-opacity-val').textContent = v + '%';
      WM.demRelief.setConfig({ roadTintOpacity: v / 100, _skipHud: true });
    });
    document.getElementById('dem-hud-road-tint-zone-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-road-tint-zone-val').textContent = v + ' px';
      WM.demRelief.setConfig({ roadTintZone: v, _skipHud: true });
    });
    document.getElementById('dem-hud-road-tint-softness-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-road-tint-softness-val').textContent = v + '%';
      WM.demRelief.setConfig({ roadTintSoftness: v / 100, _skipHud: true });
    });

    document.getElementById('dem-hud-toggle-edge-tint')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ edgeTintEnabled: e.target.checked });
    });
    document.getElementById('dem-hud-edge-tint-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({ edgeTintColor: e.target.value, _skipHud: true });
    });
    document.getElementById('dem-hud-edge-tint-blend')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ edgeTintBlendMode: e.target.value });
    });
    document.getElementById('dem-hud-edge-tint-side')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ edgeTintSide: e.target.value });
    });
    document.getElementById('dem-hud-edge-tint-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-edge-tint-opacity-val').textContent = v + '%';
      WM.demRelief.setConfig({ edgeTintOpacity: v / 100, _skipHud: true });
    });
    document.getElementById('dem-hud-edge-tint-zone-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-edge-tint-zone-val').textContent = v + ' px';
      WM.demRelief.setConfig({ edgeTintZone: v, _skipHud: true });
    });
    document.getElementById('dem-hud-edge-tint-softness-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-edge-tint-softness-val').textContent = v + '%';
      WM.demRelief.setConfig({ edgeTintSoftness: v / 100, _skipHud: true });
    });


    document.getElementById('dem-hud-canopy-clear-roads-soft-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-clear-roads-soft-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy && WM.canopy.setTreeClearRoadsSoftness) WM.canopy.setTreeClearRoadsSoftness(v / 100);
    });

    document.getElementById('toggle-hud-canopy-tree-autodense')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeAutoDense(e.target.checked);
    });

    // Слушатели кнопок 3D-среза в спойлере инструментов рельефа
    document.getElementById('btn-slice3d-toggle-hud')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (WM.slice3d) {
        WM.slice3d.toggle();
        renderHudUI();
      }
    });

    document.getElementById('btn-slice3d-refresh-hud')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (WM.slice3d) {
        WM.slice3d.open({ refresh: true });
        renderHudUI();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🧊 3D-срез обновлён по текущему экрану');
      }
    });

    document.getElementById('toggle-hud-canopy-opaque-fill')?.addEventListener('change', (e) => {
      if (WM.canopy) {
        WM.canopy.setTreeOpaqueFill(e.target.checked);
        const sub = document.getElementById('dem-hud-canopy-opaque-sub');
        if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      }
    });

    document.getElementById('dem-hud-canopy-night-bright-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-night-bright-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(2);
      if (WM.canopy) WM.canopy.setTreeNightBrightness(v);
    });

    document.getElementById('dem-hud-canopy-night-contrast-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-night-contrast-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(2);
      if (WM.canopy) WM.canopy.setTreeNightContrast(v);
    });

    document.getElementById('dem-hud-canopy-tree-volumetric-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-tree-volumetric-val');
      if (lbl) lbl.textContent = v === 0 ? 'Плоские (0%)' : v + '%';
      if (WM.canopy) WM.canopy.setTreeVolumetric(v / 100);
    });

    // Инпут цвета обводки/контура
    document.getElementById('dem-hud-canopy-tree-stroke-color')?.addEventListener('input', (e) => {
      if (WM.canopy) WM.canopy.setTreeStrokeColor(e.target.value);
    });

    // Слайдер проникания в холст
    document.getElementById('dem-hud-canopy-paper-bleed-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-paper-bleed-val');
      if (lbl) lbl.textContent = v === 0 ? 'Выкл (0%)' : v + '%';
      if (WM.canopy) WM.canopy.setTreePaperBleed(v / 100);
    });

    // Слайдер масштаба одиночных / опушки
    document.getElementById('dem-hud-canopy-edge-scale-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-edge-scale-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(2);
      if (WM.canopy) WM.canopy.setTreeEdgeScale(v);
    });

    // Слайдер масштаба центра скоплений
    document.getElementById('dem-hud-canopy-massif-scale-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-massif-scale-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(2);
      if (WM.canopy) WM.canopy.setTreeMassifScale(v);
    });

    document.getElementById('dem-hud-canopy-fill-warmth-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-fill-warmth-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeFillWarmth(v / 100);
    });

    document.getElementById('dem-hud-canopy-fill-bright-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-fill-bright-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeFillBrightness(v / 100);
    });

    document.getElementById('dem-hud-canopy-fill-sat-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-fill-sat-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeFillSaturation(v / 100);
    });

    document.getElementById('dem-hud-toggle-water-tint')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ waterTintEnabled: e.target.checked });
      const sub = document.getElementById('dem-hud-water-tint-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      const badge = document.getElementById('dem-hud-water-fill-status-badge');
      if (badge) {
        badge.textContent = e.target.checked ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', e.target.checked);
      }
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-water-tint-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({ waterTintColor: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-water-tint-blend')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ waterTintBlendMode: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-water-tint-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-water-tint-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      WM.demRelief.setConfig({ waterTintOpacity: v / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-water-tint-coverage-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-water-tint-coverage-val');
      if (lbl) lbl.textContent = v + '%';
      WM.demRelief.setConfig({ waterTintCoverage: v / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-canopy-slope-suppress-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-slope-suppress-val');
      if (lbl) lbl.textContent = v === 0 ? '0% (Выкл)' : v + '%';
      if (WM.canopy) WM.canopy.setTreeSlopeSuppression(v / 100);
    });

    document.getElementById('dem-hud-canopy-slope-tol-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-slope-tol-val');
      const deg = Math.round(Math.atan(v / 100) * 180 / Math.PI);
      if (lbl) lbl.textContent = `~${deg}° (${(v / 100).toFixed(2)})`;
      if (WM.canopy) WM.canopy.setTreeSlopeTolerance(v / 100);
    });

    document.getElementById('dem-hud-canopy-min-height')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeMinH(e.target.value);
    });

    document.getElementById('dem-hud-canopy-forest-only-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-forest-only-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setForestOnlyThreshold(v / 100);
    });

    document.getElementById('toggle-hud-canopy-tree-clustering')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeClustering(e.target.checked);
    });

    // =========================================================================
    // СЕЛЕКТОР ПРЕСЕТОВ
    // =========================================================================
    document.getElementById('dem-hud-preset-select')?.addEventListener('change', (e) => {
      const chosenId = e.target.value;
      if (!chosenId) {
        try { localStorage.removeItem('wm_active_3d_preset'); } catch (err) {}
        WM.demPresets?.syncSelectUI('');
        return;
      }
      const preset = WM.demPresets?.getAllPresets().find(p => p.id === chosenId);
      if (preset) {
        WM.demPresets.applyProfile(preset);
      }
    });

    // =========================================================================
    // ЭКСПОРТ ВСЕЙ 3D-СЦЕНЫ В JSON
    // =========================================================================
    document.getElementById('btn-dem-hud-export')?.addEventListener('click', () => {
      const defaultName = `3D Сцена (${new Date().toLocaleDateString('ru')})`;
      const chosenName = prompt('Введите название 3D-пресета (профиля):', defaultName);
      if (chosenName === null) return; // пользователь нажал «Отмена»

      const fullProfile = WM.demPresets.buildCurrentProfile(chosenName);
      
      // Сохраняем в список пользовательских пресетов, чтобы сразу отобразился в селекторе
      WM.demPresets.saveCustomPreset(fullProfile);
      WM.demPresets.syncSelectUI(fullProfile.id);

      // Формируем чистый JSON с отступами, удобный для вставки в код
      const jsonStr = JSON.stringify(fullProfile, null, 2);
      const safeFileName = fullProfile.name.replace(/[^\w\dа-яёА-ЯЁ\-_]/g, '_').slice(0, 40);

      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `3D_Preset_${safeFileName}.json`;
      a.click();
      URL.revokeObjectURL(url);

      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`💾 Пресет «${fullProfile.name}» экспортирован!`);
      }
    });

    // =========================================================================
    // ИМПОРТ ВСЕЙ 3D-СЦЕНЫ ИЗ JSON
    // =========================================================================
    const importInput = document.getElementById('dem-hud-import-input');
    document.getElementById('btn-dem-hud-import')?.addEventListener('click', () => {
      importInput?.click();
    });

    if (importInput) {
      importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();

        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result);
            if (typeof parsed !== 'object' || parsed === null) {
              throw new Error('Файл не содержит валидного JSON объекта');
            }

            // Проверяем: новый комплексный пресет или старый одиночный конфиг demRelief
            if (
              parsed.demRelief || parsed.terrainDecor || parsed.clouds || parsed.canopy ||
              parsed.viewshed || parsed.vectorRoads || parsed.terrainOverlays
            ) {
              // Новый формат
              if (!parsed.id) {
                parsed.id = 'imported_' + Date.now();
              }
              if (!parsed.name) {
                parsed.name = file.name.replace(/\.[^/.]+$/, '').replace(/^3D_Preset_/, '');
              }
              WM.demPresets.saveCustomPreset(parsed);
              WM.demPresets.applyProfile(parsed);
            } else {
              // Обратная совместимость со старыми файлами настроек только рельефа
              WM.demRelief.setConfig(parsed);
              scheduleHudRender();
              if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Настройки рельефа загружены');
            }
          } catch (err) {
            alert('Ошибка чтения файла настроек: ' + err.message);
          }
          importInput.value = '';
        };
        reader.readAsText(file);
      });
    }





    const btnRefresh = document.getElementById('btn-dem-hud-refresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        btnRefresh.classList.add('spinning');

        // Вызываем умную догрузку для всех 4 компонентов рельефа
        const demCount = await WM.demRelief.reloadMissingTiles({ force: true });
        const treesCount = WM.canopy?.reloadMissingTiles ? WM.canopy.reloadMissingTiles() : 0;
        const roadsCount = WM.vectorRoads?.reloadMissingTiles ? WM.vectorRoads.reloadMissingTiles() : 0;
        if (WM.terrainOverlays && WM.terrainOverlays.clearCache) {
          WM.terrainOverlays.clearCache();
        }

        setTimeout(() => btnRefresh.classList.remove('spinning'), 600);

        const totalMissing = demCount + treesCount + roadsCount;
        if (WM.ui && WM.ui.showToast) {
          if (totalMissing > 0) {
            WM.ui.showToast(`🔄 Догрузка: рельеф/вода (${demCount}), лес (${treesCount}), дороги (${roadsCount})`);
          } else {
            WM.ui.showToast('✅ Все слои рельефа, деревьев и дорог уже загружены');
          }
        }
      });
    }

    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        const tone = ch.dataset.tone;
        WM.demRelief.setConfig({ colorTone: tone });
        renderHudUI();
        scheduleLiveHillshade();
        const toneTitles = {
          none: '⚪ Фильтр выключен',
          imhof: '🇨🇭 Тон: Имхоф (Swisstopo)',
          slate: '🏔️ Тон: Сланец (Нордик)',
          vintage: '📜 Тон: Винтажный атлас',
          amber: '🌅 Тон: Янтарь (Золотой час)',
          emerald: '🌲 Тон: Хвоя (Альпийский бор)',
          monochrome: '✒️ Тон: Монохромная литография',
          sandstone: '🏜️ Тон: Песчаник (Каньон)',
          glacier: '❄️ Тон: Ледник (Арктика)',
          volcano: '🌋 Тон: Базальт (Вулкан)'
        };
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(toneTitles[tone] || 'Художественный фильтр изменён');
        }
      });
    });

    document.getElementById('toggle-hud-canopy-height')?.addEventListener('change', (e) => {
      if (WM.canopy) {
        WM.canopy.setHeightEnabled(e.target.checked);
        renderHudUI();
      }
    });

    document.getElementById('toggle-hud-canopy-mask')?.addEventListener('change', (e) => {
      if (WM.canopy) {
        WM.canopy.setMaskEnabled(e.target.checked);
        renderHudUI();
      }
    });

    document.getElementById('toggle-hud-canopy-trees')?.addEventListener('change', (e) => {
      if (WM.canopy) {
        WM.canopy.setTreesEnabled(e.target.checked);
        const sub = document.getElementById('dem-hud-canopy-trees-sub');
        if (sub) sub.hidden = !e.target.checked;
        renderHudUI();
      }
    });

        // Внутри initHudEvents():
    document.getElementById('toggle-hud-canopy-tree-autodense')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeAutoDense(e.target.checked);
      const sub = document.getElementById('dem-hud-canopy-autodense-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
    });

    document.getElementById('dem-hud-canopy-autodense-scale-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-autodense-scale-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(2);
      if (WM.canopy) WM.canopy.setTreeAutoDenseScale(v);
    });

    document.getElementById('dem-hud-canopy-autodense-thin-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-autodense-thin-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeAutoDenseThinning(v / 100);
    });

    document.getElementById('dem-hud-canopy-tree-style')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (WM.canopy) WM.canopy.setTreeStyle(val);
      if (typeof window.renderCanopyHudUI === 'function') {
        window.renderCanopyHudUI();
      }
      if (val === 'real' && WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🌍 Включены реальные породы леса (GLC_FCS30D)', 2500);
      }
    });
    document.getElementById('dem-hud-canopy-tree-color')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeColor(e.target.value);
    });

    document.getElementById('dem-hud-canopy-tree-density-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-tree-density-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeDensity(v / 100);
    });

    document.getElementById('dem-hud-canopy-tree-scale-slider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('dem-hud-canopy-tree-scale-val');
      if (lbl) lbl.textContent = '×' + v.toFixed(1);
      if (WM.canopy && WM.canopy.setTreeScale) {
        WM.canopy.setTreeScale(v);
      }
    });

    document.getElementById('dem-hud-canopy-tree-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-tree-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setTreeOpacity(v / 100);
    });

    document.getElementById('toggle-hud-canopy-tree-shadows')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setTreeShadows(e.target.checked);
    });

    document.getElementById('dem-hud-canopy-height-opacity')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-height-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setHeightOpacity(v / 100);
    });

    document.getElementById('dem-hud-canopy-mask-opacity')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      const lbl = document.getElementById('dem-hud-canopy-mask-opacity-val');
      if (lbl) lbl.textContent = v + '%';
      if (WM.canopy) WM.canopy.setMaskOpacity(v / 100);
    });

    document.getElementById('dem-hud-canopy-tint')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setMaskTint(e.target.value);
    });

    document.getElementById('dem-hud-canopy-blend')?.addEventListener('change', (e) => {
      if (WM.canopy) WM.canopy.setBlendMode(e.target.value);
    });

    // События слайдеров штриховки
    document.getElementById('dem-hud-hachure-type-select')?.addEventListener('change', (e) => {
      const isHyb = (e.target.value === 'hybrid');
      const wrapHyb = document.getElementById('dem-hud-hachure-hybrid-wrap');
      if (wrapHyb) wrapHyb.hidden = !isHyb;
      WM.demRelief.setConfig({ hachureType: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-hyb-thresh-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-hyb-thresh-val').textContent = val + '°';
      WM.demRelief.setConfig({ hachureHybridThresh: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-hyb-sharp-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-hyb-sharp-val').textContent = val + '%';
      WM.demRelief.setConfig({ hachureHybridSharpness: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-len-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-hachure-len-val').textContent = '×' + val.toFixed(1);
      WM.demRelief.setConfig({ hachureLength: val });
      scheduleLiveHillshade();
    });

    // События слайдеров карандашной обводки
    document.getElementById('dem-hud-outline-density-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-density-val').textContent = val + '%';
      WM.demRelief.setConfig({ outlineDensity: val / 100, _skipHud: true });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-texture-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-texture-val').textContent = val + '%';
      WM.demRelief.setConfig({ outlineTexture: val / 100, _skipHud: true });
      scheduleLiveHillshade();
    });

    // Кнопка облаков в шапке панели
    document.getElementById('dem-hud-toggle-cl')?.addEventListener('click', () => {
      if (!WM.clouds) return;
      const next = WM.clouds.toggle();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(next ? '☁️ 3D Облака включены' : '☁️ 3D Облака скрыты');
      }
    });

    // Чекбокс в спойлере
    document.getElementById('dem-hud-toggle-clouds')?.addEventListener('change', (e) => {
      if (!WM.clouds) return;
      WM.clouds.setEnabled(e.target.checked);
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(e.target.checked ? '☁️ 3D Облака включены' : '☁️ 3D Облака скрыты');
      }
    });

    if (WM.clouds) {
      const bindClSlider = (id, prop, transform, format) => {
        document.getElementById(id)?.addEventListener('input', (e) => {
          const val = transform(parseFloat(e.target.value));
          const valEl = document.getElementById(id.replace('-slider', '-val'));
          if (valEl) valEl.textContent = format(e.target.value);
          WM.clouds.setConfig({ [prop]: val });
        });
      };

      bindClSlider('dem-hud-clouds-scale-slider', 'scale', v => v, v => '×' + parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-coverage-slider', 'coverage', v => v / 100, v => Math.round(v) + '%');
      document.getElementById('dem-hud-toggle-clouds-weather-cover')?.addEventListener('change', e => WM.clouds.setConfig({ coverageFromWeather: e.target.checked }));
      bindClSlider('dem-hud-clouds-density-slider', 'density', v => v, v => parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-isolation-slider', 'clusterIsolation', v => v, v => parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-curl-slider', 'curl', v => v, v => parseFloat(v).toFixed(2));

      bindClSlider('dem-hud-clouds-bright-slider', 'cloudBrightness', v => v, v => '×' + parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-contrast-slider', 'cloudContrast', v => v, v => '×' + parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-shadow-slider', 'shadowOpacity', v => v / 100, v => Math.round(v) + '%');
      bindClSlider('dem-hud-clouds-shadow-bright-slider', 'shadowBrightness', v => v, v => '×' + parseFloat(v).toFixed(2));

      // НОВЫЕ СЛУШАТЕЛИ:
      const fmtTempSigned = v => (parseFloat(v) > 0 ? '+' : '') + parseFloat(v).toFixed(2);
      bindClSlider('dem-hud-clouds-temp-light-slider', 'cloudTempLight', v => v, fmtTempSigned);
      bindClSlider('dem-hud-clouds-temp-shadow-slider', 'cloudTempShadow', v => v, fmtTempSigned);
      bindClSlider('dem-hud-clouds-shadow-height-slider', 'shadowHeight', v => v, v => parseFloat(v).toFixed(1) + ' км');

      document.getElementById('dem-hud-clouds-hatch-style-select')?.addEventListener('change', e => WM.clouds.setConfig({ hatchStyle: e.target.value }));
      bindClSlider('dem-hud-clouds-hatch-spacing-slider', 'hatchSpacing', v => v, v => parseFloat(v).toFixed(1) + ' px');
      bindClSlider('dem-hud-clouds-hatch-thick-slider', 'hatchThickness', v => v, v => parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-hatch-len-slider', 'hatchLength', v => v, v => parseFloat(v).toFixed(1));
      bindClSlider('dem-hud-clouds-hatch-thin-slider', 'hatchThinning', v => v / 100, v => Math.round(v) + '%');
      bindClSlider('dem-hud-clouds-hatch-curv-slider', 'hatchCurvature', v => v, v => parseFloat(v).toFixed(2));

      document.getElementById('dem-hud-clouds-ink-color')?.addEventListener('input', e => {
        WM.clouds.setConfig({ inkColor: e.target.value });
      });

      document.getElementById('dem-hud-clouds-wind-source-select')?.addEventListener('change', e => {
        const src = e.target.value;
        const wrapW = document.getElementById('dem-hud-clouds-manual-wind-wrap');
        if (wrapW) wrapW.hidden = (src !== 'manual');
        WM.clouds.setConfig({ windSource: src });
      });
      bindClSlider('dem-hud-clouds-speed-slider', 'speed', v => v, v => '×' + parseFloat(v).toFixed(2));
      bindClSlider('dem-hud-clouds-wind-speed-slider', 'windSpeed', v => v, v => parseFloat(v).toFixed(1) + ' м/с');
      bindClSlider('dem-hud-clouds-wind-dir-slider', 'windDir', v => v, v => Math.round(v) + '°');

      document.getElementById('dem-hud-toggle-clouds-terrain')?.addEventListener('change', e => WM.clouds.setConfig({ terrain: e.target.checked }));
      bindClSlider('dem-hud-clouds-deflect-slider', 'mountainDeflection', v => v, v => parseFloat(v).toFixed(1));

      document.getElementById('btn-dem-hud-clouds-reset')?.addEventListener('click', () => {
        WM.clouds.resetConfig();
        renderHudUI();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('Настройки облаков сброшены по умолчанию');
      });

      document.getElementById('btn-dem-hud-clouds-copy-json')?.addEventListener('click', () => {
        const json = JSON.stringify(WM.clouds.getConfig(), null, 2);
        navigator.clipboard.writeText(json).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Настройки облаков скопированы в буфер!');
        });
      });
    }

    document.getElementById('dem-hud-dither-blend-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ditherBlendMode: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-hs')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ hillshadeEnabled: !cfg.hillshadeEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.hillshadeEnabled ? '⛰️ 3D-рельеф включён' : '⛰️ 3D-рельеф скрыт');
      }
    });

    // 2. Линии высот (горизонтали)
    document.getElementById('dem-hud-toggle-ct')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ contoursEnabled: !cfg.contoursEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.contoursEnabled ? '〰️ Горизонтали включены' : '〰️ Горизонтали скрыты');
      }
    });

    // 3. Лес (деревья)
    document.getElementById('dem-hud-toggle-trees')?.addEventListener('click', () => {
      if (WM.canopy) {
        const next = !WM.canopy.getSettings().treesEnabled;
        WM.canopy.setTreesEnabled(next);
        renderHudUI();
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(next ? '🌲 2D Лес включён' : '🌲 2D Лес скрыт');
        }
      }
    });

    // 4. Векторный слой дорог и топонимов OSM
    document.getElementById('dem-hud-toggle-roads')?.addEventListener('click', () => {
      if (WM.vectorRoads) {
        const next = WM.vectorRoads.toggle();
        renderHudUI();
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(next ? '🛤️ Векторный слой OSM включён' : '🛤️ Векторный слой OSM скрыт');
        }
      }
    });

    document.getElementById('dem-hud-roughness-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-roughness-val').textContent = val + '%';
      WM.demRelief.setConfig({ orenNayarRoughness: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-ink-bleed')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ inkBleed: e.target.checked });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-waterlining')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ waterlining: e.target.checked });
      const sub = document.getElementById('dem-hud-waterline-sub');
      if (sub) sub.hidden = !e.target.checked;
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-waterline-color')?.addEventListener('input', (e) => {
      cfg.waterlineColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-waterline-width-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-waterline-width-val').textContent = val.toFixed(1) + ' px';
      cfg.waterlineWidth = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-waterline-opacity-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-waterline-opacity-val').textContent = val + '%';
      cfg.waterlineOpacity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-formlines')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ formLinesEnabled: e.target.checked });
    });

    // Слушатели Openness
    document.getElementById('dem-hud-toggle-openness')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ opennessEnabled: e.target.checked });
      renderHudUI();
    });
    document.getElementById('dem-hud-openness-radius-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-openness-radius-val').textContent = v + '%';
      WM.demRelief.setConfig({ opennessRadius: v / 100 });
      scheduleLiveHillshade(); // <-- Добавьте вызов мгновенного перерендера
    });
    document.getElementById('dem-hud-openness-strength-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-openness-strength-val').textContent = v + '%';
      WM.demRelief.setConfig({ opennessStrength: v / 100 });
      scheduleLiveHillshade(); // <-- Добавьте вызов мгновенного перерендера
    });
    document.getElementById('dem-hud-openness-diff-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-openness-diff-val').textContent = v + '%';
      WM.demRelief.setConfig({ opennessDiff: v / 100 });
      scheduleLiveHillshade(); // <-- Добавьте вызов мгновенного перерендера
    });

    // Слушатели Radiosity
    document.getElementById('dem-hud-toggle-bounce')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ bounceEnabled: e.target.checked });
      renderHudUI();
    });
    document.getElementById('dem-hud-bounce-str-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-bounce-str-val').textContent = v + '%';
      WM.demRelief.setConfig({ bounceStrength: v / 100 });
    });

    // Слушатели Contact Hardening
    document.getElementById('dem-hud-toggle-contact-shadows')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contactShadowsEnabled: e.target.checked });
      renderHudUI();
    });
    document.getElementById('dem-hud-penumbra-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-penumbra-val').textContent = v + '%';
      WM.demRelief.setConfig({ penumbraScale: v / 100 });
    });

    document.getElementById('dem-hud-toggle-outline')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ outlineEnabled: e.target.checked });
      const sub = document.getElementById('dem-hud-outline-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      const badge = document.getElementById('dem-hud-outline-status-badge');
      if (badge) {
        badge.textContent = e.target.checked ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', e.target.checked);
      }
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-type-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ outlineType: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-blend-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ outlineBlendMode: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-color')?.addEventListener('input', (e) => {
      cfg.outlineColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-width-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-outline-width-val').textContent = val.toFixed(1) + ' px';
      cfg.outlineWidth = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-roughness-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-roughness-val').textContent = val + '%';
      cfg.outlineRoughness = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-threshold-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-threshold-val').textContent = val + '%';
      cfg.outlineThreshold = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-opacity-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-opacity-val').textContent = val + '%';
      cfg.outlineOpacity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-outline-lightmod-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-outline-lightmod-val').textContent = val + '%';
      cfg.outlineLightMod = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });



    // Слушатели дизеринга
    document.getElementById('dem-hud-toggle-dither')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ditherEnabled: e.target.checked });
      const sub = document.getElementById('dem-hud-dither-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      const badge = document.getElementById('dem-hud-dither-status-badge');
      if (badge) {
        badge.textContent = e.target.checked ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', e.target.checked);
      }
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-type-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ditherType: e.target.value });
      const wrapAngle = document.getElementById('dem-hud-dither-angle-wrap');
      if (wrapAngle) wrapAngle.hidden = (e.target.value === 'blue');
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-angle-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-angle-val').textContent = val + '°';
      cfg.ditherAngle = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-density-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-density-val').textContent = val + '%';
      cfg.ditherDensity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-lowcut-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-lowcut-val').textContent = val + '%';
      cfg.ditherLowCut = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });


    document.getElementById('dem-hud-dither-zone-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ditherZone: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-color')?.addEventListener('input', (e) => {
      cfg.ditherColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-scale-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-dither-scale-val').textContent = '×' + val.toFixed(1);
      cfg.ditherScale = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-thresh-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-thresh-val').textContent = val + '%';
      cfg.ditherThreshold = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-soft-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-soft-val').textContent = val + '%';
      cfg.ditherSoftness = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-dither-str-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-dither-str-val').textContent = val + '%';
      cfg.ditherStrength = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    // Режим освещения
    document.getElementById('dem-hud-sunmode-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ sunMode: e.target.value });
      renderHudUI();
      scheduleLiveHillshade();
    });

    // Слайдер Light Boost
    document.getElementById('dem-hud-light-boost-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-light-boost-val').textContent = '×' + val.toFixed(2);
      cfg.lightBoost = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    // Ручные цвета
    document.getElementById('dem-hud-manual-color-peak')?.addEventListener('input', (e) => {
      cfg.manualPeakColor = e.target.value;
      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-scale-mode')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({
        manualScaleMode: e.target.value,
        sunMode: 'manual'
      });
      renderHudUI();
      scheduleLiveHillshade();
    });

    const applyFixedElevInputs = () => {
      const inpMin = document.getElementById('dem-hud-manual-elev-min');
      const inpMax = document.getElementById('dem-hud-manual-elev-max');
      if (!inpMin || !inpMax) return;

      let minV = parseFloat(inpMin.value);
      let maxV = parseFloat(inpMax.value);
      if (isNaN(minV)) minV = 0;
      if (isNaN(maxV)) maxV = minV + 100;
      if (maxV <= minV) maxV = minV + 10;

      WM.demRelief.setConfig({
        manualScaleMode: 'fixed',
        manualElevMin: minV,
        manualElevMax: maxV,
        sunMode: 'manual',
        _skipHud: true
      });
      updateManualGradientPreview();
      scheduleLiveHillshade();
    };

    document.getElementById('dem-hud-manual-elev-min')?.addEventListener('input', applyFixedElevInputs);
    document.getElementById('dem-hud-manual-elev-max')?.addEventListener('input', applyFixedElevInputs);

    document.getElementById('dem-hud-manual-elev-min')?.addEventListener('change', () => renderHudUI());
    document.getElementById('dem-hud-manual-elev-max')?.addEventListener('change', () => renderHudUI());

    document.querySelectorAll('.dem-manual-elev-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const minV = parseFloat(btn.dataset.min);
        const maxV = parseFloat(btn.dataset.max);
        WM.demRelief.setConfig({
          manualScaleMode: 'fixed',
          manualElevMin: minV,
          manualElevMax: maxV,
          sunMode: 'manual'
        });
        renderHudUI();
        scheduleLiveHillshade();
      });
    });

    document.getElementById('btn-dem-hud-manual-grab-screen')?.addEventListener('click', () => {
      const stats = getViewportElevationStats();
      const minV = Math.floor(stats.minH);
      const maxV = Math.max(minV + 10, Math.ceil(stats.maxH));
      WM.demRelief.setConfig({
        manualScaleMode: 'fixed',
        manualElevMin: minV,
        manualElevMax: maxV,
        sunMode: 'manual'
      });
      renderHudUI();
      scheduleLiveHillshade();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`📐 Диапазон с экрана: ${minV}…${maxV} м`);
      }
    });

    document.getElementById('dem-hud-manual-color-mid')?.addEventListener('input', (e) => {
      cfg.manualMidColor = e.target.value;
      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-color-valley')?.addEventListener('input', (e) => {
      cfg.manualValleyColor = e.target.value;
      cfg.sunMode = 'manual';
      const selSun = document.getElementById('dem-hud-sunmode-select');
      if (selSun) selSun.value = 'manual';
      saveConfig();
      renderHudUI();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-color-shadow')?.addEventListener('input', (e) => {
      cfg.manualShadowColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    // Переход 1 (Низины -> Склоны): не даём позиции 1 зайти правее позиции 2
    document.getElementById('dem-hud-manual-blend-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-manual-blend-val').textContent = val + '%';
      cfg.manualLightBlend = val / 100;

      if ((cfg.manualLightBlend2 ?? 0.68) < cfg.manualLightBlend) {
        cfg.manualLightBlend2 = cfg.manualLightBlend;
        const s2 = document.getElementById('dem-hud-manual-blend2-slider');
        const v2 = document.getElementById('dem-hud-manual-blend2-val');
        if (s2) s2.value = val;
        if (v2) v2.textContent = val + '%';
      }

      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-softness-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-manual-softness-val').textContent = val + '%';
      cfg.manualLightSoftness = val / 100;
      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });

    // Переход 2 (Склоны -> Вершины): не даём позиции 2 зайти левее позиции 1
    document.getElementById('dem-hud-manual-blend2-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-manual-blend2-val').textContent = val + '%';
      cfg.manualLightBlend2 = val / 100;

      if ((cfg.manualLightBlend ?? 0.33) > cfg.manualLightBlend2) {
        cfg.manualLightBlend = cfg.manualLightBlend2;
        const s1 = document.getElementById('dem-hud-manual-blend-slider');
        const v1 = document.getElementById('dem-hud-manual-blend-val');
        if (s1) s1.value = val;
        if (v1) v1.textContent = val + '%';
      }

      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-softness2-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-manual-softness2-val').textContent = val + '%';
      cfg.manualLightSoftness2 = val / 100;
      saveConfig();
      updateManualGradientPreview();
      scheduleLiveHillshade();
    });





    document.getElementById('dem-hud-hachure-blend-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ hachureBlendMode: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-thinning-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-thinning-val').textContent = val + '%';
      cfg.hachureThinning = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });



    document.getElementById('dem-hud-contour-roughness-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-contour-roughness-val').textContent = val + '%';
      WM.demRelief.setConfig({ contourRoughness: val / 100 });
    });

    document.getElementById('dem-hud-contour-pressure-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-contour-pressure-val').textContent = val + '%';
      WM.demRelief.setConfig({ contourHandPressure: val / 100 });
    });

    document.getElementById('dbg-toggle-heatmap')?.addEventListener('change', (e) => {
      cfg.debugValley = e.target.checked;
      scheduleLiveHillshade(true);
    });



    // <-- ВСТАВИТЬ: обработчик плавности/охвата

    // Кнопка «Авто» Z-Factor: переключение и гарантированная смена подсветки
    const btnZAuto = document.getElementById('dem-hud-zfactor-auto-btn');
    if (btnZAuto) {
      btnZAuto.addEventListener('click', () => {
        cfg.zFactorAuto = !cfg.zFactorAuto;
        btnZAuto.classList.toggle('active', cfg.zFactorAuto);
        const sliderZ = document.getElementById('dem-hud-zfactor-slider');
        if (sliderZ) sliderZ.disabled = cfg.zFactorAuto;

        saveConfig();
        scheduleLiveHillshade();
        renderHudUI();
      });
    }

    const sliderZ = document.getElementById('dem-hud-zfactor-slider');
    if (sliderZ) {
      sliderZ.addEventListener('input', (e) => {
        cfg.zFactorAuto = false;
        if (btnZAuto) btnZAuto.classList.remove('active');
        cfg.zFactor = parseFloat(e.target.value);
        saveConfig();
        scheduleLiveHillshade();
        renderHudUI();
      });
    }

    document.getElementById('dem-hud-blendmode-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ blendMode: e.target.value });
    });

    document.getElementById('dem-hud-toggle-cast-shadows')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ castShadows: e.target.checked });
      const sub = document.getElementById('dem-hud-cast-shadows-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-shadow-reach')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-shadow-reach-val').textContent = val + '%';
      cfg.shadowReach = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-shadow-opacity')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-shadow-opacity-val').textContent = val + '%';
      cfg.shadowOpacity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-ao')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ambientOcclusion: e.target.checked });
      const sub = document.getElementById('dem-hud-ao-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-ao-strength-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-ao-strength-val').textContent = val + '%';
      WM.demRelief.setConfig({ aoStrength: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-ao-bleed-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-ao-bleed-val').textContent = val + '%';
      WM.demRelief.setConfig({ aoSlopeBleed: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-ao-radius-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-ao-radius-val').textContent = val + '%';
      WM.demRelief.setConfig({ aoRadius: val / 100 });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-svf')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ svfEnabled: e.target.checked });
      const sub = document.getElementById('dem-hud-svf-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-svf-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-svf-val').textContent = val + '%';
      WM.demRelief.setConfig({ svfStrength: val / 100 });
      scheduleLiveHillshade();
    });
    document.getElementById('dem-hud-toggle-hachure')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ hachureEnabled: e.target.checked });
      const sub = document.getElementById('dem-hud-hachure-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      const badge = document.getElementById('dem-hud-hachure-status-badge');
      if (badge) {
        badge.textContent = e.target.checked ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', e.target.checked);
      }
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-density-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-density-val').textContent = val + '%';
      cfg.hachureDensity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-opacity-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-opacity-val').textContent = val + '%';
      cfg.hachureOpacity = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-slope-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-slope-val').textContent = val + '%';
      cfg.hachureSlope = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-color')?.addEventListener('input', (e) => {
      cfg.hachureColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-hachure-lightmod-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hachure-lightmod-val').textContent = val + '%';
      cfg.hachureLightMod = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-light-wrap')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-light-wrap-val').textContent = val + '%';
      cfg.lightWrap = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-mdow')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ mdowEnabled: e.target.checked });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-imhof-defl-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-imhof-defl-val').textContent = val + '%';
      cfg.imhofDeflection = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-source-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ demSource: e.target.value });
    });

    document.getElementById('dem-hud-paper-grain-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-paper-grain-val').textContent = val + '%';
      cfg.paperGrain = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-contour-palette')?.addEventListener('change', (e) => {
      const val = e.target.value;
      const customColorWrap = document.getElementById('dem-hud-custom-color-wrap');
      if (customColorWrap) customColorWrap.hidden = (val !== 'custom');
      WM.demRelief.setConfig({ contourPalette: val });
    });

    document.getElementById('dem-hud-contour-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({ contourColor: e.target.value });
    });

    document.getElementById('dem-hud-contour-blend-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourBlendMode: e.target.value });
    });

    hud.querySelectorAll('.dem-hud-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderHudUI();
      });
    });

// Открытие полной панели настроек (погода/время/аэрозоль)
    document.getElementById('btn-viewshed-open-panel')?.addEventListener('click', () => {
      if (WM.viewshed && WM.viewshed.openPanel) {
        WM.viewshed.openPanel();
      }
    });





    document.getElementById('dem-hud-time-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const sliderVal = parseFloat(e.target.value);
      const mapCenter = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const curDate = new Date();
      
      const h = WM.timeWarp 
        ? WM.timeWarp.sliderToHour(sliderVal, mapCenter.lat, mapCenter.lng, curDate) 
        : (sliderVal / 60);

    document.getElementById('dem-hud-time-val').textContent = formatHourString(h, mapCenter.lat, mapCenter.lng, curDate);
      
      WM.demRelief.setConfig({
        manualTimeHour: h,
        sunMode: 'time',
        _skipHud: true
      });

      // Пересчёт зоны видимости при активном расчёте времени
      if (WM.viewshed && WM.viewshed.isActive && WM.viewshed.isActive()) {
        WM.viewshed.scheduleCompute();
      }
    });


      
    // Синхронизируем состояние UI только когда ползунок отпущен:
    document.getElementById('dem-hud-time-slider')?.addEventListener('change', () => {
      renderHudUI();
    });

    document.getElementById('dem-hud-date-input')?.addEventListener('change', (e) => {
      cfg.manualDateStr = e.target.value;
      cfg.sunMode = 'time';
      const sel = document.getElementById('dem-hud-sunmode-select');
      if (sel) sel.value = 'time';
      saveConfig();
      scheduleLiveHillshade();
      renderHudUI();
    });

    hud.querySelectorAll('.dem-season-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const season = btn.dataset.season;
        const curYear = new Date().getFullYear();
        let targetDate = '';
        if (season === 'summer') targetDate = `${curYear}-06-22`;
        else if (season === 'winter') targetDate = `${curYear}-12-22`;
        else {
          const t = new Date();
          const pad = n => String(n).padStart(2, '0');
          targetDate = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
        }
        cfg.manualDateStr = targetDate;
        const inputDate = document.getElementById('dem-hud-date-input');
        if (inputDate) inputDate.value = targetDate;
        cfg.sunMode = 'time';
        saveConfig();
        scheduleLiveHillshade();
        renderHudUI();
      });
    });



    // Пример для угла азимута:
    document.getElementById('dem-hud-azimuth-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-azimuth-val').textContent = val + '°';
      WM.demRelief.setConfig({ 
        sunAzimuth: val, 
        sunMode: 'manual', 
        _skipHud: true 
      });
    });

    document.getElementById('dem-hud-altitude-slider')?.addEventListener('input', (e) => {
      markSliderScrubbing();
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-altitude-val').textContent = val + '°';
      WM.demRelief.setConfig({ 
        sunAltitude: val, 
        sunMode: 'manual', 
        _skipHud: true 
      });
    });
    document.getElementById('dem-hud-hs-opacity')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hs-opacity-val').textContent = val + '%';
      WM.demRelief.setConfig({ hillshadeOpacity: val / 100 });
    });

    hud.querySelectorAll('.dem-smooth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        WM.demRelief.setConfig({ smoothMode: btn.dataset.smooth });
        renderHudUI();
        scheduleLiveHillshade();
      });
    });

    document.getElementById('dem-hud-hypso-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ hypsoMode: e.target.value });
    });

    document.getElementById('dem-hud-step-select')?.addEventListener('change', (e) => {
      const v = e.target.value;
      WM.demRelief.setConfig({ contourStep: v === 'auto' ? 'auto' : parseInt(v, 10) });
    });

    document.getElementById('dem-hud-width-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-width-val').textContent = val.toFixed(1) + ' px';
      WM.demRelief.setConfig({ contourWidth: val });
    });

    document.getElementById('dem-hud-contour-style-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourStyle: e.target.value });
    });

    document.getElementById('dem-hud-contour-smooth-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourSmoothing: e.target.value });
    });

    document.getElementById('dem-hud-toggle-taper')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ taperWithElevation: e.target.checked });
      const sub = document.getElementById('dem-hud-taper-strength-wrap');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
    });

    document.getElementById('dem-hud-taper-dir-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ taperDirection: e.target.value });
    });

    document.getElementById('dem-hud-taper-strength-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-taper-strength-val').textContent = val + '%';
      WM.demRelief.setConfig({ taperStrength: val / 100 });
    });

    document.getElementById('dem-hud-toggle-cliff-hairlines')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ cliffHairlines: e.target.checked });
    });

    document.getElementById('dem-hud-ct-opacity')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-ct-opacity-val').textContent = val + '%';
      WM.demRelief.setConfig({ contourOpacity: val / 100 });
    });

    document.getElementById('dem-hud-toggle-labels')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ showLabels: e.target.checked });
    });

    document.getElementById('dem-hud-toggle-labels')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ showLabels: e.target.checked });
      const sub = document.getElementById('dem-hud-labels-sub');
      if (sub) sub.classList.toggle('is-disabled', !e.target.checked);
      const badge = document.getElementById('dem-hud-labels-status-badge');
      if (badge) {
        badge.textContent = e.target.checked ? 'Вкл' : 'Выкл';
        badge.classList.toggle('active', e.target.checked);
      }
    });

    document.getElementById('dem-hud-label-scope-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelScope: e.target.value });
    });

    document.getElementById('dem-hud-label-orient-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelOrient: e.target.value });
    });

    document.getElementById('dem-hud-label-style-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelStyle: e.target.value });
      const wrapHalo = document.getElementById('dem-hud-label-halo-width-wrap');
      if (wrapHalo) wrapHalo.classList.toggle('is-disabled', e.target.value === 'break');
    });

    document.getElementById('dem-hud-label-density-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-label-density-val').textContent = val + '%';
      WM.demRelief.setConfig({ contourLabelDensity: val / 100, _skipHud: true });
    });

    document.getElementById('dem-hud-label-size-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-label-size-val').textContent = val.toFixed(1) + ' px';
      WM.demRelief.setConfig({ contourLabelSize: val, _skipHud: true });
    });

    document.getElementById('dem-hud-label-halo-width-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-label-halo-width-val').textContent = val.toFixed(1) + ' px';
      WM.demRelief.setConfig({ contourLabelHaloWidth: val, _skipHud: true });
    });

    document.getElementById('dem-hud-label-color-mode')?.addEventListener('change', (e) => {
      const wrapCol = document.getElementById('dem-hud-label-color-wrap');
      if (wrapCol) wrapCol.classList.toggle('is-disabled', e.target.value !== 'custom');
      WM.demRelief.setConfig({ contourLabelColorMode: e.target.value });
    });

    document.getElementById('dem-hud-label-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({
        contourLabelColorMode: 'custom',
        contourLabelColor: e.target.value,
        _skipHud: true
      });
      const selMode = document.getElementById('dem-hud-label-color-mode');
      if (selMode) selMode.value = 'custom';
      document.getElementById('dem-hud-label-color-wrap')?.classList.remove('is-disabled');
    });

    document.getElementById('dem-hud-label-halo-color')?.addEventListener('input', (e) => {
      WM.demRelief.setConfig({ contourLabelHaloColor: e.target.value, _skipHud: true });
    });

    document.getElementById('dem-hud-toggle-label-break')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelBreak: e.target.checked });
    });

    document.getElementById('dem-hud-toggle-label-unit')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelUnit: e.target.checked });
    });

    document.getElementById('dem-hud-toggle-label-bold')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourLabelBold: e.target.checked });
    });

    if (WM.terrainDecor && WM.terrainDecor.initUI) {
      WM.terrainDecor.initUI();
    }
  }

  // =========================================================================
  // ПУБЛИЧНЫЙ API
  // =========================================================================
  function isPeakViewForeground() {
    return !!(WM.peakView && WM.peakView.isOpen && WM.peakView.isOpen() && !WM.peakView.isMinimized());
  }
 function isDemActive() {
    if (!WM.map) return false;
    const hsOn = hillshadeLayerInstance && WM.map.hasLayer(hillshadeLayerInstance);
    const ctOn = contoursLayerInstance && WM.map.hasLayer(contoursLayerInstance);
    return !!(cfg.hillshadeEnabled || cfg.contoursEnabled || hsOn || ctOn);
  }

  let _demNotifyTimer = null;
  function notifyDemChange(immediate = false, extraDetail = null) {
    const fire = () => {
      try {
        window.dispatchEvent(new CustomEvent('wm:dem-change', {
          detail: Object.assign({ active: isDemActive() }, extraDetail || {})
        }));
      } catch (e) {}
    };
    if (immediate) {
      clearTimeout(_demNotifyTimer);
      fire();
    } else {
      clearTimeout(_demNotifyTimer);
      _demNotifyTimer = setTimeout(fire, 140);
    }
  }

 const RAD_DEG = Math.PI / 180;
 const FAST_ZOOMS = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5];

  function getElevationAtLatLng(lat, lng) {
    if (!WM.map || (paddedDemMemoryCache.size === 0 && demTileMemoryCache.size === 0)) return null;
    if (!isFinite(lat) || !isFinite(lng)) return null;

    const currentZ = Math.round(WM.map.getZoom());
    const cappedZ = Math.max(5, Math.min(currentZ, 17));
    const srcKey = cfg.demSource || 'fabdem';

    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin(clampedLat * RAD_DEG);
    const normX = (lng + 180) / 360;
    const normY = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);

    const tryZoom = (z) => {
      const worldPx = 256 * (1 << z);
      const px = normX * worldPx;
      const py = normY * worldPx;
      const tx = Math.floor(px / 256);
      const ty = Math.floor(py / 256);
      const key = `${srcKey}:${z}:${tx}:${ty}`;
      const lx = px - tx * 256;
      const ly = py - ty * 256;

      const cv = getPaddedDemCache(key);
      if (cv && !cv._isEmptyFallback) {
        const B = cv._pad || 0;
        const S = cv._tileSize || 256;
        const scale = S / 256;
        const P = cv.width;

        let data = cv._demData;
        if (!data) {
          data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data;
          cv._demData = data;
        }

        const fx = B + lx * scale;
        const fy = B + ly * scale;
        const x0 = Math.max(0, Math.min(P - 1, fx | 0));
        const y0 = Math.max(0, Math.min(P - 1, fy | 0));
        const x1 = Math.min(P - 1, x0 + 1);
        const y1 = Math.min(P - 1, y0 + 1);
        const dx = fx - x0;
        const dy = fy - y0;

        const i00 = (y0 * P + x0) * 4;
        if (data[i00 + 3] >= 30) {
          const r00 = (data[i00] * 256.0 + data[i00 + 1] + data[i00 + 2] / 256.0) - 32768.0;
          const h00 = r00 > -1000.0 ? r00 : 0.0;
          const i10 = (y0 * P + x1) * 4;
          const i01 = (y1 * P + x0) * 4;
          const i11 = (y1 * P + x1) * 4;
          const h10 = data[i10 + 3] >= 30 ? Math.max(0, (data[i10] * 256.0 + data[i10 + 1] + data[i10 + 2] / 256.0) - 32768.0) : h00;
          const h01 = data[i01 + 3] >= 30 ? Math.max(0, (data[i01] * 256.0 + data[i01 + 1] + data[i01 + 2] / 256.0) - 32768.0) : h00;
          const h11 = data[i11 + 3] >= 30 ? Math.max(0, (data[i11] * 256.0 + data[i11 + 1] + data[i11 + 2] / 256.0) - 32768.0) : h01;
          return (h00 * (1 - dx) + h10 * dx) * (1 - dy) + (h01 * (1 - dx) + h11 * dx) * dy;
        }
      }

      const rawImg = getDemMemoryCache(key);
      if (rawImg && !rawImg._isEmptyFallback) {
        const { grid, w, h } = getParentHeightGrid(rawImg);
        const fx = (lx / 256) * w;
        const fy = (ly / 256) * h;
        const x0 = Math.max(0, Math.min(w - 1, fx | 0));
        const y0 = Math.max(0, Math.min(h - 1, fy | 0));
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);
        const dx = fx - x0;
        const dy = fy - y0;

        const h00 = grid[y0 * w + x0];
        if (!isNaN(h00)) {
          const h10 = grid[y0 * w + x1];
          const h01 = grid[y1 * w + x0];
          const h11 = grid[y1 * w + x1];
          const v00 = h00 > -1000 ? Math.max(0, h00) : 0;
          const v10 = !isNaN(h10) && h10 > -1000 ? Math.max(0, h10) : v00;
          const v01 = !isNaN(h01) && h01 > -1000 ? Math.max(0, h01) : v00;
          const v11 = !isNaN(h11) && h11 > -1000 ? Math.max(0, h11) : v01;
          return (v00 * (1 - dx) + v10 * dx) * (1 - dy) + (v01 * (1 - dx) + v11 * dx) * dy;
        }
      }
      return null;
    };

    const zList = [cappedZ, cappedZ - 1, cappedZ + 1, cappedZ - 2];
    for (let i = 0; i < zList.length; i++) {
      const z = zList[i];
      if (z < 5 || z > 17) continue;
      const v = tryZoom(z);
      if (v !== null) return v;
    }
    for (let i = 0; i < FAST_ZOOMS.length; i++) {
      const z = FAST_ZOOMS[i];
      if (z === cappedZ || z === cappedZ - 1 || z === cappedZ + 1 || z === cappedZ - 2) continue;
      const v = tryZoom(z);
      if (v !== null) return v;
    }
    return null;
  }

  // Прямая выборка матрицы высот для одного тайла (в 20-30x быстрее для TreeEngine.buildPack)
  function sampleTileGrid(z, tx, ty, gStep, gN, padN) {
    if (z < 5 || z > 17) return null;
    const srcKey = cfg.demSource || 'fabdem';
    const cv = getPaddedDemCache(`${srcKey}:${z}:${tx}:${ty}`);
    if (!cv || cv._isEmptyFallback) return null;

    const B = cv._pad || 0;
    const S = cv._tileSize || 256;
    const scale = S / 256;
    const P = cv.width;
    if (padN * gStep * scale > B) return null;

    let data = cv._demData;
    if (!data) {
      data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data;
      cv._demData = data;
    }

    const GW = gN + 1 + padN * 2;
    const H = new Float32Array(GW * GW);
    let sum = 0, cnt = 0;

    for (let j = 0; j < GW; j++) {
      const py = Math.max(0, Math.min(P - 1, Math.round(B + (j - padN) * gStep * scale)));
      const rowOff = py * P;
      const outOff = j * GW;
      for (let i = 0; i < GW; i++) {
        const px = Math.max(0, Math.min(P - 1, Math.round(B + (i - padN) * gStep * scale)));
        const idx = (rowOff + px) * 4;
        if (data[idx + 3] < 30) {
          H[outOff + i] = NaN;
        } else {
          const raw = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
          const h = raw > -1000.0 ? raw : 0.0;
          H[outOff + i] = h;
          sum += h;
          cnt++;
        }
      }
    }
    if (cnt === 0) return null;
    const fallbackH = sum / cnt;
    if (cnt < GW * GW) {
      for (let i = 0; i < H.length; i++) if (isNaN(H[i])) H[i] = fallbackH;
    }
    return H;
  }

  function samplePathProfile(points, opts = {}) {
    if (!WM.map || !points || points.length < 2) return null;

    const maxSamples = opts.maxSamples || 96;
    const nSegs = points.length - 1;
    const segHoriz = new Float64Array(nSegs);
    let totalHoriz = 0;

    for (let i = 0; i < nSegs; i++) {
      const d = L.latLng(points[i].lat, points[i].lng).distanceTo(L.latLng(points[i + 1].lat, points[i + 1].lng));
      segHoriz[i] = d;
      totalHoriz += d;
    }

    if (totalHoriz < 0.1) {
      const e0 = getElevationAtLatLng(points[0].lat, points[0].lng);
      return {
        samples: [
          { lat: points[0].lat, lng: points[0].lng, horizDist: 0, dist3d: 0, elev: e0, ratio: 0 },
          { lat: points[nSegs].lat, lng: points[nSegs].lng, horizDist: 0, dist3d: 0, elev: e0, ratio: 1 }
        ],
        totalHoriz: 0,
        total3d: 0,
        segmentDists3d: Array.from(segHoriz),
        cumDists3d: new Array(points.length).fill(0),
        ascent: 0,
        descent: 0,
        minElev: e0 !== null ? e0 : 0,
        maxElev: e0 !== null ? e0 : 0,
        hasData: e0 !== null,
        isPartial: e0 === null
      };
    }

    const samples = [];
    const segmentDists3d = new Array(nSegs).fill(0);
    const cumDists3d = new Array(points.length).fill(0);

    let cumHoriz = 0;
    let cum3d = 0;
    let prevSample = null;
    let validCount = 0;
    let missingCount = 0;

    for (let s = 0; s < nSegs; s++) {
      const pA = points[s];
      const pB = points[s + 1];
      const dSeg = segHoriz[s];
      const subSteps = Math.max(1, Math.round((dSeg / totalHoriz) * maxSamples));
      let seg3d = 0;

      for (let k = (s === 0 ? 0 : 1); k <= subSteps; k++) {
        const t = k / subSteps;
        const lat = pA.lat + (pB.lat - pA.lat) * t;
        const lng = pA.lng + (pB.lng - pA.lng) * t;
        const hDist = cumHoriz + dSeg * t;
        const elev = getElevationAtLatLng(lat, lng);

        if (elev !== null) validCount++;
        else missingCount++;

        if (prevSample) {
          const dH = hDist - prevSample.horizDist;
          const dZ = (elev !== null && prevSample.elev !== null) ? (elev - prevSample.elev) : 0;
          const d3 = Math.hypot(dH, dZ);
          cum3d += d3;
          seg3d += d3;
        }

        const item = { lat, lng, horizDist: hDist, dist3d: cum3d, elev, ratio: 0 };
        samples.push(item);
        prevSample = item;
      }

      cumHoriz += dSeg;
      segmentDists3d[s] = seg3d;
      cumDists3d[s + 1] = cum3d;
    }

    const total3d = cum3d || totalHoriz;
    let minElev = Infinity;
    let maxElev = -Infinity;
    let ascent = 0;
    let descent = 0;
    let refElev = null;

    // Порог сглаживания микрошума квантования (1.5 м)
    const DEADBAND = 1.5;

    for (let i = 0; i < samples.length; i++) {
      const it = samples[i];
      it.ratio = total3d > 0 ? (it.dist3d / total3d) : (i / Math.max(1, samples.length - 1));
      if (it.elev !== null) {
        if (it.elev < minElev) minElev = it.elev;
        if (it.elev > maxElev) maxElev = it.elev;
        if (refElev === null) {
          refElev = it.elev;
        } else {
          const diff = it.elev - refElev;
          if (diff > DEADBAND) {
            ascent += diff;
            refElev = it.elev;
          } else if (diff < -DEADBAND) {
            descent += -diff;
            refElev = it.elev;
          }
        }
      }
    }

    if (minElev === Infinity) {
      minElev = 0;
      maxElev = 0;
    }

    return {
      samples,
      totalHoriz,
      total3d,
      segmentDists3d,
      cumDists3d,
      ascent,
      descent,
      minElev,
      maxElev,
      hasData: validCount >= 2,
      isPartial: missingCount > 0
    };
  }

  const failedPrefetchTiles = new Map();
  const FAILED_PREFETCH_TTL = 60000;
  const _pathPrefetchTimers = new Map();

  function prefetchPathDem(points, zoomHint, onDone, slotKey = 'default') {
    if (!WM.map || !points || points.length < 2) return;
    clearTimeout(_pathPrefetchTimers.get(slotKey));
    _pathPrefetchTimers.set(slotKey, setTimeout(async () => {
      _pathPrefetchTimers.delete(slotKey);
      if (!WM.map || navigator.onLine === false) return;
      const srcKey = cfg.demSource || 'mapterhorn';
      const nSegs = points.length - 1;
      const segLengths = new Float64Array(nSegs);
      let totalHoriz = 0;

      for (let i = 0; i < nSegs; i++) {
        const d = L.latLng(points[i].lat, points[i].lng).distanceTo(L.latLng(points[i + 1].lat, points[i + 1].lng));
        segLengths[i] = d;
        totalHoriz += d;
      }

      if (totalHoriz > 2500000 || totalHoriz < 1) return;

      let z = Math.min(15, Math.max(6, Math.round(zoomHint || WM.map.getZoom())));
      if (totalHoriz > 600000) z = Math.min(z, 7);
      else if (totalHoriz > 180000) z = Math.min(z, 9);
      else if (totalHoriz > 45000) z = Math.min(z, 11);
      else if (totalHoriz > 12000) z = Math.min(z, 13);

      const now = Date.now();
      const tileSet = new Map();
      const MAX_PREFETCH_TILES = 16;
      const TARGET_PROBES = 40;

      for (let p = 0; p <= TARGET_PROBES; p++) {
        if (tileSet.size >= MAX_PREFETCH_TILES) break;
        const targetDist = (p / TARGET_PROBES) * totalHoriz;
        let acc = 0;
        let segIdx = nSegs - 1;
        let t = 1;

        for (let i = 0; i < nSegs; i++) {
          if (acc + segLengths[i] >= targetDist || i === nSegs - 1) {
            segIdx = i;
            t = segLengths[i] > 0.01 ? Math.max(0, Math.min(1, (targetDist - acc) / segLengths[i])) : 0;
            break;
          }
          acc += segLengths[i];
        }

        const pA = points[segIdx], pB = points[segIdx + 1];
        const pt = WM.map.project([pA.lat + (pB.lat - pA.lat) * t, pA.lng + (pB.lng - pA.lng) * t], z);
        const tx = Math.floor(pt.x / 256);
        const ty = Math.floor(pt.y / 256);
        const key = `${srcKey}:${z}:${tx}:${ty}`;

        const failTs = failedPrefetchTiles.get(key);
        if (failTs && (now - failTs < FAILED_PREFETCH_TTL)) continue;

        if (!paddedDemMemoryCache.has(key) && !demTileMemoryCache.has(key) && !tileSet.has(key)) {
          tileSet.set(key, { z, x: tx, y: ty, key });
        }
      }

      if (!tileSet.size) return;

      let loadedOk = 0;
      const tasks = Array.from(tileSet.values()).map(item =>
        loadDemTileWithFallback({ z: item.z, x: item.x, y: item.y })
          .then(img => {
            if (img && !img._isEmptyFallback && !img._degraded) {
              loadedOk++;
            } else {
              failedPrefetchTiles.set(item.key, Date.now());
            }
          })
          .catch(() => {
            failedPrefetchTiles.set(item.key, Date.now());
          })
      );

      await Promise.allSettled(tasks);
      if (loadedOk > 0 && typeof onDone === 'function') {
        onDone();
      }
    }, 180));
  }

  function createProfileWidget(ids) {
    let probeRatio = 0.5;
    let lastProfile = null;
    let onProbeMoveCb = null;

    const getEls = () => ({
      panel: document.getElementById(ids.panel),
      wrap: document.getElementById(ids.wrap),
      area: document.getElementById(ids.area),
      line: document.getElementById(ids.line),
      probeLine: document.getElementById(ids.probeLine),
      probeDot: document.getElementById(ids.probeDot),
      minLbl: document.getElementById(ids.minLbl),
      maxLbl: document.getElementById(ids.maxLbl),
      loading: document.getElementById(ids.loading),
      info: document.getElementById(ids.info)
    });

    function fmtD(m) {
      if (!m || m < 0.1) return '0 м';
      if (m < 1000) return Math.round(m) + ' м';
      const km = m / 1000;
      return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
    }

    function sampleAtRatio(profile, ratio) {
      const arr = profile.samples;
      if (!arr || !arr.length) return null;
      const r = Math.max(0, Math.min(1, ratio));
      const target3d = r * profile.total3d;

      let lo = 0, hi = arr.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].dist3d <= target3d) lo = mid;
        else hi = mid;
      }

      const a = arr[lo];
      const b = arr[hi];
      const span = b.dist3d - a.dist3d;
      const f = span > 0.001 ? Math.max(0, Math.min(1, (target3d - a.dist3d) / span)) : 0;

      const lat = a.lat + (b.lat - a.lat) * f;
      const lng = a.lng + (b.lng - a.lng) * f;
      const horizDist = a.horizDist + (b.horizDist - a.horizDist) * f;
      const dist3d = a.dist3d + span * f;
      const elev = (a.elev !== null && b.elev !== null) ? (a.elev + (b.elev - a.elev) * f) : (a.elev !== null ? a.elev : b.elev);

      // Уклон в окне ±2.5% (минимум ±15 м по горизонтали) для стабильности
      const win = Math.max(15, profile.totalHoriz * 0.025);
      const dLeft = Math.max(0, horizDist - win);
      const dRight = Math.min(profile.totalHoriz, horizDist + win);

      const getElevAtHoriz = (hd) => {
        for (let i = 0; i < arr.length - 1; i++) {
          if (arr[i + 1].horizDist >= hd) {
            const ds = arr[i + 1].horizDist - arr[i].horizDist;
            const ff = ds > 0.001 ? Math.max(0, Math.min(1, (hd - arr[i].horizDist) / ds)) : 0;
            if (arr[i].elev !== null && arr[i + 1].elev !== null) {
              return arr[i].elev + (arr[i + 1].elev - arr[i].elev) * ff;
            }
            return arr[i].elev;
          }
        }
        return arr[arr.length - 1].elev;
      };

      const hL = getElevAtHoriz(dLeft);
      const hR = getElevAtHoriz(dRight);
      const dh = (hL !== null && hR !== null) ? (hR - hL) : 0;
      const dx = Math.max(0.5, dRight - dLeft);
      const slopePct = (dh / dx) * 100;
      const slopeDeg = Math.atan2(dh, dx) * (180 / Math.PI);

      return { lat, lng, horizDist, dist3d, elev, slopePct, slopeDeg, ratio: r };
    }

    function updateProbeOnly() {
      if (!lastProfile || !lastProfile.hasData) return null;
      const els = getEls();
      const pt = sampleAtRatio(lastProfile, probeRatio);
      if (!pt) return null;

      const span = Math.max(4, lastProfile.maxElev - lastProfile.minElev);
      const vMin = lastProfile.minElev - span * 0.08;
      const vSpan = span * 1.16;

      if (els.probeLine) {
        els.probeLine.hidden = false;
        els.probeLine.style.left = (pt.ratio * 100).toFixed(2) + '%';
      }
      if (els.probeDot && pt.elev !== null) {
        const yPct = Math.max(4, Math.min(96, (1 - (pt.elev - vMin) / vSpan) * 100));
        els.probeDot.style.display = '';
        els.probeDot.style.top = yPct.toFixed(2) + '%';
      } else if (els.probeDot) {
        els.probeDot.style.display = 'none';
      }

      if (els.info) {
        const slopeCls = pt.slopePct > 1.5 ? 'up' : (pt.slopePct < -1.5 ? 'down' : 'flat');
        const slopeSign = pt.slopePct > 0.2 ? '+' : '';
        const diff3d = lastProfile.total3d - lastProfile.totalHoriz;
        const deltaStr = diff3d >= 1
          ? `2D: ${fmtD(lastProfile.totalHoriz)} (+${fmtD(diff3d)})`
          : `2D: ${fmtD(lastProfile.totalHoriz)}`;

        els.info.innerHTML = `
          <div class="mp-info-row">
            <span class="mp-info-lbl">Точка:</span>
            <span class="mp-info-val">${fmtD(pt.dist3d)}</span>
          </div>
          <div class="mp-info-row">
            <span class="mp-info-lbl">Высота:</span>
            <span class="mp-info-val">${pt.elev !== null ? Math.round(pt.elev) + ' м' : '--'}</span>
          </div>
          <div class="mp-info-row">
            <span class="mp-info-lbl">Уклон:</span>
            <span class="mp-info-val ${slopeCls}">${slopeSign}${pt.slopePct.toFixed(1)}% (${slopeSign}${pt.slopeDeg.toFixed(1)}°)</span>
          </div>
          <div class="mp-info-divider"></div>
          <div class="mp-info-summary">
            <span style="color:#ef4444;">▲+${Math.round(lastProfile.ascent)}м</span>
            <span style="color:#10b981;">▼-${Math.round(lastProfile.descent)}м</span>
          </div>
          <div class="mp-info-delta" title="Горизонтальное расстояние vs по рельефу">${deltaStr}</div>
        `;
      }

      if (typeof onProbeMoveCb === 'function') {
        onProbeMoveCb(pt);
      }
      return pt;
    }

    function bindEvents() {
      const els = getEls();
      if (!els.wrap || els.wrap._mpBound) return;
      els.wrap._mpBound = true;

      let dragging = false;

      const updateFromClientX = (clientX) => {
        const rect = els.wrap.getBoundingClientRect();
        if (rect.width <= 0) return;
        probeRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        updateProbeOnly();
      };

      els.wrap.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        try { els.wrap.setPointerCapture(e.pointerId); } catch (err) {}
        updateFromClientX(e.clientX);
      });

      els.wrap.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.stopPropagation();
        updateFromClientX(e.clientX);
      });

      const stopDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        e.stopPropagation();
      };

      els.wrap.addEventListener('pointerup', stopDrag);
      els.wrap.addEventListener('pointercancel', stopDrag);
    }

    return {
      bind(cb) {
        onProbeMoveCb = cb;
        bindEvents();
      },
      render(profile, color) {
        bindEvents();
        const els = getEls();
        if (!els.panel) return null;

        if (!profile) {
          els.panel.hidden = true;
          lastProfile = null;
          return null;
        }

        els.panel.hidden = false;
        if (color) els.panel.style.setProperty('--mp-color', color);
        lastProfile = profile;

        if (els.loading) els.loading.hidden = !profile.isPartial;

        if (!profile.hasData) {
          if (els.area) els.area.setAttribute('points', '');
          if (els.line) els.line.setAttribute('points', '');
          if (els.probeLine) els.probeLine.hidden = true;
          if (els.minLbl) els.minLbl.textContent = '-- м';
          if (els.maxLbl) els.maxLbl.textContent = '-- м';
          if (els.info) {
            els.info.innerHTML = `<div class="mp-info-lbl" style="text-align:center; padding:12px 0;">⏳ Загрузка высот…</div>`;
          }
          return null;
        }

        const span = Math.max(4, profile.maxElev - profile.minElev);
        const vMin = profile.minElev - span * 0.08;
        const vSpan = span * 1.16;

        const ptsStr = [];
        let firstX = 0;
        let lastX = 200;
        const step = profile.samples.length > 180 ? Math.ceil(profile.samples.length / 180) : 1;

        for (let i = 0; i < profile.samples.length; i += step) {
          const s = profile.samples[i];
          if (s.elev === null || !isFinite(s.elev)) continue;
          const x = +(s.ratio * 200).toFixed(1);
          const y = +(80 - ((s.elev - vMin) / vSpan) * 72 - 4).toFixed(1);
          if (!ptsStr.length) firstX = x;
          lastX = x;
          ptsStr.push(`${x},${y}`);
        }
        if (step > 1 && profile.samples.length > 0) {
          const lastS = profile.samples[profile.samples.length - 1];
          if (lastS.elev !== null && isFinite(lastS.elev)) {
            const x = +(lastS.ratio * 200).toFixed(1);
            const y = +(80 - ((lastS.elev - vMin) / vSpan) * 72 - 4).toFixed(1);
            lastX = x;
            ptsStr.push(`${x},${y}`);
          }
        }

        if (els.line) els.line.setAttribute('points', ptsStr.join(' '));
        if (els.area) {
          els.area.setAttribute('points', ptsStr.length ? `${firstX},80 ${ptsStr.join(' ')} ${lastX},80` : '');
        }
        if (els.minLbl) els.minLbl.textContent = Math.round(profile.minElev) + ' м';
        if (els.maxLbl) els.maxLbl.textContent = Math.round(profile.maxElev) + ' м';

        return updateProbeOnly();
      },
      hide() {
        const els = getEls();
        if (els.panel) els.panel.hidden = true;
        if (els.probeLine) els.probeLine.hidden = true;
        lastProfile = null;
      },
      resetProbe() {
        probeRatio = 0.5;
      }
    };
  }






function getCachedWaterMask(z, tx, ty) {
    const targetZ = Math.min(z, 14);
    const shift0 = z - targetZ;
    const baseTx = tx >> shift0;
    const baseTy = ty >> shift0;

    // 1. Точный или родительский кэш
    for (let pz = targetZ; pz >= 8; pz--) {
      const s = targetZ - pz;
      const m = baseWaterMaskCache.get(`${pz}:${baseTx >> s}:${baseTy >> s}`);
      if (m) {
        return (pz === z) ? m : sliceMaskForZoom(m, { z, x: tx, y: ty }, pz);
      }
    }

    // 2. Дочерние тайлы (если ранее смотрели карту на более крупном зуме)
    if (targetZ < 14) {
      const cz = targetZ + 1;
      const cn = 1 << cz;
      const cx0 = (baseTx * 2) % cn;
      const cy0 = baseTy * 2;
      const c00 = baseWaterMaskCache.get(`${cz}:${cx0}:${cy0}`);
      const c10 = baseWaterMaskCache.get(`${cz}:${(cx0 + 1) % cn}:${cy0}`);
      const c01 = baseWaterMaskCache.get(`${cz}:${cx0}:${cy0 + 1}`);
      const c11 = baseWaterMaskCache.get(`${cz}:${(cx0 + 1) % cn}:${cy0 + 1}`);
      if (c00 && c10 && c01 && c11) {
        const out = new Uint8Array(256 * 256);
        const quads = [[c00, 0, 0], [c10, 128, 0], [c01, 0, 128], [c11, 128, 128]];
        for (let q = 0; q < 4; q++) {
          const src = quads[q][0], ox = quads[q][1], oy = quads[q][2];
          for (let y = 0; y < 128; y++) {
            const sy = y << 1;
            const dRow = (oy + y) * 256 + ox;
            for (let x = 0; x < 128; x++) {
              const sx = x << 1;
              out[dRow + x] = (src[sy * 256 + sx] | src[sy * 256 + sx + 1] | src[(sy + 1) * 256 + sx] | src[(sy + 1) * 256 + sx + 1]);
            }
          }
        }
        return (z === targetZ) ? out : sliceMaskForZoom(out, { z, x: tx, y: ty }, targetZ);
      }
    }
    return null;
  }

  function getWaterAtSync(lat, lng) {
    if (!baseWaterMaskCache.size || !isFinite(lat) || !isFinite(lng)) return null;
    const clLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const s = Math.sin(clLat * RAD_DEG);
    const nx = (lng + 180) / 360;
    const ny = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    for (let z = 14; z >= 10; z--) {
      const n = 1 << z;
      const fx = nx * n, fy = ny * n;
      const tx = ((Math.floor(fx) % n) + n) % n;
      const ty = Math.max(0, Math.min(n - 1, Math.floor(fy)));
      const m = baseWaterMaskCache.get(`${z}:${tx}:${ty}`);
      if (m) {
        const lx = Math.min(255, Math.floor((fx - Math.floor(fx)) * 256));
        const ly = Math.min(255, Math.floor((fy - ty) * 256));
        return m[(ly << 8) + lx] > 127 ? 1 : 0;
      }
    }
    return null;
  }

  function getCachedDemTileWithChildren(coords, srcOverride = null) {
    const srcKey = (srcOverride && DEM_SOURCES[srcOverride]) ? srcOverride : (cfg.demSource || 'fabdem');
    const direct = getDemMemoryCache(`${srcKey}:${coords.z}:${coords.x}:${coords.y}`);
    if (direct && !direct._isEmptyFallback && !direct._evicted &&
        !(direct instanceof HTMLCanvasElement && (!direct.width || !direct.height))) {
      return direct;
    }

    // Даунсэмплинг 4 дочерних тайлов из RAM (без искажения RGB, imageSmoothingEnabled = false)
    if (coords.z >= 9 && coords.z <= 16) {
      const cz = coords.z + 1;
      const cn = 1 << cz;
      const cx0 = (coords.x * 2) % cn;
      const cy0 = coords.y * 2;
      const c00 = getDemMemoryCache(`${srcKey}:${cz}:${cx0}:${cy0}`);
      const c10 = getDemMemoryCache(`${srcKey}:${cz}:${(cx0 + 1) % cn}:${cy0}`);
      const c01 = getDemMemoryCache(`${srcKey}:${cz}:${cx0}:${cy0 + 1}`);
      const c11 = getDemMemoryCache(`${srcKey}:${cz}:${(cx0 + 1) % cn}:${cy0 + 1}`);
      if (c00 && c10 && c01 && c11 && !c00._isEmptyFallback && !c10._isEmptyFallback && !c01._isEmptyFallback && !c11._isEmptyFallback) {
        const cv = document.createElement('canvas');
        cv.width = 256;
        cv.height = 256;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(c00, 0, 0, c00.width, c00.height, 0, 0, 128, 128);
        ctx.drawImage(c10, 0, 0, c10.width, c10.height, 128, 0, 128, 128);
        ctx.drawImage(c01, 0, 0, c01.width, c01.height, 0, 128, 128, 128);
        ctx.drawImage(c11, 0, 0, c11.width, c11.height, 128, 128, 128, 128);
        if (isImageMostlyTransparent(cv)) {
          cv.width = 0; cv.height = 0;
          return null;
        }
        cv._demProvider = c00._demProvider;
        cv._fromCache = true;
        cv._degraded = !!(c00._degraded || c10._degraded || c01._degraded || c11._degraded);
        cv._needsUpgrade = !!(c00._needsUpgrade || c10._needsUpgrade || c01._needsUpgrade || c11._needsUpgrade);
        return cv;
      }
    }
    return null;
  }

// Оценка времени прохождения профиля высот (функция Тоблера, нормированная на speedMps)
  function estimateProfileTravelTime(profile, speedMps, startDist3d = 0) {
    if (!profile || !profile.samples || profile.samples.length < 2 || !speedMps || speedMps <= 0) {
      return null;
    }

    const samples = profile.samples;
    const safeSpeed = Math.max(0.05, speedMps);
    // При скоростях > ~14 км/ч (вело/авто) плавно снижаем пеший штраф за уклон
    const slopeWeight = Math.max(0.15, Math.min(1.0, 1.0 - (safeSpeed - 3.8) / 8.0));
    const TOBLER_FLAT = 0.83945702; // exp(-3.5 * 0.05)

    let totalTime = 0;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      if (b.dist3d <= startDist3d) continue;

      let fracStart = 0;
      if (a.dist3d < startDist3d && b.dist3d > startDist3d) {
        const span = b.dist3d - a.dist3d;
        fracStart = span > 0.001 ? (startDist3d - a.dist3d) / span : 0;
      }

      const dH = (b.horizDist - a.horizDist) * (1 - fracStart);
      const d3 = (b.dist3d - a.dist3d) * (1 - fracStart);
      if (d3 <= 0.001) continue;

      if (a.elev !== null && b.elev !== null && dH > 0.05) {
        const dZ = (b.elev - a.elev) * (1 - fracStart);
        const slope = Math.max(-1.2, Math.min(1.2, dZ / dH));
        const toblerFactor = Math.exp(-3.5 * Math.abs(slope + 0.05)) / TOBLER_FLAT;
        const effFactor = 1.0 + (toblerFactor - 1.0) * slopeWeight;
        totalTime += d3 / Math.max(0.05, safeSpeed * effFactor);
      } else {
        totalTime += d3 / safeSpeed;
      }
    }
    return totalTime;
  }

  // Расчёт 3D-дистанции и времени между двумя точками (GPS -> цель / центр экрана)
  function calcDirectRouteRelief(fromLL, toLL, speedMps, opts = {}) {
    const flatDist = L.latLng(fromLL.lat, fromLL.lng).distanceTo(L.latLng(toLL.lat, toLL.lng));
    const safeSpeed = speedMps > 0 ? speedMps : 0;
    const flatTime = safeSpeed > 0 ? (flatDist / safeSpeed) : null;

    if (!isDemActive()) {
      return {
        dist: flatDist,
        horizDist: flatDist,
        timeSec: flatTime,
        ascent: 0,
        descent: 0,
        is3d: false
      };
    }

    const pts = [
      { lat: fromLL.lat, lng: fromLL.lng },
      { lat: toLL.lat, lng: toLL.lng }
    ];
    const profile = samplePathProfile(pts, { maxSamples: opts.maxSamples || 24 });

    if (profile && profile.isPartial && typeof opts.onPrefetchDone === 'function') {
      prefetchPathDem(
        pts,
        WM.map ? WM.map.getZoom() : 14,
        opts.onPrefetchDone,
        opts.prefetchKey || 'direct'
      );
    }

    if (profile && profile.hasData) {
      return {
        dist: profile.total3d,
        horizDist: profile.totalHoriz,
        timeSec: safeSpeed > 0 ? estimateProfileTravelTime(profile, safeSpeed, 0) : null,
        ascent: profile.ascent,
        descent: profile.descent,
        is3d: true
      };
    }

    return {
      dist: flatDist,
      horizDist: flatDist,
      timeSec: flatTime,
      ascent: 0,
      descent: 0,
      is3d: false
    };
  }

  // Добавьте в объект WM.demRelief:
  WM.demRelief = {
    isActive: isDemActive,
    flush: flushConfig,
    getElevation: getElevationAtLatLng,
    sampleProfile: samplePathProfile,
    sampleTileGrid,
    getCachedWaterMask,
    fetchWaterMaskTile,
    getWaterAtSync,
    getCachedDemTileWithChildren,
    resetNet: resetDemNet,
    getHealth: () => ({ ..._demHealthState }),
    prefetchPathDem: prefetchPathDem,
    createProfileWidget: createProfileWidget,
    getConfig: () => ({ ...cfg }),
    getSources: () => ({ ...DEM_SOURCES }),
    loadPaddedDemTile: loadPaddedDemTile,
    loadDemTileWithFallback: loadDemTileWithFallback,
    estimateProfileTravelTime: estimateProfileTravelTime,
    calcDirectRouteRelief: calcDirectRouteRelief,
    reloadMissingTiles,
    _isForceBypass: isForceBypass,
    clearCache() {
      _demCacheGen++;
      _degradedAttempt = 0;
      lastViewportMinH = null;
      lastViewportMaxH = null;

      for (const img of demTileMemoryCache.values()) {
        evictDemImg(img);
      }
      notifyDemChange(true, { sourceChanged: true });
      demTileMemoryCache.clear();
      demInFlightPromises.clear();
      dem404Set.clear();
      clearPaddedDemCache();
      paddedInFlightPromises.clear();

      failedPrefetchTiles.clear();
      baseWaterMaskCache.clear();
      baseWaterMaskInFlight.clear();
      _waterRetryAttempt = 0;
      activeTileElevations.clear();
      resetDemNet();
      globalGeomVersion++;
      if (hillshadeLayerInstance && cfg.hillshadeEnabled) {
        hillshadeLayerInstance.redraw();
      }
      if (contoursLayerInstance && cfg.contoursEnabled) {
        contoursLayerInstance.redraw();
      }
      notifyDemChange(true);
    },

    getDebugSnapshot() {
      const hsZoom = (hillshadeLayerInstance && typeof hillshadeLayerInstance._tileZoom === 'number')
        ? hillshadeLayerInstance._tileZoom
        : (WM.map ? Math.min(Math.round(WM.map.getZoom()), 17) : 0);

      const tiles = [];
      if (hillshadeLayerInstance && hillshadeLayerInstance._tiles) {
        for (const key in hillshadeLayerInstance._tiles) {
          const entry = hillshadeLayerInstance._tiles[key];
          const el = entry?.el;
          if (!el || !entry?.coords) continue;
          tiles.push({
            key,
            coords: { z: entry.coords.z, x: entry.coords.x, y: entry.coords.y },
            removed: !!el._removed,
            dem: {
              hasImg: !!el._demImg,
              provider: el._demImg?._demProvider || null,
              degraded: !!el._demImg?._degraded,
              emptyFallback: !!(el._isEmptyFallback || el._demImg?._isEmptyFallback),
              fromParentCrop: !!el._demImg?._fromParentCrop,
              fromCache: !!el._demImg?._fromCache,
              deblocked: !!el._demImg?._deblocked,
              tileSize: el._demImg?._tileSize || null,
              minH: el._demImg?._minH ?? null,
              maxH: el._demImg?._maxH ?? null,
              hasDemTex: !!el._demTex,
              hasGBuf: !!el._gBuf,
              hasSBuf: !!el._sBuf
            },
            water: {
              hasMask: !!el._waterMaskData,
              hasWater: !!el._waterMaskData?._hasWater,
              isEmpty404: !!el._waterMaskData?._isEmpty404,
              isFallback: !!el._waterMaskData?._isFallback,
              failed: !!el._waterMaskFailed,
              hasTex: !!el._waterMaskTex
            }
          });
        }
      }

      const circuitBreakers = [];
      for (const [tpl, st] of demEp.entries()) {
        circuitBreakers.push({
          label: `${detectProviderFromUrl(tpl)} (${tpl.slice(0, 46)})`,
          fails: st.fails,
          isOpen: Date.now() < st.openUntil,
          openUntil: st.openUntil
        });
      }

      return {
        cfg: {
          hillshadeEnabled: !!cfg.hillshadeEnabled,
          contoursEnabled: !!cfg.contoursEnabled,
          demSource: cfg.demSource,
          seaWavesEnabled: !!cfg.seaWavesEnabled,
          waterTintEnabled: !!cfg.waterTintEnabled,
          waterlining: !!cfg.waterlining
        },
        layerOnMap: !!(WM.map && hillshadeLayerInstance && WM.map.hasLayer(hillshadeLayerInstance)),
        hillshadeTileZoom: hsZoom,
        webgl: {
          ok: !!sharedGl,
          contextLost: sharedGl ? sharedGl.isContextLost() : false
        },
        health: { ..._demHealthState },
        caches: {
          rawSize: demTileMemoryCache.size,
          rawMax: MAX_DEM_CACHE_ENTRIES,
          paddedSize: paddedDemMemoryCache.size,
          paddedWeight: _paddedCacheWeight,
          paddedMaxWeight: MAX_PADDED_CACHE_WEIGHT,
          demInFlight: demInFlightPromises.size,
          paddedInFlight: paddedInFlightPromises.size,
          waterSize: baseWaterMaskCache.size,
          waterInFlight: baseWaterMaskInFlight.size,
          absentSize: demAbsent.size,
          cellMissSize: demCell.size
        },
        parallel: {
          demActive: _demActive,
          demMax: DEM_MAX_PARALLEL,
          demWaiters: _demWaiters.length,
          waterActive: _waterMaskActive,
          waterMax: WATER_MASK_MAX_PARALLEL,
          waterWaiters: _waterMaskWaiters.length
        },
        queues: {
          asm: _asmQueue.length,
          incoming: _incomingTileQueue.length
        },
        waterNet: {
          hasToken: !!WaterTokens.getCached(),
          lastSuccessfulIdx: WaterNet.lastSuccessfulIdx,
          retryAttempt: _waterRetryAttempt,
          states: WaterNet.states.map(s => ({
            name: s.name,
            fails: s.fails,
            isOpen: Date.now() < s.openUntil
          }))
        },
        circuitBreakers,
        tiles
      };
    },

    trimMemory(aggressive = false) {
      const targetDem = aggressive ? 24 : 40;
      while (demTileMemoryCache.size > targetDem) {
        const firstKey = demTileMemoryCache.keys().next().value;
        const evicted = demTileMemoryCache.get(firstKey);
        demTileMemoryCache.delete(firstKey);
        if (evicted) evictDemImg(evicted);
      }

      const targetWeight = aggressive ? 14 : 26;
      while (_paddedCacheWeight > targetWeight && paddedDemMemoryCache.size > 0) {
        const firstKey = paddedDemMemoryCache.keys().next().value;
        deletePaddedDemCache(firstKey);
      }

      const targetWater = aggressive ? 20 : 40;
      while (baseWaterMaskCache.size > targetWater) {
        baseWaterMaskCache.delete(baseWaterMaskCache.keys().next().value);
      }

      if (aggressive && sharedGl) {
        while (glTexturePool.length > 0) {
          const item = glTexturePool.pop();
          if (item && item.tex) sharedGl.deleteTexture(item.tex);
        }
        if (sharedGl.canvas && (sharedGl.canvas.width > 512 || sharedGl.canvas.height > 512)) {
          sharedGl.canvas.width = 256;
          sharedGl.canvas.height = 256;
        }
      }
    },

    getActiveSourceInfo(srcOverride = null) {
      const srcKey = (srcOverride && DEM_SOURCES[srcOverride]) ? srcOverride : (cfg.demSource || 'fabdem');
      const srcObj = DEM_SOURCES[srcKey] || DEM_SOURCES.fabdem;
      const urls = srcObj.urls.slice();
      if (srcKey === 'fabdem' || srcKey === 'copernicus') {
        const direct = GeeDemTokens.getCached(srcKey);
        if (direct) urls.unshift(direct);
      }
      const providers = urls.map((tpl, idx) => {
        const id = detectProviderFromUrl(tpl, srcKey);
        const st = epState(tpl);
        const label =
          /earthengine\.googleapis\.com/i.test(tpl) ? `GEE Direct (${srcKey.toUpperCase()})` :
          /workers\.dev/i.test(tpl) ? `Cloudflare (${srcKey.toUpperCase()})` :
          /yandexcloud\.net/i.test(tpl) ? `Yandex Proxy (${srcKey.toUpperCase()})` :
          id === 'mapterhorn' ? 'Mapterhorn (Copernicus 30m + LiDAR)' :
          id === 'aws' ? 'AWS Terrarium' :
          id === 'nextzen' ? 'Nextzen' : tpl;
        return {
          id,
          name: label,
          priority: idx + 1,
          maxZ: demUrlMaxZ(tpl),
          paused: epIsOpen(tpl),
          fails: st.fails
        };
      });
      return {
        sourceId: srcObj.id,
        sourceName: srcObj.name,
        providers
      };
    },


    // === ДОБАВИТЬ ЭТУ СТРОКУ ===
    getLighting: (lat, lng) => {
      const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const effLat = isFinite(lat) ? lat : c.lat;
      const effLng = isFinite(lng) ? lng : c.lng;
      return getSunLighting(effLat, effLng);
    },

    // ДОБАВЬТЕ ЭТИ 3 СТРОКИ:
    applyLayerVisibility: applyLayerVisibility,
    renderHud: scheduleHudRender,
    scheduleUpdate: (bump) => scheduleLiveHillshade(bump),
    
    getLayers() {
      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    },

    openHud(targetTab, targetSpoilerId) {
      const hud = document.getElementById('dem-relief-hud');
      if (!hud) return;
      isHudOpen = true;
      if (targetTab) {
        activeTab = targetTab;
      }
      initHudEvents();
      renderHudUI();
      hud.hidden = false;

      // Если панель была свернута в полоску — разворачиваем её
      if (hud.classList.contains('collapsed')) {
        hud.classList.remove('collapsed');
        const minBtn = document.getElementById('btn-dem-hud-minimize');
        if (minBtn) minBtn.textContent = '▼';
      }

      // Открываем нужный спойлер и прокручиваем к нему
      if (targetSpoilerId) {
        const sp = document.getElementById(targetSpoilerId);
        if (sp) {
          let parent = sp;
          while (parent && parent !== hud) {
            if (parent.tagName === 'DETAILS') parent.open = true;
            parent = parent.parentElement;
          }
          setTimeout(() => {
            const hudBody = hud.querySelector('.dem-hud-body');
            if (hudBody) {
              const bodyRect = hudBody.getBoundingClientRect();
              const spRect = sp.getBoundingClientRect();
              const targetTop = hudBody.scrollTop + (spRect.top - bodyRect.top) - 4;
              hudBody.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
            }
          }, 90);
        }
      }

      if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('demReliefHud');
    },

    closeHud() {
      const hud = document.getElementById('dem-relief-hud');
      if (hud) hud.hidden = true;
      isHudOpen = false;
      if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('demReliefHud');
    },

    isHudOpen: () => isHudOpen,

    applyProfile(profileDem) {
      const prevCfg = { ...cfg };
      const nextCfg = {
        ...DEFAULT_CONFIG,
        demSource: prevCfg.demSource,
        ...(profileDem && typeof profileDem === 'object' ? profileDem : {})
      };
      const patch = {};
      for (const k of Object.keys(nextCfg)) {
        if (nextCfg[k] !== prevCfg[k]) patch[k] = nextCfg[k];
      }
      if (Object.keys(patch).length > 0) {
        this.setConfig(patch);
      }
      flushConfig();
      applyLayerVisibility();
      if (cfg.hillshadeEnabled) scheduleLiveHillshade(true);
      scheduleHudRender();
    },

    setConfig(newCfg) {
      const oldCfg = { ...cfg };
      Object.assign(cfg, newCfg);
      saveConfig();

      const needTilesReload = (
        newCfg.demSource !== undefined && newCfg.demSource !== oldCfg.demSource ||
        newCfg.demDeblock !== undefined && newCfg.demDeblock !== oldCfg.demDeblock ||
        newCfg.demDeblockSigmaM !== undefined && newCfg.demDeblockSigmaM !== oldCfg.demDeblockSigmaM
      );

      if (newCfg.blendMode !== undefined || newCfg.contourBlendMode !== undefined) {
        applyBlendModeToPane();
      }

      if (newCfg.hillshadeEnabled !== undefined || newCfg.contoursEnabled !== undefined || needTilesReload) {
        notifyDemChange(true, needTilesReload
          ? { sourceChanged: true, configChanged: true }
          : { configChanged: true });
      }

      if (newCfg.hillshadeEnabled !== undefined) {
        if (window.syncViewshedControlState) {
          window.syncViewshedControlState();
        }
      }

      if (newCfg.hillshadeOpacity !== undefined && hillshadeLayerInstance) {
        hillshadeLayerInstance.setOpacity(cfg.hillshadeOpacity);
      }
      if (newCfg.contourOpacity !== undefined && contoursLayerInstance) {
        contoursLayerInstance.setOpacity(cfg.contourOpacity);
      }



      const needGeomInvalidate = (
        newCfg.smoothMode !== undefined && newCfg.smoothMode !== oldCfg.smoothMode ||
        newCfg.zFactor !== undefined && newCfg.zFactor !== oldCfg.zFactor ||
        newCfg.zFactorAuto !== undefined && newCfg.zFactorAuto !== oldCfg.zFactorAuto ||
        newCfg.ambientOcclusion !== undefined && newCfg.ambientOcclusion !== oldCfg.ambientOcclusion ||
        newCfg.aoStrength !== undefined && newCfg.aoStrength !== oldCfg.aoStrength ||
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.aoSlopeBleed !== undefined && newCfg.aoSlopeBleed !== oldCfg.aoSlopeBleed ||
        newCfg.opennessEnabled !== undefined && newCfg.opennessEnabled !== oldCfg.opennessEnabled ||
        newCfg.opennessRadius !== undefined && newCfg.opennessRadius !== oldCfg.opennessRadius ||
        newCfg.opennessStrength !== undefined && newCfg.opennessStrength !== oldCfg.opennessStrength ||
        newCfg.opennessDiff !== undefined && newCfg.opennessDiff !== oldCfg.opennessDiff ||
        newCfg.svfEnabled !== undefined && newCfg.svfEnabled !== oldCfg.svfEnabled ||
        newCfg.svfStrength !== undefined && newCfg.svfStrength !== oldCfg.svfStrength
      );



      if (needGeomInvalidate) {
        globalGeomVersion++;
      }

      if (needTilesReload) {
        for (const img of demTileMemoryCache.values()) evictDemImg(img);
        demTileMemoryCache.clear();
        demInFlightPromises.clear();
        dem404Set.clear();
        resetDemNet();
        clearPaddedDemCache();
        paddedInFlightPromises.clear();
        failedPrefetchTiles.clear();

        if (hillshadeLayerInstance && cfg.hillshadeEnabled) {
          hillshadeLayerInstance.redraw();
        }
        if (contoursLayerInstance && cfg.contoursEnabled) {
          contoursLayerInstance.redraw();
        }
      }

      const needShaderRecompile = (
        newCfg.mdowEnabled !== undefined && newCfg.mdowEnabled !== oldCfg.mdowEnabled ||
        newCfg.hachureEnabled !== undefined && newCfg.hachureEnabled !== oldCfg.hachureEnabled ||
        (cfg.hachureEnabled && newCfg.hachureType !== undefined && newCfg.hachureType !== oldCfg.hachureType) ||
        newCfg.ditherEnabled !== undefined && newCfg.ditherEnabled !== oldCfg.ditherEnabled ||
        (cfg.ditherEnabled && newCfg.ditherType !== undefined && newCfg.ditherType !== oldCfg.ditherType) ||
        newCfg.bounceEnabled !== undefined && newCfg.bounceEnabled !== oldCfg.bounceEnabled ||
        newCfg.seaWavesEnabled !== undefined && newCfg.seaWavesEnabled !== oldCfg.seaWavesEnabled ||
        (cfg.seaWavesEnabled && newCfg.seaWaveStyle !== undefined && newCfg.seaWaveStyle !== oldCfg.seaWaveStyle) ||
        ((newCfg.roadTintEnabled !== undefined || newCfg.edgeTintEnabled !== undefined) &&
        (!!(cfg.roadTintEnabled || cfg.edgeTintEnabled) !== !!(oldCfg.roadTintEnabled || oldCfg.edgeTintEnabled))) ||
        newCfg.contactShadowsEnabled !== undefined && newCfg.contactShadowsEnabled !== oldCfg.contactShadowsEnabled ||
        // ДОБАВИТЬ ЭТИ ДВЕ СТРОКИ:
        newCfg.outlineEnabled !== undefined && newCfg.outlineEnabled !== oldCfg.outlineEnabled ||
        (cfg.outlineEnabled && newCfg.outlineType !== undefined && newCfg.outlineType !== oldCfg.outlineType)
      );

      // Обычное обновление uniform-переменных на лету (слайдеры, солнце, цвет) БЕЗ перекомпиляции
      const needLightUpdate = needGeomInvalidate || needShaderRecompile || (
        newCfg.manualTimeHour !== undefined && newCfg.manualTimeHour !== oldCfg.manualTimeHour ||
        newCfg.manualDateStr !== undefined && newCfg.manualDateStr !== oldCfg.manualDateStr ||
        newCfg.sunMode !== undefined && newCfg.sunMode !== oldCfg.sunMode ||
        newCfg.sunAzimuth !== undefined && newCfg.sunAzimuth !== oldCfg.sunAzimuth ||
        newCfg.sunAltitude !== undefined && newCfg.sunAltitude !== oldCfg.sunAltitude ||
        newCfg.colorTone !== undefined && newCfg.colorTone !== oldCfg.colorTone ||
        newCfg.zFactor !== undefined && newCfg.zFactor !== oldCfg.zFactor ||
        newCfg.zFactorAuto !== undefined && newCfg.zFactorAuto !== oldCfg.zFactorAuto ||
        newCfg.lightBoost !== undefined && newCfg.lightBoost !== oldCfg.lightBoost ||
        newCfg.manualScaleMode !== undefined && newCfg.manualScaleMode !== oldCfg.manualScaleMode ||
        newCfg.manualElevMin !== undefined && newCfg.manualElevMin !== oldCfg.manualElevMin ||
        newCfg.manualElevMax !== undefined && newCfg.manualElevMax !== oldCfg.manualElevMax ||

        newCfg.manualPeakColor !== undefined && newCfg.manualPeakColor !== oldCfg.manualPeakColor ||
        newCfg.manualMidColor !== undefined && newCfg.manualMidColor !== oldCfg.manualMidColor ||
        newCfg.manualValleyColor !== undefined && newCfg.manualValleyColor !== oldCfg.manualValleyColor ||

        newCfg.roadTintEnabled !== undefined && newCfg.roadTintEnabled !== oldCfg.roadTintEnabled ||
        newCfg.roadTintColor !== undefined && newCfg.roadTintColor !== oldCfg.roadTintColor ||
        newCfg.roadTintOpacity !== undefined && newCfg.roadTintOpacity !== oldCfg.roadTintOpacity ||
        newCfg.roadTintZone !== undefined && newCfg.roadTintZone !== oldCfg.roadTintZone ||
        newCfg.roadTintSoftness !== undefined && newCfg.roadTintSoftness !== oldCfg.roadTintSoftness ||
        newCfg.roadTintBlendMode !== undefined && newCfg.roadTintBlendMode !== oldCfg.roadTintBlendMode ||
        newCfg.roadTintTypes !== undefined && newCfg.roadTintTypes !== oldCfg.roadTintTypes ||
        newCfg.edgeTintEnabled !== undefined && newCfg.edgeTintEnabled !== oldCfg.edgeTintEnabled ||
        newCfg.edgeTintColor !== undefined && newCfg.edgeTintColor !== oldCfg.edgeTintColor ||
        newCfg.edgeTintOpacity !== undefined && newCfg.edgeTintOpacity !== oldCfg.edgeTintOpacity ||
        newCfg.edgeTintZone !== undefined && newCfg.edgeTintZone !== oldCfg.edgeTintZone ||
        newCfg.edgeTintSoftness !== undefined && newCfg.edgeTintSoftness !== oldCfg.edgeTintSoftness ||
        newCfg.edgeTintBlendMode !== undefined && newCfg.edgeTintBlendMode !== oldCfg.edgeTintBlendMode ||
        newCfg.edgeTintSide !== undefined && newCfg.edgeTintSide !== oldCfg.edgeTintSide ||




        newCfg.manualValleyColor !== undefined && newCfg.manualValleyColor !== oldCfg.manualValleyColor ||
        newCfg.bounceStrength !== undefined && newCfg.bounceStrength !== oldCfg.bounceStrength ||
        newCfg.penumbraScale !== undefined && newCfg.penumbraScale !== oldCfg.penumbraScale ||
        newCfg.manualShadowColor !== undefined && newCfg.manualShadowColor !== oldCfg.manualShadowColor ||
        newCfg.manualLightBlend !== undefined && newCfg.manualLightBlend !== oldCfg.manualLightBlend ||
        newCfg.manualLightSoftness !== undefined && newCfg.manualLightSoftness !== oldCfg.manualLightSoftness ||
        newCfg.manualLightBlend2 !== undefined && newCfg.manualLightBlend2 !== oldCfg.manualLightBlend2 ||
        newCfg.manualLightSoftness2 !== undefined && newCfg.manualLightSoftness2 !== oldCfg.manualLightSoftness2 ||
        newCfg.ambientOcclusion !== undefined && newCfg.ambientOcclusion !== oldCfg.ambientOcclusion ||
        newCfg.aoStrength !== undefined && newCfg.aoStrength !== oldCfg.aoStrength ||
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.aoSlopeBleed !== undefined && newCfg.aoSlopeBleed !== oldCfg.aoSlopeBleed ||
        newCfg.svfEnabled !== undefined && newCfg.svfEnabled !== oldCfg.svfEnabled ||
        newCfg.svfStrength !== undefined && newCfg.svfStrength !== oldCfg.svfStrength ||

        newCfg.waterTintEnabled !== undefined && newCfg.waterTintEnabled !== oldCfg.waterTintEnabled ||
        newCfg.waterTintColor !== undefined && newCfg.waterTintColor !== oldCfg.waterTintColor ||
        newCfg.waterTintOpacity !== undefined && newCfg.waterTintOpacity !== oldCfg.waterTintOpacity ||
        newCfg.waterTintCoverage !== undefined && newCfg.waterTintCoverage !== oldCfg.waterTintCoverage ||
        newCfg.waterTintBlendMode !== undefined && newCfg.waterTintBlendMode !== oldCfg.waterTintBlendMode ||
        // --- Штриховка (Hachure) ---
        newCfg.hachureBlendMode !== undefined && newCfg.hachureBlendMode !== oldCfg.hachureBlendMode ||
        newCfg.hachureThinning !== undefined && newCfg.hachureThinning !== oldCfg.hachureThinning ||
        newCfg.hachureDensity !== undefined && newCfg.hachureDensity !== oldCfg.hachureDensity ||
        newCfg.hachureOpacity !== undefined && newCfg.hachureOpacity !== oldCfg.hachureOpacity ||
        newCfg.hachureSlope !== undefined && newCfg.hachureSlope !== oldCfg.hachureSlope ||
        newCfg.hachureColor !== undefined && newCfg.hachureColor !== oldCfg.hachureColor ||
        newCfg.hachureLightMod !== undefined && newCfg.hachureLightMod !== oldCfg.hachureLightMod ||
        newCfg.hachureLength !== undefined && newCfg.hachureLength !== oldCfg.hachureLength ||                     // <-- ДОБАВЛЕНО
        newCfg.hachureHybridThresh !== undefined && newCfg.hachureHybridThresh !== oldCfg.hachureHybridThresh ||   // <-- ДОБАВЛЕНО
        newCfg.hachureHybridSharpness !== undefined && newCfg.hachureHybridSharpness !== oldCfg.hachureHybridSharpness || // <-- ДОБАВЛЕНО
        // --- Карандашная обводка (Outline) ---
        newCfg.outlineBlendMode !== undefined && newCfg.outlineBlendMode !== oldCfg.outlineBlendMode ||
        newCfg.outlineWidth !== undefined && newCfg.outlineWidth !== oldCfg.outlineWidth ||
        newCfg.outlineRoughness !== undefined && newCfg.outlineRoughness !== oldCfg.outlineRoughness ||
        newCfg.outlineThreshold !== undefined && newCfg.outlineThreshold !== oldCfg.outlineThreshold ||
        newCfg.outlineOpacity !== undefined && newCfg.outlineOpacity !== oldCfg.outlineOpacity ||
        newCfg.outlineLightMod !== undefined && newCfg.outlineLightMod !== oldCfg.outlineLightMod ||
        newCfg.outlineColor !== undefined && newCfg.outlineColor !== oldCfg.outlineColor ||
        newCfg.outlineTexture !== undefined && newCfg.outlineTexture !== oldCfg.outlineTexture ||                   // <-- ДОБАВЛЕНО
        newCfg.outlineDensity !== undefined && newCfg.outlineDensity !== oldCfg.outlineDensity ||                   // <-- ДОБАВЛЕНО
        // --- Дизеринг (Dither) ---
        newCfg.ditherAngle !== undefined && newCfg.ditherAngle !== oldCfg.ditherAngle ||
        newCfg.ditherDensity !== undefined && newCfg.ditherDensity !== oldCfg.ditherDensity ||
        newCfg.ditherLowCut !== undefined && newCfg.ditherLowCut !== oldCfg.ditherLowCut ||
        newCfg.ditherBlendMode !== undefined && newCfg.ditherBlendMode !== oldCfg.ditherBlendMode ||
        newCfg.ditherScale !== undefined && newCfg.ditherScale !== oldCfg.ditherScale ||
        newCfg.ditherThreshold !== undefined && newCfg.ditherThreshold !== oldCfg.ditherThreshold ||
        newCfg.ditherSoftness !== undefined && newCfg.ditherSoftness !== oldCfg.ditherSoftness ||
        newCfg.ditherColor !== undefined && newCfg.ditherColor !== oldCfg.ditherColor ||
        newCfg.ditherZone !== undefined && newCfg.ditherZone !== oldCfg.ditherZone ||
        newCfg.ditherStrength !== undefined && newCfg.ditherStrength !== oldCfg.ditherStrength ||
        // --- Тени и оптика ---
        newCfg.castShadows !== undefined && newCfg.castShadows !== oldCfg.castShadows ||
        newCfg.shadowReach !== undefined && newCfg.shadowReach !== oldCfg.shadowReach ||
        newCfg.shadowOpacity !== undefined && newCfg.shadowOpacity !== oldCfg.shadowOpacity ||
        newCfg.imhofDeflection !== undefined && newCfg.imhofDeflection !== oldCfg.imhofDeflection ||
        newCfg.paperGrain !== undefined && newCfg.paperGrain !== oldCfg.paperGrain ||
        newCfg.hypsoMode !== undefined && newCfg.hypsoMode !== oldCfg.hypsoMode ||
        newCfg.orenNayarRoughness !== undefined && newCfg.orenNayarRoughness !== oldCfg.orenNayarRoughness ||
        newCfg.specularDamp !== undefined && newCfg.specularDamp !== oldCfg.specularDamp ||
        newCfg.inkBleed !== undefined && newCfg.inkBleed !== oldCfg.inkBleed ||
        // --- Морские волны (Carta Marina) ---
        newCfg.seaWaveScale !== undefined && newCfg.seaWaveScale !== oldCfg.seaWaveScale ||
        newCfg.seaWaveSpacing !== undefined && newCfg.seaWaveSpacing !== oldCfg.seaWaveSpacing ||
        newCfg.seaWaveUndulation !== undefined && newCfg.seaWaveUndulation !== oldCfg.seaWaveUndulation ||
        newCfg.seaWaveThickness !== undefined && newCfg.seaWaveThickness !== oldCfg.seaWaveThickness ||
        newCfg.seaWaveRoughness !== undefined && newCfg.seaWaveRoughness !== oldCfg.seaWaveRoughness ||
        newCfg.seaWaveOpacity !== undefined && newCfg.seaWaveOpacity !== oldCfg.seaWaveOpacity ||
        newCfg.seaWaveColor !== undefined && newCfg.seaWaveColor !== oldCfg.seaWaveColor ||
        newCfg.seaWaveShoreFade !== undefined && newCfg.seaWaveShoreFade !== oldCfg.seaWaveShoreFade ||
        newCfg.seaWaveBlendMode !== undefined && newCfg.seaWaveBlendMode !== oldCfg.seaWaveBlendMode ||
        newCfg.seaWaveFillEnabled !== undefined && newCfg.seaWaveFillEnabled !== oldCfg.seaWaveFillEnabled ||
        newCfg.seaWaveFillColor !== undefined && newCfg.seaWaveFillColor !== oldCfg.seaWaveFillColor ||
        newCfg.seaWaveFillOpacity !== undefined && newCfg.seaWaveFillOpacity !== oldCfg.seaWaveFillOpacity ||
        newCfg.waterlining !== undefined && newCfg.waterlining !== oldCfg.waterlining
      );

      if (needLightUpdate && cfg.hillshadeEnabled && !needTilesReload) {
        scheduleLiveHillshade();
      }

      const roadTypesChanged = newCfg.roadTintTypes !== undefined && newCfg.roadTintTypes !== oldCfg.roadTintTypes;
      const featTurnedOn = (newCfg.roadTintEnabled && !oldCfg.roadTintEnabled) || (newCfg.edgeTintEnabled && !oldCfg.edgeTintEnabled);
      if ((featTurnedOn || (roadTypesChanged && (cfg.roadTintEnabled || cfg.edgeTintEnabled))) && cfg.hillshadeEnabled) {
        refreshVisibleFeatureMasks(roadTypesChanged);
      }

      const isSunParamChanged = (
        newCfg.manualTimeHour !== undefined && newCfg.manualTimeHour !== oldCfg.manualTimeHour ||
        newCfg.manualDateStr !== undefined && newCfg.manualDateStr !== oldCfg.manualDateStr ||
        newCfg.sunMode !== undefined && newCfg.sunMode !== oldCfg.sunMode ||
        newCfg.sunAzimuth !== undefined && newCfg.sunAzimuth !== oldCfg.sunAzimuth ||
        newCfg.sunAltitude !== undefined && newCfg.sunAltitude !== oldCfg.sunAltitude ||
        newCfg.colorTone !== undefined && newCfg.colorTone !== oldCfg.colorTone
      );

      if (isSunParamChanged) {
        // Обновление теней и палитры крон деревьев
        if (WM.canopy && WM.canopy.onLightingChanged) {
          clearTimeout(WM.canopy._treeLightingDebounce);
          WM.canopy._treeLightingDebounce = setTimeout(() => {
            WM.canopy.onLightingChanged();
          }, 120);
        }

        // Обновление яркости дорог, рек и подписей топонимов
        if (WM.vectorRoads && WM.vectorRoads.onLightingChanged) {
          WM.vectorRoads.onLightingChanged();
        }
      }

      const needContoursRedraw = (
        newCfg.contourStep !== undefined && newCfg.contourStep !== oldCfg.contourStep ||
        newCfg.contourColor !== undefined && newCfg.contourColor !== oldCfg.contourColor ||
        newCfg.contourWidth !== undefined && newCfg.contourWidth !== oldCfg.contourWidth ||
        newCfg.contourStyle !== undefined && newCfg.contourStyle !== oldCfg.contourStyle ||
        newCfg.contourSmoothing !== undefined && newCfg.contourSmoothing !== oldCfg.contourSmoothing ||
        newCfg.contourRoughness !== undefined && newCfg.contourRoughness !== oldCfg.contourRoughness ||
        newCfg.contourHandPressure !== undefined && newCfg.contourHandPressure !== oldCfg.contourHandPressure ||
        newCfg.taperWithElevation !== undefined && newCfg.taperWithElevation !== oldCfg.taperWithElevation ||
        newCfg.taperDirection !== undefined && newCfg.taperDirection !== oldCfg.taperDirection ||
        newCfg.taperStrength !== undefined && newCfg.taperStrength !== oldCfg.taperStrength ||
        newCfg.cliffHairlines !== undefined && newCfg.cliffHairlines !== oldCfg.cliffHairlines ||
        newCfg.contourPalette !== undefined && newCfg.contourPalette !== oldCfg.contourPalette ||
        newCfg.showLabels !== undefined && newCfg.showLabels !== oldCfg.showLabels ||
        // Новая проверка для перерисовки вспомогательных полугоризонталей:
        newCfg.formLinesEnabled !== undefined && newCfg.formLinesEnabled !== oldCfg.formLinesEnabled ||
        newCfg.showLabels !== undefined && newCfg.showLabels !== oldCfg.showLabels ||
        newCfg.contourLabelScope !== undefined && newCfg.contourLabelScope !== oldCfg.contourLabelScope ||
        newCfg.contourLabelOrient !== undefined && newCfg.contourLabelOrient !== oldCfg.contourLabelOrient ||
        newCfg.contourLabelStyle !== undefined && newCfg.contourLabelStyle !== oldCfg.contourLabelStyle ||
        newCfg.contourLabelDensity !== undefined && newCfg.contourLabelDensity !== oldCfg.contourLabelDensity ||
        newCfg.contourLabelSize !== undefined && newCfg.contourLabelSize !== oldCfg.contourLabelSize ||
        newCfg.contourLabelHaloWidth !== undefined && newCfg.contourLabelHaloWidth !== oldCfg.contourLabelHaloWidth ||
        newCfg.contourLabelColorMode !== undefined && newCfg.contourLabelColorMode !== oldCfg.contourLabelColorMode ||
        newCfg.contourLabelColor !== undefined && newCfg.contourLabelColor !== oldCfg.contourLabelColor ||
        newCfg.contourLabelHaloColor !== undefined && newCfg.contourLabelHaloColor !== oldCfg.contourLabelHaloColor ||
        newCfg.contourLabelBreak !== undefined && newCfg.contourLabelBreak !== oldCfg.contourLabelBreak ||
        newCfg.contourLabelUnit !== undefined && newCfg.contourLabelUnit !== oldCfg.contourLabelUnit ||
        newCfg.contourLabelBold !== undefined && newCfg.contourLabelBold !== oldCfg.contourLabelBold ||
        newCfg.formLinesSlopeMax !== undefined && newCfg.formLinesSlopeMax !== oldCfg.formLinesSlopeMax
      );

      if (needContoursRedraw && contoursLayerInstance && cfg.contoursEnabled && !needTilesReload) {
        clearTimeout(contoursRedrawTimer);
        contoursRedrawTimer = setTimeout(() => {
          contoursLayerInstance.redraw();
        }, 100);
      }

      if (!newCfg._skipHud) {
        scheduleHudRender();
      }
    },

    initLayers(map) {
      WM.map = map; // Гарантируем привязку карты
      if (hillshadeLayerInstance && contoursLayerInstance) {
        return {
          hillshadeLayer: hillshadeLayerInstance,
          contoursLayer: contoursLayerInstance
        };
      }

      if (!map.getPane('wm-dem-hillshade-pane')) {
        map.createPane('wm-dem-hillshade-pane');
        map.getPane('wm-dem-hillshade-pane').style.zIndex = 260;
      }
      applyBlendModeToPane(map); // Применяем режим наложения сразу

      if (!map.getPane('wm-dem-contours-pane')) {
        map.createPane('wm-dem-contours-pane');
        map.getPane('wm-dem-contours-pane').style.zIndex = 333;
      }

      hillshadeLayerInstance = new WebGLHillshadeLayer({
        pane: 'wm-dem-hillshade-pane',
        maxNativeZoom: 17,
        maxZoom: 20,
        opacity: cfg.hillshadeOpacity,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 1
      });

      hillshadeLayerInstance.on('add', () => {
        applyBlendModeToPane(map);
      });
      contoursLayerInstance = new DEMContoursLayer({
        pane: 'wm-dem-contours-pane',
        minZoom: 10,
        maxNativeZoom: 16,
        maxZoom: 20,
        opacity: cfg.contourOpacity,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 1 // было 2
      });
      contoursLayerInstance.on('add', () => {
        applyBlendModeToPane();
      });

      applyLayerVisibility();

      map.off('moveend', onMapMoveEnd);
      map.on('movestart', () => {
        isSliderScrubbing = true;
      });

      map.on('moveend', () => {
        isSliderScrubbing = false;
        if (isPeakViewForeground()) return;
        if (!cfg.hillshadeEnabled || !hillshadeLayerInstance || !hillshadeLayerInstance._tiles) return;
        const center = map.getCenter();
        const sig = computeLightSig(getSunLighting(center.lat, center.lng));
        const bounds = map.getBounds();
        const tiles = hillshadeLayerInstance._tiles;
        for (const key in tiles) {
          const el = tiles[key]?.el;
          if (!el || el._removed || !el._demImg || el._isEmptyFallback || el._demImg._isEmptyFallback) continue;
          if (el._demLLB && !bounds.intersects(el._demLLB)) continue;
          if (el._renderedFast || el._lightSig !== sig) {
            scheduleLiveHillshade();
            return;
          }
        }
      });

      map.on('overlayadd overlayremove', (e) => {
        if (e.name && (e.name.includes('WebGL отмывка') || e.name.includes('Горизонтали (DEM)'))) {
          notifyDemChange(true);
        }
      });

      if (WM.terrainDecor && WM.terrainDecor.init) {
        WM.terrainDecor.init(map);
      }

      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    }
  };

 const SUN_LIGHT_PROFILE = {
  // 1. Глубокая ночь (звёзды / Луна)
  nightShadowSoftness: 0.80,
  moonMinAltDeg: 8.0,
  starElevDeg: 65.0,

  // --- СВЕТ ЗВЁЗД (без Луны) ---
  // Сама ночь становится темнее (было #8da2d2 и k: 0.70):
  nightStarLightHex: '#485880',   // приглушённый звёздный свет (не слепит пики)
  nightShadowHex: '#1e2544',      // БЫЛО #121830: тени стали заметно светлее и синее
  nightSkyHex: '#141c38',
  nightStarK: 0.38,               // БЫЛО 0.70: ночь становится более глубокой и тёмной

  // --- СВЕТ ПОЛНОЙ ЛУНЫ ---
  // Луна светит благородным серебристым светом умеренной яркости (было #a6c4f7 и k: 0.82):
  nightMoonLightHex: '#6c85b5',  // мягкий лунный свет
  nightMoonShadowHex: '#222b4c', // БЫЛО #171f3f: тени гораздо светлее и мягче
  nightMoonSkyHex: '#18244a',
  nightMoonK: 0.46,              // БЫЛО 0.82: мягкая ночная яркость

  moonPhaseGamma: 1.5,
  moonLowAltFactor: 0.45,
  moonNightMinAltDeg: 14.0,      // чуть выше минимальный угол, чтобы тени не растягивались на весь экран

  starAzimuthDeg: 315.0,
  starNightElevDeg: 60.0,

  starShadowMul: 0.0,            // у звёздного рассеянного света НЕТ резких теней
  moonShadowMul: 0.45,           // БЫЛО 1.25: резкость и глубина теней Луны снижена почти в 3 раза!
  nightHazeStrength: 0.22,
  nightValleyHex: '#232b4e',     // БЫЛО #1a2044: низины не проваливаются в темноту
  nightTwilightFade: 0.85,
  nightDepthStartAlt: -8.0,
  nightDepthFullAlt: -16.0,

  // 2. Тёмный час
  darkHourStartAlt: -18.0,
  darkHourEndAlt: -10.0,
  darkHourBrightness: 0.45,      // БЫЛО 0.68: темный час приведен к общей глубине ночи
  darkHourSkyHex: '#161d40',
  darkHourShadowHex: '#1e2444',
  darkHourLightHex: '#3c4b78',
  // 3. Рассвет и освещенные солнцем склоны
  dawnCivilStart: -8.0,
  dawnFaceHex: '#ffb494',
  dawnGlowHex: '#ff5762',
  dawnRimHex: '#d65d29',
  dawnValleyHex: '#283257',
  dawnLightHex: '#e4a067',
  dawnSkyHex: '#3e437e',
  dawnGlowIntensity: 1.10,

  // Утренний золотой час
  morningGoldenEnd: 6.0,
  morningGoldenLightHex: '#ffae00',
  morningGoldenSkyHex: '#526e99',

  // 4. Дневное солнце и охват свечения
  dayLightReach: 0.52,
  dayLightHex: '#fef1d7',
  dayShadowHex: '#464f62',
  daySkyHex: '#477abd',
  daySunIntensity: 1.0,
  dayGlowHex: '#ffe4ad',
  dayGlowStrength: 0.75,
  hazeStrength: 0.65,

  // 5. Закат и вечер
  eveningGoldenStart: 5.5,
  eveningGoldenLightHex: '#ff6633',  // сочный пламенно-оранжевый золотой час
  eveningGoldenSkyHex: '#483366',

  duskCivilEnd: -8.0,
  duskFaceHex: '#ff6b6b',            // кораллово-красный цвет освещённых граней (вместо #ffffff)
  twilightSatLimit: 1.0,
  duskGlowHex: '#ff2244',            // насыщенный багрово-алый альпенглоу (вместо жёлтого #ffd257)
  duskRimHex: '#e11d48',             // пунцово-рубиновая кайма терминатора
  duskValleyHex: '#181236',
  duskLightHex: '#ff4422',           // огненно-красный закатный луч (вместо жёлтого #dd9a08)
  duskSkyHex: '#302652',
  duskGlowIntensity: 1.30,           // усиленная выразительность свечения вершин

  // 6. Синий час
  postDuskCutoff: -15.0,
  blueHourTint: 0.70,
  postDuskSkyHex: '#2a2f86',
  postDuskValleyHex: '#171a3d'
};

  const _origGetSunLighting = getSunLighting;

  getSunLighting = function(centerLat, centerLng) {
    if (cfg.sunMode === 'manual' || cfg.sunMode === 'swiss' || !window.SunCalc) {
      return _origGetSunLighting(centerLat, centerLng);
    }

    const S = SUN_LIGHT_PROFILE;
    const dateForCalc = (cfg.sunMode === 'time') ? getEffectiveSunDate(centerLat, centerLng) : new Date();

    const sunPos = SunCalc.getPosition(dateForCalc, centerLat, centerLng);
    const sunAltDeg = sunPos.altitude * (180 / Math.PI);
    const sunAz = sunPos.azimuth + Math.PI;

    // Визуальная высота света. Днём — реальная (но не ниже 6°, чтобы тени не были бесконечными).
    // После захода Солнца прямых лучей нет, остаётся мягкий отсвет зари: поднимаем его до ~28°,
    // но АЗИМУТ оставляем солнечным — зарево всегда видно со стороны, где село (встанет) Солнце.
    const visualSunAltDeg = sunAltDeg >= 0.0
      ? Math.max(6.0, sunAltDeg)
      : 6.0 + 22.0 * smoothstep(0.0, -10.0, sunAltDeg);
    const visualSunAltRad = (visualSunAltDeg * Math.PI) / 180;
    const cosVisualAlt = Math.cos(visualSunAltRad);
    const sunV = [Math.sin(sunAz) * cosVisualAlt, -Math.cos(sunAz) * cosVisualAlt, Math.sin(visualSunAltRad)];

    let isMorning = false;
    try {
      const times = SunCalc.getTimes(dateForCalc, centerLat, centerLng);
      if (times.solarNoon && !isNaN(times.solarNoon.getTime())) {
        isMorning = dateForCalc.getTime() < times.solarNoon.getTime();
      } else {
        isMorning = (dateForCalc.getUTCHours() + centerLng / 15 + 24) % 24 < 12;
      }
    } catch (e) { isMorning = false; }

    // Динамическая Луна
    let moonUp = 0, moonAmt = 0, moonFrac = 0.5, moonAltDeg = -90;
    let moonDir = [0.0, 0.0, 1.0];

    if (SunCalc.getMoonPosition) {
      const mp = SunCalc.getMoonPosition(dateForCalc, centerLat, centerLng);
      moonAltDeg = mp.altitude * (180 / Math.PI);
      const mAz = mp.azimuth + Math.PI;
      const illum = SunCalc.getMoonIllumination ? SunCalc.getMoonIllumination(dateForCalc) : { fraction: 0.5 };
      moonFrac = illum.fraction;

      // Луна над горизонтом с учетом атмосферной рефракции
      moonUp = smoothstep(-0.5, 4.0, moonAltDeg);
      const altFactor = smoothstep(0.0, 35.0, moonAltDeg) * 0.5 + 0.5;
      moonAmt = moonUp * clamp(moonFrac, 0.05, 1.0) * altFactor;

      const effAlt = (Math.max(S.moonMinAltDeg, moonAltDeg) * Math.PI) / 180;
      const cA = Math.cos(effAlt);
      moonDir = [Math.sin(mAz) * cA, -Math.cos(mAz) * cA, Math.sin(effAlt)];
    }

    // Рассеянный купольный свет звёзд
    const starAlt = (S.starElevDeg * Math.PI) / 180;
    const cS = Math.cos(starAlt);
    const starV = normalizeVec3([Math.sin(sunAz + Math.PI) * cS, -Math.cos(sunAz + Math.PI) * cS, Math.sin(starAlt)]);

    // ================= НОВАЯ НОЧЬ =================
    // 0 при высоте Солнца >= -8° (сумерки не затронуты), 1 при <= -16°
    const nightDepthLegacy = smoothstep(S.nightDepthStartAlt, S.nightDepthFullAlt, sunAltDeg);

    // Сила лунного света: фаза (нелинейно) × высота × ослабление у горизонта
    const moonPhaseW = Math.pow(clamp(moonFrac, 0.0, 1.0), S.moonPhaseGamma);
    const moonAltW   = lerp(S.moonLowAltFactor, 1.0, smoothstep(0.0, 40.0, moonAltDeg));
    const moonStr    = smoothstep(-1.0, 6.0, moonAltDeg) * moonPhaseW * moonAltW;

    // Ночная палитра: звёзды -> Луна пропорционально moonStr
    const nLight = lerpVec3(hexToVec3(S.nightStarLightHex),  hexToVec3(S.nightMoonLightHex),  moonStr);
    const nSha   = lerpVec3(hexToVec3(S.nightShadowHex),     hexToVec3(S.nightMoonShadowHex), moonStr);
    const nSky   = lerpVec3(hexToVec3(S.nightSkyHex),        hexToVec3(S.nightMoonSkyHex),    moonStr);
    const nK     = lerp(S.nightStarK, S.nightMoonK, moonStr);

    // Новое направление света: звёзды = мягкий СЗ-свет, Луна = настоящая Луна
    const moonHor  = Math.hypot(moonDir[0], moonDir[1]) || 1.0;
    const mAltN    = (Math.max(S.moonNightMinAltDeg, moonAltDeg) * Math.PI) / 180;
    const moonVNew = normalizeVec3([
      (moonDir[0] / moonHor) * Math.cos(mAltN),
      (moonDir[1] / moonHor) * Math.cos(mAltN),
      Math.sin(mAltN)
    ]);
    const starAzN  = (S.starAzimuthDeg * Math.PI) / 180;
    const starAltN = (S.starNightElevDeg * Math.PI) / 180;
    const starVNew = normalizeVec3([
      Math.sin(starAzN) * Math.cos(starAltN),
      -Math.cos(starAzN) * Math.cos(starAltN),
      Math.sin(starAltN)
    ]);
    const nightVNew = normalizeVec3(lerpVec3(starVNew, moonVNew, smoothstep(0.03, 0.22, moonStr)));

    const dayL   = hexToVec3(S.dayLightHex);
    const dayS   = hexToVec3(S.dayShadowHex);
    const daySky = hexToVec3(S.daySkyHex);

    const dhLight = hexToVec3(S.darkHourLightHex);
    const dhSha   = hexToVec3(S.darkHourShadowHex);
    const dhSky   = hexToVec3(S.darkHourSkyHex);

    const dawnStops = [
      { a: S.darkHourStartAlt - 4.0, light: nLight, shadow: nSha, sky: nSky, k: nK },
      { a: S.darkHourStartAlt,       light: lerpVec3(nLight, dhLight, 0.25), shadow: lerpVec3(nSha, dhSha, 0.25), sky: lerpVec3(nSky, dhSky, 0.25), k: nK },
      { a: S.darkHourEndAlt,         light: lerpVec3(nLight, dhLight, 0.80), shadow: lerpVec3(nSha, dhSha, 0.80), sky: lerpVec3(nSky, dhSky, 0.80), k: lerp(nK, S.darkHourBrightness, 0.80) },
      { a: S.dawnCivilStart,         light: hexToVec3(S.dawnLightHex), shadow: hexToVec3(S.dawnValleyHex), sky: hexToVec3(S.dawnSkyHex), k: 0.72 },
      { a: -0.5,                     light: hexToVec3(S.dawnLightHex), shadow: hexToVec3(S.dawnValleyHex), sky: hexToVec3(S.dawnSkyHex), k: 0.78 },
      { a: S.morningGoldenEnd,       light: hexToVec3(S.morningGoldenLightHex), shadow: lerpVec3(hexToVec3(S.dawnValleyHex), dayS, 0.6), sky: hexToVec3(S.morningGoldenSkyHex), k: 0.88 },
      { a: 15.0,                     light: dayL, shadow: dayS, sky: daySky, k: S.daySunIntensity }
    ];

    const duskStops = [
      { a: S.postDuskCutoff - 4.0, light: nLight, shadow: nSha, sky: nSky, k: nK },
            { a: S.postDuskCutoff, light: nLight, shadow: lerpVec3(nSha, hexToVec3(S.postDuskValleyHex), S.blueHourTint), sky: lerpVec3(nSky, hexToVec3(S.postDuskSkyHex), S.blueHourTint), k: nK },
      { a: S.duskCivilEnd,         light: hexToVec3(S.duskLightHex), shadow: hexToVec3(S.duskValleyHex), sky: hexToVec3(S.duskSkyHex), k: 0.70 },
      { a: -0.5,                   light: hexToVec3(S.duskLightHex), shadow: hexToVec3(S.duskValleyHex), sky: hexToVec3(S.duskSkyHex), k: 0.76 },
      { a: S.eveningGoldenStart,   light: hexToVec3(S.eveningGoldenLightHex), shadow: lerpVec3(hexToVec3(S.duskValleyHex), dayS, 0.5), sky: hexToVec3(S.eveningGoldenSkyHex), k: 0.86 },
      { a: 15.0,                   light: dayL, shadow: dayS, sky: daySky, k: S.daySunIntensity }
    ];

    const ramp = sampleRamp(isMorning ? dawnStops : duskStops, sunAltDeg);

    // ---- ФАЗЫ ----
    //  alt > +4°        : обычный день
    //  +4° ... -3°      : «ползущий терминатор» — прямой свет уходит с низин на вершины (физически: горизонт приподнят)
    //  -3° ... -13°     : АФТЕРГЛОУ — прямого света нет, есть мягкий отсвет зари со стороны Солнца
    //  -10° ... -17°    : переход к ночи (звёзды/Луна), только когда зарево уже погасло
    const nightW = smoothstep(-10.0, -17.0, sunAltDeg);      // 0 -> сумерки, 1 -> ночь

    // Терминатор симметричен для рассвета и заката: зависит только от высоты Солнца
    const climbP = smoothstep(4.0, -3.0, sunAltDeg);
    const twClimb = -0.15 + climbP * 1.55;                   // 1.40 > типичного hEff пиков: на вершинах гарантированно темно

    let twAmt, glowW, glowCol, valleyCol, rimCol;
    if (!isMorning) {
      twAmt   = smoothstep(S.eveningGoldenStart, 0.5, sunAltDeg);
      glowW   = smoothstep(3.0, -0.5, sunAltDeg) * smoothstep(-5.0, -1.5, sunAltDeg) * S.duskGlowIntensity;
      glowCol   = hexToVec3(S.duskGlowHex);
      valleyCol = hexToVec3(S.duskValleyHex);
      rimCol    = hexToVec3(S.duskRimHex);
    } else {
      twAmt   = smoothstep(S.morningGoldenEnd, 1.0, sunAltDeg);
      glowW   = smoothstep(-5.0, -1.5, sunAltDeg) * smoothstep(3.0, -0.5, sunAltDeg) * S.dawnGlowIntensity;
      glowCol   = hexToVec3(S.dawnGlowHex);
      valleyCol = hexToVec3(S.dawnValleyHex);
      rimCol    = hexToVec3(S.dawnRimHex);
    }
    // twAmt остаётся 1 на всём протяжении сумерек и гаснет только вместе с переходом к ночи
    twAmt *= 1.0 - nightW;

    // Афтерглоу: включается, когда Солнце ушло под горизонт, гаснет к -13°
    const afterglow = smoothstep(1.5, -1.5, sunAltDeg) * smoothstep(-13.0, -6.0, sunAltDeg);

    valleyCol = lerpVec3(valleyCol, hexToVec3(S.nightValleyHex), nightW);

    // Направление света: СОЛНЕЧНЫЙ азимут держим, пока есть хоть какой-то отсвет зари.
    // К звёздам/Луне переходим только в самом конце сумерек (никогда не через «противоположную» сторону днём).
    const nightV = nightVNew;
    const finalLightVec = normalizeVec3(lerpVec3(sunV, nightV, nightW));
    const toNight = 1.0 - smoothstep(-10.0, 1.5, sunAltDeg);   // для мягкости теней
    const nightDepth = nightW;                                 // совместимость с shadowMul / haze ниже
    // В момент смены направления слегка приглушаем свет, чтобы поворот не бросался в глаза
    const swapDip = 1.0 - 0.30 * 4.0 * nightW * (1.0 - nightW);
    const dayWeight = smoothstep(1.0, 16.0, sunAltDeg);

    const sunFaceCol = isMorning ? hexToVec3(S.dawnFaceHex) : hexToVec3(S.duskFaceHex);

    return {
      sunVec: finalLightVec,
      lightColor: ramp.light,
      shadowColor: ramp.shadow,
      skyColor: ramp.sky,
      alpenglowWeight: glowW,
      sunIntensity: ramp.k * swapDip,
      afterglow: afterglow,
      warmCool: 0.85,
      isSwiss: false,
      twilightClimb: twClimb,
      twilightAmt: twAmt,
      glowColor: glowCol,
      valleyColor: valleyCol,
      twilightRimColor: rimCol,
      sunFaceColor: sunFaceCol,
      twilightSat: S.twilightSatLimit,
      dayReach: S.dayLightReach,
      sunAltDeg: sunAltDeg,
      nightWeight: nightW,
      isMorning: isMorning, // <-- ДОБАВЛЕНО: признак первой половины суток (утро/восход)
      shadowMul: lerp(
        lerp(1.0, S.nightShadowSoftness, toNight),
        lerp(S.starShadowMul, S.moonShadowMul, smoothstep(0.05, 0.45, moonStr)),
        nightDepth
      ),
      dayGlowColor: hexToVec3(S.dayGlowHex),
      dayGlowStrength: S.dayGlowStrength * dayWeight,
      hazeStrength: lerp(S.hazeStrength, S.nightHazeStrength, nightDepth)
    };
  };

  // Мемоизация освещения: за один кадр/ревизию настроек getSunLighting вызывается десятки раз
  // (createTile для каждого тайла, updateLive, контуры) — результат одинаков.
  const _sunLightingRaw = getSunLighting;
  let _slKey = null, _slVal = null;
  getSunLighting = function (centerLat, centerLng) {
    let wk = '';
    try {
      const w = WM.weather;
      if (w && w.getCacheKey) {
        const c = w.getCache && w.getCache();
        wk = w.getCacheKey() + '|' + (c ? c.utc_offset_seconds : '');
      }
    } catch (e) {}
    const timeDependent = !(cfg.sunMode === 'time' || cfg.sunMode === 'manual' || cfg.sunMode === 'swiss');
    const stamp = timeDependent ? Math.floor(Date.now() / 1000) : new Date().toDateString();
    const key = cfgRev + '|' + centerLat + '|' + centerLng + '|' + stamp;
    if (key === _slKey && _slVal) return _slVal;
    const v = _sunLightingRaw(centerLat, centerLng);
    _slKey = key;
    _slVal = v;
    return v;
  };
// =========================================================================
// ДИАГНОСТИЧЕСКИЙ ПРОФАЙЛЕР ПРОИЗВОДИТЕЛЬНОСТИ (DEM RELIEF PROFILER)
// =========================================================================
WM.perf = {
  enabled: true,
  metrics: {
    fps: 60,
    tilesCount: 0,
    cpuCalcMs: 0,
    geomPassCount: 0,
    bakePassCount: 0,
    glDrawMs: 0,
    blitMs: 0,
    totalFrameMs: 0
  },
  _accum: {
    tiles: 0, geom: 0, bake: 0,
    cpuMs: 0, glMs: 0, blitMs: 0, frames: 0, lastSec: performance.now()
  },
  _activeFrame: null,

  beginFrame() {
    if (!this.enabled) return;
    this._activeFrame = {
      t0: performance.now(),
      cpuT0: performance.now(),
      cpuCalcMs: 0,
      geomCount: 0,
      bakeCount: 0,
      glDrawMs: 0,
      blitMs: 0,
      tilesCount: 0
    };
  },

  markCpuCalcEnd() {
    if (!this._activeFrame) return;
    this._activeFrame.cpuCalcMs = performance.now() - this._activeFrame.cpuT0;
  },

  recordTile({ geomPass, bakePass, glDrawMs, blitMs }) {
    if (!this._activeFrame) return;
    this._activeFrame.tilesCount++;
    if (geomPass) this._activeFrame.geomCount++;
    if (bakePass) this._activeFrame.bakeCount++;
    this._activeFrame.glDrawMs += glDrawMs;
    this._activeFrame.blitMs += blitMs;
  },

  endFrame() {
    if (!this._activeFrame) return;
    const now = performance.now();
    const frameMs = now - this._activeFrame.t0;
    const a = this._accum;

    a.frames++;
    a.tiles += this._activeFrame.tilesCount;
    a.geom += this._activeFrame.geomCount;
    a.bake += this._activeFrame.bakeCount;
    a.cpuMs += this._activeFrame.cpuCalcMs;
    a.glMs += this._activeFrame.glDrawMs;
    a.blitMs += this._activeFrame.blitMs;

    // Сброс и усреднение каждые 200 мс для стабильности цифр
    if (now - a.lastSec >= 200) {
      const dt = (now - a.lastSec) / 1000;
      this.metrics.fps = Math.round(a.frames / dt);
      this.metrics.tilesCount = Math.round(a.tiles / a.frames);
      this.metrics.geomPassCount = Math.round(a.geom / a.frames);
      this.metrics.bakePassCount = Math.round(a.bake / a.frames);
      this.metrics.cpuCalcMs = +(a.cpuMs / a.frames).toFixed(2);
      this.metrics.glDrawMs = +(a.glMs / a.frames).toFixed(2);
      this.metrics.blitMs = +(a.blitMs / a.frames).toFixed(2);
      this.metrics.totalFrameMs = +frameMs.toFixed(2);

      this._updateHud();
      a.frames = a.tiles = a.geom = a.bake = a.cpuMs = a.glMs = a.blitMs = 0;
      a.lastSec = now;
    }
    this._activeFrame = null;
  },

  _hudEl: null,
  showHud() {
    if (this._hudEl) { this._hudEl.style.display = 'block'; return; }
    const d = document.createElement('div');
    d.id = 'wm-perf-hud';
    d.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 999999;
      background: rgba(15, 18, 28, 0.92); color: #eceff4;
      font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px;
      padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); pointer-events: none; width: 230px;
      line-height: 1.45; backdrop-filter: blur(4px);
    `;
    document.body.appendChild(d);
    this._hudEl = d;
  },

  hideHud() {
    if (this._hudEl) this._hudEl.style.display = 'none';
  },

  _updateHud() {
    if (!this._hudEl || this._hudEl.style.display === 'none') return;
    const m = this.metrics;
    const fpsColor = m.fps >= 50 ? '#4ade80' : m.fps >= 28 ? '#facc15' : '#f87171';
    
    // Детекция узких мест (Bottlenecks)
    let alert = '';
    if (m.geomPassCount > 0) alert += '<div style="color:#ef4444;font-weight:bold;">⚠️ УТЕЧКА: Пересчет геометрии!</div>';
    if (m.bakePassCount > 0) alert += '<div style="color:#ef4444;font-weight:bold;">⚠️ УТЕЧКА: Пересчет штриховки!</div>';
    if (m.blitMs > 8.0) alert += '<div style="color:#f97316;">⚠️ GPU Stall на blit/drawImage!</div>';
    if (m.glDrawMs > 12.0) alert += '<div style="color:#f97316;">⚠️ GPU Bound: лучи теней/шейдер!</div>';

    this._hudEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:6px; border-bottom:1px solid #334155; padding-bottom:4px;">
        <span style="font-weight:bold; color:#94a3b8;">RELIEF PROFILER</span>
        <span style="font-weight:bold; font-size:13px; color:${fpsColor};">${m.fps} FPS</span>
      </div>
      <div>Видимых тайлов: <b>${m.tilesCount}</b></div>
      <div>CPU (Sun/Warp/Loop): <b>${m.cpuCalcMs} ms</b></div>
      <div style="color:${m.glDrawMs > 10 ? '#f87171' : '#cbd5e1'}">WebGL Draw (Шейдер): <b>${m.glDrawMs} ms</b></div>
      <div style="color:${m.blitMs > 6 ? '#f87171' : '#cbd5e1'}">Canvas Blit/DrawImage: <b>${m.blitMs} ms</b></div>
      <div>Пересчет Geom/Bake: <b>${m.geomPassCount}/${m.bakePassCount}</b></div>
      ${alert ? `<div style="margin-top:6px; border-top:1px dashed #475569; padding-top:4px;">${alert}</div>` : ''}
    `;
  },

  // Запуск 2-секундной детальной трассировки в консоль
  traceLog() {
    console.log('%c[WM.perf] Запуск трассировки на 60 кадров...', 'color:#38bdf8; font-weight:bold;');
    const samples = [];
    const origEnd = this.endFrame.bind(this);
    let count = 0;

    this.endFrame = () => {
      origEnd();
      if (count++ < 60) {
        samples.push({ ...this.metrics });
      } else {
        this.endFrame = origEnd;
        console.table(samples.slice(10, 30));
        console.log('%c[WM.perf] Анализ завершен. Проверьте средние задержки в таблице.', 'color:#4ade80; font-weight:bold;');
      }
    };
  }
};

// =========================================================================
// ДИАГНОСТИЧЕСКИЙ ИНСПЕКТОР СЫРЫХ ПИКСЕЛЕЙ DEM
// =========================================================================
// =========================================================================
// УЛУЧШЕННЫЙ ДИАГНОСТИЧЕСКИЙ ИНСПЕКТОР СЫРЫХ ПИКСЕЛЕЙ DEM ДЛЯ AI-АНАЛИЗА
// =========================================================================
WM.demInspector = {
  active: false,
  _panel: null,

  toggle() {
    this.active = !this.active;
    if (!this._panel) this._createPanel();
    this._panel.style.display = this.active ? 'block' : 'none';
    if (this.active) {
      if (WM.map) {
        WM.map.getContainer().style.cursor = 'crosshair';
        WM.map.on('mousemove', this._onMouseMove, this);
        WM.map.on('click', this._onClick, this);
      }
      console.log('%c🔍 DEM Inspector активирован!', 'color:#38bdf8;font-weight:bold;font-size:13px;');
      console.log('Наведите курсор на артефакт для быстрого анализа. Кликните левой кнопкой мыши, чтобы ПОЛНЫЙ ДИАГНОСТИЧЕСКИЙ ОТЧЕТ скопировался в буфер обмена.');
    } else {
      if (WM.map) {
        WM.map.getContainer().style.cursor = '';
        WM.map.off('mousemove', this._onMouseMove, this);
        WM.map.off('click', this._onClick, this);
      }
    }
  },

  _createPanel() {
    const p = document.createElement('div');
    p.id = 'wm-dem-inspector-hud';
    p.style.cssText = `
      position: fixed; bottom: 30px; left: 20px; z-index: 999999;
      background: rgba(10, 14, 23, 0.95); color: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; line-height: 1.45; padding: 12px 16px;
      border-radius: 8px; border: 1px solid rgba(56, 189, 248, 0.5);
      box-shadow: 0 10px 30px rgba(0,0,0,0.7); pointer-events: none;
      min-width: 320px; max-width: 420px; backdrop-filter: blur(8px);
    `;
    document.body.appendChild(p);
    this._panel = p;
  },

  _decodeTerrarium(r, g, b, a) {
    if (a < 30) return null;
    return (r * 256.0 + g + b / 256.0) - 32768.0;
  },

  _collectDiagnostics(latlng) {
    if (!WM.map) return null;
    const z = WM.map.getZoom();
    const lat = latlng.lat;
    const lng = latlng.lng;
    const point = WM.map.project(latlng, z);
    const tileSize = 256;
    const tx = Math.floor(point.x / tileSize);
    const ty = Math.floor(point.y / tileSize);

    const srcKey = cfg.demSource || 'fabdem';
    const cacheKey = `${srcKey}:${z}:${tx}:${ty}`;
    const cv = paddedDemMemoryCache.get(cacheKey);

    if (!cv) {
      return { status: 'loading', z, tx, ty, lat, lng, srcKey };
    }

    const ctx = cv.getContext('2d');
    const B = cv._pad || 0;
    const S = cv._tileSize || 256;

    // Локальные пиксели в пределах базового тайла 256x256
    const localX = Math.floor(((point.x % tileSize) + tileSize) % tileSize);
    const localY = Math.floor(((point.y % tileSize) + tileSize) % tileSize);

    // Соответствующий пиксель в padded canvas (размер S + 2*B)
    const scale = S / tileSize;
    const px = Math.round(B + localX * scale);
    const py = Math.round(B + localY * scale);

    // Считываем область 5x5 пикселей
    const rad = 2;
    const size = rad * 2 + 1;
    const imgData = ctx.getImageData(px - rad, py - rad, size, size).data;

    const gridH = [];
    const gridRGBA = [];
    const bValues = [];
    let hasNull = false;

    for (let r = 0; r < size; r++) {
      const rowH = [];
      const rowRGBA = [];
      for (let c = 0; c < size; c++) {
        const idx = (r * size + c) * 4;
        const red = imgData[idx];
        const grn = imgData[idx + 1];
        const blu = imgData[idx + 2];
        const alp = imgData[idx + 3];
        const h = this._decodeTerrarium(red, grn, blu, alp);
        if (h === null) hasNull = true;
        rowH.push(h !== null ? Number(h.toFixed(3)) : null);
        rowRGBA.push(`[${red},${grn},${blu}]`);
        bValues.push(blu);
      }
      gridH.push(rowH);
      gridRGBA.push(rowRGBA);
    }

    const centerH = gridH[rad][rad];

    // Анализ поведения канала Blue (дробная часть высоты)
    const allBZero = bValues.every(b => b === 0);
    const uniqueB = new Set(bValues).size;

    // Расчет уклонов и Sobel-фильтра, как в шейдере
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z) / (S / 256.0);
    const effZ = typeof getEffectiveZFactor === 'function' ? getEffectiveZFactor() : cfg.zFactor;

    // 3x3 окрестность из центра матрицы 5x5
    const z00 = gridH[1][1], z10 = gridH[1][2], z20 = gridH[1][3];
    const z01 = gridH[2][1],              z21 = gridH[2][3];
    const z02 = gridH[3][1], z12 = gridH[3][2], z22 = gridH[3][3];

    let dzdx = 0, dzdy = 0, rawSlope = 0, stepThreshold = 0, terraceDamp = 1.0;
    if (centerH !== null && !hasNull) {
      const deltaMeters = Math.max(0.1, 2.0 * 1.0 * mpp);
      dzdx = ((z20 + 2.0 * z21 + z22) - (z00 + 2.0 * z01 + z02)) / (8.0 * deltaMeters) * effZ;
      dzdy = ((z02 + 2.0 * z12 + z22) - (z00 + 2.0 * z10 + z20)) / (8.0 * deltaMeters) * effZ;
      rawSlope = Math.hypot(dzdx, dzdy);
      stepThreshold = (2.0 * effZ) / deltaMeters;

      // Текущая логика шейдера terraceDamp
      const smoothstep = (e0, e1, x) => {
        const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
      };
      if (rawSlope < stepThreshold) {
        terraceDamp = smoothstep(0.01, stepThreshold, rawSlope);
      }
    }

    // Дельты к прямым соседям
    const deltaLeft = (centerH !== null && gridH[2][1] !== null) ? Number((centerH - gridH[2][1]).toFixed(3)) : 0;
    const deltaTop  = (centerH !== null && gridH[1][2] !== null) ? Number((centerH - gridH[1][2]).toFixed(3)) : 0;

    // Проверка признаков артефактов
    const isExact1mStep = Math.abs(Math.abs(deltaLeft) - 1.0) < 0.04 || Math.abs(Math.abs(deltaTop) - 1.0) < 0.04;
    const isMacroblockEdge = (localX % 8 === 0 || localX % 16 === 0 || localY % 8 === 0 || localY % 16 === 0);
    const isTerraceCoringFailed = rawSlope >= stepThreshold && (isExact1mStep || allBZero);

    // Предполагаемый вердикт
    let verdict = 'Нормальный рельеф';
    if (allBZero) {
      verdict = '1-метровое целочисленное квантование источника (канал Blue = 0)';
    } else if (isExact1mStep) {
      verdict = 'Ступенька квантования 1.000 м между пикселями';
    } else if (isMacroblockEdge && uniqueB > 1) {
      verdict = 'Подозрение на границу 8x8/16x16 блока сжатия WebP/JPEG';
    }

    return {
      status: 'ok',
      coords: { z, tx, ty, localX, localY, lat: +lat.toFixed(6), lng: +lng.toFixed(6) },
      environment: {
        source: srcKey,
        tileCanvasSize: S,
        pad: B,
        metersPerPixel: +mpp.toFixed(3),
        effectiveZFactor: +effZ.toFixed(2),
        smoothMode: cfg.smoothMode
      },
      pixelAnalysis: {
        centerH,
        deltaLeft,
        deltaTop,
        allBZero,
        uniqueBIn5x5: uniqueB,
        isMacroblockEdge,
        macroblockMod: `${localX % 16}:${localY % 16}`
      },
      shaderMath: {
        dzdx: +dzdx.toFixed(4),
        dzdy: +dzdy.toFixed(4),
        rawSlope: +rawSlope.toFixed(4),
        stepThreshold: +stepThreshold.toFixed(4),
        terraceDampFactor: +terraceDamp.toFixed(3),
        isCoringActive: rawSlope < stepThreshold
      },
      verdict,
      matrix5x5_H: gridH,
      matrix5x5_RGBA: gridRGBA
    };
  },

  _onMouseMove(e) {
    const d = this._collectDiagnostics(e.latlng);
    if (!d || d.status === 'loading') {
      this._panel.innerHTML = `<span style="color:#94a3b8">Загрузка тайла z:${d?.z} [${d?.tx}, ${d?.ty}]...</span>`;
      return;
    }

    const isIssue = d.pixelAnalysis.allBZero || Math.abs(d.pixelAnalysis.deltaLeft) >= 0.85 || Math.abs(d.pixelAnalysis.deltaTop) >= 0.85;
    const vColor = isIssue ? '#f87171' : '#4ade80';

    this._panel.innerHTML = `
      <div style="border-bottom:1px solid #334155; padding-bottom:4px; margin-bottom:6px; display:flex; justify-content:space-between;">
        <span style="color:#94a3b8">Zoom <b>${d.coords.z}</b> | Px <b>${d.coords.localX},${d.coords.localY}</b></span>
        <span style="color:#38bdf8; font-weight:bold;">Клик = Копировать</span>
      </div>
      <div>Высота: <b style="font-size:13px; color:#38bdf8">${d.pixelAnalysis.centerH !== null ? d.pixelAnalysis.centerH.toFixed(2) : 'NaN'} м</b></div>
      <div>ΔX / ΔY: <b style="color:${Math.abs(d.pixelAnalysis.deltaLeft)>=0.9?'#ef4444':'#facc15'}">${d.pixelAnalysis.deltaLeft} м</b> / <b style="color:${Math.abs(d.pixelAnalysis.deltaTop)>=0.9?'#ef4444':'#facc15'}">${d.pixelAnalysis.deltaTop} м</b></div>
      <div>Канал Blue (дробный): <b>${d.pixelAnalysis.allBZero ? '<span style="color:#ef4444">ВСЕ 0 (КВАНТОВАНО ДО 1 М)</span>' : 'Активен (' + d.pixelAnalysis.uniqueBIn5x5 + ' знач.)'}</b></div>
      <div>Slope: <b>${d.shaderMath.rawSlope}</b> | Порог шейдера: <b>${d.shaderMath.stepThreshold}</b></div>
      <div>Coring фильтр: <b style="color:${d.shaderMath.isCoringActive ? '#4ade80':'#f87171'}">${d.shaderMath.isCoringActive ? 'Смягчает (x' + d.shaderMath.terraceDampFactor + ')' : 'ВЫКЛЮЧЕН (ПРОПУСКАЕТ)'}</b></div>
      <div style="margin-top:6px; padding-top:4px; border-top:1px dashed #334155; color:${vColor}; font-weight:bold;">
        ⚠ ${d.verdict}
      </div>
    `;
  },

  _onClick(e) {
    const d = this._collectDiagnostics(e.latlng);
    if (!d || d.status === 'loading') return;

    const reportJson = JSON.stringify(d, null, 2);

    const matrixHStr = d.matrix5x5_H.map(row => 
      '  [' + row.map(v => (v === null ? ' NaN ' : v.toFixed(2).padStart(7, ' '))).join(', ') + ']'
    ).join('\n');

    const matrixRGBStr = d.matrix5x5_RGBA.map(row => 
      '  [' + row.map(v => v.padStart(13, ' ')).join(', ') + ']'
    ).join('\n');

    const markdownReport = 
`### 🔬 DEM Pixel Artifact Diagnostic Report

**Координаты и положение:**
- Координаты: Lat ${d.coords.lat}, Lng ${d.coords.lng} (Zoom: ${d.coords.z})
- Тайл Leaflet: x=${d.coords.tx}, y=${d.coords.ty}
- Локальный пиксель тайла (0..255): X=${d.coords.localX}, Y=${d.coords.localY}
- Источник: \`${d.environment.source}\` (Meters per pixel: ${d.environment.metersPerPixel} m/px)
- Режим сглаживания: \`${d.environment.smoothMode}\`, zFactor: ${d.environment.effectiveZFactor}

**Сырые параметры центрального пикселя:**
- Высота H: ${d.pixelAnalysis.centerH} м
- Смещение к соседям: ΔX = ${d.pixelAnalysis.deltaLeft} м, ΔY = ${d.pixelAnalysis.deltaTop} м
- Канал Blue (Terrarium sub-meter): ${d.pixelAnalysis.allBZero ? 'ПОЛНОСТЬЮ 0 (1-метровое целочисленное квантование растра)' : 'Есть градации (' + d.pixelAnalysis.uniqueBIn5x5 + ' уникальных в 5x5)'}
- Положение относительно сетки макроблоков WebP (mod 8 / mod 16): ${d.pixelAnalysis.macroblockMod} (Граница блока: ${d.pixelAnalysis.isMacroblockEdge})

**Математика шейдера геометрии:**
- Slope (длина градиента dz/dx, dz/dy): ${d.shaderMath.rawSlope}
- stepThreshold (порог срабатывания terrace coring): ${d.shaderMath.stepThreshold}
- Активен ли фильтр ступенек: ${d.shaderMath.isCoringActive ? 'ДА (множитель ' + d.shaderMath.terraceDampFactor + ')' : 'НЕТ (уклон превысил порог и ступенька осталась резкой)'}

**Матрица высот 5x5 вокруг точки (в метрах):**
\`\`\`
${matrixHStr}
\`\`\`

**Матрица сырых RGB каналов 5x5:**
\`\`\`
${matrixRGBStr}
\`\`\`

**Предварительный вердикт инспектора:**
> ${d.verdict}

**Полный JSON с параметрами:**
\`\`\`json
${reportJson}
\`\`\`
`;

    // 1. Копируем форматированный отчет в системный буфер обмена
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(markdownReport).then(() => {
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('📋 Диагностический отчет артефакта скопирован в буфер!');
        } else {
          console.log('%c📋 Отчет успешно скопирован в буфер обмена!', 'color:#4ade80;font-weight:bold;');
        }
      }).catch(err => {
        console.warn('Не удалось записать в буфер:', err);
      });
    }

    // 2. Выводим красивый дамп в консоль браузера
    console.group(`%c[DEM Inspector Report] Тайл ${d.coords.z}/${d.coords.tx}/${d.coords.ty} (${d.coords.localX}, ${d.coords.localY})`, 'color:#38bdf8;font-weight:bold;');
    console.log('Вердикт:', d.verdict);
    console.log('Высоты 5x5 (метры):');
    console.table(d.matrix5x5_H);
    console.log('Каналы RGB 5x5:');
    console.table(d.matrix5x5_RGBA);
    console.log('Полный JSON:', d);
    console.groupEnd();
  }
};
window.renderCanopyHudUI = renderHudUI;

// =========================================================================
  // МОДУЛЬ ДЕКОРИРОВАНИЯ ПУСТЫХ ЗОН (WM.terrainDecor)
  // =========================================================================
 // =========================================================================
  // МОДУЛЬ ДЕКОРИРОВАНИЯ ПУСТЫХ ЗОН (WM.terrainDecor)
  // =========================================================================
  WM.terrainDecor = (function () {
    const LS_KEY = 'wm_terrain_decor';
    const PAD = 24;
    const MASK_SIZE = 128;
    const WETLAND_SET = new Set([
      'wetland', 'marsh', 'swamp', 'bog', 'string_bog',
      'wet_meadow', 'fen', 'reedbed', 'saltmarsh', 'tidalflat'
    ]);

    const DEFAULTS = {
      enabled: false,
      color: '#3c352c',
      blendMode: 'multiply',
      opacity: 0.60,
      lineWidth: 1.0,
      size: 1.0,
      sizeSpread: 0.45,
      frequency: 0.40
    };

    let dCfg = { ...DEFAULTS };
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (raw && typeof raw === 'object') dCfg = { ...DEFAULTS, ...raw };
    } catch (e) {}

    let mapRef = null;
    let decorLayer = null;
    let redrawTimer = null;

    // Очередь порционного рендеринга по кадрам (без фризов основного потока)
    let _decorQueue = [];
    let _decorRaf = 0;

    let _maskCv = null;
    let _maskCtx = null;

    function getMaskCanvas() {
      if (!_maskCv) {
        _maskCv = document.createElement('canvas');
        _maskCv.width = MASK_SIZE;
        _maskCv.height = MASK_SIZE;
        _maskCtx = _maskCv.getContext('2d', { willReadFrequently: true });
      }
      return { cv: _maskCv, ctx: _maskCtx };
    }

    function isReliefOn() {
      return !!(WM.demRelief && WM.demRelief.getConfig && WM.demRelief.getConfig().hillshadeEnabled);
    }

    function save() {
      if (window._wmResetting) return;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(dCfg));
      } catch (e) {}
    }

    function hash2(a, b, s) {
      let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function makeRng(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }


    function ptQuad(x0, y0, cx, cy, x1, y1, t) {
      const u = 1 - t;
      return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
    }

    // Адаптивный «кисточный» штрих (меньше вершин на коротких линиях)
    const _taperL = new Float32Array(16);
    const _taperR = new Float32Array(16);
    function taperStroke(ctx, x0, y0, cx, cy, x1, y1, w0, w1, steps) {
      const lenApprox = Math.hypot(x1 - x0, y1 - y0);
      const st = steps || (lenApprox < 8 ? 3 : (lenApprox < 16 ? 4 : 6));
      const n = Math.min(7, Math.max(2, st));

      for (let s = 0; s <= n; s++) {
        const t = s / n, u = 1 - t;
        const px = u * u * x0 + 2 * u * t * cx + t * t * x1;
        const py = u * u * y0 + 2 * u * t * cy + t * t * y1;
        let dx = 2 * u * (cx - x0) + 2 * t * (x1 - cx);
        let dy = 2 * u * (cy - y0) + 2 * t * (y1 - cy);
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const hw = (w0 + (w1 - w0) * Math.pow(t, 0.85)) * 0.5;
        const o = s * 2;
        _taperL[o] = px - dy * hw;
        _taperL[o + 1] = py + dx * hw;
        _taperR[o] = px + dy * hw;
        _taperR[o + 1] = py - dx * hw;
      }

      ctx.beginPath();
      ctx.moveTo(_taperL[0], _taperL[1]);
      for (let s = 1; s <= n; s++) ctx.lineTo(_taperL[s * 2], _taperL[s * 2 + 1]);
      for (let s = n; s >= 0; s--) ctx.lineTo(_taperR[s * 2], _taperR[s * 2 + 1]);
      ctx.closePath();
      ctx.fill();
    }

    function groundWash(ctx, x, y, rx, ry, a) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * a;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    }

    function grassTuft(ctx, x, y, r, w, rnd, n) {
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : (k / (n - 1)) * 2 - 1;
        const ang = t * 0.72 + (rnd() - 0.5) * 0.2;
        const h = r * (0.7 + rnd() * 0.55) * (1 - Math.abs(t) * 0.28);
        const ex = x + Math.sin(ang) * h + t * r * 0.14;
        const ey = y - Math.cos(ang) * h;
        const cx = x + Math.sin(ang) * h * 0.18 + (rnd() - 0.5) * r * 0.1;
        const cy = y - h * 0.62;
        taperStroke(ctx, x + t * r * 0.1, y, cx, cy, ex, ey, w * 1.5, w * 0.08);
      }
    }

    // Холмик без destination-out (не сбрасывает GPU-конвейер)
    function decorHill(ctx, x, y, rx, ry, w, rnd, hatchN) {
      const px = x - rx * 0.12, py = y - ry;
      const lcx = x - rx * 0.62, lcy = y - ry * 0.92;
      const rcx = x + rx * 0.5,  rcy = y - ry * 0.88;

      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * 0.16;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(rcx, rcy, x + rx, y);
      ctx.lineTo(x - rx * 0.05, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = prevAlpha;

      taperStroke(ctx, x - rx, y, lcx, lcy, px, py, w * 0.35, w * 1.1, 5);
      taperStroke(ctx, px, py, rcx, rcy, x + rx, y, w * 1.9, w * 0.3, 5);

      for (let k = 0; k < hatchN; k++) {
        const t = 0.2 + 0.68 * (hatchN === 1 ? 0.3 : k / (hatchN - 1));
        const p = ptQuad(px, py, rcx, rcy, x + rx, y, t);
        const ex = p[0] - rx * (0.14 + rnd() * 0.06);
        const ey = p[1] + (y - p[1]) * (0.62 + rnd() * 0.18);
        taperStroke(ctx, p[0], p[1], (p[0] + ex) * 0.5 + rx * 0.03, (p[1] + ey) * 0.5, ex, ey, w * 0.85, w * 0.1, 3);
      }
    }

    function decorRock(ctx, x, y, rx, ry, w, rnd, detail) {
      const n = 7 + ((rnd() * 3) | 0);
      const a0 = rnd() * 0.6;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        const k = 0.78 + rnd() * 0.4;
        const sy = Math.sin(a);
        pts.push([x + Math.cos(a) * rx * k, y + (sy > 0 ? sy * ry * 0.55 : sy * ry) * k]);
      }

      groundWash(ctx, x + rx * 0.25, y + ry * 0.55, rx * 1.0, ry * 0.3, 0.16);

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();

      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * 0.10;
      ctx.fill();
      ctx.globalAlpha = prevAlpha;

      ctx.lineWidth = w * 0.8;
      ctx.stroke();

      ctx.lineWidth = w * 1.8;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const mx = (a[0] + b[0]) * 0.5 - x, my = (a[1] + b[1]) * 0.5 - y;
        if ((mx / rx) * 0.55 + (my / ry) * 0.45 > 0.2) {
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
      }
      ctx.stroke();

      if (detail) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.clip();
        for (let k = 0; k < 4; k++) {
          const ox = x + rx * (0.05 + 0.26 * k);
          taperStroke(ctx, ox, y - ry * 0.3, ox - rx * 0.12, y + ry * 0.25, ox - rx * 0.36, y + ry * 0.85, w * 0.8, w * 0.12, 3);
        }
        ctx.restore();

        ctx.lineWidth = w * 0.7;
        ctx.beginPath();
        ctx.moveTo(x - rx * 0.15, y - ry * 0.72);
        ctx.quadraticCurveTo(x - rx * 0.02, y - ry * 0.3, x + rx * 0.18, y - ry * 0.02);
        ctx.lineTo(x + rx * 0.05, y + ry * 0.28);
        ctx.stroke();
      }
    }

    function decorShrub(ctx, x, y, r, w, rnd, detail) {
      const wd = r * (0.8 + rnd() * 0.25);
      const H = r * (0.62 + rnd() * 0.2);
      const m = 4 + ((rnd() * 2) | 0);
      const q = [];
      for (let k = 0; k <= m; k++) {
        q.push([x - wd + (2 * wd * k) / m, y - H * Math.pow(Math.sin((Math.PI * k) / m), 0.7)]);
      }
      const ctrl = (k) => [(q[k][0] + q[k + 1][0]) * 0.5, (q[k][1] + q[k + 1][1]) * 0.5 - H * 0.5];

      groundWash(ctx, x + wd * 0.15, y + H * 0.08, wd * 1.05, H * 0.22, 0.14);

      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * 0.10;
      ctx.beginPath();
      ctx.moveTo(q[0][0], q[0][1]);
      for (let k = 0; k < m; k++) { const c = ctrl(k); ctx.quadraticCurveTo(c[0], c[1], q[k + 1][0], q[k + 1][1]); }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = prevAlpha;

      for (let k = 0; k < m; k++) {
        const c = ctrl(k);
        ctx.lineWidth = k >= m / 2 ? w * 1.7 : w * 0.85;
        ctx.beginPath();
        ctx.moveTo(q[k][0], q[k][1]);
        ctx.quadraticCurveTo(c[0], c[1], q[k + 1][0], q[k + 1][1]);
        ctx.stroke();
      }

      if (detail) {
        for (let k = Math.ceil(m / 2); k < m; k++) {
          taperStroke(ctx, q[k][0], q[k][1] + H * 0.08, q[k][0] - wd * 0.02, q[k][1] + H * 0.3, q[k][0] - wd * 0.07, q[k][1] + H * 0.5, w * 0.8, w * 0.1, 3);
        }
        ctx.lineWidth = w * 0.7;
        ctx.beginPath();
        ctx.moveTo(x - wd * 0.28, y); ctx.lineTo(x - wd * 0.34, y + H * 0.18);
        ctx.moveTo(x + wd * 0.1, y);  ctx.lineTo(x + wd * 0.14, y + H * 0.2);
        ctx.stroke();
      }
    }

    function drawDecorObject(ctx, type, x, y, r, v, seed) {
      const rnd = makeRng(seed);
      const lw = ctx.lineWidth || 1;
      const w = lw * (0.85 + Math.min(r, 16) * 0.035);
      const detail = r >= 5.5;

      ctx.save();
      ctx.translate(x, y);
      if (type === 0 || type === 1) ctx.scale(rnd() < 0.5 ? -1 : 1, 1);

      if (type === 0) {
        if (detail) groundWash(ctx, r * 0.05, r * 0.05, r * 0.75, r * 0.16, 0.12);
        grassTuft(ctx, 0, 0, r, w, rnd, 4 + (v % 3));
        if (detail) {
          ctx.lineWidth = w * 0.6;
          ctx.beginPath();
          ctx.moveTo(-r * 0.75, r * 0.07); ctx.lineTo(-r * 0.38, r * 0.05);
          ctx.moveTo(r * 0.42, r * 0.06);  ctx.lineTo(r * 0.8, r * 0.09);
          ctx.stroke();
        }
      } else if (type === 1) {
        const n = 3 + (v & 1);
        for (let k = 0; k < n; k++) {
          const t = n === 1 ? 0 : (k / (n - 1)) * 2 - 1;
          const bx = t * r * 0.3;
          const h = r * (1.05 + rnd() * 0.45);
          const lean = 0.25 + t * 0.35 + (rnd() - 0.5) * 0.25;
          const ex = bx + Math.sin(lean) * h * 0.85 + h * 0.12;
          const ey = -Math.cos(lean) * h * 0.95;
          const cx = bx + Math.sin(lean) * h * 0.12;
          const cy = -h * 0.65;
          taperStroke(ctx, bx, 0, cx, cy, ex, ey, w * 1.15, w * 0.25);
          const ang = Math.atan2(ey - cy, ex - cx);
          ctx.beginPath();
          ctx.ellipse(ex + Math.cos(ang) * r * 0.1, ey + Math.sin(ang) * r * 0.1, r * 0.16, r * 0.05, ang, 0, Math.PI * 2);
          ctx.fill();
        }
        grassTuft(ctx, 0, 0, r * 0.5, w * 0.9, rnd, 2);
      } else if (type === 2) {
        const rx = r * (1.0 + rnd() * 0.3), ry = r * (0.52 + rnd() * 0.18);
        ctx.translate(0, ry * 0.35);
        if (detail) groundWash(ctx, rx * 0.1, ry * 0.06, rx * 1.1, ry * 0.2, 0.10);
        decorHill(ctx, 0, 0, rx, ry, w, rnd, detail ? 3 + (v & 1) : 0);
        if (detail && rnd() < 0.6) grassTuft(ctx, -rx * 1.08, 0, r * 0.35, w * 0.8, rnd, 2);
      } else if (type === 3) {
        const rx = r * (0.95 + rnd() * 0.2), ry = r * (0.5 + rnd() * 0.15);
        ctx.translate(0, ry * 0.2);
        if (detail) groundWash(ctx, 0, ry * 0.1, rx * 1.5, ry * 0.25, 0.10);
        if (rnd() < 0.55) decorHill(ctx, -rx * 1.15, -ry * 0.05, rx * 0.45, ry * 0.55, w * 0.85, rnd, 2);
        decorHill(ctx, rx * 1.05, -ry * 0.20, rx * 0.60, ry * 0.72, w * 0.9, rnd, detail ? 2 : 0);
        decorHill(ctx, -rx * 0.15, ry * 0.1, rx, ry, w, rnd, detail ? 4 : 0);
      } else if (type === 4) {
        const rx = r * 0.72, ry = r * 0.55;
        decorRock(ctx, 0, 0, rx, ry, w, rnd, detail);
        if (detail) {
          if (rnd() < 0.75) decorRock(ctx, rx * 1.2, ry * 0.3, rx * 0.42, ry * 0.4, w * 0.85, rnd, false);
          if (rnd() < 0.5)  decorRock(ctx, -rx * 1.05, ry * 0.4, rx * 0.3, ry * 0.3, w * 0.8, rnd, false);
        }
      } else {
        decorShrub(ctx, 0, r * 0.1, r, w, rnd, detail);
      }

      ctx.restore();
    }

    function appendFlatRings(ctx, geom, factor, ox, oy) {
      for (let l = 0; l < geom.length; l++) {
        const line = geom[l];
        if (line.length < 4) continue;
        ctx.moveTo(line[0] * factor - ox, line[1] * factor - oy);
        for (let i = 2; i < line.length; i += 2) {
          ctx.lineTo(line[i] * factor - ox, line[i + 1] * factor - oy);
        }
      }
    }

    function buildExclusionMask(coords, mvtRes) {
      const { cv, ctx } = getMaskCanvas();
      ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
      if (!mvtRes || !mvtRes.layers) return null;

      const layers = mvtRes.layers;
      const sf = 1 << mvtRes.shift;
      const sx = ((coords.x % sf) + sf) % sf;
      const sy = ((coords.y % sf) + sf) % sf;
      const ox = sx * MASK_SIZE;
      const oy = sy * MASK_SIZE;

      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#000';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (layers.water_polygons && layers.water_polygons.features.length) {
        const ext = layers.water_polygons.extent || 4096;
        const factor = (MASK_SIZE * sf) / ext;
        ctx.beginPath();
        for (const f of layers.water_polygons.features) {
          appendFlatRings(ctx, f.geom, factor, ox, oy);
        }
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.stroke();
      }

      if (layers.water_lines && layers.water_lines.features.length) {
        const ext = layers.water_lines.extent || 4096;
        const factor = (MASK_SIZE * sf) / ext;
        ctx.beginPath();
        for (const f of layers.water_lines.features) {
          appendFlatRings(ctx, f.geom, factor, ox, oy);
        }
        ctx.lineWidth = 5;
        ctx.stroke();
      }

      if (layers.land && layers.land.features.length) {
        const ext = layers.land.extent || 4096;
        const factor = (MASK_SIZE * sf) / ext;
        ctx.beginPath();
        let hasLandBlock = false;
        for (const f of layers.land.features) {
          const k = f.props.kind;
          if (k === 'forest' || k === 'wood' || WETLAND_SET.has(k)) {
            appendFlatRings(ctx, f.geom, factor, ox, oy);
            hasLandBlock = true;
          }
        }
        if (hasLandBlock) {
          ctx.fill('evenodd');
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }

      if (layers.buildings && layers.buildings.features.length) {
        const ext = layers.buildings.extent || 4096;
        const factor = (MASK_SIZE * sf) / ext;
        ctx.beginPath();
        for (const f of layers.buildings.features) {
          appendFlatRings(ctx, f.geom, factor, ox, oy);
        }
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (layers.streets && layers.streets.features.length) {
        const ext = layers.streets.extent || 4096;
        const factor = (MASK_SIZE * sf) / ext;
        ctx.beginPath();
        let hasRoad = false;
        for (const f of layers.streets.features) {
          if (f.props.tunnel) continue;
          const k = f.props.kind || '';
          if (k === 'path' || k === 'footway' || k === 'cycleway') continue;
          appendFlatRings(ctx, f.geom, factor, ox, oy);
          hasRoad = true;
        }
        if (hasRoad) {
          ctx.lineWidth = 4;
          ctx.stroke();
        }
      }

      return ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
    }

    // Быстрый поиск DEM-массива один раз на тайл (без mapRef.unproject в цикле)
    function createTileDemSampler(coords) {
      const z = coords.z;
      const srcKey = cfg.demSource || 'fabdem';
      const cappedZ = Math.max(5, Math.min(z, 17));
      const shift = z - cappedZ;
      const tx = coords.x >> shift;
      const ty = coords.y >> shift;
      const cv = getPaddedDemCache(`${srcKey}:${cappedZ}:${tx}:${ty}`);

      if (cv) {
        if (cv._isEmptyFallback) {
          return !cv._degraded ? { hasDem: true, isSea: () => true } : null;
        }
        const B = cv._pad || 0;
        const S = cv._tileSize || 256;
        const P = cv.width;
        let data = cv._demData;
        if (!data) {
          data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data;
          cv._demData = data;
        }
        const factor = 1 << shift;
        const subX = ((coords.x % factor) + factor) % factor;
        const subY = ((coords.y % factor) + factor) % factor;
        const scale = S / 256;

        return {
          hasDem: true,
          isSea(lx, ly) {
            const ux = (subX + lx / 256) / factor;
            const uy = (subY + ly / 256) / factor;
            const px = Math.max(0, Math.min(P - 1, (B + ux * 256 * scale) | 0));
            const py = Math.max(0, Math.min(P - 1, (B + uy * 256 * scale) | 0));
            const idx = (py * P + px) * 4;
            if (data[idx + 3] < 30) return false;
            const h = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
            return h > -1000.0 && h <= 0.25;
          }
        };
      }

      if (!mapRef || !WM.demRelief || !WM.demRelief.getElevation) return null;
      const nw = coords.scaleBy({ x: 256, y: 256 });
      const centerLL = mapRef.unproject(nw.add([128, 128]), z);
      let anyHit = (WM.demRelief.getElevation(centerLL.lat, centerLL.lng) !== null);
      return {
        get hasDem() { return anyHit; },
        isSea(lx, ly) {
          const ll = mapRef.unproject(nw.add([lx, ly]), z);
          const elev = WM.demRelief.getElevation(ll.lat, ll.lng);
          if (elev !== null) {
            anyHit = true;
            return elev <= 0.25;
          }
          return false;
        }
      };
    }

    function renderDecorTile(tile, coords, mvtRes, waterMask) {
      if (tile._removed || !mapRef) return;

      const ctx = tile.getContext('2d');
      ctx.clearRect(0, 0, tile.width, tile.height);

      const z = coords.z;
      const n = 1 << z;
      const tx = ((coords.x % n) + n) % n;
      const ty = coords.y;

      const osmAlphaData = buildExclusionMask(coords, mvtRes);
      const hasCanopy = !!(WM.canopy && typeof WM.canopy.getHeightAtNorm === 'function');
      const demSampler = createTileDemSampler(coords);

      const basePx = (6.2 + Math.max(0, z - 12) * 0.75) * dCfg.size;
      const targetSpacing = Math.max(22, basePx * 4.1);
      const N = clamp(Math.round(256 / targetSpacing), 4, 14);
      const cell = 256 / N;
      const inv256 = 1 / 256;
      const basePx = (6.2 + Math.max(0, z - 12) * 0.75) * dCfg.size;

      ctx.save();
      ctx.strokeStyle = dCfg.color || '#3c352c';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(0.4, dCfg.lineWidth || 1.0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const isPointBlocked = (px, py) => {
        if (px < 0 || px >= 256 || py < 0 || py >= 256) return false;
        if (osmAlphaData) {
          const mx = Math.min(MASK_SIZE - 1, Math.max(0, (px * 0.5) | 0));
          const my = Math.min(MASK_SIZE - 1, Math.max(0, (py * 0.5) | 0));
          if (osmAlphaData[(my * MASK_SIZE + mx) * 4 + 3] > 32) return true;
        }
        if (waterMask) {
          const wx = Math.min(255, Math.max(0, px | 0));
          const wy = Math.min(255, Math.max(0, py | 0));
          if (waterMask[(wy << 8) + wx] > 127) return true;
        }
        if (hasCanopy) {
          const xn = (tx + px * inv256) / n;
          const yn = (ty + py * inv256) / n;
          if (WM.canopy.getHeightAtNorm(xn, yn) >= 1.5) return true;
        }
        return false;
      };

      const checkBlocked = (lx, ly, radPx) => {
        if (
          isPointBlocked(lx, ly) ||
          isPointBlocked(lx - radPx, ly) ||
          isPointBlocked(lx + radPx, ly) ||
          isPointBlocked(lx, ly - radPx * 0.6) ||
          isPointBlocked(lx, ly + radPx * 0.4)
        ) {
          return true;
        }
        if (demSampler && demSampler.isSea(lx, ly)) return true;
        return false;
      };

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const cx = tx * N + i;
          const cy = ty * N + j;

          if (hash2(cx, cy, 311) > dCfg.frequency) continue;

          const jx = (hash2(cx, cy, 17) - 0.5) * cell * 0.78;
          const jy = (hash2(cx, cy, 29) - 0.5) * cell * 0.78;
          const lx = (i + 0.5) * cell + jx;
          const ly = (j + 0.5) * cell + jy;

          const spread = (hash2(cx, cy, 43) * 2.0 - 1.0) * (dCfg.sizeSpread * 0.68);
          const r = clamp(basePx * (1.0 + spread), 2.5, 22.0);

          if (checkBlocked(lx, ly, Math.max(3, r * 0.85))) continue;

          const type = Math.floor(hash2(cx, cy, 67) * 6);
          const v = Math.floor(hash2(cx, cy, 89) * 16);
          const objSeed = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;

          drawDecorObject(ctx, type, lx + PAD, ly + PAD, r, v, objSeed);
        }
      }

      ctx.restore();
      tile._hasDem = !!(demSampler && demSampler.hasDem);
    }

    function clearDecorQueue() {
      if (_decorRaf) {
        cancelAnimationFrame(_decorRaf);
        _decorRaf = 0;
      }
      _decorQueue.length = 0;
    }

    function flushDecorQueue() {
      _decorRaf = 0;
      if (!_decorQueue.length || !mapRef || !dCfg.enabled || !isReliefOn()) {
        _decorQueue.length = 0;
        return;
      }

      const layerZoom = (decorLayer && typeof decorLayer._tileZoom === 'number')
        ? decorLayer._tileZoom
        : Math.round(mapRef.getZoom());
      const center = mapRef.getCenter();

      // Сортируем: сначала тайлы ближе к центру экрана
      _decorQueue.sort((a, b) => {
        const dya = a.lat - center.lat, dxa = a.lng - center.lng;
        const dyb = b.lat - center.lat, dxb = b.lng - center.lng;
        return (dxa * dxa + dya * dya) - (dxb * dxb + dyb * dyb);
      });

      const budgetStart = performance.now();
      let renderedCount = 0;

      while (_decorQueue.length) {
        const entry = _decorQueue.shift();
        const tile = entry.tile;
        tile._inDecorQueue = false;

        if (tile._removed || entry.coords.z !== layerZoom) {
          if (entry.done) entry.done(null, tile);
          continue;
        }
        if (decorLayer && decorLayer._tiles) {
          const key = decorLayer._tileCoordsToKey(entry.coords);
          if (!decorLayer._tiles[key]) {
            if (entry.done) entry.done(null, tile);
            continue;
          }
        }

        renderDecorTile(tile, entry.coords, tile._mvtRes, tile._waterMask);
        if (entry.done) entry.done(null, tile);
        renderedCount++;

        // Бюджет 6 мс на кадр (минимум 1 тайл за кадр)
        if (renderedCount >= 1 && (performance.now() - budgetStart) > 6.0) {
          break;
        }
      }

      if (_decorQueue.length) {
        _decorRaf = requestAnimationFrame(flushDecorQueue);
      }
    }

    function enqueueDecorTile(tile, coords, done) {
      if (!tile || tile._removed || tile._inDecorQueue) {
        if (done) done(null, tile);
        return;
      }
      tile._inDecorQueue = true;
      const nw = coords.scaleBy({ x: 256, y: 256 });
      const cLL = mapRef ? mapRef.unproject(nw.add([128, 128]), coords.z) : { lat: 0, lng: 0 };
      _decorQueue.push({ tile, coords, done: done || null, lat: cLL.lat, lng: cLL.lng });
      if (!_decorRaf) {
        _decorRaf = requestAnimationFrame(flushDecorQueue);
      }
    }

    const DecorGridLayer = L.GridLayer.extend({
      _initTile(tile) {
        L.GridLayer.prototype._initTile.call(this, tile);
        const tileW = this.getTileSize().x || 256;
        const scale = tileW / 256;
        const size = (256 + PAD * 2) * scale;
        const padPx = PAD * scale;
        tile.style.width = size + 'px';
        tile.style.height = size + 'px';
        tile.style.minWidth = size + 'px';
        tile.style.minHeight = size + 'px';
        tile.style.maxWidth = size + 'px';
        tile.style.maxHeight = size + 'px';
        tile.style.marginLeft = -padPx + 'px';
        tile.style.marginTop = -padPx + 'px';
        tile.style.pointerEvents = 'none';
      },
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        const size = 256 + PAD * 2;
        tile.width = size;
        tile.height = size;
        tile._coords = coords;

        if (coords.z < 11 || !dCfg.enabled || !isReliefOn()) {
          setTimeout(() => done(null, tile), 0);
          return tile;
        }

        const mvtP = (WM.vectorRoads && WM.vectorRoads.fetchMvtTile)
          ? WM.vectorRoads.fetchMvtTile(coords).catch(() => null)
          : Promise.resolve(null);

        const waterP = fetchWaterMaskTile(coords).catch(() => null);

        const canopyReadyP = new Promise(resolve => {
          if (!WM.canopy || typeof WM.canopy.ensureTileData !== 'function') {
            resolve();
            return;
          }
          let doneWait = false;
          const finishWait = () => {
            if (!doneWait) { doneWait = true; resolve(); }
          };
          const tm = setTimeout(finishWait, 2200);
          const readyNow = WM.canopy.ensureTileData(coords.z, coords.x, coords.y, () => {
            clearTimeout(tm);
            finishWait();
          });
          if (readyNow) {
            clearTimeout(tm);
            finishWait();
          }
        });

        Promise.all([mvtP, waterP, canopyReadyP]).then(([mvtRes, waterMask]) => {
          if (tile._removed) {
            done(null, tile);
            return;
          }
          tile._mvtRes = mvtRes;
          tile._waterMask = waterMask;
          enqueueDecorTile(tile, coords, done);
        }).catch(() => {
          done(null, tile);
        });

        return tile;
      },

      _removeTile(key) {
        const tile = this._tiles[key]?.el;
        if (tile) {
          tile._removed = true;
          tile._mvtRes = null;
          tile._waterMask = null;
          tile._hasDem = false;
          tile.width = 0;
          tile.height = 0;
        }
        L.GridLayer.prototype._removeTile.call(this, key);
      }
    });

    function applyStyles() {
      if (!mapRef) return;
      if (!mapRef.getPane('wm-decor-pane')) {
        mapRef.createPane('wm-decor-pane');
        mapRef.getPane('wm-decor-pane').style.zIndex = 328;
      }
      const pane = mapRef.getPane('wm-decor-pane');
      if (pane) pane.style.mixBlendMode = dCfg.blendMode || 'multiply';

      const shouldShow = !!(dCfg.enabled && isReliefOn());

      if (shouldShow) {
        if (!decorLayer) {
          decorLayer = new DecorGridLayer({
            pane: 'wm-decor-pane',
            minZoom: 11,
            maxNativeZoom: 16,
            maxZoom: 20,
            opacity: dCfg.opacity,
            keepBuffer: 1,
            updateWhenIdle: true,
            updateWhenZooming: false
          });
        }
        if (!mapRef.hasLayer(decorLayer)) mapRef.addLayer(decorLayer);
        decorLayer.setOpacity(dCfg.opacity);
      } else {
        clearDecorQueue();
        if (decorLayer && mapRef.hasLayer(decorLayer)) {
          mapRef.removeLayer(decorLayer);
        }
      }
    }

    function rerenderVisibleTiles() {
      if (!decorLayer || !decorLayer._tiles || !dCfg.enabled || !isReliefOn()) return;
      for (const key in decorLayer._tiles) {
        const entry = decorLayer._tiles[key];
        const el = entry?.el;
        if (!el || el._removed || !entry.coords || entry.coords.z < 11) continue;
        if (el._mvtRes === undefined) continue; // дождётся Promise.all в createTile
        enqueueDecorTile(el, entry.coords);
      }
    }

    function scheduleRerender() {
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(rerenderVisibleTiles, 50);
    }

    function syncUI() {
      const $ = id => document.getElementById(id);
      const reliefOn = isReliefOn();
      const active = !!(dCfg.enabled && reliefOn);

      const chk = $('dem-hud-toggle-decor');
      if (chk) chk.checked = !!dCfg.enabled;

      const sub = $('dem-hud-decor-sub');
      if (sub) sub.classList.toggle('is-disabled', !active);

      const badge = $('dem-hud-decor-status-badge');
      if (badge) {
        badge.textContent = (!reliefOn && dCfg.enabled) ? 'Пауза (без рельефа)' : (active ? 'Вкл' : 'Выкл');
        badge.classList.toggle('active', active);
      }

      if ($('dem-hud-decor-color')) $('dem-hud-decor-color').value = dCfg.color || '#3c352c';
      if ($('dem-hud-decor-blend')) $('dem-hud-decor-blend').value = dCfg.blendMode || 'multiply';

      if ($('dem-hud-decor-opacity')) {
        const p = Math.round((dCfg.opacity ?? 0.6) * 100);
        $('dem-hud-decor-opacity').value = p;
        if ($('dem-hud-decor-opacity-val')) $('dem-hud-decor-opacity-val').textContent = p + '%';
      }
      if ($('dem-hud-decor-width')) {
        $('dem-hud-decor-width').value = dCfg.lineWidth ?? 1.0;
        if ($('dem-hud-decor-width-val')) $('dem-hud-decor-width-val').textContent = Number(dCfg.lineWidth ?? 1.0).toFixed(1) + ' px';
      }
      if ($('dem-hud-decor-size')) {
        $('dem-hud-decor-size').value = dCfg.size ?? 1.0;
        if ($('dem-hud-decor-size-val')) $('dem-hud-decor-size-val').textContent = '×' + Number(dCfg.size ?? 1.0).toFixed(2);
      }
      if ($('dem-hud-decor-spread')) {
        const sp = Math.round((dCfg.sizeSpread ?? 0.45) * 100);
        $('dem-hud-decor-spread').value = sp;
        if ($('dem-hud-decor-spread-val')) $('dem-hud-decor-spread-val').textContent = sp + '%';
      }
      if ($('dem-hud-decor-freq')) {
        const fq = Math.round((dCfg.frequency ?? 0.40) * 100);
        $('dem-hud-decor-freq').value = fq;
        if ($('dem-hud-decor-freq-val')) $('dem-hud-decor-freq-val').textContent = fq + '%';
      }
    }

    function initUI() {
      const $ = id => document.getElementById(id);
      const chk = $('dem-hud-toggle-decor');
      if (!chk || chk._decorBound) return;
      chk._decorBound = true;

      chk.addEventListener('change', e => {
        dCfg.enabled = e.target.checked;
        save();
        applyStyles();
        syncUI();
      });

      $('dem-hud-decor-color')?.addEventListener('input', e => {
        dCfg.color = e.target.value;
        save();
        scheduleRerender();
      });

      $('dem-hud-decor-blend')?.addEventListener('change', e => {
        dCfg.blendMode = e.target.value;
        save();
        applyStyles();
      });

      $('dem-hud-decor-opacity')?.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        dCfg.opacity = v / 100;
        if ($('dem-hud-decor-opacity-val')) $('dem-hud-decor-opacity-val').textContent = v + '%';
        save();
        if (decorLayer) decorLayer.setOpacity(dCfg.opacity);
      });

      $('dem-hud-decor-width')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        dCfg.lineWidth = v;
        if ($('dem-hud-decor-width-val')) $('dem-hud-decor-width-val').textContent = v.toFixed(1) + ' px';
        save();
        scheduleRerender();
      });

      $('dem-hud-decor-size')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        dCfg.size = v;
        if ($('dem-hud-decor-size-val')) $('dem-hud-decor-size-val').textContent = '×' + v.toFixed(2);
        save();
        scheduleRerender();
      });

      $('dem-hud-decor-spread')?.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        dCfg.sizeSpread = v / 100;
        if ($('dem-hud-decor-spread-val')) $('dem-hud-decor-spread-val').textContent = v + '%';
        save();
        scheduleRerender();
      });

      $('dem-hud-decor-freq')?.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        dCfg.frequency = v / 100;
        if ($('dem-hud-decor-freq-val')) $('dem-hud-decor-freq-val').textContent = v + '%';
        save();
        scheduleRerender();
      });

      syncUI();
    }

    return {
      init(map) {
        mapRef = map;
        let lastReliefOn = isReliefOn();
        applyStyles();

        window.addEventListener('wm:dem-change', (e) => {
          const reliefNow = isReliefOn();
          if (reliefNow !== lastReliefOn) {
            lastReliefOn = reliefNow;
            applyStyles();
            syncUI();
          }

          if (!dCfg.enabled || !reliefNow || isPeakViewForeground()) return;

          if (e && e.detail && e.detail.sourceChanged) {
            scheduleRerender();
            return;
          }

          // Перерисовываем только те видимые тайлы, где ранее не было DEM-данных
          if (decorLayer && decorLayer._tiles) {
            for (const key in decorLayer._tiles) {
              const entry = decorLayer._tiles[key];
              const el = entry?.el;
              if (!el || el._removed || !entry.coords || entry.coords.z < 11 || el._hasDem) continue;
              if (el._mvtRes === undefined) continue;
              const nw = entry.coords.scaleBy({ x: 256, y: 256 });
              const cLL = mapRef.unproject(nw.add([128, 128]), entry.coords.z);
              if (WM.demRelief && WM.demRelief.getElevation && WM.demRelief.getElevation(cLL.lat, cLL.lng) !== null) {
                enqueueDecorTile(el, entry.coords);
              }
            }
          }
        });
      },
      initUI,
      syncUI,
      redraw() {
        if (decorLayer && dCfg.enabled && isReliefOn()) decorLayer.redraw();
      },
      applyProfile(profileDecor) {
        dCfg = {
          ...DEFAULTS,
          ...(profileDecor && typeof profileDecor === 'object' ? profileDecor : {})
        };
        save();
        applyStyles();
        scheduleRerender();
        syncUI();
      },
      getConfig: () => ({ ...dCfg }),
      setConfig(patch) {
        Object.assign(dCfg, patch || {});
        save();
        applyStyles();
        scheduleRerender();
        syncUI();
      }
    };
  })();

})();
