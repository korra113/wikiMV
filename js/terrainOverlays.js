/**
 * js/terrainOverlays.js
 * Модуль тематических слоёв анализа местности (WM.terrainOverlays):
 *  1. steep       — Крутые склоны и обрывы
 *  2. camp        — Пологие ровные места под палатку
 *  3. windShelter — Склоны и лесополосы, защищённые от ветра (рельеф + погода + леса)
 *  4. solar       — Накопление солнечного света за день на поверхности земли (SunCalc + DEM + леса)
 *  5. flood       — Связный гидрологический разлив рек и озёр (HAND + барьеры рельефа)
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const SETTINGS_KEY = 'wm_terrain_overlays_v1';
  const WX_LS_KEY = 'wm_to_wx_cache_v1';
  const TILE = 256;
  const GRID = 128; // 2x2 px логическая сетка для тяжёлых слоёв (solar/wind/flood/camp)
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / ((e1 - e0) || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // =========================================================================
  // 1. КОНФИГУРАЦИЯ ПО УМОЛЧАНИЮ И СОХРАНЕНИЕ
  // =========================================================================
  const DEFAULT_CFG = {
    steep: {
      enabled: false,
      minAngle: 25,
      color: '#f97316',
      cliffColor: '#dc2626',
      opacity: 0.65,
      blendMode: 'normal'
    },
    camp: {
      enabled: false,
      maxSlope: 5.0,
      flatness: 'normal', // 'strict' | 'normal' | 'relaxed'
      avoidForest: true,
      avoidWaterBuffer: true,
      color: '#10b981',
      opacity: 0.65
    },
    windShelter: {
      enabled: false,
      windSource: 'auto', // 'auto' | 'manual'
      windDir: 240,       // откуда дует ветер, град
      windSpeed: 5.0,
      minShelter: 40,     // % минимальной защиты
      useForest: true,
      color: '#06b6d4',
      opacity: 0.60
    },
    solar: {
      enabled: false,
      dateMode: 'today',  // 'today' | 'summer' | 'equinox' | 'winter' | 'custom'
      dateStr: '',
      minLight: 55,       // % минимального накопленного света
      useForestShade: true,
      color: '#f59e0b',
      opacity: 0.65
    },
    flood: {
      enabled: false,
      sourceMode: 'all', // 'osm_rivers' | 'osm_all' | 'esa_clean' | 'all'
      floodLevelM: 2.5,
      showExistingWater: false,
      shallowColor: '#38bdf8',
      color: '#1d4ed8',
      opacity: 0.65
    }
  };

  let cfg = structuredCloneSafe(DEFAULT_CFG);
  function structuredCloneSafe(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        Object.keys(DEFAULT_CFG).forEach(k => {
          if (saved[k] && typeof saved[k] === 'object') {
            Object.assign(cfg[k], saved[k]);
          }
        });
      }
    } catch (e) {}
    if (!cfg.solar.dateStr) cfg.solar.dateStr = getTodayStr();
  }

  let _saveTm = 0;
  function saveConfig() {
    if (window._wmResetting) return;
    clearTimeout(_saveTm);
    _saveTm = setTimeout(() => {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch (e) {}
    }, 150);
  }

  function getTodayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    const v = m ? parseInt(m[1], 16) : 0x3b82f6;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // =========================================================================
  // 2. ОБЩАЯ ПОГОДА (ОНЛАЙН OPEN-METEO + ОФЛАЙН-КЭШ)
  // =========================================================================
  const wxMemCache = WM._sharedWxCache = WM._sharedWxCache || new Map();
  const WX_TTL_ONLINE = 30 * 60e3;
  const WX_TTL_OFFLINE = 7 * 24 * 3600e3;
  const wxInFlight = new Map();

  function loadWxCacheFromLS() {
    const now = Date.now();
    [WX_LS_KEY, 'wm_audibility_wx_cache_v1', 'wm_viewshed_wx_cache_v1'].forEach(storeKey => {
      try {
        const obj = JSON.parse(localStorage.getItem(storeKey) || '{}');
        Object.keys(obj).forEach(k => {
          if (obj[k] && obj[k].json && (now - obj[k].t < WX_TTL_OFFLINE)) {
            const prev = wxMemCache.get(k);
            if (!prev || obj[k].t > prev.t) wxMemCache.set(k, obj[k]);
          }
        });
      } catch (e) {}
    });
  }

  function saveWxToLS() {
    try {
      const entries = Array.from(wxMemCache.entries()).sort((a, b) => b[1].t - a[1].t).slice(0, 6);
      const out = {};
      entries.forEach(([k, v]) => { out[k] = v; });
      localStorage.setItem(WX_LS_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  function findOfflineWx(lat, lng) {
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    const exact = wxMemCache.get(key);
    if (exact && (Date.now() - exact.t < WX_TTL_OFFLINE)) return exact.json;

    let best = null, bestD = 0.12;
    const now = Date.now();
    wxMemCache.forEach((entry, k) => {
      if (!entry || !entry.json || now - entry.t >= WX_TTL_OFFLINE) return;
      const parts = k.split(',');
      const cLat = parseFloat(parts[0]), cLng = parseFloat(parts[1]);
      if (!isFinite(cLat) || !isFinite(cLng)) return;
      const d = (cLat - lat) ** 2 + (cLng - lng) ** 2;
      if (d < bestD) { bestD = d; best = entry.json; }
    });
    return best;
  }

  async function fetchWeather(lat, lng) {
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    const hit = wxMemCache.get(key);
    if (hit && (Date.now() - hit.t < WX_TTL_ONLINE)) {
      return { json: hit.json, source: navigator.onLine === false ? 'offline-cache' : 'cache' };
    }
    if (navigator.onLine === false) {
      const off = findOfflineWx(lat, lng);
      return off ? { json: off, source: 'offline-cache' } : null;
    }
    if (wxInFlight.has(key)) return wxInFlight.get(key);

    const p = (async () => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&past_days=1&forecast_days=3`;
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 3000);
      try {
        const resp = await fetch(url, { signal: ctl.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        if (!json || !json.hourly || !json.hourly.time) throw new Error('Bad JSON');
        wxMemCache.set(key, { t: Date.now(), json });
        saveWxToLS();
        return { json, source: 'online' };
      } catch (e) {
        const off = findOfflineWx(lat, lng);
        return off ? { json: off, source: 'offline-cache' } : null;
      } finally {
        clearTimeout(tm);
        wxInFlight.delete(key);
      }
    })();

    wxInFlight.set(key, p);
    return p;
  }

  function extractWindAtNow(json) {
    if (!json || !json.hourly || !json.hourly.time || json.hourly.time.length < 2) return null;
    const tt = json.hourly.time;
    const t = Date.now() / 1000;
    const i = clamp(Math.floor((t - tt[0]) / 3600), 0, tt.length - 2);
    const f = clamp((t - tt[i]) / (tt[i + 1] - tt[i]), 0, 1);
    const wsArr = json.hourly.wind_speed_10m;
    const wdArr = json.hourly.wind_direction_10m;
    const spd = (wsArr && wsArr[i] != null) ? lerp(wsArr[i], wsArr[i + 1] ?? wsArr[i], f) : 3.5;
    let dir = 240;
    if (wdArr && wdArr[i] != null) {
      const d0 = wdArr[i];
      const d1 = wdArr[i + 1] != null ? wdArr[i + 1] : d0;
      const diff = ((d1 - d0 + 540) % 360) - 180;
      dir = ((d0 + diff * f) % 360 + 360) % 360;
    }
    return { speed: Math.max(0.2, spd), dir: Math.round(dir) };
  }

  let activeAutoWind = { speed: 4.0, dir: 240, source: 'fallback', lat: 0, lng: 0, ts: 0 };

  async function resolveWindForCenter(lat, lng) {
    if (cfg.windShelter.windSource === 'manual') {
      return {
        speed: cfg.windShelter.windSpeed,
        dir: cfg.windShelter.windDir,
        source: 'manual'
      };
    }
    const res = await fetchWeather(lat, lng);
    if (res && res.json) {
      const w = extractWindAtNow(res.json);
      if (w) {
        activeAutoWind = { speed: w.speed, dir: w.dir, source: res.source, lat, lng, ts: Date.now() };
        updateWindInfoText();
        return activeAutoWind;
      }
    }
    activeAutoWind = { speed: 4.0, dir: 240, source: navigator.onLine === false ? 'offline-default' : 'fallback', lat, lng, ts: Date.now() };
    updateWindInfoText();
    return activeAutoWind;
  }

  // =========================================================================
  // 3. ЕДИНЫЕ ПРОВАЙДЕРЫ ДАННЫХ ТАЙЛА (DEM + WATER + CANOPY, ОФЛАЙН-УСТОЙЧИВО)
  // =========================================================================
  // Кэш 3x3 масок воды (192x192 для области [-64..319] px)
  const paddedWaterCache = new Map();
  const paddedWaterInFlight = new Map();

  function raceWithAbort(promise, signal) {
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

  async function loadPaddedWaterMask(coords, signal = null) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = `${coords.z}:${coords.x}:${coords.y}`;
    if (paddedWaterCache.has(key)) return paddedWaterCache.get(key);

    let p = paddedWaterInFlight.get(key);
    if (!p) {
      p = (async () => {
        if (!WM.demRelief || typeof WM.demRelief.fetchWaterMaskTile !== 'function') return null;

        const maxC = 1 << coords.z;
        const jobs = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = coords.y + dy;
            if (ny < 0 || ny >= maxC) {
              jobs.push(Promise.resolve({ dx, dy, mask: null, oob: true }));
              continue;
            }
            const nx = ((coords.x + dx) % maxC + maxC) % maxC;
            jobs.push(
              WM.demRelief.fetchWaterMaskTile({ z: coords.z, x: nx, y: ny })
                .then(mask => ({ dx, dy, mask, oob: false }))
                .catch(() => ({ dx, dy, mask: null, oob: false }))
            );
          }
        }

        const tiles = await Promise.all(jobs);
        const centerRes = tiles.find(t => t.dx === 0 && t.dy === 0);
        if (!centerRes || !centerRes.mask) return null;

        let incomplete = !!centerRes.mask._isFallback;
        const byKey = new Map();
        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i];
          if (!t.oob && (!t.mask || t.mask._isFallback)) {
            incomplete = true;
          }
          byKey.set(`${t.dx},${t.dy}`, t.mask);
        }

        const W = 192;
        const PAD_C = 32;
        const out = new Uint8Array(W * W);
        let hasAnyWater = 0;

        for (let gy = 0; gy < W; gy++) {
          const ly = gy * 2 - 64;
          const tyOff = ly < 0 ? -1 : (ly >= 256 ? 1 : 0);
          const py = ((ly % 256) + 256) % 256;
          const py1 = py < 255 ? py + 1 : 255;
          const rowOff = gy * W;

          for (let gx = 0; gx < W; gx++) {
            const lx = gx * 2 - 64;
            const txOff = lx < 0 ? -1 : (lx >= 256 ? 1 : 0);
            const m = byKey.get(`${txOff},${tyOff}`);
            if (!m) continue;
            const px = ((lx % 256) + 256) % 256;
            const px1 = px < 255 ? px + 1 : 255;
            if (
              m[py * 256 + px] > 127 ||
              m[py * 256 + px1] > 127 ||
              m[py1 * 256 + px] > 127 ||
              m[py1 * 256 + px1] > 127
            ) {
              out[rowOff + gx] = 1;
              hasAnyWater = 1;
            }
          }
        }

        const res = { grid: out, size: W, pad: PAD_C, hasWater: !!hasAnyWater, incomplete };
        if (!incomplete) {
          if (paddedWaterCache.size > 48) paddedWaterCache.delete(paddedWaterCache.keys().next().value);
          paddedWaterCache.set(key, res);
        }
        return res;
      })();

      paddedWaterInFlight.set(key, p);
      p.finally(() => paddedWaterInFlight.delete(key));
    }

    return raceWithAbort(p, signal);
  }


  const paddedOsmWaterCache = new Map();
  const paddedOsmWaterInFlight = new Map();

  async function loadPaddedOsmWaterMask(coords, mode = 'osm_rivers', signal = null) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = `${mode}:${coords.z}:${coords.x}:${coords.y}`;
    if (paddedOsmWaterCache.has(key)) return paddedOsmWaterCache.get(key);

    let p = paddedOsmWaterInFlight.get(key);
    if (!p) {
      p = (async () => {
        if (!WM.vectorRoads || typeof WM.vectorRoads.fetchMvtTile !== 'function') return null;

        const maxC = 1 << coords.z;
        const jobs = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = coords.y + dy;
            if (ny < 0 || ny >= maxC) {
              jobs.push(Promise.resolve({ dx, dy, nx: 0, ny: 0, data: null, oob: true }));
              continue;
            }
            const nx = ((coords.x + dx) % maxC + maxC) % maxC;
            jobs.push(
              WM.vectorRoads.fetchMvtTile({ z: coords.z, x: nx, y: ny })
                .then(data => ({ dx, dy, nx, ny, data, oob: false }))
                .catch(() => ({ dx, dy, nx, ny, data: null, oob: false }))
            );
          }
        }

        const tiles = await Promise.all(jobs);
        const centerRes = tiles.find(t => t.dx === 0 && t.dy === 0);
        if (!centerRes || !centerRes.data || !centerRes.data.layers) return null;

        let incomplete = false;
        const W = 192;
        const PAD_C = 32;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = W;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.3;

        const includeStreams = (mode === 'osm_all');

        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i];
          if (!t.oob && (!t.data || !t.data.layers)) {
            incomplete = true;
            continue;
          }
          if (t.oob || !t.data) continue;

          const { layers, shift = 0 } = t.data;
          const sf = 1 << shift;
          const sx = shift > 0 ? (((t.nx % sf) + sf) % sf) : 0;
          const sy = shift > 0 ? (((t.ny % sf) + sf) % sf) : 0;
          const offsetX = shift > 0 ? sx * 256 : 0;
          const offsetY = shift > 0 ? sy * 256 : 0;

          // 1. Полигоны озёр, водохранилищ и широких рек (исключаем ледники, доки, моря/океаны)
          const wp = layers.water_polygons;
          if (wp && wp.features && wp.features.length) {
            const ext = wp.extent || 4096;
            const sc = ((256 * sf) / ext) * 0.5;
            const txOff = (t.dx * 256 - offsetX + 64) * 0.5;
            const tyOff = (t.dy * 256 - offsetY + 64) * 0.5;

            for (let fi = 0; fi < wp.features.length; fi++) {
              const f = wp.features[fi];
              const k = f.props.kind || '';
              if (k === 'glacier' || k === 'ocean' || k === 'sea' || k === 'dock' || f.props.maritime) continue;
              if (f.bbox && (
                txOff + f.bbox[2] * sc < -4 || txOff + f.bbox[0] * sc > W + 4 ||
                tyOff + f.bbox[3] * sc < -4 || tyOff + f.bbox[1] * sc > W + 4
              )) continue;

              ctx.beginPath();
              for (let l = 0; l < f.geom.length; l++) {
                const ring = f.geom[l];
                if (ring.length < 6) continue;
                ctx.moveTo(txOff + ring[0] * sc, tyOff + ring[1] * sc);
                for (let p = 2; p < ring.length; p += 2) {
                  ctx.lineTo(txOff + ring[p] * sc, tyOff + ring[p + 1] * sc);
                }
                ctx.closePath();
              }
              ctx.fill('evenodd'); // Вырезает острова внутри озёр и рек
            }
          }

          // 2. Линейные реки, каналы и (опционально) ручьи
          const wl = layers.water_lines;
          if (wl && wl.features && wl.features.length) {
            const ext = wl.extent || 4096;
            const sc = ((256 * sf) / ext) * 0.5;
            const txOff = (t.dx * 256 - offsetX + 64) * 0.5;
            const tyOff = (t.dy * 256 - offsetY + 64) * 0.5;

            ctx.beginPath();
            for (let fi = 0; fi < wl.features.length; fi++) {
              const f = wl.features[fi];
              if (f.props.tunnel) continue; // Игнорируем подземные коллекторы
              const k = f.props.kind || 'stream';
              const allow = (k === 'river' || k === 'canal') || (includeStreams && k === 'stream');
              if (!allow) continue;
              if (f.bbox && (
                txOff + f.bbox[2] * sc < -4 || txOff + f.bbox[0] * sc > W + 4 ||
                tyOff + f.bbox[3] * sc < -4 || tyOff + f.bbox[1] * sc > W + 4
              )) continue;

              for (let l = 0; l < f.geom.length; l++) {
                const line = f.geom[l];
                if (line.length < 4) continue;
                ctx.moveTo(txOff + line[0] * sc, tyOff + line[1] * sc);
                for (let p = 2; p < line.length; p += 2) {
                  ctx.lineTo(txOff + line[p] * sc, tyOff + line[p + 1] * sc);
                }
              }
            }
            ctx.stroke();
          }
        }

        const data = ctx.getImageData(0, 0, W, W).data;
        const out = new Uint8Array(W * W);
        let hasAnyWater = 0;
        for (let i = 0; i < out.length; i++) {
          if (data[i * 4 + 3] >= 64) {
            out[i] = 1;
            hasAnyWater = 1;
          }
        }

        const res = { grid: out, size: W, pad: PAD_C, hasWater: !!hasAnyWater, incomplete };
        if (!incomplete) {
          if (paddedOsmWaterCache.size > 48) paddedOsmWaterCache.delete(paddedOsmWaterCache.keys().next().value);
          paddedOsmWaterCache.set(key, res);
        }
        return res;
      })();

      paddedOsmWaterInFlight.set(key, p);
      p.finally(() => paddedOsmWaterInFlight.delete(key));
    }

    return raceWithAbort(p, signal);
  }

  // =========================================================================
  // ЗАГРУЗКА ДАННЫХ КРОН С ТАЙМАУТАМИ И АВТОПЕРЕКЛЮЧЕНИЕМ v1 <-> v2
  // =========================================================================
  const canopyAreaInFlight = new Map();
  const CANOPY_STALL_TIMEOUT_MS = 7000;   // 7 с без прогресса — считаем источник зависшим
  const CANOPY_HARD_TIMEOUT_MS = 14000;   // 14 с максимум на одну попытку
  const CANOPY_SWITCH_COOLDOWN_MS = 10000;

  let _canopySwitchLock = null;
  let _lastCanopySwitchAt = 0;
  let _canopySwitchToastAt = 0;
  let _internalCanopySwitch = false;

  function getCanopyVer() {
    return (WM.canopy && typeof WM.canopy.getVersion === 'function')
      ? WM.canopy.getVersion()
      : 'v1';
  }

  function hasActiveCanopyOverlay() {
    return (
      (cfg.camp.enabled && cfg.camp.avoidForest) ||
      (cfg.windShelter.enabled && cfg.windShelter.useForest) ||
      (cfg.solar.enabled && cfg.solar.useForestShade)
    );
  }

  function isCanopyResReady(res) {
    return !!res && !res._timedOut && !res._aborted && (res.total === 0 || res.failed === 0);
  }

  async function attemptCanopyArea(latC, lngC, radiusM, z, extSignal = null) {
    if (!WM.canopy || typeof WM.canopy.loadCanopyArea !== 'function') return null;
    if (extSignal && extSignal.aborted) return { _aborted: true };

    const ctl = new AbortController();
    const attemptStart = performance.now();
    let lastProgressAt = attemptStart;
    let lastDone = -1;
    let settled = false;

    const isOffline = (navigator.onLine === false);
    const stallMs = isOffline ? 1500 : CANOPY_STALL_TIMEOUT_MS;
    const hardMs = isOffline ? 2500 : CANOPY_HARD_TIMEOUT_MS;

    const onExtAbort = () => ctl.abort();
    if (extSignal) extSignal.addEventListener('abort', onExtAbort, { once: true });

    const rawP = WM.canopy.loadCanopyArea(latC, lngC, radiusM, z, {
      multiScale: false,
      signal: ctl.signal,
      onProgress: (done, total) => {
        if (settled) return;
        if (done > lastDone || (lastDone < 0 && total > 0)) {
          lastDone = done;
          lastProgressAt = performance.now();
        }
      }
    }).then(async (res) => {
      if (settled || ctl.signal.aborted) return { _aborted: true };
      if (isOffline && res && res.downloaded === 0 && res.cached === 0 && map) {
        const curZ = clamp(Math.round(map.getZoom()), 11, 15);
        if (curZ !== z) {
          const altRes = await WM.canopy.loadCanopyArea(
            latC, lngC, Math.min(radiusM, 2500), curZ,
            { multiScale: false, signal: ctl.signal }
          ).catch(() => null);
          if (altRes && (altRes.downloaded > 0 || altRes.cached > 0)) res = altRes;
        }
      }
      return res;
    }).catch(() => null);

    let watchTimer = null;
    const watchdogP = new Promise((resolve) => {
      watchTimer = setInterval(() => {
        if (extSignal && extSignal.aborted) {
          clearInterval(watchTimer);
          ctl.abort();
          resolve({ _aborted: true });
          return;
        }
        const now = performance.now();
        if (now - attemptStart >= hardMs || now - lastProgressAt >= stallMs) {
          clearInterval(watchTimer);
          ctl.abort();
          resolve({ _timedOut: true, _stalled: (now - lastProgressAt >= stallMs) });
        }
      }, 200);
    });

    try {
      const res = await Promise.race([rawP, watchdogP]);
      settled = true;
      return res;
    } finally {
      settled = true;
      clearInterval(watchTimer);
      if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
    }
  }

  async function trySwitchAndRetryCanopy(failedVer, reason, latC, lngC, radiusM, z, signal) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!WM.canopy || typeof WM.canopy.setVersion !== 'function') return false;

    const now = Date.now();
    // Если другой тайл уже только что переключил версию — просто пробуем текущую
    if (getCanopyVer() !== failedVer || (now - _lastCanopySwitchAt < CANOPY_SWITCH_COOLDOWN_MS)) {
      const retryRes = await attemptCanopyArea(latC, lngC, radiusM, z, signal);
      if (retryRes && retryRes._aborted) throw new DOMException('Aborted', 'AbortError');
      return isCanopyResReady(retryRes);
    }

    // Если переключение уже идёт в соседнем тайле — ждём его результата
    if (_canopySwitchLock) {
      const switchedOk = await raceWithAbort(_canopySwitchLock, signal);
      if (!switchedOk) return false;
      const retryRes = await attemptCanopyArea(latC, lngC, radiusM, z, signal);
      if (retryRes && retryRes._aborted) throw new DOMException('Aborted', 'AbortError');
      return isCanopyResReady(retryRes);
    }

    const fallbackVer = (failedVer === 'v2') ? 'v1' : 'v2';
    const canFallback = (fallbackVer === 'v1') || !!WM.canopyV2;
    if (!canFallback) return false;

    const pLock = (async () => {
      const curVer = getCanopyVer();
      if (curVer !== failedVer) return true;

      if (WM.ui && WM.ui.showToast && (Date.now() - _canopySwitchToastAt > 4000)) {
        _canopySwitchToastAt = Date.now();
        WM.ui.showToast(`🌲 Лес (${curVer.toUpperCase()}): ${reason} — переключаюсь на ${fallbackVer.toUpperCase()}`, 3200);
      }

      _internalCanopySwitch = true;
      try {
        WM.canopy.setVersion(fallbackVer, { skipViewshedSchedule: true });
      } finally {
        _internalCanopySwitch = false;
      }

      const res2 = await attemptCanopyArea(latC, lngC, radiusM, z, null);
      if (isCanopyResReady(res2)) {
        _lastCanopySwitchAt = Date.now();
        canopyAreaInFlight.clear();
        setTimeout(() => redrawCanopyDependentLayers(true), 50);
        return true;
      }

      // Оба источника недоступны — возвращаем настройку пользователя назад
      _internalCanopySwitch = true;
      try {
        WM.canopy.setVersion(curVer, { skipViewshedSchedule: true });
      } finally {
        _internalCanopySwitch = false;
      }
      return false;
    })();

    _canopySwitchLock = pLock;
    pLock.finally(() => {
      if (_canopySwitchLock === pLock) _canopySwitchLock = null;
    });

    const switchedOk = await raceWithAbort(pLock, signal);
    if (!switchedOk) return false;

    const resAfter = await attemptCanopyArea(latC, lngC, radiusM, z, signal);
    if (resAfter && resAfter._aborted) throw new DOMException('Aborted', 'AbortError');
    return isCanopyResReady(resAfter);
  }

  async function ensureCanopyForTile(coords, signal = null) {
    if (!WM.canopy || typeof WM.canopy.loadCanopyArea !== 'function') return false;
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const z = clamp(coords.z, 11, 14);
    const shift = coords.z - z;
    const tx = shift >= 0 ? (coords.x >> shift) : (coords.x << (-shift));
    const ty = shift >= 0 ? (coords.y >> shift) : (coords.y << (-shift));

    // Если выбрана v2, но модуль canopyV2 не подключён — сразу переходим на v1
    if (getCanopyVer() === 'v2' && !WM.canopyV2 && typeof WM.canopy.setVersion === 'function') {
      _internalCanopySwitch = true;
      try {
        WM.canopy.setVersion('v1', { skipViewshedSchedule: true });
      } finally {
        _internalCanopySwitch = false;
      }
    }

    const ver = getCanopyVer();
    const key = `${ver}:${z}:${tx}:${ty}`;

    let entry = canopyAreaInFlight.get(key);
    if (!entry) {
      const n = 1 << z;
      const lngC = ((tx + 0.5) / n) * 360 - 180;
      const latC = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 0.5) / n))) * RAD;
      const tileW_m = 40075016.7 * Math.cos(latC * DEG) / n;
      const radiusM = tileW_m * 0.95;
      const ctl = new AbortController();

      const promise = (async () => {
        const res1 = await attemptCanopyArea(latC, lngC, radiusM, z, ctl.signal);
        if (ctl.signal.aborted || (res1 && res1._aborted)) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (isCanopyResReady(res1)) {
          return true;
        }
        const reason = (res1 && res1._timedOut) ? 'долго не отвечает' : 'ошибка загрузки';
        return await trySwitchAndRetryCanopy(ver, reason, latC, lngC, radiusM, z, ctl.signal);
      })();

      entry = { promise, ctl, refs: 0 };
      canopyAreaInFlight.set(key, entry);
      promise.finally(() => {
        if (canopyAreaInFlight.get(key) === entry) {
          canopyAreaInFlight.delete(key);
        }
      });
    }

    entry.refs++;
    const onAbort = () => {
      entry.refs--;
      if (entry.refs <= 0) {
        entry.ctl.abort();
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await raceWithAbort(entry.promise, signal);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!signal || !signal.aborted) {
        entry.refs = Math.max(0, entry.refs - 1);
      }
    }
  }
  // Извлечение Float32Array высот [192x192] (шаг 2px, паддинг 32 ячейки = 64px) из padded DEM
  function extractDemGrid192(cv) {
    if (!cv || cv._isEmptyFallback) return null;
    if (cv._toDem192) return cv._toDem192;

    const P = cv.width || 256;
    const S = cv._tileSize || 256;
    const B = cv._pad || 0;
    const scale = S / 256;
    const data = cv._demData || (cv._demData = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data);

    const W = 192;
    const H = new Float32Array(W * W);
    let valid = 0;
    let sum = 0;

    for (let gy = 0; gy < W; gy++) {
      const ly = gy * 2 - 64;
      const py = clamp(Math.round(B + ly * scale), 0, P - 1);
      const pRow = py * P;
      const outRow = gy * W;
      for (let gx = 0; gx < W; gx++) {
        const lx = gx * 2 - 64;
        const px = clamp(Math.round(B + lx * scale), 0, P - 1);
        const idx = (pRow + px) * 4;
        if (data[idx + 3] < 30) {
          H[outRow + gx] = NaN;
          continue;
        }
        const raw = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
        if (raw < -1000.0) {
          H[outRow + gx] = NaN;
          continue;
        }
        const h = raw > 0 ? raw : 0;
        H[outRow + gx] = h;
        sum += h;
        valid++;
      }
    }

    if (valid < 16) return null;
    const fb = sum / valid;
    if (valid < H.length) {
      for (let i = 0; i < H.length; i++) {
        if (isNaN(H[i])) H[i] = fb;
      }
    }

    cv._toDem192 = H;
    return H;
  }

  // Извлечение сетки крон деревьев [192x192] в мировых нормированных координатах
  function extractCanopyGrid192(coords) {
    if (!WM.canopy || typeof WM.canopy.getHeightAtNorm !== 'function') return null;
    const W = 192;
    const T = new Float32Array(W * W);
    const totalPx = 256 * (1 << coords.z);
    const xBase = coords.x * 256 - 64;
    const yBase = coords.y * 256 - 64;
    let hasTrees = false;

    for (let gy = 0; gy < W; gy++) {
      const yn = (yBase + gy * 2) / totalPx;
      const row = gy * W;
      if (yn <= 0 || yn >= 1) continue;
      for (let gx = 0; gx < W; gx++) {
        const xn = (xBase + gx * 2) / totalPx;
        const h = WM.canopy.getHeightAtNorm(xn, yn) || 0;
        if (h > 0.1) hasTrees = true;
        T[row + gx] = h;
      }
    }
    return hasTrees ? T : null;
  }

  function tileMpp(coords) {
    const n = 1 << coords.z;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n))) * RAD;
    return (156543.03392 * Math.cos(lat * DEG)) / n;
  }

  function tileCenterLatLng(coords) {
    const n = 1 << coords.z;
    const lng = ((coords.x + 0.5) / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n))) * RAD;
    return { lat, lng };
  }

  // =========================================================================
  // 4. АЛГОРИТМЫ РАСЧЁТА СКАЛЯРНЫХ ПОЛЕЙ ДЛЯ 5 СЛОЁВ
  // =========================================================================

  // 4.1 Крутые склоны (256x256, нативные пиксели тайла для чётких обрывов)
  function computeSteepScalar(cv, coords) {
    const P = cv.width || 256;
    const S = cv._tileSize || 256;
    const B = cv._pad || 0;
    const scale = S / 256;
    const data = cv._demData || (cv._demData = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data);

    const mpp = tileMpp(coords);
    const stepPx = Math.max(1, Math.round(scale));
    const deltaM = 2.0 * (stepPx / scale) * mpp;
    const out = new Float32Array(TILE * TILE);

    const hAt = (px, py) => {
      const ix = clamp(px, 0, P - 1);
      const iy = clamp(py, 0, P - 1);
      const idx = (iy * P + ix) * 4;
      if (data[idx + 3] < 30) return 0;
      const raw = (data[idx] * 256.0 + data[idx + 1] + data[idx + 2] / 256.0) - 32768.0;
      return raw > 0 ? raw : 0;
    };

    for (let y = 0; y < TILE; y++) {
      const py = Math.round(B + y * scale);
      const rowOff = y * TILE;
      for (let x = 0; x < TILE; x++) {
        const px = Math.round(B + x * scale);
        const hC = hAt(px, py);
        if (hC <= 0.25) {
          out[rowOff + x] = 0;
          continue;
        }
        const z00 = hAt(px - stepPx, py - stepPx), z10 = hAt(px, py - stepPx), z20 = hAt(px + stepPx, py - stepPx);
        const z01 = hAt(px - stepPx, py),          z21 = hAt(px + stepPx, py);
        const z02 = hAt(px - stepPx, py + stepPx), z12 = hAt(px, py + stepPx), z22 = hAt(px + stepPx, py + stepPx);

        const dzdx = ((z20 + 2 * z21 + z22) - (z00 + 2 * z01 + z02)) / (4 * deltaM);
        const dzdy = ((z02 + 2 * z12 + z22) - (z00 + 2 * z10 + z20)) / (4 * deltaM);
        out[rowOff + x] = Math.atan(Math.hypot(dzdx, dzdy)) * RAD;
      }
    }
    return out;
  }

  // 4.2 Пологие места под палатку (128x128: уклон + кривизна/ровность + вода + лес)
  function computeCampScalar(H192, water192, tree192, coords) {
    const W = 192;
    const PAD = 32;
    const mppCell = tileMpp(coords) * 2.0; // шаг сетки 192x192 = 2 логических px
    const slopeArr = new Float32Array(GRID * GRID);
    const roughArr = new Float32Array(GRID * GRID);
    const waterDistArr = new Float32Array(GRID * GRID);
    const treeArr = new Float32Array(GRID * GRID);

    // 1. Быстрая оценка расстояния до воды на сетке 192x192 (2-проходное Chamfer расстояние)
    const distPx = new Float32Array(W * W);
    for (let i = 0; i < W * W; i++) {
      const isW = (water192 && water192.grid[i]) || H192[i] <= 0.28;
      distPx[i] = isW ? 0 : 1e6;
    }
    for (let y = 0; y < W; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let d = distPx[i];
        if (d === 0) continue;
        if (x > 0) d = Math.min(d, distPx[i - 1] + 1);
        if (y > 0) {
          d = Math.min(d, distPx[i - W] + 1);
          if (x > 0) d = Math.min(d, distPx[i - W - 1] + 1.414);
          if (x + 1 < W) d = Math.min(d, distPx[i - W + 1] + 1.414);
        }
        distPx[i] = d;
      }
    }
    for (let y = W - 1; y >= 0; y--) {
      const row = y * W;
      for (let x = W - 1; x >= 0; x--) {
        const i = row + x;
        let d = distPx[i];
        if (x + 1 < W) d = Math.min(d, distPx[i + 1] + 1);
        if (y + 1 < W) {
          d = Math.min(d, distPx[i + W] + 1);
          if (x + 1 < W) d = Math.min(d, distPx[i + W + 1] + 1.414);
          if (x > 0) d = Math.min(d, distPx[i + W - 1] + 1.414);
        }
        distPx[i] = d;
      }
    }

    const rSlope = clamp(Math.round(12 / mppCell), 1, 4);
    const rRough = clamp(Math.round(18 / mppCell), 1, 6);

    for (let gy = 0; gy < GRID; gy++) {
      const py = gy + PAD;
      const outRow = gy * GRID;
      for (let gx = 0; gx < GRID; gx++) {
        const px = gx + PAD;
        const idx192 = py * W + px;
        const hC = H192[idx192];

        const hL = H192[py * W + (px - rSlope)];
        const hR = H192[py * W + (px + rSlope)];
        const hU = H192[(py - rSlope) * W + px];
        const hD = H192[(py + rSlope) * W + px];
        const dzdx = (hR - hL) / (2 * rSlope * mppCell);
        const dzdy = (hD - hU) / (2 * rSlope * mppCell);
        slopeArr[outRow + gx] = Math.atan(Math.hypot(dzdx, dzdy)) * RAD;

        const avg4 = 0.25 * (
          H192[py * W + (px - rRough)] +
          H192[py * W + (px + rRough)] +
          H192[(py - rRough) * W + px] +
          H192[(py + rRough) * W + px]
        );
        roughArr[outRow + gx] = Math.abs(hC - avg4);
        waterDistArr[outRow + gx] = distPx[idx192] * mppCell;
        treeArr[outRow + gx] = tree192 ? tree192[idx192] : 0;
      }
    }

    return { slopeArr, roughArr, waterDistArr, treeArr };
  }

  // 4.3 Склоны защищённые от ветра (128x128: наветренный горизонт DEM + экспозиция + лесополоса)
  function computeWindShelterScalar(H192, tree192, coords, windFromDeg, useForest) {
    const W = 192;
    const PAD = 32;
    const mppCell = tileMpp(coords) * 2.0;
    const out = new Float32Array(GRID * GRID);

    // Вектор В НАПРАВЛЕНИИ НАВСТРЕЧУ ВЕТРУ (upwind) в координатах (x=Восток, y=Юг)
    const rad = windFromDeg * DEG;
    const ux = Math.sin(rad);
    const uy = -Math.cos(rad);

    // Прогрессивные шаги против ветра в пределах 30 ячеек (~60px)
    const STEPS = [1, 2, 3.5, 5.5, 8, 11, 15, 20, 25, 30];
    const TREE_STEPS = [1, 2, 3.5, 5.5, 8, 11];

    for (let gy = 0; gy < GRID; gy++) {
      const py = gy + PAD;
      const outRow = gy * GRID;
      for (let gx = 0; gx < GRID; gx++) {
        const px = gx + PAD;
        const idx0 = py * W + px;
        const h0 = H192[idx0];
        if (h0 <= 0.25) {
          out[outRow + gx] = 0;
          continue;
        }

        // 1. Локальный уклон и защита от обдуваемости гребней
        const dzdx = (H192[py * W + px + 1] - H192[py * W + px - 1]) / (2 * mppCell);
        const dzdy = (H192[(py + 1) * W + px] - H192[(py - 1) * W + px]) / (2 * mppCell);
        const upwindSlope = dzdx * ux + dzdy * uy; // > 0, если склон подветренный (вверх против ветра)

        const avgLocal = 0.25 * (H192[py * W + px + 2] + H192[py * W + px - 2] + H192[(py + 2) * W + px] + H192[(py - 2) * W + px]);
        const convexity = h0 - avgLocal; // > 0 на открытой макушке хребта

        // 2. Угол закрытия наветренного горизонта рельефом
        let maxTan = -0.2;
        for (let s = 0; s < STEPS.length; s++) {
          const st = STEPS[s];
          const sx = clamp(Math.round(px + ux * st), 0, W - 1);
          const sy = clamp(Math.round(py + uy * st), 0, W - 1);
          const distM = st * mppCell;
          const tanA = (H192[sy * W + sx] - h0) / distM;
          if (tanA > maxTan) maxTan = tanA;
        }
        const horizonDeg = Math.atan(maxTan) * RAD;

        // Ветровая тень рельефа + вклад подветренного склона
        let terrainShelter = smooth(1.5, 16.0, horizonDeg) * 0.85;
        if (upwindSlope > 0.04) {
          const slopeDeg = Math.atan(upwindSlope) * RAD;
          terrainShelter = Math.max(terrainShelter, smooth(4.0, 28.0, slopeDeg) * 0.82);
        }
        // На открытых наветренных гребнях ветровая защита резко падает
        if (horizonDeg < 1.0 && convexity > 1.5) {
          terrainShelter *= (1.0 - smooth(1.5, 8.0, convexity));
        }

        // 3. Ветрозащита от лесного полога и наветренных лесополос (до ~15 * H_tree)
        let forestShelter = 0;
        if (useForest && tree192) {
          const t0 = tree192[idx0];
          if (t0 >= 3.0) {
            forestShelter = Math.max(forestShelter, smooth(2.5, 14.0, t0) * 0.58);
          }
          for (let s = 0; s < TREE_STEPS.length; s++) {
            const st = TREE_STEPS[s];
            const distM = st * mppCell;
            if (distM > 260) break;
            const sx = clamp(Math.round(px + ux * st), 0, W - 1);
            const sy = clamp(Math.round(py + uy * st), 0, W - 1);
            const idxU = sy * W + sx;
            const tU = tree192[idxU];
            if (tU >= 4.0) {
              const effTop = H192[idxU] + tU;
              const rayClear = effTop - h0;
              if (rayClear > 0) {
                const reachM = tU * 15.0;
                if (distM < reachM) {
                  const wake = smooth(3.5, 14.0, tU) * (1.0 - distM / reachM) * 0.55;
                  if (wake > forestShelter) forestShelter = wake;
                }
              }
            }
          }
        }

        const combined = 1.0 - (1.0 - clamp(terrainShelter, 0, 0.96)) * (1.0 - clamp(forestShelter, 0, 0.72));
        out[outRow + gx] = clamp(combined, 0, 1);
      }
    }
    return out;
  }

  // 4.4 Накопление солнечного света за весь день на земле (SunCalc + рельеф + тень крон)
  function getSunTrajectory(dateStr, lat, lng) {
    const parts = (dateStr || getTodayStr()).split('-').map(Number);
    const y = parts[0] || 2026, m = (parts[1] || 6) - 1, d = parts[2] || 21;
    // Опорный полдень по долготе
    const anchor = new Date(Date.UTC(y, m, d, 12, 0, 0) - (lng / 15) * 3600000);
    const SC = window.SunCalc;
    const samples = [];

    if (SC && SC.getPosition) {
      let startMs = anchor.getTime() - 12 * 3600000;
      let endMs = anchor.getTime() + 12 * 3600000;
      if (SC.getTimes) {
        const times = SC.getTimes(anchor, lat, lng);
        if (times.sunrise && !isNaN(times.sunrise.getTime()) && times.sunset && !isNaN(times.sunset.getTime())) {
          startMs = times.sunrise.getTime() + 15 * 60000;
          endMs = times.sunset.getTime() - 15 * 60000;
        }
      }
      const N_STEPS = 11;
      for (let i = 0; i < N_STEPS; i++) {
        const dt = new Date(lerp(startMs, endMs, (i + 0.5) / N_STEPS));
        const pos = SC.getPosition(dt, lat, lng);
        const alt = pos.altitude;
        if (alt > 0.035) { // выше ~2° над горизонтом
          const az = pos.azimuth + Math.PI;
          const cosA = Math.cos(alt);
          const sinA = Math.sin(alt);
          const am = 1.0 / (sinA + 0.15 * Math.pow(alt * RAD + 3.885, -1.253));
          const irr = Math.pow(0.74, Math.pow(Math.max(1, am), 0.68));
          samples.push({
            sx: Math.sin(az) * cosA,
            sy: -Math.cos(az) * cosA, // +y = Юг
            sz: sinA,
            tanA: sinA / Math.max(0.05, cosA),
            ux: Math.sin(az),
            uy: -Math.cos(az),
            irr
          });
        }
      }
    } else {
      // Фоллбэк без SunCalc (дуга с востока через юг на запад)
      for (let i = 0; i < 9; i++) {
        const az = lerp(95 * DEG, 265 * DEG, i / 8);
        const alt = lerp(12 * DEG, 50 * DEG, Math.sin((i / 8) * Math.PI));
        const cosA = Math.cos(alt), sinA = Math.sin(alt);
        samples.push({
          sx: Math.sin(az) * cosA,
          sy: -Math.cos(az) * cosA,
          sz: sinA,
          tanA: sinA / Math.max(0.05, cosA),
          ux: Math.sin(az),
          uy: -Math.cos(az),
          irr: 0.78
        });
      }
    }
    return samples;
  }

  function computeSolarScalar(H192, tree192, coords, dateStr, useForestShade) {
    const W = 192;
    const PAD = 32;
    const mppCell = tileMpp(coords) * 2.0;
    const out = new Float32Array(GRID * GRID);
    const { lat, lng } = tileCenterLatLng(coords);
    const suns = getSunTrajectory(dateStr, lat, lng);
    if (!suns.length) return out; // полярная ночь

    // Считаем эталонную дневную энергию на открытой ровной поверхности
    let flatRefE = 0;
    for (let k = 0; k < suns.length; k++) {
      flatRefE += suns[k].irr * (suns[k].sz * 0.84 + 0.16 * suns[k].sz);
    }
    if (flatRefE < 1e-4) return out;

    const RAY_STEPS = [1.5, 3, 5, 8, 12, 17, 23, 30];
    const TREE_RAY_M = [8, 18, 32];

    for (let gy = 0; gy < GRID; gy++) {
      const py = gy + PAD;
      const outRow = gy * GRID;
      for (let gx = 0; gx < GRID; gx++) {
        const px = gx + PAD;
        const idx0 = py * W + px;
        const h0 = H192[idx0];

        // Нормаль рельефа (в координатах x=Восток, y=Юг, z=Вверх)
        const dzdx = (H192[py * W + px + 1] - H192[py * W + px - 1]) / (2 * mppCell);
        const dzdy = (H192[(py + 1) * W + px] - H192[(py - 1) * W + px]) / (2 * mppCell);
        const nLen = Math.hypot(dzdx, dzdy, 1.0);
        const nx = -dzdx / nLen;
        const ny = -dzdy / nLen;
        const nz = 1.0 / nLen;

        // Быстрая оценка открытости неба (SVF) для рассеянного света
        const avgSurr = 0.25 * (
          H192[py * W + clamp(px + 8, 0, W - 1)] +
          H192[py * W + clamp(px - 8, 0, W - 1)] +
          H192[clamp(py + 8, 0, W - 1) * W + px] +
          H192[clamp(py - 8, 0, W - 1) * W + px]
        );
        const svf = clamp(1.0 - Math.max(0, (avgSurr - h0) / (16.0 * mppCell)) * 0.9, 0.35, 1.0);

        // Затенение рассеянного и прямого света кронами непосредственно над точкой земли
        const t0 = (useForestShade && tree192) ? tree192[idx0] : 0;
        const canopyDirectSelf = t0 >= 2.5 ? clamp(Math.exp(-0.14 * Math.min(t0, 16)), 0.14, 1.0) : 1.0;
        const canopyDiffSelf = t0 >= 2.5 ? lerp(1.0, 0.38, smooth(2.5, 12.0, t0)) : 1.0;

        let totalE = 0;
        for (let k = 0; k < suns.length; k++) {
          const sun = suns[k];
          const cosInc = Math.max(0, nx * sun.sx + ny * sun.sy + nz * sun.sz);

          let terrainLit = 1.0;
          if (cosInc > 0.01) {
            for (let s = 0; s < RAY_STEPS.length; s++) {
              const st = RAY_STEPS[s];
              const rx = clamp(Math.round(px + sun.ux * st), 0, W - 1);
              const ry = clamp(Math.round(py + sun.uy * st), 0, W - 1);
              const distM = st * mppCell;
              if (H192[ry * W + rx] > h0 + distM * sun.tanA + 0.5) {
                terrainLit = 0.0;
                break;
              }
            }
          } else {
            terrainLit = 0.0;
          }

          // Тень на землю от соседних лесных массивов со стороны Солнца
          let canopyRayTrans = canopyDirectSelf;
          if (useForestShade && tree192 && terrainLit > 0.01 && canopyDirectSelf > 0.25) {
            for (let ts = 0; ts < TREE_RAY_M.length; ts++) {
              const distM = TREE_RAY_M[ts];
              const stepCells = distM / mppCell;
              const rx = clamp(Math.round(px + sun.ux * stepCells), 0, W - 1);
              const ry = clamp(Math.round(py + sun.uy * stepCells), 0, W - 1);
              const rIdx = ry * W + rx;
              const tRay = tree192[rIdx];
              if (tRay >= 3.5 && (H192[rIdx] + tRay > h0 + distM * sun.tanA)) {
                canopyRayTrans = Math.min(canopyRayTrans, 0.22);
                break;
              }
            }
          }

          const directE = sun.irr * cosInc * 0.84 * terrainLit * canopyRayTrans;
          const diffuseE = sun.irr * sun.sz * 0.16 * svf * canopyDiffSelf;
          totalE += directE + diffuseE;
        }

        // Нормируем так, чтобы ровный открытый луг ≈ 0.85, южный открытый склон ≈ 1.0
        out[outRow + gx] = clamp(totalE / (flatRefE * 1.15), 0, 1);
      }
    }
    return out;
  }

  function filterIsolatedWaterGrid(srcGrid, W) {
    const N = W * W;
    const out = new Uint8Array(N);
    const visited = new Uint8Array(N);
    const stack = new Int32Array(N);
    const comp = new Int32Array(N);

    for (let i = 0; i < N; i++) {
      if (!srcGrid[i] || visited[i]) continue;
      let sp = 0;
      let cp = 0;
      let touchesEdge = false;
      stack[sp++] = i;
      visited[i] = 1;

      while (sp > 0) {
        const u = stack[--sp];
        comp[cp++] = u;
        const x = u % W;
        const y = (u / W) | 0;
        if (x === 0 || x === W - 1 || y === 0 || y === W - 1) touchesEdge = true;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= W) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const v = ny * W + nx;
            if (srcGrid[v] && !visited[v]) {
              visited[v] = 1;
              stack[sp++] = v;
            }
          }
        }
      }

      // Оставляем только крупные водоёмы (>= 4 ячеек) или реки, уходящие за край тайла
      if (touchesEdge || cp >= 4) {
        for (let k = 0; k < cp; k++) out[comp[k]] = 1;
      }
    }
    return out;
  }

  // 4.5 Разлив рек (128x128: Nearest-Water Surface + связный мин-макс Дейкстра для барьеров)
  function computeFloodScalar(H192, water192, macroFlood = null, coords = null, floodSrc = 'all') {
    const W = 192;
    const PAD = 32;
    const N = W * W;
    const MAX_REQ = 15.0;

    const isStrictMode = (floodSrc === 'osm_rivers' || floodSrc === 'osm_all' || floodSrc === 'esa_clean');
    const cleanGrid = (floodSrc === 'esa_clean' && water192 && water192.hasWater)
      ? filterIsolatedWaterGrid(water192.grid, W)
      : (water192 ? water192.grid : null);

    // 1. Водные клетки и очищенная от шума берега отметка уреза
    const isWater = new Uint8Array(N);
    const bedH = new Float32Array(N);
    let waterCount = 0;

    for (let y = 0; y < W; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const w = isStrictMode
          ? !!(cleanGrid && cleanGrid[i])
          : ((cleanGrid && cleanGrid[i]) || (!water192 && H192[i] <= 0.25) || H192[i] <= 0.02);
        if (w) {
          isWater[i] = 1;
          let min3 = H192[i];
          if (x > 0 && H192[i - 1] < min3) min3 = H192[i - 1];
          if (x + 1 < W && H192[i + 1] < min3) min3 = H192[i + 1];
          if (y > 0 && H192[i - W] < min3) min3 = H192[i - W];
          if (y + 1 < W && H192[i + W] < min3) min3 = H192[i + W];
          bedH[i] = Math.max(H192[i] - 2.0, min3);
          waterCount++;
        }
      }
    }

    const bestReq = new Float32Array(N).fill(999.0);
    const bestDist = new Float32Array(N).fill(1e9);
    const stageArr = new Float32Array(N);
    const closed = new Uint8Array(N);

    const HEAP_CAP = N * 4;
    const heapIdx = new Int32Array(HEAP_CAP);
    const heapReq = new Float32Array(HEAP_CAP);
    const heapDist = new Float32Array(HEAP_CAP);
    let heapLen = 0;

    const push = (idx, rVal, dVal) => {
      if (heapLen >= HEAP_CAP) return;
      let k = heapLen++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        const pr = heapReq[p];
        if (pr < rVal || (pr === rVal && heapDist[p] <= dVal)) break;
        heapIdx[k] = heapIdx[p];
        heapReq[k] = pr;
        heapDist[k] = heapDist[p];
        k = p;
      }
      heapIdx[k] = idx;
      heapReq[k] = rVal;
      heapDist[k] = dVal;
    };

    // Источники от локальной воды
    for (let i = 0; i < N; i++) {
      if (!isWater[i]) continue;
      bestReq[i] = 0;
      bestDist[i] = 0;
      stageArr[i] = bedH[i];
      push(i, 0, 0);
    }

    // Приток паводка с более широкого макро-тайла по внешнему периметру 192x192
    let hasMacroBorder = false;
    if (macroFlood && !macroFlood.empty && coords && coords.z > macroFlood.z) {
      const zDiff = coords.z - macroFlood.z;
      const scale = 1 << zDiff;
      const txM = coords.x >> zDiff;
      const tyM = coords.y >> zDiff;
      const baseX = coords.x * 256 - 64;
      const baseY = coords.y * 256 - 64;
      const mReqA = macroFlood.req192;
      const mStA = macroFlood.stage192;
      const LO = PAD, HI = PAD + GRID; // внутренний квадрат [LO, HI)

      for (let y = 0; y < W; y++) {
        const fy = ((baseY + y * 2) / scale - tyM * 256 + 64) / 2;
        const y0 = clamp(Math.floor(fy), 0, W - 2);
        const ty = clamp(fy - y0, 0, 1);
        const inBandY = (y < LO || y >= HI);
        for (let x = 0; x < W; x++) {
          if (!inBandY && x >= LO && x < HI) continue; // внутренность считаем точно по мелкому DEM
          const i = y * W + x;
          if (isWater[i]) continue;

          const fx = ((baseX + x * 2) / scale - txM * 256 + 64) / 2;
          const x0 = clamp(Math.floor(fx), 0, W - 2);
          const tx = clamp(fx - x0, 0, 1);

          let wSum = 0, rSum = 0, sSum = 0;
          for (let k = 0; k < 4; k++) {
            const ox = k & 1, oy = k >> 1;
            const j = (y0 + oy) * W + (x0 + ox);
            const r = mReqA[j];
            if (!(r <= MAX_REQ)) continue;
            const w = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty);
            wSum += w; rSum += r * w; sSum += mStA[j] * w;
          }
          if (wSum < 0.5) continue;
          const mReq = rSum / wSum;
          const mStage = sSum / wSum;
          if (H192[i] < mStage - 2.0) continue;
          const initReq = Math.fround(Math.max(mReq, H192[i] - mStage));
          if (initReq <= MAX_REQ && initReq < bestReq[i]) {
            bestReq[i] = initReq;
            bestDist[i] = 1;
            stageArr[i] = mStage;
            push(i, initReq, 1);
            hasMacroBorder = true;
          }
        }
      }
    }

    if (waterCount === 0 && !hasMacroBorder) return { empty: true };

    // 2. Min-Max Dijkstra: минимальный требуемый подъём воды (без искусственных стоков на краях тайла)
    const DX = [1, -1, 0, 0, 1, -1, 1, -1];
    const DY = [0, 0, 1, -1, 1, 1, -1, -1];
    const STEP_D = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];

    while (heapLen > 0) {
      const u = heapIdx[0];
      const rU = heapReq[0];
      const dU = heapDist[0];
      heapLen--;
      if (heapLen > 0) {
        const lastI = heapIdx[heapLen];
        const lastR = heapReq[heapLen];
        const lastD = heapDist[heapLen];
        let k = 0;
        while (true) {
          const left = (k << 1) + 1;
          if (left >= heapLen) break;
          const right = left + 1;
          let sm = left;
          if (
            right < heapLen &&
            (heapReq[right] < heapReq[left] || (heapReq[right] === heapReq[left] && heapDist[right] < heapDist[left]))
          ) {
            sm = right;
          }
          const sr = heapReq[sm];
          if (lastR < sr || (lastR === sr && lastD <= heapDist[sm])) break;
          heapIdx[k] = heapIdx[sm];
          heapReq[k] = sr;
          heapDist[k] = heapDist[sm];
          k = sm;
        }
        heapIdx[k] = lastI;
        heapReq[k] = lastR;
        heapDist[k] = lastD;
      }

      if (closed[u]) continue;
      closed[u] = 1;

      const ux = u % W;
      const uy = (u / W) | 0;
      const stU = stageArr[u];

      for (let d = 0; d < 8; d++) {
        const vx = ux + DX[d];
        const vy = uy + DY[d];
        if (vx < 0 || vx >= W || vy < 0 || vy >= W) continue;
        const v = vy * W + vx;
        if (closed[v] || isWater[v]) continue;

        const hV = H192[v];
        // Отсекаем бесконечное «стекание» верховых болот в сухой лес заметно ниже уреза
        if (hV < stU - 1.2) continue;

        const nReq = Math.fround(Math.max(rU, hV - stU));
        if (nReq > MAX_REQ) continue;
        const nDist = Math.fround(dU + STEP_D[d]);

        if (nReq < bestReq[v] || (nReq === bestReq[v] && nDist < bestDist[v])) {
          bestReq[v] = nReq;
          bestDist[v] = nDist;
          stageArr[v] = stU;
          push(v, nReq, nDist);
        }
      }
    }

    // 3. Вырезаем внутренний квадрат 128x128
    const innerReq = new Float32Array(GRID * GRID);
    const innerWater = new Uint8Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++) {
      const srcOff = (gy + PAD) * W + PAD;
      const dstOff = gy * GRID;
      for (let gx = 0; gx < GRID; gx++) {
        innerReq[dstOff + gx] = bestReq[srcOff + gx];
        innerWater[dstOff + gx] = isWater[srcOff + gx];
      }
    }

    return {
      empty: false,
      floodReq: innerReq,
      isWater: innerWater,
      req192: bestReq,
      stage192: stageArr,
      z: coords ? coords.z : 0
    };
  }



  // =========================================================================
  // 5. ОТРИСОВКА БУФЕРА В CANVAS (МГНОВЕННО ПРИ СМЕНЕ ПОЛЗУНКОВ/ЦВЕТОВ)
  // =========================================================================
  let paintImgData = null;
  let paintBuf32 = null;
  let scratch128Cv = null;
  let scratch128Ctx = null;

  function ensurePaintBuffers(w) {
    if (w === GRID) {
      if (!scratch128Cv) {
        scratch128Cv = document.createElement('canvas');
        scratch128Cv.width = GRID;
        scratch128Cv.height = GRID;
        scratch128Ctx = scratch128Cv.getContext('2d', { willReadFrequently: true });
        paintImgData = scratch128Ctx.createImageData(GRID, GRID);
        paintBuf32 = new Uint32Array(paintImgData.data.buffer);
      }
      return;
    }
    if (!paintImgData || paintImgData.width !== w) {
      const tmp = document.createElement('canvas').getContext('2d');
      paintImgData = tmp.createImageData(w, w);
      paintBuf32 = new Uint32Array(paintImgData.data.buffer);
    }
  }

  const packABGR = (r, g, b, a) => (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;

  function blitGridToTile(canvas, buf32) {
    scratch128Ctx.putImageData(paintImgData, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch128Cv, 0, 0, TILE, TILE);
  }

  function paintSteep(canvas, scalar) {
    const c = cfg.steep;
    const colA = hexToRgb(c.color);
    const colB = hexToRgb(c.cliffColor);
    const minA = c.minAngle;
    const span = Math.max(10, 55 - minA);

    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(TILE, TILE);
    const out32 = new Uint32Array(img.data.buffer);

    for (let i = 0; i < scalar.length; i++) {
      const ang = scalar[i];
      if (ang < minA - 1.5) continue;
      const fade = smooth(minA - 1.5, minA + 1.5, ang);
      const t = clamp((ang - minA) / span, 0, 1);
      const r = lerp(colA[0], colB[0], t) | 0;
      const g = lerp(colA[1], colB[1], t) | 0;
      const b = lerp(colA[2], colB[2], t) | 0;
      const a = (lerp(145, 240, t) * fade) | 0;
      out32[i] = packABGR(r, g, b, a);
    }
    ctx.putImageData(img, 0, 0);
  }

  function paintCamp(canvas, data) {
    ensurePaintBuffers(GRID);
    paintBuf32.fill(0);

    const c = cfg.camp;
    const col = hexToRgb(c.color);
    const hiCol = [Math.min(255, col[0] + 45), Math.min(255, col[1] + 45), Math.min(255, col[2] + 45)];
    const maxSlope = c.maxSlope;
    const curvLim = c.flatness === 'strict' ? 0.35 : (c.flatness === 'relaxed' ? 1.45 : 0.78);
    const minWaterM = c.avoidWaterBuffer ? 15 : 2;

    const { slopeArr, roughArr, waterDistArr, treeArr } = data;

    for (let i = 0; i < GRID * GRID; i++) {
      if (waterDistArr[i] < minWaterM) continue;
      const sl = slopeArr[i];
      if (sl > maxSlope + 1.5) continue;
      const rg = roughArr[i];
      if (rg > curvLim * 1.45) continue;

      const sScore = smooth(maxSlope + 1.2, Math.max(0.4, maxSlope * 0.35), sl);
      const rScore = smooth(curvLim * 1.45, curvLim * 0.25, rg);
      const tScore = c.avoidForest ? smooth(6.5, 2.0, treeArr[i]) : 1.0;
      const score = sScore * rScore * tScore;
      if (score <= 0.08) continue;

      const t = smooth(0.15, 0.95, score);
      const r = lerp(col[0], hiCol[0], t) | 0;
      const g = lerp(col[1], hiCol[1], t) | 0;
      const b = lerp(col[2], hiCol[2], t) | 0;
      const a = lerp(85, 215, t) | 0;
      paintBuf32[i] = packABGR(r, g, b, a);
    }
    blitGridToTile(canvas, paintBuf32);
  }

  function paintWindShelter(canvas, scalar) {
    ensurePaintBuffers(GRID);
    paintBuf32.fill(0);

    const c = cfg.windShelter;
    const col = hexToRgb(c.color);
    const deep = [Math.max(0, col[0] - 25), Math.min(255, col[1] + 25), Math.min(255, col[2] + 30)];
    const thr = clamp(c.minShelter / 100, 0.1, 0.9);

    for (let i = 0; i < scalar.length; i++) {
      const sh = scalar[i];
      if (sh < thr - 0.06) continue;
      const fade = smooth(thr - 0.06, thr + 0.06, sh);
      const t = clamp((sh - thr) / Math.max(0.15, 1.0 - thr), 0, 1);
      const r = lerp(col[0], deep[0], t) | 0;
      const g = lerp(col[1], deep[1], t) | 0;
      const b = lerp(col[2], deep[2], t) | 0;
      const a = (lerp(115, 225, t) * fade) | 0;
      paintBuf32[i] = packABGR(r, g, b, a);
    }
    blitGridToTile(canvas, paintBuf32);
  }

  function paintSolar(canvas, scalar) {
    ensurePaintBuffers(GRID);
    paintBuf32.fill(0);

    const c = cfg.solar;
    const col = hexToRgb(c.color);
    const bright = [Math.min(255, col[0] + 35), Math.min(255, col[1] + 55), Math.min(255, col[2] + 40)];
    const thr = clamp(c.minLight / 100, 0.1, 0.95);

    for (let i = 0; i < scalar.length; i++) {
      const val = scalar[i];
      if (val < thr - 0.05) continue;
      const fade = smooth(thr - 0.05, thr + 0.05, val);
      const t = clamp((val - thr) / Math.max(0.15, 1.0 - thr), 0, 1);
      const r = lerp(col[0], bright[0], t) | 0;
      const g = lerp(col[1], bright[1], t) | 0;
      const b = lerp(col[2], bright[2], t) | 0;
      const a = (lerp(110, 225, t) * fade) | 0;
      paintBuf32[i] = packABGR(r, g, b, a);
    }
    blitGridToTile(canvas, paintBuf32);
  }

  function paintFlood(canvas, data) {
    const ctx = canvas.getContext('2d');
    if (!data || data.empty) {
      ctx.clearRect(0, 0, TILE, TILE);
      return;
    }

    ensurePaintBuffers(GRID);
    paintBuf32.fill(0);

    const c = cfg.flood;
    const colDeep = hexToRgb(c.color);
    const colShal = hexToRgb(c.shallowColor);
    const lvl = c.floodLevelM;
    const { floodReq, isWater } = data;

    for (let i = 0; i < GRID * GRID; i++) {
      if (isWater[i]) {
        if (c.showExistingWater) {
          paintBuf32[i] = packABGR(colDeep[0], colDeep[1], colDeep[2], 185);
        }
        continue;
      }
      const req = floodReq[i];
      if (req > lvl + 0.15) continue;
      const depth = lvl - req;
      const edgeFade = smooth(-0.15, 0.35, depth);
      const t = smooth(0, Math.max(1.5, lvl * 0.8), Math.max(0, depth));
      const r = lerp(colShal[0], colDeep[0], t) | 0;
      const g = lerp(colShal[1], colDeep[1], t) | 0;
      const b = lerp(colShal[2], colDeep[2], t) | 0;
      const a = (lerp(145, 235, t) * edgeFade) | 0;
      paintBuf32[i] = packABGR(r, g, b, a);
    }
    blitGridToTile(canvas, paintBuf32);
  }

  // =========================================================================
  // 6. МЕНЕДЖЕР ОЧЕРЕДИ С БЮДЖЕТОМ КАДРОВ И ИНДИКАТОРОМ ЗАГРУЗКИ
  // =========================================================================
  const MAX_SCALAR_CACHE = 48;
  const scalarCaches = {
    steep: new Map(),
    camp: new Map(),
    windShelter: new Map(),
    solar: new Map(),
    flood: new Map()
  };

  function setScalarCache(layerId, key, val) {
    const m = scalarCaches[layerId];
    if (!m) return;
    if (m.has(key)) m.delete(key);
    else if (m.size >= MAX_SCALAR_CACHE) m.delete(m.keys().next().value);
    m.set(key, val);
  }

  function scalarKeyFor(layerId, coords) {
    const demSrc = (WM.demRelief && WM.demRelief.getConfig) ? (WM.demRelief.getConfig().demSource || 'mapterhorn') : 'mapterhorn';
    const base = `${demSrc}:${coords.z}:${coords.x}:${coords.y}`;
    if (layerId === 'steep') return base;
    if (layerId === 'flood') return `${base}|src:${cfg.flood.sourceMode || 'all'}`;
    if (layerId === 'camp') {
      return `${base}|f${cfg.camp.avoidForest ? 1 : 0}|${cfg.camp.avoidForest ? getCanopyVer() : '0'}`;
    }
    if (layerId === 'windShelter') {
      const wDir = cfg.windShelter.windSource === 'manual' ? cfg.windShelter.windDir : activeAutoWind.dir;
      const qDir = Math.round(wDir / 5) * 5;
      return `${base}|w${qDir}|f${cfg.windShelter.useForest ? 1 : 0}|${cfg.windShelter.useForest ? getCanopyVer() : '0'}`;
    }
    if (layerId === 'solar') {
      const dStr = getEffectiveSolarDateStr();
      return `${base}|${dStr}|f${cfg.solar.useForestShade ? 1 : 0}|${cfg.solar.useForestShade ? getCanopyVer() : '0'}`;
    }
    return base;
  }

  function getEffectiveSolarDateStr() {
    const y = new Date().getFullYear();
    if (cfg.solar.dateMode === 'summer') return `${y}-06-22`;
    if (cfg.solar.dateMode === 'equinox') return `${y}-09-22`;
    if (cfg.solar.dateMode === 'winter') return `${y}-12-22`;
    if (cfg.solar.dateMode === 'custom' && cfg.solar.dateStr) return cfg.solar.dateStr;
    return getTodayStr();
  }

  const jobStats = {
    pendingFetch: 0,
    pendingCompute: 0,
    totalBatch: 0,
    doneBatch: 0,
    offlineNoDem: false,
    canopyFailed: false,
    lastNote: ''
  };

  let _computeQueue = [];
  let _computeRaf = 0;
  let _statusTimer = 0;

  function scheduleStatusUI() {
    if (_statusTimer) return;
    _statusTimer = setTimeout(() => {
      _statusTimer = 0;
      renderProgressUI();
    }, 60);
  }

  const MAX_CONCURRENT_FETCHES = 4;
  let _fetchQueue = [];
  let _activeFetches = 0;

  function resetBatchIfIdle() {
    if (_activeFetches <= 0 && _fetchQueue.length === 0 && _computeQueue.length === 0) {
      _activeFetches = 0;
      jobStats.pendingFetch = 0;
      jobStats.pendingCompute = 0;
      jobStats.totalBatch = 0;
      jobStats.doneBatch = 0;
    }
  }

  function markTileCancelled(tile) {
    if (tile && tile._counted && !tile._doneCounted) {
      tile._doneCounted = true;
      jobStats.totalBatch = Math.max(0, jobStats.totalBatch - 1);
    }
  }

  function markTileCompleted(tile) {
    if (tile && tile._counted && !tile._doneCounted) {
      tile._doneCounted = true;
      jobStats.doneBatch++;
    }
  }

  function pruneDeadFetchTasks() {
    if (!_fetchQueue.length) return;
    const alive = [];
    for (let i = 0; i < _fetchQueue.length; i++) {
      const t = _fetchQueue[i];
      const layer = layers[t.layerId];
      if (!t.tile._dead && !t.signal.aborted && layer && map && map.hasLayer(layer) && t.coords.z === layer._tileZoom) {
        alive.push(t);
      } else {
        markTileCancelled(t.tile);
        t.done(null, t.tile);
      }
    }
    _fetchQueue = alive;
    jobStats.pendingFetch = _activeFetches + _fetchQueue.length;
  }

  function pumpFetchQueue() {
    pruneDeadFetchTasks();
    if (!map) return;

    while (_activeFetches < MAX_CONCURRENT_FETCHES && _fetchQueue.length > 0) {
      const center = map.getCenter();
      for (let i = 0; i < _fetchQueue.length; i++) {
        const ll = _fetchQueue[i].centerLL || center;
        const dy = ll.lat - center.lat, dx = ll.lng - center.lng;
        _fetchQueue[i].dist2 = dx * dx + dy * dy;
      }
      _fetchQueue.sort((a, b) => a.dist2 - b.dist2);

      const task = _fetchQueue.shift();
      _activeFetches++;
      jobStats.pendingFetch = _activeFetches + _fetchQueue.length;
      scheduleStatusUI();
      runTileFetch(task);
    }

    resetBatchIfIdle();
    scheduleStatusUI();
  }

  async function runTileFetch(task) {
    const { layerId, tile, coords, centerLL, signal, done } = task;
    let handedToCompute = false;

    try {
      const layer = layers[layerId];
      if (signal.aborted || tile._dead || !layer || !map || !map.hasLayer(layer) || coords.z !== layer._tileZoom) {
        markTileCancelled(tile);
        done(null, tile);
        return;
      }
      if (!WM.demRelief || typeof WM.demRelief.loadPaddedDemTile !== 'function') {
        markTileCompleted(tile);
        done(null, tile);
        return;
      }


      const floodSrc = cfg.flood.sourceMode || 'all';
      const useOsmFlood = (layerId === 'flood' && (floodSrc === 'osm_rivers' || floodSrc === 'osm_all'));
      const needWater = (layerId === 'camp') || (layerId === 'flood' && !useOsmFlood);
      const needMacroFlood = (layerId === 'flood' && coords.z >= 10);
      const needCanopy =
        (layerId === 'camp' && cfg.camp.avoidForest) ||
        (layerId === 'windShelter' && cfg.windShelter.useForest) ||
        (layerId === 'solar' && cfg.solar.useForestShade);
      const needWind = (layerId === 'windShelter');

      const tasks = [
        raceWithAbort(WM.demRelief.loadPaddedDemTile(coords), signal),
        useOsmFlood
          ? loadPaddedOsmWaterMask(coords, floodSrc, signal)
          : (needWater ? loadPaddedWaterMask(coords, signal) : Promise.resolve(null)),
        needCanopy ? ensureCanopyForTile(coords, signal) : Promise.resolve(false),
        needWind ? raceWithAbort(resolveWindForCenter(centerLL.lat, centerLL.lng), signal) : Promise.resolve(null),
        needMacroFlood ? loadMacroFlood(coords, signal, floodSrc) : Promise.resolve(null)
      ];
      const [cv, water192, canopyOk, windObj, macroFlood] = await Promise.all(tasks);
      if (signal.aborted || tile._dead || coords.z !== layer._tileZoom) {
        markTileCancelled(tile);
        done(null, tile);
        return;
      }
      if (!cv || cv._isEmptyFallback) {
        if (navigator.onLine === false) jobStats.offlineNoDem = true;
        markTileCompleted(tile);
        done(null, tile);
        return;
      }
      jobStats.offlineNoDem = false;

      if (needCanopy && !canopyOk) {
        jobStats.canopyFailed = true;
        markTileCompleted(tile);
        done(null, tile); // Тайл остаётся полностью прозрачным и не попадает в кэш
        return;
      }
      if (needCanopy) jobStats.canopyFailed = false;

      const tree192 = needCanopy ? extractCanopyGrid192(coords) : null;
      const windFromDeg = windObj ? windObj.dir : cfg.windShelter.windDir;

      handedToCompute = true;
      enqueueCompute({
        layerId,
        tile,
        coords,
        centerLL,
        cv,
        water192,
        tree192,
        windFromDeg,
        macroFlood,
        floodSrc,
        done
      });
    } catch (e) {
      if (e && e.name === 'AbortError') markTileCancelled(tile);
      else markTileCompleted(tile);
      done(null, tile);
    } finally {
      _activeFetches = Math.max(0, _activeFetches - 1);
      jobStats.pendingFetch = _activeFetches + _fetchQueue.length;
      if (!handedToCompute) {
        resetBatchIfIdle();
      }
      scheduleStatusUI();
      pumpFetchQueue();
    }
  }


  function enqueueCompute(task) {
    _computeQueue.push(task);
    jobStats.pendingCompute = _computeQueue.length;
    scheduleStatusUI();
    if (!_computeRaf) _computeRaf = requestAnimationFrame(pumpComputeQueue);
  }

  function pumpComputeQueue() {
    _computeRaf = 0;
    if (!_computeQueue.length || !map) {
      jobStats.pendingCompute = 0;
      resetBatchIfIdle();
      scheduleStatusUI();
      return;
    }

    const center = map.getCenter();
    const alive = [];
    for (let i = 0; i < _computeQueue.length; i++) {
      const t = _computeQueue[i];
      const layer = layers[t.layerId];
      if (!t.tile._dead && layer && map.hasLayer(layer) && t.coords.z === layer._tileZoom) {
        const ll = t.centerLL || center;
        const dy = ll.lat - center.lat, dx = ll.lng - center.lng;
        t.dist2 = dx * dx + dy * dy;
        alive.push(t);
      } else {
        markTileCancelled(t.tile);
        t.done(null, t.tile);
      }
    }
    _computeQueue.length = 0;

    if (!alive.length) {
      jobStats.pendingCompute = 0;
      resetBatchIfIdle();
      scheduleStatusUI();
      return;
    }

    alive.sort((a, b) => a.dist2 - b.dist2);

    const t0 = performance.now();
    let idx = 0;
    do {
      const task = alive[idx++];
      try {
        executeTileCompute(task);
      } catch (e) {}
      markTileCompleted(task.tile);
      task.done(null, task.tile);
    } while (idx < alive.length && (performance.now() - t0) < 10);

    for (let i = idx; i < alive.length; i++) _computeQueue.push(alive[i]);
    jobStats.pendingCompute = _computeQueue.length;
    resetBatchIfIdle();
    scheduleStatusUI();

    if (_computeQueue.length) {
      _computeRaf = requestAnimationFrame(pumpComputeQueue);
    }
  }

  const macroFloodCache = new Map();
  const macroFloodInFlight = new Map();

  async function loadMacroFlood(coords, signal = null, floodSrc = 'all') {
    if (!coords || coords.z < 10) return null;
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!WM.demRelief || typeof WM.demRelief.loadPaddedDemTile !== 'function') return null;

    const zMacro = Math.max(9, coords.z - 2);
    const shift = coords.z - zMacro;
    const mCoords = { z: zMacro, x: coords.x >> shift, y: coords.y >> shift };
    const demSrc = (WM.demRelief.getConfig && WM.demRelief.getConfig().demSource) || 'mapterhorn';
    const key = `${demSrc}:${floodSrc}:${mCoords.z}:${mCoords.x}:${mCoords.y}`;

    if (macroFloodCache.has(key)) return macroFloodCache.get(key);

    let p = macroFloodInFlight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const useOsm = (floodSrc === 'osm_rivers' || floodSrc === 'osm_all');
          const res = await Promise.race([
            Promise.all([
              WM.demRelief.loadPaddedDemTile(mCoords),
              useOsm ? loadPaddedOsmWaterMask(mCoords, floodSrc) : loadPaddedWaterMask(mCoords),
              // КАСКАД: макро-тайл сам получает приток от ещё более крупного уровня
              loadMacroFlood(mCoords, null, floodSrc)
            ]),
            new Promise(r => setTimeout(() => r(null), 12000))
          ]);
          if (!res) return null;
          const [mCv, mWater, mParent] = res;
          if (!mCv || mCv._isEmptyFallback) return null;
          const mH = extractDemGrid192(mCv);
          if (!mH) return null;

          const mFlood = computeFloodScalar(mH, mWater, mParent, mCoords, floodSrc);
          const parentOk = (mCoords.z < 10) || !!mParent;
          if (!mCv._degraded && mWater && !mWater.incomplete && parentOk) {
            if (macroFloodCache.size >= 48) macroFloodCache.delete(macroFloodCache.keys().next().value);
            macroFloodCache.set(key, mFlood);
          }
          return mFlood;
        } catch (e) {
          return null;
        } finally {
          macroFloodInFlight.delete(key);
        }
      })();
      macroFloodInFlight.set(key, p);
    }

    return raceWithAbort(p, signal);
  }


  function executeTileCompute(task) {
    const { layerId, tile, coords, cv, water192, tree192, windFromDeg, macroFlood, floodSrc } = task;
    if (tile._dead) return;
    const sKey = scalarKeyFor(layerId, coords);
    let scalar = scalarCaches[layerId].get(sKey);

    if (!scalar) {
      if (layerId === 'steep') {
        scalar = computeSteepScalar(cv, coords);
      } else {
        const H192 = extractDemGrid192(cv);
        if (!H192) return;
        if (layerId === 'camp') scalar = computeCampScalar(H192, water192, tree192, coords);
        else if (layerId === 'windShelter') scalar = computeWindShelterScalar(H192, tree192, coords, windFromDeg, cfg.windShelter.useForest);
        else if (layerId === 'solar') scalar = computeSolarScalar(H192, tree192, coords, getEffectiveSolarDateStr(), cfg.solar.useForestShade);
        else if (layerId === 'flood') scalar = computeFloodScalar(H192, water192, macroFlood, coords, floodSrc || cfg.flood.sourceMode || 'all');
      }

      // Не кэшируем результат, если DEM или маска воды загрузились с ошибкой/неполностью
      const waterBroken = (layerId === 'flood' || layerId === 'camp') && (!water192 || water192.incomplete);
      const macroBroken = (layerId === 'flood' && coords.z >= 10 && !macroFlood && navigator.onLine !== false);
      if (scalar && !cv._degraded && !waterBroken && !macroBroken) {
        setScalarCache(layerId, sKey, scalar);
      }
    }

    if (!scalar) return;
    tile._scalarKey = sKey;
    paintTileWithScalar(layerId, tile, scalar);
  }

  function paintTileWithScalar(layerId, tile, scalar) {
    if (layerId === 'steep') paintSteep(tile, scalar);
    else if (layerId === 'camp') paintCamp(tile, scalar);
    else if (layerId === 'windShelter') paintWindShelter(tile, scalar);
    else if (layerId === 'solar') paintSolar(tile, scalar);
    else if (layerId === 'flood') paintFlood(tile, scalar);
  }

  // =========================================================================
  // 7. LEAFLET GRID LAYERS (ПО ОДНОМУ НА СЛОЙ)
  // =========================================================================
  let map = null;
  const layers = {};
  const LAYER_ZINDEX = {
    flood: 1,
    solar: 2,
    windShelter: 3,
    camp: 4,
    steep: 5
  };

  function createOverlayGridLayer(layerId) {
    const GridCls = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        tile.width = TILE;
        tile.height = TILE;

        const nw = coords.scaleBy(this.getTileSize());
        const centerLL = this._map.unproject(nw.add([128, 128]), coords.z);

        // 1. Быстрая проверка скалярного кэша — мгновенная отрисовка без очереди
        const sKey = scalarKeyFor(layerId, coords);
        const cachedScalar = scalarCaches[layerId].get(sKey);
        if (cachedScalar) {
          tile._scalarKey = sKey;
          paintTileWithScalar(layerId, tile, cachedScalar);
          setTimeout(() => done(null, tile), 0);
          return tile;
        }

        // 2. Постановка в приоритетную очередь загрузки с отменой
        const ctl = new AbortController();
        tile._abortCtl = ctl;
        tile._counted = true;
        jobStats.totalBatch++;

        _fetchQueue.push({
          layerId,
          tile,
          coords,
          centerLL,
          signal: ctl.signal,
          done
        });
        jobStats.pendingFetch = _activeFetches + _fetchQueue.length;
        pumpFetchQueue();

        return tile;
      },

      _removeTile(key) {
        const tile = this._tiles[key]?.el;
        if (tile) {
          tile._dead = true;
          if (tile._abortCtl) tile._abortCtl.abort();
          markTileCancelled(tile);
          tile.width = 0;
          tile.height = 0;
        }
        L.GridLayer.prototype._removeTile.call(this, key);
        pruneDeadFetchTasks();
        resetBatchIfIdle();
        scheduleStatusUI();
      }
    });

    return new GridCls({
      pane: 'wm-terrain-overlays-pane',
      minZoom: 9,
      maxNativeZoom: 15,
      maxZoom: 20,
      zIndex: LAYER_ZINDEX[layerId] || 1,
      opacity: cfg[layerId].opacity,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1
    });
  }

  function ensureLayerInstance(layerId) {
    if (!layers[layerId]) {
      layers[layerId] = createOverlayGridLayer(layerId);
      layers[layerId].on('add', () => applyLayerStyle(layerId));
    }
    return layers[layerId];
  }

  function applyLayerStyle(layerId) {
    const l = layers[layerId];
    if (!l) return;
    l.setOpacity(cfg[layerId].opacity);
    const cont = l.getContainer();
    if (cont && cfg[layerId].blendMode) {
      cont.style.mixBlendMode = cfg[layerId].blendMode;
    }
  }

  function syncLayerOnMap(layerId) {
    if (!map) return;
    const isOn = !!cfg[layerId].enabled;
    if (isOn) {
      const l = ensureLayerInstance(layerId);
      if (!map.hasLayer(l)) l.addTo(map);
      applyLayerStyle(layerId);
    } else if (layers[layerId] && map.hasLayer(layers[layerId])) {
      map.removeLayer(layers[layerId]);
    }
  }

  function repaintLayerFromCache(layerId) {
    const l = layers[layerId];
    if (!l || !l._tiles || !map || !map.hasLayer(l)) return;
    let miss = false;
    for (const k in l._tiles) {
      const entry = l._tiles[k];
      const tile = entry && entry.el;
      if (!tile || tile._dead || !entry.coords) continue;
      const sKey = scalarKeyFor(layerId, entry.coords);
      const scalar = scalarCaches[layerId].get(sKey);
      if (scalar) {
        tile._scalarKey = sKey;
        paintTileWithScalar(layerId, tile, scalar);
      } else {
        miss = true;
      }
    }
    if (miss) l.redraw();
  }

  let _redrawTimers = {};
  function redrawCanopyDependentLayers(clearCaches = true) {
    const ids = [
      cfg.camp.enabled && cfg.camp.avoidForest ? 'camp' : null,
      cfg.windShelter.enabled && cfg.windShelter.useForest ? 'windShelter' : null,
      cfg.solar.enabled && cfg.solar.useForestShade ? 'solar' : null
    ].filter(Boolean);

    jobStats.canopyFailed = false;
    ids.forEach(id => {
      if (clearCaches) scalarCaches[id].clear();
      if (layers[id] && map && map.hasLayer(layers[id])) {
        layers[id].redraw();
      }
    });
    scheduleStatusUI();
  }
  function invalidateAndRedraw(layerId, delayMs = 90) {
    scalarCaches[layerId].clear();
    clearTimeout(_redrawTimers[layerId]);
    _redrawTimers[layerId] = setTimeout(() => {
      if (layers[layerId] && map && map.hasLayer(layers[layerId]) && cfg[layerId].enabled) {
        layers[layerId].redraw();
      }
    }, delayMs);
  }

  // =========================================================================
  // 8. ИНДИКАТОРЫ СОСТОЯНИЯ ЗАГРУЗКИ И СТИЛИ UI
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById('wm-terrain-overlays-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-terrain-overlays-style';
    st.textContent = `
      .to-status-bar {
        padding: 7px 9px;
        border-radius: 8px;
        background: var(--bg-secondary, #1e293b);
        border: 1px solid var(--border, rgba(255,255,255,0.12));
        font-size: 11px;
        color: var(--text-muted, #94a3b8);
      }
      .to-status-bar.is-busy {
        border-color: var(--accent, #3b82f6);
        color: var(--text-main, #f1f5f9);
      }
      .to-status-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .to-progress-track {
        height: 5px;
        border-radius: 4px;
        background: var(--bg-primary, #0f172a);
        border: 1px solid var(--border, rgba(255,255,255,0.1));
        overflow: hidden;
        margin-top: 5px;
      }
      .to-progress-fill {
        height: 100%;
        width: 0%;
        background: var(--accent, #3b82f6);
        transition: width 0.15s ease;
      }
      .to-mini-info {
        padding: 5px 8px;
        border-radius: 6px;
        background: var(--bg-secondary, #1e293b);
        border-left: 3px solid var(--accent, #3b82f6);
        font-size: 10.5px;
        line-height: 1.35;
        color: var(--text-muted, #cbd5e1);
      }
      .to-chips-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 2px;
      }
      .to-flood-chip {
        border: 1px solid var(--border, rgba(255,255,255,0.15));
        background: var(--bg-primary, #0f172a);
        color: var(--text-main, #f1f5f9);
        border-radius: 99px;
        padding: 2px 8px;
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .to-flood-chip.active {
        border-color: var(--accent, #3b82f6);
        background: rgba(59, 130, 246, 0.22);
        color: var(--accent, #60a5fa);
      }
      .to-floating-loader {
        position: fixed;
        top: 56px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1200;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.90);
        color: #f8fafc;
        border: 1px solid rgba(56, 189, 248, 0.45);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
        font-size: 11.5px;
        font-weight: 600;
        pointer-events: none;
        backdrop-filter: blur(6px);
      }
      .to-floating-loader[hidden] {
        display: none !important;
      }
      .to-spinner {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        border: 2px solid rgba(56, 189, 248, 0.3);
        border-top-color: #38bdf8;
        animation: toSpin 0.8s linear infinite;
        flex-shrink: 0;
      }
      @keyframes toSpin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(st);
  }

  let floatingPillEl = null;
  function ensureFloatingPill() {
    if (floatingPillEl) return floatingPillEl;
    if (!document.body) return null;
    floatingPillEl = document.createElement('div');
    floatingPillEl.id = 'to-floating-loader';
    floatingPillEl.className = 'to-floating-loader';
    floatingPillEl.hidden = true;
    floatingPillEl.innerHTML = `<span class="to-spinner"></span><span id="to-floating-loader-text">Анализ слоёв…</span>`;
    document.body.appendChild(floatingPillEl);
    return floatingPillEl;
  }

  function renderProgressUI() {
    const activeIds = Object.keys(cfg).filter(k => cfg[k].enabled);
    const activeCount = activeIds.length;
    const isBusy = jobStats.pendingFetch > 0 || jobStats.pendingCompute > 0;
    const zoom = map ? Math.round(map.getZoom()) : 14;

    const badge = document.getElementById('dem-hud-overlays-status-badge');
    if (badge) {
      if (isBusy) {
        badge.textContent = '⏳ Расчёт';
        badge.classList.add('active');
      } else {
        badge.textContent = activeCount ? `${activeCount} вкл` : 'Выкл';
        badge.classList.toggle('active', activeCount > 0);
      }
    }

    const bar = document.getElementById('to-status-bar');
    const txt = document.getElementById('to-status-text');
    const track = document.getElementById('to-progress-track');
    const fill = document.getElementById('to-progress-fill');
    const btnOffAll = document.getElementById('btn-to-disable-all');

    if (btnOffAll) btnOffAll.hidden = activeCount === 0;
    if (bar) bar.classList.toggle('is-busy', isBusy);

    let msg = '';
    if (!activeCount) {
      msg = 'Выберите нужные слои анализа ниже';
    } else if (zoom < 9) {
      msg = '🔍 Приблизьте карту (зум 9+) для отображения слоёв';
    } else if (isBusy) {
      const total = Math.max(1, jobStats.totalBatch);
      const done = Math.min(total, jobStats.doneBatch);
      const pct = Math.round((done / total) * 100);
      const cTag = hasActiveCanopyOverlay() ? ` (лес ${getCanopyVer().toUpperCase()})` : '';
      msg = `⏳ Обработка данных${cTag}: ${done}/${total} (${pct}%)`;
      if (track) track.hidden = false;
      if (fill) fill.style.width = `${pct}%`;
    } else if (jobStats.canopyFailed && hasActiveCanopyOverlay()) {
      msg = '⚠️ Данные леса (v1 и v2) недоступны — тайлы не показаны';
    } else if (jobStats.offlineNoDem) {
      msg = '📵 Оффлайн: нет кэша DEM для этого участка';
    } else {
      const cTag = hasActiveCanopyOverlay() ? ` · Лес ${getCanopyVer().toUpperCase()}` : '';
      msg = `✅ Активно слоёв: ${activeCount}${cTag}` + (navigator.onLine === false ? ' (оффлайн-кэш)' : '');
    }

    if (!isBusy && track) track.hidden = true;
    if (txt) txt.textContent = msg;

    const pill = ensureFloatingPill();
    if (pill) {
      if (isBusy && activeCount > 0 && zoom >= 9) {
        pill.hidden = false;
        const pTxt = document.getElementById('to-floating-loader-text');
        if (pTxt) {
          const total = Math.max(1, jobStats.totalBatch);
          const done = Math.min(total, jobStats.doneBatch);
          pTxt.textContent = `Анализ местности: ${done}/${total}…`;
        }
      } else {
        pill.hidden = true;
      }
    }
  }

  function updateWindInfoText() {
    const el = document.getElementById('to-wind-wx-info');
    if (!el) return;
    if (cfg.windShelter.windSource === 'manual') {
      el.innerHTML = `Вручную: ветер с <b>${Math.round(cfg.windShelter.windDir)}°</b> · <b>${Number(cfg.windShelter.windSpeed).toFixed(1)} м/с</b>`;
      return;
    }
    const w = activeAutoWind;
    const srcMap = {
      online: 'Open-Meteo',
      cache: 'Open-Meteo (кэш)',
      'offline-cache': 'оффлайн-кэш погоды',
      'offline-default': 'оффлайн (по умолчанию)',
      fallback: 'по умолчанию'
    };
    el.innerHTML = `Ветер (${srcMap[w.source] || 'авто'}): <b>${Math.round(w.dir)}°</b> · <b>${Number(w.speed).toFixed(1)} м/с</b>`;
  }

  // =========================================================================
  // 9. СИНХРОНИЗАЦИЯ И ПРИВЯЗКА UI
  // =========================================================================
  function syncLayerToggleUI(id, badgeId, quickBtnId, chkId, subId) {
    const on = !!cfg[id].enabled;
    const badge = document.getElementById(badgeId);
    if (badge) {
      badge.textContent = on ? 'Вкл' : 'Выкл';
      badge.classList.toggle('active', on);
    }
    const qBtn = document.getElementById(quickBtnId);
    if (qBtn) {
      qBtn.textContent = on ? 'Выкл' : 'Вкл';
      qBtn.classList.toggle('active', on);
    }
    const chk = document.getElementById(chkId);
    if (chk) chk.checked = on;
    const sub = document.getElementById(subId);
    if (sub) sub.classList.toggle('is-disabled', !on);
  }

  function renderUI() {
    syncLayerToggleUI('steep', 'to-steep-badge', 'btn-to-steep-quick', 'to-steep-enable', 'to-steep-sub');
    syncLayerToggleUI('camp', 'to-camp-badge', 'btn-to-camp-quick', 'to-camp-enable', 'to-camp-sub');
    syncLayerToggleUI('windShelter', 'to-wind-badge', 'btn-to-wind-quick', 'to-wind-enable', 'to-wind-sub');
    syncLayerToggleUI('solar', 'to-solar-badge', 'btn-to-solar-quick', 'to-solar-enable', 'to-solar-sub');
    syncLayerToggleUI('flood', 'to-flood-badge', 'btn-to-flood-quick', 'to-flood-enable', 'to-flood-sub');

    const setV = (id, v) => { const e = document.getElementById(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } };
    const setT = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

    // Steep
    setV('to-steep-min-angle', cfg.steep.minAngle);
    setT('to-steep-min-angle-val', `${cfg.steep.minAngle}°`);
    setV('to-steep-color', cfg.steep.color);
    setV('to-steep-cliff-color', cfg.steep.cliffColor);
    setV('to-steep-opacity', Math.round(cfg.steep.opacity * 100));
    setT('to-steep-opacity-val', `${Math.round(cfg.steep.opacity * 100)}%`);
    setV('to-steep-blend', cfg.steep.blendMode);

    // Camp
    setV('to-camp-max-slope', cfg.camp.maxSlope);
    setT('to-camp-max-slope-val', `${cfg.camp.maxSlope}°`);
    setV('to-camp-flatness', cfg.camp.flatness);
    setV('to-camp-avoid-forest', cfg.camp.avoidForest);
    setV('to-camp-avoid-water', cfg.camp.avoidWaterBuffer);
    setV('to-camp-color', cfg.camp.color);
    setV('to-camp-opacity', Math.round(cfg.camp.opacity * 100));
    setT('to-camp-opacity-val', `${Math.round(cfg.camp.opacity * 100)}%`);

    // Wind
    setV('to-wind-source', cfg.windShelter.windSource);
    const wMan = document.getElementById('to-wind-manual-wrap');
    if (wMan) wMan.hidden = cfg.windShelter.windSource !== 'manual';
    setV('to-wind-dir', cfg.windShelter.windDir);
    setT('to-wind-dir-val', `${Math.round(cfg.windShelter.windDir)}°`);
    setV('to-wind-speed', cfg.windShelter.windSpeed);
    setT('to-wind-speed-val', `${Number(cfg.windShelter.windSpeed).toFixed(1)} м/с`);
    setV('to-wind-min-shelter', cfg.windShelter.minShelter);
    setT('to-wind-min-shelter-val', `${cfg.windShelter.minShelter}%`);
    setV('to-wind-use-forest', cfg.windShelter.useForest);
    setV('to-wind-color', cfg.windShelter.color);
    setV('to-wind-opacity', Math.round(cfg.windShelter.opacity * 100));
    setT('to-wind-opacity-val', `${Math.round(cfg.windShelter.opacity * 100)}%`);
    updateWindInfoText();

    // Solar
    setV('to-solar-date', getEffectiveSolarDateStr());
    setV('to-solar-min-light', cfg.solar.minLight);
    setT('to-solar-min-light-val', `${cfg.solar.minLight}%`);
    setV('to-solar-use-forest', cfg.solar.useForestShade);
    setV('to-solar-color', cfg.solar.color);
    setV('to-solar-opacity', Math.round(cfg.solar.opacity * 100));
    setT('to-solar-opacity-val', `${Math.round(cfg.solar.opacity * 100)}%`);

    // Flood
    setV('to-flood-level', cfg.flood.floodLevelM);
    setT('to-flood-level-val', `+${Number(cfg.flood.floodLevelM).toFixed(1)} м`);
    setV('to-flood-source', cfg.flood.sourceMode || 'all');
    setV('to-flood-level', cfg.flood.floodLevelM);
    document.querySelectorAll('.to-flood-chip').forEach(ch => {
      ch.classList.toggle('active', Math.abs(parseFloat(ch.dataset.lvl) - cfg.flood.floodLevelM) < 0.05);
    });
    setV('to-flood-show-water', cfg.flood.showExistingWater);
    setV('to-flood-shallow-color', cfg.flood.shallowColor);
    setV('to-flood-color', cfg.flood.color);
    setV('to-flood-opacity', Math.round(cfg.flood.opacity * 100));
    setT('to-flood-opacity-val', `${Math.round(cfg.flood.opacity * 100)}%`);


    renderProgressUI();
    if (window.syncLayersControlExtras) {
      window.syncLayersControlExtras();
    }

  }

  function toggleLayer(layerId, forceState) {
    const next = forceState !== undefined ? !!forceState : !cfg[layerId].enabled;
    cfg[layerId].enabled = next;
    if (!hasActiveCanopyOverlay() || next) {
      jobStats.canopyFailed = false;
    }
    saveConfig();
    syncLayerOnMap(layerId);
    renderUI();
  }

  function bindUIEvents() {
    const root = document.getElementById('spoiler-hud-overlays');
    if (!root || root._toBound) return;
    root._toBound = true;

    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };

    const bindQuickBtn = (btnId, spoilerId, layerId) => {
      on(btnId, 'click', e => {
        e.preventDefault();
        e.stopPropagation();
        const willEnable = !cfg[layerId].enabled;
        toggleLayer(layerId, willEnable);
        if (willEnable) {
          const sp = document.getElementById(spoilerId);
          if (sp) sp.open = true;
        }
      });
    };

    bindQuickBtn('btn-to-steep-quick', 'spoiler-to-steep', 'steep');
    bindQuickBtn('btn-to-camp-quick', 'spoiler-to-camp', 'camp');
    bindQuickBtn('btn-to-wind-quick', 'spoiler-to-wind', 'windShelter');
    bindQuickBtn('btn-to-solar-quick', 'spoiler-to-solar', 'solar');
    bindQuickBtn('btn-to-flood-quick', 'spoiler-to-flood', 'flood');

    on('to-steep-enable', 'change', e => toggleLayer('steep', e.target.checked));
    on('to-camp-enable', 'change', e => toggleLayer('camp', e.target.checked));
    on('to-wind-enable', 'change', e => toggleLayer('windShelter', e.target.checked));
    on('to-solar-enable', 'change', e => toggleLayer('solar', e.target.checked));
    on('to-flood-enable', 'change', e => toggleLayer('flood', e.target.checked));

    on('btn-to-disable-all', 'click', () => {
      Object.keys(cfg).forEach(k => {
        cfg[k].enabled = false;
        syncLayerOnMap(k);
      });
      saveConfig();
      renderUI();
    });

    // 1. Крутые склоны
    on('to-steep-min-angle', 'input', e => {
      cfg.steep.minAngle = parseInt(e.target.value, 10);
      document.getElementById('to-steep-min-angle-val').textContent = `${cfg.steep.minAngle}°`;
      saveConfig();
      repaintLayerFromCache('steep');
    });
    on('to-steep-color', 'input', e => { cfg.steep.color = e.target.value; saveConfig(); repaintLayerFromCache('steep'); });
    on('to-steep-cliff-color', 'input', e => { cfg.steep.cliffColor = e.target.value; saveConfig(); repaintLayerFromCache('steep'); });
    on('to-steep-opacity', 'input', e => {
      cfg.steep.opacity = parseInt(e.target.value, 10) / 100;
      document.getElementById('to-steep-opacity-val').textContent = `${e.target.value}%`;
      saveConfig();
      applyLayerStyle('steep');
    });
    on('to-steep-blend', 'change', e => { cfg.steep.blendMode = e.target.value; saveConfig(); applyLayerStyle('steep'); });

    // 2. Места под палатку
    on('to-camp-max-slope', 'input', e => {
      cfg.camp.maxSlope = parseFloat(e.target.value);
      document.getElementById('to-camp-max-slope-val').textContent = `${cfg.camp.maxSlope}°`;
      saveConfig();
      repaintLayerFromCache('camp');
    });
    on('to-camp-flatness', 'change', e => { cfg.camp.flatness = e.target.value; saveConfig(); repaintLayerFromCache('camp'); });
    on('to-camp-avoid-forest', 'change', e => {
      cfg.camp.avoidForest = !!e.target.checked;
      saveConfig();
      invalidateAndRedraw('camp');
    });
    on('to-camp-avoid-water', 'change', e => { cfg.camp.avoidWaterBuffer = !!e.target.checked; saveConfig(); repaintLayerFromCache('camp'); });
    on('to-camp-color', 'input', e => { cfg.camp.color = e.target.value; saveConfig(); repaintLayerFromCache('camp'); });
    on('to-camp-opacity', 'input', e => {
      cfg.camp.opacity = parseInt(e.target.value, 10) / 100;
      document.getElementById('to-camp-opacity-val').textContent = `${e.target.value}%`;
      saveConfig();
      applyLayerStyle('camp');
    });

    // 3. Защита от ветра
    on('to-wind-source', 'change', e => {
      cfg.windShelter.windSource = e.target.value;
      saveConfig();
      renderUI();
      invalidateAndRedraw('windShelter', 80);
    });
    on('to-wind-dir', 'input', e => {
      cfg.windShelter.windDir = parseInt(e.target.value, 10);
      document.getElementById('to-wind-dir-val').textContent = `${cfg.windShelter.windDir}°`;
      updateWindInfoText();
      saveConfig();
      invalidateAndRedraw('windShelter', 150);
    });
    on('to-wind-speed', 'input', e => {
      cfg.windShelter.windSpeed = parseFloat(e.target.value);
      document.getElementById('to-wind-speed-val').textContent = `${cfg.windShelter.windSpeed.toFixed(1)} м/с`;
      updateWindInfoText();
      saveConfig();
    });
    on('to-wind-min-shelter', 'input', e => {
      cfg.windShelter.minShelter = parseInt(e.target.value, 10);
      document.getElementById('to-wind-min-shelter-val').textContent = `${cfg.windShelter.minShelter}%`;
      saveConfig();
      repaintLayerFromCache('windShelter');
    });
    on('to-wind-use-forest', 'change', e => {
      cfg.windShelter.useForest = !!e.target.checked;
      saveConfig();
      invalidateAndRedraw('windShelter', 80);
    });
    on('to-wind-color', 'input', e => { cfg.windShelter.color = e.target.value; saveConfig(); repaintLayerFromCache('windShelter'); });
    on('to-wind-opacity', 'input', e => {
      cfg.windShelter.opacity = parseInt(e.target.value, 10) / 100;
      document.getElementById('to-wind-opacity-val').textContent = `${e.target.value}%`;
      saveConfig();
      applyLayerStyle('windShelter');
    });

    // 4. Накопление света
    on('to-solar-date', 'change', e => {
      cfg.solar.dateMode = 'custom';
      cfg.solar.dateStr = e.target.value || getTodayStr();
      saveConfig();
      invalidateAndRedraw('solar', 80);
    });
    root.querySelectorAll('.to-solar-season-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        cfg.solar.dateMode = btn.dataset.season;
        cfg.solar.dateStr = getEffectiveSolarDateStr();
        const inp = document.getElementById('to-solar-date');
        if (inp) inp.value = cfg.solar.dateStr;
        saveConfig();
        invalidateAndRedraw('solar', 80);
      });
    });
    on('to-solar-min-light', 'input', e => {
      cfg.solar.minLight = parseInt(e.target.value, 10);
      document.getElementById('to-solar-min-light-val').textContent = `${cfg.solar.minLight}%`;
      saveConfig();
      repaintLayerFromCache('solar');
    });
    on('to-solar-use-forest', 'change', e => {
      cfg.solar.useForestShade = !!e.target.checked;
      saveConfig();
      invalidateAndRedraw('solar', 80);
    });
    on('to-solar-color', 'input', e => { cfg.solar.color = e.target.value; saveConfig(); repaintLayerFromCache('solar'); });
    on('to-solar-opacity', 'input', e => {
      cfg.solar.opacity = parseInt(e.target.value, 10) / 100;
      document.getElementById('to-solar-opacity-val').textContent = `${e.target.value}%`;
      saveConfig();
      applyLayerStyle('solar');
    });

    // 5. Разлив рек
     on('to-flood-source', 'change', e => {
      cfg.flood.sourceMode = e.target.value;
      saveConfig();
      invalidateAndRedraw('flood', 60);
    });
    on('to-flood-level', 'input', e => {
      cfg.flood.floodLevelM = parseFloat(e.target.value);
      document.getElementById('to-flood-level-val').textContent = `+${cfg.flood.floodLevelM.toFixed(1)} м`;
      document.querySelectorAll('.to-flood-chip').forEach(ch => {
        ch.classList.toggle('active', Math.abs(parseFloat(ch.dataset.lvl) - cfg.flood.floodLevelM) < 0.05);
      });
      saveConfig();
      repaintLayerFromCache('flood');
    });
    root.querySelectorAll('.to-flood-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        cfg.flood.floodLevelM = parseFloat(ch.dataset.lvl);
        saveConfig();
        renderUI();
        repaintLayerFromCache('flood');
      });
    });
    on('to-flood-show-water', 'change', e => { cfg.flood.showExistingWater = !!e.target.checked; saveConfig(); repaintLayerFromCache('flood'); });
    on('to-flood-shallow-color', 'input', e => { cfg.flood.shallowColor = e.target.value; saveConfig(); repaintLayerFromCache('flood'); });
    on('to-flood-color', 'input', e => { cfg.flood.color = e.target.value; saveConfig(); repaintLayerFromCache('flood'); });
    on('to-flood-opacity', 'input', e => {
      cfg.flood.opacity = parseInt(e.target.value, 10) / 100;
      document.getElementById('to-flood-opacity-val').textContent = `${e.target.value}%`;
      saveConfig();
      applyLayerStyle('flood');
    });
  }

  // =========================================================================
  // 10. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
  // =========================================================================
  function init(mapInstance) {
    if (!mapInstance || map === mapInstance) return;
    map = mapInstance;

    loadConfig();
    loadWxCacheFromLS();
    ensureStyles();
    ensureFloatingPill();

    if (!map.getPane('wm-terrain-overlays-pane')) {
      map.createPane('wm-terrain-overlays-pane');
      map.getPane('wm-terrain-overlays-pane').style.zIndex = 278;
    }

    bindUIEvents();
    renderUI();

    Object.keys(cfg).forEach(k => {
      if (cfg[k].enabled) syncLayerOnMap(k);
    });

    map.on('zoomend moveend', () => {
      pruneDeadFetchTasks();
      pumpFetchQueue();
      scheduleStatusUI();
    });

    window.addEventListener('online', () => {
      jobStats.canopyFailed = false;
      canopyAreaInFlight.clear();
      Object.keys(cfg).forEach(k => {
        if (cfg[k].enabled) {
          invalidateAndRedraw(k, 200);
        }
      });
    });

    window.addEventListener('wm:canopy-version-change', () => {
      if (_internalCanopySwitch) return;
      canopyAreaInFlight.clear();
      _lastCanopySwitchAt = Date.now();
      redrawCanopyDependentLayers(true);
    });
  }

  function clearCache() {
    Object.values(scalarCaches).forEach(m => m.clear());
    paddedWaterCache.clear();
    paddedOsmWaterCache.clear();
    macroFloodCache.clear();
    Object.keys(cfg).forEach(k => {
      if (cfg[k].enabled && layers[k] && map && map.hasLayer(layers[k])) {
        layers[k].redraw();
      }
    });
  }

  // Автоинициализация: сработает и при подключении только <script src="js/terrainOverlays.js">, и при явном init()
  function autoBoot() {
    ensureStyles();
    bindUIEvents();
    loadConfig();
    renderUI();

    let attempts = 0;
    const tryAttach = () => {
      if (WM.map && !map) {
        init(WM.map);
        return;
      }
      if (!map && attempts++ < 80) {
        setTimeout(tryAttach, 150);
      }
    };
    tryAttach();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBoot);
  } else {
    autoBoot();
  }

  function applyProfile(profileObj) {
    const next = structuredCloneSafe(DEFAULT_CFG);
    if (profileObj && typeof profileObj === 'object' && profileObj.enabled !== false) {
      Object.keys(DEFAULT_CFG).forEach(k => {
        if (profileObj[k] && typeof profileObj[k] === 'object') {
          Object.assign(next[k], profileObj[k]);
        }
      });
    }
    cfg = next;
    if (!cfg.solar.dateStr) cfg.solar.dateStr = getTodayStr();
    saveConfig();
    jobStats.canopyFailed = false;
    Object.keys(cfg).forEach(k => {
      syncLayerOnMap(k);
      applyLayerStyle(k);
    });
    clearCache();
    renderUI();
  }

  WM.terrainOverlays = {
    init,
    toggleLayer,
    applyProfile,
    getConfig: () => structuredCloneSafe(cfg),
    clearCache,
    refreshUI: () => { bindUIEvents(); renderUI(); }
  };
})();