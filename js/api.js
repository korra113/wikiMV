(function () {
  const WM = window.WM, C = WM.config;
  const H = 'api.wikimapia.org/?';
  const KEY_LIMIT = 100;

  // Официальный системный ключ
  const MASTER_KEY = 'F29DE311-79E27525-6803266D-365D72DD-2A145EEB-9C8F7110-26ACA826-139C9859';
  const MASTER_KEY_COOLDOWN_MS = 2500; // Мягкий кулдаун для мастер-ключа

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
    if (Array.isArray(parsed)) {
      keyList = parsed.filter(k => k && k !== MASTER_KEY);
    }
  } catch (e) {}

  const keyStates = new Map();
  let activeIndex = parseInt(store.get('wm_active_key_idx') || '0', 10) || 0;
  let lastGood = store.get('wm_last_route') || null;

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

    if (key !== MASTER_KEY) {
      const dayStart = now - (24 * 3600 * 1000 - getMsUntilMidnightPT());
      if (state.timestamps.length) {
        state.timestamps = state.timestamps.filter(t => t >= dayStart);
      }
      if (!state.blockedUntil && state.timestamps.length >= KEY_LIMIT) {
        state.blockedUntil = Date.now() + getMsUntilMidnightPT();
      }
    } else {
      state.timestamps = state.timestamps.filter(t => t >= now - 8000);
    }

    return state;
  }

  function blockKey(key, waitMs = null) {
    const state = getState(key);
    if (key === MASTER_KEY) {
      const cooldown = waitMs || (MASTER_KEY_COOLDOWN_MS + Math.floor(Math.random() * 1000));
      state.blockedUntil = Date.now() + cooldown;
    } else {
      state.blockedUntil = Date.now() + getMsUntilMidnightPT();
    }
  }

  function resolveBestKey() {
    const now = Date.now();

    if (keyList.length > 0) {
      if (activeIndex >= keyList.length) activeIndex = 0;
      const curKey = keyList[activeIndex];
      const curState = getState(curKey);

      if (!curState.blockedUntil && curState.timestamps.length < KEY_LIMIT) {
        return { index: activeIndex, key: curKey, waitMs: 0, allBlocked: false, isMaster: false };
      }

      for (let i = 0; i < keyList.length; i++) {
        const st = getState(keyList[i]);
        if (!st.blockedUntil && st.timestamps.length < KEY_LIMIT) {
          activeIndex = i;
          return { index: i, key: keyList[i], waitMs: 0, allBlocked: false, isMaster: false };
        }
      }
    }

    const masterState = getState(MASTER_KEY);
    if (!masterState.blockedUntil || now >= masterState.blockedUntil) {
      return { index: -1, key: MASTER_KEY, waitMs: 0, allBlocked: false, isMaster: true };
    }

    const masterWait = Math.max(100, masterState.blockedUntil - now);
    return {
      index: -1,
      key: MASTER_KEY,
      waitMs: masterWait,
      allBlocked: true,
      isMaster: true
    };
  }

  // Строгий однопоточный планировщик очереди с мягкими интервалами (Pacer)
  let queuePromise = Promise.resolve();
  let lastRequestDoneTime = 0;

  function schedulePacedRequest(fn) {
    const run = async () => {
      const now = Date.now();
      const elapsed = now - lastRequestDoneTime;
      // Безопасный интервал между запросами: 360-460 мс исключает бан Wikimapia
      const minGap = 360 + Math.floor(Math.random() * 100);
      if (elapsed < minGap) {
        await new Promise(r => setTimeout(r, minGap - elapsed));
      }
      try {
        return await fn();
      } finally {
        lastRequestDoneTime = Date.now();
      }
    };

    const next = queuePromise.then(run, run);
    queuePromise = next.catch(() => {});
    return next;
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

  // Выполнение запроса с поддержкой прозрачного повтора (Soft Backoff)
  async function executeRequestOnce(params, retryCount = 0) {
    const resKey = resolveBestKey();
    if (resKey.allBlocked) {
      const err = new Error(`Лимит запросов исчерпан. Ожидание: ${Math.ceil(resKey.waitMs / 1000)} сек.`);
      err.rateLimit = true;
      err.retryAfterMs = resKey.waitMs;
      throw err;
    }

    const curKey = resKey.key;
    const state = getState(curKey);
    state.timestamps.push(Date.now());

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
          const isRateOrQuota = /key|limit|quota|exceed|denied|too many|1001|1004/i.test(msg);

          if (isRateOrQuota) {
            // Если это мастер-ключ или временный лимит частоты, пробуем прозрачный микро-повтор
            if (resKey.isMaster && retryCount < 2) {
              await new Promise(res => setTimeout(res, 1400 * (retryCount + 1)));
              return executeRequestOnce(params, retryCount + 1);
            }

            blockKey(curKey);
            const next = resolveBestKey();
            if (!next.allBlocked) {
              return executeRequestOnce(params, retryCount + 1);
            }
            const e = new Error(msg);
            e.api = true;
            e.rateLimit = true;
            e.retryAfterMs = next.waitMs;
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

  function request(params) {
    return schedulePacedRequest(() => executeRequestOnce(params));
  }

  function extractValidPlaces(data) {
    if (!data) return [];
    const raw = data.places || data.folder || (Array.isArray(data) ? data : []);
    if (!Array.isArray(raw)) return [];
    const res = [];
    for (const it of raw) {
      if (!it || it.id == null) continue;
      let poly = it.polygon || (it.location && it.location.polygon);
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
    get activeKey() { return resolveBestKey().key; },
    get activeIndex() { return activeIndex; },
    isMasterActive() { return resolveBestKey().isMaster; },
    hasCustomKey() { return keyList.length > 0; },
    netMode: store.get('wm_net') || 'auto',
    store,

    getKeyStats(k) {
      if (k === MASTER_KEY || (!k && this.isMasterActive())) {
        const st = getState(MASTER_KEY);
        const isBlocked = !!st.blockedUntil && st.blockedUntil > Date.now();
        const waitMs = isBlocked ? Math.max(0, st.blockedUntil - Date.now()) : 0;
        return {
          used: st.timestamps.length,
          remaining: 999999,
          limit: '∞',
          isBlocked,
          waitMs,
          isMaster: true
        };
      }
      const st = getState(k);
      const isBlocked = !!st.blockedUntil && st.blockedUntil > Date.now();
      const waitMs = isBlocked ? Math.max(0, st.blockedUntil - Date.now()) : 0;
      const used = isBlocked ? KEY_LIMIT : st.timestamps.length;
      return {
        used,
        remaining: Math.max(0, KEY_LIMIT - used),
        limit: KEY_LIMIT,
        isBlocked,
        waitMs,
        isMaster: false
      };
    },

    getPoolStatus() { return resolveBestKey(); },

    resetAllLimits() {
      for (const st of keyStates.values()) {
        st.blockedUntil = 0;
        st.timestamps = [];
      }
    },

    setKeys(keys, activeIdx = 0) {
      let filtered = (keys || [])
        .map(k => (k || '').trim())
        .filter(k => k && k !== MASTER_KEY && k.toLowerCase() !== 'example');
      keyList = filtered;
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

      let localDensity = 0;
      if (map && WM.cache) {
        const b = map.getBounds();
        const vb = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
        for (const o of WM.cache.objects.values()) {
          if (WM.geo.intersects(o.bbox, vb)) localDensity++;
        }
      }

      let searchRadiusPx;
      if (zoom <= 12) {
        searchRadiusPx = Math.round(minDim * 0.9);
      } else if (zoom <= 14) {
        searchRadiusPx = localDensity < 5 ? Math.round(minDim * 0.85) : (localDensity < 25 ? Math.round(minDim * 0.6) : 200);
      } else if (zoom <= 16) {
        searchRadiusPx = localDensity < 5 ? Math.round(minDim * 0.7) : (localDensity < 25 ? Math.round(minDim * 0.45) : 160);
      } else {
        searchRadiusPx = localDensity < 10 ? 200 : 130;
      }

      const degPerPx = 360 / (256 * 2 ** zoom);
      const cosLat = Math.cos(lat * Math.PI / 180) || 1;
      const epsLon = degPerPx * searchRadiusPx;
      const epsLat = degPerPx * searchRadiusPx * cosLat;

      try {
        const data = await this.box({
          w: lon - epsLon,
          s: lat - epsLat,
          e: lon + epsLon,
          n: lat + epsLat
        }, 1);
        const valid = extractValidPlaces(data);
        if (valid.length > 0) return valid;
      } catch (e) {}

      try {
        const data = await request({ function: 'place.getnearest', lat, lon, count: 100 });
        const valid = extractValidPlaces(data);
        if (valid.length > 0) return valid;
      } catch (e) {}

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
          const data = await request({ function: fn, q: query, lat, lon, count: 30 });
          const items = data.places || data.folder || (Array.isArray(data) ? data : []);
          if (items && items.length) return items;
        } catch (e) {}
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
      if (detailsMem.has(cacheKey)) return detailsMem.get(cacheKey);

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