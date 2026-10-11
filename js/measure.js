(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  const STORAGE_KEY = 'wm_ruler_tracks';
  const LEGACY_STORAGE_KEY = 'wm_ruler_points';

  const TRACK_COLORS = [
    '#0284c7', // Синий
    '#10b981', // Изумрудный
    '#f59e0b', // Янтарный
    '#8b5cf6', // Фиолетовый
    '#ec4899', // Розовый
    '#06b6d4', // Голубой
    '#ef4444', // Красный
    '#84cc16'  // Салатовый
  ];

  // Массив всех измерений: [{ id, name, color, points: [{ lat, lng }] }]
  let tracks = [];
  let activeTrackId = null;

  let isMeasuring = false;
  let isEditing = true; // true — добавление и перетаскивание узлов активного трека; false — фиксация
  let ignoreNextMapClick = false;

  // Слои Leaflet
  let otherTracksLayer = null; // Все неактивные линии и их плашки
  let activeLineLayer = null;   // Текущая редактируемая полилиния
  let ticksLayer = null;        // Засечки и метки расстояния активной линии
  let markersLayer = null;      // Вершины активной линии
  let midpointsLayer = null;    // Промежуточные плюсики (+) активной линии

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  // Форматирование расстояния
  function fmtDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) {
      return Math.round(meters) + ' м';
    }
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function getActiveTrack() {
    if (!tracks.length) return null;
    let found = tracks.find(t => t.id === activeTrackId);
    if (!found) {
      found = tracks[0];
      activeTrackId = found.id;
    }
    return found;
  }

  function getActiveOrCreateTrack() {
    let t = getActiveTrack();
    if (!t) {
      t = createNewTrackObject();
      tracks.push(t);
      activeTrackId = t.id;
    }
    return t;
  }

  function createNewTrackObject(customName = null) {
    const idx = tracks.length + 1;
    return {
      id: 'track_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      name: customName || `Линия ${idx}`,
      color: TRACK_COLORS[(tracks.length) % TRACK_COLORS.length],
      points: []
    };
  }

  // Загрузка и миграция старых измерений
  function loadStoredTracks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          tracks = parsed.map((t, idx) => ({
            id: t.id || ('track_' + Date.now() + '_' + idx),
            name: t.name || `Линия ${idx + 1}`,
            color: t.color || TRACK_COLORS[idx % TRACK_COLORS.length],
            points: Array.isArray(t.points) ? t.points.filter(p => p && isFinite(p.lat) && isFinite(p.lng)) : []
          }));
        }
      }
    } catch (e) {
      tracks = [];
    }

    // Если новых данных нет, проверяем legacy хранилище (одиночный массив точек)
    if (!tracks.length) {
      try {
        const oldRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (oldRaw) {
          const oldParsed = JSON.parse(oldRaw);
          if (Array.isArray(oldParsed) && oldParsed.length) {
            const validPts = oldParsed.filter(p => p && isFinite(p.lat) && isFinite(p.lng));
            if (validPts.length) {
              tracks = [{
                id: 'track_' + Date.now(),
                name: 'Линия 1',
                color: TRACK_COLORS[0],
                points: validPts
              }];
              saveStoredTracks();
            }
          }
        }
      } catch (e) {}
    }

    if (tracks.length > 0) {
      activeTrackId = tracks[0].id;
    }
  }

  function saveStoredTracks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
      const active = getActiveTrack();
      if (active) {
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(active.points));
      }
    } catch (e) {}
  }

  // Расчёт расстояния для массива точек
  function computeTrackDistances(pts) {
    if (!pts || pts.length < 2) {
      return { total: 0, segmentDists: [], cumDists: [0] };
    }
    let total = 0;
    const segmentDists = [];
    const cumDists = [0];

    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = L.latLng(pts[i].lat, pts[i].lng);
      const p2 = L.latLng(pts[i + 1].lat, pts[i + 1].lng);
      const d = p1.distanceTo(p2);
      segmentDists.push(d);
      total += d;
      cumDists.push(total);
    }
    return { total, segmentDists, cumDists };
  }

  // Подбор шага делений
  let selectedVertexIndex = null;

  // 1. Адаптивный подбор шага (комфортная плотность 75-90px между засечками)
  function chooseTickStep(totalMeters, totalPixels) {
    if (totalMeters <= 0 || totalPixels <= 0) return 100;
    const pxPerMeter = totalPixels / totalMeters;
    // Оптимальное расстояние между делениями на экране — около 75 пикселей
    const minStepMeters = 75 / pxPerMeter;

    const NICE_STEPS = [
      1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500,
      1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000
    ];

    for (const step of NICE_STEPS) {
      if (step >= minStepMeters) return step;
    }
    return 1000000;
  }

  // Отрисовка делений для активной линии
  // 2. Отрисовка делений ДЛЯ ВСЕХ измерений
  function renderTicks() {
    if (!ticksLayer || !WM.map) return;
    ticksLayer.clearLayers();

    const map = WM.map;

    tracks.forEach(track => {
      const pts = track.points;
      if (!pts || pts.length < 2) return;

      const { total, cumDists } = computeTrackDistances(pts);

      let totalPx = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const pt1 = map.latLngToLayerPoint([pts[i].lat, pts[i].lng]);
        const pt2 = map.latLngToLayerPoint([pts[i + 1].lat, pts[i + 1].lng]);
        totalPx += pt1.distanceTo(pt2);
      }

      // Если вся линия на экране занимает меньше 35px — не загромождаем карту
      if (totalPx < 35) return;

      const stepMeters = chooseTickStep(total, totalPx);
      const tickLen = 6;
      const lineColor = track.color || '#0284c7';
      const isCurrentActive = (track.id === activeTrackId);

      for (let i = 0; i < pts.length - 1; i++) {
        const latlngA = L.latLng(pts[i].lat, pts[i].lng);
        const latlngB = L.latLng(pts[i + 1].lat, pts[i + 1].lng);
        const segDist = latlngA.distanceTo(latlngB);
        if (segDist <= 0.1) continue;

        const ptA = map.latLngToLayerPoint(latlngA);
        const ptB = map.latLngToLayerPoint(latlngB);
        const segVector = ptB.subtract(ptA);
        const segLenPx = ptA.distanceTo(ptB);
        if (segLenPx < 1) continue;

        const normal = L.point(-segVector.y / segLenPx, segVector.x / segLenPx);
        const startDist = cumDists[i];
        const endDist = cumDists[i + 1];

        let currentTick = Math.ceil((startDist + 0.01) / stepMeters) * stepMeters;

        while (currentTick < endDist - (stepMeters * 0.08)) {
          const offsetInSeg = currentTick - startDist;
          const ratio = offsetInSeg / segDist;
          const tickCenterPx = ptA.add(segVector.multiplyBy(ratio));
          const tickP1 = map.layerPointToLatLng(tickCenterPx.add(normal.multiplyBy(tickLen)));
          const tickP2 = map.layerPointToLatLng(tickCenterPx.subtract(normal.multiplyBy(tickLen)));

          L.polyline([tickP1, tickP2], {
            color: lineColor,
            weight: isCurrentActive ? 2 : 1.5,
            opacity: isCurrentActive ? 0.9 : 0.65,
            interactive: false
          }).addTo(ticksLayer);

          const labelPos = map.layerPointToLatLng(tickCenterPx.add(normal.multiplyBy(tickLen + 9)));
          const tickLabel = L.marker(labelPos, {
            icon: L.divIcon({
              className: 'wm-ruler-tick-label',
              html: `<span>${fmtDistance(currentTick)}</span>`,
              iconSize: [60, 16],
              iconAnchor: [30, 8]
            }),
            interactive: false
          });
          ticksLayer.addLayer(tickLabel);

          currentTick += stepMeters;
        }
      }
    });
  }

  // Отрисовка неактивных треков (линии + плашки с расстоянием)
  function renderOtherTracks() {
    if (!otherTracksLayer || !WM.map) return;
    otherTracksLayer.clearLayers();

    tracks.forEach(track => {
      // Активный трек рисуется отдельно, если открыт инструмент
      if (isMeasuring && track.id === activeTrackId) return;
      if (!track.points || track.points.length < 2) return;

      const { total } = computeTrackDistances(track.points);

      // Сама линия неактивного измерения
      const line = L.polyline(track.points.map(p => [p.lat, p.lng]), {
        color: track.color || '#64748b',
        weight: 3.5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      });

      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        ignoreNextMapClick = true;
        setTimeout(() => { ignoreNextMapClick = false; }, 250);
        activateTrack(track.id);
        if (!isMeasuring) openTool();
      });

      otherTracksLayer.addLayer(line);

      // Информационный бейдж у конечной точки
      const lastPt = track.points[track.points.length - 1];
      const safeTrackName = escapeHtml(track.name); // escapeHtml уже есть в measure.js
      const badgeMarker = L.marker([lastPt.lat, lastPt.lng], {
        icon: L.divIcon({
          className: 'wm-ruler-track-badge-icon',
          html: `
            <div class="wm-ruler-track-badge" style="--track-color: ${escapeHtml(track.color)};">
              <span>${safeTrackName}: <b>${fmtDistance(total)}</b></span>
            </div>
          `,
          iconSize: [120, 24],
          iconAnchor: [60, 26]
        }),
        interactive: true,
        zIndexOffset: 500
      });

      badgeMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        ignoreNextMapClick = true;
        setTimeout(() => { ignoreNextMapClick = false; }, 250);
        activateTrack(track.id);
        if (!isMeasuring) openTool();
      });

      otherTracksLayer.addLayer(badgeMarker);
    });
  }

  // Промежуточные плюсики (+) для добавления узлов
  function renderMidpoints() {
    if (!midpointsLayer) return;
    midpointsLayer.clearLayers();

    if (!isEditing || !isMeasuring) return;
    const active = getActiveTrack();
    if (!active || active.points.length < 2) return;

    for (let i = 0; i < active.points.length - 1; i++) {
      const p1 = active.points[i];
      const p2 = active.points[i + 1];
      const midLat = (p1.lat + p2.lat) / 2;
      const midLng = (p1.lng + p2.lng) / 2;
      const insertIndex = i + 1;

      const midMarker = L.marker([midLat, midLng], {
        icon: L.divIcon({
          className: 'wm-ruler-midpoint-icon',
          html: `<div class="wm-ruler-midpoint-inner" style="--track-color: ${active.color};" title="Нажмите или потяните, чтобы добавить узел">＋</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        }),
        draggable: true,
        zIndexOffset: 600
      });

      midMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        ignoreNextMapClick = true;
        setTimeout(() => { ignoreNextMapClick = false; }, 250);
        active.points.splice(insertIndex, 0, { lat: midLat, lng: midLng });
        saveStoredTracks();
        updateDisplay();
      });

      midMarker.on('dragstart', () => {
        ignoreNextMapClick = true;
        active.points.splice(insertIndex, 0, { lat: midLat, lng: midLng });
      });

      midMarker.on('drag', (e) => {
        const pos = e.target.getLatLng();
        active.points[insertIndex] = { lat: pos.lat, lng: pos.lng };
        renderPolylineOnly();
      });

      midMarker.on('dragend', () => {
        saveStoredTracks();
        updateDisplay();
        setTimeout(() => { ignoreNextMapClick = false; }, 250);
      });

      midpointsLayer.addLayer(midMarker);
      const midEl = midMarker.getElement();
      if (midEl) {
        L.DomEvent.disableClickPropagation(midEl);
      }
    }
  }

  // Отрисовка основных вершин редактируемой линии
  // 3. Выделение узла красным и удаление повторным кликом
  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    if (!isMeasuring) return;
    const active = getActiveTrack();
    if (!active || !active.points) return;

    const { cumDists } = computeTrackDistances(active.points);

    active.points.forEach((p, idx) => {
      const isStart = idx === 0;
      const isEnd = idx === active.points.length - 1;
      const distText = fmtDistance(cumDists[idx]);

      const markerHtml = `
        <div class="wm-ruler-vertex-wrap ${isStart ? 'start' : ''} ${isEnd ? 'end' : ''}" style="--track-color: ${active.color};">
          <div class="wm-ruler-vertex-dot"></div>
          ${idx > 0 
            ? `<div class="wm-ruler-vertex-badge">${distText}</div>` 
            : '<div class="wm-ruler-vertex-badge start-badge">Старт</div>'}
        </div>
      `;

      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: 'wm-ruler-vertex-icon',
          html: markerHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        }),
        draggable: isEditing,
        zIndexOffset: 1000 + idx
      });

      if (isEditing) {
        let isDragging = false;

        // Создание содержимого всплывающего попапа с кнопкой удаления
        const popupWrap = document.createElement('div');
        popupWrap.className = 'wm-ruler-popup';
        popupWrap.innerHTML = `
          <div class="wm-ruler-popup-title">${isStart ? 'Начальная точка' : `Узел #${idx + 1}`} (${distText})</div>
          <button type="button" class="wm-ruler-popup-del-btn">🗑️ Удалить этот узел</button>
        `;

        // Предотвращаем прокликивание сквозь попап на карту
        L.DomEvent.disableClickPropagation(popupWrap);

        function deleteThisVertex() {
          ignoreNextMapClick = true;
          setTimeout(() => { ignoreNextMapClick = false; }, 350);

          marker.closePopup();
          active.points.splice(idx, 1);
          saveStoredTracks();
          updateDisplay();
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('🗑️ Узел удален');
        }

        const delBtn = popupWrap.querySelector('.wm-ruler-popup-del-btn');
        delBtn.onclick = (e) => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          deleteThisVertex();
        };

        marker.bindPopup(popupWrap, {
          offset: [0, -14],
          closeButton: false,
          className: 'wm-ruler-leaflet-popup'
        });

        // Перетаскивание узла
        marker.on('dragstart', () => {
          isDragging = true;
          ignoreNextMapClick = true;
          marker.closePopup();
        });

        marker.on('drag', (e) => {
          const pos = e.target.getLatLng();
          active.points[idx] = { lat: pos.lat, lng: pos.lng };
          renderPolylineOnly();
          updateHudValues();
        });

        marker.on('dragend', () => {
          saveStoredTracks();
          updateDisplay();
          setTimeout(() => {
            isDragging = false;
            ignoreNextMapClick = false;
          }, 250);
        });

        // 1. Открытие попапа по клику (Leaflet event)
        marker.on('click', (e) => {
          if (e.originalEvent) {
            L.DomEvent.stopPropagation(e.originalEvent);
          }
          ignoreNextMapClick = true;
          setTimeout(() => { ignoreNextMapClick = false; }, 300);
          if (!isDragging) {
            marker.openPopup();
          }
        });

        // 2. ПКМ удаление узла (Leaflet event с правильной отменой e.originalEvent)
        marker.on('contextmenu', (e) => {
          if (e.originalEvent) {
            L.DomEvent.stopPropagation(e.originalEvent);
            L.DomEvent.preventDefault(e.originalEvent);
          }
          deleteThisVertex();
        });

        markersLayer.addLayer(marker);

        // 3. Дублируем обработчики на DOM-элементе узла для 100% гарантии перехвата
        const markerEl = marker.getElement();
        if (markerEl) {
          L.DomEvent.disableClickPropagation(markerEl);

          // Гарантированно гасим нативное контекстное меню браузера и удаляем узел
          markerEl.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            deleteThisVertex();
          });

          // Прямой клик левой кнопкой мыши
          markerEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ignoreNextMapClick = true;
            setTimeout(() => { ignoreNextMapClick = false; }, 300);
            if (!isDragging) {
              marker.openPopup();
            }
          });

          // Мобильные свайпы / тапы
          let touchStartPos = null;
          let touchMoved = false;

          markerEl.addEventListener('touchstart', (ev) => {
            if (ev.touches.length === 1) {
              touchStartPos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
              touchMoved = false;
            }
          }, { passive: true });

          markerEl.addEventListener('touchmove', (ev) => {
            if (touchStartPos && ev.touches.length === 1) {
              const dist = Math.hypot(ev.touches[0].clientX - touchStartPos.x, ev.touches[0].clientY - touchStartPos.y);
              if (dist > 8) touchMoved = true;
            }
          }, { passive: true });

          markerEl.addEventListener('touchend', (ev) => {
            if (touchStartPos && !touchMoved && !isDragging) {
              ev.stopPropagation();
              ignoreNextMapClick = true;
              setTimeout(() => { ignoreNextMapClick = false; }, 350);
              marker.openPopup();
            }
            touchStartPos = null;
          });
        }
      } else {
        markersLayer.addLayer(marker);
      }
    });
  }

  function showVertexPopup(marker, index, distText) {
    const isStart = index === 0;
    const popupContent = document.createElement('div');
    popupContent.className = 'wm-ruler-popup';
    popupContent.innerHTML = `
      <div class="wm-ruler-popup-title">${isStart ? 'Начальная точка' : `Узел #${index + 1}`} (${distText})</div>
      <button type="button" class="wm-ruler-popup-del-btn">🗑️ Удалить этот узел</button>
    `;

    const delBtn = popupContent.querySelector('.wm-ruler-popup-del-btn');
    delBtn.onclick = () => {
      marker.closePopup();
      const active = getActiveTrack();
      if (active) {
        active.points.splice(index, 1);
        saveStoredTracks();
        updateDisplay();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🗑️ Узел удален');
      }
    };

    marker.bindPopup(popupContent, {
      offset: [0, -12],
      closeButton: false,
      className: 'wm-ruler-leaflet-popup'
    }).openPopup();
  }

  // Быстрая перерисовка линии при drag (60fps)
  function renderPolylineOnly() {
    const active = getActiveTrack();
    if (activeLineLayer && active) {
      activeLineLayer.setLatLngs(active.points.map(p => [p.lat, p.lng]));
    }
  }

  // Полное обновление
  function updateDisplay() {
    if (!WM.map) return;

    const active = getActiveTrack();

    if (activeLineLayer) {
      if (isMeasuring && active && active.points.length >= 2) {
        activeLineLayer.setStyle({ color: active.color || '#0284c7' });
        activeLineLayer.setLatLngs(active.points.map(p => [p.lat, p.lng]));
      } else {
        activeLineLayer.setLatLngs([]);
      }
    }

    renderOtherTracks();
    renderTicks();
    renderMarkers();
    renderMidpoints();
    updateHudValues();
  }

  // Обновление интерфейса HUD
  function updateHudValues() {
    const totalEl = $('measure-total-dist');
    const countEl = $('measure-points-count');
    const undoBtn = $('btn-measure-undo');
    const finishBtn = $('btn-measure-finish');
    const selectEl = $('measure-track-select');

    const active = getActiveTrack();
    const pts = active ? active.points : [];
    const { total } = computeTrackDistances(pts);

    if (totalEl) totalEl.textContent = fmtDistance(total);
    if (countEl) countEl.textContent = `Узлов: ${pts.length}`;

    if (undoBtn) undoBtn.disabled = pts.length === 0;
    if (finishBtn) {
      finishBtn.textContent = isEditing ? '✓ Готово' : '✏️ Редактировать';
      finishBtn.title = isEditing ? 'Зафиксировать это измерение' : 'Продолжить добавление узлов';
    }

    if (selectEl) {
      selectEl.innerHTML = '';
      tracks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        const d = computeTrackDistances(t.points).total;
        opt.textContent = `${t.name} (${fmtDistance(d)})`;
        if (t.id === activeTrackId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    }
  }

  function activateTrack(trackId) {
    if (activeTrackId === trackId) return;
    activeTrackId = trackId;
    saveStoredTracks();
    updateDisplay();
  }

  // Добавление новой линии
  function createNewTrack() {
    const newTrack = createNewTrackObject();
    tracks.push(newTrack);
    activeTrackId = newTrack.id;
    isEditing = true;
    saveStoredTracks();
    updateDisplay();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`📏 Создано измерение: ${newTrack.name}`);
    }
  }

  // Переименование текущей линии
  function renameCurrentTrack() {
    const active = getActiveTrack();
    if (!active) return;
    const newName = prompt('Название измерения:', active.name);
    if (newName && newName.trim()) {
      active.name = newName.trim();
      saveStoredTracks();
      updateDisplay();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`Переименовано в «${active.name}»`);
      }
    }
  }

  // Клик по карте для добавления точки
  function onMapClick(latlng) {
    if (!isMeasuring || !isEditing || ignoreNextMapClick) return;
    const active = getActiveOrCreateTrack();
    active.points.push({ lat: latlng.lat, lng: latlng.lng });
    saveStoredTracks();
    updateDisplay();
  }

  function undoLastPoint() {
    const active = getActiveTrack();
    if (!active || !active.points.length) return;
    active.points.pop();
    saveStoredTracks();
    updateDisplay();
  }

  // Удаление текущего измерения
  function deleteCurrentTrack() {
    const active = getActiveTrack();
    if (!active) return;

    if (active.points.length > 0) {
      if (!confirm(`Удалить измерение «${active.name}»?`)) return;
    }

    tracks = tracks.filter(t => t.id !== active.id);

    if (tracks.length === 0) {
      const fresh = createNewTrackObject();
      tracks.push(fresh);
      activeTrackId = fresh.id;
    } else {
      activeTrackId = tracks[tracks.length - 1].id;
    }

    saveStoredTracks();
    updateDisplay();
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('🗑️ Измерение удалено');
  }

  function toggleEditing() {
    isEditing = !isEditing;
    updateDisplay();
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(isEditing ? '✏️ Редактирование: ставьте или двигайте узлы' : '📌 Измерение зафиксировано');
    }
  }

  function openTool() {
    isMeasuring = true;
    isEditing = true;

    if (!tracks.length) {
      const fresh = createNewTrackObject();
      tracks.push(fresh);
      activeTrackId = fresh.id;
      saveStoredTracks();
    }

    const btn = $('btn-measure');
    if (btn) {
      btn.classList.add('active');
      btn.title = 'Линейка активна (нажмите для скрытия панели)';
    }

    const hud = $('measure-hud');
    if (hud) hud.hidden = false;

    updateDisplay();

    if (WM.ui && WM.ui.showToast) {
      const isCross = WM.picker && WM.picker.getMode && WM.picker.getMode() === 'cross';
      WM.ui.showToast(isCross 
        ? '📏 Наведите перекрестие и нажмите в любом месте карты' 
        : '📏 Кликайте по карте для построения линии', 2200);
    }
  }

  function closeTool() {
    isMeasuring = false;
    isEditing = false;

    const btn = $('btn-measure');
    if (btn) {
      btn.classList.remove('active');
      btn.title = 'Линейка (измерение расстояний)';
    }

    const hud = $('measure-hud');
    if (hud) hud.hidden = true;

    updateDisplay();
  }

  function toggleTool() {
    if (isMeasuring) closeTool();
    else openTool();
  }

  WM.measure = {
    init() {
      if (!WM.map) return;
      loadStoredTracks();

      otherTracksLayer = L.layerGroup().addTo(WM.map);
      ticksLayer = L.layerGroup().addTo(WM.map);

      activeLineLayer = L.polyline([], {
        color: '#0284c7',
        weight: 4,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(WM.map);

      midpointsLayer = L.layerGroup().addTo(WM.map);
      markersLayer = L.layerGroup().addTo(WM.map);

      WM.map.on('zoomend', () => {
        renderTicks();
      });

      // Привязка элементов управления
      const btnToggle = $('btn-measure');
      if (btnToggle) btnToggle.onclick = toggleTool;

      const btnUndo = $('btn-measure-undo');
      if (btnUndo) btnUndo.onclick = undoLastPoint;

      const btnClear = $('btn-measure-clear');
      if (btnClear) btnClear.onclick = deleteCurrentTrack;

      const btnFinish = $('btn-measure-finish');
      if (btnFinish) btnFinish.onclick = toggleEditing;

      const btnClose = $('btn-measure-close');
      if (btnClose) btnClose.onclick = closeTool;

      const btnNew = $('btn-measure-new');
      if (btnNew) btnNew.onclick = createNewTrack;

      const btnRename = $('btn-measure-rename');
      if (btnRename) btnRename.onclick = renameCurrentTrack;

      const trackSelect = $('measure-track-select');
      if (trackSelect) {
        trackSelect.onchange = (e) => activateTrack(e.target.value);
      }

      // Если в памяти уже были измерения, отображаем их на карте
      if (tracks.some(t => t.points && t.points.length > 0)) {
        isEditing = false;
        updateDisplay();
      }
    },
    isActive() { return isMeasuring && isEditing; },
    isToolOpen() { return isMeasuring; },
    onMapClick,
    openTool,
    closeTool,

    // Экспорт для бэкапа
    exportData() {
      return JSON.parse(JSON.stringify(tracks));
    },

    clearAll() {
      tracks = [];
      activeTrackId = null;
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (e) {}
      if (isMeasuring) {
        closeTool();
      } else {
        updateDisplay();
      }
    },

    // Импорт из бэкапа
    importData(importedData) {
      if (!Array.isArray(importedData)) return;

      // Обратная совместимость с одиночной линией
      if (importedData.length > 0 && isFinite(importedData[0].lat) && isFinite(importedData[0].lng)) {
        const validPts = importedData.filter(p => p && isFinite(p.lat) && isFinite(p.lng));
        tracks = [{
          id: 'track_' + Date.now(),
          name: 'Линия 1',
          color: TRACK_COLORS[0],
          points: validPts
        }];
      } else {
        // Новый формат (массив измерений)
        tracks = importedData.map((t, idx) => ({
          id: t.id || ('track_' + Date.now() + '_' + idx),
          name: t.name || `Линия ${idx + 1}`,
          color: t.color || TRACK_COLORS[idx % TRACK_COLORS.length],
          points: Array.isArray(t.points) ? t.points.filter(p => p && isFinite(p.lat) && isFinite(p.lng)) : []
        }));
      }

      activeTrackId = tracks.length > 0 ? tracks[0].id : null;
      saveStoredTracks();
      isEditing = false;
      updateDisplay();
    }
  };
})();