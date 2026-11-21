(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // Набор эмодзи для карт
  const EMOJI_LIST = [
    // 📍 Базовая навигация, ориентиры и геокешинг
    '📍', '📌', '🚩', '🏁', '🎯', '🧭', '🗺️', '⭐', '💎', '📦', '📜', '🔑',

    // 🥾 Передвижение, треки и обзорные точки
    '🥾', '🚶', '🧗', '🚵', '🛶', '🌉', '🛤️', '📸', '🔭',

    // 🏕️ Лагерь, стоянки и быт
    '🏕️', '⛺', '🔥', '🪵', '🛖', '🏠', '🪑', '🚻', '🗑️',

    // ⛰️ Рельеф, ландшафт и природа
    '⛰️', '🏔️', '🪨', '🌲', '🌳', '🌿', '🌾', '🍄', '🏜️', '🌊',

    // 💧 Водные точки и источники
    '💧', '🚰', '🏞️', '🏊', '🎣',

    // 🔦 Исследования, пещеры, заброшки (Urbex)
    '🕳️', '🔦', '⛏️', '🏚️', '🏰', '🏛️', '🏭', '🔒',

    // ⚠️ Препятствия, опасности и фауна
    '⚠️', '🚧', '🚫', '💀', '⚡', '❄️', '🐍', '🐻', '🐗', '🦟',

    // 🎒 Снаряжение, связь, спасение и логистика
    '🅿️', '🚗', '⛽', '🎒', '🥪', '☕', '📶', '📡', '🔋', '🩹', '🏥', '🆘'
  ];

  const COLOR_PRESETS = [
    '#3b82f6', '#ef4444', '#f97316', '#eab308',
    '#10b981', '#06b6d4', '#8b5cf6', '#ec4899', '#374151'
  ];

  const STORAGE_KEY = 'wm_user_markers';
  const BADGE_MIN_ZOOM = 11;

  let markersData = [];
  let leafletMarkers = new Map(); // id -> { marker, type: 'dot'|'pin', visualKey, lat, lng }
  let markersLayerGroup = null;
  let canvasRenderer = null;

  let currentEditingId = null;
  let draggingMarkerId = null;
  let lastRenderSignature = '';
  let moveDebounceTimer = 0;

  let selectedEmoji = EMOJI_LIST[0];
  let selectedColor = COLOR_PRESETS[0];

  function loadStoredMarkers() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      markersData = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(markersData)) markersData = [];
    } catch (e) {
      markersData = [];
    }
  }

  function saveStoredMarkers() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(markersData));
    } catch (e) {}
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  // Точные размеры контейнера маркера и точка его привязки (нижний центр)
  const ICON_WIDTH = 42;
  const ICON_HEIGHT = 56;

  // Создание HTML для манга-облачка с геометрически точным хвостиком
  function buildMarkerHtml(item) {
    const textHtml = item.text && item.text.trim()
      ? `<span class="wm-marker-label">${escapeHtml(item.text.trim())}</span>`
      : '';

    return `
      <div class="wm-marker-pin-wrap" style="--marker-bg: ${item.color};">
        <div class="wm-marker-bubble">
          <span class="wm-marker-emoji">${item.emoji}</span>
          ${textHtml}
        </div>
        <svg class="wm-marker-tail" viewBox="0 0 16 16" width="16" height="16">
          <path d="M1,0 C4,0 7,4 8,16 C9,4 12,0 15,0 Z" fill="${item.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"></path>
        </svg>
      </div>
    `;
  }

  function buildPinIcon(item) {
    return L.divIcon({
      className: 'wm-custom-marker-icon',
      html: buildMarkerHtml(item),
      iconSize: [ICON_WIDTH, ICON_HEIGHT],
      iconAnchor: [ICON_WIDTH / 2, ICON_HEIGHT]
    });
  }

  function getMarkerVisualKey(item) {
    return `${item.emoji}|${item.color}|${item.text || ''}`;
  }

  // Обработка клика и долгого нажатия для перемещения (безопасно при пересоздании _icon через setIcon)
  function attachGestureHandlers(marker) {
    let holdTimer = null;
    let isDragging = false;
    let hasMoved = false;
    let startPos = null;
    let lastTouchTime = 0;

    function cleanupWindowListeners() {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);
      window.removeEventListener('touchcancel', onPointerUp);
    }

    function cancelHold() {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    function onPointerMove(e) {
      if (!startPos) return;
      const pt = (e.touches && e.touches[0]) || e;
      if (Math.hypot(pt.clientX - startPos.x, pt.clientY - startPos.y) > 10) {
        hasMoved = true;
        if (!isDragging) {
          cancelHold();
        }
      }
    }

    function onPointerUp() {
      cancelHold();
      cleanupWindowListeners();
      startPos = null;
    }

    function startHold(e) {
      if (e.type === 'touchstart') {
        lastTouchTime = Date.now();
      } else if (e.type === 'mousedown') {
        if (Date.now() - lastTouchTime < 700 || e.button !== 0) return;
      }

      cancelHold();
      cleanupWindowListeners();

      hasMoved = false;
      const pt = (e.touches && e.touches[0]) || e;
      startPos = { x: pt.clientX, y: pt.clientY };

      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', onPointerUp);
      window.addEventListener('touchmove', onPointerMove, { passive: true });
      window.addEventListener('touchend', onPointerUp, { passive: true });
      window.addEventListener('touchcancel', onPointerUp, { passive: true });

      holdTimer = setTimeout(() => {
        const curItem = marker._wmItem;
        if (!curItem) return;

        isDragging = true;
        draggingMarkerId = curItem.id;
        marker.dragging.enable();

        const curEl = marker.getElement();
        const pin = curEl && curEl.querySelector('.wm-marker-pin-wrap');
        if (pin) pin.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(40);
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('📍 Перемещайте метку, отпустите для фиксации', 1600);
        }
      }, 420);
    }

    function bindElement() {
      const el = marker.getElement();
      if (!el || el._wmGestureBound) return;
      el._wmGestureBound = true;
      el.addEventListener('mousedown', startHold);
      el.addEventListener('touchstart', startHold, { passive: true });
    }

    marker._wmBindElement = bindElement;

    marker.on('remove', () => {
      cancelHold();
      cleanupWindowListeners();
    });

    marker.on('dragend', () => {
      const curItem = marker._wmItem;
      if (!curItem) return;

      const pos = marker.getLatLng();
      curItem.lat = pos.lat;
      curItem.lng = pos.lng;
      saveStoredMarkers();

      const entry = leafletMarkers.get(curItem.id);
      if (entry) {
        entry.lat = pos.lat;
        entry.lng = pos.lng;
      }

      if (WM.navTarget && WM.navTarget.isTarget(curItem.id)) {
        WM.navTarget.updateCoordinates(curItem.lat, curItem.lng);
      }

      marker.dragging.disable();
      isDragging = false;
      draggingMarkerId = null;

      const curEl = marker.getElement();
      const pin = curEl && curEl.querySelector('.wm-marker-pin-wrap');
      if (pin) pin.classList.remove('dragging');

      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('📍 Позиция метки сохранена');
      }

      hasMoved = true;
      setTimeout(() => { hasMoved = false; }, 250);

      lastRenderSignature = '';
      renderVisible(true);
      if (WM.sharedMarkers && WM.sharedMarkers.renderVisible) {
        WM.sharedMarkers.renderVisible();
      }
    });

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (hasMoved || isDragging) return;
      if (marker._wmItem) openMarkerModal(marker._wmItem);
    });
  }

  function createDotLayer(item) {
    const dot = L.circleMarker([item.lat, item.lng], {
      renderer: canvasRenderer,
      radius: 6,
      fillColor: item.color || '#3b82f6',
      color: '#ffffff',
      weight: 2,
      fillOpacity: 0.95,
      interactive: true
    });
    dot._wmItem = item;
    dot.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (dot._wmItem) openMarkerModal(dot._wmItem);
    });
    return dot;
  }

  function createPinLayer(item) {
    const marker = L.marker([item.lat, item.lng], {
      icon: buildPinIcon(item),
      draggable: false,
      zIndexOffset: 800
    });
    marker._wmItem = item;
    attachGestureHandlers(marker);
    return marker;
  }

  function renderVisible(force = false) {
    if (!WM.map || !markersLayerGroup) return;

    if (!markersData.length) {
      if (leafletMarkers.size > 0) {
        markersLayerGroup.clearLayers();
        leafletMarkers.clear();
      }
      lastRenderSignature = '';
      return;
    }

    const zoom = WM.map.getZoom();
    const targetType = zoom >= BADGE_MIN_ZOOM ? 'pin' : 'dot';
    const bounds = WM.map.getBounds().pad(0.25);

    const visibleItems = [];
    const sigParts = [targetType];

    for (let i = 0; i < markersData.length; i++) {
      const m = markersData[i];
      if (m.id === draggingMarkerId || bounds.contains([m.lat, m.lng])) {
        visibleItems.push(m);
        sigParts.push(m.id);
      }
    }

    const sig = sigParts.join('|');
    if (!force && sig === lastRenderSignature) {
      return;
    }
    lastRenderSignature = sig;

    const activeIds = new Set();

    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      activeIds.add(item.id);
      const visualKey = getMarkerVisualKey(item);
      const existing = leafletMarkers.get(item.id);

      if (existing && existing.type === targetType) {
        existing.marker._wmItem = item;

        if (item.id !== draggingMarkerId && (existing.lat !== item.lat || existing.lng !== item.lng)) {
          existing.marker.setLatLng([item.lat, item.lng]);
          existing.lat = item.lat;
          existing.lng = item.lng;
        }

        if (existing.visualKey !== visualKey) {
          existing.visualKey = visualKey;
          if (targetType === 'pin') {
            existing.marker.setIcon(buildPinIcon(item));
            if (existing.marker._wmBindElement) existing.marker._wmBindElement();
          } else {
            existing.marker.setStyle({ fillColor: item.color || '#3b82f6' });
          }
        }
        continue;
      }

      if (existing) {
        markersLayerGroup.removeLayer(existing.marker);
        leafletMarkers.delete(item.id);
      }

      const layer = targetType === 'pin' ? createPinLayer(item) : createDotLayer(item);
      markersLayerGroup.addLayer(layer);
      if (targetType === 'pin' && layer._wmBindElement) {
        layer._wmBindElement();
      }

      leafletMarkers.set(item.id, {
        marker: layer,
        type: targetType,
        visualKey,
        lat: item.lat,
        lng: item.lng
      });
    }

    for (const [id, entry] of leafletMarkers) {
      if (!activeIds.has(id) && id !== draggingMarkerId) {
        markersLayerGroup.removeLayer(entry.marker);
        leafletMarkers.delete(id);
      }
    }
  }

  function onMapMove() {
    clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(() => renderVisible(false), 90);
  }

  // Интерфейс модального окна (без пересоздания DOM-кнопок при каждом выборе)
  function renderEmojiGrid() {
    const grid = $('marker-emoji-grid');
    if (!grid) return;

    if (!grid._built) {
      grid._built = true;
      grid.innerHTML = '';
      EMOJI_LIST.forEach(em => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'marker-emoji-item';
        btn.dataset.emoji = em;
        btn.textContent = em;
        btn.onclick = () => {
          selectedEmoji = em;
          renderEmojiGrid();
        };
        grid.appendChild(btn);
      });
    }

    const items = grid.children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].dataset.emoji === selectedEmoji);
    }
  }

  function renderColorPalette() {
    const palette = $('marker-color-palette');
    if (!palette) return;

    if (!palette._built) {
      palette._built = true;
      palette.innerHTML = '';

      COLOR_PRESETS.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-palette-chip';
        btn.dataset.color = c.toLowerCase();
        btn.style.backgroundColor = c;
        btn.onclick = () => {
          selectedColor = c;
          renderColorPalette();
        };
        palette.appendChild(btn);
      });

      const customLabel = document.createElement('label');
      customLabel.className = 'color-palette-custom';
      customLabel.title = 'Выбрать свой цвет';
      customLabel.innerHTML = '<span>🌈</span><input type="color">';
      const input = customLabel.querySelector('input');
      input.onchange = (e) => {
        selectedColor = e.target.value;
        renderColorPalette();
      };
      palette._customInput = input;
      palette.appendChild(customLabel);
    }

    const selLower = selectedColor.toLowerCase();
    const chips = palette.querySelectorAll('.color-palette-chip');
    for (let i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].dataset.color === selLower);
    }
    if (palette._customInput) {
      palette._customInput.value = selectedColor;
    }
  }

  function openMarkerModal(item = null) {
    currentEditingId = item ? item.id : null;
    selectedEmoji = item ? item.emoji : EMOJI_LIST[0];
    selectedColor = item ? item.color : COLOR_PRESETS[0];

    const titleEl = $('marker-modal-title');
    const inputEl = $('marker-text-input');
    const deleteBtn = $('marker-delete-btn');
    const saveBtn = $('marker-save-btn');
    const charCount = $('marker-char-count');

    const isPublicChk = $('marker-is-public-input');
    const passGroup = $('marker-password-group');
    const passInput = $('marker-password-input');
    const passClearBtn = $('marker-password-clear-btn');
    const useSavedBtn = $('marker-use-saved-pass-btn');

    const savedGlobalPass = (WM.sharedMarkers && WM.sharedMarkers.getPassword) ? WM.sharedMarkers.getPassword() : '';

    const targetBtn = $('marker-target-btn');
    if (targetBtn) {
      if (item) {
        targetBtn.hidden = false;
        const isCurrentTarget = WM.navTarget && WM.navTarget.isTarget(item.id);
        targetBtn.textContent = isCurrentTarget ? '🛑 Снять цель' : '🎯 Как цель';
        targetBtn.classList.toggle('active', isCurrentTarget);
      } else {
        targetBtn.hidden = true;
      }
    }

    if (isPublicChk) {
      isPublicChk.checked = item ? !!item.isPublic : false;
      if (passGroup) {
        passGroup.hidden = !isPublicChk.checked;
      }
      isPublicChk.onchange = () => {
        if (passGroup) {
          passGroup.hidden = !isPublicChk.checked;
          if (isPublicChk.checked && !passInput.value && savedGlobalPass && useSavedBtn) {
            useSavedBtn.hidden = false;
          }
        }
      };
    }

    if (passInput) {
      passInput.value = (item && item.password) ? item.password : '';
      if (passClearBtn) passClearBtn.hidden = !passInput.value;

      passInput.oninput = () => {
        if (passClearBtn) passClearBtn.hidden = !passInput.value;
        if (useSavedBtn) {
          useSavedBtn.hidden = !savedGlobalPass || (passInput.value === savedGlobalPass);
        }
      };
    }

    if (passClearBtn && passInput) {
      passClearBtn.onclick = () => {
        passInput.value = '';
        passClearBtn.hidden = true;
        if (useSavedBtn) useSavedBtn.hidden = !savedGlobalPass;
        passInput.focus();
      };
    }

    if (useSavedBtn && passInput) {
      useSavedBtn.hidden = !savedGlobalPass || (passInput.value === savedGlobalPass);
      useSavedBtn.onclick = () => {
        passInput.value = savedGlobalPass;
        useSavedBtn.hidden = true;
        if (passClearBtn) passClearBtn.hidden = false;
      };
    }

    if (item) {
      if (titleEl) titleEl.textContent = '✏️ Редактирование метки';
      if (inputEl) inputEl.value = item.text || '';
      if (deleteBtn) deleteBtn.hidden = false;
      if (saveBtn) saveBtn.textContent = 'Сохранить';
    } else {
      if (titleEl) titleEl.textContent = '📍 Новая метка в центре карты';
      if (inputEl) inputEl.value = '';
      if (deleteBtn) deleteBtn.hidden = true;
      if (saveBtn) saveBtn.textContent = 'Поставить';
    }

    if (charCount && inputEl) {
      charCount.textContent = `${inputEl.value.length} / 200`;
    }

    renderEmojiGrid();
    renderColorPalette();

    const modal = $('modal-marker');
    if (modal) modal.classList.add('open');
  }

  function closeMarkerModal() {
    const modal = $('modal-marker');
    if (modal) modal.classList.remove('open');
    currentEditingId = null;
  }

  function saveCurrentMarker() {
    const textVal = ($('marker-text-input').value || '').trim();
    const isPublicVal = $('marker-is-public-input') ? $('marker-is-public-input').checked : false;
    const passwordVal = isPublicVal && $('marker-password-input') ? $('marker-password-input').value.trim() : '';

    if (currentEditingId) {
      const item = markersData.find(m => m.id === currentEditingId);
      if (item) {
        const wasPublic = !!item.isPublic;
        item.emoji = selectedEmoji;
        item.color = selectedColor;
        item.text = textVal;
        item.isPublic = isPublicVal;
        item.password = passwordVal;

        if (WM.sharedMarkers) {
          if (isPublicVal) {
            WM.sharedMarkers.savePublicMarker(item);
          } else if (wasPublic) {
            WM.sharedMarkers.deletePublicMarker(item.id);
          }
        }
      }
    } else {
      if (!WM.map) return;
      const center = WM.map.getCenter();
      const newItem = {
        id: 'marker_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        lat: center.lat,
        lng: center.lng,
        emoji: selectedEmoji,
        color: selectedColor,
        text: textVal,
        isPublic: isPublicVal,
        password: passwordVal,
        createdAt: Date.now()
      };
      markersData.push(newItem);

      if (isPublicVal && WM.sharedMarkers) {
        WM.sharedMarkers.savePublicMarker(newItem);
      }

      if (WM.ui && WM.ui.showToast) {
        if (isPublicVal) {
          WM.ui.showToast(passwordVal ? '🔒 Заметка с паролем сохранена и опубликована' : '🌐 Публичная метка добавлена');
        } else {
          WM.ui.showToast('📍 Метка добавлена в центре карты');
        }
      }
    }

    saveStoredMarkers();
    renderVisible(true);
    closeMarkerModal();
    if (WM.sharedMarkers && WM.sharedMarkers.renderVisible) WM.sharedMarkers.renderVisible();
  }

  function deleteCurrentMarker() {
    if (!currentEditingId) return;
    if (!confirm('Удалить эту метку с карты?')) return;

    const item = markersData.find(m => m.id === currentEditingId);
    if (item && item.isPublic && WM.sharedMarkers) {
      WM.sharedMarkers.deletePublicMarker(item.id);
    }

    if (WM.navTarget && WM.navTarget.isTarget(currentEditingId)) {
      WM.navTarget.clear();
    }

    const entry = leafletMarkers.get(currentEditingId);
    if (entry && markersLayerGroup) {
      markersLayerGroup.removeLayer(entry.marker);
    }
    leafletMarkers.delete(currentEditingId);
    markersData = markersData.filter(m => m.id !== currentEditingId);
    saveStoredMarkers();
    lastRenderSignature = '';

    if (WM.sharedMarkers && WM.sharedMarkers.renderVisible) WM.sharedMarkers.renderVisible();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🗑️ Метка удалена');
    }
    closeMarkerModal();
  }

  WM.markers = {
    init() {
      loadStoredMarkers();

      if (WM.map && !markersLayerGroup) {
        canvasRenderer = L.canvas({ padding: 0.25 });
        markersLayerGroup = L.layerGroup().addTo(WM.map);
        WM.map.on('moveend zoomend', onMapMove);
      }

      renderVisible(true);

      const btnAdd = $('btn-add-marker');
      if (btnAdd) {
        btnAdd.onclick = () => openMarkerModal(null);
      }

      const inputEl = $('marker-text-input');
      const charCount = $('marker-char-count');
      if (inputEl && charCount) {
        inputEl.oninput = () => {
          charCount.textContent = `${inputEl.value.length} / 200`;
        };
      }

      const targetBtn = $('marker-target-btn');
      if (targetBtn) {
        targetBtn.onclick = () => {
          if (!currentEditingId) return;
          const item = markersData.find(m => m.id === currentEditingId);
          if (item && WM.navTarget) {
            WM.navTarget.toggle({
              id: item.id,
              lat: item.lat,
              lng: item.lng,
              title: item.text || item.emoji || 'Метка'
            });
          }
          closeMarkerModal();
        };
      }

      $('marker-modal-x').onclick = closeMarkerModal;
      $('marker-cancel-btn').onclick = closeMarkerModal;
      $('marker-save-btn').onclick = saveCurrentMarker;
      $('marker-delete-btn').onclick = deleteCurrentMarker;
    },

    getAll() { return [...markersData]; },

    openModal(item = null) {
      openMarkerModal(item);
    },

    clearAll() {
      if (markersLayerGroup) markersLayerGroup.clearLayers();
      leafletMarkers.clear();
      markersData = [];
      lastRenderSignature = '';
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
    },

    exportData() {
      return [...markersData];
    },

    importData(newList) {
      if (!Array.isArray(newList)) return;
      if (markersLayerGroup) markersLayerGroup.clearLayers();
      leafletMarkers.clear();

      markersData = newList;
      saveStoredMarkers();
      lastRenderSignature = '';
      renderVisible(true);
    }
  };
})();