(async function () {
  const WM = window.WM, C = WM.config;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wm_view')); } catch (e) {}

  const map = L.map('map', { 
    zoomControl: false, 
    doubleClickZoom: false,
    preferCanvas: true, // <-- ДОБАВИТЬ: все слои по умолчанию рисуются на Canvas
    tapTolerance: 20, 
    maxZoom: 19, 
    minZoom: 3,
    zoomSnap: 0.5,
    zoomDelta: 0.5
  }).setView(saved ? saved.c : [55.751244, 37.618423], saved ? saved.z : 16);

  L.control.zoom({ position: 'topleft' }).addTo(map);

  // --- Базовые слои карты (без ограничений Referer и без ошибок 403) ---

  // 1. Спутниковые снимки Esri
  // 1. Спутник Esri
  const satEsri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Esri'
  }).addTo(map);

  // 2. Спутник Google + Дороги (Гибрид)
  const satGoogle = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
    attribution: '© Google'
  });

  // 3. Схема Google (детальные дороги, дома и подписи)
  const schemeGoogle = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
    attribution: '© Google'
  });

  // 4. Схема Esri Streets
  const schemeEsri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Esri'
  });

  // 5. Тёмная карта Esri Dark Canvas (работает без ключей!)
  const schemeDark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16,
    attribution: 'Esri, HERE, DeLorme'
  });

  // 6. Классический OSM (зеркало OpenStreetMap France без блокировки 403)
  const osmClassic = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
    subdomains: ['a', 'b', 'c'],
    maxZoom: 19,
    attribution: '© OpenStreetMap France'
  });

  // Растровый тайловый слой с прозрачными контурами объектов Wikimapia
  const WmRasterLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const hash = (coords.x % 4) + (coords.y % 4) * 4;
      return L.Util.template(this._url, L.extend({
        s: this._getSubdomain(coords),
        z: this._getZoomForUrl(),
        x: coords.x,
        y: coords.y,
        hash
      }, this.options));
    }
  });

  const wmContours = new WmRasterLayer('https://i{hash}.wikimapia.org/?x={x}&y={y}&zoom={z}&type=hybrid&lng=1', {
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    maxZoom: 18,
    opacity: 1.0,               // увеличиваем прозрачность до максимума
    className: 'wm-raster-tile' // вешаем специальный класс
  }).addTo(map);

  // Синхронизация растрового слоя в зависимости от выбранного режима работы
  function syncOverlayMode() {
    const mode = WM.ui ? WM.ui.getWorkMode() : 'hybrid';
    
    if (mode === 'manual' || mode === 'nakarte') {
      // В ручном режиме и режиме Nakarte растровые контуры активны всегда
      if (!map.hasLayer(wmContours)) map.addLayer(wmContours);
    } else if (mode === 'auto') {
      if (map.hasLayer(wmContours)) map.removeLayer(wmContours);
    } else {
      // Гибридный режим
      if (map.getZoom() >= C.VECTOR_ZOOM) {
        if (map.hasLayer(wmContours)) map.removeLayer(wmContours);
      } else {
        if (!map.hasLayer(wmContours)) map.addLayer(wmContours);
      }
    }
  }

  window.syncRasterOverlay = syncOverlayMode;
  map.on('zoomend', syncOverlayMode);

  // Контрол переключения слоёв
  const baseLayers = {
    'Спутник (Esri)': satEsri,
    'Спутник + Дороги (Google)': satGoogle,
    'Схема (Google)': schemeGoogle,
    'Схема (Esri Streets)': schemeEsri,
    'Схема OSM (Классика)': osmClassic,
    'Тёмная карта (Esri)': schemeDark
  };

  const overlayLayers = {
    'Контуры Wikimapia': wmContours
  };

  L.control.layers(baseLayers, overlayLayers, { position: 'topright' }).addTo(map);

  WM.map = map;

  await WM.cache.init();

  WM.view.init(map);
  WM.picker.init(map);
  WM.ui.init();

  syncOverlayMode();

  let renderTimer = 0;
  function refreshStatus() {
    const s = WM.loader.stats();
    const mode = WM.ui ? WM.ui.getWorkMode() : 'manual';
    const autoHover = WM.ui && WM.ui.isAutoHoverEnabled();

    // Показываем кнопку перехода к получению ключа, если все ключи в паузе/блоке
    if (WM.ui && WM.ui.toggleTopGetKeyBtn) {
      WM.ui.toggleTopGetKeyBtn(!!s.isRateWaiting || (!!s.blocked && /ключ|key|limit|quota/i.test(s.blocked)));
    }

    if (s.blocked) return WM.ui.setStatus('⚠ ' + s.blocked, true);
    if (s.isRateWaiting) return WM.ui.setStatus(`⏳ Лимит ключей\nПауза: ${WM.ui.fmtTimer(s.waitMs)}`, true);

    if (mode === 'manual') {
      return WM.ui.setStatus(`Ручной режим (только растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'} · в памяти: ${WM.view.count()}`);
    }

    if (map.getZoom() < C.MIN_ZOOM) return WM.ui.setStatus(`Масштаб < ${C.MIN_ZOOM}\n(приблизьте карту)`);

    if (mode === 'hybrid' && map.getZoom() < C.VECTOR_ZOOM) {
      return WM.ui.setStatus(`Гибридный режим (растр)\n${autoHover ? 'Наведите или кликните' : 'Кликните для загрузки'} · в памяти: ${WM.view.count()}`);
    }

    let t = `Объектов: ${WM.view.count()}`;
    if (s.active) t += `\nЗагрузка тайлов: ${s.active}`;
    if (s.errors) t += s.failed ? ` · ошибок: ${s.failed}` : ' · повтор…';
    WM.ui.setStatus(t, !!s.failed);
  }

  window.refreshAppStatus = refreshStatus;

  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      WM.view.render();
      refreshStatus();
      WM.picker.refresh();
    }, 60);
  };

  WM.loader.init(map, { onChange: scheduleRender, onStatus: refreshStatus });

  let moveTimer = 0;
  map.on('moveend', () => {
    WM.view.render();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => WM.loader.update(), 200);
    try {
      const c = map.getCenter();
      localStorage.setItem('wm_view', JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom() }));
    } catch (e) {}
  });

  window.addEventListener('online', () => WM.loader.retryNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) WM.loader.retryNow(); });

  let me = null;
  document.getElementById('btn-location').onclick = () => {
    if (!navigator.geolocation) return alert('Геолокация не поддерживается');
    navigator.geolocation.getCurrentPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (me) me.setLatLng(ll);
      else me = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#0284c7', fillOpacity: 1, interactive: false }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 16));
    }, e => alert('Ошибка геопозиции: ' + e.message), { enableHighAccuracy: true, timeout: 15000 });
  };

  const savedMode = WM.api.store.get('wm_mode') || 'cross';
  WM.picker.setMode(savedMode);

  WM.view.render();
  WM.loader.update();
  refreshStatus();
})();
