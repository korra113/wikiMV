(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  let map, renderer; const shown = new Map(), hl = {};
  let activeTag = null; // { id, title }
  let isVectorVisible = true;
  let isZooming = false;

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
    autoSize: true,         // По умолчанию ВКЛЮЧЕНО
    hideBuildings: false,
    hideRegions: false,
    hideDeleted: false,
    hideSmallDensity: true,
    hideSmall: false,
    hideMedium: false,
    hideLarge: false        // По умолчанию ВЫКЛЮЧЕНО
  };

  function loadStoredFilters() {
    try {
      if (WM.api && WM.api.store) {
        filters.autoSize = WM.api.store.get('wm_filter_auto_size') !== 'false';
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

  // Адаптивная фильтрация по размеру и текущему масштабу экрана
  function isAllowedByAutoSize(o, zoom, mapSize, density) {
    const area = o.area || 0;
    const isRegion = !!o.is_region;

    // Оценка плотности объектов на экране
    const isHighDensity = density > 180;
    const isExtremeDensity = density > 380;

    // -------------------------------------------------------------------------
    // 1. ПРОВЕРКА СВЕРХУ: Скрытие фоновых супергигантов при сильном приближении (zoom >= 16)
    // Чтобы огромный район или промзона не перекрывали обзор мелких домов внутри.
    // На зумах 14-15 НЕ скрываем, чтобы можно было кликнуть любой парк/квартал.
    // -------------------------------------------------------------------------
    if (zoom >= 16 && (area >= 0.00015 || isRegion)) {
      const curMapSize = mapSize || (map ? map.getSize() : { x: 400, y: 700 });
      const degPerPx = 360 / (256 * 2 ** zoom);
      const centerLat = map ? map.getCenter().lat : ((o.bbox.s + o.bbox.n) / 2);
      const cosLat = Math.cos(centerLat * Math.PI / 180) || 1;

      const wpx = (o.bbox.e - o.bbox.w) / degPerPx;
      const hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;

      // Отсекаем только если объект больше всего экрана более чем в 1.3-1.5 раза
      const maxRatio = zoom >= 18 ? 1.1 : 1.4;
      if (wpx > curMapSize.x * maxRatio && hpx > curMapSize.y * maxRatio) {
        return false;
      }
    }

    // -------------------------------------------------------------------------
    // 2. ЗУМ 14 И КРУПНЕЕ (14, 15, 16, 17, 18, 19, 20):
    // НЕ УДАЛЯЕТСЯ ВООБЩЕ НИЧЕГО — видны все ларьки, памятники, гаражи и входы
    // -------------------------------------------------------------------------
    if (zoom >= 14) {
      return true;
    }

    // Административные регионы и границы сохраняем всегда
    if (isRegion) {
      return true;
    }

    // -------------------------------------------------------------------------
    // 3. ПЕРЕХОДНАЯ ЗОНА (МАСШТАБЫ 13 — 9)
    // -------------------------------------------------------------------------

    // Зум 13: убираем только самую микро-мелочь (< 400 м²: памятники, будки, ларьки).
    // Все жилые дома, гаражные кооперативы и склады остаются.
    if (zoom === 13) {
      let minArea = 0.00000006; // ~400 м²
      if (isExtremeDensity) minArea = 0.00000035; // плотный мегаполис: ~2 500 м² (крупные дома/ТЦ)
      else if (isHighDensity) minArea = 0.00000015; // плотная застройка: ~1 000 м²
      return area >= minArea;
    }

    // Зум 12: чуть крупнее мелочи (хрущевки, школы, детсады, ТЦ, кварталы остаются).
    if (zoom === 12) {
      let minArea = 0.00000035; // ~2 500 м²
      if (isExtremeDensity) minArea = 0.000002; // мегаполис: ~14 000 м²
      else if (isHighDensity) minArea = 0.0000009; // ~6 000 м²
      return area >= minArea;
    }

    // Зум 11: ещё крупнее (кварталы, больничные городки, промплощадки, парки).
    if (zoom === 11) {
      let minArea = 0.0000025; // ~18 000 м²
      if (isExtremeDensity) minArea = 0.000015; // мегаполис: ~100 000 м²
      else if (isHighDensity) minArea = 0.000006; // ~40 000 м²
      return area >= minArea;
    }

    // Зум 10: районный масштаб (микрорайоны, крупные заводы, большие парки, посёлки).
    if (zoom === 10) {
      let minArea = 0.00002; // ~140 000 м² (~14 га)
      if (isExtremeDensity) minArea = 0.00009; // ~600 000 м²
      else if (isHighDensity) minArea = 0.000045; // ~300 000 м²
      return area >= minArea;
    }

    // Зум 9: городской масштаб (крупные промзоны, лесопарки, городские районы).
    if (zoom === 9) {
      let minArea = 0.00009; // ~600 000 м² (~60 га)
      if (isExtremeDensity) minArea = 0.00035; // ~2.5 км²
      else if (isHighDensity) minArea = 0.00018; // ~1.2 км²
      return area >= minArea;
    }

    // -------------------------------------------------------------------------
    // 4. МАСШТАБЫ 8 И МЕЛЬЧЕ: АГРЕССИВНОЕ ОТСЕЧЕНИЕ
    // Остаются только гигантские объекты (города, озера, водохранилища, заповедники)
    // -------------------------------------------------------------------------

    // Зум 8:
    if (zoom === 8) {
      let minArea = 0.00045; // ~3 км²
      if (isExtremeDensity) minArea = 0.0018; // ~12 км²
      else if (isHighDensity) minArea = 0.0009; // ~6 км²
      return area >= minArea;
    }

    // Зум 7:
    if (zoom === 7) {
      let minArea = 0.002; // ~14 км²
      if (isHighDensity) minArea = 0.0045; // ~30 км²
      return area >= minArea;
    }

    // Зум 6 и мельче (обзор всей страны/континента):
    let minArea = 0.007; // ~50+ км²
    if (isHighDensity) minArea = 0.015;
    return area >= minArea;
  }

  function isObjectAllowed(o, optZoom, optMapSize, optDensity) {
    if (!o) return false;
    if (WM.isWikimapiaDisabled && WM.isWikimapiaDisabled()) return false;

    // ЕСЛИ основной слой полигонов выключен, но выбран тег:
    // пропускаем ИСКЛЮЧИТЕЛЬНО объекты с этим тегом, игнорируя фильтры размеров
    if (!isVectorVisible && activeTag) {
      return objectMatchesTag(o, activeTag);
    }

    if (filters.hideBuildings && o.is_building) return false;
    if (filters.hideRegions && o.is_region) return false;
    if (filters.hideDeleted && o.is_deleted) return false;

    const zoom = (optZoom !== undefined) ? optZoom : (map ? map.getZoom() : 15);
    const mapSize = optMapSize || (map ? map.getSize() : { x: 400, y: 700 });
    const density = (optDensity !== undefined) ? optDensity : (shown ? shown.size : 0);

    // В авто-режиме размеры балансируются автоматически
    if (filters.autoSize) {
      return isAllowedByAutoSize(o, zoom, mapSize, density);
    }

    // Ручной режим фильтрации
    const size = getObjectSizeCategory(o);
    if (filters.hideSmall && size === 'small') return false;
    if (filters.hideMedium && size === 'medium') return false;
    if (filters.hideLarge && size === 'large') return false;

    if (filters.hideSmallDensity && density > 260 && zoom <= 14 && size === 'small') {
      return false;
    }

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
    const smoothFactor = (map && map.getZoom() >= 18) ? 0 : 1.5;

    if (isTagMatched) {
      return { ...TAG_HL_STYLE, interactive: false, smoothFactor, _k: 'tag' };
    }

    const wpx = (o.bbox.e - o.bbox.w) / degPerPx;
    const hpx = (o.bbox.n - o.bbox.s) / cosLat / degPerPx;
    const maxRatio = Math.max(wpx / mapSize.x, hpx / mapSize.y);
    const sizeCat = getObjectSizeCategory(o);

    let opacityFactor = 1.0;
    if (maxRatio > 1.2 || o.is_region || sizeCat === 'large') {
      opacityFactor = 0.15;
    } else if (maxRatio > 0.6) {
      opacityFactor = 0.35;
    } else if (maxRatio > 0.3) {
      opacityFactor = 0.65;
    }

    const isVisited = !!o.isVisited;
    const visitedFactor = isVisited ? 0.85 : 1.0;

    if (o.customColor) {
      const baseOpacity = 0.35;
      const fillOpacity = Math.round(baseOpacity * opacityFactor * visitedFactor * 1000) / 1000;

      return {
        color: o.customColor,
        weight: Math.max(2, STYLE.weight),
        fillColor: o.customColor,
        fillOpacity,
        interactive: false,
        smoothFactor,
        _k: `c_${o.customColor}_${fillOpacity}_${smoothFactor}`
      };
    }

    const baseColor = isVisited ? desaturateColor(STYLE.color, 0.55) : STYLE.color;
    const baseFillColor = isVisited ? desaturateColor(STYLE.fillColor, 0.4) : STYLE.fillColor;
    const baseWeight = isVisited ? Math.max(1, STYLE.weight * 0.9) : STYLE.weight;

    const fillOpacity = Math.round(STYLE.fillOpacity * opacityFactor * visitedFactor * 1000) / 1000;
    const styleKey = `s_${isVisited}_${baseColor}_${baseFillColor}_${baseWeight}_${fillOpacity}_${smoothFactor}`;

    return {
      color: baseColor,
      weight: baseWeight,
      fillColor: baseFillColor,
      fillOpacity,
      interactive: false,
      smoothFactor,
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
      
      renderer = L.canvas({ pane: 'wm-base', padding: 0.1 });

      map.on('zoomstart', () => { 
        isZooming = true;
      });

      map.on('zoomend', () => {
        isZooming = false;
      });
    },

    render() {
      if (!map || isZooming) return;

      if (WM.isWikimapiaDisabled && WM.isWikimapiaDisabled()) {
        if (shown.size > 0) {
          for (const [id, s] of shown) {
            map.removeLayer(s.poly);
          }
          shown.clear();
        }
        if (hl.hover && hl.hover.poly) { map.removeLayer(hl.hover.poly); hl.hover.poly = null; hl.hover.id = null; }
        if (hl.selected && hl.selected.poly) { map.removeLayer(hl.selected.poly); hl.selected.poly = null; hl.selected.id = null; }
        return;
      }

      // Если выключен и слой полигонов, и нет активного тега — очищаем холст и выходим
      if (!isVectorVisible && !activeTag) {
        if (shown.size > 0) {
          for (const [id, s] of shown) {
            map.removeLayer(s.poly);
          }
          shown.clear();
        }
        if (hl.hover && hl.hover.poly) { map.removeLayer(hl.hover.poly); hl.hover.poly = null; hl.hover.id = null; }
        if (hl.selected && hl.selected.poly) { map.removeLayer(hl.selected.poly); hl.selected.poly = null; hl.selected.id = null; }
        return;
      }

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

      const density = candidates.length || 0;

      for (let i = 0; i < candidates.length; i++) {
        const o = candidates[i];
        const isTagMatched = activeTag && objectMatchesTag(o, activeTag);

        // Если векторный слой отключен — отбираем ТОЛЬКО объекты с выбранным тегом
        if (!isVectorVisible && !isTagMatched) continue;

        // Обычные объекты проверяем через фильтры (а совпавшие по тегу всегда отображаем)
        if (!isTagMatched && !isObjectAllowed(o, zoom, mapSize, density)) continue;

        const ob = o.bbox;
        if (ob.w > ve || ob.e < vw || ob.s > vn || ob.n < vs) continue;

        const wpx = (ob.e - ob.w) / degPerPx;
        const hpx = (ob.n - ob.s) / cosLat / degPerPx;

        if (zoom >= 17 && !isTagMatched && (wpx > mapSize.x * 1.5 || hpx > mapSize.y * 1.5)) {
          continue;
        }

        const maxPx = wpx > hpx ? wpx : hpx;
        const minPxLimit = isTagMatched ? 1 : (zoom >= 16 ? 1 : (zoom >= 14 ? 2 : (C.MIN_PX || 5)));
        if (maxPx >= minPxLimit) {
          vis.push({ o, maxPx });
        }
      }

      const maxRendered = zoom >= 19 ? 120 : (zoom >= 17 ? 250 : (C.MAX_RENDERED || 1200));
      if (vis.length > maxRendered) {
        vis.sort((a, b) => (b.o.area || 0) - (a.o.area || 0));
        vis = vis.slice(0, maxRendered);
      }

      const keep = new Set();
      for (let i = 0; i < vis.length; i++) {
        keep.add(vis[i].o.id);
      }

      for (const [id, s] of shown) {
        if (!keep.has(id)) { 
          map.removeLayer(s.poly); 
          shown.delete(id); 
        }
      }

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

      // Всегда обновляем верхнюю плашку с числом найденных объектов
      if (activeTag && WM.ui && WM.ui.updateTagFilterHUD) {
        const matches = vis.filter(item => objectMatchesTag(item.o, activeTag)).length;
        WM.ui.updateTagFilterHUD(activeTag, matches);
      }
    },


    setVisible(visible) {
      isVectorVisible = !!visible;
      if (!isVectorVisible && !activeTag) {
        for (const [id, s] of shown) {
          map.removeLayer(s.poly);
        }
        shown.clear();
        if (hl.hover && hl.hover.poly) { map.removeLayer(hl.hover.poly); hl.hover.poly = null; hl.hover.id = null; }
        if (hl.selected && hl.selected.poly) { map.removeLayer(hl.selected.poly); hl.selected.poly = null; hl.selected.id = null; }
      } else {
        this.render();
      }
      if (window.refreshAppStatus) window.refreshAppStatus();
    },
    isVisible() { return isVectorVisible; },

    toggleTagFilter(tag) {
      if (WM.loader && WM.loader.resetTagBbox) WM.loader.resetTagBbox();
      if (activeTag && (activeTag.title === tag.title || (activeTag.id && activeTag.id === tag.id))) {
        activeTag = null;
        if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(null);
      } else {
        activeTag = tag;
        // Сразу отображаем верхнюю динамическую плашку тега
        if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(activeTag, 0);
        if (WM.loader && WM.loader.fetchCategoryInBounds) {
          WM.loader.fetchCategoryInBounds(tag);
        }
      }
      this.render();
    },

    clearTagFilter() {
      activeTag = null;
      if (WM.loader && WM.loader.resetTagBbox) WM.loader.resetTagBbox();
      if (WM.ui && WM.ui.updateTagFilterHUD) WM.ui.updateTagFilterHUD(null);
      this.render();
    },
    getActiveTag() { return activeTag; },

    matchesTag: objectMatchesTag,
    shownObjects() { return [...shown.values()].map(s => s.obj); },
    count() { return shown.size; },

    setHover: o => setHl('hover', o),
    setSelected: o => setHl('selected', o),
    updateObjectStyle(id) {
      const s = shown.get(id);
      if (s && map) {
        const degPerPx = 360 / (256 * 2 ** map.getZoom());
        const cosLat = Math.cos(map.getCenter().lat * Math.PI / 180) || 1;
        const style = computeStyleForObject(s.obj, map.getSize(), degPerPx, cosLat);
        if (s.styleKey !== style._k) {
          s.styleKey = style._k;
          s.poly.setStyle(style);
        }
      }
    },
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
      if (f.autoSize !== undefined) {
        filters.autoSize = !!f.autoSize;
        if (WM.api && WM.api.store) WM.api.store.set('wm_filter_auto_size', filters.autoSize ? 'true' : 'false');
      }
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