(async function () {
  const WM = window.WM, C = WM.config;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wm_view')); } catch (e) {}

  const map = L.map('map', { 
    zoomControl: false, 
    doubleClickZoom: false,
    preferCanvas: true,
    tapTolerance: 20, 
    maxZoom: 20,
    minZoom: 3,
    zoomSnap: 0.5,
    zoomDelta: 0.5
  }).setView(saved ? saved.c : [55.751244, 37.618423], saved ? saved.z : 16);

  L.control.zoom({ position: 'topleft' }).addTo(map);

  const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Базовые параметры экономии трафика для ВСЕХ слоев тайлов
  const COMMON_TILE_OPTIONS = {
    keepBuffer: 2,            // Хранить ближайшие тайлы, чтобы реже перезапрашивать
    updateWhenIdle: true,     // Грузить только после остановки сдвига карты
    updateWhenZooming: false, // Не слать запросы на промежуточных фазах зума
    updateInterval: 250,      // Троттлинг 250 мс перед стартом загрузки новой пачки
    errorTileUrl: EMPTY_TILE
  };

  // =========================================================================
  // БАЗОВЫЕ СЛОИ КАРТЫ
  // =========================================================================

  // --- 1. Спутники ---
  const satEsri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 18,
    maxZoom: 20,
    attribution: 'Esri'
  });

  const satClarity = L.tileLayer('https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 17,
    maxZoom: 20,
    attribution: 'Esri Clarity'
  });

  const satGoogle = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['0', '1', '2', '3'],
    maxNativeZoom: 20,
    maxZoom: 20,
    attribution: '© Google'
  });

  // --- 2. Топографические карты ---
  const arbaletMO = L.tileLayer('https://tiles.nakarte.me/ArbaletMO/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'Топокарта Арбалет (МО)'
  });

  const GgcSmartLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const folder = (coords.z <= 11) ? 'ggc2000' : 'ggc1000';
      this._url = `https://tiles.nakarte.me/${folder}/{z}/{x}/{-y}`;
      return L.TileLayer.prototype.getTileUrl.call(this, coords);
    }
  });

  const ggc = new GgcSmartLayer('', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 6,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'ГосГисЦентр (ГГЦ)'
  });

  const genshtab = L.tileLayer('https://tiles.nakarte.me/topo1000/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 7,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'Генштаб СССР (1 км)'
  });

  const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    maxNativeZoom: 17,
    maxZoom: 20,
    attribution: '© OpenTopoMap, OSM'
  });

  const cyclOSM = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    maxNativeZoom: 18,
    maxZoom: 20,
    attribution: '© CyclOSM, OSM'
  });

  const esriHillshade = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 16,
    maxZoom: 20,
    attribution: 'Esri Hillshade'
  });

  // --- 3. Схемы ---
  const schemeGoogle = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['0', '1', '2', '3'],
    maxNativeZoom: 20,
    maxZoom: 20,
    attribution: '© Google'
  });

  const schemeEsri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 18,
    maxZoom: 20,
    attribution: 'Esri'
  });

  const schemeDark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 16,
    maxZoom: 20,
    attribution: 'Esri, HERE'
  });

  const osmClassic = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '© OSM France'
  });

  const baseLayers = {
    'Спутник (Esri)': satEsri,
    'Спутник высокой четкости (Esri Clarity)': satClarity,
    'Спутник + Дороги (Google)': satGoogle,
    'Топокарта Арбалет (Москва и МО)': arbaletMO,
    'Топокарты ГГЦ (ГосГисЦентр)': ggc,
    'Топокарты Генштаба СССР (1 км)': genshtab,
    'Топокарта OpenTopoMap': openTopo,
    'Тропы и грунтовки (CyclOSM)': cyclOSM,
    'Рельеф (Esri Hillshade)': esriHillshade,
    'Схема (Google)': schemeGoogle,
    'Схема (Esri Streets)': schemeEsri,
    'Схема OSM (Классика)': osmClassic,
    'Тёмная карта (Esri)': schemeDark
  };

  const savedBaseName = localStorage.getItem('wm_base_layer');
  const activeBaseLayer = (savedBaseName && baseLayers[savedBaseName]) ? baseLayers[savedBaseName] : cyclOSM;
  activeBaseLayer.addTo(map);

  map.on('baselayerchange', (e) => {
    localStorage.setItem('wm_base_layer', e.name);
  });

  // =========================================================================
  // НАКЛАДЫВАЕМЫЕ СЛОИ (OVERLAYS)
  // =========================================================================

  const WmRasterLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const hash = (coords.x % 4) + (coords.y % 4) * 4;
      return L.Util.template(this._url, L.extend({
        s: this._getSubdomain(coords),
        z: this._getZoomForUrl(),
        x: coords.x,
        y: coords.y,
        hash
      }, this.options));
    }
  });

  const wmContours = new WmRasterLayer('https://i{hash}.wikimapia.org/?x={x}&y={y}&zoom={z}&type=hybrid&lng=1', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    maxNativeZoom: 18,
    maxZoom: 20,
    opacity: 1.0,
    className: 'wm-raster-tile'
  });

  const railwayOverlay = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    maxNativeZoom: 19,
    maxZoom: 20,
    opacity: 0.85,
    attribution: '© OpenRailwayMap'
  });

  let isContoursEnabled = localStorage.getItem('wm_overlay_contours') !== 'false';
  const isRailwayEnabled = localStorage.getItem('wm_overlay_railway') === 'true';

  if (isRailwayEnabled) {
    railwayOverlay.addTo(map);
  }

  let isProgrammaticLayerChange = false;

  function syncOverlayMode() {
    if (!isContoursEnabled) {
      if (map.hasLayer(wmContours)) {
        isProgrammaticLayerChange = true;
        map.removeLayer(wmContours);
        isProgrammaticLayerChange = false;
      }
      return;
    }

    const mode = WM.ui ? WM.ui.getWorkMode() : 'hybrid';
    
    if (mode === 'manual' || mode === 'nakarte') {
      if (!map.hasLayer(wmContours)) {
        isProgrammaticLayerChange = true;
        map.addLayer(wmContours);
        isProgrammaticLayerChange = false;
      }
      wmContours.setOpacity(1.0);
    } else if (mode === 'auto') {
      if (map.hasLayer(wmContours)) {
        isProgrammaticLayerChange = true;
        map.removeLayer(wmContours);
        isProgrammaticLayerChange = false;
      }
    } else {
      if (!map.hasLayer(wmContours)) {
        isProgrammaticLayerChange = true;
        map.addLayer(wmContours);
        isProgrammaticLayerChange = false;
      }

      if (map.getZoom() >= C.VECTOR_ZOOM) {
        wmContours.setOpacity(0.6);
      } else {
        wmContours.setOpacity(1.0);
      }
    }
  }

  window.syncRasterOverlay = syncOverlayMode;
  map.on('zoomend', syncOverlayMode);

  map.on('overlayadd', (e) => {
    if (isProgrammaticLayerChange) return;

    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = true;
      localStorage.setItem('wm_overlay_contours', 'true');
      syncOverlayMode();
    } else if (e.name === 'Ж/Д сеть (OpenRailwayMap)') {
      localStorage.setItem('wm_overlay_railway', 'true');
    }
  });

  map.on('overlayremove', (e) => {
    if (isProgrammaticLayerChange) return;

    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = false;
      localStorage.setItem('wm_overlay_contours', 'false');
      syncOverlayMode();
    } else if (e.name === 'Ж/Д сеть (OpenRailwayMap)') {
      localStorage.setItem('wm_overlay_railway', 'false');
    }
  });

  const overlayLayers = {
    'Контуры Wikimapia': wmContours,
    'Ж/Д сеть (OpenRailwayMap)': railwayOverlay
  };

  L.control.layers(baseLayers, overlayLayers, { position: 'topright' }).addTo(map);

  WM.map = map;

  await WM.cache.init();

  WM.view.init(map);
  WM.picker.init(map);
  WM.ui.init();
  if (WM.markers) WM.markers.init();
  if (WM.measure) WM.measure.init();

  syncOverlayMode();

  let renderTimer = 0;
  function refreshStatus() {
    const s = WM.loader.stats();
    const mode = WM.ui ? WM.ui.getWorkMode() : 'manual';
    const autoHover = WM.ui && WM.ui.isAutoHoverEnabled();

    if (WM.ui && WM.ui.toggleTopGetKeyBtn) {
      WM.ui.toggleTopGetKeyBtn(!!s.isRateWaiting || (!!s.blocked && /ключ|key|limit|quota/i.test(s.blocked)));
    }

    if (s.blocked) return WM.ui.setStatus('⚠ ' + s.blocked, true);
    if (s.isRateWaiting) return WM.ui.setStatus(`⏳ Лимит ключей\nПауза: ${WM.ui.fmtTimer(s.waitMs)}`, true);

    if (mode === 'manual') {
      let t = `Ручной режим (только растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'} · в памяти: ${WM.view.count()}`;
      if (s.detailsQueueCount > 0) t += `\n📥 Карточки: в очереди ${s.detailsQueueCount}`;
      return WM.ui.setStatus(t);
    }

    if (map.getZoom() < C.MIN_ZOOM) return WM.ui.setStatus(`Масштаб < ${C.MIN_ZOOM}\n(приблизьте карту)`);

    if (mode === 'hybrid' && map.getZoom() < C.VECTOR_ZOOM) {
      let t = `Гибридный режим (растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'} · в памяти: ${WM.view.count()}`;
      if (s.detailsQueueCount > 0) t += `\n📥 Карточки: в очереди ${s.detailsQueueCount}`;
      return WM.ui.setStatus(t);
    }

    let t = `Объектов: ${WM.view.count()}`;
    if (s.active) t += `\nЗагрузка тайлов: ${s.active}`;
    else if (s.detailsQueueCount > 0) t += `\n📥 Карточки: в очереди ${s.detailsQueueCount}`;
    if (s.errors) t += s.failed ? ` · ошибок: ${s.failed}` : ' · повтор…';
    WM.ui.setStatus(t, !!s.failed);
  }

  window.refreshAppStatus = refreshStatus;

  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      WM.view.render();
      refreshStatus();
      WM.picker.refresh();
    }, 60);
  };

  WM.loader.init(map, { onChange: scheduleRender, onStatus: refreshStatus });

  // При любом начале движения или зума карты МГНОВЕННО прерываем фоновую загрузку карточек
  map.on('movestart zoomstart', () => {
    if (WM.loader && WM.loader.stopDetailsQueue) {
      WM.loader.stopDetailsQueue();
    }
  });

  let moveTimer = 0;
  map.on('moveend', () => {
    WM.view.render();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => WM.loader.update(), 200);
    try {
      const c = map.getCenter();
      localStorage.setItem('wm_view', JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom() }));
    } catch (e) {}
  });

  window.addEventListener('online', () => WM.loader.retryNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) WM.loader.retryNow(); });

  let me = null;
  document.getElementById('btn-location').onclick = () => {
    if (!navigator.geolocation) return alert('Геолокация не поддерживается');
    navigator.geolocation.getCurrentPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (me) me.setLatLng(ll);
      else me = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#0284c7', fillOpacity: 1, interactive: false }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 16));
    }, e => alert('Ошибка геопозиции: ' + e.message), { enableHighAccuracy: true, timeout: 15000 });
  };

  const savedMode = WM.api.store.get('wm_mode') || 'cross';
  WM.picker.setMode(savedMode);

  WM.view.render();
  WM.loader.update();
  refreshStatus();
})();