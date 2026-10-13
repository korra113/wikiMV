(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // =========================================================================
  // ВСТАВЬТЕ СЮДА URL ВАШЕЙ БАЗЫ ДАННЫХ ИЗ FIREBASE CONSOLE:
  // (без слэша на конце)
  // =========================================================================
  const DATABASE_URL = 'https://wikimap-bfbd3-default-rtdb.firebaseio.com';

  let map = null;
  let canvasRenderer = null;
  let sharedLayerGroup = null;

  // Идентификатор устройства для разделения своих и чужих меток
  let deviceId = localStorage.getItem('wm_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('wm_device_id', deviceId);
  }

  // Настройки
  let cfg = {
    download: localStorage.getItem('wm_download_foreign_markers') !== 'false',
    show: localStorage.getItem('wm_show_foreign_markers') !== 'false'
  };

  // Чужие метки, загруженные из базы: id -> data
  const foreignMarkers = new Map();

  // Локальный чёрный список скрытых на этом устройстве меток
  let hiddenForeignMarkerIds = new Set();
  try {
    const rawHidden = localStorage.getItem('wm_hidden_foreign_markers');
    if (rawHidden) hiddenForeignMarkerIds = new Set(JSON.parse(rawHidden));
  } catch (e) {}

  // Отрисованные Leaflet-слои: id -> { marker, type: 'dot' | 'badge' }
  const renderedLayers = new Map();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function updateStatusUI(text) {
    const el = $('shared-markers-status');
    if (el) el.textContent = 'Статус: ' + text;
  }

  // Вспомогательная функция запроса с таймаутом (чтобы не висеть при плохой сети)
  async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, credentials: 'omit', signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // --- 1. Загрузка актуальных меток (GET /markers.json) ---
  async function fetchRemoteMarkers() {
    if (!cfg.download) {
      foreignMarkers.clear();
      renderVisible();
      updateStatusUI('Загрузка выключена');
      return;
    }

    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ')) {
      updateStatusUI('Укажите DATABASE_URL в sharedMarkers.js');
      return;
    }

    updateStatusUI('⏳ Синхронизация с базой…');

    try {
      const res = await fetchWithTimeout(`${DATABASE_URL}/markers.json`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json() || {};

      // Стираем старые метки с экрана устройства
      foreignMarkers.clear();

      let count = 0;
      Object.entries(data).forEach(([key, item]) => {
        if (!item || !item.lat || !item.lng) return;
        // Не показываем собственные метки как чужие
        if (item.authorId === deviceId) return;
        // Пропускаем метки, удалённые локально на этом устройстве
        if (hiddenForeignMarkerIds.has(item.id || key)) return;

        foreignMarkers.set(item.id || key, {
          id: item.id || key,
          authorId: item.authorId,
          lat: item.lat,
          lng: item.lng,
          emoji: item.emoji || '📍',
          text: item.text || '',
          color: item.color || '#8b5cf6',
          createdAt: item.createdAt || 0
        });
        count++;
      });

      renderVisible();
      updateStatusUI(`🟢 В сети · Чужих меток: ${count}`);
    } catch (err) {
      // При отсутствии сети приложение спокойно работает дальше
      updateStatusUI('🔴 Оффлайн (нет связи с базой)');
    }
  }

  // --- 2. Публикация своей метки (PUT /markers/{id}.json) ---
  async function savePublicMarker(marker) {
    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ') || !marker) return;

    const payload = {
      id: marker.id,
      authorId: deviceId,
      lat: marker.lat,
      lng: marker.lng,
      emoji: marker.emoji || '📍',
      text: marker.text || '',
      color: marker.color || '#3b82f6',
      createdAt: marker.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    try {
      await fetchWithTimeout(`${DATABASE_URL}/markers/${marker.id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('[Firebase REST] Не удалось сохранить метку в облако:', err.message);
    }
  }

  // --- 3. Удаление метки автором (DELETE /markers/{id}.json) ---
  async function deletePublicMarker(markerId) {
    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ') || !markerId) return;

    try {
      await fetchWithTimeout(`${DATABASE_URL}/markers/${markerId}.json`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.warn('[Firebase REST] Не удалось удалить метку из облака:', err.message);
    }
  }

  // --- 4. Удаление чужой метки ТОЛЬКО на текущем устройстве ---
  function hideForeignMarker(markerId) {
    hiddenForeignMarkerIds.add(markerId);
    try {
      localStorage.setItem('wm_hidden_foreign_markers', JSON.stringify(Array.from(hiddenForeignMarkerIds)));
    } catch (e) {}

    foreignMarkers.delete(markerId);
    if (renderedLayers.has(markerId)) {
      const entry = renderedLayers.get(markerId);
      if (sharedLayerGroup && entry) sharedLayerGroup.removeLayer(entry.marker);
      renderedLayers.delete(markerId);
    }
    renderVisible();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🗑️ Метка скрыта на вашем устройстве');
    }
  }

  // --- Отрисовка попапа чужой метки ---
  function createForeignPopup(item) {
    const wrap = document.createElement('div');
    wrap.className = 'wm-foreign-popup';
    wrap.innerHTML = `
      <div class="wm-foreign-pop-header">
        <span class="wm-foreign-pop-emoji">${item.emoji}</span>
        <div class="wm-foreign-pop-meta">
          <div class="wm-foreign-pop-badge">🌐 Публичная метка</div>
          <div class="wm-foreign-pop-coords">${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}</div>
        </div>
      </div>
      ${item.text ? `<div class="wm-foreign-pop-text">${escapeHtml(item.text)}</div>` : ''}
      <div style="display: flex; gap: 6px; margin-top: 8px;">
        <button type="button" class="btn btn-primary btn-save-foreign" style="flex: 1; font-size: 11.5px; padding: 6px 8px;">
          💾 В мои
        </button>
        <button type="button" class="btn btn-danger-outline btn-delete-foreign" style="font-size: 11.5px; padding: 6px 8px;">
          🗑️ Скрыть
        </button>
      </div>
    `;

    L.DomEvent.disableClickPropagation(wrap);

    const btnSave = wrap.querySelector('.btn-save-foreign');
    if (btnSave) {
      btnSave.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (WM.markers) {
          const newOwn = {
            id: 'marker_' + Date.now(),
            lat: item.lat,
            lng: item.lng,
            emoji: item.emoji,
            color: item.color,
            text: item.text,
            isPublic: false,
            createdAt: Date.now()
          };
          const all = WM.markers.getAll ? WM.markers.getAll() : [];
          all.push(newOwn);
          if (WM.markers.importData) WM.markers.importData(all);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Метка скопирована в ваши личные!');
        }
      };
    }

    const btnDelete = wrap.querySelector('.btn-delete-foreign');
    if (btnDelete) {
      btnDelete.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideForeignMarker(item.id);
      };
    }

    return wrap;
  }

  function createDotMarker(item) {
    const marker = L.circleMarker([item.lat, item.lng], {
      renderer: canvasRenderer,
      radius: 6.5,
      fillColor: item.color || '#8b5cf6',
      color: '#ffffff',
      weight: 2,
      fillOpacity: 0.92,
      interactive: true
    });
    marker.bindPopup(() => createForeignPopup(item), { offset: [0, -4] });
    return marker;
  }

  function createBadgeMarker(item) {
    const textHtml = item.text ? `<span class="wm-foreign-badge-text">${escapeHtml(item.text)}</span>` : '';
    const html = `
      <div class="wm-foreign-pin-anchor">
        <div class="wm-foreign-badge" style="--f-color: ${item.color || '#8b5cf6'};">
          <span class="wm-foreign-badge-radar">🌐</span>
          <span class="wm-foreign-badge-emoji">${item.emoji}</span>
          ${textHtml}
        </div>
        <div class="wm-foreign-pin-dot" style="background:${item.color || '#8b5cf6'};"></div>
      </div>
    `;

    const marker = L.marker([item.lat, item.lng], {
      icon: L.divIcon({
        className: 'wm-foreign-div-icon',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: true,
      zIndexOffset: 850
    });

    marker.bindPopup(() => createForeignPopup(item), { offset: [0, -32] });
    return marker;
  }

  function renderVisible() {
    if (!map || !sharedLayerGroup) return;

    if (!cfg.show || !cfg.download || foreignMarkers.size === 0) {
      sharedLayerGroup.clearLayers();
      renderedLayers.clear();
      return;
    }

    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.15);
    const visibleItems = [];

    foreignMarkers.forEach(m => {
      if (bounds.contains([m.lat, m.lng])) visibleItems.push(m);
    });

    const canUseBadges = zoom >= 13;
    const MAX_BADGES = 50;
    const center = map.getCenter();

    visibleItems.sort((a, b) => {
      const da = (a.lat - center.lat) ** 2 + (a.lng - center.lng) ** 2;
      const db = (b.lat - center.lat) ** 2 + (b.lng - center.lng) ** 2;
      return da - db;
    });

    const activeIds = new Set();

    visibleItems.forEach((item, idx) => {
      activeIds.add(item.id);
      const targetType = (canUseBadges && idx < MAX_BADGES) ? 'badge' : 'dot';
      const existing = renderedLayers.get(item.id);

      if (existing) {
        if (existing.type === targetType) return;
        sharedLayerGroup.removeLayer(existing.marker);
        renderedLayers.delete(item.id);
      }

      const marker = targetType === 'badge' ? createBadgeMarker(item) : createDotMarker(item);
      sharedLayerGroup.addLayer(marker);
      renderedLayers.set(item.id, { marker, type: targetType });
    });

    for (const [id, entry] of renderedLayers) {
      if (!activeIds.has(id)) {
        sharedLayerGroup.removeLayer(entry.marker);
        renderedLayers.delete(id);
      }
    }
  }

  let moveDebounceTimer = null;
  function onMapMove() {
    clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(renderVisible, 120);
  }

  WM.sharedMarkers = {
    init(m) {
      map = m;
      canvasRenderer = L.canvas({ padding: 0.25 });
      sharedLayerGroup = L.layerGroup().addTo(map);

      map.on('moveend zoomend', onMapMove);

      const chkDown = $('toggle-download-foreign');
      const chkShow = $('toggle-show-foreign');

      if (chkDown) {
        chkDown.checked = cfg.download;
        chkDown.onchange = (e) => {
          cfg.download = e.target.checked;
          localStorage.setItem('wm_download_foreign_markers', cfg.download ? 'true' : 'false');
          fetchRemoteMarkers();
        };
      }

      if (chkShow) {
        chkShow.checked = cfg.show;
        chkShow.onchange = (e) => {
          cfg.show = e.target.checked;
          localStorage.setItem('wm_show_foreign_markers', cfg.show ? 'true' : 'false');
          renderVisible();
        };
      }

      // Первичная загрузка актуальных меток при запуске
      fetchRemoteMarkers();
    },

    fetchRemoteMarkers,
    savePublicMarker,
    deletePublicMarker,
    hideForeignMarker,
    getDeviceId() { return deviceId; }
  };
})();