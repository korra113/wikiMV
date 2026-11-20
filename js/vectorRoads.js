(function () {
  const WM = window.WM = window.WM || {};

  // Источники тайлов (Shortbread v1 MVT)
  const TILE_URL_TEMPLATE = 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
  const BACKUP_URL_TEMPLATE = 'https://tile.openstreetmap.jp/data/osm/{z}/{x}/{y}.mvt';


  const WETLAND_KINDS = new Set([
    'wetland', 'marsh', 'swamp', 'bog', 'string_bog',
    'wet_meadow', 'fen', 'reedbed', 'saltmarsh', 'tidalflat'
  ]);

  const FARM_KINDS = new Set(['farmland', 'orchard', 'vineyard']);
  const CEMETERY_KINDS = new Set(['cemetery', 'grave_yard']);

  const RAIL_KINDS = new Set([
    'rail', 'narrow_gauge', 'funicular', 'tram', 'light_rail', 'subway', 'monorail'
  ]);




  // =========================================================================
  // ИСТОЧНИК OPENMAPTILES (ПИКИ ГОР И ЗАПОВЕДНИКИ, OVERZOOM C Z12)
  // =========================================================================
  const OMT_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
  const OMT_FALLBACK_TPL = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
  const OMT_BACKUP_TPL   = 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}';
  const OMT_MAX_ZOOM = 12;
  const OMT_MIN_ZOOM = 7;


  let _ofmTplPromise = null;
  let _ofmFailStreak = 0;
  let _ofmSkipUntil = 0;

  const omtTileCache = new Map();
  const omtTileInFlight = new Map();

  function getOfmTileTemplate() {
    if (_ofmTplPromise) return _ofmTplPromise;
    _ofmTplPromise = (async () => {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 4000);
        const resp = await fetch(OMT_TILEJSON_URL, { mode: 'cors', signal: ctl.signal });
        clearTimeout(tm);
        if (resp.ok) {
          const j = await resp.json();
          if (j && Array.isArray(j.tiles) && j.tiles[0]) return j.tiles[0];
        }
      } catch (e) {}
      return OMT_FALLBACK_TPL;
    })();
    return _ofmTplPromise;
  }

  // =========================================================================
  // ОПТИМИЗИРОВАННЫЙ ПАРСЕР MVT + OMT В WEB WORKER (ZERO MAIN-THREAD FREEZE)
  // =========================================================================
  const PARSER_CORE_SRC = `
    const WETLAND_KINDS = new Set(['wetland','marsh','swamp','bog','string_bog','wet_meadow','fen','reedbed','saltmarsh','tidalflat']);
    const FARM_KINDS = new Set(['farmland','orchard','vineyard']);
    const CEMETERY_KINDS = new Set(['cemetery','grave_yard']);
    const POI_TOURISM = new Set(['viewpoint','alpine_hut','camp_site','picnic_site','information']);
    const POI_HISTORIC = new Set(['castle','ruins','fort','archaeological_site','monument','memorial','battlefield','wayside_cross','wayside_shrine']);
    const POI_MANMADE = new Set(['tower','lighthouse','windmill','watermill','water_well']);
    const POI_AMENITY = new Set(['shelter','drinking_water','hunting_stand','place_of_worship']);
    const ALLOWED_LAYERS = new Set(['streets','water_polygons','water_lines','land','buildings','place_labels','water_lines_labels','water_polygons_labels','pier_lines','pier_polygons','public_transport','pois']);
    const KEEP_MVT_PROPS = new Set(['kind','name','name_ru','name:ru','name_en','name_de','tracktype','maritime','way_area','population','building:levels','levels','height','render_height','rail','bridge','tunnel','service','iata','tourism','historic','man_made','amenity','highway','religion']);
    const OMT_ALLOWED_LAYERS = new Set(['mountain_peak','park']);
    const OMT_KEEP_PROPS = new Set(['name','name:ru','name_ru','name:en','class','ele','rank']);
    const sharedTextDecoder = new TextDecoder('utf-8');

    function classifyPoi(props) {
      if (props.historic && POI_HISTORIC.has(props.historic)) return { group: 'historic', sub: props.historic, prio: 1 };
      if (props.man_made && POI_MANMADE.has(props.man_made)) return { group: 'manmade', sub: props.man_made, prio: 2 };
      if (props.tourism && POI_TOURISM.has(props.tourism)) return { group: 'tourism', sub: props.tourism, prio: (props.tourism === 'viewpoint' || props.tourism === 'alpine_hut') ? 2 : 3 };
      if (props.amenity && POI_AMENITY.has(props.amenity)) return { group: 'amenity', sub: props.amenity, prio: props.amenity === 'place_of_worship' ? 2 : 3 };
      if (props.highway === 'emergency_access_point') return { group: 'amenity', sub: 'emergency_access_point', prio: 2 };
      return null;
    }

    class MiniPbf {
      constructor(buf) { this.buf = new Uint8Array(buf); this.pos = 0; this.len = this.buf.length; }
      readVarint() {
        let res = 0, shift = 0, b;
        do { b = this.buf[this.pos++]; res |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80);
        return res >>> 0;
      }
      readString(bytes) {
        const end = this.pos + bytes;
        const s = sharedTextDecoder.decode(this.buf.subarray(this.pos, end));
        this.pos = end;
        return s;
      }
      skip(bytes) { this.pos += bytes; }
    }

    function skipField(pbf, wire) {
      if (wire === 0) { while (pbf.pos < pbf.len && (pbf.buf[pbf.pos++] & 0x80)) {} }
      else if (wire === 2) pbf.skip(pbf.readVarint());
      else if (wire === 5) pbf.skip(4);
      else if (wire === 1) pbf.skip(8);
    }

    function readVarint64Safe(pbf) {
      let res = 0, mul = 1, cnt = 0;
      const p0 = pbf.pos;
      while (pbf.pos < pbf.len) {
        const b = pbf.buf[pbf.pos++];
        cnt++;
        if (cnt > 6) {
          pbf.pos = p0;
          let big = 0n, sh = 0n;
          while (pbf.pos < pbf.len) {
            const x = pbf.buf[pbf.pos++];
            big |= BigInt(x & 0x7f) << sh;
            if (x < 0x80) break;
            sh += 7n;
          }
          return big;
        }
        res += (b & 0x7f) * mul;
        mul *= 128;
        if (b < 0x80) break;
      }
      return res;
    }

    function readRawFeatureLazy(pbf, end) {
      let type = 0;
      const tags = [];
      let geomStart = 0, geomEnd = 0;
      while (pbf.pos < end) {
        const tag = pbf.readVarint();
        const wire = tag & 7;
        const id = tag >> 3;
        if (id === 2 && wire === 2) {
          const gLen = pbf.readVarint();
          const gEnd = pbf.pos + gLen;
          while (pbf.pos < gEnd) tags.push(pbf.readVarint());
        } else if (id === 3 && wire === 0) {
          type = pbf.readVarint();
        } else if (id === 4 && wire === 2) {
          const gLen = pbf.readVarint();
          geomStart = pbf.pos;
          geomEnd = pbf.pos + gLen;
          pbf.pos = geomEnd; // Не декодируем геометрию до фильтрации!
        } else {
          skipField(pbf, wire);
        }
      }
      return { type, tags, geomStart, geomEnd };
    }

    function decodeGeometryFlatSlice(buf, pos, end) {
      const lines = [];
      let curLine = [];
      let x = 0, y = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      while (pos < end) {
        let res = 0, shift = 0, b;
        do { b = buf[pos++]; res |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80 && pos < end);
        const cmdInt = res >>> 0;
        const cmd = cmdInt & 7;
        const count = cmdInt >> 3;
        if (cmd === 1) {
          for (let c = 0; c < count; c++) {
            if (curLine.length > 0) lines.push(new Int32Array(curLine));
            curLine = [];
            let dx = 0, s1 = 0;
            do { b = buf[pos++]; dx |= (b & 0x7f) << s1; s1 += 7; } while (b >= 0x80 && pos < end);
            let dy = 0, s2 = 0;
            do { b = buf[pos++]; dy |= (b & 0x7f) << s2; s2 += 7; } while (b >= 0x80 && pos < end);
            x += (dx >>> 1) ^ -(dx & 1);
            y += (dy >>> 1) ^ -(dy & 1);
            curLine.push(x, y);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        } else if (cmd === 2) {
          for (let c = 0; c < count; c++) {
            let dx = 0, s1 = 0;
            do { b = buf[pos++]; dx |= (b & 0x7f) << s1; s1 += 7; } while (b >= 0x80 && pos < end);
            let dy = 0, s2 = 0;
            do { b = buf[pos++]; dy |= (b & 0x7f) << s2; s2 += 7; } while (b >= 0x80 && pos < end);
            x += (dx >>> 1) ^ -(dx & 1);
            y += (dy >>> 1) ^ -(dy & 1);
            curLine.push(x, y);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        } else if (cmd === 7) {
          if (curLine.length > 0) {
            curLine.push(curLine[0], curLine[1]);
            lines.push(new Int32Array(curLine));
            curLine = [];
          }
        }
      }
      if (curLine.length > 0) lines.push(new Int32Array(curLine));
      return { lines, bbox: [minX, minY, maxX, maxY] };
    }

    function parseValue(pbf, end) {
      let val = null;
      while (pbf.pos < end) {
        const tag = pbf.readVarint();
        const wire = tag & 7;
        const id = tag >> 3;
        if (id === 1 && wire === 2) val = pbf.readString(pbf.readVarint());
        else if (id === 2 && wire === 5) {
          const b = pbf.buf.subarray(pbf.pos, pbf.pos + 4); pbf.skip(4);
          val = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
        } else if (id === 3 && wire === 1) {
          const b = pbf.buf.subarray(pbf.pos, pbf.pos + 8); pbf.skip(8);
          val = new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
        } else if (id === 4 && wire === 0) {
          const v = readVarint64Safe(pbf);
          val = typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : v;
        } else if (id === 5 && wire === 0) {
          const v = readVarint64Safe(pbf);
          val = typeof v === 'bigint' ? Number(v) : v;
        } else if (id === 6 && wire === 0) {
          const v = readVarint64Safe(pbf);
          val = typeof v === 'bigint' ? Number((v >> 1n) ^ -(v & 1n)) : ((v >>> 1) ^ -(v & 1));
        } else if (id === 7 && wire === 0) val = pbf.readVarint() !== 0;
        else skipField(pbf, wire);
      }
      return val;
    }

    function parseLayer(pbf, end) {
      let name = '', extent = 4096;
      const keys = [], values = [], rawFeatures = [];
      while (pbf.pos < end) {
        const tag = pbf.readVarint();
        const wire = tag & 7, id = tag >> 3;
        if (id === 1 && wire === 2) {
          name = pbf.readString(pbf.readVarint());
          if (!ALLOWED_LAYERS.has(name)) { pbf.pos = end; return null; }
        } else if (id === 2 && wire === 2) {
          rawFeatures.push(readRawFeatureLazy(pbf, pbf.pos + pbf.readVarint()));
        } else if (id === 3 && wire === 2) keys.push(pbf.readString(pbf.readVarint()));
        else if (id === 4 && wire === 2) values.push(parseValue(pbf, pbf.pos + pbf.readVarint()));
        else if (id === 5 && wire === 0) extent = pbf.readVarint();
        else skipField(pbf, wire);
      }
      if (!name || !ALLOWED_LAYERS.has(name)) return null;

      const features = [];
      for (let r = 0; r < rawFeatures.length; r++) {
        const raw = rawFeatures[r];
        const props = {};
        const tags = raw.tags;
        for (let i = 0; i < tags.length; i += 2) {
          const k = keys[tags[i]], v = values[tags[i + 1]];
          if (k !== undefined && v !== undefined && KEEP_MVT_PROPS.has(k)) props[k] = v;
        }
        if (name === 'land') {
          const k = props.kind;
          if (!WETLAND_KINDS.has(k) && k !== 'forest' && k !== 'wood' && !FARM_KINDS.has(k) && !CEMETERY_KINDS.has(k)) continue;
        } else if (name === 'pois') {
          const poiInfo = classifyPoi(props);
          if (!poiInfo) continue;
          props._poi = poiInfo;
        }
        const decoded = decodeGeometryFlatSlice(pbf.buf, raw.geomStart, raw.geomEnd);
        features.push({ type: raw.type, props, geom: decoded.lines, bbox: decoded.bbox });
      }
      return { name, extent, features };
    }

    function parseMvt(arrayBuffer) {
      const pbf = new MiniPbf(arrayBuffer);
      const layers = {};
      while (pbf.pos < pbf.len) {
        const tag = pbf.readVarint();
        if ((tag >> 3) === 3 && (tag & 7) === 2) {
          const len = pbf.readVarint();
          const layer = parseLayer(pbf, pbf.pos + len);
          if (layer && layer.name) layers[layer.name] = layer;
        } else skipField(pbf, tag & 7);
      }
      return layers;
    }

    function getParkTier(rawName, props) {
      const cls = String(props.class || '').toLowerCase();
      const lname = rawName.toLowerCase();
      const rank = props.rank || 99;
      if (/древостой|памятник\\s+природы|урочищ|роща|квартал|лесопарк|участок/.test(lname) || /monument|памятник/.test(cls) || rank >= 5) return 1;
      if (/заповедник|национальн\\w*\\s+парк|биосферн/.test(lname) || cls === 'national_park' || /заповедник|национальн/.test(cls) || (cls === 'nature_reserve' && rank <= 2)) return 3;
      return 2;
    }

    function parseOmtLayer(pbf, end) {
      let name = '', extent = 4096;
      const keys = [], values = [], rawFeatures = [];
      while (pbf.pos < end) {
        const tag = pbf.readVarint();
        const wire = tag & 7, id = tag >> 3;
        if (id === 1 && wire === 2) {
          name = pbf.readString(pbf.readVarint());
          if (!OMT_ALLOWED_LAYERS.has(name)) { pbf.pos = end; return null; }
        } else if (id === 2 && wire === 2) {
          rawFeatures.push(readRawFeatureLazy(pbf, pbf.pos + pbf.readVarint()));
        } else if (id === 3 && wire === 2) keys.push(pbf.readString(pbf.readVarint()));
        else if (id === 4 && wire === 2) values.push(parseValue(pbf, pbf.pos + pbf.readVarint(), true));
        else if (id === 5 && wire === 0) extent = pbf.readVarint();
        else skipField(pbf, wire);
      }
      if (!name || !OMT_ALLOWED_LAYERS.has(name)) return null;

      if (name === 'mountain_peak') {
        const features = [];
        for (let r = 0; r < rawFeatures.length; r++) {
          const raw = rawFeatures[r];
          if (raw.type !== 1) continue;
          const props = {};
          const tags = raw.tags;
          for (let i = 0; i < tags.length; i += 2) {
            const k = keys[tags[i]], v = values[tags[i + 1]];
            if (k !== undefined && v !== undefined && OMT_KEEP_PROPS.has(k)) props[k] = v;
          }
          if (!(props['name:ru'] || props.name_ru || props.name) && props.ele == null) continue;
          const decoded = decodeGeometryFlatSlice(pbf.buf, raw.geomStart, raw.geomEnd);
          if (decoded.lines.length) features.push({ type: 1, props, geom: decoded.lines, bbox: decoded.bbox });
        }
        features.sort((a, b) => (a.props.rank || 999) - (b.props.rank || 999));
        return { name, extent, features };
      }

      const points = [], polys = [];
      for (let r = 0; r < rawFeatures.length; r++) {
        const raw = rawFeatures[r];
        if (raw.type !== 1 && raw.type !== 3) continue;
        const props = {};
        const tags = raw.tags;
        for (let i = 0; i < tags.length; i += 2) {
          const k = keys[tags[i]], v = values[tags[i + 1]];
          if (k !== undefined && v !== undefined && OMT_KEEP_PROPS.has(k)) props[k] = v;
        }
        if (raw.type === 1) {
          const rawName = props['name:ru'] || props.name_ru || props.name;
          if (!rawName) continue;
          const decoded = decodeGeometryFlatSlice(pbf.buf, raw.geomStart, raw.geomEnd);
          if (decoded.lines.length) {
            props._tier = getParkTier(rawName, props);
            points.push({ type: 1, props, geom: decoded.lines, bbox: decoded.bbox });
          }
        } else {
          const decoded = decodeGeometryFlatSlice(pbf.buf, raw.geomStart, raw.geomEnd);
          if (decoded.lines.length) polys.push({ type: 3, props, geom: decoded.lines, bbox: decoded.bbox });
        }
      }
      points.sort((a, b) => {
        if (b.props._tier !== a.props._tier) return b.props._tier - a.props._tier;
        return (a.props.rank || 999) - (b.props.rank || 999);
      });
      return { name, extent, points, polys };
    }

    function parseOmtMvt(arrayBuffer) {
      const pbf = new MiniPbf(arrayBuffer);
      const layers = {};
      while (pbf.pos < pbf.len) {
        const tag = pbf.readVarint();
        if ((tag >> 3) === 3 && (tag & 7) === 2) {
          const len = pbf.readVarint();
          const layer = parseOmtLayer(pbf, pbf.pos + len);
          if (layer && layer.name) layers[layer.name] = layer;
        } else skipField(pbf, tag & 7);
      }
      return layers;
    }

    async function maybeGunzip(buf) {
      const u8 = new Uint8Array(buf);
      if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        return await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
      }
      return buf;
    }
  `;

  // Пул из 2 воркеров + автоматический фолбэк на главный поток при запрете Blob Worker
  let _parseWorkers = null;
  let _workerSeq = 0;
  let _workerRobin = 0;
  let _fallbackParser = null;
  const _workerCallbacks = new Map();

  function getFallbackParser() {
    if (_fallbackParser) return _fallbackParser;
    const fn = new Function(PARSER_CORE_SRC + '\nreturn { parseMvt, parseOmtMvt, maybeGunzip };');
    _fallbackParser = fn();
    return _fallbackParser;
  }

  function initWorkers() {
    if (_parseWorkers !== null) return _parseWorkers;
    try {
      const workerCode = PARSER_CORE_SRC + `
        self.onmessage = async (e) => {
          const { id, mode, buf } = e.data;
          try {
            const raw = await maybeGunzip(buf);
            const layers = (mode === 'omt') ? parseOmtMvt(raw) : parseMvt(raw);
            self.postMessage({ id, layers });
          } catch (err) {
            self.postMessage({ id, error: err && err.message || 'parse error' });
          }
        };
      `;
      const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
      const pool = [];
      for (let i = 0; i < 2; i++) {
        const w = new Worker(blobUrl);
        w.onmessage = (e) => {
          const cb = _workerCallbacks.get(e.data.id);
          if (!cb) return;
          _workerCallbacks.delete(e.data.id);
          if (e.data.error) cb.rej(new Error(e.data.error));
          else cb.res(e.data.layers);
        };
        w.onerror = (err) => {
          _parseWorkers = [];
          for (const [id, cb] of _workerCallbacks) {
            cb.rej(err instanceof Error ? err : new Error('Worker error'));
            _workerCallbacks.delete(id);
          }
        };
        pool.push(w);
      }
      URL.revokeObjectURL(blobUrl);
      _parseWorkers = pool;
    } catch (e) {
      _parseWorkers = [];
    }
    return _parseWorkers;
  }

  async function parseBufferOffThread(buf, mode) {
    const pool = initWorkers();
    if (pool && pool.length) {
      const u8 = new Uint8Array(buf);
      const isGz = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
      if (isGz && typeof DecompressionStream === 'undefined') {
        const p = getFallbackParser();
        return mode === 'omt' ? p.parseOmtMvt(buf) : p.parseMvt(buf);
      }
      return new Promise((res, rej) => {
        const id = ++_workerSeq;
        _workerCallbacks.set(id, { res, rej });
        const w = pool[_workerRobin++ % pool.length];
        w.postMessage({ id, mode, buf }, [buf]);
      });
    }
    const p = getFallbackParser();
    const raw = await p.maybeGunzip(buf);
    return mode === 'omt' ? p.parseOmtMvt(raw) : p.parseMvt(raw);
  }

  // =========================================================================
  // СЕТЕВАЯ ЗАГРУЗКА И КЭШ MVT + OMT (С ДЕДУПЛИКАЦИЕЙ И КОНТРОЛЛЕРАМИ)
  // =========================================================================
  const MAX_NATIVE_ZOOM = 14;
  const MIN_NATIVE_ZOOM = 9;
  const MVT_CACHE_MAX = L.Browser.mobile ? 28 : 44;
  const OMT_CACHE_MAX = L.Browser.mobile ? 16 : 24;
  const AUX_CACHE_MAX = 40;

  const tileCache = new Map();
  const tileInFlight = new Map();

  function getLru(map, key) {
    if (!map.has(key)) return undefined;
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
    return val;
  }

  function setLru(map, key, val, maxSize) {
    if (map.has(key)) map.delete(key);
    while (map.size >= maxSize) map.delete(map.keys().next().value);
    map.set(key, val);
  }

  function trimLru(map, maxSize) {
    while (map.size > maxSize) {
      map.delete(map.keys().next().value);
    }
  }
  async function fetchMvtTile(coords) {
    const z = Math.min(coords.z, MAX_NATIVE_ZOOM);
    const shift = coords.z - z;
    const parentX = coords.x >> shift;
    const parentY = coords.y >> shift;

    const key = `${z}:${parentX}:${parentY}`;
    const cachedLayers = getLru(tileCache, key);
    if (cachedLayers) return { layers: cachedLayers, shift, parentX, parentY };
    if (tileInFlight.has(key)) {
      const layers = await tileInFlight.get(key);
      return layers ? { layers, shift, parentX, parentY } : null;
    }

    const loadPromise = (async () => {
      const urls = [
        L.Util.template(TILE_URL_TEMPLATE, { z, x: parentX, y: parentY }),
        L.Util.template(BACKUP_URL_TEMPLATE, { z, x: parentX, y: parentY })
      ];

      if (navigator.onLine === false || !window._wmOaFetchPatched) {
        if (WM.offlineArea && typeof WM.offlineArea.readCachedBuffer === 'function') {
          for (const url of urls) {
            try {
              const cachedBuf = await WM.offlineArea.readCachedBuffer(url);
              if (cachedBuf) {
                const layers = await parseBufferOffThread(cachedBuf, 'mvt');
               setLru(tileCache, key, layers, MVT_CACHE_MAX);
                return layers;
              }
            } catch (e) {}
          }
        }
        if (navigator.onLine === false) return null;
      }

      for (const url of urls) {
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 7500);
          const resp = await fetch(url, { signal: ctl.signal, mode: 'cors' });
          clearTimeout(tm);
          if (!resp.ok) continue;

          const buf = await resp.arrayBuffer();
          const layers = await parseBufferOffThread(buf, 'mvt');
         setLru(tileCache, key, layers, MVT_CACHE_MAX);
          return layers;
        } catch (e) {}
      }
      return null;
    })();

    tileInFlight.set(key, loadPromise);
    try {
      const layers = await loadPromise;
      return layers ? { layers, shift, parentX, parentY } : null;
    } finally {
      tileInFlight.delete(key);
    }
  }

  function isOmtNeeded() {
    return !!((cfg.peaks && cfg.peaks.enabled) || (cfg.parks && cfg.parks.enabled));
  }

  function getCachedOmtTile(coords) {
    if (!isOmtNeeded() || coords.z < OMT_MIN_ZOOM) return null;
    const z = Math.min(coords.z, OMT_MAX_ZOOM);
    const shift = coords.z - z;
    const parentX = coords.x >> shift;
    const parentY = coords.y >> shift;
    const key = `${z}:${parentX}:${parentY}`;
    const cachedOmt = getLru(omtTileCache, key);
    if (!cachedOmt) return null;
    return { layers: cachedOmt, shift, parentX, parentY };
  }

  async function fetchOmtTile(coords) {
    if (!isOmtNeeded() || coords.z < OMT_MIN_ZOOM) return null;
    const z = Math.min(coords.z, OMT_MAX_ZOOM);
    const shift = coords.z - z;
    const parentX = coords.x >> shift;
    const parentY = coords.y >> shift;
    const key = `${z}:${parentX}:${parentY}`;

    const cachedOmt = getLru(omtTileCache, key);
    if (cachedOmt) return { layers: cachedOmt, shift, parentX, parentY };
    if (omtTileInFlight.has(key)) {
      const layers = await omtTileInFlight.get(key);
      return layers ? { layers, shift, parentX, parentY } : null;
    }

    const loadPromise = (async () => {
      const ofmTpl = await getOfmTileTemplate();
      const ofmUrl = L.Util.template(ofmTpl, { z, x: parentX, y: parentY });
      const vtUrl  = L.Util.template(OMT_BACKUP_TPL, { z, x: parentX, y: parentY });
      const urls = (Date.now() < _ofmSkipUntil) ? [vtUrl, ofmUrl] : [ofmUrl, vtUrl];

      if (navigator.onLine === false || !window._wmOaFetchPatched) {
        if (WM.offlineArea && typeof WM.offlineArea.readCachedBuffer === 'function') {
          for (const url of urls) {
            try {
              const cachedBuf = await WM.offlineArea.readCachedBuffer(url);
              if (cachedBuf) {
                const layers = await parseBufferOffThread(cachedBuf, 'omt');
                setLru(omtTileCache, key, layers, OMT_CACHE_MAX);
                return layers;
              }
            } catch (e) {}
          }
        }
        if (navigator.onLine === false) return null;
      }

      for (const url of urls) {
        const isOfm = url === ofmUrl;
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 5500);
          const resp = await fetch(url, { signal: ctl.signal, mode: 'cors' });
          clearTimeout(tm);

          if (resp.status === 204 || resp.status === 404) {
            if (isOfm) _ofmFailStreak = 0;
            const empty = {};
            setLru(omtTileCache, key, OMT_CACHE_MAX);
            return empty;
          }
          if (!resp.ok) throw new Error('HTTP ' + resp.status);

          const buf = await resp.arrayBuffer();
          const layers = await parseBufferOffThread(buf, 'omt');
          if (isOfm) _ofmFailStreak = 0;
          setLru(omtTileCache, key, layers, OMT_CACHE_MAX);
          return layers;
        } catch (e) {
          if (isOfm) {
            _ofmFailStreak++;
            if (_ofmFailStreak >= 3) _ofmSkipUntil = Date.now() + 60000;
          }
        }
      }
      return null;
    })();

    omtTileInFlight.set(key, loadPromise);
    try {
      const layers = await loadPromise;
      return layers ? { layers, shift, parentX, parentY } : null;
    } finally {
      omtTileInFlight.delete(key);
    }
  }

  const DEFAULT_CONFIG = {
    enabled: true,
    blendMode: "overlay",
    opacity: 0.6,
    forest: {
      enabled: true,
      fillColor: "#3b5323",
      fillOpacity: 0.22,
      strokeColor: "#253b16",
      strokeWidth: 1.0,
      strokeDash: true
    },
    farmland: {
      enabled: true,
      fillColor: "#c9b97b",
      fillOpacity: 0.24,
      strokeColor: "#7c6a3e",
      strokeWidth: 0.8,
      pattern: true
    },
    cemeteries: {
      enabled: true,
      fillColor: "#7f8a78",
      fillOpacity: 0.32,
      strokeColor: "#373d34",
      strokeWidth: 0.9,
      pattern: true
    },
    piers: {
      enabled: true,
      fillColor: "#9c7a54",
      strokeColor: "#2e1f12",
      width: 2.0,
      opacity: 0.85,
      woodcut: true
    },
    peaks: {
      enabled: true,
      color: "#2b190d",
      iconColor: "#2b190d",
      haloColor: "#f4ead5",
      iconStyle: "classic",       // 'classic' | 'engraved' | 'triangulation' | 'cross'
      iconScale: 1.0,
      size: 11,
      opacity: 1.0,
      bold: false,
      italic: true,
      showElevation: true,
      elePosition: "below",       // 'below' | 'inline'
      showVolcanoes: true,
      showPasses: true,
      unnamedAtHighZoom: false    // показывать ли безымянные отметки высот на z13+
    },
    parks: {
      enabled: true,
      borders: true,
      borderStyle: "dashdot",     // 'dashdot' | 'double' | 'dashed' | 'dotted' | 'solid'
      borderGlow: true,
      fillColor: "#3e6b3a",
      fillOpacity: 0.08,
      fillPattern: "hatch",       // 'hatch' | 'dots' | 'none'
      strokeColor: "#285425",
      strokeWidth: 1.4,
      strokeOpacity: 0.80,
      labelColor: "#1f471d",
      haloColor: "#eff5e6",
      size: 12.5,
      opacity: 1.0,
      labelStyle: "arch",         // 'arch' | 'straight'
      archCurve: 38,              // -80..+80 (%)
      letterSpacing: 2.0,         // px
      ornament: "leaves",         // 'leaves' | 'stars' | 'crest' | 'none'
      uppercase: true,
      bold: true,
      italic: true
    },
    roads: {
      major: {
        enabled: true,
        color: "#a78772",
        width: 2.2,
        casing: true,
        casingColor: "#363126",
        casingWidth: 2.6
      },
      track: {
        enabled: true,
        color: "#f0d6c2",
        width: 1.8,
        casing: true,
        casingColor: "#2c2521",
        casingWidth: 1.7
      },
      path: {
        enabled: true,
        color: "#362416",
        width: 2.7,
        dashed: true
      },
      minor: {
        enabled: true,
        color: "#2a1c14",
        width: 3.3
      }
    },
    railways: {
      enabled: true,
      style: "ties",        // 'ties' | 'blocks' | 'dashed'
      color: "#2b1e16",
      tieColor: "#f2e7d5",
      width: 1.8,
      opacity: 0.9,
      minorEnabled: true,
      stations: {
        enabled: true,
        labelsEnabled: true,
        showIcon: true,
        showHalts: true,
        minZoom: 13,          // Shortbread отдаёт станции начиная с z13
        labelStyle: "plate",  // 'plate' (табличка) | 'halo' (ореол)
        color: "#24160d",
        haloColor: "#f4ead5",
        iconColor: "#24160d",
        size: 10.5,
        iconScale: 1.0,
        opacity: 1.0,
        bold: true,
        italic: false
      }
    },
    water: {
      rivers: { enabled: true, color: "#082c3a", width: 3, opacity: 0.65 },
      lakes: { enabled: true, fillColor: "#334661", fillOpacity: 0.5, strokeColor: "#09212a", strokeWidth: 3 },
      oceans: { enabled: true, fillColor: "#80a8b3", fillOpacity: 0.6, strokeColor: "#1d3842", strokeWidth: 1.2 },
      marshes: { enabled: true, fillColor: "#8da383", fillOpacity: 0.35, strokeColor: "#4b6343", strokeWidth: 0.8, pattern: true }
    },
    labels: {
      blendMode: "normal",
      opacity: 1.0,
      banners: {
        enabled: true,
        bannerColor: "#ede4d1",
        bannerStrokeColor: "#2c1c0f",
        bannerStrokeWidth: 1.2,
        washColor: "#dfcaa7",
        washOpacity: 0.65,
        paddingX: 8,
        paddingY: 3,
        scale: 1.0
      },
      major: { enabled: true, color: "#0e0c0b", haloColor: "#aea6a2", size: 22, bold: true },
      minor: { enabled: true, color: "#120c08", haloColor: "#bb9d90", size: 15, bold: false },
      localities: { enabled: true, color: "#090707", haloColor: "#958e8e", size: 9.5, italic: true },
      water: { enabled: true, color: "#0b1019", haloColor: "#6c87c6", size: 16.5, italic: true }
    },
    transport: {
      enabled: true,
      color: "#241811",
      haloColor: "#f2e7d5",
      size: 1.0,
      airEnabled: true,
      railEnabled: true,
      busEnabled: true,
      labelsEnabled: true
    },
    pois: {
      enabled: true,
      color: "#3a2110",
      haloColor: "#f4ead5",
      scale: 1.0,
      historicEnabled: true,
      tourismEnabled: true,
      manmadeEnabled: true,
      amenityEnabled: true,
      labelsEnabled: true
    },
    buildings: {
      enabled: true,
      fillColor: "#37271a",
      fillOpacity: 0.45,
      strokeColor: "#0c0704",
      strokeWidth: 0.8
    }
  };

  let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    const saved = JSON.parse(localStorage.getItem('wm_vector_roads_custom') || '{}');
    cfg = deepMerge(cfg, saved);
  } catch (e) {}

  // Гарантия наличия новых секций при миграции со старого localStorage
  for (const sec of ['forest', 'farmland', 'cemeteries', 'piers', 'railways', 'transport', 'pois', 'peaks', 'parks']) {
    if (!cfg[sec]) cfg[sec] = JSON.parse(JSON.stringify(DEFAULT_CONFIG[sec]));
  }

  if (!cfg.railways.stations) {
    cfg.railways.stations = JSON.parse(JSON.stringify(DEFAULT_CONFIG.railways.stations));
  }

  // Защита от старых сохранений в localStorage:

  function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const out = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
    for (const key of Object.keys(source)) {
      const sv = source[key];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        out[key] = deepMerge(
          (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) ? out[key] : {},
          sv
        );
      } else {
        out[key] = sv;
      }
    }
    return out;
  }

  let layerInstance = null;

  function saveConfig() {
    try {
      localStorage.setItem('wm_vector_roads_custom', JSON.stringify(cfg));
    } catch (e) {}
  }

  // Функция адаптации цвета к текущему освещению карты (День / Ночь)
function getLightingState(coords) {
    if (!WM.demRelief || typeof WM.demRelief.getLighting !== 'function') {
      return { night: 0.0, sun: 1.0, twilight: 0.0, isMorning: false };
    }
    const z = coords.z;
    const n = 1 << z;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n)));
    const lat = latRad * (180.0 / Math.PI);
    const lng = ((coords.x + 0.5) / n) * 360.0 - 180.0;
    const L = WM.demRelief.getLighting(lat, lng);
    return {
      night: L.nightWeight !== undefined ? L.nightWeight : 0.0,
      sun: L.sunIntensity !== undefined ? L.sunIntensity : 1.0,
      twilight: L.twilightAmt !== undefined ? L.twilightAmt : 0.0,
      isMorning: L.isMorning !== undefined ? L.isMorning : (L.sunVec ? L.sunVec[0] < 0 : false)
    };
  }

  const labelColorCache = new Map();
 /**
   * Адаптация цвета под время суток:
   * - День: оригинальный цвет без искажений
   * - Закат: мягкое затемнение с пурпурным/винным оттенком
   * - Ночь: спокойный ненасыщенный лунно-синий тон (без угольной черноты)
   * - Утро: свежий прохладный голубой тон
   */
  function adaptLabelColor(hex, light, type = 'text') {
    if (!hex) return hex;
    const { night = 0, twilight = 0, isMorning = false } = light || {};

    if (night <= 0.01 && twilight <= 0.01) return hex;

    const key = `${hex}|${night.toFixed(2)}|${twilight.toFixed(2)}|${isMorning ? 1 : 0}|${type}`;
    const cached = labelColorCache.get(key);
    if (cached) return cached;

    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return hex;

    let r = (num >> 16) & 255;
    let g = (num >> 8) & 255;
    let b = num & 255;

    const tNight = Math.min(1.0, night);
    const tDaylight = Math.max(0.0, 1.0 - tNight);
    const tMorning = Math.min(1.0, twilight * (isMorning ? 1.0 : 0.0) * tDaylight);
    const tEvening = Math.min(1.0, twilight * (!isMorning ? 1.0 : 0.0) * tDaylight);

    const lerp = (v0, v1, t) => v0 + (v1 - v0) * Math.max(0, Math.min(1, t));

    if (type === 'text') {
      if (tEvening > 0) {
        r = lerp(r, 48, tEvening * 0.70);
        g = lerp(g, 22, tEvening * 0.70);
        b = lerp(b, 58, tEvening * 0.75);
      }
      if (tMorning > 0) {
        r = lerp(r, 26, tMorning * 0.65);
        g = lerp(g, 54, tMorning * 0.65);
        b = lerp(b, 88, tMorning * 0.75);
      }
      if (tNight > 0) {
        // Глубокое затемнение до плотных ночных чернил (почти чёрный с лёгким оттенком)
        r = lerp(r * (1.0 - tNight * 0.75), 7, tNight * 0.88);
        g = lerp(g * (1.0 - tNight * 0.75), 9, tNight * 0.88);
        b = lerp(b * (1.0 - tNight * 0.75), 15, tNight * 0.88);
      }
    } else if (type === 'halo') {
      if (tEvening > 0) {
        r = lerp(r, 142, tEvening * 0.65);
        g = lerp(g, 102, tEvening * 0.65);
        b = lerp(b, 155, tEvening * 0.70);
      }
      if (tMorning > 0) {
        r = lerp(r, 125, tMorning * 0.65);
        g = lerp(g, 165, tMorning * 0.65);
        b = lerp(b, 208, tMorning * 0.70);
      }
      if (tNight > 0) {
        // Мягкий полутеневой серо-синий ореол без белых засветов и без сажи
        r = lerp(r, 24, tNight * 0.82);
        g = lerp(g, 36, tNight * 0.82);
        b = lerp(b, 58, tNight * 0.82);
      }
    } else if (type === 'banner') {
      if (tEvening > 0) {
        r = lerp(r, 208, tEvening * 0.60);
        g = lerp(g, 172, tEvening * 0.60);
        b = lerp(b, 205, tEvening * 0.65);
      }
      if (tMorning > 0) {
        r = lerp(r, 192, tMorning * 0.55);
        g = lerp(g, 212, tMorning * 0.55);
        b = lerp(b, 232, tMorning * 0.60);
      }
      if (tNight > 0) {
        r = lerp(r, 34, tNight * 0.82);
        g = lerp(g, 46, tNight * 0.82);
        b = lerp(b, 70, tNight * 0.82);
      }
    } else if (type === 'wash') {
      if (tEvening > 0) {
        r = lerp(r, 185, tEvening * 0.60);
        g = lerp(g, 138, tEvening * 0.60);
        b = lerp(b, 182, tEvening * 0.65);
      }
      if (tMorning > 0) {
        r = lerp(r, 158, tMorning * 0.60);
        g = lerp(g, 188, tMorning * 0.60);
        b = lerp(b, 218, tMorning * 0.65);
      }
      if (tNight > 0) {
        r = lerp(r, 28, tNight * 0.82);
        g = lerp(g, 42, tNight * 0.82);
        b = lerp(b, 65, tNight * 0.82);
      }
    } else if (type === 'stroke') {
      if (tEvening > 0) {
        r = lerp(r, 48, tEvening * 0.60);
        g = lerp(g, 22, tEvening * 0.60);
        b = lerp(b, 52, tEvening * 0.70);
      }
      if (tMorning > 0) {
        r = lerp(r, 26, tMorning * 0.60);
        g = lerp(g, 52, tMorning * 0.60);
        b = lerp(b, 82, tMorning * 0.70);
      }
      if (tNight > 0) {
        // Контур свитка ночью также уводим в глубокий почти чёрный
        r = lerp(r * (1.0 - tNight * 0.75), 10, tNight * 0.85);
        g = lerp(g * (1.0 - tNight * 0.75), 12, tNight * 0.85);
        b = lerp(b * (1.0 - tNight * 0.75), 18, tNight * 0.85);
      }
    }

    const res = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    if (labelColorCache.size > 800) labelColorCache.clear();
    labelColorCache.set(key, res);
    return res;
  }
  function adaptHexForNight(hex, nightFactor, isHalo = false) {
    return adaptLabelColor(hex, { night: nightFactor, twilight: 0, isMorning: false }, isHalo ? 'halo' : 'text');
  }


  // =========================================================================
  // ОПТИМИЗИРОВАННЫЙ MVT ПАРСЕР (ZERO GC, FLAT ARRAYS & BBOX)
  // =========================================================================



  // Кэш цветов RGBA
  const rgbaCache = new Map();
  function hexToRgba(hex, alpha) {
    const key = `${hex}_${alpha}`;
    const cached = rgbaCache.get(key);
    if (cached) return cached;

    let c = (hex || '#000000').replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    const res = `rgba(${r}, ${g}, ${b}, ${alpha})`;

    if (rgbaCache.size > 300) rgbaCache.clear();
    rgbaCache.set(key, res);
    return res;
  }

  function isWaterLineVisibleAtZoom(props, zoom) {
    const k = (props && props.kind) || 'stream';
    if (zoom < 10 && k !== 'river') return false;
    if (zoom < 12 && (k === 'stream' || k === 'ditch' || k === 'drain')) return false;
    return true;
  }

  function getZoomScale(z) {
    if (z <= 9) return 0.75;
    if (z === 10) return 0.85;
    if (z === 11) return 0.92;
    if (z <= 13) return 1.0;
    
    // Начиная с 14 зума названия плавно увеличиваются с каждым шагом приближения:
    // z14: ×1.28, z15: ×1.60, z16: ×1.96, z17: ×2.36, z18+: ×2.80
    const step = z - 13;
    return Math.min(3.2, 1.0 + step * 0.28 + (step * step) * 0.04);
  }

  // Кэш измерений ширины текста (убирает тяжелые вызовы ctx.measureText)
  const textWidthCache = new Map();
  function getCachedTextWidth(ctx, text, fontKey) {
    const k = `${fontKey}|${text}`;
    let w = textWidthCache.get(k);
    if (w !== undefined) return w;
    w = ctx.measureText(text).width;
    if (textWidthCache.size > 2000) textWidthCache.clear();
    textWidthCache.set(k, w);
    return w;
  }

  // =========================================================================
  // СИСТЕМА КОЛЛИЗИЙ И ДЕДУПЛИКАЦИИ НАДПИСЕЙ
  // =========================================================================
 // =========================================================================
  // ГЛОБАЛЬНЫЙ МЕЖТАЙЛОВЫЙ МЕНЕДЖЕР КОЛЛИЗИЙ И ДЕДУПЛИКАЦИИ
  // =========================================================================
   class GlobalLabelCollisionManager {
    constructor() {
      this.currentZoom = -1;
      this.names = new Map();      // cleanName -> [{ cleanName, gx, gy, tileKey }]
      this.nameGrid = new Map();   // cellKey(256px) -> [{ cleanName, gx, gy, tileKey }]
      this.boxGrid = new Map();    // cellKey(128px) -> [boxRec]
      this.tileIndex = new Map();  // tileKey -> { boxes: [], names: [] }
      this._queryId = 0;
    }

    _normalizeName(name) {
      return name.trim().toLowerCase().replace(/ё/g, 'е');
    }

    _packCell(cx, cy) {
      return (cx + 1024) * 67108864 + (cy + 1024);
    }

    _getTileBucket(tileKey) {
      let b = this.tileIndex.get(tileKey);
      if (!b) {
        b = { boxes: [], names: [] };
        this.tileIndex.set(tileKey, b);
      }
      return b;
    }

    hasDuplicate(name, gx, gy, minDist = 140) {
      const cleanName = this._normalizeName(name);
      const minDistSq = minDist * minDist;

      const exactList = this.names.get(cleanName);
      if (exactList) {
        for (let i = 0; i < exactList.length; i++) {
          const dx = exactList[i].gx - gx;
          const dy = exactList[i].gy - gy;
          if (dx * dx + dy * dy < minDistSq) return true;
        }
      }

      const fuzzyDist = minDist * 0.75;
      const fuzzyDistSq = fuzzyDist * fuzzyDist;
      const minCx = Math.floor((gx - fuzzyDist) / 256);
      const maxCx = Math.floor((gx + fuzzyDist) / 256);
      const minCy = Math.floor((gy - fuzzyDist) / 256);
      const maxCy = Math.floor((gy + fuzzyDist) / 256);

      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const cell = this.nameGrid.get(this._packCell(cx, cy));
          if (!cell) continue;
          for (let i = 0; i < cell.length; i++) {
            const p = cell[i];
            if (p.cleanName === cleanName) continue;
            if (p.cleanName.startsWith(cleanName) || cleanName.startsWith(p.cleanName)) {
              const dx = p.gx - gx;
              const dy = p.gy - gy;
              if (dx * dx + dy * dy < fuzzyDistSq) return true;
            }
          }
        }
      }
      return false;
    }

    registerName(name, gx, gy, tileKey = '') {
      const cleanName = this._normalizeName(name);
      const cellKey = this._packCell(Math.floor(gx / 256), Math.floor(gy / 256));
      const entry = { cleanName, gx, gy, tileKey, cellKey };

      let list = this.names.get(cleanName);
      if (!list) { list = []; this.names.set(cleanName, list); }
      list.push(entry);

      let cell = this.nameGrid.get(cellKey);
      if (!cell) { cell = []; this.nameGrid.set(cellKey, cell); }
      cell.push(entry);

      if (tileKey) this._getTileBucket(tileKey).names.push(entry);
    }

    isDuplicate(name, gx, gy, minDist = 140, tileKey = '') {
      if (this.hasDuplicate(name, gx, gy, minDist)) return true;
      this.registerName(name, gx, gy, tileKey);
      return false;
    }

    clear() {
      this.names.clear();
      this.nameGrid.clear();
      this.boxGrid.clear();
      this.tileIndex.clear();
    }

    resetIfZoomChanged(z) {
      if (this.currentZoom !== z) {
        this.currentZoom = z;
        this.clear();
      }
    }

    removeTile(tileKey) {
      const bucket = this.tileIndex.get(tileKey);
      if (!bucket) return;
      this.tileIndex.delete(tileKey);

      for (let i = 0; i < bucket.boxes.length; i++) {
        const rec = bucket.boxes[i];
        for (let c = 0; c < rec.cells.length; c++) {
          const ck = rec.cells[c];
          const cell = this.boxGrid.get(ck);
          if (!cell) continue;
          const idx = cell.indexOf(rec);
          if (idx !== -1) {
            if (cell.length === 1) this.boxGrid.delete(ck);
            else {
              cell[idx] = cell[cell.length - 1];
              cell.pop();
            }
          }
        }
      }

      for (let i = 0; i < bucket.names.length; i++) {
        const entry = bucket.names[i];
        const list = this.names.get(entry.cleanName);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx !== -1) {
            if (list.length === 1) this.names.delete(entry.cleanName);
            else {
              list[idx] = list[list.length - 1];
              list.pop();
            }
          }
        }
        const cell = this.nameGrid.get(entry.cellKey);
        if (cell) {
          const idx = cell.indexOf(entry);
          if (idx !== -1) {
            if (cell.length === 1) this.nameGrid.delete(entry.cellKey);
            else {
              cell[idx] = cell[cell.length - 1];
              cell.pop();
            }
          }
        }
      }
    }

    collides(box, padding = 4) {
      const x1 = box.gx - padding;
      const y1 = box.gy - padding;
      const x2 = box.gx + box.w + padding;
      const y2 = box.gy + box.h + padding;

      const minCx = Math.floor(x1 / 128);
      const maxCx = Math.floor(x2 / 128);
      const minCy = Math.floor(y1 / 128);
      const maxCy = Math.floor(y2 / 128);
      const qid = ++this._queryId;

      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const cell = this.boxGrid.get(this._packCell(cx, cy));
          if (!cell) continue;
          for (let i = 0; i < cell.length; i++) {
            const b = cell[i];
            if (b._qid === qid) continue;
            b._qid = qid;
            if (x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1) return true;
          }
        }
      }
      return false;
    }

    add(box, padding = 4) {
      const x1 = box.gx - padding;
      const y1 = box.gy - padding;
      const x2 = box.gx + box.w + padding;
      const y2 = box.gy + box.h + padding;

      const minCx = Math.floor(x1 / 128);
      const maxCx = Math.floor(x2 / 128);
      const minCy = Math.floor(y1 / 128);
      const maxCy = Math.floor(y2 / 128);

      const cells = [];
      const rec = { x1, y1, x2, y2, tileKey: box.tileKey || '', _qid: 0, cells };

      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const ck = this._packCell(cx, cy);
          let cell = this.boxGrid.get(ck);
          if (!cell) { cell = []; this.boxGrid.set(ck, cell); }
          cell.push(rec);
          cells.push(ck);
        }
      }

      if (rec.tileKey) this._getTileBucket(rec.tileKey).boxes.push(rec);
    }
  }






  const globalLabelMgr = new GlobalLabelCollisionManager();

  // =========================================================================
  // БЫСТРАЯ ПАКЕТНАЯ ОТРИСОВКА ТАЙЛА (BATCHED CANVAS PATHS)
  // =========================================================================

  // Безопасный перевод любого формата (hex или rgb) в rgba
  function colorToRgba(col, alpha) {
    if (!col) return `rgba(0,0,0,${alpha})`;
    if (col.startsWith('rgba(')) return col;
    if (col.startsWith('rgb(')) {
      return col.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    }
    return hexToRgba(col, alpha);
  }

  // =========================================================================
  // 1. ОТРИСОВКА ГЕОМЕТРИИ (ПОД ЛЕСОМ: ДОРОГИ, ВОДА, ЛЕСА, ЗДАНИЯ)
  // =========================================================================

  // =========================================================================
  // КЭШ ПАТТЕРНОВ ДЛЯ ЗАЛИВОК И ШИРИНЫ СИМВОЛОВ (БЕЗ CLIP + LOOP)
  // =========================================================================
  const patternCache = new Map();
  function getFillPattern(ctx, type, color) {
    const key = `${type}|${color}`;
    let pat = patternCache.get(key);
    if (pat) return pat;

    const c = document.createElement('canvas');
    const pCtx = c.getContext('2d');

    if (type === 'farmland') {
      c.width = 256; c.height = 256;
      pCtx.strokeStyle = hexToRgba(color, 0.45);
      pCtx.lineWidth = 0.7;
      pCtx.setLineDash([6, 4]);
      pCtx.beginPath();
      for (let offset = -256; offset < 512; offset += 16) {
        pCtx.moveTo(offset, 0);
        pCtx.lineTo(offset + 256, 256);
      }
      pCtx.stroke();
    } else if (type === 'cemeteries') {
      c.width = 16; c.height = 32;
      pCtx.strokeStyle = hexToRgba(color, 0.78);
      pCtx.lineWidth = 0.9;
      pCtx.lineCap = 'round';
      pCtx.beginPath();
      pCtx.moveTo(4, 4.5); pCtx.lineTo(4, 11.5);
      pCtx.moveTo(1.5, 6.8); pCtx.lineTo(6.5, 6.8);
      pCtx.moveTo(12, 20.5); pCtx.lineTo(12, 27.5);
      pCtx.moveTo(9.5, 22.8); pCtx.lineTo(14.5, 22.8);
      pCtx.stroke();
    } else if (type === 'marshes') {
      c.width = 16; c.height = 32;
      pCtx.strokeStyle = color;
      pCtx.lineWidth = 0.8;
      pCtx.beginPath();
      // Ряд 0 (x=4, y=8)
      pCtx.moveTo(0, 8); pCtx.lineTo(8, 8);
      pCtx.moveTo(2, 8); pCtx.lineTo(2, 5);
      pCtx.moveTo(6, 8); pCtx.lineTo(6, 5.5);
      // Ряд 1 (x=12, y=24)
      pCtx.moveTo(8, 24); pCtx.lineTo(16, 24);
      pCtx.moveTo(10, 24); pCtx.lineTo(10, 21);
      pCtx.moveTo(14, 24); pCtx.lineTo(14, 21.5);
      pCtx.stroke();
    } else if (type === 'park_hatch') {
      c.width = 12; c.height = 12;
      pCtx.strokeStyle = hexToRgba(color, 0.24);
      pCtx.lineWidth = 0.7;
      pCtx.beginPath();
      pCtx.moveTo(-12, 0); pCtx.lineTo(0, 12);
      pCtx.moveTo(0, 0); pCtx.lineTo(12, 12);
      pCtx.moveTo(12, 0); pCtx.lineTo(24, 12);
      pCtx.stroke();
    } else if (type === 'park_dots') {
      c.width = 12; c.height = 24;
      pCtx.fillStyle = hexToRgba(color, 0.30);
      pCtx.beginPath();
      pCtx.arc(4, 6, 0.9, 0, Math.PI * 2);
      pCtx.arc(10, 18, 0.9, 0, Math.PI * 2);
      pCtx.fill();
    }

    pat = ctx.createPattern(c, 'repeat');
    if (patternCache.size > 80) patternCache.clear();
    patternCache.set(key, pat);
    return pat;
  }

  // Кэш ширины отдельных символов (ускоряет drawTextAlongPath и изогнутые названия парков)
  const charWidthCache = new Map();
  function getCachedCharWidth(ctx, ch, fontKey) {
    let fMap = charWidthCache.get(fontKey);
    if (!fMap) {
      if (charWidthCache.size > 60) charWidthCache.clear();
      fMap = new Map();
      charWidthCache.set(fontKey, fMap);
    }
    let w = fMap.get(ch);
    if (w === undefined) {
      w = ctx.measureText(ch).width;
      fMap.set(ch, w);
    }
    return w;
  }

  // Общий 1x1 канвас для мгновенных измерений до выделения тайлового GPU-буфера
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = 1; measureCanvas.height = 1;
  const measureCtx = measureCanvas.getContext('2d');


  function renderGeometryTile(canvas, data, coords, omtData = null) {
    const pad = 0;
    const { layers, shift } = data;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, 256, 256);

    const zoom = coords.z;
const night = 0; // Принудительно отключаем ночную адаптацию для всей геометрии

    let subX = 0, subY = 0, subFactor = 1;
    if (shift > 0) {
      subFactor = 1 << shift;
      subX = coords.x % subFactor;
      subY = coords.y % subFactor;
    }

   function getTransformParams(layerExtent, customShift = shift) {
      const extent = layerExtent || 4096;
      if (customShift > 0) {
        const sf = 1 << customShift;
        const sx = ((coords.x % sf) + sf) % sf;
        const sy = ((coords.y % sf) + sf) % sf;
        const fullPx = 256 * sf;
        const factor = fullPx / extent;
        const offsetX = sx * 256;
        const offsetY = sy * 256;
        const marginExt = extent * 0.05 + pad * (extent / fullPx);
        const minVisX = (sx * extent / sf) - marginExt;
        const maxVisX = ((sx + 1) * extent / sf) + marginExt;
        const minVisY = (sy * extent / sf) - marginExt;
        const maxVisY = ((sy + 1) * extent / sf) + marginExt;
        return { factor, offsetX, offsetY, minVisX, maxVisX, minVisY, maxVisY, isOverzoomed: true };
      } else {
        const factor = 256 / extent;
        const marginPx = 256 * 0.05 + pad;
        const marginExt = marginPx * (extent / 256);
        return { factor, offsetX: 0, offsetY: 0, minVisX: -marginExt, maxVisX: extent + marginExt, minVisY: -marginExt, maxVisY: extent + marginExt, isOverzoomed: false };
      }
    }

    function appendGeomStrokeNoClipToPath(geom, extent, factor, offsetX, offsetY) {
      const ext = extent || 4096;
      const eps = Math.max(2, ext * 0.0005); // ~0.12px на 256px канвасе (покрывает округление вершин)
      const maxC = ext - eps;

      for (let l = 0; l < geom.length; l++) {
        const line = geom[l];
        const len = line.length;
        if (len < 4) continue;

        let penDown = false;
        for (let i = 0; i < len - 2; i += 2) {
          const x0 = line[i];
          const y0 = line[i + 1];
          const x1 = line[i + 2];
          const y1 = line[i + 3];

          const isClipVertical =
            Math.abs(x0 - x1) <= 1.5 && ((x0 <= eps && x1 <= eps) || (x0 >= maxC && x1 >= maxC));
          const isClipHorizontal =
            Math.abs(y0 - y1) <= 1.5 && ((y0 <= eps && y1 <= eps) || (y0 >= maxC && y1 >= maxC));

          if (isClipVertical || isClipHorizontal) {
            penDown = false;
            continue;
          }

          if (!penDown) {
            ctx.moveTo(x0 * factor - offsetX, y0 * factor - offsetY);
            penDown = true;
          }
          ctx.lineTo(x1 * factor - offsetX, y1 * factor - offsetY);
        }
      }
    }

    function appendGeomFlatToPath(geom, factor, offsetX, offsetY) {
      for (let l = 0; l < geom.length; l++) {
        const line = geom[l];
        const len = line.length;
        if (len < 4) continue;
        ctx.moveTo(line[0] * factor - offsetX, line[1] * factor - offsetY);
        for (let i = 2; i < len; i += 2) {
          ctx.lineTo(line[i] * factor - offsetX, line[i + 1] * factor - offsetY);
        }
      }
    }

    function isFeatureInView(bbox, t) {
      if (!t.isOverzoomed) return true;
      return !(bbox[2] < t.minVisX || bbox[0] > t.maxVisX || bbox[3] < t.minVisY || bbox[1] > t.maxVisY);
    }

    // 0. КОНТУРЫ ЛЕСНЫХ МАССИВОВ (Forest / Wood из слоя land)
    if (cfg.forest && cfg.forest.enabled && layers.land) {
      const fCfg = cfg.forest;
      const landExt = layers.land.extent || 4096;
      const t = getTransformParams(landExt);
      const feats = layers.land.features;

      const forestGeoms = [];
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const k = f.props.kind;
        if (k !== 'forest' && k !== 'wood') continue;
        if (!isFeatureInView(f.bbox, t)) continue;
        forestGeoms.push(f.geom);
      }

      if (forestGeoms.length) {
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(fCfg.fillColor, night), fCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < forestGeoms.length; i++) {
          appendGeomFlatToPath(forestGeoms[i], t.factor, t.offsetX, t.offsetY);
        }
        if (fCfg.fillOpacity > 0.001) ctx.fill();

        if (fCfg.strokeWidth > 0.05) {
          ctx.strokeStyle = adaptHexForNight(fCfg.strokeColor, night);
          ctx.lineWidth = fCfg.strokeWidth;
          ctx.lineJoin = 'round';
          ctx.setLineDash(fCfg.strokeDash ? [4, 3] : []);
          ctx.beginPath();
          for (let i = 0; i < forestGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(forestGeoms[i], landExt, t.factor, t.offsetX, t.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 0.1 ПАШНИ, САДЫ И ВИНОГРАДНИКИ
    if (cfg.farmland && cfg.farmland.enabled && zoom >= 10 && layers.land) {
      const fCfg = cfg.farmland;
      const landExt = layers.land.extent || 4096;
      const t = getTransformParams(landExt);
      const feats = layers.land.features;
      const farmGeoms = [];

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!FARM_KINDS.has(f.props.kind)) continue;
        if (!isFeatureInView(f.bbox, t)) continue;
        farmGeoms.push(f.geom);
      }

      if (farmGeoms.length) {
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(fCfg.fillColor, night), fCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < farmGeoms.length; i++) {
          appendGeomFlatToPath(farmGeoms[i], t.factor, t.offsetX, t.offsetY);
        }
        if (fCfg.fillOpacity > 0.001) ctx.fill('evenodd');

        if (fCfg.pattern && zoom >= 12) {
          ctx.fillStyle = getFillPattern(ctx, 'farmland', adaptHexForNight(fCfg.strokeColor, night));
          ctx.fill('evenodd');
        }

        if (fCfg.strokeWidth > 0.05) {
          ctx.strokeStyle = adaptHexForNight(fCfg.strokeColor, night);
          ctx.lineWidth = fCfg.strokeWidth;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          for (let i = 0; i < farmGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(farmGeoms[i], landExt, t.factor, t.offsetX, t.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 0.2 КЛАДБИЩА И ПОГОСТЫ
    if (cfg.cemeteries && cfg.cemeteries.enabled && zoom >= 13 && layers.land) {
      const cCfg = cfg.cemeteries;
      const landExt = layers.land.extent || 4096;
      const t = getTransformParams(landExt);
      const feats = layers.land.features;
      const cemGeoms = [];

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!CEMETERY_KINDS.has(f.props.kind)) continue;
        if (!isFeatureInView(f.bbox, t)) continue;
        cemGeoms.push(f.geom);
      }

      if (cemGeoms.length) {
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(cCfg.fillColor, night), cCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < cemGeoms.length; i++) {
          appendGeomFlatToPath(cemGeoms[i], t.factor, t.offsetX, t.offsetY);
        }
        if (cCfg.fillOpacity > 0.001) ctx.fill('evenodd');

        if (cCfg.pattern) {
          ctx.fillStyle = getFillPattern(ctx, 'cemeteries', adaptHexForNight(cCfg.strokeColor, night));
          ctx.fill('evenodd');
        }
        if (cCfg.strokeWidth > 0.05) {
          ctx.strokeStyle = adaptHexForNight(cCfg.strokeColor, night);
          ctx.lineWidth = cCfg.strokeWidth;
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let i = 0; i < cemGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(cemGeoms[i], landExt, t.factor, t.offsetX, t.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 0.3 ЗАПОВЕДНИКИ, НАЦПАРКИ И ЗАКАЗНИКИ (OpenMapTiles layer 'park')
    if (cfg.parks && cfg.parks.enabled && cfg.parks.borders && omtData && omtData.layers && omtData.layers.park) {
      const pLayer = omtData.layers.park;
      if (pLayer.polys && pLayer.polys.length) {
        const pkCfg = cfg.parks;
        const pkExt = pLayer.extent || 4096;
        const t = getTransformParams(pkExt, omtData.shift);
        const parkGeoms = [];

        for (let i = 0; i < pLayer.polys.length; i++) {
          const f = pLayer.polys[i];
          if (!isFeatureInView(f.bbox, t)) continue;
          parkGeoms.push(f.geom);
        }

        if (parkGeoms.length) {
          ctx.save();
          const fAlpha = pkCfg.fillOpacity ?? 0.08;
          const sAlpha = pkCfg.strokeOpacity ?? 0.80;
          const sWidth = pkCfg.strokeWidth ?? 1.4;
          const fillHex = adaptHexForNight(pkCfg.fillColor || '#3e6b3a', night);
          const strokeHex = adaptHexForNight(pkCfg.strokeColor || '#285425', night);

          ctx.beginPath();
          for (let i = 0; i < parkGeoms.length; i++) {
            appendGeomFlatToPath(parkGeoms[i], t.factor, t.offsetX, t.offsetY);
          }

          if (fAlpha > 0.005) {
            ctx.fillStyle = hexToRgba(fillHex, fAlpha);
            ctx.fill('evenodd');
          }

          // Декоративный растр заливки заповедника (диагональная штриховка или точки)
          const fPat = pkCfg.fillPattern || 'none';
          if (fPat === 'hatch' && zoom >= 9) {
            ctx.fillStyle = getFillPattern(ctx, 'park_hatch', strokeHex);
            ctx.fill('evenodd');
          } else if (fPat === 'dots' && zoom >= 9) {
            ctx.fillStyle = getFillPattern(ctx, 'park_dots', strokeHex);
            ctx.fill('evenodd');
          }

          if (sWidth > 0.05 && sAlpha > 0.01) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Мягкая охранная лента вдоль границы ООПТ
            if (pkCfg.borderGlow) {
              ctx.strokeStyle = hexToRgba(fillHex, Math.min(0.45, sAlpha * 0.30));
              ctx.lineWidth = sWidth * 3.6;
              ctx.setLineDash([]);
              ctx.beginPath();
              for (let i = 0; i < parkGeoms.length; i++) {
                appendGeomStrokeNoClipToPath(parkGeoms[i], pkExt, t.factor, t.offsetX, t.offsetY);
              }
              ctx.stroke();
            }

            const bStyle = pkCfg.borderStyle || 'dashdot';
            if (bStyle === 'double') {
              // Внешняя прерывистая кайма + тонкая внутренняя линия
              ctx.strokeStyle = hexToRgba(strokeHex, sAlpha * 0.42);
              ctx.lineWidth = sWidth * 2.1;
              ctx.setLineDash([10, 4]);
              ctx.beginPath();
              for (let i = 0; i < parkGeoms.length; i++) {
                appendGeomStrokeNoClipToPath(parkGeoms[i], pkExt, t.factor, t.offsetX, t.offsetY);
              }
              ctx.stroke();

              ctx.strokeStyle = hexToRgba(strokeHex, sAlpha);
              ctx.lineWidth = Math.max(0.6, sWidth * 0.85);
              ctx.setLineDash([]);
              ctx.stroke();
            } else {
              let dash = [];
              if (bStyle === 'dashdot') dash = [8, 3.5, 2, 3.5];
              else if (bStyle === 'dashed') dash = [7, 4];
              else if (bStyle === 'dotted') dash = [1.8, 3.8];

              ctx.strokeStyle = hexToRgba(strokeHex, sAlpha);
              ctx.lineWidth = sWidth;
              ctx.setLineDash(dash);
              ctx.beginPath();
              for (let i = 0; i < parkGeoms.length; i++) {
                appendGeomStrokeNoClipToPath(parkGeoms[i], pkExt, t.factor, t.offsetX, t.offsetY);
              }
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }
    }

    // 1. БОЛОТА И ТОПИ
    if (cfg.water.marshes.enabled && layers.land) {
      const mCfg = cfg.water.marshes;
      const landExt = layers.land.extent || 4096;
      const t = getTransformParams(landExt);
      const feats = layers.land.features;
      const marshGeoms = [];

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!WETLAND_KINDS.has(f.props.kind)) continue;
        if (!isFeatureInView(f.bbox, t)) continue;
        marshGeoms.push(f.geom);
      }

      if (marshGeoms.length) {
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(mCfg.fillColor, night), mCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < marshGeoms.length; i++) {
          appendGeomFlatToPath(marshGeoms[i], t.factor, t.offsetX, t.offsetY);
        }
        if (mCfg.fillOpacity > 0.001) ctx.fill('evenodd');

        if (mCfg.pattern && zoom >= 12) {
          ctx.fillStyle = getFillPattern(ctx, 'marshes', adaptHexForNight(mCfg.strokeColor, night));
          ctx.fill('evenodd');
        }

        if (mCfg.strokeWidth > 0) {
          ctx.strokeStyle = adaptHexForNight(mCfg.strokeColor, night);
          ctx.lineWidth = mCfg.strokeWidth;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          for (let i = 0; i < marshGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(marshGeoms[i], landExt, t.factor, t.offsetX, t.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 2. ВОДНЫЕ ПОЛИГОНЫ (Озера и моря)
    const lakeGeoms = [];
    const oceanGeoms = [];
    const lakeFeats = [];
    const oceanFeats = [];
    let tWaterPoly = null;

    if (layers.water_polygons) {
      tWaterPoly = getTransformParams(layers.water_polygons.extent);
      const feats = layers.water_polygons.features;

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!isFeatureInView(f.bbox, tWaterPoly)) continue;
        const k = f.props.kind || '';
        const isOcean = (k === 'ocean' || k === 'sea' || f.props.maritime);
        if (isOcean) {
          if (cfg.water.oceans.enabled) {
            oceanGeoms.push(f.geom);
            oceanFeats.push(f);
          }
        } else {
          if (cfg.water.lakes.enabled) {
            lakeGeoms.push(f.geom);
            lakeFeats.push(f);
          }
        }
      }

      const waterExt = layers.water_polygons.extent || 4096;

      if (lakeGeoms.length) {
        const wCfg = cfg.water.lakes;
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(wCfg.fillColor, night), wCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < lakeGeoms.length; i++) {
          appendGeomFlatToPath(lakeGeoms[i], tWaterPoly.factor, tWaterPoly.offsetX, tWaterPoly.offsetY);
        }
        if (wCfg.fillOpacity > 0.001) ctx.fill();

        if (wCfg.strokeWidth > 0.05) {
          ctx.strokeStyle = adaptHexForNight(wCfg.strokeColor, night);
          ctx.lineWidth = wCfg.strokeWidth;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let i = 0; i < lakeGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(lakeGeoms[i], waterExt, tWaterPoly.factor, tWaterPoly.offsetX, tWaterPoly.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }

      if (oceanGeoms.length) {
        const wCfg = cfg.water.oceans;
        ctx.save();
        ctx.fillStyle = hexToRgba(adaptHexForNight(wCfg.fillColor, night), wCfg.fillOpacity);
        ctx.beginPath();
        for (let i = 0; i < oceanGeoms.length; i++) {
          appendGeomFlatToPath(oceanGeoms[i], tWaterPoly.factor, tWaterPoly.offsetX, tWaterPoly.offsetY);
        }
        if (wCfg.fillOpacity > 0.001) ctx.fill();

        if (wCfg.strokeWidth > 0.05) {
          ctx.strokeStyle = adaptHexForNight(wCfg.strokeColor, night);
          ctx.lineWidth = wCfg.strokeWidth;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let i = 0; i < oceanGeoms.length; i++) {
            appendGeomStrokeNoClipToPath(oceanGeoms[i], waterExt, tWaterPoly.factor, tWaterPoly.offsetX, tWaterPoly.offsetY);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 3. ВОДНЫЕ ЛИНИИ (Реки и ручьи) — клиппинг только при реальном пересечении с водоёмами
    if (cfg.water.rivers.enabled && layers.water_lines) {
      const rCfg = cfg.water.rivers;
      const t = getTransformParams(layers.water_lines.extent);
      const feats = layers.water_lines.features;

      let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
      const riverBuckets = { major: [], mid: [], minor: [] };
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!isFeatureInView(f.bbox, t)) continue;
        if (!isWaterLineVisibleAtZoom(f.props, zoom)) continue;
        const k = f.props.kind || 'stream';
        if (k === 'river') riverBuckets.major.push(f.geom);
        else if (k === 'canal' || k === 'stream') riverBuckets.mid.push(f.geom);
        else riverBuckets.minor.push(f.geom);

        const bx0 = f.bbox[0] * t.factor - t.offsetX;
        const by0 = f.bbox[1] * t.factor - t.offsetY;
        const bx1 = f.bbox[2] * t.factor - t.offsetX;
        const by1 = f.bbox[3] * t.factor - t.offsetY;
        if (bx0 < rMinX) rMinX = bx0;
        if (by0 < rMinY) rMinY = by0;
        if (bx1 > rMaxX) rMaxX = bx1;
        if (by1 > rMaxY) rMaxY = by1;
      }

      if (riverBuckets.major.length || riverBuckets.mid.length || riverBuckets.minor.length) {
        ctx.save();
        ctx.strokeStyle = hexToRgba(adaptHexForNight(rCfg.color, night), rCfg.opacity);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (tWaterPoly && (lakeFeats.length > 0 || oceanFeats.length > 0)) {
          const clipGeoms = [];
          const checkClip = (list) => {
            for (let i = 0; i < list.length; i++) {
              const f = list[i];
              const wx0 = f.bbox[0] * tWaterPoly.factor - tWaterPoly.offsetX;
              const wy0 = f.bbox[1] * tWaterPoly.factor - tWaterPoly.offsetY;
              const wx1 = f.bbox[2] * tWaterPoly.factor - tWaterPoly.offsetX;
              const wy1 = f.bbox[3] * tWaterPoly.factor - tWaterPoly.offsetY;
              if (wx1 >= rMinX - 4 && wx0 <= rMaxX + 4 && wy1 >= rMinY - 4 && wy0 <= rMaxY + 4) {
                clipGeoms.push(f.geom);
              }
            }
          };
          checkClip(lakeFeats);
          checkClip(oceanFeats);

          if (clipGeoms.length > 0) {
            ctx.beginPath();
            ctx.rect(-20, -20, 296, 296);
            for (let i = 0; i < clipGeoms.length; i++) {
              appendGeomFlatToPath(clipGeoms[i], tWaterPoly.factor, tWaterPoly.offsetX, tWaterPoly.offsetY);
            }
            ctx.clip('evenodd');
          }
        }

        const drawRiverBucket = (geoms, width) => {
          if (!geoms.length) return;
          ctx.lineWidth = Math.max(0.6, width);
          ctx.beginPath();
          for (let i = 0; i < geoms.length; i++) appendGeomFlatToPath(geoms[i], t.factor, t.offsetX, t.offsetY);
          ctx.stroke();
        };

        drawRiverBucket(riverBuckets.minor, rCfg.width * 0.6);
        drawRiverBucket(riverBuckets.mid, rCfg.width * 0.95);
        drawRiverBucket(riverBuckets.major, rCfg.width * 1.4);
        ctx.restore();
      }
    }

    // 3.5 ПРИЧАЛЫ, ПИРСЫ И ВОЛНОРЕЗЫ (pier_polygons + pier_lines)
    if (cfg.piers && cfg.piers.enabled && zoom >= 12) {
      const pCfg = cfg.piers;
      const fillCol = hexToRgba(adaptHexForNight(pCfg.fillColor, night), pCfg.opacity);
      const strokeCol = hexToRgba(adaptHexForNight(pCfg.strokeColor, night), pCfg.opacity);

      if (layers.pier_polygons && layers.pier_polygons.features.length) {
        const t = getTransformParams(layers.pier_polygons.extent);
        const feats = layers.pier_polygons.features;
        ctx.save();
        ctx.fillStyle = fillCol;
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = Math.max(0.8, pCfg.width * 0.55);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let hasPoly = false;
        for (let i = 0; i < feats.length; i++) {
          if (!isFeatureInView(feats[i].bbox, t)) continue;
          appendGeomFlatToPath(feats[i].geom, t.factor, t.offsetX, t.offsetY);
          hasPoly = true;
        }
        if (hasPoly) {
          ctx.fill();
          ctx.stroke();
          if (pCfg.woodcut) {
            ctx.clip();
            ctx.strokeStyle = hexToRgba(adaptHexForNight(pCfg.strokeColor, night), pCfg.opacity * 0.45);
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            for (let x = 0; x < 256; x += 4) {
              ctx.moveTo(x, 0);
              ctx.lineTo(x, 256);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      if (layers.pier_lines && layers.pier_lines.features.length) {
        const t = getTransformParams(layers.pier_lines.extent);
        const feats = layers.pier_lines.features;
        const pierGeoms = [];
        const stoneGeoms = [];

        for (let i = 0; i < feats.length; i++) {
          if (!isFeatureInView(feats[i].bbox, t)) continue;
          const k = feats[i].props.kind;
          if (k === 'breakwater' || k === 'groyne') stoneGeoms.push(feats[i].geom);
          else pierGeoms.push(feats[i].geom);
        }

        const drawPierLines = (geoms, isStone) => {
          if (!geoms.length) return;
          ctx.save();
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'round';
          // Контур/сваи
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = pCfg.width + (isStone ? 1.6 : 1.0);
          ctx.beginPath();
          for (let i = 0; i < geoms.length; i++) appendGeomFlatToPath(geoms[i], t.factor, t.offsetX, t.offsetY);
          ctx.stroke();

          // Дощатое/каменное полотно
          ctx.strokeStyle = isStone ? hexToRgba('#7a7770', pCfg.opacity) : fillCol;
          ctx.lineWidth = Math.max(0.8, pCfg.width);
          ctx.stroke();

          // Поперечные доски настила / швы кладки
          if (pCfg.woodcut) {
            ctx.strokeStyle = strokeCol;
            ctx.lineWidth = pCfg.width + 1.4;
            ctx.setLineDash(isStone ? [1.2, 5.5] : [1.0, 3.2]);
            ctx.stroke();
          }
          ctx.restore();
        };

        drawPierLines(stoneGeoms, true);
        drawPierLines(pierGeoms, false);
      }
    }

    // 4. ПОСТРОЙКИ
    if (cfg.buildings.enabled && zoom >= 14 && layers.buildings) {
      const bCfg = cfg.buildings;
      const t = getTransformParams(layers.buildings.extent);
      const feats = layers.buildings.features;

      ctx.save();
      ctx.fillStyle = hexToRgba(adaptHexForNight(bCfg.fillColor, night), bCfg.fillOpacity);
      ctx.strokeStyle = adaptHexForNight(bCfg.strokeColor, night);
      ctx.lineWidth = bCfg.strokeWidth;
      ctx.beginPath();

      let hasBld = false;
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!isFeatureInView(f.bbox, t)) continue;
        appendGeomFlatToPath(f.geom, t.factor, t.offsetX, t.offsetY);
        hasBld = true;
      }
      if (hasBld) {
        ctx.fill();
        if (bCfg.strokeWidth > 0) ctx.stroke();
      }
      ctx.restore();
    }



    // 5. ДОРОЖНАЯ СЕТЬ (Оптимизированная пакетная группировка с ночной адаптацией)
    if (layers.streets) {
      const t = getTransformParams(layers.streets.extent);
      const feats = layers.streets.features;

      function roadVisibleAtZoom(k) {
        if (zoom <= 9) return (k === 'motorway' || k === 'trunk');
        if (zoom <= 10) return (k === 'motorway' || k === 'trunk' || k === 'primary');
        if (zoom <= 11) return (k === 'motorway' || k === 'trunk' || k === 'primary' || k === 'secondary');
        if (zoom <= 12) return !(k === 'residential' || k === 'living_street' || k === 'service' || k === 'path' || k === 'footway' || k === 'cycleway');
        if (zoom <= 13) return !(k === 'service' || k === 'footway' || k === 'cycleway');
        return true;
      }

      const buckets = {
        majorMotorway: [],
        majorTrunk: [],
        majorPrimary: [],
        majorOther: [],
        track: [],
        path: [],
        minor: [],
        railMain: [],
        railMainTunnel: [],
        railMinor: [],
        railMinorTunnel: []
      };

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!isFeatureInView(f.bbox, t)) continue;
        const k = f.props.kind || 'unclassified';
        const isRail = !!(f.props.rail || RAIL_KINDS.has(k));

        if (isRail) {
          if (!cfg.railways || !cfg.railways.enabled) continue;
          const isMain = (k === 'rail');
          if (!isMain && !cfg.railways.minorEnabled) continue;
          if (!isMain && (k === 'tram' || k === 'subway') && zoom < 13) continue;
          if (isMain && f.props.service && zoom < 13) continue;

          if (f.props.tunnel) {
            if (isMain) buckets.railMainTunnel.push(f.geom);
            else buckets.railMinorTunnel.push(f.geom);
          } else {
            if (isMain) buckets.railMain.push(f.geom);
            else buckets.railMinor.push(f.geom);
          }
          continue;
        }

        if (!roadVisibleAtZoom(k)) continue;

        if (k === 'motorway') buckets.majorMotorway.push(f.geom);
        else if (k === 'trunk') buckets.majorTrunk.push(f.geom);
        else if (k === 'primary') buckets.majorPrimary.push(f.geom);
        else if (k === 'secondary' || k === 'tertiary') buckets.majorOther.push(f.geom);
        else if (k === 'track') buckets.track.push(f.geom);
        else if (k === 'path' || k === 'footway' || k === 'pedestrian' || k === 'cycleway') buckets.path.push(f.geom);
        else buckets.minor.push(f.geom);
      }

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const strokeBucket = (geomList, color, width, dash = null) => {
        if (!geomList.length) return;
        ctx.strokeStyle = adaptHexForNight(color, night);
        ctx.lineWidth = width;
        if (dash && dash.length) ctx.setLineDash(dash);
        else ctx.setLineDash([]);
        ctx.beginPath();
        for (let i = 0; i < geomList.length; i++) {
          appendGeomFlatToPath(geomList[i], t.factor, t.offsetX, t.offsetY);
        }
        ctx.stroke();
      };

      // Проход 1: Контуры (Casing)
      if (cfg.roads.major.enabled && cfg.roads.major.casing) {
        const cCol = cfg.roads.major.casingColor;
        const cAdd = cfg.roads.major.casingWidth * 2;
        const bw = cfg.roads.major.width;
        strokeBucket(buckets.majorOther, cCol, (bw * 0.85) + cAdd);
        strokeBucket(buckets.majorPrimary, cCol, (bw * 1.05) + cAdd);
        strokeBucket(buckets.majorTrunk, cCol, (bw * 1.2) + cAdd);
        strokeBucket(buckets.majorMotorway, cCol, (bw * 1.35) + cAdd);
      }

      if (cfg.roads.track.enabled && cfg.roads.track.casing) {
        const cCol = cfg.roads.track.casingColor;
        const cw = cfg.roads.track.width + (cfg.roads.track.casingWidth * 2);
        strokeBucket(buckets.track, cCol, cw, [6, 4]);
      }

      // Проход 2: Тело дорог
      if (cfg.roads.minor.enabled) {
        strokeBucket(buckets.minor, cfg.roads.minor.color, cfg.roads.minor.width);
      }
      if (cfg.roads.path.enabled) {
        strokeBucket(buckets.path, cfg.roads.path.color, cfg.roads.path.width, cfg.roads.path.dashed ? [3.5, 3.5] : []);
      }
      if (cfg.roads.track.enabled) {
        strokeBucket(buckets.track, cfg.roads.track.color, cfg.roads.track.width, [5, 4]);
      }
      if (cfg.roads.major.enabled) {
        const mCol = cfg.roads.major.color;
        const bw = cfg.roads.major.width;
        strokeBucket(buckets.majorOther, mCol, bw * 0.85);
        strokeBucket(buckets.majorPrimary, mCol, bw * 1.05);
        strokeBucket(buckets.majorTrunk, mCol, bw * 1.2);
        strokeBucket(buckets.majorMotorway, mCol, bw * 1.35);
      }

      // Проход 3: Железные дороги (поверх автодорог/переездов)
      if (cfg.railways && cfg.railways.enabled) {
        const rCfg = cfg.railways;
        const rw = rCfg.width || 1.8;
        const rCol = hexToRgba(adaptHexForNight(rCfg.color, night), rCfg.opacity);
        const rTie = hexToRgba(adaptHexForNight(rCfg.tieColor, night), rCfg.opacity);

        const drawRailBucket = (geoms, scale, isTunnel) => {
          if (!geoms.length) return;
          ctx.save();
          if (isTunnel) ctx.globalAlpha *= 0.42;

          ctx.beginPath();
          for (let i = 0; i < geoms.length; i++) {
            appendGeomFlatToPath(geoms[i], t.factor, t.offsetX, t.offsetY);
          }

          const w = Math.max(0.8, rw * scale);
          if (rCfg.style === 'dashed' || isTunnel) {
            ctx.strokeStyle = rCol;
            ctx.lineWidth = w;
            ctx.lineCap = 'round';
            ctx.setLineDash([4, 4]);
            ctx.stroke();
          } else if (rCfg.style === 'blocks') {
            ctx.lineCap = 'butt';
            ctx.strokeStyle = rCol;
            ctx.lineWidth = w + 1.0;
            ctx.setLineDash([]);
            ctx.stroke();

            ctx.strokeStyle = rTie;
            ctx.lineWidth = Math.max(0.6, w * 0.6);
            ctx.setLineDash([6, 6]);
            ctx.stroke();
          } else {
            // 'ties': Классический путь со шпалами
            ctx.lineCap = 'butt';
            ctx.strokeStyle = rCol;
            ctx.lineWidth = w * 2.1;
            ctx.setLineDash([1.3, 5.2]);
            ctx.stroke();

            ctx.strokeStyle = rCol;
            ctx.lineWidth = w;
            ctx.setLineDash([]);
            ctx.stroke();

            ctx.strokeStyle = rTie;
            ctx.lineWidth = Math.max(0.5, w * 0.42);
            ctx.stroke();
          }
          ctx.restore();
        };

        drawRailBucket(buckets.railMinorTunnel, 0.72, true);
        drawRailBucket(buckets.railMainTunnel, 1.0, true);
        drawRailBucket(buckets.railMinor, 0.72, false);
        drawRailBucket(buckets.railMain, 1.0, false);
      }

      ctx.restore();
    }
  }

  // =========================================================================
  // ОТРИСОВКА СВИТКОВ И ВИНТАЖНЫХ ПОДЛОЖЕК ДЛЯ НАДПИСЕЙ (КАРТОГРАФИЯ)
  // =========================================================================

  // 1. Старинный свиток с резными завитками (для ключевых городов)
 function drawParchmentScroll(ctx, cx, cy, w, h, bCfg, light, zScale = 1.0) {
    const scaleFactor = Math.max(1.0, zScale * 0.85);
    const padX = (bCfg.paddingX || 8) * (bCfg.scale || 1.0) * scaleFactor;
    const padY = (bCfg.paddingY || 3) * (bCfg.scale || 1.0) * scaleFactor;
    const halfW = (w / 2) + padX;
    const halfH = (h / 2) + padY;

    const fillColor = colorToRgba(adaptLabelColor(bCfg.bannerColor || '#ede4d1', light, 'banner'), 0.94);
    const strokeColor = adaptLabelColor(bCfg.bannerStrokeColor || '#2c1c0f', light, 'stroke');
    const foldColor = colorToRgba(adaptLabelColor('#bfa588', light, 'banner'), 0.92);

    const earW = Math.max(12, halfH * 0.95);
    const earH = halfH * 1.35;
    const notch = earW * 0.38;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (bCfg.bannerStrokeWidth || 1.2) * Math.min(1.8, Math.max(1.0, zScale * 0.7));

    // Левый хвостик
    ctx.beginPath();
    ctx.moveTo(-halfW, -halfH + 3);
    ctx.lineTo(-halfW - earW, -halfH - 2);
    ctx.lineTo(-halfW - earW + notch, -halfH + earH * 0.5);
    ctx.lineTo(-halfW - earW, -halfH + earH);
    ctx.lineTo(-halfW, halfH - 2);
    ctx.closePath();
    ctx.fillStyle = foldColor;
    ctx.strokeStyle = strokeColor;
    ctx.fill();
    ctx.stroke();

    // Правый хвостик
    ctx.beginPath();
    ctx.moveTo(halfW, -halfH + 3);
    ctx.lineTo(halfW + earW, -halfH - 2);
    ctx.lineTo(halfW + earW - notch, -halfH + earH * 0.5);
    ctx.lineTo(halfW + earW, -halfH + earH);
    ctx.lineTo(halfW, halfH - 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Складки-тени
    ctx.beginPath();
    ctx.moveTo(-halfW, halfH - 2);
    ctx.lineTo(-halfW - earW * 0.35, halfH + 4);
    ctx.lineTo(-halfW, -halfH + 3);
    ctx.closePath();
    ctx.fillStyle = strokeColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(halfW, halfH - 2);
    ctx.lineTo(halfW + earW * 0.35, halfH + 4);
    ctx.lineTo(halfW, -halfH + 3);
    ctx.closePath();
    ctx.fill();

    // Полотно свитка
    ctx.beginPath();
    ctx.moveTo(-halfW, -halfH);
    ctx.quadraticCurveTo(0, -halfH - 2.5, halfW, -halfH);
    ctx.lineTo(halfW, halfH);
    ctx.quadraticCurveTo(0, halfH - 2.5, -halfW, halfH);
    ctx.closePath();

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  function drawWashBackground(ctx, cx, cy, w, h, bCfg, light) {
    const padX = (bCfg.paddingX || 6) * 0.85;
    const padY = (bCfg.paddingY || 2.5) * 0.85;
    const rw = (w / 2) + padX;
    const rh = (h / 2) + padY;

    const baseCol = adaptLabelColor(bCfg.washColor || '#dfcaa7', light, 'wash');
    const washCol = colorToRgba(baseCol, bCfg.washOpacity || 0.65);

    ctx.save();
    ctx.fillStyle = washCol;
    ctx.beginPath();
    ctx.moveTo(-rw - 6, 0);
    ctx.bezierCurveTo(-rw, -rh * 1.1, -rw * 0.5, -rh * 1.2, 0, -rh * 1.05);
    ctx.bezierCurveTo(rw * 0.5, -rh * 0.9, rw, -rh * 0.8, rw + 6, 0);
    ctx.bezierCurveTo(rw, rh * 0.8, rw * 0.5, rh * 0.9, 0, rh * 1.05);
    ctx.bezierCurveTo(-rw * 0.5, rh * 1.2, -rw, rh * 1.1, -rw - 6, 0);
    ctx.fill();
    ctx.restore();
  }



  // =========================================================================
  // 2. ОТРИСОВКА НАДПИСЕЙ (НАД ЛЕСОМ: ТОПОНИМИКА, ОЗЕРА, РЕКИ)
  // =========================================================================
    // Функция для отрисовки текста вдоль линии (по кривой)
  // Быстрое сглаживание ломаной реки (алгоритм Чайкина), убирающее острые изломы тайлов
  function normalizeAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // Упрощение мелких зигзагов (Ramer-Douglas-Peucker) для плоского массива [x,y, x,y...]
  function simplifyFlatPolyline(pts, tolerance = 3.0) {
    const count = pts.length / 2;
    if (count <= 2) return pts;

    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(count);
    keep[0] = 1;
    keep[count - 1] = 1;

    const stack = [[0, count - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxSqDist = 0;
      let idx = -1;

      const ax = pts[first * 2], ay = pts[first * 2 + 1];
      const bx = pts[last * 2],  by = pts[last * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;

      for (let i = first + 1; i < last; i++) {
        const px = pts[i * 2], py = pts[i * 2 + 1];
        let sqDist;
        if (lenSq === 0) {
          sqDist = (px - ax) * (px - ax) + (py - ay) * (py - ay);
        } else {
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          const qx = ax + t * dx, qy = ay + t * dy;
          sqDist = (px - qx) * (px - qx) + (py - qy) * (py - qy);
        }
        if (sqDist > maxSqDist) {
          maxSqDist = sqDist;
          idx = i;
        }
      }

      if (maxSqDist > sqTol && idx !== -1) {
        keep[idx] = 1;
        stack.push([first, idx], [idx, last]);
      }
    }

    const res = [];
    for (let i = 0; i < count; i++) {
      if (keep[i]) res.push(pts[i * 2], pts[i * 2 + 1]);
    }
    return res;
  }

  function smoothRiverPolyline(pts) {
    if (pts.length < 6) return pts;
    const res = [pts[0], pts[1]];
    for (let i = 0; i < pts.length - 2; i += 2) {
      const x0 = pts[i],     y0 = pts[i + 1];
      const x1 = pts[i + 2], y1 = pts[i + 3];
      res.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1);
      res.push(0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
    }
    res.push(pts[pts.length - 2], pts[pts.length - 1]);
    return res;
  }

  /**
   * Подбирает наименее изогнутый участок реки и готовит позиции букв.
   * Вызывается ДО регистрации коллизии в globalLabelMgr.
   */
  function prepareRiverTextPlacement(ctx, text, rawPts, fontSize = 14, opts = {}) {
    if (!text || rawPts.length < 4) return null;

    const MAX_STEP_RAD = (opts.maxStepDeg ?? 22) * (Math.PI / 180);
    const MAX_ARC_RAD  = (opts.maxArcDeg  ?? 48) * (Math.PI / 180);
    const MIN_CHORD    = opts.minChordRatio ?? 0.80;
    const STRICT_MODE  = opts.strict ?? false;
    const isForbidden  = typeof opts.isForbidden === 'function' ? opts.isForbidden : null;

    // 1. Убираем мелкий зигзаг, затем дважды сглаживаем
    const simplified = simplifyFlatPolyline(rawPts, Math.max(2.5, fontSize * 0.22));
    const pts = smoothRiverPolyline(smoothRiverPolyline(simplified));

    const dists = [0];
    let totalLen = 0;
    for (let i = 0; i < pts.length - 2; i += 2) {
      totalLen += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      dists.push(totalLen);
    }
    if (totalLen < 25) return null;

    const charWidths = new Array(text.length);
    let textW = 0;
    for (let i = 0; i < text.length; i++) {
      const w = getCachedCharWidth(ctx, text[i], ctx.font);
      charWidths[i] = w;
      textW += w;
    }
    if (textW > totalLen * 0.92) return null;

    function ptAt(d) {
      const clamped = Math.max(0, Math.min(totalLen, d));
      let lo = 0, hi = dists.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (dists[mid] <= clamped) lo = mid; else hi = mid - 1;
      }
      const d0 = dists[lo], d1 = dists[lo + 1] || d0;
      const t = (d1 - d0) > 1e-4 ? (clamped - d0) / (d1 - d0) : 0;
      const p = lo * 2;
      return {
        x: pts[p] + (pts[p + 2] - pts[p]) * t,
        y: pts[p + 1] + (pts[p + 3] - pts[p + 1]) * t
      };
    }

    const ANGLE_WINDOW = Math.max(14, fontSize * 1.15);

    function evalWindow(startD) {
      const endD = startD + textW;
      const pA = ptAt(startD);
      const pB = ptAt(endD);

      // Если край слова попадает в другой водоём — сразу отбрасываем окно
      if (isForbidden && (isForbidden(pA.x, pA.y) || isForbidden(pB.x, pB.y))) {
        return { hitForbidden: true, valid: false };
      }

      const isReversed = pB.x < pA.x;
      const chordDx = isReversed ? (pA.x - pB.x) : (pB.x - pA.x);
      const chordDy = isReversed ? (pA.y - pB.y) : (pB.y - pA.y);
      const chordLen = Math.hypot(chordDx, chordDy);
      const chordRatio = textW > 0 ? chordLen / textW : 1;
      const chordAngle = Math.atan2(chordDy, chordDx);

      let curD = isReversed ? endD : startD;
      const dir = isReversed ? -1 : 1;

      const samples = [];
      let minRel = 0, maxRel = 0, maxStep = 0, prevRel = null;

      for (let i = 0; i < text.length; i++) {
        const cw = charWidths[i];
        const midD = curD + dir * (cw * 0.5);
        const pt = ptAt(midD);

        if (isForbidden && isForbidden(pt.x, pt.y)) {
          return { hitForbidden: true, valid: false };
        }

        const pBefore = ptAt(midD - dir * ANGLE_WINDOW);
        const pAfter  = ptAt(midD + dir * ANGLE_WINDOW);
        const rawAngle = Math.atan2(pAfter.y - pBefore.y, pAfter.x - pBefore.x);
        const rel = normalizeAngle(rawAngle - chordAngle);

        if (i === 0) { minRel = rel; maxRel = rel; }
        else {
          if (rel < minRel) minRel = rel;
          if (rel > maxRel) maxRel = rel;
          const step = Math.abs(normalizeAngle(rel - prevRel));
          if (step > maxStep) maxStep = step;
        }
        prevRel = rel;
        samples.push({ ch: text[i], cw, x: pt.x, y: pt.y, angle: rawAngle, rel });
        curD += dir * cw;
      }

      const maxArc = maxRel - minRel;
      const maxAbsRel = Math.max(Math.abs(minRel), Math.abs(maxRel));
      const midPt = ptAt(startD + textW * 0.5);
      const centerDist = Math.abs((startD + textW * 0.5) - totalLen * 0.5) / totalLen;

      const valid = (maxStep <= MAX_STEP_RAD) && (maxArc <= MAX_ARC_RAD) && (maxAbsRel <= MAX_ARC_RAD * 0.75) && (chordRatio >= MIN_CHORD);
      const score = maxArc * 2.2 + maxStep * 3.0 + (1 - chordRatio) * 4.0 + centerDist * 0.35;

      return { hitForbidden: false, valid, score, samples, maxStep, maxArc, chordAngle, chordRatio, midPt, isReversed };
    }

    // 2. Скользящим окном ищем самый прямой участок вне иных водоёмов
    const freeSpan = totalLen - textW;
    const stepPx = Math.max(8, Math.min(20, freeSpan / 8));
    let bestValid = null;
    let bestAnyAllowed = null;

    const considerCand = (cand) => {
      if (!cand || cand.hitForbidden) return;
      if (!bestAnyAllowed || cand.score < bestAnyAllowed.score) bestAnyAllowed = cand;
      if (cand.valid && (!bestValid || cand.score < bestValid.score)) bestValid = cand;
    };

    for (let d = 0; d <= freeSpan + 0.5; d += stepPx) {
      considerCand(evalWindow(Math.min(d, freeSpan)));
    }
    considerCand(evalWindow(freeSpan * 0.5));

    const chosen = bestValid || bestAnyAllowed;
    if (!chosen) return null;
    if (!chosen.valid && STRICT_MODE) return null;

    // 3. Если выбранный участок изогнут сильнее лимита — плавно ограничиваем угол
    let glyphs = chosen.samples;
    if (!chosen.valid) {
      const kArc  = chosen.maxArc  > 1e-4 ? MAX_ARC_RAD / chosen.maxArc : 1;
      const kStep = chosen.maxStep > 1e-4 ? MAX_STEP_RAD / chosen.maxStep : 1;
      const k = Math.max(0, Math.min(1, kArc, kStep));

      let accX = 0, accY = 0;
      const built = [];
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        const clampedRel = Math.max(-MAX_ARC_RAD * 0.5, Math.min(MAX_ARC_RAD * 0.5, g.rel * k));
        const a = chosen.chordAngle + clampedRel;
        const dx = Math.cos(a), dy = Math.sin(a);
        const cx = accX + dx * (g.cw * 0.5);
        const cy = accY + dy * (g.cw * 0.5);
        built.push({ ch: g.ch, cw: g.cw, x: cx, y: cy, angle: a });
        accX += dx * g.cw;
        accY += dy * g.cw;
      }

      const midIdx = built.length >> 1;
      const shiftX = chosen.midPt.x - built[midIdx].x;
      const shiftY = chosen.midPt.y - built[midIdx].y;
      for (let i = 0; i < built.length; i++) {
        built[i].x += shiftX;
        built[i].y += shiftY;
        if (isForbidden && isForbidden(built[i].x, built[i].y)) return null;
      }
      glyphs = built;
    }

    const midG = glyphs[glyphs.length >> 1];
    return {
      glyphs,
      textW,
      centerX: midG.x,
      centerY: midG.y,
      midAngle: midG.angle,
      isReversed: chosen.isReversed
    };
  }


  function drawPreparedRiverText(ctx, placement, offsetY, fillStyle, strokeStyle, lineWidth, fontSize = 14) {
    const { glyphs, centerX, centerY, midAngle, isReversed } = placement;

    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.strokeText(g.ch, 0, offsetY);
      ctx.fillText(g.ch, 0, offsetY);
      ctx.restore();
    }

    // Стрелка течения под словом
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(midAngle);
    if (isReversed) ctx.scale(-1, 1);

    const arrowOffsetY = offsetY + Math.max(8, fontSize * 0.62) + 3.5;
    const halfLen = Math.max(7, Math.min(18, fontSize * 0.55));
    const headSize = Math.max(2.6, fontSize * 0.19);

    const traceArrow = () => {
      ctx.beginPath();
      ctx.moveTo(-halfLen, arrowOffsetY);
      ctx.lineTo(halfLen, arrowOffsetY);
      ctx.lineTo(halfLen - headSize * 1.4, arrowOffsetY - headSize);
      ctx.moveTo(halfLen, arrowOffsetY);
      ctx.lineTo(halfLen - headSize * 1.4, arrowOffsetY + headSize);
    };

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    traceArrow();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = Math.max(2.8, lineWidth * 0.9);
    ctx.stroke();

    traceArrow();
    ctx.strokeStyle = fillStyle;
    ctx.lineWidth = Math.max(1.25, fontSize * 0.085);
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  }

  function drawEngravedTransportIcon(ctx, kind, x, y, r, ink, halo) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawShape = () => {
      ctx.beginPath();
      if (kind === 'aerodrome') {
        ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
        // Силуэт самолёта
        ctx.moveTo(0, -r * 0.85);
        ctx.lineTo(0, r * 0.85);
        ctx.moveTo(-r * 0.85, -r * 0.05);
        ctx.lineTo(r * 0.85, -r * 0.05);
        ctx.moveTo(-r * 0.35, r * 0.65);
        ctx.lineTo(r * 0.35, r * 0.65);
      } else if (kind === 'helipad') {
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.moveTo(-r * 0.38, -r * 0.45);
        ctx.lineTo(-r * 0.38, r * 0.45);
        ctx.moveTo(r * 0.38, -r * 0.45);
        ctx.lineTo(r * 0.38, r * 0.45);
        ctx.moveTo(-r * 0.38, 0);
        ctx.lineTo(r * 0.38, 0);
      } else if (kind === 'ferry_terminal') {
        // Якорь
        ctx.arc(0, -r * 0.58, r * 0.22, 0, Math.PI * 2);
        ctx.moveTo(0, -r * 0.36);
        ctx.lineTo(0, r * 0.72);
        ctx.moveTo(-r * 0.45, -r * 0.15);
        ctx.lineTo(r * 0.45, -r * 0.15);
        ctx.moveTo(-r * 0.65, r * 0.28);
        ctx.quadraticCurveTo(0, r * 0.92, r * 0.65, r * 0.28);
      } else if (kind === 'aerialway_station') {
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.rect(-r * 0.35, -r * 0.35, r * 0.7, r * 0.7);
      } else if (kind === 'station' || kind === 'halt') {
        const s = kind === 'station' ? r * 0.85 : r * 0.62;
        ctx.rect(-s, -s, s * 2, s * 2);
        if (kind === 'station') {
          ctx.moveTo(-s * 0.55, -s * 0.55);
          ctx.lineTo(s * 0.55, s * 0.55);
          ctx.moveTo(s * 0.55, -s * 0.55);
          ctx.lineTo(-s * 0.55, s * 0.55);
        }
      } else {
        // bus_station / bus_stop / tram_stop
        const rad = kind === 'bus_station' ? r * 0.78 : r * 0.55;
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
      }
    };

    // Ореол / пергаментная подложка
    drawShape();
    if (kind === 'station' || kind === 'halt' || kind === 'aerodrome' || kind === 'helipad' || kind === 'bus_station' || kind === 'bus_stop' || kind === 'tram_stop') {
      ctx.fillStyle = halo;
      ctx.fill();
    }
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3.0;
    ctx.stroke();

    // Основная гравюрная тушь
    drawShape();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.45;
    ctx.stroke();

    if (kind === 'halt' || kind === 'bus_stop' || kind === 'tram_stop') {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEngravedPoiIcon(ctx, sub, religion, x, y, r, ink, halo) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const trace = () => {
      ctx.beginPath();
      switch (sub) {
        case 'castle': {
          // Зубчатая башня замка
          ctx.moveTo(-r * 0.8, r * 0.8);
          ctx.lineTo(-r * 0.8, -r * 0.3);
          ctx.lineTo(-r * 0.5, -r * 0.3);
          ctx.lineTo(-r * 0.5, -r * 0.75);
          ctx.lineTo(-r * 0.2, -r * 0.75);
          ctx.lineTo(-r * 0.2, -r * 0.45);
          ctx.lineTo(r * 0.2, -r * 0.45);
          ctx.lineTo(r * 0.2, -r * 0.75);
          ctx.lineTo(r * 0.5, -r * 0.75);
          ctx.lineTo(r * 0.5, -r * 0.3);
          ctx.lineTo(r * 0.8, -r * 0.3);
          ctx.lineTo(r * 0.8, r * 0.8);
          ctx.closePath();
          break;
        }
        case 'fort': {
          // Бастионная звезда (Вобан)
          for (let i = 0; i < 8; i++) {
            const ang = (i * Math.PI) / 4;
            const rad = (i % 2 === 0) ? r * 0.95 : r * 0.45;
            const px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          break;
        }
        case 'ruins': {
          // Обломанные колонны + арка
          ctx.moveTo(-r * 0.65, r * 0.8);
          ctx.lineTo(-r * 0.65, -r * 0.7);
          ctx.lineTo(-r * 0.35, -r * 0.7);
          ctx.lineTo(-r * 0.35, r * 0.8);
          ctx.moveTo(r * 0.25, r * 0.8);
          ctx.lineTo(r * 0.25, -r * 0.25);
          ctx.lineTo(r * 0.6, -r * 0.05);
          ctx.lineTo(r * 0.6, r * 0.8);
          ctx.moveTo(-r * 0.85, r * 0.8);
          ctx.lineTo(r * 0.85, r * 0.8);
          break;
        }
        case 'archaeological_site': {
          // Дольмен / мегалитический трилитон
          ctx.moveTo(-r * 0.55, r * 0.7); ctx.lineTo(-r * 0.45, -r * 0.25);
          ctx.moveTo(r * 0.55, r * 0.7); ctx.lineTo(r * 0.45, -r * 0.25);
          ctx.moveTo(-r * 0.85, -r * 0.2); ctx.lineTo(r * 0.85, -r * 0.45);
          break;
        }
        case 'monument':
        case 'memorial': {
          // Обелиск на пьедестале
          ctx.moveTo(-r * 0.6, r * 0.85); ctx.lineTo(r * 0.6, r * 0.85);
          ctx.moveTo(-r * 0.3, r * 0.85); ctx.lineTo(-r * 0.16, -r * 0.55);
          ctx.lineTo(0, -r * 0.92); ctx.lineTo(r * 0.16, -r * 0.55); ctx.lineTo(r * 0.3, r * 0.85);
          break;
        }
        case 'battlefield': {
          // Скрещённые мечи
          ctx.moveTo(-r * 0.75, r * 0.75); ctx.lineTo(r * 0.75, -r * 0.75);
          ctx.moveTo(-r * 0.55, r * 0.15); ctx.lineTo(-r * 0.15, r * 0.55);
          ctx.moveTo(r * 0.75, r * 0.75); ctx.lineTo(-r * 0.75, -r * 0.75);
          ctx.moveTo(r * 0.55, r * 0.15); ctx.lineTo(r * 0.15, r * 0.55);
          break;
        }
        case 'wayside_cross':
        case 'wayside_shrine': {
          ctx.moveTo(0, -r * 0.9); ctx.lineTo(0, r * 0.75);
          ctx.moveTo(-r * 0.5, -r * 0.35); ctx.lineTo(r * 0.5, -r * 0.35);
          ctx.moveTo(-r * 0.45, r * 0.75); ctx.lineTo(r * 0.45, r * 0.75);
          break;
        }
        case 'viewpoint': {
          // Веер лучей обзора
          ctx.arc(0, r * 0.45, r * 0.28, 0, Math.PI * 2);
          for (let a = -0.9; a <= 0.95; a += 0.45) {
            ctx.moveTo(Math.sin(a) * r * 0.35, r * 0.45 - Math.cos(a) * r * 0.35);
            ctx.lineTo(Math.sin(a) * r * 1.05, r * 0.45 - Math.cos(a) * r * 1.05);
          }
          break;
        }
        case 'alpine_hut': {
          // Горный приют с трубой
          ctx.moveTo(-r * 0.85, r * 0.05); ctx.lineTo(0, -r * 0.82); ctx.lineTo(r * 0.85, r * 0.05);
          ctx.moveTo(-r * 0.62, -r * 0.15); ctx.lineTo(-r * 0.62, r * 0.75); ctx.lineTo(r * 0.62, r * 0.75); ctx.lineTo(r * 0.62, -r * 0.15);
          ctx.moveTo(r * 0.35, -r * 0.45); ctx.lineTo(r * 0.35, -r * 0.82);
          break;
        }
        case 'camp_site': {
          // Палатка
          ctx.moveTo(-r * 0.9, r * 0.75); ctx.lineTo(0, -r * 0.8); ctx.lineTo(r * 0.9, r * 0.75); ctx.closePath();
          ctx.moveTo(-r * 0.28, r * 0.75); ctx.lineTo(0, r * 0.05); ctx.lineTo(r * 0.28, r * 0.75);
          break;
        }
        case 'picnic_site': {
          // Стол для пикника
          ctx.moveTo(-r * 0.7, -r * 0.35); ctx.lineTo(r * 0.7, -r * 0.35);
          ctx.moveTo(-r * 0.9, r * 0.15); ctx.lineTo(r * 0.9, r * 0.15);
          ctx.moveTo(-r * 0.45, -r * 0.35); ctx.lineTo(-r * 0.65, r * 0.7);
          ctx.moveTo(r * 0.45, -r * 0.35); ctx.lineTo(r * 0.65, r * 0.7);
          break;
        }
        case 'information': {
          ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
          ctx.moveTo(0, -r * 0.38); ctx.lineTo(0, -r * 0.42);
          ctx.moveTo(0, -r * 0.08); ctx.lineTo(0, r * 0.45);
          break;
        }
        case 'tower': {
          // Сторожевая вышка
          ctx.moveTo(-r * 0.55, -r * 0.75); ctx.lineTo(r * 0.55, -r * 0.75);
          ctx.moveTo(-r * 0.35, -r * 0.75); ctx.lineTo(-r * 0.55, r * 0.8); ctx.lineTo(r * 0.55, r * 0.8); ctx.lineTo(r * 0.35, -r * 0.75);
          break;
        }
        case 'lighthouse': {
          // Маяк с лучами
          ctx.moveTo(-r * 0.4, r * 0.85); ctx.lineTo(-r * 0.2, -r * 0.55); ctx.lineTo(r * 0.2, -r * 0.55); ctx.lineTo(r * 0.4, r * 0.85); ctx.closePath();
          ctx.moveTo(-r * 0.95, -r * 0.75); ctx.lineTo(-r * 0.35, -r * 0.55); ctx.lineTo(-r * 0.95, -r * 0.35);
          ctx.moveTo(r * 0.95, -r * 0.75); ctx.lineTo(r * 0.35, -r * 0.55); ctx.lineTo(r * 0.95, -r * 0.35);
          break;
        }
        case 'windmill': {
          // Ветряная мельница
          ctx.moveTo(-r * 0.4, r * 0.85); ctx.lineTo(-r * 0.2, -r * 0.2); ctx.lineTo(r * 0.2, -r * 0.2); ctx.lineTo(r * 0.4, r * 0.85); ctx.closePath();
          ctx.moveTo(-r * 0.75, -r * 0.9); ctx.lineTo(r * 0.75, r * 0.3);
          ctx.moveTo(r * 0.75, -r * 0.9); ctx.lineTo(-r * 0.75, r * 0.3);
          break;
        }
        case 'watermill': {
          // Водяная мельница (колесо + скат)
          ctx.arc(0, r * 0.25, r * 0.58, 0, Math.PI * 2);
          ctx.moveTo(-r * 0.58, r * 0.25); ctx.lineTo(r * 0.58, r * 0.25);
          ctx.moveTo(0, -r * 0.33); ctx.lineTo(0, r * 0.83);
          ctx.moveTo(-r * 0.75, -r * 0.35); ctx.lineTo(0, -r * 0.85); ctx.lineTo(r * 0.75, -r * 0.35);
          break;
        }
        case 'water_well': {
          // Колодец
          ctx.rect(-r * 0.55, r * 0.15, r * 1.1, r * 0.65);
          ctx.moveTo(-r * 0.55, r * 0.15); ctx.lineTo(-r * 0.55, -r * 0.4);
          ctx.moveTo(r * 0.55, r * 0.15); ctx.lineTo(r * 0.55, -r * 0.4);
          ctx.moveTo(-r * 0.75, -r * 0.35); ctx.lineTo(0, -r * 0.85); ctx.lineTo(r * 0.75, -r * 0.35);
          break;
        }
        case 'shelter': {
          // Навес от непогоды
          ctx.moveTo(-r * 0.85, -r * 0.25); ctx.lineTo(0, -r * 0.8); ctx.lineTo(r * 0.85, -r * 0.25);
          ctx.moveTo(-r * 0.6, -r * 0.4); ctx.lineTo(-r * 0.6, r * 0.75);
          ctx.moveTo(r * 0.6, -r * 0.4); ctx.lineTo(r * 0.6, r * 0.75);
          break;
        }
        case 'drinking_water': {
          // Источник / капля воды
          ctx.moveTo(0, -r * 0.85);
          ctx.bezierCurveTo(r * 0.75, r * 0.1, r * 0.7, r * 0.85, 0, r * 0.85);
          ctx.bezierCurveTo(-r * 0.7, r * 0.85, -r * 0.75, r * 0.1, 0, -r * 0.85);
          break;
        }
        case 'hunting_stand': {
          // Вышка на сваях
          ctx.rect(-r * 0.48, -r * 0.75, r * 0.96, r * 0.65);
          ctx.moveTo(-r * 0.35, -r * 0.1); ctx.lineTo(-r * 0.6, r * 0.85);
          ctx.moveTo(r * 0.35, -r * 0.1); ctx.lineTo(r * 0.6, r * 0.85);
          ctx.moveTo(-r * 0.48, r * 0.4); ctx.lineTo(r * 0.48, r * 0.4);
          break;
        }
        case 'place_of_worship': {
          // Храм / часовня
          ctx.arc(0, r * 0.3, r * 0.45, 0, Math.PI * 2);
          if (religion === 'muslim') {
            const cx = r * 0.08, cy = -r * 0.55, rad = r * 0.28, a0 = 0.4;
            ctx.moveTo(cx + rad * Math.cos(a0), cy + rad * Math.sin(a0));
            ctx.arc(cx, cy, rad, a0, Math.PI * 1.8);
          } else {
            ctx.moveTo(0, -r * 0.15); ctx.lineTo(0, -r * 0.95);
            ctx.moveTo(-r * 0.35, -r * 0.65); ctx.lineTo(r * 0.35, -r * 0.65);
          }
          break;
        }
        default: {
          // emergency_access_point (щит / крест)
          ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
          ctx.moveTo(0, -r * 0.45); ctx.lineTo(0, r * 0.45);
          ctx.moveTo(-r * 0.45, 0); ctx.lineTo(r * 0.45, 0);
          break;
        }
      }
    };

    // Ореол (резкость даже поверх леса и штриховок)
    trace();
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3.1;
    ctx.stroke();

    // Тушь
    trace();
    if (sub === 'castle' || sub === 'fort' || sub === 'drinking_water') {
      ctx.fillStyle = colorToRgba(ink, 0.22);
      ctx.fill();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.45;
    ctx.stroke();

    ctx.restore();
  }

  function drawPeakIcon(ctx, cls, x, y, r, ink, halo, iconStyle = 'classic') {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const trace = () => {
      ctx.beginPath();
      if (cls === 'saddle' || cls === 'mountain_pass') {
        // Классический символ перевала )(
        ctx.moveTo(-r * 0.75, -r * 0.7);
        ctx.quadraticCurveTo(-r * 0.15, 0, -r * 0.75, r * 0.7);
        ctx.moveTo(r * 0.75, -r * 0.7);
        ctx.quadraticCurveTo(r * 0.15, 0, r * 0.75, r * 0.7);
      } else if (cls === 'volcano') {
        // Вулкан с кратером
        ctx.moveTo(-r * 0.95, r * 0.75);
        ctx.lineTo(-r * 0.3, -r * 0.55);
        ctx.lineTo(r * 0.3, -r * 0.55);
        ctx.lineTo(r * 0.95, r * 0.75);
        ctx.closePath();
        ctx.moveTo(-r * 0.22, -r * 0.85);
        ctx.quadraticCurveTo(0, -r * 1.15, r * 0.25, -r * 0.9);
      } else if (iconStyle === 'cross') {
        // Отметка высоты (+)
        ctx.moveTo(0, -r * 0.75); ctx.lineTo(0, r * 0.75);
        ctx.moveTo(-r * 0.75, 0); ctx.lineTo(r * 0.75, 0);
      } else {
        // Пик (треугольник вершины)
        ctx.moveTo(0, -r * 0.92);
        ctx.lineTo(r * 0.92, r * 0.75);
        ctx.lineTo(-r * 0.92, r * 0.75);
        ctx.closePath();
      }
    };

    trace();
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3.0;
    ctx.stroke();

    trace();
    if (cls === 'volcano') {
      ctx.fillStyle = colorToRgba('#b91c1c', 0.55);
      ctx.fill();
    } else if (cls !== 'saddle' && cls !== 'mountain_pass' && iconStyle !== 'cross') {
      if (iconStyle === 'engraved') {
        // Светлый пергамент внутри + штриховка правой теневой грани
        ctx.fillStyle = halo;
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.92);
        ctx.lineTo(r * 0.92, r * 0.75);
        ctx.lineTo(0, r * 0.75);
        ctx.closePath();
        ctx.fillStyle = colorToRgba(ink, 0.38);
        ctx.fill();
        ctx.restore();
        trace();
      } else if (iconStyle === 'triangulation') {
        ctx.fillStyle = halo;
        ctx.fill();
      } else {
        ctx.fillStyle = ink;
        ctx.fill();
      }
    }

    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    if (cls !== 'saddle' && cls !== 'mountain_pass' && cls !== 'volcano' && iconStyle === 'triangulation') {
      ctx.beginPath();
      ctx.arc(0, r * 0.22, Math.max(1.0, r * 0.22), 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
    }

    ctx.restore();
  }

  function measureSpacedText(ctx, text, spacing, fontKey) {
    if (!text) return 0;
    const baseW = getCachedTextWidth(ctx, text, fontKey);
    if (!spacing || text.length <= 1) return baseW;
    return baseW + spacing * (text.length - 1);
  }

  function drawParkOrnament(ctx, type, x, y, r, rot, side, ink, halo) {
    if (!type || type === 'none') return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(side, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const trace = () => {
      ctx.beginPath();
      if (type === 'leaves') {
        // Изящная гравюрная веточка с двумя листиками и завитком
        ctx.moveTo(-r * 0.9, 0);
        ctx.quadraticCurveTo(0, -r * 0.25, r * 0.85, 0);
        // Верхний лист
        ctx.moveTo(-r * 0.1, -r * 0.08);
        ctx.quadraticCurveTo(r * 0.25, -r * 0.75, r * 0.65, -r * 0.45);
        ctx.quadraticCurveTo(r * 0.35, -r * 0.15, -r * 0.1, -r * 0.08);
        // Нижний лист
        ctx.moveTo(-r * 0.45, -r * 0.02);
        ctx.quadraticCurveTo(-r * 0.1, r * 0.65, r * 0.3, r * 0.42);
        ctx.quadraticCurveTo(0, r * 0.12, -r * 0.45, -r * 0.02);
      } else if (type === 'stars') {
        // 4-лучевая картографическая звёздочка
        const o = r * 0.85, inn = r * 0.26;
        ctx.moveTo(0, -o);
        ctx.lineTo(inn, -inn);
        ctx.lineTo(o, 0);
        ctx.lineTo(inn, inn);
        ctx.lineTo(0, o);
        ctx.lineTo(-inn, inn);
        ctx.lineTo(-o, 0);
        ctx.lineTo(-inn, -inn);
        ctx.closePath();
      } else if (type === 'crest') {
        // Гербовый ромб ООПТ с силуэтом дерева внутри
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.8, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r * 0.8, 0);
        ctx.closePath();
        ctx.moveTo(0, -r * 0.55);
        ctx.lineTo(r * 0.35, r * 0.25);
        ctx.lineTo(-r * 0.35, r * 0.25);
        ctx.closePath();
        ctx.moveTo(0, r * 0.25);
        ctx.lineTo(0, r * 0.55);
      }
    };

    trace();
    ctx.strokeStyle = halo;
    ctx.lineWidth = 2.8;
    ctx.stroke();

    trace();
    if (type === 'stars' || type === 'leaves') {
      ctx.fillStyle = colorToRgba(ink, 0.35);
      ctx.fill();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();
  }

  function drawStraightSpacedLine(ctx, text, y, lineW, spacing, haloWidth) {
    let curX = -lineW * 0.5;
    const pts = [];
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      const cw = getCachedCharWidth(ctx, ch, ctx.font);
      pts.push({ ch, x: curX + cw * 0.5 });
      curX += cw + (c < text.length - 1 ? spacing : 0);
    }
    if (haloWidth > 0) {
      for (let c = 0; c < pts.length; c++) {
        if (pts[c].ch !== ' ') ctx.strokeText(pts[c].ch, pts[c].x, y);
      }
    }
    for (let c = 0; c < pts.length; c++) {
      if (pts[c].ch !== ' ') ctx.fillText(pts[c].ch, pts[c].x, y);
    }
  }

  function wrapLabelLines(text, maxCharsPerLine = 18) {
    if (!text || text.length <= maxCharsPerLine) return [text];
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const next = cur ? (cur + ' ' + words[i]) : words[i];
      if (next.length > maxCharsPerLine && cur) {
        lines.push(cur);
        cur = words[i];
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > 3) {
      return [lines[0], lines[1], lines.slice(2).join(' ')];
    }
    return lines;
  }

  function renderLabelsTile(canvas, data, coords, pad = 0, omtData = null, omtOnly = false) {
    const { layers, shift } = data;
    const hasOmtLabels = omtData && omtData.layers && (
      (omtData.layers.mountain_peak && omtData.layers.mountain_peak.features.length) ||
      (omtData.layers.park && omtData.layers.park.points.length)
    );
    if (omtOnly) {
      if (!hasOmtLabels) return;
    } else if (!layers.place_labels && !layers.water_polygons_labels && !layers.water_lines_labels && !layers.public_transport && !layers.pois && !hasOmtLabels) {
      if (canvas.width > 0) {
        canvas.width = 0;
        canvas.height = 0;
        canvas._crop = null;
      }
      return;
    }

    const fullSize = 256 + pad * 2;
    let dirtyMinX = Infinity, dirtyMinY = Infinity, dirtyMaxX = -Infinity, dirtyMaxY = -Infinity;
    const expandDirty = (x0, y0, x1, y1) => {
      if (x0 < dirtyMinX) dirtyMinX = x0;
      if (y0 < dirtyMinY) dirtyMinY = y0;
      if (x1 > dirtyMaxX) dirtyMaxX = x1;
      if (y1 > dirtyMaxY) dirtyMaxY = y1;
    };

    let sCtx = null;
    const ensureDrawCtx = () => {
      if (sCtx) return sCtx;
      const sc = getScratchLabelCanvas(fullSize);
      sCtx = sc.ctx;
      sCtx.setTransform(1, 0, 0, 1, 0, 0);
      sCtx.clearRect(0, 0, fullSize, fullSize);
      if (omtOnly && canvas.width > 0 && canvas._crop) {
        const c = canvas._crop;
        sCtx.drawImage(canvas, c.x, c.y);
        expandDirty(c.x - pad, c.y - pad, c.x - pad + c.w, c.y - pad + c.h);
      }
      sCtx.save();
      sCtx.translate(pad, pad);
      return sCtx;
    };
    const mCtx = measureCtx;

    try {
      const zoom = coords.z;
      const zScale = getZoomScale(zoom);
      globalLabelMgr.resetIfZoomChanged(zoom);

    const light = getLightingState(coords);

    function getParkHierarchy(rawName, props, prCfg) {
      const cls = String(props.class || '').toLowerCase();
      const lname = rawName.toLowerCase();
      const rank = props.rank || 99;

      if (
        /древостой|памятник\s+природы|урочищ|роща|квартал|лесопарк|участок/.test(lname) ||
        /monument|памятник/.test(cls) ||
        rank >= 5
      ) {
        return {
          scale: 0.78,
          bold: false,
          spacingMul: 0.55,
          showOrnament: false,
          minDistMul: 1.0
        };
      }

      if (
        /заповедник|национальн\w*\s+парк|биосферн/.test(lname) ||
        cls === 'national_park' ||
        /заповедник|национальн/.test(cls) ||
        (cls === 'nature_reserve' && rank <= 2)
      ) {
        return {
          scale: 1.28,
          bold: true,
          spacingMul: 1.25,
          showOrnament: true,
          minDistMul: 1.5
        };
      }

      return {
        scale: 1.0,
        bold: prCfg.bold !== false,
        spacingMul: 1.0,
        showOrnament: true,
        minDistMul: 1.2
      };
    }

    function getTransformParams(layerExtent, customShift = shift) {
      const extent = layerExtent || 4096;
      if (customShift > 0) {
        const sf = 1 << customShift;
        const sx = ((coords.x % sf) + sf) % sf;
        const sy = ((coords.y % sf) + sf) % sf;
        const fullPx = 256 * sf;
        const factor = fullPx / extent;
        const offsetX = sx * 256;
        const offsetY = sy * 256;
        const marginExt = extent * 0.05 + pad * (extent / fullPx);
        const minVisX = (sx * extent / sf) - marginExt;
        const maxVisX = ((sx + 1) * extent / sf) + marginExt;
        const minVisY = (sy * extent / sf) - marginExt;
        const maxVisY = ((sy + 1) * extent / sf) + marginExt;
        return { factor, offsetX, offsetY, minVisX, maxVisX, minVisY, maxVisY, isOverzoomed: true };
      } else {
        const factor = 256 / extent;
        const marginPx = 256 * 0.05 + pad;
        const marginExt = marginPx * (extent / 256);
        return { factor, offsetX: 0, offsetY: 0, minVisX: -marginExt, maxVisX: extent + marginExt, minVisY: -marginExt, maxVisY: extent + marginExt, isOverzoomed: false };
      }
    }

    function isFeatureInView(bbox, t) {
      if (!t.isOverzoomed) return true;
      return !(bbox[2] < t.minVisX || bbox[0] > t.maxVisX || bbox[3] < t.minVisY || bbox[1] > t.maxVisY);
    }

    const bCfg = cfg.labels.banners || {};
    const useBanners = !!bCfg.enabled;

    // 1. НАЗВАНИЯ НАСЕЛЁННЫХ ПУНКТОВ
    if (!omtOnly && layers.place_labels) {
      const t = getTransformParams(layers.place_labels.extent);
      const pFeats = layers.place_labels.features;

      for (let i = 0; i < pFeats.length; i++) {
        const f = pFeats[i];
        if (!isFeatureInView(f.bbox, t)) continue;
        const p = f.props;
        const name = p.name_ru || p['name:ru'] || p.name;
        if (!name || !f.geom.length || !f.geom[0].length) continue;

        const ptX = f.geom[0][0] * t.factor - t.offsetX;
        const ptY = f.geom[0][1] * t.factor - t.offsetY;
        if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

        const k = p.kind || 'locality';
        let lCfg = null;
        let isMajorCity = false;

        if (k === 'city' || k === 'town') {
          lCfg = cfg.labels.major;
          isMajorCity = true;
        } else if (k === 'village' || k === 'hamlet') {
          if (zoom < 11) continue;
          if (zoom === 11 && k === 'hamlet') continue;
          lCfg = cfg.labels.minor;
        } else {
          if (zoom < 13) continue;
          lCfg = cfg.labels.localities;
        }

        if (!lCfg || !lCfg.enabled) continue;

        const gx = coords.x * 256 + ptX;
        const gy = coords.y * 256 + ptY;
        const tileKey = `${coords.x}:${coords.y}:${coords.z}`;
        if (globalLabelMgr.hasDuplicate(name, gx, gy, 120)) continue;

        const fontSize = Math.max(9, Math.round(lCfg.size * zScale));
        const fontStr = `${lCfg.italic ? 'italic ' : ''}${lCfg.bold ? 'bold ' : ''}${fontSize}px "Georgia", "Baskerville", serif`;
        mCtx.font = fontStr;

        const tw = getCachedTextWidth(mCtx, name, fontStr);

        const extraPadX = useBanners ? (isMajorCity ? 30 * Math.max(1, zScale * 0.8) : 12) : 0;
        const extraPadY = useBanners ? 8 : 0;
        const box = {
          gx: gx - tw / 2 - extraPadX,
          gy: gy - fontSize / 2 - extraPadY,
          w: tw + extraPadX * 2,
          h: fontSize + extraPadY * 2,
          tileKey
        };

        if (globalLabelMgr.collides(box, 3)) continue;
        globalLabelMgr.registerName(name, gx, gy, tileKey);
        globalLabelMgr.add(box, 3);

        // Регистрируем область с запасом под хвостики свитка / акварельный фон
        const padSpanX = extraPadX + (isMajorCity ? Math.max(26, fontSize * 1.4) : 14);
        const padSpanY = extraPadY + Math.max(10, fontSize * 0.5);
        expandDirty(ptX - tw * 0.5 - padSpanX, ptY - fontSize * 0.5 - padSpanY, ptX + tw * 0.5 + padSpanX, ptY + fontSize * 0.5 + padSpanY);

        const dCtx = ensureDrawCtx();
        dCtx.save();
        dCtx.translate(ptX, ptY);
        dCtx.font = fontStr;

        if (useBanners) {
          if (isMajorCity) {
            drawParchmentScroll(dCtx, 0, 0, tw, fontSize, bCfg, light, zScale);
          } else {
            drawWashBackground(dCtx, 0, 0, tw, fontSize, bCfg, light);
          }
        }

        dCtx.textAlign = 'center';
        dCtx.textBaseline = 'middle';
        dCtx.lineJoin = 'round';
        dCtx.miterLimit = 2;

        if (!useBanners || !isMajorCity) {
          dCtx.strokeStyle = adaptLabelColor(lCfg.haloColor, light, 'halo');
          dCtx.lineWidth = Math.max(2.8, fontSize * 0.22);
          dCtx.strokeText(name, 0, 0);
        }

        dCtx.fillStyle = adaptLabelColor(lCfg.color, light, 'text');
        dCtx.fillText(name, 0, 0);
        dCtx.restore();
      }
    }

    // 2. НАЗВАНИЯ ВОДОЁМОВ И РЕК
    if (!omtOnly && cfg.labels.water.enabled) {
      const wLabelCfg = cfg.labels.water;
      const baseWaterSize = wLabelCfg.size * zScale;
      const waterTextCol = adaptLabelColor(wLabelCfg.color, light, 'text');
      const waterHaloCol = adaptLabelColor(wLabelCfg.haloColor, light, 'halo');

      const hasWaterLines = !!(layers.water_lines_labels && layers.water_lines_labels.features.length);

      const polyAreaByName = new Map();
      if (hasWaterLines && layers.water_polygons_labels) {
        const pFeats = layers.water_polygons_labels.features;
        for (let i = 0; i < pFeats.length; i++) {
          const nm = pFeats[i].props.name_ru || pFeats[i].props['name:ru'] || pFeats[i].props.name;
          if (!nm) continue;
          const clean = nm.trim().toLowerCase().replace(/ё/g, 'е');
          const ar = pFeats[i].props.way_area || 0;
          if (ar > (polyAreaByName.get(clean) || 0)) polyAreaByName.set(clean, ar);
        }
      }

      const riverWaterPolys = [];
      const otherWaterPolys = [];
      let tWaterPoly = null;
      let waterPolyExtent = 4096;

      if (hasWaterLines && layers.water_polygons && layers.water_polygons.features.length) {
        waterPolyExtent = layers.water_polygons.extent || 4096;
        tWaterPoly = getTransformParams(waterPolyExtent);
        const pf = layers.water_polygons.features;
        for (let i = 0; i < pf.length; i++) {
          const f = pf[i];
          const k = f.props.kind || '';
          const isRiverPoly = (k === 'river' || k === 'canal') && !f.props.maritime;
          if (isRiverPoly) riverWaterPolys.push(f);
          else otherWaterPolys.push(f);
        }
      }

      const latTile = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / Math.pow(2, zoom))));
      const metersPerPx = (156543.03392 * Math.cos(latTile)) / Math.pow(2, zoom);
      const mercMetersPerPx = 156543.03392 / Math.pow(2, zoom);

      function pointInFlatRings(x, y, geom) {
        let inside = false;
        for (let l = 0; l < geom.length; l++) {
          const ring = geom[l];
          for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const xi = ring[i], yi = ring[i + 1];
            const xj = ring[j], yj = ring[j + 1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) {
              inside = !inside;
            }
          }
        }
        return inside;
      }

      if (hasWaterLines && otherWaterPolys.length && tWaterPoly) {
        for (let i = 0; i < otherWaterPolys.length; i++) {
          const p = otherWaterPolys[i];
          if (!p._pxBbox) {
            p._pxBbox = [
              p.bbox[0] * tWaterPoly.factor - tWaterPoly.offsetX,
              p.bbox[1] * tWaterPoly.factor - tWaterPoly.offsetY,
              p.bbox[2] * tWaterPoly.factor - tWaterPoly.offsetX,
              p.bbox[3] * tWaterPoly.factor - tWaterPoly.offsetY
            ];
          }
        }
      }

      function rayDistToPoly(ox, oy, dx, dy, geom, ext) {
        let minT = Infinity;
        let hitClip = false;
        const eps = 2, maxC = ext - 2;
        for (let l = 0; l < geom.length; l++) {
          const ring = geom[l];
          for (let i = 0; i < ring.length - 2; i += 2) {
            const x1 = ring[i], y1 = ring[i + 1];
            const x2 = ring[i + 2], y2 = ring[i + 3];
            const sx = x2 - x1, sy = y2 - y1;
            const denom = dx * sy - dy * sx;
            if (Math.abs(denom) < 1e-9) continue;
            const qx = x1 - ox, qy = y1 - oy;
            const t = (qx * sy - qy * sx) / denom;
            const u = (qx * dy - qy * dx) / denom;
            if (t > 0 && u >= 0 && u <= 1 && t < minT) {
              minT = t;
              hitClip = (Math.abs(x1 - x2) <= 1.5 && (x1 <= eps || x1 >= maxC)) ||
                        (Math.abs(y1 - y2) <= 1.5 && (y1 <= eps || y1 >= maxC));
            }
          }
        }
        return { t: minT, hitClip };
      }

      function getRiverScale(f, centerX, centerY, dirX, dirY, name) {
        const kind = f.props.kind || 'stream'; 
        if (kind === 'ditch' || kind === 'drain') return { mult: 0.68, bold: false, rank: 1 };
        if (kind === 'stream') return { mult: 0.76, bold: false, rank: 2 };
        if (kind === 'canal') return { mult: 0.90, bold: false, rank: 3 };

        let area = polyAreaByName.get(name.trim().toLowerCase().replace(/ё/g, 'е')) || 0;
        let widthMeters = 0;
        let hasPoly = false;

        if (tWaterPoly && riverWaterPolys.length) {
          const wx = (centerX + tWaterPoly.offsetX) / tWaterPoly.factor;
          const wy = (centerY + tWaterPoly.offsetY) / tWaterPoly.factor;
          for (let i = 0; i < riverWaterPolys.length; i++) {
            const p = riverWaterPolys[i];
            if (wx < p.bbox[0] || wx > p.bbox[2] || wy < p.bbox[1] || wy > p.bbox[3]) continue;
            if (!pointInFlatRings(wx, wy, p.geom)) continue;
            hasPoly = true;
            area = Math.max(area, p.props.way_area || 0);

            const len = Math.hypot(dirX, dirY);
            if (len > 0.001) {
              const nx = -dirY / len;
              const ny = dirX / len;
              const r1 = rayDistToPoly(wx, wy, nx, ny, p.geom, waterPolyExtent);
              const r2 = rayDistToPoly(wx, wy, -nx, -ny, p.geom, waterPolyExtent);
              let wExt = 0;
              if (Number.isFinite(r1.t) && Number.isFinite(r2.t)) {
                if (!r1.hitClip && !r2.hitClip) wExt = r1.t + r2.t;
                else if (!r1.hitClip) wExt = r1.t * 2;
                else if (!r2.hitClip) wExt = r2.t * 2;
              }
              if (wExt > 0) widthMeters = Math.max(widthMeters, wExt * tWaterPoly.factor * metersPerPx);
            }
            break;
          }
        }

        if (widthMeters >= 200 || area >= 8000000) return { mult: 1.45, bold: true, rank: 7 };
        if (widthMeters >= 75 || area >= 1500000)  return { mult: 1.28, bold: true, rank: 6 };
        if (hasPoly || widthMeters >= 20 || area >= 150000) return { mult: 1.12, bold: true, rank: 5 };
        return { mult: 0.95, bold: false, rank: 4 };
      }

     // 2.1 Реки вдоль русла (с запретом отрисовки внутри иных водоёмов)
      const riversGeomOn = !!(cfg.water.rivers.enabled && cfg.water.rivers.opacity > 0.01);
      const riverPolysOn = !!cfg.water.lakes.enabled;

      if (hasWaterLines && (riversGeomOn || riverPolysOn)) {
        const t = getTransformParams(layers.water_lines_labels.extent);
        const feats = layers.water_lines_labels.features;
        const riverItems = [];

        // Собираем реально рисуемые на данном зуме сегменты из water_lines
        let tLineGeom = null;
        const visibleLineFeats = [];
        if (riversGeomOn && layers.water_lines && layers.water_lines.features.length) {
          tLineGeom = getTransformParams(layers.water_lines.extent);
          const wlFeats = layers.water_lines.features;
          for (let i = 0; i < wlFeats.length; i++) {
            const wf = wlFeats[i];
            if (!isFeatureInView(wf.bbox, tLineGeom)) continue;
            if (!isWaterLineVisibleAtZoom(wf.props, zoom)) continue;
            visibleLineFeats.push({
              geom: wf.geom,
              minX: wf.bbox[0] * tLineGeom.factor - tLineGeom.offsetX,
              minY: wf.bbox[1] * tLineGeom.factor - tLineGeom.offsetY,
              maxX: wf.bbox[2] * tLineGeom.factor - tLineGeom.offsetX,
              maxY: wf.bbox[3] * tLineGeom.factor - tLineGeom.offsetY
            });
          }
        }

        function hasRenderedRiverAt(px, py) {
          // 1. Проверяем, проходит ли рядом видимая линия из water_lines (допуск 12px)
          if (tLineGeom && visibleLineFeats.length) {
            const r = 12;
            const rSq = r * r;
            for (let i = 0; i < visibleLineFeats.length; i++) {
              const lf = visibleLineFeats[i];
              if (px + r < lf.minX || px - r > lf.maxX || py + r < lf.minY || py - r > lf.maxY) continue;
              for (let l = 0; l < lf.geom.length; l++) {
                const line = lf.geom[l];
                for (let p = 0; p < line.length - 2; p += 2) {
                  const x1 = line[p] * tLineGeom.factor - tLineGeom.offsetX;
                  const y1 = line[p + 1] * tLineGeom.factor - tLineGeom.offsetY;
                  const x2 = line[p + 2] * tLineGeom.factor - tLineGeom.offsetX;
                  const y2 = line[p + 3] * tLineGeom.factor - tLineGeom.offsetY;
                  if (distSqPointToSeg(px, py, x1, y1, x2, y2) <= rSq) return true;
                }
              }
            }
          }

          // 2. Либо это широкая река, отрисованная полигоном в water_polygons
          if (riverPolysOn && tWaterPoly && riverWaterPolys.length) {
            const wx = (px + tWaterPoly.offsetX) / tWaterPoly.factor;
            const wy = (py + tWaterPoly.offsetY) / tWaterPoly.factor;
            for (let i = 0; i < riverWaterPolys.length; i++) {
              const p = riverWaterPolys[i];
              if (wx < p.bbox[0] || wx > p.bbox[2] || wy < p.bbox[1] || wy > p.bbox[3]) continue;
              if (pointInFlatRings(wx, wy, p.geom)) return true;
            }
          }
          return false;
        }

        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          if (!isFeatureInView(f.bbox, t)) continue;
          if (!isWaterLineVisibleAtZoom(f.props, zoom)) continue;
          const name = f.props.name_ru || f.props['name:ru'] || f.props.name;
          if (!name || !f.geom.length || !f.geom[0].length || f.geom[0].length < 4) continue;

          const line = f.geom[0];
          const numPts = line.length / 2;
          const midIdx = Math.floor(numPts / 2) * 2;
          const centerX = line[midIdx] * t.factor - t.offsetX;
          const centerY = line[midIdx + 1] * t.factor - t.offsetY;
          if (centerX < 0 || centerX >= 256 || centerY < 0 || centerY >= 256) continue;

          const prevIdx = Math.max(0, midIdx - 2);
          const nextIdx = Math.min(line.length - 2, midIdx + 2);
          const dirX = (line[nextIdx] - line[prevIdx]) * t.factor;
          const dirY = (line[nextIdx + 1] - line[prevIdx + 1]) * t.factor;

          const info = getRiverScale(f, centerX, centerY, dirX, dirY, name);
          riverItems.push({ f, name, line, centerX, centerY, info });
        }

        riverItems.sort((a, b) => b.info.rank - a.info.rank);

        let riverCtx = null;
        for (let i = 0; i < riverItems.length; i++) {
          const { f, name, line, info } = riverItems[i];
          const rFontSize = Math.max(8.5, Math.round(baseWaterSize * info.mult));
          const rFontStr = `${wLabelCfg.italic ? 'italic ' : ''}${info.bold ? 'bold ' : ''}${rFontSize}px "Georgia", serif`;
          mCtx.font = rFontStr;

          const scaledLine = [];
          for (let k = 0; k < line.length; k += 2) {
            scaledLine.push(line[k] * t.factor - t.offsetX);
            scaledLine.push(line[k + 1] * t.factor - t.offsetY);
          }

          const rx0 = f.bbox[0] * t.factor - t.offsetX;
          const ry0 = f.bbox[1] * t.factor - t.offsetY;
          const rx1 = f.bbox[2] * t.factor - t.offsetX;
          const ry1 = f.bbox[3] * t.factor - t.offsetY;

          let localIsForbidden = null;
          if (otherWaterPolys.length && tWaterPoly) {
            const localPolys = [];
            for (let pi = 0; pi < otherWaterPolys.length; pi++) {
              const pb = otherWaterPolys[pi]._pxBbox;
              if (pb[2] >= rx0 && pb[0] <= rx1 && pb[3] >= ry0 && pb[1] <= ry1) {
                localPolys.push(otherWaterPolys[pi]);
              }
            }
            if (localPolys.length) {
              localIsForbidden = (px, py) => {
                const wx = (px + tWaterPoly.offsetX) / tWaterPoly.factor;
                const wy = (py + tWaterPoly.offsetY) / tWaterPoly.factor;
                for (let pi = 0; pi < localPolys.length; pi++) {
                  const p = localPolys[pi];
                  if (wx < p.bbox[0] || wx > p.bbox[2] || wy < p.bbox[1] || wy > p.bbox[3]) continue;
                  if (pointInFlatRings(wx, wy, p.geom)) return true;
                }
                return false;
              };
            }
          }

          const placement = prepareRiverTextPlacement(mCtx, name, scaledLine, rFontSize, {
            maxStepDeg: 20,
            maxArcDeg: 45,
            minChordRatio: 0.80,
            strict: false,
            isForbidden: localIsForbidden
          });
          if (!placement) continue;
          if (!hasRenderedRiverAt(placement.centerX, placement.centerY)) continue;

          const gx = coords.x * 256 + placement.centerX;
          const gy = coords.y * 256 + placement.centerY;
          const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

          if (globalLabelMgr.hasDuplicate(name, gx, gy, 160)) continue;

          const box = {
            gx: gx - placement.textW / 2,
            gy: gy - rFontSize / 2,
            w: placement.textW,
            h: rFontSize + 8,
            tileKey
          };
          if (globalLabelMgr.collides(box, 3)) continue;
          globalLabelMgr.registerName(name, gx, gy, tileKey);
          globalLabelMgr.add(box, 3);

          // Область для глифов реки и стрелки течения
          let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
          for (let gi = 0; gi < placement.glyphs.length; gi++) {
            const gl = placement.glyphs[gi];
            if (gl.x < gMinX) gMinX = gl.x;
            if (gl.x > gMaxX) gMaxX = gl.x;
            if (gl.y < gMinY) gMinY = gl.y;
            if (gl.y > gMaxY) gMaxY = gl.y;
          }
          const rMargin = Math.max(16, rFontSize * 1.45);
          expandDirty(gMinX - rMargin, gMinY - rMargin, gMaxX + rMargin, gMaxY + rMargin + 6);

          if (!riverCtx) {
            riverCtx = ensureDrawCtx();
            riverCtx.save();
          }
          riverCtx.font = rFontStr;
          const lineW = Math.max(2.6, rFontSize * 0.2);
          drawPreparedRiverText(riverCtx, placement, -3, waterTextCol, waterHaloCol, lineW, rFontSize);
        }
        if (riverCtx) riverCtx.restore();
      }

      // 2.2 Озёра и водохранилища (размер подписи пропорционален площади водоёма)
      if (layers.water_polygons_labels) {
        const t = getTransformParams(layers.water_polygons_labels.extent);
        const lakeFeats = layers.water_polygons_labels.features
          .slice()
          .sort((a, b) => (b.props.way_area || 0) - (a.props.way_area || 0));

        function getLakeTextStyle(area) {
          if (!area || area <= 0) return { mult: 0.88, bold: false, equivDiamPx: 0 };
          const equivDiamPx = Math.sqrt(area) / mercMetersPerPx;

          const tArea = Math.max(0, Math.min(1, (Math.log10(area) - 4.2) / 5.2));
          const multArea = 0.56 + tArea * 1.16;

          const tScreen = Math.max(0, Math.min(1, (Math.log10(Math.max(8, equivDiamPx)) - 0.9) / 1.9));
          const multScreen = 0.60 + tScreen * 1.00;

          const mult = multArea * 0.55 + multScreen * 0.45;
          const bold = (area >= 1500000) || (mult >= 1.08);
          return { mult, bold, equivDiamPx };
        }

        let lakeCtx = null;

        for (let i = 0; i < lakeFeats.length; i++) {
          const f = lakeFeats[i];
          if (!isFeatureInView(f.bbox, t)) continue;
          const name = f.props.name_ru || f.props['name:ru'] || f.props.name;
          if (!name || !f.geom.length || !f.geom[0].length) continue;

          const ptX = f.geom[0][0] * t.factor - t.offsetX;
          const ptY = f.geom[0][1] * t.factor - t.offsetY;
          if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

          const area = f.props.way_area || 0;
          if (zoom <= 10 && area < 1500000) continue;
          if (zoom <= 11 && area < 400000) continue;
          if (zoom <= 12 && area < 80000) continue;
          if (zoom <= 13 && area < 15000) continue;

          const style = getLakeTextStyle(area);
          const fontSize = Math.max(8.5, Math.round(baseWaterSize * style.mult));
          const fontStr = `${wLabelCfg.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontSize}px "Georgia", serif`;
          mCtx.font = fontStr;

          const gx = coords.x * 256 + ptX;
          const gy = coords.y * 256 + ptY;
          const tileKey = `${coords.x}:${coords.y}:${coords.z}`;
          const dupDist = Math.max(140, Math.min(320, style.equivDiamPx * 0.55));
          if (globalLabelMgr.hasDuplicate(name, gx, gy, dupDist)) continue;

          const tw = getCachedTextWidth(mCtx, name, fontStr);
          const box = { gx: gx - tw / 2, gy: gy - fontSize / 2, w: tw, h: fontSize, tileKey };
          if (globalLabelMgr.collides(box, 4)) continue;
          globalLabelMgr.registerName(name, gx, gy, tileKey);
          globalLabelMgr.add(box, 4);

          expandDirty(ptX - tw * 0.5 - 8, ptY - fontSize * 0.5 - 8, ptX + tw * 0.5 + 8, ptY + fontSize * 0.5 + 8);

          if (!lakeCtx) {
            lakeCtx = ensureDrawCtx();
            lakeCtx.save();
            lakeCtx.textAlign = 'center';
            lakeCtx.textBaseline = 'middle';
            lakeCtx.lineJoin = 'round';
            lakeCtx.miterLimit = 2;
            lakeCtx.strokeStyle = waterHaloCol;
            lakeCtx.fillStyle = waterTextCol;
          }
          lakeCtx.font = fontStr;
          lakeCtx.lineWidth = Math.max(2.4, fontSize * 0.2);
          lakeCtx.strokeText(name, ptX, ptY);
          lakeCtx.fillText(name, ptX, ptY);
        }
        if (lakeCtx) lakeCtx.restore();
      }
    } // <-- ДОБАВИТЬ ЭТУ СКОБКУ (закрывает if (!omtOnly && cfg.labels.water.enabled))

    const iconScaleBase = Math.min(1.55, Math.max(0.85, 0.85 + Math.max(0, zoom - 13) * 0.16));

    // 2.5 ЖЕЛЕЗНОДОРОЖНЫЕ СТАНЦИИ И ПОЛУСТАНКИ (public_transport: station / halt)
    if (!omtOnly && cfg.railways && cfg.railways.stations && cfg.railways.stations.enabled && layers.public_transport && layers.public_transport.features.length) {
      const stCfg = cfg.railways.stations;
      const minZ = stCfg.minZoom || 13;
      if (zoom >= minZ) {
        const t = getTransformParams(layers.public_transport.extent);
        const feats = layers.public_transport.features;
        const railFeats = [];

        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          const k = f.props.kind || '';
          if (k !== 'station' && k !== 'halt') continue;
          if (k === 'halt' && stCfg.showHalts === false) continue;
          if (!f.geom.length || !f.geom[0].length) continue;
          if (!isFeatureInView(f.bbox, t)) continue;
          railFeats.push(f);
        }

        if (railFeats.length > 1) {
          railFeats.sort((a, b) => (a.props.kind === 'station' ? 0 : 1) - (b.props.kind === 'station' ? 0 : 1));
        }

        if (railFeats.length) {
          const stInk = adaptLabelColor(stCfg.color || '#24160d', light, 'text');
          const stIconInk = adaptLabelColor(stCfg.iconColor || stCfg.color || '#24160d', light, 'text');
          const stHalo = adaptLabelColor(stCfg.haloColor || '#f4ead5', light, 'halo');
          const stPlateFill = colorToRgba(adaptLabelColor(stCfg.haloColor || '#f4ead5', light, 'banner'), 0.92);
          const stPlateStroke = adaptLabelColor(stCfg.color || '#24160d', light, 'stroke');
          const stAlpha = stCfg.opacity ?? 1.0;

          const baseSize = Math.max(8.5, Math.round((stCfg.size || 10.5) * zScale));
          const rBaseIcon = 5.6 * iconScaleBase * (stCfg.iconScale ?? 1.0);
          const showIcon = stCfg.showIcon !== false;
          const isPlate = (stCfg.labelStyle || 'plate') === 'plate';
          const slant = stCfg.italic ? 'italic ' : '';

          for (let i = 0; i < railFeats.length; i++) {
            const f = railFeats[i];
            const k = f.props.kind;
            const isMainStation = (k === 'station');

            const ptX = f.geom[0][0] * t.factor - t.offsetX;
            const ptY = f.geom[0][1] * t.factor - t.offsetY;
            if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

            const gx = coords.x * 256 + ptX;
            const gy = coords.y * 256 + ptY;
            const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

            const rIcon = isMainStation ? rBaseIcon : (rBaseIcon * 0.78);
            if (showIcon) {
              const iconBox = { gx: gx - rIcon, gy: gy - rIcon, w: rIcon * 2, h: rIcon * 2, tileKey };
              if (globalLabelMgr.collides(iconBox, 2)) continue;
              globalLabelMgr.add(iconBox, 2);

              expandDirty(ptX - rIcon - 6, ptY - rIcon - 6, ptX + rIcon + 6, ptY + rIcon + 6);

              const dCtx = ensureDrawCtx();
              dCtx.save();
              dCtx.globalAlpha *= stAlpha;
              drawEngravedTransportIcon(dCtx, k, ptX, ptY, rIcon, stIconInk, stHalo);
              dCtx.restore();
            }

            const rawName = (f.props.name_ru || f.props['name:ru'] || f.props.name || '').trim();
            if (stCfg.labelsEnabled !== false && rawName) {
              const fontSize = isMainStation ? baseSize : Math.max(8, Math.round(baseSize * 0.88));
              const weight = (stCfg.bold !== false && isMainStation) ? 'bold ' : '';
              const fontStr = `${slant}${weight}${fontSize}px "Georgia", serif`;

              mCtx.font = fontStr;
              const tw = getCachedTextWidth(mCtx, rawName, fontStr);
              const padX = isPlate ? 5 : 0;
              const padY = isPlate ? 2.5 : 0;
              const ly = ptY + (showIcon ? (rIcon + fontSize * 0.65 + padY + 1.5) : 0);
              const lgy = coords.y * 256 + ly;

              const lBox = {
                gx: gx - tw / 2 - padX,
                gy: lgy - fontSize / 2 - padY,
                w: tw + padX * 2,
                h: fontSize + padY * 2,
                tileKey
              };

              if (globalLabelMgr.hasDuplicate('rail_st_' + rawName, gx, gy, 110)) continue;
              if (globalLabelMgr.collides(lBox, 2)) continue;

              globalLabelMgr.registerName('rail_st_' + rawName, gx, gy, tileKey);
              globalLabelMgr.add(lBox, 2);

              expandDirty(ptX - tw * 0.5 - padX - 6, ly - fontSize * 0.5 - padY - 6, ptX + tw * 0.5 + padX + 6, ly + fontSize * 0.5 + padY + 6);

              const dCtx = ensureDrawCtx();
              dCtx.save();
              dCtx.globalAlpha *= stAlpha;
              dCtx.translate(ptX, ly);

              if (isPlate) {
                const bw = tw + padX * 2;
                const bh = fontSize + padY * 2;
                dCtx.fillStyle = stPlateFill;
                dCtx.strokeStyle = stPlateStroke;
                dCtx.lineWidth = isMainStation ? 1.15 : 0.85;
                dCtx.beginPath();
                if (dCtx.roundRect) {
                  dCtx.roundRect(-bw / 2, -bh / 2, bw, bh, 2.5);
                } else {
                  dCtx.rect(-bw / 2, -bh / 2, bw, bh);
                }
                dCtx.fill();
                dCtx.stroke();
              } else {
                dCtx.font = fontStr;
                dCtx.textAlign = 'center';
                dCtx.textBaseline = 'middle';
                dCtx.lineJoin = 'round';
                dCtx.miterLimit = 2;
                dCtx.strokeStyle = stHalo;
                dCtx.lineWidth = Math.max(2.6, fontSize * 0.24);
                dCtx.strokeText(rawName, 0, 0);
              }

              dCtx.font = fontStr;
              dCtx.textAlign = 'center';
              dCtx.textBaseline = 'middle';
              dCtx.fillStyle = stInk;
              dCtx.fillText(rawName, 0, 0);
              dCtx.restore();
            }
          }
        }
      }
    }

    // 3. ТРАНСПОРТ, СТАНЦИИ И АЭРОДРОМЫ (public_transport)
    if (!omtOnly && cfg.transport && cfg.transport.enabled && layers.public_transport && layers.public_transport.features.length) {
      const trCfg = cfg.transport;
      const t = getTransformParams(layers.public_transport.extent);
      const feats = layers.public_transport.features;
      const trInk = adaptLabelColor(trCfg.color, light, 'text');
      const trHalo = adaptLabelColor(trCfg.haloColor, light, 'halo');
      const rIcon = 5.6 * iconScaleBase * (trCfg.size || 1.0);
      const trFontSize = Math.max(8.5, Math.round(9.5 * zScale));
      const trFont = `${trFontSize}px "Georgia", serif`;

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (!isFeatureInView(f.bbox, t)) continue;
        const k = f.props.kind || '';
        if (k === 'station' || k === 'halt') continue;
        const isAir = (k === 'aerodrome' || k === 'helipad');
        const isRailPt = (k === 'ferry_terminal' || k === 'aerialway_station');
        const isBus = (k === 'bus_station' || k === 'bus_stop' || k === 'tram_stop');

        if (isAir && !trCfg.airEnabled) continue;
        if (isRailPt && !trCfg.railEnabled) continue;
        if (isBus && (!trCfg.busEnabled || (zoom < 14 && k !== 'bus_station'))) continue;
        if (!f.geom.length || !f.geom[0].length) continue;

        const ptX = f.geom[0][0] * t.factor - t.offsetX;
        const ptY = f.geom[0][1] * t.factor - t.offsetY;
        if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

        const gx = coords.x * 256 + ptX;
        const gy = coords.y * 256 + ptY;
        const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

        const iconBox = { gx: gx - rIcon, gy: gy - rIcon, w: rIcon * 2, h: rIcon * 2, tileKey };
        if (globalLabelMgr.collides(iconBox, 2)) continue;
        globalLabelMgr.add(iconBox, 2);

        expandDirty(ptX - rIcon * 1.3 - 6, ptY - rIcon * 1.3 - 6, ptX + rIcon * 1.3 + 6, ptY + rIcon * 1.3 + 6);

        const dCtx = ensureDrawCtx();
        drawEngravedTransportIcon(dCtx, k, ptX, ptY, rIcon, trInk, trHalo);

        const rawName = f.props.name_ru || f.props['name:ru'] || f.props.name || '';
        const iata = (k === 'aerodrome' && f.props.iata) ? ` (${f.props.iata})` : '';
        const label = (rawName + iata).trim();

        if (trCfg.labelsEnabled && label && !(isBus && zoom < 15)) {
          mCtx.font = trFont;
          const tw = getCachedTextWidth(mCtx, label, trFont);
          const ly = ptY + rIcon + trFontSize * 0.65;
          const lgy = coords.y * 256 + ly;
          const lBox = { gx: gx - tw / 2, gy: lgy - trFontSize / 2, w: tw, h: trFontSize, tileKey };
          if (!globalLabelMgr.hasDuplicate(label, gx, lgy, 85) && !globalLabelMgr.collides(lBox, 2)) {
            globalLabelMgr.registerName(label, gx, lgy, tileKey);
            globalLabelMgr.add(lBox, 2);

            expandDirty(ptX - tw * 0.5 - 6, ly - trFontSize * 0.5 - 6, ptX + tw * 0.5 + 6, ly + trFontSize * 0.5 + 6);

            dCtx.save();
            dCtx.font = trFont;
            dCtx.textAlign = 'center';
            dCtx.textBaseline = 'middle';
            dCtx.lineJoin = 'round';
            dCtx.strokeStyle = trHalo;
            dCtx.lineWidth = 2.6;
            dCtx.strokeText(label, ptX, ly);
            dCtx.fillStyle = trInk;
            dCtx.fillText(label, ptX, ly);
            dCtx.restore();
          }
        }
      }
    }

    // 4. ОРИЕНТИРЫ И ТОЧКИ ИНТЕРЕСА (pois, z14+)
    if (!omtOnly && cfg.pois && cfg.pois.enabled && zoom >= 14 && layers.pois && layers.pois.features.length) {
      const pCfg = cfg.pois;
      const t = getTransformParams(layers.pois.extent);
      const feats = layers.pois.features;
      const pInk = adaptLabelColor(pCfg.color, light, 'text');
      const pHalo = adaptLabelColor(pCfg.haloColor, light, 'halo');
      const rPoi = 6.2 * iconScaleBase * (pCfg.scale || 1.0);
      const pFontSize = Math.max(8.5, Math.round(9.0 * zScale));
      const pFont = `italic ${pFontSize}px "Georgia", serif`;

      const candidates = [];
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const info = f.props._poi;
        if (!info || !f.geom.length || !f.geom[0].length) continue;
        if (info.group === 'historic' && !pCfg.historicEnabled) continue;
        if (info.group === 'tourism' && !pCfg.tourismEnabled) continue;
        if (info.group === 'manmade' && !pCfg.manmadeEnabled) continue;
        if (info.group === 'amenity' && !pCfg.amenityEnabled) continue;
        if (!isFeatureInView(f.bbox, t)) continue;
        candidates.push(f);
      }
      candidates.sort((a, b) => a.props._poi.prio - b.props._poi.prio);

      for (let i = 0; i < candidates.length; i++) {
        const f = candidates[i];
        const info = f.props._poi;
        const ptX = f.geom[0][0] * t.factor - t.offsetX;
        const ptY = f.geom[0][1] * t.factor - t.offsetY;
        if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

        const gx = coords.x * 256 + ptX;
        const gy = coords.y * 256 + ptY;
        const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

        const iconBox = { gx: gx - rPoi, gy: gy - rPoi, w: rPoi * 2, h: rPoi * 2, tileKey };
        if (globalLabelMgr.collides(iconBox, 3)) continue;
        globalLabelMgr.add(iconBox, 3);

        expandDirty(ptX - rPoi * 1.3 - 6, ptY - rPoi * 1.3 - 6, ptX + rPoi * 1.3 + 6, ptY + rPoi * 1.3 + 6);

        const dCtx = ensureDrawCtx();
        drawEngravedPoiIcon(dCtx, info.sub, f.props.religion, ptX, ptY, rPoi, pInk, pHalo);

        const name = f.props.name_ru || f.props['name:ru'] || f.props.name;
        if (pCfg.labelsEnabled && name) {
          mCtx.font = pFont;
          const tw = getCachedTextWidth(mCtx, name, pFont);
          const ly = ptY + rPoi + pFontSize * 0.65;
          const lgy = coords.y * 256 + ly;
          const lBox = { gx: gx - tw / 2, gy: lgy - pFontSize / 2, w: tw, h: pFontSize, tileKey };
          if (!globalLabelMgr.hasDuplicate(name, gx, lgy, 80) && !globalLabelMgr.collides(lBox, 2)) {
            globalLabelMgr.registerName(name, gx, lgy, tileKey);
            globalLabelMgr.add(lBox, 2);

            expandDirty(ptX - tw * 0.5 - 6, ly - pFontSize * 0.5 - 6, ptX + tw * 0.5 + 6, ly + pFontSize * 0.5 + 6);

            dCtx.save();
            dCtx.font = pFont;
            dCtx.textAlign = 'center';
            dCtx.textBaseline = 'middle';
            dCtx.lineJoin = 'round';
            dCtx.strokeStyle = pHalo;
            dCtx.lineWidth = 2.6;
            dCtx.strokeText(name, ptX, ly);
            dCtx.fillStyle = pInk;
            dCtx.fillText(name, ptX, ly);
            dCtx.restore();
          }
        }
      }
    }

    // 5. ГОРНЫЕ ПИКИ, ВУЛКАНЫ И ПЕРЕВАЛЫ (OMT)
    if (cfg.peaks && cfg.peaks.enabled && omtData && omtData.layers && omtData.layers.mountain_peak) {
      const pkCfg = cfg.peaks;
      const pkLayer = omtData.layers.mountain_peak;
      const feats = pkLayer.features;
      const t = getTransformParams(pkLayer.extent, omtData.shift);
      const pkInk = adaptLabelColor(pkCfg.color || '#2b190d', light, 'text');
      const pkIconInk = adaptLabelColor(pkCfg.iconColor || pkCfg.color || '#2b190d', light, 'text');
      const pkHalo = adaptLabelColor(pkCfg.haloColor || '#f4ead5', light, 'halo');
      const fontSize = Math.max(8.5, Math.round((pkCfg.size || 11) * zScale));
      const weight = pkCfg.bold ? 'bold ' : '600 ';
      const slant = pkCfg.italic !== false ? 'italic ' : '';
      const fontStr = `${slant}${weight}${fontSize}px "Georgia", serif`;
      const eleFontSize = Math.max(8, Math.round(fontSize * 0.85));
      const eleFontStr = `${eleFontSize}px "Georgia", serif`;
      const rIcon = 4.6 * iconScaleBase * (pkCfg.iconScale ?? 1.0);
      const pkAlpha = pkCfg.opacity ?? 1.0;

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const p = f.props;
        const cls = p.class || 'peak';
        if (cls === 'volcano' && pkCfg.showVolcanoes === false) continue;
        if ((cls === 'saddle' || cls === 'mountain_pass') && pkCfg.showPasses === false) continue;

        const eleNum = p.ele != null ? parseFloat(p.ele) : NaN;
        const hasEle = Number.isFinite(eleNum);

        const rank = p.rank || 99;
        if (zoom <= 9 && rank > 2 && !(hasEle && eleNum >= 2000)) continue;
        if (zoom === 10 && rank > 5) continue;
        if (zoom === 11 && rank > 10) continue;

        const rawName = p['name:ru'] || p.name_ru || p.name || '';
        if (!rawName && (!pkCfg.unnamedAtHighZoom || zoom < 13 || !hasEle)) continue;
        if (!isFeatureInView(f.bbox, t)) continue;

        const ptX = f.geom[0][0] * t.factor - t.offsetX;
        const ptY = f.geom[0][1] * t.factor - t.offsetY;
        if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;

        const gx = coords.x * 256 + ptX;
        const gy = coords.y * 256 + ptY;
        const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

        const showEle = pkCfg.showElevation !== false && hasEle;
        const inlineEle = (pkCfg.elePosition === 'inline');
        const mainLabel = rawName
          ? (showEle && inlineEle ? `${rawName} (${Math.round(eleNum)} м)` : rawName)
          : `выс. ${Math.round(eleNum)} м`;
        const eleLabel = (rawName && showEle && !inlineEle) ? `${Math.round(eleNum)} м` : '';

        mCtx.font = fontStr;
        const tw1 = getCachedTextWidth(mCtx, mainLabel, fontStr);
        let tw2 = 0;
        if (eleLabel) {
          mCtx.font = eleFontStr;
          tw2 = getCachedTextWidth(mCtx, eleLabel, eleFontStr);
        }

        const boxW = Math.max(tw1, tw2, rIcon * 2);
        const textH = fontSize + (eleLabel ? eleFontSize + 2 : 0);
        const boxH = rIcon * 2 + 2 + textH;
        const box = {
          gx: gx - boxW / 2,
          gy: gy - rIcon,
          w: boxW,
          h: boxH,
          tileKey
        };

        if (globalLabelMgr.hasDuplicate('pk_' + mainLabel, gx, gy, 75)) continue;
        if (globalLabelMgr.collides(box, 3)) continue;
        globalLabelMgr.registerName('pk_' + mainLabel, gx, gy, tileKey);
        globalLabelMgr.add(box, 3);

        const pkHalfW = Math.max(rIcon + 6, tw1 * 0.5 + 8, tw2 * 0.5 + 8);
        expandDirty(ptX - pkHalfW, ptY - rIcon - 8, ptX + pkHalfW, ptY + rIcon + fontSize * 1.3 + (eleLabel ? eleFontSize + 8 : 6));

        const dCtx = ensureDrawCtx();
        dCtx.save();
        dCtx.globalAlpha *= pkAlpha;
        drawPeakIcon(dCtx, cls, ptX, ptY, rIcon, pkIconInk, pkHalo, pkCfg.iconStyle || 'classic');

        dCtx.textAlign = 'center';
        dCtx.textBaseline = 'middle';
        dCtx.lineJoin = 'round';
        dCtx.miterLimit = 2;

        const yName = ptY + rIcon + fontSize * 0.65;
        dCtx.font = fontStr;
        dCtx.strokeStyle = pkHalo;
        dCtx.lineWidth = 2.8;
        dCtx.strokeText(mainLabel, ptX, yName);
        dCtx.fillStyle = pkInk;
        dCtx.fillText(mainLabel, ptX, yName);

        if (eleLabel) {
          const yEle = yName + fontSize * 0.6 + eleFontSize * 0.55;
          dCtx.font = eleFontStr;
          dCtx.lineWidth = 2.4;
          dCtx.strokeText(eleLabel, ptX, yEle);
          dCtx.fillText(eleLabel, ptX, yEle);
        }
        dCtx.restore();
      }
    }

    // 6. НАЗВАНИЯ ЗАПОВЕДНИКОВ, НАЦПАРКОВ И ООПТ (OMT)
    if (cfg.parks && cfg.parks.enabled && omtData && omtData.layers && omtData.layers.park) {
      const prCfg = cfg.parks;
      const prLayer = omtData.layers.park;
      const pts = prLayer.points || [];
      const t = getTransformParams(prLayer.extent, omtData.shift);
      const prInk = adaptLabelColor(prCfg.labelColor || '#1f471d', light, 'text');
      const prHalo = adaptLabelColor(prCfg.haloColor || '#eff5e6', light, 'halo');
      const baseFontSize = Math.max(8.5, Math.round((prCfg.size || 12.5) * zScale));
      const slant = prCfg.italic !== false ? 'italic ' : '';
      const baseSpacing = (prCfg.letterSpacing ?? 2.0) * zScale;
      const prAlpha = prCfg.opacity ?? 1.0;
      const isArched = (prCfg.labelStyle || 'arch') === 'arch' && Math.abs(prCfg.archCurve ?? 38) >= 3;
      const archCurve = isArched ? (prCfg.archCurve ?? 38) : 0;
      const baseOrn = prCfg.ornament || 'leaves';
      // Фильтруем точки текущего тайла ДО вычисления иерархии и сортировки
      const visibleParks = [];
      for (let i = 0; i < pts.length; i++) {
      const f = pts[i];
      const p = f.props;
      const rank = p.rank || 99;
      if (zoom <= 10 && rank > 3) continue;
        const rawName = p['name:ru'] || p.name_ru || p.name;
      if (!rawName || !isFeatureInView(f.bbox, t)) continue;
        const ptX = f.geom[0][0] * t.factor - t.offsetX;
        const ptY = f.geom[0][1] * t.factor - t.offsetY;
      if (ptX < 0 || ptX >= 256 || ptY < 0 || ptY >= 256) continue;
        const h = getParkHierarchy(rawName, p, prCfg);
        visibleParks.push({ f, p, rawName, ptX, ptY, h, rank });
      }
      if (visibleParks.length > 1) {
        visibleParks.sort((a, b) => {
      if (b.h.scale !== a.h.scale) return b.h.scale - a.h.scale;
        return a.rank - b.rank;
      });
      }
      for (let i = 0; i < visibleParks.length; i++) {
        const { rawName, ptX, ptY, h } = visibleParks[i];
        const gx = coords.x * 256 + ptX;
        const gy = coords.y * 256 + ptY;
        const tileKey = `${coords.x}:${coords.y}:${coords.z}`;

      const fontSize = Math.max(8, Math.round(baseFontSize * h.scale));
       const weight = h.bold ? 'bold ' : '';
       const fontStr = `${slant}${weight}${fontSize}px "Georgia", serif`;
       const lineStep = fontSize * 1.18;
       const spacing = baseSpacing * h.spacingMul;
       const orn = h.showOrnament ? baseOrn : 'none';

       const displayName = prCfg.uppercase !== false ? rawName.toUpperCase() : rawName;
       const lines = wrapLabelLines(displayName, prCfg.uppercase !== false ? 14 : 17);

       mCtx.font = fontStr;
       const lineWidths = [];
       let maxW = 0;
       for (let l = 0; l < lines.length; l++) {
         const w = measureSpacedText(mCtx, lines[l], spacing, fontStr);
         lineWidths.push(w);
         if (w > maxW) maxW = w;
       }

       const kCurve = archCurve / 100;
       const sign = kCurve >= 0 ? 1 : -1;
       const baseR = isArched ? Math.max(maxW * 0.52, (0.48 * Math.max(95, maxW)) / Math.abs(kCurve)) : 0;
       const sagitta = isArched ? baseR * (1 - Math.cos(Math.min(1.15, (maxW * 0.5) / baseR))) : 0;

       const flankExtra = (orn === 'leaves' || orn === 'stars') ? fontSize * 2.3 : 0;
       const crestExtra = (orn === 'crest') ? fontSize * 1.35 : 0;

       const totalW = maxW + flankExtra;
       const totalH = lines.length * lineStep + sagitta + crestExtra;

       const parkMinDist = Math.max(420, totalW * 1.45, 280 * zScale) * h.minDistMul;
       if (globalLabelMgr.hasDuplicate('pk_park_' + rawName, gx, gy, parkMinDist)) continue;

       const box = { gx: gx - totalW / 2, gy: gy - totalH / 2, w: totalW, h: totalH, tileKey };
       if (globalLabelMgr.collides(box, 4)) continue;

       globalLabelMgr.registerName('pk_park_' + rawName, gx, gy, tileKey);
       globalLabelMgr.add(box, 4);

       expandDirty(
         ptX - totalW * 0.5 - 16,
         ptY - totalH * 0.5 - sagitta - fontSize * 1.5 - 12,
         ptX + totalW * 0.5 + 16,
         ptY + totalH * 0.5 + sagitta + fontSize * 0.8 + 12
       );

       const dCtx = ensureDrawCtx();
       dCtx.save();
       dCtx.globalAlpha *= prAlpha;
       dCtx.translate(ptX, ptY);
       dCtx.font = fontStr;
       dCtx.textAlign = 'center';
       dCtx.textBaseline = 'middle';
       dCtx.lineJoin = 'round';
       dCtx.miterLimit = 2;
       dCtx.strokeStyle = prHalo;
       const haloWidth = Math.max(3.0, fontSize * 0.25);
       dCtx.lineWidth = haloWidth;
       dCtx.fillStyle = prInk;

       const midIdx = Math.floor((lines.length - 1) / 2);

       if (!isArched) {
         const startY = -((lines.length - 1) * lineStep) * 0.5;
         for (let l = 0; l < lines.length; l++) {
           const ly = startY + l * lineStep;
           drawStraightSpacedLine(dCtx, lines[l], ly, lineWidths[l], spacing, haloWidth);
         }
         if (orn === 'leaves' || orn === 'stars') {
           const ornR = fontSize * 0.52;
           const ornY = startY + midIdx * lineStep;
           const ornX = lineWidths[midIdx] * 0.5 + ornR * 1.45;
           drawParkOrnament(dCtx, orn, -ornX, ornY, ornR, 0, -1, prInk, prHalo);
           drawParkOrnament(dCtx, orn,  ornX, ornY, ornR, 0,  1, prInk, prHalo);
         } else if (orn === 'crest') {
           drawParkOrnament(dCtx, 'crest', 0, startY - fontSize * 1.15, fontSize * 0.62, 0, 1, prInk, prHalo);
         }
       } else {
         dCtx.translate(0, -sign * sagitta * 0.42);
         const startY = -((lines.length - 1) * lineStep) * 0.5;

         for (let l = 0; l < lines.length; l++) {
           const lineText = lines[l];
           const lineW = lineWidths[l];
           const lineY = startY + l * lineStep;
           const Rl = Math.max(36, sign > 0 ? (baseR - lineY) : (baseR + lineY));

           let curX = -lineW * 0.5;
           const chars = [];
           for (let c = 0; c < lineText.length; c++) {
             const ch = lineText[c];
             const cw = getCachedCharWidth(dCtx, ch, fontStr);
             const phi = (curX + cw * 0.5) / Rl;
             const px = Rl * Math.sin(phi);
             const py = sign > 0 ? (baseR - Rl * Math.cos(phi)) : (-baseR + Rl * Math.cos(phi));
             chars.push({ ch, px, py, rot: sign > 0 ? phi : -phi });
             curX += cw + (c < lineText.length - 1 ? spacing : 0);
           }

           for (let c = 0; c < chars.length; c++) {
             const it = chars[c];
             if (it.ch === ' ') continue;
             dCtx.save();
             dCtx.translate(it.px, it.py);
             dCtx.rotate(it.rot);
             dCtx.strokeText(it.ch, 0, 0);
             dCtx.restore();
           }
           for (let c = 0; c < chars.length; c++) {
             const it = chars[c];
             if (it.ch === ' ') continue;
             dCtx.save();
             dCtx.translate(it.px, it.py);
             dCtx.rotate(it.rot);
             dCtx.fillText(it.ch, 0, 0);
             dCtx.restore();
           }
         }

         if (orn === 'leaves' || orn === 'stars') {
           const ornR = fontSize * 0.52;
           const lineY = startY + midIdx * lineStep;
           const Rm = Math.max(36, sign > 0 ? (baseR - lineY) : (baseR + lineY));
           const phiEnd = (lineWidths[midIdx] * 0.5 + ornR * 1.45) / Rm;
           const oy = sign > 0 ? (baseR - Rm * Math.cos(phiEnd)) : (-baseR + Rm * Math.cos(phiEnd));
           const ox = Rm * Math.sin(phiEnd);
           const rotEnd = sign > 0 ? phiEnd : -phiEnd;

           drawParkOrnament(dCtx, orn, -ox, oy, ornR, -rotEnd, -1, prInk, prHalo);
           drawParkOrnament(dCtx, orn,  ox, oy, ornR,  rotEnd,  1, prInk, prHalo);
         } else if (orn === 'crest') {
           drawParkOrnament(dCtx, 'crest', 0, startY - fontSize * 1.15, fontSize * 0.62, 0, 1, prInk, prHalo);
         }
       }

       dCtx.restore();
      }
    }

    } finally {
      if (!sCtx) {
        if (!omtOnly && canvas.width > 0) {
          canvas.width = 0;
          canvas.height = 0;
          canvas._crop = null;
        }
      } else {
        sCtx.restore();
        if (dirtyMinX < dirtyMaxX && dirtyMinY < dirtyMaxY) {
          const cx = Math.max(0, Math.floor(dirtyMinX + pad - 4));
          const cy = Math.max(0, Math.floor(dirtyMinY + pad - 4));
          const cx2 = Math.min(fullSize, Math.ceil(dirtyMaxX + pad + 4));
          const cy2 = Math.min(fullSize, Math.ceil(dirtyMaxY + pad + 4));
          const cw = Math.max(0, cx2 - cx);
          const ch = Math.max(0, cy2 - cy);
          if (cw > 0 && ch > 0) {
            canvas.width = cw;
            canvas.height = ch;
            canvas.style.left = (cx - pad) + 'px';
            canvas.style.top = (cy - pad) + 'px';
            canvas._crop = { x: cx, y: cy, w: cw, h: ch };
            const outCtx = canvas.getContext('2d', { alpha: true });
            outCtx.drawImage(_scratchLabelCv, cx, cy, cw, ch, 0, 0, cw, ch);
          } else {
            canvas.width = 0;
            canvas.height = 0;
            canvas._crop = null;
          }
        }
      }
    }
  }

  // =========================================================================
  // LEAFLET СЛОИ С КООПЕРАТИВНОЙ ОЧЕРЕДЬЮ КАДРОВ
  // =========================================================================
  // =========================================================================
  // LEAFLET СЛОИ С КООПЕРАТИВНОЙ ОЧЕРЕДЬЮ КАДРОВ И ПАУЗОЙ ПРИ ДВИЖЕНИИ
  // =========================================================================
  let _renderQueue = [];
  let _renderRaf = 0;
  let _isCameraMoving = false;
  let _resumeRenderTimer = 0;

  // Общий переиспользуемый холст для подписей (устраняет аллокации 512x512 на каждый тайл)
  let _scratchLabelCv = null;
  let _scratchLabelCtx = null;
  function getScratchLabelCanvas(size) {
    if (!_scratchLabelCv) {
      _scratchLabelCv = document.createElement('canvas');
      _scratchLabelCv.width = size;
      _scratchLabelCv.height = size;
      _scratchLabelCtx = _scratchLabelCv.getContext('2d', { alpha: true });
    } else if (_scratchLabelCv.width !== size) {
      _scratchLabelCv.width = size;
      _scratchLabelCv.height = size;
    }
    return { cv: _scratchLabelCv, ctx: _scratchLabelCtx };
  }

  // Слой 1: Геометрия дорог и водоёмов (ПОД деревьями)
  const VectorRoadsGridLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;
      tile._coords = coords;
      tile._mvtOk = false;
      tile._mvtData = null;
      tile._omtData = getCachedOmtTile(coords);

      if (coords.z < MIN_NATIVE_ZOOM) {
        setTimeout(() => done(null, tile), 0);
        return tile;
      }

      const needOmtBorders = !!(cfg.parks && cfg.parks.enabled && cfg.parks.borders && coords.z >= OMT_MIN_ZOOM);
      tile._omtDone = !needOmtBorders;
      const omtPromise = (!tile._omtData && needOmtBorders)
        ? fetchOmtTile(coords).catch(() => null)
        : Promise.resolve(tile._omtData);

      const scheduleOmtGeom = (baseData) => {
        omtPromise.then(omtData => {
          tile._omtDone = true;
          if (tile._removed || !omtData || !omtData.layers) {
            tile._mvtData = null;
            tile._omtData = null;
            return;
          }
          tile._omtData = omtData;
          const hasPolys = !!(omtData.layers.park && omtData.layers.park.polys && omtData.layers.park.polys.length);
          if (!hasPolys) {
            tile._mvtData = null;
            tile._omtData = null;
            return;
          }
          _renderQueue.push({
            type: 'geom',
            tile,
            data: baseData,
            omtData,
            coords,
            done: () => {
              tile._mvtData = null;
              tile._omtData = null;
            }
          });
          if (!_renderRaf && !_isCameraMoving) _renderRaf = requestAnimationFrame(pumpRenderQueue);
        });
      };

      fetchMvtTile(coords).then(data => {
        if (tile._removed) { done(null, tile); return; }
        if (data && data.layers) {
          tile._mvtOk = true;
          tile._mvtData = data;
          const cachedOmt = tile._omtData || getCachedOmtTile(coords);
          tile._omtData = cachedOmt;
          if (cachedOmt || !needOmtBorders) tile._omtDone = true;

          _renderQueue.push({
            type: 'geom',
            tile,
            data,
            omtData: cachedOmt,
            coords,
            done: (err, el) => {
              if (tile._omtDone) {
                tile._mvtData = null;
                tile._omtData = null;
              }
              done(err, el);
            }
          });
          if (!_renderRaf && !_isCameraMoving) _renderRaf = requestAnimationFrame(pumpRenderQueue);

          if (!cachedOmt && needOmtBorders) scheduleOmtGeom(data);
        } else {
          const emptyData = { layers: {}, shift: 0 };
          tile._mvtData = emptyData;
          const cachedOmt = tile._omtData || getCachedOmtTile(coords);
          tile._omtData = cachedOmt;
          if (cachedOmt || !needOmtBorders) tile._omtDone = true;
          const hasPolys = !!(cachedOmt && cachedOmt.layers && cachedOmt.layers.park && cachedOmt.layers.park.polys && cachedOmt.layers.park.polys.length);
          if (hasPolys) {
            _renderQueue.push({
              type: 'geom',
              tile,
              data: emptyData,
              omtData: cachedOmt,
              coords,
              done: (err, el) => {
                tile._mvtData = null;
                tile._omtData = null;
                done(err, el);
              }
            });
            if (!_renderRaf && !_isCameraMoving) _renderRaf = requestAnimationFrame(pumpRenderQueue);
          } else {
            if (tile._omtDone) {
              tile._mvtData = null;
              tile._omtData = null;
            }
            done(null, tile);
            if (needOmtBorders) scheduleOmtGeom(emptyData);
          }
        }
      }).catch(() => {
        done(null, tile);
        if (!tile._removed && needOmtBorders) {
          const emptyData = { layers: {}, shift: 0 };
          tile._mvtData = emptyData;
          scheduleOmtGeom(emptyData);
        }
      });

      return tile;
    },

    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile) {
        tile._removed = true;
        tile._mvtData = null;
        tile._omtData = null;
        tile.width = 0;
        tile.height = 0;
      }
      L.GridLayer.prototype._removeTile.call(this, key);
    }
  });

  function computeLabelsLightSig(light) {
    const n = light && light.night > 0.01 ? Math.round(light.night * 50) : 0;
    const tw = light && light.twilight > 0.01 ? Math.round(light.twilight * 50) : 0;
    const m = (tw > 0 && light.isMorning) ? 1 : 0;
    return `${n}|${tw}|${m}`;
  }

  function getLabelsLightSig(coords) {
    return computeLabelsLightSig(getLightingState(coords));
  }

  const VectorLabelsGridLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const PAD = coords.z >= 16 ? 120 : 96;
      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;

      const wrapper = document.createElement('div');
      wrapper.style.width = '256px';
      wrapper.style.height = '256px';
      wrapper.style.position = 'absolute';
      wrapper.style.overflow = 'visible';

      canvas.style.position = 'absolute';
      canvas.style.left = `-${PAD}px`;
      canvas.style.top = `-${PAD}px`;
      canvas.style.pointerEvents = 'none';
      wrapper.appendChild(canvas);

      wrapper._coords = coords;
      wrapper._canvas = canvas;
      wrapper._pad = PAD;
      wrapper._mvtOk = false;
      wrapper._mvtData = null;
      wrapper._omtData = getCachedOmtTile(coords);
      wrapper._lightSig = null;

      if (coords.z < MIN_NATIVE_ZOOM) {
        setTimeout(() => done(null, wrapper), 0);
        return wrapper;
      }

      const needOmt = isOmtNeeded() && coords.z >= OMT_MIN_ZOOM;
      const omtPromise = (!wrapper._omtData && needOmt) ? fetchOmtTile(coords).catch(() => null) : Promise.resolve(wrapper._omtData);

      fetchMvtTile(coords).then(data => {
        if (wrapper._removed) { done(null, wrapper); return; }
        if (data && data.layers) {
          wrapper._mvtOk = true;
          wrapper._mvtData = data;
          const cachedOmt = wrapper._omtData || getCachedOmtTile(coords);
          wrapper._omtData = cachedOmt;

          _renderQueue.push({ type: 'labels', tile: canvas, data, omtData: cachedOmt, coords, done, pad: PAD, wrapper });
          if (!_renderRaf && !_isCameraMoving) _renderRaf = requestAnimationFrame(pumpRenderQueue);

          if (!cachedOmt && needOmt) {
            omtPromise.then(omtData => {
              if (wrapper._removed || !omtData || !omtData.layers || !wrapper._mvtData) return;
              wrapper._omtData = omtData;
              const hasContent = (omtData.layers.mountain_peak && omtData.layers.mountain_peak.features.length) ||
                                 (omtData.layers.park && omtData.layers.park.points.length);
              if (!hasContent) return;
              _renderQueue.push({
                type: 'labels', tile: canvas, data: wrapper._mvtData, omtData,
                coords, done: () => {}, pad: PAD, wrapper, omtOnly: true
              });
              if (!_renderRaf && !_isCameraMoving) _renderRaf = requestAnimationFrame(pumpRenderQueue);
            });
          }
        } else {
          done(null, wrapper);
        }
      }).catch(() => done(null, wrapper));

      wrapper._cleanup = () => {
        wrapper._removed = true;
        wrapper._mvtData = null;
        wrapper._omtData = null;
      };
      return wrapper;
    },

    _removeTile(key) {
      const tile = this._tiles[key]?.el;
      if (tile) {
        if (tile._cleanup) tile._cleanup();
        if (tile._canvas) {
          tile._canvas._crop = null;
          tile._canvas.width = 0;
          tile._canvas.height = 0;
          tile._canvas = null;
        }
      }
      globalLabelMgr.removeTile(key);
      L.GridLayer.prototype._removeTile.call(this, key);
    }
  });

  function pumpRenderQueue() {
    _renderRaf = 0;
    if (_isCameraMoving || !_renderQueue.length) return;

    const curZoom = WM.map ? Math.round(WM.map.getZoom()) : null;

    // Сразу закрываем удалённые тайлы и тайлы устаревшего зума
    const alive = [];
    for (let i = 0; i < _renderQueue.length; i++) {
      const task = _renderQueue[i];
      if (task.tile._removed || (task.wrapper && task.wrapper._removed) || (curZoom !== null && task.coords.z !== curZoom)) {
        task.done(null, task.wrapper || task.tile);
      } else {
        alive.push(task);
      }
    }
    _renderQueue = alive;
    if (!_renderQueue.length) return;

    // Приоритет тайлам ближе к центру экрана, geom чуть раньше labels
    if (_renderQueue.length > 2 && WM.map && curZoom !== null) {
      const c = WM.map.project(WM.map.getCenter(), curZoom);
      const cx = c.x / 256, cy = c.y / 256;
      _renderQueue.sort((a, b) => {
        const da = (a.coords.x + 0.5 - cx) ** 2 + (a.coords.y + 0.5 - cy) ** 2 + (a.type === 'labels' ? 0.5 : 0);
        const db = (b.coords.x + 0.5 - cx) ** 2 + (b.coords.y + 0.5 - cy) ** 2 + (b.type === 'labels' ? 0.5 : 0);
        return da - db;
      });
    }

    const tStart = performance.now();
    while (_renderQueue.length > 0) {
      if (performance.now() - tStart >= 4.5) break;
      const task = _renderQueue.shift();
      if (task.tile._removed || (task.wrapper && task.wrapper._removed)) {
        task.done(null, task.wrapper || task.tile);
        continue;
      }
      try {
        if (task.type === 'geom') {
          renderGeometryTile(task.tile, task.data, task.coords, task.omtData);
        } else if (task.type === 'labels') {
          renderLabelsTile(task.tile, task.data, task.coords, task.pad, task.omtData, !!task.omtOnly);
          if (task.wrapper) task.wrapper._lightSig = getLabelsLightSig(task.coords);
        }
      } catch (err) {
        console.error('[VectorRoads] Ошибка отрисовки тайла:', task.coords, err);
      }
      task.done(null, task.wrapper || task.tile);
    }

    if (_renderQueue.length > 0 && !_isCameraMoving) {
      _renderRaf = requestAnimationFrame(pumpRenderQueue);
    }
  }




  let roadsLayerInstance = null;
  let labelsLayerInstance = null;
  let roadsGroupInstance = null;

  function applyVisibility() {
    if (!WM.map) return;
    const map = WM.map;

    if (!map.getPane('wm-roads-pane')) {
      map.createPane('wm-roads-pane');
      map.getPane('wm-roads-pane').style.zIndex = 325;
    }
    const roadsPane = map.getPane('wm-roads-pane');
    if (roadsPane) {
      roadsPane.style.mixBlendMode = cfg.blendMode || 'overlay';
      roadsPane.style.willChange = 'transform';
    }

    if (!map.getPane('wm-labels-pane')) {
      map.createPane('wm-labels-pane');
      map.getPane('wm-labels-pane').style.zIndex = 335;
    }
    const labelsPane = map.getPane('wm-labels-pane');
    if (labelsPane) {
      labelsPane.style.mixBlendMode = (cfg.labels && cfg.labels.blendMode) || 'normal';
      labelsPane.style.willChange = 'transform';
    }

    if (cfg.enabled) {
      const buf = L.Browser.mobile ? 1 : 2;
      if (!roadsLayerInstance) {
        roadsLayerInstance = new VectorRoadsGridLayer({
          pane: 'wm-roads-pane',
          minZoom: 9,
          maxZoom: 20,
          opacity: cfg.opacity,
          keepBuffer: buf,
          updateWhenIdle: true,
          updateWhenZooming: false
        });
      }
      if (!labelsLayerInstance) {
        labelsLayerInstance = new VectorLabelsGridLayer({
          pane: 'wm-labels-pane',
          minZoom: 9,
          maxZoom: 20,
          opacity: (cfg.labels && cfg.labels.opacity !== undefined) ? cfg.labels.opacity : 1.0,
          keepBuffer: buf,
          updateWhenIdle: true,
          updateWhenZooming: false
        });
      }

      if (!roadsGroupInstance) {
        roadsGroupInstance = L.layerGroup([roadsLayerInstance, labelsLayerInstance]);
      }
      if (!map.hasLayer(roadsGroupInstance)) {
        map.addLayer(roadsGroupInstance);
      }

      roadsLayerInstance.setOpacity(cfg.opacity);
      labelsLayerInstance.setOpacity((cfg.labels && cfg.labels.opacity !== undefined) ? cfg.labels.opacity : 1.0);
    } else {
      _renderQueue = [];
      if (_renderRaf) {
        cancelAnimationFrame(_renderRaf);
        _renderRaf = 0;
      }
      if (roadsGroupInstance && map.hasLayer(roadsGroupInstance)) {
        map.removeLayer(roadsGroupInstance);
      }
    }

    layerInstance = roadsGroupInstance;
    syncHudUI();
  }

  function redrawLayer() {
    _renderQueue = [];
    globalLabelMgr.clear(); // <-- КЛЮЧЕВОЙ МОМЕНТ: сбрасываем кэш коллизий при перерисовке
    if (roadsLayerInstance) roadsLayerInstance.redraw();
    if (labelsLayerInstance) labelsLayerInstance.redraw();
  }


  function syncHudUI() {
    const $ = (id) => document.getElementById(id);

    const chkMain = $('dem-hud-roads-enable-chk');
    const topBtn = $('dem-hud-toggle-roads');
    const badge = $('dem-hud-roads-status-badge');
    if (chkMain) chkMain.checked = !!cfg.enabled;
    if (topBtn) topBtn.classList.toggle('active', !!cfg.enabled);
    if (badge) {
      badge.textContent = cfg.enabled ? 'Вкл' : 'Выкл';
      badge.classList.toggle('active', !!cfg.enabled);
    }
    // Персональные параметры надписей и свитков
    const lCfg = cfg.labels || {};
    const bCfg = lCfg.banners || {};

    if ($('labels-blend-select')) $('labels-blend-select').value = lCfg.blendMode || 'normal';
    if ($('labels-opacity-slider')) {
      const pct = Math.round((lCfg.opacity !== undefined ? lCfg.opacity : 1.0) * 100);
      $('labels-opacity-slider').value = pct;
      if ($('labels-opacity-val')) $('labels-opacity-val').textContent = pct + '%';
    }

    if ($('peaks-on')) $('peaks-on').checked = !!cfg.peaks.enabled;
    if ($('peaks-sub')) $('peaks-sub').classList.toggle('is-disabled', !cfg.peaks.enabled);
    if ($('peaks-color')) $('peaks-color').value = cfg.peaks.color || '#2b190d';
    if ($('peaks-icon-color')) $('peaks-icon-color').value = cfg.peaks.iconColor || cfg.peaks.color || '#2b190d';
    if ($('peaks-halo')) $('peaks-halo').value = cfg.peaks.haloColor || '#f4ead5';
    if ($('peaks-icon-style')) $('peaks-icon-style').value = cfg.peaks.iconStyle || 'classic';
    if ($('peaks-icon-scale')) {
      const sc = cfg.peaks.iconScale ?? 1.0;
      $('peaks-icon-scale').value = sc;
      if ($('peaks-icon-scale-val')) $('peaks-icon-scale-val').textContent = '×' + parseFloat(sc).toFixed(1);
    }
    if ($('peaks-size')) {
      $('peaks-size').value = cfg.peaks.size;
      if ($('peaks-size-val')) $('peaks-size-val').textContent = cfg.peaks.size + ' px';
    }
    if ($('peaks-opacity')) {
      const pct = Math.round((cfg.peaks.opacity ?? 1.0) * 100);
      $('peaks-opacity').value = pct;
      if ($('peaks-opacity-val')) $('peaks-opacity-val').textContent = pct + '%';
    }
    if ($('peaks-bold')) $('peaks-bold').checked = !!cfg.peaks.bold;
    if ($('peaks-italic')) $('peaks-italic').checked = cfg.peaks.italic !== false;
    if ($('peaks-ele-on')) $('peaks-ele-on').checked = cfg.peaks.showElevation !== false;
    if ($('peaks-ele-pos')) $('peaks-ele-pos').value = cfg.peaks.elePosition || 'below';
    if ($('peaks-volcanoes-on')) $('peaks-volcanoes-on').checked = cfg.peaks.showVolcanoes !== false;
    if ($('peaks-passes-on')) $('peaks-passes-on').checked = cfg.peaks.showPasses !== false;
    if ($('peaks-unnamed-on')) $('peaks-unnamed-on').checked = !!cfg.peaks.unnamedAtHighZoom;

    // Заповедники и нацпарки
    if ($('parks-on')) $('parks-on').checked = !!cfg.parks.enabled;
    if ($('parks-sub')) $('parks-sub').classList.toggle('is-disabled', !cfg.parks.enabled);
    if ($('parks-label-style')) $('parks-label-style').value = cfg.parks.labelStyle || 'arch';
    if ($('parks-ornament')) $('parks-ornament').value = cfg.parks.ornament || 'leaves';
    if ($('parks-arch-wrap')) $('parks-arch-wrap').classList.toggle('is-disabled', (cfg.parks.labelStyle || 'arch') === 'straight');
    if ($('parks-arch-curve')) {
      const cv = cfg.parks.archCurve ?? 38;
      $('parks-arch-curve').value = cv;
      if ($('parks-arch-curve-val')) $('parks-arch-curve-val').textContent = (cv > 0 ? '+' : '') + cv + '%';
    }
    if ($('parks-letter-spacing')) {
      const sp = cfg.parks.letterSpacing ?? 2.0;
      $('parks-letter-spacing').value = sp;
      if ($('parks-letter-spacing-val')) $('parks-letter-spacing-val').textContent = sp + ' px';
    }
    if ($('parks-size')) {
      $('parks-size').value = cfg.parks.size;
      if ($('parks-size-val')) $('parks-size-val').textContent = cfg.parks.size + ' px';
    }
    if ($('parks-label-color')) $('parks-label-color').value = cfg.parks.labelColor || '#1f471d';
    if ($('parks-halo-color')) $('parks-halo-color').value = cfg.parks.haloColor || '#eff5e6';
    if ($('parks-opacity')) {
      const pct = Math.round((cfg.parks.opacity ?? 1.0) * 100);
      $('parks-opacity').value = pct;
      if ($('parks-opacity-val')) $('parks-opacity-val').textContent = pct + '%';
    }
    if ($('parks-uppercase')) $('parks-uppercase').checked = cfg.parks.uppercase !== false;
    if ($('parks-bold')) $('parks-bold').checked = cfg.parks.bold !== false;
    if ($('parks-italic')) $('parks-italic').checked = cfg.parks.italic !== false;
    if ($('parks-borders-on')) $('parks-borders-on').checked = !!cfg.parks.borders;
    if ($('parks-borders-sub')) $('parks-borders-sub').classList.toggle('is-disabled', !cfg.parks.borders);
    if ($('parks-border-style')) $('parks-border-style').value = cfg.parks.borderStyle || 'dashdot';
    if ($('parks-fill-pattern')) $('parks-fill-pattern').value = cfg.parks.fillPattern || 'hatch';
    if ($('parks-stroke')) $('parks-stroke').value = cfg.parks.strokeColor || '#285425';
    if ($('parks-stroke-width')) {
      $('parks-stroke-width').value = cfg.parks.strokeWidth;
      if ($('parks-stroke-width-val')) $('parks-stroke-width-val').textContent = cfg.parks.strokeWidth + ' px';
    }
    if ($('parks-stroke-opacity')) {
      const pct = Math.round((cfg.parks.strokeOpacity ?? 0.80) * 100);
      $('parks-stroke-opacity').value = pct;
      if ($('parks-stroke-opacity-val')) $('parks-stroke-opacity-val').textContent = pct + '%';
    }
    if ($('parks-fill')) $('parks-fill').value = cfg.parks.fillColor || '#3e6b3a';
    if ($('parks-fill-opacity')) {
      const pct = Math.round((cfg.parks.fillOpacity ?? 0.08) * 100);
      $('parks-fill-opacity').value = pct;
      if ($('parks-fill-opacity-val')) $('parks-fill-opacity-val').textContent = pct + '%';
    }
    if ($('parks-border-glow')) $('parks-border-glow').checked = cfg.parks.borderGlow !== false;



    if ($('labels-banner-on')) $('labels-banner-on').checked = bCfg.enabled !== false;
    if ($('labels-banner-color')) $('labels-banner-color').value = bCfg.bannerColor || '#ede4d1';
    if ($('labels-banner-stroke')) $('labels-banner-stroke').value = bCfg.bannerStrokeColor || '#2c1c0f';
    if ($('labels-wash-color')) $('labels-wash-color').value = bCfg.washColor || '#dfcaa7';
    if ($('labels-wash-opacity')) {
      const pct = Math.round((bCfg.washOpacity !== undefined ? bCfg.washOpacity : 0.65) * 100);
      $('labels-wash-opacity').value = pct;
      if ($('labels-wash-opacity-val')) $('labels-wash-opacity-val').textContent = pct + '%';
    }

    // Железные дороги
     const stCfg = cfg.railways.stations || DEFAULT_CONFIG.railways.stations;
    if ($('rail-stations-on')) $('rail-stations-on').checked = !!stCfg.enabled;
    if ($('rail-stations-sub')) $('rail-stations-sub').classList.toggle('is-disabled', !stCfg.enabled);
    if ($('rail-stations-labels-on')) $('rail-stations-labels-on').checked = stCfg.labelsEnabled !== false;
    if ($('rail-stations-icon-on')) $('rail-stations-icon-on').checked = stCfg.showIcon !== false;
    if ($('rail-stations-halts-on')) $('rail-stations-halts-on').checked = stCfg.showHalts !== false;
    if ($('rail-stations-style')) $('rail-stations-style').value = stCfg.labelStyle || 'plate';
    if ($('rail-stations-minzoom')) $('rail-stations-minzoom').value = String(stCfg.minZoom || 13);
    if ($('rail-stations-color')) $('rail-stations-color').value = stCfg.color || '#24160d';
    if ($('rail-stations-halo')) $('rail-stations-halo').value = stCfg.haloColor || '#f4ead5';
    if ($('rail-stations-icon-color')) $('rail-stations-icon-color').value = stCfg.iconColor || stCfg.color || '#24160d';
    if ($('rail-stations-size')) {
      $('rail-stations-size').value = stCfg.size;
      if ($('rail-stations-size-val')) $('rail-stations-size-val').textContent = stCfg.size + ' px';
    }
    if ($('rail-stations-icon-scale')) {
      const sc = stCfg.iconScale ?? 1.0;
      $('rail-stations-icon-scale').value = sc;
      if ($('rail-stations-icon-scale-val')) $('rail-stations-icon-scale-val').textContent = '×' + parseFloat(sc).toFixed(1);
    }
    if ($('rail-stations-opacity')) {
      const pct = Math.round((stCfg.opacity ?? 1.0) * 100);
      $('rail-stations-opacity').value = pct;
      if ($('rail-stations-opacity-val')) $('rail-stations-opacity-val').textContent = pct + '%';
    }
    if ($('rail-stations-bold')) $('rail-stations-bold').checked = stCfg.bold !== false;
    if ($('rail-stations-italic')) $('rail-stations-italic').checked = !!stCfg.italic;
    if ($('rail-on')) $('rail-on').checked = !!cfg.railways.enabled;
    if ($('rail-style-select')) $('rail-style-select').value = cfg.railways.style || 'ties';
    if ($('rail-color')) $('rail-color').value = cfg.railways.color;
    if ($('rail-tie-color')) $('rail-tie-color').value = cfg.railways.tieColor;
    if ($('rail-width')) {
      $('rail-width').value = cfg.railways.width;
      if ($('rail-width-val')) $('rail-width-val').textContent = cfg.railways.width + ' px';
    }
    if ($('rail-opacity')) {
      const pct = Math.round(cfg.railways.opacity * 100);
      $('rail-opacity').value = pct;
      if ($('rail-opacity-val')) $('rail-opacity-val').textContent = pct + '%';
    }
    if ($('rail-minor-on')) $('rail-minor-on').checked = !!cfg.railways.minorEnabled;

    // Причалы и молы
    if ($('piers-on')) $('piers-on').checked = !!cfg.piers.enabled;
    if ($('piers-fill')) $('piers-fill').value = cfg.piers.fillColor;
    if ($('piers-stroke')) $('piers-stroke').value = cfg.piers.strokeColor;
    if ($('piers-width')) {
      $('piers-width').value = cfg.piers.width;
      if ($('piers-width-val')) $('piers-width-val').textContent = cfg.piers.width + ' px';
    }
    if ($('piers-opacity')) {
      const pct = Math.round(cfg.piers.opacity * 100);
      $('piers-opacity').value = pct;
      if ($('piers-opacity-val')) $('piers-opacity-val').textContent = pct + '%';
    }
    if ($('piers-woodcut')) $('piers-woodcut').checked = !!cfg.piers.woodcut;

    // Пашни, сады, виноградники
    if ($('farmland-on')) $('farmland-on').checked = !!cfg.farmland.enabled;
    if ($('farmland-fill')) $('farmland-fill').value = cfg.farmland.fillColor;
    if ($('farmland-fill-opacity')) {
      const pct = Math.round(cfg.farmland.fillOpacity * 100);
      $('farmland-fill-opacity').value = pct;
      if ($('farmland-fill-opacity-val')) $('farmland-fill-opacity-val').textContent = pct + '%';
    }
    if ($('farmland-stroke')) $('farmland-stroke').value = cfg.farmland.strokeColor;
    if ($('farmland-stroke-width')) {
      $('farmland-stroke-width').value = cfg.farmland.strokeWidth;
      if ($('farmland-stroke-width-val')) $('farmland-stroke-width-val').textContent = cfg.farmland.strokeWidth + ' px';
    }
    if ($('farmland-pattern')) $('farmland-pattern').checked = !!cfg.farmland.pattern;

    // Кладбища
    if ($('cemeteries-on')) $('cemeteries-on').checked = !!cfg.cemeteries.enabled;
    if ($('cemeteries-fill')) $('cemeteries-fill').value = cfg.cemeteries.fillColor;
    if ($('cemeteries-fill-opacity')) {
      const pct = Math.round(cfg.cemeteries.fillOpacity * 100);
      $('cemeteries-fill-opacity').value = pct;
      if ($('cemeteries-fill-opacity-val')) $('cemeteries-fill-opacity-val').textContent = pct + '%';
    }
    if ($('cemeteries-stroke')) $('cemeteries-stroke').value = cfg.cemeteries.strokeColor;
    if ($('cemeteries-stroke-width')) {
      $('cemeteries-stroke-width').value = cfg.cemeteries.strokeWidth;
      if ($('cemeteries-stroke-width-val')) $('cemeteries-stroke-width-val').textContent = cfg.cemeteries.strokeWidth + ' px';
    }
    if ($('cemeteries-pattern')) $('cemeteries-pattern').checked = !!cfg.cemeteries.pattern;

    // Транспорт и аэродромы
    if ($('transport-on')) $('transport-on').checked = !!cfg.transport.enabled;
    if ($('transport-color')) $('transport-color').value = cfg.transport.color;
    if ($('transport-halo')) $('transport-halo').value = cfg.transport.haloColor;
    if ($('transport-size')) {
      $('transport-size').value = cfg.transport.size;
      if ($('transport-size-val')) $('transport-size-val').textContent = '×' + parseFloat(cfg.transport.size).toFixed(1);
    }
    if ($('transport-air-on')) $('transport-air-on').checked = !!cfg.transport.airEnabled;
    if ($('transport-rail-on')) $('transport-rail-on').checked = !!cfg.transport.railEnabled;
    if ($('transport-bus-on')) $('transport-bus-on').checked = !!cfg.transport.busEnabled;
    if ($('transport-labels-on')) $('transport-labels-on').checked = !!cfg.transport.labelsEnabled;

    // Точки интереса (POI)
    if ($('pois-on')) $('pois-on').checked = !!cfg.pois.enabled;
    if ($('pois-color')) $('pois-color').value = cfg.pois.color;
    if ($('pois-halo')) $('pois-halo').value = cfg.pois.haloColor;
    if ($('pois-scale')) {
      $('pois-scale').value = cfg.pois.scale;
      if ($('pois-scale-val')) $('pois-scale-val').textContent = '×' + parseFloat(cfg.pois.scale).toFixed(1);
    }
    if ($('pois-historic-on')) $('pois-historic-on').checked = !!cfg.pois.historicEnabled;
    if ($('pois-tourism-on')) $('pois-tourism-on').checked = !!cfg.pois.tourismEnabled;
    if ($('pois-manmade-on')) $('pois-manmade-on').checked = !!cfg.pois.manmadeEnabled;
    if ($('pois-amenity-on')) $('pois-amenity-on').checked = !!cfg.pois.amenityEnabled;
    if ($('pois-labels-on')) $('pois-labels-on').checked = !!cfg.pois.labelsEnabled;

    const sub = $('dem-hud-roads-sub');
    if (sub) sub.classList.toggle('is-disabled', !cfg.enabled);

    if ($('forest-on')) $('forest-on').checked = !!cfg.forest.enabled;
    if ($('forest-fill')) $('forest-fill').value = cfg.forest.fillColor;
    if ($('forest-fill-opacity')) {
      const pct = Math.round(cfg.forest.fillOpacity * 100);
      $('forest-fill-opacity').value = pct;
      if ($('forest-fill-opacity-val')) $('forest-fill-opacity-val').textContent = pct + '%';
    }
    if ($('forest-stroke')) $('forest-stroke').value = cfg.forest.strokeColor;
    if ($('forest-stroke-width')) {
      $('forest-stroke-width').value = cfg.forest.strokeWidth;
      if ($('forest-stroke-width-val')) $('forest-stroke-width-val').textContent = cfg.forest.strokeWidth + ' px';
    }

    // Дороги: Major
    if ($('roads-major-on')) $('roads-major-on').checked = !!cfg.roads.major.enabled;
    if ($('roads-major-color')) $('roads-major-color').value = cfg.roads.major.color;
    if ($('roads-major-width')) {
      $('roads-major-width').value = cfg.roads.major.width;
      if ($('roads-major-width-val')) $('roads-major-width-val').textContent = cfg.roads.major.width + ' px';
    }
    if ($('roads-major-casing')) $('roads-major-casing').checked = !!cfg.roads.major.casing;
    if ($('roads-major-casing-color')) $('roads-major-casing-color').value = cfg.roads.major.casingColor;
    if ($('roads-major-casing-width')) {
      $('roads-major-casing-width').value = cfg.roads.major.casingWidth;
      if ($('roads-major-casing-width-val')) $('roads-major-casing-width-val').textContent = cfg.roads.major.casingWidth + ' px';
    }

    // Дороги: Track
    if ($('roads-track-on')) $('roads-track-on').checked = !!cfg.roads.track.enabled;
    if ($('roads-track-color')) $('roads-track-color').value = cfg.roads.track.color;
    if ($('roads-track-width')) {
      $('roads-track-width').value = cfg.roads.track.width;
      if ($('roads-track-width-val')) $('roads-track-width-val').textContent = cfg.roads.track.width + ' px';
    }
    if ($('roads-track-casing')) $('roads-track-casing').checked = !!cfg.roads.track.casing;
    if ($('roads-track-casing-color')) $('roads-track-casing-color').value = cfg.roads.track.casingColor;
    if ($('roads-track-casing-width')) {
      $('roads-track-casing-width').value = cfg.roads.track.casingWidth;
      if ($('roads-track-casing-width-val')) $('roads-track-casing-width-val').textContent = cfg.roads.track.casingWidth + ' px';
    }

    // Дороги: Path
    if ($('roads-path-on')) $('roads-path-on').checked = !!cfg.roads.path.enabled;
    if ($('roads-path-color')) $('roads-path-color').value = cfg.roads.path.color;
    if ($('roads-path-width')) {
      $('roads-path-width').value = cfg.roads.path.width;
      if ($('roads-path-width-val')) $('roads-path-width-val').textContent = cfg.roads.path.width + ' px';
    }
    if ($('roads-path-dash-select')) $('roads-path-dash-select').value = cfg.roads.path.dashed ? 'dashed' : 'solid';

    // Дороги: Minor
    if ($('roads-minor-on')) $('roads-minor-on').checked = !!cfg.roads.minor.enabled;
    if ($('roads-minor-color')) $('roads-minor-color').value = cfg.roads.minor.color;
    if ($('roads-minor-width')) {
      $('roads-minor-width').value = cfg.roads.minor.width;
      if ($('roads-minor-width-val')) $('roads-minor-width-val').textContent = cfg.roads.minor.width + ' px';
    }

    // Вода: Реки
    if ($('water-rivers-on')) $('water-rivers-on').checked = !!cfg.water.rivers.enabled;
    if ($('water-rivers-color')) $('water-rivers-color').value = cfg.water.rivers.color;
    if ($('water-rivers-width')) {
      $('water-rivers-width').value = cfg.water.rivers.width;
      if ($('water-rivers-width-val')) $('water-rivers-width-val').textContent = cfg.water.rivers.width + ' px';
    }
    if ($('water-rivers-opacity')) {
      const pct = Math.round(cfg.water.rivers.opacity * 100);
      $('water-rivers-opacity').value = pct;
      if ($('water-rivers-opacity-val')) $('water-rivers-opacity-val').textContent = pct + '%';
    }

    // Вода: Озёра
    if ($('water-lakes-on')) $('water-lakes-on').checked = !!cfg.water.lakes.enabled;
    if ($('water-lakes-fill')) $('water-lakes-fill').value = cfg.water.lakes.fillColor;
    if ($('water-lakes-fill-opacity')) {
      const pct = Math.round(cfg.water.lakes.fillOpacity * 100);
      $('water-lakes-fill-opacity').value = pct;
      if ($('water-lakes-fill-opacity-val')) $('water-lakes-fill-opacity-val').textContent = pct + '%';
    }
    if ($('water-lakes-stroke')) $('water-lakes-stroke').value = cfg.water.lakes.strokeColor;
    if ($('water-lakes-stroke-width')) {
      $('water-lakes-stroke-width').value = cfg.water.lakes.strokeWidth;
      if ($('water-lakes-stroke-width-val')) $('water-lakes-stroke-width-val').textContent = cfg.water.lakes.strokeWidth + ' px';
    }

    // Вода: Моря
    if ($('water-oceans-on')) $('water-oceans-on').checked = !!cfg.water.oceans.enabled;
    if ($('water-oceans-fill')) $('water-oceans-fill').value = cfg.water.oceans.fillColor;
    if ($('water-oceans-fill-opacity')) {
      const pct = Math.round(cfg.water.oceans.fillOpacity * 100);
      $('water-oceans-fill-opacity').value = pct;
      if ($('water-oceans-fill-opacity-val')) $('water-oceans-fill-opacity-val').textContent = pct + '%';
    }
    if ($('water-oceans-stroke')) $('water-oceans-stroke').value = cfg.water.oceans.strokeColor;
    if ($('water-oceans-stroke-width')) {
      $('water-oceans-stroke-width').value = cfg.water.oceans.strokeWidth;
      if ($('water-oceans-stroke-width-val')) $('water-oceans-stroke-width-val').textContent = cfg.water.oceans.strokeWidth + ' px';
    }

    // Вода: Болота
    if ($('water-marshes-on')) $('water-marshes-on').checked = !!cfg.water.marshes.enabled;
    if ($('water-marshes-fill')) $('water-marshes-fill').value = cfg.water.marshes.fillColor;
    if ($('water-marshes-fill-opacity')) {
      const pct = Math.round(cfg.water.marshes.fillOpacity * 100);
      $('water-marshes-fill-opacity').value = pct;
      if ($('water-marshes-fill-opacity-val')) $('water-marshes-fill-opacity-val').textContent = pct + '%';
    }
    if ($('water-marshes-stroke')) $('water-marshes-stroke').value = cfg.water.marshes.strokeColor;
    if ($('water-marshes-stroke-width')) {
      $('water-marshes-stroke-width').value = cfg.water.marshes.strokeWidth;
      if ($('water-marshes-stroke-width-val')) $('water-marshes-stroke-width-val').textContent = cfg.water.marshes.strokeWidth + ' px';
    }
    if ($('water-marshes-pattern')) $('water-marshes-pattern').checked = !!cfg.water.marshes.pattern;

    // Названия
    if ($('labels-major-on')) $('labels-major-on').checked = !!cfg.labels.major.enabled;
    if ($('labels-major-color')) $('labels-major-color').value = cfg.labels.major.color;
    if ($('labels-major-halo')) $('labels-major-halo').value = cfg.labels.major.haloColor;
    if ($('labels-major-size')) {
      $('labels-major-size').value = cfg.labels.major.size;
      if ($('labels-major-size-val')) $('labels-major-size-val').textContent = cfg.labels.major.size + ' px';
    }
    if ($('labels-major-bold')) $('labels-major-bold').checked = !!cfg.labels.major.bold;

    if ($('labels-minor-on')) $('labels-minor-on').checked = !!cfg.labels.minor.enabled;
    if ($('labels-minor-color')) $('labels-minor-color').value = cfg.labels.minor.color;
    if ($('labels-minor-halo')) $('labels-minor-halo').value = cfg.labels.minor.haloColor;
    if ($('labels-minor-size')) {
      $('labels-minor-size').value = cfg.labels.minor.size;
      if ($('labels-minor-size-val')) $('labels-minor-size-val').textContent = cfg.labels.minor.size + ' px';
    }
    if ($('labels-minor-bold')) $('labels-minor-bold').checked = !!cfg.labels.minor.bold;

    if ($('labels-loc-on')) $('labels-loc-on').checked = !!cfg.labels.localities.enabled;
    if ($('labels-loc-color')) $('labels-loc-color').value = cfg.labels.localities.color;
    if ($('labels-loc-halo')) $('labels-loc-halo').value = cfg.labels.localities.haloColor;
    if ($('labels-loc-size')) {
      $('labels-loc-size').value = cfg.labels.localities.size;
      if ($('labels-loc-size-val')) $('labels-loc-size-val').textContent = cfg.labels.localities.size + ' px';
    }
    if ($('labels-loc-italic')) $('labels-loc-italic').checked = !!cfg.labels.localities.italic;

    if ($('labels-water-on')) $('labels-water-on').checked = !!cfg.labels.water.enabled;
    if ($('labels-water-color')) $('labels-water-color').value = cfg.labels.water.color;
    if ($('labels-water-halo')) $('labels-water-halo').value = cfg.labels.water.haloColor;
    if ($('labels-water-size')) {
      $('labels-water-size').value = cfg.labels.water.size;
      if ($('labels-water-size-val')) $('labels-water-size-val').textContent = cfg.labels.water.size + ' px';
    }

    // Постройки
    if ($('bld-on')) $('bld-on').checked = !!cfg.buildings.enabled;
    if ($('bld-fill')) $('bld-fill').value = cfg.buildings.fillColor;
    if ($('bld-fill-opacity')) {
      const pct = Math.round(cfg.buildings.fillOpacity * 100);
      $('bld-fill-opacity').value = pct;
      if ($('bld-fill-opacity-val')) $('bld-fill-opacity-val').textContent = pct + '%';
    }
    if ($('bld-stroke')) $('bld-stroke').value = cfg.buildings.strokeColor;
    if ($('bld-stroke-width')) {
      $('bld-stroke-width').value = cfg.buildings.strokeWidth;
      if ($('bld-stroke-width-val')) $('bld-stroke-width-val').textContent = cfg.buildings.strokeWidth + ' px';
    }

    // Общие
    if ($('dem-hud-roads-blend-select')) $('dem-hud-roads-blend-select').value = cfg.blendMode || 'overlay';
    if ($('dem-hud-roads-opacity-slider')) {
      const pct = Math.round(cfg.opacity * 100);
      $('dem-hud-roads-opacity-slider').value = pct;
      if ($('dem-hud-roads-opacity-val')) $('dem-hud-roads-opacity-val').textContent = pct + '%';
    }
    if (window.syncDemSpoilerQuickToggles) {
      window.syncDemSpoilerQuickToggles();
    }
    if (window.syncLayersControlExtras) {
      window.syncLayersControlExtras();
    }

  }

  let _uiInited = false;
  let _initedMap = null;

  function initUI() {
    if (_uiInited) {
      syncHudUI();
      return;
    }
    _uiInited = true;

    const $ = (id) => document.getElementById(id);

    $('dem-hud-toggle-roads')?.addEventListener('change', (e) => {
      cfg.enabled = e.target.checked;
      saveConfig();
      applyVisibility();
    });

    bindCtrl('forest-on', 'forest.enabled', 'bool');
    bindCtrl('forest-fill', 'forest.fillColor', 'color');
    bindCtrl('forest-fill-opacity', 'forest.fillOpacity', 'percent', 'forest-fill-opacity-val', '%');
    bindCtrl('forest-stroke', 'forest.strokeColor', 'color');
    bindCtrl('forest-stroke-width', 'forest.strokeWidth', 'float', 'forest-stroke-width-val', ' px');
    $('dem-hud-roads-enable-chk')?.addEventListener('change', (e) => {
      cfg.enabled = e.target.checked;
      saveConfig();
      applyVisibility();
    });

     bindCtrl('peaks-on', 'peaks.enabled', 'bool');
    $('peaks-on')?.addEventListener('change', (e) => {
      if ($('peaks-sub')) $('peaks-sub').classList.toggle('is-disabled', !e.target.checked);
    });
    bindCtrl('peaks-color', 'peaks.color', 'color');
    bindCtrl('peaks-icon-color', 'peaks.iconColor', 'color');
    bindCtrl('peaks-halo', 'peaks.haloColor', 'color');
    bindCtrl('peaks-icon-style', 'peaks.iconStyle', 'value');
    bindCtrl('peaks-icon-scale', 'peaks.iconScale', 'float');
    $('peaks-icon-scale')?.addEventListener('input', (e) => {
      if ($('peaks-icon-scale-val')) $('peaks-icon-scale-val').textContent = '×' + parseFloat(e.target.value).toFixed(1);
    });
    bindCtrl('peaks-size', 'peaks.size', 'float', 'peaks-size-val', ' px');
    bindCtrl('peaks-opacity', 'peaks.opacity', 'percent', 'peaks-opacity-val', '%');
    bindCtrl('peaks-bold', 'peaks.bold', 'bool');
    bindCtrl('peaks-italic', 'peaks.italic', 'bool');
    bindCtrl('peaks-ele-on', 'peaks.showElevation', 'bool');
    bindCtrl('peaks-ele-pos', 'peaks.elePosition', 'value');
    bindCtrl('peaks-volcanoes-on', 'peaks.showVolcanoes', 'bool');
    bindCtrl('peaks-passes-on', 'peaks.showPasses', 'bool');
    bindCtrl('peaks-unnamed-on', 'peaks.unnamedAtHighZoom', 'bool');

    // Названия и знаки ж/д станций
    bindCtrl('rail-stations-on', 'railways.stations.enabled', 'bool');
    $('rail-stations-on')?.addEventListener('change', (e) => {
      if ($('rail-stations-sub')) $('rail-stations-sub').classList.toggle('is-disabled', !e.target.checked);
    });
    bindCtrl('rail-stations-labels-on', 'railways.stations.labelsEnabled', 'bool');
    bindCtrl('rail-stations-icon-on', 'railways.stations.showIcon', 'bool');
    bindCtrl('rail-stations-halts-on', 'railways.stations.showHalts', 'bool');
    bindCtrl('rail-stations-style', 'railways.stations.labelStyle', 'value');
    bindCtrl('rail-stations-minzoom', 'railways.stations.minZoom', 'float');
    bindCtrl('rail-stations-color', 'railways.stations.color', 'color');
    bindCtrl('rail-stations-halo', 'railways.stations.haloColor', 'color');
    bindCtrl('rail-stations-icon-color', 'railways.stations.iconColor', 'color');
    bindCtrl('rail-stations-size', 'railways.stations.size', 'float', 'rail-stations-size-val', ' px');
    bindCtrl('rail-stations-icon-scale', 'railways.stations.iconScale', 'float');
    $('rail-stations-icon-scale')?.addEventListener('input', (e) => {
      if ($('rail-stations-icon-scale-val')) $('rail-stations-icon-scale-val').textContent = '×' + parseFloat(e.target.value).toFixed(1);
    });
    bindCtrl('rail-stations-opacity', 'railways.stations.opacity', 'percent', 'rail-stations-opacity-val', '%');
    bindCtrl('rail-stations-bold', 'railways.stations.bold', 'bool');
    bindCtrl('rail-stations-italic', 'railways.stations.italic', 'bool');

    // Заповедники и нацпарки
    bindCtrl('parks-on', 'parks.enabled', 'bool');
    $('parks-on')?.addEventListener('change', (e) => {
      if ($('parks-sub')) $('parks-sub').classList.toggle('is-disabled', !e.target.checked);
    });
    bindCtrl('parks-label-style', 'parks.labelStyle', 'value');
    $('parks-label-style')?.addEventListener('change', (e) => {
      if ($('parks-arch-wrap')) $('parks-arch-wrap').classList.toggle('is-disabled', e.target.value === 'straight');
    });
    bindCtrl('parks-ornament', 'parks.ornament', 'value');
    bindCtrl('parks-arch-curve', 'parks.archCurve', 'float');
    $('parks-arch-curve')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if ($('parks-arch-curve-val')) $('parks-arch-curve-val').textContent = (v > 0 ? '+' : '') + v + '%';
    });
    bindCtrl('parks-letter-spacing', 'parks.letterSpacing', 'float', 'parks-letter-spacing-val', ' px');
    bindCtrl('parks-size', 'parks.size', 'float', 'parks-size-val', ' px');
    bindCtrl('parks-label-color', 'parks.labelColor', 'color');
    bindCtrl('parks-halo-color', 'parks.haloColor', 'color');
    bindCtrl('parks-opacity', 'parks.opacity', 'percent', 'parks-opacity-val', '%');
    bindCtrl('parks-uppercase', 'parks.uppercase', 'bool');
    bindCtrl('parks-bold', 'parks.bold', 'bool');
    bindCtrl('parks-italic', 'parks.italic', 'bool');

    bindCtrl('parks-borders-on', 'parks.borders', 'bool');
    $('parks-borders-on')?.addEventListener('change', (e) => {
      if ($('parks-borders-sub')) $('parks-borders-sub').classList.toggle('is-disabled', !e.target.checked);
    });
    bindCtrl('parks-border-style', 'parks.borderStyle', 'value');
    bindCtrl('parks-fill-pattern', 'parks.fillPattern', 'value');
    bindCtrl('parks-stroke', 'parks.strokeColor', 'color');
    bindCtrl('parks-stroke-width', 'parks.strokeWidth', 'float', 'parks-stroke-width-val', ' px');
    bindCtrl('parks-stroke-opacity', 'parks.strokeOpacity', 'percent', 'parks-stroke-opacity-val', '%');
    bindCtrl('parks-fill', 'parks.fillColor', 'color');
    bindCtrl('parks-fill-opacity', 'parks.fillOpacity', 'percent', 'parks-fill-opacity-val', '%');
    bindCtrl('parks-border-glow', 'parks.borderGlow', 'bool');

    $('dem-hud-roads-blend-select')?.addEventListener('change', (e) => {
      cfg.blendMode = e.target.value;
      saveConfig();
      applyVisibility();
    });

    $('labels-blend-select')?.addEventListener('change', (e) => {
      if (!cfg.labels) cfg.labels = {};
      cfg.labels.blendMode = e.target.value;
      saveConfig();
      applyVisibility();
    });

    $('labels-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10) / 100;
      if (!cfg.labels) cfg.labels = {};
      cfg.labels.opacity = v;
      if ($('labels-opacity-val')) $('labels-opacity-val').textContent = Math.round(v * 100) + '%';
      saveConfig();
      if (labelsLayerInstance) labelsLayerInstance.setOpacity(v);
    });

    $('labels-banner-on')?.addEventListener('change', (e) => {
      if (!cfg.labels.banners) cfg.labels.banners = {};
       if (window.syncDemSpoilerQuickToggles) window.syncDemSpoilerQuickToggles(); 
      cfg.labels.banners.enabled = e.target.checked;
      saveConfig();
      redrawLayer();

    });

    // Железные дороги
    bindCtrl('rail-on', 'railways.enabled', 'bool');
    bindCtrl('rail-style-select', 'railways.style', 'value');
    bindCtrl('rail-color', 'railways.color', 'color');
    bindCtrl('rail-tie-color', 'railways.tieColor', 'color');
    bindCtrl('rail-width', 'railways.width', 'float', 'rail-width-val', ' px');
    bindCtrl('rail-opacity', 'railways.opacity', 'percent', 'rail-opacity-val', '%');
    bindCtrl('rail-minor-on', 'railways.minorEnabled', 'bool');

    // Причалы и молы
    bindCtrl('piers-on', 'piers.enabled', 'bool');
    bindCtrl('piers-fill', 'piers.fillColor', 'color');
    bindCtrl('piers-stroke', 'piers.strokeColor', 'color');
    bindCtrl('piers-width', 'piers.width', 'float', 'piers-width-val', ' px');
    bindCtrl('piers-opacity', 'piers.opacity', 'percent', 'piers-opacity-val', '%');
    bindCtrl('piers-woodcut', 'piers.woodcut', 'bool');

    // Пашни, сады, виноградники
    bindCtrl('farmland-on', 'farmland.enabled', 'bool');
    bindCtrl('farmland-fill', 'farmland.fillColor', 'color');
    bindCtrl('farmland-fill-opacity', 'farmland.fillOpacity', 'percent', 'farmland-fill-opacity-val', '%');
    bindCtrl('farmland-stroke', 'farmland.strokeColor', 'color');
    bindCtrl('farmland-stroke-width', 'farmland.strokeWidth', 'float', 'farmland-stroke-width-val', ' px');
    bindCtrl('farmland-pattern', 'farmland.pattern', 'bool');

    // Кладбища
    bindCtrl('cemeteries-on', 'cemeteries.enabled', 'bool');
    bindCtrl('cemeteries-fill', 'cemeteries.fillColor', 'color');
    bindCtrl('cemeteries-fill-opacity', 'cemeteries.fillOpacity', 'percent', 'cemeteries-fill-opacity-val', '%');
    bindCtrl('cemeteries-stroke', 'cemeteries.strokeColor', 'color');
    bindCtrl('cemeteries-stroke-width', 'cemeteries.strokeWidth', 'float', 'cemeteries-stroke-width-val', ' px');
    bindCtrl('cemeteries-pattern', 'cemeteries.pattern', 'bool');

    // Транспорт и аэродромы
    bindCtrl('transport-on', 'transport.enabled', 'bool');
    bindCtrl('transport-color', 'transport.color', 'color');
    bindCtrl('transport-halo', 'transport.haloColor', 'color');
    bindCtrl('transport-size', 'transport.size', 'float');
    $('transport-size')?.addEventListener('input', (e) => {
      if ($('transport-size-val')) $('transport-size-val').textContent = '×' + parseFloat(e.target.value).toFixed(1);
    });
    bindCtrl('transport-air-on', 'transport.airEnabled', 'bool');
    bindCtrl('transport-rail-on', 'transport.railEnabled', 'bool');
    bindCtrl('transport-bus-on', 'transport.busEnabled', 'bool');
    bindCtrl('transport-labels-on', 'transport.labelsEnabled', 'bool');

    // Точки интереса (POI)
    bindCtrl('pois-on', 'pois.enabled', 'bool');
    bindCtrl('pois-color', 'pois.color', 'color');
    bindCtrl('pois-halo', 'pois.haloColor', 'color');
    bindCtrl('pois-scale', 'pois.scale', 'float');
    $('pois-scale')?.addEventListener('input', (e) => {
      if ($('pois-scale-val')) $('pois-scale-val').textContent = '×' + parseFloat(e.target.value).toFixed(1);
    });
    bindCtrl('pois-historic-on', 'pois.historicEnabled', 'bool');
    bindCtrl('pois-tourism-on', 'pois.tourismEnabled', 'bool');
    bindCtrl('pois-manmade-on', 'pois.manmadeEnabled', 'bool');
    bindCtrl('pois-amenity-on', 'pois.amenityEnabled', 'bool');
    bindCtrl('pois-labels-on', 'pois.labelsEnabled', 'bool');

    bindCtrl('labels-banner-color', 'labels.banners.bannerColor', 'color');
    bindCtrl('labels-banner-stroke', 'labels.banners.bannerStrokeColor', 'color');
    bindCtrl('labels-wash-color', 'labels.banners.washColor', 'color');
    bindCtrl('labels-wash-opacity', 'labels.banners.washOpacity', 'percent', 'labels-wash-opacity-val', '%');

    $('dem-hud-roads-opacity-slider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.opacity = v / 100;
      if ($('dem-hud-roads-opacity-val')) $('dem-hud-roads-opacity-val').textContent = v + '%';
      saveConfig();
      if (roadsLayerInstance) roadsLayerInstance.setOpacity(cfg.opacity);
    });

    function bindCtrl(id, path, type = 'value', valId = null, suffix = '') {
      const el = $(id);
      if (!el) return;
      const keys = path.split('.');
      const ev = (el.type === 'checkbox' || el.type === 'color' || el.tagName === 'SELECT') ? 'change' : 'input';

      el.addEventListener(ev, (e) => {
        let val;
        if (type === 'bool') val = e.target.checked;
        else if (type === 'float') val = parseFloat(e.target.value);
        else if (type === 'percent') val = parseInt(e.target.value, 10) / 100;
        else val = e.target.value;

        if (valId && $(valId)) {
          $(valId).textContent = (type === 'percent' ? Math.round(val * 100) : val) + suffix;
        }

        let ref = cfg;
        for (let i = 0; i < keys.length - 1; i++) ref = ref[keys[i]];
        ref[keys[keys.length - 1]] = val;

        saveConfig();
        redrawLayer();
        if (type === 'bool' && window.syncDemSpoilerQuickToggles) {
          window.syncDemSpoilerQuickToggles();
        }
      });
    }

    // Привязка UI элементов
    bindCtrl('roads-major-on', 'roads.major.enabled', 'bool');
    bindCtrl('roads-major-color', 'roads.major.color', 'color');
    bindCtrl('roads-major-width', 'roads.major.width', 'float', 'roads-major-width-val', ' px');
    bindCtrl('roads-major-casing', 'roads.major.casing', 'bool');
    bindCtrl('roads-major-casing-color', 'roads.major.casingColor', 'color');
    bindCtrl('roads-major-casing-width', 'roads.major.casingWidth', 'float', 'roads-major-casing-width-val', ' px');

    bindCtrl('roads-track-on', 'roads.track.enabled', 'bool');
    bindCtrl('roads-track-color', 'roads.track.color', 'color');
    bindCtrl('roads-track-width', 'roads.track.width', 'float', 'roads-track-width-val', ' px');
    bindCtrl('roads-track-casing', 'roads.track.casing', 'bool');
    bindCtrl('roads-track-casing-color', 'roads.track.casingColor', 'color');
    bindCtrl('roads-track-casing-width', 'roads.track.casingWidth', 'float', 'roads-track-casing-width-val', ' px');

    bindCtrl('roads-path-on', 'roads.path.enabled', 'bool');
    bindCtrl('roads-path-color', 'roads.path.color', 'color');
    bindCtrl('roads-path-width', 'roads.path.width', 'float', 'roads-path-width-val', ' px');
    $('roads-path-dash-select')?.addEventListener('change', (e) => {
      cfg.roads.path.dashed = (e.target.value === 'dashed');
      saveConfig();
      redrawLayer();
    });

    bindCtrl('roads-minor-on', 'roads.minor.enabled', 'bool');
    bindCtrl('roads-minor-color', 'roads.minor.color', 'color');
    bindCtrl('roads-minor-width', 'roads.minor.width', 'float', 'roads-minor-width-val', ' px');

    bindCtrl('water-rivers-on', 'water.rivers.enabled', 'bool');
    bindCtrl('water-rivers-color', 'water.rivers.color', 'color');
    bindCtrl('water-rivers-width', 'water.rivers.width', 'float', 'water-rivers-width-val', ' px');
    bindCtrl('water-rivers-opacity', 'water.rivers.opacity', 'percent', 'water-rivers-opacity-val', '%');

    bindCtrl('water-lakes-on', 'water.lakes.enabled', 'bool');
    bindCtrl('water-lakes-fill', 'water.lakes.fillColor', 'color');
    bindCtrl('water-lakes-fill-opacity', 'water.lakes.fillOpacity', 'percent', 'water-lakes-fill-opacity-val', '%');
    bindCtrl('water-lakes-stroke', 'water.lakes.strokeColor', 'color');
    bindCtrl('water-lakes-stroke-width', 'water.lakes.strokeWidth', 'float', 'water-lakes-stroke-width-val', ' px');

    bindCtrl('water-oceans-on', 'water.oceans.enabled', 'bool');
    bindCtrl('water-oceans-fill', 'water.oceans.fillColor', 'color');
    bindCtrl('water-oceans-fill-opacity', 'water.oceans.fillOpacity', 'percent', 'water-oceans-fill-opacity-val', '%');
    bindCtrl('water-oceans-stroke', 'water.oceans.strokeColor', 'color');
    bindCtrl('water-oceans-stroke-width', 'water.oceans.strokeWidth', 'float', 'water-oceans-stroke-width-val', ' px');

    bindCtrl('water-marshes-on', 'water.marshes.enabled', 'bool');
    bindCtrl('water-marshes-fill', 'water.marshes.fillColor', 'color');
    bindCtrl('water-marshes-fill-opacity', 'water.marshes.fillOpacity', 'percent', 'water-marshes-fill-opacity-val', '%');
    bindCtrl('water-marshes-stroke', 'water.marshes.strokeColor', 'color');
    bindCtrl('water-marshes-stroke-width', 'water.marshes.strokeWidth', 'float', 'water-marshes-stroke-width-val', ' px');
    bindCtrl('water-marshes-pattern', 'water.marshes.pattern', 'bool');

    bindCtrl('labels-major-on', 'labels.major.enabled', 'bool');
    bindCtrl('labels-major-color', 'labels.major.color', 'color');
    bindCtrl('labels-major-halo', 'labels.major.haloColor', 'color');
    bindCtrl('labels-major-size', 'labels.major.size', 'float', 'labels-major-size-val', ' px');
    bindCtrl('labels-major-bold', 'labels.major.bold', 'bool');

    bindCtrl('labels-minor-on', 'labels.minor.enabled', 'bool');
    bindCtrl('labels-minor-color', 'labels.minor.color', 'color');
    bindCtrl('labels-minor-halo', 'labels.minor.haloColor', 'color');
    bindCtrl('labels-minor-size', 'labels.minor.size', 'float', 'labels-minor-size-val', ' px');
    bindCtrl('labels-minor-bold', 'labels.minor.bold', 'bool');

    bindCtrl('labels-loc-on', 'labels.localities.enabled', 'bool');
    bindCtrl('labels-loc-color', 'labels.localities.color', 'color');
    bindCtrl('labels-loc-halo', 'labels.localities.haloColor', 'color');
    bindCtrl('labels-loc-size', 'labels.localities.size', 'float', 'labels-loc-size-val', ' px');
    bindCtrl('labels-loc-italic', 'labels.localities.italic', 'bool');

    bindCtrl('labels-water-on', 'labels.water.enabled', 'bool');
    bindCtrl('labels-water-color', 'labels.water.color', 'color');
    bindCtrl('labels-water-halo', 'labels.water.haloColor', 'color');
    bindCtrl('labels-water-size', 'labels.water.size', 'float', 'labels-water-size-val', ' px');

    bindCtrl('bld-on', 'buildings.enabled', 'bool');
    bindCtrl('bld-fill', 'buildings.fillColor', 'color');
    bindCtrl('bld-fill-opacity', 'buildings.fillOpacity', 'percent', 'bld-fill-opacity-val', '%');
    bindCtrl('bld-stroke', 'buildings.strokeColor', 'color');
    bindCtrl('bld-stroke-width', 'buildings.strokeWidth', 'float', 'bld-stroke-width-val', ' px');

    // Экспорт / Импорт / Сброс
    $('btn-vector-roads-export-json')?.addEventListener('click', exportConfig);

    const fileInput = $('vector-roads-import-input');
    $('btn-vector-roads-import-json')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          importConfig(ev.target.result);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Настройки векторных слоёв успешно импортированы');
        } catch (err) {
          alert('Ошибка чтения JSON: ' + err.message);
        }
        fileInput.value = '';
      };
      reader.readAsText(file);
    });

    $('btn-vector-roads-reset')?.addEventListener('click', () => {
      if (confirm('Сбросить оформление векторных дорог, водоёмов и подписей к исходным?')) {
        cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        saveConfig();
        syncHudUI();
        applyVisibility();
        redrawLayer();
      }
    });

    syncHudUI();
  }

  function exportConfig() {
    const jsonStr = JSON.stringify(cfg, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vector-map-style-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyProfile(profileObj) {
    if (!profileObj || typeof profileObj !== 'object' || profileObj.enabled === false) {
      cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      cfg.enabled = false;
    } else {
      cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), profileObj);
    }
    saveConfig();
    applyVisibility();
    if (cfg.enabled) {
      redrawLayer();
    } else {
      syncHudUI();
    }
  }

  function importConfig(jsonStr) {
    const parsed = JSON.parse(jsonStr);
    cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), parsed);
    saveConfig();
    syncHudUI();
    applyVisibility();
    redrawLayer();
  }

  const roadSegmentsCache = new Map();

  function distSqPointToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return (px - qx) * (px - qx) + (py - qy) * (py - qy);
  }

  const riverDataCache = new Map();
  const riverDataInFlight = new Map();

  function getTileRiverData(z, tx, ty, onReady) {
    const key = `${z}:${tx}:${ty}`;
    const cached = getLru(riverDataCache, key);
    if (cached) return cached;

    if (riverDataInFlight.has(key)) {
      if (onReady) riverDataInFlight.get(key).push(onReady);
      return null;
    }

    const waiters = onReady ? [onReady] : [];
    riverDataInFlight.set(key, waiters);

    fetchMvtTile({ z, x: tx, y: ty }).then(data => {
      const cbs = riverDataInFlight.get(key) || [];
      riverDataInFlight.delete(key);

      if (!data || !data.layers) return;

      const segs = [];
      const polys = [];
      const bankSegs = [];

      const calcTransform = (layer) => {
        const extent = layer.extent || 4096;
        let factor = 256 / extent;
        let offX = 0, offY = 0;
        if (data.shift > 0) {
          const factorSub = 1 << data.shift;
          const subX = ((tx % factorSub) + factorSub) % factorSub;
          const subY = ((ty % factorSub) + factorSub) % factorSub;
          factor = (256 * factorSub) / extent;
          offX = subX * 256;
          offY = subY * 256;
        }
        return { extent, factor, offX, offY };
      };

      // 1. Линейные водотоки (реки, каналы, ручьи)
      if (data.layers.water_lines && data.layers.water_lines.features.length) {
        const { factor, offX, offY } = calcTransform(data.layers.water_lines);
        const feats = data.layers.water_lines.features;

        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          if (f.props.tunnel) continue; // подземные коллекторы не вырезают лес сверху

          const k = f.props.kind || 'stream';
          let baseR = 2.8;
          if (k === 'river') baseR = 5.5;
          else if (k === 'canal') baseR = 4.2;
          else if (k === 'stream') baseR = 2.8;
          else if (k === 'ditch' || k === 'drain') baseR = 1.6;

          for (let l = 0; l < f.geom.length; l++) {
            const line = f.geom[l];
            for (let p = 0; p < line.length - 2; p += 2) {
              const x1 = line[p] * factor - offX;
              const y1 = line[p + 1] * factor - offY;
              const x2 = line[p + 2] * factor - offX;
              const y2 = line[p + 3] * factor - offY;
              const minX = x1 < x2 ? x1 : x2, maxX = x1 > x2 ? x1 : x2;
              const minY = y1 < y2 ? y1 : y2, maxY = y1 > y2 ? y1 : y2;
              if (maxX < -40 || minX > 296 || maxY < -40 || minY > 296) continue;
              segs.push({ x1, y1, x2, y2, minX, maxX, minY, maxY, r: baseR });
            }
          }
        }
      }

      // 2. Площадные водные объекты (широкие реки, озёра, пруды)
      if (data.layers.water_polygons && data.layers.water_polygons.features.length) {
        const { extent, factor, offX, offY } = calcTransform(data.layers.water_polygons);
        const eps = Math.max(2, extent * 0.0005);
        const maxC = extent - eps;
        const feats = data.layers.water_polygons.features;

        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          const minX = f.bbox[0] * factor - offX;
          const minY = f.bbox[1] * factor - offY;
          const maxX = f.bbox[2] * factor - offX;
          const maxY = f.bbox[3] * factor - offY;
          if (maxX < -40 || minX > 296 || maxY < -40 || minY > 296) continue;

          const rings = [];
          for (let l = 0; l < f.geom.length; l++) {
            const line = f.geom[l];
            if (line.length < 6) continue;
            const pts = new Float32Array(line.length);
            for (let p = 0; p < line.length; p += 2) {
              const px = line[p] * factor - offX;
              const py = line[p + 1] * factor - offY;
              pts[p] = px;
              pts[p + 1] = py;

              if (p < line.length - 2) {
                const mx0 = line[p], my0 = line[p + 1];
                const mx1 = line[p + 2], my1 = line[p + 3];
                const isClipV = Math.abs(mx0 - mx1) <= 1.5 && ((mx0 <= eps && mx1 <= eps) || (mx0 >= maxC && mx1 >= maxC));
                const isClipH = Math.abs(my0 - my1) <= 1.5 && ((my0 <= eps && my1 <= eps) || (my0 >= maxC && my1 >= maxC));
                if (!isClipV && !isClipH) {
                  const px1 = mx1 * factor - offX;
                  const py1 = my1 * factor - offY;
                  if (Math.max(px, px1) >= -40 && Math.min(px, px1) <= 296 &&
                      Math.max(py, py1) >= -40 && Math.min(py, py1) <= 296) {
                    bankSegs.push(px, py, px1, py1);
                  }
                }
              }
            }
            rings.push(pts);
          }

          if (rings.length) {
            polys.push({ rings, minX, minY, maxX, maxY });
          }
        }
      }

      setLru(riverDataCache, key, { segs, polys, bankSegs }, AUX_CACHE_MAX);

      for (let i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch (e) {}
      }
    }).catch(() => {
      riverDataInFlight.delete(key);
    });

    return null;
  }

  const roadSegmentsInFlight = new Map();

  function getTileRoadSegments(z, tx, ty, onReady) {
    const key = `${z}:${tx}:${ty}`;
    const cached = getLru(roadSegmentsCache, key);
    if (cached) return cached;

    if (roadSegmentsInFlight.has(key)) {
      if (onReady) roadSegmentsInFlight.get(key).push(onReady);
      return null;
    }

    const waiters = onReady ? [onReady] : [];
    roadSegmentsInFlight.set(key, waiters);

    fetchMvtTile({ z, x: tx, y: ty }).then(data => {
      const cbs = roadSegmentsInFlight.get(key) || [];
      roadSegmentsInFlight.delete(key);

      if (!data || !data.layers || !data.layers.streets) {
        setLru(roadSegmentsCache, key, [], AUX_CACHE_MAX);
        return;
      }
      const streets = data.layers.streets;
      const extent = streets.extent || 4096;
      let factor = 256 / extent;
      let offX = 0, offY = 0;

      if (data.shift > 0) {
        const factorSub = 1 << data.shift;
        const subX = tx % factorSub;
        const subY = ty % factorSub;
        factor = (256 * factorSub) / extent;
        offX = subX * 256;
        offY = subY * 256;
      }

      const segments = [];
      const feats = streets.features;

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const k = f.props.kind || 'unclassified';
        if (f.props.tunnel) continue;

        let baseR = 4.0;
        if (f.props.rail || RAIL_KINDS.has(k)) baseR = (k === 'rail') ? 5.5 : 3.5;
        else if (k === 'motorway' || k === 'trunk') baseR = 12.0;
        else if (k === 'primary') baseR = 9.5;
        else if (k === 'secondary' || k === 'tertiary') baseR = 7.5;
        else if (k === 'track') baseR = 4.0;
        else if (k === 'path' || k === 'footway') baseR = 2.0;
        else baseR = 6.0;

        for (let l = 0; l < f.geom.length; l++) {
          const line = f.geom[l];
          for (let p = 0; p < line.length - 2; p += 2) {
            const x1 = line[p] * factor - offX;
            const y1 = line[p + 1] * factor - offY;
            const x2 = line[p + 2] * factor - offX;
            const y2 = line[p + 3] * factor - offY;
            const minX = x1 < x2 ? x1 : x2, maxX = x1 > x2 ? x1 : x2;
            const minY = y1 < y2 ? y1 : y2, maxY = y1 > y2 ? y1 : y2;
            if (maxX < -24 || minX > 280 || maxY < -24 || minY > 280) continue;
            segments.push({ x1, y1, x2, y2, minX, maxX, minY, maxY, r: baseR });
          }
        }
      }

      setLru(roadSegmentsCache, key, segments, AUX_CACHE_MAX);
      for (let i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch (e) {}
      }
    }).catch(() => {
      roadSegmentsInFlight.delete(key);
      setLru(roadSegmentsCache, key, [], AUX_CACHE_MAX);
    });

    return null;
  }

let _lightingTimer = 0;
  let _lastCenterLightSig = null;

  function getCenterLightSig() {
    if (!WM.map || !WM.demRelief || typeof WM.demRelief.getLighting !== 'function') return '0';
    const c = WM.map.getCenter();
    return computeLabelsLightSig(WM.demRelief.getLighting(c.lat, c.lng));
  }

  function redrawLabelsInPlace() {
    if (!cfg.enabled || !labelsLayerInstance || !WM.map || !WM.map.hasLayer(labelsLayerInstance)) return;
    const tiles = labelsLayerInstance._tiles;
    if (!tiles) return;

    const curZoom = Math.round(WM.map.getZoom());
    const toRedraw = [];
    let anyChanged = false;

    for (const key in tiles) {
      const entry = tiles[key];
      const el = entry && entry.el;
      if (!el || el._removed || !el._mvtData || !el._canvas) continue;
      if (entry.coords.z !== curZoom) continue;

      const sig = getLabelsLightSig(entry.coords);
      if (el._lightSig !== sig) anyChanged = true;
      toRedraw.push({ entry, el, sig });
    }

    if (!anyChanged || !toRedraw.length) return;

    labelColorCache.clear();
    globalLabelMgr.clear();
    globalLabelMgr.resetIfZoomChanged(curZoom);

    const pendingDoneByWrapper = new Map();
    const keptQueue = [];
    for (let i = 0; i < _renderQueue.length; i++) {
      const t = _renderQueue[i];
      if (t.type !== 'labels') {
        keptQueue.push(t);
      } else if (t.wrapper && t.done) {
        const prev = pendingDoneByWrapper.get(t.wrapper);
        const origDone = t.done;
        pendingDoneByWrapper.set(t.wrapper, prev
          ? (err, res) => { prev(err, res); origDone(err, res); }
          : origDone);
      }
    }
    _renderQueue = keptQueue;

    for (let i = 0; i < toRedraw.length; i++) {
      const { entry, el, sig } = toRedraw[i];
      const pendingDone = pendingDoneByWrapper.get(el);
      _renderQueue.push({
        type: 'labels',
        tile: el._canvas,
        data: el._mvtData,
        omtData: el._omtData,
        coords: entry.coords,
        pad: el._pad || (entry.coords.z >= 16 ? 120 : 96),
        wrapper: el,
        done: (err, res) => {
          el._lightSig = sig;
          if (pendingDone) pendingDone(err, res);
        }
      });
    }
    if (!_renderRaf && !_isCameraMoving && _renderQueue.length) {
      _renderRaf = requestAnimationFrame(pumpRenderQueue);
    }
  }

  function onLightingChanged() {
    if (!cfg.enabled || !layerInstance) return;
    _lastCenterLightSig = getCenterLightSig();
    clearTimeout(_lightingTimer);
    _lightingTimer = setTimeout(() => {
      _lightingTimer = 0;
      redrawLabelsInPlace();
    }, 45);
  }



  // =========================================================================
  // ГЕНЕРАТОР КАРТЫ РАССТОЯНИЙ ДЛЯ ОКРАСКИ РЕЛЬЕФА (ДОРОГИ И ОПУШКИ ЛЕСА)
  // =========================================================================
  const _featCanvasSize = 128;
  const _featPad = 24; // 24 px при 128x128 = 48 px на 256px тайле
  const _featW = _featCanvasSize + _featPad * 2; // 176
  let _featRoadCv = null, _featRoadCtx = null;
  let _featForestCv = null, _featForestCtx = null;
  let _featRoadDist = null, _featEdgeDist = null, _featInside = null;

  function ensureFeatScratch() {
    if (!_featRoadCv) {
      _featRoadCv = document.createElement('canvas');
      _featRoadCv.width = _featW;
      _featRoadCv.height = _featW;
      _featRoadCtx = _featRoadCv.getContext('2d', { willReadFrequently: true });

      _featForestCv = document.createElement('canvas');
      _featForestCv.width = _featW;
      _featForestCv.height = _featW;
      _featForestCtx = _featForestCv.getContext('2d', { willReadFrequently: true });

      const N = _featW * _featW;
      _featRoadDist = new Uint16Array(N);
      _featEdgeDist = new Uint16Array(N);
      _featInside = new Uint8Array(N);
    }
  }

  function matchFeatureRoadKind(k, typesMode) {
    if (typesMode === 'major') {
      return k === 'motorway' || k === 'trunk' || k === 'primary' || k === 'secondary' || k === 'tertiary';
    }
    if (typesMode === 'tracks') {
      return k === 'track' || k === 'path' || k === 'footway' || k === 'pedestrian' || k === 'cycleway' || k === 'bridleway';
    }
    if (typesMode === 'all') {
      return true;
    }
    // 'drive': автодороги и грунтовки (без мелких пешеходных троп)
    return k !== 'path' && k !== 'footway' && k !== 'pedestrian' && k !== 'cycleway' && k !== 'steps';
  }

  function runChamfer34(distArr, W) {
    const N = W * W;
    for (let y = 1; y < W; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        let d = distArr[i];
        if (d === 0) continue;
        const d1 = distArr[i - 1] + 3;
        const d2 = distArr[i - W] + 3;
        const d3 = distArr[i - W - 1] + 4;
        const d4 = distArr[i - W + 1] + 4;
        if (d1 < d) d = d1;
        if (d2 < d) d = d2;
        if (d3 < d) d = d3;
        if (d4 < d) d = d4;
        distArr[i] = d;
      }
    }
    for (let y = W - 2; y >= 0; y--) {
      const row = y * W;
      for (let x = W - 2; x >= 1; x--) {
        const i = row + x;
        let d = distArr[i];
        if (d === 0) continue;
        const d1 = distArr[i + 1] + 3;
        const d2 = distArr[i + W] + 3;
        const d3 = distArr[i + W + 1] + 4;
        const d4 = distArr[i + W - 1] + 4;
        if (d1 < d) d = d1;
        if (d2 < d) d = d2;
        if (d3 < d) d = d3;
        if (d4 < d) d = d4;
        distArr[i] = d;
      }
    }
    return N;
  }

  const featMaskCache = new Map();
  const featMaskInFlight = new Map();
  const FEAT_MASK_CACHE_MAX = 128;

  async function buildTerrainFeatureMask(coords, roadTypes = 'drive') {
    if (!coords || coords.z < MIN_NATIVE_ZOOM) return null;

    const key = `${coords.z}:${coords.x}:${coords.y}:${roadTypes}`;
    if (featMaskCache.has(key)) {
      const cached = featMaskCache.get(key);
      // Поднимаем запись в конец LRU
      featMaskCache.delete(key);
      featMaskCache.set(key, cached);
      return cached;
    }
    if (featMaskInFlight.has(key)) {
      return featMaskInFlight.get(key);
    }

    const task = (async () => {
      const zNat = Math.min(coords.z, MAX_NATIVE_ZOOM);
      const shift = coords.z - zNat;
      const subFactor = 1 << shift;
      const maxParent = 1 << zNat;
      const S_parent = _featCanvasSize * subFactor;

      const worldX0 = coords.x * _featCanvasSize - _featPad;
      const worldX1 = (coords.x + 1) * _featCanvasSize + _featPad;
      const worldY0 = coords.y * _featCanvasSize - _featPad;
      const worldY1 = (coords.y + 1) * _featCanvasSize + _featPad;

      const minPX = Math.floor(worldX0 / S_parent);
      const maxPX = Math.floor((worldX1 - 0.001) / S_parent);
      const minPY = Math.max(0, Math.floor(worldY0 / S_parent));
      const maxPY = Math.min(maxParent - 1, Math.floor((worldY1 - 0.001) / S_parent));

      const tileRequests = [];
      for (let py = minPY; py <= maxPY; py++) {
        for (let px = minPX; px <= maxPX; px++) {
          const wrappedPX = ((px % maxParent) + maxParent) % maxParent;
          tileRequests.push({ px, py, wrappedPX });
        }
      }

      let anyFailed = false;
      const loadedTiles = await Promise.all(
        tileRequests.map(req =>
          fetchMvtTile({ z: zNat, x: req.wrappedPX, y: req.py })
            .then(res => {
              if (!res) anyFailed = true;
              return (res && res.layers) ? { px: req.px, py: req.py, layers: res.layers } : null;
            })
            .catch(() => {
              anyFailed = true;
              return null;
            })
        )
      );

      ensureFeatScratch();
      const W = _featW;
      const N = W * W;
      const MAX_R = _featPad;
      const INF = 60000;

      _featRoadCtx.clearRect(0, 0, W, W);
      _featForestCtx.clearRect(0, 0, W, W);

      // 1. Растеризация дорог
      _featRoadCtx.strokeStyle = '#ffffff';
      _featRoadCtx.lineWidth = 1.25;
      _featRoadCtx.lineCap = 'round';
      _featRoadCtx.lineJoin = 'round';
      _featRoadCtx.beginPath();

      let hasAnyRoadGeom = false;
      let hasAnyForestGeom = false;

      for (let t = 0; t < loadedTiles.length; t++) {
        const item = loadedTiles[t];
        if (!item) continue;
        const originX = item.px * S_parent - worldX0;
        const originY = item.py * S_parent - worldY0;

        if (item.layers.streets && item.layers.streets.features.length) {
          const stLayer = item.layers.streets;
          const factor = S_parent / (stLayer.extent || 4096);
          const feats = stLayer.features;

          for (let i = 0; i < feats.length; i++) {
            const f = feats[i];
            const k = f.props.kind || 'unclassified';
            if (f.props.tunnel || f.props.rail || RAIL_KINDS.has(k)) continue;
            if (!matchFeatureRoadKind(k, roadTypes)) continue;

            for (let l = 0; l < f.geom.length; l++) {
              const line = f.geom[l];
              if (line.length < 4) continue;
              _featRoadCtx.moveTo(originX + line[0] * factor, originY + line[1] * factor);
              for (let p = 2; p < line.length; p += 2) {
                _featRoadCtx.lineTo(originX + line[p] * factor, originY + line[p + 1] * factor);
              }
              hasAnyRoadGeom = true;
            }
          }
        }

        if (item.layers.land && item.layers.land.features.length) {
          const landLayer = item.layers.land;
          const factor = S_parent / (landLayer.extent || 4096);
          const feats = landLayer.features;

          if (!hasAnyForestGeom) _featForestCtx.beginPath();
          for (let i = 0; i < feats.length; i++) {
            const f = feats[i];
            const k = f.props.kind;
            if (k !== 'forest' && k !== 'wood') continue;

            for (let l = 0; l < f.geom.length; l++) {
              const ring = f.geom[l];
              if (ring.length < 6) continue;
              _featForestCtx.moveTo(originX + ring[0] * factor, originY + ring[1] * factor);
              for (let p = 2; p < ring.length; p += 2) {
                _featForestCtx.lineTo(originX + ring[p] * factor, originY + ring[p + 1] * factor);
              }
              hasAnyForestGeom = true;
            }
          }
        }
      }

      if (hasAnyRoadGeom) _featRoadCtx.stroke();
      if (hasAnyForestGeom) {
        _featForestCtx.fillStyle = '#ffffff';
        _featForestCtx.fill();
      }

      // 2. Поле расстояний до дорог
      let hasRoadSeeds = false;
      if (hasAnyRoadGeom) {
        const rData = _featRoadCtx.getImageData(0, 0, W, W).data;
        for (let i = 0; i < N; i++) {
          if (rData[i * 4 + 3] > 48) {
            _featRoadDist[i] = 0;
            hasRoadSeeds = true;
          } else {
            _featRoadDist[i] = INF;
          }
        }
        if (hasRoadSeeds) runChamfer34(_featRoadDist, W);
      } else {
        _featRoadDist.fill(INF);
      }

      // 3. Поле расстояний до границ леса (опушек)
      let hasEdgeSeeds = false;
      if (hasAnyForestGeom) {
        const fData = _featForestCtx.getImageData(0, 0, W, W).data;
        for (let i = 0; i < N; i++) {
          _featInside[i] = fData[i * 4 + 3] > 127 ? 1 : 0;
        }
        _featEdgeDist.fill(INF);
        for (let y = 1; y < W - 1; y++) {
          const row = y * W;
          for (let x = 1; x < W - 1; x++) {
            const i = row + x;
            const v = _featInside[i];
            if (v !== _featInside[i - 1] || v !== _featInside[i + 1] ||
                v !== _featInside[i - W] || v !== _featInside[i + W]) {
              _featEdgeDist[i] = 0;
              hasEdgeSeeds = true;
            }
          }
        }
        if (hasEdgeSeeds) runChamfer34(_featEdgeDist, W);
      } else {
        _featInside.fill(0);
        _featEdgeDist.fill(INF);
      }

      if (!hasRoadSeeds && !hasEdgeSeeds && !hasAnyForestGeom) {
        if (!anyFailed) setLru(featMaskCache, key, null, FEAT_MASK_CACHE_MAX);
        return null;
      }

      // 4. Упаковка центральной области 128x128 в RGBA8
      const out = new Uint8Array(_featCanvasSize * _featCanvasSize * 4);
      const maxUnits = MAX_R * 3;
      for (let y = 0; y < _featCanvasSize; y++) {
        const sy = y + _featPad;
        const dstRow = y * _featCanvasSize;
        const srcRow = sy * W;
        for (let x = 0; x < _featCanvasSize; x++) {
          const si = srcRow + x + _featPad;
          const di = (dstRow + x) * 4;

          const rNorm = _featRoadDist[si] >= maxUnits ? 1.0 : (_featRoadDist[si] / maxUnits);
          const eNorm = _featEdgeDist[si] >= maxUnits ? 1.0 : (_featEdgeDist[si] / maxUnits);
          const bSmooth = (
            _featInside[si] * 2 +
            _featInside[si - 1] + _featInside[si + 1] +
            _featInside[si - W] + _featInside[si + W]
          ) / 6.0;

          out[di] = Math.round((1.0 - rNorm) * 255);
          out[di + 1] = Math.round((1.0 - eNorm) * 255);
          out[di + 2] = Math.round(bSmooth * 255);
          out[di + 3] = 255;
        }
      }

      const result = { data: out, size: _featCanvasSize, hasRoads: hasRoadSeeds, hasEdges: hasEdgeSeeds };
      if (!anyFailed) {
        setLru(featMaskCache, key, result, FEAT_MASK_CACHE_MAX);
      }
      return result;
    })();

    featMaskInFlight.set(key, task);
    try {
      return await task;
    } finally {
      featMaskInFlight.delete(key);
    }
  }

  function trimMemory(aggressive = false) {
    trimLru(tileCache, aggressive ? 12 : 24);
    trimLru(omtTileCache, aggressive ? 6 : 12);
    trimLru(roadSegmentsCache, aggressive ? 12 : 24);
    trimLru(riverDataCache, aggressive ? 12 : 24);
    trimLru(featMaskCache, aggressive ? 12 : 24);
    if (textWidthCache.size > 800) textWidthCache.clear();
    if (rgbaCache.size > 150) rgbaCache.clear();
    if (labelColorCache.size > 300) labelColorCache.clear();
  }

  WM.vectorRoads = {
    init(map) {
      initUI();
      applyVisibility();
      if (_initedMap !== map) {
        _initedMap = map;
        _lastCenterLightSig = getCenterLightSig();

        map.on('movestart zoomstart', () => {
          _isCameraMoving = true;
          clearTimeout(_resumeRenderTimer);
          if (_renderRaf) {
            cancelAnimationFrame(_renderRaf);
            _renderRaf = 0;
          }
        });

        map.on('zoomend', () => {
          globalLabelMgr.resetIfZoomChanged(Math.round(map.getZoom()));
        });

        map.on('moveend zoomend', () => {
          clearTimeout(_resumeRenderTimer);
          _resumeRenderTimer = setTimeout(() => {
            _isCameraMoving = false;
            if (_renderQueue.length && !_renderRaf) {
              _renderRaf = requestAnimationFrame(pumpRenderQueue);
            }
          }, 32);

          const sig = getCenterLightSig();
          if (sig !== _lastCenterLightSig) {
            _lastCenterLightSig = sig;
            onLightingChanged();
          }
        });
      }
      return layerInstance;
    },
    syncUI: syncHudUI,
    applyProfile,
    getLayer: () => layerInstance,
    getConfig: () => cfg,
    fetchMvtTile,
    buildTerrainFeatureMask,
    trimMemory,



    exportConfig,
    reloadMissingTiles: redrawLayer,
    importConfig,
    getTileRoadSegments,
    getTileRiverData,
    distSqPointToSeg,
    onLightingChanged,
    isEnabled: () => cfg.enabled,
    toggle() {
      cfg.enabled = !cfg.enabled;
      saveConfig();
      applyVisibility();
      return cfg.enabled;
    }
  };
})();