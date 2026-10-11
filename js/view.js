(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  let map, renderer; const shown = new Map(), hl = {};
  let activeTag = null; // { id, title }

  const DEFAULT_STYLE = {
    color: '#f97316',
    weight: 1.5,
    fillColor: '#fb923c',
    fillOpacity: 0.18,
    interactive: false,
    smoothFactor: 1.5
  };

  // Стиль подсветки объектов по выбранному тегу
  const TAG_HL_STYLE = {
    color: '#a855f7',
    weight: 3.5,
    fillColor: '#c084fc',
    fillOpacity: 0.45
  };

  const DEFAULT_HL = {
    hover: { color: '#facc15', weight: 4, fillColor: '#facc15', fillOpacity: 0.3, pane: 'wm-hl' },
    selected: { color: '#ef4444', weight: 4, fillColor: '#ef4444', fillOpacity: 0.28, pane: 'wm-sel' }
  };

  let STYLE = { ...DEFAULT_STYLE };
  let HL = {
    hover: { ...DEFAULT_HL.hover },
    selected: { ...DEFAULT_HL.selected }
  };

  // --- Состояние фильтров типов объектов ---
  let filters = {
    hideBuildings: false,
    hideRegions: false,
    hideDeleted: false
  };

  function loadStoredFilters() {
    try {
      if (WM.api && WM.api.store) {
        filters.hideBuildings = WM.api.store.get('wm_filter_hide_buildings') === 'true';
        filters.hideRegions = WM.api.store.get('wm_filter_hide_regions') === 'true';
        filters.hideDeleted = WM.api.store.get('wm_filter_hide_deleted') === 'true';
      }
    } catch (e) {}
  }

  function isObjectAllowed(o) {
    if (!o) return false;
    if (filters.hideBuildings && o.is_building) return false;
    if (filters.hideRegions && o.is_region) return false;
    if (filters.hideDeleted && o.is_deleted) return false;
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

  // Преобразование HEX цвета в цвет с пониженной насыщенностью
  function desaturateColor(hex, factor = 0.4) {
    if (!hex || typeof hex !== 'string') return hex;
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
    return `#${toHex(rOut)}${toHex(gOut)}${toHex(bOut)}`;
  }

  function objectMatchesTag(o, tag) {
    if (!o || !tag || !Array.isArray(o.tags)) return false;
    return o.tags.some(t => {
      if (tag.id && t.id && String(tag.id) === String(t.id)) return true;
      if (tag.title && t.title && t.title.toLowerCase() === tag.title.toLowerCase()) return true;
      return false;
    });
  }

  // Расчёт стиля полигона с учётом тегов, уникального цвета и просмотренного статуса
  function computeStyleForObject(o, mapSize, degPerPx, cosLat) {
    const isTagMatched = activeTag && objectMatchesTag(o, activeTag);
    if (isTagMatched) {
      return { ...TAG_HL_STYLE, interactive: false, smoothFactor: 1.5 };
    }

    const wpx = (o.bbox.e - o.bbox.w) / degPerPx;
    const hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;
    const maxRatio = Math.max(wpx / mapSize.x, hpx / mapSize.y);

    // 1. Индивидуальный цвет, заданный пользователем вручную
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
        smoothFactor: 1.5
      };
    }

    // 2. Базовый или просмотренный (десатурированный от базового)
    const isVisited = !!o.hasDetail;
    const baseColor = isVisited ? desaturateColor(STYLE.color, 0.55) : STYLE.color;
    const baseFillColor = isVisited ? desaturateColor(STYLE.fillColor, 0.4) : STYLE.fillColor;
    const baseWeight = isVisited ? Math.max(1, STYLE.weight * 0.9) : STYLE.weight;
    let fillOpacity = isVisited ? STYLE.fillOpacity * 0.85 : STYLE.fillOpacity;

    // Плавное снижение прозрачности фона гигантских полигонов
    if (maxRatio > 1.2) {
      fillOpacity = Math.min(fillOpacity * 0.15, 0.025);
    } else if (maxRatio > 0.6) {
      fillOpacity = Math.min(fillOpacity * 0.35, 0.06);
    } else if (maxRatio > 0.35) {
      fillOpacity = Math.min(fillOpacity * 0.65, 0.10);
    }

    return {
      color: baseColor,
      weight: baseWeight,
      fillColor: baseFillColor,
      fillOpacity,
      interactive: false,
      smoothFactor: 1.5
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
      renderer = L.canvas({ pane: 'wm-base', padding: 0.5 });
    },
    render() {
      const zoom = map.getZoom(), degPerPx = 360 / (256 * 2 ** zoom);
      const b = map.getBounds().pad(C.VIEW_PAD);
      const vb = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
      const cosLat = Math.cos(map.getCenter().lat * Math.PI / 180) || 1;
      const mapSize = map.getSize();

      let vis = [];
      for (const o of WM.cache.objects.values()) {
        if (!isObjectAllowed(o)) continue;
        if (!G.intersects(o.bbox, vb)) continue;
        const wpx = (o.bbox.e - o.bbox.w) / degPerPx, hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;
        if (Math.max(wpx, hpx) >= C.MIN_PX) vis.push(o);
      }
      if (vis.length > C.MAX_RENDERED) vis = vis.sort((a, b) => b.area - a.area).slice(0, C.MAX_RENDERED);
      
      const keep = new Set(vis.map(o => o.id));
      for (const [id, s] of shown) {
        if (!keep.has(id)) { 
          map.removeLayer(s.poly); 
          shown.delete(id); 
        }
      }
      
      for (const o of vis) {
        const style = computeStyleForObject(o, mapSize, degPerPx, cosLat);
        const existing = shown.get(o.id);
        if (!existing) {
          shown.set(o.id, { obj: o, poly: L.polygon(o.pts, { ...style, renderer }).addTo(map) });
        } else {
          existing.poly.setStyle(style);
        }
      }

      if (activeTag && WM.ui && WM.ui.updateTagFilterHUD) {
        const matches = vis.filter(o => objectMatchesTag(o, activeTag)).length;
        WM.ui.updateTagFilterHUD(activeTag, matches);
      }
    },
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
        s.poly.setStyle(computeStyleForObject(s.obj, map.getSize(), degPerPx, cosLat));
      }
    },
    toggleTagFilter(tag) {
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
      if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(null);
      this.render();
    },
    shownObjects() { return [...shown.values()].map(s => s.obj); },
    count() { return shown.size; },
    setHover: o => setHl('hover', o),
    setSelected: o => setHl('selected', o),
    applyVectorStyle(cfg) {
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
    
    // --- Методы работы с фильтрами типов объектов ---
    isObjectAllowed,
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

      // Снимаем подсветку/выделение, если объект оказался в списке скрытых
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