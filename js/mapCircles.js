/* =============================================================================
 * WM.mapCircles — Постоянные географические круги дальности на карте (зум 12+)
 * Оптимизированная версия: viewport culling, предрасчёт геометрии, zero-thrash драг
 * ========================================================================== */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  const STORAGE_KEY = 'wm_map_circles_v1';
  const MAX_CIRCLES = 50;
  const MIN_ZOOM_DEFAULT = 12;
  const MIN_RADIUS_M = 10;
  const MAX_RADIUS_M = 200000;
  const SLIDER_MIN_M = 50;
  const SLIDER_MAX_M = 50000;

  const R_EARTH = 6371008.8;
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  const DEFAULT_CIRCLE_STYLE = {
    color: '#3b82f6',
    innerColor: '#ffffff',
    opacity: 0.75,
    innerOpacity: 0.45,
    fillOpacity: 0,
    weight: 1.5,
    innerDash: '4, 5',
    divisions: 4,
    labelPos: 'N',
    labelStyle: 'audibility',
    labelSize: 'md',
    labelColor: '#ffffff',
    showCenterLabel: true,
    showAxes: false,
    minZoom: MIN_ZOOM_DEFAULT
  };

  let map = null;
  let circles = [];
  let activeCircleId = null;

  let isOpen = false;
  let isEditing = true;
  let isSettingsExpanded = true;
  let ignoreNextMapClick = false;
  let lastRenderSignature = '';
  let saveTimer = 0;

  // Слои Leaflet
  const circlesPaneName = 'wm-map-circles';
  let ringsLayer = null;
  let labelsLayer = null;
  let handlesLayer = null;

  // Ссылки на слои активного круга для мгновенного обновления без пересоздания
  let activeOuterPoly = null;
  let activeInnerPolys = [];
  let activeAxisPolys = [];
  let activeLabelsGroup = null;
  let activeLabelMarkers = [];
  let centerMarker = null;
  let radiusHandleMarker = null;

  // Предрасчитанные таблицы sin/cos углов для быстрого построения окружностей
  const TRIG_CACHE = new Map();
  function getTrigTable(segments) {
    let table = TRIG_CACHE.get(segments);
    if (!table) {
      table = new Array(segments);
      for (let i = 0; i < segments; i++) {
        const th = ((i * 360) / segments) * DEG;
        table[i] = { s: Math.sin(th), c: Math.cos(th) };
      }
      TRIG_CACHE.set(segments, table);
    }
    return table;
  }

  // ---------------------------------------------------------------------------
  // СТИЛИ HUD И МЕТОК
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if ($('wm-map-circles-styles')) return;
    const style = document.createElement('style');
    style.id = 'wm-map-circles-styles';
    style.textContent = `
      .mc-hud {
        z-index: 1055;
      }
      .mc-settings-body {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--border);
      }
      .mc-tabs {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
        background: var(--bg-secondary);
        padding: 3px;
        border-radius: 8px;
        margin-bottom: 8px;
      }
      .mc-tab-btn {
        border: none;
        background: transparent;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 700;
        padding: 5px 4px;
        border-radius: 6px;
        cursor: pointer;
      }
      .mc-tab-btn.active {
        background: var(--accent);
        color: #fff;
      }
      .mc-row-inline {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
      }
      .mc-lbl {
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted);
      }
      .mc-num-input {
        width: 78px !important;
        padding: 4px 6px !important;
        font-size: 12px !important;
        font-weight: 700;
      }
      .mc-unit-select {
        width: 56px !important;
        padding: 4px 4px !important;
        font-size: 12px !important;
      }
      .mc-mini-btn {
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-main);
        border-radius: 6px;
        padding: 4px 7px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .mc-mini-btn:active { opacity: 0.75; }
      .mc-chips-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .mc-chip {
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-main);
        border-radius: 99px;
        padding: 2px 8px;
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .mc-chip.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .mc-grid-2 {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
      }
      .mc-grid-3 {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }
      .mc-field {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .mc-field label {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--text-muted);
        display: flex;
        justify-content: space-between;
      }
      .mc-field .styled-select {
        padding: 4px 6px;
        font-size: 11px;
      }
      .mc-field .styled-color-picker {
        width: 100%;
        height: 28px;
        padding: 1px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        cursor: pointer;
      }
      .mc-chk {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-main);
        cursor: pointer;
        padding: 3px 2px;
      }
      .mc-zoom-warn {
        margin-top: 6px;
        padding: 5px 8px;
        border-radius: 7px;
        background: rgba(245, 158, 11, 0.14);
        border: 1px solid rgba(245, 158, 11, 0.45);
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .mc-zoom-btn {
        border: none;
        background: #f59e0b;
        color: #000;
        font-weight: 700;
        font-size: 10.5px;
        padding: 3px 8px;
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
      }
      .wm-mc-label-icon {
        background: transparent;
        border: none;
        pointer-events: none;
      }
      .wm-mc-handle-icon {
        background: transparent;
        border: none;
        pointer-events: auto;
      }
      .wm-mc-lbl-aud {
        display: inline-block;
        transform: translate(-50%, -50%);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 800;
        white-space: nowrap;
        text-shadow: 0 1px 3px rgba(0,0,0,0.96), 0 0 2px rgba(0,0,0,0.95), 0 -1px 2px rgba(0,0,0,0.75);
        pointer-events: none;
      }
      .wm-mc-lbl-aud.size-sm { font-size: 9.5px; }
      .wm-mc-lbl-aud.size-md { font-size: 11px; }
      .wm-mc-lbl-aud.size-lg { font-size: 13px; }
      .wm-mc-lbl-pill {
        display: inline-block;
        transform: translate(-50%, -50%);
        font-family: system-ui, -apple-system, sans-serif;
        font-weight: 700;
        white-space: nowrap;
        background: rgba(15, 23, 42, 0.86);
        color: #fff;
        border: 1px solid var(--mc-color, #3b82f6);
        border-radius: 99px;
        padding: 1px 6px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.45);
        pointer-events: none;
      }
      .wm-mc-lbl-pill.size-sm { font-size: 9.5px; padding: 0px 5px; }
      .wm-mc-lbl-pill.size-md { font-size: 10.5px; padding: 1px 6px; }
      .wm-mc-lbl-pill.size-lg { font-size: 12px; padding: 2px 8px; }
      .wm-mc-center-lbl {
        display: inline-block;
        transform: translate(-50%, -50%);
        font: 700 10.5px/1.2 system-ui, sans-serif;
        color: #fff;
        background: rgba(15, 23, 42, 0.84);
        border: 1.5px solid var(--mc-color, #3b82f6);
        border-radius: 6px;
        padding: 2px 6px;
        white-space: nowrap;
        box-shadow: 0 1px 4px rgba(0,0,0,0.45);
        pointer-events: auto;
        cursor: pointer;
      }
      .wm-mc-center-pin {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--mc-color, #3b82f6);
        border: 2px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        color: #fff;
        pointer-events: auto;
        cursor: grab;
      }
      .wm-mc-radius-handle {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: #fff;
        border: 2.5px solid var(--mc-color, #3b82f6);
        box-shadow: 0 2px 6px rgba(0,0,0,0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 800;
        color: #0f172a;
        pointer-events: auto;
        cursor: ew-resize;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ГЕОДЕЗИЯ
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function fmtDist(meters) {
    if (!meters || meters < 0.5) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    const rounded = km < 10 ? Number(km.toFixed(2)) : Number(km.toFixed(1));
    return rounded + ' км';
  }

  function destination(latDeg, lngDeg, bearingDeg, distM) {
    const phi1 = latDeg * DEG;
    const lam1 = lngDeg * DEG;
    const th = bearingDeg * DEG;
    const dl = distM / R_EARTH;
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const cosDl = Math.cos(dl);
    const sinDl = Math.sin(dl);
    const sinPhi2 = sinPhi1 * cosDl + cosPhi1 * sinDl * Math.cos(th);
    const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
    const lam2 = lam1 + Math.atan2(Math.sin(th) * sinDl * cosPhi1, cosDl - sinPhi1 * sinPhi2);
    const lam2Deg = lam2 * RAD;
    return [phi2 * RAD, lngDeg + (((lam2Deg - lngDeg + 540) % 360) - 180)];
  }

  function buildCircleLatLngs(lat, lng, radiusM, segments = 84, closeRing = true) {
    const table = getTrigTable(segments);
    const phi1 = lat * DEG;
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const dl = radiusM / R_EARTH;
    const cosDl = Math.cos(dl);
    const sinDl = Math.sin(dl);

    const pts = new Array(closeRing ? segments + 1 : segments);
    for (let i = 0; i < segments; i++) {
      const { s, c } = table[i];
      const sinPhi2 = sinPhi1 * cosDl + cosPhi1 * sinDl * c;
      const clamped = sinPhi2 < -1 ? -1 : (sinPhi2 > 1 ? 1 : sinPhi2);
      const phi2 = Math.asin(clamped);
      const dLam = Math.atan2(s * sinDl * cosPhi1, cosDl - sinPhi1 * clamped) * RAD;
      pts[i] = [phi2 * RAD, lng + dLam];
    }
    if (closeRing) {
      pts[segments] = pts[0];
    }
    return pts;
  }

  function getSegmentsCount(radiusM) {
    if (radiusM < 500) return 64;
    if (radiusM < 5000) return 80;
    return 96;
  }

  function isCircleInPaddedBounds(c, paddedBounds) {
    if (!paddedBounds) return true;
    const outerR = Math.max(MIN_RADIUS_M, Number(c.radiusM) || 1000);
    const dLat = (outerR / R_EARTH) * RAD;
    const cosLat = Math.max(0.05, Math.cos(c.lat * DEG));
    const dLng = dLat / cosLat;

    if (c.lat + dLat < paddedBounds.getSouth() || c.lat - dLat > paddedBounds.getNorth()) {
      return false;
    }
    if (dLng >= 170) return true;
    return !(c.lng + dLng < paddedBounds.getWest() || c.lng - dLng > paddedBounds.getEast());
  }

  function suggestRadiusForCurrentView() {
    if (!map) return 1000;
    const b = map.getBounds();
    const w = b.getNorthWest().distanceTo(b.getNorthEast());
    const h = b.getNorthWest().distanceTo(b.getSouthWest());
    const target = Math.min(w, h) * 0.34;
    const NICE = [50, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000];
    let best = 1000;
    let bestDiff = Infinity;
    for (let i = 0; i < NICE.length; i++) {
      const diff = Math.abs(NICE[i] - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = NICE[i];
      }
    }
    return best;
  }

  function getCircleRingRadii(c) {
    const R = Math.max(MIN_RADIUS_M, Number(c.radiusM) || 1000);
    const divs = parseInt(c.divisions, 10);
    if (!divs || divs <= 0) {
      const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
      let step = R;
      for (let i = 0; i < NICE.length; i++) {
        if (R / NICE[i] <= 6.2) {
          step = NICE[i];
          break;
        }
      }
      const list = [];
      for (let d = step; d < R * 0.96; d += step) list.push(d);
      list.push(R);
      return list;
    }
    const list = [];
    for (let k = 1; k <= divs; k++) {
      list.push((R * k) / divs);
    }
    return list;
  }

  function getLabelAngles(pos) {
    switch (pos) {
      case 'N': return [0];
      case 'E': return [90];
      case 'S': return [180];
      case 'W': return [270];
      case 'NE': return [45];
      case 'NS': return [0, 180];
      case 'NESW': return [0, 90, 180, 270];
      case 'DIAG': return [45, 135, 225, 315];
      case 'none': return [];
      default: return [0];
    }
  }

  function sliderToRadius(val) {
    const t = Math.max(0, Math.min(1, val / 1000));
    const raw = SLIDER_MIN_M * Math.pow(SLIDER_MAX_M / SLIDER_MIN_M, t);
    if (raw < 300) return Math.round(raw / 10) * 10;
    if (raw < 1500) return Math.round(raw / 25) * 25;
    if (raw < 5000) return Math.round(raw / 50) * 50;
    if (raw < 15000) return Math.round(raw / 100) * 100;
    return Math.round(raw / 500) * 500;
  }

  function radiusToSlider(radiusM) {
    const r = Math.max(SLIDER_MIN_M, Math.min(SLIDER_MAX_M, radiusM));
    const t = Math.log(r / SLIDER_MIN_M) / Math.log(SLIDER_MAX_M / SLIDER_MIN_M);
    return Math.round(t * 1000);
  }

  // ---------------------------------------------------------------------------
  // ХРАНИЛИЩЕ
  // ---------------------------------------------------------------------------
  function sanitizeCircle(raw, idx) {
    const lat = parseFloat(raw.lat);
    const lng = parseFloat(raw.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const c = Object.assign({}, DEFAULT_CIRCLE_STYLE, raw);
    c.id = raw.id || ('mc_' + Date.now() + '_' + idx);
    c.name = (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim().slice(0, 60) : `Круг ${idx + 1}`;
    c.lat = Math.max(-85, Math.min(85, lat));
    c.lng = Math.max(-180, Math.min(180, lng));
    c.radiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Number(raw.radiusM) || 1000));
    c.divisions = (raw.divisions !== undefined) ? parseInt(raw.divisions, 10) : 4;
    c.minZoom = (raw.minZoom !== undefined) ? parseInt(raw.minZoom, 10) : MIN_ZOOM_DEFAULT;
    c.hidden = !!raw.hidden;
    return c;
  }

  function loadStoredCircles() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          circles = parsed.map((c, idx) => sanitizeCircle(c, idx)).filter(Boolean).slice(0, MAX_CIRCLES);
        }
      }
    } catch (e) {
      circles = [];
    }
    activeCircleId = circles.length > 0 ? circles[0].id : null;
  }

  function saveStoredCircles(immediate = false) {
    clearTimeout(saveTimer);
    if (immediate) {
      saveTimer = 0;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(circles));
      } catch (e) {}
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(circles));
      } catch (e) {}
    }, 250);
  }

  function getActiveCircle() {
    if (!circles.length) return null;
    let found = circles.find(c => c.id === activeCircleId);
    if (!found) {
      found = circles[0];
      activeCircleId = found.id;
    }
    return found;
  }

  function createCircleObject(lat, lng, customName) {
    const num = circles.length + 1;
    return Object.assign({}, DEFAULT_CIRCLE_STYLE, {
      id: 'mc_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      name: customName || `Круг ${num}`,
      lat,
      lng,
      radiusM: suggestRadiusForCurrentView(),
      hidden: false
    });
  }

  // ---------------------------------------------------------------------------
  // ОТРИСОВКА КРУГОВ НА КАРТЕ
  // ---------------------------------------------------------------------------
  function buildLabelHtml(text, c) {
    const safeText = escapeHtml(text);
    return c.labelStyle === 'pill'
      ? `<span class="wm-mc-lbl-pill size-${c.labelSize || 'md'}" style="--mc-color:${escapeHtml(c.color)};">${safeText}</span>`
      : `<span class="wm-mc-lbl-aud size-${c.labelSize || 'md'}" style="color:${escapeHtml(c.labelColor || '#ffffff')};">${safeText}</span>`;
  }

  function makeLabelMarker(lat, lng, text, c) {
    return L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'wm-mc-label-icon',
        html: buildLabelHtml(text, c),
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: false,
      zIndexOffset: 750
    });
  }

  function drawCircleToLayers(c, isEditingTarget) {
    const radii = getCircleRingRadii(c);
    const outerR = radii[radii.length - 1];
    const segs = getSegmentsCount(outerR);
    const innerSegs = Math.max(56, segs - 16);

    // 1. Внутренние кольца
    const innerList = [];
    for (let i = 0; i < radii.length - 1; i++) {
      const pts = buildCircleLatLngs(c.lat, c.lng, radii[i], innerSegs, true);
      const poly = L.polyline(pts, {
        pane: circlesPaneName,
        color: c.innerColor || '#ffffff',
        weight: 1,
        opacity: c.innerOpacity != null ? c.innerOpacity : 0.45,
        dashArray: c.innerDash !== undefined ? (c.innerDash || null) : '4, 5',
        interactive: false
      });
      ringsLayer.addLayer(poly);
      innerList.push(poly);
    }

    // 2. Оси (опционально)
    const axisList = [];
    if (c.showAxes) {
      const pN = destination(c.lat, c.lng, 0, outerR);
      const pS = destination(c.lat, c.lng, 180, outerR);
      const pE = destination(c.lat, c.lng, 90, outerR);
      const pW = destination(c.lat, c.lng, 270, outerR);
      [[pN, pS], [pE, pW]].forEach(seg => {
        const ax = L.polyline(seg, {
          pane: circlesPaneName,
          color: c.innerColor || '#ffffff',
          weight: 1,
          opacity: Math.max(0.15, (c.innerOpacity != null ? c.innerOpacity : 0.45) * 0.8),
          dashArray: '3, 5',
          interactive: false
        });
        ringsLayer.addLayer(ax);
        axisList.push(ax);
      });
    }

    // 3. Внешний контур (всегда interactive: false, чтобы не перехватывать клики по карте внутри круга)
    const outerPts = buildCircleLatLngs(c.lat, c.lng, outerR, segs, false);
    const outerPoly = L.polygon(outerPts, {
      pane: circlesPaneName,
      color: c.color || '#3b82f6',
      weight: c.weight != null ? c.weight : 1.5,
      opacity: c.opacity != null ? c.opacity : 0.75,
      fillColor: c.color || '#3b82f6',
      fillOpacity: c.fillOpacity != null ? c.fillOpacity : 0,
      interactive: false
    });
    ringsLayer.addLayer(outerPoly);

    // 4. Метки расстояния
    const lGroup = L.layerGroup().addTo(labelsLayer);
    const labelEntries = [];
    const angles = getLabelAngles(c.labelPos || 'N');
    angles.forEach(ang => {
      radii.forEach(rM => {
        const [la, ln] = destination(c.lat, c.lng, ang, rM);
        const text = fmtDist(rM);
        const m = makeLabelMarker(la, ln, text, c);
        lGroup.addLayer(m);
        labelEntries.push({ marker: m, text });
      });
    });

    // Подпись в центре (кликабельная, если круг сейчас не перетаскивается ручкой 🎯)
    if (c.showCenterLabel && !(isOpen && isEditing && isEditingTarget)) {
      const centerText = `${c.name} (${fmtDist(outerR)})`;
      const centerPin = L.marker([c.lat, c.lng], {
        icon: L.divIcon({
          className: 'wm-mc-handle-icon',
          html: `<span class="wm-mc-center-lbl" style="--mc-color:${escapeHtml(c.color)};">${escapeHtml(centerText)}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: true,
        zIndexOffset: 760
      });
      centerPin.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        ignoreNextMapClick = true;
        setTimeout(() => { ignoreNextMapClick = false; }, 250);
        activateCircle(c.id);
        if (!isOpen) openTool(true);
      });
      lGroup.addLayer(centerPin);
    }

    if (isEditingTarget) {
      activeOuterPoly = outerPoly;
      activeInnerPolys = innerList;
      activeAxisPolys = axisList;
      activeLabelsGroup = lGroup;
      activeLabelMarkers = labelEntries;
    }
  }

  function updateActiveCircleVisualsFast(c) {
    if (!c) return;
    const zoom = map ? map.getZoom() : 14;
    const minZ = c.minZoom != null ? c.minZoom : MIN_ZOOM_DEFAULT;
    if (c.hidden || zoom < minZ || !activeOuterPoly) {
      renderAll(true);
      return;
    }

    const radii = getCircleRingRadii(c);
    const outerR = radii[radii.length - 1];
    const segs = getSegmentsCount(outerR);
    const innerSegs = Math.max(56, segs - 16);

    if (activeInnerPolys.length !== radii.length - 1) {
      renderAll(true);
      return;
    }

    activeOuterPoly.setLatLngs(buildCircleLatLngs(c.lat, c.lng, outerR, segs, false));
    for (let i = 0; i < radii.length - 1; i++) {
      activeInnerPolys[i].setLatLngs(buildCircleLatLngs(c.lat, c.lng, radii[i], innerSegs, true));
    }

    if (c.showAxes && activeAxisPolys.length === 2) {
      activeAxisPolys[0].setLatLngs([destination(c.lat, c.lng, 0, outerR), destination(c.lat, c.lng, 180, outerR)]);
      activeAxisPolys[1].setLatLngs([destination(c.lat, c.lng, 90, outerR), destination(c.lat, c.lng, 270, outerR)]);
    }

    // Переиспользуем DOM-маркеры меток без их пересоздания
    const angles = getLabelAngles(c.labelPos || 'N');
    const expectedCount = angles.length * radii.length;
    if (activeLabelsGroup && activeLabelMarkers.length === expectedCount) {
      let idx = 0;
      for (let a = 0; a < angles.length; a++) {
        for (let r = 0; r < radii.length; r++) {
          const [la, ln] = destination(c.lat, c.lng, angles[a], radii[r]);
          const entry = activeLabelMarkers[idx++];
          entry.marker.setLatLng([la, ln]);
          const newText = fmtDist(radii[r]);
          if (entry.text !== newText) {
            entry.text = newText;
            const el = entry.marker.getElement();
            if (el) {
              const span = el.firstElementChild;
              if (span) span.textContent = newText;
            }
          }
        }
      }
    } else if (activeLabelsGroup) {
      activeLabelsGroup.clearLayers();
      activeLabelMarkers = [];
      angles.forEach(ang => {
        radii.forEach(rM => {
          const [la, ln] = destination(c.lat, c.lng, ang, rM);
          const text = fmtDist(rM);
          const m = makeLabelMarker(la, ln, text, c);
          activeLabelsGroup.addLayer(m);
          activeLabelMarkers.push({ marker: m, text });
        });
      });
    }

    if (centerMarker) centerMarker.setLatLng([c.lat, c.lng]);
    if (radiusHandleMarker) {
      const [hLat, hLng] = destination(c.lat, c.lng, 90, outerR);
      radiusHandleMarker.setLatLng([hLat, hLng]);
    }
  }

  function updateActiveCircleStyleFast(c) {
    if (!c) return;
    const zoom = map ? map.getZoom() : 14;
    const minZ = c.minZoom != null ? c.minZoom : MIN_ZOOM_DEFAULT;
    if (c.hidden || zoom < minZ || !activeOuterPoly) {
      renderAll(true);
      return;
    }

    activeOuterPoly.setStyle({
      color: c.color || '#3b82f6',
      weight: c.weight != null ? c.weight : 1.5,
      opacity: c.opacity != null ? c.opacity : 0.75,
      fillColor: c.color || '#3b82f6',
      fillOpacity: c.fillOpacity != null ? c.fillOpacity : 0
    });

    const innerStyle = {
      color: c.innerColor || '#ffffff',
      opacity: c.innerOpacity != null ? c.innerOpacity : 0.45,
      dashArray: c.innerDash !== undefined ? (c.innerDash || null) : '4, 5'
    };
    activeInnerPolys.forEach(p => p.setStyle(innerStyle));

    const axisOpacity = Math.max(0.15, (c.innerOpacity != null ? c.innerOpacity : 0.45) * 0.8);
    activeAxisPolys.forEach(ax => ax.setStyle({
      color: c.innerColor || '#ffffff',
      opacity: axisOpacity
    }));

    const pinEl = centerMarker && centerMarker.getElement()?.querySelector('.wm-mc-center-pin');
    if (pinEl) pinEl.style.setProperty('--mc-color', c.color || '#3b82f6');
    const handleEl = radiusHandleMarker && radiusHandleMarker.getElement()?.querySelector('.wm-mc-radius-handle');
    if (handleEl) handleEl.style.setProperty('--mc-color', c.color || '#3b82f6');

    const dotEl = $('mc-color-dot');
    if (dotEl && !c.hidden) dotEl.style.backgroundColor = c.color || '#3b82f6';
  }

  function renderEditHandles(c, visibleByZoom) {
    handlesLayer.clearLayers();
    centerMarker = null;
    radiusHandleMarker = null;

    if (!isOpen || !isEditing || !c || c.hidden) return;

    centerMarker = L.marker([c.lat, c.lng], {
      icon: L.divIcon({
        className: 'wm-mc-handle-icon',
        html: `<div class="wm-mc-center-pin" style="--mc-color:${escapeHtml(c.color)};">🎯</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      }),
      draggable: true,
      zIndexOffset: 2200
    });

    centerMarker.on('dragstart', () => { ignoreNextMapClick = true; });
    centerMarker.on('drag', (e) => {
      const ll = e.target.getLatLng();
      c.lat = ll.lat;
      c.lng = ll.lng;
      updateActiveCircleVisualsFast(c);
    });
    centerMarker.on('dragend', () => {
      saveStoredCircles(true);
      lastRenderSignature = '';
      setTimeout(() => { ignoreNextMapClick = false; }, 220);
    });
    handlesLayer.addLayer(centerMarker);

    if (visibleByZoom) {
      const [hLat, hLng] = destination(c.lat, c.lng, 90, c.radiusM);
      radiusHandleMarker = L.marker([hLat, hLng], {
        icon: L.divIcon({
          className: 'wm-mc-handle-icon',
          html: `<div class="wm-mc-radius-handle" style="--mc-color:${escapeHtml(c.color)};">↔</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        }),
        draggable: true,
        zIndexOffset: 2210
      });

      radiusHandleMarker.on('dragstart', () => { ignoreNextMapClick = true; });
      radiusHandleMarker.on('drag', (e) => {
        const ll = e.target.getLatLng();
        const centerLL = L.latLng(c.lat, c.lng);
        const newR = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Math.round(centerLL.distanceTo(ll))));
        c.radiusM = newR;
        updateActiveCircleVisualsFast(c);
        syncRadiusInputs(c);
        updateSummaryText(c);
      });
      radiusHandleMarker.on('dragend', () => {
        saveStoredCircles(true);
        lastRenderSignature = '';
        syncHudUI();
        setTimeout(() => { ignoreNextMapClick = false; }, 220);
      });
      handlesLayer.addLayer(radiusHandleMarker);
    }
  }

  function renderAll(force = false) {
    if (!map || !ringsLayer || !labelsLayer || !handlesLayer) return;

    const zoom = map.getZoom();
    const paddedBounds = map.getBounds().pad(0.35);
    const active = getActiveCircle();

    const visibleCircles = [];
    const sigParts = [isOpen ? '1' : '0', isEditing ? '1' : '0', active ? active.id : ''];

    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (c.hidden) continue;
      const minZ = c.minZoom != null ? c.minZoom : MIN_ZOOM_DEFAULT;
      if (zoom < minZ) continue;
      if (!isCircleInPaddedBounds(c, paddedBounds)) continue;
      visibleCircles.push(c);
      sigParts.push(c.id);
    }

    const activeMinZ = active ? (active.minZoom != null ? active.minZoom : MIN_ZOOM_DEFAULT) : MIN_ZOOM_DEFAULT;
    const activeHandlesVis = (isOpen && isEditing && active && !active.hidden)
      ? (zoom >= activeMinZ ? '2' : '1')
      : '0';
    sigParts.push(activeHandlesVis);

    const sig = sigParts.join('|');
    if (!force && sig === lastRenderSignature) {
      return;
    }
    lastRenderSignature = sig;

    ringsLayer.clearLayers();
    labelsLayer.clearLayers();
    activeOuterPoly = null;
    activeInnerPolys = [];
    activeAxisPolys = [];
    activeLabelsGroup = null;
    activeLabelMarkers = [];

    for (let i = 0; i < visibleCircles.length; i++) {
      const c = visibleCircles[i];
      drawCircleToLayers(c, active && c.id === active.id);
    }

    renderEditHandles(active, zoom >= activeMinZ);
  }

  // ---------------------------------------------------------------------------
  // СИНХРОНИЗАЦИЯ ИНТЕРФЕЙСА HUD
  // ---------------------------------------------------------------------------
  function syncRadiusInputs(c) {
    if (!c) return;
    const numEl = $('mc-radius-num');
    const unitEl = $('mc-radius-unit');
    const sliderEl = $('mc-radius-slider');

    const unit = unitEl ? unitEl.value : (c.radiusM >= 1000 ? 'km' : 'm');
    if (numEl && document.activeElement !== numEl) {
      if (unit === 'km') {
        numEl.value = Number((c.radiusM / 1000).toFixed(3));
        numEl.step = '0.1';
      } else {
        numEl.value = Math.round(c.radiusM);
        numEl.step = '10';
      }
    }
    if (sliderEl) sliderEl.value = radiusToSlider(c.radiusM);

    document.querySelectorAll('#mc-radius-presets .mc-chip').forEach(ch => {
      ch.classList.toggle('active', Math.abs(parseFloat(ch.dataset.r) - c.radiusM) < 1);
    });
  }

  function updateSummaryText(c) {
    const distEl = $('mc-summary-dist');
    const metaEl = $('mc-summary-meta');
    if (!c) {
      if (distEl) distEl.textContent = 'Нет круга';
      if (metaEl) metaEl.textContent = 'Нажмите ＋ для создания';
      return;
    }
    const radii = getCircleRingRadii(c);
    if (distEl) distEl.textContent = fmtDist(c.radiusM);
    if (metaEl) {
      const divsCount = radii.length;
      if (divsCount <= 1) {
        metaEl.textContent = '1 контур без делений';
      } else {
        const stepTxt = c.divisions === 0 ? 'авто-шаг' : `шаг ${fmtDist(c.radiusM / divsCount)}`;
        metaEl.textContent = `${divsCount} делен. · ${stepTxt}`;
      }
    }
  }

  function syncZoomWarning(c) {
    const warnEl = $('mc-zoom-warn');
    if (!warnEl || !map) return;
    if (!c || c.hidden) {
      warnEl.hidden = true;
      return;
    }
    const curZ = map.getZoom();
    const reqZ = c.minZoom != null ? c.minZoom : MIN_ZOOM_DEFAULT;
    if (curZ < reqZ) {
      warnEl.hidden = false;
      if ($('mc-zoom-warn-req')) $('mc-zoom-warn-req').textContent = reqZ;
      if ($('mc-zoom-warn-cur')) $('mc-zoom-warn-cur').textContent = curZ.toFixed(1);
    } else {
      warnEl.hidden = true;
    }
  }

  function syncHudUI() {
    const hud = $('map-circles-hud');
    if (!hud || !isOpen) return;

    const active = getActiveCircle();
    const dotEl = $('mc-color-dot');
    const selectEl = $('mc-select');
    const finishBtn = $('btn-mc-finish');
    const settingsBody = $('mc-settings-body');
    const toggleSettingsBtn = $('btn-mc-toggle-settings');

    if (selectEl) {
      selectEl.innerHTML = '';
      if (!circles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Нет кругов — нажмите ＋';
        selectEl.appendChild(opt);
      } else {
        circles.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = `${c.hidden ? '🙈 ' : ''}${c.name} (${fmtDist(c.radiusM)})`;
          if (active && c.id === active.id) opt.selected = true;
          selectEl.appendChild(opt);
        });
      }
    }

    if (dotEl) {
      const isHidden = active ? !!active.hidden : true;
      dotEl.classList.toggle('is-hidden', isHidden);
      dotEl.style.backgroundColor = !active ? '#94a3b8' : (isHidden ? '#94a3b8' : active.color);
      dotEl.title = !active ? '' : (isHidden ? 'Круг скрыт (нажмите, чтобы показать)' : 'Нажмите, чтобы скрыть круг с карты');
    }

    if (toggleSettingsBtn) {
      toggleSettingsBtn.classList.toggle('active', isSettingsExpanded);
    }
    if (settingsBody) {
      settingsBody.hidden = !active || !isSettingsExpanded;
    }

    if (finishBtn) {
      finishBtn.textContent = isEditing ? '✓ Готово' : '✏️ Править';
      finishBtn.classList.toggle('primary', isEditing);
      finishBtn.disabled = !active;
    }

    ['btn-mc-rename', 'btn-mc-fly', 'btn-mc-del'].forEach(id => {
      const b = $(id);
      if (b) b.disabled = !active;
    });

    syncZoomWarning(active);
    updateSummaryText(active);

    if (!active) return;

    const unitEl = $('mc-radius-unit');
    if (unitEl) unitEl.value = active.radiusM >= 1000 ? 'km' : 'm';
    syncRadiusInputs(active);

    if ($('mc-divisions-select')) $('mc-divisions-select').value = String(active.divisions != null ? active.divisions : 4);
    if ($('mc-minzoom-select')) $('mc-minzoom-select').value = String(active.minZoom != null ? active.minZoom : MIN_ZOOM_DEFAULT);

    if ($('mc-label-pos')) $('mc-label-pos').value = active.labelPos || 'N';
    if ($('mc-label-style')) $('mc-label-style').value = active.labelStyle || 'audibility';
    if ($('mc-label-size')) $('mc-label-size').value = active.labelSize || 'md';
    if ($('mc-label-color')) $('mc-label-color').value = active.labelColor || '#ffffff';
    if ($('mc-show-center-lbl')) $('mc-show-center-lbl').checked = active.showCenterLabel !== false;
    if ($('mc-show-axes')) $('mc-show-axes').checked = !!active.showAxes;

    if ($('mc-color')) $('mc-color').value = active.color || '#3b82f6';
    if ($('mc-inner-color')) $('mc-inner-color').value = active.innerColor || '#ffffff';
    if ($('mc-inner-dash')) $('mc-inner-dash').value = active.innerDash !== undefined ? active.innerDash : '4, 5';

    const w = active.weight != null ? active.weight : 1.5;
    if ($('mc-weight')) $('mc-weight').value = w;
    if ($('mc-weight-val')) $('mc-weight-val').textContent = w + ' px';

    const op = Math.round((active.opacity != null ? active.opacity : 0.75) * 100);
    if ($('mc-opacity')) $('mc-opacity').value = op;
    if ($('mc-opacity-val')) $('mc-opacity-val').textContent = op + '%';

    const iOp = Math.round((active.innerOpacity != null ? active.innerOpacity : 0.45) * 100);
    if ($('mc-inner-opacity')) $('mc-inner-opacity').value = iOp;
    if ($('mc-inner-opacity-val')) $('mc-inner-opacity-val').textContent = iOp + '%';

    const fOp = Math.round((active.fillOpacity != null ? active.fillOpacity : 0) * 100);
    if ($('mc-fill-opacity')) $('mc-fill-opacity').value = fOp;
    if ($('mc-fill-opacity-val')) $('mc-fill-opacity-val').textContent = fOp + '%';
  }

  function updateSelectedOptionText(c) {
    const selectEl = $('mc-select');
    if (!selectEl || !c) return;
    const opt = Array.from(selectEl.options).find(o => o.value === c.id);
    if (opt) opt.textContent = `${c.hidden ? '🙈 ' : ''}${c.name} (${fmtDist(c.radiusM)})`;
  }

  // ---------------------------------------------------------------------------
  // ДЕЙСТВИЯ ПОЛЬЗОВАТЕЛЯ
  // ---------------------------------------------------------------------------
  function activateCircle(id) {
    if (activeCircleId === id) return;
    activeCircleId = id;
    isEditing = true;
    renderAll(true);
    syncHudUI();
  }

  function createNewCircle() {
    if (!map) return;
    if (circles.length >= MAX_CIRCLES) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`⚠️ Достигнут лимит кругов (${MAX_CIRCLES})`);
      return;
    }
    const center = map.getCenter();
    const c = createCircleObject(center.lat, center.lng);
    circles.push(c);
    activeCircleId = c.id;
    isEditing = true;
    isSettingsExpanded = true;
    saveStoredCircles(true);
    renderAll(true);
    syncHudUI();
    if (WM.ui && WM.ui.showToast) WM.ui.showToast(`⭕ Создан ${c.name} (${fmtDist(c.radiusM)})`);
  }

  function deleteCurrentCircle() {
    const active = getActiveCircle();
    if (!active) return;
    if (!confirm(`Удалить «${active.name}»?`)) return;

    circles = circles.filter(c => c.id !== active.id);
    activeCircleId = circles.length ? circles[circles.length - 1].id : null;
    saveStoredCircles(true);
    renderAll(true);
    syncHudUI();
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('🗑️ Круг дальности удалён');
  }

  function renameCurrentCircle() {
    const active = getActiveCircle();
    if (!active) return;
    const newName = prompt('Название круга дальности:', active.name);
    if (newName && newName.trim()) {
      active.name = newName.trim().slice(0, 60);
      saveStoredCircles(true);
      renderAll(true);
      syncHudUI();
    }
  }

  function toggleCurrentVisibility() {
    const active = getActiveCircle();
    if (!active) return;
    active.hidden = !active.hidden;
    saveStoredCircles(true);
    renderAll(true);
    syncHudUI();
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(active.hidden ? `🙈 «${active.name}» скрыт` : `👁️ «${active.name}» показан`, 1600);
    }
  }

  function onMapClick(latlng) {
    if (!isOpen || !isEditing || ignoreNextMapClick) return;
    if (!latlng || !isFinite(latlng.lat) || !isFinite(latlng.lng)) return;

    let active = getActiveCircle();
    if (!active) {
      const c = createCircleObject(latlng.lat, latlng.lng);
      circles.push(c);
      activeCircleId = c.id;
      saveStoredCircles(true);
      renderAll(true);
      syncHudUI();
      return;
    }

    if (active.hidden) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🙈 Этот круг скрыт. Нажмите на серую точку, чтобы показать его');
      return;
    }

    active.lat = latlng.lat;
    active.lng = latlng.lng;
    saveStoredCircles(true);
    updateActiveCircleVisualsFast(active);
  }

  function openTool(keepCurrent = false) {
    if (WM.measure && WM.measure.closeTool) WM.measure.closeTool();
    if (WM.quickMeasure && WM.quickMeasure.closeTool) WM.quickMeasure.closeTool();
    if (WM.shadowHeight && WM.shadowHeight.closeTool) WM.shadowHeight.closeTool();

    isOpen = true;
    isEditing = true;

    if (!keepCurrent && circles.length === 0 && map) {
      const center = map.getCenter();
      const c = createCircleObject(center.lat, center.lng);
      circles.push(c);
      activeCircleId = c.id;
      saveStoredCircles(true);
    }

    const hud = $('map-circles-hud');
    if (hud) hud.hidden = false;

    renderAll(true);
    syncHudUI();

    if (WM.ui && WM.ui.showToast) {
      const curZ = map ? map.getZoom() : 14;
      const active = getActiveCircle();
      const reqZ = active ? (active.minZoom ?? MIN_ZOOM_DEFAULT) : MIN_ZOOM_DEFAULT;
      if (curZ < reqZ) {
        WM.ui.showToast(`⭕ Приблизьте карту до зума ${reqZ}+, чтобы увидеть круг`, 2400);
      } else {
        WM.ui.showToast('⭕ Перетащите 🎯 или кликните по карте для смены центра', 2200);
      }
    }
  }

  function closeTool() {
    if (!isOpen) return;
    isOpen = false;
    isEditing = false;
    saveStoredCircles(true);

    const hud = $('map-circles-hud');
    if (hud) hud.hidden = true;

    renderAll(true);
  }

  function toggleTool() {
    if (isOpen) closeTool();
    else openTool();
  }

  // ---------------------------------------------------------------------------
  // ПРИВЯЗКА СОБЫТИЙ ИНТЕРФЕЙСА
  // ---------------------------------------------------------------------------
  function bindHudEvents() {
    const hud = $('map-circles-hud');
    if (!hud || hud._mcBound) return;
    hud._mcBound = true;

    if (typeof L !== 'undefined' && L.DomEvent) {
      L.DomEvent.disableClickPropagation(hud);
      L.DomEvent.disableScrollPropagation(hud);
    }

    $('btn-mc-close')?.addEventListener('click', closeTool);
    $('btn-mc-new')?.addEventListener('click', createNewCircle);
    $('btn-mc-rename')?.addEventListener('click', renameCurrentCircle);
    $('btn-mc-del')?.addEventListener('click', deleteCurrentCircle);

    $('btn-mc-toggle-settings')?.addEventListener('click', () => {
      isSettingsExpanded = !isSettingsExpanded;
      syncHudUI();
    });

    $('mc-color-dot')?.addEventListener('click', toggleCurrentVisibility);
    $('mc-select')?.addEventListener('change', (e) => {
      if (e.target.value) activateCircle(e.target.value);
    });

    $('btn-mc-finish')?.addEventListener('click', () => {
      isEditing = !isEditing;
      renderAll(true);
      syncHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(isEditing ? '✏️ Режим правки круга' : '📌 Положение круга зафиксировано');
      }
    });

    $('btn-mc-fly')?.addEventListener('click', () => {
      const c = getActiveCircle();
      if (!c || !map) return;
      const reqZ = Math.max(map.getZoom(), c.minZoom ?? MIN_ZOOM_DEFAULT, 13);
      map.flyTo([c.lat, c.lng], reqZ, { animate: true });
    });

    $('btn-mc-zoom-in')?.addEventListener('click', () => {
      const c = getActiveCircle();
      if (!map) return;
      const reqZ = c ? (c.minZoom ?? MIN_ZOOM_DEFAULT) : MIN_ZOOM_DEFAULT;
      if (c) map.flyTo([c.lat, c.lng], Math.max(reqZ, 13), { animate: true });
      else map.setZoom(reqZ);
    });

    hud.querySelectorAll('.mc-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        hud.querySelectorAll('.mc-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tab;
        ['geo', 'labels', 'style'].forEach(k => {
          const pane = $(`mc-tab-${k}`);
          if (pane) pane.hidden = (k !== target);
        });
      });
    });

    $('btn-mc-center-cross')?.addEventListener('click', () => {
      const c = getActiveCircle();
      if (!c || !map) return;
      const center = map.getCenter();
      c.lat = center.lat;
      c.lng = center.lng;
      saveStoredCircles(true);
      updateActiveCircleVisualsFast(c);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🎯 Центр круга перенесён в перекрестие');
    });

    $('btn-mc-center-gps')?.addEventListener('click', () => {
      const c = getActiveCircle();
      if (!c) return;
      const u = (WM.getUserLocation && WM.getUserLocation()) || (WM.gpsState && [WM.gpsState.lat, WM.gpsState.lng]);
      if (!u) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Позиция GPS ещё не определена');
        return;
      }
      c.lat = u[0];
      c.lng = u[1];
      saveStoredCircles(true);
      updateActiveCircleVisualsFast(c);
      if (map) map.panTo([c.lat, c.lng]);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🛰️ Центр круга установлен по GPS');
    });

    const applyRadius = (rMeters, fromSlider = false, immediateSave = false) => {
      const c = getActiveCircle();
      if (!c) return;
      c.radiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, rMeters));
      updateActiveCircleVisualsFast(c);
      updateSummaryText(c);
      updateSelectedOptionText(c);
      if (fromSlider) {
        const unitEl = $('mc-radius-unit');
        if (unitEl) unitEl.value = c.radiusM >= 1000 ? 'km' : 'm';
      }
      syncRadiusInputs(c);
      saveStoredCircles(immediateSave);
    };

    $('mc-radius-slider')?.addEventListener('input', (e) => {
      applyRadius(sliderToRadius(parseInt(e.target.value, 10)), true, false);
    });
    $('mc-radius-slider')?.addEventListener('change', () => saveStoredCircles(true));

    $('mc-radius-num')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isFinite(val) || val <= 0) return;
      const unit = $('mc-radius-unit')?.value || 'm';
      applyRadius(unit === 'km' ? val * 1000 : val, false, false);
    });
    $('mc-radius-num')?.addEventListener('change', () => {
      const c = getActiveCircle();
      if (c) syncRadiusInputs(c);
      saveStoredCircles(true);
    });

    $('mc-radius-unit')?.addEventListener('change', () => {
      const c = getActiveCircle();
      if (c) syncRadiusInputs(c);
    });

    hud.querySelectorAll('#mc-radius-presets .mc-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        applyRadius(parseFloat(ch.dataset.r), true, true);
      });
    });

    $('mc-divisions-select')?.addEventListener('change', (e) => {
      const c = getActiveCircle();
      if (!c) return;
      c.divisions = parseInt(e.target.value, 10);
      saveStoredCircles(true);
      renderAll(true);
      updateSummaryText(c);
    });

    $('mc-minzoom-select')?.addEventListener('change', (e) => {
      const c = getActiveCircle();
      if (!c) return;
      c.minZoom = parseInt(e.target.value, 10);
      saveStoredCircles(true);
      renderAll(true);
      syncZoomWarning(c);
    });

    const onLabelChange = () => {
      const c = getActiveCircle();
      if (!c) return;
      c.labelPos = $('mc-label-pos')?.value || 'N';
      c.labelStyle = $('mc-label-style')?.value || 'audibility';
      c.labelSize = $('mc-label-size')?.value || 'md';
      c.labelColor = $('mc-label-color')?.value || '#ffffff';
      c.showCenterLabel = $('mc-show-center-lbl')?.checked !== false;
      c.showAxes = !!$('mc-show-axes')?.checked;
      saveStoredCircles();
      renderAll(true);
    };
    ['mc-label-pos', 'mc-label-style', 'mc-label-size', 'mc-label-color', 'mc-show-center-lbl', 'mc-show-axes'].forEach(id => {
      $(id)?.addEventListener('input', onLabelChange);
      $(id)?.addEventListener('change', onLabelChange);
    });

    const onStyleChange = (ev) => {
      const c = getActiveCircle();
      if (!c) return;
      c.color = $('mc-color')?.value || '#3b82f6';
      c.innerColor = $('mc-inner-color')?.value || '#ffffff';
      c.innerDash = $('mc-inner-dash')?.value ?? '4, 5';

      const w = parseFloat($('mc-weight')?.value);
      c.weight = Number.isFinite(w) ? w : 1.5;

      const op = parseInt($('mc-opacity')?.value, 10);
      c.opacity = (Number.isFinite(op) ? op : 75) / 100;

      const iOp = parseInt($('mc-inner-opacity')?.value, 10);
      c.innerOpacity = (Number.isFinite(iOp) ? iOp : 45) / 100;

      const fOp = parseInt($('mc-fill-opacity')?.value, 10);
      c.fillOpacity = (Number.isFinite(fOp) ? fOp : 0) / 100;

      if ($('mc-weight-val')) $('mc-weight-val').textContent = c.weight + ' px';
      if ($('mc-opacity-val')) $('mc-opacity-val').textContent = Math.round(c.opacity * 100) + '%';
      if ($('mc-inner-opacity-val')) $('mc-inner-opacity-val').textContent = Math.round(c.innerOpacity * 100) + '%';
      if ($('mc-fill-opacity-val')) $('mc-fill-opacity-val').textContent = Math.round(c.fillOpacity * 100) + '%';

      updateActiveCircleStyleFast(c);
      saveStoredCircles(ev && ev.type === 'change');
    };
    ['mc-color', 'mc-inner-color', 'mc-inner-dash', 'mc-weight', 'mc-opacity', 'mc-inner-opacity', 'mc-fill-opacity'].forEach(id => {
      $(id)?.addEventListener('input', onStyleChange);
      $(id)?.addEventListener('change', onStyleChange);
    });

    $('btn-mc-reset-style')?.addEventListener('click', () => {
      const c = getActiveCircle();
      if (!c) return;
      Object.assign(c, {
        color: DEFAULT_CIRCLE_STYLE.color,
        innerColor: DEFAULT_CIRCLE_STYLE.innerColor,
        opacity: DEFAULT_CIRCLE_STYLE.opacity,
        innerOpacity: DEFAULT_CIRCLE_STYLE.innerOpacity,
        fillOpacity: DEFAULT_CIRCLE_STYLE.fillOpacity,
        weight: DEFAULT_CIRCLE_STYLE.weight,
        innerDash: DEFAULT_CIRCLE_STYLE.innerDash,
        labelColor: DEFAULT_CIRCLE_STYLE.labelColor,
        labelStyle: DEFAULT_CIRCLE_STYLE.labelStyle
      });
      saveStoredCircles(true);
      renderAll(true);
      syncHudUI();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('↺ Стиль сброшен как в модуле слышимости');
    });
  }

  // ---------------------------------------------------------------------------
  // ПУБЛИЧНОЕ API МОДУЛЯ
  // ---------------------------------------------------------------------------
  WM.mapCircles = {
    init(mapInstance) {
      map = mapInstance || WM.map;
      if (!map || map._wmMapCirclesInited) return;
      map._wmMapCirclesInited = true;

      injectStyles();
      loadStoredCircles();

      if (!map.getPane(circlesPaneName)) {
        map.createPane(circlesPaneName);
        map.getPane(circlesPaneName).style.zIndex = 475;
      }

      ringsLayer = L.layerGroup().addTo(map);
      labelsLayer = L.layerGroup().addTo(map);
      handlesLayer = L.layerGroup().addTo(map);

      bindHudEvents();

      map.on('moveend zoomend', () => {
        renderAll(false);
        if (isOpen) syncZoomWarning(getActiveCircle());
      });

      window.addEventListener('pagehide', () => {
        if (saveTimer) saveStoredCircles(true);
      });

      renderAll(true);
    },

    openTool,
    closeTool,
    toggleTool,
    onMapClick,

    isActive() { return isOpen && isEditing; },
    isToolOpen() { return isOpen; },
    getCircles() { return circles; },

    refresh() {
      renderAll(true);
      if (isOpen) syncHudUI();
    },

    exportData() {
      return JSON.parse(JSON.stringify(circles));
    },

    importData(imported) {
      if (!Array.isArray(imported)) return;
      circles = imported.map((c, idx) => sanitizeCircle(c, idx)).filter(Boolean).slice(0, MAX_CIRCLES);
      activeCircleId = circles.length ? circles[0].id : null;
      saveStoredCircles(true);
      renderAll(true);
      if (isOpen) syncHudUI();
    },

    clearAll() {
      circles = [];
      activeCircleId = null;
      clearTimeout(saveTimer);
      saveTimer = 0;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      renderAll(true);
      if (isOpen) syncHudUI();
    }
  };
})();