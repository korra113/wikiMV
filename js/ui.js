(function () {
  const WM = window.WM = window.WM || {};
  WM.ui = WM.ui || {};
  const C = WM.config, $ = id => document.getElementById(id);
  let cur = null, tab = 'info', lb = { list: [], i: 0 };
  let editingKeys = [], editingActiveIndex = 0;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  // --- ДОБАВЛЕНО: Форматирование дистанции треков ---
  function fmtDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  let snapshotVector = null, snapshotRaster = null;

  // Централизованный диспетчер обработки кнопки "Назад" со строгой очередью приоритетов
  function handleGlobalBackAction() {

    // 0. Если активен выбор ориентира калибровки на карте — отменяем выбор и возвращаем модалку
    const triPickerHud = $('triangle-picker-hud');
    if (triPickerHud && !triPickerHud.hidden) {
      if (window.cancelTrianglePointPicker) {
        window.cancelTrianglePointPicker();
        return true;
      }
    }
    // 0. Если скрыт UI — первое нажатие "Назад" возвращает интерфейс
    if (document.body.classList.contains('wm-ui-hidden')) {
      toggleHideUI(false);
      return true;
    }

    const trackCfgHud = $('track-config-hud');
    if (trackCfgHud && !trackCfgHud.hidden) {
      trackCfgHud.hidden = true;
      return true;
    }
    const modalTrackDetails = $('modal-track-details');
    if (modalTrackDetails && modalTrackDetails.classList.contains('open')) {
      if (WM.tracker && WM.tracker.closeDetailsModal) {
        WM.tracker.closeDetailsModal();
      } else {
        modalTrackDetails.classList.remove('open');
      }
      return true;
    }

    const modalTrackShare = $('modal-track-share');
     if (modalTrackShare && modalTrackShare.classList.contains('open')) {
       if (WM.tracker && WM.tracker.closeShareModal) WM.tracker.closeShareModal();
       else modalTrackShare.classList.remove('open');
       return true;
     }

     const modalTrackDlPass = $('modal-track-download-pass');
     if (modalTrackDlPass && modalTrackDlPass.classList.contains('open')) {
       modalTrackDlPass.classList.remove('open');
       return true;
     }


    const pieOverlay = $('quick-pie-overlay');
    if (pieOverlay && !pieOverlay.hidden) {
      closeQuickPie();
      return true;
    }
    // 1. Просмотр фото на весь экран (лайтбокс): закрываем фото и остаёмся в карточке
    const lbEl = $('lightbox');
    if (lbEl && !lbEl.hidden) {
      closeLightbox(false);
      return true;
    }

    const modalQmAdd = $('modal-quick-menu-add');
    if (modalQmAdd && modalQmAdd.classList.contains('open')) {
      modalQmAdd.classList.remove('open');
      return true;
    }

    const modalInatQuick = $('modal-inat-quick');
    if (modalInatQuick && modalInatQuick.classList.contains('open')) {
      if (WM.inat && WM.inat.closeQuickHubModal) WM.inat.closeQuickHubModal();
      else modalInatQuick.classList.remove('open');
      return true;
    }
    const modalPlaceInsight = $('modal-place-insight');
    if (modalPlaceInsight && modalPlaceInsight.classList.contains('open')) {
      if (WM.placeInsight && WM.placeInsight.close) WM.placeInsight.close(false);
      else modalPlaceInsight.classList.remove('open');
      return true;
    }

    const modalSoil = $('modal-soil-diagnosis');
    if (modalSoil && modalSoil.classList.contains('open')) {
      if (WM.soil && WM.soil.closeDiagnosisModal) WM.soil.closeDiagnosisModal(false);
      else modalSoil.classList.remove('open');
      return true;
    }

    const modalWater = $('modal-water-diagnosis');
    if (modalWater && modalWater.classList.contains('open')) {
      if (WM.water && WM.water.closeDiagnosisModal) WM.water.closeDiagnosisModal(false);
      else modalWater.classList.remove('open');
      return true;
    }



    const modalInatSuggest = $('modal-inat-suggest');
    if (modalInatSuggest && modalInatSuggest.classList.contains('open')) {
      if (WM.inat && WM.inat.closeSmartSuggestionsModal) WM.inat.closeSmartSuggestionsModal(false);
      else modalInatSuggest.classList.remove('open');
      return true;
    }

    const modalInatList = $('modal-inat-list');
    if (modalInatList && modalInatList.classList.contains('open')) {
      if (WM.inat && WM.inat.closeListModal) WM.inat.closeListModal(false);
      else modalInatList.classList.remove('open');
      return true;
    }

    const modalInatCluster = $('modal-inat-cluster');
    if (modalInatCluster && modalInatCluster.classList.contains('open')) {
      if (WM.inat && WM.inat.closeClusterModal) WM.inat.closeClusterModal(false);
      else modalInatCluster.classList.remove('open');
      return true;
    }

    const modalInat = $('modal-inat-details');
    if (modalInat && modalInat.classList.contains('open')) {
      if (WM.inat && WM.inat.closeModal) WM.inat.closeModal(false);
      else modalInat.classList.remove('open');
      return true;
    }



    const vcHud = $('visual-compass-hud');
    if (vcHud && !vcHud.hidden) {
      if (window.cancelVisualCompassAdjust) {
        window.cancelVisualCompassAdjust();
        return true;
      }
    }



    const modalCompassAdj = $('modal-compass-adjust');
    if (modalCompassAdj && modalCompassAdj.classList.contains('open')) {
      modalCompassAdj.classList.remove('open');
      return true;
    }

    const modalTri = $('modal-triangle-calib');
    if (modalTri && modalTri.classList.contains('open')) {
      if (WM.pdr && WM.pdr.isTriangleCalibrating()) {
        WM.pdr.cancelTriangleCalibration();
      }
      modalTri.classList.remove('open');
      return true;
    }

    const modalImu = $('modal-imu-logger');
    if (modalImu && modalImu.classList.contains('open')) {
      if (WM.imuLogger && WM.imuLogger.isRecording()) {
        WM.imuLogger.stop();
      }
      modalImu.classList.remove('open');
      return true;
    }

    const modalQuickSwap = $('modal-quick-swap-select');
    if (modalQuickSwap && modalQuickSwap.classList.contains('open')) {
      modalQuickSwap.classList.remove('open');
      return true;
    }

    const modalPdrQuick = $('modal-pdr-quick');
    if (modalPdrQuick && modalPdrQuick.classList.contains('open')) {
      if (window.closePdrQuickModal) window.closePdrQuickModal();
      else modalPdrQuick.classList.remove('open');
      return true;
    }

    const modalCoords = $('modal-open-coords');
    if (modalCoords && modalCoords.classList.contains('open')) {
      modalCoords.classList.remove('open');
      return true;
    }

    // 2. Список объектов в зоне
    const modalObjs = $('modal-objects-list');
    if (modalObjs && modalObjs.classList.contains('open')) {
      closeObjectsListModal();
      return true;
    }

    // Модальные окна наложений проверяются ПЕРЕД закрытием режима редактирования
    const modalAddOv = $('modal-add-overlay');
    if (modalAddOv && modalAddOv.classList.contains('open')) {
      modalAddOv.classList.remove('open');
      return true;
    }
    const modalListOv = $('modal-overlays-list');
    if (modalListOv && modalListOv.classList.contains('open')) {
      modalListOv.classList.remove('open');
      return true;
    }

    // Если открыт режим правки наложения (рамка, ручки сдвига) — закрываем его
    if (WM.imageOverlay && WM.imageOverlay.isEditing()) {
      WM.imageOverlay.closeEditing();
      return true;
    }

    // 3. Быстрое меню
    const qmOverlay = $('quick-menu-overlay');
    if (qmOverlay && !qmOverlay.hidden) {
      closeQuickMenu(false);
      return true;
    }

    // 4. Окно поиска
    const modalSearch = $('modal-search');
    if (modalSearch && modalSearch.classList.contains('open')) {
      modalSearch.classList.remove('open');
      return true;
    }

    // 5. Окно настроек приложения
    const modalSettings = $('modal');
    if (modalSettings && modalSettings.classList.contains('open')) {
      if (snapshotVector && WM.view) WM.view.applyVectorStyle(snapshotVector);
      if (snapshotRaster) applyRasterCSS(snapshotRaster);
      snapshotVector = null;
      snapshotRaster = null;
      modalSettings.classList.remove('open');
      return true;
    }

    // 6. Окно предзагрузки / скачивания области
    const modalPrecache = $('modal-precache');
    if (modalPrecache && modalPrecache.classList.contains('open')) {
      if (WM.loader && WM.loader.isPrecaching) WM.loader.stopPrecache();
      modalPrecache.classList.remove('open');
      return true;
    }

    // 7. Окно добавления / редактирования метки
    const modalMarker = $('modal-marker');
    if (modalMarker && modalMarker.classList.contains('open')) {
      modalMarker.classList.remove('open');
      return true;
    }

    const modalMeasureCloud = $('modal-measure-cloud');
    if (modalMeasureCloud && modalMeasureCloud.classList.contains('open')) {
      modalMeasureCloud.classList.remove('open');
      return true;
    }

    // 8. Дополнительные вспомогательные окна
    const pasteModal = $('modal-paste-keys');
    if (pasteModal && pasteModal.classList.contains('open')) {
      pasteModal.classList.remove('open');
      return true;
    }
    const guideModal = $('modal-keys-guide');
    if (guideModal && guideModal.classList.contains('open')) {
      guideModal.classList.remove('open');
      return true;
    }

    const modalClearTiles = $('modal-clear-tiles');
    if (modalClearTiles && modalClearTiles.classList.contains('open')) {
      modalClearTiles.classList.remove('open');
      return true;
    }

    // 9. Меню и активные режимы измерений (Линейка, 2 точки, высота по тени)
    if (WM.measure && WM.measure.isNavigating && WM.measure.isNavigating()) {
      WM.measure.stopNavigation();
      return true;
    }
    if (WM.quickMeasure && WM.quickMeasure.isActive()) {
      WM.quickMeasure.closeTool();
      return true;
    }
    if (WM.shadowHeight && WM.shadowHeight.isActive()) {
      WM.shadowHeight.closeTool();
      return true;
    }
    if (WM.measure && WM.measure.isToolOpen()) {
      WM.measure.closeTool();
      return true;
    }

    // 10. Поиск / подсветка по выбранному тегу
    if (WM.view && WM.view.getActiveTag && WM.view.getActiveTag()) {
      WM.view.clearTagFilter();
      showToast('🏷️ Подсветка тега сброшена');
      return true;
    }

    // 11. Карточка объекта (шторка снизу / сайдбар)
    const sheet = $('sheet');
    if (sheet && sheet.classList.contains('open')) {
      closeSheet(false);
      return true;
    }

    // 11.5. Отключение режима слежения по кнопке "Назад"
    if (WM.followMode && WM.followMode.isActive && WM.followMode.isActive()) {
      WM.followMode.stop();
      return true;
    }

    // 12. Ничего не открыто — возвращаем false
    return false;
  }

  // Делаем функцию доступной глобально для вызова из MainActivity.java (Capacitor)
  window.handleGlobalBackAction = handleGlobalBackAction;


  // Пуш состояния в историю браузера при открытии окон
  function pushHistoryState(stateName) {
    if (window.Capacitor) return;
    // Если текущее состояние уже соответствует этому окну — не пушим дубликат
    if (history.state && history.state.wmView === stateName) return;
    history.pushState({ wmView: stateName }, '');
  }

  let isProgrammaticHistoryBack = false;

  function clearHistoryState(stateName) {
    if (window.Capacitor) return;
    if (history.state && history.state.wmView === stateName) {
      isProgrammaticHistoryBack = true;
      history.back();
    }
  }

  // Слушатель кнопки "Назад" для браузера
  window.addEventListener('popstate', () => {
    if (isProgrammaticHistoryBack) {
      isProgrammaticHistoryBack = false;
      return;
    }
    handleGlobalBackAction();
  });

  // Экспортируем в объект WM.ui
  WM.ui.pushHistoryState = pushHistoryState;
  WM.ui.clearHistoryState = clearHistoryState;

  // Подключение слушателя плагина Capacitor @capacitor/app
  function initCapacitorBackButton() {
    const Cap = window.Capacitor;
    if (Cap && Cap.Plugins && Cap.Plugins.App) {
      Cap.Plugins.App.addListener('backButton', () => {
        const handled = handleGlobalBackAction();
        if (!handled) {
          Cap.Plugins.App.exitApp();
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', initCapacitorBackButton);

  const LANG_FLAGS = {
    ru: '🇷🇺', en: '🇬🇧', uk: '🇺🇦', be: '🇧🇾', de: '🇩🇪', fr: '🇫🇷',
    es: '🇪🇸', it: '🇮🇹', pl: '🇵🇱', tr: '🇹🇷', zh: '🇨🇳', cn: '🇨🇳',
    ja: '🇯🇵', ar: '🇸🇦', he: '🇮🇱', pt: '🇵🇹', el: '🇬🇷', cs: '🇨🇿',
    ro: '🇷🇴', hu: '🇭🇺', bg: '🇧🇬', ka: '🇬🇪', hy: '🇦🇲', az: '🇦🇿',
    kk: '🇰🇿', uz: '🇺🇿', fi: '🇫🇮', sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰',
    nl: '🇳🇱', hr: '🇭🇷', sr: '🇷🇸', sk: '🇸🇰', sl: '🇸🇮', lt: '🇱🇹',
    lv: '🇱🇻', et: '🇪🇪', th: '🇹🇭', vi: '🇻🇳', ko: '🇰🇷', ca: '🇪🇸',
    mk: '🇲🇰', fa: '🇮🇷'
  };

  // =========================================================================
  // БЫСТРОЕ МЕНЮ
  // =========================================================================
  // =========================================================================
  // БЫСТРОЕ МЕНЮ (СЕТКА ПЛИТОК, DRAG & DROP, УДАЛЕНИЕ, ЗАМОК И РАЗМЕР)
  // =========================================================================
  const DEFAULT_QUICK_MENU_ORDER = [
    'placeInsight', 'soil', 'water', 'inatHub', 'objects', 'customOverlay', 'quickMeasure', 'measure', 'shadowHeight',
    'marker', 'sunMoonRays', 'manualPdr', 'gpsDist', 'rangering', 'inatSuggest', 'coords',
    'compassAdjust', 'pdrQuick', 'nightVision', 'trackRecord'
  ];

  const DEFAULT_QUICK_MENU = {
    enabled: true,
    locked: true,
    tileSize: 'medium',
    triggers: {
      longpress: false,
      crosshair: false,
      btn: true
    },
    items: {
      placeInsight: true,
      soil: true,
      water: true,
      inatHub: true,
      objects: true,
      customOverlay: true,
      quickMeasure: true,
      measure: true,
      shadowHeight: true,
      marker: true,
      sunMoonRays: true,
      manualPdr: false,
      gpsDist: true,
      rangering: false,
      inatSuggest: true,
      coords: true,
      compassAdjust: false,
      pdrQuick: false,
      nightVision: false,
      trackRecord: true // <-- Добавлено
    },
    order: [...DEFAULT_QUICK_MENU_ORDER]
  };

  let quickMenuConfig = { ...DEFAULT_QUICK_MENU };
  try {
    const savedQM = JSON.parse(WM.api.store.get('wm_quick_menu') || '{}');
    quickMenuConfig = {
      enabled: savedQM.enabled !== undefined ? !!savedQM.enabled : DEFAULT_QUICK_MENU.enabled,
      locked: savedQM.locked !== undefined ? !!savedQM.locked : DEFAULT_QUICK_MENU.locked,
      tileSize: savedQM.tileSize || DEFAULT_QUICK_MENU.tileSize,
      triggers: { ...DEFAULT_QUICK_MENU.triggers, ...(savedQM.triggers || {}) },
      items: { ...DEFAULT_QUICK_MENU.items, ...(savedQM.items || {}) },
      order: Array.isArray(savedQM.order) && savedQM.order.length ? savedQM.order : [...DEFAULT_QUICK_MENU_ORDER]
    };
  } catch (e) {}

  let quickMenuJustOpenedTime = 0;
  let isQmSettingsOpen = false;

  function saveQuickMenuConfig() {
    WM.api.store.set('wm_quick_menu', JSON.stringify(quickMenuConfig));
  }

  function updateQuickMenuTriggersUI() {
    const btn = $('btn-quick-menu');
    if (btn) {
      btn.hidden = !(quickMenuConfig.enabled && quickMenuConfig.triggers.btn);
    }
    const crosshair = $('crosshair');
    if (crosshair) {
      const isClickable = quickMenuConfig.enabled && quickMenuConfig.triggers.crosshair;
      crosshair.classList.toggle('clickable', isClickable);
      if (isClickable) crosshair.setAttribute('title', '⚡ Быстрое меню');
      else crosshair.removeAttribute('title');
    }
    if (window.updateQuickSwapUI) window.updateQuickSwapUI();
  }

  // Реестр всех доступных действий
  function getQuickMenuCatalog() {
    const center = WM.map ? WM.map.getCenter() : { lat: 0, lng: 0 };
    const coordStr = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;

    return [
      {
        id: 'objects',
        icon: '📋',
        title: 'Объекты',
        sub: 'Список видимых объектов',
        detail: 'Просмотр всех загруженных объектов на видимом участке карты с поиском, фильтрами и сохранением в память.',
        action: () => { closeQuickMenu(false); openObjectsListModal(false); }
      },
      {
        id: 'customOverlay',
        icon: '🗺️',
        title: 'Своя карта',
        sub: (WM.imageOverlay && WM.imageOverlay.isEditing()) ? 'Настроить слой' : 'Наложения и KML',
        detail: 'Загрузка и привязка собственных старинных карт, планов и схем (JPG, PNG, WebP) с поддержкой KML.',
        action: () => {
          closeQuickMenu(false);
          if (WM.imageOverlay) {
            if (WM.imageOverlay.count() === 0) WM.imageOverlay.openAddDialog();
            else WM.imageOverlay.openManager();
          }
        }
      },

      {
        id: 'quickMeasure',
        icon: '📐',
        title: 'Быстрое изм.',
        sub: 'Дистанция по 2 точкам',
        detail: 'Быстрое измерение прямого расстояния между двумя точками с возможностью их перетаскивания по карте.',
        action: () => { 
          closeQuickMenu(false); 
          if (WM.quickMeasure?.openTool) WM.quickMeasure.openTool(); 
          else $('btn-quick-measure')?.click();
        }
      },
      {
        id: 'measure',
        icon: '📏',
        title: 'Линейка',
        sub: 'Маршрут и узлы пути',
        detail: 'Построение детальных ломаных маршрутов, измерение длины пути, добавление промежуточных узлов и навигация.',
        action: () => { 
          closeQuickMenu(false); 
          if (WM.measure?.openTool) WM.measure.openTool(); 
          else $('btn-measure')?.click();
        }
      },
      {
        id: 'shadowHeight',
        icon: '🏢',
        title: 'Высота тени',
        sub: 'Расчёт высоты по Солнцу',
        detail: 'Вычисление высоты здания или вышки по длине его тени на спутниковом снимке и расчётному углу Солнца.',
        action: () => { closeQuickMenu(false); if (WM.shadowHeight?.openTool) WM.shadowHeight.openTool(); }
      },
      {
        id: 'marker',
        icon: '📍',
        title: 'Метка',
        sub: 'Создать заметку в центре',
        detail: 'Установка персональной или публичной метки с эмодзи-иконкой и текстом заметки в центре экрана.',
        action: () => {
          closeQuickMenu(false);
          if (WM.markers?.openModal) WM.markers.openModal(null);
          else if ($('btn-add-marker')) $('btn-add-marker').click();
        }
      },
      {
        id: 'compassAdjust',
        icon: '🧭',
        title: 'Юстировка',
        sub: 'Калибровка компаса',
        detail: 'Калибровка компаса телефона по направлению на Север, положению диска Солнца, Луне или ориентирам карты.',
        action: () => {
          closeQuickMenu(false);
          if (window.openCompassAdjustModal) window.openCompassAdjustModal();
        }
      },
      {
        id: 'trackRecord',
        icon: '⏺️',
        title: 'Запись трека',
        sub: (WM.tracker && WM.tracker.isRecording()) ? 'Идёт запись (нажмите для управления)' : 'Запустить запись GPS трека',
        detail: 'Непрерывная запись пути с защитой от спуфинга, барометром, аварийным сохранением при разряде и экспортом в GPX.',
        action: () => {
          closeQuickMenu();
          $('btn-track-record')?.click();
        }
      },
      {
        id: 'pdrQuick',
        icon: '👣',
        title: 'Шагомер PDR',
        sub: 'Параметры и калибровка',
        detail: 'Параметры автономной навигации без GPS: длина шага, чувствительность, положение смартфона (рука/карман).',
        action: () => {
          closeQuickMenu(false);
          if (window.openPdrQuickModal) window.openPdrQuickModal();
        }
      },
      {
        id: 'inatHub',
        icon: '🌿',
        title: 'Флора и фауна',
        sub: 'iNat: фото, поиск и фильтры',
        detail: 'База наблюдений iNaturalist: точки находок растений, птиц и грибов с фотографиями и экспертными определениями.',
        action: () => {
          closeQuickMenu(false);
          if (WM.inat && WM.inat.openQuickHubModal) WM.inat.openQuickHubModal();
        }
      },
      {
        id: 'placeInsight',
        icon: '🏕️',
        title: 'О месте',
        sub: 'Природа, биотоп, проходимость и находки',
        detail: 'Комплексная экспресс-разведка: проходимость, заболоченность, биотоп, активность грибов и вероятная флора/фауна.',
        action: () => {
          closeQuickMenu(false);
          if (WM.placeInsight && WM.placeInsight.open) WM.placeInsight.open();
        }
      },
      {
        id: 'inatSuggest',
        icon: '🔮',
        title: 'Радар видов',
        sub: 'Вероятные виды вокруг (iNat)',
        detail: 'Умный радар биоразнообразия: прогноз вероятных видов растений, птиц и грибов в окрестностях прямо сейчас.',
        action: () => { closeQuickMenu(false); if (WM.inat?.openSmartSuggestionsModal) WM.inat.openSmartSuggestionsModal(); }
      },     
      {
        id: 'soil',
        icon: '🧪',
        title: 'Почва и биотоп',
        sub: 'Кислотность pH, состав и грибы/растения',
        detail: 'Анализ почвы SoilGrids: уровень кислотности pH, соотношение песка, ила и глины, влажность и биотоп.',
        action: () => {
          closeQuickMenu(false);
          if (WM.soil && WM.soil.openDiagnosis) WM.soil.openDiagnosis();
        }
      }, 
      {
        id: 'water',
        icon: '🌊',
        title: 'Паводки и вода',
        sub: 'Разлив рек, верховодка и болота',
        detail: 'Гидрологическая диагностика GloFAS: мониторинг паводков, уровня воды в реках, верховодки и заболоченности.',
        action: () => {
          closeQuickMenu(false);
          if (WM.water && WM.water.openDiagnosis) WM.water.openDiagnosis();
        }
      },
      {
        id: 'nightVision',
        icon: '🔴',
        title: 'Ночной режим',
        sub: document.documentElement.getAttribute('data-theme') === 'night-vision' ? 'Включён (нажмите для выкл)' : 'Красный монохром',
        detail: 'Глубокий красный монохромный режим для сохранения ночной адаптации глаз при работе в темноте.',
        action: () => {
          closeQuickMenu();
          toggleNightVision();
        }
      },
      {
        id: 'sunMoonRays',
        icon: '✨',
        title: 'Азимуты',
        sub: infoHudConfig.rays ? 'Лучи включены (скрыть)' : 'Линии Солнца и Луны',
        detail: 'Отображение на карте направляющих лучей на текущее положение Солнца (жёлтый) и Луны (голубой).',
        action: () => {
          closeQuickMenu();
          infoHudConfig.rays = !infoHudConfig.rays;
          WM.api.store.set('wm_info_hud_items', JSON.stringify(infoHudConfig));
          updateInfoHudUI();
          updateRaysBtnState();
          showToast(infoHudConfig.rays ? '✨ Азимуты включены' : '✨ Азимуты скрыты');
        }
      },
      {
        id: 'manualPdr',
        icon: '🧲',
        title: 'GPS сюда',
        sub: (WM.manualPdr && WM.manualPdr.isActive()) ? 'Шагомер активен (выкл)' : 'Привязать точку к центру',
        detail: 'Принудительная привязка геопозиции к центру перекрестия и запуск автономного шагомера по датчикам.',
        action: () => { closeQuickMenu(); if (WM.manualPdr?.toggle) WM.manualPdr.toggle(); }
      },
      {
        id: 'gpsDist',
        icon: '🧭',
        title: 'До GPS',
        sub: (WM.gpsDist && WM.gpsDist.isActive()) ? 'Линия включена' : 'Линия от центра к GPS',
        detail: 'Линия от центра экрана до вашего GPS с дистанцией, скоростью, временем хода и курсовым углом.',
        action: () => { closeQuickMenu(); if (WM.gpsDist?.toggle) WM.gpsDist.toggle(); }
      },
      {
        id: 'rangering',
        icon: '🎯',
        title: 'Круг дальности',
        sub: (WM.rangeRing && WM.rangeRing.isEnabled()) ? 'Визир включён' : 'Визир со шкалами',
        detail: 'Круговой тактический визир в центре экрана со шкалами дальности и координатными осями.',
        action: () => {
          closeQuickMenu();
          const next = !(WM.rangeRing && WM.rangeRing.isEnabled());
          uiVis.rangering = next;
          const chk = $('toggle-ui-rangering');
          if (chk) chk.checked = next;
          const subRR = $('sub-rangering-settings');
          if (subRR) subRR.hidden = !next;
          applyUIVisibility();
          showToast(next ? '🎯 Круг дальности включён' : '🎯 Круг дальности скрыт');
        }
      },
      {
        id: 'coords',
        icon: '🌐',
        title: 'Координаты',
        sub: `${coordStr} · Внешние карты`,
        detail: 'Копирование координат центра экрана и открытие точки во внешних картах (Яндекс, Google, OSM, ЭтоМесто).',
        action: () => { closeQuickMenu(false); openCoordsModal(center.lat, center.lng); }
      }
    ];
  }


  // Отрисовка плиток быстрого меню
  function renderQuickMenuItems() {
    const listEl = $('quick-menu-items');
    const box = $('quick-menu-box');
    const lockBtn = $('quick-menu-btn-lock');
    if (!listEl || !box) return;

    listEl.innerHTML = '';

    const isLocked = quickMenuConfig.locked !== false;
    box.classList.toggle('unlocked', !isLocked);
    box.dataset.size = quickMenuConfig.tileSize || 'medium';

    if (lockBtn) {
      lockBtn.textContent = isLocked ? '🔒' : '🔓';
      lockBtn.title = isLocked ? 'Кнопки зафиксированы (нажмите для редактирования)' : 'Режим редактирования (нажмите для фиксации)';
      lockBtn.classList.toggle('unlocked', !isLocked);
    }

    const catalog = getQuickMenuCatalog();
    const catalogMap = new Map(catalog.map(c => [c.id, c]));

    // Синхронизация порядка (добавляем новые, если появились в каталоге)
    const currentOrder = [...quickMenuConfig.order];
    catalog.forEach(c => {
      if (!currentOrder.includes(c.id)) currentOrder.push(c.id);
    });

    // Фильтруем только активные карточки
    const activeIds = currentOrder.filter(id => quickMenuConfig.items[id] !== false && catalogMap.has(id));

    // Перетаскивание (Drag & Drop)
    let draggedId = null;

    activeIds.forEach(id => {
      const item = catalogMap.get(id);
      if (!item) return;

      const tile = el('div', {
        class: 'qm-tile',
        'data-id': id,
        draggable: (!isLocked).toString(),
        onclick: (e) => {
          if (e.target.closest('.qm-tile-del-btn')) return;
          item.action();
        }
      },
        el('span', { class: 'qm-tile-icon', text: item.icon }),
        el('span', { class: 'qm-tile-title', text: item.title, title: item.title }),
        el('span', { class: 'qm-tile-sub', text: item.sub })
      );

      // Крестик удаления (показывается только при открытом замке)
      if (!isLocked) {
        const delBtn = el('button', {
          type: 'button',
          class: 'qm-tile-del-btn',
          title: 'Удалить эту кнопку',
          onclick: (e) => {
            e.stopPropagation();
            quickMenuConfig.items[id] = false;
            saveQuickMenuConfig();
            renderQuickMenuItems();
            showToast(`Кнопка «${item.title}» скрыта`);
          }
        }, el('span', { text: '✕' }));
        tile.appendChild(delBtn);

        // События перетаскивания (Desktop HTML5 DnD)
        tile.addEventListener('dragstart', (e) => {
          draggedId = id;
          tile.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        });

        tile.addEventListener('dragend', () => {
          draggedId = null;
          tile.classList.remove('dragging');
          document.querySelectorAll('.qm-tile').forEach(t => t.classList.remove('drag-over'));
        });

        tile.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (draggedId && draggedId !== id) {
            tile.classList.add('drag-over');
          }
        });

        tile.addEventListener('dragleave', () => {
          tile.classList.remove('drag-over');
        });

        tile.addEventListener('drop', (e) => {
          e.preventDefault();
          tile.classList.remove('drag-over');
          const sourceId = e.dataTransfer.getData('text/plain') || draggedId;
          if (!sourceId || sourceId === id) return;

          const oldIdx = quickMenuConfig.order.indexOf(sourceId);
          const newIdx = quickMenuConfig.order.indexOf(id);
          if (oldIdx !== -1 && newIdx !== -1) {
            quickMenuConfig.order.splice(oldIdx, 1);
            quickMenuConfig.order.splice(newIdx, 0, sourceId);
            saveQuickMenuConfig();
            renderQuickMenuItems();
          }
        });

        // Touch Reordering для мобильных устройств (удержание и смещение)
        let touchStartPt = null;
        let touchHoldTimer = null;
        let isTouchDragging = false;

        tile.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1 || e.target.closest('.qm-tile-del-btn')) return;
          const t = e.touches[0];
          touchStartPt = { x: t.clientX, y: t.clientY };
          clearTimeout(touchHoldTimer);

          touchHoldTimer = setTimeout(() => {
            isTouchDragging = true;
            draggedId = id;
            tile.classList.add('dragging');
            if (navigator.vibrate) navigator.vibrate(40);
          }, 350);
        }, { passive: true });

        tile.addEventListener('touchmove', (e) => {
          if (!touchStartPt) return;
          const t = e.touches[0];
          if (!isTouchDragging) {
            if (Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > 10) {
              clearTimeout(touchHoldTimer);
            }
            return;
          }

          e.preventDefault(); // Защищаем от скролла при драге
          const elemBelow = document.elementFromPoint(t.clientX, t.clientY);
          const targetTile = elemBelow ? elemBelow.closest('.qm-tile') : null;
          document.querySelectorAll('.qm-tile').forEach(el => el.classList.remove('drag-over'));
          if (targetTile && targetTile !== tile && !targetTile.classList.contains('qm-tile-add')) {
            targetTile.classList.add('drag-over');
          }
        }, { passive: false });

        const endTouchDrag = (e) => {
          clearTimeout(touchHoldTimer);
          if (isTouchDragging) {
            isTouchDragging = false;
            tile.classList.remove('dragging');
            document.querySelectorAll('.qm-tile').forEach(el => el.classList.remove('drag-over'));

            const touch = (e.changedTouches && e.changedTouches[0]) || touchStartPt;
            if (touch) {
              const elemBelow = document.elementFromPoint(touch.clientX, touch.clientY);
              const targetTile = elemBelow ? elemBelow.closest('.qm-tile') : null;
              if (targetTile && targetTile !== tile && targetTile.dataset.id) {
                const targetId = targetTile.dataset.id;
                const oldIdx = quickMenuConfig.order.indexOf(id);
                const newIdx = quickMenuConfig.order.indexOf(targetId);
                if (oldIdx !== -1 && newIdx !== -1) {
                  quickMenuConfig.order.splice(oldIdx, 1);
                  quickMenuConfig.order.splice(newIdx, 0, id);
                  saveQuickMenuConfig();
                  renderQuickMenuItems();
                }
              }
            }
          }
          touchStartPt = null;
          draggedId = null;
        };

        tile.addEventListener('touchend', endTouchDrag, { passive: true });
        tile.addEventListener('touchcancel', endTouchDrag, { passive: true });
      }

      listEl.appendChild(tile);
    });

    // Кнопка с плюсом для добавления скрытых элементов (доступна только при открытом замке)
    const hiddenItems = catalog.filter(c => quickMenuConfig.items[c.id] === false);
    if (!isLocked) {
      const addTile = el('button', {
        type: 'button',
        class: 'qm-tile qm-tile-add',
        title: 'Добавить кнопку из недостающих',
        onclick: openQuickMenuAddModal
      },
        el('span', { class: 'qm-tile-add-icon', text: '＋' }),
        el('span', { class: 'qm-tile-title', text: 'Добавить' }),
        el('span', { class: 'qm-tile-sub', text: hiddenItems.length ? `Доступно: ${hiddenItems.length}` : 'Все добавлены' })
      );
      listEl.appendChild(addTile);
    }

    if (!activeIds.length && isLocked) {
      listEl.innerHTML = `
        <div class="muted" style="grid-column: 1 / -1; padding: 24px 12px; line-height: 1.45;">
          Все кнопки скрыты.<br>
          Нажмите на замок <b>🔓</b> вверху, чтобы добавить нужные кнопки через <b>[＋]</b>.
        </div>`;
    }
  }

  // Окно добавления недостающих кнопок
  function openQuickMenuAddModal() {
    const modal = $('modal-quick-menu-add');
    const listEl = $('qm-available-items-list');
    if (!modal || !listEl) return;

    listEl.innerHTML = '';
    const catalog = getQuickMenuCatalog();
    const hiddenItems = catalog.filter(c => quickMenuConfig.items[c.id] === false);

    if (!hiddenItems.length) {
      listEl.innerHTML = '<div class="muted">Все доступные кнопки уже добавлены в меню!</div>';
    } else {
      hiddenItems.forEach(item => {
        const btn = el('div', {
          class: 'qm-available-item',
          onclick: () => {
            quickMenuConfig.items[item.id] = true;
            saveQuickMenuConfig();
            modal.classList.remove('open');
            renderQuickMenuItems();
            showToast(`Кнопка «${item.title}» добавлена!`);
          }
        },
          el('span', { class: 'qm-available-item-icon', text: item.icon }),
          el('div', { class: 'qm-available-item-text' },
            el('span', { class: 'qm-available-item-title', text: item.title }),
            el('span', { class: 'qm-available-item-sub', text: item.sub })
          ),
          el('span', { style: 'font-weight: 800; color: var(--accent); font-size: 16px;', text: '＋' })
        );
        listEl.appendChild(btn);
      });
    }

    modal.classList.add('open');
  }

  function openQuickMenu(clickPos = null) {
    if (!quickMenuConfig.enabled) return;
    const overlay = $('quick-menu-overlay');
    const box = $('quick-menu-box');
    const closeBtn = $('quick-menu-close');
    if (!overlay || !box) return;

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        e.stopPropagation();
        closeQuickMenu();
      }
    };
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeQuickMenu();
      };
    }

    renderQuickMenuItems();
    quickMenuJustOpenedTime = Date.now();

    // Сброс видимости настроек при каждом открытии
    isQmSettingsOpen = false;
    const settingsBar = $('quick-menu-settings-bar');
    if (settingsBar) settingsBar.hidden = true;

    if (clickPos && window.innerWidth >= 768) {
      overlay.classList.add('desktop-context');
      box.style.position = 'absolute';
      const menuW = 380;
      const menuH = 320;
      let left = clickPos.x;
      let top = clickPos.y;
      if (left + menuW > window.innerWidth - 10) left = window.innerWidth - menuW - 10;
      if (top + menuH > window.innerHeight - 10) top = window.innerHeight - menuH - 10;
      if (left < 10) left = 10;
      if (top < 10) top = 10;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
    } else {
      overlay.classList.remove('desktop-context');
      box.style.position = '';
      box.style.left = '';
      box.style.top = '';
    }

    overlay.classList.add('open');
    overlay.hidden = false;
    pushHistoryState('quickMenu');
  }

  function closeQuickMenu(syncHistory = true) {
    const overlay = $('quick-menu-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.hidden = true;
    }
    const modalAdd = $('modal-quick-menu-add');
    if (modalAdd) modalAdd.classList.remove('open');
    if (syncHistory) clearHistoryState('quickMenu');
  }

  // =========================================================================
  // РАДИАЛЬНОЕ ВЕЕРНОЕ МЕНЮ (ЧЕТВЕРТЬ КРУГА: SWIPE / DRAG-TO-SELECT)
  // =========================================================================
  let isPieOpen = false;
  let activePieIndex = -1;
  let pieItems = [];
  let pieDetailTimer = null;

  function startPieDetailTimer(type, item) {
    clearTimeout(pieDetailTimer);
    pieDetailTimer = setTimeout(() => {
      const tipSub = $('quick-pie-tip-sub');
      if (!tipSub) return;
      if (type === 'center') {
        tipSub.textContent = 'Быстрое веерное меню: проведите пальцем к нужному сектору и отпустите. Для отмены отпустите палец в центральном круге.';
      } else if (item && item.detail) {
        tipSub.textContent = item.detail;
      }
    }, 500); // Через 500 мс удержания текст становится подробным
  }

  function closeQuickPie() {
    clearTimeout(pieDetailTimer);
    pieDetailTimer = null;
    const overlay = $('quick-pie-overlay');
    if (overlay) overlay.hidden = true;
    isPieOpen = false;
    activePieIndex = -1;
    pieItems = [];
    document.body.classList.remove('wm-pie-active');
  }

  function openQuickPie(centerPt) {
    const overlay = $('quick-pie-overlay');
    const hud = $('quick-pie-hud');
    const svg = $('quick-pie-svg');
    if (!overlay || !hud || !svg) return;

    const catalog = getQuickMenuCatalog();
    const catalogMap = new Map(catalog.map(c => [c.id, c]));
    const currentOrder = [...quickMenuConfig.order];
    catalog.forEach(c => {
      if (!currentOrder.includes(c.id)) currentOrder.push(c.id);
    });

    const activeList = currentOrder
      .filter(id => quickMenuConfig.items[id] !== false && catalogMap.has(id))
      .map(id => catalogMap.get(id));

    if (!activeList.length) return;

    pieItems = [];
    activePieIndex = -1;

    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const maxR = Math.max(175, Math.min(260, Math.min(winW, winH) * 0.62));

    const cx = centerPt.x;
    const cy = centerPt.y;

    hud.style.left = `${cx}px`;
    hud.style.top = `${cy}px`;
    svg.style.left = `-${cx}px`;
    svg.style.top = `-${cy}px`;
    svg.style.width = `${winW}px`;
    svg.style.height = `${winH}px`;
    svg.innerHTML = '';

    const count = activeList.length;
    const twoRings = count > 5;

    let innerList = [];
    let outerList = [];

    if (!twoRings) {
      innerList = activeList;
    } else {
      // Автоматическое распределение: на дальней/крупной дуге больше иконок пропорционально длине дуги
      let innerCount = Math.max(2, Math.round(count * 0.36));
      if (count - innerCount < innerCount) {
        innerCount = Math.floor(count / 2);
      }
      innerList = activeList.slice(0, innerCount);
      outerList = activeList.slice(innerCount);
    }

    // Радиусы дуг
    const r1_in = Math.round(maxR * 0.28);
    const r1_out = twoRings ? Math.round(maxR * 0.58) : Math.round(maxR * 0.95);
    const r2_in = Math.round(maxR * 0.63);
    const r2_out = Math.round(maxR * 0.98);

    // Дуга ровно 90 градусов (от горизонтали 0° до вертикали 90° вдоль края экрана)
    const aStart = 0;
    // cx — расстояние от центра кнопки до левого края экрана (около 38-44px).
    // Угол влево рассчитывается так, чтобы внешняя дуга доходила до левого среза экрана:
    const leftMarginAngle = Math.PI / 2 + Math.asin(Math.min(0.92, (cx - 4) / maxR));
    const aEnd = Math.min(Math.PI * 0.62, leftMarginAngle); // ~105-112 градусов

    // Центральная точка старта
    const centerPivot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    centerPivot.setAttribute('cx', cx);
    centerPivot.setAttribute('cy', cy);
    centerPivot.setAttribute('r', '14');
    centerPivot.setAttribute('class', 'pie-center-pivot');
    svg.appendChild(centerPivot);

    function buildRing(list, rIn, rOut, ringClass) {
      const n = list.length;
      const step = (aEnd - aStart) / n;
      const gapAngle = n > 1 ? 0.012 : 0;

      list.forEach((item, i) => {
        const rawA1 = aStart + i * step;
        const rawA2 = rawA1 + step;
        const a1 = (i === 0) ? rawA1 : rawA1 + gapAngle;
        const a2 = (i === n - 1) ? rawA2 : rawA2 - gapAngle;
        const midA = (rawA1 + rawA2) / 2;
        const midR = (rIn + rOut) / 2;

        const globalIdx = pieItems.length;
        pieItems.push({
          ...item,
          ring: ringClass === 'ring-outer' ? 'outer' : 'inner',
          rIn,
          rOut,
          a1: rawA1,
          a2: rawA2,
          midA,
          midR,
          idx: globalIdx
        });

        const x1 = cx + rIn * Math.cos(a1);
        const y1 = cy - rIn * Math.sin(a1);
        const x2 = cx + rOut * Math.cos(a1);
        const y2 = cy - rOut * Math.sin(a1);
        const x3 = cx + rOut * Math.cos(a2);
        const y3 = cy - rOut * Math.sin(a2);
        const x4 = cx + rIn * Math.cos(a2);
        const y4 = cy - rIn * Math.sin(a2);

        const pathD = `M ${x1} ${y1} L ${x2} ${y2} A ${rOut} ${rOut} 0 0 0 ${x3} ${y3} L ${x4} ${y4} A ${rIn} ${rIn} 0 0 1 ${x1} ${y1} Z`;

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'pie-item-group');
        group.setAttribute('data-idx', globalIdx);

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathD);
        path.setAttribute('class', `pie-sector ${ringClass}`);
        group.appendChild(path);

        const ix = cx + midR * Math.cos(midA);
        const iy = cy - midR * Math.sin(midA);

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', ix);
        circle.setAttribute('cy', iy);
        circle.setAttribute('r', twoRings ? '18' : '21');
        circle.setAttribute('class', twoRings ? 'pie-icon-circle ring-two' : 'pie-icon-circle');
        group.appendChild(circle);

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        icon.setAttribute('x', ix);
        icon.setAttribute('y', iy + (twoRings ? 0.5 : 1));
        icon.setAttribute('class', 'pie-icon-text');
        icon.textContent = item.icon;
        group.appendChild(icon);

        svg.appendChild(group);
      });
    }

    buildRing(innerList, r1_in, r1_out, 'ring-inner');
    if (twoRings) {
      buildRing(outerList, r2_in, r2_out, 'ring-outer');
    }

    // Сброс подсказки вверху экрана
    const tip = $('quick-pie-tip');
    if (tip) {
      tip.classList.remove('has-selection');
      $('quick-pie-tip-icon').textContent = '⚡';
      $('quick-pie-tip-title').textContent = 'Быстрое меню';
      $('quick-pie-tip-sub').textContent = 'Проведите к кнопке и отпустите';
    }

    overlay.hidden = false;
    isPieOpen = true;
    document.body.classList.add('wm-pie-active');

    // Старт таймера подробного описания для центра
    startPieDetailTimer('center', null);
  }

  function updatePiePointer(x, y, centerPt) {
    if (!isPieOpen || !pieItems.length) return;

    const dx = x - centerPt.x;
    const dy = centerPt.y - y;
    const r = Math.hypot(dx, dy);

    let foundIdx = -1;

    // Зона порога от центральной кнопки (28px)
    if (r >= 28) {
      let angle = Math.atan2(dy, dx);

      // Расширение допуска слева: палец вдоль левого края экрана (dx <= 0, dy > 0)
      if (angle < 0 && angle > -Math.PI / 3) {
        angle = 0.001;
      }
      // Расширение допуска слева: палец ушел за пределы экрана влево
      else if (angle > Math.PI * 0.65 && angle < Math.PI) {
        angle = Math.PI * 0.65;
      }

      // Проверяем попадание во весь сектор от низа (0) до левого края
      if (angle >= 0 && angle <= Math.PI) {
        const count = pieItems.length;
        const twoRings = count > 5;

        const PIE_OUTER_BUFFER = 95; // Та самая «зелёная зона»: запас ~65px за пределами кнопок

        for (let i = 0; i < pieItems.length; i++) {
          const item = pieItems[i];
          const isOuter = !twoRings || item.ring === 'outer';

          // Внешняя дуга активна на самой кнопке и в пределах запаса (зелёной зоны).
          // Если палец уведён дальше (r > item.rOut + PIE_OUTER_BUFFER) — выбор сбрасывается.
          const rMatch = isOuter
            ? (r >= item.rIn - 10 && r <= item.rOut + PIE_OUTER_BUFFER)
            : (r >= item.rIn - 10 && r < item.rOut + 10);

          if (rMatch && angle >= item.a1 - 0.001 && angle <= item.a2 + 0.001) {
            foundIdx = i;
            break;
          }
        }
      }
    }

    if (foundIdx === activePieIndex) return;

    activePieIndex = foundIdx;

    document.querySelectorAll('.pie-item-group').forEach(g => {
      const idx = parseInt(g.getAttribute('data-idx'), 10);
      const isAct = idx === activePieIndex;
      g.classList.toggle('is-active', isAct);
      const sector = g.querySelector('.pie-sector');
      if (sector) sector.classList.toggle('is-active', isAct);
    });

    const tipIcon = $('quick-pie-tip-icon');
    const tipTitle = $('quick-pie-tip-title');
    const tipSub = $('quick-pie-tip-sub');
    const tip = $('quick-pie-tip');

    if (activePieIndex >= 0) {
      const activeItem = pieItems[activePieIndex];
      if (tipIcon) tipIcon.textContent = activeItem.icon;
      if (tipTitle) tipTitle.textContent = activeItem.title;
      if (tipSub) tipSub.textContent = activeItem.sub;
      if (tip) tip.classList.add('has-selection');

      startPieDetailTimer('item', activeItem);

      if (navigator.vibrate) {
        try { navigator.vibrate(16); } catch (e) {}
      }
    } else {
      if (tipIcon) tipIcon.textContent = '⚡';
      if (tipTitle) tipTitle.textContent = 'Отмена';
      if (tipSub) tipSub.textContent = 'Отпустите здесь для отмены';
      if (tip) tip.classList.remove('has-selection');

      startPieDetailTimer('center', null);
    }
  }

  function finishPieSelection() {
    if (!isPieOpen) return;
    const chosenIndex = activePieIndex;
    const chosenItem = chosenIndex >= 0 ? pieItems[chosenIndex] : null;

    closeQuickPie();

    if (chosenItem && typeof chosenItem.action === 'function') {
      if (navigator.vibrate) {
        try { navigator.vibrate(28); } catch (e) {}
      }
      chosenItem.action();
    }
  }

  function initQuickMenu() {
    const overlay = $('quick-menu-overlay');
    const box = $('quick-menu-box');
    const closeBtn = $('quick-menu-close');
    const fabBtn = $('btn-quick-menu');
    const crosshair = $('crosshair');
    const lockBtn = $('quick-menu-btn-lock');
    const settingsBtn = $('quick-menu-btn-settings');
    const settingsBar = $('quick-menu-settings-bar');

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          e.preventDefault();
          e.stopPropagation();
          closeQuickMenu();
        }
      });
    }

    if (box) {
      box.addEventListener('click', (e) => {
        if (!e.target.closest('#quick-menu-close')) {
          e.stopPropagation();
        }
      });
    }

    // Переключение замка фиксации / редактирования
    if (lockBtn) {
      lockBtn.onclick = (e) => {
        e.stopPropagation();
        quickMenuConfig.locked = !quickMenuConfig.locked;
        saveQuickMenuConfig();
        renderQuickMenuItems();
        showToast(quickMenuConfig.locked ? '🔒 Кнопки зафиксированы' : '🔓 Режим правки: можно удалять (✕) и перетаскивать');
      };
    }

    // Выпадающая панель настроек размера
    if (settingsBtn) {
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        isQmSettingsOpen = !isQmSettingsOpen;
        if (settingsBar) settingsBar.hidden = !isQmSettingsOpen;
      };
    }

    // Выбор размера кнопок: Мелкий / Обычный / Крупный
    document.querySelectorAll('#quick-menu-size-segmented .qm-size-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#quick-menu-size-segmented .qm-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        quickMenuConfig.tileSize = btn.dataset.size;
        saveQuickMenuConfig();
        renderQuickMenuItems();
      };
    });

    // Сброс порядка кнопок
    const resetOrderBtn = $('quick-menu-btn-reset-order');
    if (resetOrderBtn) {
      resetOrderBtn.onclick = () => {
        quickMenuConfig.order = [...DEFAULT_QUICK_MENU_ORDER];
        DEFAULT_QUICK_MENU_ORDER.forEach(id => { quickMenuConfig.items[id] = true; });
        saveQuickMenuConfig();
        renderQuickMenuItems();
        showToast('Порядок и кнопки сброшены по умолчанию');
      };
    }

    // Окно добавления скрытых кнопок
    $('qm-add-modal-close')?.addEventListener('click', () => $('modal-quick-menu-add')?.classList.remove('open'));
    $('qm-add-modal-cancel')?.addEventListener('click', () => $('modal-quick-menu-add')?.classList.remove('open'));
    $('modal-quick-menu-add')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-quick-menu-add') $('modal-quick-menu-add').classList.remove('open');
    });

    if (closeBtn) {
      const handleClose = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeQuickMenu();
      };
      closeBtn.onclick = handleClose;
      closeBtn.addEventListener('touchend', handleClose, { passive: false });
    }

    if (fabBtn) {
      let pieHoldTimer = null;
      let pieStarted = false;
      let centerPt = { x: 0, y: 0 };
      let suppressClickUntil = 0;

      const getBtnCenter = () => {
        const r = fabBtn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      fabBtn.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        pieStarted = false;
        centerPt = getBtnCenter();
        clearTimeout(pieHoldTimer);

        pieHoldTimer = setTimeout(() => {
          pieStarted = true;
          suppressClickUntil = Date.now() + 600;
          if (navigator.vibrate) {
            try { navigator.vibrate(35); } catch (err) {}
          }
          openQuickPie(centerPt);
        }, 220); // 220 мс удержания для запуска
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        if (!pieStarted || !isPieOpen || e.touches.length !== 1) return;
        e.preventDefault();
        const t = e.touches[0];
        updatePiePointer(t.clientX, t.clientY, centerPt);
      }, { passive: false });

      const onTouchEnd = () => {
        clearTimeout(pieHoldTimer);
        if (pieStarted) {
          pieStarted = false;
          suppressClickUntil = Date.now() + 600;
          finishPieSelection();
        }
      };

      window.addEventListener('touchend', onTouchEnd, { passive: true });
      window.addEventListener('touchcancel', onTouchEnd, { passive: true });

      // Поддержка мыши для ПК (зажал ЛКМ на кнопке -> перевёл курсор -> отпустил)
      fabBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        pieStarted = false;
        centerPt = getBtnCenter();
        clearTimeout(pieHoldTimer);

        pieHoldTimer = setTimeout(() => {
          pieStarted = true;
          suppressClickUntil = Date.now() + 600;
          openQuickPie(centerPt);
        }, 220);
      });

      window.addEventListener('mousemove', (e) => {
        if (!pieStarted || !isPieOpen) return;
        updatePiePointer(e.clientX, e.clientY, centerPt);
      });

      window.addEventListener('mouseup', (e) => {
        clearTimeout(pieHoldTimer);
        if (pieStarted) {
          pieStarted = false;
          suppressClickUntil = Date.now() + 600;
          finishPieSelection();
        }
      });

      fabBtn.onclick = (e) => {
        if (Date.now() < suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        openQuickMenu(null);
      };
    }

    if (crosshair) {
      crosshair.addEventListener('click', (e) => {
        if (!quickMenuConfig.enabled || !quickMenuConfig.triggers.crosshair) return;
        e.stopPropagation();
        openQuickMenu(null);
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('modal-quick-menu-add')?.classList.contains('open')) {
          $('modal-quick-menu-add').classList.remove('open');
          return;
        }
        if (overlay && (!overlay.hidden || overlay.classList.contains('open'))) {
          closeQuickMenu();
        }
      }
    });



    // Обработка правого клика (ПК) и долгого тапа (смартфон) на карте
    const mapContainer = WM.map ? WM.map.getContainer() : document.getElementById('map');
    if (mapContainer) {
      mapContainer.addEventListener('contextmenu', (e) => {
        if (e.target.closest('button, a, input, select, textarea, .leaflet-control, .modal-overlay, .sheet, .lightbox, .wm-custom-marker-icon, .wm-ruler-vertex-icon, .wm-ruler-midpoint-icon, .wm-qm-marker, .quick-measure-hud, .measure-hud')) {
          return;
        }
        if (!quickMenuConfig.enabled || !quickMenuConfig.triggers.longpress) return;
        e.preventDefault();
        openQuickMenu({ x: e.clientX, y: e.clientY });
      });

      let touchStartPos = null;
      let longPressTimer = null;

      mapContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
          if (longPressTimer) clearTimeout(longPressTimer);
          return;
        }
        if (e.target.closest('button, a, input, select, textarea, .leaflet-control, .modal-overlay, .sheet, .lightbox, .wm-custom-marker-icon, .wm-ruler-vertex-icon, .wm-ruler-midpoint-icon, .wm-qm-marker, .quick-measure-hud, .measure-hud, .wm-gc-pin-anchor, .wm-gc-bubble, .wm-gc-div-icon')) {
          return;
        }
        const t = e.touches[0];
        touchStartPos = { x: t.clientX, y: t.clientY };
        if (longPressTimer) clearTimeout(longPressTimer);

        if (!quickMenuConfig.enabled || !quickMenuConfig.triggers.longpress) return;

        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (navigator.vibrate) navigator.vibrate(35);
          openQuickMenu(window.innerWidth >= 768 ? { x: t.clientX, y: t.clientY } : null);
        }, 480);
      }, { passive: true });

      mapContainer.addEventListener('touchmove', (e) => {
        if (!longPressTimer || !touchStartPos) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - touchStartPos.x, t.clientY - touchStartPos.y) > 10) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }, { passive: true });

      mapContainer.addEventListener('touchend', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }, { passive: true });

      mapContainer.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }, { passive: true });
    }

    updateQuickMenuTriggersUI();
  }

  // =========================================================================
  // ПРОВЕРКА ДОСТУПНОСТИ И ВЫБОР БАЗОВЫХ КАРТ
  // =========================================================================
  const mapCheckResults = new Map(); // id -> { status: 'ok'|'err'|'warn', text: string }

  // Расчет URL тайла для проверки в обход Leaflet
  function computeSampleTileUrl(m) {
    const { testPoint, testUrl, isTms, subdomains } = m;
    const { lat, lng, z } = testPoint;
    const n = Math.pow(2, z);
    const x = Math.floor((lng + 180) / 360 * n);
    const latRad = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    const yTms = n - 1 - y;

    // Генерация QuadKey для Bing
    let q = '';
    for (let i = z; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((x & mask) !== 0) digit += 1;
      if ((y & mask) !== 0) digit += 2;
      q += digit;
    }

    let s = 'a';
    if (Array.isArray(subdomains) && subdomains.length) {
      s = subdomains[Math.abs(x + y) % subdomains.length];
    }

    return testUrl
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{-y}', yTms)
      .replace('{s}', s)
      .replace('{q}', q);
  }

  // Одиночная проверка загрузки через объект Image (обход CORS)
  function testTileImage(url, timeoutMs = 5500) {
    return new Promise((resolve) => {
      const img = new Image();
      let timer = null;
      let done = false;

      const finish = (status, latency = 0, message = '') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        img.src = '';
        resolve({ status, latency, message });
      };

      const startTime = performance.now();
      timer = setTimeout(() => {
        finish('warn', Math.round(performance.now() - startTime), 'Таймаут (>5.5 с)');
      }, timeoutMs);

      img.onload = () => {
        const latency = Math.round(performance.now() - startTime);
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          finish('ok', latency, `${latency} мс`);
        } else {
          finish('err', latency, 'Пустой ответ');
        }
      };

      img.onerror = () => {
        const latency = Math.round(performance.now() - startTime);
        finish('err', latency, 'Ошибка сети / 404');
      };

      const cacheBust = (url.includes('?') ? '&' : '?') + '_wmchk=' + Date.now();
      img.src = url + cacheBust;
    });
  }

  // Адекватная проверка с 1 повторной попыткой при сбое
  async function testMapAvailabilityReliable(mapDef) {
    const tileUrl = computeSampleTileUrl(mapDef);
    let res = await testTileImage(tileUrl, 5500);

    // Если первая попытка упала, повторяем через 400 мс
    if (res.status !== 'ok') {
      await new Promise(r => setTimeout(r, 400));
      const retryRes = await testTileImage(tileUrl, 5500);
      if (retryRes.status === 'ok') {
        res = retryRes;
      }
    }
    return res;
  }

  function updateMapBadgeUI(id, status, text) {
    const badge = $(`map-status-${id}`);
    if (!badge) return;
    badge.className = `map-status-badge map-status-${status}`;
    if (status === 'checking') {
      badge.textContent = '⏳ Проверка…';
    } else if (status === 'ok') {
      badge.textContent = `🟢 Доступна (${text})`;
    } else if (status === 'warn') {
      badge.textContent = `🟡 ${text}`;
    } else if (status === 'err') {
      badge.textContent = `🔴 Недоступна (${text})`;
    } else {
      badge.className = 'map-status-badge map-status-idle';
      badge.textContent = '';
    }
  }

  // Запуск проверки всех карт
  async function runAllMapsAvailabilityCheck() {
    const btn = $('btn-check-maps-status');
    const summary = $('map-check-summary');
    if (!btn || !WM.baseMapsCatalog) return;

    btn.classList.add('loading');
    btn.textContent = '⏳ Проверка карт…';
    if (summary) {
      summary.hidden = false;
      summary.textContent = 'Подключение к серверам карт…';
    }

    WM.baseMapsCatalog.forEach(m => {
      updateMapBadgeUI(m.id, 'checking');
    });

    const catalog = WM.baseMapsCatalog;
    let done = 0, okCount = 0, failCount = 0;
    const concurrency = 4;
    let index = 0;

    async function worker() {
      while (index < catalog.length) {
        const m = catalog[index++];
        const res = await testMapAvailabilityReliable(m);
        done++;
        if (res.status === 'ok') okCount++;
        else failCount++;

        mapCheckResults.set(m.id, res);
        updateMapBadgeUI(m.id, res.status, res.message);

        if (summary) {
          summary.innerHTML = `<span>Проверено: <b>${done}/${catalog.length}</b></span><span>🟢 ${okCount} · 🔴 ${failCount}</span>`;
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, catalog.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    btn.classList.remove('loading');
    btn.textContent = '🔄 Проверить повторно';
    if (summary) {
      summary.innerHTML = `<span>Готово! Доступно: <b>${okCount} из ${catalog.length}</b></span><span>${failCount > 0 ? '⚠️ Есть недоступные' : '✅ Все работают'}</span>`;
    }
    showToast(`Проверка завершена: доступно ${okCount} из ${catalog.length} карт`);
  }

  function updateQuickSwapTargetBtn() {
    const titleEl = $('quick-swap-target-title');
    if (!titleEl) return;

    const targetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

    if (targetMap.startsWith('kml:')) {
      const kmlId = targetMap.slice(4);
      const kml = WM.imageOverlay && WM.imageOverlay.getOverlay ? WM.imageOverlay.getOverlay(kmlId) : null;
      titleEl.textContent = kml ? `📜 ${kml.name}` : '📜 KML карта';
    } else {
      const isSat = targetMap.includes('Спутник');
      const icon = isSat ? '🛰️' : '🗺️';
      titleEl.textContent = `${icon} ${targetMap}`;
    }
  }
  WM.ui = WM.ui || {};
  WM.ui.updateQuickSwapTargetBtn = updateQuickSwapTargetBtn;

  // Отрисовка списков карт в настройках
  function renderBaseMapsSettingsUI() {
    const modernListEl = $('modern-maps-list');
    const histListEl = $('historical-maps-list');
    const histCountEl = $('historical-maps-count');
    if (!modernListEl || !histListEl || !WM.baseMapsCatalog) return;

    const chkQuickSwap = $('toggle-quick-swap-enabled');
    const wrapQuickSwap = $('quick-swap-select-wrap');
    const selectQuickSwap = $('quick-swap-map-select');
    const selectQuickSwapPos = $('quick-swap-pos-select'); // <-- Добавлено

    const isQuickSwapOn = localStorage.getItem('wm_quick_swap_enabled') !== 'false';
    const currentTargetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';
    const currentSwapPos = localStorage.getItem('wm_quick_swap_pos') || 'top-right'; // <-- Добавлено

    const btnChooseMap = $('btn-quick-swap-choose-map');
    if (btnChooseMap) {
      btnChooseMap.onclick = () => {
        if (window.openQuickSwapTargetModal) {
          window.openQuickSwapTargetModal();
        }
      };
      updateQuickSwapTargetBtn();
    }

    if (selectQuickSwapPos) {
      selectQuickSwapPos.value = currentSwapPos; // <-- Добавлено
    }

    if (chkQuickSwap) {
      chkQuickSwap.checked = isQuickSwapOn;
      if (wrapQuickSwap) wrapQuickSwap.hidden = !isQuickSwapOn;

      chkQuickSwap.onchange = (e) => {
        if (wrapQuickSwap) wrapQuickSwap.hidden = !e.target.checked;
      };
    }

    if (selectQuickSwap) {
      selectQuickSwap.innerHTML = '';
      WM.baseMapsCatalog.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = `${m.category === 'historical' ? '📜 ' : '🗺️ '}${m.name}`;
        if (m.name === currentTargetMap) opt.selected = true;
        selectQuickSwap.appendChild(opt);
      });
    }

    modernListEl.innerHTML = '';
    histListEl.innerHTML = '';

    let disabledList = [];
    try {
      const stored = localStorage.getItem('wm_disabled_base_maps');
      if (stored !== null) {
        disabledList = JSON.parse(stored) || [];
      } else if (WM.getDefaultDisabledBaseMaps) {
        disabledList = WM.getDefaultDisabledBaseMaps();
      }
      if (!Array.isArray(disabledList)) disabledList = [];
    } catch (e) { 
      disabledList = WM.getDefaultDisabledBaseMaps ? WM.getDefaultDisabledBaseMaps() : []; 
    }
    const histMaps = WM.baseMapsCatalog.filter(m => m.category === 'historical');
    if (histCountEl) histCountEl.textContent = histMaps.length;

    WM.baseMapsCatalog.forEach(m => {
      const isHist = m.category === 'historical';
      const isChecked = !disabledList.includes(m.name);
      const targetContainer = isHist ? histListEl : modernListEl;

      const itemLabel = el('label', { class: 'toggle-item map-toggle-item' },
        el('div', { class: 'map-item-meta' },
          el('span', { class: 'map-item-title', text: m.name }),
          el('span', { id: `map-status-${m.id}`, class: 'map-status-badge map-status-idle' })
        ),
        el('input', {
          type: 'checkbox',
          class: 'map-checkbox-input',
          'data-map-name': m.name,
          checked: isChecked,
          onchange: (e) => {
            // Защита от полного отключения всех карт
            const allChecked = document.querySelectorAll('.map-checkbox-input:checked');
            if (allChecked.length === 0) {
              e.target.checked = true;
              showToast('Должна быть включена хотя бы одна карта!');
            }
          }
        }),
        el('span', { class: 'toggle-switch' })
      );

      targetContainer.append(itemLabel);

      // Восстанавливаем ранее сохраненный бейдж проверки
      if (mapCheckResults.has(m.id)) {
        const cached = mapCheckResults.get(m.id);
        updateMapBadgeUI(m.id, cached.status, cached.message);
      }
    });

    const btnCheck = $('btn-check-maps-status');
    if (btnCheck) btnCheck.onclick = runAllMapsAvailabilityCheck;

    const btnSelectAll = $('btn-maps-select-all');
    if (btnSelectAll) {
      btnSelectAll.onclick = () => {
        document.querySelectorAll('.map-checkbox-input').forEach(chk => { chk.checked = true; });
      };
    }

    const btnDeselectAll = $('btn-maps-deselect-all');
    if (btnDeselectAll) {
      btnDeselectAll.onclick = () => {
        const curActiveName = localStorage.getItem('wm_base_layer') || 'Схема (Яндекс)';
        let keptOne = false;
        document.querySelectorAll('.map-checkbox-input').forEach(chk => {
          if (chk.dataset.mapName === curActiveName || (!keptOne && chk.dataset.mapName.includes('Яндекс'))) {
            chk.checked = true;
            keptOne = true;
          } else {
            chk.checked = false;
          }
        });
        showToast('Оставлена только активная карта');
      };
    }
  }

  const UI_VIS_DEFAULT = {
    status: true,
    limit: true,
    pill: true,
    zoom: true,
    layers: true,
    search: true,
    mode: true,
    quickmeasure: false,
    trackrecord: true, // <-- Добавлено
    measure: true,
    marker: false,
    precache: false,   // <-- изменено с true на false
    location: true,
    manualpdr: true,   // <-- изменено с false на true
    gpsdist: false,
    motion: false,
    compasscone: true,
    compassneedle: true,
    rays: false,
    theme: true,
    infomenu: true,
    rangering: false,
    motiontail: true,
    motionvector: false,
    hideuibtn: false
  };
  let uiVis = { ...UI_VIS_DEFAULT }; // <-- ДОБАВИТЬ ЭТУ СТРОКУ

  const VIS_KEYS = ['status', 'limit', 'pill', 'zoom', 'layers', 'search', 'mode', 'quickmeasure', 'measure', 'marker', 'precache', 'location', 'manualpdr', 'gpsdist', 'motion', 'compasscone', 'compassneedle', 'rays', 'theme', 'infomenu', 'rangering', 'motiontail', 'motionvector', 'hideuibtn', 'trackrecord'];
  const DEFAULT_INFO_ITEMS = {
    time: true,
    userCoords: true,
    centerCoords: true,
    gps: true,
    sun: true,
    moon: true,
    weather: true,
    rays: false
  };

  let infoHudConfig = { ...DEFAULT_INFO_ITEMS };
  try {
    const savedIH = JSON.parse(WM.api.store.get('wm_info_hud_items') || '{}');
    infoHudConfig = { ...DEFAULT_INFO_ITEMS, ...savedIH };
  } catch (e) {}


  let infoHudTimer = null;
  let infoRaysLayer = null;
  let sunRayPoly = null;
  let moonRayPoly = null;
  let infoAstroDayOffset = 0; // от -3 до +7 дней

  const hudSpoilersState = {
    sun: true,
    moon: true,
    weather: false,
    weatherHourly: false
  };

  // Коды погоды WMO (World Meteorological Organization)
  const WMO_WEATHER_MAP = {
    0: { text: 'Ясно', icon: '☀️' },
    1: { text: 'Преимущ. ясно', icon: '🌤️' },
    2: { text: 'Переменная обл.', icon: '⛅' },
    3: { text: 'Пасмурно', icon: '☁️' },
    45: { text: 'Туман', icon: '🌫️' },
    48: { text: 'Туман/иней', icon: '🌫️' },
    51: { text: 'Слабая морось', icon: '🌦️' },
    53: { text: 'Морось', icon: '🌦️' },
    55: { text: 'Сильная морось', icon: '🌧️' },
    61: { text: 'Небольшой дождь', icon: '🌦️' },
    63: { text: 'Умеренный дождь', icon: '🌧️' },
    65: { text: 'Сильный дождь', icon: '🌧️' },
    71: { text: 'Небольшой снег', icon: '🌨️' },
    73: { text: 'Снегопад', icon: '🌨️' },
    75: { text: 'Сильный снегопад', icon: '❄️' },
    77: { text: 'Снежные зерна', icon: '❄️' },
    80: { text: 'Кратковрем. дождь', icon: '🌦️' },
    81: { text: 'Ливень', icon: '🌧️' },
    82: { text: 'Сильный ливень', icon: '⛈️' },
    85: { text: 'Снегопад', icon: '🌨️' },
    86: { text: 'Сильный снегопад', icon: '❄️' },
    95: { text: 'Гроза', icon: '⛈️' },
    96: { text: 'Гроза с градом', icon: '⛈️' },
    99: { text: 'Сильная гроза с градом', icon: '⛈️' }
  };

  // =========================================================================
  // МАРШРУТЫ И ФОЛЛБЕКИ ЗАГРУЗКИ ПОГОДЫ (ОБХОД БЛОКИРОВОК)
  // =========================================================================
  // =========================================================================
  // МАРШРУТЫ И ФОЛЛБЕКИ ЗАГРУЗКИ ПОГОДЫ (OPEN-METEO + WTTR.IN)
  // =========================================================================
  
  // Конвертер кода погоды WWO (wttr.in) в стандартный код WMO (Open-Meteo)
  // =========================================================================
  // МАРШРУТЫ И ФОЛЛБЕКИ ЗАГРУЗКИ ПОГОДЫ (OPEN-METEO + WTTR.IN + МНОГОУРОВНЕВЫЙ ПРОКСИ)
  // =========================================================================

  function wwoToWmoCode(wwoCode) {
    const code = parseInt(wwoCode, 10);
    switch (code) {
      case 113: return 0;  // Ясно
      case 116: return 2;  // Переменная облачность
      case 119:
      case 122: return 3;  // Пасмурно
      case 143:
      case 248:
      case 260: return 45; // Туман
      case 176:
      case 263:
      case 266:
      case 293:
      case 296: return 61; // Небольшой дождь
      case 302:
      case 308: return 65; // Сильный дождь
      case 179:
      case 227:
      case 230:
      case 323:
      case 326: return 71; // Небольшой снег
      case 332:
      case 338: return 75; // Снегопад
      case 200:
      case 386:
      case 389: return 95; // Гроза
      default: return 1;
    }
  }

  // Адаптер: преобразует формат wttr.in (?format=j1) в структуру Open-Meteo
  function parseWttrAsOpenMeteo(data) {
    if (!data || !Array.isArray(data.weather)) throw new Error('Некорректный wttr.in');
    const hourlyTimes = [];
    const hourlyTemps = [];
    const hourlyCodes = [];
    const hourlyPrecip = [];
    const dailyTimes = [];
    const dailyPrecip = [];
    const dailyCodes = [];

    const pad = n => String(n).padStart(2, '0');

    data.weather.forEach(day => {
      dailyTimes.push(day.date);
      const dayPrecip = (day.hourly || []).reduce((acc, h) => acc + (parseFloat(h.precipMM) || 0), 0);
      dailyPrecip.push(dayPrecip);
      dailyCodes.push(day.hourly && day.hourly[4] ? wwoToWmoCode(day.hourly[4].weatherCode) : 0);

      (day.hourly || []).forEach(h => {
        const hour = Math.floor(parseInt(h.time, 10) / 100);
        hourlyTimes.push(`${day.date}T${pad(hour)}:00`);
        hourlyTemps.push(parseFloat(h.tempC != null ? h.tempC : h.temp_C));
        hourlyCodes.push(wwoToWmoCode(h.weatherCode));
        hourlyPrecip.push(parseFloat(h.precipMM) || 0);
      });
    });

    return {
      hourly: {
        time: hourlyTimes,
        temperature_2m: hourlyTemps,
        precipitation: hourlyPrecip,
        weather_code: hourlyCodes
      },
      daily: {
        time: dailyTimes,
        precipitation_sum: dailyPrecip,
        weather_code: dailyCodes
      }
    };
  }

  // Безопасный запрос с таймаутом и распаковкой прокси-обёрток
  async function fetchWeatherEndpoint(url, timeoutMs = 3800) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('Ответ не в формате JSON');
      }

      // Если ответ пришел через прокси с полем contents (например, allorigins / hexlet)
      if (json && typeof json.contents === 'string') {
        json = JSON.parse(json.contents);
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  let weatherCacheData = null;
  WM.weather = {
    getCache() {
      return weatherCacheData;
    },
    getCacheKey() {
      return weatherCacheKey;
    },
    // Получение данных погоды (из кэша или запрос с зеркалами)
    async getWeatherData(lat, lng, signal = null) {
      const key = `${lat.toFixed(1)}_${lng.toFixed(1)}`;
      const now = Date.now();
      
      if (weatherCacheKey === key && weatherCacheData && (now - weatherCacheTimestamp < WEATHER_CACHE_TTL)) {
        return weatherCacheData;
      }

      // Расширенный запрос: осадки, температура воздуха, температура и влажность почвы (0-7 см)
      const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=temperature_2m,precipitation,weather_code,soil_temperature_0cm,soil_temperature_6cm,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm&daily=weather_code,precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=5&forecast_days=3&timezone=auto`;

      let data = null;
      try {
        data = await fetchWeatherEndpoint(openMeteoUrl, 2500);
      } catch (errDirect) {
        data = await Promise.any([
          fetchWeatherEndpoint('https://allorigins.hexlet.app/raw?url=' + encodeURIComponent(openMeteoUrl), 4000),
          fetchWeatherEndpoint('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(openMeteoUrl), 4000)
        ]);
      }

      if (data && data.hourly && Array.isArray(data.hourly.time)) {
        weatherCacheData = data;
        weatherCacheKey = key;
        weatherCacheTimestamp = Date.now();
        try { localStorage.setItem('wm_weather_last_cache', JSON.stringify({ key, data, time: weatherCacheTimestamp })); } catch (e) {}
        return data;
      }
      throw new Error('Не удалось получить метеоданные');
    }
  };
  let weatherCacheKey = '';
  let isWeatherLoading = false;
  let lastWeatherFailTime = 0;

  // Восстановление последнего прогноза из локальной памяти при старте
  try {
    const savedWeather = localStorage.getItem('wm_weather_last_cache');
    if (savedWeather) {
      const parsed = JSON.parse(savedWeather);
      if (parsed && parsed.data && parsed.key) {
        weatherCacheData = parsed.data;
        weatherCacheKey = parsed.key;
      }
    }
  } catch (e) {}

  let weatherCacheTimestamp = 0;
  let weatherFailCount = 0;
  const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 минут

  async function loadWeatherIfNeeded(lat, lng) {
    if (!infoHudConfig.weather) return;

    // Шаг toFixed(1) (~11 км) вместо toFixed(2) (~1.1 км)
    const key = `${lat.toFixed(1)}_${lng.toFixed(1)}`;
    const now = Date.now();

    // Если координаты те же и кэш моложе 30 минут — повторный сетевой запрос НЕ делаем
    if (weatherCacheKey === key && weatherCacheData && (now - weatherCacheTimestamp < WEATHER_CACHE_TTL)) {
      return;
    }

    if (isWeatherLoading) return;

    // Экспоненциальный бэкофф при ошибках сети (6с -> 12с -> 24с -> до 2 минут)
    const backoffDelay = Math.min(120000, 6000 * Math.pow(2, weatherFailCount));
    if (now - lastWeatherFailTime < backoffDelay) return;

    isWeatherLoading = true;
    const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=temperature_2m,precipitation,weather_code,soil_temperature_0cm,soil_temperature_6cm,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm&daily=weather_code,precipitation_sum&past_days=5&forecast_days=7&timezone=auto`;

    try {
      let data = null;
      try {
        data = await fetchWeatherEndpoint(openMeteoUrl, 1800);
      } catch (errDirect) {
        // Запускаем гонку только 2 самых стабильных зеркал вместо 5 одновременно
        data = await Promise.any([
          fetchWeatherEndpoint('https://allorigins.hexlet.app/raw?url=' + encodeURIComponent(openMeteoUrl), 3800),
          fetchWeatherEndpoint('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(openMeteoUrl), 3800)
        ]);
      }

      if (data && data.hourly && Array.isArray(data.hourly.time)) {
        weatherCacheData = data;
        weatherCacheKey = key;
        weatherCacheTimestamp = Date.now();
        weatherFailCount = 0;
        lastWeatherFailTime = 0;
        try { localStorage.setItem('wm_weather_last_cache', JSON.stringify({ key, data, time: weatherCacheTimestamp })); } catch (e) {}
      } else {
        throw new Error('Пустой ответ погоды');
      }
    } catch (err) {
      weatherFailCount++;
      lastWeatherFailTime = Date.now();
    } finally {
      isWeatherLoading = false;
      updateInfoHudUI();
    }
  }

  function getWeatherForDate(targetDate) {
    if (!weatherCacheData || !weatherCacheData.hourly) return null;

    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;

    const times = weatherCacheData.hourly.time;
    const temps = weatherCacheData.hourly.temperature_2m;
    const codes = weatherCacheData.hourly.weather_code;
    const precips = weatherCacheData.hourly.precipitation || [];

    function getHourData(hour) {
      const targetTime = `${dateStr}T${pad(hour)}:00`;
      const idx = times.indexOf(targetTime);
      if (idx === -1) return null;
      const t = temps[idx];
      const code = codes[idx];
      const wInfo = WMO_WEATHER_MAP[code] || { text: 'Ясно', icon: '🌤️' };
      return {
        temp: t != null ? (t > 0 ? `+${Math.round(t)}` : `${Math.round(t)}`) + '°' : '--',
        icon: wInfo.icon,
        text: wInfo.text
      };
    }

    const morning = getHourData(9);
    const day = getHourData(15);
    const evening = getHourData(21);
    const night = getHourData(3);

    // Сбор почасового прогноза на все 24 часа выбранного дня
    const hourlyList = [];
    for (let h = 0; h < 24; h++) {
      const targetTime = `${dateStr}T${pad(h)}:00`;
      const idx = times.indexOf(targetTime);
      if (idx !== -1) {
        const t = temps[idx];
        const code = codes[idx];
        const p = precips[idx] != null ? precips[idx] : 0;
        const wInfo = WMO_WEATHER_MAP[code] || { text: 'Ясно', icon: '🌤️' };
        hourlyList.push({
          hour: h,
          timeStr: `${pad(h)}:00`,
          temp: t != null ? (t > 0 ? `+${Math.round(t)}` : `${Math.round(t)}`) + '°' : '--',
          precip: p > 0 ? (p < 0.1 ? '0.1' : p.toFixed(1)) : null,
          icon: wInfo.icon,
          text: wInfo.text
        });
      }
    }

    // Осадки и общее описание за день из блока daily
    let precipSum = 0;
    let dayCode = 0;
    if (weatherCacheData.daily && weatherCacheData.daily.time) {
      const dIdx = weatherCacheData.daily.time.indexOf(dateStr);
      if (dIdx !== -1) {
        precipSum = weatherCacheData.daily.precipitation_sum[dIdx] || 0;
        dayCode = weatherCacheData.daily.weather_code[dIdx] || 0;
      }
    }

    const mainWeather = WMO_WEATHER_MAP[dayCode] || (day ? WMO_WEATHER_MAP[codes[times.indexOf(`${dateStr}T15:00`)]] : null) || { text: 'Без осадков', icon: '🌤️' };

    return {
      morning,
      day,
      evening,
      night,
      hourlyList,
      precipSum,
      weatherDesc: mainWeather.text,
      weatherIcon: mainWeather.icon
    };
  }


  function getDestPoint(startLL, brngDeg, distM) {
    const R = 6371e3;
    const δ = distM / R;
    const θ = brngDeg * Math.PI / 180;
    const φ1 = startLL.lat * Math.PI / 180;
    const λ1 = startLL.lng * Math.PI / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return L.latLng(φ2 * 180 / Math.PI, λ2 * 180 / Math.PI);
  }

  // Сверхбыстрое обновление линий азимута (60 FPS без пересоздания DOM)
  let lastRayOrigin = null;
  let lastRayCalcTime = 0;

  function updateRays(centerLL, force = false) {
    if (!WM.map || !infoHudConfig.rays) {
      if (infoRaysLayer) infoRaysLayer.clearLayers();
      sunRayPoly = null;
      moonRayPoly = null;
      return;
    }

    const map = WM.map;
    const origin = centerLL || map.getCenter();
    const now = Date.now();

    // Если центр не сдвинулся и не прошло 15 секунд — пропускаем
    const centerMoved = !lastRayOrigin || lastRayOrigin.distanceTo(origin) > 0.5;
    const timeElapsed = (now - lastRayCalcTime) > 15000;

    if (!force && !centerMoved && !timeElapsed) {
      return;
    }

    lastRayOrigin = origin;
    lastRayCalcTime = now;

    if (!window.SunCalc) return;

    if (!infoRaysLayer) {
      infoRaysLayer = L.layerGroup().addTo(map);
    }

    const astroDate = new Date(now);
    astroDate.setDate(astroDate.getDate() + infoAstroDayOffset);

    const sunPos = SunCalc.getPosition(astroDate, origin.lat, origin.lng);
    const moonPos = SunCalc.getMoonPosition(astroDate, origin.lat, origin.lng);

    const sunAzDeg = ((sunPos.azimuth * 180 / Math.PI + 180) % 360);
    const moonAzDeg = ((moonPos.azimuth * 180 / Math.PI + 180) % 360);

    const bounds = map.getBounds();
    const rayLenMeters = Math.max(8000, origin.distanceTo(bounds.getNorthEast()) * 1.5);

    const sunEnd = getDestPoint(origin, sunAzDeg, rayLenMeters);
    const moonEnd = getDestPoint(origin, moonAzDeg, rayLenMeters);

    if (!sunRayPoly) {
      sunRayPoly = L.polyline([origin, sunEnd], {
        pane: 'wm-top-lines',
        color: '#f59e0b',
        weight: 2.5,
        dashArray: '5, 8',
        opacity: 0.9,
        interactive: false
      }).addTo(infoRaysLayer);
    } else {
      sunRayPoly.setLatLngs([origin, sunEnd]);
    }

    if (!moonRayPoly) {
      moonRayPoly = L.polyline([origin, moonEnd], {
        pane: 'wm-top-lines',
        color: '#38bdf8',
        weight: 2,
        dashArray: '3, 6',
        opacity: 0.85,
        interactive: false
      }).addTo(infoRaysLayer);
    } else {
      moonRayPoly.setLatLngs([origin, moonEnd]);
    }
  }

  function changeAstroDay(delta) {
    const next = Math.max(-3, Math.min(7, infoAstroDayOffset + delta));
    if (next !== infoAstroDayOffset) {
      infoAstroDayOffset = next;
      updateInfoHudUI();
    }
  }

  function resetAstroDay() {
    if (infoAstroDayOffset !== 0) {
      infoAstroDayOffset = 0;
      updateInfoHudUI();
    }
  }

  const MOON_PHASE_NAMES = [
    { max: 0.03, name: 'Новолуние', icon: '🌑' },
    { max: 0.22, name: 'Растущий серп', icon: '🌒' },
    { max: 0.28, name: 'Первая четверть', icon: '🌓' },
    { max: 0.47, name: 'Растущая луна', icon: '🌔' },
    { max: 0.53, name: 'Полнолуние', icon: '🌕' },
    { max: 0.72, name: 'Убывающая луна', icon: '🌖' },
    { max: 0.78, name: 'Последняя четверть', icon: '🌗' },
    { max: 0.97, name: 'Убывающий серп', icon: '🌘' },
    { max: 1.00, name: 'Новолуние', icon: '🌑' }
  ];

  function getMoonPhaseInfo(phaseFraction) {
    const p = (phaseFraction % 1 + 1) % 1;
    for (const item of MOON_PHASE_NAMES) {
      if (p <= item.max) return item;
    }
    return MOON_PHASE_NAMES[0];
  }

  function fmtTime(d) {
    if (!d || isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }

  function degToCompass(deg) {
    const val = Math.floor((deg / 22.5) + 0.5);
    const arr = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
    return arr[(val % 16)];
  }

  function updateInfoHudUI() {
    // 1. Всегда синхронизируем лучи на карте независимо от состояния инфо-шторки
    updateRays();

    const hud = $('info-hud');
    if (!WM.map) return;

    if (!uiVis.infomenu) {
      if (hud) hud.hidden = true;
      return;
    } else if (hud) {
      hud.hidden = false;
      hud.classList.toggle('no-zoom-buttons', !uiVis.zoom);
    }

    const isCollapsed = hud ? hud.classList.contains('collapsed') : true;
    const content = $('info-hud-content');
    
    // Если панель свёрнута — текстовый контент не генерируем
    if (isCollapsed) return;

    const map = WM.map;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const now = new Date();
    const gpsData = WM.gpsState || null;
    const refLat = center.lat;
    const refLng = center.lng;

    let html = '';

    // 1. Время и дата
    if (infoHudConfig.time) {
      const dateStr = now.toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'short' });
      const timeStr = now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      html += `
        <div class="ih-section">
          <div class="ih-row main-time">
            <span class="ih-val-large">${timeStr}</span>
            <span class="ih-sub">${dateStr}</span>
          </div>
        </div>
      `;
    }

    // 2. Центр экрана
    if (infoHudConfig.centerCoords) {
      html += `
        <div class="ih-section">
          <div class="ih-row">
            <span class="ih-lbl">🎯 Центр:</span>
            <span class="ih-val">${center.lat.toFixed(5)}°, ${center.lng.toFixed(5)}°</span>
          </div>
          <div class="ih-row">
            <span class="ih-lbl">🔍 Зум:</span>
            <span class="ih-val">${zoom.toFixed(1)}</span>
          </div>
        </div>
      `;
    }

    // 3. Текущие координаты GPS
    if (infoHudConfig.userCoords) {
      if (gpsData && gpsData.lat != null) {
        html += `
          <div class="ih-section">
            <div class="ih-row">
              <span class="ih-lbl">🛰️ GPS:</span>
              <span class="ih-val">${gpsData.lat.toFixed(5)}°, ${gpsData.lng.toFixed(5)}°</span>
            </div>
            ${gpsData.accuracy ? `<div class="ih-row"><span class="ih-lbl">🎯 Точность:</span><span class="ih-val">±${Math.round(gpsData.accuracy)} м</span></div>` : ''}
          </div>
        `;
      } else {
        html += `
          <div class="ih-section">
            <div class="ih-row"><span class="ih-lbl">🛰️ GPS:</span><span class="ih-val muted-val">Ожидание спутников…</span></div>
          </div>
        `;
      }
    }

    // 4. Дополнительные данные GPS (скорость, курс, высота)
    if (infoHudConfig.gps && gpsData) {
      const spdKmh = (gpsData.speed != null && gpsData.speed >= 0) ? (gpsData.speed * 3.6).toFixed(1) + ' км/ч' : '0 км/ч';
      const altM = gpsData.altitude != null ? Math.round(gpsData.altitude) + ' м' : null;
      const headDeg = gpsData.heading != null && !isNaN(gpsData.heading) ? Math.round(gpsData.heading) + '° (' + degToCompass(gpsData.heading) + ')' : null;

      html += `
        <div class="ih-section">
          <div class="ih-row"><span class="ih-lbl">⚡ Скорость:</span><span class="ih-val">${spdKmh}</span></div>
          ${altM ? `<div class="ih-row"><span class="ih-lbl">⛰️ Высота:</span><span class="ih-val">${altM}</span></div>` : ''}
          ${headDeg ? `<div class="ih-row"><span class="ih-lbl">🧭 Курс:</span><span class="ih-val">${headDeg}</span></div>` : ''}
        </div>
      `;
    }

    // Запуск фоновой подгрузки погоды, если включена
    if (infoHudConfig.weather && hudSpoilersState.weather) {
      loadWeatherIfNeeded(refLat, refLng);
    }

    // 5. Солнце, Луна и Погода
    const hasAstroItems = (window.SunCalc && (infoHudConfig.sun || infoHudConfig.moon || infoHudConfig.rays)) || infoHudConfig.weather;

    if (hasAstroItems) {
      const astroDate = new Date(now);
      astroDate.setDate(astroDate.getDate() + infoAstroDayOffset);

      let dayTitle = 'Сегодня';
      if (infoAstroDayOffset === 1) dayTitle = 'Завтра';
      else if (infoAstroDayOffset === -1) dayTitle = 'Вчера';
      else if (infoAstroDayOffset > 1) dayTitle = `+${infoAstroDayOffset} дн.`;
      else if (infoAstroDayOffset < -1) dayTitle = `${infoAstroDayOffset} дн.`;

      const dateFormatted = astroDate.toLocaleDateString('ru', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });

      html += `
        <div class="ih-section ih-astro-ctrl">
          <div class="ih-astro-bar">
            <button type="button" class="ih-astro-arrow" data-astro-action="prev" ${infoAstroDayOffset <= -3 ? 'disabled' : ''} title="Предыдущий день (до -3 дн)">◀</button>
            <div class="ih-astro-date-wrap">
              <span class="ih-astro-day-tag ${infoAstroDayOffset !== 0 ? 'offset' : ''}">${dayTitle}</span>
              <span class="ih-astro-date">${dateFormatted}</span>
              ${infoAstroDayOffset !== 0 ? `<button type="button" class="ih-astro-reset" data-astro-action="reset" title="Вернуться к сегодня">↺ Сегодня</button>` : ''}
            </div>
            <button type="button" class="ih-astro-arrow" data-astro-action="next" ${infoAstroDayOffset >= 7 ? 'disabled' : ''} title="Следующий день (до +7 дн)">▶</button>
          </div>
        </div>
      `;

      html += `<div class="ih-astro-swipe-area">`;

      // --- СПОЙЛЕР: СОЛНЦЕ (по умолчанию открыт) ---
      if (infoHudConfig.sun && window.SunCalc) {
        const sTimes = SunCalc.getTimes(astroDate, refLat, refLng);
        const sunPos = SunCalc.getPosition(astroDate, refLat, refLng); // <-- ДОБАВЛЕНО const
        const sunAzDeg = ((sunPos.azimuth * 180 / Math.PI + 180) % 360);
        const sunAltDeg = (sunPos.altitude * 180 / Math.PI).toFixed(1);

        html += `
          <details class="ih-spoiler ih-astro-section" data-spoiler="sun" ${hudSpoilersState.sun ? 'open' : ''}>
            <summary class="ih-spoiler-summary">
              <span>☀️ Солнце (${sunAltDeg > 0 ? '+' + sunAltDeg : sunAltDeg}°)</span>
              <span class="ih-chevron">▼</span>
            </summary>
            <div class="ih-spoiler-body ih-grid-2">
              <div>🌅 Восход: <b>${fmtTime(sTimes.sunrise)}</b></div>
              <div>🌇 Закат: <b>${fmtTime(sTimes.sunset)}</b></div>
              <div>☀️ Полдень: <b>${fmtTime(sTimes.solarNoon)}</b></div>
              <div>✨ Зол час: <b>${fmtTime(sTimes.goldenHour)}</b></div>
              <div>🌆 Сумерки: <b>${fmtTime(sTimes.dusk)}</b></div>
              <div>🧭 Азимут: <b>${Math.round(sunAzDeg)}° (${degToCompass(sunAzDeg)})</b></div>
            </div>
          </details>
        `;
      }

      // --- СПОЙЛЕР: ЛУНА (по умолчанию открыт) ---
      if (infoHudConfig.moon && window.SunCalc) {
        const moonIllum = SunCalc.getMoonIllumination(astroDate);
        const moonTimes = SunCalc.getMoonTimes(astroDate, refLat, refLng);
        const moonPos = SunCalc.getMoonPosition(astroDate, refLat, refLng); // <-- ДОБАВЛЕНО const
        const moonAzDeg = ((moonPos.azimuth * 180 / Math.PI + 180) % 360);
        const moonAltDeg = (moonPos.altitude * 180 / Math.PI).toFixed(1);
        const phase = getMoonPhaseInfo(moonIllum.phase);
        const pct = Math.round(moonIllum.fraction * 100);

        html += `
          <details class="ih-spoiler ih-astro-section" data-spoiler="moon" ${hudSpoilersState.moon ? 'open' : ''}>
            <summary class="ih-spoiler-summary">
              <span>🌙 Луна (${phase.icon} ${pct}%)</span>
              <span class="ih-chevron">▼</span>
            </summary>
            <div class="ih-spoiler-body">
              <div class="ih-row" style="margin-bottom: 3px;"><span class="ih-lbl">Фаза:</span><span class="ih-val">${phase.name}</span></div>
              <div class="ih-grid-2">
                <div>Восход: <b>${moonTimes.rise ? fmtTime(moonTimes.rise) : '--:--'}</b></div>
                <div>Заход: <b>${moonTimes.set ? fmtTime(moonTimes.set) : '--:--'}</b></div>
                <div>Высота: <b>${moonAltDeg}°</b></div>
                <div>Азимут: <b>${Math.round(moonAzDeg)}° (${degToCompass(moonAzDeg)})</b></div>
              </div>
            </div>
          </details>
        `;
      }

      // --- СПОЙЛЕР: ПОГОДА (по умолчанию скрыт) ---
      if (infoHudConfig.weather) {
        const wData = getWeatherForDate(astroDate);
        const headerSummary = wData
          ? `${wData.weatherIcon} Погода (${wData.day ? wData.day.temp : '--'})`
          : '🌦️ Погода (загрузка…)';

        // Показываем вложенный почасовой спойлер только для Сегодня (0) и Завтра (1)
        const isTodayOrTomorrow = (infoAstroDayOffset === 0 || infoAstroDayOffset === 1);
        const currentHour = now.getHours();

        let hourlyHtml = '';
        if (isTodayOrTomorrow && wData && wData.hourlyList && wData.hourlyList.length) {
          const cardsHtml = wData.hourlyList.map(hItem => {
            const isCurrent = (infoAstroDayOffset === 0 && hItem.hour === currentHour);
            const isPast = (infoAstroDayOffset === 0 && hItem.hour < currentHour);
            const timeLabel = isCurrent ? 'Сейчас' : hItem.timeStr;
            const precipLabel = hItem.precip ? `<span class="ih-hourly-precip">💧${hItem.precip}</span>` : '';
            return `
              <div class="ih-hourly-card ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}">
                <span class="ih-hourly-time">${timeLabel}</span>
                <span class="ih-hourly-icon">${hItem.icon}</span>
                <span class="ih-hourly-temp">${hItem.temp}</span>
                ${precipLabel}
              </div>
            `;
          }).join('');

          hourlyHtml = `
            <details class="ih-spoiler ih-hourly-spoiler" data-spoiler="weatherHourly" ${hudSpoilersState.weatherHourly ? 'open' : ''}>
              <summary class="ih-spoiler-summary" style="margin-top: 5px; padding: 3px 0; border-top: 1px dashed var(--border);">
                <span>⏱️ Почасовой (${wData.hourlyList.length} ч)</span>
                <span class="ih-chevron">▼</span>
              </summary>
              <div class="ih-spoiler-body" style="padding-top: 3px;">
                <div class="ih-hourly-scroll">
                  ${cardsHtml}
                </div>
              </div>
            </details>
          `;
        }

        html += `
          <details class="ih-spoiler ih-astro-section" data-spoiler="weather" ${hudSpoilersState.weather ? 'open' : ''}>
            <summary class="ih-spoiler-summary">
              <span>${headerSummary}</span>
              <span class="ih-chevron">▼</span>
            </summary>
            <div class="ih-spoiler-body">
              ${wData ? `
                <div class="ih-weather-grid">
                  <div class="ih-weather-cell">
                    <span class="ih-weather-time">Утро</span>
                    <span class="ih-weather-icon">${wData.morning ? wData.morning.icon : '⛅'}</span>
                    <span class="ih-weather-temp">${wData.morning ? wData.morning.temp : '--'}</span>
                  </div>
                  <div class="ih-weather-cell">
                    <span class="ih-weather-time">День</span>
                    <span class="ih-weather-icon">${wData.day ? wData.day.icon : '☀️'}</span>
                    <span class="ih-weather-temp">${wData.day ? wData.day.temp : '--'}</span>
                  </div>
                  <div class="ih-weather-cell">
                    <span class="ih-weather-time">Вечер</span>
                    <span class="ih-weather-icon">${wData.evening ? wData.evening.icon : '🌤️'}</span>
                    <span class="ih-weather-temp">${wData.evening ? wData.evening.temp : '--'}</span>
                  </div>
                  <div class="ih-weather-cell">
                    <span class="ih-weather-time">Ночь</span>
                    <span class="ih-weather-icon">${wData.night ? wData.night.icon : '🌙'}</span>
                    <span class="ih-weather-temp">${wData.night ? wData.night.temp : '--'}</span>
                  </div>
                </div>
                <div class="ih-weather-desc">
                  <div>${wData.precipSum > 0 ? `💧 Осадки: <b>${wData.precipSum.toFixed(1)} мм</b>` : '💧 Без осадков'}</div>
                  <div style="color: var(--text-muted); margin-top: 1px;">${wData.weatherDesc}</div>
                </div>
                ${hourlyHtml}
              ` : `
                <div class="muted-val" style="padding: 4px 0; font-size: 10px; color: var(--text-muted);">
                  ${isWeatherLoading ? '⏳ Загрузка прогноза Open-Meteo…' : 'Ожидание сети…'}
                </div>
              `}
            </div>
          </details>
        `;
      }

      html += `</div>`; // ih-astro-swipe-area
    }

    if (!isCollapsed) {
      // Сохраняем положение прокрутки почасовых карточек перед обновлением DOM
      const prevScrollEl = content.querySelector('.ih-hourly-scroll');
      const prevScrollPos = prevScrollEl ? prevScrollEl.scrollLeft : null;

      content.innerHTML = html;

      // Восстанавливаем позицию прокрутки или центрируем на текущем часе
      const newScrollEl = content.querySelector('.ih-hourly-scroll');
      if (newScrollEl) {
        if (prevScrollPos !== null) {
          newScrollEl.scrollLeft = prevScrollPos;
        } else if (infoAstroDayOffset === 0) {
          const curCard = newScrollEl.querySelector('.ih-hourly-card.current');
          if (curCard) {
            newScrollEl.scrollLeft = Math.max(0, curCard.offsetLeft - 12);
          }
        }
      }
    }
  }




  let workMode = WM.api.store.get('wm_work_mode') || 'hybrid';
  let autoHoverEnabled = WM.api.store.get('wm_auto_hover') === 'true';
  let autoDetailsEnabled = WM.api.store.get('wm_auto_details') !== 'false';
  // По умолчанию включено (true)
  let autoDetailsCrosshairOnly = WM.api.store.get('wm_auto_details_crosshair') !== 'false';

  const DEFAULT_RASTER_STYLE = {
    opacity: 100,
    contrast: 140,
    saturate: 120,
    brightness: 105,
    shadow: true,
    invert: false,
    tintEnabled: true,
    tintColor: '#acd2b1',
    morphRadius: 0
  };

  let rasterStyle = { ...DEFAULT_RASTER_STYLE };
  try {
    const savedR = JSON.parse(WM.api.store.get('wm_style_raster') || '{}');
    rasterStyle = { ...DEFAULT_RASTER_STYLE, ...savedR };
  } catch (e) {}

  function updateAutoDetailsSubVisibility() {
    const chkDetails = $('toggle-auto-details');
    const chkCrosshair = $('toggle-auto-details-crosshair');
    const subWrap = $('sub-auto-details-wrap');
    const warnBulk = $('warn-auto-details-bulk');

    const isDetailsOn = chkDetails ? chkDetails.checked : false;
    const isCrosshairOn = chkCrosshair ? chkCrosshair.checked : true;

    if (subWrap) subWrap.hidden = !isDetailsOn;
    // Предупреждение видно только когда фоновая загрузка включена, а режим перекрестия выключен
    if (warnBulk) warnBulk.hidden = !isDetailsOn || isCrosshairOn;
  }

  function hexToRgbNorm(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255
    };
  }

  function formatMorphLabel(val) {
    if (val === 0) return 'Исходная (0)';
    if (val > 0) return `+${val} px (жирнее)`;
    return `${val} px (тоньше)`;
  }

  function applyRasterCSS(cfg) {
    const root = document.documentElement;
    root.style.setProperty('--wm-rast-opacity', (cfg.opacity / 100).toString());

    // 1. Настройка морфологии (толщины) в SVG
    const radius = Math.abs(cfg.morphRadius || 0);
    const operator = (cfg.morphRadius || 0) < 0 ? 'erode' : 'dilate';

    const morphTint = $('wm-morph-tint');
    const morphStandalone = $('wm-morph-standalone');

    if (morphTint) {
      morphTint.setAttribute('operator', operator);
      morphTint.setAttribute('radius', radius.toString());
    }
    if (morphStandalone) {
      morphStandalone.setAttribute('operator', operator);
      morphStandalone.setAttribute('radius', radius.toString());
    }

    // 2. Сборка цепочки CSS-фильтров
    if (cfg.tintEnabled) {
      const isMorphActive = Math.abs(cfg.morphRadius || 0) > 0.1;
      const filterId = isMorphActive ? 'wm-tint-filter' : 'wm-tint-matrix-only';
      let chain = `url(#${filterId})`;
      
      if (cfg.invert) chain += ' invert(100%)';
      root.style.setProperty('--wm-rast-filter-chain', chain);
    } else {
      let chain = '';
      if (radius > 0) {
        chain += 'url(#wm-morph-filter) ';
      }
      chain += `contrast(${cfg.contrast}%) saturate(${cfg.saturate}%) brightness(${cfg.brightness}%)`;
      if (cfg.invert) chain += ' invert(100%)';
      if (cfg.shadow) chain += ' drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))';
      root.style.setProperty('--wm-rast-filter-chain', chain.trim());
    }
  }


  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else if (k.startsWith('on')) n[k] = props[k];
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected') {
        n[k] = props[k]; // Прямое присвоение свойства (DOM property)
      } else {
        n.setAttribute(k, props[k]);
      }
    }
    kids.flat().forEach(c => c != null && n.append(c));
    return n;
  };

  const safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u.replace(/^http:\/\//i, 'https://') : '';
  const list = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  
  function fmtDate(d) {
    if (!d) return '';
    const ts = (typeof d === 'number' || /^\d{9,}$/.test(d)) ? +d * 1000 : Date.parse(d);
    if (!isNaN(ts)) {
      return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return String(d);
  }
  
  function getCentroidCoords(o) {
    const b = o.bbox;
    return {
      lat: ((b.s + b.n) / 2).toFixed(6),
      lon: ((b.w + b.e) / 2).toFixed(6)
    };
  }

  function showToast(text, duration = 2200) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, duration);
  }

  function fmtTimer(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = n => (n < 10 ? '0' : '') + n;
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function extractWikimapiaKeys(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    let text = rawText.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
    text = text.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');

    const foundKeys = new Set();
    let cleaned = text.replace(/([0-9a-fA-F]{8})\s*-\s*([0-9a-fA-F])/g, '$1-$2');
    cleaned = cleaned.replace(/([0-9a-fA-F]{8})\s*-\s*([0-9a-fA-F])/g, '$1-$2');

    const standardRegex = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){7}/gi;
    const matches = cleaned.match(standardRegex);
    if (matches) {
      for (const m of matches) foundKeys.add(m.toUpperCase().trim());
    }

    const hex64Regex = /\b([0-9a-fA-F]{64})\b/gi;
    let h64;
    while ((h64 = hex64Regex.exec(cleaned)) !== null) {
      const formatted = h64[1].match(/.{8}/g).join('-').toUpperCase();
      foundKeys.add(formatted);
    }

    return Array.from(foundKeys);
  }

  function addDiscoveredKeys(keys) {
    if (!keys || !keys.length) return 0;
    const existingSet = new Set(editingKeys.map(k => k.toUpperCase()));
    const toAdd = keys.filter(k => !existingSet.has(k.toUpperCase()));

    if (!toAdd.length) {
      showToast('Все распознанные ключи уже есть в списке');
      return 0;
    }

    editingKeys = editingKeys.filter(k => k !== 'example');
    editingKeys.push(...toAdd);
    renderKeysUI();
    showToast(`✅ Успешно добавлено ключей: ${toAdd.length}`);
    return toAdd.length;
  }



  let lastNonNightTheme = 'dark';

  function applyTheme(theme) {
    if (theme !== 'night-vision') {
      lastNonNightTheme = theme;
    }

    let statusBarColor = '#ffffff';

    if (theme === 'night-vision') {
      document.documentElement.setAttribute('data-theme', 'night-vision');
      statusBarColor = '#050101';
      $('btn-theme-toggle').textContent = '🔴';
      $('btn-theme-toggle').title = 'Режим ночного зрения (удерживайте для выхода)';
    } else if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      statusBarColor = '#111827';
      $('btn-theme-toggle').textContent = '☀️';
      $('btn-theme-toggle').title = 'Сменить тему (удерживайте для ночного зрения)';
    } else {
      document.documentElement.removeAttribute('data-theme');
      statusBarColor = '#ffffff';
      $('btn-theme-toggle').textContent = '🌙';
      $('btn-theme-toggle').title = 'Сменить тему (удерживайте для ночного зрения)';
    }

    const meta = document.getElementById('theme-color-meta') || document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', statusBarColor);

    WM.api.store.set('wm_theme', theme);

    // Синхронизация радиокнопок в настройках
    const radios = document.querySelectorAll('input[name="app-theme-mode"]');
    radios.forEach(r => { r.checked = (r.value === theme); });

    // <-- ДОБАВИТЬ ЭТУ СТРОКУ: перерисовка круга дальности в цвет темы
    if (WM.rangeRing && WM.rangeRing.refresh) WM.rangeRing.refresh();
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    if (cur === 'night-vision') {
      applyTheme(lastNonNightTheme || 'dark');
      showToast('☀️ Режим ночного зрения отключён');
    } else if (cur === 'dark') {
      applyTheme('light');
    } else {
      applyTheme('dark');
    }
  }

  function toggleNightVision() {
    const cur = document.documentElement.getAttribute('data-theme');
    if (cur === 'night-vision') {
      applyTheme(lastNonNightTheme || 'dark');
      showToast('☀️ Режим ночного зрения отключён');
    } else {
      applyTheme('night-vision');
      showToast('🔴 Режим ночного зрения включён');
    }
  }

// 1. Функция переключения скрытия/показа UI
  function toggleHideUI(forceState) {
    const isCurrentlyHidden = document.body.classList.contains('wm-ui-hidden');
    const nextState = forceState !== undefined ? !!forceState : !isCurrentlyHidden;
    document.body.classList.toggle('wm-ui-hidden', nextState);
    const btn = $('btn-hide-ui');
    if (btn) {
      btn.classList.toggle('active', nextState);
      btn.textContent = nextState ? '🕶️' : '👁️';
      btn.title = nextState ? 'Показать интерфейс' : 'Скрыть интерфейс';
    }
    updateBottomLeftButtonsStack();
    showToast(nextState ? '🕶️ Интерфейс скрыт (нажмите кнопку для возврата)' : '👁️ Интерфейс отображён');
  }

  // 2. Функция расчёта порядка кнопок в левом нижнем углу
  function updateBottomLeftButtonsStack() {
    const btnQuickMenu = $('btn-quick-menu');
    const btnQuickSwap = $('btn-quick-swap-map');
    const btnHideUI = $('btn-hide-ui');

    // Кнопка меню активна, если включена в настройках и не скрыта
    const isMenuVisible = btnQuickMenu && 
      !btnQuickMenu.hidden && 
      !!(quickMenuConfig && quickMenuConfig.enabled && quickMenuConfig.triggers && quickMenuConfig.triggers.btn);

    // Кнопка смены карт активна в левом нижнем углу, если включена и настроена на эту позицию
    const isSwapInBottomLeft = btnQuickSwap && 
      !btnQuickSwap.hidden && 
      localStorage.getItem('wm_quick_swap_enabled') !== 'false' &&
      localStorage.getItem('wm_quick_swap_pos') === 'bottom-left';

    if (btnQuickSwap && isSwapInBottomLeft) {
      btnQuickSwap.classList.toggle('stacked-above-menu', !!isMenuVisible);
    }

    if (btnHideUI) {
      let stackLevel = 0;
      if (isMenuVisible) stackLevel++;
      if (isSwapInBottomLeft) stackLevel++;

      btnHideUI.classList.remove('stack-level-1', 'stack-level-2');
      if (stackLevel === 1) {
        btnHideUI.classList.add('stack-level-1');
      } else if (stackLevel >= 2) {
        btnHideUI.classList.add('stack-level-2');
      }
    }
  }
  window.updateBottomLeftButtonsStack = updateBottomLeftButtonsStack;



  function applyUIVisibility() {
    // ЗАМЕНИЛИ ПЕРВУЮ СТРОЧКУ НА ЭТОТ БЛОК:
    const isVectors = WM.view && WM.view.isVisible ? WM.view.isVisible() : true;
    const statusEl = $('status');
    if (statusEl) {
      statusEl.style.display = (uiVis.status && isVectors && statusEl.textContent) ? '' : 'none';
    }

    // ДАЛЬШЕ ВСЁ ОСТАЁТСЯ КАК БЫЛО:
    const limitRow = $('limit-row');
    if (limitRow) limitRow.style.display = uiVis.limit ? '' : 'none';
    if (!uiVis.pill) $('hover-pill').hidden = true;

    const hud = $('info-hud');
    if (hud) hud.hidden = !uiVis.infomenu;
    updateInfoHudUI();
    if (WM.motionTail) {
      WM.motionTail.setEnabled(uiVis.motiontail !== false);
    }

    // --- ОБНОВЛЕНО: гарантированное мгновенное переключение без перезагрузки ---
    const btnHideUI = $('btn-hide-ui');
    if (btnHideUI) {
      btnHideUI.hidden = !uiVis.hideuibtn;
      btnHideUI.style.display = uiVis.hideuibtn ? 'flex' : 'none';
    }
    updateBottomLeftButtonsStack();

    if (WM.rangeRing) {
      WM.rangeRing.setEnabled(!!uiVis.rangering);
    }

    if (WM.motionVector) WM.motionVector.setEnabled(!!uiVis.motionvector);

    const btnCompass = $('btn-compass');
    if (btnCompass) {
      btnCompass.hidden = !uiVis.compassneedle;
      btnCompass.style.display = uiVis.compassneedle ? '' : 'none';
    }
    if (WM.compass && WM.compass.updateSettings) {
      WM.compass.updateSettings(uiVis.compasscone, uiVis.compassneedle);
    }

    const zoomControl = document.querySelector('.leaflet-control-zoom');
    if (zoomControl) zoomControl.style.display = uiVis.zoom ? '' : 'none';

    const layersControl = document.querySelector('.leaflet-control-layers');
    if (layersControl) layersControl.style.display = uiVis.layers ? '' : 'none';

    if ($('btn-quick-measure')) $('btn-quick-measure').style.display = uiVis.quickmeasure ? '' : 'none';


    if ($('btn-search')) $('btn-search').style.display = uiVis.search ? '' : 'none';
    if ($('btn-mode-toggle')) $('btn-mode-toggle').style.display = uiVis.mode ? '' : 'none';
    if ($('btn-measure')) $('btn-measure').style.display = uiVis.measure ? '' : 'none';
    if ($('btn-add-marker')) $('btn-add-marker').style.display = uiVis.marker ? '' : 'none';
    if ($('btn-download-area')) $('btn-download-area').style.display = uiVis.precache ? '' : 'none';
    if ($('btn-location')) $('btn-location').style.display = uiVis.location ? '' : 'none';
    if ($('btn-motion-toggle')) $('btn-motion-toggle').style.display = uiVis.motion ? '' : 'none'; // <-- Добавлено
    if ($('btn-manual-pdr')) $('btn-manual-pdr').style.display = uiVis.manualpdr ? '' : 'none'; // <-- Добавлено
    if ($('btn-gps-dist')) $('btn-gps-dist').style.display = uiVis.gpsdist ? '' : 'none';
    if ($('btn-rays-toggle')) $('btn-rays-toggle').style.display = uiVis.rays ? '' : 'none';
    if ($('btn-theme-toggle')) $('btn-theme-toggle').style.display = uiVis.theme ? '' : 'none';
    if ($('btn-track-record')) $('btn-track-record').style.display = uiVis.trackrecord !== false ? '' : 'none';

    WM.api.store.set('wm_ui_vis', JSON.stringify(uiVis));
  }


  // =========================================================================
  // БЫСТРЫЕ НАСТРОЙКИ PDR И РЕЖИМА БЕЗ GPS ПО ДОЛГОМУ НАЖАТИЮ
  // =========================================================================
  let pdrQuickTestSteps = 0;
  let pdrQuickTestDist = 0;
  let pdrQuickFlashTimer = null;
  let wasPdrRunningBeforeQuickModal = false;

  function updatePdrQuickModalMetrics() {
    const elSteps = $('pdr-quick-step-count');
    const elDist = $('pdr-quick-dist-val');
    if (elSteps) elSteps.textContent = pdrQuickTestSteps;
    if (elDist) elDist.textContent = (pdrQuickTestDist < 1000) 
      ? pdrQuickTestDist.toFixed(1) + ' м' 
      : (pdrQuickTestDist / 1000).toFixed(2) + ' км';
  }

  function handlePdrQuickStepEvent(e) {
    const d = e.detail;
    pdrQuickTestSteps++;
    const stride = d ? d.strideMeters : (WM.pdr ? WM.pdr.getConfig().baseStepLength : 0.75);
    pdrQuickTestDist += stride;
    updatePdrQuickModalMetrics();

    const flash = $('pdr-quick-step-flash');
    if (flash) {
      flash.classList.add('active');
      clearTimeout(pdrQuickFlashTimer);
      pdrQuickFlashTimer = setTimeout(() => flash.classList.remove('active'), 250);
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(25); } catch (err) {}
    }
  }

  function openPdrQuickModal() {
    const modal = $('modal-pdr-quick');
    if (!modal) return;

    pdrQuickTestSteps = 0;
    pdrQuickTestDist = 0;
    updatePdrQuickModalMetrics();

    const cfg = WM.pdr ? WM.pdr.getConfig() : {};

    const curMov = cfg.movementType || 'normal';
    document.querySelectorAll('#pdr-quick-movement-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mov === curMov);
    });
    updatePdrQuickMovHint(curMov);

    // 1. Длина шага
    const curStepCm = Math.round((cfg.baseStepLength || 0.75) * 100);
    const sliderStep = $('pdr-quick-step-slider');
    const valStep = $('pdr-quick-step-length-val');
    if (sliderStep) sliderStep.value = curStepCm;
    if (valStep) valStep.textContent = curStepCm + ' см';

    const quickChk = $('pdr-quick-toggle-step-pill');
    if (quickChk) {
      quickChk.checked = localStorage.getItem('wm_pdr_step_pill') === 'true';
    }

    document.querySelectorAll('.pdr-quick-chip').forEach(ch => {
      ch.classList.toggle('active', parseInt(ch.dataset.step, 10) === curStepCm);
    });

    // 2. В руке / В кармане
    const curMode = cfg.carryingMode || 'hand';
    document.querySelectorAll('#pdr-quick-carrying-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === curMode);
    });

    // 3. Чувствительность
    const curSens = cfg.sensitivity || 'normal';
    document.querySelectorAll('#pdr-quick-sensitivity-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sens === curSens);
    });
    updatePdrQuickSensHint(curSens);

    // Запускаем временное слушание шагов для интерактивного теста
    window.addEventListener('wm:pdr-step', handlePdrQuickStepEvent);

    wasPdrRunningBeforeQuickModal = WM.pdr ? WM.pdr.isActive() : false;
    if (WM.pdr && !wasPdrRunningBeforeQuickModal) {
      WM.pdr.start();
    }

    modal.classList.add('open');
    pushHistoryState('pdrQuick');
  }

  function closePdrQuickModal() {
    const modal = $('modal-pdr-quick');
    if (modal) modal.classList.remove('open');

    window.removeEventListener('wm:pdr-step', handlePdrQuickStepEvent);

    if (WM.pdr && !wasPdrRunningBeforeQuickModal && !WM.manualPdr.isActive() && !WM.antiSpoof.isSpoofed()) {
      WM.pdr.stop();
    }

    clearHistoryState('pdrQuick');
  }
  window.closePdrQuickModal = closePdrQuickModal;
  window.openPdrQuickModal = openPdrQuickModal;

  function updatePdrQuickSensHint(sens) {
    const hint = $('pdr-quick-sens-hint');
    if (!hint) return;
    if (sens === 'high') {
      hint.textContent = 'Высокая: для мягкой обуви, шагов по снегу, песку и тихого шага.';
    } else if (sens === 'low') {
      hint.textContent = 'Низкая: для плотных берцев, бега, марша и подавления сильной тряски.';
    } else {
      hint.textContent = 'Обычная: для кроссовок и стандартной городской/лесной ходьбы.';
    }
  }

  function updatePdrQuickMovHint(mode) {
    const hint = $('pdr-quick-mov-hint');
    if (!hint) return;
    if (mode === 'straight') {
      hint.textContent = '🌲 По прямой: держит азимут! Игнорирует виляние при обходе деревьев. Поворот только при 8 четких шагах в новую сторону.';
    } else if (mode === 'chaotic') {
      hint.textContent = '🔄 Маневры: мгновенный отклик на повороты (1-2 шага). Для поиска предметов, копа, петляющих троп.';
    } else {
      hint.textContent = '🚶 Обычный: баланс между фильтрацией покачиваний и фиксацией реальных поворотов.';
    }
  }

  function initPdrQuickModal() {
    const modal = $('modal-pdr-quick');
    if (!modal || modal._inited) return;
    modal._inited = true;

    $('pdr-quick-close-x')?.addEventListener('click', closePdrQuickModal);
    $('btn-pdr-quick-close')?.addEventListener('click', closePdrQuickModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePdrQuickModal();
    });

    // Сброс счетчика теста
    $('btn-pdr-quick-reset-test')?.addEventListener('click', () => {
      pdrQuickTestSteps = 0;
      pdrQuickTestDist = 0;
      updatePdrQuickModalMetrics();
    });

    // Мастер 3 точек
    $('btn-pdr-quick-open-tri')?.addEventListener('click', () => {
      closePdrQuickModal();
      $('btn-open-triangle-calib')?.click();
    });

    $('pdr-quick-toggle-step-pill')?.addEventListener('change', (e) => {
      const val = e.target.checked;
      localStorage.setItem('wm_pdr_step_pill', val ? 'true' : 'false');
      const mainChk = $('toggle-pdr-step-pill');
      if (mainChk) mainChk.checked = val;
      if (window.WM && WM.setPdrStepPillEnabled) WM.setPdrStepPillEnabled(val);
      showToast(val ? '👣 Плашка шагов PDR включена' : '👣 Плашка шагов PDR выключена');
    });

    // Юстировка компаса
    $('btn-pdr-quick-open-compass')?.addEventListener('click', () => {
      closePdrQuickModal();
      if (window.openCompassAdjustModal) window.openCompassAdjustModal();
    });

    // Сегмент: Характер движения (Обычный / По прямой / Маневры)
    document.querySelectorAll('#pdr-quick-movement-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pdr-quick-movement-segmented .pdr-quick-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mov = btn.dataset.mov;
        if (WM.pdr) WM.pdr.setConfig({ movementType: mov });
        const mainMov = $('pdr-movement-type-select');
        if (mainMov) mainMov.value = mov;
        updatePdrQuickMovHint(mov);

        const titles = {
          straight: '🌲 Включён азимут «По прямой» (выход из леса)',
          chaotic: '🔄 Включён «Маневренный» режим (быстрые повороты)',
          normal: '🚶 Включён «Обычный» режим движения'
        };
        showToast(titles[mov] || 'Режим обновлён');
      });
    });

    // Ползунок шага
    const sliderStep = $('pdr-quick-step-slider');
    const valStep = $('pdr-quick-step-length-val');
    const applyStep = (cm) => {
      if (sliderStep) sliderStep.value = cm;
      if (valStep) valStep.textContent = cm + ' см';
      document.querySelectorAll('.pdr-quick-chip').forEach(ch => {
        ch.classList.toggle('active', parseInt(ch.dataset.step, 10) === cm);
      });
      if (WM.pdr) WM.pdr.setConfig({ baseStepLength: cm / 100 });
      // Синхронизируем главный слайдер в общих настройках
      const mainStepSlider = $('pdr-step-length-slider');
      const mainStepVal = $('pdr-step-length-val');
      if (mainStepSlider) mainStepSlider.value = cm;
      if (mainStepVal) mainStepVal.textContent = cm + ' см';
    };

    if (sliderStep) {
      sliderStep.addEventListener('input', (e) => {
        applyStep(parseInt(e.target.value, 10));
      });
    }

    $('btn-pdr-quick-step-minus')?.addEventListener('click', () => {
      const cur = parseInt(sliderStep.value, 10) || 75;
      applyStep(Math.max(40, cur - 5));
    });

    $('btn-pdr-quick-step-plus')?.addEventListener('click', () => {
      const cur = parseInt(sliderStep.value, 10) || 75;
      applyStep(Math.min(130, cur + 5));
    });

    document.querySelectorAll('.pdr-quick-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        applyStep(parseInt(ch.dataset.step, 10));
      });
    });

    // Сегмент: В руке / В кармане
    document.querySelectorAll('#pdr-quick-carrying-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pdr-quick-carrying-segmented .pdr-quick-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        if (WM.pdr) WM.pdr.setConfig({ carryingMode: mode });
        const mainCarry = $('pdr-carrying-mode');
        if (mainCarry) mainCarry.value = mode;
        showToast(mode === 'pocket' ? '👖 Режим: В кармане (фильтрация маятника)' : '✋ Режим: В руке');
      });
    });

    // Сегмент: Чувствительность
    document.querySelectorAll('#pdr-quick-sensitivity-segmented .pdr-quick-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pdr-quick-sensitivity-segmented .pdr-quick-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const sens = btn.dataset.sens;
        if (WM.pdr) WM.pdr.setConfig({ sensitivity: sens });
        const mainSens = $('pdr-sensitivity-select');
        if (mainSens) mainSens.value = sens;
        updatePdrQuickSensHint(sens);
        showToast(`🎯 Чувствительность: ${btn.textContent.trim()}`);
      });
    });
  }

  function updateRaysBtnState() {
    const btn = $('btn-rays-toggle');
    if (btn) {
      btn.classList.toggle('active', !!infoHudConfig.rays);
    }
  }

  function toggleTopGetKeyBtn(forceShowBlocked = false) {
    const btn = $('btn-get-key-top');
    if (!btn) return;

    if (!uiVis.limit) {
      btn.hidden = true;
      return;
    }

    btn.classList.remove('warning-banner');

    const pool = WM.api.getPoolStatus();
    // Показываем плашку только если реально наступила блокировка/пауза по лимитам
    if (forceShowBlocked || pool.allBlocked) {
      btn.hidden = false;
      btn.innerHTML = '🔑 Лимит исчерпан · <u>Добавить ключ</u>';
    } else {
      btn.hidden = true;
    }
  }

  function updateSizeFilterTogglesState() {
    const isAuto = $('toggle-filter-auto-size') ? $('toggle-filter-auto-size').checked : true;
    const smallChk = $('toggle-filter-hide-small');
    const medChk = $('toggle-filter-hide-medium');
    const largeChk = $('toggle-filter-hide-large');
    const wrap = $('manual-size-filters-wrap');

    [smallChk, medChk, largeChk].forEach(chk => {
      if (chk) {
        chk.disabled = isAuto;
        const item = chk.closest('.toggle-item');
        if (item) {
          item.style.opacity = isAuto ? '0.45' : '1';
          item.style.pointerEvents = isAuto ? 'none' : 'auto';
        }
      }
    });

    if (wrap) {
      wrap.style.opacity = isAuto ? '0.45' : '1';
    }
  }

  function updateLimitHUD() {
    const badge = $('limit-badge');
    if (!badge) return;
    if (!uiVis.limit) {
      badge.hidden = true;
      return;
    }

    const pool = WM.api.getPoolStatus();
    let newText = '';
    let isDanger = false;
    let hasProblem = false;

    if (pool.allBlocked) {
      newText = `⏳ Пауза API: ${Math.ceil(pool.waitMs / 1000)} сек.`;
      isDanger = true;
      hasProblem = true;
      toggleTopGetKeyBtn(true);
    } else if (pool.isMaster) {
      // Безлимитный режим — проблем нет, плашку скрываем
      hasProblem = false;
      newText = '';
      toggleTopGetKeyBtn(false);
    } else {
      const stats = WM.api.getKeyStats(pool.key);
      if (stats.isBlocked) {
        newText = `⏳ Ключ заблокирован: ${Math.ceil(stats.waitMs / 1000)} с`;
        isDanger = true;
        hasProblem = true;
      } else if (stats.remaining <= 10) {
        newText = `⚠️ Лимит: ${stats.remaining}/${stats.limit}`;
        isDanger = true;
        hasProblem = true;
      } else {
        hasProblem = false;
        newText = '';
      }
      toggleTopGetKeyBtn(false);
    }

    if (hasProblem && newText) {
      badge.hidden = false;
      if (badge.textContent !== newText) {
        badge.textContent = newText;
      }
      badge.classList.toggle('danger', isDanger);
    } else {
      badge.hidden = true;
      badge.textContent = '';
      badge.classList.remove('danger');
    }
  }

  function renderKeysUI() {
    const container = $('keys-list');
    container.textContent = '';
    $('keys-count').textContent = editingKeys.length;

    // Если список пуст — показываем, что активен встроенный мастер-ключ
    if (editingKeys.length === 0) {
      container.append(
        el('div', { 
          class: 'muted', 
          style: 'padding: 12px; font-size: 12px;', 
          text: 'Свои ключи не добавлены (используется встроенный безлимитный ключ)' 
        })
      );
      return;
    }

    editingKeys.forEach((k, idx) => {
      const stats = WM.api.getKeyStats(k);
      const isActive = idx === editingActiveIndex;

      let statText = `${stats.used}/100 за сутки`;
      if (stats.isBlocked) statText = `Блок (до сброса ${fmtTimer(stats.waitMs)})`;

      const row = el('div', { class: 'key-item' + (isActive ? ' active' : '') },
        el('div', {
          class: 'key-info',
          onclick: () => {
            editingActiveIndex = idx;
            renderKeysUI();
          }
        },
          el('span', { class: 'key-val', text: (isActive ? '● ' : '') + k }),
          el('span', { class: 'key-stats' + (stats.isBlocked ? ' warn' : ''), text: statText })
        ),
        el('div', { class: 'key-item-actions' },
          el('button', {
            class: 'key-action-btn',
            title: 'Редактировать ключ',
            text: '✏️',
            onclick: (e) => {
              e.stopPropagation();
              const updated = prompt('Редактирование API ключа:', k);
              if (updated !== null && updated.trim()) {
                editingKeys[idx] = updated.trim().toUpperCase();
                renderKeysUI();
              }
            }
          }),
          el('button', {
            class: 'key-action-btn',
            title: 'Удалить ключ',
            text: '✕',
            style: 'color:var(--danger);',
            onclick: (e) => {
              e.stopPropagation();
              // ТЕПЕРЬ МОЖНО УДАЛИТЬ ЛЮБОЙ КЛЮЧ, ВКЛЮЧАЯ ПОСЛЕДНИЙ
              editingKeys.splice(idx, 1);
              if (editingActiveIndex >= editingKeys.length) {
                editingActiveIndex = Math.max(0, editingKeys.length - 1);
              }
              renderKeysUI();
            }
          })
        )
      );
      container.append(row);
    });
  }

  function openKeysSettings() {
    $('btn-settings').click();
    const spoiler = $('spoiler-keys');
    if (spoiler) {
      spoiler.open = true;
      setTimeout(() => {
        spoiler.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const input = $('new-key-input');
        if (input) input.focus();
      }, 150);
    }
  }

  // Извлечение всех доступных языков из availableLanguages объекта Wikimapia
  function extractAvailableLanguages(detail, selectedLang = 'ru') {
    const res = new Map();

    const addLang = (iso, nativeName, langName, slug, url) => {
      if (!iso) return;
      const lower = String(iso).toLowerCase();
      const flag = LANG_FLAGS[lower] || '🌐';
      const label = nativeName || langName || lower.toUpperCase();
      res.set(lower, {
        iso: lower,
        name: `${flag} ${label}`,
        rawName: label,
        slug: slug || '',
        url: url || ''
      });
    };

    // Всегда базово гарантируем русский язык
    addLang('ru', 'Русский', 'Russian');

    if (detail) {
      if (detail.language_iso) {
        addLang(detail.language_iso, detail.native_name, detail.language_name);
      }

      const rawLangs = detail.availableLanguages || detail.available_languages || detail.translate;
      if (rawLangs && typeof rawLangs === 'object') {
        const entries = Array.isArray(rawLangs)
          ? rawLangs.map(v => [v && (v.language_iso || v.iso || v.shortcut), v])
          : Object.entries(rawLangs);

        for (const [key, item] of entries) {
          if (!item && !key) continue;
          let iso = key;
          let nativeName = '';
          let langName = '';
          let slug = '';
          let url = '';

          if (item && typeof item === 'object') {
            iso = item.language_iso || item.shortcut || item.iso || key;
            nativeName = item.native_name || '';
            langName = item.lang_name || item.language_name || item.name || '';
            slug = item.object_local_slug || '';
            url = item.object_url || '';
          } else if (typeof item === 'string') {
            langName = item;
          }

          if (iso) {
            addLang(iso, nativeName, langName, slug, url);
          }
        }
      }
    }

    if (selectedLang && !res.has(selectedLang.toLowerCase())) {
      addLang(selectedLang, null, selectedLang.toUpperCase());
    }

    // Умная сортировка: активный язык и RU первыми, затем EN, остальные по алфавиту
    const curIso = (selectedLang || 'ru').toLowerCase();
    const sorted = Array.from(res.values()).sort((a, b) => {
      if (a.iso === curIso) return -1;
      if (b.iso === curIso) return 1;
      if (a.iso === 'ru') return -1;
      if (b.iso === 'ru') return 1;
      if (a.iso === 'en') return -1;
      if (b.iso === 'en') return 1;
      return a.rawName.localeCompare(b.rawName);
    });

    return sorted;
  }

  function renderLangsUI() {
    const container = $('sheet-langs');
    if (!container) return;
    container.textContent = '';
    if (!cur) return;

    const curIso = (cur.lang || (cur.detail && cur.detail.language_iso) || 'ru').toLowerCase();
    const langs = (cur.availableLanguages && cur.availableLanguages.length)
      ? cur.availableLanguages
      : extractAvailableLanguages(cur.detail, curIso);

    // Если доступен только 1 язык (или вообще нет переводов), скрываем блок
    if (langs.length <= 1 && !cur.loadingLang) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';

    langs.forEach(l => {
      const isAct = l.iso === curIso;
      const isLoading = cur.loadingLang === l.iso;
      const chip = el('button', {
        class: 'lang-chip' + (isAct ? ' active' : ''),
        text: l.name + (isLoading ? ' ⏳' : ''),
        title: `Переключить описание на ${l.rawName}`,
        onclick: () => switchLanguage(l.iso)
      });
      container.append(chip);
    });
  }

  function switchLanguage(targetLang) {
    if (!cur || !cur.obj) return;
    const curIso = (cur.lang || (cur.detail && cur.detail.language_iso) || 'ru').toLowerCase();
    if (curIso === targetLang && cur.detail && !cur.loadingLang) return;

    cur.lang = targetLang;
    cur.loadingLang = targetLang;
    renderLangsUI();
    load(cur.obj, targetLang);
  }

  function getWmSpaUrl(obj, action = 'view', lang = 'ru') {
    if (!obj || !obj.bbox) return 'https://wikimapia.org/';
    const coords = getCentroidCoords(obj);
    const zoom = Math.max(WM.map ? Math.round(WM.map.getZoom()) : 15, 14);
    const lngParam = (lang === 'ru') ? '1' : lang;

    let showPath = '';
    switch (action) {
      case 'edit':
        // Окно редактирования контура и параметров
        showPath = `/object/edit/?lng=${lngParam}&object_type=1&id=${obj.id}`;
        break;
      case 'history':
        // Полная история правок с авторами и датами
        showPath = `/object/history/list/?object_type=1&id=${obj.id}&lng=${lang}`;
        break;
      case 'comment':
      case 'view':
      default:
        // Интерактивная карточка с формой добавления комментария
        showPath = `/${obj.id}/${lang}/`;
        break;
    }

    return `https://wikimapia.org/#lang=${lang}&lat=${coords.lat}&lon=${coords.lon}&z=${zoom}&m=w&show=${showPath}`;
  }

  function renderInfo(body, o, d) {
    body.append(el('p', { class: 'desc', text: (d && d.description) || (d ? 'Описание отсутствует.' : 'Загрузка…') }));
    
    const rawTags = list(d && d.tags).filter(t => t && (t.title || t.name));
    if (rawTags.length) {
      const activeTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;
      const tagChips = rawTags.map(t => {
        const title = t.title || t.name;
        const id = t.id || null;
        const isActive = activeTag && (activeTag.title === title || (id && activeTag.id === id));
        return el('button', {
          class: 'tag-btn' + (isActive ? ' active' : ''),
          title: `Подсветить все «${title}»`,
          onclick: (e) => {
            e.stopPropagation();
            if (WM.view && WM.view.toggleTagFilter) {
              WM.view.toggleTagFilter({ id, title });
            }
            renderBody();
          }
        }, el('span', { text: '🏷️ ' + title }));
      });
      body.append(el('div', { class: 'tags' }, tagChips));
    }

    const loc = d && d.location, parts = [];
    if (loc) ['country', 'state', 'city', 'place', 'street', 'housenumber'].forEach(k => { 
      if (typeof loc[k] === 'string' && loc[k]) parts.push(loc[k]); 
    });
    if (parts.length) body.append(el('p', { class: 'row' }, el('b', { text: 'Адрес: ' }), parts.join(', ')));

    const coords = getCentroidCoords(o);
    const coordStr = `${coords.lat}, ${coords.lon}`;
    const titleEncoded = encodeURIComponent(o.title || 'Wikimapia Point');
    const geoUri = `geo:${coords.lat},${coords.lon}?q=${coords.lat},${coords.lon}(${titleEncoded})`;
    const yandexUrl = `https://yandex.ru/maps/?pt=${coords.lon},${coords.lat}&z=17&l=map`;
    const googleUrl = `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lon}`;
    
    const curLang = (cur && cur.lang) || 'ru';
    
    // Прямой URL на Wikimapia с учетом активного языка
    let wmUrl = '';
    if (d && d.availableLanguages && d.availableLanguages[curLang] && d.availableLanguages[curLang].object_url) {
      wmUrl = safeUrl(d.availableLanguages[curLang].object_url);
    } else {
      const baseRawUrl = safeUrl((d && (d.urlhtml || d.url)) || o.url);
      if (baseRawUrl) {
        wmUrl = baseRawUrl.replace(/(wikimapia\.org\/\d+\/)[a-z]{2,3}(\/|$)/i, `$1${curLang}$2`);
      } else {
        wmUrl = getWmSpaUrl(o, 'view', curLang);
      }
    }

    
    const wmViewUrl = getWmSpaUrl(o, 'view', curLang);
    const wmEditUrl = getWmSpaUrl(o, 'edit', curLang);
    const wmHistoryUrl = getWmSpaUrl(o, 'history', curLang);

    const navButtons = [
      el('a', { class: 'action-card-btn primary', href: geoUri, text: '🧭 В Навигатор' }),
      el('a', { class: 'action-card-btn', href: yandexUrl, target: '_blank', rel: 'noopener noreferrer', text: '🟡 Яндекс Карты' }),
      el('a', { class: 'action-card-btn', href: googleUrl, target: '_blank', rel: 'noopener noreferrer', text: '🔵 Google Maps' }),
      el('a', { class: 'action-card-btn', href: wmViewUrl, target: '_blank', rel: 'noopener noreferrer', text: '🌐 Wikimapia ↗' }),
      el('a', { 
        class: 'action-card-btn edit-btn', 
        href: wmEditUrl, 
        target: '_blank', 
        rel: 'noopener noreferrer', 
        title: 'Редактировать контур или описание на Wikimapia',
        text: '✏️ Редактировать ↗' 
      }),
      el('a', { 
        class: 'action-card-btn history-btn', 
        href: wmHistoryUrl, 
        target: '_blank', 
        rel: 'noopener noreferrer', 
        title: 'Посмотреть историю правок объекта',
        text: '📜 История правок ↗' 
      })
    ];

    // Кнопка-ссылка на Википедию, если она есть у объекта
    const wikiUrl = safeUrl(d && d.wikipedia);
    if (wikiUrl) {
      navButtons.push(
        el('a', {
          class: 'action-card-btn wiki-btn',
          href: wikiUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Открыть статью в Википедии',
          text: '📖 Википедия ↗'
        })
      );
    }

    const actionBlock = el('div', { class: 'card-action-block' },
      el('div', {
        class: 'coords-card',
        title: 'Нажмите, чтобы скопировать координаты',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(coordStr);
            showToast(`📋 Координаты скопированы: ${coordStr}`);
          } catch (e) {
            showToast(`Координаты: ${coordStr}`);
          }
        }
      },
        el('div', { class: 'coords-meta' },
          el('span', { class: 'coords-label', text: 'Координаты центра' }),
          el('span', { class: 'coords-val', text: coordStr })
        ),
        el('span', { class: 'coords-copy-badge', text: '📋 Скопировать' })
      ),
      el('div', { class: 'nav-actions-grid' }, navButtons)
    );

    body.append(actionBlock);

    const PRESETS = ['#ef4444', '#f97316', '#eab308', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
    const colorCard = el('div', { class: 'card-color-mark' });

    function renderColorPalette() {
      colorCard.textContent = '';
      const hasCustom = !!o.customColor;

      const header = el('div', { class: 'color-mark-header' },
        el('span', { text: hasCustom ? '🎨 Цветная метка объекта:' : '🎨 Пометить объект цветом:' }),
        hasCustom ? el('button', {
          class: 'color-mark-clear-btn',
          title: 'Сбросить цвет метки',
          onclick: (e) => {
            e.stopPropagation();
            delete o.customColor;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, null);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('Цветовая метка удалена');
          }
        }, el('span', { text: '✕ Сбросить' })) : null
      );

      const palette = el('div', { class: 'color-palette-row' });
      PRESETS.forEach(c => {
        const isAct = o.customColor && o.customColor.toLowerCase() === c.toLowerCase();
        const btn = el('button', {
          class: 'color-palette-chip' + (isAct ? ' active' : ''),
          style: `background-color: ${c};`,
          title: `Выбрать цвет ${c}`,
          onclick: (e) => {
            e.stopPropagation();
            o.customColor = c;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, c);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('🎨 Объект помечен цветом!');
          }
        });
        palette.append(btn);
      });

      const pickerWrap = el('label', {
        class: 'color-palette-custom',
        title: 'Выбрать произвольный цвет'
      },
        el('span', { text: '🌈' }),
        el('input', {
          type: 'color',
          value: o.customColor || '#3b82f6',
          onchange: (e) => {
            const chosen = e.target.value;
            o.customColor = chosen;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, chosen);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('🎨 Объект помечен цветом!');
          }
        })
      );
      palette.append(pickerWrap);

      colorCard.append(header, palette);
    }

    renderColorPalette();
    body.append(colorCard);
  }

  function showLbPhoto(index) {
    if (!lb.list || !lb.list.length) return;
    lb.i = (index + lb.list.length) % lb.list.length;
    resetLbTransform();
    const p = lb.list[lb.i];

    const img = $('lb-img');
    const loader = $('lb-loader');
    const targetUrl = safeUrl(p['1280_url'] || p.big_url || p.large_url || p['960_url'] || p.thumbnail_url || p.url);

    if (loader) loader.hidden = false;
    if (img) {
      img.classList.add('loading');
      img.onload = () => {
        if (loader) loader.hidden = true;
        img.classList.remove('loading');
      };
      img.onerror = () => {
        if (loader) loader.hidden = true;
        img.classList.remove('loading');
      };
      img.src = targetUrl;
      if (img.complete && img.naturalWidth > 0) {
        if (loader) loader.hidden = true;
        img.classList.remove('loading');
      }
    }
    
    // Подробная подпись в лайтбоксе с автором, датой и порядковым номером
    const author = p.user_name || p.last_user_name || '';
    const dateStr = p.time ? fmtDate(p.time) : (p.time_str || '');
    const metaParts = [`${lb.i + 1} / ${lb.list.length}`];
    if (author) metaParts.push(`👤 ${author}`);
    if (dateStr) metaParts.push(`📅 ${dateStr}`);
    
    $('lb-cap').textContent = metaParts.join('  ·  ');

    const hasMultiple = lb.list.length > 1;
    const prevBtn = $('lb-prev');
    const nextBtn = $('lb-next');
    if (prevBtn) prevBtn.hidden = !hasMultiple;
    if (nextBtn) nextBtn.hidden = !hasMultiple;
  }

  function openLightbox(index) {
    showLbPhoto(index);
    $('lightbox').hidden = false;
    pushHistoryState('lightbox');
  }

  WM.ui.openLightbox = function(photosList, startIndex = 0) {
    if (!Array.isArray(photosList) || !photosList.length) return;
    lb.list = photosList;
    openLightbox(startIndex);
  };

  function closeLightbox(syncHistory = true) {
    const lbEl = $('lightbox');
    if (lbEl) lbEl.hidden = true;
    const loader = $('lb-loader');
    if (loader) loader.hidden = true;
    resetLbTransform();
    if (syncHistory) clearHistoryState('lightbox', cur ? 'sheet' : null);
  }



  function renderPhotos(body, d) {
    const curLang = (cur && cur.lang) || 'ru';
    const obj = cur && cur.obj ? cur.obj : null;
    const wmViewUrl = getWmSpaUrl(obj, 'view', curLang);

    const photos = list(d.photos).filter(p => p && (p.thumbnail_url || p['1280_url'] || p.big_url || p['960_url']));
    if (!photos.length) {
      const emptyState = el('div', { class: 'sheet-empty-state' },
        el('div', { class: 'sheet-empty-icon', text: '📷' }),
        el('div', { class: 'sheet-empty-title', text: 'Фотографий пока нет' }),
        el('div', { class: 'sheet-empty-desc', text: 'Для этого объекта участники ещё не добавили фотографий.' }),
        el('a', {
          class: 'btn btn-secondary sheet-empty-action',
          href: wmViewUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '🌐 Открыть объект на Wikimapia ↗'
        })
      );
      return body.append(emptyState);
    }

    lb.list = photos;

    const grid = el('div', { class: 'photo-grid' });
    photos.forEach((p, i) => {
      const author = p.user_name || p.last_user_name || '';
      const dateStr = p.time ? fmtDate(p.time) : (p.time_str || '');

      const card = el('div', {
        class: 'photo-card',
        onclick: () => openLightbox(i)
      },
        el('img', {
          src: safeUrl(p.thumbnailRetina_url || p.thumbnail_url || p['960_url'] || p.big_url),
          loading: 'lazy',
          alt: author ? `Фото: ${author}` : 'Фото объекта'
        }),
        (author || dateStr) ? el('div', { class: 'photo-card-overlay' },
          author ? el('span', { class: 'photo-card-author', text: `👤 ${author}` }) : null,
          dateStr ? el('span', { class: 'photo-card-date', text: dateStr }) : null
        ) : null
      );
      grid.append(card);
    });

    body.append(grid);
  }

  function renderComments(body, d) {
    const curLang = (cur && cur.lang) || 'ru';
    const obj = cur && cur.obj ? cur.obj : null;
    const commentSpaUrl = getWmSpaUrl(obj, 'comment', curLang);

    const cs = list(d.comments).filter(c => c && (c.message || c.text));

    if (!cs.length) {
      const emptyState = el('div', { class: 'sheet-empty-state' },
        el('div', { class: 'sheet-empty-icon', text: '💬' }),
        el('div', { class: 'sheet-empty-title', text: 'Отзывов пока нет' }),
        el('div', { class: 'sheet-empty-desc', text: 'Вы можете написать первый отзыв или уточнение на Wikimapia.' }),
        el('a', {
          class: 'btn btn-primary sheet-empty-action',
          href: commentSpaUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '💬 Написать отзыв на Wikimapia ↗'
        })
      );
      return body.append(emptyState);
    }

    const topBar = el('div', { class: 'sheet-tab-action-bar' },
      el('span', { class: 'sheet-tab-action-title', text: `Всего отзывов: ${cs.length}` }),
      el('a', {
        class: 'sheet-tab-action-btn',
        href: commentSpaUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Написать отзыв на Wikimapia',
        text: '💬 Написать отзыв ↗'
      })
    );
    body.append(topBar);

    cs.forEach(c => {
      const authorName = c.name || c.user_name || 'Анонимный участник';
      const userId = +c.user_id || 0;
      
      let userPhoto = c.user_photo || '';
      if (userPhoto && !userPhoto.startsWith('http')) {
        userPhoto = `https://photos.wikimapia.org${userPhoto}`;
      }

      const dateStr = fmtDate(c.date || c.time);
      const isGood = typeof c.good === 'number' && c.good > 0;
      const isBad = typeof c.bad === 'number' && c.bad > 0;
      const moderName = c.moder_name || '';

      const header = el('div', { class: 'comment-header' });

      if (userPhoto && !userPhoto.includes('nofoto')) {
        header.append(el('img', { 
          class: 'comment-avatar', 
          src: userPhoto, 
          alt: authorName, 
          loading: 'lazy',
          onerror: (e) => { e.target.style.display = 'none'; }
        }));
      } else {
        const initial = (authorName.trim()[0] || '?').toUpperCase();
        header.append(el('div', { class: 'comment-avatar-placeholder', text: initial }));
      }

      const metaBlock = el('div', { class: 'comment-user-info' });

      if (userId > 0) {
        metaBlock.append(el('a', {
          class: 'comment-author-link',
          href: `https://wikimapia.org/user/${userId}/`,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: `Профиль ${authorName} на Wikimapia`,
          text: authorName
        }));
      } else {
        metaBlock.append(el('span', { class: 'comment-author-name', text: authorName }));
      }

      const subMeta = el('div', { class: 'comment-sub-meta' });
      if (dateStr) subMeta.append(el('span', { class: 'comment-date', text: dateStr }));
      if (moderName && moderName !== authorName) {
        subMeta.append(el('span', { class: 'comment-moder-badge', text: `🛡️ ${moderName}` }));
      }
      metaBlock.append(subMeta);
      header.append(metaBlock);

      if (isGood || isBad) {
        const ratingBlock = el('div', { class: 'comment-votes' });
        if (isGood) ratingBlock.append(el('span', { class: 'vote-good', text: `👍 ${c.good}` }));
        if (isBad) ratingBlock.append(el('span', { class: 'vote-bad', text: `👎 ${c.bad}` }));
        header.append(ratingBlock);
      }

      const commentCard = el('div', { class: 'comment-card' },
        header,
        el('div', { class: 'comment-message', text: c.message || c.text })
      );

      body.append(commentCard);
    });
  }

  function renderBody() {
    const body = $('sheet-body'); body.textContent = '';
    if (!cur) return;
    const { obj, detail, error } = cur;
    $('tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'info') renderInfo(body, obj, detail);
    else if (tab === 'photos') renderPhotos(body, detail || {});
    else renderComments(body, detail || {});
    if (error) body.append(el('div', { class: 'muted', text: 'Ошибка: ' + error }));
  }

  function load(obj, lang = 'ru') {
    cur.error = null;
    cur.loadingLang = lang;
    renderLangsUI();
    renderBody();

    WM.api.place(obj.id, lang).then(d => {
      if (cur && cur.obj.id === obj.id) { 
        cur.detail = d;
        cur.loadingLang = null;
        cur.lang = lang;
        if (d.title) $('sheet-title').textContent = d.title;

        // Обновляем список языков на основе детального ответа Wikimapia
        cur.availableLanguages = extractAvailableLanguages(d, lang);

        if (WM.cache && WM.cache.markVisited) {
          WM.cache.markVisited(obj.id, d);
        }
        if (WM.view && WM.view.updateObjectStyle) {
          WM.view.updateObjectStyle(obj.id);
        }

        renderLangsUI();
        renderBody(); 

        const respIso = (d.language_iso || '').toLowerCase();
        if (lang !== 'ru' && respIso && respIso !== lang && !d.description) {
          showToast(`Для этого объекта нет описания на выбранном языке`);
        }
      }
    }).catch(e => { 
      if (cur && cur.obj.id === obj.id) { 
        cur.error = e.message; 
        cur.loadingLang = null;
        renderLangsUI();
        renderBody(); 
      } 
    });
  }

  function closeSheet(syncHistory = true) {
    const sheet = $('sheet');
    sheet.style.transform = '';
    sheet.classList.remove('open', 'full');
    const expandBtn = $('sheet-expand');
    if (expandBtn) {
      expandBtn.textContent = '⤢';
      expandBtn.title = 'Развернуть';
    }
    document.body.classList.remove('sheet-open');
    cur = null;
    if (WM.view) WM.view.setSelected(null);
    if (WM.picker) WM.picker.refresh();
    if (syncHistory) clearHistoryState('sheet');

    // Если карточка открывалась из окна списка — возвращаем его обратно с сохранением тега
    if (returnToObjectsList) {
      openObjectsListModal(true, objectsListFilterTag);
    }
  }

  let lbScale = 1, lbPanX = 0, lbPanY = 0;
  let lbStartDist = 0, lbStartScale = 1;
  let lbLastTouch = null, lbLastTap = 0;

  function updateLbImgTransform() {
    const img = $('lb-img');
    if (img) img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbScale})`;

    const range = $('lb-zoom-range');
    const valText = $('lb-zoom-val');
    if (range) range.value = lbScale;
    if (valText) valText.textContent = Math.round(lbScale * 100) + '%';
  }

  function resetLbTransform() {
    lbScale = 1; lbPanX = 0; lbPanY = 0;
    updateLbImgTransform();
  }

  function initLightboxGestures() {
    const vp = $('lb-viewport');
    const lbEl = $('lightbox');
    if (!vp || !lbEl) return;

    const btnIn = $('lb-zoom-in');
    const btnOut = $('lb-zoom-out');
    const btnReset = $('lb-zoom-reset');
    const range = $('lb-zoom-range');

    const btnPrev = $('lb-prev');
    const btnNext = $('lb-next');
    if (btnPrev) {
      btnPrev.onclick = (e) => {
        e.stopPropagation();
        showLbPhoto(lb.i - 1);
      };
    }
    if (btnNext) {
      btnNext.onclick = (e) => {
        e.stopPropagation();
        showLbPhoto(lb.i + 1);
      };
    }

    if (btnIn) {
      btnIn.onclick = (e) => {
        e.stopPropagation();
        lbScale = Math.min(5, Math.round((lbScale + 0.5) * 10) / 10);
        updateLbImgTransform();
      };
    }
    if (btnOut) {
      btnOut.onclick = (e) => {
        e.stopPropagation();
        lbScale = Math.max(1, Math.round((lbScale - 0.5) * 10) / 10);
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
      };
    }
    if (range) {
      range.oninput = (e) => {
        lbScale = parseFloat(e.target.value);
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
      };
    }
    if (btnReset) {
      btnReset.onclick = (e) => {
        e.stopPropagation();
        resetLbTransform();
      };
    }

    window.addEventListener('keydown', e => {
      if (lbEl.hidden) return;
      if (e.key === 'ArrowRight') {
        showLbPhoto(lb.i + 1);
      } else if (e.key === 'ArrowLeft') {
        showLbPhoto(lb.i - 1);
      } else if (e.key === 'Escape') {
        closeLightbox(true);
      }
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      lbScale = Math.min(5, Math.max(1, Math.round((lbScale + delta) * 100) / 100));
      if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
      updateLbImgTransform();
    }, { passive: false });

    // Обработка мыши для ПК (панорамирование и закрытие кликом в пустоту)
    let isMouseDown = false, mouseStart = null, mouseTotalMove = 0;
    vp.addEventListener('mousedown', e => {
      if (e.target.closest('.lb-bottom-bar') || e.target.closest('.lb-btn')) return;
      isMouseDown = true;
      mouseStart = { x: e.clientX, y: e.clientY };
      mouseTotalMove = 0;
    });

    window.addEventListener('mousemove', e => {
      if (isMouseDown && mouseStart) {
        const dx = e.clientX - mouseStart.x;
        const dy = e.clientY - mouseStart.y;
        mouseTotalMove += Math.hypot(dx, dy);
        if (lbScale > 1) {
          lbPanX += dx;
          lbPanY += dy;
          updateLbImgTransform();
        }
        mouseStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mouseup', e => {
      if (!isMouseDown) return;
      isMouseDown = false;
      if (mouseTotalMove < 6 && (e.target === vp || e.target === lbEl)) {
        closeLightbox(true);
      }
      mouseStart = null;
    });


    const DOUBLE_TAP_MAX_DELAY_MS = 320;
    const DOUBLE_TAP_MAX_DIST_PX = 46;
    const ZOOM_DRAG_SENSITIVITY = 120; // Чувствительность жеста аналогично карте

    let lastTapTime = 0;
    let lastTapPt = null;
    let pendingSingleTapTimer = null;

    let isDoubleTapDragging = false;
    let hasMovedZoom = false;
    let doubleTapAnchorY = 0;
    let doubleTapStartScale = 1;

    let touchStartPt = null;
    let touchHasMoved = false;

    vp.addEventListener('touchstart', e => {
      if (e.target.closest('.lb-bottom-bar') || e.target.closest('.lb-btn')) return;

      // Щипок двумя пальцами
      if (e.touches.length === 2) {
        if (pendingSingleTapTimer) { clearTimeout(pendingSingleTapTimer); pendingSingleTapTimer = null; }
        isDoubleTapDragging = false;
        lbStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        lbStartScale = lbScale;
        return;
      }

      if (e.touches.length !== 1) return;

      const t = e.touches[0];
      const pt = { x: t.clientX, y: t.clientY };
      const now = Date.now();
      touchStartPt = pt;
      touchHasMoved = false;

      // Проверка на второй быстрый тап в той же точке
      const isSecondTap = lastTapPt &&
        (now - lastTapTime < DOUBLE_TAP_MAX_DELAY_MS) &&
        (Math.hypot(pt.x - lastTapPt.x, pt.y - lastTapPt.y) < DOUBLE_TAP_MAX_DIST_PX);

      if (isSecondTap) {
        if (pendingSingleTapTimer) { clearTimeout(pendingSingleTapTimer); pendingSingleTapTimer = null; }
        isDoubleTapDragging = true;
        hasMovedZoom = false;
        doubleTapAnchorY = pt.y;
        doubleTapStartScale = lbScale;
        lastTapTime = 0;
        lastTapPt = null;
        e.preventDefault(); // Защищает от нативного двойного зума браузера
      }
    }, { passive: false });


     vp.addEventListener('touchmove', e => {
      // 1. Щипок двумя пальцами
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (lbStartDist > 0) {
          lbScale = Math.min(5, Math.max(1, Math.round(lbStartScale * (dist / lbStartDist) * 100) / 100));
          if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
          updateLbImgTransform();
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const curPt = { x: t.clientX, y: t.clientY };

      // 2. Двойной тап с удержанием и свайпом (One-finger zoom)
      if (isDoubleTapDragging) {
        e.preventDefault();
        const deltaY = curPt.y - doubleTapAnchorY; // Вниз — плюс, вверх — минус

        if (Math.abs(deltaY) > 5) {
          hasMovedZoom = true;
        }

        const zoomChange = deltaY / ZOOM_DRAG_SENSITIVITY;
        lbScale = Math.min(5, Math.max(1, Math.round((doubleTapStartScale + zoomChange) * 100) / 100));
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
        return;
      }

      // 3. Панорамирование увеличенного фото
      if (lbScale > 1 && touchStartPt) {
        const dx = curPt.x - touchStartPt.x;
        const dy = curPt.y - touchStartPt.y;
        if (Math.hypot(dx, dy) > 6) touchHasMoved = true;
        lbPanX += dx;
        lbPanY += dy;
        touchStartPt = curPt;
        updateLbImgTransform();
        return;
      }

      // 4. Отслеживание свайпа для смены фото
      if (touchStartPt && Math.hypot(curPt.x - touchStartPt.x, curPt.y - touchStartPt.y) > 8) {
        touchHasMoved = true;
      }
    }, { passive: false });

    vp.addEventListener('touchend', e => {
      if (e.touches.length > 0) return;
      const now = Date.now();

      // Завершение двойного тапа / свайпа зума
      if (isDoubleTapDragging) {
        isDoubleTapDragging = false;
        if (!hasMovedZoom) {
          // Если палец не двигался — это был просто быстрый двойной клик (переключаем 1x ⟷ 2.5x)
          if (lbScale > 1) {
            resetLbTransform();
          } else {
            lbScale = 2.5;
            updateLbImgTransform();
          }
        }
        lastTapTime = 0;
        lastTapPt = null;
        touchStartPt = null;
        return;
      }

      // Одиночный тап (без сдвига)
      if (touchStartPt && !touchHasMoved) {
        const tappedTarget = e.target;
        const pt = touchStartPt;
        lastTapTime = now;
        lastTapPt = pt;

        if (pendingSingleTapTimer) clearTimeout(pendingSingleTapTimer);
        // Ждем интервал двойного тапа: если второго нажатия не последует и тап был в пустоту — закрываем фото
        pendingSingleTapTimer = setTimeout(() => {
          pendingSingleTapTimer = null;
          lastTapTime = 0;
          lastTapPt = null;
          if (tappedTarget === vp || tappedTarget === lbEl) {
            closeLightbox(true);
          }
        }, DOUBLE_TAP_MAX_DELAY_MS + 20);
      }
      // Горизонтальный свайп на 1x для перелистывания фото
      else if (touchStartPt && touchHasMoved && lbScale === 1) {
        const endT = e.changedTouches[0];
        const dx = endT.clientX - touchStartPt.x;
        const dy = endT.clientY - touchStartPt.y;
        
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          if (dx < 0) {
            showLbPhoto(lb.i + 1);
          } else {
            showLbPhoto(lb.i - 1);
          }
        }
      }

      touchStartPt = null;
    });
    vp.addEventListener('touchcancel', () => {
      isDoubleTapDragging = false;
      hasMovedZoom = false;
      lastTapTime = 0;
      lastTapPt = null;
      touchStartPt = null;
      if (pendingSingleTapTimer) {
        clearTimeout(pendingSingleTapTimer);
        pendingSingleTapTimer = null;
      }
    });
  }

  function initSheetGestures() {
    const sheet = $('sheet');
    const sheetBody = $('sheet-body');
    let startY = 0, startX = 0;
    let curDeltaY = 0, curDeltaX = 0;
    let isDraggingSheet = false;
    let isHorizontalSwipe = false;
    let gestureDecided = false;
    let isTouchActiveOnSheet = false;
    let baseTranslateY = 0;

    const TAB_ORDER = ['info', 'photos', 'comments'];

    function getSheetBaseTranslateY() {
      const winH = window.innerHeight;
      const sheetH = winH * 0.92;
      // Если full -> 0, если half -> (92vh - 55vh)
      return sheet.classList.contains('full') ? 0 : (sheetH - winH * 0.55);
    }

    function isEligibleDragTarget(target) {
      if (target.closest('.icon-btn, button, a, input, select, textarea, .coords-card, .sheet-alts, .sheet-langs, .color-palette-row')) {
        return false;
      }
      if (target.closest('#sheet-head, .sheet-handle, .sheet-title')) {
        return true;
      }
      if (sheet.classList.contains('full') && target.closest('#sheet-body') && sheetBody && sheetBody.scrollTop > 5) {
        return false;
      }
      return true;
    }

    sheet.addEventListener('touchstart', e => {
      if (!sheet.classList.contains('open')) return;
      if (e.touches.length !== 1) return;
      if (!isEligibleDragTarget(e.target)) return;

      isTouchActiveOnSheet = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      curDeltaX = 0;
      curDeltaY = 0;
      isDraggingSheet = false;
      isHorizontalSwipe = false;
      gestureDecided = false;
      
      baseTranslateY = getSheetBaseTranslateY();
      sheet.style.transition = 'none'; // Отключаем CSS-анимацию на время движения пальца
    }, { passive: true });

    window.addEventListener('touchmove', e => {
      if (!isTouchActiveOnSheet || e.touches.length !== 1) return;

      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      curDeltaX = dx;
      curDeltaY = dy;

      if (!gestureDecided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        gestureDecided = true;
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          isHorizontalSwipe = true;
          isDraggingSheet = false;
        } else {
          isHorizontalSwipe = false;
          isDraggingSheet = true;
        }
      }

      if (isDraggingSheet) {
        let targetY = baseTranslateY + dy;
        // Эффект упругого сопротивления при вытягивании выше максимума
        if (targetY < 0) {
          targetY = targetY * 0.22;
        }
        sheet.style.transform = `translate3d(0, ${targetY}px, 0)`;
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isTouchActiveOnSheet) return;
      isTouchActiveOnSheet = false;
      
      // Возвращаем плавную анимацию
      sheet.style.transition = '';

      if (isHorizontalSwipe) {
        sheet.style.transform = '';
        const curIndex = TAB_ORDER.indexOf(tab);
        if (curDeltaX < -45) {
          tab = TAB_ORDER[(curIndex + 1) % TAB_ORDER.length];
          renderBody();
        } else if (curDeltaX > 45) {
          tab = TAB_ORDER[(curIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length];
          renderBody();
        }
      } else if (isDraggingSheet) {
        const isFull = sheet.classList.contains('full');
        const expandBtn = $('sheet-expand');
        const winH = window.innerHeight;

        // Очищаем инлайн-стиль, чтобы управление перешло обратно CSS-классам
        sheet.style.transform = '';

        if (isFull) {
          if (curDeltaY > Math.max(180, winH * 0.25)) {
            closeSheet(true);
          } else if (curDeltaY > 60) {
            sheet.classList.remove('full');
            if (sheetBody) sheetBody.scrollTop = 0;
            if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
          }
        } else {
          // Свайп вверх сильнее 50px -> развернуть на весь экран
          if (curDeltaY < -50) {
            sheet.classList.add('full');
            if (expandBtn) { expandBtn.textContent = '⤡'; expandBtn.title = 'Свернуть'; }
          } 
          // Свайп вниз сильнее 60px -> закрыть карточку
          else if (curDeltaY > 60) {
            closeSheet(true);
          }
        }
      }

      isDraggingSheet = false;
      isHorizontalSwipe = false;
      gestureDecided = false;
      curDeltaX = 0;
      curDeltaY = 0;
    }, { passive: true });

    window.addEventListener('touchcancel', () => {
      if (!isTouchActiveOnSheet) return;
      isTouchActiveOnSheet = false;
      isDraggingSheet = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
    });
  }

  let searchSource = 'all';
  let searchDebounceTimer = null;

  // Отрисовка вкладки тегов из кэша с фильтрацией по введенной строке
  function renderTagsSearch(query = '') {
    const listEl = $('search-results');
    listEl.textContent = '';

    const tagMap = new Map();
    if (WM.cache && WM.cache.objects) {
      for (const o of WM.cache.objects.values()) {
        if (!Array.isArray(o.tags)) continue;
        for (const t of o.tags) {
          const title = (t.title || t.name || '').trim();
          if (!title) continue;
          const key = t.id ? `id:${t.id}` : `t:${title.toLowerCase()}`;
          let entry = tagMap.get(key);
          if (!entry) {
            entry = { id: t.id || null, title, count: 0 };
            tagMap.set(key, entry);
          }
          entry.count++;
        }
      }
    }

    if (tagMap.size === 0) {
      listEl.append(el('div', { 
        class: 'muted', 
        style: 'line-height: 1.5; padding: 24px 12px;',
        text: 'Теги в сохранённых объектах пока не найдены. Откройте карточки объектов или включите фоновую загрузку, чтобы они появились здесь.' 
      }));
      return;
    }

    // Информационная плашка с пояснением логики работы
    const hintEl = el('div', { class: 'search-tags-hint' },
      el('div', { class: 'search-tags-hint-title', text: '💡 Как работает поиск по тегам' }),
      el('div', { 
        class: 'search-tags-hint-desc', 
        html: 'Список и числа в скобках показывают теги из карточек в памяти устройства. <b>При клике на тег начнётся поиск по всей базе Wikimapia</b> — на карте найдутся и подсветятся <i>все</i> объекты этой категории в видимой области.' 
      })
    );
    listEl.append(hintEl);

    const qLower = query.toLowerCase();
    let tags = Array.from(tagMap.values());
    if (qLower) {
      tags = tags.filter(t => t.title.toLowerCase().includes(qLower));
    }

    // Сортировка по алфавиту
    tags.sort((a, b) => a.title.localeCompare(b.title, 'ru'));

    if (tags.length === 0) {
      listEl.append(el('div', { class: 'muted', text: 'Подходящих тегов не найдено' }));
      return;
    }

    const activeTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;
    const wrap = el('div', { class: 'search-tags-wrap' });

    tags.forEach(t => {
      const isActive = activeTag && (activeTag.title === t.title || (t.id && activeTag.id === t.id));
      const chip = el('button', {
        class: 'search-tag-chip' + (isActive ? ' active' : ''),
        title: `Подсветить объекты с тегом «${t.title}»`,
        onclick: () => {
          $('modal-search').classList.remove('open');
          if (WM.view && WM.view.toggleTagFilter) {
            WM.view.toggleTagFilter({ id: t.id, title: t.title });
          }
          showToast(isActive ? `🏷️ Подсветка тега «${t.title}» снята` : `🏷️ Поиск и подсветка: «${t.title}»`);
        }
      },
        el('span', { text: '🏷️ ' + t.title }),
        el('span', { class: 'tag-count', text: `(${t.count})` })
      );
      wrap.append(chip);
    });

    listEl.append(wrap);
  }

  // Маркер перехода к координатам поиска
  let searchCoordPin = null;

  function showSearchCoordPin(lat, lon, label) {
    if (searchCoordPin && WM.map) {
      WM.map.removeLayer(searchCoordPin);
      searchCoordPin = null;
    }

    const pinHtml = `
      <div class="wm-search-pin-wrapper">
        <div class="wm-search-pin-pulse"></div>
        <div class="wm-search-pin-dot">🎯</div>
      </div>
    `;

    searchCoordPin = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'wm-search-pin-icon',
        html: pinHtml,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      }),
      zIndexOffset: 1600
    }).addTo(WM.map);

    const coordStr = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    const popupContent = document.createElement('div');
    popupContent.className = 'wm-search-pin-popup';
    popupContent.innerHTML = `
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 2px;">📍 ${escapeHtml(label || 'Точка по координатам')}</div>
      <div style="font-family: monospace; font-size: 12px; margin-bottom: 8px; color: var(--accent); font-weight: 600;">${coordStr}</div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn btn-primary" id="btn-pin-add-marker" style="font-size: 11px; padding: 4px 8px; flex: 1;">📍 Создать метку</button>
        <button type="button" class="btn btn-secondary" id="btn-pin-copy-coords" style="font-size: 11px; padding: 4px 8px;" title="Скопировать">📋</button>
        <button type="button" class="btn btn-secondary" id="btn-pin-remove" style="font-size: 11px; padding: 4px 8px;" title="Скрыть пин">✕</button>
      </div>
    `;

    searchCoordPin.bindPopup(popupContent, { 
      offset: [0, -14], 
      closeButton: false,
      className: 'wm-search-leaflet-popup' 
    }).openPopup();

    setTimeout(() => {
      const btnAdd = document.getElementById('btn-pin-add-marker');
      if (btnAdd) {
        btnAdd.onclick = () => {
          if (searchCoordPin) {
            WM.map.removeLayer(searchCoordPin);
            searchCoordPin = null;
          }
          if (WM.markers && WM.markers.openModal) {
            WM.markers.openModal(null, { lat, lng: lon });
          }
        };
      }
      const btnCopy = document.getElementById('btn-pin-copy-coords');
      if (btnCopy) {
        btnCopy.onclick = () => {
          navigator.clipboard.writeText(coordStr).then(() => {
            showToast(`📋 Скопировано: ${coordStr}`);
          });
        };
      }
      const btnRem = document.getElementById('btn-pin-remove');
      if (btnRem) {
        btnRem.onclick = () => {
          if (searchCoordPin) {
            WM.map.removeLayer(searchCoordPin);
            searchCoordPin = null;
          }
        };
      }
    }, 60);
  }

  let searchInatType = 'global'; // <-- БЫЛО: 'screen', СТАЛО: 'global'
  let searchInatSelectedTaxon = null;
  let searchInatLastResults = [];
  let searchInatAutocompleteAbort = null;
  let searchInatAutocompleteTimer = null;

  function renderInatTaxaAutocomplete(taxa) {
    const wrap = $('search-autocomplete-wrap');
    const list = $('search-autocomplete-list');
    if (!wrap || !list) return;

    list.innerHTML = '';
    if (!taxa || !taxa.length) {
      wrap.hidden = true;
      return;
    }

    taxa.forEach(t => {
      const icon = WM.inat ? WM.inat.getTaxonIcon(t) : '🌱';
      const meta = WM.inat ? WM.inat.getTaxonMeta(t) : { name: 'Организм', color: '#10b981' };
      const ruName = t.preferred_common_name || t.name;
      const latinName = t.name || '';
      const photoUrl = t.default_photo?.square_url || '';

      const item = el('div', { class: 'inat-autocomplete-item' });
      item.innerHTML = `
        ${photoUrl ? `<img src="${photoUrl}" class="inat-ac-thumb" alt="">` : `<span class="inat-ac-icon">${icon}</span>`}
        <div class="inat-ac-meta">
          <span class="inat-ac-ru">${escapeHtml(ruName)}</span>
          <span class="inat-ac-la">${escapeHtml(latinName)}</span>
        </div>
        <span class="inat-ac-category" style="color: ${meta.color};">${meta.name}</span>
      `;

      item.onclick = (e) => {
        e.stopPropagation();
        searchInatSelectedTaxon = t;
        const input = $('search-input');
        if (input) {
          input.value = ruName;
          $('search-clear-btn').hidden = false;
        }
        wrap.hidden = true;
        executeSearch(ruName);
      };

      list.appendChild(item);
    });

    wrap.hidden = false;
  }

  function triggerSearchInatAutocomplete(q) {
    clearTimeout(searchInatAutocompleteTimer);
    const wrap = $('search-autocomplete-wrap');

    if (searchInatSelectedTaxon && q.trim() !== (searchInatSelectedTaxon.preferred_common_name || searchInatSelectedTaxon.name)) {
      searchInatSelectedTaxon = null;
    }

    // Разрешаем автодополнение как на вкладке "inat", так и на общей вкладке "all" ("Все")
    if ((searchSource !== 'inat' && searchSource !== 'all') || q.trim().length < 2 || !WM.inat) {
      if (wrap) wrap.hidden = true;
      return;
    }

    searchInatAutocompleteTimer = setTimeout(async () => {
      if (searchInatAutocompleteAbort) searchInatAutocompleteAbort.abort();
      searchInatAutocompleteAbort = new AbortController();

      const list = await WM.inat.fetchTaxaAutocomplete(q, searchInatAutocompleteAbort.signal);
      renderInatTaxaAutocomplete(list);
    }, 180);
  }

  async function executeSearch(query) {
    const listEl = $('search-results');
    const q = (query || '').trim();

    // 1. Быстрый режим тегов
    if (searchSource === 'tags') {
      renderTagsSearch(q);
      return;
    }

    // 2. Отдельный режим iNaturalist
    if (searchSource === 'inat') {
      const applyBtn = $('btn-search-inat-apply-map');
      if (q.length < 2 && !searchInatSelectedTaxon) {
        listEl.textContent = '';
        listEl.append(el('div', { class: 'muted', text: 'Введите название растения или гриба (рус / лат)…' }));
        if (applyBtn) applyBtn.hidden = true;
        searchInatLastResults = [];
        return;
      }

      listEl.innerHTML = '<div class="muted" style="padding: 16px 0;">⏳ Поиск в базе iNaturalist…</div>';

      try {
        const resData = await WM.inat.searchObservations(q, searchInatType, searchInatSelectedTaxon);
        const items = resData.results || [];
        searchInatLastResults = items;

        const mapCenter = WM.map ? WM.map.getCenter() : null;
        if (mapCenter) {
          items.forEach(obs => {
            if (obs._lat != null && obs._lng != null) {
              obs._distMeters = WM.map.distance(mapCenter, [obs._lat, obs._lng]);
            }
          });
          items.sort((a, b) => (a._distMeters || 0) - (b._distMeters || 0));
        }

        listEl.textContent = '';
        if (applyBtn) applyBtn.hidden = !items.length && !searchInatSelectedTaxon;

        if (!items.length) {
          listEl.append(el('div', {
            class: 'muted',
            text: searchInatType === 'screen'
              ? 'На видимом экране совпадений не найдено. Переключите на «Общий» или увеличьте охват.'
              : 'В базе iNaturalist ничего не найдено по этому запросу.'
          }));
          return;
        }

        // Заголовок с количеством
        const totalText = resData.total ? resData.total.toLocaleString('ru-RU') : items.length;
        const countHeader = el('div', {
          class: 'search-inat-results-header',
          style: 'font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between;'
        },
          el('span', { text: `Найдено: ${items.length} (всего ${totalText})` }),
          searchInatSelectedTaxon ? el('span', { style: 'color: var(--accent);', text: `Таксон: ${searchInatSelectedTaxon.name}` }) : null
        );
        listEl.append(countHeader);

        items.forEach(obs => {
          const taxon = obs.taxon || {};
          const meta = WM.inat ? WM.inat.getTaxonMeta(taxon) : { name: 'Организм', icon: '🌱', color: '#10b981' };
          const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
          const latinName = taxon.name || '';
          const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
          const dateStr = obs.observed_on || (obs.created_at ? obs.created_at.slice(0, 10) : '');

          let distStr = '';
          if (obs._distMeters != null) {
            distStr = obs._distMeters >= 1000
              ? ` · ~${(obs._distMeters / 1000).toFixed(1)} км`
              : ` · ~${Math.round(obs._distMeters)} м`;
          }

          const itemEl = el('div', {
            class: 'search-result-item inat-search-item',
            style: `border-left: 3.5px solid ${meta.color};`,
            onclick: () => {
              $('modal-search').classList.remove('open');
              clearHistoryState('search');
              if (obs._lat != null && obs._lng != null && WM.map) {
                WM.map.flyTo([obs._lat, obs._lng], Math.max(WM.map.getZoom(), 16), { animate: true });
                if (WM.inat && WM.inat.highlightObservationZone) {
                  WM.inat.highlightObservationZone(obs);
                }
                setTimeout(() => {
                  if (WM.inat && WM.inat.openObservationCard) {
                    WM.inat.openObservationCard(obs);
                  }
                }, 350);
                showToast(`🎯 ${meta.icon} ${ruName}`);
              }
            }
          });

          itemEl.innerHTML = `
            ${photoUrl ? `<img src="${photoUrl}" class="inat-search-thumb" alt="">` : `<span class="inat-search-icon">${meta.icon}</span>`}
            <div class="inat-search-meta">
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="inat-search-ru">${escapeHtml(ruName)}</span>
                <span class="inat-search-type-sub" style="color:${meta.color}; font-size:10px; font-weight:700;">${meta.name}</span>
              </div>
              <span class="inat-search-la">${escapeHtml(latinName)}</span>
              <span class="inat-search-extra">📅 ${dateStr}${distStr}</span>
            </div>
            <span class="inat-search-goto-btn" title="Перейти к точке на карте">🎯</span>
          `;

          listEl.appendChild(itemEl);
        });

      } catch (err) {
        listEl.innerHTML = `<div class="muted" style="color:var(--danger);">Ошибка поиска: ${escapeHtml(err.message)}</div>`;
      }
      return;
    }

    // 3. Режимы «Все», «Wikimapia», «OSM»
    if (q.length < 2) {
      listEl.textContent = '';
      listEl.append(el('div', { class: 'muted', text: 'Введите минимум 2 символа для поиска…' }));
      return;
    }

    const coordMatch = WM.geo && WM.geo.parseCoordinates ? WM.geo.parseCoordinates(q) : null;
    listEl.textContent = '';

    let coordItemEl = null;
    if (coordMatch) {
      const coordStr = `${coordMatch.lat.toFixed(6)}, ${coordMatch.lon.toFixed(6)}`;
      coordItemEl = el('div', {
        class: 'search-result-item search-result-coord',
        onclick: async () => {
          $('modal-search').classList.remove('open');
          clearHistoryState('search');
          WM.map.flyTo([coordMatch.lat, coordMatch.lon], Math.max(WM.map.getZoom(), 16), { animate: true });
          showSearchCoordPin(coordMatch.lat, coordMatch.lon, coordMatch.desc);
          if (WM.picker && WM.picker.getMode() === 'cross' && WM.picker.fetchAtCrosshair) {
            setTimeout(() => WM.picker.fetchAtCrosshair(), 400);
          }
          showToast(`🎯 Координаты: ${coordStr}`, 2400);
        }
      },
        el('div', { class: 'search-res-top' },
          el('span', { class: 'search-res-title', text: '📍 Показать место на карте' }),
          el('span', { class: 'search-badge search-badge-coord', text: coordMatch.format })
        ),
        el('div', { 
          class: 'search-res-subtitle', 
          text: `${coordStr} · ${coordMatch.desc} (нажмите для перехода)` 
        })
      );
      listEl.append(coordItemEl);

      const isPureCoordInput = /(?:https?:\/\/|geo:|^\s*[nsew+-]?\d+)/i.test(q) && !/[а-яёa-z]{4,}/i.test(q.replace(/https?:\/\/[^\s]+/gi, ''));
      if (isPureCoordInput && searchSource !== 'osm') return;
    }

    const center = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.61 };
    const qLower = q.toLowerCase();

    const localMatches = [];
    if (searchSource === 'all' || searchSource === 'wm') {
      for (const obj of WM.cache.objects.values()) {
        const titleMatch = obj.title && obj.title.toLowerCase().includes(qLower);
        const idMatch = String(obj.id) === q;
        if (titleMatch || idMatch) {
          const coords = getCentroidCoords(obj);
          localMatches.push({
            id: obj.id,
            title: obj.title || ('Объект #' + obj.id),
            subtitle: `Wikimapia ID: ${obj.id} · в памяти`,
            lat: parseFloat(coords.lat),
            lon: parseFloat(coords.lon),
            source: 'wm',
            inCache: true,
            obj
          });
          if (localMatches.length >= 10) break;
        }
      }
    }

    const promises = [];
    if (searchSource === 'all' || searchSource === 'osm') {
      promises.push(WM.api.geocodeOSM(q, center.lat, center.lng));
    } else {
      promises.push(Promise.resolve([]));
    }

    if (searchSource === 'all' || searchSource === 'wm') {
      promises.push(WM.api.search(q, center.lat, center.lng));
    } else {
      promises.push(Promise.resolve([]));
    }

    // Если активна вкладка «Все», ищем также живые организмы в iNaturalist
   if (searchSource === 'all' && WM.inat) {
      // Ищем глобально (не только на видимом экране) с учётом выбранного таксона из подсказок
      promises.push(
        WM.inat.searchObservations(q, 'global', searchInatSelectedTaxon)
          .then(res => (res && res.results ? res.results.slice(0, 7) : []))
          .catch(() => [])
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    let results = [...localMatches];

    try {
      const [osmRes, wmRaw, inatRes] = await Promise.all(promises);

      const wmRes = [];
      const seenIds = new Set(localMatches.map(m => String(m.id)));

      for (const it of (wmRaw || [])) {
        if (!it || it.id == null || seenIds.has(String(it.id))) continue;
        seenIds.add(String(it.id));

        let lat = null, lon = null;
        if (it.lat != null && it.lon != null) {
          lat = parseFloat(it.lat);
          lon = parseFloat(it.lon);
        } else if (it.location) {
          if (it.location.lat != null && it.location.lon != null) {
            lat = parseFloat(it.location.lat);
            lon = parseFloat(it.location.lon);
          } else if (it.location.north != null && it.location.south != null) {
            lat = (parseFloat(it.location.north) + parseFloat(it.location.south)) / 2;
            lon = (parseFloat(it.location.east) + parseFloat(it.location.west)) / 2;
          }
        } else if (Array.isArray(it.polygon) && it.polygon.length) {
          lat = it.polygon.reduce((acc, p) => acc + parseFloat(p.y), 0) / it.polygon.length;
          lon = it.polygon.reduce((acc, p) => acc + parseFloat(p.x), 0) / it.polygon.length;
        }

        if (lat == null || isNaN(lat)) lat = center.lat;
        if (lon == null || isNaN(lon)) lon = center.lng;

        wmRes.push({
          id: it.id,
          title: it.title || it.name || ('Объект #' + it.id),
          subtitle: `Wikimapia ID: ${it.id}`,
          lat,
          lon,
          source: 'wm',
          inCache: false,
          raw: it
        });
      }

      // Форматируем находки iNaturalist для вкладки «Все»
      const inatFormatted = (inatRes || []).map(obs => {
        const taxon = obs.taxon || {};
        const meta = WM.inat ? WM.inat.getTaxonMeta(taxon) : { name: 'Организм', icon: '🌿' };
        const ru = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
        return {
          id: 'inat_' + obs.id,
          title: `${meta.icon} ${ru}`,
          subtitle: `${taxon.name || ''} · ${meta.name}`,
          lat: obs._lat,
          lon: obs._lng,
          source: 'inat',
          obs
        };
      });

      results = [...results, ...inatFormatted, ...wmRes, ...(osmRes || [])];
    } catch (e) {
      console.warn('Ошибка при поиске:', e);
    }

    listEl.textContent = '';
    if (coordItemEl) listEl.append(coordItemEl);

    if (!results.length && !coordItemEl) {
      listEl.append(el('div', { class: 'muted', text: 'Ничего не найдено' }));
      return;
    }

    results.forEach(res => {
      const isWm = res.source === 'wm';
      const isInat = res.source === 'inat';

      let badgeClass = 'search-badge-osm';
      let badgeText = 'Адрес / OSM';
      if (isWm) {
        badgeClass = 'search-badge-wm';
        badgeText = res.inCache ? 'Wikimapia (кэш)' : 'Wikimapia';
      } else if (isInat) {
        badgeClass = 'search-badge-inat';
        badgeText = '🌿 iNaturalist';
      }

      const itemEl = el('div', {
        class: 'search-result-item',
        onclick: async () => {
          $('modal-search').classList.remove('open');
          clearHistoryState('search');

          if (isInat && res.obs) {
            WM.map.flyTo([res.lat, res.lon], Math.max(WM.map.getZoom(), 16), { animate: true });
            if (WM.inat && WM.inat.highlightObservationZone) {
              WM.inat.highlightObservationZone(res.obs);
            }
            setTimeout(() => {
              if (WM.inat && WM.inat.openObservationCard) {
                WM.inat.openObservationCard(res.obs);
              }
            }, 300);
            return;
          }

          if (isWm) {
            let targetObj = WM.cache.objects.get(res.id);
            if (!targetObj && res.raw && (res.raw.polygon || (res.raw.location && res.raw.location.polygon))) {
              const added = WM.cache.addItems(null, [res.raw]);
              targetObj = added[0] || WM.cache.objects.get(res.id);
            }

            if (!targetObj) {
              WM.ui.setStatus('🔍 Загрузка геометрии объекта…');
              try {
                const detail = await WM.api.place(res.id);
                if (detail) {
                  const poly = detail.polygon || (detail.location && detail.location.polygon);
                  if (Array.isArray(poly) && poly.length >= 3) {
                    const pts = poly.map(p => [+p.y, +p.x]).filter(p => isFinite(p[0]) && isFinite(p[1]));
                    if (pts.length >= 3) {
                      targetObj = {
                        id: res.id,
                        title: detail.title || res.title,
                        url: detail.urlhtml || detail.url || '',
                        pts,
                        bbox: WM.geo.bboxOf(pts),
                        area: WM.geo.areaOf(pts),
                        refs: 1
                      };
                      WM.cache.objects.set(targetObj.id, targetObj);
                      WM.cache.updateObject(targetObj);
                    }
                  }
                }
              } catch (e) {
                console.warn('Не удалось догрузить геометрию объекта:', e);
              } finally {
                WM.ui.updateStatusFromLoader();
              }
            }

            if (targetObj) {
              const c = targetObj.bbox;
              const centerLat = (c.s + c.n) / 2;
              const centerLng = (c.w + c.e) / 2;
              WM.view.render();
              WM.map.flyTo([centerLat, centerLng], Math.max(WM.map.getZoom(), 16), { animate: true });
              setTimeout(() => {
                WM.picker.select(targetObj, [targetObj]);
              }, 300);
            } else {
              WM.map.flyTo([res.lat, res.lon], Math.max(WM.map.getZoom(), 16), { animate: true });
              const dummyObj = { id: res.id, title: res.title, bbox: { s: res.lat, n: res.lat, w: res.lon, e: res.lon }, pts: [] };
              setTimeout(() => {
                WM.picker.select(dummyObj, [dummyObj]);
              }, 300);
            }
          } else {
            WM.map.flyTo([res.lat, res.lon], 16, { animate: true });
          }
        }
      },
        el('div', { class: 'search-res-top' },
          el('span', { class: 'search-res-title', text: res.title }),
          el('span', { class: 'search-badge ' + badgeClass, text: badgeText })
        ),
        res.subtitle ? el('div', { class: 'search-res-subtitle', text: res.subtitle }) : null
      );
      listEl.append(itemEl);
    });
  }

  function initSearchUI() {
    const btnSearch = $('btn-search');
    const modalSearch = $('modal-search');
    const inputSearch = $('search-input');
    const btnClear = $('search-clear-btn');
    const inatToolbar = $('search-inat-toolbar');
    const autoWrap = $('search-autocomplete-wrap');

    if (modalSearch) {
      modalSearch.addEventListener('click', (e) => {
        if (e.target === modalSearch) {
          modalSearch.classList.remove('open');
          clearHistoryState('search');
          if (autoWrap) autoWrap.hidden = true;
        }
      });
    }

    if (btnSearch) {
      btnSearch.onclick = () => {
        pushHistoryState('search');
        modalSearch.classList.add('open');
        setTimeout(() => inputSearch.focus(), 100);
        executeSearch(inputSearch.value);
      };
    }

    $('search-x').onclick = () => {
      modalSearch.classList.remove('open');
      if (autoWrap) autoWrap.hidden = true;
    };

    inputSearch.oninput = () => {
      const val = inputSearch.value;
      btnClear.hidden = !val;
      triggerSearchInatAutocomplete(val);
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => executeSearch(val), 350);
    };

    btnClear.onclick = () => {
      inputSearch.value = '';
      searchInatSelectedTaxon = null;
      btnClear.hidden = true;
      if (autoWrap) autoWrap.hidden = true;
      const applyBtn = $('btn-search-inat-apply-map');
      if (applyBtn) applyBtn.hidden = true;
      executeSearch('');
      inputSearch.focus();
    };

    // Скрытие подсказок при клике вне поля ввода
    document.addEventListener('click', (e) => {
      if (autoWrap && !autoWrap.hidden && !e.target.closest('#modal-search .search-input-wrap') && !e.target.closest('#search-autocomplete-wrap')) {
        autoWrap.hidden = true;
      }
    });

    // Переключение типа поиска iNaturalist: На экране / Общий
    document.querySelectorAll('#search-inat-type-segmented .inat-search-type-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#search-inat-type-segmented .inat-search-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        searchInatType = btn.dataset.type;
        executeSearch(inputSearch.value);
      };
    });

    // Кнопка «👁️ Показать на карте» в окне поиска
    const btnApplyInat = $('btn-search-inat-apply-map');
    if (btnApplyInat) {
      btnApplyInat.onclick = () => {
        if (WM.inat && WM.inat.applyFilterToMap) {
          WM.inat.applyFilterToMap(inputSearch.value, searchInatSelectedTaxon);
        }
      };
    }

    // Переключение вкладок поиска со свайпом и прокруткой в фокус
    document.querySelectorAll('.search-tab-btn').forEach(tabBtn => {
      tabBtn.onclick = () => {
        document.querySelectorAll('.search-tab-btn').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        searchSource = tabBtn.dataset.source;

        // Плавная автопрокрутка нажатой вкладки в видимую зону
        tabBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

        if (searchSource === 'inat') {
          if (inatToolbar) inatToolbar.hidden = false;
          inputSearch.placeholder = 'Растения, грибы, птицы (рус / лат)…';
        } else {
          if (inatToolbar) inatToolbar.hidden = true;
          if (autoWrap) autoWrap.hidden = true;
          inputSearch.placeholder = 'Название, адрес или ID Wikimapia…';
        }

        executeSearch(inputSearch.value);
      };
    });
  }


  function populateStyleInputs() {
    const v = WM.view.getVectorStyle();
    const rWidth = $('rast-width');
    const rWidthVal = $('rast-width-val');
    if (rWidth) rWidth.value = rasterStyle.morphRadius || 0;
    if (rWidthVal) rWidthVal.textContent = formatMorphLabel(rasterStyle.morphRadius || 0);
    $('vec-stroke-color').value = v.color;
    $('vec-stroke-color-val').textContent = v.color;
    $('vec-stroke-width').value = v.weight;
    $('vec-stroke-width-val').textContent = v.weight + ' px';
    $('vec-fill-color').value = v.fillColor;
    $('vec-fill-color-val').textContent = v.fillColor;
    $('vec-fill-opacity').value = Math.round(v.fillOpacity * 100);
    $('vec-fill-opacity-val').textContent = Math.round(v.fillOpacity * 100) + '%';
    $('vec-hover-color').value = v.hoverColor;
    $('vec-hover-color-val').textContent = v.hoverColor;
    $('vec-sel-color').value = v.selectedColor;
    $('vec-sel-color-val').textContent = v.selectedColor;

    $('rast-tint-enabled').checked = !!rasterStyle.tintEnabled;
    $('rast-tint-color').value = rasterStyle.tintColor || '#8B4513';
    $('rast-tint-color-val').textContent = rasterStyle.tintColor || '#8B4513';
    const row = $('rast-tint-color-row');
    if (row) row.style.display = rasterStyle.tintEnabled ? 'flex' : 'none';

    $('rast-opacity').value = rasterStyle.opacity;
    $('rast-opacity-val').textContent = rasterStyle.opacity + '%';
    $('rast-contrast').value = rasterStyle.contrast;
    $('rast-contrast-val').textContent = rasterStyle.contrast + '%';
    $('rast-saturate').value = rasterStyle.saturate;
    $('rast-saturate-val').textContent = rasterStyle.saturate + '%';
    $('rast-brightness').value = rasterStyle.brightness;
    $('rast-brightness-val').textContent = rasterStyle.brightness + '%';
    $('rast-shadow').checked = rasterStyle.shadow;
    $('rast-invert').checked = rasterStyle.invert;
  }

  function readVectorInputs() {
    return {
      color: $('vec-stroke-color').value,
      weight: parseFloat($('vec-stroke-width').value),
      fillColor: $('vec-fill-color').value,
      fillOpacity: parseFloat($('vec-fill-opacity').value) / 100,
      hoverColor: $('vec-hover-color').value,
      selectedColor: $('vec-sel-color').value
    };
  }

  function readRasterInputs() {
    return {
      opacity: parseInt($('rast-opacity').value, 10),
      contrast: parseInt($('rast-contrast').value, 10),
      saturate: parseInt($('rast-saturate').value, 10),
      brightness: parseInt($('rast-brightness').value, 10),
      shadow: $('rast-shadow').checked,
      invert: $('rast-invert').checked,
      tintEnabled: $('rast-tint-enabled').checked,
      tintColor: $('rast-tint-color').value,
      morphRadius: parseFloat($('rast-width').value) || 0 // <-- НОВОЕ
    };
  }

  function initMobileTooltips() {
    const tooltipEl = $('ui-tooltip');
    let holdTimer = null;
    let targetEl = null;
    let touchStartPt = null;
    let longPressTriggered = false;
    let hideTimer = null;

    const TOOLTIPS = {
      // Кнопки с собственным удержанием исключаем из всплывающих тултипов:
      'btn-theme-toggle': null,
      'btn-compass': null,
      'btn-quick-swap-map': null,
      'btn-mode-toggle': () => {
        const isCross = WM.picker && WM.picker.getMode() === 'cross';
        return isCross 
          ? '🎯 Режим «Перекрестие»\nНаведите прицел в центре экрана для выбора объекта (тапните для смены на палец)' 
          : '👆 Режим «Палец»\nВыбирайте объекты прямым нажатием на карту (тапните для смены на прицел)';
      },
      'btn-track-record': () => (WM.tracker && WM.tracker.isRecording())
        ? (WM.tracker.isPaused() ? '⏸️ Запись трека на паузе' : '⏺️ Идёт запись трека (нажмите для управления)')
        : '⏺️ Запись трека: фиксация пройденного пути с защитой от сбоев и экспортом в GPX',
      'btn-measure': () => '📏 Линейка: измерение расстояний на карте, добавление узлов и нескольких треков',
      'btn-add-marker': () => '📍 Добавить метку: создать заметку с эмодзи в центре экрана с возможностью перемещения',
      'btn-download-area': () => '📥 Скачать область: сохранить контуры и описания видимой области для автономной работы',
      'btn-location': () => (WM.followMode && WM.followMode.isActive())
        ? '🎯 Режим слежения: активен\nУдерживайте или сдвиньте карту для отключения'
        : '🛰️ Моя геопозиция\nНажатие — показать координаты, удержание — режим слежения (прилипание камеры)',
      'btn-manual-pdr': () => (WM.manualPdr && WM.manualPdr.isActive())
        ? '📍 Ведение по датчикам активно\nНажмите для возврата к штатному GPS'
        : '📍 Поместить точку GPS сюда\nПривязать координаты к центру экрана и включить шагомер',
      'btn-motion-toggle': () => {
        const tail = WM.motionTail ? WM.motionTail.isEnabled() : false;
        const vector = WM.motionVector ? WM.motionVector.isEnabled() : false;
        if (tail && !vector) return '🐾 Хвост движения (активен)\nНажмите для включения траектории';
        if (tail && vector) return '🐾↗️ Хвост и траектория (активны)\nНажмите для выключения';
        if (!tail && vector) return '↗️ Траектория движения (активна)\nНажмите для выключения';
        return '🐾 Хвост и траектория (выключены)\nНажмите для включения хвоста';
      },
      'btn-gps-dist': () => (WM.gpsDist && WM.gpsDist.isActive()) ? '🧭 Расстояние до GPS: активно\nНажмите, чтобы отключить линию' : '🧭 Расстояние до GPS\nПоказывает прямую линию и расстояние от центра экрана до вашей геопозиции',
      'btn-theme-toggle': () => '🌙/☀️ Смена темы: переключение между тёмной и светлой темой оформления',
      'btn-compass': () => '🧭 Компас ориентации: стрелка указывает на географический Север. Нажмите для калибровки и азимута',
      'btn-settings': () => '⚙️ Настройки: режимы расхода API, управление ключами, оформление контуров и экспорт',
      'btn-search': () => '🔍 Поиск: поиск по названию, адресу, координатам или ID Wikimapia',
      'limit-badge': () => '🔑 Лимит API: число обращений к сайту Wikimapia за сутки (сброс в полночь по времени PT)',
      'limit-row': () => '🔑 Лимит API: состояние квоты текущего ключа и кнопка принудительного обновления',
      'btn-force-refresh': () => '🔄 Обновить: сбросить ограничения и принудительно догрузить недостающие полигоны на экране',
      'btn-get-key-top': () => '🔑 Добавить ключ: открыть настройки для добавления API-ключа Wikimapia',
      'status': () => 'ℹ️ Статус системы: текущий режим загрузки, число объектов в памяти и состояние сети',
      'tag-filter-badge': () => '🏷️ Фильтр тега: подсвечены только объекты выбранной категории',
      'tag-filter-refresh': () => '🔄 Искать тег: найти объекты данной категории на текущем видимом экране',
      'tag-filter-clear': () => '✕ Сбросить тег: вернуть стандартное отображение всех объектов',
      'hover-pill': () => '📑 Карточка объекта: нажмите, чтобы открыть полное описание, фотографии и отзывы',
      'crosshair': () => '✛ Прицел: центр экрана для точечного выбора и загрузки объектов',
      'btn-measure-undo': () => '↩ Отменить узел: удалить последнюю поставленную точку измерения',
      'btn-measure-finish': () => '✓ Фиксация: зафиксировать измерение или продолжить добавление узлов',
      'btn-measure-clear': () => '🗑️ Удалить измерение: стереть текущую линию с карты',
      'btn-measure-close': () => '✕ Закрыть линейку: скрыть панель измерений с экрана',
      'btn-quick-swap-map': () => '🔀 Быстрая смена: нажатие — переключить, долгое удержание — выбрать вторую карту',
      'btn-measure-new': () => '＋ Новое измерение: начать рисовать ещё одну независимую линию',
      'btn-measure-rename': () => '✏️ Переименовать: изменить название текущего измерения'
    };

    function getTooltipText(elem) {
      if (!elem) return '';
      if (elem.id && TOOLTIPS[elem.id]) {
        return typeof TOOLTIPS[elem.id] === 'function' ? TOOLTIPS[elem.id]() : TOOLTIPS[elem.id];
      }

      if (elem.classList.contains('leaflet-control-zoom-in')) return '➕ Приблизить: увеличить масштаб карты';
      if (elem.classList.contains('leaflet-control-zoom-out')) return '➖ Отдалить: уменьшить масштаб карты';
      if (elem.classList.contains('leaflet-control-layers-toggle')) return '🗺️ Слои карты: выбор спутников, топокарт, схем и Ж/Д сетей';

      const parentKey = Object.keys(TOOLTIPS).find(k => elem.closest && elem.closest('#' + k));
      if (parentKey) {
        return typeof TOOLTIPS[parentKey] === 'function' ? TOOLTIPS[parentKey]() : TOOLTIPS[parentKey];
      }

      return elem.getAttribute('title') || elem.getAttribute('aria-label') || '';
    }

    function showTooltipNear(elem, text) {
      if (!tooltipEl || !text) return;
      clearTimeout(hideTimer);
      tooltipEl.textContent = text;
      tooltipEl.hidden = false;
      tooltipEl.classList.add('visible');

      const rect = elem.getBoundingClientRect();
      const ttW = tooltipEl.offsetWidth || 240;
      const ttH = tooltipEl.offsetHeight || 60;
      const winW = window.innerWidth;

      let top = rect.top - ttH - 12;
      let left = rect.left + rect.width / 2 - ttW / 2;

      if (top < 12) top = rect.bottom + 12;
      if (left < 12) left = 12;
      if (left + ttW > winW - 12) left = winW - ttW - 12;

      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${left}px`;

      hideTimer = setTimeout(hideTooltip, 3000);
    }

    function hideTooltip() {
      clearTimeout(hideTimer);
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
        tooltipEl.hidden = true;
      }
    }

    function onTouchStart(e) {
      if (e.touches.length !== 1) { cancelHold(); return; }
      const target = e.target.closest('button, a, .limit-badge, .limit-row, .status-bar, .tag-filter-badge, .hover-pill, .leaflet-control-zoom-in, .leaflet-control-zoom-out, .leaflet-control-layers-toggle');
      if (!target) return;

      const text = getTooltipText(target);
      if (!text) return;

      targetEl = target;
      touchStartPt = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      longPressTriggered = false;

      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(35);
        showTooltipNear(targetEl, text);
      }, 420);
    }

    function onTouchMove(e) {
      if (!touchStartPt) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > 10) {
        cancelHold();
      }
    }

    function onTouchEnd() {
      if (longPressTriggered && targetEl) {
        const suppressTarget = targetEl;
        const suppressClick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          suppressTarget.removeEventListener('click', suppressClick, true);
        };
        suppressTarget.addEventListener('click', suppressClick, true);
        setTimeout(() => suppressTarget.removeEventListener('click', suppressClick, true), 350);
      }
      cancelHold();
    }

    function cancelHold() {
      clearTimeout(holdTimer);
      holdTimer = null;
      touchStartPt = null;
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', cancelHold, { passive: true });

    window.addEventListener('contextmenu', (e) => {
      const target = e.target.closest && e.target.closest('button, a, .floating-btn, .square-btn-top, .limit-badge, .status-bar');
      if (target) e.preventDefault();
    });
  }

  let returnToObjectsList = false;
  let lastObjectsSearchQuery = '';
  let cachedObjectsSnapshot = null; // Фиксированный снимок объектов исходной области
  let objectsListFilterTag = null;  // <-- Активный тег фильтрации (если открыто по тегу)
  let isDownloadingObjects = false;

  function getSourceObjectsForList() {
    const rawList = (WM.view && WM.view.shownObjects) ? WM.view.shownObjects() : [];
    if (!objectsListFilterTag) return rawList;
    const tag = objectsListFilterTag;
    return rawList.filter(o => {
      if (WM.view && WM.view.matchesTag) return WM.view.matchesTag(o, tag);
      if (!Array.isArray(o.tags)) return false;
      return o.tags.some(t => {
        if (tag.id && t.id && String(tag.id) === String(t.id)) return true;
        if (tag.title && t.title && t.title.toLowerCase() === tag.title.toLowerCase()) return true;
        return false;
      });
    });
  }

  function updateObjectsModalHeader() {
    const titleEl = $('objects-list-modal-title');
    if (!titleEl) return;
    if (objectsListFilterTag) {
      titleEl.innerHTML = `🏷️ ${escapeHtml(objectsListFilterTag.title)} (<span id="objects-list-count">0</span>)`;
    } else {
      titleEl.innerHTML = `📋 Объекты на карте (<span id="objects-list-count">0</span>)`;
    }
  }

  function updateObjectsDownloadBtn() {
    const btn = $('objects-download-btn');
    if (!btn) return;
    const allObjs = cachedObjectsSnapshot || getSourceObjectsForList();
    const count = allObjs.length;
    const isTooMany = count >= 50;

    if (isDownloadingObjects) {
      btn.classList.add('loading');
      btn.classList.remove('disabled');
      btn.textContent = '⏳';
      btn.title = 'Идёт скачивание объектов…';
      return;
    }

    btn.classList.remove('loading');
    btn.textContent = '📥';

    if (isTooMany || count === 0) {
      btn.classList.add('disabled');
      btn.title = isTooMany 
        ? `Слишком много объектов (${count}). Скачивание доступно, если менее 50` 
        : 'Нет объектов для скачивания';
    } else {
      btn.classList.remove('disabled');
      btn.title = `Скачать все данные объектов (${count} шт.)`;
    }
  }

  function closeObjectsListModal() {
    const modal = $('modal-objects-list');
    if (modal) modal.classList.remove('open');
    returnToObjectsList = false;
    cachedObjectsSnapshot = null;
    objectsListFilterTag = null;
    clearHistoryState('modal');

    if (!isDownloadingObjects) {
      const pWrap = $('objects-download-progress-wrap');
      if (pWrap) pWrap.hidden = true;
    }
  }

  function renderObjectsList(filterText = '') {
    const listEl = $('objects-list-items');
    const countEl = $('objects-list-count');
    if (!listEl) return;
    listEl.textContent = '';

    const allObjs = cachedObjectsSnapshot || getSourceObjectsForList();
    const q = (filterText || '').trim().toLowerCase();

    let list = allObjs;
    if (q) {
      list = allObjs.filter(o => {
        const title = (o.title || '').toLowerCase();
        const id = String(o.id);
        return title.includes(q) || id.includes(q);
      });
    }

    if (countEl) {
      countEl.textContent = q ? `${list.length}/${allObjs.length}` : `${allObjs.length}`;
    }

    if (!allObjs.length) {
      const emptyText = objectsListFilterTag 
        ? `В видимой области карты не найдено объектов с тегом «${objectsListFilterTag.title}».`
        : 'На экране пока нет загруженных объектов. Приблизьте карту или дождитесь загрузки.';
      listEl.append(el('div', {
        class: 'muted',
        style: 'width: 100%; padding: 24px 8px;',
        text: emptyText
      }));
      return;
    }

    if (!list.length) {
      listEl.append(el('div', {
        class: 'muted',
        style: 'width: 100%; padding: 20px 8px;',
        text: 'Объектов по вашему запросу не найдено'
      }));
      return;
    }

    list.sort((a, b) => {
      if (a.title && !b.title) return -1;
      if (!a.title && b.title) return 1;
      return (a.title || '').localeCompare(b.title || '', 'ru');
    });

    list.forEach(o => {
      const title = o.title || `Объект #${o.id}`;
      const isVisited = !!o.isVisited;

      const liveObj = (WM.cache && WM.cache.objects) ? WM.cache.objects.get(o.id) : null;
      const ph = Number(liveObj ? liveObj.photosCount : o.photosCount) || 0;
      const cm = Number(liveObj ? liveObj.commentsCount : o.commentsCount) || 0;

      const chipKids = [
        el('span', { text: o.customColor ? '🎨' : (isVisited ? '✓' : '🏷️') }),
        el('span', { class: 'object-tag-chip-title', text: title })
      ];

      const statsKids = [];
      if (ph > 0) statsKids.push(el('span', { class: 'object-chip-stat', text: `📷 ${ph}` }));
      if (cm > 0) statsKids.push(el('span', { class: 'object-chip-stat', text: `💬 ${cm}` }));
      if (statsKids.length > 0) chipKids.push(el('span', { class: 'object-chip-stats' }, statsKids));

      const chip = el('button', {
        class: 'object-tag-chip' + (isVisited ? ' visited' : ''),
        style: o.customColor ? `border-color: ${o.customColor};` : '',
        title: `Открыть «${title}»`,
        onclick: () => {
          returnToObjectsList = true;
          if (!cachedObjectsSnapshot) {
            cachedObjectsSnapshot = [...allObjs];
          }

          const modal = $('modal-objects-list');
          if (modal) modal.classList.remove('open');

          if (o.bbox && WM.map) {
            const centerLat = (o.bbox.s + o.bbox.n) / 2;
            const centerLng = (o.bbox.w + o.bbox.e) / 2;
            WM.map.flyTo([centerLat, centerLng], Math.max(WM.map.getZoom(), 16), { animate: true });
          }

          setTimeout(() => {
            WM.picker.select(o, [o]);
          }, 250);
        }
      }, chipKids);

      listEl.append(chip);
    });

    updateObjectsDownloadBtn();
  }

  function openObjectsListModal(preserveState = false, filterTag = null) {
    const modal = $('modal-objects-list');
    const input = $('objects-search-input');
    const clearBtn = $('objects-search-clear-btn');
    if (!modal) return;

    if (!preserveState) {
      objectsListFilterTag = filterTag;
      lastObjectsSearchQuery = '';
      cachedObjectsSnapshot = [...getSourceObjectsForList()];
      if (input) input.value = '';
      if (clearBtn) clearBtn.hidden = true;

      if (!isDownloadingObjects) {
        const pWrap = $('objects-download-progress-wrap');
        if (pWrap) pWrap.hidden = true;
      }
    } else {
      if (input) {
        input.value = lastObjectsSearchQuery;
        if (clearBtn) clearBtn.hidden = !lastObjectsSearchQuery;
      }
      if (!cachedObjectsSnapshot) {
        cachedObjectsSnapshot = [...getSourceObjectsForList()];
      }
    }

    updateObjectsModalHeader();
    renderObjectsList(lastObjectsSearchQuery);
    pushHistoryState('modal');
    modal.classList.add('open');
    if (input) setTimeout(() => input.focus(), 120);
  }

  function initObjectsListModal() {
    const modal = $('modal-objects-list');
    const closeBtn = $('objects-list-x');
    const input = $('objects-search-input');
    const clearBtn = $('objects-search-clear-btn');
    const downloadBtn = $('objects-download-btn');

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeObjectsListModal();
      });
    }

    if (closeBtn) closeBtn.onclick = closeObjectsListModal;

    if (input) {
      input.addEventListener('input', () => {
        lastObjectsSearchQuery = input.value;
        if (clearBtn) clearBtn.hidden = !input.value;
        renderObjectsList(lastObjectsSearchQuery);
      });
    }

    if (clearBtn) {
      clearBtn.onclick = () => {
        input.value = '';
        lastObjectsSearchQuery = '';
        clearBtn.hidden = true;
        renderObjectsList('');
        input.focus();
      };
    }

    if (downloadBtn) {
      downloadBtn.onclick = async () => {
        const allObjs = cachedObjectsSnapshot || ((WM.view && WM.view.shownObjects) ? WM.view.shownObjects() : []);

        if (isDownloadingObjects) {
          showToast('⏳ Загрузка объектов уже выполняется…');
          return;
        }

        if (!allObjs || allObjs.length === 0) {
          showToast('На карте нет объектов для скачивания');
          return;
        }

        if (allObjs.length >= 50) {
          showToast(`⚠️ Слишком много объектов (${allObjs.length}). Скачивание доступно, если менее 50`);
          return;
        }

        const pWrap = $('objects-download-progress-wrap');
        const pBar = $('objects-download-progress-bar');
        const pStatus = $('objects-download-progress-status');

        isDownloadingObjects = true;
        updateObjectsDownloadBtn();

        if (pWrap) {
          pWrap.hidden = false;
          if (pBar) {
            pBar.style.transition = 'none';
            pBar.style.width = '0%';
            void pBar.offsetWidth; // сброс предыдущей анимации
            pBar.style.transition = '';
          }
          if (pStatus) pStatus.textContent = `Обработка: 0 из ${allObjs.length} (0%)`;
        }

        showToast(`📥 Проверка и загрузка данных (${allObjs.length} шт.)…`, 1800);

        let loadedCount = 0;
        let fromCacheCount = 0;
        let fromNetCount = 0;
        let failedCount = 0;

        for (let i = 0; i < allObjs.length; i++) {
          const o = allObjs[i];
          downloadBtn.title = `Обработка: ${i + 1}/${allObjs.length}`;

          let isFromNet = false;

          try {
            // 1. Проверяем наличие карточки в локальной базе данных IndexedDB
            let detail = null;
            if (WM.cache && WM.cache.getDetail) {
              detail = await WM.cache.getDetail(o.id, 'ru');
            }

            // 2. Если в базе нет — отправляем сетевой запрос к API Wikimapia
            if (!detail) {
              isFromNet = true;
              detail = await WM.api.place(o.id, 'ru');
            }

            if (detail) {
              WM.cache.applyDetail(o.id, detail);
              if (WM.view && WM.view.updateObjectStyle) {
                WM.view.updateObjectStyle(o.id);
              }
              loadedCount++;
              if (isFromNet) fromNetCount++;
              else fromCacheCount++;
            }
          } catch (err) {
            failedCount++;
            if (err && err.rateLimit) {
              showToast('⏳ Превышен лимит API. Скачивание приостановлено.');
              if (pStatus) {
                pStatus.textContent = `Лимит API! Обработано: ${loadedCount} из ${allObjs.length}`;
              }
              break;
            }
          }

          // Обновляем прогресс
          const currentDone = i + 1;
          const pct = Math.round((currentDone / allObjs.length) * 100);
          if (pBar) pBar.style.width = `${pct}%`;
          if (pStatus) {
            pStatus.textContent = `Обработка: ${currentDone} из ${allObjs.length} (${pct}%)${failedCount ? ` · ошибок: ${failedCount}` : ''}`;
          }

          // Обновляем бейджи 📷 и 💬 в карточках
          renderObjectsList(lastObjectsSearchQuery);

          // Задержка 120 мс нужна ТОЛЬКО для запросов по сети, чтобы не превысить лимиты API.
          // Если объект взят из локальной базы — обрабатываем следующий мгновенно.
          if (isFromNet && i < allObjs.length - 1) {
            await new Promise(r => setTimeout(r, 120));
          }
        }

        isDownloadingObjects = false;
        updateObjectsDownloadBtn();
        renderObjectsList(lastObjectsSearchQuery);

        // Формируем понятный отчёт
        let finishReport = `✅ Готово! Всего: ${loadedCount}`;
        if (fromCacheCount > 0 && fromNetCount > 0) {
          finishReport = `✅ Готово: ${fromNetCount} скачано, ${fromCacheCount} из базы`;
        } else if (fromNetCount === 0 && fromCacheCount > 0) {
          finishReport = `✅ Все объекты (${fromCacheCount} шт.) уже были в базе!`;
        }
        if (failedCount > 0) finishReport += ` (ошибок: ${failedCount})`;

        if (pStatus) pStatus.textContent = finishReport;
        showToast(finishReport, 2400);

        setTimeout(() => {
          if (!isDownloadingObjects && pWrap) {
            pWrap.hidden = true;
          }
        }, 2600);

        if (WM.view && WM.view.render) WM.view.render();
        if (window.refreshAppStatus) window.refreshAppStatus();
      };
    }
  }
  window.updateInfoHudUI = updateInfoHudUI;

  let activeCoordsStr = '';

  function openCoordsModal(lat, lng) {
    const modal = $('modal-open-coords');
    if (!modal) return;

    // Ограничиваем зум для RetroMap адекватным диапазоном (от 5 до 18)
    const currentZoom = WM.map ? Math.round(WM.map.getZoom()) : 16;
    const rZoom = Math.min(18, Math.max(5, currentZoom));
    
    const latStr = lat.toFixed(6);
    const lngStr = lng.toFixed(6);
    activeCoordsStr = `${latStr}, ${lngStr}`;

    const valEl = $('open-coords-val');
    if (valEl) valEl.textContent = activeCoordsStr;

    // 1. Яндекс Карты
    const yandexBtn = $('open-coords-yandex');
    if (yandexBtn) yandexBtn.href = `https://yandex.ru/maps/?pt=${lngStr},${latStr}&z=${currentZoom}&l=map`;

    // 2. Google Maps
    const googleBtn = $('open-coords-google');
    if (googleBtn) googleBtn.href = `https://www.google.com/maps/search/?api=1&query=${latStr},${lngStr}`;

    // 3. OpenStreetMap
    const osmBtn = $('open-coords-osm');
    if (osmBtn) osmBtn.href = `https://www.openstreetmap.org/#map=${currentZoom}/${latStr}/${lngStr}`;

    // 4. ЭтоМесто (etomesto.com через карту мира с переходом к архивам)
    const etomestoBtn = $('open-coords-etomesto');
    if (etomestoBtn) etomestoBtn.href = `https://etomesto.com/map-mir/?y=${latStr}&x=${lngStr}`;

    // 5. RetroMap (базовая карта 1619851 с сохранением зума и точки)
    const retromapBtn = $('open-coords-retromap');
    if (retromapBtn) retromapBtn.href = `https://retromap.ru/1619851_z${rZoom}_${latStr},${lngStr}`;

    // 6. Wikimapia
    const wmBtn = $('open-coords-wm');
    if (wmBtn) wmBtn.href = `https://wikimapia.org/#lang=ru&lat=${latStr}&lon=${lngStr}&z=${currentZoom}&m=w`;

    // 7. В Навигатор
    const geoBtn = $('open-coords-geo');
    if (geoBtn) geoBtn.href = `geo:${latStr},${lngStr}?q=${latStr},${lngStr}`;

    modal.classList.add('open');
    pushHistoryState('openCoords');
  }

  function initCoordsModal() {
    const modal = $('modal-open-coords');
    if (!modal) return;

    const doCopy = async () => {
      if (!activeCoordsStr) return;
      try {
        await navigator.clipboard.writeText(activeCoordsStr);
        showToast(`📋 Координаты скопированы: ${activeCoordsStr}`);
      } catch (e) {
        showToast(`Координаты: ${activeCoordsStr}`);
      }
    };

    const card = $('open-coords-copy-card');
    if (card) card.onclick = doCopy;

    const copyBtn = $('open-coords-btn-copy');
    if (copyBtn) copyBtn.onclick = doCopy;

    const closeBtn = $('open-coords-close');
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('open');

    const closeX = $('open-coords-x');
    if (closeX) closeX.onclick = () => modal.classList.remove('open');

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('open');
    });
  }

  async function openClearTilesModal() {
    const modal = $('modal-clear-tiles');
    const listEl = $('clear-tiles-list');
    const summaryEl = $('clear-tiles-total-summary');
    if (!modal || !listEl) return;

    listEl.innerHTML = '<div class="muted">⏳ Анализ кэша карт…</div>';
    modal.classList.add('open');
    pushHistoryState('modal');

    const stats = await WM.cache.getCachedTilesStats();
    listEl.innerHTML = '';

    if (!stats.length) {
      listEl.innerHTML = '<div class="muted">В кэше нет сохранённых тайлов.</div>';
      if (summaryEl) summaryEl.textContent = 'Сохранено: 0 тайлов';
      return;
    }

    const totalCount = stats.reduce((acc, s) => acc + s.count, 0);
    const totalMb = stats.reduce((acc, s) => acc + parseFloat(s.sizeMb), 0).toFixed(1);
    if (summaryEl) summaryEl.textContent = `Всего: ${totalCount} тайлов (~${totalMb} МБ)`;

    stats.forEach(item => {
      const row = el('label', { class: 'toggle-item' },
        el('div', {},
          el('span', { style: 'font-weight: 600; display: block;', text: item.name }),
          el('small', { class: 'hint-text', text: `${item.count} тайлов · ~${item.sizeMb} МБ` })
        ),
        el('input', {
          type: 'checkbox',
          class: 'clear-tile-checkbox',
          'data-provider-id': item.id,
          checked: true // По умолчанию отмечены все
        }),
        el('span', { class: 'toggle-switch' })
      );
      listEl.append(row);
    });
  }

  // =========================================================================
  // ИНТЕРАКТИВНАЯ ЮСТИРОВКА КОМПАСА ПО КАРТЕ
  // =========================================================================
 let initialVisualOffset = 0;
  let isVisualCompassActive = false;

  window.WM = window.WM || {};
  WM.isVisualCompassActive = () => isVisualCompassActive;

  function updateVisualCompassUI(curOffset) {
    const slider = $('vc-hud-slider');
    const badge = $('vc-hud-offset-badge');
    const headingEl = $('vc-hud-heading-val');
    const settingsVal = $('pdr-alignment-offset-val');

    const formattedOffset = (curOffset > 0 ? '+' : '') + curOffset + '°';

    if (slider && parseInt(slider.value, 10) !== curOffset) {
      slider.value = curOffset;
    }
    if (badge) badge.textContent = `Поправка: ${formattedOffset}`;
    if (settingsVal) settingsVal.textContent = formattedOffset;

    const curH = (WM.pdr && WM.pdr.getHeading) ? WM.pdr.getHeading() : null;
    if (headingEl) {
      headingEl.textContent = curH !== null ? `Курс: ${Math.round(curH)}°` : 'Курс: --';
    }

    // Передаем новый курс напрямую для мгновенного поворота без ожидания движения
    if (WM.compass && WM.compass.updateVisuals) {
      WM.compass.updateVisuals(curH);
    }
  }

  function openVisualCompassAdjust() {
    const hud = $('visual-compass-hud');
    if (!hud) return;

    $('modal-compass-adjust')?.classList.remove('open');
    $('modal-pdr-quick')?.classList.remove('open');
    $('modal')?.classList.remove('open');

    initialVisualOffset = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
    isVisualCompassActive = true;
    document.body.classList.add('visual-compass-active');

    if (WM.compass && WM.compass.start) WM.compass.start();
    if (WM.compass && WM.compass.ensureUserMarkerVisible) {
      WM.compass.ensureUserMarkerVisible();
    }

    updateVisualCompassUI(initialVisualOffset);
    hud.hidden = false;
    pushHistoryState('visualCompass');

    showToast('🧭 Вращайте ползунок, совмещая луч с ориентиром на карте', 3000);
  }

  function closeVisualCompassHUD() {
    isVisualCompassActive = false;
    document.body.classList.remove('visual-compass-active');
    const hud = $('visual-compass-hud');
    if (hud) hud.hidden = true;
    clearHistoryState('visualCompass');
  }

  function cancelVisualCompassAdjust() {
    if (!isVisualCompassActive) return;
    if (WM.pdr && WM.pdr.setAlignmentOffset) {
      WM.pdr.setAlignmentOffset(initialVisualOffset);
    }
    closeVisualCompassHUD();
    showToast('Калибровка соосности отменена');
  }
  window.cancelVisualCompassAdjust = cancelVisualCompassAdjust;

  function applyVisualCompassAdjust() {
    if (!isVisualCompassActive) return;
    const finalOffset = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
    closeVisualCompassHUD();
    const formatted = (finalOffset > 0 ? '+' : '') + finalOffset + '°';
    showToast(`✅ Соосность сохранена: ${formatted}`, 2500);
  }

  function initVisualCompassAdjustModule() {
    const hud = $('visual-compass-hud');
    const slider = $('vc-hud-slider');
    if (!hud || hud._inited) return;
    hud._inited = true;

    const setOffset = (val) => {
      let clamped = parseInt(val, 10);
      if (clamped < -180) clamped = -180;
      if (clamped > 180) clamped = 180;
      if (WM.pdr && WM.pdr.setAlignmentOffset) {
        WM.pdr.setAlignmentOffset(clamped);
      }
      updateVisualCompassUI(clamped);
    };

    if (slider) {
      slider.addEventListener('input', (e) => setOffset(e.target.value));
    }

    $('btn-vc-step-minus5')?.addEventListener('click', () => {
      const cur = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
      setOffset(cur - 5);
    });
    $('btn-vc-step-minus1')?.addEventListener('click', () => {
      const cur = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
      setOffset(cur - 1);
    });
    $('btn-vc-step-plus1')?.addEventListener('click', () => {
      const cur = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
      setOffset(cur + 1);
    });
    $('btn-vc-step-plus5')?.addEventListener('click', () => {
      const cur = WM.pdr ? WM.pdr.getAlignmentOffset() : 0;
      setOffset(cur + 5);
    });

    $('btn-vc-reset')?.addEventListener('click', () => setOffset(0));
    $('btn-vc-recenter')?.addEventListener('click', () => {
      if (WM.compass && WM.compass.ensureUserMarkerVisible) {
        WM.compass.ensureUserMarkerVisible();
      }
    });

    $('btn-vc-cancel')?.addEventListener('click', cancelVisualCompassAdjust);
    $('btn-vc-apply')?.addEventListener('click', applyVisualCompassAdjust);

    // Подключение кнопок вызова
    $('btn-adj-map-visual')?.addEventListener('click', openVisualCompassAdjust);
    $('btn-pdr-quick-open-visual-compass')?.addEventListener('click', openVisualCompassAdjust);
    $('btn-open-visual-compass-settings')?.addEventListener('click', openVisualCompassAdjust);
  }

  // =========================================================================
  // ДИАГНОСТИКА ДАТЧИКОВ И ТЕСТЕР ШАГОВ
  // =========================================================================
  // =========================================================================
  // ДИАГНОСТИКА ДАТЧИКОВ, ПРЕСЕТЫ И ТЕСТЕР ШАГОВ
  // =========================================================================
  function initPdrDiagnosticsUI() {
    // 1. Таблица параметров пресетов
    const PDR_PRESETS = {
      walk: {
        title: 'Пешком',
        navigationType: 'step',
        carryingMode: 'hand',
        baseStepLength: 0.75,
        useDynamicStride: true,
        sensitivity: 'normal',
        headingDamping: 'medium',
        stairDetection: true,
        elevatorDetection: true
      },
      run: {
        title: 'Бег / Марш',
        navigationType: 'step',
        carryingMode: 'pocket',
        baseStepLength: 0.95,
        useDynamicStride: true,
        sensitivity: 'low',
        headingDamping: 'high',
        stairDetection: true,
        elevatorDetection: false
      },
      bike: {
        title: 'Велосипед',
        navigationType: 'vehicular',
        vehicularSpeedKmh: 18,
        carryingMode: 'hand',
        baseStepLength: 0.75,
        useDynamicStride: false,
        sensitivity: 'low',
        headingDamping: 'high',
        stairDetection: false,
        elevatorDetection: false
      },
      car: {
        title: 'Автомобиль',
        navigationType: 'vehicular',
        vehicularSpeedKmh: 50,
        carryingMode: 'hand',
        baseStepLength: 0.75,
        useDynamicStride: false,
        sensitivity: 'low',
        headingDamping: 'high',
        stairDetection: false,
        elevatorDetection: false
      }
    };

    function applyPdrPreset(presetKey) {
      const p = PDR_PRESETS[presetKey];
      if (!p) return;

      // Подсветка активной кнопки пресета в сетке
      document.querySelectorAll('.pdr-preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === presetKey);
      });

      const labelEl = $('pdr-preset-current-label');
      if (labelEl) labelEl.textContent = p.title;

      // 1. Положение устройства
      const selCarry = $('pdr-carrying-mode');
      if (selCarry) selCarry.value = p.carryingMode;

      // 2. Длина шага
      const sliderStep = $('pdr-step-length-slider');
      const valStep = $('pdr-step-length-val');
      if (sliderStep) {
        const cm = Math.round(p.baseStepLength * 100);
        sliderStep.value = cm;
        if (valStep) valStep.textContent = cm + ' см';
      }

      // 3. Динамический шаг Weinberg
      const chkDyn = $('toggle-pdr-dynamic-stride');
      if (chkDyn) chkDyn.checked = p.useDynamicStride;

      // 4. Чувствительность
      const selSens = $('pdr-sensitivity-select');
      if (selSens) selSens.value = p.sensitivity;

      // 5. Демпфирование курса
      const selDamp = $('pdr-damping-select');
      if (selDamp) selDamp.value = p.headingDamping;

      // 6. Лестницы и лифты
      const chkStairs = $('toggle-pdr-stairs');
      if (chkStairs) chkStairs.checked = p.stairDetection;

      const chkElev = $('toggle-pdr-elevator');
      if (chkElev) chkElev.checked = p.elevatorDetection;

      // Применяем значения в движке PDR
      if (WM.pdr) {
        WM.pdr.setConfig({
          navigationType: p.navigationType || 'step',
          vehicularSpeedKmh: p.vehicularSpeedKmh || 18,
          carryingMode: p.carryingMode,
          baseStepLength: p.baseStepLength,
          useDynamicStride: p.useDynamicStride,
          sensitivity: p.sensitivity,
          headingDamping: p.headingDamping,
          stairDetection: p.stairDetection,
          elevatorDetection: p.elevatorDetection
        });
      }

      try { localStorage.setItem('wm_pdr_active_preset', presetKey); } catch (e) {}
      showToast(`🚀 Применён пресет: «${p.title}»`);
    }

    // Восстановление активного пресета
    const savedPresetKey = localStorage.getItem('wm_pdr_active_preset') || 'walk';
    const presetLabel = $('pdr-preset-current-label');
    if (presetLabel && PDR_PRESETS[savedPresetKey]) {
      presetLabel.textContent = PDR_PRESETS[savedPresetKey].title;
    }

    const chkStepPill = $('toggle-pdr-step-pill');
    if (chkStepPill) {
      chkStepPill.checked = localStorage.getItem('wm_pdr_step_pill') === 'true';
      chkStepPill.onchange = (e) => {
        const val = e.target.checked;
        localStorage.setItem('wm_pdr_step_pill', val ? 'true' : 'false');
        if (window.WM && WM.setPdrStepPillEnabled) WM.setPdrStepPillEnabled(val);
        const quickChk = $('pdr-quick-toggle-step-pill');
        if (quickChk) quickChk.checked = val;
        showToast(val ? '👣 Плашка шагов PDR включена' : '👣 Плашка шагов PDR выключена');
      };
    }

    // Получаем текущую конфигурацию PDR (если движок инициализирован)
    const cfg = WM.pdr ? WM.pdr.getConfig() : {};

    const selHeadingSource = $('pdr-heading-source-select');
    const hintHeadingSource = $('pdr-heading-source-hint');
    if (selHeadingSource) {
      selHeadingSource.value = cfg.headingSource || 'fusion';
      selHeadingSource.onchange = (e) => {
        const val = e.target.value;
        if (WM.pdr) WM.pdr.setConfig({ headingSource: val });
        if (hintHeadingSource) {
          hintHeadingSource.textContent = val === 'compass'
            ? '«Только компас» отключает гироскоп и стабилизирует курс адаптивным фильтром. Подходит при дрейфе или плохом гироскопе.'
            : '«Гироскоп + Компас» даёт максимальную плавность и быстроту реакции благодаря слиянию датчиков. Может плохо работать на бюджетных устройствах или при особенностях гироскопа.';
        }
        showToast(val === 'compass' ? '🧭 Режим курса: Только компас' : '🧭 Режим курса: Гироскоп + Компас');
      };
    }

    const selMov = $('pdr-movement-type-select');
    const hintMov = $('pdr-movement-type-hint');
    if (selMov) {
      selMov.value = cfg.movementType || 'normal';
      selMov.onchange = (e) => {
        const val = e.target.value;
        if (WM.pdr) WM.pdr.setConfig({ movementType: val });
        if (hintMov) {
          if (val === 'straight') hintMov.textContent = '«По прямой» держит генеральный курс и игнорирует виляние при обходе препятствий.';
          else if (val === 'chaotic') hintMov.textContent = '«Маневренный» мгновенно чертит любой резкий поворот.';
          else hintMov.textContent = 'Стандартный сбалансированный режим.';
        }
        // Синхронизация с быстрым меню
        document.querySelectorAll('#pdr-quick-movement-segmented .pdr-quick-seg-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mov === val);
        });
        updatePdrQuickMovHint(val);
        showToast(`🧭 Режим движения: ${selMov.options[selMov.selectedIndex].text.split(' ')[1]}`);
      };
    }

    const btnOpenCompassAdjSettings = $('btn-open-compass-adjust-settings');
    if (btnOpenCompassAdjSettings) {
      btnOpenCompassAdjSettings.onclick = () => {
        if (window.openCompassAdjustModal) {
          window.openCompassAdjustModal();
        }
      };
    }

    const btnOpenLogger = $('btn-open-imu-logger');
    if (btnOpenLogger && WM.imuLogger) {
      btnOpenLogger.onclick = () => WM.imuLogger.openModal();
    }

    document.querySelectorAll('.pdr-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === savedPresetKey);
      btn.onclick = () => {
        applyPdrPreset(btn.dataset.preset);
      };
    });

    // Виброотклик: шаг и навигация
    const chkStepVibe = $('toggle-pdr-step-vibe');
    if (chkStepVibe) {
      chkStepVibe.checked = WM.pdr ? (WM.pdr.getConfig().stepVibration !== false) : true;
      chkStepVibe.onchange = (e) => {
        if (WM.pdr) WM.pdr.setConfig({ stepVibration: e.target.checked });
        showToast(e.target.checked ? '📳 Вибрация при шаге включена' : '🔕 Вибрация при шаге выключена');
      };
    }

    const selNavVibroMode = $('nav-vibro-mode-select');
    const wrapVibroCone = $('nav-vibro-cone-wrap');
    const wrapVibroInt = $('nav-vibro-interval-wrap');
    const hintNavVibro = $('nav-vibro-mode-hint');

    function updateNavVibroVisibility() {
      const mode = selNavVibroMode ? selNavVibroMode.value : 'off';
      if (wrapVibroCone) wrapVibroCone.hidden = (mode === 'off');
      if (wrapVibroInt) wrapVibroInt.hidden = (mode !== 'correct');
      if (hintNavVibro) {
        if (mode === 'correct') {
          hintNavVibro.textContent = 'Мягкий периодический вибросигнал, пока вы идёте прямо к цели.';
        } else if (mode === 'deviation') {
          hintNavVibro.textContent = 'Влево — один импульс, вправо — двойной импульс при сходе с линии.';
        } else {
          hintNavVibro.textContent = 'Тактильные сигналы маршрута и цели полностью отключены.';
        }
      }
    }

    if (selNavVibroMode && WM.navVibro) {
      selNavVibroMode.value = WM.navVibro.getMode();
      updateNavVibroVisibility();
      selNavVibroMode.onchange = (e) => {
        WM.navVibro.setMode(e.target.value);
        updateNavVibroVisibility();
      };
    }

    const sliderCone = $('nav-vibro-cone-slider');
    const valCone = $('nav-vibro-cone-val');
    if (sliderCone && valCone && WM.navVibro) {
      sliderCone.value = WM.navVibro.getCone();
      valCone.textContent = `±${sliderCone.value}°`;
      sliderCone.oninput = (e) => {
        valCone.textContent = `±${e.target.value}°`;
        WM.navVibro.setCone(parseInt(e.target.value, 10));
      };
    }

    const sliderInterval = $('nav-vibro-interval-slider');
    const valInterval = $('nav-vibro-interval-val');
    if (sliderInterval && valInterval && WM.navVibro) {
      sliderInterval.value = WM.navVibro.getInterval();
      valInterval.textContent = `каждые ${sliderInterval.value} сек`;
      sliderInterval.oninput = (e) => {
        valInterval.textContent = `каждые ${e.target.value} сек`;
        WM.navVibro.setInterval(parseInt(e.target.value, 10));
      };
    }

    // 2. Системные опции экрана, звука и фона
    const chkSoundTop = $('toggle-pdr-step-sound');
    if (chkSoundTop) {
      chkSoundTop.checked = WM.pdr ? WM.pdr.isSoundEnabled() : true;
      chkSoundTop.onchange = (e) => {
        if (WM.pdr && WM.pdr.setSoundEnabled) {
          WM.pdr.setSoundEnabled(e.target.checked);
        }
        showToast(e.target.checked ? '🔊 Звук шага включён' : '🔇 Звук шага выключен');
      };
    }

    const chkWakeLock = $('toggle-pdr-wakelock');
    if (chkWakeLock) {
      // По умолчанию ВЫКЛЮЧЕН (не держит экран впустую)
      const isWake = localStorage.getItem('wm_pdr_wakelock') === 'true';
      chkWakeLock.checked = isWake;
      chkWakeLock.onchange = (e) => {
        localStorage.setItem('wm_pdr_wakelock', e.target.checked ? 'true' : 'false');
        if (window.WM && WM.syncWakeLockState) {
          WM.syncWakeLockState();
        }
        showToast(e.target.checked ? '🔆 Экран всегда включён' : 'Экран гаснет по таймеру ОС (кроме навигации)');
      };
    }

    const chkBg = $('toggle-pdr-background');
    if (chkBg) {
      const isBg = localStorage.getItem('wm_pdr_background') === 'true';
      chkBg.checked = isBg;
      chkBg.onchange = (e) => {
        const isCapacitor = window.Capacitor !== undefined || /wv|Android.*Version\/[0-9.]+/i.test(navigator.userAgent);
        if (!isCapacitor && e.target.checked) {
          showToast('⚠️ Фоновый режим в браузере ограничен ОС (доступен в APK)');
        }
        localStorage.setItem('wm_pdr_background', e.target.checked ? 'true' : 'false');
      };
    }

    // 3. Элементы телеметрии и проверки датчиков
    const permStatusEl = $('pdr-perm-status');
    const btnPerm = $('btn-pdr-request-perms');
    const valAccel = $('pdr-val-accel');
    const valMag = $('pdr-val-mag');
    const valHeading = $('pdr-val-heading');
    const valTilt = $('pdr-val-tilt');

    const btnTest = $('btn-pdr-test-toggle');
    const countEl = $('pdr-test-step-count');
    const flashEl = $('pdr-step-flash');
    const strideEl = $('pdr-test-stride');
    const cadenceEl = $('pdr-test-cadence');
    const bearingEl = $('pdr-test-bearing');
    const gaugeFill = $('pdr-gauge-fill');
    const gaugeVal = $('pdr-gauge-val');
    const gaugeThreshold = $('pdr-gauge-threshold');
    const btnReset = $('btn-pdr-test-reset');

    const btnAlign = $('btn-alignment-test-toggle');
    const stepsAlign = $('alignment-test-steps');
    const resAlign = $('alignment-test-result');
    const sliderOffset = $('pdr-alignment-offset-slider');
    const valOffset = $('pdr-alignment-offset-val');
    const chkDecl = $('toggle-pdr-declination');
    const declText = $('pdr-magnetic-declination-text');
    const chkStairs = $('toggle-pdr-stairs');
    const chkElev = $('toggle-pdr-elevator');

    let isTesting = false;
    let testSteps = 0;
    let testStartTime = 0;
    let flashTimer = null;

    function checkSensors() {
      const isHttps = window.isSecureContext !== false;
      const hasMotion = 'DeviceMotionEvent' in window || 'ondevicemotion' in window;
      const hasOrientation = 'DeviceOrientationEvent' in window || 'ondeviceorientation' in window;

      if (!permStatusEl) return;
      if (!isHttps) {
        permStatusEl.innerHTML = '⚠️ Требуется HTTPS или запуск в приложении (датчики заблокированы браузером)';
        permStatusEl.style.color = 'var(--danger)';
      } else if (hasMotion && hasOrientation) {
        permStatusEl.innerHTML = '🟢 Датчики движения и компас поддерживаются устройством';
        permStatusEl.style.color = '#16a34a';
      } else {
        permStatusEl.innerHTML = '🟡 Частичная поддержка (отсутствует гироскоп или акселерометр)';
      }
    }
    checkSensors();

    if (btnPerm) {
      btnPerm.onclick = async () => {
        if (WM.pdr && WM.pdr.requestPermissions) {
          const res = await WM.pdr.requestPermissions();
          if (res.motion && res.orientation) {
            permStatusEl.innerHTML = '🟢 Доступ к датчикам успешно предоставлен!';
            permStatusEl.style.color = '#16a34a';
            showToast('✅ Доступ к датчикам движения предоставлен');
          } else {
            showToast('⚠️ Разрешение не получено или отклонено');
          }
        }
      };
    }



    // 4. Инициализация параметров PDR-движка
    if (WM.pdr) {
      const cfg = WM.pdr.getConfig();
      if (sliderOffset && valOffset) {
        sliderOffset.value = cfg.alignmentOffset || 0;
        valOffset.textContent = (cfg.alignmentOffset > 0 ? '+' : '') + cfg.alignmentOffset + '°';
        sliderOffset.oninput = (e) => {
          const val = parseInt(e.target.value, 10);
          valOffset.textContent = (val > 0 ? '+' : '') + val + '°';
          WM.pdr.setConfig({ alignmentOffset: val });
        };
      }

      if (declText) {
        const d = WM.pdr.getMagneticDeclination();
        declText.textContent = `Автоматическая поправка к истинному Северу (${d >= 0 ? '+' : ''}${d}°)`;
      }

      if (chkDecl) {
        chkDecl.checked = cfg.useMagneticDeclination !== false;
        chkDecl.onchange = (e) => WM.pdr.setConfig({ useMagneticDeclination: e.target.checked });
      }

      if (chkStairs) {
        chkStairs.checked = cfg.stairDetection !== false;
        chkStairs.onchange = (e) => WM.pdr.setConfig({ stairDetection: e.target.checked });
      }

      if (chkElev) {
        chkElev.checked = cfg.elevatorDetection !== false;
        chkElev.onchange = (e) => WM.pdr.setConfig({ elevatorDetection: e.target.checked });
      }

      const selSens = $('pdr-sensitivity-select');
      if (selSens) {
        selSens.value = cfg.sensitivity || 'normal';
        selSens.onchange = (e) => {
          WM.pdr.setConfig({ sensitivity: e.target.value });
          showToast(`🎯 Чувствительность: ${selSens.options[selSens.selectedIndex].text.split(' ')[0]}`);
        };
      }

      const selCarry = $('pdr-carrying-mode');
      if (selCarry) {
        selCarry.value = cfg.carryingMode || 'hand';
        selCarry.onchange = (e) => {
          WM.pdr.setConfig({ carryingMode: e.target.value });
        };
      }



      const sliderStep = $('pdr-step-length-slider');
      const valStep = $('pdr-step-length-val');
      if (sliderStep) {
        const curCm = Math.round((cfg.baseStepLength || 0.75) * 100);
        sliderStep.value = curCm;
        if (valStep) valStep.textContent = curCm + ' см';
        sliderStep.oninput = (e) => {
          const val = parseFloat(e.target.value);
          if (valStep) valStep.textContent = val + ' см';
          WM.pdr.setConfig({ baseStepLength: val / 100 });
        };
      }

      const selDamp = $('pdr-damping-select');
      if (selDamp) {
        selDamp.value = cfg.headingDamping || 'medium';
        selDamp.onchange = (e) => {
          WM.pdr.setConfig({ headingDamping: e.target.value });
        };
      }

      const chkDynStride = $('toggle-pdr-dynamic-stride');
      if (chkDynStride) {
        chkDynStride.checked = cfg.useDynamicStride !== false;
        chkDynStride.onchange = (e) => {
          WM.pdr.setConfig({ useDynamicStride: e.target.checked });
        };
      }
    }

    // 5. Тест соосности (Alignment Walk)
    // =========================================================================
    // МАСТЕР КАЛИБРОВКИ ТРЕУГОЛЬНИКОМ (3 ТОЧКИ)
    // =========================================================================
    const modalSettings = $('modal');
    const modalTri = $('modal-triangle-calib');
    const btnOpenTri = $('btn-open-triangle-calib');
    const btnCloseTriX = $('triangle-calib-close-x');
    const btnCancelTri = $('btn-triangle-cancel');
    const btnActionTri = $('btn-triangle-action');

    const stepSetupEl = $('triangle-step-setup');
    const stepWalkingEl = $('triangle-step-walking');
    const stepResultEl = $('triangle-step-result');

    const btnSetA = $('btn-triangle-set-a');
    const btnSetB = $('btn-triangle-set-b');
    const btnSetC = $('btn-triangle-set-c');
    const lblA = $('lbl-triangle-pt-a');
    const lblB = $('lbl-triangle-pt-b');
    const lblC = $('lbl-triangle-pt-c');

    const curStageText = $('triangle-current-stage-text');
    const legDistText = $('triangle-leg-dist-text');
    const liveWalkedEl = $('triangle-live-walked');
    const resultDetailsEl = $('triangle-result-details');

    // Элементы плавающего HUD на карте
    const triPickerHud = $('triangle-picker-hud');
    const triPickerBadge = $('tri-picker-badge');
    const triPickerTitle = $('tri-picker-title');
    const triPickerCoords = $('tri-picker-coords');
    const btnTriPickerOk = $('btn-tri-picker-ok');
    const btnTriPickerCancel = $('btn-tri-picker-cancel');

    let points = { A: null, B: null, C: null };
    let walkStage = 0;
    let triLayer = null;
    let wasPdrActiveBefore = false;
    let triUiTimer = null;
    let currentPickingChar = null; // 'A' | 'B' | 'C'
    let previousCrosshairHidden = false;

    function getCenterLL() {
      return WM.map ? WM.map.getCenter() : { lat: 0, lng: 0 };
    }

    function calculateBearingDeg(from, to) {
      const lat1 = from.lat * Math.PI / 180;
      const lat2 = to.lat * Math.PI / 180;
      const dLng = (to.lng - from.lng) * Math.PI / 180;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    function redrawTrianglePreview() {
      if (!triLayer && WM.map) {
        triLayer = L.layerGroup().addTo(WM.map);
      }
      if (triLayer) triLayer.clearLayers();

      const charKeys = ['A', 'B', 'C'];
      const pts = [];

      charKeys.forEach(char => {
        const pt = points[char];
        if (pt) {
          pts.push({ char, pt });
          L.marker(pt, {
            icon: L.divIcon({
              className: 'wm-triangle-pin-icon',
              html: `<div class="wm-triangle-pin-badge">${char}</div>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13]
            }),
            interactive: false
          }).addTo(triLayer);
        }
      });

      // Соединительные пунктирные линии и мерные плашки
      if (points.A && points.B) {
        drawLeg(points.A, points.B, 'AB');
      }
      if (points.B && points.C) {
        drawLeg(points.B, points.C, 'BC');
      }
      if (points.C && points.A) {
        drawLeg(points.C, points.A, 'CA');
      }

      function drawLeg(p1, p2, label) {
        L.polyline([p1, p2], {
          color: '#10b981',
          dashArray: '6, 6',
          weight: 2.5,
          interactive: false
        }).addTo(triLayer);

        const mid = L.latLng((p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2);
        const distM = Math.round(p1.distanceTo(p2));
        L.marker(mid, {
          icon: L.divIcon({
            className: 'wm-triangle-pin-icon',
            html: `<div class="wm-triangle-leg-badge">${distM} м</div>`,
            iconSize: [50, 20],
            iconAnchor: [25, 10]
          }),
          interactive: false
        }).addTo(triLayer);
      }

      if (btnActionTri) {
        btnActionTri.disabled = !(points.A && points.B && points.C);
      }
    }

    function updatePointsLabels() {
      if (lblA) {
        if (points.A) {
          lblA.textContent = `${points.A.lat.toFixed(5)}, ${points.A.lng.toFixed(5)} ✓`;
          lblA.style.color = '#10b981';
        } else {
          lblA.textContent = 'Не задана';
          lblA.style.color = 'var(--text-muted)';
        }
      }
      if (lblB) {
        if (points.B) {
          const d = points.A ? ` (${Math.round(points.A.distanceTo(points.B))} м)` : '';
          lblB.textContent = `Установлена${d} ✓`;
          lblB.style.color = '#10b981';
        } else {
          lblB.textContent = 'Не задана';
          lblB.style.color = 'var(--text-muted)';
        }
      }
      if (lblC) {
        if (points.C) {
          const d = points.B ? ` (${Math.round(points.B.distanceTo(points.C))} м)` : '';
          lblC.textContent = `Установлена${d} ✓`;
          lblC.style.color = '#10b981';
        } else {
          lblC.textContent = 'Не задана';
          lblC.style.color = 'var(--text-muted)';
        }
      }
    }

    function onMapMoveTriPicker() {
      if (!triPickerCoords || !WM.map) return;
      const c = WM.map.getCenter();
      triPickerCoords.textContent = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
    }

    function startTrianglePointPicker(char) {
      currentPickingChar = char;
      const pointTitles = {
        A: 'Точка A (Старт)',
        B: 'Точка B (Второй ориентир)',
        C: 'Точка C (Третий ориентир)'
      };

      // Временно скрываем модальные окна, чтобы открыть обзор карты
      if (modalTri) modalTri.classList.remove('open');
      if (modalSettings) modalSettings.classList.remove('open');

      // Показываем прицел в центре
      const crosshair = $('crosshair');
      if (crosshair) {
        previousCrosshairHidden = crosshair.hidden;
        crosshair.hidden = false;
      }

      // Если точка уже была выбрана ранее — центрируем карту на ней
      if (points[char] && WM.map) {
        WM.map.panTo(points[char]);
      }

      // Обновляем плашку HUD
      if (triPickerBadge) triPickerBadge.textContent = `Точка ${char}`;
      if (triPickerTitle) triPickerTitle.textContent = pointTitles[char] || `Ориентир ${char}`;
      onMapMoveTriPicker();

      if (WM.map) WM.map.on('move', onMapMoveTriPicker);
      if (triPickerHud) triPickerHud.hidden = false;

      redrawTrianglePreview();
      showToast(`🎯 Наведите прицел на ${pointTitles[char]} и нажмите «OK»`);
    }

    function cancelTrianglePointPicker() {
      if (WM.map) WM.map.off('move', onMapMoveTriPicker);
      if (triPickerHud) triPickerHud.hidden = true;

      const crosshair = $('crosshair');
      if (crosshair) crosshair.hidden = previousCrosshairHidden;

      // Возвращаем модальные окна обратно
      if (modalSettings) modalSettings.classList.add('open');
      if (modalTri) modalTri.classList.add('open');
      currentPickingChar = null;
    }
    window.cancelTrianglePointPicker = cancelTrianglePointPicker;

    function confirmTrianglePointPicker() {
      if (!currentPickingChar) return;
      const c = getCenterLL();
      points[currentPickingChar] = L.latLng(c.lat, c.lng);

      if (WM.map) WM.map.off('move', onMapMoveTriPicker);
      if (triPickerHud) triPickerHud.hidden = true;

      const crosshair = $('crosshair');
      if (crosshair) crosshair.hidden = previousCrosshairHidden;

      redrawTrianglePreview();
      updatePointsLabels();

      // Возвращаем модальные окна
      if (modalSettings) modalSettings.classList.add('open');
      if (modalTri) modalTri.classList.add('open');

      showToast(`✅ Точка ${currentPickingChar} успешно зафиксирована`);
      currentPickingChar = null;
    }

    // Слушатели кнопок выбора ориентиров A, B, C
    if (btnSetA) btnSetA.onclick = () => startTrianglePointPicker('A');
    if (btnSetB) btnSetB.onclick = () => startTrianglePointPicker('B');
    if (btnSetC) btnSetC.onclick = () => startTrianglePointPicker('C');

    // Кнопки управления в плавающем HUD на карте
    if (btnTriPickerOk) btnTriPickerOk.onclick = confirmTrianglePointPicker;
    if (btnTriPickerCancel) btnTriPickerCancel.onclick = cancelTrianglePointPicker;

    function closeTriangleModal() {
      if (triUiTimer) {
        clearInterval(triUiTimer);
        triUiTimer = null;
      }
      if (modalTri) modalTri.classList.remove('open');
      if (triLayer) triLayer.clearLayers();
      if (WM.pdr && WM.pdr.isTriangleCalibrating()) {
        WM.pdr.cancelTriangleCalibration();
      }
      if (!wasPdrActiveBefore && WM.pdr && WM.pdr.isActive()) {
        WM.pdr.stop();
      }
      walkStage = 0;
    }

    if (btnOpenTri) {
      btnOpenTri.onclick = () => {
        points = { A: null, B: null, C: null };
        walkStage = 0;
        updatePointsLabels();
        if (stepSetupEl) stepSetupEl.hidden = false;
        if (stepWalkingEl) stepWalkingEl.hidden = true;
        if (stepResultEl) stepResultEl.hidden = true;
        if (btnActionTri) {
          btnActionTri.textContent = 'Начать калибровку';
          btnActionTri.disabled = true;
        }
        if (modalTri) modalTri.classList.add('open');
        redrawTrianglePreview();
      };
    }

    if (btnCloseTriX) btnCloseTriX.onclick = closeTriangleModal;
    if (btnCancelTri) btnCancelTri.onclick = closeTriangleModal;

    if (btnActionTri) {

      function updateLiveWalkedUI() {
        if (!liveWalkedEl || !WM.pdr || !WM.pdr.getTriangleCurrentLegStats) return;
        const stats = WM.pdr.getTriangleCurrentLegStats();
        liveWalkedEl.textContent = `Пройдено: ${stats.steps} шагов (~${Math.round(stats.dist)} м)`;
      }

      btnActionTri.onclick = async () => {
        // 1. Старт из точки A в сторону B
        if (walkStage === 0) {
          if (WM.pdr && WM.pdr.requestPermissions) await WM.pdr.requestPermissions();
          wasPdrActiveBefore = WM.pdr && WM.pdr.isActive();
          if (WM.pdr && !WM.pdr.isActive()) {
            WM.pdr.start(() => updateLiveWalkedUI());
          }

          walkStage = 1;
          if (stepSetupEl) stepSetupEl.hidden = true;
          if (stepWalkingEl) stepWalkingEl.hidden = false;

          if (curStageText) curStageText.textContent = '1/3: Идите в точку B';
          const dAB = Math.round(points.A.distanceTo(points.B));
          if (legDistText) legDistText.textContent = `${dAB} м по карте`;

          btnActionTri.textContent = 'Я прибыл в точку B ✓';
          WM.pdr.startTriangleLeg();
          updateLiveWalkedUI();
          triUiTimer = setInterval(updateLiveWalkedUI, 500);
          showToast('🚶 Начните естественное движение к ориентиру B');
        }
        // 2. Дошли до B, начинаем отрезок B -> C
        else if (walkStage === 1) {
          const dAB = points.A.distanceTo(points.B);
          const bAB = calculateBearingDeg(points.A, points.B);
          WM.pdr.finishTriangleLeg(dAB, bAB);

          walkStage = 2;
          if (curStageText) curStageText.textContent = '2/3: Идите в точку C';
          const dBC = Math.round(points.B.distanceTo(points.C));
          if (legDistText) legDistText.textContent = `${dBC} м по карте`;

          btnActionTri.textContent = 'Я прибыл в точку C ✓';
          WM.pdr.startTriangleLeg();
          updateLiveWalkedUI();
          showToast('🚶 Начните движение к ориентиру C');
        }
        // 3. Дошли до C, возвращаемся C -> A
        else if (walkStage === 2) {
          const dBC = points.B.distanceTo(points.C);
          const bBC = calculateBearingDeg(points.B, points.C);
          WM.pdr.finishTriangleLeg(dBC, bBC);

          walkStage = 3;
          if (curStageText) curStageText.textContent = '3/3: Возвращайтесь в точку A';
          const dCA = Math.round(points.C.distanceTo(points.A));
          if (legDistText) legDistText.textContent = `${dCA} м по карте`;

          btnActionTri.textContent = 'Я вернулся в точку A ✓';
          WM.pdr.startTriangleLeg();
          updateLiveWalkedUI();
          showToast('🚶 Замкните контур, вернувшись в точку A');
        }
        // 4. Завершение и расчет
        else if (walkStage === 3) {
          if (triUiTimer) clearInterval(triUiTimer);
          const dCA = points.C.distanceTo(points.A);
          const bCA = calculateBearingDeg(points.C, points.A);
          WM.pdr.finishTriangleLeg(dCA, bCA);

          const res = WM.pdr.computeTriangleCalibration();
          walkStage = 4;

          if (stepWalkingEl) stepWalkingEl.hidden = true;
          if (stepResultEl) stepResultEl.hidden = false;
          btnActionTri.textContent = 'Применить и закрыть';

          if (res) {
            if (resultDetailsEl) {
              resultDetailsEl.innerHTML = `
                <div>• Дистанция ориентиров: <b>${res.totalGroundDist} м</b></div>
                <div>• Зафиксировано шагов: <b>${res.totalSteps}</b></div>
                <div>• Новая длина шага: <b>${Math.round(res.newStep * 100)} см</b> (было ${Math.round(res.oldStep * 100)} см)</div>
                <div>• Поправка соосности: <b>${res.offsetApplied > 0 ? '+' : ''}${res.offsetApplied}°</b> (итог: ${res.finalOffset}°)</div>
              `;
            }

            const sliderStep = $('pdr-step-length-slider');
            const valStep = $('pdr-step-length-val');
            if (sliderStep && valStep) {
              const cm = Math.round(res.newStep * 100);
              sliderStep.value = cm;
              valStep.textContent = cm + ' см';
            }
            const sliderOff = $('pdr-alignment-offset-slider');
            const valOff = $('pdr-alignment-offset-val');
            if (sliderOff && valOff) {
              sliderOff.value = res.finalOffset;
              valOff.textContent = (res.finalOffset > 0 ? '+' : '') + res.finalOffset + '°';
            }
          } else {
            if (resultDetailsEl) {
              resultDetailsEl.innerHTML = `
                <div style="color:var(--danger);">⚠️ Недостаточно данных о шагах. Убедитесь, что датчики включены, и повторите калибровку.</div>
              `;
            }
          }
        }
        // 5. Закрытие после подтверждения
        else if (walkStage === 4) {
          closeTriangleModal();
          showToast('✅ Новые параметры навигации применены');
        }
      };
    }
    // 6. Телеметрия через requestAnimationFrame
    let telemRaf = 0;
    let latestTelem = null;

    function handleTelemetryUpdate(data) {
      latestTelem = data;
      if (!telemRaf) {
        telemRaf = requestAnimationFrame(() => {
          telemRaf = 0;
          if (!latestTelem) return;
          const d = latestTelem;

          if (valAccel) {
            valAccel.textContent = `X: ${d.ax.toFixed(1)} | Y: ${d.ay.toFixed(1)} | Z: ${d.az.toFixed(1)}`;
          }
          if (valMag) {
            valMag.textContent = d.isBlockedByZupt 
              ? `${d.dynMag.toFixed(2)} м/с² (Стоянка/ZUPT)` 
              : `${d.dynMag.toFixed(2)} м/с²`;
          }
          if (valHeading && d.heading !== null && !isNaN(d.heading)) {
            valHeading.textContent = `${Math.round(d.heading)}°`;
          }
          if (gaugeFill && gaugeVal) {
            const maxScale = 3.5;
            const pct = Math.min(100, Math.round((d.dynMag / maxScale) * 100));
            gaugeFill.style.width = pct + '%';
            gaugeVal.textContent = `${d.dynMag.toFixed(2)} м/с²`;

            if (gaugeThreshold && d.threshold) {
              const threshPct = Math.min(100, Math.round((d.threshold / maxScale) * 100));
              gaugeThreshold.style.left = threshPct + '%';
            }
          }
        });
      }
    }

    // Слушатель открытия/закрытия настроек для управления телеметрией
    function handleTiltReading(e) {
      if (valTilt && e.beta !== null && e.gamma !== null) {
        valTilt.textContent = `${Math.round(e.beta)}° / ${Math.round(e.gamma)}°`;
      }
    }

    // Слушатель открытия/закрытия настроек: включаем датчики наклона и телеметрию ТОЛЬКО когда окно открыто
    const modalSettingsEl = $('modal');
    if (modalSettingsEl) {
      const observer = new MutationObserver(() => {
        const isOpen = modalSettingsEl.classList.contains('open');
        if (WM.pdr) {
          WM.pdr.setTelemetryCallback(isOpen ? handleTelemetryUpdate : null);
        }
        if (isOpen) {
          window.addEventListener('deviceorientation', handleTiltReading, { passive: true });
        } else {
          window.removeEventListener('deviceorientation', handleTiltReading);
        }
      });
      observer.observe(modalSettingsEl, { attributes: true, attributeFilter: ['class'] });
    }

    function onTestStep(strideMeters, headingDeg) {
      testSteps++;
      if (countEl) countEl.textContent = testSteps;
      if (strideEl) strideEl.textContent = Math.round(strideMeters * 100) + ' см';
      if (bearingEl) bearingEl.textContent = Math.round(headingDeg) + '°';

      const elapsedMinutes = (Date.now() - testStartTime) / 60000;
      if (elapsedMinutes > 0 && cadenceEl) {
        const cadence = Math.round(testSteps / elapsedMinutes);
        cadenceEl.textContent = cadence + ' ш/мин';
      }

      if (flashEl) {
        flashEl.classList.add('active');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => flashEl.classList.remove('active'), 280);
      }
      if (navigator.vibrate) navigator.vibrate(30);
    }

    // 7. Интерактивный запуск теста шагов
    if (btnTest) {
      btnTest.onclick = async () => {
        if (!WM.pdr) return;
        if (isTesting) {
          isTesting = false;
          btnTest.textContent = '▶ Старт теста';
          btnTest.classList.remove('btn-danger');
          btnTest.classList.add('btn-primary');
          WM.pdr.stop();
          showToast('⏹️ Тестирование остановлено');
        } else {
          if (WM.pdr.requestPermissions) {
            await WM.pdr.requestPermissions();
          }

          isTesting = true;
          testSteps = 0;
          testStartTime = Date.now();
          if (countEl) countEl.textContent = '0';
          if (cadenceEl) cadenceEl.textContent = '0 ш/мин';
          btnTest.textContent = '⏹ Стоп теста';
          btnTest.classList.remove('btn-primary');
          btnTest.classList.add('btn-danger');

          WM.pdr.start(onTestStep, (h) => {
            if (valHeading) valHeading.textContent = Math.round(h) + '°';
          });
          showToast('🚶 Сделайте несколько шагов с устройством в руке или кармане');
        }
      };
    }

    if (btnReset) {
      btnReset.onclick = () => {
        testSteps = 0;
        testStartTime = Date.now();
        if (countEl) countEl.textContent = '0';
        if (cadenceEl) cadenceEl.textContent = '0 ш/мин';
      };
    }
  }

  function updateMotionBtnState() {
    const btn = $('btn-motion-toggle');
    if (!btn) return;

    const tailOn = WM.motionTail ? WM.motionTail.isEnabled() : false;
    const vectorOn = WM.motionVector ? WM.motionVector.isEnabled() : false;

    if (tailOn && !vectorOn) {
      // Состояние 1: Только хвост
      btn.textContent = '🐾';
      btn.classList.add('active');
      btn.title = 'Режим: Хвост движения (нажмите для смены на траекторию)';
    } else if (vectorOn) {
      // Состояние 2: Только стрелочка (траектория)
      btn.textContent = '↗️';
      btn.classList.add('active');
      btn.title = 'Режим: Траектория курса (нажмите для выключения)';
    } else {
      // Состояние 0: Выключено
      btn.textContent = '🐾';
      btn.classList.remove('active');
      btn.title = 'Хвост и траектория выключены (нажмите для включения хвоста)';
    }
  }



  function updateManualPdrBtnState() {
    const btn = $('btn-manual-pdr');
    if (!btn) return;
    const isPdr = WM.manualPdr ? WM.manualPdr.isActive() : false;
    const isSpoof = WM.antiSpoof ? WM.antiSpoof.isSpoofed() : false;
    const active = isPdr || isSpoof;
    btn.classList.toggle('active', active);

    if (isSpoof) {
      btn.title = '⚠️ Глушение GPS активно (нажмите, чтобы снять режим и вернуться к GPS)';
    } else if (isPdr) {
      btn.title = '📍 Ведение по датчикам активно (нажмите для возврата к GPS)';
    } else {
      btn.title = '📍 Поместить точку GPS сюда\nПривязать координаты к центру и включить шагомер';
    }
  }

  
  

  function setMotionMode(tailOn, vectorOn) {
    if (WM.motionTail) WM.motionTail.setEnabled(tailOn);
    if (WM.motionVector) WM.motionVector.setEnabled(vectorOn);

    uiVis.motiontail = tailOn;
    uiVis.motionvector = vectorOn;
    WM.api.store.set('wm_ui_vis', JSON.stringify(uiVis));
    try { localStorage.setItem('wm_tail_enabled', tailOn ? 'true' : 'false'); } catch (e) {}

    const chkTail = $('toggle-ui-motiontail');
    const subTail = $('sub-motiontail-settings');
    if (chkTail) {
      chkTail.checked = tailOn;
      if (subTail) subTail.hidden = !tailOn;
    }
    const chkVector = $('toggle-ui-motionvector');
    if (chkVector) chkVector.checked = vectorOn;

    if (WM.gpsDist && WM.gpsDist.refresh) WM.gpsDist.refresh();
    updateMotionBtnState();
  }

  function cycleMotionMode() {
    const tailOn = WM.motionTail ? WM.motionTail.isEnabled() : false;
    const vectorOn = WM.motionVector ? WM.motionVector.isEnabled() : false;

    if (tailOn && !vectorOn) {
      // Был только хвост -> переключаем на траекторию
      setMotionMode(true, true);
      showToast('↗️ Включена траектория движения');
    } else if (vectorOn) {
      // Была траектория -> выключаем всё
      setMotionMode(false, false);
      showToast('🛑 Хвост и траектория выключены');
    } else {
      // Было выключено -> включаем хвост
      setMotionMode(true, false);
      showToast('🐾 Включён хвост движения');
    }
  }

  // =========================================================================
  // ТЕСТОВЫЙ МОДУЛЬ ДЛЯ СЛОЯ РАСТЕНИЙ И ГРИБОВ (iNaturalist API)
  // =========================================================================
  function initINaturalistUI() {
    // Распознавание видов по фото (iNaturalist Vision)
    WM.inat?.initVisionUI?.();

    // 1. Главный тумблер включения/выключения слоя
    $('toggle-inat-layer-enable')?.addEventListener('change', (e) => {
      if (e.target.checked) WM.inat?.enable();
      else WM.inat?.disable();
    });

    $('inat-zoom-out-mode')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ zoomOutMode: e.target.value });
    });
    $('inat-filter-phenology')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ phenology: e.target.value });
    });



    const selSelectMode = $('inat-select-mode');
    const hintSelectMode = $('inat-select-mode-hint');
    if (selSelectMode) {
      const updateHint = (val) => {
        if (!hintSelectMode) return;
        if (val === 'crosshair') {
          hintSelectMode.textContent = 'Перекрестием: наведите прицел в центре экрана на облачко и нажмите на экран для открытия карточки';
        } else if (val === 'click') {
          hintSelectMode.textContent = 'Кликом: нажимайте пальцем или мышью прямо на облачко/метку на карте';
        } else {
          hintSelectMode.textContent = 'Оба варианта: карточку можно открыть и перекрестием в центре, и прямым нажатием на облачко';
        }
      };

      selSelectMode.addEventListener('change', (e) => {
        const val = e.target.value;
        WM.inat?.setConfig({ selectMode: val });
        updateHint(val);
        const titles = {
          crosshair: '🎯 Выделение: Перекрестием (по умолчанию)',
          click: '👆 Выделение: Кликом пальцем / мышью',
          both: '🎯 + 👆 Выделение: Оба варианта разом'
        };
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(titles[val] || 'Режим обновлён');
      });
    }

    const selBadgeMode = $('inat-badge-display-mode');
    const hintBadgeMode = $('inat-badge-display-mode-hint');
    if (selBadgeMode) {
      const updateBadgeHint = (val) => {
        if (!hintBadgeMode) return;
        const hints = {
          'full': 'Полный вид: названия и бейджи всегда видны целиком.',
          'auto-hide': 'Автоматически скрывать: метки сжаты в овалы и разворачиваются при наведении прицела или курсора.',
          'center-bubble': 'Автообласть по центру: карточки около центра экрана раскрываются и увеличиваются линзой.',
          'manual': 'Ручное: все плашки сжаты в овалы, открываются и закрываются кликом на стрелочку ›.'
        };
        hintBadgeMode.textContent = hints[val] || '';
      };

      selBadgeMode.addEventListener('change', (e) => {
        const val = e.target.value;
        WM.inat?.setConfig({ badgeDisplayMode: val });
        updateBadgeHint(val);
        const titles = {
          'full': '🏷️ Вид карточек: Полный',
          'auto-hide': '🏷️ Вид карточек: Авто-скрытие',
          'center-bubble': '🏷️ Вид карточек: Линза по центру',
          'manual': '🏷️ Вид карточек: Ручное'
        };
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(titles[val] || 'Настройки обновлены');
      });
      updateBadgeHint(selBadgeMode.value);
    }



    $('inat-zoom-out-mode')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ zoomOutMode: e.target.value });
    });

    // 2. Тумблер плашки вверху экрана
    $('toggle-inat-show-badge')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ showBadge: e.target.checked });
    });

    // 3. Сегментированный переключатель поиска (На экране / Общий)
    document.querySelectorAll('#inat-search-type-segmented .inat-search-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#inat-search-type-segmented .inat-search-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        WM.inat?.setSearchType(btn.dataset.type);
      });
    });

    // 4. Поле поиска и автодополнение
    const queryInput = $('inat-filter-query');
    const clearBtn = $('inat-filter-query-clear');
    const autoWrap = $('inat-autocomplete-wrap');

    if (queryInput) {
      queryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (autoWrap) autoWrap.hidden = true;
          executeSettingsSearch();
        }
      });
    }

    if (queryInput) {
      queryInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (clearBtn) clearBtn.hidden = !val.trim();
        WM.inat?.triggerSearchInput(val);
      });

      queryInput.addEventListener('focus', () => {
        if (queryInput.value.trim().length >= 2) {
          WM.inat?.triggerSearchInput(queryInput.value);
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (queryInput) {
          queryInput.value = '';
          clearBtn.hidden = true;
          if (autoWrap) autoWrap.hidden = true;
          WM.inat?.triggerSearchInput('');
          queryInput.focus();
        }
      });
    }

    // Скрытие подсказок при клике за пределами блока поиска
    document.addEventListener('click', (e) => {
      if (autoWrap && !autoWrap.hidden && !e.target.closest('.inat-search-box')) {
        autoWrap.hidden = true;
      }
    });

    // 5. Кнопка «Показать на карте»: центрирует, ставит зум 9 и скачивает данные
    $('btn-inat-filter-apply-map')?.addEventListener('click', () => {
      if (autoWrap) autoWrap.hidden = true;
      WM.inat?.applyFilterToMap();
    });

    // 6. Селекторы фильтров
    $('inat-filter-taxa')?.addEventListener('change', (e) => {
      const val = e.target.value;
      WM.inat?.setConfig({ taxa: val });
    });

    // Слушатель фенофаз растений
    

    // Слушатели стадий развития
    $('inat-filter-lifestage-insects')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ lifestageInsects: e.target.value });
    });

    $('inat-filter-lifestage-animals')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ lifestageAnimals: e.target.value });
    });

    // Кнопка открытия радара видов прямо из раздела
    $('btn-inat-open-suggest')?.addEventListener('click', () => {
      $('modal')?.classList.remove('open');
      WM.inat?.openSmartSuggestionsModal();
    });
    $('inat-filter-sort')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ sort: e.target.value });
    });
    $('inat-filter-season')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ season: e.target.value });
    });
    $('inat-filter-month')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ month: e.target.value });
    });
    $('inat-filter-quality')?.addEventListener('change', (e) => {
      WM.inat?.setConfig({ quality: e.target.value });
    });

    // 7. Чекбоксы параметров
    $('toggle-inat-wild')?.addEventListener('change', (e) => WM.inat?.setConfig({ wildOnly: e.target.checked }));
    $('toggle-inat-native')?.addEventListener('change', (e) => WM.inat?.setConfig({ nativeOnly: e.target.checked }));
    $('toggle-inat-threatened')?.addEventListener('change', (e) => WM.inat?.setConfig({ threatenedOnly: e.target.checked }));
    $('toggle-inat-photos')?.addEventListener('change', (e) => WM.inat?.setConfig({ photosOnly: e.target.checked }));

    // 8. Слайдер лимита
    const sliderLimit = $('inat-filter-limit');
    const valLimit = $('inat-filter-limit-val');
    if (sliderLimit) {
      sliderLimit.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (valLimit) valLimit.textContent = val;
        WM.inat?.setConfig({ limit: val });
      });
    }

    // 9. Кнопки обновления и экспорта
    $('btn-inat-refresh-now')?.addEventListener('click', () => {
      WM.inat?.refresh();
      showToast('🌿 Обновление наблюдений на экране…');
    });

    $('btn-inat-export-json')?.addEventListener('click', () => {
      WM.inat?.exportCurrentViewJson();
    });

    // 10. Токен
    $('btn-inat-token-toggle-eye')?.addEventListener('click', () => {
      const inp = $('inat-token-input');
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('btn-inat-token-save')?.addEventListener('click', () => {
      const inp = $('inat-token-input');
      if (inp) {
        WM.inat?.setToken(inp.value);
        showToast('🔑 Токен сохранён');
      }
    });

    $('btn-inat-token-clear')?.addEventListener('click', () => {
      WM.inat?.removeToken();
      showToast('🗑️ Токен удалён');
    });
  }

  function updateBatteryOptimizationUI() {
      const badge = $('badge-battery-opt-status');
      const btn = $('btn-request-battery-opt');
      if (!badge) return;

      if (!window.AndroidBridge || !window.AndroidBridge.isIgnoringBatteryOptimizations) {
        badge.textContent = 'Недоступно (Web)';
        badge.style.background = 'var(--bg-secondary)';
        badge.style.color = 'var(--text-muted)';
        return;
      }

      try {
        const isIgnoring = window.AndroidBridge.isIgnoringBatteryOptimizations();
        if (isIgnoring) {
          badge.textContent = 'Разрешено ✓';
          badge.style.background = '#16a34a';
          badge.style.color = '#ffffff';
          if (btn) {
            btn.textContent = '✅ Ограничения сняты';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-secondary');
          }
        } else {
          badge.textContent = 'Ограничено ⚠️';
          badge.style.background = '#f59e0b';
          badge.style.color = '#000000';
          if (btn) {
            btn.textContent = '⚡ Отключить оптимизацию батареи';
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-secondary');
          }
        }
      } catch (e) {
        badge.textContent = 'Недоступно';
      }
    }

  Object.assign(WM.ui, {
    openLightbox(photosList, startIndex = 0) {
      if (!Array.isArray(photosList) || !photosList.length) return;
      lb.list = photosList;
      openLightbox(startIndex);
    },
    updateMotionBtnState,
    updateManualPdrBtnState, // <-- Экспортируем
    updateRays,
    openPlace(obj, alts) {
      obj.isVisited = true;
      if (WM.cache && WM.cache.markVisited) {
        WM.cache.markVisited(obj.id);
      }
      if (WM.view && WM.view.updateObjectStyle) {
        WM.view.updateObjectStyle(obj.id);
      }
      cur = { 
        obj, 
        detail: null, 
        error: null, 
        lang: 'ru', 
        loadingLang: 'ru',
        availableLanguages: extractAvailableLanguages(null, 'ru')
      }; 
      tab = 'info';
      $('sheet-title').textContent = obj.title || 'Безымянный объект';
      
      const a = $('sheet-alts'); a.textContent = '';
      if (alts.length > 1) alts.forEach(x => a.append(el('button', {
        class: 'chip' + (x.id === obj.id ? ' active' : ''), 
        text: x.title || ('#' + x.id), 
        onclick: () => WM.picker.select(x, alts)
      })));

      renderLangsUI();

      $('sheet-body').scrollTop = 0;
      $('sheet').style.transform = '';
      $('sheet').classList.remove('full');
      const expandBtn = $('sheet-expand');
      if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
      $('sheet').classList.add('open'); 
      document.body.classList.add('sheet-open');
      pushHistoryState('sheet');
      load(obj, 'ru');
    },
    closeSheet,
    showToast,
    setPill(obj, count, customSubtitle) {
      const p = $('hover-pill');
      if (!obj || !uiVis.pill) { 
        p.hidden = true; 
        delete p.dataset.source; 
        return; 
      }
      p.hidden = false;

      if (obj.isInat) {
        p.dataset.source = 'inat';
        const rawTitle = obj.title || 'Наблюдение iNaturalist';
        const safeTitle = escapeHtml(rawTitle) + (count > 1 ? ` (${count})` : '') + '  ›';
        p.innerHTML = `<span class="pill-title">${safeTitle}</span><span class="pill-meta">${escapeHtml(customSubtitle || 'Нажмите для карточки')}</span>`;
        return;
      }
      delete p.dataset.source;

      const rawTitle = obj.title || 'Безымянный объект';
      const safeTitle = escapeHtml(rawTitle) + (count > 1 ? ` (+${count - 1})` : '') + '  ›';
      if (obj.hasDetail || obj.photosCount !== undefined || obj.commentsCount !== undefined) {
        const ph = Number(obj.photosCount) || 0;
        const cm = Number(obj.commentsCount) || 0;
        const visitedText = obj.isVisited ? ' · просмотрено' : '';
        p.innerHTML = `<span class="pill-title">${safeTitle}</span><span class="pill-meta">📷 ${ph} · 💬 ${cm}${visitedText}</span>`;
      } else {
        p.innerHTML = `<span class="pill-title">${safeTitle}</span>`;
      }
    },
    updateTagFilterHUD(tag, count = 0) {
      const badge = $('tag-filter-badge');
      if (!badge) return;
      if (!tag) {
        badge.hidden = true;
        return;
      }
      badge.hidden = false;
      const textEl = $('tag-filter-text');
      // Добавляем стрелочку '›' для очевидности кликабельности
      if (textEl) textEl.textContent = `🏷️ «${tag.title}» (${count})  ›`;
      textEl.title = `Нажмите, чтобы открыть список объектов «${tag.title}»`;
    },
    setStatus(text, warn) {
      const s = $('status');
      if (s) {
        // Если передан пустой текст — прячем плашку
        if (!text) {
          s.style.display = 'none';
          s.textContent = '';
          return;
        }

        // Если текст есть и плашка не выключена в настройках видимости — показываем
        if (uiVis.status !== false) {
          s.style.display = '';
        }
        s.textContent = text;
        s.classList.toggle('warn', !!warn);
      }
    },
    updateStatusFromLoader() {
      if (window.refreshAppStatus) window.refreshAppStatus();
    },
    getWorkMode() { return workMode; },
    isAutoHoverEnabled() { return false; },
    isAutoDetailsEnabled() { return autoDetailsEnabled; },
    isAutoDetailsCrosshairOnly() { return autoDetailsCrosshairOnly; },
    fmtTimer,
    openKeysSettings,
    toggleTopGetKeyBtn,

    
    init() {
      // Удаляем временный стиль предзагрузки, чтобы он не блокировал динамическое включение/выключение
      const earlyStyle = document.getElementById('early-ui-vis-style');
      if (earlyStyle) earlyStyle.remove();

      const savedTheme = WM.api.store.get('wm_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(savedTheme);

      try {
        const savedVis = JSON.parse(WM.api.store.get('wm_ui_vis') || '{}');
        uiVis = { ...UI_VIS_DEFAULT, ...savedVis };
      } catch (e) {}

      const btnHideUI = $('btn-hide-ui');
      if (btnHideUI) {
        btnHideUI.onclick = () => toggleHideUI();
      }
      updateBottomLeftButtonsStack();

      VIS_KEYS.forEach(k => {
        const chk = $('toggle-ui-' + k);
        if (chk) chk.checked = uiVis[k] !== false;
      });

      const btnManualPdr = $('btn-manual-pdr');
      if (btnManualPdr) {
        initPdrQuickModal();

        let pdrHoldTimer = null;
        let isPdrLongPress = false;
        let lastPdrLongPressTime = 0;
        let pdrTouchStartPt = null;
        let isPdrTouchAction = false;

        // 1. ПК: Правый клик мыши
        btnManualPdr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isPdrTouchAction) return;
          openPdrQuickModal();
        });

        // 2. Смартфон: touchstart (удержание от 400 мс)
        btnManualPdr.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          isPdrTouchAction = true;
          isPdrLongPress = false;
          const t = e.touches[0];
          pdrTouchStartPt = { x: t.clientX, y: t.clientY };
          clearTimeout(pdrHoldTimer);

          pdrHoldTimer = setTimeout(() => {
            isPdrLongPress = true;
            lastPdrLongPressTime = Date.now();
            if (navigator.vibrate) navigator.vibrate(40);
            openPdrQuickModal();
          }, 420);
        }, { passive: true });



        btnManualPdr.addEventListener('touchmove', (e) => {
          if (!pdrTouchStartPt) return;
          const t = e.touches[0];
          if (Math.hypot(t.clientX - pdrTouchStartPt.x, t.clientY - pdrTouchStartPt.y) > 10) {
            clearTimeout(pdrHoldTimer);
          }
        }, { passive: true });

        btnManualPdr.addEventListener('touchend', (e) => {
          clearTimeout(pdrHoldTimer);
          pdrTouchStartPt = null;
          if (isPdrLongPress) {
            lastPdrLongPressTime = Date.now();
            e.preventDefault();
            e.stopPropagation();
          }
          setTimeout(() => { isPdrTouchAction = false; }, 350);
        }, { passive: false });

        btnManualPdr.addEventListener('touchcancel', () => {
          clearTimeout(pdrHoldTimer);
          pdrTouchStartPt = null;
          isPdrLongPress = false;
          isPdrTouchAction = false;
        });

        // 3. ПК: долгое удержание левой кнопки мыши
        let mousePdrTimer = null;
        let mousePdrLong = false;

        btnManualPdr.addEventListener('mousedown', (e) => {
          if (isPdrTouchAction || e.button !== 0) return;
          mousePdrLong = false;
          clearTimeout(mousePdrTimer);
          mousePdrTimer = setTimeout(() => {
            mousePdrLong = true;
            lastPdrLongPressTime = Date.now();
            openPdrQuickModal();
          }, 420);
        });
        btnManualPdr.addEventListener('mouseup', () => clearTimeout(mousePdrTimer));
        btnManualPdr.addEventListener('mouseleave', () => clearTimeout(mousePdrTimer));

        // 4. Обычный короткий клик (активация/деактивация шагомера)
        btnManualPdr.onclick = (e) => {
          if (isPdrLongPress || mousePdrLong || (Date.now() - lastPdrLongPressTime < 600)) {
            isPdrLongPress = false;
            mousePdrLong = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (WM.manualPdr && WM.manualPdr.toggle) WM.manualPdr.toggle();
        };
      }
      updateManualPdrBtnState();

      const modalCompassAdj = $('modal-compass-adjust');
      if (modalCompassAdj) {
        const closeAdj = () => modalCompassAdj.classList.remove('open');
        $('compass-adjust-x')?.addEventListener('click', closeAdj);
        $('btn-adj-close')?.addEventListener('click', closeAdj);
        modalCompassAdj.addEventListener('click', (e) => {
          if (e.target === modalCompassAdj) closeAdj();
        });

        // 1. Привязать к Северу (0°)
        $('btn-adj-north')?.addEventListener('click', () => {
          if (WM.pdr && WM.pdr.setManualHeading) {
            const res = WM.pdr.setManualHeading(0);
            closeAdj();
            showToast(`✅ Курс откалиброван: Север (поправка ${res.newOffset > 0 ? '+' : ''}${res.newOffset}°)`, 2500);
          }
        });


        // 2. Привязать к Солнцу
        $('btn-adj-sun')?.addEventListener('click', () => {
          const targetAz = modalCompassAdj._currentSunAz;
          if (targetAz != null && WM.pdr && WM.pdr.setManualHeading) {
            const res = WM.pdr.setManualHeading(targetAz);
            closeAdj();
            showToast(`☀️ Курс выставлен по Солнцу (${targetAz}°)`, 2500);
          }
        });

        $('btn-track-download-by-pass')?.addEventListener('click', () => {
          $('modal-track-download-pass')?.classList.add('open');
        });

        $('btn-request-battery-opt')?.addEventListener('click', () => {
          if (window.AndroidBridge && window.AndroidBridge.requestIgnoreBatteryOptimizations) {
            window.AndroidBridge.requestIgnoreBatteryOptimizations();
            setTimeout(updateBatteryOptimizationUI, 1200);
          } else {
            showToast('Доступно только в собранном APK на Android');
          }
        });

        $('btn-open-app-settings')?.addEventListener('click', () => {
          if (window.AndroidBridge && window.AndroidBridge.openAppSettings) {
            window.AndroidBridge.openAppSettings();
          } else {
            showToast('Доступно только в собранном APK на Android');
          }
        });

        // Автоматически обновлять статус при возврате в приложение из настроек ОС
        window.addEventListener('focus', updateBatteryOptimizationUI);
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) updateBatteryOptimizationUI();
        });

        // 3. Привязать к Луне
        $('btn-adj-moon')?.addEventListener('click', () => {
          const targetAz = modalCompassAdj._currentMoonAz;
          if (targetAz != null && WM.pdr && WM.pdr.setManualHeading) {
            const res = WM.pdr.setManualHeading(targetAz);
            closeAdj();
            showToast(`🌙 Курс выставлен по Луне (${targetAz}°)`, 2500);
          }
        });

        // 4. Сброс в заводские значения
        $('btn-adj-reset')?.addEventListener('click', () => {
          if (WM.pdr && WM.pdr.resetAlignmentOffset) {
            WM.pdr.resetAlignmentOffset();
            closeAdj();
            showToast('↺ Поправка компаса сброшена на 0°');
          }
        });
      }

      const chkAutoSize = $('toggle-filter-auto-size');
      if (chkAutoSize) {
        chkAutoSize.addEventListener('change', updateSizeFilterTogglesState);
      }
      updateSizeFilterTogglesState();

      // Радиокнопки в модальном окне настроек
      document.querySelectorAll('input[name="app-theme-mode"]').forEach(r => {
        r.addEventListener('change', (e) => {
          if (e.target.checked) applyTheme(e.target.value);
        });
      });

      const chkMotionVector = $('toggle-ui-motionvector');
      if (chkMotionVector) {
        chkMotionVector.checked = uiVis.motionvector !== false;
        chkMotionVector.onchange = (e) => {
          uiVis.motionvector = e.target.checked;
          if (WM.motionVector) WM.motionVector.setEnabled(e.target.checked);
          if (WM.gpsDist && WM.gpsDist.refresh) WM.gpsDist.refresh();
          updateMotionBtnState(); // <-- Добавлено
        };
      }

      const btnMotion = $('btn-motion-toggle');
      if (btnMotion) {
        btnMotion.onclick = cycleMotionMode;
      }
      updateMotionBtnState();

      const tagText = $('tag-filter-text');
      if (tagText) {
        tagText.onclick = (e) => {
          e.stopPropagation();
          const curTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;
          if (curTag) {
            openObjectsListModal(false, curTag);
          }
        };
      }



      // Обработка клика и долгого тапа для btn-theme-toggle
      const btnTheme = $('btn-theme-toggle');
      if (btnTheme) {
        let themeHoldTimer = null;
        let isThemeLongPress = false;
        let lastLongPressTime = 0;
        let themeTouchStartPt = null;
        let isTouchAction = false;

        // Контекстное меню — срабатывает ТОЛЬКО от реального правого клика мыши на ПК
        btnTheme.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Если это долгий тап на телефоне — игнорируем (его уже обработал touchstart)
          if (isTouchAction || (e.pointerType && e.pointerType !== 'mouse')) return;
          if (e.button === 2) {
            toggleNightVision();
          }
        });

        // 1. Смартфон: touchstart
        btnTheme.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          isTouchAction = true;
          isThemeLongPress = false;
          const t = e.touches[0];
          themeTouchStartPt = { x: t.clientX, y: t.clientY };
          clearTimeout(themeHoldTimer);

          themeHoldTimer = setTimeout(() => {
            isThemeLongPress = true;
            lastLongPressTime = Date.now();
            if (navigator.vibrate) navigator.vibrate(45);
            toggleNightVision();
          }, 450);
        }, { passive: true });

        btnTheme.addEventListener('touchmove', (e) => {
          if (!themeTouchStartPt) return;
          const t = e.touches[0];
          if (Math.hypot(t.clientX - themeTouchStartPt.x, t.clientY - themeTouchStartPt.y) > 10) {
            clearTimeout(themeHoldTimer);
          }
        }, { passive: true });

        btnTheme.addEventListener('touchend', (e) => {
          clearTimeout(themeHoldTimer);
          themeTouchStartPt = null;

          if (isThemeLongPress) {
            // Запоминаем время отрыва пальца, чтобы надёжно заблокировать последующий синтетический click
            lastLongPressTime = Date.now();
            e.preventDefault();
            e.stopPropagation();
          }

          // Сбрасываем флаг тача с небольшой задержкой для фильтрации мышиных эмуляций
          setTimeout(() => { isTouchAction = false; }, 400);
        }, { passive: false });

        btnTheme.addEventListener('touchcancel', () => {
          clearTimeout(themeHoldTimer);
          themeTouchStartPt = null;
          isThemeLongPress = false;
          isTouchAction = false;
        });

        // 2. ПК: Долгое удержание левой кнопки мыши
        let mouseHoldTimer = null;
        let mouseIsLong = false;

        btnTheme.addEventListener('mousedown', (e) => {
          if (isTouchAction || e.button !== 0) return;
          mouseIsLong = false;
          clearTimeout(mouseHoldTimer);
          mouseHoldTimer = setTimeout(() => {
            mouseIsLong = true;
            lastLongPressTime = Date.now();
            toggleNightVision();
          }, 450);
        });

        btnTheme.addEventListener('mouseup', () => clearTimeout(mouseHoldTimer));
        btnTheme.addEventListener('mouseleave', () => clearTimeout(mouseHoldTimer));

        // 3. Обычный короткий клик
        btnTheme.onclick = (e) => {
          // Если только что сработал долгий тап или удержание — блокируем клик
          if (isThemeLongPress || mouseIsLong || (Date.now() - lastLongPressTime < 650)) {
            isThemeLongPress = false;
            mouseIsLong = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          toggleTheme();
        };
      }

      const chkTail = $('toggle-ui-motiontail');
      const subTail = $('sub-motiontail-settings');
      if (chkTail && subTail) {
        chkTail.checked = uiVis.motiontail !== false;
        subTail.hidden = !chkTail.checked;
        chkTail.onchange = (e) => {
          subTail.hidden = !e.target.checked;
          uiVis.motiontail = e.target.checked; // <-- добавить эту строчку
          if (WM.motionTail) WM.motionTail.setEnabled(e.target.checked);
          updateMotionBtnState();
        };
      }

      const sliderTailLen = $('tail-len-slider');
      const valTailLen = $('tail-len-val');
      if (sliderTailLen && valTailLen) {
        sliderTailLen.oninput = (e) => {
          valTailLen.textContent = e.target.value;
          if (WM.motionTail) WM.motionTail.setLength(e.target.value);
        };
      }

      const colorTail = $('tail-color-select');
      const valColorTail = $('tail-color-val');
      if (colorTail && valColorTail) {
        colorTail.oninput = (e) => {
          valColorTail.textContent = e.target.value;
          if (WM.motionTail) WM.motionTail.setColor(e.target.value);
        };
      }


      WM.quickMenu = {
        open: openQuickMenu,
        close: closeQuickMenu,
        isOpen: () => {
          const el = $('quick-menu-overlay');
          return el && !el.hidden;
        },
        wasJustOpened: () => (Date.now() - quickMenuJustOpenedTime < 450)
      };

      const btnGpsDist = $('btn-gps-dist');
      if (btnGpsDist) {
        btnGpsDist.onclick = () => {
          if (WM.gpsDist && WM.gpsDist.toggle) WM.gpsDist.toggle();
        };
      }

      const btnRays = $('btn-rays-toggle');
      if (btnRays) {
        btnRays.onclick = () => {
          infoHudConfig.rays = !infoHudConfig.rays;
          WM.api.store.set('wm_info_hud_items', JSON.stringify(infoHudConfig));
          updateInfoHudUI();
          updateRaysBtnState();
          showToast(infoHudConfig.rays ? '✨ Азимуты Солнца и Луны включены' : '✨ Азимуты скрыты');
        };
      }
      updateRaysBtnState();

      // Инициализация поднастроек круга дальности
      const chkRR = $('toggle-ui-rangering');
      const subRR = $('sub-rangering-settings');
      if (chkRR && subRR) {
        // Устранение бага: сразу синхронизируем видимость поднастроек с состоянием чекбокса при старте
        subRR.hidden = !chkRR.checked;
        chkRR.onchange = (e) => {
          subRR.hidden = !e.target.checked;
          if (WM.rangeRing) WM.rangeRing.setEnabled(e.target.checked);
        };
      }

      const sliderRadius = $('rr-radius-slider');
      const valRadius = $('rr-radius-val');
      if (sliderRadius && valRadius && WM.rangeRing) {
        sliderRadius.value = Math.round(WM.rangeRing.getRadiusRatio() * 100);
        valRadius.textContent = sliderRadius.value + '%';
        sliderRadius.oninput = (e) => {
          valRadius.textContent = e.target.value + '%';
          WM.rangeRing.setRadiusRatio(e.target.value / 100);
        };
      }

      const chkAxes = $('toggle-rr-axes');
      const wrapAxesSub = $('rr-axes-sub-options');
      if (chkAxes && WM.rangeRing) {
        chkAxes.checked = WM.rangeRing.getShowAxes();
        if (wrapAxesSub) wrapAxesSub.hidden = !chkAxes.checked;
        chkAxes.onchange = (e) => {
          if (wrapAxesSub) wrapAxesSub.hidden = !e.target.checked;
          WM.rangeRing.setShowAxes(e.target.checked);
        };
      }

      const sliderAxisLen = $('rr-axis-len-slider');
      const valAxisLen = $('rr-axis-len-val');
      if (sliderAxisLen && valAxisLen && WM.rangeRing) {
        sliderAxisLen.value = Math.round(WM.rangeRing.getAxisLengthRatio() * 100);
        valAxisLen.textContent = (sliderAxisLen.value / 100).toFixed(2) + 'x';
        sliderAxisLen.oninput = (e) => {
          valAxisLen.textContent = (e.target.value / 100).toFixed(2) + 'x';
          WM.rangeRing.setAxisLengthRatio(e.target.value / 100);
        };
      }

      const colorRR = $('rr-color-select');
      const valColorRR = $('rr-color-val');
      if (colorRR && valColorRR && WM.rangeRing) {
        colorRR.value = WM.rangeRing.getColor();
        valColorRR.textContent = colorRR.value;
        colorRR.oninput = (e) => {
          valColorRR.textContent = e.target.value;
          WM.rangeRing.setColor(e.target.value);
        };
      }

      // Новые контролы: размер шрифта и цвет цифр
      const sliderFontSize = $('rr-font-size-slider');
      const valFontSize = $('rr-font-size-val');
      if (sliderFontSize && valFontSize && WM.rangeRing) {
        sliderFontSize.value = WM.rangeRing.getFontSize();
        valFontSize.textContent = sliderFontSize.value + ' px';
        sliderFontSize.oninput = (e) => {
          valFontSize.textContent = e.target.value + ' px';
          WM.rangeRing.setFontSize(e.target.value);
        };
      }

      const colorTextRR = $('rr-text-color-select');
      const valColorTextRR = $('rr-text-color-val');
      if (colorTextRR && valColorTextRR && WM.rangeRing) {
        colorTextRR.value = WM.rangeRing.getTextColor();
        valColorTextRR.textContent = colorTextRR.value;
        colorTextRR.oninput = (e) => {
          valColorTextRR.textContent = e.target.value;
          WM.rangeRing.setTextColor(e.target.value);
        };
      }

      const chkQm = $('toggle-qm-enabled');
      if (chkQm) {
        chkQm.onchange = (e) => {
          const sub = $('quick-menu-settings-sub');
          if (sub) sub.hidden = !e.target.checked;
        };
      }

      const chkInfoToggle = $('toggle-ui-infomenu');
      if (chkInfoToggle) {
        chkInfoToggle.onchange = (e) => {
          const sub = $('sub-infomenu-settings');
          if (sub) sub.hidden = !e.target.checked;
        };
      }

      // Кнопка сворачивания виджета на самой карте
      const minBtn = $('info-hud-toggle-btn');
      const hudHeader = $('info-hud-header');
      const hudEl = $('info-hud');

      function setInfoHudCollapsed(isCollapsed) {
        if (!hudEl) return;
        hudEl.classList.toggle('collapsed', isCollapsed);
        if (minBtn) {
          minBtn.innerHTML = isCollapsed ? '📊<span style="font-size:10px;margin-left:1px;">▸</span>' : '◀';
          minBtn.title = isCollapsed ? 'Развернуть инфо-панель' : 'Свернуть в левый бок';
        }
        try {
          localStorage.setItem('wm_info_hud_collapsed', isCollapsed ? 'true' : 'false');
        } catch (e) {}
        if (!isCollapsed) {
          updateInfoHudUI();
        }
      }

      // Восстановление состояния из памяти
      const isSavedCollapsed = localStorage.getItem('wm_info_hud_collapsed') !== 'false';
      if (hudEl) {
        setInfoHudCollapsed(isSavedCollapsed);
      } else if (minBtn) {
        minBtn.textContent = '◀';
        minBtn.title = 'Свернуть в левый бок';
      }

      // Клик по ВСЕЙ области шапки сворачивает/разворачивает меню
      if (hudHeader) {
        hudHeader.onclick = () => {
          const isCol = !hudEl.classList.contains('collapsed');
          setInfoHudCollapsed(isCol);
        };
      }

      // Свайпы и клики по кнопкам листания дней астрономии
      const hudContent = $('info-hud-content');
      if (hudContent) {
        // Запоминание открытости спойлеров
        hudContent.addEventListener('toggle', (e) => {
          const details = e.target.closest('details[data-spoiler]');
          if (!details) return;
          const key = details.dataset.spoiler;
          if (key && hudSpoilersState[key] !== undefined) {
            hudSpoilersState[key] = details.open;
            // Если пользователь раскрыл погоду и данных нет — запускаем загрузку сразу:
            if (key === 'weather' && details.open && !weatherCacheData) {
              const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
              loadWeatherIfNeeded(c.lat, c.lng);
            }
          }
        }, true);
        let astroTouchX = 0;
        let astroTouchY = 0;

        hudContent.addEventListener('touchstart', (e) => {
          if (e.touches.length === 1) {
            astroTouchX = e.touches[0].clientX;
            astroTouchY = e.touches[0].clientY;
          }
        }, { passive: true });

        hudContent.addEventListener('touchend', (e) => {
          if (e.changedTouches.length === 1) {
            // Если свайп был внутри горизонтальной ленты почасового прогноза — не переключаем день!
            if (e.target.closest('.ih-hourly-scroll')) return;

            const dx = e.changedTouches[0].clientX - astroTouchX;
            const dy = e.changedTouches[0].clientY - astroTouchY;
            if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.3) {
              const target = e.target.closest('.ih-astro-ctrl, .ih-astro-swipe-area, .ih-astro-section');
              if (target) {
                if (dx < 0) changeAstroDay(1);   // Свайп влево: день вперед
                else changeAstroDay(-1);         // Свайп вправо: день назад
              }
            }
          }
        }, { passive: true });

        hudContent.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-astro-action]');
          if (!btn) return;
          e.stopPropagation();
          const action = btn.dataset.astroAction;
          if (action === 'prev') changeAstroDay(-1);
          else if (action === 'next') changeAstroDay(1);
          else if (action === 'reset') resetAstroDay();
        });
      }

      // КНОПКА СБРОСА ВСЕХ НАСТРОЕК
      const btnResetAll = $('btn-reset-all-settings');
      if (btnResetAll) {
        btnResetAll.onclick = () => {
          if (!confirm('Сбросить все настройки приложения по умолчанию? (Цвета, стили контуров, режимы и фильтры будут возвращены к исходным значениям)')) return;

          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('wm_') && k !== 'wm_user_markers' && k !== 'wm_ruler_tracks' && k !== 'wm_ruler_points') {
              try { localStorage.removeItem(k); } catch (e) {}
            }
          }

          showToast('Настройки сброшены! Перезагрузка…', 1500);
          setTimeout(() => window.location.reload(), 900);
        };
      }

      // Таймер обновления виджета каждую секунду
       setInterval(() => {
        if (document.hidden) return; // В фоне ничего не делаем

        const hud = $('info-hud');
        if (!hud || hud.classList.contains('collapsed')) return;

        // Быстрое обновление часов без перерисовки всего DOM
        const timeEl = hud.querySelector('.main-time .ih-val-large');
        if (timeEl) {
          const now = new Date();
          timeEl.textContent = now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } else {
          // Если структура ещё не построена
          updateInfoHudUI();
        }
      }, 1000);

      // Полная перерисовка астрономии и координат — раз в 30 секунд или по событиям карты
      setInterval(() => {
        if (!document.hidden) updateInfoHudUI();
      }, 30000);


      applyUIVisibility();

      // ДОБАВЬТЕ ЭТУ СТРОКУ СЮДА:
      applyRasterCSS(rasterStyle);

      const chkAutoHover = $('toggle-auto-hover');
      if (chkAutoHover) chkAutoHover.checked = autoHoverEnabled;
      const chkAutoDetails = $('toggle-auto-details');
      if (chkAutoDetails) {
        chkAutoDetails.checked = autoDetailsEnabled;
        chkAutoDetails.onchange = updateAutoDetailsSubVisibility;
      }
      const chkDetailsCrosshair = $('toggle-auto-details-crosshair');
      if (chkDetailsCrosshair) {
        chkDetailsCrosshair.checked = autoDetailsCrosshairOnly;
        chkDetailsCrosshair.onchange = updateAutoDetailsSubVisibility;
      }
      updateAutoDetailsSubVisibility();

      // --- НАЧАЛО ВСТАВКИ: Инициализация постоянного кэша и связь с SW ---
      function syncSWNoTrim(enabled) {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SET_NO_TRIM_TILES',
            value: enabled
          });
        }
      }

      const noEvictObjs = WM.api.store.get('wm_no_evict_objects') === 'true';
      const noEvictTiles = WM.api.store.get('wm_no_evict_tiles') === 'true';

      const chkNoEvictObjs = $('toggle-no-evict-objects');
      if (chkNoEvictObjs) chkNoEvictObjs.checked = noEvictObjs;
      const chkNoEvictTiles = $('toggle-no-evict-tiles');
      if (chkNoEvictTiles) chkNoEvictTiles.checked = noEvictTiles;

      if (navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(() => syncSWNoTrim(noEvictTiles));
      }

      const radios = document.querySelectorAll('input[name="app-work-mode"]');
      radios.forEach(r => {
        if (r.value === workMode) r.checked = true;
      });

      // Таймер обновляет лимиты каждую секунду, только если приложение на экране
      setInterval(() => {
        if (!document.hidden) updateLimitHUD();
      }, 1000);
      updateLimitHUD(); 

      const btnGetKeyTop = $('btn-get-key-top');
      if (btnGetKeyTop) {
        btnGetKeyTop.onclick = openKeysSettings;
      }

      const tagBadge = $('tag-filter-badge');
      if (tagBadge) {
        tagBadge.onclick = (e) => {
          if (e.target.closest('#tag-filter-refresh, #tag-filter-clear')) return;
          const curTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;
          if (curTag) {
            openObjectsListModal(false, curTag);
          }
        };
      }

      const clearTagBtn = $('tag-filter-clear');
      if (clearTagBtn) {
        clearTagBtn.onclick = (e) => {
          e.stopPropagation(); // Не открывать окно при клике на крестик
          if (WM.view && WM.view.clearTagFilter) {
            WM.view.clearTagFilter();
          }
        };
      }

      const refreshTagBtn = $('tag-filter-refresh');
      if (refreshTagBtn) {
        refreshTagBtn.onclick = async (e) => {
          e.stopPropagation(); // Не открывать окно при клике на обновление
          refreshTagBtn.classList.remove('spinning');
          void refreshTagBtn.offsetWidth;
          refreshTagBtn.classList.add('spinning');

          const curTag = WM.view.getActiveTag();
          if (curTag && WM.loader && WM.loader.fetchCategoryInBounds) {
            showToast(`🏷️ Поиск «${curTag.title}» в текущей области…`, 1300);
            await WM.loader.fetchCategoryInBounds(curTag);
          }
        };
      }

      const hybridSlider = $('hybrid-zoom-slider');
      const hybridVal = $('hybrid-zoom-val');
      const hybridWrap = $('hybrid-zoom-wrap');
      if (hybridSlider && hybridVal) {
        hybridSlider.value = C.VECTOR_ZOOM;
        hybridVal.textContent = `зум ${parseFloat(C.VECTOR_ZOOM).toFixed(1)}`;
        hybridSlider.oninput = (e) => {
          hybridVal.textContent = `зум ${parseFloat(e.target.value).toFixed(1)}`;
        };
      }

      function updateHybridSliderVisibility() {
        if (!hybridWrap) return;
        const checked = document.querySelector('input[name="app-work-mode"]:checked');
        hybridWrap.style.display = (checked && checked.value === 'hybrid') ? 'block' : 'none';
      }

      document.querySelectorAll('input[name="app-work-mode"]').forEach(r => {
        r.addEventListener('change', updateHybridSliderVisibility);
      });
      updateHybridSliderVisibility();

      



      const btnForceRefresh = $('btn-force-refresh');
      if (btnForceRefresh) {
        btnForceRefresh.onclick = async () => {
          btnForceRefresh.classList.remove('spinning');
          void btnForceRefresh.offsetWidth;
          btnForceRefresh.classList.add('spinning');

          // 1. Сброс лимитов API
          WM.api.resetAllLimits();
          if (WM.antiSpoof) WM.antiSpoof.reset();
          updateLimitHUD();

          // 2. Обновление публичных меток Firebase
          if (WM.sharedMarkers && WM.sharedMarkers.fetchRemoteMarkers) {
            WM.sharedMarkers.fetchRemoteMarkers();
          }

          // 3. ПЕРЕЗАГРУЗКА ВСЕХ СБОЙНЫХ/ПУСТЫХ ТАЙЛОВ КАРТЫ
          if (window.WM && WM.tileRetry) {
            WM.tileRetry.retryAllNow();
          }

          // 4. Сброс ошибок тайлов и форсированная подгрузка всей области (во всех режимах!)
          if (WM.loader) {
            if (WM.loader.retryNow) WM.loader.retryNow(true);
            if (WM.loader.loadVisibleNow) WM.loader.loadVisibleNow();
          }

          // 5. В режиме перекрестия — дополнительно опрашиваем точку в центре
          const pickerMode = WM.picker ? WM.picker.getMode() : 'cross';
          if (pickerMode === 'cross' && WM.picker.fetchAtCrosshair) {
            showToast('🔄 Обновление карты и объектов…', 1400);
            await WM.picker.fetchAtCrosshair();
          } else {
            showToast('🔄 Перезагрузка области карты…', 1400);
          }
        };
      }

      $('btn-settings-add-overlay')?.addEventListener('click', () => {
        $('modal')?.classList.remove('open');
        WM.imageOverlay.openAddDialog();
      });
      $('btn-settings-list-overlay')?.addEventListener('click', () => {
        $('modal')?.classList.remove('open');
        WM.imageOverlay.openManager();
      });


      $('tabs').onclick = e => { const t = e.target.dataset.tab; if (t) { tab = t; renderBody(); } };
      $('sheet-close').onclick = closeSheet;
      $('sheet-expand').onclick = () => {
        const isFull = $('sheet').classList.toggle('full');
        $('sheet-expand').textContent = isFull ? '⤡' : '⤢';
        $('sheet-expand').title = isFull ? 'Свернуть' : 'Развернуть';
      };
      $('hover-pill').onclick = () => WM.picker.openHover();
      $('lb-close').onclick = () => closeLightbox(true);

      window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('lightbox').hidden) {
          $('lightbox').hidden = true;
          resetLbTransform();
        }
      });

      $('btn-mode-toggle').onclick = () => WM.picker.toggleMode();

      initSearchUI();
      initObjectsListModal(); 
      initLightboxGestures();
      initSheetGestures();
      initMobileTooltips();
      initQuickMenu();
      initCoordsModal();
      initPdrDiagnosticsUI();
      initVisualCompassAdjustModule(); // <--- ВОТ СЮДА!
      initINaturalistUI(); 

      // Синхронизация обоих чекбоксов автоперехода в реальном времени:
      const chkPdrAuto1 = $('toggle-pdr-auto-engage');
      const chkPdrAuto2 = $('toggle-dead-reckon');
      if (chkPdrAuto1 && chkPdrAuto2) {
        chkPdrAuto1.addEventListener('change', () => { chkPdrAuto2.checked = chkPdrAuto1.checked; });
        chkPdrAuto2.addEventListener('change', () => { chkPdrAuto1.checked = chkPdrAuto2.checked; });
      }

      // Клик по верхней плашке статуса открывает меню объектов
      const statusBar = $('status');
      if (statusBar) {
        statusBar.onclick = () => openObjectsListModal(false);
      }

      const onVecInput = () => {
        const cfg = readVectorInputs();
        $('vec-stroke-color-val').textContent = cfg.color;
        $('vec-stroke-width-val').textContent = cfg.weight + ' px';
        $('vec-fill-color-val').textContent = cfg.fillColor;
        $('vec-fill-opacity-val').textContent = Math.round(cfg.fillOpacity * 100) + '%';
        $('vec-hover-color-val').textContent = cfg.hoverColor;
        $('vec-sel-color-val').textContent = cfg.selectedColor;
        WM.view.applyVectorStyle(cfg);
      };

      ['vec-stroke-color', 'vec-stroke-width', 'vec-fill-color', 'vec-fill-opacity', 'vec-hover-color', 'vec-sel-color']
        .forEach(id => { $(id).oninput = onVecInput; });

      const onRastInput = () => {
        const cfg = readRasterInputs();
        $('rast-opacity-val').textContent = cfg.opacity + '%';
        $('rast-contrast-val').textContent = cfg.contrast + '%';
        $('rast-saturate-val').textContent = cfg.saturate + '%';
        $('rast-brightness-val').textContent = cfg.brightness + '%';
        applyRasterCSS(cfg);
      };

      ['rast-opacity', 'rast-contrast', 'rast-saturate', 'rast-brightness', 'rast-shadow', 'rast-invert', 'rast-tint-enabled', 'rast-tint-color', 'rast-width']
      .forEach(id => {
        const elem = $(id);
        if (elem) {
          elem.oninput = onRastInput;
          elem.onchange = onRastInput;
        }
      });

      // Обновление текстового бейджа при движении ползунка
      $('rast-width').addEventListener('input', (e) => {
        $('rast-width-val').textContent = formatMorphLabel(parseFloat(e.target.value) || 0);
      });

      // Автоматически скрывать/показывать палитру цвета при переключении галочки
      $('rast-tint-enabled').addEventListener('change', (e) => {
        const row = $('rast-tint-color-row');
        if (row) row.style.display = e.target.checked ? 'flex' : 'none';
      });

      $('rast-tint-color').addEventListener('input', (e) => {
        $('rast-tint-color-val').textContent = e.target.value;
      });

      $('btn-reset-vector-style').onclick = () => {
        const def = WM.view.getDefaultVectorStyle();
        $('vec-stroke-color').value = def.color;
        $('vec-stroke-width').value = def.weight;
        $('vec-fill-color').value = def.fillColor;
        $('vec-fill-opacity').value = Math.round(def.fillOpacity * 100);
        $('vec-hover-color').value = def.hoverColor;
        $('vec-sel-color').value = def.selectedColor;
        onVecInput();
      };

      $('btn-reset-raster-style').onclick = () => {
      $('rast-opacity').value = DEFAULT_RASTER_STYLE.opacity;
      $('rast-contrast').value = DEFAULT_RASTER_STYLE.contrast;
      $('rast-saturate').value = DEFAULT_RASTER_STYLE.saturate;
      $('rast-brightness').value = DEFAULT_RASTER_STYLE.brightness;
      $('rast-shadow').checked = DEFAULT_RASTER_STYLE.shadow;
      $('rast-invert').checked = DEFAULT_RASTER_STYLE.invert;
      $('rast-width').value = 0;
      $('rast-width-val').textContent = formatMorphLabel(0);
      $('rast-tint-enabled').checked = DEFAULT_RASTER_STYLE.tintEnabled;
      $('rast-tint-color').value = DEFAULT_RASTER_STYLE.tintColor;
      $('rast-tint-color-val').textContent = DEFAULT_RASTER_STYLE.tintColor;
      const row = $('rast-tint-color-row');
      if (row) row.style.display = DEFAULT_RASTER_STYLE.tintEnabled ? 'flex' : 'none';
      onRastInput();
    };



      // === ВСТАВИТЬ СЮДА: ЛОГИКА ТРЕКЕРА В НАСТРОЙКАХ ===
      function renderTrackSettingsList() {
        const container = $('track-settings-list');
        if (!container || !WM.tracker) return;
        container.innerHTML = '';
        const list = WM.tracker.getTracks();

        if (!list.length) {
          container.innerHTML = '<div class="muted" style="padding: 10px;">Сохранённых треков пока нет.</div>';
          return;
        }

        list.forEach(t => {
          const isHidden = t.visible === false;
          const isSharedIcon = t.isShared ? (t.sharePassword ? '🔒' : '🌐') : '☁️';
          const isSharedTitle = t.isShared 
            ? (t.sharePassword ? 'В защищённой комнате (нажмите для смены)' : 'Опубликован публично (нажмите для настроек)') 
            : 'Поделиться в облако';

          const item = document.createElement('div');
          item.className = 'track-setting-item';
          item.innerHTML = `
            <div class="track-setting-color" style="background-color: ${t.color || '#ef4444'};"></div>
            <div class="track-setting-info">
              <b class="track-setting-name">${escapeHtml(t.name)}</b>
              <span class="track-setting-dist">${fmtDistance(t.distance)} · ${t.points ? t.points.length : 0} точек</span>
            </div>
            <div class="track-setting-actions">
              <button type="button" class="icon-btn-sm js-vis" title="${isHidden ? 'Показать на карте' : 'Скрыть'}">${isHidden ? '🕶️' : '👁️'}</button>
              <button type="button" class="icon-btn-sm js-zoom" title="Показать на карте">🎯</button>
              <button type="button" class="icon-btn-sm js-share" title="${isSharedTitle}">${isSharedIcon}</button>
              <button type="button" class="icon-btn-sm js-rename" title="Переименовать">✏️</button>
              <button type="button" class="icon-btn-sm js-gpx" title="Скачать GPX">💾</button>
              <button type="button" class="icon-btn-sm js-del" style="color:var(--danger);" title="Удалить">🗑️</button>
            </div>
          `;

          item.querySelector('.js-vis').onclick = () => {
            WM.tracker.toggleTrackVisibility(t.id);
            renderTrackSettingsList();
          };
          item.querySelector('.js-zoom').onclick = () => {
            $('modal').classList.remove('open');
            WM.tracker.zoomToTrack(t.id);
          };
          item.querySelector('.js-share').onclick = () => {
            if (WM.tracker && WM.tracker.openShareModal) {
              WM.tracker.openShareModal(t);
            }
          };
          item.querySelector('.js-rename').onclick = () => {
            const newName = prompt('Новое название трека:', t.name);
            if (newName) {
              WM.tracker.renameTrack(t.id, newName);
              renderTrackSettingsList();
            }
          };
          item.querySelector('.js-gpx').onclick = () => {
            WM.tracker.exportGpx(t.id);
          };
          item.querySelector('.js-del').onclick = () => {
            if (confirm(`Удалить трек «${t.name}»?`)) {
              WM.tracker.deleteTrack(t.id);
              renderTrackSettingsList();
            }
          };

          container.appendChild(item);
        });
      }
      window.renderTrackSettingsList = renderTrackSettingsList;

      // Привязка кнопки импорта GPX/GeoJSON файлов
      const importInput = $('track-import-input');
      $('btn-track-import-file')?.addEventListener('click', () => importInput?.click());
      importInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            WM.tracker.importFile(ev.target.result, file.name);
            renderTrackSettingsList();
            showToast(`✅ Трек «${file.name}» успешно загружен`);
          } catch (err) {
            alert('Ошибка чтения трека: ' + err.message);
          }
          importInput.value = '';
        };
        reader.readAsText(file);
      });

      $('track-line-width-slider')?.addEventListener('input', (e) => {
        if ($('track-line-width-val')) $('track-line-width-val').textContent = e.target.value + ' px';
      });
      $('track-line-opacity-slider')?.addEventListener('input', (e) => {
        if ($('track-line-opacity-val')) $('track-line-opacity-val').textContent = e.target.value + '%';
      });
      // ===================================================

      // Функция динамического описания режимов камеры
      function updateCameraModeHint(mode) {
        const hintEl = $('track-camera-mode-hint');
        if (!hintEl) return;
        const hints = {
          'auto': '🎯 Авторежим: камера следует за GPS. При ручном сдвиге карты открепляется и автоматически возвращается через 30 секунд бездействия.',
          'soft_auto': '🍃 Мягкий авторежим: если GPS виден на экране, камера возвращается через 5 секунд после сдвига. Если сместились далеко — остаётся свободной.',
          'locked': '🔒 Всегда привязана: камера намертво зафиксирована на позиции GPS и блокирует ручное смещение карты.',
          'free': '🔓 Свободная: камера никогда не смещается сама, вы управляете картой полностью вручную.'
        };
        hintEl.textContent = hints[mode] || hints['auto'];
      }

      // Привязка слушателя изменения селектора
      $('track-camera-mode-select')?.addEventListener('change', (e) => {
        updateCameraModeHint(e.target.value);
      });

      $('btn-settings').onclick = () => {
        // СВОРАЧИВАЕМ ВСЕ СПОЙЛЕРЫ ПО УМОЛЧАНИЮ
        document.querySelectorAll('#modal details.spoiler').forEach(d => {
          d.open = false;
        });

        // <-- ВСТАВИТЬ СЮДА:
        updateBatteryOptimizationUI();

        // <-- Добавьте сюда вызов отрисовки списка и синхронизацию полей трекера:
        if (window.renderTrackSettingsList) {
          window.renderTrackSettingsList();
        }
        if (WM.tracker) {
          const tSettings = WM.tracker.getSettings();
          if ($('toggle-track-anomaly-filter')) $('toggle-track-anomaly-filter').checked = tSettings.anomalyFilter !== false;
          if ($('toggle-track-anomaly-vibro')) $('toggle-track-anomaly-vibro').checked = tSettings.anomalyVibro !== false;
          if ($('track-power-profile-select')) $('track-power-profile-select').value = tSettings.powerProfile || 'balanced';
          if ($('toggle-track-wakelock')) $('toggle-track-wakelock').checked = tSettings.keepScreenOn === true;
          if ($('toggle-track-autopause')) $('toggle-track-autopause').checked = tSettings.autoPause === true;
          if ($('toggle-track-step-wake')) $('toggle-track-step-wake').checked = tSettings.useStepSensorToWake !== false;
          if ($('toggle-track-battery-guard')) $('toggle-track-battery-guard').checked = tSettings.batteryGuard !== false;
          if ($('track-altitude-source-select')) $('track-altitude-source-select').value = tSettings.altitudeSource || 'gps';
          if ($('toggle-track-elevation-smoothing')) $('toggle-track-elevation-smoothing').checked = tSettings.altitudeSmoothing !== false;

          // Новые поля:
          if ($('track-default-interval-select')) $('track-default-interval-select').value = tSettings.minIntervalSec || 3;
          if ($('track-default-dist-select')) $('track-default-dist-select').value = tSettings.minDistanceMeters || 5;
          if ($('track-camera-mode-select')) {
              $('track-camera-mode-select').value = tSettings.cameraMode || 'auto';
              updateCameraModeHint(tSettings.cameraMode || 'auto'); // <-- ВЫЗЫВАЕМ ПРИ ОТКРЫТИИ
            }
          
          if ($('track-line-width-slider')) {
            $('track-line-width-slider').value = tSettings.lineWidth || 4;
            if ($('track-line-width-val')) $('track-line-width-val').textContent = (tSettings.lineWidth || 4) + ' px';
          }
          if ($('track-line-opacity-slider')) {
            $('track-line-opacity-slider').value = Math.round((tSettings.lineOpacity || 0.85) * 100);
            if ($('track-line-opacity-val')) $('track-line-opacity-val').textContent = Math.round((tSettings.lineOpacity || 0.85) * 100) + '%';
          }
          if ($('toggle-track-arrows')) $('toggle-track-arrows').checked = tSettings.showArrows !== false;

          // ВОТ СЮДА ВСТАВЛЯЕМ СТРОЧКУ СИНХРОНИЗАЦИИ:
          if ($('toggle-track-show-shared')) $('toggle-track-show-shared').checked = tSettings.showSharedTracks === true;
        }
        if (WM.inat && WM.inat.syncSettingsInputs) {
          WM.inat.syncSettingsInputs();
        }

        if ($('toggle-qm-item-shadowheight')) {
          $('toggle-qm-item-shadowheight').checked = quickMenuConfig.items.shadowHeight !== false;
        }

        if ($('toggle-qm-item-manualpdr')) {
          $('toggle-qm-item-manualpdr').checked = !!quickMenuConfig.items.manualPdr;
        }
        if ($('toggle-qm-item-compass-adjust')) $('toggle-qm-item-compass-adjust').checked = !!quickMenuConfig.items.compassAdjust;
        if ($('toggle-qm-item-pdr-quick')) $('toggle-qm-item-pdr-quick').checked = !!quickMenuConfig.items.pdrQuick;
        if ($('toggle-qm-item-night-vision')) $('toggle-qm-item-night-vision').checked = !!quickMenuConfig.items.nightVision;
        if ($('toggle-qm-item-inathub')) $('toggle-qm-item-inathub').checked = quickMenuConfig.items.inatHub !== false;
        if ($('toggle-qm-item-water')) $('toggle-qm-item-water').checked = quickMenuConfig.items.water !== false;

        if ($('toggle-qm-item-soil')) $('toggle-qm-item-soil').checked = quickMenuConfig.items.soil !== false;


        if ($('toggle-pdr-step-vibe') && WM.pdr) {
          $('toggle-pdr-step-vibe').checked = WM.pdr.getConfig().stepVibration !== false;
        }
        if ($('nav-vibro-mode-select') && WM.navVibro) {
          $('nav-vibro-mode-select').value = WM.navVibro.getMode();
          const wrapCone = $('nav-vibro-cone-wrap');
          const wrapInt = $('nav-vibro-interval-wrap');
          if (wrapCone) wrapCone.hidden = (WM.navVibro.getMode() === 'off');
          if (wrapInt) wrapInt.hidden = (WM.navVibro.getMode() !== 'correct');
        }
        if ($('nav-vibro-cone-slider') && WM.navVibro) {
          $('nav-vibro-cone-slider').value = WM.navVibro.getCone();
          if ($('nav-vibro-cone-val')) $('nav-vibro-cone-val').textContent = `±${WM.navVibro.getCone()}°`;
        }
        if ($('nav-vibro-interval-slider') && WM.navVibro) {
          $('nav-vibro-interval-slider').value = WM.navVibro.getInterval();
          if ($('nav-vibro-interval-val')) $('nav-vibro-interval-val').textContent = `каждые ${WM.navVibro.getInterval()} сек`;
        }

        const pdrCfg = WM.pdr ? WM.pdr.getConfig() : {};
        const isAutoEngageOn = pdrCfg.autoEngageOnSpoof !== false;
        if ($('toggle-pdr-auto-engage')) $('toggle-pdr-auto-engage').checked = isAutoEngageOn;
        if ($('toggle-dead-reckon')) $('toggle-dead-reckon').checked = isAutoEngageOn;

        const stepSlider = $('pdr-step-length-slider');
        const stepVal = $('pdr-step-length-val');
        if (stepSlider && stepVal) {
          const stepCm = Math.round((pdrCfg.baseStepLength || 0.75) * 100);
          stepSlider.value = stepCm;
          stepVal.textContent = stepCm + ' см';
          stepSlider.oninput = (e) => {
            stepVal.textContent = e.target.value + ' см';
            if (WM.pdr) WM.pdr.setConfig({ baseStepLength: parseFloat(e.target.value) / 100 });
          };
        }


        if ($('pdr-heading-source-select')) {
          const hSrc = pdrCfg.headingSource || 'fusion';
          $('pdr-heading-source-select').value = hSrc;
          const hint = $('pdr-heading-source-hint');
          if (hint) {
            hint.textContent = hSrc === 'compass'
              ? '«Только компас» отключает гироскоп и стабилизирует курс адаптивным фильтром. Подходит при дрейфе или плохом гироскопе.'
              : '«Гироскоп + Компас» даёт максимальную плавность и быстроту реакции благодаря слиянию датчиков.';
          }
        }

        if ($('toggle-pdr-dynamic-stride')) $('toggle-pdr-dynamic-stride').checked = pdrCfg.useDynamicStride !== false;
        if ($('pdr-sensitivity-select')) $('pdr-sensitivity-select').value = pdrCfg.sensitivity || 'normal';
        if ($('pdr-damping-select')) $('pdr-damping-select').value = pdrCfg.headingDamping || 'medium';



        const passSettingsInput = $('shared-markers-password-input');
        if (passSettingsInput && WM.sharedMarkers) {
          passSettingsInput.value = WM.sharedMarkers.getPassword() || '';
          if (WM.sharedMarkers.updateSettingsPassInfo) {
            WM.sharedMarkers.updateSettingsPassInfo();
          }
        }

        if (chkTail && subTail) {
          chkTail.checked = uiVis.motiontail !== false;
          subTail.hidden = !chkTail.checked;
        }
        if (sliderTailLen && valTailLen) {
          const curLen = WM.motionTail ? WM.motionTail.getLength() : 15;
          sliderTailLen.value = curLen;
          valTailLen.textContent = curLen;
        }
        if (colorTail && valColorTail) {
          const curCol = WM.motionTail ? WM.motionTail.getColor() : '#0284c7';
          colorTail.value = curCol;
          valColorTail.textContent = curCol;
        }

        // Загрузка состояний чекбоксов инфо-панели
        const chkInfoMenu = $('toggle-ui-infomenu');
        if (chkInfoMenu) chkInfoMenu.checked = !!uiVis.infomenu;
        const subInfo = $('sub-infomenu-settings');
        if (subInfo) subInfo.hidden = !uiVis.infomenu;

        if ($('toggle-info-time')) $('toggle-info-time').checked = infoHudConfig.time;
        if ($('toggle-info-usercoords')) $('toggle-info-usercoords').checked = infoHudConfig.userCoords;
        if ($('toggle-info-centercoords')) $('toggle-info-centercoords').checked = infoHudConfig.centerCoords;
        if ($('toggle-info-gps')) $('toggle-info-gps').checked = infoHudConfig.gps;
        if ($('toggle-info-sun')) $('toggle-info-sun').checked = infoHudConfig.sun;
        if ($('toggle-info-moon')) $('toggle-info-moon').checked = infoHudConfig.moon;
        if ($('toggle-info-weather')) $('toggle-info-weather').checked = infoHudConfig.weather;
        if ($('toggle-info-rays')) $('toggle-info-rays').checked = infoHudConfig.rays;


        editingKeys = [...WM.api.keys];
        editingActiveIndex = WM.api.activeIndex;
        renderBaseMapsSettingsUI();
        renderKeysUI();
        $('net-mode').value = WM.api.netMode;
        const antiSpoofOn = WM.api.store.get('wm_gps_anti_spoof') !== 'false';
        if ($('toggle-anti-spoof')) $('toggle-anti-spoof').checked = antiSpoofOn;

        // Загрузка состояния быстрого меню в чекбоксы
        const chkQmEnabled = $('toggle-qm-enabled');
        if (chkQmEnabled) chkQmEnabled.checked = quickMenuConfig.enabled;
        const subQm = $('quick-menu-settings-sub');
        if (subQm) subQm.hidden = !quickMenuConfig.enabled;

        if ($('toggle-qm-trigger-longpress')) $('toggle-qm-trigger-longpress').checked = quickMenuConfig.triggers.longpress;
        if ($('toggle-qm-trigger-crosshair')) $('toggle-qm-trigger-crosshair').checked = quickMenuConfig.triggers.crosshair;
        if ($('toggle-qm-trigger-btn')) $('toggle-qm-trigger-btn').checked = quickMenuConfig.triggers.btn;

        if ($('toggle-qm-item-objects')) $('toggle-qm-item-objects').checked = quickMenuConfig.items.objects;
        if ($('toggle-qm-item-quickmeasure')) $('toggle-qm-item-quickmeasure').checked = quickMenuConfig.items.quickMeasure;
        if ($('toggle-qm-item-measure')) $('toggle-qm-item-measure').checked = quickMenuConfig.items.measure;
        if ($('toggle-qm-item-marker')) $('toggle-qm-item-marker').checked = quickMenuConfig.items.marker;
        if ($('toggle-qm-item-gps-dist')) $('toggle-qm-item-gps-dist').checked = quickMenuConfig.items.gpsDist; // <-- ДОБАВИТЬ
        if ($('toggle-qm-item-placeinsight')) $('toggle-qm-item-placeinsight').checked = quickMenuConfig.items.placeInsight !== false;

        if ($('toggle-qm-item-coords')) $('toggle-qm-item-coords').checked = quickMenuConfig.items.coords;
        if ($('toggle-qm-item-rays')) $('toggle-qm-item-rays').checked = quickMenuConfig.items.sunMoonRays !== false;

        // --- СИНХРОНИЗАЦИЯ НАСТРОЕК КРУГА ДАЛЬНОСТИ И БЫСТРОГО МЕНЮ ---
        const chkRR = $('toggle-ui-rangering');
        const subRR = $('sub-rangering-settings');
        if (chkRR && subRR) {
          chkRR.checked = !!uiVis.rangering;
          subRR.hidden = !chkRR.checked; // Раскрываем блок, если круг включен
        }

        if ($('toggle-qm-item-rangering')) {
          $('toggle-qm-item-rangering').checked = !!quickMenuConfig.items.rangering;
        }

        const sliderFontSize = $('rr-font-size-slider');
        const valFontSize = $('rr-font-size-val');
        if (sliderFontSize && valFontSize && WM.rangeRing) {
          sliderFontSize.value = WM.rangeRing.getFontSize();
          valFontSize.textContent = sliderFontSize.value + ' px';
        }

        const colorTextRR = $('rr-text-color-select');
        const valColorTextRR = $('rr-text-color-val');
        if (colorTextRR && valColorTextRR && WM.rangeRing) {
          colorTextRR.value = WM.rangeRing.getTextColor();
          valColorTextRR.textContent = colorTextRR.value;
        }

        if (hybridSlider && hybridVal) {
          hybridSlider.value = C.VECTOR_ZOOM;
          hybridVal.textContent = `зум ${parseFloat(C.VECTOR_ZOOM).toFixed(1)}`;
        }
        updateHybridSliderVisibility();

        // --- ДОБАВИТЬ ЭТОТ БЛОК: считывание текущих фильтров в чекбоксы ---
        if (WM.view && WM.view.getFilters) {
          const f = WM.view.getFilters();
          const chkAuto = $('toggle-filter-auto-size');
          const chkBuild = $('toggle-filter-hide-buildings');
          const chkReg = $('toggle-filter-hide-regions');
          const chkDel = $('toggle-filter-hide-deleted');
          const chkDensity = $('toggle-filter-hide-small-density');
          const chkSmall = $('toggle-filter-hide-small');
          const chkMed = $('toggle-filter-hide-medium');
          const chkLarge = $('toggle-filter-hide-large');

          if (chkAuto) chkAuto.checked = f.autoSize !== false;
          if (chkBuild) chkBuild.checked = !!f.hideBuildings;
          if (chkReg) chkReg.checked = !!f.hideRegions;
          if (chkDel) chkDel.checked = !!f.hideDeleted;
          if (chkDensity) chkDensity.checked = !!f.hideSmallDensity;
          if (chkSmall) chkSmall.checked = !!f.hideSmall;
          if (chkMed) chkMed.checked = !!f.hideMedium;
          if (chkLarge) chkLarge.checked = !!f.hideLarge;

          updateSizeFilterTogglesState();
        }
        // ------------------------------------------------------------------

        VIS_KEYS.forEach(k => {
          const chk = $('toggle-ui-' + k);
          if (chk) chk.checked = uiVis[k] !== false;
        });

        const currentRadios = document.querySelectorAll('input[name="app-work-mode"]');
        currentRadios.forEach(r => { r.checked = (r.value === workMode); });
        const chkAutoHover = $('toggle-auto-hover');
        if (chkAutoHover) chkAutoHover.checked = autoHoverEnabled;
        if ($('toggle-auto-details')) $('toggle-auto-details').checked = autoDetailsEnabled;
        if ($('toggle-auto-details-crosshair')) $('toggle-auto-details-crosshair').checked = autoDetailsCrosshairOnly;
        updateAutoDetailsSubVisibility();

        if ($('toggle-no-evict-objects')) {
          $('toggle-no-evict-objects').checked = WM.api.store.get('wm_no_evict_objects') === 'true';
        }
        if ($('toggle-no-evict-tiles')) {
          $('toggle-no-evict-tiles').checked = WM.api.store.get('wm_no_evict_tiles') === 'true';
        }

        populateStyleInputs();
        snapshotVector = WM.view.getVectorStyle();
        snapshotRaster = { ...rasterStyle };

        pushHistoryState('modal');
        $('modal').classList.add('open');
      };

      const inputNewKey = $('new-key-input');
      const handleAddKeyInput = () => {
        const val = inputNewKey.value.trim();
        if (val) {
          const extracted = extractWikimapiaKeys(val);
          if (extracted.length > 0) {
            addDiscoveredKeys(extracted);
            inputNewKey.value = '';
          } else {
            const trimmed = val.replace(/[^0-9a-fA-F\-]/g, '').toUpperCase();
            if (trimmed.length >= 60) {
              addDiscoveredKeys([trimmed]);
              inputNewKey.value = '';
            } else {
              alert('Некорректный формат ключа Wikimapia (ожидается 8 групп по 8 символов через дефис).');
            }
          }
        }
      };

      $('btn-add-key').onclick = handleAddKeyInput;
      inputNewKey.onkeydown = (e) => {
        if (e.key === 'Enter') handleAddKeyInput();
      };

      $('btn-paste-keys').onclick = async () => {
        let clipText = '';
        let readSuccess = false;

        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            clipText = await navigator.clipboard.readText();
            readSuccess = true;
          }
        } catch (e) {
          readSuccess = false;
        }

        if (readSuccess && clipText && clipText.trim()) {
          const keys = extractWikimapiaKeys(clipText);
          if (keys.length > 0) {
            addDiscoveredKeys(keys);
            return;
          }
        }

        const pasteModal = $('modal-paste-keys');
        const pasteTextarea = $('paste-keys-textarea');
        if (pasteModal && pasteTextarea) {
          pasteTextarea.value = (readSuccess && clipText) ? clipText : '';
          pasteModal.classList.add('open');
          setTimeout(() => pasteTextarea.focus(), 100);
        }
      };

      const pasteSubmit = $('paste-keys-submit');
      if (pasteSubmit) {
        pasteSubmit.onclick = () => {
          const area = $('paste-keys-textarea');
          const val = area ? area.value : '';
          const keys = extractWikimapiaKeys(val);
          if (!keys.length) {
            alert('Ключи Wikimapia в тексте не обнаружены.\nУбедитесь, что скопировали страницу со своими ключами на сайте wikimapia.org и повторите попытку.');
            return;
          }
          addDiscoveredKeys(keys);
          const modal = $('modal-paste-keys');
          if (modal) modal.classList.remove('open');
          if (area) area.value = '';
        };
      }

      const pasteCancel = $('paste-keys-cancel');
      if (pasteCancel) pasteCancel.onclick = () => { const m = $('modal-paste-keys'); if (m) m.classList.remove('open'); };

      const pasteX = $('paste-keys-x');
      if (pasteX) pasteX.onclick = () => { const m = $('modal-paste-keys'); if (m) m.classList.remove('open'); };

      const btnKeysGuide = $('btn-keys-guide');
      if (btnKeysGuide) btnKeysGuide.onclick = () => { const m = $('modal-keys-guide'); if (m) m.classList.add('open'); };

      const keysGuideClose = $('keys-guide-close');
      if (keysGuideClose) keysGuideClose.onclick = () => { const m = $('modal-keys-guide'); if (m) m.classList.remove('open'); };

      const keysGuideX = $('keys-guide-x');
      if (keysGuideX) keysGuideX.onclick = () => { const m = $('modal-keys-guide'); if (m) m.classList.remove('open'); };

      $('btn-export-db').onclick = async () => {
        try {
          const count = await WM.cache.exportDump();
          showToast(`Экспортировано объектов: ${count}`);
        } catch (e) {
          alert('Ошибка экспорта: ' + e.message);
        }
      };

      const fileInput = $('input-import-file');
      $('btn-import-db-trigger').onclick = () => fileInput.click();

      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const count = await WM.cache.importDump(e.target.result);
            showToast(`Успешно импортировано объектов: ${count}`, 1500);
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          } catch (err) {
            alert('Ошибка импорта базы: ' + err.message);
          } finally {
            fileInput.value = '';
          }
        };
        reader.readAsText(file);
      };

      $('btn-clear-tiles').onclick = () => {
        openClearTilesModal();
      };

      // 2. Обработчики кнопок внутри самого модального окна:
      const clearTilesModal = $('modal-clear-tiles');
      if (clearTilesModal) {
        // Закрытие окна по клику на крестик, отмену или фон
        clearTilesModal.addEventListener('click', (e) => {
          if (e.target === clearTilesModal) clearTilesModal.classList.remove('open');
        });
        if ($('clear-tiles-x')) $('clear-tiles-x').onclick = () => clearTilesModal.classList.remove('open');
        if ($('clear-tiles-cancel')) $('clear-tiles-cancel').onclick = () => clearTilesModal.classList.remove('open');

        // Кнопки "Выбрать все" и "Снять все"
        if ($('btn-tiles-select-all')) {
          $('btn-tiles-select-all').onclick = () => {
            document.querySelectorAll('.clear-tile-checkbox').forEach(c => { c.checked = true; });
          };
        }
        if ($('btn-tiles-deselect-all')) {
          $('btn-tiles-deselect-all').onclick = () => {
            document.querySelectorAll('.clear-tile-checkbox').forEach(c => { c.checked = false; });
          };
        }

        // Кнопка подтверждения удаления
        if ($('clear-tiles-submit')) {
          $('clear-tiles-submit').onclick = async () => {
            const selected = Array.from(document.querySelectorAll('.clear-tile-checkbox:checked'))
              .map(c => c.dataset.providerId);

            if (!selected.length) {
              showToast('Не выбрано ни одной карты для очистки');
              return;
            }

            showToast('⏳ Удаление тайлов из памяти…', 1500);
            const count = await WM.cache.deleteCachedTilesByProviders(selected);
            clearTilesModal.classList.remove('open');
            showToast(`✅ Удалено тайлов: ${count}`);
          };
        }
      }

      $('btn-clear-all').onclick = async () => {
        if (confirm('Очистить ВСЁ (кэш базы полигонов, сохраненные тайлы карт, все пользовательские метки и измерения линейки)?')) {
          await WM.cache.clearAllStorage();
          WM.view.render();
          WM.ui.updateStatusFromLoader();
          alert('Полная очистка выполнена: база объектов, карты, метки и измерения удалены.');
        }
      };

      const closeModal = () => {
        if (snapshotVector) WM.view.applyVectorStyle(snapshotVector);
        if (snapshotRaster) applyRasterCSS(snapshotRaster);
        $('modal').classList.remove('open');
      };

      $('modal-cancel').onclick = closeModal;
      $('modal-x').onclick = closeModal;

      $('modal-save').onclick = () => {
        VIS_KEYS.forEach(k => {
          const chk = $('toggle-ui-' + k);
          if (chk) uiVis[k] = chk.checked;
        });
        applyUIVisibility();

        const autoEngageSpoofVal = $('toggle-pdr-auto-engage') 
          ? $('toggle-pdr-auto-engage').checked 
          : ($('toggle-dead-reckon') ? $('toggle-dead-reckon').checked : true);

          const sndTop = $('toggle-pdr-step-sound');
          if (sndTop && WM.pdr) {
            WM.pdr.setSoundEnabled(sndTop.checked);
          }



        if (WM.pdr) {
          const stepSlider = $('pdr-step-length-slider');
          WM.pdr.setConfig({
            headingSource: $('pdr-heading-source-select') ? $('pdr-heading-source-select').value : 'fusion',
            carryingMode: $('pdr-carrying-mode') ? $('pdr-carrying-mode').value : 'hand',
            movementType: $('pdr-movement-type-select') ? $('pdr-movement-type-select').value : 'normal',
            baseStepLength: stepSlider ? parseFloat(stepSlider.value) / 100 : 0.75,
            useDynamicStride: $('toggle-pdr-dynamic-stride') ? $('toggle-pdr-dynamic-stride').checked : true,
            sensitivity: $('pdr-sensitivity-select') ? $('pdr-sensitivity-select').value : 'normal',
            headingDamping: $('pdr-damping-select') ? $('pdr-damping-select').value : 'medium',
            autoEngageOnSpoof: autoEngageSpoofVal
          });
        }






        if (hybridSlider) {
          const val = parseFloat(hybridSlider.value);
          C.VECTOR_ZOOM = val;
        }

        if (WM.motionTail) {
          if (sliderTailLen) WM.motionTail.setLength(sliderTailLen.value);
          if (colorTail) WM.motionTail.setColor(colorTail.value);
        }

        const chkStepPill = $('toggle-pdr-step-pill');
        if (chkStepPill) {
          const val = chkStepPill.checked;
          localStorage.setItem('wm_pdr_step_pill', val ? 'true' : 'false');
          if (window.WM && WM.setPdrStepPillEnabled) WM.setPdrStepPillEnabled(val);
        }

        const passSettingsInput = $('shared-markers-password-input');
        if (passSettingsInput && WM.sharedMarkers) {
          WM.sharedMarkers.setPassword(passSettingsInput.value);
        }

        const chkMV = $('toggle-ui-motionvector');
        if (chkMV) {
          uiVis.motionvector = chkMV.checked;
          if (WM.motionVector) WM.motionVector.setEnabled(chkMV.checked);
        }

        const disabledMaps = [];
        document.querySelectorAll('.map-checkbox-input').forEach(chk => {
          if (!chk.checked && chk.dataset.mapName) {
            disabledMaps.push(chk.dataset.mapName);
          }
        });
        localStorage.setItem('wm_disabled_base_maps', JSON.stringify(disabledMaps));
        if (WM.rebuildBaseLayersControl) WM.rebuildBaseLayersControl();

        quickMenuConfig.items.shadowHeight = $('toggle-qm-item-shadowheight') ? $('toggle-qm-item-shadowheight').checked : true;

        const chkAutoHover = $('toggle-auto-hover');
        if (chkAutoHover) {
          autoHoverEnabled = chkAutoHover.checked;
          WM.api.store.set('wm_auto_hover', autoHoverEnabled ? 'true' : 'false');
        }

        const chkDetails = $('toggle-auto-details');
        autoDetailsEnabled = chkDetails ? chkDetails.checked : false;
        WM.api.store.set('wm_auto_details', autoDetailsEnabled ? 'true' : 'false');

        const chkDetailsCross = $('toggle-auto-details-crosshair');
        autoDetailsCrosshairOnly = chkDetailsCross ? chkDetailsCross.checked : true;
        WM.api.store.set('wm_auto_details_crosshair', autoDetailsCrosshairOnly ? 'true' : 'false');

        const checkedMode = document.querySelector('input[name="app-work-mode"]:checked');
        if (checkedMode) {
          workMode = checkedMode.value;
          WM.api.store.set('wm_work_mode', workMode);
        }

        const newVec = readVectorInputs();
        WM.api.store.set('wm_style_vector', JSON.stringify(newVec));
        WM.view.applyVectorStyle(newVec);

        rasterStyle = readRasterInputs();
        WM.api.store.set('wm_style_raster', JSON.stringify(rasterStyle));
        applyRasterCSS(rasterStyle);

        infoHudConfig.time = $('toggle-info-time') ? $('toggle-info-time').checked : true;
        infoHudConfig.userCoords = $('toggle-info-usercoords') ? $('toggle-info-usercoords').checked : true;
        infoHudConfig.centerCoords = $('toggle-info-centercoords') ? $('toggle-info-centercoords').checked : true;
        infoHudConfig.gps = $('toggle-info-gps') ? $('toggle-info-gps').checked : true;
        infoHudConfig.sun = $('toggle-info-sun') ? $('toggle-info-sun').checked : true;
        infoHudConfig.moon = $('toggle-info-moon') ? $('toggle-info-moon').checked : true;
        infoHudConfig.weather = $('toggle-info-weather') ? $('toggle-info-weather').checked : true;
        infoHudConfig.rays = $('toggle-info-rays') ? $('toggle-info-rays').checked : false;



        WM.api.store.set('wm_info_hud_items', JSON.stringify(infoHudConfig));
        updateInfoHudUI();
        updateRaysBtnState();

        quickMenuConfig.items.manualPdr = $('toggle-qm-item-manualpdr') ? $('toggle-qm-item-manualpdr').checked : false;


        quickMenuConfig.enabled = $('toggle-qm-enabled') ? $('toggle-qm-enabled').checked : true;

        quickMenuConfig.items.compassAdjust = $('toggle-qm-item-compass-adjust') ? $('toggle-qm-item-compass-adjust').checked : false;
        quickMenuConfig.items.pdrQuick = $('toggle-qm-item-pdr-quick') ? $('toggle-qm-item-pdr-quick').checked : false;
        quickMenuConfig.items.nightVision = $('toggle-qm-item-night-vision') ? $('toggle-qm-item-night-vision').checked : false;
        quickMenuConfig.triggers.longpress = $('toggle-qm-trigger-longpress') ? $('toggle-qm-trigger-longpress').checked : false;
        quickMenuConfig.triggers.crosshair = $('toggle-qm-trigger-crosshair') ? $('toggle-qm-trigger-crosshair').checked : false;
        quickMenuConfig.triggers.btn = $('toggle-qm-trigger-btn') ? $('toggle-qm-trigger-btn').checked : true;
        quickMenuConfig.items.inatHub = $('toggle-qm-item-inathub') ? $('toggle-qm-item-inathub').checked : true;

        quickMenuConfig.items.objects = $('toggle-qm-item-objects') ? $('toggle-qm-item-objects').checked : true;
        quickMenuConfig.items.placeInsight = $('toggle-qm-item-placeinsight') ? $('toggle-qm-item-placeinsight').checked : true;
        quickMenuConfig.items.water = $('toggle-qm-item-water') ? $('toggle-qm-item-water').checked : true;
        quickMenuConfig.items.soil = $('toggle-qm-item-soil') ? $('toggle-qm-item-soil').checked : true;
        quickMenuConfig.items.quickMeasure = $('toggle-qm-item-quickmeasure') ? $('toggle-qm-item-quickmeasure').checked : true;
        quickMenuConfig.items.measure = $('toggle-qm-item-measure') ? $('toggle-qm-item-measure').checked : true;
        quickMenuConfig.items.marker = $('toggle-qm-item-marker') ? $('toggle-qm-item-marker').checked : true;
        quickMenuConfig.items.gpsDist = $('toggle-qm-item-gps-dist') ? $('toggle-qm-item-gps-dist').checked : true; // <-- ДОБАВИТЬ
        quickMenuConfig.items.coords = $('toggle-qm-item-coords') ? $('toggle-qm-item-coords').checked : true;
        quickMenuConfig.items.sunMoonRays = $('toggle-qm-item-rays') ? $('toggle-qm-item-rays').checked : true;
        quickMenuConfig.items.rangering = $('toggle-qm-item-rangering') ? $('toggle-qm-item-rangering').checked : false;

        WM.api.store.set('wm_quick_menu', JSON.stringify(quickMenuConfig));
        updateQuickMenuTriggersUI();
        updateManualPdrBtnState();


        snapshotVector = null;
        snapshotRaster = null;



        if (WM.view && WM.view.setFilters) {
          WM.view.setFilters({
            autoSize: $('toggle-filter-auto-size') ? $('toggle-filter-auto-size').checked : true,
            hideBuildings: $('toggle-filter-hide-buildings') ? $('toggle-filter-hide-buildings').checked : false,
            hideRegions: $('toggle-filter-hide-regions') ? $('toggle-filter-hide-regions').checked : false,
            hideDeleted: $('toggle-filter-hide-deleted') ? $('toggle-filter-hide-deleted').checked : false,
            hideSmallDensity: $('toggle-filter-hide-small-density') ? $('toggle-filter-hide-small-density').checked : true,
            hideSmall: $('toggle-filter-hide-small') ? $('toggle-filter-hide-small').checked : false,
            hideMedium: $('toggle-filter-hide-medium') ? $('toggle-filter-hide-medium').checked : false,
            hideLarge: $('toggle-filter-hide-large') ? $('toggle-filter-hide-large').checked : false
          });
        }
        // -----------------------------------------------------------

        WM.api.save(editingKeys, $('net-mode').value, editingActiveIndex);

        const antiSpoofChecked = $('toggle-anti-spoof') ? $('toggle-anti-spoof').checked : true;
        WM.api.store.set('wm_gps_anti_spoof', antiSpoofChecked ? 'true' : 'false');
        WM.api.store.set('wm_gps_dead_reckon', autoEngageSpoofVal ? 'true' : 'false');
        if (WM.antiSpoof) {
          WM.antiSpoof.setEnabled(antiSpoofChecked);
          WM.antiSpoof.setDeadReckoningEnabled(autoEngageSpoofVal);
        }

        const noEvictObjs = $('toggle-no-evict-objects') ? $('toggle-no-evict-objects').checked : false;
        const noEvictTiles = $('toggle-no-evict-tiles') ? $('toggle-no-evict-tiles').checked : false;

        WM.api.store.set('wm_no_evict_objects', noEvictObjs ? 'true' : 'false');
        WM.api.store.set('wm_no_evict_tiles', noEvictTiles ? 'true' : 'false');

        // Передаем новый режим в модуль кэша и отправляем сигнал Service Worker'у
        if (WM.cache && WM.cache.setNoEvict) WM.cache.setNoEvict(noEvictObjs);
        syncSWNoTrim(noEvictTiles);

        const chkQuickSwap = $('toggle-quick-swap-enabled');
        const selectQuickSwapPos = $('quick-swap-pos-select');
        const isQuickSwapEnabled = chkQuickSwap ? chkQuickSwap.checked : false;
        const targetSwapPos = selectQuickSwapPos ? selectQuickSwapPos.value : 'top-right';

        localStorage.setItem('wm_quick_swap_enabled', isQuickSwapEnabled ? 'true' : 'false');
        localStorage.setItem('wm_quick_swap_pos', targetSwapPos);

        if (window.updateQuickSwapUI) {
          window.updateQuickSwapUI();
        }


        // Сохраняем параметры трекера
        if (WM.tracker) {
          const widthSlider = $('track-line-width-slider');
          const opacitySlider = $('track-line-opacity-slider');
          WM.tracker.setSettings({
            anomalyFilter: $('toggle-track-anomaly-filter')?.checked !== false,
            anomalyVibro: $('toggle-track-anomaly-vibro')?.checked !== false,
            powerProfile: $('track-power-profile-select')?.value || 'balanced',
            keepScreenOn: $('toggle-track-wakelock')?.checked === true,
            autoPause: $('toggle-track-autopause')?.checked === true,
            useStepSensorToWake: $('toggle-track-step-wake')?.checked !== false,
            batteryGuard: $('toggle-track-battery-guard')?.checked !== false,
            altitudeSource: $('track-altitude-source-select')?.value || 'gps',
            altitudeSmoothing: $('toggle-track-elevation-smoothing')?.checked !== false,
            
            // Новые настройки:
            minIntervalSec: parseInt($('track-default-interval-select')?.value, 10) || 3,
            minDistanceMeters: parseInt($('track-default-dist-select')?.value, 10) || 5,
            cameraMode: $('track-camera-mode-select')?.value || 'auto',
            lineWidth: widthSlider ? parseFloat(widthSlider.value) : 4,
            lineOpacity: opacitySlider ? parseFloat(opacitySlider.value) / 100 : 0.85,
            showArrows: $('toggle-track-arrows')?.checked !== false,
            showSharedTracks: $('toggle-track-show-shared')?.checked === true
          });
        }

        $('modal').classList.remove('open');

        if (window.syncRasterOverlay) window.syncRasterOverlay();
        WM.loader.reset();
        WM.view.render();

        // <--- ВОТ СЮДА ВСТАВЛЯЕТСЯ ЭТОТ ВЫЗОВ:
        if (WM.loader && WM.loader.onSettingsChanged) {
          WM.loader.onSettingsChanged();
        }
        updateMotionBtnState();
      };

      $('btn-download-area').onclick = () => $('modal-precache').classList.add('open');
      const closePrecache = () => {
        const wasRunning = WM.loader.isPrecaching;
        WM.loader.stopPrecache();
        $('modal-precache').classList.remove('open');
        $('precache-progress-wrap').hidden = true;
        $('precache-start').disabled = false;
        if (wasRunning) {
          showToast('⏹️ Скачивание остановлено. Успешно загруженное сохранено на карте');
        }
      };
      $('precache-cancel').onclick = closePrecache;
      $('precache-x').onclick = closePrecache;

      $('precache-start').onclick = () => {
        const b = WM.map.getBounds();
        const bounds = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
        const z = +$('precache-zoom').value;
        const withDetails = $('precache-details') ? $('precache-details').checked : false;

        const pWrap = $('precache-progress-wrap');
        const pBar = $('precache-progress-bar');
        const pStatus = $('precache-status');

        pWrap.hidden = false;
        $('precache-start').disabled = true;

        WM.loader.precacheArea(bounds, z, withDetails, (prog) => {
          if (prog.stage === 'tiles') {
            pStatus.textContent = `[1/2] Контуры: ${prog.done} из ${prog.total} тайлов`;
            pBar.style.width = Math.round((prog.done / prog.total) * (withDetails ? 40 : 100)) + '%';
          } else if (prog.stage === 'details') {
            pStatus.textContent = `[2/2] Карточки: ${prog.done} из ${prog.total} объектов`;
            const pct = prog.total > 0 ? 40 + Math.round((prog.done / prog.total) * 60) : 100;
            pBar.style.width = pct + '%';
          } else if (prog.stage === 'retry') {
            pStatus.textContent = `⚠️ ${prog.message}`;
          } else if (prog.stage === 'aborted') {
            showToast(`💾 Сохранено до отмены: ${prog.savedTiles} тайлов${prog.savedDetails ? ', ' + prog.savedDetails + ' карточек' : ''}`);
          }

          if ((!withDetails && prog.stage === 'tiles' && prog.done >= prog.total) ||
              (withDetails && prog.stage === 'details' && prog.done >= prog.total)) {
            setTimeout(() => {
              $('modal-precache').classList.remove('open');
              pWrap.hidden = true;
              $('precache-start').disabled = false;
              showToast('✅ Область полностью сохранена в память');
            }, 600);
          }
        });
      };

      document.querySelectorAll('.btn-external-dl').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const url = btn.href;
          if (!url || !url.startsWith('http')) return;

          const isAndroidApp = window.Capacitor !== undefined || /wv|Android.*Version\/[0-9.]+/i.test(navigator.userAgent);

          if (isAndroidApp) {
            e.preventDefault();
            const noProto = url.replace(/^https?:\/\//i, '');
            const scheme = url.startsWith('https') ? 'https' : 'http';
            window.location.href = `intent://${noProto}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;
          }
        });
      });

    }
  });
})();