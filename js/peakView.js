(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  if (WM.peakView && WM.peakView._loaded) return;

  // ---------------------------------------------------------------------------
  // Оптимизация ресурсов (кратко):
  //  • PERF — профиль устройства (tier 0/1/2) + бюджеты памяти; на tier 2 всё как раньше.
  //  • Контекст WebGL2: запасные наборы атрибутов, один автоповтор, понятное сообщение + «Повторить».
  //  • Потеря контекста: пауза против цикла «потеря–восстановление», авто-понижение tier, таймаут 8 с.
  //  • Буферы кадра: проверка полноты/OOM, авто-уменьшение разрешения, освобождение при сворачивании,
  //    в фоне и в простое; лимит пикселей по tier; динамическое разрешение при устойчивых < ~18 к/с.
  //  • Шейдеры компилируются пакетом (параллельно), исходники освобождаются после линковки.
  //  • Тени: на телефонах один каскад за кадр (не один тяжёлый проход), 512 px на слабых чипах.
  //  • Кэши данных (DEM, кроны, результаты источников): LRU с лимитом по байтам, освобождение canvas.
  //  • Таймер GPU и depth экранного буфера отключены (не нужны вне оверлея производительности).
  // ---------------------------------------------------------------------------

  // ===========================================================================
  // 0. УТИЛИТЫ И МАТЕМАТИКА
  // ===========================================================================
  const LSK = 'wm_pkv_';
  const DEG = Math.PI / 180;
  const R_EARTH = 6378137;
  const OUTER_HALF = 45000;
  const OUTER_N = 400;
  const MID_HALF = 18000;
  const MID_N = 450;
  const INNER_HALF = 3200;
  const ZOOM_N = 320;

  const ZOOM_MIN_FOV = 36;
  const ZOOM_HIDE_FOV = 52;
  const INNER_N = 384;
  const CANOPY_HALF = 2200;
  const CANOPY_N = 360;
  const CANOPY_FAR_HALF = 8000;
  const CANOPY_FAR_N = 360;
  const VEC_HALF = 8000;
  const WALK_LIMIT = 2400;
  const BLD_HALF = 2600;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const pad2 = n => String(n).padStart(2, '0');
  const fmtH = h => { h = ((h % 24) + 24) % 24; const m = Math.round(h * 60) % 1440; return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); };
  const fmtDist = m => m >= 1000 ? (m >= 10000 ? (m / 1000).toFixed(1) : (m / 1000).toFixed(2)) + ' км' : Math.round(m) + ' м';
  const isMobile = () => !!((window.L && L.Browser && L.Browser.mobile) || (window.matchMedia && matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 820));

  // ===========================================================================
  // 0.1 ПРОФИЛЬ УСТРОЙСТВА И БЮДЖЕТЫ РЕСУРСОВ
  //   tier 0 — слабый телефон, 1 — обычный телефон / слабый ПК, 2 — ПК и мощные устройства.
  //   На tier 2 все бюджеты равны прежним значениям модуля (ничего не урезается).
  //   Если браузер сообщает о проблемах (потеря контекста, нехватка видеопамяти), tier
  //   автоматически понижается и это запоминается на 12 часов.
  // ===========================================================================
  const PERF = (() => {
    const KEY = LSK + 'perf';
    const TABLE = [
      // tier 0
      { demMemoMax: 48,  demMemoBytes: 40 << 20,  canopyMemoMax: 100, dcMax: 8,  tileWorkers: 2, canopySlots: 2, shadowSize: 512, maxPixels: 1.3e6 },
      // tier 1
      { demMemoMax: 140, demMemoBytes: 110 << 20, canopyMemoMax: 280, dcMax: 14, tileWorkers: 3, canopySlots: 3, shadowSize: 768, maxPixels: 3.6e6 },
      // tier 2 (как было)
      { demMemoMax: 320, demMemoBytes: 480 << 20, canopyMemoMax: 600, dcMax: 30, tileWorkers: 4, canopySlots: 3, shadowSize: 768, maxPixels: 12e6 }
    ];
    const mem = +navigator.deviceMemory || 0;
    const cores = +navigator.hardwareConcurrency || 4;
    const mobile = isMobile();
    let base = mobile ? 1 : 2;
    if (mobile && ((mem && mem <= 3) || cores <= 4)) base = 0;
    if (!mobile && ((mem && mem <= 2) || cores <= 2)) base = 1;

    let drop = 0, lastDegradeTs = 0;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && Date.now() - s.t < 12 * 3600e3) drop = clamp(s.d | 0, 0, 2);
    } catch (e) {}

    const P = { mobile, mem, cores, gpu: '', tier: 0, drop, reasons: [] };
    P.apply = () => { P.tier = clamp(base - P.drop, 0, 2); Object.assign(P, TABLE[P.tier]); };
    P.apply();

    // Уточнение по видеокарте (вызывается сразу после создания WebGL-контекста)
    P.setGpu = gl => {
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        P.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
        if (/Mali-4|Mali-T[0-8]\d\d|Mali-G[0-5]\d\b|Adreno[^0-9]*[2-5]\d\d\b|PowerVR|SGX|VideoCore|llvmpipe|SwiftShader|Software/i.test(P.gpu) || maxTex < 4096) {
          base = Math.min(base, 0);
        }
      } catch (e) {}
      P.apply();
    };

    // Сигнал о проблеме: понижаем tier (не чаще раза в 15 с), запоминаем
    P.degrade = reason => {
      const now = Date.now();
      P.reasons.push(reason);
      if (P.reasons.length > 20) P.reasons.shift();
      if (now - lastDegradeTs < 15000) return;
      lastDegradeTs = now;
      if (P.tier <= 0) return;
      P.drop = Math.min(2, P.drop + 1);
      P.apply();
      try { localStorage.setItem(KEY, JSON.stringify({ d: P.drop, t: now })); } catch (e) {}
      console.warn('[PeakView] профиль понижен до tier ' + P.tier + ' (' + reason + ')');
    };
    return P;
  })();

  const hex3 = h => {
    const n = parseInt((h || '#000000').slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  };
  const lin3 = c => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  }

  const withTimeout = (p, ms, msg) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg || 'таймаут')), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });

  function degToCompass(deg) {
    const d = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
    return d[Math.floor(((deg % 360 + 360) % 360) / 22.5 + 0.5) % 16];
  }

  function unwrapAngle(target, current) {
    let diff = (target - current) % 360;
    if (diff < -180) diff += 360;
    if (diff > 180) diff -= 360;
    return current + diff;
  }

  const M4 = {
    persp(fovy, aspect, n, f, o) {
      const t = 1 / Math.tan(fovy / 2);
      o.fill(0);
      o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
      return o;
    },
    lookAt(e, c, u, o) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
      o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
      o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
      o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
      o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
      o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]);
      o[15] = 1;
      return o;
    },
    mul(a, b, o) {
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    inv(a, out) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    }
  };

  // ===========================================================================
  // 1. ГЕОГРАФИЯ И ПРОЕКЦИЯ МЕРКАТОРА
  // ===========================================================================
  const lngToX = lng => (lng + 180) / 360;
  const latToY = lat => { const s = Math.sin(clamp(lat, -85.05, 85.05) * DEG); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const xyToLng = X => X * 360 - 180;
  const xyToLat = Y => Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) / DEG;

  function makeOriginGeo(lat0, lng0) {
    lat0 = clamp(lat0, -83, 83);
    const cosLat = Math.cos(lat0 * DEG);
    const metersPerMerc = 2 * Math.PI * R_EARTH * cosLat;
    const X0 = lngToX(lng0);
    const Y0 = latToY(lat0);

    const worldToMerc = (wx, wz) => ({
      X: X0 + wx / metersPerMerc,
      Y: Y0 + wz / metersPerMerc
    });
    const latLngToWorld = (lat, lng) => ({
      wx: (lngToX(lng) - X0) * metersPerMerc,
      wz: (latToY(lat) - Y0) * metersPerMerc
    });
    const worldToLatLng = (wx, wz) => ({
      lat: xyToLat(Y0 + wz / metersPerMerc),
      lng: xyToLng(X0 + wx / metersPerMerc)
    });
    const boxForHalf = (halfM, Nx, Ny) => {
      const m0 = worldToMerc(-halfM, -halfM);
      const m1 = worldToMerc(halfM, halfM);
      return {
        X0: m0.X, X1: m1.X, Y0: m0.Y, Y1: m1.Y,
        w: xyToLng(m0.X), e: xyToLng(m1.X),
        n: xyToLat(m0.Y), s: xyToLat(m1.Y),
        widthM: halfM * 2, heightM: halfM * 2,
        Nx, Ny,
        cellM: (halfM * 2) / (Nx - 1)
      };
    };
    const boxForCenterHalf = (cx, cz, halfM, Nx, Ny) => {
      const m0 = worldToMerc(cx - halfM, cz - halfM);
      const m1 = worldToMerc(cx + halfM, cz + halfM);
      return {
        X0: m0.X, X1: m1.X, Y0: m0.Y, Y1: m1.Y,
        w: xyToLng(m0.X), e: xyToLng(m1.X),
        n: xyToLat(m0.Y), s: xyToLat(m1.Y),
        cx, cz, halfM,
        widthM: halfM * 2, heightM: halfM * 2,
        Nx, Ny,
        cellM: (halfM * 2) / (Nx - 1)
      };
    };
    return {
      lat0, lng0, cosLat, metersPerMerc, X0, Y0, boxForCenterHalf,
      worldToMerc, latLngToWorld, worldToLatLng, boxForHalf,
      key: `${lat0.toFixed(4)},${lng0.toFixed(4)}`
    };
  }

  function tileRange(box, z) {
    const n = 1 << z;
    const x0 = Math.floor(box.X0 * n), x1 = Math.floor(Math.min(box.X1, 0.9999999) * n);
    const y0 = Math.floor(clamp(box.Y0, 0, 0.9999999) * n), y1 = Math.floor(clamp(box.Y1, 0, 0.9999999) * n);
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }

  function zoomForBox(box, lo, hi, maxTiles) {
    let z = Math.ceil(Math.log2(156543.03392 * Math.cos(xyToLat((box.Y0 + box.Y1) / 2) * DEG) / box.cellM));
    z = clamp(z, lo, hi);
    while (z > lo && tileRange(box, z).count > maxTiles) z--;
    return z;
  }

  // ===========================================================================
  // 2. АСТРОНОМИЯ (СОЛНЦЕ И ЛУНА)
  // ===========================================================================
  function sunPosition(ms, lat, lng) {
    if (window.SunCalc && SunCalc.getPosition) {
      const sp = SunCalc.getPosition(new Date(ms), lat, lng);
      return { alt: sp.altitude, az: sp.azimuth + Math.PI };
    }
    const lw = -lng * DEG, phi = lat * DEG, d = ms / 86400000 - 0.5 + 2440588 - 2451545;
    const M = DEG * (357.5291 + 0.98560028 * d);
    const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + DEG * 102.9372 + Math.PI, e = DEG * 23.4397;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const H = DEG * (280.16 + 360.9856235 * d) - lw - ra;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    return { alt, az: az + Math.PI };
  }

  function moonPosition(ms, lat, lng) {
    if (window.SunCalc && SunCalc.getMoonPosition && SunCalc.getMoonIllumination) {
      const d = new Date(ms);
      const mp = SunCalc.getMoonPosition(d, lat, lng);
      const mi = SunCalc.getMoonIllumination(d);
      return {
        alt: mp.altitude,
        az: mp.azimuth + Math.PI,
        illum: mi.fraction,
        phase: mi.phase != null ? mi.phase : 0.5,
        angle: mi.angle != null ? mi.angle : 0.0
      };
    }
    const syn = 29.53058867, base = Date.UTC(2024, 0, 11, 11, 57);
    const phase = (((ms - base) / 86400000) % syn + syn) % syn / syn;
    const sp = sunPosition(ms, lat, lng);
    return {
      alt: -sp.alt * 0.7 + 0.18,
      az: sp.az + Math.PI * 0.9,
      illum: (1 - Math.cos(phase * 2 * Math.PI)) * 0.5,
      phase,
      angle: 0.2
    };
  }

  function dirFromAltAz(alt, az) {
    const c = Math.cos(alt);
    return [Math.sin(az) * c, Math.sin(alt), -Math.cos(az) * c];
  }

  function computeAtmosphere(alt, moon, darkTheme) {
    const altD = alt / DEG;
    const night = 1 - smooth(-12, -2, altD);
    const twilight = smooth(-12, 0, altD) * (1 - smooth(2, 14, altD));
    const day = smooth(-2, 12, altD);

    let skyTop = mix3(lin3([0.02, 0.04, 0.10]), lin3([0.16, 0.36, 0.72]), day);
    let skyHor = mix3(lin3([0.04, 0.08, 0.18]), lin3([0.68, 0.80, 0.92]), day);
    if (twilight > 0.01) {
      skyTop = mix3(skyTop, lin3([0.14, 0.22, 0.52]), twilight * 0.55);
      skyHor = mix3(skyHor, lin3([0.92, 0.52, 0.30]), twilight * 0.65);
    }

    const sunCol = mix3(lin3([1.0, 0.38, 0.12]), lin3([1.0, 0.96, 0.90]), smooth(0, 22, altD));
    const sunInt = smooth(-4, 15, altD) * 1.45;
    const moonInt = (0.18 + 0.28 * moon.illum) * smooth(-3, 8, moon.alt / DEG) + 0.06;
    const moonCol = lin3([0.62, 0.78, 1.0]);

    const lcol = mix3(sunCol, moonCol, night);
    const lint = lerp(sunInt, moonInt, night);

    let contourSkyTop = darkTheme ? lin3([0.05, 0.08, 0.14]) : lin3([0.74, 0.84, 0.94]);
    let contourSkyHor = darkTheme ? lin3([0.11, 0.16, 0.25]) : lin3([0.93, 0.95, 0.98]);

    return {
      altD, night, twilight, day,
      skyTop, skyHor, contourSkyTop, contourSkyHor,
      lcol, lint, sunCol, moonCol
    };
  }

  // ===========================================================================
  // 3. ЗАГРУЗЧИКИ ДАННЫХ (DEM, CANOPY, OSM, MVT)
  // ===========================================================================
  let _scv = null, _scx = null;
  function scratch(size) {
    if (!_scv) { _scv = document.createElement('canvas'); _scx = _scv.getContext('2d', { willReadFrequently: true }); }
    if (_scv.width !== size || _scv.height !== size) { _scv.width = size; _scv.height = size; }
    return _scx;
  }

  const demTileMemo = new Map();
  let demMemoBytes = 0;
  function demMemoGet(key) {
    const v = demTileMemo.get(key);
    if (v) { demTileMemo.delete(key); demTileMemo.set(key, v); } // LRU: свежие в конец
    return v;
  }
  function demMemoPut(key, f, s, p) {
    const old = demTileMemo.get(key);
    if (old) { demMemoBytes -= old.f.byteLength; demTileMemo.delete(key); }
    demTileMemo.set(key, { f, s, p });
    demMemoBytes += f.byteLength;
    while (demTileMemo.size > 1 && (demTileMemo.size > PERF.demMemoMax || demMemoBytes > PERF.demMemoBytes)) {
      const k = demTileMemo.keys().next().value;
      demMemoBytes -= demTileMemo.get(k).f.byteLength;
      demTileMemo.delete(k);
    }
  }
  function demMemoClear() { demTileMemo.clear(); demMemoBytes = 0; }
  function scratchRelease() {
    if (PERF.tier < 2 && _scv && (_scv.width || _scv.height)) { _scv.width = 0; _scv.height = 0; }
  }

  const PROV_LABELS = {
    mapterhorn: 'Copernicus (Mapterhorn)',
    aws: 'AWS Terrarium',
    nextzen: 'Nextzen',
    empty: 'нет данных'
  };

  async function loadDemBox(box, zLo, zHi, maxTiles, job, bicubic = false) {
    const dr = WM.demRelief;
    if (!dr || typeof dr.loadDemTileWithFallback !== 'function') throw new Error('модуль рельефа (demRelief) не подключён');
    const srcId = (dr.getConfig && dr.getConfig().demSource) || 'mapterhorn';
    const z = zoomForBox(box, zLo, zHi, maxTiles);
    const r = tileRange(box, z), tw = r.x1 - r.x0 + 1;
    let S = 0, done = 0, fail = 0, degraded = 0, lastErr = null;
    const list = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) list.push({ x, y });
    const tiles = new Array(list.length).fill(null);
    const tileProvs = new Array(list.length).fill(null);
    // УДАЛИТЬ ЭТУ СТРОКУ:
    // let S = 0, done = 0, fail = 0, lastErr = null;
    const queue = list.map((t, i) => ({ ...t, i }));

    const worker = async () => {
      while (queue.length) {
        if (job.signal.aborted) throw new Error('aborted');
        const t = queue.shift();
        const tKey = `${srcId}:${z}/${t.x}/${t.y}`;
        try {
          const hit = job.force ? null : demMemoGet(tKey);
          if (hit) {
            tiles[t.i] = hit.f;
            tileProvs[t.i] = hit.p || srcId;
            S = hit.s;
          } else {
            const img = await withTimeout(dr.loadDemTileWithFallback({ z, x: t.x, y: t.y }), 25000, 'таймаут DEM');
            if (job.signal.aborted) throw new Error('aborted');
            if (!img || img._isEmptyFallback || img._demProvider === 'empty') {
              throw new Error('данные DEM временно недоступны');
            }
            const s = img.naturalWidth || img.width || 256;
            const prov = img._demProvider || srcId;
            const cx = scratch(s);
            cx.clearRect(0, 0, s, s);
            cx.drawImage(img, 0, 0, s, s);
            const d = cx.getImageData(0, 0, s, s).data, f = new Float32Array(s * s);
            let validPx = 0;
            for (let i = 0, p = 0; i < f.length; i++, p += 4) {
              if (d[p + 3] < 250) f[i] = NaN;
              else {
                const rawH = (d[p] * 256 + d[p + 1] + d[p + 2] / 256) - 32768;
                if (rawH < -500) f[i] = NaN;
                else { f[i] = rawH; validPx++; }
              }
            }
            if (validPx === 0) throw new Error('пустой тайл DEM');
            tiles[t.i] = f;
            tileProvs[t.i] = prov;
            S = s;
            if (!img._degraded) {
              demMemoPut(tKey, f, s, prov);
            } else {
              degraded++;
            }
          }
        } catch (e) {
          if (job.signal.aborted) throw e;
          fail++; lastErr = e;
        }
        job.progress(++done, list.length);
      }
    };
    await Promise.all(Array.from({ length: PERF.tileWorkers }, () => worker()));
    scratchRelease();
    if (fail === list.length || !S) throw new Error('тайлы DEM недоступны' + (lastErr ? ': ' + lastErr.message : ''));

    const provCounts = {};
    for (let i = 0; i < tileProvs.length; i++) {
      const p = tileProvs[i];
      if (!p) continue;
      provCounts[p] = (provCounts[p] || 0) + 1;
    }
    const provKeys = Object.keys(provCounts);
    const provText = provKeys
      .sort((a, b) => provCounts[b] - provCounts[a])
      .map(k => `${PROV_LABELS[k] || k}${provKeys.length > 1 ? ` (${provCounts[k]})` : ''}`)
      .join(' + ');


    const { Nx, Ny } = box, n = 1 << z, maxP = n * S - 1;
    const th = r.y1 - r.y0 + 1;
    const tx0A = new Int32Array(Nx), tx1A = new Int32Array(Nx);
    const lx0A = new Int32Array(Nx), lx1A = new Int32Array(Nx);
    const fxA = new Float32Array(Nx);
    const spanX = (box.X1 - box.X0) * n * S, baseX = box.X0 * n * S - 0.5;
    for (let i = 0; i < Nx; i++) {
      const px = baseX + (i / (Nx - 1)) * spanX;
      const x0raw = Math.floor(px);
      fxA[i] = px - x0raw;
      const ix0 = clamp(x0raw, 0, maxP), ix1 = clamp(x0raw + 1, 0, maxP);
      const tx0 = Math.floor(ix0 / S) - r.x0;
      const tx1 = Math.floor(ix1 / S) - r.x0;
      tx0A[i] = (tx0 >= 0 && tx0 < tw) ? tx0 : -1;
      tx1A[i] = (tx1 >= 0 && tx1 < tw) ? tx1 : -1;
      lx0A[i] = ix0 - (tx0 + r.x0) * S;
      lx1A[i] = ix1 - (tx1 + r.x0) * S;
    }


    const sampleAt = (ix, iy) => {
      ix = clamp(ix, 0, maxP);
      iy = clamp(iy, 0, maxP);
      const tx = Math.floor(ix / S) - r.x0;
      const ty = Math.floor(iy / S) - r.y0;
      if (tx < 0 || tx >= tw || ty < 0 || ty >= th) return NaN;
      const t = tiles[ty * tw + tx];
      if (!t) return NaN;
      return t[(iy - (ty + r.y0) * S) * S + (ix - (tx + r.x0) * S)];
    };
    const catmull = (p0, p1, p2, p3, t) => {
      const t2 = t * t, t3 = t2 * t;
      const v = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
      const lo = p1 < p2 ? p1 : p2;
      const hi = p1 > p2 ? p1 : p2;
      return v < lo ? lo : (v > hi ? hi : v);
    };

    const spanY = (box.Y1 - box.Y0) * n * S, baseY = box.Y0 * n * S - 0.5;
    const H = new Float32Array(Nx * Ny);

    for (let j = 0; j < Ny; j++) {
      const py = baseY + (j / (Ny - 1)) * spanY;
      const y0raw = Math.floor(py), fy = py - y0raw;
      const iy0 = clamp(y0raw, 0, maxP), iy1 = clamp(y0raw + 1, 0, maxP);
      const ty0 = Math.floor(iy0 / S) - r.y0;
      const ty1 = Math.floor(iy1 / S) - r.y0;
      const row0 = (ty0 >= 0 && ty0 < th) ? ty0 * tw : -1;
      const row1 = (ty1 >= 0 && ty1 < th) ? ty1 * tw : -1;
      const ly0 = (iy0 - (ty0 + r.y0) * S) * S;
      const ly1 = (iy1 - (ty1 + r.y0) * S) * S;
      const outRow = j * Nx;
      const oneMinusFy = 1 - fy;

      for (let i = 0; i < Nx; i++) {
        const px = baseX + (i / (Nx - 1)) * spanX;
        const x0raw = Math.floor(px);
        const fx = fxA[i], oneMinusFx = 1 - fx;

        if (bicubic) {
          let ok16 = true;
          const rVals = [0, 0, 0, 0];
          for (let ky = 0; ky < 4; ky++) {
            const sy = y0raw - 1 + ky;
            const v0 = sampleAt(x0raw - 1, sy);
            const v1 = sampleAt(x0raw,     sy);
            const v2 = sampleAt(x0raw + 1, sy);
            const v3 = sampleAt(x0raw + 2, sy);
            if (!(v0 === v0 && v1 === v1 && v2 === v2 && v3 === v3)) { ok16 = false; break; }
            rVals[ky] = catmull(v0, v1, v2, v3, fx);
          }
          if (ok16) {
            H[outRow + i] = catmull(rVals[0], rVals[1], rVals[2], rVals[3], fy);
            continue;
          }
        }

        const tx0 = tx0A[i], tx1 = tx1A[i];
        const lx0 = lx0A[i], lx1 = lx1A[i];
        const t00 = (row0 >= 0 && tx0 >= 0) ? tiles[row0 + tx0] : null;
        const t10 = (row0 >= 0 && tx1 >= 0) ? tiles[row0 + tx1] : null;
        const t01 = (row1 >= 0 && tx0 >= 0) ? tiles[row1 + tx0] : null;
        const t11 = (row1 >= 0 && tx1 >= 0) ? tiles[row1 + tx1] : null;
        const a = t00 ? t00[ly0 + lx0] : NaN;
        const b = t10 ? t10[ly0 + lx1] : NaN;
        const c = t01 ? t01[ly1 + lx0] : NaN;
        const d = t11 ? t11[ly1 + lx1] : NaN;
        H[outRow + i] = (a * oneMinusFx + b * fx) * oneMinusFy + (c * oneMinusFx + d * fx) * fy;
      }
    }
    let hMin = 1e9, hMax = -1e9, nan = 0;
    for (let i = 0; i < H.length; i++) {
      const v = H[i];
      if (v === v && v > -500 && v < 10000) { if (v < hMin) hMin = v; if (v > hMax) hMax = v; }
      else nan++;
    }
    const defH = (hMin > -500 && hMin < 1e8) ? hMin : 0;
    if (nan) {
      for (let j = 0; j < Ny; j++) {
        let last = NaN;
        for (let i = 0; i < Nx; i++) { const k = j * Nx + i; if (H[k] === H[k]) last = H[k]; else if (last === last) H[k] = last; }
        last = NaN;
        for (let i = Nx - 1; i >= 0; i--) { const k = j * Nx + i; if (H[k] === H[k]) last = H[k]; else if (last === last) H[k] = last; }
      }
      for (let i = 0; i < Nx; i++) {
        let last = NaN;
        for (let j = 0; j < Ny; j++) { const k = j * Nx + i; if (H[k] === H[k]) last = H[k]; else if (last === last) H[k] = last; }
        last = NaN;
        for (let j = Ny - 1; j >= 0; j--) { const k = j * Nx + i; if (H[k] === H[k]) last = H[k]; else if (last === last) H[k] = last; }
      }
      for (let i = 0; i < H.length; i++) if (!(H[i] === H[i]) || H[i] < -500) H[i] = defH;
    }
    hMin = 1e9; hMax = -1e9;
    for (let i = 0; i < H.length; i++) { if (H[i] < hMin) hMin = H[i]; if (H[i] > hMax) hMax = H[i]; }
    const usedFallback = srcId === 'mapterhorn' && provKeys.some(k => k !== 'mapterhorn' && k !== 'empty');
    return {
      data: { height: H, hMin, hMax, z, box, providers: provCounts, fallback: usedFallback },
      partial: fail > 0 || degraded > 0,
      info: `${provText ? provText + ' · ' : ''}z${z} · ${list.length - fail}/${list.length} тайлов · ${Math.round(hMin)}…${Math.round(hMax)} м` + (fail ? ` (⚠ пропусков: ${fail})` : '')
    };
  }

  // --- Крона деревьев (Canopy Height) ---
  const canopyTileMemo = new Map();
  function getCanopyUrl(idx) {
    if (idx === 0) {
      try {
        const raw = localStorage.getItem('wm_gee_tokens');
        if (raw) { const d = JSON.parse(raw); if (d.templates && d.expiresAt && Date.now() < d.expiresAt) return d.templates.height || null; }
      } catch (e) {}
      return null;
    }
    if (idx === 1) return 'https://forests.sylar1907942.workers.dev/tiles/height/{z}/{x}/{y}';
    if (idx === 2) return 'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=height&z={z}&x={x}&y={y}';
    return null;
  }

  async function decodeBlobRGBA(blob, size) {
    let bmp = null, url = null;
    if ('createImageBitmap' in window) {
      try { bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
      catch (e) { try { bmp = await createImageBitmap(blob); } catch (_) {} }
    }
    if (!bmp) {
      bmp = await new Promise((res, rej) => {
        const img = new Image(); url = URL.createObjectURL(blob);
        img.onload = () => res(img); img.onerror = () => rej(new Error('decode error')); img.src = url;
      });
    }
    const cx = scratch(size);
    cx.clearRect(0, 0, size, size);
    cx.drawImage(bmp, 0, 0, size, size);
    if (bmp.close) bmp.close();
    if (url) URL.revokeObjectURL(url);
    return cx.getImageData(0, 0, size, size).data;
  }

  const VIRIDIS_STOPS = [
    [ 68,   1,  84,  0],
    [ 72,  40, 120,  4],
    [ 62,  74, 137,  8],
    [ 49, 104, 142, 12],
    [ 38, 130, 142, 16],
    [ 31, 158, 137, 19],
    [ 53, 183, 121, 23],
    [110, 206,  88, 27],
    [181, 222,  43, 30],
    [253, 231,  37, 33]
  ];

  let _viridisLut = null;
  function getViridisLut() {
    if (_viridisLut) return _viridisLut;
    const lut = new Uint8Array(262144); // 64*64*64
    for (let r6 = 0; r6 < 64; r6++) {
      const r = (r6 << 2) + 2;
      for (let g6 = 0; g6 < 64; g6++) {
        const g = (g6 << 2) + 2;
        for (let b6 = 0; b6 < 64; b6++) {
          const b = (b6 << 2) + 2;
          let bestD2 = 1e9, bestH = 0;
          for (let s = 0; s < VIRIDIS_STOPS.length - 1; s++) {
            const a0 = VIRIDIS_STOPS[s], a1 = VIRIDIS_STOPS[s + 1];
            const dr = a1[0] - a0[0], dg = a1[1] - a0[1], db = a1[2] - a0[2];
            const len2 = dr * dr + dg * dg + db * db || 1;
            const t = clamp(((r - a0[0]) * dr + (g - a0[1]) * dg + (b - a0[2]) * db) / len2, 0, 1);
            const pr = a0[0] + dr * t - r, pg = a0[1] + dg * t - g, pb = a0[2] + db * t - b;
            const d2 = pr * pr + pg * pg + pb * pb;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestH = a0[3] + (a1[3] - a0[3]) * t;
            }
          }
          lut[(r6 << 12) | (g6 << 6) | b6] = Math.round(clamp(bestH, 0, 60) * 4);
        }
      }
    }
    return (_viridisLut = lut);
  }

  function decodeCanopyGrid(d) {
    const out = new Uint8Array(65536);
    const lut = getViridisLut();
    for (let i = 0, p = 0; i < 65536; i++, p += 4) {
      const a = d[p + 3];
      if (a < 35) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      if ((r < 20 && g < 20 && b < 20) || (r < 72 && g < 20 && b < 90)) continue;
      if (r < 76 && g < 22 && b < 102 && b >= g * 1.15) continue;

      if (r < 25 && b < 25 && g > 80) out[i] = 70;
      else if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) out[i] = clamp(Math.round(r / 255 * 150), 0, 250);
      else out[i] = lut[((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)];
    }
    return out;
  }

  function getCanopyVersion() {
    if (WM.canopy && typeof WM.canopy.getVersion === 'function') {
      return WM.canopy.getVersion();
    }
    try {
      return localStorage.getItem('wm_canopy_version') || 'v1';
    } catch (e) {
      return 'v1';
    }
  }

  let _canopyActive = 0;
  const _canopyWaiters = [];

  function acquireCanopySlot(signal) {
    if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
    if (_canopyActive < PERF.canopySlots) {
      _canopyActive++;
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const entry = { res, rej, cleanup: null };
      const onAbort = () => {
        const idx = _canopyWaiters.indexOf(entry);
        if (idx >= 0) _canopyWaiters.splice(idx, 1);
        rej(new Error('aborted'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      _canopyWaiters.push(entry);
    });
  }

  function releaseCanopySlot() {
    _canopyActive = Math.max(0, _canopyActive - 1);
    while (_canopyActive < PERF.canopySlots && _canopyWaiters.length) {
      const next = _canopyWaiters.shift();
      if (next.cleanup) next.cleanup();
      _canopyActive++;
      next.res();
    }
  }

  function putCanopyMemo(key, grid) {
    canopyTileMemo.delete(key);
    canopyTileMemo.set(key, grid);
    while (canopyTileMemo.size > PERF.canopyMemoMax) {
      canopyTileMemo.delete(canopyTileMemo.keys().next().value);
    }
  }

  async function readCanopyBlobLocal(url) {
    if (!url) return null;
    if (WM.offlineArea && typeof WM.offlineArea.readCachedBlob === 'function') {
      try {
        const b = await WM.offlineArea.readCachedBlob(url);
        if (b && b.size > 0) return b;
      } catch (e) {}
    }
    if ('caches' in window) {
      try {
        const resp = await caches.match(url, { ignoreVary: true });
        if (resp && resp.ok) {
          const b = await resp.blob();
          if (b && b.size > 0) return b;
        }
      } catch (e) {}
    }
    return null;
  }

  function saveCanopyBlobToCache(z, x, y, blob) {
    if (!blob || !blob.size || !('caches' in window)) return;
    const permTpl = getCanopyUrl(1);
    if (!permTpl) return;
    const permUrl = permTpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
    caches.open('wm-tiles-v1')
      .then(c => c.put(permUrl, new Response(blob, {
        status: 200,
        headers: { 'Content-Type': blob.type || 'image/png' }
      })))
      .catch(() => {});
  }

  function cropCanopyGrid(parentGrid, z, x, y, pz) {
    const shift = z - pz;
    const factor = 1 << shift;
    const subX = ((x % factor) + factor) % factor;
    const subY = ((y % factor) + factor) % factor;
    const subW = 256 / factor;
    const startX = subX * subW;
    const startY = subY * subW;
    const out = new Uint8Array(65536);
    for (let row = 0; row < 256; row++) {
      const sy = Math.min(255, Math.floor(startY + (row / 256) * subW));
      const dstOff = row * 256;
      const srcOff = sy * 256;
      for (let col = 0; col < 256; col++) {
        const sx = Math.min(255, Math.floor(startX + (col / 256) * subW));
        out[dstOff + col] = parentGrid[srcOff + sx];
      }
    }
    return out;
  }

  async function tryLocalCanopyV1(z, x, y) {
    const cacheKey = `v1/${z}/${x}/${y}`;
    if (canopyTileMemo.has(cacheKey)) return canopyTileMemo.get(cacheKey);

    // 1. Проверяем, не отдаёт ли WM.canopy готовый тайл из своей памяти (если метод поддерживается)
    if (WM.canopy && typeof WM.canopy.getCachedHeightGrid === 'function') {
      try {
        const g = WM.canopy.getCachedHeightGrid(z, x, y, 4);
        if (g instanceof Uint8Array) {
          putCanopyMemo(cacheKey, g);
          return g;
        }
      } catch (e) {}
    }

    // 2. Ищем в offlineArea / CacheStorage по всем зеркалам (workers.dev — приоритет offlineArea)
    for (const idx of [1, 2, 0]) {
      const tpl = getCanopyUrl(idx);
      if (!tpl) continue;
      const url = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
      const blob = await readCanopyBlobLocal(url);
      if (blob) {
        try {
          const data = await decodeBlobRGBA(blob, 256);
          const grid = decodeCanopyGrid(data);
          putCanopyMemo(cacheKey, grid);
          return grid;
        } catch (e) {}
      }
    }
    return null;
  }

  async function tryLocalCanopyV1Parent(z, x, y) {
    for (let pz = z - 1; pz >= 11; pz--) {
      const shift = z - pz;
      const px = x >> shift;
      const py = y >> shift;
      const pGrid = await tryLocalCanopyV1(pz, px, py);
      if (pGrid) return cropCanopyGrid(pGrid, z, x, y, pz);
    }
    return null;
  }

  async function fetchCanopyTile(z, x, y, signal) {
    const n = 1 << z;
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;

    const ver = getCanopyVersion();
    const key = `${ver}/${z}/${x}/${y}`;
    if (canopyTileMemo.has(key)) return canopyTileMemo.get(key);

    // Быстрый кэш-хит до захвата сетевого слота (мгновенная загрузка из offlineArea / 2D-карты)
    if (ver !== 'v2') {
      const localHit = await tryLocalCanopyV1(z, x, y);
      if (localHit) return localHit;
      if (navigator.onLine === false) {
        const parentHit = await tryLocalCanopyV1Parent(z, x, y);
        if (parentHit) return parentHit;
        throw new Error('тайлы крон недоступны офлайн');
      }
    }

    await acquireCanopySlot(signal);
    try {
      if (signal && signal.aborted) throw new Error('aborted');
      if (canopyTileMemo.has(key)) return canopyTileMemo.get(key);

      // --- ВЕТКА v2 (Meta CHM v2 COG, шаг квантования Q = 4) ---
      if (ver === 'v2' && WM.canopyV2 && typeof WM.canopyV2.fetchHeightGridQ === 'function') {
        const res = await WM.canopyV2.fetchHeightGridQ(z, x, y, 4, signal);
        if (signal && signal.aborted) throw new Error('aborted');

        if (res === 'ZERO') {
          const empty = new Uint8Array(65536);
          putCanopyMemo(key, empty);
          return empty;
        }
        if (res instanceof Uint8Array) {
          putCanopyMemo(key, res);
          return res;
        }
        throw new Error('тайлы крон v2 недоступны');
      }

      // --- ВЕТКА v1 (GEE / Cloudflare / Yandex PNG) ---
      const localHit2 = await tryLocalCanopyV1(z, x, y);
      if (localHit2) return localHit2;

      const order = (WM.canopyNet && WM.canopyNet.getPreferredOrder) ? WM.canopyNet.getPreferredOrder() : [0, 1, 2];
      let n404 = 0, tried = 0;
      for (const idx of order) {
        const tpl = getCanopyUrl(idx);
        if (!tpl) continue;
        tried++;
        if (signal && signal.aborted) throw new Error('aborted');
        const url = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 8500);
        const onAb = () => ctl.abort();
        if (signal) signal.addEventListener('abort', onAb, { once: true });
        try {
          const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });
          if (resp.status === 404) { n404++; continue; }
          if (!resp.ok) { WM.canopyNet && WM.canopyNet.markFailure && WM.canopyNet.markFailure(idx); continue; }
          const blob = await resp.blob();
          const data = await decodeBlobRGBA(blob, 256);
          WM.canopyNet && WM.canopyNet.markSuccess && WM.canopyNet.markSuccess(idx);
          const grid = decodeCanopyGrid(data);
          putCanopyMemo(key, grid);
          // Сохраняем в общий кэш под постоянным URL workers.dev, чтобы 2D-карта и офлайн не качали заново
          saveCanopyBlobToCache(z, x, y, blob);
          return grid;
        } catch (e) {
          if (signal && signal.aborted) throw e;
        } finally {
          clearTimeout(tm);
          if (signal) signal.removeEventListener('abort', onAb);
        }
      }

      if (tried > 0 && n404 === tried) {
        const empty = new Uint8Array(65536);
        putCanopyMemo(key, empty);
        return empty;
      }

      // Если сеть не ответила — пробуем вырезать из кэшированного родительского зума (z12/z13)
      const parentHit = await tryLocalCanopyV1Parent(z, x, y);
      if (parentHit) return parentHit;

      throw new Error('тайлы крон недоступны');
    } finally {
      releaseCanopySlot();
    }
  }


  async function loadCanopyZone(geo, job, halfM = CANOPY_HALF, gridN = CANOPY_N, zLo = 12, zHi = 14, maxTiles = 25) {
    let curHalf = halfM;
    let box = geo.boxForHalf(curHalf, gridN, gridN);
    let z = zHi;
    while (z > zLo && tileRange(box, z).count > maxTiles) z--;
    while (curHalf > 3000 && tileRange(box, z).count > maxTiles) {
      curHalf = Math.round(curHalf * 0.88);
      box = geo.boxForHalf(curHalf, gridN, gridN);
    }

    const r = tileRange(box, z), tw = r.x1 - r.x0 + 1;

    const list = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) list.push({ x, y });
    const arr = new Array(list.length).fill(null);
    let done = 0, fail = 0;
    const queue = list.map((t, i) => ({ ...t, i }));
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          arr[t.i] = await fetchCanopyTile(z, t.x, t.y, job.signal);
        } catch (e) {
          if (job.signal.aborted) throw e;
          fail++;
        }
        job.progress(++done, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, PERF.tileWorkers) }, () => worker()));
    if (fail === list.length) throw new Error('высоты деревьев недоступны');

    const { Nx, Ny } = box, n = 1 << z, maxP = n * 256 - 1;
    const q = new Uint8Array(Nx * Ny);
    for (let j = 0; j < Ny; j++) {
      const py = clamp(Math.floor((box.Y0 + (j / (Ny - 1)) * (box.Y1 - box.Y0)) * n * 256), 0, maxP);
      const ty = (py >> 8) - r.y0, ly = py & 255;
      for (let i = 0; i < Nx; i++) {
        const px = clamp(Math.floor((box.X0 + (i / (Nx - 1)) * (box.X1 - box.X0)) * n * 256), 0, maxP);
        const tx = (px >> 8) - r.x0, lx = px & 255;
        const g = (tx >= 0 && tx < tw && ty >= 0) ? arr[ty * tw + tx] : null;
        q[j * Nx + i] = g ? g[ly * 256 + lx] : 0;
      }
    }
    let cnt = 0;
    for (let i = 0; i < q.length; i++) if (q[i] >= 8) cnt++;

    return {
      data: { grid: q, box, count: cnt, halfM: curHalf },
      info: `${getCanopyVersion()} · z${z} · ${list.length - fail}/${list.length} тайлов · ±${(curHalf / 1000).toFixed(1)} км · лесистость ${Math.round(cnt / q.length * 100)}%`
    };
  }












 // --- Классификация дорог, быстрая растеризация и векторные данные (MVT) ---
  const VEC_CANVAS_SZ = 2048;

  const PAVED_MAIN_KINDS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
  const PAVED_MINOR_KINDS = new Set(['unclassified', 'residential', 'living_street', 'pedestrian', 'service', 'bus_guideway', 'busway', 'road']);
  const TRAIL_KINDS = new Set(['track', 'path', 'footway', 'bridleway', 'cycleway', 'steps']);

  function computePoiPrio(cat, kind, ele, pop, hasRealName, wayArea) {
    if (cat === 'peak') {
      if (kind === 'pass') return 780 + (ele ? Math.min(120, ele * 0.03) : 0);
      if (!hasRealName) return 520 + (ele ? Math.min(140, ele * 0.04) : 0);
      return 1000 + (kind === 'volcano' ? 120 : 0) + (ele ? Math.min(420, ele * 0.08) : 60);
    }
    if (cat === 'settlement') {
      const p = Math.max(10, Number(pop) || 0);
      if (kind === 'city') return 960 + Math.min(260, Math.log10(Math.max(1000, p || 50000)) * 45);
      if (kind === 'town') return 790 + Math.min(160, Math.log10(Math.max(500, p || 10000)) * 35);
      if (kind === 'village') return 520 + Math.min(100, Math.log10(Math.max(50, p || 500)) * 24);
      return 290 + Math.min(50, Math.log10(Math.max(10, p || 50)) * 16); // hamlet
    }
    if (cat === 'landmark') {
      if (kind === 'viewpoint' || kind === 'alpine_hut' || kind === 'wilderness_hut' || kind === 'castle') return 470;
      if (kind === 'lake' || kind === 'reservoir') return 310 + Math.min(140, Math.log10(Math.max(1000, wayArea || 10000)) * 18);
      return 230;
    }
    return 140 + (ele ? Math.min(40, ele * 0.02) : 0); // locality / isolated_dwelling / suburb
  }

  function rasterizeVectorsCanvas(vecData, layersOpt) {
    if (!vecData || (!vecData.far && !vecData.near)) return null;
    const SZ = vecData.size || VEC_CANVAS_SZ;
    const cv = vecData._canvas || (vecData._canvas = document.createElement('canvas'));
    if (cv.width !== SZ) cv.width = SZ;
    if (cv.height !== SZ) cv.height = SZ;
    const ctx = cv.getContext('2d');

    // Непрозрачная чёрная база (A=255), чтобы R, G, B не смешивались через альфу в WebGL
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgb(0, 0, 0)';
    ctx.fillRect(0, 0, SZ, SZ);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const wPaved = clamp((layersOpt && layersOpt.roadPavedWidth) || 1.0, 0.4, 3.0);
    const wTrail = clamp((layersOpt && layersOpt.roadTrailWidth) || 1.0, 0.4, 3.0);
    const wRiver = clamp((layersOpt && layersOpt.riverWidth) || 1.0, 0.4, 3.0);

    const drawLines = (list, widthScale) => {
      for (let idx = 0; idx < list.length; idx++) {
        const item = list[idx];
        ctx.strokeStyle = item.col;
        ctx.lineWidth = item.baseW * widthScale;
        ctx.beginPath();
        for (let l = 0; l < item.lines.length; l++) {
          const pts = item.lines[l];
          if (pts.length < 4) continue;
          ctx.moveTo(pts[0], pts[1]);
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        }
        ctx.stroke();
      }
    };

    // B = Вода (озёра 195, реки 255)
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgb(0, 0, 195)';
    for (let idx = 0; idx < vecData.waterPolys.length; idx++) {
      const poly = vecData.waterPolys[idx];
      ctx.beginPath();
      for (let l = 0; l < poly.length; l++) {
        const ring = poly[l];
        if (ring.length < 6) continue;
        ctx.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
        ctx.closePath();
      }
      ctx.fill();
    }

    const nb = vecData.nearCanvasRect;
    const hasNear = vecData.near && (vecData.near.paved.length || vecData.near.trails.length || vecData.near.rivers.length);

    // Дальняя зона (z11-z12): за пределами ближнего квадрата z13-z14
    ctx.save();
    if (hasNear && nb) {
      ctx.beginPath();
      ctx.rect(0, 0, SZ, SZ);
      ctx.rect(nb.x, nb.y, nb.w, nb.h);
      ctx.clip('evenodd');
    }
    if (vecData.far) {
      drawLines(vecData.far.rivers, wRiver);
      drawLines(vecData.far.trails, wTrail);
      drawLines(vecData.far.paved, wPaved);
    }
    ctx.restore();

    // Ближняя зона (z13-z14): детальные тропы, грунтовки и ручьи
    if (hasNear && nb) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(nb.x, nb.y, nb.w, nb.h);
      ctx.clip();
      drawLines(vecData.near.rivers, wRiver);
      drawLines(vecData.near.trails, wTrail);
      drawLines(vecData.near.paved, wPaved);
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
    return cv;
  }

  async function loadVectorsZone(geo, job) {
    const vr = WM.vectorRoads;
    if (!vr || typeof vr.fetchMvtTile !== 'function') {
      return { data: { far: null, near: null, waterPolys: [], fallbackPlaces: [], buildingFeatures: [] }, info: 'модуль vectorRoads не подключён' };
    }
    const SZ = VEC_CANVAS_SZ;
    const box = geo.boxForHalf(VEC_HALF, SZ, SZ);
    const z = zoomForBox(box, 11, 13, 16);
    const r = tileRange(box, z);
    const coords = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) coords.push({ x, y, z });

    const bldBox = geo.boxForHalf(BLD_HALF, 512, 512);
    const bldZ = 14;
    const bldR = tileRange(bldBox, bldZ);
    const bldCoords = [];
    for (let y = bldR.y0; y <= bldR.y1; y++) for (let x = bldR.x0; x <= bldR.x1; x++) bldCoords.push({ x, y, z: bldZ });

    const tileCache = new Map();
    const allUnique = [];
    const keyOf = c => `${c.z}/${c.x}/${c.y}`;
    for (const c of [...coords, ...bldCoords]) {
      const k = keyOf(c);
      if (!tileCache.has(k)) { tileCache.set(k, null); allUnique.push(c); }
    }

    let done = 0;
    allUnique.forEach(c => {
      const p = vr.fetchMvtTile(c).catch(() => null).finally(() => job.progress(++done, allUnique.length));
      tileCache.set(keyOf(c), p);
    });

    const [results, bldResults] = await Promise.all([
      Promise.all(coords.map(c => tileCache.get(keyOf(c)))),
      Promise.all(bldCoords.map(c => tileCache.get(keyOf(c))))
    ]);
    if (job.signal.aborted) throw new Error('aborted');

    const waterPolys = [];
    const fallbackPlaces = [];
    const seenPlaces = new Set();

    const extractFromResults = (resList, tileCoordsList, collectPolys) => {
      const paved = [], trails = [], rivers = [];
      const seenParents = new Set();

      resList.forEach((res, idx) => {
        if (!res || !res.layers) return;
        const tc = tileCoordsList[idx];
        const { shift = 0, parentX = tc.x, parentY = tc.y, layers } = res;
        const pZoom = tc.z - shift;
        const pKey = `${pZoom}:${parentX}:${parentY}`;
        if (seenParents.has(pKey)) return;
        seenParents.add(pKey);

        const nParent = 1 << pZoom;
        const toPx = (lx, ly, extent) => [
          (((parentX + lx / extent) / nParent) - box.X0) / (box.X1 - box.X0) * SZ,
          (((parentY + ly / extent) / nParent) - box.Y0) / (box.Y1 - box.Y0) * SZ
        ];
        const toLatLng = (lx, ly, extent) => ({
          lat: xyToLat((parentY + ly / extent) / nParent),
          lng: xyToLng((parentX + lx / extent) / nParent)
        });
        const convertGeom = (geom, ext) => {
          const out = [];
          for (let l = 0; l < geom.length; l++) {
            const pts = geom[l];
            if (pts.length < 4) continue;
            const flat = new Float32Array(pts.length);
            for (let i = 0; i < pts.length; i += 2) {
              const [px, py] = toPx(pts[i], pts[i + 1], ext);
              flat[i] = px; flat[i + 1] = py;
            }
            out.push(flat);
          }
          return out;
        };

        if (collectPolys) {
          const wp = layers.water_polygons || layers.water;
          if (wp && wp.features) {
            const ext = wp.extent || 4096;
            wp.features.forEach(f => {
              const conv = convertGeom(f.geom, ext);
              if (conv.length) waterPolys.push(conv);
            });
          }
        }

        const wl = layers.water_lines || layers.waterway;
        if (wl && wl.features) {
          const ext = wl.extent || 4096;
          wl.features.forEach(f => {
            const p = f.props || {};
            const k = p.kind || p.class || p.waterway || '';
            if (p.tunnel === 1 || p.tunnel === 'yes' || k === 'ditch' || k === 'drain') return;
            const lines = convertGeom(f.geom, ext);
            if (!lines.length) return;
            const baseW = k === 'river' ? 5.2 : (k === 'canal' ? 3.8 : 2.3);
            rivers.push({ lines, baseW, col: 'rgb(0, 0, 255)' });
          });
        }

        const st = layers.streets || layers.transportation || layers.roads;
        if (st && st.features) {
          const ext = st.extent || 4096;
          st.features.forEach(f => {
            const p = f.props || {};
            if (p.tunnel === 1 || p.tunnel === 'yes') return;
            const k = p.kind || p.class || p.highway || '';
            if (!k) return;
            if (PAVED_MAIN_KINDS.has(k) || PAVED_MINOR_KINDS.has(k)) {
              const lines = convertGeom(f.geom, ext);
              if (!lines.length) return;
              const isMain = PAVED_MAIN_KINDS.has(k);
              paved.push({
                lines,
                baseW: isMain ? 4.8 : 3.0,
                col: isMain ? 'rgb(255, 0, 0)' : 'rgb(205, 0, 0)'
              });
            } else if (TRAIL_KINDS.has(k)) {
              const lines = convertGeom(f.geom, ext);
              if (!lines.length) return;
              const isTrack = (k === 'track');
              trails.push({
                lines,
                baseW: isTrack ? 3.0 : 2.0,
                col: isTrack ? 'rgb(0, 255, 0)' : 'rgb(0, 195, 0)'
              });
            }
          });
        }

        const pl = layers.place_labels;
        if (pl && pl.features) {
          const ext = pl.extent || 4096;
          pl.features.forEach(f => {
            const p = f.props || {};
            const name = p.name_ru || p['name:ru'] || p.name;
            if (!name || !f.geom.length || f.geom[0].length < 2) return;
            const ll = toLatLng(f.geom[0][0], f.geom[0][1], ext);
            const k = p.kind || 'locality';
            const cat = (k === 'city' || k === 'town' || k === 'village' || k === 'hamlet') ? 'settlement' : 'locality';
            const pop = Number(p.population) || 0;
            const keyN = `${cat}:${name.toLowerCase()}`;
            if (!seenPlaces.has(keyN)) {
              seenPlaces.add(keyN);
              fallbackPlaces.push({
                id: 'mvt_' + fallbackPlaces.length,
                cat, kind: k, name,
                lat: ll.lat, lng: ll.lng,
                ele: null, pop,
                prio: computePoiPrio(cat, k, null, pop, true, 0)
              });
            }
          });
        }

        const wpl = layers.water_polygons_labels;
        if (wpl && wpl.features) {
          const ext = wpl.extent || 4096;
          wpl.features.forEach(f => {
            const p = f.props || {};
            const name = p.name_ru || p['name:ru'] || p.name;
            const area = Number(p.way_area) || 0;
            if (!name || area < 35000 || !f.geom.length || f.geom[0].length < 2) return;
            const ll = toLatLng(f.geom[0][0], f.geom[0][1], ext);
            const keyN = `lake:${name.toLowerCase()}`;
            if (!seenPlaces.has(keyN)) {
              seenPlaces.add(keyN);
              fallbackPlaces.push({
                id: 'mvt_w_' + fallbackPlaces.length,
                cat: 'landmark', kind: 'lake', name,
                lat: ll.lat, lng: ll.lng,
                ele: null, pop: 0, way_area: area,
                prio: computePoiPrio('landmark', 'lake', null, 0, true, area)
              });
            }
          });
        }
      });

      return { paved, trails, rivers };
    };

    const far = extractFromResults(results, coords, true);
    const near = extractFromResults(bldResults, bldCoords, false);

    // Сбор полигонов зданий в локальных метрах сцены (wx, wz)
    const buildingFeatures = [];
    const seenBldParents = new Set();
    bldResults.forEach((res, idx) => {
      if (!res || !res.layers) return;
      const tc = bldCoords[idx];
      const { shift = 0, parentX = tc.x, parentY = tc.y, layers } = res;
      const pZoom = tc.z - shift;
      const pKey = `${pZoom}:${parentX}:${parentY}`;
      if (seenBldParents.has(pKey)) return;
      seenBldParents.add(pKey);

      const bldLayer = layers.buildings || layers.building;
      if (!bldLayer || !bldLayer.features) return;
      const ext = bldLayer.extent || 4096;
      const nParent = 1 << pZoom;

      bldLayer.features.forEach(f => {
        if (!f.geom || !f.geom.length) return;
        const geomWorld = [];
        let inBounds = false;
        for (let l = 0; l < f.geom.length; l++) {
          const ring = f.geom[l];
          if (ring.length < 6) continue;
          const outRing = [];
          for (let i = 0; i < ring.length; i += 2) {
            const normX = (parentX + ring[i] / ext) / nParent;
            const normY = (parentY + ring[i + 1] / ext) / nParent;
            const wx = (normX - geo.X0) * geo.metersPerMerc;
            const wz = (normY - geo.Y0) * geo.metersPerMerc;
            if (Math.abs(wx) <= BLD_HALF && Math.abs(wz) <= BLD_HALF) inBounds = true;
            outRing.push(wx, wz);
          }
          if (outRing.length >= 6) geomWorld.push(outRing);
        }
        if (inBounds && geomWorld.length) {
          buildingFeatures.push({ props: f.props || {}, geom: geomWorld });
        }
      });
    });

    const nearRectX0 = (bldBox.X0 - box.X0) / (box.X1 - box.X0) * SZ;
    const nearRectY0 = (bldBox.Y0 - box.Y0) / (box.Y1 - box.Y0) * SZ;
    const nearRectX1 = (bldBox.X1 - box.X0) / (box.X1 - box.X0) * SZ;
    const nearRectY1 = (bldBox.Y1 - box.Y0) / (box.Y1 - box.Y0) * SZ;

    const vecData = {
      size: SZ,
      waterPolys,
      far,
      near,
      nearCanvasRect: { x: nearRectX0, y: nearRectY0, w: nearRectX1 - nearRectX0, h: nearRectY1 - nearRectY0 },
      fallbackPlaces,
      buildingFeatures
    };

    return {
      data: vecData,
      info: `z${z}/z${bldZ} · дорог ${far.paved.length + near.paved.length}, троп ${far.trails.length + near.trails.length}, рек ${far.rivers.length + near.rivers.length}, зданий ${buildingFeatures.length}`
    };
  }

  // --- Объекты OSM из векторных тайлов (OpenFreeMap + фоллбэк VersaTiles) ---
  const OFM_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
  const OFM_FALLBACK_TPL = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
  const VERSATILES_TPL = 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}';

  let ofmTplPromise = null;
  let ofmFailStreak = 0;
  let ofmSkipUntil = 0;
  const mvtPoiTileCache = new Map();

  function parseEle(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number') return isFinite(raw) && raw > -500 && raw < 9000 ? raw : null;
    const s = String(raw).replace(',', '.').replace(/[^\d.\-]/g, '');
    const v = parseFloat(s);
    return isFinite(v) && v > -500 && v < 9000 ? v : null;
  }

  function getOfmTileTemplate() {
    if (navigator.onLine === false) return Promise.resolve(OFM_FALLBACK_TPL);
    if (ofmTplPromise) return ofmTplPromise;
    ofmTplPromise = (async () => {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 4000);
        const resp = await fetch(OFM_TILEJSON_URL, { mode: 'cors', signal: ctl.signal });
        clearTimeout(tm);
        if (resp.ok) {
          const j = await resp.json();
          if (j && Array.isArray(j.tiles) && j.tiles[0]) return j.tiles[0];
        }
      } catch (e) {}
      ofmTplPromise = null; // не фиксируем фоллбэк навсегда при временном сбое сети
      return OFM_FALLBACK_TPL;
    })();
    return ofmTplPromise;
  }

  async function readCachedMvtBytes(url) {
    if (!url) return null;
    if (WM.offlineArea && typeof WM.offlineArea.readCachedBuffer === 'function') {
      try {
        const buf = await WM.offlineArea.readCachedBuffer(url);
        if (buf && buf.byteLength > 0) return buf;
      } catch (e) {}
    }
    if ('caches' in window) {
      try {
        const resp = await caches.match(url, { ignoreVary: true });
        if (resp && resp.ok) {
          const buf = await resp.arrayBuffer();
          if (buf && buf.byteLength > 0) return buf;
        }
      } catch (e) {}
    }
    return null;
  }

  function writeCachedMvtBytes(url, buf) {
    if (!url || !buf || !buf.byteLength || !('caches' in window)) return;
    caches.open('wm-tiles-v1')
      .then(c => c.put(url, new Response(buf, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile' }
      })))
      .catch(() => {});
  }

  async function fetchPoiMvtTile(z, x, y, allowPoi, signal) {
    const n = 1 << z;
    if (y < 0 || y >= n) return { provider: 'empty', layers: {} };
    x = ((x % n) + n) % n;

    const cacheKey = `${z}/${x}/${y}|${allowPoi ? 1 : 0}`;
    if (mvtPoiTileCache.has(cacheKey)) return mvtPoiTileCache.get(cacheKey);

    const tryCacheAt = async (tz, tx, ty, ofmTplStr) => {
      const candidates = [
        ['versatiles', VERSATILES_TPL.replace('{z}', tz).replace('{x}', tx).replace('{y}', ty)],
        ['openfreemap', (ofmTplStr || OFM_FALLBACK_TPL).replace('{z}', tz).replace('{x}', tx).replace('{y}', ty)]
      ];
      if (ofmTplStr && ofmTplStr !== OFM_FALLBACK_TPL) {
        candidates.push(['openfreemap', OFM_FALLBACK_TPL.replace('{z}', tz).replace('{x}', tx).replace('{y}', ty)]);
      }
      for (const [provider, url] of candidates) {
        const buf = await readCachedMvtBytes(url);
        if (!buf) continue;
        const u8 = await maybeGunzip(buf);
        const layers = u8.length ? extractPoisFromMvt(u8, allowPoi) : {};
        return { provider, layers, tileZ: tz, tileX: tx, tileY: ty };
      }
      return null;
    };

    // 1. Сначала мгновенно проверяем кэш точного тайла (без ожидания TileJSON по сети)
    const fastHit = await tryCacheAt(z, x, y, null);
    if (fastHit) {
      mvtPoiTileCache.set(cacheKey, fastHit);
      if (mvtPoiTileCache.size > 240) mvtPoiTileCache.delete(mvtPoiTileCache.keys().next().value);
      return fastHit;
    }

    const fetchOne = async (url, timeoutMs) => {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), timeoutMs);
      const onAb = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAb, { once: true });
      try {
        const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });
        if (resp.status === 204 || resp.status === 404) return new ArrayBuffer(0);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.arrayBuffer();
      } finally {
        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAb);
      }
    };

    let lastErr = null;
    if (navigator.onLine !== false) {
      const ofmTpl = await getOfmTileTemplate();
      if (ofmTpl !== OFM_FALLBACK_TPL) {
        const tplHit = await tryCacheAt(z, x, y, ofmTpl);
        if (tplHit) {
          mvtPoiTileCache.set(cacheKey, tplHit);
          return tplHit;
        }
      }

      const ofmUrl = ofmTpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const vtUrl = VERSATILES_TPL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const tryOrder = (Date.now() < ofmSkipUntil)
        ? [['versatiles', vtUrl], ['openfreemap', ofmUrl]]
        : [['openfreemap', ofmUrl], ['versatiles', vtUrl]];

      for (const [provider, url] of tryOrder) {
        if (signal && signal.aborted) throw new Error('aborted');
        try {
          const rawBuf = await fetchOne(url, 5000);
          if (rawBuf.byteLength > 0) writeCachedMvtBytes(vtUrl, rawBuf);
          const u8 = rawBuf.byteLength ? await maybeGunzip(rawBuf) : new Uint8Array(0);
          await new Promise(r => setTimeout(r, 0));
          if (signal && signal.aborted) throw new Error('aborted');

          const layers = u8.length ? extractPoisFromMvt(u8, allowPoi) : {};
          if (provider === 'openfreemap') ofmFailStreak = 0;
          const res = { provider, layers, tileZ: z, tileX: x, tileY: y };
          mvtPoiTileCache.set(cacheKey, res);
          if (mvtPoiTileCache.size > 240) mvtPoiTileCache.delete(mvtPoiTileCache.keys().next().value);
          return res;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          lastErr = e;
          if (provider === 'openfreemap') {
            ofmFailStreak++;
            if (ofmFailStreak >= 3) ofmSkipUntil = Date.now() + 60000;
          }
        }
      }
    }

    // 2. Офлайн или сбой сети: пробуем найти родительский тайл (z-1 .. z9) в кэше
    for (let pz = z - 1; pz >= 9; pz--) {
      const shift = z - pz;
      const pHit = await tryCacheAt(pz, x >> shift, y >> shift, null);
      if (pHit) {
        mvtPoiTileCache.set(cacheKey, pHit);
        if (mvtPoiTileCache.size > 240) mvtPoiTileCache.delete(mvtPoiTileCache.keys().next().value);
        return pHit;
      }
    }

    throw lastErr || new Error('MVT-тайлы недоступны офлайн');
  }

  async function maybeGunzip(buf) {
    let u8 = new Uint8Array(buf);
    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const ab = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
      u8 = new Uint8Array(ab);
    }
    return u8;
  }

  const POI_BASE_LAYERS = new Set([
    'mountain_peak', 'place', 'water_name',
    'mountain_peaks', 'place_labels', 'water_polygons_labels'
  ]);
  const POI_EXTRA_LAYERS = new Set(['poi', 'pois']);

  // Берём только те ключи, которые реально используются при построении POI
  const POI_WANTED_KEYS = new Set([
    'name', 'name:ru', 'name_ru', 'name:en', 'name_en', 'name:latin', 'name:int',
    'ele', 'kind', 'class', 'subclass', 'population', 'rank', 'way_area',
    'tourism', 'historic', 'natural', 'amenity'
  ]);
  const LANDMARK_KINDS = new Set([
    'viewpoint', 'alpine_hut', 'wilderness_hut', 'camp_site', 'castle', 'ruins', 'monument', 'memorial'
  ]);

  // Потоковый декодер MVT без замыканий, BigInt в горячем цикле и без разбора ненужных тегов/POI
  function extractPoisFromMvt(u8, allowPoiLayer) {
    const len = u8.length;
    if (!len) return {};
    const dv = new DataView(u8.buffer, u8.byteOffset, len);
    const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const layers = {};

    const readStr = (p, l) => {
      const sub = u8.subarray(p, p + l);
      if (td) return td.decode(sub);
      let s = '';
      for (let i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]);
      return s;
    };

    const skipField = (p, end, wire) => {
      if (wire === 0) { while (p < end && (u8[p++] & 0x80)) {} return p; }
      if (wire === 1) return p + 8;
      if (wire === 2) {
        let l = 0, sh = 0;
        while (p < end) { const b = u8[p++]; l |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
        return p + l;
      }
      if (wire === 5) return p + 4;
      return end;
    };

    const decodeValue = (start, end) => {
      let p = start, val = null;
      while (p < end) {
        let tag = 0, sh = 0;
        while (p < end) { const b = u8[p++]; tag |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
        const f = tag >>> 3, w = tag & 7;
        if (f === 1 && w === 2) {
          let l = 0; sh = 0;
          while (p < end) { const b = u8[p++]; l |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          val = readStr(p, l);
          p += l;
        } else if (f === 2 && w === 5) {
          val = dv.getFloat32(p, true); p += 4;
        } else if (f === 3 && w === 1) {
          val = dv.getFloat64(p, true); p += 8;
        } else if (f === 4 && w === 0) {
          let res = 0, mult = 1, cnt = 0, p0 = p;
          while (p < end) {
            const b = u8[p++]; cnt++;
            if (cnt > 6) {
              let big = 0n, bsh = 0n; p = p0;
              while (p < end) { const x = u8[p++]; big |= BigInt(x & 0x7f) << bsh; if (!(x & 0x80)) break; bsh += 7n; }
              res = Number(BigInt.asIntN(64, big)); break;
            }
            res += (b & 0x7f) * mult; mult *= 128;
            if (!(b & 0x80)) break;
          }
          val = res;
        } else if (f === 5 && w === 0) {
          let res = 0, mult = 1;
          while (p < end) { const b = u8[p++]; res += (b & 0x7f) * mult; mult *= 128; if (!(b & 0x80)) break; }
          val = res;
        } else if (f === 6 && w === 0) {
          let u = 0, bsh = 0, cnt = 0, p0 = p;
          while (p < end) {
            const b = u8[p++]; cnt++;
            if (cnt > 4) {
              let big = 0n, sh2 = 0n; p = p0;
              while (p < end) { const x = u8[p++]; big |= BigInt(x & 0x7f) << sh2; if (!(x & 0x80)) break; sh2 += 7n; }
              val = Number((big >> 1n) ^ -(big & 1n)); u = -1; break;
            }
            u |= (b & 0x7f) << bsh; if (!(b & 0x80)) break; bsh += 7;
          }
          if (u >= 0) val = (u >>> 1) ^ -(u & 1);
        } else if (f === 7 && w === 0) {
          val = u8[p++] !== 0;
        } else {
          p = skipField(p, end, w);
        }
      }
      return val;
    };

    const readGeomFirstPt = (gStart, gEnd, type) => {
      let p = gStart, x = 0, y = 0, sumX = 0, sumY = 0, cnt = 0;
      const rInt = () => {
        let res = 0, sh = 0;
        while (p < gEnd) { const b = u8[p++]; res |= (b & 0x7f) << sh; if (!(b & 0x80)) return res >>> 0; sh += 7; }
        return res >>> 0;
      };
      while (p < gEnd) {
        const cmdInt = rInt();
        const cmd = cmdInt & 7, n = cmdInt >>> 3;
        if (cmd === 1 || cmd === 2) {
          for (let k = 0; k < n; k++) {
            const dx = rInt(), dy = rInt();
            x += (dx >>> 1) ^ -(dx & 1);
            y += (dy >>> 1) ^ -(dy & 1);
            if (type === 1) return [x, y];
            if ((cmd === 1 && cnt === 0) || cmd === 2) { sumX += x; sumY += y; cnt++; }
          }
          if (type === 2 && cnt > 0) break;
        } else if (cmd === 7) {
          if (cnt > 0) break;
        } else break;
      }
      return cnt ? [sumX / cnt, sumY / cnt] : null;
    };

    let pos = 0;
    while (pos < len) {
      let tag = 0, sh = 0;
      while (pos < len) { const b = u8[pos++]; tag |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
      const f = tag >>> 3, w = tag & 7;
      if (f !== 3 || w !== 2) { pos = skipField(pos, len, w); continue; }

      let lLen = 0; sh = 0;
      while (pos < len) { const b = u8[pos++]; lLen |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
      const lStart = pos, lEnd = pos + lLen;
      pos = lEnd;

      // Быстрый проход 1: узнаём имя слоя и собираем байтовые смещения ключей/значений/фич
      let lp = lStart, name = '', extent = 4096, skipLayer = false;
      const keySlices = [], valSlices = [], featSlices = [];

      while (lp < lEnd) {
        let lt = 0; sh = 0;
        while (lp < lEnd) { const b = u8[lp++]; lt |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
        const lf = lt >>> 3, lw = lt & 7;
        if (lf === 1 && lw === 2) {
          let sl = 0; sh = 0;
          while (lp < lEnd) { const b = u8[lp++]; sl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          name = readStr(lp, sl);
          lp += sl;
          if (!POI_BASE_LAYERS.has(name) && !(allowPoiLayer && POI_EXTRA_LAYERS.has(name))) {
            skipLayer = true;
            break;
          }
        } else if (lf === 5 && lw === 0) {
          let ex = 0; sh = 0;
          while (lp < lEnd) { const b = u8[lp++]; ex |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          extent = ex || 4096;
        } else if (lf === 3 && lw === 2) {
          let kl = 0; sh = 0;
          while (lp < lEnd) { const b = u8[lp++]; kl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          keySlices.push(lp, lp + kl);
          lp += kl;
        } else if (lf === 4 && lw === 2) {
          let vl = 0; sh = 0;
          while (lp < lEnd) { const b = u8[lp++]; vl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          valSlices.push(lp, lp + vl);
          lp += vl;
        } else if (lf === 2 && lw === 2) {
          let fl = 0; sh = 0;
          while (lp < lEnd) { const b = u8[lp++]; fl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          featSlices.push(lp, lp + fl);
          lp += fl;
        } else {
          lp = skipField(lp, lEnd, lw);
        }
      }

      if (skipLayer || !name || !featSlices.length) continue;


      // Декодируем только имена ключей из белого списка
      const numKeys = keySlices.length >> 1;
      const keys = new Array(numKeys);
      for (let i = 0; i < numKeys; i++) {
        const ks = keySlices[i << 1], ke = keySlices[(i << 1) + 1];
        const kStr = readStr(ks, ke - ks);
        keys[i] = POI_WANTED_KEYS.has(kStr) ? kStr : null;
      }

      // Значения декодируем лениво по индексу, только когда встретятся у нужной фичи
      const numVals = valSlices.length >> 1;
      const valsCache = new Array(numVals);
      const getVal = (idx) => {
        let v = valsCache[idx];
        if (v !== undefined) return v;
        if (idx < 0 || idx >= numVals) return null;
        v = decodeValue(valSlices[idx << 1], valSlices[(idx << 1) + 1]);
        valsCache[idx] = v;
        return v;
      };

      const isPoiLayer = (name === 'poi' || name === 'pois');
      const features = [];

      for (let idx = 0; idx < featSlices.length; idx += 2) {
        let fp = featSlices[idx], fEnd = featSlices[idx + 1];
        let type = 0, tStart = 0, tEnd = 0, gStart = 0, gEnd = 0;

        while (fp < fEnd) {
          let ft = 0; sh = 0;
          while (fp < fEnd) { const b = u8[fp++]; ft |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          const ff = ft >>> 3, fw = ft & 7;
          if (ff === 3 && fw === 0) {
            let tv = 0; sh = 0;
            while (fp < fEnd) { const b = u8[fp++]; tv |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            type = tv;
          } else if (ff === 2 && fw === 2) {
            let tl = 0; sh = 0;
            while (fp < fEnd) { const b = u8[fp++]; tl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            tStart = fp; tEnd = fp + tl; fp += tl;
          } else if (ff === 4 && fw === 2) {
            let gl = 0; sh = 0;
            while (fp < fEnd) { const b = u8[fp++]; gl |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            gStart = fp; gEnd = fp + gl; fp += gl;
          } else {
            fp = skipField(fp, fEnd, fw);
          }
        }

        if (!gEnd || tEnd <= tStart) continue;

        // Предпроверка тегов ДО разбора геометрии и сборки props
        let tp = tStart;
        let poiSubMatch = !isPoiLayer;
        let hasNameOrEle = false;
        const props = {};

        while (tp < tEnd) {
          let kIdx = 0; sh = 0;
          while (tp < tEnd) { const b = u8[tp++]; kIdx |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          let vIdx = 0; sh = 0;
          while (tp < tEnd) { const b = u8[tp++]; vIdx |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
          const key = keys[kIdx];
          if (!key) continue;
          const val = getVal(vIdx);
          if (val == null || val === '') continue;
          props[key] = val;

          if (key === 'ele' || key.startsWith('name')) hasNameOrEle = true;
          if (isPoiLayer && !poiSubMatch &&
              (key === 'subclass' || key === 'class' || key === 'tourism' || key === 'historic' || key === 'natural' || key === 'amenity')) {
            if (val === 'saddle' || val === 'mountain_pass' || LANDMARK_KINDS.has(val)) poiSubMatch = true;
          }
        }

        if (!poiSubMatch || !hasNameOrEle) continue;

        const pt = readGeomFirstPt(gStart, gEnd, type);
        if (!pt) continue;
        features.push({ x: pt[0], y: pt[1], props });
      }

      if (features.length) layers[name] = { extent, features };
    }
    return layers;
  }

  const pickMvtName = p => p['name:ru'] || p.name_ru || p.name || p['name:latin'] || p['name:en'] || p.name_en || p['name:int'] || '';

  function pickZoomForMaxTiles(box, lo, hi, maxTiles) {
    let z = hi;
    while (z > lo && tileRange(box, z).count > maxTiles) z--;
    return z;
  }

  async function loadOsmPois(geo, job) {
    // 4 сбалансированных яруса: минимум тайлов, высокий зум только у самого наблюдателя
    const tiers = [
      { box: geo.boxForHalf(45000, 2, 2), lo: 9,  hi: 10, maxT: 20, allowPoi: false }, // дальние пики, города, озёра
      { box: geo.boxForHalf(15000, 2, 2), lo: 10, hi: 11, maxT: 16, allowPoi: false }, // средние горы и сёла
      { box: geo.boxForHalf(5500,  2, 2), lo: 11, hi: 12, maxT: 9,  allowPoi: true  }, // ближние детали + основные POI
      { box: geo.boxForHalf(2200,  2, 2), lo: 12, hi: 13, maxT: 4,  allowPoi: true  }  // центр: перевалы, хижины, смотровые
    ];

    const tileMap = new Map();
    for (const tr of tiers) {
      const z = pickZoomForMaxTiles(tr.box, tr.lo, tr.hi, tr.maxT);
      const r = tileRange(tr.box, z);
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          const k = `${z}/${x}/${y}`;
          const prev = tileMap.get(k);
          if (prev) prev.allowPoi = prev.allowPoi || tr.allowPoi;
          else tileMap.set(k, { z, x, y, allowPoi: tr.allowPoi });
        }
      }
    }

    const tileJobs = [...tileMap.values()];
    let done = 0, fail = 0, usedOfm = 0, usedVt = 0, lastErr = null;
    const tileResults = new Array(tileJobs.length).fill(null);
    const queue = tileJobs.map((t, i) => ({ ...t, i }));

    const worker = async () => {
      while (queue.length) {
        if (job.signal.aborted) throw new Error('aborted');
        const t = queue.shift();
        try {
          const res = await fetchPoiMvtTile(t.z, t.x, t.y, t.allowPoi, job.signal);
          tileResults[t.i] = { ...t, ...res };
          if (res.provider === 'openfreemap') usedOfm++;
          else if (res.provider === 'versatiles') usedVt++;
        } catch (e) {
          if (job.signal.aborted) throw e;
          fail++;
          lastErr = e;
        }
        job.progress(++done, tileJobs.length);
      }
    };

    await Promise.all(Array.from({ length: PERF.tileWorkers }, () => worker()));
    if (fail === tileJobs.length) {
      throw new Error('OpenFreeMap и VersaTiles недоступны' + (lastErr ? ': ' + lastErr.message : ''));
    }

    const dedup = new Map();
    const counts = { peak: 0, settlement: 0, locality: 0, landmark: 0 };

    const addPoi = (cat, kind, rawName, lat, lng, ele, pop, wayArea, p, uid) => {
      const { wx, wz } = geo.latLngToWorld(lat, lng);
      const d = Math.hypot(wx, wz);
      const maxR = cat === 'locality' ? 16500 : (cat === 'landmark' ? 25500 : 45000);
      if (d > maxR) return;

      const name = rawName || (ele != null ? `Выс. ${Math.round(ele)} м` : '');
      if (!name) return;

      const prio = computePoiPrio(cat, kind, ele, pop, !!rawName, wayArea);
      const key = `${cat}:${kind}:${name.toLowerCase()}:${Math.round(lat * 250)},${Math.round(lng * 250)}`;
      const prev = dedup.get(key);
      if (prev) {
        if (prev.ele == null && ele != null) { prev.ele = ele; prev.eleExact = true; }
        if (!prev.pop && pop) prev.pop = pop;
        prev.prio = Math.max(prev.prio, prio);
        return;
      }

      dedup.set(key, {
        id: uid,
        cat, kind, name,
        lat, lng,
        ele, eleExact: ele != null,
        pop, way_area: wayArea || 0,
        prio,
        tags: p
      });
      if (counts[cat] != null) counts[cat]++;
    };

    const seenActualTiles = new Set();
    for (const tr of tileResults) {
      if (!tr || !tr.layers) continue;
      const tz = tr.tileZ || tr.z;
      const tx = tr.tileX != null ? tr.tileX : tr.x;
      const ty = tr.tileY != null ? tr.tileY : tr.y;
      const actualKey = `${tz}/${tx}/${ty}`;
      if (seenActualTiles.has(actualKey)) continue;
      seenActualTiles.add(actualKey);

      const nTiles = 1 << tz;
      const toLL = (lx, ly, ext) => ({
        lat: xyToLat((ty + ly / ext) / nTiles),
        lng: xyToLng((tx + lx / ext) / nTiles)
      });

      const peakLayer = tr.layers.mountain_peak || tr.layers.mountain_peaks;
      if (peakLayer) {
        const ext = peakLayer.extent || 4096;
        for (let i = 0; i < peakLayer.features.length; i++) {
          const f = peakLayer.features[i], p = f.props;
          const cls = p.kind || p.class || 'peak';
          const kind = cls === 'volcano' ? 'volcano' : ((cls === 'saddle' || cls === 'mountain_pass') ? 'pass' : 'peak');
          const ele = parseEle(p.ele);
          const rawName = pickMvtName(p);
          if (!rawName && ele == null) continue;
          const ll = toLL(f.x, f.y, ext);
          addPoi('peak', kind, rawName, ll.lat, ll.lng, ele, 0, 0, p, `mvt_pk_${tr.z}_${tr.x}_${tr.y}_${i}`);
        }
      }

      const placeLayer = tr.layers.place || tr.layers.place_labels;
      if (placeLayer) {
        const ext = placeLayer.extent || 4096;
        for (let i = 0; i < placeLayer.features.length; i++) {
          const f = placeLayer.features[i], p = f.props;
          const k = p.kind || p.class || '';
          const rawName = pickMvtName(p);
          if (!rawName) continue;
          let cat = null;
          if (k === 'city' || k === 'town' || k === 'village' || k === 'hamlet') cat = 'settlement';
          else if (k === 'locality' || k === 'isolated_dwelling') cat = 'locality';
          if (!cat) continue;
          const pop = Number(p.population) || (p.rank && p.rank <= 6 ? Math.pow(10, 7 - p.rank) : 0);
          const ll = toLL(f.x, f.y, ext);
          addPoi(cat, k, rawName, ll.lat, ll.lng, null, pop, 0, p, `mvt_pl_${tr.z}_${tr.x}_${tr.y}_${i}`);
        }
      }

      const poiLayer = tr.layers.poi || tr.layers.pois;
      if (poiLayer) {
        const ext = poiLayer.extent || 4096;
        for (let i = 0; i < poiLayer.features.length; i++) {
          const f = poiLayer.features[i], p = f.props;
          const rawName = pickMvtName(p);
          if (!rawName) continue;
          const sub = p.subclass || p.class || p.tourism || p.historic || p.natural || p.amenity || '';
          if (sub === 'saddle' || sub === 'mountain_pass') {
            const ll = toLL(f.x, f.y, ext);
            addPoi('peak', 'pass', rawName, ll.lat, ll.lng, parseEle(p.ele), 0, 0, p, `mvt_ps_${tr.z}_${tr.x}_${tr.y}_${i}`);
          } else if (LANDMARK_KINDS.has(sub)) {
            const ll = toLL(f.x, f.y, ext);
            addPoi('landmark', sub, rawName, ll.lat, ll.lng, parseEle(p.ele), 0, 0, p, `mvt_lm_${tr.z}_${tr.x}_${tr.y}_${i}`);
          }
        }
      }

      const lakeLayer = tr.layers.water_name || tr.layers.water_polygons_labels;
      if (lakeLayer) {
        const ext = lakeLayer.extent || 4096;
        for (let i = 0; i < lakeLayer.features.length; i++) {
          const f = lakeLayer.features[i], p = f.props;
          const rawName = pickMvtName(p);
          const area = Number(p.way_area) || 0;
          if (!rawName || (p.way_area != null && area < 35000)) continue;
          const ll = toLL(f.x, f.y, ext);
          addPoi('landmark', 'lake', rawName, ll.lat, ll.lng, null, 0, area, p, `mvt_lk_${tr.z}_${tr.x}_${tr.y}_${i}`);
        }
      }
    }

    const srcLabel = usedOfm && usedVt ? 'OpenFreeMap + VersaTiles' : (usedVt ? 'VersaTiles' : 'OpenFreeMap');
    return {
      data: [...dedup.values()],
      info: `${srcLabel}: вершин/перевалов ${counts.peak}, н.п. ${counts.settlement}, урочищ ${counts.locality}, мест ${counts.landmark}`
    };
  }















  // ===========================================================================
  // 4. ХАБ ИСТОЧНИКОВ
  // ===========================================================================
  const DC = new Map();
  let _liveHub = null; // хаб открытого окна: его данные нельзя освобождать при вытеснении из кэша
  function dcRelease(ent) {
    const d = ent && ent.res && ent.res.data;
    if (!d || !d._canvas) return;
    const live = _liveHub && _liveHub.sources && _liveHub.sources.vectors && _liveHub.sources.vectors.data;
    if (live === d) return;
    try { d._canvas.width = 0; d._canvas.height = 0; } catch (e) {}
    d._canvas = null;
  }
  function dcGet(key) {
    const v = DC.get(key);
    if (v) { DC.delete(key); DC.set(key, v); }
    return v;
  }
  function dcPut(key, res) {
    const old = DC.get(key);
    if (old && old.res !== res) dcRelease(old);
    DC.delete(key);
    DC.set(key, { t: Date.now(), res });
    while (DC.size > PERF.dcMax) {
      const k = DC.keys().next().value;
      dcRelease(DC.get(k));
      DC.delete(k);
    }
  }

  function createHub(onChange, enabledMap) {
    const hub = { sources: {}, geo: null, gen: 0 };
    const defs = [
      { id: 'demOuter', icon: '⛰️', title: 'Рельеф (дальний, ±45 км)', desc: 'Горизонт и горные хребты (z10)', load: (job) => loadDemBox(job.geo.boxForHalf(OUTER_HALF, OUTER_N, OUTER_N), 10, 11, 30, job) },
      { id: 'demMid', icon: '🏔️', title: 'Рельеф (средний, ±18 км)', desc: 'Детальные профили гор и хребтов (z12)', load: (job) => loadDemBox(job.geo.boxForHalf(MID_HALF, MID_N, MID_N), 11, 12, 42, job) },
      { id: 'demInner', icon: '🪨', title: 'Рельеф (ближний, ±4.5 км)', desc: 'Детальный рельеф вокруг наблюдателя (z13–14)', load: (job) => loadDemBox(job.geo.boxForHalf(INNER_HALF, INNER_N, INNER_N), 13, 14, 36, job) },
      { id: 'osm', icon: '📍', title: 'Вершины и объекты OSM', desc: 'OpenFreeMap / VersaTiles: пики, перевалы, сёла, урочища, виды', load: (job) => loadOsmPois(job.geo, job) },
      { id: 'vectors', icon: '🛣️', title: 'Дороги и реки OSM', desc: 'Векторные тайлы (±8 км) на поверхность рельефа', load: (job) => loadVectorsZone(job.geo, job) },
      { id: 'canopy', icon: '🌲', title: 'Высота деревьев (ближняя, ±2.2 км)', desc: 'Детальный слой крон и прогалин (z13–14)', load: (job) => loadCanopyZone(job.geo, job, CANOPY_HALF, CANOPY_N, 12, 14, 20) },
      { id: 'canopyFar', icon: '🌳', title: 'Высота деревьев (дальняя, ±8 км)', desc: 'Дальние лесные массивы на склонах (z12)', load: (job) => loadCanopyZone(job.geo, job, CANOPY_FAR_HALF, CANOPY_FAR_N, 12, 12, 20) }
    ];

    defs.forEach(def => {
      hub.sources[def.id] = {
        id: def.id, def,
        enabled: !enabledMap || enabledMap[def.id] !== false,
        state: 'idle', msg: '', ms: 0, cached: false, progress: null, data: null, run: 0, ctl: null
      };
    });

    const emit = (id, kind) => { try { onChange(id, kind); } catch (e) { console.error(e); } };

    async function runSource(s, force) {
      const geo = hub.geo;
      if (!geo) return;
      const run = ++s.run, gen = hub.gen;
      if (s.ctl) try { s.ctl.abort(); } catch (e) {}
      s.ctl = new AbortController();
      if (!s.enabled) { s.state = 'off'; s.msg = 'отключён'; s.data = null; emit(s.id, 'data'); return; }
      s.state = 'loading'; s.msg = 'Загрузка…'; s.progress = null;
      emit(s.id, 'state');
      const t0 = performance.now();
      const key = (s.id === 'canopy' || s.id === 'canopyFar')
        ? `${s.id}|${getCanopyVersion()}|${geo.key}`
        : `${s.id}|${geo.key}`;
      try {
        if (force && (s.id === 'demOuter' || s.id === 'demMid' || s.id === 'demInner')) {
          if (WM.demRelief && WM.demRelief.resetNet) WM.demRelief.resetNet();
          demMemoClear();
        }
        const hit = !force && dcGet(key);
        let res, cached = false;
        if (hit && Date.now() - hit.t < 30 * 60e3) { res = hit.res; cached = true; }
        else {
          res = await s.def.load({
            geo,
            force: !!force,
            signal: s.ctl.signal,
            progress: (d, t) => { if (run === s.run) { s.progress = { d, t }; emit(s.id, 'progress'); } }
          });
          if (!res.partial) {
            dcPut(key, res);
          }
        }
        if (run !== s.run || gen !== hub.gen) return;
        s.data = res.data;
        s.state = res.partial ? 'warn' : 'ok';
        s.msg = res.info || 'OK';
        s.ms = Math.round(performance.now() - t0); s.cached = cached; s.progress = null;
         emit(s.id, 'data');
       } catch (e) {
        if (run !== s.run || gen !== hub.gen || (s.ctl && s.ctl.signal.aborted)) return;
        s.state = 'error';
        s.msg = (e && e.message) || String(e);
        s.progress = null;
        emit(s.id, 'data');
      }
    }

    hub.start = (geo) => {
      hub.abort(); hub.geo = geo; hub.gen++;
      Object.values(hub.sources).forEach(s => runSource(s, false));
    };
    hub.reload = (id) => { const s = hub.sources[id]; if (s && hub.geo) return runSource(s, true); };
    hub.reloadAll = () => { if (!hub.geo) return; DC.clear(); hub.start(hub.geo); };
    hub.setEnabled = (id, on) => {
      const s = hub.sources[id]; if (!s) return;
      s.enabled = !!on;
      if (!on) { s.run++; if (s.ctl) try { s.ctl.abort(); } catch (e) {} s.state = 'off'; s.msg = 'отключён'; s.data = null; emit(id, 'data'); }
      else runSource(s, false);
    };
    hub.abort = () => {
      hub.gen++;
      Object.values(hub.sources).forEach(s => { s.run++; if (s.ctl) try { s.ctl.abort(); } catch (e) {} });
    };
    hub.summary = () => {
      const a = Object.values(hub.sources);
      return {
        loading: a.filter(s => s.state === 'loading').length,
        error: a.filter(s => s.state === 'error').length,
        warn: a.filter(s => s.state === 'warn').length,
        ok: a.filter(s => s.state === 'ok').length
      };
    };
    return hub;
  }

  // ===========================================================================
  // 5. СБОРКА СЦЕНЫ НА CPU (СШИТЫЕ СЕТКИ РЕЛЬЕФА, ДЕРЕВЬЯ, POI)
  // ===========================================================================
  function sampleGridBilinear(H, Nx, Ny, halfM, wx, wz) {
    const u = clamp((wx + halfM) / (2 * halfM), 0, 1);
    const v = clamp((wz + halfM) / (2 * halfM), 0, 1);
    const gx = u * (Nx - 1), gz = v * (Ny - 1);
    const x0 = Math.min(Math.floor(gx), Nx - 2);
    const z0 = Math.min(Math.floor(gz), Ny - 2);
    const fx = gx - x0, fz = gz - z0;
    const k = z0 * Nx + x0;
    return (H[k] * (1 - fx) + H[k + 1] * fx) * (1 - fz) +
           (H[k + Nx] * (1 - fx) + H[k + Nx + 1] * fx) * fz;
  }

  function buildBuildingsMesh(buildingFeatures, sampleElevAbs, h0) {
    if (!buildingFeatures || !buildingFeatures.length) return null;
    const verts = []; // stride = 11 floats: pos(3), nrm(3), extra(localY, isRoof)(2), meta(3)
    const getRawY = (wx, wz) => sampleElevAbs(wx, wz) - h0;
    const pushV = (wx, gY, wz, nx, ny, nz, localY, isRoof, rnd, cls, lvl) => {
      verts.push(wx, gY, wz, nx, ny, nz, localY, isRoof, rnd, cls, lvl);
    };

    buildingFeatures.forEach((feat, fIdx) => {
      const props = feat.props || {};
      feat.geom.forEach(rawRing => {
        if (rawRing.length < 6) return;
        // Гарантируем замкнутый контур
        const isClosed = Math.hypot(rawRing[0] - rawRing[rawRing.length - 2], rawRing[1] - rawRing[rawRing.length - 1]) < 0.1;
        const ring = isClosed ? rawRing : [...rawRing, rawRing[0], rawRing[1]];
        const len = ring.length;
        if (len < 8) return;

        let cx = 0, cz = 0, pts = (len / 2) - 1;
        let area2 = 0, longestEdgeLen = 0, ridgeDirX = 1, ridgeDirZ = 0;
        let minRawY = 1e9, maxRawY = -1e9;

        for (let i = 0; i < len - 2; i += 2) {
          const x1 = ring[i], z1 = ring[i + 1];
          const x2 = ring[i + 2], z2 = ring[i + 3];
          cx += x1; cz += z1;
          area2 += x1 * z2 - x2 * z1;

          const ry = getRawY(x1, z1);
          if (ry < minRawY) minRawY = ry;
          if (ry > maxRawY) maxRawY = ry;

          const edx = x2 - x1, edz = z2 - z1;
          const elen = Math.hypot(edx, edz);
          if (elen > longestEdgeLen) {
            longestEdgeLen = elen;
            ridgeDirX = edx / elen;
            ridgeDirZ = edz / elen;
          }
        }
        cx /= pts; cz /= pts;
        const cRawY = getRawY(cx, cz);
        if (cRawY < minRawY) minRawY = cRawY;
        if (cRawY > maxRawY) maxRawY = cRawY;

        const bldArea = Math.abs(area2) * 0.5;
        if (bldArea < 12.0) return;

        // Не ставим здания ближе 14 м к камере старта (чтобы не оказаться внутри стены)
        if (cx * cx + cz * cz < 196) return;

        const hVal = Math.sin(cx * 12.9898 + cz * 78.233 + fIdx) * 43758.5453;
        const rnd = hVal - Math.floor(hVal);

        let levels = parseFloat(props['building:levels']);
        if (!levels || isNaN(levels)) {
          levels = bldArea < 180 ? (1.0 + rnd * 1.5) : (bldArea < 600 ? (2.5 + rnd * 2.5) : (4.0 + rnd * 6.0));
        }
        const bldH = levels * 3.3;
        const isGabled = bldArea < 550 && levels <= 3.5;
        const roofPitch = isGabled ? Math.min(5.0, 2.2 + Math.sqrt(bldArea) * 0.16) : 0.0;

        const botRawY = minRawY - 1.5;
        const eaveRawY = maxRawY;
        const areaClass = bldArea < 180 ? 0.0 : (bldArea < 600 ? 1.0 : 2.0);

        // 1. СТЕНЫ ФАСАДОВ
        for (let i = 0; i < len - 2; i += 2) {
          const x1 = ring[i], z1 = ring[i + 1];
          const x2 = ring[i + 2], z2 = ring[i + 3];
          const dx = x2 - x1, dz = z2 - z1;
          const dLen = Math.hypot(dx, dz) || 1.0;
          const nx = dz / dLen, nz = -dx / dLen;

          pushV(x1, botRawY, z1,  nx, 0, nz, 0.0,  0.0, rnd, areaClass, levels);
          pushV(x2, botRawY, z2,  nx, 0, nz, 0.0,  0.0, rnd, areaClass, levels);
          pushV(x1, eaveRawY, z1, nx, 0, nz, bldH, 0.0, rnd, areaClass, levels);

          pushV(x1, eaveRawY, z1, nx, 0, nz, bldH, 0.0, rnd, areaClass, levels);
          pushV(x2, botRawY, z2,  nx, 0, nz, 0.0,  0.0, rnd, areaClass, levels);
          pushV(x2, eaveRawY, z2, nx, 0, nz, bldH, 0.0, rnd, areaClass, levels);
        }

        // 2. КРЫША (ДВУСКАТНАЯ ИЛИ ПЛОСКАЯ)
        if (isGabled) {
          const ridgeLocalY = bldH + roofPitch;
          for (let i = 0; i < len - 2; i += 2) {
            const x1 = ring[i], z1 = ring[i + 1];
            const x2 = ring[i + 2], z2 = ring[i + 3];
            const edx = x2 - x1, edz = z2 - z1;
            const elen = Math.hypot(edx, edz) || 1.0;
            const cosRidge = Math.abs((edx * ridgeDirX + edz * ridgeDirZ) / elen);

            const p1Proj = (x1 - cx) * ridgeDirX + (z1 - cz) * ridgeDirZ;
            const p2Proj = (x2 - cx) * ridgeDirX + (z2 - cz) * ridgeDirZ;
            const r1x = cx + ridgeDirX * p1Proj, r1z = cz + ridgeDirZ * p1Proj;
            const r2x = cx + ridgeDirX * p2Proj, r2z = cz + ridgeDirZ * p2Proj;

            if (cosRidge > 0.45) {
              const ux = x2 - x1, uz = z2 - z1;
              const vx = r1x - x1, vy = roofPitch, vz = r1z - z1;
              let snx = -uz * vy;
              let sny = uz * vx - ux * vz;
              let snz = ux * vy;
              const snl = Math.hypot(snx, sny, snz) || 1.0;
              snx /= snl; sny = Math.abs(sny / snl); snz /= snl;

              pushV(x1, eaveRawY, z1,   snx, sny, snz, bldH,        1.0, rnd, areaClass, levels);
              pushV(x2, eaveRawY, z2,   snx, sny, snz, bldH,        1.0, rnd, areaClass, levels);
              pushV(r1x, eaveRawY, r1z, snx, sny, snz, ridgeLocalY, 1.0, rnd, areaClass, levels);

              pushV(r1x, eaveRawY, r1z, snx, sny, snz, ridgeLocalY, 1.0, rnd, areaClass, levels);
              pushV(x2, eaveRawY, z2,   snx, sny, snz, bldH,        1.0, rnd, areaClass, levels);
              pushV(r2x, eaveRawY, r2z, snx, sny, snz, ridgeLocalY, 1.0, rnd, areaClass, levels);
            } else {
              const midProj = (p1Proj + p2Proj) * 0.5;
              const rmidX = cx + ridgeDirX * midProj, rmidZ = cz + ridgeDirZ * midProj;
              const fnx = edz / elen, fnz = -edx / elen;

              pushV(x1, eaveRawY, z1,       fnx, 0, fnz, bldH,        0.0, rnd, areaClass, levels);
              pushV(x2, eaveRawY, z2,       fnx, 0, fnz, bldH,        0.0, rnd, areaClass, levels);
              pushV(rmidX, eaveRawY, rmidZ, fnx, 0, fnz, ridgeLocalY, 0.0, rnd, areaClass, levels);
            }
          }
        } else {
          for (let i = 0; i < len - 2; i += 2) {
            pushV(cx, eaveRawY, cz,                 0, 1, 0, bldH, 1.0, rnd, areaClass, levels);
            pushV(ring[i], eaveRawY, ring[i + 1],   0, 1, 0, bldH, 1.0, rnd, areaClass, levels);
            pushV(ring[i + 2], eaveRawY, ring[i + 3], 0, 1, 0, bldH, 1.0, rnd, areaClass, levels);
          }
        }
      });
    });

    if (!verts.length) return null;
    return { data: new Float32Array(verts), count: verts.length / 11 };
  }

  function getWaterPolyMask(vecData) {
    if (!vecData || !vecData.waterPolys || !vecData.waterPolys.length) return null;
    if (vecData._waterMask) return vecData._waterMask;
    const MSZ = 2048;
    const scale = MSZ / (vecData.size || VEC_CANVAS_SZ);
    const cv = document.createElement('canvas');
    cv.width = MSZ; cv.height = MSZ;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    for (let idx = 0; idx < vecData.waterPolys.length; idx++) {
      const poly = vecData.waterPolys[idx];
      ctx.beginPath();
      for (let l = 0; l < poly.length; l++) {
        const ring = poly[l];
        if (ring.length < 6) continue;
        ctx.moveTo(ring[0] * scale, ring[1] * scale);
        for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * scale, ring[i + 1] * scale);
        ctx.closePath();
      }
      ctx.fill();
    }
    const d = ctx.getImageData(0, 0, MSZ, MSZ).data;
    const mask = new Uint8Array(MSZ * MSZ);
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
      mask[i] = d[p]; // сохраняем антиалиасинг 0..255
    }
    return (vecData._waterMask = { mask, size: MSZ });
  }

  function flattenDemGridByWaterMask(H, Nx, Ny, cx, cz, halfM, wm) {
    if (!wm || !wm.mask) return;
    const MSZ = wm.size, mask = wm.mask;
    const cell = (2 * halfM) / (Nx - 1);
    const cov = new Float32Array(Nx * Ny);
    const isW = new Uint8Array(Nx * Ny);
    const invSpan = (MSZ - 1) / (2 * VEC_HALF);
    let waterCnt = 0;

    // 1. Билинейная выборка сглаженной водной маски
    for (let j = 0; j < Ny; j++) {
      const wz = cz - halfM + j * cell;
      if (wz <= -VEC_HALF || wz >= VEC_HALF) continue;
      const fyFull = (wz + VEC_HALF) * invSpan;
      const y0 = Math.min(MSZ - 2, Math.max(0, Math.floor(fyFull)));
      const fy = fyFull - y0, omFy = 1 - fy;
      const r0 = y0 * MSZ, r1 = r0 + MSZ;
      const row = j * Nx;
      for (let i = 0; i < Nx; i++) {
        const wx = cx - halfM + i * cell;
        if (wx <= -VEC_HALF || wx >= VEC_HALF) continue;
        const fxFull = (wx + VEC_HALF) * invSpan;
        const x0 = Math.min(MSZ - 2, Math.max(0, Math.floor(fxFull)));
        const fx = fxFull - x0, omFx = 1 - fx;
        const val = (
          (mask[r0 + x0] * omFx + mask[r0 + x0 + 1] * fx) * omFy +
          (mask[r1 + x0] * omFx + mask[r1 + x0 + 1] * fx) * fy
        ) / 255;
        if (val > 0.02) {
          cov[row + i] = val;
          if (val >= 0.5) {
            isW[row + i] = 1;
            waterCnt++;
          }
        }
      }
    }
    if (!waterCnt) return;

    // 2. Убираем единичные 1-пиксельные провалы вниз внутри воды
    const hClean = new Float32Array(H);
    for (let j = 1; j < Ny - 1; j++) {
      const row = j * Nx;
      for (let i = 1; i < Nx - 1; i++) {
        const k = row + i;
        if (!isW[k]) continue;
        const min4 = Math.min(H[k - 1], H[k + 1], H[k - Nx], H[k + Nx]);
        if (H[k] < min4 - 2.0) hClean[k] = min4;
      }
    }

    // 3. Грубая сетка (~40 м) + min-фильтр в радиусе ~160 м (устойчиво к буграм, сохраняет уклон рек)
    const block = Math.max(1, Math.round(40 / cell));
    const cNx = Math.ceil(Nx / block), cNy = Math.ceil(Ny / block);
    const cMin = new Float32Array(cNx * cNy).fill(1e9);
    for (let j = 0; j < Ny; j++) {
      const cj = Math.floor(j / block) * cNx;
      const row = j * Nx;
      for (let i = 0; i < Nx; i++) {
        const k = row + i;
        if (!isW[k]) continue;
        const ck = cj + Math.floor(i / block);
        if (hClean[k] < cMin[ck]) cMin[ck] = hClean[k];
      }
    }
    const cRad = Math.max(2, Math.min(6, Math.round(160 / (block * cell))));
    const cTmp = new Float32Array(cNx * cNy).fill(1e9);
    for (let cj = 0; cj < cNy; cj++) {
      const row = cj * cNx;
      for (let ci = 0; ci < cNx; ci++) {
        let m = 1e9;
        const i0 = Math.max(0, ci - cRad), i1 = Math.min(cNx - 1, ci + cRad);
        for (let ii = i0; ii <= i1; ii++) if (cMin[row + ii] < m) m = cMin[row + ii];
        cTmp[row + ci] = m;
      }
    }
    const cLow = new Float32Array(cNx * cNy).fill(1e9);
    for (let cj = 0; cj < cNy; cj++) {
      const j0 = Math.max(0, cj - cRad), j1 = Math.min(cNy - 1, cj + cRad);
      for (let ci = 0; ci < cNx; ci++) {
        let m = 1e9;
        for (let jj = j0; jj <= j1; jj++) {
          const v = cTmp[jj * cNx + ci];
          if (v < m) m = v;
        }
        cLow[cj * cNx + ci] = m;
      }
    }

    // 4. Отбираем «честные» ровные ячейки воды не выше cLow + 3.5 м
    const hWater = new Float32Array(Nx * Ny);
    const trusted = new Uint8Array(Nx * Ny);
    const q = new Int32Array(Nx * Ny);
    let qHead = 0, qTail = 0;
    const maxWaterStep = Math.max(2.5, cell * 0.12);

    for (let j = 1; j < Ny - 1; j++) {
      const cj = Math.floor(j / block) * cNx;
      const row = j * Nx;
      for (let i = 1; i < Nx - 1; i++) {
        const k = row + i;
        if (!isW[k]) continue;
        if (!isW[k - 1] || !isW[k + 1] || !isW[k - Nx] || !isW[k + Nx]) continue;
        const low = cLow[cj + Math.floor(i / block)];
        const v = hClean[k];
        if (v > low + 3.5) continue;
        const locMin = Math.min(hClean[k - 1], hClean[k + 1], hClean[k - Nx], hClean[k + Nx]);
        const locMax = Math.max(hClean[k - 1], hClean[k + 1], hClean[k - Nx], hClean[k + Nx]);
        if (locMax - locMin <= maxWaterStep) {
          trusted[k] = 1;
          hWater[k] = v;
          q[qTail++] = k;
        }
      }
    }

    if (qTail === 0) {
      for (let j = 0; j < Ny; j++) {
        const cj = Math.floor(j / block) * cNx;
        const row = j * Nx;
        for (let i = 0; i < Nx; i++) {
          const k = row + i;
          if (!isW[k]) continue;
          const low = cLow[cj + Math.floor(i / block)];
          if (hClean[k] <= low + 2.0) {
            trusted[k] = 1;
            hWater[k] = low < 1e8 ? low : hClean[k];
            q[qTail++] = k;
          }
        }
      }
    }

    // 5. BFS-распространение уровня воды на все участки с береговыми буграми
    while (qHead < qTail) {
      const k = q[qHead++];
      const val = hWater[k];
      const i = k % Nx, j = (k - i) / Nx;
      if (i > 0 && isW[k - 1] && !trusted[k - 1]) { trusted[k - 1] = 1; hWater[k - 1] = val; q[qTail++] = k - 1; }
      if (i < Nx - 1 && isW[k + 1] && !trusted[k + 1]) { trusted[k + 1] = 1; hWater[k + 1] = val; q[qTail++] = k + 1; }
      if (j > 0 && isW[k - Nx] && !trusted[k - Nx]) { trusted[k - Nx] = 1; hWater[k - Nx] = val; q[qTail++] = k - Nx; }
      if (j < Ny - 1 && isW[k + Nx] && !trusted[k + Nx]) { trusted[k + Nx] = 1; hWater[k + Nx] = val; q[qTail++] = k + Nx; }
    }
    for (let k = 0; k < H.length; k++) {
      if (isW[k] && !trusted[k]) hWater[k] = hClean[k];
    }

    // 6. Сглаживание зеркала воды (6 проходов)
    const wTmp = new Float32Array(hWater);
    for (let pass = 0; pass < 6; pass++) {
      const src = pass % 2 === 0 ? hWater : wTmp;
      const dst = pass % 2 === 0 ? wTmp : hWater;
      for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
          const k = row + i;
          if (!isW[k]) continue;
          let sum = src[k] * 2.0, w = 2.0;
          if (isW[k - 1])  { sum += src[k - 1];  w += 1.0; }
          if (isW[k + 1])  { sum += src[k + 1];  w += 1.0; }
          if (isW[k - Nx]) { sum += src[k - Nx]; w += 1.0; }
          if (isW[k + Nx]) { sum += src[k + Nx]; w += 1.0; }
          dst[k] = sum / w;
        }
      }
    }

    // 7. Безусловное выравнивание всех пикселей воды (без порога 18 м) + полоса берега ~50 м
    const work = new Float32Array(H);
    const shoreDist = new Int16Array(Nx * Ny).fill(-1);
    qHead = 0; qTail = 0;

    for (let k = 0; k < H.length; k++) {
      if (isW[k]) {
        work[k] = hWater[k];
        shoreDist[k] = 0;
        q[qTail++] = k;
      }
    }

    const maxShore = Math.max(2, Math.min(8, Math.round(50 / cell)));
    while (qHead < qTail) {
      const k = q[qHead++];
      const d = shoreDist[k];
      if (d >= maxShore) continue;
      const nd = d + 1;
      const i = k % Nx, j = (k - i) / Nx;
      if (i > 0 && shoreDist[k - 1] < 0) { shoreDist[k - 1] = nd; q[qTail++] = k - 1; }
      if (i < Nx - 1 && shoreDist[k + 1] < 0) { shoreDist[k + 1] = nd; q[qTail++] = k + 1; }
      if (j > 0 && shoreDist[k - Nx] < 0) { shoreDist[k - Nx] = nd; q[qTail++] = k - Nx; }
      if (j < Ny - 1 && shoreDist[k + Nx] < 0) { shoreDist[k + Nx] = nd; q[qTail++] = k + Nx; }
    }

    // Субпиксельная кромка воды (0 < cov < 0.5)
    for (let j = 1; j < Ny - 1; j++) {
      const row = j * Nx;
      for (let i = 1; i < Nx - 1; i++) {
        const k = row + i;
        if (isW[k] || cov[k] <= 0.02) continue;
        let wSum = 0, wCnt = 0;
        if (isW[k - 1])  { wSum += work[k - 1];  wCnt++; }
        if (isW[k + 1])  { wSum += work[k + 1];  wCnt++; }
        if (isW[k - Nx]) { wSum += work[k - Nx]; wCnt++; }
        if (isW[k + Nx]) { wSum += work[k + Nx]; wCnt++; }
        if (wCnt) {
          const t = Math.min(1, cov[k] * 2.0);
          work[k] = work[k] + ((wSum / wCnt) - work[k]) * (t * t * (3 - 2 * t));
        }
      }
    }

    // 8. Срезаем торчащие пики/бугры в прибрежной полосе (despike)
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
          const k = row + i;
          const sd = shoreDist[k];
          if (sd <= 0 || sd > maxShore) continue;
          const n4 = [work[k - 1], work[k + 1], work[k - Nx], work[k + Nx]].sort((a, b) => a - b);
          if (work[k] > n4[2] + 1.2) {
            work[k] = n4[2] + 0.5 * (work[k] - n4[2]);
          }
        }
      }
    }

    // 9. Сглаживание прибрежной 30-метровой «ступеньки» DEM (~50 м от уреза воды)
    const sTmp = new Float32Array(work);
    const passes = cell < 25 ? 6 : 4;
    for (let pass = 0; pass < passes; pass++) {
      const src = pass % 2 === 0 ? work : sTmp;
      const dst = pass % 2 === 0 ? sTmp : work;
      for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
          const k = row + i;
          const sd = shoreDist[k];
          if (sd <= 0 || sd > maxShore) continue;
          const blend = 1.0 - (sd - 1) / maxShore;
          const avg = (
            src[k] * 2.0 +
            src[k - 1] + src[k + 1] + src[k - Nx] + src[k + Nx] +
            0.5 * (src[k - Nx - 1] + src[k - Nx + 1] + src[k + Nx - 1] + src[k + Nx + 1])
          ) / 8.0;
          dst[k] = src[k] + (avg - src[k]) * blend;
        }
      }
    }
    if (passes % 2 === 1) {
      for (let k = 0; k < H.length; k++) {
        if (shoreDist[k] > 0 && shoreDist[k] <= maxShore) work[k] = sTmp[k];
      }
    }

    H.set(work);
  }

  function levelDemGridByRoads(H, Nx, Ny, cx, cz, halfM, vecData, opts) {
    if (!vecData || (!vecData.near && !vecData.far)) return;
    const usePaved = !opts || opts.paved !== false;
    const useTrails = !opts || opts.trails !== false;
    if (!usePaved && !useTrails) return;

    const gMinX = cx - halfM, gMaxX = cx + halfM;
    const gMinZ = cz - halfM, gMaxZ = cz + halfM;
    if (gMaxX <= -VEC_HALF || gMinX >= VEC_HALF || gMaxZ <= -VEC_HALF || gMinZ >= VEC_HALF) return;

    const cell = (2 * halfM) / (Nx - 1);
    // rFlat >= ~0.95*cell гарантирует, что все 3 вершины треугольников под полотном получат высоту оси
    const rFlatP = Math.max(7.0, cell * 0.95);
    const rBlendP = Math.max(18.0, cell * 2.25);
    const rFlatT = Math.max(5.5, cell * 0.85);
    const rBlendT = Math.max(15.0, cell * 1.95);
    const rBlendP2 = rBlendP * rBlendP;
    const rBlendT2 = rBlendT * rBlendT;

    const SZ = vecData.size || VEC_CANVAS_SZ;
    const scaleM = (2 * VEC_HALF) / SZ;

    const H_orig = new Float32Array(H);
    const bestD2 = new Float32Array(Nx * Ny).fill(1e12);
    const bestH = new Float32Array(Nx * Ny);
    const bestKind = new Uint8Array(Nx * Ny); // 1 = paved, 2 = trail
    let touched = false;

    const stampSeg = (x1, z1, x2, z2, isPaved) => {
      const rB = isPaved ? rBlendP : rBlendT;
      const rB2 = isPaved ? rBlendP2 : rBlendT2;
      const minX = (x1 < x2 ? x1 : x2) - rB;
      const maxX = (x1 > x2 ? x1 : x2) + rB;
      const minZ = (z1 < z2 ? z1 : z2) - rB;
      const maxZ = (z1 > z2 ? z1 : z2) + rB;
      if (maxX < gMinX || minX > gMaxX || maxZ < gMinZ || minZ > gMaxZ) return;

      const i0 = Math.max(0, Math.floor((minX - gMinX) / cell));
      const i1 = Math.min(Nx - 1, Math.ceil((maxX - gMinX) / cell));
      const j0 = Math.max(0, Math.floor((minZ - gMinZ) / cell));
      const j1 = Math.min(Ny - 1, Math.ceil((maxZ - gMinZ) / cell));

      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz;
      const invLen2 = len2 > 1e-4 ? 1.0 / len2 : 0.0;

      for (let j = j0; j <= j1; j++) {
        const wz = gMinZ + j * cell;
        const row = j * Nx;
        for (let i = i0; i <= i1; i++) {
          const wx = gMinX + i * cell;
          let t = invLen2 ? ((wx - x1) * dx + (wz - z1) * dz) * invLen2 : 0.0;
          if (t < 0.0) t = 0.0;
          else if (t > 1.0) t = 1.0;

          const qx = x1 + dx * t;
          const qz = z1 + dz * t;
          const ex = wx - qx, ez = wz - qz;
          const d2 = ex * ex + ez * ez;
          const k = row + i;
          if (d2 >= rB2 || d2 >= bestD2[k]) continue;

          bestD2[k] = d2;
          bestH[k] = sampleGridBilinear(H_orig, Nx, Ny, halfM, qx - cx, qz - cz);
          bestKind[k] = isPaved ? 1 : 2;
          touched = true;
        }
      }
    };

    const processList = (list, isPaved, zoneFilter) => {
      if (!list || !list.length) return;
      for (let idx = 0; idx < list.length; idx++) {
        const lines = list[idx].lines;
        for (let l = 0; l < lines.length; l++) {
          const pts = lines[l];
          for (let p = 0; p < pts.length - 2; p += 2) {
            const x1 = pts[p] * scaleM - VEC_HALF;
            const z1 = pts[p + 1] * scaleM - VEC_HALF;
            const x2 = pts[p + 2] * scaleM - VEC_HALF;
            const z2 = pts[p + 3] * scaleM - VEC_HALF;
            const mx = (x1 + x2) * 0.5, mz = (z1 + z2) * 0.5;
            if (zoneFilter === 1 && (Math.abs(mx) > BLD_HALF || Math.abs(mz) > BLD_HALF)) continue;
            if (zoneFilter === 2 && Math.abs(mx) <= BLD_HALF && Math.abs(mz) <= BLD_HALF) continue;

            // Длинные диагональные сегменты дробим, чтобы AABB оставался узким
            const segLen = Math.hypot(x2 - x1, z2 - z1);
            if (segLen > 80) {
              const steps = Math.ceil(segLen / 80);
              for (let s = 0; s < steps; s++) {
                const t0 = s / steps, t1 = (s + 1) / steps;
                stampSeg(lerp(x1, x2, t0), lerp(z1, z2, t0), lerp(x1, x2, t1), lerp(z1, z2, t1), isPaved);
              }
            } else {
              stampSeg(x1, z1, x2, z2, isPaved);
            }
          }
        }
      }
    };

    const hasNear = !!(vecData.near && (vecData.near.paved.length || vecData.near.trails.length));
    if (hasNear) {
      if (useTrails) processList(vecData.near.trails, false, 1);
      if (usePaved)  processList(vecData.near.paved,  true,  1);
    }
    if (vecData.far) {
      const farFilter = hasNear ? 2 : 0;
      if (useTrails) processList(vecData.far.trails, false, farFilter);
      if (usePaved)  processList(vecData.far.paved,  true,  farFilter);
    }

    if (!touched) return;

    for (let k = 0; k < H.length; k++) {
      const kind = bestKind[k];
      if (!kind) continue;
      const d = Math.sqrt(bestD2[k]);
      const rf = kind === 1 ? rFlatP : rFlatT;
      const rb = kind === 1 ? rBlendP : rBlendT;
      if (d >= rb) continue;
      const w = d <= rf ? 1.0 : (1.0 - smooth(rf, rb, d));
      H[k] = H_orig[k] + (bestH[k] - H_orig[k]) * w;
    }
  }

  function buildGridMesh(H, Nx, Ny, halfM, h0, skipInnerHalfM) {
    const verts = new Float32Array(Nx * Ny * 6);
    const cell = (2 * halfM) / (Nx - 1);
    const cut = skipInnerHalfM || 0;

    for (let j = 0; j < Ny; j++) {
      const wz = -halfM + j * cell;
      const jU = Math.max(0, j - 1), jD = Math.min(Ny - 1, j + 1);
      const inZCut = cut > 0 && Math.abs(wz) < cut - cell * 2;
      for (let i = 0; i < Nx; i++) {
        const wx = -halfM + i * cell;
        const o = (j * Nx + i) * 6;
        if (inZCut && Math.abs(wx) < cut - cell * 2) continue; // пропускаем вершины строго внутри дырки
        const iL = Math.max(0, i - 1), iR = Math.min(Nx - 1, i + 1);
        const h = H[j * Nx + i] - h0;
        const dhx = (H[j * Nx + iR] - H[j * Nx + iL]) / ((iR - iL) * cell || 1);
        const dhz = (H[jD * Nx + i] - H[jU * Nx + i]) / ((jD - jU) * cell || 1);
        let nx = -dhx, ny = 1, nz = -dhz;
        const invL = 1 / (Math.sqrt(nx * nx + 1 + nz * nz) || 1);
        verts[o] = wx; verts[o + 1] = h; verts[o + 2] = wz;
        verts[o + 3] = nx * invL; verts[o + 4] = invL; verts[o + 5] = nz * invL;
      }
    }

    const idx = new Uint32Array((Nx - 1) * (Ny - 1) * 6);
    const chunks = [];
    const SPLIT = 4;
    let ptr = 0;

    for (let cy = 0; cy < SPLIT; cy++) {
      const j0 = Math.floor((cy * (Ny - 1)) / SPLIT);
      const j1 = Math.floor(((cy + 1) * (Ny - 1)) / SPLIT);
      for (let cx = 0; cx < SPLIT; cx++) {
        const i0 = Math.floor((cx * (Nx - 1)) / SPLIT);
        const i1 = Math.floor(((cx + 1) * (Nx - 1)) / SPLIT);
        const start = ptr;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;

        for (let j = j0; j < j1; j++) {
          const wz0 = -halfM + j * cell, wz1 = wz0 + cell;
          for (let i = i0; i < i1; i++) {
            const wx0 = -halfM + i * cell, wx1 = wx0 + cell;
            if (cut > 0 && Math.abs(wx0) < cut && Math.abs(wx1) < cut && Math.abs(wz0) < cut && Math.abs(wz1) < cut) {
              continue;
            }
            const a = j * Nx + i, b = a + Nx, c = a + 1, d = b + 1;
            const ha = verts[a * 6 + 1], hb = verts[b * 6 + 1], hc = verts[c * 6 + 1], hd = verts[d * 6 + 1];
            if (Math.abs(ha - hd) < Math.abs(hb - hc)) {
              idx[ptr++] = a; idx[ptr++] = b; idx[ptr++] = d;
              idx[ptr++] = a; idx[ptr++] = d; idx[ptr++] = c;
            } else {
              idx[ptr++] = a; idx[ptr++] = b; idx[ptr++] = c;
              idx[ptr++] = c; idx[ptr++] = b; idx[ptr++] = d;
            }

            if (wx0 < x0) x0 = wx0; if (wx1 > x1) x1 = wx1;
            if (wz0 < z0) z0 = wz0; if (wz1 > z1) z1 = wz1;
            const hMinC = Math.min(ha, hb, hc, hd), hMaxC = Math.max(ha, hb, hc, hd);
            if (hMinC < y0) y0 = hMinC;
            if (hMaxC > y1) y1 = hMaxC;
          }
        }
        if (ptr > start) {
          chunks.push({ byteOffset: start * 4, count: ptr - start, x0, x1, y0, y1, z0, z1 });
        }
      }
    }
    return { verts, idx: idx.subarray(0, ptr), count: ptr, chunks };
  }

  function buildZoomGridMesh(rawH, Nx, Ny, cx, cz, halfM, h0, sampleBaseElevAbs) {
    const H = new Float32Array(rawH);
    const cell = (2 * halfM) / (Nx - 1);

    if (sampleBaseElevAbs) {
      for (let j = 0; j < Ny; j++) {
        const wz = cz - halfM + j * cell;
        const dz = Math.abs(wz - cz) / halfM;
        for (let i = 0; i < Nx; i++) {
          const wx = cx - halfM + i * cell;
          const edgeFrac = Math.max(Math.abs(wx - cx) / halfM, dz);
          if (edgeFrac > 0.85) {
            const k = j * Nx + i;
            H[k] = lerp(H[k], sampleBaseElevAbs(wx, wz), smooth(0.85, 1.0, edgeFrac));
          }
        }
      }
    }

    const verts = new Float32Array(Nx * Ny * 6);
    for (let j = 0; j < Ny; j++) {
      const wz = cz - halfM + j * cell;
      const jU = Math.max(0, j - 1), jD = Math.min(Ny - 1, j + 1);
      for (let i = 0; i < Nx; i++) {
        const wx = cx - halfM + i * cell;
        const iL = Math.max(0, i - 1), iR = Math.min(Nx - 1, i + 1);
        const h = H[j * Nx + i] - h0;
        const dhx = (H[j * Nx + iR] - H[j * Nx + iL]) / ((iR - iL) * cell || 1);
        const dhz = (H[jD * Nx + i] - H[jU * Nx + i]) / ((jD - jU) * cell || 1);
        const nx = -dhx, nz = -dhz;
        const invL = 1 / (Math.sqrt(nx * nx + 1 + nz * nz) || 1);
        const o = (j * Nx + i) * 6;
        verts[o] = wx; verts[o + 1] = h; verts[o + 2] = wz;
        verts[o + 3] = nx * invL; verts[o + 4] = invL; verts[o + 5] = nz * invL;
      }
    }

    const idx = new Uint32Array((Nx - 1) * (Ny - 1) * 6);
    const chunks = [];
    const SPLIT = 4;
    let ptr = 0;
    for (let cy = 0; cy < SPLIT; cy++) {
      const j0 = Math.floor((cy * (Ny - 1)) / SPLIT), j1 = Math.floor(((cy + 1) * (Ny - 1)) / SPLIT);
      for (let cxi = 0; cxi < SPLIT; cxi++) {
        const i0 = Math.floor((cxi * (Nx - 1)) / SPLIT), i1 = Math.floor(((cxi + 1) * (Nx - 1)) / SPLIT);
        const start = ptr;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (let j = j0; j < j1; j++) {
          const wz0 = cz - halfM + j * cell, wz1 = wz0 + cell;
          for (let i = i0; i < i1; i++) {
            const wx0 = cx - halfM + i * cell, wx1 = wx0 + cell;
            const a = j * Nx + i, b = a + Nx, c = a + 1, d = b + 1;
            const ha = verts[a * 6 + 1], hb = verts[b * 6 + 1], hc = verts[c * 6 + 1], hd = verts[d * 6 + 1];
            if (Math.abs(ha - hd) < Math.abs(hb - hc)) {
              idx[ptr++] = a; idx[ptr++] = b; idx[ptr++] = d;
              idx[ptr++] = a; idx[ptr++] = d; idx[ptr++] = c;
            } else {
              idx[ptr++] = a; idx[ptr++] = b; idx[ptr++] = c;
              idx[ptr++] = c; idx[ptr++] = b; idx[ptr++] = d;
            }
            if (wx0 < x0) x0 = wx0; if (wx1 > x1) x1 = wx1;
            if (wz0 < z0) z0 = wz0; if (wz1 > z1) z1 = wz1;

            const hMinC = Math.min(ha, hb, hc, hd), hMaxC = Math.max(ha, hb, hc, hd);
            if (hMinC < y0) y0 = hMinC;
            if (hMaxC > y1) y1 = hMaxC;
          }
        }
        if (ptr > start) chunks.push({ byteOffset: start * 4, count: ptr - start, x0, x1, y0, y1, z0, z1 });
      }
    }

    const nrmData = new Uint8Array(Nx * Ny * 4);
    for (let j = 0; j < Ny; j++) {
      const jU = Math.max(0, j - 1), jD = Math.min(Ny - 1, j + 1);
      for (let i = 0; i < Nx; i++) {
        const iL = Math.max(0, i - 1), iR = Math.min(Nx - 1, i + 1);
        const dhx = (H[j * Nx + iR] - H[j * Nx + iL]) / ((iR - iL) * cell || 1);
        const dhz = (H[jD * Nx + i] - H[jU * Nx + i]) / ((jD - jU) * cell || 1);
        const nx = -dhx, nz = -dhz;
        const invL = 1 / (Math.sqrt(nx * nx + 1 + nz * nz) || 1);
        const p = (j * Nx + i) * 4;
        nrmData[p]     = clamp(Math.round((nx * invL * 0.5 + 0.5) * 255), 0, 255);
        nrmData[p + 1] = clamp(Math.round((invL * 0.5 + 0.5) * 255), 0, 255);
        nrmData[p + 2] = clamp(Math.round((nz * invL * 0.5 + 0.5) * 255), 0, 255);
        nrmData[p + 3] = 255;
      }
    }

    return { mesh: { verts, idx: idx.subarray(0, ptr), count: ptr, chunks }, nrmData, H };
  }



  function buildCanopySurfaceMesh(cd, sampleElevAbs, h0, skipInnerHalfM) {
    if (!cd || !cd.grid || !cd.count) return null;
    const g = cd.grid, Nx = cd.box.Nx, Ny = cd.box.Ny;
    const halfM = cd.halfM || (cd.box && cd.box.widthM ? cd.box.widthM * 0.5 : CANOPY_HALF);
    const cell = (2 * halfM) / (Nx - 1);
    const cut = skipInnerHalfM || 0;

    // 1. Заполняем 1-пиксельные «дыры» внутри сплошного леса
    const gFilled = new Uint8Array(g);
    for (let j = 1; j < Ny - 1; j++) {
      const row = j * Nx;
      for (let i = 1; i < Nx - 1; i++) {
        const k = row + i;
        if (g[k] >= 8) continue;
        let nCnt = 0, nSum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const r2 = (j + dj) * Nx;
          for (let di = -1; di <= 1; di++) {
            if (!dj && !di) continue;
            const v = g[r2 + i + di];
            if (v >= 8) { nCnt++; nSum += v; }
          }
        }
        if (nCnt >= 6) gFilled[k] = Math.round(nSum / nCnt);
      }
    }

    // 2. Мягкое сглаживание квантования высот только по лесным ячейкам
    const hasTree = new Uint8Array(Nx * Ny);
    const chArr = new Float32Array(Nx * Ny);
    for (let j = 0; j < Ny; j++) {
      const row = j * Nx;
      for (let i = 0; i < Nx; i++) {
        const k = row + i;
        if (gFilled[k] < 8) continue;
        hasTree[k] = 1;
        let sum = (gFilled[k] / 4) * 2.0, wSum = 2.0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= Ny) continue;
          const r2 = jj * Nx;
          for (let di = -1; di <= 1; di++) {
            if (!dj && !di) continue;
            const ii = i + di;
            if (ii < 0 || ii >= Nx) continue;
            const q = gFilled[r2 + ii];
            if (q >= 8) { sum += q / 4; wSum += 1.0; }
          }
        }
        chArr[k] = sum / wSum;
      }
    }

    // 3. Вершины: (wx, groundY, wz, treeH) с пропуском вырезанной середины
    const verts = new Float32Array(Nx * Ny * 4);
    const skipBound = cut > 0 ? cut - cell * 2 : 0;
    for (let j = 0; j < Ny; j++) {
      const wz = -halfM + j * cell;
      const inZCut = skipBound > 0 && Math.abs(wz) < skipBound;
      for (let i = 0; i < Nx; i++) {
        const wx = -halfM + i * cell;
        if (inZCut && Math.abs(wx) < skipBound) continue;
        const k = j * Nx + i;
        const o = k * 4;
        verts[o]     = wx;
        verts[o + 1] = sampleElevAbs(wx, wz) - h0;
        verts[o + 2] = wz;
        verts[o + 3] = hasTree[k] ? chArr[k] : -0.5;
      }
    }

    // 4. Индексы, сгруппированные в 4x4 чанка для фрустум-отсечения
    const idx = new Uint32Array((Nx - 1) * (Ny - 1) * 6);
    const chunks = [];
    const SPLIT = 4;
    let ptr = 0;

    for (let cy = 0; cy < SPLIT; cy++) {
      const j0 = Math.floor((cy * (Ny - 1)) / SPLIT);
      const j1 = Math.floor(((cy + 1) * (Ny - 1)) / SPLIT);
      for (let cx = 0; cx < SPLIT; cx++) {
        const i0 = Math.floor((cx * (Nx - 1)) / SPLIT);
        const i1 = Math.floor(((cx + 1) * (Nx - 1)) / SPLIT);
        const start = ptr;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;

        for (let j = j0; j < j1; j++) {
          const wz0 = -halfM + j * cell, wz1 = wz0 + cell;
          for (let i = i0; i < i1; i++) {
            const wx0 = -halfM + i * cell, wx1 = wx0 + cell;
            if (cut > 0 && Math.abs(wx0) < cut && Math.abs(wx1) < cut && Math.abs(wz0) < cut && Math.abs(wz1) < cut) {
              continue;
            }
            const a = j * Nx + i, b = a + Nx, c = a + 1, d = b + 1;
            const t1 = hasTree[a] || hasTree[b] || hasTree[c];
            const t2 = hasTree[c] || hasTree[b] || hasTree[d];
            if (!t1 && !t2) continue;


            if (t1) { idx[ptr++] = a; idx[ptr++] = b; idx[ptr++] = c; }
            if (t2) { idx[ptr++] = c; idx[ptr++] = b; idx[ptr++] = d; }

            const ga = verts[a * 4 + 1], gb = verts[b * 4 + 1], gc = verts[c * 4 + 1], gd = verts[d * 4 + 1];
            const ta = verts[a * 4 + 3], tb = verts[b * 4 + 3], tc = verts[c * 4 + 3], td = verts[d * 4 + 3];
            const minG = Math.min(ga, gb, gc, gd) - 3.5;

            const maxTop = Math.max(
              ga + (ta > 0 ? ta : 0),
              gb + (tb > 0 ? tb : 0),
              gc + (tc > 0 ? tc : 0),
              gd + (td > 0 ? td : 0)
            );

            if (wx0 < x0) x0 = wx0; if (wx1 > x1) x1 = wx1;
            if (wz0 < z0) z0 = wz0; if (wz1 > z1) z1 = wz1;
            if (minG < y0) y0 = minG;
            if (maxTop > y1) y1 = maxTop;

            if (minG < y0) y0 = minG;
            if (maxTop > y1) y1 = maxTop;
          }
        }
        if (ptr > start) {
          chunks.push({ byteOffset: start * 4, count: ptr - start, x0, x1, y0, y1, z0, z1 });
        }
      }
    }

    if (!ptr) return null;
    return { verts, idx: idx.subarray(0, ptr), count: ptr, chunks };
  }


  // ===========================================================================
  // 6. ШЕЙДЕРЫ WEBGL2
  // ===========================================================================
  // ===========================================================================
  // 6. ШЕЙДЕРЫ WEBGL2
  // ===========================================================================
  const CANOPY_HOLE_R = 13.5;

  function canopyHoleRadius(ang, cx, cz, baseR) {
    const w = 0.21 * Math.sin(3.0 * ang + cx * 0.031 + cz * 0.023 + 0.6)
            + 0.14 * Math.cos(5.0 * ang - cx * 0.047 + cz * 0.039 + 1.4)
            + 0.08 * Math.sin(8.0 * ang + cx * 0.071 - cz * 0.061 + 2.3);
    return baseR * (1.0 + w);
  }

  const HEAD = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n';

  const GLSL_HOLE_FN = `
float canopyHoleRadius(vec2 dXZ, vec2 camXZ, float baseR) {
  float len = length(dXZ);
  if (len < 0.001) return baseR;
  float ang = atan(dXZ.y, dXZ.x);
  float w = 0.21 * sin(3.0 * ang + camXZ.x * 0.031 + camXZ.y * 0.023 + 0.6)
          + 0.14 * cos(5.0 * ang - camXZ.x * 0.047 + camXZ.y * 0.039 + 1.4)
          + 0.08 * sin(8.0 * ang + camXZ.x * 0.071 - camXZ.y * 0.061 + 2.3);
  return baseR * (1.0 + w);
}`;

  const VS_TRI = HEAD + `
out vec2 vUV; out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p; vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`;

const FS_SHADOW_BAKE = HEAD + `
uniform sampler2D uDemInnerTex;
uniform sampler2D uDemMidTex;
uniform sampler2D uDemOuterTex;
uniform sampler2D uCanopyNearTex;
uniform sampler2D uCanopyFarTex;

uniform vec4 uBakeBox;     // x = cascadeHalfM, y = INNER_HALF, z = MID_HALF, w = OUTER_HALF
uniform vec4 uDemFlags;    // x = hasInner, y = hasMid, z = hasOuter, w = hMaxRel
uniform vec4 uDemGridN;    // x = INNER_N, y = MID_N, z = OUTER_N, w = uFloatLinear (0/1)
uniform vec4 uCanopyMeta;  // x = nearHalf (0=off), y = farHalf (0=off), z = minH, w = treeScale
uniform vec4 uCanopyGridN; // x = CANOPY_N, y = CANOPY_FAR_N, z = treeZScale, w = zScale
uniform vec4 uLightBake;   // xyz = dir to light (normalized), w = curv (0/1)
uniform vec4 uBakeOpt;     // x = needTerr, y = needForest, z = h0, w = cascadeCellM

in vec2 vUV;
out vec4 fragColor;

float sampleR32F(sampler2D tex, vec2 uv, float sz) {
  if (uDemGridN.w > 0.5) return texture(tex, uv).r;
  vec2 fc = clamp(uv * sz - 0.5, vec2(0.0), vec2(sz - 1.001));
  ivec2 i0 = ivec2(floor(fc));
  ivec2 i1 = min(i0 + 1, ivec2(int(sz) - 1));
  vec2 f = fract(fc);
  float a = texelFetch(tex, i0, 0).r;
  float b = texelFetch(tex, ivec2(i1.x, i0.y), 0).r;
  float c = texelFetch(tex, ivec2(i0.x, i1.y), 0).r;
  float d = texelFetch(tex, i1, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float sampleDemRel(vec2 p) {
  vec2 ap = abs(p);
  float m = max(ap.x, ap.y);
  float hAbs;
  if (uDemFlags.x > 0.5 && m <= uBakeBox.y * 0.96) {
    vec2 uv = ((p / (2.0 * uBakeBox.y) + 0.5) * (uDemGridN.x - 1.0) + 0.5) / uDemGridN.x;
    hAbs = sampleR32F(uDemInnerTex, uv, uDemGridN.x);
  } else if (uDemFlags.y > 0.5 && m <= uBakeBox.z * 0.96) {
    vec2 uv = ((p / (2.0 * uBakeBox.z) + 0.5) * (uDemGridN.y - 1.0) + 0.5) / uDemGridN.y;
    hAbs = sampleR32F(uDemMidTex, uv, uDemGridN.y);
  } else {
    vec2 c = clamp(p, -vec2(uBakeBox.w), vec2(uBakeBox.w));
    vec2 uv = ((c / (2.0 * uBakeBox.w) + 0.5) * (uDemGridN.z - 1.0) + 0.5) / uDemGridN.z;
    hAbs = sampleR32F(uDemOuterTex, uv, uDemGridN.z);
  }
  return (hAbs - uBakeOpt.z) * uCanopyGridN.w;
}

float sampleCanopyRaw(vec2 p) {
  float m = max(abs(p.x), abs(p.y));
  if (uCanopyMeta.x > 10.0 && m <= uCanopyMeta.x) {
    vec2 uv = ((p / (2.0 * uCanopyMeta.x) + 0.5) * (uCanopyGridN.x - 1.0) + 0.5) / uCanopyGridN.x;
    return texture(uCanopyNearTex, uv).r * 63.75;
  }
  if (uCanopyMeta.y > 10.0 && m <= uCanopyMeta.y) {
    vec2 uv = ((p / (2.0 * uCanopyMeta.y) + 0.5) * (uCanopyGridN.y - 1.0) + 0.5) / uCanopyGridN.y;
    return texture(uCanopyFarTex, uv).r * 63.75;
  }
  return 0.0;
}

void main() {
  vec2 wxz = (vUV * 2.0 - 1.0) * uBakeBox.x;
  float y0 = sampleDemRel(wxz);

  float rawH0 = (uBakeOpt.y > 0.5) ? sampleCanopyRaw(wxz) : 0.0;
  float fCover = (uBakeOpt.y > 0.5) ? smoothstep(uCanopyMeta.z - 0.8, uCanopyMeta.z + 1.0, rawH0) : 0.0;

  if (uLightBake.y <= 0.012) {
    fragColor = vec4(1.0, 0.0, fCover, 1.0);
    return;
  }

  float horLen = max(length(uLightBake.xz), 1e-4);
  vec2 rayDir = uLightBake.xz / horLen;
  float tanSlope = uLightBake.y / horLen;
  float curvDropK = uLightBake.w / 14646000.0;

  // 1. Падающая тень от гор (с экспоненциальным шагом до границ сцены)
  float terrShadow = 0.0;
  if (uBakeOpt.x > 0.5) {
    float maxEx = -1.0;
    float d = max(uBakeOpt.w * 1.15, 18.0);
    float yStart = y0 + max(1.2, uBakeOpt.w * 0.03);
    for (int i = 0; i < 76; i++) {
      vec2 sp = wxz + rayDir * d;
      if (abs(sp.x) > uBakeBox.w || abs(sp.y) > uBakeBox.w) break;
      float rayY = yStart + d * tanSlope;
      if (rayY > uDemFlags.w + 50.0) break;
      float hs = sampleDemRel(sp) - curvDropK * d * d;
      float ex = (hs - rayY) / d;
      if (ex > maxEx) maxEx = ex;
      if (maxEx > 0.028) break;
      d *= 1.115;
    }
    terrShadow = smoothstep(0.003, 0.024, maxEx);
  }

  // 2. Падающая тень от деревьев (по высотам крон + углу света)
  float forestShadow = 0.0;
  float maxCanHalf = max(uCanopyMeta.x, uCanopyMeta.y);
  if (uBakeOpt.y > 0.5 && maxCanHalf > 10.0 && max(abs(wxz.x), abs(wxz.y)) <= maxCanHalf + 600.0) {
    float maxTreeH = 48.0 * uCanopyMeta.w * uCanopyGridN.z;
    float maxFDist = clamp(maxTreeH / max(tanSlope, 0.075), 35.0, 560.0);
    float dStart = max(uBakeOpt.w * 0.75, 6.0);
    float span = max(maxFDist - dStart, 10.0);
    float maxOcc = 0.0;
    const int F_STEPS = 24;
    for (int i = 0; i < F_STEPS; i++) {
      float t = float(i) / float(F_STEPS - 1);
      float d = dStart + span * (t * (0.45 + 0.55 * t));
      vec2 sp = wxz + rayDir * d;
      if (abs(sp.x) > maxCanHalf || abs(sp.y) > maxCanHalf) break;
      float rawH = sampleCanopyRaw(sp);
      if (rawH < uCanopyMeta.z - 0.8) continue;
      float treeH = smoothstep(uCanopyMeta.z - 0.8, uCanopyMeta.z + 0.8, rawH) * rawH * uCanopyMeta.w * uCanopyGridN.z;
      float topY = sampleDemRel(sp) + treeH - curvDropK * d * d;
      float rayY = y0 + d * tanSlope;
      float occ = smoothstep(-1.4, 2.6, topY - rayY);
      if (occ > maxOcc) maxOcc = occ;
      if (maxOcc > 0.98) break;
    }
    forestShadow = maxOcc;
  }

  fragColor = vec4(terrShadow, forestShadow, fCover, 1.0);
}`;

const GLSL_SHADOW_FN = `
uniform sampler2D uShadowTex0;
uniform sampler2D uShadowTex1;
uniform sampler2D uShadowTex2;
uniform vec4 uShadowOpt;  // x = castTerr, y = castForest, z = sunUp (0..1), w = unused
uniform vec3 uSunDirOnly; // normalized sun direction

vec3 sampleShadowCascades(vec2 wxz) {
  float m = max(abs(wxz.x), abs(wxz.y));
  if (m < 3250.0) {
    vec2 uv0 = wxz / (2.0 * 3300.0) + 0.5;
    vec3 s0 = texture(uShadowTex0, uv0).rgb;
    if (m > 2850.0) {
      vec2 uv1 = wxz / (2.0 * 12000.0) + 0.5;
      vec3 s1 = texture(uShadowTex1, uv1).rgb;
      return mix(s0, s1, smoothstep(2850.0, 3250.0, m));
    }
    return s0;
  }
  if (m < 11800.0) {
    vec2 uv1 = wxz / (2.0 * 12000.0) + 0.5;
    vec3 s1 = texture(uShadowTex1, uv1).rgb;
    if (m > 10500.0) {
      vec2 uv2 = wxz / (2.0 * 45000.0) + 0.5;
      vec3 s2 = texture(uShadowTex2, uv2).rgb;
      return mix(s1, s2, smoothstep(10500.0, 11800.0, m));
    }
    return s1;
  }
  vec2 uv2 = clamp(wxz / (2.0 * 45000.0) + 0.5, 0.001, 0.999);
  return texture(uShadowTex2, uv2).rgb;
}`;

  const VS_TERRAIN = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uVP;
uniform vec4 uCam;     // xyz = pos, w = curTime
uniform float uZScale;
uniform float uCurv;
out vec3 vWorld;
out vec3 vNrm;
out float vRawY;
void main() {
  vec3 p = vec3(aPos.x, aPos.y * uZScale, aPos.z);
  vec2 dXZ = p.xz - uCam.xz;
  p.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;
  vNrm = normalize(vec3(aNrm.x, aNrm.y / max(uZScale, 0.01), aNrm.z));
  vWorld = p;
  vRawY = aPos.y;
  gl_Position = uVP * vec4(p, 1.0);
}`;

  const FS_TERRAIN = HEAD + `
uniform sampler2D uVecTex;
uniform vec4 uCam;
uniform vec4 uLightDir; // xyz, w = intensity
uniform vec4 uSunCol;   // rgb, w = night

uniform vec4 uSkyHor;
uniform vec4 uMode;     // x = mode (0..4), y = showIsolines, z = isoStep, w = h0
uniform vec4 uRange;    // x = fogDist, y = hMinAbs, z = hMaxAbs, w = darkTheme
uniform vec4 uVecOpt;   // x = VEC_HALF, y = showRoads, z = showRivers, w = zScale
uniform vec3 uRoadPavedDay;
uniform vec3 uRoadPavedNight;
uniform vec3 uRoadTrailDay;
uniform vec3 uRoadTrailNight;

in vec3 vWorld;
in vec3 vNrm;
in float vRawY;
out vec4 fragColor;

uniform sampler2D uZoomNrmTex;
uniform vec4 uZoomBox;   // xy = center (cx, cz), z = halfM, w = active (0/1)
uniform float uSkipZoom; // 1.0 = базовые меши (вырезаем центр), 0.0 = zoomMesh
uniform float uZScale;

uniform vec4 uTerrDet1;  // x = enabled, y = bumpStrength, z = macroScale, w = microScale
uniform vec4 uTerrDet2;  // x = cragStrength, y = strataStrength, z = strataFreq, w = cavityAO
uniform vec4 uTerrDet3;  // x = detailDist, y = macroDist, z = swissBoost, w = albedoRough
uniform vec4 uTerrDet4;  // x = smartFogOn, y = slopeDetail, z = hypsoWarp, w = 0
uniform vec4 uTerrCnt1;  // x = isoWarpAmp, y = microContourStr, z = microContourFreq, w = isoOpacity

${GLSL_SHADOW_FN}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Возвращает vec3(значение 0..1, d/dx, d/dz) за один проход
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  vec2 grad = du * (vec2(k1, k2) + k3 * u.yx);
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, grad);
}

vec3 hypsoColor(float hAbs, float hMin, float hMax) {
  float t = clamp((hAbs - hMin) / max(hMax - hMin, 20.0), 0.0, 1.0);
  const vec3 c0 = vec3(0.0290, 0.1643, 0.0433); // долина
  const vec3 c1 = vec3(0.2793, 0.3494, 0.0707); // предгорья
  const vec3 c2 = vec3(0.3494, 0.1989, 0.0815); // склоны
  const vec3 c3 = vec3(0.1989, 0.1643, 0.1483); // скалы
  const vec3 c4 = vec3(0.8727, 0.9141, 0.9781); // вершины / снег
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.52) return mix(c1, c2, (t - 0.25) / 0.27);
  if (t < 0.80) return mix(c2, c3, (t - 0.52) / 0.28);
  return mix(c3, c4, (t - 0.80) / 0.20);
}

vec3 slopeColor(float deg) {
  const vec3 cSafe  = vec3(0.0433, 0.3746, 0.1056); // < 20°
  const vec3 cMod   = vec3(0.7176, 0.5789, 0.0358); // 20..30°
  const vec3 cSteep = vec3(0.8324, 0.1812, 0.0132); // 30..40°
  const vec3 cExtr  = vec3(0.7176, 0.0177, 0.0230); // > 40°
  if (deg < 20.0) return mix(cSafe, cMod, smoothstep(12.0, 20.0, deg));
  if (deg < 30.0) return mix(cMod, cSteep, smoothstep(20.0, 30.0, deg));
  if (deg < 40.0) return mix(cSteep, cExtr, smoothstep(30.0, 40.0, deg));
  return cExtr;
}

float isoMask(float hAbs, float stepM) {
  float s = max(stepM, 5.0);
  float v = hAbs / s;
  float f = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-4);
  float thin = 1.0 - smoothstep(0.6, 1.5, f);
  float vMaj = hAbs / (s * 5.0);
  float fMaj = abs(fract(vMaj - 0.5) - 0.5) / max(fwidth(vMaj), 1e-4);
  float major = 1.0 - smoothstep(0.7, 1.8, fMaj);
  return max(thin * 0.45, major * 0.85);
}

void main() {
  vec3 N = normalize(vNrm);
  if (uZoomBox.w > 0.5) {
    vec2 zd = abs(vWorld.xz - uZoomBox.xy) / uZoomBox.z;
    float zEdge = max(zd.x, zd.y);
    if (uSkipZoom > 0.5) {
      if (zEdge < 0.93) discard;
    } else {
      vec2 zuv = (vWorld.xz - uZoomBox.xy) / (2.0 * uZoomBox.z) + 0.5;
      vec3 zN = texture(uZoomNrmTex, clamp(zuv, 0.002, 0.998)).xyz * 2.0 - 1.0;
      zN = normalize(vec3(zN.x, zN.y / max(uZScale, 0.01), zN.z));
      N = normalize(mix(zN, N, smoothstep(0.85, 0.95, zEdge)));
    }
  }
  vec3 L = normalize(uLightDir.xyz);
  vec3 V = normalize(uCam.xyz - vWorld);
  float dist = length(uCam.xyz - vWorld);
  float hAbs = uMode.w + vRawY;
  int mode = int(uMode.x + 0.5);
  bool dark = uRange.w > 0.5;

  vec3 N_geom = N;
  float shTerr = 0.0;
  float shForest = 0.0;
  float fCover = 0.0;
  if (uShadowOpt.x > 0.5 || uShadowOpt.y > 0.5) {
    vec3 sh = sampleShadowCascades(vWorld.xz);
    shTerr = sh.r;
    shForest = sh.g;
    fCover = sh.b;
  }
  float terrVis = (uShadowOpt.x > 0.5) ? shTerr : 0.0;
  float forVis  = (uShadowOpt.y > 0.5) ? (shForest * (1.0 - shTerr * 0.85)) : 0.0;
  float dirLit  = (1.0 - terrVis) * (1.0 - forVis * 0.90);

  float baseSlopeDeg = degrees(acos(clamp(N.y, 0.0, 1.0)));
  float detVal = 0.5;
  float detMicro = 0.5;
  float detCavity = 0.0;
  float strataMask = 0.0;
  float microDistFade = 0.0;

  if (uTerrDet1.x > 0.5 && dist < max(uTerrDet3.y, 2000.0)) {
    vec2 wp = vWorld.xz;
    float macroFade = 1.0 - smoothstep(uTerrDet3.y * 0.45, uTerrDet3.y, dist);
    vec3 nMacro = noised(wp / max(uTerrDet1.z, 5.0));
    detVal = nMacro.x;
    vec2 grad = (nMacro.yz / max(uTerrDet1.z, 5.0)) * (uTerrDet1.y * 8.0) * macroFade;

    microDistFade = 1.0 - smoothstep(uTerrDet3.x * 0.25, uTerrDet3.x, dist);
    if (microDistFade > 0.01) {
      const mat2 rot2  = mat2(0.80, -0.60, 0.60, 0.80);
      const mat2 rot2T = mat2(0.80,  0.60,-0.60, 0.80);
      vec2 wp2 = rot2 * wp;
      vec3 nMicro = noised(wp2 / max(uTerrDet1.w, 1.5));
      detMicro = nMicro.x;
      grad += (rot2T * (nMicro.yz / max(uTerrDet1.w, 1.5))) * (uTerrDet1.y * 2.2) * microDistFade;

      float rockMask = smoothstep(16.0, 36.0, baseSlopeDeg);
      if (uTerrDet2.x > 0.01 && rockMask > 0.01) {
        vec2 wp3 = rot2 * (wp2 * 1.37 + vec2(31.7, 17.3));
        vec3 nCrag = noised(wp3 / max(uTerrDet1.w * 0.75, 1.5));
        float sgn = clamp((nCrag.x * 2.0 - 1.0) * 6.0, -1.0, 1.0);
        grad += (rot2T * (-sgn * 2.0 * nCrag.yz / max(uTerrDet1.w * 0.75, 1.5))) * (uTerrDet2.x * 1.4 * rockMask) * microDistFade;
        detMicro = mix(detMicro, 1.0 - abs(nCrag.x * 2.0 - 1.0), 0.45 * rockMask);
      }

      if (uTerrDet2.y > 0.01) {
        float sMask = smoothstep(18.0, 40.0, baseSlopeDeg) * microDistFade;
        if (sMask > 0.01) {
          float phase = hAbs * uTerrDet2.z + (nMacro.x - 0.5) * 3.5;
          strataMask = sin(phase) * sMask * uTerrDet2.y;
          vec2 hSlope = N.xz / max(length(N.xz), 0.05);
          grad += hSlope * (cos(phase) * uTerrDet2.z * 2.2 * uTerrDet2.y * sMask);
        }
      }
    }

    N = normalize(vec3(N.x - grad.x, max(N.y, 0.08), N.z - grad.y));
    float comb = mix(detVal, detMicro, 0.65 * microDistFade + 0.15);
    detCavity = (comb - 0.5) * 2.0 * uTerrDet2.w * mix(0.40, 1.0, microDistFade);
  }

  float hHypso = hAbs + (detVal - 0.5) * uTerrDet4.z;
  float ndl = max(dot(N, L), 0.0);
  float wrap = clamp(dot(N, L) * 0.55 + 0.45, 0.0, 1.0);
  float slopeDeg = mix(baseSlopeDeg, degrees(acos(clamp(N.y, 0.0, 1.0))), uTerrDet4.y);

  // Швейцарская боковая отмывка (СЗ 315°, ~38° над горизонтом)
  const vec3 L_swiss = vec3(-0.557, 0.616, -0.557);
  float swissRaw = clamp(dot(N, L_swiss) * 0.65 + 0.48, 0.14, 1.18);
  float swissShade = clamp(mix(0.62, swissRaw, uTerrDet3.z), 0.10, 1.28);
  float slopeAO = mix(1.05, 0.72, smoothstep(8.0, 48.0, baseSlopeDeg));
  float detLightMod = clamp((1.0 + detCavity + strataMask * 0.22) * (1.0 + (detMicro - 0.5) * uTerrDet3.w * microDistFade), 0.55, 1.45);

  bool smartFog = uTerrDet4.x > 0.5;
  float fogK = smartFog ? 0.0 : 1.0;

  vec3 col = vec3(0.0);
  float fogF = clamp(1.0 - exp(-dist / max(uRange.x * 0.65, 600.0)), 0.0, 0.92);

  if (mode == 0) {
    // 0: Контуры / Хребты
    vec3 nearCol = dark ? vec3(0.0132, 0.0259, 0.0561) : vec3(0.3746, 0.4854, 0.6121);
    vec3 farCol  = dark ? vec3(0.0063, 0.0154, 0.0394) : vec3(0.7549, 0.8324, 0.9141);
    float shade = mix(0.68, 1.14, swissShade * 0.72 + wrap * 0.28) * slopeAO * mix(1.0, detLightMod, 0.55);
    col = mix(nearCol * shade, farCol, clamp(pow(dist / max(uRange.x, 1500.0), 0.65), 0.0, 0.92) * (smartFog ? 0.15 : 1.0));
  } else if (mode == 1) {
    // 1: CG (подсветка склонов от Солнца и Луны)
    vec3 alb = hypsoColor(hHypso, uRange.y, uRange.z);
    alb = mix(alb, vec3(0.1726, 0.1562, 0.1406), smoothstep(30.0, 50.0, baseSlopeDeg) * 0.70);
    alb *= detLightMod;
    vec3 amb = mix(vec3(0.0039, 0.0063, 0.0177), vec3(0.0608, 0.1056, 0.2371), 1.0 - uSunCol.w)
             * (0.60 + 0.40 * N.y) * mix(0.62, 1.28, swissShade) * slopeAO;
    vec3 sun = uSunCol.rgb * uLightDir.w * ndl * dirLit;
    amb *= mix(vec3(1.0), vec3(0.74, 0.82, 0.97), max(terrVis, forVis * 0.65));
    col = alb * (sun + amb);
    col = mix(col, uSkyHor.rgb, fogF * 0.85 * fogK);
  } else if (mode == 2) {
    // 2: Гипсометрия
    vec3 alb = hypsoColor(hHypso, uRange.y, uRange.z) * detLightMod;
    col = alb * mix(0.45, 1.15, wrap * 0.55 + swissShade * 0.45) * slopeAO;
    col = mix(col, uSkyHor.rgb, fogF * 0.72 * fogK);
  } else if (mode == 3) {
    // 3: Уклоны (крутизна)
    vec3 alb = slopeColor(slopeDeg);
    col = alb * mix(0.48, 1.12, wrap * 0.5 + swissShade * 0.5) * mix(1.0, detLightMod, uTerrDet4.y);
    col = mix(col, uSkyHor.rgb, fogF * 0.72 * fogK);
  } else if (mode == 4) {
    // 4: Топо-сетка
    vec3 bg = dark ? vec3(0.0029, 0.0063, 0.0154) : vec3(0.8324, 0.7931, 0.6994);
    col = bg * mix(0.76, 1.08, swissShade * 0.65 + wrap * 0.35) * mix(1.0, detLightMod, 0.45);
    float rDist = length(vWorld.xz - uCam.xz);
    float ringV = rDist / 2000.0;
    float ringF = abs(fract(ringV - 0.5) - 0.5) / max(fwidth(ringV), 1e-4);
    float ringLine = (1.0 - smoothstep(0.6, 1.5, ringF)) * (1.0 - smoothstep(1000.0, 25000.0, dist));
    vec3 ringCol = dark ? vec3(0.0230, 0.1483, 0.3494) : vec3(0.0815, 0.1989, 0.4281);
    col = mix(col, ringCol, ringLine * 0.5);
    col = mix(col, uSkyHor.rgb, fogF * 0.70 * fogK);
  } else {
    // 5: Гибрид
    vec3 nearCol = dark ? vec3(0.0132, 0.0259, 0.0561) : vec3(0.4143, 0.5310, 0.6637);
    vec3 farCol  = dark ? vec3(0.0063, 0.0154, 0.0394) : vec3(0.7549, 0.8324, 0.9141);
    float cShade = mix(0.70, 1.12, swissShade * 0.70 + wrap * 0.30) * slopeAO * mix(1.0, detLightMod, 0.45);
    vec3 contourCol = mix(nearCol * cShade, farCol, clamp(pow(dist / max(uRange.x, 1500.0), 0.65), 0.0, 0.90) * (smartFog ? 0.15 : 1.0));

    vec3 alb = hypsoColor(hHypso, uRange.y, uRange.z);
    alb = mix(alb, vec3(0.1726, 0.1562, 0.1406), smoothstep(30.0, 50.0, baseSlopeDeg) * 0.70);
    alb *= detLightMod;
    vec3 amb = mix(vec3(0.0039, 0.0063, 0.0177), vec3(0.0608, 0.1056, 0.2371), 1.0 - uSunCol.w)
             * (0.60 + 0.40 * N.y) * mix(0.62, 1.28, swissShade) * slopeAO;
    vec3 sun = uSunCol.rgb * uLightDir.w * ndl;

    vec3 H = normalize(L + V);
    float hNorm = clamp((hHypso - uRange.y) / max(uRange.z - uRange.y, 20.0), 0.0, 1.0);
    float specPow = mix(18.0, 44.0, smoothstep(0.6, 0.95, hNorm));
    float spec = pow(max(dot(N, H), 0.0), specPow) * (0.14 + 0.28 * ndl) * uLightDir.w;

    vec3 cgCol = alb * (sun + amb) + uSunCol.rgb * (spec * dirLit);
    cgCol = mix(cgCol, uSkyHor.rgb, fogF * 0.72 * fogK);

    float reliefVis = mix(0.82, 0.46, clamp(dist / max(uRange.x * 0.85, 1200.0), 0.0, 1.0));
    col = mix(contourCol, cgCol, reliefVis);
  }





  // Наложение дорог и воды (ранний отсекатель dist < 8000.0)
  vec3 vm = vec3(0.0);
  float vecFade = 0.0;
  float waterMask = 0.0;
  float isRivMask = 0.0;
  if (dist < 8000.0 && (uVecOpt.y > 0.5 || uVecOpt.z > 0.5 || uVecOpt.w > 0.5)) {
    vec2 vuv = vWorld.xz / (2.0 * uVecOpt.x) + 0.5;
    if (vuv.x > 0.01 && vuv.x < 0.99 && vuv.y > 0.01 && vuv.y < 0.99) {
      vm = texture(uVecTex, vuv).rgb;
      vecFade = 1.0 - smoothstep(6600.0, 7950.0, dist);
      if (uVecOpt.z > 0.5 && vm.b > 0.08) {
        isRivMask = smoothstep(0.78, 0.96, vm.b);
        // Озёрная/морская вода не залезает на крутые берега (>10..20°); для рек в ущельях допуск шире
        float slopeGate = mix(
          1.0 - smoothstep(9.0, 20.0, baseSlopeDeg),
          1.0 - smoothstep(22.0, 42.0, baseSlopeDeg),
          isRivMask
        );
        float cov = mix(smoothstep(0.28, 0.56, vm.b), smoothstep(0.14, 0.62, vm.b), isRivMask);
        waterMask = cov * slopeGate * vecFade;
      }
    }
  }
  float landWeight = 1.0 - waterMask;

  // Горизонтали (глушатся на воде)
  if (uMode.y > 0.5) {
    float isoH = hAbs + (detVal - 0.5) * uTerrCnt1.x + (detMicro - 0.5) * (uTerrCnt1.x * 0.35);
    float iso = isoMask(isoH, uMode.z) * (1.0 - smoothstep(4000.0, 20000.0, dist));
    bool darkIso = dark || (uSunCol.w > 0.45 && mode != 0 && mode != 4);
    vec3 isoCol = darkIso
      ? (mode == 4 ? vec3(0.0608, 0.2793, 0.5789) : vec3(0.32, 0.46, 0.64))
      : vec3(0.0433, 0.0358, 0.0290);
    float modeIsoOp = (mode == 4) ? 0.80 : (darkIso ? 0.48 : 0.55);
    col = mix(col, isoCol, clamp(iso * modeIsoOp * uTerrCnt1.w * landWeight, 0.0, 0.95));
  }

  // Микро-штриховка рельефа на склонах (глушится на воде)
  if (uTerrCnt1.y > 0.005 && landWeight > 0.01) {
    float hFade = 1.0 - smoothstep(uTerrDet3.x * 0.25, uTerrDet3.x, dist);
    float slopeW = smoothstep(8.0, 28.0, baseSlopeDeg);
    float microPhase = (hAbs * 0.35 + detVal * 5.0 + detMicro * 2.2) * uTerrCnt1.z;
    float fw = max(fwidth(microPhase), 1e-4);
    float lineM = 1.0 - smoothstep(0.6, 1.5, abs(fract(microPhase - 0.5) - 0.5) / fw);
    vec3 hCol = dark ? vec3(0.32, 0.48, 0.68) : vec3(0.08, 0.09, 0.11);
    col = mix(col, hCol, lineM * uTerrCnt1.y * slopeW * hFade * landWeight);
  }

  // Наложение воды, троп и дорог
  if (vecFade > 0.005) {
    if (waterMask > 0.005) {
      const vec3 lakeCol = vec3(0.0177, 0.1643, 0.4854);
      const vec3 rivCol  = vec3(0.0290, 0.2793, 0.7176);
      vec3 wBase = mix(lakeCol, rivCol, isRivMask);
      if (mode == 1 || mode == 5) {
        float dayLight = mix(0.24, 1.0, clamp(uLightDir.w * 0.65 + 0.35, 0.0, 1.0)) * mix(1.0, 0.35, uSunCol.w);
        wBase *= dayLight;
        wBase = mix(wBase, uSkyHor.rgb, fogF * 0.72 * fogK);
      } else if (mode != 0 && mode != 4) {
        wBase = mix(wBase, uSkyHor.rgb, fogF * 0.68 * fogK);
      }
      col = mix(col, wBase, clamp(waterMask * mix(0.95, 0.92, isRivMask), 0.0, 0.96));
    }
    float nightMix = clamp(uSunCol.w, 0.0, 1.0);
    if (uVecOpt.w > 0.5 && vm.g > 0.08) {
      float isTrack = smoothstep(0.78, 0.96, vm.g);
      vec3 trailBase = mix(uRoadTrailDay, uRoadTrailNight, nightMix);
      vec3 trailCol = mix(trailBase * 0.78, trailBase, isTrack);
      col = mix(col, trailCol, smoothstep(0.06, 0.62, vm.g) * 0.88 * vecFade);
    }
    if (uVecOpt.y > 0.5 && vm.r > 0.08) {
      vec3 roadCol = mix(uRoadPavedDay, uRoadPavedNight, nightMix);
      col = mix(col, roadCol, smoothstep(0.06, 0.68, vm.r) * 0.90 * vecFade);
    }
  }

  // Падающие тени в остальных режимах + дополнительная тень леса + тёплая подсветка солнцем
  if (uShadowOpt.x > 0.5 || uShadowOpt.y > 0.5) {
    float distAtt = 1.0 - fogF * fogK * 0.82;
    if (mode != 1 && mode != 5) {
      float anySh = max(terrVis, forVis * 0.88);
      if (anySh > 0.005) {
        float shAmt = (mode == 0 || mode == 4) ? (dark ? 0.42 : 0.34) : 0.50;
        vec3 shTint = dark ? vec3(0.56, 0.66, 0.88) : vec3(0.50, 0.60, 0.82);
        col = mix(col, col * shTint, anySh * shAmt * distAtt);
      }
    } else if (forVis > 0.005) {
      col *= mix(1.0, 0.78, forVis * distAtt);
    }

    // Тёплая подсветка участков открытого рельефа, куда сейчас попадает Солнце
    if (uShadowOpt.y > 0.5 && uShadowOpt.z > 0.005) {
      float slopeFacing = smoothstep(0.015, 0.16, dot(N_geom, normalize(uSunDirOnly)));
      float openLand = (1.0 - fCover) * (1.0 - waterMask * 0.85);
      float sunlit = openLand * (1.0 - shForest) * (1.0 - shTerr) * slopeFacing * uShadowOpt.z * distAtt;
      if (sunlit > 0.005) {
        if (mode == 0 || mode == 4) {
          vec3 warmS = dark ? vec3(0.18, 0.12, 0.025) : vec3(0.98, 0.78, 0.34);
          col = dark ? (col + warmS * (sunlit * 0.75)) : mix(col, warmS, sunlit * 0.44);
        } else {
          vec3 warmG = vec3(1.0, 0.70, 0.24);
          col = mix(col, col * vec3(1.12, 1.00, 0.76) + warmG * 0.13, sunlit * 0.74);
        }
      }
    }
  }

  // Альфа 0.82 помечает воду для FS_COMPOSITE, оставаясь > 0.75 (не ломает силуэты и 2D-деревья)
  float outA = mix(1.0, 0.82, smoothstep(0.25, 0.65, waterMask));
  fragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), outA);
}`;


const VS_BUILDING = HEAD + `
layout(location=0) in vec3 aPos;    // x, groundRawY, z
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aExtra;  // x = localY, y = isRoof
layout(location=3) in vec3 aMeta;   // x = rnd, y = areaClass, z = levels

uniform mat4 uVP;
uniform vec4 uCam;
uniform float uZScale;
uniform float uCurv;
uniform float uBldScale;

out vec3 vN;
out vec3 vWorld;
out float vLocalY;
out float vIsRoof;
flat out vec3 vMeta;


void main() {
  vec3 p = vec3(aPos.x, aPos.y * uZScale + aExtra.x * uBldScale, aPos.z);
  vec2 dXZ = p.xz - uCam.xz;
  p.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;
  vWorld = p;
  vN = aNrm;
  vLocalY = aExtra.x * uBldScale;
  vIsRoof = aExtra.y;
  vMeta = aMeta;
  gl_Position = uVP * vec4(p, 1.0);
}`;

  const FS_BUILDING = HEAD + `
uniform vec4 uCam;       // xyz = pos, w = time
uniform vec4 uLightDir;  // xyz, w = intensity
uniform vec4 uSunCol;    // rgb, w = night (0..1)
uniform vec4 uSkyHor;
uniform vec4 uMode;      // x = mode (0..4)
uniform vec4 uRange;     // x = fogDist, w = darkTheme
uniform float uBldFloorHeight;

in vec3 vN;
in vec3 vWorld;
in float vLocalY;
in float vIsRoof;
flat in vec3 vMeta;
out vec4 fragColor;

${GLSL_SHADOW_FN}

vec3 lin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir.xyz);
  vec3 V = normalize(uCam.xyz - vWorld);
  float distToCam = length(uCam.xyz - vWorld);
  int mode = int(uMode.x + 0.5);
  bool dark = uRange.w > 0.5;
  float nightFactor = clamp(uSunCol.w, 0.0, 1.0);

  float rnd = vMeta.x;
  vec3 wallCol = rnd < 0.35 ? lin(vec3(0.78, 0.76, 0.72)) :
                (rnd < 0.70 ? lin(vec3(0.65, 0.58, 0.52)) : lin(vec3(0.85, 0.82, 0.75)));
  vec3 roofCol = rnd < 0.40 ? lin(vec3(0.48, 0.20, 0.16)) :
                (rnd < 0.75 ? lin(vec3(0.24, 0.28, 0.32)) : lin(vec3(0.35, 0.40, 0.34)));

  vec3 col;

  float fogK = (uMode.y > 0.5) ? 0.0 : 1.0;
  float fogF = clamp(1.0 - exp(-distToCam / max(uRange.x * 0.65, 600.0)), 0.0, 0.90) * fogK;

  if (mode == 0 || mode == 4) {
    // Контуры / Топо-сетка
    vec3 wSchem = dark ? lin(vec3(0.18, 0.23, 0.30)) : lin(vec3(0.74, 0.76, 0.79));
    vec3 rSchem = dark ? lin(vec3(0.12, 0.16, 0.22)) : lin(vec3(0.56, 0.60, 0.65));
    float wrap = clamp(dot(N, L) * 0.45 + 0.55, 0.0, 1.0);
    col = mix(wSchem, rSchem, vIsRoof) * (0.78 + 0.26 * wrap);
    if (uShadowOpt.x > 0.5) {
      float terrSh = sampleShadowCascades(vWorld.xz).r;
      col *= mix(1.0, 0.72, terrSh);
    }
    col = mix(col, uSkyHor.rgb, clamp(pow(distToCam / max(uRange.x, 1500.0), 0.75), 0.0, 0.88) * fogK);
  } else {
    // CG / Гипсометрия / Уклоны
    vec3 baseCol = mix(wallCol, roofCol, vIsRoof);
    float ndl = max(dot(N, L), 0.0);
    float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(lin(vec3(0.10, 0.12, 0.18)), lin(vec3(0.32, 0.38, 0.50)), 1.0 - nightFactor) * (0.65 + 0.35 * N.y);
    vec3 sun = uSunCol.rgb * uLightDir.w * (mode == 1 ? ndl : wrap * 0.7);
    if (uShadowOpt.x > 0.5) {
      float terrSh = sampleShadowCascades(vWorld.xz).r;
      sun *= (1.0 - terrSh);
      amb *= mix(vec3(1.0), vec3(0.72, 0.80, 0.96), terrSh);
    }
    col = baseCol * (sun + amb);
    col = mix(col, uSkyHor.rgb, fogF * 0.85);
  }

  // Окна (дневной блик + ночная подсветка)
  if (vIsRoof < 0.5 && abs(N.y) < 0.9) {
    float bSeed = vMeta.x;
    float bClass = vMeta.y;
    bool isSmall = (bClass < 0.5);
    bool isIndustrial = (bClass > 1.5);

    bool alongX = abs(N.x) > abs(N.z);
    float sideId = alongX ? (N.x > 0.0 ? 0.0 : 1.0) : (N.z > 0.0 ? 2.0 : 3.0);
    float horiz = alongX ? vWorld.z : vWorld.x;
    float vert = max(vLocalY, 0.0);

    float bHash = fract(bSeed * 13.71 + 0.37);
    float stepX = mix(2.9, 5.0, bClass) * mix(0.90, 1.10, bHash);
    float stepY = max(uBldFloorHeight, 1.5);

    float winW = stepX * mix(0.42, 0.56, bHash);
    float winH = stepY * mix(0.40, 0.55, fract(bSeed * 71.3 + 0.31));

    vec2 gP = vec2(horiz / stepX, vert / stepY);
    vec2 cell = floor(gP);
    vec2 fC = fract(gP);
    fC.x = fract(fC.x + sideId * 0.17);

    float floorIdx = floor(vert / stepY);
    bool isGround = (floorIdx < 0.5);

    float wHalfX = winW / stepX * 0.5;
    float wHalfY = winH / stepY * 0.5;
    float subpixelPad = clamp(distToCam * 0.00035, 0.0, 0.28);
    wHalfX = min(0.48, wHalfX + subpixelPad);
    wHalfY = min(0.48, wHalfY + subpixelPad);

    if (floorIdx >= vMeta.z + 0.2) {
      wHalfX = 0.0; // без окон на фронтоне выше последнего этажа
    } else if (isGround && !isIndustrial) {
      wHalfX = 0.38; wHalfY = 0.35;
    } else if (isIndustrial && !isGround) {
      if (mod(floorIdx, 2.0) < 1.0) { wHalfX = 0.45; wHalfY = 0.20; }
      else wHalfX = 0.0;
    } else if (isSmall && !isGround) {
      if (hash21(cell + vec2(sideId * 17.3, bSeed * 5.1)) > 0.55) wHalfX = 0.0;
    }

    vec2 wKey = cell + vec2(sideId * 31.3, bSeed * 53.1);
    float wHash = hash21(wKey);
    float litGate = max(nightFactor, (dark && (mode == 0 || mode == 4)) ? 0.65 : 0.0);
    bool isLit = false;
    if (wHalfX > 0.0 && litGate > 0.04) {
      float floorBias = hash21(vec2(floorIdx, bSeed * 11.1));
      float litProb = (isGround && !isIndustrial) ? 0.32 : (isIndustrial ? 0.08 * floorBias : mix(0.07, 0.22, floorBias));
      isLit = (wHash < litProb);
    }

    vec2 dC = abs(fC - 0.5);
    vec2 distFromEdge = max(dC - vec2(wHalfX, wHalfY), vec2(0.0)) * vec2(stepX, stepY);
    float distToWinM = length(distFromEdge);
    bool inWin = (wHalfX > 0.0) && (dC.x < wHalfX) && (dC.y < wHalfY);

    float colVar = hash21(wKey + 3.3);
    vec3 lightCol = vec3(0.0);
    if (isLit) {
      if (colVar < 0.30)      lightCol = lin(vec3(1.00, 0.40, 0.12));
      else if (colVar < 0.64) lightCol = lin(vec3(1.00, 0.455, 0.161));
      else if (colVar < 0.82) lightCol = lin(vec3(1.00, 0.52, 0.21));
      else if (colVar < 0.88) lightCol = lin(vec3(1.00, 0.22, 0.05));
      else if (colVar < 0.95) lightCol = lin(vec3(0.82, 0.88, 1.00));
      else                    lightCol = lin(vec3(0.32, 0.60, 1.00));
    }

    float fadeWin = 1.0 - fogF * 0.85;
    if (inWin) {
      if (litGate < 0.5 && mode == 1) {
        float dayW = 1.0 - litGate * 2.0;
        col *= mix(1.0, 0.80, dayW * 0.5);
        vec2 dCWin = fC - 0.5;
        float glint = smoothstep(0.35, 0.0, length(dCWin * vec2(stepX / max(winW, 0.1), stepY / max(winH, 0.1))));
        col += vec3(0.06, 0.07, 0.09) * glint * dayW * 0.5 * fadeWin;
      }
      if (isLit) {
        vec2 dCWin = fC - 0.5;
        float centerFall = smoothstep(0.55, 0.08, length(dCWin * vec2(stepX / max(winW, 0.1), stepY / max(winH, 0.1))));
        float flicker = 0.95 + 0.05 * sin(uCam.w * (1.2 + colVar * 2.5) + wHash * 50.0);
        float emit = smoothstep(0.12, 0.85, litGate) * (1.8 + 1.5 * centerFall) * flicker * fadeWin;
        col += lightCol * emit;
      }
    } else if (isLit) {
      float maxHaloDist = clamp(distToCam * 0.015 + 2.0, 2.0, 12.0);
      if (distToWinM < maxHaloDist) {
        float flicker = 0.95 + 0.05 * sin(uCam.w * (1.2 + colVar * 2.5) + wHash * 50.0);
        float halo = exp(-distToWinM / (maxHaloDist * 0.32)) * smoothstep(maxHaloDist, 0.05, distToWinM);
        float haloIntensity = smoothstep(0.12, 0.85, litGate) * 0.95 * flicker * fadeWin;
        col += lightCol * (halo * haloIntensity);
      }
    }
  }

  fragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

  const VS_TREE = HEAD + `
layout(location=0) in vec2 aCorner; // x: -0.5..0.5, y: 0..1
layout(location=1) in vec4 iA;      // xyz = world pos, w = height
layout(location=2) in vec2 iB;      // x = width, y = seed
uniform mat4 uVP;
uniform vec4 uCam;
uniform vec2 uCamFwd;
uniform float uZScale;
uniform float uCurv;
uniform vec3 uCanopyHole;
out vec2 vUV;
out float vSeed;
out float vDist;
flat out vec2 vSeedTrig;
${GLSL_HOLE_FN}
void main() {
  vec3 base = vec3(iA.x, iA.y * uZScale, iA.z);
  vec2 dXZ = base.xz - uCam.xz;
  if (dot(dXZ, uCamFwd) < -24.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float dist = length(dXZ);
  float cutDist = 5.5;
  if (uCanopyHole.z > 0.1) {
    cutDist = canopyHoleRadius(dXZ, uCanopyHole.xy, uCanopyHole.z) + 1.0;
  }
  if (dist < cutDist) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  base.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;
  vec2 toCam = dXZ / max(dist, 0.001);
  vec2 right = vec2(-toCam.y, toCam.x);
  float h = iA.w * mix(1.0, uZScale, 0.35);
  float w = iB.x;
  vec3 wp = base + vec3(right.x * aCorner.x * w, aCorner.y * h, right.y * aCorner.x * w);
  vUV = vec2(aCorner.x * 2.0, aCorner.y);
  vSeed = iB.y;
  vDist = dist;
  vSeedTrig = vec2(cos(iB.y * 31.0), sin(iB.y * 31.0));
  gl_Position = uVP * vec4(wp, 1.0);
}`;

  const FS_TREE = HEAD + `
uniform vec4 uMode;
uniform vec4 uRange;
uniform vec4 uSkyHor;
uniform vec4 uLightDir;
in vec2 vUV;
in float vSeed;
in float vDist;
flat in vec2 vSeedTrig;
out vec4 fragColor;

vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

void main() {
  float x = abs(vUV.x);
  float y = vUV.y;
  bool inside = false;
  bool isConifer = vSeed < 0.52;

  if (isConifer) {
    if (y > 0.14) {
      float t = (y - 0.14) / 0.86;
      float baseW = (1.0 - t) * 0.90;
      if (x >= baseW * 1.24) discard;
      if (x >= baseW * 0.76) {
        float hw = baseW * (1.0 + 0.24 * sin(t * 19.0 + vSeed * 20.0));
        if (x >= hw) discard;
      }
      inside = true;
    } else {
      inside = x < 0.12;
    }
  } else {
    if (y > 0.26) {
      float cy = (y - 0.63) / 0.37;
      float len2 = vUV.x * vUV.x + cy * cy;
      if (len2 >= 0.9604) discard; // 0.98^2
      if (len2 <= 0.5476) {        // 0.74^2
        inside = true;
      } else {
        float len = sqrt(len2);
        float c = vUV.x / len, s = cy / len;
        float c2 = c * c, s2 = s * s;
        float cos5 = c * (c2 * (c2 - 10.0 * s2) + 5.0 * s2 * s2);
        float sin5 = s * (5.0 * c2 * c2 - 10.0 * c2 * s2 + s2 * s2);
        float wave = sin5 * vSeedTrig.x + cos5 * vSeedTrig.y;
        inside = len < (0.86 + 0.12 * wave);
      }
    } else {
      inside = x < 0.11;
    }
  }

  if (!inside) discard;

  int mode = int(uMode.x + 0.5);
  bool dark = uRange.w > 0.5;
  float fogF = clamp(vDist / 2800.0, 0.0, 0.78) * ((uMode.y > 0.5) ? 0.0 : 1.0);
  vec3 col;

  if (mode == 0 || mode == 4) {
    col = dark ? lin(vec3(0.11, 0.20, 0.16)) : lin(vec3(0.42, 0.54, 0.44));
    col = mix(col, uSkyHor.rgb, fogF * 0.65);
  } else {
    vec3 baseG = isConifer ? lin(vec3(0.08, 0.22, 0.12)) : lin(vec3(0.16, 0.34, 0.14));
    float lit = 0.45 + 0.55 * clamp(uLightDir.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(baseG * lit, uSkyHor.rgb, fogF * 0.72);
  }
  fragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 0.5);
}`;


const VS_CANOPY = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 iA;    // xyz = wx, groundY, wz; w = chRaw (м)
layout(location=3) in vec3 iB;    // x = rx (м), y = seed, z = edgeFactor (0..1)

uniform mat4 uVP;
uniform vec4 uCam;
uniform float uZScale;
uniform float uCurv;
uniform vec4 uCanopyOpt;          // x = opacity, y = minH, z = canopyScale, w = waveAmp
uniform vec4 uDevForm1;           // x = rxScale, y = topFlatten, z = skirtScale, w = waveFreq
uniform vec4 uDevForm2;           // x = lobeAmp, y = lobeFreq, z = jitterAmp, w = edgeShrink
uniform vec4 uDevForm3;           // x = heightGamma, y = edgeRxShrink, z = gammaRxCouple, w = 0
uniform vec4 uSeam1;              // x = seamStart, y = seamEnd, z = rxMultStart, w = rxMultEnd
uniform vec4 uSeam2;              // x = hMultStart, y = hMultEnd, z = outerFadeHalfM (0 = выкл), w = 0
uniform vec3 uCanopyHole;

out vec3 vWorld;
out vec3 vNrm;
flat out float vSeed;
${GLSL_HOLE_FN}
void main() {
  float chRaw = iA.w;
  if (chRaw < uCanopyOpt.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float cScale        = uCanopyOpt.z;
  float waveAmp       = uCanopyOpt.w;
  float rxScale       = uDevForm1.x;
  float topFlatten    = max(uDevForm1.y, 0.25);
  float skirtScale    = uDevForm1.z;
  float waveFreq      = uDevForm1.w;
  float lobeAmp       = uDevForm2.x;
  float lobeFreq      = uDevForm2.y;
  float jitterAmp     = uDevForm2.z;
  float edgeShrink    = clamp(uDevForm2.w, 0.0, 0.95);
  float heightGamma   = max(uDevForm3.x, 0.25);
  float edgeRxShrink  = clamp(uDevForm3.y, 0.0, 0.85);
  float gammaRxCouple = clamp(uDevForm3.z, 0.0, 1.0);

  float seed = iB.y;
  float edgeFactor = clamp(iB.z, 0.0, 1.0);
  float edgeHMult  = max(0.08, 1.0 - edgeShrink * edgeFactor);
  float edgeRxMult = max(0.20, 1.0 - edgeRxShrink * edgeFactor);

  float hJitter = 1.0 + (fract(seed * 17.3) - 0.5) * 0.34 * jitterAmp;
  float swell = 1.0 + waveAmp * 0.14 * sin(iA.x * waveFreq + iA.z * waveFreq * 0.86);
  float zMix = mix(1.0, uZScale, 0.35);

  float chShaped = pow(max(chRaw, 0.1) / 25.0, heightGamma) * 25.0;
  float hGammaRatio = clamp(chShaped / max(chRaw, 0.1), 0.18, 1.10);
  float gammaRxMult = mix(1.0, hGammaRatio, gammaRxCouple);


  float boxDist = max(abs(iA.x), abs(iA.z));
  float seamRxMult = 1.0;
  float seamHMult  = 1.0;
  if (uSeam1.y > uSeam1.x + 1.0) {
    float st = smoothstep(uSeam1.x, uSeam1.y, boxDist);
    seamRxMult = mix(uSeam1.z, uSeam1.w, st);
    seamHMult  = mix(uSeam2.x, uSeam2.y, st);
  }
  // Если дальний слой выключен — мягко сходим на нет у внешней границы ближнего слоя:
  if (uSeam2.z > 10.0) {
    float outerT = smoothstep(uSeam2.z - 35.0, uSeam2.z, boxDist);
    seamRxMult *= mix(1.0, 0.25, outerT);
    seamHMult  *= mix(1.0, 0.25, outerT);
  }

  float totalRxMult = max(0.15, edgeRxMult * gammaRxMult);
  float rx = iB.x * rxScale * totalRxMult * seamRxMult * (0.94 + 0.16 * fract(seed * 7.31));
  float rz = iB.x * rxScale * totalRxMult * seamRxMult * (0.94 + 0.16 * fract(seed * 13.17));

  float effH = max(0.6, chShaped * cScale * hJitter * swell * edgeHMult * seamHMult) * zMix;
  float gy = iA.y * uZScale;

  if (uCanopyHole.z > 0.1) {
    vec2 cdXZ = iA.xz - uCanopyHole.xy;
    float cDist = length(cdXZ);
    float holeR = canopyHoleRadius(cdXZ, uCanopyHole.xy, uCanopyHole.z);
    float clearFade = smoothstep(holeR * 0.85, holeR + 8.5, cDist);
    if (clearFade < 0.02) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    rx *= clearFade;
    rz *= clearFade;
    effH *= clearFade;
  }

  float yaw = seed * 6.2831853;
  float cy = cos(yaw), sy = sin(yaw);
  vec3 lp = vec3(aPos.x * cy - aPos.z * sy, aPos.y, aPos.x * sy + aPos.z * cy);
  vec3 ln = vec3(aNrm.x * cy - aNrm.z * sy, aNrm.y, aNrm.x * sy + aNrm.z * cy);

  float horiz = sqrt(max(0.0, 1.0 - lp.y * lp.y));
  float ang = (abs(lp.x) + abs(lp.z)) > 1e-4 ? atan(lp.z, lp.x) : 0.0;
  float lobe = 1.0 + lobeAmp * horiz * sin(lobeFreq * ang + seed * 12.56);
  lp.x *= lobe;
  lp.z *= lobe;

  if (lp.y > 0.0) {
    lp.y = pow(lp.y, 1.0 / topFlatten);
  }

  float skirtH = max(effH, max(rx, rz) * skirtScale);
  float yScale = lp.y >= 0.0 ? effH : skirtH;

  vec3 wp = vec3(iA.x + lp.x * rx, gy + lp.y * yScale, iA.z + lp.z * rz);
  vec2 dXZ = wp.xz - uCam.xz;
  wp.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;

  vWorld = wp;
  float nrmYScale = max(effH, max(rx, rz) * 0.35);
  vNrm = normalize(vec3(ln.x / max(rx * lobe, 0.05), (ln.y * topFlatten) / nrmYScale, ln.z / max(rz * lobe, 0.05)));
  vSeed = seed;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

const FS_CANOPY = HEAD + `
uniform vec4 uCam;
uniform vec4 uLightDir;
uniform vec4 uSunCol;
uniform vec4 uSkyHor;
uniform vec4 uMode;      // x = mode
uniform vec4 uRange;     // x = fogDist, w = darkTheme

uniform vec4 uDevLight1; // x = ndlWeight, y = litPos, z = litSoft, w = hiPos
uniform vec4 uDevLight2; // x = hiSoft, y = hiStr, z = sunApply, w = ambApply
uniform vec4 uDevShade;  // x = brushAmp, y = brushFreq, z = tintAmp, w = aoSide
uniform vec4 uDevCol0;   // rgb = shadow, w = fogStr
uniform vec4 uDevCol1;   // rgb = base, w = fogDistScale
uniform vec4 uDevCol2;   // rgb = hi, w = darkAutoTint
uniform vec4 uDevEdgeA;  // x = upMaskMin, y = upMaskMax, z = penBreakAmp, w = penBreakFreq
uniform vec4 uDevMisc;   // x = lightAllModes

in vec3 vWorld;
in vec3 vNrm;
flat in float vSeed;
out vec4 fragColor;

${GLSL_SHADOW_FN}

vec3 lin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
void main() {
  vec3 N = normalize(vNrm);
  vec3 L = normalize(uLightDir.xyz);
  float dist = length(uCam.xyz - vWorld);
  int mode = int(uMode.x + 0.5);
  bool dark = uRange.w > 0.5;

  float ndl = dot(N, L) * 0.5 + 0.5;
  float ndlW = clamp(uDevLight1.x, 0.0, 1.0);
  float shade = ndl * ndlW + clamp(N.y, 0.0, 1.0) * (1.0 - ndlW);

  float bf = uDevShade.y;
  float brush = sin(vWorld.x * bf + vWorld.z * bf * 0.875 + vSeed * 23.0) * (0.6 * uDevShade.x)
              + cos(vWorld.x * bf * 1.94 - vWorld.z * bf * 1.69 + vSeed * 11.0) * (0.4 * uDevShade.x);
  float sBrush = shade + brush * (1.0 - smoothstep(450.0, 1500.0, dist));

  float hLit = max(uDevLight1.z, 0.002);
  float hHi  = max(uDevLight2.x, 0.002);
  float litBand = smoothstep(uDevLight1.y - hLit, uDevLight1.y + hLit, sBrush);
  float hiBand  = smoothstep(uDevLight1.w - hHi,  uDevLight1.w + hHi,  sBrush);
  float tint = (fract(vSeed * 13.7) - 0.5) * uDevShade.z;

  vec3 cShadow = lin(uDevCol0.rgb);
  vec3 cBase   = lin(uDevCol1.rgb);
  vec3 cHi     = lin(uDevCol2.rgb);

  cBase.r = max(0.0, cBase.r + tint);
  cHi.r   = max(0.0, cHi.r   + tint);

  // Чтобы при тёмной теме ночью не было двойного затемнения
  if (dark && uDevCol2.w > 0.5) {
    float dt = 1.0 - clamp(uSunCol.w, 0.0, 1.0) * 0.85;
    cShadow *= mix(vec3(1.0), vec3(0.40, 0.42, 0.55), dt);
    cBase   *= mix(vec3(1.0), vec3(0.36, 0.46, 0.78), dt);
    cHi     *= mix(vec3(1.0), vec3(0.38, 0.52, 0.85), dt);
  }

  if (mode == 1 || uDevMisc.x > 0.5) {
    float nightF = clamp(uSunCol.w, 0.0, 1.0);
    float lowSun = (1.0 - smoothstep(0.02, 0.40, uLightDir.w)) * (1.0 - nightF);
    float nightMix = clamp(nightF + lowSun * 0.65, 0.0, 1.0);

    vec3 amb = mix(lin(vec3(0.08, 0.12, 0.20)), lin(vec3(0.32, 0.44, 0.58)), 1.0 - nightF);
    vec3 sun = uSunCol.rgb * min(uLightDir.w, 1.25);

    // Безопасный пол и pow() вместо mix(), чтобы при sunApply > 1.0 цвета не уходили в минус/чёрный
    vec3 lSh = clamp(amb * 0.95 + sun * 0.25, vec3(0.18, 0.20, 0.26), vec3(1.6));
    vec3 lBs = clamp(amb * 0.65 + sun * 0.62, vec3(0.18, 0.20, 0.26), vec3(1.6));
    vec3 lHi = clamp(amb * 0.45 + sun * 0.80, vec3(0.18, 0.20, 0.26), vec3(1.6));

    vec3 daySh = cShadow * pow(lSh, vec3(uDevLight2.w));
    vec3 dayBs = cBase   * pow(lBs, vec3(uDevLight2.z));
    vec3 dayHi = cHi     * pow(lHi, vec3(uDevLight2.z));

    // Ночью деревья чуть темнее и с голубой подсветкой луны (работает и при ambApply = 0)
    float moonVis = clamp(uLightDir.w / 0.35, 0.30, 1.0);
    float moonNdl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    vec3 moonTint = lin(vec3(0.55, 0.76, 1.0));

    vec3 nightSh = cShadow * vec3(0.34, 0.42, 0.68) + moonTint * (0.020 + 0.018 * moonVis);
    vec3 nightBs = cBase   * vec3(0.38, 0.48, 0.78) + moonTint * (0.045 + 0.055 * moonVis * (0.55 + 0.45 * moonNdl));
    vec3 nightHi = cHi     * vec3(0.42, 0.54, 0.88) + moonTint * (0.070 + 0.085 * moonVis * (0.45 + 0.55 * moonNdl));

    cShadow = mix(daySh, nightSh, nightMix);
    cBase   = mix(dayBs, nightBs, nightMix);
    cHi     = mix(dayHi, nightHi, nightMix);
  }

  if (uShadowOpt.x > 0.5) {
    float terrSh = sampleShadowCascades(vWorld.xz).r;
    if (terrSh > 0.005) {
      vec3 shTint = vec3(0.46, 0.54, 0.72);
      cShadow = mix(cShadow, cShadow * shTint, terrSh * 0.75);
      cBase   = mix(cBase,   cBase   * shTint, terrSh * 0.85);
      cHi     = mix(cHi,     cHi     * shTint, terrSh * 0.90);
    }
  }

  vec3 col = mix(cShadow, cBase, litBand);
  col = mix(col, cHi, hiBand * uDevLight2.y);

  // Затенение боковых складок (AO)
  float ao = 1.0 - uDevShade.w * (1.0 - clamp(N.y, 0.0, 1.0));
  col *= ao;

  // Воздушная перспектива
  float fogDistEff = max(uRange.x * uDevCol1.w, 400.0);
  float fogF = clamp(1.0 - exp(-dist / fogDistEff), 0.0, 0.90);
  float fogK = (uMode.y > 0.5) ? 0.0 : 1.0;
  col = mix(col, uSkyHor.rgb, fogF * uDevCol0.w * (mode == 1 ? 1.15 : 1.0) * fogK);

  float upMask = smoothstep(uDevEdgeA.x, max(uDevEdgeA.x + 0.02, uDevEdgeA.y), N.y);
  float penBreak = (1.0 - uDevEdgeA.z) + uDevEdgeA.z * sin(vWorld.x * uDevEdgeA.w - vWorld.z * uDevEdgeA.w * 0.86 + vSeed * 23.0);
  float topWeight = clamp(upMask * penBreak, 0.0, 1.0);

  fragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 0.20 + 0.80 * topWeight);
}`;


const DEV_CANOPY_ZONES_DEF = {
    minRawH: 5.75,
    fillHolesMin: 8,
    edgeWindow: 4,
    edgeEmptyDiv: 0.35,
    sparseEmptyThr: 0.28,
    sparseDropProb: 0.3,
    minCnt3x3: 9,
    minCnt2x2: 3,
    allowSingles: true,
    rad3x3: 3,
    rad2x2: 3.2,
    rad1x1: 1.9,
    chMaxBlend: 2.15,
    jitterDense: 1.5,
    jitterEdge: 2
  };
  const DEV_CANOPY_ZONES = JSON.parse(JSON.stringify(DEV_CANOPY_ZONES_DEF));

  const DEV_CANOPY_FAR_ZONES_DEF = {
    minRawH: 1.5,
    fillHolesMin: 6,
    edgeWindow: 3,
    edgeEmptyDiv: 0.45,
    sparseEmptyThr: 0.9,
    sparseDropProb: 0.65,
    minCnt3x3: 9,
    minCnt2x2: 4,
    allowSingles: true,
    rad3x3: 4,
    rad2x2: 3.2,
    rad1x1: 2.5,
    chMaxBlend: 1.25,
    jitterDense: 1.5,
    jitterEdge: 2,
    seamOverlapM: 490
  };
  const DEV_CANOPY_FAR_ZONES = JSON.parse(JSON.stringify(DEV_CANOPY_FAR_ZONES_DEF));

  const DEV_CANOPY_FAR_OPT_DEF = {
    enabled: true,
    minH: 0.5,
    scale: 2.5,
    wave: 1.4,
    nearEndRx: 2.15,
    nearEndH: 1.8,
    farStartRx: 0.58,
    farStartH: 0.55,
    farGrowExtraM: 110
  };
  const DEV_CANOPY_FAR_OPT = { ...DEV_CANOPY_FAR_OPT_DEF };

  function buildCanopyImpostors(cd, sampleElevAbs, h0, skipInnerHalfM, zoneCfg, fadeOuterEdge = true) {
    if (!cd || !cd.grid || !cd.count) return null;
    const Z = zoneCfg || DEV_CANOPY_ZONES;
    const g = cd.grid, Nx = cd.box.Nx, Ny = cd.box.Ny;
    const halfM = cd.halfM || (cd.box && cd.box.widthM ? cd.box.widthM * 0.5 : CANOPY_HALF);
    const cell = (2 * halfM) / (Nx - 1);
    const cut = skipInnerHalfM || 0;
    const minQ = Math.round(clamp(Z.minRawH, 0.25, 15) * 4);

    const fract = v => v - Math.floor(v);
    const hash2 = (x, y) => {
      let px = fract(x * 0.1031), py = fract(y * 0.1031), pz = px;
      const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
      return fract(((px + d) + (py + d)) * (pz + d));
    };

    // 1. Закрываем мелкие 1-пиксельные «дыры» внутри сплошного леса
    const gFilled = new Uint8Array(g);
    if (Z.fillHolesMin <= 8) {
      for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
          const k = row + i;
          if (g[k] >= minQ) continue;
          let nCnt = 0, nSum = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const r2 = (j + dj) * Nx;
            for (let di = -1; di <= 1; di++) {
              if (!dj && !di) continue;
              const v = g[r2 + i + di];
              if (v >= minQ) { nCnt++; nSum += v; }
            }
          }
          if (nCnt >= Z.fillHolesMin) gFilled[k] = Math.round(nSum / nCnt);
        }
      }
    }

    // Оценка «опушки» и разреженности в окне (2*win+1)×(2*win+1)
    const win = clamp(Math.round(Z.edgeWindow), 1, 6);
    const calcEdgeInfo = (wx, wz) => {
      const ci = Math.round((wx + halfM) / cell);
      const cj = Math.round((wz + halfM) / cell);
      let total = 0, empty = 0;
      for (let dj = -win; dj <= win; dj++) {
        const jj = cj + dj;
        if (jj < 0 || jj >= Ny) continue;
        const row = jj * Nx;
        for (let di = -win; di <= win; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= Nx) continue;
          total++;
          if (gFilled[row + ii] < minQ) empty++;
        }
      }
      const emptyFrac = total ? empty / total : 0;
      return {
        emptyFrac,
        edgeFactor: clamp(emptyFrac / Math.max(Z.edgeEmptyDiv, 0.05), 0, 1)
      };
    };

    const visited = new Uint8Array(Nx * Ny);
    const buckets = Array.from({ length: 16 }, () => ({
      arr: [], x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9
    }));
    const invSpan = 1 / (2 * halfM);
    const fadeZone = cell * 2.5;

    const pushCluster = (sumX, sumZ, cnt, maxQ, sumQ, radiusM, isSparse) => {
      const wx = sumX / cnt;
      const wz = sumZ / cnt;
      if (cut > 0 && Math.abs(wx) < cut - cell * 1.5 && Math.abs(wz) < cut - cell * 1.5) return;

      const { edgeFactor, emptyFrac } = calcEdgeInfo(wx, wz);

      if (isSparse && emptyFrac > Z.sparseEmptyThr && hash2(wx + 91.1, wz + 61.8) < Z.sparseDropProb) {
        return;
      }

      const avgQ = sumQ / cnt;
      const chRaw = (avgQ * (1 - Z.chMaxBlend) + maxQ * Z.chMaxBlend) / 4;
      const rnd = hash2(wx, wz);
      const rndX = hash2(wx + 17.3, wz + 5.1);
      const rndZ = hash2(wx + 53.7, wz + 29.4);

      const jitterK = lerp(Z.jitterDense, Z.jitterEdge, edgeFactor);
      const jx = wx + (rndX - 0.5) * cell * jitterK;
      const jz = wz + (rndZ - 0.5) * cell * jitterK;
      if (cut > 0 && Math.abs(jx) < cut && Math.abs(jz) < cut) return;

       let finalEdge = edgeFactor;
      if (fadeOuterEdge) {
        const outerEdge = Math.max(Math.abs(jx), Math.abs(jz));
        if (outerEdge > halfM - fadeZone) {
          finalEdge = Math.max(finalEdge, smooth(halfM - fadeZone, halfM, outerEdge));
        }
      }


      const gy = sampleElevAbs(jx, jz) - h0;
      const rx = radiusM * (0.90 + 0.24 * rnd);

      const bx = clamp(Math.floor((jx + halfM) * invSpan * 4), 0, 3);
      const bz = clamp(Math.floor((jz + halfM) * invSpan * 4), 0, 3);
      const b = buckets[bz * 4 + bx];
      b.arr.push(jx, gy, jz, chRaw, rx, rnd, finalEdge);

      const padXZ = rx * 2.6; // чуть больше запас под укрупнение на границе
      if (jx - padXZ < b.x0) b.x0 = jx - padXZ;
      if (jx + padXZ > b.x1) b.x1 = jx + padXZ;
      if (jz - padXZ < b.z0) b.z0 = jz - padXZ;
      if (jz + padXZ > b.z1) b.z1 = jz + padXZ;
      if (gy - rx * 0.5 < b.y0) b.y0 = gy - rx * 0.5;
      if (gy + chRaw * 3.5 > b.y1) b.y1 = gy + chRaw * 3.5;
    };

    // Проход 1: крупные «подушки» 3×3 (сплошной лес)
    for (let j = 0; j <= Ny - 3; j += 3) {
      const wz0 = -halfM + j * cell;
      for (let i = 0; i <= Nx - 3; i += 3) {
        let cnt = 0, sumX = 0, sumZ = 0, sumQ = 0, maxQ = 0;
        for (let dj = 0; dj < 3; dj++) {
          const row = (j + dj) * Nx + i;
          const wz = wz0 + dj * cell;
          for (let di = 0; di < 3; di++) {
            const q = gFilled[row + di];
            if (q >= minQ) {
              cnt++;
              sumX += -halfM + (i + di) * cell;
              sumZ += wz;
              sumQ += q;
              if (q > maxQ) maxQ = q;
            }
          }
        }
        if (cnt >= Z.minCnt3x3) {
          for (let dj = 0; dj < 3; dj++) {
            const row = (j + dj) * Nx + i;
            for (let di = 0; di < 3; di++) visited[row + di] = 1;
          }
          pushCluster(sumX, sumZ, cnt, maxQ, sumQ, cell * Z.rad3x3, false);
        }
      }
    }

    // Проход 2: средние кластеры 2×2 — опушки и просеки
    for (let j = 0; j <= Ny - 2; j += 2) {
      const wz0 = -halfM + j * cell;
      for (let i = 0; i <= Nx - 2; i += 2) {
        let cnt = 0, sumX = 0, sumZ = 0, sumQ = 0, maxQ = 0;
        for (let dj = 0; dj < 2; dj++) {
          const row = (j + dj) * Nx + i;
          const wz = wz0 + dj * cell;
          for (let di = 0; di < 2; di++) {
            const k = row + di;
            if (visited[k]) continue;
            const q = gFilled[k];
            if (q >= minQ) {
              cnt++;
              sumX += -halfM + (i + di) * cell;
              sumZ += wz;
              sumQ += q;
              if (q > maxQ) maxQ = q;
            }
          }
        }
        if (cnt >= Z.minCnt2x2) {
          for (let dj = 0; dj < 2; dj++) {
            const row = (j + dj) * Nx + i;
            for (let di = 0; di < 2; di++) visited[row + di] = 1;
          }
          pushCluster(sumX, sumZ, cnt, maxQ, sumQ, cell * Z.rad2x2, cnt <= 3);
        }
      }
    }

    // Проход 3: одиночные группы на кромке и в редколесье
    if (Z.allowSingles) {
      for (let j = 0; j < Ny; j++) {
        const wz = -halfM + j * cell;
        for (let i = 0; i < Nx; i++) {
          const k = j * Nx + i;
          if (visited[k]) continue;
          const q = gFilled[k];
          if (q < minQ) continue;
          const wx = -halfM + i * cell;
          pushCluster(wx, wz, 1, q, q, cell * Z.rad1x1, true);
        }
      }
    }

    let totalFloats = 0;
    for (let i = 0; i < buckets.length; i++) totalFloats += buckets[i].arr.length;
    if (!totalFloats) return null;

    const data = new Float32Array(totalFloats);
    const chunks = [];
    let floatPtr = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (!b.arr.length) continue;
      data.set(b.arr, floatPtr);
      const cnt = b.arr.length / 7;
      chunks.push({
        byteOffset: floatPtr * 4,
        count: cnt,
        x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1
      });
      floatPtr += b.arr.length;
    }

    return { data, count: totalFloats / 7, chunks };
  }
const DEV_CONTOURS_DEF = {
    terrain: {
      thrBase: 14,
      thrSlope: 0.052,
      softness: 0,
      thick: 1,
      horizonThick: 1.25,
      slopeFilter: 0.85,
      diagWeight: 0,
      horizonBoost: 1.7,
      hazeMix: 0.45,
      backHalo: 0.16,
      nearSuppress: 12,
      treeSilhouette: true,
      occBias: 0.25,
      fadeStart: 0.35,
      fadeEnd: 1.15,
      strBase: 0.32,
      strNearAdd: 0.62,
      strMin: 0.22,
      strMax: 0.94,
      modeK_CG: 0.55,
      modeK_Hybrid: 0.86,
      modeK_Other: 0.92,
      colLight: '#1c2430',
      colDark: '#add6fa'
    },
    treeLine: {
      thick: 1.15,
      thrBase: 8,
      thrSlope: 0.042,
      softness: 0,
      slopeFilter: 0.75,
      checkMode: 0,
      outerWeight: 1,
      ridgeWeight: 1,
      skyBoost: 1.2,
      nearFade: 25,
      hazeMix: 0.3,
      dashAmp: 0,
      dashFreq: 0.22,
      tolTree: 18,
      tolTerrain: 1.5,
      borderFadeIn: 2130,
      borderFadeOut: 2196,
      fadeStart: 1400,
      fadeEnd: 3200,
      strBase: 0.46,
      strNearAdd: 0.48,
      strMin: 0.35,
      strMax: 0.94,
      colLight: '#127a2b',
      colDark: '#4de075'
    },
    forestZone: {
      treeTolMin: 14,
      treeTolMax: 20,
      terrTolMin: 0,
      terrTolMax: 1.5,
      strength: 0.88,
      skyAffect: 1,
      treesAffect: 1,
      tintLight: '#6b7875',
      tintDark: '#5c6b70'
    }
  };
  const DEV_CONTOURS = JSON.parse(JSON.stringify(DEV_CONTOURS_DEF));

  const DEV_TERRAIN_DEF = {
    relief: {
      enabled: false,
      bumpStrength: 0.64,   // сила искажения нормалей (бугры и кочки)
      macroScale: 260,      // размер крупных складок (м)
      microScale: 4,        // размер мелких кочек (м)
      cragStrength: 0,      // скалистость на крутых склонах
      strataStrength: 1,    // слоистость пород
      strataFreq: 0.12,     // частота слоёв
      cavityAO: 0.16,       // микро-затенение впадин
      albedoRough: 0.52,    // зернистость поверхности
      swissBoost: 1.25,     // контраст боковой отмывки
      slopeDetail: 0.65,    // доля деталей в режиме «Уклоны»
      hypsoWarp: 15,        // неровность границ высотных поясов (м)
      detailDist: 15000,    // дальность мелких кочек (м)
      macroDist: 32000      // дальность крупных неровностей (м)
    },
    contours: {
      isoWarpAmp: 14.5,     // искривление горизонталей шумом (м)
      isoOpacity: 1.15,     // яркость горизонталей
      microContourStr: 0,   // микро-штриховка склонов
      microContourFreq: 0.1,
      ridgeOn: true,        // внутренние линии гребней
      ridgeThr: 0.009,
      ridgeStr: 0.5,
      ridgeColLight: '#1e293b',
      ridgeColDark: '#8ec5fc',
      valleyOn: true,       // линии ложбин и промоин
      valleyThr: 0.001,
      valleyStr: 0.68,
      valleyColLight: '#3b2f24',
      valleyColDark: '#4a6b8c',
      creaseThick: 1.35,    // толщина линий гребней/ложбин (px)
      creaseMaxDist: 35000, // дальность (м)
      sketchBreak: 0        // органический разрыв штриха
    }
  };
  const DEV_TERRAIN = JSON.parse(JSON.stringify(DEV_TERRAIN_DEF));

const VS_CANOPY_SURF = HEAD + `
layout(location=0) in vec3 aPos;    // wx, groundRawY, wz
layout(location=1) in float aTreeH; // >= 0: высота крон, < 0: под землю на границе
uniform mat4 uVP;
uniform vec4 uCam;
uniform float uZScale;
uniform float uCurv;
out vec2 vXZ;
void main() {
  float zMix = mix(1.0, uZScale, 0.35);
  float y = aPos.y * uZScale + (aTreeH >= 0.0 ? aTreeH * zMix : aTreeH);
  vec3 p = vec3(aPos.x, y, aPos.z);
  vec2 dXZ = p.xz - uCam.xz;
  p.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;
  vXZ = aPos.xz;
  gl_Position = uVP * vec4(p, 1.0);
}`;

const FS_CANOPY_SURF = HEAD + `
uniform vec2 uCanopyBorder;
uniform vec3 uCanopyHole;
in vec2 vXZ;
out vec4 fragColor;
${GLSL_HOLE_FN}
void main() {
  if (uCanopyHole.z > 0.1) {
    vec2 dXZ = vXZ - uCanopyHole.xy;
    if (length(dXZ) < canopyHoleRadius(dXZ, uCanopyHole.xy, uCanopyHole.z)) {
      discard;
    }
  }
  // Гасим рисование зелёной линии на самом краю квадрата ±2200 м
  float boxDist = max(abs(vXZ.x), abs(vXZ.y));
  float b0 = uCanopyBorder.x;
  float b1 = max(b0 + 1.0, uCanopyBorder.y);
  float borderFade = 1.0 - smoothstep(b0, b1, boxDist);
  fragColor = vec4(0.0, borderFade, 0.0, 1.0);
}`;

 const VS_CLEAR_WALL = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aData; // x = fade, y = rim, z = slope
uniform mat4 uVP;
uniform vec4 uCam;
uniform float uCurv;
out vec3 vData;
void main() {
  vec3 p = aPos;
  vec2 dXZ = p.xz - uCam.xz;
  p.y -= uCurv * dot(dXZ, dXZ) / 14646000.0;
  vData = aData;
  gl_Position = uVP * vec4(p, 1.0);
}`;

 const FS_CLEAR_WALL = HEAD + `
in vec3 vData;
out vec4 fragColor;
void main() {
  fragColor = vec4(vData.y, vData.x, vData.z, 1.0);
}`;

  const FS_COMPOSITE = HEAD + `
uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform sampler2D uCanopyColorTex;
uniform sampler2D uCanopyDepthTex;
uniform sampler2D uClearColorTex;
uniform sampler2D uClearDepthTex;
uniform mat4 uInvVP;
uniform vec4 uCam;
uniform vec4 uSunDir;   // xyz, w = altDeg
uniform vec4 uSkyTop;
uniform vec4 uSkyHor;
uniform vec4 uSunCol;   // rgb, w = night
uniform vec4 uEdgeOpt;  // x = showEdges, y = near, z = far, w = fogMaxDist
uniform vec2 uTexel;
uniform vec4 uMode;     // x = mode, w = darkTheme
uniform vec4 uCanopyOpt;// x = opacity, y = inForest, z = 0, w = massModeActive
uniform vec4 uTreeLineOpt; // x = treeHeightLines, y = hideOccludedTerrainLines, z = clearWallActive
uniform vec4 uDevComp1; // x = edgeOn, y = edgeOuter, z = edgeRidge, w = edgeThick
uniform vec4 uDevComp2; // x = edgeThrBase, y = edgeThrSlope, z = edgeStr, w = edgeCheckMode
uniform vec4 uDevComp3; // x = edgeFadeStart, y = edgeFadeEnd, z = edgeHillOccl, w = 0
uniform vec4 uDevCompCol;
uniform vec4 uMoonDir;  // xyz = dir, w = altDeg
uniform vec4 uMoonOpt;

uniform vec4 uCrease1;      // x = ridgeOn, y = ridgeThr, z = ridgeStr, w = valleyOn
uniform vec4 uCrease2;      // x = valleyThr, y = valleyStr, z = thick, w = maxDist
uniform vec4 uCreaseColR;   // rgb = ridgeCol, w = sketchBreak
uniform vec4 uCreaseColV;   // rgb = valleyCol, w = 0

// Настройки контуров рельефа
uniform vec4 uTerrEdge1;    // x = thrBase, y = thrSlope, z = softness, w = thick
uniform vec4 uTerrEdge2;    // x = diagWeight, y = horizonBoost, z = treeSilhouette, w = occBias
uniform vec4 uTerrEdge3;    // x = fadeStart, y = fadeEnd, z = strBase, w = strNearAdd
uniform vec4 uTerrEdge4;    // x = strMin, y = strMax, z = modeK_CG, w = modeK_Hybrid
uniform vec4 uTerrEdgeColL; // rgb = light color, w = modeK_Other
uniform vec4 uTerrEdgeColD; // rgb = dark color
uniform vec4 uTerrEdge5;

uniform vec4 uSmartFog1; // x = enabled, y = layers (3 or 4), z = strength, w = contrast
uniform vec4 uSmartFog2; // x = b1, y = b2, z = b3, w = fogDist
uniform vec4 uSmartFog3; // x = valleyMist, y = ridgeBackMist, z = visYMin, w = visYMax

uniform vec4 uTreeEdge5;    // x = slopeFilter, y = skyBoost, z = nearFade, w = hazeMix

// Настройки зелёных контуров над лесом
uniform vec4 uTreeEdge1;    // x = thick, y = thrBase, z = thrSlope, w = softness
uniform vec4 uTreeEdge2;    // x = checkMode, y = outerWeight, z = ridgeWeight, w = tolTree
uniform vec4 uTreeEdge3;    // x = tolTerrain, y = fadeStart, z = fadeEnd, w = strBase
uniform vec4 uTreeEdge4;    // x = strNearAdd, y = strMin, z = strMax, w = dashAmp
uniform vec4 uTreeEdgeColL; // rgb = light color, w = dashFreq
uniform vec4 uTreeEdgeColD; // rgb = dark/night color

// Настройки зоны допуска/затенения за лесом
uniform vec4 uFZone1;       // x = treeTolMin, y = treeTolMax, z = terrTolMin, w = terrTolMax
uniform vec4 uFZone2;       // x = strength, y = skyAffect, z = treesAffect, w = 0
uniform vec4 uFZoneColL;    // rgb = light tint
uniform vec4 uFZoneColD;    // rgb = dark/night tint

in vec2 vUV;
in vec2 vNdc;
out vec4 outCol;

float linearZ(float d) {
  float n = uEdgeOpt.y, f = uEdgeOpt.z;
  return (n * f) / (f - d * (f - n));
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 lin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.02 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec4 c = texture(uColorTex, vUV);
  float dRaw = texture(uDepthTex, vUV).r;
  float dTerrC = (c.a < 0.1) ? uEdgeOpt.z : linearZ(dRaw);
  float dFog = dTerrC;
  float dRawFog = dRaw;
  bool hasGeom = (c.a >= 0.1);
  vec3 col;
  vec3 skySrgb = pow(clamp(uSkyHor.rgb, 0.0, 1.0), vec3(1.0 / 2.2));
  float terrEdgeAlpha = 0.0;
  vec3 terrEdgeCol = vec3(0.0);

  if (c.a < 0.1) {
    // НЕБО
    vec4 wp = uInvVP * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize(wp.xyz / wp.w - uCam.xyz);
    float y = clamp(rd.y, 0.0, 1.0);
    vec3 sky = mix(uSkyHor.rgb, uSkyTop.rgb, pow(y, 0.55));
    if (rd.y < 0.0) sky = mix(uSkyHor.rgb, uSkyHor.rgb * 0.7, smoothstep(0.0, -0.3, rd.y));

    vec3 sunDir = normalize(uSunDir.xyz);
    float sd = max(dot(rd, sunDir), 0.0);
    float dayVis = smoothstep(-6.0, 4.0, uSunDir.w);
    sky += uSunCol.rgb * (pow(sd, 32.0) * 0.45 + pow(sd, 6.0) * 0.12) * dayVis;

    // ЛУНА И ЕЁ ФАЗЫ
    float moonDiskMask = 0.0;
    int mMode = int(uMode.x + 0.5);
    bool showMoon = (mMode == 1 || mMode == 2 || mMode == 3 || mMode == 5 || uMode.w > 0.5);
    if (showMoon) {
      vec3 moonDir = normalize(uMoonDir.xyz);
      float md = dot(rd, moonDir);
      const float moonCosRadius = 0.99925;
      if (md > 0.994 && uMoonDir.w > -4.0) {
        float moonAltDeg = uMoonDir.w;
        vec3 mUp0 = abs(moonDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 mRight = normalize(cross(moonDir, mUp0));
        vec3 mUp = cross(mRight, moonDir);

        float moonAngRad = sqrt(max(0.0, 1.0 - moonCosRadius * moonCosRadius));
        vec2 mCoord = vec2(dot(rd, mRight), dot(rd, mUp)) / moonAngRad;

        float rDisk = length(mCoord);
        moonDiskMask = smoothstep(1.0, 0.97, rDisk);

        float horizonExtinction = clamp(1.0 - smoothstep(-1.5, 13.0, moonAltDeg), 0.0, 1.0);
        vec3 colZenithWhite = vec3(0.95, 0.97, 1.00);
        vec3 colWarmPeach   = vec3(0.98, 0.82, 0.70);
        vec3 colCoralRose   = vec3(0.92, 0.52, 0.55);
        vec3 colHorizonRose = vec3(0.847, 0.294, 0.396);

        float extT = pow(horizonExtinction, 1.2);
        vec3 moonExtinctCol = extT < 0.35 ? mix(colZenithWhite, colWarmPeach, extT / 0.35)
                            : (extT < 0.70 ? mix(colWarmPeach, colCoralRose, (extT - 0.35) / 0.35)
                                           : mix(colCoralRose, colHorizonRose, (extT - 0.70) / 0.30));

        float twilightSun = smoothstep(-9.0, -1.0, uSunDir.w) * (1.0 - smoothstep(1.0, 7.0, uSunDir.w));
        float isAntiSolar = clamp(-dot(moonDir.xz, sunDir.xz), 0.0, 1.0);
        float purpleWeight = twilightSun * isAntiSolar * smoothstep(-1.0, 10.0, moonAltDeg) * (1.0 - smoothstep(10.0, 22.0, moonAltDeg));
        moonExtinctCol = mix(moonExtinctCol, vec3(0.88, 0.38, 0.55), purpleWeight * 0.65);

        vec3 moonTintLin = lin(moonExtinctCol);
        float horVis = smoothstep(-3.0, 0.5, moonAltDeg);

        if (moonDiskMask > 0.001) {
          float zSph = sqrt(max(0.0, 1.0 - min(rDisk * rDisk, 1.0)));
          vec3 lunarN = mRight * mCoord.x + mUp * mCoord.y - moonDir * zSph;
          float litMask = smoothstep(-0.04, 0.06, dot(lunarN, sunDir));

          float mAng = uMoonOpt.z;
          float ca = cos(mAng), sa = sin(mAng);
          vec2 pDisk = vec2(ca * mCoord.x - sa * mCoord.y, sa * mCoord.x + ca * mCoord.y);
          float mariaNoise = fbm(pDisk * 4.2 + vec2(1.7, 4.3)) * 0.7 + vnoise(pDisk * 9.5) * 0.3;
          float mariaDarkness = mix(0.68, 1.0, smoothstep(0.35, 0.65, mariaNoise));

          vec3 moonLitColor  = moonTintLin * 2.2 * mariaDarkness;
          vec3 moonDarkColor = lin(vec3(0.08, 0.14, 0.26)) * (0.35 * mariaDarkness);
          vec3 unlitSide = max(sky, moonDarkColor * (0.12 + 0.88 * uSunCol.w));
          vec3 moonSurface = mix(unlitSide, max(sky, moonLitColor), litMask);
          sky = mix(sky, moonSurface, moonDiskMask * horVis);
        }

        float moonGlow = pow(clamp((md - 0.994) / 0.006, 0.0, 1.0), 3.2);
        float glowPhase = sin(clamp(uMoonOpt.x, 0.0, 1.0) * 3.14159);
        sky += moonTintLin * (moonGlow * 0.65 * glowPhase * (0.15 + 0.85 * uSunCol.w) * horVis);
      }
    }

    if (uSunCol.w > 0.3 && rd.y > 0.02 && (mMode == 1 || mMode == 5)) {
      vec3 sp = rd * 180.0;
      float hs = hash21(floor(sp.xy + sp.z * 31.7));
      if (hs > 0.988) {
        float st = smoothstep(0.35, 0.0, length(fract(sp) - 0.5));
        sky += vec3(0.85, 0.92, 1.0) * st * uSunCol.w * 0.9 * (1.0 - moonDiskMask);
      }
    }
    col = pow(clamp(sky, 0.0, 1.0), vec3(1.0 / 2.2));

    // Ореол над линией горизонта гор (backHalo на небе)
    if (uEdgeOpt.x > 0.5 && uTerrEdge5.w > 0.005) {
      vec2 tSt = uTexel * max(uTerrEdge1.w, 0.1);
      float rN = texture(uDepthTex, vUV + vec2(0.0, tSt.y)).r;
      float rS = texture(uDepthTex, vUV - vec2(0.0, tSt.y)).r;
      float rE = texture(uDepthTex, vUV + vec2(tSt.x, 0.0)).r;
      float rW = texture(uDepthTex, vUV - vec2(tSt.x, 0.0)).r;
      float minRaw = min(min(rN, rS), min(rE, rW));
      if (minRaw < 0.99999) {
        float minN = linearZ(minRaw);
        float f0 = uEdgeOpt.w * uTerrEdge3.x;
        float f1 = max(f0 + 10.0, uEdgeOpt.w * uTerrEdge3.y);
        float nearFade = 1.0 - smoothstep(f0, f1, minN);
        float haloSup = uTerrEdgeColD.w > 0.5 ? smoothstep(uTerrEdgeColD.w * 0.25, uTerrEdgeColD.w, minN) : 1.0;
        bool dark = uMode.w > 0.5;
        int mEdge = int(uMode.x + 0.5);
        float modeEdgeK = (mEdge == 1) ? uTerrEdge4.z : ((mEdge == 5) ? uTerrEdge4.w : uTerrEdgeColL.w);
        vec3 haloCol = mix(skySrgb, vec3(1.0), dark ? 0.12 : 0.45);
        col = mix(col, haloCol, clamp(uTerrEdge5.w * 0.55 * (0.35 + 0.65 * nearFade) * haloSup * modeEdgeK, 0.0, 0.75));
      }
    }
  } else {
    col = c.rgb;
    if (uEdgeOpt.x > 0.5) {
      float dC = dTerrC;
      vec2 tSt = uTexel * max(uTerrEdge1.w, 0.1);
      float rN = texture(uDepthTex, vUV + vec2(0.0, tSt.y)).r;
      float rS = texture(uDepthTex, vUV - vec2(0.0, tSt.y)).r;
      float rE = texture(uDepthTex, vUV + vec2(tSt.x, 0.0)).r;
      float rW = texture(uDepthTex, vUV - vec2(tSt.x, 0.0)).r;
      float dN = linearZ(rN), dS = linearZ(rS), dE = linearZ(rE), dW = linearZ(rW);

      float thr = max(uTerrEdge1.x, dC * uTerrEdge1.y);
      bool isWaterPx = (c.a < 0.90);
      if (isWaterPx) thr *= 2.2;
      float sf = uTerrEdge5.x;

      // Фильтр непрерывных склонов
      float gN = (rN < 0.99999) ? ((dN - dC) - sf * max(0.0, dC - dS)) : 0.0;
      float gS = (rS < 0.99999) ? ((dS - dC) - sf * max(0.0, dC - dN)) : 0.0;
      float gE = (rE < 0.99999) ? ((dE - dC) - sf * max(0.0, dC - dW)) : 0.0;
      float gW = (rW < 0.99999) ? ((dW - dC) - sf * max(0.0, dC - dE)) : 0.0;
      float maxDiff = max(max(gN, gS), max(gE, gW));

      bool skyNeighbor = false;
      bool sameHaloStep = abs(uTerrEdge5.y - uTerrEdge1.w) < 0.02;
      vec2 hSt = uTexel * max(uTerrEdge5.y, 0.1);
      if (uTerrEdge5.y > 0.05) {
        if (sameHaloStep) {
          skyNeighbor = (rN >= 0.99999 || rS >= 0.99999 || rE >= 0.99999 || rW >= 0.99999);
        } else {
          skyNeighbor = (
            texture(uDepthTex, vUV + vec2(0.0, hSt.y)).r >= 0.99999 ||
            texture(uDepthTex, vUV - vec2(0.0, hSt.y)).r >= 0.99999 ||
            texture(uDepthTex, vUV + vec2(hSt.x, 0.0)).r >= 0.99999 ||
            texture(uDepthTex, vUV - vec2(hSt.x, 0.0)).r >= 0.99999
          );
        }
      }

      if (uTerrEdge2.x > 0.01) {
        float rNW = texture(uDepthTex, vUV + vec2(-tSt.x, tSt.y)).r;
        float rNE = texture(uDepthTex, vUV + vec2( tSt.x, tSt.y)).r;
        float rSW = texture(uDepthTex, vUV + vec2(-tSt.x,-tSt.y)).r;
        float rSE = texture(uDepthTex, vUV + vec2( tSt.x,-tSt.y)).r;
        float dNW = linearZ(rNW), dNE = linearZ(rNE), dSW = linearZ(rSW), dSE = linearZ(rSE);

        float gNW = (rNW < 0.99999) ? ((dNW - dC) - sf * max(0.0, dC - dSE)) : 0.0;
        float gNE = (rNE < 0.99999) ? ((dNE - dC) - sf * max(0.0, dC - dSW)) : 0.0;
        float gSW = (rSW < 0.99999) ? ((dSW - dC) - sf * max(0.0, dC - dNE)) : 0.0;
        float gSE = (rSE < 0.99999) ? ((dSE - dC) - sf * max(0.0, dC - dNW)) : 0.0;
        float diagMax = max(max(gNW, gNE), max(gSW, gSE));
        maxDiff = max(maxDiff, diagMax * uTerrEdge2.x);

        if (!skyNeighbor && uTerrEdge5.y > 0.05) {
          if (sameHaloStep) {
            skyNeighbor = (rNW >= 0.99999 || rNE >= 0.99999 || rSW >= 0.99999 || rSE >= 0.99999);
          } else {
            skyNeighbor = (
              texture(uDepthTex, vUV + vec2(-hSt.x, hSt.y)).r >= 0.99999 ||
              texture(uDepthTex, vUV + vec2( hSt.x, hSt.y)).r >= 0.99999 ||
              texture(uDepthTex, vUV + vec2(-hSt.x,-hSt.y)).r >= 0.99999 ||
              texture(uDepthTex, vUV + vec2( hSt.x,-hSt.y)).r >= 0.99999
            );
          }
        }
      }

      float intEdge = 0.0;
      if (uTerrEdge1.z <= 0.005) {
        intEdge = (maxDiff > thr) ? 1.0 : 0.0;
      } else {
        intEdge = smoothstep(thr, thr * (1.0 + uTerrEdge1.z) + 0.001, maxDiff);
      }

      if (uTerrEdge2.z > 0.5 && c.a > 0.25 && c.a < 0.75) {
        if (texture(uColorTex, vUV + vec2(0.0, tSt.y)).a > 0.75 ||
            texture(uColorTex, vUV - vec2(0.0, tSt.y)).a > 0.75 ||
            texture(uColorTex, vUV + vec2(tSt.x, 0.0)).a > 0.75 ||
            texture(uColorTex, vUV - vec2(tSt.x, 0.0)).a > 0.75) intEdge = 1.0;
      }

      float edge = max(intEdge, skyNeighbor ? 1.0 : 0.0);
      float nearSup = uTerrEdgeColD.w;
      if (nearSup > 0.5) {
        edge *= smoothstep(nearSup * 0.25, nearSup, dC);
      }

      if (edge > 0.0 && uCanopyOpt.w > 1.5 && uTreeLineOpt.y > 0.5 && c.a > 0.75) {
        vec4 ccOcc = texture(uCanopyColorTex, vUV);
        if (ccOcc.a > 0.1 && ccOcc.g > 0.02) {
          float dCanOcc = linearZ(texture(uCanopyDepthTex, vUV).r);
          if (dCanOcc < dC - uTerrEdge2.w) edge = 0.0;
        }
      }

      bool dark = uMode.w > 0.5;
      float f0 = uEdgeOpt.w * uTerrEdge3.x;
      float f1 = max(f0 + 10.0, uEdgeOpt.w * uTerrEdge3.y);
      float distFade = 1.0 - smoothstep(f0, f1, dC);
      float atmT = smoothstep(f0, f1, dC) * uTerrEdge5.z;
      int mEdge = int(uMode.x + 0.5);
      float modeEdgeK = (mEdge == 1) ? uTerrEdge4.z : ((mEdge == 5) ? uTerrEdge4.w : uTerrEdgeColL.w);

      // Светлый ореол разделения планов за ближним хребтом
      if (uTerrEdge5.w > 0.005 && edge < 0.5) {
        float minN = min(min(dN, dS), min(dE, dW));
        float bN = (rN < 0.99999) ? ((dC - dN) - sf * max(0.0, dS - dC)) : 0.0;
        float bS = (rS < 0.99999) ? ((dC - dS) - sf * max(0.0, dN - dC)) : 0.0;
        float bE = (rE < 0.99999) ? ((dC - dE) - sf * max(0.0, dW - dC)) : 0.0;
        float bW = (rW < 0.99999) ? ((dC - dW) - sf * max(0.0, dE - dC)) : 0.0;
        float backDiff = max(max(bN, bS), max(bE, bW));
        float thrNear = max(uTerrEdge1.x, minN * uTerrEdge1.y);
        float halo = smoothstep(thrNear, thrNear * (1.0 + max(uTerrEdge1.z, 0.25)) + 0.001, backDiff);
        if (nearSup > 0.5) halo *= smoothstep(nearSup * 0.25, nearSup, minN);
        if (halo > 0.01) {
          float nearDistFade = 1.0 - smoothstep(f0, f1, minN);
          vec3 haloCol = mix(skySrgb, vec3(1.0), dark ? 0.12 : 0.50);
          col = mix(col, haloCol, clamp(halo * uTerrEdge5.w * (0.35 + 0.65 * nearDistFade) * modeEdgeK, 0.0, 0.85));
        }
      }

      if (edge > 0.0) {
        float strength = clamp(uTerrEdge3.z + uTerrEdge3.w * distFade, uTerrEdge4.x, max(uTerrEdge4.x, uTerrEdge4.y));
        if (skyNeighbor) strength = clamp(strength * uTerrEdge2.y, 0.0, 1.0);
        vec3 baseLineCol = dark ? uTerrEdgeColD.rgb : uTerrEdgeColL.rgb;
        terrEdgeCol = mix(baseLineCol, skySrgb, atmT);
        terrEdgeAlpha = clamp(edge * strength * modeEdgeK, 0.0, 1.0);
        col = mix(col, terrEdgeCol, terrEdgeAlpha);
      }
    }
    // Внутренние контуры гребней и ложбин (по 2-й производной глубины)
    if (c.a > 0.90 && (uCrease1.x > 0.5 || uCrease1.w > 0.5) && dTerrC < uCrease2.w) {
      vec2 cSt = uTexel * max(uCrease2.z, 0.5);
      vec2 wSt = cSt * 2.5;
      float aN = texture(uColorTex, vUV + vec2(0.0, wSt.y)).a;
      float aS = texture(uColorTex, vUV - vec2(0.0, wSt.y)).a;
      float aE = texture(uColorTex, vUV + vec2(wSt.x, 0.0)).a;
      float aW = texture(uColorTex, vUV - vec2(wSt.x, 0.0)).a;
      bool nearWater = (aN > 0.75 && aN < 0.90) || (aS > 0.75 && aS < 0.90) ||
                       (aE > 0.75 && aE < 0.90) || (aW > 0.75 && aW < 0.90);
      if (!nearWater) {
        float crN = texture(uDepthTex, vUV + vec2(0.0, cSt.y)).r;
        float crS = texture(uDepthTex, vUV - vec2(0.0, cSt.y)).r;
        float crE = texture(uDepthTex, vUV + vec2(cSt.x, 0.0)).r;
        float crW = texture(uDepthTex, vUV - vec2(cSt.x, 0.0)).r;
        if (crN < 0.99999 && crS < 0.99999 && crE < 0.99999 && crW < 0.99999) {
          float sc = dTerrC / max(uEdgeOpt.y, 0.5);
          float cV = ((crN + crS) * 0.5 - dRaw) * sc;
          float cH = ((crE + crW) * 0.5 - dRaw) * sc;
          float qFloor = dTerrC * 2.2e-7; // защита от квантования 24-бит глубины
          float cFade = (1.0 - smoothstep(uCrease2.w * 0.45, uCrease2.w, dTerrC))
                      * smoothstep(12.0, 55.0, dTerrC)
                      * (1.0 - terrEdgeAlpha);

          float sketch = 1.0;
          if (uCreaseColR.w > 0.01) {
            sketch = mix(1.0, smoothstep(0.28, 0.72, vnoise(gl_FragCoord.xy * 0.085)), uCreaseColR.w);
          }
          if (uCrease1.x > 0.5) {
            float rVal = max(cV, cH);
            float rThr = max(uCrease1.y, qFloor);
            float rLine = smoothstep(rThr, rThr * 2.2 + 1e-5, rVal) * cFade * sketch;
            if (rLine > 0.01) col = mix(col, uCreaseColR.rgb, clamp(rLine * uCrease1.z, 0.0, 0.92));
          }
          if (uCrease1.w > 0.5) {
            float vVal = max(-cV, -cH);
            float vThr = max(uCrease2.x, qFloor);
            float vLine = smoothstep(vThr, vThr * 2.2 + 1e-5, vVal) * cFade * sketch;
            if (vLine > 0.01) col = mix(col, uCreaseColV.rgb, clamp(vLine * uCrease2.y, 0.0, 0.92));
          }
        }
      }
    }
  }

  // Наложение сплошного волнистого массива леса (режим 'mass')
  if (uCanopyOpt.w > 0.5 && uCanopyOpt.w < 1.5 && uCanopyOpt.x > 0.01) {
    vec4 cc = texture(uCanopyColorTex, vUV);
    float dCanRaw = texture(uCanopyDepthTex, vUV).r;
    bool canopyVisible = (cc.a > 0.1 && dCanRaw < dRaw);

    if (canopyVisible) {
      float dCanC = linearZ(dCanRaw);
      hasGeom = true;
      dFog = dCanC;
      dRawFog = dCanRaw;
      vec3 canCol = cc.rgb;
      if (uDevComp1.x > 0.5) {
        float topWeight = clamp((cc.a - 0.20) / 0.80, 0.0, 1.0);
        if (topWeight > 0.02) {
          vec2 st = uTexel * uDevComp1.w;

          float dCanN  = linearZ(texture(uCanopyDepthTex, vUV + vec2(0.0, st.y)).r);
          float dCanN2 = linearZ(texture(uCanopyDepthTex, vUV + vec2(0.0, 2.0 * st.y)).r);
          float dCanNW = linearZ(texture(uCanopyDepthTex, vUV + vec2(-st.x, st.y)).r);
          float dCanNE = linearZ(texture(uCanopyDepthTex, vUV + vec2( st.x, st.y)).r);

          float caN  = texture(uCanopyColorTex, vUV + vec2(0.0, st.y)).a;
          float caN2 = texture(uCanopyColorTex, vUV + vec2(0.0, 2.0 * st.y)).a;
          float caNW = texture(uCanopyColorTex, vUV + vec2(-st.x, st.y)).a;
          float caNE = texture(uCanopyColorTex, vUV + vec2( st.x, st.y)).a;

          float dTerrN = linearZ(texture(uDepthTex, vUV + vec2(0.0, st.y)).r);
          float notHillOccluded = mix(1.0, step(dCanC - 1.5, dTerrN), uDevComp3.z);

          float cThr = max(uDevComp2.x, dCanC * uDevComp2.y);
          float topOut  = (caN < 0.1 || caNW < 0.1 || caNE < 0.1) ? 1.0 : 0.0;
          float topOut2 = (caN2 < 0.1) ? 0.55 : 0.0;

          float rN  = (caN  >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanN  - dCanC) : 0.0;
          float rNW = (caNW >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanNW - dCanC) : 0.0;
          float rNE = (caNE >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanNE - dCanC) : 0.0;
          float rN2 = (caN2 >= 0.1) ? smoothstep(cThr * 1.15, max(cThr + 1.5, cThr * 1.9), dCanN2 - dCanC) * 0.55 : 0.0;
          float topRidge = max(max(rN, rNW), max(rNE, rN2));

          if (uDevComp2.w > 0.5) {
            float caW = texture(uCanopyColorTex, vUV + vec2(-st.x, 0.0)).a;
            float caE = texture(uCanopyColorTex, vUV + vec2( st.x, 0.0)).a;
            if (caW < 0.1 || caE < 0.1) topOut = 1.0;
            float dCanW = linearZ(texture(uCanopyDepthTex, vUV + vec2(-st.x, 0.0)).r);
            float dCanE = linearZ(texture(uCanopyDepthTex, vUV + vec2( st.x, 0.0)).r);
            float rW = (caW >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanW - dCanC) : 0.0;
            float rE = (caE >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanE - dCanC) : 0.0;
            topRidge = max(topRidge, max(rW, rE));
          }
          if (uDevComp2.w > 1.5) {
            float caS  = texture(uCanopyColorTex, vUV + vec2(0.0, -st.y)).a;
            float caSW = texture(uCanopyColorTex, vUV + vec2(-st.x, -st.y)).a;
            float caSE = texture(uCanopyColorTex, vUV + vec2( st.x, -st.y)).a;
            if (caS < 0.1 || caSW < 0.1 || caSE < 0.1) topOut = 1.0;
            float dCanS  = linearZ(texture(uCanopyDepthTex, vUV + vec2(0.0, -st.y)).r);
            float dCanSW = linearZ(texture(uCanopyDepthTex, vUV + vec2(-st.x, -st.y)).r);
            float dCanSE = linearZ(texture(uCanopyDepthTex, vUV + vec2( st.x, -st.y)).r);
            float rS  = (caS  >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanS  - dCanC) : 0.0;
            float rSW = (caSW >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanSW - dCanC) : 0.0;
            float rSE = (caSE >= 0.1) ? smoothstep(cThr, max(cThr + 1.0, cThr * 1.75), dCanSE - dCanC) : 0.0;
            topRidge = max(topRidge, max(rS, max(rSW, rSE)));
          }

          float outerW = max(topOut, topOut2) * uDevComp1.y;
          float ridgeW = topRidge * uDevComp1.z;
          float edgeW = clamp(max(outerW, ridgeW), 0.0, 1.0) * topWeight * notHillOccluded;

          if (edgeW > 0.02) {
            float cFade = 1.0 - smoothstep(uDevComp3.x, max(uDevComp3.x + 50.0, uDevComp3.y), dCanC);
            float cStr = clamp(edgeW * uDevComp2.z * (0.35 + 0.65 * cFade), 0.0, 0.96);
            canCol = mix(canCol, uDevCompCol.rgb, cStr);
          }
        }
      }
      col = mix(col, canCol, clamp(uCanopyOpt.x, 0.0, 1.0));
      if (uCanopyOpt.z > 0.5 && terrEdgeAlpha > 0.005) {
        col = mix(col, terrEdgeCol, terrEdgeAlpha);
      }
    }
  }

  // Умная видимость: слоистая воздушная перспектива (3–4 плана гор + долины)
  // Выполняется ДО затемнения зоной леса, чтобы лес затемнял и туман/дымку за собой
  if (hasGeom && uSmartFog1.x > 0.5) {
    float b1 = max(uSmartFog2.x, 80.0);
    float b2 = max(uSmartFog2.y, b1 + 80.0);
    float b3 = max(uSmartFog2.z, b2 + 80.0);
    float fMax = max(uSmartFog2.w, 600.0);
    float cSoft = mix(0.34, 0.055, clamp(uSmartFog1.w, 0.0, 1.0));

    float s1 = smoothstep(b1 * (1.0 - cSoft), b1 * (1.0 + cSoft), dFog);
    float s2 = smoothstep(b2 * (1.0 - cSoft), b2 * (1.0 + cSoft), dFog);
    float s3 = (uSmartFog1.y > 3.5) ? smoothstep(b3 * (1.0 - cSoft), b3 * (1.0 + cSoft), dFog) : 0.0;

    float planeAmt = (uSmartFog1.y < 3.5)
      ? (s1 * 0.36 + s2 * 0.54)
      : (s1 * 0.22 + s2 * 0.34 + s3 * 0.34);

    float farCap = smoothstep(fMax * 0.78, fMax * 1.12, dFog);
    planeAmt = max(planeAmt, farCap * 0.96);

    vec4 wpPix = uInvVP * vec4(vNdc, dRawFog * 2.0 - 1.0, 1.0);
    float pixY = wpPix.y / wpPix.w;
    float hSpan = max(uSmartFog3.w - uSmartFog3.z, 40.0);
    float hNorm = clamp((pixY - uSmartFog3.z) / hSpan, 0.0, 1.0);

    float distGate = smoothstep(b1 * 0.45, b1 * 1.15, dFog);
    float valleyFactor = pow(1.0 - hNorm, 1.45) * uSmartFog3.x;
    float planeMod = planeAmt + valleyFactor * distGate * (0.48 - planeAmt * 0.25);

    // Полоса дымки непосредственно за гребнями ближних гор
    float ridgeBack = 0.0;
    if (uSmartFog3.y > 0.01 && dFog > b1 * 0.45) {
      float rS1 = texture(uDepthTex, vUV - vec2(0.0, uTexel.y * 5.0)).r;
      float rS2 = texture(uDepthTex, vUV - vec2(0.0, uTexel.y * 14.0)).r;
      float rS3 = texture(uDepthTex, vUV - vec2(0.0, uTexel.y * 28.0)).r;
      float dS1 = (rS1 < 0.99999) ? linearZ(rS1) : dFog;
      float dS2 = (rS2 < 0.99999) ? linearZ(rS2) : dFog;
      float dS3 = (rS3 < 0.99999) ? linearZ(rS3) : dFog;
      ridgeBack = (
        smoothstep(0.20, 0.80, (dFog - dS1) / max(dS1, 60.0)) * 0.55 +
        smoothstep(0.25, 0.95, (dFog - dS2) / max(dS2, 60.0)) * 0.30 +
        smoothstep(0.30, 1.10, (dFog - dS3) / max(dS3, 60.0)) * 0.15
      ) * uSmartFog3.y * 0.52 * distGate;
    }

    float fogFinal = clamp((planeMod + ridgeBack) * uSmartFog1.z, 0.0, 0.985);
    fogFinal *= smoothstep(b1 * 0.35, b1 * 0.88, dFog);

    vec3 linCol = pow(max(col, vec3(0.0)), vec3(2.2));
    vec3 hazeCol = uSkyHor.rgb;
    int mSF = int(uMode.x + 0.5);
    if (mSF != 0 && mSF != 4) {
      vec3 rayD = normalize(wpPix.xyz / wpPix.w - uCam.xyz);
      float sAlign = max(dot(rayD, normalize(uSunDir.xyz)), 0.0);
      float dayS = smoothstep(-4.0, 12.0, uSunDir.w);
      hazeCol += uSunCol.rgb * (pow(sAlign, 5.0) * 0.14 * dayS);
    }
    linCol = mix(linCol, hazeCol, fogFinal);
    col = pow(clamp(linCol, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  // Читаем текстуры до условных ветвлений (для корректной работы fwidth)
  bool treesOverlayOn = (uCanopyOpt.w > 1.5 && (uTreeLineOpt.x > 0.5 || uTreeLineOpt.y > 0.5));
  vec4 ccPre = treesOverlayOn ? texture(uCanopyColorTex, vUV) : vec4(0.0);
  bool hasCcPre = treesOverlayOn && ccPre.a > 0.1 && ccPre.g > 0.02;
  float dCanC = hasCcPre ? linearZ(texture(uCanopyDepthTex, vUV).r) : uEdgeOpt.z;

  vec4 cwPre = vec4(0.0);
  float fwRim = 0.0;
  if (treesOverlayOn && uTreeLineOpt.z > 0.5) {
    cwPre = texture(uClearColorTex, vUV);
    if (uTreeLineOpt.x > 0.5) fwRim = fwidth(cwPre.r);
  }
  bool hasCwPre = treesOverlayOn && (uTreeLineOpt.z > 0.5) && cwPre.a > 0.1 && cwPre.g > 0.02;
  float dCwC = hasCwPre ? linearZ(texture(uClearDepthTex, vUV).r) : uEdgeOpt.z;

  // Зона допуска / затемнения объектов позади леса (режим 'trees')
  if (uCanopyOpt.w > 1.5 && uTreeLineOpt.y > 0.5 && (hasCcPre || hasCwPre)) {
    float zStr = 0.0;

    // 1. Затемнение от обычных лесных массивов (canopyFbo)
    if (hasCcPre) {
      float zoneMask = 0.0;
      if (c.a < 0.1) {
        zoneMask = uFZone2.y;
      } else if (c.a < 0.75) {
        float t0 = dCanC + uFZone1.x;
        float t1 = max(t0 + 0.1, dCanC + uFZone1.y);
        zoneMask = smoothstep(t0, t1, dTerrC) * uFZone2.z;
      } else {
        float r0 = dCanC + uFZone1.z;
        float r1 = max(r0 + 0.1, dCanC + uFZone1.w);
        zoneMask = smoothstep(r0, r1, dTerrC);
      }
      zStr = max(zStr, clamp(zoneMask * ccPre.g * uFZone2.x, 0.0, 1.0));
    }

    // 2. Затемнение ближайшей зоны от среза прогалины (clearFbo), не перекрывающее контуры
    if (hasCwPre) {
      float zoneMaskCw = 0.0;
      if (c.a < 0.1) {
        zoneMaskCw = uFZone2.y;
      } else if (c.a < 0.75) {
        float t0 = dCwC + uFZone1.x;
        float t1 = max(t0 + 0.1, dCwC + uFZone1.y);
        zoneMaskCw = smoothstep(t0, t1, dTerrC) * uFZone2.z;
      } else {
        float r0 = dCwC + uFZone1.z;
        float r1 = max(r0 + 0.1, dCwC + uFZone1.w);
        zoneMaskCw = smoothstep(r0, r1, dTerrC);
      }
      zStr = max(zStr, clamp(zoneMaskCw * cwPre.g * uFZone2.x, 0.0, 1.0));
    }

    if (zStr > 0.005) {
      int mFz = int(uMode.x + 0.5);
      bool isDarkOrNight = (uMode.w > 0.5) || (uSunCol.w > 0.45 && mFz != 0 && mFz != 4);
      vec3 tintCol = isDarkOrNight ? uFZoneColD.rgb : uFZoneColL.rgb;
      col = mix(col, col * tintCol, zStr);
    }
  }

  // Зелёные контуры высоты деревьев для всех лесных массивов (режим 'trees')
  if (uCanopyOpt.w > 1.5 && uTreeLineOpt.x > 0.5 && hasCcPre) {
    bool canVisible = (c.a < 0.75)
      ? (c.a < 0.1 || uCanopyOpt.y > 0.5 || dCanC <= dTerrC + uTreeEdge2.w)
      : (dCanC <= dTerrC + uTreeEdge3.x);

    if (canVisible) {
      vec2 st = uTexel * max(uTreeEdge1.x, 0.1);
      float rCanN  = texture(uCanopyDepthTex, vUV + vec2(0.0, st.y)).r;
      float rCanNW = texture(uCanopyDepthTex, vUV + vec2(-st.x, st.y)).r;
      float rCanNE = texture(uCanopyDepthTex, vUV + vec2( st.x, st.y)).r;

      float dCanN  = linearZ(rCanN);
      float dCanNW = linearZ(rCanNW);
      float dCanNE = linearZ(rCanNE);

      float tsf = uTreeEdge5.x;
      float rCanS = 1.0, rCanSW = 1.0, rCanSE = 1.0;
      float dCanS = dCanC, dCanSW = dCanC, dCanSE = dCanC;
      if (tsf > 0.01 || uTreeEdge2.x > 1.5) {
        rCanS  = texture(uCanopyDepthTex, vUV + vec2(0.0, -st.y)).r;
        rCanSW = texture(uCanopyDepthTex, vUV + vec2(-st.x, -st.y)).r;
        rCanSE = texture(uCanopyDepthTex, vUV + vec2( st.x, -st.y)).r;
        dCanS  = linearZ(rCanS);
        dCanSW = linearZ(rCanSW);
        dCanSE = linearZ(rCanSE);
      }

      float outerHit = (rCanN >= 0.99999 || rCanNW >= 0.99999 || rCanNE >= 0.99999) ? 1.0 : 0.0;
      float diffN  = (rCanN  < 0.99999) ? ((dCanN  - dCanC) - tsf * max(0.0, dCanC - dCanS))  : 0.0;
      float diffNW = (rCanNW < 0.99999) ? ((dCanNW - dCanC) - tsf * max(0.0, dCanC - dCanSE)) : 0.0;
      float diffNE = (rCanNE < 0.99999) ? ((dCanNE - dCanC) - tsf * max(0.0, dCanC - dCanSW)) : 0.0;
      float maxRidgeDiff = max(diffN, max(diffNW, diffNE));

      if (uTreeEdge2.x < 0.5 || uTreeEdge2.x > 1.5) {
        float rCanW = texture(uCanopyDepthTex, vUV + vec2(-st.x, 0.0)).r;
        float rCanE = texture(uCanopyDepthTex, vUV + vec2( st.x, 0.0)).r;
        float dCanW = linearZ(rCanW);
        float dCanE = linearZ(rCanE);
        float diffW = (rCanW < 0.99999) ? ((dCanW - dCanC) - tsf * max(0.0, dCanC - dCanE)) : 0.0;
        float diffE = (rCanE < 0.99999) ? ((dCanE - dCanC) - tsf * max(0.0, dCanC - dCanW)) : 0.0;
        maxRidgeDiff = max(maxRidgeDiff, max(diffW, diffE));
        if (uTreeEdge2.x > 1.5) {
          if (rCanW >= 0.99999 || rCanE >= 0.99999 || rCanS >= 0.99999 || rCanSW >= 0.99999 || rCanSE >= 0.99999) outerHit = 1.0;
          float diffS  = (rCanS  < 0.99999) ? ((dCanS  - dCanC) - tsf * max(0.0, dCanC - dCanN))  : 0.0;
          float diffSW = (rCanSW < 0.99999) ? ((dCanSW - dCanC) - tsf * max(0.0, dCanC - dCanNE)) : 0.0;
          float diffSE = (rCanSE < 0.99999) ? ((dCanSE - dCanC) - tsf * max(0.0, dCanC - dCanNW)) : 0.0;
          maxRidgeDiff = max(maxRidgeDiff, max(diffS, max(diffSW, diffSE)));
        }
      }

      float cThr = max(uTreeEdge1.y, dCanC * uTreeEdge1.z);
      float ridgeEdge = (uTreeEdge1.w <= 0.005)
        ? ((maxRidgeDiff > cThr) ? 1.0 : 0.0)
        : smoothstep(cThr, cThr * (1.0 + uTreeEdge1.w) + 0.001, maxRidgeDiff);

      float cEdge = clamp(max(outerHit * uTreeEdge2.y, ridgeEdge * uTreeEdge2.z), 0.0, 1.0);

      if (uTreeEdge5.z > 0.5) {
        cEdge *= smoothstep(uTreeEdge5.z * 0.25, uTreeEdge5.z, dCanC);
      }
      if (uTreeEdge4.w > 0.01) {
        float dash = 0.5 + 0.5 * sin((gl_FragCoord.x + gl_FragCoord.y * 0.6) * uTreeEdgeColL.w);
        cEdge *= mix(1.0, smoothstep(0.20, 0.72, dash), uTreeEdge4.w);
      }

      if (cEdge > 0.01) {
        int mTree = int(uMode.x + 0.5);
        bool isDarkOrNight = (uMode.w > 0.5) || (uSunCol.w > 0.45 && mTree != 0 && mTree != 4);
        float tf0 = uTreeEdge3.y;
        float tf1 = max(tf0 + 10.0, uTreeEdge3.z);
        float distFade = 1.0 - smoothstep(tf0, tf1, dCanC);
        float strength = clamp(uTreeEdge3.w + uTreeEdge4.x * distFade, uTreeEdge4.y, max(uTreeEdge4.y, uTreeEdge4.z)) * ccPre.g * cEdge;
        if (c.a < 0.1) strength *= uTreeEdge5.y;
        float tAtm = smoothstep(tf0, tf1, dCanC) * uTreeEdge5.w;
        vec3 treeLineCol = mix(isDarkOrNight ? uTreeEdgeColD.rgb : uTreeEdgeColL.rgb, skySrgb, tAtm);
        col = mix(col, treeLineCol, clamp(strength, 0.0, 1.0));
      }
    }
  }

  // Контур самого ближайшего среза прогалины (рисуется независимо и не перекрывает дальние контуры)
  if (uCanopyOpt.w > 1.5 && uTreeLineOpt.x > 0.5 && uTreeLineOpt.z > 0.5 && hasCwPre) {
    bool cwVisible = (c.a < 0.75)
      ? (c.a < 0.1 || dCwC <= dTerrC + uTreeEdge2.w)
      : (dCwC <= dTerrC + uTreeEdge3.x);

    if (cwVisible) {
      float cwEdge = 0.0;
      if (cwPre.r > 0.15 && cwPre.r < 0.95) {
        float rimLine = 1.0 - smoothstep(0.0, max(fwRim * 1.6, 0.025), abs(cwPre.r - 0.65));
        cwEdge = max(cwEdge, rimLine * 0.65);
      }
      if (cwPre.b > 0.18) {
        vec2 st = uTexel * max(uTreeEdge1.x, 0.1);
        vec4 cwS  = texture(uClearColorTex, vUV - vec2(0.0, st.y));
        vec4 cwSW = texture(uClearColorTex, vUV + vec2(-st.x, -st.y));
        vec4 cwSE = texture(uClearColorTex, vUV + vec2( st.x, -st.y));
        float dCwS   = linearZ(texture(uClearDepthTex, vUV - vec2(0.0, st.y)).r);
        float caTerrS = texture(uColorTex, vUV - vec2(0.0, st.y)).a;
        float dTerrS = (caTerrS < 0.1) ? uEdgeOpt.z : linearZ(texture(uDepthTex, vUV - vec2(0.0, st.y)).r);
        if (cwS.a < 0.1 || cwSW.a < 0.1 || cwSE.a < 0.1 || cwS.g < 0.18 || dCwS > dTerrS + uTreeEdge3.x) {
          cwEdge = max(cwEdge, 0.58);
        }
      }
      if (uTreeEdge4.w > 0.01) {
        float dash = 0.5 + 0.5 * sin((gl_FragCoord.x + gl_FragCoord.y * 0.6) * uTreeEdgeColL.w);
        cwEdge *= mix(1.0, smoothstep(0.20, 0.72, dash), uTreeEdge4.w);
      }
      if (cwEdge > 0.01) {
        int mTree = int(uMode.x + 0.5);
        bool isDarkOrNight = (uMode.w > 0.5) || (uSunCol.w > 0.45 && mTree != 0 && mTree != 4);
        float strength = clamp(uTreeEdge3.w + uTreeEdge4.x, uTreeEdge4.y, max(uTreeEdge4.y, uTreeEdge4.z)) * cwPre.g * cwEdge;
        if (c.a < 0.1) strength *= uTreeEdge5.y;
        vec3 treeLineCol = isDarkOrNight ? uTreeEdgeColD.rgb : uTreeEdgeColL.rgb;
        col = mix(col, treeLineCol, clamp(strength, 0.0, 1.0));
      }
    }
  }

  outCol = vec4(col, 1.0);
}`;


  // ===========================================================================
  // 7. РЕНДЕРЕР WEBGL2
  // ===========================================================================
  const CANOPY_CONTOUR_TOPO = {
    rxScale: 0.78, topFlatten: 1.47, skirtScale: 0.25, waveFreq: 0.055,
    lobeAmp: 0.35, lobeFreq: 5, jitterAmp: 1.8, edgeShrink: 0.75,
    edgeRxShrink: 0.75, heightGamma: 2.3, gammaRxCouple: 1,
    ndlWeight: 0, litPos: 0.25, litSoft: 0.002, hiPos: 0.51, hiSoft: 0.002, hiStr: 0,
    aoSide: 0, brushAmp: 0.06, brushFreq: 0.13, tintAmp: 0.11,
    sunApply: 1.5, ambApply: 0, lightAllModes: true,
    colShadow: hex3('#265e42'), colBase: hex3('#56a437'), colHi: hex3('#8fc947'),
    darkAutoTint: true, fogStr: 0.54, fogDistScale: 0.34,
    edgeOn: true, edgeCheckMode: 0, edgeOuter: 1.5, edgeRidge: 1.5, edgeThick: 2.2,
    edgeThrBase: 2, edgeThrSlope: 0.06, edgeStr: 0.74,
    edgeFadeStart: 500, edgeFadeEnd: 500, edgeHillOccl: 1,
    upMaskMin: 0, upMaskMax: 0.28, penBreakAmp: 0.3, penBreakFreq: 0.31,
    lineAutoColor: true, colLine: hex3('#14291a')
  };

  const cloneCanopyPreset = src => {
    const out = { ...src };
    if (out.colShadow) out.colShadow = [...out.colShadow];
    if (out.colBase) out.colBase = [...out.colBase];
    if (out.colHi) out.colHi = [...out.colHi];
    if (out.colLine) out.colLine = [...out.colLine];
    return out;
  };

  const CANOPY_SHADED_MODES = cloneCanopyPreset({
    ...CANOPY_CONTOUR_TOPO,
    rxScale: 0.66, topFlatten: 1.73, skirtScale: 0, waveFreq: 0.15,
    lobeAmp: 0.48, lobeFreq: 5, jitterAmp: 2.1, edgeShrink: 0.8,
    edgeRxShrink: 0.74, heightGamma: 0.75, gammaRxCouple: 1,
    colShadow: hex3('#315442'), colBase: hex3('#779c68'), colHi: hex3('#7dd510'),
    darkAutoTint: true, ndlWeight: 0.82, litPos: 0.49, litSoft: 0.002,
    hiPos: 0.7, hiSoft: 0.002, hiStr: 0.12, sunApply: 1.7, ambApply: 0.1,
    lightAllModes: true, aoSide: 0.08, brushAmp: 0.04, brushFreq: 0.21,
    tintAmp: 0.11, fogStr: 0.48, fogDistScale: 0.63,
    upMaskMin: 0.56, upMaskMax: 0.65, penBreakAmp: 0.36, penBreakFreq: 0.12
  });

  const CANOPY_FAR_CONTOUR_TOPO = cloneCanopyPreset(CANOPY_CONTOUR_TOPO);

  const CANOPY_FAR_SHADED_MODES = cloneCanopyPreset({
    ...CANOPY_FAR_CONTOUR_TOPO,
    rxScale: 0.3, topFlatten: 1.01, skirtScale: 1.2, waveFreq: 0.115,
    lobeAmp: 0.6, lobeFreq: 5, jitterAmp: 1.7, edgeShrink: 0.16,
    edgeRxShrink: 0.38, heightGamma: 1.3, gammaRxCouple: 0,
    colShadow: hex3('#265e42'), colBase: hex3('#4d8637'), colHi: hex3('#94c757'),
    darkAutoTint: true, ndlWeight: 1, litPos: 0.81, litSoft: 0.002,
    hiPos: 0.06, hiSoft: 0.002, hiStr: 0.28, sunApply: 2.5, ambApply: 0.5,
    lightAllModes: true, aoSide: 0, brushAmp: 0, brushFreq: 0.01,
    tintAmp: 0.25, fogStr: 0.48, fogDistScale: 0.51,
    upMaskMin: 0.24, upMaskMax: 0.45, penBreakAmp: 0.38, penBreakFreq: 0.3
  });


  function createRenderer(canvas, onLost, onRestored) {
    // Контекст: от лучшего набора атрибутов к самому щадящему. depth/stencil у экранного буфера не нужны —
    // весь рендер идёт в offscreen-FBO, а на экран выводится один полноэкранный треугольник.
    let gl = null;
    const ctxAttempts = [
      { antialias: false, alpha: false, powerPreference: PERF.tier >= 1 ? 'high-performance' : 'default', stencil: false, depth: false },
      { antialias: false, alpha: false, stencil: false, depth: false },
      {}
    ];
    for (const a of ctxAttempts) {
      try { gl = canvas.getContext('webgl2', a); } catch (e) { gl = null; }
      if (gl) break;
    }
    if (!gl) {
      const err = new Error('WebGL2 недоступен: браузер не смог создать графический контекст (обычно исчерпан лимит контекстов или видеопамяти). Закройте лишние вкладки или слои карты и нажмите «Повторить».');
      err.code = 'NO_GL';
      throw err;
    }
    if (gl.isContextLost()) {
      const err = new Error('Графический контекст потерян браузером и ещё не восстановлен. Подождите пару секунд и нажмите «Повторить».');
      err.code = 'LOST';
      throw err;
    }
    PERF.setGpu(gl);
    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    let scaleLimit = 1; // поднимается вниз при нехватке памяти под буферы кадра

    let gpuExt = null; // таймер GPU создаётся только когда открыт оверлей производительности
    const gpuQueries = [];
    let lastGpuMs = null;

    const R = {
      gl, lost: false,
      hasInner: false, hasMid: false, hasOuter: false,
      hasZoom: false, zoomBox: null, // <-- ДОБАВИТЬ ЭТУ СТРОКУ
      hasTrees: false, hasCanopy: false, hasCanopyFar: false, hasBuildings: false, hasCanopySurf: false, hasCanopySurfFar: false,
      stats: {
        drawCalls: 0, terrainTris: 0, bldTris: 0, canopyTris: 0, treeTris: 0,
        rw: 0, rh: 0, glSubmitMs: 0, gpuMs: null
      }
    };


    // Компиляция идёт пакетом: сначала запускаем все шейдеры, и только потом проверяем статус.
    // Драйвер собирает их параллельно, и главный поток не стоит на каждом по отдельности.
    const pendingProgs = [];
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const link = (vs, fs) => {
      const sv = compile(gl.VERTEX_SHADER, vs);
      const sf = compile(gl.FRAGMENT_SHADER, fs);
      const p = gl.createProgram();
      gl.attachShader(p, sv);
      gl.attachShader(p, sf);
      gl.linkProgram(p);
      const loc = {};
      const prog = { p, sv, sf, srcs: [vs, fs], u: n => (n in loc ? loc[n] : (loc[n] = gl.getUniformLocation(p, n))) };
      pendingProgs.push(prog);
      return prog;
    };

    const verifyPrograms = () => {
      for (const pr of pendingProgs) {
        if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS)) {
          let log = '';
          [[pr.sv, pr.srcs[0]], [pr.sf, pr.srcs[1]]].forEach(([sh, src]) => {
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
              const l = gl.getShaderInfoLog(sh) || 'Ошибка компиляции шейдера';
              const numbered = src.split('\n').map((ln, i) => `${i + 1}: ${ln}`).join('\n');
              console.error('[PeakView] Shader compile error:\n' + l + '\n\n' + numbered);
              log += l + '\n';
            }
          });
          if (!log) {
            log = gl.getProgramInfoLog(pr.p) || 'Ошибка линковки программы';
            console.error('[PeakView] Shader link error:\n' + log);
          }
          throw new Error(log);
        }
        // Исходники шейдеров после успешной линковки драйверу больше не нужны
        gl.detachShader(pr.p, pr.sv); gl.deleteShader(pr.sv);
        gl.detachShader(pr.p, pr.sf); gl.deleteShader(pr.sf);
        pr.sv = pr.sf = pr.srcs = null;
      }
      pendingProgs.length = 0;
    };

    const pTerr = link(VS_TERRAIN, FS_TERRAIN);
    const pTree = link(VS_TREE, FS_TREE);
    const pComp = link(VS_TRI, FS_COMPOSITE);
    const pCanopy = link(VS_CANOPY, FS_CANOPY);
    const pCanopySurf = link(VS_CANOPY_SURF, FS_CANOPY_SURF);
    const pBld = link(VS_BUILDING, FS_BUILDING);
    const pClearWall = link(VS_CLEAR_WALL, FS_CLEAR_WALL);

    const pShadowBake = link(VS_TRI, FS_SHADOW_BAKE);
    verifyPrograms();
    gl.useProgram(pShadowBake.p);
    gl.uniform1i(pShadowBake.u('uDemInnerTex'), 0);
    gl.uniform1i(pShadowBake.u('uDemMidTex'), 1);
    gl.uniform1i(pShadowBake.u('uDemOuterTex'), 2);
    gl.uniform1i(pShadowBake.u('uCanopyNearTex'), 3);
    gl.uniform1i(pShadowBake.u('uCanopyFarTex'), 4);

    [pTerr, pCanopy, pBld].forEach(prog => {
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u('uShadowTex0'), 8);
      gl.uniform1i(prog.u('uShadowTex1'), 9);
      gl.uniform1i(prog.u('uShadowTex2'), 10);
    });

    const floatLinExt = gl.getExtension('OES_texture_float_linear');
    const SHADOW_SZ = PERF.shadowSize; // 768 на ПК и обычных телефонах, 512 на слабых
    const SHADOW_CASCS = [3300, 12000, 45000];
    let shadowInitDone = false;
    let demInTex = null, demMidTex = null, demOutTex = null, canNearTex = null, canFarTex = null;
    let shadowFbos = null, shadowTexs = null;
    let shUploadedDemSig = null, shUploadedCanSig = null;
    let shHasInner = 0, shHasMid = 0, shHasOuter = 0, shH0 = 0, shHMaxRel = 100;
    let shNearHalf = 0, shFarHalf = 0, shNearN = 1, shFarN = 1;
    let lastBakeKey = '', lastBakeLightDir = null;
    let bakeMask = 0; // какие каскады ещё нужно перерисовать (бит i = каскад i)

    function mkTex2D(filter) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    function ensureShadowGpu() {
      if (shadowInitDone) return;
      shadowInitDone = true;
      const demFilter = floatLinExt ? gl.LINEAR : gl.NEAREST;
      demInTex   = mkTex2D(demFilter);
      demMidTex  = mkTex2D(demFilter);
      demOutTex  = mkTex2D(demFilter);
      canNearTex = mkTex2D(gl.LINEAR);
      canFarTex  = mkTex2D(gl.LINEAR);

      // 1x1 заглушки для гарантии полноты всех сэмплеров
      const zeroF = new Float32Array([0]);
      const zeroB = new Uint8Array([0]);
      [demInTex, demMidTex, demOutTex].forEach(t => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, zeroF);
      });
      [canNearTex, canFarTex].forEach(t => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, zeroB);
      });

      shadowTexs = [];
      shadowFbos = [];
      for (let i = 0; i < 3; i++) {
        const st = mkTex2D(gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, st);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SHADOW_SZ, SHADOW_SZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, st, 0);
        shadowTexs.push(st);
        shadowFbos.push(fb);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let pendingSceneForShadow = null;
    function syncShadowInputTextures(S) {
      if (!S) return;
      ensureShadowGpu();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      if (shUploadedDemSig !== S.demSig && S.outerH) {
        shUploadedDemSig = S.demSig;
        shH0 = S.h0 || 0;
        shHMaxRel = Math.max(20, (S.hMax || 0) - shH0);
        shHasInner = S.innerH ? 1 : 0;
        shHasMid   = S.midH   ? 1 : 0;
        shHasOuter = S.outerH ? 1 : 0;
        if (S.innerH) {
          gl.bindTexture(gl.TEXTURE_2D, demInTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, INNER_N, INNER_N, 0, gl.RED, gl.FLOAT, S.innerH);
        }
        if (S.midH) {
          gl.bindTexture(gl.TEXTURE_2D, demMidTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, MID_N, MID_N, 0, gl.RED, gl.FLOAT, S.midH);
        }
        if (S.outerH) {
          gl.bindTexture(gl.TEXTURE_2D, demOutTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, OUTER_N, OUTER_N, 0, gl.RED, gl.FLOAT, S.outerH);
        }
        lastBakeKey = '';
      }

      if (shUploadedCanSig !== S.canopyBaseSig) {
        shUploadedCanSig = S.canopyBaseSig;
        if (S.canopyNearRaw && S.canopyNearRaw.grid) {
          shNearN = S.canopyNearRaw.box.Nx;
          shNearHalf = S.canopyNearRaw.halfM || CANOPY_HALF;
          gl.bindTexture(gl.TEXTURE_2D, canNearTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, shNearN, S.canopyNearRaw.box.Ny, 0, gl.RED, gl.UNSIGNED_BYTE, S.canopyNearRaw.grid);
        } else {
          shNearHalf = 0; shNearN = 1;
        }
        if (S.canopyFarRaw && S.canopyFarRaw.grid) {
          shFarN = S.canopyFarRaw.box.Nx;
          shFarHalf = S.canopyFarRaw.halfM || CANOPY_FAR_HALF;
          gl.bindTexture(gl.TEXTURE_2D, canFarTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, shFarN, S.canopyFarRaw.box.Ny, 0, gl.RED, gl.UNSIGNED_BYTE, S.canopyFarRaw.grid);
        } else {
          shFarHalf = 0; shFarN = 1;
        }
        lastBakeKey = '';
      }
    }

    function bakeShadowsIfNeeded(o) {
      if (!o.castTerrainShadows && !o.castForestShadows) { R.bakeBusy = false; bakeMask = 0; return false; }
      if (pendingSceneForShadow) {
        if (shUploadedDemSig !== pendingSceneForShadow.demSig || shUploadedCanSig !== pendingSceneForShadow.canopyBaseSig) {
          syncShadowInputTextures(pendingSceneForShadow);
        }
      }
      if (!shadowInitDone || !shHasOuter) { R.bakeBusy = false; return false; }

      const ld = o.lightDir;
      const treeMinH = o.shadowTreeMinH || 2.2;
      const treeScale = o.shadowTreeScale || 1.0;
      const curStateKey = `${shUploadedDemSig}|${shUploadedCanSig}|${o.zScale.toFixed(2)}|${o.curv ? 1 : 0}|${o.castTerrainShadows ? 1 : 0}|${o.castForestShadows ? 1 : 0}|${treeMinH.toFixed(1)}|${treeScale.toFixed(2)}`;
      const dirMoved = !lastBakeLightDir ||
        (ld[0] * lastBakeLightDir[0] + ld[1] * lastBakeLightDir[1] + ld[2] * lastBakeLightDir[2]) < 0.999993; // ~0.21°

      if (curStateKey !== lastBakeKey || dirMoved) {
        lastBakeKey = curStateKey;
        lastBakeLightDir = [ld[0], ld[1], ld[2]];
        bakeMask = 7;
      }
      if (!bakeMask) { R.bakeBusy = false; return true; }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, demInTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, demMidTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, demOutTex);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, canNearTex);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, canFarTex);

      gl.useProgram(pShadowBake.p);
      gl.uniform4f(pShadowBake.u('uDemFlags'), shHasInner, shHasMid, shHasOuter, shHMaxRel * o.zScale);
      gl.uniform4f(pShadowBake.u('uDemGridN'), INNER_N, MID_N, OUTER_N, floatLinExt ? 1.0 : 0.0);
      gl.uniform4f(pShadowBake.u('uCanopyMeta'), shNearHalf, shFarHalf, treeMinH, treeScale);
      gl.uniform4f(pShadowBake.u('uCanopyGridN'), shNearN, shFarN, lerp(1.0, o.zScale, 0.35), o.zScale);
      gl.uniform4f(pShadowBake.u('uLightBake'), ld[0], ld[1], ld[2], o.curv ? 1.0 : 0.0);

      gl.bindVertexArray(emptyVao);
      gl.viewport(0, 0, SHADOW_SZ, SHADOW_SZ);

      // ПК: все три каскада за один кадр, как раньше. Телефоны: по одному каскаду на кадр, чтобы один
      // тяжёлый проход не упирался в таймаут GPU (на слабых чипах именно он роняет контекст).
      const perCall = PERF.tier >= 2 ? 3 : 1;
      let baked = 0;
      for (let i = 0; i < 3 && baked < perCall; i++) {
        if (!(bakeMask & (1 << i))) continue;
        const cHalf = SHADOW_CASCS[i];
        const cellM = (2 * cHalf) / SHADOW_SZ;
        const needForest = (o.castForestShadows && i < 2) ? 1.0 : 0.0;
        const needTerr = (o.castTerrainShadows || o.castForestShadows) ? 1.0 : 0.0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbos[i]);
        gl.uniform4f(pShadowBake.u('uBakeBox'), cHalf, INNER_HALF, MID_HALF, OUTER_HALF);
        gl.uniform4f(pShadowBake.u('uBakeOpt'), needTerr, needForest, shH0, cellM);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        frameDraws++;
        bakeMask &= ~(1 << i);
        baked++;
      }
      R.bakeBusy = bakeMask !== 0;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      return true;
    }

    gl.useProgram(pTerr.p); gl.uniform1i(pTerr.u('uVecTex'), 0);
    gl.uniform1i(pTerr.u('uZoomNrmTex'), 7);
    gl.useProgram(pComp.p);
    gl.uniform1i(pComp.u('uColorTex'), 1);
    gl.uniform1i(pComp.u('uDepthTex'), 2);
    gl.uniform1i(pComp.u('uCanopyColorTex'), 3);
    gl.uniform1i(pComp.u('uCanopyDepthTex'), 4);
    gl.uniform1i(pComp.u('uClearColorTex'), 5);
    gl.uniform1i(pComp.u('uClearDepthTex'), 6);



    const emptyVao = gl.createVertexArray();
    const mkMeshBufs = () => {
      const vao = gl.createVertexArray(), vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bindVertexArray(null);
      return { vao, vbo, ibo, count: 0, chunks: null };
    };
    const innerB = mkMeshBufs(), midB = mkMeshBufs(), outerB = mkMeshBufs(), zoomB = mkMeshBufs();

    const zoomNrmTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, zoomNrmTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 255, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    function buildCrownClusterMesh() {
      const unitV = [
        [0, 1, 0], [0, -1, 0],
        [1, 0, 0], [0, 0, -1], [-1, 0, 0], [0, 0, 1]
      ];
      let faces = [
        [5, 2, 0], [2, 3, 0], [3, 4, 0], [4, 5, 0],
        [2, 5, 1], [3, 2, 1], [4, 3, 1], [5, 4, 1]
      ];

      // 2 подразделения октаэдра -> 128 ровных треугольников, 66 вершин
      for (let sub = 0; sub < 1; sub++) { // было sub < 2
        const midCache = new Map();
        const getMid = (a, b) => {
          const k = a < b ? `${a}_${b}` : `${b}_${a}`;
          if (midCache.has(k)) return midCache.get(k);
          const va = unitV[a], vb = unitV[b];
          let x = va[0] + vb[0], y = va[1] + vb[1], z = va[2] + vb[2];
          const l = Math.hypot(x, y, z) || 1;
          const idx = unitV.length;
          unitV.push([x / l, y / l, z / l]);
          midCache.set(k, idx);
          return idx;
        };
        const nextFaces = [];
        for (const [a, b, c] of faces) {
          const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
          nextFaces.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
        }
        faces = nextFaces;
      }

      // Мягкая органическая форма «облачка» кроны без острых углов
      const pos = unitV.map(([nx, ny, nz]) => {
        const ang = Math.atan2(nz, nx);
        const lobe = 1.0 + 0.08 * (1.0 - ny * ny) * Math.sin(3.0 * ang)
                         + 0.04 * (1.0 - ny * ny) * Math.cos(2.0 * ang + ny * 1.5);
        const py = ny * (1.10 - 0.10 * ny * ny); // чуть более пышные плечи
        return [nx * lobe, py, nz * lobe];
      });

      // Считаем гладкие усреднённые нормали по граням
      const accN = pos.map(() => [0, 0, 0]);
      for (const [a, b, c] of faces) {
        const pa = pos[a], pb = pos[b], pc = pos[c];
        const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
        const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
        const fnx = uy * vz - uz * vy;
        const fny = uz * vx - ux * vz;
        const fnz = ux * vy - uy * vx;
        for (const idx of [a, b, c]) {
          accN[idx][0] += fnx; accN[idx][1] += fny; accN[idx][2] += fnz;
        }
      }

      const verts = [];
      for (let i = 0; i < pos.length; i++) {
        const p = pos[i], n = accN[i];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        verts.push(p[0], p[1], p[2], n[0] / l, n[1] / l, n[2] / l);
      }
      const indices = [];
      for (const [a, b, c] of faces) indices.push(a, b, c);
      return { verts: new Float32Array(verts), idx: new Uint16Array(indices) };
    }

    const bldVao = gl.createVertexArray();
    const bldVbo = gl.createBuffer();
    let bldCount = 0;
    gl.bindVertexArray(bldVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, bldVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 44, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 44, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 44, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 44, 32);
    gl.bindVertexArray(null);

    const canopySurfVao = gl.createVertexArray();
    const canopySurfVbo = gl.createBuffer();
    const canopySurfIbo = gl.createBuffer();
    const canopySurfFarVao = gl.createVertexArray();
    const canopySurfFarVbo = gl.createBuffer();
    const canopySurfFarIbo = gl.createBuffer();
    let canopySurfFarCount = 0;
    let canopySurfFarChunks = null;
    let canopyFarHalf = CANOPY_FAR_HALF;
    gl.bindVertexArray(canopySurfFarVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopySurfFarVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopySurfFarIbo);
    gl.bindVertexArray(null);
    let canopySurfCount = 0;
    let canopySurfChunks = null;
    gl.bindVertexArray(canopySurfVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopySurfVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopySurfIbo);
    gl.bindVertexArray(null);

    const CLEAR_SEG = 96;
    const CLEAR_ROWS = 6;
    const clearWallVerts = new Float32Array((CLEAR_SEG + 1) * CLEAR_ROWS * 6);
    const clearWallIdx = new Uint16Array(CLEAR_SEG * (CLEAR_ROWS - 1) * 6);
    let cwPtr = 0;
    for (let i = 0; i < CLEAR_SEG; i++) {
      for (let k = 0; k < CLEAR_ROWS - 1; k++) {
        const a = i * CLEAR_ROWS + k, b = (i + 1) * CLEAR_ROWS + k;
        const c = a + 1, d = b + 1;
        clearWallIdx[cwPtr++] = a; clearWallIdx[cwPtr++] = c; clearWallIdx[cwPtr++] = b;
        clearWallIdx[cwPtr++] = b; clearWallIdx[cwPtr++] = c; clearWallIdx[cwPtr++] = d;
      }
    }
    let wallLastX = NaN, wallLastZ = NaN, wallLastZScale = NaN, wallLastVer = '';
    const clearWallVao = gl.createVertexArray();
    const clearWallVbo = gl.createBuffer();
    const clearWallIbo = gl.createBuffer();
    gl.bindVertexArray(clearWallVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, clearWallVbo);
    gl.bufferData(gl.ARRAY_BUFFER, clearWallVerts.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, clearWallIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, clearWallIdx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const crownMesh = buildCrownClusterMesh();
    const canopyVao = gl.createVertexArray();
    const canopyMeshVbo = gl.createBuffer();
    const canopyMeshIbo = gl.createBuffer();
    const canopyInstVbo = gl.createBuffer();
    const canopyMeshIdxCount = crownMesh.idx.length;

    gl.bindVertexArray(canopyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopyMeshVbo);
    gl.bufferData(gl.ARRAY_BUFFER, crownMesh.verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopyMeshIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, crownMesh.idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopyInstVbo);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    const canopyFarVao = gl.createVertexArray();
    const canopyFarInstVbo = gl.createBuffer();
    gl.bindVertexArray(canopyFarVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopyMeshVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopyMeshIbo);
    gl.bindBuffer(gl.ARRAY_BUFFER, canopyFarInstVbo);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    let canopyFarCount = 0;
    let canopyFarChunks = null;
    let canopyCount = 0;
    let canopyChunks = null;


    // Деревья: инстансированный биллборд (4 вершины triangle_strip)
    const treeVao = gl.createVertexArray(), treeQuadVbo = gl.createBuffer(), treeInstVbo = gl.createBuffer();
    gl.bindVertexArray(treeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, treeQuadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, treeInstVbo);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    let treeCount = 0;

    // Текстура дорог/рек
    const vecTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, vecTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Offscreen render targets (цвет + глубина). Выделение проверяется на полноту и ошибки памяти:
    // при нехватке видеопамяти разрешение рендера само уменьшается, а не рвёт контекст.
    let usedCanopyRT = false, usedClearRT = false;
    const rtTexParams = () => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    function allocRT(w, h) {
      let guard = 0;
      while (gl.getError() !== gl.NO_ERROR && guard++ < 8) { /* сбросить старые ошибки */ }
      const color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      rtTexParams();
      const depth = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depth);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      rtTexParams();
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      const err = gl.getError();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const ok = st === gl.FRAMEBUFFER_COMPLETE && err === gl.NO_ERROR;
      if (!ok) { gl.deleteFramebuffer(fb); gl.deleteTexture(color); gl.deleteTexture(depth); }
      return { fbo: ok ? fb : null, color: ok ? color : null, depth: ok ? depth : null, ok };
    }

    let fbo = null, colorTex = null, depthTex = null, fboW = 0, fboH = 0;
    function freeMainRT() {
      if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteTexture(depthTex); }
      fbo = colorTex = depthTex = null; fboW = fboH = 0;
    }
    function ensureFbo(w, h) {
      if (fbo && fboW === w && fboH === h) return true;
      freeMainRT();
      const rt = allocRT(w, h);
      if (!rt.ok) return false;
      fbo = rt.fbo; colorTex = rt.color; depthTex = rt.depth; fboW = w; fboH = h;
      return true;
    }

    let clearFbo = null, clearColorTex = null, clearDepthTex = null, clrFboW = 0, clrFboH = 0;
    function freeClearRT() {
      if (clearFbo) { gl.deleteFramebuffer(clearFbo); gl.deleteTexture(clearColorTex); gl.deleteTexture(clearDepthTex); }
      clearFbo = clearColorTex = clearDepthTex = null; clrFboW = clrFboH = 0;
    }
    function ensureClearFbo(w, h) {
      if (clearFbo && clrFboW === w && clrFboH === h) return true;
      freeClearRT();
      const rt = allocRT(w, h);
      if (!rt.ok) { R.needRedraw = true; scaleLimit = Math.max(0.35, scaleLimit * 0.75); PERF.degrade('rt-clear'); return false; }
      clearFbo = rt.fbo; clearColorTex = rt.color; clearDepthTex = rt.depth; clrFboW = w; clrFboH = h;
      return true;
    }

    let canopyFbo = null, canopyColorTex = null, canopyDepthTex = null, cFboW = 0, cFboH = 0;
    function freeCanopyRT() {
      if (canopyFbo) { gl.deleteFramebuffer(canopyFbo); gl.deleteTexture(canopyColorTex); gl.deleteTexture(canopyDepthTex); }
      canopyFbo = canopyColorTex = canopyDepthTex = null; cFboW = cFboH = 0;
    }
    function ensureCanopyFbo(w, h) {
      if (canopyFbo && cFboW === w && cFboH === h) return true;
      freeCanopyRT();
      const rt = allocRT(w, h);
      if (!rt.ok) { R.needRedraw = true; scaleLimit = Math.max(0.35, scaleLimit * 0.75); PERF.degrade('rt-canopy'); return false; }
      canopyFbo = rt.fbo; canopyColorTex = rt.color; canopyDepthTex = rt.depth; cFboW = w; cFboH = h;
      return true;
    }

    let uploadedDemSig = null;
    let uploadedBldSig = null;
    let uploadedVecSig = null;
    let uploadedCanopyMassSig = null;
    let uploadedCanopyTreesSig = null;

    R.uploadScene = (S) => {
      if (!S || R.lost) return;
      pendingSceneForShadow = S;
      const put = (b, m) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, m.verts, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
        b.count = m.count;
        b.chunks = m.chunks || null;
      };

      // 1. Меши рельефа (inner / mid / outer)
      if (uploadedDemSig !== S.demSig) {
        uploadedDemSig = S.demSig;
        put(innerB, S.innerMesh); R.hasInner = innerB.count > 0;
        if (S.midMesh) {
          put(midB, S.midMesh); R.hasMid = midB.count > 0;
        } else {
          midB.count = 0; midB.chunks = null; R.hasMid = false;
        }
        put(outerB, S.outerMesh); R.hasOuter = outerB.count > 0;
      }

      // 2. Режим 'trees' (поверхность крон + 2D-биллборды деревьев)
      const treesSig = S.canopyTreesSig || 'none';
      if (uploadedCanopyTreesSig !== treesSig) {
        uploadedCanopyTreesSig = treesSig;
        if (S.canopySurfMesh && S.canopySurfMesh.count > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, canopySurfVbo);
          gl.bufferData(gl.ARRAY_BUFFER, S.canopySurfMesh.verts, gl.STATIC_DRAW);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopySurfIbo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, S.canopySurfMesh.idx, gl.STATIC_DRAW);
          canopySurfCount = S.canopySurfMesh.count;
          canopySurfChunks = S.canopySurfMesh.chunks || null;
          R.hasCanopySurf = true;
        } else {
          canopySurfCount = 0;
          canopySurfChunks = null;
          R.hasCanopySurf = false;
        }

        if (S.canopyFarSurfMesh && S.canopyFarSurfMesh.count > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, canopySurfFarVbo);
          gl.bufferData(gl.ARRAY_BUFFER, S.canopyFarSurfMesh.verts, gl.STATIC_DRAW);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, canopySurfFarIbo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, S.canopyFarSurfMesh.idx, gl.STATIC_DRAW);
          canopySurfFarCount = S.canopyFarSurfMesh.count;
          canopySurfFarChunks = S.canopyFarSurfMesh.chunks || null;
          canopyFarHalf = S.canopyFarHalf || CANOPY_FAR_HALF;
          R.hasCanopySurfFar = true;
        } else {
          canopySurfFarCount = 0;
          canopySurfFarChunks = null;
          canopyFarHalf = CANOPY_FAR_HALF;
          R.hasCanopySurfFar = false;
        }

        if (S.treeData && S.treeCount > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, treeInstVbo);
          gl.bufferData(gl.ARRAY_BUFFER, S.treeData, gl.STATIC_DRAW);
          treeCount = S.treeCount; R.hasTrees = true;
        } else {
          treeCount = 0; R.hasTrees = false;
        }
      }

      // 3. 3D-постройки OSM
      if (uploadedBldSig !== S.bldSig) {
        uploadedBldSig = S.bldSig;
        if (S.buildingMesh && S.buildingMesh.count > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, bldVbo);
          gl.bufferData(gl.ARRAY_BUFFER, S.buildingMesh.data, gl.STATIC_DRAW);
          bldCount = S.buildingMesh.count;
          R.hasBuildings = true;
        } else {
          bldCount = 0;
          R.hasBuildings = false;
        }
      }

      // 4. Режим 'mass' (3D-кластеры крон)
      const massSig = S.canopyMassSig || 'none';
      if (uploadedCanopyMassSig !== massSig) {
        uploadedCanopyMassSig = massSig;
        R.updateCanopy(S);
      }

      // 5. Растеризованные дороги и реки
      if (uploadedVecSig !== S.vecSig) {
        uploadedVecSig = S.vecSig;
        gl.bindTexture(gl.TEXTURE_2D, vecTex);
        if (S.vecCanvas) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, S.vecCanvas);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };

    R.updateVecTexture = (vecCanvas) => {
      if (R.lost) return;
      uploadedVecSig = null;
      gl.bindTexture(gl.TEXTURE_2D, vecTex);
      if (vecCanvas) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, vecCanvas);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      }
    };

    R.updateCanopy = (S) => {
      if (R.lost) return;
      uploadedCanopyMassSig = S.canopyMassSig || uploadedCanopyMassSig;
      if (S.canopyData && S.canopyCount > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, canopyInstVbo);
        gl.bufferData(gl.ARRAY_BUFFER, S.canopyData, gl.STATIC_DRAW);
        canopyCount = S.canopyCount;
        canopyChunks = S.canopyChunks || null;
        R.hasCanopy = true;
      } else {
        canopyCount = 0;
        canopyChunks = null;
        R.hasCanopy = false;
      }
      if (S.canopyFarData && S.canopyFarCount > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, canopyFarInstVbo);
        gl.bufferData(gl.ARRAY_BUFFER, S.canopyFarData, gl.STATIC_DRAW);
        canopyFarCount = S.canopyFarCount;
        canopyFarChunks = S.canopyFarChunks || null;
        R.hasCanopyFar = true;
      } else {
        canopyFarCount = 0;
        canopyFarChunks = null;
        R.hasCanopyFar = false;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };

    // <-- ВСТАВИТЬ СЮДА:
    R.uploadZoomPatch = (patch) => {
      if (R.lost || !patch || !patch.mesh) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, zoomB.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, patch.mesh.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, zoomB.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, patch.mesh.idx, gl.STATIC_DRAW);
      zoomB.count = patch.mesh.count;
      zoomB.chunks = patch.mesh.chunks || null;

      gl.bindTexture(gl.TEXTURE_2D, zoomNrmTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, patch.Nx, patch.Ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, patch.nrmData);

      R.hasZoom = zoomB.count > 0;
      R.zoomBox = { cx: patch.cx, cz: patch.cz, halfM: patch.halfM };
    };

    R.clearZoomPatch = () => {
      zoomB.count = 0; zoomB.chunks = null;
      R.hasZoom = false; R.zoomBox = null;
    };

    const fPlanes = new Float32Array(20); // Left, Right, Bottom, Top, Near

    let frameDraws = 0;

    function extractFrustum5(m, out) {
      out[0]  = m[3] + m[0]; out[1]  = m[7] + m[4]; out[2]  = m[11] + m[8];  out[3]  = m[15] + m[12];
      out[4]  = m[3] - m[0]; out[5]  = m[7] - m[4]; out[6]  = m[11] - m[8];  out[7]  = m[15] - m[12];
      out[8]  = m[3] + m[1]; out[9]  = m[7] + m[5]; out[10] = m[11] + m[9];  out[11] = m[15] + m[13];
      out[12] = m[3] - m[1]; out[13] = m[7] - m[5]; out[14] = m[11] - m[9];  out[15] = m[15] - m[13];
      out[16] = m[3] + m[2]; out[17] = m[7] + m[6]; out[18] = m[11] + m[10]; out[19] = m[15] + m[14];
    }

    function chunkVisible(ch, camX, camZ, zScale, curv, extraYTop) {
      const dxMax = Math.max(Math.abs(camX - ch.x0), Math.abs(camX - ch.x1));
      const dzMax = Math.max(Math.abs(camZ - ch.z0), Math.abs(camZ - ch.z1));
      const maxDrop = curv ? (dxMax * dxMax + dzMax * dzMax) / 14646000.0 + 2.0 : 0.0;
      const y0 = ch.y0 * zScale - maxDrop;
      const y1 = ch.y1 * zScale + extraYTop;

      for (let i = 0; i < 20; i += 4) {
        const a = fPlanes[i], b = fPlanes[i + 1], c = fPlanes[i + 2], d = fPlanes[i + 3];
        const px = a >= 0 ? ch.x1 : ch.x0;
        const py = b >= 0 ? y1 : y0;
        const pz = c >= 0 ? ch.z1 : ch.z0;
        if (a * px + b * py + c * pz + d < 0) return false;
      }
      return true;
    }

    function drawChunked(b, camX, camZ, zScale, curv, extraYTop) {
      gl.bindVertexArray(b.vao);
      if (!b.chunks || !b.chunks.length) {
        gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
        frameDraws++;
        return b.count / 3;
      }
      let tris = 0;
      for (let i = 0; i < b.chunks.length; i++) {
        const ch = b.chunks[i];
        if (!chunkVisible(ch, camX, camZ, zScale, curv, extraYTop)) continue;
        gl.drawElements(gl.TRIANGLES, ch.count, gl.UNSIGNED_INT, ch.byteOffset);
        frameDraws++;
        tris += ch.count / 3;
      }
      return tris;
    }

    R.render = (o) => {
      if (R.lost) return;
      const tGl0 = performance.now();
      frameDraws = 0;
      let terrTris = 0, bldTris = 0, canopyTris = 0, treeTris = 0;

      if (o.wantGpuTimer && !gpuExt) gpuExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
      // Считываем готовые асинхронные замеры GPU без блокировки конвейера
      if (gpuExt && gpuQueries.length) {
        let disjoint = null;
        while (gpuQueries.length) {
          const q = gpuQueries[0];
          if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          if (disjoint === null) disjoint = gl.getParameter(gpuExt.GPU_DISJOINT_EXT);
          gpuQueries.shift();
          if (!disjoint) {
            lastGpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          }
          gl.deleteQuery(q);
        }
      }
      let activeGpuQ = null;
      if (o.wantGpuTimer && gpuExt && gpuQueries.length < 4) {
        activeGpuQ = gl.createQuery();
        gl.beginQuery(gpuExt.TIME_ELAPSED_EXT, activeGpuQ);
      }

      extractFrustum5(o.vp, fPlanes);

      const shadowsReady = bakeShadowsIfNeeded(o);
      const shOptX = (shadowsReady && o.castTerrainShadows) ? 1.0 : 0.0;
      const shOptY = (shadowsReady && o.castForestShadows) ? 1.0 : 0.0;
      const sunUp  = shadowsReady ? smooth(-0.5, 3.5, o.sunAltDeg) : 0.0;
      if (shadowsReady) {
        gl.activeTexture(gl.TEXTURE8);  gl.bindTexture(gl.TEXTURE_2D, shadowTexs[0]);
        gl.activeTexture(gl.TEXTURE9);  gl.bindTexture(gl.TEXTURE_2D, shadowTexs[1]);
        gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, shadowTexs[2]);
      }


      const dv = (o.mode === 0 || o.mode === 4) ? CANOPY_CONTOUR_TOPO : CANOPY_SHADED_MODES;
      const dvFar = (o.mode === 0 || o.mode === 4) ? CANOPY_FAR_CONTOUR_TOPO : CANOPY_FAR_SHADED_MODES;

      let w = o.w, h = o.h;
      { // Бюджет пикселей: тир устройства, лимит текстур, ранее пойманная нехватка видеопамяти
        let k = Math.min(1, scaleLimit);
        if (w * h * k * k > PERF.maxPixels) k = Math.sqrt(PERF.maxPixels / (w * h));
        const maxDim = Math.min(maxTexSize, 8192);
        if (Math.max(w, h) * k > maxDim) k = maxDim / Math.max(w, h);
        if (k < 1) { w = Math.max(2, Math.floor(w * k)); h = Math.max(2, Math.floor(h * k)); }
      }
      let rtTries = 0;
      while (!ensureFbo(w, h) && rtTries++ < 4) {
        scaleLimit = Math.max(0.35, scaleLimit * 0.75);
        w = Math.max(2, Math.floor(w * 0.75));
        h = Math.max(2, Math.floor(h * 0.75));
        R.needRedraw = true;
        PERF.degrade('rt-alloc');
      }
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      // PASS 1: Геометрия в FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vecTex);

      gl.useProgram(pTerr.p);
      gl.uniformMatrix4fv(pTerr.u('uVP'), false, o.vp);
      gl.uniform4f(pTerr.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
      gl.uniform1f(pTerr.u('uZScale'), o.zScale);
      gl.uniform1f(pTerr.u('uCurv'), o.curv ? 1.0 : 0.0);
      gl.uniform4f(pTerr.u('uLightDir'), o.lightDir[0], o.lightDir[1], o.lightDir[2], o.lightInt);
      gl.uniform4f(pTerr.u('uSunCol'), o.lcol[0], o.lcol[1], o.lcol[2], o.night);

      gl.uniform4f(pTerr.u('uShadowOpt'), shOptX, shOptY, sunUp, 0.0);
      gl.uniform3f(pTerr.u('uSunDirOnly'), o.sunDir[0], o.sunDir[1], o.sunDir[2]);

      gl.uniform4f(pTerr.u('uSkyHor'), o.skyHor[0], o.skyHor[1], o.skyHor[2], 1.0);
      gl.uniform4f(pTerr.u('uMode'), o.mode, o.showIso ? 1.0 : 0.0, o.isoStep, o.h0);
      gl.uniform4f(pTerr.u('uRange'), o.fogDist, o.hMin, o.hMax, o.dark ? 1.0 : 0.0);
      gl.uniform4f(pTerr.u('uVecOpt'), VEC_HALF, o.showPavedRoads ? 1.0 : 0.0, o.showRivers ? 1.0 : 0.0, o.showTrailRoads ? 1.0 : 0.0);
      const rpD = o.roadPavedDay, rpN = o.roadPavedNight;
      const rtD = o.roadTrailDay, rtN = o.roadTrailNight;
      gl.uniform3f(pTerr.u('uRoadPavedDay'),   rpD[0], rpD[1], rpD[2]);
      gl.uniform3f(pTerr.u('uRoadPavedNight'), rpN[0], rpN[1], rpN[2]);
      gl.uniform3f(pTerr.u('uRoadTrailDay'),   rtD[0], rtD[1], rtD[2]);
      gl.uniform3f(pTerr.u('uRoadTrailNight'), rtN[0], rtN[1], rtN[2]);

      const tr = DEV_TERRAIN.relief, tc = DEV_TERRAIN.contours;
      gl.uniform4f(pTerr.u('uTerrDet1'), tr.enabled ? 1.0 : 0.0, tr.bumpStrength, tr.macroScale, tr.microScale);
      gl.uniform4f(pTerr.u('uTerrDet2'), tr.cragStrength, tr.strataStrength, tr.strataFreq, tr.cavityAO);
      gl.uniform4f(pTerr.u('uTerrDet3'), tr.detailDist, tr.macroDist, tr.swissBoost, tr.albedoRough);
      gl.uniform4f(pTerr.u('uTerrDet4'), (o.smartFog && o.smartFog.enabled) ? 1.0 : 0.0, tr.slopeDetail, tr.hypsoWarp, 0.0);
      gl.uniform4f(pTerr.u('uTerrCnt1'), tc.isoWarpAmp, tc.microContourStr, tc.microContourFreq, tc.isoOpacity);


     const useZoom = !!(R.hasZoom && o.zoomActive && R.zoomBox);
      gl.uniform4f(
        pTerr.u('uZoomBox'),
        useZoom ? R.zoomBox.cx : 0,
        useZoom ? R.zoomBox.cz : 0,
        useZoom ? R.zoomBox.halfM : 1,
        useZoom ? 1.0 : 0.0
      );
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, zoomNrmTex);

      if (useZoom) {
        gl.uniform1f(pTerr.u('uSkipZoom'), 0.0);
        terrTris += drawChunked(zoomB, o.cam[0], o.cam[2], o.zScale, o.curv, 0.0);
      }

      gl.uniform1f(pTerr.u('uSkipZoom'), 1.0);
      if (R.hasInner) {
        if (useZoom) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 1.0); }
        terrTris += drawChunked(innerB, o.cam[0], o.cam[2], o.zScale, o.curv, 0.0);
        if (useZoom) gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      if (R.hasMid) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.0, 1.0);
        terrTris += drawChunked(midB, o.cam[0], o.cam[2], o.zScale, o.curv, 0.0);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      if (R.hasOuter) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2.0, 2.0);
        terrTris += drawChunked(outerB, o.cam[0], o.cam[2], o.zScale, o.curv, 0.0);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }

      if (o.showTrees && !o.canopyMassMode && R.hasTrees && treeCount > 0) {
        gl.useProgram(pTree.p);
        gl.uniformMatrix4fv(pTree.u('uVP'), false, o.vp);
        gl.uniform4f(pTree.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
        gl.uniform2f(pTree.u('uCamFwd'), o.camFwd[0], o.camFwd[1]);
        gl.uniform1f(pTree.u('uZScale'), o.zScale);
        gl.uniform1f(pTree.u('uCurv'), o.curv ? 1.0 : 0.0);
        gl.uniform3f(pTree.u('uCanopyHole'), o.cam[0], o.cam[2], o.inForest ? CANOPY_HOLE_R : 0.0);
        gl.uniform4f(pTree.u('uMode'), o.mode, (o.smartFog && o.smartFog.enabled) ? 1.0 : 0.0, 0, 0);
        gl.uniform4f(pTree.u('uRange'), o.fogDist, o.hMin, o.hMax, o.dark ? 1.0 : 0.0);
        gl.uniform4f(pTree.u('uSkyHor'), o.skyHor[0], o.skyHor[1], o.skyHor[2], 1.0);
        gl.uniform4f(pTree.u('uLightDir'), o.lightDir[0], o.lightDir[1], o.lightDir[2], o.lightInt);
        gl.bindVertexArray(treeVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, treeCount);
        frameDraws++;
        treeTris += treeCount * 2;
      }

      if (o.showBuildings && R.hasBuildings && bldCount > 0) {
        gl.useProgram(pBld.p);
        gl.uniformMatrix4fv(pBld.u('uVP'), false, o.vp);
        gl.uniform4f(pBld.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
        gl.uniform1f(pBld.u('uZScale'), o.zScale);
        gl.uniform1f(pBld.u('uCurv'), o.curv ? 1.0 : 0.0);
        gl.uniform1f(pBld.u('uBldScale'), o.bldHeightScale || 1.0);
        gl.uniform1f(pBld.u('uBldFloorHeight'), 3.3 * (o.bldHeightScale || 1.0));
        gl.uniform4f(pBld.u('uLightDir'), o.lightDir[0], o.lightDir[1], o.lightDir[2], o.lightInt);
        gl.uniform4f(pBld.u('uSunCol'), o.lcol[0], o.lcol[1], o.lcol[2], o.night);
        gl.uniform4f(pBld.u('uSkyHor'), o.skyHor[0], o.skyHor[1], o.skyHor[2], 1.0);
        gl.uniform4f(pBld.u('uMode'), o.mode, (o.smartFog && o.smartFog.enabled) ? 1.0 : 0.0, 0, 0);
        gl.uniform4f(pBld.u('uRange'), o.fogDist, o.hMin, o.hMax, o.dark ? 1.0 : 0.0);
        gl.uniform4f(pBld.u('uShadowOpt'), shOptX, shOptY, sunUp, 0.0);
        gl.uniform3f(pBld.u('uSunDirOnly'), o.sunDir[0], o.sunDir[1], o.sunDir[2]);
        gl.bindVertexArray(bldVao);
        gl.drawArrays(gl.TRIANGLES, 0, bldCount);
        gl.bindVertexArray(null);
        frameDraws++;
        bldTris += bldCount / 3;
      }

      // PASS 1B: Сплошной волнистый массив леса в отдельный FBO
      const drawCanopyNear = !!(o.showTrees && o.canopyMassMode && R.hasCanopy && canopyCount > 0 && o.canopyOpacity > 0.01);
      const drawCanopyFar = !!(o.showTrees && o.canopyMassMode && R.hasCanopyFar && canopyFarCount > 0 && o.canopyOpacity > 0.01 && DEV_CANOPY_FAR_OPT.enabled !== false);
      const drawCanopyMass = drawCanopyNear || drawCanopyFar;
      const drawCanopySurf = !!(
        o.showTrees &&
        !o.canopyMassMode &&
        ((R.hasCanopySurf && canopySurfCount > 0) || (R.hasCanopySurfFar && canopySurfFarCount > 0)) &&
        (o.treeHeightLines || o.hideOccludedTerrainLines)
      );
      const drawClearWall = !!(drawCanopySurf && o.inForest && o.fillClearWall);

      if (drawCanopyMass) {
        ensureCanopyFbo(w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, canopyFbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);

        gl.useProgram(pCanopy.p);
        gl.uniformMatrix4fv(pCanopy.u('uVP'), false, o.vp);
        gl.uniform4f(pCanopy.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
        gl.uniform1f(pCanopy.u('uZScale'), o.zScale);
        gl.uniform1f(pCanopy.u('uCurv'), o.curv ? 1.0 : 0.0);
        gl.uniform3f(pCanopy.u('uCanopyHole'), o.cam[0], o.cam[2], o.inForest ? CANOPY_HOLE_R : 0.0);
        gl.uniform4f(pCanopy.u('uLightDir'), o.lightDir[0], o.lightDir[1], o.lightDir[2], o.lightInt);
        gl.uniform4f(pCanopy.u('uSunCol'), o.lcol[0], o.lcol[1], o.lcol[2], o.night);
        gl.uniform4f(pCanopy.u('uSkyHor'), o.skyHor[0], o.skyHor[1], o.skyHor[2], 1.0);
        gl.uniform4f(pCanopy.u('uMode'), o.mode, (o.smartFog && o.smartFog.enabled) ? 1.0 : 0.0, 0, 0);
        gl.uniform4f(pCanopy.u('uRange'), o.fogDist, o.hMin, o.hMax, o.dark ? 1.0 : 0.0);

        gl.uniform4f(pCanopy.u('uShadowOpt'), shOptX, shOptY, sunUp, 0.0);
        gl.uniform3f(pCanopy.u('uSunDirOnly'), o.sunDir[0], o.sunDir[1], o.sunDir[2]);

        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        const nearHalf = o.canopyNearHalf || CANOPY_HALF;
        const overlap = Math.max(0, DEV_CANOPY_FAR_ZONES.seamOverlapM || 0);
        const seamStart = Math.max(0, nearHalf - overlap);

        const drawCanopyLayer = (vao, instVbo, chunks, count, layerDv, minH, cScale, wave, isNearLayer) => {
          const cSh = layerDv.colShadow, cBs = layerDv.colBase, cHi = layerDv.colHi;
          gl.uniform4f(pCanopy.u('uCanopyOpt'), o.canopyOpacity, minH, cScale, wave);
          gl.uniform4f(pCanopy.u('uDevForm1'), layerDv.rxScale, layerDv.topFlatten, layerDv.skirtScale, layerDv.waveFreq);
          gl.uniform4f(pCanopy.u('uDevForm2'), layerDv.lobeAmp, layerDv.lobeFreq, layerDv.jitterAmp, layerDv.edgeShrink);
          gl.uniform4f(pCanopy.u('uDevForm3'), layerDv.heightGamma, layerDv.edgeRxShrink, layerDv.gammaRxCouple, 0.0);

          if (isNearLayer) {
            if (drawCanopyFar && overlap > 10) {
              // Дальние включены: ближние плавно нарастают от 1.0 к nearEndRx / nearEndH у границы
              gl.uniform4f(pCanopy.u('uSeam1'), seamStart, nearHalf, 1.0, DEV_CANOPY_FAR_OPT.nearEndRx);
              gl.uniform4f(pCanopy.u('uSeam2'), 1.0, DEV_CANOPY_FAR_OPT.nearEndH, 0.0, 0.0);
            } else {
              // Дальние выключены: ближние мягко затухают на самой внешней кромке
              gl.uniform4f(pCanopy.u('uSeam1'), 0.0, 0.0, 1.0, 1.0);
              gl.uniform4f(pCanopy.u('uSeam2'), 1.0, 1.0, nearHalf, 0.0);
            }
          } else {
            if (drawCanopyNear && overlap > 10) {
              // Ближние включены: дальние в зоне нахлёста растут от farStartRx / farStartH до 1.0
              const farEnd = nearHalf + Math.max(0, DEV_CANOPY_FAR_OPT.farGrowExtraM || 0);
              gl.uniform4f(pCanopy.u('uSeam1'), seamStart, farEnd, DEV_CANOPY_FAR_OPT.farStartRx, 1.0);
              gl.uniform4f(pCanopy.u('uSeam2'), DEV_CANOPY_FAR_OPT.farStartH, 1.0, 0.0, 0.0);
            } else {
              // Ближние выключены: дальние рисуются в обычном масштабе 1.0
              gl.uniform4f(pCanopy.u('uSeam1'), 0.0, 0.0, 1.0, 1.0);
              gl.uniform4f(pCanopy.u('uSeam2'), 1.0, 1.0, 0.0, 0.0);
            }
          }

          gl.uniform4f(pCanopy.u('uDevLight1'), layerDv.ndlWeight, layerDv.litPos, layerDv.litSoft, layerDv.hiPos);
          gl.uniform4f(pCanopy.u('uDevLight2'), layerDv.hiSoft, layerDv.hiStr, layerDv.sunApply, layerDv.ambApply);
          gl.uniform4f(pCanopy.u('uDevShade'), layerDv.brushAmp, layerDv.brushFreq, layerDv.tintAmp, layerDv.aoSide);
          gl.uniform4f(pCanopy.u('uDevCol0'), cSh[0], cSh[1], cSh[2], layerDv.fogStr);
          gl.uniform4f(pCanopy.u('uDevCol1'), cBs[0], cBs[1], cBs[2], layerDv.fogDistScale);
          gl.uniform4f(pCanopy.u('uDevCol2'), cHi[0], cHi[1], cHi[2], layerDv.darkAutoTint ? 1.0 : 0.0);
          gl.uniform4f(pCanopy.u('uDevEdgeA'), layerDv.upMaskMin, layerDv.upMaskMax, layerDv.penBreakAmp, layerDv.penBreakFreq);
          gl.uniform4f(pCanopy.u('uDevMisc'), layerDv.lightAllModes ? 1.0 : 0.0, 0.0, 0.0, 0.0);
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
          if (chunks && chunks.length) {
            for (let i = 0; i < chunks.length; i++) {
              const ch = chunks[i];
              if (!chunkVisible(ch, o.cam[0], o.cam[2], o.zScale, o.curv, 30.0)) continue;
              gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, ch.byteOffset);
              gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 28, ch.byteOffset + 16);
              gl.drawElementsInstanced(gl.TRIANGLES, canopyMeshIdxCount, gl.UNSIGNED_SHORT, 0, ch.count);
              frameDraws++;
              canopyTris += (canopyMeshIdxCount / 3) * ch.count;
            }
          } else {
            gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 0);
            gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 28, 16);
            gl.drawElementsInstanced(gl.TRIANGLES, canopyMeshIdxCount, gl.UNSIGNED_SHORT, 0, count);
            frameDraws++;
            canopyTris += (canopyMeshIdxCount / 3) * count;
          }
        };

        if (drawCanopyNear) {
          drawCanopyLayer(canopyVao, canopyInstVbo, canopyChunks, canopyCount, dv, o.canopyMinH, o.canopyScale, o.canopyWave, true);
        }
        if (drawCanopyFar) {
          const farScale = DEV_CANOPY_FAR_OPT.scale * (o.canopyScale / (DEF.layers.canopyScale || 1.1));
          const farWave  = DEV_CANOPY_FAR_OPT.wave  * (o.canopyWave  / (DEF.layers.canopyWave  || 0.9));
          const farMinH  = Math.max(0.5, o.canopyMinH + (DEV_CANOPY_FAR_OPT.minH - DEV_CANOPY_FAR_OPT_DEF.minH));
          drawCanopyLayer(canopyFarVao, canopyFarInstVbo, canopyFarChunks, canopyFarCount, dvFar, farMinH, farScale, farWave, false);
        }
        gl.disable(gl.CULL_FACE);
      } else if (drawCanopySurf) {
      
        ensureCanopyFbo(w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, canopyFbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);

        // Всегда отсекаем изнанку потолка над камерой, чтобы не перекрывала дальние массивы леса
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        gl.useProgram(pCanopySurf.p);
        gl.uniformMatrix4fv(pCanopySurf.u('uVP'), false, o.vp);
        gl.uniform4f(pCanopySurf.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
        gl.uniform1f(pCanopySurf.u('uZScale'), o.zScale);
        gl.uniform1f(pCanopySurf.u('uCurv'), o.curv ? 1.0 : 0.0);
        gl.uniform2f(pCanopySurf.u('uCanopyBorder'), DEV_CONTOURS.treeLine.borderFadeIn, DEV_CONTOURS.treeLine.borderFadeOut);
        gl.uniform3f(pCanopySurf.u('uCanopyHole'), o.cam[0], o.cam[2], o.inForest ? CANOPY_HOLE_R : 0.0);

  

        const hasFarSurf = R.hasCanopySurfFar && canopySurfFarCount > 0;

        if (R.hasCanopySurf && canopySurfCount > 0) {
          if (hasFarSurf) {
            gl.uniform2f(pCanopySurf.u('uCanopyBorder'), 1e6, 1e6);
          } else {
            gl.uniform2f(pCanopySurf.u('uCanopyBorder'), DEV_CONTOURS.treeLine.borderFadeIn, DEV_CONTOURS.treeLine.borderFadeOut);
          }
          canopyTris += drawChunked(
            { vao: canopySurfVao, count: canopySurfCount, chunks: canopySurfChunks },
            o.cam[0], o.cam[2], o.zScale, o.curv, 25.0
          );
        }

        if (hasFarSurf) {
          gl.uniform2f(pCanopySurf.u('uCanopyBorder'), canopyFarHalf - 160, canopyFarHalf - 10);
          canopyTris += drawChunked(
            { vao: canopySurfFarVao, count: canopySurfFarCount, chunks: canopySurfFarChunks },
            o.cam[0], o.cam[2], o.zScale, o.curv, 25.0
          );
        }
        if (drawClearWall) {
          ensureClearFbo(w, h);
          gl.bindFramebuffer(gl.FRAMEBUFFER, clearFbo);
          gl.viewport(0, 0, w, h);
          gl.clearColor(0, 0, 0, 0);
          gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.disable(gl.CULL_FACE);

          const wallDirty = (
            o.cam[0] !== wallLastX ||
            o.cam[2] !== wallLastZ ||
            o.zScale !== wallLastZScale ||
            o.wallVer !== wallLastVer
          );
          if (wallDirty) {
            o.fillClearWall(clearWallVerts, CLEAR_SEG, CANOPY_HOLE_R);
            gl.bindBuffer(gl.ARRAY_BUFFER, clearWallVbo);
            gl.bufferData(gl.ARRAY_BUFFER, clearWallVerts, gl.DYNAMIC_DRAW);
            wallLastX = o.cam[0];
            wallLastZ = o.cam[2];
            wallLastZScale = o.zScale;
            wallLastVer = o.wallVer;
          }
          gl.useProgram(pClearWall.p);
          gl.uniformMatrix4fv(pClearWall.u('uVP'), false, o.vp);
          gl.uniform4f(pClearWall.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
          gl.uniform1f(pClearWall.u('uCurv'), o.curv ? 1.0 : 0.0);
          gl.bindVertexArray(clearWallVao);
          gl.drawElements(gl.TRIANGLES, clearWallIdx.length, gl.UNSIGNED_SHORT, 0);
          frameDraws++;
          canopyTris += clearWallIdx.length / 3;
        }

        gl.disable(gl.CULL_FACE);
      }

      // PASS 2: Небо + Силуэтные контуры на экран
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(pComp.p);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, depthTex);
      const hasAnyCanopyFbo = (drawCanopyMass || drawCanopySurf) && !!canopyFbo;
      usedCanopyRT = hasAnyCanopyFbo;
      usedClearRT = drawClearWall && !!clearFbo;
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, hasAnyCanopyFbo ? canopyColorTex : colorTex);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, hasAnyCanopyFbo ? canopyDepthTex : depthTex);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, usedClearRT ? clearColorTex : colorTex);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, usedClearRT ? clearDepthTex : depthTex);
      gl.uniformMatrix4fv(pComp.u('uInvVP'), false, o.invVP);
      gl.uniform4f(pComp.u('uCam'), o.cam[0], o.cam[1], o.cam[2], o.time);
      gl.uniform4f(pComp.u('uSunDir'), o.sunDir[0], o.sunDir[1], o.sunDir[2], o.sunAltDeg);
      gl.uniform4f(
        pComp.u('uCanopyOpt'),
        o.canopyOpacity,
        o.inForest ? 1.0 : 0.0,
        o.massTerrainContours ? 1.0 : 0.0,
        drawCanopyMass ? 1.0 : (drawCanopySurf ? 2.0 : 0.0)
      );
      gl.uniform4f(
        pComp.u('uTreeLineOpt'),
        o.treeHeightLines ? 1.0 : 0.0,
        o.hideOccludedTerrainLines ? 1.0 : 0.0,
        drawClearWall ? 1.0 : 0.0,
        0.0
      );
      gl.uniform4f(pComp.u('uSkyTop'), o.skyTop[0], o.skyTop[1], o.skyTop[2], 1.0);
      gl.uniform4f(pComp.u('uSkyHor'), o.skyHor[0], o.skyHor[1], o.skyHor[2], 1.0);
      gl.uniform4f(pComp.u('uSunCol'), o.sunCol[0], o.sunCol[1], o.sunCol[2], o.night);
      gl.uniform4f(pComp.u('uEdgeOpt'), o.showEdges ? 1.0 : 0.0, o.near, o.far, o.fogDist);
      gl.uniform2f(pComp.u('uTexel'), 1.0 / w, 1.0 / h);
      gl.uniform4f(pComp.u('uMode'), o.mode, 0, 0, o.dark ? 1.0 : 0.0);
      gl.uniform4f(pComp.u('uMoonDir'), o.moonDir[0], o.moonDir[1], o.moonDir[2], o.moonAltDeg);
      gl.uniform4f(pComp.u('uMoonOpt'), o.moonPhase, o.moonIllum, o.moonAngle, 1.0);
      const autoLine = o.dark ? [0.48, 0.78, 0.56] : [0.08, 0.16, 0.10];
      const lineC = dv.lineAutoColor ? autoLine : dv.colLine;
      gl.uniform4f(pComp.u('uDevComp1'), dv.edgeOn ? 1.0 : 0.0, dv.edgeOuter, dv.edgeRidge, dv.edgeThick);
      gl.uniform4f(pComp.u('uDevComp2'), dv.edgeThrBase, dv.edgeThrSlope, dv.edgeStr, dv.edgeCheckMode);
      gl.uniform4f(pComp.u('uDevComp3'), dv.edgeFadeStart, dv.edgeFadeEnd, dv.edgeHillOccl, 0.0);
      gl.uniform4f(pComp.u('uDevCompCol'), lineC[0], lineC[1], lineC[2], 0.0);
      const dt = DEV_CONTOURS.terrain;
      const dl = DEV_CONTOURS.treeLine;
      const dz = DEV_CONTOURS.forestZone;
      const tcL = hex3(dt.colLight), tcD = hex3(dt.colDark);
      const lcL = hex3(dl.colLight), lcD = hex3(dl.colDark);
      const zcL = hex3(dz.tintLight), zcD = hex3(dz.tintDark);

      gl.uniform4f(pComp.u('uTerrEdge1'), dt.thrBase, dt.thrSlope, dt.softness, dt.thick);
      gl.uniform4f(pComp.u('uTerrEdge2'), dt.diagWeight, dt.horizonBoost, dt.treeSilhouette ? 1.0 : 0.0, dt.occBias);
      gl.uniform4f(pComp.u('uTerrEdge3'), dt.fadeStart, dt.fadeEnd, dt.strBase, dt.strNearAdd);
      gl.uniform4f(pComp.u('uTerrEdge4'), dt.strMin, dt.strMax, dt.modeK_CG, dt.modeK_Hybrid);
      gl.uniform4f(pComp.u('uTerrEdgeColL'), tcL[0], tcL[1], tcL[2], dt.modeK_Other);
      gl.uniform4f(pComp.u('uTerrEdgeColD'), tcD[0], tcD[1], tcD[2], dt.nearSuppress);
      gl.uniform4f(pComp.u('uTerrEdge5'), dt.slopeFilter, dt.horizonThick, dt.hazeMix, dt.backHalo);

      gl.uniform4f(pComp.u('uTreeEdge1'), dl.thick, dl.thrBase, dl.thrSlope, dl.softness);
      gl.uniform4f(pComp.u('uTreeEdge2'), dl.checkMode, dl.outerWeight, dl.ridgeWeight, dl.tolTree);
      gl.uniform4f(pComp.u('uTreeEdge3'), dl.tolTerrain, dl.fadeStart, dl.fadeEnd, dl.strBase);
      gl.uniform4f(pComp.u('uTreeEdge4'), dl.strNearAdd, dl.strMin, dl.strMax, dl.dashAmp);
      gl.uniform4f(pComp.u('uTreeEdgeColL'), lcL[0], lcL[1], lcL[2], dl.dashFreq);
      gl.uniform4f(pComp.u('uTreeEdgeColD'), lcD[0], lcD[1], lcD[2], 0.0);
      gl.uniform4f(pComp.u('uTreeEdge5'), dl.slopeFilter, dl.skyBoost, dl.nearFade, dl.hazeMix);

      gl.uniform4f(pComp.u('uFZone1'), dz.treeTolMin, dz.treeTolMax, dz.terrTolMin, dz.terrTolMax);
      gl.uniform4f(pComp.u('uFZone2'), dz.strength, dz.skyAffect, dz.treesAffect, 0.0);
      gl.uniform4f(pComp.u('uFZoneColL'), zcL[0], zcL[1], zcL[2], 0.0);
      gl.uniform4f(pComp.u('uFZoneColD'), zcD[0], zcD[1], zcD[2], 0.0);
      const tcC = DEV_TERRAIN.contours;
      const crR = hex3(o.dark ? tcC.ridgeColDark : tcC.ridgeColLight);
      const crV = hex3(o.dark ? tcC.valleyColDark : tcC.valleyColLight);
      gl.uniform4f(pComp.u('uCrease1'), tcC.ridgeOn ? 1.0 : 0.0, tcC.ridgeThr, tcC.ridgeStr, tcC.valleyOn ? 1.0 : 0.0);
      gl.uniform4f(pComp.u('uCrease2'), tcC.valleyThr, tcC.valleyStr, tcC.creaseThick, tcC.creaseMaxDist);
      gl.uniform4f(pComp.u('uCreaseColR'), crR[0], crR[1], crR[2], tcC.sketchBreak);
      gl.uniform4f(pComp.u('uCreaseColV'), crV[0], crV[1], crV[2], 0.0);


      const sf = o.smartFog;
      if (sf && sf.enabled) {
        gl.uniform4f(pComp.u('uSmartFog1'), 1.0, sf.layers, sf.strength, sf.contrast);
        gl.uniform4f(pComp.u('uSmartFog2'), sf.b1, sf.b2, sf.b3, o.fogDist);
        gl.uniform4f(pComp.u('uSmartFog3'), sf.valleyMist, sf.ridgeBoost, sf.visYMin, sf.visYMax);
      } else {
        gl.uniform4f(pComp.u('uSmartFog1'), 0.0, 4.0, 0.0, 0.0);
        gl.uniform4f(pComp.u('uSmartFog2'), 1000.0, 5000.0, 15000.0, o.fogDist);
        gl.uniform4f(pComp.u('uSmartFog3'), 0.0, 0.0, 0.0, 100.0);
      }

      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);
      frameDraws++;

      if (activeGpuQ) {
        gl.endQuery(gpuExt.TIME_ELAPSED_EXT);
        gpuQueries.push(activeGpuQ);
      }

      R.stats.drawCalls = frameDraws;
      R.stats.terrainTris = Math.round(terrTris);
      R.stats.bldTris = Math.round(bldTris);
      R.stats.canopyTris = Math.round(canopyTris);
      R.stats.treeTris = Math.round(treeTris);
      R.stats.rw = w;
      R.stats.rh = h;
      R.stats.glSubmitMs = performance.now() - tGl0;
      R.stats.gpuMs = lastGpuMs;


    };

    // Освобождение видеопамяти: свёрнутое окно / фоновая вкладка (full) и простой (только лишние буферы леса)
    R.trim = full => {
      if (R.lost) return;
      freeCanopyRT(); freeClearRT();
      if (full) freeMainRT();
      usedCanopyRT = usedClearRT = false;
    };
    R.trimIdle = () => {
      if (R.lost) return;
      if (!usedCanopyRT) freeCanopyRT();
      if (!usedClearRT) freeClearRT();
    };

    const handleLost = e => { e.preventDefault(); R.lost = true; onLost && onLost(); };
    const handleRestored = () => { onRestored && onRestored(); };
    canvas.addEventListener('webglcontextlost', handleLost);
    canvas.addEventListener('webglcontextrestored', handleRestored);

    R.detach = () => {
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
    };

    R.dispose = () => {
      R.detach();
      try {
        if (gpuExt) gpuQueries.forEach(q => gl.deleteQuery(q));
        if (clearFbo) { gl.deleteFramebuffer(clearFbo); gl.deleteTexture(clearColorTex); gl.deleteTexture(clearDepthTex); }
        if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteTexture(depthTex); }
        if (canopyFbo) { gl.deleteFramebuffer(canopyFbo); gl.deleteTexture(canopyColorTex); gl.deleteTexture(canopyDepthTex); }
        if (shadowInitDone) {
          [demInTex, demMidTex, demOutTex, canNearTex, canFarTex].forEach(t => t && gl.deleteTexture(t));
          if (shadowTexs) shadowTexs.forEach(t => gl.deleteTexture(t));
          if (shadowFbos) shadowFbos.forEach(f => gl.deleteFramebuffer(f));
        }
        [innerB, midB, outerB, zoomB] .forEach(b => { gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.vbo); gl.deleteBuffer(b.ibo); });
        gl.deleteVertexArray(treeVao); gl.deleteVertexArray(canopyVao); gl.deleteVertexArray(canopyFarVao); gl.deleteVertexArray(emptyVao);
        gl.deleteBuffer(treeQuadVbo); gl.deleteBuffer(treeInstVbo);
        gl.deleteBuffer(canopyMeshVbo); gl.deleteBuffer(canopyMeshIbo); gl.deleteBuffer(canopyInstVbo); gl.deleteBuffer(canopyFarInstVbo);
        gl.deleteTexture(vecTex);
        gl.deleteVertexArray(bldVao);
        gl.deleteBuffer(bldVbo);
        gl.deleteVertexArray(canopySurfVao);
        gl.deleteVertexArray(canopySurfFarVao);
        gl.deleteBuffer(canopySurfFarVbo);
        gl.deleteTexture(zoomNrmTex);
        gl.deleteBuffer(canopySurfFarIbo);
        gl.deleteBuffer(canopySurfVbo);
        gl.deleteBuffer(canopySurfIbo);
        gl.deleteVertexArray(clearWallVao);
        gl.deleteBuffer(clearWallVbo);
        gl.deleteBuffer(clearWallIbo);
        [pTerr, pTree, pCanopy, pCanopySurf, pClearWall, pBld, pComp, pShadowBake].forEach(p => gl.deleteProgram(p.p)); // <-- добавили pShadowBake

        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext && !R.lost) ext.loseContext();
      } catch (e) {}
    };

    return R;
  }

  // ===========================================================================
  // 8. НАСТРОЙКИ
  // ===========================================================================
  const DEF = {
    view: {
      mode: 'hybrid',
      perfOverlay: false,
      perfContinuous: false,
      darkTheme: false,
      showEdges: true,
      showIsolines: false,
      isoStep: 25,
      zScale: 1.2,
      curvature: true,
      fogDist: 45000,
      castTerrainShadows: false, 
      smartFog: {
        enabled: true,
        layers: 4,        // 3 или 4 плана
        zoneMode: 'auto', // 'auto' | 'manual'
        nearBias: 0.60,   // сдвиг ближней зоны в авто-режиме
        farBias: 0.95,    // сдвиг средних/дальних зон в авто-режиме
        b1Km: 1.5,        // ручная граница 1 (км)
        b2Km: 6.0,        // ручная граница 2 (км)
        b3Km: 16.0,       // ручная граница 3 (км)
        strength: 0.80,   // плотность слоёв
        contrast: 0.60,   // резкость границ между планами
        valleyMist: 0.45, // сгущение дымки в долинах
        ridgeBoost: 0.50  // ореол дымки сразу за гребнями
      },
      fov: 72,
      quality: 'mid',
      refreshOnRestore: true
    },
    layers: {
      peaks: true,
      settlements: true,
      localities: true,
      landmarks: true,
      hideOccluded: true,
      showDist: 'smart',
      maxDistKm: 45,
      fontSize: 12,
      roadsPaved: true,
      levelRoads: true,
      roadPavedWidth: 0.4,
      roadPavedDay: '#76878f',
      roadPavedNight: '#92a5af',
      roadsTrail: true,
      roadTrailWidth: 0.8,
      roadTrailDay: '#9a734c',
      roadTrailNight: '#a8a88f',

      rivers: true,
      riverWidth: 1.0,
      buildings: true,
      bldHeightScale: 1.0,
      trees: true,
      treeMode: 'trees',
      canopyOpacity: 1.0,
      canopyScale: 1.05,
      canopyMinH: 0.5,
      massTerrainContours: true,
      treeHeightLines: true,
      hideOccludedTerrainLines: true,
      castForestShadows: false,
      canopyWave: 1.1
    },
    camera: {
      eyeHeight: 2.0,
      sensorOn: false,
      compassOffset: 0,
      clickToMove: true,
      joystick: 'auto'
    },
    sky: {
      trajectories: true,
      timeMode: 'now',
      hour: 12.0,
      date: ''
    },
    sources: {
      demOuter: true,
      demMid: true,
      demInner: true,
      osm: true,
      vectors: true,
      canopy: true,
      canopyFar: true
    },
    win: { x: null, y: null, w: null, h: null, max: true },
    panel: false,
    tab: 'main'
  };

  const deepMerge = (a, b) => {
    for (const k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
      else a[k] = b[k];
    }
    return a;
  };
  const loadST = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(LSK + 'st') || '{}');
      if (raw.layers && raw.layers.roads === false) {
        if (raw.layers.roadsPaved === undefined) raw.layers.roadsPaved = false;
        if (raw.layers.roadsTrail === undefined) raw.layers.roadsTrail = false;
      }
      return deepMerge(JSON.parse(JSON.stringify(DEF)), raw);
    } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  };

  // ===========================================================================
  // 9. СТИЛИ
  // ===========================================================================
  const PKV_CSS = `
.pkv-win{--accent:#4da3ff;--bg0:#0e1218;--bg1:#151a23;--bg2:#1b222d;--bg3:#232b39;--line:#2d3646;--txt:#e8ecf3;--mut:#8d99ab;
position:fixed;z-index:3010;background:var(--bg1);color:var(--txt);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 56px rgba(0,0,0,.62);display:flex;flex-direction:column;overflow:hidden;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-width:320px;min-height:280px}
.pkv-win *{box-sizing:border-box}
.pkv-win.pkv-max{inset:0!important;width:auto!important;height:auto!important;border-radius:0;border:0}
.pkv-win.pkv-hide{display:none}
.pkv-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:linear-gradient(180deg,#1d2431,#171c26);border-bottom:1px solid var(--line);user-select:none;touch-action:none;cursor:move;flex:0 0 auto}
.pkv-win.pkv-max .pkv-head{cursor:default}
.pkv-title{font-weight:700;white-space:nowrap}
.pkv-dots{display:flex;gap:4px;align-items:center;cursor:pointer;padding:3px 7px;border-radius:999px;background:rgba(255,255,255,.05)}
.pkv-dot{width:8px;height:8px;border-radius:50%;background:#555;display:inline-block}
.pkv-dot.ok{background:#3fb950}.pkv-dot.loading{background:#d29922;animation:pkvp 1s infinite}.pkv-dot.error{background:#f85149}
.pkv-dot.warn{background:#f0883e}
.pkv-src.st-warn{border-left-color:#f0883e}
@keyframes pkvp{50%{opacity:.35}}
.pkv-sp{flex:1}
.pkv-b{border:1px solid var(--line);background:var(--bg3);color:var(--txt);border-radius:8px;min-width:30px;height:28px;padding:0 9px;cursor:pointer;font-size:13px;line-height:1;transition:.15s}
.pkv-b:hover{background:#2d3748;border-color:#404d63}
.pkv-b.act{border-color:var(--accent);color:var(--accent);background:rgba(77,163,255,.12)}
.pkv-b.prime{background:linear-gradient(135deg,#3b82f6,#6366f1);border:0;color:#fff;font-weight:600}
.pkv-b.warn{border-color:#7d2a27;color:#ffb4ae;background:#2e1b1b}
.pkv-brand{flex:1 1 0%;min-width:0;display:flex;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;touch-action:pan-x}
.pkv-brand::-webkit-scrollbar{display:none}
.pkv-brand.ovf{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 16px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 16px),transparent)}
.pkv-head .pkv-b,.pkv-dots{flex:0 0 auto}
.pkv-main{flex:1;min-height:0;display:flex;position:relative}
.pkv-view{flex:1;min-width:0;position:relative;background:#0b0e13;overflow:hidden}
.pkv-gl,.pkv-hud{position:absolute;inset:0;width:100%;height:100%;display:block}
.pkv-gl{touch-action:none;outline:none}
.pkv-hud{pointer-events:none}
.pkv-chips{position:absolute;left:8px;top:46px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:calc(100% - 16px);pointer-events:none;z-index:3}
.pkv-chip{background:rgba(12,16,23,.72);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:3px 9px;font-size:11.5px;color:#e6edf5;white-space:nowrap}
.pkv-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(10,13,18,.92);border:1px solid #354152;border-radius:10px;padding:7px 12px;font-size:12px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:88%;text-align:center;z-index:8}
.pkv-toast.on{opacity:1}
.pkv-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:20px;background:rgba(11,14,19,.72);z-index:5;text-align:center}
.pkv-msg.on{display:flex}
.pkv-spin{width:28px;height:28px;border:3px solid #2f3643;border-top-color:var(--accent);border-radius:50%;animation:pkvr .8s linear infinite}
@keyframes pkvr{to{transform:rotate(360deg)}}

.pkv-edge-alert{position:absolute;left:50%;top:46px;transform:translateX(-50%);display:none;align-items:center;justify-content:center;max-width:calc(100% - 24px);background:rgba(16,22,34,.88);border:1px solid rgba(77,163,255,.45);border-radius:999px;padding:4px 12px;font-size:11.5px;color:#e8f1ff;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;z-index:6}
.pkv-edge-alert.on{display:flex}

.pkv-colw{flex:1;display:flex;align-items:center;gap:6px;min-width:0}
.pkv-col{width:34px;height:24px;padding:1px;border:1px solid #354052;border-radius:6px;background:var(--bg3);cursor:pointer;flex:0 0 auto}
.pkv-col:disabled{opacity:.42;cursor:not-allowed}
.pkv-col-lbl{font-size:11px;color:#9eb0c7;user-select:none}

.pkv-perf{position:absolute;left:8px;bottom:130px;z-index:7;background:rgba(10,14,20,.88);border:1px solid #354152;border-radius:10px;padding:7px 9px;color:#dce5f2;font:11px/1.35 ui-monospace,Consolas,monospace;min-width:210px;max-width:270px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.pkv-perf.on{display:block}
.pkv-perf-h{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:700}
.pkv-perf-h .pkv-b{height:20px;min-width:22px;padding:0 5px;font-size:11px}
.pkv-perf-cv{display:block;width:100%;height:34px;margin:4px 0;background:rgba(255,255,255,.04);border-radius:5px}
.pkv-perf-grid{display:grid;grid-template-columns:1fr auto;gap:1px 10px;color:#9eb0c7}
.pkv-perf-grid b{color:#e8eff9;font-weight:600;text-align:right}

/* Инспектор выбранной вершины/объекта */
.pkv-poi-card{position:absolute;right:10px;top:48px;width:258px;max-width:calc(100% - 20px);background:rgba(17,22,31,.93);border:1px solid #384457;border-radius:12px;padding:10px 12px;box-shadow:0 12px 32px rgba(0,0,0,.55);z-index:6;display:none}
.pkv-poi-card.on{display:block}
.pkv-poi-h{display:flex;align-items:flex-start;gap:6px;margin-bottom:6px}
.pkv-poi-h b{flex:1;font-size:13.5px;line-height:1.25}
.pkv-poi-meta{font-size:12px;color:#b8c4d4;display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin-bottom:8px}
.pkv-poi-coords{font:11px ui-monospace,Consolas,monospace;color:#8db4e2;background:rgba(255,255,255,.05);padding:4px 7px;border-radius:6px;cursor:pointer;margin-bottom:8px;text-align:center}

/* Стик и кнопки управления на экране */
.pkv-joy{position:absolute;left:14px;bottom:16px;width:104px;height:104px;border-radius:50%;background:rgba(15,20,28,.55);border:1.5px solid rgba(255,255,255,.22);touch-action:none;z-index:4;display:none}
.pkv-joy.on{display:block}
.pkv-joy-knob{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:rgba(77,163,255,.78);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none}
.pkv-rctrls{position:absolute;right:10px;bottom:16px;display:flex;flex-direction:column;gap:6px;z-index:4}
.pkv-rc-b{width:38px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(15,20,28,.75);color:#fff;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.pkv-rc-b:active{transform:scale(.94);background:rgba(77,163,255,.45)}
.pkv-rc-b svg{display:block;pointer-events:none}
.pkv-rc-b.pkv-dim{opacity:.38}

/* Боковая панель */
.pkv-panel{width:328px;flex:0 0 328px;background:var(--bg1);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.pkv-panel.hide{display:none}
.pkv-tabs{display:flex;gap:4px;padding:6px 8px 0;background:var(--bg0);border-bottom:1px solid var(--line);flex:0 0 auto}
.pkv-tab{flex:1;padding:7px 4px 8px;text-align:center;cursor:pointer;color:var(--mut);border-radius:9px 9px 0 0;font-size:11.5px;font-weight:500;border-bottom:2px solid transparent;user-select:none;transition:.15s;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap}
.pkv-tab i{display:inline-block;font-style:normal;font-size:14px;line-height:1}
.pkv-tab:hover{color:#cfd8e6;background:rgba(255,255,255,.03)}
.pkv-tab.on{color:#fff;background:var(--bg1);border-bottom-color:var(--accent);font-weight:600}
.pkv-pages{flex:1;overflow:auto;padding:10px 10px 20px;scrollbar-width:thin;scrollbar-color:#344054 transparent}

.pkv-card{margin:0 0 10px;border:1px solid var(--line);border-radius:11px;background:var(--bg2);overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.pkv-card-h{display:flex;align-items:center;gap:7px;padding:8px 11px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));border-bottom:1px solid var(--line);font-size:12.5px}
.pkv-card-h b{flex:1;font-weight:600;letter-spacing:.1px}
.pkv-card-b{padding:8px 11px}

.pkv-row{display:flex;align-items:center;gap:8px;margin:6px 0;min-height:26px;transition:opacity .15s}
.pkv-row>label{flex:0 0 112px;color:#b9c4d4;font-size:12px;line-height:1.25}
.pkv-row.off{opacity:.42;pointer-events:none}
.pkv-in,.pkv-row select,.pkv-row input[type=date]{flex:1;min-width:0;background:var(--bg3);color:var(--txt);border:1px solid #354052;border-radius:7px;padding:5px 8px;font-size:12px;outline:none;transition:border-color .15s}
.pkv-in:focus,.pkv-row select:focus,.pkv-row input[type=date]:focus{border-color:var(--accent)}
.pkv-in:disabled{opacity:.48;cursor:not-allowed}

.pkv-rngw{flex:1;display:flex;align-items:center;gap:6px;min-width:0}
.pkv-rng{--p:50%;flex:1;min-width:0;height:6px;border-radius:4px;-webkit-appearance:none;appearance:none;outline:none;background:linear-gradient(90deg,var(--accent) var(--p),#2c3342 var(--p))}
.pkv-rng::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#fff;border:3px solid var(--accent);cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4)}
.pkv-val{flex:0 0 46px;text-align:right;font-variant-numeric:tabular-nums;color:#a7b8d0;font-size:11.5px;white-space:nowrap}

.pkv-chk{display:flex;align-items:center;gap:9px;margin:6px 0;font-size:12px;color:#dce5f2;cursor:pointer;user-select:none;min-height:22px}
.pkv-chk input{-webkit-appearance:none;appearance:none;flex:0 0 30px;width:30px;height:17px;border-radius:999px;background:#323b4b;position:relative;cursor:pointer;transition:.2s;margin:0}
.pkv-chk input::after{content:'';position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#cfd8e6;transition:.2s}
.pkv-chk input:checked{background:var(--accent)}.pkv-chk input:checked::after{left:15px;background:#fff}

.pkv-btns{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.pkv-btns .pkv-b{flex:1 1 auto;height:29px;font-size:11.5px;padding:0 8px}
.pkv-btns.compact{gap:4px}
.pkv-btns.compact .pkv-b{height:26px;font-size:11px;padding:0 6px;min-width:0}
.pkv-note{font-size:11.5px;color:var(--mut);line-height:1.4;margin:5px 0}
.pkv-pill-info{background:rgba(255,255,255,.04);border:1px solid #2b3444;border-radius:8px;padding:5px 8px;font-size:11px;color:#b2c2d8;line-height:1.35;margin:6px 0}

/* Спойлеры для второстепенных настроек */
.pkv-spoil{margin:7px 0 2px;border:1px solid #2b3444;border-radius:8px;background:rgba(14,18,24,.45);overflow:hidden}
.pkv-spoil>summary{list-style:none;display:flex;align-items:center;gap:6px;padding:6px 9px;font-size:11.5px;font-weight:600;color:#9bb3d1;cursor:pointer;user-select:none;transition:background .15s,color .15s}
.pkv-spoil>summary::-webkit-details-marker{display:none}
.pkv-spoil>summary::before{content:'▸';font-size:11px;color:var(--accent);transition:transform .18s;display:inline-block;width:10px;text-align:center}
.pkv-spoil[open]>summary::before{transform:rotate(90deg)}
.pkv-spoil>summary:hover{background:rgba(255,255,255,.04);color:#dce7f7}
.pkv-spoil[open]>summary{border-bottom:1px solid #262f3e;color:#cfe0f7;background:rgba(255,255,255,.025)}
.pkv-spoil-b{padding:6px 9px 8px}

.pkv-forest-alert{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:none;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 140px);background:rgba(16,42,28,.93);border:1px solid #2ea043;border-radius:12px;padding:7px 11px;font-size:12px;color:#d2f5dc;box-shadow:0 10px 28px rgba(0,0,0,.55);z-index:6}
.pkv-forest-alert.on{display:flex}
.pkv-forest-alert .pkv-b{height:24px;font-size:11.5px;padding:0 8px;background:rgba(46,160,67,.22);border-color:#3fb950;color:#fff}
.pkv-sub{margin:4px 0 6px 6px;padding-left:9px;border-left:2px solid var(--line)}
.pkv-sub.off{opacity:.45;pointer-events:none}

.pkv-src{border:1px solid var(--line);border-left-width:4px;border-radius:9px;padding:7px 9px;margin:0 0 8px;background:var(--bg2)}
.pkv-src.st-ok{border-left-color:#3fb950}.pkv-src.st-loading{border-left-color:#d29922}.pkv-src.st-error{border-left-color:#f85149}.pkv-src.st-off{border-left-color:#555}
.pkv-sh{display:flex;align-items:center;gap:6px}.pkv-sh b{flex:1;font-size:12px}
.pkv-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid #354152}
.pkv-bar{height:4px;border-radius:3px;background:#2c3342;overflow:hidden;margin:4px 0}.pkv-bar>i{display:block;height:100%;background:var(--accent)}

.pkv-foot{flex:0 0 auto;padding:5px 12px;background:var(--bg0);border-top:1px solid var(--line);font-size:12px;color:#9fb0c8;min-height:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pkv-rz{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:6;background:linear-gradient(135deg,transparent 55%,#4b5568 55%,#4b5568 62%,transparent 62%,transparent 72%,#4b5568 72%,#4b5568 79%,transparent 79%)}
.pkv-win.pkv-max .pkv-rz{display:none}
.pkv-pill{position:fixed;z-index:3010;left:12px;bottom:112px;display:none;align-items:center;gap:8px;background:#161a21;color:#e6e9ef;border:1px solid #333b49;border-radius:999px;padding:6px 8px 6px 12px;box-shadow:0 6px 20px rgba(0,0,0,.45);font:13px system-ui,sans-serif;cursor:pointer}
.pkv-pill.on{display:flex}
.pkv-pill .pkv-b{height:24px;min-width:24px;border-radius:999px}
@media(max-width:820px){
  .pkv-panel{position:absolute;right:0;left:0;bottom:0;width:auto;flex:none;height:54%;border-left:0;border-top:1px solid var(--line);z-index:7;border-radius:14px 14px 0 0}
}
`;

  function ensureStyle() {
    if (!document.getElementById('pkv-style')) {
      document.head.append(el('style', { id: 'pkv-style', text: PKV_CSS }));
    }
  }

  // ===========================================================================
  // 10. ЭКЗЕМПЛЯР МОДУЛЯ
  // ===========================================================================
  let inst = null;

  function getStartLatLng(opts) {
    if (opts && opts.latLng) return { lat: opts.latLng.lat, lng: opts.latLng.lng };
    if (opts && opts.lat != null && opts.lng != null) return { lat: opts.lat, lng: opts.lng };
    if (WM.map && WM.map.getCenter) {
      const c = WM.map.getCenter();
      return { lat: c.lat, lng: c.lng };
    }
    return { lat: 43.35, lng: 42.44 }; // Фолбэк (Эльбрус)
  }

  function createInstance(opts) {
    ensureStyle();
    const ST = loadST();
    const mobile = isMobile();
    const save = () => { try { localStorage.setItem(LSK + 'st', JSON.stringify(ST)); } catch (e) {} };

    const cam = {
      x: 0, z: 0, y: 2,
      yaw: 0, pitch: 0.04,
      targetX: 0, targetZ: 0, movingToTarget: false,
      fov: ST.view.fov || 48,
      pos: [0, 2, 0]
    };
    const joy = { dx: 0, dy: 0 };
    const keys = {};

    let geo = null, hub = null, S = null, R = null;

    let zoomPatch = null, zoomLoading = false, zoomJobCtl = null, zoomTimer = 0, lastZoomViewSig = '';
    const zoomPatchCache = new Map();

    function clearZoomState() {
      if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = 0; }
      if (zoomJobCtl) { try { zoomJobCtl.abort(); } catch (e) {} zoomJobCtl = null; }
      zoomLoading = false;
      zoomPatch = null;
      zoomPatchCache.clear();
      if (R && R.clearZoomPatch) R.clearZoomPatch();
    }

    function isHitInsidePatch(hit, patch) {
      if (!hit || !patch) return false;
      return Math.max(Math.abs(hit.x - patch.cx), Math.abs(hit.z - patch.cz)) < patch.halfM * 0.62;
    }

    let smartFogKey = '';
    let smartFogDemSig = '';
    let smartFogInit = false;
    let smartFogTarget = { b1: 1500, b2: 6000, b3: 18000, visYMin: -50, visYMax: 450 };
    let smartFogState  = { b1: 1500, b2: 6000, b3: 18000, visYMin: -50, visYMax: 450 };

    function analyzeSmartFog(cssW, cssH, dt) {
      const sf = ST.view.smartFog;
      if (!sf || !sf.enabled || !S) return null;

      const fogDist  = ST.view.fogDist || 45000;
      const zScale   = ST.view.zScale || 1.0;
      const curv     = ST.view.curvature !== false;
      const layers   = sf.layers === 3 ? 3 : 4;
      const zoneMode = sf.zoneMode === 'manual' ? 'manual' : 'auto';
      const nearBias = sf.nearBias != null ? sf.nearBias : 1.0;
      const farBias  = sf.farBias != null ? sf.farBias : 1.0;
      const b1Km     = sf.b1Km != null ? sf.b1Km : 1.5;
      const b2Km     = sf.b2Km != null ? sf.b2Km : 6.0;
      const b3Km     = sf.b3Km != null ? sf.b3Km : 16.0;

      if (S.demSig !== smartFogDemSig) {
        smartFogDemSig = S.demSig;
        smartFogInit = false;
      }

      // Не зависит от поворота (yaw), наклона (pitch) и зума (fov) — 0 скачков при обзоре
      const key = `${S.demSig}|${Math.round(cam.x / 60)}|${Math.round(cam.z / 60)}|${fogDist}|${layers}|${zScale.toFixed(1)}|${curv ? 1 : 0}|${zoneMode}|${nearBias.toFixed(2)}|${farBias.toFixed(2)}|${b1Km.toFixed(1)}|${b2Km.toFixed(1)}|${b3Km.toFixed(1)}`;

      if (key !== smartFogKey) {
        smartFogKey = key;
        const dMin = Math.max(80, Math.min(450, fogDist * 0.04));
        const dMax = Math.max(dMin + 400, fogDist);
        const sqMin = Math.sqrt(dMin), sqMax = Math.sqrt(dMax);
        const BINS = 48;
        const hist = new Float32Array(BINS);
        const visHeights = [];

        const N_RAYS = 24, N_STEPS = 40;
        for (let r = 0; r < N_RAYS; r++) {
          const rayYaw = (r / N_RAYS) * Math.PI * 2;
          const dx = Math.sin(rayYaw), dz = -Math.cos(rayYaw);
          let maxSlope = -1e9, prevVis = false;

          for (let k = 0; k < N_STEPS; k++) {
            const t = k / (N_STEPS - 1);
            const d = Math.pow(sqMin + (sqMax - sqMin) * t, 2);
            const wx = cam.x + dx * d, wz = cam.z + dz * d;
            if (Math.abs(wx) > OUTER_HALF || Math.abs(wz) > OUTER_HALF) break;

            const drop = curv ? (d * d) / 14646000 : 0;
            const gy = S.sampleRawY(wx, wz) * zScale - drop;
            const slope = (gy - cam.y) / d;

            if (slope >= maxSlope - 0.006) {
              visHeights.push(gy);
              if (zoneMode === 'auto') {
                const bin = clamp(Math.floor(t * (BINS - 0.001)), 0, BINS - 1);
                const isNewRidge = !prevVis || slope > maxSlope + 0.004;
                hist[bin] += isNewRidge ? 3.0 : 0.65;
              }
              if (slope > maxSlope) maxSlope = slope;
              prevVis = true;
            } else {
              prevVis = false;
            }
          }
        }

        // Устойчивые границы высот (12%..88% перцентиль вместо резких min/max)
        let visYMin, visYMax;
        if (visHeights.length >= 6) {
          visHeights.sort((a, b) => a - b);
          visYMin = visHeights[Math.floor(visHeights.length * 0.12)];
          visYMax = visHeights[Math.floor(visHeights.length * 0.88)];
        } else {
          const g0 = S.sampleRawY(cam.x, cam.z) * zScale;
          visYMin = g0 - 20; visYMax = g0 + 250;
        }
        if (!(visYMax > visYMin + 20)) visYMax = visYMin + 40;

        let b1, b2, b3;
        if (zoneMode === 'manual') {
          b1 = clamp(b1Km * 1000, 120, dMax * 0.85);
          b2 = clamp(b2Km * 1000, b1 + 200, dMax * 0.95);
          b3 = layers === 4 ? clamp(b3Km * 1000, b2 + 250, dMax * 0.99) : dMax * 2.5;
        } else {
          const sh = new Float32Array(hist);
          const tmp = new Float32Array(BINS);
          let sumH = 0;
          for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < BINS; i++) {
              const l = sh[Math.max(0, i - 1)], c = sh[i], r = sh[Math.min(BINS - 1, i + 1)];
              tmp[i] = l * 0.24 + c * 0.52 + r * 0.24;
            }
            sh.set(tmp);
          }
          for (let i = 0; i < BINS; i++) sumH += sh[i];
          const avgH = sumH / BINS;

          const baseTargets = layers === 3 ? [0.28, 0.62] : [0.22, 0.48, 0.74];
          const biasedTargets = baseTargets.map((t, idx) =>
            clamp(idx === 0 ? t * Math.sqrt(nearBias) : t * Math.sqrt(farBias), 0.08, 0.90)
          );
          const splitSubBins = [];
          let minBin = 3;

          for (let m = 0; m < biasedTargets.length; m++) {
            const tBin = Math.round(biasedTargets[m] * (BINS - 1));
            const maxBin = BINS - 3 - (biasedTargets.length - 1 - m) * 4;
            const lo = clamp(tBin - 5, minBin, maxBin);
            const hi = clamp(tBin + 5, lo, maxBin);
            let bestB = lo, bestScore = 1e9;
            for (let b = lo; b <= hi; b++) {
              const score = sh[b] + 0.14 * Math.abs(b - tBin) * avgH;
              if (score < bestScore) { bestScore = score; bestB = b; }
            }
            // Суб-биновая параболическая интерполяция убирает дискретные прыжки
            let subB = bestB;
            if (bestB > lo && bestB < hi) {
              const sL = sh[bestB - 1], sC = sh[bestB], sR = sh[bestB + 1];
              const denom = sL - 2 * sC + sR;
              if (denom > 1e-5) subB += clamp(0.5 * (sL - sR) / denom, -0.5, 0.5);
            }
            splitSubBins.push(subB);
            minBin = Math.round(subB) + 4;
          }

          const binToDist = b => Math.pow(sqMin + (sqMax - sqMin) * ((b + 0.5) / BINS), 2);
          b1 = clamp(binToDist(splitSubBins[0]) * nearBias, 150, dMax * 0.75);
          b2 = clamp(binToDist(splitSubBins[1]) * farBias, b1 * 1.35 + 150, dMax * 0.92);
          b3 = layers === 4
            ? clamp(binToDist(splitSubBins[2]) * farBias, b2 * 1.25 + 250, dMax * 0.98)
            : dMax * 2.5;
        }

        smartFogTarget = { b1, b2, b3, visYMin, visYMax };
        if (!smartFogInit || zoneMode === 'manual') {
          smartFogState = { ...smartFogTarget };
          smartFogInit = true;
        }
      }

      // Плавный переход границ при ходьбе
      const alpha = zoneMode === 'manual' ? 1.0 : clamp(1.0 - Math.exp(-(dt || 0.016) * 3.5), 0.02, 1.0);
      let animating = false;
      const smoothField = (k, eps) => {
        const diff = smartFogTarget[k] - smartFogState[k];
        if (Math.abs(diff) > eps) {
          smartFogState[k] += diff * alpha;
          animating = true;
        } else {
          smartFogState[k] = smartFogTarget[k];
        }
      };
      smoothField('b1', 6);
      smoothField('b2', 12);
      smoothField('b3', 18);
      smoothField('visYMin', 1.5);
      smoothField('visYMax', 1.5);

      if (refs.smartFogNote) {
        const fmtKm = m => m >= 1000 ? (m / 1000).toFixed(1) + ' км' : Math.round(m) + ' м';
        refs.smartFogNote.textContent = layers === 3
          ? `Планы: < ${fmtKm(smartFogState.b1)} · ${fmtKm(smartFogState.b2)}`
          : `Планы: < ${fmtKm(smartFogState.b1)} · ${fmtKm(smartFogState.b2)} · ${fmtKm(smartFogState.b3)}`;
      }

      return {
        enabled: true,
        _animating: animating,
        layers,
        strength: sf.strength != null ? sf.strength : 0.90,
        contrast: sf.contrast != null ? sf.contrast : 0.78,
        valleyMist: sf.valleyMist != null ? sf.valleyMist : 0.65,
        ridgeBoost: sf.ridgeBoost != null ? sf.ridgeBoost : 0.75,
        ...smartFogState
      };
    }

    function findZoomTarget(W, H) {
      if (!S || !W || !H) return null;

      // 1. Главный приоритет — точно по перекрестию
      const centerHit = pickTerrain(W * 0.50, H * 0.50);
      if (centerHit && centerHit.dist >= 1200 && centerHit.dist <= 40000) {
        return centerHit;
      }

      // 2. Если центр в небе чуть выше гребня — ищем ближайшую к центру вершину,
      //    НО берём самый ДАЛЬНИЙ склон (чтобы не съехать на ближайший холм у ног)
      const nearCenterPts = [
        [0.47, 0.50], [0.53, 0.50],
        [0.50, 0.53], [0.50, 0.47],
        [0.45, 0.52], [0.55, 0.52],
        [0.50, 0.56]
      ];
      const hits = [];
      for (const [fx, fy] of nearCenterPts) {
        const hit = pickTerrain(W * fx, H * fy);
        if (hit && hit.dist >= 1200 && hit.dist <= 40000) hits.push(hit);
      }
      if (!hits.length) return null;

      if (zoomPatch && geo && zoomPatch.geoKey === geo.key && zoomPatch.demSig === S.demSig) {
        const inside = hits.filter(h => isHitInsidePatch(h, zoomPatch));
        if (inside.length) {
          inside.sort((a, b) => b.dist - a.dist);
          return inside[0];
        }
      }
      hits.sort((a, b) => b.dist - a.dist);
      return hits[0];
    }

    async function runZoomCheck() {
      zoomTimer = 0;
      if (destroyed || min || !S || !geo || !R || cam.fov > ZOOM_MIN_FOV) return;
      const W = viewW || glCanvas.clientWidth || 0;
      const H = viewH || glCanvas.clientHeight || 0;
      const hit = findZoomTarget(W, H);
      if (!hit || hit.dist < 2000) return;

      const aspect = W / Math.max(H, 1);
      const visHalf = hit.dist * Math.tan((cam.fov * 0.5) * DEG) * Math.max(1.0, aspect);
      const maxNoCamOverlap = Math.max(600, Math.floor((hit.dist - 600) / 100) * 100);
      const desiredHalf = clamp(Math.round((visHalf * 2.2) / 100) * 100, 600, Math.min(7500, maxNoCamOverlap));

      if (zoomPatch && zoomPatch.geoKey === geo.key && zoomPatch.demSig === S.demSig) {
        const dCenter = Math.max(Math.abs(hit.x - zoomPatch.cx), Math.abs(hit.z - zoomPatch.cz));
        if (dCenter < zoomPatch.halfM * 0.62 && desiredHalf >= zoomPatch.halfM * 0.50 && desiredHalf <= zoomPatch.halfM * 1.90) {
          return;
        }
      }

      const snap = Math.max(200, Math.round((desiredHalf * 0.25) / 100) * 100);
      const snapCx = Math.round(hit.x / snap) * snap;
      const snapCz = Math.round(hit.z / snap) * snap;
      const patchKey = `${geo.key}|${S.demSig}|${snapCx},${snapCz}|${desiredHalf}`;

      const cached = zoomPatchCache.get(patchKey);
      if (cached) {
        zoomPatchCache.delete(patchKey);
        zoomPatchCache.set(patchKey, cached);
        zoomPatch = cached;
        R.uploadZoomPatch(zoomPatch);
        updateChips();
        requestRender();
        return;
      }

      if (zoomJobCtl) try { zoomJobCtl.abort(); } catch (e) {}
      const ctl = zoomJobCtl = new AbortController();
      const curGeo = geo, curDemSig = S.demSig, curH0 = S.h0;
      const box = curGeo.boxForCenterHalf(snapCx, snapCz, desiredHalf, ZOOM_N, ZOOM_N);

      zoomLoading = true;
      updateChips();

      try {
        const res = await loadDemBox(box, 12, 14, 25, { signal: ctl.signal, progress: () => {} }, true);
        if (ctl.signal.aborted || destroyed || !geo || geo.key !== curGeo.key || !S) return;



        const wm = (hub && hub.sources.vectors && hub.sources.vectors.state === 'ok')
          ? getWaterPolyMask(hub.sources.vectors.data)
          : null;

        if (ST.layers.levelRoads !== false && hub && hub.sources.vectors && hub.sources.vectors.state === 'ok') {
          levelDemGridByRoads(res.data.height, ZOOM_N, ZOOM_N, snapCx, snapCz, desiredHalf, hub.sources.vectors.data, {
            paved: ST.layers.roadsPaved !== false,
            trails: ST.layers.roadsTrail !== false
          });
        }
        if (wm) flattenDemGridByWaterMask(res.data.height, ZOOM_N, ZOOM_N, snapCx, snapCz, desiredHalf, wm);

        const built = buildZoomGridMesh(res.data.height, ZOOM_N, ZOOM_N, snapCx, snapCz, desiredHalf, curH0, S.sampleElevAbs);


        const hArr = built.H;
        zoomPatch = {
          geoKey: curGeo.key,
          demSig: S.demSig,
          cx: snapCx, cz: snapCz, halfM: desiredHalf,
          Nx: ZOOM_N, Ny: ZOOM_N, z: res.data.z,
          mesh: built.mesh, nrmData: built.nrmData,
          sampleRawY: (wx, wz) => sampleGridBilinear(hArr, ZOOM_N, ZOOM_N, desiredHalf, wx - snapCx, wz - snapCz) - S.h0
        };
        if (S.demSig !== curDemSig) zoomPatch.demSig = S.demSig;
        zoomPatchCache.set(patchKey, zoomPatch);
        if (zoomPatchCache.size > 4) zoomPatchCache.delete(zoomPatchCache.keys().next().value);

        R.uploadZoomPatch(zoomPatch);
        zoomLoading = false;
        updateChips();
        requestRender();
      } catch (e) {
        if (!ctl.signal.aborted) {
          zoomLoading = false;
          updateChips();
        }
      }
    }

    let sceneCache = {};
    let syncSceneTimer = 0;

    function assembleCanopyImpostors(src, sampleElevAbs, h0, which = 'both') {
      const ok = id => src[id] && src[id].state === 'ok' && src[id].data;
      const out = {};
      if (which === 'both' || which === 'near') {
        out.near = ok('canopy')
          ? buildCanopyImpostors(src.canopy.data, sampleElevAbs, h0, 0, DEV_CANOPY_ZONES, false)
          : null;
      }
      if (which === 'both' || which === 'far') {
        const overlap = DEV_CANOPY_FAR_ZONES.seamOverlapM != null ? DEV_CANOPY_FAR_ZONES.seamOverlapM : 280;
        const skipHalf = ok('canopy') ? Math.max(0, (src.canopy.data.halfM || CANOPY_HALF) - overlap) : 0;
        out.far = ok('canopyFar')
          ? buildCanopyImpostors(src.canopyFar.data, sampleElevAbs, h0, skipHalf, DEV_CANOPY_FAR_ZONES, true)
          : null;
      }
      return out;
    }

    function composeSceneIncremental(geo, hub, layersOpt, forceTreeMode) {
      const src = hub.sources;
      const ok = id => src[id] && src[id].state === 'ok' && src[id].data;
      const sigOf = id => `${src[id].state}:${src[id].run}`;


      const waterFlatSig = ok('vectors') ? sigOf('vectors') : 'none';
      const roadLevelSig = (layersOpt.levelRoads !== false && ok('vectors'))
        ? `${sigOf('vectors')}:${layersOpt.roadsPaved !== false ? 1 : 0}:${layersOpt.roadsTrail !== false ? 1 : 0}`
        : 'off';
      const demSig = `${geo.key}|${sigOf('demOuter')}|${sigOf('demMid')}|${sigOf('demInner')}|${waterFlatSig}|${roadLevelSig}`;
      const bldSig = `${demSig}|${sigOf('vectors')}`;
      const vecSig = `${geo.key}|${sigOf('vectors')}|${layersOpt.roadPavedWidth}|${layersOpt.roadTrailWidth}|${layersOpt.riverWidth}`;
      const mode = forceTreeMode || layersOpt.treeMode || 'mass';
      const treesActive = layersOpt.trees !== false || !!forceTreeMode;
      const canopyBaseSig = `${demSig}|${sigOf('canopy')}|${sigOf('canopyFar')}`;
      const poiSig = `${demSig}|${sigOf('osm')}|${sigOf('vectors')}`;

      const sc = sceneCache;

      // 1. Рельеф (пересчитываем при готовности DEM или появлении водной маски)
      if (sc.demSig !== demSig) {
        const outerD = ok('demOuter') ? src.demOuter.data : null;
        const midD   = ok('demMid')   ? src.demMid.data   : null;
        const innerD = ok('demInner') ? src.demInner.data : null;
        const wm     = ok('vectors')  ? getWaterPolyMask(src.vectors.data) : null;

        let outerH;
        if (outerD) {
          outerH = outerD.height;
        } else {
          outerH = new Float32Array(OUTER_N * OUTER_N);
          if (midD || innerD) {
            const cell = (2 * OUTER_HALF) / (OUTER_N - 1);
            for (let j = 0; j < OUTER_N; j++) {
              const wz = -OUTER_HALF + j * cell;
              for (let i = 0; i < OUTER_N; i++) {
                const wx = -OUTER_HALF + i * cell;
                outerH[j * OUTER_N + i] = midD
                  ? sampleGridBilinear(midD.height, MID_N, MID_N, MID_HALF, wx, wz)
                  : sampleGridBilinear(innerD.height, INNER_N, INNER_N, INNER_HALF, wx, wz);
              }
            }
          }
        }
        const midH   = midD   ? new Float32Array(midD.height) : null;
        const innerH = innerD ? new Float32Array(innerD.height) : new Float32Array(INNER_N * INNER_N);

        if (midH && wm) flattenDemGridByWaterMask(midH, MID_N, MID_N, 0, 0, MID_HALF, wm);

        const sampleFallbackForMid = (wx, wz) => outerD ? sampleGridBilinear(outerH, OUTER_N, OUTER_N, OUTER_HALF, wx, wz) : 0;
        const sampleFallbackForInner = (wx, wz) => {
          if (midH) return sampleGridBilinear(midH, MID_N, MID_N, MID_HALF, wx, wz);
          if (outerD) return sampleGridBilinear(outerH, OUTER_N, OUTER_N, OUTER_HALF, wx, wz);
          return 0;
        };

        if (!innerD && (midH || outerD)) {
          const cell = (2 * INNER_HALF) / (INNER_N - 1);
          for (let j = 0; j < INNER_N; j++) {
            const wz = -INNER_HALF + j * cell;
            for (let i = 0; i < INNER_N; i++) innerH[j * INNER_N + i] = sampleFallbackForInner(-INNER_HALF + i * cell, wz);
          }
        }

        if (outerD && midH) {
          const cell = (2 * MID_HALF) / (MID_N - 1);
          for (let j = 0; j < MID_N; j++) {
            const wz = -MID_HALF + j * cell;
            for (let i = 0; i < MID_N; i++) {
              const wx = -MID_HALF + i * cell;
              const edgeFrac = Math.max(Math.abs(wx), Math.abs(wz)) / MID_HALF;
              if (edgeFrac > 0.85) {
                const k = j * MID_N + i;
                midH[k] = lerp(midH[k], sampleFallbackForMid(wx, wz), smooth(0.85, 1.0, edgeFrac));
              }
            }
          }
        }

        if (innerD && layersOpt.levelRoads !== false && ok('vectors')) {
          levelDemGridByRoads(innerH, INNER_N, INNER_N, 0, 0, INNER_HALF, src.vectors.data, {
            paved: layersOpt.roadsPaved !== false,
            trails: layersOpt.roadsTrail !== false
          });
        }
        if (innerD && wm) flattenDemGridByWaterMask(innerH, INNER_N, INNER_N, 0, 0, INNER_HALF, wm);



        if (innerD && (midH || outerD)) {
          const cell = (2 * INNER_HALF) / (INNER_N - 1);
          for (let j = 0; j < INNER_N; j++) {
            const wz = -INNER_HALF + j * cell;
            for (let i = 0; i < INNER_N; i++) {
              const wx = -INNER_HALF + i * cell;
              const edgeFrac = Math.max(Math.abs(wx), Math.abs(wz)) / INNER_HALF;
              if (edgeFrac > 0.85) {
                const k = j * INNER_N + i;
                innerH[k] = lerp(innerH[k], sampleFallbackForInner(wx, wz), smooth(0.85, 1.0, edgeFrac));
              }
            }
          }
        }

        const sampleElevAbs = (wx, wz) => {
          if (Math.abs(wx) <= INNER_HALF * 0.96 && Math.abs(wz) <= INNER_HALF * 0.96) return sampleGridBilinear(innerH, INNER_N, INNER_N, INNER_HALF, wx, wz);
          if (midH && Math.abs(wx) <= MID_HALF * 0.96 && Math.abs(wz) <= MID_HALF * 0.96) return sampleGridBilinear(midH, MID_N, MID_N, MID_HALF, wx, wz);
          if (Math.abs(wx) <= OUTER_HALF && Math.abs(wz) <= OUTER_HALF) return sampleGridBilinear(outerH, OUTER_N, OUTER_N, OUTER_HALF, wx, wz);
          return outerD ? outerD.hMin : (midD ? midD.hMin : 0);
        };

        const h0 = sampleElevAbs(0, 0);
        let hMin = outerD ? outerD.hMin : h0;
        let hMax = outerD ? outerD.hMax : h0 + 100;
        if (midD) { hMin = Math.min(hMin, midD.hMin); hMax = Math.max(hMax, midD.hMax); }
        if (innerD) { hMin = Math.min(hMin, innerD.hMin); hMax = Math.max(hMax, innerD.hMax); }
        if (hMax - hMin < 10) hMax = hMin + 10;

        const innerMesh = buildGridMesh(innerH, INNER_N, INNER_N, INNER_HALF, h0, 0);
        const midMesh   = midH ? buildGridMesh(midH, MID_N, MID_N, MID_HALF, h0, INNER_HALF * 0.84) : null;
        const outerMesh = buildGridMesh(outerH, OUTER_N, OUTER_N, OUTER_HALF, h0, (midMesh ? MID_HALF : INNER_HALF) * 0.84);

        Object.assign(sc, {
          demSig, geo, h0, hMin, hMax, relief: hMax - hMin,
          demOk: !!(outerD || midD || innerD),
          innerH, midH, outerH, // <-- ДОБАВИТЬ
          innerMesh, midMesh, outerMesh,
          sampleElevAbs,
          sampleRawY: (wx, wz) => sampleElevAbs(wx, wz) - h0,
          _visVer: (sc._visVer || 0) + 1
        });
      }

      // 2. Здания
      if (sc.bldSig !== bldSig) {
        sc.bldSig = bldSig;
        sc.buildingMesh = (ok('vectors') && src.vectors.data.buildingFeatures && src.vectors.data.buildingFeatures.length)
          ? buildBuildingsMesh(src.vectors.data.buildingFeatures, sc.sampleElevAbs, sc.h0)
          : null;
      }

      // 3. Векторная текстура дорог/рек (не зависит от DEM — не перерисовываем при догрузке DEM)
      if (sc.vecSig !== vecSig) {
        sc.vecSig = vecSig;
        sc.vecCanvas = ok('vectors') ? rasterizeVectorsCanvas(src.vectors.data, layersOpt) : null;
      }

      // 4. Лес (сброс кэша обоих режимов только при изменении canopy или DEM)
      if (sc.canopyBaseSig !== canopyBaseSig) {
        sc.canopyBaseSig = canopyBaseSig;
        sc.canopyData = null; sc.canopyCount = 0; sc.canopyChunks = null;
        sc.canopyFarData = null; sc.canopyFarCount = 0; sc.canopyFarChunks = null;
        sc.canopyBuilt = false; sc.canopyMassSig = 'none';
        sc.canopyNearRaw = ok('canopy') ? src.canopy.data : null;
        sc.canopyFarRaw  = ok('canopyFar') ? src.canopyFar.data : null;


        sc.canopySurfMesh = null; sc.canopyFarSurfMesh = null; sc.canopyFarHalf = CANOPY_FAR_HALF;
        sc.treeData = null; sc.treeCount = 0; sc.treesBuilt = false; sc.canopyTreesSig = 'none';
        sc.sampleCanopySurfRawH = (wx, wz) => {
          const csm = sc.canopySurfMesh;
          if (!csm) return -1.5;
          const u = clamp((wx + CANOPY_HALF) / (2 * CANOPY_HALF), 0, 1);
          const v = clamp((wz + CANOPY_HALF) / (2 * CANOPY_HALF), 0, 1);
          const gx = u * (CANOPY_N - 1), gz = v * (CANOPY_N - 1);
          const x0 = Math.min(Math.floor(gx), CANOPY_N - 2);
          const z0 = Math.min(Math.floor(gz), CANOPY_N - 2);
          const fx = gx - x0, fz = gz - z0;
          const sv = csm.verts;
          const k = z0 * CANOPY_N + x0;
          const h00 = sv[k * 4 + 3], h10 = sv[(k + 1) * 4 + 3];
          const h01 = sv[(k + CANOPY_N) * 4 + 3], h11 = sv[(k + CANOPY_N + 1) * 4 + 3];
          return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
        };
        sc._visVer = (sc._visVer || 0) + 1;
      }

      // Ленивая сборка только активного режима леса
      if (treesActive) {
        const hasAnyCanopy = ok('canopy') || ok('canopyFar');
        if (mode === 'mass' && !sc.canopyBuilt) {
          sc.canopyBuilt = true;
          const imp = hasAnyCanopy ? assembleCanopyImpostors(src, sc.sampleElevAbs, sc.h0, 'both') : null;
          sc.canopyData = imp && imp.near ? imp.near.data : null;
          sc.canopyCount = imp && imp.near ? imp.near.count : 0;
          sc.canopyChunks = imp && imp.near ? imp.near.chunks : null;
          sc.canopyFarData = imp && imp.far ? imp.far.data : null;
          sc.canopyFarCount = imp && imp.far ? imp.far.count : 0;
          sc.canopyFarChunks = imp && imp.far ? imp.far.chunks : null;
          sc.canopyMassSig = hasAnyCanopy ? canopyBaseSig : 'none';
        } else if (mode === 'trees' && !sc.treesBuilt) {
          sc.treesBuilt = true;
          sc.canopySurfMesh = ok('canopy')
            ? buildCanopySurfaceMesh(src.canopy.data, sc.sampleElevAbs, sc.h0, 0)
            : null;
          sc.canopyFarSurfMesh = ok('canopyFar')
            ? buildCanopySurfaceMesh(
                src.canopyFar.data,
                sc.sampleElevAbs,
                sc.h0,
                ok('canopy') ? ((src.canopy.data.halfM || CANOPY_HALF) - 80) : 0
              )
            : null;
          sc.canopyFarHalf = ok('canopyFar') ? (src.canopyFar.data.halfM || CANOPY_FAR_HALF) : CANOPY_HALF;

          let treeData = null, treeCount = 0;
          if (ok('canopy')) {
            const cd = src.canopy.data;
            const g = cd.grid, cNx = cd.box.Nx, cNy = cd.box.Ny;
            const cell = (2 * CANOPY_HALF) / (cNx - 1);
            const out = [];
            const TARGET_TREES = 12000;
            const HARD_MAX_TREES = 16000;
            const keepProb = cd.count > TARGET_TREES ? (TARGET_TREES / cd.count) : 1.0;

            const fract = v => v - Math.floor(v);
            const hash2 = (x, y) => {
              let px = fract(x * 0.1031), py = fract(y * 0.1031), pz = px;
              const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
              return fract(((px + d) + (py + d)) * (pz + d));
            };

            for (let j = 0; j < cNy && treeCount < HARD_MAX_TREES; j++) {
              const wz = -CANOPY_HALF + j * cell;
              for (let i = 0; i < cNx && treeCount < HARD_MAX_TREES; i++) {
                const wx = -CANOPY_HALF + i * cell;
                if (wx * wx + wz * wz < 144) continue;
                const idx = j * cNx + i;
                const ch = g[idx] / 4;
                if (ch < 2.2) continue;
                if (keepProb < 1.0 && hash2(i + 3.1, j + 7.7) > keepProb) continue;

                let n4 = 0;
                if (i > 0 && g[idx - 1] >= 8) n4++;
                if (i < cNx - 1 && g[idx + 1] >= 8) n4++;
                if (j > 0 && g[idx - cNx] >= 8) n4++;
                if (j < cNy - 1 && g[idx + cNx] >= 8) n4++;
                if (n4 <= 1 && hash2(i + 71.3, j + 11.9) < 0.50) continue;

                const rnd = hash2(wx, wz);
                const rndX = hash2(wx + 19.3, wz + 5.7);
                const rndZ = hash2(wx + 41.1, wz + 23.9);
                const jx = wx + (rndX - 0.5) * cell * 0.9;
                const jz = wz + (rndZ - 0.5) * cell * 0.9;
                const gy = sc.sampleElevAbs(jx, jz) - sc.h0;
                const w = clamp(ch * (0.55 + 0.25 * rnd), 4.0, 17.0);
                out.push(jx, gy, jz, ch, w, rnd);
                treeCount++;
              }
            }
            if (treeCount > 0) treeData = new Float32Array(out);
          }
          sc.treeData = treeData;
          sc.treeCount = treeCount;
          sc.canopyTreesSig = hasAnyCanopy ? canopyBaseSig : 'none';
        }
      }

      // 5. Подписи и POI
      if (sc.poiSig !== poiSig) {
        sc.poiSig = poiSig;
        const pois = [];
        const seen = new Map();
        const pushPoi = (p) => {
          if (Math.abs(p.lat - geo.lat0) > 0.65 || Math.abs(p.lng - geo.lng0) > 1.2) return;
          const { wx, wz } = geo.latLngToWorld(p.lat, p.lng);
          const dist = Math.hypot(wx, wz);
          if (dist > OUTER_HALF * 0.98) return;
          const key = `${p.cat}:${p.name.toLowerCase()}:${Math.round(wx / 600)},${Math.round(wz / 600)}`;
          const prev = seen.get(key);
          if (prev) {
            if (!prev.pop && p.pop) {
              prev.pop = p.pop;
              prev.prio = Math.max(prev.prio, computePoiPrio(prev.cat, prev.kind, prev.ele, p.pop, true, prev.way_area));
            }
            return;
          }

          const demEle = sc.sampleElevAbs(wx, wz);
          const ele = p.ele != null ? p.ele : demEle;
          const prio = Number(p.prio) || computePoiPrio(p.cat, p.kind, p.ele, p.pop, true, p.way_area);
          const entry = {
            ...p,
            prio,
            wx, wz,
            ele,
            rawY: ele - sc.h0,
            demRawY: demEle - sc.h0,
            dist0: dist
          };
          seen.set(key, entry);
          pois.push(entry);
        };

        if (ok('osm')) src.osm.data.forEach(pushPoi);
        if (ok('vectors') && src.vectors.data.fallbackPlaces) src.vectors.data.fallbackPlaces.forEach(pushPoi);
        pois.sort((a, b) => (b.prio - a.prio) || ((b.ele || 0) - (a.ele || 0)) || (a.dist0 - b.dist0));
        sc.pois = pois;
      }

      return sc;
    }

    function syncSceneNow() {
      if (destroyed || !geo || !hub || !R) return;
      S = composeSceneIncremental(geo, hub, ST.layers);
      R.uploadScene(S);
    }
    let sunPos = { alt: 0.5, az: 2.2 }, moonPos = { alt: -0.3, az: 5.0, illum: 0.4, phase: 0.5 }, atm = null;
    let viewW = 0, viewH = 0;
    let labelBoxes = [], selectedPoi = null;
    let raf = 0, dirty = true, min = false, destroyed = false;
    // Динамическое разрешение: срабатывает только если при движении устойчиво < ~18 к/с (на мощных устройствах не включается)
    let glResScale = 1, slowFrames = 0, fastFrames = 0, resDownCount = 0;
    let idleTrimTm = 0;
    let sensorListening = false, sensorHeadingSmooth = null;

    const mView = new Float32Array(16), mProj = new Float32Array(16), mVP = new Float32Array(16), mInv = new Float32Array(16);

    // DOM элементы
    const glCanvas = el('canvas', { class: 'pkv-gl', tabindex: 0 });
    const hudCanvas = el('canvas', { class: 'pkv-hud' });
    const chipsEl = el('div', { class: 'pkv-chips' });
    const toastEl = el('div', { class: 'pkv-toast' });
    const msgEl = el('div', { class: 'pkv-msg' }, el('div', { class: 'pkv-spin' }), el('span', { text: 'Загрузка рельефа…' }));
    const poiCard = el('div', { class: 'pkv-poi-card' });



    const joyEl = el('div', { class: 'pkv-joy' });
    const joyKnob = el('div', { class: 'pkv-joy-knob' });
    joyEl.append(joyKnob);

    const edgeAlertEl = el('div', { class: 'pkv-edge-alert', text: 'нажмите кнопку обновить вверху для загрузки новой зоны' });
    const forestAlertEl = el('div', { class: 'pkv-forest-alert' });
    const viewEl = el('div', { class: 'pkv-view' }, glCanvas, hudCanvas, chipsEl, edgeAlertEl, forestAlertEl, poiCard, joyEl, toastEl, msgEl);
    const panelEl = el('aside', { class: 'pkv-panel' + (ST.panel ? '' : ' hide') });
    const tabsEl = el('div', { class: 'pkv-tabs' });
    const pagesEl = el('div', { class: 'pkv-pages' });
    panelEl.append(tabsEl, pagesEl);

    const dotsEl = el('div', { class: 'pkv-dots', title: 'Источники данных' });
    const headTitle = el('span', { class: 'pkv-title', text: '⛰️ Пики гор' });


    const brandEl = el('div', { class: 'pkv-brand' }, headTitle, dotsEl);

    const bRefreshCenter = el('button', { class: 'pkv-b', type: 'button', title: 'Перезагрузить сцену в текущей точке камеры' }, '🔄');
    const bSensor = el('button', { class: 'pkv-b' + (ST.camera.sensorOn ? ' act' : ''), type: 'button', title: 'Вращение компасом/гироскопом' }, '🧭');
    const bPanel = el('button', { class: 'pkv-b' + (ST.panel ? ' act' : ''), type: 'button', title: 'Настройки' }, '⚙️');
    const bMax = el('button', { class: 'pkv-b', type: 'button', title: 'Развернуть / вернуть' }, '⛶');
    const bMin = el('button', { class: 'pkv-b', type: 'button', title: 'Свернуть' }, '▁');
    const bClose = el('button', { class: 'pkv-b', type: 'button', title: 'Закрыть' }, '✕');

    const headEl = el('div', { class: 'pkv-head' }, brandEl, bRefreshCenter, bSensor, bPanel, bMax, bMin, bClose);
    const footEl = el('div', { class: 'pkv-foot', text: 'Клик по вершине — детали · Drag — обзор · WASD / Стик — шаг' });
    const rzEl = el('div', { class: 'pkv-rz' });

    const winEl = el('div', { class: 'pkv-win' }, headEl, el('div', { class: 'pkv-main' }, viewEl, panelEl), footEl, rzEl);
    const pillTxt = el('span', { text: '…' });
    const pillEl = el('div', { class: 'pkv-pill' },
      el('span', { text: '⛰️ Пики гор' }), pillTxt,
      el('button', { class: 'pkv-b', type: 'button', onclick: () => I.restore() }, '▲'),
      el('button', { class: 'pkv-b', type: 'button', onclick: () => api.close() }, '✕')
    );

    // Правые быстрые кнопки на канвасе (Зум, Высота, Домой)
    function syncTreeUiControls() {
      const L = ST.layers;
      if (bTreeModeQuick) {
        bTreeModeQuick.textContent = L.trees === false ? '🚫' : ((L.treeMode || 'mass') === 'mass' ? '🌊' : '🌲');
      }
      if (refs.treeUi.massTerrainContoursChk) {
        refs.treeUi.massTerrainContoursChk.input.checked = !!L.massTerrainContours;
      }
      if (refs.treeUi.forestShadowChk) refs.treeUi.forestShadowChk.input.checked = !!L.castForestShadows;
      if (refs.treeUi.forestShadowMassChk) refs.treeUi.forestShadowMassChk.input.checked = !!L.castForestShadows;
      if (!refs.treeUi) return;
      refs.treeUi.treeChk.input.checked = L.trees !== false;
      refs.treeUi.treeModeSel.value = L.treeMode || 'mass';
      refs.treeUi.treeModeSel.disabled = (L.trees === false);
      refs.treeUi.canopyOpRng.input.value = L.canopyOpacity != null ? L.canopyOpacity : 1.0;
      refs.treeUi.canopyOpRng.upd();
      if (refs.treeUi.canopyScaleRng) {
        refs.treeUi.canopyScaleRng.input.value = L.canopyScale != null ? L.canopyScale : 0.95;
        refs.treeUi.canopyScaleRng.upd();
      }
      if (refs.treeUi.canopyMinHRng) {
        refs.treeUi.canopyMinHRng.input.value = L.canopyMinH != null ? L.canopyMinH : 3.5;
        refs.treeUi.canopyMinHRng.upd();
      }
      if (refs.treeUi.canopyWaveRng) {
        refs.treeUi.canopyWaveRng.input.value = L.canopyWave != null ? L.canopyWave : 1.5;
        refs.treeUi.canopyWaveRng.upd();
      }
      const isOff = L.trees === false;
      const isMass = (L.treeMode || 'mass') === 'mass';
      refs.treeUi.massSubEl.style.display = isMass ? '' : 'none';
      refs.treeUi.massSubEl.classList.toggle('off', isOff);
      if (refs.treeUi.treesSubEl) {
        refs.treeUi.treesSubEl.style.display = isMass ? 'none' : '';
        refs.treeUi.treesSubEl.classList.toggle('off', isOff);
      }
      if (refs.treeUi.treeLinesChk) refs.treeUi.treeLinesChk.input.checked = L.treeHeightLines !== false;
      if (refs.treeUi.hideOccTerrChk) refs.treeUi.hideOccTerrChk.input.checked = L.hideOccludedTerrainLines !== false;
      if (refs.treeUi.forestShadowChk) refs.treeUi.forestShadowChk.input.checked = !!L.castForestShadows;
      if (refs.treeUi.forestShadowMassChk) refs.treeUi.forestShadowMassChk.input.checked = !!L.castForestShadows;
    }

    const bTreeModeQuick = el('button', {
      class: 'pkv-rc-b', type: 'button', title: 'Переключить режим леса (Массив / Деревья / Выкл)',
      text: ST.layers.trees === false ? '🚫' : ((ST.layers.treeMode || 'mass') === 'mass' ? '🌳' : '🌲'),
      onclick: () => {
        if (ST.layers.trees === false) {
          ST.layers.trees = true; ST.layers.treeMode = 'mass';
          toast('🌲 Лес: сплошной волнистый массив');
        } else if ((ST.layers.treeMode || 'mass') === 'mass') {
          ST.layers.treeMode = 'trees';
          toast('🌳 Лес: отдельные деревья');
        } else {
          ST.layers.trees = false;
          toast('🚫 Лес скрыт');
        }
        syncTreeUiControls();
        save();
        syncSceneNow();
        requestRender();
      }

    });

    
    function makeHoldRepeatBtn(attrs, svgHtml, onStep, onRelease) {
      let holdDelay = 0, holdRaf = 0, holding = false;
      const stopHold = (commit) => {
        const wasHolding = holding;
        holding = false;
        if (holdDelay) { clearTimeout(holdDelay); holdDelay = 0; }
        if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; }
        if (commit && wasHolding) {
          if (onRelease) onRelease();
          else save();
        }
      };
      const btn = el('button', {
        ...attrs,
        class: 'pkv-rc-b',
        type: 'button',
        html: svgHtml,
        onpointerdown: e => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
          stopHold(false);
          holding = true;
          onStep(0.5);
          holdDelay = setTimeout(() => {
            holdDelay = 0;
            if (!holding || destroyed || min) return;
            const holdStart = performance.now();
            let lastT = holdStart;
            const tick = now => {
              holdRaf = 0;
              if (!holding || destroyed || min) { stopHold(false); return; }
              const dt = Math.min((now - lastT) / 1000, 0.05);
              lastT = now;
              const elapsed = Math.max(0, (now - holdStart) / 1000);
              const speed = Math.min(85, 4 + 14 * elapsed + 22 * elapsed * elapsed);
              if (dt > 0) onStep(speed * dt);
              holdRaf = requestAnimationFrame(tick);
            };
            holdRaf = requestAnimationFrame(tick);
          }, 220);
        },
        onpointerup: () => stopHold(true),
        onpointercancel: () => stopHold(true),
        onlostpointercapture: () => stopHold(true),
        onkeydown: e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onStep(0.5);
            if (onRelease) onRelease();
            else save();
          }
        }
      });
      cleanups.push(() => stopHold(false));
      return btn;
    }

    const svgUp = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 3.5L13.5 11.5H2.5Z"/></svg>';
    const svgDown = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 12.5L13.5 4.5H2.5Z"/></svg>';



    const cleanups = [];
    const listen = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); cleanups.push(() => t.removeEventListener(ev, fn, opt)); };

    let bHeightUp = null, bHeightDown = null;

    function syncHeightBtnsState() {
      const h = ST.camera.eyeHeight || 2.0;
      if (bHeightDown) bHeightDown.classList.toggle('pkv-dim', h <= 1.5);
      if (bHeightUp) bHeightUp.classList.toggle('pkv-dim', h >= 180);
    }


      

    bHeightUp = makeHoldRepeatBtn(
      { title: 'Подняться выше (+0.5м, можно зажать)' },
      svgUp,
      delta => setEyeHeight(ST.camera.eyeHeight + delta, true),
      () => setEyeHeight(ST.camera.eyeHeight, false)
    );
    bHeightDown = makeHoldRepeatBtn(
      { title: 'Опуститься ниже (-0.5м, можно зажать)' },
      svgDown,
      delta => setEyeHeight(ST.camera.eyeHeight - delta, true),
      () => setEyeHeight(ST.camera.eyeHeight, false)
    );


    const rCtrls = el('div', { class: 'pkv-rctrls' },
      el('button', { class: 'pkv-rc-b', type: 'button', title: 'Приблизить (Зум +)', onclick: () => setFov(cam.fov * 0.72) }, '🔍+'),
      el('button', { class: 'pkv-rc-b', type: 'button', title: 'Отдалить (Зум -)', onclick: () => setFov(cam.fov / 0.72) }, '🔍−'),

      bHeightUp,
      bHeightDown,
      bTreeModeQuick,
      el('button', { class: 'pkv-rc-b', type: 'button', title: 'Посмотреть на карте', onclick: () => I.showOnMap() }, '🗺️'),
      el('button', { class: 'pkv-rc-b', type: 'button', title: 'Вернуться в стартовую точку (2м)', onclick: () => resetToStart() }, '🏠')
    );
    viewEl.append(rCtrls);
    syncHeightBtnsState();

    const perfSpark = el('canvas', { class: 'pkv-perf-cv', width: 220, height: 34 });
    const perfTitle = el('span', { text: '-- FPS' });
    const bPerfStress = el('button', {
      class: 'pkv-b' + (ST.view.perfContinuous ? ' act' : ''),
      type: 'button', title: 'Непрерывный рендер (стресс-тест FPS)', text: '⚡',
      onclick: () => {
        ST.view.perfContinuous = !ST.view.perfContinuous;
        bPerfStress.classList.toggle('act', ST.view.perfContinuous);
        save();
        requestRender();
      }
    });
    const perfSparkCtx = perfSpark.getContext('2d');
    const perfGrid = el('div', { class: 'pkv-perf-grid' });
    const perfValEls = [];
    [
      'Кадр / JS+GL / HUD',
      'GPU (timer query)',
      'Буфер (DPR)',
      'Draw / Всего трис',
      'Рельеф / Здания',
      'Лес (трис)',
      'POI (видим / плашки)',
      'Кэш (DEM/Лес/POI)'
    ].forEach(label => {
      const valEl = el('b', { text: '-' });
      perfValEls.push(valEl);
      perfGrid.append(el('span', { text: label }), valEl);
    });

    const perfEl = el('div', { class: 'pkv-perf' + (ST.view.perfOverlay ? ' on' : '') },
      el('div', { class: 'pkv-perf-h' },
        perfTitle, el('span', { class: 'pkv-sp' }), bPerfStress,
        el('button', { class: 'pkv-b', type: 'button', text: '✕', onclick: () => togglePerf(false) })
      ),
      perfSpark,
      perfGrid
    );
    viewEl.append(perfEl);


    function togglePerf(on) {
      ST.view.perfOverlay = on != null ? !!on : !ST.view.perfOverlay;
      perfEl.classList.toggle('on', ST.view.perfOverlay);
      if (refs.chkPerf) refs.chkPerf.input.checked = ST.view.perfOverlay;
      save();
      requestRender();
    }


    const perfHist = [];
    let hudStat = { ms: 0, cand: 0, drawn: 0 };
    let lastPerfUiTs = 0;
    let qDprLast = 1;

    function updatePerfUi(nowTs, frameMs, isActiveFrame) {
      if (!ST.view.perfOverlay) return;
      perfHist.push(frameMs);
      if (perfHist.length > 64) perfHist.shift();
      if (nowTs - lastPerfUiTs < 180 && isActiveFrame) return;
      lastPerfUiTs = nowTs;

      const sum = perfHist.reduce((a, b) => a + b, 0);
      const avgMs = sum / (perfHist.length || 1);
      const maxMs = Math.max(...perfHist, 0.1);
      const fps = Math.min(240, Math.round(1000 / Math.max(avgMs, 1)));
      const minFps = Math.min(240, Math.round(1000 / Math.max(maxMs, 1)));

      perfTitle.textContent = isActiveFrame
        ? `${fps} FPS (min ${minFps})`
        : `${fps} FPS · IDLE`;
      perfTitle.style.color = fps >= 50 ? '#3fb950' : (fps >= 28 ? '#d29922' : '#f85149');

      const scx = perfSparkCtx;
      const W = perfSpark.width, H = perfSpark.height;
      scx.clearRect(0, 0, W, H);
      const scaleMax = Math.max(40, maxMs * 1.15);

      [16.67, 33.33].forEach((refMs, idx) => {
        const y = H - (refMs / scaleMax) * H;
        if (y > 1 && y < H) {
          scx.strokeStyle = idx === 0 ? 'rgba(63,185,80,0.45)' : 'rgba(210,153,34,0.45)';
          scx.beginPath(); scx.moveTo(0, y); scx.lineTo(W, y); scx.stroke();
        }
      });

      const bw = W / 64;
      for (let i = 0; i < perfHist.length; i++) {
        const ms = perfHist[i];
        const bh = clamp((ms / scaleMax) * H, 1, H);
        scx.fillStyle = ms <= 17 ? '#3fb950' : (ms <= 34 ? '#d29922' : '#f85149');
        scx.fillRect(i * bw, H - bh, Math.max(1, bw - 0.5), bh);
      }

      const st = R ? R.stats : {};
      const totalTris = (st.terrainTris || 0) + (st.bldTris || 0) + (st.canopyTris || 0) + (st.treeTris || 0);
      const demMemoCnt = typeof demTileMemo !== 'undefined' ? demTileMemo.size : 0;
      const vals = [
        `${frameMs.toFixed(1)} / ${(st.glSubmitMs || 0).toFixed(1)} / ${hudStat.ms.toFixed(1)} мс`,
        st.gpuMs != null ? `${st.gpuMs.toFixed(2)} мс` : 'н/д',
        `${st.rw || 0}×${st.rh || 0} (${qDprLast.toFixed(2)}x)`,
        `${st.drawCalls || 0} / ${(totalTris / 1000).toFixed(1)}k`,
        `${((st.terrainTris || 0) / 1000).toFixed(0)}k / ${((st.bldTris || 0) / 1000).toFixed(1)}k`,
        `${(((st.canopyTris || 0) + (st.treeTris || 0)) / 1000).toFixed(1)}k`,
        `${hudStat.cand} / ${hudStat.drawn}`,
        `${demMemoCnt} / ${canopyTileMemo.size} / ${mvtPoiTileCache.size}`
      ];
      for (let i = 0; i < perfValEls.length; i++) {
        if (perfValEls[i].textContent !== vals[i]) perfValEls[i].textContent = vals[i];
      }
    }

    let toastTm = 0;
    const toast = t => {
      toastEl.textContent = t; toastEl.classList.add('on');
      clearTimeout(toastTm); toastTm = setTimeout(() => toastEl.classList.remove('on'), 3200);
    };

    let inFrame = false;
    const requestRender = () => {
      dirty = true;
      if (!inFrame && !raf && !min && !destroyed && R) raf = requestAnimationFrame(frame);
    };


    // --- Управление временем и астрономией ---
    function getSkyMs() {
      if (ST.sky.timeMode === 'now') return Date.now();
      const now = new Date();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ST.sky.date || '');
      const y = m ? +m[1] : now.getFullYear();
      const mo = m ? +m[2] - 1 : now.getMonth();
      const d = m ? +m[3] : now.getDate();
      const lng = geo ? geo.lng0 : 0;
      return Date.UTC(y, mo, d) + (ST.sky.hour - lng / 15) * 3600000;
    }

    let arcCacheKey = '';
    let sunArcDirs = [], sunHourDirs = [];
    let moonArcDirs = [], moonHourDirs = [];

    function updateAstro() {
      if (!geo) return;
      const ms = getSkyMs();
      sunPos = sunPosition(ms, geo.lat0, geo.lng0);
      moonPos = moonPosition(ms, geo.lat0, geo.lng0);
      atm = computeAtmosphere(sunPos.alt, moonPos, ST.view.darkTheme);

      const baseDayMs = Math.floor(ms / 86400000) * 86400000 - (geo.lng0 / 15) * 3600000;
      const key = `${geo.key}|${baseDayMs}`;
      if (key !== arcCacheKey) {
        arcCacheKey = key;
        sunArcDirs = []; sunHourDirs = [];
        moonArcDirs = []; moonHourDirs = [];
        for (let m = 0; m <= 1440; m += 20) {
          const t = baseDayMs + m * 60000;
          const ps = sunPosition(t, geo.lat0, geo.lng0);
          sunArcDirs.push(ps.alt < -4 * DEG ? null : dirFromAltAz(ps.alt, ps.az));
          const pm = moonPosition(t, geo.lat0, geo.lng0);
          moonArcDirs.push(pm.alt < -4 * DEG ? null : dirFromAltAz(pm.alt, pm.az));
        }
        for (let hr = 0; hr < 24; hr += 3) {
          const t = baseDayMs + hr * 3600000;
          const ps = sunPosition(t, geo.lat0, geo.lng0);
          if (ps.alt >= 1 * DEG) sunHourDirs.push({ hr, dir: dirFromAltAz(ps.alt, ps.az) });
          const pm = moonPosition(t, geo.lat0, geo.lng0);
          if (pm.alt >= 1 * DEG) moonHourDirs.push({ hr, dir: dirFromAltAz(pm.alt, pm.az) });
        }
      }
    }

    // --- Датчики ориентации (компас / гироскоп) ---
    function computeDeviceHeading(e) {
      if (typeof e.webkitCompassHeading === 'number') return (e.webkitCompassHeading + 360) % 360;
      if (e.alpha == null) return null;
      const a = (e.alpha || 0) * DEG, b = (e.beta || 0) * DEG, g = (e.gamma || 0) * DEG;
      const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
      const east = -sA * cG - cA * sB * sG, north = cA * cG - sA * sB * sG;
      const scr = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * DEG;
      const rE = east * Math.cos(scr) - north * Math.sin(scr);
      const rN = east * Math.sin(scr) + north * Math.cos(scr);
      return ((Math.atan2(rE, rN) / DEG) + 360) % 360;
    }

    function onOrientation(e) {
      if (!ST.camera.sensorOn || destroyed || min) return;
      const rawH = computeDeviceHeading(e);
      if (rawH == null || isNaN(rawH)) return;
      const pdrOff = (WM.pdr && WM.pdr.getAlignmentOffset) ? WM.pdr.getAlignmentOffset() : 0;
      const h = (rawH + (ST.camera.compassOffset || 0) + pdrOff + 360) % 360;
      if (sensorHeadingSmooth == null) sensorHeadingSmooth = h;
      else sensorHeadingSmooth = unwrapAngle(h, sensorHeadingSmooth);
      cam.yaw = (sensorHeadingSmooth % 360) * DEG;

      // Мягкий тангаж по наклону телефона (beta ≈ 90° вертикально = 0° горизонтально)
      if (typeof e.beta === 'number') {
        const tiltRad = clamp((e.beta - 90) * DEG, -65 * DEG, 70 * DEG);
        cam.pitch = lerp(cam.pitch, tiltRad, 0.25);
      }
      requestRender();
    }

    async function setSensorMode(on) {
      if (on) {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          try {
            const res = await DeviceOrientationEvent.requestPermission();
            if (res !== 'granted') { toast('Нет доступа к датчикам ориентации'); return; }
          } catch (e) { toast('Датчики недоступны'); return; }
        }
        if (!sensorListening) {
          if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientation, true);
          else window.addEventListener('deviceorientation', onOrientation, true);
          sensorListening = true;
        }
        ST.camera.sensorOn = true;
        toast('🧭 Управление по компасу и гироскопу включено');
      } else {
        stopSensor();
        ST.camera.sensorOn = false;
      }
      bSensor.classList.toggle('act', ST.camera.sensorOn);
      if (refs.chkSensor) refs.chkSensor.input.checked = ST.camera.sensorOn;
      save();
      requestRender();
    }

    function stopSensor() {
      if (!sensorListening) return;
      window.removeEventListener('deviceorientationabsolute', onOrientation, true);
      window.removeEventListener('deviceorientation', onOrientation, true);
      sensorListening = false;
      sensorHeadingSmooth = null;
    }

    // --- Позиционирование и зум ---
    function setFov(next) {
      cam.fov = clamp(next, 6, 82);
      ST.view.fov = Math.round(cam.fov);
      if (refs.fov) { refs.fov.input.value = ST.view.fov; refs.fov.upd(); }
      save();
      requestRender();
    }

    let lastEyeUiStep = null;
    function setEyeHeight(h, skipSave) {
      const nextH = clamp(skipSave ? h : Math.round(h * 10) / 10, 1.5, 180);
      ST.camera.eyeHeight = nextH;
      const uiStep = Math.round(nextH * 2);
      if (uiStep !== lastEyeUiStep) {
        lastEyeUiStep = uiStep;
        if (refs.eyeH) { refs.eyeH.input.value = nextH; refs.eyeH.upd(); }
        syncHeightBtnsState();
      }
      if (!skipSave) save();
      requestRender();
    }

    function resetToStart() {
      cam.x = 0; cam.z = 0;
      cam.movingToTarget = false;
      setEyeHeight(2.0);
      toast('🏠 Возврат в стартовую точку (2 м над землёй)');
    }

    function updateJoystickVis() {
      const m = ST.camera.joystick || 'auto';
      const on = m === 'on' || (m === 'auto' && (mobile || ('ontouchstart' in window)));
      joyEl.classList.toggle('on', !!on);
    }

    // --- Геометрия окна ---
    function applyGeom() {
      if (ST.win.max || mobile) { winEl.classList.add('pkv-max'); return; }
      winEl.classList.remove('pkv-max');
      const W = window.innerWidth, H = window.innerHeight;
      const w = clamp(ST.win.w || Math.min(960, W * 0.78), 360, W - 8);
      const h = clamp(ST.win.h || Math.min(680, H * 0.82), 300, H - 8);
      const x = clamp(ST.win.x == null ? (W - w) / 2 : ST.win.x, 0, Math.max(0, W - 120));
      const y = clamp(ST.win.y == null ? 44 : ST.win.y, 0, Math.max(0, H - 60));
      Object.assign(winEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    }

    function toggleMax() { ST.win.max = !ST.win.max; applyGeom(); save(); requestRender(); }

    let bMoved = 0;
    const syncBrandOverflow = () => {
      const canScroll = brandEl.scrollWidth > brandEl.clientWidth + 2;
      const atEnd = brandEl.scrollLeft + brandEl.clientWidth >= brandEl.scrollWidth - 2;
      brandEl.classList.toggle('ovf', canScroll && !atEnd);
    };

    function setupDragWin() {
      let d = null;
      listen(headEl, 'pointerdown', e => {
        if (e.target.closest('button') || winEl.classList.contains('pkv-max')) return;
        if (e.target.closest('.pkv-brand') && (e.target.closest('.pkv-dots') || brandEl.scrollWidth > brandEl.clientWidth + 1)) return;
        const r = winEl.getBoundingClientRect(); d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        headEl.setPointerCapture(e.pointerId);
      });
      let bDrag = null;
      listen(headEl, 'pointermove', e => {
        if (!d) return;
        const x = clamp(e.clientX - d.dx, -200, window.innerWidth - 100);
        const y = clamp(e.clientY - d.dy, 0, window.innerHeight - 40);
        winEl.style.left = x + 'px'; winEl.style.top = y + 'px'; ST.win.x = x; ST.win.y = y;
      });
      const end = () => { if (d) { d = null; save(); } };
      listen(headEl, 'pointerup', end); listen(headEl, 'pointercancel', end);
      listen(headEl, 'dblclick', e => { if (!e.target.closest('button,.pkv-dots') && !mobile) toggleMax(); });

      let r0 = null;
      listen(rzEl, 'pointerdown', e => { const r = winEl.getBoundingClientRect(); r0 = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }; rzEl.setPointerCapture(e.pointerId); e.stopPropagation(); });
      listen(rzEl, 'pointermove', e => {
        if (!r0) return;
        const w = clamp(r0.w + e.clientX - r0.x, 360, window.innerWidth);
        const h = clamp(r0.h + e.clientY - r0.y, 300, window.innerHeight);
        winEl.style.width = w + 'px'; winEl.style.height = h + 'px'; ST.win.w = w; ST.win.h = h;
      });
      const endR = () => { if (r0) { r0 = null; save(); } };
      listen(rzEl, 'pointerup', endR); listen(rzEl, 'pointercancel', endR);
      listen(window, 'resize', () => { applyGeom(); syncBrandOverflow(); requestRender(); });
    }

    // --- Луч в рельеф (picking) ---
    function pickTerrain(px, py) {
      if (!S) return null;
      const w = glCanvas.clientWidth, h = glCanvas.clientHeight;
      if (!w || !h) return null;
      const nx = (px / w) * 2 - 1, ny = 1 - (py / h) * 2;
      const un = z => {
        const a = [nx, ny, z, 1], o = [0, 0, 0, 0];
        for (let r = 0; r < 4; r++) o[r] = mInv[r] * a[0] + mInv[4 + r] * a[1] + mInv[8 + r] * a[2] + mInv[12 + r] * a[3];
        return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
      };
      const p0 = cam.pos, p1 = un(1);
      let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;

      const zScale = ST.view.zScale || 1.0;
      const curv = ST.view.curvature !== false;
      let t = 4.0, step = 12.0, prevT = 0;
      while (t < 46000) {
        const x = p0[0] + dx * t, y = p0[1] + dy * t, z = p0[2] + dz * t;
        if (Math.abs(x) > OUTER_HALF || Math.abs(z) > OUTER_HALF) break;
        const d2 = (x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z);
        const drop = curv ? d2 / 14646000 : 0;
        const gy = S.sampleRawY(x, z) * zScale - drop;
        if (y <= gy) {
          let a = prevT, b = t;
          for (let k = 0; k < 8; k++) {
            const m = (a + b) * 0.5;
            const mx = p0[0] + dx * m, my = p0[1] + dy * m, mz = p0[2] + dz * m;
            const md2 = (mx - cam.x) * (mx - cam.x) + (mz - cam.z) * (mz - cam.z);
            const mgy = S.sampleRawY(mx, mz) * zScale - (curv ? md2 / 14646000 : 0);
            if (my <= mgy) b = m; else a = m;
          }
          const tt = (a + b) * 0.5;
          const hx = p0[0] + dx * tt, hz = p0[2] + dz * tt;
          return { x: hx, z: hz, ele: S.sampleElevAbs(hx, hz), dist: Math.hypot(hx - cam.x, hz - cam.z) };
        }
        prevT = t;
        step = t < 300 ? 6 : (t < 2000 ? 22 : (t < 10000 ? 85 : 220));
        t += step;
      }
      return null;
    }

    // --- Показ карточки выбранного объекта OSM ---
    function showPoiCard(poi, anchor) {
      selectedPoi = poi;
      poiCard.textContent = '';
      if (!poi) { poiCard.classList.remove('on'); requestRender(); return; }

      const dx = poi.wx - cam.x, dz = poi.wz - cam.z;
      const dist = Math.hypot(dx, dz);
      const az = ((Math.atan2(dx, -dz) / DEG) + 360) % 360;
      const obsEle = S ? S.sampleElevAbs(cam.x, cam.z) + ST.camera.eyeHeight : 0;
      const dH = poi.ele - obsEle;
      const catNames = { peak: '⛰️ Вершина', pass: '⛩️ Перевал', volcano: '🌋 Вулкан', settlement: '🏘️ Нас. пункт', locality: '🌾 Урочище', landmark: '🧭 Объект' };
      const catLabel = catNames[poi.kind] || catNames[poi.cat] || '📍 Точка';
      const coordStr = `${poi.lat.toFixed(5)}, ${poi.lng.toFixed(5)}`;

      poiCard.append(
        el('div', { class: 'pkv-poi-h' },
          el('b', { text: poi.name }),
          el('button', { class: 'pkv-b', type: 'button', onclick: () => showPoiCard(null) }, '✕')
        ),
        el('div', { class: 'pkv-poi-meta' },
          el('span', { text: catLabel }),
          el('span', { text: `Высота: ${poi.eleExact ? '' : '~'}${Math.round(poi.ele)} м` }),
          el('span', { text: `Дистанция: ${fmtDist(dist)}` }),
          el('span', { text: `Азимут: ${Math.round(az)}° ${degToCompass(az)}` }),
          el('span', { text: `Превыш.: ${dH >= 0 ? '+' : ''}${Math.round(dH)} м` })
        ),
        el('div', {
          class: 'pkv-poi-coords', title: 'Скопировать координаты', text: '📋 ' + coordStr,
          onclick: async () => {
            try { await navigator.clipboard.writeText(coordStr); toast('📋 Координаты скопированы'); } catch (e) {}
          }
        }),
        el('div', { class: 'pkv-btns' },
          el('button', {
            class: 'pkv-b prime', type: 'button', text: '🎯 Навестись',
            onclick: () => {
              if (ST.camera.sensorOn) setSensorMode(false);
              const zScale = ST.view.zScale || 1.0;
              const drop = ST.view.curvature !== false ? (dx * dx + dz * dz) / 14646000 : 0;
              const ty = poi.rawY * zScale - drop;
              cam.yaw = Math.atan2(dx, -dz);
              cam.pitch = clamp(Math.atan2(ty - cam.y, dist), -70 * DEG, 70 * DEG);
              requestRender();
            }
          }),
          el('button', {
            class: 'pkv-b', type: 'button', text: '🚶 Подойти',
            onclick: () => {
              I.reopenAt(poi.lat, poi.lng, { keepView: true });
              toast(`🚶 Переход в точку: ${poi.name}`);
            }
          })
        )
      );
      poiCard.classList.add('on');

      const W = viewW || viewEl.clientWidth || 320;
      const H = viewH || viewEl.clientHeight || 240;
      const cw = poiCard.offsetWidth || 258;
      const ch = poiCard.offsetHeight || 175;
      const pad = 10;
      const topPad = 46; // чтобы не перекрывать верхнюю полосу компаса

      if (anchor && anchor.keepPos && poiCard.style.left) {
        const curL = parseFloat(poiCard.style.left) || pad;
        const curT = parseFloat(poiCard.style.top) || topPad;
        poiCard.style.left = Math.round(clamp(curL, pad, Math.max(pad, W - cw - pad))) + 'px';
        poiCard.style.top = Math.round(clamp(curT, topPad, Math.max(topPad, H - ch - pad))) + 'px';
      } else {
        let ax = null, ay = null;
        if (anchor && anchor.x != null && anchor.y != null) {
          ax = anchor.x;
          ay = anchor.y;
        } else {
          const lb = labelBoxes.find(b => b.poi === poi);
          if (lb) {
            ax = lb.sx != null ? lb.sx : (lb.x + lb.w * 0.5);
            ay = lb.sy != null ? lb.sy : (lb.y + lb.h);
          } else if (S) {
            const drop = ST.view.curvature !== false ? (dx * dx + dz * dz) / 14646000 : 0;
            const sp = projectWorld(poi.wx, Math.max(poi.rawY, poi.demRawY) * (ST.view.zScale || 1.0) - drop, poi.wz, W, H);
            if (sp && sp.x >= 0 && sp.x <= W && sp.y >= 0 && sp.y <= H) {
              ax = sp.x;
              ay = sp.y;
            }
          }
        }

        let left, top;
        if (ax != null && ay != null) {
          const gap = 14;
          left = (ax + gap + cw <= W - pad) ? (ax + gap) : (ax - cw - gap);
          if (left < pad) left = (W - cw) * 0.5;
          left = clamp(left, pad, Math.max(pad, W - cw - pad));

          const boxTop = anchor && anchor.box ? anchor.box.y : ay;
          if (ay + gap + ch <= H - pad) {
            top = ay + gap;
          } else if (boxTop - gap - ch >= topPad) {
            top = boxTop - gap - ch;
          } else {
            top = ay - ch * 0.5;
          }
          top = clamp(top, topPad, Math.max(topPad, H - ch - pad));
        } else {
          left = Math.max(pad, W - cw - pad);
          top = topPad + 2;
        }

        poiCard.style.right = 'auto';
        poiCard.style.left = Math.round(left) + 'px';
        poiCard.style.top = Math.round(top) + 'px';
      }

      requestRender();
    }

    // --- Ввод (мышь, тач, клавиатура, джойстик) ---
    function setupInput() {
      const ptrs = new Map();
      let pinchDist = 0, tapStart = null, moved = 0;
      let rmbActive = false, rmbFloatH = ST.camera.eyeHeight || 2.0;
      let twoMode = null, twoStartDist = 0, twoStartMidY = 0, twoMidY = 0, twoFloatH = ST.camera.eyeHeight || 2.0;

      listen(glCanvas, 'contextmenu', e => e.preventDefault());

      listen(window, 'keydown', e => {
        if (min || destroyed) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
          keys[e.code] = true;
          cam.movingToTarget = false;
          requestRender();
        } else if (e.key === '=' || e.key === '+') setFov(cam.fov * 0.8);
        else if (e.key === '-') setFov(cam.fov / 0.8);
      });
      listen(window, 'keyup', e => { delete keys[e.code]; });
      listen(window, 'blur', () => {
        for (const k in keys) delete keys[k];
        if (wasMovingUp) {
          wasMovingUp = false;
          ST.camera.eyeHeight = Math.round(ST.camera.eyeHeight * 10) / 10;
          save();
        }
      });

      listen(glCanvas, 'pointerdown', e => {
        glCanvas.setPointerCapture(e.pointerId);
        const isRmb = e.button === 2 || (e.buttons & 2) !== 0;
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: isRmb ? 2 : e.button });
        moved = 0;
        if (isRmb && ptrs.size === 1) {
          rmbActive = true;
          rmbFloatH = ST.camera.eyeHeight || 2.0;
          tapStart = null;
        } else if (ptrs.size === 1) {
          rmbActive = false;
          twoMode = null;
          tapStart = { t: performance.now(), x: e.clientX, y: e.clientY };
        } else if (ptrs.size === 2) {
          rmbActive = false;
          tapStart = null;
          twoMode = null;
          const [a, b] = [...ptrs.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
          twoStartDist = pinchDist;
          twoMidY = (a.y + b.y) * 0.5;
          twoStartMidY = twoMidY;
          twoFloatH = ST.camera.eyeHeight || 2.0;
        } else {
          rmbActive = false;
          tapStart = null;
          twoMode = null;
        }
      });

      let lastHoverPickTs = 0;
      listen(glCanvas, 'pointermove', e => {
        const p = ptrs.get(e.pointerId);
        if (!p) {
          const now = performance.now();
          if (e.pointerType !== 'touch' && S && now - lastHoverPickTs > 90) {
            lastHoverPickTs = now;
            const hit = pickTerrain(e.offsetX, e.offsetY);
            if (hit) {
              const az = ((Math.atan2(hit.x - cam.x, -(hit.z - cam.z)) / DEG) + 360) % 360;
              const ll = geo.worldToLatLng(hit.x, hit.z);
              footEl.textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)} · высота ${Math.round(hit.ele)} м · ${fmtDist(hit.dist)} · ${Math.round(az)}° ${degToCompass(az)}`;
            }
          }
          return;
        }
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);

        if (ptrs.size === 1 && (p.btn === 2 || rmbActive)) {
          // Зажата правая кнопка мыши: движение вверх/вниз меняет высоту камеры
          const stepScale = Math.max(0.08, rmbFloatH * 0.008);
          rmbFloatH = clamp(rmbFloatH + dy * stepScale, 1.5, 180);
          setEyeHeight(rmbFloatH, true);
        } else if (ptrs.size === 1 && moved > 3) {
          if (ST.camera.sensorOn) {
            setSensorMode(false);
            toast('Ручной обзор (компас отключён)');
          }
          const sens = 0.0042 * (cam.fov / 48);
          cam.yaw -= dx * sens;
          cam.pitch = clamp(cam.pitch + dy * sens, -75 * DEG, 78 * DEG);
          requestRender();
        } else if (ptrs.size === 2) {
          const [a, b] = [...ptrs.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const midY = (a.y + b.y) * 0.5;

          if (!twoMode) {
            const ad = Math.abs(d - twoStartDist);
            const am = Math.abs(midY - twoStartMidY);
            if (ad > 12 && ad >= am * 1.15) {
              twoMode = 'pinch';
              pinchDist = d;
            } else if (am > 12 && am > ad * 1.35) {
              twoMode = 'elev';
              twoMidY = midY;
              twoFloatH = ST.camera.eyeHeight || 2.0;
            }
          } else if (twoMode === 'pinch') {
            if (pinchDist > 5 && d > 5) {
              setFov(cam.fov * (pinchDist / d));
            }
            pinchDist = d;
          } else if (twoMode === 'elev') {
            const dMidY = midY - twoMidY;
            twoMidY = midY;
            const stepScale = Math.max(0.08, twoFloatH * 0.008);
            twoFloatH = clamp(twoFloatH + dMidY * stepScale, 1.5, 180);
            setEyeHeight(twoFloatH, true);
          }
        }
      });

      const onUp = e => {
        const p = ptrs.get(e.pointerId);
        ptrs.delete(e.pointerId);
        if (p && p.btn === 2) {
          rmbActive = false;
          setEyeHeight(ST.camera.eyeHeight, false);
          return;
        }
        if (twoMode && ptrs.size < 2) {
          const wasElev = twoMode === 'elev';
          twoMode = null;
          if (wasElev) setEyeHeight(ST.camera.eyeHeight, false);
          return;
        }
        if (!ptrs.size && moved < 7 && tapStart && performance.now() - tapStart.t < 420 && e.type === 'pointerup') {

      
          const r = glCanvas.getBoundingClientRect();
          const px = e.clientX - r.left, py = e.clientY - r.top;

          // 1. Проверяем попадание в подпись вершины/объекта
          const hitPoi = labelBoxes.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
          if (hitPoi) {
            showPoiCard(hitPoi.poi, { x: hitPoi.sx, y: hitPoi.sy, box: hitPoi });
            return;
          }

          // 2. Если открыта карточка — закрываем, либо идём к точке клика
          if (selectedPoi) {
            showPoiCard(null);
            return;
          }

          if (ST.camera.clickToMove && S) {
            const hit = pickTerrain(px, py);
            if (hit) {
              const d0 = Math.hypot(hit.x, hit.z);
              if (d0 <= WALK_LIMIT) {
                cam.targetX = hit.x;
                cam.targetZ = hit.z;
              } else {
                cam.targetX = (hit.x / d0) * WALK_LIMIT;
                cam.targetZ = (hit.z / d0) * WALK_LIMIT;
                toast('Граница перемещения: 2.4 км от стартовой точки');
              }
              cam.movingToTarget = true;
              requestRender();
            }
          }
        }
      };

      listen(glCanvas, 'pointerup', onUp);
      listen(glCanvas, 'pointercancel', onUp);

      listen(glCanvas, 'wheel', e => {
        e.preventDefault();
        setFov(cam.fov * Math.exp(clamp(e.deltaY, -300, 300) * 0.0012));
      }, { passive: false });

      listen(glCanvas, 'dblclick', e => {
        if (!S) return;
        const r = glCanvas.getBoundingClientRect();
        const hit = pickTerrain(e.clientX - r.left, e.clientY - r.top);
        if (hit) {
          if (ST.camera.sensorOn) setSensorMode(false);
          const dx = hit.x - cam.x, dz = hit.z - cam.z;
          const dist = Math.hypot(dx, dz);
          const zScale = ST.view.zScale || 1.0;
          const drop = ST.view.curvature !== false ? (dx * dx + dz * dz) / 14646000 : 0;
          const ty = S.sampleRawY(hit.x, hit.z) * zScale - drop;
          cam.yaw = Math.atan2(dx, -dz);
          cam.pitch = clamp(Math.atan2(ty - cam.y, Math.max(dist, 1)), -70 * DEG, 70 * DEG);
          requestRender();
        }
      });

      // Виртуальный стик перемещения (для сенсорных экранов)
      let joyPtr = null;
      const updateJoy = (cx, cy) => {
        const r = joyEl.getBoundingClientRect();
        const maxR = r.width * 0.36 || 36;
        let dx = cx - (r.left + r.width / 2);
        let dy = cy - (r.top + r.height / 2);
        const l = Math.hypot(dx, dy);
        if (l > maxR) { dx = (dx / l) * maxR; dy = (dy / l) * maxR; }
        joy.dx = dx / maxR;
        joy.dy = dy / maxR;
        joyKnob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
        cam.movingToTarget = false;
        requestRender();
      };
      listen(joyEl, 'pointerdown', e => {
        e.stopPropagation();
        joyPtr = e.pointerId;
        joyEl.setPointerCapture(e.pointerId);
        updateJoy(e.clientX, e.clientY);
      });
      listen(joyEl, 'pointermove', e => {
        if (e.pointerId === joyPtr) updateJoy(e.clientX, e.clientY);
      });
      const resetJoy = e => {
        if (e.pointerId !== joyPtr) return;
        joyPtr = null;
        joy.dx = 0; joy.dy = 0;
        joyKnob.style.transform = '';
      };
      listen(joyEl, 'pointerup', resetJoy);
      listen(joyEl, 'pointercancel', resetJoy);
    }

    // =========================================================================
    // 11. ИНТЕРФЕЙС ПАНЕЛИ НАСТРОЕК И ИСТОЧНИКОВ
    // =========================================================================
    // =========================================================================
    // 11. ИНТЕРФЕЙС ПАНЕЛИ НАСТРОЕК И ИСТОЧНИКОВ
    // =========================================================================
    var refs = {};

    const mkSel = (optsArr, val, on) => {
      const s = el('select', { class: 'pkv-in' });
      optsArr.forEach(([v, t]) => {
        const o = el('option', { value: v, text: t });
        if (String(v) === String(val)) o.selected = true;
        s.append(o);
      });
      s.addEventListener('change', () => on(s.value));
      return s;
    };

    const mkRng = (min, max, step, val, on, fmt) => {
      const inp = el('input', { type: 'range', min, max, step, class: 'pkv-rng' });
      inp.value = val;
      const out = el('span', { class: 'pkv-val' });
      const upd = () => {
        out.textContent = fmt ? fmt(+inp.value) : inp.value;
        inp.style.setProperty('--p', clamp(((inp.value - min) / (max - min)) * 100, 0, 100) + '%');
      };
      upd();
      inp.addEventListener('input', () => { upd(); on(+inp.value); });
      const w = el('div', { class: 'pkv-rngw' }, inp, out);
      w.input = inp; w.upd = upd;
      return w;
    };

    const mkChk = (label, val, on) => {
      const inp = el('input', { type: 'checkbox' });
      inp.checked = !!val;
      inp.addEventListener('change', () => on(inp.checked));
      const l = el('label', { class: 'pkv-chk' }, inp, el('span', { text: label }));
      l.input = inp;
      return l;
    };

    const mkRow = (label, ctrl) => el('div', { class: 'pkv-row' }, el('label', { text: label }), ctrl);
    const mkCard = (title, ...kids) => el('div', { class: 'pkv-card' },
      el('div', { class: 'pkv-card-h' }, el('b', { text: title })),
      el('div', { class: 'pkv-card-b' }, ...kids)
    );
    const mkSpoil = (title, open, ...kids) => el('details', { class: 'pkv-spoil', open: !!open },
      el('summary', null, el('span', { text: title })),
      el('div', { class: 'pkv-spoil-b' }, ...kids)
    );

    function renderDots() {
      if (!dotsEl || !hub) return;
      dotsEl.textContent = '';
      Object.values(hub.sources).forEach(s => {
        dotsEl.append(el('i', {
          class: 'pkv-dot ' + s.state,
          title: `${s.def.title}: ${s.msg || s.state}`
        }));
      });
      const sm = hub.summary();
      pillTxt.textContent = sm.loading ? '⏳' : sm.error ? `⚠ ${sm.error}` : sm.warn ? `⚠ ${sm.warn}` : '✓';
    }

    function renderSources() {
      if (!refs.srcList || !hub) return;

      if (refs.demMeta) {
        refs.demMeta.textContent = '';
        const dr = WM.demRelief;
        const sInfo = (dr && typeof dr.getActiveSourceInfo === 'function') ? dr.getActiveSourceInfo() : null;

        const agg = {};
        ['demOuter', 'demMid', 'demInner'].forEach(id => {
          const provs = hub.sources[id]?.data?.providers;
          if (!provs) return;
          for (const k in provs) agg[k] = (agg[k] || 0) + provs[k];
        });
        const aggEntries = Object.entries(agg).sort((a, b) => b[1] - a[1]);
        const actualText = aggEntries.length
          ? aggEntries.map(([k, n]) => `${PROV_LABELS[k] || k}: ${n} т.`).join(' · ')
          : 'ожидание данных…';

        const prioText = sInfo
          ? sInfo.providers.map(p => `${p.priority}. ${p.name} (≤z${p.maxZ})${p.paused ? ' [⏸ пауза]' : ''}`).join(' → ')
          : 'Mapterhorn (Copernicus) → AWS Terrarium';

        const mainProv = aggEntries.length ? (PROV_LABELS[aggEntries[0][0]] || aggEntries[0][0]) : (sInfo?.providers[0]?.name || 'Copernicus');

        refs.demMeta.append(
          el('div', { class: 'pkv-sh' },
            el('span', { text: '🛰️' }),
            el('b', { text: 'Источник высот (DEM)' }),
            el('span', { class: 'pkv-badge', text: mainProv })
          ),
          el('div', { class: 'pkv-note', text: `Приоритет: ${prioText}` }),
          el('div', { class: 'pkv-note', style: 'color:#c4cedd', text: `Фактически в сцене: ${actualText}` })
        );
      }

      refs.srcList.textContent = '';
      const ST_TXT = { ok: '✓ готово', loading: '⏳ загрузка', error: '✕ ошибка', off: '⏸ выкл', idle: '… ожидание' };
      Object.values(hub.sources).forEach(s => {
        const pg = s.progress && s.progress.t ? Math.round((s.progress.d / s.progress.t) * 100) : null;
        refs.srcList.append(el('div', { class: 'pkv-src st-' + s.state },
          el('div', { class: 'pkv-sh' },
            el('span', { text: s.def.icon }),
            el('b', { text: s.def.title }),
            el('span', { class: 'pkv-badge', text: ST_TXT[s.state] || s.state })
          ),
          el('div', { class: 'pkv-note', text: s.def.desc }),
          s.msg ? el('div', { class: 'pkv-note', style: 'color:#c4cedd', text: s.msg + (s.state === 'ok' ? ` · ${s.cached ? 'кэш' : 'сеть'} · ${s.ms} мс` : '') }) : null,
          s.state === 'loading' ? el('div', { class: 'pkv-bar' }, el('i', { style: 'width:' + (pg == null ? 30 : pg) + '%' })) : null,
          el('div', { class: 'pkv-btns', style: 'margin-top:6px' },
            mkChk('Включить', s.enabled, v => { ST.sources[s.id] = v; save(); hub.setEnabled(s.id, v); }),
            el('button', { class: 'pkv-b' + (s.state === 'error' ? ' warn' : ''), type: 'button', text: '🔄', title: 'Перезагрузить', onclick: () => hub.reload(s.id) })
          )
        ));
      });
    }

    // -------------------------------------------------------------------------
    // ВКЛАДКА 1: ОСНОВНОЕ
    // -------------------------------------------------------------------------
    function buildMainTab() {
      const V = ST.view, L = ST.layers, C = ST.camera, SK = ST.sky;

      // 1. Тип отображения и тема
      const modeSel = mkSel([
        ['contour', '🏔️ Контуры и хребты'],
        ['hybrid', '🌤️ Гибрид (контуры + рельеф)'],
        ['cg', '☀️ CG (рельеф + свет)'],
        ['hypso', '🌈 Гипсометрия (высоты)'],
        ['slope', '📐 Уклоны (крутизна)'],
        ['topo', '🗺️ Топо-сетка']
      ], V.mode, v => { V.mode = v; save(); requestRender(); });

      // 2. Туман и умная дымка
      const sf = V.smartFog || (V.smartFog = JSON.parse(JSON.stringify(DEF.view.smartFog)));
      if (!sf.zoneMode) sf.zoneMode = 'auto';
      if (sf.nearBias == null) sf.nearBias = 0.60;
      if (sf.farBias == null) sf.farBias = 0.95;
      if (sf.b1Km == null) sf.b1Km = 1.5;
      if (sf.b2Km == null) sf.b2Km = 6.0;
      if (sf.b3Km == null) sf.b3Km = 16.0;

      refs.smartFogNote = el('div', { class: 'pkv-pill-info', text: 'Планы определяются по профилям рельефа' });

      const b1Rng = mkRng(0.2, 15.0, 0.1, sf.b1Km, v => {
        sf.b1Km = v;
        if (sf.b2Km < v + 0.3) {
          sf.b2Km = +(Math.min(30.0, v + 0.5)).toFixed(1);
          b2Rng.input.value = sf.b2Km; b2Rng.upd();
        }
        save(); requestRender();
      }, v => v.toFixed(1) + ' км');

      const b2Rng = mkRng(0.5, 30.0, 0.5, sf.b2Km, v => {
        sf.b2Km = Math.max(v, sf.b1Km + 0.3);
        if (sf.b3Km < sf.b2Km + 0.5) {
          sf.b3Km = +(Math.min(44.0, sf.b2Km + 1.0)).toFixed(1);
          b3Rng.input.value = sf.b3Km; b3Rng.upd();
        }
        save(); requestRender();
      }, v => v.toFixed(1) + ' км');

      const b3Rng = mkRng(1.5, 44.0, 0.5, sf.b3Km, v => {
        sf.b3Km = Math.max(v, sf.b2Km + 0.5);
        save(); requestRender();
      }, v => v.toFixed(1) + ' км');

      const b3Row = mkRow('Зона 3 (дальняя)', b3Rng);
      const autoZonesWrap = el('div', null,
        mkRow('Ближний план', mkRng(0.3, 2.2, 0.05, sf.nearBias, v => { sf.nearBias = v; save(); requestRender(); }, v => '×' + v.toFixed(2))),
        mkRow('Дальние планы', mkRng(0.5, 1.6, 0.05, sf.farBias, v => { sf.farBias = v; save(); requestRender(); }, v => '×' + v.toFixed(2)))
      );
      const manualZonesWrap = el('div', null,
        mkRow('Зона 1 (ближняя)', b1Rng),
        mkRow('Зона 2 (средняя)', b2Rng),
        b3Row
      );

      const syncSmartFogUi = () => {
        const isMan = sf.zoneMode === 'manual';
        autoZonesWrap.style.display = isMan ? 'none' : '';
        manualZonesWrap.style.display = isMan ? '' : 'none';
        b3Row.style.display = (sf.layers === 3) ? 'none' : '';
      };

      const zoneModeSel = mkSel([
        ['auto', 'Авто (стабильно, 360°)'],
        ['manual', 'Вручную (точные км)']
      ], sf.zoneMode, v => {
        sf.zoneMode = v;
        if (v === 'manual' && smartFogInit) {
          sf.b1Km = +clamp(smartFogState.b1 / 1000, 0.2, 15.0).toFixed(1);
          sf.b2Km = +clamp(smartFogState.b2 / 1000, sf.b1Km + 0.5, 30.0).toFixed(1);
          sf.b3Km = +clamp(smartFogState.b3 / 1000, sf.b2Km + 0.5, 44.0).toFixed(1);
          b1Rng.input.value = sf.b1Km; b1Rng.upd();
          b2Rng.input.value = sf.b2Km; b2Rng.upd();
          b3Rng.input.value = sf.b3Km; b3Rng.upd();
        }
        syncSmartFogUi();
        save();
        requestRender();
      });

      const smartFogSub = el('div', { class: 'pkv-sub', style: sf.enabled ? '' : 'display:none' },
        mkRow('Планов (слоёв)', mkSel([
          ['3', '3 плана'],
          ['4', '4 плана']
        ], sf.layers || 4, v => { sf.layers = +v; syncSmartFogUi(); save(); requestRender(); })),
        refs.smartFogNote,
        mkSpoil('Настройка слоёв и дымки', false,
          mkRow('Границы зон', zoneModeSel),
          autoZonesWrap,
          manualZonesWrap,
          mkRow('Сила дымки', mkRng(0.3, 1.5, 0.05, sf.strength != null ? sf.strength : 0.8, v => { sf.strength = v; save(); requestRender(); }, v => Math.round(v * 100) + '%')),
          mkRow('Чёткость слоёв', mkRng(0.0, 1.0, 0.05, sf.contrast != null ? sf.contrast : 0.6, v => { sf.contrast = v; save(); requestRender(); }, v => Math.round(v * 100) + '%')),
          mkRow('Дымка в долинах', mkRng(0.0, 1.0, 0.05, sf.valleyMist != null ? sf.valleyMist : 0.45, v => { sf.valleyMist = v; save(); requestRender(); }, v => Math.round(v * 100) + '%')),
          mkRow('Отрыв гребней', mkRng(0.0, 1.0, 0.05, sf.ridgeBoost != null ? sf.ridgeBoost : 0.5, v => { sf.ridgeBoost = v; save(); requestRender(); }, v => Math.round(v * 100) + '%'))
        )
      );
      syncSmartFogUi();

      // 3. Лес и его режимы
      const treeChk = mkChk('Отображать лес (перекрывает обзор)', L.trees !== false, v => {
        L.trees = v;
        syncTreeUiControls();
        save();
        syncSceneNow();
        requestRender();
      });
      const treeModeSel = mkSel([
        ['mass', '🌊 Сплошной волнистый массив'],
        ['trees', '🌲 Отдельные деревья']
      ], L.treeMode || 'mass', v => {
        L.treeMode = v;
        syncTreeUiControls();
        save();
        syncSceneNow();
        requestRender();
      });
      const canopyOpRng = mkRng(0.15, 1.0, 0.05, L.canopyOpacity != null ? L.canopyOpacity : 1.0, v => {
        L.canopyOpacity = v; save(); requestRender();
      }, v => Math.round(v * 100) + '%');
      const canopyScaleRng = mkRng(0.5, 2.0, 0.05, L.canopyScale || 1.0, v => {
        L.canopyScale = v; save(); requestRender();
      }, v => '×' + v.toFixed(2));
      const canopyMinHRng = mkRng(0.5, 8.0, 0.5, L.canopyMinH != null ? L.canopyMinH : 0.5, v => {
        L.canopyMinH = v; save(); requestRender();
      }, v => v.toFixed(1) + ' м');
      const canopyWaveRng = mkRng(0.0, 1.5, 0.05, L.canopyWave != null ? L.canopyWave : 0.75, v => {
        L.canopyWave = v; save(); requestRender();
      }, v => Math.round(v * 100) + '%');
      const massTerrainContoursChk = mkChk('🏔️ Контуры гор поверх леса', !!L.massTerrainContours, v => {
        L.massTerrainContours = v; save(); requestRender();
      });

      const onForestShadowToggle = v => {
        L.castForestShadows = v;
        if (refs.treeUi.forestShadowChk) refs.treeUi.forestShadowChk.input.checked = v;
        if (refs.treeUi.forestShadowMassChk) refs.treeUi.forestShadowMassChk.input.checked = v;
        save();
        requestRender();
      };
      const forestShadowChk = mkChk('🌑 Отбрасываемая лесом тень', !!L.castForestShadows, onForestShadowToggle);
      const forestShadowMassChk = mkChk('🌑 Отбрасываемая лесом тень', !!L.castForestShadows, onForestShadowToggle);

      const massSubEl = el('div', { class: 'pkv-sub' },
        mkRow('Перекрытие гор', canopyOpRng),
        forestShadowMassChk, // <-- ВСТАВЛЕНО В РЕЖИМ «МАССИВ»
        mkSpoil('Параметры крон и контуров', false,
          mkRow('Высота крон', canopyScaleRng),
          mkRow('Порог леса', canopyMinHRng),
          mkRow('Волнистость', canopyWaveRng),
          massTerrainContoursChk,
          el('div', { class: 'pkv-note', text: 'При 100% лес непрозрачный. Уменьшите «Перекрытие» или включите контуры гор поверх леса.' })
        )
      );

      const treeLinesChk = mkChk('🟩 Линия высоты деревьев (по карте крон)', L.treeHeightLines !== false, v => {
        L.treeHeightLines = v; save(); requestRender();
      });
      const hideOccTerrChk = mkChk('👁️ Скрывать линии рельефа за лесом', L.hideOccludedTerrainLines !== false, v => {
        L.hideOccludedTerrainLines = v; save(); requestRender();
      });
      const treesSubEl = el('div', { class: 'pkv-sub' },
        treeLinesChk,
        hideOccTerrChk,
        forestShadowChk, // <-- ВСТАВЛЕНО СРАЗУ НИЖЕ «Скрывать линии рельефа за лесом»
        mkSpoil('Подробнее о линиях леса', false,
          el('div', { class: 'pkv-note', text: 'Зелёные линии повторяют контур высоты крон, а линии хребтов за лесом видны лишь там, где не перекрыты деревьями с вашей точки.' })
        )
      );

      refs.treeUi = {
        treeChk, treeModeSel, canopyOpRng, canopyScaleRng, canopyMinHRng, canopyWaveRng,
        massSubEl, treesSubEl, treeLinesChk, hideOccTerrChk, forestShadowChk, forestShadowMassChk, massTerrainContoursChk
      };

      // 4. Время суток и небо
      const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const dateIn = el('input', { type: 'date', class: 'pkv-in', value: SK.date || localDateStr() });
      let timeModeSel = null;
      let bNow = null;
      let fineBaseHour = null;

      const fineRng = mkRng(-30, 30, 1, 0, v => {
        if (fineBaseHour === null) {
          if (SK.timeMode === 'now') {
            const now = new Date();
            fineBaseHour = now.getHours() + now.getMinutes() / 60;
            if (!SK.date) SK.date = localDateStr(now);
          } else {
            fineBaseHour = SK.hour != null ? SK.hour : 12.0;
          }
        }
        SK.timeMode = 'manual';
        SK.hour = ((fineBaseHour + v / 60) % 24 + 24) % 24;
        if (timeModeSel) timeModeSel.value = 'manual';
        hourRng.input.value = SK.hour;
        hourRng.upd();
        syncSkyControls();
        updateAstro();
        save();
        requestRender();
      }, v => (v > 0 ? '+' : '') + v + ' м');

      const resetFine = () => {
        fineBaseHour = null;
        fineRng.input.value = 0;
        fineRng.upd();
      };

      const syncSkyControls = () => {
        const isNow = SK.timeMode === 'now';
        if (bNow) bNow.classList.toggle('prime', isNow);
        if (isNow) {
          const now = new Date();
          dateIn.value = localDateStr(now);
          const localH = now.getHours() + now.getMinutes() / 60;
          hourRng.input.value = localH;
          hourRng.upd();
        }
      };

      const hourRng = mkRng(0, 24, 1 / 60, SK.hour != null ? SK.hour : 12.0, v => {
        resetFine();
        SK.timeMode = 'manual';
        SK.hour = v;
        if (timeModeSel) timeModeSel.value = 'manual';
        syncSkyControls();
        updateAstro();
        save();
        requestRender();
      }, fmtH);

      timeModeSel = mkSel([
        ['now', '🕒 Сейчас (реальное время)'],
        ['manual', '🎛️ Вручную']
      ], SK.timeMode || 'now', v => {
        resetFine();
        SK.timeMode = v;
        if (v === 'now') SK.date = '';
        syncSkyControls();
        updateAstro();
        save();
        requestRender();
      });

      dateIn.addEventListener('change', () => {
        if (SK.timeMode === 'now') {
          const now = new Date();
          SK.hour = now.getHours() + now.getMinutes() / 60;
          resetFine();
        }
        SK.timeMode = 'manual';
        SK.date = dateIn.value;
        timeModeSel.value = 'manual';
        syncSkyControls();
        updateAstro();
        save();
        requestRender();
      });

      const setHourPreset = h => {
        resetFine();
        SK.timeMode = 'manual';
        SK.hour = h;
        timeModeSel.value = 'manual';
        hourRng.input.value = h;
        hourRng.upd();
        syncSkyControls();
        updateAstro();
        save();
        requestRender();
      };

      bNow = el('button', {
        class: 'pkv-b' + (SK.timeMode === 'now' ? ' prime' : ''),
        type: 'button',
        text: 'Сейчас',
        onclick: () => {
          resetFine();
          SK.timeMode = 'now';
          SK.date = '';
          timeModeSel.value = 'now';
          syncSkyControls();
          updateAstro();
          save();
          requestRender();
        }
      });

      syncSkyControls();
      refs.astroInfo = el('div', { class: 'pkv-pill-info' });
      

      // 5. Наблюдатель и управление
      refs.eyeH = mkRng(1.5, 180, 0.5, C.eyeHeight || 2.0, v => { setEyeHeight(v); }, v => v.toFixed(1) + ' м');
      refs.chkSensor = mkChk('🧭 Вращать компасом / гироскопом', !!C.sensorOn, v => setSensorMode(v));

      const joySel = mkSel([
        ['auto', 'Авто (на сенсорных экранах)'],
        ['on', 'Всегда показывать'],
        ['off', 'Скрыть']
      ], C.joystick || 'auto', v => { C.joystick = v; updateJoystickVis(); save(); });

      // 6. Калибровка компаса и направление взгляда
      refs.compassOff = mkRng(-180, 180, 1, C.compassOffset || 0, v => {
        C.compassOffset = v;
        save();
        requestRender();
      }, v => (v > 0 ? '+' : '') + v + '°');

      const alignToDeg = (targetAzDeg, targetAltRad, label) => {
        if (ST.camera.sensorOn) {
          const curDeg = ((cam.yaw / DEG) % 360 + 360) % 360;
          let diff = (targetAzDeg - curDeg) % 360;
          if (diff < -180) diff += 360;
          if (diff > 180) diff -= 360;
          ST.camera.compassOffset = Math.round(clamp((ST.camera.compassOffset || 0) + diff, -180, 180));
          if (ST.camera.compassOffset <= -180 || ST.camera.compassOffset >= 180) {
            ST.camera.compassOffset = (((ST.camera.compassOffset + 540) % 360) - 180);
          }
          refs.compassOff.input.value = ST.camera.compassOffset;
          refs.compassOff.upd();
          sensorHeadingSmooth = targetAzDeg;
          cam.yaw = targetAzDeg * DEG;
          toast(`🧭 Компас отъюстирован по ${label} (${Math.round(targetAzDeg)}°)`);
        } else {
          cam.yaw = targetAzDeg * DEG;
          if (targetAltRad != null) cam.pitch = clamp(targetAltRad, -70 * DEG, 70 * DEG);
          toast(`🧭 Взгляд направлен на ${label} (${Math.round(targetAzDeg)}°)`);
        }
        save();
        requestRender();
      };
      const setIsolinesOn = v => {
        V.showIsolines = !!v;
        if (refs.chkIsolines) refs.chkIsolines.input.checked = V.showIsolines;
        if (refs.chkIsolinesMain) refs.chkIsolinesMain.input.checked = V.showIsolines;
        save();
        if (I._dev && I._dev.onIsolinesChange) I._dev.onIsolinesChange();
        requestRender();
      };
      refs.chkIsolinesMain = mkChk('📏 Горизонтали высот', !!V.showIsolines, setIsolinesOn);

      const page = el('div', null,
        mkCard('☀️ Время суток и небо',
          mkRow('Режим времени', timeModeSel),
          mkRow('Время суток', hourRng),
          mkRow('Точно (±30 м)', fineRng),
          mkRow('Дата', dateIn),
          el('div', { class: 'pkv-btns compact' },
            el('button', { class: 'pkv-b', type: 'button', text: '🌅 06:00', onclick: () => setHourPreset(6) }),
            el('button', { class: 'pkv-b', type: 'button', text: '☀️ 12:00', onclick: () => setHourPreset(12) }),
            el('button', { class: 'pkv-b', type: 'button', text: '🌇 19:00', onclick: () => setHourPreset(19) }),
            el('button', { class: 'pkv-b', type: 'button', text: '🌙 23:00', onclick: () => setHourPreset(23) }),
            bNow
          ),
          refs.astroInfo,
          mkSpoil('Траектории светил', false,
            mkChk('Траектории Солнца и Луны', SK.trajectories !== false, v => { SK.trajectories = v; save(); requestRender(); })
          )
        ),

        mkCard('🎨 Вид и отображение',
          mkRow('Режим', modeSel),
          mkChk('🌙 Тёмная тема неба и линий', V.darkTheme, v => { V.darkTheme = v; updateAstro(); save(); requestRender(); }),
          mkChk('⛰️ Силуэтные контуры хребтов', V.showEdges !== false, v => { V.showEdges = v; save(); requestRender(); }),
          mkChk('🌒 Отбрасываемые тени гор', !!V.castTerrainShadows, v => { V.castTerrainShadows = v; save(); requestRender(); }),
          refs.chkIsolinesMain
        ),

        mkCard('🌫️ Видимость и дымка',
          mkRow('Дальность', mkRng(2000, 45000, 500, V.fogDist || 45000, v => { V.fogDist = v; save(); requestRender(); }, v => (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + ' км')),
          mkChk('🌫️ Умная видимость (слои гор)', !!sf.enabled, v => {
            sf.enabled = v;
            smartFogSub.style.display = v ? '' : 'none';
            save();
            requestRender();
          }),
          smartFogSub
        ),

        mkCard('🌲 Лес и его режимы',
          treeChk,
          mkRow('Вид леса', treeModeSel),
          massSubEl,
          treesSubEl
        ),

        mkCard('🚶 Наблюдатель и управление',
          mkRow('Высота над землёй', refs.eyeH),
          refs.chkSensor,
          mkSpoil('Жесты, клик и экранный стик', false,
            mkChk('👆 Перемещаться по клику на рельеф', C.clickToMove !== false, v => { C.clickToMove = v; save(); }),
            mkRow('Стик на экране', joySel),
            el('div', { class: 'pkv-note', text: 'ПК: ЛКМ — обзор, ПКМ — высота, колесо — зум, WASD — шаг, Q/E — высота. Телефон: свайп — обзор, щипок — зум, 2 пальца вверх/вниз — высота, стик — шаг.' })
          )
        ),

        mkCard('🧭 Направление и калибровка компаса',
          el('div', { class: 'pkv-btns compact' },
            el('button', { class: 'pkv-b', type: 'button', text: 'С 0°', onclick: () => alignToDeg(0, null, 'Север') }),
            el('button', { class: 'pkv-b', type: 'button', text: 'В 90°', onclick: () => alignToDeg(90, null, 'Восток') }),
            el('button', { class: 'pkv-b', type: 'button', text: 'Ю 180°', onclick: () => alignToDeg(180, null, 'Юг') }),
            el('button', { class: 'pkv-b', type: 'button', text: 'З 270°', onclick: () => alignToDeg(270, null, 'Запад') })
          ),
          el('div', { class: 'pkv-btns' },
            el('button', {
              class: 'pkv-b prime', type: 'button', text: '☀️ По Солнцу',
              onclick: () => {
                updateAstro();
                const azD = ((sunPos.az / DEG) % 360 + 360) % 360;
                alignToDeg(azD, sunPos.alt, 'Солнце');
              }
            }),
            el('button', {
              class: 'pkv-b', type: 'button', text: '🌙 По Луне',
              onclick: () => {
                updateAstro();
                const azD = ((moonPos.az / DEG) % 360 + 360) % 360;
                alignToDeg(azD, moonPos.alt, 'Луну');
              }
            })
          ),
          mkSpoil('Точная юстировка датчика', false,
            mkRow('Поправка датчика', refs.compassOff),
            el('div', { class: 'pkv-note', text: 'При ручном обзоре кнопки поворачивают камеру, а при активном компасе 🧭 — автоматически калибруют поправку.' })
          )
        )
      );

      syncTreeUiControls();
      return page;
    }

    // -------------------------------------------------------------------------
    // ВКЛАДКА 2: ДОП. НАСТРОЙКИ
    // -------------------------------------------------------------------------
    function buildExtraTab() {
      const V = ST.view, L = ST.layers;

      refs.fov = mkRng(6, 82, 1, V.fov || 48, v => { setFov(v); }, v => v + '°');
      refs.startCoordNote = el('div', { class: 'pkv-pill-info', text: geo ? `Старт: ${geo.lat0.toFixed(5)}, ${geo.lng0.toFixed(5)}` : '' });

      const isoStepSel = mkSel([
        ['10', '10 м'], ['25', '25 м'], ['50', '50 м'], ['100', '100 м'], ['200', '200 м']
      ], V.isoStep || 50, v => { V.isoStep = +v; save(); requestRender(); });

      const distSel = mkSel([
        ['smart', 'Умный (главные + <3.5 км)'],
        ['all', 'У всех подписей'],
        ['off', 'Только у выбранной']
      ], L.showDist || 'smart', v => { L.showDist = v; save(); requestRender(); });

      const qualSel = mkSel([
        ['low', 'Низкое (быстрее)'], ['mid', 'Среднее'], ['high', 'Высокое (чётче)']
      ], V.quality || 'mid', v => { V.quality = v; save(); requestRender(); });

      const updateVecTexLive = () => {
        syncSceneNow();
        save();
        requestRender();
      };

      const mkRoadColorsRow = (label, dayKey, nightKey, defDay, defNight) => {
        const inpDay = el('input', { type: 'color', class: 'pkv-col', value: L[dayKey] || defDay, title: 'Цвет днём' });
        const inpNight = el('input', { type: 'color', class: 'pkv-col', value: L[nightKey] || defNight, title: 'Цвет ночью' });
        inpDay.addEventListener('input', () => { L[dayKey] = inpDay.value; save(); requestRender(); });
        inpNight.addEventListener('input', () => { L[nightKey] = inpNight.value; save(); requestRender(); });
        const w = el('div', { class: 'pkv-colw' },
          el('span', { class: 'pkv-col-lbl', text: '☀️' }), inpDay,
          el('span', { class: 'pkv-col-lbl', text: '🌙' }), inpNight
        );
        const row = mkRow(label, w);
        row.inpDay = inpDay;
        row.inpNight = inpNight;
        return row;
      };

      const pavedColorRow = mkRoadColorsRow('Цвет асфальта', 'roadPavedDay', 'roadPavedNight', DEF.layers.roadPavedDay, DEF.layers.roadPavedNight);
      const trailColorRow = mkRoadColorsRow('Цвет грунтовых', 'roadTrailDay', 'roadTrailNight', DEF.layers.roadTrailDay, DEF.layers.roadTrailNight);

      const pavedWidthRow = mkRow('Ширина асфальта', mkRng(0.4, 3.0, 0.1, L.roadPavedWidth || 1.0, v => { L.roadPavedWidth = v; updateVecTexLive(); }, v => '×' + v.toFixed(1)));
      const trailWidthRow = mkRow('Ширина троп', mkRng(0.4, 3.0, 0.1, L.roadTrailWidth || 1.0, v => { L.roadTrailWidth = v; updateVecTexLive(); }, v => '×' + v.toFixed(1)));
      const riverWidthRow = mkRow('Ширина рек', mkRng(0.4, 3.0, 0.1, L.riverWidth || 1.0, v => { L.riverWidth = v; updateVecTexLive(); }, v => '×' + v.toFixed(1)));
      const bldHeightRow = mkRow('Высота построек', mkRng(0.5, 3.0, 0.1, L.bldHeightScale || 1.0, v => { L.bldHeightScale = v; save(); requestRender(); }, v => '×' + v.toFixed(1)));

      const syncPavedRows = on => {
        pavedWidthRow.classList.toggle('off', !on);
        pavedColorRow.classList.toggle('off', !on);
        pavedColorRow.inpDay.disabled = !on;
        pavedColorRow.inpNight.disabled = !on;
      };
      const syncTrailRows = on => {
        trailWidthRow.classList.toggle('off', !on);
        trailColorRow.classList.toggle('off', !on);
        trailColorRow.inpDay.disabled = !on;
        trailColorRow.inpNight.disabled = !on;
      };
      syncPavedRows(L.roadsPaved !== false);
      syncTrailRows(L.roadsTrail !== false);
      riverWidthRow.classList.toggle('off', L.rivers === false);
      bldHeightRow.classList.toggle('off', L.buildings === false);

      return el('div', null,
        mkCard('📍 Точка обзора и камера',
          refs.startCoordNote,
          el('div', { class: 'pkv-btns' },
            el('button', {
              class: 'pkv-b prime', type: 'button', text: '🗺️ Центр карты',
              onclick: () => {
                if (WM.map && WM.map.getCenter) {
                  const c = WM.map.getCenter();
                  I.reopenAt(c.lat, c.lng);
                } else {
                  toast('Карта недоступна');
                }
              }
            }),
            el('button', { class: 'pkv-b', type: 'button', text: '🏠 Старт', onclick: () => resetToStart() }),
            el('button', { class: 'pkv-b', type: 'button', text: '📍 На карте', onclick: () => I.showOnMap() })
          ),
          mkRow('Угол обзора (FOV)', refs.fov),
          mkSpoil('Поведение при открытии', false,
            mkChk('🔄 Обновлять с карты при разворачивании', V.refreshOnRestore !== false, v => { V.refreshOnRestore = v; save(); })
          )
        ),

        mkCard('⛰️ Геометрия рельефа и изолинии',
          mkRow('Масштаб высот (Z)', mkRng(0.5, 3.0, 0.1, V.zScale || 1.0, v => { V.zScale = v; save(); requestRender(); }, v => '×' + v.toFixed(1))),
          (refs.chkIsolines = mkChk('Горизонтали высот', !!V.showIsolines, v => {
            V.showIsolines = v;
            if (refs.chkIsolinesMain) refs.chkIsolinesMain.input.checked = v;
            save();
            if (I._dev && I._dev.onIsolinesChange) I._dev.onIsolinesChange();
            requestRender();
          })),
          mkRow('Шаг горизонталей', isoStepSel),
          mkChk('Учитывать кривизну Земли', V.curvature !== false, v => { V.curvature = v; save(); requestRender(); })
        ),


        mkCard('🏔️ Подписи и объекты OSM',
          mkRow('Дистанция в метках', distSel),
          mkChk('👁️ Скрывать закрытые горами и лесом', L.hideOccluded !== false, v => { L.hideOccluded = v; save(); requestRender(); }),
          mkSpoil('Категории объектов и вид меток', false,
            mkChk('⛰️ Вершины, вулканы, перевалы', L.peaks !== false, v => { L.peaks = v; save(); requestRender(); }),
            mkChk('🏘️ Населённые пункты', L.settlements !== false, v => { L.settlements = v; save(); requestRender(); }),
            mkChk('🌾 Урочища и местности', L.localities !== false, v => { L.localities = v; save(); requestRender(); }),
            mkChk('🧭 Смотровые, хижины, памятники', L.landmarks !== false, v => { L.landmarks = v; save(); requestRender(); }),
            mkRow('Макс. дистанция', mkRng(5, 45, 1, L.maxDistKm || 42, v => { L.maxDistKm = v; save(); requestRender(); }, v => v + ' км')),
            mkRow('Размер шрифта', mkRng(10, 16, 1, L.fontSize || 12, v => { L.fontSize = v; save(); requestRender(); }, v => v + ' px'))
          )
        ),

        mkCard('🛣️ Дороги, реки и постройки',
          mkChk('🛣️ Выравнивать рельеф под дорогами', L.levelRoads !== false, v => {
            L.levelRoads = v;
            save();
            applySceneSync();
          }),
          mkChk('🛣️ Асфальтированные дороги', L.roadsPaved !== false, v => {
            L.roadsPaved = v;
            syncPavedRows(v);
            save(); requestRender();
          }),
          pavedColorRow,
          mkChk('🥾 Грунтовые дороги и тропы', L.roadsTrail !== false, v => {
            L.roadsTrail = v;
            syncTrailRows(v);
            save(); requestRender();
          }),
          trailColorRow,
          mkChk('🌊 Реки и водоёмы OSM', L.rivers !== false, v => {
            L.rivers = v;
            riverWidthRow.classList.toggle('off', !v);
            save(); requestRender();
          }),
          mkChk('🏘️ 3D-постройки OSM (±2.6 км)', L.buildings !== false, v => {
            L.buildings = v;
            bldHeightRow.classList.toggle('off', !v);
            save(); requestRender();
          }),
          mkSpoil('Толщина линий, сброс цветов и высота', false,
            pavedWidthRow,
            trailWidthRow,
            riverWidthRow,
            bldHeightRow,
            el('div', { class: 'pkv-btns' },
              el('button', {
                class: 'pkv-b', type: 'button', text: '↺ Сбросить цвета дорог',
                onclick: () => {
                  L.roadPavedDay = DEF.layers.roadPavedDay;
                  L.roadPavedNight = DEF.layers.roadPavedNight;
                  L.roadTrailDay = DEF.layers.roadTrailDay;
                  L.roadTrailNight = DEF.layers.roadTrailNight;
                  pavedColorRow.inpDay.value = L.roadPavedDay;
                  pavedColorRow.inpNight.value = L.roadPavedNight;
                  trailColorRow.inpDay.value = L.roadTrailDay;
                  trailColorRow.inpNight.value = L.roadTrailNight;
                  save(); requestRender();
                }
              })
            )
          )
        ),

        mkCard('⚡ Графика и диагностика',
          mkRow('Качество графики', qualSel),
          (refs.chkPerf = mkChk('📊 Счётчик FPS и профилировщик', !!ST.view.perfOverlay, v => togglePerf(v))),
          mkSpoil('Инструменты разработчика', false,
            el('div', { class: 'pkv-btns' },
              el('button', {
                class: 'pkv-b', type: 'button', text: '🛠️ Контуры и 3D-лес',
                onclick: () => api.openDevTool && api.openDevTool()
              }),
              el('button', {
                class: 'pkv-b', type: 'button', text: '🏔️ Рельеф и контуры',
                onclick: () => api.openTerrainDevTool && api.openTerrainDevTool()
              })
            )
          )
        )
      );
    }

    // -------------------------------------------------------------------------
    // ВКЛАДКА 3: ДАННЫЕ (без изменений)
    // -------------------------------------------------------------------------
    function buildSourcesTab() {
      refs.demMeta = el('div', { class: 'pkv-src', style: 'border-left-color:#4da3ff' });
      refs.srcList = el('div');
      const p = el('div', null,
        refs.demMeta,
        refs.srcList,
        el('div', { class: 'pkv-btns' },
          el('button', { class: 'pkv-b prime', type: 'button', text: '↻ Перезагрузить все данные', onclick: () => hub && hub.reloadAll() })
        ),
        el('div', { class: 'pkv-note', text: 'Данные загружаются 1 раз для зоны вокруг выбранной точки. Рельеф берётся из кэша DEM, вершины и дороги — из OSM.' })
      );
      renderSources();
      return p;
    }

    function buildPanel() {
      tabsEl.textContent = '';
      pagesEl.textContent = '';
      const pgs = {
        main: buildMainTab(),
        extra: buildExtraTab(),
        sources: buildSourcesTab()
      };
      const defs = [
        ['main', '🎛️', 'Основное'],
        ['extra', '⚙️', 'Доп. настройки'],
        ['sources', '📡', 'Данные']
      ];
      const setTab = k => {
        if (k === 'view' || k === 'layers' || k === 'sky') k = 'main';
        if (!(k in pgs)) k = 'main';
        ST.tab = k;
        tabsEl.querySelectorAll('.pkv-tab').forEach(t => t.classList.toggle('on', t.dataset.k === k));
        pagesEl.textContent = '';
        pagesEl.append(pgs[k]);
        if (k === 'sources') renderSources();
        save();
      };
      defs.forEach(([k, ic, label]) => {
        tabsEl.append(el('div', { class: 'pkv-tab', 'data-k': k, onclick: () => setTab(k) }, el('i', { text: ic }), label));
      });
      setTab(ST.tab || 'main');
      I.openTab = k => {
        ST.panel = true;
        panelEl.classList.remove('hide');
        bPanel.classList.add('act');
        setTab(k);
        save();
        requestRender();
      };
    }

    // =========================================================================
    // 12. HUD: КОМПАС, ТРАЕКТОРИИ СОЛНЦА И ЛУНЫ, ПОДПИСИ ВЕРШИН И ПЕРЕКРЫТИЕ
    // =========================================================================
    function projectWorld(wx, wy, wz, W, H) {
      const cx = mVP[0] * wx + mVP[4] * wy + mVP[8]  * wz + mVP[12];
      const cy = mVP[1] * wx + mVP[5] * wy + mVP[9]  * wz + mVP[13];
      const cw = mVP[3] * wx + mVP[7] * wy + mVP[11] * wz + mVP[15];
      if (cw <= 0.15) return null;
      const nx = cx / cw, ny = cy / cw;
      return { x: (nx * 0.5 + 0.5) * W, y: (0.5 - ny * 0.5) * H, w: cw };
    }

    function sampleCanopyGrid(cd, wx, wz) {
      if (!cd || !cd.grid) return 0;
      const halfM = cd.halfM || CANOPY_HALF;
      if (Math.abs(wx) > halfM || Math.abs(wz) > halfM) return 0;
      const Nx = cd.box.Nx, Ny = cd.box.Ny;
      const u = clamp((wx + halfM) / (2 * halfM), 0, 1);
      const v = clamp((wz + halfM) / (2 * halfM), 0, 1);
      const gx = u * (Nx - 1), gz = v * (Ny - 1);
      const x0 = Math.min(Math.floor(gx), Nx - 2);
      const z0 = Math.min(Math.floor(gz), Ny - 2);
      const fx = gx - x0, fz = gz - z0;
      const k = z0 * Nx + x0;
      const rawH = (
        (cd.grid[k] * (1 - fx) + cd.grid[k + 1] * fx) * (1 - fz) +
        (cd.grid[k + Nx] * (1 - fx) + cd.grid[k + Nx + 1] * fx) * fz
      ) / 4;
      const minH = ST.layers.treeMode === 'mass' ? (ST.layers.canopyMinH || 2.0) : 2.2;
      if (rawH < minH) return 0;
      const scale = ST.layers.treeMode === 'mass' ? (ST.layers.canopyScale || 1.0) : 1.0;
      return rawH * scale;
    }

    function sampleCanopyHeight(wx, wz) {
      if (ST.layers.trees === false || !hub) return 0;
      const cNear = hub.sources.canopy;
      if (cNear && cNear.state === 'ok' && cNear.data) {
        const nearHalf = cNear.data.halfM || CANOPY_HALF;
        if (Math.abs(wx) <= nearHalf && Math.abs(wz) <= nearHalf) {
          return sampleCanopyGrid(cNear.data, wx, wz);
        }
      }
      const cFar = hub.sources.canopyFar;
      if (cFar && cFar.state === 'ok' && cFar.data) {
        return sampleCanopyGrid(cFar.data, wx, wz);
      }
      return 0;
    }

    // Возвращает: 'visible' | 'terrain' | 'trees'
    function getPoiVisibilityCached(poi, targetY, visKey) {
      if (!ST.layers.hideOccluded || !S) return 'visible';
      if (poi._visKey === visKey) return poi._vis;

      const dx = poi.wx - cam.x, dy = targetY - cam.y, dz = poi.wz - cam.z;
      const dist = Math.hypot(dx, dz);
      let res = 'visible';

      if (dist >= 40) {
        const zScale = ST.view.zScale || 1.0;
        const curv = ST.view.curvature !== false;
        const treeZ = lerp(1.0, zScale, 0.35);
        const farH = (hub && hub.sources.canopyFar && hub.sources.canopyFar.state === 'ok')
          ? ((hub.sources.canopyFar.data && hub.sources.canopyFar.data.halfM) || CANOPY_FAR_HALF)
          : CANOPY_HALF;
        const nearEnd = Math.min(dist * 0.96, farH * 1.4);

        // Адаптивный шаг: плотно вблизи (18м), реже на 1-3 км
        for (let d = 14; d < nearEnd; d += Math.max(18, d * 0.045)) {
          const t = d / dist;
          const px = cam.x + dx * t, py = cam.y + dy * t, pz = cam.z + dz * t;
          const drop = curv ? (d * d) / 14646000 : 0;
          const gy = S.sampleRawY(px, pz) * zScale - drop;
          if (gy > py + 5.0) { res = 'terrain'; break; }
          const th = sampleCanopyHeight(px, pz);
          if (th > 0 && gy + th * treeZ > py + 2.0) { res = 'trees'; break; }
        }

        if (res === 'visible' && dist > nearEnd) {
          const steps = clamp(Math.round((dist - nearEnd) / 380), 8, 36);
          const span = dist * 0.96 - nearEnd;
          for (let i = 1; i <= steps; i++) {
            const d = nearEnd + (span * i) / steps;
            const t = d / dist;
            const px = cam.x + dx * t, py = cam.y + dy * t, pz = cam.z + dz * t;
            const drop = curv ? (d * d) / 14646000 : 0;
            const gy = S.sampleRawY(px, pz) * zScale - drop;
            if (gy > py + 6.0) { res = 'terrain'; break; }
          }
        }
      }
      poi._visKey = visKey;
      poi._vis = res;
      return res;
    }

    function drawHud(W, H) {
      const tHud0 = performance.now();
      let candCnt = 0, drawnCnt = 0;

      const maxHudDpr = ST.view.quality === 'high' ? 2 : (ST.view.quality === 'low' ? 1 : 1.25);
      const dpr = Math.min(window.devicePixelRatio || 1, maxHudDpr);
      const cw = Math.max(1, Math.round(W * dpr));
      const ch = Math.max(1, Math.round(H * dpr));
      if (hudCanvas.width !== cw || hudCanvas.height !== ch) {
        hudCanvas.width = cw; hudCanvas.height = ch;
      }
      const ctx = hudCanvas._ctx || (hudCanvas._ctx = hudCanvas.getContext('2d'));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      labelBoxes = [];
      if (!geo || !atm) return;


      const isSimpleBg = (ST.view.mode === 'contour' || ST.view.mode === 'topo') && !ST.view.darkTheme;
      const txtCol = isSimpleBg ? '#131a24' : '#eef4fc';
      const subTxtCol = isSimpleBg ? '#3f4c5e' : '#a8b8cc';

      // 1. Траектории Солнца и Луны на небе
      if (ST.sky.trajectories && S) {
        const R_SKY = 30000;

        const drawCachedArc = (arcDirs, hourDirs, strokeCol, dash, isSun) => {
          ctx.save();
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = 1.6;
          ctx.setLineDash(dash);
          ctx.beginPath();
          let penDown = false;
          for (let i = 0; i < arcDirs.length; i++) {
            const dir = arcDirs[i];
            if (!dir) { penDown = false; continue; }
            const sp = projectWorld(cam.x + dir[0] * R_SKY, cam.y + dir[1] * R_SKY, cam.z + dir[2] * R_SKY, W, H);
            if (!sp || sp.x < -100 || sp.x > W + 100 || sp.y < -100 || sp.y > H + 100) { penDown = false; continue; }
            if (!penDown) { ctx.moveTo(sp.x, sp.y); penDown = true; }
            else ctx.lineTo(sp.x, sp.y);
          }
          ctx.stroke();

          // Часовые метки (каждые 3 часа)
          ctx.setLineDash([]);
          ctx.font = '600 10px system-ui,sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = strokeCol;
          for (let i = 0; i < hourDirs.length; i++) {
            const { hr, dir } = hourDirs[i];
            const sp = projectWorld(cam.x + dir[0] * R_SKY, cam.y + dir[1] * R_SKY, cam.z + dir[2] * R_SKY, W, H);
            if (!sp || sp.x < 18 || sp.x > W - 18 || sp.y < 48 || sp.y > H - 20) continue;
            ctx.beginPath(); ctx.arc(sp.x, sp.y, 2.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillText(pad2(hr) + ':00', sp.x, sp.y - 6);
          }

          // Текущее светило
          const curP = isSun ? sunPos : moonPos;
          if (curP.alt > -6 * DEG) {
            const dCur = dirFromAltAz(curP.alt, curP.az);
            const spCur = projectWorld(cam.x + dCur[0] * R_SKY, cam.y + dCur[1] * R_SKY, cam.z + dCur[2] * R_SKY, W, H);
            if (spCur && spCur.x >= -20 && spCur.x <= W + 20 && spCur.y >= -20 && spCur.y <= H + 20) {
              const webglMoonOn = !isSun && ((ST.view.mode !== 'contour' && ST.view.mode !== 'topo') || !!ST.view.darkTheme);
              if (isSun || !webglMoonOn) {
                ctx.fillStyle = isSun ? '#fbbf24' : '#93c5fd';
                ctx.beginPath(); ctx.arc(spCur.x, spCur.y, isSun ? 6.5 : 5.5, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = isSun ? 'rgba(251,191,36,0.45)' : 'rgba(147,197,253,0.45)';
                ctx.lineWidth = 4;
                ctx.beginPath(); ctx.arc(spCur.x, spCur.y, isSun ? 9.5 : 8.5, 0, Math.PI * 2); ctx.stroke();
              }
              ctx.fillStyle = txtCol;
              ctx.font = '700 11px system-ui,sans-serif';
              if (isSun) {
                ctx.fillText('☀️', spCur.x, spCur.y - 12);
              } else {
                ctx.fillText(
                  webglMoonOn ? `🌙 ${Math.round((moonPos.illum || 0) * 100)}%` : '🌙',
                  spCur.x,
                  spCur.y - (webglMoonOn ? 24 : 12)
                );
              }
            }
          }
          ctx.restore();
        };

        drawCachedArc(sunArcDirs, sunHourDirs, isSimpleBg ? 'rgba(217,119,6,0.78)' : 'rgba(251,191,36,0.75)', [5, 5], true);
        drawCachedArc(moonArcDirs, moonHourDirs, isSimpleBg ? 'rgba(37,99,235,0.68)' : 'rgba(147,197,253,0.65)', [2, 4], false);
      }

      // 2. Подписи вершин и объектов OSM
     if (S && S.pois && S.pois.length) {
        const L = ST.layers;
        const maxDistM = (L.maxDistKm || 42) * 1000;
        const zScale = ST.view.zScale || 1.0;
        const curv = ST.view.curvature !== false;
        const fSzBase = clamp(L.fontSize || 12, 10, 16);
        const isMass = (L.treeMode || 'mass') === 'mass';
        const op = L.canopyOpacity != null ? L.canopyOpacity : 1.0;

        const visKey = `${Math.round(cam.x * 0.25)}|${Math.round(cam.y * 0.25)}|${Math.round(cam.z * 0.25)}|${zScale}|${curv ? 1 : 0}|${L.trees !== false ? 1 : 0}|${isMass ? 1 : 0}|${L.canopyScale || 1}|${L.canopyMinH || 2}|${L.hideOccluded ? 1 : 0}|${S._visVer || 0}`;

        const zoomFactor = 48 / Math.max(cam.fov, 6);
        const halfW = Math.max(W * 0.5, 1), halfH = Math.max(H * 0.5, 1);

        const candidates = [];
        for (let i = 0; i < S.pois.length; i++) {
          const p = S.pois[i];
          if (p.cat === 'peak' && L.peaks === false) continue;
          if (p.cat === 'settlement' && L.settlements === false) continue;
          if (p.cat === 'locality' && L.localities === false) continue;
          if (p.cat === 'landmark' && L.landmarks === false) continue;

          const dx = p.wx - cam.x, dz = p.wz - cam.z;
          const dist = Math.hypot(dx, dz);
          if (dist > maxDistM || dist < 12) continue;

          const drop = curv ? (dx * dx + dz * dz) / 14646000 : 0;
          let demY = p.demRawY;
          if (zoomPatch && cam.fov <= ZOOM_HIDE_FOV &&
              Math.abs(p.wx - zoomPatch.cx) <= zoomPatch.halfM * 0.90 &&
              Math.abs(p.wz - zoomPatch.cz) <= zoomPatch.halfM * 0.90) {
            demY = zoomPatch.sampleRawY(p.wx, p.wz);
          }
          const anchorY = Math.max(p.rawY, demY) * zScale - drop;
          const sp = projectWorld(p.wx, anchorY, p.wz, W, H);
          if (!sp || sp.x < -30 || sp.x > W + 30 || sp.y < 42 || sp.y > H - 20) continue;

          const basePrio = Number(p.prio) || 150;
          const tier = basePrio >= 760 ? 1 : (basePrio >= 450 ? 2 : 3);
          const centerNorm = Math.hypot((sp.x - halfW) / halfW, (sp.y - halfH) / halfH);
          // При зуме отдаём приоритет объектам, которые пользователь держит ближе к центру кадра
          const centerBoost = zoomFactor > 1.2 ? (1 - clamp(centerNorm, 0, 1)) * Math.min(260, (zoomFactor - 1.0) * 140) : 0;
          const viewScore = (p === selectedPoi) ? 1e9 : (basePrio + centerBoost - Math.min(70, dist / 650));

          candidates.push({ poi: p, sx: sp.x, sy: sp.y, dist, anchorY, tier, centerNorm, viewScore });
        }

        // Сортируем ДО проверки перекрытия рельефом и лесом
        candidates.sort((a, b) => b.viewScore - a.viewScore);

        const icons = { peak: '⛰️', volcano: '🌋', pass: '⛩️', settlement: '🏘️', locality: '🌾', landmark: '🧭', lake: '🌊' };
        const maxDraw = Math.round(clamp((W * H) / 42000, 10, 24));
        const maxTier3Total = Math.max(2, Math.round(maxDraw * 0.65));
        const distMode = L.showDist || 'smart';

        // Предварительно отсеиваем скрытые объекты, чтобы точно знать число видимых плашек на экране
        const visibleCands = [];
        let visChecksLeft = 45;
        for (let i = 0; i < candidates.length && visibleCands.length < maxDraw * 2; i++) {
          const c = candidates[i];
          const p = c.poi;
          const isSel = (p === selectedPoi);

          let vis;
          if (p._visKey === visKey || !ST.layers.hideOccluded) {
            vis = getPoiVisibilityCached(p, c.anchorY, visKey);
          } else if (visChecksLeft > 0 || isSel) {
            visChecksLeft--;
            vis = getPoiVisibilityCached(p, c.anchorY, visKey);
          } else {
            vis = p._vis || 'visible'; // используем прошлое состояние без фриза кадра
          }

          if (vis === 'terrain') continue;
          if (vis === 'trees' && (!isMass || op >= 0.70)) continue;
          c.occludedByTrees = (vis === 'trees');
          visibleCands.push(c);
        }

        // Чем меньше плашек на экране и чем сильнее зум — тем шире центральная зона с показом дистанции
        const sparseBonus = clamp((8 - visibleCands.length) / 6, 0, 1);
        const focusRadius = 0.28 + clamp((zoomFactor - 1.0) * 0.25, 0, 0.55) + sparseBonus * 0.75;

        const placed = [];
        for (let i = 0; i < visibleCands.length && placed.length < maxDraw; i++) {
          const c = visibleCands[i];
          const p = c.poi;
          const isSel = (p === selectedPoi);
          if (c.tier === 3 && !isSel && placed.length >= maxTier3Total) continue;

          const occludedByTrees = c.occludedByTrees;
          const showDist = isSel ||
            (distMode === 'all') ||
            (distMode === 'smart' && (c.tier === 1 || c.dist <= 3500 || c.centerNorm <= focusRadius));

        

          const fSz = c.tier === 1 ? fSzBase : (c.tier === 2 ? Math.max(10, fSzBase - 1) : Math.max(9, fSzBase - 2));
          const distFSz = Math.max(9, fSz - 2);
          const weight = c.tier === 1 ? 700 : (c.tier === 2 ? 600 : 500);
          const padX = c.tier === 1 ? 8 : 6;

          const ic = (occludedByTrees ? '🌲' : '') + (icons[p.kind] || icons[p.cat] || '📍');
          const eleTxt = p.ele != null ? ` · ${Math.round(p.ele)} м` : '';
          const line1 = `${ic} ${p.name}${eleTxt}`;
          const font1 = `${weight} ${fSz}px system-ui,-apple-system,sans-serif`;

          let w1;
          if (p._tw1Key === font1 + '|' + line1) {
            w1 = p._tw1;
          } else {
            ctx.font = font1;
            w1 = ctx.measureText(line1).width;
            p._tw1Key = font1 + '|' + line1;
            p._tw1 = w1;
          }

          let line2 = '';
          let w2 = 0;
          const font2 = `500 ${distFSz}px ui-monospace,Consolas,system-ui,sans-serif`;
          if (showDist) {
            const azDeg = ((Math.atan2(p.wx - cam.x, -(p.wz - cam.z)) / DEG) + 360) % 360;
            line2 = `${fmtDist(c.dist)} · ${degToCompass(azDeg)}`;
            if (p._tw2Key === font2 + '|' + line2) {
              w2 = p._tw2;
            } else {
              ctx.font = font2;
              w2 = ctx.measureText(line2).width;
              p._tw2Key = font2 + '|' + line2;
              p._tw2 = w2;
            }
          }

          const boxW = Math.round(Math.max(w1, w2) + padX * 2);
          const boxH = Math.round(showDist ? (fSz + distFSz + 13) : (fSz + 10));

          const gapX = c.tier === 1 ? 8 : (c.tier === 2 ? 14 : 26);
          const gapY = c.tier === 1 ? 6 : (c.tier === 2 ? 10 : 18);

          const stems = c.tier === 1 ? [24, 46, 70] : (c.tier === 2 ? [22, 44] : [20]);
          const bx = Math.round(clamp(c.sx - boxW / 2, 6, W - boxW - 6));
          let by = -1;
          for (const stem of stems) {
            const ty = Math.round(c.sy - stem - boxH);
            if (ty < 46) continue;
            let overlaps = false;
            for (let rIdx = 0; rIdx < placed.length; rIdx++) {
              const r = placed[rIdx];
              if (bx < r.x + r.w + gapX && bx + boxW + gapX > r.x &&
                  ty < r.y + r.h + gapY && ty + boxH + gapY > r.y) {
                overlaps = true;
                break;
              }
            }
            if (!overlaps) { by = ty; break; }
          }
          if (by < 0 && !isSel) continue;
          if (by < 0) by = Math.max(46, Math.round(c.sy - 24 - boxH));

          const peakCol = p.cat === 'peak' ? '#f59e0b' : (p.cat === 'settlement' ? '#60a5fa' : '#34d399');

          ctx.globalAlpha = isSel ? 1 : (occludedByTrees ? 0.72 : (c.tier === 3 ? 0.84 : 1));

          ctx.strokeStyle = isSel ? '#4da3ff' : (isSimpleBg ? 'rgba(19,26,36,0.50)' : 'rgba(255,255,255,0.45)');
          ctx.lineWidth = isSel ? 1.8 : 1.0;
          ctx.beginPath();
          ctx.moveTo(c.sx, c.sy);
          ctx.lineTo(c.sx, by + boxH);
          ctx.stroke();

          ctx.fillStyle = isSel ? '#4da3ff' : peakCol;
          ctx.beginPath();
          ctx.arc(c.sx, c.sy, isSel ? 4.2 : (c.tier === 1 ? 3.0 : 2.3), 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = isSel
            ? 'rgba(30, 64, 120, 0.94)'
            : (isSimpleBg ? 'rgba(255,255,255,0.90)' : 'rgba(12,16,23,0.82)');
          ctx.strokeStyle = isSel
            ? '#4da3ff'
            : (c.tier === 1
                ? (isSimpleBg ? 'rgba(19,26,36,0.32)' : 'rgba(255,255,255,0.28)')
                : (isSimpleBg ? 'rgba(19,26,36,0.16)' : 'rgba(255,255,255,0.13)'));
          ctx.lineWidth = isSel ? 1.5 : 1;

          ctx.beginPath();
          ctx.roundRect(bx, by, boxW, boxH, 7);
          ctx.fill();
          ctx.stroke();

          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.font = font1;
          ctx.fillStyle = isSel ? '#ffffff' : txtCol;
          const y1 = showDist ? (by + 6 + fSz * 0.5) : (by + boxH * 0.5);
          ctx.fillText(line1, bx + padX, y1);

          if (showDist) {
            ctx.font = font2;
            ctx.fillStyle = isSel ? '#bfdbfe' : subTxtCol;
            ctx.textAlign = 'center';
            ctx.fillText(line2, bx + boxW * 0.5, by + boxH - 5 - distFSz * 0.45);
          }

          const rect = { x: bx, y: by, w: boxW, h: boxH, sx: c.sx, sy: c.sy, poi: p };
          placed.push(rect);
          labelBoxes.push(rect);
        }
        ctx.globalAlpha = 1;
        candCnt = candidates.length;
        drawnCnt = placed.length;
      }

      // 3. Верхняя лента компаса
      const compW = Math.min(340, W - 24);
      const compX = (W - compW) / 2;
      const compY = 8;
      const compH = 30;
      const yawDeg = ((cam.yaw / DEG) % 360 + 360) % 360;
      const fovyRad = cam.fov * DEG;
      const fovHorDeg = (2 * Math.atan(Math.tan(fovyRad / 2) * (W / Math.max(H, 1)))) / DEG;
      const pxPerDeg = W / Math.max(fovHorDeg, 10);

      ctx.save();
      ctx.fillStyle = isSimpleBg ? 'rgba(255,255,255,0.82)' : 'rgba(12,16,23,0.75)';
      ctx.strokeStyle = isSimpleBg ? 'rgba(19,26,36,0.18)' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(compX, compY, compW, compH, 999);
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.roundRect(compX + 6, compY, compW - 12, compH, 999);
      ctx.clip();

      const cardinals = { 0: 'С', 45: 'СВ', 90: 'В', 135: 'ЮВ', 180: 'Ю', 225: 'ЮЗ', 270: 'З', 315: 'СЗ' };
      const centerX = W / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let deg = 0; deg < 360; deg += 15) {
        const diff = ((deg - yawDeg + 540) % 360) - 180;
        const tx = centerX + diff * Math.min(pxPerDeg, compW / 95);
        if (tx < compX || tx > compX + compW) continue;
        const lbl = cardinals[deg];
        if (lbl) {
          ctx.fillStyle = deg === 0 ? '#ef4444' : txtCol;
          ctx.font = '700 11px system-ui,sans-serif';
          ctx.fillText(lbl, tx, compY + 11);
        } else {
          ctx.strokeStyle = subTxtCol;
          ctx.beginPath(); ctx.moveTo(tx, compY + 4); ctx.lineTo(tx, compY + 9); ctx.stroke();
        }
      }

      // Метки Солнца и Луны на компасе
      const sunAzD = ((sunPos.az / DEG) % 360 + 360) % 360;
      const moonAzD = ((moonPos.az / DEG) % 360 + 360) % 360;
      [
        [sunAzD, '#f59e0b'],
        [moonAzD, '#60a5fa']
      ].forEach(([azD, col]) => {
        const diff = ((azD - yawDeg + 540) % 360) - 180;
        const tx = centerX + diff * Math.min(pxPerDeg, compW / 95);
        if (tx >= compX + 8 && tx <= compX + compW - 8) {
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(tx, compY + 6, 3, 0, Math.PI * 2); ctx.fill();
        }
      });

      ctx.restore();

      // Текущий точный курс по центру внизу плашки компаса
      ctx.fillStyle = '#4da3ff';
      ctx.beginPath();
      ctx.moveTo(centerX, compY + compH - 1);
      ctx.lineTo(centerX - 4, compY + compH + 4);
      ctx.lineTo(centerX + 4, compY + compH + 4);
      ctx.closePath();
      ctx.fill();

      ctx.font = '700 10.5px ui-monospace,Consolas,monospace';
      ctx.fillStyle = txtCol;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(yawDeg)}° ${degToCompass(yawDeg)}`, centerX, compY + 23);

      // 4. Лёгкое перекрестие в центре экрана
      ctx.strokeStyle = isSimpleBg ? 'rgba(19,26,36,0.28)' : 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      const cx0 = W / 2, cy0 = H / 2;
      ctx.beginPath();
      ctx.moveTo(cx0 - 8, cy0); ctx.lineTo(cx0 - 3, cy0);
      ctx.moveTo(cx0 + 3, cy0); ctx.lineTo(cx0 + 8, cy0);
      ctx.moveTo(cx0, cy0 - 8); ctx.lineTo(cx0, cy0 - 3);
      ctx.moveTo(cx0, cy0 + 3); ctx.lineTo(cx0, cy0 + 8);
      ctx.stroke();

      hudStat.ms = performance.now() - tHud0;
      hudStat.cand = candCnt;
      hudStat.drawn = drawnCnt;
    }

    let layoutChipsTm = 0;
    function layoutChipsNow() {
      layoutChipsTm = 0;
      if (destroyed || !chipsEl || !viewEl) return;
      const W = viewW || viewEl.clientWidth || 0;
      if (!W) return;
      const compW = Math.min(340, W - 24);
      const compX = (W - compW) / 2;
      const availLeft = compX - 16; // 8px от левого края + 8px зазор до компаса
      const chipsW = chipsEl.offsetWidth || 0;
      const nextTop = (chipsW > 0 && chipsW <= availLeft) ? '8px' : '46px';
      if (chipsEl._lastTop !== nextTop) {
        chipsEl._lastTop = nextTop;
        chipsEl.style.top = nextTop;
      }
    }
    function layoutChips() {
      if (layoutChipsTm) return;
      layoutChipsTm = setTimeout(layoutChipsNow, 0);
    }

    function updateChips() {
      if (!chipsEl || !geo || !atm) return;
      const chips = [];
      const obsEle = S ? Math.round(S.sampleElevAbs(cam.x, cam.z) + ST.camera.eyeHeight) : 0;
      const dStart = Math.hypot(cam.x, cam.z);
      const curLL = geo.worldToLatLng(cam.x, cam.z);

      chips.push(`📍 ${curLL.lat.toFixed(4)}, ${curLL.lng.toFixed(4)}`);
      chips.push(`⛰️ ${obsEle} м (глаза +${ST.camera.eyeHeight.toFixed(1)} м)`);
      if (dStart > 8) chips.push(`🚶 от старта ${fmtDist(dStart)}`);
      chips.push(`🔍 ${Math.round(cam.fov)}°`);
      if (zoomLoading) chips.push('🔭 HD рельеф…');
      else if (zoomPatch && cam.fov <= ZOOM_HIDE_FOV) {
        chips.push(`🔭 HD z${zoomPatch.z} (${Math.round((zoomPatch.halfM * 2) / (ZOOM_N - 1))}м)`);
      }
      const chChip = sampleCanopyHeight(cam.x, cam.z);
      if (chChip > 0 && ST.camera.eyeHeight < chChip + 0.3) {
        chips.push(`🌲 в лесу (~${Math.round(chChip)} м)`);
      }

      const ms = getSkyMs();
      const d = new Date(ms);
      const hDisp = ST.sky.timeMode === 'manual'
        ? fmtH(ST.sky.hour)
        : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      chips.push(`${atm.night > 0.4 ? '🌙' : '☀️'} ${hDisp}`);

      if (hub) {
         const sm = hub.summary();
         const usedFallback = ['demOuter', 'demMid', 'demInner'].some(id => hub.sources[id]?.data?.fallback);
         if (usedFallback) chips.push('⚠️ DEM: резерв (AWS)');
         if (sm.loading) chips.push(`⏳ загрузка: ${sm.loading}`);
         else if (sm.error) chips.push(`❌ недоступно: ${sm.error}`);
         else if (sm.warn) chips.push(`⚠️ частично: ${sm.warn}`);
       }

      const key = chips.join('|');
      if (key !== chipsEl._lastKey) {
        chipsEl._lastKey = key;
        while (chipsEl.children.length > chips.length) chipsEl.lastChild.remove();
        for (let i = 0; i < chips.length; i++) {
          let node = chipsEl.children[i];
          if (!node) {
            node = el('span', { class: 'pkv-chip' });
            chipsEl.append(node);
          }
          if (node.textContent !== chips[i]) node.textContent = chips[i];
        }
        layoutChips();
      }

      if (refs.astroInfo) {
        const sunAzD = Math.round(((sunPos.az / DEG) % 360 + 360) % 360);
        const moonAzD = Math.round(((moonPos.az / DEG) % 360 + 360) % 360);
        refs.astroInfo.textContent = `☀️ Солнце: ${Math.round(sunPos.alt / DEG)}° выс., ${sunAzD}° ${degToCompass(sunAzD)} · 🌙 Луна: ${Math.round(moonPos.alt / DEG)}° выс., ${moonAzD}° ${degToCompass(moonAzD)} (${Math.round(moonPos.illum * 100)}%)`;
      }
    }

    // =========================================================================
    // 13. ГЛАВНЫЙ ЦИКЛ КАДРА И ЖИЗНЕННЫЙ ЦИКЛ ЭКЗЕМПЛЯРА
    // =========================================================================
    const MODE_MAP = { contour: 0, cg: 1, hypso: 2, slope: 3, topo: 4, hybrid: 5 };
    let lastChipTs = 0;

    let lastForestAlertKey = '';
    let lastAtZoneEdge = false;


    let lastRenderTs = 0;
    let wasMovingUp = false;
    const TARGET_FPS = 0; // можно вынести в ST.view.fpsLimit (0 = без лимита, 30 = лок 30 FPS)
    const FRAME_GATE_MS = TARGET_FPS ? (1000 / TARGET_FPS - 5.0) : 0;

    function frame(ts) {
      raf = 0;
      if (idleTrimTm) { clearTimeout(idleTrimTm); idleTrimTm = 0; }
      if (destroyed || min || !R || R.lost || !S) return;

      // Лок 30 FPS: пропускаем промежуточные vsync-тики
      if (FRAME_GATE_MS > 0 && lastRenderTs > 0 && (ts - lastRenderTs) < FRAME_GATE_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }

      inFrame = true;
      let keepLoop = false;
      try {
        const tFrame0 = performance.now();
        const hasPrevTs = lastRenderTs > 0;
        const frameDtMs = hasPrevTs ? (ts - lastRenderTs) : (1000 / (TARGET_FPS || 60));
        // Сглаженный/фиксированный шаг для движения убирает рывки скорости при случайном лаге
        const dt = clamp(frameDtMs / 1000, 0.004, 0.05);
        lastRenderTs = ts;

        // 1. Перемещение (WASD, стрелки, стик или точка клика)
        let fwd = -joy.dy, right = joy.dx, moveUp = 0;
        if (keys.KeyW || keys.ArrowUp) fwd += 1;
        if (keys.KeyS || keys.ArrowDown) fwd -= 1;
        if (keys.KeyD || keys.ArrowRight) right += 1;
        if (keys.KeyA || keys.ArrowLeft) right -= 1;
        if (keys.KeyE) moveUp += 1;
        if (keys.KeyQ) moveUp -= 1;

        const isMoving = Math.abs(fwd) > 0.01 || Math.abs(right) > 0.01 || Math.abs(moveUp) > 0.01 || cam.movingToTarget;

        if (Math.abs(fwd) > 0.01 || Math.abs(right) > 0.01) {
          cam.movingToTarget = false;
          const speed = (keys.ShiftLeft || keys.ShiftRight ? 180 : 55) * dt;
          const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
          cam.x += (sy * fwd + cy * right) * speed;
          cam.z += (-cy * fwd + sy * right) * speed;
        } else if (cam.movingToTarget) {
          const dx = cam.targetX - cam.x, dz = cam.targetZ - cam.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 1.5) {
            cam.x = cam.targetX; cam.z = cam.targetZ;
            cam.movingToTarget = false;
          } else {
            const step = Math.min(dist, Math.max(45, dist * 3.0) * dt);
            cam.x += (dx / dist) * step;
            cam.z += (dz / dist) * step;
          }
        }

        // Ограничиваем зону прогулки загруженным участком (±2.4 км)
        const dOriginNow = Math.hypot(cam.x, cam.z);
        const atZoneEdge = dOriginNow >= WALK_LIMIT - 15;
        if (atZoneEdge !== lastAtZoneEdge) {
          lastAtZoneEdge = atZoneEdge;
          edgeAlertEl.classList.toggle('on', atZoneEdge);
        }

        if (Math.abs(moveUp) > 0.01) {
          wasMovingUp = true;
          setEyeHeight(ST.camera.eyeHeight + moveUp * 18 * dt, true);
        } else if (wasMovingUp) {
          wasMovingUp = false;
          ST.camera.eyeHeight = Math.round(ST.camera.eyeHeight * 10) / 10;
          save();
        }

      const zScale = ST.view.zScale || 1.0;
      const groundY = S ? S.sampleRawY(cam.x, cam.z) * zScale : 0;
      cam.y = groundY + (ST.camera.eyeHeight || 2.0);
      cam.pos = [cam.x, cam.y, cam.z];

      const isMassMode = (ST.layers.treeMode || 'mass') === 'mass';
      const chHere = sampleCanopyHeight(cam.x, cam.z);
      const inForest = chHere > 0 && (ST.camera.eyeHeight < chHere + 0.3);
      const alertKey = inForest ? `${Math.round(chHere)}|${isMassMode ? 1 : 0}|${ST.layers.canopyOpacity}` : '';

      if (alertKey !== lastForestAlertKey) {
        lastForestAlertKey = alertKey;
        forestAlertEl.textContent = '';
        if (inForest) {
          const liftH = clamp(Math.ceil(chHere + 2.5), 2, 180);
          forestAlertEl.append(
            el('span', { text: `🌲 Вы в лесу (кроны ~${Math.round(chHere)} м) — обзор перекрыт` }),
            el('button', {
              class: 'pkv-b', type: 'button', text: `▲ Над кронами (${liftH} м)`,
              onclick: () => setEyeHeight(liftH)
            })
          );
          if (isMassMode && (ST.layers.canopyOpacity == null || ST.layers.canopyOpacity > 0.65)) {
            forestAlertEl.append(el('button', {
              class: 'pkv-b', type: 'button', text: '👁️ Просветить (50%)',
              onclick: () => {
                ST.layers.canopyOpacity = 0.5;
                syncTreeUiControls();
                save();
                requestRender();
              }
            }));
          }
          forestAlertEl.classList.add('on');
        } else {
          forestAlertEl.classList.remove('on');
        }
      }

      // 2. Матрицы камеры
      const cssW = viewW || Math.max(10, glCanvas.clientWidth);
      const cssH = viewH || Math.max(10, glCanvas.clientHeight);
      const qDpr = ST.view.quality === 'high'
        ? Math.min(window.devicePixelRatio || 1, 2.0)
        : (ST.view.quality === 'low' ? 0.75 : Math.min(window.devicePixelRatio || 1, 1.25));
      qDprLast = qDpr * glResScale;
      const rw = Math.max(2, Math.round(cssW * qDpr * glResScale));
      const rh = Math.max(2, Math.round(cssH * qDpr * glResScale));

      const cp = Math.cos(cam.pitch);
      const lookDir = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
      const near = 1.0, far = 95000.0;

      M4.lookAt(cam.pos, [cam.x + lookDir[0] * 100, cam.y + lookDir[1] * 100, cam.z + lookDir[2] * 100], [0, 1, 0], mView);
      M4.persp(cam.fov * DEG, cssW / cssH, near, far, mProj);
      M4.mul(mProj, mView, mVP);
      M4.inv(mVP, mInv);

      // 3. Астрономия и рендер WebGL2
      if (ST.sky.timeMode === 'now' && ts - lastChipTs > 1000) updateAstro();

      const modeIdx = MODE_MAP[ST.view.mode] != null ? MODE_MAP[ST.view.mode] : 0;
      const isSimpleSky = (modeIdx === 0 || modeIdx === 4);
      const skyTop = isSimpleSky
        ? atm.contourSkyTop
        : (modeIdx === 5 ? mix3(atm.contourSkyTop, atm.skyTop, 0.55) : atm.skyTop);
      const skyHor = isSimpleSky
        ? atm.contourSkyHor
        : (modeIdx === 5 ? mix3(atm.contourSkyHor, atm.skyHor, 0.55) : atm.skyHor);

      const sunDir = dirFromAltAz(sunPos.alt, sunPos.az);
      const moonDir = dirFromAltAz(moonPos.alt, moonPos.az);
      const lightDir = atm.night > 0.45 ? moonDir : sunDir;

      const zoomSig = `${Math.round(cam.x)}|${Math.round(cam.z)}|${(cam.yaw / DEG).toFixed(1)}|${(cam.pitch / DEG).toFixed(1)}|${Math.round(cam.fov)}`;
      if (zoomSig !== lastZoomViewSig) {
        lastZoomViewSig = zoomSig;
        if (cam.fov <= ZOOM_MIN_FOV) {
          if (zoomTimer) clearTimeout(zoomTimer);
          zoomTimer = setTimeout(runZoomCheck, 240);
        } else {
          if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = 0; }
          if (zoomJobCtl) { try { zoomJobCtl.abort(); } catch (e) {} zoomJobCtl = null; zoomLoading = false; }
          if (cam.fov > ZOOM_HIDE_FOV && zoomPatch) {
            zoomPatch = null;
            if (R && R.clearZoomPatch) R.clearZoomPatch();
          }
        }
      }

      const sfData = analyzeSmartFog(cssW, cssH, dt);

      R.render({
        w: rw, h: rh,
        wantGpuTimer: !!ST.view.perfOverlay,
        vp: mVP, invVP: mInv,
        cam: cam.pos,
        camFwd: [Math.sin(cam.yaw), -Math.cos(cam.yaw)],
        time: ts * 0.001,
        zScale,
        curv: ST.view.curvature !== false,
        lightDir,
        lightInt: atm.lint,
        lcol: atm.lcol,
        zoomActive: cam.fov <= ZOOM_HIDE_FOV,
        night: atm.night,
        skyTop, skyHor,
        mode: modeIdx,
        showIso: !!ST.view.showIsolines,
        isoStep: ST.view.isoStep || 50,
        h0: S.h0,
        fogDist: ST.view.fogDist || 42000,
        smartFog: sfData,
        hMin: S.hMin,
        hMax: S.hMax,
         showBuildings: ST.layers.buildings !== false,
        bldHeightScale: ST.layers.bldHeightScale || 1.0,

        roadPavedDay: lin3(hex3(ST.layers.roadPavedDay || DEF.layers.roadPavedDay)),
        roadPavedNight: lin3(hex3(ST.layers.roadPavedNight || DEF.layers.roadPavedNight)),
        roadTrailDay: lin3(hex3(ST.layers.roadTrailDay || DEF.layers.roadTrailDay)),
        roadTrailNight: lin3(hex3(ST.layers.roadTrailNight || DEF.layers.roadTrailNight)),
        castTerrainShadows: !!ST.view.castTerrainShadows,
        castForestShadows: !!(ST.layers.trees !== false && ST.layers.castForestShadows),
        shadowTreeMinH: isMassMode ? (ST.layers.canopyMinH || 2.0) : 2.2,
        shadowTreeScale: isMassMode ? (ST.layers.canopyScale || 1.0) : 1.0,
        moonDir,
        moonAltDeg: moonPos.alt / DEG,
        moonPhase: moonPos.phase != null ? moonPos.phase : 0.5,
        moonIllum: moonPos.illum != null ? moonPos.illum : 0.5,
        moonAngle: moonPos.angle || 0.0,
        dark: !!ST.view.darkTheme,
        showPavedRoads: ST.layers.roadsPaved !== false,
        showTrailRoads: ST.layers.roadsTrail !== false,
        showRivers: ST.layers.rivers !== false,
        showTrees: ST.layers.trees !== false,
        canopyMassMode: isMassMode,
        treeHeightLines: ST.layers.treeHeightLines !== false,
        hideOccludedTerrainLines: ST.layers.hideOccludedTerrainLines !== false,
        canopyOpacity: ST.layers.canopyOpacity != null ? ST.layers.canopyOpacity : 1.0,
        massTerrainContours: !!ST.layers.massTerrainContours,
        canopyMinH: ST.layers.canopyMinH || 2.0,
        canopyScale: ST.layers.canopyScale || 1.0,
        canopyWave: ST.layers.canopyWave != null ? ST.layers.canopyWave : 0.75,
        // >>> ДОБАВИТЬ ЭТО:
        canopyNearHalf: (hub && hub.sources.canopy && hub.sources.canopy.state === 'ok' && hub.sources.canopy.data)
          ? (hub.sources.canopy.data.halfM || CANOPY_HALF)
          : CANOPY_HALF,
        // <<<
        inForest,
        wallVer: `${S._visVer || 0}|${S.canopyTreesSig || ''}`,
        fillClearWall: (buf, segs, radius) => {
          const treeZ = lerp(1.0, zScale, 0.35);
          const putPt = (idx, wx, y, wz, fade, rim, slope) => {
            buf[idx] = wx; buf[idx + 1] = y; buf[idx + 2] = wz;
            buf[idx + 3] = fade; buf[idx + 4] = rim; buf[idx + 5] = slope;
          };
          for (let i = 0; i <= segs; i++) {
            const a = (i / segs) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const r0 = canopyHoleRadius(a, cam.x, cam.z, radius);
            const wx0 = cam.x + ca * r0, wz0 = cam.z + sa * r0;
            const surfH = S.sampleCanopySurfRawH ? S.sampleCanopySurfRawH(wx0, wz0) : sampleCanopyHeight(wx0, wz0);
            const baseO = i * 36;

            if (surfH <= 0) {
              const gy0 = S.sampleRawY(wx0, wz0) * zScale;
              for (let k = 0; k < 6; k++) {
                putPt(baseO + k * 6, wx0, gy0 + (k === 5 ? -2.0 : -1.5), wz0, 0, 0, 0);
              }
              continue;
            }

            const fade0 = clamp(surfH / 1.5, 0, 1);
            const effH = surfH * treeZ;
            const cw = 0.5 + 0.5 * Math.sin(7.0 * a + cam.x * 0.09 + cam.z * 0.07);
            const setRow = (k, r, dy, fade, rim, slope) => {
              const wx = cam.x + ca * r, wz = cam.z + sa * r;
              putPt(baseO + k * 6, wx, S.sampleRawY(wx, wz) * zScale + dy, wz, fade, rim, slope);
            };
            setRow(0, r0,                            effH,                    fade0,        0.0, 0.0);
            setRow(1, r0 - (1.1 + 0.7 * cw) * fade0, effH * (0.85 + 0.11 * cw), fade0,      1.0, 0.0);
            setRow(2, r0 - (0.4 + 0.3 * cw) * fade0, effH * 0.56,             fade0,        1.0, 0.0);
            setRow(3, r0 + 0.9 * fade0,              effH * 0.24,             fade0,        1.0, 0.2);
            setRow(4, r0 + 2.5 * fade0,              0.35 * fade0,            fade0 * 0.92, 1.0, 1.0);
            setRow(5, r0 + 3.4 * fade0,             -2.4,                     0.0,          1.0, 0.0);
          }
        },
        sunDir,
        sunAltDeg: atm.altD,
        sunCol: atm.sunCol,
        showEdges: ST.view.showEdges !== false,
        near, far
      });

      // 4. 2D HUD
      drawHud(cssW, cssH);

      if (ts - lastChipTs > (isMoving ? 140 : 450)) {
        lastChipTs = ts;
        updateChips();
      }

        const cpuFrameMs = performance.now() - tFrame0;
        keepLoop = isMoving || dirty || (sfData && sfData._animating) || (ST.view.perfOverlay && ST.view.perfContinuous) || R.bakeBusy || R.needRedraw;
        R.needRedraw = false;

        // Адаптация разрешения под реальную скорость кадров (только во время движения камеры)
        if (isMoving && hasPrevTs && frameDtMs < 500 && !document.hidden) {
          if (frameDtMs > 55) { slowFrames++; fastFrames = 0; }
          else if (frameDtMs < 20) { fastFrames++; slowFrames = 0; }
          else { slowFrames = 0; fastFrames = 0; }
          if (slowFrames >= 18 && glResScale > 0.56) {
            glResScale = Math.max(0.55, glResScale * 0.85);
            resDownCount = Math.min(4, resDownCount + 1);
            slowFrames = 0; dirty = true;
          } else if (fastFrames >= 240 * (1 + resDownCount) && glResScale < 1) {
            glResScale = Math.min(1, glResScale * 1.12);
            fastFrames = 0; dirty = true;
          }
        }
        updatePerfUi(ts, (keepLoop && hasPrevTs && frameDtMs < 500) ? frameDtMs : cpuFrameMs, keepLoop);
      } finally {
        inFrame = false;
      }

      if (keepLoop) {
        dirty = false;
        raf = requestAnimationFrame(frame);
      } else {
        lastRenderTs = 0; // <-- сбросить при уходе в простой
        // В простое через 3.5 с освобождаем неиспользуемые буферы леса/стены (пересоздаются сами при надобности)
        if (idleTrimTm) clearTimeout(idleTrimTm);
        idleTrimTm = setTimeout(() => { idleTrimTm = 0; if (R && !R.lost && !destroyed) R.trimIdle(); }, 3500);
      }
    }

    function updateDemOverlay() {
      if (!hub || !S) return;
      const demIds = ['demOuter', 'demMid', 'demInner'];
      const demSources = demIds.map(id => hub.sources[id]).filter(s => s && s.enabled);
      const demLoading = demSources.some(s => s.state === 'loading') && !S.demOk;
      const demFailed = demSources.length > 0 && !demLoading && !S.demOk && demSources.every(s => s.state === 'error');

      if (demLoading) {
        msgEl.textContent = '';
        msgEl.append(el('div', { class: 'pkv-spin' }), el('span', { text: 'Загрузка рельефа…' }));
        msgEl.classList.add('on');
      } else if (demFailed) {
        msgEl.textContent = '';
        msgEl.append(
          el('div', { style: 'font-size:22px', text: '⚠️' }),
          el('div', { text: 'Данные рельефа (DEM) временно недоступны' }),
          el('div', { class: 'pkv-note', text: demSources[0].msg || 'Ошибка загрузки тайлов высот' }),
          el('button', {
            class: 'pkv-b prime', type: 'button', text: '🔄 Повторить загрузку',
            onclick: () => { hub.reloadAll(); updateDemOverlay(); }
          })
        );
        msgEl.classList.add('on');
      } else {
        msgEl.classList.remove('on');
      }
    }

    function applySceneSync() {
      syncSceneTimer = 0;
      if (destroyed || !geo || !hub || !R) return;
      S = composeSceneIncremental(geo, hub, ST.layers);
      R.uploadScene(S);
      if (zoomPatch && zoomPatch.demSig !== S.demSig) {
        clearZoomState();
        if (cam.fov <= ZOOM_MIN_FOV) zoomTimer = setTimeout(runZoomCheck, 80);
      }
      updateDemOverlay();
      if (poiCard.classList.contains('on') && selectedPoi) {
        const updated = S.pois.find(p => p.id === selectedPoi.id);
        if (updated) showPoiCard(updated, { keepPos: true });
      }
      updateChips();
      requestRender();
    }

    function syncSceneDeferred() {
      if (syncSceneTimer) clearTimeout(syncSceneTimer);
      syncSceneTimer = setTimeout(applySceneSync, 16);
    }

    let lastProgUiTs = 0;
    function onHubChange(id, kind) {
      if (kind === 'progress') {
        const now = performance.now();
        if (now - lastProgUiTs < 150) return;
        lastProgUiTs = now;
        renderDots();
        if (ST.panel && ST.tab === 'sources') renderSources();
        return;
      }
      renderDots();
      if (ST.panel && ST.tab === 'sources') renderSources();
      if (kind === 'data' && geo && hub) {
        syncSceneDeferred();
      }
    }

    const I = {
      minimize() {
        if (min) return;
        min = true;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (R && !R.lost) R.trim(true); // свёрнуто в «пилюлю» — буферы кадра не нужны
        stopSensor();
        winEl.classList.add('pkv-hide');
        pillEl.classList.add('on');
        renderDots();
      },
      restore(skipAutoRefresh) {
        if (!min) return;
        min = false;
        winEl.classList.remove('pkv-hide');
        pillEl.classList.remove('on');
        if (!skipAutoRefresh && ST.view.refreshOnRestore !== false && WM.map && WM.map.getCenter) {
          const c = WM.map.getCenter();
          const nextKey = `${clamp(c.lat, -83, 83).toFixed(4)},${c.lng.toFixed(4)}`;
          if (!geo || geo.key !== nextKey) {
            I.reopenAt(c.lat, c.lng);
            toast('🗺️ Точка обзора обновлена по центру карты');
          }
        }
        if (ST.camera.sensorOn) setSensorMode(true);
        requestRender();
      },
      isMinimized: () => min,
      showOnMap() {
        const curLL = geo ? geo.worldToLatLng(cam.x, cam.z) : null;
        I.minimize();
        if (curLL && WM.map) {
          const z = WM.map.getZoom ? WM.map.getZoom() : 16;
          if (typeof WM.map.flyTo === 'function') {
            WM.map.flyTo([curLL.lat, curLL.lng], z, { animate: true, duration: 0.7 });
          } else if (typeof WM.map.panTo === 'function') {
            WM.map.panTo([curLL.lat, curLL.lng], { animate: true });
          }
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('📍 Карта центрирована на вашей точке обзора');
          }
        }
      },

      reopenAt(lat, lng, reopenOpts) {
        clearZoomState(); // <-- ДОБАВИТЬ В НАЧАЛЕ
        const keepView = !!(reopenOpts && reopenOpts.keepView);
        const savedYaw = cam.yaw, savedPitch = cam.pitch;
        geo = makeOriginGeo(lat, lng);
        if (reopenOpts && reopenOpts.refreshKey) {
          for (const k of [...DC.keys()]) {
            if (k.endsWith('|' + geo.key)) DC.delete(k);
          }
        }
        cam.x = 0; cam.z = 0; cam.movingToTarget = false;
        if (keepView) { cam.yaw = savedYaw; cam.pitch = savedPitch; }
        showPoiCard(null);
        if (refs.startCoordNote) refs.startCoordNote.textContent = `Старт: ${geo.lat0.toFixed(5)}, ${geo.lng0.toFixed(5)}`;
        updateAstro();
        if (syncSceneTimer) { clearTimeout(syncSceneTimer); syncSceneTimer = 0; }
        hub.start(geo);
        if (syncSceneTimer) { clearTimeout(syncSceneTimer); syncSceneTimer = 0; }
        S = composeSceneIncremental(geo, hub, ST.layers);
         R.uploadScene(S);
         updateDemOverlay(); // было: mupdateDemOverlay();
         updateChips();
        requestRender();
      },
      requestRender,
      destroy() {
        destroyed = true;
        clearZoomState(); // <-- ДОБАВИТЬ СРАЗУ ПОСЛЕ destroyed = true
        if (syncSceneTimer) { clearTimeout(syncSceneTimer); syncSceneTimer = 0; }
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (layoutChipsTm) { clearTimeout(layoutChipsTm); layoutChipsTm = 0; }
        if (idleTrimTm) { clearTimeout(idleTrimTm); idleTrimTm = 0; }
        if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
        stopSensor();
        if (hub) hub.abort();
        if (_liveHub === hub) _liveHub = null;
        if (ro) ro.disconnect();
        cleanups.forEach(fn => { try { fn(); } catch (e) {} });
        if (R) { R.dispose(); R = null; }
        
        winEl.remove();
        pillEl.remove();
      }
    };

    listen(bRefreshCenter, 'click', () => {
      if (!geo) return;
      const curLL = geo.worldToLatLng(cam.x, cam.z);
      const movedM = Math.hypot(cam.x, cam.z);
      I.reopenAt(curLL.lat, curLL.lng, {
        keepView: true,
        refreshKey: movedM < 5 // если стоим в том же центре — сбросим запись в DC для пересборки, но тайлы возьмутся из RAM-кэша
      });
      toast(`🔄 Сцена обновлена (${curLL.lat.toFixed(5)}, ${curLL.lng.toFixed(5)})`);
    });

    // Связываем кнопки шапки
    listen(bSensor, 'click', () => setSensorMode(!ST.camera.sensorOn));
    listen(bPanel, 'click', () => {
      ST.panel = !ST.panel;
      panelEl.classList.toggle('hide', !ST.panel);
      bPanel.classList.toggle('act', ST.panel);
      save();
      requestRender();
    });
    listen(bMax, 'click', toggleMax);
    listen(bMin, 'click', () => I.minimize());
    listen(bClose, 'click', () => api.close());
    listen(dotsEl, 'click', () => {
      if (bMoved > 5) { bMoved = 0; return; }
      I.openTab && I.openTab('sources');
    });
    listen(document, 'visibilitychange', () => {
      if (document.hidden) { if (R && !R.lost) R.trim(true); } // фоновая вкладка: отдаём видеопамять системе
      else if (!min) requestRender();
    });


    listen(window, 'wm:canopy-version-change', () => {
      if (!destroyed && hub) { hub.reload('canopy'); hub.reload('canopyFar'); }
    });

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === headEl) { syncBrandOverflow(); continue; }
        const r = entry.contentRect;
        const w = (r ? r.width : viewEl.clientWidth) || 0;
        const h = (r ? r.height : viewEl.clientHeight) || 0;
        viewW = w >= 10 ? Math.round(w) : 0;
        viewH = h >= 10 ? Math.round(h) : 0;
        layoutChips();
        requestRender();
      }
    });
    ro.observe(viewEl);
    ro.observe(headEl);


    // Запуск модуля
    const start = getStartLatLng(opts);
    geo = makeOriginGeo(start.lat, start.lng);
    document.body.append(winEl, pillEl);
    applyGeom();
    setupDragWin();
    setupInput();
    updateJoystickVis();
    buildPanel();
    updateAstro();

    // --- Жизненный цикл WebGL: создание, потеря контекста, восстановление, повтор ---
    let lostCount = 0, lostWindowStart = 0, restoreTimer = 0, autoRetried = false, booted = false;

    const showGlFailure = (e, canRetry) => {
      msgEl.textContent = '';
      msgEl.append(el('div', { text: '⚠ ' + ((e && e.message) || e) }));
      if (canRetry) msgEl.append(el('button', { class: 'pkv-b prime', type: 'button', text: '🔄 Повторить', onclick: () => retryGl() }));
      msgEl.append(el('button', { class: 'pkv-b', type: 'button', text: 'Закрыть', onclick: () => api.close() }));
      msgEl.classList.add('on');
    };

    function onGlLost() {
      console.warn('[PeakView] WebGL context lost');
      const now = performance.now();
      if (now - lostWindowStart > 30000) { lostWindowStart = now; lostCount = 0; }
      lostCount++;
      PERF.degrade('context-lost');
      glResScale = Math.min(glResScale, 0.8);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      toast('Контекст WebGL потерян — восстанавливаю…');
      if (restoreTimer) clearTimeout(restoreTimer);
      // Если браузер так и не вернул контекст — не мерцаем бесконечно, а честно предлагаем повторить
      restoreTimer = setTimeout(() => {
        restoreTimer = 0;
        if (!destroyed && R && R.lost) {
          showGlFailure(new Error('Браузер не вернул графический контекст (не хватает видеопамяти или открыто слишком много WebGL-слоёв). Закройте лишние вкладки/слои и нажмите «Повторить».'), true);
        }
      }, 8000);
    }

    function onGlRestored() {
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
      if (destroyed) return;
      // Пауза растёт при повторных потерях, чтобы не раскачивать цикл «потеря — восстановление»
      const delay = Math.min(1500, 120 * lostCount * lostCount);
      restoreTimer = setTimeout(() => {
        restoreTimer = 0;
        if (destroyed) return;
        try {
          initRenderer();
          if (S) {
            R.uploadScene(S);
            if (zoomPatch) R.uploadZoomPatch(zoomPatch);
          }
          updateDemOverlay();
          requestRender();
        } catch (e) {
          console.error('[PeakView] WebGL restore error:', e);
          showGlFailure(e, true);
        }
      }, delay);
    }

    const initRenderer = () => {
      if (R && R.detach) R.detach();
      R = createRenderer(glCanvas, onGlLost, onGlRestored);
    };

    const bootScene = () => {
      booted = true;
      hub = createHub(onHubChange, ST.sources);
      _liveHub = hub;
      hub.start(geo);
      if (syncSceneTimer) { clearTimeout(syncSceneTimer); syncSceneTimer = 0; }
      S = composeSceneIncremental(geo, hub, ST.layers);
      R.uploadScene(S);
      updateDemOverlay();
      renderDots();
      updateChips();

      if (ST.camera.sensorOn) {
        setSensorMode(true);
      }
      requestRender();
    };

    function retryGl() {
      if (destroyed) return;
      try {
        initRenderer();
        if (!booted) bootScene();
        else {
          if (S) { R.uploadScene(S); if (zoomPatch) R.uploadZoomPatch(zoomPatch); }
          updateDemOverlay();
          requestRender();
        }
      } catch (e) {
        console.error('[PeakView] Renderer retry error:', e);
        showGlFailure(e, true);
      }
    }

    try {
      initRenderer();
    } catch (e) {
      console.error('[PeakView] Renderer init error:', e);
      PERF.degrade('init-fail');
      showGlFailure(e, true);
      // Один автоматический повтор: часто контекст не создаётся из-за соседнего слоя, который освобождается через секунду
      if (!autoRetried && !destroyed) {
        autoRetried = true;
        restoreTimer = setTimeout(() => { restoreTimer = 0; retryGl(); }, 1400);
      }
      return I;
    }

    bootScene();

function rebuildCanopy(which = 'both') {
      if (!S || !R || !hub) return;
      const src = hub.sources;
      const hasAny = (src.canopy && src.canopy.state === 'ok' && src.canopy.data) ||
                     (src.canopyFar && src.canopyFar.state === 'ok' && src.canopyFar.data);
      if (!hasAny) return;
      const res = assembleCanopyImpostors(src, S.sampleElevAbs, S.h0, which);
      if (which === 'both' || which === 'near') {
        S.canopyData = res.near ? res.near.data : null;
        S.canopyCount = res.near ? res.near.count : 0;
        S.canopyChunks = res.near ? res.near.chunks : null;
      }
      if (which === 'both' || which === 'far') {
        S.canopyFarData = res.far ? res.far.data : null;
        S.canopyFarCount = res.far ? res.far.count : 0;
        S.canopyFarChunks = res.far ? res.far.chunks : null;
      }
      R.updateCanopy(S);
      requestRender();
    }

    I._dev = {
      ST,
      save,
      updateAstro,
      requestRender,
      syncTreeUiControls,
      syncTerrainUi() {
        if (refs.chkIsolines) refs.chkIsolines.input.checked = !!ST.view.showIsolines;
        if (refs.chkIsolinesMain) refs.chkIsolinesMain.input.checked = !!ST.view.showIsolines;
      },
      onIsolinesChange: null,
      syncScene: syncSceneNow,
      rebuildCanopy
    };

    return I;
  }

  // ===========================================================================
  // 14. ПУБЛИЧНЫЙ API
  // ===========================================================================
  const api = WM.peakView = {
    _loaded: true,
    perf: PERF,
    open(opts) {
      if (inst) {
        const hasExplicit = !!(opts && (opts.latLng || (opts.lat != null && opts.lng != null)));
        inst.restore(hasExplicit);
        if (hasExplicit) {
          const p = getStartLatLng(opts);
          inst.reopenAt(p.lat, p.lng);
        }
        return inst;
      }
      inst = createInstance(opts);
      return inst;
    },
    close() {
      if (!inst) return;
      const curInst = inst;
      inst = null;
      curInst.destroy();
    },
    toggle(opts) {
      if (inst && !inst.isMinimized()) api.close();
      else api.open(opts);
    },
    minimize() { if (inst) inst.minimize(); },

    restore(skipAutoRefresh) { if (inst) inst.restore(skipAutoRefresh); },
    isOpen() { return !!inst; },
    isMinimized() { return !!inst && inst.isMinimized(); },
    requestRender() { if (inst) inst.requestRender(); }
  };

// ===========================================================================
  // 15. ВРЕМЕННЫЙ DEV TOOL ДЛЯ НАСТРОЙКИ ВСЕХ КОНТУРОВ
  // ===========================================================================
     (function initContourDevTool() {
    const DEV_LS = LSK + 'dev_contours_v2';
    const MASS_EDGE_KEYS = [
      'edgeOn', 'edgeCheckMode', 'edgeOuter', 'edgeRidge', 'edgeThick',
      'edgeThrBase', 'edgeThrSlope', 'edgeStr', 'edgeFadeStart', 'edgeFadeEnd',
      'edgeHillOccl', 'lineAutoColor', 'colLine'
    ];
    const FORM_KEYS = [
      'rxScale', 'topFlatten', 'skirtScale', 'waveFreq',
      'lobeAmp', 'lobeFreq', 'jitterAmp',
      'edgeShrink', 'edgeRxShrink', 'heightGamma', 'gammaRxCouple'
    ];
    const LOOK_KEYS = [
      'colShadow', 'colBase', 'colHi', 'darkAutoTint',
      'ndlWeight', 'litPos', 'litSoft', 'hiPos', 'hiSoft', 'hiStr',
      'sunApply', 'ambApply', 'lightAllModes',
      'aoSide', 'brushAmp', 'brushFreq', 'tintAmp',
      'fogStr', 'fogDistScale',
      'upMaskMin', 'upMaskMax', 'penBreakAmp', 'penBreakFreq'
    ];

    const snapPreset = src => {
      const out = { ...src };
      ['colShadow', 'colBase', 'colHi', 'colLine'].forEach(k => {
        if (Array.isArray(out[k])) out[k] = [...out[k]];
      });
      return out;
    };
    const applyKeys = (dst, src, keys) => {
      keys.forEach(k => {
        if (src[k] !== undefined) dst[k] = Array.isArray(src[k]) ? [...src[k]] : src[k];
      });
    };

    const NEAR_TOPO_DEF = snapPreset(CANOPY_CONTOUR_TOPO);
    const NEAR_SHADED_DEF = snapPreset(CANOPY_SHADED_MODES);
    const FAR_TOPO_DEF = snapPreset(CANOPY_FAR_CONTOUR_TOPO);
    const FAR_SHADED_DEF = snapPreset(CANOPY_FAR_SHADED_MODES);

    const rgbToHex = rgb => '#' + rgb.map(v => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0')).join('');

    const pickKeys = (src, keys) => {
      const o = {};
      keys.forEach(k => { o[k] = Array.isArray(src[k]) ? [...src[k]] : src[k]; });
      return o;
    };

    const saveDev = () => {
      try {
        localStorage.setItem(DEV_LS, JSON.stringify({
          ...DEV_CONTOURS,
          zones3d: DEV_CANOPY_ZONES,
          zonesFar3d: DEV_CANOPY_FAR_ZONES,
          farOpt: DEV_CANOPY_FAR_OPT,
          mass: pickKeys(CANOPY_CONTOUR_TOPO, MASS_EDGE_KEYS),
          nearTopo: pickKeys(CANOPY_CONTOUR_TOPO, [...FORM_KEYS, ...LOOK_KEYS]),
          nearShaded: pickKeys(CANOPY_SHADED_MODES, [...FORM_KEYS, ...LOOK_KEYS]),
          farTopo: pickKeys(CANOPY_FAR_CONTOUR_TOPO, [...FORM_KEYS, ...LOOK_KEYS]),
          farShaded: pickKeys(CANOPY_FAR_SHADED_MODES, [...FORM_KEYS, ...LOOK_KEYS])
        }));
      } catch (e) {}
    };

    const loadDev = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(DEV_LS) || 'null');
        if (!raw) return;
        ['terrain', 'treeLine', 'forestZone'].forEach(g => {
          if (raw[g]) Object.assign(DEV_CONTOURS[g], raw[g]);
        });
        if (raw.zones3d) Object.assign(DEV_CANOPY_ZONES, raw.zones3d);
        if (raw.zonesFar3d) Object.assign(DEV_CANOPY_FAR_ZONES, raw.zonesFar3d);
        if (raw.farOpt) Object.assign(DEV_CANOPY_FAR_OPT, raw.farOpt);
        if (raw.mass) {
          applyKeys(CANOPY_CONTOUR_TOPO, raw.mass, MASS_EDGE_KEYS);
          applyKeys(CANOPY_SHADED_MODES, raw.mass, MASS_EDGE_KEYS);
        }
        if (raw.nearTopo) applyKeys(CANOPY_CONTOUR_TOPO, raw.nearTopo, [...FORM_KEYS, ...LOOK_KEYS]);
        if (raw.nearShaded) applyKeys(CANOPY_SHADED_MODES, raw.nearShaded, [...FORM_KEYS, ...LOOK_KEYS]);
        if (raw.farTopo) applyKeys(CANOPY_FAR_CONTOUR_TOPO, raw.farTopo, [...FORM_KEYS, ...LOOK_KEYS]);
        if (raw.farShaded) applyKeys(CANOPY_FAR_SHADED_MODES, raw.farShaded, [...FORM_KEYS, ...LOOK_KEYS]);
      } catch (e) {}
    };
    loadDev();

    const DEV_CSS = `
.pkv-dev{position:fixed;right:12px;top:50px;width:372px;max-height:calc(100vh - 68px);z-index:3030;
background:rgba(15,20,29,.95);color:#e8ecf3;border:1px solid #354152;
border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.68);display:flex;flex-direction:column;
font:12px/1.35 system-ui,-apple-system,sans-serif;overflow:hidden}
.pkv-dev *{box-sizing:border-box}
.pkv-dev.hide{display:none}
.pkv-dev.coll .pkv-dev-top,.pkv-dev.coll .pkv-dev-tabs,.pkv-dev.coll .pkv-dev-body,.pkv-dev.coll .pkv-dev-foot{display:none}
.pkv-dev-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#1a2230;border-bottom:1px solid #2d3646;cursor:move;user-select:none;touch-action:none}
.pkv-dev-hd b{flex:1;font-size:12.5px}
.pkv-dev-top{display:flex;flex-wrap:wrap;gap:5px;padding:6px 8px;background:#121720;border-bottom:1px solid #283040}
.pkv-dev-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:7px;border:1px solid #333e50;background:#1c2432;color:#cfe0f5;cursor:pointer;font-size:11px;user-select:none}
.pkv-dev-chip.on{border-color:#4da3ff;background:rgba(77,163,255,.18);color:#fff}
.pkv-dev-tabs{display:flex;gap:2px;padding:5px 6px 0;background:#10151d;border-bottom:1px solid #2d3646}
.pkv-dev-tab{flex:1;padding:6px 2px;text-align:center;cursor:pointer;color:#8d99ab;border-radius:7px 7px 0 0;font-size:10.5px;border-bottom:2px solid transparent;user-select:none;white-space:nowrap}
.pkv-dev-tab.on{color:#fff;background:#161d28;border-bottom-color:#4da3ff;font-weight:600}
.pkv-dev-body{flex:1;overflow:auto;padding:8px 10px}
.pkv-dev-sec{margin:0 0 9px;padding:7px 9px;border:1px solid #2a3344;border-radius:9px;background:rgba(255,255,255,.025)}
.pkv-dev-sec-t{font-size:11px;font-weight:700;color:#7cb8ff;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px}
.pkv-dev-row{display:flex;align-items:center;gap:6px;margin:5px 0;min-height:22px}
.pkv-dev-row>label{flex:0 0 138px;color:#b8c4d4;font-size:11.5px}
.pkv-dev-rng{flex:1;min-width:0;accent-color:#4da3ff;cursor:pointer}
.pkv-dev-num{width:48px;text-align:right;font:11px ui-monospace,Consolas,monospace;color:#9fc0e8}
.pkv-dev-col{width:46px;height:24px;padding:1px;border:1px solid #3d495d;border-radius:5px;background:#232b39;cursor:pointer}
.pkv-dev-sel{flex:1;background:#202836;color:#e8ecf3;border:1px solid #384457;border-radius:6px;padding:3px 6px;font-size:11.5px}
.pkv-dev-chk{display:flex;align-items:center;gap:7px;margin:5px 0;cursor:pointer;font-size:11.5px;color:#d6e0ee}
.pkv-dev-chk input{accent-color:#4da3ff;width:15px;height:15px;margin:0}
.pkv-dev-foot{display:flex;gap:6px;padding:8px 10px;background:#10151d;border-top:1px solid #2d3646}
.pkv-dev-foot .pkv-b{flex:1;height:30px;font-size:11.5px;padding:0 6px;white-space:nowrap}
.pkv-dev-modal{position:absolute;inset:0;z-index:10;background:rgba(13,18,26,.97);display:flex;flex-direction:column;gap:8px;padding:10px}
.pkv-dev-ta{flex:1;width:100%;resize:none;background:#0d1118;color:#dce6f5;border:1px solid #354152;border-radius:8px;padding:8px;font:11px/1.35 ui-monospace,Consolas,monospace;outline:none}
.pkv-dev-ta:focus{border-color:#4da3ff}
.pkv-dev-err{color:#ff8b85;font-size:11px;min-height:14px}
@media(max-width:820px){
  .pkv-dev{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-height:52vh}
}
`;
    if (!document.getElementById('pkv-dev-style')) {
      document.head.append(el('style', { id: 'pkv-dev-style', text: DEV_CSS }));
    }

    let box = null, bodyEl = null, topEl = null, tabsEl = null, curTab = 'terrain', copyBtn = null, pasteBtn = null;
    let styleModeSel = 'active'; // 'active' | 'topo' | 'shaded' | 'both'

    const redraw = (rebuildWhich) => {
      saveDev();
      if (inst && inst._dev) {
        if (rebuildWhich && inst._dev.rebuildCanopy) inst._dev.rebuildCanopy(rebuildWhich);
        else inst._dev.requestRender();
      }
    };

    const mkSlider = (label, obj, key, min, max, step, fmt, onExtra) => {
      const decimals = step < 0.01 ? 3 : (step < 0.1 ? 2 : (step < 1 ? 1 : 0));
      const inp = el('input', { type: 'range', class: 'pkv-dev-rng', min, max, step, value: obj[key] });
      const valEl = el('span', { class: 'pkv-dev-num', text: fmt ? fmt(obj[key]) : Number(obj[key]).toFixed(decimals) });
      inp.addEventListener('input', () => {
        obj[key] = +inp.value;
        valEl.textContent = fmt ? fmt(obj[key]) : obj[key].toFixed(decimals);
        if (onExtra) onExtra(obj[key]);
        else redraw(false);
      });
      return el('div', { class: 'pkv-dev-row' }, el('label', { text: label }), inp, valEl);
    };

    const mkCheck = (label, obj, key, onExtra) => {
      const inp = el('input', { type: 'checkbox' });
      inp.checked = !!obj[key];
      inp.addEventListener('change', () => {
        obj[key] = inp.checked;
        if (onExtra) onExtra(inp.checked);
        else redraw(false);
      });
      return el('label', { class: 'pkv-dev-chk' }, inp, el('span', { text: label }));
    };

    const mkColor = (label, obj, key, isArr) => {
      const curHex = isArr ? rgbToHex(obj[key]) : obj[key];
      const inp = el('input', { type: 'color', class: 'pkv-dev-col', value: curHex });
      const hexTxt = el('span', { class: 'pkv-dev-num', text: curHex });
      inp.addEventListener('input', () => {
        obj[key] = isArr ? hex3(inp.value) : inp.value;
        hexTxt.textContent = inp.value;
        redraw(false);
      });
      return el('div', { class: 'pkv-dev-row' }, el('label', { text: label }), inp, el('span', { class: 'pkv-sp' }), hexTxt);
    };

    const mkSelect = (label, obj, key, options, isNum, onExtra) => {
      const s = el('select', { class: 'pkv-dev-sel' });
      options.forEach(([v, t]) => {
        const o = el('option', { value: v, text: t });
        if (String(v) === String(obj[key])) o.selected = true;
        s.append(o);
      });
      s.addEventListener('change', () => {
        obj[key] = isNum ? +s.value : s.value;
        if (onExtra) onExtra(obj[key]);
        redraw(false);
      });
      return el('div', { class: 'pkv-dev-row' }, el('label', { text: label }), s);
    };

    const mkSec = (title, ...kids) => el('div', { class: 'pkv-dev-sec' }, el('div', { class: 'pkv-dev-sec-t', text: title }), ...kids);

    function getActiveStyleMode() {
      const m = inst && inst._dev ? inst._dev.ST.view.mode : 'contour';
      return (m === 'contour' || m === 'topo') ? 'topo' : 'shaded';
    }

    function makePresetProxy(topoObj, shadedObj, scope) {
      const resolved = scope === 'active' ? getActiveStyleMode() : scope;
      const primary = resolved === 'shaded' ? shadedObj : topoObj;
      return new Proxy(primary, {
        get(target, prop) { return target[prop]; },
        set(target, prop, val) {
          const v = Array.isArray(val) ? [...val] : val;
          if (resolved === 'both') {
            topoObj[prop] = v;
            shadedObj[prop] = Array.isArray(v) ? [...v] : v;
          } else {
            target[prop] = v;
          }
          return true;
        }
      });
    }

    function appendLookAndFormSections(parent, pWrap, zonesObj, rebuildTarget) {
      const onZone = () => redraw(rebuildTarget);
      parent.append(
        mkSec('Внешний вид: цвета и освещение',
          mkColor('Цвет тени', pWrap, 'colShadow', true),
          mkColor('Базовый цвет', pWrap, 'colBase', true),
          mkColor('Цвет бликов', pWrap, 'colHi', true),
          mkCheck('Авто-затемнение в тёмной теме', pWrap, 'darkAutoTint'),
          mkCheck('Реалистичный свет во всех режимах', pWrap, 'lightAllModes'),
          mkSlider('Вес света N·L (0=верх)', pWrap, 'ndlWeight', 0.0, 1.0, 0.02),
          mkSlider('Порог базы (litPos)', pWrap, 'litPos', 0.0, 1.0, 0.01),
          mkSlider('Мягкость базы (litSoft)', pWrap, 'litSoft', 0.002, 0.4, 0.005),
          mkSlider('Порог блика (hiPos)', pWrap, 'hiPos', 0.0, 1.0, 0.01),
          mkSlider('Мягкость блика (hiSoft)', pWrap, 'hiSoft', 0.002, 0.4, 0.005),
          mkSlider('Сила блика (hiStr)', pWrap, 'hiStr', 0.0, 1.0, 0.02),
          mkSlider('Гамма солнца (sunApply)', pWrap, 'sunApply', 0.1, 2.5, 0.05),
          mkSlider('Гамма тени (ambApply)', pWrap, 'ambApply', 0.0, 2.5, 0.05),
          mkSlider('Затенение боков (aoSide)', pWrap, 'aoSide', 0.0, 0.85, 0.02),
          mkSlider('Текстура мазков (brush)', pWrap, 'brushAmp', 0.0, 0.4, 0.01),
          mkSlider('Частота мазков', pWrap, 'brushFreq', 0.01, 0.5, 0.01),
          mkSlider('Вариация оттенка (tint)', pWrap, 'tintAmp', 0.0, 0.35, 0.01),
          mkSlider('Сила дымки (fogStr)', pWrap, 'fogStr', 0.0, 1.0, 0.02),
          mkSlider('Дальность дымки (scale)', pWrap, 'fogDistScale', 0.05, 1.5, 0.02),
          mkSlider('Маска верха мин.', pWrap, 'upMaskMin', 0.0, 0.8, 0.02),
          mkSlider('Маска верха макс.', pWrap, 'upMaskMax', 0.05, 1.0, 0.02),
          mkSlider('Рваный край (penBreak)', pWrap, 'penBreakAmp', 0.0, 1.0, 0.02),
          mkSlider('Частота края', pWrap, 'penBreakFreq', 0.02, 1.0, 0.02)
        ),
        mkSec('Форма и размер крон (шейдер)',
          mkSlider('Ширина крон (rxScale)', pWrap, 'rxScale', 0.3, 2.4, 0.02),
          mkSlider('Кривая высоты (gamma)', pWrap, 'heightGamma', 0.4, 3.0, 0.05),
          mkSlider('Связь ширины с gamma', pWrap, 'gammaRxCouple', 0.0, 1.0, 0.05),
          mkSlider('Уменьш. выс. на опушке', pWrap, 'edgeShrink', 0.0, 0.92, 0.02),
          mkSlider('Уменьш. шир. на опушке', pWrap, 'edgeRxShrink', 0.0, 0.85, 0.02),
          mkSlider('Плоскость макушек', pWrap, 'topFlatten', 0.5, 2.5, 0.03),
          mkSlider('Юбка вниз (склоны)', pWrap, 'skirtScale', 0.0, 1.2, 0.02),
          mkSlider('Разброс высоты', pWrap, 'jitterAmp', 0.0, 2.5, 0.05),
          mkSlider('Лепестки контура', pWrap, 'lobeAmp', 0.0, 0.6, 0.02),
          mkSlider('Частота лепестков', pWrap, 'lobeFreq', 2, 8, 1),
          mkSlider('Частота волн (waveFreq)', pWrap, 'waveFreq', 0.005, 0.2, 0.005)
        ),
        mkSec('Где растут кластеры (зоны)',
          mkSlider('Мин. высота в сетке (м)', zonesObj, 'minRawH', 0.25, 8.0, 0.25, null, onZone),
          mkSlider('Заливка дыр (соседей ≥)', zonesObj, 'fillHolesMin', 3, 9, 1, null, onZone),
          mkSlider('Окно оценки опушки', zonesObj, 'edgeWindow', 1, 6, 1, null, onZone),
          mkSlider('Порог пустоты опушки', zonesObj, 'edgeEmptyDiv', 0.15, 1.0, 0.05, null, onZone),
          mkSlider('Порог редколесья', zonesObj, 'sparseEmptyThr', 0.1, 0.9, 0.02, null, onZone),
          mkSlider('Удалять в редколесье', zonesObj, 'sparseDropProb', 0.0, 1.0, 0.05, null, onZone),
          mkSlider('Плотн. 3×3 (ячеек ≥)', zonesObj, 'minCnt3x3', 4, 9, 1, null, onZone),
          mkSlider('Средн. 2×2 (ячеек ≥)', zonesObj, 'minCnt2x2', 1, 4, 1, null, onZone),
          mkCheck('Одиночные деревья (1×1)', zonesObj, 'allowSingles', onZone),
          mkSlider('Радиус 3×3 (внутри)', zonesObj, 'rad3x3', 0.6, 4.0, 0.05, null, onZone),
          mkSlider('Радиус 2×2 (опушка)', zonesObj, 'rad2x2', 0.5, 3.2, 0.05, null, onZone),
          mkSlider('Радиус 1×1 (край)', zonesObj, 'rad1x1', 0.4, 2.5, 0.05, null, onZone),
          mkSlider('Вес макс. высоты', zonesObj, 'chMaxBlend', 0.0, 10.0, 0.05, null, onZone),
          mkSlider('Сдвиг внутри леса', zonesObj, 'jitterDense', 0.0, 1.5, 0.05, null, onZone),
          mkSlider('Сдвиг на опушке', zonesObj, 'jitterEdge', 0.0, 2.0, 0.05, null, onZone)
        )
      );
    }

    function renderQuickBar() {
      if (!topEl || !inst || !inst._dev) return;
      const { ST, save, updateAstro, requestRender, syncTreeUiControls } = inst._dev;
      topEl.textContent = '';

      const addChip = (label, active, onClick) => {
        topEl.append(el('button', {
          type: 'button',
          class: 'pkv-dev-chip' + (active ? ' on' : ''),
          text: label,
          onclick: () => { onClick(); save(); renderQuickBar(); requestRender(); }
        }));
      };

      addChip('⛰️ Контуры', ST.view.showEdges !== false, () => { ST.view.showEdges = !(ST.view.showEdges !== false); });
      addChip('🟩 Линии леса', ST.layers.treeHeightLines !== false, () => {
        ST.layers.treeHeightLines = !(ST.layers.treeHeightLines !== false);
        syncTreeUiControls();
      });
      addChip('👁️ Зона за лесом', ST.layers.hideOccludedTerrainLines !== false, () => {
        ST.layers.hideOccludedTerrainLines = !(ST.layers.hideOccludedTerrainLines !== false);
        syncTreeUiControls();
      });
      addChip((ST.layers.treeMode || 'mass') === 'mass' ? '🌊 Режим: Массив' : '🌲 Режим: Деревья', true, () => {
        ST.layers.trees = true;
        ST.layers.treeMode = (ST.layers.treeMode || 'mass') === 'mass' ? 'trees' : 'mass';
        syncTreeUiControls();
        if (inst._dev.syncScene) inst._dev.syncScene();
      });
      addChip(ST.view.darkTheme ? '🌙 Тёмная' : '☀️ Светлая', !!ST.view.darkTheme, () => {
        ST.view.darkTheme = !ST.view.darkTheme;
        updateAstro();
      });
      addChip(DEV_CANOPY_FAR_OPT.enabled !== false ? '🌳 Дальн.3D: Вкл' : '🌳 Дальн.3D: Выкл', DEV_CANOPY_FAR_OPT.enabled !== false, () => {
        DEV_CANOPY_FAR_OPT.enabled = !(DEV_CANOPY_FAR_OPT.enabled !== false);
        saveDev();
        if (curTab === 'far3d') renderBody();
      });
    }

    function renderBody() {
      if (!bodyEl) return;
      bodyEl.textContent = '';
      if (curTab === 'terrain') {
        const t = DEV_CONTOURS.terrain;
        bodyEl.append(
          mkSec('Пороги и логика хребтов',
            mkSlider('Толщина хребтов (px)', t, 'thick', 0.4, 3.5, 0.05),
            mkSlider('Толщина горизонта (px)', t, 'horizonThick', 0.0, 3.5, 0.05),
            mkSlider('Фильтр ровных склонов', t, 'slopeFilter', 0.0, 1.6, 0.05),
            mkSlider('Баз. порог (м)', t, 'thrBase', 1.0, 50.0, 0.5),
            mkSlider('Наклон с дист.', t, 'thrSlope', 0.005, 0.16, 0.002),
            mkSlider('Мягкость края', t, 'softness', 0.0, 2.0, 0.05),
            mkSlider('Диагонали (0=выкл)', t, 'diagWeight', 0.0, 1.0, 0.05),
            mkSlider('Усил. на горизонте', t, 'horizonBoost', 0.5, 2.0, 0.05),
            mkSlider('Ближнее сглаж. (м)', t, 'nearSuppress', 0.0, 120.0, 2.0),
            mkCheck('Контур на стыке 2D-дерева', t, 'treeSilhouette'),
            mkSlider('Допуск за лесом (м)', t, 'occBias', -2.0, 8.0, 0.1)
          ),
          mkSec('Цвета, дымка и красота',
            mkColor('Светлая тема', t, 'colLight', false),
            mkColor('Тёмная тема', t, 'colDark', false),
            mkSlider('Растворение в дымке', t, 'hazeMix', 0.0, 1.0, 0.02),
            mkSlider('Ореол за хребтом', t, 'backHalo', 0.0, 0.8, 0.02),
            mkSlider('Затух. старт (×fog)', t, 'fadeStart', 0.05, 1.5, 0.05),
            mkSlider('Затух. конец (×fog)', t, 'fadeEnd', 0.2, 2.5, 0.05),
            mkSlider('Яркость база', t, 'strBase', 0.0, 1.0, 0.02),
            mkSlider('Добавка вблизи', t, 'strNearAdd', 0.0, 1.0, 0.02),
            mkSlider('Мин. сила', t, 'strMin', 0.0, 1.0, 0.02),
            mkSlider('Макс. сила', t, 'strMax', 0.0, 1.0, 0.02)
          ),
          mkSec('Множители режимов',
            mkSlider('Режим CG', t, 'modeK_CG', 0.0, 1.0, 0.02),
            mkSlider('Режим Гибрид', t, 'modeK_Hybrid', 0.0, 1.0, 0.02),
            mkSlider('Контур / Топо / др.', t, 'modeK_Other', 0.0, 1.0, 0.02)
          )
        );
      } else if (curTab === 'treeLine') {
        const l = DEV_CONTOURS.treeLine;
        bodyEl.append(
          mkSec('Зона допуска (перекрытие)',
            mkSlider('Допуск 2D-деревья (м)', l, 'tolTree', -5.0, 50.0, 0.5),
            mkSlider('Допуск рельеф (м)', l, 'tolTerrain', -3.0, 15.0, 0.25),
            mkSlider('Край зоны старт (м)', l, 'borderFadeIn', 1900, 2195, 5),
            mkSlider('Край зоны конец (м)', l, 'borderFadeOut', 2100, 2200, 2)
          ),
          mkSec('Геометрия и обнаружение',
            mkSelect('Направления', l, 'checkMode', [
              ['0', 'Верх + бока (стандарт)'],
              ['1', 'Только верхний край'],
              ['2', 'Все 8 сторон (полный)']
            ], true),
            mkSlider('Толщина (px)', l, 'thick', 0.4, 3.5, 0.05),
            mkSlider('Фильтр ровных склонов', l, 'slopeFilter', 0.0, 1.6, 0.05),
            mkSlider('Баз. порог (м)', l, 'thrBase', 1.0, 30.0, 0.5),
            mkSlider('Наклон с дист.', l, 'thrSlope', 0.005, 0.15, 0.002),
            mkSlider('Мягкость края', l, 'softness', 0.0, 2.0, 0.05),
            mkSlider('Вес внешн. края', l, 'outerWeight', 0.0, 1.5, 0.05),
            mkSlider('Вес внутр. гребней', l, 'ridgeWeight', 0.0, 1.5, 0.05),
            mkSlider('Ближнее сглаж. (м)', l, 'nearFade', 0.0, 150.0, 2.0)
          ),
          mkSec('Цвета, штрих и дымка',
            mkColor('Светлая тема', l, 'colLight', false),
            mkColor('Тёмная / Ночь', l, 'colDark', false),
            mkSlider('Усиление на фоне неба', l, 'skyBoost', 0.5, 2.0, 0.05),
            mkSlider('Растворение в дымке', l, 'hazeMix', 0.0, 1.0, 0.02),
            mkSlider('Штриховка (пунктир)', l, 'dashAmp', 0.0, 1.0, 0.05),
            mkSlider('Частота штриха', l, 'dashFreq', 0.05, 0.6, 0.01),
            mkSlider('Затух. старт (м)', l, 'fadeStart', 200, 3000, 50),
            mkSlider('Затух. конец (м)', l, 'fadeEnd', 500, 4500, 50),
            mkSlider('Яркость база', l, 'strBase', 0.0, 1.0, 0.02),
            mkSlider('Добавка вблизи', l, 'strNearAdd', 0.0, 1.0, 0.02),
            mkSlider('Мин. сила', l, 'strMin', 0.0, 1.0, 0.02),
            mkSlider('Макс. сила', l, 'strMax', 0.0, 1.0, 0.02)
          )
        );
      } else if (curTab === 'forestZone') {
        const z = DEV_CONTOURS.forestZone;
        bodyEl.append(
          mkSec('Зона допуска глубины за лесом',
            mkSlider('2D-деревья: мин (м)', z, 'treeTolMin', -10.0, 40.0, 0.5),
            mkSlider('2D-деревья: макс (м)', z, 'treeTolMax', -5.0, 50.0, 0.5),
            mkSlider('Рельеф: мин (м)', z, 'terrTolMin', -5.0, 15.0, 0.25),
            mkSlider('Рельеф: макс (м)', z, 'terrTolMax', -2.0, 20.0, 0.25)
          ),
          mkSec('Затемнение и цвета зоны',
            mkSlider('Сила затемнения', z, 'strength', 0.0, 1.0, 0.02),
            mkSlider('Влияние на небо', z, 'skyAffect', 0.0, 1.0, 0.05),
            mkSlider('Влияние на 2D-деревья', z, 'treesAffect', 0.0, 1.0, 0.05),
            mkColor('Оттенок (Светлая)', z, 'tintLight', false),
            mkColor('Оттенок (Тёмная/Ночь)', z, 'tintDark', false)
          )
        );
      } else if (curTab === 'mass') {
        const wrapObj = new Proxy(CANOPY_CONTOUR_TOPO, {
          set(target, prop, val) {
            target[prop] = val;
            if (MASS_EDGE_KEYS.includes(prop)) CANOPY_SHADED_MODES[prop] = val;
            return true;
          }
        });
        bodyEl.append(
          mkSec('Контуры сплошного массива (mass)',
            mkCheck('Включить контуры массива', wrapObj, 'edgeOn'),
            mkSelect('Проверка краёв', wrapObj, 'edgeCheckMode', [
              ['0', 'Только верх'],
              ['1', 'Верх + бока'],
              ['2', 'Верх + бока + низ']
            ], true),
            mkSlider('Толщина (px)', wrapObj, 'edgeThick', 0.5, 4.5, 0.1),
            mkSlider('Сила контура', wrapObj, 'edgeStr', 0.0, 1.0, 0.02),
            mkSlider('Внешний край', wrapObj, 'edgeOuter', 0.0, 2.0, 0.05),
            mkSlider('Внутренние гребни', wrapObj, 'edgeRidge', 0.0, 2.0, 0.05),
            mkSlider('Порог база (м)', wrapObj, 'edgeThrBase', 0.5, 15.0, 0.25),
            mkSlider('Наклон с дист.', wrapObj, 'edgeThrSlope', 0.005, 0.2, 0.005),
            mkSlider('Затух. старт (м)', wrapObj, 'edgeFadeStart', 100, 2500, 50),
            mkSlider('Затух. конец (м)', wrapObj, 'edgeFadeEnd', 200, 3500, 50),
            mkSlider('Прятать за холмами', wrapObj, 'edgeHillOccl', 0.0, 1.0, 0.05),
            mkCheck('Автоцвет (светлая/тёмная)', wrapObj, 'lineAutoColor'),
            mkColor('Свой цвет линии', wrapObj, 'colLine', true)
          )
        );
      } else if (curTab === 'trees3d') {
        const pWrap = makePresetProxy(CANOPY_CONTOUR_TOPO, CANOPY_SHADED_MODES, styleModeSel);
        const L = inst && inst._dev ? inst._dev.ST.layers : null;
        const onLayer = () => {
          if (inst && inst._dev) {
            inst._dev.save();
            inst._dev.syncTreeUiControls();
            inst._dev.requestRender();
          }
        };
        const presetCtrl = { scope: styleModeSel };
        bodyEl.append(
          mkSec('Пресет режима рендера',
            mkSelect('Редактировать', presetCtrl, 'scope', [
              ['active', `Текущий (${getActiveStyleMode() === 'topo' ? 'Контур/Топо' : 'CG/Гибрид/др.'})`],
              ['topo', 'Только Контур / Топо'],
              ['shaded', 'Только CG / Гибрид / Уклоны'],
              ['both', 'Оба пресета сразу']
            ], false, v => { styleModeSel = v; renderBody(); })
          )
        );
        if (L) {
          bodyEl.append(
            mkSec('Фильтр и масштаб ближнего слоя (±2.2 км)',
              mkSlider('Порог показа (м)', L, 'canopyMinH', 0.5, 12.0, 0.25, null, onLayer),
              mkSlider('Высота крон (×)', L, 'canopyScale', 0.4, 2.5, 0.05, null, onLayer),
              mkSlider('Волнистость', L, 'canopyWave', 0.0, 2.0, 0.05, null, onLayer)
            )
          );
        }
        appendLookAndFormSections(bodyEl, pWrap, DEV_CANOPY_ZONES, 'near');
      } else if (curTab === 'far3d') {
        const pWrap = makePresetProxy(CANOPY_FAR_CONTOUR_TOPO, CANOPY_FAR_SHADED_MODES, styleModeSel);
        const presetCtrl = { scope: styleModeSel };
        const copyBtnRow = el('div', { class: 'pkv-btns' },
          el('button', {
            class: 'pkv-b', type: 'button', text: '📋 Скопировать вид и форму с ближнего',
            onclick: () => {
              applyKeys(CANOPY_FAR_CONTOUR_TOPO, CANOPY_CONTOUR_TOPO, [...FORM_KEYS, ...LOOK_KEYS]);
              applyKeys(CANOPY_FAR_SHADED_MODES, CANOPY_SHADED_MODES, [...FORM_KEYS, ...LOOK_KEYS]);
              if (inst && inst._dev) {
                const L = inst._dev.ST.layers;
                DEV_CANOPY_FAR_OPT.minH = L.canopyMinH;
                DEV_CANOPY_FAR_OPT.scale = L.canopyScale;
                DEV_CANOPY_FAR_OPT.wave = L.canopyWave;
              }
              renderBody();
              redraw(false);
            }
          })
        );

        bodyEl.append(
          mkSec('Дальний 3D-слой (±8 км)',
            mkCheck('Включить дальний 3D-слой', DEV_CANOPY_FAR_OPT, 'enabled', () => { renderQuickBar(); redraw(false); }),
            mkSelect('Пресет режима', presetCtrl, 'scope', [
              ['active', `Текущий (${getActiveStyleMode() === 'topo' ? 'Контур/Топо' : 'CG/Гибрид/др.'})`],
              ['topo', 'Только Контур / Топо'],
              ['shaded', 'Только CG / Гибрид / Уклоны'],
              ['both', 'Оба пресета сразу']
            ], false, v => { styleModeSel = v; renderBody(); }),

            mkSlider('Перехлёст стыка (м)', DEV_CANOPY_FAR_ZONES, 'seamOverlapM', 0, 700, 10, null, () => redraw('far')),
            mkSlider('Дальние: старт ширины', DEV_CANOPY_FAR_OPT, 'farStartRx', 0.10, 1.0, 0.02),
            mkSlider('Дальние: старт высоты', DEV_CANOPY_FAR_OPT, 'farStartH', 0.15, 1.0, 0.02),
            mkSlider('Дальние: дорастание за стык (м)', DEV_CANOPY_FAR_OPT, 'farGrowExtraM', 0, 500, 10),
            mkSlider('Ближние: конец ширины', DEV_CANOPY_FAR_OPT, 'nearEndRx', 1.0, 3.5, 0.05),
            mkSlider('Ближние: конец высоты', DEV_CANOPY_FAR_OPT, 'nearEndH', 1.0, 2.5, 0.05),
            mkSlider('Порог показа (м)', DEV_CANOPY_FAR_OPT, 'minH', 0.5, 12.0, 0.25),
            mkSlider('Высота крон (×)', DEV_CANOPY_FAR_OPT, 'scale', 0.3, 2.5, 0.05),
            mkSlider('Волнистость', DEV_CANOPY_FAR_OPT, 'wave', 0.0, 2.0, 0.05),
            copyBtnRow
          )
        );
        appendLookAndFormSections(bodyEl, pWrap, DEV_CANOPY_FAR_ZONES, 'far');
      }
    }

    function setTab(k) {
      curTab = k;
      if (tabsEl) tabsEl.querySelectorAll('.pkv-dev-tab').forEach(t => t.classList.toggle('on', t.dataset.k === k));
      renderBody();
    }

    function fmtPresetPatch(obj) {
      const p = pickKeys(obj, [...FORM_KEYS, ...LOOK_KEYS]);
      let s = JSON.stringify(p, null, 2);
      ['colShadow', 'colBase', 'colHi'].forEach(ck => {
        s = s.replace(new RegExp(`"${ck}": \\[[^\\]]+\\]`, 's'), `"${ck}": hex3('${rgbToHex(obj[ck])}')`);
      });
      return s;
    }

    function buildExportText() {
      const massPatch = pickKeys(CANOPY_CONTOUR_TOPO, MASS_EDGE_KEYS);
      const fmtMass = JSON.stringify(massPatch, null, 2)
        .replace(/"colLine": \[[^\]]+\]/s, `"colLine": hex3('${rgbToHex(CANOPY_CONTOUR_TOPO.colLine)}')`);
      const L = inst && inst._dev ? inst._dev.ST.layers : null;
      const layerPatch = L ? { canopyScale: L.canopyScale, canopyMinH: L.canopyMinH, canopyWave: L.canopyWave } : null;

      return `  const DEV_CONTOURS_DEF = ${JSON.stringify(DEV_CONTOURS, null, 2)};\n\n` +
             `  const DEV_CANOPY_ZONES_DEF = ${JSON.stringify(DEV_CANOPY_ZONES, null, 2)};\n\n` +
             `  const DEV_CANOPY_FAR_ZONES_DEF = ${JSON.stringify(DEV_CANOPY_FAR_ZONES, null, 2)};\n\n` +
             `  const DEV_CANOPY_FAR_OPT_DEF = ${JSON.stringify(DEV_CANOPY_FAR_OPT, null, 2)};\n\n` +
             (layerPatch ? `  // Слой ближнего леса (DEF.layers):\n  const LAYERS_CANOPY_PATCH = ${JSON.stringify(layerPatch, null, 2)};\n\n` : '') +
             `  // Контуры массива:\n  const CANOPY_EDGE_PATCH = ${fmtMass};\n\n` +
             `  // Ближний 3D-лес (Контур/Топо):\n  const CANOPY_NEAR_TOPO_PATCH = ${fmtPresetPatch(CANOPY_CONTOUR_TOPO)};\n\n` +
             `  // Ближний 3D-лес (CG/Гибрид/др.):\n  const CANOPY_NEAR_SHADED_PATCH = ${fmtPresetPatch(CANOPY_SHADED_MODES)};\n\n` +
             `  // Дальний 3D-лес (Контур/Топо):\n  const CANOPY_FAR_TOPO_PATCH = ${fmtPresetPatch(CANOPY_FAR_CONTOUR_TOPO)};\n\n` +
             `  // Дальний 3D-лес (CG/Гибрид/др.):\n  const CANOPY_FAR_SHADED_PATCH = ${fmtPresetPatch(CANOPY_FAR_SHADED_MODES)};`;
    }

    function copySettings() {
      const txt = buildExportText();
      const okFeedback = () => {
        if (!copyBtn) return;
        const old = copyBtn.textContent;
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => { if (copyBtn) copyBtn.textContent = old; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(okFeedback, () => fallbackCopy(txt, okFeedback));
      } else {
        fallbackCopy(txt, okFeedback);
      }
    }

    function fallbackCopy(txt, done) {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = txt;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { prompt('Скопируйте настройки:', txt); }
      ta.remove();
    }

    const RGB_KEYS = new Set(['colShadow', 'colBase', 'colHi', 'colLine']);

    function normalizePatch(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      for (const k of Object.keys(obj)) {
        if (RGB_KEYS.has(k) && typeof obj[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj[k])) {
          obj[k] = hex3(obj[k]);
        }
      }
      return obj;
    }

    function parsePatchJson(raw) {
      let s = String(raw || '')
        .replace(/hex3\(\s*['"](#[0-9a-fA-F]{6})['"]\s*\)/g, (_, hex) => JSON.stringify(hex3(hex)))
        .replace(/,\s*([}\]])/g, '$1');
      return normalizePatch(JSON.parse(s));
    }

    function extractNamedJson(txt, name) {
      const re = new RegExp(`(?:const|let|var)?\\s*${name}\\s*=\\s*\\{`);
      const m = re.exec(txt);
      if (!m) return null;
      const idx = m.index + m[0].length - 1;
      let depth = 0, inStr = false, strCh = '', esc = false;
      for (let i = idx; i < txt.length; i++) {
        const ch = txt[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === strCh) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return parsePatchJson(txt.slice(idx, i + 1));
        }
      }
      return null;
    }

    function applyImportedText(txt) {
      if (!txt || !txt.trim()) throw new Error('Текст пуст');
      let applied = 0;
      let rebuildNear = false;
      let rebuildFar = false;

      const devContours = extractNamedJson(txt, 'DEV_CONTOURS_DEF') || extractNamedJson(txt, 'DEV_CONTOURS');
      if (devContours) {
        ['terrain', 'treeLine', 'forestZone'].forEach(g => {
          if (devContours[g]) Object.assign(DEV_CONTOURS[g], devContours[g]);
        });
        applied++;
      }

      const zNear = extractNamedJson(txt, 'DEV_CANOPY_ZONES_DEF') || extractNamedJson(txt, 'DEV_CANOPY_ZONES');
      if (zNear) { Object.assign(DEV_CANOPY_ZONES, zNear); rebuildNear = true; applied++; }

      const zFar = extractNamedJson(txt, 'DEV_CANOPY_FAR_ZONES_DEF') || extractNamedJson(txt, 'DEV_CANOPY_FAR_ZONES');
      if (zFar) { Object.assign(DEV_CANOPY_FAR_ZONES, zFar); rebuildFar = true; applied++; }

      const farOpt = extractNamedJson(txt, 'DEV_CANOPY_FAR_OPT_DEF') || extractNamedJson(txt, 'DEV_CANOPY_FAR_OPT');
      if (farOpt) { Object.assign(DEV_CANOPY_FAR_OPT, farOpt); applied++; }

      const layersPatch = extractNamedJson(txt, 'LAYERS_CANOPY_PATCH');
      if (layersPatch && inst && inst._dev) {
        const L = inst._dev.ST.layers;
        ['canopyScale', 'canopyMinH', 'canopyWave'].forEach(k => {
          if (layersPatch[k] !== undefined) L[k] = layersPatch[k];
        });
        inst._dev.save();
        inst._dev.syncTreeUiControls();
        applied++;
      }

      const edgePatch = extractNamedJson(txt, 'CANOPY_EDGE_PATCH');
      if (edgePatch) {
        applyKeys(CANOPY_CONTOUR_TOPO, edgePatch, MASS_EDGE_KEYS);
        applyKeys(CANOPY_SHADED_MODES, edgePatch, MASS_EDGE_KEYS);
        applied++;
      }

      const nearTopo = extractNamedJson(txt, 'CANOPY_NEAR_TOPO_PATCH');
      if (nearTopo) { applyKeys(CANOPY_CONTOUR_TOPO, nearTopo, [...FORM_KEYS, ...LOOK_KEYS]); applied++; }

      const nearShaded = extractNamedJson(txt, 'CANOPY_NEAR_SHADED_PATCH');
      if (nearShaded) { applyKeys(CANOPY_SHADED_MODES, nearShaded, [...FORM_KEYS, ...LOOK_KEYS]); applied++; }

      const farTopo = extractNamedJson(txt, 'CANOPY_FAR_TOPO_PATCH');
      if (farTopo) { applyKeys(CANOPY_FAR_CONTOUR_TOPO, farTopo, [...FORM_KEYS, ...LOOK_KEYS]); applied++; }

      const farShaded = extractNamedJson(txt, 'CANOPY_FAR_SHADED_PATCH');
      if (farShaded) { applyKeys(CANOPY_FAR_SHADED_MODES, farShaded, [...FORM_KEYS, ...LOOK_KEYS]); applied++; }

      // Фоллбэк: если вставлен JSON формата localStorage
      if (!applied) {
        const raw = parsePatchJson(txt.trim());
        if (raw && typeof raw === 'object') {
          ['terrain', 'treeLine', 'forestZone'].forEach(g => {
            if (raw[g]) { Object.assign(DEV_CONTOURS[g], raw[g]); applied++; }
          });
          if (raw.zones3d) { Object.assign(DEV_CANOPY_ZONES, raw.zones3d); rebuildNear = true; applied++; }
          if (raw.zonesFar3d) { Object.assign(DEV_CANOPY_FAR_ZONES, raw.zonesFar3d); rebuildFar = true; applied++; }
          if (raw.farOpt) { Object.assign(DEV_CANOPY_FAR_OPT, raw.farOpt); applied++; }
          if (raw.mass) {
            const m = normalizePatch(raw.mass);
            applyKeys(CANOPY_CONTOUR_TOPO, m, MASS_EDGE_KEYS);
            applyKeys(CANOPY_SHADED_MODES, m, MASS_EDGE_KEYS);
            applied++;
          }
          if (raw.nearTopo) { applyKeys(CANOPY_CONTOUR_TOPO, normalizePatch(raw.nearTopo), [...FORM_KEYS, ...LOOK_KEYS]); applied++; }
          if (raw.nearShaded) { applyKeys(CANOPY_SHADED_MODES, normalizePatch(raw.nearShaded), [...FORM_KEYS, ...LOOK_KEYS]); applied++; }
          if (raw.farTopo) { applyKeys(CANOPY_FAR_CONTOUR_TOPO, normalizePatch(raw.farTopo), [...FORM_KEYS, ...LOOK_KEYS]); applied++; }
          if (raw.farShaded) { applyKeys(CANOPY_FAR_SHADED_MODES, normalizePatch(raw.farShaded), [...FORM_KEYS, ...LOOK_KEYS]); applied++; }
        }
      }

      if (!applied) throw new Error('Не найдено ни одного блока настроек');

      renderQuickBar();
      renderBody();
      const rebuildWhich = rebuildNear && rebuildFar ? 'both' : (rebuildNear ? 'near' : (rebuildFar ? 'far' : false));
      redraw(rebuildWhich);
      return applied;
    }

    function flashPasteOk() {
      if (!pasteBtn) return;
      const old = pasteBtn.textContent;
      pasteBtn.textContent = '✓ Вставлено!';
      setTimeout(() => { if (pasteBtn) pasteBtn.textContent = old; }, 1600);
    }

    function openPasteModal(prefill, errText) {
      if (!box) return;
      const old = box.querySelector('.pkv-dev-modal');
      if (old) old.remove();

      const ta = el('textarea', {
        class: 'pkv-dev-ta',
        placeholder: 'Вставьте сюда текст из «Копировать настройки» (Ctrl+V)…'
      });
      if (prefill) ta.value = prefill;
      const errEl = el('div', { class: 'pkv-dev-err', text: errText || '' });

      const fileIn = el('input', { type: 'file', accept: '.txt,.json,.js', style: 'display:none' });
      fileIn.addEventListener('change', () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        f.text().then(txt => {
          ta.value = txt;
          try {
            applyImportedText(txt);
            modal.remove();
            flashPasteOk();
          } catch (e) {
            errEl.textContent = '⚠ ' + (e.message || 'Ошибка разбора файла');
          }
        });
      });

      const modal = el('div', { class: 'pkv-dev-modal' },
        el('div', { style: 'display:flex;align-items:center;gap:6px' },
          el('b', { style: 'flex:1', text: '📥 Вставка настроек' }),
          el('button', { class: 'pkv-b', type: 'button', text: '📂 Из файла', onclick: () => fileIn.click() }),
          el('button', { class: 'pkv-b', type: 'button', text: '✕', onclick: () => modal.remove() })
        ),
        fileIn,
        ta,
        errEl,
        el('div', { style: 'display:flex;gap:6px' },
          el('button', {
            class: 'pkv-b prime', type: 'button', style: 'flex:1;height:30px', text: '✓ Применить',
            onclick: () => {
              try {
                applyImportedText(ta.value);
                modal.remove();
                flashPasteOk();
              } catch (e) {
                errEl.textContent = '⚠ ' + (e.message || 'Не удалось распознать настройки');
              }
            }
          }),
          el('button', {
            class: 'pkv-b', type: 'button', style: 'height:30px', text: 'Отмена',
            onclick: () => modal.remove()
          })
        )
      );

      box.append(modal);
      ta.focus();
    }

    async function pasteSettings() {
      if (navigator.clipboard && navigator.clipboard.readText) {
        try {
          const txt = await navigator.clipboard.readText();
          if (txt && txt.trim()) {
            try {
              applyImportedText(txt);
              flashPasteOk();
              return;
            } catch (e) {
              openPasteModal(txt, '⚠ В буфере не распознаны настройки: ' + (e.message || ''));
              return;
            }
          }
        } catch (e) {
          // Нет разрешения на чтение буфера — открываем ручную вставку
        }
      }
      openPasteModal('', '');
    }

    function resetAll() {
      ['terrain', 'treeLine', 'forestZone'].forEach(g => Object.assign(DEV_CONTOURS[g], JSON.parse(JSON.stringify(DEV_CONTOURS_DEF[g]))));
      Object.assign(DEV_CANOPY_ZONES, JSON.parse(JSON.stringify(DEV_CANOPY_ZONES_DEF)));
      Object.assign(DEV_CANOPY_FAR_ZONES, JSON.parse(JSON.stringify(DEV_CANOPY_FAR_ZONES_DEF)));
      Object.assign(DEV_CANOPY_FAR_OPT, { ...DEV_CANOPY_FAR_OPT_DEF });
      applyKeys(CANOPY_CONTOUR_TOPO, NEAR_TOPO_DEF, Object.keys(NEAR_TOPO_DEF));
      applyKeys(CANOPY_SHADED_MODES, NEAR_SHADED_DEF, Object.keys(NEAR_SHADED_DEF));
      applyKeys(CANOPY_FAR_CONTOUR_TOPO, FAR_TOPO_DEF, Object.keys(FAR_TOPO_DEF));
      applyKeys(CANOPY_FAR_SHADED_MODES, FAR_SHADED_DEF, Object.keys(FAR_SHADED_DEF));
      try { localStorage.removeItem(DEV_LS); } catch (e) {}
      renderQuickBar();
      renderBody();
      redraw('both');
    }

    function openDevTool() {
      if (box) {
        box.classList.remove('hide');
        renderQuickBar();
        return;
      }
      const bColl = el('button', { class: 'pkv-b', type: 'button', text: '▁', title: 'Свернуть/развернуть' });
      const bCls = el('button', { class: 'pkv-b', type: 'button', text: '✕', title: 'Скрыть' });
      const hd = el('div', { class: 'pkv-dev-hd' }, el('b', { text: '🛠️ Dev: Настройка контуров и 3D' }), bColl, bCls);

      topEl = el('div', { class: 'pkv-dev-top' });
      tabsEl = el('div', { class: 'pkv-dev-tabs' });
      [
        ['terrain', '⛰️ Рельеф'],
        ['treeLine', '🟩 Линии'],
        ['forestZone', '👁️ Допуск'],
        ['mass', '🌊 Конт.3D'],
        ['trees3d', '🌲 Ближ.3D'],
        ['far3d', '🌳 Дальн.3D']
      ].forEach(([k, label]) => {
        tabsEl.append(el('div', { class: 'pkv-dev-tab', 'data-k': k, text: label, onclick: () => setTab(k) }));
      });

      bodyEl = el('div', { class: 'pkv-dev-body' });
      copyBtn = el('button', { class: 'pkv-b prime', type: 'button', text: '📋 Копировать', onclick: copySettings });
      pasteBtn = el('button', { class: 'pkv-b', type: 'button', text: '📥 Вставить', onclick: pasteSettings });
      const resetBtn = el('button', { class: 'pkv-b', type: 'button', text: '↺ Сброс', onclick: resetAll });
      const foot = el('div', { class: 'pkv-dev-foot' }, copyBtn, pasteBtn, resetBtn);

      box = el('div', { class: 'pkv-dev' }, hd, topEl, tabsEl, bodyEl, foot);
      document.body.append(box);

      bColl.onclick = () => {
        box.classList.toggle('coll');
        bColl.textContent = box.classList.contains('coll') ? '▢' : '▁';
      };
      bCls.onclick = () => box.classList.add('hide');

      let dr = null;
      hd.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        const r = box.getBoundingClientRect();
        dr = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        hd.setPointerCapture(e.pointerId);
      });
      hd.addEventListener('pointermove', e => {
        if (!dr) return;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        box.style.left = clamp(e.clientX - dr.dx, 0, window.innerWidth - 120) + 'px';
        box.style.top = clamp(e.clientY - dr.dy, 0, window.innerHeight - 50) + 'px';
      });
      hd.addEventListener('pointerup', () => { dr = null; });
      hd.addEventListener('pointercancel', () => { dr = null; });

      renderQuickBar();
      setTab(curTab);
    }

    function closeDevTool() {
      if (box) { box.remove(); box = null; }
    }

    let devWasVisible = false;
    api.openDevTool = openDevTool;

    const origClose = api.close.bind(api);
    const origMin = api.minimize.bind(api);
    const origRes = api.restore.bind(api);

    api.close = () => {
      devWasVisible = false;
      closeDevTool();
      return origClose();
    };
    api.minimize = () => {
      devWasVisible = !!(box && !box.classList.contains('hide'));
      if (box) box.classList.add('hide');
      return origMin();
    };
    api.restore = skip => {
      const res = origRes(skip);
      if (box && devWasVisible) box.classList.remove('hide');
      return res;
    };

    if (api.isOpen()) openDevTool();
  })();
// ===========================================================================
  // 16. DEV TOOL: ДЕТАЛИЗАЦИЯ РЕЛЬЕФА И КОНТУРЫ
  // ===========================================================================
  (function initTerrainDevTool() {
    const TDEV_LS = LSK + 'dev_terrain_v1';

    const saveTDev = () => {
      try { localStorage.setItem(TDEV_LS, JSON.stringify(DEV_TERRAIN)); } catch (e) {}
    };
    const loadTDev = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(TDEV_LS) || 'null');
        if (!raw) return;
        if (raw.relief) Object.assign(DEV_TERRAIN.relief, raw.relief);
        if (raw.contours) Object.assign(DEV_TERRAIN.contours, raw.contours);
      } catch (e) {}
    };
    loadTDev();

    if (!document.getElementById('pkv-tdev-style')) {
      document.head.append(el('style', {
        id: 'pkv-tdev-style',
        text: `.pkv-tdev{left:12px;right:auto;top:50px}@media(max-width:820px){.pkv-tdev{left:8px;right:8px}}`
      }));
    }

    let box = null, topEl = null, tabsEl = null, bodyEl = null, copyBtn = null, pasteBtn = null;
    let curTab = 'both'; // 'both' | 'relief' | 'contours'

    const redraw = () => {
      saveTDev();
      if (inst && inst._dev) inst._dev.requestRender();
    };

    const mkSlider = (label, obj, key, min, max, step, fmt) => {
      const dec = step < 0.001 ? 4 : (step < 0.01 ? 3 : (step < 0.1 ? 2 : (step < 1 ? 1 : 0)));
      const inp = el('input', { type: 'range', class: 'pkv-dev-rng', min, max, step, value: obj[key] });
      const valEl = el('span', { class: 'pkv-dev-num', text: fmt ? fmt(obj[key]) : Number(obj[key]).toFixed(dec) });
      inp.addEventListener('input', () => {
        obj[key] = +inp.value;
        valEl.textContent = fmt ? fmt(obj[key]) : obj[key].toFixed(dec);
        redraw();
      });
      return el('div', { class: 'pkv-dev-row' }, el('label', { text: label }), inp, valEl);
    };

    const mkCheck = (label, obj, key, onExtra) => {
      const inp = el('input', { type: 'checkbox' });
      inp.checked = !!obj[key];
      inp.addEventListener('change', () => {
        obj[key] = inp.checked;
        if (onExtra) onExtra(inp.checked);
        redraw();
      });
      return el('label', { class: 'pkv-dev-chk' }, inp, el('span', { text: label }));
    };

    const mkColor = (label, obj, key) => {
      const inp = el('input', { type: 'color', class: 'pkv-dev-col', value: obj[key] });
      const hexTxt = el('span', { class: 'pkv-dev-num', text: obj[key] });
      inp.addEventListener('input', () => {
        obj[key] = inp.value;
        hexTxt.textContent = inp.value;
        redraw();
      });
      return el('div', { class: 'pkv-dev-row' }, el('label', { text: label }), inp, el('span', { class: 'pkv-sp' }), hexTxt);
    };

    const mkSec = (title, ...kids) => el('div', { class: 'pkv-dev-sec' }, el('div', { class: 'pkv-dev-sec-t', text: title }), ...kids);

    function renderQuickBar() {
      if (!topEl || !inst || !inst._dev) return;
      const { ST, save, updateAstro, requestRender } = inst._dev;
      topEl.textContent = '';

      const addChip = (label, active, onClick) => {
        topEl.append(el('button', {
          type: 'button',
          class: 'pkv-dev-chip' + (active ? ' on' : ''),
          text: label,
          onclick: () => { onClick(); save(); saveTDev(); renderQuickBar(); requestRender(); }
        }));
      };

      addChip('🏔️ Микрорельеф', DEV_TERRAIN.relief.enabled, () => {
        DEV_TERRAIN.relief.enabled = !DEV_TERRAIN.relief.enabled;
        if (curTab !== 'contours') renderBody();
      });
      addChip('⛰️ Гребни', DEV_TERRAIN.contours.ridgeOn, () => {
        DEV_TERRAIN.contours.ridgeOn = !DEV_TERRAIN.contours.ridgeOn;
        if (curTab !== 'relief') renderBody();
      });
      addChip('〰️ Ложбины', DEV_TERRAIN.contours.valleyOn, () => {
        DEV_TERRAIN.contours.valleyOn = !DEV_TERRAIN.contours.valleyOn;
        if (curTab !== 'relief') renderBody();
      });
      addChip('📏 Изолинии', !!ST.view.showIsolines, () => {
        ST.view.showIsolines = !ST.view.showIsolines;
      });
      addChip(ST.view.darkTheme ? '🌙 Тёмная' : '☀️ Светлая', !!ST.view.darkTheme, () => {
        ST.view.darkTheme = !ST.view.darkTheme;
        updateAstro();
      });
    }

    function appendReliefBlock(parent) {
      const r = DEV_TERRAIN.relief;
      parent.append(
        mkSec('Блок 1: Усиление и микрорельеф поверхности',
          mkCheck('Включить детализацию рельефа', r, 'enabled'),
          mkSlider('Сила бугров / кочек', r, 'bumpStrength', 0.0, 1.6, 0.02),
          mkSlider('Крупные складки (м)', r, 'macroScale', 20, 260, 5),
          mkSlider('Мелкие кочки (м)', r, 'microScale', 4, 55, 1),
          mkSlider('Скалистость склонов', r, 'cragStrength', 0.0, 1.5, 0.02),
          mkSlider('Слоистость пород', r, 'strataStrength', 0.0, 1.0, 0.02),
          mkSlider('Частота слоёв', r, 'strataFreq', 0.04, 0.6, 0.01),
          mkSlider('Затенение впадин (AO)', r, 'cavityAO', 0.0, 0.9, 0.02),
          mkSlider('Зернистость породы', r, 'albedoRough', 0.0, 0.7, 0.02),
          mkSlider('Отмывка отрогов', r, 'swissBoost', 0.5, 2.0, 0.05),
          mkSlider('Живость поясов (м)', r, 'hypsoWarp', 0.0, 15.0, 0.5),
          mkSlider('Детали в «Уклонах»', r, 'slopeDetail', 0.0, 1.0, 0.05),
          mkSlider('Дальность кочек (м)', r, 'detailDist', 1000, 15000, 250),
          mkSlider('Дальность складок (м)', r, 'macroDist', 6000, 40000, 500)
        )
      );
    }

    function appendContoursBlock(parent) {
      const c = DEV_TERRAIN.contours;
      parent.append(
        mkSec('Блок 2А: Горизонтали и штриховка рельефа',
          mkSlider('Живость горизонталей (м)', c, 'isoWarpAmp', 0.0, 25.0, 0.5),
          mkSlider('Яркость горизонталей', c, 'isoOpacity', 0.2, 2.0, 0.05),
          mkSlider('Микро-штриховка', c, 'microContourStr', 0.0, 0.8, 0.02),
          mkSlider('Частота штриховки', c, 'microContourFreq', 0.1, 1.5, 0.05)
        ),
        mkSec('Блок 2Б: Контуры гребней и ложбин',
          mkCheck('Линии внутренних гребней', c, 'ridgeOn'),
          mkSlider('Порог гребней', c, 'ridgeThr', 0.001, 0.02, 0.0005),
          mkSlider('Яркость гребней', c, 'ridgeStr', 0.0, 1.0, 0.02),
          mkColor('Гребни (светлая)', c, 'ridgeColLight'),
          mkColor('Гребни (тёмная)', c, 'ridgeColDark'),
          mkCheck('Линии ложбин и промоин', c, 'valleyOn'),
          mkSlider('Порог ложбин', c, 'valleyThr', 0.001, 0.025, 0.0005),
          mkSlider('Яркость ложбин', c, 'valleyStr', 0.0, 1.0, 0.02),
          mkColor('Ложбины (светлая)', c, 'valleyColLight'),
          mkColor('Ложбины (тёмная)', c, 'valleyColDark'),
          mkSlider('Толщина (px)', c, 'creaseThick', 0.5, 2.5, 0.05),
          mkSlider('Дальность (м)', c, 'creaseMaxDist', 3000, 45000, 500),
          mkSlider('Разрыв штриха', c, 'sketchBreak', 0.0, 0.8, 0.02)
        )
      );
    }

    function renderBody() {
      if (!bodyEl) return;
      bodyEl.textContent = '';
      if (curTab === 'both' || curTab === 'relief') appendReliefBlock(bodyEl);
      if (curTab === 'both' || curTab === 'contours') appendContoursBlock(bodyEl);
    }

    function setTab(k) {
      curTab = k;
      if (tabsEl) tabsEl.querySelectorAll('.pkv-dev-tab').forEach(t => t.classList.toggle('on', t.dataset.k === k));
      renderBody();
    }

    function copySettings() {
      const txt = `  const DEV_TERRAIN_DEF = ${JSON.stringify(DEV_TERRAIN, null, 2)};`;
      const ok = () => {
        if (!copyBtn) return;
        const old = copyBtn.textContent;
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => { if (copyBtn) copyBtn.textContent = old; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, () => prompt('Скопируйте настройки:', txt));
      } else {
        prompt('Скопируйте настройки:', txt);
      }
    }

    function applyImported(txt) {
      const cleaned = String(txt || '')
        .replace(/^\s*(?:const|let|var)?\s*DEV_TERRAIN(?:_DEF)?\s*=\s*/, '')
        .replace(/;\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1');
      const obj = JSON.parse(cleaned);
      if (!obj || (!obj.relief && !obj.contours)) throw new Error('Не найдены блоки relief / contours');
      if (obj.relief) Object.assign(DEV_TERRAIN.relief, obj.relief);
      if (obj.contours) Object.assign(DEV_TERRAIN.contours, obj.contours);
      renderQuickBar();
      renderBody();
      redraw();
    }

    async function pasteSettings() {
      let txt = '';
      if (navigator.clipboard && navigator.clipboard.readText) {
        try { txt = await navigator.clipboard.readText(); } catch (e) {}
      }
      if (!txt) txt = prompt('Вставьте настройки DEV_TERRAIN_DEF (JSON):') || '';
      if (!txt.trim()) return;
      try {
        applyImported(txt);
        if (pasteBtn) {
          const old = pasteBtn.textContent;
          pasteBtn.textContent = '✓ Вставлено!';
          setTimeout(() => { if (pasteBtn) pasteBtn.textContent = old; }, 1600);
        }
      } catch (e) {
        alert('Ошибка вставки: ' + (e.message || e));
      }
    }

    function resetAll() {
      Object.assign(DEV_TERRAIN.relief, JSON.parse(JSON.stringify(DEV_TERRAIN_DEF.relief)));
      Object.assign(DEV_TERRAIN.contours, JSON.parse(JSON.stringify(DEV_TERRAIN_DEF.contours)));
      try { localStorage.removeItem(TDEV_LS); } catch (e) {}
      renderQuickBar();
      renderBody();
      redraw();
    }

    function openTerrainDevTool() {
      if (box) {
        box.classList.remove('hide');
        renderQuickBar();
        return;
      }
      const bColl = el('button', { class: 'pkv-b', type: 'button', text: '▁', title: 'Свернуть/развернуть' });
      const bCls = el('button', { class: 'pkv-b', type: 'button', text: '✕', title: 'Скрыть' });
      const hd = el('div', { class: 'pkv-dev-hd' }, el('b', { text: '🏔️ Dev: Рельеф и контуры' }), bColl, bCls);

      topEl = el('div', { class: 'pkv-dev-top' });
      tabsEl = el('div', { class: 'pkv-dev-tabs' });
      [
        ['both', '📋 Оба блока'],
        ['relief', '⛰️ Рельеф'],
        ['contours', '✏️ Контуры']
      ].forEach(([k, label]) => {
        tabsEl.append(el('div', { class: 'pkv-dev-tab', 'data-k': k, text: label, onclick: () => setTab(k) }));
      });

      bodyEl = el('div', { class: 'pkv-dev-body' });
      copyBtn = el('button', { class: 'pkv-b prime', type: 'button', text: '📋 Копировать', onclick: copySettings });
      pasteBtn = el('button', { class: 'pkv-b', type: 'button', text: '📥 Вставить', onclick: pasteSettings });
      const resetBtn = el('button', { class: 'pkv-b', type: 'button', text: '↺ Сброс', onclick: resetAll });
      const foot = el('div', { class: 'pkv-dev-foot' }, copyBtn, pasteBtn, resetBtn);

      box = el('div', { class: 'pkv-dev pkv-tdev' }, hd, topEl, tabsEl, bodyEl, foot);
      document.body.append(box);

      bColl.onclick = () => {
        box.classList.toggle('coll');
        bColl.textContent = box.classList.contains('coll') ? '▢' : '▁';
      };
      bCls.onclick = () => box.classList.add('hide');

      let dr = null;
      hd.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        const r = box.getBoundingClientRect();
        dr = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        hd.setPointerCapture(e.pointerId);
      });
      hd.addEventListener('pointermove', e => {
        if (!dr) return;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        box.style.left = clamp(e.clientX - dr.dx, 0, window.innerWidth - 120) + 'px';
        box.style.top = clamp(e.clientY - dr.dy, 0, window.innerHeight - 50) + 'px';
      });
      hd.addEventListener('pointerup', () => { dr = null; });
      hd.addEventListener('pointercancel', () => { dr = null; });

      renderQuickBar();
      setTab(curTab);
    }

    function closeTerrainDevTool() {
      if (box) { box.remove(); box = null; }
    }

    let tDevWasVisible = false;
    api.openTerrainDevTool = openTerrainDevTool;

    const prevClose = api.close.bind(api);
    const prevMin = api.minimize.bind(api);
    const prevRes = api.restore.bind(api);

    api.close = () => {
      tDevWasVisible = false;
      closeTerrainDevTool();
      return prevClose();
    };
    api.minimize = () => {
      tDevWasVisible = !!(box && !box.classList.contains('hide'));
      if (box) box.classList.add('hide');
      return prevMin();
    };
    api.restore = skip => {
      const res = prevRes(skip);
      if (box && tDevWasVisible) box.classList.remove('hide');
      return res;
    };
  })();



})();