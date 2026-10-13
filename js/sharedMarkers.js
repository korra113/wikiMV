(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // Настройки подключения к публичному брокеру
  const MQTT_BROKER = 'broker.hivemq.com';
  const MQTT_PORT = 8884; // WSS
  const MQTT_PATH = '/mqtt';
  const TOPIC_PREFIX = 'wm_live_v1/grid/';

  let map = null;
  let client = null;
  let isConnected = false;
  let canvasRenderer = null;
  let sharedLayerGroup = null;

  // Уникальный ID устройства (генерируется один раз)
  let deviceId = localStorage.getItem('wm_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('wm_device_id', deviceId);
  }

  // Настройки из localStorage (по умолчанию ВСЕ ВЫКЛЮЧЕНЫ)
  let cfg = {
    share: localStorage.getItem('wm_share_markers_enabled') === 'true',
    download: localStorage.getItem('wm_download_foreign_markers') === 'true',
    show: localStorage.getItem('wm_show_foreign_markers') === 'true'
  };

  // Хранилище чужих меток: id -> markerData
  const foreignMarkers = new Map();
  // Leaflet слои: id -> { marker, type: 'dot' | 'badge' }
  const renderedLayers = new Map();

  // Активные подписки на квадраты
  const activeGridSubs = new Set();
  let subDebounceTimer = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function getGridKey(lat, lng) {
    return `${Math.floor(lat)}_${Math.floor(lng)}`;
  }

  // --- 1. MQTT СОЕДИНЕНИЕ ---
  function initMqtt() {
    if (!window.Paho || client || (!cfg.share && !cfg.download)) return;

    try {
      client = new Paho.MQTT.Client(MQTT_BROKER, Number(MQTT_PORT), MQTT_PATH, deviceId + '_' + Date.now().toString(36));

      client.onConnectionLost = (resp) => {
        isConnected = false;
        updateStatusUI('🟡 Соединение разорвано. Повтор...');
        activeGridSubs.clear();
        setTimeout(connectMqtt, 3500);
      };

      client.onMessageArrived = (message) => {
        handleIncomingMessage(message.destinationName, message.payloadString);
      };

      connectMqtt();
    } catch (e) {
      console.warn('[SharedMarkers] Ошибка инициализации Paho:', e);
    }
  }

  function connectMqtt() {
    if (!client || isConnected) return;

    updateStatusUI('⏳ Подключение к эфиру (MQTT)...');
    client.connect({
      useSSL: true,
      timeout: 10,
      keepAliveInterval: 30,
      cleanSession: true,
      onSuccess: () => {
        isConnected = true;
        updateStatusUI('🟢 В сети (эфир активен)');
        if (cfg.download) syncGridSubscriptions();
        if (cfg.share) broadcastOwnMarkers();
      },
      onFailure: (err) => {
        isConnected = false;
        updateStatusUI('🔴 Ошибка подключения к эфиру');
        setTimeout(connectMqtt, 5000);
      }
    });
  }

  function disconnectMqtt() {
    if (client && isConnected) {
      // При выходе шлем очистку своих меток
      if (cfg.share) clearOwnBroadcast();
      try { client.disconnect(); } catch (e) {}
    }
    client = null;
    isConnected = false;
    activeGridSubs.clear();
    updateStatusUI('Выключено');
  }

  // --- 2. РАССЫЛКА СВОИХ МЕТОК ---
  function broadcastOwnMarkers() {
    if (!client || !isConnected || !cfg.share || !WM.markers) return;

    const ownMarkers = WM.markers.getAll ? WM.markers.getAll() : [];
    // Группируем свои метки по сетке
    const gridMap = new Map();

    ownMarkers.forEach(m => {
      const gKey = getGridKey(m.lat, m.lng);
      if (!gridMap.has(gKey)) gridMap.set(gKey, []);
      gridMap.get(gKey).push({
        id: m.id,
        lat: m.lat,
        lng: m.lng,
        emoji: m.emoji || '📍',
        text: m.text || '',
        color: m.color || '#3b82f6',
        u: Date.now()
      });
    });

    gridMap.forEach((markers, gKey) => {
      const topic = `${TOPIC_PREFIX}${gKey}/${deviceId}`;
      const payload = JSON.stringify({ sender: deviceId, markers });
      const msg = new Paho.MQTT.Message(payload);
      msg.destinationName = topic;
      msg.retained = true; // Сохраняется на брокере для вновь вошедших
      msg.qos = 0;
      client.send(msg);
    });
  }

  function clearOwnBroadcast() {
    if (!client || !isConnected || !WM.markers) return;
    const ownMarkers = WM.markers.getAll ? WM.markers.getAll() : [];
    const sentGrids = new Set(ownMarkers.map(m => getGridKey(m.lat, m.lng)));

    sentGrids.forEach(gKey => {
      const topic = `${TOPIC_PREFIX}${gKey}/${deviceId}`;
      const msg = new Paho.MQTT.Message('');
      msg.destinationName = topic;
      msg.retained = true; // Стирает retained-сообщение на брокере
      try { client.send(msg); } catch (e) {}
    });
  }

  // --- 3. ПРИЕМ ЧУЖИХ МЕТОК ---
  function syncGridSubscriptions() {
    if (!client || !isConnected || !cfg.download || !map) return;

    const b = map.getBounds().pad(0.1);
    const minLat = Math.floor(b.getSouth()), maxLat = Math.floor(b.getNorth());
    const minLng = Math.floor(b.getWest()), maxLng = Math.floor(b.getEast());

    const neededSubs = new Set();
    for (let lat = minLat; lat <= maxLat; lat++) {
      for (let lng = minLng; lng <= maxLng; lng++) {
        neededSubs.add(`${lat}_${lng}`);
      }
    }

    // Подписываемся на новые квадраты
    neededSubs.forEach(gKey => {
      if (!activeGridSubs.has(gKey)) {
        activeGridSubs.add(gKey);
        client.subscribe(`${TOPIC_PREFIX}${gKey}/#`, { qos: 0 });
      }
    });

    // Отписываемся от квадратов, ушедших за горизонт (экономия трафика)
    activeGridSubs.forEach(gKey => {
      if (!neededSubs.has(gKey)) {
        activeGridSubs.delete(gKey);
        client.unsubscribe(`${TOPIC_PREFIX}${gKey}/#`);
        // Удаляем из памяти метки ушедшего квадрата
        for (const [id, m] of foreignMarkers) {
          if (getGridKey(m.lat, m.lng) === gKey) {
            foreignMarkers.delete(id);
          }
        }
      }
    });

    renderVisible();
  }

  function handleIncomingMessage(topic, payload) {
    if (!cfg.download) return;

    // Пустой payload означает удаление метки
    if (!payload || payload.trim() === '') {
      const parts = topic.split('/');
      const sender = parts[parts.length - 1];
      for (const [id, m] of foreignMarkers) {
        if (m.sender === sender) foreignMarkers.delete(id);
      }
      renderVisible();
      return;
    }

    try {
      const data = JSON.parse(payload);
      if (data.sender === deviceId) return; // Игнорируем собственные метки

      const items = Array.isArray(data.markers) ? data.markers : [];
      items.forEach(it => {
        foreignMarkers.set(it.id, {
          id: it.id,
          sender: data.sender,
          lat: it.lat,
          lng: it.lng,
          emoji: it.emoji,
          text: it.text,
          color: it.color,
          u: it.u
        });
      });

      renderVisible();
      updateStatusUI(`🟢 В сети · Чужих меток: ${foreignMarkers.size}`);
    } catch (e) {}
  }

  // --- 4. ДВУХУРОВНЕВАЯ ОТРИСОВКА (CANVAS + DOM PLATES) ---
  function createForeignPopup(item) {
    const wrap = document.createElement('div');
    wrap.className = 'wm-foreign-popup';
    wrap.innerHTML = `
      <div class="wm-foreign-pop-header">
        <span class="wm-foreign-pop-emoji">${item.emoji}</span>
        <div class="wm-foreign-pop-meta">
          <div class="wm-foreign-pop-badge">📡 Чужая метка (Live)</div>
          <div class="wm-foreign-pop-coords">${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}</div>
        </div>
      </div>
      ${item.text ? `<div class="wm-foreign-pop-text">${escapeHtml(item.text)}</div>` : ''}
      <button type="button" class="btn btn-primary btn-save-foreign" style="width: 100%; margin-top: 6px; font-size: 12px; padding: 6px;">
        💾 Сохранить в свои метки
      </button>
    `;

    L.DomEvent.disableClickPropagation(wrap);

    const btnSave = wrap.querySelector('.btn-save-foreign');
    if (btnSave) {
      btnSave.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (WM.markers) {
          const newOwn = {
            id: 'marker_' + Date.now(),
            lat: item.lat,
            lng: item.lng,
            emoji: item.emoji,
            color: item.color,
            text: item.text,
            createdAt: Date.now()
          };
          const all = WM.markers.getAll ? WM.markers.getAll() : [];
          all.push(newOwn);
          if (WM.markers.importData) WM.markers.importData(all);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Метка скопирована в ваши личные!');
        }
      };
    }

    return wrap;
  }

  function createDotMarker(item) {
    const marker = L.circleMarker([item.lat, item.lng], {
      renderer: canvasRenderer,
      radius: 6.5,
      fillColor: item.color || '#8b5cf6',
      color: '#ffffff',
      weight: 2,
      fillOpacity: 0.9,
      interactive: true
    });
    marker.bindPopup(() => createForeignPopup(item), { offset: [0, -4] });
    return marker;
  }

  function createBadgeMarker(item) {
    const textHtml = item.text ? `<span class="wm-foreign-badge-text">${escapeHtml(item.text)}</span>` : '';
    const html = `
      <div class="wm-foreign-pin-anchor">
        <div class="wm-foreign-badge" style="--f-color: ${item.color || '#8b5cf6'};">
          <span class="wm-foreign-badge-radar">📡</span>
          <span class="wm-foreign-badge-emoji">${item.emoji}</span>
          ${textHtml}
        </div>
        <div class="wm-foreign-pin-dot" style="background:${item.color || '#8b5cf6'};"></div>
      </div>
    `;

    const marker = L.marker([item.lat, item.lng], {
      icon: L.divIcon({
        className: 'wm-foreign-div-icon',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: true,
      zIndexOffset: 900
    });

    marker.bindPopup(() => createForeignPopup(item), { offset: [0, -32] });
    return marker;
  }

  function renderVisible() {
    if (!map || !sharedLayerGroup) return;

    if (!cfg.show || !cfg.download || foreignMarkers.size === 0) {
      sharedLayerGroup.clearLayers();
      renderedLayers.clear();
      return;
    }

    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.1);
    const visibleItems = [];

    foreignMarkers.forEach(m => {
      if (bounds.contains([m.lat, m.lng])) visibleItems.push(m);
    });

    const canUseBadges = zoom >= 13;
    const MAX_BADGES = 45;
    const center = map.getCenter();

    // Сортировка по удаленности от центра
    visibleItems.sort((a, b) => {
      const da = (a.lat - center.lat) ** 2 + (a.lng - center.lng) ** 2;
      const db = (b.lat - center.lat) ** 2 + (b.lng - center.lng) ** 2;
      return da - db;
    });

    const activeIds = new Set();

    visibleItems.forEach((item, idx) => {
      activeIds.add(item.id);
      const targetType = (canUseBadges && idx < MAX_BADGES) ? 'badge' : 'dot';
      const existing = renderedLayers.get(item.id);

      if (existing) {
        if (existing.type === targetType) return;
        sharedLayerGroup.removeLayer(existing.marker);
        renderedLayers.delete(item.id);
      }

      const marker = targetType === 'badge' ? createBadgeMarker(item) : createDotMarker(item);
      sharedLayerGroup.addLayer(marker);
      renderedLayers.set(item.id, { marker, type: targetType });
    });

    // Удаляем ушедшие за горизонт
    for (const [id, entry] of renderedLayers) {
      if (!activeIds.has(id)) {
        sharedLayerGroup.removeLayer(entry.marker);
        renderedLayers.delete(id);
      }
    }
  }

  function updateStatusUI(text) {
    const el = $('shared-markers-status');
    if (el) el.textContent = 'Статус: ' + text;
  }

  function onMapMove() {
    clearTimeout(subDebounceTimer);
    subDebounceTimer = setTimeout(() => {
      if (cfg.download) syncGridSubscriptions();
      else renderVisible();
    }, 200);
  }

  // --- ПУБЛИЧНЫЙ API МОДУЛЯ ---
  WM.sharedMarkers = {
    init(m) {
      map = m;
      canvasRenderer = L.canvas({ padding: 0.25 });
      sharedLayerGroup = L.layerGroup().addTo(map);

      map.on('moveend zoomend', onMapMove);

      // Привязка UI тумблеров
      const chkShare = $('toggle-share-markers');
      const chkDown = $('toggle-download-foreign');
      const chkShow = $('toggle-show-foreign');

      if (chkShare) {
        chkShare.checked = cfg.share;
        chkShare.onchange = (e) => {
          cfg.share = e.target.checked;
          localStorage.setItem('wm_share_markers_enabled', cfg.share);
          this.applyConfig();
        };
      }

      if (chkDown) {
        chkDown.checked = cfg.download;
        chkDown.onchange = (e) => {
          cfg.download = e.target.checked;
          localStorage.setItem('wm_download_foreign_markers', cfg.download);
          this.applyConfig();
        };
      }

      if (chkShow) {
        chkShow.checked = cfg.show;
        chkShow.onchange = (e) => {
          cfg.show = e.target.checked;
          localStorage.setItem('wm_show_foreign_markers', cfg.show);
          renderVisible();
        };
      }

      this.applyConfig();
    },

    applyConfig() {
      if (cfg.share || cfg.download) {
        if (!client) initMqtt();
        else if (isConnected) {
          if (cfg.share) broadcastOwnMarkers();
          if (cfg.download) syncGridSubscriptions();
        }
      } else {
        disconnectMqtt();
        foreignMarkers.clear();
        renderVisible();
      }
    },

    // Вызывать из markers.js при сохранении/удалении своих меток
    notifyOwnMarkersChanged() {
      if (cfg.share && isConnected) {
        broadcastOwnMarkers();
      }
    }
  };
})();