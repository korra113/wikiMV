(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  let map = null;
  let isEnabled = false;
  let p1 = null; // Основание объекта (A)
  let p2 = null; // Кончик тени (B)
  function getDefaultMeasureDate() {
    // 6 — это июль (0 = январь), 15 число, 10 часов, 0 минут
    return new Date(new Date().getFullYear(), 6, 15, 10, 0, 0);
  }

  let measureDate = getDefaultMeasureDate();

  // Leaflet-слои
  let layerGroup = null;
  let polyline = null;
  let marker1 = null;
  let marker2 = null;
  let badgeMarker = null;

  function fmtDist(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return (meters < 10 ? meters.toFixed(1) : Math.round(meters)) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function getMode() {
    return (WM.picker && WM.picker.getMode) ? WM.picker.getMode() : 'cross';
  }

  // Расчёт азимута между двумя точками (в градусах от севера 0..360°)
  function calculateBearing(from, to) {
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const dLng = (to.lng - from.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function createPointIcon(label, color, sublabel) {
    return L.divIcon({
      className: 'wm-sh-marker',
      html: `
        <div class="wm-sh-pin" style="--sh-color: ${color};">
          <div class="wm-sh-dot">${label}</div>
          <span class="wm-sh-pin-label">${sublabel}</span>
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });
  }

  function createBadgeIcon(heightText, shadowText) {
    return L.divIcon({
      className: 'wm-sh-badge-wrap',
      html: `
        <div class="wm-sh-badge">
          <span class="wm-sh-badge-h">🏢 ${heightText}</span>
          <span class="wm-sh-badge-s">тень: ${shadowText}</span>
        </div>
      `,
      iconSize: [130, 36],
      // [65, 52] центрирует по горизонтали и сдвигает плашку на 52px ВВЕРХ над точкой B
      iconAnchor: [65, 52]
    });
  }

  // Форматирование даты в формат для <input type="datetime-local">
  function toDateTimeLocalString(date) {
    const pad = n => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${y}-${m}-${d}T${h}:${min}`;
  }

  function updateHUD(data = null) {
    const valEl = $('sh-hud-val');
    const hintEl = $('sh-hud-hint');
    const floorsEl = $('sh-hud-floors');
    const inputEl = $('sh-datetime-input');

    if (inputEl && !inputEl.matches(':focus')) {
      inputEl.value = toDateTimeLocalString(measureDate);
    }

    if (!data) {
      if (valEl) valEl.textContent = '0 м';
      if (floorsEl) floorsEl.textContent = '';
      if (hintEl) {
        hintEl.textContent = p1
          ? (getMode() === 'cross' ? 'Наведите перекрестие на кончик тени (B)' : 'Укажите кончик тени (B)')
          : (getMode() === 'cross' ? 'Наведите на основание (A) · Выставите дату снимка в поле выше' : 'Укажите основание (A) · Выставите дату снимка в поле выше');
      }
      return;
    }

    const { height, shadowLen, sunAltDeg, sunAzDeg, shadowBearing, isSunBelowHorizon } = data;

    if (isSunBelowHorizon) {
      if (valEl) valEl.textContent = 'Ночь (Солнце за горизонтом)';
      if (floorsEl) floorsEl.textContent = '';
      if (hintEl) hintEl.textContent = `Высота солнца: ${sunAltDeg.toFixed(1)}° — измените время на дневное`;
      return;
    }

    if (valEl) valEl.textContent = `~${height < 10 ? height.toFixed(1) : Math.round(height)} м`;

    if (floorsEl) {
      const floors = Math.max(1, Math.round(height / 3.2));
      floorsEl.textContent = height >= 3 ? `(~${floors} эт.)` : '';
    }

    if (hintEl) {
      const diffAz = Math.abs(((shadowBearing - ((sunAzDeg + 180) % 360) + 540) % 360) - 180);
      const azQuality = diffAz < 15 ? '🟢 совпадает' : (diffAz < 35 ? '🟡 близко' : '⚠️ не совпадает');
      hintEl.textContent = `Тень: ${fmtDist(shadowLen)} · ☀️ Солнце: ${sunAltDeg.toFixed(1)}° (азимут: ${Math.round(sunAzDeg)}°, тень: ${Math.round(shadowBearing)}° [${azQuality}])`;
    }
  }

  function calculateGeometry(pointA, pointB) {
    if (!window.SunCalc) return null;

    const sunPos = SunCalc.getPosition(measureDate, pointA.lat, pointA.lng);
    const sunAltRad = sunPos.altitude;
    const sunAltDeg = sunAltRad * (180 / Math.PI);
    const sunAzDeg = ((sunPos.azimuth * 180 / Math.PI + 180) % 360);

    const shadowLen = pointA.distanceTo(pointB);
    const shadowBearing = calculateBearing(pointA, pointB);

    if (sunAltRad <= 0.001) {
      return {
        height: 0,
        shadowLen,
        sunAltDeg,
        sunAzDeg,
        shadowBearing,
        isSunBelowHorizon: true
      };
    }

    // Основная формула: H = L * tan(alpha)
    const height = shadowLen * Math.tan(sunAltRad);

    return {
      height,
      shadowLen,
      sunAltDeg,
      sunAzDeg,
      shadowBearing,
      isSunBelowHorizon: false
    };
  }

  function updateVisuals(targetP2 = null) {
    if (!map || !layerGroup) return;

    const currentP2 = p2 || targetP2;

    // 1. Точка A (основание)
    if (p1) {
      if (!marker1) {
        marker1 = L.marker(p1, {
          icon: createPointIcon('A', '#0284c7', 'Основание'),
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

    // 2. Точка B (кончик тени)
    if (p2) {
      if (!marker2) {
        marker2 = L.marker(p2, {
          icon: createPointIcon('B', '#f59e0b', 'Тень'),
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

    // 3. Линия и бейдж
    if (p1 && currentP2) {
      const calcData = calculateGeometry(p1, currentP2);
      
      // БЫЛО: const midLatLng = L.latLng((p1.lat + currentP2.lat) / 2, (p1.lng + currentP2.lng) / 2);
      // СТАЛО: плашка ставится строго над второй точкой (кончиком тени)
      const badgeTargetLatLng = currentP2;

      if (!polyline) {
        polyline = L.polyline([p1, currentP2], {
          color: '#f59e0b',
          weight: 3.5,
          dashArray: p2 ? null : '6, 6',
          opacity: 0.95,
          interactive: false
        }).addTo(layerGroup);
      } else {
        polyline.setLatLngs([p1, currentP2]);
        polyline.setStyle({ dashArray: p2 ? null : '6, 6' });
      }

      const hText = calcData && !calcData.isSunBelowHorizon
        ? `~${calcData.height < 10 ? calcData.height.toFixed(1) : Math.round(calcData.height)} м`
        : 'Ночь';
      const sText = fmtDist(p1.distanceTo(currentP2));

      if (!badgeMarker) {
        badgeMarker = L.marker(badgeTargetLatLng, {
          icon: createBadgeIcon(hText, sText),
          interactive: false,
          zIndexOffset: 1400
        }).addTo(layerGroup);
      } else {
        badgeMarker.setLatLng(badgeTargetLatLng);
        badgeMarker.setIcon(createBadgeIcon(hText, sText));
      }

      updateHUD(calcData);
    } else {
      if (polyline) { layerGroup.removeLayer(polyline); polyline = null; }
      if (badgeMarker) { layerGroup.removeLayer(badgeMarker); badgeMarker = null; }
      updateHUD(null);
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
    updateHUD(null);
  }

  function changeTimeHours(deltaHours) {
    measureDate = new Date(measureDate.getTime() + deltaHours * 3600 * 1000);
    updateVisuals();
  }

  function resetTimeToNow() {
    measureDate = new Date();
    updateVisuals();
  }

  function openTool() {
    if (WM.quickMeasure && WM.quickMeasure.closeTool) WM.quickMeasure.closeTool();
    if (WM.measure && WM.measure.closeTool) WM.measure.closeTool();

    isEnabled = true;
    const hud = $('shadow-height-hud');
    if (hud) hud.hidden = false;

    clearPoints();
    map.on('move', onMapMove);

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(getMode() === 'cross'
        ? '🏢 Измерение высоты: наведите перекрестие на основание объекта (A)'
        : '🏢 Измерение высоты: укажите основание объекта (A)', 2400);
    }
  }

  function closeTool() {
    isEnabled = false;
    const hud = $('shadow-height-hud');
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
      updateVisuals(getMode() === 'cross' ? map.getCenter() : null);
    }
  }

  WM.shadowHeight = {
    init(m) {
      map = m;
      layerGroup = L.layerGroup().addTo(map);

      const btnClear = $('sh-btn-clear');
      if (btnClear) btnClear.onclick = clearPoints;

      const btnClose = $('sh-btn-close');
      if (btnClose) btnClose.onclick = closeTool;

      const btnMinus1h = $('sh-btn-time-minus1h');
      if (btnMinus1h) btnMinus1h.onclick = () => changeTimeHours(-1);

      const btnPlus1h = $('sh-btn-time-plus1h');
      if (btnPlus1h) btnPlus1h.onclick = () => changeTimeHours(1);

      const btnNow = $('sh-btn-time-now');
      if (btnNow) btnNow.onclick = resetTimeToNow;

      const inputDt = $('sh-datetime-input');
      if (inputDt) {
        inputDt.onchange = (e) => {
          const val = e.target.value;
          if (val) {
            measureDate = new Date(val);
            updateVisuals();
          }
        };
      }
    },
    isActive() { return isEnabled; },
    openTool,
    closeTool,
    toggleTool,
    clearPoints,
    onMapClick
  };
})();