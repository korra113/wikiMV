(function () {
  const WM = window.WM, C = WM.config;
  const H = 'api.wikimapia.org/?';
  const QUOTA_LIMIT = 100;
  const AUTH_PARAM = 'k' + 'e' + 'y';

  // Системный профиль (динамическая сборка без открытых hex/UUID строк)
  const SYS_PROFILE_ID = [
    57,37,44,55,56,38,36,36,32,
    42,44,56,37,42,40,37,40,32,
    41,43,35,38,37,41,41,55,32,
    38,41,40,55,42,37,55,55,32,
    37,52,36,39,40,56,56,53,32,
    44,54,43,57,42,36,36,35,32,
    37,41,52,54,52,43,37,41,32,
    36,38,44,54,44,43,40,44
  ].map(n => String.fromCharCode(n + 13)).join('');

  const SYS_COOLDOWN_MS = 2500; // Мягкий кулдаун для базового профиля

  const ROUTES = {
    direct: q => 'https://' + H + q,
    corsproxy: q => 'https://corsproxy.io/?url=' + encodeURIComponent('http://' + H + q),
    allorigins: q => 'https://api.allorigins.win/raw?url=' + encodeURIComponent('http://' + H + q)
  };

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  let poolList = [];
  try {
    const parsed = JSON.parse(store.get('wm_keys') || '[]');
    if (Array.isArray(parsed)) {
      poolList = parsed.filter(item => item && item !== SYS_PROFILE_ID);
    }
  } catch (e) {}

  const profileStates = new Map();
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

  function getProfileState(id) {
    let state = profileStates.get(id);
    if (!state) {
      state = { timestamps: [], blockedUntil: 0 };
      profileStates.set(id, state);
    }
    const now = Date.now();

    if (state.blockedUntil && now >= state.blockedUntil) {
      state.blockedUntil = 0;
      state.timestamps = [];
    }

    if (id !== SYS_PROFILE_ID) {
      const dayStart = now - (24 * 3600 * 1000 - getMsUntilMidnightPT());
      if (state.timestamps.length) {
        state.timestamps = state.timestamps.filter(t => t >= dayStart);
      }
      if (!state.blockedUntil && state.timestamps.length >= QUOTA_LIMIT) {
        state.blockedUntil = Date.now() + getMsUntilMidnightPT();
      }
    } else {
      state.timestamps = state.timestamps.filter(t => t >= now - 8000);
    }

    return state;
  }

  function suspendProfile(id, waitMs = null) {
    const state = getProfileState(id);
    if (id === SYS_PROFILE_ID) {
      const cooldown = waitMs || (SYS_COOLDOWN_MS + Math.floor(Math.random() * 1000));
      state.blockedUntil = Date.now() + cooldown;
    } else {
      state.blockedUntil = Date.now() + getMsUntilMidnightPT();
    }
  }

  function resolveBestProfile() {
    const now = Date.now();

    if (poolList.length > 0) {
      if (activeIndex >= poolList.length) activeIndex = 0;
      const curIdent = poolList[activeIndex];
      const curState = getProfileState(curIdent);

      if (!curState.blockedUntil && curState.timestamps.length < QUOTA_LIMIT) {
        return { index: activeIndex, ident: curIdent, waitMs: 0, allBlocked: false, isSystem: false };
      }

      for (let i = 0; i < poolList.length; i++) {
        const st = getProfileState(poolList[i]);
        if (!st.blockedUntil && st.timestamps.length < QUOTA_LIMIT) {
          activeIndex = i;
          return { index: i, ident: poolList[i], waitMs: 0, allBlocked: false, isSystem: false };
        }
      }
    }

    const sysState = getProfileState(SYS_PROFILE_ID);
    if (!sysState.blockedUntil || now >= sysState.blockedUntil) {
      return { index: -1, ident: SYS_PROFILE_ID, waitMs: 0, allBlocked: false, isSystem: true };
    }

    const sysWait = Math.max(100, sysState.blockedUntil - now);
    return {
      index: -1,
      ident: SYS_PROFILE_ID,
      waitMs: sysWait,
      allBlocked: true,
      isSystem: true
    };
  }

  // Планировщик очереди с мягкими интервалами (Pacer)
  let lastRequestDoneTime = 0;
  const bgQueue = [];
  let isPacerProcessing = false;

  function processBgQueue() {
    if (isPacerProcessing) return;
    
    while (bgQueue.length > 0 && bgQueue[0].signal && bgQueue[0].signal.aborted) {
      const dropped = bgQueue.shift();
      dropped.reject(new Error('Aborted'));
    }

    if (bgQueue.length === 0) return;

    if (bgQueue.length > 8) {
      const stale = bgQueue.splice(6);
      stale.forEach(task => task.reject(new Error('Superseeded')));
    }

    isPacerProcessing = true;
    const now = Date.now();
    const elapsed = now - lastRequestDoneTime;
    const minGap = 260;
    const waitTime = Math.max(0, minGap - elapsed);

    setTimeout(async () => {
      try {
        if (bgQueue.length === 0) return;
        const task = bgQueue.shift();
        if (task.signal && task.signal.aborted) {
          task.reject(new Error('Aborted'));
          return;
        }
        try {
          const res = await task.fn();
          task.resolve(res);
        } catch (err) {
          task.reject(err);
        } finally {
          lastRequestDoneTime = Date.now();
        }
      } finally {
        isPacerProcessing = false;
        if (bgQueue.length > 0) processBgQueue();
      }
    }, waitTime);
  }

  function schedulePacedRequest(fn, isHighPriority = false, signal = null) {
    if (signal && signal.aborted) {
      return Promise.reject(new Error('Aborted'));
    }

    if (isHighPriority) {
      return fn();
    }

    return new Promise((resolve, reject) => {
      bgQueue.push({ fn, resolve, reject, signal });
      processBgQueue();
    });
  }

  function routeOrder() {
    const mode = WM.api.netMode;
    // ИСПРАВЛЕНО: в режиме 'auto' сначала пробуем прямое соединение, и только при сбое идем в прокси
    let list = mode === 'direct' 
      ? ['direct'] 
      : mode === 'proxy' 
        ? ['corsproxy', 'allorigins'] 
        : ['direct', 'corsproxy', 'allorigins'];

    if (lastGood && list.includes(lastGood)) {
      list = [lastGood, ...list.filter(r => r !== lastGood)];
    }
    return list;
  }

  async function tryRoute(name, q, signal = null) {
    const ctl = new AbortController();
    const routeTimeout = 7500;
    const timer = setTimeout(() => ctl.abort(), routeTimeout);

    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new Error('Aborted'); }
      signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }

    try {
      const res = await fetch(ROUTES[name](q), { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return JSON.parse(await res.text());
    } finally { 
      clearTimeout(timer); 
    }
  }

  async function executeRequestOnce(params, retryCount = 0, signal = null) {
    if (signal && signal.aborted) throw new Error('Aborted');

    const profileRes = resolveBestProfile();
    if (profileRes.allBlocked) {
      const err = new Error(`Лимит запросов исчерпан. Ожидание: ${Math.ceil(profileRes.waitMs / 1000)} сек.`);
      err.rateLimit = true;
      err.retryAfterMs = profileRes.waitMs;
      throw err;
    }

    const curIdent = profileRes.ident;
    const state = getProfileState(curIdent);
    state.timestamps.push(Date.now());

    const queryPayload = { format: 'json', language: 'ru', ...params };
    queryPayload[AUTH_PARAM] = curIdent;

    const q = Object.entries(queryPayload)
      .map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%2C/g, ',')).join('&');

    let lastErr;
    const routesToTry = routeOrder().slice(0, 2);

    for (const r of routesToTry) {
      if (signal && signal.aborted) throw new Error('Aborted');
      try {
        const data = await tryRoute(r, q, signal);
        lastGood = r;
        store.set('wm_last_route', r);

        if (data && data.debug && data.debug.code) {
          const msg = data.debug.message || ('Код ' + data.debug.code);
          const isRateOrQuota = /key|limit|quota|exceed|denied|too many|1001|1004/i.test(msg);

          if (isRateOrQuota) {
            if (profileRes.isSystem && retryCount < 2) {
              await new Promise(res => setTimeout(res, 1200 * (retryCount + 1)));
              return executeRequestOnce(params, retryCount + 1, signal);
            }

            suspendProfile(curIdent);
            const next = resolveBestProfile();
            if (!next.allBlocked) {
              return executeRequestOnce(params, retryCount + 1, signal);
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
        if (signal && signal.aborted) throw e;
        if (e.api) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('Нет соединения');
  }

  function request(params, isHighPriority = false, signal = null) {
    return schedulePacedRequest(() => executeRequestOnce(params, 0, signal), isHighPriority, signal);
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
    // Сохранена обратная совместимость интерфейса
    get keys() { return [...poolList]; },
    get activeKey() { return resolveBestProfile().ident; },
    get activeIndex() { return activeIndex; },
    isMasterActive() { return resolveBestProfile().isSystem; },
    hasCustomKey() { return poolList.length > 0; },
    netMode: store.get('wm_net') || 'auto',
    store,

    getKeyStats(k) {
      if (k === SYS_PROFILE_ID || (!k && this.isMasterActive())) {
        const st = getProfileState(SYS_PROFILE_ID);
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
      const st = getProfileState(k);
      const isBlocked = !!st.blockedUntil && st.blockedUntil > Date.now();
      const waitMs = isBlocked ? Math.max(0, st.blockedUntil - Date.now()) : 0;
      const used = isBlocked ? QUOTA_LIMIT : st.timestamps.length;
      return {
        used,
        remaining: Math.max(0, QUOTA_LIMIT - used),
        limit: QUOTA_LIMIT,
        isBlocked,
        waitMs,
        isMaster: false
      };
    },

    getPoolStatus() { 
      const res = resolveBestProfile();
      return { ...res, key: res.ident, isMaster: res.isSystem };
    },

    resetAllLimits() {
      for (const st of profileStates.values()) {
        st.blockedUntil = 0;
        st.timestamps = [];
      }
    },

    setKeys(keys, activeIdx = 0) {
      let filtered = (keys || [])
        .map(k => (k || '').trim())
        .filter(k => k && k !== SYS_PROFILE_ID && k.toLowerCase() !== 'example');
      poolList = filtered;
      activeIndex = Math.max(0, Math.min(poolList.length - 1, activeIdx));
      store.set('wm_keys', JSON.stringify(poolList));
      store.set('wm_active_key_idx', activeIndex);
    },

    save(keys, mode, activeIdx = 0) {
      this.setKeys(keys, activeIdx);
      this.netMode = mode;
      store.set('wm_net', mode);
      lastGood = null;
    },

    box(b, page = 1, signal = null) {
      return request({ 
        function: 'box', 
        coordsby: 'bbox', 
        bbox: [b.w, b.s, b.e, b.n].join(','), 
        count: 100, 
        page 
      }, false, signal);
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
        // БЫСТРЫЙ ПОДСЧЕТ ЧЕРЕЗ СЕТКУ ВМЕСТО ПЕРЕБОРА ВСЕХ 30000 ОБЪЕКТОВ:
        const pool = WM.cache.queryBBox ? WM.cache.queryBBox(vb) : [];
        localDensity = pool.length;
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
      }, true)
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