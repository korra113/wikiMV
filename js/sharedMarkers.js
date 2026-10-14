(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  // =========================================================================
  // URL БАЗЫ FIREBASE (REST API)
  // =========================================================================
  const DATABASE_URL = 'https://wikimap-bfbd3-default-rtdb.firebaseio.com';

  let map = null;
  let canvasRenderer = null;
  let sharedLayerGroup = null;

  // Идентификатор устройства для разделения своих и чужих меток
  let deviceId = localStorage.getItem('wm_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('wm_device_id', deviceId);
  }

  // Настройки
  let cfg = {
    download: localStorage.getItem('wm_download_foreign_markers') !== 'false',
    show: localStorage.getItem('wm_show_foreign_markers') !== 'false',
    password: localStorage.getItem('wm_shared_markers_password') || ''
  };

  // Чужие метки, загруженные из базы: id -> data
  const foreignMarkers = new Map();

  // Локальный чёрный список скрытых на этом устройстве меток
  let hiddenForeignMarkerIds = new Set();
  try {
    const rawHidden = localStorage.getItem('wm_hidden_foreign_markers');
    if (rawHidden) hiddenForeignMarkerIds = new Set(JSON.parse(rawHidden));
  } catch (e) {}

  // Отрисованные Leaflet-слои: id -> { marker, type: 'dot' | 'badge' }
  const renderedLayers = new Map();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function updateStatusUI(text) {
    const el = $('shared-markers-status');
    if (el) el.textContent = 'Статус: ' + text;
  }

  // =========================================================================
  // КРИПТОГРАФИЯ (Хэширование пароля и шифрование заметок)
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
      return '🔒 [Заметка защищена паролем]';
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, credentials: 'omit', signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  function hasOwnMarkerAt(lat, lng) {
    if (!WM.markers || !WM.markers.getAll) return false;
    const ownList = WM.markers.getAll();
    if (!Array.isArray(ownList) || !ownList.length) return false;

    for (let i = 0; i < ownList.length; i++) {
      const o = ownList[i];
      if (Math.hypot(o.lat - lat, o.lng - lng) < 0.00006) {
        return true;
      }
    }
    return false;
  }

  // --- 1. Загрузка меток с фильтрацией по паролю ---
  async function fetchRemoteMarkers() {
    if (!cfg.download) {
      foreignMarkers.clear();
      renderVisible();
      updateStatusUI('Загрузка выключена');
      return;
    }

    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ')) {
      updateStatusUI('Укажите DATABASE_URL в sharedMarkers.js');
      return;
    }

    updateStatusUI('⏳ Синхронизация с базой…');

    try {
      const res = await fetchWithTimeout(`${DATABASE_URL}/markers.json`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json() || {};

      foreignMarkers.clear();

      const activePassword = (cfg.password || '').trim();
      let targetHash = '';
      if (activePassword) {
        targetHash = await hashPassword(activePassword);
      }

      let count = 0;
      for (const [key, item] of Object.entries(data)) {
        if (!item || item.lat == null || item.lng == null) continue;
        if (item.authorId === deviceId) continue;
        const markerId = item.id || key;
        if (hiddenForeignMarkerIds.has(markerId)) continue;

        const itemHash = (item.passHash || '').trim();

        // Фильтрация:
        // Если пароль введен: показываем ТОЛЬКО метки с совпадающим passHash.
        // Если пароль пустой: показываем ТОЛЬКО открытые метки без passHash.
        if (activePassword) {
          if (!itemHash || itemHash !== targetHash) continue;
        } else {
          if (itemHash) continue;
        }

        let displayText = item.text || '';
        if (displayText.startsWith('enc:') && activePassword) {
          displayText = await decryptText(displayText, activePassword);
        }

        foreignMarkers.set(markerId, {
          id: markerId,
          authorId: item.authorId,
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lng),
          emoji: item.emoji || '📍',
          text: displayText,
          color: item.color || '#8b5cf6',
          isProtected: !!itemHash,
          createdAt: item.createdAt || 0
        });
        count++;
      }

      renderVisible();

      if (activePassword) {
        updateStatusUI(`🔒 Группа «${activePassword}» · Меток: ${count}`);
      } else {
        updateStatusUI(`🟢 Общий доступ · Меток: ${count}`);
      }
    } catch (err) {
      updateStatusUI('🔴 Оффлайн (нет связи с базой)');
    }
  }

  // --- 2. Публикация своей метки (с паролем или без) ---
  async function savePublicMarker(marker) {
    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ') || !marker) return;

    const pass = (marker.password || '').trim();
    let passHash = null;
    let textToSave = marker.text || '';

    if (pass) {
      passHash = await hashPassword(pass);
      textToSave = await encryptText(textToSave, pass);
    }

    const payload = {
      id: marker.id,
      authorId: deviceId,
      lat: marker.lat,
      lng: marker.lng,
      emoji: marker.emoji || '📍',
      text: textToSave,
      passHash: passHash || null,
      color: marker.color || '#3b82f6',
      createdAt: marker.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    try {
      await fetchWithTimeout(`${DATABASE_URL}/markers/${marker.id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('[Firebase REST] Не удалось сохранить метку в облако:', err.message);
    }
  }

  // --- 3. Удаление метки автором ---
  async function deletePublicMarker(markerId) {
    if (!DATABASE_URL || DATABASE_URL.includes('ВАШ_ПРОЕКТ') || !markerId) return;

    try {
      await fetchWithTimeout(`${DATABASE_URL}/markers/${markerId}.json`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.warn('[Firebase REST] Не удалось удалить метку из облака:', err.message);
    }
  }

  // --- 4. Локальное скрытие чужой метки на данном устройстве ---
  function hideForeignMarker(markerId) {
    if (WM.navTarget && WM.navTarget.isTarget('foreign_' + markerId)) {
      WM.navTarget.clear();
    }
    hiddenForeignMarkerIds.add(markerId);
    try {
      localStorage.setItem('wm_hidden_foreign_markers', JSON.stringify(Array.from(hiddenForeignMarkerIds)));
    } catch (e) {}

    

    foreignMarkers.delete(markerId);
    if (renderedLayers.has(markerId)) {
      const entry = renderedLayers.get(markerId);
      if (sharedLayerGroup && entry) sharedLayerGroup.removeLayer(entry.marker);
      renderedLayers.delete(markerId);
    }
    renderVisible();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🗑️ Метка скрыта на вашем устройстве');
    }
  }

  // Карточка чужой метки
  function createForeignPopup(item, markerInstance) {
    const coordsStr = `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`;
    const dateStr = item.createdAt ? fmtDate(item.createdAt) : '';
    const isTarget = WM.navTarget && WM.navTarget.isTarget('foreign_' + item.id);

    const wrap = document.createElement('div');
    wrap.className = 'wm-foreign-popup';
    wrap.innerHTML = `
      <div class="wm-foreign-pop-header">
        <div class="wm-foreign-pop-avatar" style="--marker-c: ${escapeHtml(item.color)};">
          <span>${item.emoji}</span>
        </div>
        <div class="wm-foreign-pop-meta">
          <div class="wm-foreign-pop-badge-row">
            <span class="wm-foreign-pop-badge ${item.isProtected ? 'protected-pop-badge' : ''}">
              ${item.isProtected ? '🔒 Закрытая заметка' : '🌐 Публичная заметка'}
            </span>
            ${dateStr ? `<span class="wm-foreign-pop-date">· ${dateStr}</span>` : ''}
          </div>
          <div class="wm-foreign-pop-coords" title="Нажмите для копирования">${coordsStr}</div>
        </div>
      </div>

      <div class="wm-foreign-pop-text-wrap">
        <div class="wm-foreign-pop-text">${item.text ? escapeHtml(item.text) : '<i class="muted-note">Без описания</i>'}</div>
      </div>

      <div class="wm-foreign-pop-actions">
        <div class="wm-foreign-actions-row">
          <button type="button" class="btn btn-target-foreign ${isTarget ? 'btn-target-active' : 'btn-target'}">
            ${isTarget ? '🛑 Снять цель' : '🎯 Как цель'}
          </button>
          <button type="button" class="btn btn-primary btn-save-foreign">
            💾 В мои заметки
          </button>
        </div>
        <div class="wm-foreign-actions-row secondary">
          <button type="button" class="btn btn-secondary btn-copy-foreign" title="Скопировать текст и координаты">
            📋 Копировать
          </button>
          <button type="button" class="btn btn-danger-outline btn-delete-foreign" title="Скрыть только на моем устройстве">
            🗑️ Скрыть
          </button>
        </div>
      </div>
    `;

    L.DomEvent.disableClickPropagation(wrap);

    const btnTarget = wrap.querySelector('.btn-target-foreign');
    if (btnTarget) {
      btnTarget.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (markerInstance) markerInstance.closePopup();
        if (WM.navTarget) {
          WM.navTarget.toggle({
            id: 'foreign_' + item.id,
            lat: item.lat,
            lng: item.lng,
            title: item.text ? item.text.slice(0, 22) : (item.emoji || 'Метка')
          });
        }
      };
    }

    const coordsEl = wrap.querySelector('.wm-foreign-pop-coords');
    if (coordsEl) {
      coordsEl.onclick = async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(coordsStr);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📍 Координаты скопированы: ${coordsStr}`);
        } catch (err) {}
      };
    }

    const btnSave = wrap.querySelector('.btn-save-foreign');
    if (btnSave) {
      btnSave.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (markerInstance) markerInstance.closePopup();

        if (WM.markers) {
          const newOwn = {
            id: 'marker_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            lat: item.lat,
            lng: item.lng,
            emoji: item.emoji,
            color: item.color,
            text: item.text || '',
            isPublic: false,
            createdAt: Date.now()
          };

          const all = WM.markers.getAll ? WM.markers.getAll() : [];
          all.push(newOwn);
          if (WM.markers.importData) WM.markers.importData(all);

          renderVisible();

          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('✅ Метка добавлена в ваши личные!');
          }
        }
      };
    }

    const btnCopy = wrap.querySelector('.btn-copy-foreign');
    if (btnCopy) {
      btnCopy.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const copyContent = item.text ? `${item.emoji} ${item.text}\n(${coordsStr})` : coordsStr;
        try {
          await navigator.clipboard.writeText(copyContent);
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Текст заметки скопирован!');
        } catch (err) {}
      };
    }

    const btnDelete = wrap.querySelector('.btn-delete-foreign');
    if (btnDelete) {
      btnDelete.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (markerInstance) markerInstance.closePopup();
        hideForeignMarker(item.id);
      };
    }

    return wrap;
  }

  function createDotMarker(item) {
    const marker = L.circleMarker([item.lat, item.lng], {
      renderer: canvasRenderer,
      radius: 6,
      fillColor: item.isProtected ? '#f59e0b' : (item.color || '#8b5cf6'),
      color: '#ffffff',
      weight: 2,
      fillOpacity: 0.95,
      interactive: true
    });
    marker.bindPopup(() => createForeignPopup(item, marker), {
      offset: [0, -6],
      className: 'wm-foreign-leaflet-popup'
    });
    return marker;
  }

  function createBadgeMarker(item) {
    const safeText = item.text ? escapeHtml(item.text) : '';
    const textHtml = safeText ? `<span class="wm-foreign-badge-text">${safeText}</span>` : '';
    const iconBadge = item.isProtected ? '🔒' : '🌐';

    const html = `
      <div class="wm-foreign-pin-anchor">
        <div class="wm-foreign-badge ${item.isProtected ? 'protected-badge' : ''}" style="--f-color: ${item.isProtected ? '#f59e0b' : (item.color || '#8b5cf6')};">
          <span class="wm-foreign-badge-radar">${iconBadge}</span>
          <span class="wm-foreign-badge-emoji">${item.emoji}</span>
          ${textHtml}
        </div>
        <div class="wm-foreign-pin-dot" style="background:${item.isProtected ? '#f59e0b' : (item.color || '#8b5cf6')};"></div>
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
      zIndexOffset: 850
    });

    marker.bindPopup(() => createForeignPopup(item, marker), {
      offset: [0, -34],
      className: 'wm-foreign-leaflet-popup'
    });
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
    const bounds = map.getBounds().pad(0.2);
    const visibleItems = [];

    foreignMarkers.forEach(m => {
      if (bounds.contains([m.lat, m.lng])) {
        if (!hasOwnMarkerAt(m.lat, m.lng)) {
          visibleItems.push(m);
        }
      }
    });

    const canUseBadges = zoom >= 11;
    const MAX_BADGES = 85;
    const center = map.getCenter();

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

    for (const [id, entry] of renderedLayers) {
      if (!activeIds.has(id)) {
        sharedLayerGroup.removeLayer(entry.marker);
        renderedLayers.delete(id);
      }
    }
  }

  let moveDebounceTimer = null;
  function onMapMove() {
    clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(renderVisible, 110);
  }

  // Обновление подсказки режима в настройках
  function updateSettingsPassInfo() {
    const infoEl = $('shared-markers-pass-info');
    const inputEl = $('shared-markers-password-input');
    const clearBtn = $('btn-shared-pass-clear');
    if (!infoEl || !inputEl) return;

    const val = inputEl.value.trim();
    if (clearBtn) clearBtn.hidden = !val;

    if (!val) {
      infoEl.innerHTML = `
        <span style="color: #16a34a; font-weight: 700;">🔓 Общий режим:</span> скачиваются и отображаются все открытые метки без пароля.
      `;
    } else {
      infoEl.innerHTML = `
        <span style="color: #8b5cf6; font-weight: 700;">🔒 Режим закрытой группы:</span> скачиваются и отображаются <b>только</b> метки с этим паролем. Открытые метки скрыты.
      `;
    }
  }

  function initSettingsControls() {
    const chkDown = $('toggle-download-foreign');
    const chkShow = $('toggle-show-foreign');
    const passInput = $('shared-markers-password-input');
    const eyeBtn = $('btn-shared-pass-toggle-eye');
    const clearBtn = $('btn-shared-pass-clear');

    if (chkDown) {
      chkDown.checked = cfg.download;
      chkDown.onchange = (e) => {
        cfg.download = e.target.checked;
        localStorage.setItem('wm_download_foreign_markers', cfg.download ? 'true' : 'false');
        fetchRemoteMarkers();
      };
    }

    if (chkShow) {
      chkShow.checked = cfg.show;
      chkShow.onchange = (e) => {
        cfg.show = e.target.checked;
        localStorage.setItem('wm_show_foreign_markers', cfg.show ? 'true' : 'false');
        renderVisible();
      };
    }

    if (passInput) {
      passInput.value = cfg.password;
      updateSettingsPassInfo();

      passInput.oninput = () => {
        updateSettingsPassInfo();
      };
    }

    if (eyeBtn && passInput) {
      eyeBtn.onclick = () => {
        const isPass = passInput.type === 'password';
        passInput.type = isPass ? 'text' : 'password';
        eyeBtn.textContent = isPass ? '🙈' : '👁️';
      };
    }

    if (clearBtn && passInput) {
      clearBtn.onclick = () => {
        passInput.value = '';
        updateSettingsPassInfo();
        passInput.focus();
      };
    }
  }

  WM.sharedMarkers = {
    init(m) {
      map = m;
      canvasRenderer = L.canvas({ padding: 0.25 });
      sharedLayerGroup = L.layerGroup().addTo(map);

      map.on('moveend zoomend', onMapMove);

      initSettingsControls();
      fetchRemoteMarkers();
    },

    fetchRemoteMarkers,
    savePublicMarker,
    deletePublicMarker,
    hideForeignMarker,
    renderVisible,
    updateSettingsPassInfo,
    getPassword() {
      return cfg.password || '';
    },
    setPassword(newPass) {
      const trimmed = (newPass || '').trim();
      const changed = cfg.password !== trimmed;
      cfg.password = trimmed;
      localStorage.setItem('wm_shared_markers_password', trimmed);
      if (changed) {
        fetchRemoteMarkers();
      }
    },
    getDeviceId() { return deviceId; }
  };
})();
