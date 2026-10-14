// =========================================================================
// АВТОМАТИЧЕСКИЙ ПОВТОР И ИНДИКАЦИЯ СОСТОЯНИЙ ТАЙЛОВ КАРТЫ
// =========================================================================
(function() {
  const origTileOnError = L.TileLayer.prototype._tileOnError;
  const origTileOnLoad  = L.TileLayer.prototype._tileOnLoad;
  const origInitTile    = L.GridLayer.prototype._initTile;

  L.GridLayer.include({
    // Перехватываем именно _initTile, так как Leaflet выставляет размеры именно здесь!
    _initTile: function(tile) {
      origInitTile.call(this, tile);
      const size = this.getTileSize();
      // 1px нахлёста физически перекрывает субпиксельный зазор соседнего тайла
      tile.style.width = (size.x + 1) + 'px';
      tile.style.height = (size.y + 1) + 'px';
    },

    _tileOnLoad: function(done, tile) {
      tile.classList.remove('leaflet-tile-retry', 'leaflet-tile-error');
      origTileOnLoad.call(this, done, tile);
    },

    _tileOnError: function(done, tile, e) {
      const currentSrc = tile.getAttribute('src') || '';
      if (currentSrc.startsWith('data:')) {
        origTileOnError.call(this, done, tile, e);
        return;
      }

      tile._retryCount = (tile._retryCount || 0) + 1;
      const maxRetries = 3;

      if (tile._retryCount <= maxRetries && this._map) {
        tile.classList.add('leaflet-tile-retry');
        tile.classList.remove('leaflet-tile-error');

        const delay = tile._retryCount * 1400;
        setTimeout(() => {
          if (this._map && tile.parentNode) {
            const src = tile.getAttribute('src');
            if (src && !src.startsWith('data:')) {
              tile.src = src;
              return;
            }
          }
          tile.classList.remove('leaflet-tile-retry');
          tile.classList.add('leaflet-tile-error');
          origTileOnError.call(this, done, tile, e);
        }, delay);
        return;
      }

      tile.classList.remove('leaflet-tile-retry');
      tile.classList.add('leaflet-tile-error');
      origTileOnError.call(this, done, tile, e);
    }
  });
})();

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
    zoomSnap: 1,
    zoomDelta: 1,
    zoomAnimation: true,
    fadeAnimation: false, // <-- ОТКЛЮЧАЕТ внутренний сброс тайла в opacity: 0
    zoomAnimationThreshold: 4
  }).setView(saved ? saved.c : [55.751244, 37.618423], saved ? saved.z : 16);

  L.control.zoom({ position: 'topleft' }).addTo(map);

  const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Базовые параметры экономии трафика для ВСЕХ слоев тайлов
const isMobile = L.Browser.mobile;

  const COMMON_TILE_OPTIONS = {
    keepBuffer: 3,                 // Держим чуть больший запас тайлов вокруг экрана, чтобы они не удалялись на границе
    updateWhenIdle: isMobile,      // На смартфонах обновляем тайлы только в паузах скролла — устраняет дёрганье!
    updateWhenZooming: true,       // Разрешаем Leaflet плавно масштабировать тайлы во время зума
    updateInterval: isMobile ? 200 : 100,
    errorTileUrl: EMPTY_TILE
  };



  // =========================================================================
  // БАЗОВЫЕ ПАНЕЛИ (PANES) КАРТЫ
  // =========================================================================

  map.createPane('wm-underlay');
  map.getPane('wm-underlay').style.zIndex = 150; // Лежит строго ПОД основными слоями (200)

  // Слой рельефа (Hillshade / Shaded Relief) с режимом multiply для теней и объема базовым картам
  map.createPane('wm-hillshade-pane');
  map.getPane('wm-hillshade-pane').style.zIndex = 250; // Над базой (200), под растром Wikimapia (350)
  map.getPane('wm-hillshade-pane').style.mixBlendMode = 'multiply';

  map.createPane('wm-top-lines');
  map.getPane('wm-top-lines').style.zIndex = 480; // Строго НАД полигонами Wikimapia (420, 450, 460)

  map.createPane('wm-raster-pane');
  map.getPane('wm-raster-pane').style.zIndex = 350; // Под векторами (420), над базой

  // -------------------------------------------------------------------------
  // АДАПТЕР BING MAPS (QuadKey адресация)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // АДАПТЕР YANDEX MAPS (коррекция проекции EPSG:3395 в EPSG:3857 без сдвига)
  // -------------------------------------------------------------------------
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
      tile.style.height = (h + 1) + 'px';
      return tile;
    }
  });

  // Фоновая обзорная подложка (только для малых масштабов 0-11)
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

  // Добавляем только если начальный зум <= 11
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
  const tfOutdoors = L.tileLayer('https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png', {
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

  // Полный каталог базовых карт с точными тестовыми координатами для проверки доступности
  WM.baseMapsCatalog = [
    // --- 1. Спутниковые снимки ---
    { id: 'satEsri', name: 'Спутник (Esri)', category: 'modern', layer: satEsri, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satClarity', name: 'Спутник (Esri Clarity)', category: 'modern', layer: satClarity, testUrl: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satGoogle', name: 'Спутник + Дороги (Google)', category: 'modern', layer: satGoogle, testUrl: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satBing', name: 'Спутник (Bing)', category: 'modern', layer: satBing, testUrl: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satYandex', name: 'Спутник (Яндекс)', category: 'modern', layer: satYandex, testUrl: 'https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang=ru_RU', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },

    // --- 2. Топографические и туристические карты ---
    { id: 'cyclOSM', name: 'Тропы и грунтовки (CyclOSM)', category: 'modern', layer: cyclOSM, testUrl: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'openTopo', name: 'Топокарта OpenTopoMap', category: 'modern', layer: openTopo, testUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc', name: 'Топокарты ГГЦ 250-1000м', category: 'modern', layer: ggc, testUrl: 'https://tiles.nakarte.me/ggc1000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc2000', name: 'Топокарта ГГЦ 2 км ', category: 'modern', layer: ggc2000, testUrl: 'https://tiles.nakarte.me/ggc2000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'arbaletMO', name: 'Топокарта Арбалет (Москва и МО)', category: 'modern', layer: arbaletMO, testUrl: 'https://tiles.nakarte.me/ArbaletMO/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'genshtab1980', name: 'Топокарта Генштаб 1-2 км (1980-е)', category: 'modern', layer: genshtab1980, testUrl: 'https://russia3d.ru/maps/tiles/topomaper1-2km1980/webmercator/{z}/{x}/{y}.png', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'tfOutdoors', name: 'Thunderforest Outdoors', category: 'modern', layer: tfOutdoors, testUrl: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },

    // --- 3. Схемы и городские дорожные карты ---
    { id: 'osmClassic', name: 'Схема OSM (Классика)', category: 'modern', layer: osmClassic, testUrl: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'osmHot', name: 'Гуманитарная карта OSM ', category: 'modern', layer: osmHot, testUrl: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeYandex', name: 'Схема (Яндекс)', category: 'modern', layer: schemeYandex, testUrl: 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&scale=1&lang=ru_RU', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'narodYandex', name: 'Народная карта (Яндекс)', category: 'modern', layer: narodYandex, testUrl: `https://{s}.core-nmaps-renderer-nmaps.maps.yandex.net/tile2?x={x}&y={y}&z={z}&l=mpmap&sl=${YANDEX_SL}&token=`, subdomains: ['01', '02', '03', '04'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeGoogle', name: 'Схема (Google)', category: 'modern', layer: schemeGoogle, testUrl: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeEsri', name: 'Схема (Esri Streets)', category: 'modern', layer: schemeEsri, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'schemeDark', name: 'Тёмная карта (Esri)', category: 'modern', layer: schemeDark, testUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },

    // --- 4. Исторические карты ---
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
      .filter(m => m.category === 'historical' && m.id !== 'rkkaEtomesto')
      .map(m => m.name);
  }
  WM.getDefaultDisabledBaseMaps = getDefaultDisabledBaseMaps;

  let layersControl = null;

  if (localStorage.getItem('wm_disabled_base_maps') === null) {
    try {
      localStorage.setItem('wm_disabled_base_maps', JSON.stringify(getDefaultDisabledBaseMaps()));
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

    const activeBaseMapName = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
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

  // Обновление состояния кнопки на экране
  function updateQuickSwapUI() {
    if (!btnQuickSwap) return;
    const isEnabled = localStorage.getItem('wm_quick_swap_enabled') !== 'false';
    btnQuickSwap.hidden = !isEnabled;
    if (!isEnabled) return;

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

    // Режим KML-карты
    if (targetMap.startsWith('kml:')) {
      const kmlId = targetMap.slice(4);
      const kml = WM.imageOverlay && WM.imageOverlay.getOverlay ? WM.imageOverlay.getOverlay(kmlId) : null;
      if (kml) {
        const isVisible = kml.visible !== false;
        btnQuickSwap.classList.toggle('active-target', isVisible);
        btnQuickSwap.title = isVisible 
          ? `Скрыть слой «${kml.name}» (удерживайте для выбора)` 
          : `Показать слой «${kml.name}» (удерживайте для выбора)`;
        return;
      }
    }

    // Режим обычной базовой подложки
    const currentMap = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
    const isCurrentlyTarget = (currentMap === targetMap);

    btnQuickSwap.classList.toggle('active-target', isCurrentlyTarget);
    btnQuickSwap.title = isCurrentlyTarget 
      ? `Вернуться на предыдущую карту (удерживайте для выбора второй карты)` 
      : `Переключить на «${targetMap}» (удерживайте для выбора второй карты)`;
  }


  window.updateQuickSwapUI = updateQuickSwapUI;

  // Окно выбора карты/слоя по долгому тапу
  function openQuickSwapTargetModal() {
    const modal = document.getElementById('modal-quick-swap-select');
    const listEl = document.getElementById('quick-swap-maps-list');
    if (!modal || !listEl || !WM.baseMapsCatalog) return;

    initQuickSwapModal(); // Гарантирует работу крестика и клика в пустоту

    const currentTarget = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';
    const currentBase = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';

    let disabledList = [];
    try {
      const stored = localStorage.getItem('wm_disabled_base_maps');
      if (stored !== null) disabledList = JSON.parse(stored) || [];
    } catch (e) {}

    listEl.innerHTML = '';

    // --- 1. Секция многотайловых KML карт (если загружены) ---
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

    // --- 2. Секция стандартных подложек ---
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
        const sel = document.getElementById('quick-swap-map-select');
        if (sel) sel.value = m.name;

        updateQuickSwapUI();
        modal.classList.remove('open');
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`🔀 Вторая карта: ${m.name}`);
        }
      };

      listEl.appendChild(itemBtn);
    });

    modal.classList.add('open');
  }

  // =========================================================================
  // ОБРАБОТКА КОРОТКОГО И ДОЛГОГО НАЖАТИЯ ДЛЯ КНОПКИ БЫСТРОЙ СМЕНЫ КАРТЫ
  // =========================================================================
  let swapHoldTimer = null;
  let isSwapLongPressed = false;
  let swapTouchStartPt = null;

  // 1. Контекстное меню (ПК — правый клик)
  btnQuickSwap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openQuickSwapTargetModal();
  });

  // 2. Долгий тап на смартфоне
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

  // 3. Долгое удержание левой кнопки мыши на ПК
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

  // 4. Обычный короткий клик (переключение)
  btnQuickSwap.onclick = (e) => {
    if (isSwapLongPressed || mouseIsLong) {
      mouseIsLong = false;
      return;
    }

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

    // А) Переключение отображения KML-слоя
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

    // Б) Переключение между базовыми картами
    const currentMap = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
    const prevMap = localStorage.getItem('wm_quick_swap_previous') || 'Тропы и грунтовки (CyclOSM)';

    if (currentMap !== targetMap) {
      localStorage.setItem('wm_quick_swap_previous', currentMap);
      switchToBaseMap(targetMap);
      WM.ui.showToast(`🔀 Карта: ${targetMap}`);
    } else {
      const returnMap = (prevMap && prevMap !== targetMap) ? prevMap : 'Тропы и грунтовки (CyclOSM)';
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

  // 1. Монохромный рельеф Esri Hillshade (акцент на тени и склоны)
  const esriHillshade = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    pane: 'wm-hillshade-pane',
    maxNativeZoom: 16,
    maxZoom: 20,
    opacity: 0.65,
    className: 'wm-relief-tile wm-relief-hillshade',
    attribution: 'Esri Hillshade'
  });

  // 2. Вариант А: Esri World Shaded Relief (Гипсометрия + Цветовая высотная поясность)
  const esriShadedRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
    ...COMMON_TILE_OPTIONS,
    pane: 'wm-hillshade-pane',
    maxNativeZoom: 13,
    maxZoom: 20,
    opacity: 0.70,
    className: 'wm-relief-tile wm-relief-shaded',
    attribution: 'Esri Shaded Relief'
  });

  // 3. Вариант Б: Адаптер для Maps-For-Free Relief (Художественный SRTM-рельеф)
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

  // Wikimapia контуры (растр)
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
    keepBuffer: 2, // Было 0! Значение 0 уничтожало тайл при малейшем выходе за край экрана
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

    // На зумах 19 и 20 растровых тайлов у Wikimapia нет (только 4-кратное размытое растягивание с тяжелым SVG-фильтром)
    // Векторные полигоны полностью перекрывают эти масштабы, поэтому растр отключаем для 60 FPS
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

  // Инициализация слоев рельефа из localStorage
  let isHillshadeEnabled = localStorage.getItem('wm_overlay_hillshade') === 'true';
  if (isHillshadeEnabled) {
    esriHillshade.addTo(map);
  }

  let isShadedReliefEnabled = localStorage.getItem('wm_overlay_shaded_relief') === 'true';
  if (isShadedReliefEnabled) {
    esriShadedRelief.addTo(map);
  }

  let isMffReliefEnabled = localStorage.getItem('wm_overlay_mff_relief') === 'true';
  if (isMffReliefEnabled) {
    mffRelief.addTo(map);
  }

  // --- Слой тайников Geocaching.su ---
  map.createPane('wm-geocaching');
  map.getPane('wm-geocaching').style.zIndex = 430;
  const geocachingLayer = L.layerGroup();
  const isGeocachingEnabled = localStorage.getItem('wm_overlay_geocaching') === 'true';
  if (isGeocachingEnabled) {
    geocachingLayer.addTo(map);
  }

  // --- Векторные полигоны Wikimapia ---
  const vectorPolygonsLayer = L.layerGroup();
  let isVectorsEnabled = localStorage.getItem('wm_overlay_vectors') !== 'false';
  if (isVectorsEnabled) {
    vectorPolygonsLayer.addTo(map);
  }

  const overlayLayers = {
    'Контуры Wikimapia': wmContours,
    'Полигоны Wikimapia (вектор)': vectorPolygonsLayer,
    'Рельеф: Тени (Esri)': esriHillshade,
    'Рельеф: Гипсометрия (Esri)': esriShadedRelief,
    'Рельеф: Художественный SRTM': mffRelief,
    'Тайники (Geocaching.su)': geocachingLayer
  };

  map.on('overlayadd', (e) => {
    if (isProgrammaticLayerChange) return;

    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = true;
      localStorage.setItem('wm_overlay_contours', 'true');
      syncOverlayMode();
    } else if (e.name === 'Полигоны Wikimapia (вектор)') {
      isVectorsEnabled = true;
      localStorage.setItem('wm_overlay_vectors', 'true');
      WM.view.setVisible(true);
    } else if (e.name.includes('Тени (Esri)')) { // <-- БЫЛО: 'Esri Hillshade'
      localStorage.setItem('wm_overlay_hillshade', 'true');
    } else if (e.name.includes('Гипсометрия (Esri)')) { // <-- БЫЛО: 'Esri Shaded Relief'
      localStorage.setItem('wm_overlay_shaded_relief', 'true');
    } else if (e.name.includes('Художественный SRTM')) { // <-- БЫЛО: 'Maps-For-Free'
      localStorage.setItem('wm_overlay_mff_relief', 'true');
    } else if (e.name === 'Тайники (Geocaching.su)') {
      localStorage.setItem('wm_overlay_geocaching', 'true');
      if (WM.geocaching && WM.geocaching.enable) WM.geocaching.enable();
    }
  });

  map.on('overlayremove', (e) => {
    if (isProgrammaticLayerChange) return;

    if (e.name === 'Контуры Wikimapia') {
      isContoursEnabled = false;
      localStorage.setItem('wm_overlay_contours', 'false');
      syncOverlayMode();
    } else if (e.name === 'Полигоны Wikimapia (вектор)') {
      isVectorsEnabled = false;
      localStorage.setItem('wm_overlay_vectors', 'false');
      WM.view.setVisible(false);
    } else if (e.name.includes('Тени (Esri)')) {           // <-- БЫЛО: 'Esri Hillshade'
      localStorage.setItem('wm_overlay_hillshade', 'false');
    } else if (e.name.includes('Гипсометрия (Esri)')) {    // <-- БЫЛО: 'Esri Shaded Relief'
      localStorage.setItem('wm_overlay_shaded_relief', 'false');
    } else if (e.name.includes('Художественный SRTM')) {   // <-- БЫЛО: 'Maps-For-Free'
      localStorage.setItem('wm_overlay_mff_relief', 'false');
    } else if (e.name === 'Тайники (Geocaching.su)') {
      localStorage.setItem('wm_overlay_geocaching', 'false');
      if (WM.geocaching && WM.geocaching.disable) WM.geocaching.disable();
    }
  });

  rebuildBaseLayersControl();

  WM.map = map;

  await WM.cache.init();

  WM.view.init(map);
  WM.view.setVisible(isVectorsEnabled);
  WM.picker.init(map);
  if (WM.ui && WM.ui.init) WM.ui.init();
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

  // === ВОТ СЮДА ВСТАВЛЯЕТСЯ ИНИЦИАЛИЗАЦИЯ НАЛОЖЕННЫХ КАРТ ===
  if (WM.imageOverlay) {
    await WM.imageOverlay.init(map);
  }

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

  let isRenderScheduled = false;
  const scheduleRender = () => {
    if (isRenderScheduled) return;
    isRenderScheduled = true;
    requestAnimationFrame(() => {
      isRenderScheduled = false;
      WM.view.render();
      refreshStatus();
      WM.picker.refresh();
    });
  };

  WM.loader.init(map, { onChange: scheduleRender, onStatus: refreshStatus });

  map.on('movestart zoomstart', () => {
    if (WM.loader && WM.loader.stopDetailsQueue) {
      WM.loader.stopDetailsQueue();
    }
  });

  let moveTimer = 0;
  map.on('moveend', () => {
    // scheduleRender() использует requestAnimationFrame с флагом-стражем,
    // исключая повторный синхронный рендер, если зум только что завершился
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
  const tailPoints = []; // [{ latlng: L.latLng, time: number, accuracy: number }]

  let isTailEnabled = true;
  let tailMaxPoints = 15;
  let tailColor = '#0284c7';

  try {
    const savedEn = localStorage.getItem('wm_tail_enabled');
    if (savedEn !== null) isTailEnabled = (savedEn !== 'false');
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
      const progress = (i + 1) / totalSegs; // от ~0.1 до 1.0 (градиент свежести)

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

      // Маленькая точка в узле для читаемости траектории
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
    if (!isTailEnabled) return;

    const newLL = L.latLng(latlng[0], latlng[1]);
    const now = timestamp || Date.now();
    const accuracy = (coords && coords.accuracy) || 10;

    // 1. Фильтр плохой точности (погрешность > 40 м отсекаем)
    if (accuracy > 40) return;

    if (tailPoints.length > 0) {
      const last = tailPoints[tailPoints.length - 1];
      const dist = last.latlng.distanceTo(newLL);
      const dt = (now - last.time) / 1000;

      // 2. Защита от кляксы при стоянке на месте (динамический порог)
      const minDistance = Math.max(3.8, Math.min(10, accuracy * 0.45));
      if (dist < minDistance) {
        return; // Стоим на месте, не плодим узлы друг на друге
      }

      // 3. Защита от телепортации и разрывов связи
      const impliedSpeedKmh = dt > 0 ? (dist / dt) * 3.6 : 0;
      if (dt > 150 || (dist > 500 && impliedSpeedKmh > 180)) {
        clearTail(); // Сброс хвоста при скачке
      }
    }

    tailPoints.push({ latlng: newLL, time: now, accuracy });

    while (tailPoints.length > tailMaxPoints) {
      tailPoints.shift();
    }

    redrawTail();
  }

  WM.motionTail = {
    isEnabled: () => isTailEnabled,
    setEnabled(val) {
      isTailEnabled = !!val;
      try { localStorage.setItem('wm_tail_enabled', isTailEnabled ? 'true' : 'false'); } catch (e) {}
      if (!isTailEnabled) clearTail();
      else redrawTail();
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
  // МОДУЛЬ КОМПАСА И ОРИЕНТАЦИИ УСТРОЙСТВА (DEVICE ORIENTATION API)
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

  function getCompassHeadingFromAngles(alpha, beta, gamma) {
    const degToRad = Math.PI / 180;
    const _x = beta ? beta * degToRad : 0;
    const _y = gamma ? gamma * degToRad : 0;
    const _z = alpha ? alpha * degToRad : 0;

    const cX = Math.cos(_x), sX = Math.sin(_x);
    const cY = Math.cos(_y), sY = Math.sin(_y);
    const cZ = Math.cos(_z), sZ = Math.sin(_z);

    const Vx = -cZ * sY - sZ * sX * cY;
    const Vy = -sZ * sY + cZ * sX * cY;

    let heading = Math.atan2(Vx, Vy) * (180 / Math.PI);
    if (heading < 0) heading += 360;
    return heading;
  }

  function onDeviceOrientation(e) {
    let heading = null;

    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== null && e.alpha !== undefined) {
      if (e.beta !== null && e.gamma !== null && (Math.abs(e.beta) > 20 || Math.abs(e.gamma) > 20)) {
        heading = getCompassHeadingFromAngles(e.alpha, e.beta, e.gamma);
      } else {
        heading = 360 - e.alpha;
      }
      const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      heading = (heading + screenAngle) % 360;
      if (heading < 0) heading += 360;
    }

    if (heading !== null && !isNaN(heading)) {
      currentHeading = Math.round(heading);
      updateCompassVisuals();
    }
  }

  function updateCompassVisuals() {
    if (currentHeading === null) return;

    if (isConeEnabled && me) {
      const el = me.getElement();
      if (el) {
        const cone = el.querySelector('.wm-gps-cone');
        if (cone) {
          smoothConeAngle = unwrapAngle(currentHeading, smoothConeAngle);
          cone.style.display = '';
          cone.style.transform = `rotate(${smoothConeAngle}deg)`;
        }
      }
    }

    if (isNeedleEnabled) {
      const needle = document.getElementById('compass-needle');
      if (needle) {
        smoothNeedleAngle = unwrapAngle(-currentHeading, smoothNeedleAngle);
        needle.style.transform = `rotate(${smoothNeedleAngle}deg)`;
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

  async function startOrientationListener() {
    if (isOrientationListening) return;
    const granted = await requestOrientationPermission();
    if (!granted) return;

    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    }
    if ('ondeviceorientation' in window) {
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

  try {
    const savedVis = JSON.parse(localStorage.getItem('wm_ui_vis') || '{}');
    const cone = savedVis.compasscone !== undefined ? savedVis.compasscone : true;
    const needle = savedVis.compassneedle !== undefined ? savedVis.compassneedle : true;
    WM.compass.updateSettings(cone, needle);
  } catch (e) {
    WM.compass.updateSettings(true, true);
  }

  const btnCompass = document.getElementById('btn-compass');
  if (btnCompass) {
    btnCompass.onclick = async () => {
      await startOrientationListener();
      if (currentHeading !== null) {
        const arr = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
        const compDir = arr[Math.floor((currentHeading / 22.5) + 0.5) % 16];
        WM.ui.showToast(`🧭 Курс: ${currentHeading}° (${compDir}) · Красная стрелка — Север`);
      } else {
        WM.ui.showToast('🧭 Калибровка компаса… Поверните смартфон «восьмёркой»');
      }
    };
  }

// =========================================================================
  // ВСПОМОГАТЕЛЬНАЯ ГЕОМЕТРИЯ: ПЕЛЕНГ, ВРЕМЯ И СКОЛЬЖЕНИЕ ПО ЛИНИИ
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

  // Расчёт оптимальной точки скольжения бейджа по видимой на экране части линии
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

    // Середина видимой на экране части отрезка
    let tMid = (t0 + t1) / 2;

    // Не даём бейджу наезжать вплотную на конечные маркеры/точки
    const totalLen = Math.hypot(dx, dy);
    if (totalLen > 90) {
      const marginT = 36 / totalLen;
      tMid = Math.max(marginT, Math.min(1 - marginT, tMid));
    }

    const resPt = L.point(pA.x + tMid * dx, pA.y + tMid * dy);
    return map.containerPointToLatLng(resPt);
  }


  // =========================================================================
  // МОДУЛЬ «ТРАЕКТОРИЯ ДВИЖЕНИЯ» (MOTION VECTOR / COURSE PREDICTION)
  // =========================================================================
  const motionVectorLayer = L.layerGroup().addTo(map);
  let motionVectorLine = null;
  let motionVectorBadge = null;
  let isMotionVectorEnabled = true;

  try {
    const savedVis = JSON.parse(localStorage.getItem('wm_ui_vis') || '{}');
    if (savedVis.motionvector !== undefined) isMotionVectorEnabled = !!savedVis.motionvector;
  } catch (e) {}

 // Определение умного курса: 
  // 1-й приоритет: реальные точки движения (COG) на ходу/в авто
  // 2-й приоритет: магнитный компас устройства при стоянке на месте
  function getEstimatedMotionCourse() {
    const now = Date.now();
    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;
    
    // -----------------------------------------------------------------------
    // 1. ВЫСШИЙ ПРИОРИТЕТ: ВЕКТОР ПЕРЕМЕЩЕНИЯ ПО ТОЧКАМ (Course Over Ground)
    // -----------------------------------------------------------------------
    if (motionHistory.length >= 2) {
      // Берём окно точек за последние 8-10 секунд
      const recent = motionHistory.filter(p => now - p.time <= 10000);
      if (recent.length >= 2) {
        const pOld = recent[0];
        const pNew = recent[recent.length - 1];
        const dist = pOld.latlng.distanceTo(pNew.latlng);
        const dt = (pNew.time - pOld.time) / 1000;
        const speedFromPoints = dt > 0 ? (dist / dt) : 0;

        // Если есть физическое смещение >= 3.5 м и скорость >= 0.65 м/с (~2.3 км/ч — уверенный шаг)
        if (dist >= 3.5 && (speed >= 0.65 || speedFromPoints >= 0.65)) {
          return computeBearing(pOld.latlng, pNew.latlng);
        }
      }
    }

    // Дополнительный аппаратный курс чипа GPS при скорости > 3 км/ч
    if (WM.gpsState && WM.gpsState.heading != null && !isNaN(WM.gpsState.heading) && speed >= 0.85) {
      return WM.gpsState.heading;
    }

    // -----------------------------------------------------------------------
    // 2. РЕЖИМ СТОЯНКИ / МЕДЛЕННОГО ОСМОТРА: Датчики ориентации (Компас)
    // -----------------------------------------------------------------------
    // Срабатывает только когда пользователь стоит на месте или движется медленнее 2 км/ч
    if (currentHeading !== null) {
      return currentHeading;
    }

    // 3. Fallback: если стоим и компас не откалиброван, сохраняем последний курс движения
    if (motionHistory.length >= 2) {
      const pOld = motionHistory[0];
      const pNew = motionHistory[motionHistory.length - 1];
      if (pOld.latlng.distanceTo(pNew.latlng) >= 2.5) {
        return computeBearing(pOld.latlng, pNew.latlng);
      }
    }

    return null;
  }

  // Быстрый 2D-расчет пересечения луча движения с прямоугольником видимой карты
  function clipRayToBounds(originLL, courseDeg, maxRayLenMeters, bounds) {
    const R = 6371e3;
    const courseRad = courseDeg * Math.PI / 180;
    const sinC = Math.sin(courseRad);
    const cosC = Math.cos(courseRad);

    const mPerLat = 111320;
    const mPerLng = mPerLat * Math.cos(originLL.lat * Math.PI / 180);

    const targetEndLL = L.latLng(
      originLL.lat + (maxRayLenMeters * cosC) / mPerLat,
      originLL.lng + (maxRayLenMeters * sinC) / mPerLng
    );

    // Параметрический поиск t в диапазоне [0, 1] для отрезка [origin, targetEnd]
    let t0 = 0;
    let t1 = 1;

    const dx = targetEndLL.lng - originLL.lng;
    const dy = targetEndLL.lat - originLL.lat;

    const p = [-dx, dx, -dy, dy];
    const q = [
      originLL.lng - bounds.getWest(),
      bounds.getEast() - originLL.lng,
      originLL.lat - bounds.getSouth(),
      bounds.getNorth() - originLL.lat
    ];

    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return null; // Параллелен и снаружи
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) {
          if (t > t1) return null;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return null;
          if (t < t1) t1 = t;
        }
      }
    }

    if (t0 > t1) return null;

    // Точки отрезка, попадающие на экран
    const startLL = (t0 <= 0) 
      ? originLL 
      : L.latLng(originLL.lat + t0 * dy, originLL.lng + t0 * dx);

    const endLL = L.latLng(originLL.lat + t1 * dy, originLL.lng + t1 * dx);

    return { startLL, endLL, isEnteringFromOutside: t0 > 0.001 };
  }

  function updateMotionVectorVisuals() {
    if (!isMotionVectorEnabled || !userLatLng || !map) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      return;
    }

    const course = getEstimatedMotionCourse();
    const speed = (WM.gpsState && WM.gpsState.speed != null) ? WM.gpsState.speed : 0;

    // Не чертим вектор, если стоим на месте (скорость < 1.2 км/ч) и нет чёткого курса
    if (course === null || speed < 0.35) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      return;
    }

    const originLL = L.latLng(userLatLng[0], userLatLng[1]);
    const bounds = map.getBounds().pad(0.02);

    // Длина луча: запас хода на 8 минут, минимум 1 км, максимум 40 км
    const maxRayLen = Math.max(1000, Math.min(40000, speed * 480));

    const clipped = clipRayToBounds(originLL, course, maxRayLen, bounds);
    if (!clipped) {
      motionVectorLayer.clearLayers();
      motionVectorLine = null;
      motionVectorBadge = null;
      return;
    }

    const { startLL, endLL, isEnteringFromOutside } = clipped;

    // Отрисовка линии курса
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

    // Если GPS находится за экраном, но мы идём в сторону просматриваемой области:
    // показываем в месте входа луча на экран бейдж-указатель
    if (isEnteringFromOutside) {
      const badgeHtml = `<div class="wm-motion-vector-badge">▲ Вектор курса (${Math.round(speed * 3.6)} км/ч)</div>`;
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
      } else {
        motionVectorBadge.setLatLng(startLL);
        motionVectorBadge.setIcon(L.divIcon({
          className: 'wm-motion-badge-wrap',
          html: badgeHtml,
          iconSize: [140, 24],
          iconAnchor: [70, 12]
        }));
      }
    } else if (motionVectorBadge) {
      motionVectorLayer.removeLayer(motionVectorBadge);
      motionVectorBadge = null;
    }
  }

  WM.motionVector = {
    isEnabled: () => isMotionVectorEnabled,
    setEnabled(val) {
      isMotionVectorEnabled = !!val;
      if (!isMotionVectorEnabled) {
        motionVectorLayer.clearLayers();
        motionVectorLine = null;
        motionVectorBadge = null;
      } else {
        updateMotionVectorVisuals();
      }
    },
    getCourse: getEstimatedMotionCourse
  };

  // =========================================================================
  // МОДУЛЬ ОТОБРАЖЕНИЯ РАССТОЯНИЯ, СКОРОСТИ И ВРЕМЕНИ ДО ЦЕНТРА ЭКРАНА
  // =========================================================================

  // Вспомогательное форматирование дистанции для GPS-линий
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

  // =========================================================================
  // СОСТОЯНИЯ СВЁРНУТОСТИ ПЛАШЕК
  // =========================================================================
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
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
    }
    isNavTargetCollapsed = !isNavTargetCollapsed;
    try { localStorage.setItem('wm_nav_target_collapsed', isNavTargetCollapsed ? 'true' : 'false'); } catch (err) {}
    updateNavTargetVisuals();
  }

  // =========================================================================
  // ОБНОВЛЕНИЕ БЕЙДЖА: ДИСТАНЦИЯ ДО ЦЕНТРА ЭКРАНА
  // =========================================================================
  function updateGpsDistVisuals() {
    if (!isGpsDistEnabled || !userLatLng || !map) {
      if (gpsDistPolyline) { gpsDistLayer.removeLayer(gpsDistPolyline); gpsDistPolyline = null; }
      if (gpsDistBadgeMarker) { gpsDistLayer.removeLayer(gpsDistBadgeMarker); gpsDistBadgeMarker = null; }
      return;
    }

    const center = map.getCenter();
    const targetLL = L.latLng(userLatLng[0], userLatLng[1]);
    const dist = center.distanceTo(targetLL);

    const badgeLL = getVisibleSegmentPoint(map, targetLL, center, { left: 90, right: 90, top: 110, bottom: 120 });

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
      // Разница со знаком от -180° до +180°
      signedDiff = (motionCourse - bearingToCenter + 540) % 360 - 180;
      diffAngle = Math.abs(signedDiff);

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

    let badgeHtml = '';

    if (isGpsDistCollapsed) {
      // КОМПАКТНАЯ ВЕРСИЯ: только расстояние и скорость
      badgeHtml = `
        <div class="wm-gps-dist-badge col-badge compact ${colorClass}" title="Нажмите, чтобы развернуть">
          <span class="wm-gdb-compact-val">${distFormatted}</span>
          <span class="wm-gdb-compact-sep">·</span>
          <span class="wm-gdb-compact-val">${speedFormatted}</span>
          <button type="button" class="wm-gdb-toggle-btn" title="Развернуть подробности">▼</button>
        </div>
      `;
    } else {
      // ПОЛНАЯ ВЕРСИЯ: с временем прибытия, курсом и кнопкой сворачивания
      badgeHtml = `
        <div class="wm-gps-dist-badge col-badge ${colorClass}">
          <div class="wm-gdb-head">
            <span class="wm-gdb-icon">🧭</span>
            <span class="wm-gdb-name">К центру экрана</span>
            <button type="button" class="wm-gdb-toggle-btn" title="Свернуть подробности">▲</button>
          </div>
          <div class="wm-gdb-grid">
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Дистанция:</span>
              <span class="wm-gdb-val">${distFormatted}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Скорость:</span>
              <span class="wm-gdb-val">${speedFormatted}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">В пути:</span>
              <span class="wm-gdb-val ${isMovingAway ? 'negative' : ''}">${durationText}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Прибытие:</span>
              <span class="wm-gdb-val ${isMovingAway ? 'negative' : ''}">${etaClock}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Курс:</span>
              <span class="wm-gdb-val ${diffAngle > 55 ? 'negative' : ''}">${driftText}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (!gpsDistBadgeMarker) {
      gpsDistBadgeMarker = L.marker(badgeLL, {
        icon: L.divIcon({
          className: 'wm-gps-badge-wrap',
          html: badgeHtml,
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: true,
        zIndexOffset: 1400
      }).addTo(gpsDistLayer);

      gpsDistBadgeMarker._lastHtml = badgeHtml;
      gpsDistBadgeMarker.on('click', toggleGpsDistCollapse);
    } else {
      gpsDistBadgeMarker.setLatLng(badgeLL);
      if (gpsDistBadgeMarker._lastHtml !== badgeHtml) {
        gpsDistBadgeMarker._lastHtml = badgeHtml;
        const el = gpsDistBadgeMarker.getElement();
        if (el) el.innerHTML = badgeHtml;
      }
    }
  }



  // =========================================================================
  // МОДУЛЬ НАВИГАЦИИ НА ВЫБРАННУЮ ЦЕЛЬ (TARGET NAVIGATION)
  // =========================================================================
  const navTargetLayer = L.layerGroup().addTo(map);
  let navTargetPolyline = null;
  let navTargetBadgeMarker = null;
  let activeNavTarget = null; // { id, lat, lng, title }

  // =========================================================================
  // ОБНОВЛЕНИЕ БЕЙДЖА: НАВИГАЦИЯ НА ЦЕЛЬ
  // =========================================================================
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
      // Разница со знаком от -180° до +180°
      signedDiff = (motionCourse - bearingToTarget + 540) % 360 - 180;
      diffAngle = Math.abs(signedDiff);

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

    let badgeHtml = '';

    if (isNavTargetCollapsed) {
      // КОМПАКТНАЯ ВЕРСИЯ: только расстояние и скорость
      badgeHtml = `
        <div class="wm-gps-dist-badge col-badge compact ${colorClass}" title="Нажмите, чтобы развернуть">
          <span class="wm-gdb-compact-val">${distFormatted}</span>
          <span class="wm-gdb-compact-sep">·</span>
          <span class="wm-gdb-compact-val">${speedFormatted}</span>
          <button type="button" class="wm-gdb-toggle-btn" title="Развернуть подробности">▼</button>
        </div>
      `;
    } else {
      // ПОЛНАЯ ВЕРСИЯ: с временем прибытия, курсом и кнопкой сворачивания
      badgeHtml = `
        <div class="wm-gps-dist-badge col-badge ${colorClass}">
          <div class="wm-gdb-head">
            <span class="wm-gdb-icon">🎯</span>
            <span class="wm-gdb-name" title="${targetTitle}">${targetTitle}</span>
            <button type="button" class="wm-gdb-toggle-btn" title="Свернуть подробности">▲</button>
          </div>
          <div class="wm-gdb-grid">
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Дистанция:</span>
              <span class="wm-gdb-val">${distFormatted}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Скорость:</span>
              <span class="wm-gdb-val">${speedFormatted}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">В пути:</span>
              <span class="wm-gdb-val ${isMovingAway ? 'negative' : ''}">${durationText}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Прибытие:</span>
              <span class="wm-gdb-val ${isMovingAway ? 'negative' : ''}">${etaClock}</span>
            </div>
            <div class="wm-gdb-row">
              <span class="wm-gdb-lbl">Курс:</span>
              <span class="wm-gdb-val ${diffAngle > 55 ? 'negative' : ''}">${driftText}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (!navTargetBadgeMarker) {
      navTargetBadgeMarker = L.marker(badgeLL, {
        icon: L.divIcon({
          className: 'wm-gps-badge-wrap',
          html: badgeHtml,
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: true,
        zIndexOffset: 1450
      }).addTo(navTargetLayer);

      navTargetBadgeMarker._lastHtml = badgeHtml;
      navTargetBadgeMarker.on('click', toggleNavTargetCollapse);
    } else {
      navTargetBadgeMarker.setLatLng(badgeLL);
      if (navTargetBadgeMarker._lastHtml !== badgeHtml) {
        navTargetBadgeMarker._lastHtml = badgeHtml;
        const el = navTargetBadgeMarker.getElement();
        if (el) el.innerHTML = badgeHtml;
      }
    }
  }

  WM.navTarget = {
    set(target) {
      activeNavTarget = target;
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

  // Обновление при движении карты
  let moveAnimFrame = 0;
  map.on('move', () => {
    if (moveAnimFrame) return;
    moveAnimFrame = requestAnimationFrame(() => {
      moveAnimFrame = 0;
      if (isGpsDistEnabled) updateGpsDistVisuals();
      if (activeNavTarget) updateNavTargetVisuals();
      if (isMotionVectorEnabled) updateMotionVectorVisuals();
      if (WM.ui && WM.ui.updateRays) WM.ui.updateRays();
    });
  });

  // =========================================================================
  // НЕЗАВИСИМЫЙ БУФЕР ИСТОРИИ ПЕРЕМЕЩЕНИЙ ДЛЯ ВЫЧИСЛЕНИЯ КУРСА (COG)
  // =========================================================================
  const motionHistory = []; // [{ latlng: L.latLng, time: number, accuracy: number }]

  function updateMotionHistory(ll, coords, timestamp) {
    const newLL = L.latLng(ll[0], ll[1]);
    const now = timestamp || Date.now();
    const accuracy = (coords && coords.accuracy) || 10;
    
    // Игнорируем выбросы с грубой погрешностью (> 35 м)
    if (accuracy > 35) return;

    if (motionHistory.length > 0) {
      const last = motionHistory[motionHistory.length - 1];
      const dist = last.latlng.distanceTo(newLL);
      const dt = (now - last.time) / 1000;

      // Сброс буфера при скачке (телепортация или пауза более 45 сек)
      if (dt > 45 || (dist > 350 && (dist / Math.max(0.1, dt)) > 55)) {
        motionHistory.length = 0;
      }
    }

    motionHistory.push({ latlng: newLL, time: now, accuracy });

    // Храним точки за последние 12 секунд (до 15 записей)
    const cutoff = now - 12000;
    while (motionHistory.length > 0 && (motionHistory[0].time < cutoff || motionHistory.length > 15)) {
      motionHistory.shift();
    }
  }

  function setGpsCoords(ll, coords, timestamp) {
    userLatLng = ll;
    if (me) {
      me.setLatLng(ll);
    } else {
      me = L.marker(ll, {
        icon: WM.compass ? WM.compass.createGpsIcon() : L.divIcon(),
        interactive: false,
        zIndexOffset: 1200
      }).addTo(map);
    }

    // Всегда обновляем буфер перемещения независимо от визуального хвоста
    updateMotionHistory(ll, coords, timestamp);

    if (WM.motionTail) {
      WM.motionTail.addPoint(ll, coords, timestamp);
    }

    if (isMotionVectorEnabled) {
      updateMotionVectorVisuals();
    }
    if (isGpsDistEnabled) {
      updateGpsDistVisuals();
    }
    if (activeNavTarget) {
      updateNavTargetVisuals();
    }
    if (WM.compass) {
      updateCompassVisuals();
    }
  }

  // Непрерывное отслеживание движения:
  let gpsWatchId = null;
  function startGpsWatch() {
    if (gpsWatchId !== null || !navigator.geolocation) return;
    try {
      gpsWatchId = navigator.geolocation.watchPosition(
        (p) => {
          const ll = [p.coords.latitude, p.coords.longitude];
          WM.gpsState = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: p.coords.accuracy,
            altitude: p.coords.altitude,
            speed: p.coords.speed,
            heading: p.coords.heading,
            timestamp: p.timestamp
          };
          setGpsCoords(ll, p.coords, p.timestamp);
        },
        (e) => console.warn('GPS watch error:', e),
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
      );
    } catch (e) {}
  }





  function acquireLocation(onSuccess, onError) {
    if (!navigator.geolocation) {
      if (onError) onError(new Error('Геолокация не поддерживается устройством'));
      return;
    }
    startGpsWatch(); // Запускаем слежение при первом запросе локации
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll = [p.coords.latitude, p.coords.longitude];
        setGpsCoords(ll, p.coords, p.timestamp);
        WM.gpsState = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          altitude: p.coords.altitude,
          speed: p.coords.speed,
          heading: p.coords.heading,
          timestamp: p.timestamp
        };
        if (onSuccess) onSuccess(ll);
      },
      (e) => {
        if (onError) onError(e);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  WM.gpsDist = {
    isActive() { return isGpsDistEnabled; },
    refresh: updateGpsDistVisuals,
    enable() {
      if (isGpsDistEnabled) return;
      if (!userLatLng) {
        WM.ui.showToast('🛰️ Определение геопозиции…', 1500);
        acquireLocation(
          () => {
            isGpsDistEnabled = true;
            const btn = document.getElementById('btn-gps-dist');
            if (btn) btn.classList.add('active');
            updateGpsDistVisuals();
            WM.ui.showToast('🧭 Линия до GPS включена');
          },
          (err) => {
            WM.ui.showToast('Ошибка геопозиции: ' + err.message);
          }
        );
        return;
      }
      isGpsDistEnabled = true;
      const btn = document.getElementById('btn-gps-dist');
      if (btn) btn.classList.add('active');
      updateGpsDistVisuals();
      WM.ui.showToast('🧭 Линия до GPS включена');
    },
    disable() {
      if (!isGpsDistEnabled) return;
      isGpsDistEnabled = false;
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

  document.getElementById('btn-location').onclick = () => {
    if (WM.compass && WM.compass.start) {
      WM.compass.start();
    }
    acquireLocation(
      (ll) => {
        map.setView(ll, Math.max(map.getZoom(), 16));
      },
      (e) => alert('Ошибка геопозиции: ' + e.message)
    );
  };

  const savedMode = WM.api.store.get('wm_mode') || 'cross';
  WM.picker.setMode(savedMode);

  WM.view.render();
  WM.loader.update();
  refreshStatus();

  // =========================================================================
  // ОБРАБОТКА ВОЗВРАТА ИЗ ФОНА (Leaflet invalidateSize & перерисовка)
  // =========================================================================
  function onAppResume() {
    setTimeout(function() {
      if (WM.map) {
        // Заставляем Leaflet пересчитать реальные размеры экрана в пикселях
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

  // Срабатывает при возврате вкладки/приложения на передний план
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      onAppResume();
      WM.loader.retryNow();
    }
  });

  // Событие нативного плагина Capacitor при выходе из спящего режима
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

  // 1. Проверяем, отдается ли вообще сам sw.js
  log(`\n[Проверка доступности sw.js]`);
  try {
    const swFetch = await fetch('./sw.js', { cache: 'no-store' });
    log(`• fetch('./sw.js') HTTP: ${swFetch.status} ${swFetch.statusText}`);
    log(`• Content-Type: ${swFetch.headers.get('content-type')}`);
    const text = await swFetch.text();
    log(`• Размер файла: ${text.length} байт`);
  } catch (err) {
    log(`❌ ОШИБКА загрузки sw.js: ${err.name} - ${err.message}`);
    log(`   (В APK это означает, что WebView не может прочитать файл из ассетов!)`);
  }

  // 2. Статус регистрации Service Worker
  log(`\n[Регистрация Service Worker]`);
  if ('serviceWorker' in navigator) {
    log(`• controller: ${navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : 'null (SW не управляет страницей!)'}`);
    
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      log(`• Найдено регистраций: ${regs.length}`);
      regs.forEach((r, idx) => {
        log(`  [${idx + 1}] scope: ${r.scope}`);
        log(`      active: ${r.active ? r.active.state : 'нет'}`);
        log(`      installing: ${r.installing ? r.installing.state : 'нет'}`);
        log(`      waiting: ${r.waiting ? r.waiting.state : 'нет'}`);
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

  // 3. Анализ CacheStorage
  log(`\n[Анализ CacheStorage]`);
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      log(`• Найдено кэшей: ${keys.length} [${keys.join(', ')}]`);

      for (const k of keys) {
        const c = await caches.open(k);
        const reqs = await c.keys();
        log(`  - "${k}": ${reqs.length} записей`);
        if (k === 'wm-tiles-v1' && reqs.length > 0) {
          log(`    Пример URL: ${reqs[0].url.slice(0, 60)}...`);
        }
      }
    } catch (err) {
      log(`❌ ОШИБКА чтения CacheStorage: ${err.message}`);
    }
  }

  // 4. Тестовый запрос тайла через fetch
  log(`\n[Тест перехвата тайла]`);
  try {
    // Берём тайл CyclOSM или Esri, который идёт строго в 'wm-tiles-v1'
    const testTileUrl = 'https://tile-cyclosm.openstreetmap.fr/cyclosm/0/0/0.png';
    const res = await fetch(testTileUrl);
    log(`• Запрос тестового тайла: HTTP ${res.status}`);
    
    // Даём SW 300 мс на завершение фоновой записи cache.put()
    await new Promise(r => setTimeout(r, 300));

    if ('caches' in window) {
      const tileCache = await caches.open('wm-tiles-v1');
      const match = await tileCache.match(testTileUrl);
      log(`• Наличие в кэше 'wm-tiles-v1': ${match ? '✅ Сохранён в кэш' : '❌ НЕ попал в кэш'}`);
    }
  } catch (err) {
    log(`• Ошибка тестового запроса: ${err.message}`);
  }

  log(`\n--- Диагностика завершена ---`);
}

// Привязка обработчиков
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
