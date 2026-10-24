
(function () {
  const WM = window.WM = window.WM || {};
  const $ = id => document.getElementById(id);

  const DATABASE_URL = 'https://wikimap-bfbd3-default-rtdb.firebaseio.com';
  const STORAGE_TRACKS_KEY = 'wm_saved_gps_tracks';
  const STORAGE_SETTINGS_KEY = 'wm_track_recorder_settings';
  const DB_NAME = 'WM_Tracker_CrashSafe_DB';
  const DB_STORE = 'active_track_points';

  const TRACK_COLORS = [
    '#ef4444', '#f97316', '#10b981', '#06b6d4', 
    '#3b82f6', '#8b5cf6', '#ec4899', '#eab308'
  ];

  // Настройки по умолчанию с новыми опциями
  const DEFAULT_SETTINGS = {
    anomalyFilter: true,
    anomalyVibro: true,
    powerProfile: 'balanced', // 'high' | 'balanced' | 'eco'
    keepScreenOn: false,
    autoPause: false,
    autoPauseStopDelaySec: 45,
    useStepSensorToWake: true,
    batteryGuard: true,
    altitudeSource: 'gps', // 'gps' | 'barometer'
    altitudeSmoothing: true,
    minDistanceMeters: 5,
    minIntervalSec: 3,
    defaultColor: '#ef4444',
    cameraMode: 'auto', // 'locked' | 'free' | 'auto' | 'soft_auto'
    lineWidth: 4,
    lineOpacity: 0.85,
    showArrows: true,
    showSharedTracks: false // Показывать общедоступные треки из облака
  };

  let settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (saved) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch (e) {}

  let tracks = [];
  let remoteSharedTracks = [];
  let mapInstance = null;
  let activeTrackLayer = null;
  let savedTracksLayer = null;
  let remoteTracksLayer = null;
  let arrowsLayer = null;

  // Состояние текущей сессии записи
  let isRecording = false;
  let isPaused = false;
  let isAutoPaused = false;
  let activeSession = null;
  let crashDb = null;
  let wakeLockSentinel = null;

  // Эмуляция тестового трека
  let simTimer = null;
  let isSimActive = false;
  let simStep = 0;
  let simLat = 0;
  let simLng = 0;
  let simHeading = 0;

  // Вспомогательные переменные фильтрации и автопаузы
  let lastRecordedPoint = null;
  let lastMovementTime = 0;
  let lastGpsSampleTime = 0;
  let anomalyVibroTimer = null;
  let barometerAltitude = null;
  let smoothedElevation = null;

  // Умное управление камерой без перегрузки CPU
  let lastUserInteractionTime = 0;
  let cameraFollowActive = true;
  let dragAnchorPt = null;
  const DRAG_DETACH_THRESHOLD_PX = 38;

  // Маркер на карте при прощупывании графика
  let chartProbeMarker = null;

  function setNativeBackgroundTracking(isTracking) {
    if (window.AndroidBridge && typeof window.AndroidBridge.setBackgroundTrackingState === 'function') {
      try {
        window.AndroidBridge.setBackgroundTrackingState(!!isTracking);
      } catch (e) {
        console.warn('[Tracker] Ошибка AndroidBridge:', e);
      }
    }
}

  // Функция остановки пробития клика на карту/перекрестие
  function stopMapClickPropagation(e) {
    if (e.originalEvent) {
      if (e.originalEvent.stopPropagation) e.originalEvent.stopPropagation();
      e.originalEvent._stopped = true;
    }
    if (e.stopPropagation) e.stopPropagation();
    e._stopped = true;
  }

  // --- Хеширование пароля для комнат Firebase ---
  async function hashPassword(str) {
    if (!str || !str.trim()) return 'public';
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.trim()));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch (e) {
      let hash = 0;
      const s = str.trim();
      for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
      }
      return 'p_' + Math.abs(hash).toString(16);
    }
  }

  // --- IndexedDB Crash Safety ---
  function initCrashDb() {
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { autoIncrement: true });
        }
      };
      req.onsuccess = () => { crashDb = req.result; resolve(crashDb); };
      req.onerror = () => resolve(null);
    });
  }

  function dbAppendPoint(pt) {
    if (!crashDb) return;
    try {
      const tx = crashDb.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).add(pt);
    } catch (e) {}
  }

  function dbClearActivePoints() {
    if (!crashDb) return;
    try {
      const tx = crashDb.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
    } catch (e) {}
  }

  function dbGetActivePoints() {
    return new Promise((resolve) => {
      if (!crashDb) return resolve([]);
      try {
        const tx = crashDb.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }

  // --- Форматирование ---
  function fmtDistance(meters) {
    if (!meters || meters < 0.1) return '0 м';
    if (meters < 1000) return Math.round(meters) + ' м';
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' км';
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
    return `${pad(m)}:${pad(sec)}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  // --- Хранение треков ---
  function loadStoredTracks() {
    try {
      const raw = localStorage.getItem(STORAGE_TRACKS_KEY);
      if (raw) {
        tracks = JSON.parse(raw) || [];
      }
    } catch (e) {
      tracks = [];
    }
  }

  function saveStoredTracks() {
    try {
      localStorage.setItem(STORAGE_TRACKS_KEY, JSON.stringify(tracks));
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  // --- WakeLock управления экраном ---
  async function requestWakeLock() {
    if (!settings.keepScreenOn) return;
    if ('wakeLock' in navigator) {
      try {
        if (!wakeLockSentinel || wakeLockSentinel.released) {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
        }
      } catch (e) {}
    }
    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(true);
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }
    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(false);
    }
  }

  // --- Барометр и высотомер ---
  function initBarometerListener() {
    if ('Barometer' in window) {
      try {
        const sensor = new Barometer({ frequency: 1 });
        sensor.addEventListener('reading', () => {
          if (sensor.pressure) {
            barometerAltitude = 44330 * (1 - Math.pow(sensor.pressure / 1013.25, 0.1903));
          }
        });
        sensor.start();
      } catch (e) {}
    }
  }

  // --- Проверка заряда батареи ---
  function initBatteryWatcher() {
    if (settings.batteryGuard && 'getBattery' in navigator) {
      navigator.getBattery().then(battery => {
        const check = () => {
          if (!battery.charging && battery.level <= 0.18 && isRecording) {
            if (settings.powerProfile !== 'eco') {
              settings.powerProfile = 'eco';
              if (WM.ui && WM.ui.showToast) {
                WM.ui.showToast('🔋 Низкий заряд батареи! Запись переведена в режим Эко');
              }
            }
          }
        };
        battery.addEventListener('levelchange', check);
        battery.addEventListener('chargingchange', check);
        check();
      }).catch(() => {});
    }
  }

  // --- 10 вибросигналов при аномалии ---
  function triggerAnomalyAlert(reasonText) {
    if (!settings.anomalyVibro || !navigator.vibrate) return;
    clearInterval(anomalyVibroTimer);
    let count = 0;
    try { navigator.vibrate(250); } catch (e) {}
    count++;
    anomalyVibroTimer = setInterval(() => {
      count++;
      try { navigator.vibrate(250); } catch (e) {}
      if (count >= 10) {
        clearInterval(anomalyVibroTimer);
        anomalyVibroTimer = null;
      }
    }, 1000);

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`⚠️ Аномалия GPS (${reasonText})! Запись приостановлена.`, 4000);
    }
  }

  function stopTestSimulation() {
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
    isSimActive = false;
  }

  function cancelRecording() {
    if (!isRecording) return;
    stopTestSimulation();
    clearInterval(anomalyVibroTimer);
    releaseWakeLock();

    dbClearActivePoints();
    isRecording = false;

    // 👉 ТАКЖЕ ВЫКЛЮЧАЕМ ФОНОВУЮ СЛУЖБУ ПРИ ОТМЕНЕ
    setNativeBackgroundTracking(false);

    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(false);
    }
    isPaused = false;
    isAutoPaused = false;
    activeSession = null;
    lastRecordedPoint = null;

    hideLiveHUD();
    renderAllLayers();
    updateFloatingBtnState();

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🗑️ Запись трека отменена');
    }
  }

  // =========================================================================
  // УПРАВЛЕНИЕ КАМЕРОЙ ПРИ ЗАПИСИ
  // =========================================================================
  function initCameraTracker() {
    if (!mapInstance) return;

    mapInstance.on('dragstart', () => {
      dragAnchorPt = mapInstance.getCenter();
    });

    mapInstance.on('drag', () => {
      if (!isRecording || !dragAnchorPt) return;

      if (settings.cameraMode === 'locked') return;

      const curCenter = mapInstance.getCenter();
      const distPx = mapInstance.latLngToContainerPoint(dragAnchorPt).distanceTo(
        mapInstance.latLngToContainerPoint(curCenter)
      );

      if (distPx >= DRAG_DETACH_THRESHOLD_PX) {
        lastUserInteractionTime = Date.now();
        if (cameraFollowActive) {
          cameraFollowActive = false;
          if (settings.cameraMode !== 'free' && WM.ui && WM.ui.showToast) {
            WM.ui.showToast('🔓 Камера откреплена (ручное смещение)');
          }
        }
      }
    });

    mapInstance.on('zoomstart', () => {
      if (!isRecording) return;
      lastUserInteractionTime = Date.now();
      if (settings.cameraMode !== 'locked') {
        cameraFollowActive = false;
      }
    });
  }

  function handleCameraFollow(targetLL) {
    if (!mapInstance || !isRecording || !targetLL) return;
    const mode = settings.cameraMode || 'auto';

    if (mode === 'free') return;

    if (mode === 'locked') {
      cameraFollowActive = true;
      mapInstance.panTo(targetLL, { animate: true, duration: 0.25 });
      return;
    }

    const now = Date.now();
    const idleSeconds = (now - lastUserInteractionTime) / 1000;

    if (mode === 'soft_auto') {
      const isVisible = mapInstance.getBounds().pad(-0.05).contains(targetLL);
      if (isVisible) {
        if (!cameraFollowActive && idleSeconds >= 5) {
          cameraFollowActive = true;
          if (WM.ui && WM.ui.showToast) WM.ui.showToast('🎯 Камера возвращена к GPS');
        }
      } else {
        cameraFollowActive = false;
      }
    } else if (mode === 'auto') {
      if (!cameraFollowActive && idleSeconds >= 30) {
        cameraFollowActive = true;
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🎯 Камера вернулась к точке (30 с бездействия)');
      }
    }

    if (cameraFollowActive) {
      mapInstance.panTo(targetLL, { animate: true, duration: 0.3 });
    }
  }

  // =========================================================================
  // ПРОВЕРКА НАЛИЧИЯ ПОЗИЦИИ И СТАРТ ЗАПИСИ
  // =========================================================================
  function getActivePosition() {
    if (WM.getUserLocation && WM.getUserLocation()) {
      const ll = WM.getUserLocation();
      return L.latLng(ll[0], ll[1]);
    }
    if (WM.gpsState && WM.gpsState.lat != null && WM.gpsState.lng != null) {
      return L.latLng(WM.gpsState.lat, WM.gpsState.lng);
    }
    return null;
  }

  async function ensureGpsOrPdrAvailable() {
    const activeLL = getActivePosition();
    if (activeLL) return activeLL;

    if (WM.pdr && WM.pdr.isActive && WM.pdr.isActive()) {
      const pdrLL = getActivePosition();
      if (pdrLL) return pdrLL;
    }

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🛰️ Определение позиции спутников GPS…', 2200);
    }

    return new Promise((resolve, reject) => {
      if (WM.acquireUserLocation) {
        WM.acquireUserLocation(
          (ll) => resolve(L.latLng(ll[0], ll[1])),
          (err) => reject(err)
        );
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(L.latLng(p.coords.latitude, p.coords.longitude)),
          (e) => reject(e),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
        );
      } else {
        reject(new Error('Геолокация не поддерживается'));
      }
    });
  }

  async function startRecording(customName, color, intervalSec, minDist) {
    if (isRecording) return;

    let initialPos = null;
    try {
      initialPos = await ensureGpsOrPdrAvailable();
    } catch (err) {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('❌ Нет сигнала GPS или шагомера! Запись не может быть начата.', 3500);
      }
      return;
    }

    if (!initialPos) {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('⚠️ Координаты не получены. Включите GPS или режим «Я тут» (🧲)', 3500);
      }
      return;
    }

    loadStoredTracks();
    const trackIndex = tracks.length + 1;
    const name = (customName || '').trim() || `Трек ${trackIndex}`;
    const trackColor = color || settings.defaultColor || TRACK_COLORS[0];

    const interval = intervalSec || settings.minIntervalSec || 3;
    const distanceThreshold = minDist || settings.minDistanceMeters || 5;

    activeSession = {
      id: 'track_' + Date.now(),
      name,
      color: trackColor,
      startTime: Date.now(),
      endTime: Date.now(),
      elapsedSeconds: 0,
      movingTime: 0,
      distance: 0,
      maxSpeed: 0,
      eleGain: 0,
      eleLoss: 0,
      minAlt: null,
      maxAlt: null,
      points: [],
      minIntervalSec: interval,
      minDistanceMeters: distanceThreshold,
      visible: true,
      isShared: false,
      sharePassword: ''
    };

    isRecording = true;
  
    // 👉 ВКЛЮЧАЕМ ФОНОВУЮ СЛУЖБУ И УДЕРЖАНИЕ ПРОЦЕССОРА
    setNativeBackgroundTracking(true);

    // Если в настройках включен пункт «Экран всегда включен»:
    if (currentSettings.keepScreenOn && window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(true);
    }
    isPaused = false;
    isAutoPaused = false;
    lastRecordedPoint = null;
    lastMovementTime = Date.now();
    lastGpsSampleTime = 0;
    lastUserInteractionTime = Date.now();
    cameraFollowActive = true;
    smoothedElevation = null;

    dbClearActivePoints();
    requestWakeLock();

    hideConfigHUD();
    showLiveHUD();
    updateLiveHUD();
    renderAllLayers();

    const initialCoords = (WM.gpsState) ? WM.gpsState : { altitude: null, speed: 0 };
    handleGpsUpdate([initialPos.lat, initialPos.lng], initialCoords, Date.now());

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`⏺️ Начата запись: «${name}»`);
    }
    updateFloatingBtnState();
  }

  // =========================================================================
  // ТЕСТОВЫЙ СИМУЛЯТОР ДВИЖЕНИЯ ТРЕКА (5 - 15 КМ/Ч)
  // =========================================================================
  function startTestTrackRecording() {
    if (isRecording) {
      stopAndSaveRecording();
    }

    const mapCenter = mapInstance ? mapInstance.getCenter() : L.latLng(55.75124, 37.61842);
    simLat = mapCenter.lat;
    simLng = mapCenter.lng;
    simHeading = Math.random() * Math.PI * 2;
    simStep = 0;
    isSimActive = true;

    loadStoredTracks();
    const trackIndex = tracks.length + 1;
    const name = `Тестовый трек ${trackIndex}`;
    const trackColor = settings.defaultColor || TRACK_COLORS[0];

    activeSession = {
      id: 'track_' + Date.now(),
      name,
      color: trackColor,
      startTime: Date.now(),
      endTime: Date.now(),
      elapsedSeconds: 0,
      movingTime: 0,
      distance: 0,
      maxSpeed: 0,
      eleGain: 0,
      eleLoss: 0,
      minAlt: null,
      maxAlt: null,
      points: [],
      minIntervalSec: 1,
      minDistanceMeters: 2,
      visible: true,
      isShared: false
    };

    isRecording = true;
    isPaused = false;
    isAutoPaused = false;
    lastRecordedPoint = null;
    lastMovementTime = Date.now();
    lastGpsSampleTime = 0;
    lastUserInteractionTime = Date.now();
    cameraFollowActive = true;
    smoothedElevation = null;

    dbClearActivePoints();
    requestWakeLock();

    hideConfigHUD();
    showLiveHUD();
    updateLiveHUD();
    renderAllLayers();

    clearInterval(simTimer);
    simTimer = setInterval(() => {
      if (!isRecording || isPaused) return;

      simStep++;
      const speedKmh = 5.0 + (Math.sin(simStep * 0.18) * 5.0 + 5.0);
      const speedMps = speedKmh / 3.6;

      simHeading += (Math.sin(simStep * 0.12) * 0.14) + ((Math.random() - 0.5) * 0.05);

      const distMeters = speedMps * 1.0;
      const dLat = (distMeters * Math.cos(simHeading)) / 111320;
      const cosLat = Math.cos(simLat * Math.PI / 180) || 1;
      const dLng = (distMeters * Math.sin(simHeading)) / (111320 * cosLat);

      const jitterLat = ((Math.random() - 0.5) * 0.8) / 111320;
      const jitterLng = ((Math.random() - 0.5) * 0.8) / (111320 * cosLat);

      simLat += dLat + jitterLat;
      simLng += dLng + jitterLng;

      const alt = 150 + Math.sin(simStep * 0.08) * 16 + (Math.sin(simStep * 0.25) * 3);
      const headingDeg = ((simHeading * 180 / Math.PI) % 360 + 360) % 360;

      const syntheticCoords = {
        latitude: simLat,
        longitude: simLng,
        altitude: Math.round(alt * 10) / 10,
        speed: speedMps,
        heading: Math.round(headingDeg),
        accuracy: 4
      };

      if (WM.gpsState) {
        Object.assign(WM.gpsState, syntheticCoords, { lat: simLat, lng: simLng });
      }

      handleGpsUpdate([simLat, simLng], syntheticCoords, Date.now());
    }, 1000);

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`🚶 Начата тестовая запись трека (5–15 км/ч)`);
    }
    updateFloatingBtnState();
  }

  function pauseRecording(userInitiated = true) {
    if (!isRecording || isPaused) return;
    isPaused = true;
    updateLiveHUD();
    if (userInitiated && WM.ui && WM.ui.showToast) {
      WM.ui.showToast('⏸️ Запись трека на паузе');
    }
    updateFloatingBtnState();
  }

  function resumeRecording() {
    if (!isRecording || !isPaused) return;
    isPaused = false;
    isAutoPaused = false;
    lastMovementTime = Date.now();
    updateLiveHUD();
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('▶️ Запись трека возобновлена');
    }
    updateFloatingBtnState();
  }

  function stopAndSaveRecording() {
    if (!isRecording) return;
    stopTestSimulation();
    clearInterval(anomalyVibroTimer);
    releaseWakeLock();

    if (activeSession && activeSession.points.length >= 2) {
      activeSession.endTime = Date.now();
      calculateTrackAggregates(activeSession);
      tracks.push(activeSession);
      saveStoredTracks();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`💾 Трек «${activeSession.name}» сохранён (${fmtDistance(activeSession.distance)})`);
      }
    } else {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('⚠️ Трек слишком короткий (менее 2 точек) и не был сохранён');
      }
    }

    dbClearActivePoints();
    isRecording = false;

    // 👉 ВЫКЛЮЧАЕМ ФОНОВУЮ СЛУЖБУ (Уведомление в шторке исчезает, процессор спит)
    setNativeBackgroundTracking(false);

    // Возвращаем штатное гашение экрана
    if (window.AndroidBridge && window.AndroidBridge.setKeepScreenOn) {
      window.AndroidBridge.setKeepScreenOn(false);
    }

    isPaused = false;
    isAutoPaused = false;
    activeSession = null;
    lastRecordedPoint = null;

    hideLiveHUD();
    renderAllLayers();
    updateFloatingBtnState();
  }

  function calculateTrackAggregates(t) {
    if (!t || !t.points || !t.points.length) return;
    let dist = 0;
    let maxSpd = 0;
    let movingSec = 0;
    let gain = 0;
    let loss = 0;
    let minA = null;
    let maxA = null;

    for (let i = 0; i < t.points.length; i++) {
      const p = t.points[i];
      if (p.alt != null) {
        if (minA === null || p.alt < minA) minA = p.alt;
        if (maxA === null || p.alt > maxA) maxA = p.alt;
      }
      if (p.speed != null && p.speed > maxSpd) {
        maxSpd = p.speed;
      }

      if (i > 0) {
        const prev = t.points[i - 1];
        const segDist = L.latLng(prev.lat, prev.lng).distanceTo(L.latLng(p.lat, p.lng));
        dist += segDist;

        const dt = Math.max(0.1, (p.time - prev.time) / 1000);
        const impliedSpd = segDist / dt;
        if (impliedSpd > maxSpd && impliedSpd < 60) maxSpd = impliedSpd;

        if (impliedSpd >= 0.35 || (p.speed != null && p.speed >= 0.35)) {
          movingSec += dt;
        }

        if (p.alt != null && prev.alt != null) {
          const dAlt = p.alt - prev.alt;
          if (dAlt > 1.2) gain += dAlt;
          else if (dAlt < -1.2) loss += Math.abs(dAlt);
        }
      }
    }

    t.distance = dist;
    t.maxSpeed = maxSpd;
    t.movingTime = movingSec;
    t.eleGain = gain;
    t.eleLoss = loss;
    t.minAlt = minA;
    t.maxAlt = maxA;
    t.duration = (t.endTime - t.startTime) / 1000;
  }

  // --- Фильтрация точек и добавление в активный трек ---
  function handleGpsUpdate(ll, coords, timestamp) {
    if (!isRecording || !activeSession) return;
    const now = timestamp || Date.now();

    let minProfileInterval = activeSession.minIntervalSec;
    if (settings.powerProfile === 'eco') minProfileInterval = Math.max(minProfileInterval, 60);
    else if (settings.powerProfile === 'balanced') minProfileInterval = Math.max(minProfileInterval, 3);
    else if (settings.powerProfile === 'high') minProfileInterval = Math.max(minProfileInterval, 1);

    if (now - lastGpsSampleTime < minProfileInterval * 1000) {
      return;
    }

    let rawAlt = (coords && coords.altitude != null) ? coords.altitude : null;
    if (settings.altitudeSource === 'barometer' && barometerAltitude != null) {
      rawAlt = barometerAltitude;
    }
    let effectiveAlt = rawAlt;
    if (settings.altitudeSmoothing && rawAlt != null) {
      if (smoothedElevation === null) smoothedElevation = rawAlt;
      else smoothedElevation = smoothedElevation * 0.75 + rawAlt * 0.25;
      effectiveAlt = Math.round(smoothedElevation * 10) / 10;
    }

    const currentLL = L.latLng(ll[0], ll[1]);
    const speed = (coords && coords.speed != null && coords.speed >= 0) ? coords.speed : 0;
    const accuracy = (coords && coords.accuracy != null) ? coords.accuracy : 10;

    if (!isSimActive && settings.anomalyFilter && lastRecordedPoint) {
      const distFromLast = lastRecordedPoint.latlng.distanceTo(currentLL);
      const dt = Math.max(0.1, (now - lastRecordedPoint.time) / 1000);
      const impliedSpeedKmh = (distFromLast / dt) * 3.6;

      if (distFromLast > 2000 || impliedSpeedKmh > 190) {
        pauseRecording(false);
        triggerAnomalyAlert(`Скачок ${Math.round(distFromLast)}м / ${Math.round(impliedSpeedKmh)}км/ч`);
        return;
      }
    }

    const isMoving = speed >= 0.45;
    if (isMoving) {
      lastMovementTime = now;
      if (isAutoPaused) {
        isAutoPaused = false;
        isPaused = false;
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('▶️ Движение возобновлено');
      }
    } else if (settings.autoPause && !isPaused && !isAutoPaused) {
      const idleSeconds = (now - lastMovementTime) / 1000;
      if (idleSeconds >= settings.autoPauseStopDelaySec) {
        isAutoPaused = true;
        isPaused = true;
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('⏸️ Автопауза (остановка на месте)');
        updateLiveHUD();
        return;
      }
    }

    if (isPaused) return;

    if (lastRecordedPoint) {
      const dist = lastRecordedPoint.latlng.distanceTo(currentLL);
      if (dist < activeSession.minDistanceMeters && accuracy <= 25) {
        return;
      }

      activeSession.distance += dist;
      if (speed > (activeSession.maxSpeed || 0)) activeSession.maxSpeed = speed;

      const dt = Math.max(0.1, (now - lastRecordedPoint.time) / 1000);
      if (speed >= 0.35 || (dist / dt) >= 0.35) {
        activeSession.movingTime = (activeSession.movingTime || 0) + dt;
      }

      if (effectiveAlt != null && lastRecordedPoint.alt != null) {
        const dAlt = effectiveAlt - lastRecordedPoint.alt;
        if (dAlt > 1.2) activeSession.eleGain += dAlt;
        else if (dAlt < -1.2) activeSession.eleLoss += Math.abs(dAlt);
      }
    }

    lastGpsSampleTime = now;
    const pt = {
      lat: currentLL.lat,
      lng: currentLL.lng,
      alt: effectiveAlt,
      speed,
      time: now
    };

    activeSession.points.push(pt);
    lastRecordedPoint = { latlng: currentLL, time: now, alt: effectiveAlt, speed };

    dbAppendPoint(pt);

    handleCameraFollow(currentLL);

    renderActiveTrackLine();
    updateLiveHUD();
  }

  // =========================================================================
  // РЕНДЕРИНГ НА КАРТЕ СО СТРЕЛКАМИ НАПРАВЛЕНИЯ И ОБЛАЧНЫМИ ТРЕКАМИ
  // =========================================================================
  function renderAllLayers() {
    if (!mapInstance) return;
    renderSavedTracks();
    renderRemoteSharedTracks();
    renderActiveTrackLine();
  }

  function renderSavedTracks() {
    if (!savedTracksLayer || !arrowsLayer || !mapInstance) return;
    savedTracksLayer.clearLayers();
    arrowsLayer.clearLayers();

    const lineWidth = settings.lineWidth || 4;
    const lineOpacity = settings.lineOpacity != null ? settings.lineOpacity : 0.85;
    const showArrows = settings.showArrows !== false;

    tracks.forEach(t => {
      if (t.visible === false || !t.points || t.points.length < 2) return;
      const pts = t.points.map(p => [p.lat, p.lng]);

      const polyline = L.polyline(pts, {
        color: t.color || '#ef4444',
        weight: lineWidth,
        opacity: lineOpacity,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      });

      // Корректный перехват клика без пробития на карту
      polyline.on('click', (e) => {
        stopMapClickPropagation(e);
        openTrackDetailsPopup(t, e.latlng);
      });

      savedTracksLayer.addLayer(polyline);

      if (showArrows) {
        renderTrackDirectionArrows(t, lineWidth, t.color || '#ef4444');
      }

      const lastPt = t.points[t.points.length - 1];
      const isSharedBadge = t.isShared ? (t.sharePassword ? '🔒 ' : '🌐 ') : '';
      const badge = L.marker([lastPt.lat, lastPt.lng], {
        icon: L.divIcon({
          className: 'wm-track-badge-icon',
          html: `
            <div class="wm-track-badge" style="--track-c: ${escapeHtml(t.color || '#ef4444')};">
              <span>${isSharedBadge}🚩 ${escapeHtml(t.name)}: <b>${fmtDistance(t.distance)}</b></span>
            </div>
          `,
          iconSize: [130, 24],
          iconAnchor: [65, 26]
        }),
        interactive: true,
        zIndexOffset: 600
      });

      // Корректный перехват клика по бейджу
      badge.on('click', (e) => {
        stopMapClickPropagation(e);
        openTrackDetailsPopup(t, [lastPt.lat, lastPt.lng]);
      });

      savedTracksLayer.addLayer(badge);
    });
  }

  function renderRemoteSharedTracks() {
    if (!remoteTracksLayer || !mapInstance) return;
    remoteTracksLayer.clearLayers();

    if (!settings.showSharedTracks || !remoteSharedTracks.length) return;

    const lineWidth = Math.max(3, (settings.lineWidth || 4) - 1);
    const localTrackIds = new Set(tracks.map(t => t.id));

    remoteSharedTracks.forEach(t => {
      if (!t.points || t.points.length < 2 || localTrackIds.has(t.id)) return;
      const pts = t.points.map(p => [p.lat, p.lng]);
      const trackColor = t.color || '#06b6d4';

      const polyline = L.polyline(pts, {
        color: trackColor,
        weight: lineWidth,
        opacity: 0.8,
        dashArray: '6, 6',
        lineCap: 'round',
        interactive: true
      });

      polyline.on('click', (e) => {
        stopMapClickPropagation(e);
        openRemoteTrackPopup(t, e.latlng);
      });

      remoteTracksLayer.addLayer(polyline);

      const lastPt = t.points[t.points.length - 1];
      const badge = L.marker([lastPt.lat, lastPt.lng], {
        icon: L.divIcon({
          className: 'wm-track-badge-icon',
          html: `
            <div class="wm-track-badge wm-remote-track-badge" style="--track-c: ${escapeHtml(trackColor)};">
              <span>🌐 ${escapeHtml(t.name)}: <b>${fmtDistance(t.distance)}</b></span>
            </div>
          `,
          iconSize: [130, 24],
          iconAnchor: [65, 26]
        }),
        interactive: true,
        zIndexOffset: 550
      });

      badge.on('click', (e) => {
        stopMapClickPropagation(e);
        openRemoteTrackPopup(t, [lastPt.lat, lastPt.lng]);
      });

      remoteTracksLayer.addLayer(badge);
    });
  }

  function renderTrackDirectionArrows(track, weight, color) {
    if (!track.points || track.points.length < 3) return;
    const pts = track.points;
    const step = Math.max(3, Math.floor(pts.length / 15));

    for (let i = step; i < pts.length - 1; i += step) {
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const lat1 = p1.lat * Math.PI / 180;
      const lat2 = p2.lat * Math.PI / 180;
      const dLng = (p2.lng - p1.lng) * Math.PI / 180;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      const bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;

      const arrow = L.marker([p2.lat, p2.lng], {
        icon: L.divIcon({
          className: 'wm-track-arrow-icon',
          html: `<div class="wm-track-arrow-symbol" style="color: ${color}; transform: rotate(${Math.round(bearing)}deg);">▲</div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        interactive: false
      });
      arrowsLayer.addLayer(arrow);
    }
  }

  function renderActiveTrackLine() {
    if (!activeTrackLayer || !mapInstance) return;
    activeTrackLayer.clearLayers();

    if (!isRecording || !activeSession || !activeSession.points || activeSession.points.length < 2) {
      return;
    }

    const latlngs = activeSession.points.map(p => [p.lat, p.lng]);
    const lineWidth = (settings.lineWidth || 4) + 1;
    L.polyline(latlngs, {
      color: activeSession.color || '#ef4444',
      weight: lineWidth,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(activeTrackLayer);
  }

  // =========================================================================
  // РАСШИРЕННЫЙ ПОПАП ТРЕКА НА КАРТЕ
  // =========================================================================
  function openTrackDetailsPopup(track, latlng) {
    if (!mapInstance) return;
    calculateTrackAggregates(track);

    const durationSec = track.duration || (track.endTime - track.startTime) / 1000;
    const durStr = fmtDuration(durationSec);

    const avgSpeedKmh = durationSec > 0 ? (track.distance / durationSec) * 3.6 : 0;
    const maxSpeedKmh = (track.maxSpeed || 0) * 3.6;

    const popupContent = document.createElement('div');
    popupContent.className = 'wm-track-popup';
    popupContent.innerHTML = `
      <div class="wm-track-popup-head">
        <span class="wm-track-popup-dot" style="background-color: ${escapeHtml(track.color || '#ef4444')};"></span>
        <b class="wm-track-popup-title">${escapeHtml(track.name)}</b>
      </div>
      <div class="wm-track-popup-grid">
        <div class="cell"><span class="lbl">Дистанция</span><b class="val">${fmtDistance(track.distance)}</b></div>
        <div class="cell"><span class="lbl">Время</span><b class="val">${durStr}</b></div>
        <div class="cell"><span class="lbl">Ср. скорость</span><b class="val">${avgSpeedKmh.toFixed(1)} км/ч</b></div>
        <div class="cell"><span class="lbl">Макс. скор.</span><b class="val">${maxSpeedKmh.toFixed(1)} км/ч</b></div>
        <div class="cell"><span class="lbl">Подъём</span><b class="val">+${Math.round(track.eleGain || 0)} м</b></div>
        <div class="cell"><span class="lbl">Спуск</span><b class="val">-${Math.round(track.eleLoss || 0)} м</b></div>
      </div>
      <div class="wm-track-popup-actions">
        <button type="button" class="btn btn-secondary js-btn-zoom">🎯 Центр</button>
        <button type="button" class="btn btn-primary js-btn-details">📊 Подробнее</button>
        <button type="button" class="btn btn-secondary js-btn-share" title="Поделиться треком">🌐</button>
        <button type="button" class="btn btn-secondary js-btn-gpx">💾 GPX</button>
        <button type="button" class="btn btn-danger-outline js-btn-del" style="flex:0.6;">🗑️</button>
      </div>
    `;

    L.DomEvent.disableClickPropagation(popupContent);

    L.popup({ className: 'wm-track-leaflet-popup' })
      .setLatLng(latlng)
      .setContent(popupContent)
      .openOn(mapInstance);

    popupContent.querySelector('.js-btn-zoom').onclick = () => {
      zoomToTrack(track.id);
      mapInstance.closePopup();
    };
    popupContent.querySelector('.js-btn-details').onclick = () => {
      mapInstance.closePopup();
      openTrackDetailsModal(track);
    };
    popupContent.querySelector('.js-btn-share').onclick = () => {
      mapInstance.closePopup();
      openShareTrackModal(track);
    };
    popupContent.querySelector('.js-btn-gpx').onclick = () => {
      exportTrackGpx(track.id);
    };
    popupContent.querySelector('.js-btn-del').onclick = () => {
      if (confirm(`Удалить трек «${track.name}»?`)) {
        deleteTrack(track.id);
        mapInstance.closePopup();
      }
    };
  }

  function openRemoteTrackPopup(track, latlng) {
    if (!mapInstance) return;
    calculateTrackAggregates(track);

    const durationSec = track.duration || 0;
    const durStr = fmtDuration(durationSec);

    const popupContent = document.createElement('div');
    popupContent.className = 'wm-track-popup';
    popupContent.innerHTML = `
      <div class="wm-track-popup-head">
        <span class="wm-track-popup-dot" style="background-color: ${escapeHtml(track.color || '#06b6d4')};"></span>
        <b class="wm-track-popup-title">🌐 ${escapeHtml(track.name)} (Общий)</b>
      </div>
      <div class="wm-track-popup-grid">
        <div class="cell"><span class="lbl">Дистанция</span><b class="val">${fmtDistance(track.distance)}</b></div>
        <div class="cell"><span class="lbl">Время</span><b class="val">${durStr}</b></div>
        <div class="cell"><span class="lbl">Подъём</span><b class="val">+${Math.round(track.eleGain || 0)} м</b></div>
        <div class="cell"><span class="lbl">Точек</span><b class="val">${track.points ? track.points.length : 0}</b></div>
      </div>
      <div class="wm-track-popup-actions">
        <button type="button" class="btn btn-primary js-btn-save-remote">💾 Сохранить к себе</button>
        <button type="button" class="btn btn-secondary js-btn-remote-gpx">💾 GPX</button>
      </div>
    `;

    L.DomEvent.disableClickPropagation(popupContent);

    L.popup({ className: 'wm-track-leaflet-popup' })
      .setLatLng(latlng)
      .setContent(popupContent)
      .openOn(mapInstance);

    popupContent.querySelector('.js-btn-save-remote').onclick = () => {
      mapInstance.closePopup();
      importRemoteTrackToLocal(track);
    };
    popupContent.querySelector('.js-btn-remote-gpx').onclick = () => {
      downloadBlobGpx(track);
    };
  }

  function importRemoteTrackToLocal(remoteTrack) {
    loadStoredTracks();
    const imported = {
      ...JSON.parse(JSON.stringify(remoteTrack)),
      id: 'track_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      name: `${remoteTrack.name} (из облака)`,
      isShared: false
    };
    tracks.push(imported);
    saveStoredTracks();
    renderAllLayers();
    if (window.renderTrackSettingsList) window.renderTrackSettingsList();
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`✅ Трек «${remoteTrack.name}» сохранён в ваши локальные треки!`);
    }
  }

  // =========================================================================
  // МОДАЛЬНОЕ ОКНО ДЕТАЛЕЙ ТРЕКА С ГРАФИКОМ ВЫСОТ
  // =========================================================================
  let currentInspectedTrack = null;

  function openTrackDetailsModal(track) {
    currentInspectedTrack = track;
    calculateTrackAggregates(track);

    const modal = $('modal-track-details');
    if (!modal) return;

    $('track-details-title').textContent = track.name;
    const dot = $('track-details-badge-dot');
    if (dot) dot.style.backgroundColor = track.color || '#ef4444';

    const durationSec = track.duration || (track.endTime - track.startTime) / 1000;
    const movingSec = track.movingTime || durationSec;
    const avgSpd = durationSec > 0 ? (track.distance / durationSec) * 3.6 : 0;
    const avgMovingSpd = movingSec > 0 ? (track.distance / movingSec) * 3.6 : 0;
    const maxSpd = (track.maxSpeed || 0) * 3.6;

    const startDateStr = track.startTime ? new Date(track.startTime).toLocaleString('ru', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : '—';

    let paceStr = '—';
    if (track.distance > 50 && movingSec > 0) {
      const paceSecPerKm = movingSec / (track.distance / 1000);
      const pM = Math.floor(paceSecPerKm / 60);
      const pS = Math.floor(paceSecPerKm % 60);
      paceStr = `${pM}:${String(pS).padStart(2, '0')} /км`;
    }

    const grid = $('track-details-metrics-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="track-metric-card">
          <span class="lbl">Дистанция</span>
          <b class="val">${fmtDistance(track.distance)}</b>
          <span class="sub">${track.points.length} точек</span>
        </div>
        <div class="track-metric-card">
          <span class="lbl">Общее время</span>
          <b class="val">${fmtDuration(durationSec)}</b>
          <span class="sub">Старт: ${startDateStr}</span>
        </div>
        <div class="track-metric-card">
          <span class="lbl">В движении</span>
          <b class="val">${fmtDuration(movingSec)}</b>
          <span class="sub">Темп: ${paceStr}</span>
        </div>
        <div class="track-metric-card">
          <span class="lbl">Ср. скорость</span>
          <b class="val">${avgSpd.toFixed(1)} км/ч</b>
          <span class="sub">В движении: ${avgMovingSpd.toFixed(1)} км/ч</span>
        </div>
        <div class="track-metric-card">
          <span class="lbl">Макс. скорость</span>
          <b class="val">${maxSpd.toFixed(1)} км/ч</b>
          <span class="sub">Пиковый замер</span>
        </div>
        <div class="track-metric-card">
          <span class="lbl">Набор высоты</span>
          <b class="val">+${Math.round(track.eleGain || 0)} м</b>
          <span class="sub">Спуск: -${Math.round(track.eleLoss || 0)} м</span>
        </div>
      `;
    }

    renderElevationChart(track);

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('modal');
  }

  function closeTrackDetailsModal() {
    const modal = $('modal-track-details');
    if (modal) modal.classList.remove('open');
    if (chartProbeMarker && mapInstance) {
      mapInstance.removeLayer(chartProbeMarker);
      chartProbeMarker = null;
    }
    currentInspectedTrack = null;
    if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('modal');
  }

  // Рендеринг интерактивного SVG-графика высот
  function renderElevationChart(track) {
    const svgWrap = $('track-chart-svg-wrap');
    const svg = $('track-elevation-svg');
    const probeVal = $('track-chart-probe-val');
    if (!svgWrap || !svg) return;

    if (probeVal) probeVal.textContent = 'Нажмите или проведите по графику';

    const pts = track.points || [];
    if (pts.length < 2) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="12">Недостаточно данных о высоте</text>';
      return;
    }

    const chartData = [];
    let accumDist = 0;
    let minA = Infinity;
    let maxA = -Infinity;

    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        accumDist += L.latLng(pts[i - 1].lat, pts[i - 1].lng).distanceTo(L.latLng(pts[i].lat, pts[i].lng));
      }
      const alt = pts[i].alt != null ? pts[i].alt : 0;
      if (alt < minA) minA = alt;
      if (alt > maxA) maxA = alt;

      chartData.push({
        dist: accumDist,
        alt: alt,
        speed: pts[i].speed || 0,
        time: pts[i].time,
        lat: pts[i].lat,
        lng: pts[i].lng
      });
    }

    if (!isFinite(minA) || minA === maxA) {
      minA = Math.max(0, minA - 10);
      maxA = minA + 20;
    }

    const padY = Math.max(5, (maxA - minA) * 0.12);
    const plotMinY = minA - padY;
    const plotMaxY = maxA + padY;

    $('track-chart-min-alt').textContent = `Мин: ${Math.round(minA)} м`;
    $('track-chart-max-alt').textContent = `Макс: ${Math.round(maxA)} м`;
    $('track-chart-total-dist').textContent = fmtDistance(accumDist);

    const W = svgWrap.clientWidth || 360;
    const H = 120;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const getX = d => (accumDist > 0 ? (d / accumDist) * W : 0);
    const getY = a => H - ((a - plotMinY) / (plotMaxY - plotMinY)) * H;

    let pathD = `M ${getX(chartData[0].dist)} ${getY(chartData[0].alt)}`;
    let areaD = `M ${getX(chartData[0].dist)} ${H} L ${getX(chartData[0].dist)} ${getY(chartData[0].alt)}`;

    for (let i = 1; i < chartData.length; i++) {
      const x = getX(chartData[i].dist);
      const y = getY(chartData[i].alt);
      pathD += ` L ${x} ${y}`;
      areaD += ` L ${x} ${y}`;
    }
    areaD += ` L ${W} ${H} Z`;

    const trackColor = track.color || '#ef4444';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="trackChartGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${trackColor}" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="${trackColor}" stop-opacity="0.02"/>
      </linearGradient>
    `;
    svg.appendChild(defs);

    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', areaD);
    area.setAttribute('fill', 'url(#trackChartGrad)');
    svg.appendChild(area);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', trackColor);
    path.setAttribute('stroke-width', '2.5');
    svg.appendChild(path);

    const cursorLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    cursorLine.setAttribute('y1', '0');
    cursorLine.setAttribute('y2', H);
    cursorLine.setAttribute('stroke', 'var(--text-main)');
    cursorLine.setAttribute('stroke-width', '1.5');
    cursorLine.setAttribute('stroke-dasharray', '3, 3');
    cursorLine.style.display = 'none';
    svg.appendChild(cursorLine);

    const cursorDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cursorDot.setAttribute('r', '4.5');
    cursorDot.setAttribute('fill', trackColor);
    cursorDot.setAttribute('stroke', '#ffffff');
    cursorDot.setAttribute('stroke-width', '2');
    cursorDot.style.display = 'none';
    svg.appendChild(cursorDot);

    function updateProbeAtX(clientX) {
      const rect = svgWrap.getBoundingClientRect();
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const targetDist = (relX / rect.width) * accumDist;

      let nearest = chartData[0];
      let minDiff = Math.abs(chartData[0].dist - targetDist);
      for (let i = 1; i < chartData.length; i++) {
        const diff = Math.abs(chartData[i].dist - targetDist);
        if (diff < minDiff) {
          minDiff = diff;
          nearest = chartData[i];
        }
      }

      const svgX = getX(nearest.dist);
      const svgY = getY(nearest.alt);

      cursorLine.setAttribute('x1', svgX);
      cursorLine.setAttribute('x2', svgX);
      cursorLine.style.display = '';

      cursorDot.setAttribute('cx', svgX);
      cursorDot.setAttribute('cy', svgY);
      cursorDot.style.display = '';

      const timeElapsed = nearest.time && track.startTime ? (nearest.time - track.startTime) / 1000 : 0;
      const spdKmh = (nearest.speed * 3.6).toFixed(1);

      if (probeVal) {
        probeVal.textContent = `📍 ${fmtDistance(nearest.dist)} · ⛰️ ${Math.round(nearest.alt)} м · ⚡ ${spdKmh} км/ч · ⏱️ ${fmtDuration(timeElapsed)}`;
      }

      if (mapInstance) {
        if (!chartProbeMarker) {
          chartProbeMarker = L.marker([nearest.lat, nearest.lng], {
            icon: L.divIcon({
              className: 'wm-track-arrow-icon',
              html: `<div class="wm-track-probe-marker" style="--accent: ${trackColor};"></div>`,
              iconSize: [18, 18],
              iconAnchor: [9, 9]
            }),
            zIndexOffset: 2000
          }).addTo(mapInstance);
        } else {
          chartProbeMarker.setLatLng([nearest.lat, nearest.lng]);
        }
      }
    }

    svgWrap.onpointerdown = (e) => {
      svgWrap.setPointerCapture(e.pointerId);
      updateProbeAtX(e.clientX);
    };

    svgWrap.onpointermove = (e) => {
      if (e.buttons > 0 || e.pointerType === 'mouse') {
        updateProbeAtX(e.clientX);
      }
    };
  }

  // =========================================================================
  // ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ ТРЕКОВ (FIREBASE REALTIME DATABASE)
  // =========================================================================
  let currentSharingTrack = null;

  function openShareTrackModal(track) {
    currentSharingTrack = track;
    const modal = $('modal-track-share');
    if (!modal) return;

    $('track-share-title').textContent = `🌐 Поделиться «${track.name}»`;
    const passInput = $('track-share-password');
    const statusEl = $('track-share-status');
    const unpubBtn = $('btn-track-share-unpublish');

    if (passInput) passInput.value = track.sharePassword || '';
    if (unpubBtn) unpubBtn.hidden = !track.isShared;

    if (statusEl) {
      if (track.isShared) {
        statusEl.hidden = false;
        statusEl.innerHTML = track.sharePassword 
          ? `🔒 Трек опубликован в защищённой комнате (пароль: <b>${escapeHtml(track.sharePassword)}</b>)`
          : `🌐 Трек опубликован в общем доступе`;
        statusEl.style.color = '#10b981';
      } else {
        statusEl.hidden = true;
      }
    }

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('modal');
  }

  function closeShareTrackModal() {
    const modal = $('modal-track-share');
    if (modal) modal.classList.remove('open');
    currentSharingTrack = null;
    if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('modal');
  }

  async function shareTrackToCloud(track, password) {
    if (!track || !track.points || !track.points.length) {
      throw new Error('У трека нет точек для публикации');
    }

    calculateTrackAggregates(track);
    const pass = (password || '').trim();
    const hash = await hashPassword(pass);
    const isPublic = !pass;
    const endpoint = isPublic ? 'public' : `protected/${hash}`;

    const payload = {
      id: track.id,
      name: track.name,
      color: track.color,
      distance: track.distance,
      duration: track.duration,
      movingTime: track.movingTime,
      maxSpeed: track.maxSpeed,
      eleGain: track.eleGain,
      eleLoss: track.eleLoss,
      startTime: track.startTime,
      endTime: track.endTime,
      points: track.points,
      createdAt: Date.now(),
      hasPassword: !isPublic
    };

    const res = await fetch(`${DATABASE_URL}/shared_tracks/${endpoint}/${track.id}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Ошибка облака HTTP ${res.status}`);
    }

    if (track.isShared) {
      const prevHash = await hashPassword(track.sharePassword || '');
      const prevEndpoint = track.sharePassword ? `protected/${prevHash}` : 'public';
      if (prevEndpoint !== endpoint) {
        try {
          await fetch(`${DATABASE_URL}/shared_tracks/${prevEndpoint}/${track.id}.json`, { method: 'DELETE' });
        } catch (e) {}
      }
    }

    track.isShared = true;
    track.sharePassword = pass;
    saveStoredTracks();
    renderSavedTracks();
    if (window.renderTrackSettingsList) window.renderTrackSettingsList();
  }

  async function unshareTrackFromCloud(track) {
    if (!track || !track.isShared) return;

    const pass = (track.sharePassword || '').trim();
    const hash = await hashPassword(pass);
    const endpoint = pass ? `protected/${hash}` : 'public';

    try {
      await fetch(`${DATABASE_URL}/shared_tracks/${endpoint}/${track.id}.json`, { method: 'DELETE' });
    } catch (e) {}

    track.isShared = false;
    track.sharePassword = '';
    saveStoredTracks();
    renderSavedTracks();
    if (window.renderTrackSettingsList) window.renderTrackSettingsList();
  }

  async function fetchPublicTracksFromCloud() {
    if (!settings.showSharedTracks) return;

    try {
      const res = await fetch(`${DATABASE_URL}/shared_tracks/public.json`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data) {
        remoteSharedTracks = [];
        renderRemoteSharedTracks();
        return;
      }

      const list = Object.values(data).filter(t => t && Array.isArray(t.points) && t.points.length >= 2);
      remoteSharedTracks = list;
      renderRemoteSharedTracks();
    } catch (err) {
      console.warn('[WM Tracker] Не удалось загрузить общие треки:', err);
    }
  }

  async function downloadTracksByPassword(password) {
    const pass = (password || '').trim();
    if (!pass) throw new Error('Введите пароль комнаты');

    const hash = await hashPassword(pass);
    const res = await fetch(`${DATABASE_URL}/shared_tracks/protected/${hash}.json`);
    if (!res.ok) throw new Error(`Ошибка загрузки: HTTP ${res.status}`);
    const data = await res.json();
    if (!data) throw new Error('В этой комнате пока нет треков');

    const list = Object.values(data).filter(t => t && Array.isArray(t.points) && t.points.length >= 2);
    if (!list.length) throw new Error('В комнате не найдено корректных треков');

    loadStoredTracks();
    let importedCount = 0;
    list.forEach(t => {
      const exists = tracks.some(x => x.id === t.id);
      if (!exists) {
        tracks.push({
          ...t,
          id: 'track_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          isShared: false
        });
        importedCount++;
      }
    });

    saveStoredTracks();
    renderAllLayers();
    if (window.renderTrackSettingsList) window.renderTrackSettingsList();
    return { total: list.length, imported: importedCount };
  }

  // =========================================================================
  // ЭКСПОРТ И ИМПОРТ (GPX / GEOJSON)
  // =========================================================================
  function exportTrackGpx(trackId) {
    const track = tracks.find(t => t.id === trackId) || activeSession;
    if (!track || !track.points || !track.points.length) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Нет точек для экспорта');
      return;
    }
    downloadBlobGpx(track);
  }

  function downloadBlobGpx(track) {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx version="1.1" creator="WikiMV Tracker" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpx += `  <metadata><name>${escapeHtml(track.name)}</name></metadata>\n`;
    gpx += `  <trk>\n    <name>${escapeHtml(track.name)}</name>\n    <trkseg>\n`;

    track.points.forEach(p => {
      const timeStr = p.time ? new Date(p.time).toISOString() : '';
      gpx += `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">`;
      if (p.alt != null) gpx += `<ele>${p.alt.toFixed(1)}</ele>`;
      if (timeStr) gpx += `<time>${timeStr}</time>`;
      gpx += `</trkpt>\n`;
    });

    gpx += `    </trkseg>\n  </trk>\n</gpx>`;
    downloadBlob(gpx, `${track.name.replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_')}.gpx`, 'application/gpx+xml');
  }

  function downloadBlob(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function importTrackFile(fileContent, fileName = 'Импортированный трек') {
    let pts = [];
    let name = fileName.replace(/\.[^/.]+$/, '');

    if (fileContent.includes('<trkpt') || fileContent.includes('<gpx')) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(fileContent, 'text/xml');
      const trkptEls = doc.querySelectorAll('trkpt');
      trkptEls.forEach(el => {
        const lat = parseFloat(el.getAttribute('lat'));
        const lon = parseFloat(el.getAttribute('lon'));
        const eleEl = el.querySelector('ele');
        const timeEl = el.querySelector('time');
        if (isFinite(lat) && isFinite(lon)) {
          pts.push({
            lat,
            lng: lon,
            alt: eleEl ? parseFloat(eleEl.textContent) : null,
            time: timeEl ? Date.parse(timeEl.textContent) : Date.now()
          });
        }
      });
      const nameEl = doc.querySelector('trk > name') || doc.querySelector('name');
      if (nameEl && nameEl.textContent) name = nameEl.textContent.trim();
    } else {
      try {
        const json = JSON.parse(fileContent);
        if (Array.isArray(json.points)) {
          pts = json.points;
          if (json.name) name = json.name;
        } else if (json.type === 'FeatureCollection' || json.type === 'Feature') {
          const coords = json.type === 'Feature' ? json.geometry.coordinates : json.features[0].geometry.coordinates;
          pts = coords.map(c => ({ lat: c[1], lng: c[0], alt: c[2] || null, time: Date.now() }));
        }
      } catch (e) {}
    }

    if (pts.length < 2) {
      throw new Error('Файл не содержит корректных координат трека');
    }

    const newTrack = {
      id: 'track_' + Date.now(),
      name,
      color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
      startTime: pts[0].time || Date.now(),
      endTime: pts[pts.length - 1].time || Date.now(),
      points: pts,
      visible: true
    };

    calculateTrackAggregates(newTrack);

    tracks.push(newTrack);
    saveStoredTracks();
    renderAllLayers();
    zoomToTrack(newTrack.id);
    return newTrack;
  }

  function zoomToTrack(trackId) {
    const track = tracks.find(t => t.id === trackId) || remoteSharedTracks.find(t => t.id === trackId);
    if (!track || !track.points || !track.points.length || !mapInstance) return;
    const bounds = L.latLngBounds(track.points.map(p => [p.lat, p.lng]));
    mapInstance.fitBounds(bounds.pad(0.15));
  }

  function deleteTrack(trackId) {
    const t = tracks.find(x => x.id === trackId);
    if (t && t.isShared) {
      unshareTrackFromCloud(t).catch(() => {});
    }
    tracks = tracks.filter(t => t.id !== trackId);
    saveStoredTracks();
    renderAllLayers();
    if (window.renderTrackSettingsList) window.renderTrackSettingsList();
  }

  // =========================================================================
  // UI И HUD УПРАВЛЕНИЯ
  // =========================================================================
  function showConfigHUD() {
    if (isRecording) {
      showLiveHUD();
      return;
    }
    const hud = $('track-config-hud');
    if (!hud) return;

    $('btn-track-record')?.classList.add('active');
    $('track-config-name').value = `Трек ${tracks.length + 1}`;
    
    if ($('track-config-interval')) $('track-config-interval').value = settings.minIntervalSec || 3;
    if ($('track-config-dist')) $('track-config-dist').value = settings.minDistanceMeters || 5;

    const pal = $('track-config-colors');
    if (pal) {
      pal.innerHTML = '';
      TRACK_COLORS.forEach((c, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'track-color-btn' + (idx === 0 ? ' active' : '');
        btn.style.backgroundColor = c;
        btn.onclick = () => {
          pal.querySelectorAll('.track-color-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        };
        pal.appendChild(btn);
      });
    }

    hud.hidden = false;
  }

  function hideConfigHUD() {
    const hud = $('track-config-hud');
    if (hud) hud.hidden = true;
    if (!isRecording) $('btn-track-record')?.classList.remove('active');
  }

  function showLiveHUD() {
    const hud = $('track-live-hud');
    if (hud) hud.hidden = false;
  }

  function hideLiveHUD() {
    const hud = $('track-live-hud');
    if (hud) hud.hidden = true;
  }

  function updateLiveHUD() {
    if (!isRecording || !activeSession) return;

    const elTime = $('track-live-time');
    const elDist = $('track-live-dist');
    const elSpeed = $('track-live-speed');
    const elEle = $('track-live-ele');
    const btnPause = $('btn-track-live-pause');
    const dotPulse = $('track-live-pulse-dot');

    const elapsed = (Date.now() - activeSession.startTime) / 1000;
    if (elTime) elTime.textContent = fmtDuration(elapsed);
    if (elDist) elDist.textContent = fmtDistance(activeSession.distance);

    const curSpeedKmh = lastRecordedPoint && lastRecordedPoint.speed ? (lastRecordedPoint.speed * 3.6).toFixed(1) : '0.0';
    if (elSpeed) elSpeed.textContent = `${curSpeedKmh} км/ч`;

    if (elEle) {
      elEle.textContent = `▲+${Math.round(activeSession.eleGain || 0)} ▼-${Math.round(activeSession.eleLoss || 0)}`;
    }

    if (btnPause) {
      btnPause.textContent = isPaused ? '▶️' : '⏸️';
      btnPause.title = isPaused ? 'Возобновить запись' : 'Пауза';
    }

    if (dotPulse) {
      dotPulse.classList.toggle('paused', isPaused);
    }
  }

  function updateFloatingBtnState() {
    const btn = $('btn-track-record');
    if (!btn) return;
    btn.classList.toggle('recording', isRecording && !isPaused);
    btn.classList.toggle('paused', isRecording && isPaused);
    btn.title = isRecording 
      ? (isPaused ? '⏸️ Запись трека на паузе' : '⏺️ Идёт запись трека…') 
      : 'Запись трека (GPS Logger)';
  }

  // =========================================================================
  // ИНИЦИАЛИЗАЦИЯ
  // =========================================================================
  WM.tracker = {
    init(map) {
      mapInstance = map;
      loadStoredTracks();
      initCrashDb().then(async () => {
        const pts = await dbGetActivePoints();
        if (pts && pts.length >= 2) {
          if (confirm(`Найден незавершённый трек (${pts.length} точек). Сохранить его?`)) {
            const newTrack = {
              id: 'restored_' + Date.now(),
              name: `Восстановленный трек`,
              color: '#ef4444',
              startTime: pts[0].time || Date.now(),
              endTime: pts[pts.length - 1].time || Date.now(),
              points: pts,
              visible: true
            };
            calculateTrackAggregates(newTrack);
            tracks.push(newTrack);
            saveStoredTracks();
            renderAllLayers();
          }
          dbClearActivePoints();
        }
      });

      activeTrackLayer = L.layerGroup().addTo(map);
      savedTracksLayer = L.layerGroup().addTo(map);
      remoteTracksLayer = L.layerGroup().addTo(map);
      arrowsLayer = L.layerGroup().addTo(map);

      initBarometerListener();
      initBatteryWatcher();
      initCameraTracker();
      renderAllLayers();

      if (settings.showSharedTracks) {
        fetchPublicTracksFromCloud();
      }

      setInterval(() => {
        if (isRecording && !isPaused) updateLiveHUD();
      }, 1000);

      $('btn-track-record')?.addEventListener('click', () => {
        if (isRecording) {
          const hud = $('track-live-hud');
          if (hud) hud.hidden = !hud.hidden;
        } else {
          const cfg = $('track-config-hud');
          if (cfg && !cfg.hidden) hideConfigHUD();
          else showConfigHUD();
        }
      });

      $('btn-track-config-start')?.addEventListener('click', () => {
        const name = $('track-config-name').value;
        const interval = parseInt($('track-config-interval').value, 10);
        const dist = parseInt($('track-config-dist').value, 10);
        const activeColorBtn = $('track-config-colors')?.querySelector('.track-color-btn.active');
        const color = activeColorBtn ? activeColorBtn.style.backgroundColor : TRACK_COLORS[0];
        startRecording(name, color, interval, dist);
      });

      // Кнопка тестового трека
      $('btn-track-config-test')?.addEventListener('click', () => {
        startTestTrackRecording();
      });

      $('btn-track-live-cancel')?.addEventListener('click', () => {
        if (confirm('Отменить запись трека без сохранения?')) {
          cancelRecording();
        }
      });

      $('btn-track-config-close')?.addEventListener('click', hideConfigHUD);

      $('btn-track-live-pause')?.addEventListener('click', () => {
        if (isPaused) resumeRecording();
        else pauseRecording(true);
      });

      $('btn-track-live-stop')?.addEventListener('click', () => {
        if (confirm('Завершить и сохранить этот трек?')) {
          stopAndSaveRecording();
        }
      });

      // События модального окна подробной статистики
      $('track-details-close-x')?.addEventListener('click', closeTrackDetailsModal);
      $('btn-track-details-close')?.addEventListener('click', closeTrackDetailsModal);
      $('modal-track-details')?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-track-details') closeTrackDetailsModal();
      });

      $('btn-track-details-zoom')?.addEventListener('click', () => {
        if (currentInspectedTrack) {
          zoomToTrack(currentInspectedTrack.id);
          closeTrackDetailsModal();
        }
      });

      $('btn-track-details-export')?.addEventListener('click', () => {
        if (currentInspectedTrack) {
          exportTrackGpx(currentInspectedTrack.id);
        }
      });

      $('btn-track-details-share')?.addEventListener('click', () => {
        if (currentInspectedTrack) {
          openShareTrackModal(currentInspectedTrack);
        }
      });

      // Модальное окно публикации трека (Firebase)
      $('track-share-close-x')?.addEventListener('click', closeShareTrackModal);
      $('btn-track-share-cancel')?.addEventListener('click', closeShareTrackModal);
      $('modal-track-share')?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-track-share') closeShareTrackModal();
      });

      $('btn-track-share-submit')?.addEventListener('click', async () => {
        if (!currentSharingTrack) return;
        const pass = $('track-share-password')?.value || '';
        const submitBtn = $('btn-track-share-submit');
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = '⏳ Публикация…';
        }
        try {
          await shareTrackToCloud(currentSharingTrack, pass);
          closeShareTrackModal();
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(pass 
              ? '🔒 Трек опубликован в комнате с паролем!' 
              : '🌐 Трек опубликован в общем доступе!');
          }
        } catch (err) {
          alert('Ошибка публикации трека: ' + err.message);
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Опубликовать';
          }
        }
      });

      $('btn-track-share-unpublish')?.addEventListener('click', async () => {
        if (!currentSharingTrack) return;
        if (!confirm(`Удалить трек «${currentSharingTrack.name}» из облака Firebase?`)) return;
        const btn = $('btn-track-share-unpublish');
        if (btn) btn.disabled = true;
        try {
          await unshareTrackFromCloud(currentSharingTrack);
          closeShareTrackModal();
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast('🗑️ Трек удалён из облака Firebase');
          }
        } catch (err) {
          alert('Ошибка удаления из облака: ' + err.message);
        } finally {
          if (btn) btn.disabled = false;
        }
      });

      // Модальное окно загрузки треков по паролю
      const modalDlPass = $('modal-track-download-pass');
      $('track-dl-pass-close-x')?.addEventListener('click', () => modalDlPass?.classList.remove('open'));
      $('btn-track-dl-pass-cancel')?.addEventListener('click', () => modalDlPass?.classList.remove('open'));
      modalDlPass?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-track-download-pass') modalDlPass.classList.remove('open');
      });

      $('btn-track-dl-pass-submit')?.addEventListener('click', async () => {
        const passInput = $('track-dl-password-input');
        const pass = passInput ? passInput.value : '';
        const submitBtn = $('btn-track-dl-pass-submit');
        const statusEl = $('track-dl-pass-status');

        if (!pass.trim()) {
          alert('Введите пароль комнаты');
          return;
        }

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = '⏳ Поиск…';
        }
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.textContent = 'Подключение к Firebase…';
          statusEl.style.color = 'var(--text-muted)';
        }

        try {
          const res = await downloadTracksByPassword(pass);
          modalDlPass?.classList.remove('open');
          if (passInput) passInput.value = '';
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`✅ Загружено треков: ${res.imported} (всего в комнате: ${res.total})`);
          }
        } catch (err) {
          if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = '⚠️ ' + err.message;
            statusEl.style.color = 'var(--danger)';
          } else {
            alert('Ошибка: ' + err.message);
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '📥 Загрузить';
          }
        }
      });
    },

    onGpsUpdate: handleGpsUpdate,
    start: startRecording,
    pause: pauseRecording,
    resume: resumeRecording,
    stop: stopAndSaveRecording,
    cancel: cancelRecording,
    fmtDistance: fmtDistance,
    isRecording: () => isRecording,
    isPaused: () => isPaused,
    isCameraLocked: () => isRecording && settings.cameraMode === 'locked',
    getSettings: () => ({ ...settings }),
    setSettings: (s) => {
      const prevShowShared = settings.showSharedTracks;
      settings = { ...settings, ...s };
      saveSettings();
      if (settings.showSharedTracks && !prevShowShared) {
        fetchPublicTracksFromCloud();
      } else if (!settings.showSharedTracks) {
        remoteSharedTracks = [];
      }
      renderAllLayers();
    },
    getTracks: () => [...tracks],
    deleteTrack,
    zoomToTrack,
    exportGpx: exportTrackGpx,
    importFile: importTrackFile,
    closeDetailsModal: closeTrackDetailsModal,
    openDetailsModal: openTrackDetailsModal,
    openShareModal: openShareTrackModal,
    fetchPublicTracks: fetchPublicTracksFromCloud,
    downloadTracksByPassword,
    toggleTrackVisibility(trackId) {
      const t = tracks.find(x => x.id === trackId);
      if (t) {
        t.visible = (t.visible === false);
        saveStoredTracks();
        renderSavedTracks();
      }
    },
    renameTrack(trackId, newName) {
      const t = tracks.find(x => x.id === trackId);
      if (t && newName) {
        t.name = newName.trim();
        saveStoredTracks();
        renderSavedTracks();
      }
    }
  };
})();