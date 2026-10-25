(function () {
  const WM = window.WM;
  let map = null;
  let container = null;
  let svg = null;

  const DEFAULT_CONFIG = {
    enabled: false,
    radiusRatio: 0.35,      // от 0.15 до 0.65 (доля от половины меньшей стороны экрана)
    showAxes: true,         // отображать мерные шкалы (вверх и по бокам)
    axisLengthRatio: 1.15,  // длина осей относительно радиуса круга (0.6 - 1.8)
    color: '#38bdf8',       // акцентный цвет визира
    fontSize: 10,           // размер шрифта цифр (px)
    textColor: '#ffffff'    // цвет шрифта цифр
  };

  let cfg = { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(localStorage.getItem('wm_range_ring_cfg') || '{}');
    cfg = { ...DEFAULT_CONFIG, ...saved };
  } catch (e) {}

  function saveConfig() {
    try {
      localStorage.setItem('wm_range_ring_cfg', JSON.stringify(cfg));
    } catch (e) {}
  }

  function formatDist(meters) {
    if (meters < 1000) {
      return Math.round(meters) + ' м';
    }
    const km = meters / 1000;
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' км';
  }

  // Расчёт круглых "удобных" шагов шкалы (10, 20, 50, 100, 200, 500, 1000...)
  function getNiceStep(totalMeters, approxTicks = 4) {
    const raw = totalMeters / Math.max(1, approxTicks);
    const exponent = Math.floor(Math.log10(raw));
    const fraction = raw / Math.pow(10, exponent);
    let nice;
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3.5) nice = 2;
    else if (fraction < 7.5) nice = 5;
    else nice = 10;
    return nice * Math.pow(10, exponent);
  }

  function render() {
    if (!svg || !map || !cfg.enabled) {
      if (svg) svg.innerHTML = '';
      return;
    }

    const size = map.getSize();
    const w = size.x;
    const h = size.y;
    if (w <= 0 || h <= 0) return;

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    const cx = w / 2;
    const cy = h / 2;
    const minDim = Math.min(w, h);

    // Радиус круга в пикселях
    const rPx = Math.max(30, (minDim / 2) * cfg.radiusRatio);

    // Физическое расстояние в метрах от центра до края круга
    const centerLatLng = map.getCenter();
    const edgePoint = L.point(cx + rPx, cy);
    const edgeLatLng = map.containerPointToLatLng(edgePoint);
    const radiusMeters = centerLatLng.distanceTo(edgeLatLng);
    if (!radiusMeters || isNaN(radiusMeters)) return;

    const pxPerMeter = rPx / radiusMeters;
    const isNightVision = document.documentElement.getAttribute('data-theme') === 'night-vision';
    const color = isNightVision ? '#ef4444' : (cfg.color || '#38bdf8');
    const fSize = cfg.fontSize || 10;
    const textColor = isNightVision ? '#ef4444' : (cfg.textColor || '#ffffff');
    const badgeBg = isNightVision ? 'rgba(20, 2, 2, 0.92)' : 'rgba(15, 23, 42, 0.78)';

    let out = '';

    // 1. Центральное микро-перекрестие кольца
    out += `
      <g class="rr-center" stroke="${color}" stroke-width="1.2" opacity="0.6">
        <line x1="${cx - 6}" y1="${cy}" x2="${cx + 6}" y2="${cy}" />
        <line x1="${cx}" y1="${cy - 6}" x2="${cx}" y2="${cy + 6}" />
      </g>
    `;

    // 2. Основной круг дальности
    out += `
      <circle cx="${cx}" cy="${cy}" r="${rPx}" 
        fill="none" 
        stroke="${color}" 
        stroke-width="1.4" 
        stroke-dasharray="5, 4" 
        class="rr-circle" 
      />
    `;

    // Подпись радиуса круга на 45° (северо-восток)
    const angleRad = -Math.PI / 4;
    const badgeX = cx + (rPx + 6) * Math.cos(angleRad);
    const badgeY = cy + (rPx + 6) * Math.sin(angleRad);
    const radiusLabel = formatDist(radiusMeters);
    const badgeW = Math.max(34, radiusLabel.length * (fSize * 0.65) + 12);
    const badgeH = fSize + 6;

    out += `
      <g class="rr-badge" transform="translate(${badgeX}, ${badgeY})">
        <rect x="0" y="-${badgeH * 0.75}" width="${badgeW}" height="${badgeH}" rx="4" 
              fill="${badgeBg}" stroke="${color}" stroke-width="1" />
        <text x="6" y="${badgeH * 0.2 - 2}" fill="${textColor}" font-size="${fSize}" font-weight="700" 
              font-family="-apple-system, sans-serif" alignment-baseline="middle">
          ${radiusLabel}
        </text>
      </g>
    `;

    // 3. Мерные шкалы-оси (вверх/Север, влево/Запад, вправо/Восток)
    if (cfg.showAxes) {
      const axisLenPx = rPx * cfg.axisLengthRatio;
      const axisMeters = axisLenPx / pxPerMeter;
      const stepMeters = getNiceStep(axisMeters, 4);

      // Направляющие лучи
      out += `
        <g stroke="${color}" stroke-width="1.2" opacity="0.75" class="rr-axes">
          <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - axisLenPx}" />
          <line x1="${cx}" y1="${cy}" x2="${cx - axisLenPx}" y2="${cy}" />
          <line x1="${cx}" y1="${cy}" x2="${cx + axisLenPx}" y2="${cy}" />
        </g>
      `;

      // Генерация делений и цифровых подписей вдоль шкал
      let ticksSvg = '';
      const numSteps = Math.floor(axisMeters / stepMeters);

      for (let i = 1; i <= numSteps; i++) {
        const dM = i * stepMeters;
        const dPx = dM * pxPerMeter;
        if (dPx > axisLenPx) break;

        const isCircleTick = Math.abs(dPx - rPx) < 4;
        const tickSize = isCircleTick ? 8 : 5;
        const labelText = formatDist(dM);

        // Ось ВВЕРХ (Север)
        ticksSvg += `
          <line x1="${cx - tickSize}" y1="${cy - dPx}" x2="${cx + tickSize}" y2="${cy - dPx}" stroke="${color}" stroke-width="1.2" />
          <text x="${cx + tickSize + 4}" y="${cy - dPx + fSize * 0.35}" fill="${textColor}" font-size="${fSize}" font-weight="600" 
                filter="url(#rr-text-shadow)" font-family="ui-monospace, monospace">${labelText}</text>
        `;

        // Ось ВПРАВО (Восток)
        ticksSvg += `
          <line x1="${cx + dPx}" y1="${cy - tickSize}" x2="${cx + dPx}" y2="${cy + tickSize}" stroke="${color}" stroke-width="1.2" />
          <text x="${cx + dPx}" y="${cy + tickSize + fSize + 2}" text-anchor="middle" fill="${textColor}" font-size="${fSize}" font-weight="600" 
                filter="url(#rr-text-shadow)" font-family="ui-monospace, monospace">${labelText}</text>
        `;

        // Ось ВЛЕВО (Запад)
        ticksSvg += `
          <line x1="${cx - dPx}" y1="${cy - tickSize}" x2="${cx - dPx}" y2="${cy + tickSize}" stroke="${color}" stroke-width="1.2" />
          <text x="${cx - dPx}" y="${cy + tickSize + fSize + 2}" text-anchor="middle" fill="${textColor}" font-size="${fSize}" font-weight="600" 
                filter="url(#rr-text-shadow)" font-family="ui-monospace, monospace">${labelText}</text>
        `;
      }

      // Стрелка "N" на верхушке вертикальной шкалы
      ticksSvg += `
        <path d="M ${cx - 4} ${cy - axisLenPx - 4} L ${cx} ${cy - axisLenPx - 10} L ${cx + 4} ${cy - axisLenPx - 4} Z" fill="${color}" />
        <text x="${cx}" y="${cy - axisLenPx - 13}" text-anchor="middle" fill="${color}" font-size="10" font-weight="800">N</text>
      `;

      out += ticksSvg;
    }

    svg.innerHTML = `
      <defs>
        <filter id="rr-text-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.9"/>
        </filter>
      </defs>
      ${out}
    `;
  }

  WM.rangeRing = {
    init(m) {
      if (container) return; // Защита от повторной инициализации
      map = (m && typeof m.getContainer === 'function') ? m : WM.map;
      if (!map || typeof map.getContainer !== 'function') return;

      container = document.createElement('div');
      container.className = 'wm-range-ring-container';
      container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:950;overflow:hidden;';

      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText = 'width:100%;height:100%;display:block;';
      container.appendChild(svg);

      map.getContainer().appendChild(container);

      map.on('move zoom resize', render);
      render();
    },

    setEnabled(val) {
      cfg.enabled = !!val;
      saveConfig();
      render();
    },

    isEnabled() {
      return !!cfg.enabled;
    },

    setRadiusRatio(val) {
      cfg.radiusRatio = Math.max(0.15, Math.min(0.75, parseFloat(val)));
      saveConfig();
      render();
    },

    getRadiusRatio() {
      return cfg.radiusRatio;
    },

    setShowAxes(val) {
      cfg.showAxes = !!val;
      saveConfig();
      render();
    },

    getShowAxes() {
      return cfg.showAxes;
    },

    setAxisLengthRatio(val) {
      cfg.axisLengthRatio = Math.max(0.6, Math.min(1.8, parseFloat(val)));
      saveConfig();
      render();
    },

    getAxisLengthRatio() {
      return cfg.axisLengthRatio;
    },

    setColor(val) {
      cfg.color = val;
      saveConfig();
      render();
    },

    getColor() {
      return cfg.color;
    },

    setFontSize(val) {
      cfg.fontSize = Math.max(8, Math.min(24, parseInt(val, 10) || 10));
      saveConfig();
      render();
    },

    getFontSize() {
      return cfg.fontSize || 10;
    },

    setTextColor(val) {
      cfg.textColor = val;
      saveConfig();
      render();
    },

    getTextColor() {
      return cfg.textColor || '#ffffff';
    },

    refresh: render
  };
})();