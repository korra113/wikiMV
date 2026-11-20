/**
 * js/squad.js — Модуль «Отряд: чат и онлайн-слежение» для Wikimapia Viewer
 * Работает через Supabase REST API (zero dependencies).
 */
(function () {
  const WM = window.WM = window.WM || {};

  const DEFAULT_SUPABASE_URL = 'https://hvjkbpzzapwypcbkkkti.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_uNV3E_0uIecLwnXNQK9Yrw_plwOA1LS';

  const EMOJI_AVATARS = ['🦊', '🐻', '🐺', '🐗', '🦉', '🦅', '🌲', '🏕️', '🧭', '🍄', '🦌', '🐾', '⚡', '🏹', '🧗'];
  const PRESET_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

  let map = null;
  let squadLayer = null;
  let memberMarkers = new Map();
  let lastKnownMembers = [];
  let tempCoordMarker = null;

  let state = {
    connected: false,
    room: null, // { id, name, password, creator_id }
    isCreator: false,
    memberId: '',
    nickname: '',
    color: '#10b981',
    shareLocation: false,
    showOthers: false,
    updateIntervalSec: 30,
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseKey: DEFAULT_SUPABASE_ANON_KEY
  };

  let unreadMessagesCount = 0;
  let isWindowOpen = false;
  let isWindowMinimized = false;
  let lastKnownMessages = [];
  let editingMessageId = null;

  let pollTimer = null;
  let gpsSendTimer = null;
  let lastGpsCoords = null;
  let isNetworkBusy = false;

  function sanitizeNickname(str) {
    if (!str) return '';
    return str.replace(/[^a-zA-Zа-яА-ЯёЁ0-9 _\-.]/g, '').trim().slice(0, 24);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function getRandomEmoji() {
    return EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)];
  }

  function getRandomColor() {
    return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
  }

  function loadSavedState() {
    try {
      const saved = JSON.parse(localStorage.getItem('wm_squad_state') || '{}');
      state.memberId = saved.memberId || ('usr_' + Math.random().toString(36).substring(2, 10));
      state.nickname = saved.nickname || '';
      state.color = saved.color || getRandomColor();
      state.shareLocation = !!saved.shareLocation;
      state.showOthers = !!saved.showOthers;
      state.updateIntervalSec = saved.updateIntervalSec || 30;
      state.room = saved.room || null;
      state.connected = !!(state.room && state.room.id);
      if (saved.supabaseUrl) state.supabaseUrl = saved.supabaseUrl;
      if (saved.supabaseKey) state.supabaseKey = saved.supabaseKey;

      if (state.room) {
        state.isCreator = (state.room.creator_id === state.memberId) || 
                          (localStorage.getItem('wm_squad_creator_' + state.room.id) === state.memberId);
      }
    } catch (e) {
      state.memberId = 'usr_' + Math.random().toString(36).substring(2, 10);
      state.color = getRandomColor();
    }
  }

  function saveState() {
    try {
      localStorage.setItem('wm_squad_state', JSON.stringify({
        memberId: state.memberId,
        nickname: state.nickname,
        color: state.color,
        shareLocation: state.shareLocation,
        showOthers: state.showOthers,
        updateIntervalSec: state.updateIntervalSec,
        room: state.room,
        supabaseUrl: state.supabaseUrl,
        supabaseKey: state.supabaseKey
      }));
    } catch (e) {}
  }

  // Запросы к Supabase REST API с корректной обработкой 204 No Content
  async function supabaseRequest(endpoint, method = 'GET', body = null, timeoutMs = 7000) {
    const url = `${state.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${endpoint}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    const headers = {
      'apikey': state.supabaseKey,
      'Authorization': `Bearer ${state.supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    try {
      const opts = { method, headers, signal: ctl.signal };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const errObj = JSON.parse(errText);
          if (errObj.message) errMsg += `: ${errObj.message}`;
          if (errObj.code === '42P01') errMsg = 'Таблицы базы данных не найдены в Supabase. Запустите SQL-скрипт инициализации.';
          if (errObj.code === '23505') errMsg = 'Отряд с таким паролем уже создан. Используйте "Войти по паролю".';
        } catch (_) {
          if (errText) errMsg += `: ${errText}`;
        }
        throw new Error(errMsg);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // =========================================================================
  // ЛОГИКА КОМНАТ
  // =========================================================================

  async function createRoom(name, password, nickname, color) {
    name = (name || '').trim();
    password = (password || '').trim();
    if (name.length < 3) throw new Error('Название отряда должно быть от 3 символов');
    if (password.length < 5) throw new Error('Пароль отряда должен быть не менее 5 символов');

    state.nickname = sanitizeNickname(nickname) || state.nickname || getRandomEmoji();
    state.color = color || state.color || getRandomColor();

    let created = null;
    try {
      // Пробуем создать с сохранением creator_id в таблице
      created = await supabaseRequest('squad_rooms', 'POST', {
        name: name,
        password: password,
        creator_id: state.memberId
      });
    } catch (e) {
      // Фолбэк, если в таблице ещё не добавлена колонка creator_id
      created = await supabaseRequest('squad_rooms', 'POST', {
        name: name,
        password: password
      });
    }

    if (!created || !created.length) throw new Error('Не удалось создать комнату');
    const r = created[0];
    state.room = { 
      id: r.id, 
      name: r.name, 
      password: r.password, 
      creator_id: r.creator_id || state.memberId 
    };
    state.isCreator = true;
    state.connected = true;
    try { localStorage.setItem('wm_squad_creator_' + r.id, state.memberId); } catch (_) {}
    saveState();

    await registerPresence();
    startSyncLoops();
    updateUIState();
    return state.room;
  }

  async function joinRoom(password, nickname, color) {
    password = (password || '').trim();
    if (password.length < 5) throw new Error('Пароль отряда должен быть от 5 символов');

    const found = await supabaseRequest(`squad_rooms?password=eq.${encodeURIComponent(password)}&select=*`);
    if (!found || !found.length) {
      throw new Error('Отряд с таким паролем не найден');
    }

    const room = found[0];
    state.nickname = sanitizeNickname(nickname) || state.nickname || getRandomEmoji();
    state.color = color || state.color || getRandomColor();
    state.room = { 
      id: room.id, 
      name: room.name, 
      password: room.password, 
      creator_id: room.creator_id || null 
    };
    state.isCreator = (room.creator_id === state.memberId) || 
                      (localStorage.getItem('wm_squad_creator_' + room.id) === state.memberId);
    state.connected = true;
    saveState();

    await registerPresence();
    startSyncLoops();
    updateUIState();
    return state.room;
  }

  async function leaveRoom(silent = false) {
    if (!state.room) return;
    const roomId = state.room.id;
    const memberId = state.memberId;

    try {
      await supabaseRequest(`squad_members?room_id=eq.${roomId}&member_id=eq.${memberId}`, 'DELETE');
      const remaining = await supabaseRequest(`squad_members?room_id=eq.${roomId}&select=id`);
      if (!remaining || remaining.length === 0) {
        await supabaseRequest(`squad_rooms?id=eq.${roomId}`, 'DELETE');
      }
    } catch (e) {
      console.warn('[Squad] Ошибка при выходе:', e);
    } finally {
      state.connected = false;
      state.room = null;
      state.isCreator = false;
      saveState();
      stopSyncLoops();
      clearMarkers();
      updateUIState();
      closeWindow();
      if (!silent && WM.ui && WM.ui.showToast) {
        WM.ui.showToast('Вы вышли из отряда');
      }
    }
  }

  // =========================================================================
  // ПРАВА И ДЕЙСТВИЯ СОЗДАТЕЛЯ ОТРАДА
  // =========================================================================

  async function updateRoomInfo(newName, newPassword) {
    if (!state.connected || !state.room || !state.isCreator) return;
    newName = (newName || '').trim();
    newPassword = (newPassword || '').trim();

    if (newName.length < 3) throw new Error('Название отряда должно быть не менее 3 символов');
    if (newPassword.length < 5) throw new Error('Пароль отряда должен быть не менее 5 символов');

    await supabaseRequest(`squad_rooms?id=eq.${state.room.id}`, 'PATCH', {
      name: newName,
      password: newPassword
    });

    state.room.name = newName;
    state.room.password = newPassword;
    saveState();
    updateUIState();

    // Системное сообщение в чат об изменениях
    await sendMessage(`📢 Создатель обновил данные отряда: «${newName}» (пароль изменён)`);
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('✅ Параметры отряда успешно обновлены');
  }

  async function kickMember(targetMemberId, targetNick) {
    if (!state.connected || !state.room || !state.isCreator) return;
    if (targetMemberId === state.memberId) return;

    if (!confirm(`Исключить участника «${targetNick}» из отряда?`)) return;

    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${targetMemberId}`, 'DELETE');
      await sendMessage(`⛔ Участник «${targetNick}» исключён создателем из отряда.`);
      await syncSquadData();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`Участник ${targetNick} исключён`);
    } catch (e) {
      alert('Ошибка при исключении участника: ' + e.message);
    }
  }

  async function deleteRoomByCreator() {
    if (!state.connected || !state.room || !state.isCreator) return;

    if (!confirm(`ВНИМАНИЕ! Полностью расформировать и удалить отряд «${state.room.name}» для ВСЕХ участников?`)) {
      return;
    }

    const roomId = state.room.id;
    try {
      await sendMessage('⚠️ Создатель расформировал отряд. Комната закрыта.');
      await supabaseRequest(`squad_messages?room_id=eq.${roomId}`, 'DELETE');
      await supabaseRequest(`squad_members?room_id=eq.${roomId}`, 'DELETE');
      await supabaseRequest(`squad_rooms?id=eq.${roomId}`, 'DELETE');
    } catch (e) {
      console.warn('Ошибка при удалении отряда:', e);
    } finally {
      state.connected = false;
      state.room = null;
      state.isCreator = false;
      saveState();
      stopSyncLoops();
      clearMarkers();
      updateUIState();
      closeWindow();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('💥 Отряд полностью расформирован и удален');
    }
  }

  async function registerPresence() {
    if (!state.room) return;
    const payload = {
      room_id: state.room.id,
      member_id: state.memberId,
      nickname: state.nickname,
      color: state.color,
      share_location: state.shareLocation,
      lat: (state.shareLocation && lastGpsCoords) ? lastGpsCoords[0] : null,
      lng: (state.shareLocation && lastGpsCoords) ? lastGpsCoords[1] : null,
      last_seen: new Date().toISOString()
    };
    try {
      await supabaseRequest('squad_members', 'POST', payload);
    } catch (e) {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`, 'PATCH', payload);
    }
  }

  // =========================================================================
  // СИНХРОНИЗАЦИЯ КООРДИНАТ И СООБЩЕНИЙ
  // =========================================================================

  async function syncSquadData() {
    if (!state.connected || !state.room || isNetworkBusy) return;
    isNetworkBusy = true;

    try {
      // 1. Проверяем существование и актуальные данные самой комнаты (название, пароль)
      const roomCheck = await supabaseRequest(`squad_rooms?id=eq.${state.room.id}&select=*`);
      if (!roomCheck || !roomCheck.length) {
        // Комната была удалена создателем!
        alert('⚠️ Отряд был расформирован создателем.');
        await leaveRoom(true);
        return;
      }

      const freshRoom = roomCheck[0];
      if (freshRoom.name !== state.room.name || freshRoom.password !== state.room.password) {
        state.room.name = freshRoom.name;
        state.room.password = freshRoom.password;
        saveState();
        updateUIState();
      }

      // 2. Получаем участников
      const members = await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&select=*`);
      lastKnownMembers = members || [];

      // Проверяем, не исключили ли текущего пользователя
      const isStillMember = lastKnownMembers.some(m => m.member_id === state.memberId);
      if (!isStillMember && lastKnownMembers.length > 0 && !state.isCreator) {
        alert('⚠️ Вы были исключены из отряда создателем.');
        await leaveRoom(true);
        return;
      }

      renderMembersOnMap(lastKnownMembers);
      renderMembersList(lastKnownMembers);

      // 3. Получаем сообщения
      const msgs = await supabaseRequest(`squad_messages?room_id=eq.${state.room.id}&select=*&order=created_at.asc&limit=50`);
      handleNewMessages(msgs || []);

      setOnlineStatus(true);
    } catch (err) {
      setOnlineStatus(false, err.message);
    } finally {
      isNetworkBusy = false;
    }
  }

  async function sendGpsCoordinates() {
    if (!state.connected || !state.room || !state.shareLocation || !lastGpsCoords) return;
    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`, 'PATCH', {
        lat: lastGpsCoords[0],
        lng: lastGpsCoords[1],
        share_location: true,
        last_seen: new Date().toISOString()
      });
    } catch (e) {
      console.warn('[Squad] Ошибка отправки GPS:', e);
    }
  }

  function handleNewMessages(messages) {
    const prevCount = lastKnownMessages.length;
    const newCount = messages.length;

    if ((isWindowMinimized || !isWindowOpen) && newCount > prevCount && prevCount > 0) {
      const added = messages.slice(prevCount);
      const foreignAdded = added.filter(m => m.member_id !== state.memberId);
      if (foreignAdded.length > 0) {
        unreadMessagesCount += foreignAdded.length;
        if (navigator.vibrate) navigator.vibrate(40);
        updateUnreadBadgeUI();
      }
    }

    lastKnownMessages = messages;
    renderChatMessages(messages);
  }

  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text || text.length > 512 || !state.room) return;

    if (editingMessageId) {
      await supabaseRequest(`squad_messages?id=eq.${editingMessageId}&member_id=eq.${state.memberId}`, 'PATCH', {
        text: text,
        updated_at: new Date().toISOString()
      });
      editingMessageId = null;
    } else {
      await supabaseRequest('squad_messages', 'POST', {
        room_id: state.room.id,
        member_id: state.memberId,
        nickname: state.nickname,
        color: state.color,
        text: text
      });
    }

    await syncSquadData();
  }

  function startSyncLoops() {
    stopSyncLoops();
    if (!state.connected) return;

    syncSquadData();
    pollTimer = setInterval(syncSquadData, 5000);
    const intervalMs = Math.max(10, state.updateIntervalSec) * 1000;
    gpsSendTimer = setInterval(sendGpsCoordinates, intervalMs);
  }

  function stopSyncLoops() {
    if (pollTimer) clearInterval(pollTimer);
    if (gpsSendTimer) clearInterval(gpsSendTimer);
    pollTimer = null;
    gpsSendTimer = null;
  }

  // =========================================================================
  // ОТОБРАЖЕНИЕ ТОЧЕК НА КАРТЕ LEAFLET
  // =========================================================================

  function clearMarkers() {
    if (squadLayer) squadLayer.clearLayers();
    memberMarkers.clear();
    if (tempCoordMarker && map) {
      map.removeLayer(tempCoordMarker);
      tempCoordMarker = null;
    }
  }

  function renderMembersOnMap(members) {
    if (!map || !state.showOthers || !squadLayer) {
      clearMarkers();
      return;
    }

    const currentZoom = map.getZoom();
    const keepIds = new Set();

    members.forEach(m => {
      if (m.member_id === state.memberId || !m.share_location || m.lat == null || m.lng == null) {
        return;
      }

      keepIds.add(m.member_id);
      const latlng = [m.lat, m.lng];
      const isFar = currentZoom < 13;
      const nickSafe = escapeHtml(m.nickname || 'Участник');
      const color = m.color || '#10b981';

      const minsAgo = Math.round((Date.now() - new Date(m.last_seen).getTime()) / 60000);
      const timeAgoText = minsAgo <= 1 ? 'сейчас' : `${minsAgo} мин назад`;

      const markerHtml = isFar
        ? `<div class="wm-squad-dot" style="background-color: ${color};"></div>`
        : `
          <div class="wm-squad-pin" style="--sq-color: ${color};">
            <span class="wm-squad-pin-badge">${nickSafe}</span>
            <div class="wm-squad-pin-dot" style="background-color: ${color};"></div>
          </div>
        `;

      let marker = memberMarkers.get(m.member_id);
      if (!marker) {
        marker = L.marker(latlng, {
          icon: L.divIcon({
            className: 'wm-squad-marker-wrap',
            html: markerHtml,
            iconSize: isFar ? [16, 16] : [120, 36],
            iconAnchor: isFar ? [8, 8] : [60, 34]
          }),
          zIndexOffset: 1300
        }).addTo(squadLayer);

        marker.on('click', () => {
          map.panTo(latlng);
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`🎯 Участник: ${m.nickname} (${timeAgoText})`);
          }
        });

        memberMarkers.set(m.member_id, marker);
      } else {
        marker.setLatLng(latlng);
        marker.setIcon(L.divIcon({
          className: 'wm-squad-marker-wrap',
          html: markerHtml,
          iconSize: isFar ? [16, 16] : [120, 36],
          iconAnchor: isFar ? [8, 8] : [60, 34]
        }));
      }
    });

    for (const [id, marker] of memberMarkers) {
      if (!keepIds.has(id)) {
        squadLayer.removeLayer(marker);
        memberMarkers.delete(id);
      }
    }
  }

  // =========================================================================
  // ИНТЕРФЕЙС, СПИСОК УЧАСТНИКОВ И ЧАТ
  // =========================================================================

  function renderMembersList(members) {
    const listEl = document.getElementById('squad-members-chips');
    if (!listEl) return;
    listEl.innerHTML = '';

    members.forEach(m => {
      const isMe = m.member_id === state.memberId;
      const hasCoords = m.share_location && m.lat != null && m.lng != null;
      const isCreatorMember = state.room && state.room.creator_id === m.member_id;

      const chip = document.createElement('div');
      chip.className = 'squad-member-chip' + (hasCoords ? ' has-coords' : '');
      chip.style.borderColor = m.color || '#10b981';

      let kickBtnHtml = '';
      if (state.isCreator && !isMe) {
        kickBtnHtml = `<button type="button" class="squad-member-kick-btn" title="Исключить участника">✕</button>`;
      }

      chip.innerHTML = `
        <span class="squad-chip-dot" style="background: ${m.color};"></span>
        <span class="squad-chip-name">${isCreatorMember ? '👑 ' : ''}${escapeHtml(m.nickname)}${isMe ? ' (Вы)' : ''}</span>
        ${hasCoords ? '<span class="squad-chip-gps">📍</span>' : ''}
        ${kickBtnHtml}
      `;

      if (hasCoords) {
        chip.title = 'Перенести камеру на участника';
        chip.onclick = (e) => {
          if (e.target.closest('.squad-member-kick-btn')) return;
          if (map) {
            map.flyTo([m.lat, m.lng], Math.max(map.getZoom(), 16), { animate: true });
            if (WM.ui && WM.ui.showToast) WM.ui.showToast(`🎯 Камера перенесена к ${m.nickname}`);
          }
        };
      }

      const kickBtn = chip.querySelector('.squad-member-kick-btn');
      if (kickBtn) {
        kickBtn.onclick = (e) => {
          e.stopPropagation();
          kickMember(m.member_id, m.nickname);
        };
      }

      listEl.appendChild(chip);
    });
  }

  // Форматирование сообщений с автоссылками и кликабельными координатами
  function formatChatMessageText(rawText) {
    if (!rawText) return '';
    let safe = escapeHtml(rawText);

    // 1. Интерактивные координаты 📍 [lat, lng] или просто [lat, lng]
    const coordRegex = /(?:📍\s*)?\[\s*(-?\d{1,2}\.\d{4,7})\s*,\s*(-?\d{1,3}\.\d{4,7})\s*\]/g;
    safe = safe.replace(coordRegex, (match, lat, lng) => {
      return `<button type="button" class="squad-coord-badge" data-lat="${lat}" data-lng="${lng}">📍 ${lat}, ${lng}</button>`;
    });

    // 2. Автоссылки (URL)
    const urlRegex = /(https?:\/\/[^\s<]+)/gi;
    safe = safe.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    return safe;
  }

  function renderChatMessages(messages) {
    const box = document.getElementById('squad-chat-messages');
    if (!box) return;

    const isScrolledBottom = box.scrollHeight - box.clientHeight <= box.scrollTop + 45;
    box.innerHTML = '';

    if (!messages.length) {
      box.innerHTML = '<div class="squad-chat-empty" style="text-align:center; padding:20px; font-size:11.5px; color:var(--text-muted);">Сообщений пока нет. Напишите первым!</div>';
      return;
    }

    messages.forEach(m => {
      const isMe = m.member_id === state.memberId;
      const timeStr = new Date(m.created_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const isEdited = m.updated_at && m.updated_at !== m.created_at;

      const bubble = document.createElement('div');
      bubble.className = 'squad-msg-bubble' + (isMe ? ' me' : '');
      bubble.style.borderLeftColor = m.color || '#10b981';

      bubble.innerHTML = `
        <div class="squad-msg-head">
          <span class="squad-msg-author" style="color: ${m.color};">${escapeHtml(m.nickname)}</span>
          <span class="squad-msg-time">${timeStr}${isEdited ? ' (ред.)' : ''}</span>
          ${isMe ? `<button type="button" class="squad-msg-edit-btn" title="Редактировать">✏️</button>` : ''}
        </div>
        <div class="squad-msg-text">${formatChatMessageText(m.text)}</div>
      `;

      if (isMe) {
        const editBtn = bubble.querySelector('.squad-msg-edit-btn');
        if (editBtn) {
          editBtn.onclick = () => {
            editingMessageId = m.id;
            const inp = document.getElementById('squad-chat-input');
            const cancelEdit = document.getElementById('squad-chat-cancel-edit');
            if (inp) {
              inp.value = m.text;
              inp.focus();
            }
            if (cancelEdit) cancelEdit.hidden = false;
          };
        }
      }

      box.appendChild(bubble);
    });

    if (isScrolledBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function setOnlineStatus(isOk, errMsg = '') {
    const dot = document.getElementById('squad-status-dot');
    const label = document.getElementById('squad-status-text');
    if (dot) dot.className = 'squad-status-dot ' + (isOk ? 'online' : 'offline');
    if (label) label.textContent = isOk ? 'Онлайн' : (errMsg ? 'Связь потеряна' : 'Офлайн');
  }

  function updateUnreadBadgeUI() {
    const badge = document.getElementById('squad-unread-badge');
    if (badge) {
      badge.textContent = unreadMessagesCount > 0 ? unreadMessagesCount : '';
      badge.hidden = unreadMessagesCount === 0;
    }
  }

  function openWindow() {
    const win = document.getElementById('squad-window');
    if (!win) return;
    isWindowOpen = true;
    isWindowMinimized = false;
    win.classList.remove('minimized');
    win.hidden = false;

    unreadMessagesCount = 0;
    updateUnreadBadgeUI();
    updateUIState();

    if (state.connected) {
      syncSquadData();
    }
  }

  function closeWindow() {
    const win = document.getElementById('squad-window');
    if (!win) return;
    isWindowOpen = false;
    win.hidden = true;
  }

  function toggleMinimizeWindow() {
    const win = document.getElementById('squad-window');
    if (!win) return;
    isWindowMinimized = !isWindowMinimized;
    win.classList.toggle('minimized', isWindowMinimized);
    if (!isWindowMinimized) {
      unreadMessagesCount = 0;
      updateUnreadBadgeUI();
    }
  }

  function updateUIState() {
    const titleEl = document.getElementById('squad-win-room-title');
    if (titleEl) {
      titleEl.textContent = state.connected && state.room ? `Отряд: «${state.room.name}»` : 'Отряд не выбран';
    }

    const chkShare = document.getElementById('squad-toggle-share-loc');
    const chkShow = document.getElementById('squad-toggle-show-others');
    if (chkShare) chkShare.checked = state.shareLocation;
    if (chkShow) chkShow.checked = state.showOthers;

    const settingsConnectedBox = document.getElementById('squad-settings-connected');
    const settingsNotConnectedBox = document.getElementById('squad-settings-not-connected');
    if (settingsConnectedBox && settingsNotConnectedBox) {
      settingsConnectedBox.hidden = !state.connected;
      settingsNotConnectedBox.hidden = state.connected;
    }

    const roomNameLabel = document.getElementById('squad-settings-room-name');
    if (roomNameLabel && state.room) {
      roomNameLabel.textContent = `«${state.room.name}» (пароль: ${state.room.password})`;
    }

    // Бейдж роли и панель создателя в настройках
    const roleBadge = document.getElementById('squad-settings-role-badge');
    const adminPanel = document.getElementById('squad-admin-panel');
    const editNameInp = document.getElementById('squad-admin-edit-name');
    const editPassInp = document.getElementById('squad-admin-edit-pass');

    if (roleBadge) {
      roleBadge.textContent = state.isCreator ? '👑 Вы создатель этого отряда' : '👤 Вы участник отряда';
      roleBadge.style.color = state.isCreator ? '#f59e0b' : 'var(--accent)';
    }

    if (adminPanel) {
      adminPanel.style.display = (state.connected && state.isCreator) ? 'block' : 'none';
      if (state.room) {
        if (editNameInp) editNameInp.value = state.room.name || '';
        if (editPassInp) editPassInp.value = state.room.password || '';
      }
    }

    const intervalSel = document.getElementById('squad-gps-interval-select');
    if (intervalSel) intervalSel.value = state.updateIntervalSec;

    const notInSquadAlert = document.getElementById('squad-not-connected-view');
    const activeSquadView = document.getElementById('squad-connected-view');
    if (notInSquadAlert && activeSquadView) {
      notInSquadAlert.hidden = state.connected;
      activeSquadView.hidden = !state.connected;
    }

    const nickInp = document.getElementById('squad-user-nick');
    if (nickInp && !nickInp.value) nickInp.value = state.nickname || '';

    const colInp = document.getElementById('squad-user-color');
    if (colInp && !colInp.value) colInp.value = state.color || '#10b981';

    const urlInp = document.getElementById('squad-cfg-supabase-url');
    if (urlInp) urlInp.value = state.supabaseUrl;

    const keyInp = document.getElementById('squad-cfg-supabase-key');
    if (keyInp) keyInp.value = state.supabaseKey;
  }

  // Переход к спойлеру настроек
  function goToSettings() {
    closeWindow();
    const btnSettings = document.getElementById('btn-settings');
    if (btnSettings) btnSettings.click();
    setTimeout(() => {
      const sp = document.getElementById('spoiler-squad-settings');
      if (sp) {
        let parent = sp.parentElement;
        while (parent) {
          if (parent.tagName === 'DETAILS') parent.open = true;
          parent = parent.parentElement;
        }
        sp.open = true;
        sp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 180);
  }

  function initDOM() {
    document.getElementById('btn-squad-win-min')?.addEventListener('click', toggleMinimizeWindow);
    document.getElementById('btn-squad-win-close')?.addEventListener('click', closeWindow);
    
    // Клик по шапке в свёрнутом виде разворачивает окно обратно по центру
    document.querySelector('.squad-win-header')?.addEventListener('click', (e) => {
      if (isWindowMinimized && !e.target.closest('button')) {
        toggleMinimizeWindow();
      }
    });

    document.getElementById('btn-squad-refresh')?.addEventListener('click', () => {
      syncSquadData();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('🔄 Данные отряда обновлены');
    });

    document.getElementById('squad-toggle-share-loc')?.addEventListener('change', (e) => {
      state.shareLocation = e.target.checked;
      saveState();
      registerPresence();
      if (state.shareLocation) sendGpsCoordinates();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(state.shareLocation ? '📡 Раздача координат включена' : '🛑 Раздача координат выключена');
      }
    });

    document.getElementById('squad-toggle-show-others')?.addEventListener('change', (e) => {
      state.showOthers = e.target.checked;
      saveState();
      renderMembersOnMap(lastKnownMembers);
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(state.showOthers ? '👁️ Отображение участников включено' : '🕶️ Участники на карте скрыты');
      }
    });

    const chatInput = document.getElementById('squad-chat-input');
    const chatCount = document.getElementById('squad-chat-count');
    const chatBtn = document.getElementById('btn-squad-chat-send');
    const coordsBtn = document.getElementById('btn-squad-chat-coords');
    const cancelEditBtn = document.getElementById('squad-chat-cancel-edit');
    const chatMessagesBox = document.getElementById('squad-chat-messages');

    if (chatInput) {
      chatInput.addEventListener('input', () => {
        if (chatCount) chatCount.textContent = `${chatInput.value.length}/512`;
      });
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          chatBtn?.click();
        }
      });
    }

    // Отправка координат центра карты по кнопке 📍
    if (coordsBtn) {
      coordsBtn.addEventListener('click', async () => {
        if (!map || !state.room) return;
        const c = map.getCenter();
        const lat = c.lat.toFixed(5);
        const lng = c.lng.toFixed(5);
        const text = `📍 [${lat}, ${lng}]`;
        await sendMessage(text);
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📍 Координаты центра карты отправлены`);
      });
    }

    // Клик по координатам внутри сообщения: перенос экрана к точке
    if (chatMessagesBox) {
      chatMessagesBox.addEventListener('click', (e) => {
        const btn = e.target.closest('.squad-coord-badge');
        if (btn && map) {
          const lat = parseFloat(btn.dataset.lat);
          const lng = parseFloat(btn.dataset.lng);
          if (!isNaN(lat) && !isNaN(lng)) {
            map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { animate: true });

            // Временный визуальный маяк точки
            if (tempCoordMarker) map.removeLayer(tempCoordMarker);
            tempCoordMarker = L.circleMarker([lat, lng], {
              radius: 12,
              color: '#0284c7',
              weight: 3,
              fillColor: '#38bdf8',
              fillOpacity: 0.5
            }).addTo(map);

            setTimeout(() => {
              if (tempCoordMarker && map) {
                map.removeLayer(tempCoordMarker);
                tempCoordMarker = null;
              }
            }, 5000);

            if (WM.ui && WM.ui.showToast) {
              WM.ui.showToast(`🎯 Переход к точке: ${lat}, ${lng}`);
            }
          }
        }
      });
    }

    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', () => {
        editingMessageId = null;
        if (chatInput) chatInput.value = '';
        cancelEditBtn.hidden = true;
      });
    }

    if (chatBtn) {
      chatBtn.addEventListener('click', async () => {
        if (!chatInput || !chatInput.value.trim()) return;
        const txt = chatInput.value;
        chatInput.value = '';
        if (chatCount) chatCount.textContent = '0/512';
        if (cancelEditBtn) cancelEditBtn.hidden = true;
        await sendMessage(txt);
      });
    }

    // Кнопки управления создателя (Admin Panel)
    document.getElementById('btn-squad-admin-save-name')?.addEventListener('click', async () => {
      const newName = document.getElementById('squad-admin-edit-name')?.value;
      const curPass = state.room ? state.room.password : '';
      try {
        await updateRoomInfo(newName, curPass);
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-squad-admin-save-pass')?.addEventListener('click', async () => {
      const curName = state.room ? state.room.name : '';
      const newPass = document.getElementById('squad-admin-edit-pass')?.value;
      try {
        await updateRoomInfo(curName, newPass);
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-squad-admin-delete-room')?.addEventListener('click', deleteRoomByCreator);

    // Переключение вкладок «Войти по паролю» / «Создать новый»
    const tabJoin = document.getElementById('btn-squad-tab-join');
    const tabCreate = document.getElementById('btn-squad-tab-create');
    const boxJoin = document.getElementById('squad-box-join');
    const boxCreate = document.getElementById('squad-box-create');

    if (tabJoin && tabCreate && boxJoin && boxCreate) {
      tabJoin.onclick = () => {
        tabJoin.classList.add('active');
        tabCreate.classList.remove('active');
        boxJoin.style.display = 'block';
        boxJoin.removeAttribute('hidden');
        boxCreate.style.display = 'none';
        boxCreate.setAttribute('hidden', '');
      };
      tabCreate.onclick = () => {
        tabCreate.classList.add('active');
        tabJoin.classList.remove('active');
        boxCreate.style.display = 'block';
        boxCreate.removeAttribute('hidden');
        boxJoin.style.display = 'none';
        boxJoin.setAttribute('hidden', '');
      };
    }

    document.getElementById('btn-squad-goto-settings')?.addEventListener('click', goToSettings);

    document.getElementById('btn-squad-create')?.addEventListener('click', async () => {
      const name = document.getElementById('squad-create-name')?.value;
      const pass = document.getElementById('squad-create-pass')?.value;
      const nick = document.getElementById('squad-user-nick')?.value;
      const color = document.getElementById('squad-user-color')?.value;
      try {
        await createRoom(name, pass, nick, color);
        const modal = document.getElementById('modal');
        if (modal) modal.classList.remove('open');
        openWindow();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`✅ Отряд «${name}» успешно создан!`);
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-squad-join')?.addEventListener('click', async () => {
      const pass = document.getElementById('squad-join-pass')?.value;
      const nick = document.getElementById('squad-user-nick')?.value;
      const color = document.getElementById('squad-user-color')?.value;
      try {
        const room = await joinRoom(pass, nick, color);
        const modal = document.getElementById('modal');
        if (modal) modal.classList.remove('open');
        openWindow();
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`✅ Вы присоединились к отряду «${room.name}»!`);
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-squad-leave')?.addEventListener('click', async () => {
      if (confirm('Выйти из отряда?')) {
        await leaveRoom();
      }
    });

    document.getElementById('btn-squad-open-chat-from-settings')?.addEventListener('click', () => {
      const modal = document.getElementById('modal');
      if (modal) modal.classList.remove('open');
      openWindow();
    });

    document.getElementById('squad-gps-interval-select')?.addEventListener('change', (e) => {
      state.updateIntervalSec = parseInt(e.target.value, 10) || 30;
      saveState();
      startSyncLoops();
    });

    document.getElementById('squad-user-nick')?.addEventListener('change', (e) => {
      state.nickname = sanitizeNickname(e.target.value);
      saveState();
      registerPresence();
    });

    document.getElementById('squad-user-color')?.addEventListener('change', (e) => {
      state.color = e.target.value;
      saveState();
      registerPresence();
    });

    document.getElementById('btn-squad-save-supabase-cfg')?.addEventListener('click', () => {
      const u = document.getElementById('squad-cfg-supabase-url')?.value.trim();
      const k = document.getElementById('squad-cfg-supabase-key')?.value.trim();
      if (u) state.supabaseUrl = u;
      if (k) state.supabaseKey = k;
      saveState();
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Настройки Supabase сохранены');
    });
  }

  WM.squad = {
    init(m) {
      map = m;
      squadLayer = L.layerGroup().addTo(map);
      loadSavedState();
      initDOM();
      updateUIState();

      map.on('zoomend', () => {
        if (state.connected && state.showOthers && lastKnownMembers.length) {
          renderMembersOnMap(lastKnownMembers);
        }
      });

      if (state.connected) {
        startSyncLoops();
      }
    },
    openWindow,
    closeWindow,
    toggleMinimizeWindow,
    openSettings: goToSettings,
    isConnected: () => state.connected,
    getRoom: () => state.room,
    isCreator: () => state.isCreator,
    onGpsUpdate(coords) {
      lastGpsCoords = coords;
    }
  };
})();