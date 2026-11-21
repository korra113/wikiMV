/* =============================================================================
 * WM.audibility v1.0 — Зона слышимости (акустическая модель местности)
 * Режимы: «Слышимые звуки» и «Издаваемые звуки» (2 зоны громкости)
 * + дифракция на хребтах (Maekawa) + 2D-отражения волн от склонов и долин
 * + ISO 9613-1 атмосфера + ветер/инверсия + листва/снег + водоёмы + оффлайн
 * ========================================================================== */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  // ---------------------------------------------------------------------------
  // КОНСТАНТЫ И МАТЕМАТИЧЕСКИЕ УТИЛИТЫ
  // ---------------------------------------------------------------------------
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const TAU = Math.PI * 2;
  const INV_2PI = 1 / TAU;
  const INV_4PI = 1 / (4 * Math.PI);
  const R_EARTH = 6371008.8;
  const SETTINGS_KEY = 'wm_audibility_settings_v1';
  const WX_LS_KEY = 'wm_audibility_wx_cache_v1';
  const FOV_HALF = 35.0;

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / ((b - a) || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
  // ШКАЛА ГРОМКОСТИ И ПОДСКАЗКИ (дБ на 1 м от источника)
  // ---------------------------------------------------------------------------
  const HUMAN_MAX_DB = 105; // Предел звука, который человек может издать сам (громкий крик / свист пальцами)

  const HEAR_HINTS = [
    { max: 24,  icon: '🐁', title: 'Шуршание мышей в траве, тихий шорох листвы', freq: 3200 },
    { max: 36,  icon: '💭', title: 'Тихий шёпот рядом, тихие шаги по мху', freq: 2200 },
    { max: 46,  icon: '🦗', title: 'Стрекотание кузнечиков/сверчков, журчание ручья', freq: 3800 },
    { max: 54,  icon: '🐦', title: 'Пение лесных птиц, негромкая речь', freq: 1600 },
    { max: 64,  icon: '🗣️', title: 'Обычный разговор, треск сухих веток, шаги по валежнику', freq: 1100 },
    { max: 76,  icon: '🚗', title: 'Громкий разговор, смех, авто на грунтовке', freq: 850 },
    { max: 89,  icon: '🐕', title: 'Лай собаки, громкий крик, мотор лодки', freq: 750 },
    { max: 100, icon: '🪚', title: 'Бензопила, трактор в поле, проходящий поезд', freq: 500 },
    { max: 114, icon: '📯', title: 'Клаксон автомобиля, туристический свисток, сирена вдали', freq: 950 },
    { max: 128, icon: '🚁', title: 'Низколетящий вертолёт, далёкий выстрел или гром', freq: 260 },
    { max: 145, icon: '⚡', title: 'Близкий раскат грома, пуск ракеты, мощный взрыв', freq: 160 }
  ];

  const HEAR_PRESETS = [
    { label: '🐁 Мыши 22',      db: 22,  freq: 3200, kind: 'broadband' },
    { label: '💭 Шёпот 34',     db: 34,  freq: 2200, kind: 'broadband' },
    { label: '🦗 Кузнечики 44', db: 44,  freq: 3800, kind: 'tonal' },
    { label: '🗪 Речь 58',      db: 58,  freq: 1000, kind: 'voice' },
    { label: '🚗 Авто 72',      db: 72,  freq: 850,  kind: 'broadband' },
    { label: '🪚 Пила 85',      db: 85,  freq: 500,  kind: 'broadband' },   
    { label: '📯 Свисток 90',  db: 90, freq: 950,  kind: 'tonal' },     
    { label: '🐕 Лай 95',       db: 95,  freq: 750,  kind: 'voice' },


    { label: '🚁 Вертолёт 115', db: 115, freq: 260,  kind: 'broadband' },
    { label: '⚡ Гром 130',     db: 130, freq: 160,  kind: 'broadband' }
  ];

  const EMIT_HINTS = [
    // Зона 1: Человек самостоятельно (20–105 дБ)
    { max: 32,  zone: 1, icon: '💭', title: 'Тихий шёпот, осторожный шаг по мху', freq: 1800, kind: 'broadband' },
    { max: 48,  zone: 1, icon: '🗪', title: 'Спокойный разговор в лагере', freq: 950, kind: 'voice' },
    { max: 62,  zone: 1, icon: '🥾', title: 'Громкая речь, кашель, шаги по хрустящему снегу или сучьям', freq: 900, kind: 'voice' },
    { max: 75,  zone: 1, icon: '🪵', title: 'Оклик («Эй!»), стук палкой по стволу дерева', freq: 780, kind: 'voice' },
    { max: 88,  zone: 1, icon: '🙌', title: 'Громкий зов «Ау!», резкий хлопок в ладоши', freq: 750, kind: 'voice' },
    { max: 105, zone: 1, icon: '🗣️', title: 'Предельный крик на сорванном голосе, свист пальцами', freq: 1100, kind: 'voice' },
    // Зона 2: Подручные средства (106–145 дБ)
    { max: 118, zone: 2, icon: '😙', title: 'Туристический свисток, звонкий удар по металлическому котелку', freq: 2350, kind: 'tonal' },
    { max: 128, zone: 2, icon: '📣', title: 'Пневматический горн, петарда, хлопок фальшфейера', freq: 780, kind: 'tonal' },
    { max: 137, zone: 2, icon: '🚀', title: 'Сигнальная ракета / «Сигнал охотника»', freq: 380, kind: 'impulse' },
    { max: 145, zone: 2, icon: '💥', title: 'Ружейный выстрел / мощный пиротехнический сигнал', freq: 260, kind: 'impulse' }
  ];

  const EMIT_PRESETS_HUMAN = [
    { label: '💭 Шёпот 28',      db: 28,  freq: 1800, kind: 'broadband' },
    { label: '🗪 Речь 55',       db: 55,  freq: 950,  kind: 'voice' },
    { label: '🙌 Ау! 85',        db: 85,  freq: 750,  kind: 'voice' },
    { label: '📢 Макс. крик 100', db: 100, freq: 1100, kind: 'voice' }
  ];

  const EMIT_PRESETS_GEAR = [
    { label: '😙 Свисток 116',   db: 116, freq: 2350, kind: 'tonal' },
    { label: '📣 Горн 124',      db: 124, freq: 780,  kind: 'tonal' },
    { label: '🚀 Ракета 134',    db: 134, freq: 380,  kind: 'impulse' },
    { label: '💥 Выстрел 142',   db: 142, freq: 260,  kind: 'impulse' }
  ];



  // ---------------------------------------------------------------------------
  // НАСТРОЙКИ МОДУЛЯ
  // ---------------------------------------------------------------------------
  const S = {
    mode: 'hear',              // 'hear' (слышимые звуки) | 'emit' (издаваемые звуки)
    volumeDb: 85,              // Громкость источника на 1 м (дБ)
    allowGear: true,           // Для 'emit': разрешать зону 2 (подручные средства > 105 дБ)
    freqBand: 'auto',          // 'auto' | 'low' (250 Гц) | 'mid' (850 Гц) | 'high' (2600 Гц)
    autoRadius: true,          // Автоматический подбор радиуса расчёта по громкости
    radiusKm: 6,               // Ручной радиус расчёта (0.25 .. 50 км)
    quality: 'standard',       // 'fast' | 'standard' | 'high'
    earHeight: 1.6,            // Высота наблюдателя (ушей / рта) над землёй, м
    sourceHeight: 1.5,         // Высота удалённой точки (источника / слушателя) над землёй, м
    color: '#3b82f6',          // Основной цвет зоны слышимости
    echoColor: '#a855f7',      // Цвет зон, слышимых за счёт эхо/отражений/дифракции
    highlightEcho: true,       // Подсвечивать зоны отражения/дифракции отдельным оттенком
    opacity: 0.56,
    followCompass: false,
    observerSnap: true,
    ambientOffsetDb: 0,        // Ручная поправка фонового шума (-10 .. +25 дБ)
    activePreset: null,

    // Тумблеры учёта отдельных физических аспектов
    factors: {
      relief: true,            // Учёт рельефа и дифракции волн над хребтами
      reflections: true,       // Симуляция отражений волн от формы рельефа (склоны, долины)
      foliage: true,           // Растительность и листва на деревьях (WM.canopy + сезон)
      snow: true,              // Поглощение звука у земли снежным покровом (зимой / в снег)
      water: true,             // Близость водоёмов (зеркало воды + волновод + шум волн)
      wind: true,              // Снос и рефракция звука ветром
      weather: true,           // Погода: температура, влажность (ISO 9613-1), дождь/туман
      timeOfDay: true,         // Время суток: ночная/утренняя тишина и температурная инверсия
      ambientNoise: true       // Учёт фонового шума среды (ветер, дождь, время суток)
    },

    season: 'auto',            // 'auto' | 'summer' | 'spring_fall' | 'winter'
    time: { mode: 'now', ts: null },
    wx: {
      source: 'auto',          // 'auto' | 'manual'
      preset: 'clear',
      windSpeed: 2.5,          // Ручной ветер, м/с
      windDir: 240,            // Откуда дует ветер, град (метеорологический азимут)
      tempC: 16,
      rh: 60
    }
  };

  const QUALITY = {
    fast:     { nRays: 240, outSize: 640,  maxCells: 1.6e6, texelScale: 1.8, reflTop: 72 },
    standard: { nRays: 360, outSize: 896,  maxCells: 3.4e6, texelScale: 1.0, reflTop: 128 },
    high:     { nRays: 540, outSize: 1152, maxCells: 6.0e6, texelScale: 0.65, reflTop: 180 }
  };

  const WX_PRESETS = {
    clear:     { label: 'Ясно / спокойно',          T: 18, RH: 55, rain: 0,   snow: 0,   wind: 2.0, cloud: 0.1,  visibility: 24000, cape: 120, fog: false },
    calmNight: { label: 'Тихий штиль (инверсия)',    T: 8,  RH: 78, rain: 0,   snow: 0,   wind: 0.5, cloud: 0.0,  visibility: 16000, cape: 0,   fog: false },
    windy:     { label: 'Ветрено',                   T: 14, RH: 58, rain: 0,   snow: 0,   wind: 9.5, cloud: 0.4,  visibility: 20000, cape: 80,  fog: false },
    fog:       { label: 'Туман / высокая влажность', T: 10, RH: 98, rain: 0,   snow: 0,   wind: 0.8, cloud: 0.85, visibility: 350,   cape: 0,   fog: true },
    drizzle:   { label: 'Морось',                    T: 11, RH: 92, rain: 0.4, snow: 0,   wind: 3.5, cloud: 0.9,  visibility: 4500,  cape: 20,  fog: false },
    rain:      { label: 'Дождь',                     T: 12, RH: 93, rain: 3.5, snow: 0,   wind: 5.0, cloud: 1.0,  visibility: 3000,  cape: 150, fog: false },
    heavyRain: { label: 'Ливень / шквал',            T: 15, RH: 95, rain: 14,  snow: 0,   wind: 11.0,cloud: 1.0,  visibility: 1500,  cape: 950, fog: false },
    snow:      { label: 'Снегопад',                  T: -5, RH: 88, rain: 0,   snow: 1.2, wind: 3.5, cloud: 1.0,  visibility: 1800,  cape: 0,   fog: false },
    frost:     { label: 'Мороз и солнце',            T: -16,RH: 68, rain: 0,   snow: 0,   wind: 1.5, cloud: 0.1,  visibility: 24000, cape: 0,   fog: false }
  };

  function loadSettings() {
    try {
      const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!j || typeof j !== 'object') return;
      ['mode', 'volumeDb', 'allowGear', 'freqBand', 'autoRadius', 'radiusKm', 'quality',
       'earHeight', 'sourceHeight', 'color', 'echoColor', 'highlightEcho', 'opacity',
       'followCompass', 'observerSnap', 'ambientOffsetDb', 'season'].forEach(k => {
        if (j[k] !== undefined && typeof j[k] === typeof S[k]) S[k] = j[k];
      });
       if (j.activePreset && typeof j.activePreset === 'object' && isFinite(j.activePreset.freq)) {
        S.activePreset = j.activePreset;
      }
      if (j.factors && typeof j.factors === 'object') {
        Object.keys(S.factors).forEach(k => {
          if (typeof j.factors[k] === 'boolean') S.factors[k] = j.factors[k];
        });
      }

      if (j.time && typeof j.time === 'object') Object.assign(S.time, j.time);
      if (j.wx && typeof j.wx === 'object') Object.assign(S.wx, j.wx);
      if (!QUALITY[S.quality]) S.quality = 'standard';
      if (S.mode !== 'hear' && S.mode !== 'emit') S.mode = 'hear';
      S.volumeDb = clamp(+S.volumeDb || 74, S.mode === 'emit' ? 20 : 10, (S.mode === 'emit' && !S.allowGear) ? HUMAN_MAX_DB : 145);
    } catch (e) {}
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // CIRCUIT BREAKER СЕТЕВЫХ ИСТОЧНИКОВ
  // ---------------------------------------------------------------------------
  const NetHealth = {
    hosts: new Map(),
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
    isAvailable(url) { return Date.now() >= this.getState(url).openUntil; },
    reportSuccess(url, latencyMs) {
      const s = this.getState(url);
      s.fails = 0; s.openUntil = 0; s.backoffMs = 15000;
      s.lastSuccess = Date.now();
      s.avgLatency = s.avgLatency * 0.7 + latencyMs * 0.3;
    },
    reportFailure(url, fatal = false) {
      const s = this.getState(url);
      s.fails++;
      const recent = (Date.now() - s.lastSuccess) < 60000;
      if (fatal || s.fails >= (recent ? 3 : 2)) {
        s.openUntil = Date.now() + s.backoffMs;
        s.backoffMs = Math.min(s.backoffMs * 2, 300000);
      }
    },
    rankUrls(urls) {
      const now = Date.now();
      return urls.slice().sort((a, b) => {
        const sa = this.getState(a), sb = this.getState(b);
        const ad = sa.openUntil > now, bd = sb.openUntil > now;
        if (ad !== bd) return ad ? 1 : -1;
        return sa.avgLatency - sb.avgLatency;
      });
    }
  };

  // ---------------------------------------------------------------------------
  // СОСТОЯНИЕ МОДУЛЯ
  // ---------------------------------------------------------------------------
  let map = null;
  let isActive = false;
  let observerLL = null;
  let originMode = 'center';
  try { originMode = localStorage.getItem('wm_audibility_origin_mode') || 'center'; } catch (e) {}

  let layerGroup = (typeof L !== 'undefined' && L.layerGroup) ? L.layerGroup() : null;
  let probeLayer = (typeof L !== 'undefined' && L.layerGroup) ? L.layerGroup() : null;
  let audioOverlay = null;
  let observerMarker = null;
  let probePopup = null;
  let probeArmed = false;
  let lastHeading = 0;
  let lastBlobUrl = null;
  let lastComputedLL = null;

  let pipeToken = 0;
  let _internalCanopySwitch = false;
  let running = false;
  let timer = null;
  let paintTimer = null;
  let envTimer = null;
  let idleWaiters = [];

  let geo = null;     // Pass 1: геометрия рельефа + уклоны + кроны + вода
  let aco = null;     // Pass 2 + 2.5: прямое поле, дифракция, 2D-отражения от рельефа
  let fields = null;  // Pass 3: растровые поля
  let lastEnv = null;
  let lastSig = '';
  let paintDirty = false;


  // ---------------------------------------------------------------------------
  // АСТРОНОМИЯ (СОЛНЦЕ ДЛЯ ВРЕМЕНИ СУТОК И ИНВЕРСИИ)
  // ---------------------------------------------------------------------------
  const J1970 = 2440588, J2000 = 2451545, DAYMS = 864e5, OBL = 23.4397 * DEG;
  const toDays = (d) => d.valueOf() / DAYMS - 0.5 + J1970 - J2000;

  function sunPosFallback(date, lat, lng) {
    const d = toDays(date);
    const M = DEG * (357.5291 + 0.98560028 * d);
    const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + DEG * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(OBL) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(OBL), Math.cos(L));
    const lw = DEG * -lng, phi = DEG * lat;
    const H = DEG * (280.16 + 360.9856235 * d) - lw - ra;
    return {
      altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
      azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
    };
  }

  function getSunAltitudeDeg(date, lat, lng) {
    const SC = window.SunCalc;
    const p = (SC && SC.getPosition) ? SC.getPosition(date, lat, lng) : sunPosFallback(date, lat, lng);
    return p.altitude * RAD;
  }

  // ---------------------------------------------------------------------------
  // ГЕОДЕЗИЯ
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

  const mercY = (latDeg) => { const s = Math.sin(clamp(latDeg, -85.05, 85.05) * DEG); return 0.5 - Math.log((1 + s) / (1 - s)) * INV_4PI; };
  const mercLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * RAD;

  // ---------------------------------------------------------------------------
  // ХРАНИЛИЩЕ DEM-ТАЙЛОВ (ОФЛАЙН + КЭШ + СЕРВЕРЫ)
  // ---------------------------------------------------------------------------
  const DEFAULT_TEMPLATES = [
    'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    'https://tile.nextzen.org/tilezen/elevation/v1/terrarium/{z}/{x}/{y}.png'
  ];
  const tileStore = new Map();
  let storeBytes = 0;
  const STORE_MAX_BYTES = 128 * 1024 * 1024;
  let demS = 0;
  let jobSerial = 0;
  let tileLoaderHook = null;

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

  async function downsampleCachedDemChildren(z, x, y) {
    if (z < 10 || z > 14) return null;
    if (!WM.offlineArea || typeof WM.offlineArea.readCachedBlob !== 'function') return null;
    const templates = demTemplates();
    let cv = null, ctx = null, found = 0;

    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = x * 2 + dx, cy = y * 2 + dy;
        let blob = null;
        for (const tpl of templates) {
          const url = tpl.replace('{z}', z + 1).replace('{x}', cx).replace('{y}', cy);
          try { blob = await WM.offlineArea.readCachedBlob(url); if (blob) break; } catch (e) {}
        }
        if (!blob) continue;
        try {
          let bmp;
          try { bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
          catch (e) { bmp = await createImageBitmap(blob); }
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
    if (navigator.onLine === false) return null;

    const templates = NetHealth.rankUrls(demTemplates());
    let saw404 = 0, triedNet = 0;
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
        if (resp.status === 404) { saw404++; NetHealth.reportSuccess(tpl, performance.now() - t0); continue; }
        if (!resp.ok) { NetHealth.reportFailure(tpl, resp.status >= 500 || resp.status === 429); continue; }
        const blob = await resp.blob();
        let bmp;
        try { bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
        catch (e) { bmp = await createImageBitmap(blob); }
        const h = decodeBitmap(bmp, targetS);
        if (bmp.close) bmp.close();
        let hasValid = false;
        for (let i = 0; i < h.length; i += 17) { if (h[i] !== 0) { hasValid = true; break; } }
        if (!hasValid) { NetHealth.reportFailure(tpl, false); continue; }
        NetHealth.reportSuccess(tpl, performance.now() - t0);
        return { S: targetS, h };
      } catch (e) {
        if (to) clearTimeout(to);
        NetHealth.reportFailure(tpl, e.name === 'AbortError' || e.name === 'TypeError');
      }
    }
    if (triedNet > 0 && saw404 === triedNet) return { sea: true };
    return null;
  }

  function downsampleWater256To64(mask256) {
    const out = new Uint8Array(WATER_GRID_S * WATER_GRID_S);
    let any = 0;
    for (let y = 0; y < WATER_GRID_S; y++) {
      const sy = y << 2;
      const dRow = y * WATER_GRID_S;
      for (let x = 0; x < WATER_GRID_S; x++) {
        const sx = x << 2;
        if (mask256[sy * 256 + sx] > 127 || mask256[(sy + 1) * 256 + sx + 1] > 127 ||
            mask256[(sy + 2) * 256 + sx + 2] > 127 || mask256[(sy + 3) * 256 + sx + 3] > 127) {
          out[dRow + x] = 1;
          any = 1;
        }
      }
    }
    return any ? out : 'empty';
  }

  async function ensureWaterTile(z, x, y) {
    const key = `${z}:${x}:${y}`;
    if (waterStore.has(key)) return waterStore.get(key);
    if (waterInFlight.has(key)) return waterInFlight.get(key);

    // 1. Быстрая проверка общего RAM-кэша из demRelief.js (без сети и декодинга)
    if (WM.demRelief && typeof WM.demRelief.getCachedWaterMask === 'function') {
      const sharedMask = WM.demRelief.getCachedWaterMask(z, x, y);
      if (sharedMask) {
        const m64 = downsampleWater256To64(sharedMask);
        waterStore.set(key, m64);
        return m64;
      }
    }

    // 2. Если demRelief.js подключён — делегируем загрузку ему (общий пул, offlineArea и WaterNet!)
    if (WM.demRelief && typeof WM.demRelief.fetchWaterMaskTile === 'function') {
      const pShared = WM.demRelief.fetchWaterMaskTile({ z, x, y }).then(mask256 => {
        if (!mask256) return null;
        const m64 = downsampleWater256To64(mask256);
        waterStore.set(key, m64);
        if (waterStore.size > 240) waterStore.delete(waterStore.keys().next().value);
        return m64;
      }).catch(() => null);
      waterInFlight.set(key, pShared);
      try { return await pShared; } finally { waterInFlight.delete(key); }
    }

    // 3. Автономный фоллбэк (если модуль demRelief.js не загружен)
    const p = (async () => {
      const urls = getWaterMaskUrls(z, x, y);
      if (WM.offlineArea && typeof WM.offlineArea.readCachedBlob === 'function') {
        for (const u of urls) {
          try {
            const blob = await WM.offlineArea.readCachedBlob(u);
            if (blob) {
              const bmp = await createImageBitmap(blob);
              const m = decodeWaterBitmap(bmp);
              if (bmp.close) bmp.close();
              waterStore.set(key, m);
              return m;
            }
          } catch (e) {}
        }
        for (let pz = z - 1; pz >= Math.max(8, z - 3); pz--) {
          const shift = z - pz;
          const pUrls = getWaterMaskUrls(pz, x >> shift, y >> shift);
          for (const u of pUrls) {
            try {
              const blob = await WM.offlineArea.readCachedBlob(u);
              if (blob) {
                const bmp = await createImageBitmap(blob);
                const factor = 1 << shift;
                const sx = (((x % factor) + factor) % factor) * (bmp.width / factor);
                const sy = (((y % factor) + factor) % factor) * (bmp.height / factor);
                if (!_wCv) {
                  _wCv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(WATER_GRID_S, WATER_GRID_S) : document.createElement('canvas');
                  _wCv.width = WATER_GRID_S; _wCv.height = WATER_GRID_S;
                  _wCtx = _wCv.getContext('2d', { willReadFrequently: true });
                }
                _wCtx.clearRect(0, 0, WATER_GRID_S, WATER_GRID_S);
                _wCtx.drawImage(bmp, sx, sy, bmp.width / factor, bmp.height / factor, 0, 0, WATER_GRID_S, WATER_GRID_S);
                if (bmp.close) bmp.close();
                const d = _wCtx.getImageData(0, 0, WATER_GRID_S, WATER_GRID_S).data;
                const mask = new Uint8Array(WATER_GRID_S * WATER_GRID_S);
                let any = 0;
                for (let i = 0, q = 0; i < mask.length; i++, q += 4) {
                  const r = d[q], g = d[q + 1], b = d[q + 2], a = d[q + 3];
                  if (a > 30 && ((r < 35 && g > 70 && g < 130 && b > 170) || (b > 180 && r < 55 && g < 140))) {
                    mask[i] = 1; any = 1;
                  }
                }
                const res = any ? mask : 'empty';
                waterStore.set(key, res);
                return res;
              }
            } catch (e) {}
          }
        }
      }

      if (navigator.onLine === false) return null;

      const ranked = NetHealth.rankUrls(urls);
      for (const url of ranked) {
        if (!NetHealth.isAvailable(url)) continue;
        const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
        let timedOut = false;
        const to = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, 2500) : null;
        const t0 = performance.now();
        try {
          const resp = await fetch(url, { mode: 'cors', signal: ctl ? ctl.signal : undefined });
          if (to) clearTimeout(to);
          if (resp.status === 404) {
            NetHealth.reportSuccess(url, performance.now() - t0);
            waterStore.set(key, 'empty');
            return 'empty';
          }
          if (!resp.ok) { NetHealth.reportFailure(url, resp.status >= 500); continue; }
          const blob = await resp.blob();
          const bmp = await createImageBitmap(blob);
          const m = decodeWaterBitmap(bmp);
          if (bmp.close) bmp.close();
          NetHealth.reportSuccess(url, performance.now() - t0);
          waterStore.set(key, m);
          if (waterStore.size > 240) waterStore.delete(waterStore.keys().next().value);
          return m;
        } catch (e) {
          if (to) clearTimeout(to);
          NetHealth.reportFailure(url, timedOut || e.name === 'TypeError');
        }
      }
      return null;
    })();

    waterInFlight.set(key, p);
    try { return await p; } finally { waterInFlight.delete(key); }
  }

  async function preloadWaterArea(lat0, lng0, Rm, token, onProgress) {
    if (!S.factors.water) return;
    const z = Rm > 15000 ? 12 : 13;
    const list = tilesForRing(lat0, lng0, z, 0, Math.min(Rm, 28000));
    const limited = list.slice(0, 64);
    let idx = 0;
    let done = 0;
    const total = limited.length;
    if (onProgress) onProgress(0, total);
    const workers = [];
    for (let w = 0; w < 4; w++) {
      workers.push((async () => {
        while (idx < limited.length) {
          if (token !== pipeToken) return;
          const [tx, ty] = limited[idx++];
          await ensureWaterTile(z, tx, ty);
          done++;
          if (onProgress) onProgress(done, total);
        }
      })());
    }
    await Promise.all(workers);
  }

  function getWaterAt(lat, lng, hTerrain) {
    if (!S.factors.water) return 0;
    if (hTerrain !== undefined && hTerrain <= 0.25) return 1;
    const candidateZ = [13, 12];
    for (const z of candidateZ) {
      const n = 1 << z;
      const fx = ((lng + 180) / 360) * n;
      const fy = mercY(lat) * n;
      const tx = ((Math.floor(fx) % n) + n) % n;
      const ty = clamp(Math.floor(fy), 0, n - 1);
      const m = waterStore.get(`${z}:${tx}:${ty}`);
      if (m) {
        if (m === 'empty') return 0;
        const lx = clamp(Math.floor((fx - Math.floor(fx)) * WATER_GRID_S), 0, WATER_GRID_S - 1);
        const ly = clamp(Math.floor((fy - Math.floor(fy)) * WATER_GRID_S), 0, WATER_GRID_S - 1);
        return m[ly * WATER_GRID_S + lx] ? 1 : 0;
      }
    }
    if (WM.demRelief && typeof WM.demRelief.getWaterAtSync === 'function') {
      const sharedW = WM.demRelief.getWaterAtSync(lat, lng);
      if (sharedW !== null) return sharedW;
    }
    return 0;
  }

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

  const zoomForTexel = (targetM, latRad, Ssz) =>
    clamp(Math.round(Math.log2(156543.03392 * Math.cos(latRad) * (256 / Ssz) / targetM)), 3, 15);
  const texelMeters = (z, latRad, Ssz) => 156543.03392 * Math.cos(latRad) * (256 / Ssz) / Math.pow(2, z);

  function makeLevel(z, Ssz) { return { z, S: Ssz, W: Math.pow(2, z) * Ssz, lastKey: -1, lastTile: null }; }
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
            return (top + (bot - top) * fy) * 0.25 - 1000.0;
          }
        }
      }
    }
    const h00 = texelRaw(L, ix, iy), h10 = texelRaw(L, ix + 1, iy), h01 = texelRaw(L, ix, iy + 1), h11 = texelRaw(L, ix + 1, iy + 1);
    let sum = 0, cnt = 0;
    if (h00 === h00) { sum += h00; cnt++; }
    if (h10 === h10) { sum += h10; cnt++; }
    if (h01 === h01) { sum += h01; cnt++; }
    if (h11 === h11) { sum += h11; cnt++; }
    if (!cnt) return NaN;
    const mean = sum / cnt;
    const a = h00 === h00 ? h00 : mean, b = h10 === h10 ? h10 : mean, c = h01 === h01 ? h01 : mean, d = h11 === h11 ? h11 : mean;
    return a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  // ---------------------------------------------------------------------------
  // ХРАНИЛИЩЕ МАСКИ ВОДЫ (ESA WorldCover 10m: 64x64 сетка на тайл, оффлайн + сеть)
  // ---------------------------------------------------------------------------
  const WATER_GRID_S = 64;
  const waterStore = new Map(); // key: `${z}:${x}:${y}` -> Uint8Array(4096) | 'empty'
  const waterInFlight = new Map();

  function getWaterMaskUrls(z, x, y) {
    const padZ = String(z).padStart(2, '0');
    const out = [
      `https://forests.sylar1907942.workers.dev/tiles/water/${z}/${x}/${y}`,
      `https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=water&z=${z}&x=${x}&y=${y}`,
      `https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2021-v2_map/webmercator/${padZ}/${x}/${y}.png`
    ];
    try {
      const tpl = WM.canopyTokens?.templates?.water;
      if (tpl) out.unshift(L.Util.template(tpl, { z, x, y, s: 'a' }));
    } catch (e) {}
    return out;
  }

  let _wCv = null, _wCtx = null;
  function decodeWaterBitmap(bmp) {
    if (!_wCv) {
      _wCv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(WATER_GRID_S, WATER_GRID_S) : document.createElement('canvas');
      _wCv.width = WATER_GRID_S; _wCv.height = WATER_GRID_S;
      _wCtx = _wCv.getContext('2d', { willReadFrequently: true });
      _wCtx.imageSmoothingEnabled = false;
    }
    _wCtx.clearRect(0, 0, WATER_GRID_S, WATER_GRID_S);
    _wCtx.drawImage(bmp, 0, 0, WATER_GRID_S, WATER_GRID_S);
    const d = _wCtx.getImageData(0, 0, WATER_GRID_S, WATER_GRID_S).data;
    const mask = new Uint8Array(WATER_GRID_S * WATER_GRID_S);
    let any = 0;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
      const isWater = a > 30 && ((r < 35 && g > 70 && g < 130 && b > 170) || (b > 180 && r < 55 && g < 140));
      if (isWater) { mask[i] = 1; any = 1; }
    }
    return any ? mask : 'empty';
  }




  // ---------------------------------------------------------------------------
  // ПОГОДА (OPEN-METEO + OFFLINE CACHE + MANUAL) И СЕЗОН
  // ---------------------------------------------------------------------------
  const weatherCache = WM._sharedWxCache = WM._sharedWxCache || new Map();

  const WX_ONLINE_TTL = 30 * 60e3;
  const WX_OFFLINE_TTL = 7 * 24 * 3600e3;

  function loadWxCacheFromLS() {
    try {
      const now = Date.now();
      ['wm_audibility_wx_cache_v1', 'wm_viewshed_wx_cache_v1', WX_LS_KEY].forEach(kStore => {
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

  const WX_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'rain', 'showers', 'snowfall',
    'snow_depth', 'weather_code', 'pressure_msl', 'surface_pressure', 'cloud_cover',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility',
    'wind_speed_10m', 'wind_direction_10m', 'cape'
  ];

  function saveWxCacheToLS() {
    try {
      const entries = Array.from(weatherCache.entries()).sort((a, b) => b[1].t - a[1].t).slice(0, 6);
      const out = {};
      entries.forEach(([k, v]) => { out[k] = v; });
      localStorage.setItem(WX_LS_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  function findOfflineWeather(lat, lng) {
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    const exact = weatherCache.get(key);
    if (exact && (Date.now() - exact.t < WX_OFFLINE_TTL)) return exact.json;

    let best = null, bestD = 0.09; // до ~30 км
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
      throw new Error('Offline');
    }

    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4) +
      '&hourly=' + WX_VARS.join(',') + '&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&past_days=3&forecast_days=7';

    if (!NetHealth.isAvailable(url)) {
      const off = findOfflineWeather(lat, lng);
      if (off) return off;
      throw new Error('Open-Meteo blocked');
    }

    const t0 = performance.now();
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), 2400) : null;
    try {
      const resp = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (to) clearTimeout(to);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (!json || !json.hourly || !json.hourly.time) throw new Error('Bad JSON');
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

    const dir0 = g('wind_direction_10m', 240);
    const rainMain = Math.max(0, g('rain', 0));
    const showers = Math.max(0, g('showers', 0));
    const totalRain = rainMain + showers;

    const cAll = clamp(g('cloud_cover', 20) / 100, 0, 1);
    const cLowRaw = g('cloud_cover_low', null);
    const cMidRaw = g('cloud_cover_mid', null);
    const cHighRaw = g('cloud_cover_high', null);
    const cloudLow = cLowRaw != null ? clamp(cLowRaw / 100, 0, 1) : null;
    const cloudMid = cMidRaw != null ? clamp(cMidRaw / 100, 0, 1) : null;
    const cloudHigh = cHighRaw != null ? clamp(cHighRaw / 100, 0, 1) : null;
    // Нижний ярус блокирует выхолаживание на 100%, средний на 65%, перистые (верхний) почти не мешают (20%)
    const cloudEff = (cloudLow != null || cloudMid != null || cloudHigh != null)
      ? clamp(1 - (1 - (cloudLow || 0)) * (1 - 0.65 * (cloudMid || 0)) * (1 - 0.20 * (cloudHigh || 0)), 0, 1)
      : cAll;

    const visRaw = g('visibility', null);
    const visibility = visRaw != null ? Math.max(20, visRaw) : null;
    const cape = Math.max(0, g('cape', 0));
    const code = near('weather_code', 0);
    const fog = code === 45 || code === 48 || (visibility != null && visibility < 1000);

    return {
      source: navigator.onLine === false ? 'offline-cache' : 'online',
      T: g('temperature_2m', 14),
      RH: clamp(g('relative_humidity_2m', 60), 5, 100),
      P: g('surface_pressure', g('pressure_msl', 1013.25)),
      rain: totalRain,
      showers,
      snow: Math.max(0, g('snowfall', 0)),
      snowDepthM: Math.max(0, g('snow_depth', 0)),
      cloud: cAll,
      cloudLow,
      cloudMid,
      cloudHigh,
      cloudEff,
      visibility,
      cape,
      wind: Math.max(0, g('wind_speed_10m', 2)),
      windDir: ((dir0 % 360) + 360) % 360,
      code,
      fog
    };
  }

  function getEffectiveSeason(date, lat) {
    if (S.season && S.season !== 'auto') return S.season;
    const d = date || new Date();
    const m = d.getMonth() + 1;
    const isSouth = lat < 0;
    if (!isSouth) {
      if (m >= 5 && m <= 9) return 'summer';
      if (m >= 11 || m <= 3) return 'winter';
      return 'spring_fall';
    } else {
      if (m >= 11 || m <= 3) return 'summer';
      if (m >= 5 && m <= 9) return 'winter';
      return 'spring_fall';
    }
  }

  // ---------------------------------------------------------------------------
  // ISO 9613-1 АТМОСФЕРНОЕ ПОГЛОЩЕНИЕ ЗВУКА + СКОРОСТЬ ЗВУКА + СРЕДА
  // ---------------------------------------------------------------------------
  function iso9613AtmAlphaDbPerKm(freqHz, tempC, rhPct, pressureHpa) {
    const T_0 = 293.15;
    const T_01 = 273.16;
    const T_K = clamp(tempC + 273.15, 220, 330);
    const p_r = 101.325;
    const p_a = clamp((pressureHpa || 1013.25) * 0.1, 40, 110); // hPa -> kPa
    const RH = clamp(rhPct, 5, 100);

    const C = -6.8346 * Math.pow(T_01 / T_K, 1.261) + 4.6151;
    const pSatRatio = Math.pow(10, C);
    const h = RH * (pSatRatio / (p_a / p_r));

    const f = clamp(freqHz, 40, 10000);
    const f_rO = (p_a / p_r) * (24 + 4.04e4 * h * ((0.02 + h) / (0.391 + h)));
    const f_rN = (p_a / p_r) * Math.pow(T_K / T_0, -0.5) *
      (9 + 280 * h * Math.exp(-4.170 * (Math.pow(T_K / T_0, -1 / 3) - 1)));

    const f2 = f * f;
    const term1 = 1.84e-11 * (p_r / p_a) * Math.sqrt(T_K / T_0);
    const termO = 0.01275 * Math.exp(-2239.1 / T_K) / (f_rO + f2 / f_rO);
    const termN = 0.1068 * Math.exp(-3352.0 / T_K) / (f_rN + f2 / f_rN);
    const alphaPerMeter = 8.686 * f2 * (term1 + Math.pow(T_K / T_0, -2.5) * (termO + termN));
    return alphaPerMeter * 1000.0; // дБ / км
  }

  function getHintForDb(db, mode) {
    const list = (mode === 'emit') ? EMIT_HINTS : HEAR_HINTS;
    for (let i = 0; i < list.length; i++) {
      if (db <= list[i].max) return list[i];
    }
    return list[list.length - 1];
  }

  function getEffectiveFreqHz(db) {
    if (S.freqBand === 'low') return 260;
    if (S.freqBand === 'mid') return 850;
    if (S.freqBand === 'high') return 2600;
    if (S.activePreset && Math.abs(db - S.activePreset.db) <= 5) {
      return S.activePreset.freq;
    }
    const h = getHintForDb(db, S.mode);
    return h ? h.freq : 800;
  }

  function getEffectiveSoundKind(db) {
    if (S.activePreset && Math.abs(db - S.activePreset.db) <= 5 && S.activePreset.kind) {
      return S.activePreset.kind;
    }
    const h = getHintForDb(db, S.mode);
    return (h && h.kind) ? h.kind : (db >= 132 ? 'impulse' : 'voice');
  }




  const BAND_FREQS = [220, 900, 2800]; // НЧ (гул/огибание), СЧ (речь/лай), ВЧ (свист/разборчивость)

  function getBandWeights(freqHz, kind, freqBand) {
    if (freqBand === 'low')  return [0.80, 0.17, 0.03];
    if (freqBand === 'mid')  return [0.12, 0.76, 0.12];
    if (freqBand === 'high') return [0.03, 0.17, 0.80];

    const f = clamp(freqHz || 850, 80, 5000);
    const lF = Math.log10(f);
    const l0 = Math.log10(BAND_FREQS[0]);
    const l1 = Math.log10(BAND_FREQS[1]);
    const l2 = Math.log10(BAND_FREQS[2]);

    let wL, wM, wH;
    if (kind === 'tonal') {
      if (lF <= l1) {
        const t = clamp((lF - l0) / (l1 - l0), 0, 1);
        wL = lerp(0.84, 0.10, t);
        wM = lerp(0.14, 0.82, t);
        wH = lerp(0.02, 0.08, t);
      } else {
        const t = clamp((lF - l1) / (l2 - l1), 0, 1);
        wL = lerp(0.10, 0.02, t);
        wM = lerp(0.82, 0.14, t);
        wH = lerp(0.08, 0.84, t);
      }
    } else if (kind === 'voice') {
      const shift = clamp((lF - l1) / (l2 - l0), -0.5, 0.5);
      wL = clamp(0.24 - shift * 0.24, 0.08, 0.42);
      wH = clamp(0.18 + shift * 0.24, 0.08, 0.36);
      wM = 1.0 - wL - wH;
    } else if (kind === 'impulse') {
      const t = clamp((lF - l0) / (l1 - l0), 0, 1);
      wL = lerp(0.64, 0.42, t);
      wM = lerp(0.26, 0.40, t);
      wH = 1.0 - wL - wM;
    } else {
      if (lF <= l1) {
        const t = clamp((lF - l0) / (l1 - l0), 0, 1);
        wL = lerp(0.68, 0.30, t);
        wM = lerp(0.25, 0.50, t);
        wH = 1.0 - wL - wM;
      } else {
        const t = clamp((lF - l1) / (l2 - l1), 0, 1);
        wL = lerp(0.30, 0.06, t);
        wM = lerp(0.50, 0.32, t);
        wH = 1.0 - wL - wM;
      }
    }
    const sum = wL + wM + wH;
    return [wL / sum, wM / sum, wH / sum];
  }

  async function buildAcousticEnv(lat, lng) {
    const customTime = S.time.mode === 'custom' && S.time.ts;
    const date = customTime ? new Date(S.time.ts) : new Date();
    const sunAltDeg = getSunAltitudeDeg(date, lat, lng);
    const season = getEffectiveSeason(date, lat);

    let wx = null;
    const notes = [];

    if (S.factors.weather || S.factors.wind) {
      if (S.wx.source === 'manual') {
        const pr = WX_PRESETS[S.wx.preset] || WX_PRESETS.clear;
        wx = {
          source: 'manual',
          T: S.wx.tempC != null ? S.wx.tempC : pr.T,
          RH: S.wx.rh != null ? S.wx.rh : pr.RH,
          P: 1013.25,
          rain: pr.rain,
          showers: 0,
          snow: pr.snow,
          snowDepthM: season === 'winter' ? 0.25 : 0,
          cloud: pr.cloud,
          cloudEff: pr.cloud,
          visibility: pr.visibility != null ? pr.visibility : 20000,
          cape: pr.cape || 0,
          wind: S.wx.windSpeed != null ? S.wx.windSpeed : pr.wind,
          windDir: S.wx.windDir != null ? S.wx.windDir : 240,
          fog: !!pr.fog
        };
      } else {
        try {
          const json = await fetchWeather(lat, lng);
          wx = wxAtTime(json, date);
          if (wx && wx.source === 'offline-cache') notes.push('погода из оффлайн-кэша');
        } catch (e) {
          notes.push('нет сети: погода принята стандартной');
        }
      }
    }

    if (!wx) {
      wx = {
        source: 'fallback',
        T: season === 'winter' ? -4 : 15,
        RH: 60,
        P: 1013.25,
        rain: 0,
        showers: 0,
        snow: 0,
        snowDepthM: season === 'winter' ? 0.25 : 0,
        cloud: 0.2,
        cloudEff: 0.2,
        visibility: 20000,
        cape: 50,
        wind: 1.8,
        windDir: 240,
        fog: false
      };
    }

    const tempC = S.factors.weather ? wx.T : (season === 'winter' ? -4 : 15);
    const rh = S.factors.weather ? wx.RH : 60;
    const pressHpa = S.factors.weather ? (wx.P || 1013.25) : 1013.25;
    const windSpeed = S.factors.wind ? wx.wind : 0;
    const windFromDir = S.factors.wind ? wx.windDir : 240;
    const windToDir = (windFromDir + 180) % 360;
    const rain = S.factors.weather ? wx.rain : 0;
    const snowfall = S.factors.weather ? wx.snow : 0;
    const cloud = S.factors.weather ? wx.cloud : 0.2;
    const cloudEff = S.factors.weather ? (wx.cloudEff != null ? wx.cloudEff : cloud) : 0.2;
    const visibility = (S.factors.weather && wx.visibility != null) ? wx.visibility : 20000;
    const cape = S.factors.weather ? (wx.cape || 0) : 0;

    const soundSpeed = 331.3 + 0.606 * tempC;
    const freqHz = getEffectiveFreqHz(S.volumeDb);
    const soundKind = getEffectiveSoundKind(S.volumeDb);
    const lambda = soundSpeed / freqHz;

    // 3-полосный спектр источника и поглощение в воздухе (+ дымка/туман по visibility)
    const bandWeights = getBandWeights(freqHz, soundKind, S.freqBand);
    const fogStrength = S.factors.weather
      ? (wx.fog ? Math.max(0.65, smooth(2500, 200, visibility)) : smooth(3000, 300, visibility))
      : 0;
    const fogAlphaBands = [0.05 * fogStrength, 0.45 * fogStrength, 2.2 * fogStrength];
    const alphaBands = [
      iso9613AtmAlphaDbPerKm(BAND_FREQS[0], tempC, rh, pressHpa) + fogAlphaBands[0],
      iso9613AtmAlphaDbPerKm(BAND_FREQS[1], tempC, rh, pressHpa) + fogAlphaBands[1],
      iso9613AtmAlphaDbPerKm(BAND_FREQS[2], tempC, rh, pressHpa) + fogAlphaBands[2]
    ];
    const alphaDbKm = iso9613AtmAlphaDbPerKm(freqHz, tempC, rh, pressHpa) +
      (freqHz > 1400 ? 1.8 * fogStrength * smooth(1200, 3000, freqHz) : 0);

    const hasSnowCover = S.factors.snow && (
      season === 'winter' ||
      (wx.snowDepthM != null && wx.snowDepthM >= 0.03) ||
      snowfall >= 0.1 ||
      (tempC <= -2 && wx.T <= -2 && season !== 'summer')
    );

    const leafFactor = !S.factors.foliage ? 0 : (season === 'summer' ? 1.0 : (season === 'spring_fall' ? 0.55 : 0.25));

    const seasonNoiseShift = season === 'winter' ? -2.8 : (season === 'summer' ? 0.8 : 0.0);
    let baseAmbientDb = 30.0 + seasonNoiseShift;
    let timePhase = 'день';
    let inversionStrength = 0;

    if (S.factors.timeOfDay) {
      if (sunAltDeg < -6) {
        timePhase = 'ночь';
        baseAmbientDb = 21.5 + seasonNoiseShift;
        inversionStrength = (1 - 0.65 * cloudEff) * clamp(1 - windSpeed / 7.5, 0.2, 1.0);
      } else if (sunAltDeg < 8) {
        timePhase = sunAltDeg < 0 ? 'сумерки' : 'утро/вечер';
        const t = smooth(-6, 8, sunAltDeg);
        baseAmbientDb = lerp(22.5, 29.5, t) + seasonNoiseShift;
        inversionStrength = lerp(0.85, 0.15, t) * (1 - 0.55 * cloudEff) * clamp(1 - windSpeed / 8, 0.15, 1.0);
      } else {
        timePhase = 'день';
        baseAmbientDb = lerp(33.0, 38.0, smooth(8, 40, sunAltDeg)) + seasonNoiseShift;
        const dayConv = (hasSnowCover || season === 'winter') ? -0.14 : -0.52;
        inversionStrength = dayConv * (1 - 0.45 * cloudEff);
      }
      // Низкая видимость (дымка/туман) при слабом ветре указывает на сильную приземную инверсию
      if (S.factors.weather && fogStrength > 0.25 && windSpeed < 3.8 && sunAltDeg < 12) {
        const fogInv = lerp(0.35, 0.88, fogStrength) * clamp(1 - windSpeed / 4.2, 0.1, 1.0) * smooth(12, -2, sunAltDeg);
        inversionStrength = Math.max(inversionStrength, fogInv);
      }
    }

    // Динамическое турбулентное рассеяние (днём при высоком CAPE в 3-4 раза выше, чем ночью/в пасмурный день)
    const dayThermal = (S.factors.timeOfDay && sunAltDeg > 2)
      ? smooth(2, 42, sunAltDeg) * (1 - 0.65 * cloudEff) * (hasSnowCover ? 0.35 : 1.0)
      : 0;
    const capeTurb = (S.factors.weather && cape > 60)
      ? smooth(60, 1600, cape) * (sunAltDeg > 0 ? 1.0 : 0.35)
      : 0;
    const windTurb = S.factors.wind ? smooth(2.0, 12.0, windSpeed) * 0.45 : 0;
    const turbDbKm = 0.18 + 0.55 * dayThermal + 0.65 * capeTurb + windTurb;

    let windNoiseDb = 0;
    if (S.factors.wind && windSpeed > 1.2) {
      const foliageNoiseMult = season === 'summer' ? 1.2 : (season === 'winter' ? 0.6 : 0.9);
      windNoiseDb = 10 * Math.log10(1 + Math.pow((windSpeed - 1.2) / 2.4, 2.0) * foliageNoiseMult);
    }
    let rainNoiseDb = 0;
    if (S.factors.weather && rain > 0.05) {
      rainNoiseDb = 8.0 + 7.5 * Math.log10(1 + rain);
    } else if (S.factors.weather && snowfall > 0.1) {
      rainNoiseDb = -1.5;
    }

    let totalAmbientDb = 30.0;
    if (S.factors.ambientNoise) {
      let pwr = Math.pow(10, baseAmbientDb / 10);
      if (windNoiseDb > 0.2) pwr += Math.pow(10, (17.5 + windNoiseDb) / 10);
      if (rainNoiseDb > 0) pwr += Math.pow(10, (24 + rainNoiseDb) / 10);
      totalAmbientDb = clamp(10 * Math.log10(pwr) + (rainNoiseDb < 0 ? rainNoiseDb : 0) + (S.ambientOffsetDb || 0), 14, 72);
    } else {
      totalAmbientDb = clamp(30.0 + (S.ambientOffsetDb || 0), 14, 72);
    }

    const rainMaskPenalty = (S.factors.weather && rain > 0.1) ? clamp(rain * 0.65, 0, 3.0) : 0;
    const windMaskPenalty = (S.factors.wind && windSpeed > 3.5) ? clamp((windSpeed - 3.5) * 0.3, 0, 2.8) : 0;

    // Распределение фонового шума и пороги обнаружения по 3 октавам
    const rainShare = (S.factors.weather && rain > 0.2) ? clamp(rainNoiseDb / 22, 0, 0.7) : 0;
    const windShare = (S.factors.wind && windSpeed > 3.0) ? clamp((windSpeed - 3.0) / 12, 0, 0.5) * leafFactor : 0;
    const ambFrac = [
      lerp(lerp(0.54, 0.46, windShare), 0.25, rainShare),
      lerp(lerp(0.34, 0.34, windShare), 0.40, rainShare),
      lerp(lerp(0.12, 0.20, windShare), 0.35, rainShare)
    ];

    const calcAbsFloor = (f) => {
      const earRes = -3.0 * Math.exp(-Math.pow((Math.log10(clamp(f, 100, 6000)) - Math.log10(2900)) / 0.24, 2));
      const lowLift = f < 800 ? 32.0 * Math.pow(Math.log10(800 / Math.max(80, f)), 2.0) : 0;
      return 2.5 + earRes + lowLift;
    };
    const calcKindBonus = (f) => {
      const fL = clamp((Math.log10(clamp(f, 150, 4500)) - Math.log10(250)) / (Math.log10(3200) - Math.log10(250)), 0, 1);
      if (soundKind === 'tonal')   return lerp(7.5, 13.5, fL);
      if (soundKind === 'voice')   return lerp(4.5, 7.5, fL);
      if (soundKind === 'impulse') return -4.5;
      return lerp(3.0, 6.0, fL);
    };

    const ambBands = [
      totalAmbientDb + 10 * Math.log10(ambFrac[0]),
      totalAmbientDb + 10 * Math.log10(ambFrac[1]),
      totalAmbientDb + 10 * Math.log10(ambFrac[2])
    ];
    const thrBands = BAND_FREQS.map((f, b) =>
      Math.max(calcAbsFloor(f), ambBands[b] - (calcKindBonus(f) - rainMaskPenalty - windMaskPenalty))
    );

    const detectThresholdDb = Math.max(
      calcAbsFloor(freqHz),
      totalAmbientDb - (calcKindBonus(freqHz) - rainMaskPenalty - windMaskPenalty)
    );

    const env = {
      date, sunAltDeg, season, timePhase, wx,
      tempC, rh, pressHpa, windSpeed, windFromDir, windToDir, rain, snowfall,
      cloud, cloudEff, visibility, cape, fogStrength, turbDbKm,
      soundSpeed, freqHz, soundKind, lambda, alphaDbKm,
      bandWeights, alphaBands, ambBands, thrBands,
      hasSnowCover, leafFactor,
      inversionStrength, baseAmbientDb, windNoiseDb, rainNoiseDb,
      ambientDb: totalAmbientDb,
      detectThresholdDb,
      notes
    };

    env.key = [
      Math.round(date.getTime() / (S.time.mode === 'now' ? 600000 : 60000)),
      S.mode, Math.round(S.volumeDb), S.freqBand, Math.round(freqHz), soundKind, season,
      tempC.toFixed(1), Math.round(rh), windSpeed.toFixed(1), Math.round(windFromDir),
      rain.toFixed(1), snowfall.toFixed(1), Math.round(cloudEff * 20), Math.round(cape / 100),
      Math.round(fogStrength * 10), Math.round(totalAmbientDb * 2),
      

  Object.values(S.factors).map(v => v ? 1 : 0).join('')
    ].join('|');

    return env;
  }

  function estimateAutoRadiusKm(env) {
    const excessDb = Math.max(10, S.volumeDb - env.detectThresholdDb + 3.0);
    const alphaKm = Math.max(0.45, env.alphaDbKm * 0.85 + 0.32);
    let d = Math.pow(10, excessDb / 20);
    for (let it = 0; it < 5; it++) {
      const f = 20 * Math.log10(Math.max(1, d)) + alphaKm * (d / 1000) - excessDb;
      const df = (20 / (Math.LN10 * Math.max(1, d))) + alphaKm / 1000;
      d = clamp(d - f / df, 120, 50000);
    }
    const km = clamp((d * 1.25) / 1000, 0.12, 50);
    if (km < 0.5) return Math.round(km * 25) / 25;
    if (km < 1) return Math.round(km * 10) / 10;
    if (km < 5) return Math.round(km * 2) / 2;
    return Math.round(km);
  }

  // ---------------------------------------------------------------------------
  // PASS 1 — СБОР ГЕОМЕТРИИ (РЕЛЬЕФ + ВОДОЁМЫ + ДЕРЕВЬЯ)
  // ---------------------------------------------------------------------------
  function getTreeHeightAt(lat, lng) {
    if (!S.factors.foliage) return 0;
    try {
      if (WM.canopy) {
        if (typeof WM.canopy.getTreeHeight === 'function') return Math.max(0, WM.canopy.getTreeHeight(lat, lng) || 0);
        if (typeof WM.canopy.getHeightAt === 'function') return Math.max(0, WM.canopy.getHeightAt(lat, lng) || 0);
        if (typeof WM.canopy.getCanopyHeight === 'function') return Math.max(0, WM.canopy.getCanopyHeight(lat, lng) || 0);
      }
    } catch (e) {}
    return 0;
  }

  function getTreeHeightNorm(xn, yn) {
    if (!S.factors.foliage) return 0;
    if (WM.canopy && typeof WM.canopy.getHeightAtNorm === 'function') {
      return Math.max(0, WM.canopy.getHeightAtNorm(xn, yn) || 0);
    }
    return getTreeHeightAt(mercLat(yn), xn * 360.0 - 180.0);
  }

  function runSliced(token, n, body, budgetMs, onProgress, checkStride = 8) {
    const budget = budgetMs || 14;
    const mask = checkStride <= 1 ? 0 : (checkStride - 1);
    return new Promise(resolve => {
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
          if (t - lastProg > 120) { lastProg = t; onProgress(i / n); }
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
    const ws = [];
    for (let i = 0; i < 8; i++) ws.push(worker());
    await Promise.all(ws);
    return { total, fail };
  }

  async function loadCanopyWithFallback(lat0, lng0, canopyMaxDistM, token, onProgressUpdate) {
    const STALL_TIMEOUT_MS = 8000;  // 8 с без прогресса — источник завис
    const HARD_TIMEOUT_MS = 15000;  // 15 с максимум на одну версию

    const isResReady = (res) => (
      !!res && !res._timedOut && !res._aborted && (res.total === 0 || res.failed === 0)
    );

    const safeSetCanopyVersion = (ver) => {
      if (typeof WM.canopy.setVersion !== 'function') return;
      _internalCanopySwitch = true;
      try {
        WM.canopy.setVersion(ver, { skipViewshedSchedule: true });
      } finally {
        _internalCanopySwitch = false;
      }
    };

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

    // Если выбрана v2, но модуль canopyV2 не загружен — сразу уходим на v1
    if (initialVer === 'v2' && !WM.canopyV2 && typeof WM.canopy.setVersion === 'function') {
      safeSetCanopyVersion('v1');
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
    toast(`🌲 Лес (${initialVer.toUpperCase()}): ${reason} — переключаюсь на ${fallbackVer.toUpperCase()}`, 3200);

    safeSetCanopyVersion(fallbackVer);

    const res2 = await runAttempt(fallbackVer);
    if (token !== pipeToken || (res2 && res2._aborted)) return { _aborted: true };

    if (isResReady(res2)) {
      return { ok: true, res: res2, version: fallbackVer, switchedFrom: initialVer };
    }

    // Если не ответили оба источника — возвращаем исходную настройку пользователя
    safeSetCanopyVersion(initialVer);
    return { ok: false, res: res2, version: fallbackVer, switchedFrom: initialVer };
  }

  async function buildGeometry(lat0, lng0, Rm, token, setStatus) {
    const Q = QUALITY[S.quality] || QUALITY.standard;
    const latRad = lat0 * DEG;
    const serial = ++jobSerial;

    // Параллельная подгрузка воды и крон

    const canopyMaxDistM = Math.min(Rm, 6500);
    let wDone = 0, wTotal = 0;
    let cDone = 0, cTotal = 0, cFinished = false;
    let cVer = (WM.canopy && typeof WM.canopy.getVersion === 'function') ? WM.canopy.getVersion() : 'v1';

    const updEnvWait = () => {
      if (token !== pipeToken) return;
      const parts = [];
      if (wTotal > 0 && wDone < wTotal) parts.push(`Вода ${wDone}/${wTotal}`);
      if (S.factors.foliage && !cFinished) {
        parts.push(cTotal > 0 ? `Лес ${cVer} ${cDone}/${cTotal}` : `Лес ${cVer}…`);
      }
      const txt = parts.length ? parts.join(' · ') : 'Среда';
      setStatus && setStatus(`⏳ Загрузка (${txt})…`);
      updateMarkerProgress(`⏳ ${txt}`);
    };

    const waterP = S.factors.water
      ? preloadWaterArea(lat0, lng0, Rm, token, (d, t) => { wDone = d; wTotal = t; }).catch(() => null)
      : Promise.resolve();

    let canopyP = Promise.resolve({ ok: true });
    if (S.factors.foliage && WM.canopy && typeof WM.canopy.loadCanopyArea === 'function') {
      canopyP = loadCanopyWithFallback(lat0, lng0, canopyMaxDistM, token, (ver, d, t) => {
        cVer = ver;
        cDone = d;
        cTotal = t;
      }).then((outcome) => {
        cFinished = true;
        return outcome;
      });
    } else {
      cFinished = true;
    }


    let levels = [], levelFb = null, Ssz = 256;
    let resTiles = { total: 0, fail: 0 };
    let flatMode = !S.factors.relief;

    // Шаги сетки: плотная ближняя зона для тихих звуков (мыши/кузнечики) и плавный рост вдаль
    const stepNear = clamp(Rm / 160, 1.0, 18);
    const BAND_EDGES = [0, Math.min(Rm * 0.08, 300), Math.min(Rm * 0.25, 1800), Math.min(Rm * 0.6, 8000), Infinity];
    const stepBand = [
      stepNear,
      Math.max(stepNear * 2.0, Math.min(S.factors.foliage ? 22 : 999, Rm / 120)),
      Math.max(stepNear * 4.5, Rm / 85),
      Math.max(stepNear * 8, Rm / 60)
    ];

    if (!flatMode) {
      await ensureTileSize(lat0, lng0, serial);
      if (token !== pipeToken) return null;
      Ssz = demS;

      const BAND_TEXEL = [10, 25, 65, 150];
      const zBand = [];
      for (let b = 0; b < 4; b++) {
        let z = zoomForTexel(BAND_TEXEL[b] * Q.texelScale, latRad, Ssz);
        if (b > 0 && z > zBand[b - 1]) z = zBand[b - 1];
        zBand.push(z);
        stepBand[b] = Math.max(stepNear, Math.min(stepBand[b], Math.max(3, texelMeters(z, latRad, Ssz))));
      }
      const zFb = clamp(Math.min(zoomForTexel(360 * Q.texelScale, latRad, Ssz), zBand[3] - 1), 3, 15);
      levels = zBand.map(z => makeLevel(z, Ssz));
      levelFb = makeLevel(zFb, Ssz);

      const want = new Map();
      const addRing = (z, dMin, dMax) => {
        tilesForRing(lat0, lng0, z, dMin, dMax).forEach(([x, y]) => want.set(tileKey(z, x, y), [z, x, y]));
      };
      for (let b = 0; b < 4; b++) {
        if (BAND_EDGES[b] >= Rm) break;
        addRing(zBand[b], BAND_EDGES[b], Math.min(BAND_EDGES[b + 1], Rm) + stepBand[b] * 2);
      }

      addRing(zFb, 0, Rm + 500);
      const list = Array.from(want.values()).sort((a, b) => b[0] - a[0]);

      setStatus && setStatus(`⏳ Рельеф DEM (${list.length} тайлов)…`);
      updateMarkerProgress('⏳ DEM', true);
      resTiles = await loadTiles(list, token, (done, total) => {
        setStatus && setStatus(`⏳ Загрузка DEM: <b>${done}/${total}</b>…`);
        updateMarkerProgress(`⏳ DEM ${done}/${total}`);
      });
      if (token !== pipeToken) return null;

      if (resTiles.total > 0 && resTiles.fail >= resTiles.total) {
        flatMode = true; // Оффлайн-фоллбэк на ровную местность с уведомлением
      }
    }

    updEnvWait();
    const envTicker = setInterval(updEnvWait, 200);
    let canopyOutcome = null;
    try {
      const [, cRes] = await Promise.all([waterP, canopyP]);
      canopyOutcome = cRes;
    } finally {
      clearInterval(envTicker);
    }
    if (token !== pipeToken) return null;

    if (S.factors.foliage && WM.canopy && typeof WM.canopy.loadCanopyArea === 'function') {
      if (!canopyOutcome || canopyOutcome._aborted) return null;
    }
    const canopyUnavailable = !!(
      S.factors.foliage &&
      WM.canopy &&
      typeof WM.canopy.loadCanopyArea === 'function' &&
      !canopyOutcome.ok
    );
    const distArr = [], bandArr = [];
    let d = Math.max(1.0, stepBand[0]);
    while (d <= Rm) {
      let b = 0;
      while (b < 3 && d >= BAND_EDGES[b + 1]) b++;
      distArr.push(d);
      bandArr.push(b);
      d += stepBand[b];
    }
    if (distArr.length === 0 || distArr[distArr.length - 1] < Rm * 0.96) {
      distArr.push(Rm);
      bandArr.push(3);
    }

    const nSteps = distArr.length;
    const dist = Float64Array.from(distArr);
    const band = Uint8Array.from(bandArr);
    let nRays = Math.min(Q.nRays, Math.floor(Q.maxCells / Math.max(1, nSteps)));
    nRays = Math.max(120, (nRays + 3) & ~3);

    const x0 = (lng0 + 180) / 360, y0 = mercY(lat0);
    let obsGround = 0;
    if (!flatMode && levels.length) {
      levels.forEach(L => { L.lastKey = -1; L.lastTile = null; });
      levelFb.lastKey = -1; levelFb.lastTile = null;
      obsGround = sampleLevel(levels[0], x0, y0);
      if (obsGround !== obsGround) obsGround = sampleLevel(levelFb, x0, y0);
      if (obsGround !== obsGround) obsGround = 0;
      if (S.observerSnap) {
        const delta = 0.0002;
        [[delta, 0], [-delta, 0], [0, delta], [0, -delta]].forEach(([dl, dg]) => {
          const v = sampleLevel(levels[0], (lng0 + dg + 180) / 360, mercY(lat0 + dl));
          if (v === v && v > obsGround) obsGround = v;
        });
      }
    }

    const totalCells = nRays * nSteps;
    const hgt = new Float32Array(totalCells);
    const treeHgt = new Float32Array(totalCells);
    const waterM = new Uint8Array(totalCells);
    const sinD = new Float64Array(nSteps), cosD = new Float64Array(nSteps);
    for (let i = 0; i < nSteps; i++) {
      const a = dist[i] / R_EARTH;
      sinD[i] = Math.sin(a);
      cosD[i] = Math.cos(a);
    }

    const phi0 = lat0 * DEG, lam0 = lng0 * DEG, sinP0 = Math.sin(phi0), cosP0 = Math.cos(phi0);
    const dTh = TAU / nRays;
    const sinTArr = new Float64Array(nRays), cosTArr = new Float64Array(nRays);
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

        let h = obsGround;
        if (!flatMode) {
          const b = band[i];
          h = sampleLevel(levels[b], xn, yn);
          if (h !== h) h = sampleLevel(levelFb, xn, yn);
          if (h !== h) h = prevH;
        }
        hgt[off + i] = h;
        prevH = h;

        const sLat = mercLat(yn);
        const sLng = xn * 360 - 180;
        if (S.factors.foliage && dist[i] <= canopyMaxDistM) {
          treeHgt[off + i] = getTreeHeightNorm(xn, yn);
        }
        if (S.factors.water) {
          const sLat = mercLat(yn);
          const sLng = xn * 360 - 180;
          waterM[off + i] = getWaterAt(sLat, sLng, h);
        }
      }
    }, 14, p => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Сбор рельефа и среды: <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Рельеф ${pct}%`);
    });

    if (!ok) return null;
    trimStore(serial);

    const obsTreeH = getTreeHeightAt(lat0, lng0);
    const obsWater = getWaterAt(lat0, lng0, obsGround);

    return {
      key: geoKeyOf(lat0, lng0, Rm),
      lat0, lng0, Rm, nRays, nSteps, dTh, dist, hgt, treeHgt, waterM,
      sinTArr, cosTArr, obsGround, obsTreeH, obsWater,
      flatMode,
      demMissingOffline: (!flatMode ? false : (S.factors.relief && resTiles.fail >= resTiles.total && resTiles.total > 0)),
      canopyUnavailable,
      tiles: resTiles.total, tilesFail: resTiles.fail
    };
  }

  const geoKeyOf = (lat, lng, Rm) => {
    const canopyVer = (S.factors.foliage && WM.canopy && typeof WM.canopy.getVersion === 'function')
      ? WM.canopy.getVersion()
      : '0';
    return [
      lat.toFixed(5), lng.toFixed(5), Math.round(Rm), S.quality,
      S.factors.relief ? 1 : 0, S.factors.foliage ? 1 : 0, S.factors.water ? 1 : 0,
      canopyVer,
      S.observerSnap ? 1 : 0, demSourceId()
    ].join('|');
  };

  // ---------------------------------------------------------------------------
  // PASS 2 + 2.5 — АКУСТИЧЕСКОЕ ПОЛЕ (ПРЯМОЙ ЛУЧ + ДИФРАКЦИЯ + ОТРАЖЕНИЯ ОТ РЕЛЬЕФА)
  // ---------------------------------------------------------------------------
  async function computeAudibility(G, env, token, setStatus) {
    const nRays = G.nRays;
    const nSteps = G.nSteps;
    const total = nRays * nSteps;

    const dirDb = new Float32Array(total);
    const reflDb = new Float32Array(total).fill(-200);
    const totalDb = new Float32Array(total);
    const bandL = new Float32Array(total);
    const bandM = new Float32Array(total);
    const bandH = new Float32Array(total);
    const reflL = new Float32Array(total).fill(-200);
    const reflM = new Float32Array(total).fill(-200);
    const reflH = new Float32Array(total).fill(-200);
    const effMargin = new Float32Array(total);
    const intelMargin = new Float32Array(total);
    const barLoss = new Float32Array(total);
    const bestReflCell = new Int32Array(total).fill(-1);

    const obsH = G.obsGround + S.earHeight;
    const tgtHOffset = S.sourceHeight;
    const L1 = S.volumeDb;
    const isEmit = (S.mode === 'emit');
    const windSign = isEmit ? 1 : -1; // В режиме 'hear' звук идёт К наблюдателю, поэтому ветер усиливает с наветренной стороны
    const detThrDb = env.detectThresholdDb;

    const w0 = env.bandWeights[0], w1 = env.bandWeights[1], w2 = env.bandWeights[2];
    const L1_0 = L1 + 10 * Math.log10(Math.max(1e-4, w0));
    const L1_1 = L1 + 10 * Math.log10(Math.max(1e-4, w1));
    const L1_2 = L1 + 10 * Math.log10(Math.max(1e-4, w2));

    const alpha0 = env.alphaBands[0], alpha1 = env.alphaBands[1], alpha2 = env.alphaBands[2];
    const lam0 = env.soundSpeed / BAND_FREQS[0];
    const lam1 = env.soundSpeed / BAND_FREQS[1];
    const lam2 = env.soundSpeed / BAND_FREQS[2];
    const thr0 = env.thrBands[0], thr1 = env.thrBands[1], thr2 = env.thrBands[2];

    const turbBase = env.turbDbKm;
    const turb0 = turbBase * 0.65, turb1 = turbBase * 1.0, turb2 = turbBase * 1.45;

    const folFreq0 = clamp(Math.pow(BAND_FREQS[0] / 800, 0.42), 0.42, 1.85);
    const folFreq1 = clamp(Math.pow(BAND_FREQS[1] / 800, 0.42), 0.42, 1.85);
    const folFreq2 = clamp(Math.pow(BAND_FREQS[2] / 800, 0.42), 0.42, 1.85);
    const seasonAtt = 0.32 + 0.68 * env.leafFactor;

    const snowFreq0 = clamp(Math.pow(BAND_FREQS[0] / 800, 0.5), 0.35, 1.45);
    const snowFreq1 = clamp(Math.pow(BAND_FREQS[1] / 800, 0.5), 0.35, 1.45);
    const snowFreq2 = clamp(Math.pow(BAND_FREQS[2] / 800, 0.5), 0.35, 1.45);

    const invRacByRay = new Float64Array(nRays);
    const windSpreadingBias = new Float64Array(nRays);
    const windToRad = env.windToDir * DEG;

    for (let r = 0; r < nRays; r++) {
      const th = r * G.dTh;
      const windProj = S.factors.wind ? windSign * env.windSpeed * Math.cos(th - windToRad) : 0;
      const invGrad = S.factors.timeOfDay ? (env.inversionStrength * 0.00018) : 0;
      const windGrad = windProj * 0.000045;
      invRacByRay[r] = clamp(invGrad + windGrad, -1 / 1400, 1 / 1400);
      windSpreadingBias[r] = windProj;
    }

    const reflectors = [];
    const cellX = new Float32Array(total);
    const cellY = new Float32Array(total);

    // Буфер макро-блоков леса вдоль одного луча (~0% нагрузки и 0 аллокаций)
    const MAX_FBLK = 28;
    const fBlockSize = Math.max(2, Math.ceil(nSteps / MAX_FBLK));
    const fbDist = new Float64Array(MAX_FBLK);
    const fbTop = new Float64Array(MAX_FBLK);
    const fbWeight = new Float64Array(MAX_FBLK);

    const maekawaBand = (effDelta, lam, nFade, edgeFactor) => {
      const N = (2 * effDelta) / lam;
      if (N <= -0.10) return 0;
      const sArg = Math.sqrt(TAU * Math.max(0.001, N));
      const barRaw = 5.0 + 20.0 * Math.log10(Math.max(1.0, sArg / Math.tanh(sArg)));
      const nf = N < 0.04 ? smooth(-0.10, 0.04, N) : 1.0;
      return clamp(barRaw * nf * edgeFactor, 0, 22.5);
    };

    const powerSum2 = (a, b) => {
      if (b < -150) return a;
      if (a < -150) return b;
      const mx = a > b ? a : b;
      return mx + 10 * Math.log10(1 + Math.pow(10, -Math.abs(a - b) / 10));
    };
    const powerSum3 = (a, b, c) => powerSum2(powerSum2(a, b), c);

    const ok1 = await runSliced(token, nRays, (r) => {
      const off = r * nSteps;
      const sinT = G.sinTArr[r], cosT = G.cosTArr[r];
      const invRac = invRacByRay[r];
      const rPrev = (r - 1 + nRays) % nRays;
      const rNext = (r + 1) % nRays;
      const effCurvDiff = Math.max(0, invRac) - (1 / R_EARTH);

      let maxObsAngle = -Infinity;
      let peakIdx = -1;
      let peakH = obsH;
      let peakD = 0;

      let fbCount = 0;
      let curBlkSteps = 0;
      let curBlkDistSum = 0;
      let curBlkTopSum = 0;
      let curBlkWeight = 0;

      let waterMeters = 0;
      let corridorMeters = 0;
      let lastExitEmitD = -999;
      let prevTH = G.obsTreeH || 0;

      const windAbs = S.factors.wind ? env.windSpeed : 0;
      const waterCalm = clamp(1.0 - Math.max(0, windAbs - 1.8) / 6.5, 0.12, 1.0);
      const waterThermal = (env.season === 'winter') ? 0.55 : 1.0;

      for (let i = 0; i < nSteps; i++) {
        const d = G.dist[i];
        const stepD = i === 0 ? d : (d - G.dist[i - 1]);
        const idx = off + i;

        cellX[idx] = d * sinT;
        cellY[idx] = d * cosT;

        const hGround = G.hgt[idx];
        const hTgt = hGround + tgtHOffset;
        const tH = G.treeHgt[idx];
        const isW = G.waterM[idx];

        if (S.factors.foliage && tH >= 2.0) {
          const wStep = stepD * clamp((tH - 1.5) / 10.0, 0.35, 1.0);
          curBlkDistSum += d * wStep;
          curBlkTopSum += (hGround + tH) * wStep;
          curBlkWeight += wStep;
        }
        curBlkSteps++;

        if (isW) waterMeters += stepD;
        const waterFrac = waterMeters / Math.max(1, d);
        const waterEff = waterFrac * waterCalm * waterThermal;

        // 1. Геометрическое расхождение (волновод над водой смягчён и зависит от штиля)
        const invDuct = S.factors.timeOfDay ? Math.max(0, env.inversionStrength) * 0.72 : 0;
        const windDuct = (S.factors.wind && windSpreadingBias[r] > 0.8)
          ? Math.min(0.40, (windSpreadingBias[r] - 0.8) * 0.05) : 0;
        const waterDuct = S.factors.water ? waterEff * 0.48 : 0;
        const ductFactor = clamp(
          invDuct + windDuct * (1 - invDuct * 0.5) + waterDuct * (1 - invDuct * 0.4),
          0, 1.0
        );
        const minExp = lerp(16.8, 15.8, waterEff);
        const effExp = d > 100 ? lerp(20.0, minExp, ductFactor * smooth(100, 650, d)) : 20.0;
        const aDiv = 20.0 * Math.log10(Math.min(d, 100)) + (d > 100 ? effExp * Math.log10(d / 100) : 0);

        // 2. Атмосферное поглощение (ISO 9613-1 + туман) + динамическая турбулентность (CAPE + солнце)
        const distOver600 = d > 600 ? ((d - 600) * 0.001) : 0;
        const aAtm0 = alpha0 * (d * 0.001) + turb0 * distOver600;
        const aAtm1 = alpha1 * (d * 0.001) + turb1 * distOver600;
        const aAtm2 = alpha2 * (d * 0.001) + turb2 * distOver600;

        // 3. Рельеф и дифракция Maekawa по 3 полосам
        let aBar0 = 0, aBar1 = 0, aBar2 = 0;
        let isDiffractedOverPeak = false;
        if (S.factors.relief && peakIdx >= 0 && d > peakD + 1) {
          const d1 = peakD;
          const d2 = d - peakD;
          const rayMidLift = 0.5 * d1 * d2 * effCurvDiff;
          const chordHAtPeak = obsH + (hTgt - obsH) * (d1 / d) + rayMidLift;
          const hExcess = peakH - chordHAtPeak;
          isDiffractedOverPeak = hExcess > 0.2;

          if (hExcess > -1.0) {
            const dInv = 1 / Math.max(10, (d1 * d2) / d);
            const effDelta = hExcess > 0 ? (hExcess * hExcess) * 0.5 * dInv : -0.04 * Math.abs(hExcess);
            const edgeFactor = hExcess <= 0 ? 0.35 : lerp(0.3, 1.0, smooth(0.2, 3.0, hExcess));
            aBar0 = maekawaBand(effDelta, lam0, 0, edgeFactor);
            aBar1 = maekawaBand(effDelta, lam1, 0, edgeFactor);
            aBar2 = maekawaBand(effDelta, lam2, 0, edgeFactor);
          }
        }
        const aBarMean = w0 * aBar0 + w1 * aBar1 + w2 * aBar2;

        // Акустическая тень при встречном ветре или дневной конвекции
        let aShadow = 0;
        if (invRac < -1e-7 && d > 80) {
          const rayDrop = 0.5 * d * d * Math.abs(invRac);
          const clearance = (S.earHeight + tgtHOffset) * 0.5 + 1.2;
          if (rayDrop > clearance) {
            const excessShadow = (rayDrop - clearance) / Math.max(4, clearance);
            aShadow = clamp(8.5 * Math.log10(1 + excessShadow * 1.2), 0, 22.0);
          }
        }

        // 4. Поглощение лесом с проверкой реальной высоты луча над кронами
        let effForestMeters = 0;
        if (S.factors.foliage && (fbCount > 0 || curBlkWeight > 0.5)) {
          const evalForestBlock = (bx, bTop, bWeight) => {
            let zRay;
            if (isDiffractedOverPeak) {
              if (bx <= peakD) {
                const f = bx / Math.max(1, peakD);
                zRay = obsH + (peakH - obsH) * f + 0.5 * bx * (peakD - bx) * effCurvDiff;
              } else {
                const f = (bx - peakD) / Math.max(1, d - peakD);
                zRay = peakH + (hTgt - peakH) * f + 0.5 * (bx - peakD) * (d - bx) * effCurvDiff;
              }
            } else {
              zRay = obsH + (hTgt - obsH) * (bx / Math.max(1, d)) + 0.5 * bx * (d - bx) * effCurvDiff;
            }
            const clear = zRay - bTop;
            if (clear <= 0) return bWeight;
            const fresnelM = clamp(5.0 + 0.45 * Math.sqrt(lam1 * Math.min(bx, Math.max(1, d - bx))), 5.0, 14.0);
            if (clear < fresnelM) return bWeight * (1.0 - smooth(0, fresnelM, clear));
            return 0;
          };

          for (let k = 0; k < fbCount; k++) {
            effForestMeters += evalForestBlock(fbDist[k], fbTop[k], fbWeight[k]);
          }
          if (curBlkWeight > 0.5) {
            effForestMeters += evalForestBlock(curBlkDistSum / curBlkWeight, curBlkTopSum / curBlkWeight, curBlkWeight);
          }
        }

        let aFol0 = 0, aFol1 = 0, aFol2 = 0;
        if (S.factors.foliage && effForestMeters > 4) {
          const ductBypass = 1.0 - 0.25 * ductFactor * smooth(200, 1200, d);
          const calcFol = (fAtt) => {
            const maxF = clamp(9.5 * fAtt * seasonAtt, 2.5, 16.5);
            const rawF = effForestMeters * 0.038 * fAtt * seasonAtt;
            return maxF * (1 - Math.exp(-rawF / maxF)) * ductBypass;
          };
          aFol0 = calcFol(folFreq0);
          aFol1 = calcFol(folFreq1);
          aFol2 = calcFol(folFreq2);
        }

        // 5. Грунт, снег (по 3 октавам) и смягчённый бонус воды
        const meanH = (S.earHeight + tgtHOffset) * 0.5;
        const baseGrd = lerp(5.8, 2.0, smooth(2.0, 14.0, meanH));
        const grdMask = (1.0 - waterFrac) * smooth(35, 380, d) * (aBarMean > 0.5 ? (1.0 - clamp(aBarMean / 10.0, 0, 0.7)) : 1.0);
        let aGrd0 = baseGrd * grdMask;
        let aGrd1 = aGrd0;
        let aGrd2 = aGrd0;
        if (S.factors.snow && env.hasSnowCover) {
          const ductLift = 1.0 - 0.4 * ductFactor * smooth(120, 900, d);
          const snowMask = (1.0 - waterFrac) * smooth(40, 420, d) * ductLift * (aBarMean > 0.5 ? (1.0 - clamp(aBarMean / 10.0, 0, 0.7)) : 1.0);
          aGrd0 += 2.8 * snowFreq0 * snowMask;
          aGrd1 += 2.8 * snowFreq1 * snowMask;
          aGrd2 += 2.8 * snowFreq2 * snowMask;
        }

        let waterBoost = 0;
        if (S.factors.water && waterFrac > 0.05) {
          const mirrorGain = (1.0 + 1.5 * smooth(150, 1200, d)) * waterEff;
          const surfPenalty = (windAbs > 3.2) ? clamp((windAbs - 3.2) * 0.45, 0, 2.8) * waterFrac : 0;
          waterBoost = mirrorGain - surfPenalty;
        }

        // 6. Фокусировка в долинах
        let valleyGain = 0;
        if (S.factors.reflections && S.factors.relief && d > 40) {
          const hLeft = G.hgt[rPrev * nSteps + i];
          const hRight = G.hgt[rNext * nSteps + i];
          const avgFlank = (hLeft + hRight) * 0.5 - hGround;
          if (avgFlank > 4.0) {
            const wallAbs = G.treeHgt[idx] >= 2 ? lerp(1.0, 0.55, env.leafFactor) : 1.0;
            valleyGain = clamp((avgFlank - 4.0) * 0.08 * wallAbs, 0, 3.8);
          }
        }

        // 6.5. Эффект лесного коридора («просеки-трубы»)
        let corridorGain0 = 0, corridorGain1 = 0, corridorGain2 = 0;
        if (S.factors.foliage && S.factors.reflections && d > 25 && tH < 2.2) {
          const arcPerRay = Math.max(1.0, d * G.dTh);
          const dr1 = clamp(Math.round(22 / arcPerRay), 1, 14);
          const dr2 = clamp(Math.round(48 / arcPerRay), 2, 28);

          const hL = Math.max(
            G.treeHgt[((r - dr1 + nRays) % nRays) * nSteps + i],
            G.treeHgt[((r - dr2 + nRays) % nRays) * nSteps + i]
          );
          const hR = Math.max(
            G.treeHgt[((r + dr1) % nRays) * nSteps + i],
            G.treeHgt[((r + dr2) % nRays) * nSteps + i]
          );

          if (hL >= 5.5 && hR >= 5.5) {
            const wallH = Math.min(hL, hR);
            const hFactor = clamp((wallH - 4.5) / 12.0, 0.3, 1.0);
            corridorMeters += stepD * hFactor;
            const trunkRefl = lerp(0.95, 0.62, env.leafFactor) * (env.hasSnowCover ? 0.8 : 1.0);
            const cBase = 4.2 * (1 - Math.exp(-corridorMeters / 160)) * trunkRefl;
            corridorGain0 = cBase * 1.12;
            corridorGain1 = cBase * 0.96;
            corridorGain2 = cBase * 0.65;
          } else if (corridorMeters >= 55 && hL < 3.5 && hR < 3.5 && (d - lastExitEmitD) > 90) {
            lastExitEmitD = d;
            const cExit0 = L1_0 - aDiv - aAtm0 - aBar0 - aShadow - aFol0 - aGrd0 + waterBoost + valleyGain + 3.0;
            const cExit1 = L1_1 - aDiv - aAtm1 - aBar1 - aShadow - aFol1 - aGrd1 + waterBoost + valleyGain + 3.0;
            const cExit2 = L1_2 - aDiv - aAtm2 - aBar2 - aShadow - aFol2 - aGrd2 + waterBoost + valleyGain + 3.0;
            const L_exit = powerSum3(cExit0, cExit1, cExit2);
            if (L_exit > detThrDb - 14) {
              reflectors.push({
                kind: 'clearingExit',
                useLocalBase: true,
                baseDb: L_exit,
                b0: cExit0, b1: cExit1, b2: cExit2,
                idx, r, i, d, h: hGround + 3.0,
                x: cellX[idx], y: cellY[idx],
                nx: sinT, ny: cosT,
                rx: sinT, ry: cosT,
                reflDbGain: -1.5,
                score: L_exit + 6.0
              });
            }
            corridorMeters *= 0.25;
          } else {
            corridorMeters = Math.max(0, corridorMeters - stepD * 0.5);
          }
        } else if (tH >= 3.0) {
          corridorMeters = 0;
        }

        const Lr0 = L1_0 - aDiv - aAtm0 - aBar0 - aShadow - aFol0 - aGrd0 + waterBoost + valleyGain + corridorGain0;
        const Lr1 = L1_1 - aDiv - aAtm1 - aBar1 - aShadow - aFol1 - aGrd1 + waterBoost + valleyGain + corridorGain1;
        const Lr2 = L1_2 - aDiv - aAtm2 - aBar2 - aShadow - aFol2 - aGrd2 + waterBoost + valleyGain + corridorGain2;

        bandL[idx] = Lr0;
        bandM[idx] = Lr1;
        bandH[idx] = Lr2;
        const L_rec = powerSum3(Lr0, Lr1, Lr2);
        dirDb[idx] = L_rec;
        barLoss[idx] = aBarMean;

        if (corridorGain1 >= 1.2) {
          reflL[idx] = Math.max(reflL[idx], Lr0 - 0.4);
          reflM[idx] = Math.max(reflM[idx], Lr1 - 0.4);
          reflH[idx] = Math.max(reflH[idx], Lr2 - 0.4);
        }

        // Закрываем текущий блок леса
        if (curBlkSteps >= fBlockSize && fbCount < MAX_FBLK) {
          if (curBlkWeight > 0.5) {
            fbDist[fbCount] = curBlkDistSum / curBlkWeight;
            fbTop[fbCount] = curBlkTopSum / curBlkWeight;
            fbWeight[fbCount] = curBlkWeight;
            fbCount++;
          }
          curBlkSteps = 0;
          curBlkDistSum = 0;
          curBlkTopSum = 0;
          curBlkWeight = 0;
        }

        // Огибающая рельефа
        if (S.factors.relief) {
          const ang = (hGround - obsH) / d + 0.5 * d * effCurvDiff;
          if (ang > maxObsAngle) {
            maxObsAngle = ang;
            peakIdx = i;
            peakH = hGround;
            peakD = d;
          }
        }

        // Поиск сильных отражающих склонов
        if (S.factors.reflections && S.factors.relief && i >= 1 && i < nSteps - 1 && d >= 20 && aBarMean < 5.0) {
          const dNext = G.dist[i + 1], dPrev = G.dist[i - 1];
          const dhDr = (G.hgt[off + i + 1] - G.hgt[off + i - 1]) / Math.max(1, dNext - dPrev);
          if (dhDr > 0.14) {
            const arcSpan = Math.max(4, 2 * d * G.dTh);
            const dhDt = (G.hgt[rNext * nSteps + i] - G.hgt[rPrev * nSteps + i]) / arcSpan;
            let reflCoef = clamp(0.45 + dhDr * 0.55, 0.35, 0.88);
            if (S.factors.foliage && tH >= 2.5) reflCoef *= (1.0 - 0.55 * env.leafFactor);
            if (S.factors.snow && env.hasSnowCover) reflCoef *= 0.65;
            if (reflCoef > 0.14) {
              const nRad = -dhDr, nTan = -dhDt;
              const nLen = Math.hypot(nRad, nTan) || 1;
              const nr = nRad / nLen, nt = nTan / nLen;
              const nx = nr * sinT + nt * cosT;
              const ny = nr * cosT - nt * sinT;
              const dotIn = sinT * nx + cosT * ny;
              if (dotIn < -0.15) {
                const ux = sinT - 2 * dotIn * nx;
                const uy = cosT - 2 * dotIn * ny;
                const uLen = Math.hypot(ux, uy) || 1;
                reflectors.push({
                  idx, r, i, d, h: hGround + 4,
                  x: cellX[idx], y: cellY[idx],
                  nx, ny,
                  rx: ux / uLen, ry: uy / uLen,
                  reflDbGain: 10 * Math.log10(reflCoef),
                  score: L_rec + 10 * Math.log10(reflCoef) + dhDr * 12
                });
              }
            }
          }
        }

        // Отражение от косой стены леса
        if (S.factors.foliage && S.factors.reflections && i >= 1 && i < nSteps - 1 &&
            d >= 30 && aBarMean < 5.0 && prevTH < 2.2 && tH >= 7.0) {
          const arcSpan = Math.max(4, 2 * d * G.dTh);
          const dhDrT = (G.treeHgt[off + i + 1] - G.treeHgt[off + i - 1]) / Math.max(1, G.dist[i + 1] - G.dist[i - 1]);
          const dhDtT = (G.treeHgt[rNext * nSteps + i] - G.treeHgt[rPrev * nSteps + i]) / arcSpan;
          const nRad = -dhDrT, nTan = -dhDtT;
          const nLen = Math.hypot(nRad, nTan) || 1;
          const nx = (nRad / nLen) * sinT + (nTan / nLen) * cosT;
          const ny = (nRad / nLen) * cosT - (nTan / nLen) * sinT;
          const dotIn = sinT * nx + cosT * ny;

          if (dotIn < -0.15) {
            const ux = sinT - 2 * dotIn * nx;
            const uy = cosT - 2 * dotIn * ny;
            const uLen = Math.hypot(ux, uy) || 1;
            let forestRefl = lerp(0.32, 0.16, env.leafFactor) * clamp((tH - 5) / 12, 0.5, 1.0);
            if (S.factors.snow && env.hasSnowCover) forestRefl *= 0.8;

            reflectors.push({
              kind: 'forestWall',
              useLocalBase: true,
              baseDb: L_rec,
              b0: Lr0, b1: Lr1 - 0.8, b2: Lr2 - 2.6,
              idx, r, i, d, h: hGround + 4.0,
              x: cellX[idx], y: cellY[idx],
              nx, ny,
              rx: ux / uLen, ry: uy / uLen,
              reflDbGain: 10 * Math.log10(forestRefl),
              score: L_rec + 10 * Math.log10(forestRefl) + 4.0
            });
          }
        }
        prevTH = tH;
      }
    }, 14, p => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Расчёт прямого звука (3 полосы): <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Звук ${pct}%`);
    });
    if (!ok1) return null;

    // PASS 2.5: Вторичные отражённые волны (с 3-полосным затуханием)
    if (S.factors.reflections && (S.factors.relief || S.factors.foliage) && reflectors.length > 0) {
      const Q = QUALITY[S.quality] || QUALITY.standard;
      reflectors.sort((a, b) => b.score - a.score);

      const minClusterDist = Math.max(45, G.Rm * 0.035);
      const minClusterDist2 = minClusterDist * minClusterDist;
      const picked = [];
      for (let k = 0; k < reflectors.length && picked.length < Q.reflTop; k++) {
        const cand = reflectors[k];
        if (cand.score < detThrDb - 14) break;
        let tooClose = false;
        for (let p = 0; p < picked.length; p++) {
          const dx = cand.x - picked[p].x, dy = cand.y - picked[p].y;
          if (dx * dx + dy * dy < minClusterDist2) { tooClose = true; break; }
        }
        if (!tooClose) picked.push(cand);
      }

      const maxBounceM = Math.min(G.Rm * 0.65, 4200);
      const maxBounceM2 = maxBounceM * maxBounceM;
      const dMinG = G.dist[0];
      const dMaxG = G.dist[nSteps - 1];
      const LN10_10 = 1 / Math.LN10;

      const addBounceBand = (arr, idx, val) => {
        const cur = arr[idx];
        if (val > cur) {
          if (cur < -150 || val - cur > 25) arr[idx] = val;
          else arr[idx] = val + 10 * Math.log(1 + Math.exp((cur - val) * 0.2302585)) * LN10_10;
        }
      };

      const ok2 = await runSliced(token, picked.length, (wIdx) => {
        const w = picked[wIdx];
        const wx = w.x, wy = w.y, wh = w.h;
        const wR2 = wx * wx + wy * wy;
        const isExit = (w.kind === 'clearingExit');
        const dotThresh = isExit ? 0.12 : 0.05;
        const dFromObs = Math.max(1, w.d);

        for (let mr = 0; mr < nRays; mr++) {
          const sinT = G.sinTArr[mr], cosT = G.cosTArr[mr];
          const proj = wx * sinT + wy * cosT;
          const perp2 = wR2 - proj * proj;
          if (perp2 > maxBounceM2) continue;

          const halfChord = Math.sqrt(Math.max(0, maxBounceM2 - perp2));
          const rLo = proj - halfChord;
          const rHi = proj + halfChord;
          if (rHi < dMinG || rLo > dMaxG) continue;

          let i0 = 0;
          if (rLo > dMinG) {
            let lo = 0, hi = nSteps - 1;
            while (lo < hi) { const m = (lo + hi) >> 1; if (G.dist[m] < rLo) lo = m + 1; else hi = m; }
            i0 = lo;
          }
          let i1 = nSteps - 1;
          if (rHi < dMaxG) {
            let lo = i0, hi = nSteps - 1;
            while (lo < hi) { const m = (lo + hi + 1) >> 1; if (G.dist[m] <= rHi) lo = m; else hi = m - 1; }
            i1 = lo;
          }

          const baseOff = mr * nSteps;
          for (let mi = i0; mi <= i1; mi++) {
            const idx = baseOff + mi;
            const dx = cellX[idx] - wx;
            const dy = cellY[idx] - wy;
            const d2 = dx * dx + dy * dy;
            if (d2 < 225 || d2 > maxBounceM2) continue;

            const dWp = Math.sqrt(d2);
            const invD = 1 / dWp;
            const dirX = dx * invD, dirY = dy * invD;

            const frontDot = dirX * w.nx + dirY * w.ny;
            if (frontDot <= dotThresh) continue;

            const specDot = Math.max(0, dirX * w.rx + dirY * w.ry);
            const lobe = isExit
              ? (0.45 * frontDot + 0.55 * specDot)
              : (0.28 * frontDot + 0.72 * specDot * specDot);
            const lobeDb = 10 * Math.log(Math.max(0.05, lobe)) * LN10_10;

            let b0, b1, b2;
            if (w.useLocalBase) {
              const aDivSeg = 20.0 * Math.log((dFromObs + dWp) / dFromObs) * LN10_10;
              const gainSeg = w.reflDbGain + lobeDb - aDivSeg;
              b0 = w.b0 + gainSeg - alpha0 * (dWp * 0.001);
              b1 = w.b1 + gainSeg - alpha1 * (dWp * 0.001);
              b2 = w.b2 + gainSeg - alpha2 * (dWp * 0.001);
            } else {
              const dTotal = w.d + dWp;
              const aDivB = 20.0 * Math.log(Math.max(1, dTotal)) * LN10_10;
              const gainB = w.reflDbGain + lobeDb - aDivB - 2.5;
              const kmTot = dTotal * 0.001;
              b0 = L1_0 + gainB - alpha0 * kmTot;
              b1 = L1_1 + gainB - alpha1 * kmTot;
              b2 = L1_2 + gainB - alpha2 * kmTot;
            }

            if (Math.max(b0 - thr0, b1 - thr1, b2 - thr2) < -10) continue;

            let segBarLoss = 0;
            let forestSegHits = 0;
            for (let s = 1; s <= 3; s++) {
              const frac = s * 0.25;
              const sx = wx + dx * frac;
              const sy = wy + dy * frac;
              const sD = Math.hypot(sx, sy);
              if (sD <= 5 || sD >= G.Rm) continue;

              let sTh = Math.atan2(sx, sy);
              if (sTh < 0) sTh += TAU;
              const sMr = ((Math.round(sTh / G.dTh) % nRays) + nRays) % nRays;
              let lo = 0, hi = nSteps - 1;
              while (hi - lo > 1) { const m = (lo + hi) >> 1; if (G.dist[m] <= sD) lo = m; else hi = m; }
              const cIdx = sMr * nSteps + lo;

              if (S.factors.relief) {
                const hChord = lerp(wh, G.hgt[idx] + tgtHOffset, frac);
                const exc = G.hgt[cIdx] - hChord;
                if (exc > 2.0) segBarLoss = Math.max(segBarLoss, clamp(exc * 0.45, 3.0, 14.0));
              }
              if (S.factors.foliage && G.treeHgt[cIdx] >= 3.0) forestSegHits++;
            }

            const fin0 = b0 - segBarLoss * 0.72 - forestSegHits * (1.8 + 1.0 * env.leafFactor);
            const fin1 = b1 - segBarLoss * 1.00 - forestSegHits * (3.2 + 2.5 * env.leafFactor);
            const fin2 = b2 - segBarLoss * 1.25 - forestSegHits * (5.2 + 4.0 * env.leafFactor);

            const prevR1 = reflM[idx];
            addBounceBand(reflL, idx, fin0);
            addBounceBand(reflM, idx, fin1);
            addBounceBand(reflH, idx, fin2);
            if (fin1 > prevR1) bestReflCell[idx] = w.idx;
          }
        }
      }, 14, p => {
        const pct = Math.round(p * 100);
        setStatus && setStatus(`⏳ Отражения и выход из просек: <b>${pct}%</b>…`);
        updateMarkerProgress(`⏳ Отражения ${pct}%`);
      }, 1);

      if (!ok2) return null;
    }

    // Финальное сведение 3 полос и расчёт психоакустического запаса слышимости + разборчивости
    for (let i = 0; i < total; i++) {
      const r0 = reflL[i], r1 = reflM[i], r2 = reflH[i];
      const hasRefl = (r0 > -150 || r1 > -150 || r2 > -150);

      const t0 = powerSum2(bandL[i], r0);
      const t1 = powerSum2(bandM[i], r1);
      const t2 = powerSum2(bandH[i], r2);
      bandL[i] = t0;
      bandM[i] = t1;
      bandH[i] = t2;

      totalDb[i] = powerSum3(t0, t1, t2);
      if (hasRefl) reflDb[i] = powerSum3(r0, r1, r2);

      const m0 = t0 - thr0;
      const m1 = t1 - thr1;
      const m2 = t2 - thr2;
      const maxM = Math.max(m0, m1, m2);
      let sumAbove = 0;
      if (m0 > maxM - 8) sumAbove += Math.pow(10, (m0 - maxM) / 10);
      if (m1 > maxM - 8) sumAbove += Math.pow(10, (m1 - maxM) / 10);
      if (m2 > maxM - 8) sumAbove += Math.pow(10, (m2 - maxM) / 10);
      effMargin[i] = maxM + Math.min(2.0, 5.0 * Math.log10(Math.max(1, sumAbove)));

      // Разборчивость речи/деталей определяется СЧ (900 Гц) и ВЧ (2800 Гц)
      const hiMax = Math.max(m1, m2), hiMin = Math.min(m1, m2);
      intelMargin[i] = hiMax + (hiMin > hiMax - 6 ? 1.0 : 0);
    }

    return {
      key: '',
      isEmit,
      ambientDb: env.ambientDb,
      detectThresholdDb: env.detectThresholdDb,
      dirDb, reflDb, totalDb,
      bandL, bandM, bandH,
      effMargin, intelMargin,
      barLoss, bestReflCell, cellX, cellY
    };
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

  function polarLookupAudio(G, A, dM, th, out) {
    const dist = G.dist, n = G.nSteps;
    let i0, w;
    if (dM <= dist[0]) { i0 = 0; w = 0; }
    else if (dM >= dist[n - 1]) { i0 = n - 1; w = 0; }
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dist[mid] <= dM) lo = mid; else hi = mid; }
      i0 = lo;
      w = (dM - dist[lo]) / Math.max(1e-6, dist[hi] - dist[lo]);
      if (w > 1) w = 1;
    }
    const i1 = i0 + 1 < n ? i0 + 1 : i0;
    const rf = th / G.dTh;
    let r0 = Math.floor(rf);
    const wr = rf - r0;
    r0 = ((r0 % G.nRays) + G.nRays) % G.nRays;
    const r1 = (r0 + 1) % G.nRays;
    const a = r0 * n + i0, b = r0 * n + i1, c = r1 * n + i0, d = r1 * n + i1;

    const interp = (arr) => lerp(lerp(arr[a], arr[b], w), lerp(arr[c], arr[d], w), wr);
    out.totalDb = interp(A.totalDb);
    out.dirDb = interp(A.dirDb);
    out.reflDb = interp(A.reflDb);
    out.effMargin = interp(A.effMargin);
    out.intelMargin = interp(A.intelMargin);
    out.bL = interp(A.bandL);
    out.bM = interp(A.bandM);
    out.bH = interp(A.bandH);
    out.barLoss = interp(A.barLoss);
    out.bestReflIdx = A.bestReflCell[w < 0.5 ? (wr < 0.5 ? a : c) : (wr < 0.5 ? b : d)];
  }

  async function buildFields(G, A, env, token, setStatus) {
    const Q = QUALITY[S.quality] || QUALITY.standard;
    const W = Q.outSize;
    const V = makeView(G.lat0, G.lng0, G.Rm, W);
    const N = W * W;
    const fMargin = new Float32Array(N).fill(NaN);
    const fReflGain = new Float32Array(N);
    const fAz = new Uint16Array(N);

    const phi0 = G.lat0 * DEG, sinP0 = Math.sin(phi0), cosP0 = Math.cos(phi0);
    const sinDl = new Float64Array(W), cosDl = new Float64Array(W);
    for (let u = 0; u < W; u++) {
      const xn = V.x0 + ((u + 0.5) / W - 0.5) * 2 * V.half;
      const dl = (xn - V.x0) * TAU;
      sinDl[u] = Math.sin(dl); cosDl[u] = Math.cos(dl);
    }

    const tmp = { totalDb: 0, dirDb: 0, reflDb: 0, effMargin: 0, intelMargin: 0, bL: 0, bM: 0, bH: 0, barLoss: 0, bestReflIdx: -1 };
    const Rm = G.Rm;
    const azScale = 65535 / TAU;

    const ok = await runSliced(token, W, (v) => {
      const yn = V.y0 + ((v + 0.5) / W - 0.5) * 2 * V.half;
      const lat = mercLat(yn) * DEG;
      const sinP = Math.sin(lat), cosP = Math.cos(lat);
      const row = v * W;
      for (let u = 0; u < W; u++) {
        const cdl = cosDl[u], sdl = sinDl[u];
        const cc = sinP0 * sinP + cosP0 * cosP * cdl;
        const ang = Math.acos(cc > 1 ? 1 : (cc < -1 ? -1 : cc));
        const dM = ang * R_EARTH;
        if (dM > Rm) continue;

        let th = Math.atan2(sdl * cosP, cosP0 * sinP - sinP0 * cosP * cdl);
        if (th < 0) th += TAU;

        polarLookupAudio(G, A, dM, th, tmp);
        const margin = tmp.effMargin;
        if (margin < -3.0) continue;

        const idx = row + u;
        fMargin[idx] = margin;
        fAz[idx] = (th * azScale) | 0;

        const reflBonus = Math.max(0, tmp.totalDb - tmp.dirDb);
        const dirMargin = margin - reflBonus;
        if (reflBonus >= 1.2 && dirMargin < 4.0) {
          fReflGain[idx] = clamp(reflBonus / 6.0, 0, 1);
        } else if (tmp.barLoss >= 4.0 && margin >= -2.0) {
          fReflGain[idx] = 0.55;
        }
      }
    }, 14, p => {
      const pct = Math.round(p * 100);
      setStatus && setStatus(`⏳ Построение карты слышимости: <b>${pct}%</b>…`);
      updateMarkerProgress(`⏳ Карта ${pct}%`);
    });

    if (!ok) return null;
    return { V, W, fMargin, fReflGain, fAz };
  }

  // ---------------------------------------------------------------------------
  // PASS 4 — ОТРИСОВКА РАСТРА И ГЕОМЕТРИИ
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
    const v = m ? parseInt(m[1], 16) : 0x3b82f6;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const packABGR = (r, g, b, a) => ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
  const C_BORDER = [6, 182, 212];

  function paintFields(F) {
    ensureCanvas(F.W);
    const W = F.W, N = W * W;
    buf32.fill(0);

    const main = hexToRgb(S.color);
    const echo = hexToRgb(S.echoColor);
    const fm = F.fMargin, fr = F.fReflGain, az = F.fAz;
    const dimOutside = S.followCompass;
    const hdg = lastHeading;
    const azToDeg = 360 / 65535;
    const showEcho = !!S.highlightEcho;

    for (let i = 0; i < N; i++) {
      const m = fm[i];
      if (m !== m || m < -2.5) continue;

      let r, g, b, a;
      if (m < 3.0) {
        // Граничная зона (-2.5 .. +3 дБ): слышно при прислушивании
        const t = smooth(-2.5, 3.0, m);
        r = lerp(C_BORDER[0], main[0], t);
        g = lerp(C_BORDER[1], main[1], t);
        b = lerp(C_BORDER[2], main[2], t);
        a = lerp(45, 130, t);
      } else {
        // Уверенная слышимость (+3 .. +25 дБ)
        const t = smooth(3.0, 22.0, m);
        r = lerp(main[0], Math.min(255, main[0] + 40), t * 0.45);
        g = lerp(main[1], Math.min(255, main[1] + 45), t * 0.45);
        b = lerp(main[2], Math.min(255, main[2] + 35), t * 0.35);
        a = lerp(130, 195, t);
      }

      if (showEcho && fr[i] > 0.05) {
        const ef = clamp(fr[i], 0, 1);
        r = lerp(r, echo[0], ef * 0.78);
        g = lerp(g, echo[1], ef * 0.78);
        b = lerp(b, echo[2], ef * 0.78);
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
    c.strokeStyle = 'rgba(255,255,255,0.42)';
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.font = 'bold ' + Math.max(10, Math.round(W / 95)) + 'px monospace';
    c.textAlign = 'center';

    let intervals;
    if (Rkm <= 0.8) intervals = [0.1, 0.25, 0.5];
    else if (Rkm <= 3.0) intervals = [0.5, 1, 2];
    else if (Rkm <= 12) intervals = [1, 2, 5, 10];
    else intervals = [5, 10, 20, 35, 50];

    intervals.forEach(km => {
      if (km >= Rkm * 0.94) return;
      c.beginPath();
      for (let b = 0; b <= 180; b++) {
        const [la, ln] = destination(geo.lat0, geo.lng0, b * 2, km * 1000);
        const p = llToPx(V, la, ln);
        if (b === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]);
      }
      c.stroke();
      const pN = llToPx(V, ...destination(geo.lat0, geo.lng0, 0, km * 1000));
      const lbl = km < 1 ? `${Math.round(km * 1000)} м` : `${km} км`;
      c.fillText(lbl, pN[0], pN[1] + 12);
    });

    // Внешняя граница расчёта
    c.setLineDash([]);
    c.strokeStyle = 'rgba(59,130,246,0.75)';
    c.lineWidth = 1.5;
    c.beginPath();
    for (let b = 0; b <= 180; b++) {
      const [la, ln] = destination(geo.lat0, geo.lng0, b * 2, geo.Rm);
      const p = llToPx(V, la, ln);
      if (b === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]);
    }
    c.stroke();

    // Стрелка направления ветра на границе
    if (S.factors.wind && lastEnv && lastEnv.windSpeed >= 1.2) {
      const pFrom = llToPx(V, ...destination(geo.lat0, geo.lng0, lastEnv.windFromDir, geo.Rm * 0.88));
      const pTo = llToPx(V, ...destination(geo.lat0, geo.lng0, lastEnv.windFromDir, geo.Rm * 0.72));
      c.strokeStyle = 'rgba(250,204,21,0.9)';
      c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(pFrom[0], pFrom[1]); c.lineTo(pTo[0], pTo[1]); c.stroke();
      c.fillStyle = '#fde047';
      c.fillText(`💨 ${lastEnv.windSpeed.toFixed(1)} м/с`, pFrom[0], pFrom[1] - 6);
    }

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
      if (!audioOverlay) {
        audioOverlay = L.imageOverlay(lastBlobUrl, bounds, { opacity: S.opacity, interactive: false, zIndex: 422 }).addTo(layerGroup);
      } else {
        audioOverlay.setUrl(lastBlobUrl);
        audioOverlay.setBounds(bounds);
        audioOverlay.setOpacity(S.opacity);
      }
      updateObserverMarker(geo.obsGround);
      if (infoHtml) setStatusInfo(infoHtml);
    }, 'image/png');
  }

  // ---------------------------------------------------------------------------
  // ПРОБНИК ТОЧКИ (ДЕТАЛЬНЫЙ АКУСТИЧЕСКИЙ ПРОФИЛЬ С ОТРАЖЕНИЯМИ И ДИФРАКЦИЕЙ)
  // ---------------------------------------------------------------------------
  function probe(latlng) {
    if (!geo || !aco || !fields || !lastEnv) return null;
    const ll = L.latLng(latlng);
    const { d, bearing } = distBearing(geo.lat0, geo.lng0, ll.lat, ll.lng);
    const res = {
      latlng: ll,
      distMeters: d,
      distKm: d / 1000,
      bearing,
      inRange: d <= geo.Rm,
      mode: S.mode,
      sourceDb: S.volumeDb,
      ambientDb: lastEnv.ambientDb,
      detectThresholdDb: lastEnv.detectThresholdDb,
      freqHz: lastEnv.freqHz,
      obsElev: geo.obsGround,
      earHeight: S.earHeight,
      sourceHeight: S.sourceHeight
    };
    if (!res.inRange) return res;

    const tmp = { totalDb: 0, dirDb: 0, reflDb: 0, effMargin: 0, intelMargin: 0, bL: 0, bM: 0, bH: 0, barLoss: 0, bestReflIdx: -1 };
    const nSamples = Math.min(180, Math.max(40, Math.floor(d / Math.max(3, geo.Rm / 160))));
    const profDist = new Float64Array(nSamples + 1);
    const profH = new Float64Array(nSamples + 1);
    const profTree = new Float32Array(nSamples + 1);
    const profWater = new Uint8Array(nSamples + 1);
    const profDb = new Float32Array(nSamples + 1);

    const d0Grid = geo.dist[0];
    polarLookupAudio(geo, aco, d0Grid, bearing * DEG, tmp);
    const effAtD0 = lastEnv.detectThresholdDb + tmp.effMargin;

    const rf = ((bearing * DEG) / geo.dTh);
    const r0 = ((Math.floor(rf) % geo.nRays) + geo.nRays) % geo.nRays;
    const r1 = (r0 + 1) % geo.nRays;
    const wr = rf - Math.floor(rf);

    let maxRidgeIdx = -1;
    let maxRidgeExcess = -Infinity;
    const zO = geo.obsGround + S.earHeight;

    for (let i = 0; i <= nSamples; i++) {
      const curD = (i / nSamples) * d;
      profDist[i] = curD;

      let lo = 0, hi = geo.nSteps - 1, w = 0;
      if (curD <= geo.dist[0]) { lo = 0; w = 0; }
      else if (curD >= geo.dist[geo.nSteps - 1]) { lo = geo.nSteps - 1; w = 0; }
      else {
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (geo.dist[mid] <= curD) lo = mid; else hi = mid; }
        w = (curD - geo.dist[lo]) / Math.max(1e-6, geo.dist[hi] - geo.dist[lo]);
      }
      const hiIdx = lo + 1 < geo.nSteps ? lo + 1 : lo;
      const h0 = lerp(geo.hgt[r0 * geo.nSteps + lo], geo.hgt[r0 * geo.nSteps + hiIdx], w);
      const h1 = lerp(geo.hgt[r1 * geo.nSteps + lo], geo.hgt[r1 * geo.nSteps + hiIdx], w);
      profH[i] = lerp(h0, h1, wr);

      const t0 = lerp(geo.treeHgt[r0 * geo.nSteps + lo], geo.treeHgt[r0 * geo.nSteps + hiIdx], w);
      const t1 = lerp(geo.treeHgt[r1 * geo.nSteps + lo], geo.treeHgt[r1 * geo.nSteps + hiIdx], w);
      profTree[i] = lerp(t0, t1, wr);
      profWater[i] = geo.waterM[r0 * geo.nSteps + lo];

      if (curD <= 1.0) {
        profDb[i] = S.volumeDb;
      } else if (curD < d0Grid) {
        const tNear = Math.log10(curD) / Math.max(1e-6, Math.log10(d0Grid));
        profDb[i] = lerp(S.volumeDb, effAtD0, tNear);
      } else {
        polarLookupAudio(geo, aco, curD, bearing * DEG, tmp);
        profDb[i] = lastEnv.detectThresholdDb + tmp.effMargin;
      }
    }

    polarLookupAudio(geo, aco, Math.max(2, d), bearing * DEG, tmp);

    const tgtGround = profH[nSamples];
    const zT = tgtGround + S.sourceHeight;
    for (let i = 1; i < nSamples; i++) {
      const f = profDist[i] / Math.max(1, d);
      const chordY = zO + (zT - zO) * f;
      const exc = profH[i] - chordY;
      if (exc > maxRidgeExcess) {
        maxRidgeExcess = exc;
        maxRidgeIdx = i;
      }
    }

    let cutoffDistM = null;
    const thrVis = lastEnv.detectThresholdDb - 2.0;
    for (let i = 1; i <= nSamples; i++) {
      if (profDb[i - 1] >= thrVis && profDb[i] < thrVis) {
        const frac = (thrVis - profDb[i - 1]) / ((profDb[i] - profDb[i - 1]) || -1e-6);
        cutoffDistM = profDist[i - 1] + (profDist[i] - profDist[i - 1]) * clamp(frac, 0, 1);
      }
    }

    let reflectorLL = null;
    let reflectorDistM = 0;
    if (tmp.bestReflIdx >= 0) {
      const rx = aco.cellX[tmp.bestReflIdx];
      const ry = aco.cellY[tmp.bestReflIdx];
      reflectorDistM = Math.hypot(rx, ry);
      const rBrg = ((Math.atan2(rx, ry) * RAD) + 360) % 360;
      const dest = destination(geo.lat0, geo.lng0, rBrg, reflectorDistM);
      reflectorLL = L.latLng(dest[0], dest[1]);
    }

    const margin = tmp.effMargin;
    const reflBoost = Math.max(0, tmp.totalDb - tmp.dirDb);

    res.terrain = tgtGround;
    res.cutoffDistM = cutoffDistM;
    res.totalDb = tmp.totalDb;
    res.dirDb = tmp.dirDb;
    res.reflDb = tmp.reflDb;
    res.reflBoost = reflBoost;
    res.barLoss = tmp.barLoss;
    res.margin = margin;
    res.intelMargin = tmp.intelMargin;
    res.bandDb = [tmp.bL, tmp.bM, tmp.bH];
    res.bandMargins = [
      tmp.bL - lastEnv.thrBands[0],
      tmp.bM - lastEnv.thrBands[1],
      tmp.bH - lastEnv.thrBands[2]
    ];
    res.audible = margin >= -2.0;
    res.clearAudible = margin >= 3.0;
    res.intelligible = res.audible && tmp.intelMargin >= -1.0;
    res.reflectorLL = reflectorLL;
    res.reflectorDistM = reflectorDistM;
    res.ridgeBlocked = maxRidgeExcess > 0.5;
    res.ridgeIdx = maxRidgeIdx;
    res.profile = { dist: profDist, h: profH, tree: profTree, water: profWater, db: profDb };
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

    const P = 8, W = wCss, H = hCss;
    const splitY = Math.round(H * 0.58);
    const dbTop = splitY + 6;
    const dbBot = H - 6;

    const ds = r.profile.dist, hs = r.profile.h, ts = r.profile.tree, ws = r.profile.water, dbs = r.profile.db;
    const n = ds.length, D = Math.max(1, r.distMeters);
    const zO = r.obsElev + r.earHeight;
    const zT = r.terrain + r.sourceHeight;

    let lo = Math.min(zO, zT), hi = Math.max(zO, zT);
    for (let i = 0; i < n; i++) {
      if (hs[i] < lo) lo = hs[i];
      if (hs[i] + ts[i] > hi) hi = hs[i] + ts[i];
    }
    const span = Math.max(12, hi - lo);
    lo -= span * 0.12;
    hi += span * 0.22;

    const X = dist => P + (W - 2 * P) * (dist / D);
    const Y = yVal => splitY - 4 - (splitY - 4 - P) * ((yVal - lo) / (hi - lo));

    c.save();
    // Вертикальная сетка
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    [0.25, 0.5, 0.75].forEach(f => { const x = X(D * f); c.moveTo(x, P); c.lineTo(x, dbBot); });
    c.moveTo(P, splitY); c.lineTo(W - P, splitY);
    c.stroke();

    // Водоёмы
    for (let i = 0; i < n - 1; i++) {
      if (ws[i]) {
        c.fillStyle = 'rgba(56, 189, 248, 0.35)';
        c.fillRect(X(ds[i]), Y(hs[i]) - 2, Math.max(2, X(ds[i + 1]) - X(ds[i])), 5);
      }
    }

    // Рельеф
    const grad = c.createLinearGradient(0, Y(hi), 0, splitY);
    grad.addColorStop(0, '#475569');
    grad.addColorStop(1, '#1e293b');
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(X(0), splitY - 2);
    for (let i = 0; i < n; i++) c.lineTo(X(ds[i]), Y(hs[i]));
    c.lineTo(X(D), splitY - 2);
    c.closePath();
    c.fill();

    // Кроны леса
    c.fillStyle = 'rgba(16, 185, 129, 0.34)';
    c.beginPath();
    c.moveTo(X(0), Y(hs[0]));
    for (let i = 0; i < n; i++) c.lineTo(X(ds[i]), Y(hs[i] + ts[i]));
    for (let i = n - 1; i >= 0; i--) c.lineTo(X(ds[i]), Y(hs[i]));
    c.closePath();
    c.fill();

    // Траектория (до cutoff — сине-голубая/янтарная, после — красная пунктирная)
    const cutD = (r.cutoffDistM != null && r.cutoffDistM < D) ? r.cutoffDistM : (r.audible ? D : 0);
    const ptOnRay = (distVal) => {
      const f = clamp(distVal / D, 0, 1);
      if (r.ridgeBlocked && r.ridgeIdx > 0) {
        const dR = ds[r.ridgeIdx];
        const yR = hs[r.ridgeIdx] + 2;
        if (distVal <= dR) {
          const t = distVal / Math.max(1, dR);
          return [X(distVal), lerp(Y(zO), Y(yR), t)];
        }
        const t = (distVal - dR) / Math.max(1, D - dR);
        return [X(distVal), lerp(Y(yR), Y(zT), t)];
      }
      return [X(distVal), lerp(Y(zO), Y(zT), f)];
    };

    const drawRaySeg = (dFrom, dTo, color, dash) => {
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.setLineDash(dash || []);
      c.beginPath();
      const pA = ptOnRay(dFrom);
      c.moveTo(pA[0], pA[1]);
      if (r.ridgeBlocked && r.ridgeIdx > 0) {
        const dR = ds[r.ridgeIdx];
        if (dFrom < dR && dTo > dR) {
          const pM = ptOnRay(dR);
          c.lineTo(pM[0], pM[1]);
        }
      }
      const pB = ptOnRay(dTo);
      c.lineTo(pB[0], pB[1]);
      c.stroke();
    };

    if (cutD > 0) {
      drawRaySeg(0, cutD, r.ridgeBlocked ? '#f59e0b' : '#38bdf8', r.ridgeBlocked ? [4, 3] : []);
    }
    if (cutD < D) {
      drawRaySeg(cutD, D, '#ef4444', [3, 3]);
    }

    // Дуга отражения от склона
    if (r.reflBoost >= 0.8) {
      c.strokeStyle = '#a855f7';
      c.lineWidth = 1.5;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(X(0), Y(zO));
      c.quadraticCurveTo(W * 0.5, P + 4, X(D), Y(zT));
      c.stroke();
    }
    c.setLineDash([]);

    // Точки наблюдателя и цели
    c.fillStyle = '#38bdf8';
    c.beginPath(); c.arc(X(0), Y(zO), 3.5, 0, TAU); c.fill();
    c.fillStyle = r.audible ? '#10b981' : '#ef4444';
    c.beginPath(); c.arc(X(D), Y(zT), 3.5, 0, TAU); c.fill();

    // Подписи рельефа
    c.fillStyle = 'rgba(255,255,255,0.72)';
    c.font = '9px monospace';
    c.textAlign = 'left';
    c.fillText(`⛰️ ${Math.round(zO)}→${Math.round(zT)} м`, P + 2, P + 8);
    c.textAlign = 'right';
    c.fillText(r.distMeters < 1000 ? `${Math.round(r.distMeters)} м` : `${r.distKm.toFixed(1)} км`, W - P - 2, P + 8);

    // --- Нижняя полоса: Уровень сигнала (дБ) vs Порог ---
    const thr = r.detectThresholdDb;
    let dbMin = Math.min(thr - 8, r.totalDb - 4);
    let dbMax = Math.max(thr + 24, r.totalDb + 10);
    for (let i = 1; i < n; i++) {
      if (dbs[i] < dbMin) dbMin = dbs[i] - 3;
    }
    dbMin = Math.max(-15, dbMin);
    const Ydb = val => dbBot - (dbBot - dbTop) * clamp((val - dbMin) / Math.max(10, dbMax - dbMin), 0, 1);

    const yThr = Ydb(thr);
    c.strokeStyle = 'rgba(250, 204, 21, 0.75)';
    c.lineWidth = 1;
    c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(P, yThr); c.lineTo(W - P, yThr); c.stroke();
    c.setLineDash([]);

    // Кривая затухания сигнала
    for (let i = 1; i < n; i++) {
      const above = (dbs[i - 1] + dbs[i]) * 0.5 >= thr - 2.0;
      c.strokeStyle = above ? '#38bdf8' : '#ef4444';
      c.lineWidth = 1.8;
      c.beginPath();
      c.moveTo(X(ds[i - 1]), Ydb(dbs[i - 1]));
      c.lineTo(X(ds[i]), Ydb(dbs[i]));
      c.stroke();
    }

    if (r.cutoffDistM != null && r.cutoffDistM < D) {
      const xCut = X(r.cutoffDistM);
      c.strokeStyle = 'rgba(248, 113, 113, 0.65)';
      c.setLineDash([2, 2]);
      c.beginPath(); c.moveTo(xCut, P); c.lineTo(xCut, dbBot); c.stroke();
      c.setLineDash([]);
    }

    c.fillStyle = 'rgba(250, 204, 21, 0.9)';
    c.textAlign = 'left';
    c.fillText(`Порог ${thr.toFixed(0)} дБ`, P + 2, Math.max(dbTop + 8, yThr - 3));
    c.fillStyle = r.audible ? '#38bdf8' : '#f87171';
    c.textAlign = 'right';
    c.fillText(`${r.totalDb.toFixed(1)} дБ`, W - P - 2, dbBot - 2);

    c.restore();
  }

  function clearProbeOverlay() {
    if (probeLayer) probeLayer.clearLayers();
  }

  function showProbe(latlng) {
    if (!map) return null;
    const r = probe(latlng);
    if (!r) {
      toast('Сначала включите расчёт зоны слышимости');
      return null;
    }
    if (!r.inRange) {
      toast(`Точка вне радиуса расчёта (${r.distKm.toFixed(1)} км)`);
      return r;
    }

    clearProbeOverlay();
    if (probePopup) { try { map.closePopup(probePopup); } catch (e) {} probePopup = null; }

    // Отрисовка траекторий на карте
    if (probeLayer && observerLL) {
      L.polyline([observerLL, r.latlng], {
        color: r.audible ? '#3b82f6' : '#ef4444',
        weight: 2.2,
        dashArray: r.ridgeBlocked ? '5,5' : null,
        interactive: false
      }).addTo(probeLayer);

      if (r.reflectorLL && r.reflBoost >= 0.8) {
        L.polyline([observerLL, r.reflectorLL, r.latlng], {
          color: '#a855f7',
          weight: 2,
          dashArray: '4,4',
          interactive: false
        }).addTo(probeLayer);
        L.circleMarker(r.reflectorLL, {
          radius: 5,
          color: '#ffffff',
          fillColor: '#a855f7',
          fillOpacity: 0.9,
          weight: 1.5,
          interactive: false
        }).addTo(probeLayer);
      }
    }

    const distStr = r.distMeters < 1000 ? `${Math.round(r.distMeters)} м` : `${r.distKm.toFixed(2)} км`;
    const az = Math.round(r.bearing);
    const modeTitle = r.mode === 'emit' ? 'Там услышат ваш звук' : 'Вы услышите этот звук';

    let statusHtml = '';
    if (r.margin >= 10 && r.intelligible) {
      statusHtml = `<span style="color:#10b981;font-weight:700;">🔊 Отчётливо и разборчиво (+${r.margin.toFixed(1)} дБ)</span>`;
    } else if (r.audible && r.intelligible) {
      statusHtml = `<span style="color:#38bdf8;font-weight:700;">🗣️ Слышно разборчиво (+${r.margin.toFixed(1)} дБ к порогу)</span>`;
    } else if (r.audible) {
      statusHtml = `<span style="color:#f59e0b;font-weight:700;">🔉 Слышен глухой гул / НЧ (${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(1)} дБ)</span>`;
    } else {
      statusHtml = `<span style="color:#ef4444;font-weight:700;">🔇 Не слышно (${r.margin.toFixed(1)} дБ ниже порога)</span>`;
    }

    const fmtM = (m) => `${m >= 0 ? '+' : ''}${m.toFixed(0)}`;
    const details = [];
    details.push(`Сигнал: <b>${r.totalDb.toFixed(1)} дБ</b> (фон ${r.ambientDb.toFixed(0)} дБ)`);
    if (r.bandMargins) {
      details.push(`📊 Запас по октавам: НЧ <b>${fmtM(r.bandMargins[0])}</b> · СЧ <b>${fmtM(r.bandMargins[1])}</b> · ВЧ <b>${fmtM(r.bandMargins[2])} дБ</b>`);
    }
    if (r.barLoss > 1.5) details.push(`⛰️ Дифракция через преграду: <b>-${r.barLoss.toFixed(1)} дБ</b>`);
    if (r.reflBoost >= 0.8) {
      details.push(`🪞 Отражение волны от склона: <b style="color:#c084fc;">+${r.reflBoost.toFixed(1)} дБ</b> (стена в ${Math.round(r.reflectorDistM)} м)`);
    }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div style="min-width:270px;max-width:320px;font:11.5px/1.38 system-ui,sans-serif;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <b>🎧 ${modeTitle}: ${distStr}</b>
          <span style="font-family:monospace;color:var(--text-muted);">${az}°</span>
        </div>
        <div style="margin-bottom:4px;">${statusHtml}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px;">${details.join('<br>')}</div>
        <canvas class="wm-aud-probe-canvas" style="width:275px;height:136px;border-radius:6px;background:#0f172a;display:block;"></canvas>
        <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">⛰️ рельеф · 🌲 лес · ━ путь звука · ┅ порог слышимости (дБ)</div>
      </div>
    `;
    renderProbeCanvas(r, wrap.querySelector('canvas'), 275, 136);

    probePopup = L.popup({ maxWidth: 345, closeOnClick: false, autoClose: false })
      .setLatLng(latlng)
      .setContent(wrap)
      .openOn(map);
    probePopup.on('remove', () => clearProbeOverlay());
    return r;
  }

  // ---------------------------------------------------------------------------
  // МАРКЕР НАБЛЮДАТЕЛЯ И ПОДПИСИ
  // ---------------------------------------------------------------------------
  let _lastAudMarkerSig = '';
  let _lastAudProgAt = 0;

  function updateObserverMarker(statusOrElev, isStatus = false) {
    if (!observerLL || !layerGroup) return;
    const isDraggable = (originMode === 'manual');
    const iconChar = S.mode === 'emit' ? '📣' : '👂';
    const badge = isStatus ? String(statusOrElev) : (typeof statusOrElev === 'number' ? `${Math.round(statusOrElev)} м` : '…');
    const sig = `${S.mode}|${S.color}|${isDraggable ? 1 : 0}`;

    if (!observerMarker) {
      const html = `
        <div class="wm-aud-pin" style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
          <div class="wm-aud-dot" style="width:26px;height:26px;border-radius:50%;background:${S.color};border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:13px;">${iconChar}</div>
          <div class="wm-aud-badge" style="position:absolute;top:30px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.88);color:${isStatus ? '#fde047' : '#fff'};padding:1px 6px;border-radius:99px;font:700 10px/1.3 system-ui;white-space:nowrap;border:1px solid rgba(255,255,255,0.2);">${badge}</div>
        </div>
      `;
      observerMarker = L.marker(observerLL, {
        icon: L.divIcon({ className: 'wm-aud-div-icon', html, iconSize: [32, 32], iconAnchor: [16, 16] }),
        draggable: isDraggable,
        interactive: isDraggable,
        zIndexOffset: 2050
      }).addTo(layerGroup);
      observerMarker.on('dragend', (e) => {
        if (originMode === 'manual') {
          observerLL = e.target.getLatLng();
          updateMarkerProgress('⏳ Позиция', true);
          scheduleCompute();
        }
      });
      _lastAudMarkerSig = sig;
      return;
    }

    observerMarker.setLatLng(observerLL);
    if (observerMarker.dragging) {
      if (isDraggable) observerMarker.dragging.enable(); else observerMarker.dragging.disable();
    }

    const el = observerMarker.getElement && observerMarker.getElement();
    if (el) {
      if (_lastAudMarkerSig !== sig) {
        const dotEl = el.querySelector('.wm-aud-dot');
        if (dotEl) {
          dotEl.style.background = S.color;
          dotEl.textContent = iconChar;
        }
        _lastAudMarkerSig = sig;
      }
      const badgeEl = el.querySelector('.wm-aud-badge');
      if (badgeEl) {
        badgeEl.textContent = badge;
        badgeEl.style.color = isStatus ? '#fde047' : '#fff';
        return;
      }
    }
    observerMarker.setIcon(L.divIcon({
      className: 'wm-aud-div-icon',
      html: `<div class="wm-aud-pin" style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center;"><div class="wm-aud-dot" style="width:26px;height:26px;border-radius:50%;background:${S.color};border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:13px;">${iconChar}</div><div class="wm-aud-badge" style="position:absolute;top:30px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.88);color:${isStatus ? '#fde047' : '#fff'};padding:1px 6px;border-radius:99px;font:700 10px/1.3 system-ui;white-space:nowrap;border:1px solid rgba(255,255,255,0.2);">${badge}</div></div>`,
      iconSize: [32, 32], iconAnchor: [16, 16]
    }));
    _lastAudMarkerSig = sig;
  }

  function updateMarkerProgress(label, force = false) {
    if (!observerLL || !layerGroup) return;
    const now = nowMs();
    if (!force && now - _lastAudProgAt < 120) return;
    _lastAudProgAt = now;
    const dots = '.'.repeat((Math.floor(now / 350) % 3) + 1);
    updateObserverMarker(`${label}${dots}`, true);
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

  function setStatusInfo(html) {
    const box = document.getElementById('wm-aud-status-box');
    if (box) box.innerHTML = html;
  }

  function describeEnvLine(env, G) {
    const sNames = { summer: '☀️ Лето (листва)', spring_fall: '🍂 Межсезонье', winter: '❄️ Зима' };
    const modeLabel = S.mode === 'emit' ? '📣 Издаваемые' : '👂 Слышимые';
    const rKm = (G.Rm / 1000);
    const rStr = rKm < 1 ? `${Math.round(G.Rm)} м` : `${rKm.toFixed(1)} км`;

    const parts = [
      `<b>${modeLabel}</b> · <b>${S.volumeDb} дБ</b> (~${env.freqHz} Гц) · Радиус: <b>${rStr}</b>`,
      `🔇 Фон: <b>${Math.round(env.ambientDb)} дБ</b> (порог ~<b>${Math.round(env.detectThresholdDb)} дБ</b>, ${env.timePhase}) · ${sNames[env.season] || ''}${env.hasSnowCover ? ' · ❄️ снег' : ''}`,
      `🌡️ ${env.tempC.toFixed(0)}°C · RH ${Math.round(env.rh)}% · 💨 ${env.windSpeed.toFixed(1)} м/с (${Math.round(env.windFromDir)}°) · Затухание: ${env.alphaDbKm.toFixed(1)} дБ/км`
    ];
    if (G.demMissingOffline) {
      parts.push('<span style="color:#f59e0b;">⚠️ Оффлайн без DEM-тайлов: расчёт выполнен для ровной местности</span>');
    }
    if (G.canopyUnavailable) {
      parts.push('<span style="color:#f59e0b;">⚠️ Данные леса (v1/v2) недоступны: недостающие участки учтены без крон</span>');
    }
    env.notes.forEach(n => parts.push(`ℹ️ ${n}`));
    return parts.join('<br>');
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
    return (o ? o.lat.toFixed(5) + ',' + o.lng.toFixed(5) : '') + '|' + originMode + '|' + JSON.stringify(S) + '|' + demSourceId();
  }

  function scheduleCompute() {
    if (!isActive) return;
    lastSig = stateSig();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; runPipeline(); }, 220);
  }

  function repaint() {
    if (!isActive || !fields || running || paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      if (fields && !running) {
        paintFields(fields);
        publishOverlay(fields, null);
      }
    }, 50);
  }

  async function runPipeline() {
    if (!map || !isActive) { notifyIdle(); return; }
    syncObserverPosition();
    if (!observerLL) { notifyIdle(); return; }
    const token = ++pipeToken;
    running = true;

    try {
      const lat0 = observerLL.lat, lng0 = observerLL.lng;
      const env = await buildAcousticEnv(lat0, lng0);
      if (token !== pipeToken) return;
      lastEnv = env;
      updateCalcDetailsUI(); // <--- 1. Сразу показываем в спойлере погоду/ветер/время, пока грузится DEM

      const effRadiusKm = S.autoRadius ? estimateAutoRadiusKm(env) : clamp(S.radiusKm, 0.2, 50);
      const Rm = effRadiusKm * 1000;
      const gk = geoKeyOf(lat0, lng0, Rm);
      let changed = false;

      if (!geo || geo.key !== gk) {
        setStatusInfo(`⏳ Подготовка рельефа и водоёмов (${effRadiusKm} км)…`);
        const G = await buildGeometry(lat0, lng0, Rm, token, setStatusInfo);
        if (!G || token !== pipeToken) return;
        geo = G; aco = null; fields = null; changed = true;
      }

      const ak = [geo.key, env.key, S.earHeight, S.sourceHeight].join('|');
      if (!aco || aco.key !== ak) {
        setStatusInfo('⏳ Моделирование звуковых волн и отражений…');
        const A = await computeAudibility(geo, env, token, setStatusInfo);
        if (!A || token !== pipeToken) return;
        A.key = ak; aco = A; fields = null; changed = true;
      }

      const fk = [ak, QUALITY[S.quality].outSize].join('|');
      if (!fields || fields.key !== fk) {
        const F = await buildFields(geo, aco, env, token, setStatusInfo);
        if (!F || token !== pipeToken) return;
        F.key = fk; fields = F; changed = true;
      }

      if (!changed && audioOverlay && !paintDirty) return;
      paintDirty = false;

      paintFields(fields);
      publishOverlay(fields, describeEnvLine(env, geo));
      lastComputedLL = L.latLng(lat0, lng0);
      refreshUI(); // <--- 2. Обновляет авто-радиус в интерфейсе и дополняет спойлер данными о рельефе/лесе из geo
    } catch (e) {
      console.error('[audibility]', e);
      setStatusInfo('⚠️ Ошибка расчёта: ' + (e && e.message ? e.message : e));
    } finally {
      if (token === pipeToken) running = false;
      notifyIdle();
    }
  }

  // ---------------------------------------------------------------------------
  // ВСТРОЕННЫЙ ПОЛНОЦЕННЫЙ ИНТЕРФЕЙС (СВЯЗАННЫЙ HUD + CSS)
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ВСПОМОГАТЕЛЬНЫЙ БЛОК ПОДРОБНОЙ ДИАГНОСТИКИ ВЛИЯНИЯ ФАКТОРОВ
  // ---------------------------------------------------------------------------
  const WIND_ADJ = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];
  const WIND_TO  = ['на север', 'на северо-восток', 'на восток', 'на юго-восток', 'на юг', 'на юго-запад', 'на запад', 'на северо-запад'];

  function dirIdx8(deg) {
    return Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  }

  function renderCalcDetailsHtml(env, G) {
    if (!env) {
      return '<div class="hint-text">Данные среды появятся после завершения расчёта.</div>';
    }

    const rows = [];
    const addRow = (icon, title, effectHtml, muted = false) => {
      rows.push(`
        <div class="wm-aud-factor-item${muted ? ' is-off' : ''}">
          <div class="wm-aud-factor-head"><span>${icon} <b>${title}</b></span></div>
          <div class="wm-aud-factor-desc">${effectHtml}</div>
        </div>
      `);
    };

    const bandNames = { auto: 'авто по источнику', low: 'акцент НЧ', mid: 'акцент СЧ', high: 'акцент ВЧ' };
    const excess1m = S.volumeDb - env.detectThresholdDb;
    const radStr = G ? (G.Rm < 1000 ? `${Math.round(G.Rm)} м` : `${(G.Rm / 1000).toFixed(1)} км`) : '—';
    const gridStr = G ? `сетка ${G.nRays} лучей × ${G.nSteps} шагов, ` : '';
    const wPct = env.bandWeights.map(w => `${Math.round(w * 100)}%`).join(' / ');
    addRow(
      S.mode === 'emit' ? '📣' : '👂',
      `Источник ${S.volumeDb} дБ · 3 октавы (220 / 900 / 2800 Гц)`,
      `Режим: <b>${S.mode === 'emit' ? 'издаваемые' : 'слышимые'}</b> (${bandNames[S.freqBand] || 'авто'}, энергия НЧ/СЧ/ВЧ: <b>${wPct}</b>). ` +
      `Запас на 1 м: <b>${excess1m >= 0 ? '+' : ''}${excess1m.toFixed(1)} дБ</b>. ` +
      `Высоты: наблюдатель <b>${S.earHeight} м</b>, цель <b>${S.sourceHeight} м</b> (${gridStr}радиус ${radStr}).`
    );

    if (!S.factors.wind) {
      addRow('💨', 'Ветер', 'Фактор отключён — снос, акустическая тень и шум ветра не учитываются.', true);
    } else if (env.windSpeed < 1.0) {
      addRow('💨', `Штиль (${env.windSpeed.toFixed(1)} м/с)`, 'Скорость ветра минимальна: сноса, акустической тени и ветрового шума почти нет.');
    } else {
      const iFrom = dirIdx8(env.windFromDir);
      const iTo = dirIdx8(env.windToDir);
      const adj = WIND_ADJ[iFrom];
      const capAdj = adj.charAt(0).toUpperCase() + adj.slice(1);
      const noiseTxt = env.windNoiseDb > 0.2 ? `; повышает фоновый шум на <b>+${env.windNoiseDb.toFixed(1)} дБ</b>` : '';
      const windEffect = (S.mode === 'emit')
        ? `<b>Ослабляет</b> распространение против ветра (${WIND_TO[iFrom]}) и <b>усиливает</b> по ветру (${WIND_TO[iTo]})${noiseTxt}.`
        : `В режиме «Слышимые»: ветер <b>приносит</b> звук с наветренной стороны (${adj} сектор) и <b>сносит/глушит</b> звуки с подветренной стороны${noiseTxt}.`;
      addRow('💨', `${capAdj} ветер (${Math.round(env.windFromDir)}°, ${env.windSpeed.toFixed(1)} м/с)`, windEffect);
    }

    if (!S.factors.timeOfDay) {
      addRow('🌙', 'Время суток и инверсия', 'Фактор отключён — суточная инверсия и перепад шума дня/ночи не учитываются.', true);
    } else {
      const tStr = env.date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      let invDesc = '';
      if (env.inversionStrength > 0.25) {
        invDesc = `Сильная <b>температурная инверсия (${Math.round(env.inversionStrength * 100)}%)</b> прижимает звук к земле (волноводное распространение) и даёт тихий фон (~${env.baseAmbientDb.toFixed(0)} дБ) — дальность заметно <b>растёт</b>.`;
      } else if (env.inversionStrength > 0.05) {
        invDesc = `Умеренная инверсия (${Math.round(env.inversionStrength * 100)}%) слегка улучшает прохождение звука вдаль.`;
      } else if (env.inversionStrength < -0.1) {
        invDesc = `<b>Дневная конвекция</b> загибает звук вверх, формируя акустическую тень на дальних дистанциях и повышая дневной фон (~${env.baseAmbientDb.toFixed(0)} дБ).`;
      } else {
        invDesc = `Нейтральный температурный профиль, минимальный градиент рефракции.`;
      }
      addRow('🌙', `Время суток: ${env.timePhase} (${tStr}, Солнце ${env.sunAltDeg.toFixed(0)}°)`, invDesc);
    }

    if (!S.factors.weather) {
      addRow('🌤️', 'Погода и атмосфера', 'Фактор отключён — используются стандартные T=15°C / RH=60% без осадков.', true);
    } else {
      const wxSrcMap = { online: 'Open-Meteo (онлайн)', 'offline-cache': 'оффлайн-кэш Open-Meteo', manual: 'задана вручную', fallback: 'стандартная' };
      const precipParts = [];
      if (env.rain > 0.05) precipParts.push(`дождь/ливень ${env.rain.toFixed(1)} мм/ч (шум +${env.rainNoiseDb.toFixed(1)} дБ)`);
      if (env.snowfall > 0.1) precipParts.push(`снегопад ${env.snowfall.toFixed(1)} мм/ч (приглушает фон)`);
      if (env.fogStrength > 0.25) precipParts.push(`дымка/туман (видимость ${Math.round(env.visibility)} м, доп. затухание ВЧ)`);
      const precipTxt = precipParts.length ? `; ${precipParts.join(', ')}` : '; без осадков';
      addRow(
        '🌤️',
        `Погода (${wxSrcMap[env.wx?.source] || 'авто'}): ${env.tempC.toFixed(1)}°C, RH ${Math.round(env.rh)}%, эфф. облака ${Math.round(env.cloudEff * 100)}%`,
        `Затухание воздуха (ISO 9613-1) НЧ/СЧ/ВЧ: <b>${env.alphaBands.map(a => a.toFixed(1)).join(' / ')} дБ/км</b>. ` +
        `Турбулентность (CAPE ${Math.round(env.cape)}): <b>${env.turbDbKm.toFixed(2)} дБ/км</b>${precipTxt}.`
      );
    }

    if (!S.factors.relief) {
      addRow('⛰️', 'Рельеф и отражения', 'Фактор отключён — расчёт ведётся как по ровной плоскости.', true);
    } else if (G && G.flatMode) {
      addRow('⛰️', 'Рельеф (оффлайн-режим без DEM)', 'Нет загруженных тайлов DEM — поверхность принята плоской.', false);
    } else {
      const elevTxt = G ? `Высота точки: <b>${Math.round(G.obsGround)} м</b> н.у.м. ` : '';
      const reflTxt = S.factors.reflections
        ? 'Учитываются <b>2D-отражения от склонов</b>, просек и фокусировка в долинах.'
        : 'Отражения и эхо от склонов отключены.';
      addRow('⛰️', 'Рельеф (DEM) и частотная дифракция Maekawa', `${elevTxt}Гребни сильнее глушат ВЧ и огибаются низкими частотами (НЧ). ${reflTxt}`);
    }

    const sNames = { summer: 'лето', spring_fall: 'весна/осень', winter: 'зима' };
    if (!S.factors.foliage) {
      addRow('🌲', 'Лес и листва', 'Фактор отключён — кроны деревьев не поглощают звук.', true);
    } else {
      const obsTreeTxt = (G && G.obsTreeH >= 2) ? ` Наблюдатель в лесу (кроны ~${G.obsTreeH.toFixed(1)} м).` : '';
      addRow(
        '🌲',
        `Лес и листва (${sNames[env.season] || env.season}, кроны ${Math.round(env.leafFactor * 100)}%)`,
        `Полог деревьев (Meta CHM) поглощает звук только на участках, где сам луч проходит внутри крон (над долинами луч летит свободно). ВЧ глушатся в ~3 раза сильнее НЧ.${obsTreeTxt}`
      );
    }

    if (!S.factors.snow) {
      addRow('❄️', 'Снежный покров', 'Фактор отключён.', true);
    } else if (env.hasSnowCover) {
      addRow('❄️', 'Снежный покров (активен)', 'Рыхлый снег сильнее поглощает средние и высокие частоты у земли, снижает эхо на 35% и делает тише общий фон (−2.8 дБ).');
    } else {
      addRow('❄️', 'Снежный покров (отсутствует)', 'Снега нет: используется обычное приземное поглощение грунта.');
    }

    if (!S.factors.water) {
      addRow('🌊', 'Водоёмы (волновод)', 'Фактор отключён — водная гладь считается обычным грунтом.', true);
    } else {
      const obsW = (G && G.obsWater) ? ' Точка находится у/на воде.' : '';
      addRow('🌊', 'Водоёмы (ESA WorldCover)', `Над гладью воды нет поглощения грунтом, а в штиль формируется мягкий волновод (+1…+2.5 дБ). При сильном ветре волнение разрушает волновод и добавляет шум волн.${obsW}`);
    }

    const offTxt = S.ambientOffsetDb ? ` + ручная поправка ${S.ambientOffsetDb >= 0 ? '+' : ''}${S.ambientOffsetDb} дБ` : '';
    addRow(
      '🔇',
      `Фоновый шум: ${env.ambientDb.toFixed(1)} дБ · Пороги НЧ/СЧ/ВЧ: ${env.thrBands.map(t => t.toFixed(0)).join(' / ')} дБ`,
      S.factors.ambientNoise
        ? `Складывается из базового фона (${env.baseAmbientDb.toFixed(1)} дБ), ветра (+${env.windNoiseDb.toFixed(1)} дБ), осадков${offTxt}. В каждой октаве используется свой порог слышимости.`
        : `Адаптивный шум среды отключён (базовый фон 30 дБ${offTxt}).`,
      !S.factors.ambientNoise
    );

    return rows.join('');
  }

  function updateCalcDetailsUI() {
    const box = document.getElementById('wm-aud-calc-details-box');
    if (box) box.innerHTML = renderCalcDetailsHtml(lastEnv, geo);
  }

  // ---------------------------------------------------------------------------
  // СТИЛИ, ОБНОВЛЕНИЕ UI И ПРИВЯЗКА СОБЫТИЙ ВНУТРИ СПОЙЛЕРА
  // ---------------------------------------------------------------------------
  function ensureStyles() {
    if (document.getElementById('wm-audibility-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-audibility-style';
    st.textContent = `
      .wm-aud-pill-btn {
        border: 1px solid var(--border, rgba(255,255,255,0.2));
        background: var(--bg-primary, #0f172a);
        color: var(--text-main, #f1f5f9);
        border-radius: 7px;
        padding: 4px 9px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .wm-aud-pill-btn.active {
        background: var(--accent, #3b82f6);
        border-color: var(--accent, #3b82f6);
        color: #fff;
      }
      .wm-aud-seg {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 4px;
        background: var(--bg-secondary, #1e293b);
        padding: 3px;
        border-radius: 9px;
        border: 1px solid var(--border, rgba(255,255,255,0.1));
      }
      .wm-aud-seg-3 { grid-template-columns: repeat(3, 1fr); }
      .wm-aud-seg button {
        border: none;
        background: transparent;
        color: var(--text-muted, #94a3b8);
        padding: 5px 6px;
        border-radius: 7px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .wm-aud-seg button.active {
        background: var(--accent, #3b82f6);
        color: #fff;
      }
      .wm-aud-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
      .wm-aud-row:last-child { margin-bottom: 0; }
      .wm-aud-vol-wrap { position: relative; padding-top: 2px; }
      .wm-aud-zone-bar {
        display: flex;
        height: 6px;
        border-radius: 4px;
        overflow: hidden;
        margin-top: 3px;
        border: 1px solid var(--border, rgba(255,255,255,0.12));
      }
      .wm-aud-zone-1 { background: #10b981; flex: 68; }
      .wm-aud-zone-2 { background: #f59e0b; flex: 32; transition: opacity .2s; }
      .wm-aud-zone-2.locked { background: #475569; opacity: 0.35; }
      .wm-aud-zone-labels {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-muted, #94a3b8);
        margin-top: 2px;
      }
      .wm-aud-hint-box {
        margin-top: 6px;
        padding: 6px 8px;
        border-radius: 7px;
        background: var(--bg-primary, #0f172a);
        border-left: 3px solid var(--accent, #3b82f6);
        font-size: 11px;
      }
      .wm-aud-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
      .wm-aud-chip {
        border: 1px solid var(--border, rgba(255,255,255,0.15));
        background: var(--bg-primary, #0f172a);
        color: var(--text-main, #f1f5f9);
        border-radius: 99px;
        padding: 2px 8px;
        font-size: 10.5px;
        cursor: pointer;
      }
      .wm-aud-chip.active { border-color: var(--accent, #3b82f6); background: rgba(59,130,246,0.22); }
      .wm-aud-grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
      .wm-aud-chk {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        cursor: pointer;
        padding: 3px 4px;
        border-radius: 6px;
      }
      .wm-aud-chk:hover { background: rgba(255,255,255,0.04); }
      .wm-aud-status {
        font-size: 11px;
        line-height: 1.4;
        padding: 7px 9px;
        border-radius: 8px;
        background: var(--bg-primary, #0f172a);
        border: 1px solid var(--border, rgba(255,255,255,0.1));
        color: var(--text-muted, #cbd5e1);
      }
      .wm-aud-calc-details { display: flex; flex-direction: column; gap: 6px; }
      .wm-aud-factor-item {
        padding: 6px 8px;
        border-radius: 7px;
        background: var(--bg-primary, #0f172a);
        border: 1px solid var(--border, rgba(255,255,255,0.08));
        font-size: 10.8px;
        line-height: 1.38;
      }
      .wm-aud-factor-item.is-off { opacity: 0.55; }
      .wm-aud-factor-head { margin-bottom: 2px; color: var(--text-main, #f1f5f9); }
      .wm-aud-factor-desc { color: var(--text-muted, #cbd5e1); }
    `;
    document.head.appendChild(st);
  }

  function refreshUI() {
    const root = document.getElementById('spoiler-hud-audibility');
    const badge = document.getElementById('dem-hud-audibility-status-badge');
    const btnQuick = document.getElementById('btn-audibility-toggle-quick');
    const placeholder = document.getElementById('audibility-disabled-placeholder');
    const container = document.getElementById('audibility-settings-container');

    if (badge) {
      badge.textContent = isActive ? 'Вкл' : 'Выкл';
      badge.classList.toggle('active', isActive);
    }
    if (btnQuick) {
      btnQuick.textContent = isActive ? 'Выкл' : 'Вкл';
      btnQuick.classList.toggle('active', isActive);
    }
    if (placeholder) placeholder.hidden = isActive;
    if (container) {
      container.hidden = !isActive;
      container.classList.toggle('is-disabled', !isActive);
    }
    if (!root) return;

    const set = (id, v) => { const e = document.getElementById(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } };
    const txt = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

    root.querySelectorAll('.wm-aud-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
    root.querySelectorAll('.wm-aud-origin-btn').forEach(b => b.classList.toggle('active', b.dataset.origin === originMode));
    root.querySelectorAll('.wm-aud-qual-btn').forEach(b => b.classList.toggle('active', b.dataset.q === S.quality));

    const isEmit = (S.mode === 'emit');
    const minDb = isEmit ? 20 : 10;
    const maxDb = (isEmit && !S.allowGear) ? HUMAN_MAX_DB : 145;
    if (S.volumeDb < minDb) S.volumeDb = minDb;
    if (S.volumeDb > maxDb) S.volumeDb = maxDb;

    const volSlider = document.getElementById('wm-aud-vol-slider');
    if (volSlider) {
      volSlider.min = minDb;
      volSlider.max = 145;
      volSlider.value = S.volumeDb;
    }
    txt('wm-aud-vol-label', isEmit ? 'Громкость вашего звука (на 1 м)' : 'Громкость источника вокруг');
    txt('wm-aud-vol-val', `${Math.round(S.volumeDb)} дБ`);

    const zoneWrap = document.getElementById('wm-aud-zone-bar-wrap');
    const gearWrap = document.getElementById('wm-aud-gear-wrap');
    const z2Bar = document.getElementById('wm-aud-zone-2-bar');
    const z2Lbl = document.getElementById('wm-aud-zone-2-lbl');
    if (zoneWrap) zoneWrap.hidden = !isEmit;
    if (gearWrap) gearWrap.hidden = !isEmit;
    if (z2Bar) z2Bar.classList.toggle('locked', !S.allowGear);
    if (z2Lbl) z2Lbl.style.opacity = S.allowGear ? '1' : '0.4';
    set('wm-aud-allow-gear', S.allowGear);

    const hint = getHintForDb(S.volumeDb, S.mode);
    const hintBox = document.getElementById('wm-aud-vol-hint');
    if (hintBox && hint) {
      const zoneTag = (isEmit && hint.zone === 2)
        ? '<span style="color:#f59e0b;font-weight:700;">[Подручные средства]</span> '
        : (isEmit ? '<span style="color:#10b981;font-weight:700;">[Человек сам]</span> ' : '');
      hintBox.innerHTML = `${hint.icon} ${zoneTag}<b>${hint.title}</b>`;
    }

    const presetsWrap = document.getElementById('wm-aud-vol-presets');
    if (presetsWrap) {
      const list = isEmit ? (S.allowGear ? [...EMIT_PRESETS_HUMAN, ...EMIT_PRESETS_GEAR] : EMIT_PRESETS_HUMAN) : HEAR_PRESETS;
      presetsWrap.innerHTML = list.map((p, idx) => {
        const isSel = S.activePreset
          ? (S.activePreset.label === p.label && Math.abs(S.volumeDb - p.db) <= 2)
          : (Math.abs(S.volumeDb - p.db) <= 2);
        return `<button type="button" class="wm-aud-chip ${isSel ? 'active' : ''}" data-idx="${idx}">${p.label}</button>`;
      }).join('');
      presetsWrap.querySelectorAll('.wm-aud-chip').forEach(btn => {
        btn.onclick = () => {
          const p = list[parseInt(btn.dataset.idx, 10)];
          if (!p) return;
          S.volumeDb = p.db;
          S.activePreset = { label: p.label, db: p.db, freq: p.freq, kind: p.kind };
          saveSettings();
          refreshUI();
          scheduleCompute();
        };
      });
    }

    set('wm-aud-auto-rad', S.autoRadius);
    const radSlider = document.getElementById('wm-aud-rad-slider');
    if (radSlider) {
      radSlider.disabled = !!S.autoRadius;
      radSlider.value = S.radiusKm;
    }
    const shownRad = (S.autoRadius && geo) ? (geo.Rm / 1000) : S.radiusKm;
    txt('wm-aud-rad-val', (S.autoRadius ? 'Авто: ' : '') + (shownRad < 1 ? `${Math.round(shownRad * 1000)} м` : `${shownRad.toFixed(1)} км`));
    set('wm-aud-freq-band', S.freqBand);

    root.querySelectorAll('input[data-factor]').forEach(chk => {
      chk.checked = !!S.factors[chk.dataset.factor];
    });
    set('wm-aud-hl-echo', S.highlightEcho);

    set('wm-aud-season', S.season);
    set('wm-aud-time-mode', S.time.mode);
    const tWrap = document.getElementById('wm-aud-time-custom-wrap');
    if (tWrap) tWrap.hidden = S.time.mode !== 'custom';

    const d = S.time.ts ? new Date(S.time.ts) : new Date();
    const p2 = n => String(n).padStart(2, '0');
    const ti = document.getElementById('wm-aud-time-input');
    if (ti) {
      ti.value = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
    }
    const tSlider = document.getElementById('wm-aud-time-slider');
    if (tSlider) tSlider.value = d.getHours() * 60 + d.getMinutes();
    txt('wm-aud-time-slider-val', `${p2(d.getHours())}:${p2(d.getMinutes())}`);

    set('wm-aud-wx-source', S.wx.source);
    const wxWrap = document.getElementById('wm-aud-wx-manual-wrap');
    if (wxWrap) wxWrap.hidden = S.wx.source !== 'manual';

    const selPr = document.getElementById('wm-aud-wx-preset');
    if (selPr && !selPr.options.length) {
      selPr.innerHTML = Object.keys(WX_PRESETS).map(k => `<option value="${k}">${WX_PRESETS[k].label}</option>`).join('');
    }
    set('wm-aud-wx-preset', S.wx.preset);
    set('wm-aud-wind-spd', S.wx.windSpeed);
    txt('wm-aud-wind-spd-val', `${Number(S.wx.windSpeed).toFixed(1)} м/с`);
    set('wm-aud-wind-dir', S.wx.windDir);
    txt('wm-aud-wind-dir-val', `${Math.round(S.wx.windDir)}°`);

    set('wm-aud-amb-off', S.ambientOffsetDb);
    txt('wm-aud-amb-off-val', `${S.ambientOffsetDb >= 0 ? '+' : ''}${S.ambientOffsetDb} дБ`);
    set('wm-aud-opacity', Math.round(S.opacity * 100));
    set('wm-aud-color', S.color);

    const pBtn = document.getElementById('wm-aud-probe-btn');
    if (pBtn) {
      pBtn.classList.toggle('active', probeArmed);
      pBtn.textContent = probeArmed ? '🎯 Кликните на точку карты…' : '🎯 Проверить слышимость в точке карты';
    }

    updateCalcDetailsUI();
  }

  function bindSpoilerEvents() {
    const root = document.getElementById('spoiler-hud-audibility');
    if (!root || root._audBound) return;
    root._audBound = true;
    const on = (id, ev, fn) => { const e = document.getElementById(id); if (e) e.addEventListener(ev, fn); };

    root.querySelectorAll('.wm-aud-mode-btn').forEach(btn => {
      btn.onclick = () => setMode(btn.dataset.mode);
    });
    root.querySelectorAll('.wm-aud-origin-btn').forEach(btn => {
      btn.onclick = () => WM.audibility.setOriginMode(btn.dataset.origin);
    });
    root.querySelectorAll('.wm-aud-qual-btn').forEach(btn => {
      btn.onclick = () => {
        S.quality = btn.dataset.q;
        saveSettings(); refreshUI(); geo = null; scheduleCompute();
      };
    });

    on('wm-aud-vol-slider', 'input', (e) => {
      let v = parseInt(e.target.value, 10);
      if (S.mode === 'emit' && !S.allowGear && v > HUMAN_MAX_DB) {
        v = HUMAN_MAX_DB;
        e.target.value = HUMAN_MAX_DB;
      }
      S.volumeDb = v;
      if (S.activePreset && Math.abs(v - S.activePreset.db) > 5) {
        S.activePreset = null;
      }
      saveSettings();
      refreshUI();
      scheduleCompute();
    });

    on('wm-aud-allow-gear', 'change', (e) => {
      S.allowGear = !!e.target.checked;
      if (!S.allowGear && S.volumeDb > HUMAN_MAX_DB) S.volumeDb = HUMAN_MAX_DB;
      saveSettings(); refreshUI(); scheduleCompute();
    });

    on('wm-aud-auto-rad', 'change', (e) => { S.autoRadius = !!e.target.checked; saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-rad-slider', 'input', (e) => { S.radiusKm = clamp(parseFloat(e.target.value), 0.5, 50); saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-freq-band', 'change', (e) => { S.freqBand = e.target.value; saveSettings(); scheduleCompute(); });

    root.querySelectorAll('input[data-factor]').forEach(chk => {
      chk.addEventListener('change', (e) => {
        S.factors[chk.dataset.factor] = !!e.target.checked;
        saveSettings();
        if (chk.dataset.factor === 'relief' || chk.dataset.factor === 'foliage' || chk.dataset.factor === 'water') geo = null;
        scheduleCompute();
      });
    });

    on('wm-aud-hl-echo', 'change', (e) => { S.highlightEcho = !!e.target.checked; saveSettings(); repaint(); });
    on('wm-aud-season', 'change', (e) => { S.season = e.target.value; saveSettings(); scheduleCompute(); });
    on('wm-aud-time-mode', 'change', (e) => {
      S.time.mode = e.target.value;
      if (S.time.mode === 'custom' && !S.time.ts) S.time.ts = Date.now();
      saveSettings(); refreshUI(); scheduleCompute();
    });

    // Слайдер ручного времени суток
    on('wm-aud-time-slider', 'input', (e) => {
      const mins = clamp(parseInt(e.target.value, 10) || 0, 0, 1439);
      const hh = Math.floor(mins / 60);
      const mm = mins % 60;
      const base = S.time.ts ? new Date(S.time.ts) : new Date();
      base.setHours(hh, mm, 0, 0);
      S.time.mode = 'custom';
      S.time.ts = base.getTime();
      saveSettings();

      const p2 = n => String(n).padStart(2, '0');
      const lbl = document.getElementById('wm-aud-time-slider-val');
      if (lbl) lbl.textContent = `${p2(hh)}:${p2(mm)}`;
      const ti = document.getElementById('wm-aud-time-input');
      if (ti) ti.value = `${base.getFullYear()}-${p2(base.getMonth() + 1)}-${p2(base.getDate())}T${p2(hh)}:${p2(mm)}`;
      scheduleCompute();
    });

    on('wm-aud-time-input', 'change', (e) => {
      const d = new Date(e.target.value);
      if (!isNaN(d.getTime())) {
        S.time.ts = d.getTime();
        S.time.mode = 'custom';
        saveSettings();
        refreshUI();
        scheduleCompute();
      }
    });

    on('wm-aud-wx-source', 'change', (e) => { S.wx.source = e.target.value; saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-wx-preset', 'change', (e) => {
      S.wx.preset = e.target.value;
      const pr = WX_PRESETS[S.wx.preset];
      if (pr) { S.wx.tempC = pr.T; S.wx.rh = pr.RH; S.wx.windSpeed = pr.wind; }
      saveSettings(); refreshUI(); scheduleCompute();
    });
    on('wm-aud-wind-spd', 'input', (e) => { S.wx.windSpeed = parseFloat(e.target.value); saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-wind-dir', 'input', (e) => { S.wx.windDir = parseInt(e.target.value, 10); saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-amb-off', 'input', (e) => { S.ambientOffsetDb = parseInt(e.target.value, 10); saveSettings(); refreshUI(); scheduleCompute(); });
    on('wm-aud-opacity', 'input', (e) => {
      S.opacity = clamp(parseInt(e.target.value, 10) / 100, 0.1, 0.95);
      if (audioOverlay) audioOverlay.setOpacity(S.opacity);
      saveSettings();
    });
    on('wm-aud-color', 'input', (e) => { S.color = e.target.value; saveSettings(); repaint(); });

    on('wm-aud-probe-btn', 'click', () => {
      if (!isActive) { toast('Сначала включите зону слышимости'); return; }
      probeArmed = !probeArmed;
      if (map) map.getContainer().style.cursor = probeArmed ? 'crosshair' : '';
      refreshUI();
    });
  }


  // ---------------------------------------------------------------------------
  // КОМПАС И ИНИЦИАЛИЗАЦИЯ
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
    loadWxCacheFromLS();
    ensureStyles();
    bindSpoilerEvents();
    refreshUI();
    if (!layerGroup) layerGroup = L.layerGroup();
    if (!probeLayer) probeLayer = L.layerGroup();

    if (isActive && !map.hasLayer(layerGroup)) layerGroup.addTo(map);
    if (isActive && !map.hasLayer(probeLayer)) probeLayer.addTo(map);

    map.on('click', (e) => {
      if (probeArmed) {
        WM.audibility.analyzeTarget(e.latlng);
      } else if (isActive && originMode === 'manual') {
        observerLL = e.latlng;
        updateObserverMarker('⏳ Расчёт…', true);
        scheduleCompute();
      }
    });

    map.on('moveend', () => {
      if (isActive && originMode === 'center') scheduleCompute();
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
    window.addEventListener('online', () => {
      NetHealth.hosts.clear();
      if (isActive && geo && (geo.tilesFail > 0 || geo.demMissingOffline || geo.canopyUnavailable)) {
        geo = null; aco = null; fields = null;
        scheduleCompute();
      }
    });
    window.addEventListener('wm:canopy-version-change', () => {
      if (_internalCanopySwitch) return;
      if (isActive && S.factors.foliage) {
        geo = null; aco = null; fields = null;
        scheduleCompute();
      }
    });

    if (envTimer) clearInterval(envTimer);
    envTimer = setInterval(() => {
      if (isActive && (S.time.mode === 'now' || S.wx.source === 'auto')) {
        paintDirty = true;
        scheduleCompute();
      }
    }, 10 * 60 * 1000);
  }

  function toggle() {
    isActive = !isActive;
    if (isActive) {
      if (map && layerGroup && !map.hasLayer(layerGroup)) layerGroup.addTo(map);
      if (map && probeLayer && !map.hasLayer(probeLayer)) probeLayer.addTo(map);
      syncObserverPosition();
      refreshUI();
      scheduleCompute();
      toast('🎧 Зона слышимости включена');
    } else {
      pipeToken++; running = false;
      probeArmed = false;
      if (map) map.getContainer().style.cursor = '';
      if (timer) { clearTimeout(timer); timer = null; }
      closeProbePopup();
      if (layerGroup) layerGroup.clearLayers();
      if (probeLayer) probeLayer.clearLayers();
      if (map && layerGroup && map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
      if (map && probeLayer && map.hasLayer(probeLayer)) map.removeLayer(probeLayer);
      audioOverlay = null; observerMarker = null;
      geo = null; aco = null; fields = null; lastEnv = null;
      if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
      refreshUI();
      toast('🎧 Зона слышимости выключена');
      notifyIdle();
    }
  }

  function openPanel() {
    if (WM.demRelief && WM.demRelief.openHud) {
      WM.demRelief.openHud('tools', 'spoiler-hud-audibility');
    }
    refreshUI();
  }

  function closePanel() {
    const sp = document.getElementById('spoiler-hud-audibility');
    if (sp) sp.open = false;
  }

  function setMode(mode) {
    if (mode !== 'hear' && mode !== 'emit') return;
    S.mode = mode;
    S.activePreset = null;
    const minDb = mode === 'emit' ? 20 : 10;
    const maxDb = (mode === 'emit' && !S.allowGear) ? HUMAN_MAX_DB : 145;
    S.volumeDb = clamp(S.volumeDb, minDb, maxDb);
    saveSettings();
    refreshUI();
    if (isActive) scheduleCompute();
  }

  function closeProbePopup() {
    clearProbeOverlay();
    if (probePopup && map) {
      try { map.closePopup(probePopup); } catch (e) {}
      probePopup = null;
      return true;
    }
    return false;
  }

// ---------------------------------------------------------------------------
  // ПУБЛИЧНЫЙ API
  // ---------------------------------------------------------------------------
  WM.audibility = {
    init,
    toggle,
    refreshUI,
    isActive: () => isActive,
    openPanel,
    closePanel,
    prefetchWeather: (lat, lng) => fetchWeather(lat, lng).catch(() => null),

    getLayerGroup: () => {
      if (!layerGroup && typeof L !== 'undefined' && L.layerGroup) layerGroup = L.layerGroup();
      return layerGroup;
    },
    getLayer: () => WM.audibility.getLayerGroup(),

    getOriginMode: () => originMode,
    setOriginMode(mode) {
      if (mode !== 'center' && mode !== 'gps' && mode !== 'manual') return;
      originMode = mode;
      try { localStorage.setItem('wm_audibility_origin_mode', mode); } catch (e) {}
      syncObserverPosition();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setObserver(latlng) {
      observerLL = L.latLng(latlng);
      originMode = 'manual';
      try { localStorage.setItem('wm_audibility_origin_mode', 'manual'); } catch (e) {}
      if (!isActive) {
        toggle();
      } else {
        updateObserverMarker('⏳ Расчёт…', true);
        refreshUI();
        scheduleCompute();
      }
    },

    onGpsUpdate(ll) {
      if (isActive && originMode === 'gps') {
        const nextLL = L.latLng(ll[0], ll[1]);
        if (!lastComputedLL || lastComputedLL.distanceTo(nextLL) > 25.0) {
          observerLL = nextLL;
          scheduleCompute();
        }
      }
    },

    scheduleCompute,
    invalidate() {
      geo = null; aco = null; fields = null;
      if (isActive) scheduleCompute();
    },
    whenIdle,

    applyProfile(profileData) {
      if (!profileData) return;
      const s = profileData.settings || profileData;
      for (const k in s) {
        if (k in S) {
          if (typeof S[k] === 'object' && S[k] !== null && !Array.isArray(S[k])) {
            Object.assign(S[k], s[k]);
          } else {
            S[k] = s[k];
          }
        }
      }
      saveSettings();
      refreshUI();

      const shouldBeActive = profileData.active !== undefined ? !!profileData.active : false;
      if (isActive !== shouldBeActive) {
        toggle();
      } else if (isActive) {
        geo = null; aco = null; fields = null;
        scheduleCompute();
      }
    },

    setMode,

    setVolumeDb(db) {
      const minDb = S.mode === 'emit' ? 20 : 10;
      const maxDb = (S.mode === 'emit' && !S.allowGear) ? HUMAN_MAX_DB : 145;
      S.volumeDb = clamp(+db || 74, minDb, maxDb);
      if (S.activePreset && Math.abs(S.volumeDb - S.activePreset.db) > 5) {
        S.activePreset = null;
      }
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setAllowGear(v) {
      S.allowGear = !!v;
      if (!S.allowGear && S.mode === 'emit' && S.volumeDb > HUMAN_MAX_DB) {
        S.volumeDb = HUMAN_MAX_DB;
      }
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setFactor(key, val) {
      if (key in S.factors) {
        S.factors[key] = !!val;
        saveSettings();
        refreshUI();
        if (key === 'relief' || key === 'foliage' || key === 'water') {
          geo = null;
        }
        if (isActive) scheduleCompute();
      }
    },

    setFactors(obj) {
      if (!obj || typeof obj !== 'object') return;
      let needGeoReset = false;
      Object.keys(obj).forEach(k => {
        if (k in S.factors) {
          S.factors[k] = !!obj[k];
          if (k === 'relief' || k === 'foliage' || k === 'water') needGeoReset = true;
        }
      });
      if (needGeoReset) geo = null;
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setFreqBand(band) {
      if (band === 'auto' || band === 'low' || band === 'mid' || band === 'high') {
        S.freqBand = band;
        saveSettings();
        refreshUI();
        if (isActive) scheduleCompute();
      }
    },

    setAutoRadius(v) {
      S.autoRadius = !!v;
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setRadiusKm(km) {
      S.autoRadius = false;
      S.radiusKm = clamp(+km || 6, 0.25, 50);
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setQuality(q) {
      if (QUALITY[q]) {
        S.quality = q;
        geo = null;
        saveSettings();
        refreshUI();
        if (isActive) scheduleCompute();
      }
    },

    setEarHeight(h) {
      S.earHeight = clamp(+h || 1.6, 0.2, 100);
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setSourceHeight(h) {
      S.sourceHeight = clamp(+h || 1.5, 0.1, 100);
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setOpacity(op) {
      S.opacity = clamp(+op, 0.05, 1);
      if (audioOverlay) audioOverlay.setOpacity(S.opacity);
      saveSettings();
      refreshUI();
    },

    setColor(hex) {
      S.color = hex || '#3b82f6';
      saveSettings();
      refreshUI();
      if (isActive) repaint();
    },

    setEchoColor(hex) {
      S.echoColor = hex || '#a855f7';
      saveSettings();
      refreshUI();
      if (isActive) repaint();
    },

    setHighlightEcho(v) {
      S.highlightEcho = !!v;
      saveSettings();
      refreshUI();
      if (isActive) repaint();
    },

    setFollowCompass(v) {
      S.followCompass = !!v;
      saveSettings();
      if (isActive) repaint();
    },

    setObserverSnap(v) {
      S.observerSnap = !!v;
      geo = null;
      saveSettings();
      if (isActive) scheduleCompute();
    },

    setAmbientOffsetDb(db) {
      S.ambientOffsetDb = clamp(parseInt(db, 10) || 0, -10, 25);
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setSeason(season) {
      if (season === 'auto' || season === 'summer' || season === 'spring_fall' || season === 'winter') {
        S.season = season;
        saveSettings();
        refreshUI();
        if (isActive) scheduleCompute();
      }
    },

    setDateTime(d) {
      S.time.mode = d ? 'custom' : 'now';
      S.time.ts = d ? new Date(d).getTime() : null;
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    setWeather(o) {
      if (!o || typeof o !== 'object') return;
      Object.assign(S.wx, o);
      saveSettings();
      refreshUI();
      if (isActive) scheduleCompute();
    },

    getWeatherPresets: () => Object.keys(WX_PRESETS).map(k => ({ id: k, label: WX_PRESETS[k].label })),
    getHints: (mode) => ((mode || S.mode) === 'emit' ? EMIT_HINTS : HEAR_HINTS).slice(),

    probe,
    showProbe,
    analyzeTarget(latlng) {
      probeArmed = false;
      if (map) map.getContainer().style.cursor = '';
      refreshUI();
      return showProbe(latlng);
    },
    isProbeArmed: () => probeArmed,
    armTargetProbe() {
      if (!isActive) { toast('Сначала включите зону слышимости'); return; }
      probeArmed = true;
      if (map) map.getContainer().style.cursor = 'crosshair';
      refreshUI();
    },
    closeProbePopup,

    getEnvironment: () => lastEnv,
    getSettings: () => JSON.parse(JSON.stringify(S))
  };

  function toast(msg, ms) {
    try {
      if (WM.ui && typeof WM.ui.showToast === 'function') {
        WM.ui.showToast(msg, ms);
      }
    } catch (e) {}
  }
})();