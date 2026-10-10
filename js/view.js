(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  let map, renderer; const shown = new Map(), hl = {};

  const DEFAULT_STYLE = {
    color: '#f97316',
    weight: 1.5,
    fillColor: '#fb923c',
    fillOpacity: 0.18,
    interactive: false,
    smoothFactor: 1.5
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

  function loadStoredStyle() {
    try {
      const s = JSON.parse(WM.api.store.get('wm_style_vector') || '{}');
      if (s.color) STYLE.color = s.color;
      if (s.weight != null) STYLE.weight = +s.weight;
      if (s.fillColor) STYLE.fillColor = s.fillColor;
      if (s.fillOpacity != null) STYLE.fillOpacity = +s.fillOpacity;
      if (s.hoverColor) {
        HL.hover.color = s.hoverColor;
        HL.hover.fillColor = s.hoverColor;
      }
      if (s.selectedColor) {
        HL.selected.color = s.selectedColor;
        HL.selected.fillColor = s.selectedColor;
      }
    } catch (e) {}
  }

  function applyVectorStyle(cfg) {
    if (cfg.color) STYLE.color = cfg.color;
    if (cfg.weight != null) STYLE.weight = +cfg.weight;
    if (cfg.fillColor) STYLE.fillColor = cfg.fillColor;
    if (cfg.fillOpacity != null) STYLE.fillOpacity = +cfg.fillOpacity;
    if (cfg.hoverColor) {
      HL.hover.color = cfg.hoverColor;
      HL.hover.fillColor = cfg.hoverColor;
    }
    if (cfg.selectedColor) {
      HL.selected.color = cfg.selectedColor;
      HL.selected.fillColor = cfg.selectedColor;
    }

    // Обновляем уже отображаемые полигоны без очистки кэша
    for (const s of shown.values()) {
      s.poly.setStyle(STYLE);
    }
    if (hl.hover && hl.hover.poly) hl.hover.poly.setStyle(HL.hover);
    if (hl.selected && hl.selected.poly) hl.selected.poly.setStyle(HL.selected);
  }

  function setHl(kind, obj) {
    const h = hl[kind] || (hl[kind] = { poly: null, id: null });
    if (!obj) { 
      if (h.poly) { map.removeLayer(h.poly); h.poly = null; h.id = null; } 
      return; 
    }
    if (h.id === obj.id && h.poly) return;
    if (h.poly) map.removeLayer(h.poly);
    
    // Указываем renderer, чтобы подсветка не создавала отдельный SVG
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
      let vis = [];
      for (const o of WM.cache.objects.values()) {
        if (!G.intersects(o.bbox, vb)) continue;
        const wpx = (o.bbox.e - o.bbox.w) / degPerPx, hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;
        if (Math.max(wpx, hpx) >= C.MIN_PX) vis.push(o);
      }
      if (vis.length > C.MAX_RENDERED) vis = vis.sort((a, b) => b.area - a.area).slice(0, C.MAX_RENDERED);
      const keep = new Set(vis.map(o => o.id));
      for (const [id, s] of shown) if (!keep.has(id)) { map.removeLayer(s.poly); shown.delete(id); }
      for (const o of vis) if (!shown.has(o.id)) shown.set(o.id, { obj: o, poly: L.polygon(o.pts, { ...STYLE, renderer }).addTo(map) });
    },
    shownObjects() { return [...shown.values()].map(s => s.obj); },
    count() { return shown.size; },
    setHover: o => setHl('hover', o),
    setSelected: o => setHl('selected', o),
    applyVectorStyle,
    getVectorStyle() {
      return {
        color: STYLE.color,
        weight: STYLE.weight,
        fillColor: STYLE.fillColor,
        fillOpacity: STYLE.fillOpacity,
        hoverColor: HL.hover.color,
        selectedColor: HL.selected.color
      };
    },
    getDefaultVectorStyle() {
      return {
        color: DEFAULT_STYLE.color,
        weight: DEFAULT_STYLE.weight,
        fillColor: DEFAULT_STYLE.fillColor,
        fillOpacity: DEFAULT_STYLE.fillOpacity,
        hoverColor: DEFAULT_HL.hover.color,
        selectedColor: DEFAULT_HL.selected.color
      };
    }
  };
})();