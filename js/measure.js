(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  const DATABASE_URL = 'https://wikimap-bfbd3-default-rtdb.firebaseio.com';
  const STORAGE_KEY = 'wm_ruler_tracks';
  const LEGACY_STORAGE_KEY = 'wm_ruler_points';
  const VIBRO_STORAGE_KEY = 'wm_route_vibro';

  const TRACK_COLORS = [
    '#0284c7', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#06b6d4', '#ef4444', '#84cc16'
  ];

  let tracks = [];
  let activeTrackId = null;

  let isMeasuring = false;
  let isEditing = true;
  let ignoreNextMapClick = false;

  // Режим маршрутной навигации
  // Режим маршрутной навигации
  let isNavigating = false;
  let navTargetIndex = 0;

  // Настройки тактильной навигации
  let navVibroMode = 'deviation'; // 'off' | 'correct' | 'deviation'
  try {
    const savedMode = localStorage.getItem('wm_nav_vibro_mode');
    if (savedMode) {
      navVibroMode = savedMode;
    } else {
      const legacy = localStorage.getItem(VIBRO_STORAGE_KEY);
      navVibroMode = (legacy === 'false') ? 'off' : 'deviation';
    }
  } catch (e) {}

  let navVibroCone = 30; // Градусы (размер конуса)
  try {
    const savedCone = parseInt(localStorage.getItem('wm_nav_vibro_cone'), 10);
    if (!isNaN(savedCone) && savedCone >= 10 && savedCone <= 90) navVibroCone = savedCone;
  } catch (e) {}

  let navVibroInterval = 5; // Секунды (частота для режима "по курсу")
  try {
    const savedInt = parseInt(localStorage.getItem('wm_nav_vibro_interval'), 10);
    if (!isNaN(savedInt) && savedInt >= 2 && savedInt <= 30) navVibroInterval = savedInt;
  } catch (e) {}

  let offCourseStartTime = 0;
  let lastVibroAlertTime = 0;
  let lastNavCourse = null;

  // Screen Wake Lock (предотвращение засыпания экрана во время навигации)
  let wakeLockSentinel = null;

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      } catch (e) {}
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      try { wakeLockSentinel.release(); } catch (e) {}
      wakeLockSentinel = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isNavigating && !wakeLockSentinel) {
      requestWakeLock();
    }
  });

  // Слои Leaflet
  let otherTracksLayer = null;
  let activeLineLayer = null;
  let ticksLayer = null;
  let markersLayer = null;
  let midpointsLayer = null;
  let navGuideLayer = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function fmtDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function fmtEta(seconds) {
    if (!isFinite(seconds) || isNaN(seconds) || seconds <= 0) return '--:--';
    const sec = Math.round(seconds);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}ч ${m}м`;
    if (m > 0) return `${m} мин`;
    return `${s} сек`;
  }

  function computeBearing(fromLL, toLL) {
    const lat1 = fromLL.lat * Math.PI / 180;
    const lat2 = toLL.lat * Math.PI / 180;
    const dLng = (toLL.lng - fromLL.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
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

    if (tracks.length > 0) activeTrackId = tracks[0].id;
  }

  function saveStoredTracks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
      const active = getActiveTrack();
      if (active) localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(active.points));
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

  // =========================================================================
  // МАТЕМАТИКА ПРОЕКЦИИ И ОПРЕДЕЛЕНИЯ ЦЕЛЕВОГО УЗЛА МАРШРУТА
  // =========================================================================
  function projectPointToSegmentMeters(uLL, aLL, bLL) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const cosLat = Math.cos(uLL.lat * rad) || 1;

    const ax = (aLL.lng - uLL.lng) * rad * R * cosLat;
    const ay = (aLL.lat - uLL.lat) * rad * R;
    const bx = (bLL.lng - uLL.lng) * rad * R * cosLat;
    const by = (bLL.lat - uLL.lat) * rad * R;

    const abx = bx - ax;
    const aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    if (lenSq < 0.01) {
      return { t: 0, dist: Math.hypot(ax, ay) };
    }

    const t = ((-ax) * abx + (-ay) * aby) / lenSq;
    const tClamped = Math.max(0, Math.min(1, t));
    const qx = ax + tClamped * abx;
    const qy = ay + tClamped * aby;
    const dist = Math.hypot(qx, qy);

    return { t, tClamped, dist };
  }

  function findSmartInitialTargetIndex(pts, uLL) {
    if (!pts || pts.length < 2) return 0;

    const p0 = L.latLng(pts[0].lat, pts[0].lng);
    const p1 = L.latLng(pts[1].lat, pts[1].lng);
    const proj0 = projectPointToSegmentMeters(uLL, p0, p1);

    // Если находимся до первого узла и движемся к нему
    if (proj0.t <= 0.05 && uLL.distanceTo(p0) < uLL.distanceTo(p1)) {
      return 0;
    }

    let bestDist = Infinity;
    let bestSeg = 0;
    let bestT = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = L.latLng(pts[i].lat, pts[i].lng);
      const b = L.latLng(pts[i + 1].lat, pts[i + 1].lng);
      const res = projectPointToSegmentMeters(uLL, a, b);
      if (res.dist < bestDist) {
        bestDist = res.dist;
        bestSeg = i;
        bestT = res.t;
      }
    }

    // Если стоим между узлом bestSeg и bestSeg + 1, узел bestSeg уже сзади,
    // значит цель — узел bestSeg + 1 (в сторону финиша)!
    if (bestSeg === 0 && bestT <= 0.05) {
      return 0;
    }
    return Math.min(pts.length - 1, bestSeg + 1);
  }

  function getNodeArrivalRadius(pts, targetIdx) {
    const { total } = computeTrackDistances(pts);
    const norm = Math.max(0, Math.min(1, (total - 1000) / 9000));
    const baseR = 32 + norm * 108; // 32м .. 140м

    let segLen = 100;
    if (targetIdx > 0 && targetIdx < pts.length) {
      const pPrev = L.latLng(pts[targetIdx - 1].lat, pts[targetIdx - 1].lng);
      const pCur = L.latLng(pts[targetIdx].lat, pts[targetIdx].lng);
      segLen = pPrev.distanceTo(pCur);
    } else if (targetIdx === 0 && pts.length > 1) {
      const p0 = L.latLng(pts[0].lat, pts[0].lng);
      const p1 = L.latLng(pts[1].lat, pts[1].lng);
      segLen = p0.distanceTo(p1);
    }

    return Math.max(22, Math.min(baseR, segLen * 0.42));
  }

  // Интеллектуальный контроль прогресса и автопропуск пройденных узлов
  function checkAndAdvanceRouteNodes(pts, uLL) {
    const totalNodes = pts.length;
    if (navTargetIndex >= totalNodes) return false;

    let advanced = false;
    const prevTarget = navTargetIndex;

    // 1. Проверка взятия текущего целевого узла
    const targetPt = pts[navTargetIndex];
    const targetLL = L.latLng(targetPt.lat, targetPt.lng);
    const distToCur = uLL.distanceTo(targetLL);
    const arrivalRadius = getNodeArrivalRadius(pts, navTargetIndex);

    if (distToCur <= arrivalRadius) {
      navTargetIndex++;
      advanced = true;
    }

    // 2. Сканирование сегментов вперед: определяем, не ушёл ли пользователь вперёд при отключенном GPS
    const startScanSeg = Math.max(0, navTargetIndex - 1);
    let bestForwardSeg = -1;
    let minForwardDist = Infinity;

    for (let k = startScanSeg; k < totalNodes - 1; k++) {
      const aLL = L.latLng(pts[k].lat, pts[k].lng);
      const bLL = L.latLng(pts[k + 1].lat, pts[k + 1].lng);
      const proj = projectPointToSegmentMeters(uLL, aLL, bLL);
      const segArrivalR = getNodeArrivalRadius(pts, k + 1);
      const maxAllowedCorridor = Math.max(48, segArrivalR * 1.7);

      // Пользователь находится вдоль сегмента k (t >= 0.1) в пределах допустимого коридора
      if (proj.t >= 0.1 && proj.dist <= maxAllowedCorridor) {
        if (k > startScanSeg || proj.dist < minForwardDist) {
          minForwardDist = proj.dist;
          bestForwardSeg = k;
        }
      } else if (k === startScanSeg && proj.t > 1.05 && uLL.distanceTo(bLL) < uLL.distanceTo(aLL)) {
        // Перелетели целевой узел дальше по направлению
        bestForwardSeg = Math.min(totalNodes - 2, startScanSeg + 1);
      }
    }

    if (bestForwardSeg > startScanSeg) {
      const candidateTarget = Math.min(totalNodes - 1, bestForwardSeg + 1);
      if (candidateTarget > navTargetIndex) {
        navTargetIndex = candidateTarget;
        advanced = true;
      }
    }

    if (advanced) {
      const skippedCount = navTargetIndex - prevTarget;
      if (skippedCount > 0) {
        if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
        if (WM.ui && WM.ui.showToast) {
          if (navTargetIndex >= totalNodes) {
            WM.ui.showToast('🏁 Финишный узел достигнут! Маршрут завершён.', 3500);
          } else if (skippedCount > 1) {
            WM.ui.showToast(`⏩ Пройдено узлов в пути: ${skippedCount}. Цель: узел #${navTargetIndex + 1}`, 2600);
          } else {
            WM.ui.showToast(`✓ Узел #${prevTarget + 1} пройден!`, 1800);
          }
        }
      }
      return true;
    }
    return false;
  }

  // =========================================================================
  // ОТРИСОВКА КАРТЫ
  // =========================================================================
  function renderTicks() {
    if (!ticksLayer || !WM.map || isNavigating) {
      if (ticksLayer) ticksLayer.clearLayers();
      return;
    }
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
      if ((isMeasuring || isNavigating) && track.id === activeTrackId) return;
      if (!track.points || track.points.length < 2) return;

      const { total } = computeTrackDistances(track.points);
      const line = L.polyline(track.points.map(p => [p.lat, p.lng]), {
        color: track.color || '#64748b',
        weight: 3.5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: !isNavigating
      });

      if (!isNavigating) {
        line.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          ignoreNextMapClick = true;
          setTimeout(() => { ignoreNextMapClick = false; }, 250);
          activateTrack(track.id);
          if (!isMeasuring) openTool();
        });
      }
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
        interactive: !isNavigating,
        zIndexOffset: 500
      });

      if (!isNavigating) {
        badgeMarker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          ignoreNextMapClick = true;
          setTimeout(() => { ignoreNextMapClick = false; }, 250);
          activateTrack(track.id);
          if (!isMeasuring) openTool();
        });
      }
      otherTracksLayer.addLayer(badgeMarker);
    });
  }

  function renderMidpoints() {
    if (!midpointsLayer) return;
    midpointsLayer.clearLayers();
    if (!isEditing || !isMeasuring || isNavigating) return;

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
          html: `<div class="wm-ruler-midpoint-inner" style="--track-color: ${active.color};" title="Добавить узел">＋</div>`,
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
    }
  }

  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    const active = getActiveTrack();
    if (!active || !active.points) return;
    const { cumDists } = computeTrackDistances(active.points);

    active.points.forEach((p, idx) => {
      const isStart = idx === 0;
      const isEnd = idx === active.points.length - 1;
      const distText = fmtDistance(cumDists[idx]);

      if (isNavigating) {
        const isPassed = idx < navTargetIndex;
        const isTarget = idx === navTargetIndex;

        let nodeClass = 'wm-nav-vertex';
        if (isPassed) nodeClass += ' passed';
        if (isTarget) nodeClass += ' current-target';

        let innerContent = '';
        if (isPassed) {
          innerContent = '<div class="wm-nav-vertex-dot check">✓</div>';
        } else if (isTarget) {
          innerContent = `
            <div class="wm-nav-target-pulse"></div>
            <div class="wm-nav-vertex-dot target">🎯</div>
            <div class="wm-ruler-vertex-badge target-badge">${idx + 1}: ${distText}</div>
          `;
        } else {
          innerContent = `
            <div class="wm-nav-vertex-dot upcoming">${idx + 1}</div>
            <div class="wm-ruler-vertex-badge">${distText}</div>
          `;
        }

        const marker = L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: 'wm-ruler-vertex-icon ' + nodeClass,
            html: `<div class="wm-ruler-vertex-wrap nav-wrap">${innerContent}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18]
          }),
          interactive: false,
          zIndexOffset: isTarget ? 2500 : (1000 + idx)
        });
        markersLayer.addLayer(marker);
        return;
      }

      // Обычный режим линейки
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

        popupWrap.querySelector('.wm-ruler-popup-del-btn').onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          deleteThisVertex();
        };

        marker.bindPopup(popupWrap, { offset: [0, -14], closeButton: false, className: 'wm-ruler-leaflet-popup' });
        marker.on('dragstart', () => { isDragging = true; ignoreNextMapClick = true; marker.closePopup(); });
        marker.on('drag', (e) => {
          const pos = e.target.getLatLng();
          active.points[idx] = { lat: pos.lat, lng: pos.lng };
          renderPolylineOnly();
          updateHudValues();
        });
        marker.on('dragend', () => {
          saveStoredTracks(); updateDisplay();
          setTimeout(() => { isDragging = false; ignoreNextMapClick = false; }, 250);
        });
        marker.on('click', (e) => {
          if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          ignoreNextMapClick = true;
          setTimeout(() => { ignoreNextMapClick = false; }, 300);
          if (!isDragging) marker.openPopup();
        });
      }
      markersLayer.addLayer(marker);
    });
  }

  function renderPolylineOnly() {
    const active = getActiveTrack();
    if (!active || !activeLineLayer) return;

    if (isNavigating) {
      activeLineLayer.clearLayers();
      const pts = active.points.map(p => [p.lat, p.lng]);
      if (pts.length < 2) return;

      const splitIdx = Math.max(0, Math.min(pts.length - 1, navTargetIndex));

      // 1. Пройденная часть пути
      if (splitIdx > 0) {
        L.polyline(pts.slice(0, splitIdx + 1), {
          color: '#94a3b8',
          weight: 3.5,
          opacity: 0.55,
          dashArray: '5, 6',
          lineCap: 'round',
          interactive: false
        }).addTo(activeLineLayer);
      }

      // 2. Активная часть пути впереди
      if (splitIdx < pts.length) {
        L.polyline(pts.slice(Math.max(0, splitIdx - 1)), {
          color: active.color || '#0284c7',
          weight: 4.5,
          opacity: 0.95,
          lineCap: 'round',
          interactive: false
        }).addTo(activeLineLayer);
      }
      return;
    }

    if (active.points.length >= 2) {
      activeLineLayer.clearLayers();
      L.polyline(active.points.map(p => [p.lat, p.lng]), {
        color: active.color || '#0284c7',
        weight: 4,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(activeLineLayer);
    } else {
      activeLineLayer.clearLayers();
    }
  }

  function updateDisplay() {
    if (!WM.map) return;
    renderPolylineOnly();
    renderOtherTracks();
    renderTicks();
    renderMarkers();
    renderMidpoints();
    updateHudValues();
  }

  function updateHudValues() {
    const active = getActiveTrack();
    const pts = active ? active.points : [];
    const { total } = computeTrackDistances(pts);

    const playBtn = $('btn-measure-nav-play');
    if (playBtn) {
      playBtn.disabled = pts.length < 2;
      playBtn.classList.toggle('disabled', pts.length < 2);
    }

    if (isNavigating) {
      updateNavigationHUD();
      return;
    }

    const totalEl = $('measure-total-dist');
    const countEl = $('measure-points-count');
    const undoBtn = $('btn-measure-undo');
    const finishBtn = $('btn-measure-finish');
    const selectEl = $('measure-track-select');
    const dotEl = $('measure-track-color-dot');

    if (dotEl && active) dotEl.style.backgroundColor = active.color || '#0284c7';
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

  // =========================================================================
  // ЛОГИКА НАВИГАЦИИ ПО МАРШРУТУ
  // =========================================================================
  function getUserLocationLL() {
    if (WM.gpsState && WM.gpsState.lat != null && WM.gpsState.lng != null) {
      return L.latLng(WM.gpsState.lat, WM.gpsState.lng);
    }
    const dot = document.querySelector('.wm-gps-core-circle');
    if (dot && WM.map) {
      const markerWrap = dot.closest('.leaflet-marker-icon');
      if (markerWrap && markerWrap._leaflet_pos) {
        return WM.map.layerPointToLatLng(markerWrap._leaflet_pos);
      }
    }
    return null;
  }

  function startNavigation() {
    const active = getActiveTrack();
    if (!active || !active.points || active.points.length < 2) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Для навигации постройте линию хотя бы из 2 точек');
      return;
    }

    const uLL = getUserLocationLL();
    if (!uLL) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛰️ Определение геопозиции для навигации…', 2000);
      const btnLoc = $('btn-location');
      if (btnLoc) btnLoc.click();
    }

    isNavigating = true;
    isEditing = false;
    offCourseStartTime = 0;
    lastVibroAlertTime = 0;

    // Включаем бодрствование экрана
    requestWakeLock();

    // Автоматически определяем правильный начальный узел
    if (uLL) {
      navTargetIndex = findSmartInitialTargetIndex(active.points, uLL);
    } else {
      navTargetIndex = 0;
    }

    // Переключаем блоки HUD
    const editHUD = $('measure-hud-edit-mode');
    const navHUD = $('measure-hud-nav-mode');
    if (editHUD) editHUD.hidden = true;
    if (navHUD) navHUD.hidden = false;

    updateVibroBtnUI();
    updateDisplay();
    updateNavigationHUD();

    const targetNum = navTargetIndex + 1;
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`🚀 Навигация запущена к узлу #${targetNum}`, 2500);
    }
  }

  function stopNavigation() {
    if (!isNavigating) return;
    isNavigating = false;
    offCourseStartTime = 0;

    releaseWakeLock();

    if (navGuideLayer) navGuideLayer.clearLayers();

    const editHUD = $('measure-hud-edit-mode');
    const navHUD = $('measure-hud-nav-mode');
    if (editHUD) editHUD.hidden = false;
    if (navHUD) navHUD.hidden = true;

    updateDisplay();
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛑 Навигация по маршруту завершена');
  }

  function triggerNavigationVibration(signedDiff, absDiff, speed) {
    if (navVibroMode === 'off' || !navigator.vibrate) return;
    if (speed < 0.4) return;

    const now = Date.now();

    if (navVibroMode === 'correct') {
      // 1. Отклик когда движение верное (внутри конуса)
      if (absDiff <= navVibroCone) {
        if (now - lastVibroAlertTime >= navVibroInterval * 1000) {
          lastVibroAlertTime = now;
          try { navigator.vibrate(70); } catch (e) {}
        }
      }
    } else if (navVibroMode === 'deviation') {
      // 2. Отклик когда ушли с курса (снаружи конуса)
      if (absDiff > navVibroCone) {
        let minInterval = 11000;
        if (absDiff > navVibroCone * 2.5) {
          minInterval = 3500;
        } else if (absDiff > navVibroCone * 1.6) {
          minInterval = 6500;
        }

        if (now - lastVibroAlertTime < minInterval) return;
        lastVibroAlertTime = now;

        try {
          if (signedDiff < 0) {
            navigator.vibrate(220); // Влево: 1 длинный импульс
          } else {
            navigator.vibrate([130, 90, 130]); // Вправо: 2 импульса
          }
        } catch (e) {}
      }
    }
  }

  // Экспортируем менеджер наружу в глобальный объект WM
  WM.navVibro = {
    getMode: () => navVibroMode,
    setMode: (m) => {
      navVibroMode = m;
      try {
        localStorage.setItem('wm_nav_vibro_mode', m);
        localStorage.setItem(VIBRO_STORAGE_KEY, m !== 'off' ? 'true' : 'false');
      } catch (e) {}
      updateVibroBtnUI();
    },
    getCone: () => navVibroCone,
    setCone: (c) => {
      navVibroCone = c;
      try { localStorage.setItem('wm_nav_vibro_cone', c.toString()); } catch (e) {}
    },
    getInterval: () => navVibroInterval,
    setInterval: (sec) => {
      navVibroInterval = sec;
      try { localStorage.setItem('wm_nav_vibro_interval', sec.toString()); } catch (e) {}
    },
    isEnabled: () => navVibroMode !== 'off',
    triggerNavigationVibration
  };

  function toggleVibration() {
    if (!WM.navVibro) return;
    const curMode = WM.navVibro.getMode();
    if (curMode === 'off') {
      const lastActive = localStorage.getItem('wm_nav_vibro_last_active') || 'deviation';
      WM.navVibro.setMode(lastActive);
      if (navigator.vibrate) navigator.vibrate(100);
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(lastActive === 'correct' ? '📳 Виброотклик «По курсу» включён' : '📳 Виброотклик «Уход с курса» включён');
      }
    } else {
      localStorage.setItem('wm_nav_vibro_last_active', curMode);
      WM.navVibro.setMode('off');
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🔕 Виброотклик отключён');
    }
    updateVibroBtnUI();
  }

  function updateVibroBtnUI() {
    const btn = $('btn-measure-nav-vibro');
    if (!btn) return;
    const isEn = WM.navVibro ? WM.navVibro.isEnabled() : false;
    btn.textContent = isEn ? '📳' : '🔕';
    btn.classList.toggle('active', isEn);
    const mode = WM.navVibro ? WM.navVibro.getMode() : 'off';
    btn.title = isEn 
      ? (mode === 'correct' ? 'Виброотклик «По курсу» (нажмите для выкл)' : 'Виброотклик «Уход с курса» (нажмите для выкл)') 
      : 'Виброотклик выключен (нажмите для вкл)';
  }

  function executeDeviationVibration(signedDiff, absDiff) {
    if (!navVibroEnabled || !navigator.vibrate) return;
    const now = Date.now();

    let minInterval = 13000;
    if (absDiff > 110) {
      minInterval = 3800;
    } else if (absDiff > 65) {
      minInterval = 7500;
    }

    if (now - lastVibroAlertTime < minInterval) return;
    lastVibroAlertTime = now;

    if (signedDiff < 0) {
      navigator.vibrate(220); // Влево: один импульс
    } else {
      navigator.vibrate([130, 90, 130]); // Вправо: двойной импульс
    }
  }

  function updateNavigationHUD() {
    if (!isNavigating) return;
    const active = getActiveTrack();
    if (!active || !active.points || !active.points.length) return;

    const uLL = getUserLocationLL();
    const pts = active.points;
    const totalNodes = pts.length;

    // Автопроверка и автопропуск пройденных узлов при каждом обновлении геопозиции
    if (uLL) {
      const advanced = checkAndAdvanceRouteNodes(pts, uLL);
      if (advanced) {
        updateDisplay();
        return;
      }
    }

    // Финиш достигнут
    if (navTargetIndex >= totalNodes) {
      if (navGuideLayer) navGuideLayer.clearLayers();
      const titleEl = $('measure-nav-target-title');
      if (titleEl) titleEl.textContent = '🏁 Маршрут пройден!';
      const distNodeEl = $('measure-nav-dist-node');
      if (distNodeEl) distNodeEl.textContent = '0 м';
      const distTotalEl = $('measure-nav-dist-total');
      if (distTotalEl) distTotalEl.textContent = '0 м';
      const driftEl = $('measure-nav-drift-text');
      if (driftEl) driftEl.textContent = 'Финиш';
      return;
    }

    const targetPt = pts[navTargetIndex];
    const targetLL = L.latLng(targetPt.lat, targetPt.lng);

    const titleEl = $('measure-nav-target-title');
    if (titleEl) {
      titleEl.textContent = `🎯 Узел ${navTargetIndex + 1} из ${totalNodes}`;
    }

    let distToNode = 0;
    let distToTotal = 0;
    let bearingToNode = 0;

    if (uLL) {
      distToNode = uLL.distanceTo(targetLL);
      distToTotal = distToNode;
      for (let k = navTargetIndex; k < totalNodes - 1; k++) {
        const pA = L.latLng(pts[k].lat, pts[k].lng);
        const pB = L.latLng(pts[k + 1].lat, pts[k + 1].lng);
        distToTotal += pA.distanceTo(pB);
      }
      bearingToNode = computeBearing(uLL, targetLL);
    }

    const distNodeEl = $('measure-nav-dist-node');
    if (distNodeEl) distNodeEl.textContent = fmtDistance(distToNode);

    const distTotalEl = $('measure-nav-dist-total');
    if (distTotalEl) distTotalEl.textContent = fmtDistance(distToTotal);

    const speed = (WM.gpsState && WM.gpsState.speed != null && WM.gpsState.speed >= 0) ? WM.gpsState.speed : 0;
    const speedKmh = speed * 3.6;
    const speedEl = $('measure-nav-speed');
    if (speedEl) speedEl.textContent = `${speedKmh.toFixed(1)} км/ч`;

    let etaNode = '--:--';
    let etaTotal = '--:--';
    const effectiveSpeed = speed >= 0.4 ? speed : 1.35;

    if (distToNode > 0) etaNode = fmtEta(distToNode / effectiveSpeed);
    if (distToTotal > 0) etaTotal = fmtEta(distToTotal / effectiveSpeed);

    const etaNodeEl = $('measure-nav-eta-node');
    if (etaNodeEl) etaNodeEl.textContent = `ETA: ${etaNode}`;

    const etaTotalEl = $('measure-nav-eta-total');
    if (etaTotalEl) etaTotalEl.textContent = `Финиш: ${etaTotal}`;

    let driftText = 'Стоянка';
    let driftSub = 'Ожидание шага';
    let signedDiff = 0;
    let absDiff = 0;
    let guideColor = '#0284c7';

    let course = (WM.motionVector && WM.motionVector.getCourse) ? WM.motionVector.getCourse() : null;
    if (course === null && WM.gpsState && WM.gpsState.heading != null && !isNaN(WM.gpsState.heading)) {
      course = WM.gpsState.heading;
    }
    if (course !== null) lastNavCourse = course;


    const cone = WM.navVibro ? WM.navVibro.getCone() : 30;

    if (uLL && lastNavCourse !== null && speed >= 0.45) {
      signedDiff = ((lastNavCourse - bearingToNode + 540) % 360) - 180;
      absDiff = Math.abs(signedDiff);

      if (absDiff <= cone) {
        driftText = '🟢 По курсу';
        driftSub = `Азимут: ${Math.round(bearingToNode)}°`;
        guideColor = '#10b981';
        offCourseStartTime = 0;
      } else {
        const sideText = signedDiff > 0 ? 'вправо' : 'влево';
        driftText = `Крен ${sideText} ${Math.round(absDiff)}°`;
        guideColor = absDiff > (cone * 1.8) ? '#ef4444' : '#f59e0b';

        const now = Date.now();
        if (!offCourseStartTime) {
          offCourseStartTime = now;
        }

        const elapsedOffCourse = Math.floor((now - offCourseStartTime) / 1000);
        if (elapsedOffCourse < 15) {
          driftSub = `Проверка уклона: ${15 - elapsedOffCourse}с`;
        } else {
          driftSub = `⚠️ Уход с курса (${elapsedOffCourse}с)`;
        }
      }

      // Вызов тактильного отклика с учётом выбранного режима (по курсу / уход / выкл)
      if (WM.navVibro) {
        WM.navVibro.triggerNavigationVibration(signedDiff, absDiff, speed);
      }
    } else {
      offCourseStartTime = 0;
      if (uLL) driftSub = `Азимут: ${Math.round(bearingToNode)}°`;
    }

    const driftEl = $('measure-nav-drift-text');
    if (driftEl) {
      driftEl.textContent = driftText;
      driftEl.style.color = (absDiff > 35 && speed >= 0.45) ? guideColor : '';
    }

    const driftSubEl = $('measure-nav-drift-sub');
    if (driftSubEl) driftSubEl.textContent = driftSub;

    const statusSubEl = $('measure-nav-status-sub');
    if (statusSubEl) {
      statusSubEl.textContent = uLL ? (speed >= 0.45 ? 'Движение' : 'Остановка') : 'Поиск GPS…';
    }

    if (navGuideLayer) {
      navGuideLayer.clearLayers();
      if (uLL) {
        L.polyline([uLL, targetLL], {
          pane: 'wm-top-lines',
          color: guideColor,
          weight: 3.5,
          dashArray: '6, 6',
          opacity: 0.9,
          interactive: false
        }).addTo(navGuideLayer);
      }
    }
  }

  // =========================================================================
  // ОСНОВНЫЕ МЕТОДЫ И ИНИЦИАЛИЗАЦИЯ
  // =========================================================================
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
    if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📏 Создано: ${newTrack.name}`);
  }

  function renameCurrentTrack() {
    const active = getActiveTrack();
    if (!active) return;
    const newName = prompt('Название измерения:', active.name);
    if (newName && newName.trim()) {
      active.name = newName.trim();
      saveStoredTracks();
      updateDisplay();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`Переименовано в «${active.name}»`);
    }
  }

  function onMapClick(latlng) {
    if (!isMeasuring || !isEditing || ignoreNextMapClick || isNavigating) return;
    const active = getActiveOrCreateTrack();
    active.points.push({ lat: latlng.lat, lng: latlng.lng });
    saveStoredTracks();
    updateDisplay();
  }

  function undoLastPoint() {
    if (isNavigating) return;
    const active = getActiveTrack();
    if (!active || !active.points.length) return;
    active.points.pop();
    saveStoredTracks();
    updateDisplay();
  }

  function deleteCurrentTrack() {
    if (isNavigating) stopNavigation();
    const active = getActiveTrack();
    if (!active) return;
    if (active.points.length > 0 && !confirm(`Удалить измерение «${active.name}»?`)) return;

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
    if (isNavigating) return;
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
    if (isNavigating) stopNavigation();
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
      activeLineLayer = L.layerGroup().addTo(WM.map);
      navGuideLayer = L.layerGroup().addTo(WM.map);
      midpointsLayer = L.layerGroup().addTo(WM.map);
      markersLayer = L.layerGroup().addTo(WM.map);

      let tickDebounceTimer = null;
      WM.map.on('zoomend', () => {
        clearTimeout(tickDebounceTimer);
        tickDebounceTimer = setTimeout(renderTicks, 150);
      });

      // Привязка кнопок панели
      $('btn-measure')?.addEventListener('click', toggleTool);
      $('btn-measure-undo')?.addEventListener('click', undoLastPoint);
      $('btn-measure-clear')?.addEventListener('click', deleteCurrentTrack);
      $('btn-measure-finish')?.addEventListener('click', toggleEditing);
      $('btn-measure-close')?.addEventListener('click', closeTool);
      $('btn-measure-new')?.addEventListener('click', createNewTrack);
      $('btn-measure-rename')?.addEventListener('click', renameCurrentTrack);

      const trackSelect = $('measure-track-select');
      if (trackSelect) trackSelect.onchange = (e) => activateTrack(e.target.value);

      // Кнопки навигации
      $('btn-measure-nav-play')?.addEventListener('click', startNavigation);
      $('btn-measure-nav-stop')?.addEventListener('click', stopNavigation);
      $('btn-measure-nav-vibro')?.addEventListener('click', toggleVibration);
      $('btn-measure-nav-recenter')?.addEventListener('click', () => {
        const uLL = getUserLocationLL();
        if (uLL && WM.map) {
          WM.map.panTo(uLL);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛰️ Центрирование на GPS');
        } else {
          $('btn-location')?.click();
        }
      });

      updateVibroBtnUI();

      if (tracks.some(t => t.points && t.points.length > 0)) {
        isEditing = false;
        updateDisplay();
      }
    },

    isActive() { return isMeasuring && isEditing && !isNavigating; },
    isToolOpen() { return isMeasuring || isNavigating; },
    isNavigating() { return isNavigating; },
    onMapClick,
    openTool,
    closeTool,
    startNavigation,
    stopNavigation,

    onGpsUpdate(ll, coords) {
      if (isNavigating) {
        updateNavigationHUD();
      }
    },

    onMapMove() {
      if (isNavigating) {
        updateNavigationHUD();
      }
    },

    exportData() {
      return JSON.parse(JSON.stringify(tracks));
    },

    clearAll() {
      if (isNavigating) stopNavigation();
      tracks = [];
      activeTrackId = null;
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (e) {}
      if (isMeasuring) closeTool();
      else updateDisplay();
    },

    importData(importedData) {
      if (!Array.isArray(importedData)) return;
      if (isNavigating) stopNavigation();

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