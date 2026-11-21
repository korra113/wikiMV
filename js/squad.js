/**
 * js/squad.js — Модуль «Отряд: чат и онлайн-слежение» для Wikimapia Viewer  (v2.0)
 * Работает через Supabase REST API (zero dependencies).
 *
 * Что нового в v2.0 (надёжность связи):
 *  • Один «умный» сетевой слой: таймауты, авто-повтор, классификация ошибок, cache:'no-store'.
 *  • Опрос не по setInterval, а цепочкой setTimeout с адаптивным интервалом и экспоненциальным
 *    бэкоффом; 2 запроса параллельно вместо 3 последовательных; сообщения — инкрементально.
 *  • Исправлен баг «видны только первые 50 сообщений» (раньше order=asc&limit=50).
 *  • Мгновенная отправка (optimistic UI) + исходящая очередь (outbox), переживает перезагрузку,
 *    повтор с защитой от дублей, статусы: 🕓 отправляется → ✓ отправлено → ✓✓ доставлено → ✓✓ прочитано.
 *  • Умная перерисовка чата (без полной пересборки DOM каждые 5 секунд).
 *  • Мгновенная ресинхронизация при возврате во вкладку / появлении сети.
 *  • Кнопка 🐞 в шапке окна: журнал событий, причина разрыва, задержки, тест связи, копирование отчёта.
 *
 * Для статусов «доставлено / прочитано» нужны 2 колонки (выполнить один раз в Supabase → SQL Editor):
 *   alter table squad_members add column if not exists last_delivered_at timestamptz;
 *   alter table squad_members add column if not exists last_read_at timestamptz;
 *   notify pgrst, 'reload schema';
 * Без них модуль работает как раньше, но видны только статусы «отправляется» и «отправлено».
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const MODULE_VERSION = '2.0.0';

  const DEFAULT_SUPABASE_URL = 'https://hvjkbpzzapwypcbkkkti.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_uNV3E_0uIecLwnXNQK9Yrw_plwOA1LS';

  const EMOJI_AVATARS = ['🦊', '🐻', '🐺', '🐗', '🦉', '🦅', '🌲', '🏕️', '🧭', '🍄', '🦌', '🐾', '⚡', '🏹', '🧗'];
  const PRESET_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

  const RECEIPTS_SQL =
    "alter table squad_members add column if not exists last_delivered_at timestamptz;\n" +
    "alter table squad_members add column if not exists last_read_at timestamptz;\n" +
    "notify pgrst, 'reload schema';";

  const CONFIG = {
    pollOpenMs: 3000,          // окно чата открыто и видимо
    pollIdleMs: 6000,          // окно закрыто/свёрнуто, вкладка видима
    pollHiddenMs: 20000,       // вкладка скрыта
    pollMaxBackoffMs: 30000,   // потолок бэкоффа при ошибках
    fullRefreshEvery: 5,       // каждый N-й опрос — полная загрузка последних сообщений (правки, пропуски)
    getTimeoutMs: 12000,
    writeTimeoutMs: 15000,
    messagesLimit: 80,
    messagesKeep: 300,
    heartbeatMs: 40000,
    onlineWindowMs: 150000,
    outboxMaxAttempts: 6,
    outboxBackoffMs: [1000, 2000, 4000, 8000, 15000, 15000],
    debugLogMax: 150
  };

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
  let editingMessageId = null;

  let pollTimer = null;
  let gpsSendTimer = null;
  let heartbeatTimer = null;
  let outboxTimer = null;
  let lastGpsCoords = null;

  // ---- runtime комнаты ----
  const serverMessages = new Map();   // String(id) -> row
  const editsInFlight = new Set();    // String(id)
  let lastMsgCreatedAt = null;
  let messagesLoaded = false;
  let initialLoaded = false;
  let pollCount = 0;
  let forceFullNext = false;
  let syncInFlight = null;
  let syncQueued = false;
  let selfSeenInList = false;
  let selfMissCount = 0;
  let roomMissCount = 0;
  let hiddenAt = 0;

  // ---- исходящая очередь ----
  let outbox = [];
  let outboxRunning = false;
  const OUTBOX_KEY = 'wm_squad_outbox';

  // ---- квитанции ----
  let receiptsSupported = true;
  let receiptsWarned = false;
  let receiptsInitialized = false;
  let sentDelivered = null;
  let sentRead = null;
  let wantDelivered = null;
  let wantRead = null;
  let receiptInFlight = false;
  let receiptDirty = false;
  let receiptTimer = null;

  // ---- DOM-кэш чата ----
  const chatNodes = new Map(); // key -> { el, sig }

  // ---- статус соединения / отладка ----
  let connStatus = 'idle'; // idle | online | unstable | offline
  const dbg = {
    entries: [],
    lastOkAt: 0,
    lastErrAt: 0,
    okCount: 0,
    errCount: 0,
    consecutiveFails: 0,
    reconnects: 0,
    downSince: 0,
    lastError: null,        // { at, label, kind, title, hints }
    lastDisconnect: null,   // { at, title, hints }
    lat: [],
    syncCount: 0
  };
  let debugOpen = false;
  let debugTimer = null;
  let debugRenderTimer = null;
  let debugPersistTimer = null;
  const DEBUG_KEY = 'wm_squad_debug_log';

  // =========================================================================
  // УТИЛИТЫ
  // =========================================================================

  function sanitizeNickname(str) {
    if (!str) return '';
    return str.replace(/[^a-zA-Zа-яА-ЯёЁ0-9 _\-.]/g, '').trim().slice(0, 24);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function safeColor(c, fallback) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : (fallback || '#10b981');
  }

  function getRandomEmoji() {
    return EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)];
  }

  function getRandomColor() {
    return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
  }

  function randId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function toast(msg) {
    if (WM.ui && WM.ui.showToast) WM.ui.showToast(msg);
  }

  function parseTs(s) {
    if (!s) return 0;
    // Postgres отдаёт микросекунды — обрезаем до миллисекунд (совместимость с Safari)
    const n = Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
    return isNaN(n) ? 0 : n;
  }

  function maxTs(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return parseTs(b) > parseTs(a) ? b : a;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtAgo(ts) {
    if (!ts) return 'никогда';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 2) return 'только что';
    if (s < 60) return s + ' с назад';
    if (s < 3600) return Math.floor(s / 60) + ' мин ' + (s % 60) + ' с назад';
    return Math.floor(s / 3600) + ' ч ' + Math.floor((s % 3600) / 60) + ' мин назад';
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' с';
    if (s < 3600) return Math.floor(s / 60) + ' мин ' + (s % 60) + ' с';
    return Math.floor(s / 3600) + ' ч ' + Math.floor((s % 3600) / 60) + ' мин';
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }

  // =========================================================================
  // ЖУРНАЛ ОТЛАДКИ
  // =========================================================================

  function dlog(level, tag, msg) {
    const t = Date.now();
    const last = dbg.entries[dbg.entries.length - 1];
    if (last && last.level === level && last.tag === tag && last.msg === msg && t - last.t < 60000) {
      last.count = (last.count || 1) + 1;
      last.t = t;
    } else {
      dbg.entries.push({ t, level, tag, msg, count: 1 });
      if (dbg.entries.length > CONFIG.debugLogMax) {
        dbg.entries.splice(0, dbg.entries.length - CONFIG.debugLogMax);
      }
    }
    if (level === 'ERR') console.warn('[Squad]', tag, msg);
    persistDebugSoon();
    scheduleDebugRender();
  }

  function persistDebugSoon() {
    if (debugPersistTimer) return;
    debugPersistTimer = setTimeout(() => {
      debugPersistTimer = null;
      lsSet(DEBUG_KEY, JSON.stringify(dbg.entries.slice(-80)));
    }, 1500);
  }

  function loadDebugLog() {
    try {
      const arr = JSON.parse(lsGet(DEBUG_KEY) || '[]');
      if (Array.isArray(arr) && arr.length) {
        dbg.entries = arr.filter(e => e && e.t && e.msg);
        dbg.entries.push({ t: Date.now(), level: 'INFO', tag: 'life', msg: `— перезапуск приложения (squad.js v${MODULE_VERSION}) —`, count: 1 });
      } else {
        dlog('INFO', 'life', `Запуск squad.js v${MODULE_VERSION}`);
      }
    } catch (_) {
      dlog('INFO', 'life', `Запуск squad.js v${MODULE_VERSION}`);
    }
  }

  // =========================================================================
  // СОСТОЯНИЕ (localStorage)
  // =========================================================================

  function loadSavedState() {
    try {
      const saved = JSON.parse(lsGet('wm_squad_state') || '{}');
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
                          (lsGet('wm_squad_creator_' + state.room.id) === state.memberId);
      }
    } catch (e) {
      state.memberId = 'usr_' + Math.random().toString(36).substring(2, 10);
      state.color = getRandomColor();
    }
    if (!state.memberId) state.memberId = 'usr_' + Math.random().toString(36).substring(2, 10);
  }

  function saveState() {
    lsSet('wm_squad_state', JSON.stringify({
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
  }

  // =========================================================================
  // СЕТЕВОЙ СЛОЙ
  // =========================================================================

  class SquadError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'SquadError';
      Object.assign(this, info || {});
    }
  }

  function describeSw() {
    try {
      if (!('serviceWorker' in navigator)) return 'не поддерживается';
      const c = navigator.serviceWorker.controller;
      return c ? ('активен (' + (c.scriptURL || 'sw').replace(location.origin, '') + ')') : 'не управляет страницей';
    } catch (_) { return 'н/д'; }
  }

  function hasSwController() {
    try { return !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (_) { return false; }
  }

  // Превращает ошибку в понятное описание причины + подсказки, что с этим делать
  function classifyError(err) {
    const e = err || {};
    const hints = [];
    let kind = e.kind || 'unknown';
    let title = e.message || 'Неизвестная ошибка';

    if (navigator.onLine === false) {
      kind = 'offline';
      title = 'Устройство не в сети (браузер сообщает, что интернета нет)';
      hints.push('Проверьте Wi-Fi/мобильные данные. Wi-Fi может быть подключён, но без выхода в интернет.');
      return { kind, title, hints };
    }

    switch (kind) {
      case 'timeout':
        title = `Таймаут: сервер не ответил за ${Math.round((e.timeoutMs || 0) / 1000)} с`;
        hints.push('Слабый сигнал или перегруженный канал (проверьте скорость, подойдите ближе к роутеру).');
        hints.push('Страница может быть занята отрисовкой карты/рельефа — на слабом телефоне это задерживает сетевые ответы.');
        hints.push('Возможна блокировка/замедление supabase.co (VPN, прокси, приватный DNS).');
        if (hasSwController()) hints.push('Страница управляется Service Worker — исключите *.supabase.co из его перехвата.');
        break;
      case 'network':
        title = 'Запрос не дошёл до сервера (Failed to fetch)';
        hints.push('Блокировщик рекламы или приватный DNS (AdGuard, NextDNS, Private DNS) может блокировать supabase.co.');
        hints.push('Проект Supabase мог «уснуть» (бесплатные проекты засыпают после недели без активности) — откройте панель Supabase и нажмите Restore.');
        hints.push('VPN/прокси/сеть с фильтрацией, либо смена сети (Wi-Fi ↔ LTE) оборвала соединение.');
        if (hasSwController()) hints.push('Страница управляется Service Worker — он может ломать запросы к *.supabase.co (добавьте в sw.js: if (url.hostname.endsWith("supabase.co")) return;).');
        break;
      case 'parse':
        title = 'Сервер вернул не JSON: ' + (e.message || '');
        hints.push('Ответ мог подменить Wi-Fi-портал, прокси, антивирус или Service Worker.');
        if (hasSwController()) hints.push('Проверьте, что sw.js не кэширует и не подменяет запросы к supabase.co.');
        break;
      case 'http': {
        const s = e.status || 0;
        title = e.message || ('HTTP ' + s);
        if (s === 401 || s === 403) hints.push('Ключ API недействителен/не подходит ИЛИ политики RLS в Supabase запрещают операцию. Проверьте URL/ключ в настройках отряда.');
        else if (s === 404) hints.push('Таблица или адрес не найдены: проверьте URL проекта и выполнен ли SQL-скрипт инициализации.');
        else if (s === 400 || s === 406 || s === 422) hints.push('Сервер отклонил запрос (структура таблиц не совпадает с ожидаемой?).');
        else if (s === 409) hints.push('Конфликт уникальности (запись уже существует).');
        else if (s === 413) hints.push('Слишком большой запрос.');
        else if (s === 429) hints.push('Превышен лимит запросов Supabase — модуль автоматически замедлит опрос.');
        else if (s >= 500) hints.push('Supabase временно недоступен или проект на паузе. Проверьте статус проекта в панели Supabase.');
        break;
      }
      default:
        hints.push('Детали смотрите в журнале ниже.');
    }
    return { kind, title, hints };
  }

  function recordRequestResult(label, ok, ms, err) {
    if (ok) {
      dbg.okCount++;
      dbg.lastOkAt = Date.now();
      dbg.lat.push(ms);
      if (dbg.lat.length > 30) dbg.lat.shift();
      if (ms > 4000) dlog('WARN', 'net', `Медленный ответ «${label}»: ${ms} мс`);
    } else {
      dbg.errCount++;
      dbg.lastErrAt = Date.now();
      const info = classifyError(err);
      dbg.lastError = { at: Date.now(), label, kind: info.kind, title: info.title, hints: info.hints };
      dlog('ERR', 'net', `«${label}» (${ms} мс): ${info.title}`);
    }
  }

  // Один HTTP-запрос без повторов
  async function rawRequest(endpoint, method, body, o) {
    const url = `${state.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${endpoint}`;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs);

    const headers = {
      'apikey': state.supabaseKey,
      'Authorization': `Bearer ${state.supabaseKey}`
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (o.prefer) headers['Prefer'] = o.prefer;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

    try {
      const opts = { method, headers, signal: ctl.signal, cache: 'no-store', credentials: 'omit', mode: 'cors' };
      if (body) opts.body = JSON.stringify(body);

      let res, text;
      try {
        res = await fetch(url, opts);
        text = await res.text();
      } catch (fe) {
        const ms = elapsed();
        if (timedOut) {
          throw new SquadError('Сервер не ответил вовремя', { kind: 'timeout', retryable: true, timeoutMs: o.timeoutMs, ms });
        }
        throw new SquadError(fe && fe.message ? fe.message : 'Failed to fetch', { kind: 'network', retryable: true, ms });
      }
      const ms = elapsed();

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        let code = null;
        try {
          const errObj = JSON.parse(text);
          code = errObj.code || null;
          if (errObj.message) errMsg += `: ${errObj.message}`;
          if (errObj.code === '42P01') errMsg = 'Таблицы базы данных не найдены в Supabase. Запустите SQL-скрипт инициализации.';
          if (errObj.code === '23505') errMsg = 'Отряд с таким паролем уже создан. Используйте "Войти по паролю".';
        } catch (_) {
          if (text) errMsg += `: ${String(text).slice(0, 160)}`;
        }
        throw new SquadError(errMsg, {
          kind: 'http', status: res.status, code, ms,
          retryable: res.status >= 500 || res.status === 429 || res.status === 408
        });
      }

      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (pe) {
          const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '?';
          throw new SquadError(`content-type: ${ct}, начало ответа: «${String(text).slice(0, 60).replace(/\s+/g, ' ')}»`, { kind: 'parse', retryable: true, ms });
        }
      }
      return { data, ms };
    } finally {
      clearTimeout(timer);
    }
  }

  // Запрос с повторами, логированием и статистикой
  async function supabaseRequest(endpoint, method = 'GET', body = null, opts = {}) {
    const isRead = method === 'GET';
    const o = Object.assign({
      timeoutMs: isRead ? CONFIG.getTimeoutMs : CONFIG.writeTimeoutMs,
      retries: (isRead || method === 'PATCH') ? 1 : 0,
      prefer: method === 'GET' ? null : (method === 'DELETE' ? 'return=minimal' : 'return=representation'),
      label: method + ' ' + endpoint.split('?')[0]
    }, opts);

    let attempt = 0;
    for (;;) {
      try {
        const r = await rawRequest(endpoint, method, body, o);
        recordRequestResult(o.label, true, r.ms);
        return r.data;
      } catch (e) {
        recordRequestResult(o.label + (attempt ? ` (повтор ${attempt})` : ''), false, e.ms || 0, e);
        if (attempt < o.retries && e.retryable && navigator.onLine !== false) {
          attempt++;
          await sleep(400 + Math.random() * 500);
          continue;
        }
        throw e;
      }
    }
  }

  function isAmbiguousError(e) {
    // запрос мог дойти до сервера и выполниться, но ответ потерян
    return !!(e && (e.kind === 'timeout' || e.kind === 'network' || e.kind === 'parse' || (e.kind === 'http' && e.status >= 500)));
  }

  // =========================================================================
  // СТАТУС СОЕДИНЕНИЯ
  // =========================================================================

  function setConnStatus(status) {
    connStatus = status;
    const dot = document.getElementById('squad-status-dot');
    const label = document.getElementById('squad-status-text');
    if (dot) {
      dot.className = 'squad-status-dot ' + (status === 'online' ? 'online' : 'offline');
      dot.style.background = status === 'unstable' ? '#f59e0b' : '';
    }
    if (label) {
      label.textContent = status === 'online' ? 'Онлайн'
        : status === 'unstable' ? 'Нестабильно…'
        : status === 'offline' ? (navigator.onLine === false ? 'Нет сети' : 'Связь потеряна')
        : 'Офлайн';
    }
    const dbgBtn = document.getElementById('btn-squad-debug');
    if (dbgBtn) {
      dbgBtn.classList.toggle('bad', status === 'offline');
      dbgBtn.classList.toggle('warn', status === 'unstable');
    }
  }

  // Совместимость со старым именем
  function setOnlineStatus(isOk) {
    setConnStatus(isOk ? 'online' : 'offline');
  }

  function onSyncSuccess() {
    if (dbg.consecutiveFails > 0) {
      const down = dbg.downSince ? fmtDur(Date.now() - dbg.downSince) : '?';
      dlog('OK', 'conn', `Связь восстановлена (неудач подряд: ${dbg.consecutiveFails}, простой ${down})`);
      dbg.reconnects++;
    }
    dbg.consecutiveFails = 0;
    dbg.downSince = 0;
    setConnStatus('online');
    if (outbox.some(p => p.status === 'retry')) flushOutbox();
  }

  function onSyncFailure(err) {
    dbg.consecutiveFails++;
    const info = classifyError(err);
    if (dbg.consecutiveFails === 1) {
      dbg.downSince = Date.now();
      dbg.lastDisconnect = { at: Date.now(), title: info.title, hints: info.hints, kind: info.kind };
      dlog('WARN', 'conn', `Сбой синхронизации: ${info.title}`);
    } else if (dbg.consecutiveFails === 3) {
      dbg.lastDisconnect = { at: Date.now(), title: info.title, hints: info.hints, kind: info.kind };
      dlog('ERR', 'conn', `Связь потеряна (3 неудачи подряд): ${info.title}`);
    }
    setConnStatus(dbg.consecutiveFails >= 3 ? 'offline' : 'unstable');
  }

  // =========================================================================
  // ЛОГИКА КОМНАТ
  // =========================================================================

  function resetRoomRuntime() {
    serverMessages.clear();
    editsInFlight.clear();
    lastMsgCreatedAt = null;
    messagesLoaded = false;
    initialLoaded = false;
    pollCount = 0;
    forceFullNext = false;
    selfSeenInList = false;
    selfMissCount = 0;
    roomMissCount = 0;
    receiptsInitialized = false;
    sentDelivered = sentRead = wantDelivered = wantRead = null;
    lastKnownMembers = [];
    editingMessageId = null;
    chatNodes.clear();
    const box = document.getElementById('squad-chat-messages');
    if (box) box.innerHTML = '';
    const lst = document.getElementById('squad-members-chips');
    if (lst) { lst.innerHTML = ''; lst.removeAttribute('data-sig'); }
  }

  async function lookupRoomByPassword(password) {
    return supabaseRequest(`squad_rooms?password=eq.${encodeURIComponent(password)}&select=*`, 'GET', null, { label: 'room lookup' });
  }

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
      }, { label: 'create room' });
    } catch (e) {
      if (e.code === '23505') throw e;
      if (isAmbiguousError(e)) {
        // Ответ мог потеряться, а комната — создаться. Проверяем, чтобы не плодить дубль/ложную ошибку.
        const found = await lookupRoomByPassword(password);
        if (found && found.length && found[0].creator_id === state.memberId) {
          created = found;
        } else {
          throw e;
        }
      } else {
        // Фолбэк, если в таблице ещё не добавлена колонка creator_id
        created = await supabaseRequest('squad_rooms', 'POST', {
          name: name,
          password: password
        }, { label: 'create room (legacy)' });
      }
    }

    if (!created || !created.length) throw new Error('Не удалось создать комнату');
    const r = created[0];
    resetRoomRuntime();
    state.room = {
      id: r.id,
      name: r.name,
      password: r.password,
      creator_id: r.creator_id || state.memberId
    };
    state.isCreator = true;
    state.connected = true;
    lsSet('wm_squad_creator_' + r.id, state.memberId);
    saveState();
    dlog('OK', 'room', `Создан отряд «${r.name}»`);

    await registerPresence();
    loadOutboxForRoom();
    startSyncLoops();
    updateUIState();
    return state.room;
  }

  async function joinRoom(password, nickname, color) {
    password = (password || '').trim();
    if (password.length < 5) throw new Error('Пароль отряда должен быть от 5 символов');

    const found = await lookupRoomByPassword(password);
    if (!found || !found.length) {
      throw new Error('Отряд с таким паролем не найден');
    }

    const room = found[0];
    state.nickname = sanitizeNickname(nickname) || state.nickname || getRandomEmoji();
    state.color = color || state.color || getRandomColor();
    resetRoomRuntime();
    state.room = {
      id: room.id,
      name: room.name,
      password: room.password,
      creator_id: room.creator_id || null
    };
    state.isCreator = (room.creator_id === state.memberId) ||
                      (lsGet('wm_squad_creator_' + room.id) === state.memberId);
    state.connected = true;
    saveState();
    dlog('OK', 'room', `Вход в отряд «${room.name}»`);

    await registerPresence();
    loadOutboxForRoom();
    startSyncLoops();
    updateUIState();
    return state.room;
  }

  function localLeaveCleanup(roomId) {
    state.connected = false;
    state.room = null;
    state.isCreator = false;
    saveState();
    stopSyncLoops();
    clearMarkers();
    outbox = outbox.filter(p => p.room_id !== roomId);
    persistOutbox();
    resetRoomRuntime();
    setConnStatus('idle');
    updateUIState();
    closeWindow();
  }

  async function leaveRoom(silent = false) {
    if (!state.room) return;
    const roomId = state.room.id;
    const memberId = state.memberId;

    try {
      await supabaseRequest(`squad_members?room_id=eq.${roomId}&member_id=eq.${memberId}`, 'DELETE', null, { label: 'leave' });
      const remaining = await supabaseRequest(`squad_members?room_id=eq.${roomId}&select=id`, 'GET', null, { label: 'leave check' });
      if (Array.isArray(remaining) && remaining.length === 0) {
        await supabaseRequest(`squad_rooms?id=eq.${roomId}`, 'DELETE', null, { label: 'delete empty room' });
      }
    } catch (e) {
      console.warn('[Squad] Ошибка при выходе:', e);
      dlog('WARN', 'room', 'Ошибка при выходе из отряда на сервере (локально вы вышли): ' + e.message);
    } finally {
      localLeaveCleanup(roomId);
      dlog('INFO', 'room', 'Вы вышли из отряда');
      if (!silent) toast('Вы вышли из отряда');
    }
  }

  // =========================================================================
  // ПРАВА И ДЕЙСТВИЯ СОЗДАТЕЛЯ ОТРЯДА
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
    }, { label: 'update room' });

    state.room.name = newName;
    state.room.password = newPassword;
    saveState();
    updateUIState();

    // Системное сообщение в чат об изменениях
    sendMessage(`📢 Создатель обновил данные отряда: «${newName}» (пароль изменён)`);
    toast('✅ Параметры отряда успешно обновлены');
  }

  async function kickMember(targetMemberId, targetNick) {
    if (!state.connected || !state.room || !state.isCreator) return;
    if (targetMemberId === state.memberId) return;

    if (!confirm(`Исключить участника «${targetNick}» из отряда?`)) return;

    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${targetMemberId}`, 'DELETE', null, { label: 'kick' });
      sendMessage(`⛔ Участник «${targetNick}» исключён создателем из отряда.`);
      syncSquadData();
      toast(`Участник ${targetNick} исключён`);
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
      // Системное сообщение отправляем напрямую (очередь здесь не подходит: комната сейчас будет удалена)
      try {
        await supabaseRequest('squad_messages', 'POST', {
          room_id: roomId,
          member_id: state.memberId,
          nickname: state.nickname,
          color: state.color,
          text: '⚠️ Создатель расформировал отряд. Комната закрыта.'
        }, { label: 'disband msg', retries: 0 });
      } catch (_) {}
      await supabaseRequest(`squad_messages?room_id=eq.${roomId}`, 'DELETE', null, { label: 'delete messages' });
      await supabaseRequest(`squad_members?room_id=eq.${roomId}`, 'DELETE', null, { label: 'delete members' });
      await supabaseRequest(`squad_rooms?id=eq.${roomId}`, 'DELETE', null, { label: 'delete room' });
    } catch (e) {
      console.warn('Ошибка при удалении отряда:', e);
      dlog('ERR', 'room', 'Ошибка при удалении отряда: ' + e.message);
    } finally {
      localLeaveCleanup(roomId);
      toast('💥 Отряд полностью расформирован и удален');
    }
  }

  // Регистрация/обновление присутствия. Не бросает исключений — повторится из опроса при необходимости.
  async function registerPresence() {
    if (!state.room) return false;
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
    const filter = `squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`;
    try {
      const rows = await supabaseRequest(filter, 'PATCH', payload, { label: 'presence' });
      if (Array.isArray(rows) && rows.length) return true;
      try {
        await supabaseRequest('squad_members', 'POST', payload, { label: 'presence insert', retries: 0 });
      } catch (e2) {
        if (e2.status === 409 || e2.code === '23505') {
          await supabaseRequest(filter, 'PATCH', payload, { label: 'presence retry' });
        } else {
          throw e2;
        }
      }
      return true;
    } catch (e) {
      dlog('WARN', 'presence', 'Не удалось обновить присутствие: ' + e.message);
      return false;
    }
  }

  // =========================================================================
  // СИНХРОНИЗАЦИЯ
  // =========================================================================

  function syncSquadData(opts) {
    if (!state.connected || !state.room) return Promise.resolve();
    if (syncInFlight) {
      syncQueued = true;
      if (opts && opts.full) forceFullNext = true;
      return syncInFlight;
    }
    if (opts && opts.full) forceFullNext = true;
    syncInFlight = (async () => {
      try {
        await doSync();
      } finally {
        syncInFlight = null;
      }
      if (syncQueued) {
        syncQueued = false;
        return syncSquadData();
      }
    })();
    return syncInFlight;
  }

  async function doSync() {
    if (!state.connected || !state.room) return;
    const roomId = state.room.id;
    dbg.syncCount++;
    pollCount++;

    const full = forceFullNext || !messagesLoaded || !lastMsgCreatedAt || (pollCount % CONFIG.fullRefreshEvery === 0);
    forceFullNext = false;

    const membersP = supabaseRequest(`squad_members?room_id=eq.${roomId}&select=*`, 'GET', null, { label: 'members' });
    const msgsQuery = full
      ? `squad_messages?room_id=eq.${roomId}&select=*&order=created_at.desc&limit=${CONFIG.messagesLimit}`
      : `squad_messages?room_id=eq.${roomId}&select=*&created_at=gt.${encodeURIComponent(lastMsgCreatedAt)}&order=created_at.asc&limit=200`;
    const msgsP = supabaseRequest(msgsQuery, 'GET', null, { label: full ? 'messages (full)' : 'messages (new)' });
    const roomP = full
      ? supabaseRequest(`squad_rooms?id=eq.${roomId}&select=*`, 'GET', null, { label: 'room' })
      : Promise.resolve(undefined);

    const results = await Promise.allSettled([membersP, msgsP, roomP]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
      onSyncFailure(failed.reason);
      return;
    }
    // Если за время запросов пользователь вышел/сменил комнату — результат устарел
    if (!state.connected || !state.room || state.room.id !== roomId) return;

    const members = results[0].value;
    const msgs = results[1].value;
    const roomRows = results[2].value;

    // 1. Комната (название, пароль, удалена ли создателем)
    if (roomRows !== undefined) {
      if (Array.isArray(roomRows) && roomRows.length === 0) {
        roomMissCount++;
        if (roomMissCount >= 2) {
          dlog('WARN', 'room', 'Комната не найдена на сервере (2 проверки подряд) — отряд расформирован');
          setTimeout(() => alert('⚠️ Отряд был расформирован создателем.'), 0);
          await leaveRoom(true);
          return;
        }
        forceFullNext = true; // перепроверим на следующем опросе
      } else if (Array.isArray(roomRows) && roomRows.length) {
        roomMissCount = 0;
        const freshRoom = roomRows[0];
        if (freshRoom.name !== state.room.name || freshRoom.password !== state.room.password) {
          state.room.name = freshRoom.name;
          state.room.password = freshRoom.password;
          saveState();
          updateUIState();
        }
      }
    }

    // 2. Участники
    lastKnownMembers = Array.isArray(members) ? members : [];
    if (lastKnownMembers.length && !('last_read_at' in lastKnownMembers[0]) && receiptsSupported) {
      receiptsSupported = false;
      if (!receiptsWarned) {
        receiptsWarned = true;
        dlog('WARN', 'receipts', 'В squad_members нет колонок last_delivered_at / last_read_at — статусы «доставлено/прочитано» отключены. Выполните SQL (см. 🐞).');
      }
    }

    const self = lastKnownMembers.find(m => m.member_id === state.memberId);
    if (self) {
      selfSeenInList = true;
      selfMissCount = 0;
      if (!receiptsInitialized) {
        receiptsInitialized = true;
        sentDelivered = self.last_delivered_at || null;
        sentRead = self.last_read_at || null;
      }
    } else if (lastKnownMembers.length > 0) {
      selfMissCount++;
      if (!selfSeenInList) {
        // Мы ещё ни разу не появлялись в списке (регистрация не удалась) — регистрируемся заново
        registerPresence();
      } else if (selfMissCount >= 2 && !state.isCreator) {
        dlog('WARN', 'room', 'Вас нет в списке участников (2 проверки подряд) — исключены создателем');
        setTimeout(() => alert('⚠️ Вы были исключены из отряда создателем.'), 0);
        await leaveRoom(true);
        return;
      }
    }

    renderMembersOnMap(lastKnownMembers);
    renderMembersList(lastKnownMembers);

    // 3. Сообщения
    const rows = Array.isArray(msgs) ? msgs : [];
    const res = mergeServerMessages(rows, full);
    if (full) messagesLoaded = true;

    if (res.newForeign > 0 && initialLoaded) {
      const hiddenNow = !isWindowOpen || isWindowMinimized || document.hidden;
      if (hiddenNow) {
        unreadMessagesCount += res.newForeign;
        if (navigator.vibrate) { try { navigator.vibrate(40); } catch (_) {} }
        updateUnreadBadgeUI();
      }
    }
    initialLoaded = true;

    renderChat();
    maybeMarkRead();
    onSyncSuccess();
  }

  function mergeServerMessages(rows, full) {
    let changed = false;
    let newForeign = 0;
    for (const r of rows) {
      if (r == null || r.id == null) continue;
      const key = String(r.id);
      if (editsInFlight.has(key)) continue;
      const prev = serverMessages.get(key);
      if (!prev) {
        serverMessages.set(key, r);
        changed = true;
        if (r.member_id !== state.memberId) newForeign++;
        else reconcilePendingWithServerRow(r);
      } else if (prev.text !== r.text || prev.updated_at !== r.updated_at || prev.nickname !== r.nickname || prev.color !== r.color) {
        serverMessages.set(key, r);
        changed = true;
      }
      if (!lastMsgCreatedAt || parseTs(r.created_at) > parseTs(lastMsgCreatedAt)) {
        lastMsgCreatedAt = r.created_at;
      }
    }
    // Ограничиваем память
    if (serverMessages.size > CONFIG.messagesKeep) {
      const sorted = [...serverMessages.values()].sort(cmpMsg);
      const drop = sorted.slice(0, sorted.length - CONFIG.messagesKeep);
      drop.forEach(m => { serverMessages.delete(String(m.id)); const n = chatNodes.get('m' + m.id); if (n) { n.el.remove(); chatNodes.delete('m' + m.id); } });
    }
    return { changed, newForeign };
  }

  function cmpMsg(a, b) {
    const d = parseTs(a.created_at) - parseTs(b.created_at);
    if (d) return d;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  }

  async function sendGpsCoordinates() {
    if (!state.connected || !state.room || !state.shareLocation || !lastGpsCoords) return;
    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`, 'PATCH', {
        lat: lastGpsCoords[0],
        lng: lastGpsCoords[1],
        share_location: true,
        last_seen: new Date().toISOString()
      }, { prefer: 'return=minimal', label: 'gps' });
    } catch (e) {
      console.warn('[Squad] Ошибка отправки GPS:', e);
    }
  }

  async function sendHeartbeat() {
    if (!state.connected || !state.room || document.hidden) return;
    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`, 'PATCH', {
        last_seen: new Date().toISOString()
      }, { prefer: 'return=minimal', label: 'heartbeat', retries: 0 });
    } catch (_) { /* журнал ведёт сетевой слой */ }
  }

  // ---- планировщик опроса ----

  function currentPollDelay() {
    let base;
    if (document.hidden) base = CONFIG.pollHiddenMs;
    else if (isWindowOpen && !isWindowMinimized) base = CONFIG.pollOpenMs;
    else base = CONFIG.pollIdleMs;
    const f = dbg.consecutiveFails;
    if (f > 0) {
      base = Math.min(CONFIG.pollMaxBackoffMs, Math.max(base, 2000) * Math.pow(1.7, Math.min(f, 8)));
    }
    return Math.round(base * (0.85 + Math.random() * 0.3));
  }

  function schedulePoll(delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!state.connected) return;
    pollTimer = setTimeout(pollTick, delay === undefined ? currentPollDelay() : delay);
  }

  async function pollTick() {
    pollTimer = null;
    if (!state.connected) return;
    try {
      await syncSquadData();
    } catch (e) {
      dlog('ERR', 'sync', 'Необработанная ошибка синхронизации: ' + (e && e.message));
    }
    schedulePoll();
  }

  // Мгновенная ресинхронизация (вернулись во вкладку, появилась сеть и т.п.)
  function wake(reason, forceFull) {
    if (!state.connected) return;
    dlog('INFO', 'life', 'Пробуждение: ' + reason);
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    syncSquadData({ full: !!forceFull }).then(() => schedulePoll(), () => schedulePoll());
    flushOutbox();
    maybeMarkRead();
  }

  function startSyncLoops() {
    stopSyncLoops();
    if (!state.connected) return;

    schedulePoll(0);
    const intervalMs = Math.max(10, state.updateIntervalSec) * 1000;
    gpsSendTimer = setInterval(sendGpsCoordinates, intervalMs);
    heartbeatTimer = setInterval(sendHeartbeat, CONFIG.heartbeatMs);
    flushOutbox();
  }

  function stopSyncLoops() {
    if (pollTimer) clearTimeout(pollTimer);
    if (gpsSendTimer) clearInterval(gpsSendTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (outboxTimer) clearTimeout(outboxTimer);
    pollTimer = null;
    gpsSendTimer = null;
    heartbeatTimer = null;
    outboxTimer = null;
  }

  // =========================================================================
  // ОТПРАВКА СООБЩЕНИЙ: OUTBOX + OPTIMISTIC UI
  // =========================================================================

  function persistOutbox() {
    const toSave = outbox.map(p => ({
      tmp: p.tmp, room_id: p.room_id, text: p.text, ts: p.ts, baseTs: p.baseTs || null,
      status: p.status === 'failed' ? 'failed' : 'retry',
      attempts: p.attempts, lastError: p.lastError || ''
    }));
    lsSet(OUTBOX_KEY, JSON.stringify(toSave));
  }

  function loadOutboxForRoom() {
    try {
      const arr = JSON.parse(lsGet(OUTBOX_KEY) || '[]');
      outbox = (Array.isArray(arr) ? arr : [])
        .filter(p => p && p.tmp && p.text && state.room && String(p.room_id) === String(state.room.id))
        .map(p => ({
          tmp: p.tmp, room_id: p.room_id, text: p.text, ts: p.ts || Date.now(), baseTs: p.baseTs || null,
          status: p.status === 'failed' ? 'failed' : 'retry',
          attempts: p.status === 'failed' ? (p.attempts || 0) : 0,
          ambiguous: true, // страница могла закрыться посреди отправки
          nextAt: 0, lastError: p.lastError || ''
        }));
      if (outbox.length) dlog('INFO', 'outbox', `Восстановлено неотправленных сообщений: ${outbox.length}`);
    } catch (_) {
      outbox = [];
    }
  }

  // Отправка нового сообщения. Возвращается мгновенно: сообщение уже на экране со статусом «отправляется».
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text || text.length > 512 || !state.room) return null;

    const p = {
      tmp: randId('tmp_'),
      room_id: state.room.id,
      text: text,
      ts: Date.now(),
      baseTs: lastMsgCreatedAt, // серверная метка последнего известного сообщения (не зависит от часов телефона)
      status: 'retry',
      attempts: 0,
      ambiguous: false,
      nextAt: 0,
      lastError: ''
    };
    outbox.push(p);
    persistOutbox();
    renderChat({ forceScroll: true });
    flushOutbox();
    return p;
  }

  function scheduleOutboxRetry(ms) {
    if (outboxTimer) clearTimeout(outboxTimer);
    outboxTimer = setTimeout(() => { outboxTimer = null; flushOutbox(); }, Math.max(200, ms));
  }

  async function flushOutbox() {
    if (outboxRunning) return;
    outboxRunning = true;
    try {
      for (;;) {
        if (!state.connected || !state.room) break;
        const item = outbox.find(p => p.status !== 'failed' && String(p.room_id) === String(state.room.id));
        if (!item) break;
        if (item.nextAt && item.nextAt > Date.now()) {
          scheduleOutboxRetry(item.nextAt - Date.now());
          break;
        }
        const r = await trySendPending(item);
        if (r === 'stop') break;
      }
    } finally {
      outboxRunning = false;
    }
  }

  function adoptServerRow(item, row) {
    const idx = outbox.indexOf(item);
    if (idx >= 0) outbox.splice(idx, 1);
    persistOutbox();
    const key = String(row.id);
    // Переносим существующий DOM-узел, чтобы пузырь не мигал
    const node = chatNodes.get('p' + item.tmp);
    if (node) { chatNodes.delete('p' + item.tmp); node.sig = null; chatNodes.set('m' + row.id, node); }
    serverMessages.set(key, row);
    // lastMsgCreatedAt здесь намеренно НЕ двигаем: иначе можно пропустить чужие сообщения, созданные раньше нашего
    renderChat();
  }

  function reconcilePendingWithServerRow(row) {
    // Опрос принёс наше сообщение раньше, чем пришёл ответ на POST (или ответ потерялся)
    const item = outbox.find(p =>
      p.text === row.text && String(p.room_id) === String(row.room_id) &&
      (p.status === 'retry' || p.status === 'sending') && (p.ambiguous || p.status === 'sending' || p.attempts > 0) &&
      (!p.baseTs || parseTs(row.created_at) >= parseTs(p.baseTs)));
    if (item) {
      const idx = outbox.indexOf(item);
      outbox.splice(idx, 1);
      persistOutbox();
      const node = chatNodes.get('p' + item.tmp);
      if (node) { chatNodes.delete('p' + item.tmp); node.sig = null; chatNodes.set('m' + row.id, node); }
      dlog('INFO', 'outbox', 'Сообщение подтверждено опросом (ответ на отправку не дошёл)');
    }
  }

  async function findExistingMessage(item) {
    const rows = await supabaseRequest(
      `squad_messages?room_id=eq.${encodeURIComponent(item.room_id)}&member_id=eq.${encodeURIComponent(state.memberId)}` +
      `&order=created_at.desc&limit=20&select=*`,
      'GET', null, { label: 'dedupe check' });
    if (!Array.isArray(rows)) return null;
    const base = item.baseTs ? parseTs(item.baseTs) : 0;
    return rows.find(r => r.text === item.text && !serverMessages.has(String(r.id)) && parseTs(r.created_at) >= base) || null;
  }

  async function trySendPending(item) {
    item.status = 'sending';
    item.attempts++;
    renderChat();
    try {
      if (item.ambiguous) {
        const ex = await findExistingMessage(item);
        if (ex) {
          dlog('INFO', 'outbox', 'Сообщение уже было сохранено на сервере — дубль не создаётся');
          if (outbox.includes(item)) adoptServerRow(item, ex);
          return 'ok';
        }
      }
      const rows = await supabaseRequest('squad_messages', 'POST', {
        room_id: item.room_id,
        member_id: state.memberId,
        nickname: state.nickname,
        color: state.color,
        text: item.text
      }, { retries: 0, label: 'send message' });

      if (!outbox.includes(item)) return 'ok'; // уже подтверждено опросом
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.id != null) {
        adoptServerRow(item, row);
      } else {
        outbox.splice(outbox.indexOf(item), 1);
        persistOutbox();
        forceFullNext = true;
        syncSquadData({ full: true });
      }
      if (connStatus !== 'online') { dbg.consecutiveFails = 0; setConnStatus('online'); }
      return 'ok';
    } catch (e) {
      if (!outbox.includes(item)) return 'ok';
      const info = classifyError(e);
      item.lastError = info.title;
      if (e.kind === 'http' && !e.retryable) {
        item.status = 'failed';
        dlog('ERR', 'outbox', `Сообщение отклонено сервером: ${e.message}`);
        persistOutbox();
        renderChat();
        return 'next';
      }
      item.ambiguous = item.ambiguous || isAmbiguousError(e);
      if (item.attempts >= CONFIG.outboxMaxAttempts) {
        item.status = 'failed';
        dlog('ERR', 'outbox', `Сообщение не отправлено после ${item.attempts} попыток: ${info.title}`);
        persistOutbox();
        renderChat();
        return 'next';
      }
      item.status = 'retry';
      const wait = CONFIG.outboxBackoffMs[Math.min(item.attempts - 1, CONFIG.outboxBackoffMs.length - 1)];
      item.nextAt = Date.now() + wait;
      dlog('WARN', 'outbox', `Отправка не удалась (попытка ${item.attempts}), повтор через ${Math.round(wait / 1000)} с`);
      persistOutbox();
      renderChat();
      scheduleOutboxRetry(wait);
      return 'stop';
    }
  }

  function retryPending(tmp) {
    const item = outbox.find(p => p.tmp === tmp);
    if (!item) return;
    item.status = 'retry';
    item.attempts = 0;
    item.nextAt = 0;
    item.ambiguous = true;
    persistOutbox();
    renderChat();
    flushOutbox();
  }

  function discardPending(tmp) {
    const idx = outbox.findIndex(p => p.tmp === tmp);
    if (idx < 0) return;
    outbox.splice(idx, 1);
    persistOutbox();
    renderChat();
  }

  async function editMessage(id, text) {
    const key = String(id);
    const prev = serverMessages.get(key);
    if (!prev) return;
    text = (text || '').trim();
    if (!text || text.length > 512 || text === prev.text) return;

    const nowIso = new Date().toISOString();
    editsInFlight.add(key);
    serverMessages.set(key, Object.assign({}, prev, { text, updated_at: nowIso }));
    renderChat();
    try {
      const rows = await supabaseRequest(`squad_messages?id=eq.${encodeURIComponent(prev.id)}&member_id=eq.${encodeURIComponent(state.memberId)}`, 'PATCH', {
        text: text,
        updated_at: nowIso
      }, { label: 'edit message' });
      if (Array.isArray(rows) && rows[0]) serverMessages.set(key, rows[0]);
    } catch (e) {
      serverMessages.set(key, prev);
      toast('⚠️ Не удалось изменить сообщение: ' + (classifyError(e).title));
      const inp = document.getElementById('squad-chat-input');
      if (inp && !inp.value) { inp.value = text; }
    } finally {
      editsInFlight.delete(key);
      renderChat();
    }
  }

  // =========================================================================
  // КВИТАНЦИИ: ДОСТАВЛЕНО / ПРОЧИТАНО
  // =========================================================================

  function newestForeignCreatedAt() {
    let best = null;
    for (const m of serverMessages.values()) {
      if (m.member_id === state.memberId) continue;
      best = maxTs(best, m.created_at);
    }
    return best;
  }

  function maybeMarkRead() {
    if (!state.connected || !receiptsSupported) return;
    const newest = newestForeignCreatedAt();
    if (!newest) return;
    wantDelivered = maxTs(wantDelivered, newest);
    const visible = isWindowOpen && !isWindowMinimized && !document.hidden;
    if (visible) {
      wantRead = maxTs(wantRead, newest);
      if (unreadMessagesCount) { unreadMessagesCount = 0; updateUnreadBadgeUI(); }
    }
    schedulePushReceipts();
  }

  function schedulePushReceipts() {
    if (receiptTimer) return;
    receiptTimer = setTimeout(() => { receiptTimer = null; pushReceipts(); }, 400);
  }

  function isMissingColumnError(e) {
    if (!e) return false;
    if (e.code === 'PGRST204' || e.code === '42703') return true;
    return e.kind === 'http' && e.status === 400 && /last_(read|delivered)_at|column/i.test(e.message || '');
  }

  async function pushReceipts() {
    if (!receiptsSupported || !receiptsInitialized || !state.connected || !state.room) return;
    if (receiptInFlight) { receiptDirty = true; return; }

    const patch = {};
    if (wantDelivered && parseTs(wantDelivered) > parseTs(sentDelivered)) patch.last_delivered_at = wantDelivered;
    if (wantRead && parseTs(wantRead) > parseTs(sentRead)) {
      patch.last_read_at = wantRead;
      if (parseTs(wantRead) > parseTs(sentDelivered) && !patch.last_delivered_at) patch.last_delivered_at = wantRead;
    }
    if (!Object.keys(patch).length) return;

    receiptInFlight = true;
    try {
      await supabaseRequest(`squad_members?room_id=eq.${state.room.id}&member_id=eq.${state.memberId}`, 'PATCH', patch, { prefer: 'return=minimal', label: 'receipt', retries: 1 });
      if (patch.last_delivered_at) sentDelivered = patch.last_delivered_at;
      if (patch.last_read_at) sentRead = patch.last_read_at;
    } catch (e) {
      if (isMissingColumnError(e)) {
        receiptsSupported = false;
        if (!receiptsWarned) {
          receiptsWarned = true;
          dlog('WARN', 'receipts', 'Колонки last_delivered_at / last_read_at не найдены — статусы «доставлено/прочитано» отключены. Выполните SQL (см. 🐞).');
        }
        renderChat();
      }
    } finally {
      receiptInFlight = false;
      if (receiptDirty) { receiptDirty = false; schedulePushReceipts(); }
    }
  }

  function computeStatus(m) {
    const others = lastKnownMembers.filter(x => x.member_id !== state.memberId);
    if (!receiptsSupported || !others.length) return { code: 'sent', delivered: 0, read: 0, total: others.length };
    const t = parseTs(m.created_at);
    let delivered = 0, read = 0;
    others.forEach(o => {
      const d = parseTs(o.last_delivered_at);
      const r = parseTs(o.last_read_at);
      if (r && r >= t) { read++; delivered++; }
      else if (d && d >= t) delivered++;
    });
    return { code: read > 0 ? 'read' : (delivered > 0 ? 'delivered' : 'sent'), delivered, read, total: others.length };
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
      const color = safeColor(m.color);

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
        marker._wmHtml = markerHtml;
        marker._wmMember = m;

        marker.on('click', () => {
          const mm = marker._wmMember || m;
          const minsAgo = Math.round((Date.now() - parseTs(mm.last_seen)) / 60000);
          const timeAgoText = minsAgo <= 1 ? 'сейчас' : `${minsAgo} мин назад`;
          map.panTo([mm.lat, mm.lng]);
          toast(`🎯 Участник: ${mm.nickname} (${timeAgoText})`);
        });

        memberMarkers.set(m.member_id, marker);
      } else {
        marker._wmMember = m;
        marker.setLatLng(latlng);
        if (marker._wmHtml !== markerHtml) {
          marker._wmHtml = markerHtml;
          marker.setIcon(L.divIcon({
            className: 'wm-squad-marker-wrap',
            html: markerHtml,
            iconSize: isFar ? [16, 16] : [120, 36],
            iconAnchor: isFar ? [8, 8] : [60, 34]
          }));
        }
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
  // ИНТЕРФЕЙС: СПИСОК УЧАСТНИКОВ И ЧАТ
  // =========================================================================

  function renderMembersList(members) {
    const listEl = document.getElementById('squad-members-chips');
    if (!listEl) return;

    const now = Date.now();
    const sig = members.map(m => [
      m.member_id, m.nickname, m.color, m.share_location ? 1 : 0, m.lat, m.lng,
      (m.member_id === state.memberId || (now - parseTs(m.last_seen) < CONFIG.onlineWindowMs)) ? 1 : 0
    ].join('|')).join(';') + '#' + (state.isCreator ? 1 : 0) + '#' + (state.room ? state.room.creator_id : '');
    if (listEl.getAttribute('data-sig') === sig) return;
    listEl.setAttribute('data-sig', sig);
    listEl.innerHTML = '';

    members.forEach(m => {
      const isMe = m.member_id === state.memberId;
      const hasCoords = m.share_location && m.lat != null && m.lng != null;
      const isCreatorMember = state.room && state.room.creator_id === m.member_id;
      const isOnline = isMe || (now - parseTs(m.last_seen) < CONFIG.onlineWindowMs);
      const col = safeColor(m.color);

      const chip = document.createElement('div');
      chip.className = 'squad-member-chip' + (hasCoords ? ' has-coords' : '') + (isOnline ? '' : ' squad-member-offline');
      chip.style.borderColor = col;
      if (!isOnline) chip.title = 'Не в сети (был: ' + fmtAgo(parseTs(m.last_seen)) + ')';

      let kickBtnHtml = '';
      if (state.isCreator && !isMe) {
        kickBtnHtml = `<button type="button" class="squad-member-kick-btn" title="Исключить участника">✕</button>`;
      }

      chip.innerHTML = `
        <span class="squad-chip-dot" style="background: ${col};"></span>
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
            toast(`🎯 Камера перенесена к ${m.nickname}`);
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

    // 2. Автоссылки (URL) — только вне уже созданных кнопок координат
    const urlRegex = /(https?:\/\/[^\s<]+)/gi;
    safe = safe.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    return safe;
  }

  function tickHtml(it) {
    if (it.kind === 'pending') {
      const p = it.p;
      if (p.status === 'failed') {
        return `<span class="squad-tick squad-tick-fail" title="Не отправлено: ${escapeHtml(p.lastError || 'ошибка сети')}">⚠️</span>` +
               `<button type="button" class="squad-msg-retry-btn" data-tmp="${escapeHtml(p.tmp)}" title="Повторить отправку">🔄 Повторить</button>` +
               `<button type="button" class="squad-msg-discard-btn" data-tmp="${escapeHtml(p.tmp)}" title="Удалить неотправленное">✕</button>`;
      }
      const why = p.status === 'retry' && p.lastError ? ` (повтор: ${escapeHtml(p.lastError)})` : '';
      return `<span class="squad-tick squad-tick-wait" title="Отправляется…${why}">🕓</span>`;
    }
    if (!it.isMe || !it.st) return '';
    const st = it.st;
    if (st.code === 'read') {
      return `<span class="squad-tick squad-tick-read" title="Прочитано (${st.read} из ${st.total})">✓✓</span>`;
    }
    if (st.code === 'delivered') {
      return `<span class="squad-tick squad-tick-delivered" title="Доставлено (${st.delivered} из ${st.total})">✓✓</span>`;
    }
    return `<span class="squad-tick squad-tick-sent" title="Отправлено на сервер">✓</span>`;
  }

  function fillBubble(el, it) {
    const isServer = it.kind === 'server';
    const m = isServer ? it.m : null;
    const nickname = isServer ? m.nickname : state.nickname;
    const color = safeColor(isServer ? m.color : state.color);
    const text = isServer ? m.text : it.p.text;
    const ts = isServer ? parseTs(m.created_at) : it.p.ts;
    const timeStr = new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const isEdited = isServer && m.updated_at && m.updated_at !== m.created_at;

    el.className = 'squad-msg-bubble' + (it.isMe ? ' me' : '') +
      (it.kind === 'pending' ? (it.p.status === 'failed' ? ' failed' : ' pending') : '');
    el.style.borderLeftColor = color;

    el.innerHTML = `
      <div class="squad-msg-head">
        <span class="squad-msg-author" style="color: ${color};">${escapeHtml(nickname)}</span>
        <span class="squad-msg-time">${timeStr}${isEdited ? ' (ред.)' : ''}</span>
        ${it.isMe ? tickHtml(it) : ''}
        ${(it.isMe && isServer) ? `<button type="button" class="squad-msg-edit-btn" data-mid="${escapeHtml(String(m.id))}" title="Редактировать">✏️</button>` : ''}
      </div>
      <div class="squad-msg-text">${formatChatMessageText(text)}</div>
    `;
  }

  function buildRenderItems() {
    const items = [];
    const server = [...serverMessages.values()].sort(cmpMsg);
    for (const m of server) {
      const isMe = m.member_id === state.memberId;
      const st = isMe ? computeStatus(m) : null;
      items.push({
        key: 'm' + m.id, kind: 'server', m, isMe, st,
        sig: [m.text, m.updated_at || '', m.nickname || '', m.color || '',
          st ? (st.code + ':' + st.delivered + '/' + st.read + '/' + st.total) : ''].join('\u0001')
      });
    }
    const roomId = state.room ? String(state.room.id) : '';
    outbox.filter(p => String(p.room_id) === roomId).sort((a, b) => a.ts - b.ts).forEach(p => {
      items.push({
        key: 'p' + p.tmp, kind: 'pending', p, isMe: true,
        sig: [p.text, p.status, p.lastError || '', p.attempts, state.nickname, state.color].join('\u0001')
      });
    });
    return items;
  }

  function renderChat(opts) {
    opts = opts || {};
    const box = document.getElementById('squad-chat-messages');
    if (!box) return;

    const items = buildRenderItems();
    const nearBottom = box.scrollHeight - box.clientHeight <= box.scrollTop + 60;

    const placeholder = box.querySelector('.squad-chat-empty');
    if (!items.length) {
      chatNodes.forEach(n => n.el.remove());
      chatNodes.clear();
      if (!placeholder) {
        box.innerHTML = '<div class="squad-chat-empty" style="text-align:center; padding:20px; font-size:11.5px; color:var(--text-muted);">Сообщений пока нет. Напишите первым!</div>';
      }
      return;
    }
    if (placeholder) placeholder.remove();

    const wanted = new Set();
    items.forEach((it, i) => {
      wanted.add(it.key);
      let node = chatNodes.get(it.key);
      if (!node) {
        node = { el: document.createElement('div'), sig: null };
        chatNodes.set(it.key, node);
      }
      if (node.sig !== it.sig) {
        fillBubble(node.el, it);
        node.sig = it.sig;
      }
      const ref = box.children[i];
      if (ref !== node.el) box.insertBefore(node.el, ref || null);
    });

    for (const [key, node] of chatNodes) {
      if (!wanted.has(key)) {
        node.el.remove();
        chatNodes.delete(key);
      }
    }

    if (opts.forceScroll || nearBottom) {
      box.scrollTop = box.scrollHeight;
    }
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
    renderChat({ forceScroll: true });

    if (state.connected) {
      wake('открыто окно чата');
    }
  }

  function closeWindow() {
    const win = document.getElementById('squad-window');
    if (!win) return;
    isWindowOpen = false;
    win.hidden = true;
    closeDebugPanel();
  }

  function toggleMinimizeWindow() {
    const win = document.getElementById('squad-window');
    if (!win) return;
    isWindowMinimized = !isWindowMinimized;
    win.classList.toggle('minimized', isWindowMinimized);
    if (!isWindowMinimized) {
      unreadMessagesCount = 0;
      updateUnreadBadgeUI();
      maybeMarkRead();
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
        if (editNameInp && document.activeElement !== editNameInp) editNameInp.value = state.room.name || '';
        if (editPassInp && document.activeElement !== editPassInp) editPassInp.value = state.room.password || '';
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
    if (urlInp && document.activeElement !== urlInp) urlInp.value = state.supabaseUrl;

    const keyInp = document.getElementById('squad-cfg-supabase-key');
    if (keyInp && document.activeElement !== keyInp) keyInp.value = state.supabaseKey;
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

  // =========================================================================
  // ОТЛАДОЧНАЯ ПАНЕЛЬ 🐞
  // =========================================================================

  function injectStyles() {
    if (document.getElementById('wm-squad-extra-css')) return;
    const st = document.createElement('style');
    st.id = 'wm-squad-extra-css';
    st.textContent = `
      .squad-tick{font-size:11px;font-weight:700;letter-spacing:-2px;margin-left:5px;color:#94a3b8;user-select:none}
      .squad-tick-wait{letter-spacing:0;font-weight:400;opacity:.8}
      .squad-tick-delivered{color:#94a3b8}
      .squad-tick-read{color:#38bdf8}
      .squad-tick-fail{letter-spacing:0}
      .squad-msg-bubble.pending{opacity:.78}
      .squad-msg-bubble.failed{outline:1px solid #ef4444;outline-offset:-1px}
      .squad-msg-retry-btn,.squad-msg-discard-btn{margin-left:6px;font-size:10.5px;padding:1px 6px;border:1px solid #ef4444;border-radius:8px;background:transparent;color:#ef4444;cursor:pointer}
      .squad-member-offline{opacity:.55}
      .squad-debug-btn{background:transparent;border:none;cursor:pointer;font-size:14px;line-height:1;padding:2px 5px;border-radius:6px;position:relative}
      .squad-debug-btn.warn{background:rgba(245,158,11,.25)}
      .squad-debug-btn.bad{background:rgba(239,68,68,.30)}
      #squad-debug-panel{position:absolute;left:0;right:0;top:0;bottom:0;z-index:60;display:flex;flex-direction:column;background:#0f172a;color:#e2e8f0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      #squad-debug-panel[hidden]{display:none}
      #squad-debug-panel .dbg-head{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#1e293b;flex-wrap:wrap}
      #squad-debug-panel .dbg-head b{flex:1;font-size:12px;min-width:120px}
      #squad-debug-panel button{background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer}
      #squad-debug-panel button:active{background:#475569}
      #squad-debug-panel .dbg-body{flex:1;overflow:auto;padding:8px;-webkit-overflow-scrolling:touch}
      #squad-debug-panel .dbg-sec{margin:0 0 10px}
      #squad-debug-panel .dbg-sec h4{margin:0 0 4px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em}
      #squad-debug-panel .dbg-kv{display:flex;gap:6px;padding:1px 0}
      #squad-debug-panel .dbg-kv span:first-child{color:#94a3b8;flex:0 0 42%}
      #squad-debug-panel .dbg-kv span:last-child{flex:1;word-break:break-word}
      #squad-debug-panel .dbg-reason{background:#3b1d1d;border:1px solid #7f1d1d;border-radius:6px;padding:6px 8px;margin-bottom:8px}
      #squad-debug-panel .dbg-reason.ok{background:#12301f;border-color:#14532d}
      #squad-debug-panel .dbg-reason ul{margin:4px 0 0 14px;padding:0}
      #squad-debug-panel .dbg-log div{padding:1px 0;border-bottom:1px solid #1e293b;word-break:break-word}
      #squad-debug-panel .l-ERR{color:#fca5a5}
      #squad-debug-panel .l-WARN{color:#fcd34d}
      #squad-debug-panel .l-OK{color:#86efac}
      #squad-debug-panel .l-INFO{color:#cbd5e1}
      #squad-debug-panel pre{white-space:pre-wrap;margin:4px 0 0;background:#020617;padding:6px;border-radius:6px;user-select:all}
    `;
    document.head.appendChild(st);
  }

  function netInfoText() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return 'н/д';
    const parts = [];
    if (c.effectiveType) parts.push(c.effectiveType);
    if (c.type) parts.push(c.type);
    if (c.rtt != null) parts.push('rtt ' + c.rtt + ' мс');
    if (c.downlink != null) parts.push(c.downlink + ' Мбит/с');
    if (c.saveData) parts.push('экономия трафика ВКЛ');
    return parts.join(', ') || 'н/д';
  }

  function latStats() {
    if (!dbg.lat.length) return 'нет данных';
    const last = dbg.lat[dbg.lat.length - 1];
    const avg = Math.round(dbg.lat.reduce((a, b) => a + b, 0) / dbg.lat.length);
    const max = Math.max.apply(null, dbg.lat);
    return `последний ${last} мс, средний ${avg} мс, макс ${max} мс`;
  }

  function buildSummaryRows() {
    let host = state.supabaseUrl;
    try { host = new URL(state.supabaseUrl).host; } catch (_) {}
    const statusText = { idle: 'нет подключения', online: 'онлайн', unstable: 'нестабильно', offline: 'связь потеряна' }[connStatus];
    const failedCount = outbox.filter(p => p.status === 'failed').length;
    const queued = outbox.length - failedCount;
    return [
      ['Статус', statusText],
      ['Последний успешный запрос', fmtAgo(dbg.lastOkAt)],
      ['Неудач подряд', String(dbg.consecutiveFails)],
      ['Запросов ок / ошибок', `${dbg.okCount} / ${dbg.errCount}`],
      ['Задержка', latStats()],
      ['Переподключений', String(dbg.reconnects)],
      ['Следующий опрос', currentPollDelay() + ' мс (база)'],
      ['Браузер онлайн', navigator.onLine === false ? 'НЕТ' : 'да'],
      ['Вкладка', document.hidden ? 'скрыта' : 'видима'],
      ['Сеть', netInfoText()],
      ['Service Worker', describeSw()],
      ['Приложение', location.origin + ' (' + location.protocol + ')'],
      ['Supabase', host],
      ['Очередь отправки', `в ожидании ${queued}, не отправлено ${failedCount}`],
      ['Статусы «доставлено/прочитано»', receiptsSupported ? 'включены' : 'ОТКЛЮЧЕНЫ (нет колонок в БД)'],
      ['Сообщений в памяти', String(serverMessages.size)],
      ['Версия модуля', MODULE_VERSION]
    ];
  }

  function buildReportText() {
    const lines = [];
    lines.push(`Отчёт squad.js v${MODULE_VERSION} — ${new Date().toLocaleString('ru')}`);
    buildSummaryRows().forEach(r => lines.push(`${r[0]}: ${r[1]}`));
    if (dbg.lastDisconnect) {
      lines.push(`Последний разрыв (${fmtClock(dbg.lastDisconnect.at)}): ${dbg.lastDisconnect.title}`);
      dbg.lastDisconnect.hints.forEach(h => lines.push('  - ' + h));
    }
    lines.push(`UserAgent: ${navigator.userAgent}`);
    lines.push('--- журнал ---');
    dbg.entries.forEach(e => lines.push(`${fmtClock(e.t)} ${e.level} [${e.tag}] ${e.msg}${e.count > 1 ? ' ×' + e.count : ''}`));
    return lines.join('\n');
  }

  function scheduleDebugRender() {
    if (!debugOpen || debugRenderTimer) return;
    debugRenderTimer = setTimeout(() => { debugRenderTimer = null; renderDebugPanel(); }, 250);
  }

  function renderDebugPanel() {
    const panel = document.getElementById('squad-debug-panel');
    if (!panel || panel.hidden) return;
    const body = panel.querySelector('.dbg-body');
    if (!body) return;
    const prevScroll = body.scrollTop;

    let reason = '';
    if (connStatus === 'online' && dbg.consecutiveFails === 0) {
      reason = `<div class="dbg-reason ok"><b>✅ Связь в порядке.</b>` +
        (dbg.lastDisconnect ? `<div>Последний разрыв был в ${fmtClock(dbg.lastDisconnect.at)}: ${escapeHtml(dbg.lastDisconnect.title)}</div>` : '') + `</div>`;
    } else if (connStatus === 'idle') {
      reason = `<div class="dbg-reason ok">Вы не состоите в отряде — синхронизация не запущена.</div>`;
    } else {
      const d = dbg.lastDisconnect || dbg.lastError;
      if (d) {
        reason = `<div class="dbg-reason"><b>⚠️ Причина проблемы:</b><div>${escapeHtml(d.title)}</div>` +
          (d.hints && d.hints.length ? `<ul>${d.hints.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul>` : '') + `</div>`;
      }
    }

    let receiptsBlock = '';
    if (!receiptsSupported) {
      receiptsBlock = `<div class="dbg-sec"><h4>Статусы «доставлено / прочитано»</h4>` +
        `Чтобы включить, выполните в Supabase → SQL Editor:<pre>${escapeHtml(RECEIPTS_SQL)}</pre></div>`;
    }

    const rows = buildSummaryRows().map(r => `<div class="dbg-kv"><span>${escapeHtml(r[0])}</span><span>${escapeHtml(r[1])}</span></div>`).join('');
    const log = dbg.entries.slice().reverse().map(e =>
      `<div class="l-${e.level}">${fmtClock(e.t)} [${escapeHtml(e.tag)}] ${escapeHtml(e.msg)}${e.count > 1 ? ' ×' + e.count : ''}</div>`).join('');

    body.innerHTML = `${reason}${receiptsBlock}<div class="dbg-sec"><h4>Состояние</h4>${rows}</div>` +
      `<div class="dbg-sec"><h4>Журнал (новые сверху)</h4><div class="dbg-log">${log || '<div>пусто</div>'}</div></div>`;
    body.scrollTop = prevScroll;
  }

  async function runConnectivityTest() {
    dlog('INFO', 'test', '▶ Тест связи запущен');
    renderDebugPanel();
    const t0 = Date.now();

    // 1. Есть ли вообще интернет (не Supabase)
    let internetOk = false;
    try {
      const s = Date.now();
      await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store' });
      internetOk = true;
      dlog('OK', 'test', `Интернет (gstatic.com): OK, ${Date.now() - s} мс`);
    } catch (e) {
      dlog('ERR', 'test', 'Интернет (gstatic.com): недоступен — ' + (e && e.message));
    }

    // 2. Supabase: 3 пинга
    let okCount = 0;
    const times = [];
    for (let i = 1; i <= 3; i++) {
      try {
        const s = Date.now();
        await rawRequest('squad_rooms?select=id&limit=1', 'GET', null, { timeoutMs: CONFIG.getTimeoutMs });
        const ms = Date.now() - s;
        times.push(ms);
        okCount++;
        dlog('OK', 'test', `Supabase пинг ${i}/3: OK, ${ms} мс`);
      } catch (e) {
        const info = classifyError(e);
        dlog('ERR', 'test', `Supabase пинг ${i}/3: ${info.title}`);
      }
      await sleep(250);
    }

    let verdict;
    if (okCount === 3) {
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      verdict = `Тест пройден: Supabase отвечает (средняя задержка ${avg} мс).` +
        (avg > 1500 ? ' Задержка высокая — возможны таймауты на слабом канале.' : '');
      dlog('OK', 'test', verdict);
    } else if (internetOk && okCount === 0) {
      verdict = 'Интернет есть, но Supabase недоступен именно с этого устройства/сети: DNS-фильтр или блокировщик, Service Worker, VPN, либо проект Supabase на паузе.';
      dlog('ERR', 'test', verdict);
    } else if (!internetOk && okCount === 0) {
      verdict = 'Нет доступа в интернет (Wi-Fi без выхода в сеть или потеря сигнала).';
      dlog('ERR', 'test', verdict);
    } else {
      verdict = `Связь нестабильна: успешно ${okCount} из 3 запросов.`;
      dlog('WARN', 'test', verdict);
    }
    dlog('INFO', 'test', `■ Тест завершён за ${Math.round((Date.now() - t0) / 100) / 10} с`);
    toast(verdict);
    renderDebugPanel();
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function openDebugPanel() {
    const win = document.getElementById('squad-window');
    const panel = document.getElementById('squad-debug-panel');
    if (!win || !panel) return;
    if (win.hidden) { win.hidden = false; isWindowOpen = true; }
    if (isWindowMinimized) toggleMinimizeWindow();
    panel.hidden = false;
    debugOpen = true;
    renderDebugPanel();
    if (debugTimer) clearInterval(debugTimer);
    debugTimer = setInterval(renderDebugPanel, 1000);
  }

  function closeDebugPanel() {
    const panel = document.getElementById('squad-debug-panel');
    if (panel) panel.hidden = true;
    debugOpen = false;
    if (debugTimer) clearInterval(debugTimer);
    debugTimer = null;
  }

  function createDebugUI() {
    const win = document.getElementById('squad-window');
    if (!win || document.getElementById('squad-debug-panel')) return;

    try {
      if (getComputedStyle(win).position === 'static') win.style.position = 'relative';
    } catch (_) {}

    // Кнопка 🐞 в шапке окна
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-squad-debug';
    btn.className = 'squad-debug-btn';
    btn.title = 'Диагностика связи';
    btn.textContent = '🐞';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (debugOpen) closeDebugPanel(); else openDebugPanel();
    });

    const minBtn = document.getElementById('btn-squad-win-min');
    const header = document.querySelector('.squad-win-header');
    if (minBtn && minBtn.parentElement) {
      minBtn.parentElement.insertBefore(btn, minBtn);
    } else if (header) {
      header.appendChild(btn);
    } else {
      btn.style.position = 'absolute';
      btn.style.top = '4px';
      btn.style.right = '60px';
      win.appendChild(btn);
    }

    // Панель
    const panel = document.createElement('div');
    panel.id = 'squad-debug-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="dbg-head">
        <b>🐞 Диагностика связи</b>
        <button type="button" data-act="test">Тест связи</button>
        <button type="button" data-act="sync">Синхр.</button>
        <button type="button" data-act="copy">Копировать</button>
        <button type="button" data-act="clear">Очистить</button>
        <button type="button" data-act="close">✕</button>
      </div>
      <div class="dbg-body"></div>
    `;
    panel.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'close') closeDebugPanel();
      else if (act === 'test') runConnectivityTest();
      else if (act === 'sync') { dlog('INFO', 'life', 'Ручная синхронизация'); wake('ручная синхронизация', true); }
      else if (act === 'clear') { dbg.entries = []; lsSet(DEBUG_KEY, '[]'); renderDebugPanel(); }
      else if (act === 'copy') {
        const ok = await copyText(buildReportText());
        toast(ok ? '📋 Отчёт скопирован — отправьте его разработчику' : 'Не удалось скопировать — выделите текст вручную');
      }
    });
    win.appendChild(panel);

    // Тап по индикатору статуса тоже открывает диагностику
    ['squad-status-dot', 'squad-status-text'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => { e.stopPropagation(); openDebugPanel(); });
      }
    });
  }

  // =========================================================================
  // ИНИЦИАЛИЗАЦИЯ DOM
  // =========================================================================

  function initDOM() {
    injectStyles();
    createDebugUI();

    document.getElementById('btn-squad-win-min')?.addEventListener('click', toggleMinimizeWindow);
    document.getElementById('btn-squad-win-close')?.addEventListener('click', closeWindow);

    // Клик по шапке в свёрнутом виде разворачивает окно обратно по центру
    document.querySelector('.squad-win-header')?.addEventListener('click', (e) => {
      if (isWindowMinimized && !e.target.closest('button')) {
        toggleMinimizeWindow();
      }
    });

    document.getElementById('btn-squad-refresh')?.addEventListener('click', () => {
      wake('кнопка «обновить»', true);
      toast('🔄 Данные отряда обновлены');
    });

    document.getElementById('squad-toggle-share-loc')?.addEventListener('change', (e) => {
      state.shareLocation = e.target.checked;
      saveState();
      registerPresence();
      if (state.shareLocation) sendGpsCoordinates();
      toast(state.shareLocation ? '📡 Раздача координат включена' : '🛑 Раздача координат выключена');
    });

    document.getElementById('squad-toggle-show-others')?.addEventListener('change', (e) => {
      state.showOthers = e.target.checked;
      saveState();
      renderMembersOnMap(lastKnownMembers);
      toast(state.showOthers ? '👁️ Отображение участников включено' : '🕶️ Участники на карте скрыты');
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
      coordsBtn.addEventListener('click', () => {
        if (!map || !state.room) return;
        const c = map.getCenter();
        const lat = c.lat.toFixed(5);
        const lng = c.lng.toFixed(5);
        sendMessage(`📍 [${lat}, ${lng}]`);
        toast(`📍 Координаты центра карты отправлены`);
      });
    }

    // Делегирование кликов внутри чата: координаты, редактирование, повтор/удаление неотправленных
    if (chatMessagesBox) {
      chatMessagesBox.addEventListener('click', (e) => {
        const retry = e.target.closest('.squad-msg-retry-btn');
        if (retry) { retryPending(retry.dataset.tmp); return; }

        const discard = e.target.closest('.squad-msg-discard-btn');
        if (discard) { discardPending(discard.dataset.tmp); return; }

        const edit = e.target.closest('.squad-msg-edit-btn');
        if (edit) {
          const m = serverMessages.get(String(edit.dataset.mid));
          if (!m) return;
          editingMessageId = String(m.id);
          const inp = document.getElementById('squad-chat-input');
          const cancelEdit = document.getElementById('squad-chat-cancel-edit');
          if (inp) {
            inp.value = m.text;
            inp.focus();
            if (chatCount) chatCount.textContent = `${inp.value.length}/512`;
          }
          if (cancelEdit) cancelEdit.hidden = false;
          return;
        }

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

            toast(`🎯 Переход к точке: ${lat}, ${lng}`);
          }
        }
      });
    }

    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', () => {
        editingMessageId = null;
        if (chatInput) chatInput.value = '';
        if (chatCount) chatCount.textContent = '0/512';
        cancelEditBtn.hidden = true;
      });
    }

    if (chatBtn) {
      chatBtn.addEventListener('click', () => {
        if (!chatInput || !chatInput.value.trim()) return;
        const txt = chatInput.value.trim();
        if (txt.length > 512) {
          toast('Сообщение слишком длинное (максимум 512 символов)');
          return;
        }
        chatInput.value = '';
        if (chatCount) chatCount.textContent = '0/512';
        if (cancelEditBtn) cancelEditBtn.hidden = true;

        if (editingMessageId) {
          const id = editingMessageId;
          editingMessageId = null;
          editMessage(id, txt);
        } else {
          sendMessage(txt);
        }
        // Оставляем фокус в поле, чтобы на телефоне не закрывалась клавиатура
        try { chatInput.focus(); } catch (_) {}
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
        toast(`✅ Отряд «${name}» успешно создан!`);
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
        toast(`✅ Вы присоединились к отряду «${room.name}»!`);
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
      dlog('INFO', 'cfg', 'Настройки Supabase изменены');
      toast('Настройки Supabase сохранены');
      if (state.connected) wake('смена настроек Supabase', true);
    });
  }

  // Глобальные события жизненного цикла страницы (телефон: сон, сворачивание, смена сети)
  function initLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        dlog('INFO', 'life', 'Вкладка скрыта — опрос замедлен (в фоне телефон может приостановить сеть)');
      } else {
        const away = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = 0;
        if (state.connected) wake('вкладка снова активна' + (away ? ` (была скрыта ${fmtDur(away)})` : ''), away > 30000);
      }
    });

    window.addEventListener('online', () => {
      dlog('OK', 'life', 'Браузер сообщил: сеть появилась');
      wake('сеть появилась', true);
    });

    window.addEventListener('offline', () => {
      dlog('ERR', 'life', 'Браузер сообщил: сеть пропала');
      if (state.connected) setConnStatus('offline');
    });

    window.addEventListener('pageshow', (e) => {
      if (e.persisted && state.connected) wake('страница восстановлена из кэша', true);
    });

    try {
      const c = navigator.connection;
      if (c && c.addEventListener) {
        c.addEventListener('change', () => dlog('INFO', 'life', 'Тип сети изменился: ' + netInfoText()));
      }
    } catch (_) {}
  }

  WM.squad = {
    version: MODULE_VERSION,
    init(m) {
      map = m;
      squadLayer = L.layerGroup().addTo(map);
      loadDebugLog();
      loadSavedState();
      initDOM();
      initLifecycle();
      if (state.connected) loadOutboxForRoom();
      updateUIState();
      renderChat();

      map.on('zoomend', () => {
        if (state.connected && state.showOthers && lastKnownMembers.length) {
          renderMembersOnMap(lastKnownMembers);
        }
      });

      if (state.connected) {
        setConnStatus('unstable');
        startSyncLoops();
      } else {
        setConnStatus('idle');
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
    },
    // Диагностика
    debug: {
      open: openDebugPanel,
      close: closeDebugPanel,
      report: buildReportText,
      log: () => dbg.entries.slice(),
      test: runConnectivityTest
    }
  };
})();