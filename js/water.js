/**
 * Wikimapia Viewer — модуль «Вода, разлив и заболоченность» (water.js) v3.2
 *
 * Архитектура отказоустойчивости по стандарту soil.js:
 *  - Прямой запрос -> Cloudflare Worker + Yandex Cloud Function -> публичные CORS-прокси
 *  - Overpass API: персональный ключ overpass.ch + зеркала РФ/ЕС + POST/GET fallback
 *  - Журнал сетевых запросов (Debug Trace Log) + Raw JSON Inspector для отладки
 *
 * v3.2:
 *  - Устранено занижение риска болот в сухую погоду (учет terrain.wetness и торфа при soc >= 80)
 *  - Корректная обработка OSM-полигонов при dist: null и dist: 0 (точка внутри контура)
 *  - Выделен отдельный статус для открытых водоемов (акваторий) взамен «болота/зыбуна»
 *  - Защита от деления на ноль и ложного «критического разлива» GloFAS при расходах < 0.5 м³/с
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const PROXY = 'https://weather-soil-proxy.sylar1907942.workers.dev/';
  const YANDEX_PROXY = 'https://functions.yandexcloud.net/d4e100u26krnn0mkl3ma';
  const OVERPASS_KEY = 'ovp_EV05aAhEX8JcD7JlrS5NoMyptMf2vkLi';
  const OVERPASS_MIRRORS = [
    `https://api.overpass.ch/v1/${OVERPASS_KEY}/interpreter`,
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  const CACHE_TTL = 30 * 60 * 1000;
  const memCache = new Map();
  let abortController = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const sgn = v => (v > 0 ? '+' : '') + v;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  // =========================================================================
  // СЕТЕВОЙ ТРЕЙС / DEBUG ЖУРНАЛ
  // =========================================================================
  const debugTraceLog = [];

  function logTrace(item) {
    debugTraceLog.unshift({
      time: new Date().toLocaleTimeString(),
      ...item
    });
    if (debugTraceLog.length > 25) debugTraceLog.pop();
  }

  function renderDebugAccordion() {
    if (!debugTraceLog.length) return '';
    const rows = debugTraceLog.slice(0, 20).map(tr => {
      const col = tr.ok ? '#16a34a' : '#ef4444';
      return `
        <div style="padding:5px 0; border-bottom:1px solid var(--border); font-size:11px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b>${esc(tr.channel)}</b>
            <span style="color:${col}; font-weight:700;">${esc(tr.status)} (${tr.ms} мс)</span>
          </div>
          <div style="margin-top:2px; word-break:break-all; font-family:monospace; font-size:10px;">
            <a href="${esc(tr.url)}" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:underline;">🔗 Открыть URL запроса в новой вкладке ↗</a>
          </div>
          ${tr.error ? `<div style="color:#ef4444; font-size:10px; margin-top:2px;">⚠️ ${esc(tr.error)}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <details style="margin-top:12px; border:1px dashed var(--border); border-radius:9px; padding:6px 10px; background:var(--bg-primary);">
        <summary style="cursor:pointer; font-weight:700; font-size:11.5px; color:var(--text-muted); user-select:none;">
          🐞 Журнал сетевых запросов (Debug Log: последние ${Math.min(debugTraceLog.length, 20)})
        </summary>
        <div style="margin-top:8px;">${rows}</div>
      </details>
    `;
  }

  function renderRawDataAccordion(ctx) {
    if (!ctx) return '';
    const safePayload = {
      timestamp: new Date().toISOString(),
      coordinates: { lat: ctx.lat, lon: ctx.lon },
      glofasFlood: ctx.flood || null,
      weatherAndMoisture: ctx.wx || null,
      osmHydrology: ctx.osm || null,
      terrainDEM: ctx.terrain || null,
      soilGrids: ctx.soil || null
    };

    const jsonStr = JSON.stringify(safePayload, null, 2);

    return `
      <details style="margin-top:8px; border:1px dashed var(--border); border-radius:9px; padding:6px 10px; background:var(--bg-primary);">
        <summary style="cursor:pointer; font-weight:700; font-size:11.5px; color:var(--text-muted); user-select:none; display:flex; justify-content:space-between; align-items:center;">
          <span>📦 Исходные сырые данные (Raw JSON: GloFAS, Почва, Метео, OSM)</span>
        </summary>
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; justify-content:flex-end;">
            <button type="button" class="btn btn-secondary" id="btn-water-copy-raw-json" style="font-size:11px; padding:4px 10px;">
              📋 Скопировать сырой JSON
            </button>
          </div>
          <pre id="water-raw-json-pre" style="max-height:240px; overflow:auto; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:8px; font-family:monospace; font-size:10.5px; line-height:1.35; user-select:text; margin:0; white-space:pre-wrap; word-break:break-word;">${esc(jsonStr)}</pre>
        </div>
      </details>
    `;
  }

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
.gx-strip-wrap { margin: 10px 0; display: flex; flex-direction: column; gap: 6px; }
.gx-strip-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; color: var(--text-muted); }
.gx-strip { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; width: 100%; }
.gx-cell { border-radius: 8px; padding: 6px 3px; text-align: center; font-size: 10px; color: var(--text-main); background: var(--bg-primary); border: 1.5px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.06); display: flex; flex-direction: column; align-items: center; gap: 3px; transition: transform 0.12s ease; min-width: 0; overflow: hidden; }
.gx-cell:hover { transform: translateY(-2px); }
.gx-cell-date { font-size: 9.5px; font-weight: 600; color: var(--text-muted); white-space: nowrap; line-height: 1.1; }
.gx-cell-val { font-size: 12.5px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gx-cell-unit { font-size: 8px; font-weight: 600; color: var(--text-muted); line-height: 1; }
.gx-cell-status-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 1px; }

.gx-cell.lvl-normal { border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.06); }
.gx-cell.lvl-normal .gx-cell-val { color: #10b981; }
.gx-cell.lvl-normal .gx-cell-status-dot { background: #10b981; }

.gx-cell.lvl-elevated { border-color: rgba(234, 179, 8, 0.5); background: rgba(234, 179, 8, 0.08); }
.gx-cell.lvl-elevated .gx-cell-val { color: #d97706; }
.gx-cell.lvl-elevated .gx-cell-status-dot { background: #eab308; }

.gx-cell.lvl-high { border-color: rgba(249, 115, 22, 0.6); background: rgba(249, 115, 22, 0.12); }
.gx-cell.lvl-high .gx-cell-val { color: #ea580c; }
.gx-cell.lvl-high .gx-cell-status-dot { background: #f97316; }

.gx-cell.lvl-critical { border-color: rgba(239, 68, 68, 0.7); background: rgba(239, 68, 68, 0.15); }
.gx-cell.lvl-critical .gx-cell-val { color: #dc2626; }
.gx-cell.lvl-critical .gx-cell-status-dot { background: #ef4444; }

@media (max-width: 420px) {
  .gx-strip { display: flex; overflow-x: auto; padding-bottom: 4px; scroll-snap-type: x mandatory; }
  .gx-cell { flex: 0 0 52px; scroll-snap-align: start; }
}
`;
    document.head.appendChild(st);
  }

  // =========================================================================
  // ТРАНСПОРТ ЗАПРОСОВ
  // =========================================================================
  async function fetchJson(url, timeoutMs, outer, channelName = 'Direct') {
    const ctl = new AbortController();
    const t0 = performance.now();
    let timedOut = false;

    const onAbort = () => ctl.abort();
    if (outer) {
      if (outer.aborted) throw new DOMException('Aborted', 'AbortError');
      outer.addEventListener('abort', onAbort, { once: true });
    }

    const tm = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);

    try {
      const res = await fetch(url, { signal: ctl.signal });
      const elapsed = Math.round(performance.now() - t0);
      const text = await res.text();

      if (!res.ok) {
        logTrace({ channel: channelName, url, status: `HTTP ${res.status}`, ok: false, ms: elapsed, error: text.slice(0, 120) });
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 80)}`);
      }

      let json = JSON.parse(text);
      if (json && typeof json.contents === 'string') json = JSON.parse(json.contents);

      logTrace({ channel: channelName, url, status: '200 OK', ok: true, ms: elapsed, error: null });
      return json;
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      const isAbort = err.name === 'AbortError' || err instanceof DOMException;
      const statusText = timedOut ? `⏱️ Таймаут (> ${timeoutMs / 1000} сек)` : (isAbort ? '⏹️ Отменён' : `❌ ${err.message || 'Ошибка CORS / сети'}`);
      logTrace({ channel: channelName, url, status: statusText, ok: false, ms: elapsed, error: err.message });
      throw err;
    } finally {
      clearTimeout(tm);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  }

  async function fetchWithFallback(url, timeoutMs = 6500, signal, reqName = 'WaterAPI') {
    try {
      return await fetchJson(url, timeoutMs, signal, `${reqName} (Direct)`);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }
    const enc = encodeURIComponent(url);

    try {
      const privateProxies = [fetchJson(PROXY + '?url=' + enc, timeoutMs, signal, `${reqName} (CF Worker)`)];
      if (YANDEX_PROXY && !YANDEX_PROXY.includes('YOUR_FUNCTION_ID')) {
        privateProxies.push(fetchJson(YANDEX_PROXY + '?url=' + enc, timeoutMs, signal, `${reqName} (Yandex Function)`));
      }
      return await Promise.any(privateProxies);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }

    return await Promise.any([
      fetchJson('https://allorigins.hexlet.app/raw?url=' + enc, timeoutMs, signal, `${reqName} (AllOrigins)`),
      fetchJson('https://api.codetabs.com/v1/proxy?quest=' + enc, timeoutMs, signal, `${reqName} (CodeTabs)`)
    ]);
  }

  async function cached(key, fn) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
    const v = await fn();
    if (v != null && !(v && v.ok === false)) memCache.set(key, { t: Date.now(), v });
    return v;
  }

  const safe = (p, signal) => p.catch(e => {
    if (signal && signal.aborted) throw e;
    console.warn('[Water]', e);
    return null;
  });

  // =========================================================================
  // 1. GloFAS
  // =========================================================================
  const LEVELS = {
    critical: { label: 'Критический разлив', color: '#ef4444', rank: 3 },
    high: { label: 'Высокая вода (выход на пойму)', color: '#f97316', rank: 2 },
    elevated: { label: 'Повышенный сток', color: '#eab308', rank: 1 },
    normal: { label: 'В пределах нормы', color: '#10b981', rank: 0 }
  };

  function floodLevelOf(q, f) {
    // Шумовой порог: при расходах менее 0.5 м³/с паводка быть не может
    if (q < 0.5) return 'normal';
    if (q >= f.p90 && f.p90 >= 1.0) return 'critical';
    if (q >= f.p75 && f.p75 >= 0.8 && f.p75 > f.median * 1.1) return 'high';
    if (q >= Math.max(f.median * 1.25, 0.8)) return 'elevated';
    return 'normal';
  }

  async function fetchGloFas(lat, lon, signal) {
    const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=river_discharge,river_discharge_median,river_discharge_max,river_discharge_p75&past_days=14&forecast_days=21`;
    const data = await fetchWithFallback(url, 7500, signal, 'Copernicus GloFAS');
    if (!data || !data.daily || !Array.isArray(data.daily.time)) return null;
    const d = data.daily;
    const todayStr = new Date().toISOString().slice(0, 10);
    let ti = d.time.indexOf(todayStr);
    if (ti < 0) ti = Math.min(14, d.time.length - 1);

    const q = i => (d.river_discharge[i] != null ? d.river_discharge[i] : (d.river_discharge_max[i] != null ? d.river_discharge_max[i] : 0));
    const cur = q(ti);
    const median = d.river_discharge_median[ti] != null ? d.river_discharge_median[ti] : 0.5;
    // Защита от схлопывания квантилей
    const p75Raw = d.river_discharge_p75[ti] != null ? d.river_discharge_p75[ti] : median * 1.5;
    const p75 = Math.max(p75Raw, median * 1.15);
    const p90 = p75 * 1.35;
    const f = { median, p75, p90 };

    let peakQ = 0, peakI = ti;
    for (let i = ti; i < d.time.length; i++) { if (q(i) > peakQ) { peakQ = q(i); peakI = i; } }
    const next = q(Math.min(d.time.length - 1, ti + 3));
    const trend = next > cur * 1.15 ? 'rising' : next < cur * 0.85 ? 'falling' : 'stable';

    const daily7 = [];
    for (let i = ti; i < Math.min(d.time.length, ti + 7); i++) daily7.push({ date: d.time[i], q: r1(q(i)), level: floodLevelOf(q(i), f) });

    const hasCatchment = cur >= 0.5 || median >= 0.5 || peakQ >= 0.8;

    return {
      hasCatchment,
      cur: r1(cur), median: r1(median), p75: r1(p75), p90: r1(p90),
      level: floodLevelOf(cur, f), peakLevel: floodLevelOf(peakQ, f),
      peakQ: r1(peakQ), peakDate: d.time[peakI], peakInDays: peakI - ti,
      trend, daily7,
      times: d.time, q: d.time.map((_, i) => q(i)), med: d.river_discharge_median, p75Arr: d.river_discharge_p75, ti
    };
  }

  // =========================================================================
  // 2. Погода и влажность почвы
  // =========================================================================
  async function fetchWeather(lat, lon, signal) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      `&hourly=temperature_2m,precipitation,snow_depth,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm,soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm` +
      `&daily=precipitation_sum,snowfall_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,precipitation_probability_max&past_days=14&forecast_days=7&timezone=auto`;
    const data = await fetchWithFallback(url, 7500, signal, 'Open-Meteo Agro');
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
  // 3. OSM
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
    if (t.natural === 'water' || t.water) {
      const isRiverWater = t.water === 'river' || (t.name && /волга|река/i.test(t.name));
      const title = isRiverWater ? `Река / акватория${t.name ? ` «${t.name}»` : ''}` : (t.water === 'oxbow' ? 'Старица (пойменный водоём)' : `Озеро / пруд${t.name ? ` «${t.name}»` : ''}`);
      return { kind: 'water', title, icon: '🛶', severity: 'warning', isRiverWater };
    }
    if (t.natural === 'spring') return { kind: 'spring', title: 'Родник', icon: '💦', severity: 'info' };
    if (t.flood_prone === 'yes') return { kind: 'flood_prone', title: 'Зона паводкового затопления', icon: '⚠️', severity: 'danger' };
    if (t.man_made === 'dyke') return { kind: 'dyke', title: 'Дамба / обвалование', icon: '🧱', severity: 'info' };
    if (t.highway) return { kind: 'road', title: 'Дорога', icon: '🛣️', severity: 'info' };
    return null;
  }

  const LAND_COVER = { forest: 'лес', wood: 'лес', meadow: 'луг', grass: 'луг', grassland: 'луг', farmland: 'поле', orchard: 'сад', residential: 'застройка', scrub: 'кустарник', heath: 'пустошь' };

  async function fetchOverpass(q, signal) {
    for (const mirrorUrl of OVERPASS_MIRRORS) {
      if (signal && signal.aborted) return null;

      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 6500);
      const t0 = performance.now();
      const isOverpassCh = mirrorUrl.includes('overpass.ch');
      const channelName = isOverpassCh ? 'OSM Water (overpass.ch)' : `OSM Water (${new URL(mirrorUrl).hostname})`;
      const debugUrl = `${mirrorUrl}?data=${encodeURIComponent(q)}`;

      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      try {
        let res;
        try {
          res = await fetch(mirrorUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json' },
            body: 'data=' + encodeURIComponent(q),
            signal: ctl.signal
          });
        } catch (postErr) {
          res = await fetch(debugUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: ctl.signal
          });
        }

        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAbort);
        const elapsed = Math.round(performance.now() - t0);

        if (res.ok) {
          const data = await res.json();
          logTrace({ channel: channelName, url: debugUrl, status: '200 OK', ok: true, ms: elapsed, error: null });
          return data;
        } else {
          const errText = await res.text().catch(() => '');
          logTrace({ channel: channelName, url: debugUrl, status: `HTTP ${res.status}`, ok: false, ms: elapsed, error: errText.slice(0, 100) });
        }
      } catch (e) {
        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAbort);
        const elapsed = Math.round(performance.now() - t0);
        logTrace({ channel: channelName, url: debugUrl, status: ctl.signal.aborted ? '⏱️ Таймаут (> 6.5 с)' : `❌ ${e.message || 'Ошибка сети / CORS'}`, ok: false, ms: elapsed, error: e.message });
      }
    }

    const fallbackUrl = OVERPASS_MIRRORS[0] + '?data=' + encodeURIComponent(q);
    return await fetchWithFallback(fallbackUrl, 8500, signal, 'OSM Water (Proxy Fallback)');
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
        const c = classifyOsm(t);

        // Если это результат is_in (любой тип) или полигон покрытия
        if (el.type === 'area' || (!el.geometry && !el.members && c)) {
          if (c && ['wetland', 'water', 'flood_prone'].includes(c.kind)) {
            const key = c.kind === 'flood_prone' ? 'floodProne' : c.kind;
            if (!inside[key]) inside[key] = c;
          } else {
            const lc = LAND_COVER[t.landuse] || LAND_COVER[t.natural];
            if (lc && !landCover) landCover = lc;
          }
          if (el.type === 'area') return;
        }

        if (!c) return;
        let dist = elementDist(lat, lon, el);

        // Если полигон окружает точку (dist === 0 или null для охватывающего контура)
        if (dist === 0 || dist == null) {
          if (['wetland', 'water', 'flood_prone'].includes(c.kind)) {
            const key = c.kind === 'flood_prone' ? 'floodProne' : c.kind;
            if (!inside[key]) inside[key] = { ...c, dist: 0 };
          }
        }

        if (c.kind === 'road') {
          if (dist != null && (pavedDist == null || dist < pavedDist)) pavedDist = dist;
          return;
        }

        const key = `${c.kind}|${c.title}`;
        const prev = map.get(key);
        if (!prev || (dist != null && (prev.dist == null || dist < prev.dist))) {
          map.set(key, { ...c, dist: dist == null ? 0 : dist, tags: t });
        }
      });

      const items = Array.from(map.values()).sort((a, b) => a.dist - b.dist);
      const nearest = {};
      items.forEach(it => {
        if (!nearest[it.kind] || it.dist < nearest[it.kind].dist) nearest[it.kind] = it;
      });

      return { ok: true, items, inside, nearest, pavedDist, landCover };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      console.warn('[Water] Overpass:', e);
      return empty;
    }
  }

  // =========================================================================
  // АНАЛИЗ И СИНТЕЗ
  // =========================================================================
  function analyze(ctx) {
    const { flood, osm, wx, terrain, soil } = ctx;
    const F = [];
    const add = (pts, text) => F.push({ pts, text });
    const month = new Date().getMonth() + 1;

    // Рельеф (0 - 40)
    let topoS = 0;
    if (terrain) {
      if (terrain.isDepression) {
        const p = Math.round(clamp(16 + terrain.deltaLocal * 5, 16, 28));
        topoS += p;
        add(p, `Котловина: вогнутость ${sgn(terrain.deltaLocal)} м — природная чаша сбора воды`);
      } else if (terrain.isValleyBottom) {
        topoS += 18;
        add(18, `Дно лощины / долины: на ${Math.abs(terrain.rel300)} м ниже окрестности`);
      } else if (terrain.isRidge) {
        topoS -= 12;
        add(-12, 'Гребень / холм: отличный гравитационный сток');
      }

      if (terrain.wetness > 0.75) {
        const wp = Math.round(terrain.wetness * 12);
        topoS += wp;
        add(wp, `Высокий топографический индекс увлажнения (${r1(terrain.wetness * 100)}%)`);
      }

      if (terrain.isFlat) {
        topoS += 8;
        add(8, 'Плоский рельеф: поверхностный сток затруднен');
      } else if (terrain.hLow <= 1.5 && !terrain.isRidge) {
        topoS += 8;
        add(8, `Низкое положение: всего ${terrain.hLow} м над понижением`);
      }

      const sl = terrain.slopeDeg;
      if (sl >= 8) { topoS -= 25; add(-25, `Крутой склон ${sl}°: вода стекает без задержки`); }
      else if (sl >= 4) { topoS -= 14; add(-14, `Уклон ${sl}°: застой воды невозможен`); }
    }
    topoS = clamp(topoS, 0, 40);

    // Почва (0 - 30)
    let soilS = 0, aquitardCm = null;
    const isWaterSoil = soil && soil.bdod === 0 && soil.soc === 0 && soil.sand === 0;

    if (soil && !isWaterSoil) {
      // Торф / оторфованная почва
      if (soil.socRoot >= 80 || soil.soc >= 130) {
        soilS += 30;
        add(30, `Торфяной / органогенный грунт (SOC ${soil.socRoot || soil.soc} г/кг): впитывает воду как губка`);
      } else if (soil.socRoot >= 50) {
        soilS += 16;
        add(16, `Высокое содержание органики (SOC ${soil.socRoot} г/кг)`);
      }

      if (soil.clay >= 40) {
        soilS += 14;
        add(14, `Тяжёлая глина (${soil.clay}%): водоупорный горизонт`);
      } else if (soil.clay >= 28) {
        soilS += 8;
        add(8, `Суглинок (${soil.clay}% глины): умеренное замедление дренажа`);
      }

      const p = soil.profile || [];
      if (p[3] && p[3].clay != null && p[2] && p[2].clay != null && p[3].clay >= 35 && p[3].clay >= soil.clay + 15) {
        soilS += 8; aquitardCm = 30;
        add(8, `Глинистый водоупор на глубине ~30 см: сезонная верховодка`);
      }

      if (soil.sand >= 65 && soil.hydro.ks >= 40 && soil.socRoot < 50) {
        soilS -= 14;
        add(-14, `Песок ${soil.sand}%: фильтрация ${soil.hydro.ks} мм/ч, вода быстро уходит вглубь`);
      }
    }
    soilS = clamp(soilS, 0, 30);

    // OSM объекты (0 - 30)
    let mapS = 0;
    const ins = osm.inside || {}, nr = osm.nearest || {};
    const hasInsideWater = !!(ins.water || (nr.water && nr.water.dist === 0));
    const hasInsideWetland = !!(ins.wetland || (nr.wetland && nr.wetland.dist === 0));

    if (osm.ok) {
      if (hasInsideWater) {
        mapS += 30;
        add(30, `Точка внутри акватории / водоёма: «${(ins.water || nr.water).title}»`);
      } else if (hasInsideWetland) {
        mapS += 30;
        add(30, `Точка внутри болота OSM: ${(ins.wetland || nr.wetland).title}`);
      } else if (nr.wetland && nr.wetland.dist <= 60) {
        mapS += 26;
        add(26, `Болото вплотную (${nr.wetland.dist} м): ${nr.wetland.title}`);
      } else if (nr.wetland && nr.wetland.dist <= 200) {
        mapS += 16;
        add(16, `Болото в ${nr.wetland.dist} м: близкий уровень грунтовых вод`);
      } else if (nr.water && nr.water.dist <= 40) {
        mapS += 16;
        add(16, `Берег водоёма в ${nr.water.dist} м`);
      }

      if (ins.floodProne) { mapS += 20; add(20, 'Зона паводкового затопления (OSM flood_prone)'); }
      if (nr.stream && nr.stream.dist <= 40) { mapS += 10; add(10, `Ручей в ${nr.stream.dist} м`); }
      if (nr.spring && nr.spring.dist <= 100) { mapS += 10; add(10, `Родник в ${nr.spring.dist} м`); }
      if (nr.ditch && nr.ditch.dist <= 100) { mapS -= 5; add(-5, `Канава в ${nr.ditch.dist} м: водоотвод`); }
      if (osm.pavedDist != null && osm.pavedDist <= 40) { mapS -= 10; add(-10, `Дорога с покрытием в ${osm.pavedDist} м: насыпь`); }
    }
    mapS = clamp(mapS, 0, 30);

    const susceptibility = clamp(topoS + soilS + mapS, 0, 100);

    // Динамика погоды (0 - 100)
    let dynamic = 0, deepSat = 0, topIdx = null;
    const dyn = [];
    if (wx) {
      const fc = (soil && !isWaterSoil) ? soil.hydro.fc : 0.32;
      const ths = (soil && !isWaterSoil) ? soil.hydro.thetaS : 0.45;
      const idx = m => (m - fc) / Math.max(0.05, ths - fc);
      const top = (wx.m0_1 + wx.m1_3 + wx.m3_9) / 3, deep = (wx.m9_27 + wx.m27_81) / 2;
      topIdx = idx(top);
      deepSat = idx(deep);

      const topAct = clamp((topIdx + 0.35) / 1.1, 0, 1);
      const deepAct = clamp((deepSat + 0.35) / 1.1, 0, 1);
      const apiAct = clamp(wx.api / 25, 0, 1);
      const rainAct = clamp(wx.rain72 / 35, 0, 1);
      const fcAct = clamp(wx.fc72 / 30, 0, 1);

      dynamic = 100 * (0.30 * topAct + 0.20 * deepAct + 0.20 * apiAct + 0.15 * rainAct + 0.15 * fcAct);

      if (wx.thawing) {
        const b = clamp(wx.meltCm * 3, 5, 20);
        dynamic += b;
        dyn.push(`Снеготаяние: снег ${wx.snowCm} см, воздух ${sgn(wx.airT)}°C (+${Math.round(b)} к сырости)`);
      }
      if ((wx.frozenTop || wx.frozenDeep) && (wx.rain72 > 2 || wx.thawing)) {
        dynamic += 10;
        dyn.push('Мёрзлый грунт: инфильтрация блокирована, сток идет поверху');
      }
      dynamic = clamp(dynamic, 0, 100);

      if (topIdx > 0.8) dyn.push(`Верхние слои переувлажнены (${Math.round(top * 100)}% при норме ${Math.round(fc * 100)}%)`);
      if (deepSat > 0.7) dyn.push('Глубокие горизонты заполнены: естественный дренаж заблокирован');
      dyn.push(`Осадки: за 72 ч — ${wx.rain72} мм, за 14 дней — ${wx.rain14} мм, API — ${wx.api} мм`);
      if (wx.fc72 >= 8) dyn.push(`Прогноз на 72 ч: ${wx.fc72} мм осадков`);
    }

    // Позиционирование относительно реки / поймы
    let floodPos = 'out';
    const dRiver = nr.river ? nr.river.dist : null;
    if (ins.floodProne) floodPos = 'in';
    else if (dRiver != null) {
      if (dRiver <= 120 && (!terrain || terrain.hLow <= 3.5)) floodPos = 'in';
      else if (dRiver <= 350 && (!terrain || terrain.hLow <= 5.5)) floodPos = 'near';
    }
    // Если точка на высоком холме (hLow > 10 м) — она вне поймы, даже если река в 20 м
    if (terrain && terrain.hLow >= 10) floodPos = 'out';

    let floodScore = 0, floodText = '', floodActive = false;
    const hasFlood = flood && flood.hasCatchment && flood.cur >= 0.5;

    if (hasFlood) {
      const lvl = LEVELS[flood.level].rank;
      const base = [0, 35, 65, 88][lvl];
      const mult = floodPos === 'in' ? 1.0 : floodPos === 'near' ? 0.65 : 0.1;
      floodScore = Math.round(base * mult);
      if (floodPos === 'out') floodScore = Math.min(floodScore, 15);
      floodActive = floodScore >= 30;

      const posTxt = floodPos === 'in' ? 'точка в пойме' : floodPos === 'near' ? 'точка у границы поймы' : 'высокий берег / вне поймы';
      floodText = `${LEVELS[flood.level].label}: ${flood.cur} м³/с (норма ${flood.median}, порог поймы ${flood.p75}); ${posTxt}${dRiver != null ? `, до русла ${dRiver} м` : ''}${terrain ? `, превышение +${terrain.hLow} м` : ''}.`;
      if (floodScore >= 30) add(floodScore, `Речной разлив (GloFAS): ${floodText}`);
    } else {
      floodText = 'Речного паводка нет или водоток локальный (расход < 0.5 м³/с).';
    }

    // Торфяник / болото
    const isPeat = !!((soil && !isWaterSoil && (soil.socRoot >= 80 || soil.soc >= 130)));
    const isWetland = hasInsideWetland || (nr.wetland && nr.wetland.dist <= 60);
    const isOpenWater = hasInsideWater || (soil && isWaterSoil);

    // Базовый синтез риска
    let risk = susceptibility * (0.35 + 0.65 * dynamic / 100);
    if (!wx) risk = susceptibility * 0.70;

    // Защита от ложного осушения: постоянные водоёмы и болота
    if (isOpenWater) {
      risk = Math.max(risk, 95);
    } else if (isWetland || (isPeat && terrain && (terrain.isDepression || terrain.wetness > 0.6))) {
      // Болото не высыхает до «сухого грунта» за неделю без дождей
      risk = Math.max(risk, 68 + 0.25 * dynamic);
    }

    const floodDriven = floodScore > risk;
    risk = Math.max(risk, floodScore);

    // Ограничители (сухой песок, крутые склоны)
    const capNotes = [];
    if (terrain && terrain.slopeDeg >= 5 && !isOpenWater && !isWetland && !floodActive) {
      if (risk > 40) capNotes.push('Уклон склона обеспечивает сток: стоячая вода невозможна');
      risk = Math.min(risk, 40);
    }
    if (terrain && terrain.isRidge && terrain.hLow >= 15 && !isOpenWater) {
      risk = Math.min(risk, 28);
    }
    if (soil && soil.sand >= 65 && soil.hydro.ks >= 45 && !isWetland && !isOpenWater && !floodActive) {
      if (terrain && terrain.hLow >= 3) risk = Math.min(risk, 28);
    }

    risk = clamp(Math.round(risk), 5, 99);

    // Вердикты
    let v;
    if (isOpenWater) {
      const isRiver = (osm.inside.water && osm.inside.water.isRiverWater) || (nr.river && nr.river.dist <= 30);
      v = {
        title: isRiver ? 'Судоходное русло реки / глубокая вода' : 'Открытый водоём / акватория',
        color: '#0284c7', icon: '🛶',
        walk: 'Пешком невозможно: открытая вода (глубина).',
        car: 'Проезд невозможен. Только лодки, катера и амфибии.',
        gear: 'Плавсредство, спасательный жилет, навигатор.'
      };
    } else if (floodDriven && risk >= 60) {
      v = {
        title: floodPos === 'in' ? 'Пойма под водой / разлив' : 'Подтопление прибрежной зоны',
        color: '#ef4444', icon: '🌊',
        walk: 'Опасно: вода на пойме выше сапог, скрытые ямы и течение.',
        car: 'Проезд запрещен: размытые съезды и насыпи.',
        gear: 'Вейдерсы (забродники), шест для промера глубины, спасжилет.'
      };
    } else if (isWetland || risk >= 75) {
      v = {
        title: isWetland ? 'Топь / болото' : 'Непроходимая топь / переувлажнение',
        color: '#ef4444', icon: '🌾',
        walk: 'Крайне тяжело: провал выше щиколотки/колена, зыбучий покров.',
        car: 'Непроходимо для гражданских авто. Только болотоходы и спецтехника.',
        gear: 'Высокие бродни / вейдерсы, слега (жердь для опоры).'
      };
    } else if (risk >= 50) {
      v = {
        title: (soil && soil.clay >= 30) ? 'Вязкая глина / колеи с водой' : 'Сильная распутица / грязь',
        color: '#f97316', icon: '⚠️',
        walk: 'Тяжелое движение: жижа, глубокие лужи, размокший грунт.',
        car: 'Только подготовленные внедорожники (MT-грязевая резина, лебедка).',
        gear: 'Резиновые сапоги. Для авто: буксировочный трос, лопата, траки.'
      };
    } else if (risk >= 30) {
      v = {
        title: 'Умеренная сырость / локальные лужи',
        color: '#eab308', icon: '🌦️',
        walk: 'Проходимо в треккинговой обуви; сырость в микропонижениях.',
        car: 'Легковой транспорт проедет осторожно; колеи на грунте скользкие.',
        gear: 'Влагозащитная обувь или треккинговые ботинки.'
      };
    } else {
      v = {
        title: 'Сухой устойчивый грунт',
        color: '#10b981', icon: '🟢',
        walk: 'Свободное движение в любой обуви.',
        car: 'Свободный проезд для любого гражданского транспорта.',
        gear: 'Специальная экипировка не требуется.'
      };
    }

    let outlook = { tone: 'same', text: 'Существенных изменений в ближайшие 3 суток не ожидается.' };
    if (wx) {
      if (wx.fc72 >= 15) outlook = { tone: 'worse', text: `Ожидается ${wx.fc72} мм осадков за 72 ч: сырость и грязь заметно усилятся.` };
      else if (wx.fc72 >= 6) outlook = { tone: 'worse', text: `Прогноз осадков: ${wx.fc72} мм за 72 ч, возможно локальное ухудшение.` };
      else if (wx.fc72 < 2 && !isOpenWater) {
        outlook = { tone: 'better', text: isPeat ? 'Сухая погода, но торфяник сохраняет влагу неделями.' : 'Сухо: грунт будет постепенно подсыхать.' };
      }
    }

    return {
      susceptibility, dynamic: Math.round(dynamic), risk, v, outlook,
      parts: { topoS, soilS, mapS }, factors: F, dyn, capNotes,
      floodPos, floodScore, floodText, floodDriven, dRiver, aquitardCm,
      topIdx, deepSat, month, isPeat, isWetland, isOpenWater
    };
  }

  // =========================================================================
  // РЕНДЕРИНГ
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
      const pr = s.prob[i] != null ? ` (${s.prob[i]}%)` : '';
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
      <div class="gx-note">Осадки по суткам: факт (14 дн) и прогноз (7 дн). Пунктир — сегодня.</div>`;
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
      <div style="margin: 8px 0;">
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
        <div style="display:flex; justify-content:center; gap:12px; font-size:10px; margin-top:4px;">
          <span><b style="color:#0284c7;">—</b> Расход (м³/с)</span>
          <span><b style="color:#64748b;">---</b> Медиана</span>
          <span><b style="color:#f59e0b;">···</b> Порог поймы</span>
        </div>
      </div>`;
  }

  function renderFloodStrip(flood) {
    if (!flood || !flood.hasCatchment) return '';
    const cells = flood.daily7.map((d, i) => {
      const isToday = i === 0;
      const dateLbl = isToday ? 'Сегодня' : `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}`;
      return `
        <div class="river-forecast-card lvl-${d.level} ${isToday ? 'today' : ''}" title="${esc(d.date)}: ${d.q} м³/с">
          <span class="rfc-date">${dateLbl}</span>
          <span class="rfc-val">${d.q}</span>
          <span class="rfc-unit">м³/с</span>
          <span class="rfc-dot"></span>
        </div>`;
    }).join('');

    return `
      <div style="display:flex; flex-direction:column; gap:5px; margin-top:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; font-weight:700; color:var(--text-muted);">
          <span>📅 Прогноз расхода (7 дней)</span>
          <span style="font-size:10px; font-weight:500;">Порог поймы: ${flood.p75} м³/с</span>
        </div>
        <div class="river-forecast-strip">${cells}</div>
      </div>`;
  }

  function renderMoistureLayers(wx, soil) {
    const isWaterSoil = soil && soil.bdod === 0 && soil.soc === 0;
    const fc = (soil && !isWaterSoil) ? soil.hydro.fc : 0.32;
    const ths = (soil && !isWaterSoil) ? soil.hydro.thetaS : 0.45;
    const layers = [['0–1 см', wx.m0_1], ['1–3 см', wx.m1_3], ['3–9 см', wx.m3_9], ['9–27 см', wx.m9_27], ['27–81 см', wx.m27_81]];
    return layers.map(([lbl, m]) => {
      const pct = clamp(m / ths * 100, 2, 100), fcPct = clamp(fc / ths * 100, 0, 100);
      const idx = (m - fc) / Math.max(0.05, ths - fc);
      const col = idx > 0.8 ? '#ef4444' : idx > 0.2 ? '#f97316' : idx > 0 ? '#eab308' : '#0284c7';
      return `<div class="gx-row"><span class="gx-note" style="min-width:56px;">${lbl}</span><div class="gx-bar" style="flex:1;position:relative;"><i style="width:${pct}%;background:${col}"></i><span style="position:absolute;left:${fcPct}%;top:0;bottom:0;width:2px;background:var(--text-main);opacity:.55;"></span></div><b style="min-width:38px;text-align:right;">${Math.round(m * 100)}%</b></div>`;
    }).join('') + `<div class="gx-note">Метка внутри шкалы — полевая влагоёмкость (${Math.round(fc * 100)}%). Всё что правее — свободная гравитационная вода.</div>`;
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
    insights.push(`🏞️ <b>Место:</b> природная склонность ${A.susceptibility}% (рельеф ${A.parts.topoS}/40, грунт ${A.parts.soilS}/30, гидросеть ${A.parts.mapS}/30).`);
    insights.push(`☔ <b>Погода:</b> активация ${A.dynamic}%${wx ? ` (за 72 ч: ${wx.rain72} мм, индекс API: ${wx.api} мм)` : ''}.`);
    if (A.isOpenWater) insights.push('🛶 <b>Открытая вода:</b> точка на акватории водоёма или реки.');
    else if (A.isWetland) insights.push('🌾 <b>Болото:</b> постоянное гидроморфное понижение, сохраняет топкость в любую погоду.');
    insights.push(`🌊 <b>Речной сток:</b> ${esc(A.floodText)}`);
    if (A.capNotes.length) insights.push('ℹ️ ' + esc(A.capNotes.join('; ')));

    const floodLvl = flood && flood.hasCatchment && flood.cur >= 0.5 ? LEVELS[flood.level] : null;
    const posLbl = A.floodPos === 'in' ? 'в пойме' : A.floodPos === 'near' ? 'у границы поймы' : 'вне поймы';
    const posCol = A.floodPos === 'in' ? '#ef4444' : A.floodPos === 'near' ? '#f97316' : '#10b981';

    const osmChips = osm.items.length ? osm.items.slice(0, 14).map(o => `
      <span class="water-osm-chip ${o.severity}"><span>${o.icon}</span><span>${esc(o.title)}${o.dist > 0 ? ` · ${o.dist} м` : ' (здесь)'}</span></span>`).join('') : '';

    const floodPct = flood && flood.p75 ? Math.min(100, Math.round((flood.cur / flood.p75) * 100)) : 0;
    const floodBarCol = floodPct >= 95 ? '#ef4444' : floodPct >= 80 ? '#f97316' : floodPct >= 60 ? '#eab308' : '#10b981';

    content.innerHTML = `
      <div class="water-hero-card" style="border-left:4.5px solid ${v.color};">
        <div class="water-hero-top">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:28px;">${v.icon}</span>
            <div>
              <h4 class="water-status-title" style="color:${v.color};margin:0;font-size:15px;">${esc(v.title)}</h4>
              <span class="water-status-sub">Итоговый гидрологический риск: <b>${A.risk}%</b></span>
            </div>
          </div>
          <span class="water-score-pill" style="border-color:${v.color};color:${v.color};font-size:12px;font-weight:800;">${A.risk} / 100</span>
        </div>
        <div class="gx-bar" style="margin-top:8px;"><i style="width:${A.risk}%;background:${v.color}"></i></div>

        <div class="gx-row" style="margin-top:10px;"><span class="gx-note">🏞️ Природная предрасположенность</span><b>${A.susceptibility}%</b></div>
        <div class="gx-bar"><i style="width:${A.susceptibility}%;background:#8b5cf6"></i></div>
        <div class="gx-row"><span class="gx-note">☔ Метео-активация (дожди/грунт)</span><b>${A.dynamic}%</b></div>
        <div class="gx-bar"><i style="width:${A.dynamic}%;background:#0284c7"></i></div>

        <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:12px;font-weight:700;">🚶 Пешеход: <span style="font-weight:400;">${esc(v.walk)}</span></div>
          <div style="font-size:12px;font-weight:700;">🚙 Транспорт: <span style="font-weight:400;">${esc(v.car)}</span></div>
          <div class="gx-note" style="color:var(--text-main);">🥾 <b>Снаряжение:</b> ${esc(v.gear)}</div>
          <div style="font-size:12px;font-weight:700;color:${outTone};">${outIcon} 72 часа: <span style="font-weight:400;">${esc(A.outlook.text)}</span></div>
        </div>

        <div class="gx-insights"><div style="font-weight:800;">🔎 Детализация синтеза</div>${insights.map(t => `<div>${t}</div>`).join('')}</div>
      </div>

      <div class="water-river-card">
        <div class="water-section-header">
          <span>🌊 Мониторинг речного стока (GloFAS)</span>
          ${floodLvl ? `<span style="font-size:11px; color:var(--text-muted);">Copernicus EMS</span>` : ''}
        </div>

        ${floodLvl ? `
          <!-- Статус-баннер без тавтологии -->
          <div class="river-status-banner" style="--river-status-col: ${floodLvl.color};">
            <div class="river-status-left">
              <span class="river-status-title">${floodLvl.label}</span>
              <span class="river-status-sub">
                ${flood.trend === 'rising' ? 'Сток растёт ↗' : flood.trend === 'falling' ? 'Сток падает ↘' : 'Уровень стабилен →'} · Риск затопления: ${floodPct >= 90 ? 'высокий' : floodPct >= 70 ? 'умеренный' : 'минимальный'}
              </span>
            </div>
            <div class="river-status-badge">
              <b>${flood.cur}</b> <small style="color:var(--text-muted);">м³/с</small>
            </div>
          </div>

          <!-- Наглядная шкала: сколько запаса до поймы -->
          <div class="river-gauge-wrap">
            <div class="river-gauge-head">
              <span style="color:var(--text-muted);">Заполнение русла до выхода на пойму</span>
              <span style="color:${floodBarCol};">${floodPct}% (${flood.cur} из ${flood.p75} м³/с)</span>
            </div>
            <div class="river-gauge-bar">
              <div class="river-gauge-fill" style="width:${floodPct}%; background:${floodBarCol};"></div>
            </div>
          </div>

          <!-- Сетка параметров: 2x2 -->
          <div class="river-metrics-grid">
            <div class="river-metric-box">
              <span class="river-metric-lbl">Положение точки</span>
              <span class="river-metric-val" style="color:${posCol};">${posLbl}</span>
              <span class="river-metric-hint">${A.dRiver != null ? `До русла: ${A.dRiver} м` : 'Вне прямой зоны'}</span>
            </div>
            <div class="river-metric-box">
              <span class="river-metric-lbl">Превышение рельефа</span>
              <span class="river-metric-val">${terrain ? `+${terrain.hLow} м` : '—'}</span>
              <span class="river-metric-hint">Над низиной (750 м)</span>
            </div>
            <div class="river-metric-box">
              <span class="river-metric-lbl">Сезонная норма</span>
              <span class="river-metric-val">${flood.median} <small style="font-size:10px; font-weight:600; color:var(--text-muted);">м³/с</small></span>
              <span class="river-metric-hint">Медиана для этой даты</span>
            </div>
            <div class="river-metric-box">
              <span class="river-metric-lbl">Порог поймы (P75)</span>
              <span class="river-metric-val" style="color:#f59e0b;">${flood.p75} <small style="font-size:10px; font-weight:600; color:var(--text-muted);">м³/с</small></span>
              <span class="river-metric-hint">Выход воды на берега</span>
            </div>
          </div>

          <!-- Алерт ожидаемого пика -->
          ${flood.peakInDays > 0 && flood.peakLevel !== 'normal' ? `
            <div class="river-peak-alert">
              <span style="font-size:16px;">📈</span>
              <div>
                Ожидается пик расхода <b>${flood.peakQ} м³/с</b> через <b>${flood.peakInDays} дн.</b> (${flood.peakDate.slice(8,10)}.${flood.peakDate.slice(5,7)}).
              </div>
            </div>
          ` : ''}

          <!-- 7-дневная лента-плитка -->
          ${renderFloodStrip(flood)}

          <!-- График гидрографа -->
          ${renderHydrograph(flood)}
        ` : `
          <div class="muted" style="font-size:11.5px; padding:12px 0;">
            Водотока с паводковым бассейном нет (расход &lt; 0.5 м³/с).
          </div>
        `}
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>🧪 Влага в почве и осадки</span></div>
        ${wx ? `
          ${renderMoistureLayers(wx, soil)}
          <div class="gx-grid">
            ${statBox('Дождь 24 ч / 72 ч', `${wx.rain24} / ${wx.rain72} мм`)}
            ${statBox('Осадки 7 / 14 дн', `${wx.rain7} / ${wx.rain14} мм`)}
            ${statBox('Прогноз 24 ч / 72 ч', `${wx.fc24} / ${wx.fc72} мм`)}
            ${statBox('Баланс 7 дн (P−ET₀)', `${sgn(r1(wx.rain7 - wx.et7))} мм`)}
          </div>
          <div class="gx-note">Температура: воздух ${sgn(wx.airT)}°C, почва 0 см ${sgn(wx.t0)}°C, глубина 18 см ${sgn(wx.t18)}°C.</div>
          ${renderPrecipChart(wx)}
        ` : '<div class="muted" style="font-size:11px;">Метеоданные недоступны.</div>'}
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>⚖️ Факторы оценки</span></div>
        ${factorsUp.length ? `<div class="gx-note" style="font-weight:700;">Повышают сырость и застой воды:</div>${factorsUp.map(fRow).join('')}` : ''}
        ${factorsDown.length ? `<div class="gx-note" style="font-weight:700;margin-top:6px;">Отводят воду / способствуют дренажу:</div>${factorsDown.map(fRow).join('')}` : ''}
      </div>

      <div class="water-section-card">
        <div class="water-section-header"><span>🗺️ Рельеф и объекты OSM</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:11.5px;line-height:1.45;">
          ${terrain ? `<div>• <b>Рельеф:</b> уклон <b>${terrain.slopeDeg}°</b>, вогнутость <b>${sgn(terrain.deltaLocal)} м</b>, превышение <b>${terrain.hLow} м</b> — ${terrain.isDepression ? 'котловина' : terrain.isValleyBottom ? 'дно лощины' : terrain.isRidge ? 'гребень' : 'склон'}${terrain.wetness != null ? `, индекс увлажнения ${Math.round(terrain.wetness * 100)}%` : ''}.</div>` : ''}
          ${soil && !A.isOpenWater ? `<div>• <b>Грунт:</b> глина <b>${soil.clay}%</b>, песок <b>${soil.sand}%</b>, органика SOC <b>${soil.socRoot || soil.soc} г/кг</b>${A.isPeat ? ' (торфяник)' : ''}; Ksat <b>${soil.hydro.ks} мм/ч</b>.</div>` : ''}
          <div>
            <div style="font-weight:700;color:var(--text-main);margin-bottom:3px;">Гидрообъекты OSM (до 900 м):</div>
            ${osmChips ? `<div class="water-osm-chips">${osmChips}</div>` : '<div class="muted" style="font-size:11px;">Водоемов и болот в радиусе 900 м нет.</div>'}
          </div>
        </div>
      </div>

      <div class="nav-actions-grid" style="margin-top:12px;">
        <button type="button" class="action-card-btn primary" id="btn-water-copy-report">📋 Скопировать гидроотчёт</button>
        <button type="button" class="action-card-btn" id="btn-water-to-soil">🧪 Почва и грибы</button>
      </div>

      ${renderDebugAccordion()}
      ${renderRawDataAccordion(ctx)}
    `;

    document.getElementById('btn-water-copy-report')?.addEventListener('click', () => {
      const plain = s => String(s).replace(/<[^>]+>/g, '');
      const text = [
        `🌊 Гидрологический отчёт [${lat.toFixed(5)}, ${lon.toFixed(5)}]:`,
        `• Вердикт: ${v.title} (риск ${A.risk}%; место ${A.susceptibility}%, погода ${A.dynamic}%)`,
        `• Пешеход: ${v.walk}`, `• Транспорт: ${v.car}`, `• Экипировка: ${v.gear}`,
        `• 72 ч: ${A.outlook.text}`,
        `• Речной сток: ${A.floodText}`,
        terrain ? `• Рельеф: уклон ${terrain.slopeDeg}°, вогнутость ${sgn(terrain.deltaLocal)} м, превышение ${terrain.hLow} м` : '',
        osm.items.length ? `• OSM: ${osm.items.slice(0, 6).map(o => `${o.title} (${o.dist} м)`).join('; ')}` : ''
      ].filter(Boolean).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Гидроотчёт скопирован');
      });
    });

    document.getElementById('btn-water-copy-raw-json')?.addEventListener('click', () => {
      const pre = document.getElementById('water-raw-json-pre');
      if (pre && pre.textContent) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Сырые гидроданные (JSON) скопированы');
        });
      }
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
        <small class="hint-text" style="text-align:center;">Анализ рельефа, влажности слоев, пойменных границ и гидрообъектов</small>
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
      if (!flood && !wx && !terrain && !soil && !osmSafe.ok) {
        throw new Error('Не удалось получить данные гидрологии. Проверьте интернет-соединение.');
      }

      renderWaterModalResult({ flood, osm: osmSafe, wx, terrain, soil, lat, lon });
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      content.innerHTML = `
        <div class="sheet-empty-state" style="padding:24px 14px;">
          <div class="sheet-empty-icon">⚠️</div>
          <div class="sheet-empty-title">Ошибка гидродиагностики</div>
          <div class="sheet-empty-desc">${esc(err.message)}</div>
          <button type="button" class="btn btn-primary" id="btn-water-retry">↺ Повторить запрос</button>
        </div>
        ${renderDebugAccordion()}`;
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
    runDiagnosisForCoords: runWaterDiagnosisForCoords,
    fetchGloFas,
    fetchWeather,
    fetchOsm,
    analyze
  };
})();