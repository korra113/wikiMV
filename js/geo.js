(function () {
  const WM = window.WM, D = 180 / Math.PI;
  const lon2x = (lon, n) => Math.floor((lon + 180) / 360 * n);
  const lat2y = (lat, n) => {
    lat = Math.max(-85.05, Math.min(85.05, lat)); const r = lat / D;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  const x2lon = (x, n) => x / n * 360 - 180;
  const y2lat = (y, n) => D * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / n));

  WM.geo = {
    tileBBox(x, y, z) { const n = 2 ** z; return { w: x2lon(x, n), e: x2lon(x + 1, n), n: y2lat(y, n), s: y2lat(y + 1, n) }; },
    // Плитки, покрывающие bounds {w,s,e,n}, отсортированные от центра; не более max
    tilesFor(b, z, max) {
      const n = 2 ** z, cl = v => Math.max(0, Math.min(n - 1, v));
      const x0 = cl(lon2x(b.w, n)), x1 = cl(lon2x(b.e, n)), y0 = cl(lat2y(b.n, n)), y1 = cl(lat2y(b.s, n));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, out = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
        out.push({ x, y, z, key: z + '/' + x + '/' + y, d: (x - cx) ** 2 + (y - cy) ** 2 });
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, max);
    },
    bboxOf(pts) {
      let w = 180, e = -180, s = 90, n = -90;
      for (const p of pts) { if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; }
      return { w, s, e, n };
    },
    areaOf(pts) {
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][1] * pts[i][0] - pts[i][1] * pts[j][0];
      return Math.abs(a / 2);
    },
    intersects(a, b) { return a.w <= b.e && a.e >= b.w && a.s <= b.n && a.n >= b.s; },
    pointInPoly(lat, lng, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
        if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    // расстояние (в пикселях) от точки до контура; proj: [lat,lng] -> {x,y}
    distToEdge(p, pts, proj) {
      let best = Infinity, prev = proj(pts[pts.length - 1]);
      for (const q of pts) {
        const c = proj(q), dx = c.x - prev.x, dy = c.y - prev.y, l2 = dx * dx + dy * dy;
        let t = l2 ? ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p.x - (prev.x + t * dx), p.y - (prev.y + t * dy));
        if (d < best) best = d; prev = c;
      }
      return best;
    },

    // ПАРСЕР КООРДИНАТ ИЗ ТЕКСТА И ССЫЛОК
    // =========================================================================
    parseCoordinates(rawInput) {
      if (!rawInput || typeof rawInput !== 'string') return null;
      let str = rawInput.trim();
      if (str.length < 3) return null;

      // Раскодирование URL-encoded сущностей (%20, %2C, %3A...)
      if (/%[0-9a-fA-F]{2}/.test(str)) {
        try { str = decodeURIComponent(str); } catch (e) {}
        try { str = decodeURIComponent(str); } catch (e) {}
      }

      function isValid(lat, lon) {
        return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      }

      // -----------------------------------------------------------------------
      // 1. ПАРСИНГ ССЫЛОК И URI
      // -----------------------------------------------------------------------
      const isUrlLike = /(?:https?:\/\/|geo:|yandex|google|openstreetmap|wikimapia|etomesto|retromap|2gis)/i.test(str);
      if (isUrlLike) {
        // geo: URI
        let m = str.match(/geo:(?:0(?:(?:\.0+)?)?,0(?:(?:\.0+)?)?\?q=)?([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'geo: URI', source: 'geo URI', desc: 'Координаты из geo-ссылки' };
        }

        // Яндекс Карты (ll, pt, whatshere[point] имеют порядок ДОЛГОТА, ШИРОТА!)
        if (/yandex\.[a-z]{2,3}\/maps/i.test(str) || /maps\.yandex\./i.test(str)) {
          m = str.match(/(?:ll|pt|whatshere\[point\])=([+-]?\d+(?:\.\d+)?)[,%2C\s]+([+-]?\d+(?:\.\d+)?)/i);
          if (m) {
            const lon = parseFloat(m[1]), lat = parseFloat(m[2]);
            if (isValid(lat, lon)) return { lat, lon, format: 'Яндекс Карты', source: 'Яндекс', desc: 'Точка из Яндекс Карт' };
          }
          m = str.match(/text=([+-]?\d+(?:\.\d+)?)[,%2C\s+]+([+-]?\d+(?:\.\d+)?)/i);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (isValid(lat, lon)) return { lat, lon, format: 'Яндекс Карты', source: 'Яндекс', desc: 'Поиск Яндекс Карт' };
          }
        }

        // Google Maps
        if (/google\.[a-z.]+\/maps/i.test(str) || /maps\.google\./i.test(str) || /goo\.gl\/maps/i.test(str)) {
          m = str.match(/@([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (isValid(lat, lon)) return { lat, lon, format: 'Google Maps', source: 'Google', desc: 'Центр экрана Google Maps' };
          }
          m = str.match(/(?:q|query|destination)=([+-]?\d+(?:\.\d+)?)[,%2C+]+([+-]?\d+(?:\.\d+)?)/i);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (isValid(lat, lon)) return { lat, lon, format: 'Google Maps', source: 'Google', desc: 'Точка назначения Google Maps' };
          }
          m = str.match(/place\/([+-]?\d+(?:\.\d+)?)[,%2C+]+([+-]?\d+(?:\.\d+)?)/i);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (isValid(lat, lon)) return { lat, lon, format: 'Google Maps', source: 'Google', desc: 'Место из Google Maps' };
          }
          // DMS внутри пути Google: /place/55°45'06.5"N+37°37'04.3"E/
          m = str.match(/place\/([^/]+)/i);
          if (m) {
            const sub = WM.geo.parseCoordinates(m[1].replace(/\+/g, ' '));
            if (sub) {
              sub.format = 'Google Maps (DMS)';
              sub.desc = 'Место из ссылки Google Maps';
              return sub;
            }
          }
        }

        // OpenStreetMap
        m = str.match(/#map=\d+\/([+-]?\d+(?:\.\d+)?)\/([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'OpenStreetMap', source: 'OSM', desc: 'Координаты из OpenStreetMap' };
        }
        m = str.match(/mlat=([+-]?\d+(?:\.\d+)?)&mlon=([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'OpenStreetMap', source: 'OSM', desc: 'Метка из OpenStreetMap' };
        }

        // Wikimapia
        m = str.match(/lat=([+-]?\d+(?:\.\d+)?)&lon=([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'Wikimapia', source: 'Wikimapia', desc: 'Координаты из Wikimapia' };
        }

        // ЭтоМесто
        m = str.match(/[?&]y=([+-]?\d+(?:\.\d+)?)&x=([+-]?\d+(?:\.\d+)?)/i);
        if (!m) m = str.match(/[?&]x=([+-]?\d+(?:\.\d+)?)&y=([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const isYFirst = str.indexOf('y=') < str.indexOf('x=');
          const lat = parseFloat(isYFirst ? m[1] : m[2]);
          const lon = parseFloat(isYFirst ? m[2] : m[1]);
          if (isValid(lat, lon)) return { lat, lon, format: 'ЭтоМесто', source: 'ЭтоМесто', desc: 'Координаты с сайта ЭтоМесто' };
        }

        // RetroMap
        m = str.match(/_([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/i);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'RetroMap', source: 'RetroMap', desc: 'Координаты из RetroMap' };
        }

        // 2GIS (обычно долгота, широта)
        if (/2gis\.[a-z]{2,3}/i.test(str)) {
          m = str.match(/(?:geo|points|center)\/([+-]?\d+(?:\.\d+)?)[,%2C\s]+([+-]?\d+(?:\.\d+)?)/i);
          if (m) {
            let lon = parseFloat(m[1]), lat = parseFloat(m[2]);
            if (!isValid(lat, lon) && isValid(lon, lat)) {
              const tmp = lat; lat = lon; lon = tmp;
            }
            if (isValid(lat, lon)) return { lat, lon, format: '2GIS', source: '2GIS', desc: 'Координаты из 2GIS' };
          }
        }

        // Любая ссылка с парой чисел
        m = str.match(/([+-]?\d{1,2}\.\d{4,})[,/_\s]+([+-]?\d{1,3}\.\d{4,})/);
        if (m) {
          const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
          if (isValid(lat, lon)) return { lat, lon, format: 'Ссылка', source: 'URL', desc: 'Координаты из ссылки' };
        }
      }

      // -----------------------------------------------------------------------
      // 2. ТЕКСТОВЫЕ КООРДИНАТЫ (DMS, DDM, DD)
      // -----------------------------------------------------------------------
      // Нормализация кавычек и русских сторон света
      let clean = str
        .replace(/[′’‘´]/g, "'")
        .replace(/[″”«»“]/g, '"')
        .replace(/с\.?\s*ш\.?/gi, ' N ')
        .replace(/ю\.?\s*ш\.?/gi, ' S ')
        .replace(/в\.?\s*д\.?/gi, ' E ')
        .replace(/з\.?\s*д\.?/gi, ' W ')
        .replace(/(?<=\d|\b)[°\s]*(?:с|c)(?=\b|[\s,;]|$)/gi, ' N ')
        .replace(/(?<=\d|\b)[°\s]*(?:ю)(?=\b|[\s,;]|$)/gi, ' S ')
        .replace(/(?<=\d|\b)[°\s]*(?:в)(?=\b|[\s,;]|$)/gi, ' E ')
        .replace(/(?<=\d|\b)[°\s]*(?:з)(?=\b|[\s,;]|$)/gi, ' W ')
        .replace(/[,;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Вспомогательная функция парсинга отдельных блоков DMS / DDM
      const dmsRegex = /([NSEW])?\s*(\d{1,3})[°d\s]+(\d{1,2})['m\s]+(\d{1,2}(?:[.,]\d+)?)(?:["s\s]+)?([NSEW])?/gi;
      const dmsMatches = [...clean.matchAll(dmsRegex)];

      if (dmsMatches.length >= 2) {
        function calcDms(m) {
          const dir = (m[1] || m[5] || '').toUpperCase();
          const deg = parseFloat(m[2]);
          const min = parseFloat(m[3]);
          const sec = parseFloat(m[4].replace(',', '.'));
          let val = deg + (min / 60) + (sec / 3600);
          if (dir === 'S' || dir === 'W') val = -val;
          return { val, dir };
        }
        const p1 = calcDms(dmsMatches[0]);
        const p2 = calcDms(dmsMatches[1]);

        let lat, lon;
        if (p1.dir === 'E' || p1.dir === 'W' || p2.dir === 'N' || p2.dir === 'S') {
          lat = p2.val; lon = p1.val;
        } else {
          lat = p1.val; lon = p2.val;
        }

        if (isValid(lat, lon)) {
          return { lat, lon, format: 'DMS', source: 'DMS', desc: 'Градусы, минуты, секунды' };
        }
      }

      // Градусы и десятичные минуты: DDM (например: 55° 45.074' N 37° 37.105' E)
      const ddmRegex = /([NSEW])?\s*(\d{1,3})[°d\s]+(\d{1,2}(?:[.,]\d+)?)(?:['m\s]+)?([NSEW])?/gi;
      const ddmMatches = [...clean.matchAll(ddmRegex)];

      if (ddmMatches.length >= 2) {
        function calcDdm(m) {
          const dir = (m[1] || m[4] || '').toUpperCase();
          const deg = parseFloat(m[2]);
          const min = parseFloat(m[3].replace(',', '.'));
          let val = deg + (min / 60);
          if (dir === 'S' || dir === 'W') val = -val;
          return { val, dir };
        }
        const p1 = calcDdm(ddmMatches[0]);
        const p2 = calcDdm(ddmMatches[1]);

        let lat, lon;
        if (p1.dir === 'E' || p1.dir === 'W' || p2.dir === 'N' || p2.dir === 'S') {
          lat = p2.val; lon = p1.val;
        } else {
          lat = p1.val; lon = p2.val;
        }

        if (isValid(lat, lon)) {
          return { lat, lon, format: 'DDM', source: 'DDM', desc: 'Градусы и десятичные минуты' };
        }
      }

      // Десятичные градусы (DD): 55.75124 37.61842 или N55.75124 E37.61842
      // Поддержка запятой как разделителя дроби: 55,75124 37,61842
      const ddRegex = /([NSEW])?\s*([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([NSEW])?/gi;
      const ddMatches = [...clean.matchAll(ddRegex)].filter(m => !isNaN(parseFloat(m[2].replace(',', '.'))));

      if (ddMatches.length >= 2) {
        function calcDd(m) {
          const dir = (m[1] || m[3] || '').toUpperCase();
          let val = parseFloat(m[2].replace(',', '.'));
          if (dir === 'S' || dir === 'W') val = -Math.abs(val);
          else if (dir === 'N' || dir === 'E') val = Math.abs(val);
          return { val, dir };
        }
        const p1 = calcDd(ddMatches[0]);
        const p2 = calcDd(ddMatches[1]);

        let lat, lon;
        let isSwapped = false;

        if (p1.dir === 'E' || p1.dir === 'W' || p2.dir === 'N' || p2.dir === 'S') {
          lat = p2.val; lon = p1.val;
        } else {
          lat = p1.val; lon = p2.val;
          // Автоопределение: если первое число > 90, а второе <= 90 -> порядок Долгота, Широта
          if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
            const tmp = lat; lat = lon; lon = tmp;
            isSwapped = true;
          }
        }

        if (isValid(lat, lon)) {
          return { 
            lat, 
            lon, 
            format: 'DD', 
            source: 'DD', 
            desc: isSwapped ? 'Десятичные градусы (порядок: Lon, Lat)' : 'Десятичные градусы' 
          };
        }
      }

      return null;
    }
  };
})();
