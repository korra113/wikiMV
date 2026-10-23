/**
 * Wikimapia Viewer — модуль «Вода, разлив и заболоченность» (water.js) v2
 *
 * Логика (двухслойная, как в гидрологии):
 *   ПРЕДРАСПОЛОЖЕННОСТЬ МЕСТА (статика 0–100) = рельеф + почва/водоупоры + карта гидрообъектов
 *   АКТИВАЦИЯ ПОГОДОЙ (динамика 0–100)       = влажность 5 слоёв vs полевая влагоёмкость + индекс предшествующих осадков (API)
 *                                              + дождь 72 ч + прогноз 72 ч + снеготаяние/мёрзлый грунт
 *   ИТОГ = предрасположенность × (0.30 + 0.70 × активация), болото/торфяник не опускаются ниже 62
 *   РЕЧНОЙ РАЗЛИВ (GloFAS) учитывается ТОЛЬКО если точка в пойме: расстояние до русла (OSM, по геометрии)
 *   и превышение над ближайшим понижением (DEM) — иначе река «не достанет».
 *
 * Данные: Copernicus GloFAS v4, Open-Meteo (погода/почва/высоты), ISRIC SoilGrids (через WM.soil, общий кэш),
 *         OpenStreetMap Overpass (геометрия, is_in, расстояния до русел).
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const PROXY = 'https://weather-soil-proxy.sylar1907942.workers.dev/';
  const CACHE_TTL = 20 * 60 * 1000;
  const memCache = new Map();
  let abortController = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const sgn = v => (v > 0 ? '+' : '') + v;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  function ensureStyles() {
    if (document.getElementById('gx-shared-style')) return;
    const st = document.createElement('style');
    st.id = 'gx-shared-style';
    st.textContent = `
.gx-bar{height:8px;border-radius:6px;background:var(--bg-primary);border:1px solid var(--border);overflow:hidden}
.gx-bar>i{display:block;height:100%;border-radius:6px;transition:width .5s}
.gx-row{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;margin:5px 0}
.gx-row b{white-space:nowrap}
.gx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:6px;margin:8px 0}
.gx-stat{border:1px solid var(--border);border-radius:9px;padding:6px 8px;background:var(--bg-primary)}
.gx-stat small{display:block;color:var(--text-muted);font-size:10.5px;line-height:1.2}
.gx-stat b{font-size:13px;color:var(--text-main)}
.gx-note{font-size:11.5px;line-height:1.45;color:var(--text-muted)}
.gx-insights{margin:10px 0 0;padding:8px 10px;border-radius:9px;border:1px dashed var(--border);background:var(--bg-primary);font-size:12px;line-height:1.5;color:var(--text-main)}
.gx-insights div{margin:3px 0}
.gx-tabs{display:flex;gap:4px;margin:6px 0 8px}
.gx-tab{flex:1;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-main);border-radius:8px;padding:6px 2px;font-size:11.5px;cursor:pointer}
.gx-tab.active{border-color:var(--accent);color:var(--accent);font-weight:700}
.gx-table{width:100%;border-collapse:collapse;font-size:11px;color:var(--text-main)}
.gx-table th,.gx-table td{padding:3px 4px;border-bottom:1px solid var(--border);text-align:right;font-weight:500}
.gx-table th{color:var(--text-muted);font-size:10px}
.gx-table th:first-child,.gx-table td:first-child{text-align:left}
.gx-factor{display:flex;gap:6px;font-size:11.5px;line-height:1.4;margin:3px 0;color:var(--text-main)}
.gx-fpts{font-weight:800;min-width:34px;text-align:right}
.gx-svg{width:100%;height:auto;display:block}
.gx-svg text{fill:var(--text-muted)}
.gx-split{display:flex;gap:10px;align-items:center}
.gx-pill{display:inline-block;font-size:10.5px;font-weight:700;border:1px solid var(--border);border-radius:20px;padding:1px 8px}
.gx-alt{display:flex;align-items:center;gap:8px;font-size:11.5px;margin:4px 0}
.gx-alt .gx-bar{flex:1}
.gx-strip{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin:8px 0}
.gx-cell{border-radius:8px;padding:4px 2px;text-align:center;font-size:10px;color:#fff;line-height:1.25}
.gx-cell b{display:block;font-size:11.5px}
`;
    document.head.appendChild(st);
  }

  // =========================================================================
  // СЕТЬ
  // =========================================================================
  async function fetchJson(url, timeoutMs, outer) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (outer) {
      if (outer.aborted) throw new DOMException('Aborted', 'AbortError');
      outer.addEventListener('abort', onAbort, { once: true });
    }
    const tm = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let json = JSON.parse(await res.text());
      if (json && typeof json.contents === 'string') json = JSON.parse(json.contents);
      return json;
    } finally {
      clearTimeout(tm);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  }

  async function fetchWithFallback(url, timeoutMs = 5500, signal) {
    const enc = encodeURIComponent(url);
    try {
      return await fetchJson(PROXY + '?url=' + enc, timeoutMs, signal);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }
    return await Promise.any([
      url,
      PROXY + enc,
      'https://api.codetabs.com/v1/proxy?quest=' + enc,
      'https://allorigins.hexlet.app/raw?url=' + enc
    ].map(u => fetchJson(u, timeoutMs, signal)));
  }

  async function cached(key, fn) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
    const v = await fn();
    if (v != null && !(v && v.ok === false)) memCache.set(key, { t: Date.now(), v });
    return v;
  }

  const safe = (p, signal) => p.catch(e => { if (signal && signal.aborted) throw e; console.warn('[Water]', e); return null; });

  // =========================================================================
  // 1. GloFAS: речной сток, медиана/p75, прогноз на 3 недели
  // =========================================================================
  const LEVELS = {
    critical: { label: 'Критический разлив', color: '#ef4444', rank: 3 },
    high: { label: 'Высокая вода (выход на пойму)', color: '#f97316', rank: 2 },
    elevated: { label: 'Повышенный сток', color: '#eab308', rank: 1 },
    normal: { label: 'В пределах нормы', color: '#10b981', rank: 0 }
  };

  function floodLevelOf(q, f) {
    if (q >= f.p90) return 'critical';
    if (q >= f.p75) return 'high';
    if (q >= Math.max(f.median * 1.25, 0.05)) return 'elevated';
    return 'normal';
  }

  async function fetchGloFas(lat, lon, signal) {
    const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=river_discharge,river_discharge_median,river_discharge_max,river_discharge_p75&past_days=14&forecast_days=21`;
    const data = await fetchWithFallback(url, 6000, signal);
    if (!data || !data.daily || !Array.isArray(data.daily.time)) return null;
    const d = data.daily;
    const todayStr = new Date().toISOString().slice(0, 10);
    let ti = d.time.indexOf(todayStr);
    if (ti < 0) ti = Math.min(14, d.time.length - 1);

    const q = i => (d.river_discharge[i] != null ? d.river_discharge[i] : (d.river_discharge_max[i] != null ? d.river_discharge_max[i] : 0));
    const cur = q(ti);
    const median = d.river_discharge_median[ti] != null ? d.river_discharge_median[ti] : 0.5;
    const p75 = d.river_discharge_p75[ti] != null ? d.river_discharge_p75[ti] : median * 1.5;
    const p90 = p75 * 1.35; // оценка: GloFAS не отдаёт p90 в daily
    const f = { median, p75, p90 };

    let peakQ = 0, peakI = ti;
    for (let i = ti; i < d.time.length; i++) { if (q(i) > peakQ) { peakQ = q(i); peakI = i; } }
    const next = q(Math.min(d.time.length - 1, ti + 3));
    const trend = next > cur * 1.15 ? 'rising' : next < cur * 0.85 ? 'falling' : 'stable';

    const daily7 = [];
    for (let i = ti; i < Math.min(d.time.length, ti + 7); i++) daily7.push({ date: d.time[i], q: r1(q(i)), level: floodLevelOf(q(i), f) });

    return {
      hasCatchment: cur > 0.05 || median > 0.05 || peakQ > 0.05,
      cur: r1(cur), median: r1(median), p75: r1(p75), p90: r1(p90),
      level: floodLevelOf(cur, f), peakLevel: floodLevelOf(peakQ, f),
      peakQ: r1(peakQ), peakDate: d.time[peakI], peakInDays: peakI - ti,
      trend, daily7,
      times: d.time, q: d.time.map((_, i) => q(i)), med: d.river_discharge_median, p75Arr: d.river_discharge_p75, ti
    };
  }

  // =========================================================================
  // 2. Погода и почвенные датчики (14 суток истории + 7 суток прогноза)
  // =========================================================================
  async function fetchWeather(lat, lon, signal) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      `&hourly=temperature_2m,precipitation,snow_depth,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm,soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm` +
      `&daily=precipitation_sum,snowfall_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,precipitation_probability_max&past_days=14&forecast_days=7&timezone=auto`;
    const data = await fetchWithFallback(url, 7000, signal);
    if (!data || !data.hourly || !data.daily) return null;
    const h = data.hourly, d = data.daily;

    const nowStr = new Date(Date.now() + (data.utc_offset_seconds || 0) * 1000).toISOString();
    const nowHour = nowStr.slice(0, 13) + ':00';
    let ni = h.time.indexOf(nowHour);
    if (ni < 0) { ni = h.time.length - 1; for (let i = 0; i < h.time.length; i++) if (h.time[i] > nowHour) { ni = Math.max(0, i - 1); break; } }
    let di = d.time.indexOf(nowStr.slice(0, 10));
    if (di < 0) di = Math.min(14, d.time.length - 1);

    const num = v => (v == null || isNaN(v) ? 0 : Number(v));
    const hsum = (a, b) => { let s = 0; const arr = h.precipitation || []; for (let i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) s += num(arr[i]); return s; };
    const dsum = (arr, a, b) => { let s = 0; for (let i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) s += num(arr[i]); return s; };
    const P = d.precipitation_sum || [], ET = d.et0_fao_evapotranspiration || [];
    const hv = (arr, def) => (arr && arr[ni] != null ? arr[ni] : def);

    // Индекс предшествующих осадков: API = Σ P(k)·0.9^k (k = дни назад)
    let api = 0;
    for (let k = 0; k <= 13; k++) api += num(P[di - k]) * Math.pow(0.9, k);

    let maxHourFc = 0;
    for (let i = ni + 1; i <= Math.min(h.precipitation.length - 1, ni + 72); i++) maxHourFc = Math.max(maxHourFc, num(h.precipitation[i]));

    const snowNow = num(hv(h.snow_depth, 0)) * 100;
    const snowThen = num(h.snow_depth && h.snow_depth[Math.max(0, ni - 72)]) * 100;
    const airT = hv(h.temperature_2m, 8);
    const t0 = hv(h.soil_temperature_0cm, airT), t6 = hv(h.soil_temperature_6cm, t0), t18 = hv(h.soil_temperature_18cm, t6);
    const meltCm = Math.max(0, snowThen - snowNow);

    const m0_1 = hv(h.soil_moisture_0_to_1cm, 0.25);
    const m1_3 = hv(h.soil_moisture_1_to_3cm, m0_1);
    const m3_9 = hv(h.soil_moisture_3_to_9cm, m1_3);
    const m9_27 = hv(h.soil_moisture_9_to_27cm, m3_9);
    const m27_81 = hv(h.soil_moisture_27_to_81cm, m9_27);

    const s0 = Math.max(0, di - 13);
    return {
      m0_1, m1_3, m3_9, m9_27, m27_81,
      airT: r1(airT), t0: r1(t0), t6: r1(t6), t18: r1(t18),
      snowCm: Math.round(snowNow), meltCm: r1(meltCm),
      thawing: snowNow > 1 && airT > 0.8,
      frozenTop: t0 < -0.5 || t6 < -0.2, frozenDeep: t18 < -0.5,
      rain24: r1(hsum(ni - 23, ni)), rain72: r1(hsum(ni - 71, ni)), rain7: r1(dsum(P, di - 6, di)), rain14: r1(dsum(P, di - 13, di)),
      fc24: r1(hsum(ni + 1, ni + 24)), fc72: r1(hsum(ni + 1, ni + 72)), fc7: r1(dsum(P, di + 1, di + 6)),
      maxHourFc: r1(maxHourFc), api: r1(api),
      et7: r1(dsum(ET, di - 6, di)),
      series: { dates: d.time.slice(s0), precip: P.slice(s0).map(num), prob: (d.precipitation_probability_max || []).slice(s0), todayI: di - s0 }
    };
  }

  // =========================================================================
  // 3. OSM: геометрия, расстояния до русел и точное попадание в контуры (is_in)
  // =========================================================================
  function toXY(lat0, lon0, lat, lon) {
    const k = Math.cos(lat0 * Math.PI / 180);
    return [(lon - lon0) * 111320 * k, (lat - lat0) * 110574];
  }
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function minDist(lat, lon, geom) {
    const pts = (geom || []).filter(Boolean).map(g => toXY(lat, lon, g.lat, g.lon));
    if (!pts.length) return null;
    if (pts.length === 1) return Math.hypot(pts[0][0], pts[0][1]);
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, distSeg(0, 0, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    return m;
  }
  function elementDist(lat, lon, el) {
    if (el.type === 'node') return Math.round(Math.hypot(...toXY(lat, lon, el.lat, el.lon)));
    if (el.geometry) { const d = minDist(lat, lon, el.geometry); return d == null ? null : Math.round(d); }
    if (el.members) {
      let m = null;
      el.members.forEach(mb => { if (mb.geometry) { const d = minDist(lat, lon, mb.geometry); if (d != null && (m == null || d < m)) m = d; } });
      return m == null ? null : Math.round(m);
    }
    return null;
  }

  const WETLAND_TITLES = {
    bog: ['Верховое сфагновое болото (зыбун)', '🔴', 'danger'],
    fen: ['Низинное болото (топь)', '🌾', 'danger'],
    swamp: ['Лесное болото / топь', '🌲', 'danger'],
    marsh: ['Травянистый марш / плавни', '🌾', 'warning'],
    peatland: ['Торфяник (опасность провала)', '🟤', 'danger'],
    wet_meadow: ['Сырой заболоченный луг', '🌱', 'warning'],
    reedbed: ['Тростниковые заросли', '🌾', 'warning']
  };

  function classifyOsm(t) {
    if (t.waterway) {
      const w = t.waterway, nm = t.name ? ` «${t.name}»` : '';
      if (w === 'river' || w === 'canal') return { kind: 'river', title: `${w === 'canal' ? 'Канал' : 'Река'}${nm}`, icon: '🌊', severity: 'warning' };
      if (w === 'stream' || w === 'brook') return { kind: 'stream', title: `Ручей${nm}`, icon: '〰️', severity: 'info' };
      if (w === 'ditch' || w === 'drain') return { kind: 'ditch', title: 'Мелиоративная канава (дренаж)', icon: '⛏️', severity: 'info' };
      if (w === 'dam' || w === 'weir') return { kind: 'dam', title: `Плотина / запруда${nm}`, icon: '🧱', severity: 'warning' };
    }
    if (t.natural === 'wetland') {
      const w = WETLAND_TITLES[t.wetland] || [`Болото / топь${t.wetland ? ` (${t.wetland})` : ''}`, '🌾', 'warning'];
      return { kind: 'wetland', title: w[0], icon: w[1], severity: w[2], sub: t.wetland };
    }
    if (t.natural === 'water' || t.water) return { kind: 'water', title: t.water === 'oxbow' ? 'Старица (пойменный водоём)' : `Озеро / пруд${t.name ? ` «${t.name}»` : ''}`, icon: '🛶', severity: 'warning' };
    if (t.natural === 'spring') return { kind: 'spring', title: 'Родник', icon: '💦', severity: 'info' };
    if (t.flood_prone === 'yes') return { kind: 'flood_prone', title: 'Зона паводкового затопления', icon: '⚠️', severity: 'danger' };
    if (t.man_made === 'dyke') return { kind: 'dyke', title: 'Дамба / обвалование', icon: '🧱', severity: 'info' };
    if (t.highway) return { kind: 'road', title: 'Дорога', icon: '🛣️', severity: 'info' };
    return null;
  }

  const LAND_COVER = { forest: 'лес', wood: 'лес', meadow: 'луг', grass: 'луг', grassland: 'луг', farmland: 'поле', orchard: 'сад', residential: 'застройка', scrub: 'кустарник', heath: 'пустошь' };

  async function fetchOverpass(q, signal) {
    const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    let last;
    for (const h of hosts) {
      try { return await fetchWithFallback(h + '?data=' + encodeURIComponent(q), 10000, signal); }
      catch (e) { if (signal && signal.aborted) throw e; last = e; }
    }
    throw last;
  }

  async function fetchOsm(lat, lon, signal) {
    const empty = { ok: false, items: [], inside: {}, nearest: {}, pavedDist: null, landCover: null };
    try {
      const R = 900, G = 1500;
      const dLat = G / 111139, dLon = G / (111139 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
      const bbox = `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
      const at = `(around:${R},${lat.toFixed(5)},${lon.toFixed(5)})`;
      const q = `[out:json][timeout:14];
is_in(${lat.toFixed(5)},${lon.toFixed(5)})->.a;
(
 area.a["natural"~"^(wetland|water)$"];
 area.a["landuse"~"^(reservoir|basin|forest|meadow|farmland|orchard|grass|residential)$"];
 area.a["natural"~"^(wood|scrub|grassland|heath)$"];
 area.a["flood_prone"="yes"];
)->.in;
(
 nwr["natural"~"^(wetland|spring)$"]${at};
 way["waterway"~"^(river|stream|canal|ditch|drain|brook|dam|weir)$"]${at};
 nwr["natural"="water"]${at};
 nwr["flood_prone"="yes"]${at};
 way["man_made"="dyke"]${at};
 way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)$"](around:100,${lat.toFixed(5)},${lon.toFixed(5)});
)->.near;
.in out tags;
.near out tags geom(${bbox}) 160;`;

      const json = await fetchOverpass(q, signal);
      if (!json || !Array.isArray(json.elements)) return empty;

      const inside = {};
      let landCover = null;
      const map = new Map();
      let pavedDist = null;

      json.elements.forEach(el => {
        const t = el.tags || {};
        if (el.type === 'area') {
          const c = classifyOsm(t);
          if (c && ['wetland', 'water', 'flood_prone'].includes(c.kind)) {
            const key = c.kind === 'flood_prone' ? 'floodProne' : c.kind;
            if (!inside[key]) inside[key] = c;
          } else {
            const lc = LAND_COVER[t.landuse] || LAND_COVER[t.natural];
            if (lc && !landCover) landCover = lc;
          }
          return;
        }
        const c = classifyOsm(t);
        if (!c) return;
        const dist = elementDist(lat, lon, el);
        if (c.kind === 'road') { if (dist != null && (pavedDist == null || dist < pavedDist)) pavedDist = dist; return; }
        const key = `${c.kind}|${c.title}`;
        const prev = map.get(key);
        if (!prev || (dist != null && (prev.dist == null || dist < prev.dist))) map.set(key, { ...c, dist, tags: t });
      });

      const items = Array.from(map.values()).sort((a, b) => (a.dist == null ? 9999 : a.dist) - (b.dist == null ? 9999 : b.dist));
      const nearest = {};
      items.forEach(it => { if (it.dist != null && (!nearest[it.kind] || it.dist < nearest[it.kind].dist)) nearest[it.kind] = it; });

      return { ok: true, items, inside, nearest, pavedDist, landCover };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      console.warn('[Water] Overpass:', e);
      return empty;
    }
  }

  // =========================================================================
  // АНАЛИЗ: предрасположенность × активация + пойма
  // =========================================================================
  function analyze(ctx) {
    const { flood, osm, wx, terrain, soil } = ctx;
    const F = [];
    const add = (pts, text) => F.push({ pts, text });
    const month = new Date().getMonth() + 1;

    // ---- 1. СТАТИКА: рельеф ----
    let topoS = 0;
    if (terrain) {
      if (terrain.isDepression) { const p = Math.round(clamp(15 + terrain.deltaLocal * 6, 15, 26)); topoS += p; add(p, `Котловина: вогнутость +${terrain.deltaLocal} м при уклоне ${terrain.slopeDeg}° — чаша сбора воды`); }
      else if (terrain.isValleyBottom) { topoS += 18; add(18, `Дно лощины: на ${Math.abs(terrain.rel300)} м ниже окрестности 300 м`); }
      else if (terrain.isRidge) { topoS -= 10; add(-10, 'Гребень / водораздел: вода не задерживается'); }
      if (!terrain.isFlat && terrain.hLow <= 1) { topoS += 8; add(8, `Всего ${terrain.hLow} м над ближайшим понижением в радиусе 750 м`); }
      if (terrain.isFlat) { topoS += 8; add(8, 'Плоская местность (перепад < 3 м на 750 м): сток слабый'); }
      const sl = terrain.slopeDeg;
      if (sl >= 8) { topoS -= 25; add(-25, `Крутой склон ${sl}°: вода уходит гравитационно`); }
      else if (sl >= 5) { topoS -= 15; add(-15, `Уклон ${sl}°: стоячая вода невозможна`); }
      else if (sl >= 3) { topoS -= 8; add(-8, `Уклон ${sl}° помогает стоку`); }
    }
    topoS = clamp(topoS, 0, 40);

    // ---- 2. СТАТИКА: почва ----
    let soilS = 0, aquitardCm = null;
    if (soil) {
      if (soil.socRoot >= 120) { soilS += 30; add(30, `Торфяная почва (SOC ${soil.socRoot} г/кг): пористость до ${Math.round(soil.hydro.thetaS * 100)}%, вода удерживается`); }
      else if (soil.socRoot >= 70) { soilS += 18; add(18, `Оторфованная гумусная почва (SOC ${soil.socRoot} г/кг)`); }
      if (soil.clay >= 40) { soilS += 14; add(14, `Тяжёлая глина (${soil.clay}%): водоупор, Ksat ≈ ${soil.hydro.ks} мм/ч`); }
      else if (soil.clay >= 28) { soilS += 8; add(8, `Тяжёлый суглинок (глина ${soil.clay}%): замедленная фильтрация`); }
      const p = soil.profile || [];
      if (p[3] && p[3].clay != null && p[2] && p[2].clay != null && p[3].clay >= 35 && p[3].clay >= soil.clay + 15) {
        soilS += 8; aquitardCm = 30; add(8, `Глинистый водоупор на глубине ~30 см (глина ${Math.round(p[3].clay)}% против ${soil.clay}% сверху): весной и осенью «верховодка»`);
      }
      if (soil.hydro.ks < 5 && soil.clay < 28) { soilS += 6; add(6, `Низкая фильтрация (Ksat ${soil.hydro.ks} мм/ч)`); }
      if (soil.sand >= 65 && soil.hydro.ks >= 40) { soilS -= 12; add(-12, `Песок ${soil.sand}%: Ksat ${soil.hydro.ks} мм/ч, вода уходит мгновенно`); }
    }
    soilS = clamp(soilS, 0, 30);

    // ---- 3. СТАТИКА: карта (OSM) ----
    let mapS = 0;
    const ins = osm.inside || {}, nr = osm.nearest || {};
    if (osm.ok) {
      if (ins.water) { mapS += 30; add(30, `Точка внутри водоёма OSM: «${ins.water.title}»`); }
      else if (ins.wetland) { mapS += 30; add(30, `Точка внутри контура болота OSM: ${ins.wetland.title}`); }
      else if (nr.wetland && nr.wetland.dist <= 50) { mapS += 24; add(24, `Болото в ${nr.wetland.dist} м: ${nr.wetland.title}`); }
      else if (nr.wetland && nr.wetland.dist <= 150) { mapS += 14; add(14, `Болото в ${nr.wetland.dist} м: ${nr.wetland.title}`); }
      else if (nr.wetland && nr.wetland.dist <= 400) { mapS += 6; add(6, `Болото в ${nr.wetland.dist} м (возможна подпитка грунтовыми водами)`); }
      if (ins.floodProne) { mapS += 20; add(20, 'Зона периодического паводка (OSM flood_prone)'); }
      if (nr.stream && nr.stream.dist <= 40) { mapS += 10; add(10, `Ручей в ${nr.stream.dist} м`); }
      if (nr.spring && nr.spring.dist <= 100) { mapS += 10; add(10, `Родник в ${nr.spring.dist} м: подпитка склона`); }
      if (nr.dam && nr.dam.dist <= 300) { mapS += 5; add(5, `${nr.dam.title} в ${nr.dam.dist} м: подпор воды`); }
      if (nr.ditch && nr.ditch.dist <= 100) { mapS -= 5; add(-5, `Канава в ${nr.ditch.dist} м: местный дренаж`); }
      if (osm.pavedDist != null && osm.pavedDist <= 40) { mapS -= 10; add(-10, `Дорога с твёрдым покрытием в ${osm.pavedDist} м: насыпь и водоотвод`); }
    }
    mapS = clamp(mapS, 0, 30);

    const susceptibility = clamp(topoS + soilS + mapS, 0, 100);

    // ---- 4. ДИНАМИКА: погода ----
    let dynamic = 0, deepSat = 0, topIdx = null;
    const dyn = [];
    if (wx) {
      const fc = soil ? soil.hydro.fc : 0.30, ths = soil ? soil.hydro.thetaS : 0.44;
      const idx = m => (m - fc) / Math.max(0.05, ths - fc);
      const top = (wx.m0_1 + wx.m1_3 + wx.m3_9) / 3, deep = (wx.m9_27 + wx.m27_81) / 2;
      topIdx = idx(top);
      const topAct = clamp((idx(top) + 0.3) / 1.1, 0, 1), deepAct = clamp((idx(deep) + 0.3) / 1.1, 0, 1);
      deepSat = idx(deep);
      const apiAct = clamp(wx.api / 30, 0, 1), rainAct = clamp(wx.rain72 / 40, 0, 1), fcAct = clamp(wx.fc72 / 35, 0, 1);
      dynamic = 100 * (0.30 * topAct + 0.20 * deepAct + 0.20 * apiAct + 0.15 * rainAct + 0.15 * fcAct);
      if (wx.thawing) { const b = clamp(wx.meltCm * 3, 5, 20); dynamic += b; dyn.push(`Снеготаяние: покров ${wx.snowCm} см, воздух ${sgn(wx.airT)}°C (+${Math.round(b)} к активации)`); }
      if ((wx.frozenTop || wx.frozenDeep) && (wx.rain72 > 3 || wx.thawing)) { dynamic += 10; dyn.push('Мёрзлый грунт не впитывает дождь и талые воды: идёт поверхностный сток'); }
      dynamic = clamp(dynamic, 0, 100);

      if (topIdx > 0.8) dyn.push(`Верхние слои (0–9 см) насыщены: ${Math.round(top * 100)}% при полевой влагоёмкости ${Math.round(fc * 100)}%`);
      else if (topIdx > 0) dyn.push(`Верхние слои выше полевой влагоёмкости (${Math.round(top * 100)}% при ${Math.round(fc * 100)}%): появляется гравитационная вода`);
      else dyn.push(`Верхние слои ниже полевой влагоёмкости (${Math.round(top * 100)}% при ${Math.round(fc * 100)}%): почва впитывает воду`);
      if (deepSat > 0.7) dyn.push('Глубокие слои (9–81 см) заполнены: дренаж остановлен, воде некуда уходить');
      dyn.push(`Индекс предшествующих осадков ${wx.api} мм (14 дн: ${wx.rain14} мм), за 72 ч: ${wx.rain72} мм`);
      if (wx.fc72 >= 10) dyn.push(`Прогноз 72 ч: ${wx.fc72} мм (пик интенсивности до ${wx.maxHourFc} мм/ч)`);
    }

    // ---- 5. ПОЙМА И РЕЧНОЙ РАЗЛИВ ----
    let floodPos = 'out', dRiver = nr.river ? nr.river.dist : null;
    if (ins.floodProne) floodPos = 'in';
    else if (dRiver != null) {
      if (dRiver <= 150 && (!terrain || terrain.hLow <= 3.5)) floodPos = 'in';
      else if (dRiver <= 400 && (!terrain || terrain.hLow <= 6)) floodPos = 'near';
    }
    if (floodPos === 'out' && terrain && terrain.isValleyBottom && (dRiver == null ? !osm.ok : dRiver <= 800)) floodPos = 'near';

    let floodScore = 0, floodText = '', floodActive = false;
    const hasFlood = flood && flood.hasCatchment;
    if (hasFlood) {
      const lvl = Math.max(LEVELS[flood.level].rank, Math.round(LEVELS[flood.peakLevel].rank * 0.85));
      const base = [0, 38, 62, 85][lvl];
      const mult = floodPos === 'in' ? 1 : floodPos === 'near' ? 0.7 : 0.15;
      floodScore = Math.round(base * mult);
      if (floodPos === 'out') floodScore = Math.min(floodScore, 20);
      floodActive = floodScore >= 30;
      const posTxt = floodPos === 'in' ? 'точка в пойме' : floodPos === 'near' ? 'точка на границе поймы' : 'точка вне поймы';
      floodText = `${LEVELS[flood.level].label}: ${flood.cur} м³/с (норма ${flood.median}, порог поймы ${flood.p75}); ${posTxt}${dRiver != null ? `, до реки ${dRiver} м` : ''}${terrain ? `, ${terrain.hLow} м над ближайшим понижением` : ''}.`;
      if (floodScore >= 30) add(floodScore, `Речной разлив (GloFAS): ${floodText}`);
    } else {
      floodText = 'Рядом нет моделируемого речного стока GloFAS (сетка ~5 км, бассейн от ~1000 км²).';
    }

    // ---- 6. ИТОГ ----
    const peat = !!(soil && soil.socRoot >= 120);
    const isWetland = !!(ins.wetland || ins.water);
    let risk = susceptibility * (0.30 + 0.70 * dynamic / 100);
    if (!wx) risk = susceptibility * 0.65;
    if (peat || isWetland) risk = Math.max(risk, 62 + 0.30 * dynamic);
    const floodDriven = floodScore > risk;
    risk = Math.max(risk, floodScore);

    const capNotes = [];
    if (terrain && terrain.isSteep && !isWetland && !peat && !floodActive) { if (risk > 45) capNotes.push('Крутой склон ограничивает оценку: глубокая стоячая вода невозможна'); risk = Math.min(risk, 45); }
    if (osm.pavedDist != null && osm.pavedDist <= 25 && !floodActive) { risk = Math.min(risk, 45); }
    if (soil && soil.sand >= 70 && soil.hydro.ks >= 40 && deepSat < 0.8 && !isWetland && !peat && !floodActive && !(nr.stream && nr.stream.dist <= 40)) { risk = Math.min(risk, 30); }
    risk = clamp(Math.round(risk), 5, 98);

    // ---- 7. ВЕРДИКТ ----
    let v;
    if (floodDriven && risk >= 60) {
      v = { title: floodPos === 'in' ? 'Пойма под водой / риск затопления' : 'Подтопление у поймы', color: '#ef4444', icon: '🌊',
        walk: 'Не заходить: вода на пойме может быть выше колена, течение и ямы скрыты.', car: 'Проезд опасен: размытые съезды и дороги в пойме.', gear: 'Вейдерсы, шест для промера, спасжилет; лучше обойти по возвышенности.' };
    } else if (risk >= 78) {
      v = { title: isWetland ? 'Топь / болото' : 'Глубокое затопление / непроходимая топь', color: '#ef4444', icon: isWetland ? '🌾' : '🌊',
        walk: 'Крайне тяжело или невозможно: провал выше колена, возможен зыбун.', car: 'Закрыто для колёсной техники. Только болотоходы и лодки.', gear: 'Вейдерсы или бродни, жердь для промера, спасжилет или лодка.' };
    } else if (risk >= 58) {
      v = { title: (soil && soil.clay >= 35) ? 'Вязкая глина / колеи с водой' : 'Сильная заболоченность / верховодка', color: '#f97316', icon: '⚠️',
        walk: 'Тяжёлое движение: жижа, глубокие лужи, погружение по щиколотку и выше.', car: 'Только подготовленные внедорожники (MT-резина, пониженная, лебёдка). Кроссоверы сядут.', gear: 'Бродни или высокие резиновые сапоги. Авто: трос, лопата, траки.' };
    } else if (risk >= 36) {
      v = { title: 'Умеренная сырость / локальная грязь', color: '#eab308', icon: '🌦️',
        walk: 'Проходимо в влагозащищённой обуви, местами лужи и размокший дёрн.', car: 'Легковой проедет осторожно. Риск пробуксовки в низинах и на мокрой глине.', gear: 'Ботинки с мембраной или невысокие сапоги.' };
    } else {
      v = { title: 'Сухой устойчивый грунт', color: '#10b981', icon: '🟢',
        walk: 'Свободное движение в любой обуви.', car: 'Свободный проезд для гражданского транспорта.', gear: 'Дренаж хороший, специальное снаряжение не нужно.' };
    }
    if (wx && (wx.frozenTop) && risk < 78) v.walk += ' Земля мёрзлая: при оттепели с дождём ситуация быстро ухудшится.';

    // ---- 8. ПРОГНОЗ 72 ч ----
    let outlook = { tone: 'same', text: 'Без резких изменений в ближайшие 3 суток.' };
    if (wx) {
      if (wx.fc72 >= 20) outlook = { tone: 'worse', text: `Ожидается ~${wx.fc72} мм осадков за 72 ч: ситуация ухудшится, особенно в низинах и на глине.` };
      else if (wx.fc72 >= 8) outlook = { tone: 'worse', text: `Осадки ~${wx.fc72} мм за 72 ч: возможное небольшое ухудшение.` };
      else if (wx.fc72 < 3) {
        const slow = soil && (soil.hydro.ks < 5 || soil.socRoot >= 70);
        outlook = { tone: 'better', text: slow ? 'Сухая погода: подсыхание идёт, но торф и глина отдают воду неделями.' : 'Сухая погода: грунт будет подсыхать в ближайшие дни.' };
      }
      if (hasFlood && flood.peakLevel !== 'normal' && flood.peakInDays > 0 && LEVELS[flood.peakLevel].rank > LEVELS[flood.level].rank) {
        outlook.text += ` Пик реки (${LEVELS[flood.peakLevel].label.toLowerCase()}, ${flood.peakQ} м³/с) ожидается ${flood.peakDate} (через ${flood.peakInDays} дн).`;
      }
    }

    return { susceptibility, dynamic: Math.round(dynamic), risk, v, outlook, parts: { topoS, soilS, mapS }, factors: F, dyn, capNotes,
      floodPos, floodScore, floodText, floodDriven, dRiver, aquitardCm, topIdx, deepSat, month, peat, isWetland };
  }

  // =========================================================================
  // ВИЗУАЛИЗАЦИЯ
  // =========================================================================
  const statBox = (label, value) => `<div class="gx-stat"><small>${label}</small><b>${value}</b></div>`;

  function renderPrecipChart(wx) {
    const s = wx && wx.series;
    if (!s || s.dates.length < 4) return '';
    const n = s.dates.length, w = 420, h = 118, pL = 28, pR = 8, pT = 10, pB = 22;
    const pw = w - pL - pR, ph = h - pT - pB, bw = pw / n;
    const maxP = Math.max(10, ...s.precip);
    const y = v => pT + ph - (v / maxP) * ph;
    const cx = i => pL + i * bw + bw / 2;
    const bars = s.precip.map((v, i) => {
      if (!v) return '';
      const col = i < s.todayI ? '#0284c7' : i === s.todayI ? '#0ea5e9' : '#7dd3fc';
      const pr = s.prob[i] != null ? ` (вероятность ${s.prob[i]}%)` : '';
      return `<rect x="${(pL + i * bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(pT + ph - y(v)).toFixed(1)}" fill="${col}" opacity="0.88"><title>${s.dates[i]}: ${v.toFixed(1)} мм${pr}</title></rect>`;
    }).join('');
    const labels = s.dates.map((d, i) => (i % 3 === 0 || i === s.todayI) ? `<text x="${cx(i).toFixed(1)}" y="${h - 7}" font-size="8.5" text-anchor="middle">${d.slice(8, 10)}.${d.slice(5, 7)}</text>` : '').join('');
    return `
      <svg viewBox="0 0 ${w} ${h}" class="gx-svg">
        <line x1="${pL}" y1="${pT + ph}" x2="${w - pR}" y2="${pT + ph}" stroke="var(--border)"/>
        ${bars}
        <line x1="${cx(s.todayI).toFixed(1)}" y1="${pT}" x2="${cx(s.todayI).toFixed(1)}" y2="${pT + ph}" stroke="var(--accent)" stroke-dasharray="4,3"/>
        <text x="${pL - 4}" y="${pT + 8}" font-size="8.5" text-anchor="end">${Math.round(maxP)} мм</text>
        ${labels}
      </svg>
      <div class="gx-note">Осадки по суткам: тёмные — факт (14 дн), светлые — прогноз. Пунктир — сегодня.</div>`;
  }

  function renderHydrograph(flood) {
    if (!flood || !flood.hasCatchment || flood.q.length < 5) return '';
    const w = 420, h = 112, pL = 34, pR = 10, pT = 12, pB = 22;
    const pw = w - pL - pR, ph = h - pT - pB;
    const maxV = Math.max(...flood.q, ...flood.p75Arr.filter(v => v != null), 1) * 1.18;
    const gx = i => pL + (i / (flood.times.length - 1)) * pw;
    const gy = v => pT + ph - ((v || 0) / maxV) * ph;
    const pts = arr => arr.map((v, i) => `${gx(i).toFixed(1)},${gy(v).toFixed(1)}`).join(' ');
    const tx = gx(flood.ti).toFixed(1);
    const peakX = gx(flood.ti + flood.peakInDays).toFixed(1);
    return `
      <div class="water-hydrograph-wrap">
        <svg viewBox="0 0 ${w} ${h}" class="gx-svg">
          <line x1="${pL}" y1="${gy(0)}" x2="${w - pR}" y2="${gy(0)}" stroke="var(--border)"/>
          <line x1="${tx}" y1="${pT}" x2="${tx}" y2="${h - pB}" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4,4"/>
          <text x="${tx}" y="${h - 7}" font-size="9" font-weight="700" text-anchor="middle" style="fill:var(--accent)">Сегодня</text>
          <polyline points="${pts(flood.p75Arr)}" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-dasharray="3,3"/>
          <polyline points="${pts(flood.med)}" fill="none" stroke="#64748b" stroke-width="1.4" stroke-dasharray="4,4" opacity="0.8"/>
          <polyline points="${pts(flood.q)}" fill="none" stroke="#0284c7" stroke-width="2.4"/>
          ${flood.peakInDays > 0 && flood.peakLevel !== 'normal' ? `<circle cx="${peakX}" cy="${gy(flood.peakQ).toFixed(1)}" r="3.5" fill="#ef4444"/>` : ''}
          <text x="${pL - 5}" y="${pT + 8}" font-size="8.5" text-anchor="end">${Math.round(maxV)}</text>
          <text x="${pL - 5}" y="${gy(0)}" font-size="8.5" text-anchor="end">0</text>
        </svg>
        <div class="water-hydrograph-legend">
          <span><b style="color:#0284c7;">—</b> Расход (м³/с)</span>
          <span><b style="color:#64748b;">---</b> Медиана сезона</span>
          <span><b style="color:#f59e0b;">···</b> Порог поймы p75</span>
        </div>
      </div>`;
  }

  function renderFloodStrip(flood) {
    if (!flood || !flood.hasCatchment) return '';
    return `<div class="gx-strip">${flood.daily7.map((d, i) => `
      <div class="gx-cell" style="background:${LEVELS[d.level].color};" title="${d.date}: ${d.q} м³/с — ${LEVELS[d.level].label}">${i === 0 ? 'сегодня' : d.date.slice(8, 10) + '.' + d.date.slice(5, 7)}<b>${d.q}</b></div>`).join('')}</div>`;
  }

  function renderMoistureLayers(wx, soil, A) {
    const fc = soil ? soil.hydro.fc : 0.30, ths = soil ? soil.hydro.thetaS : 0.44;
    const layers = [['0–1 см', wx.m0_1], ['1–3 см', wx.m1_3], ['3–9 см', wx.m3_9], ['9–27 см', wx.m9_27], ['27–81 см', wx.m27_81]];
    return layers.map(([lbl, m]) => {
      const pct = clamp(m / ths * 100, 2, 100), fcPct = clamp(fc / ths * 100, 0, 100);
      const idx = (m - fc) / Math.max(0.05, ths - fc);
      const col = idx > 0.8 ? '#ef4444' : idx > 0.2 ? '#f97316' : idx > 0 ? '#eab308' : '#0284c7';
      return `<div class="gx-row"><span class="gx-note" style="min-width:56px;">${lbl}</span><div class="gx-bar" style="flex:1;position:relative;"><i style="width:${pct}%;background:${col}"></i><span style="position:absolute;left:${fcPct}%;top:0;bottom:0;width:2px;background:var(--text-main);opacity:.55;"></span></div><b style="min-width:38px;text-align:right;">${Math.round(m * 100)}%</b></div>`;
    }).join('') + `<div class="gx-note">Чёрная метка — полевая влагоёмкость (${Math.round(fc * 100)}%): выше неё в почве появляется свободная вода. Правый край шкалы — полное насыщение (${Math.round(ths * 100)}%).</div>`;
  }

  function renderWaterModalResult(ctx) {
    const content = document.getElementById('water-diagnosis-content');
    if (!content) return;
    ensureStyles();
    const { flood, osm, wx, terrain, soil, lat, lon } = ctx;
    const A = analyze(ctx);
    const v = A.v;

    const factorsUp = A.factors.filter(f => f.pts > 0).sort((a, b) => b.pts - a.pts);
    const factorsDown = A.factors.filter(f => f.pts < 0).sort((a, b) => a.pts - b.pts);
    const fRow = f => `<div class="gx-factor"><span class="gx-fpts" style="color:${f.pts > 0 ? '#ef4444' : '#10b981'}">${f.pts > 0 ? '+' : ''}${f.pts}</span><span>${esc(f.text)}</span></div>`;

    const outTone = A.outlook.tone === 'worse' ? '#f97316' : A.outlook.tone === 'better' ? '#10b981' : 'var(--text-muted)';
    const outIcon = A.outlook.tone === 'worse' ? '📈' : A.outlook.tone === 'better' ? '📉' : '➡️';

    const insights = [];
    insights.push(`🏞️ <b>Место:</b> предрасположенность к воде ${A.susceptibility}% (рельеф ${A.parts.topoS}/40, почва ${A.parts.soilS}/30, карта ${A.parts.mapS}/30).`);
    insights.push(`☔ <b>Погода сейчас:</b> активация ${A.dynamic}%${wx ? ` (осадки 72 ч ${wx.rain72} мм, индекс влаги API ${wx.api} мм)` : ' (нет метеоданных)'}.`);
    if (A.peat || A.isWetland) insights.push('🌾 Болото / торфяник: остаётся мокрым в любую погоду, меняется только глубина зыбуна.');
    insights.push(`🌊 <b>Река:</b> ${esc(A.floodText)}`);
    if (A.capNotes.length) insights.push('ℹ️ ' + esc(A.capNotes.join('; ')));
    if (osm.landCover) insights.push(`🌳 Покров по OSM: ${osm.landCover}.`);

    const floodLvl = flood && flood.hasCatchment ? LEVELS[flood.level] : null;
    const posLbl = A.floodPos === 'in' ? 'в пойме' : A.floodPos === 'near' ? 'на границе поймы' : 'вне поймы';
    const posCol = A.floodPos === 'in' ? '#ef4444' : A.floodPos === 'near' ? '#f97316' : '#10b981';

    const osmChips = osm.items.length ? osm.items.slice(0, 14).map(o => `
      <span class="water-osm-chip ${o.severity}"><span>${o.icon}</span><span>${esc(o.title)}${o.dist != null ? ` · ${o.dist} м` : ''}</span></span>`).join('') : '';
    const insChips = [osm.inside.wetland, osm.inside.water, osm.inside.floodProne].filter(Boolean).map(o => `
      <span class="water-osm-chip danger"><span>${o.icon}</span><span>Точка внутри: ${esc(o.title)}</span></span>`).join('');

    const notes = [];
    if (!wx) notes.push('метеоданные Open-Meteo недоступны: активация не рассчитана');
    if (!soil) notes.push('профиль почвы не загружен (модуль «Почва» или SoilGrids недоступны)');
    if (!terrain) notes.push('рельеф не загружен: оценка по положению в долине неполная');
    if (!osm.ok) notes.push('OpenStreetMap (Overpass) недоступен: болота и реки не учтены');
    if (!flood) notes.push('GloFAS недоступен');

    content.innerHTML = `
      <div class="water-hero-card" style="border-left:4.5px solid ${v.color};">
        <div class="water-hero-top">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:28px;">${v.icon}</span>
            <div>
              <h4 class="water-status-title" style="color:${v.color};margin:0;font-size:15px;">${esc(v.title)}</h4>
              <span class="water-status-sub">Итоговый риск воды и распутицы: <b>${A.risk}%</b></span>
            </div>
          </div>
          <span class="water-score-pill" style="border-color:${v.color};color:${v.color};font-size:12px;font-weight:800;">${A.risk} / 100</span>
        </div>
        <div class="gx-bar" style="margin-top:8px;"><i style="width:${A.risk}%;background:${v.color}"></i></div>

        <div class="gx-row" style="margin-top:10px;"><span class="gx-note">🏞️ Предрасположенность места</span><b>${A.susceptibility}%</b></div>
        <div class="gx-bar"><i style="width:${A.susceptibility}%;background:#8b5cf6"></i></div>
        <div class="gx-row"><span class="gx-note">☔ Активация погодой</span><b>${A.dynamic}%</b></div>
        <div class="gx-bar"><i style="width:${A.dynamic}%;background:#0284c7"></i></div>

        <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:12px;font-weight:700;">🚶 Пешеход: <span style="font-weight:400;">${esc(v.walk)}</span></div>
          <div style="font-size:12px;font-weight:700;">🚙 Транспорт: <span style="font-weight:400;">${esc(v.car)}</span></div>
          <div class="gx-note" style="color:var(--text-main);">🥾 <b>Экипировка:</b> ${esc(v.gear)}</div>
          <div style="font-size:12px;font-weight:700;color:${outTone};">${outIcon} Ближайшие 72 ч: <span style="font-weight:400;">${esc(A.outlook.text)}</span></div>
        </div>

        <div class="gx-insights"><div style="font-weight:800;">🔎 Как получен вывод</div>${insights.map(t => `<div>${t}</div>`).join('')}</div>
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>🌊 Разлив рек (Copernicus GloFAS)</span>
          ${floodLvl ? `<b style="color:${floodLvl.color};font-size:12px;">${flood.cur} м³/с ${flood.trend === 'rising' ? '↗' : flood.trend === 'falling' ? '↘' : '→'}</b>` : '<span class="muted" style="font-size:11px;">нет русловой сети</span>'}
        </div>
        <div class="gx-row"><span class="gx-note">Положение точки</span><b style="color:${posCol};">${posLbl}${A.dRiver != null ? ` · до реки ${A.dRiver} м` : ''}</b></div>
        ${terrain ? `<div class="gx-row"><span class="gx-note">Над ближайшим понижением (750 м)</span><b>${terrain.hLow} м</b></div>` : ''}
        <div class="gx-note" style="color:var(--text-main);margin:6px 0;">${esc(A.floodText)}</div>
        ${floodLvl ? `
          <div class="gx-note">Статус: <b style="color:${floodLvl.color};">${floodLvl.label}</b>. Порог высокой воды p75 — ${flood.p75} м³/с, критический (оценка p75×1.35) — ${flood.p90} м³/с.
          ${flood.peakInDays > 0 && flood.peakLevel !== 'normal' ? `<br>Прогноз пика: <b>${flood.peakQ} м³/с</b> ${flood.peakDate} (через ${flood.peakInDays} дн), ${LEVELS[flood.peakLevel].label.toLowerCase()}.` : ''}</div>
          ${renderFloodStrip(flood)}
          ${renderHydrograph(flood)}` : ''}
        <div class="gx-note" style="margin-top:4px;">GloFAS считает крупные реки на сетке ~5 км: для малых ручьёв и точек вне поймы его значения лишь индикатор.</div>
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>🧪 Влага почвы и баланс воды</span>
          ${wx && A.topIdx != null ? `<span style="font-size:11px;font-weight:700;color:var(--text-muted);">${A.topIdx > 0.8 ? 'верх насыщен' : A.topIdx > 0 ? 'выше ПВ' : 'ниже ПВ'}</span>` : ''}
        </div>
        ${wx ? `
          ${renderMoistureLayers(wx, soil, A)}
          <div class="gx-grid">
            ${statBox('Дождь 24 ч / 72 ч', `${wx.rain24} / ${wx.rain72} мм`)}
            ${statBox('Осадки 7 / 14 дн', `${wx.rain7} / ${wx.rain14} мм`)}
            ${statBox('Прогноз 24 ч / 72 ч', `${wx.fc24} / ${wx.fc72} мм`)}
            ${statBox('Баланс 7 дн (P−ET₀)', `${sgn(r1(wx.rain7 - wx.et7))} мм`)}
            ${statBox('Индекс API', `${wx.api} мм`)}
            ${statBox('Снег / таяние', `${wx.snowCm} см / ${wx.meltCm} см`)}
          </div>
          <div class="gx-note">Температура: воздух ${sgn(wx.airT)}°C, почва 0 см ${sgn(wx.t0)}°C, 18 см ${sgn(wx.t18)}°C${wx.frozenTop ? ' · <b>поверхность мёрзлая</b>' : ''}.</div>
          ${A.dyn.map(t => `<div class="gx-factor"><span class="gx-fpts">•</span><span>${esc(t)}</span></div>`).join('')}
          <div style="margin-top:6px;">${renderPrecipChart(wx)}</div>
        ` : '<div class="muted" style="font-size:11px;">Нет агрометеорологических данных.</div>'}
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>⚖️ Что повышает и что снижает риск</span></div>
        ${factorsUp.length ? `<div class="gx-note" style="font-weight:700;">Накапливают воду:</div>${factorsUp.map(fRow).join('')}` : '<div class="gx-note">Явных факторов накопления воды не найдено.</div>'}
        ${factorsDown.length ? `<div class="gx-note" style="font-weight:700;margin-top:6px;">Отводят воду:</div>${factorsDown.map(fRow).join('')}` : ''}
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>🗺️ Рельеф, грунт и объекты на карте</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:11.5px;line-height:1.45;">
          ${terrain ? `<div>• <b>Рельеф:</b> уклон <b>${terrain.slopeDeg}°</b>, вогнутость <b>${sgn(terrain.deltaLocal)} м</b>, к окрестности 300 м <b>${sgn(terrain.rel300)} м</b>, перепад 750 м <b>${terrain.range750} м</b> — ${terrain.isDepression ? 'котловина' : terrain.isValleyBottom ? 'дно лощины' : terrain.isRidge ? 'гребень' : terrain.isFlat ? 'равнина' : 'склон'}${terrain.aspectDeg != null ? `, вода стекает на ${terrain.aspectName.split(' ')[0]}` : ''}.</div>` : ''}
          ${soil ? `<div>• <b>Почва (SoilGrids):</b> глина <b>${soil.clay}%</b>, песок <b>${soil.sand}%</b>, SOC <b>${soil.socRoot} г/кг</b>${soil.socRoot >= 120 ? ' (торф)' : ''}; пористость <b>${Math.round(soil.hydro.thetaS * 100)}%</b>, ПВ <b>${Math.round(soil.hydro.fc * 100)}%</b>, Ksat <b>${soil.hydro.ks} мм/ч</b> — ${soil.hydro.drainage.label.toLowerCase()}${A.aquitardCm ? `; водоупор с ~${A.aquitardCm} см` : ''}.</div>` : ''}
          <div>
            <div style="font-weight:700;color:var(--text-main);margin-bottom:3px;">Объекты OSM (до 900 м, расстояние по геометрии):</div>
            ${osm.ok ? ((insChips || osmChips) ? `<div class="water-osm-chips">${insChips}${osmChips}</div>` : '<div class="muted" style="font-size:11px;text-align:left;">Болот, русел и водоёмов в радиусе 900 м по OSM нет.</div>') : '<div class="muted" style="font-size:11px;text-align:left;">OSM недоступен.</div>'}
          </div>
        </div>
      </div>

      ${notes.length ? `<div class="gx-note" style="margin:6px 2px;">⚠️ Неполные данные: ${notes.map(esc).join('; ')}.</div>` : ''}

      <div class="nav-actions-grid" style="margin-top:12px;">
        <button type="button" class="action-card-btn primary" id="btn-water-copy-report">📋 Скопировать гидроотчёт</button>
        <button type="button" class="action-card-btn" id="btn-water-to-soil">🧪 Почва и грибы</button>
      </div>

      <div class="inat-traits-source-note" style="margin-top:10px;">
        <span>📚 <b>Copernicus GloFAS v4</b>, <b>Open-Meteo</b>, <b>ISRIC SoilGrids</b>, <b>OSM Overpass</b>. Модель высот ~90 м; результат — оценка, а не полевое измерение.</span>
      </div>
    `;

    document.getElementById('btn-water-copy-report')?.addEventListener('click', () => {
      const plain = s => String(s).replace(/<[^>]+>/g, '');
      const text = [
        `🌊 Гидрологический отчёт [${lat.toFixed(5)}, ${lon.toFixed(5)}]:`,
        `• Вердикт: ${v.title} (риск ${A.risk}%; место ${A.susceptibility}%, погода ${A.dynamic}%)`,
        `• Пешеход: ${v.walk}`, `• Транспорт: ${v.car}`, `• Экипировка: ${v.gear}`,
        `• 72 ч: ${A.outlook.text}`,
        `• Река: ${A.floodText}`,
        terrain ? `• Рельеф: уклон ${terrain.slopeDeg}°, вогнутость ${sgn(terrain.deltaLocal)} м, над понижением ${terrain.hLow} м` : '',
        wx ? `• Осадки: 72 ч ${wx.rain72} мм, 14 дн ${wx.rain14} мм, прогноз 72 ч ${wx.fc72} мм, API ${wx.api} мм` : '',
        soil ? `• Почва: глина ${soil.clay}%, песок ${soil.sand}%, SOC ${soil.socRoot} г/кг, Ksat ${soil.hydro.ks} мм/ч` : '',
        osm.items.length ? `• OSM: ${osm.items.slice(0, 8).map(o => `${o.title}${o.dist != null ? ` (${o.dist} м)` : ''}`).join('; ')}` : '',
        ...A.factors.filter(f => Math.abs(f.pts) >= 10).slice(0, 6).map(f => `  ${f.pts > 0 ? '+' : ''}${f.pts}: ${plain(f.text)}`)
      ].filter(Boolean).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Гидрологический отчёт скопирован');
      });
    });

    document.getElementById('btn-water-to-soil')?.addEventListener('click', () => {
      closeWaterDiagnosisModal();
      if (WM.soil && WM.soil.runDiagnosisForCoords) WM.soil.runDiagnosisForCoords(lat, lon);
    });
  }

  // =========================================================================
  // ТОЧКА ВХОДА
  // =========================================================================
  async function runWaterDiagnosisForCoords(lat, lon) {
    const modal = document.getElementById('modal-water-diagnosis');
    const content = document.getElementById('water-diagnosis-content');
    const headerCoords = document.getElementById('water-diagnosis-coords');
    if (!modal || !content) return;

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    if (headerCoords) headerCoords.textContent = `📍 ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
    content.innerHTML = `
      <div class="soil-loading-wrap">
        <div class="lb-spinner" style="width:36px;height:36px;border-width:3px;border-top-color:#0284c7;"></div>
        <div class="soil-loading-text">Гидрологический синтез: GloFAS, рельеф, почва, OSM, погода…</div>
        <small class="hint-text" style="text-align:center;">Расстояния до русел, положение в пойме, влажность 5 слоёв, прогноз осадков</small>
      </div>`;

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('waterDiagnosis');

    try {
      const k = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
      const soilApi = WM.soil;
      const [flood, osm, wx, terrain, soil] = await Promise.all([
        safe(cached('f_' + k, () => fetchGloFas(lat, lon, signal)), signal),
        safe(cached('o_' + k, () => fetchOsm(lat, lon, signal)), signal),
        safe(cached('w_' + k, () => fetchWeather(lat, lon, signal)), signal),
        soilApi && soilApi.getTerrain ? safe(soilApi.getTerrain(lat, lon, signal), signal) : Promise.resolve(null),
        soilApi && soilApi.getSoilGrids ? safe(soilApi.getSoilGrids(lat, lon, signal), signal) : Promise.resolve(null)
      ]);
      if (signal.aborted) return;

      const osmSafe = osm || { ok: false, items: [], inside: {}, nearest: {}, pavedDist: null, landCover: null };
      if (!flood && !wx && !terrain && !soil && !osmSafe.ok) throw new Error('Не удалось получить ни один источник данных. Проверьте подключение к сети.');
      renderWaterModalResult({ flood, osm: osmSafe, wx, terrain, soil, lat, lon });
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      content.innerHTML = `
        <div class="sheet-empty-state" style="padding:24px 14px;">
          <div class="sheet-empty-icon">⚠️</div>
          <div class="sheet-empty-title">Не удалось загрузить гидроданные</div>
          <div class="sheet-empty-desc">${esc((err && err.message) || 'Ошибка подключения к серверам геоинформации.')}</div>
          <button type="button" class="btn btn-primary" id="btn-water-retry">↺ Повторить запрос</button>
        </div>`;
      document.getElementById('btn-water-retry')?.addEventListener('click', () => runWaterDiagnosisForCoords(lat, lon));
    }
  }

  function openWaterDiagnosis() {
    let lat, lon;
    const pickerMode = WM.picker ? WM.picker.getMode() : 'cross';
    if (pickerMode === 'cross' && WM.map) {
      const c = WM.map.getCenter(); lat = c.lat; lon = c.lng;
    } else if (WM.gpsState && WM.gpsState.lat != null) {
      lat = WM.gpsState.lat; lon = WM.gpsState.lng;
    } else if (WM.map) {
      const c = WM.map.getCenter(); lat = c.lat; lon = c.lng;
    } else {
      lat = 55.75124; lon = 37.61842;
    }
    runWaterDiagnosisForCoords(lat, lon);
  }

  function closeWaterDiagnosisModal(syncHistory = true) {
    if (abortController) { abortController.abort(); abortController = null; }
    const modal = document.getElementById('modal-water-diagnosis');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('waterDiagnosis');
  }

  function init() {
    const modal = document.getElementById('modal-water-diagnosis');
    if (!modal || modal._inited) return;
    modal._inited = true;
    ensureStyles();
    document.getElementById('water-diagnosis-close-x')?.addEventListener('click', () => closeWaterDiagnosisModal());
    document.getElementById('btn-water-diagnosis-close')?.addEventListener('click', () => closeWaterDiagnosisModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) closeWaterDiagnosisModal(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  WM.water = {
    init,
    openDiagnosis: openWaterDiagnosis,
    closeDiagnosisModal: closeWaterDiagnosisModal,
    runDiagnosisForCoords: runWaterDiagnosisForCoords
  };
})();