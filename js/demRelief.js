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
      const ev = this.getSunEvents(lat, lng, date);
      const base = ev.noon || this._anchor(lng, date);
      return new Date(base.getTime() + (hour - 12) * 3600000);
    }
  };

  const DEFAULT_CONFIG = {
    demSource: 'mapterhorn',
    hillshadeEnabled: true,
    blendMode: 'soft-light', // Исправлено: совпадает с UI
    contourBlendMode: 'normal',
    zFactor: 3.5,
    zFactorAuto: true,
    sunMode: 'time',
    manualTimeHour: 15,
    manualDateStr: '',
    sunAzimuth: 315,
    sunAltitude: 45,
    colorTone: 'imhof',
    smoothMode: 'bilateral',
    hypsoMode: 'none',
    orenNayarRoughness: 0.50, // 0.0 = Lambert, 1.0 = Max Oren-Nayar
    inkBleed: true,          // Впитывание краски и рельеф пластины
    waterlining: true,       // Береговые каёмки водоемов
    formLinesEnabled: true,  // Вспомогательные пунктирные полугоризонтали
    formLinesSlopeMax: 0.035,// Порог крутизны, выше которого полугоризонтали не рисуются

    // Художественный дизеринг и гравюра
    ditherEnabled: false,
    ditherType: 'blue',       // 'blue', 'wavy', 'hex', 'chevron', 'hatch', 'woodcut', 'cross', 'dots', 'bayer', 'stipple', 'litho'
    ditherBlendMode: 'multiply', // 'normal', 'multiply', 'overlay', 'softlight', 'screen', 'burn', 'difference'
    ditherScale: 1.0,
    ditherAngle: 45,
    ditherDensity: 1.0,
    ditherThreshold: 0.60,
    ditherLowCut: 0.00,
    ditherSoftness: 0.20,
    ditherZone: 'shadows',
    ditherStrength: 0.85,
    ditherColor: '#1a1614',

    // Новые параметры: усиление света и ручная палитра
    lightBoost: 1.0,
    manualPeakColor: '#fff8e7',
    manualValleyColor: '#ffd8a8',
    manualShadowColor: '#1e2438',
    manualLightBlend: 0.50,

    // Швейцарская школа и многолучевая отмывка
    imhofDeflection: 0.35,
    mdowEnabled: true,

    // Штриховка
    hachureEnabled: false,
    hachureType: 'classic',
    hachureDensity: 1.0,
    hachureOpacity: 0.75,
    hachureSlope: 0.08,
    hachureColor: '#1c1917',
    hachureLightMod: 0.60,

    ambientOcclusion: true,
    aoStrength: 1.0,
    aoRadius: 1.0,
    aoSlopeBleed: 0.65,

    svfEnabled: true,
    svfStrength: 0.85,

    castShadows: true,
    shadowReach: 1.0,
    shadowOpacity: 0.60,

    imhofWarmCool: 0.85,
    lightWrap: 0.35,
    paperGrain: 0.40,
    contourPalette: 'sepia',
    contourBlendMode: 'normal',
    hillshadeOpacity: 0.70,

    contoursEnabled: false,
    contourStep: 'auto',
    contourColor: '#b45309',
    contourOpacity: 0.85,
    contourWidth: 1.5,
    taperWithElevation: true,
    taperDirection: 'crests',
    taperStrength: 0.60,
    cliffHairlines: true,
    showLabels: true,

    // Стили горизонталей
    contourStyle: 'standard',
    contourSmoothing: 'chaikin'
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

  let saveConfigTimer = null;
  function saveConfig() {
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

  function hexToVec3(hex) {
    const clean = (hex || '#000000').replace('#', '');
    const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
    return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
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

  function getViewportElevationStats(currentZoom) {
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

    const pKey = p => `${Math.round(p[0] * 8)},${Math.round(p[1] * 8)}`;
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
    const data = pCtx.getImageData(0, 0, P, P).data;

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

    const cLat = centerLatLng ? centerLatLng.lat : 55.75;
    const cLng = centerLatLng ? centerLatLng.lng : 37.62;
    const sunLighting = getSunLighting(cLat, cLng);
    const sunDir2D = normalizeVec3([sunLighting.sunVec[0], -sunLighting.sunVec[1], 0.0]);

    const baseStep = getEffectiveContourStep(zoom);
    const useFormLines = !!cfg.formLinesEnabled;
    const loopStep = useFormLines ? (baseStep * 0.5) : baseStep;
    const firstContour = Math.ceil(minH / loopStep) * loopStep;
    if (firstContour > maxH) return canvas;

    for (let iso = firstContour; iso <= maxH; iso += loopStep) {
      const isHalfStep = useFormLines && (Math.abs(iso % baseStep) > 0.001);
      const isMajor = !isHalfStep && (Math.round(iso / baseStep) % 5 === 0);
      let targetWidth = isMajor ? (baseW * 1.6) : (isHalfStep ? baseW * 0.75 : baseW);

      if (taperEnabled && taperStrength > 0.01) {
        const elevNorm = clamp((iso - screenMin) / screenSpan, 0.0, 1.0);
        const factor = (taperDir === 'crests') ? (1.0 - elevNorm * taperStrength) : ((1.0 - taperStrength) + elevNorm * taperStrength);
        targetWidth = Math.max(0.45, targetWidth * clamp(factor, 0.25, 1.0));
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
          // Расчёт реальной ширины ячейки в метрах на местности:
          const mpp = (156543.03392 * Math.cos(((centerLatLng ? centerLatLng.lat : 55) * Math.PI) / 180)) / Math.pow(2, zoom);
          const cellMeters = cellW * mpp;

          const cellSlope = Math.hypot(dzdx, dzdy) / Math.max(1.0, cellMeters);

          // Порог уклона в реальных тангенсах (например, 0.04 = уклон до 4%):
          if (isHalfStep && cellSlope > (cfg.formLinesSlopeMax || 0.04)) {
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
        const polylineList = buildPolylinesFast(segments);
        ctx.strokeStyle = baseStrokeColor;
        ctx.lineWidth = targetWidth;
        ctx.beginPath();

        for (let p = 0; p < polylineList.length; p++) {
          const poly = polylineList[p];
          if (poly.length < 2) continue;

          const isClosed = Math.hypot(
            poly[0][0] - poly[poly.length - 1][0],
            poly[0][1] - poly[poly.length - 1][1]
          ) < 2.0;

          drawSmoothContourPath(ctx, poly, isClosed);
        }
        ctx.stroke();
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

  // =========================================================================
  // РАСЧЕТ ОСВЕЩЕНИЯ
  // =========================================================================
  function getSunLighting(centerLat, centerLng) {
    const TONE_PALETTES = {
      imhof:   { light: [1.05, 0.96, 0.84], shadow: [0.22, 0.26, 0.45], warmCool: 1.0 },
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

      // 1. Позиция Солнца
      const sunPos = SunCalc.getPosition(dateForCalc, centerLat, centerLng);
      const sunAltDeg = sunPos.altitude * (180 / Math.PI);
      const sunAz = sunPos.azimuth + Math.PI;

      // Ограничение визуальной высоты лучей (не падает ниже 9°, чтобы не терялся рельеф)
      const visualSunAltDeg = Math.max(9.0, sunAltDeg);
      const visualSunAltRad = (visualSunAltDeg * Math.PI) / 180;
      const cosVisualAlt = Math.cos(visualSunAltRad);
      const sunV = [
        Math.sin(sunAz) * cosVisualAlt,
        -Math.cos(sunAz) * cosVisualAlt,
        Math.sin(visualSunAltRad)
      ];

      // 2. Определение половины суток (Утро vs Вечер)
      let isMorning = false;
      try {
        const times = SunCalc.getTimes(dateForCalc, centerLat, centerLng);
        if (times.solarNoon && !isNaN(times.solarNoon.getTime())) {
          isMorning = dateForCalc.getTime() < times.solarNoon.getTime();
        } else {
          isMorning = (dateForCalc.getUTCHours() + centerLng / 15 + 24) % 24 < 12;
        }
      } catch (e) {
        isMorning = false;
      }

      // 3. Данные Луны
      const moonPos = SunCalc.getMoonPosition(dateForCalc, centerLat, centerLng);
      const moonIllum = SunCalc.getMoonIllumination(dateForCalc);
      const moonAltDeg = moonPos.altitude * (180 / Math.PI);
      const moonAz = moonPos.azimuth + Math.PI;

      // Мягкий горизонт луны вместо жесткого ступора
      const moonHorizonWeight = smoothstep(-5.0, 5.0, moonAltDeg);
      const visualMoonAltRad = (Math.max(12.0, moonAltDeg) * Math.PI) / 180;
      const cosMoonAlt = Math.cos(visualMoonAltRad);
      const realMoonVec = [
        Math.sin(moonAz) * cosMoonAlt,
        -Math.cos(moonAz) * cosMoonAlt,
        Math.sin(visualMoonAltRad)
      ];
      // Вектор рассеянного ночного неба при отсутствии Луны
      const starlightVec = normalizeVec3([0.35, -0.45, 0.82]);
      const targetNightVec = normalizeVec3(lerpVec3(starlightVec, realMoonVec, moonHorizonWeight));

      // Яркость ночи:
      // Базовый звёздный свет не падает ниже 0.22 (было 0.11), исключая черную дыру после захода Луны
      const moonFraction = (moonIllum && typeof moonIllum.fraction === 'number') ? moonIllum.fraction : 0.5;
      const lunarBoost = 0.38 * smoothstep(0.0, 30.0, moonAltDeg) * (0.25 + 0.75 * moonFraction);
      const nightLightIntensity = 0.22 + lunarBoost * moonHorizonWeight;

      // Цвета ночного освещения:
      const brightMoonLight = lerpVec3([0.62, 0.74, 0.96], [0.75, 0.90, 1.18], moonFraction);
      const brightMoonSha   = [0.065, 0.085, 0.160];
      const starLightCol    = [0.42, 0.52, 0.76];    // Мягкий рассеянный звёздный свет
      const starShadowCol   = [0.055, 0.075, 0.140]; // Бархатная синева вместо глухой черноты

      const moonLightCol  = lerpVec3(starLightCol, brightMoonLight, moonHorizonWeight);
      const moonShadowCol = lerpVec3(starShadowCol, brightMoonSha, moonHorizonWeight);

      // 4. Палитры дня и неба
      const baseLight   = chosenTone.light;
      const baseShadow  = chosenTone.shadow;
      const daySky      = [0.45, 0.58, 0.75];
      const nightSky    = [0.07, 0.10, 0.19];

      // --- ПАЛИТРЫ РАССВЕТА ---
      const dawnGoldLight   = [1.14, 0.95, 0.78];
      const dawnGoldShadow  = [0.18, 0.22, 0.36];
      const dawnAlpenLight  = [1.22, 0.72, 0.76];
      const dawnAlpenShadow = [0.14, 0.16, 0.30];
      const dawnSky         = [0.42, 0.48, 0.68];

      // --- ПАЛИТРЫ ЗАКАТА ---
      const duskGoldLight   = [1.32, 0.78, 0.42];
      const duskGoldShadow  = [0.24, 0.16, 0.38];
      const duskAlpenLight  = [1.40, 0.48, 0.56];
      const duskAlpenShadow = [0.18, 0.14, 0.34];
      const duskSky         = [0.55, 0.33, 0.48];

      const activeGoldLight   = isMorning ? dawnGoldLight   : duskGoldLight;
      const activeGoldShadow  = isMorning ? dawnGoldShadow  : duskGoldShadow;
      const activeAlpenLight  = isMorning ? dawnAlpenLight  : duskAlpenLight;
      const activeAlpenShadow = isMorning ? dawnAlpenShadow : duskAlpenShadow;
      const activeTwilightSky = isMorning ? dawnSky         : duskSky;

      let sunLightCol, sunShadowCol, skyCol;
      let alpenWeight = 0.0;

      if (sunAltDeg > 6.0) {
        sunLightCol = baseLight;
        sunShadowCol = baseShadow;
        skyCol = daySky;
      } else if (sunAltDeg > 1.5) {
        const t = smoothstep(1.5, 6.0, sunAltDeg);
        sunLightCol = lerpVec3(activeGoldLight, baseLight, t);
        sunShadowCol = lerpVec3(activeGoldShadow, baseShadow, t);
        skyCol = lerpVec3(activeTwilightSky, daySky, t);
      } else if (sunAltDeg > -2.5) {
        const t = smoothstep(-2.5, 1.5, sunAltDeg);
        sunLightCol = lerpVec3(activeAlpenLight, activeGoldLight, t);
        sunShadowCol = lerpVec3(activeAlpenShadow, activeGoldShadow, t);
        skyCol = activeTwilightSky;
        const maxAlpen = isMorning ? 0.80 : 1.0;
        alpenWeight = Math.sin(t * Math.PI) * maxAlpen;
      } else if (sunAltDeg > -9.0) {
        // Утренняя заря/синий час (пробуждается плавно уже с -9.0°)
        const t = smoothstep(-9.0, -2.5, sunAltDeg);
        const blueHourLight = isMorning ? [0.36, 0.46, 0.70] : [0.32, 0.36, 0.64];
        const blueHourSha   = isMorning ? [0.08, 0.10, 0.20] : [0.07, 0.07, 0.18];
        sunLightCol = lerpVec3(blueHourLight, activeAlpenLight, t);
        sunShadowCol = lerpVec3(blueHourSha, activeAlpenShadow, t);
        skyCol = lerpVec3(nightSky, activeTwilightSky, t);
      } else {
        // Глубокая ночь: читаемая и пластичная
        sunLightCol = [0.35, 0.45, 0.68];
        sunShadowCol = [0.055, 0.075, 0.150];
        skyCol = nightSky;
      }

      // Затухание дневного солнца (рассвет начинает плавно вливаться с -8.0°, а не с -5.5°)
      const sunFade = smoothstep(-8.0, 1.0, sunAltDeg);

      // =====================================================================
      // 5. АСИММЕТРИЧНЫЙ КРОССФЕЙД (ЗАКАТ С ЛУНОЙ VS ПРЕДРАССВЕТ)
      // =====================================================================
      let finalLightVec;
      let finalLightColor;
      let finalShadowColor;
      let finalSunIntensity;

      if (!isMorning) {
        // --- ВЕЧЕР И ЗАКАТ ---
        const moonBlendWeight = smoothstep(1.0, -5.0, sunAltDeg);
        finalLightVec = normalizeVec3(lerpVec3(sunV, targetNightVec, moonBlendWeight));
        finalLightColor = lerpVec3(sunLightCol, moonLightCol, moonBlendWeight);
        finalShadowColor = lerpVec3(sunShadowCol, moonShadowCol, moonBlendWeight);

        const sunContribution = sunFade * 0.95;
        const moonContribution = nightLightIntensity * moonBlendWeight;
        finalSunIntensity = Math.max(0.18, sunContribution + moonContribution);

      } else {
        // --- НОЧЬ, ПРЕДРАССВЕТ И ВОСХОД ---
        // Плавный переход от звёздно-ночного света к восходу солнца (без 3-часовой тьмы)
        const dawnTransition = smoothstep(-7.0, 0.5, sunAltDeg);

        finalLightVec = normalizeVec3(lerpVec3(targetNightVec, sunV, dawnTransition));
        finalLightColor = lerpVec3(moonLightCol, sunLightCol, dawnTransition);
        finalShadowColor = lerpVec3(moonShadowCol, sunShadowCol, dawnTransition);

        // Фоновый ночной свет плавно уступает место рассвету:
        const nightPortion = nightLightIntensity * (1.0 - smoothstep(-6.0, -1.0, sunAltDeg));
        const sunPortion = sunFade * 0.95;

        // Минимальный пол зафиксирован на 0.18 (вместо 0.04) — рельеф всегда виден
        finalSunIntensity = Math.max(0.18, nightPortion + sunPortion);
      }


      return {
        sunVec: finalLightVec,
        lightColor: finalLightColor,
        shadowColor: finalShadowColor,
        skyColor: skyCol,
        alpenglowWeight: alpenWeight,
        sunIntensity: finalSunIntensity,
        warmCool: lerp(chosenTone.warmCool, 0.30, 1.0 - sunFade),
        isSwiss: false
      };
    }

    // Fallback
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

    return `#version 300 es
    precision highp float;
    precision highp int;

    ${defines.join('\n')}

    uniform sampler2D u_dem;
    uniform sampler2D u_gbuf;
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

    uniform float u_orenNayarRoughness;
    uniform float u_inkBleed;
    uniform float u_waterlining;

    #ifdef USE_HACHURE
    uniform float u_hachureDensity;
    uniform float u_hachureOpacity;
    uniform float u_hachureSlope;
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

    float computeCastShadowPx(ivec2 basePx, vec2 localCoord, float h0, vec3 sunDir, float maxSafeMeters) {
      if (u_useCastShadow < 0.5) return 1.0;
      if (sunDir.z <= 0.001) return 0.0;

      vec2 rayDir = normalize(sunDir.xy);
      float sunTan = max(0.14, sunDir.z / max(0.01, length(sunDir.xy)));
      float dither = hash(localCoord * 1.7) * 0.5;

      float shadowFactor = 1.0;
      float maxDistMeters = min(380.0 * u_shadowReach, maxSafeMeters);
      float stepPixels = 2.2;
      float stepMeters = stepPixels * u_metersPerPixel;

      float curMeters = (1.5 + dither) * stepMeters;
      vec2 curPxVec = vec2(basePx) + rayDir * ((1.5 + dither) * stepPixels);

      for (int i = 0; i < 20; i++) {
        if (curMeters > maxDistMeters) break;
        float terrainH = getRawHPx(ivec2(round(curPxVec)), h0);
        float rayH = h0 + (curMeters * sunTan) / u_zFactor;

        float diff = terrainH - rayH;
        if (diff > 0.0) {
          float occ = clamp(diff * 0.28, 0.0, 1.0);
          shadowFactor = min(shadowFactor, 1.0 - occ * u_shadowOpacity);
          if (shadowFactor < 0.2) break;
        }

        float scale = 1.0 + float(i) * 0.08;
        curMeters += stepMeters * scale;
        curPxVec += rayDir * (stepPixels * scale);
      }

      float horizonFade = smoothstep(0.04, 0.20, sunDir.z);
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

    float computeWaterlining(float h, float slope, vec2 px) {
      if (slope > 0.006) return 0.0;
      float ripple = sin(px.x * 0.3 + px.y * 0.3 + noise(px * 0.1) * 4.0);
      float bands = smoothstep(0.3, 0.7, sin(h * 6.28 + ripple * 0.5));
      return bands * smoothstep(0.006, 0.001, slope) * 0.45;
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
    float getWoodcutHatch(vec2 pRot, float luma, float scale, float density, vec2 gradDir) {
      vec2 d = normalize(rotate2D(gradDir, 0.785) + vec2(0.2, 0.8));
      float coord = dot(pRot, d) / max(1.0, scale * 3.2);
      float wave = abs(fract(coord) - 0.5) * 2.0;
      float thickness = clamp((1.0 - luma) * 0.85 * density, 0.05, 0.95);
      return smoothstep(thickness - 0.15, thickness + 0.15, wave);
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

    void main() {
      ivec2 tilePx = ivec2(gl_FragCoord.xy);
      vec4 g = texelFetch(u_gbuf, tilePx, 0);

      if (g.r == 0.0 && g.g == 0.0 && g.b == 0.0 && g.a == 0.0) {
        fragColor = vec4(0.0);
        return;
      }

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
        vec2 sunDir2D = normalize(u_sunDir.xy);
        float sin2A = (aspectDir.x * sunDir2D.y - aspectDir.y * sunDir2D.x) * dot(aspectDir, sunDir2D) * 2.0;
        float rotAngle = sin2A * (u_imhofDeflection * 0.45) * smoothstep(0.02, 0.25, slope);
        float cosR = cos(rotAngle);
        float sinR = sin(rotAngle);
        vec2 deflXY = vec2(sunDir2D.x * cosR - sunDir2D.y * sinR, sunDir2D.x * sinR + sunDir2D.y * cosR);
        effectiveSunDir = normalize(vec3(deflXY * length(u_sunDir.xy), u_sunDir.z));
      }

      float wrappedLight;
      float castShadow = 1.0;

      #ifdef USE_MDOW
        vec3 dir1 = effectiveSunDir;
        vec3 dir2 = normalize(vec3(effectiveSunDir.y, -effectiveSunDir.x, effectiveSunDir.z * 1.1));
        vec3 dir3 = normalize(vec3(-effectiveSunDir.y, effectiveSunDir.x, effectiveSunDir.z * 0.9));
        vec3 dir4 = normalize(vec3(-effectiveSunDir.x * 0.5, -effectiveSunDir.y * 0.5, 0.75));

        float l1 = getOrenNayarLight(norm, dir1, u_orenNayarRoughness, u_lightWrap);
        float l2 = getOrenNayarLight(norm, dir2, u_orenNayarRoughness, u_lightWrap * 0.7);
        float l3 = getOrenNayarLight(norm, dir3, u_orenNayarRoughness, u_lightWrap * 0.7);
        float l4 = max(0.0, dot(norm, dir4));

        wrappedLight = l1 * 0.55 + l2 * 0.20 + l3 * 0.15 + l4 * 0.10;
      #else
        wrappedLight = getOrenNayarLight(norm, effectiveSunDir, u_orenNayarRoughness, u_lightWrap);
      #endif

      castShadow = computeCastShadowPx(basePx, v_tileLocalPx, centerH, effectiveSunDir, maxSafeMeters);
      castShadow = mix(1.0, castShadow, clamp(u_sunIntensity * 1.15, 0.25, 1.0));
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

      if (u_isManualMode == 1) {
        float peakFactor = clamp(elevFactor + crestGlint * 0.4, 0.0, 1.0);
        warmSunCol = mix(u_manualColorValley, u_manualColorPeak, peakFactor);
        float valleyInfluence = 1.0 - elevFactor;
        coolShaCol = mix(coolShaCol, u_manualColorValley * 0.75, valleyInfluence * 0.65);
      } else {
        float peakExposure = pow(hNorm, 1.35) + crestGlint * 0.45;
        float alpenFactor = u_alpenglowWeight * smoothstep(0.30, 0.90, peakExposure);
        vec3 alpenTint = vec3(1.20, 0.45, 0.52);
        warmSunCol = mix(warmSunCol, warmSunCol * alpenTint + vec3(0.15, 0.02, 0.05), alpenFactor * 0.75);
        directLight += alpenFactor * 0.25;
      }

      float boostDiff = u_lightBoost - 1.0;
      float peakness = clamp(pow(hNorm, 1.5) * 0.65 + ridgeness * 0.35, 0.0, 1.0);
      float sunFacing = smoothstep(0.10, 0.80, directLight);
      float twilightDamp = mix(1.0, 0.55, u_alpenglowWeight);

      float gain = boostDiff * mix(0.20, 1.30, peakness) * mix(0.50, 1.0, sunFacing) * twilightDamp;
      gain += max(0.0, boostDiff) * crestGlint * 1.1 * twilightDamp;

      // Гарантируем, что при boostDiff >= 0 свет никогда не становится темнее исходного:
      warmSunCol *= (1.0 + max(-0.8, gain));

      float maxComponent = max(warmSunCol.r, max(warmSunCol.g, warmSunCol.b));
      if (maxComponent > 1.05) {
        float compressed = 1.05 + (maxComponent - 1.05) / (1.0 + (maxComponent - 1.05) * 0.85);
        warmSunCol *= (compressed / maxComponent);
      }

      vec3 ambientSky = mix(coolShaCol, u_skyColor, 0.45 * u_imhofWarmCool);
      vec3 ambientTerrain = (u_isManualMode == 1) ? mix(coolShaCol, warmSunCol, 0.35) : ambientSky;
      vec3 litTerrain = mix(coolShaCol, warmSunCol, directLight);
      float totalLightWeight = clamp(directLight + skyFill * svf * 0.55 * max(0.3, u_sunIntensity), 0.0, 1.0);
      vec3 finalCol = mix(ambientTerrain, litTerrain, totalLightWeight);

      float isNight = smoothstep(0.15, 0.50, u_lightColor.b - u_lightColor.r);
      float nightGlintBoost = mix(1.0, 2.4, isNight);
      vec3 silverRimCol = mix(warmSunCol, vec3(0.85, 0.95, 1.25), isNight * 0.65);
      finalCol += silverRimCol * (crestGlint * svf * 0.45 * nightGlintBoost);

      if (isNight > 0.05) {
        float valleyDepth = clamp((1.0 - hNorm) * (1.0 - svf * 0.7), 0.0, 1.0);
        finalCol = mix(finalCol, vec3(0.04, 0.08, 0.16), valleyDepth * 0.35 * isNight);
      }

      finalCol *= aoVal;
      finalCol *= mix(1.0, svf, min(1.0, u_svfStrength * 0.45));

      #ifdef USE_HACHURE
      if (slope > u_hachureSlope) {
        float density = max(0.3, u_hachureDensity);
        float slopeFactor = smoothstep(u_hachureSlope, u_hachureSlope * 3.2, slope);
        float sunMod = mix(1.0, clamp(1.25 - directLight, 0.15, 1.0), u_hachureLightMod);
        float hachureDarkness = 0.0;

        vec2 hachureCoord = v_tileLocalPx;
        if (u_inkBleed > 0.5) {
          hachureCoord += (hash(hachureCoord * 4.0) - 0.5) * 0.35;
        }

        #if defined(HACHURE_LEHMANN)
          vec2 gradDir = normalize(vec2(dzdx, dzdy));
          vec2 perpDir = vec2(-gradDir.y, gradDir.x);
          float stripe = sin(dot(hachureCoord, perpDir) * density * 1.8);
          float rowMask = smoothstep(-0.2, 0.2, sin(dot(hachureCoord, gradDir) * density * 0.6));
          float lehmannThickness = clamp(slope * 1.5, 0.1, 0.95);
          hachureDarkness = smoothstep(1.0 - lehmannThickness, 1.0, stripe) * rowMask * slopeFactor;
        #elif defined(HACHURE_ROCK)
          float ridge = clamp(crestGlint * 2.5, 0.0, 1.0);
          float couloir = clamp(slope * 0.4, 0.0, 1.0);
          vec2 rockDir = normalize(vec2(-dzdy * 0.3 + dzdx * 0.7, dzdx * 0.3 + dzdy * 0.7));
          float rockStripe = sin(dot(hachureCoord, rockDir) * density * 2.2);
          hachureDarkness = smoothstep(0.1, 0.8, rockStripe) * slopeFactor * couloir * 0.85;
          finalCol += warmSunCol * (ridge * slopeFactor * 0.35);
        #else
          vec2 dirAlongContour = normalize(vec2(-dzdy, dzdx));
          hachureDarkness = smoothstep(0.18, 0.78, sin(dot(hachureCoord, dirAlongContour) * 1.6 * density)) * slopeFactor;
        #endif

        if (u_inkBleed > 0.5 && hachureDarkness > 0.2) {
          finalCol -= vec3(smoothstep(0.2, 0.9, hachureDarkness) * 0.08);
        }

        finalCol = mix(finalCol, u_hachureColor, clamp(hachureDarkness * u_hachureOpacity * sunMod, 0.0, 1.0));
      }
      #endif

      if (u_hypso > 0) {
        finalCol = mix(finalCol, finalCol * getVintageHypso(centerH), 0.70);
      }

      vec2 grainPos = v_tileLocalPx;
      if (u_inkBleed > 0.5) {
        grainPos += vec2(
          hash(grainPos * 3.7 + vec2(1.2, 4.5)) - 0.5,
          hash(grainPos * 3.7 + vec2(8.1, 2.3)) - 0.5
        ) * 1.2;
        float edgeBleed = smoothstep(0.3, 0.7, directLight) * (1.0 - smoothstep(0.3, 0.7, directLight));
        finalCol -= vec3(edgeBleed * 0.05);
        finalCol -= vec3(clamp(slope * 0.25, 0.0, 0.09) * (1.0 - directLight * 0.45));
      }

      float paperGrain = ((hash(grainPos * 2.5) - 0.5) * 0.7 + (noise(grainPos * 0.35) - 0.5) * 0.3) * (u_paperGrain * 0.22);
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
          ditherMask = getWoodcutHatch(pRot, luma, dScale, u_ditherDensity, vec2(dzdx, dzdy));
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
        float waterLine = computeWaterlining(centerH, slope, v_tileLocalPx);
        if (waterLine > 0.01) {
          finalCol = mix(finalCol, mix(finalCol, vec3(0.18, 0.32, 0.45), 0.75), waterLine);
        }
      }

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
      flags.dither ? (flags.ditherType || 'blue') : '0'
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
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Light Program Link Error:', gl.getProgramInfoLog(prog));
    }

    const locs = {
      dem: gl.getUniformLocation(prog, 'u_dem'),
      gbuf: gl.getUniformLocation(prog, 'u_gbuf'),
      iRes: gl.getUniformLocation(prog, 'u_iRes'),
      pad: gl.getUniformLocation(prog, 'u_pad'),
      uvOrigin: gl.getUniformLocation(prog, 'u_uvOrigin'),
      uvScale: gl.getUniformLocation(prog, 'u_uvScale'),
      sunDir: gl.getUniformLocation(prog, 'u_sunDir'),
      lightColor: gl.getUniformLocation(prog, 'u_lightColor'),
      shadowColor: gl.getUniformLocation(prog, 'u_shadowColor'),
      skyColor: gl.getUniformLocation(prog, 'u_skyColor'),
      alpenglowWeight: gl.getUniformLocation(prog, 'u_alpenglowWeight'),
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
      lightWrap: gl.getUniformLocation(prog, 'u_lightWrap'),
      paperGrain: gl.getUniformLocation(prog, 'u_paperGrain'),
      mpp: gl.getUniformLocation(prog, 'u_metersPerPixel'),
      orenNayarRoughness: gl.getUniformLocation(prog, 'u_orenNayarRoughness'),
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

      // Штриховка (только если USE_HACHURE)
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
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;

    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });

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

  if (window.requestIdleCallback) {
    requestIdleCallback(() => initSharedGl());
  }

  // =========================================================================
  // РЕНДЕР ОТМЫВКИ В ХОЛСТ ТАЙЛА
  // =========================================================================
  function renderTileHillshade(img, lat, zoom, lighting, targetCanvas = null, coords = null) {
    initSharedGl();
    if (!sharedGl) return null;
    const gl = sharedGl;

    const P = img.width || 256;
    const S = img._tileSize || 256;
    const B = img._pad || 0;

    if (gl.canvas.width !== S || gl.canvas.height !== S) {
      gl.canvas.width = S;
      gl.canvas.height = S;
    }

    const mppBase = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const currentMpp = mppBase / (S / 256.0);
    const effZ = getEffectiveZFactor();
    const vStats = getViewportElevationStats(zoom);

    // 1. Управление текстурой исходного DEM
    let tileTex = targetCanvas ? targetCanvas._demTex : null;
    if (!tileTex || targetCanvas._demTexWidth !== P || targetCanvas._demTexHeight !== P) {
      if (tileTex) gl.deleteTexture(tileTex);
      tileTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, P, P);

      if (targetCanvas) {
        targetCanvas._demTex = tileTex;
        targetCanvas._demTexWidth = P;
        targetCanvas._demTexHeight = P;
      }
    }

    if (!targetCanvas || targetCanvas._cachedDemImg !== img) {
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, img);
      if (targetCanvas) targetCanvas._cachedDemImg = img;
    }

    // 2. Управление текстурами G-Buffer (_gBuf0 и _gBuf1)
    if (targetCanvas && (!targetCanvas._gBuf || targetCanvas._gBufWidth !== S)) {
       if (targetCanvas._gBuf) {
         gl.deleteTexture(targetCanvas._gBuf);
       }
       const t = gl.createTexture();
       gl.bindTexture(gl.TEXTURE_2D, t);
       gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
       gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
       gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
       gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
       // Стандартный RGBA8 без расширений и без Float16
       gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, S, S);

       targetCanvas._gBuf = t;
       targetCanvas._gBufWidth = S;
       targetCanvas._geomVersion = -1;
     }

    // 3. ПРОХОД 1: ЗАПЕКАНИЕ ГЕОМЕТРИИ (выполняется 1 раз при загрузке или смене рельефа)
    const needGeomPass = !targetCanvas || targetCanvas._geomVersion !== globalGeomVersion || targetCanvas._cachedZ !== effZ;
    if (needGeomPass && targetCanvas && targetCanvas._gBuf) {
       gl.bindFramebuffer(gl.FRAMEBUFFER, sharedFbo);
       gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetCanvas._gBuf, 0);
       // Больше НИКАКИХ gl.drawBuffers - стандартный COLOR_ATTACHMENT0
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

      gl.uniform1f(geomLocations.elevMin, vStats.minH);
      gl.uniform1f(geomLocations.elevSpan, Math.max(10.0, vStats.span));

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      targetCanvas._geomVersion = globalGeomVersion;
      targetCanvas._cachedZ = effZ;
    }

    // 4. ПРОХОД 2: МГНОВЕННОЕ ОСВЕЩЕНИЕ (60+ FPS при кручении времени)
    gl.viewport(0, 0, S, S);

    // Получаем программу с нужной конфигурацией модулей (из кэша)
    const activeProgramEntry = getOrCreateLightProgram(gl, {
      mdow: !!cfg.mdowEnabled,
      hachure: !!cfg.hachureEnabled,
      hachureType: cfg.hachureType,
      dither: !!cfg.ditherEnabled,
      ditherType: cfg.ditherType
    });

    const activeProg = activeProgramEntry.prog;
    const lightLocations = activeProgramEntry.locs;

    gl.useProgram(activeProg);
    gl.bindVertexArray(sharedVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tileTex);
    if (lightLocations.dem) gl.uniform1i(lightLocations.dem, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targetCanvas ? targetCanvas._gBuf : tileTex);
    if (lightLocations.gbuf) gl.uniform1i(lightLocations.gbuf, 1);

    if (lightLocations.iRes) gl.uniform2i(lightLocations.iRes, P, P);
    if (lightLocations.pad) gl.uniform1f(lightLocations.pad, B);
    if (lightLocations.uvOrigin) gl.uniform2f(lightLocations.uvOrigin, B / P, B / P);
    if (lightLocations.uvScale) gl.uniform2f(lightLocations.uvScale, S / P, S / P);

    if (lightLocations.sunDir) gl.uniform3f(lightLocations.sunDir, lighting.sunVec[0], lighting.sunVec[1], lighting.sunVec[2]);
    if (lightLocations.lightColor) gl.uniform3f(lightLocations.lightColor, lighting.lightColor[0], lighting.lightColor[1], lighting.lightColor[2]);
    if (lightLocations.shadowColor) gl.uniform3f(lightLocations.shadowColor, lighting.shadowColor[0], lighting.shadowColor[1], lighting.shadowColor[2]);
    if (lightLocations.skyColor) gl.uniform3f(lightLocations.skyColor, lighting.skyColor[0], lighting.skyColor[1], lighting.skyColor[2]);
    if (lightLocations.alpenglowWeight) gl.uniform1f(lightLocations.alpenglowWeight, lighting.alpenglowWeight !== undefined ? lighting.alpenglowWeight : 0.0);
    if (lightLocations.sunIntensity) gl.uniform1f(lightLocations.sunIntensity, lighting.sunIntensity !== undefined ? lighting.sunIntensity : 1.0);
    if (lightLocations.zFactor) gl.uniform1f(lightLocations.zFactor, effZ);
    if (lightLocations.mode) gl.uniform1i(lightLocations.mode, lighting.isSwiss ? 1 : 0);
    if (lightLocations.hypso) gl.uniform1i(lightLocations.hypso, { none: 0, atlas: 1 }[cfg.hypsoMode] || 0);

    if (lightLocations.useSVF) gl.uniform1f(lightLocations.useSVF, cfg.svfEnabled !== false ? 1.0 : 0.0);
    if (lightLocations.svfStrength) gl.uniform1f(lightLocations.svfStrength, cfg.svfStrength !== undefined ? cfg.svfStrength : 0.85);

    if (lightLocations.useCastShadow) gl.uniform1f(lightLocations.useCastShadow, cfg.castShadows ? 1.0 : 0.0);
    if (lightLocations.shadowReach) gl.uniform1f(lightLocations.shadowReach, cfg.shadowReach || 1.0);
    if (lightLocations.shadowOpacity) gl.uniform1f(lightLocations.shadowOpacity, cfg.shadowOpacity !== undefined ? cfg.shadowOpacity : 0.60);

    // Параметры штриховки (передаются только если модуль скомпилирован)
    if (cfg.hachureEnabled) {
      if (lightLocations.hachureDensity) gl.uniform1f(lightLocations.hachureDensity, cfg.hachureDensity || 1.0);
      if (lightLocations.hachureOpacity) gl.uniform1f(lightLocations.hachureOpacity, cfg.hachureOpacity !== undefined ? cfg.hachureOpacity : 0.75);
      if (lightLocations.hachureSlope) gl.uniform1f(lightLocations.hachureSlope, cfg.hachureSlope !== undefined ? cfg.hachureSlope : 0.08);
      if (lightLocations.hachureLightMod) gl.uniform1f(lightLocations.hachureLightMod, cfg.hachureLightMod !== undefined ? cfg.hachureLightMod : 0.60);
      if (lightLocations.hachureColor) {
        const hachCol = hexToVec3(cfg.hachureColor || '#1c1917');
        gl.uniform3f(lightLocations.hachureColor, hachCol[0], hachCol[1], hachCol[2]);
      }
    }

    if (lightLocations.imhofDeflection) gl.uniform1f(lightLocations.imhofDeflection, cfg.imhofDeflection !== undefined ? cfg.imhofDeflection : 0.35);
    if (lightLocations.imhofWarmCool) gl.uniform1f(lightLocations.imhofWarmCool, lighting.warmCool !== undefined ? lighting.warmCool : 0.85);
    if (lightLocations.lightWrap) gl.uniform1f(lightLocations.lightWrap, cfg.lightWrap !== undefined ? cfg.lightWrap : 0.35);
    if (lightLocations.paperGrain) gl.uniform1f(lightLocations.paperGrain, cfg.paperGrain !== undefined ? cfg.paperGrain : 0.4);
    if (lightLocations.mpp) gl.uniform1f(lightLocations.mpp, currentMpp);
    if (lightLocations.orenNayarRoughness) gl.uniform1f(lightLocations.orenNayarRoughness, cfg.orenNayarRoughness !== undefined ? cfg.orenNayarRoughness : 0.5);
    if (lightLocations.inkBleed) gl.uniform1f(lightLocations.inkBleed, cfg.inkBleed !== false ? 1.0 : 0.0);
    if (lightLocations.waterlining) gl.uniform1f(lightLocations.waterlining, cfg.waterlining !== false ? 1.0 : 0.0);

    // Параметры дизеринга (передаются только если модуль скомпилирован)
    if (cfg.ditherEnabled) {
      const ditherBlendMap = { normal: 0, multiply: 1, overlay: 2, softlight: 3, screen: 4, burn: 5, difference: 6 };
      if (lightLocations.ditherBlend) gl.uniform1i(lightLocations.ditherBlend, ditherBlendMap[cfg.ditherBlendMode] !== undefined ? ditherBlendMap[cfg.ditherBlendMode] : 1);
      if (lightLocations.ditherScale) gl.uniform1f(lightLocations.ditherScale, cfg.ditherScale || 1.0);
      if (lightLocations.ditherAngle) gl.uniform1f(lightLocations.ditherAngle, cfg.ditherAngle !== undefined ? cfg.ditherAngle : 45.0);
      if (lightLocations.ditherDensity) gl.uniform1f(lightLocations.ditherDensity, cfg.ditherDensity !== undefined ? cfg.ditherDensity : 1.0);
      if (lightLocations.ditherThreshold) gl.uniform1f(lightLocations.ditherThreshold, cfg.ditherThreshold !== undefined ? cfg.ditherThreshold : 0.60);
      if (lightLocations.ditherLowCut) gl.uniform1f(lightLocations.ditherLowCut, cfg.ditherLowCut !== undefined ? cfg.ditherLowCut : 0.00);
      if (lightLocations.ditherSoftness) gl.uniform1f(lightLocations.ditherSoftness, cfg.ditherSoftness !== undefined ? cfg.ditherSoftness : 0.20);
      if (lightLocations.ditherColor) {
        const dithCol = hexToVec3(cfg.ditherColor || '#1a1614');
        gl.uniform3f(lightLocations.ditherColor, dithCol[0], dithCol[1], dithCol[2]);
      }
      const ditherZoneMap = { shadows: 0, highlights: 1, all: 2 };
      if (lightLocations.ditherZone) gl.uniform1i(lightLocations.ditherZone, ditherZoneMap[cfg.ditherZone] !== undefined ? ditherZoneMap[cfg.ditherZone] : 0);
      if (lightLocations.ditherStrength) gl.uniform1f(lightLocations.ditherStrength, cfg.ditherStrength !== undefined ? cfg.ditherStrength : 0.85);
    }

    if (lightLocations.lightBoost) gl.uniform1f(lightLocations.lightBoost, cfg.lightBoost !== undefined ? cfg.lightBoost : 1.0);
    if (lightLocations.isManualMode) gl.uniform1i(lightLocations.isManualMode, (cfg.sunMode === 'manual') ? 1 : 0);
    if (lightLocations.debugValley) gl.uniform1i(lightLocations.debugValley, cfg.debugValley ? 1 : 0);

    if (lightLocations.manualColorPeak) {
      const colPeak = hexToVec3(cfg.manualPeakColor || '#fff8e7');
      gl.uniform3f(lightLocations.manualColorPeak, colPeak[0], colPeak[1], colPeak[2]);
    }
    if (lightLocations.manualColorValley) {
      const colValley = hexToVec3(cfg.manualValleyColor || '#ffd8a8');
      gl.uniform3f(lightLocations.manualColorValley, colValley[0], colValley[1], colValley[2]);
    }
    if (lightLocations.manualLightBlend) gl.uniform1f(lightLocations.manualLightBlend, cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.5);

    if (lightLocations.elevMin) gl.uniform1f(lightLocations.elevMin, vStats.minH);
    if (lightLocations.elevSpan) gl.uniform1f(lightLocations.elevSpan, Math.max(10.0, vStats.span));

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    if (targetCanvas) {
      const ctx = targetCanvas.getContext('2d');
      ctx.drawImage(gl.canvas, 0, 0, 256, 256);
      return targetCanvas;
    } else {
      const out = document.createElement('canvas');
      out.width = 256;
      out.height = 256;
      out.getContext('2d').drawImage(gl.canvas, 0, 0, 256, 256);
      return out;
    }
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

  async function fetchSingleTile(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const resp = await fetch(url, { signal: controller.signal, mode: 'cors' });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error('404 or Network Error');
      const blob = await resp.blob();

      if ('createImageBitmap' in window) {
        try {
          return await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none'
          });
        } catch (e) {}
      }

      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Decode error'));
        img.src = URL.createObjectURL(blob);
      });
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
    const ctx = cv.getContext('2d', { willReadFrequently: true });
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
    const subX = targetCoords.x % factor;
    const subY = targetCoords.y % factor;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    const out = imgData.data;

    const clampVal = (v, max) => (v < 0 ? 0 : (v > max ? max : v));

    for (let y = 0; y < 256; y++) {
      const fy = ((subY + (y + 0.5) / 256) / factor) * h - 0.5;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const yA = clampVal(y0, h - 1) * w;
      const yB = clampVal(y0 + 1, h - 1) * w;

      for (let x = 0; x < 256; x++) {
        const fx = ((subX + (x + 0.5) / 256) / factor) * w - 0.5;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const xA = clampVal(x0, w - 1);
        const xB = clampVal(x0 + 1, w - 1);

        const h00 = grid[yA + xA];
        const h10 = grid[yA + xB];
        const h01 = grid[yB + xA];
        const h11 = grid[yB + xB];

        const outIdx = (y * 256 + x) * 4;
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
      try {
        const pData = ctx.getImageData(B, B, S, S).data;
        let tMin = Infinity, tMax = -Infinity;
        for (let i = 0; i < pData.length; i += 16) {
          if (pData[i + 3] > 30) {
            const h = (pData[i] * 256 + pData[i + 1] + pData[i + 2] / 256) - 32768;
            if (h > -1000 && h < 9000) {
              if (h < tMin) tMin = h;
              if (h > tMax) tMax = h;
            }
          }
        }
        if (tMin !== Infinity && coords) {
          cv._minH = tMin;
          cv._maxH = tMax;
          registerTileElevation(coords, tMin, tMax);
          if (tMax - tMin > 5.0) {
            currentRegionalSpan = Math.max(currentRegionalSpan, tMax - tMin);
          }
        }
      } catch (e) {}
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
          for (let i = 0; i < templates.length; i++) {
            const url = L.Util.template(templates[i], { z: curZ, x: curX, y: curY });
            try {
              const loaded = await fetchSingleTile(url);
              setDemMemoryCache(cacheKey, loaded);
              if (curZ === origZ) return loaded;
              return cropParentTile(loaded, coords, { z: curZ, x: curX, y: curY });
            } catch (err) {}
          }
          dem404Set.add(cacheKey);
        }

        curZ -= 1;
        curX = Math.floor(curX / 2);
        curY = Math.floor(curY / 2);
      }
      throw new Error(`DEM Tile not available ${coords.z}/${coords.x}/${coords.y}`);
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

  // =========================================================================
  // LEAFLET GRID LAYERS
  // =========================================================================
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
           if (tile._demTex) sharedGl.deleteTexture(tile._demTex);
           if (tile._gBuf) sharedGl.deleteTexture(tile._gBuf);
           tile._demTex = null;
           tile._gBuf = null;
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
          const mapCenter = WM.map ? WM.map.getCenter() : centerLatLng;
          const lighting = getSunLighting(mapCenter.lat, mapCenter.lng);

          renderTileHillshade(img, centerLatLng.lat, coords.z, lighting, tile, coords);
          done(null, tile);
        })
        .catch((err) => {
          if (err && err.message !== 'Timeout' && !err.message.includes('404')) {
            console.error('DEM render error:', err);
          }
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
    const tiles = hillshadeLayerInstance._tiles;
    if (!tiles) return;

    const map = WM.map;
    const center = map.getCenter();
    const lighting = getSunLighting(center.lat, center.lng);
    const bounds = map.getBounds();
    const tileSize = hillshadeLayerInstance.getTileSize();

    const visibleTiles = [];
    const bufferTiles = [];

    for (const key in tiles) {
      const tileEntry = tiles[key];
      const el = tileEntry ? tileEntry.el : null;
      if (!el || !el._demImg || !el._demCoords) continue;

      const nwPt = tileEntry.coords.scaleBy(tileSize);
      const sePt = nwPt.add(tileSize);
      const nwLatLng = map.unproject(nwPt, tileEntry.coords.z);
      const seLatLng = map.unproject(sePt, tileEntry.coords.z);
      const tileBounds = L.latLngBounds(nwLatLng, seLatLng);

      if (bounds.intersects(tileBounds)) {
        visibleTiles.push(el);
      } else {
        bufferTiles.push(el);
      }
    }

    for (let i = 0; i < visibleTiles.length; i++) {
      const canvas = visibleTiles[i];
      canvas._demNeedsRedraw = false;
      renderTileHillshade(
        canvas._demImg,
        canvas._demLat || center.lat,
        canvas._demCoords.z,
        lighting,
        canvas,
        canvas._demCoords
      );
    }

    for (let i = 0; i < bufferTiles.length; i++) {
      bufferTiles[i]._demNeedsRedraw = true;
    }
  }

  function scheduleLiveHillshade() {
    if (liveHillshadeRaf) return;
    liveHillshadeRaf = requestAnimationFrame(() => {
      liveHillshadeRaf = 0;
      updateLiveHillshade();
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

    const sliderRough = document.getElementById('dem-hud-roughness-slider');
    const valRough = document.getElementById('dem-hud-roughness-val');
    if (sliderRough && valRough) {
      const rPct = Math.round((cfg.orenNayarRoughness !== undefined ? cfg.orenNayarRoughness : 0.5) * 100);
      sliderRough.value = rPct;
      valRough.textContent = rPct + '%';
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
    if (selHachType) selHachType.value = cfg.hachureType || 'classic';

    const colHach = document.getElementById('dem-hud-hachure-color');
    if (colHach) colHach.value = cfg.hachureColor || '#1c1917';

    const sliderHachOp = document.getElementById('dem-hud-hachure-opacity-slider');
    const valHachOp = document.getElementById('dem-hud-hachure-opacity-val');
    if (sliderHachOp && valHachOp) {
      const v = Math.round((cfg.hachureOpacity !== undefined ? cfg.hachureOpacity : 0.75) * 100);
      sliderHachOp.value = v;
      valHachOp.textContent = v + '%';
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
              el._demTex = null;
              el._gBuf = null;
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
      const sliderVal = parseFloat(e.target.value);
      const mapCenter = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const curDate = new Date();
      
      const h = WM.timeWarp 
        ? WM.timeWarp.sliderToHour(sliderVal, mapCenter.lat, mapCenter.lng, curDate) 
        : (sliderVal / 60);

      document.getElementById('dem-hud-time-val').textContent = formatHourString(h, mapCenter.lat, mapCenter.lng, curDate);
      
      WM.demRelief.setConfig({
        manualTimeHour: h,
        sunMode: 'time'
      });
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

    document.getElementById('dem-hud-azimuth-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-azimuth-val').textContent = val + '°';
      cfg.sunAzimuth = val;
      cfg.sunMode = 'manual';
      saveConfig();
      scheduleLiveHillshade();
    });

    document.getElementById('dem-hud-altitude-slider')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-altitude-val').textContent = val + '°';
      cfg.sunAltitude = val;
      cfg.sunMode = 'manual';
      saveConfig();
      scheduleLiveHillshade();
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
        (cfg.ditherEnabled && newCfg.ditherType !== undefined && newCfg.ditherType !== oldCfg.ditherType)
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
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.aoSlopeBleed !== undefined && newCfg.aoSlopeBleed !== oldCfg.aoSlopeBleed ||
        newCfg.svfEnabled !== undefined && newCfg.svfEnabled !== oldCfg.svfEnabled ||
        newCfg.svfStrength !== undefined && newCfg.svfStrength !== oldCfg.svfStrength ||
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

      renderHudUI();
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
      map.on('moveend', onMapMoveEnd);

      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    }
  };
})();
