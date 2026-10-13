(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // Адрес базы данных Firebase Realtime Database
  const DATABASE_URL = 'https://wikimap-bfbd3-default-rtdb.firebaseio.com';

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
  let isEditing = true;
  let ignoreNextMapClick = false;

  // Слои Leaflet
  let otherTracksLayer = null;
  let activeLineLayer = null;
  let ticksLayer = null;
  let markersLayer = null;
  let midpointsLayer = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

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

  function chooseTickStep(totalMeters, totalPixels) {
    if (totalMeters <= 0 || totalPixels <= 0) return 100;
    const pxPerMeter = totalPixels / totalMeters;
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

  function renderOtherTracks() {
    if (!otherTracksLayer || !WM.map) return;
    otherTracksLayer.clearLayers();

    tracks.forEach(track => {
      if (isMeasuring && track.id === activeTrackId) return;
      if (!track.points || track.points.length < 2) return;

      const { total } = computeTrackDistances(track.points);

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

      const lastPt = track.points[track.points.length - 1];
      const safeTrackName = escapeHtml(track.name);
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

        const popupWrap = document.createElement('div');
        popupWrap.className = 'wm-ruler-popup';
        popupWrap.innerHTML = `
          <div class="wm-ruler-popup-title">${isStart ? 'Начальная точка' : `Узел #${idx + 1}`} (${distText})</div>
          <button type="button" class="wm-ruler-popup-del-btn">🗑️ Удалить этот узел</button>
        `;

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

        marker.on('contextmenu', (e) => {
          if (e.originalEvent) {
            L.DomEvent.stopPropagation(e.originalEvent);
            L.DomEvent.preventDefault(e.originalEvent);
          }
          deleteThisVertex();
        });

        markersLayer.addLayer(marker);

        const markerEl = marker.getElement();
        if (markerEl) {
          L.DomEvent.disableClickPropagation(markerEl);

          markerEl.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            deleteThisVertex();
          });

          markerEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ignoreNextMapClick = true;
            setTimeout(() => { ignoreNextMapClick = false; }, 300);
            if (!isDragging) {
              marker.openPopup();
            }
          });

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

  function renderPolylineOnly() {
    const active = getActiveTrack();
    if (activeLineLayer && active) {
      activeLineLayer.setLatLngs(active.points.map(p => [p.lat, p.lng]));
    }
  }

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

  function updateHudValues() {
    const totalEl = $('measure-total-dist');
    const countEl = $('measure-points-count');
    const undoBtn = $('btn-measure-undo');
    const finishBtn = $('btn-measure-finish');
    const selectEl = $('measure-track-select');
    const dotEl = $('measure-track-color-dot');

    const active = getActiveTrack();
    const pts = active ? active.points : [];
    const { total } = computeTrackDistances(pts);

    if (dotEl && active) {
      dotEl.style.backgroundColor = active.color || '#0284c7';
    }

    if (totalEl) totalEl.textContent = fmtDistance(total);
    if (countEl) countEl.textContent = `${pts.length} узлов`;

    if (undoBtn) undoBtn.disabled = pts.length === 0;
    if (finishBtn) {
      finishBtn.textContent = isEditing ? '✓ Готово' : '✏️ Править';
      finishBtn.title = isEditing ? 'Зафиксировать это измерение' : 'Продолжить добавление узлов';
      finishBtn.classList.toggle('primary', isEditing);
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

  function createNewTrack() {
    const newTrack = createNewTrackObject();
    tracks.push(newTrack);
    activeTrackId = newTrack.id;
    isEditing = true;
    saveStoredTracks();
    updateDisplay();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`📏 Создано: ${newTrack.name}`);
    }
  }

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
    if (WM.quickMeasure && WM.quickMeasure.closeTool) WM.quickMeasure.closeTool();
    if (WM.shadowHeight && WM.shadowHeight.closeTool) WM.shadowHeight.closeTool();

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
        ? '📏 Наведите прицел и нажмите для добавления узла' 
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

  // =========================================================================
  // ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ ЛИНИЙ (FIREBASE + ШИФРОВАНИЕ)
  // =========================================================================
  async function hashPassword(pass) {
    if (!pass || !pass.trim()) return '';
    const text = pass.trim();
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
      for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x01000193);
        h2 = Math.imul(h2 ^ ch, 0x01000193);
      }
      return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
    }
  }

  async function encryptText(plainText, password) {
    if (!plainText || !password) return plainText;
    try {
      const enc = new TextEncoder();
      const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(password));
      const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plainText));
      const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(cipherBuf), iv.length);
      let binary = '';
      for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
      return 'enc:' + btoa(binary);
    } catch (e) {
      return plainText;
    }
  }

  async function decryptText(cipherText, password) {
    if (!cipherText || !cipherText.startsWith('enc:') || !password) return cipherText;
    try {
      const b64 = cipherText.slice(4);
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const iv = bytes.slice(0, 12);
      const data = bytes.slice(12);
      const enc = new TextEncoder();
      const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(password));
      const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
      const decBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
      return new TextDecoder().decode(decBuf);
    } catch (e) {
      return null;
    }
  }

  let cloudMode = 'share'; // 'share' | 'download'

  function openCloudModal(mode = 'share') {
    cloudMode = mode;
    const modal = $('modal-measure-cloud');
    if (!modal) return;

    const titleEl = $('measure-cloud-title');
    const descEl = $('measure-cloud-desc');
    const labelEl = $('measure-cloud-pass-label');
    const hintEl = $('measure-cloud-hint');
    const submitBtn = $('measure-cloud-submit');
    const passInput = $('measure-cloud-password');
    const passClear = $('measure-cloud-pass-clear');
    const tabShare = $('tab-measure-share');
    const tabDownload = $('tab-measure-download');

    if (tabShare) tabShare.classList.toggle('active', mode === 'share');
    if (tabDownload) tabDownload.classList.toggle('active', mode === 'download');

    if (mode === 'share') {
      if (titleEl) titleEl.textContent = '📤 Поделиться линиями';
      if (descEl) descEl.textContent = 'Загрузить все ваши измерения в облако Firebase под паролем.';
      if (labelEl) labelEl.textContent = 'Придумайте пароль (минимум 5 символов):';
      if (passInput) passInput.placeholder = 'Придумайте пароль комнаты...';
      if (hintEl) hintEl.textContent = 'Сообщите этот пароль другому человеку, чтобы он смог скачать данные линии.';
      if (submitBtn) submitBtn.textContent = '📤 Поделиться';
    } else {
      if (titleEl) titleEl.textContent = '📥 Скачать линии из облака';
      if (descEl) descEl.textContent = 'Получить измерения из облака Firebase по паролю комнаты.';
      if (labelEl) labelEl.textContent = 'Введите пароль комнаты (минимум 5 символов):';
      if (passInput) passInput.placeholder = 'Введите пароль комнаты...';
      if (hintEl) hintEl.textContent = 'Все линии измерений, сохранённые под этим паролем, добавятся на карту.';
      if (submitBtn) submitBtn.textContent = '📥 Скачать';
    }

    if (passInput) {
      passInput.value = '';
      if (passClear) passClear.hidden = true;
    }

    modal.classList.add('open');
    if (passInput) setTimeout(() => passInput.focus(), 120);
  }

  function closeCloudModal() {
    const modal = $('modal-measure-cloud');
    if (modal) modal.classList.remove('open');
  }

  async function handleCloudSubmit() {
    const passInput = $('measure-cloud-password');
    const submitBtn = $('measure-cloud-submit');
    const pass = passInput ? passInput.value.trim() : '';

    if (!pass || pass.length < 5) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Пароль должен быть не менее 5 символов', 2500);
      return;
    }

    if (!DATABASE_URL) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ База Firebase недоступна', 2500);
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Обработка…';
    }

    try {
      const roomHash = await hashPassword(pass);

      if (cloudMode === 'share') {
        const validTracks = tracks.filter(t => t.points && t.points.length >= 2);
        if (!validTracks.length) {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Нет готовых линий для отправки (нужно минимум 2 точки)', 2500);
          return;
        }

        const serialized = JSON.stringify(validTracks);
        const encrypted = await encryptText(serialized, pass);

        const payload = {
          updatedAt: Date.now(),
          tracksCount: validTracks.length,
          data: encrypted
        };

        const res = await fetch(`${DATABASE_URL}/shared_tracks/${roomHash}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('HTTP ' + res.status);

        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`✅ Отправлено линий: ${validTracks.length}! Пароль: «${pass}»`, 3500);
        }
        closeCloudModal();
      } else {
        const res = await fetch(`${DATABASE_URL}/shared_tracks/${roomHash}.json`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const remote = await res.json();

        if (!remote || !remote.data) {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('❌ Линии с таким паролем не найдены в облаке', 2500);
          return;
        }

        const decrypted = await decryptText(remote.data, pass);
        if (!decrypted) {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('❌ Не удалось расшифровать: неверный пароль', 2500);
          return;
        }

        const downloadedTracks = JSON.parse(decrypted);
        if (!Array.isArray(downloadedTracks) || !downloadedTracks.length) {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('❌ В комнате нет сохранённых линий', 2500);
          return;
        }

        let addedCount = 0;
        downloadedTracks.forEach(dT => {
          if (!Array.isArray(dT.points) || dT.points.length < 2) return;

          const isDuplicate = tracks.some(eT =>
            eT.points.length === dT.points.length &&
            Math.abs(eT.points[0].lat - dT.points[0].lat) < 0.00001 &&
            Math.abs(eT.points[0].lng - dT.points[0].lng) < 0.00001
          );

          if (!isDuplicate) {
            tracks.push({
              id: 'track_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
              name: dT.name || `Линия ${tracks.length + 1}`,
              color: dT.color || TRACK_COLORS[tracks.length % TRACK_COLORS.length],
              points: dT.points
            });
            addedCount++;
          }
        });

        if (addedCount > 0) {
          activeTrackId = tracks[tracks.length - 1].id;
          saveStoredTracks();
          updateDisplay();
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`✅ Скачано новых линий: ${addedCount}`, 3000);
          }
          closeCloudModal();
        } else {
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('ℹ️ Все линии из этой комнаты уже есть на карте', 2500);
          }
          closeCloudModal();
        }
      }
    } catch (err) {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('❌ Ошибка связи с сервером: ' + err.message, 3000);
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = cloudMode === 'share' ? '📤 Поделиться' : '📥 Скачать';
      }
    }
  }

  function initCloudUI() {
    const btnShare = $('btn-measure-share');
    if (btnShare) btnShare.onclick = () => openCloudModal('share');

    const btnDownload = $('btn-measure-download');
    if (btnDownload) btnDownload.onclick = () => openCloudModal('download');

    const modal = $('modal-measure-cloud');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeCloudModal();
      });
    }

    const closeBtn = $('measure-cloud-x');
    if (closeBtn) closeBtn.onclick = closeCloudModal;

    const cancelBtn = $('measure-cloud-cancel');
    if (cancelBtn) cancelBtn.onclick = closeCloudModal;

    const submitBtn = $('measure-cloud-submit');
    if (submitBtn) submitBtn.onclick = handleCloudSubmit;

    const passInput = $('measure-cloud-password');
    const passClear = $('measure-cloud-pass-clear');

    if (passInput) {
      passInput.addEventListener('input', () => {
        if (passClear) passClear.hidden = !passInput.value;
      });
      passInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleCloudSubmit();
      });
    }

    if (passClear && passInput) {
      passClear.onclick = () => {
        passInput.value = '';
        passClear.hidden = true;
        passInput.focus();
      };
    }

    const tabShare = $('tab-measure-share');
    if (tabShare) tabShare.onclick = () => openCloudModal('share');

    const tabDownload = $('tab-measure-download');
    if (tabDownload) tabDownload.onclick = () => openCloudModal('download');
  }

  let tickDebounceTimer = null;

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
        clearTimeout(tickDebounceTimer);
        tickDebounceTimer = setTimeout(() => {
          renderTicks();
        }, 150);
      });

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

      initCloudUI();

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
    openCloudModal,

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

    importData(importedData) {
      if (!Array.isArray(importedData)) return;

      if (importedData.length > 0 && isFinite(importedData[0].lat) && isFinite(importedData[0].lng)) {
        const validPts = importedData.filter(p => p && isFinite(p.lat) && isFinite(p.lng));
        tracks = [{
          id: 'track_' + Date.now(),
          name: 'Линия 1',
          color: TRACK_COLORS[0],
          points: validPts
        }];
      } else {
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