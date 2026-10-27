(function () {
  const WM = window.WM = window.WM || {};

  const DEM_SOURCES = {
    mapterhorn: {
      id: 'mapterhorn',
      name: 'Mapterhorn (Copernicus 30m + LiDAR)',
      urls: [
        'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
      ]
    },
    aws: {
      id: 'aws',
      name: 'AWS Terrarium (Mapzen / Nextzen)',
      urls: [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        'https://tile.nextzen.org/tilezen/elevation/v1/terrarium/{z}/{x}/{y}.png'
      ]
    }
  };

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
    const k = lat + ',' + lng;
    if (k === _tzLookupKey) return _tzLookupVal;
    const v = tzlookup(lat, lng);
    _tzLookupKey = k;
    _tzLookupVal = v;
    return v;
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
      const { y, m, d } = this._ymd(date);
      
      // Географический базовый пояс точки
      let tzOffsetHours = Math.round(lng / 15);

      // Проверяем точную таймзону (библиотека tz-lookup)
      let tzName = tzLookupCached(lat, lng);

      // Проверяем кэш погоды ТОЛЬКО если он совпадает с текущими координатами!
      const currentKey = `${lat.toFixed(1)}_${lng.toFixed(1)}`;
      if (WM.weather && WM.weather.getCacheKey && WM.weather.getCacheKey() === currentKey) {
        const cache = WM.weather.getCache();
        if (cache?.utc_offset_seconds != null) {
          tzOffsetHours = cache.utc_offset_seconds / 3600;
          tzName = cache.timezone || tzName;
        }
      } else if (tzName) {
        // Смещение в часах через Intl для найденной IANA таймзоны (кэш на 60 с)
        const nowMs = Date.now();
        let memo = _tzOffsetMemo.get(tzName);
        if (!memo || nowMs - memo.t > 60000) {
          let off = null;
          try {
            const str = new Date(nowMs).toLocaleString('en-US', { timeZone: tzName, timeZoneName: 'shortOffset' });
            const match = str.match(/GMT([+-]\d+)(?::(\d+))?/);
            if (match) {
              off = parseInt(match[1], 10) + (match[2] ? parseInt(match[2], 10) / 60 : 0);
            }
          } catch (e) {}
          memo = { t: nowMs, off };
          _tzOffsetMemo.set(tzName, memo);
        }
        if (memo.off !== null) tzOffsetHours = memo.off;
      }
      
      // Истинное UTC-время для заданного местного часа в этой точке
      const targetUtcMs = Date.UTC(y, m, d, Math.floor(hour), Math.round((hour % 1) * 60)) - tzOffsetHours * 3600000;
      return new Date(targetUtcMs);
    }
  };

  const DEFAULT_CONFIG = {
    demSource: 'mapterhorn',
    hillshadeEnabled: true,
    blendMode: 'hard-light',
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
    formLinesEnabled: true,
    formLinesSlopeMax: 0.035,

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
    manualValleyColor: '#a8863e',
    manualShadowColor: '#456327',
    manualLightBlend: 0.3,

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
    hachureThinning: 0.6,
    hachureOpacity: 0.55,
    hachureSlope: 0.12,
    hachureColor: '#6f4020',
    hachureLightMod: 1,
    hachureLength: 1,
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
    contoursEnabled: true,
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
    outlineRoughness: 1,
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

  function flushConfig() {
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

  function registerTileElevation(coords, minH, maxH) {
    if (!coords) return;
    const key = `${coords.z}:${coords.x}:${coords.y}`;
    activeTileElevations.set(key, { minH, maxH, z: coords.z, x: coords.x, y: coords.y });
    if (activeTileElevations.size > 200) {
      const oldest = activeTileElevations.keys().next().value;
      activeTileElevations.delete(oldest);
    }
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
    const z = (currentZoom !== undefined) ? currentZoom : WM.map.getZoom();
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
        if (stat) {
          if (stat.minH < vMin) vMin = stat.minH;
          if (stat.maxH > vMax) vMax = stat.maxH;
          count++;
        }
      }
    }

    if (count > 0 && vMax > vMin + 1.0) {
      return { minH: vMin, maxH: vMax, span: vMax - vMin };
    }

    // Защита от сброса в 0 в горных районах:
    const fallbackMin = (lastViewportMinH !== null) ? lastViewportMinH : 300.0;
    const fallbackSpan = Math.max(100.0, currentRegionalSpan || 400.0);
    return { minH: fallbackMin, maxH: fallbackMin + fallbackSpan, span: fallbackSpan };
  }

  function onMapMoveEnd() {
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

  // Применение карандашной текстуры (микросмещение вдоль нормали сегментов)
  function applyPencilRoughness(points, roughness, iso) {
    if (roughness <= 0.01 || points.length < 2) return points;
    const res = new Array(points.length);
    const amp = roughness * 2.2;
    const isoSeed = (iso % 100) * 0.13;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let dx = 0, dy = 0;
      if (i === 0) {
        dx = points[1][0] - p[0];
        dy = points[1][1] - p[1];
      } else if (i === points.length - 1) {
        dx = p[0] - points[i - 1][0];
        dy = p[1] - points[i - 1][1];
      } else {
        dx = points[i + 1][0] - points[i - 1][0];
        dy = points[i + 1][1] - points[i - 1][1];
      }

      const len = Math.hypot(dx, dy) || 1.0;
      // Нормаль к касательной линии
      const nx = -dy / len;
      const ny = dx / len;

      const offset = (contourNoise(p[0] * 2.1, p[1] * 2.1, isoSeed) - 0.5) * 2.0 * amp;
      res[i] = [p[0] + nx * offset, p[1] + ny * offset];
    }
    return res;
  }

  // Отрисовка полилинии с переменным нажимом руки (Hand Pressure)
  function drawVariablePressurePolyline(ctx, poly, baseWidth, pressure, elevNorm, iso, isClosed) {
    const len = poly.length;
    if (len < 2) return;

    // Низины чуть жирнее, вершины легче:
    const elevFactor = clamp(1.0 + (1.0 - elevNorm * 2.0) * (pressure * 0.20), 0.8, 1.25);

    // Если нажим минимален — рисуем всю полилинию за 1 вызов stroke (макс. скорость)
    if (pressure <= 0.04) {
      ctx.lineWidth = Math.max(0.4, baseWidth * elevFactor);
      ctx.beginPath();
      drawSmoothContourPath(ctx, poly, isClosed);
      ctx.stroke();
      return;
    }

    // Разбиваем полилинию на связные фрагменты по 3-4 точки с плавной модуляцией ширины
    const CHUNK_SIZE = 3;
    let startIdx = 0;
    let distAlong = 0;
    const isoPhase = (iso % 50) * 0.35;

    while (startIdx < len - 1) {
      const endIdx = Math.min(len - 1, startIdx + CHUNK_SIZE);
      const midPt = poly[Math.floor((startIdx + endIdx) / 2)];

      // Плавная волнообразная вариация нажима от руки
      distAlong += Math.hypot(poly[endIdx][0] - poly[startIdx][0], poly[endIdx][1] - poly[startIdx][1]);
      const handWave = Math.sin(distAlong * 0.06 + isoPhase) * 0.45;
      const curWidth = Math.max(0.4, baseWidth * elevFactor * (1.0 + pressure * handWave));

      ctx.lineWidth = curWidth;
      ctx.beginPath();

      const chunk = poly.slice(startIdx, endIdx + 1);
      if (startIdx > 0 && chunk.length > 1) {
        // Плавный стык с предыдущим отрезком
        ctx.moveTo(poly[startIdx][0], poly[startIdx][1]);
      }
      drawSmoothContourPath(ctx, chunk, false);
      ctx.stroke();

      startIdx = endIdx;
    }
  }

  function drawSmoothContourPath(ctx, points, isClosed) {
    const len = points.length;
    if (len < 2) return;

    if (len === 2) {
      ctx.moveTo(points[0][0], points[0][1]);
      ctx.lineTo(points[1][0], points[1][1]);
      return;
    }

    if (isClosed) {
      // Для замкнутого контура: стартуем из середины между последней и первой точкой
      const startX = (points[len - 1][0] + points[0][0]) * 0.5;
      const startY = (points[len - 1][1] + points[0][1]) * 0.5;
      ctx.moveTo(startX, startY);

      for (let i = 0; i < len; i++) {
        const next = points[(i + 1) % len];
        const midX = (points[i][0] + next[0]) * 0.5;
        const midY = (points[i][1] + next[1]) * 0.5;
        ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
      }
    } else {
      // Для разомкнутого контура (выходящего за границы тайла)
      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < len - 1; i++) {
        const midX = (points[i][0] + points[i + 1][0]) * 0.5;
        const midY = (points[i][1] + points[i + 1][1]) * 0.5;
        ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
      }

      ctx.lineTo(points[len - 1][0], points[len - 1][1]);
    }
  }

  // =========================================================================
  // РЕНДЕР ГОРИЗОНТАЛЕЙ
  // =========================================================================
  function renderTileContours(paddedImg, zoom = 14, coords = null, centerLatLng = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const baseStrokeColor = (cfg.contourPalette === 'sepia') ? '#78350f' : (cfg.contourColor || '#b45309');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const P = paddedImg.width || 256;
    const S = paddedImg._tileSize || 256;
    const B = paddedImg._pad || 0;

    const pCtx = paddedImg.getContext('2d', { willReadFrequently: true });
    const data = paddedImg._demData || paddedImg.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, P, P).data;

    const COLS = 64;
    const ROWS = 64;
    const cellW = 256.0 / COLS;
    const cellH = 256.0 / ROWS;

    const PAD = 2;
    const gridW = COLS + 1 + PAD * 2;
    const gridH = ROWS + 1 + PAD * 2;
    const rawGrid = new Float32Array(gridW * gridH);

    let rawMin = Infinity, rawMax = -Infinity;
    let validCount = 0;

    for (let r = -PAD; r <= ROWS + PAD; r++) {
      const py = Math.min(P - 1, Math.max(0, Math.round(B + r * (S / ROWS))));
      const gRow = r + PAD;

      for (let c = -PAD; c <= COLS + PAD; c++) {
        const px = Math.min(P - 1, Math.max(0, Math.round(B + c * (S / COLS))));
        const gCol = c + PAD;
        const idx = (py * P + px) * 4;

        if (data[idx + 3] < 30) {
          rawGrid[gRow * gridW + gCol] = -99999;
          continue;
        }

        const h = (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
        if (h < -1000) {
          rawGrid[gRow * gridW + gCol] = -99999;
          continue;
        }

        rawGrid[gRow * gridW + gCol] = h;
        validCount++;
        if (h < rawMin) rawMin = h;
        if (h > rawMax) rawMax = h;
      }
    }

    if (validCount < 16 || rawMin === Infinity) return canvas;

    const smoothed = new Float32Array((COLS + 1) * (ROWS + 1));
    const K = [
      1,  4,  7,  4, 1,
      4, 16, 26, 16, 4,
      7, 26, 41, 26, 7,
      4, 16, 26, 16, 4,
      1,  4,  7,  4, 1
    ];

    let minH = Infinity, maxH = -Infinity;

    for (let r = 0; r <= ROWS; r++) {
      const rawR = r + PAD;
      for (let c = 0; c <= COLS; c++) {
        const rawC = c + PAD;
        const centerVal = rawGrid[rawR * gridW + rawC];

        if (centerVal < -1000) {
          smoothed[r * (COLS + 1) + c] = -99999;
          continue;
        }

        let acc = 0, wAcc = 0;
        for (let dr = -2; dr <= 2; dr++) {
          const nr = rawR + dr;
          for (let dc = -2; dc <= 2; dc++) {
            const val = rawGrid[nr * gridW + (rawC + dc)];
            if (val > -1000) {
              const weight = K[(dr + 2) * 5 + (dc + 2)];
              acc += val * weight;
              wAcc += weight;
            }
          }
        }

        const valSmoothed = wAcc > 0 ? (acc / wAcc) : centerVal;
        smoothed[r * (COLS + 1) + c] = valSmoothed;

        if (valSmoothed < minH) minH = valSmoothed;
        if (valSmoothed > maxH) maxH = valSmoothed;
      }
    }

    if (coords) registerTileElevation(coords, minH, maxH);

    const step = getEffectiveContourStep(zoom);

    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const baseW = Math.min(5.0, Math.max(0.5, cfg.contourWidth || 1.5));
    const labeledIso = new Set();

    const taperEnabled = !!cfg.taperWithElevation;
    const taperStrength = cfg.taperStrength !== undefined ? cfg.taperStrength : 0.60;
    const taperDir = cfg.taperDirection || 'crests';
    const isTanaka = cfg.contourStyle === 'tanaka';
    const useChaikin = cfg.contourSmoothing === 'chaikin' && !isTanaka;

    const vStats = getViewportElevationStats(zoom);
    const screenMin = (vStats.minH !== Infinity) ? vStats.minH : minH;
    const screenSpan = (vStats.span > 5.0) ? vStats.span : Math.max(40.0, maxH - minH);

    // Направление света нужно только стилю Tanaka
    let sunDir2D = null;
    if (isTanaka) {
      const cLat = centerLatLng ? centerLatLng.lat : 55.75;
      const cLng = centerLatLng ? centerLatLng.lng : 37.62;
      const sunLighting = getSunLighting(cLat, cLng);
      sunDir2D = normalizeVec3([sunLighting.sunVec[0], -sunLighting.sunVec[1], 0.0]);
    }

    const baseStep = getEffectiveContourStep(zoom);
    // Ширина ячейки в метрах постоянна для тайла — считаем один раз
    const cellMetersDen = Math.max(1.0, cellW * ((156543.03392 * Math.cos(((centerLatLng ? centerLatLng.lat : 55) * Math.PI) / 180)) / Math.pow(2, zoom)));
    const formSlopeMax = cfg.formLinesSlopeMax || 0.04;
    const useFormLines = !!cfg.formLinesEnabled;
    const loopStep = useFormLines ? (baseStep * 0.5) : baseStep;
    const startIso = Math.ceil(minH / loopStep) * loopStep;
    const firstContour = Math.max(loopStep, startIso);
    if (firstContour > maxH) return canvas;

    for (let iso = firstContour; iso <= maxH; iso += loopStep) {
      const isHalfStep = useFormLines && (Math.abs(iso % baseStep) > 0.001);
      const isMajor = !isHalfStep && (Math.round(iso / baseStep) % 5 === 0);
      let targetWidth = isMajor ? (baseW * 1.6) : (isHalfStep ? baseW * 0.75 : baseW);

      if (taperEnabled && taperStrength > 0.01) {
        const elevNorm = clamp((iso - screenMin) / screenSpan, 0.0, 1.0);
        // Ограничиваем раздувание снизу:
        const factor = (taperDir === 'crests') 
          ? (1.0 - elevNorm * taperStrength) 
          : ((1.0 - taperStrength) + elevNorm * taperStrength);
        targetWidth = Math.max(0.45, Math.min(baseW * 1.8, targetWidth * clamp(factor, 0.25, 1.25)));
      }

      const segments = [];
      let labelPlaced = false;

      for (let r = 0; r < ROWS; r++) {
        const y0 = r * cellH, y1 = (r + 1) * cellH;

        for (let c = 0; c < COLS; c++) {
          const x0 = c * cellW, x1 = (c + 1) * cellW;

          const tl = smoothed[r * (COLS + 1) + c];
          const tr = smoothed[r * (COLS + 1) + (c + 1)];
          const bl = smoothed[(r + 1) * (COLS + 1) + c];
          const br = smoothed[(r + 1) * (COLS + 1) + (c + 1)];

          if (tl < -1000 || tr < -1000 || bl < -1000 || br < -1000) continue;

          // ВОТ СЮДА ВСТАВЛЯТЬ:
          const cellMinH = Math.min(tl, tr, bl, br);
          const cellMaxH = Math.max(tl, tr, bl, br);
          if (cellMaxH - cellMinH < 0.05) continue;

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

          // Порог уклона в реальных тангенсах (например, 0.04 = уклон до 4%):
          if (isHalfStep && cellSlope > formSlopeMax) {
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

          if (cfg.showLabels && isMajor && !labelPlaced && !labeledIso.has(iso) && c > 18 && c < 46 && r > 18 && r < 46) {
            ctx.save();
            ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
            ctx.fillRect(x0 - 2, y0 - 5, 28, 11);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(Math.round(iso).toString(), x0 + 12, y0);
            ctx.restore();
            labelPlaced = true;
            labeledIso.add(iso);
          }
        }
      }
      if (!segments.length) continue;

      ctx.save();
      if (isHalfStep) {
        ctx.setLineDash([4, 4]); // Пунктир для полугоризонталей
        ctx.globalAlpha = (cfg.contourOpacity || 0.85) * 0.55;
      } else {
        ctx.setLineDash([]);
        ctx.globalAlpha = cfg.contourOpacity || 0.85;
      }

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
        ctx.strokeStyle = baseStrokeColor;
        ctx.lineWidth = targetWidth;

        const roughness = cfg.contourRoughness || 0.0;
        const pressure = cfg.contourHandPressure || 0.0;
        const elevNorm = clamp((iso - screenMin) / screenSpan, 0.0, 1.0);

        if (roughness > 0.02) {
          // Легчайшая текстурная прерывистость карандашного грифеля
          ctx.setLineDash([16, 1.2 * roughness, 8, 0.8 * roughness]);
        } else {
          ctx.setLineDash([]);
        }

        for (let p = 0; p < polylineList.length; p++) {
          let poly = polylineList[p];
          if (poly.length < 2) continue;

          // 1. Применяем текстуру карандаша / рваность
          if (roughness > 0.01) {
            poly = applyPencilRoughness(poly, roughness, iso);
          }

          const isClosed = Math.hypot(
            poly[0][0] - poly[poly.length - 1][0],
            poly[0][1] - poly[poly.length - 1][1]
          ) < 2.0;

          // 2. Рисуем с переменным нажимом руки или цельным штрихом
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

    in vec2 v_uv;
    in vec2 v_tileLocalPx;

    // Один стандартный буфер вывода (RGBA8)
    out vec4 fragColor;

    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      return (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
    }

    float getRawHPx(ivec2 p, float fallbackH) {
      vec4 c = texelFetch(u_dem, clamp(p, ivec2(0), u_iRes - ivec2(1)), 0);
      float h = decodeH(c);
      return (h < -1000.0) ? fallbackH : h;
    }

    float getGaussianHPx(ivec2 p, float centerH, int rad) {
      float h = getRawHPx(p, centerH) * 0.20;
      h += (getRawHPx(p + ivec2( rad, 0), centerH) + getRawHPx(p - ivec2( rad, 0), centerH)) * 0.12;
      h += (getRawHPx(p + ivec2(0,  rad), centerH) + getRawHPx(p - ivec2(0,  rad), centerH)) * 0.12;
      h += (getRawHPx(p + ivec2( rad,  rad), centerH) + getRawHPx(p - ivec2( rad,  rad), centerH)) * 0.08;
      h += (getRawHPx(p + ivec2(-rad,  rad), centerH) + getRawHPx(p + ivec2( rad, -rad), centerH)) * 0.08;
      h += (getRawHPx(p + ivec2( rad * 2, 0), centerH) + getRawHPx(p - ivec2( rad * 2, 0), centerH)) * 0.05;
      h += (getRawHPx(p + ivec2(0,  rad * 2), centerH) + getRawHPx(p - ivec2(0,  rad * 2), centerH)) * 0.05;
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
        float sampleH = getRawHPx(p + off[i], centerH);
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

      float hN  = getRawHPx(p + ivec2(0,  rPx), h0);
      float hS  = getRawHPx(p - ivec2(0,  rPx), h0);
      float hE  = getRawHPx(p + ivec2( rPx, 0), h0);
      float hW  = getRawHPx(p - ivec2( rPx, 0), h0);
      float hNE = getRawHPx(p + ivec2( diagPx,  diagPx), h0);
      float hNW = getRawHPx(p + ivec2(-diagPx,  diagPx), h0);
      float hSE = getRawHPx(p + ivec2( diagPx, -diagPx), h0);
      float hSW = getRawHPx(p + ivec2(-diagPx, -diagPx), h0);

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

    void main() {
      ivec2 basePx = ivec2(floor(v_uv * vec2(u_iRes)));
      vec4 centerRaw = texelFetch(u_dem, clamp(basePx, ivec2(0), u_iRes - ivec2(1)), 0);
      float centerH = decodeH(centerRaw);

      if (centerRaw.a < 0.1 || centerH < -1000.0) {
        fragColor = vec4(0.0);
        return;
      }

      float maxSafeR = max(1.0, u_pad - 3.0);
      int stepPx = 1;
      float z00, z10, z20, z01, z21, z02, z12, z22;

      if (u_smooth == 0) {
        stepPx = 1;
        z00 = getRawHPx(basePx + ivec2(-1, -1), centerH);
        z10 = getRawHPx(basePx + ivec2( 0, -1), centerH);
        z20 = getRawHPx(basePx + ivec2( 1, -1), centerH);
        z01 = getRawHPx(basePx + ivec2(-1,  0), centerH);
        z21 = getRawHPx(basePx + ivec2( 1,  0), centerH);
        z02 = getRawHPx(basePx + ivec2(-1,  1), centerH);
        z12 = getRawHPx(basePx + ivec2( 0,  1), centerH);
        z22 = getRawHPx(basePx + ivec2( 1,  1), centerH);
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
        float targetMetersRadius = clamp(45.0, u_metersPerPixel * 1.5, 90.0);
        float adaptiveBlurRadius = min(max(1.5, targetMetersRadius / u_metersPerPixel), maxSafeR);
        stepPx = max(1, int(round(adaptiveBlurRadius)));
        z00 = getGaussianHPx(basePx + ivec2(-stepPx, -stepPx), centerH, 1);
        z10 = getGaussianHPx(basePx + ivec2( 0,      -stepPx), centerH, 1);
        z20 = getGaussianHPx(basePx + ivec2( stepPx, -stepPx), centerH, 1);
        z01 = getGaussianHPx(basePx + ivec2(-stepPx,  0),      centerH, 1);
        z21 = getGaussianHPx(basePx + ivec2( stepPx,  0),      centerH, 1);
        z02 = getGaussianHPx(basePx + ivec2(-stepPx,  stepPx), centerH, 1);
        z12 = getGaussianHPx(basePx + ivec2( 0,       stepPx), centerH, 1);
        z22 = getGaussianHPx(basePx + ivec2( stepPx,  stepPx), centerH, 1);
      }

      float deltaMeters = max(0.1, 2.0 * float(stepPx) * u_metersPerPixel);
      float dzdx = ((z20 + 2.0 * z21 + z22) - (z00 + 2.0 * z01 + z02)) / (8.0 * deltaMeters) * u_zFactor;
      float dzdy = ((z02 + 2.0 * z12 + z22) - (z00 + 2.0 * z10 + z20)) / (8.0 * deltaMeters) * u_zFactor;
      vec3 norm = normalize(vec3(-dzdx, -dzdy, 1.0));

      float curvature = ((z10 + z01 + z21 + z12) * 0.25) - centerH;
      float crestGlint = clamp(-curvature * 0.20 * u_zFactor, 0.0, 0.40);
      float svf = computeSkyViewFactorPx(basePx, centerH, maxSafeR);

      float aoVal = 1.0;
      if (u_useAO > 0.5) {
        float aoMeterRadius = max(90.0, u_metersPerPixel * 3.5) * u_aoRadius;
        int wideR = int(min(aoMeterRadius / u_metersPerPixel, maxSafeR));
        float avgH = (getRawHPx(basePx + ivec2(-wideR,  0), centerH) +
                      getRawHPx(basePx + ivec2( wideR,  0), centerH) +
                      getRawHPx(basePx + ivec2( 0, -wideR), centerH) +
                      getRawHPx(basePx + ivec2( 0,  wideR), centerH)) * 0.25;

        float filteredDiff = max(0.0, (avgH - centerH) - 0.7);
        float slope = length(vec2(dzdx, dzdy));
        float slopeBleedFactor = mix(1.0, clamp(slope * 14.0, 0.5, 3.0), u_aoSlopeBleed);
        float valleyDepth = (filteredDiff * slopeBleedFactor) / max(2.5, u_metersPerPixel * 0.35);
        aoVal = clamp(1.0 - valleyDepth * 0.26 * u_aoStrength, 0.35, 1.0);
      }

      // --- УПАКОВКА В 1 ТЕКСТУРУ RGBA8 ---
      // R, G: нормали XY [-1..1] -> [0..1]
      vec2 encNorm = norm.xy * 0.5 + 0.5;
      float ambVal = clamp(aoVal * min(1.0, svf), 0.0, 1.0);
      float packedB = clamp(ambVal * 0.75 + crestGlint * 0.625, 0.0, 1.0);

      // Записываем нейтральную единицу (или маску валидности) в альфу:
      fragColor = vec4(encNorm, packedB, 1.0);
    }
  `;

  // ШЕЙДЕР ОСВЕЩЕНИЯ (РЕАЛЬНОЕ ВРЕМЯ)
  // =========================================================================
  // ДИНАМИЧЕСКИЙ ГЕНЕРАТОР ШЕЙДЕРА ОСВЕЩЕНИЯ (МОДУЛЬНАЯ КОМПИЛЯЦИЯ)
  // =========================================================================
  function buildLightFragmentShader(flags) {
    const defines = [];
    if (flags.mdow) defines.push('#define USE_MDOW');
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
    uniform vec3  u_manualColorValley;
    uniform float u_manualLightBlend;
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

    in vec2 v_uv;
    in vec2 v_tileLocalPx;

    out vec4 fragColor;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      return (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
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
      float diff = terrainH - rayH;
      if (diff > 0.0) {
        float occ = clamp(diff * 0.28, 0.0, 1.0);
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
      float rough    = clamp(u_outlineRoughness, 0.0, 1.0);
      float widthTex = max(0.4, u_outlineWidth) * texPerCss;
      float thrK     = 0.05 + 0.50 * u_outlineThreshold;

      float maxR = max(3.0, u_pad - 4.0);
      float r1f  = clamp(floor(26.0 / max(0.01, u_metersPerPixel) + 0.5), 2.0, min(14.0, maxR));
      float r2f  = clamp(r1f * 3.0, 6.0, min(40.0, maxR));
      int r1 = int(r1f);
      int r2 = int(r2f);

      // «Рука»: плавный увод линии в стороны и нажим вдоль штриха
      float sway  = ((olNoise(wp, 16.0) - 0.5) * 1.6
                   + (olNoise(wp + vec2(57.0, 23.0), 8.0) - 0.5) * 0.7) * rough * texPerCss;
      float press = mix(1.0, 0.68 + 0.60 * olNoise(wp + vec2(311.0, 5.0), 32.0), rough);

      float ink = 0.0;
      float rD, rS, vD, vS, steep;
      for (int s = 0; s < 2; s++) {
        olLineScale(bp, h0, (s == 0) ? r1 : r2, thrK, rD, rS, vD, vS, steep);
        float wMul = (s == 0) ? 0.80 : 1.20;   // мелкие линии тоньше, крупные хребты жирнее
        float aMul = (s == 0) ? 0.72 : 1.00;
        float gate = mix(1.0, steep, OL_K_CLIFF);

        // хребет: утолщается на крутых бортах (кромка обрыва)
        float hwR  = 0.5 * widthTex * wMul * mix(0.40, 1.0, rS) * (1.0 + 0.45 * steep) * press;
        float covR = smoothstep(0.0, 1.0, hwR + 0.5 - abs(rD + sway));
        float aR   = covR * smoothstep(0.0, 0.30, rS) * mix(0.55, 1.0, rS) * gate * OL_K_RIDGE;

        // тальвег: тоньше, сужается к верховьям
        float hwV  = 0.5 * widthTex * wMul * 0.72 * mix(0.40, 1.0, vS) * mix(1.0, 0.60, hNorm) * press;
        float covV = smoothstep(0.0, 1.0, hwV + 0.5 - abs(vD + sway));
        float aV   = covV * smoothstep(0.0, 0.30, vS) * mix(0.50, 0.90, vS) * gate * OL_K_VALLEY;

        ink = max(ink, max(aR, aV) * aMul);
      }

      // Зерно графита: слабые штрихи рвутся, сильные остаются сплошными
      float tooth = 0.6 * olNoise(wp, 1.0) + 0.4 * olNoise(wp + vec2(19.7, 7.3), 2.0);
      float grain = smoothstep(0.16, 0.56, tooth + 0.42 * ink);
      ink *= mix(1.0, grain, rough * 0.85);

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
      float hNorm = clamp((centerH - u_elevMin) / max(1.0, u_elevSpan), 0.0, 1.0);

      // 3. Восстановление нормалей и параметров из G-буфера
      vec2 nxy = g.xy * 2.0 - 1.0;
      float nz = sqrt(max(0.0001, 1.0 - dot(nxy, nxy)));
      vec3 norm = vec3(nxy, nz);

      float packedB = g.b;
      float aoVal = clamp(packedB / 0.75, 0.0, 1.0);
      float svf = aoVal;
      float crestGlint = clamp((packedB - 0.75) / 0.625, 0.0, 0.40);
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

      if (wrappedLight > 0.005 && u_sunIntensity > 0.01 && u_shadowOpacity > 0.01) {
        castShadow = computeCastShadowPx(basePx, v_tileLocalPx, centerH, effectiveSunDir, maxSafeMeters);
        castShadow = mix(1.0, castShadow, clamp(u_sunIntensity * 1.15, 0.25, 1.0));
      } else {
        castShadow = 1.0;
      }
      float directLight = wrappedLight * castShadow * u_sunIntensity;
      float skyFill = clamp(dot(norm, vec3(0.0, 0.0, 1.0)) * 0.65 + 0.35, 0.0, 1.0);

      float dayLuma = clamp(dot(u_lightColor, vec3(0.299, 0.587, 0.114)), 0.05, 1.0);

      float blendBias = clamp(u_manualLightBlend, 0.02, 0.98);
      float gamma = (1.0 - blendBias) / blendBias;
      float elevFactor = pow(hNorm, gamma);

      if (u_debugValley == 1) {
        fragColor = vec4(mix(u_manualColorValley, u_manualColorPeak, elevFactor), 1.0);
        return;
      }

      vec3 warmSunCol = u_lightColor;
      vec3 coolShaCol = u_shadowColor;
      float twilightShade = 0.0;
      float hEff = hNorm;
      const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

       if (u_isManualMode == 1) {
        float peakFactor = clamp(elevFactor + crestGlint * 0.4, 0.0, 1.0);
        warmSunCol = mix(u_manualColorValley, u_manualColorPeak, peakFactor);
        float valleyInfluence = 1.0 - elevFactor;
        coolShaCol = mix(coolShaCol, u_manualColorValley * 0.75, valleyInfluence * 0.65);
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
        float sunMod = mix(1.0, clamp(1.25 - directLight, 0.15, 1.0), u_hachureLightMod);
        // Маска штриховки запечена в sbuf (16 бит в R,G)
        float hachureDarkness = (floor(sb.r * 255.0 + 0.5) * 256.0 + floor(sb.g * 255.0 + 0.5)) / 65535.0;

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

      #ifdef USE_DITHER
      {
        float luma = dot(finalCol, vec3(0.299, 0.587, 0.114));
        vec2 p = v_tileLocalPx;
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
      }
      #endif

      if (u_waterlining > 0.5) {
        float waterLine = sb.b * 0.45;
        if (waterLine > 0.01) {
          finalCol = mix(finalCol, mix(finalCol, vec3(0.18, 0.32, 0.45), 0.75), waterLine);
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
        if (inkV > 0.004) {
          // Ослабление нажима карандаша на ярком свету
          float sunMod = mix(1.0, clamp(1.25 - directLight, 0.18, 1.0), u_outlineLightMod);
          float outlineAlpha = clamp(inkV * u_outlineOpacity * sunMod, 0.0, 1.0);
          vec3 blendedOutline = blendOutlineColor(u_outlineBlend, finalCol, u_outlineColor);
          finalCol = mix(finalCol, blendedOutline, outlineAlpha);
        }
      }
      #endif

      fragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
    }
  `;
  }

  let sharedGl = null;
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
      flags.outline ? (flags.outlineType || 'all') : '0'
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
      isManualMode: gl.getUniformLocation(prog, 'u_isManualMode'),
      debugValley: gl.getUniformLocation(prog, 'u_debugValley'),
      manualColorPeak: gl.getUniformLocation(prog, 'u_manualColorPeak'),
      manualColorValley: gl.getUniformLocation(prog, 'u_manualColorValley'),
      manualLightBlend: gl.getUniformLocation(prog, 'u_manualLightBlend'),
      elevMin: gl.getUniformLocation(prog, 'u_elevMin'),
      elevSpan: gl.getUniformLocation(prog, 'u_elevSpan'),

      // Обводка (только если USE_OUTLINE)
      outlineBlend: gl.getUniformLocation(prog, 'u_outlineBlend'),
      outlineWidth: gl.getUniformLocation(prog, 'u_outlineWidth'),
      outlineRoughness: gl.getUniformLocation(prog, 'u_outlineRoughness'),
      outlineThreshold: gl.getUniformLocation(prog, 'u_outlineThreshold'),
      outlineOpacity: gl.getUniformLocation(prog, 'u_outlineOpacity'),
      outlineLightMod: gl.getUniformLocation(prog, 'u_outlineLightMod'),
      outlineColor: gl.getUniformLocation(prog, 'u_outlineColor'),
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
      elevSpan: gl.getUniformLocation(gProg, 'u_elevSpan')
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
      return (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
    }

    float getRawHPx(ivec2 p, float fallbackH) {
      vec4 c = texelFetch(u_dem, clamp(p, ivec2(0), u_iRes - ivec2(1)), 0);
      float h = decodeH(c);
      return (h < -1000.0) ? fallbackH : h;
    }

    float computeWaterlining(float h, float slope, vec2 px) {
      if (slope > 0.006) return 0.0;
      float ripple = sin(px.x * 0.3 + px.y * 0.3 + noise(px * 0.1) * 4.0);
      float bands = smoothstep(0.3, 0.7, sin(h * 6.28 + ripple * 0.5));
      return bands * smoothstep(0.006, 0.001, slope) * 0.45;
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
      if (g.a < 0.5) return vec2(0.0);
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
            // Вдоль горизонталей: очерчивает формы рельефа поперек склона
            float h = cell * 0.85;
            float tt;
            hachSeg(p, c - tanDir * h, c + tanDir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * 0.13 * mix(0.7, 1.3, smoothstep(u_hachureSlope, u_hachureSlope * 5.0, sl));

          #elif defined(HACHURE_HYBRID)
            // ☯️ ГИБРИДНЫЙ РЕЖИМ:
            // На малых уклонах (холмы, балки) штрихи идут по tanDir (очерчивают горизонталями).
            // При возрастании крутизны плавно поворачиваются по dir (параллельно падению обрывов).
            steepFactor = smoothstep(u_hachureSlope * 1.8, u_hachureSlope * 4.8, sl);
            vec2 strokeDir = normalize(mix(tanDir, dir, steepFactor));
            float h = cell * mix(0.85, 0.95, steepFactor);
            float tt;
            hachSeg(p, c - strokeDir * h, c + strokeDir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * mix(
              0.13 * mix(0.7, 1.3, smoothstep(u_hachureSlope, u_hachureSlope * 3.5, sl)),
              0.12 * mix(0.8, 2.2, smoothstep(u_hachureSlope * 2.0, u_hachureSlope * 8.0, sl)),
              steepFactor
            );

          #elif defined(HACHURE_FLOW)
            // Изогнутый штрих: ломаная по линии стока (вперёд и назад от центра)
            float h = cell * 0.95;
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
            // Леман: штрихи одной длины, толщина пропорциональна крутизне
            float h = cell * 0.9;
            float tt;
            hachSeg(p, c - dir * h, c + dir * h, d, tt);
            s = tt * 2.0 - 1.0;
            w0 = cell * 0.10 * mix(0.5, 2.4, smoothstep(u_hachureSlope, u_hachureSlope * 8.0, sl));
          #elif defined(HACHURE_ROCK)
            // Скалы: короткие толстые штрихи с хаотичным отклонением
            if (sl < u_hachureSlope * 1.5) continue;
            float ang = (rnd.x - 0.5) * 1.1;
            float ca = cos(ang), sa = sin(ang);
            vec2 rdir = vec2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
            float h = cell * 0.6;
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

      float wl = computeWaterlining(centerH, slope, v_tileLocalPx);
      if (wl <= 0.01) wl = 0.0;

      float mv = floor(clamp(hachMask, 0.0, 1.0) * 65535.0 + 0.5);
      float hi = floor(mv / 256.0);
      float lo = mv - hi * 256.0;

      fragColor = vec4(hi / 255.0, lo / 255.0, clamp(wl / 0.45, 0.0, 1.0), clamp(grain + 0.5, 0.0, 1.0));
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
        hachureSlope: u('u_hachureSlope')
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
    if (glTexturePool.length < 48) {
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
  function uploadLightFrameUniforms(gl, L, lighting, effZ) {
    const u3 = (loc, v) => { if (loc) gl.uniform3f(loc, v[0], v[1], v[2]); };
    const u1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };

    if (L.dem) gl.uniform1i(L.dem, 0);
    if (L.gbuf) gl.uniform1i(L.gbuf, 1);
    if (L.sbuf) gl.uniform1i(L.sbuf, 2);

    u3(L.sunFaceColor, lighting.sunFaceColor || [1.0, 0.9, 0.8]);
    u1(L.twilightSat, lighting.twilightSat !== undefined ? lighting.twilightSat : 0.85);
    u3(L.dayGlowColor, lighting.dayGlowColor || [1.0, 0.96, 0.88]);
    u1(L.dayGlowStrength, lighting.dayGlowStrength !== undefined ? lighting.dayGlowStrength : 0.0);
    u1(L.hazeStrength, lighting.hazeStrength !== undefined ? lighting.hazeStrength : 0.0);
    u1(L.dayReach, lighting.dayReach !== undefined ? lighting.dayReach : 0.50);
    u3(L.twilightRimColor, lighting.twilightRimColor || [1.0, 0.45, 0.25]);
    u1(L.twilightRimWidth, lighting.twilightRimWidth || 0.5);

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
    if (L.debugValley) gl.uniform1i(L.debugValley, cfg.debugValley ? 1 : 0);
    if (L.manualColorPeak) u3(L.manualColorPeak, hexToVec3(cfg.manualPeakColor || '#fff8e7'));
    if (L.manualColorValley) u3(L.manualColorValley, hexToVec3(cfg.manualValleyColor || '#ffd8a8'));
    u1(L.manualLightBlend, cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.5);

    u1(L.twilightClimb, lighting.twilightClimb !== undefined ? lighting.twilightClimb : -1.0);
    u1(L.twilightAmt, lighting.twilightAmt !== undefined ? lighting.twilightAmt : 0.0);
    u1(L.afterglow, lighting.afterglow !== undefined ? lighting.afterglow : 0.0);
    u3(L.glowColor, lighting.glowColor || [0.92, 0.27, 0.33]);
    u3(L.valleyColor, lighting.valleyColor || [0.20, 0.17, 0.46]);
    const vStats = getViewportElevationStats();
    if (L.elevMin) gl.uniform1f(L.elevMin, vStats.minH);
    if (L.elevSpan) gl.uniform1f(L.elevSpan, Math.max(10.0, vStats.span));
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
    const inkBleedOn = cfg.inkBleed !== false;
    const bakeSig = globalGeomVersion + '|' + effZ + '|' + (inkBleedOn ? 1 : 0) + '|' +
      (wantHach ? (hachType + '|' + hachDensity + '|' + hachThin + '|' + hachSlope) : '0');

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
      outline: !!cfg.outlineEnabled,
      outlineType: cfg.outlineType
    });

    const L = activeProgramEntry.locs;

    // gl.useProgram ДОЛЖЕН вызываться ДО передачи любых uniform!
    gl.useProgram(activeProgramEntry.prog);
    if (L.vpOrigin) gl.uniform2i(L.vpOrigin, slot ? slot.x : 0, slot ? slot.y : 0);
    gl.bindVertexArray(sharedVao);

    // Общие uniform-ы заливаются только если изменилось освещение / настройки / z-factor
    if (activeProgramEntry._lighting !== lighting ||
        activeProgramEntry._cfgRev !== cfgRev ||
        activeProgramEntry._effZ !== effZ) {
      uploadLightFrameUniforms(gl, L, lighting, effZ);
      activeProgramEntry._lighting = lighting;
      activeProgramEntry._cfgRev = cfgRev;
      activeProgramEntry._effZ = effZ;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tileTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, owner._gBuf);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, owner._sBuf);

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
  const MAX_DEM_CACHE_ENTRIES = 128;

  const paddedDemMemoryCache = new Map();
  const paddedInFlightPromises = new Map();
  const MAX_PADDED_CACHE_ENTRIES = 48;

  function setDemMemoryCache(key, value) {
    if (demTileMemoryCache.size >= MAX_DEM_CACHE_ENTRIES) {
      const firstKey = demTileMemoryCache.keys().next().value;
      demTileMemoryCache.delete(firstKey);
    }
    demTileMemoryCache.set(key, value);
  }

  function setPaddedDemCache(key, value) {
    if (paddedDemMemoryCache.size >= MAX_PADDED_CACHE_ENTRIES) {
      const firstKey = paddedDemMemoryCache.keys().next().value;
      paddedDemMemoryCache.delete(firstKey);
    }
    paddedDemMemoryCache.set(key, value);
  }

  const TARGET_SIZE = 256; // <-- БЫЛО 512, СТАВИМ 256

  async function fetchSingleTile(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const resp = await fetch(url, { signal: controller.signal, mode: 'cors' });
      clearTimeout(timeout);
      if (!resp.ok) {
        const err = new Error(resp.status === 404 ? '404' : `HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const blob = await resp.blob();

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
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Decode error'));
          img.src = URL.createObjectURL(blob);
        });
      }

      const w = bmp.naturalWidth || bmp.width;
      const h = bmp.naturalHeight || bmp.height;

      // Если тайл уже 256x256 — отдаем сразу
      if (w === TARGET_SIZE && h === TARGET_SIZE) {
        return bmp;
      }

      // Если тайл 512x512 (Mapterhorn), уменьшаем до 256x256 строго без сглаживания!
      const cv = document.createElement('canvas');
      cv.width = TARGET_SIZE;
      cv.height = TARGET_SIZE;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, TARGET_SIZE, TARGET_SIZE);
      return cv;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
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
      if (data[idx + 3] < 20) {
        grid[i] = NaN;
      } else {
        grid[i] = (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
      }
    }

    entry = { grid, w, h };
    parentHeightCache.set(img, entry);
    return entry;
  }

  function cropParentTile(parentImg, targetCoords, parentCoords) {
    const { grid, w, h } = getParentHeightGrid(parentImg);
    const factor = 1 << (targetCoords.z - parentCoords.z);
    const subX = ((targetCoords.x % factor) + factor) % factor;
    const subY = ((targetCoords.y % factor) + factor) % factor;

    const OUT_SIZE = 256; // <-- ОБЯЗАТЕЛЬНО ПОМЕНЯТЬ С 512 НА 256!
    const canvas = document.createElement('canvas');
    canvas.width = OUT_SIZE;
    canvas.height = OUT_SIZE;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(OUT_SIZE, OUT_SIZE);
    const out = imgData.data;

    const clampVal = (v, max) => (v < 0 ? 0 : (v > max ? max : v));

    for (let y = 0; y < OUT_SIZE; y++) {
      const fy = ((subY + (y + 0.5) / OUT_SIZE) / factor) * h - 0.5;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const yA = clampVal(y0, h - 1) * w;
      const yB = clampVal(y0 + 1, h - 1) * w;

      for (let x = 0; x < OUT_SIZE; x++) {
        const fx = ((subX + (x + 0.5) / OUT_SIZE) / factor) * w - 0.5;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const xA = clampVal(x0, w - 1);
        const xB = clampVal(x0 + 1, w - 1);

        const h00 = grid[yA + xA];
        const h10 = grid[yA + xB];
        const h01 = grid[yB + xA];
        const h11 = grid[yB + xB];

        const outIdx = (y * OUT_SIZE + x) * 4;
        if (isNaN(h00) || isNaN(h10) || isNaN(h01) || isNaN(h11)) {
          out[outIdx + 3] = 0;
          continue;
        }

        const hMid = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
        const v = hMid + 32768.0;
        const r = Math.floor(v / 256.0);
        const g = Math.floor(v - r * 256.0);
        const b = Math.floor((v - Math.floor(v)) * 256.0);

        out[outIdx]     = clampVal(r, 255);
        out[outIdx + 1] = clampVal(g, 255);
        out[outIdx + 2] = clampVal(b, 255);
        out[outIdx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  async function loadPaddedDemTile(coords) {
    const srcKey = cfg.demSource || 'mapterhorn';
    const cacheKey = `${srcKey}:${coords.z}:${coords.x}:${coords.y}`;

    if (paddedDemMemoryCache.has(cacheKey)) {
      const cached = paddedDemMemoryCache.get(cacheKey);
      // ВОССТАНАВЛИВАЕМ ДАННЫЕ ВЫСОТ ИЗ КЭША:
      if (cached._minH !== undefined && coords) {
        registerTileElevation(coords, cached._minH, cached._maxH);
      }
      return cached;
    }
    if (paddedInFlightPromises.has(cacheKey)) {
      return paddedInFlightPromises.get(cacheKey);
    }

    const promise = (async () => {
      const center = await loadDemTileWithFallback(coords);
      const S = center.naturalWidth || center.width || 256;
      const B = Math.round(64 * (S / 256));
      const P = S + 2 * B;

      const cv = document.createElement('canvas');
      cv.width = P;
      cv.height = P;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;

      ctx.drawImage(center, 0, 0, P, P);
      ctx.clearRect(B, B, S, S);
      ctx.drawImage(center, B, B, S, S);

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
              .then(img => ({ img, dx, dy }))
              .catch(() => null)
          );
        }
      }

      const results = await Promise.all(neighbors);
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res && res.img) {
          ctx.clearRect(B + res.dx * S, B + res.dy * S, S, S);
          ctx.drawImage(res.img, B + res.dx * S, B + res.dy * S, S, S);
        }
      }

      // --- ДОБАВИТЬ ЭТОТ БЛОК: Быстрый замер мин/макс высоты тайла (~0.04 мс) ---
      if (cfg.contoursEnabled) {
        try {
          const full = ctx.getImageData(0, 0, P, P).data;
          // Сохраняем ссылку на данные, чтобы изолинии не дергали getImageData повторно
          cv._demData = full;

          let tMin = Infinity, tMax = -Infinity;
          let dMax = -Infinity;
          const stride = 4; // Прореживание выборки

          for (let y = 0; y < P; y += stride) {
            const rowIdx = y * P * 4;
            const isCenterY = (y >= B && y < B + S);
            for (let x = 0; x < P; x += stride) {
              const i = rowIdx + x * 4;
              if (full[i + 3] > 25) {
                const h = (full[i] * 256 + full[i + 1] + full[i + 2] * 0.00390625) - 32768.0;
                if (h > -1000.0) {
                  if (h > dMax) dMax = h;
                  if (isCenterY && x >= B && x < B + S && h < 9000.0) {
                    if (h < tMin) tMin = h;
                    if (h > tMax) tMax = h;
                  }
                }
              }
            }
          }

          cv._demMaxH = (dMax === -Infinity) ? 9000.0 : dMax;
          if (tMin !== Infinity && coords) {
            cv._minH = tMin;
            cv._maxH = tMax;
            registerTileElevation(coords, tMin, tMax);
            if (tMax - tMin > 5.0) {
              currentRegionalSpan = Math.max(currentRegionalSpan, tMax - tMin);
            }
          }
        } catch (e) {}
      } else {
        // При выключенных горизонталях отсекаем чтение пикселей в память:
        // задаем безопасный потолок для раннего выхода лучей теней в шейдере
        cv._demMaxH = 9000.0;
      }
      // ------------------------------------------------------------------------

      cv._pad = B;
      cv._tileSize = S;
      setPaddedDemCache(cacheKey, cv);
      return cv;
    })();

    paddedInFlightPromises.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      paddedInFlightPromises.delete(cacheKey);
    }
  }

  

  function createEmptyDemTile(size = 256) {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    // В формате Terrarium цвет rgb(128, 0, 0) означает высоту ровно 0 метров (уровень моря)
    ctx.fillStyle = 'rgb(128, 0, 0)';
    ctx.fillRect(0, 0, size, size);
    return cv;
  }
  // ------------------------------

  async function loadDemTileWithFallback(coords) {
    const srcKey = cfg.demSource || 'mapterhorn';
    const origKey = `${srcKey}:${coords.z}:${coords.x}:${coords.y}`;

    if (demTileMemoryCache.has(origKey)) {
      return demTileMemoryCache.get(origKey);
    }
    if (demInFlightPromises.has(origKey)) {
      return demInFlightPromises.get(origKey);
    }

    const promise = (async () => {
      const srcObj = DEM_SOURCES[srcKey] || DEM_SOURCES.mapterhorn;
      const templates = srcObj.urls;
      const origZ = coords.z;
      const minFallbackZ = Math.max(9, origZ - 4);

      let curZ = origZ;
      let curX = coords.x;
      let curY = coords.y;

      while (curZ >= minFallbackZ) {
        const cacheKey = `${srcKey}:${curZ}:${curX}:${curY}`;

        if (demTileMemoryCache.has(cacheKey)) {
          const cachedImg = demTileMemoryCache.get(cacheKey);
          if (curZ === origZ) return cachedImg;
          return cropParentTile(cachedImg, coords, { z: curZ, x: curX, y: curY });
        }

        if (!dem404Set.has(cacheKey)) {
          let hasExplicit404 = false;
          for (let i = 0; i < templates.length; i++) {
            const url = L.Util.template(templates[i], { z: curZ, x: curX, y: curY });
            try {
              const loaded = await fetchSingleTile(url);
              setDemMemoryCache(cacheKey, loaded);
              if (curZ === origZ) return loaded;
              return cropParentTile(loaded, coords, { z: curZ, x: curX, y: curY });
            } catch (err) {
              if (err && err.status === 404) {
                hasExplicit404 = true;
              }
              // Если это AbortError или таймаут — не глушим в 404, даём повторить попытку
            }
          }
          // Заносим в черный список только реальный 404
          if (hasExplicit404) {
            dem404Set.add(cacheKey);
          }
        }

        curZ -= 1;
        curX = Math.floor(curX / 2);
        curY = Math.floor(curY / 2);
      }

      // Если тайлов нет (океан / за пределами покрытия), возвращаем плоский тайл 0 м:
      return createEmptyDemTile(256);
    })();

    demInFlightPromises.set(origKey, promise);
    try {
      const res = await promise;
      setDemMemoryCache(origKey, res);
      return res;
    } finally {
      demInFlightPromises.delete(origKey);
    }
  }

  function renderTilesBatch(items, lighting) {
    initSharedGl();
    if (!sharedGl || !items.length) return;
    const gl = sharedGl;
    const CHUNK = 36;

    for (let off = 0; off < items.length; off += CHUNK) {
      const chunk = items.slice(off, off + CHUNK);
      const S = chunk[0].img._tileSize || 256;
      const cols = Math.ceil(Math.sqrt(chunk.length));
      const rows = Math.ceil(chunk.length / cols);
      const W = cols * S, H = rows * S;

      // ОПТИМИЗАЦИЯ: Холст может только расширяться, не пересоздавая контекст при 1 тайле
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
      const glCanvasH = gl.canvas.height; // Учитываем реальную высоту общего буфера

      for (let i = 0; i < chunk.length; i++) {
        const tileCanvas = chunk[i].canvas;
        const ctx = tileCanvas._cachedCtx2d || (tileCanvas._cachedCtx2d = tileCanvas.getContext('2d', { willReadFrequently: false }));
        
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(src, slots[i].x, glCanvasH - slots[i].y - S, S, S, 0, 0, 256, 256);
      }

      if (WM.perf && WM.perf._activeFrame) WM.perf._activeFrame.blitMs += performance.now() - t0;
    }
  }

  // =========================================================================
  // LEAFLET GRID LAYERS
  // =========================================================================
  // Очередь пакетного рендеринга для вновь прибывших тайлов
  let _incomingTileQueue = [];
  let _incomingQueueRaf = 0;

  function flushIncomingTiles() {
    _incomingQueueRaf = 0;
    if (!_incomingTileQueue.length || !WM.map) return;
    
    const curZoom = WM.map.getZoom();
    const validBatch = _incomingTileQueue.filter(b => b.item.z === curZoom);
    const staleBatch = _incomingTileQueue.filter(b => b.item.z !== curZoom);
    _incomingTileQueue = [];

    staleBatch.forEach(b => b.done(null, b.item.canvas));
    if (!validBatch.length) return;

    // Рендерим максимум 2 тайла за кадр, чтобы сохранить 60 FPS
    const MAX_TILES_PER_FRAME = 2;
    const currentBatch = validBatch.slice(0, MAX_TILES_PER_FRAME);
    const remainingBatch = validBatch.slice(MAX_TILES_PER_FRAME);

    if (remainingBatch.length > 0) {
      _incomingTileQueue = remainingBatch;
      _incomingQueueRaf = requestAnimationFrame(flushIncomingTiles);
    }

    const center = WM.map.getCenter();
    const lighting = getSunLighting(center.lat, center.lng);

    renderTilesBatch(currentBatch.map(b => b.item), lighting);

    for (let i = 0; i < currentBatch.length; i++) {
      currentBatch[i].done(null, currentBatch[i].item.canvas);
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
        if (sharedGl) {
          if (tile._demTex) { releaseTexture(sharedGl, tile._demTex, tile._demTexWidth); tile._demTex = null; }
          if (tile._gBuf) { releaseTexture(sharedGl, tile._gBuf, tile._gBufWidth); tile._gBuf = null; }
          if (tile._sBuf) { releaseTexture(sharedGl, tile._sBuf, tile._sBufWidth); tile._sBuf = null; }
          tile._cachedDemImg = null;
        }
      };

      loadPaddedDemTile(coords)
        .then(img => {
          if (!tile.parentNode && this._tiles && !this._tiles[this._tileCoordsToKey(coords)]) {
            done(null, tile);
            return;
          }
          tile._demImg = img;
          
          // Отправляем в объединенную очередь вместо мгновенного одиночного рендера:
          _incomingTileQueue.push({
            item: { img, lat: centerLatLng.lat, z: coords.z, canvas: tile, coords },
            done: done
          });
          if (!_incomingQueueRaf) {
            _incomingQueueRaf = requestAnimationFrame(flushIncomingTiles);
          }
        })
        .catch((err) => {
          done(null, tile);
        });

      return tile;
    },

    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile && tile._cleanup) tile._cleanup();
      L.GridLayer.prototype._removeTile.call(this, key);
    }
  });

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
          if (!tile.parentNode && this._tiles && !this._tiles[this._tileCoordsToKey(coords)]) {
            done(null, tile);
            return;
          }
          const rendered = renderTileContours(img, coords.z, coords, centerLatLng);
          if (rendered) {
            const ctx = tile.getContext('2d');
            ctx.drawImage(rendered, 0, 0);
          }
          done(null, tile);
        })
        .catch((err) => {
          if (err && err.message !== 'Timeout' && !err.message.includes('404')) {
            console.error('DEM render error:', err);
          }
          done(null, tile);
        });

      return tile;
    }
  });

  let hillshadeLayerInstance = null;
  let contoursLayerInstance = null;
  let contoursRedrawTimer = null;
  let liveHillshadeRaf = 0;

  function updateLiveHillshade() {
    if (!hillshadeLayerInstance || !WM.map || !cfg.hillshadeEnabled) return;
    if (!hillshadeLayerInstance || !WM.map || !cfg.hillshadeEnabled) return;
    
    // --- ХУК 1: СТАРТ КАДРА ---
    WM.perf.beginFrame();

    const tiles = hillshadeLayerInstance._tiles;
    if (!tiles) {
      WM.perf.endFrame();
      return;
    }

    const map = WM.map;
    const center = map.getCenter();
    const lighting = getSunLighting(center.lat, center.lng);
    const bounds = map.getBounds();
    const tileSize = hillshadeLayerInstance.getTileSize();

    // Замеряем время подготовки CPU данных
    WM.perf.markCpuCalcEnd();

    _frameStatsCache = new Map();
    const batch = [];
    try {
      const curZoom = map.getZoom();
      for (const key in tiles) {
        const tileEntry = tiles[key];
        const el = tileEntry ? tileEntry.el : null;
        if (!el || !el._demImg || !el._demCoords) continue;

        // ИГНОРИРУЕМ ТАЙЛЫ ДРУГИХ МАСШТАБОВ (убирает конфликт зумов при смене масштаба)
        if (el._demCoords.z !== curZoom) continue;
        
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

        if (bounds.intersects(tileBounds)) {
          el._demNeedsRedraw = false;
          batch.push({ img: el._demImg, lat: el._demLat || center.lat, z: el._demCoords.z, canvas: el, coords: el._demCoords });
        } else {
          el._demNeedsRedraw = true;
        }
      }
      renderTilesBatch(batch, lighting);
    } finally {
      _frameStatsCache = null;
      WM.perf.endFrame();
    }
  }


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

  function scheduleLiveHillshade() {
    cfgRev++;
    if (liveHillshadeRaf) return;
    liveHillshadeRaf = requestAnimationFrame(() => {
      liveHillshadeRaf = 0;
      if (isHillshadeRendering) {
        scheduleLiveHillshade();
        return;
      }
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
  }

  function applyBlendModeToPane(mapInstance) {
    const m = mapInstance || WM.map;
    if (!m) return;
    const hsPane = m.getPane('wm-dem-hillshade-pane');
    if (hsPane) {
      hsPane.style.mixBlendMode = cfg.blendMode || 'soft-light';
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

  function renderHudUI() {
    if (!isHudOpen) return;

    const hud = document.getElementById('dem-relief-hud');
    if (!hud) return;

    const btnHs = document.getElementById('dem-hud-toggle-hs');
    const btnCt = document.getElementById('dem-hud-toggle-ct');
    if (btnHs) btnHs.classList.toggle('active', !!cfg.hillshadeEnabled);
    if (btnCt) btnCt.classList.toggle('active', !!cfg.contoursEnabled);

    hud.querySelectorAll('.dem-hud-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });

    const bodyLight = document.getElementById('dem-hud-body-light');
    const bodyTerrain = document.getElementById('dem-hud-body-terrain');
    const bodyContours = document.getElementById('dem-hud-body-contours');
    if (bodyLight) bodyLight.hidden = (activeTab !== 'light');
    if (bodyTerrain) bodyTerrain.hidden = (activeTab !== 'terrain');
    if (bodyContours) bodyContours.hidden = (activeTab !== 'contours');

    // --- Дизеринг ---
    const chkDither = document.getElementById('dem-hud-toggle-dither');
    if (chkDither) chkDither.checked = !!cfg.ditherEnabled;

    const subDither = document.getElementById('dem-hud-dither-sub');
    if (subDither) {
      subDither.classList.toggle('is-disabled', !cfg.ditherEnabled);
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
    if (selBlend) selBlend.value = cfg.blendMode || 'multiply';

    const sliderHsOp = document.getElementById('dem-hud-hs-opacity');
    const valHsOp = document.getElementById('dem-hud-hs-opacity-val');
    if (sliderHsOp && valHsOp) {
      sliderHsOp.value = Math.round(cfg.hillshadeOpacity * 100);
      valHsOp.textContent = sliderHsOp.value + '%';
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
    if (colPeak) colPeak.value = cfg.manualPeakColor || '#fff8e7';

    const colValley = document.getElementById('dem-hud-manual-color-valley');
    if (colValley) colValley.value = cfg.manualValleyColor || '#ffd8a8';

    const colShadow = document.getElementById('dem-hud-manual-color-shadow');
    if (colShadow) colShadow.value = cfg.manualShadowColor || '#1e2438';

    const sliderBlend = document.getElementById('dem-hud-manual-blend-slider');
    const valBlend = document.getElementById('dem-hud-manual-blend-val');
    if (sliderBlend && valBlend) {
      const bPct = Math.round((cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.50) * 100);
      sliderBlend.value = bPct;
      valBlend.textContent = bPct + '%';
    }

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
    if (selSource) selSource.value = cfg.demSource || 'mapterhorn';

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

    const chkLabels = document.getElementById('dem-hud-toggle-labels');
    if (chkLabels) chkLabels.checked = cfg.showLabels !== false;

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
  }

  function initHudEvents() {
    const hud = document.getElementById('dem-relief-hud');
    if (!hud || hud._inited) return;
    hud._inited = true;

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

    // Экспорт настроек в JSON
    document.getElementById('btn-dem-hud-export')?.addEventListener('click', () => {
      const jsonStr = JSON.stringify(cfg, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dem_relief_settings_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('💾 Настройки 3D сохранены в файл JSON');
    });

    // Импорт настроек из JSON
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
            if (typeof parsed === 'object' && parsed !== null) {
              WM.demRelief.setConfig(parsed);
              renderHudUI();
              if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Настройки 3D успешно загружены');
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
      btnRefresh.addEventListener('click', () => {
        btnRefresh.classList.add('spinning');
        setTimeout(() => btnRefresh.classList.remove('spinning'), 700);

        demTileMemoryCache.clear();
        demInFlightPromises.clear();
        dem404Set.clear();
        paddedDemMemoryCache.clear();
        paddedInFlightPromises.clear();

        if (sharedGl && hillshadeLayerInstance && hillshadeLayerInstance._tiles) {
          for (const k in hillshadeLayerInstance._tiles) {
            const el = hillshadeLayerInstance._tiles[k]?.el;
            if (el) {
              if (el._demTex) sharedGl.deleteTexture(el._demTex);
              if (el._gBuf) sharedGl.deleteTexture(el._gBuf);
              if (el._sBuf) sharedGl.deleteTexture(el._sBuf);
              el._demTex = null;
              el._gBuf = null;
              el._sBuf = null;
              el._sBufWidth = 0;
              el._bakeSig = null;
              el._demTexWidth = 0;
              el._demTexHeight = 0;
              el._gBufWidth = 0;
              el._cachedDemImg = null;
              el._geomVersion = -1;
            }
          }
        }
        globalGeomVersion++;

        if (hillshadeLayerInstance && cfg.hillshadeEnabled) {
          hillshadeLayerInstance.redraw();
        }
        if (contoursLayerInstance && cfg.contoursEnabled) {
          contoursLayerInstance.redraw();
        }

        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('🔄 Рельеф перезагружается для текущего экрана…');
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

    document.getElementById('dem-hud-dither-blend-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ditherBlendMode: e.target.value });
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-hs')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ hillshadeEnabled: !cfg.hillshadeEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.hillshadeEnabled ? '⛰️ 3D Отмывка включена' : '⛰️ 3D Отмывка скрыта');
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
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-toggle-formlines')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ formLinesEnabled: e.target.checked });
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

    document.getElementById('dem-hud-toggle-ct')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ contoursEnabled: !cfg.contoursEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.contoursEnabled ? '〰️ Горизонтали включены' : '〰️ Горизонтали скрыты');
      }
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

    document.getElementById('dem-hud-manual-color-valley')?.addEventListener('input', (e) => {
      cfg.manualValleyColor = e.target.value;
      // АВТОМАТИЧЕСКИ переводим режим в manual, если пользователь настраивает ручные цвета:
      cfg.sunMode = 'manual';
      const selSun = document.getElementById('dem-hud-sunmode-select');
      if (selSun) selSun.value = 'manual';
      saveConfig();
      renderHudUI();
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
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-color-shadow')?.addEventListener('input', (e) => {
      cfg.manualShadowColor = e.target.value;
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-manual-blend-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-manual-blend-val').textContent = val + '%';
      cfg.manualLightBlend = val / 100;
      saveConfig();
      scheduleLiveHillshade();
    });

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

    document.getElementById('dem-hud-hachure-type-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ hachureType: e.target.value });
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

    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        const tone = ch.dataset.tone;
        WM.demRelief.setConfig({ colorTone: tone });
        renderHudUI();
        scheduleLiveHillshade();
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
  }

  // =========================================================================
  // ПУБЛИЧНЫЙ API
  // =========================================================================
  WM.demRelief = {
    getConfig: () => ({ ...cfg }),
    getSources: () => ({ ...DEM_SOURCES }),

    getLayers() {
      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    },

    openHud() {
      const hud = document.getElementById('dem-relief-hud');
      if (!hud) return;
      isHudOpen = true;
      initHudEvents();
      renderHudUI();
      hud.hidden = false;
      if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('demReliefHud');
    },

    closeHud() {
      const hud = document.getElementById('dem-relief-hud');
      if (hud) hud.hidden = true;
      isHudOpen = false;
      if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('demReliefHud');
    },

    isHudOpen: () => isHudOpen,

    setConfig(newCfg) {
      const oldCfg = { ...cfg };
      Object.assign(cfg, newCfg);
      saveConfig();

      if (newCfg.blendMode !== undefined || newCfg.contourBlendMode !== undefined) {
        applyBlendModeToPane();
      }

      if (newCfg.hillshadeEnabled !== undefined || newCfg.contoursEnabled !== undefined) {
        applyLayerVisibility();
      }

      if (newCfg.hillshadeOpacity !== undefined && hillshadeLayerInstance) {
        hillshadeLayerInstance.setOpacity(cfg.hillshadeOpacity);
      }
      if (newCfg.contourOpacity !== undefined && contoursLayerInstance) {
        contoursLayerInstance.setOpacity(cfg.contourOpacity);
      }

      const needTilesReload = (
        newCfg.demSource !== undefined && newCfg.demSource !== oldCfg.demSource
      );

      const needGeomInvalidate = (
        newCfg.smoothMode !== undefined && newCfg.smoothMode !== oldCfg.smoothMode ||
        newCfg.zFactor !== undefined && newCfg.zFactor !== oldCfg.zFactor ||
        newCfg.zFactorAuto !== undefined && newCfg.zFactorAuto !== oldCfg.zFactorAuto ||
        newCfg.ambientOcclusion !== undefined && newCfg.ambientOcclusion !== oldCfg.ambientOcclusion ||
        newCfg.aoStrength !== undefined && newCfg.aoStrength !== oldCfg.aoStrength ||
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.aoSlopeBleed !== undefined && newCfg.aoSlopeBleed !== oldCfg.aoSlopeBleed ||
        newCfg.svfEnabled !== undefined && newCfg.svfEnabled !== oldCfg.svfEnabled ||
        newCfg.svfStrength !== undefined && newCfg.svfStrength !== oldCfg.svfStrength
      );

      if (needGeomInvalidate) {
        globalGeomVersion++;
      }

      if (needTilesReload) {
        demTileMemoryCache.clear();
        demInFlightPromises.clear();
        dem404Set.clear();
        paddedDemMemoryCache.clear();
        paddedInFlightPromises.clear();

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
        newCfg.manualPeakColor !== undefined && newCfg.manualPeakColor !== oldCfg.manualPeakColor ||
        newCfg.manualValleyColor !== undefined && newCfg.manualValleyColor !== oldCfg.manualValleyColor ||
        newCfg.manualShadowColor !== undefined && newCfg.manualShadowColor !== oldCfg.manualShadowColor ||
        newCfg.manualLightBlend !== undefined && newCfg.manualLightBlend !== oldCfg.manualLightBlend ||
        newCfg.ambientOcclusion !== undefined && newCfg.ambientOcclusion !== oldCfg.ambientOcclusion ||
        newCfg.aoStrength !== undefined && newCfg.aoStrength !== oldCfg.aoStrength ||
        newCfg.hachureBlendMode !== undefined && newCfg.hachureBlendMode !== oldCfg.hachureBlendMode ||
        newCfg.hachureThinning !== undefined && newCfg.hachureThinning !== oldCfg.hachureThinning ||
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.aoSlopeBleed !== undefined && newCfg.aoSlopeBleed !== oldCfg.aoSlopeBleed ||
        newCfg.svfEnabled !== undefined && newCfg.svfEnabled !== oldCfg.svfEnabled ||
        newCfg.svfStrength !== undefined && newCfg.svfStrength !== oldCfg.svfStrength ||
        newCfg.ditherAngle !== undefined && newCfg.ditherAngle !== oldCfg.ditherAngle ||
        newCfg.outlineBlendMode !== undefined && newCfg.outlineBlendMode !== oldCfg.outlineBlendMode ||
        newCfg.outlineWidth !== undefined && newCfg.outlineWidth !== oldCfg.outlineWidth ||
        newCfg.outlineRoughness !== undefined && newCfg.outlineRoughness !== oldCfg.outlineRoughness ||
        newCfg.outlineThreshold !== undefined && newCfg.outlineThreshold !== oldCfg.outlineThreshold ||
        newCfg.outlineOpacity !== undefined && newCfg.outlineOpacity !== oldCfg.outlineOpacity ||
        newCfg.outlineLightMod !== undefined && newCfg.outlineLightMod !== oldCfg.outlineLightMod ||
        newCfg.outlineColor !== undefined && newCfg.outlineColor !== oldCfg.outlineColor ||
        newCfg.ditherDensity !== undefined && newCfg.ditherDensity !== oldCfg.ditherDensity ||
        newCfg.ditherLowCut !== undefined && newCfg.ditherLowCut !== oldCfg.ditherLowCut ||
        newCfg.ditherBlendMode !== undefined && newCfg.ditherBlendMode !== oldCfg.ditherBlendMode ||
        newCfg.ditherScale !== undefined && newCfg.ditherScale !== oldCfg.ditherScale ||
        newCfg.ditherThreshold !== undefined && newCfg.ditherThreshold !== oldCfg.ditherThreshold ||
        newCfg.ditherSoftness !== undefined && newCfg.ditherSoftness !== oldCfg.ditherSoftness ||
        newCfg.ditherColor !== undefined && newCfg.ditherColor !== oldCfg.ditherColor ||
        newCfg.ditherZone !== undefined && newCfg.ditherZone !== oldCfg.ditherZone ||
        newCfg.ditherStrength !== undefined && newCfg.ditherStrength !== oldCfg.ditherStrength ||
        newCfg.hachureDensity !== undefined && newCfg.hachureDensity !== oldCfg.hachureDensity ||
        newCfg.hachureOpacity !== undefined && newCfg.hachureOpacity !== oldCfg.hachureOpacity ||
        newCfg.hachureSlope !== undefined && newCfg.hachureSlope !== oldCfg.hachureSlope ||
        newCfg.hachureColor !== undefined && newCfg.hachureColor !== oldCfg.hachureColor ||
        newCfg.hachureLightMod !== undefined && newCfg.hachureLightMod !== oldCfg.hachureLightMod ||
        newCfg.castShadows !== undefined && newCfg.castShadows !== oldCfg.castShadows ||
        newCfg.shadowReach !== undefined && newCfg.shadowReach !== oldCfg.shadowReach ||
        newCfg.shadowOpacity !== undefined && newCfg.shadowOpacity !== oldCfg.shadowOpacity ||
        newCfg.imhofDeflection !== undefined && newCfg.imhofDeflection !== oldCfg.imhofDeflection ||
        newCfg.paperGrain !== undefined && newCfg.paperGrain !== oldCfg.paperGrain ||
        newCfg.hypsoMode !== undefined && newCfg.hypsoMode !== oldCfg.hypsoMode ||
        newCfg.orenNayarRoughness !== undefined && newCfg.orenNayarRoughness !== oldCfg.orenNayarRoughness ||
        newCfg.specularDamp !== undefined && newCfg.specularDamp !== oldCfg.specularDamp ||
        newCfg.inkBleed !== undefined && newCfg.inkBleed !== oldCfg.inkBleed ||
        newCfg.waterlining !== undefined && newCfg.waterlining !== oldCfg.waterlining
      );

      if (needLightUpdate && cfg.hillshadeEnabled && !needTilesReload) {
        scheduleLiveHillshade();
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
        map.getPane('wm-dem-contours-pane').style.zIndex = 470;
      }

      hillshadeLayerInstance = new WebGLHillshadeLayer({
        pane: 'wm-dem-hillshade-pane',
        maxNativeZoom: 16,
        maxZoom: 20,
        opacity: cfg.hillshadeOpacity,
        updateWhenIdle: true,
        keepBuffer: 2
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
        keepBuffer: 2
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
        scheduleLiveHillshade(); // Дорисовываем в максимальном качестве, когда карта встала
      });

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
  eveningGoldenLightHex: '#ffba7a',
  eveningGoldenSkyHex: '#584a78',

  duskCivilEnd: -8.0,
  duskFaceHex: '#ffffff',
  twilightSatLimit: 1.0,
  duskGlowHex: '#ffd257',
  duskRimHex: '#c32222',
  duskValleyHex: '#1f163d',
  duskLightHex: '#dd9a08',
  duskSkyHex: '#393361',
  duskGlowIntensity: 1.15,

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
    const key = cfgRev + '|' + centerLat + '|' + centerLng + '|' + stamp + '|' + wk;
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

})();
