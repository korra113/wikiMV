/* ============================================================================
   WM.clouds — «Гравюрные облака» для 3D-рельефа (Версия 10 — «живая гравюра»)
   [Optimized Edition: Fast Shader Math, Low Overhead Uniforms, Zero-GC Solver]
   ========================================================================== */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  if (WM.clouds && WM.clouds.__loaded) return;

  const LS_KEY = 'wm_clouds_v10';
  const MERC_FULL = 40075016.68;
  const MERC_HALF = 20037508.34;
  const FIELD_N = 128;

  const DEFAULTS = {
    enabled: true,

    // — Форма и распределение —
    scale: 0.85,
    coverage: 0.86,
    coverageFromWeather: false,
    density: 2.85,
    billowDetail: 0.9,
    stretch: 3,

    // — Разнообразие типов облаков —
    mixCumulus: 2,
    mixRolls: 4,
    mixArcs: 1,
    mixStreaks: 2,
    mixSheets: 1,
    fractus: 0.5,
    translucency: 0.1,
    curl: 0.3,
    edgeRagged: -2,

    // — Слепливание (метаболы) —
    cumulusMode: true,
    clusterIsolation: 6,
    smoothBlend: 3,
    sunBlendBoost: 8,

    // — Объём и светотеневой баланс —
    creviceDarkness: 0,
    volumeDepth: 1.1,
    shadowCoverage: 0.46,
    shadowSoftness: 0.6,

    // — Атмосфера и закатный свет —
    atmTintStrength: 1.5,
    sunsetWarmth: 1.5,
    shadowBrightness: 1.35,
    shadowColorSat: 1,
    bodyColorInfluence: 1,

    // — Базовая цветокоррекция —
    cloudBrightness: 1.35,
    cloudContrast: 1.2,
    cloudTempLight: 0.05,
    cloudTempShadow: 0.4,

    // — Гравюрные гашюры —
    hatchStyle: 'woodcut',
    hatchCurvature: 0.75,
    hatchSpacing: 3.8,
    hatchThickness: 0.75,
    hatchLength: 4.8,
    hatchThinning: 0.52,
    hatchLight: 1,
    creaseOutlines: 0.2,
    creaseBlur: 0.6,
    outlineWidth: 2.5,
    outlineColor: '#271f1b',
    bodyColor: '#ff5e24',
    inkColor: '#15130e',
    opacity: 0.9,
    inkOpacity: 0.84,
    shadowOpacity: 0.4,
    shadowHeight: 5,
    shadowBlur: 6,

    // — Взаимодействие с рельефом —
    terrain: true,
    mountainDeflection: 2.5,
    peakPiercing: 0.6,
    cloudBase: 1.5,
    cloudThickness: 0.5,
    wakeSplit: 1,
    orographicLift: 0.08,
    foehnDissipation: 0.85,

    // — Ветер —
    speed: 1,
    windSource: 'manual',
    windDir: 196,
    windSpeed: 16,

    // — Плавность объёмов и тона —
    volumeSmooth: 0.55,
    toneRamp: 1,
    paperShading: 1.1,
    paperGrain: 1.5,
    paperGrainScale: 1,
    paperGrainContrast: 3,

    // — Внутренняя анимация —
    innerAnim: true,
    innerSpeed: 1.15,
    innerWobble: 0.8,
    innerWarp: 0.1,
    hatchBoil: 0,
    animFps: 30,

    // — Тёмные облака —
    darkCover: 0.28,
    darkAmount: 1.1,
    darkSoft: 0.44,
    darkScale: 2.7,

    // — Плавность появления / смены —
    fadeIn: 1.4,
    fadeOut: 0.6,
    reorientDeg: 25,

    // — Производительность —
    fps: 60,
    adaptiveFps: true,
    resolution: 0.9,
    fieldRes: 0.5,
    autoQuality: true,
    zIndex: 460
  };

  let cfg = { ...DEFAULTS };
  let cfgRev = 1;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    for (const k in saved) {
      if (k in DEFAULTS && typeof saved[k] === typeof DEFAULTS[k]) cfg[k] = saved[k];
    }
  } catch (e) {}

  let saveTimer = null;
  function saveConfig() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window._wmResetting) return;
      try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
    }, 200);
  }

  const clamp = (v, min, max) => (v < min ? min : (v > max ? max : v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth01 = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const modPos = (a, b) => ((a % b) + b) % b;
  

  const _hexCache = new Map();
  function hex3(hex) {
    let r = _hexCache.get(hex);
    if (r) return r;
    const clean = String(hex || '#000').replace('#', '');
    const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16) || 0;
    r = [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    _hexCache.set(hex, r);
    return r;
  }


  let canvas = null, gl = null;
  let progField = null, progComp = null, vao = null, vbo = null;
  let running = false, raf = 0, lastTime = 0, prevRafTs = 0;
  let enableSeq = 0;
  let cssW = 0, cssH = 0;
  let noiseTexture = null;
  let ctxLost = false;
  let forceRedraw = true;

  const FADE = { alpha: 0, lastAlpha: -1, misT: 0, reorient: false };
  let isMapMoving = false;
  let lastMoveEnd = 0;
  let animT = 0;
  let hiddenCleared = false;
  let covSm = null;

  function createNoiseTexture(gl) {
    const S = 256;
    const data = new Uint8Array(S * S * 4);
    const P = new Uint8Array(512);
    for (let i = 0; i < 256; i++) P[i] = i;
    for (let i = 255; i > 0; i--) {
      const r = Math.floor(Math.random() * (i + 1));
      const t = P[i]; P[i] = P[r]; P[r] = t;
    }
    for (let i = 0; i < 256; i++) P[256 + i] = P[i];

    function grad(hash, x, y) {
      const h = hash & 7;
      const u = h < 4 ? x : y;
      const v = h < 4 ? y : x;
      return ((h & 1) ? -u : u) + ((h & 2) ? -2.0 * v : 2.0 * v);
    }
    function perlin(x, y, period) {
      const fx = Math.floor(x), fy = Math.floor(y);
      const xi = modPos(fx, period), yi = modPos(fy, period);
      const xi1 = (xi + 1) % period, yi1 = (yi + 1) % period;
      const xf = x - fx, yf = y - fy;
      const u = xf * xf * (3.0 - 2.0 * xf);
      const v = yf * yf * (3.0 - 2.0 * yf);
      const aa = P[P[xi] + yi], ab = P[P[xi] + yi1];
      const ba = P[P[xi1] + yi], bb = P[P[xi1] + yi1];
      return lerp(
        lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u),
        lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u),
        v
      );
    }

    function makeWorley(g) {
      const pts = new Float32Array(g * g * 2);
      for (let i = 0; i < g * g; i++) { pts[2 * i] = Math.random(); pts[2 * i + 1] = Math.random(); }
      const cs = S / g;
      const out = new Float32Array(S * S);
      for (let y = 0; y < S; y++) {
        const cy = Math.floor(y / cs);
        for (let x = 0; x < S; x++) {
          const cx = Math.floor(x / cs);
          let best = 1e9;
          for (let oy = -1; oy <= 1; oy++) {
            const gy = modPos(cy + oy, g);
            for (let ox = -1; ox <= 1; ox++) {
              const gx = modPos(cx + ox, g);
              const k = (gy * g + gx) * 2;
              const px = (cx + ox + pts[k]) * cs, py = (cy + oy + pts[k + 1]) * cs;
              const dx = px - x, dy = py - y;
              const d = dx * dx + dy * dy;
              if (d < best) best = d;
            }
          }
          out[y * S + x] = 1.0 - clamp(Math.sqrt(best) / (cs * 0.95), 0, 1);
        }
      }
      return out;
    }
    const w16 = makeWorley(16), w32 = makeWorley(32);

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const idx = (y * S + x) * 4;
        let rVal = perlin(x / 32, y / 32, 8) * 0.55 + perlin(x / 16, y / 16, 16) * 0.30 + perlin(x / 8, y / 8, 32) * 0.15;
        rVal = clamp(rVal * 0.5 + 0.5, 0, 1);
        let gVal = perlin(x / 16, y / 32, 16) * 0.65 + perlin(x / 8, y / 16, 32) * 0.35;
        gVal = clamp(gVal * 0.5 + 0.5, 0, 1);
        const bVal = clamp(w16[y * S + x] * 0.65 + w32[y * S + x] * 0.35, 0, 1);
        let aVal = perlin(y / 32 + 2.3, x / 32 + 5.1, 8) * 0.6 + perlin(y / 16 + 1.1, x / 16 + 7.3, 16) * 0.4;
        aVal = clamp(aVal * 0.5 + 0.5, 0, 1);
        data[idx]     = Math.round(rVal * 255);
        data[idx + 1] = Math.round(gVal * 255);
        data[idx + 2] = Math.round(bVal * 255);
        data[idx + 3] = Math.round(aVal * 255);
      }
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  // Оптимизированный решатель поля: повторное использование плоских буферов (Zero-GC)
  function solveField(job) {
    var N = job.N, cell = job.cell, K = job.K, vmin = job.vmin;
    var ux = job.ux, uy = job.uy, h = job.h, iters = job.iters || 180;
    var NN = N * N, half = N * cell * 0.5;
    var i, j, c, it, color;
    var b0 = job.b0 || 450, bR = job.bR || 2200;

    var _pool = self._fldPool;
    if (!_pool || _pool.NN !== NN) {
      _pool = self._fldPool = {
        NN: NN,
        m: new Float32Array(NN), blk: new Float32Array(NN),
        phi: new Float32Array(NN), px: new Float32Array(N),
        Fx: new Float32Array(NN), Fy: new Float32Array(NN),
        vx: new Float32Array(NN), vy: new Float32Array(NN),
        curl: new Float32Array(NN), dPsi: new Float32Array(NN),
        tvx: new Float32Array(NN), tvy: new Float32Array(NN),
        s: new Float32Array(NN), fixed: new Uint8Array(NN),
        oro: new Float32Array(NN), wake: new Float32Array(NN),
        scratch: new Float32Array(NN),
        hs: new Float32Array(NN), hs2: new Float32Array(NN)
      };
    }
    var m = _pool.m, blk = _pool.blk, phi = _pool.phi, px = _pool.px;
    var Fx = _pool.Fx, Fy = _pool.Fy, vx = _pool.vx, vy = _pool.vy;
    var curl = _pool.curl, dPsi = _pool.dPsi, tvx = _pool.tvx, tvy = _pool.tvy;
    var s = _pool.s, fixed = _pool.fixed, oro = _pool.oro, wake = _pool.wake;
    var scratch = _pool.scratch;

    fixed.fill(0); dPsi.fill(0); wake.fill(0);

    for (c = 0; c < NN; c++) {
      var b = (h[c] - b0) / bR;
      b = b < 0 ? 0 : (b > 1 ? 1 : b);
      var bSq = Math.pow(b, 1.5);
      blk[c] = bSq;
      m[c] = 1.0 / (1.0 + K * 45.0 * bSq);
    }

    for (i = 0; i < N; i++) px[i] = (i + 0.5) * cell - half;

    for (j = 0; j < N; j++) {
      var jOffset = j * N;
      var py = uy * px[j];
      for (i = 0; i < N; i++) {
        phi[jOffset + i] = ux * px[i] + py;
      }
    }
    var omega = 1.92;
    for (it = 0; it < iters; it++) {
      for (color = 0; color < 2; color++) {
        for (j = 1; j < N - 1; j++) {
          i = color ^ (j & 1);
          if (i < 1) i += 2;
          for (; i < N - 1; i += 2) {
            c = j * N + i;
            var mc = m[c];
            var mE = 2 * mc * m[c + 1] / (mc + m[c + 1]);
            var mW = 2 * mc * m[c - 1] / (mc + m[c - 1]);
            var mN = 2 * mc * m[c + N] / (mc + m[c + N]);
            var mS = 2 * mc * m[c - N] / (mc + m[c - N]);
            var sumM = mE + mW + mN + mS;
            phi[c] += omega * ((mE * phi[c + 1] + mW * phi[c - 1] + mN * phi[c + N] + mS * phi[c - N]) / sumM - phi[c]);
          }
        }
      }
    }

    var invCell = 1.0 / cell;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        c = j * N + i;
        if (i < N - 1) Fx[c] = (2 * m[c] * m[c + 1] / (m[c] + m[c + 1])) * (phi[c + 1] - phi[c]) * invCell;
        if (j < N - 1) Fy[c] = (2 * m[c] * m[c + N] / (m[c] + m[c + N])) * (phi[c + N] - phi[c]) * invCell;
      }
    }
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        c = j * N + i;
        vx[c] = (i === 0) ? Fx[c] : ((i === N - 1) ? Fx[c - 1] : 0.5 * (Fx[c - 1] + Fx[c]));
        vy[c] = (j === 0) ? Fy[c] : ((j === N - 1) ? Fy[c - N] : 0.5 * (Fy[c - N] + Fy[c]));
      }
    }

    var inv2Cell = 0.5 * invCell;
    for (j = 1; j < N - 1; j++) {
      for (i = 1; i < N - 1; i++) {
        var dvx_dy = (vx[(j + 1) * N + i] - vx[(j - 1) * N + i]) * inv2Cell;
        var dvy_dx = (vy[j * N + (i + 1)] - vy[j * N + (i - 1)]) * inv2Cell;
        curl[j * N + i] = dvx_dy - dvy_dx;
      }
    }
    var cellSq = cell * cell;
    for (it = 0; it < 60; it++) {
      for (color = 0; color < 2; color++) {
        for (j = 1; j < N - 1; j++) {
          i = color ^ (j & 1);
          if (i < 1) i += 2;
          for (; i < N - 1; i += 2) {
            c = j * N + i;
            dPsi[c] = 0.25 * (dPsi[c + 1] + dPsi[c - 1] + dPsi[c + N] + dPsi[c - N] - cellSq * curl[c]);
          }
        }
      }
    }

    for (c = 0; c < NN; c++) {
      var sp = Math.sqrt(vx[c] * vx[c] + vy[c] * vy[c]);
      if (sp < 1e-6) { tvx[c] = ux * vmin; tvy[c] = uy * vmin; }
      else if (sp < vmin) { var kk = vmin / sp; tvx[c] = vx[c] * kk; tvy[c] = vy[c] * kk; }
      else { tvx[c] = vx[c]; tvy[c] = vy[c]; }
    }
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        c = j * N + i;
        s[c] = ux * px[i] + uy * px[j];
        if ((i === 0 && ux > 0) || (i === N - 1 && ux < 0) || (j === 0 && uy > 0) || (j === N - 1 && uy < 0)) fixed[c] = 1;
      }
    }
    for (var pass = 0; pass < 3; pass++) {
      for (var dy = 0; dy < 2; dy++) {
        for (var dx = 0; dx < 2; dx++) {
          for (var jj = 0; jj < N; jj++) {
            j = dy ? N - 1 - jj : jj;
            for (var ii = 0; ii < N; ii++) {
              i = dx ? N - 1 - ii : ii;
              c = j * N + i;
              if (fixed[c]) continue;
              var wx = tvx[c], wy = tvy[c];
              var ax = Math.abs(wx) * invCell, ay = Math.abs(wy) * invCell;
              var ni = i - (wx > 0 ? 1 : -1), nj = j - (wy > 0 ? 1 : -1);
              var sx = (ni >= 0 && ni < N) ? s[j * N + ni] : (ux * (px[i] + (ni - i) * cell) + uy * px[j]);
              var sy = (nj >= 0 && nj < N) ? s[nj * N + i] : (ux * px[i] + uy * (px[j] + (nj - j) * cell));
              s[c] = (1 + ax * sx + ay * sy) / (ax + ay);
            }
          }
        }
      }
    }

    function blurTo(src, dst) {
      var x, y, xx, yy, acc, cnt;
      for (y = 0; y < N; y++) {
        for (x = 0; x < N; x++) {
          acc = 0; cnt = 0;
          for (yy = y - 1; yy <= y + 1; yy++) {
            if (yy < 0 || yy >= N) continue;
            var rowOff = yy * N;
            for (xx = x - 1; xx <= x + 1; xx++) {
              if (xx < 0 || xx >= N) continue;
              acc += src[rowOff + xx]; cnt++;
            }
          }
          dst[y * N + x] = acc / cnt;
        }
      }
    }

    blurTo(h, scratch);
    blurTo(scratch, _pool.hs);
    var hs = _pool.hs;

    for (j = 1; j < N - 1; j++) {
      for (i = 1; i < N - 1; i++) {
        c = j * N + i;
        var up = (vx[c] * (hs[c + 1] - hs[c - 1]) + vy[c] * (hs[c + N] - hs[c - N])) * (inv2Cell / 140.0);
        oro[c] = up < -1 ? -1 : (up > 1 ? 1 : up);
      }
    }
    blurTo(oro, scratch);
    for (c = 0; c < NN; c++) oro[c] = scratch[c];

    var decay = Math.exp(-cell / 24.0);
    var stepX = ux >= 0 ? 1 : -1, stepY = uy >= 0 ? 1 : -1;
    var startI = ux >= 0 ? 0 : N - 1, endI = ux >= 0 ? N : -1;
    var startJ = uy >= 0 ? 0 : N - 1, endJ = uy >= 0 ? N : -1;

    for (j = startJ; j !== endJ; j += stepY) {
      for (i = startI; i !== endI; i += stepX) {
        c = j * N + i;
        var srcWake = 0.0;
        if (blk[c] > 0.20 && oro[c] < 0.0) {
          srcWake = (blk[c] - 0.20) * 1.6 * (-oro[c]);
        }
        var prevI = i - stepX, prevJ = j - stepY;
        var upWake = 0.0, cntW = 0;
        if (prevI >= 0 && prevI < N) { upWake += wake[j * N + prevI] * Math.abs(ux); cntW += Math.abs(ux); }
        if (prevJ >= 0 && prevJ < N) { upWake += wake[prevJ * N + i] * Math.abs(uy); cntW += Math.abs(uy); }
        var advected = cntW > 0 ? (upWake / cntW) * decay : 0.0;
        wake[c] = Math.max(srcWake, advected);
      }
    }

    var maxD = 0.35 * N * cell;
    var cl = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
    blurTo(wake, scratch); blurTo(scratch, wake);
    blurTo(hs, scratch);

    var out = new Float32Array(NN * 4);
    for (c = 0; c < NN; c++) {
      var oPar = s[c] - (ux * px[c % N] + uy * px[(c / N) | 0]);
      var oPer = dPsi[c] * 1.5;
      var oOro = oro[c] > 0 ? oro[c] : -cl(wake[c] * 1.35 + (-oro[c]) * 0.75, 0.0, 1.8);
      out[4 * c]     = cl(oPar, -maxD, maxD);
      out[4 * c + 1] = cl(oPer, -maxD, maxD);
      out[4 * c + 2] = oOro;
      out[4 * c + 3] = scratch[c] * 0.001;
    }

    blurTo(h, scratch);
    var hl = scratch;
    var ter = new Float32Array(NN * 4);
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        c = j * N + i;
        var i0 = i > 0 ? c - 1 : c, i1 = i < N - 1 ? c + 1 : c;
        var j0 = j > 0 ? c - N : c, j1 = j < N - 1 ? c + N : c;
        var gx = (hl[i1] - hl[i0]) * 0.001 / (cell * (i1 - i0 === 2 ? 2 : 1));
        var gy = (hl[j1] - hl[j0]) * 0.001 / (cell * (j1 - j0 === 2 * N ? 2 : 1));
        ter[4 * c]     = hl[c] * 0.001;
        ter[4 * c + 1] = cl(gx, -3, 3);
        ter[4 * c + 2] = cl(gy, -3, 3);
        ter[4 * c + 3] = 0;
      }
    }
    return { flow: out, ter: ter };
  }

  const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const tileCache = new Map();
  const tilePending = new Map();
  const tileFail = new Map();

  let sharedTileCanvas = null;
  let sharedTileCtx = null;
  function getSharedTileCtx() {
    if (!sharedTileCtx && typeof OffscreenCanvas !== 'undefined') {
      sharedTileCanvas = new OffscreenCanvas(256, 256);
      sharedTileCtx = sharedTileCanvas.getContext('2d', { willReadFrequently: true });
    }
    return sharedTileCtx;
  }

  async function loadTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    const hit = tileCache.get(key);
    if (hit) return hit;
    const failT = tileFail.get(key);
    if (failT && performance.now() - failT < 60000) return null;
    let p = tilePending.get(key);
    if (p) return p;

    p = (async () => {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      try {
        const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const resp = await fetch(url, { signal: ctl.signal, mode: 'cors' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();

        let d;
        const ctx = getSharedTileCtx();
        if ('createImageBitmap' in window && ctx) {
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          d = ctx.getImageData(0, 0, 256, 256).data;
        } else {
          return null;
        }

        const out = new Int16Array(65536);
        for (let i = 0; i < 65536; i++) {
          const v = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          out[i] = v < -500 ? -500 : (v > 9000 ? 9000 : Math.round(v));
        }
        tileCache.set(key, out);
        if (tileCache.size > 64) tileCache.delete(tileCache.keys().next().value);
        return out;
      } catch (e) {
        tileFail.set(key, performance.now());
        return null;
      } finally {
        clearTimeout(to);
        tilePending.delete(key);
      }
    })();
    tilePending.set(key, p);
    return p;
  }

  let worker = null, workerFailed = false, jobSeq = 0;
  const workerPending = new Map();

  function runSolver(job) {
    return new Promise((resolve, reject) => {
      job.id = ++jobSeq;
      if (!workerFailed) {
        try {
          if (!worker) {
            const src = 'self.onmessage=function(e){var r=(' + solveField.toString() +
              ')(e.data);self.postMessage({id:e.data.id,out:r},[r.flow.buffer,r.ter.buffer]);};';
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            worker.onmessage = ev => {
              const p = workerPending.get(ev.data.id);
              if (p) { workerPending.delete(ev.data.id); p.resolve(ev.data.out); }
            };
            worker.onerror = () => {
              workerFailed = true;
              workerPending.forEach(p => p.reject(new Error('worker error')));
              workerPending.clear();
            };
          }
          workerPending.set(job.id, { resolve, reject });
          worker.postMessage(job, [job.h.buffer]);
          return;
        } catch (e) { workerFailed = true; }
      }
      setTimeout(() => { try { resolve(solveField(job)); } catch (e) { reject(e); } }, 0);
    });
  }

  const fld = {
    cur: null, prev: null,
    building: false, lastT: 0, epoch: 0,
    blendT0: 0, amtT0: 0
  };

  const terrainSig = () => cfg.mountainDeflection.toFixed(2) + '|' + cfg.cloudBase.toFixed(1);
  const wantFieldSize = view => clamp(Math.max(view.w, view.h) * 2.4, 120, 1800);

  function needsRebuild(view) {
    const c = fld.cur;
    if (!c) return true;
    const S = wantFieldSize(view);
    const r = S / c.size;
    if (r > 1.3 || r < 0.55) return true;
    const m = 0.17 * c.size;
    if (view.cx - view.w / 2 < c.ox + m || view.cx + view.w / 2 > c.ox + c.size - m ||
        view.cy - view.h / 2 < c.oy + m || view.cy + view.h / 2 > c.oy + c.size - m) return true;
    if (wind.ux * c.ux + wind.uy * c.uy < 0.985) return true;
    if (c.sig !== terrainSig()) return true;
    return false;
  }

  async function buildField(view, epoch) {
    const N = FIELD_N;
    const S = wantFieldSize(view);
    const cell = S / N;
    const ox = view.cx - S / 2, oy = view.cy - S / 2;
    const ux = wind.ux, uy = wind.uy;
    const sig = terrainSig();
    const K = cfg.mountainDeflection;

    let z = clamp(Math.round(Math.log2(40075.017 / (256 * cell))), 2, 10);
    let n = Math.pow(2, z);
    const fxAt = kx => ((kx * 1000 + MERC_HALF) / MERC_FULL) * n;
    const fyAt = ky => ((MERC_HALF - ky * 1000) / MERC_FULL) * n;

    let tx0 = Math.floor(fxAt(ox)), tx1 = Math.floor(fxAt(ox + S));
    let ty0 = Math.max(0, Math.floor(fyAt(oy + S))), ty1 = Math.min(n - 1, Math.floor(fyAt(oy)));
    while ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 20 && z > 2) {
      z--; n = Math.pow(2, z);
      tx0 = Math.floor(fxAt(ox)); tx1 = Math.floor(fxAt(ox + S));
      ty0 = Math.max(0, Math.floor(fyAt(oy + S))); ty1 = Math.min(n - 1, Math.floor(fyAt(oy)));
    }

    const tileMap = new Map();
    const jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const wx = modPos(tx, n);
        const key = wx + ':' + ty;
        if (tileMap.has(key)) continue;
        tileMap.set(key, null);
        jobs.push(loadTile(z, wx, ty).then(t => { tileMap.set(key, t); }));
      }
    }
    await Promise.all(jobs);
    if (epoch !== fld.epoch) return null;

    const heights = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const fy = fyAt(oy + (j + 0.5) * cell);
      const ty = Math.floor(fy);
      if (ty < 0 || ty >= n) continue;
      const py = Math.min(255, Math.floor((fy - ty) * 256)) * 256;
      for (let i = 0; i < N; i++) {
        const fx = fxAt(ox + (i + 0.5) * cell);
        const tx = Math.floor(fx);
        const px = Math.min(255, Math.floor((fx - tx) * 256));
        const t = tileMap.get(modPos(tx, n) + ':' + ty);
        if (t) {
          const hv = t[py + px];
          heights[j * N + i] = hv > 0 ? hv : 0;
        }
      }
    }

    const baseM = cfg.cloudBase * 1000;
    const out = await runSolver({
      N, cell, K, vmin: 0.25, ux, uy, h: heights, iters: 160,
      b0: Math.max(150, baseM * 0.45), bR: Math.max(900, baseM * 1.4)
    });
    if (epoch !== fld.epoch) return null;
    return { flow: out.flow, ter: out.ter, N, ox, oy, size: S, ux, uy, sig };
  }

  function makeFloatTex(unit, data, N) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, N, 0, gl.RGBA, gl.FLOAT, data);
    return tex;
  }

  function deleteFieldTex(f) {
    if (!f || !gl) return;
    if (f.tex) { gl.deleteTexture(f.tex); f.tex = null; }
    if (f.tex2) { gl.deleteTexture(f.tex2); f.tex2 = null; }
  }

  function fieldValid(view) {
    const c = fld.cur;
    if (!c) return false;
    const m = 0.08 * c.size;
    return view.cx - view.w / 2 >= c.ox + m && view.cx + view.w / 2 <= c.ox + c.size - m &&
           view.cy - view.h / 2 >= c.oy + m && view.cy + view.h / 2 <= c.oy + c.size - m;
  }

  function installField(f) {
    if (!gl) return;
    const tex = makeFloatTex(1, f.flow, f.N);
    const tex2 = makeFloatTex(3, f.ter, f.N);
    const obj = { tex, tex2, ox: f.ox, oy: f.oy, size: f.size, ux: f.ux, uy: f.uy, sig: f.sig };
    const t = performance.now();
    const hidden = FADE.alpha < 0.02;
    if (fld.cur && !hidden) {
      if (fld.prev) deleteFieldTex(fld.prev);
      fld.prev = fld.cur;
      fld.blendT0 = t;
    } else {
      if (fld.prev) deleteFieldTex(fld.prev);
      if (fld.cur) deleteFieldTex(fld.cur);
      fld.prev = null;
      fld.amtT0 = t - 5000;
    }
    fld.cur = obj;
    fld.failed = false;
    forceRedraw = true;
  }

  function maintainField(view) {
    if (!cfg.terrain || fld.building || !gl || isMapMoving) return;
    const t = performance.now();
    if (t - lastMoveEnd < 250) return;
    if (fld.failed && t - fld.lastT < 15000) return;
    const critical = !fld.cur || !fieldValid(view);
    if (!critical) {
      if (t - fld.lastT < 2200) return;
      if (!needsRebuild(view)) return;
    }
    fld.building = true;
    fld.lastT = t;
    const ep = fld.epoch;
    buildField(view, ep)
      .then(f => { if (f && ep === fld.epoch) installField(f); })
      .catch(err => {
        console.warn('[WM.clouds] Поле потока не построено:', err);
        if (ep === fld.epoch) fld.failed = true;
      })
      .finally(() => { if (ep === fld.epoch) { fld.building = false; fld.lastT = performance.now(); } });
  }

  function resetField() {
    fld.epoch++;
    fld.building = false;
    fld.failed = false;
    deleteFieldTex(fld.cur); deleteFieldTex(fld.prev);
    fld.cur = null; fld.prev = null;
  }

  const VS_SOURCE = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const GLSL_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const float FN = ${FIELD_N}.0;

uniform sampler2D u_noiseTex;
uniform sampler2D u_fldCur;
uniform sampler2D u_fldPrev;
uniform sampler2D u_terCur;
uniform sampler2D u_terPrev;
uniform int   u_hasField;
uniform vec4  u_fldCurGeo;
uniform vec2  u_fldCurDir;
uniform vec4  u_fldPrevGeo;
uniform vec2  u_fldPrevDir;
uniform float u_fldMix;
uniform float u_fldAmt;
uniform float u_W;
uniform float u_Er;
uniform float u_dispMax;
uniform vec2  u_kmSize;
uniform mat2  u_patRot;
uniform vec2  u_ppC;
uniform vec4  u_anim;
uniform vec4  u_dark;
uniform float u_darkSz;

#define OM(k) (float(k) * 0.0015339808)

in vec2 v_uv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float darkMask(vec2 pp) {
  if (u_dark.y < 0.005 || u_dark.x < 0.005) return 0.0;
  vec4 nd = textureLod(u_noiseTex, pp / u_darkSz + vec2(0.53, 0.17), u_dark.w);
  float v = clamp((nd.r - 0.5) * 2.2 + 0.5, 0.0, 1.0);
  float th = 1.0 - u_dark.x;
  float sf = max(0.02, u_dark.z);
  return smoothstep(th - sf, th + sf, v);
}

vec4 texBicubic(sampler2D tex, vec2 uv, vec2 sz) {
  vec2 tc = uv * sz - 0.5;
  vec2 i = floor(tc);
  vec2 f = tc - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) * 0.16666667;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) * 0.16666667;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) * 0.16666667;
  vec2 w3 = f3 * 0.16666667;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 p0 = (i - 1.0 + w1 / s0 + 0.5) / sz;
  vec2 p1 = (i + 1.0 + w3 / s1 + 0.5) / sz;
  vec4 a = textureLod(tex, vec2(p0.x, p0.y), 0.0);
  vec4 b = textureLod(tex, vec2(p1.x, p0.y), 0.0);
  vec4 c = textureLod(tex, vec2(p0.x, p1.y), 0.0);
  vec4 d = textureLod(tex, vec2(p1.x, p1.y), 0.0);
  return s0.y * (s0.x * a + s1.x * b) + s1.y * (s0.x * c + s1.x * d);
}

struct Terr {
  vec2  disp;
  float oro;
  float wake;
  float h;
  vec2  g;
};

Terr terrOne(sampler2D ft, sampler2D tt, vec4 geo, vec2 dir, vec2 dv, bool full) {
  Terr T;
  vec2 uv = (dv - geo.xy) / geo.z;
  vec2 e = min(uv, 1.0 - uv);
  float fade = smoothstep(0.0, 0.14, min(e.x, e.y));
  vec2 cuv = clamp(uv, 0.0, 1.0);
  vec4 f = texBicubic(ft, cuv, vec2(FN));
  float ow = f.b * fade;
  T.oro = max(ow, 0.0);
  T.wake = max(-ow, 0.0);
  T.disp = (dir * f.r + vec2(-dir.y, dir.x) * f.g) * fade;
  T.h = 0.0;
  T.g = vec2(0.0);
  if (full) {
    vec4 t = texBicubic(tt, cuv, vec2(FN));
    T.h = max(t.r, 0.0) * fade;
    T.g = t.gb * fade;
  }
  return T;
}

Terr terrain(vec2 dv, bool full) {
  Terr T;
  T.disp = vec2(0.0); T.oro = 0.0; T.wake = 0.0; T.h = 0.0; T.g = vec2(0.0);
  if (u_hasField == 0) return T;
  T = terrOne(u_fldCur, u_terCur, u_fldCurGeo, u_fldCurDir, dv, full);
  if (u_fldMix < 0.999) {
    Terr P = terrOne(u_fldPrev, u_terPrev, u_fldPrevGeo, u_fldPrevDir, dv, full);
    T.disp = mix(P.disp, T.disp, u_fldMix);
    T.oro  = mix(P.oro,  T.oro,  u_fldMix);
    T.wake = mix(P.wake, T.wake, u_fldMix);
    T.h    = mix(P.h,    T.h,    u_fldMix);
    T.g    = mix(P.g,    T.g,    u_fldMix);
  }
  T.disp *= u_fldAmt; T.oro *= u_fldAmt; T.wake *= u_fldAmt; T.h *= u_fldAmt;
  float l = length(T.disp);
  T.disp /= (1.0 + l / max(u_dispMax, 1e-3));
  return T;
}
`;

  const FS_FIELD = GLSL_COMMON + `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;

uniform float u_lodMacro;
uniform float u_lodMid;
uniform float u_lodDet;
uniform float u_coverage;
uniform float u_density;
uniform float u_billowDetail;
uniform float u_stretch;
uniform int   u_cumulusMode;
uniform float u_clusterIsolation;
uniform float u_smoothBlend;
uniform float u_sunBlendBoost;
uniform vec4  u_mixA;
uniform vec4  u_mixB;

uniform float u_orographicLift;
uniform float u_foehnDissipation;
uniform float u_peakPiercing;
uniform float u_cloudBase;
uniform float u_cloudThickness;
uniform float u_wakeSplit;

uniform vec3  u_sunDir;
uniform float u_shadowCoverage;
uniform float u_shadowSoftness;
uniform float u_volumeDepth;
uniform float u_creviceDarkness;
uniform float u_volumeSmooth;

vec2  g_sun;
float g_zScale;
float g_kmul;
float g_t;
float g_amp;
float g_blendK;
float g_boostK;

struct Acc {
  float E;
  vec3  n;
  float sw;
  float sd;
  float sf;
  float e1, e2, R1;
};

float smax(float a, float b, float k) {
  if (k <= 1e-4) return max(a, b);
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float bump(float x, float c, float w) { return max(0.0, 1.0 - abs(x - c) / w); }

void lobe(inout Acc A, vec2 d, float R, float dens, float soft) {
  float d2 = dot(d, d);
  // Быстрое отсечение до sqrt: если d^2 > (1.8 * R)^2, то e < -0.8 * R гарантированно
  if (d2 > 3.24 * R * R) return;

  float dist = sqrt(d2);
  float e = R - dist;

  float invDist = 1.0 / max(dist, 1e-4);
  float facing = dot(d, g_sun) * invDist;
  float lit = clamp(facing * 0.5 + 0.5, 0.0, 1.0);

  float k = max(0.15, R * g_blendK * (1.0 + lit * g_boostK) * g_kmul);

  A.E = smax(A.E, e, k);
  if (e > A.e1) { A.e2 = A.e1; A.e1 = e; A.R1 = R; }
  else if (e > A.e2) { A.e2 = e; }

  float zr = sqrt(max(R * R - d2, 0.0));
  vec3 n = normalize(vec3(d, max(zr, 0.05 * R) * g_zScale));
  float localZ = zr / max(R, 1e-4);
  float lz = clamp(localZ, 0.0, 1.0);
  float w = (lz * lz) * (dens * 0.8 + 0.2);
  A.n += n * w; A.sd += dens * w; A.sf += soft * w; A.sw += w;
}

void seg(inout Acc A, vec2 aw, vec2 p0, vec2 p1, float r0, float r1, float dens, float soft) {
  vec2 ab = p1 - p0;
  float t = clamp(dot(aw - p0, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 d = aw - (p0 + ab * t);
  lobe(A, d, mix(r0, r1, t), dens, soft);
}

void chain(inout Acc A, vec2 aw, vec2 c, vec2 cs, float Lh, float kap, float Rm, int mode,
           float nz, int M, vec2 seed, float dens, float soft, float wAmp, float wFr, float wPh) {
  vec2 prevP = vec2(0.0);
  float prevR = 0.0;
  float chainWaveT = (g_amp > 0.001) ? g_t * OM(120) : 0.0;
  for (int i = 0; i <= 9; i++) {
    if (i > M) break;
    float t = float(i) / float(M) * 2.0 - 1.0;
    float sx = t * Lh;
    float sy = 0.5 * kap * sx * sx + wAmp * sin(t * wFr + wPh + chainWaveT);
    float hr = hash12(seed + float(i) * vec2(13.1, 5.7));
    float prof = (mode == 0) ? (0.72 + 0.28 * cos(t * 1.5708))
               : (mode == 1 ? mix(1.0, 0.22, smoothstep(-1.0, 1.0, t))
                            : pow(max(cos(t * 1.5708), 0.06), 0.55));
    float r = Rm * prof * (1.0 + nz * (hr - 0.5) * 2.0) * (1.0 + 0.14 * g_amp * sin(g_t * OM(150) + hr * 6.2832));
    vec2 P = c + vec2(cs.x * sx - cs.y * sy, cs.y * sx + cs.x * sy);
    if (i > 0) seg(A, aw, prevP, P, prevR, r, dens, soft);
    prevP = P; prevR = r;
  }
}

void layerA(inout Acc A, vec2 aw) {
  float W = u_W;
  float cell = W * 2.2;
  float tot0 = u_mixA.x + u_mixA.y + u_mixA.z + u_mixA.w + u_mixB.x;
  if (tot0 < 0.01) return;
  vec2 id = floor(aw / cell);
  float C = clamp(u_coverage, 0.02, 0.98);
  float g0 = mix(0.10, 0.40, u_clusterIsolation);
  float Rmul = (0.78 + 0.20 * u_density) * (u_cumulusMode == 1 ? 1.0 : 1.25);
  float lobeK = inversesqrt(max(0.4, u_billowDetail / 1.35));
  float asp = 1.0 + (u_stretch - 1.0) * 0.6;
  float sf = clamp(u_stretch / 1.45, 0.7, 1.3);
  float curl = u_mixB.w;
  float trn = u_mixB.z;
  int K = int(mix(4.0, 9.0, clamp((u_billowDetail - 0.5) / 2.0, 0.0, 1.0)));
  float maxCellDist2 = 1.69 * cell * cell;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 n = id + vec2(float(dx), float(dy));
      vec2 hj = vec2(hash12(n + 8.1), hash12(n + 1.9));
      vec2 c = (n + 0.5 + (hj - 0.5) * 0.24) * cell;
      vec2 dp = aw - c;
      if (dot(dp, dp) > maxCellDist2) continue;

      float h0 = hash12(n + 3.7);
      vec4 gt  = textureLod(u_noiseTex, c / (W * 5.5556), u_lodMacro);
      vec4 gt2 = textureLod(u_noiseTex, c / (W * 5.5556) * 0.43 + 0.37, u_lodMacro + 1.2);
      float g = smoothstep(g0, g0 + 0.40, gt.r * 0.6 + gt.g * 0.4);
      float reg = smoothstep(0.30, 0.70, gt2.a);

      float wC = u_mixA.x * (0.35 + 0.65 * bump(reg, 0.12, 0.45));
      float wR = u_mixA.y * (0.35 + 0.65 * bump(reg, 0.38, 0.35));
      float wA = u_mixA.z * (0.35 + 0.65 * bump(reg, 0.58, 0.35));
      float wS = u_mixA.w * (0.35 + 0.65 * bump(reg, 0.82, 0.35));
      float wH = u_mixB.x * (0.35 + 0.65 * bump(reg, 0.95, 0.30));
      float tot = wC + wR + wA + wS + wH + 1e-4;
      float pk = hash12(n * 1.7 + 9.1) * tot;
      int ty = (pk < wC) ? 0 : (pk < wC + wR ? 1 : (pk < wC + wR + wA ? 2 : (pk < wC + wR + wA + wS ? 3 : 4)));
      float tm = (ty == 0) ? 1.0 : (ty == 1 ? 0.8 : (ty == 2 ? 0.5 : (ty == 3 ? 0.9 : 0.5)));
      float thr = clamp(C * 2.0 * (0.25 + 1.5 * g) * tm, 0.0, 1.0);
      if (h0 > thr) continue;

      float rA = hash12(n * 2.3 + 5.5);
      float rB = hash12(n * 3.1 + 1.3);
      float rC = hash12(n * 4.7 + 7.7);
      float rD = hash12(n * 5.9 + 2.2);
      float phi = (rA - 0.5) * 0.7 + (gt2.g - 0.5) * 1.3 * curl;
      vec2 cs = vec2(cos(phi), sin(phi));
      vec2 seed = n * 1.9 + 4.4;

      if (ty == 0) {
        float R0 = (0.18 + 0.11 * rB * rB * (3.0 - 2.0 * rB)) * cell * Rmul;
        R0 *= 1.0 + 0.07 * g_amp * sin(g_t * OM(95) + rA * 6.2832);
        if (dot(dp, dp) > 4.4 * R0 * R0) continue;
        float dens = 0.85 + 0.15 * rC;
        g_kmul = 1.0;

        for (int m = 0; m < 3; m++) {
          float angM = float(m) * 2.0944 + rA * 3.14;
          float distM = (0.22 + 0.18 * hash12(n * 2.7 + float(m))) * R0;
          vec2 cOff = vec2(cos(angM) * asp, sin(angM)) * distM;
          float rCore = R0 * (0.75 + 0.20 * hash12(n * 4.1 + float(m)));
          lobe(A, dp - cOff, rCore, dens, 0.0);
        }

        for (int j = 0; j < 9; j++) {
          if (j >= K) break;
          vec2 jb = n * 1.3 + float(j) * vec2(17.3, 7.1);
          vec2 hv = vec2(hash12(jb), hash12(jb + 4.9));
          float hq = hash12(jb + 5.5);
          float hd = hash12(jb + 11.7);
          vec2 dir = normalize(hv * 2.0 - 1.0 + vec2(1e-4));
          dir.x *= asp;
          float dist = (0.40 + 0.45 * hd) * R0;
          float rc = (0.35 + 0.35 * hq) * R0 * lobeK;
          if (g_amp > 0.001) {
            float ph = hq * 6.2832 + hd * 11.0;
            float a1 = g_amp * 0.30 * sin(g_t * OM(110) + ph);
            dir = dir + vec2(-dir.y, dir.x) * a1;
            dist *= 1.0 + g_amp * 0.16 * sin(g_t * OM(140) + ph * 1.7);
            rc *= 1.0 + g_amp * 0.18 * sin(g_t * OM(170) + ph * 2.3);
          }
          lobe(A, dp - dir * dist, rc, dens * (0.9 + 0.1 * hq), 0.0);
        }
        for (int j = 0; j < 2; j++) {
          vec2 jb = n * 2.9 + float(j) * vec2(5.3, 19.1);
          float ang = hash12(jb) * 6.2832;
          float dist = (1.05 + 0.35 * hash12(jb + 2.2)) * R0;
          float rc = (0.22 + 0.18 * hash12(jb + 7.7)) * R0;
          if (hash12(jb + 1.1) < 0.6)
            lobe(A, dp - vec2(cos(ang) * asp, sin(ang)) * dist, rc, 0.55 + 0.25 * rD, 0.2);
        }
      } else if (ty == 1) {
        float Lh = min(cell * (0.30 + 0.40 * rB) * sf, 0.72 * cell);
        float Rm = cell * (0.060 + 0.050 * rC) * Rmul;
        float kapLh = (rD * 2.0 - 1.0) * 0.9 * curl;
        float kap = kapLh / Lh;
        float bnd = Lh * length(vec2(1.0, 0.5 * abs(kapLh))) + Rm * 1.8 + Rm;
        if (dot(dp, dp) > bnd * bnd) continue;
        g_kmul = 0.9;
        chain(A, aw, c, cs, Lh, kap, Rm, 0, 0.38, 5 + int(rA * 3.0), seed,
              0.80 + 0.20 * rC, 0.0, Rm * 0.5 * rB, 2.0 + 3.0 * rA, rD * 6.28);
      } else if (ty == 2) {
        float Lh = cell * (0.28 + 0.24 * rB);
        float kapLh = (rD > 0.5 ? 1.0 : -1.0) * (1.3 + 1.1 * rC) * curl;
        float kap = kapLh / Lh;
        float Rm = cell * (0.075 + 0.050 * rA) * Rmul;
        float bnd = Lh * length(vec2(1.0, 0.5 * abs(kapLh))) + Rm * 1.8;
        if (dot(dp, dp) > bnd * bnd) continue;
        g_kmul = 0.8;
        chain(A, aw, c, cs, Lh, kap, Rm, 1, 0.30, 6 + int(rB * 2.0), seed,
              0.60 + 0.30 * rC, 0.10, 0.0, 1.0, 0.0);
      } else if (ty == 3) {
        float Lh = min(cell * (0.45 + 0.35 * rB) * sf, 0.85 * cell);
        float kapLh = (rD * 2.0 - 1.0) * 1.1 * curl;
        float kap = kapLh / Lh;
        float Rm = cell * (0.022 + 0.020 * rC);
        float wAmp = Rm * (1.5 + 2.0 * rB) * curl;
        float bnd = Lh * length(vec2(1.0, 0.5 * abs(kapLh))) + wAmp + Rm * 1.8;
        if (dot(dp, dp) > bnd * bnd) continue;
        g_kmul = 0.45;
        chain(A, aw, c, cs, Lh, kap, Rm, 2, 0.55, 8, seed,
              mix(0.55, 0.22, trn) * (0.7 + 0.6 * rA), 0.55, wAmp, 2.0 + 3.0 * rA, rB * 6.28);
      } else {
        float R0 = cell * (0.22 + 0.20 * rB) * Rmul * (1.0 + 0.10 * g_amp * sin(g_t * OM(100) + rA * 6.2832));
        if (dot(dp, dp) > 4.0 * R0 * R0) continue;
        float dens = mix(0.45, 0.15, trn) * (0.7 + 0.6 * rC);
        g_kmul = 2.2;
        lobe(A, dp, R0, dens, 1.0);
        for (int j = 0; j < 2; j++) {
          float ang = hash12(n + float(j) * 7.3) * 6.2832;
          lobe(A, dp - vec2(cos(ang) * asp, sin(ang)) * R0 * 0.75, R0 * 0.62, dens, 1.0);
        }
      }
    }
  }
}

void layerB(inout Acc A, vec2 aw) {
  if (u_mixB.y < 0.01) return;
  float W = u_W;
  float cell = W * 0.75;
  vec2 id = floor(aw / cell);
  float C = clamp(u_coverage, 0.02, 0.98);
  float g0 = mix(0.10, 0.40, u_clusterIsolation) * 0.6;
  float trn = u_mixB.z;
  float asp = 1.0 + (u_stretch - 1.0) * 0.6;
  float maxCellDistB = 0.49 * cell * cell;
  g_kmul = 0.8;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 n = id + vec2(float(dx), float(dy));
      vec2 hj = vec2(hash12(n + 18.1), hash12(n + 11.9));
      vec2 c = (n + 0.5 + (hj - 0.5) * 0.7) * cell;
      vec2 dp = aw - c;
      if (dot(dp, dp) > maxCellDistB) continue;
      float pres = hash12(n + 13.3);
      vec4 gt = textureLod(u_noiseTex, c / (W * 5.5556) + 0.19, u_lodMacro);
      float g = smoothstep(g0, g0 + 0.5, gt.r * 0.6 + gt.g * 0.4);
      float thr = clamp(C * 1.6 * (0.15 + 1.5 * g) * u_mixB.y, 0.0, 1.0);
      if (pres > thr) continue;
      float rA = hash12(n * 2.1 + 3.3), rB = hash12(n * 3.7 + 6.1);
      float rC = hash12(n * 4.3 + 1.7), rD = hash12(n * 5.1 + 9.9);
      float R = cell * (0.09 + 0.12 * rB * rB) * (1.0 + 0.12 * g_amp * sin(g_t * OM(130) + rD * 6.2832));
      float dens = (0.35 + 0.45 * rC) * mix(1.0, 0.7, trn);
      float soft = 0.25 + 0.5 * rD;
      lobe(A, dp, R, dens, soft);
      int nch = int(rA * 3.0);
      for (int j = 0; j < 2; j++) {
        if (j >= nch) break;
        float ang = hash12(n * 1.3 + float(j) * 9.7) * 6.2832;
        float dist = (0.6 + 0.4 * hash12(n + float(j) * 3.1)) * R;
        lobe(A, dp - vec2(cos(ang) * asp, sin(ang)) * dist, R * (0.4 + 0.2 * rD), dens, soft);
      }
    }
  }
}

void main() {
  float W = u_W;
  vec2 dv = (v_uv - 0.5) * u_kmSize;
  Terr T = terrain(dv, true);
  vec2 pRel = dv + T.disp;
  vec2 pp = u_ppC + u_patRot * pRel;

  g_sun = normalize(u_patRot * u_sunDir.xy + vec2(1e-4));
  g_zScale = 1.0 / max(0.35, u_volumeDepth * 0.75);
  g_kmul = 1.0;
  g_t = u_anim.x;
  g_amp = u_anim.y;
  g_blendK = clamp(u_smoothBlend * 0.08, 0.04, 0.45);
  g_boostK = clamp(u_sunBlendBoost * 0.04, 0.0, 0.40);

  vec4 nM = textureLod(u_noiseTex, pp / (W * 5.5556), u_lodMacro);
  vec4 nF = textureLod(u_noiseTex, pp / (W * 1.7) + 0.31, u_lodMid);
  vec2 aw = pp + (vec2(nM.g, nM.a) - 0.5) * (W * (0.28 + 0.30 * u_mixB.w))
               + (vec2(nF.r, nF.a) - 0.5) * (W * 0.10);
  if (u_anim.z > 0.001) {
    float tn = u_anim.x * (1.0 / 4096.0);
    vec4 w1 = textureLod(u_noiseTex, pp / (W * 2.1) + vec2(10.0, 7.0) * tn, u_lodMid);
    vec4 w2 = textureLod(u_noiseTex, pp / (W * 1.2) + vec2(-8.0, 12.0) * tn + 0.6, u_lodDet);
    aw += ((vec2(w1.r, w1.g) - 0.5) * (W * 0.16) + (vec2(w2.g, w2.a) - 0.5) * (W * 0.07)) * u_anim.z;
  }

  Acc A;
  A.E = -1000.0; A.n = vec3(0.0); A.sw = 0.0; A.sd = 0.0; A.sf = 0.0;
  A.e1 = -1000.0; A.e2 = -1000.0; A.R1 = 1.0;
  layerA(A, aw);
  layerB(A, aw);

  float E = A.E;
  vec3 nrm = vec3(0.0, 0.0, 1.0);
  float dens = 0.0, soft = 0.0;
  if (A.sw > 1e-4) {
    nrm = normalize(A.n / A.sw);
    dens = A.sd / A.sw;
    soft = A.sf / A.sw;
  }
  float crev = 0.0;
  if (A.e1 > 0.0 && A.e2 > 0.0) crev = smoothstep(0.18 * A.R1, 0.0, A.e1 - A.e2);

  float rim = 0.0;
  if (u_hasField == 1) {
    float base = u_cloudBase;
    float thick = max(0.2, u_cloudThickness);

    E += T.oro * u_orographicLift * 0.20 * W;
    dens = min(1.0, dens + T.oro * 0.25 * u_orographicLift);

    float L = base + thick * (1.0 - 0.9 * clamp(u_peakPiercing, 0.0, 1.5));
    float gl = max(length(T.g), 0.05);
    float q = (L - T.h) / gl;
    if (u_orographicLift > 0.02 && T.oro > 0.08) {
      float cw = smoothstep(0.08, 0.45, T.oro) * min(u_orographicLift, 1.0);
      float col = (0.10 * W - abs(q - 0.16 * W)) * cw - (1.0 - cw) * W;
      E = smax(E, col, 0.05 * W);
      dens = max(dens, 0.5 * cw * smoothstep(-0.02 * W, 0.03 * W, col));
    }

    vec4 ns = textureLod(u_noiseTex, vec2(pp.x * 0.22, pp.y * 1.2) / (W * 2.8), u_lodMacro + 0.5);
    float tearA = smoothstep(0.05, 0.85, T.wake) * u_wakeSplit * (1.0 + 0.5 * u_foehnDissipation);
    E -= tearA * W * (0.08 + 0.45 * smoothstep(0.35, 0.75, ns.r));
    dens *= 1.0 - u_foehnDissipation * smoothstep(0.1, 1.0, T.wake) * 0.5;
    rim += smoothstep(0.1, 0.7, T.wake) * (1.0 - smoothstep(0.0, 0.05 * W, abs(E))) * 0.6;

    if (u_peakPiercing > 0.02) {
      float holeE = clamp(q, -0.8 * W, 0.8 * W);
      float nr = textureLod(u_noiseTex, pp / (W * 0.9), u_lodDet).r - 0.5;
      holeE += nr * W * 0.18;
      float kh = 0.10 * W;
      float Ecut = -smax(-E, -holeE, kh);
      float cutW = smoothstep(0.0, 0.10 * W, E - holeE);
      rim = max(rim, cutW * (1.0 - smoothstep(0.0, 0.07 * W, abs(Ecut))));
      dens *= 1.0 - 0.65 * smoothstep(L - 0.9 * thick, L, T.h);
      E = Ecut;
    }
  }
  float Er = u_Er;
  E = clamp(E, -Er, Er);

  vec3 Ld = normalize(vec3(u_patRot * u_sunDir.xy, max(0.02, u_sunDir.z)));
  float NdotL = dot(nrm, Ld);

  float lowSunBias = (1.0 - smoothstep(0.04, 0.35, u_sunDir.z)) * 0.42;
  float shadowBias = (u_shadowCoverage - 0.5) * 1.1 + lowSunBias;

  float lightDiff = NdotL - shadowBias - crev * (u_creviceDarkness * 0.45);
  float sSoft = u_shadowSoftness + clamp(u_volumeSmooth, 0.0, 1.5) * 0.30;
  float litW = smoothstep(-sSoft, sSoft, lightDiff);
  float shade = clamp(1.0 - litW, 0.0, 1.0);

  float dmask = darkMask(pp);
  shade = clamp(shade + dmask * u_dark.y * 0.85, 0.0, 1.0);

  o0 = vec4(E / Er * 0.5 + 0.5, clamp(dens, 0.0, 1.0), crev, clamp(rim, 0.0, 1.0));
  o1 = vec4(nrm.xy * 0.5 + 0.5, shade, clamp(soft, 0.0, 1.0));
}`;

  const FS_COMP = GLSL_COMMON + `
out vec4 fragColor;

uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform vec2  u_fSize;
uniform float u_kmPerPx;
uniform float u_pxScale;
uniform float u_lodRag;
uniform float u_ragged;

uniform int   u_hatchStyle;
uniform float u_hatchCurvature;
uniform float u_hatchThickness;
uniform float u_hatchLength;
uniform float u_hatchThinning;
uniform float u_hatchLight;
uniform float u_creaseOutlines;
uniform float u_creaseBlur;
uniform float u_hatchSp;
uniform float u_hatchAA;
uniform vec2  u_hatchOrg;

uniform vec3  u_lightTint;
uniform vec3  u_bodyColor;
uniform vec3  u_inkColor;
uniform vec3  u_outlineColor;
uniform float u_opacity;
uniform float u_inkOpacity;
uniform float u_outlineWidth;
uniform float u_shadowOpacity;
uniform vec2  u_shadowOff;
uniform float u_globalFade;
uniform float u_paperShading;
uniform float u_grain;

uniform vec3  u_shadowTint;
uniform float u_sunIntensity;
uniform vec3  u_sunDir;
uniform vec3  u_skyTint;
uniform vec3  u_glowColor;
uniform vec3  u_twilightRimColor;
uniform vec3  u_valleyColor;
uniform float u_twilightAmt;

uniform float u_atmTintStrength;
uniform float u_sunsetWarmth;
uniform float u_shadowBrightness;
uniform float u_shadowColorSat;
uniform float u_bodyColorInfluence;
uniform float u_cloudBrightness;
uniform float u_cloudContrast;
uniform float u_cloudTempLight;
uniform float u_cloudTempShadow;
uniform float u_shadowBlur;

uniform float u_paperGrainScale;
uniform float u_paperGrainContrast;

float hatchInk(vec2 pRel, vec2 dispv, float shadeP, float dk, vec2 ppCloud, float crevFactor) {
  if (shadeP < 0.05 && u_hatchLight < 0.01 && crevFactor < 0.05) return 0.0;
  float sp = u_hatchSp;
  vec2 hq = u_hatchOrg + (u_patRot * pRel) / sp;
  vec2 hid = floor(hq);
  float aa = u_hatchAA;
  float res = 0.0;
  mat2 Rinv = transpose(u_patRot);

  float crv = smoothstep(0.25, 0.85, crevFactor) * clamp(u_creaseOutlines, 0.0, 1.5);
  float gSc = max(0.1, u_paperGrainScale);
  vec2 paperCoord = (ppCloud / sp) / (4.5 * gSc);
  vec4 pNz = textureLod(u_noiseTex, paperCoord, 0.0);
  float paperTooth = (pNz.b * 0.65 + pNz.r * 0.35 - 0.5) * u_paperGrainContrast;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = hid + vec2(float(i), float(j));
      vec2 idw = mod(id, 4096.0);

      if (u_hatchThinning > 0.001) {
        float dropRand = hash12(idw * 3.71 + vec2(19.3, 41.7));
        if (dropRand < u_hatchThinning * (1.0 - crv * 0.75)) continue;
      }

      vec2 rn = vec2(hash12(idw * 1.37 + vec2(3.1, 7.7)), hash12(idw * 2.11 + vec2(9.3, 1.9)));
      float rt = hash12(idw * 0.77 + vec2(5.3, 2.9));
      vec2 cq = id + 0.5 + (rn - 0.5) * 0.55;

      vec2 relC = (cq - u_hatchOrg) * sp;
      vec2 dvC = Rinv * relC - dispv;
      vec4 tc = textureLod(u_tex1, dvC / u_kmSize + 0.5, 0.0);
      float sh = tc.z;

      float thr = 0.08 + 0.64 * rt;
      float lightPres = 0.0;
      if (u_hatchLight > 0.001) {
        lightPres = u_hatchLight * smoothstep(0.30, 0.95, hash12(idw * 4.19 + vec2(7.3, 13.1)));
        thr -= lightPres * 0.45;
      }

      float bo = u_anim.w;
      vec2 sc = vec2(0.0);
      if (bo > 0.001) {
        sc = vec2(sin(u_anim.x * OM(260) + rt * 40.0 + idw.x * 0.37),
                  cos(u_anim.x * OM(210) + rt * 23.0 + idw.y * 0.53));
        thr += bo * 0.10 * sc.x;
      }

      thr -= dk * 0.12 + crv * 0.35;
      if (sh < thr && crv < 0.1) continue;

      vec2 n2 = tc.xy * 2.0 - 1.0;
      float nl = length(n2);
      vec2 tang = (nl > 0.06) ? vec2(-n2.y, n2.x) / nl : vec2(1.0, 0.0);
      if (dot(tang, vec2(0.94, 0.34)) < 0.0) tang = -tang;
      vec2 dir = tang;
      if (u_hatchStyle == 1) {
        dir = normalize(mix(vec2(1.0, 0.0), tang, clamp(u_hatchCurvature * 0.45, 0.0, 1.0)) + vec2(1e-4));
      } else if (u_hatchStyle == 0) {
        dir = normalize(tang + vec2(0.15, 0.0) * (1.0 - nl));
      }
      if (bo > 0.001) dir = normalize(dir + vec2(-dir.y, dir.x) * (bo * 0.14 * sc.y));
      vec2 perpd = vec2(-dir.y, dir.x);
      vec2 p0 = hq - cq - bo * 0.06 * vec2(sc.y, sc.x);
      float al = dot(p0, dir);
      float pe = dot(p0, perpd);

      float localTone = clamp(mix(sh, shadeP, 0.55) + crv * 0.55, 0.0, 1.0);
      localTone = max(localTone, lightPres * 0.35);
      float pres = smoothstep(thr, thr + 0.50, localTone);

      float lenMul = max(0.2, u_hatchLength);
      float baseHl = (0.50 + 0.60 * smoothstep(thr, thr + 0.35, localTone)) * (0.85 + 0.35 * rt) * lenMul;
      float hl = max(0.05, min(8.0, baseHl * (0.15 + 0.85 * pres)));

      float bendS = (dot(perpd, n2) <= 0.0) ? 1.0 : -1.0;
      float k = 0.28 * u_hatchCurvature * (0.4 + 0.6 * nl);
      float peB = pe - bendS * k * al * al;
      float tt = al / hl;

      float inkTooth = paperTooth * (0.04 * (1.0 + u_grain));
      float peTooth = peB + inkTooth;

      if (abs(tt) < 1.0) {
        float toneWidth = pow(pres, 0.65) * (0.35 + 0.65 * smoothstep(0.1, 0.85, localTone));
        float strokeEnvelope = 1.0 - pow(abs(tt), 2.2);
        float w = 0.20 * u_hatchThickness * (1.0 + 0.5 * dk + crv * 0.65) * toneWidth * strokeEnvelope;

        float stipple = 1.0;
        if (w < 0.055 && u_grain > 0.01) {
          float stippleFreq = 22.0 + rt * 10.0;
          float dotWave = sin(al * stippleFreq) * 0.5 + 0.5;
          dotWave += paperTooth * 1.5;
          stipple = smoothstep(0.42, 0.68, dotWave);
        }

        float m = (1.0 - smoothstep(w - aa, w + aa, abs(peTooth)))
                * (1.0 - smoothstep(0.82, 1.0, abs(tt)))
                * stipple;
        res = max(res, m);
      }

      if (u_hatchStyle == 2 && localTone > 0.55) {
        if (rt > 0.38) {
          float al2 = dot(p0, perpd);
          float pe2 = dot(p0, dir) + inkTooth;
          float tt2 = al2 / (hl * 0.72);
          if (abs(tt2) < 1.0) {
            float w2 = 0.16 * u_hatchThickness * (1.0 + crv * 0.5) * (1.0 - (tt2 * tt2)) * pres;
            float m2 = (1.0 - smoothstep(w2 - aa, w2 + aa, abs(pe2))) * (1.0 - smoothstep(0.80, 1.0, abs(tt2)));
            res = max(res, m2 * smoothstep(0.55, 0.88, localTone));
          }
        }
      }
    }
  }
  return clamp(res, 0.0, 1.0);
}

void main() {
  float W = u_W;
  vec2 dv = (v_uv - 0.5) * u_kmSize;

  vec4 t0 = texBicubic(u_tex0, v_uv, u_fSize);
  vec4 t1 = textureLod(u_tex1, v_uv, 0.0);
  float E = (t0.x * 2.0 - 1.0) * u_Er;
  float dens = t0.y;
  float crev = t0.z;
  float rim  = t0.w;
  float shade = t1.z;
  float soft  = t1.w;

  Terr T = terrain(dv, false);
  vec2 pRel = dv + T.disp;
  vec2 pp = u_ppC + u_patRot * pRel;
  float dk = darkMask(pp) * u_dark.y;

  vec4 nz = textureLod(u_noiseTex, pp / (W * 0.55) + vec2(16.0, -11.0) * (u_anim.x * (1.0 / 4096.0)) * step(0.001, u_anim.z), u_lodRag);
  float nrag = mix(nz.r, nz.b, 0.5) - 0.5;
  float amp = W * 0.015 * clamp(abs(u_ragged) * 0.5, 0.0, 1.5) * (0.4 + 0.6 * dens)
            * (1.0 - smoothstep(0.8, 2.5, u_lodRag)) * (1.0 - soft * 0.6);
  E += nrag * amp;

  vec2 dE = vec2(dFdx(E), dFdy(E));
  float gradE = max(length(dE), 1e-5);
  float distPx = abs(E) / gradE;

  float sunSkylight = clamp(u_sunIntensity * 0.75 + 0.25, 0.0, 1.0);
  vec3 inkDynamicColor = mix(u_shadowTint * 0.40, u_inkColor, sunSkylight);
  vec3 outlineDynamicColor = mix(u_shadowTint * 0.40, u_outlineColor, sunSkylight);

  float shadowA = 0.0;
  if (u_shadowOpacity > 0.01) {
    vec2 baseUv = v_uv + u_shadowOff;
    if (u_shadowBlur > 0.05) {
      vec2 bStep = (u_shadowBlur * 0.75) / u_fSize;
      vec4 ts0 = textureLod(u_tex0, baseUv, 0.0);
      vec4 ts1 = textureLod(u_tex0, baseUv + vec2( bStep.x,  bStep.y), 0.0);
      vec4 ts2 = textureLod(u_tex0, baseUv + vec2(-bStep.x,  bStep.y), 0.0);
      vec4 ts3 = textureLod(u_tex0, baseUv + vec2(-bStep.x, -bStep.y), 0.0);
      vec4 ts4 = textureLod(u_tex0, baseUv + vec2( bStep.x, -bStep.y), 0.0);

      float es0 = (ts0.x * 2.0 - 1.0) * u_Er;
      float es1 = (ts1.x * 2.0 - 1.0) * u_Er;
      float es2 = (ts2.x * 2.0 - 1.0) * u_Er;
      float es3 = (ts3.x * 2.0 - 1.0) * u_Er;
      float es4 = (ts4.x * 2.0 - 1.0) * u_Er;

      float a0 = smoothstep(-0.02 * W, 0.05 * W, es0);
      float a1 = smoothstep(-0.02 * W, 0.05 * W, es1);
      float a2 = smoothstep(-0.02 * W, 0.05 * W, es2);
      float a3 = smoothstep(-0.02 * W, 0.05 * W, es3);
      float a4 = smoothstep(-0.02 * W, 0.05 * W, es4);

      shadowA = (a0 * 0.36 + (a1 + a2 + a3 + a4) * 0.16) * u_shadowOpacity;
    } else {
      vec4 ts = textureLod(u_tex0, baseUv, 0.0);
      float Es = (ts.x * 2.0 - 1.0) * u_Er;
      shadowA = smoothstep(-0.02 * W, 0.05 * W, Es) * u_shadowOpacity;
    }
  }
  float shadowSunFade = smoothstep(0.03, 0.28, u_sunIntensity);
  vec4 shPm = vec4(inkDynamicColor * 0.40 * shadowA * shadowSunFade, shadowA * shadowSunFade);

  float band = max(gradE * 0.5, soft * 0.08 * W);
  float cov = smoothstep(-band, band, E);
  float densMask = smoothstep(0.06, 0.32, dens);

  float hatch = 0.0, crease = 0.0;
  if (cov > 0.005) {
    float hatchDensFade = smoothstep(0.08, 0.40, dens);
    if (hatchDensFade > 0.001) {
      hatch = hatchInk(pRel, T.disp, shade, dk, pp, crev) * cov * hatchDensFade;
    }

    float cBlur = max(0.02, u_creaseBlur);
    float cMin = clamp(0.35 - cBlur * 0.25, 0.03, 0.45);
    float cMax = clamp(0.75 + cBlur * 0.50, cMin + 0.12, 1.80);
    float crevSmooth = smoothstep(cMin, cMax, crev);
    crevSmooth = mix(crevSmooth, pow(clamp(crev, 0.0, 1.0), 1.0 / (1.0 + cBlur * 1.8)), clamp(cBlur * 0.65, 0.0, 1.0));

    crease = crevSmooth * clamp(shade * 1.35 + 0.1, 0.0, 1.0)
             * clamp(u_creaseOutlines * 1.2, 0.0, 1.5) * cov * densMask;
  }

  float lightWeight = mix(0.28, 1.65, smoothstep(0.12, 0.85, shade));
  float wpx = u_outlineWidth * u_pxScale * lightWeight * (1.0 + rim * 0.4) * (1.0 + 0.25 * clamp(dk, 0.0, 1.0));

  float outerInk = (1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, distPx)) * densMask;

  float thin = 1.0 - smoothstep(0.12, 0.65, dens);
  float paperWarmthFade = (1.0 - clamp(u_twilightAmt * 0.85, 0.0, 0.85)) * (1.0 - thin * 0.85);
  vec3 baseCanvas = mix(vec3(1.0), u_bodyColor, u_bodyColorInfluence * 0.25 * paperWarmthFade);

  float nightFactor = 1.0 - smoothstep(0.02, 0.25, u_sunIntensity);
  vec3 directSkyLight = mix(u_lightTint, u_skyTint, 0.18);
  float nightLuma = dot(directSkyLight, vec3(0.299, 0.587, 0.114));
  vec3 effectiveLightColor = mix(directSkyLight, vec3(nightLuma * 1.4), nightFactor * 0.75);

  float safeAtm = clamp(u_atmTintStrength, 0.0, 1.0);
  vec3 colLight = mix(baseCanvas, baseCanvas * effectiveLightColor, safeAtm);
  colLight = mix(colLight, colLight * clamp(u_sunIntensity * 0.7 + 0.3, 0.0, 1.0), nightFactor);

  if (u_twilightAmt > 0.01) {
    vec3 sunsetGlow = mix(u_glowColor, u_twilightRimColor, 0.65);
    float sunsetInfluence = clamp(u_twilightAmt * u_sunsetWarmth * 0.90, 0.0, 1.0);
    colLight = mix(colLight, sunsetGlow, sunsetInfluence);
  }

  vec3 shadowAtmosphere = mix(u_shadowTint, u_valleyColor, clamp(u_twilightAmt * 1.3, 0.0, 1.0));
  float shaLuma = dot(shadowAtmosphere, vec3(0.299, 0.587, 0.114));
  shadowAtmosphere = mix(vec3(shaLuma), shadowAtmosphere, u_shadowColorSat * (1.0 - nightFactor * 0.5));

  vec3 shadowBase = mix(vec3(1.0), baseCanvas, 0.25);
  vec3 colSha = shadowBase * shadowAtmosphere * (u_shadowBrightness * 0.95);

  vec3 skyAtmosphere = mix(vec3(0.95), effectiveLightColor * 1.1, safeAtm);
  vec3 colMid = mix(colLight * 0.50 + skyAtmosphere * 0.50, colSha, 0.45);

  vec2 nrm2D = t1.xy * 2.0 - 1.0;
  float groundFacing = clamp(-nrm2D.y * 0.65 + 0.35, 0.0, 1.0);
  vec3 groundReflectColor = mix(u_lightTint, u_twilightRimColor, u_twilightAmt * 0.75);
  vec3 bounceLight = groundReflectColor * (groundFacing * 0.32 * u_sunIntensity);
  colSha += bounceLight;

  float lightMask  = 1.0 - smoothstep(0.08, 0.42, shade);
  float shadowMask = smoothstep(0.42, 0.85, shade);
  float midMask    = clamp(1.0 - lightMask - shadowMask, 0.0, 1.0);

  vec3 paper = colLight * lightMask + colMid * midMask + colSha * shadowMask;

  vec3 coldBurgundy = mix(u_twilightRimColor * 0.80, u_valleyColor * 1.15, 0.45);
  float bLuma = dot(coldBurgundy, vec3(0.299, 0.587, 0.114));
  coldBurgundy = mix(vec3(bLuma * 0.9), coldBurgundy, 0.70);

  float burgShift = thin * clamp(u_twilightAmt * 0.85, 0.0, 0.85);
  paper = mix(paper, coldBurgundy, burgShift);
  paper = mix(paper, paper * vec3(0.78, 0.82, 0.94), clamp(dk, 0.0, 1.0));

  if (u_paperShading > 0.001 || u_creaseBlur > 0.02) {
    float creaseSoftTuning = smoothstep(0.10, 0.85, crev) * u_creaseBlur * 0.75;
    float shadeFactor = clamp(smoothstep(0.10, 0.85, shade) + creaseSoftTuning, 0.0, 1.0);
    vec3 pencilTone = mix(paper, inkDynamicColor * 0.72, 0.48);
    float totalShadingStrength = max(u_paperShading, u_creaseBlur * 0.45);
    paper = mix(paper, pencilTone, shadeFactor * totalShadingStrength * 0.55);
  }

  if (u_grain > 0.001) {
    float gScale = max(0.1, u_paperGrainScale);
    vec2 grainCoord = (pp / u_hatchSp) / (5.0 * gScale);
    float rawGrn1 = texture(u_noiseTex, grainCoord).b;
    float rawGrn2 = texture(u_noiseTex, grainCoord * 2.85 + vec2(0.37, 0.71)).r;

    float grn = (rawGrn1 * 0.62 + rawGrn2 * 0.38) - 0.5;
    grn *= u_paperGrainContrast * 1.8;
    grn = clamp(grn, -0.85, 0.85);

    float grainSens = mix(0.70, 1.30, smoothstep(0.08, 0.70, shade));
    paper *= clamp(1.0 - grn * (u_grain * 0.45 * grainSens), 0.0, 2.0);
  }

  float backlight = clamp(dot(-normalize(pRel + 1e-4), u_sunDir.xy) * 0.5 + 0.5, 0.0, 1.0);
  float rimGlow = (1.0 - smoothstep(0.0, 0.15 * W, abs(E))) * backlight
                * (1.0 - smoothstep(0.0, 0.35, u_sunDir.z))
                * (1.0 - thin * 0.85);

  vec3 rimTone = (u_twilightAmt > 0.05) ? mix(colLight, u_twilightRimColor * 1.3, u_twilightAmt) : colLight;
  paper += rimTone * (rimGlow * 0.65);

  vec3 tLight = (u_cloudTempLight >= 0.0)
    ? vec3(1.0 + u_cloudTempLight * 0.24, 1.0 + u_cloudTempLight * 0.08, 1.0 - u_cloudTempLight * 0.28)
    : vec3(1.0 + u_cloudTempLight * 0.26, 1.0 + u_cloudTempLight * 0.10, 1.0 - u_cloudTempLight * 0.38);

  vec3 tShadow = (u_cloudTempShadow >= 0.0)
    ? vec3(1.0 + u_cloudTempShadow * 0.24, 1.0 + u_cloudTempShadow * 0.08, 1.0 - u_cloudTempShadow * 0.28)
    : vec3(1.0 + u_cloudTempShadow * 0.26, 1.0 + u_cloudTempShadow * 0.10, 1.0 - u_cloudTempShadow * 0.38);

  vec3 tempFilter = mix(tLight, tShadow, smoothstep(0.15, 0.75, shade));
  paper *= tempFilter;
  paper *= u_cloudBrightness;
  paper = clamp((paper - 0.5) * u_cloudContrast + 0.5, 0.0, 1.5);

  float innerInk = max(hatch, crease) * u_inkOpacity;
  float outInk = outerInk * u_inkOpacity;
  float inkTotal = clamp(max(outInk, innerInk), 0.0, 1.0);

  float bodyA = cov * u_opacity * densMask;

  vec3 rgb = mix(paper, inkDynamicColor, innerInk);
  rgb = mix(rgb, outlineDynamicColor, outInk);

  float a = clamp(max(bodyA, inkTotal), 0.0, 1.0) * u_globalFade;
  vec4 cloudPm = vec4(rgb * a, a);
  vec4 outc = cloudPm + (shPm * u_globalFade) * (1.0 - a);

  if (outc.a < 0.005) discard;
  fragColor = outc;
}`;

  const sky = {
    dir: [0.55, 0.45, 0.70],
    tint: [1, 1, 1],
    shadowTint: [0.28, 0.32, 0.41],
    skyColor: [0.45, 0.55, 0.70],
    glowColor: [1.0, 0.45, 0.30],
    rimColor: [0.85, 0.25, 0.15],
    valleyColor: [0.15, 0.12, 0.30],
    alpenglowWeight: 0.0,
    twilightAmt: 0.0,
    sunIntensity: 1.0,
    day: 1
  };
  let lastLightT = 0;

  function updateLighting(lat, lng, t) {
    if (t - lastLightT < 16) return;
    lastLightT = t;

    const dem = WM.demRelief;
    if (dem && typeof dem.getLighting === 'function') {
      try {
        const L = dem.getLighting(lat, lng);
        if (L && L.sunVec) {
          const rawVx = L.sunVec[0];
          const rawVy = -L.sunVec[1];
          const rawVz = L.sunVec[2];

          const realAltDeg = Math.asin(clamp(rawVz, -1.0, 1.0)) * (180 / Math.PI);

          let effAltDeg;
          if (realAltDeg >= 20.0) {
            const norm = (realAltDeg - 20.0) / 70.0;
            effAltDeg = 3.5 + 17.5 * Math.pow(norm, 0.82);
          } else if (realAltDeg >= 0.0) {
            const norm = realAltDeg / 20.0;
            effAltDeg = 0.8 + 2.7 * Math.pow(norm, 1.15);
          } else {
            effAltDeg = Math.max(0.1, 0.8 + realAltDeg * 0.06);
          }

          const horLen = Math.hypot(rawVx, rawVy) || 1.0;
          const effAltRad = (effAltDeg * Math.PI) / 180;
          const cosEff = Math.cos(effAltRad);

          sky.dir = [
            (rawVx / horLen) * cosEff,
            (rawVy / horLen) * cosEff,
            Math.sin(effAltRad)
          ];

          const k = L.sunIntensity !== undefined ? L.sunIntensity : 1.0;
          sky.sunIntensity = k;
          sky.day = smooth01((k - 0.20) / 0.60);

          let faceCol = L.lightColor || [1, 1, 1];
          if (L.twilightAmt > 0.01) {
            const rimCol = L.twilightRimColor || [0.9, 0.25, 0.15];
            const glowCol = L.glowColor || [1.0, 0.45, 0.25];
            const sunsetTarget = [
              glowCol[0] * 0.4 + rimCol[0] * 0.6,
              glowCol[1] * 0.4 + rimCol[1] * 0.6,
              glowCol[2] * 0.4 + rimCol[2] * 0.6
            ];
            const twFactor = Math.min(1.0, L.twilightAmt * 1.25);
            faceCol = [
              faceCol[0] * (1.0 - twFactor) + sunsetTarget[0] * twFactor,
              faceCol[1] * (1.0 - twFactor) + sunsetTarget[1] * twFactor,
              faceCol[2] * (1.0 - twFactor) + sunsetTarget[2] * twFactor
            ];
          }

          sky.tint = faceCol;
          sky.shadowTint = L.shadowColor || [0.2, 0.25, 0.35];
          sky.skyColor = L.skyColor || [0.4, 0.5, 0.7];
          sky.glowColor = L.glowColor || [1.0, 0.45, 0.25];
          sky.rimColor = L.twilightRimColor || [0.9, 0.25, 0.15];
          sky.valleyColor = L.valleyColor || [0.15, 0.12, 0.30];
          sky.alpenglowWeight = L.alpenglowWeight || 0.0;
          sky.twilightAmt = L.twilightAmt || 0.0;
          return;
        }
      } catch (e) {}
    }

    if (window.SunCalc) {
      const now = new Date();
      const sp = SunCalc.getPosition(now, lat, lng);
      const az = sp.azimuth + Math.PI;
      const altDeg = sp.altitude * (180 / Math.PI);

      const effAltDeg = altDeg >= 20.0
        ? 3.5 + 17.5 * Math.pow((altDeg - 20.0) / 70.0, 0.82)
        : (altDeg >= 0.0 ? 0.8 + 2.7 * Math.pow(altDeg / 20.0, 1.15) : Math.max(0.1, 0.8 + altDeg * 0.06));

      const effAltRad = (effAltDeg * Math.PI) / 180;
      sky.dir = [Math.sin(az) * Math.cos(effAltRad), Math.cos(az) * Math.cos(effAltRad), Math.sin(effAltRad)];

      const sunInt = smooth01((altDeg + 6.0) / 16.0);
      sky.sunIntensity = sunInt;
      sky.day = smooth01(altDeg / 10.0);

      const isTwilight = altDeg >= -10.0 && altDeg <= 8.0;
      if (isTwilight) {
        const tw = 1.0 - Math.min(1.0, Math.abs(altDeg) / 8.0);
        sky.twilightAmt = tw;
        sky.alpenglowWeight = smooth01((altDeg + 2.0) / 5.0) * (1.0 - smooth01((altDeg - 3.0) / 4.0));
        sky.tint = [lerp(1.0, 1.0, tw), lerp(1.0, 0.58, tw), lerp(1.0, 0.25, tw)];
        sky.glowColor = [1.0, 0.40, 0.28];
        sky.rimColor = [0.85, 0.18, 0.15];
        sky.shadowTint = [lerp(0.28, 0.16, tw), lerp(0.32, 0.15, tw), lerp(0.41, 0.38, tw)];
        sky.valleyColor = [0.14, 0.12, 0.32];
        sky.skyColor = [0.35, 0.40, 0.65];
      } else if (altDeg < -10.0) {
        sky.twilightAmt = 0.0;
        sky.alpenglowWeight = 0.0;
        sky.tint = [0.45, 0.55, 0.80];
        sky.shadowTint = [0.08, 0.10, 0.22];
        sky.valleyColor = [0.08, 0.09, 0.20];
        sky.skyColor = [0.10, 0.14, 0.28];
        sky.glowColor = [0.5, 0.5, 0.6];
        sky.rimColor = [0.3, 0.3, 0.4];
      } else {
        sky.twilightAmt = 0.0;
        sky.alpenglowWeight = 0.0;
        sky.tint = [1.0, 0.98, 0.94];
        sky.shadowTint = [0.28, 0.32, 0.41];
        sky.valleyColor = [0.22, 0.25, 0.35];
        sky.skyColor = [0.45, 0.58, 0.75];
        sky.glowColor = [1.0, 0.85, 0.65];
        sky.rimColor = [1.0, 0.80, 0.60];
      }
    }
  }

  const wind = {
    dir: 196, speed: 16.0, sp: 16.0,
    tx: 0.866, ty: 0.5,
    ux: 0.866, uy: 0.5,
    offX: 0, offY: 0, kmPerS: 0,
    cloudCover: null, label: 'прогноз…',
    fetchedAt: 0, fetchLat: null, fetchLng: null, inflight: false,
    initialized: false
  };
  const pat = { theta: 0 };

  function setWindTarget(dirDeg, speedMs) {
    wind.dir = dirDeg; wind.speed = speedMs;
    const rad = (dirDeg + 180) * (Math.PI / 180);
    wind.tx = Math.sin(rad); wind.ty = Math.cos(rad);
    if (!wind.initialized) {
      wind.ux = wind.tx; wind.uy = wind.ty; wind.sp = speedMs;
      pat.theta = Math.atan2(wind.ty, wind.tx);
      wind.initialized = true;
    }
  }

  async function fetchForecastWind(lat, lng) {
    if (wind.inflight) return;
    const now = Date.now();
    const age = now - wind.fetchedAt;
    const moved = wind.fetchLat !== null &&
      (Math.abs(lat - wind.fetchLat) > 1.0 ||
       Math.abs(lng - wind.fetchLng) * Math.cos(lat * Math.PI / 180) > 1.0);
    if (age < (moved ? 8e3 : 15 * 60e3)) return;
    wind.inflight = true;
    wind.fetchLat = lat; wind.fetchLng = lng;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&current=wind_speed_10m,wind_direction_10m,cloud_cover&wind_speed_unit=ms`;
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || !j.current) throw new Error('empty');
      const d = +j.current.wind_direction_10m, sp = +j.current.wind_speed_10m;
      if (!isFinite(d) || !isFinite(sp)) throw new Error('bad wind');
      wind.cloudCover = j.current.cloud_cover != null ? +j.current.cloud_cover : null;
      wind.fetchedAt = now;
      wind.label = `${Math.round(d)}° · ${sp.toFixed(1)} м/с`;
      setWindTarget(d, sp);
    } catch (e) {
      wind.fetchedAt = now - 14 * 60e3;
      if (!wind.initialized) {
        setWindTarget(cfg.windDir, cfg.windSpeed);
        wind.label = 'нет данных · по умолчанию';
      }
    } finally {
      clearTimeout(to);
      wind.inflight = false;
    }
  }

  function updateWind(dt, lat, lng) {
    if (cfg.windSource === 'manual') {
      setWindTarget(cfg.windDir, cfg.windSpeed);
      wind.label = `ручной: ${Math.round(wind.dir)}° · ${wind.speed.toFixed(1)} м/с`;
    } else {
      fetchForecastWind(lat, lng);
    }
    if (!wind.initialized) return;

    wind.sp += (wind.speed - wind.sp) * (1 - Math.exp(-dt * 0.7));
    const k = 1.0 - Math.exp(-dt * 1.2);
    let nx = wind.ux + (wind.tx - wind.ux) * k;
    let ny = wind.uy + (wind.ty - wind.uy) * k;
    let len = Math.hypot(nx, ny);
    if (len < 1e-3) { nx = wind.tx; ny = wind.ty; len = 1; }
    wind.ux = nx / len; wind.uy = ny / len;

    const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const speedKmS = wind.sp * 0.001 * cfg.speed * 18.0 / cosLat;
    wind.kmPerS = speedKmS;
    wind.offX += wind.ux * speedKmS * dt;
    wind.offY += wind.uy * speedKmS * dt;
  }

  function updateFade(dt, view) {
    let want = true;
    if (!wind.initialized) want = false;

    if (wind.initialized) {
      const cosErr = wind.tx * Math.cos(pat.theta) + wind.ty * Math.sin(pat.theta);
      const lim = Math.cos(clamp(cfg.reorientDeg, 5, 120) * Math.PI / 180);
      if (cosErr < lim) FADE.misT += dt; else FADE.misT = 0;
      if (!FADE.reorient && FADE.misT > 0.8) FADE.reorient = true;
    }
    if (FADE.reorient) want = false;

    if (cfg.terrain && !fld.failed) {
      if (!fld.cur || !fieldValid(view)) want = false;
    }

    const outRate = 1 / Math.max(0.1, cfg.fadeOut);
    const inRate = 1 / Math.max(0.1, cfg.fadeIn);
    if (want) FADE.alpha = Math.min(1, FADE.alpha + dt * inRate);
    else FADE.alpha = Math.max(0, FADE.alpha - dt * outRate);

    if (FADE.reorient && FADE.alpha <= 0.001) {
      wind.ux = wind.tx; wind.uy = wind.ty;
      pat.theta = Math.atan2(wind.ty, wind.tx);
      FADE.reorient = false; FADE.misT = 0;
      if (cfg.terrain) resetField();
      forceRedraw = true;
    }
  }

  function getView(map) {
    const size = map.getSize();
    let center = map.getCenter();
    let zoom = map.getZoom();
    if (map._animatingZoom && map._animateToCenter && typeof map._animateToZoom === 'number') {
      center = map._animateToCenter; zoom = map._animateToZoom;
    }
    const n = 256 * Math.pow(2, zoom);
    const pc = map.project(center, zoom);
    const x0 = pc.x - size.x / 2, y0 = pc.y - size.y / 2;
    const toMx = px => (px / n) * MERC_FULL - MERC_HALF;
    const toMy = py => MERC_HALF - (py / n) * MERC_FULL;
    const west = toMx(x0) / 1000, east = toMx(x0 + size.x) / 1000;
    const north = toMy(y0) / 1000, south = toMy(y0 + size.y) / 1000;
    return {
      cx: (west + east) / 2, cy: (north + south) / 2,
      w: east - west, h: north - south,
      lat: center.lat, lng: center.lng, zoom
    };
  }

  const NAMES_FIELD = [
    'u_noiseTex', 'u_fldCur', 'u_fldPrev', 'u_terCur', 'u_terPrev', 'u_hasField',
    'u_fldCurGeo', 'u_fldCurDir', 'u_fldPrevGeo', 'u_fldPrevDir', 'u_fldMix', 'u_fldAmt',
    'u_W', 'u_Er', 'u_dispMax', 'u_kmSize', 'u_patRot', 'u_ppC',
    'u_lodMacro', 'u_lodMid', 'u_lodDet',
    'u_coverage', 'u_density', 'u_billowDetail', 'u_stretch', 'u_cumulusMode', 'u_clusterIsolation',
    'u_smoothBlend', 'u_sunBlendBoost', 'u_mixA', 'u_mixB',
    'u_orographicLift', 'u_foehnDissipation', 'u_peakPiercing', 'u_cloudBase', 'u_cloudThickness', 'u_wakeSplit',
    'u_sunDir', 'u_shadowCoverage', 'u_shadowSoftness', 'u_volumeDepth', 'u_creviceDarkness',
    'u_anim', 'u_dark', 'u_darkSz', 'u_volumeSmooth'
  ];
  const NAMES_COMP = [
    'u_noiseTex', 'u_fldCur', 'u_fldPrev', 'u_terCur', 'u_terPrev', 'u_hasField',
    'u_fldCurGeo', 'u_fldCurDir', 'u_fldPrevGeo', 'u_fldPrevDir', 'u_fldMix', 'u_fldAmt',
    'u_W', 'u_Er', 'u_dispMax', 'u_kmSize', 'u_patRot', 'u_ppC',
    'u_tex0', 'u_tex1', 'u_fSize', 'u_kmPerPx', 'u_pxScale', 'u_lodRag', 'u_ragged',
    'u_hatchStyle', 'u_hatchCurvature', 'u_hatchThickness', 'u_hatchLength', 'u_hatchThinning', 'u_hatchLight',
    'u_creaseOutlines', 'u_creaseBlur', 'u_hatchSp', 'u_hatchAA', 'u_hatchOrg',
    'u_lightTint', 'u_shadowTint', 'u_skyTint', 'u_glowColor', 'u_twilightRimColor', 'u_valleyColor',
    'u_twilightAmt',
    'u_atmTintStrength', 'u_sunsetWarmth', 'u_shadowBrightness', 'u_shadowColorSat', 'u_bodyColorInfluence',
    'u_cloudBrightness', 'u_cloudContrast', 'u_cloudTempLight', 'u_cloudTempShadow',
    'u_shadowBlur',
    'u_sunIntensity', 'u_sunDir', 'u_bodyColor', 'u_inkColor', 'u_outlineColor', 'u_opacity', 'u_inkOpacity', 'u_outlineWidth',
    'u_shadowOpacity', 'u_shadowOff', 'u_globalFade',
    'u_anim', 'u_dark', 'u_darkSz', 'u_paperShading', 'u_grain',
    'u_paperGrainScale', 'u_paperGrainContrast'
  ];

  function mkProg(fsSrc, names) {
    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(log);
      }
      return s;
    }
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, VS_SOURCE), fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));

    const P = {
      p, loc: Object.create(null),
      c1: Object.create(null),
      c2x: Object.create(null), c2y: Object.create(null),
      c3x: Object.create(null), c3y: Object.create(null), c3z: Object.create(null),
      c4x: Object.create(null), c4y: Object.create(null), c4z: Object.create(null), c4w: Object.create(null),
      cm0: Object.create(null), cm1: Object.create(null), cm2: Object.create(null), cm3: Object.create(null)
    };
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      P.loc[n] = gl.getUniformLocation(p, n);
      P.c1[n] = NaN; P.c2x[n] = NaN; P.c3x[n] = NaN; P.c4x[n] = NaN; P.cm0[n] = NaN;
    }
    return P;
  }

  function u1(P, n, v) { if (P.c1[n] === v) return; P.c1[n] = v; gl.uniform1f(P.loc[n], v); }
  function u1i(P, n, v) { if (P.c1[n] === v) return; P.c1[n] = v; gl.uniform1i(P.loc[n], v); }
  function u2(P, n, a, b) {
    if (P.c2x[n] === a && P.c2y[n] === b) return;
    P.c2x[n] = a; P.c2y[n] = b; gl.uniform2f(P.loc[n], a, b);
  }
  function u3(P, n, a, b, d) {
    if (P.c3x[n] === a && P.c3y[n] === b && P.c3z[n] === d) return;
    P.c3x[n] = a; P.c3y[n] = b; P.c3z[n] = d; gl.uniform3f(P.loc[n], a, b, d);
  }
  function u4(P, n, a, b, d, e) {
    if (P.c4x[n] === a && P.c4y[n] === b && P.c4z[n] === d && P.c4w[n] === e) return;
    P.c4x[n] = a; P.c4y[n] = b; P.c4z[n] = d; P.c4w[n] = e; gl.uniform4f(P.loc[n], a, b, d, e);
  }
  const _m2 = new Float32Array(4);
  function um2(P, n, a, b, d, e) {
    if (P.cm0[n] === a && P.cm1[n] === b && P.cm2[n] === d && P.cm3[n] === e) return;
    P.cm0[n] = a; P.cm1[n] = b; P.cm2[n] = d; P.cm3[n] = e;
    _m2[0] = a; _m2[1] = b; _m2[2] = d; _m2[3] = e;
    gl.uniformMatrix2fv(P.loc[n], false, _m2);
  }

  const rt = { fbo: null, tex0: null, tex1: null, w: 0, h: 0, float: true };

  function freeTargets() {
    if (!gl) return;
    if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
    if (rt.tex0) gl.deleteTexture(rt.tex0);
    if (rt.tex1) gl.deleteTexture(rt.tex1);
    rt.fbo = rt.tex0 = rt.tex1 = null; rt.w = rt.h = 0;
  }

  function buildTargets(w, h, useFloat) {
    function mkTex(unit) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    }
    const t0 = mkTex(5), t1 = mkTex(6);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t1, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo); gl.deleteTexture(t0); gl.deleteTexture(t1);
      return false;
    }
    rt.fbo = fbo; rt.tex0 = t0; rt.tex1 = t1; rt.w = w; rt.h = h; rt.float = useFloat;
    return true;
  }

  function ensureTargets() {
    if (!gl || !canvas) return;
    const w = Math.max(8, Math.round(canvas.width * clamp(cfg.fieldRes, 0.25, 1.0)));
    const h = Math.max(8, Math.round(canvas.height * clamp(cfg.fieldRes, 0.25, 1.0)));
    if (rt.fbo && rt.w === w && rt.h === h) return;
    freeTargets();
    let ok = false;
    if (rt.float !== false) {
      const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
      if (ext) ok = buildTargets(w, h, true);
    }
    if (!ok) { rt.float = false; ok = buildTargets(w, h, false); }
    if (!ok) throw new Error('Не удалось создать рендер-таргеты');
    forceRedraw = true;
  }

  function initGL() {
    gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, powerPreference: 'default'
    });
    if (!gl) throw new Error('WebGL2 недоступен');

    progField = mkProg(FS_FIELD, NAMES_FIELD);
    progComp = mkProg(FS_COMP, NAMES_COMP);

    gl.useProgram(progField.p);
    u1i(progField, 'u_noiseTex', 0); u1i(progField, 'u_fldCur', 1); u1i(progField, 'u_fldPrev', 2);
    u1i(progField, 'u_terCur', 3); u1i(progField, 'u_terPrev', 4);
    gl.useProgram(progComp.p);
    u1i(progComp, 'u_noiseTex', 0); u1i(progComp, 'u_fldCur', 1); u1i(progComp, 'u_fldPrev', 2);
    u1i(progComp, 'u_terCur', 3); u1i(progComp, 'u_terPrev', 4);
    u1i(progComp, 'u_tex0', 5); u1i(progComp, 'u_tex1', 6);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    noiseTexture = createNoiseTexture(gl);
    ensureTargets();
  }

  let qScale = 1.0, qAcc = 0, qCnt = 0, qGood = 0, qExpect = 0;
  function adaptQuality(frameMs, expectMs) {
    if (!cfg.autoQuality) {
      if (qScale !== 1.0) { qScale = 1.0; resize(); }
      return;
    }
    if (frameMs > 250) return;
    if (Math.abs(expectMs - qExpect) > 1) { qExpect = expectMs; qAcc = 0; qCnt = 0; }
    qAcc += frameMs; qCnt++;
    if (qCnt < 60) return;
    const avg = qAcc / qCnt; qAcc = 0; qCnt = 0;
    if (avg > expectMs * 1.45 && qScale > 0.5) {
      qScale = Math.max(0.5, qScale - 0.1); qGood = 0; resize();
    } else if (avg < expectMs * 1.12 && qScale < 1.0) {
      if (++qGood >= 5) { qScale = Math.min(1.0, qScale + 0.05); qGood = 0; resize(); }
    } else {
      qGood = 0;
    }
  }

  function resize() {
    if (!canvas || !WM.map) return;
    const sz = WM.map.getSize();
    cssW = sz.x; cssH = sz.y;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const k = dpr * clamp(cfg.resolution * qScale, 0.3, 1.0);
    const w = Math.max(2, Math.round(cssW * k)), h = Math.max(2, Math.round(cssH * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (gl) { try { ensureTargets(); } catch (e) { console.error('[WM.clouds]', e); } }
    forceRedraw = true;
  }

  const sigNow = new Float64Array(20), sigPrev = new Float64Array(20).fill(NaN);
  let lastCfgRev = -1, idleFps = 60, lastViewCx = NaN, lastViewCy = NaN, lastViewW = NaN;

  function setFieldUniforms(P, hasField, fMix, fAmt, view, W) {
    u1i(P, 'u_hasField', hasField);
    if (hasField) {
      const c = fld.cur, p = fld.prev || fld.cur;
      u4(P, 'u_fldCurGeo', c.ox - view.cx, c.oy - view.cy, c.size, 0);
      u2(P, 'u_fldCurDir', c.ux, c.uy);
      u4(P, 'u_fldPrevGeo', p.ox - view.cx, p.oy - view.cy, p.size, 0);
      u2(P, 'u_fldPrevDir', p.ux, p.uy);
    }
    u1(P, 'u_fldMix', fMix);
    u1(P, 'u_fldAmt', fAmt);
    u1(P, 'u_dispMax', W * 0.9);
  }

  function renderFrame(now) {
    raf = requestAnimationFrame(renderFrame);
    if (!running || !gl || ctxLost || document.hidden) { prevRafTs = 0; return; }
    const map = WM.map;
    if (!map) return;

    const capFps = clamp(cfg.fps, 15, 60);
    const fpsNow = cfg.adaptiveFps ? Math.min(capFps, idleFps) : capFps;
    const minDt = 1000 / fpsNow - 1.5;
    if (now - lastTime < minDt) return;
    const dt = clamp((now - lastTime) / 1000, 0.001, 0.1);
    const frameMs = prevRafTs ? now - prevRafTs : 0;
    prevRafTs = now;
    lastTime = now;

    const sz = map.getSize();
    if (sz.x !== cssW || sz.y !== cssH) resize();

    const tNow = performance.now();
    const view = getView(map);
    updateLighting(view.lat, view.lng, tNow);
    updateWind(dt, view.lat, view.lng);

    const animOn = !!cfg.innerAnim && cfg.innerSpeed > 0.001;
    if (animOn) animT = (animT + dt * cfg.innerSpeed) % 4096;

    maintainField(view);
    updateFade(dt, view);

    if (FADE.alpha <= 0.001) {
      if (!hiddenCleared) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        hiddenCleared = true;
        FADE.lastAlpha = 0;
      }
      idleFps = 30;
      return;
    }
    if (hiddenCleared) { hiddenCleared = false; forceRedraw = true; }

    const co = Math.cos(pat.theta), si = Math.sin(pat.theta);
    const qcx = view.cx - wind.offX, qcy = view.cy - wind.offY;
    const ppCx = co * qcx + si * qcy;
    const ppCy = -si * qcx + co * qcy;

    const hasField = (cfg.terrain && fld.cur) ? 1 : 0;
    let fMix = 1.0, fAmt = 1.0, blending = false;
    if (hasField) {
      if (fld.prev) {
        fMix = clamp((tNow - fld.blendT0) / 1200, 0, 1);
        if (fMix >= 1) { deleteFieldTex(fld.prev); fld.prev = null; }
        else blending = true;
      }
      fAmt = smooth01((tNow - fld.amtT0) / 1500);
      if (fAmt < 1) blending = true;
    }

    let cov = cfg.coverage;
    if (cfg.coverageFromWeather && wind.cloudCover != null) {
      const target = clamp(wind.cloudCover / 100, 0.05, 0.95);
      covSm = covSm === null ? target : covSm + (target - covSm) * (1 - Math.exp(-dt * 0.5));
      cov = covSm;
    } else {
      covSm = null;
    }

    const s = sigNow;
    s[0] = view.cx; s[1] = view.cy; s[2] = view.w; s[3] = view.h;
    s[4] = wind.offX; s[5] = wind.offY; s[6] = pat.theta; s[7] = hasField;
    s[8] = sky.dir[0];
    s[9] = sky.dir[1];
    s[10] = sky.sunIntensity;
    s[11] = sky.tint[0] + sky.tint[1] + sky.tint[2];
    s[12] = sky.shadowTint[0] + sky.shadowTint[1] + sky.shadowTint[2];
    s[13] = canvas.width; s[14] = canvas.height;
    s[15] = animOn ? animT : 0;
    s[16] = cov;
    let needField = forceRedraw || lastCfgRev !== cfgRev || blending;
    if (!needField) for (let i = 0; i < 17; i++) if (s[i] !== sigPrev[i]) { needField = true; break; }
    const fadeChanged = FADE.alpha !== FADE.lastAlpha;

    let kmPerCanvasPx = view.w / canvas.width;
    const viewMoved = view.cx !== lastViewCx || view.cy !== lastViewCy || view.w !== lastViewW;
    lastViewCx = view.cx; lastViewCy = view.cy; lastViewW = view.w;

    const driftPx = wind.kmPerS / Math.max(1e-9, kmPerCanvasPx);
    idleFps = (viewMoved || blending || fld.building || FADE.alpha < 1) ? 60
            : (driftPx < 2 ? 12 : (driftPx < 8 ? 24 : 60));
    if (animOn) idleFps = Math.max(idleFps, clamp(cfg.animFps, 5, 60));

    if (!needField && !fadeChanged) return;

    if (frameMs) adaptQuality(frameMs, 1000 / fpsNow);
    if (forceRedraw) needField = true;
    if (needField) {
      for (let i = 0; i < 17; i++) sigPrev[i] = s[i];
      lastCfgRev = cfgRev;
    }
    forceRedraw = false;
    FADE.lastAlpha = FADE.alpha;
    kmPerCanvasPx = view.w / canvas.width;

    const W = Math.max(6, cfg.scale * 50);
    const spKm = Math.max(1e-6, cfg.hatchSpacing * (view.w / cssW));
    const kmPerFieldPx = view.w / rt.w;
    const lodFor = (px, scaleKm) => Math.max(0, Math.log2(Math.max(1e-6, 256 * px / scaleKm)));
    const lodMacro = lodFor(kmPerFieldPx, W * 5.5556);
    const lodMid = lodFor(kmPerFieldPx, W * 1.7);
    const lodDet = lodFor(kmPerFieldPx, W * 0.9);
    const lodRag = lodFor(kmPerCanvasPx, W * 0.55);
    const Er = 0.6 * W;
    const darkSz = W * 11.0 * clamp(cfg.darkScale, 0.2, 4.0);
    const wob = animOn ? cfg.innerWobble : 0;
    const warp = animOn ? cfg.innerWarp : 0;
    const boil = animOn ? cfg.hatchBoil : 0;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    const curF = hasField ? fld.cur : null;
    const prevF = hasField ? (fld.prev || fld.cur) : null;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, curF ? curF.tex : noiseTexture);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prevF ? prevF.tex : noiseTexture);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, curF ? curF.tex2 : noiseTexture);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, prevF ? prevF.tex2 : noiseTexture);

    gl.bindVertexArray(vao);

    // ПРОХОД 1: поле форм
    if (needField) {
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, rt.w, rt.h);
      const P1 = progField;
      gl.useProgram(P1.p);
      setFieldUniforms(P1, hasField, fMix, fAmt, view, W);
      u1(P1, 'u_W', W); u1(P1, 'u_Er', Er);
      u2(P1, 'u_kmSize', view.w, view.h);
      u2(P1, 'u_ppC', ppCx, ppCy);
      um2(P1, 'u_patRot', co, -si, si, co);
      u1(P1, 'u_lodMacro', lodMacro); u1(P1, 'u_lodMid', lodMid); u1(P1, 'u_lodDet', lodDet);
      u1(P1, 'u_coverage', cov);
      u1(P1, 'u_density', cfg.density);
      u1(P1, 'u_billowDetail', cfg.billowDetail);
      u1(P1, 'u_stretch', cfg.stretch);
      u1i(P1, 'u_cumulusMode', cfg.cumulusMode ? 1 : 0);
      u1(P1, 'u_clusterIsolation', cfg.clusterIsolation);
      u1(P1, 'u_smoothBlend', cfg.smoothBlend);
      u1(P1, 'u_sunBlendBoost', cfg.sunBlendBoost);
      u4(P1, 'u_mixA', cfg.mixCumulus, cfg.mixRolls, cfg.mixArcs, cfg.mixStreaks);
      u4(P1, 'u_mixB', cfg.mixSheets, cfg.fractus, cfg.translucency, cfg.curl);
      u1(P1, 'u_orographicLift', cfg.orographicLift);
      u1(P1, 'u_foehnDissipation', cfg.foehnDissipation);
      u1(P1, 'u_peakPiercing', cfg.peakPiercing);
      u1(P1, 'u_cloudBase', cfg.cloudBase);
      u1(P1, 'u_cloudThickness', cfg.cloudThickness);
      u1(P1, 'u_wakeSplit', cfg.wakeSplit);
      u3(P1, 'u_sunDir', sky.dir[0], sky.dir[1], sky.dir[2]);
      u1(P1, 'u_shadowCoverage', cfg.shadowCoverage);
      u1(P1, 'u_shadowSoftness', cfg.shadowSoftness);
      u1(P1, 'u_volumeDepth', cfg.volumeDepth);
      u1(P1, 'u_creviceDarkness', cfg.creviceDarkness);
      u1(P1, 'u_volumeSmooth', cfg.volumeSmooth);
      u4(P1, 'u_anim', animT, wob, warp, boil);
      u4(P1, 'u_dark', cfg.darkCover, cfg.darkAmount, cfg.darkSoft, lodFor(kmPerFieldPx, darkSz));
      u1(P1, 'u_darkSz', darkSz);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ПРОХОД 2: композит
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const P2 = progComp;
    gl.useProgram(P2.p);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, rt.tex0);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, rt.tex1);
    setFieldUniforms(P2, hasField, fMix, fAmt, view, W);
    u1(P2, 'u_W', W); u1(P2, 'u_Er', Er);
    u2(P2, 'u_kmSize', view.w, view.h);
    u2(P2, 'u_ppC', ppCx, ppCy);
    um2(P2, 'u_patRot', co, -si, si, co);
    u2(P2, 'u_fSize', rt.w, rt.h);
    u1(P2, 'u_kmPerPx', kmPerCanvasPx);
    const pxScale = canvas.width / cssW;
    u1(P2, 'u_pxScale', pxScale);
    u1(P2, 'u_lodRag', lodRag);
    u1(P2, 'u_ragged', cfg.edgeRagged);

    const hatchModes = { woodcut: 0, streamline: 1, cross: 2 };
    u1i(P2, 'u_hatchStyle', hatchModes[cfg.hatchStyle] !== undefined ? hatchModes[cfg.hatchStyle] : 0);
    u1(P2, 'u_hatchCurvature', cfg.hatchCurvature);
    u1(P2, 'u_hatchThickness', cfg.hatchThickness);
    u1(P2, 'u_hatchThinning', cfg.hatchThinning);
    u1(P2, 'u_hatchLight', cfg.hatchLight);
    u1(P2, 'u_creaseOutlines', cfg.creaseOutlines);
    u1(P2, 'u_creaseBlur', cfg.creaseBlur);
    u1(P2, 'u_hatchLength', cfg.hatchLength);
    u1(P2, 'u_hatchSp', spKm);
    u1(P2, 'u_hatchAA', 0.75 / (cfg.hatchSpacing * pxScale));
    u2(P2, 'u_hatchOrg', modPos(ppCx / spKm, 4096), modPos(ppCy / spKm, 4096));

    const bCol = hex3(cfg.bodyColor), iCol = hex3(cfg.inkColor);
    const oCol = hex3(cfg.outlineColor || cfg.inkColor);
    u3(P2, 'u_bodyColor', bCol[0], bCol[1], bCol[2]);
    u3(P2, 'u_inkColor', iCol[0], iCol[1], iCol[2]);
    u3(P2, 'u_outlineColor', oCol[0], oCol[1], oCol[2]);
    u1(P2, 'u_opacity', cfg.opacity);
    u1(P2, 'u_inkOpacity', cfg.inkOpacity);
    u1(P2, 'u_outlineWidth', cfg.outlineWidth);
    u1(P2, 'u_shadowOpacity', cfg.shadowOpacity);
    u1(P2, 'u_globalFade', smooth01(FADE.alpha));
    u1(P2, 'u_paperShading', cfg.paperShading);
    u1(P2, 'u_grain', cfg.paperGrain);
    u1(P2, 'u_paperGrainScale', cfg.paperGrainScale);
    u1(P2, 'u_paperGrainContrast', cfg.paperGrainContrast);
    u4(P2, 'u_anim', animT, wob, warp, boil);
    u4(P2, 'u_dark', cfg.darkCover, cfg.darkAmount, cfg.darkSoft, lodFor(kmPerCanvasPx, darkSz));
    u1(P2, 'u_darkSz', darkSz);
    const shK = cfg.shadowHeight / Math.max(0.25, sky.dir[2]);
    u2(P2, 'u_shadowOff', sky.dir[0] * shK / view.w, sky.dir[1] * shK / view.h);
    u3(P2, 'u_lightTint', sky.tint[0], sky.tint[1], sky.tint[2]);
    u3(P2, 'u_shadowTint', sky.shadowTint[0], sky.shadowTint[1], sky.shadowTint[2]);
    u3(P2, 'u_skyTint', sky.skyColor[0], sky.skyColor[1], sky.skyColor[2]);
    u3(P2, 'u_glowColor', sky.glowColor[0], sky.glowColor[1], sky.glowColor[2]);
    u3(P2, 'u_twilightRimColor', sky.rimColor[0], sky.rimColor[1], sky.rimColor[2]);
    u3(P2, 'u_valleyColor', sky.valleyColor[0], sky.valleyColor[1], sky.valleyColor[2]);
    u1(P2, 'u_twilightAmt', sky.twilightAmt);
    u1(P2, 'u_atmTintStrength', cfg.atmTintStrength);
    u1(P2, 'u_sunsetWarmth', cfg.sunsetWarmth);
    u1(P2, 'u_shadowBrightness', cfg.shadowBrightness);
    u1(P2, 'u_shadowColorSat', cfg.shadowColorSat);
    u1(P2, 'u_bodyColorInfluence', cfg.bodyColorInfluence);
    u1(P2, 'u_cloudBrightness', cfg.cloudBrightness);
    u1(P2, 'u_cloudContrast', cfg.cloudContrast);
    u1(P2, 'u_cloudTempLight', cfg.cloudTempLight);
    u1(P2, 'u_cloudTempShadow', cfg.cloudTempShadow);
    u1(P2, 'u_shadowBlur', cfg.shadowBlur);

    u1(P2, 'u_sunIntensity', sky.sunIntensity);
    u3(P2, 'u_sunDir', sky.dir[0], sky.dir[1], sky.dir[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  function onCtxLost(e) {
    if (e.target !== canvas) return;
    e.preventDefault();
    ctxLost = true;
    progField = progComp = vao = vbo = noiseTexture = null;
    rt.fbo = rt.tex0 = rt.tex1 = null; rt.w = rt.h = 0;
    fld.cur = null; fld.prev = null; fld.epoch++; fld.building = false;
  }
  function onCtxRestored(e) {
    if (e.target !== canvas) return;
    try {
      ctxLost = false;
      rt.float = true;
      initGL();
      forceRedraw = true;
    } catch (err) {
      console.error('[WM.clouds] Не удалось восстановить WebGL:', err);
      api.setEnabled(false);
    }
  }

  function onMapMoveStart() { isMapMoving = true; }
  function onMapMoveEnd() { isMapMoving = false; lastMoveEnd = performance.now(); }

  function start() {
    if (running || !WM.map) return false;
    try {
      canvas = document.createElement('canvas');
      canvas.className = 'wm-clouds-canvas';
      canvas.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${cfg.zIndex};`;
      canvas.addEventListener('webglcontextlost', onCtxLost, false);
      canvas.addEventListener('webglcontextrestored', onCtxRestored, false);
      WM.map.getContainer().appendChild(canvas);
      resize();
      initGL();
    } catch (e) {
      console.error('[WM.clouds] Ошибка инициализации WebGL2:', e);
      stop();
      return false;
    }

    WM.map.on('resize', resize);
    WM.map.on('movestart', onMapMoveStart);
    WM.map.on('moveend', onMapMoveEnd);

    running = true;
    forceRedraw = true;
    ctxLost = false;
    FADE.alpha = 0; FADE.lastAlpha = -1; FADE.misT = 0; FADE.reorient = false;
    hiddenCleared = false;
    lastTime = performance.now();
    prevRafTs = 0;
    raf = requestAnimationFrame(renderFrame);
    return true;
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf); raf = 0;
    if (WM.map) {
      WM.map.off('resize', resize);
      WM.map.off('movestart', onMapMoveStart);
      WM.map.off('moveend', onMapMoveEnd);
    }
    resetField();
    if (gl) {
      try {
        freeTargets();
        if (noiseTexture) gl.deleteTexture(noiseTexture);
        if (progField) gl.deleteProgram(progField.p);
        if (progComp) gl.deleteProgram(progComp.p);
        if (vao) gl.deleteVertexArray(vao);
        if (vbo) gl.deleteBuffer(vbo);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) {}
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null; gl = null; progField = progComp = null; vao = vbo = null; noiseTexture = null;
    rt.float = true;
    FADE.alpha = 0; FADE.lastAlpha = -1; FADE.misT = 0; FADE.reorient = false;
    hiddenCleared = false;
  }


  function whenMapReady(cb) {
    if (WM.map && WM.map.getContainer) {
      setTimeout(cb, 500);
      return;
    }
    let tries = 0;
    const t = setInterval(() => {
      if (WM.map && WM.map.getContainer) {
        clearInterval(t);
        setTimeout(cb, 500);
      } else if (++tries > 100) {
        clearInterval(t);
      }
    }, 200);
  }

  const api = WM.clouds = {
    __loaded: true,
    version: '10.0-living-engraving-opt',
    getConfig: () => ({ ...cfg }),
    isEnabled: () => !!cfg.enabled,
    isRunning: () => running,

    setEnabled(on) {
      on = !!on;
      const seq = ++enableSeq;
      cfg.enabled = on;
      saveConfig();
      if (on) {
        whenMapReady(() => {
          if (seq !== enableSeq || !cfg.enabled) return;
          if (!running && !start()) {
            cfg.enabled = false;
            saveConfig();
          }
        });
      } else {
        stop();
      }
    },
    enable() { api.setEnabled(true); },
    disable() { api.setEnabled(false); },
    toggle() { api.setEnabled(!cfg.enabled); return cfg.enabled; },

    

    setConfig(patch) {
      if (!patch) return;
      for (const k in patch) {
        if (k === 'enabled') continue;
        if (k in DEFAULTS && typeof patch[k] === typeof DEFAULTS[k]) cfg[k] = patch[k];
      }
      cfgRev++;
      saveConfig();
      if (patch.windSource === 'auto') wind.fetchedAt = 0;
      if ('enabled' in patch) api.setEnabled(patch.enabled);
      if (running) {
        if (canvas) canvas.style.zIndex = cfg.zIndex;
        if (patch.resolution !== undefined || patch.fieldRes !== undefined) resize();
      }
    },

    applyProfile(profileClouds) {
      const shouldEnable = !!(profileClouds && profileClouds.enabled);
      const patch = (profileClouds && profileClouds.config) ? profileClouds.config : {};
      const prevTerrain = cfg.terrain;
      const prevDeflect = cfg.mountainDeflection;
      const prevBase = cfg.cloudBase;

      cfg = { ...DEFAULTS, enabled: shouldEnable };
      for (const k in patch) {
        if (k === 'enabled') continue;
        if (k in DEFAULTS && typeof patch[k] === typeof DEFAULTS[k]) {
          cfg[k] = patch[k];
        }
      }
      cfgRev++;
      saveConfig();
      if (patch.windSource === 'auto') wind.fetchedAt = 0;

      api.setEnabled(shouldEnable);

      if (running && shouldEnable) {
        if (canvas) canvas.style.zIndex = cfg.zIndex;
        if (
          (!cfg.terrain && prevTerrain) ||
          (cfg.terrain && (!prevTerrain || prevDeflect !== cfg.mountainDeflection || prevBase !== cfg.cloudBase))
        ) {
          resetField();
        }
        forceRedraw = true;
        resize();
      }
    },

    resetConfig() {
      const en = cfg.enabled;
      cfg = { ...DEFAULTS, enabled: en };
      cfgRev++;
      saveConfig();
      if (running) resize();
    },

    setWind(dirDeg, speedMs) {
      api.setConfig({ windSource: 'manual', windDir: +dirDeg || 0, windSpeed: Math.max(0.5, +speedMs || 0.5) });
    },
    getWind: () => ({ dirFrom: wind.dir, speed: wind.speed, source: cfg.windSource, cloudCover: wind.cloudCover }),
    getFieldInfo: () => fld.cur ? { size: fld.cur.size, ox: fld.cur.ox, oy: fld.cur.oy, building: fld.building } : null,

    // Открытие настроек облаков внутри панели рельефа:
    openPanel() {
      if (WM.demRelief && WM.demRelief.openHud) {
        WM.demRelief.openHud();

        // Переключаем панель рельефа на вкладку "Свет"
        const lightTabBtn = document.querySelector('.dem-hud-tab-btn[data-tab="light"]');
        if (lightTabBtn) lightTabBtn.click();

        // Находим и раскрываем спойлер облаков
        const spoiler = document.getElementById('spoiler-hud-clouds');
        if (spoiler) {
          spoiler.open = true;
          setTimeout(() => spoiler.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120);
        }
      }
    },
    closePanel() {
      const spoiler = document.getElementById('spoiler-hud-clouds');
      if (spoiler) spoiler.open = false;
    },
    togglePanel() { 
      api.openPanel(); 
    },
    refreshTerrain() { 
      if (fld.cur) fld.cur.sig = ''; 
      fld.lastT = 0; 
      forceRedraw = true; 
    },
    destroy() { 
      cfg.enabled = false; 
      stop(); 
    }
  };

  if (cfg.enabled) whenMapReady(() => { if (!start()) { cfg.enabled = false; } });
})();

