/**
 * js/offlineArea.js
 * Универсальный модуль офлайн-загрузки области, расчёта квот/размера,
 * инкрементальной докачки и гибкой очистки кэша (WM.offlineArea).
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  if (WM.offlineArea && WM.offlineArea._loaded) return;

  // =========================================================================
  // 1. КОНСТАНТЫ И ОГРАНИЧЕНИЯ БЕЗОПАСНОСТИ
  // =========================================================================
  const DB_NAME = 'WM_Offline_Packs_DB';
  const DB_VER = 1;
  const TILE_CACHE_NAME = 'wm-tiles-v1';
  const PREFS_LS_KEY = 'wm_oa_prefs_v1';

  const ABS_MIN_ZOOM = 4;
  const ABS_MAX_ZOOM = 18;
  const MAX_TILES_PER_SOURCE = 900;     // Жёсткий потолок тайлов на один источник за скачивание
  const MAX_TOTAL_TILES_HARD = 3600;    // Общий потолок тайлов за одну сессию

  const WM_MAX_OBJECTS = 100;           // Чёткий лимит объектов Wikimapia с карточками
  const WM_MAX_BOX_TILES = 16;          // Потолок обзорных тайлов Wikimapia за сессию
  const WM_MIN_DELAY_MS = 1150;         // Базовая пауза между запросами карточек Wikimapia
  const WM_JITTER_MS = 650;             // Случайный джиттер паузы
  const WM_BURST_EVERY = 12;            // Дополнительная передышка каждые N запросов
  const WM_BURST_PAUSE_MS = 3000;

  const MAX_SOIL_POINTS = 16;           // Потолок точек SoilGrids на область

  const SOIL_TTL_MS = 30 * 24 * 3600 * 1000;
  const SOIL_CACHE_RADIUS_M = 450;      // Радиус переиспользования при скачивании сетки
  const SOIL_FALLBACK_RADIUS_M = 20000; // Макс. радиус поиска ближайшей точки SoilGrids в офлайне (20 км)

  const DEM_MAX_ZOOM = 15;              // Выше z15 DEM-модуль сам кропит родительские тайлы
  const CANOPY_MAX_ZOOM = 15;           // Высота крон / маска
  const CANOPY_SPECIES_MAX_ZOOM = 12;   // Породы леса GLC_FCS30D (30 м)
  const VECTOR_MIN_ZOOM = 9;
  const VECTOR_MAX_ZOOM = 14;           // Shortbread MVT (вектор рендерится до z20)
  const VERSATILES_MIN_ZOOM = 9;
  const VERSATILES_MAX_ZOOM = 13;       // POI для PeakView (пики, перевалы, н.п.)
  const ESA_WATER_MAX_ZOOM = 14;

  const DEG = Math.PI / 180;

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[m]));
  const fmtBytes = bytes => {
    if (!bytes || bytes <= 0) return '0 КБ';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  };
  const fmtArea = km2 => {
    if (km2 < 0.5) return Math.round(km2 * 100) + ' га';
    if (km2 < 10) return km2.toFixed(2) + ' км²';
    if (km2 < 1000) return km2.toFixed(1) + ' км²';
    return Math.round(km2).toLocaleString('ru-RU') + ' км²';
  };

  function toast(msg, ms = 2600) {
    if (WM.ui && typeof WM.ui.showToast === 'function') {
      WM.ui.showToast(msg, ms);
    } else {
      console.info('[OfflineArea]', msg);
    }
  }

  // =========================================================================
  // 2. ГЕОМЕТРИЯ И ПРОЕКЦИИ ТАЙЛОВ (WebMercator, TMS, QuadKey, Yandex 3395)
  // =========================================================================
  function normalizeBounds(b) {
    if (!b) return null;
    const w = clamp(Number(b.w ?? b.getWest?.() ?? 0), -179.999, 179.999);
    const e = clamp(Number(b.e ?? b.getEast?.() ?? 0), -179.999, 179.999);
    const s = clamp(Number(b.s ?? b.getSouth?.() ?? 0), -85.051, 85.051);
    const n = clamp(Number(b.n ?? b.getNorth?.() ?? 0), -85.051, 85.051);
    return {
      w: Math.min(w, e),
      e: Math.max(w, e),
      s: Math.min(s, n),
      n: Math.max(s, n)
    };
  }

  function boundsAreaKm2(b) {
    const avgLat = (b.n + b.s) * 0.5;
    const cosLat = Math.max(0.05, Math.cos(avgLat * DEG));
    const hKm = (b.n - b.s) * 111.132;
    const wKm = (b.e - b.w) * 111.320 * cosLat;
    return Math.max(0.001, Math.abs(hKm * wKm));
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function lonToTileX(lon, z) {
    const n = 1 << z;
    return clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1);
  }

  function latToTileY(lat, z) {
    const n = 1 << z;
    const r = clamp(lat, -85.051128, 85.051128) * DEG;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    return clamp(y, 0, n - 1);
  }

  function latToYandexTileY(lat, z) {
    const n = 1 << z;
    const rLat = clamp(lat, -85.051128, 85.051128) * DEG;
    const a = 6378137.0;
    const b = 6356752.3142;
    const e = Math.sqrt(1 - (b * b) / (a * a));
    const sinPhi = Math.sin(rLat);
    const ts = Math.tan(Math.PI / 4 - rLat / 2) / Math.pow((1 - e * sinPhi) / (1 + e * sinPhi), e / 2);
    const mercY = -a * Math.log(Math.max(ts, 1e-10));
    const worldSize = 40075016.68557849;
    return clamp(Math.floor((1 - (mercY + worldSize / 2) / worldSize) * n), 0, n - 1);
  }

  function toQuadKey(x, y, z) {
    let q = '';
    for (let i = z; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((x & mask) !== 0) digit += 1;
      if ((y & mask) !== 0) digit += 2;
      q += digit;
    }
    return q;
  }

  function tileRangeForZoom(bounds, z, isYandex = false) {
    const x0 = lonToTileX(bounds.w, z);
    const x1 = lonToTileX(bounds.e, z);
    const yFn = isYandex ? latToYandexTileY : latToTileY;
    const y0 = yFn(bounds.n, z);
    const y1 = yFn(bounds.s, z);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    return {
      z, x0: minX, x1: maxX, y0: minY, y1: maxY,
      count: (maxX - minX + 1) * (maxY - minY + 1)
    };
  }

  function countTilesInRange(bounds, zMin, zMax, isYandex = false) {
    let sum = 0;
    for (let z = zMin; z <= zMax; z++) {
      sum += tileRangeForZoom(bounds, z, isYandex).count;
    }
    return sum;
  }

  function computeAllowedMaxZoom(bounds, minZ) {
    const safeMin = clamp(minZ, ABS_MIN_ZOOM, ABS_MAX_ZOOM);
    if (tileRangeForZoom(bounds, safeMin).count > MAX_TILES_PER_SOURCE) {
      let z = safeMin;
      while (z > ABS_MIN_ZOOM && tileRangeForZoom(bounds, z).count > MAX_TILES_PER_SOURCE) {
        z--;
      }
      return z;
    }
    let best = safeMin;
    let total = 0;
    for (let z = safeMin; z <= ABS_MAX_ZOOM; z++) {
      const c = tileRangeForZoom(bounds, z).count;
      if (total + c > MAX_TILES_PER_SOURCE) break;
      total += c;
      best = z;
    }
    return best;
  }

  function buildTileCoordsList(bounds, zMin, zMax, isYandex = false, maxLimit = MAX_TILES_PER_SOURCE) {
    const list = [];
    for (let z = zMin; z <= zMax; z++) {
      const r = tileRangeForZoom(bounds, z, isYandex);
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          list.push({ z, x, y });
          if (list.length >= maxLimit) return list;
        }
      }
    }
    return list;
  }

  function formatTileTemplate(tpl, coords, opts = {}) {
    const n = 1 << coords.z;
    const rawSubs = opts.subdomains;
    const subs = Array.isArray(rawSubs) && rawSubs.length
      ? rawSubs
      : (typeof rawSubs === 'string' && rawSubs.length ? rawSubs.split('') : ['a', 'b', 'c']);
    const s = subs[Math.abs(coords.x + coords.y) % subs.length];
    const yTms = n - 1 - coords.y;
    const q = toQuadKey(coords.x, coords.y, coords.z);
    const hash = (coords.x % 4) + (coords.y % 4) * 4;
    return tpl
      .replace(/\{z\}/g, String(coords.z))
      .replace(/\{x\}/g, String(coords.x))
      .replace(/\{y\}/g, String(coords.y))
      .replace(/\{-y\}/g, String(yTms))
      .replace(/\{s\}/g, String(s))
      .replace(/\{q\}/g, q)
      .replace(/\{hash\}/g, String(hash));
  }

  // =========================================================================
  // 3. ЛОКАЛЬНАЯ БД (IndexedDB WM_Offline_Packs_DB) + CACHE STORAGE
  // =========================================================================
  let _dbPromise = null;

  function openOfflineDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('areas')) db.createObjectStore('areas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('soil_points')) db.createObjectStore('soil_points', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('canopy_v2')) db.createObjectStore('canopy_v2', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('fallback_blobs')) db.createObjectStore('fallback_blobs', { keyPath: 'url' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return _dbPromise;
  }

  async function idbAll(store) {
    const db = await openOfflineDb();
    if (!db) return [];
    return new Promise(res => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => res([]);
      } catch (e) { res([]); }
    });
  }

  async function idbKeys(store) {
    const db = await openOfflineDb();
    if (!db) return [];
    return new Promise(res => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => res([]);
      } catch (e) { res([]); }
    });
  }

  async function idbCount(store) {
    const db = await openOfflineDb();
    if (!db) return 0;
    return new Promise(res => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).count();
        req.onsuccess = () => res(req.result || 0);
        req.onerror = () => res(0);
      } catch (e) { res(0); }
    });
  }


  async function idbPut(store, item) {
    const db = await openOfflineDb();
    if (!db) return false;
    return new Promise(res => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(item);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  }

  async function idbDel(store, key) {
    const db = await openOfflineDb();
    if (!db) return false;
    return new Promise(res => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  }

  async function idbClear(store) {
    const db = await openOfflineDb();
    if (!db) return false;
    return new Promise(res => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  }

  let _tileCachePromise = null;
  let _hasFallbackBlobs = null; // null = неизвестно, true/false после первой проверки

  async function openTileCache() {
    if (!('caches' in window)) return null;
    if (!_tileCachePromise) {
      _tileCachePromise = caches.open(TILE_CACHE_NAME).catch(() => {
        _tileCachePromise = null;
        return null;
      });
    }
    return _tileCachePromise;
  }

  async function hasAnyFallbackBlobs() {
    if (_hasFallbackBlobs !== null) return _hasFallbackBlobs;
    const cnt = await idbCount('fallback_blobs');
    _hasFallbackBlobs = cnt > 0;
    return _hasFallbackBlobs;
  }

  async function putCachedResponse(tileCache, url, response) {
    if (tileCache) {
      try {
        await tileCache.put(url, response.clone());
        return true;
      } catch (e) {}
    }
    try {
      if (response.type !== 'opaque') {
        const blob = await response.clone().blob();
        await idbPut('fallback_blobs', { url, blob, size: blob.size, ts: Date.now() });
        _hasFallbackBlobs = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function readCachedResponse(url, allowOpaque = false) {
    if (!url) return null;
    const tileCache = await openTileCache();
    if (tileCache) {
      try {
        const hit = await tileCache.match(url, { ignoreVary: true });
        if (hit && (hit.ok || (allowOpaque && hit.type === 'opaque'))) {
          return hit;
        }
      } catch (e) {}
    }
    if (await hasAnyFallbackBlobs()) {
      try {
        const db = await openOfflineDb();
        if (db) {
          const rec = await new Promise(res => {
            try {
              const req = db.transaction('fallback_blobs', 'readonly').objectStore('fallback_blobs').get(url);
              req.onsuccess = () => res(req.result || null);
              req.onerror = () => res(null);
            } catch (e) { res(null); }
          });
          if (rec && rec.blob) {
            return new Response(rec.blob, { status: 200 });
          }
        }
      } catch (e) {}
    }
    return null;
  }

  async function hasCachedUrl(tileCache, url) {
    if (tileCache) {
      try {
        const hit = await tileCache.match(url, { ignoreVary: true });
        if (hit) return true;
      } catch (e) {}
    }
    try {
      const db = await openOfflineDb();
      if (db) {
        const count = await new Promise(res => {
          try {
            const req = db.transaction('fallback_blobs', 'readonly').objectStore('fallback_blobs').count(url);
            req.onsuccess = () => res(req.result || 0);
            req.onerror = () => res(0);
          } catch (e) { res(0); }
        });
        if (count > 0) return true;
      }
    } catch (e) {}
    return false;
  }

  function syncSwNoTrim(enable) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      try {
        navigator.serviceWorker.controller.postMessage({ type: 'SET_NO_TRIM_TILES', value: !!enable });
      } catch (e) {}
    }
  }

  // =========================================================================
  // 4. АДАПТЕР КАТАЛОГА КАРТ И ОПРЕДЕЛЕНИЕ ИСТОЧНИКОВ ПРОЕКТА
  // =========================================================================
  function extractBaseMapLayers(entry) {
    const out = [];
    if (!entry || !entry.layer || entry.id === 'noBase') return out;
    const rawLayers = typeof entry.layer.getLayers === 'function' ? entry.layer.getLayers() : [entry.layer];
    const isYandex = /yandex/i.test(entry.id || '') || /яндекс/i.test(entry.name || '');

    rawLayers.forEach(l => {
      if (!l) return;
      let tpl = l._url || '';
      if (!tpl && /maps-for-free/i.test(entry.id + ' ' + entry.name)) {
        tpl = 'https://maps-for-free.com/layer/relief/z{z}/row{y}/{z}_{x}-{y}.jpg';
      }
      if (!tpl && entry.testUrl && !/tile\?/.test(entry.testUrl)) {
        tpl = entry.testUrl;
      }
      if (!tpl) return;

      const opt = l.options || {};
      const minZ = Math.max(0, opt.minNativeZoom != null ? opt.minNativeZoom : (opt.minZoom || 0));
      const maxZ = Math.min(ABS_MAX_ZOOM, opt.maxNativeZoom != null ? opt.maxNativeZoom : (opt.maxZoom || ABS_MAX_ZOOM));
      out.push({
        tpl,
        subdomains: opt.subdomains || entry.subdomains || ['a', 'b', 'c'],
        minZ,
        maxZ,
        isYandex
      });
    });
    return out;
  }

  function getBaseMapsList() {
    const cat = Array.isArray(WM.baseMapsCatalog) ? WM.baseMapsCatalog : [];
    const curActive = localStorage.getItem('wm_base_layer') || '';
    let disabled = [];
    try {
      const s = localStorage.getItem('wm_disabled_base_maps');
      if (s) disabled = JSON.parse(s) || [];
    } catch (e) {}

    return cat
      .filter(m => extractBaseMapLayers(m).length > 0)
      .map(m => ({
        id: m.id,
        name: m.name,
        category: m.category || m.group || 'other',
        isActive: m.name === curActive,
        isEnabledInMenu: !disabled.includes(m.name),
        avgKb: m.category === 'satellite' ? 28 : (m.category === 'historical' ? 24 : 18),
        sublayers: extractBaseMapLayers(m)
      }));
  }

  // =========================================================================
  // ЧТЕНИЕ ИЗ ОФЛАЙН-КЭША (CACHE-FIRST API ДЛЯ МОДУЛЕЙ ПРИЛОЖЕНИЯ)
  // =========================================================================
  

  async function readCachedBlob(url) {
    const resp = await readCachedResponse(url);
    if (!resp) return null;
    try {
      const blob = await resp.blob();
      return blob && blob.size > 0 ? blob : null;
    } catch (e) {
      return null;
    }
  }

  async function readCachedBuffer(url) {
    const resp = await readCachedResponse(url);
    if (!resp) return null;
    try {
      const buf = await resp.arrayBuffer();
      return buf && buf.byteLength > 0 ? buf : null;
    } catch (e) {
      return null;
    }
  }

  async function readCachedTileBlobUrl(url) {
    const resp = await readCachedResponse(url, false);
    if (!resp) return null;
    try {
      const blob = await resp.blob();
      if (blob && blob.size > 0) {
        return { blobUrl: URL.createObjectURL(blob), size: blob.size };
      }
    } catch (e) {}
    return null;
  }

  async function readCanopyV2Grid(z, x, y, targetQ = 5) {
    const db = await openOfflineDb();
    if (!db) return null;
    const key = `v2/height/${z}/${x}/${y}`;
    return new Promise(res => {
      try {
        const req = db.transaction('canopy_v2', 'readonly').objectStore('canopy_v2').get(key);
        req.onsuccess = () => {
          const rec = req.result;
          if (!rec) return res(null);
          if (rec.zero) return res('ZERO');
          if (rec.grid) {
            const arr = rec.grid instanceof Uint8Array ? rec.grid : new Uint8Array(rec.grid);
            const srcQ = rec.q || 5;
            if (targetQ && targetQ !== srcQ) {
              const scaled = new Uint8Array(arr.length);
              const ratio = targetQ / srcQ;
              for (let i = 0; i < arr.length; i++) {
                scaled[i] = Math.min(255, Math.round(arr[i] * ratio));
              }
              return res(scaled);
            }
            return res(arr);
          }
          res(null);
        };
        req.onerror = () => res(null);
      } catch (e) {
        res(null);
      }
    });
  }

  async function readCanopyV2ParentGrid(z, x, y, targetQ = 5) {
    for (let pz = z - 1; pz >= 11; pz--) {
      const shift = z - pz;
      const px = x >> shift;
      const py = y >> shift;
      const pGrid = await readCanopyV2Grid(pz, px, py, targetQ);
      if (pGrid === null) continue;
      if (pGrid === 'ZERO') return 'ZERO';

      const TILE = 256;
      const factor = 1 << shift;
      const subX = ((x % factor) + factor) % factor;
      const subY = ((y % factor) + factor) % factor;
      const subW = TILE / factor;
      const startX = subX * subW;
      const startY = subY * subW;

      const out = new Uint8Array(TILE * TILE);
      for (let pyRow = 0; pyRow < TILE; pyRow++) {
        const srcY = Math.min(TILE - 1, Math.floor(startY + (pyRow / TILE) * subW));
        const rowOff = pyRow * TILE;
        const srcOff = srcY * TILE;
        for (let pxCol = 0; pxCol < TILE; pxCol++) {
          const srcX = Math.min(TILE - 1, Math.floor(startX + (pxCol / TILE) * subW));
          out[rowOff + pxCol] = pGrid[srcOff + srcX];
        }
      }
      return out;
    }
    return null;
  }

  function templateToRegex(tpl) {
    const escaped = tpl
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{s\\\}/g, '[^./]+')
      .replace(/\\\{(?:-?z|-?x|-?y|q|hash)\\\}/g, '[^&/]+');
    return new RegExp('^' + escaped);
  }

  // Полный список категорий для окна гибкой очистки
  function getCleanupCategories() {
    const list = [];

    // 1. Специализированные слои
    list.push(
      {
        id: 'vector-shortbread',
        name: '🛣️ Векторные тайлы OSM (Shortbread)',
        desc: 'Дороги, тропы, реки, контуры зданий, названия',
        kind: 'cache-url',
        avgKb: 35,
        match: u => u.includes('vector.openstreetmap.org/shortbread') || u.includes('tile.openstreetmap.jp/data/osm')
      },
      {
        id: 'versatiles-poi',
        name: '⛰️ Вершины и POI (VersaTiles / OpenFreeMap)',
        desc: 'Пики, перевалы, озёра, н.п. для 3D-панорамы «Пики гор»',
        kind: 'cache-url',
        avgKb: 40,
        match: u => u.includes('tiles.versatiles.org') || u.includes('tiles.openfreemap.org')
      },
      {
        id: 'dem-relief',
        name: '🏔️ Высоты рельефа (DEM Mapterhorn / AWS)',
        desc: 'Сетка высот для 3D-отмывки, горизонталей, Viewshed, 3D-среза',
        kind: 'cache-url',
        avgKb: 45,
        match: u => u.includes('tiles.mapterhorn.com') || u.includes('elevation-tiles-prod') || u.includes('nextzen.org/tilezen/elevation')
      },
      {
        id: 'esa-water-mask',
        name: '🌊 Маска воды (ESA WorldCover 10м)',
        desc: 'Контур берегов и водоёмов для 3D-отмывки рельефа',
        kind: 'cache-url',
        avgKb: 12,
        match: u => u.includes('mapproxy.terrascope.be')
      },
      {
        id: 'canopy-trees',
        name: '🌲 Карты высот деревьев (Canopy v1 / v2)',
        desc: 'Высоты крон, лесной покров и породы (2D-лес, Viewshed, 3D-срез)',
        kind: 'canopy-mixed',
        avgKb: 22,
        match: u => u.includes('forests.sylar1907942.workers.dev') || u.includes('d4e8q0lca1vlcb5n35hs') || u.includes('earthengine.googleapis.com') || u.includes('offline.canopy.v2')
      },
      {
        id: 'wikimapia-details-db',
        name: '📝 Описания и карточки Wikimapia',
        desc: 'Только тексты, теги и ссылки на фото (полигоны на карте сохранятся)',
        kind: 'wm-details',
        avgKb: 5
      },
      {
        id: 'wm-raster-contours',
        name: '🌐 Контуры Wikimapia (растр)',
        desc: 'Растровая подложка контуров Wikimapia на обзорных зумах',
        kind: 'cache-url',
        avgKb: 18,
        match: u => /^https:\/\/i\d+\.wikimapia\.org\//i.test(u)
      }
    );

    // 2. Все базовые карты из каталога приложения (каждая отдельной строкой)
    getBaseMapsList().forEach(m => {
      const regexes = m.sublayers.map(sl => templateToRegex(sl.tpl));
      list.push({
        id: 'basemap_' + m.id,
        name: (m.category === 'historical' ? '📜 ' : (m.category === 'satellite' ? '🛰️ ' : '🗺️ ')) + m.name,
        desc: 'Тайлы карты в CacheStorage',
        kind: 'cache-url',
        avgKb: m.avgKb || 20,
        match: u => regexes.some(re => re.test(u))
      });
    });

    // 3. Дополнительные провайдеры из WM.cache (если есть не вошедшие в каталог)
    if (WM.cache && typeof WM.cache.getTileProvidersDef === 'function') {
      const SKIP_EXTRA_IDS = new Set([
        'wm-contours', 'sat-esri', 'sat-clarity', 'sat-google', 'sat-bing', 'sat-yandex',
        'cyclosm', 'opentopo', 'osm-france', 'osm-hot', 'yandex-map', 'google-map',
        'nakarte-ggc', 'russia3d-hist', 'other'
      ]);
      WM.cache.getTileProvidersDef().filter(d => !SKIP_EXTRA_IDS.has(d.id)).forEach(d => {
        if (!list.some(x => x.id === d.id || x.id === 'extra_' + d.id)) {
          list.push({
            id: 'extra_' + d.id,
            name: '🗺️ ' + d.name,
            desc: 'Тайлы карты в CacheStorage',
            kind: 'cache-url',
            avgKb: d.avgKb || 20,
            match: d.match
          });
        }
      });
    }

    list.push(
      {
        id: 'other-tiles',
        name: '📦 Прочие тайлы в CacheStorage',
        desc: 'Вспомогательные и нераспознанные тайлы',
        kind: 'cache-url',
        avgKb: 20,
        match: () => true
      },
      {
        id: 'soilgrids-db',
        name: '🧪 Почвенные профили SoilGrids',
        desc: 'Офлайн-точки pH, состава и влажности для «Почвы» и «О месте»',
        kind: 'idb-soil',
        avgKb: 8
      },
      {
        id: 'wikimapia-db',
        name: '🌐 База объектов Wikimapia (полигоны и карточки)',
        desc: 'Векторные контуры и скачанные описания/комментарии в IndexedDB',
        kind: 'wm-cache',
        avgKb: 6
      }
    );

    return list;
  }


  // =========================================================================
  // 5. СЕТЕВЫЕ ПОМОЩНИКИ И ПУЛ ЗАГРУЗКИ
  // =========================================================================
  async function runPool(items, concurrency, fn, signal) {
    let idx = 0;
    const workers = [];
    const n = Math.min(concurrency, items.length);
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (idx < items.length) {
          if (signal && signal.aborted) return;
          const cur = items[idx++];
          try {
            await fn(cur, idx);
          } catch (e) {
            if (signal && signal.aborted) return;
          }
        }
      })());
    }
    await Promise.all(workers);
  }

  function sleep(ms, signal) {
    return new Promise((res, rej) => {
      if (signal && signal.aborted) return rej(new DOMException('Aborted', 'AbortError'));
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAb);
        res();
      }, ms);
      const onAb = () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); };
      if (signal) signal.addEventListener('abort', onAb, { once: true });
    });
  }

  async function fetchTileToCache(tileCache, url, { allowOpaque = false, timeoutMs = 8500, signal, storeUrl = null, checkUrls = [] } = {}) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const targetUrl = storeUrl || url;

    if (await hasCachedUrl(tileCache, targetUrl)) {
      return { status: 'cached', bytes: 0 };
    }
    for (const alt of checkUrls) {
      if (await hasCachedUrl(tileCache, alt)) {
        return { status: 'cached', bytes: 0 };
      }
    }

    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), timeoutMs);
    const onAb = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAb, { once: true });

    try {
      let resp = null;
      let corsFailed = false;
      try {
        resp = await fetch(url, { mode: 'cors', signal: ctl.signal });
      } catch (e) {
        if (ctl.signal.aborted && signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (allowOpaque && e.name === 'TypeError') corsFailed = true;
        else throw e;
      }

      if (corsFailed && allowOpaque) {
        resp = await fetch(url, { mode: 'no-cors', signal: ctl.signal });
        if (resp && resp.type === 'opaque') {
          await putCachedResponse(tileCache, targetUrl, resp);
          return { status: 'ok', opaque: true, bytes: 0 };
        }
      }

      if (!resp) throw new Error('No response');
      if (resp.status === 404 || resp.status === 204) {
        return { status: 'empty', code: resp.status, bytes: 0 };
      }
      if (!resp.ok) {
        const err = new Error('HTTP ' + resp.status);
        err.status = resp.status;
        throw err;
      }

      const buf = await resp.clone().arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return { status: 'empty', code: 204, bytes: 0 };
      }
      await putCachedResponse(tileCache, targetUrl, resp);
      return { status: 'ok', bytes: buf.byteLength };
    } finally {
      clearTimeout(tm);
      if (signal) signal.removeEventListener('abort', onAb);
    }
  }

  // =========================================================================
  // 6. ОЦЕНКА ОБЪЁМА И ПЛАНИРОВАНИЕ ЗАДАЧ
  // =========================================================================
  function buildSoilSampleGrid(bounds) {
    const areaKm2 = boundsAreaKm2(bounds);
    const cLat = (bounds.s + bounds.n) * 0.5;
    const cLon = (bounds.w + bounds.e) * 0.5;
    if (areaKm2 < 0.8) {
      return [{ lat: cLat, lon: cLon }];
    }
    const cols = areaKm2 < 6 ? 2 : (areaKm2 < 45 ? 3 : 4);
    const rows = areaKm2 < 6 ? 2 : (areaKm2 < 45 ? 3 : 4);
    const pts = [];
    for (let r = 0; r < rows; r++) {
      const lat = bounds.s + ((r + 0.5) / rows) * (bounds.n - bounds.s);
      for (let c = 0; c < cols; c++) {
        const lon = bounds.w + ((c + 0.5) / cols) * (bounds.e - bounds.w);
        pts.push({ lat, lon });
        if (pts.length >= MAX_SOIL_POINTS) return pts;
      }
    }
    return pts;
  }

  function estimatePlan(bounds, form) {
    const b = normalizeBounds(bounds);
    const areaKm2 = boundsAreaKm2(b);
    const rawMinZ = clamp(Number(form.minZoom) || 12, ABS_MIN_ZOOM, ABS_MAX_ZOOM);
    const allowedMaxZ = computeAllowedMaxZoom(b, rawMinZ);
    const minZ = Math.min(rawMinZ, allowedMaxZ);
    const maxZ = clamp(Number(form.maxZoom) || allowedMaxZ, minZ, allowedMaxZ);

    const sources = {};
    let totalItems = 0;
    let totalBytes = 0;
    let totalTileCount = 0;

    // 1. Wikimapia (чёткий потолок 100 объектов)
    if (form.wikimapia) {
      const wmZ = clamp(Math.round((WM.config && WM.config.VECTOR_ZOOM) || 15), 13, 16);
      const lod = (WM.loader && WM.loader.lodFor) ? (WM.loader.lodFor(wmZ) || { tz: wmZ }) : { tz: wmZ };
      const targetZ = lod.tz || wmZ;
      const r = tileRangeForZoom(b, targetZ);
      const boxTiles = Math.min(r.count, WM_MAX_BOX_TILES);
      const cachedObjs = (WM.cache && typeof WM.cache.queryBBox === 'function')
        ? WM.cache.queryBBox(b)
        : [];
      const needDetails = form.wmDetails
        ? Math.min(WM_MAX_OBJECTS, Math.max(cachedObjs.filter(o => !o.hasDetail).length, cachedObjs.length ? 0 : 40))
        : 0;
      const rasterContourCnt = form.wmRasterContours
        ? Math.min(countTilesInRange(b, minZ, Math.min(maxZ, 17)), MAX_TILES_PER_SOURCE)
        : 0;
      const bytes = boxTiles * 12 * 1024 + needDetails * 4 * 1024 + rasterContourCnt * 8 * 1024;
      sources.wikimapia = {
        label: 'Wikimapia',
        count: boxTiles + needDetails + rasterContourCnt,
        tiles: boxTiles,
        rasterContourCnt,
        targetZ,
        wmZ,
        cappedObjects: WM_MAX_OBJECTS,
        inCacheObjs: cachedObjs.length,
        bytes,
        note: `вектор z${targetZ}: ${boxTiles} т. + до ${WM_MAX_OBJECTS} карт.` + (rasterContourCnt ? ` + ${rasterContourCnt} растр. контуров` : '')
      };
      totalItems += sources.wikimapia.count;
      totalTileCount += rasterContourCnt;
      totalBytes += bytes;
    }

    // 2. Базовые карты
    const mapsList = getBaseMapsList();
    const selectedMapIds = new Set(form.mapIds || []);
    const mapEstimates = [];
    mapsList.forEach(m => {
      if (!selectedMapIds.has(m.id)) return;
      let cnt = 0;
      m.sublayers.forEach(sl => {
        const zLo = Math.max(minZ, sl.minZ);
        const zHi = Math.min(maxZ, sl.maxZ);
        if (zLo <= zHi) {
          cnt += countTilesInRange(b, zLo, zHi, sl.isYandex);
        }
      });
      cnt = Math.min(cnt, MAX_TILES_PER_SOURCE);
      const bytes = cnt * m.avgKb * 1024;
      mapEstimates.push({ id: m.id, name: m.name, count: cnt, bytes });
      totalItems += cnt;
      totalTileCount += cnt;
      totalBytes += bytes;
    });
    if (mapEstimates.length) {
      sources.maps = {
        items: mapEstimates,
        count: mapEstimates.reduce((s, x) => s + x.count, 0),
        bytes: mapEstimates.reduce((s, x) => s + x.bytes, 0)
      };
    }

    // 3. Векторные тайлы Shortbread OSM
    if (form.vectorOsm) {
      const zLo = clamp(Math.max(minZ, VECTOR_MIN_ZOOM), VECTOR_MIN_ZOOM, VECTOR_MAX_ZOOM);
      const zHi = clamp(Math.min(maxZ, VECTOR_MAX_ZOOM), zLo, VECTOR_MAX_ZOOM);
      const cnt = Math.min(countTilesInRange(b, zLo, zHi), MAX_TILES_PER_SOURCE);
      const bytes = cnt * 35 * 1024;
      sources.vectorOsm = { count: cnt, bytes, zLo, zHi };
      totalItems += cnt;
      totalTileCount += cnt;
      totalBytes += bytes;
    }

    // 4. VersaTiles / OpenFreeMap (POI)
    if (form.versaTiles) {
      const zLo = clamp(Math.max(minZ, VERSATILES_MIN_ZOOM), VERSATILES_MIN_ZOOM, VERSATILES_MAX_ZOOM);
      const zHi = clamp(Math.min(maxZ, VERSATILES_MAX_ZOOM), zLo, VERSATILES_MAX_ZOOM);
      const cnt = Math.min(countTilesInRange(b, zLo, zHi), 150);
      const bytes = cnt * 40 * 1024;
      sources.versaTiles = { count: cnt, bytes, zLo, zHi };
      totalItems += cnt;
      totalTileCount += cnt;
      totalBytes += bytes;
    }

    // 5. Высоты рельефа (DEM) + маска воды ESA
    if (form.dem) {
      const zHi = clamp(Math.min(maxZ, DEM_MAX_ZOOM), 6, DEM_MAX_ZOOM);
      // Гарантируем наличие обзорных зумов от z11 для Viewshed (если качается z12+)
      const zLo = clamp(Math.min(minZ, 11), 6, zHi);
      const demCnt = Math.min(countTilesInRange(b, zLo, zHi), 350);
      const esaHi = clamp(Math.min(maxZ, ESA_WATER_MAX_ZOOM), Math.min(zLo, ESA_WATER_MAX_ZOOM), ESA_WATER_MAX_ZOOM);
      const esaCnt = form.demWaterMask ? Math.min(countTilesInRange(b, Math.min(zLo, esaHi), esaHi), 250) : 0;
      const bytes = demCnt * 45 * 1024 + esaCnt * 12 * 1024;
      sources.dem = { count: demCnt + esaCnt, demCnt, esaCnt, bytes, zLo, zHi };
      totalItems += demCnt + esaCnt;
      totalTileCount += demCnt + esaCnt;
      totalBytes += bytes;
    }

    // 6. Карты высот деревьев (Canopy)
    if (form.canopy) {
      const curCanopyVer = (WM.canopy && WM.canopy.getVersion)
        ? WM.canopy.getVersion()
        : (localStorage.getItem('wm_canopy_version') || 'v1');
      const zHi = clamp(Math.min(maxZ, CANOPY_MAX_ZOOM), 11, CANOPY_MAX_ZOOM);
      // Viewshed всегда запрашивает z13 для расчёта перекрытия лесом
      const zLo = clamp(Math.min(minZ, 13), 11, zHi);
      const hCnt = Math.min(countTilesInRange(b, zLo, zHi), 350);
      const spHi = Math.min(zHi, CANOPY_SPECIES_MAX_ZOOM);
      const spLo = Math.min(zLo, spHi);
      const spCnt = form.canopySpecies ? Math.min(countTilesInRange(b, spLo, spHi), 100) : 0;
      const maskCnt = (form.canopyMask && curCanopyVer !== 'v2') ? hCnt : 0;
      const cnt = hCnt + spCnt + maskCnt;
      const bytes = cnt * 22 * 1024;
      sources.canopy = { count: cnt, hCnt, spCnt, maskCnt, bytes, zLo, zHi };
      totalItems += cnt;
      totalTileCount += cnt;
      totalBytes += bytes;
    }

    // 7. SoilGrids
    if (form.soil) {
      const pts = buildSoilSampleGrid(b);
      const bytes = pts.length * 8 * 1024;
      sources.soil = { count: pts.length, points: pts, bytes };
      totalItems += pts.length;
      totalBytes += bytes;
    }

    return {
      bounds: b,
      areaKm2,
      minZ,
      maxZ,
      allowedMaxZ,
      wasZoomClamped: Number(form.maxZoom) > allowedMaxZ,
      overTotalBudget: totalTileCount > MAX_TOTAL_TILES_HARD,
      totalTileCount,
      totalItems,
      totalBytes,
      sources
    };
  }

  // =========================================================================
  // 7. ЗАГРУЗЧИКИ ИСТОЧНИКОВ (ИЗОЛИРОВАННЫЕ, С ИНКРЕМЕНТАЛЬНОЙ ДОКАЧКОЙ)
  // =========================================================================
  async function downloadBaseMap(tileCache, bounds, mapDef, minZ, maxZ, signal, onStep, collectedUrls) {
    const res = { ok: 0, cached: 0, empty: 0, failed: 0 };
    const tasks = [];
    mapDef.sublayers.forEach((sl, slIdx) => {
      const zLo = Math.max(minZ, sl.minZ);
      const zHi = Math.min(maxZ, sl.maxZ);
      if (zLo > zHi) return;
      const coords = buildTileCoordsList(bounds, zLo, zHi, sl.isYandex, MAX_TILES_PER_SOURCE);
      coords.forEach(c => tasks.push({ c, sl, slMaxZ: sl.maxZ, slIdx }));
    });

    // Сначала обзорные зумы, при равном z — более детальный подслой (например ggc250 раньше ggc1000)
    tasks.sort((a, b) => (a.c.z - b.c.z) || (b.slMaxZ - a.slMaxZ) || (b.slIdx - a.slIdx));

    await runPool(tasks.slice(0, MAX_TILES_PER_SOURCE), 4, async ({ c, sl }) => {
      const url = formatTileTemplate(sl.tpl, c, { subdomains: sl.subdomains });
      try {
        const r = await fetchTileToCache(tileCache, url, { allowOpaque: true, signal });
        if (r.status === 'cached') { res.cached++; collectedUrls.add(url); }
        else if (r.status === 'ok') { res.ok++; collectedUrls.add(url); }
        else res.empty++;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        res.failed++;
      }
      onStep();
    }, signal);
    return res;
  }

  async function downloadVectorOsm(tileCache, bounds, zLo, zHi, signal, onStep, collectedUrls) {
    const res = { ok: 0, cached: 0, empty: 0, failed: 0 };
    const coords = buildTileCoordsList(bounds, zLo, zHi, false, MAX_TILES_PER_SOURCE);
    const primaryTpl = 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
    const backupTpl = 'https://tile.openstreetmap.jp/data/osm/{z}/{x}/{y}.mvt';

    await runPool(coords, 3, async c => {
      const url1 = formatTileTemplate(primaryTpl, c);
      const url2 = formatTileTemplate(backupTpl, c);
      try {
        const r = await fetchTileToCache(tileCache, url1, { signal, checkUrls: [url2] });
        if (r.status === 'cached') { res.cached++; collectedUrls.add(url1); }
        else if (r.status === 'ok') { res.ok++; collectedUrls.add(url1); }
        else res.empty++;
      } catch (e1) {
        if (signal && signal.aborted) throw e1;
        try {
          const r2 = await fetchTileToCache(tileCache, url2, { signal, storeUrl: url1, checkUrls: [url1] });
          if (r2.status === 'cached') { res.cached++; collectedUrls.add(url1); }
          else if (r2.status === 'ok') { res.ok++; collectedUrls.add(url1); }
          else res.empty++;
        } catch (e2) {
          if (signal && signal.aborted) throw e2;
          res.failed++;
        }
      }
      onStep();
    }, signal);
    return res;
  }

  let _ofmTplCache = null;
  async function resolveOfmTemplate(signal) {
    if (_ofmTplCache) return _ofmTplCache;
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 3500);
      const onAb = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAb, { once: true });
      try {
        const r = await fetch('https://tiles.openfreemap.org/planet', { mode: 'cors', signal: ctl.signal });
        if (r.ok) {
          const j = await r.json();
          if (j && Array.isArray(j.tiles) && j.tiles[0]) {
            _ofmTplCache = j.tiles[0];
            return _ofmTplCache;
          }
        }
      } finally {
        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAb);
      }
    } catch (e) {}
    _ofmTplCache = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
    return _ofmTplCache;
  }

  async function downloadVersaTiles(tileCache, bounds, zLo, zHi, signal, onStep, collectedUrls) {
    const res = { ok: 0, cached: 0, empty: 0, failed: 0 };
    const coords = buildTileCoordsList(bounds, zLo, zHi, false, 150);
    const vtTpl = 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}';
    const ofmTpl = await resolveOfmTemplate(signal);

    await runPool(coords, 3, async c => {
      const urlVt = formatTileTemplate(vtTpl, c);
      const urlOfm = formatTileTemplate(ofmTpl, c);
      try {
        const r = await fetchTileToCache(tileCache, urlVt, { signal, checkUrls: [urlOfm] });
        if (r.status === 'cached') { res.cached++; collectedUrls.add(urlVt); }
        else if (r.status === 'ok') { res.ok++; collectedUrls.add(urlVt); }
        else res.empty++;
      } catch (e1) {
        if (signal && signal.aborted) throw e1;
        try {
          const r2 = await fetchTileToCache(tileCache, urlOfm, { signal, storeUrl: urlVt, checkUrls: [urlVt] });
          if (r2.status === 'cached') { res.cached++; collectedUrls.add(urlVt); }
          else if (r2.status === 'ok') { res.ok++; collectedUrls.add(urlVt); }
          else res.empty++;
        } catch (e2) {
          if (signal && signal.aborted) throw e2;
          res.failed++;
        }
      }
      onStep();
    }, signal);
    return res;
  }

  async function downloadDem(tileCache, bounds, zLo, zHi, withWaterMask, signal, onStep, collectedUrls) {
    const res = { ok: 0, cached: 0, empty: 0, failed: 0 };
    const demCfg = (WM.demRelief && WM.demRelief.getConfig) ? WM.demRelief.getConfig() : { demSource: 'mapterhorn' };
    const sourcesMap = (WM.demRelief && WM.demRelief.getSources) ? WM.demRelief.getSources() : null;
    const srcKey = demCfg.demSource || 'mapterhorn';
    const urls = (sourcesMap && sourcesMap[srcKey] && sourcesMap[srcKey].urls) || [
      'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
    ];

    const coords = buildTileCoordsList(bounds, zLo, zHi, false, 350);
    await runPool(coords, 4, async c => {
      let doneTile = false;
      for (const tpl of urls) {
        if (/elevation-tiles-prod|nextzen/i.test(tpl) && c.z > 15) continue;
        const url = formatTileTemplate(tpl, c);
        try {
          const r = await fetchTileToCache(tileCache, url, { signal });
          if (r.status === 'cached') { res.cached++; collectedUrls.add(url); doneTile = true; break; }
          if (r.status === 'ok') { res.ok++; collectedUrls.add(url); doneTile = true; break; }
        } catch (e) {
          if (signal && signal.aborted) throw e;
        }
      }
      if (!doneTile) res.failed++;
      onStep();
    }, signal);

    if (withWaterMask && !(signal && signal.aborted)) {
      const esaHi = clamp(zHi, 6, ESA_WATER_MAX_ZOOM);
      const esaLo = Math.min(zLo, esaHi);
      const esaCoords = buildTileCoordsList(bounds, esaLo, esaHi, false, 250);
      const esaTpls = [
        'https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2021-v2_map/webmercator/{padZ}/{x}/{y}.png',
        'https://forests.sylar1907942.workers.dev/tiles/water/{z}/{x}/{y}',
        'https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=water&z={z}&x={x}&y={y}',
        'https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2020-v1_map/webmercator/{padZ}/{x}/{y}.png'
      ];
      await runPool(esaCoords, 3, async c => {
        const padZ = String(c.z).padStart(2, '0');
        let doneEsa = false;
        for (const tpl of esaTpls) {
          const url = tpl.replace('{z}', padZ).replace('{x}', c.x).replace('{y}', c.y);
          try {
            const r = await fetchTileToCache(tileCache, url, { signal, timeoutMs: 9500 });
            if (r.status === 'cached') { res.cached++; collectedUrls.add(url); doneEsa = true; break; }
            if (r.status === 'ok') { res.ok++; collectedUrls.add(url); doneEsa = true; break; }
            if (r.status === 'empty') { res.empty++; doneEsa = true; break; }
          } catch (e) {
            if (signal && signal.aborted) throw e;
          }
        }
        if (!doneEsa) res.failed++;
        onStep();
      }, signal);
    }

    return res;
  }

  function getCanopyV1Mirrors(type) {
    const out = [];
    try {
      const raw = localStorage.getItem('wm_gee_tokens');
      if (raw) {
        const d = JSON.parse(raw);
        if (d.templates && d.templates[type] && d.expiresAt && Date.now() < d.expiresAt) {
          out.push(d.templates[type]);
        }
      }
    } catch (e) {}
    out.push(`https://forests.sylar1907942.workers.dev/tiles/${type}/{z}/{x}/{y}`);
    out.push(`https://functions.yandexcloud.net/d4e8q0lca1vlcb5n35hs?type=${type}&z={z}&x={x}&y={y}`);
    return out;
  }

  async function downloadCanopy(tileCache, bounds, zLo, zHi, opts, signal, onStep, collectedUrls) {
    const res = { ok: 0, cached: 0, empty: 0, failed: 0 };
    const ver = (WM.canopy && WM.canopy.getVersion) ? WM.canopy.getVersion() : (localStorage.getItem('wm_canopy_version') || 'v1');
    const coords = buildTileCoordsList(bounds, zLo, zHi, false, 350);

    // Ветка v2 (Meta CHM v2 COG)
    if (ver === 'v2' && WM.canopyV2 && typeof WM.canopyV2.fetchHeightGridQ === 'function') {
      const existingKeys = await idbKeys('canopy_v2');
      const existingSet = new Set(existingKeys);
      const rawFetchV2 = WM.canopyV2._rawFetchHeightGridQ || WM.canopyV2.fetchHeightGridQ.bind(WM.canopyV2);

      await runPool(coords, 3, async c => {
        const key = `v2/height/${c.z}/${c.x}/${c.y}`;
        if (existingSet.has(key)) {
          res.cached++;
          onStep();
          return;
        }
        try {
          const grid = await rawFetchV2(c.z, c.x, c.y, 5, signal);
          if (grid === 'ZERO') {
            await idbPut('canopy_v2', { key, z: c.z, x: c.x, y: c.y, q: 5, zero: true, ts: Date.now() });
            res.empty++;
          } else if (grid instanceof Uint8Array) {
            await idbPut('canopy_v2', { key, z: c.z, x: c.x, y: c.y, q: 5, grid, ts: Date.now() });
            res.ok++;
          } else {
            res.failed++;
          }
        } catch (e) {
          if (signal && signal.aborted) throw e;
          res.failed++;
        }
        onStep();
      }, signal);
    } else {
      // Ветка v1 (height + optional mask)
      const types = ['height'];
      if (opts.canopyMask) types.push('mask');

      for (const type of types) {
        const mirrors = getCanopyV1Mirrors(type);
        const permanentUrlTpl = `https://forests.sylar1907942.workers.dev/tiles/${type}/{z}/{x}/{y}`;

        await runPool(coords, 3, async c => {
          const permUrl = formatTileTemplate(permanentUrlTpl, c);
          if (await hasCachedUrl(tileCache, permUrl)) {
            res.cached++;
            collectedUrls.add(permUrl);
            onStep();
            return;
          }
          let doneTile = false;
          for (const tpl of mirrors) {
            const url = formatTileTemplate(tpl, c);
            try {
              // Сохраняем строго по постоянному URL workers.dev (токены GEE протухают)
              const r = await fetchTileToCache(tileCache, url, { signal, storeUrl: permUrl });
              if (r.status === 'cached') { res.cached++; collectedUrls.add(permUrl); doneTile = true; break; }
              if (r.status === 'ok') { res.ok++; collectedUrls.add(permUrl); doneTile = true; break; }
              if (r.status === 'empty') { res.empty++; doneTile = true; break; }
            } catch (e) {
              if (signal && signal.aborted) throw e;
            }
          }
          if (!doneTile) res.failed++;
          onStep();
        }, signal);
      }
    }

    // Породы леса (GLC_FCS30D, макс. z12)
    if (opts.canopySpecies && !(signal && signal.aborted)) {
      const spHi = Math.min(zHi, CANOPY_SPECIES_MAX_ZOOM);
      const spLo = Math.min(zLo, spHi);
      const spCoords = buildTileCoordsList(bounds, spLo, spHi, false, 100);
      const spMirrors = getCanopyV1Mirrors('species');
      const spPermTpl = 'https://forests.sylar1907942.workers.dev/tiles/species/{z}/{x}/{y}';

      await runPool(spCoords, 2, async c => {
        const permUrl = formatTileTemplate(spPermTpl, c);
        if (await hasCachedUrl(tileCache, permUrl)) {
          res.cached++;
          collectedUrls.add(permUrl);
          onStep();
          return;
        }
        let doneSp = false;
        for (const tpl of spMirrors) {
          const url = formatTileTemplate(tpl, c);
          try {
            const r = await fetchTileToCache(tileCache, url, { signal, storeUrl: permUrl });
            if (r.status === 'cached') { res.cached++; collectedUrls.add(permUrl); doneSp = true; break; }
            if (r.status === 'ok') { res.ok++; collectedUrls.add(permUrl); doneSp = true; break; }
            if (r.status === 'empty') { res.empty++; doneSp = true; break; }
          } catch (e) {
            if (signal && signal.aborted) throw e;
          }
        }
        if (!doneSp) res.failed++;
        onStep();
      }, signal);
    }

    return res;
  }


  async function downloadSoilGrids(bounds, signal, onStep, onStatus) {
    const res = { ok: 0, cached: 0, failed: 0, note: '' };
    if (!WM.soil || typeof WM.soil.getSoilGrids !== 'function') {
      res.note = 'Модуль soil.js не подключён';
      return res;
    }

    const gridPts = buildSoilSampleGrid(bounds);
    const cachedPts = await idbAll('soil_points');
    const now = Date.now();
    let consecutiveFails = 0;

    for (let i = 0; i < gridPts.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const pt = gridPts[i];

      // Инкрементальная проверка: есть ли свежая точка ближе 450м
      const hit = cachedPts.find(cp => (now - (cp.ts || 0) < SOIL_TTL_MS) && haversineMeters(pt.lat, pt.lon, cp.lat, cp.lon) <= SOIL_CACHE_RADIUS_M);
      if (hit) {
        res.cached++;
        onStep();
        continue;
      }

      if (onStatus) onStatus(`SoilGrids: точка ${i + 1} из ${gridPts.length}…`);
      try {
        const data = await WM.soil.getSoilGrids(pt.lat, pt.lon, signal);
        if (data && !data._fromOffline) {
          const record = {
            key: `${pt.lat.toFixed(3)}_${pt.lon.toFixed(3)}`,
            lat: pt.lat,
            lon: pt.lon,
            ts: Date.now(),
            data
          };
          await idbPut('soil_points', record);
          cachedPts.push(record);
          res.ok++;
          consecutiveFails = 0;
        } else {
          res.failed++;
          consecutiveFails++;
        }
      } catch (e) {
        if (signal && signal.aborted) throw e;
        res.failed++;
        consecutiveFails++;
        if (consecutiveFails >= 2) {
          res.note = 'Сервер ISRIC SoilGrids временно недоступен — остальные точки пропущены';
          onStep(gridPts.length - i - 1);
          break;
        }
      }
      onStep();
      if (i < gridPts.length - 1) {
        await sleep(550, signal);
      }
    }
    return res;
  }

  function shrinkBoundsToMaxTiles(bounds, z, maxTiles) {
    const r = tileRangeForZoom(bounds, z);
    if (r.count <= maxTiles) return bounds;
    const cLat = (bounds.s + bounds.n) * 0.5;
    const cLon = (bounds.w + bounds.e) * 0.5;
    const scale = Math.sqrt(maxTiles / r.count) * 0.9;
    const halfH = (bounds.n - bounds.s) * 0.5 * scale;
    const halfW = (bounds.e - bounds.w) * 0.5 * scale;
    return { w: cLon - halfW, e: cLon + halfW, s: cLat - halfH, n: cLat + halfH };
  }

  async function downloadWikimapia(bounds, withDetails, withRasterContours, minZ, maxZ, signal, onStep, onStatus, collectedUrls) {
    const res = { ok: 0, cached: 0, failed: 0, capped: false, note: '' };
    if (!WM.cache || !WM.api) {
      res.note = 'Модули api/cache не подключены';
      WM.view && WM.view.render && WM.view.render();
      return res;
    }

    const wmZ = clamp(Math.round((WM.config && WM.config.VECTOR_ZOOM) || 15), 13, 16);
    const lod = (WM.loader && WM.loader.lodFor) ? (WM.loader.lodFor(wmZ) || { tz: wmZ }) : { tz: wmZ };
    const targetZ = lod.tz || wmZ;
    const safeBounds = shrinkBoundsToMaxTiles(bounds, targetZ, WM_MAX_BOX_TILES);
    const r = tileRangeForZoom(safeBounds, targetZ);

    // 0. Растровые контуры Wikimapia (для обзорных зумов)
    if (withRasterContours && collectedUrls) {
      const tileCache = await openTileCache();
      const rcCoords = buildTileCoordsList(bounds, minZ, Math.min(maxZ, 17), false, MAX_TILES_PER_SOURCE);
      const rcTpl = 'https://i{hash}.wikimapia.org/?x={x}&y={y}&zoom={z}&type=hybrid&lng=1';
      await runPool(rcCoords, 4, async c => {
        const url = formatTileTemplate(rcTpl, c);
        collectedUrls.add(url);
        try {
          const rTile = await fetchTileToCache(tileCache, url, { allowOpaque: true, signal });
          if (rTile.status === 'cached') res.cached++;
          else if (rTile.status === 'ok') res.ok++;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          res.failed++;
        }
        onStep();
      }, signal);
    }

    // 1. Векторные тайлы Wikimapia (ключ строго по targetZ = lod.tz)
    const missingTiles = [];
    const restorePromises = [];
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const key = `${targetZ}/${x}/${y}`;
        const existing = WM.cache.tiles && WM.cache.tiles.get(key);
        if (existing && existing.state === 'done') {
          res.cached++;
          if (typeof WM.cache.restoreTileObjects === 'function') {
            restorePromises.push(WM.cache.restoreTileObjects(existing));
          }
          onStep();
        } else {
          missingTiles.push({ x, y, z: targetZ, key, d: 0 });
        }
      }
    }
    if (restorePromises.length) {
      await Promise.all(restorePromises);
    }

    if (missingTiles.length > 0 && WM.geo && typeof WM.geo.tileBBox === 'function') {
      for (let i = 0; i < missingTiles.length; i++) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const t = missingTiles[i];
        if (onStatus) onStatus(`Wikimapia: контуры ${i + 1}/${missingTiles.length}…`);
        const e = WM.cache.tile(t);
        const bb = WM.geo.tileBBox(e.x, e.y, e.z);
        let tileOk = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
          try {
            const data = await WM.api.box(bb, 1, signal);
            WM.cache.addItems(e, Array.isArray(data.folder) ? data.folder : []);
            e.state = 'done';
            e.tries = 0;
            WM.cache.saveTileMeta(e);
            res.ok++;
            tileOk = true;
            break;
          } catch (err) {
            if (signal && signal.aborted) throw err;
            const waitMs = (err && err.retryAfterMs) ? err.retryAfterMs : attempt * 1500;
            if (attempt < 3) await sleep(waitMs, signal);
          }
        }
        if (!tileOk) res.failed++;
        onStep();
        if (i < missingTiles.length - 1) await sleep(350, signal);
      }
      WM.view && WM.view.render && WM.view.render();
    }
    onStep(r.count);

    if (!withDetails || (signal && signal.aborted)) return res;

    // 2. Сбор объектов внутри области и жёсткий лимит 100 штук с антибан-паузами
    const cLat = (bounds.s + bounds.n) * 0.5;
    const cLon = (bounds.w + bounds.e) * 0.5;
    const allInBox = typeof WM.cache.queryBBox === 'function' ? WM.cache.queryBBox(bounds) : [];

    const candidates = [];
    for (let i = 0; i < allInBox.length; i++) {
      const o = allInBox[i];
      if (!o || !o.bbox) continue;
      if (o.bbox.e < bounds.w || o.bbox.w > bounds.e || o.bbox.n < bounds.s || o.bbox.s > bounds.n) continue;
      if (o.hasDetail) {
        res.cached++;
        continue;
      }
      const oLat = (o.bbox.s + o.bbox.n) * 0.5;
      const oLon = (o.bbox.w + o.bbox.e) * 0.5;
      const d2 = (oLat - cLat) ** 2 + (oLon - cLon) ** 2;
      candidates.push({ o, d2 });
    }

    candidates.sort((a, b) => a.d2 - b.d2);
    if (candidates.length > WM_MAX_OBJECTS) {
      res.capped = true;
    }
    const batch = candidates.slice(0, WM_MAX_OBJECTS);
    if (!batch.length) return res;

    for (let i = 0; i < batch.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const obj = batch[i].o;

      // Проверяем уже скачанную деталь в IndexedDB перед сетью
      if (typeof WM.cache.getDetail === 'function') {
        const localDet = await WM.cache.getDetail(obj.id, 'ru');
        if (localDet) {
          WM.cache.applyDetail && WM.cache.applyDetail(obj.id, localDet);
          res.cached++;
          onStep();
          continue;
        }
      }

      // Проверка состояния пула ключей перед запросом (антибан)
      if (typeof WM.api.getPoolStatus === 'function') {
        const pool = WM.api.getPoolStatus();
        if (pool && pool.allBlocked) {
          if (pool.waitMs && pool.waitMs <= 12000) {
            if (onStatus) onStatus(`Wikimapia: пауза антибан (${Math.ceil(pool.waitMs / 1000)} с)…`);
            await sleep(pool.waitMs + 500, signal);
          } else {
            res.note = `Остановлено по лимитам API Wikimapia (скачано ${res.ok}, пропущено ${batch.length - i})`;
            break;
          }
        }
      }

      if (onStatus) onStatus(`Wikimapia: карточка ${i + 1}/${batch.length} (лимит ${WM_MAX_OBJECTS})…`);

      let success = false;
      let rateBlocked = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const detail = await WM.api.place(obj.id, 'ru');
          if (detail) {
            if (typeof WM.cache.saveDetail === 'function') WM.cache.saveDetail(obj.id, detail, 'ru');
            if (typeof WM.cache.applyDetail === 'function') WM.cache.applyDetail(obj.id, detail);
            res.ok++;
          }
          success = true;
          break;
        } catch (err) {
          if (signal && signal.aborted) throw err;
          if (err && (err.rateLimit || /429|limit|block|ban/i.test(err.message || ''))) {
            if (attempt === 0) {
              if (onStatus) onStatus('Wikimapia: ограничение скорости, пауза 5 с…');
              await sleep(5000, signal);
              continue;
            }
            rateBlocked = true;
            break;
          }
          res.failed++;
          break;
        }
      }

      onStep();
      if (rateBlocked) {
        res.note = `Достигнут лимит API на карточке ${i + 1} из ${batch.length} (защита от бана)`;
        break;
      }

      // Антибан-пауза со случайным джиттером и передышками
      if (i < batch.length - 1 && success) {
        const extra = ((i + 1) % WM_BURST_EVERY === 0) ? WM_BURST_PAUSE_MS : 0;
        if (extra && onStatus) onStatus('Wikimapia: пауза антибан 3 с…');
        await sleep(WM_MIN_DELAY_MS + Math.random() * WM_JITTER_MS + extra, signal);
      }
    }

    return res;
  }

  // =========================================================================
  // 8. ОСНОВНОЙ КОНТРОЛЛЕР ЗАГРУЗКИ И ПОВТОРНОЙ ДОКАЧКИ
  // =========================================================================
  let currentJob = null;

  async function startDownload(bounds, form, onProgress) {
    if (currentJob) {
      throw new Error('Загрузка уже выполняется');
    }

    const plan = estimatePlan(bounds, form);
    const ctl = new AbortController();
    const signal = ctl.signal;
    const collectedUrls = new Set();
    const results = {};

    let doneSteps = 0;
    const totalSteps = Math.max(1, plan.totalItems);
    const emit = (stage, statusText) => {
      if (typeof onProgress === 'function') {
        onProgress({
          stage,
          statusText,
          done: Math.min(doneSteps, totalSteps),
          total: totalSteps,
          pct: Math.min(100, Math.round((doneSteps / totalSteps) * 100)),
          results
        });
      }
    };
    const step = (n = 1) => {
      doneSteps += n;
      emit('running', currentJob ? currentJob.statusText : 'Загрузка…');
    };

    currentJob = {
      ctl,
      statusText: 'Подготовка кэша…',
      plan
    };

    syncSwNoTrim(true);
    const tileCache = await openTileCache();
    const mapsById = new Map(getBaseMapsList().map(m => [m.id, m]));

    const runSafe = async (key, title, fn) => {
      if (signal.aborted) return;
      currentJob.statusText = title;
      emit('running', title);
      try {
        results[key] = await fn();
      } catch (e) {
        if (signal.aborted) return;
        results[key] = { ok: 0, cached: 0, failed: 1, error: e.message || 'Сбой источника' };
      }
    };

    try {
      // 1. Базовые карты
      if (plan.sources.maps && plan.sources.maps.items.length) {
        for (const mi of plan.sources.maps.items) {
          if (signal.aborted) break;
          const mDef = mapsById.get(mi.id);
          if (!mDef) continue;
          await runSafe('map_' + mi.id, `Карта: ${mi.name}`, () =>
            downloadBaseMap(tileCache, plan.bounds, mDef, plan.minZ, plan.maxZ, signal, () => step(1), collectedUrls)
          );
        }
      }

      // 2. Векторные тайлы Shortbread OSM
      if (plan.sources.vectorOsm) {
        await runSafe('vectorOsm', 'Векторные тайлы OSM (Shortbread)', () =>
          downloadVectorOsm(tileCache, plan.bounds, plan.sources.vectorOsm.zLo, plan.sources.vectorOsm.zHi, signal, () => step(1), collectedUrls)
        );
      }

      // 3. DEM Рельеф + Маска воды
      if (plan.sources.dem) {
        if (WM.viewshed && typeof WM.viewshed.prefetchWeather === 'function') {
          const cLat = (plan.bounds.s + plan.bounds.n) * 0.5;
          const cLon = (plan.bounds.w + plan.bounds.e) * 0.5;
          WM.viewshed.prefetchWeather(cLat, cLon);
        }
        await runSafe('dem', 'Высоты рельефа (DEM)', () =>
          downloadDem(tileCache, plan.bounds, plan.sources.dem.zLo, plan.sources.dem.zHi, !!form.demWaterMask, signal, () => step(1), collectedUrls)
        );
      }

      // 4. Карты высот деревьев (Canopy)
      if (plan.sources.canopy) {
        await runSafe('canopy', 'Высоты деревьев (Canopy)', () =>
          downloadCanopy(tileCache, plan.bounds, plan.sources.canopy.zLo, plan.sources.canopy.zHi, form, signal, () => step(1), collectedUrls)
        );
      }

      // 5. VersaTiles / OpenFreeMap POI
      if (plan.sources.versaTiles) {
        await runSafe('versaTiles', 'VersaTiles / OpenFreeMap (POI)', () =>
          downloadVersaTiles(tileCache, plan.bounds, plan.sources.versaTiles.zLo, plan.sources.versaTiles.zHi, signal, () => step(1), collectedUrls)
        );
      }

      // 6. Почвенная сетка SoilGrids
      if (plan.sources.soil) {
        await runSafe('soil', 'Почва SoilGrids', () =>
          downloadSoilGrids(plan.bounds, signal, n => step(n || 1), txt => {
            currentJob.statusText = txt;
            emit('running', txt);
          })
        );
      }

      // 7. Wikimapia (ограничено 100 карточками + антибан)
      if (plan.sources.wikimapia) {
        await runSafe('wikimapia', 'Wikimapia (контуры и карточки)', () =>
          downloadWikimapia(
            plan.bounds,
            !!form.wmDetails,
            !!form.wmRasterContours,
            plan.minZ,
            plan.maxZ,
            signal,
            n => step(n || 1),
            txt => {
              currentJob.statusText = txt;
              emit('running', txt);
            },
            collectedUrls
          )
        );
      }
      // Сохраняем или обновляем паспорт загруженной области
      const areaId = form.existingAreaId || ('area_' + Date.now());
      const prevAreas = await idbAll('areas');
      const prev = prevAreas.find(a => a.id === areaId);
      const mergedUrls = new Set(prev && Array.isArray(prev.urls) ? prev.urls : []);
      collectedUrls.forEach(u => mergedUrls.add(u));

      const areaName = (form.areaName || '').trim() ||
        `${((plan.bounds.s + plan.bounds.n) * 0.5).toFixed(3)}, ${((plan.bounds.w + plan.bounds.e) * 0.5).toFixed(3)} (${fmtArea(plan.areaKm2)})`;

      const areaRecord = {
        id: areaId,
        name: areaName,
        bounds: plan.bounds,
        areaKm2: plan.areaKm2,
        minZ: plan.minZ,
        maxZ: plan.maxZ,
        formSnapshot: {
          wikimapia: !!form.wikimapia,
          wmDetails: !!form.wmDetails,
          wmRasterContours: !!form.wmRasterContours,
          mapIds: [...(form.mapIds || [])],
          vectorOsm: !!form.vectorOsm,
          versaTiles: !!form.versaTiles,
          dem: !!form.dem,
          demWaterMask: !!form.demWaterMask,
          canopy: !!form.canopy,
          canopyMask: !!form.canopyMask,
          canopySpecies: !!form.canopySpecies,
          soil: !!form.soil
        },
        urls: Array.from(mergedUrls),
        createdAt: prev ? prev.createdAt : Date.now(),
        updatedAt: Date.now(),
        aborted: signal.aborted,
        lastSummary: results
      };

      const hasAnyData = mergedUrls.size > 0 || Object.values(results).some(r => r && ((r.ok || 0) > 0 || (r.cached || 0) > 0));
      if (hasAnyData) {
        await idbPut('areas', areaRecord);
      }

      emit(signal.aborted ? 'aborted' : 'done', signal.aborted ? 'Остановлено (скачанное сохранено)' : 'Загрузка завершена');
      return { aborted: signal.aborted, results, area: areaRecord };
    } finally {
      currentJob = null;
    }
  }

  function stopDownload() {
    if (currentJob && currentJob.ctl) {
      currentJob.ctl.abort();
      try { WM.loader && WM.loader.stopPrecache && WM.loader.stopPrecache(); } catch (e) {}
    }
  }

  // =========================================================================
  // 9. АНАЛИЗ ПАМЯТИ И ГИБКАЯ ОЧИСТКА
  // =========================================================================
  async function getStorageStats() {
    const categories = getCleanupCategories();
    const mapStats = new Map();
    categories.forEach(c => mapStats.set(c.id, { ...c, count: 0, bytes: 0, urls: [] }));

    const tileCache = await openTileCache();
    if (tileCache) {
      try {
        const reqs = await tileCache.keys();
        for (let i = 0; i < reqs.length; i++) {
          const url = reqs[i].url;
          for (const cat of categories) {
            if (cat.kind === 'cache-url' || cat.kind === 'canopy-mixed') {
              if (cat.match(url)) {
                const st = mapStats.get(cat.id);
                st.count++;
                st.bytes += (cat.avgKb || 20) * 1024;
                st.urls.push(reqs[i]);
                break;
              }
            }
          }
        }
      } catch (e) {}
    }

    const [soilPts, canopyV2Count, areas, fbBlobs] = await Promise.all([
      idbAll('soil_points'),
      idbCount('canopy_v2'),
      idbAll('areas'),
      idbAll('fallback_blobs')
    ]);

    let wmDbCounts = { objects: 0, tiles: 0, details: 0 };
    if (WM.cache && typeof WM.cache.getDbCounts === 'function') {
      wmDbCounts = await WM.cache.getDbCounts();
    } else if (WM.cache && WM.cache.objects) {
      wmDbCounts.objects = WM.cache.objects.size;
    }

    const wmDetStat = mapStats.get('wikimapia-details-db');
    if (wmDetStat) {
      wmDetStat.count = wmDbCounts.details;
      wmDetStat.bytes = wmDbCounts.details * 5 * 1024;
    }

    const canopyStat = mapStats.get('canopy-trees');
    if (canopyStat && canopyV2Count) {
      canopyStat.count += canopyV2Count;
      canopyStat.bytes += canopyV2Count * 16 * 1024;
    }

    const soilStat = mapStats.get('soilgrids-db');
    if (soilStat) {
      soilStat.count = soilPts.length;
      soilStat.bytes = soilPts.length * 8 * 1024;
    }

    const wmStat = mapStats.get('wikimapia-db');
    if (wmStat) {
      wmStat.count = wmDbCounts.objects;
      wmStat.bytes = wmDbCounts.objects * 4 * 1024;
    }

    if (fbBlobs.length) {
      const otherStat = mapStats.get('other-tiles');
      fbBlobs.forEach(b => {
        let matched = false;
        for (const cat of categories) {
          if ((cat.kind === 'cache-url' || cat.kind === 'canopy-mixed') && cat.id !== 'other-tiles' && cat.match(b.url)) {
            const st = mapStats.get(cat.id);
            st.count++;
            st.bytes += b.size || (cat.avgKb * 1024);
            matched = true;
            break;
          }
        }
        if (!matched && otherStat) {
          otherStat.count++;
          otherStat.bytes += b.size || 20 * 1024;
        }
      });
    }

    let quota = null;
    if (navigator.storage && navigator.storage.estimate) {
      try { quota = await navigator.storage.estimate(); } catch (e) {}
    }

    const items = Array.from(mapStats.values()).filter(x => x.count > 0);
    const totalBytes = items.reduce((s, x) => s + x.bytes, 0);
    areas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return { items, totalBytes, areas, quota };
  }

  async function clearSelected(categoryIds) {
    const selected = new Set(categoryIds || []);
    if (!selected.size) return { deleted: 0 };

    const stats = await getStorageStats();
    const tileCache = await openTileCache();
    let deleted = 0;

    for (const item of stats.items) {
      if (!selected.has(item.id)) continue;

      if (item.kind === 'cache-url' || item.kind === 'canopy-mixed') {
        if (tileCache && item.urls.length) {
          for (const req of item.urls) {
            await tileCache.delete(req);
            deleted++;
          }
        }
        const fbBlobs = await idbAll('fallback_blobs');
        for (const b of fbBlobs) {
          if (item.match && item.match(b.url)) {
            await idbDel('fallback_blobs', b.url);
            deleted++;
          }
        }
        if (item.id === 'canopy-trees') {
          const v2Count = await idbCount('canopy_v2');
          deleted += v2Count;
          await idbClear('canopy_v2');
          if (WM.canopy && WM.canopy.clearDataCache) WM.canopy.clearDataCache();
          else if (WM.canopy && WM.canopy.clearCache) WM.canopy.clearCache();
        } else if (item.id === 'dem-relief' || item.id === 'esa-water-mask') {
          if (WM.demRelief && WM.demRelief.clearCache) WM.demRelief.clearCache();
        } else if (item.id === 'vector-shortbread') {
          if (WM.vectorRoads && WM.vectorRoads.clearCache) WM.vectorRoads.clearCache();
        }
      } else if (item.kind === 'idb-soil') {
        deleted += item.count;
        await idbClear('soil_points');

      } else if (item.kind === 'wm-details') {
        deleted += item.count;
        if (WM.cache && WM.cache.clearDetailsOnly) {
          await WM.cache.clearDetailsOnly();
          WM.view && WM.view.render && WM.view.render();
        }
      } else if (item.kind === 'wm-cache') {
        deleted += item.count;
        if (WM.cache) {
          if (WM.cache.clearObjects) await WM.cache.clearObjects();
          else if (WM.cache.clear) await WM.cache.clear();
          WM.loader && WM.loader.reset && WM.loader.reset();
          WM.view && WM.view.render && WM.view.render();
          WM.ui && WM.ui.updateStatusFromLoader && WM.ui.updateStatusFromLoader();
        }
      }
    }

    return { deleted };
  }

  async function deleteSavedArea(areaId, removeTiles = true) {
    const areas = await idbAll('areas');
    const target = areas.find(a => a.id === areaId);
    if (!target) return { deletedTiles: 0 };

    let deletedTiles = 0;
    if (removeTiles && Array.isArray(target.urls) && target.urls.length) {
      const sharedUrls = new Set();
      areas.forEach(a => {
        if (a.id !== areaId && Array.isArray(a.urls)) {
          a.urls.forEach(u => sharedUrls.add(u));
        }
      });

      const tileCache = await openTileCache();
      for (const url of target.urls) {
        if (sharedUrls.has(url)) continue;
        if (tileCache) {
          const ok = await tileCache.delete(url, { ignoreVary: true });
          if (ok) deletedTiles++;
        }
        await idbDel('fallback_blobs', url);
      }

      if (WM.demRelief && WM.demRelief.clearCache) WM.demRelief.clearCache();
      if (WM.canopy && WM.canopy.clearDataCache) WM.canopy.clearDataCache();
      if (WM.vectorRoads && WM.vectorRoads.clearCache) WM.vectorRoads.clearCache();
    }

    await idbDel('areas', areaId);
    return { deletedTiles };
  }


  // =========================================================================
  // 10. ОФЛАЙН-АДАПТЕР ДЛЯ SOILGRIDS И ЖИЗНЕННЫЙ ЦИКЛ
  // =========================================================================
  async function getCachedSoil(lat, lon, maxDistM = SOIL_FALLBACK_RADIUS_M) {
    const pts = await idbAll('soil_points');
    const now = Date.now();
    let best = null;
    let bestD = maxDistM;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (now - (p.ts || 0) > SOIL_TTL_MS || !p.data) continue;
      const d = haversineMeters(lat, lon, p.lat, p.lon);
      if (d <= bestD) {
        bestD = d;
        best = p.data;
      }
    }
    if (!best) return null;
    return {
      ...best,
      _fromOffline: true,
      _offlineDistM: Math.round(bestD)
    };
  }

  function normalizeCanopyUrl(url) {
    try {
      const u = new URL(url);
      const type = u.searchParams.get('type') || 'height';
      const z = u.searchParams.get('z');
      const x = u.searchParams.get('x');
      const y = u.searchParams.get('y');
      if (z && x && y) {
        return `https://forests.sylar1907942.workers.dev/tiles/${type}/${z}/${x}/${y}`;
      }
    } catch (e) {}
    return url;
  }

  function isCacheableTileUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('vector.openstreetmap.org/shortbread') ||
      url.includes('tile.openstreetmap.jp/data/osm') ||
      url.includes('tiles.versatiles.org/tiles/osm/') ||
      (url.includes('tiles.openfreemap.org/') && /\.(pbf|mvt)(\?|$)/i.test(url)) ||
      url.includes('tiles.mapterhorn.com/') ||
      url.includes('elevation-tiles-prod') ||
      url.includes('nextzen.org/tilezen/elevation') ||
      url.includes('mapproxy.terrascope.be/') ||
      url.includes('forests.sylar1907942.workers.dev/tiles/') ||
      url.includes('d4e8q0lca1vlcb5n35hs')
    );
  }

  function getDemCandidateUrls(z, x, y) {
    const dr = WM.demRelief;
    const cfg = (dr && dr.getConfig) ? dr.getConfig() : { demSource: 'mapterhorn' };
    const srcMap = (dr && dr.getSources) ? dr.getSources() : null;
    const activeKey = cfg.demSource || 'mapterhorn';
    const orderKeys = [activeKey, ...['mapterhorn', 'aws', 'nextzen'].filter(k => k !== activeKey)];
    const out = [];
    const seen = new Set();

    orderKeys.forEach(k => {
      const urls = (srcMap && srcMap[k] && srcMap[k].urls) || (
        k === 'mapterhorn' ? ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'] :
        k === 'aws' ? ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'] :
        k === 'nextzen' ? ['https://tile.nextzen.org/tilezen/terrain/v1/256/terrarium/{z}/{x}/{y}.png'] : []
      );
      urls.forEach(tpl => {
        if (/elevation-tiles-prod|nextzen/i.test(tpl) && z > 15) return;
        const url = formatTileTemplate(tpl, { z, x, y });
        if (!seen.has(url)) {
          seen.add(url);
          const prov = /mapterhorn/i.test(url) ? 'mapterhorn'
            : (/elevation-tiles-prod/i.test(url) ? 'aws'
            : (/nextzen/i.test(url) ? 'nextzen' : k));
          out.push({ url, prov });
        }
      });
    });
    return out;
  }

  function loadDemImageFromBlobUrl(blobUrl, prov) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(blobUrl);
        img._demProvider = prov;
        res(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        rej(new Error('DEM blob decode error'));
      };
      img.src = blobUrl;
    });
  }

  async function loadDemFromParentCache(z, x, y) {
    for (let pz = z - 1; pz >= Math.max(5, z - 4); pz--) {
      const shift = z - pz;
      const factor = 1 << shift;
      const px = x >> shift;
      const py = y >> shift;
      const cands = getDemCandidateUrls(pz, px, py);
      for (const c of cands) {
        const hit = await readCachedTileBlobUrl(c.url);
        if (!hit) continue;
        try {
          const pImg = await loadDemImageFromBlobUrl(hit.blobUrl, c.prov);
          const s = pImg.naturalWidth || pImg.width || 256;
          const subX = ((x % factor) + factor) % factor;
          const subY = ((y % factor) + factor) % factor;
          const sw = s / factor;
          const cv = document.createElement('canvas');
          cv.width = s;
          cv.height = s;
          const ctx = cv.getContext('2d');
          ctx.imageSmoothingEnabled = false; // Важно: не интерполировать RGB-кодировку Terrarium!
          ctx.drawImage(pImg, subX * sw, subY * sw, sw, sw, 0, 0, s, s);
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          if (blob) {
            const outImg = await loadDemImageFromBlobUrl(URL.createObjectURL(blob), c.prov);
            outImg._degraded = true;
            return outImg;
          }
        } catch (e) {}
      }
    }
    return null;
  }

  function patchIntegrations() {
    // 0. Cache-first перехватчик fetch для тайлов (Shortbread MVT, DEM, VersaTiles, Canopy)
    // Позволяет 2D-карте и PeakView обмениваться кэшем даже без Service Worker (например, в APK)
    if (!window._wmOaFetchPatched && typeof window.fetch === 'function') {
      const origFetch = window.fetch.bind(window);
      window._wmOaFetchPatched = true;
      window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const cacheMode = (init && init.cache) || '';

        if (method !== 'GET' || cacheMode === 'no-store' || !isCacheableTileUrl(url)) {
          return origFetch(input, init);
        }
        if (init && init.signal && init.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const normUrl = url.includes('d4e8q0lca1vlcb5n35hs') ? normalizeCanopyUrl(url) : url;
        if (cacheMode !== 'reload') {
          const hit = (await readCachedResponse(url, false)) || (normUrl !== url ? await readCachedResponse(normUrl, false) : null);
          if (hit) return hit;
        }
        const netResp = await origFetch(input, init);
        if (netResp && netResp.ok && netResp.type !== 'opaque') {
          const clone = netResp.clone();
          openTileCache().then(tc => {
            if (tc) tc.put(normUrl, clone).catch(() => {});
          }).catch(() => {});
        }
        return netResp;
      };
    }

    // 1. Офлайн-фолбэк для SoilGrids
    if (WM.soil && typeof WM.soil.getSoilGrids === 'function' && !WM.soil._oaPatched) {
      const origGetSoil = WM.soil.getSoilGrids;
      WM.soil._oaPatched = true;
      WM.soil.getSoilGrids = async function (lat, lon, signal) {
        const findNearest = async () =>
          (await getCachedSoil(lat, lon, 700)) ||
          (await getCachedSoil(lat, lon, 3000)) ||
          (await getCachedSoil(lat, lon, SOIL_FALLBACK_RADIUS_M));

        if (!navigator.onLine) {
          const cached = await findNearest();
          if (cached) return cached;
        }
        try {
          return await origGetSoil(lat, lon, signal);
        } catch (err) {
          const cached = await findNearest();
          if (cached) return cached;
          throw err;
        }
      };
    }

    // 2. Cache-first для карточек Wikimapia (WM.api.place)
    if (WM.api && typeof WM.api.place === 'function' && !WM.api._oaPlacePatched) {
      const origPlace = WM.api.place.bind(WM.api);
      WM.api._oaPlacePatched = true;
      WM.api.place = async function (id, lang = 'ru', ...rest) {
        if (WM.cache && typeof WM.cache.getDetail === 'function') {
          try {
            const cached = await WM.cache.getDetail(id, lang);
            if (cached) {
              const numId = +id;
              const existingObj = WM.cache.objects && (WM.cache.objects.get(numId) || WM.cache.objects.get(id));
              if (WM.cache.applyDetail && (!existingObj || !existingObj.hasDetail)) {
                WM.cache.applyDetail(existingObj ? existingObj.id : numId, cached);
              }
              return cached;
            }
          } catch (e) {}
        }
        return origPlace(id, lang, ...rest);
      };
    }

    // 3. Cache-first + родительский кроп для Canopy v2
    if (WM.canopyV2 && typeof WM.canopyV2.fetchHeightGridQ === 'function' && !WM.canopyV2._oaPatched) {
      const origFetchV2 = WM.canopyV2.fetchHeightGridQ.bind(WM.canopyV2);
      WM.canopyV2._rawFetchHeightGridQ = origFetchV2;
      WM.canopyV2._oaPatched = true;
      WM.canopyV2.fetchHeightGridQ = async function (z, x, y, q = 5, signal) {
        const cached = await readCanopyV2Grid(z, x, y, q);
        if (cached !== null) return cached;
        if (!navigator.onLine) {
          const parentCached = await readCanopyV2ParentGrid(z, x, y, q);
          if (parentCached !== null) return parentCached;
        }
        try {
          const netRes = await origFetchV2(z, x, y, q, signal);
          if (netRes !== null) return netRes;
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
        }
        return await readCanopyV2ParentGrid(z, x, y, q);
      };
    }

    // 4. Cache-first + родительский кроп для DEM рельефа (и для 2D-отмывки, и для PeakView)
    if (WM.demRelief && typeof WM.demRelief.loadDemTileWithFallback === 'function' && !WM.demRelief._oaPatched) {
      const origLoadDem = WM.demRelief.loadDemTileWithFallback.bind(WM.demRelief);
      WM.demRelief._oaPatched = true;
      WM.demRelief.loadDemTileWithFallback = async function (coords, ...rest) {
        const drCfg = (WM.demRelief && WM.demRelief.getConfig) ? WM.demRelief.getConfig() : {};
        const activeKey = drCfg.demSource || 'mapterhorn';
        const isOffline = navigator.onLine === false;
        const forceBypass = !!(WM.demRelief && WM.demRelief._isForceBypass && WM.demRelief._isForceBypass());

        if (coords && coords.z != null && coords.x != null && coords.y != null && !(forceBypass && !isOffline)) {
          const cands = getDemCandidateUrls(coords.z, coords.x, coords.y);
          for (const c of cands) {
            // Онлайн не подменяем выбранный источник случайно закэшированным резервным провайдером
            if (!isOffline && c.prov !== activeKey) continue;
            const hit = await readCachedTileBlobUrl(c.url);
            if (hit) {
              try {
                return await loadDemImageFromBlobUrl(hit.blobUrl, c.prov);
              } catch (e) {}
            }
          }
        }

        let netImg = null;
        let netErr = null;
        if (navigator.onLine !== false) {
          try {
            netImg = await origLoadDem(coords, ...rest);
            if (netImg && !netImg._isEmptyFallback && netImg._demProvider !== 'empty') {
              return netImg;
            }
          } catch (e) {
            netErr = e;
          }
        }

        if (coords && coords.z != null && coords.x != null && coords.y != null) {
          const parentImg = await loadDemFromParentCache(coords.z, coords.x, coords.y);
          if (parentImg) return parentImg;
        }

        if (netImg) return netImg;
        if (netErr) throw netErr;
        throw new Error('тайл DEM недоступен офлайн');
      };
    }
  }
  // =========================================================================
  // 11. ПОЛЬЗОВАТЕЛЬСКИЙ ИНТЕРФЕЙС (MODAL)
  // =========================================================================
  function ensureStyles() {
    if ($('wm-oa-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-oa-style';
    st.textContent = `
.oa-box{max-width:560px;width:96%;max-height:90vh;display:flex;flex-direction:column}
.oa-tabs{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--bg-secondary)}
.oa-tab{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-primary);color:var(--text-main);font-size:12.5px;font-weight:600;cursor:pointer;transition:.15s}
.oa-tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.oa-body{padding:12px 14px;overflow-y:auto;flex:1}
.oa-zone-card{border:1px solid var(--border);border-radius:10px;padding:9px 11px;background:var(--bg-secondary);margin-bottom:10px;font-size:12px}
.oa-zone-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.oa-stat{background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:5px 7px}
.oa-stat small{display:block;font-size:10px;color:var(--text-muted)}
.oa-stat b{font-size:12.5px;color:var(--text-main)}
.oa-warn{margin-top:7px;padding:6px 9px;border-radius:8px;font-size:11.5px;background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.45);color:#d97706}
[data-theme="dark"] .oa-warn{color:#fbbf24}
.oa-zoom-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.oa-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.oa-field select,.oa-field input[type="text"]{background:var(--bg-primary);color:var(--text-main);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12.5px;outline:none}
.oa-card{border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--bg-primary)}
.oa-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.oa-card-title{font-weight:700;font-size:13px;color:var(--text-main)}
.oa-card-est{font-size:11px;font-weight:700;color:var(--accent);white-space:nowrap}
.oa-card-desc{font-size:11.5px;line-height:1.4;color:var(--text-muted);margin:4px 0 0}
.oa-sub{margin:7px 0 2px 10px;padding-left:10px;border-left:2px solid var(--border)}
.oa-sub.disabled{opacity:.45;pointer-events:none}
.oa-maps-list{max-height:200px;overflow-y:auto;margin-top:6px;border:1px solid var(--border);border-radius:8px;padding:4px 8px;background:var(--bg-secondary)}
.oa-maps-toolbar{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.oa-btn-xs{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-main);cursor:pointer}
.oa-btn-xs:hover{border-color:var(--accent)}
.oa-total-bar{position:sticky;bottom:0;background:var(--bg-secondary);border-top:1px solid var(--border);padding:8px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}
.oa-prog-box{border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px;background:var(--bg-secondary)}
.oa-prog-track{height:9px;border-radius:6px;background:var(--bg-primary);border:1px solid var(--border);overflow:hidden;margin:6px 0}
.oa-prog-fill{height:100%;width:0%;background:var(--accent);transition:width .2s}
.oa-res-list{display:flex;flex-direction:column;gap:4px;font-size:11.5px;margin-top:6px}
.oa-res-row{display:flex;justify-content:space-between;gap:8px;padding:3px 6px;border-radius:6px;background:var(--bg-primary)}
.oa-area-item{border:1px solid var(--border);border-radius:9px;padding:8px 10px;margin-bottom:7px;background:var(--bg-primary);font-size:12px}
.oa-area-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
`;
    document.head.appendChild(st);
  }

  function loadSavedPrefs() {
    const def = {
      wikimapia: true,
      wmDetails: true,
      mapIds: [],
      vectorOsm: true,
      versaTiles: false,
      dem: true,
      wmRasterContours: true,
      demWaterMask: true,
      canopy: true,
      canopyMask: false,
      canopySpecies: false,
      soil: false
    };
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_LS_KEY) || 'null');
      if (saved && typeof saved === 'object') return { ...def, ...saved };
    } catch (e) {}
    const curActive = getBaseMapsList().find(m => m.isActive);
    if (curActive) def.mapIds = [curActive.id];
    return def;
  }

  function savePrefs(form) {
    try {
      localStorage.setItem(PREFS_LS_KEY, JSON.stringify({
        wikimapia: !!form.wikimapia,
        wmDetails: !!form.wmDetails,
        wmRasterContours: !!form.wmRasterContours,
        mapIds: [...(form.mapIds || [])],
        vectorOsm: !!form.vectorOsm,
        versaTiles: !!form.versaTiles,
        dem: !!form.dem,
        demWaterMask: !!form.demWaterMask,
        canopy: !!form.canopy,
        canopyMask: !!form.canopyMask,
        canopySpecies: !!form.canopySpecies,
        soil: !!form.soil
      }));
    } catch (e) {}
  }

  let modalEl = null;
  let activeTab = 'download';
  let activeBounds = null;
  let activeCurZoom = 14;
  let formState = null;
  let isDownloading = false;
  let uiDownloadToken = 0; 

  function ensureModalDom() {
    if (modalEl) return modalEl;
    ensureStyles();
    const div = document.createElement('div');
    div.id = 'wm-oa-modal';
    div.className = 'modal-overlay';
    div.innerHTML = `
      <div class="modal-box oa-box">
        <div class="modal-header">
          <h3 style="margin:0;font-size:15px;">📥 Офлайн-область и память</h3>
          <button type="button" class="icon-btn" id="wm-oa-close-x" title="Закрыть">✕</button>
        </div>
        <div class="oa-tabs">
          <button type="button" class="oa-tab active" data-oa-tab="download">📥 Скачать область</button>
          <button type="button" class="oa-tab" data-oa-tab="clean">🗑️ Память и очистка</button>
        </div>
        <div class="oa-body" id="wm-oa-body"></div>
        <div class="oa-total-bar" id="wm-oa-total-bar" hidden></div>
        <div class="modal-footer" id="wm-oa-footer"></div>
      </div>
    `;
    document.body.appendChild(div);
    modalEl = div;

    div.addEventListener('click', e => {
      if (e.target === div && !isDownloading) close();
    });
    div.querySelector('#wm-oa-close-x').onclick = () => close();
    div.querySelectorAll('.oa-tab').forEach(btn => {
      btn.onclick = () => {
        if (isDownloading) return;
        activeTab = btn.dataset.oaTab;
        renderModal();
      };
    });
    return div;
  }

  function renderModal() {
    if (!modalEl) return;
    modalEl.querySelectorAll('.oa-tab').forEach(b => b.classList.toggle('active', b.dataset.oaTab === activeTab));
    if (activeTab === 'download') renderDownloadTab();
    else renderCleanupTab();
  }

  function renderDownloadTab() {
    const body = $('wm-oa-body');
    const bar = $('wm-oa-total-bar');
    const foot = $('wm-oa-footer');
    if (!body || !bar || !foot) return;

    const prevScrollTop = body.scrollTop;
    const mapsList = getBaseMapsList();
    const plan = estimatePlan(activeBounds, formState);
    formState.minZoom = plan.minZ;
    formState.maxZoom = plan.maxZ;
    const est = plan.sources;

    const minOptions = [];
    for (let z = ABS_MIN_ZOOM; z <= plan.allowedMaxZ; z++) {
      minOptions.push(`<option value="${z}" ${z === plan.minZ ? 'selected' : ''}>z${z}${z === activeCurZoom ? ' (текущий)' : ''}</option>`);
    }
    const maxOptions = [];
    for (let z = plan.minZ; z <= plan.allowedMaxZ; z++) {
      maxOptions.push(`<option value="${z}" ${z === plan.maxZ ? 'selected' : ''}>z${z}</option>`);
    }

    const activeMapsHtml = mapsList.map(m => {
      const checked = formState.mapIds.includes(m.id);
      const mEst = est.maps?.items.find(x => x.id === m.id);
      const badge = mEst ? `${mEst.count} т. · ~${fmtBytes(mEst.bytes)}` : (m.isActive ? 'активная' : '');
      return `
        <label class="toggle-item" style="padding:4px 0;">
          <span style="font-size:12px;">
            ${m.isActive ? '⭐ ' : ''}${esc(m.name)}
            ${badge ? `<small style="color:var(--accent);margin-left:4px;">(${esc(badge)})</small>` : ''}
          </span>
          <input type="checkbox" class="oa-map-chk" data-map-id="${esc(m.id)}" ${checked ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>`;
    }).join('');

    const curCanopyVer = (WM.canopy && WM.canopy.getVersion) ? WM.canopy.getVersion() : 'v1';

    body.innerHTML = `
      <div class="oa-zone-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b>📐 Выбранная область экрана</b>
          <span style="font-family:monospace;font-size:11px;color:var(--text-muted);">
            ${((plan.bounds.s + plan.bounds.n) * 0.5).toFixed(4)}, ${((plan.bounds.w + plan.bounds.e) * 0.5).toFixed(4)}
          </span>
        </div>
        <div class="oa-zone-grid">
          <div class="oa-stat"><small>Площадь</small><b>${fmtArea(plan.areaKm2)}</b></div>
          <div class="oa-stat"><small>Текущий зум</small><b>z${activeCurZoom}</b></div>
          <div class="oa-stat"><small>Макс. допуск</small><b>z${plan.allowedMaxZ} / 18</b></div>
        </div>
        ${plan.allowedMaxZ < ABS_MAX_ZOOM ? `
          <div class="oa-warn">
            ⚠️ Область слишком велика для z${ABS_MAX_ZOOM} — потолок ограничен до <b>z${plan.allowedMaxZ}</b> (лимит ${MAX_TILES_PER_SOURCE} тайлов на слой). Приблизьте карту для более крупных зумов.
          </div>` : ''}
        ${plan.overTotalBudget ? `
          <div class="oa-warn">
            ⚠️ Выбрано очень много тайлов (${plan.totalTileCount}). Рекомендуется уменьшить число карт или верхний зум.
          </div>` : ''}
      </div>

      <div class="oa-card">
        <div class="oa-zoom-row">
          <div class="oa-field">
            <label for="wm-oa-minz">Мин. зум (от)</label>
            <select id="wm-oa-minz" ${isDownloading ? 'disabled' : ''}>${minOptions.join('')}</select>
          </div>
          <div class="oa-field">
            <label for="wm-oa-maxz">Макс. зум (до 18)</label>
            <select id="wm-oa-maxz" ${isDownloading ? 'disabled' : ''}>${maxOptions.join('')}</select>
          </div>
        </div>
        <div class="oa-field">
          <label for="wm-oa-name">Название зоны (для списка сохранённых и докачки)</label>
          <input type="text" id="wm-oa-name" placeholder="Например: Сосновый бор у озера" value="${esc(formState.areaName || '')}" ${isDownloading ? 'disabled' : ''}>
        </div>
      </div>

      <div id="wm-oa-prog-wrap" class="oa-prog-box" ${isDownloading ? '' : 'hidden'}>
        <div style="display:flex;justify-content:space-between;font-size:12px;">
          <b id="wm-oa-prog-status">Подготовка…</b>
          <b id="wm-oa-prog-pct">0%</b>
        </div>
        <div class="oa-prog-track"><div class="oa-prog-fill" id="wm-oa-prog-bar"></div></div>
        <div class="oa-res-list" id="wm-oa-res-list"></div>
      </div>

      <!-- 1. Базовые карты -->
      <div class="oa-card">
        <div class="oa-card-head">
          <span class="oa-card-title">🗺️ Базовые карты (${formState.mapIds.length} выбрано)</span>
          <span class="oa-card-est">${est.maps ? `${est.maps.count} т. · ~${fmtBytes(est.maps.bytes)}` : '0 т.'}</span>
        </div>
        <div class="oa-maps-toolbar">
          <button type="button" class="oa-btn-xs" id="wm-oa-maps-active" ${isDownloading ? 'disabled' : ''}>Только активная</button>
          <button type="button" class="oa-btn-xs" id="wm-oa-maps-enabled" ${isDownloading ? 'disabled' : ''}>Все включённые</button>
          <button type="button" class="oa-btn-xs" id="wm-oa-maps-none" ${isDownloading ? 'disabled' : ''}>Снять все</button>
        </div>
        <div class="oa-maps-list">${activeMapsHtml || '<div class="oa-card-desc">Нет доступных карт в каталоге</div>'}</div>
      </div>

      <!-- 2. Векторные тайлы OSM -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">🛣️ Векторные тайлы OSM (Shortbread)</div>
            <div class="oa-card-est">${est.vectorOsm ? `z${est.vectorOsm.zLo}–z${est.vectorOsm.zHi}: ${est.vectorOsm.count} т. · ~${fmtBytes(est.vectorOsm.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-vector" ${formState.vectorOsm ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">
          <b>Что это и где используется:</b> дороги, тропы, просеки, реки, озёра, болота, 3D-постройки и подписи OpenStreetMap. Работают на <b>2D-карте</b> (до z20), для автоматической расчистки просек в <b>«2D Лесу»</b>, а также в <b>«3D-срезе»</b> и <b>«Пиках гор»</b>.
        </p>
      </div>

      <!-- 3. Высоты рельефа DEM -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">🏔️ Высоты рельефа (DEM)</div>
            <div class="oa-card-est">${est.dem ? `z${est.dem.zLo}–z${est.dem.zHi}: ${est.dem.count} т. · ~${fmtBytes(est.dem.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-dem" ${formState.dem ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">Сетка высот для WebGL 3D-отмывки, горизонталей, зоны видимости (Viewshed), 3D-среза и панорамы «Пики гор» (качается до z${DEM_MAX_ZOOM} с автокропом выше).</p>
        <div class="oa-sub ${formState.dem ? '' : 'disabled'}">
          <label class="toggle-item" style="margin:0;">
            <span style="font-size:12px;">🌊 Маска воды ESA WorldCover 10м (до z${ESA_WATER_MAX_ZOOM})</span>
            <input type="checkbox" id="wm-oa-chk-dem-water" ${formState.demWaterMask ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
            <span class="toggle-switch"></span>
          </label>
        </div>
      </div>

      <!-- 4. Карты высот деревьев -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">🌲 Карты высот деревьев (Canopy ${esc(curCanopyVer)})</div>
            <div class="oa-card-est">${est.canopy ? `z${est.canopy.zLo}–z${est.canopy.zHi}: ${est.canopy.count} т. · ~${fmtBytes(est.canopy.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-canopy" ${formState.canopy ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">Высота лесных крон: используется для 2D гравюрного леса, расчёта перекрытия обзора в Viewshed и лесного покрова в 3D («Пики гор», «3D-срез»).</p>
        <div class="oa-sub ${formState.canopy ? '' : 'disabled'}">
          <label class="toggle-item" style="margin:0;${curCanopyVer === 'v2' ? 'opacity:.45;pointer-events:none;' : ''}">
            <span style="font-size:12px;">Маска лесного покрова ≥1м (${curCanopyVer === 'v2' ? 'встроена в v2' : 'подложка v1'})</span>
            <input type="checkbox" id="wm-oa-chk-canopy-mask" ${formState.canopyMask && curCanopyVer !== 'v2' ? 'checked' : ''} ${(isDownloading || curCanopyVer === 'v2') ? 'disabled' : ''}>
            <span class="toggle-switch"></span>
          </label>
          <label class="toggle-item" style="margin:0;">
            <span style="font-size:12px;">Породы леса GLC_FCS30D (хвойный/лиственный, до z${CANOPY_SPECIES_MAX_ZOOM})</span>
            <input type="checkbox" id="wm-oa-chk-canopy-species" ${formState.canopySpecies ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
            <span class="toggle-switch"></span>
          </label>
        </div>
      </div>

      <!-- 5. VersaTiles / OpenFreeMap -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">⛰️ Данные VersaTiles / OpenFreeMap</div>
            <div class="oa-card-est">${est.versaTiles ? `z${est.versaTiles.zLo}–z${est.versaTiles.zHi}: ${est.versaTiles.count} т. · ~${fmtBytes(est.versaTiles.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-versa" ${formState.versaTiles ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">Векторные тайлы с точками горных вершин, перевалов, урочищ, озёр, смотровых и населённых пунктов (до z${VERSATILES_MAX_ZOOM}, макс. 150 тайлов) для 3D-панорамы «Пики гор».</p>
      </div>

      <!-- 6. Wikimapia (лимит 100 объектов + антибан) -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">🌐 Wikimapia (макс. ${WM_MAX_OBJECTS} объектов)</div>
            <div class="oa-card-est">${est.wikimapia ? esc(est.wikimapia.note) + ` · ~${fmtBytes(est.wikimapia.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-wm" ${formState.wikimapia ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">Скачивает контуры полигонов (в пределах ${WM_MAX_BOX_TILES} центр. тайлов) и не более <b>${WM_MAX_OBJECTS} новых карточек</b> с антибан-паузами (~1.2–1.8 с/запрос). Уже сохранённые объекты пропускаются.</p>
        <div class="oa-sub ${formState.wikimapia ? '' : 'disabled'}">
          <label class="toggle-item" style="margin:0;">
            <span style="font-size:12px;">Скачивать подробные карточки (описания, теги, комментарии)</span>
            <input type="checkbox" id="wm-oa-chk-wm-details" ${formState.wmDetails ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
            <span class="toggle-switch"></span>
          </label>
          <label class="toggle-item" style="margin:0;">
            <span style="font-size:12px;">Растровые контуры Wikimapia (обзорные зумы)</span>
            <input type="checkbox" id="wm-oa-chk-wm-raster" ${formState.wmRasterContours ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
            <span class="toggle-switch"></span>
          </label>
        </div>
      </div>

      <!-- 7. Почва SoilGrids -->
      <div class="oa-card">
        <label class="toggle-item" style="margin:0;">
          <div>
            <div class="oa-card-title">🧪 Данные почвы SoilGrids (ISRIC)</div>
            <div class="oa-card-est">${est.soil ? `сетка ${est.soil.count} тчк · ~${fmtBytes(est.soil.bytes)}` : 'выкл'}</div>
          </div>
          <input type="checkbox" id="wm-oa-chk-soil" ${formState.soil ? 'checked' : ''} ${isDownloading ? 'disabled' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p class="oa-card-desc">Сетка до ${MAX_SOIL_POINTS} опорных точек (pH, песок/ил/глина, гумус, азот, плотность) для работы модулей «Почва и биотоп» и «О месте» без интернета.</p>
      </div>
    `;

    const hasAnything = plan.totalItems > 0;
    bar.hidden = false;
    bar.innerHTML = `
      <div>
        <div style="font-weight:700;color:var(--text-main);">Итого: ~${fmtBytes(plan.totalBytes)}</div>
        <div style="font-size:11px;color:var(--text-muted);">Элементов к проверке/докачке: ${plan.totalItems}</div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);text-align:right;">Существующее в памяти<br>автоматически пропускается</div>
    `;

    foot.innerHTML = isDownloading
      ? `<button type="button" class="btn btn-danger" id="wm-oa-btn-stop" style="flex:1;">⏹ Остановить (сохранить скачанное)</button>`
      : `<button type="button" class="btn btn-secondary" id="wm-oa-btn-cancel">Закрыть</button>
         <button type="button" class="btn btn-primary" id="wm-oa-btn-start" ${hasAnything ? '' : 'disabled'}>📥 Скачать выбранное</button>`;

    bindDownloadEvents(mapsList, plan);
    body.scrollTop = prevScrollTop;
  }

  function bindDownloadEvents(mapsList, plan) {
    const syncAndRender = () => {
      savePrefs(formState);
      renderDownloadTab();
    };


    $('wm-oa-minz')?.addEventListener('change', e => {
      formState.minZoom = parseInt(e.target.value, 10);
      if (formState.maxZoom < formState.minZoom) formState.maxZoom = formState.minZoom;
      syncAndRender();
    });
    $('wm-oa-maxz')?.addEventListener('change', e => {
      formState.maxZoom = parseInt(e.target.value, 10);
      syncAndRender();
    });
    $('wm-oa-name')?.addEventListener('input', e => {
      formState.areaName = e.target.value;
    });

    document.querySelectorAll('.oa-map-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        const id = chk.dataset.mapId;
        const set = new Set(formState.mapIds || []);
        if (chk.checked) set.add(id); else set.delete(id);
        formState.mapIds = Array.from(set);
        syncAndRender();
      });
    });

    $('wm-oa-maps-active')?.addEventListener('click', () => {
      const act = mapsList.find(m => m.isActive);
      formState.mapIds = act ? [act.id] : [];
      syncAndRender();
    });
    $('wm-oa-maps-enabled')?.addEventListener('click', () => {
      formState.mapIds = mapsList.filter(m => m.isEnabledInMenu).map(m => m.id);
      syncAndRender();
    });
    $('wm-oa-maps-none')?.addEventListener('click', () => {
      formState.mapIds = [];
      syncAndRender();
    });

    const bindChk = (id, key) => {
      $(id)?.addEventListener('change', e => {
        formState[key] = e.target.checked;
        syncAndRender();
      });
    };
    bindChk('wm-oa-chk-vector', 'vectorOsm');
    bindChk('wm-oa-chk-dem', 'dem');
    bindChk('wm-oa-chk-dem-water', 'demWaterMask');
    bindChk('wm-oa-chk-canopy', 'canopy');
    bindChk('wm-oa-chk-canopy-mask', 'canopyMask');
    bindChk('wm-oa-chk-canopy-species', 'canopySpecies');
    bindChk('wm-oa-chk-versa', 'versaTiles');
    bindChk('wm-oa-chk-wm', 'wikimapia');
    bindChk('wm-oa-chk-wm-details', 'wmDetails');
    bindChk('wm-oa-chk-wm-raster', 'wmRasterContours');
    bindChk('wm-oa-chk-soil', 'soil');

    $('wm-oa-btn-cancel')?.addEventListener('click', () => close());
    $('wm-oa-btn-stop')?.addEventListener('click', () => {
      stopDownload();
      toast('⏹ Остановка… сохраняем уже скачанное');
    });

    $('wm-oa-btn-start')?.addEventListener('click', async () => {
      if (isDownloading || currentJob) return;
      const myToken = ++uiDownloadToken;
      isDownloading = true;
      renderDownloadTab();

      const labelMap = {
        vectorOsm: '🛣️ Вектор OSM',
        dem: '🏔️ Рельеф DEM',
        canopy: '🌲 Деревья',
        versaTiles: '⛰️ VersaTiles',
        soil: '🧪 SoilGrids',
        wikimapia: '🌐 Wikimapia'
      };

      const renderResults = results => {
        const resListEl = $('wm-oa-res-list');
        if (!resListEl || !results) return;
        resListEl.innerHTML = Object.entries(results).map(([k, r]) => {
          const title = k.startsWith('map_')
            ? ('🗺️ ' + (mapsList.find(m => 'map_' + m.id === k)?.name || k))
            : (labelMap[k] || k);
          const parts = [];
          if (r.ok) parts.push(`+${r.ok} скачано`);
          if (r.cached) parts.push(`${r.cached} уже в памяти`);
          if (r.empty) parts.push(`${r.empty} пустых`);
          if (r.failed) parts.push(`⚠ ${r.failed} сбоев`);
          if (r.note) parts.push(r.note);
          if (r.error) parts.push(`❌ ${r.error}`);
          return `<div class="oa-res-row"><span>${esc(title)}</span><b>${esc(parts.join(' · ') || 'готово')}</b></div>`;
        }).join('');
      };

      try {
        const out = await startDownload(activeBounds, formState, prog => {
          if (myToken !== uiDownloadToken) return;
          const progStat = $('wm-oa-prog-status');
          const progPct = $('wm-oa-prog-pct');
          const progBar = $('wm-oa-prog-bar');
          if (progStat) progStat.textContent = prog.statusText || 'Загрузка…';
          if (progPct) progPct.textContent = `${prog.pct}% (${prog.done}/${prog.total})`;
          if (progBar) progBar.style.width = `${prog.pct}%`;
          renderResults(prog.results);
        });
        if (myToken !== uiDownloadToken) return;
        isDownloading = false;
        renderDownloadTab();
        const pw = $('wm-oa-prog-wrap');
        if (pw) pw.hidden = false;
        const ps = $('wm-oa-prog-status');
        const pp = $('wm-oa-prog-pct');
        const pb = $('wm-oa-prog-bar');
        if (ps) ps.textContent = out.aborted ? '⏹ Загрузка остановлена (сохранено)' : '✅ Область готова к работе офлайн';
        if (pp) pp.textContent = '100%';
        if (pb) pb.style.width = '100%';
        renderResults(out.results);
        toast(out.aborted ? '⏹ Остановлено, скачанное сохранено' : '✅ Область успешно загружена в память');
      } catch (e) {
        if (myToken !== uiDownloadToken) return;
        isDownloading = false;
        renderDownloadTab();
        toast('❌ Ошибка загрузки: ' + (e.message || e));
      }
    });
  }

  async function renderCleanupTab() {
    const body = $('wm-oa-body');
    const bar = $('wm-oa-total-bar');
    const foot = $('wm-oa-footer');
    if (!body || !bar || !foot) return;

    bar.hidden = true;
    body.innerHTML = '<div class="oa-card-desc" style="padding:20px;text-align:center;">⏳ Подсчёт кэша карт, слоёв и баз данных…</div>';
    foot.innerHTML = `<button type="button" class="btn btn-secondary" id="wm-oa-clean-close">Закрыть</button>`;
    $('wm-oa-clean-close').onclick = () => close();

    const stats = await getStorageStats();
    const quotaText = (stats.quota && stats.quota.usage != null && stats.quota.quota != null)
      ? `Браузер занял: <b>${fmtBytes(stats.quota.usage)}</b> из <b>${fmtBytes(stats.quota.quota)}</b>`
      : `Оценка загруженных слоёв: <b>${fmtBytes(stats.totalBytes)}</b>`;

    const itemsHtml = stats.items.length
      ? stats.items.map(it => `
          <label class="toggle-item" style="padding:6px 0;border-bottom:1px dashed var(--border);">
            <div style="padding-right:8px;">
              <div style="font-size:12.5px;font-weight:600;color:var(--text-main);">${esc(it.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${it.count.toLocaleString('ru-RU')} записей · ~${fmtBytes(it.bytes)}</div>
              <div style="font-size:10.5px;color:var(--text-muted);">${esc(it.desc)}</div>
            </div>
            <input type="checkbox" class="oa-clean-chk" data-cat-id="${esc(it.id)}" checked>
            <span class="toggle-switch"></span>
          </label>`).join('')
      : '<div class="oa-card-desc" style="padding:12px 0;">Кэш карт и офлайн-слоёв пуст.</div>';

    const areasHtml = stats.areas.length
      ? stats.areas.map(a => {
          const dt = new Date(a.updatedAt || a.createdAt || Date.now()).toLocaleDateString('ru');
          const urlCnt = Array.isArray(a.urls) ? a.urls.length : 0;
          return `
            <div class="oa-area-item" data-area-id="${esc(a.id)}">
              <div style="display:flex;justify-content:space-between;gap:8px;">
                <b>📍 ${esc(a.name)}</b>
                <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${dt}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                z${a.minZ}–z${a.maxZ} · ${fmtArea(a.areaKm2 || 1)} · ${urlCnt} тайлов в паспорте ${a.aborted ? '· (частичная)' : ''}
              </div>
              <div class="oa-area-actions">
                <button type="button" class="oa-btn-xs oa-area-goto" data-id="${esc(a.id)}">🎯 На карте</button>
                <button type="button" class="oa-btn-xs oa-area-resume" data-id="${esc(a.id)}">🔄 Докачать</button>
                <button type="button" class="oa-btn-xs oa-area-del" data-id="${esc(a.id)}" style="color:var(--danger);border-color:var(--danger);">🗑️ Удалить</button>
              </div>
            </div>`;
        }).join('')
      : '<div class="oa-card-desc">Сохранённых областей пока нет.</div>';

    const noEvictTiles = localStorage.getItem('wm_no_evict_tiles') === 'true';

    body.innerHTML = `
      <div class="oa-zone-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <span>${quotaText}</span>
          <span style="font-size:11.5px;color:var(--accent);font-weight:700;">В кэше: ~${fmtBytes(stats.totalBytes)}</span>
        </div>
        <label class="toggle-item" style="margin:6px 0 0;padding-top:6px;border-top:1px dashed var(--border);">
          <span style="font-size:12px;">🔒 Защищать тайлы от автоочистки Service Worker</span>
          <input type="checkbox" id="wm-oa-no-trim" ${noEvictTiles ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
      </div>

      <div class="oa-card">
        <div class="oa-card-head">
          <span class="oa-card-title">🗂️ Очистка по источникам и слоям</span>
        </div>
        <div class="oa-maps-toolbar">
          <button type="button" class="oa-btn-xs" id="wm-oa-clean-all">Выбрать все</button>
          <button type="button" class="oa-btn-xs" id="wm-oa-clean-none">Снять все</button>
        </div>
        <div style="margin-top:6px;">${itemsHtml}</div>
      </div>

      <div class="oa-card">
        <div class="oa-card-head" style="margin-bottom:6px;">
          <span class="oa-card-title">📦 Сохранённые области (${stats.areas.length})</span>
        </div>
        ${areasHtml}
      </div>
    `;

    foot.innerHTML = `
      <button type="button" class="btn btn-secondary" id="wm-oa-clean-cancel">Закрыть</button>
      <button type="button" class="btn btn-danger" id="wm-oa-clean-run" ${stats.items.length ? '' : 'disabled'}>🗑️ Удалить выбранное</button>
    `;

    $('wm-oa-clean-cancel').onclick = () => close();
    $('wm-oa-no-trim')?.addEventListener('change', e => {
      localStorage.setItem('wm_no_evict_tiles', e.target.checked ? 'true' : 'false');
      syncSwNoTrim(e.target.checked);
    });
    $('wm-oa-clean-all')?.addEventListener('click', () => {
      body.querySelectorAll('.oa-clean-chk').forEach(c => { c.checked = true; });
    });
    $('wm-oa-clean-none')?.addEventListener('click', () => {
      body.querySelectorAll('.oa-clean-chk').forEach(c => { c.checked = false; });
    });

    $('wm-oa-clean-run')?.addEventListener('click', async () => {
      const ids = Array.from(body.querySelectorAll('.oa-clean-chk:checked')).map(c => c.dataset.catId);
      if (!ids.length) {
        toast('Выберите хотя бы один источник для очистки');
        return;
      }
      if (!confirm(`Удалить выбранные категории из кэша (${ids.length} шт.)?`)) return;
      const r = await clearSelected(ids);
      toast(`🗑️ Удалено элементов: ${r.deleted}`);
      renderCleanupTab();
    });

    body.querySelectorAll('.oa-area-goto').forEach(btn => {
      btn.onclick = () => {
        const a = stats.areas.find(x => x.id === btn.dataset.id);
        if (a && a.bounds && WM.map) {
          WM.map.fitBounds([[a.bounds.s, a.bounds.w], [a.bounds.n, a.bounds.e]]);
          close();
        }
      };
    });

    body.querySelectorAll('.oa-area-resume').forEach(btn => {
      btn.onclick = () => {
        const a = stats.areas.find(x => x.id === btn.dataset.id);
        if (!a) return;
        activeBounds = normalizeBounds(a.bounds);
        formState = {
          ...loadSavedPrefs(),
          ...(a.formSnapshot || {}),
          minZoom: a.minZ,
          maxZoom: a.maxZ,
          areaName: a.name,
          existingAreaId: a.id
        };
        activeTab = 'download';
        renderModal();
        toast('🔄 Готово к докачке недостающих данных области');
      };
    });

    body.querySelectorAll('.oa-area-del').forEach(btn => {
      btn.onclick = async () => {
        const a = stats.areas.find(x => x.id === btn.dataset.id);
        if (!a) return;
        if (!confirm(`Удалить сохранённую область «${a.name}» и её уникальные тайлы?`)) return;
        const r = await deleteSavedArea(a.id, true);
        toast(`🗑️ Область удалена (тайлов очищено: ${r.deletedTiles})`);
        renderCleanupTab();
      };
    });
  }

  function open(opts = {}) {
    patchIntegrations();
    ensureModalDom();

    // Если прямо сейчас идёт загрузка (не отменённая) — просто показываем окно с её прогрессом
    if (currentJob && !currentJob.ctl.signal.aborted) {
      activeTab = opts.tab || 'download';
      renderModal();
      modalEl.classList.add('open');
      if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('offlineArea');
      return;
    }

    // Отменяем влияние старых завершающихся обработчиков от предыдущей сессии
    uiDownloadToken++;
    isDownloading = false;

    let b = opts.bounds;
    if (!b && WM.map) {
      b = WM.map.getBounds();
    }
    if (!b) {
      b = { w: 37.55, s: 55.70, e: 37.68, n: 55.80 };
    }

    activeBounds = normalizeBounds(b);
    activeCurZoom = WM.map ? Math.round(WM.map.getZoom()) : 14;
    activeTab = opts.tab || 'download';

    const prefs = loadSavedPrefs();
    const allowedMax = computeAllowedMaxZoom(activeBounds, clamp(activeCurZoom, ABS_MIN_ZOOM, ABS_MAX_ZOOM));
    const defMin = clamp(activeCurZoom, ABS_MIN_ZOOM, allowedMax);
    const defMax = clamp(Math.max(defMin, activeCurZoom + 2), defMin, allowedMax);

    formState = {
      ...prefs,
      minZoom: opts.minZoom != null ? clamp(opts.minZoom, ABS_MIN_ZOOM, allowedMax) : defMin,
      maxZoom: opts.maxZoom != null ? clamp(opts.maxZoom, defMin, allowedMax) : defMax,
      areaName: opts.areaName || '',
      existingAreaId: opts.existingAreaId || null
    };

    renderModal();
    modalEl.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('offlineArea');
  }

  function openCleaner() {
    open({ tab: 'clean' });
  }

  function close(syncHistory = true) {
    if (isDownloading) {
      stopDownload();
    }
    if (modalEl) modalEl.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('offlineArea');
  }

  function isOpen() {
    return !!(modalEl && modalEl.classList.contains('open'));
  }

  function bindTrigger(selectorOrEl) {
    const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
    if (!el) return false;
    el.onclick = e => {
      if (e) e.preventDefault();
      open();
    };
    return true;
  }

  // Публичный API модуля
  WM.offlineArea = {
    _loaded: true,
    open,
    openCleaner,
    close,
    isOpen,
    estimate: estimatePlan,
    startDownload,
    stopDownload,
    getStorageStats,
    clearSelected,
    deleteSavedArea,
    getCachedSoil,
    readCachedResponse,
    readCachedBlob,
    readCachedBuffer,
    readCachedTileBlobUrl,
    readCanopyV2Grid,
    readCanopyV2ParentGrid,
    patchIntegrations,
    bindTrigger
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchIntegrations);
  } else {
    patchIntegrations();
  }
})();