(function () {
  const WM = window.WM, C = WM.config, $ = id => document.getElementById(id);
  let cur = null, tab = 'info', lb = { list: [], i: 0 };
  let editingKeys = [], editingActiveIndex = 0;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  let historyPushedState = null;

  function pushHistoryState(stateName) {
    if (historyPushedState === stateName) return;
    historyPushedState = stateName;
    history.pushState({ wmView: stateName }, '');
  }

  function clearHistoryState(stateName, fallbackState = null) {
    if (historyPushedState === stateName) {
      historyPushedState = fallbackState;
      if (history.state && history.state.wmView === stateName) {
        history.back();
      }
    }
  }

  window.addEventListener('popstate', (e) => {
    const targetView = (e.state && e.state.wmView) || null;

    const lbEl = $('lightbox');
    if (lbEl && !lbEl.hidden && targetView !== 'lightbox') {
      closeLightbox(false);
      historyPushedState = targetView;
      return;
    }

    const qmOverlay = $('quick-menu-overlay');
    if (qmOverlay && !qmOverlay.hidden && targetView !== 'quickMenu') {
      closeQuickMenu(false);
      historyPushedState = targetView;
      return;
    }

    const openModals = document.querySelectorAll('.modal-overlay.open');
    if (openModals.length > 0 && targetView !== 'modal') {
      if ($('modal') && $('modal').classList.contains('open')) {
        if (snapshotVector) WM.view.applyVectorStyle(snapshotVector);
        if (snapshotRaster) applyRasterCSS(snapshotRaster);
        snapshotVector = null;
        snapshotRaster = null;
      }
      openModals.forEach(m => m.classList.remove('open'));
      historyPushedState = targetView;
      return;
    }

    const sheet = $('sheet');
    if (sheet && sheet.classList.contains('open') && targetView !== 'sheet') {
      closeSheet(false);
      historyPushedState = null;
    }
  });

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
  const DEFAULT_QUICK_MENU = {
    enabled: true,
    triggers: {
      longpress: true,
      crosshair: false,
      btn: false
    },
    items: {
      objects: true,
      shadowHeight: true,
      quickMeasure: true,
      measure: true,
      marker: true,
      gpsDist: true,
      coords: true,
      sunMoonRays: true // <-- ДОБАВЛЕНО, чтобы пункт был включён по умолчанию
    }
  };

  let quickMenuConfig = { ...DEFAULT_QUICK_MENU };
  try {
    const savedQM = JSON.parse(WM.api.store.get('wm_quick_menu') || '{}');
    quickMenuConfig = {
      enabled: savedQM.enabled !== undefined ? !!savedQM.enabled : DEFAULT_QUICK_MENU.enabled,
      triggers: { ...DEFAULT_QUICK_MENU.triggers, ...(savedQM.triggers || {}) },
      items: { ...DEFAULT_QUICK_MENU.items, ...(savedQM.items || {}) }
    };
  } catch (e) {}

  let quickMenuJustOpenedTime = 0;

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
  }

  function renderQuickMenuItems() {
    const listEl = $('quick-menu-items');
    if (!listEl) return;
    listEl.innerHTML = '';

    const itemsCfg = quickMenuConfig.items;
    const center = WM.map ? WM.map.getCenter() : { lat: 0, lng: 0 };
    const coordStr = `${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}`;

    const ALL_ITEMS = [
      {
        id: 'objects',
        icon: '📋',
        title: 'Объекты в зоне',
        sub: 'Открыть список видимых объектов',
        show: itemsCfg.objects,
        action: () => {
          closeQuickMenu();
          openObjectsListModal(false);
        }
      },
      {
        id: 'quickMeasure',
        icon: '📐',
        title: 'Быстрое измерение',
        sub: 'Расстояние между 2 точками',
        show: itemsCfg.quickMeasure,
        action: () => {
          closeQuickMenu();
          if (WM.quickMeasure && WM.quickMeasure.openTool) WM.quickMeasure.openTool();
        }
      },
      {
        id: 'measure',
        icon: '📏',
        title: 'Линейка / путь',
        sub: 'Построение маршрута с узлами',
        show: itemsCfg.measure,
        action: () => {
          closeQuickMenu();
          if (WM.measure && WM.measure.openTool) WM.measure.openTool();
        }
      },
      {
        id: 'shadowHeight',
        icon: '🏢',
        title: 'Высота по тени',
        sub: 'Расчёт высоты объекта по длине тени (SunCalc)',
        show: itemsCfg.shadowHeight !== false,
        action: () => {
          closeQuickMenu();
          if (WM.shadowHeight && WM.shadowHeight.openTool) WM.shadowHeight.openTool();
        }
      },
      {
        id: 'marker',
        icon: '📍',
        title: 'Поставить метку',
        sub: 'Создать заметку в центре карты',
        show: itemsCfg.marker,
        action: () => {
          closeQuickMenu();
          if (WM.markers && WM.markers.openModal) WM.markers.openModal(null);
          else if ($('btn-add-marker')) $('btn-add-marker').click();
        }
      },
      {
        id: 'sunMoonRays',
        icon: '✨',
        title: 'Азимуты Солнца и Луны',
        sub: infoHudConfig.rays ? 'Включены (нажмите для скрытия)' : 'Линии направления на карте',
        show: itemsCfg.sunMoonRays,
        action: () => {
          closeQuickMenu();
          infoHudConfig.rays = !infoHudConfig.rays;
          WM.api.store.set('wm_info_hud_items', JSON.stringify(infoHudConfig));
          updateInfoHudUI();
          updateRaysBtnState();
          showToast(infoHudConfig.rays ? '✨ Азимуты Солнца и Луны включены' : '✨ Азимуты скрыты');
        }
      },
      {
        id: 'gpsDist',
        icon: '🧭',
        title: 'Расстояние до GPS',
        sub: (WM.gpsDist && WM.gpsDist.isActive()) ? 'Включено (нажмите для скрытия)' : 'Линия от центра экрана к вашей позиции',
        show: itemsCfg.gpsDist,
        action: () => {
          closeQuickMenu();
          if (WM.gpsDist && WM.gpsDist.toggle) WM.gpsDist.toggle();
        }
      },
      {
        id: 'coords',
        icon: '🌐',
        title: 'Скопировать координаты',
        sub: coordStr,
        show: itemsCfg.coords,
        action: async () => {
          closeQuickMenu();
          try {
            await navigator.clipboard.writeText(coordStr);
            showToast(`📋 Координаты скопированы: ${coordStr}`);
          } catch (e) {
            showToast(`Координаты: ${coordStr}`);
          }
        }
      }
    ];

    const activeItems = ALL_ITEMS.filter(it => it.show);
    if (!activeItems.length) {
      listEl.append(el('div', { class: 'muted', style: 'padding: 16px;', text: 'Все пункты меню скрыты в настройках' }));
      return;
    }

    activeItems.forEach(item => {
      const btn = el('button', {
        type: 'button',
        class: 'quick-menu-item',
        onclick: item.action
      },
        el('span', { class: 'quick-menu-item-icon', text: item.icon }),
        el('div', { class: 'quick-menu-item-text' },
          el('span', { class: 'quick-menu-item-title', text: item.title }),
          el('span', { class: 'quick-menu-item-sub', text: item.sub })
        )
      );
      listEl.append(btn);
    });
  }

  function openQuickMenu(clickPos = null) {
    if (!quickMenuConfig.enabled) return;
    const overlay = $('quick-menu-overlay');
    const box = $('quick-menu-box');
    if (!overlay || !box) return;

    renderQuickMenuItems();
    quickMenuJustOpenedTime = Date.now();

    // Если это ПК и есть координаты клика мышью — позиционируем у курсора
    if (clickPos && window.innerWidth >= 768) {
      overlay.classList.add('desktop-context');
      box.style.position = 'absolute';
      box.style.width = '280px'; // Фиксируем ширину для абсолютного позиционирования
      const menuW = 280;
      const menuH = 260;
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

    overlay.hidden = false;
    pushHistoryState('quickMenu');
  }

  function closeQuickMenu(syncHistory = true) {
    const overlay = $('quick-menu-overlay');
    if (overlay) overlay.hidden = true;
    if (syncHistory) clearHistoryState('quickMenu');
  }

  function initQuickMenu() {
    const overlay = $('quick-menu-overlay');
    const closeBtn = $('quick-menu-close');
    const fabBtn = $('btn-quick-menu');
    const crosshair = $('crosshair');

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeQuickMenu();
      });
    }
    if (closeBtn) closeBtn.onclick = () => closeQuickMenu();
    if (fabBtn) fabBtn.onclick = (e) => { e.stopPropagation(); openQuickMenu(null); };

    if (crosshair) {
      crosshair.addEventListener('click', (e) => {
        if (!quickMenuConfig.enabled || !quickMenuConfig.triggers.crosshair) return;
        e.stopPropagation();
        openQuickMenu(null);
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.hidden) {
        closeQuickMenu();
      }
    });

    // Обработка клика правой кнопкой мыши на ПК и долгого тапа на мобильных
    const mapContainer = WM.map ? WM.map.getContainer() : document.getElementById('map');
    if (mapContainer) {
      // 1. Правая кнопка мыши (ПК)
      mapContainer.addEventListener('contextmenu', (e) => {
        if (e.target.closest('button, a, input, select, textarea, .leaflet-control, .modal-overlay, .sheet, .lightbox, .wm-custom-marker-icon, .wm-ruler-vertex-icon, .wm-ruler-midpoint-icon, .wm-qm-marker, .quick-measure-hud, .measure-hud')) {
          return;
        }
        if (!quickMenuConfig.enabled || !quickMenuConfig.triggers.longpress) return;
        e.preventDefault();
        openQuickMenu({ x: e.clientX, y: e.clientY });
      });

      // 2. Долгий тап на одном месте (смартфон)
      let touchStartPos = null;
      let longPressTimer = null;

      mapContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
          if (longPressTimer) clearTimeout(longPressTimer);
          return;
        }
        if (e.target.closest('button, a, input, select, textarea, .leaflet-control, .modal-overlay, .sheet, .lightbox, .wm-custom-marker-icon, .wm-ruler-vertex-icon, .wm-ruler-midpoint-icon, .wm-qm-marker, .quick-measure-hud, .measure-hud')) {
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
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }, { passive: true });

      mapContainer.addEventListener('touchcancel', () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
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

    let s = 'a';
    if (Array.isArray(subdomains) && subdomains.length) {
      s = subdomains[Math.abs(x + y) % subdomains.length];
    }

    return testUrl
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{-y}', yTms)
      .replace('{s}', s);
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

  // Отрисовка списков карт в настройках
  function renderBaseMapsSettingsUI() {
    const modernListEl = $('modern-maps-list');
    const histListEl = $('historical-maps-list');
    const histCountEl = $('historical-maps-count');
    if (!modernListEl || !histListEl || !WM.baseMapsCatalog) return;

    const chkQuickSwap = $('toggle-quick-swap-enabled');
    const wrapQuickSwap = $('quick-swap-select-wrap');
    const selectQuickSwap = $('quick-swap-map-select');

    const isQuickSwapOn = localStorage.getItem('wm_quick_swap_enabled') !== 'false';
    const currentTargetMap = localStorage.getItem('wm_quick_swap_target') || 'Спутник (Esri)';

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
        const curActiveName = localStorage.getItem('wm_base_layer') || 'Тропы и грунтовки (CyclOSM)';
        let keptOne = false;
        document.querySelectorAll('.map-checkbox-input').forEach(chk => {
          if (chk.dataset.mapName === curActiveName || (!keptOne && chk.dataset.mapName.includes('CyclOSM'))) {
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
    measure: true,
    marker: false,
    precache: true,
    location: true,
    gpsdist: false,
    rays: false,         // Выключена по умолчанию
    theme: true,
    infomenu: true
  };
  let uiVis = { ...UI_VIS_DEFAULT };
  const VIS_KEYS = ['status', 'limit', 'pill', 'zoom', 'layers', 'search', 'mode', 'quickmeasure', 'measure', 'marker', 'precache', 'location', 'gpsdist', 'rays', 'theme', 'infomenu'];

  const DEFAULT_INFO_ITEMS = {
    time: true,
    userCoords: true,
    centerCoords: true,
    gps: true,
    sun: true,
    moon: true,
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
  function updateRays(centerLL) {
    if (!WM.map) return;
    const map = WM.map;

    // ГАРАНТИРОВАННАЯ ОЧИСТКА ПРИ ОТКЛЮЧЕНИИ
    if (!infoHudConfig.rays) {
      if (infoRaysLayer) {
        infoRaysLayer.clearLayers();
      }
      sunRayPoly = null;
      moonRayPoly = null;
      return;
    }

    if (!window.SunCalc) return;

    if (!infoRaysLayer) {
      infoRaysLayer = L.layerGroup().addTo(map);
    }

    const origin = centerLL || map.getCenter();
    const now = new Date();
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

    // Плавное обновление существующих линий на Canvas/SVG без создания мусора в памяти
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

    // 5. SunCalc: Солнце и Луна
    const hasAstroItems = window.SunCalc && (infoHudConfig.sun || infoHudConfig.moon || infoHudConfig.rays);
    let sunPos = null, moonPos = null;

    if (hasAstroItems) {
      // Дата с учётом смещения от -3 до +7 дней
      const astroDate = new Date(now);
      astroDate.setDate(astroDate.getDate() + infoAstroDayOffset);

      // Форматирование плашки выбранного дня
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

      // Панель листания даты
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

      // Обертка для свайпов
      html += `<div class="ih-astro-swipe-area">`;

      if (infoHudConfig.sun) {
        const sTimes = SunCalc.getTimes(astroDate, refLat, refLng);
        sunPos = SunCalc.getPosition(astroDate, refLat, refLng);
        const sunAzDeg = ((sunPos.azimuth * 180 / Math.PI + 180) % 360);
        const sunAltDeg = (sunPos.altitude * 180 / Math.PI).toFixed(1);

        html += `
          <div class="ih-section ih-astro-section">
            <div class="ih-sec-title">☀️ Солнце (${sunAltDeg > 0 ? '+' + sunAltDeg : sunAltDeg}°)</div>
            <div class="ih-grid-2">
              <div>🌅 Восход: <b>${fmtTime(sTimes.sunrise)}</b></div>
              <div>🌇 Закат: <b>${fmtTime(sTimes.sunset)}</b></div>
              <div>☀️ Полдень: <b>${fmtTime(sTimes.solarNoon)}</b></div>
              <div>✨ Золотой час: <b>${fmtTime(sTimes.goldenHour)}</b></div>
              <div>🌆 Сумерки: <b>${fmtTime(sTimes.dusk)}</b></div>
              <div>🧭 Азимут: <b>${Math.round(sunAzDeg)}° (${degToCompass(sunAzDeg)})</b></div>
            </div>
          </div>
        `;
      }

      if (infoHudConfig.moon) {
        const moonIllum = SunCalc.getMoonIllumination(astroDate);
        const moonTimes = SunCalc.getMoonTimes(astroDate, refLat, refLng);
        moonPos = SunCalc.getMoonPosition(astroDate, refLat, refLng);
        const moonAzDeg = ((moonPos.azimuth * 180 / Math.PI + 180) % 360);
        const moonAltDeg = (moonPos.altitude * 180 / Math.PI).toFixed(1);
        const phase = getMoonPhaseInfo(moonIllum.phase);
        const pct = Math.round(moonIllum.fraction * 100);

        html += `
          <div class="ih-section ih-astro-section">
            <div class="ih-sec-title">🌙 Луна (${phase.icon} ${pct}%)</div>
            <div class="ih-row"><span class="ih-lbl">Фаза:</span><span class="ih-val">${phase.name}</span></div>
            <div class="ih-grid-2">
              <div>Восход: <b>${moonTimes.rise ? fmtTime(moonTimes.rise) : '--:--'}</b></div>
              <div>Заход: <b>${moonTimes.set ? fmtTime(moonTimes.set) : '--:--'}</b></div>
              <div>Высота: <b>${moonAltDeg}°</b></div>
              <div>Азимут: <b>${Math.round(moonAzDeg)}° (${degToCompass(moonAzDeg)})</b></div>
            </div>
          </div>
        `;
      }

      html += `</div>`; // ih-astro-swipe-area
    } // <--- ДОБАВЬТЕ ЭТУ СКОБКУ

    if (!isCollapsed) content.innerHTML = html;
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

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    const statusBarColor = isDark ? '#111827' : '#ffffff';

    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      $('btn-theme-toggle').textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      $('btn-theme-toggle').textContent = '🌙';
    }

    const meta = document.getElementById('theme-color-meta') || document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', statusBarColor);

    WM.api.store.set('wm_theme', theme);
  }

  function toggleTheme() {
    const curTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(curTheme === 'dark' ? 'light' : 'dark');
  }

  function applyUIVisibility() {
    $('status').style.display = uiVis.status ? '' : 'none';
    const limitRow = $('limit-row');
    if (limitRow) limitRow.style.display = uiVis.limit ? '' : 'none';
    if (!uiVis.pill) $('hover-pill').hidden = true;

    const hud = $('info-hud');
    if (hud) hud.hidden = !uiVis.infomenu;
    updateInfoHudUI();

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
    if ($('btn-gps-dist')) $('btn-gps-dist').style.display = uiVis.gpsdist ? '' : 'none';
    if ($('btn-rays-toggle')) $('btn-rays-toggle').style.display = uiVis.rays ? '' : 'none';
    if ($('btn-theme-toggle')) $('btn-theme-toggle').style.display = uiVis.theme ? '' : 'none';

    WM.api.store.set('wm_ui_vis', JSON.stringify(uiVis));
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

  function updateLimitHUD() {
    const badge = $('limit-badge');
    if (!badge || !uiVis.limit) return;

    const pool = WM.api.getPoolStatus();
    let newText = '';
    let isDanger = false;

    if (pool.allBlocked) {
      newText = `⏳ Пауза API: ${Math.ceil(pool.waitMs / 1000)} сек.`;
      isDanger = true;
      toggleTopGetKeyBtn(true);
    } else if (pool.isMaster) {
      newText = '🔑 Безлимитный режим';
      isDanger = false;
      toggleTopGetKeyBtn(false);
    } else {
      const stats = WM.api.getKeyStats(pool.key);
      newText = `🔑 ${stats.used}/${stats.limit}`;
      isDanger = stats.remaining <= 10;
      toggleTopGetKeyBtn(false);
    }

    if (badge.textContent !== newText) {
      badge.textContent = newText;
    }
    badge.classList.toggle('danger', isDanger);
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
    $('lb-img').src = safeUrl(p['1280_url'] || p.big_url || p['960_url'] || p.thumbnail_url);
    
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

  function closeLightbox(syncHistory = true) {
    const lbEl = $('lightbox');
    if (lbEl) lbEl.hidden = true;
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

    // Если карточка открывалась из окна списка объектов — возвращаем его обратно
    if (returnToObjectsList) {
      openObjectsListModal(true);
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

    let isMouseDown = false, mouseStart = null, mouseTotalMove = 0;
    vp.addEventListener('mousedown', e => {
      if (e.target.closest('.lb-zoom-controls') || e.target.closest('.lb-btn')) return;
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

    let touchStartPt = null;
    let touchStartTime = 0;
    let touchHasMoved = false;
    let isDoubleTapDragging = false;
    let doubleTapAnchorY = 0;
    let doubleTapStartScale = 1;
    let pendingTapTimer = null;

    vp.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
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
      const now = Date.now();
      const pt = { x: t.clientX, y: t.clientY };
      touchStartPt = pt;
      touchStartTime = now;
      touchHasMoved = false;

      const isSecondTap = lbLastTouch && 
        (now - lbLastTap < 320) && 
        (Math.hypot(pt.x - lbLastTouch.x, pt.y - lbLastTouch.y) < 36);

      if (isSecondTap) {
        if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
        isDoubleTapDragging = true;
        doubleTapAnchorY = pt.y;
        doubleTapStartScale = lbScale;
      } else {
        lbLastTouch = pt;
      }
    }, { passive: false });

    vp.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
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

      if (isDoubleTapDragging) {
        e.preventDefault();
        touchHasMoved = true;
        const deltaY = doubleTapAnchorY - t.clientY;
        const newScale = Math.min(5, Math.max(1, doubleTapStartScale + deltaY / 120));
        lbScale = Math.round(newScale * 100) / 100;
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
        return;
      }

      if (lbScale > 1 && touchStartPt) {
        const dx = t.clientX - touchStartPt.x;
        const dy = t.clientY - touchStartPt.y;
        if (Math.hypot(dx, dy) > 8) touchHasMoved = true;
        lbPanX += dx;
        lbPanY += dy;
        touchStartPt = { x: t.clientX, y: t.clientY };
        updateLbImgTransform();
        return;
      }

      if (touchStartPt && Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > 10) {
        touchHasMoved = true;
      }
    }, { passive: false });

    vp.addEventListener('touchend', e => {
      if (e.touches.length > 0) return;

      const now = Date.now();

      if (isDoubleTapDragging) {
        isDoubleTapDragging = false;
        if (!touchHasMoved) {
          if (lbScale > 1) resetLbTransform();
          else { lbScale = 2.5; updateLbImgTransform(); }
        }
        lbLastTap = 0;
        lbLastTouch = null;
        return;
      }

      if (touchStartPt && !touchHasMoved) {
        const tappedTarget = e.target;
        lbLastTap = now;

        if (pendingTapTimer) clearTimeout(pendingTapTimer);
        pendingTapTimer = setTimeout(() => {
          pendingTapTimer = null;
          if (tappedTarget === vp || tappedTarget === lbEl) {
            closeLightbox(true);
          }
        }, 300);
      } else if (touchStartPt && touchHasMoved && lbScale === 1) {
        const endT = e.changedTouches[0];
        const dx = endT.clientX - touchStartPt.x;
        const dy = endT.clientY - touchStartPt.y;
        
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) {
            showLbPhoto(lb.i + 1);
          } else {
            showLbPhoto(lb.i - 1);
          }
        }
      }

      touchStartPt = null;
    });
  }

  function initSheetGestures() {
    const sheet = $('sheet');
    const sheetBody = $('sheet-body');
    let startY = 0, curDeltaY = 0, isDraggingSheet = false;

    function isEligibleDragTarget(target) {
      if (target.closest('.icon-btn, button, a, input, select, textarea, .coords-card, .photo-grid img, .chip, .lang-chip, .tab-btn')) {
        return false;
      }
      if (target.closest('#sheet-head') || target.id === 'sheet-title') {
        return true;
      }
      if (sheet.classList.contains('full') && sheetBody && sheetBody.scrollTop > 5) {
        return false;
      }
      const textNode = target.closest('.desc, .comment-card, .row, .msg, .meta, .tag');
      if (textNode) {
        return false;
      }

      return true;
    }

    sheet.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      if (!isEligibleDragTarget(e.target)) return;

      startY = e.touches[0].clientY;
      curDeltaY = 0;
      isDraggingSheet = true;
      sheet.style.transition = 'none';
    }, { passive: true });

    window.addEventListener('touchmove', e => {
      if (!isDraggingSheet) return;
      const dy = e.touches[0].clientY - startY;
      curDeltaY = dy;
      const isFull = sheet.classList.contains('full');

      if (isFull) {
        if (dy < 0) {
          sheet.style.transform = `translateY(${dy * 0.18}px)`;
        } else {
          sheet.style.transform = `translateY(${dy}px)`;
        }
      } else {
        sheet.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      sheet.style.transition = '';

      const isFull = sheet.classList.contains('full');
      const expandBtn = $('sheet-expand');
      const winH = window.innerHeight;

      if (isFull) {
        if (curDeltaY > Math.max(220, winH * 0.35)) {
          closeSheet(true);
        } else if (curDeltaY > 70) {
          sheet.style.transform = '';
          sheet.classList.remove('full');
          if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
        } else {
          sheet.style.transform = '';
        }
      } else {
        if (curDeltaY < -60) {
          sheet.style.transform = '';
          sheet.classList.add('full');
          if (expandBtn) { expandBtn.textContent = '⤡'; expandBtn.title = 'Свернуть'; }
        } else if (curDeltaY > 70) {
          closeSheet(true);
        } else {
          sheet.style.transform = '';
        }
      }
      curDeltaY = 0;
    }, { passive: true });

    window.addEventListener('touchcancel', () => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      curDeltaY = 0;
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

  async function executeSearch(query) {
    const listEl = $('search-results');
    const q = (query || '').trim();

    // Быстрый локальный режим тегов без задержки и без внешних запросов
    if (searchSource === 'tags') {
      renderTagsSearch(q);
      return;
    }

    if (q.length < 2) {
      listEl.textContent = '';
      listEl.append(el('div', { class: 'muted', text: 'Введите минимум 2 символа для поиска…' }));
      return;
    }

    listEl.textContent = '';
    listEl.append(el('div', { class: 'muted', text: '🔍 Поиск…' }));

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

    let results = [...localMatches];

    try {
      const [osmRes, wmRaw] = await Promise.all(promises);

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

      results = [...results, ...wmRes, ...(osmRes || [])];
    } catch (e) {
      console.warn('Ошибка при поиске:', e);
    }

    listEl.textContent = '';
    if (!results.length) {
      listEl.append(el('div', { class: 'muted', text: 'Ничего не найдено' }));
      return;
    }

    results.forEach(res => {
      const isWm = res.source === 'wm';
      const itemEl = el('div', {
        class: 'search-result-item',
        onclick: async () => {
          $('modal-search').classList.remove('open');
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
          el('span', {
            class: 'search-badge ' + (isWm ? 'search-badge-wm' : 'search-badge-osm'),
            text: isWm ? (res.inCache ? 'Wikimapia (кэш)' : 'Wikimapia') : 'Адрес / OSM'
          })
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

    // Закрытие поиска по клику на пустое место вокруг окна
    if (modalSearch) {
      modalSearch.addEventListener('click', (e) => {
        if (e.target === modalSearch) {
          modalSearch.classList.remove('open');
          clearHistoryState('search');
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

    $('search-x').onclick = () => modalSearch.classList.remove('open');

    inputSearch.oninput = () => {
      const val = inputSearch.value;
      btnClear.hidden = !val;
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => executeSearch(val), 350);
    };

    btnClear.onclick = () => {
      inputSearch.value = '';
      btnClear.hidden = true;
      executeSearch('');
      inputSearch.focus();
    };

    document.querySelectorAll('.search-tab-btn').forEach(tabBtn => {
      tabBtn.onclick = () => {
        document.querySelectorAll('.search-tab-btn').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        searchSource = tabBtn.dataset.source;
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
      'btn-mode-toggle': () => {
        const isCross = WM.picker && WM.picker.getMode() === 'cross';
        return isCross 
          ? '🎯 Режим «Перекрестие»\nНаведите прицел в центре экрана для выбора объекта (тапните для смены на палец)' 
          : '👆 Режим «Палец»\nВыбирайте объекты прямым нажатием на карту (тапните для смены на прицел)';
      },
      'btn-measure': () => '📏 Линейка: измерение расстояний на карте, добавление узлов и нескольких треков',
      'btn-add-marker': () => '📍 Добавить метку: создать заметку с эмодзи в центре экрана с возможностью перемещения',
      'btn-download-area': () => '📥 Скачать область: сохранить контуры и описания видимой области для автономной работы',
      'btn-location': () => '🛰️ Моя геопозиция: определить и показать текущие координаты по GPS',
      'btn-gps-dist': () => (WM.gpsDist && WM.gpsDist.isActive()) ? '🧭 Расстояние до GPS: активно\nНажмите, чтобы отключить линию' : '🧭 Расстояние до GPS\nПоказывает прямую линию и расстояние от центра экрана до вашей геопозиции',
      'btn-theme-toggle': () => '🌙/☀️ Смена темы: переключение между тёмной и светлой темой оформления',
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

  function closeObjectsListModal() {
    const modal = $('modal-objects-list');
    if (modal) modal.classList.remove('open');
    returnToObjectsList = false;
    cachedObjectsSnapshot = null; // Сбрасываем сохраненный список при закрытии меню
    clearHistoryState('modal');
  }

  function renderObjectsList(filterText = '') {
    const listEl = $('objects-list-items');
    const countEl = $('objects-list-count');
    if (!listEl) return;
    listEl.textContent = '';

    // Используем зафиксированный снимок, если он есть, иначе берем текущие объекты
    const allObjs = cachedObjectsSnapshot || ((WM.view && WM.view.shownObjects) ? WM.view.shownObjects() : []);
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
      listEl.append(el('div', {
        class: 'muted',
        style: 'width: 100%; padding: 24px 8px;',
        text: 'На экране пока нет загруженных объектов. Приблизьте карту или дождитесь загрузки.'
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

    // Сортировка: сначала объекты с именами по алфавиту, затем безымянные по ID
    list.sort((a, b) => {
      if (a.title && !b.title) return -1;
      if (!a.title && b.title) return 1;
      return (a.title || '').localeCompare(b.title || '', 'ru');
    });

    list.forEach(o => {
      const title = o.title || `Объект #${o.id}`;
      const isVisited = !!o.isVisited;
      const chip = el('button', {
        class: 'object-tag-chip' + (isVisited ? ' visited' : ''),
        style: o.customColor ? `border-color: ${o.customColor};` : '',
        title: `Открыть «${title}»`,
        onclick: () => {
          // Оставляем флаг возврата активным для последующих открытий
          returnToObjectsList = true;

          // Гарантируем, что снимок зафиксирован именно для этой сессии
          if (!cachedObjectsSnapshot) {
            cachedObjectsSnapshot = [...allObjs];
          }

          const modal = $('modal-objects-list');
          if (modal) modal.classList.remove('open');

          // Центрируем камеру карты на выбранном объекте (камера перемещается и остается там)
          if (o.bbox && WM.map) {
            const centerLat = (o.bbox.s + o.bbox.n) / 2;
            const centerLng = (o.bbox.w + o.bbox.e) / 2;
            WM.map.flyTo([centerLat, centerLng], Math.max(WM.map.getZoom(), 16), { animate: true });
          }

          // Выделяем и открываем карточку
          setTimeout(() => {
            WM.picker.select(o, [o]);
          }, 250);
        }
      },
        el('span', { text: o.customColor ? '🎨' : (isVisited ? '✓' : '🏷️') }),
        el('span', { class: 'object-tag-chip-title', text: title })
      );

      listEl.append(chip);
    });
  }

  function openObjectsListModal(preserveState = false) {
    const modal = $('modal-objects-list');
    const input = $('objects-search-input');
    const clearBtn = $('objects-search-clear-btn');
    if (!modal) return;

    if (!preserveState) {
      // Первичное открытие по клику на плашку: сбрасываем фильтр и делаем свежий снимок текущего экрана
      lastObjectsSearchQuery = '';
      cachedObjectsSnapshot = (WM.view && WM.view.shownObjects) ? [...WM.view.shownObjects()] : [];
      if (input) input.value = '';
      if (clearBtn) clearBtn.hidden = true;
    } else {
      // Возврат после закрытия карточки: восстанавливаем поисковый запрос и держим старый снимок
      if (input) {
        input.value = lastObjectsSearchQuery;
        if (clearBtn) clearBtn.hidden = !lastObjectsSearchQuery;
      }
      if (!cachedObjectsSnapshot) {
        cachedObjectsSnapshot = (WM.view && WM.view.shownObjects) ? [...WM.view.shownObjects()] : [];
      }
    }

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

    if (modal) {
      // Клик по пустому месту вокруг окна закрывает его и сбрасывает снимок
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
  }
  window.updateInfoHudUI = updateInfoHudUI;

  WM.ui = {
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
    setPill(obj, count) {
      const p = $('hover-pill');
      if (!obj || !uiVis.pill) { p.hidden = true; return; }
      p.hidden = false;

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
      if (textEl) textEl.textContent = `🏷️ «${tag.title}» (${count})`;
    },
    setStatus(text, warn) {
      const s = $('status');
      if (s) {
        s.textContent = text;
        s.classList.toggle('warn', !!warn);
      }
    },
    updateStatusFromLoader() {
      if (window.refreshAppStatus) window.refreshAppStatus();
    },
    getWorkMode() { return workMode; },
    isAutoHoverEnabled() { return autoHoverEnabled; },
    isAutoDetailsEnabled() { return autoDetailsEnabled; },
    isAutoDetailsCrosshairOnly() { return autoDetailsCrosshairOnly; },
    fmtTimer,
    openKeysSettings,
    toggleTopGetKeyBtn,
    init() {
      const savedTheme = WM.api.store.get('wm_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(savedTheme);
      $('btn-theme-toggle').onclick = toggleTheme;

      try {
        const savedVis = JSON.parse(WM.api.store.get('wm_ui_vis') || '{}');
        uiVis = { ...UI_VIS_DEFAULT, ...savedVis };
      } catch (e) {}

      VIS_KEYS.forEach(k => {
        const chk = $('toggle-ui-' + k);
        if (chk) chk.checked = uiVis[k] !== false;
      });

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
      setInterval(updateInfoHudUI, 1000);


      applyUIVisibility();

      // ДОБАВЬТЕ ЭТУ СТРОКУ СЮДА:
      applyRasterCSS(rasterStyle);

      $('toggle-auto-hover').checked = autoHoverEnabled;
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

      setInterval(updateLimitHUD, 1000);
      updateLimitHUD(); 

      const btnGetKeyTop = $('btn-get-key-top');
      if (btnGetKeyTop) {
        btnGetKeyTop.onclick = openKeysSettings;
      }

      const clearTagBtn = $('tag-filter-clear');
      if (clearTagBtn) {
        clearTagBtn.onclick = () => {
          if (WM.view && WM.view.clearTagFilter) {
            WM.view.clearTagFilter();
          }
        };
      }
      const refreshTagBtn = $('tag-filter-refresh');
      if (refreshTagBtn) {
        refreshTagBtn.onclick = async () => {
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

          // 1. Сбрасываем суточные/минутные блокировки и лимиты API
          WM.api.resetAllLimits();
          updateLimitHUD();

          // 2. Принудительно перезагружаем упавшие растровые тайлы карты (убираем серые/красные дыры)
          document.querySelectorAll('.leaflet-tile-error, .leaflet-tile-retry').forEach(tile => {
            tile._retryCount = 0;
            tile.classList.remove('leaflet-tile-error', 'leaflet-tile-retry');
            const src = tile.getAttribute('src');
            if (src && !src.startsWith('data:')) {
              tile.src = src.split('?')[0] + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
            }
          });

          // 3. Сбрасываем статус ошибок всех векторных тайлов и форсируем их повтор
          if (WM.loader && WM.loader.retryNow) {
            WM.loader.retryNow(true);
          }

          // 4. Догрузка объектов в зависимости от режима прицела/карты
          const pickerMode = WM.picker.getMode();
          if (pickerMode === 'cross') {
            showToast('🔄 Обновление карты и объектов…', 1400);
            await WM.picker.fetchAtCrosshair();
          } else {
            const zoom = WM.map ? WM.map.getZoom() : 0;
            if (zoom >= WM.config.VECTOR_ZOOM) {
              showToast('🔄 Загрузка недостающих тайлов…', 1400);
              WM.loader.loadVisibleNow();
            } else {
              showToast('🔄 Тайлы перезагружены', 1400);
            }
          }
        };
      }

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

      let snapshotVector = null, snapshotRaster = null;

      $('btn-settings').onclick = () => {
        // СВОРАЧИВАЕМ ВСЕ СПОЙЛЕРЫ ПО УМОЛЧАНИЮ
        document.querySelectorAll('#modal details.spoiler').forEach(d => {
          d.open = false;
        });

        if ($('toggle-qm-item-shadowheight')) {
          $('toggle-qm-item-shadowheight').checked = quickMenuConfig.items.shadowHeight !== false;
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
        if ($('toggle-info-rays')) $('toggle-info-rays').checked = infoHudConfig.rays;


        editingKeys = [...WM.api.keys];
        editingActiveIndex = WM.api.activeIndex;
        renderBaseMapsSettingsUI();
        renderKeysUI();
        $('net-mode').value = WM.api.netMode;

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
        if ($('toggle-qm-item-coords')) $('toggle-qm-item-coords').checked = quickMenuConfig.items.coords;
        if ($('toggle-qm-item-rays')) $('toggle-qm-item-rays').checked = quickMenuConfig.items.sunMoonRays !== false;

        if (hybridSlider && hybridVal) {
          hybridSlider.value = C.VECTOR_ZOOM;
          hybridVal.textContent = `зум ${parseFloat(C.VECTOR_ZOOM).toFixed(1)}`;
        }
        updateHybridSliderVisibility();

        // --- ДОБАВИТЬ ЭТОТ БЛОК: считывание текущих фильтров в чекбоксы ---
        if (WM.view && WM.view.getFilters) {
          const f = WM.view.getFilters();
          const chkBuild = $('toggle-filter-hide-buildings');
          const chkReg = $('toggle-filter-hide-regions');
          const chkDel = $('toggle-filter-hide-deleted');
          const chkDensity = $('toggle-filter-hide-small-density');
          const chkSmall = $('toggle-filter-hide-small');
          const chkMed = $('toggle-filter-hide-medium');
          const chkLarge = $('toggle-filter-hide-large');

          if (chkBuild) chkBuild.checked = !!f.hideBuildings;
          if (chkReg) chkReg.checked = !!f.hideRegions;
          if (chkDel) chkDel.checked = !!f.hideDeleted;
          if (chkDensity) chkDensity.checked = !!f.hideSmallDensity;
          if (chkSmall) chkSmall.checked = !!f.hideSmall;
          if (chkMed) chkMed.checked = !!f.hideMedium;
          if (chkLarge) chkLarge.checked = !!f.hideLarge;
        }
        // ------------------------------------------------------------------

        VIS_KEYS.forEach(k => {
          const chk = $('toggle-ui-' + k);
          if (chk) chk.checked = uiVis[k] !== false;
        });

        const currentRadios = document.querySelectorAll('input[name="app-work-mode"]');
        currentRadios.forEach(r => { r.checked = (r.value === workMode); });
        $('toggle-auto-hover').checked = autoHoverEnabled;
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

      $('btn-clear-tiles').onclick = async () => {
        if (confirm('Очистить сохраненные подложки карт? Это освободит память смартфона, сохранив все загруженные полигоны и описания объектов Wikimapia.')) {
          await WM.cache.clearRasterTiles();
          alert('Кэш карт успешно очищен. Память освобождена, полигоны сохранены.');
        }
      };

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


        if (hybridSlider) {
          const val = parseFloat(hybridSlider.value);
          C.VECTOR_ZOOM = val;
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

        autoHoverEnabled = $('toggle-auto-hover').checked;
        WM.api.store.set('wm_auto_hover', autoHoverEnabled ? 'true' : 'false');

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
        infoHudConfig.rays = $('toggle-info-rays') ? $('toggle-info-rays').checked : false;

        WM.api.store.set('wm_info_hud_items', JSON.stringify(infoHudConfig));
        updateInfoHudUI();
        updateRaysBtnState();


        quickMenuConfig.enabled = $('toggle-qm-enabled') ? $('toggle-qm-enabled').checked : true;
        quickMenuConfig.triggers.longpress = $('toggle-qm-trigger-longpress') ? $('toggle-qm-trigger-longpress').checked : true;
        quickMenuConfig.triggers.crosshair = $('toggle-qm-trigger-crosshair') ? $('toggle-qm-trigger-crosshair').checked : false;
        quickMenuConfig.triggers.btn = $('toggle-qm-trigger-btn') ? $('toggle-qm-trigger-btn').checked : false;

        quickMenuConfig.items.objects = $('toggle-qm-item-objects') ? $('toggle-qm-item-objects').checked : true;
        quickMenuConfig.items.quickMeasure = $('toggle-qm-item-quickmeasure') ? $('toggle-qm-item-quickmeasure').checked : true;
        quickMenuConfig.items.measure = $('toggle-qm-item-measure') ? $('toggle-qm-item-measure').checked : true;
        quickMenuConfig.items.marker = $('toggle-qm-item-marker') ? $('toggle-qm-item-marker').checked : true;
        quickMenuConfig.items.gpsDist = $('toggle-qm-item-gps-dist') ? $('toggle-qm-item-gps-dist').checked : true; // <-- ДОБАВИТЬ
        quickMenuConfig.items.coords = $('toggle-qm-item-coords') ? $('toggle-qm-item-coords').checked : true;
        quickMenuConfig.items.sunMoonRays = $('toggle-qm-item-rays') ? $('toggle-qm-item-rays').checked : true;

        WM.api.store.set('wm_quick_menu', JSON.stringify(quickMenuConfig));
        updateQuickMenuTriggersUI();


        snapshotVector = null;
        snapshotRaster = null;



        if (WM.view && WM.view.setFilters) {
          WM.view.setFilters({
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


        const noEvictObjs = $('toggle-no-evict-objects') ? $('toggle-no-evict-objects').checked : false;
        const noEvictTiles = $('toggle-no-evict-tiles') ? $('toggle-no-evict-tiles').checked : false;

        WM.api.store.set('wm_no_evict_objects', noEvictObjs ? 'true' : 'false');
        WM.api.store.set('wm_no_evict_tiles', noEvictTiles ? 'true' : 'false');

        // Передаем новый режим в модуль кэша и отправляем сигнал Service Worker'у
        if (WM.cache && WM.cache.setNoEvict) WM.cache.setNoEvict(noEvictObjs);
        syncSWNoTrim(noEvictTiles);

        const chkQuickSwap = $('toggle-quick-swap-enabled');
        const selectQuickSwap = $('quick-swap-map-select');
        const isQuickSwapEnabled = chkQuickSwap ? chkQuickSwap.checked : false;
        const targetQuickSwapMap = selectQuickSwap ? selectQuickSwap.value : 'Спутник (Esri)';

        localStorage.setItem('wm_quick_swap_enabled', isQuickSwapEnabled ? 'true' : 'false');
        localStorage.setItem('wm_quick_swap_target', targetQuickSwapMap);

        if (window.updateQuickSwapUI) {
          window.updateQuickSwapUI();
        }


        $('modal').classList.remove('open');

        if (window.syncRasterOverlay) window.syncRasterOverlay();
        WM.loader.reset();
        WM.view.render();

        // <--- ВОТ СЮДА ВСТАВЛЯЕТСЯ ЭТОТ ВЫЗОВ:
        if (WM.loader && WM.loader.onSettingsChanged) {
          WM.loader.onSettingsChanged();
        }
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
  };
})();