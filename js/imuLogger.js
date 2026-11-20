(function () {
  window.WM = window.WM || {};

  const $ = id => document.getElementById(id);

  const SCENARIOS = {
    cardinal: {
      title: '4 стороны света (по 5 сек)',
      desc: 'Идите по 5 секунд в каждую сторону света, слегка покачивая смартфон вперед-назад.',
      durationSec: 20,
      phases: [
        { from: 0,  to: 5,  label: '🧭 Фаза 1/4: Идите на СЕВЕР (держите ровно или слегка наклоняйте)' },
        { from: 5,  to: 10, label: '🧭 Фаза 2/4: Повернитесь и идите на ВОСТОК' },
        { from: 10, to: 15, label: '🧭 Фаза 3/4: Повернитесь и идите на ЮГ' },
        { from: 15, to: 20, label: '🧭 Фаза 4/4: Повернитесь и идите на ЗАПАД' }
      ]
    },
    pitch_tilt: {
      title: 'Тест наклонов вперед-назад (20 сек)',
      desc: 'Выявляет ошибки компенсации наклона корпуса при движении в одном направлении.',
      durationSec: 20,
      phases: [
        { from: 0,  to: 5,  label: '📱 Фаза 1/4: Держите телефон ровно горизонтально' },
        { from: 5,  to: 10, label: '📐 Фаза 2/4: Наклоните телефон экраном ОТ СЕБЯ (вперед на ~30-40°)' },
        { from: 10, to: 15, label: '📐 Фаза 3/4: Наклоните телефон НА СЕБЯ (назад на ~30-40°)' },
        { from: 15, to: 20, label: '🔄 Фаза 4/4: Медленно повернитесь вокруг своей оси на 360°' }
      ]
    },
    free: {
      title: 'Свободная запись (Ручной старт / стоп)',
      desc: 'Включите запись и идите в направлении, где компас начинает лихорадить.',
      durationSec: 60,
      phases: [
        { from: 0, to: 9999, label: '🚶 Идет запись... Нажмите «Стоп» в любой момент' }
      ]
    }
  };

  let activeScenarioKey = 'cardinal';
  let isRecording = false;
  let startTime = 0;
  let sampleTimer = null;
  let animTimer = null;
  let audioCtx = null;
  let lastBeepSec = -1;

  // Буфер сырых данных
  let recordedSamples = [];
  let latestOrientation = null;
  let latestMotion = null;

  function playBeep(freq = 880, duration = 0.08) {
    try {
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioClass) return;
      if (!audioCtx) audioCtx = new AudioClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }

  function onOrientationEvent(e) {
    latestOrientation = {
      alpha: e.alpha !== null ? Math.round(e.alpha * 10) / 10 : null,
      beta: e.beta !== null ? Math.round(e.beta * 10) / 10 : null,
      gamma: e.gamma !== null ? Math.round(e.gamma * 10) / 10 : null,
      absolute: !!e.absolute,
      webkitCompass: (typeof e.webkitCompassHeading === 'number') ? Math.round(e.webkitCompassHeading * 10) / 10 : null
    };
  }

  function onMotionEvent(e) {
    const acc = e.accelerationIncludingGravity || {};
    const rot = e.rotationRate || {};
    latestMotion = {
      ax: acc.x !== null ? Math.round(acc.x * 100) / 100 : 0,
      ay: acc.y !== null ? Math.round(acc.y * 100) / 100 : 0,
      az: acc.z !== null ? Math.round(acc.z * 100) / 100 : 0,
      // Вращения в градусах в секунду
      gx: rot.beta !== null ? Math.round(rot.beta * 10) / 10 : 0,   // pitch rate
      gy: rot.gamma !== null ? Math.round(rot.gamma * 10) / 10 : 0,  // roll rate
      gz: rot.alpha !== null ? Math.round(rot.alpha * 10) / 10 : 0   // yaw rate
    };
  }

  function getCurrentPhase(elapsedSec) {
    const sc = SCENARIOS[activeScenarioKey];
    for (const ph of sc.phases) {
      if (elapsedSec >= ph.from && elapsedSec < ph.to) {
        return ph;
      }
    }
    return sc.phases[sc.phases.length - 1];
  }

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    recordedSamples = [];
    startTime = performance.now();
    lastBeepSec = -1;

    // Включаем сенсоры
    window.addEventListener('deviceorientationabsolute', onOrientationEvent, true);
    window.addEventListener('deviceorientation', onOrientationEvent, true);
    window.addEventListener('devicemotion', onMotionEvent, true);

    const btnStart = $('imu-log-btn-start');
    const btnStop = $('imu-log-btn-stop');
    const resultBox = $('imu-log-result-box');
    const liveBox = $('imu-log-live-box');

    if (btnStart) btnStart.hidden = true;
    if (btnStop) btnStop.hidden = false;
    if (resultBox) resultBox.hidden = true;
    if (liveBox) liveBox.hidden = false;

    playBeep(660, 0.15);
    if (navigator.vibrate) navigator.vibrate(100);

    // Сбор данных ровно 20 раз в секунду (каждые 50 мс)
    sampleTimer = setInterval(recordSampleTick, 50);

    // Отрисовка UI 60 FPS
    updateLiveUI();
  }

  function recordSampleTick() {
    if (!isRecording) return;
    const now = performance.now();
    const elapsedSec = (now - startTime) / 1000;
    const sc = SCENARIOS[activeScenarioKey];

    if (activeScenarioKey !== 'free' && elapsedSec >= sc.durationSec) {
      stopRecording();
      return;
    }

    const curPhase = getCurrentPhase(elapsedSec);

    // Звуковой/вибро обратный отсчет перед сменой фазы (за 3, 2, 1 сек)
    if (activeScenarioKey !== 'free') {
      const remainingInPhase = Math.ceil(curPhase.to - elapsedSec);
      if (remainingInPhase <= 3 && remainingInPhase > 0 && remainingInPhase !== lastBeepSec) {
        lastBeepSec = remainingInPhase;
        playBeep(440, 0.05);
        if (navigator.vibrate) navigator.vibrate(30);
      } else if (remainingInPhase > 3) {
        lastBeepSec = -1;
      }
    }

    // Собираем данные
    const pdrSnap = (WM.pdr && WM.pdr.getDebugSnapshot) ? WM.pdr.getDebugSnapshot() : {};
    const compassHeading = (WM.compass && WM.compass.getHeading) ? WM.compass.getHeading() : null;

    const sample = {
      t: Math.round(elapsedSec * 100) / 100,
      ph: curPhase.label.split(':')[0].replace(/[^0-9/]/g, '') || '1',
      ori: latestOrientation ? [latestOrientation.alpha, latestOrientation.beta, latestOrientation.gamma] : null,
      rot: latestMotion ? [latestMotion.gx, latestMotion.gy, latestMotion.gz] : null,
      acc: latestMotion ? [latestMotion.ax, latestMotion.ay, latestMotion.az] : null,
      comp: compassHeading,
      fused: pdrSnap.fused || null,
      madg: pdrSnap.rawMadgwick || null,
      q: pdrSnap.q || null,
      anom: pdrSnap.anomaly ? 1 : 0
    };

    recordedSamples.push(sample);
  }

  function updateLiveUI() {
    if (!isRecording) return;
    const now = performance.now();
    const elapsedSec = (now - startTime) / 1000;
    const sc = SCENARIOS[activeScenarioKey];
    const curPhase = getCurrentPhase(elapsedSec);

    const promptEl = $('imu-log-phase-prompt');
    const timerEl = $('imu-log-timer');
    const progressFill = $('imu-log-progress-fill');
    const liveTelemEl = $('imu-log-live-telem');

    if (promptEl) promptEl.textContent = curPhase.label;

    if (activeScenarioKey !== 'free') {
      const totalSec = sc.durationSec;
      const leftSec = Math.max(0, totalSec - elapsedSec);
      if (timerEl) timerEl.textContent = `${leftSec.toFixed(1)} с`;
      if (progressFill) progressFill.style.width = `${Math.min(100, (elapsedSec / totalSec) * 100)}%`;
    } else {
      if (timerEl) timerEl.textContent = `${elapsedSec.toFixed(1)} с`;
      if (progressFill) progressFill.style.width = '100%';
    }

    if (liveTelemEl && latestOrientation) {
      const pdrH = (WM.pdr && WM.pdr.getHeading) ? WM.pdr.getHeading() : '--';
      liveTelemEl.textContent = 
        `Alpha: ${latestOrientation.alpha}° | Beta (наклон): ${latestOrientation.beta}° | Gamma: ${latestOrientation.gamma}° | Курс PDR: ${pdrH}° | Точек: ${recordedSamples.length}`;
    }

    animTimer = requestAnimationFrame(updateLiveUI);
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    clearInterval(sampleTimer);
    cancelAnimationFrame(animTimer);

    window.removeEventListener('deviceorientationabsolute', onOrientationEvent, true);
    window.removeEventListener('deviceorientation', onOrientationEvent, true);
    window.removeEventListener('devicemotion', onMotionEvent, true);

    playBeep(880, 0.25);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    const btnStart = $('imu-log-btn-start');
    const btnStop = $('imu-log-btn-stop');
    const resultBox = $('imu-log-result-box');
    const liveBox = $('imu-log-live-box');

    if (btnStart) btnStart.hidden = false;
    if (btnStop) btnStop.hidden = true;
    if (liveBox) liveBox.hidden = true;
    if (resultBox) resultBox.hidden = false;

    buildFinalReport();
  }

  function buildFinalReport() {
    const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const ua = navigator.userAgent;

    // Подсчет статистики колебаний и аномалий
    let maxPitch = -Infinity, minPitch = Infinity;
    let headingJumps = 0;
    let anomalyCount = 0;

    for (let i = 1; i < recordedSamples.length; i++) {
      const s = recordedSamples[i];
      const prev = recordedSamples[i - 1];
      if (s.ori && s.ori[1] !== null) {
        if (s.ori[1] > maxPitch) maxPitch = s.ori[1];
        if (s.ori[1] < minPitch) minPitch = s.ori[1];
      }
      if (s.anom) anomalyCount++;
      if (s.fused !== null && prev.fused !== null) {
        // Кратчайшая угловая дуга с корректным переходом через 0°/360°
        const delta = Math.abs(((s.fused - prev.fused + 540) % 360) - 180);
        if (delta > 15) headingJumps++;
      }
    }

    const payload = {
      meta: {
        scenario: SCENARIOS[activeScenarioKey].title,
        samplesCount: recordedSamples.length,
        durationSec: recordedSamples.length ? recordedSamples[recordedSamples.length - 1].t : 0,
        screenOrientationAngle: screenAngle,
        userAgent: ua,
        stats: {
          pitchRange: [minPitch, maxPitch],
          rapidHeadingJumps: headingJumps,
          magneticAnomalyFrames: anomalyCount
        }
      },
      legend: {
        t: 'Время (сек)',
        ph: 'Номер фазы теста',
        ori: '[alpha (yaw/компас), beta (pitch/наклон вперед-назад), gamma (roll/крен)]',
        rot: '[gyroX (pitchRate), gyroY (rollRate), gyroZ (yawRate)] в град/с',
        acc: '[ax, ay, az] акселерометр в м/с²',
        comp: 'Курс из компаса приложения',
        fused: 'Курс после фильтра сшивки PDR',
        madg: 'Курс кватерниона Madgwick',
        q: '[qW, qX, qY, qZ]',
        anom: '1 если сработал детектор магнитных аномалий'
      },
      data: recordedSamples
    };

    const promptText = `
=== ЗАДАЧА ДЛЯ НЕЙРОСЕТИ ===
Проанализируй телеметрию датчиков DeviceOrientation, Gyroscope и вычисленного курса (PDR / Comp) при ходьбе/наклонах устройства.
Проблема: в некоторых направлениях компас и конус направления ведут себя стабильно, а при наклоне телефона вперед-назад (угол beta) или при смене направления на перпендикулярное — курс начинает сильно лихорадить и скакать.

Определи:
1. Связан ли скачок курса со сменой знака или проекции угла наклона beta/gamma на горизонтальную плоскость?
2. Есть ли несоответствие между фактической угловой скоростью рыскания (rot[2] / yawRate) и поворотом кватерниона/компаса при наклонах?
3. Какая математическая ошибка в фильтре ориентации или тригонометрии приводит к этим колебаниям и как её исправить в коде?

=== ТЕЛЕМЕТРИЯ (JSON) ===
${JSON.stringify(payload)}
`.trim();

    const textarea = $('imu-log-output');
    if (textarea) textarea.value = promptText;

    const statsEl = $('imu-log-stats-summary');
    if (statsEl) {
      statsEl.innerHTML = `
        Записано сэмплов: <b>${recordedSamples.length}</b> (~${(recordedSamples.length / 20).toFixed(1)} с) · 
        Диапазон наклона Beta: <b>${minPitch === Infinity ? '--' : minPitch + '°...' + maxPitch + '°'}</b> · 
        Резких скачков курса (&gt;15°): <b>${headingJumps}</b>
      `;
    }
  }

  function copyLogToClipboard() {
    const textarea = $('imu-log-output');
    if (!textarea || !textarea.value) return;

    textarea.select();
    navigator.clipboard.writeText(textarea.value).then(() => {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Лог телеметрии скопирован в буфер обмена!');
    }).catch(() => {
      document.execCommand('copy');
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('📋 Лог скопирован');
    });
  }

  function downloadLogJson() {
    const textarea = $('imu-log-output');
    if (!textarea || !textarea.value) return;

    const blob = new Blob([textarea.value], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imu_telemetry_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function openModal() {
    const modal = $('modal-imu-logger');
    if (!modal) return;
    modal.classList.add('open');

    // Сброс в исходное состояние
    const btnStart = $('imu-log-btn-start');
    const btnStop = $('imu-log-btn-stop');
    const liveBox = $('imu-log-live-box');
    const resultBox = $('imu-log-result-box');

    if (btnStart) btnStart.hidden = false;
    if (btnStop) btnStop.hidden = true;
    if (liveBox) liveBox.hidden = true;
    if (resultBox) resultBox.hidden = true;

    updateScenarioDescription();
  }

  function closeModal() {
    if (isRecording) stopRecording();
    const modal = $('modal-imu-logger');
    if (modal) modal.classList.remove('open');
  }

  function updateScenarioDescription() {
    const sc = SCENARIOS[activeScenarioKey];
    const descEl = $('imu-log-scenario-desc');
    if (descEl && sc) descEl.textContent = sc.desc;
  }

  function init() {
    const sel = $('imu-log-scenario-select');
    if (sel) {
      sel.onchange = (e) => {
        if (isRecording) stopRecording();
        activeScenarioKey = e.target.value;
        updateScenarioDescription();
      };
    }

    $('imu-log-btn-start')?.addEventListener('click', startRecording);
    $('imu-log-btn-stop')?.addEventListener('click', stopRecording);
    $('imu-log-btn-copy')?.addEventListener('click', copyLogToClipboard);
    $('imu-log-btn-download')?.addEventListener('click', downloadLogJson);
    $('imu-log-close-x')?.addEventListener('click', closeModal);
    $('imu-log-btn-close')?.addEventListener('click', closeModal);

    const modal = $('modal-imu-logger');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  WM.imuLogger = {
    openModal,
    closeModal,
    isRecording: () => isRecording,
    stop: stopRecording
  };
})();