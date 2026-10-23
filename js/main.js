

(async function () {
  const WM = window.WM, C = WM.config;

  // =========================================================================
  // УПРАВЛЕНИЕ ЭКРАНОМ (WAKE LOCK API)
  // =========================================================================
  let wakeLockSentinel = null;

  async function requestScreenWakeLock() {
    // 1. Аппаратное удержание через нативный Android-мост (в APK)
    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(true);
    }

    // 2. Стандартный веб-API (в браузере)
    if ('wakeLock' in navigator) {
      try {
        if (wakeLockSentinel && !wakeLockSentinel.released) return;
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      } catch (err) {}
    }
  }

  function releaseScreenWakeLock() {
    // 1. Снимаем флаг в Android (в APK)
    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(false);
    }

    // 2. Снимаем в браузере
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }
  }

  WM.wakeLock = {
    request: requestScreenWakeLock,
    release: releaseScreenWakeLock
  };

  // Автоматический запрос удержания подсветки, если включено в настройках
  function shouldKeepScreenOn() {
    const userPref = localStorage.getItem('wm_pdr_wakelock');
    if (userPref === 'false') return false;
    if (userPref === 'true' || userPref === 'always') return true;

    const isPdr = WM.pdr && WM.pdr.isActive();
    const isFollow = WM.followMode && WM.followMode.isActive();
    const hasNav = WM.navTarget && WM.navTarget.getTarget();
    return !!(isPdr || isFollow || hasNav);
  }

  function syncWakeLockState() {
    if (document.visibilityState !== 'visible') {
      releaseScreenWakeLock();
      return;
    }
    if (shouldKeepScreenOn()) {
      requestScreenWakeLock();
    } else {
      releaseScreenWakeLock();
    }
  }

  WM.syncWakeLockState = syncWakeLockState;
  syncWakeLockState();

  document.addEventListener('visibilitychange', () => {
    syncWakeLockState();
  });

  // =========================================================================
  // ИНИЦИАЛИЗАЦИЯ КАРТЫ LEAFLET
  // =========================================================================
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wm_view')); } catch (e) {}

  const map = L.map('map', { 
    zoomControl: false, 
    doubleClickZoom: false,
    preferCanvas: true,
    tapTolerance: 20, 
    maxZoom: 20,
    minZoom: 3,
    zoomSnap: 1,
    zoomDelta: 1,
    zoomAnimation: true,
    fadeAnimation: false,
    zoomAnimationThreshold: 4
  }).setView(saved ? saved.c : [55.751244, 37.618423], saved ? saved.z : 16);

  L.control.zoom({ position: 'topleft' }).addTo(map);

  const isMobile = L.Browser.mobile;
  const COMMON_TILE_OPTIONS = {
    keepBuffer: isMobile ? 1 : 2,
    updateWhenIdle: isMobile,
    updateWhenZooming: !isMobile,
    updateInterval: isMobile ? 150 : 100
  };

  // Базовые панели
  map.createPane('wm-underlay');
  map.getPane('wm-underlay').style.zIndex = 150;

  map.createPane('wm-hillshade-pane');
  map.getPane('wm-hillshade-pane').style.zIndex = 250;
  map.getPane('wm-hillshade-pane').style.mixBlendMode = 'multiply';

  map.createPane('wm-top-lines');
  map.getPane('wm-top-lines').style.zIndex = 480;

  map.createPane('wm-raster-pane');
  map.getPane('wm-raster-pane').style.zIndex = 350;

  // Адаптер Bing
  const BingTileLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      let quad = '';
      for (let i = coords.z; i > 0; i--) {
        let digit = 0;
        const mask = 1 << (i - 1);
        if ((coords.x & mask) !== 0) digit += 1;
        if ((coords.y & mask) !== 0) digit += 2;
        quad += digit;
      }
      return L.Util.template(this._url, L.extend({
        s: this._getSubdomain(coords),
        q: quad
      }, this.options));
    }
  });

  // Адаптер Яндекс
  const yandexCrs = L.CRS.EPSG3395;
  const YandexTileLayer = L.TileLayer.extend({
    _getTilePos(coords) {
      const tilePosLatLng = yandexCrs.pointToLatLng(coords.scaleBy(this.getTileSize()), coords.z);
      return this._map.project(tilePosLatLng, coords.z).subtract(this._level.origin);
    },

    _pxBoundsToTileRange(bounds) {
      const zoom = this._tileZoom;
      const bounds2 = L.bounds(
        yandexCrs.latLngToPoint(this._map.unproject(bounds.min, zoom), zoom),
        yandexCrs.latLngToPoint(this._map.unproject(bounds.max, zoom), zoom)
      );
      return L.TileLayer.prototype._pxBoundsToTileRange.call(this, bounds2);
    },

    createTile(coords, done) {
      const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
      const coordsBelow = L.point(coords).add([0, 1]);
      coordsBelow.z = coords.z;
      const h = Math.ceil(this._getTilePos(coordsBelow).y - this._getTilePos(coords).y);
      tile.style.setProperty('height', (h + 1) + 'px', 'important');
      return tile;
    }
  });

  // Фоновая обзорная подложка
  const fallbackUnderlay = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
    pane: 'wm-underlay',
    subdomains: ['a', 'b', 'c'],
    minZoom: 0,
    maxNativeZoom: 5,
    maxZoom: 11,
    keepBuffer: 0,
    updateWhenIdle: true,
    className: 'wm-fallback-tile',
    attribution: 'OSM'
  });

  function syncFallbackUnderlay() {
    const z = map.getZoom();
    if (z <= 11) {
      if (!map.hasLayer(fallbackUnderlay)) map.addLayer(fallbackUnderlay);
    } else {
      if (map.hasLayer(fallbackUnderlay)) map.removeLayer(fallbackUnderlay);
    }
  }

  if (map.getZoom() <= 11) {
    fallbackUnderlay.addTo(map);
  }
  map.on('zoomend', syncFallbackUnderlay);

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

  const satBing = new BingTileLayer('https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['0', '1', '2', '3'],
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '© Microsoft Bing'
  });

  const satYandex = new YandexTileLayer('https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang=ru_RU', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '© Яндекс'
  });

  // --- 2. Топографические карты ---
  const tfOutdoorsUrl = (L.Browser.mobile || ((navigator.deviceMemory || 4) <= 3))
    ? 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png'
    : 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png';

  const tfOutdoors = L.tileLayer(tfOutdoorsUrl, {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    maxNativeZoom: 18,
    maxZoom: 20,
    attribution: '© Thunderforest, OSM'
  });

  const arbaletMO = L.tileLayer('https://tiles.nakarte.me/ArbaletMO/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'Топокарта Арбалет (МО)'
  });

  const ggc2000 = L.tileLayer('https://tiles.nakarte.me/ggc2000/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 5,
    maxNativeZoom: 12,
    maxZoom: 20,
    attribution: 'ГосГисЦентр 2 км (ГГЦ)'
  });

  const ggc1000 = L.tileLayer('https://tiles.nakarte.me/ggc1000/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 6,
    maxNativeZoom: 13,
    maxZoom: 20,
    zIndex: 1,
    attribution: 'ГосГисЦентр (ГГЦ)'
  });

  const ggc500 = L.tileLayer('https://tiles.nakarte.me/ggc500/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minZoom: 9,
    maxNativeZoom: 14,
    maxZoom: 20,
    zIndex: 2
  });

  const ggc250 = L.tileLayer('https://tiles.nakarte.me/ggc250/{z}/{x}/{-y}', {
    ...COMMON_TILE_OPTIONS,
    minZoom: 10,
    maxNativeZoom: 15,
    maxZoom: 20,
    zIndex: 3
  });

  const ggc = L.layerGroup([ggc1000, ggc500, ggc250]);

  const genshtab1980 = L.tileLayer('https://russia3d.ru/maps/tiles/topomaper1-2km1980/webmercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 7,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'Генштаб 1-2 км 1980-е (topomapper / russia3d)'
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

  // --- 3. Схемы ---
  const schemeGoogle = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['0', '1', '2', '3'],
    maxNativeZoom: 20,
    maxZoom: 20,
    attribution: '© Google'
  });

  const schemeYandex = new YandexTileLayer('https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU', {
    ...COMMON_TILE_OPTIONS,
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '© Яндекс'
  });

  const YANDEX_SL = [
    'ad_map_area', 'ad_border_all_map', 'ad_cnt', 'addr_regular', 'zipcode_z12',
    'poi_entrance', 'hydro_fc', 'hydro_line_map', 'hydro_area', 'hydro_point',
    'rd_oneway', 'rd_junctions', 'rd_all_map', 'urban_roadnet', 'fence_map',
    'bld_regular', 'poi_auto', 'poi_service', 'poi_government', 'poi_urban',
    'poi_food', 'poi_other', 'poi_culture', 'poi_medicine', 'poi_edu',
    'poi_leisure', 'poi_industry', 'poi_backa_null', 'poi_religion', 'poi_sport',
    'poi_construction', 'poi_shopping', 'poi_finance', 'parking_lot_linear',
    'parking_lot_regular', 'vegetation_plant_color', 'vegetation_area',
    'vegetation_cnt', 'relief_line_map', 'relief_area', 'relief_point',
    'indoor_plan', 'urban_areal', 'transport_terminal', 'transport_airport',
    'transport_helicopter', 'transport_metro_exit', 'transport_waterway_line',
    'transport_railway', 'transport_metro_line', 'transport_stop',
    'transport_railway_platform', 'transport_waterway_stop',
    'transport_railway_station', 'transport_metro_station',
    'transport_airport_terminal', 'transport_tram_line', 'road_surface'
  ].join(',');

  const narodYandex = new YandexTileLayer(
    `https://{s}.core-nmaps-renderer-nmaps.maps.yandex.net/tile2?x={x}&y={y}&z={z}&l=mpmap&sl=${YANDEX_SL}&token=`, {
      ...COMMON_TILE_OPTIONS,
      subdomains: ['01', '02', '03', '04'],
      maxNativeZoom: 19,
      maxZoom: 20,
      attribution: '© Народная карта Яндекс'
    }
  );

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

  // --- 4. Исторические карты ---
  const rkkaEtomesto = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_rkka_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'Карта РККА (ЭтоМесто / russia3d)'
  });

  const vtk3v = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_3v_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 13,
    maxZoom: 20,
    attribution: 'ВТК 3 версты в дюйме (ЭтоМесто / russia3d)'
  });

  const mendeVladimir = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_vladimir_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Владимирская губ. (ЭтоМесто / russia3d)'
  });

  const mendeNN = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_nn_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Нижегородская губ. (ЭтоМесто / russia3d)'
  });

  const mendePenza = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_penza_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Пензенская губ. (ЭтоМесто / russia3d)'
  });

  const mendeRyazan = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_ryazan_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Рязанская губ. (ЭтоМесто / russia3d)'
  });

  const mendeSimbirsk = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_simbirsk_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Симбирская губ. (ЭтоМесто / russia3d)'
  });

  const mendeTambov = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_tambov_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Тамбовская губ. (ЭтоМесто / russia3d)'
  });

  const mendeTver = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_tver_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Тверская губ. (ЭтоМесто / russia3d)'
  });

  const mendeYaroslavl = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mende_yaroslavl_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Менде: Ярославская губ. (ЭтоМесто / russia3d)'
  });

  const mendeMoscow = L.tileLayer('https://russia3d.ru/maps/tiles/etomesto_mos_1860_all_mb/mercator/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    minNativeZoom: 8,
    maxNativeZoom: 14,
    maxZoom: 20,
    attribution: 'Карта Московской губ. 1860 г. (ЭтоМесто / russia3d)'
  });

  // --- Гуманитарная карта OSM (HOT) ---
  const osmHot = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    ...COMMON_TILE_OPTIONS,
    subdomains: ['a', 'b', 'c'],
    minZoom: 1,
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '© Humanitarian OSM Team, OSM'
  });

  WM.baseMapsCatalog = [
    { id: 'satEsri', name: 'Спутник (Esri)', category: 'modern', layer: satEsri, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satClarity', name: 'Спутник (Esri Clarity)', category: 'modern', layer: satClarity, testUrl: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satGoogle', name: 'Спутник + Дороги (Google)', category: 'modern', layer: satGoogle, testUrl: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satBing', name: 'Спутник (Bing)', category: 'modern', layer: satBing, testUrl: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satYandex', name: 'Спутник (Яндекс)', category: 'modern', layer: satYandex, testUrl: 'https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang=ru_RU', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'cyclOSM', name: 'Тропы и грунтовки (CyclOSM)', category: 'modern', layer: cyclOSM, testUrl: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'openTopo', name: 'Топокарта OpenTopoMap', category: 'modern', layer: openTopo, testUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc', name: 'Топокарты ГГЦ 250-1000м', category: 'modern', layer: ggc, testUrl: 'https://tiles.nakarte.me/ggc1000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc2000', name: 'Топокарта ГГЦ 2 км', category: 'modern', layer: ggc2000, testUrl: 'https://tiles.nakarte.me/ggc2000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'arbaletMO', name: 'Топокарта Арбалет (Москва и МО)', category: 'modern', layer: arbaletMO, testUrl: 'https://tiles.nakarte.me/ArbaletMO/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'genshtab1980', name: 'Топокарта Генштаб 1-2 км (1980-е)', category: 'modern', layer: genshtab1980, testUrl: 'https://russia3d.ru/maps/tiles/topomaper1-2km1980/webmercator/{z}/{x}/{y}.png', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'tfOutdoors', name: 'Thunderforest Outdoors', category: 'modern', layer: tfOutdoors, testUrl: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'osmClassic', name: 'Схема OSM (Классика)', category: 'modern', layer: osmClassic, testUrl: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'osmHot', name: 'Гуманитарная карта OSM ', category: 'modern', layer: osmHot, testUrl: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeYandex', name: 'Схема (Яндекс)', category: 'modern', layer: schemeYandex, testUrl: 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&scale=1&lang=ru_RU', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'narodYandex', name: 'Народная карта (Яндекс)', category: 'modern', layer: narodYandex, testUrl: `https://{s}.core-nmaps-renderer-nmaps.maps.yandex.net/tile2?x={x}&y={y}&z={z}&l=mpmap&sl=${YANDEX_SL}&token=`, subdomains: ['01', '02', '03', '04'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeGoogle', name: 'Схема (Google)', category: 'modern', layer: schemeGoogle, testUrl: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeEsri', name: 'Схема (Esri Streets)', category: 'modern', layer: schemeEsri, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeDark', name: 'Тёмная карта (Esri)', category: 'modern', layer: schemeDark, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'rkkaEtomesto', name: 'Карта РККА (ЭтоМесто)', category: 'historical', layer: rkkaEtomesto, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_rkka_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'vtk3v', name: 'ВТК 3 версты (Юго-Запад России)', category: 'historical', layer: vtk3v, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_3v_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 53.50, lng: 37.00, z: 10 } },
    { id: 'mendeMoscow', name: 'Карта Московской губ. (1860)', category: 'historical', layer: mendeMoscow, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mos_1860_all_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'mendeVladimir', name: 'Менде: Владимирская губ.', category: 'historical', layer: mendeVladimir, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_vladimir_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 56.13, lng: 40.40, z: 10 } },
    { id: 'mendeNN', name: 'Менде: Нижегородская губ.', category: 'historical', layer: mendeNN, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_nn_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 56.32, lng: 44.00, z: 10 } },
    { id: 'mendeTver', name: 'Менде: Тверская губ.', category: 'historical', layer: mendeTver, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_tver_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 56.85, lng: 35.90, z: 10 } },
    { id: 'mendeYaroslavl', name: 'Менде: Ярославская губ.', category: 'historical', layer: mendeYaroslavl, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_yaroslavl_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 57.62, lng: 39.87, z: 10 } },
    { id: 'mendeRyazan', name: 'Менде: Рязанская губ.', category: 'historical', layer: mendeRyazan, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_ryazan_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 54.62, lng: 39.73, z: 10 } },
    { id: 'mendeTambov', name: 'Менде: Тамбовская губ.', category: 'historical', layer: mendeTambov, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_tambov_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 52.72, lng: 41.44, z: 10 } },
    { id: 'mendePenza', name: 'Менде: Пензенская губ.', category: 'historical', layer: mendePenza, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_penza_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 53.20, lng: 45.00, z: 10 } },
    { id: 'mendeSimbirsk', name: 'Менде: Симбирская губ.', category: 'historical', layer: mendeSimbirsk, testUrl: 'https://russia3d.ru/maps/tiles/etomesto_mende_simbirsk_mb/mercator/{z}/{x}/{y}.png', testPoint: { lat: 54.32, lng: 48.38, z: 10 } }
  ];

   function getDefaultDisabledBaseMaps() {
    return WM.baseMapsCatalog
      .filter(m => 
        (m.category === 'historical' && m.id !== 'rkkaEtomesto') ||
        m.id === 'schemeDark' || 
        m.id === 'ggc2000'
      )
      .map(m => m.name);
  }
  WM.getDefaultDisabledBaseMaps = getDefaultDisabledBaseMaps;

  let layersControl = null;

  // ВЕРСИОНИРОВАННЫЙ СБРОС: меняем версию (например, v2), 
  // чтобы применилось и у старых пользователей
  const BASE_MAPS_DEFAULTS_VER = 'v2';
  if (localStorage.getItem('wm_disabled_base_maps_ver') !== BASE_MAPS_DEFAULTS_VER) {
    try {
      localStorage.setItem('wm_disabled_base_maps', JSON.stringify(getDefaultDisabledBaseMaps()));
      localStorage.setItem('wm_disabled_base_maps_ver', BASE_MAPS_DEFAULTS_VER);
    } catch (e) {}
  }

  function rebuildBaseLayersControl() {
    let disabledList = [];
    try {
      const stored = localStorage.getItem('wm_disabled_base_maps');
      if (stored !== null) {
        disabledList = JSON.parse(stored) || [];
      } else {
        disabledList = getDefaultDisabledBaseMaps();
      }
      if (!Array.isArray(disabledList)) disabledList = [];
    } catch (e) { disabledList = getDefaultDisabledBaseMaps(); }

    const enabledMaps = WM.baseMapsCatalog.filter(m => !disabledList.includes(m.name));
    const effectiveEnabled = enabledMaps.length ? enabledMaps : [WM.baseMapsCatalog[0]];

    const activeBaseMapName = localStorage.getItem('wm_base_layer') || 'Схема (Яндекс)';
    const isCurrentActiveAllowed = effectiveEnabled.some(m => m.name === activeBaseMapName);

    if (!isCurrentActiveAllowed) {
      const fallbackMap = effectiveEnabled[0];
      WM.baseMapsCatalog.forEach(m => {
        if (map.hasLayer(m.layer)) map.removeLayer(m.layer);
      });
      fallbackMap.layer.addTo(map);
      localStorage.setItem('wm_base_layer', fallbackMap.name);
    } else {
      const activeObj = WM.baseMapsCatalog.find(m => m.name === activeBaseMapName);
      if (activeObj && !map.hasLayer(activeObj.layer)) {
        activeObj.layer.addTo(map);
      }
    }

    const enabledBaseLayers = {};
    effectiveEnabled.forEach(m => {
      enabledBaseLayers[m.name] = m.layer;
    });

    if (layersControl) {
      map.removeControl(layersControl);
    }
    layersControl = L.control.layers(enabledBaseLayers, overlayLayers, { position: 'topright' }).addTo(map);
    WM.layersControl = layersControl;
  }
  WM.rebuildBaseLayersControl = rebuildBaseLayersControl;

  function switchToBaseMap(mapName) {
    const targetObj = WM.baseMapsCatalog.find(m => m.name === mapName);
    if (!targetObj || !map) return;

    WM.baseMapsCatalog.forEach(m => {
      if (map.hasLayer(m.layer)) map.removeLayer(m.layer);
    });

    targetObj.layer.addTo(map);
    localStorage.setItem('wm_base_layer', mapName);
    rebuildBaseLayersControl();

    if (window.updateQuickSwapUI) window.updateQuickSwapUI();
  }
  WM.switchToBaseMap = switchToBaseMap;

  // Логика кнопки быстрой смены карты
  const btnQuickSwap = document.getElementById('btn-quick-swap-map');

  function initQuickSwapModal() {
    const modal = document.getElementById('modal-quick-swap-select');
    const closeBtn = document.getElementById('quick-swap-select-x');
    if (modal && !modal._swapInited) {
      modal._swapInited = true;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
      if (closeBtn) {
        closeBtn.onclick = () => modal.classList.remove('open');
      }
    }
  }

  function updateQuickSwapUI() {
    const btnSearch = document.getElementById('btn-search');
    const btnQuickMenu = document.getElementById('btn-quick-menu');
    if (!btnQuickSwap) return;
    if (window.updateBottomLeftButtonsStack) {
      window.updateBottomLeftButtonsStack();
    }

    const isEnabled = localStorage.getItem('wm_quick_swap_enabled') !== 'false';
    const swapPos = localStorage.getItem('wm_quick_swap_pos') || 'top-right';

    btnQuickSwap.hidden = !isEnabled;

    if (!isEnabled || swapPos !== 'top-right') {
      if (btnSearch) btnSearch.classList.add('search-top-aligned');
    } else {
      if (btnSearch) btnSearch.classList.remove('search-top-aligned');
    }

    if (swapPos === 'bottom-left') {
      btnQuickSwap.classList.add('pos-bottom-left');
      const isQuickMenuVisible = btnQuickMenu && 
        !btnQuickMenu.hidden && 
        btnQuickMenu.style.display !== 'none' && 
        getComputedStyle(btnQuickMenu).display !== 'none';

      btnQuickSwap.classList.toggle('stacked-above-menu', !!isQuickMenuVisible);
    } else {
      btnQuickSwap.classList.remove('pos-bottom-left', 'stacked-above-menu');
    }

    if (!isEnabled) return;

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

    if (targetMap.startsWith('kml:')) {
      const kmlId = targetMap.slice(4);
      const kml = WM.imageOverlay && WM.imageOverlay.getOverlay ? WM.imageOverlay.getOverlay(kmlId) : null;
      if (kml && WM.imageOverlay.toggleOverlayVisibility) {
        const isVisible = kml.visible !== false;
        btnQuickSwap.classList.toggle('active-target', isVisible);
        btnQuickSwap.title = isVisible 
          ? `Скрыть слой «${kml.name}» (удерживайте для выбора)` 
          : `Показать слой «${kml.name}» (удерживайте для выбора)`;
        return;
      }
    }

    const currentMap = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
    const isCurrentlyTarget = (currentMap === targetMap);

    btnQuickSwap.classList.toggle('active-target', isCurrentlyTarget);
    btnQuickSwap.title = isCurrentlyTarget 
      ? `Вернуться на предыдущую карту (удерживайте для выбора второй карты)` 
      : `Переключить на «${targetMap}» (удерживайте для выбора второй карты)`;
  }
  window.updateQuickSwapUI = updateQuickSwapUI;

  function openQuickSwapTargetModal() {
    const modal = document.getElementById('modal-quick-swap-select');
    const listEl = document.getElementById('quick-swap-maps-list');
    if (!modal || !listEl || !WM.baseMapsCatalog) return;

    initQuickSwapModal();

    const currentTarget = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';
    const currentBase = localStorage.getItem('wm_base_layer') || 'Схема (Яндекс)';

    let disabledList = [];
    try {
      const stored = localStorage.getItem('wm_disabled_base_maps');
      if (stored !== null) disabledList = JSON.parse(stored) || [];
    } catch (e) {}

    listEl.innerHTML = '';

    const kmlOverlays = WM.imageOverlay && WM.imageOverlay.getKmlOverlays ? WM.imageOverlay.getKmlOverlays() : [];
    if (kmlOverlays.length > 0) {
      const kmlHeader = document.createElement('div');
      kmlHeader.style.cssText = 'padding: 6px 12px; font-size: 11px; font-weight: 700; color: var(--accent); background: var(--bg-secondary); border-bottom: 1px solid var(--border);';
      kmlHeader.textContent = '📜 МНОГОТАЙЛОВЫЕ KML КАРТЫ (ВКЛ / ВЫКЛ ПО КНОПКЕ)';
      listEl.appendChild(kmlHeader);

      kmlOverlays.forEach(kml => {
        const kmlKey = 'kml:' + kml.id;
        const isTarget = (currentTarget === kmlKey);
        const isVisible = (kml.visible !== false);

        const itemBtn = document.createElement('button');
        itemBtn.type = 'button';
        itemBtn.className = 'quick-menu-item' + (isTarget ? ' active' : '');
        itemBtn.style.padding = '10px 12px';

        itemBtn.innerHTML = `
          <span class="quick-menu-item-icon">📜</span>
          <div class="quick-menu-item-text">
            <span class="quick-menu-item-title" ${isTarget ? 'style="color:var(--accent);"' : ''}>
              ${kml.name} ${isTarget ? '✓ (Назначена на кнопку)' : ''}
            </span>
            <span class="quick-menu-item-sub">
              KML слой (${kml.tiles ? kml.tiles.length : 0} тайлов) · Статус: ${isVisible ? 'Включён' : 'Скрыт'}
            </span>
          </div>
        `;

        itemBtn.onclick = () => {
          localStorage.setItem('wm_quick_swap_target', kmlKey);
          updateQuickSwapUI();
          if (WM.ui && WM.ui.updateQuickSwapTargetBtn) {
            WM.ui.updateQuickSwapTargetBtn();
          }
          modal.classList.remove('open');
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`🔀 На кнопку назначена KML-карта: ${kml.name}`);
          }
        };

        listEl.appendChild(itemBtn);
      });

      const baseHeader = document.createElement('div');
      baseHeader.style.cssText = 'padding: 6px 12px; font-size: 11px; font-weight: 700; color: var(--text-muted); background: var(--bg-secondary); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);';
      baseHeader.textContent = '🗺️ БАЗОВЫЕ ПОДЛОЖКИ КАРТ';
      listEl.appendChild(baseHeader);
    }

    const availableMaps = WM.baseMapsCatalog.filter(m => !disabledList.includes(m.name));
    const mapsToDisplay = availableMaps.length ? availableMaps : WM.baseMapsCatalog;

    mapsToDisplay.forEach(m => {
      const isTarget = (m.name === currentTarget);
      const isCurrentActive = (m.name === currentBase);

      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'quick-menu-item' + (isTarget ? ' active' : '');
      itemBtn.style.padding = '10px 12px';

      const icon = m.category === 'historical' ? '📜' : (m.name.includes('Спутник') ? '🛰️' : '🗺️');

      itemBtn.innerHTML = `
        <span class="quick-menu-item-icon">${icon}</span>
        <div class="quick-menu-item-text">
          <span class="quick-menu-item-title" ${isTarget ? 'style="color:var(--accent);"' : ''}>
            ${m.name} ${isTarget ? '✓ (Активная вторая)' : (isCurrentActive ? ' (Текущая)' : '')}
          </span>
          <span class="quick-menu-item-sub">${m.category === 'historical' ? 'Историческая карта' : 'Современная карта'}</span>
        </div>
      `;

      itemBtn.onclick = () => {
        localStorage.setItem('wm_quick_swap_target', m.name);
        updateQuickSwapUI();
        if (WM.ui && WM.ui.updateQuickSwapTargetBtn) {
          WM.ui.updateQuickSwapTargetBtn();
        }
        modal.classList.remove('open');
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`🔀 Вторая карта: ${m.name}`);
        }
      };

      listEl.appendChild(itemBtn);
    });

    modal.classList.add('open');
  }

  window.openQuickSwapTargetModal = openQuickSwapTargetModal;
  WM.openQuickSwapTargetModal = openQuickSwapTargetModal;

  // Обработчики быстрой смены карты
  let swapHoldTimer = null;
  let isSwapLongPressed = false;
  let swapTouchStartPt = null;

  btnQuickSwap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openQuickSwapTargetModal();
  });

  btnQuickSwap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    isSwapLongPressed = false;
    const t = e.touches[0];
    swapTouchStartPt = { x: t.clientX, y: t.clientY };
    clearTimeout(swapHoldTimer);

    swapHoldTimer = setTimeout(() => {
      isSwapLongPressed = true;
      if (navigator.vibrate) navigator.vibrate(40);
      openQuickSwapTargetModal();
    }, 450);
  }, { passive: true });

  btnQuickSwap.addEventListener('touchmove', (e) => {
    if (!swapTouchStartPt) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - swapTouchStartPt.x, t.clientY - swapTouchStartPt.y) > 10) {
      clearTimeout(swapHoldTimer);
    }
  }, { passive: true });

  btnQuickSwap.addEventListener('touchend', (e) => {
    clearTimeout(swapHoldTimer);
    swapTouchStartPt = null;
    if (isSwapLongPressed) {
      e.preventDefault();
      setTimeout(() => { isSwapLongPressed = false; }, 300);
    }
  });

  btnQuickSwap.addEventListener('touchcancel', () => {
    clearTimeout(swapHoldTimer);
    swapTouchStartPt = null;
    isSwapLongPressed = false;
  });

  let mouseHoldTimer = null;
  let mouseIsLong = false;

  btnQuickSwap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mouseIsLong = false;
    clearTimeout(mouseHoldTimer);
    mouseHoldTimer = setTimeout(() => {
      mouseIsLong = true;
      openQuickSwapTargetModal();
    }, 450);
  });
  btnQuickSwap.addEventListener('mouseup', () => clearTimeout(mouseHoldTimer));
  btnQuickSwap.addEventListener('mouseleave', () => clearTimeout(mouseHoldTimer));

  btnQuickSwap.onclick = (e) => {
    if (isSwapLongPressed || mouseIsLong) {
      mouseIsLong = false;
      return;
    }

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

    if (targetMap.startsWith('kml:')) {
      const kmlId = targetMap.slice(4);
      const kml = WM.imageOverlay && WM.imageOverlay.getOverlay ? WM.imageOverlay.getOverlay(kmlId) : null;
      if (kml && WM.imageOverlay.toggleOverlayVisibility) {
        const isVisible = WM.imageOverlay.toggleOverlayVisibility(kmlId);
        updateQuickSwapUI();
        WM.ui.showToast(isVisible ? `📜 «${kml.name}» включена` : `🕶️ «${kml.name}» скрыта`);
      } else {
        WM.ui.showToast('⚠️ KML-карта не найдена или была удалена');
      }
      return;
    }

    const currentMap = localStorage.getItem('wm_base_layer') || 'Схема (Яндекс)';
    const prevMap = localStorage.getItem('wm_quick_swap_previous') || 'Схема (Яндекс)';

    if (currentMap !== targetMap) {
      localStorage.setItem('wm_quick_swap_previous', currentMap);
      switchToBaseMap(targetMap);
      WM.ui.showToast(`🔀 Карта: ${targetMap}`);
    } else {
      const returnMap = (prevMap && prevMap !== targetMap) ? prevMap : 'Схема (Яндекс)';
      switchToBaseMap(returnMap);
      WM.ui.showToast(`🔀 Возврат: ${returnMap}`);
    }
  };

  updateQuickSwapUI();

  map.on('baselayerchange', (e) => {
    localStorage.setItem('wm_base_layer', e.name);
  });

  // =========================================================================
  // НАКЛАДЫВАЕМЫЕ СЛОИ (OVERLAYS)
  // =========================================================================
  const esriHillshade = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    pane: 'wm-hillshade-pane',
    maxNativeZoom: 16,
    maxZoom: 20,
    opacity: 0.65,
    className: 'wm-relief-tile wm-relief-hillshade',
    attribution: 'Esri Hillshade'
  });

  const esriShadedRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    pane: 'wm-hillshade-pane',
    maxNativeZoom: 13,
    maxZoom: 20,
    opacity: 0.70,
    className: 'wm-relief-tile wm-relief-shaded',
    attribution: 'Esri Shaded Relief'
  });

  const MapsForFreeLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const z = this._getZoomForUrl();
      return `https://maps-for-free.com/layer/relief/z${z}/row${coords.y}/${z}_${coords.x}-${coords.y}.jpg`;
    }
  });

  const mffRelief = new MapsForFreeLayer('', {
    ...COMMON_TILE_OPTIONS,
    pane: 'wm-hillshade-pane',
    minZoom: 0,
    maxNativeZoom: 11,
    maxZoom: 20,
    opacity: 0.75,
    className: 'wm-relief-tile wm-relief-mff',
    attribution: '© Maps-For-Free (CC0)'
  });

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
    keepBuffer: 2,
    pane: 'wm-raster-pane',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    maxNativeZoom: 18,
    maxZoom: 20,
    opacity: 1.0,
    className: 'wm-raster-tile'
  });

  let isContoursEnabled = localStorage.getItem('wm_overlay_contours') !== 'false';
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

    const currentZoom = map.getZoom();

    if (currentZoom >= 18) {
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

      if (currentZoom >= C.VECTOR_ZOOM) {
        wmContours.setOpacity(0.6);
      } else {
        wmContours.setOpacity(1.0);
      }
    }
  }

  window.syncRasterOverlay = syncOverlayMode;
  map.on('zoomend', syncOverlayMode);

  let isHillshadeEnabled = localStorage.getItem('wm_overlay_hillshade') === 'true';
  if (isHillshadeEnabled) esriHillshade.addTo(map);

  let isShadedReliefEnabled = localStorage.getItem('wm_overlay_shaded_relief') === 'true';
  if (isShadedReliefEnabled) esriShadedRelief.addTo(map);

  let isMffReliefEnabled = localStorage.getItem('wm_overlay_mff_relief') === 'true';
  if (isMffReliefEnabled) mffRelief.addTo(map);

  map.createPane('wm-inaturalist');
  map.getPane('wm-inaturalist').style.zIndex = 435;
  const inatLayer = L.layerGroup();
  const isInatEnabled = localStorage.getItem('wm_overlay_inat') === 'true';
  if (isInatEnabled) inatLayer.addTo(map);

  map.createPane('wm-geocaching');
  map.getPane('wm-geocaching').style.zIndex = 430;
  const geocachingLayer = L.layerGroup();
  const isGeocachingEnabled = localStorage.getItem('wm_overlay_geocaching') === 'true';
  if (isGeocachingEnabled) geocachingLayer.addTo(map);

  const vectorPolygonsLayer = L.layerGroup();
  let isVectorsEnabled = localStorage.getItem('wm_overlay_vectors') !== 'false';
  if (isVectorsEnabled) vectorPolygonsLayer.addTo(map);

  const overlayLayers = {
    'Контуры Wikimapia': wmContours,
    'Полигоны Wikimapia (вектор)': vectorPolygonsLayer,
    'Рельеф: Тени (Esri)': esriHillshade,
    'Рельеф: Гипсометрия (Esri)': esriShadedRelief,
    'Рельеф: Художественный SRTM': mffRelief,
    'Тайники (Geocaching.su)': geocachingLayer,
    'Растения и грибы (iNaturalist)': inatLayer // <-- Добавлено
  };

  map.on('overlayadd', (e) => {
    if (isProgrammaticLayerChange) return;
    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = true;
      localStorage.setItem('wm_overlay_contours', 'true');
      syncOverlayMode();
    } else if (e.name === 'Полигоны Wikimapia (вектор)') {
      isVectorsEnabled = true; // БЫЛО: false
      localStorage.setItem('wm_overlay_vectors', 'true'); // БЫЛО: 'false'
      WM.view.setVisible(true); // БЫЛО: false
      refreshStatus();
    } else if (e.name.includes('Тени (Esri)')) {
      localStorage.setItem('wm_overlay_hillshade', 'true');
    } else if (e.name.includes('Гипсометрия (Esri)')) {
      localStorage.setItem('wm_overlay_shaded_relief', 'true');
    } else if (e.name.includes('Художественный SRTM')) {
      localStorage.setItem('wm_overlay_mff_relief', 'true');
    } else if (e.name === 'Тайники (Geocaching.su)') {
      localStorage.setItem('wm_overlay_geocaching', 'true');
      if (WM.geocaching && WM.geocaching.enable) WM.geocaching.enable();
    }
    if (e.name === 'Растения и грибы (iNaturalist)') {
      localStorage.setItem('wm_overlay_inat', 'true');
      if (WM.inat && WM.inat.enable) WM.inat.enable();
    }
  });

  map.on('overlayremove', (e) => {
    if (isProgrammaticLayerChange) return;
    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = false;
      localStorage.setItem('wm_overlay_contours', 'false');
      syncOverlayMode();
    } else if (e.name === 'Полигоны Wikimapia (вектор)') {
      isVectorsEnabled = false; // БЫЛО: true
      localStorage.setItem('wm_overlay_vectors', 'false'); // БЫЛО: 'true'
      WM.view.setVisible(false); // БЫЛО: true
      refreshStatus();
    } else if (e.name.includes('Тени (Esri)')) {
      localStorage.setItem('wm_overlay_hillshade', 'false');
    } else if (e.name.includes('Гипсометрия (Esri)')) {
      localStorage.setItem('wm_overlay_shaded_relief', 'false');
    } else if (e.name.includes('Художественный SRTM')) {
      localStorage.setItem('wm_overlay_mff_relief', 'false');
    } else if (e.name === 'Тайники (Geocaching.su)') {
      localStorage.setItem('wm_overlay_geocaching', 'false');
      if (WM.geocaching && WM.geocaching.disable) WM.geocaching.disable();
    }
    if (e.name === 'Растения и грибы (iNaturalist)') {
      localStorage.setItem('wm_overlay_inat', 'false');
      if (WM.inat && WM.inat.disable) WM.inat.disable();
    }
  });

  rebuildBaseLayersControl();

  WM.map = map;

  WM.view.init(map);
  WM.view.setVisible(isVectorsEnabled);
  WM.picker.init(map);
  if (WM.ui && WM.ui.init) WM.ui.init();
  
  const savedMode = (WM.api && WM.api.store) ? (WM.api.store.get('wm_mode') || 'cross') : 'cross';
  WM.picker.setMode(savedMode);

  if (WM.ui && WM.ui.updateMotionBtnState) WM.ui.updateMotionBtnState();
  if (WM.ui && WM.ui.updateManualPdrBtnState) WM.ui.updateManualPdrBtnState();

  await WM.cache.init();

  if (WM.markers) WM.markers.init();
  if (WM.sharedMarkers) WM.sharedMarkers.init(map);
  if (WM.measure) WM.measure.init();
  if (WM.quickMeasure) WM.quickMeasure.init(map);
  if (WM.shadowHeight) WM.shadowHeight.init(map);
  if (WM.rangeRing) WM.rangeRing.init(map);
  if (WM.geocaching) {
    WM.geocaching.init(map, geocachingLayer);
    if (isGeocachingEnabled) WM.geocaching.enable();
  }
  if (WM.inat) {
    WM.inat.init(map, inatLayer);
    if (isInatEnabled) WM.inat.enable();
  }

  if (WM.imageOverlay) {
    await WM.imageOverlay.init(map);
  }

  syncOverlayMode();

  function refreshStatus() {
    if (!WM.ui || typeof WM.ui.setStatus !== 'function') return;

    const isVectors = WM.view && WM.view.isVisible ? WM.view.isVisible() : true;

    // --- ЕСЛИ ВЕКТОРНЫЙ СЛОЙ ВЫКЛЮЧЕН — ПОЛНОСТЬЮ СКРЫВАЕМ ПЛАШКУ СТАТУСА ---
    if (!isVectors) {
      WM.ui.setStatus(''); // скрываем элемент
      return;
    }

    const s = WM.loader.stats();
    const mode = WM.ui.getWorkMode ? WM.ui.getWorkMode() : 'manual';
    const autoHover = WM.ui.isAutoHoverEnabled ? WM.ui.isAutoHoverEnabled() : false;

    if (WM.ui.toggleTopGetKeyBtn) {
      WM.ui.toggleTopGetKeyBtn(!!s.isRateWaiting || (!!s.blocked && /ключ|key|limit|quota/i.test(s.blocked)));
    }

    if (s.blocked) return WM.ui.setStatus('⚠ ' + s.blocked, true);
    if (s.isRateWaiting) return WM.ui.setStatus(`⏳ Лимит ключей\nПауза: ${WM.ui.fmtTimer ? WM.ui.fmtTimer(s.waitMs) : ''}`, true);

    if (mode === 'manual') {
      let t = `Ручной режим (только растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'}`;
      t += ` · в памяти: ${WM.view.count()}`;
      if (s.detailsQueueCount > 0) t += `\n📥 Карточки: в очереди ${s.detailsQueueCount}`;
      return WM.ui.setStatus(t);
    }

    if (map.getZoom() < C.MIN_ZOOM) return WM.ui.setStatus(`Масштаб < ${C.MIN_ZOOM}\n(приблизьте карту)`);

    if (mode === 'hybrid' && map.getZoom() < C.VECTOR_ZOOM) {
      let t = `Гибридный режим (растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'}`;
      t += ` · в памяти: ${WM.view.count()}`;
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

  let isRenderScheduled = false;
  let lastRenderTime = 0;

  const scheduleRender = () => {
    if (isRenderScheduled) return;
    isRenderScheduled = true;

    requestAnimationFrame((now) => {
      const minInterval = L.Browser.mobile ? 180 : 100;
      const elapsed = now - lastRenderTime;

      if (elapsed < minInterval) {
        setTimeout(() => {
          isRenderScheduled = false;
          scheduleRender();
        }, minInterval - elapsed);
        return;
      }

      isRenderScheduled = false;
      lastRenderTime = now;
      WM.view.render();
      refreshStatus();
      WM.picker.refresh();
    });
  };

  WM.loader.init(map, { onChange: scheduleRender, onStatus: refreshStatus });

  map.getContainer().addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) {
      document.body.classList.add('leaflet-touching');
    }
  }, { passive: true });

  map.getContainer().addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      document.body.classList.remove('leaflet-touching');
    }
  }, { passive: true });

  map.on('movestart zoomstart', () => {
    if (WM.loader && WM.loader.stopDetailsQueue) {
      WM.loader.stopDetailsQueue();
    }
  });

  let moveTimer = 0;
  map.on('moveend zoomend', () => {
    scheduleRender();

    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => WM.loader.update(), 250);
    try {
      const c = map.getCenter();
      localStorage.setItem('wm_view', JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom() }));
    } catch (e) {}
  });

  window.addEventListener('online', () => WM.loader.retryNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) WM.loader.retryNow(); });

  // =========================================================================
  // МОДУЛЬ «ХВОСТ ДВИЖЕНИЯ» (GPS MOTION TAIL)
  // =========================================================================
  const motionTailLayer = L.layerGroup().addTo(map);
  const tailPoints = [];

  let isTailEnabled = true;
  let tailMaxPoints = 15;
  let tailColor = '#0284c7';

  try {
    const savedVis = JSON.parse(localStorage.getItem('wm_ui_vis') || '{}');
    if (savedVis.motiontail !== undefined) {
      isTailEnabled = (savedVis.motiontail !== false);
    } else {
      const savedEn = localStorage.getItem('wm_tail_enabled');
      if (savedEn !== null) isTailEnabled = (savedEn !== 'false');
    }
    const savedLen = localStorage.getItem('wm_tail_length');
    if (savedLen) tailMaxPoints = Math.max(5, Math.min(50, parseInt(savedLen, 10) || 15));
    const savedCol = localStorage.getItem('wm_tail_color');
    if (savedCol) tailColor = savedCol;
  } catch (e) {}

  function clearTail() {
    tailPoints.length = 0;
    motionTailLayer.clearLayers();
  }

  function redrawTail() {
    motionTailLayer.clearLayers();
    if (!isTailEnabled || tailPoints.length < 2) return;

    const totalSegs = tailPoints.length - 1;
    for (let i = 0; i < totalSegs; i++) {
      const p1 = tailPoints[i].latlng;
      const p2 = tailPoints[i + 1].latlng;
      const progress = (i + 1) / totalSegs;

      const opacity = 0.2 + progress * 0.75;
      const weight = 2.5 + progress * 2.5;

      L.polyline([p1, p2], {
        pane: 'wm-top-lines',
        color: tailColor,
        weight: weight,
        opacity: opacity,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(motionTailLayer);

      if (i > 0) {
        L.circleMarker(p1, {
          pane: 'wm-top-lines',
          radius: 1.5 + progress * 2,
          color: tailColor,
          fillColor: tailColor,
          fillOpacity: opacity,
          weight: 1,
          interactive: false
        }).addTo(motionTailLayer);
      }
    }
  }

  function addPointToTail(latlng, coords, timestamp) {
    const newLL = L.latLng(latlng[0], latlng[1]);
    const now = timestamp || Date.now();
    const accuracy = (coords && coords.accuracy) || 10;

    if (accuracy > 40) return;

    if (tailPoints.length > 0) {
      const last = tailPoints[tailPoints.length - 1];
      const dist = last.latlng.distanceTo(newLL);
      const dt = (now - last.time) / 1000;

      const minDistance = Math.max(3.8, Math.min(10, accuracy * 0.45));
      if (dist < minDistance) {
        return;
      }

      const impliedSpeedKmh = dt > 0 ? (dist / dt) * 3.6 : 0;
      if (dt > 150 || (dist > 500 && impliedSpeedKmh > 180)) {
        clearTail();
      }
    }

    tailPoints.push({ latlng: newLL, time: now, accuracy });

    while (tailPoints.length > tailMaxPoints) {
      tailPoints.shift();
    }

    if (isTailEnabled) {
      redrawTail();
    }
  }

  WM.motionTail = {
    isEnabled: () => isTailEnabled,
    setEnabled(val) {
      isTailEnabled = !!val;
      try { localStorage.setItem('wm_tail_enabled', isTailEnabled ? 'true' : 'false'); } catch (e) {}
      if (!isTailEnabled) {
        motionTailLayer.clearLayers();
      } else {
        redrawTail();
      }
    },
    getLength: () => tailMaxPoints,
    setLength(val) {
      tailMaxPoints = Math.max(5, Math.min(50, parseInt(val, 10) || 15));
      try { localStorage.setItem('wm_tail_length', tailMaxPoints.toString()); } catch (e) {}
      while (tailPoints.length > tailMaxPoints) tailPoints.shift();
      redrawTail();
    },
    getColor: () => tailColor,
    setColor(val) {
      if (val) tailColor = val;
      try { localStorage.setItem('wm_tail_color', tailColor); } catch (e) {}
      redrawTail();
    },
    clear: clearTail,
    addPoint: addPointToTail
  };

  // =========================================================================
  // ИНДИКАЦИЯ СОСТОЯНИЯ ПОИСКА НА КНОПКЕ ГЕОПОЗИЦИИ
  // =========================================================================
  function updateLocationBtnSearching(isSearching) {
    const btn = document.getElementById('btn-location');
    if (!btn) return;
    btn.classList.toggle('searching', !!isSearching);
    if (isSearching) {
      btn.title = '🛰️ Определение геопозиции…';
    } else {
      btn.title = isFollowMode 
        ? '🎯 Слежение активно (удерживайте или сдвиньте карту для отключения)'
        : '🛰️ Моя геопозиция (удерживайте для слежения)';
    }
  }

  // =========================================================================
  // СИСТЕМА ЗАЩИТЫ ОТ ГЛУШИЛОК GPS (АНТИСПУФИНГ) И АВТОНОМНЫЙ ШАГОМЕР (PDR)
  // =========================================================================


  let isAntiSpoofEnabled = localStorage.getItem('wm_gps_anti_spoof') !== 'false';
  let isManualPdrActive = false;
  let isSpoofed = false;
  let lastGoodGpsFix = null;
  let cleanGpsSamplesCount = 0;
  let rawGpsPointsBuffer = [];

  const spoofPanelEl = document.getElementById('spoof-alert-panel');
  const spoofReasonEl = document.getElementById('spoof-alert-reason');
  const limitRowEl = document.getElementById('limit-row');
  const btnManualPdr = document.getElementById('btn-manual-pdr');

  let isPdrStepPillEnabled = localStorage.getItem('wm_pdr_step_pill') === 'true';
  let pdrSessionSteps = 0;
  let pdrSessionDist = 0;

  function updatePdrStepPill() {
    const pill = document.getElementById('pdr-step-pill');
    if (!pill) return;

    const isPdrActive = WM.pdr && WM.pdr.isActive();
    if (!isPdrStepPillEnabled || !isPdrActive) {
      pill.hidden = true;
      return;
    }

    pill.hidden = false;
    const pdrCfg = WM.pdr.getConfig ? WM.pdr.getConfig() : {};
    const isVehicular = pdrCfg && pdrCfg.navigationType === 'vehicular';

    const stepsEl = document.getElementById('pdr-pill-steps');
    const distEl = document.getElementById('pdr-pill-dist');
    const textEl = pill.querySelector('.pdr-pill-text');
    const iconEl = pill.querySelector('.pdr-pill-icon');

    const distFmt = pdrSessionDist >= 1000 
      ? (pdrSessionDist / 1000).toFixed(2) + ' км' 
      : Math.round(pdrSessionDist) + ' м';

    if (isVehicular) {
      if (iconEl) iconEl.textContent = '🚗';
      if (textEl) textEl.textContent = 'Ведение:';
      if (stepsEl) stepsEl.textContent = distFmt;
      if (distEl) distEl.textContent = `· ${pdrCfg.vehicularSpeedKmh || 18} км/ч`;
    } else {
      if (iconEl) iconEl.textContent = '🧲';
      if (textEl) textEl.textContent = 'Шагомер:';
      if (stepsEl) stepsEl.textContent = `${pdrSessionSteps} ш.`;
      if (distEl) distEl.textContent = `(${distFmt})`;
    }
  }

  WM.setPdrStepPillEnabled = function(val) {
    isPdrStepPillEnabled = !!val;
    updatePdrStepPill();
  };
  WM.updatePdrStepPill = updatePdrStepPill;

  function setSpoofState(spoofed, reason = '') {
    isSpoofed = spoofed;
    const pdrCfg = WM.pdr ? WM.pdr.getConfig() : {};

    if (isSpoofed) {
      if (limitRowEl) limitRowEl.style.display = 'none';
      if (spoofPanelEl) spoofPanelEl.hidden = false;
      if (spoofReasonEl) spoofReasonEl.textContent = reason || 'Глушение сигнала';

      if (pdrCfg.autoEngageOnSpoof && WM.pdr && !WM.pdr.isActive()) {
        startPdrTracking();
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('🛡️ Глушение GPS! Автоматически включён шагомер PDR', 2800);
        }
      }
    } else {
      if (spoofPanelEl) spoofPanelEl.hidden = true;
      if (limitRowEl && (WM.ui && WM.ui.uiVis ? WM.ui.uiVis.limit !== false : true)) {
        limitRowEl.style.display = '';
      }
      if (!isManualPdrActive && WM.pdr && WM.pdr.isActive()) {
        stopPdrTracking();
      }
    }
    if (WM.ui && WM.ui.updateManualPdrBtnState) WM.ui.updateManualPdrBtnState();
  }

  // Интеллектуальный фильтр отсева спуфинга и глушения GPS
  function validateGpsPoint(targetLL, coords, timestamp) {
    if (!isAntiSpoofEnabled) {
      if (isSpoofed) setSpoofState(false);
      lastGoodGpsFix = {
        ll: targetLL,
        time: timestamp || Date.now(),
        alt: coords ? coords.altitude : null,
        speed: coords ? coords.speed : 0
      };
      return true;
    }

    const now = timestamp || Date.now();
    const accuracy = (coords && coords.accuracy != null) ? coords.accuracy : 10;
    const speed = (coords && coords.speed != null && coords.speed >= 0) ? coords.speed : 0;
    const altitude = coords ? coords.altitude : null;

    // 1. Первая точка сессии: разрешаем погрешность до 2000 м для первого захвата района
    if (!lastGoodGpsFix) {
      if (accuracy > 2500) {
        return false;
      }
      lastGoodGpsFix = { ll: targetLL, time: now, alt: altitude, speed: speed };
      cleanGpsSamplesCount = 1;
      return true;
    }

    // 2. Отсекаем координаты с критически недостоверной погрешностью (>450 м для установившегося режима)
    if (accuracy > 450) {
      return false;
    }

    if (speed > 2.0 && WM.pdr) {
      const spdKmh = Math.round(speed * 3.6);
      WM.pdr.setConfig({ vehicularSpeedKmh: spdKmh });
    }

    const dt = Math.max(0.1, (now - lastGoodGpsFix.time) / 1000);
    const dist = lastGoodGpsFix.ll.distanceTo(targetLL);
    const impliedSpeed = dist / dt;

    if (dt > 90) {
      lastGoodGpsFix = { ll: targetLL, time: now, alt: altitude, speed: speed };
      cleanGpsSamplesCount = 1;
      if (isSpoofed) setSpoofState(false);
      return true;
    }

    // 3. Анализ телепортации и аномалий
    const MAX_REALISTIC_SPEED = 55; // ~200 км/ч
    let isAnomalous = false;
    let anomalyReason = '';

    if (dist > 350 && impliedSpeed > MAX_REALISTIC_SPEED) {
      isAnomalous = true;
      anomalyReason = `Скачок на ${dist > 1000 ? (dist / 1000).toFixed(1) + ' км' : Math.round(dist) + ' м'} (${Math.round(impliedSpeed * 3.6)} км/ч)`;
    } else if (speed > 65) {
      isAnomalous = true;
      anomalyReason = `Аномальная скорость (${Math.round(speed * 3.6)} км/ч)`;
    } else if (altitude !== null && lastGoodGpsFix.alt !== null) {
      const dAlt = Math.abs(altitude - lastGoodGpsFix.alt);
      if (dAlt > 600 && (dAlt / dt) > 80) {
        isAnomalous = true;
        anomalyReason = `Резкий скачок высоты (${Math.round(dAlt)} м)`;
      }
    }

    if (isAnomalous) {
      cleanGpsSamplesCount = 0;
      setSpoofState(true, anomalyReason);
      return false;
    }

    cleanGpsSamplesCount++;
    if (isSpoofed) {
      if (cleanGpsSamplesCount >= 3) {
        setSpoofState(false);
        lastGoodGpsFix = { ll: targetLL, time: now, alt: altitude, speed: speed };
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Сигнал GPS нормализовался');
        return true;
      }
      return false;
    }

    lastGoodGpsFix = { ll: targetLL, time: now, alt: altitude, speed: speed };
    return true;
  }

  function onPdrStepTaken(strideMeters, headingDeg, count, deltaAlt, currentAlt) {
    pdrSessionSteps++;
    pdrSessionDist += strideMeters;
    updatePdrStepPill();

    if (!userLatLng) return;

    let effectiveHeading = (headingDeg !== null && !isNaN(headingDeg)) 
      ? headingDeg 
      : (currentHeading !== null ? currentHeading : 0);

    const rad = (effectiveHeading * Math.PI) / 180;
    const dLat = (strideMeters * Math.cos(rad)) / 111320;
    const cosLat = Math.cos((userLatLng[0] * Math.PI) / 180) || 1;
    const dLng = (strideMeters * Math.sin(rad)) / (111320 * cosLat);

    const nextLL = [userLatLng[0] + dLat, userLatLng[1] + dLng];
    
    const pdrCfg = WM.pdr ? WM.pdr.getConfig() : {};
    const speedMps = pdrCfg.navigationType === 'vehicular' 
      ? ((pdrCfg.vehicularSpeedKmh || 18) / 3.6) 
      : (strideMeters / 0.65);

    const syntheticCoords = {
      latitude: nextLL[0],
      longitude: nextLL[1],
      altitude: Math.round(currentAlt),
      accuracy: 5,
      speed: speedMps,
      heading: effectiveHeading,
      timestamp: Date.now()
    };

    setGpsCoords(nextLL, syntheticCoords, syntheticCoords.timestamp, true);

    if (WM.pdr && WM.pdr.updateRegionCoordinates) {
      WM.pdr.updateRegionCoordinates(nextLL[0], nextLL[1]);
    }
  }

  function startPdrTracking() {
    if (!WM.pdr) return;
    pdrSessionSteps = 0;
    pdrSessionDist = 0;
    updatePdrStepPill();
    if (userLatLng && WM.pdr.updateRegionCoordinates) {
      WM.pdr.updateRegionCoordinates(userLatLng[0], userLatLng[1]);
    }
    WM.pdr.start(onPdrStepTaken, (heading) => {
      if (currentHeading !== null) {
        updateCompassVisuals();
      }
    });
    if (btnManualPdr) btnManualPdr.classList.add('pdr-walking');
    syncWakeLockState();
    updatePdrStepPill();
  }

  function stopPdrTracking() {
    if (WM.pdr && WM.pdr.stop) WM.pdr.stop();
    if (btnManualPdr) btnManualPdr.classList.remove('pdr-walking');
    syncWakeLockState();
    syncGpsWatchState();
    pdrSessionSteps = 0;
    pdrSessionDist = 0;
    updatePdrStepPill();
  }

  WM.manualPdr = {
    isActive: () => isManualPdrActive,
    toggle() {
      if (isManualPdrActive || isSpoofed) {
        isManualPdrActive = false;
        setSpoofState(false);
        lastGoodGpsFix = null;
        rawGpsPointsBuffer = [];
        cleanGpsSamplesCount = 0;
        stopPdrTracking();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛰️ Возврат к штатному GPS');
      } else {
        isManualPdrActive = true;
        const c = map.getCenter();
        const ll = [c.lat, c.lng];
        lastGoodGpsFix = { ll: L.latLng(ll[0], ll[1]), time: Date.now(), alt: null, speed: 0 };
        setGpsCoords(ll, { latitude: ll[0], longitude: ll[1], accuracy: 5, speed: 0, heading: currentHeading || 0 }, Date.now(), true);
        startPdrTracking();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🧲 Позиция привязана к центру. Шагомер активен!');
      }
      if (WM.ui && WM.ui.updateManualPdrBtnState) WM.ui.updateManualPdrBtnState();
    }
  };

  WM.antiSpoof = {
    isEnabled: () => isAntiSpoofEnabled,
    setEnabled(v) { 
      isAntiSpoofEnabled = !!v; 
      if (!v) setSpoofState(false); 
    },
    setDeadReckoningEnabled(v) {
      if (WM.pdr) {
        WM.pdr.setConfig({ autoEngageOnSpoof: !!v });
      }
    },
    isSpoofed: () => isSpoofed,
    reset: () => {
      setSpoofState(false);
      lastGoodGpsFix = null;
      rawGpsPointsBuffer = [];
      cleanGpsSamplesCount = 0;
    }
  };

  const spoofPanel = document.getElementById('spoof-alert-panel');
  if (spoofPanel) {
    spoofPanel.addEventListener('click', (e) => {
      if (e.target.closest('.spoof-alert-actions') || e.target.closest('button')) return;
      if (window.openPdrQuickModal) {
        window.openPdrQuickModal();
      }
    });
  }

  // Клик по нижней плашке шагов также открывает быстрое меню PDR
  const pdrStepPill = document.getElementById('pdr-step-pill');
  if (pdrStepPill) {
    pdrStepPill.addEventListener('click', () => {
      if (window.openPdrQuickModal) {
        window.openPdrQuickModal();
      }
    });
  }

  document.querySelectorAll('#btn-i-am-here, .btn-i-am-here').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = map.getCenter();
      const ll = [c.lat, c.lng];
      lastGoodGpsFix = { ll: L.latLng(ll[0], ll[1]), time: Date.now(), alt: null, speed: 0 };
      setGpsCoords(ll, { latitude: ll[0], longitude: ll[1], accuracy: 5, speed: 0, heading: currentHeading || 0 }, Date.now(), true);
      isManualPdrActive = true;
      startPdrTracking();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🧲 Позиция привязана к центру перекрестия');
      if (WM.ui && WM.ui.updateManualPdrBtnState) WM.ui.updateManualPdrBtnState();
    });
  });

  document.getElementById('btn-spoof-probe')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const probeBtn = document.getElementById('btn-spoof-probe');
    if (probeBtn) probeBtn.classList.add('loading');
    acquireLocation(
      () => {
        if (probeBtn) probeBtn.classList.remove('loading');
        if (!isSpoofed && WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Сигнал проверен: глушения нет');
      },
      (err) => {
        if (probeBtn) probeBtn.classList.remove('loading');
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Ошибка GPS: ' + err.message);
      }
    );
  });

  document.getElementById('btn-spoof-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    WM.antiSpoof.reset();
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('Тревога глушения снята вручную');
  });

  // =========================================================================
  // МОДУЛЬ КОМПАСА И ОРИЕНТАЦИИ УСТРОЙСТВА
  // =========================================================================
  let me = null;
  let userLatLng = null;

  let currentHeading = null;
  let isOrientationListening = false;
  let smoothConeAngle = 0;
  let smoothNeedleAngle = 0;
  let isConeEnabled = false;
  let isNeedleEnabled = false;

  function unwrapAngle(target, current) {
    let diff = (target - current) % 360;
    if (diff < -180) diff += 360;
    if (diff > 180) diff -= 360;
    return current + diff;
  }

  let orientationRafId = 0;
  let pendingHeading = null;

  function computeCleanHeading(e) {
    if (typeof e.webkitCompassHeading === 'number') {
      return (e.webkitCompassHeading + 360) % 360;
    }

    if (e.alpha === null || e.alpha === undefined) return null;

    const degToRad = Math.PI / 180;
    const alpha = (e.alpha || 0) * degToRad; // Z (азимут)
    const beta  = (e.beta  || 0) * degToRad; // X (наклон вперед-назад)
    const gamma = (e.gamma || 0) * degToRad; // Y (крен влево-вправо)

    const cA = Math.cos(alpha), sA = Math.sin(alpha);
    const cB = Math.cos(beta),  sB = Math.sin(beta);
    const cG = Math.cos(gamma), sG = Math.sin(gamma);

    // Вычисляем компоненты горизонтального вектора без скачкообразных условий
    // Матрица поворота Z-X'-Y'' проецируется на плоскость горизонта
    const worldEast  = -sA * cG - cA * sB * sG;
    const worldNorth =  cA * cG - sA * sB * sG;

    // Учет ориентации экрана (портретная/альбомная)
    const screenAngle = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * degToRad;
    const cosS = Math.cos(screenAngle);
    const sinS = Math.sin(screenAngle);

    const rotEast  = worldEast * cosS - worldNorth * sinS;
    const rotNorth = worldEast * sinS + worldNorth * cosS;

    let heading = Math.atan2(rotEast, rotNorth) * (180 / Math.PI);
    return (heading + 360) % 360;
  }

  let lastCompassEvTime = 0;
  let lastDispatchedHeading = null;

  function onDeviceOrientation(e) {
    if (document.hidden) return;
    window._wmSensorEventsCount = (window._wmSensorEventsCount || 0) + 1;

    const now = performance.now();
    if (now - lastCompassEvTime < 66) return;

    const heading = computeCleanHeading(e);
    if (heading === null || isNaN(heading)) return;

    const rounded = Math.round(heading);
    
    if (lastDispatchedHeading !== null && Math.abs(rounded - lastDispatchedHeading) < 1.0 && (now - lastCompassEvTime < 250)) {
      return;
    }

    lastCompassEvTime = now;
    lastDispatchedHeading = rounded;
    pendingHeading = rounded;

    if (WM.pdr && WM.pdr.updateExternalCompass) {
      WM.pdr.updateExternalCompass(pendingHeading);
    }

    if (!orientationRafId) {
      orientationRafId = requestAnimationFrame(() => {
        orientationRafId = 0;
        const effectiveH = (WM.pdr && WM.pdr.getHeading) ? WM.pdr.getHeading() : pendingHeading;
        if (effectiveH !== null && effectiveH !== currentHeading) {
          currentHeading = effectiveH;
          updateCompassVisuals();
        }
      });
    }
  }

  let wasOrientationListeningBeforeHide = false;

  async function startOrientationListener() {
    if (isOrientationListening || document.hidden) return;
    const granted = await requestOrientationPermission();
    if (!granted) return;

    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    } else if ('ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', onDeviceOrientation, true);
    }
    isOrientationListening = true;
  }

  function stopOrientationListener() {
    if (!isOrientationListening) return;
    window.removeEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    window.removeEventListener('deviceorientation', onDeviceOrientation, true);
    isOrientationListening = false;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const isPdrActive = WM.pdr && WM.pdr.isActive();
      if (!isPdrActive) {
        stopGpsWatch();
      }
      if (isOrientationListening) {
        wasOrientationListeningBeforeHide = true;
        stopOrientationListener();
      }
      syncWakeLockState();
    } else {
      if (isFollowMode || (WM.gpsDist && WM.gpsDist.isActive()) || activeNavTarget) {
        startGpsWatch();
      }
      if (wasOrientationListeningBeforeHide && (isConeEnabled || isNeedleEnabled)) {
        wasOrientationListeningBeforeHide = false;
        startOrientationListener();
      }
      syncWakeLockState();
    }
  });

  let cachedModalAdj = null;
  let cachedAdjValEl = null;
  let cachedGpsConeEl = null;

  function updateCompassVisuals(headingOverride) {
    if (typeof headingOverride === 'number' && !isNaN(headingOverride)) {
      currentHeading = headingOverride;
    } else if (WM.pdr && WM.pdr.getHeading) {
      const pdrH = WM.pdr.getHeading();
      if (pdrH !== null && !isNaN(pdrH)) currentHeading = pdrH;
    }
    if (currentHeading === null) return;

    if (isNeedleEnabled) {
      const needle = document.getElementById('compass-needle');
      if (needle) {
        smoothNeedleAngle = unwrapAngle(-currentHeading, smoothNeedleAngle);
        needle.style.transform = `rotate(${smoothNeedleAngle}deg)`;
      }
    }

    const isVisActive = (WM.isVisualCompassActive && WM.isVisualCompassActive());
    if ((isConeEnabled || isVisActive) && me) {
      if (!cachedGpsConeEl) {
        const el = me.getElement();
        if (el) cachedGpsConeEl = el.querySelector('.wm-gps-cone');
      }
      if (cachedGpsConeEl) {
        if (isVisActive) cachedGpsConeEl.style.display = '';
        smoothConeAngle = unwrapAngle(currentHeading, smoothConeAngle);
        cachedGpsConeEl.style.transform = `rotate(${smoothConeAngle}deg)`;
      }
    }

    if (!cachedModalAdj) cachedModalAdj = document.getElementById('modal-compass-adjust');
    if (cachedModalAdj && cachedModalAdj.classList.contains('open')) {
      if (!cachedAdjValEl) cachedAdjValEl = document.getElementById('compass-adjust-cur-val');
      if (cachedAdjValEl) {
        cachedAdjValEl.textContent = `${Math.round(currentHeading)}°`;
      }
    }
  }

  async function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        return res === 'granted';
      } catch (err) {
        return false;
      }
    }
    return true;
  }

  function createGpsDivIcon() {
    const initialAngle = currentHeading !== null ? smoothConeAngle : 0;
    return L.divIcon({
      className: 'wm-gps-marker-container',
      html: `
        <div class="wm-gps-marker-wrap">
          <div class="wm-gps-cone" style="${isConeEnabled ? `transform: rotate(${initialAngle}deg);` : 'display:none;'}">
            <svg viewBox="0 0 120 120" width="120" height="120" class="wm-gps-cone-svg">
              <defs>
                <radialGradient id="wm-gps-cone-beam" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stop-color="#0284c7" stop-opacity="0.8" />
                  <stop offset="40%" stop-color="#38bdf8" stop-opacity="0.38" />
                  <stop offset="80%" stop-color="#38bdf8" stop-opacity="0.1" />
                  <stop offset="100%" stop-color="#38bdf8" stop-opacity="0" />
                </radialGradient>
              </defs>
              <path d="M 60 60 L 30 8 A 58 58 0 0 1 90 8 Z" fill="url(#wm-gps-cone-beam)" />
            </svg>
          </div>
          <div class="wm-gps-center-dot">
            <div class="wm-gps-pulse-ring"></div>
            <div class="wm-gps-core-circle"></div>
          </div>
        </div>
      `,
      iconSize: [120, 120],
      iconAnchor: [60, 60]
    });
  }

  WM.compass = {
    getHeading() { return currentHeading; },
    createGpsIcon: createGpsDivIcon,
    start: startOrientationListener,
    updateSettings(coneOn, needleOn) {
      isConeEnabled = !!coneOn;
      isNeedleEnabled = !!needleOn;

      const btnComp = document.getElementById('btn-compass');
      if (btnComp) {
        btnComp.hidden = !isNeedleEnabled;
        btnComp.style.display = isNeedleEnabled ? '' : 'none';
      }

      if (me) {
        const el = me.getElement();
        if (el) {
          const cone = el.querySelector('.wm-gps-cone');
          if (cone) {
            cone.style.display = isConeEnabled ? '' : 'none';
            cone.style.transform = `rotate(${smoothConeAngle}deg)`;
          }
        }
      }

      if (isConeEnabled || isNeedleEnabled) {
        startOrientationListener();
      } else {
        stopOrientationListener();
      }
    }
  };

  WM.compass.updateVisuals = updateCompassVisuals;
  WM.compass.ensureUserMarkerVisible = function() {
    if (!userLatLng) {
      const c = map.getCenter();
      setGpsCoords([c.lat, c.lng], { latitude: c.lat, longitude: c.lng, accuracy: 5 }, Date.now(), true);
    } else if (!me) {
      setGpsCoords(userLatLng, { latitude: userLatLng[0], longitude: userLatLng[1], accuracy: 5 }, Date.now(), true);
    }
    if (me) {
      const el = me.getElement();
      if (el) {
        const cone = el.querySelector('.wm-gps-cone');
        if (cone) cone.style.display = '';
      }
    }
    if (userLatLng) {
      map.panTo(userLatLng);
    }
  };

  try {
    const savedVis = JSON.parse(localStorage.getItem('wm_ui_vis') || '{}');
    const cone = savedVis.compasscone !== undefined ? savedVis.compasscone : true;
    const needle = savedVis.compassneedle !== undefined ? savedVis.compassneedle : true;
    WM.compass.updateSettings(cone, needle);
  } catch (e) {
    WM.compass.updateSettings(true, true);
  }

  function openCompassAdjustModal() {
    const modal = document.getElementById('modal-compass-adjust');
    if (!modal) return;

    const center = map ? map.getCenter() : { lat: 55.75, lng: 37.62 };
    const now = new Date();

    if (window.SunCalc) {
      const sunPos = SunCalc.getPosition(now, center.lat, center.lng);
      const sunAzDeg = Math.round((sunPos.azimuth * 180 / Math.PI + 180) % 360);
      const sunEl = document.getElementById('adj-sun-azimuth');
      if (sunEl) sunEl.textContent = `${sunAzDeg}°`;
      modal._currentSunAz = sunAzDeg;

      const moonPos = SunCalc.getMoonPosition(now, center.lat, center.lng);
      const moonAzDeg = Math.round((moonPos.azimuth * 180 / Math.PI + 180) % 360);
      const moonEl = document.getElementById('adj-moon-azimuth');
      if (moonEl) moonEl.textContent = `${moonAzDeg}°`;
      modal._currentMoonAz = moonAzDeg;
    }

    const curValEl = document.getElementById('compass-adjust-cur-val');
    if (curValEl) {
      const curH = (WM.pdr && WM.pdr.getHeading) ? WM.pdr.getHeading() : currentHeading;
      curValEl.textContent = curH !== null ? `${Math.round(curH)}°` : '--°';
    }

    modal.classList.add('open');
  }

  window.openCompassAdjustModal = openCompassAdjustModal;
  WM.openCompassAdjustModal = openCompassAdjustModal;

  const btnCompass = document.getElementById('btn-compass');
  if (btnCompass) {
    let compassHoldTimer = null;
    let isCompassLongPress = false;
    let lastLongPressTime = 0;
    let compassTouchStartPt = null;
    let isTouchAction = false;

    btnCompass.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isTouchAction) return;
      openCompassAdjustModal();
    });

    btnCompass.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      isTouchAction = true;
      isCompassLongPress = false;
      const t = e.touches[0];
      compassTouchStartPt = { x: t.clientX, y: t.clientY };
      clearTimeout(compassHoldTimer);

      compassHoldTimer = setTimeout(() => {
        isCompassLongPress = true;
        lastLongPressTime = Date.now();
        if (navigator.vibrate) navigator.vibrate(40);
        openCompassAdjustModal();
      }, 400);
    }, { passive: true });

    btnCompass.addEventListener('touchmove', (e) => {
      if (!compassTouchStartPt) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - compassTouchStartPt.x, t.clientY - compassTouchStartPt.y) > 10) {
        clearTimeout(compassHoldTimer);
      }
    }, { passive: true });

    btnCompass.addEventListener('touchend', (e) => {
      clearTimeout(compassHoldTimer);
      compassTouchStartPt = null;
      if (isCompassLongPress) {
        lastLongPressTime = Date.now();
        e.preventDefault();
        e.stopPropagation();
      }
      setTimeout(() => { isTouchAction = false; }, 350);
    }, { passive: false });

    btnCompass.addEventListener('touchcancel', () => {
      clearTimeout(compassHoldTimer);
      compassTouchStartPt = null;
      isCompassLongPress = false;
      isTouchAction = false;
    });

    let mouseHoldTimer = null;
    let mouseIsLong = false;

    btnCompass.addEventListener('mousedown', (e) => {
      if (isTouchAction || e.button !== 0) return;
      mouseIsLong = false;
      clearTimeout(mouseHoldTimer);
      mouseHoldTimer = setTimeout(() => {
        mouseIsLong = true;
        lastLongPressTime = Date.now();
        openCompassAdjustModal();
      }, 400);
    });
    btnCompass.addEventListener('mouseup', () => clearTimeout(mouseHoldTimer));
    btnCompass.addEventListener('mouseleave', () => clearTimeout(mouseHoldTimer));

    btnCompass.onclick = async (e) => {
      if (isCompassLongPress || mouseIsLong || (Date.now() - lastLongPressTime < 600)) {
        isCompassLongPress = false;
        mouseIsLong = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      await startOrientationListener();
      if (currentHeading !== null) {
        const arr = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
        const compDir = arr[Math.floor((currentHeading / 22.5) + 0.5) % 16];
        WM.ui.showToast(`🧭 Курс: ${Math.round(currentHeading)}° (${compDir}) · Удерживайте для юстировки`);
      } else {
        WM.ui.showToast('🧭 Калибровка сенсоров… Поверните смартфон «восьмёркой» (∞)');
      }
    };
  }

  // =========================================================================
  // ВСПОМОГАТЕЛЬНАЯ ГЕОМЕТРИЯ
  // =========================================================================
  function computeBearing(fromLL, toLL) {
    const lat1 = fromLL.lat * Math.PI / 180;
    const lat2 = toLL.lat * Math.PI / 180;
    const dLng = (toLL.lng - fromLL.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function fmtEtaTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '--:--';
    const isNeg = seconds < 0;
    const sec = Math.abs(Math.round(seconds));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const sign = isNeg ? '-' : '';

    if (h > 0) return `${sign}${h}ч ${m}м`;
    if (m > 0) return `${sign}${m} мин`;
    return `${sign}${s} сек`;
  }

  function getVisibleSegmentPoint(map, llA, llB, pad = { left: 90, right: 90, top: 110, bottom: 120 }) {
    const pA = map.latLngToContainerPoint(llA);
    const pB = map.latLngToContainerPoint(llB);
    const size = map.getSize();

    const minX = pad.left;
    const maxX = Math.max(minX + 20, size.x - pad.right);
    const minY = pad.top;
    const maxY = Math.max(minY + 20, size.y - pad.bottom);

    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;

    let t0 = 0;
    let t1 = 1;

    const p = [-dx, dx, -dy, dy];
    const q = [pA.x - minX, maxX - pA.x, pA.y - minY, maxY - pA.y];

    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) {
          return L.latLng((llA.lat + llB.lat) / 2, (llA.lng + llB.lng) / 2);
        }
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) {
          if (t > t1) return L.latLng((llA.lat + llB.lat) / 2, (llA.lng + llB.lng) / 2);
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return L.latLng((llA.lat + llB.lat) / 2, (llA.lng + llB.lng) / 2);
          if (t < t1) t1 = t;
        }
      }
    }

    if (t0 > t1) {
      return L.latLng((llA.lat + llB.lat) / 2, (llA.lng + llB.lng) / 2);
    }

    let tMid = (t0 + t1) / 2;
    const totalLen = Math.hypot(dx, dy);
    if (totalLen > 90) {
      const marginT = 36 / totalLen;
      tMid = Math.max(marginT, Math.min(1 - marginT, tMid));
    }

    const resPt = L.point(pA.x + tMid * dx, pA.y + tMid * dy);
    return map.containerPointToLatLng(resPt);
  }

  // =========================================================================
  // МОДУЛЬ «ТРАЕКТОРИЯ ДВИЖЕНИЯ» (MOTION VECTOR)
  // =========================================================================
  const motionVectorLayer = L.layerGroup().addTo(map);
  let motionVectorLine = null;
  let motionVectorBadge = null;
  let isMotionVectorEnabled = false;

  try {
    const savedVis = JSON.parse(localStorage.getItem('wm_ui_vis') || '{}');
    if (savedVis.motionvector !== undefined) isMotionVectorEnabled = !!savedVis.motionvector;
  } catch (e) {}

  let offscreenIndicatorEl = null;

  function getOffscreenIndicatorEl() {
    if (!offscreenIndicatorEl && map) {
      offscreenIndicatorEl = document.getElementById('wm-mv-offscreen-pointer');
      if (!offscreenIndicatorEl) {
        offscreenIndicatorEl = document.createElement('div');
        offscreenIndicatorEl.id = 'wm-mv-offscreen-pointer';
        offscreenIndicatorEl.className = 'wm-mv-offscreen-pointer';
        offscreenIndicatorEl.hidden = true;
        map.getContainer().appendChild(offscreenIndicatorEl);
      }
    }
    return offscreenIndicatorEl;
  }

  function hideMotionVectorOffscreenIndicator() {
    const el = getOffscreenIndicatorEl();
    if (el) el.hidden = true;
  }

  function showMotionVectorOffscreenIndicator(originLL, course) {
    if (!map) return;
    const el = getOffscreenIndicatorEl();
    if (!el) return;

    const centerLL = map.getCenter();
    const crs = L.CRS.EPSG3857;
    const O = crs.project(originLL);
    const C = crs.project(centerLL);

    const rad = course * Math.PI / 180;
    const dx = Math.sin(rad);
    const dy = Math.cos(rad);

    const wx = C.x - O.x;
    const wy = C.y - O.y;
    const t = Math.max(0, wx * dx + wy * dy);

    const Qx = O.x + t * dx;
    const Qy = O.y + t * dy;

    const vx = Qx - C.x;
    const vy = Qy - C.y;

    let bearing = Math.atan2(vx, vy) * 180 / Math.PI;
    if (bearing < 0) bearing += 360;

    const SECTORS = [
      { arrow: '↑', dx: 0,      dy: -1 },
      { arrow: '↗', dx: 0.707,  dy: -0.707 },
      { arrow: '→', dx: 1,      dy: 0 },
      { arrow: '↘', dx: 0.707,  dy: 0.707 },
      { arrow: '↓', dx: 0,      dy: 1 },
      { arrow: '↙', dx: -0.707, dy: 0.707 },
      { arrow: '←', dx: -1,     dy: 0 },
      { arrow: '↖', dx: -0.707, dy: -0.707 }
    ];

    const sectorIdx = Math.round(bearing / 45) % 8;
    const sec = SECTORS[sectorIdx];
    const radius = 48;

    const posX = Math.round(sec.dx * radius);
    const posY = Math.round(sec.dy * radius);
    const degText = Math.round(bearing) + '°';

    const distMeters = Math.hypot(vx, vy);
    const distFmt = distMeters >= 1000 ? (distMeters / 1000).toFixed(1) + ' км' : Math.round(distMeters) + ' м';

    el.innerHTML = `<span class="wm-mv-arrow">${sec.arrow}</span><span class="wm-mv-deg">${degText}</span>`;
    el.style.transform = `translate(calc(-50% + ${posX}px), calc(-50% + ${posY}px))`;
    el.title = `Траектория за экраном: ${degText} (~${distFmt}). Нажмите для центрирования на GPS`;
    el.onclick = (e) => {
      e.stopPropagation();
      map.panTo(originLL);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🧲 Переход к геопозиции');
    };
    el.hidden = false;
  }

  // =========================================================================
  // СГЛАЖИВАНИЕ И ФИЛЬТРАЦИЯ КУРСА ДВИЖЕНИЯ (COG)
  // =========================================================================
  let smoothedMotionCourse = null;
  let lastCourseUpdateTime = 0;

  function calculateRawMotionCourse(now) {
    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;

    if (WM.gpsState && WM.gpsState.heading != null && !isNaN(WM.gpsState.heading) && WM.gpsState.heading >= 0 && speed >= 0.7) {
      return WM.gpsState.heading;
    }

    if (motionHistory.length >= 2) {
      const recent = motionHistory.filter(p => now - p.time <= 10000);

      if (recent.length >= 2) {
        const pOld = recent[0].latlng;
        const pNew = recent[recent.length - 1].latlng;
        const dist = pOld.distanceTo(pNew);
        const dt = (recent[recent.length - 1].time - recent[0].time) / 1000;
        const impliedSpeed = dt > 0 ? (dist / dt) : 0;
        const effectiveSpeed = Math.max(speed, impliedSpeed);

        if (dist >= 2.0 && effectiveSpeed >= 0.35) {
          return computeBearing(pOld, pNew);
        }
      }
    }

    if (speed < 0.5 && currentHeading !== null) {
      return currentHeading;
    }

    return null;
  }

  function updateSmoothedCourse(timestamp) {
    const now = timestamp || Date.now();
    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;
    const raw = calculateRawMotionCourse(now);

    if (raw === null) return;

    if (smoothedMotionCourse === null) {
      smoothedMotionCourse = raw;
      lastCourseUpdateTime = now;
      return;
    }

    const dt = Math.min(2.0, Math.max(0.05, (now - lastCourseUpdateTime) / 1000));
    lastCourseUpdateTime = now;

    let diff = ((raw - smoothedMotionCourse + 540) % 360) - 180;
    const absDiff = Math.abs(diff);

    if (absDiff < 1.2) {
      return;
    }

    let alpha;
    let maxTurnDegPerSec;

    if (speed < 2.0) {
      alpha = 0.35;
      maxTurnDegPerSec = 35;

      if (absDiff > 35) {
        alpha = 0.60;
        maxTurnDegPerSec = 70;
      }
      if (absDiff > 90) {
        alpha = 0.85;
        maxTurnDegPerSec = 140;
      }
    } else if (speed < 7.0) {
      alpha = 0.50;
      maxTurnDegPerSec = 60;
    } else {
      alpha = 0.70;
      maxTurnDegPerSec = 100;
    }

    let step = diff * (1 - Math.pow(1 - alpha, dt));
    const maxStep = maxTurnDegPerSec * dt;

    if (Math.abs(step) > maxStep) {
      step = Math.sign(step) * maxStep;
    }

    smoothedMotionCourse = (smoothedMotionCourse + step + 360) % 360;
  }

  function getEstimatedMotionCourse() {
    updateSmoothedCourse();
    return smoothedMotionCourse !== null ? Math.round(smoothedMotionCourse * 10) / 10 : null;
  }

  let currentRenderedAngle = null;
  let targetMotionCourse = null;
  let mvAnimRafId = 0;
  let lastMvAnimTime = 0;

  function startMotionVectorAnimation() {
    if (mvAnimRafId) return;
    lastMvAnimTime = performance.now();
    stepMotionVectorAnimation();
  }

  function stepMotionVectorAnimation() {
    if (!isMotionVectorEnabled || targetMotionCourse === null || !userLatLng) {
      mvAnimRafId = 0;
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.08, Math.max(0.005, (now - lastMvAnimTime) / 1000));
    lastMvAnimTime = now;

    if (currentRenderedAngle === null) {
      currentRenderedAngle = targetMotionCourse;
    }

    let diff = ((targetMotionCourse - currentRenderedAngle + 540) % 360) - 180;
    const absDiff = Math.abs(diff);

    if (absDiff < 0.15) {
      currentRenderedAngle = targetMotionCourse;
      renderMotionVectorLine(currentRenderedAngle);
      mvAnimRafId = 0;
      return;
    }

    const turnRate = Math.max(50, Math.min(180, absDiff * 3.5));
    let step = diff * (1 - Math.exp(-9.0 * dt));
    const maxStep = turnRate * dt;

    if (Math.abs(step) > maxStep) {
      step = Math.sign(step) * maxStep;
    }

    currentRenderedAngle = (currentRenderedAngle + step + 360) % 360;
    renderMotionVectorLine(currentRenderedAngle);

    mvAnimRafId = requestAnimationFrame(stepMotionVectorAnimation);
  }

  function clipRayToBounds(originLL, courseDeg, maxRayLenMeters, bounds) {
    const crs = L.CRS.EPSG3857;
    const O = crs.project(originLL);
    const sw = crs.project(bounds.getSouthWest());
    const ne = crs.project(bounds.getNorthEast());

    const Xmin = Math.min(sw.x, ne.x);
    const Xmax = Math.max(sw.x, ne.x);
    const Ymin = Math.min(sw.y, ne.y);
    const Ymax = Math.max(sw.y, ne.y);

    const rad = courseDeg * Math.PI / 180;
    const Dx = Math.sin(rad);
    const Dy = Math.cos(rad);

    let t0 = 0;
    let t1 = Infinity;

    if (Math.abs(Dx) < 1e-9) {
      if (O.x < Xmin || O.x > Xmax) return null;
    } else {
      let tx1 = (Xmin - O.x) / Dx;
      let tx2 = (Xmax - O.x) / Dx;
      if (tx1 > tx2) { const tmp = tx1; tx1 = tx2; tx2 = tmp; }
      t0 = Math.max(t0, tx1);
      t1 = Math.min(t1, tx2);
      if (t0 > t1) return null;
    }

    if (Math.abs(Dy) < 1e-9) {
      if (O.y < Ymin || O.y > Ymax) return null;
    } else {
      let ty1 = (Ymin - O.y) / Dy;
      let ty2 = (Ymax - O.y) / Dy;
      if (ty1 > ty2) { const tmp = ty1; ty1 = ty2; ty2 = tmp; }
      t0 = Math.max(t0, ty1);
      t1 = Math.min(t1, ty2);
      if (t0 > t1) return null;
    }

    if (t1 < 0) return null;

    const isEnteringFromOutside = (t0 > 0.001);
    const startPt = isEnteringFromOutside 
      ? L.point(O.x + t0 * Dx, O.y + t0 * Dy) 
      : O;

    const endPt = L.point(O.x + t1 * Dx, O.y + t1 * Dy);

    return {
      startLL: crs.unproject(startPt),
      endLL: crs.unproject(endPt),
      isEnteringFromOutside
    };
  }

  function renderMotionVectorLine(course) {
    if (!isMotionVectorEnabled || !userLatLng || !map || course === null) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      hideMotionVectorOffscreenIndicator();
      return;
    }

    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;

    if (speed < 0.35) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      hideMotionVectorOffscreenIndicator();
      return;
    }

    const originLL = L.latLng(userLatLng[0], userLatLng[1]);
    const bounds = map.getBounds().pad(0.02);

    const clipped = clipRayToBounds(originLL, course, Infinity, bounds);
    if (!clipped) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      showMotionVectorOffscreenIndicator(originLL, course);
      return;
    }

    hideMotionVectorOffscreenIndicator();

    const { startLL, endLL, isEnteringFromOutside } = clipped;

    if (!motionVectorLine) {
      motionVectorLine = L.polyline([startLL, endLL], {
        pane: 'wm-top-lines',
        color: '#0284c7',
        weight: 3.5,
        dashArray: '8, 6',
        opacity: 0.85,
        interactive: false
      }).addTo(motionVectorLayer);
    } else {
      motionVectorLine.setLatLngs([startLL, endLL]);
    }

    if (isEnteringFromOutside) {
      const speedKmh = Math.round(speed * 3.6);
      const infoText = speedKmh > 0 ? `${speedKmh} км/ч` : `${Math.round(course)}°`;
      const badgeHtml = `<div class="wm-motion-vector-badge">▲ Вектор курса (${infoText})</div>`;
      if (!motionVectorBadge) {
        motionVectorBadge = L.marker(startLL, {
          icon: L.divIcon({
            className: 'wm-motion-badge-wrap',
            html: badgeHtml,
            iconSize: [140, 24],
            iconAnchor: [70, 12]
          }),
          interactive: false,
          zIndexOffset: 1500
        }).addTo(motionVectorLayer);
        motionVectorBadge._lastHtml = badgeHtml;
      } else {
        motionVectorBadge.setLatLng(startLL);
        if (motionVectorBadge._lastHtml !== badgeHtml) {
          motionVectorBadge._lastHtml = badgeHtml;
          const el = motionVectorBadge.getElement();
          if (el) el.innerHTML = badgeHtml;
        }
      }
    } else if (motionVectorBadge) {
      motionVectorLayer.removeLayer(motionVectorBadge);
      motionVectorBadge = null;
    }
  }

  function updateMotionVectorVisuals() {
    if (!isMotionVectorEnabled || !userLatLng || !map) {
      if (mvAnimRafId) { cancelAnimationFrame(mvAnimRafId); mvAnimRafId = 0; }
      renderMotionVectorLine(null);
      return;
    }

    targetMotionCourse = getEstimatedMotionCourse();

    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;
    if (targetMotionCourse === null || speed < 0.35) {
      if (mvAnimRafId) { cancelAnimationFrame(mvAnimRafId); mvAnimRafId = 0; }
      renderMotionVectorLine(null);
      return;
    }

    if (currentRenderedAngle === null) {
      currentRenderedAngle = targetMotionCourse;
    }

    const diff = ((targetMotionCourse - currentRenderedAngle + 540) % 360) - 180;
    if (Math.abs(diff) > 0.15) {
      startMotionVectorAnimation();
    } else {
      currentRenderedAngle = targetMotionCourse;
      renderMotionVectorLine(currentRenderedAngle);
    }
  }

  WM.motionVector = {
    isEnabled: () => isMotionVectorEnabled,
    setEnabled(val) {
      isMotionVectorEnabled = !!val;
      if (!isMotionVectorEnabled) {
        if (mvAnimRafId) { cancelAnimationFrame(mvAnimRafId); mvAnimRafId = 0; }
        motionVectorLayer.clearLayers();
        motionVectorLine = null;
        motionVectorBadge = null;
        hideMotionVectorOffscreenIndicator();
      } else {
        updateMotionVectorVisuals();
      }
    },
    getCourse: () => (currentRenderedAngle !== null ? Math.round(currentRenderedAngle * 10) / 10 : getEstimatedMotionCourse())
  };

  // =========================================================================
  // РАССТОЯНИЕ, СКОРОСТЬ И ВРЕМЯ ДО ЦЕНТРА ЭКРАНА
  // =========================================================================
  function fmtGpsDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  const gpsDistLayer = L.layerGroup().addTo(map);
  let gpsDistPolyline = null;
  let gpsDistBadgeMarker = null;
  let isGpsDistEnabled = false;

  let isGpsDistCollapsed = localStorage.getItem('wm_gps_dist_collapsed') !== 'false';
  let isNavTargetCollapsed = localStorage.getItem('wm_nav_target_collapsed') !== 'false';

  function toggleGpsDistCollapse(e) {
    if (e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
    }
    isGpsDistCollapsed = !isGpsDistCollapsed;
    try { localStorage.setItem('wm_gps_dist_collapsed', isGpsDistCollapsed ? 'true' : 'false'); } catch (err) {}
    updateGpsDistVisuals();
  }

  function toggleNavTargetCollapse(e) {
    if (e) {
      if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest('.wm-nav-close-btn')) {
        return;
      }
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
    }
    isNavTargetCollapsed = !isNavTargetCollapsed;
    try { localStorage.setItem('wm_nav_target_collapsed', isNavTargetCollapsed ? 'true' : 'false'); } catch (err) {}
    updateNavTargetVisuals();
  }

  function updateGpsDistVisuals() {
    if (!isGpsDistEnabled || !userLatLng || !map) {
      if (gpsDistPolyline) { gpsDistLayer.removeLayer(gpsDistPolyline); gpsDistPolyline = null; }
      if (gpsDistBadgeMarker) { gpsDistLayer.removeLayer(gpsDistBadgeMarker); gpsDistBadgeMarker = null; }
      return;
    }

    const center = map.getCenter();
    const targetLL = L.latLng(userLatLng[0], userLatLng[1]);
    const dist = center.distanceTo(targetLL);

    const badgeLL = center;

    const speed = (WM.gpsState && WM.gpsState.speed != null && WM.gpsState.speed >= 0) ? WM.gpsState.speed : 0;
    const speedKmh = speed * 3.6;

    const bearingToCenter = computeBearing(targetLL, center);
    const motionCourse = getEstimatedMotionCourse();

    let diffAngle = 0;
    let signedDiff = 0;
    let driftText = '—';
    let colorClass = 'status-purple';
    let strokeColor = '#8b5cf6';

    if (isMotionVectorEnabled && motionCourse !== null) {
      signedDiff = (motionCourse - bearingToCenter + 540) % 360 - 180;
      diffAngle = Math.abs(signedDiff);

      if (WM.navVibro && activeNavTarget && speed >= 0.35) {
        WM.navVibro.triggerNavigationVibration(signedDiff, diffAngle, speed);
      }

      if (speed >= 0.35) {
        if (diffAngle <= 5) {
          driftText = '🟢 Прямо к цели';
        } else if (signedDiff > 0) {
          driftText = `Крен вправо ${Math.round(diffAngle)}°`;
        } else {
          driftText = `Крен влево ${Math.round(diffAngle)}°`;
        }
      } else {
        driftText = 'Стоянка';
      }

      if (diffAngle <= 25) {
        colorClass = 'status-purple';
        strokeColor = '#8b5cf6';
      } else if (diffAngle <= 55) {
        colorClass = 'status-yellow';
        strokeColor = '#eab308';
      } else if (diffAngle <= 90) {
        colorClass = 'status-orange';
        strokeColor = '#f97316';
      } else {
        colorClass = 'status-red';
        strokeColor = '#ef4444';
      }
    } else if (speed < 0.35) {
      driftText = 'Стоянка';
    }

    let durationText = '—';
    let etaClock = '—';
    let isMovingAway = false;

    if (speed < 0.35) {
      durationText = 'Стоянка';
      etaClock = '—';
    } else {
      const radDiff = diffAngle * Math.PI / 180;
      const vmg = speed * Math.cos(radDiff);

      if (vmg > 0.08) {
        const timeSec = dist / vmg;
        durationText = fmtEtaTime(timeSec);
        const arrDate = new Date(Date.now() + timeSec * 1000);
        etaClock = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
      } else {
        durationText = 'Удаление';
        etaClock = '—';
        isMovingAway = true;
      }
    }

    if (!gpsDistPolyline) {
      gpsDistPolyline = L.polyline([center, targetLL], {
        pane: 'wm-top-lines',
        color: strokeColor,
        weight: 3,
        dashArray: '6, 6',
        opacity: 0.9,
        interactive: false
      }).addTo(gpsDistLayer);
    } else {
      gpsDistPolyline.setLatLngs([center, targetLL]);
      gpsDistPolyline.setStyle({ color: strokeColor });
    }

    const distFormatted = fmtGpsDistance(dist);
    const speedFormatted = `${speedKmh.toFixed(1)} км/ч`;
    const moveActionLabel = speedKmh > 6 ? 'Ещё ехать:' : 'Ещё идти:';

    if (!gpsDistBadgeMarker) {
      gpsDistBadgeMarker = L.marker(badgeLL, {
        icon: L.divIcon({
          className: 'wm-gps-badge-wrap',
          html: '<div class="wm-gdb-root"></div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: true,
        zIndexOffset: 1400
      }).addTo(gpsDistLayer);

      gpsDistBadgeMarker.on('click', toggleGpsDistCollapse);
      gpsDistBadgeMarker._renderedMode = null;
    } else {
      gpsDistBadgeMarker.setLatLng(badgeLL);
    }

    const containerEl = gpsDistBadgeMarker.getElement();
    if (!containerEl) return;
    const root = containerEl.querySelector('.wm-gdb-root') || containerEl;

    const currentMode = isGpsDistCollapsed ? 'compact' : 'full';

    if (gpsDistBadgeMarker._renderedMode !== currentMode) {
      gpsDistBadgeMarker._renderedMode = currentMode;
      if (isGpsDistCollapsed) {
        root.innerHTML = `
          <div class="wm-gps-dist-badge col-badge compact over-crosshair ${colorClass}" title="Нажмите, чтобы развернуть">
            <div class="wm-gdb-compact-lines">
              <span class="wm-gdb-compact-val js-dist">${distFormatted}</span>
              <span class="wm-gdb-compact-sub js-speed">${speedFormatted}</span>
            </div>
            <button type="button" class="wm-gdb-toggle-btn" title="Развернуть подробности">▼</button>
          </div>
        `;
      } else {
        root.innerHTML = `
          <div class="wm-gps-dist-badge col-badge over-crosshair ${colorClass}">
            <div class="wm-gdb-head">
              <span class="wm-gdb-icon">🧭</span>
              <span class="wm-gdb-name">К центру экрана</span>
              <button type="button" class="wm-gdb-toggle-btn" title="Свернуть подробности">▲</button>
            </div>
            <div class="wm-gdb-grid">
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Дистанция:</span>
                <span class="wm-gdb-val js-dist">${distFormatted}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Скорость:</span>
                <span class="wm-gdb-val js-speed">${speedFormatted}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl js-action-lbl">${moveActionLabel}</span>
                <span class="wm-gdb-val js-duration ${isMovingAway ? 'negative' : ''}">${durationText}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Прибытие:</span>
                <span class="wm-gdb-val js-eta ${isMovingAway ? 'negative' : ''}">${etaClock}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Курс:</span>
                <span class="wm-gdb-val js-drift ${diffAngle > 55 ? 'negative' : ''}">${driftText}</span>
              </div>
            </div>
          </div>
        `;
      }
      return;
    }

    const badgeEl = root.querySelector('.wm-gps-dist-badge');
    if (badgeEl) {
      badgeEl.className = `wm-gps-dist-badge col-badge ${currentMode} over-crosshair ${colorClass}`;
    }

    const elDist = root.querySelector('.js-dist');
    if (elDist && elDist.textContent !== distFormatted) elDist.textContent = distFormatted;

    const elSpeed = root.querySelector('.js-speed');
    if (elSpeed && elSpeed.textContent !== speedFormatted) elSpeed.textContent = speedFormatted;

    if (!isGpsDistCollapsed) {
      const elAction = root.querySelector('.js-action-lbl');
      if (elAction && elAction.textContent !== moveActionLabel) elAction.textContent = moveActionLabel;

      const elDuration = root.querySelector('.js-duration');
      if (elDuration) {
        if (elDuration.textContent !== durationText) elDuration.textContent = durationText;
        elDuration.classList.toggle('negative', isMovingAway);
      }

      const elEta = root.querySelector('.js-eta');
      if (elEta) {
        if (elEta.textContent !== etaClock) elEta.textContent = etaClock;
        elEta.classList.toggle('negative', isMovingAway);
      }

      const elDrift = root.querySelector('.js-drift');
      if (elDrift) {
        if (elDrift.textContent !== driftText) elDrift.textContent = driftText;
        elDrift.classList.toggle('negative', diffAngle > 55);
      }
    }
  }

  // =========================================================================
  // НАВИГАЦИЯ НА ВЫБРАННУЮ ЦЕЛЬ (TARGET NAVIGATION)
  // =========================================================================
  const navTargetLayer = L.layerGroup().addTo(map);
  let navTargetPolyline = null;
  let navTargetBadgeMarker = null;
  let activeNavTarget = null;

  function updateNavTargetVisuals() {
    if (!activeNavTarget || !userLatLng || !map) {
      if (navTargetPolyline) { navTargetLayer.removeLayer(navTargetPolyline); navTargetPolyline = null; }
      if (navTargetBadgeMarker) { navTargetLayer.removeLayer(navTargetBadgeMarker); navTargetBadgeMarker = null; }
      return;
    }

    const targetLL = L.latLng(activeNavTarget.lat, activeNavTarget.lng);
    const originLL = L.latLng(userLatLng[0], userLatLng[1]);
    const dist = originLL.distanceTo(targetLL);

    const badgeLL = getVisibleSegmentPoint(map, originLL, targetLL, { left: 90, right: 90, top: 110, bottom: 120 });

    const speed = (WM.gpsState && WM.gpsState.speed != null && WM.gpsState.speed >= 0) ? WM.gpsState.speed : 0;
    const speedKmh = speed * 3.6;

    const bearingToTarget = computeBearing(originLL, targetLL);
    const motionCourse = getEstimatedMotionCourse();

    let diffAngle = 0;
    let signedDiff = 0;
    let driftText = '—';
    let colorClass = 'status-purple';
    let strokeColor = '#8b5cf6';

    if (isMotionVectorEnabled && motionCourse !== null) {
      signedDiff = (motionCourse - bearingToTarget + 540) % 360 - 180;
      diffAngle = Math.abs(signedDiff);

      if (WM.navVibro && activeNavTarget && speed >= 0.35) {
        WM.navVibro.triggerNavigationVibration(signedDiff, diffAngle, speed);
      }

      if (speed >= 0.35) {
        if (diffAngle <= 5) {
          driftText = '🟢 Прямо к цели';
        } else if (signedDiff > 0) {
          driftText = `Крен вправо ${Math.round(diffAngle)}°`;
        } else {
          driftText = `Крен влево ${Math.round(diffAngle)}°`;
        }
      } else {
        driftText = 'Стоянка';
      }

      if (diffAngle <= 25) {
        colorClass = 'status-purple';
        strokeColor = '#8b5cf6';
      } else if (diffAngle <= 55) {
        colorClass = 'status-yellow';
        strokeColor = '#eab308';
      } else if (diffAngle <= 90) {
        colorClass = 'status-orange';
        strokeColor = '#f97316';
      } else {
        colorClass = 'status-red';
        strokeColor = '#ef4444';
      }
    } else if (speed < 0.35) {
      driftText = 'Стоянка';
    }

    let durationText = '—';
    let etaClock = '—';
    let isMovingAway = false;

    if (speed < 0.35) {
      durationText = 'Стоянка';
      etaClock = '—';
    } else {
      const radDiff = diffAngle * Math.PI / 180;
      const vmg = speed * Math.cos(radDiff);

      if (vmg > 0.08) {
        const timeSec = dist / vmg;
        durationText = fmtEtaTime(timeSec);
        const arrDate = new Date(Date.now() + timeSec * 1000);
        etaClock = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
      } else {
        durationText = 'Удаление';
        etaClock = '—';
        isMovingAway = true;
      }
    }

    if (!navTargetPolyline) {
      navTargetPolyline = L.polyline([originLL, targetLL], {
        pane: 'wm-top-lines',
        color: strokeColor,
        weight: 3.5,
        dashArray: '8, 6',
        opacity: 0.95,
        interactive: false
      }).addTo(navTargetLayer);
    } else {
      navTargetPolyline.setLatLngs([originLL, targetLL]);
      navTargetPolyline.setStyle({ color: strokeColor });
    }

    const distFormatted = fmtGpsDistance(dist);
    const speedFormatted = `${speedKmh.toFixed(1)} км/ч`;
    const targetTitle = activeNavTarget.title ? escapeHtml(activeNavTarget.title) : 'Цель';
    const moveActionLabel = speedKmh > 6 ? 'Ещё ехать:' : 'Ещё идти:';


    if (!navTargetBadgeMarker) {
      navTargetBadgeMarker = L.marker(badgeLL, {
        icon: L.divIcon({
          className: 'wm-gps-badge-wrap',
          html: '<div class="wm-nav-root"></div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: true,
        zIndexOffset: 1450
      }).addTo(navTargetLayer);

      navTargetBadgeMarker.on('click', toggleNavTargetCollapse);
      navTargetBadgeMarker._renderedMode = null;
    } else {
      navTargetBadgeMarker.setLatLng(badgeLL);
    }

    const containerEl = navTargetBadgeMarker.getElement();
    if (!containerEl) return;
    const root = containerEl.querySelector('.wm-nav-root') || containerEl;

    // Перехват клика по крестику с отменой следования к цели:
    if (!root._navCloseBound) {
      root._navCloseBound = true;
      L.DomEvent.on(root, 'click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.wm-nav-close-btn');
        if (btn) {
          L.DomEvent.stopPropagation(e);
          L.DomEvent.preventDefault(e);
          WM.navTarget.clear();
        }
      });
      L.DomEvent.on(root, 'mousedown touchstart', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.wm-nav-close-btn');
        if (btn) {
          L.DomEvent.stopPropagation(e);
        }
      });
    }

    const currentMode = isNavTargetCollapsed ? 'compact' : 'full';

    if (navTargetBadgeMarker._renderedMode !== currentMode) {
      navTargetBadgeMarker._renderedMode = currentMode;
      if (isNavTargetCollapsed) {
        root.innerHTML = `
          <div class="wm-gps-dist-badge col-badge compact ${colorClass}" title="Нажмите, чтобы развернуть">
            <div class="wm-gdb-compact-lines">
              <span class="wm-gdb-compact-val js-dist">${distFormatted}</span>
              <span class="wm-gdb-compact-sub js-speed">${speedFormatted}</span>
            </div>
            <div class="wm-gdb-actions">
              <button type="button" class="wm-gdb-toggle-btn" title="Развернуть подробности">▼</button>
              <button type="button" class="wm-nav-close-btn" title="Отменить следование">✕</button>
            </div>
          </div>
        `;
      } else {
        root.innerHTML = `
          <div class="wm-gps-dist-badge col-badge ${colorClass}">
            <div class="wm-gdb-head">
              <span class="wm-gdb-icon">🎯</span>
              <span class="wm-gdb-name" title="${targetTitle}">${targetTitle}</span>
              <div class="wm-gdb-actions">
                <button type="button" class="wm-gdb-toggle-btn" title="Свернуть подробности">▲</button>
                <button type="button" class="wm-nav-close-btn" title="Отменить следование">✕</button>
              </div>
            </div>
            <div class="wm-gdb-grid">
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Дистанция:</span>
                <span class="wm-gdb-val js-dist">${distFormatted}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Скорость:</span>
                <span class="wm-gdb-val js-speed">${speedFormatted}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl js-action-lbl">${moveActionLabel}</span>
                <span class="wm-gdb-val js-duration ${isMovingAway ? 'negative' : ''}">${durationText}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Прибытие:</span>
                <span class="wm-gdb-val js-eta ${isMovingAway ? 'negative' : ''}">${etaClock}</span>
              </div>
              <div class="wm-gdb-row">
                <span class="wm-gdb-lbl">Курс:</span>
                <span class="wm-gdb-val js-drift ${diffAngle > 55 ? 'negative' : ''}">${driftText}</span>
              </div>
            </div>
          </div>
        `;
      }
      return;
    }

    const badgeEl = root.querySelector('.wm-gps-dist-badge');
    if (badgeEl) {
      badgeEl.className = `wm-gps-dist-badge col-badge ${currentMode} ${colorClass}`;
    }

    const elDist = root.querySelector('.js-dist');
    if (elDist && elDist.textContent !== distFormatted) elDist.textContent = distFormatted;

    const elSpeed = root.querySelector('.js-speed');
    if (elSpeed && elSpeed.textContent !== speedFormatted) elSpeed.textContent = speedFormatted;

    if (!isNavTargetCollapsed) {
      const elAction = root.querySelector('.js-action-lbl');
      if (elAction && elAction.textContent !== moveActionLabel) elAction.textContent = moveActionLabel;

      const elDuration = root.querySelector('.js-duration');
      if (elDuration) {
        if (elDuration.textContent !== durationText) elDuration.textContent = durationText;
        elDuration.classList.toggle('negative', isMovingAway);
      }

      const elEta = root.querySelector('.js-eta');
      if (elEta) {
        if (elEta.textContent !== etaClock) elEta.textContent = etaClock;
        elEta.classList.toggle('negative', isMovingAway);
      }

      const elDrift = root.querySelector('.js-drift');
      if (elDrift) {
        if (elDrift.textContent !== driftText) elDrift.textContent = driftText;
        elDrift.classList.toggle('negative', diffAngle > 55);
      }
    }
  }

  WM.navTarget = {
    set(target) {
      activeNavTarget = target;
      syncWakeLockState();
      syncGpsWatchState();
      if (!userLatLng) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛰️ Определение геопозиции для навигации…', 1800);
        acquireLocation(
          () => {
            updateNavTargetVisuals();
            if (WM.ui && WM.ui.showToast) WM.ui.showToast(`🎯 Направление к цели: ${target.title || 'Точка'}`);
          },
          (err) => {
            if (WM.ui && WM.ui.showToast) WM.ui.showToast('Ошибка геопозиции: ' + err.message);
          }
        );
        return;
      }
      updateNavTargetVisuals();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`🎯 Направление к цели: ${target.title || 'Точка'}`);
    },
    clear() {
      const hadTarget = !!activeNavTarget;
      activeNavTarget = null;
      syncWakeLockState();
      syncGpsWatchState();
      updateNavTargetVisuals();
      if (hadTarget && WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🛑 Навигация к цели отключена');
      }
    },
    toggle(target) {
      if (this.isTarget(target.id)) {
        this.clear();
      } else {
        this.set(target);
      }
    },
    isTarget(id) {
      return !!(activeNavTarget && String(activeNavTarget.id) === String(id));
    },
    getTarget() {
      return activeNavTarget;
    },
    updateCoordinates(lat, lng) {
      if (activeNavTarget) {
        activeNavTarget.lat = lat;
        activeNavTarget.lng = lng;
        updateNavTargetVisuals();
      }
    },
    refresh: updateNavTargetVisuals
  };

  let lastMoveCalc = 0;
  map.on('move', () => {
    const now = performance.now();
    if (now - lastMoveCalc < 33) return;
    lastMoveCalc = now;

    if (isGpsDistEnabled) updateGpsDistVisuals();
    if (activeNavTarget) updateNavTargetVisuals();
    if (isMotionVectorEnabled) updateMotionVectorVisuals();
    if (WM.ui && WM.ui.updateRays) WM.ui.updateRays(map.getCenter(), true);
    if (WM.measure && WM.measure.onMapMove) WM.measure.onMapMove();
  });

  // =========================================================================
  // ИСТОРИЯ ДВИЖЕНИЯ
  // =========================================================================
  const motionHistory = [];

  function updateMotionHistory(ll, coords, timestamp) {
    const newLL = L.latLng(ll[0], ll[1]);
    const now = timestamp || Date.now();
    const accuracy = (coords && coords.accuracy) || 10;
    
    if (accuracy > 35) return;

    if (motionHistory.length > 0) {
      const last = motionHistory[motionHistory.length - 1];
      const dist = last.latlng.distanceTo(newLL);
      const dt = (now - last.time) / 1000;

      if (dt > 45 || (dist > 350 && (dist / Math.max(0.1, dt)) > 55)) {
        motionHistory.length = 0;
        smoothedMotionCourse = null;
      }
    }

    motionHistory.push({ latlng: newLL, time: now, accuracy });

    const cutoff = now - 14000;
    while (motionHistory.length > 0 && (motionHistory[0].time < cutoff || motionHistory.length > 20)) {
      motionHistory.shift();
    }
  }

  // =========================================================================
  // РЕЖИМ СЛЕЖЕНИЯ ЗА ГЕОПОЗИЦИЕЙ
  // =========================================================================
  let isFollowMode = false;
  let isUserDragging = false;
  let dragStartCenter = null;
  let hasExceededDragThreshold = false;
  const DRAG_BREAK_THRESHOLD_PX = 50;

  function startFollowMode() {
    isFollowMode = true;
    syncGpsWatchState();
    syncWakeLockState();
    
    const btnLoc = document.getElementById('btn-location');
    if (btnLoc) {
      btnLoc.classList.add('following');
      btnLoc.title = '🎯 Слежение активно (удерживайте или сдвиньте карту для отключения)';
    }

    if (WM.compass && WM.compass.start) {
      WM.compass.start();
    }

    if (userLatLng) {
      map.panTo(userLatLng, { animate: true, duration: 0.35 });
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🎯 Режим слежения включён (камера привязана к точке)');
      }
    } else {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🎯 Поиск позиции и включение слежения…');
      }
      acquireLocation(
        (ll) => {
          if (isFollowMode) {
            map.panTo(ll, { animate: true, duration: 0.35 });
            if (WM.ui && WM.ui.showToast) {
              WM.ui.showToast('🎯 Режим слежения включён');
            }
          }
        },
        (err) => {
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('Ошибка геопозиции: ' + err.message);
          }
        }
      );
    }
  }

  function stopFollowMode(silent = false) {
    if (!isFollowMode) return;
    isFollowMode = false;
    syncWakeLockState(); 
    syncGpsWatchState();

    const btnLoc = document.getElementById('btn-location');
    if (btnLoc) {
      btnLoc.classList.remove('following');
      btnLoc.title = '🛰️ Моя геопозиция (удерживайте для слежения)';
    }
    if (!silent && WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🔓 Режим слежения отключён');
    }
  }

  function toggleFollowMode() {
    if (isFollowMode) {
      stopFollowMode(false);
    } else {
      startFollowMode();
    }
  }

  WM.followMode = {
    isActive: () => isFollowMode,
    start: startFollowMode,
    stop: stopFollowMode,
    toggle: toggleFollowMode
  };

  map.on('dragstart', () => {
    isUserDragging = true;
    dragStartCenter = map.getCenter();
    hasExceededDragThreshold = false;
  });

  map.on('drag', () => {
    if (!isFollowMode || !dragStartCenter) return;
    const screenCenter = map.getSize().divideBy(2);
    const oldCenterScreenPos = map.latLngToContainerPoint(dragStartCenter);
    const displacement = oldCenterScreenPos.distanceTo(screenCenter);
    if (displacement >= DRAG_BREAK_THRESHOLD_PX) {
      hasExceededDragThreshold = true;
    }
  });

  map.on('dragend', () => {
    isUserDragging = false;
    if (!isFollowMode) return;

    if (hasExceededDragThreshold) {
      stopFollowMode(true);
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('🔓 Слежение отключено (смещение карты)');
      }
    } else {
      if (userLatLng) {
        map.panTo(userLatLng, { animate: true, duration: 0.25 });
      }
    }
    dragStartCenter = null;
    hasExceededDragThreshold = false;
  });

  map.on('zoomend', () => {
    if (isFollowMode && userLatLng && !isUserDragging) {
      map.panTo(userLatLng, { animate: false });
    }
  });

  function setGpsCoords(ll, coords, timestamp, isPdrBypass = false) {
    if (isManualPdrActive && !isPdrBypass) {
      return;
    }

    const targetLL = L.latLng(ll[0], ll[1]);

    if (!isPdrBypass && !validateGpsPoint(targetLL, coords, timestamp)) {
      return;
    }

    userLatLng = ll;

    WM.gpsState = {
      lat: ll[0],
      lng: ll[1],
      accuracy: (coords && coords.accuracy != null) ? coords.accuracy : 5,
      altitude: (coords && coords.altitude != null) ? coords.altitude : (WM.gpsState ? WM.gpsState.altitude : null),
      speed: (coords && coords.speed != null) ? coords.speed : 0,
      heading: (coords && coords.heading != null && !isNaN(coords.heading)) ? coords.heading : (currentHeading || 0),
      timestamp: timestamp || Date.now()
    };

    if (me) {
      me.setLatLng(ll);
    } else {
      cachedGpsConeEl = null;
      me = L.marker(ll, {
        icon: WM.compass ? WM.compass.createGpsIcon() : L.divIcon(),
        interactive: false,
        zIndexOffset: 1200
      }).addTo(map);
    }

    if (isFollowMode && !isUserDragging) {
      if (map.getBounds().contains(targetLL)) {
        map.panTo(targetLL, { animate: true, duration: 0.3 });
      } else {
        map.setView(targetLL, map.getZoom());
      }
    }

    updateMotionHistory(ll, coords, timestamp);
    updateSmoothedCourse(timestamp);

    if (WM.motionTail) {
      WM.motionTail.addPoint(ll, coords, timestamp);
    }

    if (isMotionVectorEnabled) updateMotionVectorVisuals();
    if (isGpsDistEnabled) updateGpsDistVisuals();
    if (activeNavTarget) updateNavTargetVisuals();
    if (WM.compass) updateCompassVisuals();
    if (WM.measure && WM.measure.onGpsUpdate) {
      WM.measure.onGpsUpdate(ll, coords);
    }
  }

  // =========================================================================
  // МЕНЕДЖЕР ЭНЕРГОПОТРЕБЛЕНИЯ GPS И ПОЛУЧЕНИЕ КООРДИНАТ
  // =========================================================================
  let gpsWatchId = null;
  let gpsSingleFixTimer = null;

  function shouldGpsBeTracking() {
    if (document.hidden) return false;
    const hasFollow = isFollowMode;
    const hasDistLine = isGpsDistEnabled;
    const hasNav = !!activeNavTarget;
    const isPdrTracking = WM.pdr && WM.pdr.isActive() && !isManualPdrActive;
    return hasFollow || hasDistLine || hasNav || isPdrTracking;
  }

  function syncGpsWatchState() {
    if (shouldGpsBeTracking()) {
      clearTimeout(gpsSingleFixTimer);
      startGpsWatch();
    } else {
      stopGpsWatch();
    }
  }

  function startGpsWatch() {
    if (gpsWatchId !== null || !navigator.geolocation) return;
    try {
      gpsWatchId = navigator.geolocation.watchPosition(
        (p) => {
          const ll = [p.coords.latitude, p.coords.longitude];
          setGpsCoords(ll, p.coords, p.timestamp);
        },
        (e) => console.warn('GPS watch error:', e),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );
    } catch (e) {}
  }

  function stopGpsWatch() {
    if (gpsWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
  }

  function acquireLocation(onSuccess, onError) {
    if (!navigator.geolocation) {
      if (onError) onError(new Error('Геолокация не поддерживается устройством'));
      return;
    }

    // Если был включен ручной PDR («Я тут»), клик на штатную кнопку геолокации возвращает реальный GPS
    if (isManualPdrActive) {
      isManualPdrActive = false;
      stopPdrTracking();
      if (WM.ui && WM.ui.updateManualPdrBtnState) WM.ui.updateManualPdrBtnState();
    }

    updateLocationBtnSearching(true);
    startGpsWatch();

    // Даем чипу до 15 секунд на точную фиксацию координат в фоне
    clearTimeout(gpsSingleFixTimer);
    if (!shouldGpsBeTracking()) {
      gpsSingleFixTimer = setTimeout(() => {
        if (!shouldGpsBeTracking()) stopGpsWatch();
      }, 15000);
    }

    navigator.geolocation.getCurrentPosition(
      (p) => {
        updateLocationBtnSearching(false);
        const targetLL = L.latLng(p.coords.latitude, p.coords.longitude);
        const isValid = validateGpsPoint(targetLL, p.coords, p.timestamp);
        
        if (isValid) {
          const ll = [p.coords.latitude, p.coords.longitude];
          setGpsCoords(ll, p.coords, p.timestamp);
          if (onSuccess) onSuccess(ll);
        } else if (userLatLng && onSuccess) {
          onSuccess(userLatLng);
        }
      },
      (e) => {
        updateLocationBtnSearching(false);
        if (!shouldGpsBeTracking()) stopGpsWatch();
        if (onError) onError(e);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }

  // =========================================================================
  // ОБРАБОТЧИКИ КНОПКИ ГЕОПОЗИЦИИ
  // =========================================================================
  const btnLoc = document.getElementById('btn-location');
  if (btnLoc) {
    let locHoldTimer = null;
    let isLocLongPress = false;
    let lastLocLongPressTime = 0;
    let locTouchStartPt = null;
    let isLocTouchAction = false;

    btnLoc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isLocTouchAction) return;
      toggleFollowMode();
    });

    btnLoc.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      isLocTouchAction = true;
      isLocLongPress = false;
      const t = e.touches[0];
      locTouchStartPt = { x: t.clientX, y: t.clientY };
      clearTimeout(locHoldTimer);

      locHoldTimer = setTimeout(() => {
        isLocLongPress = true;
        lastLocLongPressTime = Date.now();
        if (navigator.vibrate) navigator.vibrate(45);
        toggleFollowMode();
      }, 420);
    }, { passive: true });

    btnLoc.addEventListener('touchmove', (e) => {
      if (!locTouchStartPt) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - locTouchStartPt.x, t.clientY - locTouchStartPt.y) > 10) {
        clearTimeout(locHoldTimer);
      }
    }, { passive: true });

    btnLoc.addEventListener('touchend', (e) => {
      clearTimeout(locHoldTimer);
      locTouchStartPt = null;
      if (isLocLongPress) {
        lastLocLongPressTime = Date.now();
        e.preventDefault();
        e.stopPropagation();
      }
      setTimeout(() => { isLocTouchAction = false; }, 350);
    }, { passive: false });

    btnLoc.addEventListener('touchcancel', () => {
      clearTimeout(locHoldTimer);
      locTouchStartPt = null;
      isLocLongPress = false;
      isLocTouchAction = false;
    });

    let mouseLocTimer = null;
    let mouseLocLong = false;

    btnLoc.addEventListener('mousedown', (e) => {
      if (isLocTouchAction || e.button !== 0) return;
      mouseLocLong = false;
      clearTimeout(mouseLocTimer);
      mouseLocTimer = setTimeout(() => {
        mouseLocLong = true;
        lastLocLongPressTime = Date.now();
        toggleFollowMode();
      }, 420);
    });
    btnLoc.addEventListener('mouseup', () => clearTimeout(mouseLocTimer));
    btnLoc.addEventListener('mouseleave', () => clearTimeout(mouseLocTimer));

    btnLoc.onclick = (e) => {
      if (isLocLongPress || mouseLocLong || (Date.now() - lastLocLongPressTime < 600)) {
        isLocLongPress = false;
        mouseLocLong = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (WM.compass && WM.compass.start) {
        WM.compass.start();
      }

      if (isFollowMode && userLatLng) {
        map.panTo(userLatLng, { animate: true, duration: 0.25 });
        return;
      }

      if (isSpoofed) {
        if (userLatLng) {
          map.setView(userLatLng, Math.max(map.getZoom(), 16));
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('⚠️ Показана безопасная точка (глушение активно)');
          }
        } else {
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('⚠️ GPS заглушен! Наведите прицел и нажмите «Я тут»');
          }
        }
        return;
      }

      if (userLatLng) {
        map.setView(userLatLng, Math.max(map.getZoom(), 16));
      }

      acquireLocation(
        (ll) => {
          map.setView(ll, Math.max(map.getZoom(), 16));
        },
        (err) => {
          if (!userLatLng && WM.ui && WM.ui.showToast) {
            WM.ui.showToast('Ошибка геопозиции: ' + err.message);
          }
        }
      );
    };
  }

  WM.setGpsPosition = function(lat, lng, speed = 5, heading = 0) {
    const pCoords = {
      latitude: lat,
      longitude: lng,
      accuracy: 5,
      altitude: 150,
      speed: speed,
      heading: heading,
      timestamp: Date.now()
    };
    WM.gpsState = { ...pCoords, lat, lng };
    setGpsCoords([lat, lng], pCoords, pCoords.timestamp);
  };

  WM.gpsDist = {
    isActive() { return isGpsDistEnabled; },
    refresh: updateGpsDistVisuals,
    enable() {
      if (isGpsDistEnabled) return;
      isGpsDistEnabled = true;
      syncGpsWatchState();
      const btn = document.getElementById('btn-gps-dist');
      if (btn) btn.classList.add('active');

      if (!userLatLng) {
        WM.ui.showToast('🛰️ Определение геопозиции…', 1500);
        acquireLocation(
          () => {
            updateGpsDistVisuals();
            WM.ui.showToast('🧭 Линия до GPS включена');
          },
          (err) => {
            WM.ui.showToast('Ошибка геопозиции: ' + err.message);
          }
        );
        return;
      }
      updateGpsDistVisuals();
      WM.ui.showToast('🧭 Линия до GPS включена');
    },
    disable() {
      if (!isGpsDistEnabled) return;
      isGpsDistEnabled = false;
      syncGpsWatchState();
      const btn = document.getElementById('btn-gps-dist');
      if (btn) btn.classList.remove('active');
      updateGpsDistVisuals();
      WM.ui.showToast('🧭 Линия до GPS скрыта');
    },
    toggle() {
      if (isGpsDistEnabled) this.disable();
      else this.enable();
    }
  };

  WM.view.render();
  WM.loader.update();
  refreshStatus();

  if (WM.ui && WM.ui.updateMotionBtnState) {
    WM.ui.updateMotionBtnState();
  }

  if (WM.ui && WM.ui.updateManualPdrBtnState) {
    WM.ui.updateManualPdrBtnState();
  }

  function onAppResume() {
    setTimeout(function() {
      if (WM.map) {
        WM.map.invalidateSize({ pan: false, debounceMoveEvents: true });
      }
      if (WM.view) {
        WM.view.render();
      }
      if (window.refreshAppStatus) {
        window.refreshAppStatus();
      }
    }, 150);
  }

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      onAppResume();
      WM.loader.retryNow();
    }
  });

  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', function(state) {
      if (state.isActive) {
        onAppResume();
      }
    });
  }

  // =========================================================================
  // ДЕБАГ-МОДУЛЬ: ДИАГНОСТИКА SERVICE WORKER И CACHE STORAGE
  // =========================================================================
  async function runSwDiagnostics() {
    const logEl = document.getElementById('sw-debug-log');
    if (!logEl) return;
    
    logEl.textContent = '⏳ Выполняется диагностика...\n';
    const out = [];
    const log = (msg) => { out.push(msg); logEl.textContent = out.join('\n'); };

    log(`[Окружение]`);
    log(`• Origin: ${window.location.origin}`);
    log(`• Protocol: ${window.location.protocol}`);
    log(`• Capacitor: ${typeof window.Capacitor !== 'undefined' ? 'Да (Native APK)' : 'Нет (Браузер)'}`);
    log(`• UserAgent: ${navigator.userAgent.slice(0, 70)}...`);

    log(`\n[Поддержка API]`);
    log(`• 'serviceWorker' in navigator: ${'serviceWorker' in navigator}`);
    log(`• 'caches' in window: ${'caches' in window}`);

    log(`\n[Проверка доступности sw.js]`);
    try {
      const swFetch = await fetch('./sw.js', { cache: 'no-store' });
      log(`• fetch('./sw.js') HTTP: ${swFetch.status} ${swFetch.statusText}`);
      log(`• Content-Type: ${swFetch.headers.get('content-type')}`);
      const text = await swFetch.text();
      log(`• Размер файла: ${text.length} байт`);
    } catch (err) {
      log(`❌ ОШИБКА загрузки sw.js: ${err.name} - ${err.message}`);
    }

    log(`\n[Регистрация Service Worker]`);
    if ('serviceWorker' in navigator) {
      log(`• controller: ${navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : 'null'}`);
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        log(`• Найдено регистраций: ${regs.length}`);
        regs.forEach((r, idx) => {
          log(`  [${idx + 1}] scope: ${r.scope}`);
          log(`      active: ${r.active ? r.active.state : 'нет'}`);
        });

        if (regs.length === 0) {
          log(`⚠️ Попытка принудительной регистрации './sw.js'...`);
          const newReg = await navigator.serviceWorker.register('./sw.js');
          log(`✅ Успешно зарегистрирован! Scope: ${newReg.scope}`);
        }
      } catch (err) {
        log(`❌ ОШИБКА регистрации SW: ${err.name} - ${err.message}`);
      }
    }

    log(`\n[Анализ CacheStorage]`);
    if ('caches' in window) {
      try {
        const keys = await caches.keys();
        log(`• Найдено кэшей: ${keys.length} [${keys.join(', ')}]`);

        for (const k of keys) {
          const c = await caches.open(k);
          const reqs = await c.keys();
          log(`  - "${k}": ${reqs.length} записей`);
        }
      } catch (err) {
        log(`❌ ОШИБКА чтения CacheStorage: ${err.message}`);
      }
    }

    log(`\n--- Диагностика завершена ---`);
  }

  document.getElementById('btn-open-sw-debug')?.addEventListener('click', () => {
    document.getElementById('modal-sw-debug')?.classList.add('open');
    runSwDiagnostics();
  });
  document.getElementById('btn-sw-debug-rerun')?.addEventListener('click', runSwDiagnostics);
  document.getElementById('btn-sw-debug-copy')?.addEventListener('click', () => {
    const text = document.getElementById('sw-debug-log')?.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      if (window.WM && WM.ui) WM.ui.showToast('📋 Отчёт скопирован');
    });
  });
})();

// =========================================================================
// СИМУЛЯТОР ДВИЖЕНИЯ GPS
// =========================================================================
(function initGpsSimulator() {
  let simTimer = null;
  let simActive = false;
  let simLat = null;
  let simLng = null;
  let simAngle = 0;
  let simStep = 0;

  function toggle() {
    const btn = document.getElementById('perf-btn-gps-sim');
    if (simActive) {
      simActive = false;
      clearInterval(simTimer);
      simTimer = null;
      if (btn) {
        btn.textContent = '🚶 Тест ходьбы GPS (лес)';
        btn.classList.remove('active');
      }
      if (window.WM && WM.ui && WM.ui.showToast) WM.ui.showToast('🛑 Эмуляция ходьбы остановлена');
    } else {
      simActive = true;
      simStep = 0;

      const curLL = (window.WM && WM.map) ? WM.map.getCenter() : { lat: 55.75124, lng: 37.61842 };
      simLat = curLL.lat;
      simLng = curLL.lng;
      simAngle = Math.random() * Math.PI * 2;

      if (btn) {
        btn.textContent = '🛑 Стоп GPS-тест (ходьба)';
        btn.classList.add('active');
      }
      if (window.WM && WM.ui && WM.ui.showToast) WM.ui.showToast('🚶 Запущена ходьба по лесу (~4.8 км/ч)');

      simTimer = setInterval(() => {
        simStep++;
        const walkSpeed = 1.35 + (Math.sin(simStep * 0.35) * 0.2);
        simAngle += (Math.sin(simStep * 0.12) * 0.08) + ((Math.random() - 0.5) * 0.04);

        const distMeters = walkSpeed * 1.0;
        const dLat = (distMeters * Math.cos(simAngle)) / 111320;
        const cosLat = Math.cos(simLat * Math.PI / 180) || 1;
        const dLng = (distMeters * Math.sin(simAngle)) / (111320 * cosLat);

        const jitterLat = ((Math.random() - 0.5) * 2.0) / 111320;
        const jitterLng = ((Math.random() - 0.5) * 2.0) / (111320 * cosLat);

        simLat += dLat + jitterLat;
        simLng += dLng + jitterLng;

        let headingDeg = (simAngle * 180 / Math.PI);
        headingDeg = (headingDeg % 360 + 360) % 360;

        if (window.WM && typeof WM.setGpsPosition === 'function') {
          WM.setGpsPosition(simLat, simLng, walkSpeed, Math.round(headingDeg));
        }
      }, 1000);
    }
  }

  window.WM = window.WM || {};
  WM.gpsSimulator = { toggle, isRunning: () => simActive };
})();

window._wmSensorEventsCount = 0;
// 2. Функция мониторинга
function initPerfMonitor() {
  const hud = document.getElementById('perf-hud');
  const toggle = document.getElementById('toggle-perf-hud');
  const closeBtn = document.getElementById('perf-hud-close');

  const elFps = document.getElementById('perf-fps');
  const elFtime = document.getElementById('perf-ftime');
  const elDomTiles = document.getElementById('perf-dom-tiles');
  const elDomNodes = document.getElementById('perf-dom-nodes');
  const elSensors = document.getElementById('perf-sensors');
  const elLongTasks = document.getElementById('perf-long-tasks');
  const elDpr = document.getElementById('perf-dpr');

  let isEnabled = localStorage.getItem('wm_perf_hud') === 'true';
  let frameCount = 0;
  let lastTime = performance.now();
  let lastFrameTime = performance.now();
  let maxFrameDelta = 0;
  let longTasksCount = 0;
  let rafId = 0;

  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) longTasksCount++;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  }

  function updateVisibility(show) {
    isEnabled = show;
    localStorage.setItem('wm_perf_hud', show ? 'true' : 'false');
    if (hud) hud.hidden = !show;
    if (toggle) toggle.checked = show;
    if (show) {
      lastTime = performance.now();
      lastFrameTime = performance.now();
      frameCount = 0;
      maxFrameDelta = 0;
      loop();
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function loop() {
    if (!isEnabled) return;
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;

    if (delta > maxFrameDelta) maxFrameDelta = delta;
    frameCount++;

    // Обновляем статистику раз в секунду
    if (now >= lastTime + 1000) {
      const elapsed = now - lastTime;
      const fps = Math.round((frameCount * 1000) / elapsed);
      const avgFrameTime = elapsed / frameCount;

      const sensorHz = Math.round((window._wmSensorEventsCount * 1000) / elapsed);
      window._wmSensorEventsCount = 0;

      frameCount = 0;
      lastTime = now;

      if (elFps) {
        elFps.textContent = fps + ' fps';
        elFps.className = fps >= 50 ? 'good' : (fps >= 30 ? 'warn' : 'bad');
      }

      if (elFtime) {
        elFtime.textContent = `${avgFrameTime.toFixed(1)} мс (пик ${maxFrameDelta.toFixed(0)} мс)`;
        elFtime.style.color = maxFrameDelta > 33 ? '#ef4444' : '#22c55e';
      }
      maxFrameDelta = 0;

      if (elSensors) {
        elSensors.textContent = sensorHz + ' Гц';
        elSensors.style.color = sensorHz > 40 ? '#f59e0b' : '#22c55e';
      }

      if (elDomTiles) {
        const totalTiles = document.querySelectorAll('.leaflet-tile').length;
        elDomTiles.textContent = totalTiles;
        elDomTiles.style.color = totalTiles > 60 ? '#f59e0b' : '#ffffff';
      }

      if (elDomNodes) {
        const nodes = document.getElementsByTagName('*').length;
        elDomNodes.textContent = nodes;
        elDomNodes.style.color = nodes > 1200 ? '#f59e0b' : '#ffffff';
      }

      if (elLongTasks) {
        elLongTasks.textContent = longTasksCount;
        elLongTasks.style.color = longTasksCount > 0 ? '#ef4444' : '#ffffff';
      }

      if (elDpr) {
        const dpr = window.devicePixelRatio || 1;
        elDpr.textContent = `${window.innerWidth}×${window.innerHeight} (${dpr}x)`;
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  if (toggle) {
    toggle.checked = isEnabled;
    toggle.onchange = (e) => updateVisibility(e.target.checked);
  }
  if (closeBtn) closeBtn.onclick = () => updateVisibility(false);

  const btnSim = document.getElementById('perf-btn-gps-sim');
  if (btnSim && window.WM && WM.gpsSimulator) {
    btnSim.onclick = () => WM.gpsSimulator.toggle();
  }

  if (isEnabled) updateVisibility(true);
}
// Запуск строго после полной загрузки дерева DOM:
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPerfMonitor);
} else {
  initPerfMonitor();
}