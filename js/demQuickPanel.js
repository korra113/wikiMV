(function () {
  const WM = window.WM = window.WM || {};

  const LS_POS_KEY = 'wm_dqp_pos';
  const LS_COLLAPSED_KEY = 'wm_dqp_collapsed';

  let panelEl = null;
  let currentMode = 'relief'; // 'relief' | 'contours'
  let isOpen = false;
  let isCollapsed = false;
  let uiSyncRaf = 0;

  try {
    isCollapsed = localStorage.getItem(LS_COLLAPSED_KEY) === 'true';
  } catch (e) {}

  function injectStyles() {
    if (document.getElementById('wm-dqp-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-dqp-style';
    st.textContent = `
      .dqp-panel {
        position: fixed;
        z-index: 1260;
        width: min(322px, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
        max-height: calc(100dvh - 16px);
        display: flex;
        flex-direction: column;
        background: var(--bg-primary, #ffffff);
        color: var(--text-main, #111827);
        border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
        overflow: hidden;
        font-size: 12px;
        user-select: none;
        -webkit-user-select: none;
      }
      .dqp-panel[hidden] {
        display: none !important;
      }
      .dqp-panel.dqp-collapsed .dqp-body,
      .dqp-panel.dqp-collapsed .dqp-mode-bar,
      .dqp-panel.dqp-collapsed .dqp-footer {
        display: none !important;
      }

      /* Шапка (зона перетаскивания) */
      .dqp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 7px 9px;
        background: var(--bg-secondary, #f3f4f6);
        border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
        cursor: grab;
        touch-action: none;
      }
      .dqp-header:active {
        cursor: grabbing;
      }
      .dqp-panel.dqp-collapsed .dqp-header {
        border-bottom: none;
      }
      .dqp-title-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .dqp-drag-dots {
        font-size: 13px;
        color: var(--text-muted, #6b7280);
        letter-spacing: -1px;
        flex-shrink: 0;
      }
      .dqp-title {
        font-weight: 800;
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dqp-head-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .dqp-hbtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 26px;
        height: 26px;
        padding: 0 6px;
        border-radius: 7px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
        background: var(--bg-primary, #ffffff);
        color: var(--text-main, #111827);
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .dqp-hbtn:hover {
        border-color: var(--accent, #3b82f6);
      }
      .dqp-hbtn-full {
        font-size: 11px;
        gap: 3px;
      }
      .dqp-hbtn-close:hover {
        border-color: #ef4444;
        color: #ef4444;
      }

      /* Переключатель режимов + главный тумблер */
      .dqp-mode-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.2));
        background: var(--bg-primary, #ffffff);
      }
      .dqp-seg {
        display: flex;
        flex: 1 1 auto;
        background: var(--bg-secondary, #f3f4f6);
        border-radius: 8px;
        padding: 2px;
        gap: 2px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
      }
      .dqp-seg-btn {
        flex: 1 1 0;
        padding: 4px 6px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted, #6b7280);
        font-size: 11.5px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }
      .dqp-seg-btn.active {
        background: var(--bg-primary, #ffffff);
        color: var(--accent, #3b82f6);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
      }
      .dqp-power-btn {
        flex: 0 0 auto;
        padding: 5px 10px;
        border-radius: 8px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
        background: var(--bg-secondary, #f3f4f6);
        color: var(--text-muted, #6b7280);
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
      }
      .dqp-power-btn.active {
        background: var(--accent, #3b82f6);
        border-color: var(--accent, #3b82f6);
        color: #ffffff;
      }

      /* Прокручиваемая область настроек */
      .dqp-body {
        padding: 8px;
        overflow-y: auto;
        overscroll-behavior: contain;
        max-height: min(54vh, 430px);
        max-height: min(54dvh, 430px);
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      @media (max-width: 600px) {
        .dqp-body {
          max-height: min(44dvh, 340px);
        }
      }

      .dqp-card {
        background: var(--bg-secondary, #f3f4f6);
        border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
        border-radius: 9px;
        padding: 7px 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dqp-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        align-items: end;
      }
      .dqp-grid-4 {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 5px;
      }
      .dqp-field {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .dqp-field label {
        font-size: 10.5px;
        font-weight: 700;
        color: var(--text-muted, #6b7280);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 4px;
        margin: 0;
      }
      .dqp-field label b {
        color: var(--accent, #3b82f6);
        font-weight: 800;
      }
      .dqp-panel .styled-select,
      .dqp-panel .styled-input {
        padding: 4px 6px;
        font-size: 11.5px;
        min-height: 28px;
        width: 100%;
        box-sizing: border-box;
      }
      .dqp-panel .styled-color-picker {
        width: 100%;
        height: 26px;
        padding: 1px;
        border-radius: 6px;
        cursor: pointer;
      }

      .dqp-mini-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .dqp-chip {
        flex: 1 1 auto;
        padding: 3px 6px;
        font-size: 10.5px;
        font-weight: 700;
        border-radius: 6px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
        background: var(--bg-primary, #ffffff);
        color: var(--text-main, #111827);
        cursor: pointer;
        text-align: center;
        white-space: nowrap;
      }
      .dqp-chip.active {
        background: var(--accent, #3b82f6);
        border-color: var(--accent, #3b82f6);
        color: #ffffff;
      }

      .dqp-grad-wrap {
        margin-top: 2px;
      }
      .dqp-grad-bar {
        position: relative;
        height: 11px;
        border-radius: 6px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
        overflow: hidden;
      }
      .dqp-grad-pin {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: #ffffff;
        box-shadow: 0 0 2px #000000;
        pointer-events: none;
      }
      .dqp-grad-labels {
        display: flex;
        justify-content: space-between;
        font-size: 9.5px;
        color: var(--text-muted, #6b7280);
        margin-top: 2px;
      }

      /* Вложенные спойлеры */
      .dqp-spoiler {
        border: 1px solid var(--border, rgba(128, 128, 128, 0.24));
        border-radius: 9px;
        background: var(--bg-secondary, #f3f4f6);
        overflow: hidden;
      }
      .dqp-spoiler-sum {
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 8px;
        font-size: 11.5px;
        font-weight: 700;
        cursor: pointer;
        color: var(--text-main, #111827);
      }
      .dqp-spoiler-sum::-webkit-details-marker {
        display: none;
      }
      .dqp-spoiler-chev {
        font-size: 9.5px;
        color: var(--text-muted, #6b7280);
        transition: transform 0.15s ease;
      }
      .dqp-spoiler[open] > .dqp-spoiler-sum .dqp-spoiler-chev {
        transform: rotate(180deg);
      }
      .dqp-spoiler-body {
        padding: 6px 8px 8px;
        border-top: 1px dashed var(--border, rgba(128, 128, 128, 0.25));
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .dqp-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        font-size: 11.5px;
        font-weight: 600;
      }
      .dqp-dimmed {
        opacity: 0.45;
        pointer-events: none;
      }

      /* Подвал */
      .dqp-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 6px 8px;
        border-top: 1px solid var(--border, rgba(128, 128, 128, 0.22));
        background: var(--bg-secondary, #f3f4f6);
      }
      .dqp-footer .btn {
        font-size: 11px;
        padding: 5px 9px;
      }

      [data-theme="night-vision"] .dqp-panel {
        border-color: #450a0a;
      }
    `;
    document.head.appendChild(st);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function hexToVec3(hex) {
    const clean = (hex || '#000000').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16) || 0;
    return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
  }

  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0 || 1e-5), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function lerpVec3(a, b, t) {
    const s = clamp(t, 0, 1);
    return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
  }

  function fmtHour(h, lat, lng) {
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60) % 24;
    const mm = totalMin % 60;
    const str = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (WM.timeWarp && isFinite(lat) && isFinite(lng)) {
      const ev = WM.timeWarp.getSunEvents(lat, lng, new Date());
      if (ev.valid) {
        if (Math.abs(h - ev.rise) < 0.45) return `${str} 🌅`;
        if (Math.abs(h - ev.set) < 0.45) return `${str} 🌇`;
        if (h > ev.rise && h < ev.set) return `${str} ☀️`;
        return `${str} 🌙`;
      }
    }
    return str;
  }

  function clampPanelPosition(save = false) {
    if (!panelEl || panelEl.hidden) return;
    const rect = panelEl.getBoundingClientRect();
    const w = rect.width || Math.min(322, window.innerWidth - 16);
    const h = rect.height || 50;

    let left = parseFloat(panelEl.style.left);
    let top = parseFloat(panelEl.style.top);

    if (!isFinite(left) || !isFinite(top)) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_POS_KEY) || 'null');
        if (saved && isFinite(saved.left) && isFinite(saved.top)) {
          left = saved.left;
          top = saved.top;
        }
      } catch (e) {}
    }

    if (!isFinite(left) || !isFinite(top)) {
      if (window.innerWidth < 600) {
        left = Math.round((window.innerWidth - w) / 2);
        top = 58;
      } else {
        left = Math.max(12, window.innerWidth - w - 58);
        top = 56;
      }
    }

    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    const maxTop = Math.max(8, window.innerHeight - h - 8);
    left = clamp(Math.round(left), 8, maxLeft);
    top = clamp(Math.round(top), 8, maxTop);

    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';

    if (save) {
      try { localStorage.setItem(LS_POS_KEY, JSON.stringify({ left, top })); } catch (e) {}
    }
  }

  function buildMarkup() {
    const div = document.createElement('div');
    div.id = 'dem-quick-panel';
    div.className = 'dqp-panel';
    div.hidden = true;

    div.innerHTML = `
      <div class="dqp-header" id="dqp-drag-header" title="Перетащите панель">
        <div class="dqp-title-wrap">
          <span class="dqp-drag-dots">⋮⋮</span>
          <span class="dqp-title" id="dqp-header-title">⛰️ Быстрый рельеф</span>
        </div>
        <div class="dqp-head-actions">
          <button type="button" id="dqp-btn-full" class="dqp-hbtn dqp-hbtn-full" title="Открыть полные настройки">⚙️ Полные</button>
          <button type="button" id="dqp-btn-collapse" class="dqp-hbtn" title="Свернуть / развернуть">▼</button>
          <button type="button" id="dqp-btn-close" class="dqp-hbtn dqp-hbtn-close" title="Закрыть">✕</button>
        </div>
      </div>

      <div class="dqp-mode-bar">
        <div class="dqp-seg" id="dqp-mode-seg">
          <button type="button" class="dqp-seg-btn active" data-mode="relief">⛰️ Рельеф</button>
          <button type="button" class="dqp-seg-btn" data-mode="contours">〰️ Линии</button>
        </div>
        <button type="button" id="dqp-power-btn" class="dqp-power-btn">Вкл</button>
      </div>

      <div class="dqp-body" id="dqp-body">
        <!-- ==================== РЕЖИМ 1: РЕЛЬЕФ ==================== -->
        <div id="dqp-pane-relief" style="display:flex; flex-direction:column; gap:7px;">

          <!-- Базовые параметры (всегда на виду) -->
          <div class="dqp-card">
            <div class="dqp-field" id="dqp-preset-wrap">
              <label for="dqp-preset-select"><span>⭐ Пресет 3D-сцены</span></label>
              <select id="dqp-preset-select" class="styled-select"></select>
            </div>

            <div class="dqp-grid-2">
              <div class="dqp-field">
                <label for="dqp-source-select">Источник DEM</label>
                <select id="dqp-source-select" class="styled-select">
                  <option value="fabdem">FABDEM 30м</option>
                  <option value="copernicus">Copernicus 30м</option>
                  <option value="mapterhorn">Mapterhorn</option>
                  <option value="aws">AWS Terrarium</option>
                </select>
              </div>
              <div class="dqp-field">
                <label for="dqp-blend-select">Смешивание</label>
                <select id="dqp-blend-select" class="styled-select">
                  <option value="normal">Normal</option>
                  <option value="multiply">Multiply</option>
                  <option value="soft-light">Soft-Light</option>
                  <option value="overlay">Overlay</option>
                  <option value="hard-light">Hard-Light</option>
                  <option value="luminosity">Luminosity</option>
                  <option value="screen">Screen</option>
                </select>
              </div>
            </div>

            <div class="dqp-grid-2">
              <div class="dqp-field">
                <label for="dqp-hs-opacity"><span>Прозрачность</span><b id="dqp-hs-opacity-val">95%</b></label>
                <input type="range" id="dqp-hs-opacity" class="styled-range" min="10" max="100" step="5" value="95">
              </div>
              <div class="dqp-field">
                <label for="dqp-zfactor">
                  <span>Высота Z <b id="dqp-zfactor-val">×3.5</b></span>
                  <button type="button" id="dqp-zauto-btn" class="dqp-chip" style="flex:0 0 auto; padding:1px 5px; font-size:9.5px;">Авто</button>
                </label>
                <input type="range" id="dqp-zfactor" class="styled-range" min="1.0" max="10.0" step="0.5" value="3.5">
              </div>
            </div>
          </div>

          <!-- Свет и раскраска -->
          <div class="dqp-card">
            <div class="dqp-field">
              <label for="dqp-sunmode-select">☀️ Режим освещения</label>
              <select id="dqp-sunmode-select" class="styled-select">
                <option value="time">🕒 Время суток (24ч)</option>
                <option value="suncalc">☀️ Реальное Солнце</option>
                <option value="swiss">🇨🇭 Швейцарский (СЗ 315°)</option>
                <option value="manual">📐 Ручные углы и раскраска</option>
              </select>
            </div>

            <!-- Время суток -->
            <div id="dqp-time-block" style="display:flex; flex-direction:column; gap:6px;">
              <div class="dqp-field">
                <label for="dqp-time-slider"><span>Время в точке</span><b id="dqp-time-val">12:00</b></label>
                <input type="range" id="dqp-time-slider" class="styled-range" min="0" max="1440" step="1" value="720">
              </div>
              <div class="dqp-mini-chips">
                <button type="button" class="dqp-chip js-dqp-snap" data-snap="rise">🌅 Восход</button>
                <button type="button" class="dqp-chip js-dqp-snap" data-snap="noon">☀️ Полдень</button>
                <button type="button" class="dqp-chip js-dqp-snap" data-snap="set">🌇 Закат</button>
                <button type="button" class="dqp-chip js-dqp-snap" data-snap="night">🌙 Ночь</button>
              </div>
              <details class="dqp-spoiler">
                <summary class="dqp-spoiler-sum"><span>📅 Дата и сезон</span><span class="dqp-spoiler-chev">▼</span></summary>
                <div class="dqp-spoiler-body">
                  <input type="date" id="dqp-date-input" class="styled-input">
                  <div class="dqp-mini-chips">
                    <button type="button" class="dqp-chip js-dqp-season" data-season="summer">☀️ Лето</button>
                    <button type="button" class="dqp-chip js-dqp-season" data-season="winter">❄️ Зима</button>
                    <button type="button" class="dqp-chip js-dqp-season" data-season="today">Сегодня</button>
                  </div>
                </div>
              </details>
            </div>

            <!-- Ручные углы + полноценная раскраска высот -->
            <div id="dqp-manual-block" style="display:flex; flex-direction:column; gap:6px;" hidden>
              <div class="dqp-grid-2">
                <div class="dqp-field">
                  <label for="dqp-az-slider"><span>Азимут</span><b id="dqp-az-val">215°</b></label>
                  <input type="range" id="dqp-az-slider" class="styled-range" min="0" max="360" step="5" value="215">
                </div>
                <div class="dqp-field">
                  <label for="dqp-alt-slider"><span>Угол</span><b id="dqp-alt-val">50°</b></label>
                  <input type="range" id="dqp-alt-slider" class="styled-range" min="5" max="85" step="5" value="50">
                </div>
              </div>

              <div class="dqp-field">
                <label for="dqp-scale-mode">Шкала высот (раскраска)</label>
                <select id="dqp-scale-mode" class="styled-select">
                  <option value="relative">🔄 По экрану (адаптивная)</option>
                  <option value="fixed">📏 Фиксированная (метры)</option>
                </select>
              </div>

              <div id="dqp-fixed-wrap" style="display:flex; flex-direction:column; gap:5px;" hidden>
                <div class="dqp-grid-2">
                  <div class="dqp-field">
                    <label for="dqp-elev-min">Мин. (м)</label>
                    <input type="number" id="dqp-elev-min" class="styled-input" min="-500" max="8500" step="10" value="0">
                  </div>
                  <div class="dqp-field">
                    <label for="dqp-elev-max">Макс. (м)</label>
                    <input type="number" id="dqp-elev-max" class="styled-input" min="-400" max="9000" step="10" value="1500">
                  </div>
                </div>
                <div class="dqp-mini-chips">
                  <button type="button" class="dqp-chip js-dqp-elev" data-min="0" data-max="300">0–300</button>
                  <button type="button" class="dqp-chip js-dqp-elev" data-min="0" data-max="1000">0–1000</button>
                  <button type="button" class="dqp-chip js-dqp-elev" data-min="0" data-max="2500">0–2500</button>
                  <button type="button" class="dqp-chip" id="dqp-btn-grab-screen" title="Взять мин/макс высоту с текущего экрана">📐 Экран</button>
                </div>
              </div>

              <div class="dqp-grid-4">
                <div class="dqp-field">
                  <label for="dqp-col-valley">Низы</label>
                  <input type="color" id="dqp-col-valley" class="styled-color-picker" value="#a8863e">
                </div>
                <div class="dqp-field">
                  <label for="dqp-col-mid">Склон</label>
                  <input type="color" id="dqp-col-mid" class="styled-color-picker" value="#e8b074">
                </div>
                <div class="dqp-field">
                  <label for="dqp-col-peak">Верх</label>
                  <input type="color" id="dqp-col-peak" class="styled-color-picker" value="#fe1691">
                </div>
                <div class="dqp-field">
                  <label for="dqp-col-shadow">Тень</label>
                  <input type="color" id="dqp-col-shadow" class="styled-color-picker" value="#456327">
                </div>
              </div>

              <div class="dqp-grad-wrap">
                <div class="dqp-grad-bar" id="dqp-grad-bar">
                  <span class="dqp-grad-pin" id="dqp-grad-pin1" style="left:33%;"></span>
                  <span class="dqp-grad-pin" id="dqp-grad-pin2" style="left:68%;"></span>
                </div>
                <div class="dqp-grad-labels">
                  <span id="dqp-grad-min-lbl">0%</span>
                  <span>Градиент высот</span>
                  <span id="dqp-grad-max-lbl">100%</span>
                </div>
              </div>

              <details class="dqp-spoiler">
                <summary class="dqp-spoiler-sum"><span>🎚️ Переходы и плавность градиента</span><span class="dqp-spoiler-chev">▼</span></summary>
                <div class="dqp-spoiler-body">
                  <div class="dqp-grid-2">
                    <div class="dqp-field">
                      <label for="dqp-blend1"><span>Низы → Склон</span><b id="dqp-blend1-val">33%</b></label>
                      <input type="range" id="dqp-blend1" class="styled-range" min="0" max="100" step="1" value="33">
                    </div>
                    <div class="dqp-field">
                      <label for="dqp-soft1"><span>Плавность 1</span><b id="dqp-soft1-val">35%</b></label>
                      <input type="range" id="dqp-soft1" class="styled-range" min="2" max="100" step="2" value="35">
                    </div>
                  </div>
                  <div class="dqp-grid-2">
                    <div class="dqp-field">
                      <label for="dqp-blend2"><span>Склон → Верх</span><b id="dqp-blend2-val">68%</b></label>
                      <input type="range" id="dqp-blend2" class="styled-range" min="0" max="100" step="1" value="68">
                    </div>
                    <div class="dqp-field">
                      <label for="dqp-soft2"><span>Плавность 2</span><b id="dqp-soft2-val">35%</b></label>
                      <input type="range" id="dqp-soft2" class="styled-range" min="2" max="100" step="2" value="35">
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>

          <!-- Вложенный спойлер 1: Тени и точность рельефа -->
          <details class="dqp-spoiler">
            <summary class="dqp-spoiler-sum"><span>🌑 Тени, сглаживание и объём (AO/SVF)</span><span class="dqp-spoiler-chev">▼</span></summary>
            <div class="dqp-spoiler-body">
              <div class="dqp-field">
                <label>Сглаживание DEM</label>
                <div class="dqp-mini-chips" id="dqp-smooth-chips">
                  <button type="button" class="dqp-chip js-dqp-smooth" data-smooth="none">Точный</button>
                  <button type="button" class="dqp-chip js-dqp-smooth" data-smooth="gauss">Гаусс</button>
                  <button type="button" class="dqp-chip js-dqp-smooth" data-smooth="bilateral">Билатер.</button>
                </div>
              </div>

              <label class="dqp-toggle-row">
                <span>🌑 Падающие тени от хребтов</span>
                <input type="checkbox" id="dqp-cast-shadows">
              </label>
              <div id="dqp-shadows-sub" class="dqp-grid-2">
                <div class="dqp-field">
                  <label for="dqp-shadow-reach"><span>Дальность</span><b id="dqp-shadow-reach-val">100%</b></label>
                  <input type="range" id="dqp-shadow-reach" class="styled-range" min="20" max="100" step="10" value="100">
                </div>
                <div class="dqp-field">
                  <label for="dqp-shadow-op"><span>Плотность</span><b id="dqp-shadow-op-val">60%</b></label>
                  <input type="range" id="dqp-shadow-op" class="styled-range" min="10" max="200" step="5" value="60">
                </div>
              </div>

              <label class="dqp-toggle-row">
                <span>🕳️ Затенение оврагов (AO)</span>
                <input type="checkbox" id="dqp-ao-on">
              </label>
              <div class="dqp-field" id="dqp-ao-sub">
                <label for="dqp-ao-str"><span>Сила AO</span><b id="dqp-ao-str-val">100%</b></label>
                <input type="range" id="dqp-ao-str" class="styled-range" min="20" max="250" step="10" value="100">
              </div>

              <label class="dqp-toggle-row">
                <span>🌤️ Купол неба (SVF)</span>
                <input type="checkbox" id="dqp-svf-on">
              </label>
              <div class="dqp-field" id="dqp-svf-sub">
                <label for="dqp-svf-str"><span>Сила SVF</span><b id="dqp-svf-str-val">85%</b></label>
                <input type="range" id="dqp-svf-str" class="styled-range" min="10" max="300" step="5" value="85">
              </div>
            </div>
          </details>

          <!-- Вложенный спойлер 2: Тон, гипсометрия, контраст -->
          <details class="dqp-spoiler">
            <summary class="dqp-spoiler-sum"><span>🎨 Тон, гипсометрия и контраст света</span><span class="dqp-spoiler-chev">▼</span></summary>
            <div class="dqp-spoiler-body">
              <div class="dqp-grid-2">
                <div class="dqp-field">
                  <label for="dqp-tone-select">Цветовой тон</label>
                  <select id="dqp-tone-select" class="styled-select">
                    <option value="none">⚪ Выкл</option>
                    <option value="imhof">🇨🇭 Имхоф</option>
                    <option value="slate">🏔️ Сланец</option>
                    <option value="vintage">📜 Винтаж</option>
                    <option value="amber">🌅 Янтарь</option>
                    <option value="emerald">🌲 Хвоя</option>
                    <option value="monochrome">✒️ Монохром</option>
                    <option value="sandstone">🏜️ Песчаник</option>
                    <option value="glacier">❄️ Ледник</option>
                    <option value="volcano">🌋 Базальт</option>
                  </select>
                </div>
                <div class="dqp-field">
                  <label for="dqp-hypso-select">Гипсометрия</label>
                  <select id="dqp-hypso-select" class="styled-select">
                    <option value="none">Без шкалы</option>
                    <option value="atlas">Атласная</option>
                  </select>
                </div>
              </div>
              <div class="dqp-grid-2">
                <div class="dqp-field">
                  <label for="dqp-light-boost"><span>Подсветка пиков</span><b id="dqp-light-boost-val">×1.0</b></label>
                  <input type="range" id="dqp-light-boost" class="styled-range" min="-2.0" max="5.0" step="0.05" value="1.0">
                </div>
                <div class="dqp-field">
                  <label for="dqp-light-wrap"><span>Мягкость (Wrap)</span><b id="dqp-light-wrap-val">35%</b></label>
                  <input type="range" id="dqp-light-wrap" class="styled-range" min="0" max="120" step="5" value="35">
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- ==================== РЕЖИМ 2: ГОРИЗОНТАЛИ ==================== -->
        <div id="dqp-pane-contours" style="display:flex; flex-direction:column; gap:7px;" hidden>

          <!-- Базовые параметры (всегда на виду) -->
          <div class="dqp-card">
            <div class="dqp-grid-2">
              <div class="dqp-field">
                <label for="dqp-ct-step">Шаг высот</label>
                <select id="dqp-ct-step" class="styled-select">
                  <option value="auto">⚡ Авто</option>
                  <option value="5">5 м</option>
                  <option value="10">10 м</option>
                  <option value="20">20 м</option>
                  <option value="25">25 м</option>
                  <option value="50">50 м</option>
                  <option value="100">100 м</option>
                </select>
              </div>
              <div class="dqp-field">
                <label for="dqp-ct-blend">Смешивание</label>
                <select id="dqp-ct-blend" class="styled-select">
                  <option value="normal">Normal</option>
                  <option value="multiply">Multiply</option>
                  <option value="overlay">Overlay</option>
                  <option value="soft-light">Soft-Light</option>
                  <option value="hard-light">Hard-Light</option>
                  <option value="luminosity">Luminosity</option>
                  <option value="screen">Screen</option>
                </select>
              </div>
            </div>

            <div class="dqp-grid-2">
              <div class="dqp-field">
                <label for="dqp-ct-width"><span>Толщина</span><b id="dqp-ct-width-val">1.5 px</b></label>
                <input type="range" id="dqp-ct-width" class="styled-range" min="0.5" max="5.0" step="0.1" value="1.5">
              </div>
              <div class="dqp-field">
                <label for="dqp-ct-opacity"><span>Яркость</span><b id="dqp-ct-opacity-val">85%</b></label>
                <input type="range" id="dqp-ct-opacity" class="styled-range" min="20" max="100" step="5" value="85">
              </div>
            </div>

            <div class="dqp-grid-2">
              <div class="dqp-field">
                <label for="dqp-ct-style">Стиль линий</label>
                <select id="dqp-ct-style" class="styled-select">
                  <option value="standard">Обычные</option>
                  <option value="tanaka">🏯 Танаки (3D)</option>
                </select>
              </div>
              <div class="dqp-field">
                <label for="dqp-ct-palette">Цвет линий</label>
                <div style="display:flex; gap:4px; align-items:center;">
                  <select id="dqp-ct-palette" class="styled-select" style="flex:1;">
                    <option value="sepia">Сепия</option>
                    <option value="custom">Свой</option>
                  </select>
                  <input type="color" id="dqp-ct-color" class="styled-color-picker" style="width:32px; flex:0 0 32px;" value="#47370a">
                </div>
              </div>
            </div>
          </div>

          <!-- Вложенный спойлер 1: Метки высот (подписи) -->
          <details class="dqp-spoiler">
            <summary class="dqp-spoiler-sum"><span>🏷️ Подписи высот на линиях</span><span class="dqp-spoiler-chev">▼</span></summary>
            <div class="dqp-spoiler-body">
              <label class="dqp-toggle-row">
                <span>Показывать отметки высоты</span>
                <input type="checkbox" id="dqp-lbl-on">
              </label>

              <div id="dqp-lbl-sub" style="display:flex; flex-direction:column; gap:6px;">
                <div class="dqp-grid-2">
                  <div class="dqp-field">
                    <label for="dqp-lbl-scope">Какие подписывать</label>
                    <select id="dqp-lbl-scope" class="styled-select">
                      <option value="auto">⚡ Умно</option>
                      <option value="major">〰️ Основные (×5)</option>
                      <option value="all">📏 Все основные</option>
                      <option value="all_form">📐 С полушагами</option>
                    </select>
                  </div>
                  <div class="dqp-field">
                    <label for="dqp-lbl-orient">Ориентация</label>
                    <select id="dqp-lbl-orient" class="styled-select">
                      <option value="readable">📖 Читаемая</option>
                      <option value="uphill">⛰️ К вершине</option>
                      <option value="horizontal">― Горизонт.</option>
                    </select>
                  </div>
                </div>

                <div class="dqp-grid-2">
                  <div class="dqp-field">
                    <label for="dqp-lbl-density"><span>Плотность</span><b id="dqp-lbl-density-val">100%</b></label>
                    <input type="range" id="dqp-lbl-density" class="styled-range" min="25" max="250" step="5" value="100">
                  </div>
                  <div class="dqp-field">
                    <label for="dqp-lbl-size"><span>Шрифт</span><b id="dqp-lbl-size-val">9.5 px</b></label>
                    <input type="range" id="dqp-lbl-size" class="styled-range" min="7.5" max="16.0" step="0.5" value="9.5">
                  </div>
                </div>

                <div class="dqp-grid-2">
                  <div class="dqp-field">
                    <label for="dqp-lbl-style">Оформление</label>
                    <select id="dqp-lbl-style" class="styled-select">
                      <option value="halo">Ореол</option>
                      <option value="break">Разрыв</option>
                      <option value="pill">Плашка</option>
                    </select>
                  </div>
                  <div class="dqp-field">
                    <label for="dqp-lbl-colmode">Цвет цифр</label>
                    <div style="display:flex; gap:4px; align-items:center;">
                      <select id="dqp-lbl-colmode" class="styled-select" style="flex:1;">
                        <option value="auto">Как линия</option>
                        <option value="custom">Свой</option>
                      </select>
                      <input type="color" id="dqp-lbl-col" class="styled-color-picker" style="width:28px; flex:0 0 28px;" value="#3a250b">
                    </div>
                  </div>
                </div>

                <div class="dqp-grid-2">
                  <label class="dqp-toggle-row">
                    <span>Разрыв линии</span>
                    <input type="checkbox" id="dqp-lbl-break">
                  </label>
                  <label class="dqp-toggle-row">
                    <span>Дописать «м»</span>
                    <input type="checkbox" id="dqp-lbl-unit">
                  </label>
                </div>
              </div>
            </div>
          </details>

          <!-- Вложенный спойлер 2: Точность, полушаги и сглаживание -->
          <details class="dqp-spoiler">
            <summary class="dqp-spoiler-sum"><span>📐 Полушаги, сглаживание и толщина</span><span class="dqp-spoiler-chev">▼</span></summary>
            <div class="dqp-spoiler-body">
              <div class="dqp-field">
                <label for="dqp-ct-smooth">Сглаживание геометрии</label>
                <select id="dqp-ct-smooth" class="styled-select">
                  <option value="chaikin">Плавное (Чайкин)</option>
                  <option value="raw">Прямые сегменты</option>
                </select>
              </div>
              <label class="dqp-toggle-row">
                <span>Полугоризонтали (0.5 шага на равнинах)</span>
                <input type="checkbox" id="dqp-ct-formlines">
              </label>
              <label class="dqp-toggle-row">
                <span>Волосяные линии на крутых обрывах</span>
                <input type="checkbox" id="dqp-ct-cliff">
              </label>
              <label class="dqp-toggle-row">
                <span>Утоньшение линий по высоте</span>
                <input type="checkbox" id="dqp-ct-taper">
              </label>
              <div id="dqp-taper-sub" class="dqp-grid-2">
                <div class="dqp-field">
                  <select id="dqp-ct-taper-dir" class="styled-select">
                    <option value="crests">Тоньше к пикам</option>
                    <option value="valleys">Тоньше в низинах</option>
                  </select>
                </div>
                <div class="dqp-field">
                  <label for="dqp-ct-taper-str"><span>Сила</span><b id="dqp-ct-taper-str-val">60%</b></label>
                  <input type="range" id="dqp-ct-taper-str" class="styled-range" min="10" max="200" step="5" value="60">
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div class="dqp-footer">
        <button type="button" id="dqp-btn-refresh" class="btn btn-secondary" title="Догрузить рельеф для экрана">🔄 Обновить</button>
        <button type="button" id="dqp-btn-full-footer" class="btn btn-primary">⚙️ Полные настройки</button>
      </div>
    `;

    document.body.appendChild(div);
    panelEl = div;
    bindEvents();
  }

  function updateManualGradientBar(cfg) {
    const bar = document.getElementById('dqp-grad-bar');
    if (!bar) return;

    const cV = hexToVec3(cfg.manualValleyColor || '#a8863e');
    const cM = hexToVec3(cfg.manualMidColor || '#e8b074');
    const cP = hexToVec3(cfg.manualPeakColor || '#fe1691');

    const b1 = cfg.manualLightBlend !== undefined ? cfg.manualLightBlend : 0.33;
    const hw1 = Math.max(0.01, (cfg.manualLightSoftness !== undefined ? cfg.manualLightSoftness : 0.35) * 0.5);
    const b2 = Math.max(b1, cfg.manualLightBlend2 !== undefined ? cfg.manualLightBlend2 : 0.68);
    const hw2 = Math.max(0.01, (cfg.manualLightSoftness2 !== undefined ? cfg.manualLightSoftness2 : 0.35) * 0.5);

    const stops = [];
    for (let i = 0; i <= 20; i++) {
      const h = i / 20;
      const t1 = smoothstep(b1 - hw1, b1 + hw1, h);
      const t2 = smoothstep(b2 - hw2, b2 + hw2, h);
      const col = lerpVec3(lerpVec3(cV, cM, t1), cP, t2);
      stops.push(`rgb(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)}) ${i * 5}%`);
    }
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;

    const pin1 = document.getElementById('dqp-grad-pin1');
    const pin2 = document.getElementById('dqp-grad-pin2');
    if (pin1) pin1.style.left = Math.round(b1 * 100) + '%';
    if (pin2) pin2.style.left = Math.round(b2 * 100) + '%';

    const minLbl = document.getElementById('dqp-grad-min-lbl');
    const maxLbl = document.getElementById('dqp-grad-max-lbl');
    const isFixed = cfg.manualScaleMode === 'fixed';
    const minM = cfg.manualElevMin !== undefined ? Number(cfg.manualElevMin) : 0;
    const maxM = Math.max(minM + 1, cfg.manualElevMax !== undefined ? Number(cfg.manualElevMax) : 1500);
    if (minLbl) minLbl.textContent = isFixed ? `${Math.round(minM)} м` : 'Низ (0%)';
    if (maxLbl) maxLbl.textContent = isFixed ? `${Math.round(maxM)} м` : 'Верх (100%)';
  }

  function syncUI() {
    if (!panelEl || !isOpen || !WM.demRelief) return;
    const cfg = WM.demRelief.getConfig();
    const $ = id => document.getElementById(id);

    panelEl.classList.toggle('dqp-collapsed', isCollapsed);
    const colBtn = $('dqp-btn-collapse');
    if (colBtn) colBtn.textContent = isCollapsed ? '▲' : '▼';

    const titleEl = $('dqp-header-title');
    if (titleEl) {
      titleEl.textContent = currentMode === 'contours' ? '〰️ Горизонтали (DEM)' : '⛰️ 3D Рельеф';
    }

    panelEl.querySelectorAll('#dqp-mode-seg .dqp-seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });

    const isActive = currentMode === 'contours' ? !!cfg.contoursEnabled : !!cfg.hillshadeEnabled;
    const pwrBtn = $('dqp-power-btn');
    if (pwrBtn) {
      pwrBtn.textContent = isActive ? 'Включён' : 'Выключен';
      pwrBtn.classList.toggle('active', isActive);
    }

    $('dqp-pane-relief').hidden = (currentMode !== 'relief');
    $('dqp-pane-contours').hidden = (currentMode !== 'contours');

    if (currentMode === 'relief') {
      // Пресеты
      const presetWrap = $('dqp-preset-wrap');
      const presetSel = $('dqp-preset-select');
      if (presetWrap && presetSel) {
        if (WM.demPresets && WM.demPresets.getAllPresets) {
          presetWrap.hidden = false;
          const presets = WM.demPresets.getAllPresets();
          const activeId = localStorage.getItem('wm_active_3d_preset') || '';
          presetSel.innerHTML = '<option value="">(Пользовательские)</option>';
          presets.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name || p.id;
            if (p.id === activeId) opt.selected = true;
            presetSel.appendChild(opt);
          });
        } else {
          presetWrap.hidden = true;
        }
      }

      if ($('dqp-source-select')) $('dqp-source-select').value = cfg.demSource || 'fabdem';
      if ($('dqp-blend-select')) $('dqp-blend-select').value = cfg.blendMode || 'normal';

      const opPct = Math.round((cfg.hillshadeOpacity ?? 0.95) * 100);
      if ($('dqp-hs-opacity')) $('dqp-hs-opacity').value = opPct;
      if ($('dqp-hs-opacity-val')) $('dqp-hs-opacity-val').textContent = opPct + '%';

      const zAuto = !!cfg.zFactorAuto;
      if ($('dqp-zauto-btn')) $('dqp-zauto-btn').classList.toggle('active', zAuto);
      if ($('dqp-zfactor')) {
        $('dqp-zfactor').disabled = zAuto;
        $('dqp-zfactor').value = cfg.zFactor || 3.5;
      }
      if ($('dqp-zfactor-val')) {
        $('dqp-zfactor-val').textContent = zAuto ? 'Авто' : '×' + parseFloat(cfg.zFactor || 3.5).toFixed(1);
      }

      const sunMode = cfg.sunMode || 'time';
      if ($('dqp-sunmode-select')) $('dqp-sunmode-select').value = sunMode;
      $('dqp-time-block').hidden = (sunMode !== 'time');
      $('dqp-manual-block').hidden = (sunMode !== 'manual');

      if (sunMode === 'time') {
        const curH = cfg.manualTimeHour !== undefined ? cfg.manualTimeHour : 12;
        const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
        const tSlider = $('dqp-time-slider');
        if (tSlider) {
          const want = WM.timeWarp
            ? WM.timeWarp.hourToSlider(curH, c.lat, c.lng, new Date())
            : Math.round(curH * 60);
          if (document.activeElement !== tSlider) tSlider.value = want;
        }
        if ($('dqp-time-val')) $('dqp-time-val').textContent = fmtHour(curH, c.lat, c.lng);

        if ($('dqp-date-input')) {
          if (cfg.manualDateStr) {
            $('dqp-date-input').value = cfg.manualDateStr;
          } else {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            $('dqp-date-input').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          }
        }
      } else if (sunMode === 'manual') {
        const az = cfg.sunAzimuth ?? 215;
        const alt = cfg.sunAltitude ?? 50;
        if ($('dqp-az-slider')) $('dqp-az-slider').value = az;
        if ($('dqp-az-val')) $('dqp-az-val').textContent = az + '°';
        if ($('dqp-alt-slider')) $('dqp-alt-slider').value = alt;
        if ($('dqp-alt-val')) $('dqp-alt-val').textContent = alt + '°';

        const sMode = cfg.manualScaleMode || 'relative';
        if ($('dqp-scale-mode')) $('dqp-scale-mode').value = sMode;
        $('dqp-fixed-wrap').hidden = (sMode !== 'fixed');

        const minM = cfg.manualElevMin !== undefined ? Number(cfg.manualElevMin) : 0;
        const maxM = Math.max(minM + 1, cfg.manualElevMax !== undefined ? Number(cfg.manualElevMax) : 1500);
        if ($('dqp-elev-min') && document.activeElement !== $('dqp-elev-min')) $('dqp-elev-min').value = minM;
        if ($('dqp-elev-max') && document.activeElement !== $('dqp-elev-max')) $('dqp-elev-max').value = maxM;

        panelEl.querySelectorAll('.js-dqp-elev').forEach(ch => {
          ch.classList.toggle('active', sMode === 'fixed' && minM === +ch.dataset.min && maxM === +ch.dataset.max);
        });

        if ($('dqp-col-valley')) $('dqp-col-valley').value = cfg.manualValleyColor || '#a8863e';
        if ($('dqp-col-mid')) $('dqp-col-mid').value = cfg.manualMidColor || '#e8b074';
        if ($('dqp-col-peak')) $('dqp-col-peak').value = cfg.manualPeakColor || '#fe1691';
        if ($('dqp-col-shadow')) $('dqp-col-shadow').value = cfg.manualShadowColor || '#456327';

        const b1 = Math.round((cfg.manualLightBlend ?? 0.33) * 100);
        const s1 = Math.round((cfg.manualLightSoftness ?? 0.35) * 100);
        const b2 = Math.round((cfg.manualLightBlend2 ?? 0.68) * 100);
        const s2 = Math.round((cfg.manualLightSoftness2 ?? 0.35) * 100);
        if ($('dqp-blend1')) $('dqp-blend1').value = b1;
        if ($('dqp-blend1-val')) $('dqp-blend1-val').textContent = b1 + '%';
        if ($('dqp-soft1')) $('dqp-soft1').value = s1;
        if ($('dqp-soft1-val')) $('dqp-soft1-val').textContent = s1 + '%';
        if ($('dqp-blend2')) $('dqp-blend2').value = b2;
        if ($('dqp-blend2-val')) $('dqp-blend2-val').textContent = b2 + '%';
        if ($('dqp-soft2')) $('dqp-soft2').value = s2;
        if ($('dqp-soft2-val')) $('dqp-soft2-val').textContent = s2 + '%';

        updateManualGradientBar(cfg);
      }

      // Спойлер 1: Тени, сглаживание, AO/SVF
      panelEl.querySelectorAll('.js-dqp-smooth').forEach(b => {
        b.classList.toggle('active', b.dataset.smooth === (cfg.smoothMode || 'gauss'));
      });
      const shOn = !!cfg.castShadows;
      if ($('dqp-cast-shadows')) $('dqp-cast-shadows').checked = shOn;
      $('dqp-shadows-sub').classList.toggle('dqp-dimmed', !shOn);
      const rch = Math.round((cfg.shadowReach ?? 1.0) * 100);
      const sop = Math.round((cfg.shadowOpacity ?? 0.6) * 100);
      if ($('dqp-shadow-reach')) $('dqp-shadow-reach').value = rch;
      if ($('dqp-shadow-reach-val')) $('dqp-shadow-reach-val').textContent = rch + '%';
      if ($('dqp-shadow-op')) $('dqp-shadow-op').value = sop;
      if ($('dqp-shadow-op-val')) $('dqp-shadow-op-val').textContent = sop + '%';

      const aoOn = !!cfg.ambientOcclusion;
      if ($('dqp-ao-on')) $('dqp-ao-on').checked = aoOn;
      $('dqp-ao-sub').classList.toggle('dqp-dimmed', !aoOn);
      const aoStr = Math.round((cfg.aoStrength ?? 1.0) * 100);
      if ($('dqp-ao-str')) $('dqp-ao-str').value = aoStr;
      if ($('dqp-ao-str-val')) $('dqp-ao-str-val').textContent = aoStr + '%';

      const svfOn = cfg.svfEnabled !== false;
      if ($('dqp-svf-on')) $('dqp-svf-on').checked = svfOn;
      $('dqp-svf-sub').classList.toggle('dqp-dimmed', !svfOn);
      const svfStr = Math.round((cfg.svfStrength ?? 0.85) * 100);
      if ($('dqp-svf-str')) $('dqp-svf-str').value = svfStr;
      if ($('dqp-svf-str-val')) $('dqp-svf-str-val').textContent = svfStr + '%';

      // Спойлер 2: Тон, гипсометрия, контраст
      if ($('dqp-tone-select')) $('dqp-tone-select').value = cfg.colorTone || 'none';
      if ($('dqp-hypso-select')) $('dqp-hypso-select').value = cfg.hypsoMode || 'none';
      const lb = cfg.lightBoost ?? 1.0;
      if ($('dqp-light-boost')) $('dqp-light-boost').value = lb;
      if ($('dqp-light-boost-val')) $('dqp-light-boost-val').textContent = '×' + parseFloat(lb).toFixed(2);
      const lw = Math.round((cfg.lightWrap ?? 0.35) * 100);
      if ($('dqp-light-wrap')) $('dqp-light-wrap').value = lw;
      if ($('dqp-light-wrap-val')) $('dqp-light-wrap-val').textContent = lw + '%';

    } else {
      // Режим 2: Горизонтали
      if ($('dqp-ct-step')) $('dqp-ct-step').value = cfg.contourStep || 'auto';
      if ($('dqp-ct-blend')) $('dqp-ct-blend').value = cfg.contourBlendMode || 'normal';

      const cw = cfg.contourWidth || 1.5;
      if ($('dqp-ct-width')) $('dqp-ct-width').value = cw;
      if ($('dqp-ct-width-val')) $('dqp-ct-width-val').textContent = parseFloat(cw).toFixed(1) + ' px';

      const cop = Math.round((cfg.contourOpacity ?? 0.85) * 100);
      if ($('dqp-ct-opacity')) $('dqp-ct-opacity').value = cop;
      if ($('dqp-ct-opacity-val')) $('dqp-ct-opacity-val').textContent = cop + '%';

      if ($('dqp-ct-style')) $('dqp-ct-style').value = cfg.contourStyle || 'standard';
      const pal = cfg.contourPalette || 'sepia';
      if ($('dqp-ct-palette')) $('dqp-ct-palette').value = pal;
      if ($('dqp-ct-color')) {
        $('dqp-ct-color').value = cfg.contourColor || '#47370a';
        $('dqp-ct-color').hidden = (pal !== 'custom');
      }

      // Спойлер 1: Подписи
      const lblOn = cfg.showLabels !== false;
      if ($('dqp-lbl-on')) $('dqp-lbl-on').checked = lblOn;
      $('dqp-lbl-sub').classList.toggle('dqp-dimmed', !lblOn);
      if ($('dqp-lbl-scope')) $('dqp-lbl-scope').value = cfg.contourLabelScope || 'auto';
      if ($('dqp-lbl-orient')) $('dqp-lbl-orient').value = cfg.contourLabelOrient || 'readable';
      const ld = Math.round((cfg.contourLabelDensity ?? 1.0) * 100);
      if ($('dqp-lbl-density')) $('dqp-lbl-density').value = ld;
      if ($('dqp-lbl-density-val')) $('dqp-lbl-density-val').textContent = ld + '%';
      const ls = cfg.contourLabelSize ?? 9.5;
      if ($('dqp-lbl-size')) $('dqp-lbl-size').value = ls;
      if ($('dqp-lbl-size-val')) $('dqp-lbl-size-val').textContent = parseFloat(ls).toFixed(1) + ' px';
      if ($('dqp-lbl-style')) $('dqp-lbl-style').value = cfg.contourLabelStyle || 'halo';
      const cm = cfg.contourLabelColorMode || 'auto';
      if ($('dqp-lbl-colmode')) $('dqp-lbl-colmode').value = cm;
      if ($('dqp-lbl-col')) {
        $('dqp-lbl-col').value = cfg.contourLabelColor || '#3a250b';
        $('dqp-lbl-col').hidden = (cm !== 'custom');
      }
      if ($('dqp-lbl-break')) $('dqp-lbl-break').checked = cfg.contourLabelBreak !== false;
      if ($('dqp-lbl-unit')) $('dqp-lbl-unit').checked = !!cfg.contourLabelUnit;

      // Спойлер 2: Геометрия
      if ($('dqp-ct-smooth')) $('dqp-ct-smooth').value = cfg.contourSmoothing || 'chaikin';
      if ($('dqp-ct-formlines')) $('dqp-ct-formlines').checked = cfg.formLinesEnabled !== false;
      if ($('dqp-ct-cliff')) $('dqp-ct-cliff').checked = cfg.cliffHairlines !== false;
      const tapOn = !!cfg.taperWithElevation;
      if ($('dqp-ct-taper')) $('dqp-ct-taper').checked = tapOn;
      $('dqp-taper-sub').classList.toggle('dqp-dimmed', !tapOn);
      if ($('dqp-ct-taper-dir')) $('dqp-ct-taper-dir').value = cfg.taperDirection || 'crests';
      const tStr = Math.round((cfg.taperStrength ?? 0.6) * 100);
      if ($('dqp-ct-taper-str')) $('dqp-ct-taper-str').value = tStr;
      if ($('dqp-ct-taper-str-val')) $('dqp-ct-taper-str-val').textContent = tStr + '%';
    }
  }

  function scheduleSyncUI() {
    if (!isOpen || uiSyncRaf) return;
    uiSyncRaf = requestAnimationFrame(() => {
      uiSyncRaf = 0;
      syncUI();
    });
  }

  function setCfg(patch, redrawUI = false) {
    if (!WM.demRelief) return;
    WM.demRelief.setConfig({ ...patch, _skipHud: true });
    if (redrawUI) scheduleSyncUI();
  }

  function toggleActiveLayer() {
    if (!WM.demRelief) return;
    const cfg = WM.demRelief.getConfig();
    if (currentMode === 'contours') {
      const next = !cfg.contoursEnabled;
      WM.demRelief.setConfig({ contoursEnabled: next });
      WM.demRelief.applyLayerVisibility();
      WM.demRelief.flush();
      const chk = document.getElementById('toggle-dem-contours');
      if (chk) chk.checked = next;
    } else {
      const next = !cfg.hillshadeEnabled;
      WM.demRelief.setConfig({ hillshadeEnabled: next });
      WM.demRelief.applyLayerVisibility();
      WM.demRelief.flush();
      const chk = document.getElementById('toggle-dem-hillshade');
      if (chk) chk.checked = next;
    }
    syncUI();
  }

  function openFullSettings() {
    const targetTab = currentMode === 'contours' ? 'terrain' : 'light';
    const targetSpoiler = currentMode === 'contours' ? 'spoiler-hud-contours' : null;
    close(true);
    setTimeout(() => {
      if (WM.demRelief && WM.demRelief.openHud) {
        WM.demRelief.openHud(targetTab, targetSpoiler);
      }
    }, 55);
  }

  function bindEvents() {
    const $ = id => document.getElementById(id);

    // Запрет всплытия событий к карте Leaflet
    ['mousedown', 'touchstart', 'wheel', 'dblclick'].forEach(ev => {
      panelEl.addEventListener(ev, e => e.stopPropagation(), { passive: ev === 'wheel' || ev === 'touchstart' });
    });

    // Перетаскивание окна за шапку (Pointer Events — работает на ПК и смартфонах)
    const header = $('dqp-drag-header');
    let dragState = null;

    header.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('button, select, input, a')) return;
      const rect = panelEl.getBoundingClientRect();
      dragState = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origL: rect.left,
        origT: rect.top,
        w: rect.width,
        h: rect.height
      };
      if (header.setPointerCapture) {
        try { header.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
    });

    const onDragMove = (e) => {
      if (!dragState || (e.pointerId !== undefined && e.pointerId !== dragState.id)) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const maxL = Math.max(8, window.innerWidth - dragState.w - 8);
      const maxT = Math.max(8, window.innerHeight - dragState.h - 8);
      panelEl.style.left = clamp(Math.round(dragState.origL + dx), 8, maxL) + 'px';
      panelEl.style.top = clamp(Math.round(dragState.origT + dy), 8, maxT) + 'px';
    };

    const onDragEnd = (e) => {
      if (!dragState) return;
      dragState = null;
      clampPanelPosition(true);
    };

    header.addEventListener('pointermove', onDragMove);
    header.addEventListener('pointerup', onDragEnd);
    header.addEventListener('pointercancel', onDragEnd);

    // Ресайз окна / поворот смартфона
    window.addEventListener('resize', () => clampPanelPosition(false));
    window.addEventListener('orientationchange', () => setTimeout(() => clampPanelPosition(false), 150));

    // Переключение спойлеров может менять высоту — поджимаем в экран
    panelEl.addEventListener('toggle', () => requestAnimationFrame(() => clampPanelPosition(false)), true);

    // Кнопки шапки и подвала
    $('dqp-btn-close').onclick = () => close(true);
    $('dqp-btn-collapse').onclick = () => {
      isCollapsed = !isCollapsed;
      try { localStorage.setItem(LS_COLLAPSED_KEY, isCollapsed ? 'true' : 'false'); } catch (e) {}
      syncUI();
      requestAnimationFrame(() => clampPanelPosition(true));
    };
    $('dqp-btn-full').onclick = openFullSettings;
    $('dqp-btn-full-footer').onclick = openFullSettings;

    $('dqp-btn-refresh').onclick = async () => {
      const btn = $('dqp-btn-refresh');
      btn.disabled = true;
      try {
        if (WM.demRelief && WM.demRelief.reloadMissingTiles) {
          await WM.demRelief.reloadMissingTiles({ force: true });
        }
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('🔄 Рельеф обновлён');
      } finally {
        btn.disabled = false;
      }
    };

    // Переключатель режима Рельеф / Линии
    panelEl.querySelectorAll('#dqp-mode-seg .dqp-seg-btn').forEach(btn => {
      btn.onclick = () => {
        currentMode = btn.dataset.mode;
        syncUI();
        requestAnimationFrame(() => clampPanelPosition(false));
      };
    });

    $('dqp-power-btn').onclick = toggleActiveLayer;

    // --- Слушатели режима РЕЛЬЕФ ---
    $('dqp-preset-select').onchange = (e) => {
      const id = e.target.value;
      if (!id) {
        try { localStorage.removeItem('wm_active_3d_preset'); } catch (err) {}
        return;
      }
      const preset = WM.demPresets?.getAllPresets?.().find(p => p.id === id);
      if (preset) {
        WM.demPresets.applyProfile(preset);
        syncUI();
      }
    };

    $('dqp-source-select').onchange = e => setCfg({ demSource: e.target.value }, true);
    $('dqp-blend-select').onchange = e => setCfg({ blendMode: e.target.value });

    $('dqp-hs-opacity').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-hs-opacity-val').textContent = v + '%';
      setCfg({ hillshadeOpacity: v / 100 });
    };

    $('dqp-zauto-btn').onclick = () => {
      const cur = WM.demRelief.getConfig();
      setCfg({ zFactorAuto: !cur.zFactorAuto }, true);
    };

    $('dqp-zfactor').oninput = e => {
      const v = parseFloat(e.target.value);
      $('dqp-zfactor-val').textContent = '×' + v.toFixed(1);
      setCfg({ zFactor: v, zFactorAuto: false });
      $('dqp-zauto-btn').classList.remove('active');
    };

    $('dqp-sunmode-select').onchange = e => {
      setCfg({ sunMode: e.target.value }, true);
      requestAnimationFrame(() => clampPanelPosition(false));
    };

    // Время суток
    $('dqp-time-slider').oninput = e => {
      const sv = parseFloat(e.target.value);
      const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
      const h = WM.timeWarp ? WM.timeWarp.sliderToHour(sv, c.lat, c.lng, new Date()) : (sv / 60);
      $('dqp-time-val').textContent = fmtHour(h, c.lat, c.lng);
      setCfg({ manualTimeHour: h, sunMode: 'time' });
    };

    panelEl.querySelectorAll('.js-dqp-snap').forEach(btn => {
      btn.onclick = () => {
        const c = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.62 };
        const ev = WM.timeWarp ? WM.timeWarp.getSunEvents(c.lat, c.lng, new Date()) : { valid: false };
        let h = 12;
        if (btn.dataset.snap === 'rise') h = ev.valid ? ev.rise : 6;
        else if (btn.dataset.snap === 'noon') h = 12;
        else if (btn.dataset.snap === 'set') h = ev.valid ? ev.set : 18;
        else if (btn.dataset.snap === 'night') h = 0;
        setCfg({ manualTimeHour: h, sunMode: 'time' }, true);
      };
    });

    $('dqp-date-input').onchange = e => setCfg({ manualDateStr: e.target.value, sunMode: 'time' }, true);
    panelEl.querySelectorAll('.js-dqp-season').forEach(btn => {
      btn.onclick = () => {
        const y = new Date().getFullYear();
        let dStr = '';
        if (btn.dataset.season === 'summer') dStr = `${y}-06-22`;
        else if (btn.dataset.season === 'winter') dStr = `${y}-12-22`;
        else {
          const d = new Date();
          const pad = n => String(n).padStart(2, '0');
          dStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
        setCfg({ manualDateStr: dStr, sunMode: 'time' }, true);
      };
    });

    // Ручные углы и раскраска
    $('dqp-az-slider').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-az-val').textContent = v + '°';
      setCfg({ sunAzimuth: v, sunMode: 'manual' });
    };
    $('dqp-alt-slider').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-alt-val').textContent = v + '°';
      setCfg({ sunAltitude: v, sunMode: 'manual' });
    };
    $('dqp-scale-mode').onchange = e => {
      setCfg({ manualScaleMode: e.target.value, sunMode: 'manual' }, true);
      requestAnimationFrame(() => clampPanelPosition(false));
    };

    const applyElevInputs = () => {
      let minV = parseFloat($('dqp-elev-min').value);
      let maxV = parseFloat($('dqp-elev-max').value);
      if (isNaN(minV)) minV = 0;
      if (isNaN(maxV) || maxV <= minV) maxV = minV + 10;
      setCfg({ manualScaleMode: 'fixed', manualElevMin: minV, manualElevMax: maxV, sunMode: 'manual' });
      updateManualGradientBar(WM.demRelief.getConfig());
    };
    $('dqp-elev-min').oninput = applyElevInputs;
    $('dqp-elev-max').oninput = applyElevInputs;

    panelEl.querySelectorAll('.js-dqp-elev').forEach(btn => {
      btn.onclick = () => {
        setCfg({
          manualScaleMode: 'fixed',
          manualElevMin: parseFloat(btn.dataset.min),
          manualElevMax: parseFloat(btn.dataset.max),
          sunMode: 'manual'
        }, true);
      };
    });

    $('dqp-btn-grab-screen').onclick = () => {
      if (!WM.map || !WM.demRelief || !WM.demRelief.getElevation) return;
      const b = WM.map.getBounds();
      const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
      let minV = Infinity, maxV = -Infinity;
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const val = WM.demRelief.getElevation(s + (n - s) * (i / 8), w + (e - w) * (j / 8));
          if (val !== null && isFinite(val)) {
            if (val < minV) minV = val;
            if (val > maxV) maxV = val;
          }
        }
      }
      if (minV === Infinity) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Высоты на экране ещё не загружены');
        return;
      }
      const floorMin = Math.floor(minV);
      const ceilMax = Math.max(floorMin + 10, Math.ceil(maxV));
      setCfg({ manualScaleMode: 'fixed', manualElevMin: floorMin, manualElevMax: ceilMax, sunMode: 'manual' }, true);
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📐 Диапазон с экрана: ${floorMin}…${ceilMax} м`);
    };

    const bindCol = (id, prop) => {
      $(id).oninput = e => {
        setCfg({ [prop]: e.target.value, sunMode: 'manual' });
        updateManualGradientBar(WM.demRelief.getConfig());
      };
    };
    bindCol('dqp-col-valley', 'manualValleyColor');
    bindCol('dqp-col-mid', 'manualMidColor');
    bindCol('dqp-col-peak', 'manualPeakColor');
    bindCol('dqp-col-shadow', 'manualShadowColor');

    $('dqp-blend1').oninput = e => {
      const v = parseInt(e.target.value, 10);
      const cur = WM.demRelief.getConfig();
      const patch = { manualLightBlend: v / 100 };
      if ((cur.manualLightBlend2 ?? 0.68) < patch.manualLightBlend) {
        patch.manualLightBlend2 = patch.manualLightBlend;
        $('dqp-blend2').value = v;
        $('dqp-blend2-val').textContent = v + '%';
      }
      $('dqp-blend1-val').textContent = v + '%';
      setCfg(patch);
      updateManualGradientBar(WM.demRelief.getConfig());
    };
    $('dqp-soft1').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-soft1-val').textContent = v + '%';
      setCfg({ manualLightSoftness: v / 100 });
      updateManualGradientBar(WM.demRelief.getConfig());
    };
    $('dqp-blend2').oninput = e => {
      const v = parseInt(e.target.value, 10);
      const cur = WM.demRelief.getConfig();
      const patch = { manualLightBlend2: v / 100 };
      if ((cur.manualLightBlend ?? 0.33) > patch.manualLightBlend2) {
        patch.manualLightBlend = patch.manualLightBlend2;
        $('dqp-blend1').value = v;
        $('dqp-blend1-val').textContent = v + '%';
      }
      $('dqp-blend2-val').textContent = v + '%';
      setCfg(patch);
      updateManualGradientBar(WM.demRelief.getConfig());
    };
    $('dqp-soft2').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-soft2-val').textContent = v + '%';
      setCfg({ manualLightSoftness2: v / 100 });
      updateManualGradientBar(WM.demRelief.getConfig());
    };

    // Спойлеры рельефа
    panelEl.querySelectorAll('.js-dqp-smooth').forEach(btn => {
      btn.onclick = () => setCfg({ smoothMode: btn.dataset.smooth }, true);
    });
    $('dqp-cast-shadows').onchange = e => {
      setCfg({ castShadows: e.target.checked }, true);
    };
    $('dqp-shadow-reach').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-shadow-reach-val').textContent = v + '%';
      setCfg({ shadowReach: v / 100 });
    };
    $('dqp-shadow-op').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-shadow-op-val').textContent = v + '%';
      setCfg({ shadowOpacity: v / 100 });
    };
    $('dqp-ao-on').onchange = e => setCfg({ ambientOcclusion: e.target.checked }, true);
    $('dqp-ao-str').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-ao-str-val').textContent = v + '%';
      setCfg({ aoStrength: v / 100 });
    };
    $('dqp-svf-on').onchange = e => setCfg({ svfEnabled: e.target.checked }, true);
    $('dqp-svf-str').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-svf-str-val').textContent = v + '%';
      setCfg({ svfStrength: v / 100 });
    };

    $('dqp-tone-select').onchange = e => setCfg({ colorTone: e.target.value });
    $('dqp-hypso-select').onchange = e => setCfg({ hypsoMode: e.target.value });
    $('dqp-light-boost').oninput = e => {
      const v = parseFloat(e.target.value);
      $('dqp-light-boost-val').textContent = '×' + v.toFixed(2);
      setCfg({ lightBoost: v });
    };
    $('dqp-light-wrap').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-light-wrap-val').textContent = v + '%';
      setCfg({ lightWrap: v / 100 });
    };

    // --- Слушатели режима ГОРИЗОНТАЛИ ---
    $('dqp-ct-step').onchange = e => {
      const v = e.target.value;
      setCfg({ contourStep: v === 'auto' ? 'auto' : parseInt(v, 10) });
    };
    $('dqp-ct-blend').onchange = e => setCfg({ contourBlendMode: e.target.value });
    $('dqp-ct-width').oninput = e => {
      const v = parseFloat(e.target.value);
      $('dqp-ct-width-val').textContent = v.toFixed(1) + ' px';
      setCfg({ contourWidth: v });
    };
    $('dqp-ct-opacity').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-ct-opacity-val').textContent = v + '%';
      setCfg({ contourOpacity: v / 100 });
    };
    $('dqp-ct-style').onchange = e => setCfg({ contourStyle: e.target.value });
    $('dqp-ct-palette').onchange = e => setCfg({ contourPalette: e.target.value }, true);
    $('dqp-ct-color').oninput = e => setCfg({ contourColor: e.target.value, contourPalette: 'custom' });

    // Подписи
    $('dqp-lbl-on').onchange = e => setCfg({ showLabels: e.target.checked }, true);
    $('dqp-lbl-scope').onchange = e => setCfg({ contourLabelScope: e.target.value });
    $('dqp-lbl-orient').onchange = e => setCfg({ contourLabelOrient: e.target.value });
    $('dqp-lbl-density').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-lbl-density-val').textContent = v + '%';
      setCfg({ contourLabelDensity: v / 100 });
    };
    $('dqp-lbl-size').oninput = e => {
      const v = parseFloat(e.target.value);
      $('dqp-lbl-size-val').textContent = v.toFixed(1) + ' px';
      setCfg({ contourLabelSize: v });
    };
    $('dqp-lbl-style').onchange = e => setCfg({ contourLabelStyle: e.target.value });
    $('dqp-lbl-colmode').onchange = e => setCfg({ contourLabelColorMode: e.target.value }, true);
    $('dqp-lbl-col').oninput = e => setCfg({ contourLabelColor: e.target.value, contourLabelColorMode: 'custom' });
    $('dqp-lbl-break').onchange = e => setCfg({ contourLabelBreak: e.target.checked });
    $('dqp-lbl-unit').onchange = e => setCfg({ contourLabelUnit: e.target.checked });

    // Геометрия линий
    $('dqp-ct-smooth').onchange = e => setCfg({ contourSmoothing: e.target.value });
    $('dqp-ct-formlines').onchange = e => setCfg({ formLinesEnabled: e.target.checked });
    $('dqp-ct-cliff').onchange = e => setCfg({ cliffHairlines: e.target.checked });
    $('dqp-ct-taper').onchange = e => setCfg({ taperWithElevation: e.target.checked }, true);
    $('dqp-ct-taper-dir').onchange = e => setCfg({ taperDirection: e.target.value });
    $('dqp-ct-taper-str').oninput = e => {
      const v = parseInt(e.target.value, 10);
      $('dqp-ct-taper-str-val').textContent = v + '%';
      setCfg({ taperStrength: v / 100 });
    };

    window.addEventListener('wm:dem-change', scheduleSyncUI);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) close(true);
    });
  }

  function open(mode = 'relief') {
    injectStyles();
    if (!panelEl) buildMarkup();

    if (mode === 'contours' || mode === 'relief') {
      currentMode = mode;
    }

    isOpen = true;
    panelEl.hidden = false;
    syncUI();
    requestAnimationFrame(() => clampPanelPosition(false));

    if (WM.ui && WM.ui.pushHistoryState) {
      WM.ui.pushHistoryState('demQuickPanel');
    }
  }

  function close(syncHistory = true) {
    if (!isOpen) return;
    isOpen = false;
    if (panelEl) panelEl.hidden = true;
    if (WM.demRelief && WM.demRelief.flush) WM.demRelief.flush();
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('demQuickPanel');
    }
  }

  WM.demQuickPanel = {
    open,
    close,
    isOpen: () => isOpen,
    sync: scheduleSyncUI
  };
})();