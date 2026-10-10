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
  let activeIndex = 0;
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
      // Fallback на полночь UTC, если браузер не поддерживает timeZone
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

    // Если наступила полночь PT — сбрасываем блокировку и счётчики
    if (state.blockedUntil && now >= state.blockedUntil) {
      state.blockedUntil = 0;
      state.timestamps = [];
    }

    // Удаляем запросы, сделанные до начала текущих суток PT
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

    const q = Object.entries({ ...params, format: 'json', language: 'ru', key: curKey })
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

  const detailsMem = new Map(), inflight = new Map();

  WM.api = {
    get keys() { return [...keyList]; },
    get activeKey() { return keyList[activeIndex] || 'example'; },
    get activeIndex() { return activeIndex; },
    // ПРОВЕРКА: есть ли пользовательские ключи (отличные от example)
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
    },

    save(keys, mode, activeIdx = 0) {
      this.setKeys(keys, activeIdx);
      this.netMode = mode;
      store.set('wm_net', mode);
      lastGood = null;
    },

    box(b, page) {
      return request({ function: 'box', coordsby: 'bbox', bbox: [b.w, b.s, b.e, b.n].join(','), count: C.PAGE_SIZE, page });
    },

    async point(lat, lon) {
      try {
        const data = await request({
          function: 'place.getnearest',
          lat,
          lon,
          count: 30
        });
        const items = data.places || data.folder || (Array.isArray(data) ? data : []);
        const valid = items.filter(it => it && Array.isArray(it.polygon) && it.polygon.length >= 3);
        if (valid.length) return valid;
      } catch (e) {
        console.warn('[WM API] place.getnearest error, fallback to box:', e.message);
      }

      const zoom = (WM.map && WM.map.getZoom()) || 13;
      const degPerPx = 360 / (256 * 2 ** zoom);
      const cosLat = Math.cos(lat * Math.PI / 180) || 1;
      const epsLon = Math.max(0.0015, degPerPx * 35);
      const epsLat = Math.max(0.0015, (degPerPx * 35) / cosLat);

      try {
        const data = await this.box({
          w: lon - epsLon,
          s: lat - epsLat,
          e: lon + epsLon,
          n: lat + epsLat
        }, 1);
        const items = Array.isArray(data.folder) ? data.folder : [];
        if (items.length) return items;
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

    async place(id) {
      if (detailsMem.has(id)) return detailsMem.get(id);
      const offline = await WM.cache.getDetail(id);
      if (offline) { detailsMem.set(id, offline); return offline; }
      if (inflight.has(id)) return inflight.get(id);

      const p = request({ function: 'place.getbyid', id, data_blocks: 'main,photos,comments,location' })
        .then(d => {
          detailsMem.set(id, d);
          WM.cache.saveDetail(id, d);
          if (detailsMem.size > C.DETAIL_CACHE_MAX) detailsMem.delete(detailsMem.keys().next().value);
          return d;
        }).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    }
  };
})();
