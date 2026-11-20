/**
 * js/appProfiles.js
 * Приветственный экран и профили сценариев использования приложения.
 */
(function () {
  const WM = window.WM = window.WM || {};
  const LS_KEY = 'wm_app_profile_v1';

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

  // =========================================================================
  // ОПИСАНИЕ 7 ПРОФИЛЕЙ
  // =========================================================================
  const PROFILES = [
    {
      id: 'standard',
      icon: '🗺️',
      name: 'Стандартный',
      badge: 'По умолчанию',
      desc: 'Базовый сбалансированный набор: схема Яндекс, Wikimapia, 3D-рельеф в стандартном стиле и основные инструменты.',
      tags: ['Схема (Яндекс)', 'Wikimapia вкл.', '3D-отмывка'],
      baseMap: 'Схема (Яндекс)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      getDisabledMaps: () => (WM.getDefaultDisabledBaseMaps ? WM.getDefaultDisabledBaseMaps() : []),
      wikimapia: 'enabled_on',
      inatEnabled: false,
      demPresetId: 'profile_1795198313316_931', // Стандартный стиль
      workMode: 'hybrid',
      uiVis: {
        status: true, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: false, marker: false, precache: false,
        location: true, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
      getDisabledMaps: () => getDisabledMapsByFilter(m => m.id === 'osmClassic'),
      wikimapia: 'enabled_off',
      inatEnabled: false,
      demPresetId: null,
      workMode: 'manual',
      uiVis: {
        status: false, limit: false, pill: true, zoom: true, layers: true, search: true,
        mode: false, measure: false, quickmeasure: false, marker: false, precache: false,
        location: false, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: false, theme: false, compasscone: false, compassneedle: false, infomenu: false,
        rangering: false, motiontail: false, motionvector: false, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'disabled',
      inatEnabled: true,
      demPresetId: null,
      workMode: 'manual',
      uiVis: {
        status: false, limit: false, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: false, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
      getDisabledMaps: () => [],
      wikimapia: 'enabled_on',
      inatEnabled: false,
      demPresetId: null,
      workMode: 'hybrid',
      uiVis: {
        status: true, limit: true, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: false, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
        sun: true, moon: true, weather: true, extra: true, rays: false
      }
    },

    {
      id: 'hiking',
      icon: '🥾',
      name: 'Обычные походы',
      badge: 'Тропы и навигация',
      desc: 'Карта троп CyclOSM, трекер, линейка, офлайн-загрузка, отряд и навигация без GPS. Слои Wikimapia выключены, но доступны в списке слоёв.',
      tags: ['CyclOSM', 'Трекер + линейка + PDR', 'Wikimapia в резерве'],
      baseMap: 'Тропы и грунтовки (CyclOSM)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'enabled_off',
      inatEnabled: false,
      demPresetId: null,
      workMode: 'hybrid',
      uiVis: {
        status: false, limit: false, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: true, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
      badge: 'Рельеф и обзор',
      desc: 'Сразу включена 3D-отмывка («Стандартный стиль»), упор на 3D-пики, срез местности, зоны видимости и слышимости, крутые склоны и лагерь.',
      tags: ['3D-отмывка вкл.', 'Пики + 3D-срез', 'Видимость + склоны'],
      baseMap: 'Топокарта OpenTopoMap',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category !== 'historical' &&
        m.id !== 'rkkaEtomesto' &&
        m.id !== 'vtk3v' &&
        m.id !== 'schemeDark'
      ),
      wikimapia: 'enabled_off',
      inatEnabled: false,
      demPresetId: 'profile_1795198313316_931', // Стандартный стиль
      workMode: 'hybrid',
      uiVis: {
        status: false, limit: false, pill: true, zoom: true, layers: true, search: true,
        mode: true, measure: true, quickmeasure: true, marker: true, precache: true,
        location: true, trackrecord: true, gpsdist: true, motion: true, manualpdr: true,
        rays: true, theme: true, compasscone: true, compassneedle: true, infomenu: true,
        rangering: false, motiontail: true, motionvector: true, hideuibtn: false
      },
      quickMenu: {
        enabled: true,
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
      badge: '3D-визуал + Лес',
      desc: 'Максимальная эстетика: сразу включён 3D-рельеф «Стандартный стиль (+Лес)», 3D-срез и панорама пиков. Всё не связанное с визуалом скрыто.',
      tags: ['3D-отмывка + Лес', '3D-срез и пики', 'Чистый экран'],
      baseMap: 'Тропы и грунтовки (CyclOSM)',
      quickSwapEnabled: true,
      quickSwapTarget: 'Спутник (Esri)',
      getDisabledMaps: () => getDisabledMapsByFilter(m =>
        m.category === 'satellite' || m.category === 'topo' || m.id === 'osmClassic' || m.id === 'schemeYandex'
      ),
      wikimapia: 'disabled',
      inatEnabled: false,
      demPresetId: 'profile_1795197745902_439', // Стандартный стиль (+Лес)
      workMode: 'manual',
      uiVis: {
        status: false, limit: false, pill: false, zoom: true, layers: true, search: true,
        mode: true, measure: false, quickmeasure: false, marker: false, precache: false,
        location: false, trackrecord: false, gpsdist: false, motion: false, manualpdr: false,
        rays: true, theme: true, compasscone: false, compassneedle: true, infomenu: true,
        rangering: false, motiontail: false, motionvector: false, hideuibtn: true
      },
      quickMenu: {
        enabled: true,
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

  // =========================================================================
  // СТИЛИ ОКНА И СПОЙЛЕРА (ИСПОЛЬЗУЮТ ТЕКУЩИЕ CSS-ПЕРЕМЕННЫЕ ПРИЛОЖЕНИЯ)
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById('wm-app-profiles-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-app-profiles-style';
    st.textContent = `
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
        transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
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
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(st);
  }

  // =========================================================================
  // ПРИМЕНЕНИЕ ПРОФИЛЯ
  // =========================================================================
  function applyProfile(profileId, opts = {}) {
    const p = PROFILES.find(item => item.id === profileId);
    if (!p) return false;

    try {
      localStorage.setItem(LS_KEY, p.id);
    } catch (e) {}

    // 1. Базовые карты и быстрая смена
    const disabledMaps = p.getDisabledMaps ? p.getDisabledMaps() : [];
    try {
      localStorage.setItem('wm_disabled_base_maps', JSON.stringify(disabledMaps));
      localStorage.setItem('wm_disabled_base_maps_ver', 'v2');
      localStorage.setItem('wm_quick_swap_enabled', p.quickSwapEnabled ? 'true' : 'false');
      if (p.quickSwapTarget) {
        localStorage.setItem('wm_quick_swap_target', p.quickSwapTarget);
      }
    } catch (e) {}

    if (typeof WM.switchToBaseMap === 'function' && p.baseMap) {
      WM.switchToBaseMap(p.baseMap);
    } else if (typeof WM.rebuildBaseLayersControl === 'function') {
      WM.rebuildBaseLayersControl();
    }

    // 2. Wikimapia
    if (p.wikimapia === 'disabled') {
      if (typeof WM.setWikimapiaDisabled === 'function') WM.setWikimapiaDisabled(true);
    } else {
      if (typeof WM.setWikimapiaDisabled === 'function') WM.setWikimapiaDisabled(false);
      const layersOn = (p.wikimapia === 'enabled_on');
      if (typeof WM.setWikimapiaLayersEnabled === 'function') {
        WM.setWikimapiaLayersEnabled(layersOn, layersOn);
      }
    }

    // 3. iNaturalist
    if (WM.inat) {
      if (p.inatEnabled && typeof WM.inat.enable === 'function') {
        WM.inat.enable();
      } else if (!p.inatEnabled && typeof WM.inat.disable === 'function') {
        WM.inat.disable();
      }
    }

    // 4. 3D-пресет (отмывка / лес / вектор OSM / декор)
    if (WM.demPresets) {
      if (p.demPresetId) {
        const preset = WM.demPresets.getAllPresets().find(pr => pr.id === p.demPresetId);
        if (preset) {
          WM.demPresets.applyProfile(preset, { silent: true });
        }
      } else {
        WM.demPresets.applyProfile({
          id: '',
          name: 'Без 3D-пресета',
          demRelief: { hillshadeEnabled: false, contoursEnabled: false },
          terrainDecor: { enabled: false },
          clouds: { enabled: false },
          canopy: { enabled: false },
          vectorRoads: { enabled: false },
          terrainOverlays: { enabled: false },
          viewshed: { active: false }
        }, { silent: true });
        try { localStorage.removeItem(WM.demPresets.ACTIVE_PRESET_KEY); } catch (e) {}
        if (WM.demPresets.syncSelectUI) WM.demPresets.syncSelectUI('');
      }
    }

    // 5. Режим работы загрузки Wikimapia
    if (WM.ui && typeof WM.ui.setWorkMode === 'function' && p.workMode) {
      WM.ui.setWorkMode(p.workMode);
    }

    // 6. Инфо-панель
    if (WM.ui && typeof WM.ui.setInfoHudConfig === 'function' && p.infoHud) {
      WM.ui.setInfoHudConfig(p.infoHud);
    }

    // 7. Быстрое меню
    if (WM.ui && typeof WM.ui.setQuickMenuConfig === 'function' && p.quickMenu) {
      WM.ui.setQuickMenuConfig(p.quickMenu);
    }

    // 8. Видимость круглых кнопок и системных панелей
    if (WM.ui && typeof WM.ui.setUIVisibility === 'function' && p.uiVis) {
      WM.ui.setUIVisibility(p.uiVis);
    }

    // 9. Пересборка панели слоёв и синхронизация настроек
    if (typeof WM.rebuildBaseLayersControl === 'function') {
      WM.rebuildBaseLayersControl();
    }
    if (typeof window.updateQuickSwapUI === 'function') {
      window.updateQuickSwapUI();
    }
    if (WM.ui && typeof WM.ui.syncSettingsModalFromState === 'function') {
      WM.ui.syncSettingsModalFromState();
    }

    renderSettingsSpoiler();

    if (!opts.silent && WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`${p.icon} Применён профиль: «${p.name}»`, 2600);
    }
    return true;
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

    const hasExistingSetup = !!(localStorage.getItem('wm_view') || localStorage.getItem('wm_dem_relief'));

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
      PROFILES.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wm-prof-card' + (selectedWelcomeId === p.id ? ' selected' : '');
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
          renderCards();
        };
        btn.ondblclick = () => {
          selectedWelcomeId = p.id;
          applyProfile(selectedWelcomeId);
          closeWelcomeModal();
        };
        cardsWrap.appendChild(btn);
      });
    };

    renderCards();

    modal.querySelector('#wm-welcome-apply').onclick = () => {
      applyProfile(selectedWelcomeId);
      closeWelcomeModal();
    };

    const dismiss = () => {
      if (hasExistingSetup) {
        try { localStorage.setItem(LS_KEY, 'custom'); } catch (e) {}
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
    if (!PROFILES.some(p => p.id === selectedWelcomeId)) {
      selectedWelcomeId = 'standard';
    }
    const modal = createWelcomeModal();
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
    const activeObj = PROFILES.find(p => p.id === activeId);

    if (badgeEl) {
      badgeEl.textContent = activeObj ? `${activeObj.icon} ${activeObj.name}` : 'Свои настройки';
    }

    listEl.innerHTML = '';
    PROFILES.forEach(p => {
      const isAct = (p.id === activeId);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wm-prof-card' + (isAct ? ' active' : '');
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
        applyProfile(p.id);
      };
      listEl.appendChild(card);
    });
  }

  function init() {
    ensureStyles();
    renderSettingsSpoiler();

    // Показываем приветственное окно при первом запуске
    if (!localStorage.getItem(LS_KEY)) {
      setTimeout(() => {
        openWelcomeModal();
      }, 250);
    }
  }

  WM.appProfiles = {
    init,
    apply: applyProfile,
    openWelcomeModal,
    closeWelcomeModal,
    renderSettingsSpoiler,
    getProfiles: () => PROFILES.slice(),
    getActiveId: () => localStorage.getItem(LS_KEY) || ''
  };
})();