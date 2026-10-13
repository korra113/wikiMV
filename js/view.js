(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  let map, renderer; const shown = new Map(), hl = {};
  let activeTag = null; // { id, title }
  let isVectorVisible = true;
  let isZooming = false; // <-- ПЕРЕНЕСЕНО СЮДА

  const DEFAULT_STYLE = {
    color: '#f2ba5a',
    weight: 3.5,
    fillColor: '#fe8616',
    fillOpacity: 0.12,
    interactive: false,
    smoothFactor: 1.5
  };

  const TAG_HL_STYLE = {
    color: '#a855f7',
    weight: 3.5,
    fillColor: '#c084fc',
    fillOpacity: 0.45
  };

  const DEFAULT_HL = {
    hover: { color: '#fed50b', weight: 4, fillColor: '#fed50b', fillOpacity: 0.3, pane: 'wm-hl' },
    selected: { color: '#da541b', weight: 4, fillColor: '#da541b', fillOpacity: 0.28, pane: 'wm-sel' }
  };

  let STYLE = { ...DEFAULT_STYLE };
  let HL = {
    hover: { ...DEFAULT_HL.hover },
    selected: { ...DEFAULT_HL.selected }
  };

  // Пороговые значения площади в градусах² (~1 deg² ≈ 7-10 млрд м²)
  // SMALL_AREA_MAX ≈ до 25 000 м² (жилые дома, магазины, строения)
  // LARGE_AREA_MIN ≈ от 600 000 м² (крупные промзоны, парки, районы, города)
  const SMALL_AREA_MAX = 0.000005;
  const LARGE_AREA_MIN = 0.00012;

  let filters = {
    hideBuildings: false,
    hideRegions: false,
    hideDeleted: false,
    hideSmallDensity: true, // По умолчанию включено для плавной работы
    hideSmall: false,
    hideMedium: false,
    hideLarge: false
  };

  function loadStoredFilters() {
    try {
      if (WM.api && WM.api.store) {
        filters.hideBuildings = WM.api.store.get('wm_filter_hide_buildings') === 'true';
        filters.hideRegions = WM.api.store.get('wm_filter_hide_regions') === 'true';
        filters.hideDeleted = WM.api.store.get('wm_filter_hide_deleted') === 'true';
        filters.hideSmallDensity = WM.api.store.get('wm_filter_hide_small_density') !== 'false';
        filters.hideSmall = WM.api.store.get('wm_filter_hide_small') === 'true';
        filters.hideMedium = WM.api.store.get('wm_filter_hide_medium') === 'true';
        filters.hideLarge = WM.api.store.get('wm_filter_hide_large') === 'true';
      }
    } catch (e) {}
  }

  function getObjectSizeCategory(o) {
    if (!o) return 'small';
    if (o.is_region) return 'large';
    const area = o.area || 0;
    if (area < SMALL_AREA_MAX) return 'small';
    if (area >= LARGE_AREA_MIN) return 'large';
    return 'medium';
  }

  function isObjectAllowed(o) {
    if (!o) return false;
    if (filters.hideBuildings && o.is_building) return false;
    if (filters.hideRegions && o.is_region) return false;
    if (filters.hideDeleted && o.is_deleted) return false;

    const size = getObjectSizeCategory(o);
    if (filters.hideSmall && size === 'small') return false;
    if (filters.hideMedium && size === 'medium') return false;
    if (filters.hideLarge && size === 'large') return false;

    return true;
  }

  function loadStoredStyle() {
    try {
      const s = JSON.parse(WM.api.store.get('wm_style_vector') || '{}');
      if (s.color) STYLE.color = s.color;
      if (s.weight != null) STYLE.weight = +s.weight;
      if (s.fillColor) STYLE.fillColor = s.fillColor;
      if (s.fillOpacity != null) STYLE.fillOpacity = +s.fillOpacity;
      if (s.hoverColor) { HL.hover.color = s.hoverColor; HL.hover.fillColor = s.hoverColor; }
      if (s.selectedColor) { HL.selected.color = s.selectedColor; HL.selected.fillColor = s.selectedColor; }
    } catch (e) {}
  }

  // Кэш для предотвращения повторных математических расчетов цветов
  const desatCache = new Map();

  function desaturateColor(hex, factor = 0.4) {
    if (!hex || typeof hex !== 'string') return hex;
    const cacheKey = `${hex}_${factor}`;
    if (desatCache.has(cacheKey)) return desatCache.get(cacheKey);

    let c = hex.trim().replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    if (c.length !== 6) return hex;
    const num = parseInt(c, 16);
    let r = ((num >> 16) & 255) / 255;
    let g = ((num >> 8) & 255) / 255;
    let b = (num & 255) / 255;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    s = Math.max(0, Math.min(1, s * factor));

    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }

    let rOut, gOut, bOut;
    if (s === 0) {
      rOut = gOut = bOut = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      rOut = hue2rgb(p, q, h + 1/3);
      gOut = hue2rgb(p, q, h);
      bOut = hue2rgb(p, q, h - 1/3);
    }

    const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
    const res = `#${toHex(rOut)}${toHex(gOut)}${toHex(bOut)}`;
    if (desatCache.size > 200) desatCache.clear();
    desatCache.set(cacheKey, res);
    return res;
  }

  function objectMatchesTag(o, tag) {
    if (!o || !tag || !Array.isArray(o.tags)) return false;
    return o.tags.some(t => {
      if (tag.id && t.id && String(tag.id) === String(t.id)) return true;
      if (tag.title && t.title && t.title.toLowerCase() === tag.title.toLowerCase()) return true;
      return false;
    });
  }

  function computeStyleForObject(o, mapSize, degPerPx, cosLat) {
    const isTagMatched = activeTag && objectMatchesTag(o, activeTag);

    // На зумах 18+ полностью отключаем упрощение (0), на обзорных зумах оставляем сглаживание (1.5)
    const smoothFactor = (map && map.getZoom() >= 18) ? 0 : 1.5;

    if (isTagMatched) {
      return { ...TAG_HL_STYLE, interactive: false, smoothFactor, _k: 'tag' };
    }

    const wpx = (o.bbox.e - o.bbox.w) / degPerPx;
    const hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;
    const maxRatio = Math.max(wpx / mapSize.x, hpx / mapSize.y);

    if (o.customColor) {
      let fillOpacity = 0.35;
      if (maxRatio > 1.2) fillOpacity = 0.05;
      else if (maxRatio > 0.6) fillOpacity = 0.12;
      else if (maxRatio > 0.35) fillOpacity = 0.22;

      return {
        color: o.customColor,
        weight: Math.max(2, STYLE.weight),
        fillColor: o.customColor,
        fillOpacity,
        interactive: false,
        smoothFactor, // <-- подставляем динамический smoothFactor
        _k: `c_${o.customColor}_${fillOpacity}`
      };
    }

    // Фиксируем дискретные уровни прозрачности вместо постоянных расчётов fillOpacity.toFixed(3)
    const isVisited = !!o.isVisited;
    const baseColor = isVisited ? desaturateColor(STYLE.color, 0.55) : STYLE.color;
    const baseFillColor = isVisited ? desaturateColor(STYLE.fillColor, 0.4) : STYLE.fillColor;
    const baseWeight = isVisited ? Math.max(1, STYLE.weight * 0.9) : STYLE.weight;

    // Ключ стиля теперь стабилен и зависит ТОЛЬКО от состояния объекта, а не от зума карты!
    const styleKey = o.customColor 
      ? `c_${o.customColor}` 
      : `s_${isVisited}_${baseColor}_${baseFillColor}_${baseWeight}`;

    return {
      color: o.customColor || baseColor,
      weight: o.customColor ? Math.max(2, STYLE.weight) : baseWeight,
      fillColor: o.customColor || baseFillColor,
      fillOpacity: isVisited ? STYLE.fillOpacity * 0.85 : STYLE.fillOpacity,
      interactive: false,
      smoothFactor, // <-- подставляем динамический smoothFactor
      _k: styleKey
    };
  }

  function setHl(kind, obj) {
    const h = hl[kind] || (hl[kind] = { poly: null, id: null });
    if (!obj) { 
      if (h.poly) { map.removeLayer(h.poly); h.poly = null; h.id = null; } 
      return; 
    }
    if (h.id === obj.id && h.poly) return;
    if (h.poly) map.removeLayer(h.poly);
    
    h.poly = L.polygon(obj.pts, { 
      ...HL[kind], 
      renderer, 
      interactive: false 
    }).addTo(map);
    
    h.id = obj.id;
  }



  WM.view = {
    init(m) {
      map = m;
      loadStoredStyle();
      loadStoredFilters();
      map.createPane('wm-base').style.zIndex = 420;
      map.createPane('wm-hl').style.zIndex = 450;
      map.createPane('wm-sel').style.zIndex = 460;
      
      // Отключаем лишний padding для Canvas на больших зумах — экономит до 40% пикселей рендера
      renderer = L.canvas({ pane: 'wm-base', padding: 0.1 });

      map.on('zoomstart', () => { 
        isZooming = true;
      });

      map.on('zoomend', () => {
        isZooming = false;
        // Синхронный вызов НЕ делаем, событие moveend само вызовет scheduleRender()
      });
    },

    render() {
      if (!map || !isVectorVisible || isZooming) return;

      const zoom = map.getZoom();
      const degPerPx = 360 / (256 * 2 ** zoom);
      const b = map.getBounds().pad(zoom >= 17 ? 0.1 : (C.VIEW_PAD || 0.25));
      const vw = b.getWest(), vs = b.getSouth(), ve = b.getEast(), vn = b.getNorth();
      const cosLat = Math.cos(map.getCenter().lat * Math.PI / 180) || 1;
      const mapSize = map.getSize();

      let vis = [];
      const candidates = WM.cache.queryBBox 
        ? WM.cache.queryBBox({ w: vw, s: vs, e: ve, n: vn }) 
        : WM.cache.objects.values();

      for (let i = 0; i < candidates.length; i++) {
        const o = candidates[i];
        if (!isObjectAllowed(o)) continue;
        const ob = o.bbox;
        if (ob.w > ve || ob.e < vw || ob.s > vn || ob.n < vs) continue;

        const wpx = (ob.e - ob.w) / degPerPx;
        const hpx = (ob.n - ob.s) / cosLat / degPerPx;

        // На зумах 17+ отсекаем полигоны шире 1.5 экранов — их отрисовка в Canvas забирает сотни миллисекунд
        if (zoom >= 17 && (wpx > mapSize.x * 1.5 || hpx > mapSize.y * 1.5)) {
          continue;
        }

        const maxPx = wpx > hpx ? wpx : hpx;
        if (maxPx >= (C.MIN_PX || 6)) {
          vis.push({ o, maxPx });
        }
      }

      // Лимит полигонов на сверхдетальных масштабах
      const maxRendered = zoom >= 19 ? 120 : (zoom >= 17 ? 250 : (C.MAX_RENDERED || 1200));
      if (vis.length > maxRendered) {
        vis.sort((a, b) => (b.o.area || 0) - (a.o.area || 0));
        vis = vis.slice(0, maxRendered);
      }

      const keep = new Set();
      for (let i = 0; i < vis.length; i++) {
        keep.add(vis[i].o.id);
      }

      // 1. Сначала удаляем полигоны, вышедшие за экран
      for (const [id, s] of shown) {
        if (!keep.has(id)) { 
          map.removeLayer(s.poly); 
          shown.delete(id); 
        }
      }

      // 2. Отрисовываем / добавляем оставшиеся
      for (let i = 0; i < vis.length; i++) {
        const o = vis[i].o;
        const style = computeStyleForObject(o, mapSize, degPerPx, cosLat);
        const existing = shown.get(o.id);

        if (!existing) {
          shown.set(o.id, { 
            obj: o, 
            styleKey: style._k,
            poly: L.polygon(o.pts, { ...style, renderer }).addTo(map) 
          });
        } else if (existing.styleKey !== style._k) {
          existing.styleKey = style._k;
          existing.poly.setStyle(style);
        }
      }

      if (activeTag && WM.ui && WM.ui.updateTagFilterHUD) {
        const matches = vis.filter(item => objectMatchesTag(item.o, activeTag)).length;
        WM.ui.updateTagFilterHUD(activeTag, matches);
      }
    },
    setVisible(visible) {
      isVectorVisible = !!visible;
      if (!isVectorVisible) {
        for (const [id, s] of shown) {
          map.removeLayer(s.poly);
        }
        shown.clear();
        if (hl.hover && hl.hover.poly) { map.removeLayer(hl.hover.poly); hl.hover.poly = null; hl.hover.id = null; }
        if (hl.selected && hl.selected.poly) { map.removeLayer(hl.selected.poly); hl.selected.poly = null; hl.selected.id = null; }
      } else {
        this.render();
      }
    },
    isVectorVisible() { return isVectorVisible; },
    updateObjectStyle(id) {
      const s = shown.get(id);
      if (s && map) {
        if (!isObjectAllowed(s.obj)) {
          map.removeLayer(s.poly);
          shown.delete(id);
          return;
        }
        const zoom = map.getZoom(), degPerPx = 360 / (256 * 2 ** zoom);
        const cosLat = Math.cos(map.getCenter().lat * Math.PI / 180) || 1;
        const style = computeStyleForObject(s.obj, map.getSize(), degPerPx, cosLat);
        s.styleKey = style._k;
        s.poly.setStyle(style);
      }
    },
    toggleTagFilter(tag) {
      if (WM.loader && WM.loader.resetTagBbox) WM.loader.resetTagBbox();
      if (activeTag && (activeTag.title === tag.title || (activeTag.id && activeTag.id === tag.id))) {
        activeTag = null;
        if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(null);
      } else {
        activeTag = tag;
        if (WM.loader && WM.loader.fetchCategoryInBounds) {
          WM.loader.fetchCategoryInBounds(tag);
        }
      }
      this.render();
    },
    getActiveTag() { return activeTag; },
    clearTagFilter() {
      activeTag = null;
      if (WM.loader && WM.loader.resetTagBbox) WM.loader.resetTagBbox();
      if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(null);
      this.render();
    },
    shownObjects() { return [...shown.values()].map(s => s.obj); },
    count() { return shown.size; },
    setHover: o => setHl('hover', o),
    setSelected: o => setHl('selected', o),
    applyVectorStyle(cfg) {
      desatCache.clear();
      if (cfg.color) STYLE.color = cfg.color;
      if (cfg.weight != null) STYLE.weight = +cfg.weight;
      if (cfg.fillColor) STYLE.fillColor = cfg.fillColor;
      if (cfg.fillOpacity != null) STYLE.fillOpacity = +cfg.fillOpacity;
      if (cfg.hoverColor) { HL.hover.color = cfg.hoverColor; HL.hover.fillColor = cfg.hoverColor; }
      if (cfg.selectedColor) { HL.selected.color = cfg.selectedColor; HL.selected.fillColor = cfg.selectedColor; }
      this.render();
    },
    getVectorStyle() { return { ...STYLE, hoverColor: HL.hover.color, selectedColor: HL.selected.color }; },
    getDefaultVectorStyle() { return { ...DEFAULT_STYLE, hoverColor: DEFAULT_HL.hover.color, selectedColor: DEFAULT_HL.selected.color }; },
    
    isObjectAllowed,
    getObjectSizeCategory,
    setFilters(f) {
      if (f.hideBuildings !== undefined) {
        filters.hideBuildings = !!f.hideBuildings;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_buildings', filters.hideBuildings ? 'true' : 'false');
      }
      if (f.hideRegions !== undefined) {
        filters.hideRegions = !!f.hideRegions;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_regions', filters.hideRegions ? 'true' : 'false');
      }
      if (f.hideDeleted !== undefined) {
        filters.hideDeleted = !!f.hideDeleted;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_deleted', filters.hideDeleted ? 'true' : 'false');
      }
      if (f.hideSmallDensity !== undefined) {
        filters.hideSmallDensity = !!f.hideSmallDensity;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_small_density', filters.hideSmallDensity ? 'true' : 'false');
      }
      if (f.hideSmall !== undefined) {
        filters.hideSmall = !!f.hideSmall;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_small', filters.hideSmall ? 'true' : 'false');
      }
      if (f.hideMedium !== undefined) {
        filters.hideMedium = !!f.hideMedium;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_medium', filters.hideMedium ? 'true' : 'false');
      }
      if (f.hideLarge !== undefined) {
        filters.hideLarge = !!f.hideLarge;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_hide_large', filters.hideLarge ? 'true' : 'false');
      }

      if (hl.hover && hl.hover.id) {
        const ho = WM.cache && WM.cache.objects.get(hl.hover.id);
        if (ho && !isObjectAllowed(ho)) setHl('hover', null);
      }
      if (hl.selected && hl.selected.id) {
        const so = WM.cache && WM.cache.objects.get(hl.selected.id);
        if (so && !isObjectAllowed(so)) setHl('selected', null);
      }

      this.render();
    },
    getFilters() {
      return { ...filters };
    }
  };
})();