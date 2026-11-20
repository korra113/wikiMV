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
  let probeMapMarker = null;

  let profileWidget = null;
  let lastLiveFetchTime = 0;

  function is3dMode() {
    return !!(WM.demRelief && WM.demRelief.isActive && WM.demRelief.isActive());
  }

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

  function createBadgeIcon(text, is3d) {
    const tag = is3d ? '⛰️' : '📐';
    return L.divIcon({
      className: 'wm-qm-badge-wrap',
      html: `<div class="wm-qm-badge">${tag} ${text}</div>`,
      iconSize: [130, 24],
      iconAnchor: [65, 28]
    });
  }

  function updateProbeMarkerOnMap(pt) {
    if (!layerGroup || !pt || !isEnabled) {
      if (probeMapMarker && layerGroup) {
        layerGroup.removeLayer(probeMapMarker);
        probeMapMarker = null;
      }
      return;
    }
    if (!probeMapMarker) {
      probeMapMarker = L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({
          className: 'wm-measure-probe-icon',
          html: '<div class="wm-measure-probe-marker"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        }),
        interactive: false,
        zIndexOffset: 1400
      }).addTo(layerGroup);
    } else {
      probeMapMarker.setLatLng([pt.lat, pt.lng]);
    }
  }

  function hideProfileUI() {
    const hud = $('quick-measure-hud');
    if (hud) hud.classList.remove('has-profile');
    if (profileWidget) profileWidget.hide();
    updateProbeMarkerOnMap(null);
  }

  function updateHUD(distMeters, hint, is3dUsed) {
    const distEl = $('qm-hud-dist');
    const hintEl = $('qm-hud-hint');
    if (distEl) {
      distEl.innerHTML = (distMeters !== null ? fmtDist(distMeters) : '0 м') +
        (is3dUsed ? '<span class="mp-3d-pill">3D</span>' : '');
    }
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

    // 2. Вторая точка
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

    // 3. Линия, 3D-расчет и профиль рельефа
    if (p1 && currentP2) {
      const horizDist = p1.distanceTo(currentP2);
      let displayDist = horizDist;
      let is3dActiveNow = is3dMode();
      let profile = null;

      if (is3dActiveNow && WM.demRelief.sampleProfile) {
        const pts = [
          { lat: p1.lat, lng: p1.lng },
          { lat: currentP2.lat, lng: currentP2.lng }
        ];
        profile = WM.demRelief.sampleProfile(pts, { maxSamples: 64 });
        if (profile && profile.hasData) {
          displayDist = profile.total3d;
        }
        // Догружаем недостающие тайлы (ограничиваем частоту при живом перетаскивании)
        const now = performance.now();
        if (profile && profile.isPartial && (p2 || now - lastLiveFetchTime > 600)) {
          lastLiveFetchTime = now;
          WM.demRelief.prefetchPathDem(pts, map.getZoom(), () => {
            if (isEnabled) updateVisuals(p2 ? null : (getMode() === 'cross' ? map.getCenter() : null));
          });
        }
      }

      const midLatLng = L.latLng((p1.lat + currentP2.lat) / 2, (p1.lng + currentP2.lng) / 2);

      if (!polyline) {
        polyline = L.polyline([p1, currentP2], {
          color: '#38bdf8',
          weight: 3.5,
          dashArray: p2 ? null : '6, 6',
          opacity: 0.95,
          interactive: false
        }).addTo(layerGroup);
      } else {
        polyline.setLatLngs([p1, currentP2]);
        polyline.setStyle({ dashArray: p2 ? null : '6, 6' });
      }

      if (!badgeMarker) {
        badgeMarker = L.marker(midLatLng, {
          icon: createBadgeIcon(fmtDist(displayDist), is3dActiveNow && profile && profile.hasData),
          interactive: false,
          zIndexOffset: 1300
        }).addTo(layerGroup);
      } else {
        badgeMarker.setLatLng(midLatLng);
        badgeMarker.setIcon(createBadgeIcon(fmtDist(displayDist), is3dActiveNow && profile && profile.hasData));
      }

      const hintText = p2
        ? 'Точки зафиксированы (можно двигать)'
        : (getMode() === 'cross' ? 'Наведите перекрестие и нажмите для фиксации' : 'Укажите точку B');
      updateHUD(displayDist, hintText, is3dActiveNow && profile && profile.hasData);

      const hud = $('quick-measure-hud');
      if (is3dActiveNow && profile && profileWidget) {
        if (hud) hud.classList.add('has-profile');
        const probePt = profileWidget.render(profile, '#38bdf8');
        updateProbeMarkerOnMap(probePt);
      } else {
        hideProfileUI();
      }
    } else {
      if (polyline) { layerGroup.removeLayer(polyline); polyline = null; }
      if (badgeMarker) { layerGroup.removeLayer(badgeMarker); badgeMarker = null; }
      hideProfileUI();

      if (p1) {
        updateHUD(0, getMode() === 'cross' ? 'Двигайте карту: линия тянется к прицелу' : 'Нажмите на карту для точки B', false);
      } else {
        updateHUD(0, getMode() === 'cross' ? 'Нажмите в любом месте для точки A' : 'Нажмите на карту для точки A', false);
      }
    }
  }

  let _moveRaf = 0;
  function onMapMove() {
    if (!isEnabled || !p1 || p2) return;
    if (getMode() === 'cross') {
      if (_moveRaf) return;
      _moveRaf = requestAnimationFrame(() => {
        _moveRaf = 0;
        if (isEnabled && p1 && !p2) updateVisuals(map.getCenter());
      });
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
    probeMapMarker = null;
    if (profileWidget) profileWidget.resetProbe();
    hideProfileUI();
    updateHUD(0, getMode() === 'cross' ? 'Нажмите в любом месте для точки A' : 'Нажмите на карту для точки A', false);
  }

  function openTool() {
    if (WM.measure && WM.measure.closeTool) WM.measure.closeTool();
    if (WM.shadowHeight && WM.shadowHeight.closeTool) WM.shadowHeight.closeTool();

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
      p1 = latlng;
      updateVisuals(getMode() === 'cross' ? map.getCenter() : null);
    } else if (!p2) {
      p2 = latlng;
      updateVisuals();
    } else {
      p1 = latlng;
      p2 = null;
      if (profileWidget) profileWidget.resetProbe();
      updateVisuals(getMode() === 'cross' ? map.getCenter() : null);
    }
  }

  WM.quickMeasure = {
    init(m) {
      map = m;
      layerGroup = L.layerGroup().addTo(map);

      if (WM.demRelief && WM.demRelief.createProfileWidget) {
        profileWidget = WM.demRelief.createProfileWidget({
          panel: 'qm-profile-panel',
          wrap: 'qm-chart-wrap',
          area: 'qm-profile-area',
          line: 'qm-profile-line',
          probeLine: 'qm-probe-line',
          probeDot: 'qm-probe-dot',
          minLbl: 'qm-chart-min',
          maxLbl: 'qm-chart-max',
          loading: 'qm-chart-loading',
          info: 'qm-profile-info'
        });
        profileWidget.bind((pt) => updateProbeMarkerOnMap(pt));
      }

      window.addEventListener('wm:dem-change', () => {
        if (isEnabled && p1) {
          updateVisuals(p2 ? null : (getMode() === 'cross' ? map.getCenter() : null));
        }
      });

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