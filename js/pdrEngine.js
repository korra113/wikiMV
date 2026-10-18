(function () {
  window.WM = window.WM || {};

  const CONFIG = {
    navigationType: 'step',       // 'step' (пешком/бег) | 'vehicular' (вело/авто)
    carryingMode: 'hand',         // 'hand' | 'pocket'
    baseStepLength: 0.75,         // метры
    vehicularSpeedKmh: 18,        // базовая скорость для вело/авто при потере GPS (км/ч)
    useDynamicStride: true,       // модель Вайнберга
    sensitivity: 'normal',        // 'high' | 'normal' | 'low'
    headingDamping: 'medium',     // 'low' | 'medium' | 'high'
    autoEngageOnSpoof: true,      // автостарт при глушении
    alignmentOffset: 0,           // угол поправки соосности (°)
    useMagneticDeclination: true, // учёт магнитного склонения (True North)
    altitudeSource: 'auto',       // 'auto' | 'barometer' | 'dem' | 'imu'
    stairDetection: true,         // распознавание ступеней лестниц
    elevatorDetection: true,      // распознавание лифтов/эскалаторов
    stepVibration: true           // виброотклик при обычном шаге
  };

  const SENSITIVITY_TABLE = {
    high:   { peakValleyDiff: 0.55, minPeak: 0.40, minVertical: 0.15, maxGyroNoise: 5.5 },
    normal: { peakValleyDiff: 1.35, minPeak: 0.95, minVertical: 0.30, maxGyroNoise: 4.0 },
    low:    { peakValleyDiff: 2.40, minPeak: 1.70, minVertical: 0.50, maxGyroNoise: 3.0 }
  };

  function getActiveThresholds() {
    return SENSITIVITY_TABLE[CONFIG.sensitivity] || SENSITIVITY_TABLE.normal;
  }

  let isRunning = false;
  let onStepCallback = null;
  let onHeadingCallback = null;
  let onTelemetryCallback = null;
  let onAltitudeCallback = null;
  let isSoundEnabled = true;

  // Кватернион ориентации: q = [w, x, y, z]
  let qW = 1.0, qX = 0.0, qY = 0.0, qZ = 0.0;
  const betaMadgwick = 0.045;
  let lastSensorTime = 0;

  // --- КАЛИБРОВКА НУЛЯ ГИРОСКОПА (ZUPT BIAS CORRECTION) ---
  let biasGx = 0.0, biasGy = 0.0, biasGz = 0.0;
  let restFramesCount = 0;

  let hasTrueHardwareGyro = false;     // True, если подтвержден физический качественный гироскоп
  let gyroEvaluated = false;           // Флаг завершения автокалибровки типа сенсора
  let gyroEvaluationFrames = 0;
  let gyroValidMotionFrames = 0;



  // --- ДЕТЕКТОР МАГНИТНЫХ АНОМАЛИЙ И СШИВКА КУРСА ---
  let fusedHeading = null;
  let lastExternalCompass = null;
  let magneticAnomalyActive = false;
  let anomalyCooldownTimer = 0;

  // Мировые ускорения ENU
  let aEast = 0, aNorth = 0, aUp = 0;
  let currentGyroMag = 0;

  // Детектор покоя (ZUPT)
  const ZUPT_WINDOW = 25;
  const zuptBuffer = [];
  const zuptAccelBuffer = [];

  // Детектор шагов
  const ACCEL_WINDOW_SIZE = 9;
  const accelWindow = [];
  let smoothDynMag = 0;
  let lastPeakTime = 0;
  let minValleySinceLastPeak = Infinity;
  let stepCount = 0;

  // Двухшаговый валидатор
  let walkingState = 'IDLE';
  let pendingStepCandidate = null;
  let lastConfirmedStepTime = 0;

  // Соосность ходьбы
  let isAlignmentTesting = false;
  let alignmentStepsTarget = 15;
  let alignmentStepsDone = 0;
  let alignmentImpulseVectors = [];

  // Высота и барометр
  let currentAltitude = 150.0;
  let baseSeaPressure = 1013.25;
  let lastPressureHpa = null;
  let barometerAvailable = false;
  let pressureSensorInstance = null;
  let stairCounter = 0;

  // Склонение
  let magneticDeclinationDeg = 0;
  let lastLat = 55.75, lastLng = 37.62;

  // SDR (Vehicular Speed Dead Reckoning) таймер
  let vehicularTimer = null;
  let lastVehicularTick = 0;

  let audioCtx = null;
  let lpfGravity = { x: 0, y: 9.80665, z: 0 };
  let hasGravityInit = false;

  function calculateMagneticDeclination(lat, lng) {
    // Для европейской части РФ склонение около +11°...+13°
    if (lat >= 53 && lat <= 60 && lng >= 34 && lng <= 42) {
      return 12.3;
    }
    return 0;
  }
  function updateRegionCoordinates(lat, lng) {
    if (lat && lng) {
      lastLat = lat;
      lastLng = lng;
      magneticDeclinationDeg = calculateMagneticDeclination(lat, lng);
    }
  }

  function rotateDeviceToWorldENU(ax, ay, az, q0, q1, q2, q3) {
    const r11 = 1 - 2 * (q2 * q2 + q3 * q3);
    const r12 = 2 * (q1 * q2 - q0 * q3);
    const r13 = 2 * (q1 * q3 + q0 * q2);

    const r21 = 2 * (q1 * q2 + q0 * q3);
    const r22 = 1 - 2 * (q1 * q1 + q3 * q3);
    const r23 = 2 * (q2 * q3 - q0 * q1);

    const r31 = 2 * (q1 * q3 - q0 * q2);
    const r32 = 2 * (q2 * q3 + q0 * q1);
    const r33 = 1 - 2 * (q1 * q1 + q2 * q2);

    const e = r11 * ax + r12 * ay + r13 * az;
    const n = r21 * ax + r22 * ay + r23 * az;
    const u = r31 * ax + r32 * ay + r33 * az;

    return { e, n, u: u - 9.80665 };
  }

  function madgwickUpdate(gx, gy, gz, ax, ay, az, dt) {
    let qDot1 = 0.5 * (-qX * gx - qY * gy - qZ * gz);
    let qDot2 = 0.5 * (qW * gx + qY * gz - qZ * gy);
    let qDot3 = 0.5 * (qW * gy - qX * gz + qZ * gx);
    let qDot4 = 0.5 * (qW * gz + qX * gy - qY * gx);

    const aNorm = Math.hypot(ax, ay, az);
    if (aNorm > 4.0 && aNorm < 16.0) {
      const invA = 1.0 / aNorm;
      ax *= invA; ay *= invA; az *= invA;

      const _2q0 = 2.0 * qW, _2q1 = 2.0 * qX, _2q2 = 2.0 * qY, _2q3 = 2.0 * qZ;
      const _4q0 = 4.0 * qW, _4q1 = 4.0 * qX, _4q2 = 4.0 * qY;
      const _8q1 = 8.0 * qX, _8q2 = 8.0 * qY;
      const q0q0 = qW * qW, q1q1 = qX * qX, q2q2 = qY * qY, q3q3 = qZ * qZ;

      const s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      const s1 = _4q1 * q3q3 - _2q3 * ax + 4.0 * q0q0 * qX - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      const s2 = 4.0 * q0q0 * qY + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      const s3 = 4.0 * q1q1 * qZ - _2q1 * ax + 4.0 * q2q2 * qZ - _2q2 * ay;

      const sNorm = Math.hypot(s0, s1, s2, s3);
      if (sNorm > 0.0001) {
        const invS = 1.0 / sNorm;
        qDot1 -= betaMadgwick * (s0 * invS);
        qDot2 -= betaMadgwick * (s1 * invS);
        qDot3 -= betaMadgwick * (s2 * invS);
        qDot4 -= betaMadgwick * (s3 * invS);
      }
    }

    qW += qDot1 * dt;
    qX += qDot2 * dt;
    qY += qDot3 * dt;
    qZ += qDot4 * dt;

    const recipNorm = 1.0 / Math.hypot(qW, qX, qY, qZ);
    qW *= recipNorm; qX *= recipNorm; qY *= recipNorm; qZ *= recipNorm;
  }

  function getRawMadgwickHeading() {
    const t0 = 2.0 * (qW * qZ + qX * qY);
    const t1 = 1.0 - 2.0 * (qY * qY + qZ * qZ);
    let heading = Math.atan2(t0, t1) * (180 / Math.PI);
    if (heading < 0) heading += 360;

    const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    heading = (heading + screenAngle + CONFIG.alignmentOffset) % 360;
    if (CONFIG.useMagneticDeclination) {
      heading = (heading + magneticDeclinationDeg + 360) % 360;
    }
    return (heading + 360) % 360;
  }

  // --- ОБНОВЛЕНИЕ ВНЕШНЕГО КОМПАСА С ДЕТЕКТОРОМ АНОМАЛИЙ ---
  // Флаг обнаружения виртуального/нестабильного гироскопа
  let isSyntheticGyro = false;
  let gyroCheckSamples = 0;
  let gyroZeroOrDupeCount = 0;

  // --- ОБНОВЛЕНИЕ ВНЕШНЕГО КОМПАСА С УМНЫМ ДЕТЕКТОРОМ АНОМАЛИЙ ---
  function updateExternalCompass(compassDeg) {
    if (compassDeg === null || isNaN(compassDeg)) return;
    const now = performance.now();

    if (fusedHeading === null) {
      fusedHeading = compassDeg;
      lastExternalCompass = compassDeg;
      return;
    }

    // 1. Кратчайшая дельта нового замера компаса к прошлому замеру
    const compassDelta = ((compassDeg - (lastExternalCompass || compassDeg) + 540) % 360) - 180;
    lastExternalCompass = compassDeg;

    // 2. Детектор аномалий: скачок более 55° без соответствующего вращения планшета
    const isWindows = navigator.userAgent.includes('Windows');
    const isJerk = Math.abs(compassDelta) > 55 && !isWindows;
    if (isJerk) {
      magneticAnomalyActive = true;
      anomalyCooldownTimer = now + 400;
    } else if (now > anomalyCooldownTimer) {
      magneticAnomalyActive = false;
    }

    // 3. Распределение веса в фильтре:
    let filterWeight;
    if (magneticAnomalyActive) {
      // При магнитной аномалии почти не доверяем компасу
      filterWeight = 0.02;
    } else if (hasTrueHardwareGyro) {
      // НА ФЛАГМАНЕ: высокочастотные повороты уже рассчитаны гироскопом в handleDeviceMotion,
      // компас лишь плавно и незаметно устраняет медленный дрейф нуля:
      filterWeight = (CONFIG.headingDamping === 'high') ? 0.03 : 0.06;
    } else {
      // НА БЮДЖЕТНОМ УСТРОЙСТВЕ: компас — основной источник.
      // Используем адаптивное кольцевое сглаживание:
      const diff = Math.abs(((compassDeg - fusedHeading + 540) % 360) - 180);
      if (diff > 30) filterWeight = 0.28;       // Резкий разворот человека
      else if (diff > 10) filterWeight = 0.16;  // Обычный шаг/поворот
      else filterWeight = 0.07;                 // Стояние на месте / дрожание рук
    }

    // 4. Корректный поворот кольцевого угла без сингулярности 0°/360°
    const diffAngle = ((compassDeg - fusedHeading + 540) % 360) - 180;
    fusedHeading = (fusedHeading + diffAngle * filterWeight + 360) % 360;
  }

  function getFusedHeading() {
    if (fusedHeading !== null) return fusedHeading;
    return getRawMadgwickHeading();
  }

  function initBarometer() {
    if ('PressureSensor' in window || 'AmbientPressureSensor' in window) {
      try {
        const SensorClass = window.PressureSensor || window.AmbientPressureSensor;
        pressureSensorInstance = new SensorClass({ frequency: 10 });
        pressureSensorInstance.addEventListener('reading', () => {
          barometerAvailable = true;
          const hPa = pressureSensorInstance.pressure;
          if (hPa > 300 && hPa < 1150) handlePressureReading(hPa);
        });
        pressureSensorInstance.start();
      } catch (e) {
        barometerAvailable = false;
      }
    }
  }

  function handlePressureReading(hPa) {
    if (lastPressureHpa === null) {
      lastPressureHpa = hPa;
      return;
    }
    const instantAlt = 44330 * (1.0 - Math.pow(hPa / baseSeaPressure, 0.190284));
    const deltaAlt = instantAlt - (44330 * (1.0 - Math.pow(lastPressureHpa / baseSeaPressure, 0.190284)));
    lastPressureHpa = hPa;

    if (Math.abs(deltaAlt) > 0.05 && Math.abs(deltaAlt) < 8.0) {
      currentAltitude += deltaAlt;
      if (onAltitudeCallback) onAltitudeCallback(currentAltitude, deltaAlt, 'barometer');
    }
  }

  function decodeTerrariumRGB(r, g, b) {
    return (r * 256.0 + g + b / 256.0) - 32768.0;
  }

  // --- ОБРАБОТЧИК ДАТЧИКОВ ДВИЖЕНИЯ ---
  function handleDeviceMotion(e) {
    const now = performance.now();
    // Ограничиваем dt в разумных пределах (от 5 до 80 мс) на случай подвисания потока браузера
    const dt = Math.min(0.08, Math.max(0.005, (now - (lastSensorTime || now)) / 1000));
    lastSensorTime = now;

    // 1. Сырые ускорения с гравитацией
    let rawAx = (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x) || 0;
    let rawAy = (e.accelerationIncludingGravity && e.accelerationIncludingGravity.y) || 0;
    let rawAz = (e.accelerationIncludingGravity && e.accelerationIncludingGravity.z) || 0;

    // 2. Выделение гравитационного вектора через фильтр нижних частот (LPF)
    const alphaGravity = Math.min(0.985, Math.max(0.85, Math.exp(-dt / 0.40)));
    if (!hasGravityInit) {
      lpfGravity = { x: rawAx, y: rawAy, z: rawAz };
      hasGravityInit = true;
    } else {
      lpfGravity.x = alphaGravity * lpfGravity.x + (1 - alphaGravity) * rawAx;
      lpfGravity.y = alphaGravity * lpfGravity.y + (1 - alphaGravity) * rawAy;
      lpfGravity.z = alphaGravity * lpfGravity.z + (1 - alphaGravity) * rawAz;
    }

    // 3. Динамическое ускорение (чистое движение человека без силы тяжести)
    const dynX = rawAx - lpfGravity.x;
    const dynY = rawAy - lpfGravity.y;
    const dynZ = rawAz - lpfGravity.z;
    const dynMagTotal = Math.hypot(dynX, dynY, dynZ);

    const alphaSmooth = Math.min(0.65, Math.max(0.12, dt / (0.055 + dt)));
    smoothDynMag += alphaSmooth * (dynMagTotal - smoothDynMag);

    // 4. Чтение угловых скоростей (W3C standard)
    const rot = e.rotationRate || {};
    const rawGx = (rot.beta || 0) * (Math.PI / 180);   // X = Pitch rate (рад/с)
    const rawGy = (rot.gamma || 0) * (Math.PI / 180);  // Y = Roll rate (рад/с)
    const rawGz = (rot.alpha || 0) * (Math.PI / 180);  // Z = Yaw rate (рад/с)
    currentGyroMag = Math.hypot(rawGx, rawGy, rawGz);

    // 5. Безопасная автодетекция физического гироскопа:
    // Оцениваем сенсор ТОЛЬКО когда в руках есть реальное движение (dynMagTotal > 0.15)
    // чтобы телефон, лежащий неподвижно на столе при запуске, не был сочтен "бюджетным".
    if (!gyroEvaluated && dynMagTotal > 0.15) {
      gyroEvaluationFrames++;
      // Физический MEMS-гироскоп при движении в руке показывает реалистичные угловые скорости
      // (от 0.03 до 8.0 рад/с). Эмулятор бюджетника либо дает нули, либо прыгает до 15+ рад/с.
      if (currentGyroMag > 0.03 && currentGyroMag < 8.0) {
        gyroValidMotionFrames++;
      }
      if (gyroEvaluationFrames >= 60) {
        hasTrueHardwareGyro = (gyroValidMotionFrames / gyroEvaluationFrames) > 0.65;
        gyroEvaluated = true;
        if (!hasTrueHardwareGyro) {
          console.info('[PDR] Обнаружен виртуальный гироскоп. Включен адаптивный режим повышенной стабильности компаса.');
        }
      }
    }

    // Если синтетический гироскоп выдал дикий артефакт (>12 рад/с ≈ 700°/с), принудительно гасим его
    if (currentGyroMag > 12.0) {
      hasTrueHardwareGyro = false;
      gyroEvaluated = true;
    }

    const sensCfg = getActiveThresholds();

    // 6. Буфер покоя (ZUPT): на бюджетных опираемся строго на отсутствие ускорения
    zuptBuffer.push(currentGyroMag);
    if (zuptBuffer.length > ZUPT_WINDOW) zuptBuffer.shift();

    zuptAccelBuffer.push(smoothDynMag);
    if (zuptAccelBuffer.length > ZUPT_WINDOW) zuptAccelBuffer.shift();

    const avgAccel = zuptAccelBuffer.reduce((a, b) => a + b, 0) / zuptAccelBuffer.length;
    const isAtRest = avgAccel < (sensCfg.minPeak * 0.35);

    // Калибровка нуля (Bias): выполняется ТОЛЬКО на подтвержденном аппаратном гироскопе
    if (hasTrueHardwareGyro && isAtRest) {
      restFramesCount++;
      if (restFramesCount > 10) {
        const biasLearnRate = 0.015;
        biasGx += biasLearnRate * (rawGx - biasGx);
        biasGy += biasLearnRate * (rawGy - biasGy);
        biasGz += biasLearnRate * (rawGz - biasGz);
      }
    } else {
      restFramesCount = 0;
    }

    const cleanGx = rawGx - (hasTrueHardwareGyro ? biasGx : 0);
    const cleanGy = rawGy - (hasTrueHardwareGyro ? biasGy : 0);
    const cleanGz = rawGz - (hasTrueHardwareGyro ? biasGz : 0);

    // Единичный вектор «Вверх» против силы тяжести
    const gNorm = Math.hypot(lpfGravity.x, lpfGravity.y, lpfGravity.z) || 9.80665;
    const upX = lpfGravity.x / gNorm;
    const upY = lpfGravity.y / gNorm;
    const upZ = lpfGravity.z / gNorm;

    // 7. Интеграция курса гироскопом
    const isWindowsDesktop = navigator.userAgent.includes('Windows');

    // На Windows/Surface оси гироскопа в браузере часто перепутаны драйвером,
    // а встроенный компас Windows уже аппаратно сглажен — интеграцию гироскопа по Z на Windows отключаем:
    if (hasTrueHardwareGyro && !isWindowsDesktop) {
      madgwickUpdate(cleanGx, cleanGy, cleanGz, rawAx, rawAy, rawAz, dt);

      const worldGyroZ = cleanGx * upX + cleanGy * upY + cleanGz * upZ;

      if (fusedHeading !== null) {
        const gyroYawRateDeg = Math.abs(worldGyroZ * (180 / Math.PI));
        if (gyroYawRateDeg > 2.2 && gyroYawRateDeg < 380.0) {
          const gyroYawStepDeg = -(worldGyroZ * (180 / Math.PI)) * dt;
          fusedHeading = (fusedHeading + gyroYawStepDeg + 360) % 360;
        }
      }
    }

    // 8. Вертикальное ускорение шага вдоль оси тяжести: a_up = (a · g)/|g| - |g|
    aUp = (rawAx * lpfGravity.x + rawAy * lpfGravity.y + rawAz * lpfGravity.z) / gNorm - gNorm;

    const currentHeading = getFusedHeading();
    const isStationaryManipulating = (currentGyroMag > sensCfg.maxGyroNoise && Math.abs(aUp) < 0.25);

    // Сброс зависших кандидатов шага по таймауту
    if (pendingStepCandidate && (now - pendingStepCandidate.time > 1350)) pendingStepCandidate = null;
    if (walkingState === 'WALKING' && (now - lastConfirmedStepTime > 1500)) walkingState = 'IDLE';

    // 9. Телеметрия для графиков и HUD
    if (onTelemetryCallback) {
      try {
        onTelemetryCallback({
          ax: dynX, ay: dynY, az: dynZ,
          dynMag: smoothDynMag,
          upAccel: aUp,
          gyroMag: currentGyroMag,
          heading: currentHeading,
          altitude: currentAltitude,
          isBlockedByZupt: isAtRest || isStationaryManipulating || (walkingState === 'IDLE' && !pendingStepCandidate),
          threshold: sensCfg.peakValleyDiff,
          magneticAnomaly: magneticAnomalyActive,
          hasHardwareGyro: hasTrueHardwareGyro
        });
      } catch (err) {}
    }

    // В vehicular-режиме (вело/авто) физический шагомер пропускаем
    if (!isRunning || CONFIG.navigationType === 'vehicular') return;

    // 10. Пиковый детектор шагов
    const stepWaveform = (CONFIG.carryingMode === 'pocket') ? Math.hypot(dynY, dynZ) : smoothDynMag;
    accelWindow.push(stepWaveform);
    if (accelWindow.length > ACCEL_WINDOW_SIZE) accelWindow.shift();
    if (accelWindow.length < ACCEL_WINDOW_SIZE) return;

    const midIdx = Math.floor(ACCEL_WINDOW_SIZE / 2);
    const midVal = accelWindow[midIdx];

    let isLocalPeak = true;
    for (let i = 0; i < ACCEL_WINDOW_SIZE; i++) {
      if (i !== midIdx && accelWindow[i] >= midVal) { isLocalPeak = false; break; }
    }

    minValleySinceLastPeak = Math.min(minValleySinceLastPeak, midVal);

    const minStepIntervalMs = CONFIG.carryingMode === 'pocket' ? 290 : 310;
    const maxStepIntervalMs = 1350;

    if (isLocalPeak && midVal >= sensCfg.minPeak && !isStationaryManipulating && !isAtRest) {
      const peakValleyDiff = midVal - minValleySinceLastPeak;
      const timeSinceLastPeak = now - lastPeakTime;
      const minVert = sensCfg.minVertical || 0.22;
      const hasVerticalGait = (Math.abs(aUp) >= minVert) || (Math.hypot(dynY, dynZ) >= (minVert * 1.3));

      if (peakValleyDiff >= sensCfg.peakValleyDiff && timeSinceLastPeak >= minStepIntervalMs && hasVerticalGait) {
        lastPeakTime = now;
        minValleySinceLastPeak = midVal;

        // Распознавание ступеней
        let deltaAltStep = 0;
        let isStairs = false;
        if (CONFIG.stairDetection && peakValleyDiff > 2.0 && aUp > 0.85) {
          stairCounter++;
          if (stairCounter >= 2) {
            isStairs = true; deltaAltStep = 0.165; currentAltitude += deltaAltStep;
            if (onAltitudeCallback) onAltitudeCallback(currentAltitude, deltaAltStep, 'stairs_up');
          }
        } else if (CONFIG.stairDetection && peakValleyDiff > 1.8 && aUp < -0.80) {
          stairCounter++;
          if (stairCounter >= 2) {
            isStairs = true; deltaAltStep = -0.165; currentAltitude += deltaAltStep;
            if (onAltitudeCallback) onAltitudeCallback(currentAltitude, deltaAltStep, 'stairs_down');
          }
        } else {
          stairCounter = 0;
        }

        // Расчет длины шага (модель Вайнберга)
        let actualStrideMeters = CONFIG.baseStepLength;
        if (CONFIG.useDynamicStride) {
          const bounceFactor = Math.pow(Math.max(0.4, peakValleyDiff), 0.25);
          actualStrideMeters = CONFIG.baseStepLength * (bounceFactor / 1.10);
          if (isStairs) actualStrideMeters *= 0.70;
          actualStrideMeters = Math.max(CONFIG.baseStepLength * 0.50, Math.min(CONFIG.baseStepLength * 1.45, actualStrideMeters));
        }

        const bodyImpulseAngle = (Math.atan2(dynX, dynY) * 180 / Math.PI + 360) % 360;

        // Двухшаговый валидатор от случайных одиночных встряхиваний
        if (walkingState === 'IDLE') {
          if (!pendingStepCandidate) {
            pendingStepCandidate = {
              stride: actualStrideMeters,
              heading: currentHeading,
              deltaAlt: deltaAltStep,
              bodyImpulseAngle,
              time: now
            };
          } else {
            const interval = now - pendingStepCandidate.time;
            if (interval >= minStepIntervalMs && interval <= maxStepIntervalMs) {
              walkingState = 'WALKING';
              lastConfirmedStepTime = now;
              stepCount++;
              commitStep(pendingStepCandidate.stride, pendingStepCandidate.heading, pendingStepCandidate.deltaAlt, pendingStepCandidate.bodyImpulseAngle);
              stepCount++;
              commitStep(actualStrideMeters, currentHeading, deltaAltStep, bodyImpulseAngle);
              pendingStepCandidate = null;
            } else {
              pendingStepCandidate = {
                stride: actualStrideMeters,
                heading: currentHeading,
                deltaAlt: deltaAltStep,
                bodyImpulseAngle,
                time: now
              };
            }
          }
        } else {
          const interval = now - lastConfirmedStepTime;
          if (interval >= minStepIntervalMs && interval <= maxStepIntervalMs) {
            lastConfirmedStepTime = now;
            stepCount++;
            commitStep(actualStrideMeters, currentHeading, deltaAltStep, bodyImpulseAngle);
          } else if (interval > maxStepIntervalMs) {
            walkingState = 'IDLE';
            pendingStepCandidate = {
              stride: actualStrideMeters,
              heading: currentHeading,
              deltaAlt: deltaAltStep,
              bodyImpulseAngle,
              time: now
            };
          }
        }
      }
    }
  }

  
  function commitStep(strideMeters, headingDeg, deltaAltStep, bodyImpulseAngle) {
    if (isAlignmentTesting) {
      alignmentStepsDone++;
      alignmentImpulseVectors.push({
        step: alignmentStepsDone,
        impulseAngle: bodyImpulseAngle,
        deviceYaw: headingDeg
      });
      if (alignmentStepsDone >= alignmentStepsTarget) finishAlignmentWalk();
    }

    playStepAudioCue();
    if (CONFIG.stepVibration && navigator.vibrate) {
      try { navigator.vibrate(25); } catch (err) {}
    }

    if (onStepCallback) {
      onStepCallback(strideMeters, headingDeg, stepCount, deltaAltStep, currentAltitude);
    }
  }

  // --- СОВЕТ 3: SPEED DEAD RECKONING ДЛЯ ВЕЛОСИПЕДА И АВТОМОБИЛЯ ---
  function startVehicularLoop() {
    stopVehicularLoop();
    lastVehicularTick = performance.now();

    vehicularTimer = setInterval(() => {
      if (!isRunning || CONFIG.navigationType !== 'vehicular') return;
      const now = performance.now();
      const dt = (now - lastVehicularTick) / 1000;
      lastVehicularTick = now;

      if (dt <= 0 || dt > 2.0) return;

      const speedMps = (CONFIG.vehicularSpeedKmh || 18) / 3.6;
      const distanceMeters = speedMps * dt;
      const heading = getFusedHeading();

      stepCount++;
      if (onStepCallback) {
        onStepCallback(distanceMeters, heading, stepCount, 0, currentAltitude);
      }
    }, 400); // тикаем каждые 400 мс для плавности ведения трека
  }

  function stopVehicularLoop() {
    if (vehicularTimer) {
      clearInterval(vehicularTimer);
      vehicularTimer = null;
    }
  }

  function startAlignmentWalk(steps = 15) {
    isAlignmentTesting = true;
    alignmentStepsTarget = steps;
    alignmentStepsDone = 0;
    alignmentImpulseVectors = [];
  }

  function finishAlignmentWalk() {
    isAlignmentTesting = false;
    if (!alignmentImpulseVectors.length) return null;

    let sumSin = 0, sumCos = 0;
    alignmentImpulseVectors.forEach(v => {
      const diffRad = ((v.impulseAngle - v.deviceYaw + 540) % 360 - 180) * (Math.PI / 180);
      sumSin += Math.sin(diffRad);
      sumCos += Math.cos(diffRad);
    });

    const calculatedOffset = Math.round((Math.atan2(sumSin, sumCos) * 180 / Math.PI));
    CONFIG.alignmentOffset = calculatedOffset;
    try {
      localStorage.setItem('wm_pdr_alignment_offset', calculatedOffset.toString());
    } catch (e) {}

    return {
      offset: calculatedOffset,
      stepsRecorded: alignmentImpulseVectors.length
    };
  }

  function playStepAudioCue() {
    if (!isSoundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioCtx) audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.14, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.06);
    } catch (e) {}
  }

  function loadSettings() {
    try {
      const navType = localStorage.getItem('wm_pdr_nav_type');
      if (navType === 'step' || navType === 'vehicular') CONFIG.navigationType = navType;

      const mode = localStorage.getItem('wm_pdr_mode');
      if (mode === 'hand' || mode === 'pocket') CONFIG.carryingMode = mode;

      const stride = parseFloat(localStorage.getItem('wm_pdr_step_length'));
      if (stride && stride >= 0.4 && stride <= 1.3) CONFIG.baseStepLength = stride;

      const vSpeed = parseFloat(localStorage.getItem('wm_pdr_vehicular_speed'));
      if (vSpeed && vSpeed >= 3 && vSpeed <= 160) CONFIG.vehicularSpeedKmh = vSpeed;

      const sVibe = localStorage.getItem('wm_pdr_step_vibe');
      if (sVibe !== null) CONFIG.stepVibration = (sVibe === 'true');

      const dyn = localStorage.getItem('wm_pdr_dynamic_stride');
      if (dyn !== null) CONFIG.useDynamicStride = (dyn === 'true');

      const sens = localStorage.getItem('wm_pdr_sensitivity');
      if (sens && SENSITIVITY_TABLE[sens]) CONFIG.sensitivity = sens;

      const damp = localStorage.getItem('wm_pdr_damping');
      if (damp) CONFIG.headingDamping = damp;

      const autoEngage = localStorage.getItem('wm_pdr_auto_engage');
      if (autoEngage !== null) CONFIG.autoEngageOnSpoof = (autoEngage === 'true');

      const offset = parseFloat(localStorage.getItem('wm_pdr_alignment_offset'));
      if (!isNaN(offset)) CONFIG.alignmentOffset = offset;

      const decl = localStorage.getItem('wm_pdr_use_declination');
      if (decl !== null) CONFIG.useMagneticDeclination = (decl === 'true');

      const stairs = localStorage.getItem('wm_pdr_stair_detect');
      if (stairs !== null) CONFIG.stairDetection = (stairs === 'true');

      const elev = localStorage.getItem('wm_pdr_elev_detect');
      if (elev !== null) CONFIG.elevatorDetection = (elev === 'true');

      const snd = localStorage.getItem('wm_pdr_sound');
      if (snd !== null) isSoundEnabled = (snd === 'true');
    } catch (e) {}
  }

  loadSettings();
  initBarometer();

  async function requestPermissions() {
    let orientation = false, motion = false;
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { orientation = (await DeviceOrientationEvent.requestPermission() === 'granted'); } catch (e) {}
    } else {
      orientation = ('ondeviceorientation' in window);
    }

    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { motion = (await DeviceMotionEvent.requestPermission() === 'granted'); } catch (e) {}
    } else {
      motion = ('ondevicemotion' in window);
    }

    try {
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (AudioClass && (!audioCtx || audioCtx.state === 'suspended')) {
        if (!audioCtx) audioCtx = new AudioClass();
        await audioCtx.resume();
      }
    } catch (e) {}

    return { orientation, motion };
  }

  WM.pdr = {
    start(stepCb, headingCb, altCb) {
      isRunning = true;
      onStepCallback = stepCb;
      if (headingCb) onHeadingCallback = headingCb;
      if (altCb) onAltitudeCallback = altCb;

      walkingState = 'IDLE';
      pendingStepCandidate = null;
      lastConfirmedStepTime = 0;
      smoothDynMag = 0;
      accelWindow.length = 0;
      zuptBuffer.length = 0;
      zuptAccelBuffer.length = 0;
      minValleySinceLastPeak = Infinity;
      lastPeakTime = performance.now();

      window.addEventListener('devicemotion', handleDeviceMotion, false);

      if (CONFIG.navigationType === 'vehicular') {
        startVehicularLoop();
      }
    },

    stop() {
      isRunning = false;
      onStepCallback = null;
      walkingState = 'IDLE';
      pendingStepCandidate = null;
      stopVehicularLoop();
      if (!onTelemetryCallback) {
        window.removeEventListener('devicemotion', handleDeviceMotion, false);
      }
    },

    isActive: () => isRunning,
    getHeading: () => getFusedHeading(),
    updateExternalCompass,
    isMagneticAnomaly: () => magneticAnomalyActive,
    getStepCount: () => stepCount,
    resetStepCount: () => { 
      stepCount = 0; 
      walkingState = 'IDLE'; 
      pendingStepCandidate = null; 
    },
    getAltitude: () => currentAltitude,
    setAltitude: (alt) => { currentAltitude = alt; },

    setTelemetryCallback(cb) {
      onTelemetryCallback = cb;
      if (cb) {
        window.addEventListener('devicemotion', handleDeviceMotion, false);
      } else if (!isRunning) {
        this.stop();
      }
    },

    startAlignmentWalk,
    finishAlignmentWalk,
    isAlignmentActive: () => isAlignmentTesting,
    getAlignmentProgress: () => ({ done: alignmentStepsDone, target: alignmentStepsTarget }),

    updateRegionCoordinates,
    getMagneticDeclination: () => magneticDeclinationDeg,
    decodeTerrariumRGB,
    requestPermissions,
    setSoundEnabled(val) {
      isSoundEnabled = !!val;
      try { localStorage.setItem('wm_pdr_sound', isSoundEnabled ? 'true' : 'false'); } catch (e) {}
    },
    isSoundEnabled: () => isSoundEnabled,
    playCue: playStepAudioCue,

    getConfig: () => ({ ...CONFIG, declination: magneticDeclinationDeg }),
    setConfig(newCfg) {
      Object.assign(CONFIG, newCfg);
      try {
        if (newCfg.navigationType) localStorage.setItem('wm_pdr_nav_type', newCfg.navigationType);
        if (newCfg.carryingMode) localStorage.setItem('wm_pdr_mode', newCfg.carryingMode);
        if (newCfg.baseStepLength) localStorage.setItem('wm_pdr_step_length', newCfg.baseStepLength.toString());
        if (newCfg.vehicularSpeedKmh) localStorage.setItem('wm_pdr_vehicular_speed', newCfg.vehicularSpeedKmh.toString());
        if (newCfg.stepVibration !== undefined) {
          CONFIG.stepVibration = !!newCfg.stepVibration;
          try { localStorage.setItem('wm_pdr_step_vibe', CONFIG.stepVibration ? 'true' : 'false'); } catch (e) {}
        }
        if (newCfg.useDynamicStride !== undefined) localStorage.setItem('wm_pdr_dynamic_stride', newCfg.useDynamicStride ? 'true' : 'false');
        if (newCfg.sensitivity) localStorage.setItem('wm_pdr_sensitivity', newCfg.sensitivity);
        if (newCfg.headingDamping) localStorage.setItem('wm_pdr_damping', newCfg.headingDamping);
        if (newCfg.autoEngageOnSpoof !== undefined) localStorage.setItem('wm_pdr_auto_engage', newCfg.autoEngageOnSpoof ? 'true' : 'false');
        if (newCfg.alignmentOffset !== undefined) localStorage.setItem('wm_pdr_alignment_offset', newCfg.alignmentOffset.toString());
        if (newCfg.useMagneticDeclination !== undefined) localStorage.setItem('wm_pdr_use_declination', newCfg.useMagneticDeclination ? 'true' : 'false');
        if (newCfg.stairDetection !== undefined) localStorage.setItem('wm_pdr_stair_detect', newCfg.stairDetection ? 'true' : 'false');
        if (newCfg.elevatorDetection !== undefined) localStorage.setItem('wm_pdr_elev_detect', newCfg.elevatorDetection ? 'true' : 'false');
      } catch (e) {}

      if (isRunning) {
        if (CONFIG.navigationType === 'vehicular') {
          startVehicularLoop();
        } else {
          stopVehicularLoop();
        }
      }
    }, // <-- Добавлена запятая
    getDebugSnapshot() {
      return {
        fused: fusedHeading !== null ? Math.round(fusedHeading * 10) / 10 : null,
        rawMadgwick: Math.round(getRawMadgwickHeading() * 10) / 10,
        anomaly: magneticAnomalyActive,
        q: [
          Math.round(qW * 1000) / 1000,
          Math.round(qX * 1000) / 1000,
          Math.round(qY * 1000) / 1000,
          Math.round(qZ * 1000) / 1000
        ],
        biasZ: Math.round(biasGz * 1000) / 1000,
        dynMag: Math.round(smoothDynMag * 100) / 100,
        upAccel: Math.round(aUp * 100) / 100
      };
    }
  };
})();
