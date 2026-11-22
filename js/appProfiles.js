/**
 * js/appProfiles.js
 * Приветственный экран, глобальные профили сценариев и пресет «Мои последние настройки».
 */
(function () {
  const WM = window.WM = window.WM || {};
  const LS_KEY = 'wm_app_profile_v1';
  const LAST_CUSTOM_KEY = 'wm_app_profile_last_custom_v1';
  const LAST_CUSTOM_ID = 'last_custom';

  const ALL_QM_IDS = [
    'slice3d', 'peakView', 'demRelief', 'viewshed', 'audibility', 'terrainOverlays',
    'placeInsight', 'soil', 'water', 'inatHub', 'inatSuggest',
    'skyCircle', 'sunMoonRays',
    'squad', 'trackRecord', 'gpsDist',
    'customOverlay', 'marker', 'mapCircles', 'measure', 'quickMeasure', 'shadowHeight', 'rangering',
    'offlineArea', 'objects', 'coords', 'cacheCleaner',
    'manualPdr', 'pdrQuick', 'compassAdjust', 'nightVision'
  ];

  function buildQmItems(enabledIds) {
    const set = new Set(enabledIds);
    const out = {};
    ALL_QM_IDS.forEach(id => { out[id] = set.has(id); });
    return out;
  }

  function getDisabledMapsByFilter(keepPredicate) {
    if (!Array.isArray(WM.baseMapsCatalog)) return [];
    return WM.baseMapsCatalog
      .filter(m => !keepPredicate(m))
      .map(m => m.name);
  }

  const EMPTY_LEGACY_OVERLAYS = {
    esriHillshade: false,
    esriShadedRelief: false,
    mffRelief: false,
    geocaching: false,
    inat: false
  };

  // =========================================================================
  // ОПИСАНИЕ 7 ЭТАЛОННЫХ ПРОФИЛЕЙ
  // =========================================================================
  const PROFILES = [
    {
      id: 'standard',
      icon: '🗺️',
      name: 'Стандартный',
      badge: 'По умолчанию',
      desc: 'Базовый сбалансированный набор: схема Яндекс, 3D-отмывка в стандартном стиле и основные инструменты. Слои Wikimapia доступны в меню слоёв.',
      tags: ['Схема (Яндекс)', 'Wikimapia доступна', '3D-отмывка (Стандарт)'],
      baseMap: 'Схема (Яндекс)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => (WM.getDefaultDisabledBaseMaps ? WM.getDefaultDisabledBaseMaps() : []),
      wikimapia: 'enabled_off',
      pickerMode: 'cross',
      workMode: 'hybrid',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS, inat: false },
      demPresetId: 'profile_1795198313316_931', // Стандартный стиль
      demLayersActive: true,
      uiVis: {
        status: true, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: false, marker: false, precache: false,
        location: true, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: true, historical: false,
        osm: true, wikimapia: true, relief: true, canopy: true,
        analysis: true, places: true, custom: true
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'slice3d', 'peakView', 'demRelief', 'viewshed', 'audibility',
          'placeInsight', 'soil', 'water', 'inatHub',
          'skyCircle', 'squad', 'trackRecord', 'gpsDist',
          'customOverlay', 'marker', 'mapCircles', 'offlineArea'
        ])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: true,
        sun: true, moon: true, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'minimal',
      icon: '🪶',
      name: 'Минимальный (настрою сам)',
      badge: 'Чистый лист',
      desc: 'Ничего лишнего на экране: только карта OSM, поиск, масштаб и кнопка настроек. В быстром меню — только координаты.',
      tags: ['Только OSM', 'Минимум кнопок', 'Без перекрестия'],
      baseMap: 'Схема OSM (Классика)',
      quickSwapEnabled: false,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => getDisabledMapsByFilter(m => m.id === 'osmClassic'),
      wikimapia: 'enabled_off',
      pickerMode: 'click',
      workMode: 'manual',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS },
      demPresetId: 'profile_1795198313316_931', // Стандартный стиль (на случай включения позже)
      demLayersActive: false,
      uiVis: {
        status: false, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: false, measure: false, quickmeasure: false, marker: false, precache: false,
        location: false, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: false, theme: false, compasscone: false, compassneedle: false, infomenu: false,
        rangering: false, motiontail: false, motionvector: false, hideuibtn: false
      },
      layersPanelVis: {
        satellite: false, scheme: true, topo: false, rare: false, historical: false,
        osm: false, wikimapia: true, relief: false, canopy: false,
        analysis: false, places: false, custom: false
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems(['coords'])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: false,
        sun: false, moon: false, weather: false, extra: false, rays: false
      }
    },

    {
      id: 'mushroom',
      icon: '🍄',
      name: 'Грибник / прогулки на природе',
      badge: 'Природа и iNat',
      desc: 'Карта троп CyclOSM, включён слой находок iNaturalist, шагомер PDR и запись трека для возврата из леса. Wikimapia отключена.',
      tags: ['CyclOSM', 'iNaturalist вкл.', 'PDR + трекер', 'Без Wikimapia'],
      baseMap: 'Тропы и грунтовки (CyclOSM)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'disabled',
      pickerMode: 'cross',
      workMode: 'manual',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS, inat: true },
      demPresetId: 'profile_1795198313316_931', // Стандартный стиль (на случай ручного включения)
      demLayersActive: false,
      uiVis: {
        status: false, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: false, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: true, historical: false,
        osm: true, wikimapia: false, relief: true, canopy: true,
        analysis: true, places: true, custom: false
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'inatHub', 'inatSuggest', 'placeInsight', 'soil', 'water',
          'demRelief', 'terrainOverlays', 'skyCircle',
          'squad', 'trackRecord', 'gpsDist', 'marker', 'measure', 'quickMeasure',
          'offlineArea', 'coords', 'cacheCleaner', 'manualPdr', 'pdrQuick', 'compassAdjust', 'nightVision'
        ])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: true,
        sun: true, moon: true, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'lore',
      icon: '📜',
      name: 'Краеведение / поиск мест',
      badge: 'Архив и Wikimapia',
      desc: 'Полный каталог карт (включая старинные карты Менде, РККА и ГГЦ), активна Wikimapia, наложения KML и высота по тени.',
      tags: ['Все карты (вкл. старинные)', 'Wikimapia вкл.', 'KML + высота тени'],
      baseMap: 'Схема (Яндекс)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Карта РККА (ЭтоМесто)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => [],
      wikimapia: 'enabled_on',
      pickerMode: 'cross',
      workMode: 'hybrid',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS },
      demPresetId: 'profile_1795379935037_761', // Старинная карта (в резерве)
      demLayersActive: false,
      uiVis: {
        status: true, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: true, historical: true,
        osm: true, wikimapia: true, relief: true, canopy: false,
        analysis: false, places: false, custom: true
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'objects', 'customOverlay', 'shadowHeight', 'placeInsight', 'soil', 'water',
          'demRelief', 'slice3d', 'viewshed', 'skyCircle', 'sunMoonRays',
          'trackRecord', 'gpsDist', 'marker', 'mapCircles', 'measure', 'quickMeasure', 'rangering',
          'offlineArea', 'coords', 'cacheCleaner', 'compassAdjust', 'nightVision'
        ])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: true,
        sun: true, moon: false, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'hiking',
      icon: '🥾',
      name: 'Обычные походы',
      badge: 'Тропы и навигация',
      desc: 'Карта троп CyclOSM, трекер, линейка, офлайн-загрузка, отряд и навигация без GPS. Отмывка рельефа выключена (пресет «Стандартный стиль»).',
      tags: ['CyclOSM', 'Трекер + линейка + PDR', 'Рельеф выкл (Стандарт)'],
      baseMap: 'Тропы и грунтовки (CyclOSM)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'enabled_off',
      pickerMode: 'cross',
      workMode: 'hybrid',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS },
      demPresetId: 'profile_1795198313316_931', // Пресет выставлен на "Стандартный стиль"
      demLayersActive: false,                   // Сами слои отмывки/декора/OSM выключены
      uiVis: {
        status: false, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: true, hideuibtn: false
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: true, historical: false,
        osm: true, wikimapia: true, relief: true, canopy: true,
        analysis: true, places: true, custom: true
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'offlineArea', 'trackRecord', 'squad', 'terrainOverlays', 'demRelief',
          'viewshed', 'audibility', 'slice3d', 'placeInsight', 'water', 'soil', 'inatHub',
          'skyCircle', 'gpsDist', 'customOverlay', 'marker', 'mapCircles', 'measure', 'quickMeasure',
          'rangering', 'coords', 'cacheCleaner', 'manualPdr', 'pdrQuick', 'compassAdjust', 'nightVision'
        ])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: true,
        sun: true, moon: true, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'mountain',
      icon: '⛰️',
      name: 'Горные походы',
      badge: 'CG Отмывка + Танака',
      desc: 'Автоматически включается 3D-отмывка в стиле «CG Отмывка» с объёмными изолиниями Танаки, 3D-пики, обзор и слышимость.',
      tags: ['CG Отмывка вкл.', 'Пики + 3D-срез', 'Видимость + склоны'],
      baseMap: 'Топокарта OpenTopoMap',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'enabled_off',
      pickerMode: 'cross',
      workMode: 'hybrid',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS },
      demPresetId: 'profile_1795201097641_869', // CG Отмывка
      demLayersActive: true,
      uiVis: {
        status: false, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: true, hideuibtn: false
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: true, historical: false,
        osm: true, wikimapia: true, relief: true, canopy: true,
        analysis: true, places: false, custom: false
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'slice3d', 'peakView', 'demRelief', 'viewshed', 'audibility', 'terrainOverlays',
          'skyCircle', 'sunMoonRays', 'squad', 'trackRecord', 'gpsDist',
          'marker', 'mapCircles', 'measure', 'quickMeasure', 'rangering',
          'offlineArea', 'coords', 'cacheCleaner', 'manualPdr', 'pdrQuick', 'compassAdjust',
          'placeInsight', 'water', 'nightVision'
        ])
      },
      infoHud: {
        time: true, userCoords: true, centerCoords: true, gps: true,
        sun: true, moon: true, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'beautiful',
      icon: '🎨',
      name: 'Красивая карта',
      badge: 'Старинная карта + 3D',
      desc: 'Максимальная эстетика: сразу включён 3D-рельеф «Старинная карта» с декором, лесом, 3D-срезом и панорамой пиков. Всё лишнее скрыто.',
      tags: ['Старинная карта', 'Декор + Лес', '3D-срез и пики'],
      baseMap: 'Тропы и грунтовки (CyclOSM)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      quickSwapPos: 'top-right',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category === 'satellite' || m.category === 'topo' || m.id === 'osmClassic' || m.id === 'schemeYandex'
      ),
      wikimapia: 'disabled',
      pickerMode: 'cross',
      workMode: 'manual',
      hybridZoom: 13,
      legacyOverlays: { ...EMPTY_LEGACY_OVERLAYS },
      demPresetId: 'profile_1795379935037_761', // Старинная карта (с декором)
      demLayersActive: true,
      uiVis: {
        status: false, limit: true, pill: false, zoom: true, layers: true, search: true,
        mode: true, measure: false, quickmeasure: false, marker: false, precache: false,
        location: false, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: false, compassneedle: true, infomenu: true,
        rangering: false, motiontail: false, motionvector: false, hideuibtn: true
      },
      layersPanelVis: {
        satellite: true, scheme: true, topo: true, rare: false, historical: false,
        osm: true, wikimapia: false, relief: true, canopy: true,
        analysis: true, places: false, custom: true
      },
      quickMenu: {
        enabled: true,
        locked: true,
        tileSize: 'medium',
        pieSync: true,
        order: 'default',
        triggers: { btn: true, longpress: false, crosshair: false },
        items: buildQmItems([
          'slice3d', 'peakView', 'demRelief', 'viewshed', 'terrainOverlays',
          'skyCircle', 'sunMoonRays', 'customOverlay', 'nightVision', 'coords'
        ])
      },
      infoHud: {
        time: true, userCoords: false, centerCoords: true, gps: false,
        sun: true, moon: true, weather: true, extra: false, rays: false
      }
    }
  ];

  let applyDepth = 0;
  let isInitialized = false;
  let userModDebounceTimer = null;

  function loadLastCustomSnapshot() {
    try {
      const raw = localStorage.getItem(LAST_CUSTOM_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveLastCustomSnapshot(snap) {
    if (!snap) return;
    try {
      localStorage.setItem(LAST_CUSTOM_KEY, JSON.stringify(snap));
    } catch (e) {}
  }

  function captureFullSnapshot() {
    let disabledMaps = [];
    try {
      disabledMaps = JSON.parse(localStorage.getItem('wm_disabled_base_maps') || '[]');
      if (!Array.isArray(disabledMaps)) disabledMaps = [];
    } catch (e) {}

    const active3dId = (WM.demPresets && WM.demPresets.ACTIVE_PRESET_KEY)
      ? (localStorage.getItem(WM.demPresets.ACTIVE_PRESET_KEY) || '')
      : '';

    return {
      version: 1,
      savedAt: Date.now(),
      layersPanelVis: WM.getLayersPanelVis ? WM.getLayersPanelVis() : null,
      baseMap: localStorage.getItem('wm_base_layer') || 'Схема (Яндекс)',
      disabledBaseMaps: disabledMaps,
      groupLayers: localStorage.getItem('wm_group_layers') !== 'false',
      quickSwap: {
        enabled: localStorage.getItem('wm_quick_swap_enabled') !== 'false',
        target: localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)',
        pos: localStorage.getItem('wm_quick_swap_pos') || 'top-right'
      },
      wikimapia: WM.getWikimapiaLayersState ? WM.getWikimapiaLayersState() : null,
      workMode: WM.ui && WM.ui.getWorkMode ? WM.ui.getWorkMode() : 'hybrid',
      pickerMode: WM.picker && WM.picker.getMode ? WM.picker.getMode() : 'cross',
      wikimapiaAdvanced: WM.ui && WM.ui.getWikimapiaAdvancedState ? WM.ui.getWikimapiaAdvancedState() : null,
      legacyOverlays: WM.getLegacyOverlaysState ? WM.getLegacyOverlaysState() : null,
      active3dPresetId: active3dId,
      scene3d: {
        demRelief: WM.demRelief && WM.demRelief.getConfig ? WM.demRelief.getConfig() : null,
        terrainDecor: WM.terrainDecor && WM.terrainDecor.getConfig ? WM.terrainDecor.getConfig() : null,
        clouds: WM.clouds ? { enabled: WM.clouds.isEnabled(), config: WM.clouds.getConfig() } : null,
        canopy: WM.canopy && WM.canopy.getSettings ? { settings: WM.canopy.getSettings() } : null,
        vectorRoads: WM.vectorRoads && WM.vectorRoads.getConfig ? WM.vectorRoads.getConfig() : null,
        terrainOverlays: WM.terrainOverlays && WM.terrainOverlays.getConfig ? WM.terrainOverlays.getConfig() : null,
        viewshed: WM.viewshed
          ? { active: WM.viewshed.isActive(), settings: WM.viewshed.getSettings ? WM.viewshed.getSettings() : {} }
          : null,
        audibility: WM.audibility
          ? { active: WM.audibility.isActive(), config: WM.audibility.getConfig ? WM.audibility.getConfig() : null }
          : null
      },
      uiVis: WM.ui && WM.ui.uiVis ? { ...WM.ui.uiVis } : null,
      infoHud: WM.ui && WM.ui.getInfoHudConfig ? WM.ui.getInfoHudConfig() : null,
      quickMenu: WM.ui && WM.ui.getQuickMenuConfig ? WM.ui.getQuickMenuConfig() : null,
      theme: (WM.api && WM.api.store) ? WM.api.store.get('wm_theme') : localStorage.getItem('wm_theme')
    };
  }

  function disableAll3dSceneLayers() {
    if (WM.demRelief) {
      WM.demRelief.setConfig({ hillshadeEnabled: false, contoursEnabled: false });
      if (WM.demRelief.applyLayerVisibility) WM.demRelief.applyLayerVisibility();
      if (WM.demRelief.flush) WM.demRelief.flush();
    }
    if (WM.terrainDecor && WM.terrainDecor.setConfig) {
      WM.terrainDecor.setConfig({ enabled: false });
    }
    if (WM.clouds && WM.clouds.setEnabled) {
      WM.clouds.setEnabled(false);
    }
    if (WM.canopy) {
      if (WM.canopy.setTreesEnabled) WM.canopy.setTreesEnabled(false);
      if (WM.canopy.setHeightEnabled) WM.canopy.setHeightEnabled(false);
      if (WM.canopy.setMaskEnabled) WM.canopy.setMaskEnabled(false);
    }
    if (WM.vectorRoads && WM.vectorRoads.isEnabled && WM.vectorRoads.isEnabled()) {
      WM.vectorRoads.toggle();
    }
    if (WM.terrainOverlays && WM.terrainOverlays.disableAll) {
      WM.terrainOverlays.disableAll();
    }
    if (WM.viewshed && WM.viewshed.isActive && WM.viewshed.isActive()) {
      WM.viewshed.toggle();
    }
    if (WM.audibility && WM.audibility.isActive && WM.audibility.isActive()) {
      WM.audibility.toggle();
    }
  }

  function restoreFullSnapshot(snap, opts = {}) {
    if (!snap || typeof snap !== 'object') return false;

    applyDepth++;
    clearTimeout(userModDebounceTimer);

    try {
      localStorage.setItem(LS_KEY, LAST_CUSTOM_ID);

      if (typeof WM.setLayersPanelVis === 'function' && snap.layersPanelVis) {
        WM.setLayersPanelVis(snap.layersPanelVis);
      }

      try {
        localStorage.setItem('wm_disabled_base_maps', JSON.stringify(Array.isArray(snap.disabledBaseMaps) ? snap.disabledBaseMaps : []));
        localStorage.setItem('wm_disabled_base_maps_ver', 'v2');
        localStorage.setItem('wm_group_layers', snap.groupLayers !== false ? 'true' : 'false');
        if (snap.quickSwap) {
          localStorage.setItem('wm_quick_swap_enabled', snap.quickSwap.enabled !== false ? 'true' : 'false');
          if (snap.quickSwap.target) localStorage.setItem('wm_quick_swap_target', snap.quickSwap.target);
          if (snap.quickSwap.pos) localStorage.setItem('wm_quick_swap_pos', snap.quickSwap.pos);
        }
      } catch (e) {}

      if (typeof WM.switchToBaseMap === 'function' && snap.baseMap) {
        WM.switchToBaseMap(snap.baseMap);
      } else if (typeof WM.rebuildBaseLayersControl === 'function') {
        WM.rebuildBaseLayersControl();
      }

      if (snap.wikimapia) {
         try {
           localStorage.setItem('wm_overlay_contours', snap.wikimapia.contours !== false ? 'true' : 'false');
           localStorage.setItem('wm_overlay_vectors', snap.wikimapia.vectors !== false ? 'true' : 'false');
         } catch (e) {}
         if (typeof WM.setWikimapiaDisabled === 'function') {
           WM.setWikimapiaDisabled(!!snap.wikimapia.disabled);
         }
         if (!snap.wikimapia.disabled && typeof WM.setWikimapiaLayersEnabled === 'function') {
           WM.setWikimapiaLayersEnabled(snap.wikimapia.contours !== false, snap.wikimapia.vectors !== false);
         }
      }



      if (WM.picker && WM.picker.setMode && snap.pickerMode) {
        WM.picker.setMode(snap.pickerMode);
      }
      if (WM.ui && typeof WM.ui.setWorkMode === 'function' && snap.workMode) {
        WM.ui.setWorkMode(snap.workMode);
      }
      if (WM.ui && typeof WM.ui.applyWikimapiaAdvancedState === 'function' && snap.wikimapiaAdvanced) {
        WM.ui.applyWikimapiaAdvancedState(snap.wikimapiaAdvanced);
      }

      if (typeof WM.applyLegacyOverlaysState === 'function' && snap.legacyOverlays) {
        WM.applyLegacyOverlaysState(snap.legacyOverlays);
      }

      if (WM.demPresets && snap.scene3d) {
        WM.demPresets.applyProfile({
          id: snap.active3dPresetId || '',
          name: 'Мои последние настройки',
          demRelief: snap.scene3d.demRelief || { hillshadeEnabled: false, contoursEnabled: false },
          terrainDecor: snap.scene3d.terrainDecor || { enabled: false },
          clouds: snap.scene3d.clouds || { enabled: false },
          canopy: snap.scene3d.canopy || { enabled: false },
          vectorRoads: snap.scene3d.vectorRoads || { enabled: false },
          terrainOverlays: snap.scene3d.terrainOverlays || { enabled: false },
          viewshed: snap.scene3d.viewshed || { active: false }
        }, { silent: true });

        if (!snap.active3dPresetId) {
          try { localStorage.removeItem(WM.demPresets.ACTIVE_PRESET_KEY); } catch (e) {}
          if (WM.demPresets.syncSelectUI) WM.demPresets.syncSelectUI('');
        } else if (WM.demPresets.syncSelectUI) {
          WM.demPresets.syncSelectUI(snap.active3dPresetId);
        }
      }

      if (WM.audibility) {
        const aud = snap.scene3d && snap.scene3d.audibility;
        if (aud && aud.config && WM.audibility.setConfig) WM.audibility.setConfig(aud.config);
        if (WM.audibility.isActive && WM.audibility.toggle) {
          if (WM.audibility.isActive() !== !!(aud && aud.active)) WM.audibility.toggle();
        }
      }

      if (WM.ui && snap.theme && typeof WM.ui.applyTheme === 'function') {
        WM.ui.applyTheme(snap.theme);
      }
      if (WM.ui && typeof WM.ui.setInfoHudConfig === 'function' && snap.infoHud) {
        WM.ui.setInfoHudConfig(snap.infoHud);
      }
      if (WM.ui && typeof WM.ui.setQuickMenuConfig === 'function' && snap.quickMenu) {
        WM.ui.setQuickMenuConfig(snap.quickMenu);
      }
      if (WM.ui && typeof WM.ui.setUIVisibility === 'function' && snap.uiVis) {
        WM.ui.setUIVisibility(snap.uiVis);
      }

      if (typeof WM.enforceHiddenLayerSpoilers === 'function') WM.enforceHiddenLayerSpoilers();
      if (typeof WM.rebuildBaseLayersControl === 'function') WM.rebuildBaseLayersControl();
      if (typeof window.syncLayersControlExtras === 'function') window.syncLayersControlExtras();
      if (typeof window.updateQuickSwapUI === 'function') window.updateQuickSwapUI();
      if (WM.ui && typeof WM.ui.syncSettingsModalFromState === 'function') WM.ui.syncSettingsModalFromState();
      if (WM.demRelief && WM.demRelief.flush) WM.demRelief.flush();

      renderSettingsSpoiler();

      if (!opts.silent && WM.ui && WM.ui.showToast) {
        WM.ui.showToast('💾 Восстановлены: «Мои последние настройки»', 2600);
      }
      return true;
    } finally {
      clearTimeout(userModDebounceTimer);
      setTimeout(() => { applyDepth = Math.max(0, applyDepth - 1); }, 450);
    }
  }

  // =========================================================================
  // ПРИМЕНЕНИЕ ЭТАЛОННОГО ПРОФИЛЯ
  // =========================================================================
  function applyProfile(profileId, opts = {}) {
    if (profileId === LAST_CUSTOM_ID) {
      const snap = loadLastCustomSnapshot();
      if (!snap) {
        if (!opts.silent && WM.ui && WM.ui.showToast) {
          WM.ui.showToast('ℹ️ Пока нет сохранённых изменений. Настройте любой слой или кнопку.');
        }
        return false;
      }
      return restoreFullSnapshot(snap, opts);
    }

    const p = PROFILES.find(item => item.id === profileId);
    if (!p) return false;

    applyDepth++;
    clearTimeout(userModDebounceTimer);

    try {
      try { localStorage.setItem(LS_KEY, p.id); } catch (e) {}

      // 0. Спойлеры меню слоёв
      if (typeof WM.setLayersPanelVis === 'function' && p.layersPanelVis) {
        WM.setLayersPanelVis(p.layersPanelVis);
      }

      // 1. Базовые карты и быстрая смена
      const disabledMaps = p.getDisabledMaps ? p.getDisabledMaps() : [];
      try {
        localStorage.setItem('wm_disabled_base_maps', JSON.stringify(disabledMaps));
        localStorage.setItem('wm_disabled_base_maps_ver', 'v2');
        localStorage.setItem('wm_group_layers', 'true');
        localStorage.setItem('wm_quick_swap_enabled', p.quickSwapEnabled ? 'true' : 'false');
        if (p.quickSwapTarget) localStorage.setItem('wm_quick_swap_target', p.quickSwapTarget);
        localStorage.setItem('wm_quick_swap_pos', p.quickSwapPos || 'top-right');
      } catch (e) {}

      if (typeof WM.switchToBaseMap === 'function' && p.baseMap) {
        WM.switchToBaseMap(p.baseMap);
      } else if (typeof WM.rebuildBaseLayersControl === 'function') {
        WM.rebuildBaseLayersControl();
      }

      // 2. Wikimapia, режим загрузки, режим выбора и сброс стилей/фильтров к исходным
      if (p.wikimapia === 'disabled') {
      if (typeof WM.setWikimapiaDisabled === 'function') WM.setWikimapiaDisabled(true);
       } else {
         const layersOn = (p.wikimapia === 'enabled_on');
         try {
           localStorage.setItem('wm_overlay_contours', layersOn ? 'true' : 'false');
           localStorage.setItem('wm_overlay_vectors', layersOn ? 'true' : 'false');
         } catch (e) {}
         if (typeof WM.setWikimapiaDisabled === 'function') WM.setWikimapiaDisabled(false);
         if (typeof WM.setWikimapiaLayersEnabled === 'function') {
           WM.setWikimapiaLayersEnabled(layersOn, layersOn);
         }
       }

       if (WM.view && WM.view.getActiveTag && WM.view.getActiveTag()) {
         WM.view.clearTagFilter();
       }
       if (WM.picker && WM.picker.setMode && p.pickerMode) {
         WM.picker.setMode(p.pickerMode);
       }
       if (WM.ui && typeof WM.ui.setWorkMode === 'function' && p.workMode) {
         WM.ui.setWorkMode(p.workMode);
       }
       if (WM.ui && typeof WM.ui.applyWikimapiaAdvancedState === 'function') {
         WM.ui.applyWikimapiaAdvancedState({
           hybridZoom: p.hybridZoom || 13,
           autoDetails: true,
           autoDetailsCrosshair: true,
           vectorStyle: null,
           rasterStyle: null,
           filters: null
         });
       }

      // 3. Прочие слои-подложки (Esri Hillshade/Shaded, SRTM, Geocaching, iNaturalist)
      if (typeof WM.applyLegacyOverlaysState === 'function') {
        WM.applyLegacyOverlaysState(p.legacyOverlays || EMPTY_LEGACY_OVERLAYS);
      } else if (WM.inat) {
        const wantInat = !!(p.legacyOverlays && p.legacyOverlays.inat);
        if (wantInat && WM.inat.enable) WM.inat.enable();
        else if (!wantInat && WM.inat.disable) WM.inat.disable();
      }

      // 4. Слышимость (выключаем при переключении глобального профиля)
      if (WM.audibility && WM.audibility.isActive && WM.audibility.isActive()) {
        WM.audibility.toggle();
      }

      // 5. 3D-пресет (рельеф / лес / вектор OSM / декор / облака)
      if (WM.demPresets) {
         const preset = p.demPresetId
           ? WM.demPresets.getAllPresets().find(pr => pr.id === p.demPresetId)
           : null;

         if (preset) {
           const presetToApply = (p.demLayersActive === false)
             ? {
                 ...preset,
                 demRelief: { ...(preset.demRelief || {}), hillshadeEnabled: false, contoursEnabled: false },
                 terrainDecor: { ...(preset.terrainDecor || {}), enabled: false },
                 clouds: { ...(preset.clouds || {}), enabled: false },
                 canopy: { enabled: false },
                 vectorRoads: { ...(preset.vectorRoads || {}), enabled: false },
                 terrainOverlays: { enabled: false },
                 viewshed: { active: false }
               }
             : preset;

           WM.demPresets.applyProfile(presetToApply, { silent: true });
           if (p.demPresetId) {
             try { localStorage.setItem(WM.demPresets.ACTIVE_PRESET_KEY, p.demPresetId); } catch (e) {}
             if (WM.demPresets.syncSelectUI) WM.demPresets.syncSelectUI(p.demPresetId);
           }
         } else {
           disableAll3dSceneLayers();
           try { localStorage.removeItem(WM.demPresets.ACTIVE_PRESET_KEY); } catch (e) {}
           if (WM.demPresets.syncSelectUI) WM.demPresets.syncSelectUI('');
         }
       }

      // 6. Инфо-панель, быстрое меню и видимость круглых кнопок
      if (WM.ui && typeof WM.ui.setInfoHudConfig === 'function' && p.infoHud) {
        WM.ui.setInfoHudConfig(p.infoHud);
      }
      if (WM.ui && typeof WM.ui.setQuickMenuConfig === 'function' && p.quickMenu) {
        WM.ui.setQuickMenuConfig(p.quickMenu);
      }
      if (WM.ui && typeof WM.ui.setUIVisibility === 'function' && p.uiVis) {
        WM.ui.setUIVisibility(p.uiVis);
      }

      // 7. Финальная синхронизация слоёв и интерфейса
      if (typeof WM.enforceHiddenLayerSpoilers === 'function') WM.enforceHiddenLayerSpoilers();
      if (typeof WM.rebuildBaseLayersControl === 'function') WM.rebuildBaseLayersControl();
      if (typeof window.syncLayersControlExtras === 'function') window.syncLayersControlExtras();
      if (typeof window.updateQuickSwapUI === 'function') window.updateQuickSwapUI();
      if (WM.ui && typeof WM.ui.syncSettingsModalFromState === 'function') WM.ui.syncSettingsModalFromState();
      if (WM.demRelief && WM.demRelief.flush) WM.demRelief.flush();

      renderSettingsSpoiler();

      if (!opts.silent && WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`${p.icon} Применён профиль: «${p.name}»`, 2600);
      }
      return true;
     } finally {
       clearTimeout(userModDebounceTimer);
       setTimeout(() => { applyDepth = Math.max(0, applyDepth - 1); }, 450);
     }
  }

  // =========================================================================
  // ОТСЛЕЖИВАНИЕ РУЧНЫХ ИЗМЕНЕНИЙ В ПРОФИЛЬ «МОИ ПОСЛЕДНИЕ НАСТРОЙКИ»
  // =========================================================================
  function notifyUserModified() {
    if (!isInitialized || applyDepth > 0 || window._wmResetting) return;
    clearTimeout(userModDebounceTimer);
    userModDebounceTimer = setTimeout(() => {
      if (applyDepth > 0 || window._wmResetting) return;
      const snap = captureFullSnapshot();
      saveLastCustomSnapshot(snap);
      try { localStorage.setItem(LS_KEY, LAST_CUSTOM_ID); } catch (e) {}
      renderSettingsSpoiler();
    }, 350);
  }

  function bindUserModificationListeners() {
    if (document._wmProfilesWatched) return;
    document._wmProfilesWatched = true;

    // 1. Плавающий 3D-HUD
    const demHud = document.getElementById('dem-relief-hud');
    if (demHud) {
      demHud.addEventListener('change', () => notifyUserModified());
      demHud.addEventListener('input', (e) => {
        if (e.target && e.target.matches('input[type="range"], input[type="color"], input[type="number"]')) {
          notifyUserModified();
        }
      });
      demHud.addEventListener('click', (e) => {
        const btn = e.target.closest(
          '#dem-hud-toggle-hs, #dem-hud-toggle-ct, #dem-hud-toggle-trees, #dem-hud-toggle-roads, #dem-hud-toggle-cl, ' +
          '#dem-hud-toggle-vs, #btn-viewshed-toggle-quick, #btn-viewshed-toggle-body, #btn-audibility-toggle-quick, ' +
          '#btn-to-steep-quick, #btn-to-camp-quick, #btn-to-wind-quick, #btn-to-solar-quick, #btn-to-flood-quick, ' +
          '.js-hud-spoiler-toggle, .js-hud-tools-toggle, ' +
          '.dem-hud-switch-btn, .dem-tone-chip, .dem-smooth-btn, .dem-season-btn, ' +
          '.dem-manual-elev-chip, .viewshed-origin-btn, .vs-tkind-btn, .vs-preset-chip, ' +
          '.vs-qual-btn, .vs-tq, .wm-aud-mode-btn, .wm-aud-origin-btn, .wm-aud-qual-btn, ' +
          '.to-flood-chip, .to-solar-season-btn, #dem-hud-zfactor-auto-btn, ' +
          '#btn-dem-hud-manual-grab-screen, #btn-dem-hud-clouds-reset, #btn-vector-roads-reset, #btn-to-disable-all'
        );
        if (btn) notifyUserModified();
      }, true);
    }

    // 2. Мгновенные переключатели внутри окна Настроек (#modal)
    const modal = document.getElementById('modal');
    if (modal) {
      modal.addEventListener('change', (e) => {
        const t = e.target;
        if (!t) return;
        if (
          t.closest('#layers-panel-vis-list') ||
          t.closest('#spoiler-inaturalist') ||
          t.name === 'app-theme-mode' ||
          t.id === 'toggle-dem-hillshade' ||
          t.id === 'toggle-dem-contours' ||
          t.id === 'dem-source-select' ||
          t.id === 'dem-blendmode-select' ||
          t.id === 'dem-contour-blend-select' ||
          t.id === 'toggle-group-layers'
        ) {
          notifyUserModified();
        }
      });
      modal.addEventListener('click', (e) => {
        if (e.target.closest('#inat-search-type-segmented button')) {
          notifyUserModified();
        }
      });
    }

    // 3. Изменения слоёв через событие DEM
    window.addEventListener('wm:dem-change', (e) => {
      if (e && e.detail && !e.detail.tilesLoaded && (e.detail.sourceChanged || e.detail.configChanged)) {
        notifyUserModified();
      }
    });
  }

  // =========================================================================
  // СТИЛИ И РЕНДЕРИНГ
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById('wm-app-profiles-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-app-profiles-style';
    st.textContent = `
      #modal-welcome-profiles {
        contain: layout style paint;
      }
      #modal-welcome-profiles .modal-box {
        overflow: hidden;
        transform: translate3d(0, 0, 0);
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        contain: layout style paint;
      }
      .wm-prof-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .wm-prof-card {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        width: 100%;
        text-align: left;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1.5px solid var(--border, rgba(128,128,128,0.28));
        background: var(--bg-secondary, rgba(128,128,128,0.08));
        color: var(--text-main, #f1f5f9);
        cursor: pointer;
        contain: layout style;
        transition: border-color 0.12s ease, background 0.12s ease;
      }
      .wm-prof-card:hover {
        border-color: var(--accent, #3b82f6);
      }
      .wm-prof-card:active {
        transform: scale(0.99);
      }
      .wm-prof-card.selected,
      .wm-prof-card.active {
        border-color: var(--accent, #3b82f6);
        background: var(--accent-bg, rgba(59, 130, 246, 0.14));
      }
      .wm-prof-card.is-last-custom {
        border-style: dashed;
      }
      .wm-prof-card.is-last-custom.active,
      .wm-prof-card.is-last-custom.selected {
        border-style: solid;
      }
      .wm-prof-card.is-empty {
        opacity: 0.65;
      }
      .wm-prof-icon {
        font-size: 24px;
        line-height: 1.1;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .wm-prof-body {
        flex: 1;
        min-width: 0;
      }
      .wm-prof-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 3px;
      }
      .wm-prof-name {
        font-size: 13.5px;
        font-weight: 800;
      }
      .wm-prof-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(128,128,128,0.16);
        color: var(--text-muted, #94a3b8);
      }
      .wm-prof-card.selected .wm-prof-badge,
      .wm-prof-card.active .wm-prof-badge {
        background: var(--accent, #3b82f6);
        color: #fff;
      }
      .wm-prof-desc {
        font-size: 11.5px;
        line-height: 1.4;
        color: var(--text-muted, #94a3b8);
        margin: 0 0 6px 0;
      }
      .wm-prof-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .wm-prof-tag {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(128,128,128,0.22));
        background: var(--bg-primary, rgba(0,0,0,0.15));
        color: var(--text-main, #e2e8f0);
      }
      .wm-prof-active-pill {
        margin-left: auto;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--accent-bg, rgba(59,130,246,0.15));
        color: var(--accent, #3b82f6);
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(st);
  }

  function buildLastCustomCardDescriptor(snap) {
    if (!snap) {
      return {
        id: LAST_CUSTOM_ID,
        icon: '💾',
        name: 'Мои последние настройки',
        badge: 'Пока пусто',
        desc: 'Здесь автоматически сохраняются последние настройки, которые вы меняли вручную (карты, слои, 3D-рельеф и кнопки).',
        tags: ['Автосохранение при правках'],
        isLastCustom: true,
        isEmpty: true
      };
    }

    const tags = [];
    if (snap.baseMap) tags.push(snap.baseMap);
    const demOn = !!(snap.scene3d && snap.scene3d.demRelief && snap.scene3d.demRelief.hillshadeEnabled);
     const ctOn = !!(snap.scene3d && snap.scene3d.demRelief && snap.scene3d.demRelief.contoursEnabled);
     if (demOn) {
      const pName = (snap.active3dPresetId && WM.demPresets)
        ? (WM.demPresets.getAllPresets().find(pr => pr.id === snap.active3dPresetId)?.name || '3D-рельеф вкл.')
        : '3D-рельеф (кастом)';
      tags.push(pName);
    } else if (ctOn) {
      tags.push('〰️ Горизонтали');
    } if (snap.scene3d && snap.scene3d.vectorRoads && snap.scene3d.vectorRoads.enabled) {
      tags.push('🛤️ OSM');
    } else {
      tags.push('Рельеф выкл.');
    }
    if (snap.scene3d && snap.scene3d.canopy && snap.scene3d.canopy.settings && snap.scene3d.canopy.settings.treesEnabled) {
      tags.push('🌲 Лес');
    }
    if (snap.legacyOverlays && snap.legacyOverlays.inat) {
      tags.push('🌿 iNat');
    }
    if (snap.wikimapia && !snap.wikimapia.disabled && snap.wikimapia.vectors) {
      tags.push('Wikimapia');
    }

    let timeBadge = 'Сохранено';
    if (snap.savedAt) {
      const d = new Date(snap.savedAt);
      timeBadge = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    }

    return {
      id: LAST_CUSTOM_ID,
      icon: '💾',
      name: 'Мои последние настройки',
      badge: `Изм. в ${timeBadge}`,
      desc: 'Ваша последняя вручную изменённая конфигурация слоёв, карт, 3D-рельефа и кнопок интерфейса.',
      tags,
      isLastCustom: true,
      isEmpty: false
    };
  }

  // =========================================================================
  // ПРИВЕТСТВЕННОЕ ОКНО (WELCOME MODAL)
  // =========================================================================
  let selectedWelcomeId = 'standard';

  function createWelcomeModal() {
    ensureStyles();
    let modal = document.getElementById('modal-welcome-profiles');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'modal-welcome-profiles';
    modal.className = 'modal-overlay';

    const hasExistingSetup = !window._wmIsFirstLaunch && !!(localStorage.getItem('wm_view') || localStorage.getItem('wm_dem_relief'));

    modal.innerHTML = `
      <div class="modal-box modal-box-large" style="max-width: 520px;">
        <div class="modal-header">
          <div>
            <h3 style="margin: 0; font-size: 16.5px;">🧭 Добро пожаловать!</h3>
            <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
              Выберите сценарий использования приложения
            </div>
          </div>
          <button type="button" class="modal-close-x" id="wm-welcome-x">✕</button>
        </div>

        <p class="modal-desc" style="margin-bottom: 10px;">
          Профиль настроит стартовую карту, доступные слои, быстрое меню и нужные кнопки. Позже его можно сменить в самом верху меню <b>⚙️ Настройки</b>.
        </p>

        <div class="modal-content-scroll" style="max-height: 55vh; padding-right: 4px;">
          <div id="wm-welcome-cards" class="wm-prof-grid"></div>
        </div>

        <div class="modal-actions" style="margin-top: 12px; justify-content: space-between;">
          ${hasExistingSetup
            ? '<button type="button" id="wm-welcome-keep" class="btn btn-secondary">Оставить текущие</button>'
            : '<span></span>'}
          <button type="button" id="wm-welcome-apply" class="btn btn-primary" style="font-weight: 700; padding: 9px 18px;">
            ✓ Начать с выбранным
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const cardsWrap = modal.querySelector('#wm-welcome-cards');
    const renderCards = () => {
      cardsWrap.innerHTML = '';
      const lastSnap = loadLastCustomSnapshot();
      const list = lastSnap ? [buildLastCustomCardDescriptor(lastSnap), ...PROFILES] : PROFILES;

      list.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.profileId = p.id;
        btn.className = 'wm-prof-card'
          + (p.isLastCustom ? ' is-last-custom' : '')
          + (selectedWelcomeId === p.id ? ' selected' : '');
        btn.innerHTML = `
          <span class="wm-prof-icon">${p.icon}</span>
          <div class="wm-prof-body">
            <div class="wm-prof-top">
              <span class="wm-prof-name">${p.name}</span>
              <span class="wm-prof-badge">${p.badge}</span>
            </div>
            <p class="wm-prof-desc">${p.desc}</p>
            <div class="wm-prof-tags">
              ${p.tags.map(t => `<span class="wm-prof-tag">${t}</span>`).join('')}
            </div>
          </div>
        `;
        btn.onclick = () => {
          selectedWelcomeId = p.id;
          cardsWrap.querySelectorAll('.wm-prof-card').forEach(el => {
            el.classList.toggle('selected', el.dataset.profileId === selectedWelcomeId);
          });
        };
        btn.ondblclick = () => {
          selectedWelcomeId = p.id;
          applyProfile(selectedWelcomeId);
          closeWelcomeModal();
        };
        cardsWrap.appendChild(btn);
      });
    };

    modal._renderCards = renderCards;
    renderCards();

    modal.querySelector('#wm-welcome-apply').onclick = () => {
      applyProfile(selectedWelcomeId);
      closeWelcomeModal();
    };

    const dismiss = () => {
      if (hasExistingSetup) {
        saveLastCustomSnapshot(captureFullSnapshot());
        try { localStorage.setItem(LS_KEY, LAST_CUSTOM_ID); } catch (e) {}
        renderSettingsSpoiler();
      } else {
        applyProfile('standard', { silent: true });
      }
      closeWelcomeModal();
    };

    modal.querySelector('#wm-welcome-x').onclick = dismiss;
    const keepBtn = modal.querySelector('#wm-welcome-keep');
    if (keepBtn) keepBtn.onclick = dismiss;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) dismiss();
    });

    return modal;
  }

  function openWelcomeModal() {
    selectedWelcomeId = localStorage.getItem(LS_KEY);
    if (selectedWelcomeId !== LAST_CUSTOM_ID && !PROFILES.some(p => p.id === selectedWelcomeId)) {
      selectedWelcomeId = 'standard';
    }
    const modal = createWelcomeModal();
    if (modal._renderCards) modal._renderCards();
    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('welcomeProfiles');
  }

  function closeWelcomeModal(syncHistory = true) {
    const modal = document.getElementById('modal-welcome-profiles');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('welcomeProfiles');
  }

  // =========================================================================
  // СПОЙЛЕР ВВЕРХУ МЕНЮ НАСТРОЕК
  // =========================================================================
  function renderSettingsSpoiler() {
    ensureStyles();
    const listEl = document.getElementById('app-profiles-settings-list');
    const badgeEl = document.getElementById('app-profile-active-badge');
    if (!listEl) return;

    const activeId = localStorage.getItem(LS_KEY) || '';
    const lastSnap = loadLastCustomSnapshot();
    const lastCustomCard = buildLastCustomCardDescriptor(lastSnap);
    const allCards = [lastCustomCard, ...PROFILES];

    const activeObj = allCards.find(p => p.id === activeId);
    if (badgeEl) {
      badgeEl.textContent = activeObj ? `${activeObj.icon} ${activeObj.name}` : 'Свои настройки';
    }

    listEl.innerHTML = '';
    allCards.forEach(p => {
      const isAct = (p.id === activeId);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wm-prof-card'
        + (p.isLastCustom ? ' is-last-custom' : '')
        + (p.isEmpty ? ' is-empty' : '')
        + (isAct ? ' active' : '');

      card.innerHTML = `
        <span class="wm-prof-icon">${p.icon}</span>
        <div class="wm-prof-body">
          <div class="wm-prof-top">
            <span class="wm-prof-name">${p.name}</span>
            <span class="wm-prof-badge">${isAct ? '✓ Активен' : p.badge}</span>
          </div>
          <p class="wm-prof-desc">${p.desc}</p>
          <div class="wm-prof-tags">
            ${p.tags.map(t => `<span class="wm-prof-tag">${t}</span>`).join('')}
          </div>
        </div>
      `;
      card.onclick = () => {
        if (p.isEmpty) {
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('ℹ️ Пока пусто — измените любую настройку или слой, и она сохранится здесь');
          }
          return;
        }
        applyProfile(p.id);
      };
      listEl.appendChild(card);
    });
  }

  function init() {
    ensureStyles();
    bindUserModificationListeners();

    const savedProfile = localStorage.getItem(LS_KEY);
    const hasExistingSetup = !window._wmIsFirstLaunch && !!(localStorage.getItem('wm_view') || localStorage.getItem('wm_dem_relief'));

    // Миграция для пользователей, у которых уже были настройки до появления "Моих последних настроек"
    if (!loadLastCustomSnapshot() && hasExistingSetup && (!savedProfile || savedProfile === 'custom' || savedProfile === LAST_CUSTOM_ID)) {
      saveLastCustomSnapshot(captureFullSnapshot());
      try { localStorage.setItem(LS_KEY, LAST_CUSTOM_ID); } catch (e) {}
    }

    renderSettingsSpoiler();
    isInitialized = true;

    if (!localStorage.getItem(LS_KEY)) {
      requestAnimationFrame(() => {
        openWelcomeModal();
      });
    } else {
      renderSettingsSpoiler();
    }
  }

  WM.appProfiles = {
    init,
    apply: applyProfile,
    notifyUserModified,
    captureSnapshot: captureFullSnapshot,
    openWelcomeModal,
    closeWelcomeModal,
    renderSettingsSpoiler,
    getProfiles: () => PROFILES.slice(),
    getActiveId: () => localStorage.getItem(LS_KEY) || ''
  };
})();
