(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  let map = null;
  let isEnabled = false;
  let p1 = null; // L.LatLng первой точки
  let p2 = null; // L.LatLng второй точки

  // Слои Leaflet
  let layerGroup = null;
  let polyline = null;
  let marker1 = null;
  let marker2 = null;
  let badgeMarker = null;

  function fmtDist(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function getMode() {
    return (WM.picker && WM.picker.getMode) ? WM.picker.getMode() : 'cross';
  }

  function createPointIcon(label, color) {
    return L.divIcon({
      className: 'wm-qm-marker',
      html: `
        <div class="wm-qm-pin" style="--qm-color: ${color};">
          <div class="wm-qm-dot">${label}</div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  function createBadgeIcon(text) {
    return L.divIcon({
      className: 'wm-qm-badge-wrap',
      html: `<div class="wm-qm-badge">📐 ${text}</div>`,
      iconSize: [120, 24],
      iconAnchor: [60, 28]
    });
  }

  function updateHUD(distMeters, hint) {
    const distEl = $('qm-hud-dist');
    const hintEl = $('qm-hud-hint');
    if (distEl) distEl.textContent = distMeters !== null ? fmtDist(distMeters) : '0 м';
    if (hintEl) hintEl.textContent = hint || '';
  }

  function updateVisuals(targetP2 = null) {
    if (!map || !layerGroup) return;

    const currentP2 = p2 || targetP2;

    // 1. Первая точка
    if (p1) {
      if (!marker1) {
        marker1 = L.marker(p1, {
          icon: createPointIcon('A', '#10b981'),
          draggable: true,
          zIndexOffset: 1200
        }).addTo(layerGroup);

        marker1.on('drag', (e) => {
          p1 = e.target.getLatLng();
          updateVisuals(p2 ? null : (getMode() === 'cross' ? map.getCenter() : null));
        });
      } else {
        marker1.setLatLng(p1);
      }
    } else if (marker1) {
      layerGroup.removeLayer(marker1);
      marker1 = null;
    }

    // 2. Вторая точка (создается только при фиксации p2)
    if (p2) {
      if (!marker2) {
        marker2 = L.marker(p2, {
          icon: createPointIcon('B', '#ef4444'),
          draggable: true,
          zIndexOffset: 1200
        }).addTo(layerGroup);

        marker2.on('drag', (e) => {
          p2 = e.target.getLatLng();
          updateVisuals();
        });
      } else {
        marker2.setLatLng(p2);
      }
    } else if (marker2) {
      layerGroup.removeLayer(marker2);
      marker2 = null;
    }

    // 3. Линия и бейдж дистанции
    if (p1 && currentP2) {
      const dist = p1.distanceTo(currentP2);
      const midLatLng = L.latLng((p1.lat + currentP2.lat) / 2, (p1.lng + currentP2.lng) / 2);

      if (!polyline) {
        polyline = L.polyline([p1, currentP2], {
          color: '#38bdf8',
          weight: 3.5,
          dashArray: p2 ? null : '6, 6', // Пунктир, пока точка B движется за прицелом
          opacity: 0.95,
          interactive: false
        }).addTo(layerGroup);
      } else {
        polyline.setLatLngs([p1, currentP2]);
        polyline.setStyle({ dashArray: p2 ? null : '6, 6' });
      }

      if (!badgeMarker) {
        badgeMarker = L.marker(midLatLng, {
          icon: createBadgeIcon(fmtDist(dist)),
          interactive: false,
          zIndexOffset: 1300
        }).addTo(layerGroup);
      } else {
        badgeMarker.setLatLng(midLatLng);
        badgeMarker.setIcon(createBadgeIcon(fmtDist(dist)));
      }

      const hintText = p2
        ? 'Точки зафиксированы (можно двигать)'
        : (getMode() === 'cross' ? 'Наведите перекрестие и нажмите для фиксации' : 'Укажите точку B');
      updateHUD(dist, hintText);
    } else {
      if (polyline) { layerGroup.removeLayer(polyline); polyline = null; }
      if (badgeMarker) { layerGroup.removeLayer(badgeMarker); badgeMarker = null; }

      if (p1) {
        updateHUD(0, getMode() === 'cross' ? 'Двигайте карту: линия тянется к прицелу' : 'Нажмите на карту для точки B');
      } else {
        updateHUD(0, getMode() === 'cross' ? 'Нажмите в любом месте для точки A' : 'Нажмите на карту для точки A');
      }
    }
  }

  function onMapMove() {
    if (!isEnabled || !p1 || p2) return;
    if (getMode() === 'cross') {
      updateVisuals(map.getCenter());
    }
  }

  function clearPoints() {
    p1 = null;
    p2 = null;
    if (layerGroup) layerGroup.clearLayers();
    polyline = null;
    marker1 = null;
    marker2 = null;
    badgeMarker = null;
    updateHUD(0, getMode() === 'cross' ? 'Нажмите в любом месте для точки A' : 'Нажмите на карту для точки A');
  }

  function openTool() {
    if (WM.measure && WM.measure.closeTool) WM.measure.closeTool();
    if (WM.shadowHeight && WM.shadowHeight.closeTool) WM.shadowHeight.closeTool(); // <-- ДОБАВИТЬ

    isEnabled = true;
    const btn = $('btn-quick-measure');
    if (btn) btn.classList.add('active');

    const hud = $('quick-measure-hud');
    if (hud) hud.hidden = false;

    clearPoints();
    map.on('move', onMapMove);

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(getMode() === 'cross'
        ? '📐 Быстрое измерение: наведите прицел и нажмите для точки A'
        : '📐 Быстрое измерение: кликните по карте для точки A', 2200);
    }
  }

  function closeTool() {
    isEnabled = false;
    const btn = $('btn-quick-measure');
    if (btn) btn.classList.remove('active');

    const hud = $('quick-measure-hud');
    if (hud) hud.hidden = true;

    if (map) map.off('move', onMapMove);
    clearPoints();
  }

  function toggleTool() {
    if (isEnabled) closeTool();
    else openTool();
  }

  function onMapClick(latlng) {
    if (!isEnabled) return;

    if (!p1) {
      // 1. Ставим первую точку A
      p1 = latlng;
      if (getMode() === 'cross') {
        updateVisuals(map.getCenter());
      } else {
        updateVisuals();
      }
    } else if (!p2) {
      // 2. Ставим вторую точку B
      p2 = latlng;
      updateVisuals();
    } else {
      // Если уже стоят 2 точки — новый клик начинает новое измерение с точки A
      p1 = latlng;
      p2 = null;
      if (getMode() === 'cross') {
        updateVisuals(map.getCenter());
      } else {
        updateVisuals();
      }
    }
  }

  WM.quickMeasure = {
    init(m) {
      map = m;
      layerGroup = L.layerGroup().addTo(map);

      const btnToggle = $('btn-quick-measure');
      if (btnToggle) btnToggle.onclick = toggleTool;

      const btnClear = $('qm-btn-clear');
      if (btnClear) btnClear.onclick = clearPoints;

      const btnClose = $('qm-btn-close');
      if (btnClose) btnClose.onclick = closeTool;
    },
    isActive() { return isEnabled; },
    openTool,
    closeTool,
    clearPoints,
    onMapClick
  };
})();