/**
 * js/colorPicker.js
 * Кастомный Color Picker: 2D-квадрат (HSV/HSL), слайдеры HSL, HEX/цифровой ввод.
 * Автоматически перехватывает клик по ЛЮБОМУ input[type="color"] в проекте.
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  // Картографические пресеты (рельеф, тени, вода, скалы, горизонтали)
  const PRESET_COLORS = [
    '#ffffff', '#000000', '#fff8e7', '#ffd8a8', '#1e2438',
    '#b45309', '#78350f', '#1c1917', '#2a4d69', '#1c3d5a',
    '#264e36', '#7fa361', '#b89e58', '#ef4444', '#38bdf8'
  ];

  // Математика преобразований
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function hsvToHsl(h, s_val, v) {
    const l = v * (1 - s_val / 2);
    const s_hsl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
    return [Math.round(h), Math.round(s_hsl * 100), Math.round(l * 100)];
  }

  function hslToHsv(h, s_pct, l_pct) {
    const s = s_pct / 100;
    const l = l_pct / 100;
    const v = l + s * Math.min(l, 1 - l);
    const s_val = v === 0 ? 0 : 2 * (1 - l / v);
    return [h, s_val, v];
  }

  function hslToRgb(h, s, l) {
    h = (h % 360 + 360) % 360;
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h = Math.round(h * 60);
    }
    return [(h % 360 + 360) % 360, Math.round(s * 100), Math.round(l * 100)];
  }

  function hexToRgb(hex) {
    let clean = String(hex || '#000').replace('#', '').trim();
    if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
    const n = parseInt(clean, 16);
    if (isNaN(n) || clean.length !== 6) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const toHex = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function hslToHex(h, s, l) {
    const [r, g, b] = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
  }

  // Состояние текущего выбора
  let curH = 0;   // 0..360
  let curS = 100; // 0..100 (%)
  let curL = 50;  // 0..100 (%)
  let initialHex = '#ffffff';
  let targetInput = null;
  let isDraggingSv = false;

  const $ = id => document.getElementById(id);

  function updateUI(source) {
    const hex = (source === 'init') ? initialHex : hslToHex(curH, curS, curL);

    // 1. Цвет фона квадрата (чистый тон без затемнений)
    const svBox = $('cp-sv-box');
    if (svBox) svBox.style.backgroundColor = `hsl(${curH}, 100%, 50%)`;

    // 2. Позиция кружка на 2D-квадрате (HSV координаты)
    if (source !== 'sv') {
      const [, s_v, v] = hslToHsv(curH, curS, curL);
      const handle = $('cp-sv-handle');
      if (handle) {
        handle.style.left = (s_v * 100) + '%';
        handle.style.top = ((1 - v) * 100) + '%';
      }
    }

    // 3. Слайдеры и их градиенты
    if (source !== 'h') {
      const sH = $('cp-hue-slider'); if (sH) sH.value = curH;
      const vH = $('cp-hue-val'); if (vH) vH.textContent = curH + '°';
    }
    if (source !== 's') {
      const sS = $('cp-sat-slider'); if (sS) sS.value = curS;
      const vS = $('cp-sat-val'); if (vS) vS.textContent = curS + '%';
    }
    if (source !== 'l') {
      const sL = $('cp-lit-slider'); if (sL) sL.value = curL;
      const vL = $('cp-lit-val'); if (vL) vL.textContent = curL + '%';
    }

    const satSlider = $('cp-sat-slider');
    if (satSlider) {
      satSlider.style.background = `linear-gradient(to right, hsl(${curH}, 0%, ${curL}%), hsl(${curH}, 100%, ${curL}%))`;
    }

    const litSlider = $('cp-lit-slider');
    if (litSlider) {
      litSlider.style.background = `linear-gradient(to right, #000000 0%, hsl(${curH}, ${curS}%, 50%) 50%, #ffffff 100%)`;
    }

    // 4. Текстовые инпуты
    if (source !== 'hex') {
      const inHex = $('cp-hex-input'); if (inHex) inHex.value = hex;
    }
    if (source !== 'num') {
      const nH = $('cp-num-h'); if (nH) nH.value = curH;
      const nS = $('cp-num-s'); if (nS) nS.value = curS;
      const nL = $('cp-num-l'); if (nL) nL.value = curL;
    }

    // 5. Превью
    const swNew = $('cp-swatch-new');
    if (swNew) swNew.style.backgroundColor = hex;

    // 6. Live-передача цвета (только при реальном изменении, НЕ при init)
    if (targetInput && source !== 'init') {
      targetInput.value = hex;
      const valLabel = document.getElementById(targetInput.id + '-val');
      if (valLabel) valLabel.textContent = hex;

      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function handleSvMove(clientX, clientY) {
    const svBox = $('cp-sv-box');
    if (!svBox) return;
    const rect = svBox.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);

    const handle = $('cp-sv-handle');
    if (handle) {
      handle.style.left = (x * 100) + '%';
      handle.style.top = (y * 100) + '%';
    }

    const s_val = x;
    const v = 1 - y;
    const [, s_hsl, l_hsl] = hsvToHsl(curH, s_val, v);
    curS = s_hsl;
    curL = l_hsl;

    const vS = $('cp-sat-val'); if (vS) vS.textContent = curS + '%';
    const vL = $('cp-lit-val'); if (vL) vL.textContent = curL + '%';

    updateUI('sv');
  }

  function openPicker(inputEl) {
    targetInput = inputEl;
    initialHex = inputEl.value || '#ffffff';
    const [r, g, b] = hexToRgb(initialHex);
    [curH, curS, curL] = rgbToHsl(r, g, b);

    const modal = $('modal-color-picker');
    const swOld = $('cp-swatch-old');
    if (swOld) swOld.style.backgroundColor = initialHex;

    const titleEl = $('cp-modal-title');
    if (titleEl) {
      const labelText = inputEl.closest('.form-group, .style-row, .te-row')?.querySelector('label')?.textContent;
      titleEl.textContent = labelText ? `🎨 ${labelText.trim().replace(/[:：]/g, '')}` : '🎨 Выбор цвета';
    }

    renderPresets();
    updateUI('init');

    if (modal) {
      modal.classList.add('open');
      if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('colorPicker');
    }
  }

  function closePicker(apply) {
    const modal = $('modal-color-picker');
    if (modal) modal.classList.remove('open');

    if (!apply && targetInput) {
      // Отмена: возвращаем исходный цвет
      targetInput.value = initialHex;
      const valLabel = document.getElementById(targetInput.id + '-val');
      if (valLabel) valLabel.textContent = initialHex;
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (apply && targetInput) {
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    targetInput = null;
    if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('colorPicker');
  }

  function renderPresets() {
    const row = $('cp-presets-row');
    if (!row || row._inited) return;
    row._inited = true;
    row.innerHTML = '';

    PRESET_COLORS.forEach(hex => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cp-preset-chip';
      chip.style.backgroundColor = hex;
      chip.title = hex;
      chip.onclick = () => {
        const [r, g, b] = hexToRgb(hex);
        [curH, curS, curL] = rgbToHsl(r, g, b);
        updateUI('preset');
      };
      row.appendChild(chip);
    });
  }

  function initEvents() {
    // 2D Квадрат тач и мышь
    const svBox = $('cp-sv-box');
    if (svBox) {
      const onStart = e => {
        isDraggingSv = true;
        const pt = e.touches ? e.touches[0] : e;
        handleSvMove(pt.clientX, pt.clientY);
      };
      svBox.addEventListener('mousedown', onStart);
      svBox.addEventListener('touchstart', onStart, { passive: false });

      window.addEventListener('mousemove', e => {
        if (!isDraggingSv) return;
        handleSvMove(e.clientX, e.clientY);
      });
      window.addEventListener('touchmove', e => {
        if (!isDraggingSv) return;
        handleSvMove(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });

      const onEnd = () => { isDraggingSv = false; };
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchend', onEnd);
    }

    // Слайдеры HSL
    $('cp-hue-slider')?.addEventListener('input', e => {
      curH = parseInt(e.target.value, 10);
      $('cp-hue-val').textContent = curH + '°';
      updateUI('h');
    });

    $('cp-sat-slider')?.addEventListener('input', e => {
      curS = parseInt(e.target.value, 10);
      $('cp-sat-val').textContent = curS + '%';
      updateUI('s');
    });

    $('cp-lit-slider')?.addEventListener('input', e => {
      curL = parseInt(e.target.value, 10);
      $('cp-lit-val').textContent = curL + '%';
      updateUI('l');
    });

    // Текстовый ввод HEX
    $('cp-hex-input')?.addEventListener('input', e => {
      let val = e.target.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        const [r, g, b] = hexToRgb(val);
        [curH, curS, curL] = rgbToHsl(r, g, b);
        updateUI('hex');
      }
    });

    // Цифровой ввод H / S / L
    const onNumInput = () => {
      curH = clamp(parseInt($('cp-num-h').value, 10) || 0, 0, 360);
      curS = clamp(parseInt($('cp-num-s').value, 10) || 0, 0, 100);
      curL = clamp(parseInt($('cp-num-l').value, 10) || 0, 0, 100);
      updateUI('num');
    };
    $('cp-num-h')?.addEventListener('input', onNumInput);
    $('cp-num-s')?.addEventListener('input', onNumInput);
    $('cp-num-l')?.addEventListener('input', onNumInput);

    // Копирование HEX
    $('cp-copy-hex')?.addEventListener('click', () => {
      const hex = hslToHex(curH, curS, curL);
      navigator.clipboard?.writeText(hex).then(() => {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📋 Скопировано: ${hex}`);
      });
    });

    // Кнопки Применить / Отмена
    $('cp-btn-apply')?.addEventListener('click', () => closePicker(true));
    $('cp-btn-cancel')?.addEventListener('click', () => closePicker(false));
    $('cp-close-x')?.addEventListener('click', () => closePicker(false));

    $('modal-color-picker')?.addEventListener('click', e => {
      if (e.target.id === 'modal-color-picker') closePicker(false);
    });

    // =======================================================================
    // САМОЕ ГЛАВНОЕ: АВТОМАТИЧЕСКИЙ ПЕРЕХВАТ ВСЕХ input[type="color"] В ПРОЕКТЕ
    // =======================================================================
    document.addEventListener('click', e => {
      const colorInput = e.target.closest('input[type="color"]');
      if (!colorInput) return;

      // Блокируем нативное окно выбора цвета ОС/браузера
      e.preventDefault();
      e.stopPropagation();

      // Открываем наше красивое меню
      openPicker(colorInput);
    }, true); // Флаг true (capture-фаза) перехватывает клик раньше нативного браузера!
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEvents);
  } else {
    initEvents();
  }

  // Публичный API
  WM.colorPicker = {
    open: openPicker,
    close: closePicker,
    hslToHex,
    hexToRgb,
    rgbToHsl
  };
})();