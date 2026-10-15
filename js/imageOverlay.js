(function () {
  const WM = window.WM = window.WM || {};

  const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 МБ
  const MAX_IMAGE_PIXELS = 4096 * 4096;          // ~16.7 Мп
  const METERS_PER_DEG_LAT = 111320;
  const MAX_ACTIVE_KML_TILES = 200;
  const MIN_TILE_DISPLAY_PX = 44; // Тайлы мельче 36px не рендерим (защита от лагов на мелком зуме)

  let map = null;
  let db = null;
  const overlays = new Map();
  let activeOverlayId = null;
  let moveStepMeters = 5;

  // =========================================================================
  // ВЫСОКОСКОРОСТНОЙ СЛОЙ МНОГОТАЙЛОВЫХ КАРТ (KML / ETOMESTO)
  // =========================================================================
  const KmlTileLayer = L.Layer.extend({
    options: {
      opacity: 0.85,
      pane: 'overlayPane',
      blendMode: 'normal',
      name: 'Карта KML'
    },

    initialize: function (tiles, totalBounds, options) {
      L.setOptions(this, options);
      this._tiles = tiles || [];
      this._totalBounds = L.latLngBounds(totalBounds);
      this._activeTiles = new Map(); // href -> { img, bounds, key }
      this._grid = new Map();
      this._gridStep = 0.05; // ~5 км ячейка индекса
      this._animFrame = 0;
      this._placeholder = null;
      this._isOverview = false;
      this._tileZoom = undefined;
      this._origin = null;

      // Построение пространственного индекса для мгновенного поиска (O(1))
      for (let i = 0; i < this._tiles.length; i++) {
        const t = this._tiles[i];
        const s = t.bounds[0][0], w = t.bounds[0][1], n = t.bounds[1][0], e = t.bounds[1][1];
        t.bbox = { s, w, n, e };
        t._llBounds = L.latLngBounds(t.bounds);
        t._center = L.latLng((s + n) / 2, (w + e) / 2);

        const minX = Math.floor((w + 180) / this._gridStep);
        const maxX = Math.floor((e + 180) / this._gridStep);
        const minY = Math.floor((s + 90) / this._gridStep);
        const maxY = Math.floor((n + 90) / this._gridStep);

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const key = (x * 100000) + y;
            let cell = this._grid.get(key);
            if (!cell) { cell = []; this._grid.set(key, cell); }
            cell.push(t);
          }
        }
      }
    },

    onAdd: function (map) {
      this._map = map;
      const targetPane = this.getPane();
      // leaflet-zoom-animated обязателен для аппаратного скейлинга при жестах
      this._container = L.DomUtil.create('div', 'leaflet-layer leaflet-zoom-animated wm-kml-tiles-container');
      this._container.style.position = 'absolute';
      this._container.style.pointerEvents = 'none';
      this._container.style.opacity = this.options.opacity;
      this._container.style.mixBlendMode = this.options.blendMode || 'normal';
      this._container.style.transformOrigin = '0 0';

      targetPane.appendChild(this._container);

      map.on('moveend zoomend', this._scheduleUpdate, this);
      this._update();
    },

    onRemove: function (map) {
      if (this._animFrame) {
        cancelAnimationFrame(this._animFrame);
        this._animFrame = 0;
      }
      map.off('moveend zoomend', this._scheduleUpdate, this);
      this._clearAll();
      this._removePlaceholder();
      if (this._container && this._container.parentNode) {
        this._container.parentNode.removeChild(this._container);
      }
    },

    getEvents: function () {
      const events = {
        viewreset: this._reset
      };

      if (this._map && this._map.options.zoomAnimation) {
        this._zoomAnimated = true;
        events.zoomanim = this._animateZoom;
      } else {
        // Вызываем пересчет геометрии только по окончании зума, а не на каждый тик
        events.zoomend = this._reset;
      }

      return events;
    },
    // Плавное непрерывное масштабирование всего контейнера тайлов на GPU при щипке
    _onZoom: function () {
      if (!this._container || !this._map || !this._origin || this._tileZoom === undefined) return;
      const currentZoom = this._map.getZoom();
      const scale = this._map.getZoomScale(currentZoom, this._tileZoom);
      const offset = this._map.latLngToLayerPoint(this._totalBounds.getNorthWest());
      L.DomUtil.setTransform(this._container, offset, scale);
    },

    // Масштабирование при анимации Leaflet
    _animateZoom: function (e) {
      if (!this._container || !this._map || !this._origin || this._tileZoom === undefined) return;
      const scale = this._map.getZoomScale(e.zoom, this._tileZoom);
      const offset = this._map._latLngToNewLayerPoint(this._totalBounds.getNorthWest(), e.zoom, e.center);
      L.DomUtil.setTransform(this._container, offset, scale);
    },

    _onViewReset: function () {
      this._update();
    },

    _scheduleUpdate: function () {
      if (this._animFrame) cancelAnimationFrame(this._animFrame);
      this._animFrame = requestAnimationFrame(() => {
        this._animFrame = 0;
        this._update();
      });
    },

    _showPlaceholder: function () {
      this._isOverview = true;
      this._clearAll();

      if (!this._placeholder) {
        this._placeholder = L.DomUtil.create('div', 'wm-kml-placeholder', this._container);
        
        const inner = L.DomUtil.create('div', 'wm-kml-placeholder-inner', this._placeholder);
        inner.innerHTML = `
          <div class="wm-kml-placeholder-icon">📜</div>
          <div class="wm-kml-placeholder-title">${escapeHtml(this.options.name || 'Карта KML')}</div>
          <div class="wm-kml-placeholder-hint">🔍 Приблизьте для просмотра</div>
        `;

        L.DomEvent.on(this._placeholder, 'click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (this._map) {
            this._map.fitBounds(this._totalBounds, { padding: [40, 40], maxZoom: 15 });
          }
        });
      }

      this._placeholder.style.display = 'flex';
      this._positionPlaceholder();
    },

    _positionPlaceholder: function () {
      if (!this._placeholder || !this._map || !this._origin) return;
      const p1 = this._map.latLngToLayerPoint(this._totalBounds.getNorthWest()).subtract(this._origin);
      const p2 = this._map.latLngToLayerPoint(this._totalBounds.getSouthEast()).subtract(this._origin);
      L.DomUtil.setPosition(this._placeholder, p1);
      this._placeholder.style.width = Math.max(1, Math.ceil(p2.x - p1.x)) + 'px';
      this._placeholder.style.height = Math.max(1, Math.ceil(p2.y - p1.y)) + 'px';
    },

    _removePlaceholder: function () {
      this._isOverview = false;
      if (this._placeholder) {
        if (this._placeholder.parentNode) {
          this._placeholder.parentNode.removeChild(this._placeholder);
        }
        this._placeholder = null;
      }
    },

    _update: function () {
      if (!this._map || !this._container) return;

      const mapBounds = this._map.getBounds();
      if (!mapBounds.intersects(this._totalBounds)) {
        this._clearAll();
        this._removePlaceholder();
        return;
      }

      // Проверка масштаба по первому тайлу
      const sampleTile = this._tiles[0];
      let isTooFar = false;
      if (sampleTile) {
        const pNW = this._map.latLngToLayerPoint(sampleTile._llBounds.getNorthWest());
        const pSE = this._map.latLngToLayerPoint(sampleTile._llBounds.getSouthEast());
        const sizePx = Math.max(Math.abs(pSE.x - pNW.x), Math.abs(pSE.y - pNW.y));
        if (sizePx < MIN_TILE_DISPLAY_PX) {
          isTooFar = true;
        }
      }

      // Сброс и привязка точки начала координат контейнера к северо-западу
      this._tileZoom = this._map.getZoom();
      this._origin = this._map.latLngToLayerPoint(this._totalBounds.getNorthWest());
      L.DomUtil.setPosition(this._container, this._origin);
      L.DomUtil.setTransform(this._container, this._origin, 1);

      if (isTooFar) {
        this._showPlaceholder();
        return;
      }

      if (this._isOverview) {
        this._removePlaceholder();
      }

      const b = mapBounds.pad(0.1);
      const minX = Math.floor((b.getWest() + 180) / this._gridStep);
      const maxX = Math.floor((b.getEast() + 180) / this._gridStep);
      const minY = Math.floor((b.getSouth() + 90) / this._gridStep);
      const maxY = Math.floor((b.getNorth() + 90) / this._gridStep);

      const neededTiles = [];
      const seen = new Set();

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const cell = this._grid.get((x * 100000) + y);
          if (!cell) continue;

          for (let i = 0; i < cell.length; i++) {
            const t = cell[i];
            if (seen.has(t.href)) continue;
            seen.add(t.href);

            if (b.intersects(t._llBounds)) {
              neededTiles.push(t);
            }
          }
        }
      }

      if (neededTiles.length > 300) {
        this._showPlaceholder();
        return;
      }

      const neededHrefs = new Set(neededTiles.map(t => t.href));

      // 1. Отображаем/позиционируем тайлы экрана относительно _origin
      for (let i = 0; i < neededTiles.length; i++) {
        const t = neededTiles[i];
        if (!this._activeTiles.has(t.href)) {
          this._loadTile(t);
        } else {
          this._positionTile(this._activeTiles.get(t.href));
        }
      }

      // 2. Удаляем вышедшие за границы тайлы
      for (const [href, data] of this._activeTiles) {
        if (!neededHrefs.has(href)) {
          if (data.img.parentNode) data.img.parentNode.removeChild(data.img);
          data.img.src = '';
          this._activeTiles.delete(href);
        }
      }
    },

    _loadTile: function (t) {
      const img = L.DomUtil.create('img', 'wm-kml-tile', this._container);
      img.style.position = 'absolute';
      img.style.willChange = 'transform, width, height';
      img.loading = 'lazy';
      img.decoding = 'async';

      const data = { img, bounds: t._llBounds };
      this._positionTile(data);
      img.src = t.href;
      this._activeTiles.set(t.href, data);
    },

    // Позиционируем тайл строго относительно _origin слоя
    _positionTile: function (data) {
      if (!this._origin) return;
      const p1 = this._map.latLngToLayerPoint(data.bounds.getNorthWest()).subtract(this._origin);
      const p2 = this._map.latLngToLayerPoint(data.bounds.getSouthEast()).subtract(this._origin);
      L.DomUtil.setPosition(data.img, p1);
      data.img.style.width = Math.ceil(p2.x - p1.x) + 'px';
      data.img.style.height = Math.ceil(p2.y - p1.y) + 'px';
    },

    _clearAll: function () {
      for (const [, data] of this._activeTiles) {
        if (data.img.parentNode) data.img.parentNode.removeChild(data.img);
        data.img.src = '';
      }
      this._activeTiles.clear();
    },

    setOpacity: function (opacity) {
      this.options.opacity = opacity;
      if (this._container) this._container.style.opacity = opacity;
      return this;
    },

    setBlendMode: function (mode) {
      this.options.blendMode = mode || 'normal';
      if (this._container) this._container.style.mixBlendMode = this.options.blendMode;
      return this;
    },

    getBounds: function () {
      return this._totalBounds;
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function getOriginalAspect(item) {
    if (item.origAspect && !isNaN(item.origAspect)) {
      return item.origAspect;
    }
    if (item.initial && item.initial.widthMeters && item.initial.heightMeters) {
      return item.initial.widthMeters / item.initial.heightMeters;
    }
    return (item.widthMeters || 1) / (item.heightMeters || 1);
  }

  function restoreAspectRatio(item) {
    const aspect = getOriginalAspect(item);
    if (!aspect || isNaN(aspect) || aspect <= 0) return;

    item.heightMeters = Math.max(20, Math.round(item.widthMeters / aspect));

    const bounds = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);
    if (item.layer && typeof item.layer.setBounds === 'function') {
      item.layer.setBounds(bounds);
    }
    
    if (activeOverlayId === item.id) {
      renderEditHandles(item);
    }
    if (item.nwSelectPin) {
      const corners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
      item.nwSelectPin.setLatLng(corners[0]);
    }
    saveOverlay(item);
  }

  function getOrCreateOverlayPane(item) {
    const paneName = 'wm-ov-pane-' + item.id;
    let pane = map.getPane(paneName);
    if (!pane) {
      pane = map.createPane(paneName);
      L.DomUtil.addClass(pane, 'leaflet-zoom-animated');
    }
    pane.style.zIndex = 390;
    pane.style.mixBlendMode = item.blendMode || 'normal';
    pane.style.display = item.visible !== false ? '' : 'none';
    return paneName;
  }

  const RotatedImageOverlay = L.Layer.extend({
    options: {
      opacity: 0.8,
      rotation: 0,
      blendMode: 'normal',
      interactive: true,
      className: ''
    },

    initialize: function (url, bounds, options) {
      this._url = url;
      this._bounds = L.latLngBounds(bounds);
      L.setOptions(this, options);
    },

    getEvents: function () {
      const events = {
        zoom: this._reset,
        viewreset: this._reset
      };

      if (this._map && this._map.options.zoomAnimation) {
        this._zoomAnimated = true;
        events.zoomanim = this._animateZoom;
      }

      return events;
    },

    onAdd: function () {
      if (!this._container) {
        this._initImage();
      }
      this.getPane().appendChild(this._container);
      this._updateBlendMode();
      this._reset();
    },

    onRemove: function () {
      if (this._container && this._container.parentNode) {
        this._container.parentNode.removeChild(this._container);
      }
    },

    _initImage: function () {
      this._zoomAnimated = this._map && this._map.options.zoomAnimation;

      const div = this._container = L.DomUtil.create(
        'div',
        'leaflet-image-layer ' + (this._zoomAnimated ? 'leaflet-zoom-animated ' : '') + 'wm-custom-overlay-wrap'
      );
      div.style.position = 'absolute';
      div.style.overflow = 'visible';

      const img = this._rawImg = L.DomUtil.create('img', 'wm-custom-overlay-img', div);
      img.src = this._url;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.display = 'block';
      img.style.position = 'absolute';
      img.style.top = '0';
      img.style.left = '0';
      img.style.transformOrigin = '50% 50%';

      if (this.options.rotation) {
        img.style.transform = `rotate(${this.options.rotation}deg)`;
      }

      this._updateOpacity();
      this._updateBlendMode();

      if (this.options.interactive) {
        L.DomUtil.addClass(img, 'leaflet-interactive');
        this.addInteractiveTarget(img);
      }
    },

    _updateOpacity: function () {
      if (this._rawImg) {
        L.DomUtil.setOpacity(this._rawImg, this.options.opacity);
      }
    },

    _updateBlendMode: function () {
      const mode = this.options.blendMode || 'normal';
      const pane = this.getPane();
      if (pane) {
        pane.style.mixBlendMode = mode;
      }
      if (this._rawImg) {
        this._rawImg.style.mixBlendMode = mode;
      }
    },

    _animateZoom: function (e) {
      if (!this._container) return;
      const scale = this._map.getZoomScale(e.zoom);
      const offset = this._map._latLngBoundsToNewLayerBounds(this._bounds, e.zoom, e.center).min;
      L.DomUtil.setTransform(this._container, offset, scale);
    },

    _reset: function () {
      if (!this._container || !this._map) return;
      const bounds = new L.Bounds(
        this._map.latLngToLayerPoint(this._bounds.getNorthWest()),
        this._map.latLngToLayerPoint(this._bounds.getSouthEast())
      );
      const size = bounds.getSize();

      L.DomUtil.setPosition(this._container, bounds.min);
      this._container.style.width = size.x + 'px';
      this._container.style.height = size.y + 'px';
    },

    setBounds: function (bounds) {
      this._bounds = L.latLngBounds(bounds);
      if (this._map) {
        this._reset();
      }
      return this;
    },

    setOpacity: function (opacity) {
      this.options.opacity = opacity;
      this._updateOpacity();
      return this;
    },

    setRotation: function (deg) {
      this.options.rotation = ((deg % 360) + 360) % 360;
      if (this._rawImg) {
        this._rawImg.style.transform = this.options.rotation ? `rotate(${this.options.rotation}deg)` : '';
      }
      return this;
    },

    setBlendMode: function (mode) {
      this.options.blendMode = mode || 'normal';
      this._updateBlendMode();
      return this;
    },

    getElement: function () {
      return this._rawImg || this._container;
    }
  });

  function openDB() {
    return new Promise((resolve) => {
      const req = indexedDB.open('WM_Overlays_DB', 2);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('overlays')) {
          d.createObjectStore('overlays', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { console.warn('IndexedDB Overlays недоступен'); resolve(null); };
    });
  }

  function dbPut(item) {
    if (!db) return;
    try {
      const tx = db.transaction('overlays', 'readwrite');
      tx.objectStore('overlays').put(item);
    } catch (e) {}
  }

  function dbDelete(id) {
    if (!db) return;
    try {
      const tx = db.transaction('overlays', 'readwrite');
      tx.objectStore('overlays').delete(id);
    } catch (e) {}
  }

  function dbGetAll() {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      try {
        const tx = db.transaction('overlays', 'readonly');
        const req = tx.objectStore('overlays').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }

  function getMetersPerDegLng(lat) {
    const rad = lat * Math.PI / 180;
    return METERS_PER_DEG_LAT * (Math.cos(rad) || 0.00001);
  }

  function computeUnrotatedBounds(center, widthMeters, heightMeters) {
    const dLat = (heightMeters / 2) / METERS_PER_DEG_LAT;
    const dLng = (widthMeters / 2) / getMetersPerDegLng(center.lat);
    return [
      [center.lat - dLat, center.lng - dLng],
      [center.lat + dLat, center.lng + dLng]
    ];
  }

  function computeRotatedCorners(center, widthMeters, heightMeters, rotationDeg) {
    const halfW = widthMeters / 2;
    const halfH = heightMeters / 2;
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const mPerLng = getMetersPerDegLng(center.lat);

    const localPts = [
      { x: -halfW, y: halfH },  // NW
      { x: halfW, y: halfH },   // NE
      { x: halfW, y: -halfH },  // SE
      { x: -halfW, y: -halfH }  // SW
    ];

    return localPts.map(pt => {
      const rotX = pt.x * cos + pt.y * sin;
      const rotY = -pt.x * sin + pt.y * cos;
      return L.latLng(
        center.lat + rotY / METERS_PER_DEG_LAT,
        center.lng + rotX / mPerLng
      );
    });
  }

  function computeRotationHandlePoint(center, widthMeters, heightMeters, rotationDeg, offsetPx = 36) {
    const halfH = heightMeters / 2;
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const mPerLng = getMetersPerDegLng(center.lat);

    const currentZoom = map.getZoom();
    const metersPerPixel = (40075016.686 * Math.abs(Math.cos(center.lat * Math.PI / 180))) / (256 * Math.pow(2, currentZoom));
    const offsetMeters = offsetPx * metersPerPixel;

    const topDist = halfH + Math.max(10, offsetMeters);
    const rotX = topDist * sin;
    const rotY = topDist * cos;

    return L.latLng(
      center.lat + rotY / METERS_PER_DEG_LAT,
      center.lng + rotX / mPerLng
    );
  }

  function parseKmlGroundOverlay(kmlText) {
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(kmlText, 'text/xml');

      function findTag(root, name) {
        let el = root.getElementsByTagName(name)[0];
        if (!el) el = root.getElementsByTagName(name.toLowerCase())[0];
        if (!el) {
          const all = root.getElementsByTagName('*');
          const lower = name.toLowerCase();
          for (let i = 0; i < all.length; i++) {
            if ((all[i].localName || '').toLowerCase() === lower) return all[i];
          }
        }
        return el;
      }

      function getTagFloat(root, name, fallback = NaN) {
        const el = findTag(root, name);
        if (!el || !el.textContent) return fallback;
        const v = parseFloat(el.textContent.trim());
        return isNaN(v) ? fallback : v;
      }

      function getTagText(root, name) {
        const el = findTag(root, name);
        return el && el.textContent ? el.textContent.trim() : '';
      }

      // 1. Проверяем наличие нескольких GroundOverlay (тайловый KML / ЭтоМесто)
      const allOverlays = xml.getElementsByTagName('GroundOverlay');
      if (allOverlays.length > 0) {
        const tiles = [];
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

        for (let i = 0; i < allOverlays.length; i++) {
          const node = allOverlays[i];
          const iconNode = findTag(node, 'Icon');
          const href = iconNode ? getTagText(iconNode, 'href') : '';
          const box = findTag(node, 'LatLonBox');

          if (box) {
            const n = getTagFloat(box, 'north');
            const s = getTagFloat(box, 'south');
            const e = getTagFloat(box, 'east');
            const w = getTagFloat(box, 'west');
            const rot = getTagFloat(box, 'rotation', 0);

            if (!isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w)) {
              if (n > maxLat) maxLat = n;
              if (s < minLat) minLat = s;
              if (e > maxLng) maxLng = e;
              if (w < minLng) minLng = w;

              tiles.push({
                href,
                bounds: [[s, w], [n, e]],
                rotation: rot
              });
            }
          }
        }

        if (tiles.length > 1 || (tiles.length === 1 && tiles[0].href && /^https?:\/\//i.test(tiles[0].href))) {
          const docName = getTagText(xml, 'name') || 'KML Слой';
          const center = L.latLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);
          const heightMeters = Math.abs(maxLat - minLat) * METERS_PER_DEG_LAT;
          const widthMeters = Math.abs(maxLng - minLng) * getMetersPerDegLng(center.lat);

          return {
            isMultiTile: true,
            name: docName,
            tiles,
            center,
            widthMeters,
            heightMeters,
            bounds: [[minLat, minLng], [maxLat, maxLng]]
          };
        }
      }

      // 2. Обычный одиночный KML
      const box = findTag(xml, 'LatLonBox');
      if (!box) return null;

      const n = getTagFloat(box, 'north');
      const s = getTagFloat(box, 'south');
      const e = getTagFloat(box, 'east');
      const w = getTagFloat(box, 'west');
      const rot = getTagFloat(box, 'rotation', 0);

      if (!isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w)) {
        const center = L.latLng((n + s) / 2, (e + w) / 2);
        const heightMeters = Math.abs(n - s) * METERS_PER_DEG_LAT;
        const widthMeters = Math.abs(e - w) * getMetersPerDegLng(center.lat);
        return {
          isMultiTile: false,
          center,
          widthMeters,
          heightMeters,
          rotation: rot
        };
      }
    } catch (err) {
      console.warn('Ошибка парсинга KML:', err);
    }
    return null;
  }

  function renderOverlayLayer(item) {
    if (item.layer) {
      map.removeLayer(item.layer);
      item.layer = null;
    }
    if (item.markersGroup) {
      map.removeLayer(item.markersGroup);
      item.markersGroup = null;
    }
    if (item.nwSelectPin) {
      map.removeLayer(item.nwSelectPin);
      item.nwSelectPin = null;
    }

    const paneName = getOrCreateOverlayPane(item);
    if (item.visible === false) return;

    const opacity = (item.opacity !== undefined ? item.opacity : 80) / 100;

    // ВАРИАНТ А: Мультитайловый KML (ЭтоМесто и др.)
    if (item.isMultiTile && Array.isArray(item.tiles)) {
      item.layer = new KmlTileLayer(item.tiles, item.bounds, {
        pane: paneName,
        opacity: opacity,
        blendMode: item.blendMode || 'normal',
        name: item.name // <-- передаем имя для плашки
      }).addTo(map);
      return;
    }

    // ВАРИАНТ Б: Одиночная пользовательская растровая карта
    if (item.aspectLocked !== false) {
      const aspect = getOriginalAspect(item);
      item.heightMeters = Math.max(20, Math.round(item.widthMeters / aspect));
    }

    const unrotatedBounds = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);

    item.layer = new RotatedImageOverlay(item.dataUrl, unrotatedBounds, {
      pane: paneName,
      opacity: opacity,
      rotation: item.rotation || 0,
      blendMode: item.blendMode || 'normal',
      interactive: false
    }).addTo(map);

    renderNwSelectPin(item);

    if (activeOverlayId === item.id) {
      renderEditHandles(item);
    }
  }

  function renderNwSelectPin(item) {
    if (item.nwSelectPin) {
      map.removeLayer(item.nwSelectPin);
      item.nwSelectPin = null;
    }

    if (!item.center || !item.widthMeters) return;

    const corners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
    const nw = corners[0];
    const isAct = activeOverlayId === item.id;

    const pinIcon = L.divIcon({
      className: 'wm-overlay-select-pin-wrap',
      html: `
        <div class="wm-overlay-select-pin ${isAct ? 'active' : ''}" title="Редактировать «${escapeHtml(item.name)}»">
          <span class="ov-pin-icon">⚙️</span>
          <span class="ov-pin-label">${escapeHtml(item.name)}</span>
        </div>
      `,
      iconSize: [0, 0]
    });

    item.nwSelectPin = L.marker(nw, {
      pane: 'wm-overlay-handles',
      icon: pinIcon,
      interactive: true,
      zIndexOffset: isAct ? 2600 : 2300
    }).addTo(map);

    item.nwSelectPin.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      selectOverlay(item.id);
    });
  }

  function renderEditHandles(item) {
    if (item.markersGroup) {
      map.removeLayer(item.markersGroup);
      item.markersGroup = null;
    }

    if (item.isMultiTile) return; // У KML тайлов фиксированная геометрия

    item.markersGroup = L.layerGroup().addTo(map);

    const corners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
    const nw = corners[0], ne = corners[1], se = corners[2], sw = corners[3];

    // Рамка полигона
    const poly = L.polygon([nw, ne, se, sw], {
      pane: 'wm-top-lines',
      color: '#0284c7',
      weight: 2,
      dashArray: '5, 5',
      fill: false,
      className: 'wm-overlay-frame-poly',
      interactive: true
    }).addTo(item.markersGroup);

    poly.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectOverlay(item.id);
    });

    // 1. Центральный маркер сдвига
    const centerIcon = L.divIcon({
      className: 'wm-overlay-handle-wrap',
      html: '<div class="wm-overlay-handle-dot center" title="Переместить карту (тяните)">✥</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const centerMarker = L.marker(item.center, {
      pane: 'wm-overlay-handles',
      icon: centerIcon,
      draggable: true,
      zIndexOffset: 3200
    }).addTo(item.markersGroup);

    centerMarker.on('drag', (e) => {
      item.center = e.target.getLatLng();
      const bounds = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);
      item.layer.setBounds(bounds);
      const newCorners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
      poly.setLatLngs(newCorners);
      scaleMarker.setLatLng(newCorners[1]);
      rotMarker.setLatLng(computeRotationHandlePoint(item.center, item.widthMeters, item.heightMeters, item.rotation));
      const curTopCenter = L.latLng((newCorners[0].lat + newCorners[1].lat) / 2, (newCorners[0].lng + newCorners[1].lng) / 2);
      stemLine.setLatLngs([curTopCenter, rotMarker.getLatLng()]);
      if (item.nwSelectPin) item.nwSelectPin.setLatLng(newCorners[0]);
      updateHudCoords(item);
    });

    centerMarker.on('dragend', () => {
      saveOverlay(item);
      renderOverlayLayer(item);
    });

    // 2. Угловой маркер изменения размера (NE)
    const scaleIcon = L.divIcon({
      className: 'wm-overlay-handle-wrap',
      html: '<div class="wm-overlay-handle-dot corner" title="Изменить размер (потяните)">⤢</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const scaleMarker = L.marker(ne, {
      pane: 'wm-overlay-handles',
      icon: scaleIcon,
      draggable: true,
      zIndexOffset: 3500
    }).addTo(item.markersGroup);

    scaleMarker.on('drag', (e) => {
      const curLatLng = e.target.getLatLng();
      const c = item.center;
      const mPerLng = getMetersPerDegLng(c.lat);

      const dxWorld = (curLatLng.lng - c.lng) * mPerLng;
      const dyWorld = (curLatLng.lat - c.lat) * METERS_PER_DEG_LAT;

      const rad = (item.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const localX = Math.abs(dxWorld * cos - dyWorld * sin);
      const localY = Math.abs(dxWorld * sin + dyWorld * cos);

      const origAspect = getOriginalAspect(item);

      if (item.aspectLocked !== false) {
        const targetHalfW = Math.max(10, Math.round(Math.max(localX, localY * origAspect)));
        item.widthMeters = targetHalfW * 2;
        item.heightMeters = Math.max(20, Math.round(item.widthMeters / origAspect));
      } else {
        item.widthMeters = Math.max(20, Math.round(localX * 2));
        item.heightMeters = Math.max(20, Math.round(localY * 2));
      }

      const bounds = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);
      item.layer.setBounds(bounds);

      const newCorners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
      poly.setLatLngs(newCorners);
      rotMarker.setLatLng(computeRotationHandlePoint(item.center, item.widthMeters, item.heightMeters, item.rotation));
      if (item.nwSelectPin) item.nwSelectPin.setLatLng(newCorners[0]);
      stemLine.setLatLngs([
        L.latLng((newCorners[0].lat + newCorners[1].lat) / 2, (newCorners[0].lng + newCorners[1].lng) / 2),
        rotMarker.getLatLng()
      ]);
    });

    scaleMarker.on('dragend', () => {
      saveOverlay(item);
      renderOverlayLayer(item);
    });

    // 3. Выносной рычаг поворота
    const rotPoint = computeRotationHandlePoint(item.center, item.widthMeters, item.heightMeters, item.rotation);
    const topCenter = L.latLng((nw.lat + ne.lat) / 2, (nw.lng + ne.lng) / 2);

    const stemLine = L.polyline([topCenter, rotPoint], {
      pane: 'wm-top-lines',
      color: '#0284c7',
      weight: 2,
      dashArray: '3, 3',
      interactive: false
    }).addTo(item.markersGroup);

    const rotIcon = L.divIcon({
      className: 'wm-overlay-handle-wrap',
      html: '<div class="wm-overlay-handle-dot rotate" title="Повернуть карту (потяните)">↻</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const rotMarker = L.marker(rotPoint, {
      pane: 'wm-overlay-handles',
      icon: rotIcon,
      draggable: true,
      zIndexOffset: 3400
    }).addTo(item.markersGroup);

    rotMarker.on('drag', (e) => {
      const curLatLng = e.target.getLatLng();
      const c = item.center;
      const mPerLng = getMetersPerDegLng(c.lat);

      const dx = (curLatLng.lng - c.lng) * mPerLng;
      const dy = (curLatLng.lat - c.lat) * METERS_PER_DEG_LAT;

      let angleDeg = Math.atan2(dx, dy) * (180 / Math.PI);
      if (angleDeg < 0) angleDeg += 360;

      item.rotation = Math.round(angleDeg);
      item.layer.setRotation(item.rotation);

      const newCorners = computeRotatedCorners(item.center, item.widthMeters, item.heightMeters, item.rotation);
      poly.setLatLngs(newCorners);
      scaleMarker.setLatLng(newCorners[1]);
      if (item.nwSelectPin) item.nwSelectPin.setLatLng(newCorners[0]);

      const curTopCenter = L.latLng((newCorners[0].lat + newCorners[1].lat) / 2, (newCorners[0].lng + newCorners[1].lng) / 2);
      stemLine.setLatLngs([curTopCenter, curLatLng]);

      const rotVal = document.getElementById('ov-hud-rot-val');
      if (rotVal) rotVal.textContent = item.rotation + '°';
    });

    rotMarker.on('dragend', () => {
      saveOverlay(item);
      renderOverlayLayer(item);
    });
  }

  function saveOverlay(item) {
    if (item.isMultiTile) {
      dbPut({
        id: item.id,
        name: item.name,
        isMultiTile: true,
        tiles: item.tiles,
        bounds: item.bounds,
        center: item.center ? { lat: item.center.lat, lng: item.center.lng } : null,
        widthMeters: item.widthMeters || 1000,
        heightMeters: item.heightMeters || 1000,
        visible: item.visible !== false,
        opacity: item.opacity !== undefined ? item.opacity : 85,
        blendMode: item.blendMode || 'normal',
        updatedAt: Date.now()
      });
      return;
    }

    dbPut({
      id: item.id,
      name: item.name,
      isMultiTile: false,
      dataUrl: item.dataUrl,
      center: item.center ? { lat: item.center.lat, lng: item.center.lng } : null,
      widthMeters: item.widthMeters,
      heightMeters: item.heightMeters,
      opacity: item.opacity,
      rotation: item.rotation,
      blendMode: item.blendMode,
      aspectLocked: item.aspectLocked !== false,
      origAspect: getOriginalAspect(item),
      visible: item.visible !== false,
      initial: item.initial || (item.center ? {
        center: { lat: item.center.lat, lng: item.center.lng },
        widthMeters: item.widthMeters,
        heightMeters: item.heightMeters,
        rotation: item.rotation || 0,
        opacity: item.opacity || 80,
        blendMode: item.blendMode || 'normal',
        origAspect: getOriginalAspect(item)
      } : null),
      updatedAt: Date.now()
    });
  }

  function selectOverlay(id) {
    activeOverlayId = id;
    overlays.forEach(it => {
      if (it.id === id) {
        if (!it.isMultiTile) renderOverlayLayer(it);
        openHud(it);
      } else if (it.markersGroup) {
        map.removeLayer(it.markersGroup);
        it.markersGroup = null;
        if (it.nwSelectPin) {
          const el = it.nwSelectPin.getElement();
          if (el) {
            const pin = el.querySelector('.wm-overlay-select-pin');
            if (pin) pin.classList.remove('active');
          }
        }
      }
    });
  }

  function deselectOverlay() {
    if (activeOverlayId && overlays.has(activeOverlayId)) {
      const it = overlays.get(activeOverlayId);
      if (it.markersGroup) {
        map.removeLayer(it.markersGroup);
        it.markersGroup = null;
      }
      if (it.nwSelectPin) {
        const el = it.nwSelectPin.getElement();
        if (el) {
          const pin = el.querySelector('.wm-overlay-select-pin');
          if (pin) pin.classList.remove('active');
        }
      }
    }
    activeOverlayId = null;
    closeHud();
  }

  function nudgeOverlay(dir) {
    if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
    const it = overlays.get(activeOverlayId);
    if (it.isMultiTile || !it.center) return;

    const latMeters = moveStepMeters / METERS_PER_DEG_LAT;
    const lngMeters = moveStepMeters / getMetersPerDegLng(it.center.lat);

    let dLat = 0, dLng = 0;
    if (dir === 'up') dLat = latMeters;
    else if (dir === 'down') dLat = -latMeters;
    else if (dir === 'left') dLng = -lngMeters;
    else if (dir === 'right') dLng = lngMeters;

    it.center = L.latLng(it.center.lat + dLat, it.center.lng + dLng);
    const bounds = computeUnrotatedBounds(it.center, it.widthMeters, it.heightMeters);
    if (it.layer) it.layer.setBounds(bounds);
    renderEditHandles(it);
    if (it.nwSelectPin) {
      const corners = computeRotatedCorners(it.center, it.widthMeters, it.heightMeters, it.rotation);
      it.nwSelectPin.setLatLng(corners[0]);
    }
    saveOverlay(it);
    updateHudCoords(it);
  }

  function scaleOverlay(factor) {
    if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
    const it = overlays.get(activeOverlayId);
    if (it.isMultiTile || !it.center) return;

    it.widthMeters = Math.max(20, Math.round(it.widthMeters * factor));

    if (it.aspectLocked !== false) {
      const aspect = getOriginalAspect(it);
      it.heightMeters = Math.max(20, Math.round(it.widthMeters / aspect));
    } else {
      it.heightMeters = Math.max(20, Math.round(it.heightMeters * factor));
    }

    const bounds = computeUnrotatedBounds(it.center, it.widthMeters, it.heightMeters);
    if (it.layer) it.layer.setBounds(bounds);
    renderEditHandles(it);
    if (it.nwSelectPin) {
      const corners = computeRotatedCorners(it.center, it.widthMeters, it.heightMeters, it.rotation);
      it.nwSelectPin.setLatLng(corners[0]);
    }
    saveOverlay(it);
  }

  function rotateOverlay(degDelta) {
    if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
    const it = overlays.get(activeOverlayId);
    if (it.isMultiTile || !it.center) return;

    it.rotation = ((it.rotation || 0) + degDelta + 360) % 360;
    if (it.layer) it.layer.setRotation(it.rotation);
    renderEditHandles(it);
    if (it.nwSelectPin) {
      const corners = computeRotatedCorners(it.center, it.widthMeters, it.heightMeters, it.rotation);
      it.nwSelectPin.setLatLng(corners[0]);
    }
    saveOverlay(it);
    const rotVal = document.getElementById('ov-hud-rot-val');
    if (rotVal) rotVal.textContent = Math.round(it.rotation) + '°';
  }

  function resetOverlay(id) {
    const targetId = id || activeOverlayId;
    if (!targetId || !overlays.has(targetId)) return;
    const it = overlays.get(targetId);

    if (it.isMultiTile) {
      it.opacity = 85;
      it.blendMode = 'normal';
      if (it.layer) {
        it.layer.setOpacity(0.85);
        it.layer.setBlendMode('normal');
      }
      saveOverlay(it);
      updateHudUI(it);
      WM.ui.showToast('↺ Параметры слоя сброшены');
      return;
    }

    if (it.initial) {
      it.center = L.latLng(it.initial.center.lat, it.initial.center.lng);
      it.widthMeters = it.initial.widthMeters;
      it.heightMeters = it.initial.heightMeters;
      it.rotation = it.initial.rotation || 0;
      it.opacity = it.initial.opacity !== undefined ? it.initial.opacity : 80;
      it.blendMode = it.initial.blendMode || 'normal';
    } else {
      it.rotation = 0;
      it.opacity = 80;
      it.blendMode = 'normal';
    }

    it.aspectLocked = true;
    restoreAspectRatio(it);
    renderOverlayLayer(it);
    updateHudUI(it);
    WM.ui.showToast('↺ Параметры слоя сброшены к начальным');
  }

  function toggleAspectLock() {
    if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
    const it = overlays.get(activeOverlayId);
    if (it.isMultiTile) return;

    const nextLocked = (it.aspectLocked === false);
    it.aspectLocked = nextLocked;

    if (nextLocked) {
      restoreAspectRatio(it);
      WM.ui.showToast('🔒 Пропорции зафиксированы и восстановлены');
    } else {
      saveOverlay(it);
      WM.ui.showToast('🔓 Свободное изменение сторон');
    }

    updateHudUI(it);
  }

  function openHud(item) {
    const hud = document.getElementById('overlay-hud');
    if (!hud) return;
    hud.hidden = false;
    updateHudUI(item);
  }

  function closeHud() {
    const hud = document.getElementById('overlay-hud');
    if (hud) hud.hidden = true;
  }

  function updateHudCoords(item) {
    const coordEl = document.getElementById('ov-hud-center-val');
    if (!coordEl || !item || !item.center) return;
    coordEl.textContent = `${item.center.lat.toFixed(5)}, ${item.center.lng.toFixed(5)}`;
  }

  function updateHudUI(item) {
    const hud = document.getElementById('overlay-hud');
    const title = document.getElementById('ov-hud-title');
    const opacitySlider = document.getElementById('ov-hud-opacity');
    const opacityVal = document.getElementById('ov-hud-opacity-val');
    const rotVal = document.getElementById('ov-hud-rot-val');
    const blendSelect = document.getElementById('ov-hud-blend');
    const lockBtn = document.getElementById('ov-btn-lock-aspect');
    const controlsGrid = hud ? hud.querySelector('.ov-hud-controls-grid') : null;
    const footerLeft = hud ? hud.querySelector('.ov-hud-footer-left') : null;
    
    // --- Обновление иконки и подсказки кнопки видимости ---
    const visBtn = document.getElementById('ov-btn-toggle-vis');
    if (visBtn) {
      const isVis = item.visible !== false;
      visBtn.textContent = isVis ? '👁️' : '🕶️';
      visBtn.title = isVis ? 'Скрыть этот слой' : 'Показать этот слой';
      visBtn.classList.toggle('off', !isVis);
    }
    // ------------------------------------------------------

    if (title) title.textContent = (item.isMultiTile ? '📜 ' : '🗺️ ') + (item.name || 'Слой карты');
    if (opacitySlider) opacitySlider.value = item.opacity !== undefined ? item.opacity : 80;
    if (opacityVal) opacityVal.textContent = (item.opacity !== undefined ? item.opacity : 80) + '%';
    if (rotVal) rotVal.textContent = Math.round(item.rotation || 0) + '°';
    if (blendSelect) blendSelect.value = item.blendMode || 'normal';

    // Для мультитайловых KML карт скрываем лишние элементы управления геометрией
    if (controlsGrid) controlsGrid.style.display = item.isMultiTile ? 'none' : '';
    if (footerLeft) footerLeft.style.display = item.isMultiTile ? 'none' : '';

    if (lockBtn && !item.isMultiTile) {
      const isLocked = item.aspectLocked !== false;
      lockBtn.classList.toggle('active', isLocked);
      lockBtn.textContent = isLocked ? '🔒' : '🔓';
    }

    updateHudCoords(item);
  }

  function initHudEvents() {
    // --- Переключение видимости слоя из HUD ---
    document.getElementById('ov-btn-toggle-vis')?.addEventListener('click', () => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      const it = overlays.get(activeOverlayId);
      const isVisible = WM.imageOverlay.toggleOverlayVisibility(activeOverlayId);
      updateHudUI(it);
      if (window.updateQuickSwapUI) window.updateQuickSwapUI();
      WM.ui.showToast(isVisible ? `👁️ Слой «${it.name}» показан` : `🕶️ Слой «${it.name}» скрыт`);
    });
    // -----------------------------------------

    document.getElementById('ov-btn-nudge-up')?.addEventListener('click', () => nudgeOverlay('up'));
    document.getElementById('ov-btn-nudge-down')?.addEventListener('click', () => nudgeOverlay('down'));
    document.getElementById('ov-btn-nudge-left')?.addEventListener('click', () => nudgeOverlay('left'));
    document.getElementById('ov-btn-nudge-right')?.addEventListener('click', () => nudgeOverlay('right'));

    document.getElementById('ov-btn-scale-plus')?.addEventListener('click', () => scaleOverlay(1.05));
    document.getElementById('ov-btn-scale-minus')?.addEventListener('click', () => scaleOverlay(0.95));

    document.getElementById('ov-btn-rot-ccw')?.addEventListener('click', () => rotateOverlay(-1));
    document.getElementById('ov-btn-rot-cw')?.addEventListener('click', () => rotateOverlay(1));

    document.getElementById('ov-btn-lock-aspect')?.addEventListener('click', toggleAspectLock);
    document.getElementById('ov-btn-reset')?.addEventListener('click', () => resetOverlay());

    document.getElementById('ov-hud-step')?.addEventListener('change', (e) => {
      moveStepMeters = parseFloat(e.target.value) || 5;
    });

    const opSlider = document.getElementById('ov-hud-opacity');
    opSlider?.addEventListener('input', (e) => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      const it = overlays.get(activeOverlayId);
      it.opacity = parseInt(e.target.value, 10);
      document.getElementById('ov-hud-opacity-val').textContent = it.opacity + '%';
      
      if (it.layer && typeof it.layer.setOpacity === 'function') {
        it.layer.setOpacity(it.opacity / 100);
      }
      saveOverlay(it);
    });

    const blendSelect = document.getElementById('ov-hud-blend');
    blendSelect?.addEventListener('change', (e) => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      const it = overlays.get(activeOverlayId);
      it.blendMode = e.target.value;
      
      if (it.layer && typeof it.layer.setBlendMode === 'function') {
        it.layer.setBlendMode(it.blendMode);
      } else {
        const pane = map.getPane('wm-ov-pane-' + it.id);
        if (pane) pane.style.mixBlendMode = it.blendMode;
      }
      saveOverlay(it);
    });

    document.getElementById('ov-btn-flyto')?.addEventListener('click', () => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      const it = overlays.get(activeOverlayId);
      if (it.bounds) {
        map.fitBounds(it.bounds, { padding: [40, 40], maxZoom: 17 });
      } else if (it.center) {
        const b = computeUnrotatedBounds(it.center, it.widthMeters, it.heightMeters);
        map.fitBounds(b, { padding: [50, 50], maxZoom: 18 });
      }
    });

    document.getElementById('ov-btn-delete')?.addEventListener('click', () => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      if (!confirm('Удалить эту наложенную карту?')) return;
      WM.imageOverlay.deleteOverlay(activeOverlayId);
    });

    const hudKmlInput = document.getElementById('ov-hud-kml-input');
    document.getElementById('ov-btn-import-kml')?.addEventListener('click', () => {
      if (!activeOverlayId) return;
      hudKmlInput?.click();
    });

    hudKmlInput?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !activeOverlayId || !overlays.has(activeOverlayId)) {
        if (hudKmlInput) hudKmlInput.value = '';
        return;
      }

      try {
        const text = await file.text();
        const parsed = parseKmlGroundOverlay(text);
        if (parsed && !parsed.isMultiTile) {
          const it = overlays.get(activeOverlayId);
          it.center = parsed.center;
          it.widthMeters = parsed.widthMeters;
          it.heightMeters = parsed.heightMeters;
          it.rotation = parsed.rotation || 0;
          it.aspectLocked = true;
          it.origAspect = it.widthMeters / it.heightMeters;

          renderOverlayLayer(it);
          updateHudUI(it);
          saveOverlay(it);

          const b = computeUnrotatedBounds(it.center, it.widthMeters, it.heightMeters);
          map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
          WM.ui.showToast('✅ Новая привязка KML успешно применена!');
        } else {
          alert('Файл не содержит одиночной привязки GroundOverlay.');
        }
      } catch (err) {
        alert('Ошибка чтения KML: ' + err.message);
      } finally {
        hudKmlInput.value = '';
      }
    });

    document.getElementById('ov-btn-export-kml')?.addEventListener('click', () => {
      if (!activeOverlayId || !overlays.has(activeOverlayId)) return;
      const it = overlays.get(activeOverlayId);
      if (it.isMultiTile || !it.center) return;

      const dLat = (it.heightMeters / 2) / METERS_PER_DEG_LAT;
      const dLng = (it.widthMeters / 2) / getMetersPerDegLng(it.center.lat);
      const north = (it.center.lat + dLat).toFixed(8);
      const south = (it.center.lat - dLat).toFixed(8);
      const east = (it.center.lng + dLng).toFixed(8);
      const west = (it.center.lng - dLng).toFixed(8);
      const rot = Math.round(it.rotation || 0);

      const safeName = (it.name || 'overlay').replace(/[<>&'"]/g, '');

      const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Folder>
    <name>${safeName}</name>
    <GroundOverlay>
      <name>${safeName}</name>
      <Icon><href>${safeName}.png</href></Icon>
      <LatLonBox>
        <north>${north}</north><south>${south}</south>
        <east>${east}</east><west>${west}</west>
        <rotation>${rot}</rotation>
      </LatLonBox>
    </GroundOverlay>
  </Folder>
</kml>`;

      const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${it.name || 'overlay'}.kml`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 400);

      WM.ui.showToast('📄 Файл KML успешно сохранён');
    });

    document.getElementById('ov-btn-close')?.addEventListener('click', deselectOverlay);
  }

  function initAddModal() {
    const modal = document.getElementById('modal-add-overlay');
    const fileImgInput = document.getElementById('ov-input-file');
    const fileKmlInput = document.getElementById('ov-input-kml');
    const btnClearImg = document.getElementById('ov-file-clear');
    const btnClearKml = document.getElementById('ov-kml-clear');
    const centerInput = document.getElementById('ov-input-coords');
    const btnCurCenter = document.getElementById('ov-btn-cur-center');
    const btnSubmit = document.getElementById('ov-btn-submit');
    const btnCancel = document.getElementById('ov-btn-cancel');
    const btnX = document.getElementById('ov-modal-x');
    const kmlHint = document.getElementById('ov-kml-hint');

    let parsedKml = null;

    function resetAddModalForm() {
      if (fileImgInput) fileImgInput.value = '';
      if (fileKmlInput) fileKmlInput.value = '';
      if (btnClearImg) btnClearImg.hidden = true;
      if (btnClearKml) btnClearKml.hidden = true;
      parsedKml = null;

      if (centerInput) {
        centerInput.disabled = false;
        if (map) {
          const c = map.getCenter();
          centerInput.value = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
        } else {
          centerInput.value = '';
        }
      }
      if (btnCurCenter) {
        btnCurCenter.disabled = false;
        btnCurCenter.style.opacity = '';
        btnCurCenter.style.pointerEvents = '';
      }
      if (kmlHint) {
        kmlHint.textContent = 'Если выбран .kml (GroundOverlay), координаты и границы заполнятся автоматически.';
        kmlHint.style.color = '';
      }
      const nameInput = document.getElementById('ov-input-name');
      if (nameInput) nameInput.value = '';
    }

    fileImgInput?.addEventListener('change', (e) => {
      const hasFile = !!(e.target.files && e.target.files.length);
      if (btnClearImg) btnClearImg.hidden = !hasFile;
      const nameInput = document.getElementById('ov-input-name');
      if (hasFile && nameInput && !nameInput.value.trim()) {
        nameInput.value = e.target.files[0].name.replace(/\.[^/.]+$/, '');
      }
    });

    btnClearImg?.addEventListener('click', () => {
      if (fileImgInput) fileImgInput.value = '';
      if (btnClearImg) btnClearImg.hidden = true;
    });

    btnCurCenter?.addEventListener('click', () => {
      if (centerInput && map && !centerInput.disabled) {
        const c = map.getCenter();
        centerInput.value = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
      }
    });

    fileKmlInput?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) {
        if (btnClearKml) btnClearKml.hidden = true;
        return;
      }
      const text = await file.text();
      parsedKml = parseKmlGroundOverlay(text);
      if (parsedKml) {
        if (btnClearKml) btnClearKml.hidden = false;

        const nameInput = document.getElementById('ov-input-name');
        if (nameInput && (!nameInput.value.trim() || parsedKml.name)) {
          nameInput.value = parsedKml.name || file.name.replace(/\.[^/.]+$/, '');
        }

        if (centerInput) {
          centerInput.value = `${parsedKml.center.lat.toFixed(6)}, ${parsedKml.center.lng.toFixed(6)}`;
          centerInput.disabled = true;
        }
        if (btnCurCenter) {
          btnCurCenter.disabled = true;
          btnCurCenter.style.opacity = '0.4';
          btnCurCenter.style.pointerEvents = 'none';
        }

        if (parsedKml.isMultiTile) {
          if (kmlHint) {
            kmlHint.textContent = `🌐 Найдено тайлов: ${parsedKml.tiles.length} шт. Файл картинки выбирать не нужно!`;
            kmlHint.style.color = 'var(--accent)';
          }
          WM.ui.showToast(`✅ Найдено ${parsedKml.tiles.length} тайлов. Нажмите «Поместить на карту»!`);
        } else {
          if (kmlHint) {
            kmlHint.textContent = '🔒 Координаты и границы зафиксированы из KML.';
            kmlHint.style.color = 'var(--accent)';
          }
          WM.ui.showToast('✅ Параметры взяты из KML! Теперь выберите файл картинки.');
        }
      } else {
        alert('Не удалось найти блоки <LatLonBox> или <GroundOverlay> в файле KML');
        fileKmlInput.value = '';
        if (btnClearKml) btnClearKml.hidden = true;
      }
    });

    btnClearKml?.addEventListener('click', () => {
      if (fileKmlInput) fileKmlInput.value = '';
      parsedKml = null;
      if (btnClearKml) btnClearKml.hidden = true;

      if (centerInput) {
        centerInput.disabled = false;
        if (map) {
          const c = map.getCenter();
          centerInput.value = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
        }
      }
      if (btnCurCenter) {
        btnCurCenter.disabled = false;
        btnCurCenter.style.opacity = '';
        btnCurCenter.style.pointerEvents = '';
      }
      if (kmlHint) {
        kmlHint.textContent = 'Если выбран .kml (GroundOverlay), координаты и границы заполнятся автоматически.';
        kmlHint.style.color = '';
      }
    });

    btnSubmit?.addEventListener('click', async () => {
      // 1. ОНЛАЙН МУЛЬТИТАЙЛОВЫЙ KML
      if (parsedKml && parsedKml.isMultiTile) {
        const overlayName = document.getElementById('ov-input-name').value.trim() 
          || parsedKml.name 
          || 'Карта KML';

        const customLayerId = 'kml_layer_' + Date.now();
        const layerDisplayName = '📜 ' + overlayName;

        const kmlLayer = new KmlTileLayer(parsedKml.tiles, parsedKml.bounds, {
          opacity: 0.85
        });

        const newOverlayItem = {
          id: customLayerId,
          name: overlayName,
          isMultiTile: true,
          tiles: parsedKml.tiles,
          bounds: parsedKml.bounds,
          center: parsedKml.center,
          widthMeters: parsedKml.widthMeters,
          heightMeters: parsedKml.heightMeters,
          visible: true,
          opacity: 85,
          blendMode: 'normal',
          layer: kmlLayer
        };

        saveOverlay(newOverlayItem);
        overlays.set(customLayerId, newOverlayItem);

        kmlLayer.addTo(map);

        if (WM.layersControl) {
          WM.layersControl.addOverlay(kmlLayer, layerDisplayName);
        }

        map.fitBounds(parsedKml.bounds, { padding: [30, 30], maxZoom: 16 });

        modal.classList.remove('open');
        resetAddModalForm();
        WM.ui.showToast(`✅ Слой «${overlayName}» добавлен на карту!`);
        return;
      }

      // 2. СТАНДАРТНАЯ ОДИНОЧНАЯ КАРТИНКА
      const file = fileImgInput.files[0];
      if (!file) {
        alert('Пожалуйста, выберите файл изображения (или укажите KML файл с тайлами)');
        return;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`Файл слишком большой (${(file.size / (1024 * 1024)).toFixed(1)} МБ). Лимит — 25 МБ.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (re) => {
        const dataUrl = re.target.result;
        const img = new Image();
        img.onload = () => {
          const pixels = img.naturalWidth * img.naturalHeight;
          if (pixels > MAX_IMAGE_PIXELS) {
            alert(`Слишком высокое разрешение (${img.naturalWidth}x${img.naturalHeight} px). Максимальный лимит — 4096x4096 px.`);
            return;
          }

          let center = map.getCenter();
          const coordStr = centerInput.value.trim();
          if (coordStr) {
            const parts = coordStr.split(/[\s,]+/);
            if (parts.length >= 2) {
              const pLat = parseFloat(parts[0]);
              const pLng = parseFloat(parts[1]);
              if (!isNaN(pLat) && !isNaN(pLng)) center = L.latLng(pLat, pLng);
            }
          }

          let widthMeters, heightMeters, rotation = 0;
          if (parsedKml) {
            center = parsedKml.center || center;
            widthMeters = parsedKml.widthMeters;
            heightMeters = parsedKml.heightMeters;
            rotation = parsedKml.rotation || 0;
          } else {
            const aspect = (img.naturalWidth || 1) / (img.naturalHeight || 1);
            heightMeters = 800;
            widthMeters = Math.round(heightMeters * aspect);
          }

          const overlayName = document.getElementById('ov-input-name').value.trim() || file.name.replace(/\.[^/.]+$/, '');
          const origAspect = widthMeters / heightMeters;

          const newOverlay = {
            id: 'ov_' + Date.now(),
            name: overlayName,
            isMultiTile: false,
            dataUrl,
            center,
            widthMeters,
            heightMeters,
            opacity: 80,
            rotation,
            blendMode: 'normal',
            aspectLocked: true,
            origAspect,
            visible: true,
            initial: {
              center: { lat: center.lat, lng: center.lng },
              widthMeters,
              heightMeters,
              rotation,
              opacity: 80,
              blendMode: 'normal',
              origAspect
            }
          };

          overlays.set(newOverlay.id, newOverlay);
          saveOverlay(newOverlay);
          renderOverlayLayer(newOverlay);
          selectOverlay(newOverlay.id);

          modal.classList.remove('open');
          resetAddModalForm();
          WM.ui.showToast(`🗺️ Слой «${overlayName}» наложен на карту!`);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });

    const closeModal = () => {
      modal.classList.remove('open');
      resetAddModalForm();
    };
    btnCancel?.addEventListener('click', closeModal);
    btnX?.addEventListener('click', closeModal);
  }

  function openOverlaysListModal() {
    const modal = document.getElementById('modal-overlays-list');
    const container = document.getElementById('overlays-list-items');
    if (!modal || !container) return;

    container.innerHTML = '';
    const list = Array.from(overlays.values());

    if (!list.length) {
      container.innerHTML = '<div class="muted">Наложенных карт пока нет. Нажмите «+ Добавить карту».</div>';
    } else {
      list.forEach(item => {
        const row = document.createElement('div');
        row.className = 'overlay-list-item' + (activeOverlayId === item.id ? ' active' : '');
        
        const isKml = !!item.isMultiTile;
        const metaText = isKml
          ? `🌐 KML-тайлы (${item.tiles ? item.tiles.length : 0} шт.) · Прозрачность: ${item.opacity !== undefined ? item.opacity : 85}%`
          : `Прозрачность: ${item.opacity}% · Поворот: ${Math.round(item.rotation || 0)}° · ${Math.round(item.widthMeters)}×${Math.round(item.heightMeters)} м`;

        row.innerHTML = `
          <div class="overlay-list-info" style="cursor: pointer;">
            <span class="overlay-list-name">${isKml ? '📜 ' : '🗺️ '}${escapeHtml(item.name)}</span>
            <small class="overlay-list-meta">${metaText}</small>
          </div>
          <div class="overlay-list-actions">
            <button type="button" class="icon-btn-sm btn-vis" title="${item.visible !== false ? 'Скрыть' : 'Показать'}">${item.visible !== false ? '👁️' : '🕶️'}</button>
            <button type="button" class="icon-btn-sm btn-reset" title="Сбросить прозрачность">↺</button>
            <button type="button" class="icon-btn-sm btn-edit" title="Панель настроек">⚙️</button>
            <button type="button" class="icon-btn-sm btn-del" title="Удалить" style="color:var(--danger);">🗑️</button>
          </div>
        `;

        // Клик по названию центрирует карту на слое
        row.querySelector('.overlay-list-info').onclick = () => {
          modal.classList.remove('open');
          if (item.bounds) {
            map.fitBounds(item.bounds, { padding: [40, 40], maxZoom: 17 });
          } else if (item.center) {
            const b = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);
            map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
          }
        };

        // Переключение видимости
        row.querySelector('.btn-vis').onclick = (e) => {
          e.stopPropagation();
          const nextVis = (item.visible === false);
          item.visible = nextVis;
          localStorage.setItem('wm_layer_vis_' + item.id, nextVis ? 'true' : 'false');
          saveOverlay(item);

          if (isKml) {
            if (nextVis) {
              if (item.layer && !map.hasLayer(item.layer)) item.layer.addTo(map);
            } else {
              if (item.layer && map.hasLayer(item.layer)) map.removeLayer(item.layer);
            }
          } else {
            renderOverlayLayer(item);
          }
          openOverlaysListModal();
        };

        row.querySelector('.btn-reset').onclick = (e) => {
          e.stopPropagation();
          resetOverlay(item.id);
          openOverlaysListModal();
        };

        row.querySelector('.btn-edit').onclick = (e) => {
          e.stopPropagation();
          modal.classList.remove('open');
          selectOverlay(item.id);
          if (item.bounds) {
            map.fitBounds(item.bounds, { padding: [40, 40], maxZoom: 17 });
          } else if (item.center) {
            const b = computeUnrotatedBounds(item.center, item.widthMeters, item.heightMeters);
            map.fitBounds(b, { maxZoom: 17 });
          }
        };

        row.querySelector('.btn-del').onclick = (e) => {
          e.stopPropagation();
          if (confirm(`Удалить карту «${item.name}»?`)) {
            WM.imageOverlay.deleteOverlay(item.id);
            openOverlaysListModal();
          }
        };

        container.appendChild(row);
      });
    }

    modal.classList.add('open');
  }

  WM.imageOverlay = {
    async init(m) {
      map = m;

      if (!map.getPane('wm-overlay-handles')) {
        const handlesPane = map.createPane('wm-overlay-handles');
        handlesPane.style.zIndex = 550;
      }

      await openDB();
      const saved = await dbGetAll();

      saved.forEach(it => {
        // 1. МНОГОТАЙЛОВЫЙ СЛОЙ КАРТЫ (KML)
        if (it.isMultiTile && Array.isArray(it.tiles) && it.bounds) {
          const kmlLayer = new KmlTileLayer(it.tiles, it.bounds, {
            opacity: (it.opacity !== undefined ? it.opacity : 85) / 100,
            blendMode: it.blendMode || 'normal',
            name: it.name // <-- передаем имя
          });
          it.layer = kmlLayer;
          overlays.set(it.id, it);

          const isSavedVisible = localStorage.getItem('wm_layer_vis_' + it.id) !== null
            ? localStorage.getItem('wm_layer_vis_' + it.id) === 'true'
            : (it.visible !== false);

          it.visible = isSavedVisible;

          if (isSavedVisible) {
            kmlLayer.addTo(map);
          }

          if (WM.layersControl) {
            WM.layersControl.addOverlay(kmlLayer, '📜 ' + it.name);
          }

          map.on('overlayadd', (e) => {
            if (e.layer === kmlLayer) {
              it.visible = true;
              localStorage.setItem('wm_layer_vis_' + it.id, 'true');
              saveOverlay(it);
            }
          });

          map.on('overlayremove', (e) => {
            if (e.layer === kmlLayer) {
              it.visible = false;
              localStorage.setItem('wm_layer_vis_' + it.id, 'false');
              saveOverlay(it);
            }
          });

          return;
        }

        // 2. ОДИНОЧНАЯ КАРТИНКА С РУЧНОЙ ПРИВЯЗКОЙ
        if (it.bounds && (!it.center || !it.widthMeters)) {
          const s = it.bounds[0][0], w = it.bounds[0][1], n = it.bounds[1][0], e = it.bounds[1][1];
          it.center = L.latLng((s + n) / 2, (w + e) / 2);
          it.heightMeters = Math.abs(n - s) * METERS_PER_DEG_LAT;
          it.widthMeters = Math.abs(e - w) * getMetersPerDegLng(it.center.lat);
        } else if (it.center) {
          it.center = L.latLng(it.center.lat, it.center.lng);
        }

        it.aspectLocked = it.aspectLocked !== false;
        it.origAspect = getOriginalAspect(it);

        if (it.aspectLocked) {
          it.heightMeters = Math.max(20, Math.round(it.widthMeters / it.origAspect));
        }

        overlays.set(it.id, it);
        renderOverlayLayer(it);
      });

      initHudEvents();
      initAddModal();

      map.on('zoomend', () => {
        if (activeOverlayId && overlays.has(activeOverlayId)) {
          const it = overlays.get(activeOverlayId);
          if (it.visible && !it.isMultiTile) {
            renderEditHandles(it);
          }
        }
      });

      document.getElementById('overlays-list-x')?.addEventListener('click', () => {
        document.getElementById('modal-overlays-list')?.classList.remove('open');
      });

      document.getElementById('btn-open-add-overlay-modal')?.addEventListener('click', () => {
        document.getElementById('modal-overlays-list')?.classList.remove('open');
        this.openAddDialog();
      });
    },

    openAddDialog() {
      const modal = document.getElementById('modal-add-overlay');
      const centerInput = document.getElementById('ov-input-coords');
      const btnCurCenter = document.getElementById('ov-btn-cur-center');
      if (modal) {
        if (centerInput && map) {
          centerInput.disabled = false;
          const c = map.getCenter();
          centerInput.value = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
        }
        if (btnCurCenter) {
          btnCurCenter.disabled = false;
          btnCurCenter.style.opacity = '';
          btnCurCenter.style.pointerEvents = '';
        }
        modal.classList.add('open');
      }
    },

    openManager() {
      openOverlaysListModal();
    },

    getKmlOverlays() {
      return Array.from(overlays.values()).filter(it => it.isMultiTile);
    },

    getOverlay(id) {
      return overlays.get(id);
    },

    toggleOverlayVisibility(id) {
      const it = overlays.get(id);
      if (!it) return false;
      const nextVis = (it.visible === false);
      it.visible = nextVis;
      localStorage.setItem('wm_layer_vis_' + it.id, nextVis ? 'true' : 'false');
      saveOverlay(it);

      if (it.isMultiTile) {
        if (nextVis) {
          if (it.layer && !map.hasLayer(it.layer)) it.layer.addTo(map);
        } else {
          if (it.layer && map.hasLayer(it.layer)) map.removeLayer(it.layer);
        }
      } else {
        renderOverlayLayer(it);
      }
      return nextVis;
    },

    

    deleteOverlay(id) {
      if (!overlays.has(id)) return;
      const it = overlays.get(id);

      if (localStorage.getItem('wm_quick_swap_target') === 'kml:' + id) {
        localStorage.removeItem('wm_quick_swap_target');
        if (window.updateQuickSwapUI) window.updateQuickSwapUI();
      }

      // Полное удаление из карты и контрола слоёв Leaflet
      if (it.layer) {
        if (WM.layersControl) {
          WM.layersControl.removeLayer(it.layer);
        }
        if (map && map.hasLayer(it.layer)) {
          map.removeLayer(it.layer);
        }
      }

      if (it.markersGroup && map) map.removeLayer(it.markersGroup);
      if (it.nwSelectPin && map) map.removeLayer(it.nwSelectPin);

      const paneName = 'wm-ov-pane-' + id;
      if (map) {
        const pane = map.getPane(paneName);
        if (pane && pane.parentNode) {
          pane.parentNode.removeChild(pane);
          if (map._panes) delete map._panes[paneName];
        }
      }

      localStorage.removeItem('wm_layer_vis_' + id);
      overlays.delete(id);
      dbDelete(id);
      if (activeOverlayId === id) deselectOverlay();
      WM.ui.showToast('🗑️ Карта удалена');
    },

    exportData() {
      return [];
    },

    importData(items) {
      if (!Array.isArray(items)) return;
      this.clearAll();
      items.forEach(it => {
        if (!it || !it.id) return;
        if (it.isMultiTile) {
          overlays.set(it.id, it);
          saveOverlay(it);
          if (map) renderOverlayLayer(it);
          return;
        }
        if (!it.dataUrl || !it.center) return;
        it.center = L.latLng(it.center.lat, it.center.lng);
        it.aspectLocked = it.aspectLocked !== false;
        it.origAspect = it.origAspect || getOriginalAspect(it);
        it.visible = it.visible !== false;
        if (it.aspectLocked) {
          it.heightMeters = Math.max(20, Math.round(it.widthMeters / it.origAspect));
        }
        overlays.set(it.id, it);
        saveOverlay(it);
        if (map) renderOverlayLayer(it);
      });
    },

    clearAll() {
      overlays.forEach(it => {
        if (it.layer) {
          if (WM.layersControl) WM.layersControl.removeLayer(it.layer);
          if (map && map.hasLayer(it.layer)) map.removeLayer(it.layer);
        }
        if (it.markersGroup && map) map.removeLayer(it.markersGroup);
        if (it.nwSelectPin && map) map.removeLayer(it.nwSelectPin);

        const paneName = 'wm-ov-pane-' + id;
        if (map) {
          const pane = map.getPane(paneName);
          if (pane && pane.parentNode) {
            pane.parentNode.removeChild(pane);
            if (map._panes) delete map._panes[paneName];
          }
        }
        localStorage.removeItem('wm_layer_vis_' + it.id);
      });

      overlays.clear();
      activeOverlayId = null;
      closeHud();

      if (db) {
        try {
          const tx = db.transaction('overlays', 'readwrite');
          tx.objectStore('overlays').clear();
        } catch (e) {}
      }
    },

    count: () => overlays.size,
    isEditing: () => !!activeOverlayId,
    closeEditing: deselectOverlay,
    resetCurrent: () => resetOverlay()
  };
})();
