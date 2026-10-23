(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // Набор из 32 разноплановых эмодзи для карт
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
  let markersData = [];
  let leafletMarkers = new Map(); // id -> L.Marker
  let currentEditingId = null;

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

  // Создание HTML для манга-облачка
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
        <svg class="wm-marker-tail" viewBox="0 0 16 15" width="16" height="15">
          <path d="M1,0 C4,0 7,4 8,14 C9,4 12,0 15,0 Z" fill="${item.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"></path>
        </svg>
      </div>
    `;
  }

  function renderMarkerOnMap(item) {
    if (!WM.map) return;

    // Четкая привязка: точка [ICON_WIDTH / 2, ICON_HEIGHT] указывает строго на кончик капли
    const icon = L.divIcon({
      className: 'wm-custom-marker-icon',
      html: buildMarkerHtml(item),
      iconSize: [ICON_WIDTH, ICON_HEIGHT],
      iconAnchor: [ICON_WIDTH / 2, ICON_HEIGHT]
    });

    let marker = leafletMarkers.get(item.id);

    if (marker) {
      marker.setLatLng([item.lat, item.lng]);
      marker.setIcon(icon);
    } else {
      marker = L.marker([item.lat, item.lng], {
        icon,
        draggable: false,
        zIndexOffset: 800
      }).addTo(WM.map);

      attachGestureHandlers(marker, item);
      leafletMarkers.set(item.id, marker);
    }
  }

  // Обработка клика и долгого нажатия для перемещения
  function attachGestureHandlers(marker, item) {
    let holdTimer = null;
    let isDragging = false;
    let hasMoved = false;
    let startPos = null;

    const el = marker.getElement();
    if (!el) return;

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
    }

    function startHold(e) {
      hasMoved = false;
      const pt = (e.touches && e.touches[0]) || e;
      startPos = { x: pt.clientX, y: pt.clientY };

      // Подписываемся на события перемещения и отпускания только пока удерживается палец/мышь
      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', onPointerUp);
      window.addEventListener('touchmove', onPointerMove, { passive: true });
      window.addEventListener('touchend', onPointerUp, { passive: true });
      window.addEventListener('touchcancel', onPointerUp, { passive: true });

      holdTimer = setTimeout(() => {
        isDragging = true;
        marker.dragging.enable();
        const pin = el.querySelector('.wm-marker-pin-wrap');
        if (pin) pin.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(40);
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('📍 Перемещайте метку, отпустите для фиксации', 1600);
        }
      }, 420); // 420 мс порог долгого нажатия
    }

    el.addEventListener('mousedown', startHold);
    el.addEventListener('touchstart', startHold, { passive: true });

    // По завершению перемещения Leaflet
    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      item.lat = pos.lat;
      item.lng = pos.lng;
      saveStoredMarkers();

      if (WM.navTarget && WM.navTarget.isTarget(item.id)) {
        WM.navTarget.updateCoordinates(item.lat, item.lng);
      }

      marker.dragging.disable();
      isDragging = false;
      const pin = el.querySelector('.wm-marker-pin-wrap');
      if (pin) pin.classList.remove('dragging');

      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('📍 Позиция метки сохранена');
      }

      // Защита от открытия диалога сразу после перетаскивания
      hasMoved = true;
      setTimeout(() => { hasMoved = false; }, 250);
    });

    // Одиночный короткий клик — открыть модальное окно просмотра / редактирования
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (hasMoved || isDragging) return;
      openMarkerModal(item);
    });
  }

  // Интерфейс модального окна
  function renderEmojiGrid() {
    const grid = $('marker-emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    EMOJI_LIST.forEach(em => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'marker-emoji-item' + (em === selectedEmoji ? ' active' : '');
      btn.textContent = em;
      btn.onclick = () => {
        selectedEmoji = em;
        renderEmojiGrid();
      };
      grid.appendChild(btn);
    });
  }

  function renderColorPalette() {
    const palette = $('marker-color-palette');
    if (!palette) return;
    palette.innerHTML = '';

    COLOR_PRESETS.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-palette-chip' + (c.toLowerCase() === selectedColor.toLowerCase() ? ' active' : '');
      btn.style.backgroundColor = c;
      btn.onclick = () => {
        selectedColor = c;
        renderColorPalette();
      };
      palette.appendChild(btn);
    });

    // Пользовательский цвет
    const customLabel = document.createElement('label');
    customLabel.className = 'color-palette-custom';
    customLabel.title = 'Выбрать свой цвет';
    customLabel.innerHTML = '<span>🌈</span><input type="color">';
    const input = customLabel.querySelector('input');
    input.value = selectedColor;
    input.onchange = (e) => {
      selectedColor = e.target.value;
      renderColorPalette();
    };
    palette.appendChild(customLabel);
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
      // Редактирование
      const item = markersData.find(m => m.id === currentEditingId);
      if (item) {
        const wasPublic = !!item.isPublic;
        item.emoji = selectedEmoji;
        item.color = selectedColor;
        item.text = textVal;
        item.isPublic = isPublicVal;
        item.password = passwordVal;
        renderMarkerOnMap(item);

        if (WM.sharedMarkers) {
          if (isPublicVal) {
            WM.sharedMarkers.savePublicMarker(item);
          } else if (wasPublic) {
            WM.sharedMarkers.deletePublicMarker(item.id);
          }
        }
      }
    } else {
      // Создание новой метки
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
      renderMarkerOnMap(newItem);

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
    closeMarkerModal();
    if (WM.sharedMarkers && WM.sharedMarkers.renderVisible) WM.sharedMarkers.renderVisible();
  }

  function deleteCurrentMarker() {
    if (!currentEditingId) return;
    if (!confirm('Удалить эту метку с карты?')) return;

    const item = markersData.find(m => m.id === currentEditingId);
    if (item && item.isPublic && WM.sharedMarkers) {
      // Удаление автором из облака Firebase
      WM.sharedMarkers.deletePublicMarker(item.id);
    }

    if (WM.navTarget && WM.navTarget.isTarget(currentEditingId)) {
      WM.navTarget.clear();
    }

    const marker = leafletMarkers.get(currentEditingId);
    if (marker && WM.map) {
      WM.map.removeLayer(marker);
    }
    leafletMarkers.delete(currentEditingId);
    markersData = markersData.filter(m => m.id !== currentEditingId);
    saveStoredMarkers();

    if (WM.sharedMarkers && WM.sharedMarkers.renderVisible) WM.sharedMarkers.renderVisible();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🗑️ Метка удалена');
    }
    closeMarkerModal();
  }


  WM.markers = {
    init() {
      loadStoredMarkers();

      // Отрисовка всех сохранённых меток
      markersData.forEach(m => renderMarkerOnMap(m));

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
      leafletMarkers.forEach(m => {
        if (WM.map) WM.map.removeLayer(m);
      });
      leafletMarkers.clear();
      markersData = [];
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
    },
    
    // Экспорт данных меток
    exportData() {
      return [...markersData];
    },

    // Импорт и мгновенная перерисовка на карте
    importData(newList) {
      if (!Array.isArray(newList)) return;
      // Удаляем текущие маркеры с карты
      leafletMarkers.forEach(m => {
        if (WM.map) WM.map.removeLayer(m);
      });
      leafletMarkers.clear();

      markersData = newList;
      saveStoredMarkers();
      markersData.forEach(m => renderMarkerOnMap(m));
    }
  };
})();