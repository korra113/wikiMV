(function () {
  const WM = window.WM, C = WM.config;
  const H = 'api.wikimapia.org/?';
  const KEY_LIMIT = 100;

  const ROUTES = {
    direct: q => 'https://' + H + q,
    corsproxy: q => 'https://corsproxy.io/?url=' + encodeURIComponent('http://' + H + q),
    allorigins: q => 'https://api.allorigins.win/raw?url=' + encodeURIComponent('http://' + H + q)
  };

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  let keyList = [];
  try {
    const parsed = JSON.parse(store.get('wm_keys') || '[]');
    if (Array.isArray(parsed) && parsed.length) keyList = parsed.filter(Boolean);
  } catch (e) {}
  if (!keyList.length) {
    const oldKey = store.get('wm_api_key') || 'example';
    keyList = [oldKey];
  }

  const keyStates = new Map();
  let activeIndex = parseInt(store.get('wm_active_key_idx') || '0', 10) || 0;
  let lastGood = store.get('wm_last_route') || null;

  // Расчёт времени до полуночи по Тихоокеанскому времени (America/Los_Angeles, PT)
  function getMsUntilMidnightPT() {
    try {
      const now = new Date();
      const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const ptNow = new Date(ptStr);
      const ptMidnight = new Date(ptNow);
      ptMidnight.setHours(24, 0, 0, 0);
      return Math.max(1000, ptMidnight.getTime() - ptNow.getTime());
    } catch (e) {
      const now = new Date();
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
      return Math.max(1000, utcMidnight.getTime() - now.getTime());
    }
  }

  function getMidnightPTTimestamp() {
    return Date.now() + getMsUntilMidnightPT();
  }

  function getState(key) {
    let state = keyStates.get(key);
    if (!state) {
      state = { timestamps: [], blockedUntil: 0 };
      keyStates.set(key, state);
    }
    const now = Date.now();

    if (state.blockedUntil && now >= state.blockedUntil) {
      state.blockedUntil = 0;
      state.timestamps = [];
    }

    const dayStart = now - (24 * 3600 * 1000 - getMsUntilMidnightPT());
    if (state.timestamps.length) {
      state.timestamps = state.timestamps.filter(t => t >= dayStart);
    }

    if (!state.blockedUntil && state.timestamps.length >= KEY_LIMIT) {
      state.blockedUntil = getMidnightPTTimestamp();
    }

    return state;
  }

  function blockKey(key) {
    const state = getState(key);
    state.blockedUntil = getMidnightPTTimestamp();
  }

  function resolveBestKey() {
    if (activeIndex >= keyList.length) activeIndex = 0;
    const curKey = keyList[activeIndex];
    const curState = getState(curKey);

    if (!curState.blockedUntil && curState.timestamps.length < KEY_LIMIT) {
      return { index: activeIndex, key: curKey, waitMs: 0, allBlocked: false };
    }

    for (let i = 0; i < keyList.length; i++) {
      const st = getState(keyList[i]);
      if (!st.blockedUntil && st.timestamps.length < KEY_LIMIT) {
        activeIndex = i;
        return { index: i, key: keyList[i], waitMs: 0, allBlocked: false };
      }
    }

    let minWait = Infinity;
    let bestIdx = activeIndex;
    const now = Date.now();

    for (let i = 0; i < keyList.length; i++) {
      const st = getState(keyList[i]);
      const wait = Math.max(0, (st.blockedUntil || getMidnightPTTimestamp()) - now);
      if (wait < minWait) {
        minWait = wait;
        bestIdx = i;
      }
    }

    activeIndex = bestIdx;
    return {
      index: bestIdx,
      key: keyList[bestIdx],
      waitMs: minWait === Infinity ? getMsUntilMidnightPT() : minWait,
      allBlocked: true
    };
  }

  function routeOrder() {
    const mode = WM.api.netMode;
    let list = mode === 'direct' ? ['direct'] : mode === 'proxy' ? ['corsproxy', 'allorigins'] : ['corsproxy', 'direct', 'allorigins'];
    if (lastGood && list.includes(lastGood)) {
      list = [lastGood, ...list.filter(r => r !== lastGood)];
    }
    return list;
  }

  async function tryRoute(name, q) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), C.TIMEOUT_MS || 8000);
    try {
      const res = await fetch(ROUTES[name](q), { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return JSON.parse(await res.text());
    } finally { clearTimeout(timer); }
  }

  async function request(params) {
    const resKey = resolveBestKey();
    if (resKey.allBlocked) {
      const waitMs = resKey.waitMs;
      const err = new Error(`Лимит всех ключей исчерпан до полуночи PT.`);
      err.rateLimit = true;
      err.retryAfterMs = waitMs;
      throw err;
    }

    const curKey = resKey.key;
    const state = getState(curKey);

    state.timestamps.push(Date.now());
    if (state.timestamps.length >= KEY_LIMIT) {
      state.blockedUntil = getMidnightPTTimestamp();
    }

    const q = Object.entries({ format: 'json', language: 'ru', ...params, key: curKey })
      .map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%2C/g, ',')).join('&');

    let lastErr;
    for (const r of routeOrder()) {
      try {
        const data = await tryRoute(r, q);
        lastGood = r;
        store.set('wm_last_route', r);

        if (data && data.debug && data.debug.code) {
          const msg = data.debug.message || ('Код ' + data.debug.code);
          const isQuota = /key|limit|quota|exceed|denied|1001|1004/i.test(msg);
          if (isQuota) {
            blockKey(curKey);
            if (keyList.length > 1) {
              const next = resolveBestKey();
              if (!next.allBlocked) return request(params);
            }
            const e = new Error(msg);
            e.api = true;
            e.rateLimit = true;
            e.retryAfterMs = getMsUntilMidnightPT();
            throw e;
          }
          const e = new Error(msg);
          e.api = true;
          throw e;
        }

        return data;
      } catch (e) {
        if (e.api) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('Нет соединения');
  }

  // Извлечение и нормализация полигонов из любого ответа API
  function extractValidPlaces(data) {
    if (!data) return [];
    const raw = data.places || data.folder || (Array.isArray(data) ? data : []);
    if (!Array.isArray(raw)) return [];
    const res = [];
    for (const it of raw) {
      if (!it || it.id == null) continue;
      let poly = it.polygon || (it.location && it.location.polygon);
      // Если PHP вернул ассоциативный объект вместо массива — конвертируем
      if (poly && !Array.isArray(poly) && typeof poly === 'object') {
        poly = Object.values(poly);
      }
      if (Array.isArray(poly) && poly.length >= 3) {
        it.polygon = poly;
        res.push(it);
      }
    }
    return res;
  }

  const detailsMem = new Map(), inflight = new Map();

  WM.api = {
    get keys() { return [...keyList]; },
    get activeKey() { return keyList[activeIndex] || 'example'; },
    get activeIndex() { return activeIndex; },
    hasCustomKey() {
      return keyList.some(k => k && k.toLowerCase() !== 'example');
    },
    netMode: store.get('wm_net') || 'auto',
    store,

    getKeyStats(k) {
      const st = getState(k);
      const isBlocked = !!st.blockedUntil && st.blockedUntil > Date.now();
      const waitMs = isBlocked ? Math.max(0, st.blockedUntil - Date.now()) : 0;
      const used = isBlocked ? KEY_LIMIT : st.timestamps.length;
      return {
        used,
        remaining: Math.max(0, KEY_LIMIT - used),
        limit: KEY_LIMIT,
        isBlocked,
        waitMs
      };
    },

    getPoolStatus() { return resolveBestKey(); },

    resetAllLimits() {
      for (const k of keyList) {
        const st = keyStates.get(k);
        if (st) { st.blockedUntil = 0; st.timestamps = []; }
      }
    },

    setKeys(keys, activeIdx = 0) {
      let filtered = (keys || []).map(k => (k || '').trim()).filter(Boolean);
      if (filtered.some(k => k !== 'example')) {
        filtered = filtered.filter(k => k !== 'example');
      }
      keyList = filtered.length ? filtered : ['example'];
      activeIndex = Math.max(0, Math.min(keyList.length - 1, activeIdx));
      store.set('wm_keys', JSON.stringify(keyList));
      store.set('wm_active_key_idx', activeIndex);
    },

    save(keys, mode, activeIdx = 0) {
      this.setKeys(keys, activeIdx);
      this.netMode = mode;
      store.set('wm_net', mode);
      lastGood = null;
    },

    box(b, page = 1) {
      return request({ 
        function: 'box', 
        coordsby: 'bbox', 
        bbox: [b.w, b.s, b.e, b.n].join(','), 
        count: 100, 
        page 
      });
    },

    categoryBox(b, category, page = 1) {
      return request({
        function: 'box',
        coordsby: 'bbox',
        bbox: [b.w, b.s, b.e, b.n].join(','),
        category,
        count: 100,
        page
      });
    },

    async point(lat, lon) {
      const map = WM.map;
      const zoom = map ? Math.round(map.getZoom()) : 14;
      const mapSize = map ? map.getSize() : { x: 400, y: 700 };
      const minDim = Math.max(320, Math.min(mapSize.x, mapSize.y));

      // 1. Оцениваем плотность объектов в видимой области экрана по локальному кэшу
      let localDensity = 0;
      if (map && WM.cache) {
        const b = map.getBounds();
        const vb = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
        for (const o of WM.cache.objects.values()) {
          if (WM.geo.intersects(o.bbox, vb)) localDensity++;
        }
      }

      // 2. Адаптивный расчёт радиуса захвата (в экранных пикселях)
      // Чем ниже плотность и дальше зум — тем шире захват (в глуши берём почти весь экран)
      let searchRadiusPx;
      if (zoom <= 12) {
        searchRadiusPx = Math.round(minDim * 0.9); // обзорный масштаб
      } else if (zoom <= 14) {
        searchRadiusPx = localDensity < 5 ? Math.round(minDim * 0.85) : (localDensity < 25 ? Math.round(minDim * 0.6) : 200);
      } else if (zoom <= 16) {
        searchRadiusPx = localDensity < 5 ? Math.round(minDim * 0.7) : (localDensity < 25 ? Math.round(minDim * 0.45) : 160);
      } else {
        // Zoom 17+ (детальный городской уровень)
        searchRadiusPx = localDensity < 10 ? 200 : 130;
      }

      const degPerPx = 360 / (256 * 2 ** zoom);
      const cosLat = Math.cos(lat * Math.PI / 180) || 1;

      // Симметричный расчёт без искажений проекции Меркатора
      const epsLon = degPerPx * searchRadiusPx;
      const epsLat = degPerPx * searchRadiusPx * cosLat;

      // 3. Основной запрос: адаптивный BOX с максимальной квотой count: 100
      // Метод BOX за 1 запрос гарантированно возвращает все объекты в округе без отсечения по дистанции
      try {
        const data = await this.box({
          w: lon - epsLon,
          s: lat - epsLat,
          e: lon + epsLon,
          n: lat + epsLat
        }, 1);
        const valid = extractValidPlaces(data);
        if (valid.length > 0) {
          return valid;
        }
      } catch (e) {
        console.warn('[WM API] Adaptive box error, fallback to getnearest:', e.message);
      }

      // 4. Fallback: если в рассчитанном квадрате совсем пусто (глухая тайга/пустыня),
      // запрашиваем place.getnearest с count: 100. Сервер найдёт даже одиночный удалённый объект.
      try {
        const data = await request({
          function: 'place.getnearest',
          lat,
          lon,
          count: 100
        });
        const valid = extractValidPlaces(data);
        if (valid.length > 0) {
          return valid;
        }
      } catch (e) {
        console.warn('[WM API] place.getnearest fallback error:', e.message);
      }

      return [];
    },

    async search(q, lat, lon) {
      const query = (q || '').trim();
      if (!query) return [];

      const idMatch = query.match(/(?:#|\/|^)(\d{4,10})(?:\/|$|\b)/);
      if (idMatch) {
        try {
          const p = await this.place(idMatch[1]);
          if (p && p.id) return [p];
        } catch (e) {}
      }

      const tryFunctions = ['place.search', 'search'];
      for (const fn of tryFunctions) {
        try {
          const data = await request({
            function: fn,
            q: query,
            lat,
            lon,
            count: 30
          });
          const items = data.places || data.folder || (Array.isArray(data) ? data : []);
          if (items && items.length) return items;
        } catch (e) {
          console.warn(`[WM API] ${fn} error:`, e.message);
        }
      }

      return [];
    },

    async geocodeOSM(query, lat, lon) {
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lat=${lat}&lon=${lon}&limit=10&lang=ru`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Photon error');
        const data = await res.json();
        return (data.features || []).map(f => {
          const p = f.properties || {};
          const labelParts = [p.name, p.street, p.city || p.town || p.village, p.state, p.country].filter(Boolean);
          return {
            title: p.name || labelParts[0] || query,
            subtitle: labelParts.slice(1).join(', '),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            source: 'osm'
          };
        });
      } catch (e) {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=8&accept-language=ru`);
          if (!res.ok) return [];
          const items = await res.json();
          return items.map(it => ({
            title: it.display_name.split(',')[0],
            subtitle: it.display_name.split(',').slice(1).join(','),
            lat: parseFloat(it.lat),
            lon: parseFloat(it.lon),
            source: 'osm'
          }));
        } catch (err) {
          return [];
        }
      }
    },

    async place(id, lang = 'ru') {
      const cacheKey = `${id}:${lang}`;
      if (detailsMem.has(cacheKey)) {
        return detailsMem.get(cacheKey);
      }

      const offline = await WM.cache.getDetail(id, lang);
      if (offline) {
        detailsMem.set(cacheKey, offline);
        return offline;
      }

      if (inflight.has(cacheKey)) return inflight.get(cacheKey);

      const p = request({ 
        function: 'place.getbyid', 
        id, 
        language: lang, 
        data_blocks: 'main,photos,comments,location,translate' 
      })
        .then(d => {
          detailsMem.set(cacheKey, d);
          WM.cache.saveDetail(id, d, lang);
          if (detailsMem.size > C.DETAIL_CACHE_MAX) detailsMem.delete(detailsMem.keys().next().value);
          return d;
        })
        .finally(() => inflight.delete(cacheKey));

      inflight.set(cacheKey, p);
      return p;
    }
  };
})();
