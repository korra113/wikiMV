/* =============================================================================
 * WM.viewshed v2 (Ultimate Edition) — Зона видимости по рельефу (DEM)
 * + время суток/года + атмосфера/погода + интерактивный профиль препятствий
 * ========================================================================== */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  // ---------------------------------------------------------------------------
  // КОНСТАНТЫ И МАТЕМАТИЧЕСКИЕ УТИЛИТЫ
  // ---------------------------------------------------------------------------
  const DEG = Math.PI / 180, RAD = 180 / Math.PI;
  const TAU = Math.PI * 2;
  const INV_2PI = 1 / TAU, INV_4PI = 1 / (4 * Math.PI);
  const R_EARTH = 6371008.8; // Средний радиус Земли, м
  const SETTINGS_KEY = 'wm_viewshed_settings_v3';
  const FOV_HALF = 35.0;     // Полуугол обзора для следования компасу
  const NEAR_NO_TARGET_M = 300.0; // Вблизи цель не "висит" над землей

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Квантованная уступка главному потоку без задержки 4 мс таймера
  const yieldTask = (function () {
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      const q = [];
      ch.port1.onmessage = () => { const f = q.shift(); if (f) f(); };
      return (f) => { q.push(f); ch.port2.postMessage(0); };
    }
    return (f) => setTimeout(f, 0);
  })();

  // ---------------------------------------------------------------------------
  // НАСТРОЙКИ
  // ---------------------------------------------------------------------------
  const S = {
    eyeHeight: 1.8,
    targetHeight: 15.0,
    radiusKm: 75,
    followCompass: false,
    quality: 'standard',          // fast | standard | high
    color: '#10b981',
    opacity: 0.55,
    peakPreserve: true,
    observerSnap: true,
    baseK: 0.115,                 // Вшитая калибровка рефракции

    // --- 1. ВШИТАЯ КАЛИБРОВКА ЛЕСНОГО ПОКРОВА ---
    canopy: {
      enabled: true,
      season: 'summer',
      summerPenetrationM: 40.0,     // Было 100.0 м — в густом лесу летом дальность 35-45 м
      winterPenetrationM: 85.0,     // Было 200.0 м — зимой без листвы дальность 70-90 м
      treeHeightFactor: 1.15,
      clearingMinM: 10.0,
      forestScanNearM: 300.0,
      underCanopyMinM: 40.0,
      wetCanopyPenalty: 0.40
    },

    // --- 2. ВШИТАЯ КАЛИБРОВКА НОЧНОГО И СУМЕРЕЧНОГО ЗРЕНИЯ ---
    night: {
      baseMoonlessM: 2000.0,
      fullMoonMaxM: 20000.0,
      moonPhaseGamma: 1.50,
      twilightDepthDeg: -14.0,
      guaranteedNearM: 120.0,
      cloudScreeningPenalty: 0.75,
      nightToneFactor: 0.65
    },

    // --- 3. АТМОСФЕРА И ПОГОДА ---
    time: { enabled: false, mode: 'now', ts: null, dynRefraction: true },
    wx:   { enabled: false, source: 'auto', preset: 'clear', cloudBase: 1500, cloudThick: 800 },
    atm:  { baseVisKm: 80, targetKind: 'auto', cityLight: 3e6 }
  };

  const QUALITY = {
    fast:     { cellFarM: 420, outSize: 768,  maxCells: 3.0e6,  texelScale: 2.0 },
    standard: { cellFarM: 190, outSize: 1024, maxCells: 6.5e6,  texelScale: 1.0 },
    high:     { cellFarM: 95,  outSize: 1536, maxCells: 12.0e6, texelScale: 0.5 }
  };

  // =========================================================================
// УНИВЕРСАЛЬНЫЙ АДАПТИВНЫЙ CIRCUIT BREAKER ДЛЯ СЕТЕВЫХ РЕСУРСОВ
// =========================================================================
const NetHealth = {
  hosts: new Map(), // key -> { fails, openUntil, backoffMs, lastSuccess, avgLatency }

  _getHost(url) {
    try { return new URL(url).host; } catch (e) { return url.split('/')[2] || url; }
  },

  getState(url) {
    const host = this._getHost(url);
    let s = this.hosts.get(host);
    if (!s) {
      s = { fails: 0, openUntil: 0, backoffMs: 15000, lastSuccess: 0, avgLatency: 200 };
      this.hosts.set(host, s);
    }
    return s;
  },

  isAvailable(url) {
    const s = this.getState(url);
    return Date.now() >= s.openUntil;
  },

  reportSuccess(url, latencyMs) {
    const s = this.getState(url);
    s.fails = 0;
    s.openUntil = 0;
    s.backoffMs = 15000;
    s.lastSuccess = Date.now();
    s.avgLatency = s.avgLatency * 0.7 + latencyMs * 0.3;
  },

  reportFailure(url, isFatal = false) {
    const s = this.getState(url);
    s.fails++;
    // Если хост работал недавно, 1 случайная ошибка не отключает его сразу
    const isRecentlyAlive = (Date.now() - s.lastSuccess) < 60000;
    const threshold = isRecentlyAlive ? 3 : 2;

    if (isFatal || s.fails >= threshold) {
      // Экспоненциальный откат (15 сек -> 30 сек -> 2 мин -> макс 5 мин)
      s.openUntil = Date.now() + s.backoffMs;
      s.backoffMs = Math.min(s.backoffMs * 2, 300000);
    }
  },

  // Сортировка списка URL: доступные и быстрые идут первыми, упавшие — в конец
  rankUrls(urls) {
    return urls.slice().sort((a, b) => {
      const sa = this.getState(a), sb = this.getState(b);
      const now = Date.now();
      const aDead = sa.openUntil > now, bDead = sb.openUntil > now;
      if (aDead !== bDead) return aDead ? 1 : -1;
      return sa.avgLatency - sb.avgLatency;
    });
  }
};

  function loadSettings() {
    try {
      const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!j || typeof j !== 'object') return;
      
      // Загружаем только пользовательские параметры UI
      const userProps = ['eyeHeight', 'targetHeight', 'radiusKm', 'quality', 'color', 'opacity', 'peakPreserve', 'observerSnap'];
      userProps.forEach(k => { 
        if (j[k] !== undefined && typeof j[k] === typeof S[k]) S[k] = j[k]; 
      });

      if (j.canopy && typeof j.canopy === 'object') {
        if (typeof j.canopy.enabled === 'boolean') S.canopy.enabled = j.canopy.enabled;
        if (typeof j.canopy.season === 'string') S.canopy.season = j.canopy.season;
      }

      ['time', 'wx', 'atm'].forEach(g => {
        if (j[g] && typeof j[g] === 'object') {
          Object.keys(S[g]).forEach(k => { if (j[g][k] !== undefined) S[g][k] = j[g][k]; });
        }
      });

      if (!QUALITY[S.quality]) S.quality = 'standard';
    } catch (e) {}
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) {}
  }


  // ---------------------------------------------------------------------------
  // СОСТОЯНИЕ МОДУЛЯ
  // ---------------------------------------------------------------------------
  let map = null;
  let isActive = false;
  let observerLL = null;
  let originMode = 'center';
  try { originMode = localStorage.getItem('wm_viewshed_origin_mode') || 'center'; } catch (e) {}

  let layerGroup = (typeof L !== 'undefined' && L.layerGroup) ? L.layerGroup() : null, viewshedOverlay = null, observerMarker = null;
  let lastHeading = 0, lastBlobUrl = null;
  let probePopup = null, probeArmed = false;
  let probeHandledAt = -1e9, lastSetObserverAt = -1e9, lastSetObserverLL = null;

  let pipeToken = 0, running = false, timer = null, paintTimer = null;
  let idleWaiters = [];

  let geo = null;        // Pass 1: геометрия рельефа
  let vis = null;        // Pass 2: видимость (hReq)
  let fields = null;     // Pass 3: растровые поля пикселей
  let lastEnv = null;    // Атмосферная модель
  let weatherCache = new Map();
  let envTimer = null;
  let lastSig = '';
  let paintDirty = false;

  const ViewshedDiag = {
    pipelineStartMs: 0,
    totalCalcMs: 0,
    dem: {
      source: '',
      loadMs: 0,
      tilesRequested: 0,
      tilesFailed: 0,
      status: 'idle',
      hosts: []
    },
    wx: {
      source: '',
      loadMs: 0,
      status: 'idle',
      detail: '',
      blocked: false
    },
    canopy: {
      activeHost: '',
      loadMs: 0,
      status: 'disabled',
      tilesTotal: 0,
      tilesDownloaded: 0,
      tilesCached: 0,
      tilesFailed: 0,
      maxTreeHeight: 0,
      deadHosts: []
    },

    updateUI() {
      const $id = (id) => document.getElementById(id);
      const setTxt = (id, val) => { const el = $id(id); if (el) el.textContent = val; };

      setTxt('vs-diag-calc-time', this.totalCalcMs > 0 ? `${Math.round(this.totalCalcMs)} мс` : '--');
      setTxt('vs-diag-tiles-ram', `${tileStore.size} (~${Math.round(storeBytes / 1024 / 1024)} МБ)`);

      // 1. DEM
      const demBadge = $id('vs-diag-dem-badge');
      if (demBadge) {
        demBadge.textContent = this.dem.status === 'ok' ? 'OK' : (this.dem.status === 'loading' ? '⏳' : 'ERR');
        demBadge.className = `dem-hud-badge-mini ${this.dem.status === 'ok' ? 'active' : ''}`;
      }
      setTxt('vs-diag-dem-source', this.dem.source || 'Не выбран');
      setTxt('vs-diag-dem-time', this.dem.loadMs > 0 ? `${Math.round(this.dem.loadMs)} мс` : '--');
      setTxt('vs-diag-dem-counts', `${this.dem.tilesRequested - this.dem.tilesFailed} / ${this.dem.tilesRequested}`);

      const demHostsEl = $id('vs-diag-dem-hosts');
      if (demHostsEl) {
        demHostsEl.textContent = this.dem.hosts.length ? `Зеркала: ${this.dem.hosts.join(', ')}` : '';
      }
      const demBlockedEl = $id('vs-diag-dem-blocked');
      if (demBlockedEl) {
        if (this.dem.tilesFailed > 0) {
          demBlockedEl.hidden = false;
          demBlockedEl.textContent = `⚠️ Не ответило тайлов: ${this.dem.tilesFailed}`;
        } else {
          demBlockedEl.hidden = true;
        }
      }

      // 2. Weather
      const wxBadge = $id('vs-diag-wx-badge');
      if (wxBadge) {
        wxBadge.textContent = this.wx.status;
        wxBadge.className = `dem-hud-badge-mini ${this.wx.status === 'online' || this.wx.status === 'manual' ? 'active' : ''}`;
      }
      setTxt('vs-diag-wx-source', this.wx.source || 'Выкл');
      setTxt('vs-diag-wx-time', this.wx.loadMs > 0 ? `${Math.round(this.wx.loadMs)} мс` : '--');
      setTxt('vs-diag-wx-details', this.wx.detail || 'Метеоданные не задействованы');
      
      const wxStatusEl = $id('vs-diag-wx-status');
      if (wxStatusEl) {
        if (this.wx.blocked) {
          wxStatusEl.innerHTML = `<span style="color:#ef4444; font-weight:bold;">⚠️ Open-Meteo недоступен. Применён фоллбэк</span>`;
        } else {
          wxStatusEl.innerHTML = `<span style="color:#10b981;">✓ Погодная модель активна</span>`;
        }
      }

      // 3. Canopy
      const cBadge = $id('vs-diag-canopy-badge');
      if (cBadge) {
        const isOk = this.canopy.status === 'active';
        cBadge.textContent = isOk ? 'OK' : (this.canopy.status === 'loading' ? '⏳' : (this.canopy.status === 'disabled' ? 'ВЫКЛ' : 'ERR'));
        cBadge.className = `dem-hud-badge-mini ${isOk ? 'active' : ''}`;
      }
      setTxt('vs-diag-canopy-active-host', this.canopy.activeHost || 'Выключено');
      setTxt('vs-diag-canopy-time', this.canopy.loadMs > 0 ? `${Math.round(this.canopy.loadMs)} мс` : '--');

      const cCountsEl = $id('vs-diag-canopy-counts');
      if (cCountsEl) {
        cCountsEl.textContent = this.canopy.status === 'disabled'
          ? '--'
          : `Тайлы: ${this.canopy.tilesDownloaded} загружено, ${this.canopy.tilesCached} в кэше, ${this.canopy.tilesFailed} сбоев (макс. высота: ${Math.round(this.canopy.maxTreeHeight)} м)`;
      }

      const cBlockedEl = $id('vs-diag-canopy-blocked');
      if (cBlockedEl) {
        if (this.canopy.deadHosts && this.canopy.deadHosts.length > 0) {
          cBlockedEl.hidden = false;
          cBlockedEl.textContent = `🚫 Заблокированы: ${this.canopy.deadHosts.join(', ')}`;
        } else {
          cBlockedEl.hidden = true;
        }
      }

      const ovBadge = $id('vs-diag-overall-status');
      if (ovBadge) {
        ovBadge.textContent = this.dem.status === 'ok' ? 'готов' : 'расчёт';
        ovBadge.classList.toggle('active', this.dem.status === 'ok');
      }
    }
  };

  // ---------------------------------------------------------------------------
  // АСТРОНОМИЯ: СОЛНЦЕ / ЛУНА
  // ---------------------------------------------------------------------------
  const J1970 = 2440588, J2000 = 2451545, DAYMS = 864e5, OBL = 23.4397 * DEG;
  const toDays = (date) => date.valueOf() / DAYMS - 0.5 + J1970 - J2000;

  function sunCoords(d) {
    const M = DEG * (357.5291 + 0.98560028 * d);
    const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + DEG * 102.9372 + Math.PI;
    return { dec: Math.asin(Math.sin(OBL) * Math.sin(L)), ra: Math.atan2(Math.sin(L) * Math.cos(OBL), Math.cos(L)) };
  }

  function sunPosFallback(date, lat, lng) {
    const lw = DEG * -lng, phi = DEG * lat, d = toDays(date), c = sunCoords(d);
    const H = DEG * (280.16 + 360.9856235 * d) - lw - c.ra;
    return {
      azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)),
      altitude: Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H))
    };
  }

  function sunInfo(date, lat, lng) {
    const SC = window.SunCalc;
    const p = (SC && SC.getPosition) ? SC.getPosition(date, lat, lng) : sunPosFallback(date, lat, lng);
    const altDeg = p.altitude * RAD;
    const azDeg = ((p.azimuth * RAD + 180) % 360 + 360) % 360;
    const decDeg = sunCoords(toDays(date)).dec * RAD;
    const noonAltDeg = 90 - Math.abs(lat - decDeg);
    let moonAltDeg = -90, moonFrac = 0;
    try {
      if (SC && SC.getMoonPosition) moonAltDeg = SC.getMoonPosition(date, lat, lng).altitude * RAD;
      if (SC && SC.getMoonIllumination) moonFrac = SC.getMoonIllumination(date).fraction;
    } catch (e) {}
    return { altDeg, azDeg, noonAltDeg, moonAltDeg, moonFrac, date };
  }

  // ---------------------------------------------------------------------------
  // МОДУЛЬ СБОРА ВЫСОТЫ РАСТИТЕЛЬНОСТИ И ОЦЕНКИ СЕЗОНА
  // ---------------------------------------------------------------------------
  function getEffectiveSeason(date) {
    if (S.canopy.season && S.canopy.season !== 'auto') {
      return S.canopy.season;
    }
    const d = date || new Date();
    const month = d.getMonth() + 1;
    if (month >= 5 && month <= 9) return 'summer';
    if (month >= 11 || month <= 3) return 'winter';
    return 'spring_fall'; // Межсезонье
  }

  function getTreeHeightNorm(xn, yn) {
    if (!S.canopy || !S.canopy.enabled) return 0;
    if (WM.canopy && typeof WM.canopy.getHeightAtNorm === 'function') {
      return Math.max(0, WM.canopy.getHeightAtNorm(xn, yn) || 0);
    }
    return getTreeHeightAt(mercLat(yn), xn * 360.0 - 180.0);
  }

  // Получение высоты деревьев в точке через модуль WM.canopy
  function getTreeHeightAt(lat, lng) {
    if (!S.canopy || !S.canopy.enabled) return 0;
    try {
      if (WM.canopy) {
        if (typeof WM.canopy.getTreeHeight === 'function') {
          return Math.max(0, WM.canopy.getTreeHeight(lat, lng) || 0);
        }
        if (typeof WM.canopy.getHeightAt === 'function') {
          return Math.max(0, WM.canopy.getHeightAt(lat, lng) || 0);
        }
        if (typeof WM.canopy.getCanopyHeight === 'function') {
          return Math.max(0, WM.canopy.getCanopyHeight(lat, lng) || 0);
        }
      }
    } catch (e) {}
    return 0;
  }

  // ---------------------------------------------------------------------------
  // ГЕОДЕЗИЯ НА СФЕРЕ
  // ---------------------------------------------------------------------------
  function destination(latDeg, lngDeg, bearingDeg, distM) {
    const phi1 = latDeg * DEG, lam1 = lngDeg * DEG, th = bearingDeg * DEG, dl = distM / R_EARTH;
    const sinPhi2 = Math.sin(phi1) * Math.cos(dl) + Math.cos(phi1) * Math.sin(dl) * Math.cos(th);
    const phi2 = Math.asin(clamp(sinPhi2, -1, 1));
    const lam2 = lam1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(phi1), Math.cos(dl) - Math.sin(phi1) * sinPhi2);
    return [phi2 * RAD, ((lam2 * RAD + 540) % 360) - 180];
  }

  function distBearing(lat1, lng1, lat2, lng2) {
    const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lng2 - lng1) * DEG;
    const c = Math.acos(clamp(Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl), -1, 1));
    let th = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
    if (th < 0) th += TAU;
    return { d: c * R_EARTH, bearing: th * RAD };
  }

  const mercY = (latDeg) => { const s = Math.sin(latDeg * DEG); return 0.5 - Math.log((1 + s) / (1 - s)) * INV_4PI; };
  const mercLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * RAD;

  // ---------------------------------------------------------------------------
  // ХРАНИЛИЩЕ DEM-ТАЙЛОВ (Uint16Array: (h + 1000) * 4)
  // ---------------------------------------------------------------------------
  const DEFAULT_TEMPLATES = [
    'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    'https://tile.nextzen.org/tilezen/elevation/v1/terrarium/{z}/{x}/{y}.png'
  ];
  const tileStore = new Map();
  let storeBytes = 0;
  const STORE_MAX_BYTES = 160 * 1024 * 1024; // 160 МБ
  let demS = 0;
  let tileLoaderHook = null;
  let jobSerial = 0;

  const tileKey = (z, x, y) => (z * 131072 + y) * 131072 + x;

  function demTemplates() {
    try {
      const dr = WM.demRelief;
      if (dr && dr.getConfig && dr.getSources) {
        const src = dr.getSources()[dr.getConfig().demSource];
        if (src && src.urls && src.urls.length) return src.urls.slice();
      }
    } catch (e) {}
    return DEFAULT_TEMPLATES.slice();
  }
  const demSourceId = () => { try { return (WM.demRelief && WM.demRelief.getConfig().demSource) || 'mapterhorn'; } catch (e) { return 'mapterhorn'; } };

  let scratchCv = null, scratchCtx = null;
  function decodeBitmap(bmp, Ssz) {
    if (!scratchCv || scratchCv.width !== Ssz) {
      scratchCv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(Ssz, Ssz) : document.createElement('canvas');
      scratchCv.width = Ssz; scratchCv.height = Ssz;
      scratchCtx = scratchCv.getContext('2d', { willReadFrequently: true });
    }
    scratchCtx.clearRect(0, 0, Ssz, Ssz);
    scratchCtx.drawImage(bmp, 0, 0, Ssz, Ssz);
    const px = scratchCtx.getImageData(0, 0, Ssz, Ssz).data;
    const out = new Uint16Array(Ssz * Ssz);
    for (let i = 0, o = 0; i < out.length; i++, o += 4) {
      if (px[o + 3] < 30) continue;
      const h = px[o] * 256.0 + px[o + 1] + px[o + 2] / 256.0 - 32768.0;
      if (h < -500.0) continue;
      const v = Math.round((h + 1000.0) * 4.0);
      out[i] = v < 1 ? 1 : (v > 65535 ? 65535 : v);
    }
    return out;
  }

  // Сборка обзорного DEM-тайла (z) из скачанных в офлайн-кэш дочерних тайлов (z+1)
  // Используется imageSmoothingEnabled = false, чтобы не искажать RGB-кодировку Terrarium
  async function downsampleCachedDemChildren(z, x, y) {
    if (z < 10 || z > 14) return null;
    if (!WM.offlineArea || typeof WM.offlineArea.readCachedBlob !== 'function') return null;

    const templates = demTemplates();
    let cv = null, ctx = null, found = 0;

    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = x * 2 + dx;
        const cy = y * 2 + dy;
        let blob = null;

        for (const tpl of templates) {
          const url = tpl.replace('{z}', z + 1).replace('{x}', cx).replace('{y}', cy);
          try {
            blob = await WM.offlineArea.readCachedBlob(url);
            if (blob) break;
          } catch (e) {}
        }
        if (!blob) continue;

        try {
          let bmp;
          try {
            bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          } catch (e) {
            bmp = await createImageBitmap(blob);
          }
          if (!cv) {
            cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(256, 256) : document.createElement('canvas');
            cv.width = 256; cv.height = 256;
            ctx = cv.getContext('2d');
            ctx.imageSmoothingEnabled = false;
          }
          ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, dx * 128, dy * 128, 128, 128);
          if (bmp.close) bmp.close();
          found++;
        } catch (e) {}
      }
    }

    if (!found || !cv) return null;
    return { S: 256, h: decodeBitmap(cv, 256) };
  }

  async function fetchOneTile(z, x, y) {
    if (tileLoaderHook) {
      const hooked = await tileLoaderHook(z, x, y);
      if (hooked) return hooked;
    }

    // В офлайне не ходим в сеть и не помечаем неподгруженные тайлы как "море"
    if (navigator.onLine === false) {
      return null;
    }

    const rawTemplates = demTemplates();
    const templates = NetHealth.rankUrls(rawTemplates);
    let saw404 = 0;
    let triedNet = 0;
    const targetS = demS || 256;

    for (const tpl of templates) {
      if (!NetHealth.isAvailable(tpl)) continue;
      if (/elevation-tiles-prod|nextzen/i.test(tpl) && z > 15) continue;

      triedNet++;
      const url = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const t0 = performance.now();
      const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      const to = ctl ? setTimeout(() => ctl.abort(), 3500) : null;

      try {
        const resp = await fetch(url, { mode: 'cors', signal: ctl ? ctl.signal : undefined });
        if (to) clearTimeout(to);

        if (resp.status === 404) {
          saw404++;
          NetHealth.reportSuccess(tpl, performance.now() - t0);
          continue; // Пробуем следующего провайдера!
        }
        if (!resp.ok) {
          NetHealth.reportFailure(tpl, resp.status >= 500 || resp.status === 429);
          continue;
        }

        const blob = await resp.blob();
        let bmp;
        try {
          bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        } catch (e) {
          bmp = await createImageBitmap(blob);
        }
        const h = decodeBitmap(bmp, targetS);
        if (bmp.close) bmp.close();

        // Проверяем, не пришёл ли полностью пустой/прозрачный тайл
        let hasValid = false;
        for (let i = 0; i < h.length; i += 17) {
          if (h[i] !== 0) { hasValid = true; break; }
        }
        if (!hasValid) {
          NetHealth.reportFailure(tpl, false);
          continue;
        }

        NetHealth.reportSuccess(tpl, performance.now() - t0);
        return { S: targetS, h };
      } catch (e) {
        if (to) clearTimeout(to);
        NetHealth.reportFailure(tpl, e.name === 'AbortError' || e.name === 'TypeError');
      }
    }

    // Помечаем тайл морем ТОЛЬКО если ВСЕ доступные провайдеры честно ответили 404
    if (triedNet > 0 && saw404 === triedNet) return { sea: true };
    return null;
  }
  // 2. Внутри функции init(mapInstance) в viewshed.js:
  // ЗАМЕНИТЕ старый tileLoaderHook на этот:

  async function ensureTile(z, x, y, serial) {
    const key = tileKey(z, x, y);
    const ex = tileStore.get(key);
    if (ex && ex.state !== 'fail') { ex.job = serial; return ex; }
    if (ex && ex.promise) return ex.promise;
    const t = { z, x, y, S: 0, h: null, state: 'loading', job: serial, promise: null };
    tileStore.set(key, t);
    t.promise = (async () => {
      let r = null;
      try { r = await fetchOneTile(z, x, y); } catch (e) { r = null; }
      if (!r) t.state = 'fail';
      else if (r.sea) t.state = 'sea';
      else { t.state = 'ok'; t.S = r.S; t.h = r.h; storeBytes += r.h.length * 2; }
      t.promise = null;
      return t;
    })();
    return t.promise;
  }

  function trimStore(currentSerial) {
    if (storeBytes <= STORE_MAX_BYTES) return;
    const arr = Array.from(tileStore.entries()).filter(([, t]) => t.state === 'ok' && t.job !== currentSerial);
    arr.sort((a, b) => a[1].job - b[1].job);
    for (const [k, t] of arr) {
      if (storeBytes <= STORE_MAX_BYTES * 0.75) break;
      storeBytes -= t.h.length * 2;
      tileStore.delete(k);
    }
  }

  function tilesForRing(lat0, lng0, z, dMin, dMax) {
    const n = Math.pow(2, z);
    const cosLat = Math.max(0.05, Math.cos(lat0 * DEG));
    const dLat = dMax / 111195.0, dLng = Math.min(179, dMax / (111195.0 * cosLat));
    const latN = Math.min(85.05, lat0 + dLat), latS = Math.max(-85.05, lat0 - dLat);
    const xa = Math.floor(((lng0 - dLng + 180) / 360) * n), xb = Math.floor(((lng0 + dLng + 180) / 360) * n);
    const ya = Math.max(0, Math.floor(mercY(latN) * n)), yb = Math.min(n - 1, Math.floor(mercY(latS) * n));
    const res = [];
    for (let ty = ya; ty <= yb; ty++) {
      const latC = mercLat((ty + 0.5) / n);
      const wM = 40075016.7 * Math.cos(latC * DEG) / n;
      const hd = 0.7072 * wM;
      for (let tx = xa; tx <= xb; tx++) {
        const lngC = ((tx + 0.5) / n) * 360 - 180;
        let dx = (lngC - lng0); dx = ((dx + 540) % 360) - 180;
        const ex = dx * 111195.0 * cosLat, ey = (latC - lat0) * 111195.0;
        const dc = Math.sqrt(ex * ex + ey * ey);
        if (dc + hd >= dMin && dc - hd <= dMax) res.push([((tx % n) + n) % n, ty]);
      }
    }
    return res;
  }

  async function ensureTileSize(lat0, lng0, serial) {
    if (demS) return demS;
    const z = 8, n = 1 << z;
    const t = await ensureTile(z, Math.floor(((lng0 + 180) / 360) * n), Math.floor(mercY(lat0) * n), serial);
    demS = (t && t.state === 'ok' && t.S) ? t.S : 256;
    return demS;
  }

  // ---------------------------------------------------------------------------
  // ВЫБОРКА ВЫСОТ ИЗ ТАЙЛОВ
  // ---------------------------------------------------------------------------
  const zoomForTexel = (targetM, latRad, Ssz) =>
    clamp(Math.round(Math.log2(156543.03392 * Math.cos(latRad) * (256 / Ssz) / targetM)), 3, 15);
  const texelMeters = (z, latRad, Ssz) => 156543.03392 * Math.cos(latRad) * (256 / Ssz) / Math.pow(2, z);

  function makeLevel(z, Ssz) {
    return { z, S: Ssz, W: Math.pow(2, z) * Ssz, lastKey: -1, lastTile: null };
  }
  function tileAt(L, tx, ty) {
    const key = tileKey(L.z, tx, ty);
    if (key === L.lastKey) return L.lastTile;
    const t = tileStore.get(key) || null;
    L.lastKey = key; L.lastTile = t;
    return t;
  }

  function texelRaw(L, ix, iy) {
    const W = L.W, Sx = L.S;
    if (iy < 0) iy = 0; else if (iy >= W) iy = W - 1;
    ix = ((ix % W) + W) % W;
    const tx = (ix / Sx) | 0, ty = (iy / Sx) | 0;
    const t = tileAt(L, tx, ty);
    if (!t) return NaN;
    if (t.state === 'sea') return 0;
    if (t.state !== 'ok' || !t.h) return NaN;
    const v = t.h[(iy - ty * Sx) * Sx + (ix - tx * Sx)];
    return v === 0 ? NaN : v * 0.25 - 1000.0;
  }

  let _max4 = 0;
  function sampleLevel(L, xn, yn) {
    const W = L.W, Sx = L.S;
    const px = xn * W - 0.5, py = yn * W - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    if (ix >= 0 && iy >= 0 && ix < W - 1 && iy < W - 1) {
      const tx = (ix / Sx) | 0, ty = (iy / Sx) | 0;
      const lx = ix - tx * Sx, ly = iy - ty * Sx;
      if (lx < Sx - 1 && ly < Sx - 1) {
        const t = tileAt(L, tx, ty);
        if (t && t.h) {
          const h = t.h, o = ly * Sx + lx;
          const a = h[o], b = h[o + 1], c = h[o + Sx], d = h[o + Sx + 1];
          if (a && b && c && d) {
            const top = a + (b - a) * fx, bot = c + (d - c) * fx;
            const m = a > b ? a : b, m2 = c > d ? c : d;
            _max4 = (m > m2 ? m : m2) * 0.25 - 1000.0;
            return (top + (bot - top) * fy) * 0.25 - 1000.0;
          }
        }
      }
    }
    const h00 = texelRaw(L, ix, iy), h10 = texelRaw(L, ix + 1, iy), h01 = texelRaw(L, ix, iy + 1), h11 = texelRaw(L, ix + 1, iy + 1);
    let sum = 0, cnt = 0, mx = -1e9;
    if (h00 === h00) { sum += h00; cnt++; if (h00 > mx) mx = h00; }
    if (h10 === h10) { sum += h10; cnt++; if (h10 > mx) mx = h10; }
    if (h01 === h01) { sum += h01; cnt++; if (h01 > mx) mx = h01; }
    if (h11 === h11) { sum += h11; cnt++; if (h11 > mx) mx = h11; }
    if (!cnt) { _max4 = NaN; return NaN; }
    _max4 = mx;
    const mean = sum / cnt;
    const a = h00 === h00 ? h00 : mean, b = h10 === h10 ? h10 : mean, c = h01 === h01 ? h01 : mean, d = h11 === h11 ? h11 : mean;
    return a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  // ---------------------------------------------------------------------------
  // PASS 1 — ГЕОМЕТРИЯ: Загрузка тайлов и выборка высот по лучам
  // ---------------------------------------------------------------------------
  const BAND_EDGES = [0, 1500, 6000, 20000, 60000, Infinity];
  const BAND_TEXEL = [10, 30, 60, 120, 240];

  function runSliced(token, n, body, budgetMs, onProgress, checkStride = 8) {
    const budget = budgetMs || 14;
    const mask = checkStride <= 1 ? 0 : (checkStride - 1);
    return new Promise((resolve) => {
      let i = 0, lastProg = 0;
      (function tick() {
        if (token !== pipeToken) return resolve(false);
        const t0 = nowMs();
        while (i < n) {
          body(i++);
          if ((i & mask) === 0 && nowMs() - t0 > budget) break;
        }
        if (onProgress) {
          const t = nowMs();
          if (t - lastProg > 120 || i >= n) { lastProg = t; onProgress(i / n); }
        }
        if (i >= n) return resolve(true);
        yieldTask(tick);
      })();
    });
  }

  async function loadTiles(list, token, onProgress) {
    let done = 0, fail = 0;
    const total = list.length;
    let next = 0;
    const serial = jobSerial;
    async function worker() {
      while (next < list.length) {
        if (token !== pipeToken) return;
        const [z, x, y] = list[next++];
        const t = await ensureTile(z, x, y, serial);
        if (!t || t.state === 'fail') fail++;
        done++;
        if (onProgress) onProgress(done, total);
      }
    }
    const ws = []; for (let i = 0; i < 8; i++) ws.push(worker());
    await Promise.all(ws);
    return { total, fail };
  }

  async function loadCanopyWithFallback(lat0, lng0, canopyMaxDistM, token, onProgressUpdate) {
    const STALL_TIMEOUT_MS = 8000;  // 8 с без прогресса — считаем, что источник завис
    const HARD_TIMEOUT_MS = 15000;  // 15 с максимум на одну версию

    const isResReady = (res) => (
      !!res && !res._timedOut && !res._aborted && (res.total === 0 || res.failed === 0)
    );

    const runAttempt = async (ver) => {
      const ac = (typeof AbortController === 'function') ? new AbortController() : null;
      const attemptStart = performance.now();
      let lastProgressAt = attemptStart;
      let lastDone = -1;
      let settled = false;

      onProgressUpdate(ver, 0, 0);

      const rawP = WM.canopy.loadCanopyArea(lat0, lng0, canopyMaxDistM, 13, {
        signal: ac ? ac.signal : undefined,
        onProgress: (done, total) => {
          if (settled || token !== pipeToken) return;
          if (done > lastDone || (lastDone < 0 && total > 0)) {
            lastDone = done;
            lastProgressAt = performance.now();
          }
          onProgressUpdate(ver, done, total);
        }
      }).then(async (res) => {
        if (settled || token !== pipeToken) return { _aborted: true };
        if (navigator.onLine === false && res && res.downloaded === 0 && res.cached === 0 && map) {
          const curZ = clamp(Math.round(map.getZoom()), 11, 15);
          if (curZ !== 13) {
            const altRes = await WM.canopy.loadCanopyArea(
              lat0, lng0, Math.min(canopyMaxDistM, 2500), curZ,
              { signal: ac ? ac.signal : undefined }
            ).catch(() => null);
            if (altRes && (altRes.downloaded > 0 || altRes.cached > 0)) res = altRes;
          }
        }
        return res;
      }).catch(() => null);

      let watchTimer = null;
      const watchdogP = new Promise((resolve) => {
        watchTimer = setInterval(() => {
          if (token !== pipeToken) {
            clearInterval(watchTimer);
            if (ac) ac.abort();
            resolve({ _aborted: true });
            return;
          }
          const now = performance.now();
          if (now - attemptStart >= HARD_TIMEOUT_MS || now - lastProgressAt >= STALL_TIMEOUT_MS) {
            clearInterval(watchTimer);
            if (ac) ac.abort();
            resolve({ _timedOut: true, _stalled: (now - lastProgressAt >= STALL_TIMEOUT_MS) });
          }
        }, 200);
      });

      const res = await Promise.race([rawP, watchdogP]);
      settled = true;
      clearInterval(watchTimer);
      return res;
    };

    const initialVer = (typeof WM.canopy.getVersion === 'function') ? WM.canopy.getVersion() : 'v1';
    const fallbackVer = (initialVer === 'v2') ? 'v1' : 'v2';
    const canFallback = (fallbackVer === 'v1') || !!WM.canopyV2;

    // Если выбрана v2, но модуль canopyV2 вообще не загружен — сразу уходим на v1
    if (initialVer === 'v2' && !WM.canopyV2 && typeof WM.canopy.setVersion === 'function') {
      WM.canopy.setVersion('v1', { skipViewshedSchedule: true });
      const resV1 = await runAttempt('v1');
      if (token !== pipeToken || (resV1 && resV1._aborted)) return { _aborted: true };
      return { ok: isResReady(resV1), res: resV1, version: 'v1', switchedFrom: 'v2' };
    }

    const res1 = await runAttempt(initialVer);
    if (token !== pipeToken || (res1 && res1._aborted)) return { _aborted: true };
    if (isResReady(res1)) {
      return { ok: true, res: res1, version: initialVer };
    }

    if (!canFallback || typeof WM.canopy.setVersion !== 'function') {
      return { ok: false, res: res1, version: initialVer };
    }

    // Автоматическое переключение v2 <-> v1
    const reason = (res1 && res1._timedOut) ? 'долго не отвечает' : 'ошибка загрузки';
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`🌲 Лес (${initialVer.toUpperCase()}): ${reason} — переключаюсь на ${fallbackVer.toUpperCase()}`, 3200);
    }

    WM.canopy.setVersion(fallbackVer, { skipViewshedSchedule: true });
    if (WM.canopy.getNetworkDiagnostics) {
      const diag = WM.canopy.getNetworkDiagnostics();
      ViewshedDiag.canopy.activeHost = diag.activeHost;
      ViewshedDiag.canopy.deadHosts = diag.deadHosts;
      ViewshedDiag.updateUI();
    }

    const res2 = await runAttempt(fallbackVer);
    if (token !== pipeToken || (res2 && res2._aborted)) return { _aborted: true };

    if (isResReady(res2)) {
      return { ok: true, res: res2, version: fallbackVer, switchedFrom: initialVer };
    }

    // Если не ответили оба источника (например, нет сети) — возвращаем настройку пользователя назад
    WM.canopy.setVersion(initialVer, { skipViewshedSchedule: true });
    return { ok: false, res: res2, version: fallbackVer, switchedFrom: initialVer };
  }

  async function buildGeometry(lat0, lng0, Rm, token, setStatus) {
    const Q = QUALITY[S.quality] || QUALITY.standard;
    const latRad = lat0 * DEG;
    const serial = ++jobSerial;

    // 1. Запускаем загрузку леса параллельно с DEM (с жёстким таймаутом 12 с и отменой по token)
    const canopyMaxDistM = Math.min(Rm, 6500.0);
    let cDone = 0, cTotal = 0, cFinished = false;
    let dDone = 0, dTotal = 0;

    let cVer = (WM.canopy && WM.canopy.getVersion) ? WM.canopy.getVersion() : 'v1';

    const reportLoadProgress = (force = false) => {
      if (token !== pipeToken) return;
      const partsHtml = [], partsMarker = [];
      if (dTotal > 0) {
        partsHtml.push(`DEM <b>${dDone}/${dTotal}</b>`);
        partsMarker.push(`DEM ${dDone}/${dTotal}`);
      }
      if (S.canopy && S.canopy.enabled && !cFinished) {
        const tag = `Лес ${cVer}`;
        if (cTotal > 0) {
          partsHtml.push(`${tag} <b>${cDone}/${cTotal}</b>`);
          partsMarker.push(`${tag} ${cDone}/${cTotal}`);
        } else {
          partsHtml.push(`${tag}…`);
          partsMarker.push(tag);
        }
      }
      if (!partsHtml.length) {
        setStatus && setStatus('⏳ Подготовка рельефа…');
        updateMarkerProgress('⏳ Рельеф', force);
      } else {
        setStatus && setStatus(`⏳ Загрузка: ${partsHtml.join(' · ')}…`);
        updateMarkerProgress(`⏳ ${partsMarker.join(' · ')}`, force);
      }
    };

    let canopyPromise = null;
    const canopyT0 = performance.now();

    if (S.canopy && S.canopy.enabled && WM.canopy && typeof WM.canopy.loadCanopyArea === 'function') {
      ViewshedDiag.canopy.status = 'loading';
      if (WM.canopy.getNetworkDiagnostics) {
        const diag = WM.canopy.getNetworkDiagnostics();
        ViewshedDiag.canopy.activeHost = diag.activeHost;
        ViewshedDiag.canopy.deadHosts = diag.deadHosts;
      }
      ViewshedDiag.updateUI();

      canopyPromise = loadCanopyWithFallback(lat0, lng0, canopyMaxDistM, token, (ver, done, total) => {
        cVer = ver;
        cDone = done;
        cTotal = total;
        reportLoadProgress(done >= total);
      }).then((outcome) => {
        cFinished = true;
        if (token !== pipeToken || !outcome || outcome._aborted) return { _aborted: true };

        const res = outcome.res;
        ViewshedDiag.canopy.loadMs = performance.now() - canopyT0;
        ViewshedDiag.canopy.tilesTotal = res?.total || cTotal || 0;
        ViewshedDiag.canopy.tilesDownloaded = res?.downloaded || 0;
        ViewshedDiag.canopy.tilesCached = res?.cached || 0;
        ViewshedDiag.canopy.tilesFailed = res?.failed || 0;
        if (WM.canopy.getNetworkDiagnostics) {
          const diag = WM.canopy.getNetworkDiagnostics();
          ViewshedDiag.canopy.activeHost = diag.activeHost || res?.activeHost || outcome.version;
          ViewshedDiag.canopy.deadHosts = diag.deadHosts;
        } else {
          ViewshedDiag.canopy.activeHost = res?.activeHost || outcome.version;
        }

        if (!outcome.ok) {
          ViewshedDiag.canopy.status = 'err';
          ViewshedDiag.canopy.maxTreeHeight = 0;
        } else {
          let maxH = 0;
          for (let deg = 0; deg < 360; deg += 30) {
            const p = destination(lat0, lng0, deg, 300);
            const h = getTreeHeightAt(p[0], p[1]);
            if (h > maxH) maxH = h;
          }
          ViewshedDiag.canopy.maxTreeHeight = maxH;
          ViewshedDiag.canopy.status = 'active';
        }
        ViewshedDiag.updateUI();
        return outcome;
      });
    } else if (!S.canopy || !S.canopy.enabled) {
      cFinished = true;
      ViewshedDiag.canopy.status = 'disabled';
      ViewshedDiag.canopy.activeHost = 'Отключено пользователем';
      ViewshedDiag.canopy.loadMs = 0;
      ViewshedDiag.updateUI();
    } else {
      cFinished = true;
      ViewshedDiag.canopy.status = 'err';
      ViewshedDiag.canopy.activeHost = 'Ошибка: WM.canopy недоступен';
      ViewshedDiag.canopy.loadMs = 0;
      ViewshedDiag.updateUI();
    }



    reportLoadProgress(true);

    await ensureTileSize(lat0, lng0, serial);
    if (token !== pipeToken) return null;
    const Ssz = demS;

    const nBands = 5;
    const zBand = [], stepBand = [];
    for (let b = 0; b < nBands; b++) {
      let z = zoomForTexel(BAND_TEXEL[b] * Q.texelScale, latRad, Ssz);
      if (b > 0 && z > zBand[b - 1]) z = zBand[b - 1];
      zBand.push(z);
      stepBand.push(Math.max(4, texelMeters(z, latRad, Ssz)));
    }
    let zFb = Math.min(zoomForTexel(480 * Q.texelScale, latRad, Ssz), zBand[nBands - 1] - 1);
    zFb = clamp(zFb, 3, 15);
    const levels = zBand.map(z => makeLevel(z, Ssz));
    const levelFb = makeLevel(zFb, Ssz);

    const distArr = [], bandArr = [];
    let d = stepBand[0];
    while (d <= Rm) {
      let b = 0; while (b < nBands - 1 && d >= BAND_EDGES[b + 1]) b++;
      distArr.push(d); bandArr.push(b);
      d += stepBand[b];
    }
    const nSteps = distArr.length;
    const dist = Float64Array.from(distArr);
    const band = Uint8Array.from(bandArr);
    const sinD = new Float64Array(nSteps), cosD = new Float64Array(nSteps);
    for (let i = 0; i < nSteps; i++) {
      const a = dist[i] / R_EARTH;
      sinD[i] = Math.sin(a);
      cosD[i] = Math.cos(a);
    }

    let nRays = Math.ceil(TAU * Rm / Q.cellFarM);
    nRays = Math.max(720, Math.min(nRays, Math.floor(Q.maxCells / nSteps)));
    nRays = (nRays + 3) & ~3;

    const want = new Map();
    const addRing = (z, dMin, dMax) => {
      tilesForRing(lat0, lng0, z, dMin, dMax).forEach(([x, y]) => want.set(tileKey(z, x, y), [z, x, y]));
    };
    for (let b = 0; b < nBands; b++) {
      if (BAND_EDGES[b] >= Rm) break;
      addRing(zBand[b], BAND_EDGES[b], Math.min(BAND_EDGES[b + 1], Rm) + stepBand[b] * 2);
    }
    addRing(zFb, 0, Rm + 500);
    const list = Array.from(want.values());
    list.sort((a, b) => b[0] - a[0]);

    dTotal = list.length;
    reportLoadProgress(true);

    const demT0 = performance.now();
    const loadTicker = setInterval(() => reportLoadProgress(false), 200);
    let res;
    try {
      res = await loadTiles(list, token, (done, total) => {
        dDone = done; dTotal = total;
        reportLoadProgress(done >= total);
      });
      if (token !== pipeToken) return null;

      // Дожидаемся леса, если DEM загрузился раньше (ограничено таймаутом 12 с выше)
      if (canopyPromise && !cFinished) {
        reportLoadProgress(true);
        await canopyPromise;
      }
    } finally {
      clearInterval(loadTicker);
    }
    let canopyOutcome = null;
    try {
      res = await loadTiles(list, token, (done, total) => {
        dDone = done; dTotal = total;
        reportLoadProgress(done >= total);
      });
      if (token !== pipeToken) return null;

      if (canopyPromise) {
        reportLoadProgress(true);
        canopyOutcome = await canopyPromise;
      }
    } finally {
      clearInterval(loadTicker);
    }
    if (token !== pipeToken) return null;

    if (S.canopy && S.canopy.enabled) {
      if (!canopyOutcome || canopyOutcome._aborted) return null;
      if (!canopyOutcome.ok) {
        return { _canopyFailed: true, canopyOutcome };
      }
    }
    if (token !== pipeToken) return null;

    ViewshedDiag.dem.loadMs = performance.now() - demT0;
    ViewshedDiag.dem.source = demSourceId() === 'mapterhorn' ? 'Mapterhorn (Copernicus + LiDAR)' : 'AWS Terrarium (Mapzen)';
    ViewshedDiag.dem.tilesRequested = res.total;
    ViewshedDiag.dem.tilesFailed = res.fail;
    ViewshedDiag.dem.status = res.fail > res.total * 0.5 ? 'err' : 'ok';
    ViewshedDiag.dem.hosts = demTemplates().map(u => {
      try { return new URL(u).host; } catch (e) { return u.slice(0, 20); }
    });
    ViewshedDiag.updateUI();

    levels.forEach(L => { L.lastKey = -1; L.lastTile = null; });
    levelFb.lastKey = -1; levelFb.lastTile = null;

    const x0 = (lng0 + 180) / 360, y0 = mercY(lat0);
    let obsGround = sampleLevel(levels[0], x0, y0);
    if (obsGround !== obsGround) obsGround = sampleLevel(levelFb, x0, y0);
    let obsMissing = false;
    if (obsGround !== obsGround) { obsGround = 0; obsMissing = true; }
    if (S.observerSnap) {
      const delta = 0.00025;
      const samples = [
        [delta, 0], [-delta, 0], [0, delta], [0, -delta],
        [delta, delta], [-delta, -delta], [delta, -delta], [-delta, delta]
      ];
      samples.forEach(([dLat, dLng]) => {
        const v = sampleLevel(levels[0], (lng0 + dLng + 180) / 360, mercY(lat0 + dLat));
        if (v === v && v > obsGround) obsGround = v;
      });
    }

    const hgt = new Float32Array(nRays * nSteps);
    const bonus = new Uint8Array(nRays * nSteps);
    const treeHgt = new Float32Array(nRays * nSteps);
    const phi0 = lat0 * DEG, lam0 = lng0 * DEG, sinP0 = Math.sin(phi0), cosP0 = Math.cos(phi0);
    const dTh = TAU / nRays;
    const peak = S.peakPreserve;

    const sinTArr = new Float64Array(nRays);
    const cosTArr = new Float64Array(nRays);
    for (let r = 0; r < nRays; r++) {
      const th = r * dTh;
      sinTArr[r] = Math.sin(th);
      cosTArr[r] = Math.cos(th);
    }

    const ok = await runSliced(token, nRays, (r) => {
      const sinT = sinTArr[r], cosT = cosTArr[r];
      const off = r * nSteps;
      let prevH = obsGround;
      for (let i = 0; i < nSteps; i++) {
        const sinP2 = sinP0 * cosD[i] + cosP0 * sinD[i] * cosT;
        const yn = 0.5 - Math.log((1 + sinP2) / (1 - sinP2)) * INV_4PI;
        let xn = (lam0 + Math.atan2(sinT * sinD[i] * cosP0, cosD[i] - sinP0 * sinP2) + Math.PI) * INV_2PI;
        xn -= Math.floor(xn);
        const b = band[i];
        let h = sampleLevel(levels[b], xn, yn), mx = _max4;
        if (h !== h) { h = sampleLevel(levelFb, xn, yn); mx = _max4; }
        if (h !== h) { h = prevH; mx = prevH; }
        hgt[off + i] = h;
        if (peak && b >= 2) {
          const bb = Math.round((mx - h) * 2);
          bonus[off + i] = bb < 0 ? 0 : (bb > 255 ? 255 : bb);
        }

        if (S.canopy && S.canopy.enabled && dist[i] <= canopyMaxDistM) {
          treeHgt[off + i] = getTreeHeightNorm(xn, yn);
        } else {
          treeHgt[off + i] = 0;
        }

        prevH = h;
      }
    }, 14, (p) => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Сбор рельефа и леса: <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Рельеф ${pct}%`);
    }, 1); // <-- checkStride = 1
    if (!ok) return null;

    trimStore(serial);
    const baseElev = lowlandElevation(hgt, dist, nRays, nSteps);

    return {
      key: geoKeyOf(lat0, lng0, Rm), lat0, lng0, Rm, nRays, nSteps, dTh, dist, band, sinD, cosD, hgt, bonus,
      treeHgt,
      obsGround, obsMissing, baseElev, zBand, zFb, stepBand, texelNear: stepBand[0],
      tiles: res.total, tilesFail: res.fail, demS: Ssz, levels, levelFb
    };
  }
  function lowlandElevation(hgt, dist, nRays, nSteps) {
    const BIN = 20, OFF = 1000, nb = 700;
    const hist = new Float64Array(nb);
    let total = 0;
    for (let r = 0; r < nRays; r += 3) {
      const off = r * nSteps;
      for (let i = 0; i < nSteps; i += 2) {
        const w = dist[i];
        const bi = clamp(Math.floor((hgt[off + i] + OFF) / BIN), 0, nb - 1);
        hist[bi] += w; total += w;
      }
    }
    let acc = 0;
    for (let b = 0; b < nb; b++) {
      acc += hist[b];
      if (acc >= total * 0.10) return b * BIN - OFF + BIN / 2;
    }
    return 0;
  }

  const geoKeyOf = (lat, lng, Rm) => {
    const canopyVer = (S.canopy && S.canopy.enabled && WM.canopy && typeof WM.canopy.getVersion === 'function')
      ? WM.canopy.getVersion()
      : '0';
    return [
      lat.toFixed(6), lng.toFixed(6), Math.round(Rm),
      S.quality, S.peakPreserve ? 1 : 0, S.observerSnap ? 1 : 0,
      S.canopy && S.canopy.enabled ? 1 : 0,
      canopyVer,
      demSourceId()
    ].join('|');
  };


    // ---------------------------------------------------------------------------
  // ГАРАНТИРОВАННАЯ БЛИЖНЯЯ ЗОНА ВИДИМОСТИ (ОТ 10 ДО 200 МЕТРОВ)
  // ---------------------------------------------------------------------------
  function computeGuaranteedNearRange(env, season, isObserverInForest) {
    // 1. Дневная базовая дальность при чистом небе (от 80 до 200 м)
    let baseM = 200.0; // Открытое поле / луг днем
    if (isObserverInForest) {
      if (season === 'winter') {
        baseM = 150.0; // День + солнце + зима + лес: 150 м (голые стволы)
      } else if (season === 'summer') {
        baseM = 80.0;  // День + солнце + лес (лето): 80 м (густая листва)
      } else {
        baseM = 110.0; // Межсезонье (весна/осень): 110 м
      }
    }

    // 2. Фактор естественной освещенности (Солнце, сумерки, Луна)
    let lightFactor = 1.0;
    if (env && env.sun) {
      const alt = env.sun.altDeg;
      if (alt > 2.0) {
        lightFactor = 1.0; // День
      } else if (alt > -12.0) {
        // Сумерки: плавное угасание
        const tTwilight = smooth(-12.0, 2.0, alt);
        lightFactor = lerp(0.35, 1.0, tTwilight);
      } else {
        // Глубокая ночь: фаза и высота Луны над горизонтом
        let moonLight = 0.0;
        if (env.sun.moonAltDeg > 0.0) {
          const mElev = smooth(0.0, 40.0, env.sun.moonAltDeg);
          const mPhase = Math.pow(clamp(env.sun.moonFrac || 0, 0, 1), 1.5);
          moonLight = mElev * mPhase; // 0.0 (новолуние) .. 1.0 (полнолуние в зените)
        }
        // Безлунной ночью - 0.25 от базы, в яркое полнолуние - до 0.65
        lightFactor = lerp(0.25, 0.65, moonLight);
      }
    }

    // 3. Фактор метеоусловий (туман, осадки, ночная облачность)
    let weatherFactor = 1.0;
    if (env) {
      if (env.fog && env.fog.on) {
        // Густой туман снижает видимость вдвое
        weatherFactor = 0.50;
      } else if (env.precip && env.precip.sigma > 0.05) {
        weatherFactor = clamp(1.0 - env.precip.sigma * 0.4, 0.6, 1.0);
      }

      // Ночью плотная облачность экранирует звездный и лунный свет
      if (env.wx && env.wx.cloudTot > 0.75 && (!env.sun || env.sun.altDeg <= -6.0)) {
        weatherFactor *= 0.75;
      }
    }

    // Ночь без луны + туман + лес: 80 * 0.25 * 0.50 = 10.0 м
    const finalRangeM = baseM * lightFactor * weatherFactor;
    return clamp(finalRangeM, 20.0, 200.0);
  }
  // ---------------------------------------------------------------------------
  // PASS 2 — ВИДИМОСТЬ: Минимальная высота цели над землёй (hReq, м)
  // ---------------------------------------------------------------------------
   async function computeVisibility(G, eyeH, k, token, setStatus) {
    const Reff = R_EARTH / (1.0 - k);
    const Ho = Reff + G.obsGround + eyeH;
    const n = G.nSteps;
    const cosE = new Float64Array(n), sinE = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = G.dist[i] / Reff;
      cosE[i] = Math.cos(a);
      sinE[i] = Math.sin(a);
    }
    const req = new Int16Array(G.nRays * n);
    const hgt = G.hgt, bonus = G.bonus, treeH = G.treeHgt;

    const season = getEffectiveSeason(lastEnv ? lastEnv.date : new Date());
    const isSummer = (season === 'summer');
    const isWinter = (season === 'winter');

    // Оценка растительности строго в точке наблюдателя (прогалина или лес)
    let obsTreeH = (S.canopy && S.canopy.enabled) ? getTreeHeightAt(G.lat0, G.lng0) : 0;
    const isObserverInForest = S.canopy && S.canopy.enabled && (obsTreeH >= 2.5);

    // Предел непрерывного хода луча сквозь лесную чащу вокруг наблюдателя
    const summerMaxPen = S.canopy.summerPenetrationM || 40.0;
    const winterMaxPen = S.canopy.winterPenetrationM || 85.0;
    let maxCanopyPenetrationM = isSummer ? summerMaxPen : (isWinter ? winterMaxPen : (summerMaxPen + winterMaxPen) * 0.5);

    if (lastEnv && (lastEnv.wx.rain > 0.1 || (lastEnv.fog && lastEnv.fog.on))) {
      maxCanopyPenetrationM *= (1.0 - (S.canopy.wetCanopyPenalty || 0.40));
    }

    const treeHeightMult = (isSummer ? 1.0 : (isWinter ? 0.80 : 0.90)) * (S.canopy.treeHeightFactor || 1.15);
    const guaranteedNearM = computeGuaranteedNearRange(lastEnv, season, isObserverInForest);

    const ok = await runSliced(token, G.nRays, (r) => {
      const off = r * n;
      let maxTan = -Infinity;

      let inObsForest = isObserverInForest;
      let forestAccumM = 0;
      let forestBlocked = false;

      for (let i = 0; i < n; i++) {
        const curDist = G.dist[i];
        const stepDist = (i === 0) ? curDist : (curDist - G.dist[i - 1]);
        const hTerrain = hgt[off + i];
        const rawTreeH = (treeH && S.canopy && S.canopy.enabled) ? treeH[off + i] : 0;
        const localTreeH = rawTreeH * treeHeightMult;

        const cE = cosE[i], sE = sinE[i];

        // 1. Проверка непрерывности леса вокруг наблюдателя:
        // Даже если склон уходит вниз, деревья растут вдоль него, пока не встретится явная прогалина/опушка
        const effCanopyPenetration = (lastEnv && lastEnv.lights && lastEnv.lights.on)
          ? maxCanopyPenetrationM * 1.6
          : maxCanopyPenetrationM;

        if (inObsForest) {
          if (localTreeH >= 2.0) {
            forestAccumM += stepDist;
            if (forestAccumM > effCanopyPenetration) {
              forestBlocked = true;
              inObsForest = false;
            }
          } else {
            inObsForest = false;
          }
        }

        // 2. Расчет требуемой высоты цели над рельефом
        let hr;
        if (forestBlocked && curDist > guaranteedNearM) {
          // За пределами ближней зоны чаща наглухо закрывает обзор
          hr = 7500;
        } else if (maxTan === -Infinity || curDist <= guaranteedNearM) {
          hr = -8000;
        } else {
          const den = cE - maxTan * sE;
          hr = den <= 1e-9 ? 8000 : (Ho / den - Reff - hTerrain);
          if (hr > 8000) hr = 8000; else if (hr < -8000) hr = -8000;
        }

        req[off + i] = Math.round(hr * 4);

        // 3. Препятствия для последующих точек луча (земля + кроны)
        let obstacleH = hTerrain;
        // Деревья перекрывают обзор только на дистанциях за пределами ближней зоны;
        // в ближней зоне взгляд идёт под пологом, препятствием выступает только сам рельеф
        if (S.canopy && S.canopy.enabled && curDist > guaranteedNearM) {
          obstacleH += localTreeH;
        }

        const hp = obstacleH + bonus[off + i] * 0.5;
        const Hr = Reff + hp;
        const tp = (Hr * cE - Ho) / (Hr * sE);
        if (tp > maxTan) maxTan = tp;
      }
    }, 14, (p) => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Расчёт лучей обзора: <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Лучи ${pct}%`);
    }, 1);

    if (!ok) return null;
    return { key: '', k, eyeH, req, Reff, season, guaranteedNearM };
  }
  // ---------------------------------------------------------------------------
  // ПОГОДА И АТМОСФЕРА
  // ---------------------------------------------------------------------------
  const WX_PRESETS = {
    clear:     { label: 'Ясно',                  cloudLow: 0.00, cloudMid: 0.00, cloudHigh: 0.05, RH: 50,  rain: 0,   snow: 0,   code: 0 },
    partly:    { label: 'Переменная облачность', cloudLow: 0.30, cloudMid: 0.20, cloudHigh: 0.30, RH: 60,  rain: 0,   snow: 0,   code: 2 },
    cloudy:    { label: 'Облачно',               cloudLow: 0.75, cloudMid: 0.50, cloudHigh: 0.50, RH: 75,  rain: 0,   snow: 0,   code: 3 },
    overcast:  { label: 'Пасмурно (сплошная)',   cloudLow: 1.00, cloudMid: 0.80, cloudHigh: 0.60, RH: 85,  rain: 0,   snow: 0,   code: 3 },
    haze:      { label: 'Дымка / мгла',          cloudLow: 0.10, cloudMid: 0.00, cloudHigh: 0.10, RH: 95,  rain: 0,   snow: 0,   code: 0 },
    fog:       { label: 'Туман',                 cloudLow: 1.00, cloudMid: 0.30, cloudHigh: 0.20, RH: 100, rain: 0,   snow: 0,   code: 45, fog: true, wind: 1 },
    drizzle:   { label: 'Морось',                cloudLow: 1.00, cloudMid: 0.60, cloudHigh: 0.40, RH: 92,  rain: 0.3, snow: 0,   code: 51 },
    rain:      { label: 'Дождь',                 cloudLow: 1.00, cloudMid: 0.80, cloudHigh: 0.60, RH: 93,  rain: 2.5, snow: 0,   code: 63 },
    heavyRain: { label: 'Ливень / гроза',        cloudLow: 1.00, cloudMid: 0.90, cloudHigh: 0.70, RH: 94,  rain: 12,  snow: 0,   code: 82, cape: 1500 },
    snow:      { label: 'Снегопад',              cloudLow: 1.00, cloudMid: 0.80, cloudHigh: 0.60, RH: 92,  rain: 0,   snow: 0.8, code: 73 }
  };
  const WX_VARS = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'rain', 'showers', 'snowfall', 'snow_depth', 'weather_code',
    'pressure_msl', 'surface_pressure', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'visibility', 'wind_speed_10m', 'wind_direction_10m', 'cape'];

  const WX_LS_KEY = 'wm_shared_wx_cache_v1';
  const WX_ONLINE_TTL = 30 * 60e3;
  const WX_OFFLINE_TTL = 7 * 24 * 3600e3;
  weatherCache = WM._sharedWxCache = WM._sharedWxCache || new Map();

  function loadWxCacheFromLS() {
    try {
      const now = Date.now();
      ['wm_viewshed_wx_cache_v1', 'wm_audibility_wx_cache_v1', WX_LS_KEY].forEach(kStore => {
        const obj = JSON.parse(localStorage.getItem(kStore) || '{}');
        Object.keys(obj).forEach(k => {
          if (obj[k] && obj[k].json && (now - obj[k].t < WX_OFFLINE_TTL)) {
            const prev = weatherCache.get(k);
            if (!prev || obj[k].t > prev.t) weatherCache.set(k, obj[k]);
          }
        });
      });
    } catch (e) {}
  }
  

  function saveWxCacheToLS() {
    try {
      const entries = Array.from(weatherCache.entries())
        .sort((a, b) => b[1].t - a[1].t)
        .slice(0, 5);
      const out = {};
      entries.forEach(([k, v]) => { out[k] = v; });
      localStorage.setItem(WX_LS_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  function findOfflineWeather(lat, lng) {
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    const exact = weatherCache.get(key);
    if (exact && (Date.now() - exact.t < WX_OFFLINE_TTL)) return exact.json;

    let best = null, bestD = 0.08; // Поиск ближайшей сохранённой точки (~25 км)
    const now = Date.now();
    weatherCache.forEach((entry, k) => {
      if (!entry || !entry.json || now - entry.t >= WX_OFFLINE_TTL) return;
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
    const c = weatherCache.get(key);
    if (c && Date.now() - c.t < WX_ONLINE_TTL) return c.json;

    if (navigator.onLine === false) {
      const off = findOfflineWeather(lat, lng);
      if (off) return off;
      throw new Error('Offline (no cached weather)');
    }

    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4) +
      '&hourly=' + WX_VARS.join(',') + '&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&past_days=3&forecast_days=7';

    if (!NetHealth.isAvailable(url)) {
      const off = findOfflineWeather(lat, lng);
      if (off) return off;
      throw new Error('Open-Meteo temporarily blocked/down');
    }

    const t0 = performance.now();
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), 2200) : null;

    try {
      const resp = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (to) clearTimeout(to);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (!json || !json.hourly || !json.hourly.time) throw new Error('Bad weather JSON');

      NetHealth.reportSuccess(url, performance.now() - t0);
      weatherCache.set(key, { t: Date.now(), json });
      saveWxCacheToLS();
      return json;
    } catch (e) {
      if (to) clearTimeout(to);
      NetHealth.reportFailure(url, true);
      const off = findOfflineWeather(lat, lng);
      if (off) return off;
      throw e;
    }
  }
  function wxAtTime(json, date) {
    const H = json.hourly, tt = H.time;
    if (!tt || tt.length < 2) return null;
    const t = date.getTime() / 1000;
    if (t < tt[0] - 5400 || t > tt[tt.length - 1] + 5400) return null;
    const i = clamp(Math.floor((t - tt[0]) / 3600), 0, tt.length - 2);
    const f = clamp((t - tt[i]) / (tt[i + 1] - tt[i]), 0, 1);
    const g = (name, def) => {
      const a = H[name]; if (!a) return def;
      const v0 = a[i], v1 = a[i + 1];
      if (v0 == null && v1 == null) return def;
      if (v0 == null) return v1; if (v1 == null) return v0;
      return v0 + (v1 - v0) * f;
    };
    const near = (name, def) => { const a = H[name]; if (!a) return def; const v = a[f < 0.5 ? i : i + 1]; return v == null ? def : v; };
    const cLow = clamp(g('cloud_cover_low', 0) / 100, 0, 1), cMid = clamp(g('cloud_cover_mid', 0) / 100, 0, 1), cHigh = clamp(g('cloud_cover_high', 0) / 100, 0, 1);
    const cTot = clamp(g('cloud_cover', 100 * (1 - (1 - cLow) * (1 - cMid) * (1 - cHigh))) / 100, 0, 1);
    return {
      source: 'online', stationElev: (typeof json.elevation === 'number') ? json.elevation : null,
      T: g('temperature_2m', 12), Td: g('dew_point_2m', 6), RH: g('relative_humidity_2m', 60),
      P: g('surface_pressure', 1013), Pmsl: g('pressure_msl', 1013),
      cloudLow: cLow, cloudMid: cMid, cloudHigh: cHigh, cloudTot: cTot,
      rain: Math.max(0, g('rain', 0) + g('showers', 0)), snow: Math.max(0, g('snowfall', 0)),
      code: near('weather_code', 0), visM: g('visibility', null), wind: Math.max(0, g('wind_speed_10m', 2)), cape: Math.max(0, g('cape', 0)),
      fog: false
    };
  }

  function presetWx(zLow, name) {
    const p = WX_PRESETS[name] || WX_PRESETS.clear;
    return {
      source: 'manual', stationElev: zLow, T: 15, Td: 15 - (100 - p.RH) / 5, RH: p.RH, P: 1013, Pmsl: 1013,
      cloudLow: p.cloudLow, cloudMid: p.cloudMid, cloudHigh: p.cloudHigh,
      cloudTot: 1 - (1 - p.cloudLow) * (1 - p.cloudMid) * (1 - p.cloudHigh),
      rain: p.rain, snow: p.snow, code: p.code, visM: null, wind: p.wind != null ? p.wind : 2, cape: p.cape || 0, fog: !!p.fog
    };
  }

  async function prepareEnvInputs(lat, lng) {
    // Включаем расчет, если включены тумблеры времени/погоды ЛИБО если выбран режим огней или авто
    const needsAtmosphere = S.time.enabled || S.wx.enabled || S.atm.targetKind === 'lights' || S.atm.targetKind === 'auto';
    if (!needsAtmosphere) {
      ViewshedDiag.wx.source = 'Выключено в настройках';
      ViewshedDiag.wx.status = 'off';
      ViewshedDiag.wx.loadMs = 0;
      ViewshedDiag.wx.detail = 'Атмосферная модель отключена';
      ViewshedDiag.wx.blocked = false;
      return null;
    }

    const custom = S.time.enabled && S.time.mode === 'custom' && S.time.ts;
    const date = custom ? new Date(S.time.ts) : new Date();
    // Солнце и луна рассчитываются всегда для честного порога ночного контраста
    const sun = sunInfo(date, lat, lng);
    let wx = null, note = '';

    if (S.wx.enabled) {
      if (S.wx.source === 'auto') {
        const t0 = performance.now();
        ViewshedDiag.wx.source = 'Open-Meteo (Онлайн)';
        try {
          const json = await fetchWeather(lat, lng);
          ViewshedDiag.wx.loadMs = performance.now() - t0;
          wx = wxAtTime(json, date);
          ViewshedDiag.wx.status = 'online';
          ViewshedDiag.wx.blocked = false;
          ViewshedDiag.wx.detail = `T: ${wx.T.toFixed(1)}°C, Влажность: ${Math.round(wx.RH)}%, Облачность: ${Math.round(wx.cloudTot * 100)}%`;
          if (!wx) note = 'на выбранное время нет прогноза — взят пресет «Ясно»';
        } catch (e) {
          ViewshedDiag.wx.loadMs = performance.now() - t0;
          ViewshedDiag.wx.status = 'fallback';
          ViewshedDiag.wx.blocked = true;
          ViewshedDiag.wx.detail = 'Сбой API Open-Meteo. Применён фоллбэк «Ясно»';
          note = 'погода недоступна (офлайн/таймаут) — взят пресет «Ясно»';
        }
      } else {
        ViewshedDiag.wx.source = `Ручной пресет (${S.wx.preset})`;
        ViewshedDiag.wx.status = 'manual';
        ViewshedDiag.wx.loadMs = 0;
        ViewshedDiag.wx.detail = `База облаков: ${S.wx.cloudBase}м, толщина: ${S.wx.cloudThick}м`;
        ViewshedDiag.wx.blocked = false;
      }
    }

    return { date, sun, wx, note };
  }

  const LUM_TAB = [[-90, -3.4], [-18, -3.2], [-15, -2.6], [-12, -1.9], [-9, -0.9], [-6, 0.35], [-3, 1.5], [0, 2.5], [3, 3.0], [10, 3.4], [30, 3.7], [90, 3.9]];
  function interpTab(tab, x) {
    if (x <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) {
      if (x <= tab[i][0]) { const t = (x - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]); return lerp(tab[i - 1][1], tab[i][1], t); }
    }
    return tab[tab.length - 1][1];
  }

  function glareMult(azDeg, sun, cTot) {
    if (!sun || sun.altDeg < -8) return 1;
    let dAz = Math.abs(azDeg - sun.azDeg); if (dAz > 180) dAz = 360 - dAz;
    const c = Math.cos(dAz * DEG);
    const front = Math.pow((1 + c) / 2, 3), back = Math.pow((1 - c) / 2, 2);
    const A = 3.0 * smooth(-8, 0, sun.altDeg) * (1 - 0.85 * smooth(10, 45, sun.altDeg)) * (1 - 0.6 * cTot);
    let m = 1 + A * front;
    m *= 1 - 0.22 * back * smooth(-2, 10, sun.altDeg);
    return m;
  }

  function deriveEnv(inp, G) {
    if (!inp) return null;
    const sun = inp.sun;
    const zLow = G.baseElev, zObs = G.obsGround + S.eyeHeight;
    const notes = [];
    let wx;
    if (S.wx.enabled) {
      if (S.wx.source === 'manual') wx = presetWx(zLow, S.wx.preset);
      else if (inp.wx) wx = inp.wx;
      else { wx = presetWx(zLow, 'clear'); if (inp.note) notes.push(inp.note); }
    } else {
      wx = presetWx(zLow, 'clear'); wx.RH = 55; wx.source = 'none';
    }
    const station = (wx.stationElev != null) ? wx.stationElev : zLow;
    const wind = wx.wind != null ? wx.wind : 2;
    const cTot = clamp(wx.cloudTot, 0, 1), cLow = clamp(wx.cloudLow, 0, 1), cMid = clamp(wx.cloudMid, 0, 1);

    const heat = sun ? Math.max(0, Math.sin(sun.altDeg * DEG)) : 0.55;
    const dailyHeat = sun ? Math.max(0.08, Math.sin(Math.max(0, sun.noonAltDeg) * DEG)) : 0.7;
    let depth = 120 + 1500 * Math.pow(heat, 0.7) * (0.35 + 0.65 * dailyHeat) * (1 - 0.6 * cTot);
    depth = clamp(Math.max(depth, 100 + 80 * wind), 80, 2600);
    const zBL = zLow + depth;

    let sigP = (wx.rain > 0 ? 0.365 * Math.pow(wx.rain, 0.63) : 0) + (wx.snow > 0 ? 1.4 * Math.pow(wx.snow, 0.9) : 0);
    if (wx.code >= 51 && wx.code <= 57 && sigP < 0.25) sigP = 0.25;

    const fogOn = !!wx.fog || wx.code === 45 || wx.code === 48 ||
      (wx.RH >= 98 && (wx.T - wx.Td) < 0.6 && wind < 3 && cLow > 0.8);
    const fog = { on: fogOn, top: zLow + clamp(300 - 35 * wind, 60, 300), sigma: wx.code === 48 ? 25 : 20 };

    const clouds = [];
    let lowBase = null, lowTop = null;
    if (cLow >= 0.03) {
      if (wx.source === 'manual' && S.wx.enabled) { lowBase = S.wx.cloudBase; lowTop = lowBase + S.wx.cloudThick; }
      else {
        lowBase = station + clamp(125 * (wx.T - wx.Td), 30, 2500);
        let th = 350 + 900 * cLow;
        if (wx.rain > 0.2 || wx.snow > 0.2) th += 600;
        if (wx.cape > 800) th *= 2.2;
        lowTop = lowBase + clamp(th, 200, 4000);
      }
      clouds.push({ name: 'low', zb: lowBase, zt: lowTop, c: cLow, D: cLow > 0.85 ? 40000 : 6000 });
    }
    if (cMid >= 0.03) {
      let mb = station + 2000; if (lowTop != null && lowTop + 300 > mb) mb = lowTop + 300;
      clouds.push({ name: 'mid', zb: mb, zt: mb + 800 + 600 * cMid, c: cMid, D: cMid > 0.85 ? 40000 : 15000 });
    }
    clouds.forEach(cl => { cl.lnk = -Math.log(1 - Math.min(cl.c, 0.995)); });
    const precip = { sigma: sigP, top: (lowBase != null && cLow > 0.2) ? lowBase : station + 1800 };

    const sigR0 = 0.0125;
    const V0 = clamp(S.atm.baseVisKm, 5, 400);
    const sigA0 = Math.max(0.002, 3.912 / V0 - sigR0);
    const rh = clamp(wx.RH / 100, 0.05, 0.99);
    const fRH = clamp(Math.pow((1 - rh) / 0.5, -0.6), 0.75, 8);
    const load = (wind < 2 ? 1.25 : (wind > 8 ? 0.7 : 1)) * (sigP > 0.3 ? 0.6 : 1);
    const trap = clamp(Math.pow(900 / depth, 0.35), 0.8, 1.6);
    let sigA = sigA0 * fRH * load * trap;
    if (wx.visM != null && wx.visM < 23500) sigA = Math.max(sigA, 3.912 / Math.max(0.05, wx.visM / 1000) - sigP - sigR0);
    const Hf = 1200;

    let k = S.baseK;
    if (sun && S.time.dynRefraction) {
      const heatK = heat * (1 - 0.6 * cTot) * (0.55 + 0.45 * dailyHeat);
      const night = smooth(5, -10, sun.altDeg);
      const stab = (1 - 0.9 * cTot) * (1 / (1 + wind / 3)) * night;
      k += -0.055 * heatK + 0.09 * stab;
    }
    if (S.wx.enabled) {
      const zMid = (G.obsGround + zLow) / 2;
      const Peff = (wx.Pmsl || 1013.25) * Math.exp(-zMid / 8400);
      const Tmid = (wx.T != null ? wx.T : 15) - 0.0065 * (zMid - station) + 273.15;
      k *= clamp((Peff / 1013.25) * Math.pow(288.15 / Tmid, 2), 0.6, 1.25);
    }
    k = clamp(k, 0.06, 0.26);

    let sigLocal = sigA * (zObs <= zBL ? 1 : Math.exp(-(zObs - zBL) / Hf)) + sigR0 * Math.exp(-zObs / 8000);
    if (fog.on && zObs <= fog.top) sigLocal += fog.sigma;
    if (sigP > 0 && zObs <= precip.top) sigLocal += sigP;
    let relation = '';
    const lowL = clouds.find(c => c.name === 'low');
    if (lowL && lowL.c >= 0.2) {
      if (zObs < lowL.zb) relation = 'below';
      else if (zObs <= lowL.zt) { relation = 'inside'; sigLocal += 50 * lowL.c; }
      else relation = 'above';
    }
    const midL = clouds.find(c => c.name === 'mid');
    if (midL && midL.c >= 0.2 && zObs >= midL.zb && zObs <= midL.zt) { relation = 'inside'; sigLocal += 50 * midL.c; }
    const localVisKm = 3.912 / Math.max(0.001, sigLocal);
    const dayRangeM = localVisKm * 1000.0;

    // Фоновая яркость небосвода L (кд/м²)
    let L;
    if (sun) {
      L = Math.pow(10, interpTab(LUM_TAB, sun.altDeg));
      if (sun.moonAltDeg > 0) {
        L += 0.05 * Math.pow(sun.moonFrac, 1.5) * Math.sin(Math.max(0, sun.moonAltDeg) * DEG);
      }
      L = Math.max(1e-4, L);
      L *= (1.0 - 0.75 * cTot * smooth(-8, 4, sun.altDeg));
    } else {
      L = 3000;
    }

    const epsRaw = 0.02 * (1 + Math.pow(1 / Math.max(1e-4, L), 0.7));
    const eps0 = clamp(epsRaw, 0.02, 0.35);
    const C0 = Math.max(0.4, 0.8 * (1 - 0.2 * cTot));

    const isDay = sun ? (sun.altDeg > 0.0) : true;

    let moonIllum = 0;
    if (sun && sun.moonAltDeg > -1.0) {
      const moonElev = smooth(-1.0, 35.0, sun.moonAltDeg);
      const moonPhase = Math.pow(clamp(sun.moonFrac, 0, 1), S.night.moonPhaseGamma || 1.5);
      moonIllum = moonElev * moonPhase;
    }

    const nCfg = S.night;
    let baseNightRangeM = lerp(nCfg.baseMoonlessM || 1500.0, nCfg.fullMoonMaxM || 20000.0, moonIllum);
    baseNightRangeM = Math.min(baseNightRangeM, dayRangeM);

    const twDepth = nCfg.twilightDepthDeg || -12.0;
    let nightRangeM = baseNightRangeM;
    if (sun) {
      if (sun.altDeg > 0.0) {
        nightRangeM = dayRangeM;
      } else if (sun.altDeg > twDepth) {
        const tTwilight = smooth(twDepth, 0.0, sun.altDeg);
        nightRangeM = lerp(baseNightRangeM, dayRangeM, tTwilight);
      } else {
        nightRangeM = baseNightRangeM;
      }
    }

    if (cTot > 0.3) {
      nightRangeM *= (1.0 - (nCfg.cloudScreeningPenalty || 0.75) * smooth(0.3, 0.95, cTot));
    }
    if (fog.on) {
      nightRangeM = Math.min(nightRangeM, Math.max(40.0, dayRangeM));
    } else if (sigP > 0.2) {
      nightRangeM = Math.min(nightRangeM, Math.max(60.0, dayRangeM));
    }

    let obsTreeH = (S.canopy && S.canopy.enabled) ? getTreeHeightAt(G.lat0, G.lng0) : 0;
    const isObsInForest = S.canopy && S.canopy.enabled && (obsTreeH >= 2.0);
    const season = getEffectiveSeason(inp ? inp.date : new Date());
    const guaranteedNearM = computeGuaranteedNearRange({ sun, wx, fog, precip }, season, isObsInForest);
    nightRangeM = Math.max(guaranteedNearM, nightRangeM);

    const objMax = new Float32Array(360);
    for (let a = 0; a < 360; a++) {
      const g = glareMult(a, sun, cTot);
      const val = Math.log(Math.max(1.01, C0 / (eps0 * g)));
      objMax[a] = Math.max(0.1, val);
    }

    // Режим цели (Auto / Object / Lights)
    const kind = S.atm.targetKind || 'auto';
    let lightsOn = false;
    let objOn = true;

    if (kind === 'lights') {
      lightsOn = true;
      objOn = false; // Строго только свет городов
    } else if (kind === 'object') {
      lightsOn = false;
      objOn = true;  // Строго только физические объекты/рельеф
    } else { // 'auto'
      lightsOn = !isDay || (sun && sun.altDeg < 5.0); // Включаются в сумерках и ночью
      objOn = true;
    }

    // Порог видимости огней по закону Эллисона:
    // Ночью Et ≈ 2e-7 лк, в сумерках ≈ 1e-5 лк, днем солнце слепит фон: Et ≈ 3e-4 лк
    const logL = Math.log10(Math.max(1e-4, L));
    const Et = Math.pow(10, -4.8 + 0.5 * (logL + 3.0));

    const lights = {
      on: lightsOn,
      I: S.atm.cityLight || 3e6, // Сила света в канделах (300k, 3M, 30M)
      Et: Et,
      isDay: isDay
    };

    const env = {
      date: inp.date, sun, wx, k, zLow, zObs, depth, zBL, Hf, sigA, sigR0, fog, clouds, precip, relation, localVisKm,
      L, eps0, C0, objMax, objOn, lights, notes, station, heat, kind,
      nightRangeM, isDay, guaranteedNearM
    };

    env.key = [
      Math.round(inp.date.getTime() / (S.time.mode === 'now' ? 600000 : 60000)),
      S.time.enabled ? 1 : 0, S.wx.enabled ? S.wx.source : 'off', S.wx.preset, S.wx.cloudBase, S.wx.cloudThick,
      S.atm.baseVisKm, S.atm.targetKind, S.atm.cityLight, S.time.dynRefraction ? 1 : 0, Math.round(zLow), Math.round(G.obsGround),
      wx.T != null ? wx.T.toFixed(1) : '', wx.RH != null ? Math.round(wx.RH) : '', wx.cloudLow.toFixed(2), wx.cloudMid.toFixed(2),
      wx.rain.toFixed(2), wx.snow.toFixed(2), wx.code, wx.wind.toFixed(1),
      wx.visM != null ? Math.round(wx.visM / 500) : ''
    ].join('|');

    return env;
  }

  function makeAtmosphere(env, k) {
    const Reff = R_EARTH / (1 - k);
    const a2 = 1 / (2 * Reff);
    const sigA = env.sigA, sigR0 = env.sigR0, zBL = env.zBL, Hf = env.Hf;
    const clouds = env.clouds, fog = env.fog, pr = env.precip, objMax = env.objMax;
    const lights = env.lights, objOn = env.objOn;

    function lenBelow(zA, b, d, level) {
      const disc = b * b - 4 * a2 * (zA - level);
      if (disc <= 0) return 0;
      const sq = Math.sqrt(disc);
      let s1 = (-b - sq) / (2 * a2), s2 = (-b + sq) / (2 * a2);
      if (s1 < 0) s1 = 0; if (s2 > d) s2 = d;
      return s2 > s1 ? s2 - s1 : 0;
    }
    function tau(zA, zB, dM, parts) {
      const dKm = dM * 0.001;
      const uA = zA - zBL, uB = zB - zBL, du = uB - uA;
      let meanG;
      if (Math.abs(du) < 1e-3) meanG = uA <= 0 ? 1 : Math.exp(-uA / Hf);
      else {
        const GA = uA <= 0 ? uA : Hf * (1 - Math.exp(-uA / Hf));
        const GB = uB <= 0 ? uB : Hf * (1 - Math.exp(-uB / Hf));
        meanG = Math.abs(GB - GA) / Math.abs(du);
      }
      const tAer = sigA * dKm * meanG + sigR0 * dKm * Math.exp(-(zA + zB) * 0.5 / 8000);
      const m = (zB - zA) / dM, b = m - dM * a2;
      let tF = 0, tP = 0, tC = 0;
      if (fog.on) tF = fog.sigma * lenBelow(zA, b, dM, fog.top) * 0.001;
      if (pr.sigma > 0) tP = pr.sigma * lenBelow(zA, b, dM, pr.top) * 0.001;
      for (let i = 0; i < clouds.length; i++) {
        const cl = clouds[i];
        const inside = lenBelow(zA, b, dM, cl.zt) - lenBelow(zA, b, dM, cl.zb);
        if (inside > 0.5) tC += cl.lnk * (1 + 1.27 * inside / cl.D);
      }
      if (parts) { parts.aer = tAer; parts.fog = tF; parts.precip = tP; parts.cloud = tC; }
      return tAer + tF + tP + tC;
    }
    function tauMax(dM, bin) {
      let m = -999.0;
      if (objOn) {
        if (env.isDay) {
          m = objMax[bin];
        } else {
          if (dM <= env.nightRangeM) {
            const distRatio = dM / env.nightRangeM;
            m = (1.0 - distRatio * distRatio) * 2.5;
          } else {
            const fade = smooth(env.nightRangeM * 1.25, env.nightRangeM * 0.95, dM);
            m = (fade > 0.01) ? 0.3 * fade : -999.0;
          }
        }
      }

      if (lights.on) {
        // Закон Эллисона: E = (I / d^2) * exp(-tau) >= Et => tau <= ln( I / (Et * d^2) )
        const dSafe = Math.max(5.0, dM);
        const illuminanceAtDistance = lights.I / (dSafe * dSafe);
        if (illuminanceAtDistance > lights.Et) {
          const tl = Math.log(illuminanceAtDistance / lights.Et);
          if (tl > m) m = tl;
        } else if (!objOn) {
          m = -1.0; // Огни физически слишком слабы для такой дистанции даже в вакууме
        }
      }
      return m;
    }
    return { tau, tauMax, Reff };
  }

  // ---------------------------------------------------------------------------
  // PASS 3 — ПОЛЯ ПИКСЕЛЕЙ (ОБРАТНАЯ ВЫБОРКА В МЕРКАТОРЕ)
  // ---------------------------------------------------------------------------
  function makeView(lat0, lng0, Rm, W) {
    const x0 = (lng0 + 180) / 360, y0 = mercY(lat0);
    let half = 0;
    for (let b = 0; b < 72; b++) {
      const [la, ln] = destination(lat0, lng0, b * 5, Rm);
      let dx = (ln + 180) / 360 - x0; dx = dx - Math.round(dx);
      half = Math.max(half, Math.abs(dx), Math.abs(mercY(la) - y0));
    }
    half *= 1.02;
    return {
      W, x0, y0, half,
      north: mercLat(y0 - half), south: mercLat(y0 + half),
      west: (x0 - half) * 360 - 180, east: (x0 + half) * 360 - 180
    };
  }

  const llToPx = (V, lat, lng) => {
    let dx = (lng + 180) / 360 - V.x0; dx = dx - Math.round(dx);
    return [((dx + V.half) / (2 * V.half)) * V.W, ((mercY(lat) - V.y0 + V.half) / (2 * V.half)) * V.W];
  };

  function polarLookup(G, V, dM, th, out) {
    const dist = G.dist, n = G.nSteps;
    let i0, w;
    if (dM <= dist[0]) { i0 = 0; w = 0; }
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dist[mid] <= dM) lo = mid; else hi = mid; }
      i0 = lo; w = (dM - dist[lo]) / (dist[hi] - dist[lo]);
      if (w > 1) w = 1;
    }
    const i1 = i0 + 1 < n ? i0 + 1 : i0;
    const rf = th / G.dTh;
    let r0 = Math.floor(rf);
    const wr = rf - r0;
    r0 = ((r0 % G.nRays) + G.nRays) % G.nRays;
    const r1 = (r0 + 1) % G.nRays;
    const a = r0 * n + i0, b = r0 * n + i1, c = r1 * n + i0, d = r1 * n + i1;
    const rq = V.req, hg = G.hgt;
    const q0 = rq[a] + (rq[b] - rq[a]) * w, q1 = rq[c] + (rq[d] - rq[c]) * w;
    out.hr = (q0 + (q1 - q0) * wr) * 0.25;
    const g0 = hg[a] + (hg[b] - hg[a]) * w, g1 = hg[c] + (hg[d] - hg[c]) * w;
    out.hg = g0 + (g1 - g0) * wr;
  }

  async function buildFields(G, Vis, env, token, setStatus) {
    const Q = QUALITY[S.quality] || QUALITY.standard;
    const W = Q.outSize;
    const V = makeView(G.lat0, G.lng0, G.Rm, W);
    V.req = Vis.req;
    const N = W * W;
    const fHr = new Float32Array(N).fill(NaN);
    const fMg = new Float32Array(N).fill(NaN);
    const fAz = new Uint16Array(N);
    const atm = env ? makeAtmosphere(env, Vis.k) : null;

    const phi0 = G.lat0 * DEG, sinP0 = Math.sin(phi0), cosP0 = Math.cos(phi0);
    // СОХРАНЯЕМ xnArr ДЛЯ ВСЕХ КОЛОНОК:
    const sinDl = new Float64Array(W), cosDl = new Float64Array(W), xnArr = new Float64Array(W);
    for (let u = 0; u < W; u++) {
      const xn = V.x0 + ((u + 0.5) / W - 0.5) * 2 * V.half;
      xnArr[u] = xn;
      const dl = (xn - V.x0) * TAU;
      sinDl[u] = Math.sin(dl); cosDl[u] = Math.cos(dl);
    }
    const tmp = { hr: 0, hg: 0 };
    const zA = G.obsGround + S.eyeHeight;
    const Rm = G.Rm;
    const azScale = 65535 / TAU;
    const pxM = (2.0 * V.half * R_EARTH) / W;
    const nearZoneLimitM = Math.max(
      env ? env.guaranteedNearM : (Vis ? Vis.guaranteedNearM : 60.0),
      pxM * 2.5,
      20.0
    );
    const canopyOn = !!(S.canopy && S.canopy.enabled);
    const baseTgtLimit = S.targetHeight + 50.0;

    const ok = await runSliced(token, W, (v) => {
      const yn = V.y0 + ((v + 0.5) / W - 0.5) * 2 * V.half;
      const lat = mercLat(yn) * DEG;
      const sinP = Math.sin(lat), cosP = Math.cos(lat);
      const row = v * W;
      for (let u = 0; u < W; u++) {
        const xn = xnArr[u];
        const cdl = cosDl[u], sdl = sinDl[u];
        const cc = sinP0 * sinP + cosP0 * cosP * cdl;
        const ang = Math.acos(cc > 1 ? 1 : (cc < -1 ? -1 : cc));
        const dM = ang * R_EARTH;
        if (dM > Rm) continue;
        let th = Math.atan2(sdl * cosP, cosP0 * sinP - sinP0 * cosP * cdl);
        if (th < 0) th += TAU;
        polarLookup(G, V, dM, th, tmp);
        let hr = tmp.hr;
        const isNearZone = (dM <= nearZoneLimitM);

        if (hr >= 7000) {
          if (!isNearZone) continue;
          hr = 0;
        }

        const idx = row + u;
        fHr[idx] = hr;
        fAz[idx] = (th * azScale) | 0;

        if (atm) {
          let effectiveTargetH = S.targetHeight;
          // Крона (<= 60 м) может расширить порог только в узком окне (targetHeight + 50 .. 110 м)
          if (canopyOn && hr > baseTgtLimit && hr <= 110.0) {
            const destTreeH = getTreeHeightNorm(xn, yn);
            if (destTreeH > effectiveTargetH) effectiveTargetH = destTreeH;
          }
          if (hr <= (effectiveTargetH + 50.0)) {
            const zB = tmp.hg + (hr > 0 ? hr : 0);
            const bin = ((th * RAD + 0.5) | 0) % 360;
            let optMargin = atm.tauMax(dM, bin) - atm.tau(zA, zB, dM);
            if (isNearZone && hr <= Math.max(0.5, S.targetHeight)) {
              optMargin = Math.max(optMargin, 3.0);
            }
            fMg[idx] = optMargin;
          }
        }
      }
      }, 14, (p) => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Построение карты видимости: <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Карта ${pct}%`);
    }, 1);
    if (!ok) return null;
    return { V, W, fHr, fMg, fAz, hasAtm: !!atm, atm };
  }

  // ---------------------------------------------------------------------------
  // PASS 4 — ОТРИСОВКА
  // ---------------------------------------------------------------------------
  let cvs = null, cctx = null, imgData = null, buf32 = null;
  function ensureCanvas(W) {
    if (cvs && cvs.width === W) return;
    cvs = document.createElement('canvas'); cvs.width = W; cvs.height = W;
    cctx = cvs.getContext('2d', { willReadFrequently: true });
    imgData = cctx.createImageData(W, W);
    buf32 = new Uint32Array(imgData.data.buffer);
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0x10b981;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const packABGR = (r, g, b, a) => ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
  const C_AQUA = [6, 182, 212], C_AMBER = [245, 158, 11], C_SLATE = [148, 163, 184];

  // ---------------------------------------------------------------------------
  // PASS 4 — ОТРИСОВКА
  // ---------------------------------------------------------------------------
  function paintFields(F) {
    ensureCanvas(F.W);
    const W = F.W, N = W * W;
    buf32.fill(0);
    const main = hexToRgb(S.color);
    const aMain = 140, aEdge = 120, aAmber = 140;
    const tH = S.targetHeight;
    const dimOutside = S.followCompass;
    const hdg = lastHeading;
    const hr = F.fHr, mg = F.fMg, az = F.fAz;
    const atmOn = F.hasAtm;
    const azToDeg = 360 / 65535;

    const isLightsOnlyMode = (S.atm.targetKind === 'lights');
    const isAutoLightsActive = (lastEnv && lastEnv.lights && lastEnv.lights.on);

    const C_CANOPY = [13, 148, 136];
    const C_LIGHTS = [251, 191, 36]; // Яркий тёплый янтарь огней (#fbbf24)
    const C_LIGHTS_CORE = [254, 240, 138]; // Бело-золотой центр мегаполиса (#fef08a)

    for (let i = 0; i < N; i++) {
      const h = hr[i];
      if (h !== h) continue;

      let r, g, b, a;

      if (isLightsOnlyMode) {
        // Режим «Только огни»: отображаются источники света на поверхности и на мачтах
        if (h > Math.max(tH, 15.0)) continue; // Перекрыто горой
        r = C_LIGHTS[0];
        g = C_LIGHTS[1];
        b = C_LIGHTS[2];
        a = 150;
      } else if (h <= 0) {
        // Чистая земля (объекты)
        const t = smooth(0, 4, -h);
        r = lerp(C_AQUA[0], main[0], t);
        g = lerp(C_AQUA[1], main[1], t);
        b = lerp(C_AQUA[2], main[2], t);
        a = lerp(aEdge, aMain, t);
      } else if (S.canopy && S.canopy.enabled && h <= 18.0 && S.targetHeight < h) {
        // Шапки леса
        r = C_CANOPY[0];
        g = C_CANOPY[1];
        b = C_CANOPY[2];
        a = 115;
      } else if (tH > 0 && h <= tH) {
        // Высокая цель
        r = C_AMBER[0];
        g = C_AMBER[1];
        b = C_AMBER[2];
        a = aAmber;
      } else {
        continue;
      }

      // Учет прозрачности атмосферы, темноты, тумана и дальности огней
      if (atmOn) {
        const m = mg[i];

        if (m === m) {
          if (m <= 0) {
            continue; // Не видно: туман, дождь или дистанция превысила закон Эллисона
          } else {
            const q = smooth(0, 2.0, m);
            a = Math.round(a * q);
            if (a < 5) continue;

            if (isLightsOnlyMode) {
              // В режиме огней интенсивный свет делает центр ярче
              const lightBloom = smooth(0.5, 12.0, m);
              r = lerp(C_LIGHTS[0], C_LIGHTS_CORE[0], lightBloom);
              g = lerp(C_LIGHTS[1], C_LIGHTS_CORE[1], lightBloom);
              b = lerp(C_LIGHTS[2], C_LIGHTS_CORE[2], lightBloom);
            } else if (isAutoLightsActive && m > 3.0) {
              // В авто-режиме ночью видимые огни слегка подсвечивают карту золотистым тоном
              r = lerp(r, C_LIGHTS[0], 0.45);
              g = lerp(g, C_LIGHTS[1], 0.35);
              b = lerp(b, C_LIGHTS[2], 0.15);
            } else if (lastEnv && !lastEnv.isDay) {
              // Ночные тени обычного рельефа
              r = lerp(C_SLATE[0], r, q * 0.6);
              g = lerp(C_SLATE[1], g, q * 0.6);
              b = lerp(C_SLATE[2], b, q * 0.85);
            }
          }
        } else if (lastEnv && (lastEnv.fog.on || lastEnv.relation === 'inside')) {
          continue;
        }
      }

      if (dimOutside) {
        let d = Math.abs(az[i] * azToDeg - hdg);
        if (d > 180) d = 360 - d;
        if (d > FOV_HALF) a *= 0.35;
      }

      buf32[i] = packABGR(r | 0, g | 0, b | 0, a | 0);
    }

    cctx.putImageData(imgData, 0, 0);
    drawOverlayDecor(cctx, F);
  }

  function drawOverlayDecor(c, F) {
    if (!geo) return;
    const V = F.V, W = F.W;
    const Rkm = geo.Rm / 1000;
    c.save();
    c.setLineDash([4, 5]);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.font = 'bold ' + Math.max(10, Math.round(W / 110)) + 'px monospace';
    c.textAlign = 'center';
    const intervals = Rkm > 60 ? [15, 30, 50, 75, 100, 150] : [5, 10, 15, 20, 30, 40, 50];
    intervals.forEach(km => {
      if (km >= Rkm) return;
      c.beginPath();
      for (let b = 0; b <= 180; b++) {
        const [la, ln] = destination(geo.lat0, geo.lng0, b * 2, km * 1000);
        const p = llToPx(V, la, ln);
        if (b === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]);
      }
      c.stroke();
      const pN = llToPx(V, ...destination(geo.lat0, geo.lng0, 0, km * 1000));
      c.fillText(km + ' км', pN[0], pN[1] + 12);
    });

    c.setLineDash([]);
    c.strokeStyle = 'rgba(16,185,129,0.75)'; c.lineWidth = 1.6;
    c.beginPath();
    for (let b = 0; b <= 180; b++) {
      const [la, ln] = destination(geo.lat0, geo.lng0, b * 2, geo.Rm);
      const p = llToPx(V, la, ln);
      if (b === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]);
    }
    c.stroke();

    if (S.followCompass) {
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.3;
      const p0 = llToPx(V, geo.lat0, geo.lng0);
      [-FOV_HALF, FOV_HALF].forEach(o => {
        const [la, ln] = destination(geo.lat0, geo.lng0, lastHeading + o, geo.Rm);
        const p = llToPx(V, la, ln);
        c.beginPath(); c.moveTo(p0[0], p0[1]); c.lineTo(p[0], p[1]); c.stroke();
      });
    }
    c.restore();
  }

  function publishOverlay(F, infoHtml) {
    cvs.toBlob((blob) => {
      if (!blob || !isActive) return;
      if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = URL.createObjectURL(blob);
      const V = F.V;
      const bounds = L.latLngBounds([V.south, V.west], [V.north, V.east]);
      if (!viewshedOverlay) {
        viewshedOverlay = L.imageOverlay(lastBlobUrl, bounds, { opacity: S.opacity, interactive: false, zIndex: 420 }).addTo(layerGroup);
      } else {
        viewshedOverlay.setUrl(lastBlobUrl);
        viewshedOverlay.setBounds(bounds);
        viewshedOverlay.setOpacity(S.opacity);
      }
      updateObserverMarker(geo.obsGround);
      if (infoHtml) setInfo(infoHtml);
    }, 'image/png');
  }

  // ---------------------------------------------------------------------------
  // ОТЧЁТЫ И ИНТЕРФЕЙСНЫЕ ТЕКСТЫ
  // ---------------------------------------------------------------------------
  function fmtDate(d) {
    try { return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return d.toISOString(); }
  }

  function describeEnv(env) {
    if (!env) return '';
    const parts = [];
    if (env.sun) {
      const s = env.sun;
      const phase = s.altDeg > 6 ? 'день' : (s.altDeg > -0.8 ? 'восход/закат' : (s.altDeg > -6 ? 'гражданские сумерки' : (s.altDeg > -12 ? 'навигационные сумерки' : (s.altDeg > -18 ? 'астрономические сумерки' : 'ночь'))));
      parts.push(`☀️ ${fmtDate(env.date)} · Солнце ${s.altDeg >= 0 ? '+' : ''}${s.altDeg.toFixed(1)}° (аз ${Math.round(s.azDeg)}°) · ${phase}`);
    }
    const w = env.wx;
    if (S.wx.enabled) {
      const src = w.source === 'online' ? 'Open-Meteo' : 'вручную';
      let t = `🌤️ Погода (${src}): облака ${Math.round(w.cloudTot * 100)}%`;
      if (w.T != null) t += ` · ${w.T.toFixed(0)}°C · RH ${Math.round(w.RH)}%`;
      if (w.rain > 0.05) t += ` · дождь ${w.rain.toFixed(1)} мм/ч`;
      if (w.snow > 0.05) t += ` · снег ${w.snow.toFixed(1)} см/ч`;
      if (env.fog.on) t += ` · ТУМАН до ${Math.round(env.fog.top)} м`;
      parts.push(t);
    }
    const low = env.clouds.find(c => c.name === 'low');
    if (low) {
      const rel = { below: 'вы ниже облаков', inside: '<b>вы ВНУТРИ облаков</b>', above: 'вы выше облаков' }[env.relation] || '';
      parts.push(`☁️ Нижний ярус: ${Math.round(low.zb)}–${Math.round(low.zt)} м · ${rel}`);
    }
    parts.push(`🌫️ Дымка до ~${Math.round(env.zBL)} м · видимость у вас ≈ ${env.localVisKm >= 10 ? Math.round(env.localVisKm) : env.localVisKm.toFixed(1)} км`);
    parts.push(`🔭 Рефракция k = ${env.k.toFixed(3)}`);
    env.notes.forEach(n => parts.push('⚠️ ' + n));
    return parts.join('<br>');
  }

  function setInfo(html) {
    const box = document.getElementById('viewshed-info-box');
    if (box) box.innerHTML = html;
  }

  function mainInfoLine() {
    const modeNames = { center: '🎯 Центр экрана', gps: '🛰️ GPS положение', manual: '📍 Точка на карте' };
    let s = `Источник: <b>${modeNames[originMode] || ''}</b> | Высота: <b>${Math.round(geo.obsGround)} м</b> (+${S.eyeHeight.toFixed(1)}) | Радиус: <b>${S.radiusKm} км</b> | Цель: <b>+${Math.round(S.targetHeight)} м</b>`;
    if (geo.tilesFail) {
      s += navigator.onLine === false
        ? ` | 📴 офлайн: ${geo.tilesFail}/${geo.tiles} тайлов вне кэша (уменьшите радиус)`
        : ` | ⚠️ тайлов недоступно: ${geo.tilesFail}/${geo.tiles}`;
    }
    if (geo.obsMissing) s += ' | ⚠️ нет DEM под наблюдателем';
    return s;
  }

  // ---------------------------------------------------------------------------
  // ТОЧЕЧНЫЙ АНАЛИЗ ЦЕЛИ С CANVAS-ГРАФИКОМ ПРЕПЯТСТВИЙ
  // ---------------------------------------------------------------------------
   function probe(latlng) {
    if (!geo || !vis || !fields) return null;
    const ll = L.latLng(latlng);
    const { d, bearing } = distBearing(geo.lat0, geo.lng0, ll.lat, ll.lng);
    const guaranteedNearM = vis.guaranteedNearM || (lastEnv ? lastEnv.guaranteedNearM : 80.0);

    const res = {
      latlng: ll,
      distKm: d / 1000,
      distMeters: d,
      bearing,
      inRange: d <= geo.Rm,
      isNearZone: d <= guaranteedNearM,
      guaranteedNearM,
      targetHeight: S.targetHeight,
      eyeHeight: S.eyeHeight,
      obsElev: geo.obsGround,
      k: vis.k,
      Reff: vis.Reff || (R_EARTH / (1.0 - vis.k))
    };
    if (!res.inRange) return res;

    const nSamples = Math.min(240, Math.max(40, Math.floor(d / 110)));
    const profDist = new Float64Array(nSamples + 1);
    const profH = new Float64Array(nSamples + 1);
    const profY = new Float64Array(nSamples + 1);
    const profCanopyY = new Float64Array(nSamples + 1);
    const profTree = new Float32Array(nSamples + 1);

    const Re = res.Reff;
    const zO = geo.obsGround + S.eyeHeight;
    const thRad = bearing * DEG;
    const probeTmp = { hr: 0, hg: 0 };

    for (let i = 0; i <= nSamples; i++) {
      const curD = (i / nSamples) * d;
      profDist[i] = curD;
      polarLookup(geo, fields.V, curD, thRad, probeTmp);
      const hGround = probeTmp.hg;
      profH[i] = hGround;

      const destLL = destination(geo.lat0, geo.lng0, bearing, curD);
      const tH = (S.canopy && S.canopy.enabled) ? getTreeHeightAt(destLL[0], destLL[1]) : 0;
      profTree[i] = tH;

      const curv = (curD * curD) / (2 * Re);
      profY[i] = hGround - curv;
      profCanopyY[i] = (hGround + tH) - curv;
    }

    const targetGroundH = profH[nSamples];
    res.terrain = targetGroundH;

    const yTopT = (targetGroundH + S.targetHeight) - (d * d) / (2 * Re);
    const yGrT = targetGroundH - (d * d) / (2 * Re);

    const obsTreeH = profTree[0];
    const isObsInForest = S.canopy && S.canopy.enabled && (obsTreeH >= 3.0);
    const season = getEffectiveSeason(lastEnv ? lastEnv.date : new Date());

    const summerPen = S.canopy.summerPenetrationM || 110.0;
    const winterPen = S.canopy.winterPenetrationM || 230.0;
    let maxPenetrationM = (season === 'summer' ? summerPen : (season === 'winter' ? winterPen : (summerPen + winterPen) * 0.5));
    if (lastEnv && (lastEnv.wx.rain > 0.1 || lastEnv.fog.on)) maxPenetrationM *= 0.65;

    let maxGroundExcess = -Infinity;
    let worstGroundIdx = -1;
    let maxCanopyExcess = -Infinity;
    let worstCanopyIdx = -1;
    let groundBlocked = false;



    const baseNearM = vis.guaranteedNearM || (lastEnv ? lastEnv.guaranteedNearM : 60.0);
    res.isNearZone = (d <= baseNearM);

    let inForest = isObsInForest;
    let forestPathM = 0;
    let blockedByForestExtinction = false;
    let forestBlockDist = 0;

    for (let i = 1; i <= nSamples; i++) {
      const curD = profDist[i];
      const stepD = curD - profDist[i - 1];
      const lineY = zO + (yTopT - zO) * (curD / d);
      const canopyY = (S.canopy && S.canopy.enabled) ? profCanopyY[i] : profY[i];

      // Проверка пробития лесного массива наблюдателя
      if (inForest) {
        if (profTree[i] >= 2.0) {
          forestPathM += stepD;
          if (forestPathM > maxPenetrationM) {
            blockedByForestExtinction = true;
            forestBlockDist = curD;
            inForest = false;
          }
        } else {
          // Встретилась поляна/опушка
          inForest = false;
        }
      }

      // Анализ препятствий между наблюдателем и целью
      if (i < nSamples) {
        const lineGrY = zO + (yGrT - zO) * (curD / d);
        
        // 1. Проверяем сам рельеф (земля блокирует землю)
        if (profY[i] > lineGrY + 0.05) {
          groundBlocked = true;
        }
        
        // 2. Деревья блокируют луч к земле ТОЛЬКО вне ближней зоны наблюдателя 
        // и не вплотную к самой цели (радиус опушки 25 м)
        if (S.canopy && S.canopy.enabled && curD > guaranteedNearM && curD < (d - 25.0)) {
          if (profCanopyY[i] > lineGrY + 0.05) {
            groundBlocked = true;
          }
        }

        const gExcess = profY[i] - lineY;
        if (gExcess > maxGroundExcess) {
          maxGroundExcess = gExcess;
          worstGroundIdx = i;
        }

        if (S.canopy && S.canopy.enabled) {
          const cExcess = profCanopyY[i] - lineY;
          if (cExcess > maxCanopyExcess) {
            maxCanopyExcess = cExcess;
            worstCanopyIdx = i;
          }
        }
      }
    }

    // Определение видимости
   const targetTreeH = (S.canopy && S.canopy.enabled) ? (profTree[nSamples] || 0) : 0;
    const isTargetInForest = targetTreeH >= 2.0;

    // Препятствие считается «локальным лесом цели», если оно находится 
    // в пределах 45 метров от самой точки цели
    const isBlockerAtDestination = worstCanopyIdx >= 0 && (d - profDist[worstCanopyIdx]) <= 45.0;

    if (maxGroundExcess > 0.05) {
      // 1. Реальное перекрытие твердым грунтом/хребтом
      res.geomVisible = false;
      res.groundVisible = false;
      res.canopyVisible = false;
      const bDist = profDist[worstGroundIdx];
      const bY = profY[worstGroundIdx];
      const reqSlope = (bY - zO) / bDist;
      res.requiredHeight = Math.max(0, (zO + reqSlope * d) - yGrT);
      res.hReq = res.requiredHeight;
      const tH = profTree[worstGroundIdx];
      res.blocker = {
        distance: bDist,
        groundElevation: profH[worstGroundIdx],
        treeHeight: tH,
        totalElevation: profH[worstGroundIdx] + tH,
        aboveLineM: maxGroundExcess,
        isTree: false,
        hasTreesOnRidge: tH >= 2.5,
        isLocalForest: false
      };
    } else if (blockedByForestExtinction && !res.isNearZone) {
      // 2. Сплошной лес вокруг самого наблюдателя поглотил луч
      res.geomVisible = false;
      res.groundVisible = false;
      res.canopyVisible = false;
      res.requiredHeight = 999;
      res.hReq = 999;
      res.blocker = {
        distance: forestBlockDist,
        groundElevation: profH[1],
        treeHeight: profTree[1],
        totalElevation: profH[1] + profTree[1],
        aboveLineM: 10.0,
        isTree: true,
        isLocalForest: true
      };
    } else if (maxCanopyExcess > 0.05 && !res.isNearZone && !isBlockerAtDestination) {
      // 3. Промежуточный лес на чужом холме по пути перекрыл горизонт
      res.geomVisible = false;
      res.groundVisible = false;
      res.canopyVisible = false;
      const bDist = profDist[worstCanopyIdx];
      const bY = profCanopyY[worstCanopyIdx];
      const reqSlope = (bY - zO) / bDist;
      res.requiredHeight = Math.max(0, (zO + reqSlope * d) - yGrT);
      res.hReq = res.requiredHeight;
      res.blocker = {
        distance: bDist,
        groundElevation: profH[worstCanopyIdx],
        treeHeight: profTree[worstCanopyIdx],
        totalElevation: profH[worstCanopyIdx] + profTree[worstCanopyIdx],
        aboveLineM: maxCanopyExcess,
        isTree: true,
        hasTreesOnRidge: false,
        isLocalForest: false
      };
    } else {
      // 4. Луч свободно дошёл до района цели!
      res.blocker = null;
      res.geomVisible = true;
      res.requiredHeight = 0;

      // Если луч перекрыт лишь листвой в самой точке цели:
      if (isTargetInForest || isBlockerAtDestination || groundBlocked) {
        res.groundVisible = false;
        res.canopyVisible = true;  // <-- ШАПКИ ДЕРЕВЬЕВ ВИДНЫ СВЕРХУ!
        res.hReq = Math.min(targetTreeH, 5.0);
      } else {
        res.groundVisible = true;
        res.canopyVisible = false;
        res.hReq = 0;
      }
    }

    res.profile = { dist: profDist, h: profH, y: profY, canopyY: profCanopyY, tree: profTree };

    if (fields.atm) {
      const zA = zO;
      const zB = targetGroundH + (res.hReq > 0 ? Math.min(res.hReq, S.targetHeight) : 0);
      const parts = {};
      const tau = fields.atm.tau(zA, zB, d, parts);
      const bin = Math.round(bearing) % 360;
      const tmax = fields.atm.tauMax(d, bin);
      res.tau = tau;
      res.tauMax = tmax;
      res.margin = tmax - tau;
      res.parts = parts;
      res.transmittance = Math.exp(-tau);

      // Проверка видимости огней по закону Эллисона
      if (lastEnv && lastEnv.lights && lastEnv.lights.on) {
        const dSafe = Math.max(5.0, d);
        const I = lastEnv.lights.I;
        const Et = lastEnv.lights.Et;
        const receivedE = (I / (dSafe * dSafe)) * res.transmittance;
        res.lightsVisible = res.geomVisible && (receivedE >= Et);
        res.lightsReceivedE = receivedE;
        res.lightsEt = Et;
      }

      res.visible = res.isNearZone || (res.geomVisible && res.margin > 0);
    } else {
      res.visible = res.geomVisible;
    }

    return res;
  }
  function renderProbeCanvas(r, cv, wCss, hCss) {
    if (!r || !r.profile || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(wCss * dpr);
    cv.height = Math.round(hCss * dpr);
    cv.style.width = wCss + 'px';
    cv.style.height = hCss + 'px';

    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, wCss, hCss);

    const P = 8;
    const W = wCss, H = hCss;
    const ds = r.profile.dist;
    const ys = r.profile.y;
    const cys = r.profile.canopyY || ys;
    const n = ds.length;
    const D = r.distMeters;
    const zO = r.obsElev + r.eyeHeight;
    const Re = r.Reff;
    const yTopT = (r.terrain + r.targetHeight) - (D * D) / (2 * Re);
    const yGrT = r.terrain - (D * D) / (2 * Re);

    // Безопасный сбор диапазона высот без NaN
    let validVals = [];
    for (let i = 0; i < n; i++) {
      if (isFinite(ys[i])) validVals.push(ys[i]);
      if (isFinite(cys[i])) validVals.push(cys[i]);
    }
    if (isFinite(zO)) validVals.push(zO);
    if (isFinite(yTopT)) validVals.push(yTopT);
    if (isFinite(yGrT)) validVals.push(yGrT);
    if (!validVals.length) validVals = [0, 50];

    let lo = Math.min(...validVals);
    let hi = Math.max(...validVals);
    const span = Math.max(25, hi - lo);
    lo -= span * 0.12;
    hi += span * 0.18;

    const X = (dist) => P + (W - 2 * P) * (dist / Math.max(1, D));
    const Y = (yVal) => H - P - (H - 2 * P) * ((yVal - lo) / (hi - lo));

    // Сетка дистанций
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    [0.25, 0.5, 0.75].forEach(f => {
      const x = X(D * f);
      c.moveTo(x, P); c.lineTo(x, H - P);
    });
    c.stroke();

    // Рельеф (земля)
    const grad = c.createLinearGradient(0, Y(hi), 0, H);
    grad.addColorStop(0, '#475569');
    grad.addColorStop(1, '#1e293b');
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(X(0), H);
    for (let i = 0; i < n; i++) c.lineTo(X(ds[i]), Y(ys[i]));
    c.lineTo(X(D), H);
    c.closePath();
    c.fill();

    // Линия поверхности земли
    c.strokeStyle = '#94a3b8';
    c.lineWidth = 1.3;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) c.moveTo(X(ds[i]), Y(ys[i]));
      else c.lineTo(X(ds[i]), Y(ys[i]));
    }
    c.stroke();

    // Слой крон деревьев
    let hasTrees = false;
    for (let i = 0; i < n; i++) {
      if (r.profile.tree && r.profile.tree[i] >= 1.5) { hasTrees = true; break; }
    }

    if (hasTrees) {
      c.fillStyle = 'rgba(16, 185, 129, 0.28)';
      c.beginPath();
      c.moveTo(X(0), Y(ys[0]));
      for (let i = 0; i < n; i++) c.lineTo(X(ds[i]), Y(cys[i]));
      for (let i = n - 1; i >= 0; i--) c.lineTo(X(ds[i]), Y(ys[i]));
      c.closePath();
      c.fill();

      c.strokeStyle = '#10b981';
      c.lineWidth = 1.6;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) c.moveTo(X(ds[i]), Y(cys[i]));
        else c.lineTo(X(ds[i]), Y(cys[i]));
      }
      c.stroke();
    }

    // Столбик цели
    c.strokeStyle = '#f59e0b';
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(X(D), Y(yGrT));
    c.lineTo(X(D), Y(yTopT));
    c.stroke();

    // Линия взгляда (Line of Sight)
    c.strokeStyle = r.geomVisible ? '#10b981' : (r.blocker?.isTree ? '#f97316' : '#ef4444');
    c.lineWidth = 1.8;
    c.setLineDash([4, 3]);

    if (r.groundVisible) {
      // Прямая видимость земли
      c.strokeStyle = '#10b981';
      c.beginPath();
      c.moveTo(X(0), Y(zO));
      c.lineTo(X(D), Y(yGrT));
      c.stroke();
    } else if (r.canopyVisible) {
      // ВИДНЫ ШАПКИ ДЕРЕВЬЕВ:
      // Луч к верхушке крон рисуем сплошным/бирюзовым (он доходит беспрепятственно!)
      const yCanopyT = (r.terrain + (r.profile.tree[n - 1] || 5)) - (D * D) / (2 * Re);
      c.strokeStyle = '#06b6d4'; // Циан / морская волна
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(X(0), Y(zO));
      c.lineTo(X(D), Y(yCanopyT));
      c.stroke();

      // А непросматриваемый срез под крону к земле — пунктиром
      c.strokeStyle = 'rgba(249, 115, 22, 0.6)';
      c.setLineDash([2, 3]);
      c.beginPath();
      c.moveTo(X(D), Y(yCanopyT));
      c.lineTo(X(D), Y(yGrT));
      c.stroke();
    } else {
      // Перекрыто промежуточным препятствием
      c.strokeStyle = r.blocker?.isTree ? '#f97316' : '#ef4444';
      c.beginPath();
      c.moveTo(X(0), Y(zO));
      c.lineTo(X(D), Y(yTopT));
      c.stroke();
    }

    c.setLineDash([]);

    // Наблюдатель
    c.fillStyle = '#38bdf8';
    c.beginPath();
    c.arc(X(0), Y(zO), 4, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1.5;
    c.stroke();

    // Точка препятствия (оранжевый/зеленый кружок — листва, красный — скала/холм)
    if (r.blocker && !r.geomVisible) {
      const bX = X(r.blocker.distance);
      const bYVal = r.blocker.isTree
        ? (r.blocker.totalElevation - (r.blocker.distance * r.blocker.distance) / (2 * Re))
        : (r.blocker.groundElevation - (r.blocker.distance * r.blocker.distance) / (2 * Re));
      const bY = Y(bYVal);

      c.fillStyle = r.blocker.isTree ? '#f97316' : '#ef4444';
      c.beginPath();
      c.arc(bX, bY, 5, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.stroke();
    }

    // Подписи
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.font = '9px ui-monospace, SFMono-Regular, monospace';
    c.textAlign = 'left';
    c.fillText(`Вы: ${Math.round(zO)} м`, P + 4, P + 9);

    if (hasTrees) {
      c.fillStyle = '#10b981';
      c.fillText('— Кроны (Meta CHM)', P + 70, P + 9);
    }

    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.textAlign = 'right';
    c.fillText(`${r.distKm.toFixed(1)} км`, W - P, H - P - 3);
    c.restore();
  }

  function showProbe(latlng) {
    if (!map) return null;
    const r = probe(latlng);
    if (!r) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Сначала включите расчёт зоны видимости');
      return null;
    }

    if (!r.inRange) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`Цель вне радиуса расчёта (${r.distKm.toFixed(1)} км)`);
      return r;
    }

    if (probePopup) {
      try { map.closePopup(probePopup); } catch (e) {}
      probePopup = null;
    }

    const km = r.distKm.toFixed(1);
    const az = Math.round(r.bearing);
    let statusText = '';
    let complicationNote = '';

    // Оценка факторов усложнения видимости
    const env = lastEnv;
    const compReasons = [];
    if (r.profile && r.profile.tree[0] >= 3.0) compReasons.push('лесным пологом');
    if (env) {
      if (env.fog && env.fog.on) compReasons.push('туманом');
      else if (env.precip && env.precip.sigma > 0.1) compReasons.push('осадками');
      if (!env.isDay) {
        compReasons.push(env.sun && env.sun.altDeg > -12 ? 'сумерками' : 'ночной темнотой');
      }
    }

    if (r.isNearZone && r.groundVisible) {
      statusText = `<span style="color:#10b981;font-weight:700;">👁️ Ближняя зона обзора (${Math.round(r.distMeters)} м)</span>`;
    } else if (r.groundVisible) {
      statusText = `<span style="color:#10b981;font-weight:700;">✅ Земля видна</span> (прямая видимость грунта)`;
    } else if (r.canopyVisible) {
      // ИНФОРМАТИВНЫЙ СТАТУС ВМЕСТО ОШИБОЧНОГО ПЕРЕКРЫТИЯ:
      statusText = `<span style="color:#06b6d4;font-weight:700;">🌲 Виден полог леса (верхушки крон)</span>`;
      complicationNote = `
        <div style="margin-top:4px;padding:5px 8px;background:rgba(6,182,212,0.12);border-left:3px solid #06b6d4;border-radius:4px;font-size:11px;color:#e0f2fe;">
          Лесной массив в низине <b>полностью открыт для обзора</b> с вашей высоты (${Math.round(r.obsElev + r.eyeHeight)} м). Поверхность грунта под деревьями скрыта кронами (~${Math.round(r.profile.tree[r.profile.tree.length - 1] || 5)} м).
        </div>`;
    } else if (r.geomVisible) {
      statusText = `<span style="color:#f59e0b;font-weight:700;">🟠 Видна приподнятая цель</span> (+${Math.round(r.targetHeight)} м)`;
    } else {
      if (r.blocker && r.blocker.isTree) {
        statusText = `<span style="color:#f97316;font-weight:700;">🌳 Перекрыто промежуточным лесом</span>`;
      } else {
        statusText = `<span style="color:#ef4444;font-weight:700;">⛰️ Закрыто рельефом местности</span>`;
      }
    }

    let blockerText = '';
    if (r.blocker && !r.geomVisible && !r.isNearZone) {
      const bKm = (r.blocker.distance / 1000).toFixed(1);
      const bDistM = Math.round(r.blocker.distance);
      const distLabel = bDistM < 1000 ? `${bDistM} м` : `${bKm} км`;

      if (r.blocker.isLocalForest) {
        blockerText = `
          <div style="margin-top:3px;padding:4px 8px;background:rgba(249,115,22,0.12);border-left:3px solid #f97316;border-radius:4px;font-size:11px;color:#cbd5e1;">
            🌲 <b>Вы находитесь внутри леса</b>.<br>
            В этом направлении сплошной лесной массив поглощает обзор на удалении <b>~${distLabel}</b>.
          </div>`;
      } else if (r.blocker.isTree) {
        blockerText = `
          <div style="margin-top:3px;padding:4px 8px;background:rgba(249,115,22,0.12);border-left:3px solid #f97316;border-radius:4px;font-size:11px;color:#cbd5e1;">
            🌲 <b>Препятствие: лесной покров (${distLabel})</b>.<br>
            Сам рельеф луч не срезает, но кроны деревьев (высота леса ~${Math.round(r.blocker.treeHeight)} м) перекрывают обзор на <b>+${Math.round(r.blocker.aboveLineM)} м</b>.
          </div>`;
      } else {
        const ridgeForestExtra = r.blocker.hasTreesOnRidge
          ? `<br><span style="color:#94a3b8;">(на хребте также растёт лес высотой ~${Math.round(r.blocker.treeHeight)} м)</span>`
          : '';
        blockerText = `
          <div style="margin-top:3px;padding:4px 8px;background:rgba(239,68,68,0.12);border-left:3px solid #ef4444;border-radius:4px;font-size:11px;color:#cbd5e1;">
            ⛰️ <b>Препятствие: склон / хребет (${distLabel})</b>.<br>
            Поверхность земли (${Math.round(r.blocker.groundElevation)} м) превышает луч взгляда на <b>+${Math.round(r.blocker.aboveLineM)} м</b>.${ridgeForestExtra}
          </div>`;
      }
    }

    let lightsStatusText = '';
    if (lastEnv && lastEnv.lights && lastEnv.lights.on && r.inRange) {
      const lightName = S.atm.cityLight >= 25e6 ? 'мегаполиса' : (S.atm.cityLight >= 2e6 ? 'города' : 'посёлка');
      if (r.lightsVisible) {
        lightsStatusText = `
          <div style="margin-top:4px;padding:4px 8px;background:rgba(245,158,11,0.15);border-left:3px solid #f59e0b;border-radius:4px;font-size:11px;color:#fef08a;">
            🏙️ <b>Огни ${lightName} видны!</b> (освещенность ${(r.lightsReceivedE * 1e6).toFixed(1)} мклк при пороге ${(r.lightsEt * 1e6).toFixed(2)} мклк).
          </div>`;
      } else if (!r.geomVisible) {
        lightsStatusText = `
          <div style="margin-top:4px;padding:4px 8px;background:rgba(239,68,68,0.12);border-left:3px solid #ef4444;border-radius:4px;font-size:11px;color:#cbd5e1;">
            🏙️ Огни ${lightName} <b>заслонены рельефом</b>.
          </div>`;
      } else {
        lightsStatusText = `
          <div style="margin-top:4px;padding:4px 8px;background:rgba(239,68,68,0.12);border-left:3px solid #ef4444;border-radius:4px;font-size:11px;color:#cbd5e1;">
            🏙️ Огни ${lightName} <b>не видны из-за ${lastEnv.isDay ? 'яркого дневного света' : 'тумана/осадков'}</b>.
          </div>`;
      }
    }

    let atmoText = '';
    if (r.tau != null && !r.isNearZone) {
      const ok = r.margin > 0;
      const t = r.tau.toFixed(2), tMax = Math.max(0, r.tauMax).toFixed(2);
      const passPct = (r.transmittance * 100).toFixed(r.transmittance < 0.05 ? 1 : 0);
      atmoText = `
        <div style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--border);font-size:10.5px;">
          🌫️ Оптика: τ=${t} (порог ≤${tMax}, свет ${passPct}%) — ${ok ? '<b style="color:#10b981;">просматривается</b>' : '<b style="color:#ef4444;">скрыто дымкой/сумерками</b>'}
        </div>`;
    }

    const wrap = document.createElement('div');
    wrap.className = 'wm-viewshed-probe-popup';
    wrap.innerHTML = `
      <div style="min-width:275px;max-width:325px;font:11.5px/1.35 system-ui,sans-serif;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <b style="font-size:12.5px;">🎯 Анализ цели: ${km} км</b>
          <span style="font-size:11px;font-family:monospace;color:var(--text-muted);">${az}°</span>
        </div>
        <div>${statusText}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Рельеф цели: <b>${Math.round(r.terrain)} м</b> · Наблюдатель: <b>${Math.round(r.obsElev + r.eyeHeight)} м</b></div>
        ${complicationNote}
        ${blockerText}
        ${lightsStatusText}
        <canvas class="wm-vs-profile-canvas" style="width:280px;height:120px;margin-top:6px;border-radius:6px;background:#0f172a;display:block;"></canvas>
        ${atmoText}
      </div>
    `;

    const cv = wrap.querySelector('canvas');
    renderProbeCanvas(r, cv, 280, 120);

    probePopup = L.popup({
      maxWidth: 350,
      className: 'wm-viewshed-leaflet-popup',
      closeOnClick: false,
      autoClose: false
    })
      .setLatLng(latlng)
      .setContent(wrap)
      .openOn(map);

    return r;
  }

  // ---------------------------------------------------------------------------
  // МАРКЕР НАБЛЮДАТЕЛЯ
  // ---------------------------------------------------------------------------

  let _lastMarkerProgAt = 0;
  let _lastMarkerLabel = '';
  function updateMarkerProgress(label, force = false) {
    if (!observerLL || !layerGroup) return;
    const now = nowMs();
    if (!force && label === _lastMarkerLabel && now - _lastMarkerProgAt < 120) return;
    if (!force && now - _lastMarkerProgAt < 90) return;
    _lastMarkerProgAt = now;
    _lastMarkerLabel = label;
    const dots = '.'.repeat((Math.floor(now / 350) % 3) + 1);
    const sameSpot = geo && geo.obsGround != null &&
      Math.abs(geo.lat0 - observerLL.lat) < 1e-5 &&
      Math.abs(geo.lng0 - observerLL.lng) < 1e-5;
    updateObserverMarker(`${label}${dots}`, true, sameSpot ? geo.obsGround : null);
  }

  function updateObserverMarker(statusOrElev, isStatus = false, elevVal = null) {
    if (!observerLL || !layerGroup) return;
    const isDraggable = (originMode === 'manual');

    let badgeHtml = '';
    let isBusy = false;

    if (isStatus || typeof statusOrElev === 'string') {
      isBusy = true;
      if (elevVal !== null && typeof elevVal === 'number') {
        badgeHtml = `${Math.round(elevVal + S.eyeHeight)} м<span class="wm-vs-badge-sub" style="display:block;font-size:8.5px;color:#facc15;font-weight:normal;margin-top:1px;">${statusOrElev}</span>`;
      } else {
        badgeHtml = String(statusOrElev);
      }
    } else if (typeof statusOrElev === 'number' && !isNaN(statusOrElev)) {
      badgeHtml = `${Math.round(statusOrElev + S.eyeHeight)} м`;
    } else {
      badgeHtml = '…';
    }

    const iconHtml = `
      <div class="wm-viewshed-observer-pin ${isDraggable ? 'is-draggable' : ''} ${isBusy ? 'is-busy' : ''}">
        <div class="wm-viewshed-pulse"></div>
        <div class="wm-viewshed-dot">${originMode === 'gps' ? '🛰️' : (originMode === 'manual' ? '📍' : '👁️')}</div>
        <div class="wm-viewshed-badge ${isBusy ? 'status-mode' : ''}">${badgeHtml}</div>
      </div>`;

    if (!observerMarker) {
      observerMarker = L.marker(observerLL, {
        icon: L.divIcon({ className: 'wm-viewshed-div-icon', html: iconHtml, iconSize: [32, 32], iconAnchor: [16, 16] }),
        draggable: isDraggable, interactive: isDraggable, zIndexOffset: 2000
      }).addTo(layerGroup);
      observerMarker.on('dragend', (e) => {
        if (originMode === 'manual') {
          observerLL = e.target.getLatLng();
          updateObserverMarker('⏳ Расчёт…', true);
          scheduleCompute();
        }
      });
    } else {
      observerMarker.setLatLng(observerLL);
      if (observerMarker.dragging) {
        if (isDraggable) observerMarker.dragging.enable(); else observerMarker.dragging.disable();
      }
      const el = observerMarker.getElement && observerMarker.getElement();
      const b = el && el.querySelector('.wm-viewshed-badge');
      if (el && b) {
        b.innerHTML = badgeHtml;
        b.classList.toggle('status-mode', isBusy);
        el.querySelector('.wm-viewshed-observer-pin')?.classList.toggle('is-busy', isBusy);
      } else {
        observerMarker.setIcon(L.divIcon({
          className: 'wm-viewshed-div-icon',
          html: iconHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        }));
      }
    }
  }

  function setObserver(latlng) {
    const ll = L.latLng(latlng);
    const t = nowMs();
    if (lastSetObserverLL && t - lastSetObserverAt < 300 &&
        Math.abs(ll.lat - lastSetObserverLL.lat) < 1e-6 && Math.abs(ll.lng - lastSetObserverLL.lng) < 1e-6) return;
    lastSetObserverAt = t;
    lastSetObserverLL = ll;
    observerLL = ll;
    originMode = 'manual';
    try { localStorage.setItem('wm_viewshed_origin_mode', 'manual'); } catch (e) {}
    updateOriginButtonsUI();
    if (!isActive) {
      isActive = true;
      updateBadgeUI(true);
    }
    if (map && layerGroup && !map.hasLayer(layerGroup)) {
      layerGroup.addTo(map);
    }
    updateObserverMarker('⏳ Построение…', true);
    scheduleCompute();
  }

  function syncObserverPosition() {
    if (!map) return;
    if (originMode === 'center') observerLL = map.getCenter();
    else if (originMode === 'gps') {
      const u = (WM.getUserLocation && WM.getUserLocation()) || (WM.gpsState && [WM.gpsState.lat, WM.gpsState.lng]);
      observerLL = u ? L.latLng(u[0], u[1]) : map.getCenter();
    } else if (originMode === 'manual' && !observerLL) {
      observerLL = map.getCenter();
    }
  }

  // ---------------------------------------------------------------------------
  // ПАЙПЛАЙН РАСЧЁТА
  // ---------------------------------------------------------------------------
  function notifyIdle() {
    if (running || timer) return;
    const w = idleWaiters; idleWaiters = []; w.forEach(f => f());
  }

  function whenIdle() {
    return new Promise(res => { if (!running && !timer) res(); else idleWaiters.push(res); });
  }

  function stateSig() {
    syncObserverPosition();
    const o = observerLL;
    return (o ? o.lat.toFixed(6) + ',' + o.lng.toFixed(6) : '') + '|' + originMode + '|' + JSON.stringify(S) + '|' + demSourceId();
  }

  function softSchedule() {
    if (!isActive) return;
    if ((running || timer) && stateSig() === lastSig) return;
    scheduleCompute();
  }

  let lastComputedLL = null;

  function scheduleCompute() {
    if (!isActive) return;
    lastSig = stateSig();
    if (timer) clearTimeout(timer);
    // 250 мс дают карте и жестам завершиться перед стартом расчёта
    timer = setTimeout(() => { 
      timer = null; 
      runPipeline(); 
    }, 250);
  }

  function repaint() {
    if (!isActive || !fields || running || paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      if (fields && !running) {
        paintFields(fields);
        publishOverlay(fields, null);
      }
    }, 60);
  }

async function runPipeline() {
    if (!map || !isActive) { notifyIdle(); return; }
    syncObserverPosition();
    if (!observerLL) { notifyIdle(); return; }
    if (layerGroup && !map.hasLayer(layerGroup)) layerGroup.addTo(map);

    const token = ++pipeToken;
    running = true;

    ViewshedDiag.pipelineStartMs = performance.now();
    ViewshedDiag.dem.status = 'loading';
    ViewshedDiag.updateUI();

    try {
      const lat0 = observerLL.lat, lng0 = observerLL.lng, Rm = S.radiusKm * 1000;
      const gk = geoKeyOf(lat0, lng0, Rm);
      let changed = false;
      const envP = prepareEnvInputs(lat0, lng0).catch(() => null);

      // Pass 1: Рельеф + Лес (загружаются параллельно только при изменении geo)
      if (!geo || geo.key !== gk) {
        if (S.canopy && S.canopy.enabled && viewshedOverlay && layerGroup) {
          layerGroup.removeLayer(viewshedOverlay);
          viewshedOverlay = null;
        }
        setInfo(`⏳ Подготовка рельефа и леса (${S.radiusKm} км)…`);
        updateMarkerProgress('⏳ Старт', true);
        const G = await buildGeometry(lat0, lng0, Rm, token, setInfo);
        if (!G || token !== pipeToken) return;

        if (G._canopyFailed) {
          geo = null; vis = null; fields = null;
          if (viewshedOverlay && layerGroup) {
            layerGroup.removeLayer(viewshedOverlay);
            viewshedOverlay = null;
          }
          updateObserverMarker('⚠️ Нет леса', true);
          setInfo('⚠️ <b>Данные леса (v2 и v1) недоступны</b>. Зона видимости скрыта, чтобы не показывать ложный обзор. Проверьте сеть или отключите учёт леса.');
          ViewshedDiag.canopy.status = 'err';
          ViewshedDiag.updateUI();
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('⚠️ Данные леса недоступны (v1/v2) — зона не показана', 3500);
          }
          return;
        }
        geo = G; vis = null; fields = null; changed = true;
      }

      // Атмосфера
      const inp = await envP;
      if (token !== pipeToken) return;
      const env = deriveEnv(inp, geo);
      lastEnv = env;
      const k = env ? env.k : S.baseK;

      // Pass 2: Видимость (hReq)
      const canKey = (S.canopy && S.canopy.enabled)
        ? `${S.canopy.season}|${S.canopy.summerPenetrationM}|${S.canopy.winterPenetrationM}|${S.canopy.treeHeightFactor}`
        : '0';
      const vk = [geo.key, S.eyeHeight, k.toFixed(3), canKey].join('|');
      if (!vis || vis.key !== vk) {
        const v = await computeVisibility(geo, S.eyeHeight, k, token, setInfo);
        if (!v || token !== pipeToken) return;
        v.key = vk; vis = v; fields = null; changed = true;
      }

      // Pass 3: Поля пикселей
      const nightKey = `${S.night.baseMoonlessM}|${S.night.fullMoonMaxM}|${S.night.twilightDepthDeg}`;
      const fk = [vk, env ? env.key : '', nightKey, QUALITY[S.quality].outSize].join('|');
      if (!fields || fields.key !== fk) {
        const F = await buildFields(geo, vis, env, token, setInfo);
        if (!F || token !== pipeToken) return;
        F.key = fk; fields = F; changed = true;
      }

      if (!changed && viewshedOverlay && !paintDirty) return;
      paintDirty = false;

      // Pass 4: Отрисовка
      paintFields(fields);
      publishOverlay(fields, mainInfoLine() + (env ? '<br>' + describeEnv(env) : ''));

      updateObserverMarker(geo.obsGround);

      ViewshedDiag.totalCalcMs = performance.now() - ViewshedDiag.pipelineStartMs;
      ViewshedDiag.updateUI();

      if (changed && WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`👁️ Зона видимости построена (${S.radiusKm} км)`);
      }
    } catch (e) {
      console.error('[viewshed]', e);
      setInfo('⚠️ Ошибка расчёта: ' + (e && e.message ? e.message : e));
    } finally {
      if (token === pipeToken) running = false;
      notifyIdle();
    }
  }

  // ---------------------------------------------------------------------------
  // КОМПАС И ВВОД
  // ---------------------------------------------------------------------------
  let lastCompassRepaint = 0;
  function onOrientation(e) {
    if (!isActive || !S.followCompass) return;
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
    else if (e.alpha !== null && e.alpha !== undefined) heading = (360 - e.alpha) % 360;
    
    const now = performance.now();
    if (heading !== null && Math.abs(heading - lastHeading) > 3.0 && (now - lastCompassRepaint > 120)) {
      lastHeading = heading;
      lastCompassRepaint = now;
      repaint();
    }
  }


  function init(mapInstance) {
    map = mapInstance;
    loadSettings();
    loadWxCacheFromLS(); // <-- загрузка сохранённой погоды при старте
    syncFromDom();
    if (!layerGroup) layerGroup = L.layerGroup();
    if (isActive && !map.hasLayer(layerGroup)) {
      layerGroup.addTo(map);
    }

    map.on('click', (e) => {
      if (probeArmed) {
        WM.viewshed.analyzeTarget(e.latlng);
      }
    });

    tileLoaderHook = async (z, x, y) => {
      if (WM.demRelief) {
        let singleTile = WM.demRelief.getCachedDemTileWithChildren
          ? WM.demRelief.getCachedDemTileWithChildren({ z, x, y })
          : null;
        if (!singleTile && typeof WM.demRelief.loadDemTileWithFallback === 'function') {
          try {
            singleTile = await WM.demRelief.loadDemTileWithFallback({ z, x, y });
          } catch (e) {}
        }
        if (singleTile && !singleTile._isEmptyFallback && singleTile._demProvider !== 'empty') {
          const targetS = demS || 256;
          const h = decodeBitmap(singleTile, targetS);
          for (let i = 0; i < h.length; i += 17) {
            if (h[i] !== 0) return { S: targetS, h };
          }
        }
      }
      return await downsampleCachedDemChildren(z, x, y);
    };


    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    window.addEventListener('deviceorientationabsolute', onOrientation, { passive: true });

    // Автоматический пересчёт недостающих дальних тайлов при появлении интернета
    window.addEventListener('online', () => {
      NetHealth.hosts.clear();
      if (WM.demRelief && WM.demRelief.resetNet) WM.demRelief.resetNet();
      if (isActive && geo && geo.tilesFail > 0) {
        geo = null; vis = null; fields = null;
        scheduleCompute();
      }
    });

    if (!mountUI()) { setTimeout(mountUI, 500); setTimeout(mountUI, 2000); }

    if (envTimer) clearInterval(envTimer);
    envTimer = setInterval(() => {
      if (isActive && ((S.time.enabled && S.time.mode === 'now') || (S.wx.enabled && S.wx.source === 'auto'))) {
        paintDirty = true; scheduleCompute();
      }
    }, 10 * 60 * 1000);
  }

  function toggle() {
    isActive = !isActive;
    updateBadgeUI(isActive);
    if (isActive) {
      if (layerGroup && !map.hasLayer(layerGroup)) {
        layerGroup.addTo(map);
      }
      syncObserverPosition();
      updateObserverMarker('⏳ Подготовка…', true);
      scheduleCompute();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('👁️ Расчёт видимости включён');
    } else {
      pipeToken++; running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      layerGroup && layerGroup.clearLayers();
      if (layerGroup && map.hasLayer(layerGroup)) {
        map.removeLayer(layerGroup);
      }
      viewshedOverlay = null; observerMarker = null;
      geo = null; vis = null; fields = null;
      if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('👁️ Расчёт видимости выключен');
      notifyIdle();
    }
    if (window.syncViewshedControlState) window.syncViewshedControlState();
  }

  function updateBadgeUI(active) {
    const badge = document.getElementById('dem-hud-viewshed-status-badge');
    if (badge) { 
      badge.textContent = active ? 'Вкл' : 'Выкл'; 
      badge.classList.toggle('active', !!active); 
    }

    const btnQuick = document.getElementById('btn-viewshed-toggle-quick');
    if (btnQuick) {
      btnQuick.textContent = active ? 'Выкл' : 'Вкл';
      btnQuick.classList.toggle('active', !!active);
    }

    const placeholder = document.getElementById('viewshed-disabled-placeholder');
    const container = document.getElementById('viewshed-settings-container');
    if (placeholder) placeholder.hidden = !!active;
    if (container) {
      container.hidden = !active;
      container.classList.toggle('is-disabled', !active);
    }

    updateOriginButtonsUI();
    if (window.syncViewshedControlState) window.syncViewshedControlState();
  }

  function updateOriginButtonsUI() {
    document.querySelectorAll('.viewshed-origin-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.origin === originMode));
  }

  // ---------------------------------------------------------------------------
  // ВСТРАИВАЕМЫЙ ИНТЕРФЕЙС (HUD & EXPANDED PANEL)
  // ---------------------------------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, '0');
  const toLocalInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const $ = (id) => document.getElementById(id);

  function setProbeBtn(on) {
    const b = $('vs-probe-btn');
    if (b) {
      b.classList.toggle('active', !!on);
      const textEl = b.querySelector('.vs-probe-texts b');
      if (textEl) textEl.textContent = on ? '🎯 Кликните на цель на карте…' : 'Проверить прямую видимость цели';
    }
    if (map) {
      map.getContainer().style.cursor = on ? 'crosshair' : '';
    }
  }



  function mountUI() {
    const spoiler = $('spoiler-hud-viewshed');
    if (!spoiler) return false;

    // Заполняем выпадающий список пресетов погоды, если он пуст
    const selPreset = $('vs-wx-preset');
    if (selPreset && !selPreset.options.length) {
      selPreset.innerHTML = Object.keys(WX_PRESETS)
        .map(k => `<option value="${k}">${WX_PRESETS[k].label}</option>`)
        .join('');
    }

    bindUI();
    refreshUI();
    return true;
  }

  function refreshUI() {
    const set = (id, v) => { const e = $(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } };
    const txt = (id, v) => { const e = $(id); if (e) e.textContent = v; };

    // Базовые параметры наблюдателя и цели
    set('viewshed-radius-slider', S.radiusKm); txt('viewshed-radius-val', S.radiusKm + ' км');
    set('viewshed-target-height-slider', S.targetHeight); txt('viewshed-target-height-val', Math.round(S.targetHeight) + ' м');
    set('viewshed-eye-height-slider', S.eyeHeight); txt('viewshed-eye-height-val', S.eyeHeight.toFixed(1) + ' м');

    set('viewshed-opacity-slider', Math.round(S.opacity * 100)); txt('viewshed-opacity-val', Math.round(S.opacity * 100) + '%');
    set('viewshed-color', S.color);
    set('toggle-viewshed-follow-compass', S.followCompass);
    set('vs-toggle-peaks', S.peakPreserve);

    set('vs-canopy-on', S.canopy.enabled);
    set('vs-canopy-season', S.canopy.season);
    const subCanopy = $('vs-canopy-sub');
    if (subCanopy) subCanopy.classList.toggle('is-disabled', !S.canopy.enabled);

    if (geo && geo.obsGround != null) {
      txt('viewshed-obs-alt-label', Math.round(geo.obsGround + S.eyeHeight) + ' м над морем');
    }

    // Чипы быстрых высот цели
    document.querySelectorAll('.vs-preset-chip').forEach(btn => {
      btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.h) - S.targetHeight) < 0.1);
    });

    // Сегментная кнопка типа цели (Авто / Объект / Огни)
    document.querySelectorAll('.vs-tkind-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.kind === S.atm.targetKind);
    });

    // Видимость поля яркости огней
    const cityRow = $('vs-city-light-row');
    if (cityRow) {
      cityRow.hidden = (S.atm.targetKind === 'object');
    }
    set('vs-city-light', String(S.atm.cityLight || 3000000));

    // Качество расчёта (сегментные кнопки)
    document.querySelectorAll('.vs-qual-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.q === S.quality);
    });

    // Погода и время
    set('vs-time-on', S.time.enabled);
    set('vs-time-mode', S.time.mode);
    set('vs-dyn-refr', S.time.dynRefraction);
    set('vs-time-input', toLocalInput(S.time.ts ? new Date(S.time.ts) : new Date()));
    
    set('vs-wx-on', S.wx.enabled);
    set('vs-wx-source', S.wx.source);
    set('vs-wx-preset', S.wx.preset);
    set('vs-wx-base', S.wx.cloudBase); txt('vs-wx-base-val', Math.round(S.wx.cloudBase) + ' м');
    set('vs-wx-thick', S.wx.cloudThick); txt('vs-wx-thick-val', Math.round(S.wx.cloudThick) + ' м');
    set('vs-base-vis', S.atm.baseVisKm); txt('vs-base-vis-val', S.atm.baseVisKm + ' км');

    const show = (id, on) => { const e = $(id); if (e) e.style.display = on ? '' : 'none'; };
    show('vs-time-box', S.time.enabled);
    show('vs-wx-box', S.wx.enabled);

    const manualWx = S.wx.source === 'manual';
    const pw = $('vs-wx-preset-wrap'); if (pw) pw.hidden = !manualWx;
    const mw = $('vs-wx-manual'); if (mw) mw.hidden = !manualWx;

    const ti = $('vs-time-input'); if (ti) ti.disabled = S.time.mode !== 'custom';
  }

  function quickTime(kind) {
    const base = (S.time.mode === 'custom' && S.time.ts) ? new Date(S.time.ts) : new Date();
    const c = observerLL || (map && map.getCenter());
    let d = null;
    try {
      if (kind === '+1h') d = new Date(base.getTime() + 3600e3);
      else if (kind === '-1h') d = new Date(base.getTime() - 3600e3);
      else if (c && window.SunCalc && SunCalc.getTimes) {
        const t = SunCalc.getTimes(base, c.lat, c.lng);
        d = ({ sunrise: t.sunrise, noon: t.solarNoon, sunset: t.sunset, night: t.nadir })[kind];
        if (d && isNaN(d.getTime())) d = null;
      }
    } catch (e) {}
    if (!d) { if (WM.ui && WM.ui.showToast) WM.ui.showToast('Нет астрономических данных для этой точки'); return; }
    
    S.time.enabled = true;
    S.time.mode = 'custom';
    S.time.ts = d.getTime();
    saveSettings();
    refreshUI();
    scheduleCompute();
  }

  let uiBound = false;
  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    const apply = (fn) => (e) => { fn(e); saveSettings(); refreshUI(); scheduleCompute(); };

    // Источник наблюдателя (Центр / GPS / Точка)
    document.querySelectorAll('.viewshed-origin-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        WM.viewshed.setOriginMode(btn.dataset.origin);
      });
    });

    // Тип цели (Авто / Объект / Огни)
    document.querySelectorAll('.vs-tkind-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        S.atm.targetKind = btn.dataset.kind;
        saveSettings();
        refreshUI();
        if (isActive) {
          scheduleCompute(); // ПЕРЕСЧИТЫВАЕМ АТМОСФЕРУ И ПОЛЯ
        }
      });
    });

    // Мощность огней цели (Деревня / Город / Мегаполис)
    on('vs-city-light', 'change', (e) => {
      S.atm.cityLight = parseFloat(e.target.value);
      saveSettings();
      refreshUI();
      if (isActive) {
        scheduleCompute(); // МГНОВЕННЫЙ ПЕРЕСЧЕТ ДАЛЬНОСТИ ПО ЗАКОНУ ЭЛЛИСОНА
      }
    });

    // Чипы быстрой высоты цели
    document.querySelectorAll('.vs-preset-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const h = parseFloat(btn.dataset.h);
        S.targetHeight = h;
        saveSettings();
        refreshUI();
        if (isActive) {
          if (fields) repaint(); else scheduleCompute();
        }
      });
    });

    // Качество расчёта (Fast / Standard / High)
    document.querySelectorAll('.vs-qual-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.q;
        if (QUALITY[q]) {
          S.quality = q;
          saveSettings();
          refreshUI();
          if (isActive) scheduleCompute();
        }
      });
    });

    // Слайдеры и переключатели
    on('viewshed-radius-slider', 'input', apply(e => { S.radiusKm = clamp(+e.target.value, 5, 150); }));
    on('viewshed-target-height-slider', 'input', (e) => {
      S.targetHeight = Math.max(0, +e.target.value);
      saveSettings();
      refreshUI();
      if (isActive) {
        if (fields) repaint(); else scheduleCompute();
      }
    });
    on('viewshed-eye-height-slider', 'input', apply(e => { S.eyeHeight = Math.max(0.5, +e.target.value); }));
    on('viewshed-opacity-slider', 'input', (e) => {
      S.opacity = clamp(+e.target.value / 100, 0.05, 1);
      $('viewshed-opacity-val').textContent = Math.round(S.opacity * 100) + '%';
      if (viewshedOverlay) viewshedOverlay.setOpacity(S.opacity);
      saveSettings();
    });
    on('viewshed-color', 'input', (e) => {
      S.color = e.target.value;
      saveSettings();
      if (isActive) repaint();
    });
    on('toggle-viewshed-follow-compass', 'change', (e) => {
      S.followCompass = !!e.target.checked;
      saveSettings();
      if (isActive) repaint();
    });
    on('vs-toggle-peaks', 'change', apply(e => { S.peakPreserve = !!e.target.checked; }));

    on('vs-city-light', 'change', apply(e => { S.atm.cityLight = +e.target.value; }));
    on('vs-time-on', 'change', apply(e => { S.time.enabled = e.target.checked; }));
    on('vs-time-mode', 'change', apply(e => { 
      S.time.mode = e.target.value; 
      if (S.time.mode === 'custom' && !S.time.ts) S.time.ts = Date.now(); 
    }));
    on('vs-time-input', 'change', apply(e => { 
      const d = new Date(e.target.value); 
      if (!isNaN(d.getTime())) { S.time.ts = d.getTime(); S.time.mode = 'custom'; } 
    }));
    on('vs-dyn-refr', 'change', apply(e => { S.time.dynRefraction = e.target.checked; }));

    on('vs-wx-on', 'change', apply(e => { S.wx.enabled = e.target.checked; }));
    on('vs-wx-source', 'change', apply(e => { S.wx.source = e.target.value; }));
    on('vs-wx-preset', 'change', apply(e => { S.wx.preset = e.target.value; }));
    on('vs-wx-base', 'input', apply(e => { S.wx.cloudBase = +e.target.value; }));
    on('vs-wx-thick', 'input', apply(e => { S.wx.cloudThick = +e.target.value; }));
    on('vs-base-vis', 'input', apply(e => { S.atm.baseVisKm = +e.target.value; }));

    document.querySelectorAll('.vs-tq').forEach(b => b.addEventListener('click', () => quickTime(b.dataset.t)));

    on('vs-probe-btn', 'click', () => {
      if (!isActive) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('Сначала включите расчёт зоны видимости (кнопка «Вкл»)');
        return;
      }
      probeArmed = !probeArmed;
      setProbeBtn(probeArmed);
      if (probeArmed && WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🎯 Кликните по карте на любую вершину или ориентир');
      }
    });
    on('vs-canopy-on', 'change', (e) => {
      if (!S.canopy) S.canopy = {};
      S.canopy.enabled = !!e.target.checked;

      const sub = $('vs-canopy-sub');
      if (sub) sub.classList.toggle('is-disabled', !S.canopy.enabled);

      if (S.canopy.enabled && viewshedOverlay && layerGroup) {
        layerGroup.removeLayer(viewshedOverlay);
        viewshedOverlay = null;
      }

      saveSettings();
      geo = null;
      vis = null;
      fields = null;
      paintDirty = true;
      scheduleCompute();
    });

    on('vs-canopy-season', 'change', (e) => {
      if (!S.canopy) S.canopy = {};
      S.canopy.season = e.target.value;
      saveSettings();
      vis = null;
      fields = null;
      paintDirty = true;
      scheduleCompute();
    });

    on('btn-viewshed-toggle-quick', 'click', (e) => {
      e.stopPropagation();
      toggle();
    });
  }


  function syncFromDom() {
    const num = (id) => { const e = $(id); return e ? parseFloat(e.value) : NaN; };
    const rad = num('viewshed-radius-slider'); if (rad === rad) S.radiusKm = clamp(rad, 5, 150);
    const tgt = num('viewshed-target-height-slider'); if (tgt === tgt) S.targetHeight = Math.max(0, tgt);
    const eye = num('viewshed-eye-height-slider'); if (eye === eye) S.eyeHeight = Math.max(0.5, eye);
    const op = num('viewshed-opacity-slider'); if (op === op) S.opacity = clamp(op / 100, 0.05, 1);
    const col = $('viewshed-color'); if (col && col.value) S.color = col.value;
    const fc = $('toggle-viewshed-follow-compass'); if (fc) S.followCompass = !!fc.checked;
    
    // Синхронизация состояния растительности из DOM
    const cOn = $('vs-canopy-on');
    if (cOn) {
      if (!S.canopy) S.canopy = {};
      S.canopy.enabled = !!cOn.checked;
    }
    const cSeason = $('vs-canopy-season');
    if (cSeason) {
      if (!S.canopy) S.canopy = {};
      S.canopy.season = cSeason.value || 'auto';
    }
  }

  // ---------------------------------------------------------------------------
  // ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
  // ---------------------------------------------------------------------------


  WM.viewshed = {
    init,
    toggle,
    mountUI,
    prefetchWeather: (lat, lng) => fetchWeather(lat, lng).catch(() => null),

    isActive: () => isActive,
    getOriginMode: () => originMode,
    getLayerGroup: () => {
      if (!layerGroup && typeof L !== 'undefined' && L.layerGroup) {
        layerGroup = L.layerGroup();
      }
      return layerGroup;
    },
    scheduleCompute: softSchedule,
    invalidate() { geo = null; vis = null; fields = null; scheduleCompute(); },
    whenIdle,
    setObserver,
    onGpsUpdate(ll) {
      if (isActive && originMode === 'gps') {
        const newLL = L.latLng(ll[0], ll[1]);
        if (!lastComputedLL || lastComputedLL.distanceTo(newLL) > 30.0) {
          observerLL = newLL;
          scheduleCompute();
        }
      }
    },
    applyProfile(profileData) {
      if (!profileData) return;
      const s = profileData.settings || profileData;
      // Применяем настройки
      for (const k in s) {
        if (k in S) {
          if (typeof S[k] === 'object' && S[k] !== null) {
            Object.assign(S[k], s[k]);
          } else {
            S[k] = s[k];
          }
        }
      }
      saveSettings();
      refreshUI();

      // Управление активностью (включен / выключен)
      const shouldBeActive = profileData.active !== undefined ? !!profileData.active : false;
      if (isActive !== shouldBeActive) {
        toggle();
      } else if (isActive) {
        geo = null; vis = null; fields = null;
        scheduleCompute();
      }
    },
    setOriginMode(mode) {
      originMode = mode;
      try { localStorage.setItem('wm_viewshed_origin_mode', mode); } catch (e) {}
      updateOriginButtonsUI();
      syncObserverPosition();
      scheduleCompute();
    },
    setRadiusKm(km) { S.radiusKm = clamp(+km, 5, 150); saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    setTargetHeight(h) {
      S.targetHeight = Math.max(0, h);
      saveSettings();
      refreshUI();
      if (isActive) {
        if (fields) repaint(); else scheduleCompute();
      }
    },
    setEyeHeight(h) { S.eyeHeight = Math.max(0.5, h); saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    setOpacity(op) { S.opacity = clamp(op, 0.05, 1); if (viewshedOverlay) viewshedOverlay.setOpacity(S.opacity); },
    setColor(hex) { S.color = hex; saveSettings(); if (isActive) repaint(); },
    setFollowCompass(v) { S.followCompass = !!v; if (isActive) repaint(); },
    setQuality(q) { if (QUALITY[q]) { S.quality = q; saveSettings(); refreshUI(); if (isActive) scheduleCompute(); } },
    setPeakPreserve(v) { S.peakPreserve = !!v; saveSettings(); if (isActive) scheduleCompute(); },
    setObserverSnap(v) { S.observerSnap = !!v; saveSettings(); if (isActive) scheduleCompute(); },
    setTimeEffects(o) { Object.assign(S.time, o || {}); saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    setDateTime(d) { S.time.mode = d ? 'custom' : 'now'; S.time.ts = d ? new Date(d).getTime() : null; saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    setWeatherEffects(o) { Object.assign(S.wx, o || {}); saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    setAtmosphere(o) { Object.assign(S.atm, o || {}); saveSettings(); refreshUI(); if (isActive) scheduleCompute(); },
    getWeatherPresets: () => Object.keys(WX_PRESETS).map(k => ({ id: k, label: WX_PRESETS[k].label })),

    probe,
    showProbe,
    analyzeTarget(latlng) {
      probeArmed = false;
      setProbeBtn(false);
      return showProbe(latlng);
    },
    isProbeArmed: () => probeArmed,
    armTargetProbe() { probeArmed = true; setProbeBtn(true); },
    closeProbePopup() {
      if (probePopup && map) {
        try { map.closePopup(probePopup); } catch (e) {}
        probePopup = null;
        return true;
      }
      return false;
    },
    openPanel() {
      const sp = document.getElementById('spoiler-hud-viewshed');
      if (sp) sp.open = true;
      const ext = document.getElementById('viewshed-ext-panel');
      if (ext) ext.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    getEnvironment: () => lastEnv,
    getSettings: () => JSON.parse(JSON.stringify(S))
  };











})();