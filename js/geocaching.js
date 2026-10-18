(function () {
  const WM = window.WM = window.WM || {};
  const GEOCACHING_JSON_URL = 'https://nakarte.me/geocachingSu/geocaching_su2.json';

  let map = null;
  let containerLayer = null;
  let canvasRenderer = null;
  let isEnabled = false;
  let cachesData = [];
  let isLoading = false;
  let markersMap = new Map(); // id -> { marker, type: 'dot' | 'badge' }
  let renderDebounce = null;

  // Пространственная сетка: шаг 0.5° (~40-55 км)
  const GRID_STEP = 0.5;
  const spatialGrid = new Map();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  async function copyToClipboard(text, successMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(successMsg);
    } catch (e) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(text);
    }
  }

  function createPopupContent(item) {
    const [title, id, lat, lon] = item;
    const url = `https://geocaching.su/?pn=101&cid=${id}`;
    const coordsStr = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    const isTarget = WM.navTarget && WM.navTarget.isTarget('gc_' + id);

    const wrap = document.createElement('div');
    wrap.className = 'wm-geocache-popup';
    wrap.innerHTML = `
      <div class="wm-gc-header">
        <span class="wm-gc-icon">🧭</span>
        <div class="wm-gc-info">
          <div class="wm-gc-title">${escapeHtml(title)}</div>
          <div class="wm-gc-meta">ID: <b>${id}</b> · ${coordsStr}</div>
        </div>
      </div>
      <div class="wm-gc-actions">
        <div class="wm-gc-actions-row">
          <button type="button" class="wm-gc-btn btn-target-gc ${isTarget ? 'active' : ''}">
            ${isTarget ? '🛑 Снять цель' : '🎯 Как цель'}
          </button>
          <a href="${url}" target="_blank" rel="noopener noreferrer" class="wm-gc-btn primary">
            🌐 Открыть тайник ↗
          </a>
        </div>
        <div class="wm-gc-actions-row">
          <button type="button" class="wm-gc-btn btn-copy-url">
            📋 Ссылка
          </button>
          <button type="button" class="wm-gc-btn btn-copy-coords">
            📍 Координаты
          </button>
        </div>
      </div>
    `;

    L.DomEvent.disableClickPropagation(wrap);

    const btnTarget = wrap.querySelector('.btn-target-gc');
    if (btnTarget) {
      btnTarget.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (map) map.closePopup();
        if (WM.navTarget) {
          WM.navTarget.toggle({
            id: 'gc_' + id,
            lat: lat,
            lng: lon,
            title: title ? title.slice(0, 22) : ('Тайник #' + id)
          });
        }
      };
    }

    const btnUrl = wrap.querySelector('.btn-copy-url');
    if (btnUrl) {
      btnUrl.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(url, '📋 Ссылка на тайник скопирована!');
      };
    }

    const btnCoords = wrap.querySelector('.btn-copy-coords');
    if (btnCoords) {
      btnCoords.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(coordsStr, `📍 Координаты скопированы: ${coordsStr}`);
      };
    }

    return wrap;
  }

  // Быстрый Canvas-маркер (нулевая нагрузка на DOM, 60 FPS)
  function createDotMarker(item) {
    const [, , lat, lon] = item;
    const marker = L.circleMarker([lat, lon], {
      renderer: canvasRenderer,
      pane: 'wm-geocaching',
      radius: 6, // Увеличено с 4.5 до 6px для удобного попадания пальцем
      fillColor: '#16a34a',
      color: '#ffffff',
      weight: 1.5,
      fillOpacity: 0.95,
      interactive: true
    });

    marker.bindPopup(() => createPopupContent(item), {
      offset: [0, -4],
      className: 'wm-geocache-leaflet-popup'
    });

    marker.on('click', (e) => {
      if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    });

    return marker;
  }

  // Детальный DOM-маркер с текстом (только в фокусе внимания)
  // Функция привязки надежных тач- и клик-обработчиков
  function attachBadgeTouchHandlers(marker) {
    const el = marker.getElement();
    if (!el) return;

    // Запрещаем событиям касания уходить в Leaflet и вызывать сдвиг карты
    L.DomEvent.disableClickPropagation(el);

    let startPos = null;
    let touchMoved = false;

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        startPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchMoved = false;
      }
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (startPos && e.touches.length === 1) {
        const dist = Math.hypot(e.touches[0].clientX - startPos.x, e.touches[0].clientY - startPos.y);
        if (dist > 8) touchMoved = true;
      }
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
      if (startPos && !touchMoved) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        marker.openPopup();
      }
      startPos = null;
    });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      marker.openPopup();
    });
  }

  // Детальный DOM-маркер с текстом
  function createBadgeMarker(item) {
    const [title, , lat, lon] = item;
    const safeTitle = escapeHtml(title);

    const html = `
      <div class="wm-gc-pin-anchor">
        <div class="wm-gc-bubble">
          <div class="wm-gc-badge-card">
            <span class="wm-gc-badge-icon">🧭</span>
            <span class="wm-gc-badge-text">${safeTitle}</span>
          </div>
          <svg class="wm-gc-badge-tail" width="14" height="9" viewBox="0 0 14 9">
            <path d="M0,0 L14,0 L7,9 Z" fill="#ffffff" stroke="#16a34a" stroke-width="1.5" stroke-linejoin="round"></path>
            <line x1="1" y1="0" x2="13" y2="0" stroke="#ffffff" stroke-width="2.5"></line>
          </svg>
        </div>
        <div class="wm-gc-target-dot"></div>
      </div>
    `;

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'wm-gc-div-icon',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: true,
      zIndexOffset: 1200 // Поднимаем над векторными контурами и линиями
    });

    marker.bindPopup(() => createPopupContent(item), {
      offset: [0, -36],
      className: 'wm-geocache-leaflet-popup'
    });

    // Навешиваем обработчики при добавлении маркера на карту
    marker.on('add', () => {
      attachBadgeTouchHandlers(marker);
    });

    return marker;
  }

  // Построение пространственного индекса
  function buildSpatialIndex(data) {
    spatialGrid.clear();
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const lat = item[2];
      const lon = item[3];
      const gx = Math.floor(lat / GRID_STEP);
      const gy = Math.floor(lon / GRID_STEP);
      const key = `${gx}_${gy}`;

      let cell = spatialGrid.get(key);
      if (!cell) {
        cell = [];
        spatialGrid.set(key, cell);
      }
      cell.push(item);
    }
  }

  // Мгновенная выборка тайлов из индекса
  function querySpatialGrid(bounds) {
    const minGx = Math.floor(bounds.getSouth() / GRID_STEP);
    const maxGx = Math.floor(bounds.getNorth() / GRID_STEP);
    const minGy = Math.floor(bounds.getWest() / GRID_STEP);
    const maxGy = Math.floor(bounds.getEast() / GRID_STEP);

    const result = [];
    const minLat = bounds.getSouth(), maxLat = bounds.getNorth();
    const minLng = bounds.getWest(), maxLng = bounds.getEast();

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const cell = spatialGrid.get(`${gx}_${gy}`);
        if (!cell) continue;

        for (let i = 0; i < cell.length; i++) {
          const item = cell[i];
          const lat = item[2];
          const lng = item[3];
          if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
            result.push(item);
          }
        }
      }
    }
    return result;
  }

  async function loadData() {
    if (cachesData.length > 0 || isLoading) return;
    isLoading = true;
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('📥 Загрузка базы Geocaching.su…', 2000);

    try {
      const res = await fetch(GEOCACHING_JSON_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        cachesData = data;
        buildSpatialIndex(data);
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`🧭 Тайников загружено: ${cachesData.length}`, 2200);
        }
        renderVisible();
      }
    } catch (e) {
      console.warn('Ошибка загрузки Geocaching.su:', e);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Ошибка загрузки базы Geocaching.su');
    } finally {
      isLoading = false;
    }
  }

  function renderVisible() {
    if (!isEnabled || !map || !containerLayer || cachesData.length === 0) return;

    const zoom = map.getZoom();
    if (zoom < 6) {
      containerLayer.clearLayers();
      markersMap.clear();
      return;
    }

    const bounds = map.getBounds().pad(0.15);
    const visibleItems = querySpatialGrid(bounds);
    const currentVisibleIds = new Set();

    const center = map.getCenter();
    const canUseBadges = zoom >= 13;
    const MAX_BADGES = 60;

    let badgeCandidates = new Set();
    if (canUseBadges && visibleItems.length > 0) {
      if (visibleItems.length <= MAX_BADGES) {
        for (let i = 0; i < visibleItems.length; i++) {
          badgeCandidates.add(visibleItems[i][1]);
        }
      } else {
        // Гистерезис: если маркер УЖЕ был плашкой на экране, оставляем его плашкой,
        // чтобы не пересоздавать DOM-ноды при каждом небольшом сдвиге камеры
        const candidates = [];
        for (let i = 0; i < visibleItems.length; i++) {
          const it = visibleItems[i];
          const id = it[1];
          const existing = markersMap.get(id);
          const isAlreadyBadge = existing && existing.type === 'badge';

          const dLat = it[2] - center.lat;
          const dLng = it[3] - center.lng;
          // Бонус приоритета для уже созданных плашек (-40% к дистанции)
          const weight = isAlreadyBadge ? 0.6 : 1.0;
          candidates.push({ id, distSq: (dLat * dLat + dLng * dLng) * weight });
        }

        candidates.sort((a, b) => a.distSq - b.distSq);
        for (let i = 0; i < MAX_BADGES; i++) {
          badgeCandidates.add(candidates[i].id);
        }
      }
    }

    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      const id = item[1];
      currentVisibleIds.add(id);

      const targetType = badgeCandidates.has(id) ? 'badge' : 'dot';
      const existing = markersMap.get(id);

      if (existing) {
        if (existing.type === targetType) {
          continue; // Маркер уже нужного типа, не трогаем DOM
        }
        containerLayer.removeLayer(existing.marker);
        markersMap.delete(id);
      }

      const marker = targetType === 'badge' ? createBadgeMarker(item) : createDotMarker(item);
      containerLayer.addLayer(marker);
      markersMap.set(id, { marker, type: targetType });
    }

    // Удаляем маркеры, ушедшие за пределы видимости
    for (const [id, entry] of markersMap) {
      if (!currentVisibleIds.has(id)) {
        containerLayer.removeLayer(entry.marker);
        markersMap.delete(id);
      }
    }
  }

  function onMapChange() {
    if (!isEnabled) return;
    clearTimeout(renderDebounce);
    renderDebounce = setTimeout(renderVisible, 90);
  }

  WM.geocaching = {
    init(m, layer) {
      map = m;
      containerLayer = layer;
      canvasRenderer = L.canvas({ padding: 0.25, pane: 'wm-geocaching' });
      map.on('moveend zoomend', onMapChange);
    },
    enable() {
      isEnabled = true;
      if (!map.hasLayer(containerLayer)) {
        containerLayer.addTo(map);
      }
      if (cachesData.length === 0) {
        loadData();
      } else {
        renderVisible();
      }
    },
    disable() {
      isEnabled = false;
      clearTimeout(renderDebounce);
      if (containerLayer) {
        containerLayer.clearLayers();
      }
      markersMap.clear();
      if (map && map.hasLayer(containerLayer)) {
        map.removeLayer(containerLayer);
      }
    },
    isActive() {
      return isEnabled;
    }
  };
})();