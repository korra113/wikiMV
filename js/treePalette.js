/**
 * js/treePalette.js — Экспресс-палитра деревьев и травы с поддержкой 6 сезонов.
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  function hexToRgb(hex) {
    const n = parseInt((hex || '#000000').replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function rgbToHex(r, g, b) {
    const toHex = v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function rgbToHsl(r, g, b) {
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
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s / 100, 0, 1);
    l = clamp(l / 100, 0, 1);
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = t => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    return [hue2rgb(h + 1/3), hue2rgb(h), hue2rgb(h - 1/3)];
  }

  function hslToHex(h, s, l) {
    const [r, g, b] = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
  }

  const SEASONS = [
    { id: 'summer',       name: '☀️ Лето' },
    { id: 'early_spring', name: '🌱 Ранняя весна' },
    { id: 'spring',       name: '🌿 Весна' },
    { id: 'autumn',       name: '🍁 Золотая осень' },
    { id: 'late_autumn',  name: '🍂 Поздняя осень' },
    { id: 'winter',       name: '❄️ Зима' }
  ];

  const GRASS_DEFS = [
    { key: 'grass_a',      name: 'Трава — веерная', icon: '🌾', bTitle: 'Низ пучка', tTitle: 'Кончики' },
    { key: 'grass_b',      name: 'Трава — стеблевая', icon: '🌾', bTitle: 'Стебли', tTitle: 'Верхушки' },
    { key: 'grass_c',      name: 'Трава — кочковая', icon: '🌾', bTitle: 'Основание', tTitle: 'Кончики' },
    { key: 'fern',         name: 'Лесной папоротник', icon: '🌿', bTitle: 'Черешок вайи', tTitle: 'Доли листа' },
    { key: 'cereal',       name: 'Злаки и колосья', icon: '🌾', bTitle: 'Стебель', tTitle: 'Колос' },
    { key: 'umbel',        name: 'Зонтичные (борщевик)', icon: '🪴', bTitle: 'Стебель и листья', tTitle: 'Шапка-зонтик' },
    { key: 'reeds',        name: 'Болотный камыш', icon: '🌾', bTitle: 'Листья', tTitle: 'Метёлка' },
    { key: 'flower_white', name: 'Белые цветы (ромашка)', icon: '🌼', bTitle: 'Стебель', tTitle: 'Лепестки' },
    { key: 'flower_red',   name: 'Красные цветы (мак)', icon: '🌺', bTitle: 'Стебель', tTitle: 'Лепестки' },
    { key: 'flower_blue',  name: 'Синие цветы (василёк)', icon: '🌸', bTitle: 'Стебель', tTitle: 'Лепестки' }
  ];

  let paletteWin = null;
  let activeTab = 'trees'; // 'trees' | 'grass'
  let activeSeason = 'summer';

  const CSS = `
.tp-modal {
  position: fixed; left: 20px; top: 60px; width: 550px; max-height: 86vh;
  background: #12161f; color: #e6e9ef; border: 1px solid #2a3444; border-radius: 12px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.75); z-index: 99998; display: flex; flex-direction: column;
  font: 12.5px/1.4 system-ui, -apple-system, sans-serif; overflow: hidden;
}
.tp-head {
  display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
  background: #1a222e; border-bottom: 1px solid #2a3444; cursor: move; user-select: none;
}
.tp-head b { font-size: 13.5px; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
.tp-nav-tabs {
  display: flex; background: #151b24; border-bottom: 1px solid #252e3d;
}
.tp-nav-tab {
  flex: 1; padding: 8px; text-align: center; cursor: pointer; color: #8b9bb0; font-weight: 600; font-size: 12px;
  border-bottom: 2px solid transparent; background: none; border-top: none; border-left: none; border-right: none;
}
.tp-nav-tab.act { color: #58a6ff; border-bottom-color: #58a6ff; background: #19212d; }
.tp-season-bar {
  display: flex; gap: 4px; padding: 8px 10px; background: #161c26; border-bottom: 1px solid #242d3a; overflow-x: auto;
}
.tp-sbtn {
  flex: 1; padding: 5px 6px; border: 1px solid #2e3a4e; border-radius: 6px; background: #1c2432;
  color: #c4cfdd; cursor: pointer; font-size: 11px; white-space: nowrap; text-align: center;
}
.tp-sbtn:hover { background: #263246; }
.tp-sbtn.act { background: #1f6feb; border-color: #58a6ff; color: #fff; font-weight: bold; }
.tp-col-legend {
  display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 5px 14px; font-size: 11px;
  color: #8b949e; background: #141a24; border-bottom: 1px solid #222b38;
}
.tp-list {
  flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.tp-item {
  display: flex; align-items: center; gap: 8px; background: #18202c; border: 1px solid #283344;
  border-radius: 8px; padding: 6px 9px;
}
.tp-item:hover { border-color: #3b4d66; }
.tp-item.tp-disabled { opacity: 0.55; background: #131720; border-color: #202733; }
.tp-item-title {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: #dce4ef;
}
.tp-color-grp { display: flex; align-items: center; gap: 6px; }
.tp-dim-grp { display: flex; align-items: center; gap: 6px; }
.tp-dim-grp label { display: flex; align-items: center; gap: 2px; font-size: 11px; color: #9bb0c9; }
.tp-num {
  width: 38px; height: 22px; background: #121720; color: #fff; border: 1px solid #36445a;
  border-radius: 4px; padding: 1px 3px; font-size: 11px; text-align: center;
}
.tp-chk-hide {
  display: flex; align-items: center; gap: 4px; font-size: 11px; color: #f85149; cursor: pointer; user-select: none;
  background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.25); border-radius: 4px; padding: 2px 6px;
}
.tp-chk-hide input { margin: 0; cursor: pointer; }
.tp-cpick {
  width: 26px; height: 24px; padding: 0; border: 1px solid #3d4c62; border-radius: 4px; background: none; cursor: pointer;
}
.tp-cpick-wood { margin-left: 4px; border-color: #5e4634; }
.tp-cpick::-webkit-color-swatch-wrapper { padding: 0; }
.tp-cpick::-webkit-color-swatch { border: none; border-radius: 3px; }
.tp-btn {
  background: #238636; color: #fff; border: 1px solid rgba(255,255,255,0.15); padding: 4px 8px;
  border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;
}
.tp-btn:hover { background: #2ea043; }
.tp-btn.sec { background: #242d3c; color: #c4cfdd; border-color: #38465c; }
.tp-btn.sec:hover { background: #313d52; }
.tp-btn.sm { padding: 3px 6px; font-size: 11px; }
.tp-foot {
  display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #161c26; border-top: 1px solid #242d3a;
}
.tp-toast {
  position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%); background: rgba(16,21,30,0.95);
  border: 1px solid #3fb950; color: #3fb950; padding: 6px 14px; border-radius: 8px; font-weight: bold;
  font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 0.25s; z-index: 10;
}
.tp-toast.on { opacity: 1; }
`;

  function showToast(text) {
    if (!paletteWin) return;
    const t = paletteWin.querySelector('#tp-toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 2200);
  }

  function downloadFile(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function buildFullPresetsJs() {
    const S3D = WM.slice3d;
    if (!S3D || !S3D.getRawActiveCatalog) return '';
    const catalog = S3D.getRawActiveCatalog();
    const cleanFn = (WM.treeEditor && WM.treeEditor.cleanSparseRecipe)
      ? WM.treeEditor.cleanSparseRecipe
      : (r => JSON.parse(JSON.stringify(r)));
    const cleanedList = catalog.map(tree => cleanFn(tree));
    return `/**
 * js/treePresets.js — Каталог встроенных пресетов деревьев по умолчанию.
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  WM.defaultTreePresets = ${JSON.stringify(cleanedList, null, 2)};
})();`;
  }

  function buildGrassPresetsJs() {
    const S3D = WM.slice3d;
    const grassTypes = S3D ? S3D.getGrassTypes() : {};
    return `// Вставьте этот блок внутрь DEF.view.grassTypes в slice3d.js:
grassTypes: ${JSON.stringify(grassTypes, null, 2)}`;
  }

  function openTreePalette() {
    if (WM.slice3d && WM.slice3d.getCurrentSeason) {
      activeSeason = WM.slice3d.getCurrentSeason();
    }
    if (paletteWin) {
      paletteWin.style.display = 'flex';
      renderView();
      return;
    }

    if (!document.getElementById('tp-style')) {
      const s = document.createElement('style');
      s.id = 'tp-style';
      s.textContent = CSS;
      document.head.append(s);
    }

    paletteWin = document.createElement('div');
    paletteWin.className = 'tp-modal';
    paletteWin.innerHTML = `
      <div class="tp-head">
        <b>🎨 Экспресс-палитра растительности</b>
        <button class="tp-btn sec sm" id="tp-close-btn" style="padding:2px 7px">✕</button>
      </div>

      <!-- Вкладки: Деревья / Трава -->
      <div class="tp-nav-tabs">
        <button class="tp-nav-tab act" id="tp-tab-trees">🌲 Деревья</button>
        <button class="tp-nav-tab" id="tp-tab-grass">🌿 Трава и цветы</button>
      </div>

      <!-- Селектор сезона -->
      <div class="tp-season-bar" id="tp-seasons">
        ${SEASONS.map(s => `<button class="tp-sbtn ${s.id === activeSeason ? 'act' : ''}" data-sid="${s.id}">${s.name}</button>`).join('')}
      </div>

      <!-- Легенда колонок -->
      <div class="tp-col-legend" id="tp-col-legend"></div>

      <!-- Список элементов -->
      <div class="tp-list" id="tp-content-list"></div>

      <div class="tp-toast" id="tp-toast">✓ Скопировано</div>

      <!-- Футер -->
      <div class="tp-foot" id="tp-foot">
        <button class="tp-btn" id="tp-copy-all" style="flex:1" title="Скопировать код пресетов">📋 Копировать (JS)</button>
        <button class="tp-btn sec" id="tp-dl-js" style="flex:1" title="Скачать файл">💾 Скачать .js</button>
        <button class="tp-btn sec" id="tp-dl-json" title="Скачать JSON">📦 JSON</button>
      </div>
    `;

    document.body.append(paletteWin);

    paletteWin.querySelector('#tp-close-btn').onclick = () => { paletteWin.style.display = 'none'; };
    setupDrag(paletteWin);

    const btnTrees = paletteWin.querySelector('#tp-tab-trees');
    const btnGrass = paletteWin.querySelector('#tp-tab-grass');

    btnTrees.onclick = () => {
      activeTab = 'trees';
      btnTrees.classList.add('act');
      btnGrass.classList.remove('act');
      renderView();
    };

    btnGrass.onclick = () => {
      activeTab = 'grass';
      btnGrass.classList.add('act');
      btnTrees.classList.remove('act');
      renderView();
    };

    paletteWin.querySelectorAll('.tp-sbtn').forEach(btn => {
      btn.onclick = () => {
        paletteWin.querySelectorAll('.tp-sbtn').forEach(b => b.classList.remove('act'));
        btn.classList.add('act');
        activeSeason = btn.dataset.sid;
        applySeasonToSlice3D(activeSeason);
        renderView();
      };
    });

    paletteWin.querySelector('#tp-copy-all').onclick = () => {
      if (activeTab === 'trees') {
        const code = buildFullPresetsJs();
        navigator.clipboard.writeText(code).then(() => showToast('✓ Пресеты деревьев скопированы!'));
      } else {
        const code = buildGrassPresetsJs();
        navigator.clipboard.writeText(code).then(() => showToast('✓ Пресеты 6 сезонов травы скопированы!'));
      }
    };

    paletteWin.querySelector('#tp-dl-js').onclick = () => {
      if (activeTab === 'trees') {
        downloadFile('treePresets.js', buildFullPresetsJs(), 'application/javascript');
        showToast('✓ treePresets.js скачан');
      } else {
        downloadFile('grassPresets.js', buildGrassPresetsJs(), 'application/javascript');
        showToast('✓ grassPresets.js скачан');
      }
    };

    paletteWin.querySelector('#tp-dl-json').onclick = () => {
      const data = (activeTab === 'trees')
        ? (WM.slice3d ? WM.slice3d.getRawActiveCatalog() : [])
        : (WM.slice3d ? WM.slice3d.getGrassTypes() : {});
      downloadFile(activeTab === 'trees' ? 'treePresets.json' : 'grassPresets.json', JSON.stringify(data, null, 2), 'application/json');
      showToast('✓ JSON скачан');
    };

    renderView();
  }

  function applySeasonToSlice3D(sId) {
    if (!WM.slice3d) return;
    WM.slice3d.setOptions({ season: sId, time: { mode: 'manual' } });
  }

  function renderView() {
    if (!paletteWin) return;
    const legendEl = paletteWin.querySelector('#tp-col-legend');

    if (activeTab === 'trees') {
      legendEl.innerHTML = `<span>🍃 Низ кроны</span><span>🌿 Верх кроны</span><span>🪵 Ствол</span>`;
      renderTreesList();
    } else {
      legendEl.innerHTML = `<span>Размеры (В/Ш)</span><span>🌱 Низ/Стебель</span><span>🌸 Верх/Цветок</span>`;
      renderGrassList();
    }
  }

  // --- СПИСОК ДЕРЕВЬЕВ ---
  function renderTreesList() {
    const listEl = paletteWin.querySelector('#tp-content-list');
    listEl.innerHTML = '';

    const S3D = WM.slice3d;
    if (!S3D || !S3D.getRawActiveCatalog) {
      listEl.innerHTML = '<div style="padding:15px;text-align:center;color:#8b949e">3D-срез не запущен</div>';
      return;
    }

    const catalog = S3D.getRawActiveCatalog();
    const treeSeasonKey = activeSeason === 'early_spring' ? 'earlySpring' : (activeSeason === 'late_autumn' ? 'lateAutumn' : activeSeason);

    catalog.forEach((tree, idx) => {
      const isConifer = tree.eco && tree.eco.kind === 'conifer';
      const kindIcon = isConifer ? '🌲' : '🌳';
      const st = tree.style = tree.style || { leaf: '#2d6e1e', leaf2: '#86c14a', wood: '#4d3322' };
      const eco = tree.eco = tree.eco || {};
      const cs = eco.colorShift = eco.colorShift || { enabled: true };

      let curColorHex1 = st.leaf || '#2d6e1e';
      let curColorHex2 = st.leaf2 || st.leaf || '#86c14a';

      if (treeSeasonKey !== 'summer') {
        const sConf = cs[treeSeasonKey];
        if (sConf && sConf.h != null) curColorHex1 = hslToHex(sConf.h, sConf.s, sConf.l);
        if (sConf && sConf.h2 != null) curColorHex2 = hslToHex(sConf.h2, sConf.s2, sConf.l2);
        else if (sConf && sConf.h != null) curColorHex2 = hslToHex(sConf.h, Math.max(0, sConf.s - 6), Math.min(95, sConf.l + 10));
      }

      const item = document.createElement('div');
      item.className = 'tp-item';
      item.innerHTML = `
        <span style="font-size:16px">${kindIcon}</span>
        <div class="tp-item-title" title="${tree.name || ''}"><b>#${idx + 1}</b> ${tree.name || 'Дерево'}</div>
        <div class="tp-color-grp">
          <input type="color" class="tp-cpick" value="${curColorHex1}" title="Крона 1 (низ/основа)">
          <input type="color" class="tp-cpick" value="${curColorHex2}" title="Крона 2 (верх/концы)">
          <input type="color" class="tp-cpick tp-cpick-wood" value="${st.wood || '#4d3322'}" title="Цвет ствола">
        </div>
        <button class="tp-btn sec sm" title="Редактировать форму">✏️ Форма</button>
      `;

      const [p1, p2, pWood] = item.querySelectorAll('.tp-cpick');

      p1.oninput = () => {
        const hex = p1.value;
        if (treeSeasonKey === 'summer') st.leaf = hex;
        else {
          cs.enabled = true;
          const [r, g, b] = hexToRgb(hex);
          const hsl = rgbToHsl(r, g, b);
          cs[treeSeasonKey] = cs[treeSeasonKey] || {};
          cs[treeSeasonKey].h = hsl.h; cs[treeSeasonKey].s = hsl.s; cs[treeSeasonKey].l = hsl.l;
        }
        S3D.updateTreeSlot(idx, tree);
      };

      p2.oninput = () => {
        const hex = p2.value;
        if (treeSeasonKey === 'summer') st.leaf2 = hex;
        else {
          cs.enabled = true;
          const [r, g, b] = hexToRgb(hex);
          const hsl = rgbToHsl(r, g, b);
          cs[treeSeasonKey] = cs[treeSeasonKey] || {};
          cs[treeSeasonKey].h2 = hsl.h; cs[treeSeasonKey].s2 = hsl.s; cs[treeSeasonKey].l2 = hsl.l;
        }
        S3D.updateTreeSlot(idx, tree);
      };

      pWood.oninput = () => {
        st.wood = pWood.value;
        st.wood2 = pWood.value;
        S3D.updateTreeSlot(idx, tree);
      };

      item.querySelector('.tp-btn').onclick = () => {
        if (WM.treeEditor && WM.treeEditor.open) WM.treeEditor.open(tree, { slot: idx });
      };

      listEl.append(item);
    });
  }

  // --- СПИСОК ТРАВЫ И ЦВЕТОВ ---
  function renderGrassList() {
    const listEl = paletteWin.querySelector('#tp-content-list');
    listEl.innerHTML = '';

    const S3D = WM.slice3d;
    const grassTypes = S3D && S3D.getGrassTypes ? S3D.getGrassTypes() : {};

    GRASS_DEFS.forEach((def, idx) => {
      const cfg = grassTypes[def.key] || {};
      const sMap = (cfg.seasons && cfg.seasons[activeSeason]) || {};
      const isOff = !!sMap.disabled;
      const curH = sMap.h != null ? sMap.h : (cfg.h != null ? cfg.h : 1.0);
      const curW = sMap.w != null ? sMap.w : (cfg.w != null ? cfg.w : 1.0);
      const curBase = sMap.colBase || cfg.colBase || '#264214';
      const curTip  = sMap.colTip  || cfg.colTip  || '#6ca82c';

      const item = document.createElement('div');
      item.className = 'tp-item' + (isOff ? ' tp-disabled' : '');
      item.innerHTML = `
        <span style="font-size:16px">${def.icon}</span>
        <div class="tp-item-title" title="${def.name}"><b>#${idx + 1}</b> ${def.name}</div>
        
        <label class="tp-chk-hide" title="Полностью скрыть данный вид в сезоне «${activeSeason}»">
          <input type="checkbox" class="tp-hide-chk" ${isOff ? 'checked' : ''}>
          <span>Убрать</span>
        </label>

        <div class="tp-dim-grp" ${isOff ? 'style="opacity:0.3;pointer-events:none"' : ''}>
          <label title="Высота (множитель)">В <input type="number" step="0.1" min="0.1" max="15.0" class="tp-num tp-num-h" value="${Number(curH).toFixed(1)}"></label>
          <label title="Ширина (множитель)">Ш <input type="number" step="0.1" min="0.1" max="15.0" class="tp-num tp-num-w" value="${Number(curW).toFixed(1)}"></label>
        </div>

        <div class="tp-color-grp" ${isOff ? 'style="opacity:0.3;pointer-events:none"' : ''}>
          <input type="color" class="tp-cpick tp-pick-base" value="${curBase}" title="${def.bTitle}">
          <input type="color" class="tp-cpick tp-pick-tip" value="${curTip}" title="${def.tTitle}">
        </div>
      `;

      const chkHide = item.querySelector('.tp-hide-chk');
      const inH     = item.querySelector('.tp-num-h');
      const inW     = item.querySelector('.tp-num-w');
      const pBase   = item.querySelector('.tp-pick-base');
      const pTip    = item.querySelector('.tp-pick-tip');

      chkHide.onchange = () => {
        const disabled = chkHide.checked;
        if (S3D && S3D.updateGrassSeason) {
          S3D.updateGrassSeason(def.key, activeSeason, { disabled });
        }
        renderGrassList();
      };

      inH.onchange = () => {
        const h = Math.max(0.1, parseFloat(inH.value) || 1.0);
        inH.value = h.toFixed(1);
        if (S3D && S3D.updateGrassSeason) {
          S3D.updateGrassSeason(def.key, activeSeason, { h });
        }
      };

      inW.onchange = () => {
        const w = Math.max(0.1, parseFloat(inW.value) || 1.0);
        inW.value = w.toFixed(1);
        if (S3D && S3D.updateGrassSeason) {
          S3D.updateGrassSeason(def.key, activeSeason, { w });
        }
      };

      pBase.oninput = () => {
        if (S3D && S3D.updateGrassSeason) {
          S3D.updateGrassSeason(def.key, activeSeason, { colBase: pBase.value });
        }
      };

      pTip.oninput = () => {
        if (S3D && S3D.updateGrassSeason) {
          S3D.updateGrassSeason(def.key, activeSeason, { colTip: pTip.value });
        }
      };

      listEl.append(item);
    });
  }

  function setupDrag(win) {
    const head = win.querySelector('.tp-head');
    let d = null;
    head.onpointerdown = e => {
      if (e.target.closest('button,input')) return;
      const r = win.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    };
    head.onpointermove = e => {
      if (!d) return;
      win.style.left = clamp(e.clientX - d.dx, 0, window.innerWidth - 100) + 'px';
      win.style.top = clamp(e.clientY - d.dy, 0, window.innerHeight - 50) + 'px';
    };
    const end = () => { d = null; };
    head.onpointerup = end;
    head.onpointercancel = end;
  }

  WM.treePalette = {
    open: openTreePalette,
    refresh: renderView,
    buildFullPresetsJs,
    buildGrassPresetsJs
  };

  if (WM.slice3d) {
    WM.slice3d.openTreePalette = openTreePalette;
  }
})();