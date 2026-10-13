// =========================================================================
// АВТОМАТИЧЕСКИЙ ПОВТОР И ИНДИКАЦИЯ СОСТОЯНИЙ ТАЙЛОВ КАРТЫ
// =========================================================================
(function() {
  const origTileOnError = L.TileLayer.prototype._tileOnError;
  const origTileOnLoad  = L.TileLayer.prototype._tileOnLoad;

  L.TileLayer.include({
    _tileOnLoad: function(done, tile) {
      const src = tile.getAttribute('src') || '';
      // Снимаем статус ошибки только если загрузилась настоящая картинка, а не 1x1 заглушка сбоя
      if (!src.startsWith('data:')) {
        tile.classList.remove('leaflet-tile-retry', 'leaflet-tile-error');
      }
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

      // Если связь прервалась — переводим в статус повтора
      if (tile._retryCount <= maxRetries && this._map) {
        tile.classList.add('leaflet-tile-retry');
        tile.classList.remove('leaflet-tile-error');

        const delay = tile._retryCount * 1400; // 1.4с, 2.8с, 4.2с
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

      // Все попытки исчерпаны
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
    zoomSnap: 1,      // 1 вместо 0.5 убирает интерполяцию пикселей и размытие растра при зуме
    zoomDelta: 1,
    zoomAnimation: true,
    zoomAnimationThreshold: 4 // При резком скачке зума не анимировать лишние кадры
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
      tile.style.height = (this._getTilePos(coordsBelow).y - this._getTilePos(coords).y) + 'px';
      return tile;
    }
  });

  // Фоновая обзорная подложка
  const fallbackUnderlay = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
    pane: 'wm-underlay',
    subdomains: ['a', 'b', 'c'],
    minZoom: 0,
    maxNativeZoom: 5,        // Скачивает только зумы 0-5
    maxZoom: 20,             // Выше Leaflet плавно растягивает их
    updateWhenIdle: false,
    keepBuffer: 6,
    className: 'wm-fallback-tile',
    attribution: 'OSM'
  }).addTo(map);

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
    { id: 'satClarity', name: 'Спутник высокой четкости (Esri Clarity)', category: 'modern', layer: satClarity, testUrl: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satGoogle', name: 'Спутник + Дороги (Google)', category: 'modern', layer: satGoogle, testUrl: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satBing', name: 'Спутник (Bing)', category: 'modern', layer: satBing, testUrl: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1', subdomains: ['0', '1', '2', '3'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'satYandex', name: 'Спутник (Яндекс)', category: 'modern', layer: satYandex, testUrl: 'https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang=ru_RU', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },

    // --- 2. Топографические и туристические карты ---
    { id: 'cyclOSM', name: 'Тропы и грунтовки (CyclOSM)', category: 'modern', layer: cyclOSM, testUrl: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'openTopo', name: 'Топокарта OpenTopoMap', category: 'modern', layer: openTopo, testUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc', name: 'Топокарты ГГЦ (ГосГисЦентр)', category: 'modern', layer: ggc, testUrl: 'https://tiles.nakarte.me/ggc1000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'ggc2000', name: 'Топокарта ГГЦ 2 км (ГосГисЦентр)', category: 'modern', layer: ggc2000, testUrl: 'https://tiles.nakarte.me/ggc2000/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'arbaletMO', name: 'Топокарта Арбалет (Москва и МО)', category: 'modern', layer: arbaletMO, testUrl: 'https://tiles.nakarte.me/ArbaletMO/{z}/{x}/{-y}', isTms: true, testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'genshtab1980', name: 'Топокарта Генштаб 1-2 км (1980-е)', category: 'modern', layer: genshtab1980, testUrl: 'https://russia3d.ru/maps/tiles/topomaper1-2km1980/webmercator/{z}/{x}/{y}.png', testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'tfOutdoors', name: 'Thunderforest Outdoors', category: 'modern', layer: tfOutdoors, testUrl: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },

    // --- 3. Схемы и городские дорожные карты ---
    { id: 'osmClassic', name: 'Схема OSM (Классика)', category: 'modern', layer: osmClassic, testUrl: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
    { id: 'osmHot', name: 'Гуманитарная карта OSM (HOT)', category: 'modern', layer: osmHot, testUrl: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], testPoint: { lat: 55.75, lng: 37.62, z: 10 } },
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

  function updateQuickSwapUI() {
    if (!btnQuickSwap) return;
    const isEnabled = localStorage.getItem('wm_quick_swap_enabled') !== 'false';
    btnQuickSwap.hidden = !isEnabled;

    if (!isEnabled) return;

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';
    const currentMap = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
    const isCurrentlyTarget = (currentMap === targetMap);

    btnQuickSwap.classList.toggle('active-target', isCurrentlyTarget);
    btnQuickSwap.title = isCurrentlyTarget 
      ? `Вернуться на предыдущую карту` 
      : `Переключить на «${targetMap}»`;
  }

  window.updateQuickSwapUI = updateQuickSwapUI;

  if (btnQuickSwap) {
    btnQuickSwap.onclick = () => {
      const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';
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
  }

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
    keepBuffer: 0,
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
    'Рельеф: Тени (Esri Hillshade)': esriHillshade,
    'Рельеф: Гипсометрия (Esri Shaded Relief)': esriShadedRelief,
    'Рельеф: Художественный SRTM (Maps-For-Free)': mffRelief,
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
    } else if (e.name.includes('Esri Hillshade')) {
      localStorage.setItem('wm_overlay_hillshade', 'true');
    } else if (e.name.includes('Esri Shaded Relief')) {
      localStorage.setItem('wm_overlay_shaded_relief', 'true');
    } else if (e.name.includes('Maps-For-Free')) {
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
    } else if (e.name.includes('Esri Hillshade')) {
      localStorage.setItem('wm_overlay_hillshade', 'false');
    } else if (e.name.includes('Esri Shaded Relief')) {
      localStorage.setItem('wm_overlay_shaded_relief', 'false');
    } else if (e.name.includes('Maps-For-Free')) {
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
  WM.ui.init();
  if (WM.markers) WM.markers.init();
  if (WM.sharedMarkers) WM.sharedMarkers.init(map); // <-- ДОБАВИТЬ ЭТУ СТРОКУ
  if (WM.measure) WM.measure.init();
  if (WM.quickMeasure) WM.quickMeasure.init(map);
  if (WM.shadowHeight) WM.shadowHeight.init(map);
  if (WM.geocaching) {
    WM.geocaching.init(map, geocachingLayer);
    if (isGeocachingEnabled) WM.geocaching.enable();
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
    if (!map._animatingZoom) {
      WM.view.render();
    }
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
  // МОДУЛЬ КОМПАСА И ОРИЕНТАЦИИ УСТРОЙСТВА (DEVICE ORIENTATION API)
  // =========================================================================
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

  let me = null;
  let userLatLng = null;

  // =========================================================================
  // МОДУЛЬ ОТОБРАЖЕНИЯ РАССТОЯНИЯ ОТ ЦЕНТРА ЭКРАНА ДО GPS МЕТКИ
  // =========================================================================
  const gpsDistLayer = L.layerGroup().addTo(map);
  let gpsDistPolyline = null;
  let gpsDistBadgeMarker = null;
  let isGpsDistEnabled = false;

  function fmtGpsDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
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

    const midLatLng = L.latLng(
      (center.lat + targetLL.lat) / 2,
      (center.lng + targetLL.lng) / 2
    );

    if (!gpsDistPolyline) {
      gpsDistPolyline = L.polyline([center, targetLL], {
        pane: 'wm-top-lines',
        color: '#8b5cf6',
        weight: 3,
        dashArray: '6, 6',
        opacity: 0.9,
        interactive: false
      }).addTo(gpsDistLayer);
    } else {
      gpsDistPolyline.setLatLngs([center, targetLL]);
    }

    const badgeHtml = `<div class="wm-gps-dist-badge">🧭 ${fmtGpsDistance(dist)}</div>`;
    if (!gpsDistBadgeMarker) {
      gpsDistBadgeMarker = L.marker(midLatLng, {
        icon: L.divIcon({
          className: 'wm-gps-badge-wrap',
          html: badgeHtml,
          iconSize: [110, 24],
          iconAnchor: [55, 12]
        }),
        interactive: false,
        zIndexOffset: 1400
      }).addTo(gpsDistLayer);
    } else {
      gpsDistBadgeMarker.setLatLng(midLatLng);
      gpsDistBadgeMarker.setIcon(L.divIcon({
        className: 'wm-gps-badge-wrap',
        html: badgeHtml,
        iconSize: [110, 24],
        iconAnchor: [55, 12]
      }));
    }
  }

  map.on('move', () => {
    if (isGpsDistEnabled) updateGpsDistVisuals();
    if (WM.ui && WM.ui.updateRays) WM.ui.updateRays();
  });

  function setGpsCoords(ll) {
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
    if (isGpsDistEnabled) {
      updateGpsDistVisuals();
    }
    if (WM.compass) {
      updateCompassVisuals();
    }
  }

  function acquireLocation(onSuccess, onError) {
    if (!navigator.geolocation) {
      if (onError) onError(new Error('Геолокация не поддерживается устройством'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll = [p.coords.latitude, p.coords.longitude];
        setGpsCoords(ll);
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
})();
