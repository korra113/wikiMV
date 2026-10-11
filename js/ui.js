(function () {
  const WM = window.WM, $ = id => document.getElementById(id);
  let cur = null, tab = 'info', lb = { list: [], i: 0 };
  let editingKeys = [], editingActiveIndex = 0;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  let historyPushedState = null;

  function pushHistoryState(stateName) {
    if (historyPushedState === stateName) return;
    historyPushedState = stateName;
    history.pushState({ wmView: stateName }, '');
  }

  function clearHistoryState(stateName, fallbackState = null) {
    if (historyPushedState === stateName) {
      historyPushedState = fallbackState;
      if (history.state && history.state.wmView === stateName) {
        history.back();
      }
    }
  }

  window.addEventListener('popstate', (e) => {
    const targetView = (e.state && e.state.wmView) || null;

    const lbEl = $('lightbox');
    if (lbEl && !lbEl.hidden && targetView !== 'lightbox') {
      closeLightbox(false);
      historyPushedState = targetView;
      return;
    }

    const openModals = document.querySelectorAll('.modal-overlay.open');
    if (openModals.length > 0 && targetView !== 'modal') {
      openModals.forEach(m => m.classList.remove('open'));
      historyPushedState = targetView;
      return;
    }

    const sheet = $('sheet');
    if (sheet && sheet.classList.contains('open') && targetView !== 'sheet') {
      closeSheet(false);
      historyPushedState = null;
    }
  });

  const LANG_NAMES = {
    ru: { name: 'Русский', flag: '🇷🇺' },
    en: { name: 'English', flag: '🇬🇧' },
    uk: { name: 'Українська', flag: '🇺🇦' },
    be: { name: 'Беларуская', flag: '🇧🇾' },
    de: { name: 'Deutsch', flag: '🇩🇪' },
    fr: { name: 'Français', flag: '🇫🇷' },
    es: { name: 'Español', flag: '🇪🇸' },
    it: { name: 'Italiano', flag: '🇮🇹' },
    pl: { name: 'Polski', flag: '🇵🇱' },
    tr: { name: 'Türkçe', flag: '🇹🇷' },
    zh: { name: '中文', flag: '🇨🇳' },
    ja: { name: '日本語', flag: '🇯🇵' },
    ar: { name: 'العربية', flag: '🇸🇦' },
    he: { name: 'עברית', flag: '🇮🇱' },
    pt: { name: 'Português', flag: '🇵🇹' },
    el: { name: 'Ελληνικά', flag: '🇬🇷' },
    cs: { name: 'Čeština', flag: '🇨🇿' },
    ro: { name: 'Română', flag: '🇷🇴' },
    hu: { name: 'Magyar', flag: '🇭🇺' },
    bg: { name: 'Български', flag: '🇧🇬' },
    ka: { name: 'ქართული', flag: '🇬🇪' },
    hy: { name: 'Հայերեն', flag: '🇦🇲' },
    az: { name: 'Azərbaycan', flag: '🇦🇿' },
    kk: { name: 'Қазақша', flag: '🇰🇿' },
    uz: { name: 'Oʻzbekcha', flag: '🇺🇿' }
  };

  const UI_VIS_DEFAULT = {
    status: true,
    limit: true,
    pill: true,
    zoom: true,
    layers: true,
    search: true,
    mode: true,
    measure: true,
    marker: true,
    precache: true,
    location: true,
    theme: true
  };
  let uiVis = { ...UI_VIS_DEFAULT };
  const VIS_KEYS = ['status', 'limit', 'pill', 'zoom', 'layers', 'search', 'mode', 'measure', 'marker', 'precache', 'location', 'theme'];

  let workMode = WM.api.store.get('wm_work_mode') || 'manual';
  let autoHoverEnabled = WM.api.store.get('wm_auto_hover') === 'true';

  const DEFAULT_RASTER_STYLE = {
    opacity: 85,
    contrast: 135,
    saturate: 130,
    brightness: 100,
    shadow: false,
    invert: false
  };

  let rasterStyle = { ...DEFAULT_RASTER_STYLE };
  try {
    const savedR = JSON.parse(WM.api.store.get('wm_style_raster') || '{}');
    rasterStyle = { ...DEFAULT_RASTER_STYLE, ...savedR };
  } catch (e) {}

  function applyRasterCSS(cfg) {
    const root = document.documentElement;
    root.style.setProperty('--wm-rast-opacity', (cfg.opacity / 100).toString());
    root.style.setProperty('--wm-rast-contrast', cfg.contrast + '%');
    root.style.setProperty('--wm-rast-saturate', cfg.saturate + '%');
    root.style.setProperty('--wm-rast-brightness', cfg.brightness + '%');
    root.style.setProperty('--wm-rast-invert', cfg.invert ? '100%' : '0%');
    root.style.setProperty(
      '--wm-rast-shadow', 
      cfg.shadow ? 'drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))' : 'none'
    );
  }
  applyRasterCSS(rasterStyle);

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.startsWith('on')) n[k] = props[k];
      else n.setAttribute(k, props[k]);
    }
    kids.flat().forEach(c => c != null && n.append(c));
    return n;
  };

  const safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u.replace(/^http:\/\//i, 'https://') : '';
  const list = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  const fmtDate = d => (typeof d === 'number' || /^\d{9,}$/.test(d)) ? new Date(+d * 1000).toLocaleDateString('ru') : (d || '');
  
  function getCentroidCoords(o) {
    const b = o.bbox;
    return {
      lat: ((b.s + b.n) / 2).toFixed(6),
      lon: ((b.w + b.e) / 2).toFixed(6)
    };
  }

  function showToast(text, duration = 2200) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, duration);
  }

  function fmtTimer(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = n => (n < 10 ? '0' : '') + n;
    if (h > 0) {
      return `${h}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  }

  function extractWikimapiaKeys(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];

    let text = rawText.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
    text = text.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');

    const foundKeys = new Set();
    let cleaned = text.replace(/([0-9a-fA-F]{8})\s*-\s*([0-9a-fA-F])/g, '$1-$2');
    cleaned = cleaned.replace(/([0-9a-fA-F]{8})\s*-\s*([0-9a-fA-F])/g, '$1-$2');

    const standardRegex = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){7}/gi;
    const matches = cleaned.match(standardRegex);
    if (matches) {
      for (const m of matches) {
        foundKeys.add(m.toUpperCase().trim());
      }
    }

    const hex64Regex = /\b([0-9a-fA-F]{64})\b/gi;
    let h64;
    while ((h64 = hex64Regex.exec(cleaned)) !== null) {
      const formatted = h64[1].match(/.{8}/g).join('-').toUpperCase();
      foundKeys.add(formatted);
    }

    return Array.from(foundKeys);
  }

  function addDiscoveredKeys(keys) {
    if (!keys || !keys.length) return 0;
    const existingSet = new Set(editingKeys.map(k => k.toUpperCase()));
    const toAdd = keys.filter(k => !existingSet.has(k.toUpperCase()));

    if (!toAdd.length) {
      showToast('Все распознанные ключи уже есть в списке');
      return 0;
    }

    editingKeys = editingKeys.filter(k => k !== 'example');
    editingKeys.push(...toAdd);
    renderKeysUI();
    showToast(`✅ Успешно добавлено ключей: ${toAdd.length}`);
    return toAdd.length;
  }

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    const statusBarColor = isDark ? '#111827' : '#ffffff';

    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      $('btn-theme-toggle').textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      $('btn-theme-toggle').textContent = '🌙';
    }

    const meta = document.getElementById('theme-color-meta') || document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', statusBarColor);
    }

    WM.api.store.set('wm_theme', theme);
  }

  function toggleTheme() {
    const curTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(curTheme === 'dark' ? 'light' : 'dark');
  }

  function applyUIVisibility() {
    $('status').style.display = uiVis.status ? '' : 'none';
    const limitRow = $('limit-row');
    if (limitRow) limitRow.style.display = uiVis.limit ? '' : 'none';
    if (!uiVis.pill) $('hover-pill').hidden = true;

    const zoomControl = document.querySelector('.leaflet-control-zoom');
    if (zoomControl) zoomControl.style.display = uiVis.zoom ? '' : 'none';

    const layersControl = document.querySelector('.leaflet-control-layers');
    if (layersControl) layersControl.style.display = uiVis.layers ? '' : 'none';

    if ($('btn-search')) $('btn-search').style.display = uiVis.search ? '' : 'none';
    if ($('btn-mode-toggle')) $('btn-mode-toggle').style.display = uiVis.mode ? '' : 'none';
    if ($('btn-measure')) $('btn-measure').style.display = uiVis.measure ? '' : 'none';
    if ($('btn-add-marker')) $('btn-add-marker').style.display = uiVis.marker ? '' : 'none';
    if ($('btn-download-area')) $('btn-download-area').style.display = uiVis.precache ? '' : 'none';
    if ($('btn-location')) $('btn-location').style.display = uiVis.location ? '' : 'none';
    if ($('btn-theme-toggle')) $('btn-theme-toggle').style.display = uiVis.theme ? '' : 'none';

    WM.api.store.set('wm_ui_vis', JSON.stringify(uiVis));
  }

  function toggleTopGetKeyBtn(forceShowBlocked = false) {
    const btn = $('btn-get-key-top');
    if (!btn) return;

    if (!uiVis.limit) {
      btn.hidden = true;
      return;
    }

    const hasKeys = WM.api.hasCustomKey ? WM.api.hasCustomKey() : WM.api.keys.some(k => k && k.toLowerCase() !== 'example');

    if (!hasKeys) {
      btn.hidden = false;
      btn.classList.add('warning-banner');
      btn.innerHTML = '⚠️ Нужен API ключ Wikimapia · <u>Добавить</u>';
      return;
    }

    btn.classList.remove('warning-banner');

    const pool = WM.api.getPoolStatus();
    if (forceShowBlocked || pool.allBlocked) {
      btn.hidden = false;
      btn.innerHTML = '🔑 Лимит исчерпан · <u>Добавить ключ</u>';
    } else {
      btn.hidden = true;
    }
  }

  function updateLimitHUD() {
    const badge = $('limit-badge');
    if (!badge || !uiVis.limit) return;

    const hasKeys = WM.api.hasCustomKey ? WM.api.hasCustomKey() : WM.api.keys.some(k => k && k.toLowerCase() !== 'example');
    const pool = WM.api.getPoolStatus();
    let newText = '';
    let isDanger = false;

    if (!hasKeys) {
      newText = '🔑 Ключ не задан';
      isDanger = true;
      toggleTopGetKeyBtn(false);
    } else if (pool.allBlocked) {
      newText = `🔑 Лимит исчерпан · ${fmtTimer(pool.waitMs)}`;
      isDanger = true;
      toggleTopGetKeyBtn(true);
    } else {
      const stats = WM.api.getKeyStats(pool.key);
      newText = `🔑 ${stats.used}/${stats.limit}`;
      isDanger = stats.remaining <= 10;
      toggleTopGetKeyBtn(false);
    }

    if (badge.textContent !== newText) {
      badge.textContent = newText;
    }
    badge.classList.toggle('danger', isDanger);
  }

  function renderKeysUI() {
    const container = $('keys-list');
    container.textContent = '';
    $('keys-count').textContent = editingKeys.length;

    editingKeys.forEach((k, idx) => {
      const stats = WM.api.getKeyStats(k);
      const isActive = idx === editingActiveIndex;

      let statText = `${stats.used}/100 за сутки`;
      if (stats.isBlocked) statText = `Блок (до сброса ${fmtTimer(stats.waitMs)})`;

      const row = el('div', { class: 'key-item' + (isActive ? ' active' : '') },
        el('div', {
          class: 'key-info',
          onclick: () => {
            editingActiveIndex = idx;
            renderKeysUI();
          }
        },
          el('span', { class: 'key-val', text: (isActive ? '● ' : '') + k }),
          el('span', { class: 'key-stats' + (stats.isBlocked ? ' warn' : ''), text: statText })
        ),
        el('div', { class: 'key-item-actions' },
          el('button', {
            class: 'key-action-btn',
            title: 'Редактировать ключ',
            text: '✏️',
            onclick: (e) => {
              e.stopPropagation();
              const updated = prompt('Редактирование API ключа:', k);
              if (updated !== null && updated.trim()) {
                editingKeys[idx] = updated.trim().toUpperCase();
                renderKeysUI();
              }
            }
          }),
          el('button', {
            class: 'key-action-btn',
            title: 'Удалить ключ',
            text: '✕',
            style: 'color:var(--danger);',
            onclick: (e) => {
              e.stopPropagation();
              if (editingKeys.length <= 1) {
                alert('Нельзя удалить единственный ключ!');
                return;
              }
              editingKeys.splice(idx, 1);
              if (editingActiveIndex >= editingKeys.length) editingActiveIndex = editingKeys.length - 1;
              renderKeysUI();
            }
          })
        )
      );
      container.append(row);
    });
  }

  function openKeysSettings() {
    $('btn-settings').click();
    const spoiler = $('spoiler-keys');
    if (spoiler) {
      spoiler.open = true;
      setTimeout(() => {
        spoiler.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const input = $('new-key-input');
        if (input) input.focus();
      }, 150);
    }
  }

  function extractAvailableLanguages(detail, selectedLang = 'ru') {
    const res = new Map();
    const defaultIsos = ['ru', 'en'];
    for (const iso of defaultIsos) {
      const meta = LANG_NAMES[iso];
      res.set(iso, {
        iso,
        name: meta ? `${meta.flag} ${meta.name}` : iso.toUpperCase()
      });
    }

    if (selectedLang && !res.has(selectedLang.toLowerCase())) {
      const iso = selectedLang.toLowerCase();
      const meta = LANG_NAMES[iso];
      res.set(iso, {
        iso,
        name: meta ? `${meta.flag} ${meta.name}` : iso.toUpperCase()
      });
    }

    if (!detail) return Array.from(res.values());

    const curIso = (
      detail.language_iso ||
      detail.language ||
      detail.shortcut ||
      detail.lang ||
      detail.language_code ||
      ''
    ).toLowerCase();

    if (curIso && !res.has(curIso)) {
      const meta = LANG_NAMES[curIso];
      res.set(curIso, { 
        iso: curIso, 
        name: meta ? `${meta.flag} ${meta.name}` : (detail.language_name || curIso.toUpperCase()) 
      });
    }

    const rawTranslate = detail.translate || detail.translations || detail.available_languages || detail.languages;
    if (rawTranslate) {
      const entries = Array.isArray(rawTranslate)
        ? rawTranslate.map(v => [null, v])
        : (typeof rawTranslate === 'object' ? Object.entries(rawTranslate) : []);

      for (const [key, item] of entries) {
        if (!item && !key) continue;
        let iso = '', name = '';

        if (key && typeof key === 'string' && (key.length === 2 || key.length === 3 || LANG_NAMES[key.toLowerCase()])) {
          iso = key.toLowerCase();
        }

        if (typeof item === 'string') {
          const itemLower = item.toLowerCase();
          if (!iso && (item.length === 2 || item.length === 3 || LANG_NAMES[itemLower])) {
            iso = itemLower;
          } else if (iso && !name) {
            name = item;
          }
        } else if (item && typeof item === 'object') {
          const propIso = (
            item.language_iso ||
            item.shortcut ||
            item.iso ||
            item.code ||
            item.lang ||
            item.language_code ||
            (typeof item.language === 'string' && item.language.length <= 3 ? item.language : '')
          );
          if (propIso) iso = String(propIso).toLowerCase();
          name = item.language_name || item.name || (typeof item.language === 'string' && item.language.length > 3 ? item.language : '');
        }

        if (iso && !res.has(iso)) {
          const meta = LANG_NAMES[iso];
          res.set(iso, { 
            iso, 
            name: meta ? `${meta.flag} ${meta.name}` : (name || iso.toUpperCase()) 
          });
        }
      }
    }

    return Array.from(res.values());
  }

  function renderLangsUI() {
    const container = $('sheet-langs');
    if (!container) return;
    container.textContent = '';
    if (!cur) return;

    const curIso = (cur.lang || (cur.detail && cur.detail.language_iso) || 'ru').toLowerCase();
    const langs = extractAvailableLanguages(cur.detail, curIso);

    langs.forEach(l => {
      const isAct = l.iso === curIso;
      const isLoading = cur.loadingLang === l.iso;
      const chip = el('button', {
        class: 'lang-chip' + (isAct ? ' active' : ''),
        text: l.name + (isLoading ? ' ⏳' : ''),
        onclick: () => switchLanguage(l.iso)
      });
      container.append(chip);
    });
  }

  function switchLanguage(targetLang) {
    if (!cur || !cur.obj) return;
    const curIso = (cur.lang || (cur.detail && cur.detail.language_iso) || 'ru').toLowerCase();
    if (curIso === targetLang && cur.detail && !cur.loadingLang) return;

    cur.lang = targetLang;
    cur.loadingLang = targetLang;
    cur.detail = null;
    renderLangsUI();
    load(cur.obj, targetLang);
  }

  function renderInfo(body, o, d) {
    body.append(el('p', { class: 'desc', text: (d && d.description) || (d ? 'Описание отсутствует.' : 'Загрузка…') }));
    
    const rawTags = list(d && d.tags).filter(t => t && (t.title || t.name));
    if (rawTags.length) {
      const activeTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;
      const tagChips = rawTags.map(t => {
        const title = t.title || t.name;
        const id = t.id || null;
        const isActive = activeTag && (activeTag.title === title || (id && activeTag.id === id));
        return el('button', {
          class: 'tag-btn' + (isActive ? ' active' : ''),
          title: `Подсветить все «${title}»`,
          onclick: (e) => {
            e.stopPropagation();
            if (WM.view && WM.view.toggleTagFilter) {
              WM.view.toggleTagFilter({ id, title });
            }
            renderBody();
          }
        }, el('span', { text: '🏷️ ' + title }));
      });
      body.append(el('div', { class: 'tags' }, tagChips));
    }

    const loc = d && d.location, parts = [];
    if (loc) ['country', 'state', 'city', 'place', 'street'].forEach(k => { if (typeof loc[k] === 'string' && loc[k]) parts.push(loc[k]); });
    if (parts.length) body.append(el('p', { class: 'row' }, el('b', { text: 'Адрес: ' }), parts.join(', ')));

    const coords = getCentroidCoords(o);
    const coordStr = `${coords.lat}, ${coords.lon}`;
    const titleEncoded = encodeURIComponent(o.title || 'Wikimapia Point');
    const geoUri = `geo:${coords.lat},${coords.lon}?q=${coords.lat},${coords.lon}(${titleEncoded})`;
    const yandexUrl = `https://yandex.ru/maps/?pt=${coords.lon},${coords.lat}&z=17&l=map`;
    const googleUrl = `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lon}`;
    const curLang = (cur && cur.lang) || 'ru';
    let wmUrl = safeUrl((d && (d.urlhtml || d.url)) || o.url);
    if (wmUrl) {
      wmUrl = wmUrl.replace(/(wikimapia\.org\/\d+\/)[a-z]{2,3}(\/|$)/i, `$1${curLang}$2`);
    } else {
      wmUrl = `https://wikimapia.org/${o.id}/${curLang}/`;
    }

    const actionBlock = el('div', { class: 'card-action-block' },
      el('div', {
        class: 'coords-card',
        title: 'Нажмите, чтобы скопировать координаты',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(coordStr);
            showToast(`📋 Координаты скопированы: ${coordStr}`);
          } catch (e) {
            showToast(`Координаты: ${coordStr}`);
          }
        }
      },
        el('div', { class: 'coords-meta' },
          el('span', { class: 'coords-label', text: 'Координаты центра' }),
          el('span', { class: 'coords-val', text: coordStr })
        ),
        el('span', { class: 'coords-copy-badge', text: '📋 Скопировать' })
      ),

      el('div', { class: 'nav-actions-grid' },
        el('a', { class: 'action-card-btn primary', href: geoUri, text: '🧭 В Навигатор' }),
        el('a', { class: 'action-card-btn', href: yandexUrl, target: '_blank', rel: 'noopener', text: '🟡 Яндекс Карты' }),
        el('a', { class: 'action-card-btn', href: googleUrl, target: '_blank', rel: 'noopener', text: '🔵 Google Maps' }),
        el('a', { class: 'action-card-btn', href: wmUrl, target: '_blank', rel: 'noopener', text: '🌐 Wikimapia ↗' })
      )
    );

    body.append(actionBlock);

    const PRESETS = ['#ef4444', '#f97316', '#eab308', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
    const colorCard = el('div', { class: 'card-color-mark' });

    function renderColorPalette() {
      colorCard.textContent = '';
      const hasCustom = !!o.customColor;

      const header = el('div', { class: 'color-mark-header' },
        el('span', { text: hasCustom ? '🎨 Цветная метка объекта:' : '🎨 Пометить объект цветом:' }),
        hasCustom ? el('button', {
          class: 'color-mark-clear-btn',
          title: 'Сбросить цвет метки',
          onclick: (e) => {
            e.stopPropagation();
            delete o.customColor;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, null);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('Цветовая метка удалена');
          }
        }, el('span', { text: '✕ Сбросить' })) : null
      );

      const palette = el('div', { class: 'color-palette-row' });
      PRESETS.forEach(c => {
        const isAct = o.customColor && o.customColor.toLowerCase() === c.toLowerCase();
        const btn = el('button', {
          class: 'color-palette-chip' + (isAct ? ' active' : ''),
          style: `background-color: ${c};`,
          title: `Выбрать цвет ${c}`,
          onclick: (e) => {
            e.stopPropagation();
            o.customColor = c;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, c);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('🎨 Объект помечен цветом!');
          }
        });
        palette.append(btn);
      });

      const pickerWrap = el('label', {
        class: 'color-palette-custom',
        title: 'Выбрать произвольный цвет'
      },
        el('span', { text: '🌈' }),
        el('input', {
          type: 'color',
          value: o.customColor || '#3b82f6',
          onchange: (e) => {
            const chosen = e.target.value;
            o.customColor = chosen;
            if (WM.cache && WM.cache.setCustomColor) WM.cache.setCustomColor(o.id, chosen);
            if (WM.view && WM.view.updateObjectStyle) WM.view.updateObjectStyle(o.id);
            renderColorPalette();
            showToast('🎨 Объект помечен цветом!');
          }
        })
      );
      palette.append(pickerWrap);

      colorCard.append(header, palette);
    }

    renderColorPalette();
    body.append(colorCard);
  }

  function showLbPhoto(index) {
    if (!lb.list || !lb.list.length) return;
    lb.i = (index + lb.list.length) % lb.list.length;
    resetLbTransform();
    const p = lb.list[lb.i];
    $('lb-img').src = safeUrl(p['1280_url'] || p.big_url || p.thumbnail_url);
    $('lb-cap').textContent = `${lb.i + 1} / ${lb.list.length}`;

    const hasMultiple = lb.list.length > 1;
    const prevBtn = $('lb-prev');
    const nextBtn = $('lb-next');
    if (prevBtn) prevBtn.hidden = !hasMultiple;
    if (nextBtn) nextBtn.hidden = !hasMultiple;
  }

  function openLightbox(index) {
    showLbPhoto(index);
    $('lightbox').hidden = false;
    pushHistoryState('lightbox');
  }

  function closeLightbox(syncHistory = true) {
    const lbEl = $('lightbox');
    if (lbEl) lbEl.hidden = true;
    resetLbTransform();
    if (syncHistory) clearHistoryState('lightbox', cur ? 'sheet' : null);
  }

  function renderPhotos(body, d) {
    const photos = list(d.photos).filter(p => p && (p.thumbnail_url || p['1280_url'] || p.big_url));
    if (!photos.length) return body.append(el('div', { class: 'muted', text: 'Фотографий нет' }));
    lb.list = photos;
    body.append(el('div', { class: 'photo-grid' }, photos.map((p, i) =>
      el('img', { 
        src: safeUrl(p.thumbnail_url || p['1280_url']), 
        loading: 'lazy', 
        onclick: () => openLightbox(i) 
      }))));
  }

  function renderComments(body, d) {
    const cs = list(d.comments).filter(c => c && (c.message || c.text));
    if (!cs.length) return body.append(el('div', { class: 'muted', text: 'Отзывов пока нет' }));
    cs.forEach(c => body.append(el('div', { class: 'comment' },
      el('div', { class: 'meta', text: [c.user_name || 'Аноним', fmtDate(c.date || c.time)].filter(Boolean).join(' · ') }),
      el('div', { class: 'msg', text: c.message || c.text }))));
  }

  function renderBody() {
    const body = $('sheet-body'); body.textContent = '';
    if (!cur) return;
    const { obj, detail, error } = cur;
    $('tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'info') renderInfo(body, obj, detail);
    else if (tab === 'photos') renderPhotos(body, detail || {});
    else renderComments(body, detail || {});
    if (error) body.append(el('div', { class: 'muted', text: 'Ошибка: ' + error }));
  }

  function load(obj, lang = 'ru') {
    cur.error = null;
    cur.loadingLang = lang;
    renderLangsUI();
    renderBody();

    WM.api.place(obj.id, lang).then(d => {
      if (cur && cur.obj.id === obj.id) { 
        cur.detail = d;
        cur.loadingLang = null;
        cur.lang = lang;
        if (d.title) $('sheet-title').textContent = d.title;

        if (WM.cache && WM.cache.markVisited) {
          WM.cache.markVisited(obj.id, d);
        }
        if (WM.view && WM.view.updateObjectStyle) {
          WM.view.updateObjectStyle(obj.id);
        }

        renderLangsUI();
        renderBody(); 

        const respIso = (d.language_iso || '').toLowerCase();
        if (lang !== 'ru' && respIso && respIso !== lang && !d.description) {
          showToast(`Для этого объекта нет описания на ${LANG_NAMES[lang]?.name || lang}`);
        }
      }
    }).catch(e => { 
      if (cur && cur.obj.id === obj.id) { 
        cur.error = e.message; 
        cur.loadingLang = null;
        renderLangsUI();
        renderBody(); 
      } 
    });
  }

  function closeSheet(syncHistory = true) {
    const sheet = $('sheet');
    sheet.style.transform = '';
    sheet.classList.remove('open', 'full');
    const expandBtn = $('sheet-expand');
    if (expandBtn) {
      expandBtn.textContent = '⤢';
      expandBtn.title = 'Развернуть';
    }
    document.body.classList.remove('sheet-open');
    cur = null;
    if (WM.view) WM.view.setSelected(null);
    if (WM.picker) WM.picker.refresh();
    if (syncHistory) clearHistoryState('sheet');
  }

  let lbScale = 1, lbPanX = 0, lbPanY = 0;
  let lbStartDist = 0, lbStartScale = 1;
  let lbLastTouch = null, lbLastTap = 0;

  function updateLbImgTransform() {
    const img = $('lb-img');
    if (img) img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbScale})`;

    const range = $('lb-zoom-range');
    const valText = $('lb-zoom-val');
    if (range) range.value = lbScale;
    if (valText) valText.textContent = Math.round(lbScale * 100) + '%';
  }

  function resetLbTransform() {
    lbScale = 1; lbPanX = 0; lbPanY = 0;
    updateLbImgTransform();
  }

  function initLightboxGestures() {
    const vp = $('lb-viewport');
    const lbEl = $('lightbox');
    if (!vp || !lbEl) return;

    const btnIn = $('lb-zoom-in');
    const btnOut = $('lb-zoom-out');
    const btnReset = $('lb-zoom-reset');
    const range = $('lb-zoom-range');

    const btnPrev = $('lb-prev');
    const btnNext = $('lb-next');
    if (btnPrev) {
      btnPrev.onclick = (e) => {
        e.stopPropagation();
        showLbPhoto(lb.i - 1);
      };
    }
    if (btnNext) {
      btnNext.onclick = (e) => {
        e.stopPropagation();
        showLbPhoto(lb.i + 1);
      };
    }

    if (btnIn) {
      btnIn.onclick = (e) => {
        e.stopPropagation();
        lbScale = Math.min(5, Math.round((lbScale + 0.5) * 10) / 10);
        updateLbImgTransform();
      };
    }
    if (btnOut) {
      btnOut.onclick = (e) => {
        e.stopPropagation();
        lbScale = Math.max(1, Math.round((lbScale - 0.5) * 10) / 10);
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
      };
    }
    if (range) {
      range.oninput = (e) => {
        lbScale = parseFloat(e.target.value);
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
      };
    }
    if (btnReset) {
      btnReset.onclick = (e) => {
        e.stopPropagation();
        resetLbTransform();
      };
    }

    window.addEventListener('keydown', e => {
      if (lbEl.hidden) return;
      if (e.key === 'ArrowRight') {
        showLbPhoto(lb.i + 1);
      } else if (e.key === 'ArrowLeft') {
        showLbPhoto(lb.i - 1);
      } else if (e.key === 'Escape') {
        closeLightbox(true);
      }
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      lbScale = Math.min(5, Math.max(1, Math.round((lbScale + delta) * 100) / 100));
      if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
      updateLbImgTransform();
    }, { passive: false });

    let isMouseDown = false, mouseStart = null, mouseTotalMove = 0;
    vp.addEventListener('mousedown', e => {
      if (e.target.closest('.lb-zoom-controls') || e.target.closest('.lb-btn')) return;
      isMouseDown = true;
      mouseStart = { x: e.clientX, y: e.clientY };
      mouseTotalMove = 0;
    });

    window.addEventListener('mousemove', e => {
      if (isMouseDown && mouseStart) {
        const dx = e.clientX - mouseStart.x;
        const dy = e.clientY - mouseStart.y;
        mouseTotalMove += Math.hypot(dx, dy);
        if (lbScale > 1) {
          lbPanX += dx;
          lbPanY += dy;
          updateLbImgTransform();
        }
        mouseStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mouseup', e => {
      if (!isMouseDown) return;
      isMouseDown = false;
      if (mouseTotalMove < 6 && (e.target === vp || e.target === lbEl)) {
        closeLightbox(true);
      }
      mouseStart = null;
    });

    let touchStartPt = null;
    let touchStartTime = 0;
    let touchHasMoved = false;
    let isDoubleTapDragging = false;
    let doubleTapAnchorY = 0;
    let doubleTapStartScale = 1;
    let pendingTapTimer = null;

    vp.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
        isDoubleTapDragging = false;
        lbStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        lbStartScale = lbScale;
        return;
      }

      if (e.touches.length !== 1) return;

      const t = e.touches[0];
      const now = Date.now();
      const pt = { x: t.clientX, y: t.clientY };
      touchStartPt = pt;
      touchStartTime = now;
      touchHasMoved = false;

      const isSecondTap = lbLastTouch && 
        (now - lbLastTap < 320) && 
        (Math.hypot(pt.x - lbLastTouch.x, pt.y - lbLastTouch.y) < 36);

      if (isSecondTap) {
        if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
        isDoubleTapDragging = true;
        doubleTapAnchorY = pt.y;
        doubleTapStartScale = lbScale;
      } else {
        lbLastTouch = pt;
      }
    }, { passive: false });

    vp.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (lbStartDist > 0) {
          lbScale = Math.min(5, Math.max(1, Math.round(lbStartScale * (dist / lbStartDist) * 100) / 100));
          if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
          updateLbImgTransform();
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const t = e.touches[0];

      if (isDoubleTapDragging) {
        e.preventDefault();
        touchHasMoved = true;
        const deltaY = doubleTapAnchorY - t.clientY;
        const newScale = Math.min(5, Math.max(1, doubleTapStartScale + deltaY / 120));
        lbScale = Math.round(newScale * 100) / 100;
        if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
        updateLbImgTransform();
        return;
      }

      if (lbScale > 1 && touchStartPt) {
        const dx = t.clientX - touchStartPt.x;
        const dy = t.clientY - touchStartPt.y;
        if (Math.hypot(dx, dy) > 8) touchHasMoved = true;
        lbPanX += dx;
        lbPanY += dy;
        touchStartPt = { x: t.clientX, y: t.clientY };
        updateLbImgTransform();
        return;
      }

      if (touchStartPt && Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > 10) {
        touchHasMoved = true;
      }
    }, { passive: false });

    vp.addEventListener('touchend', e => {
      if (e.touches.length > 0) return;

      const now = Date.now();

      if (isDoubleTapDragging) {
        isDoubleTapDragging = false;
        if (!touchHasMoved) {
          if (lbScale > 1) resetLbTransform();
          else { lbScale = 2.5; updateLbImgTransform(); }
        }
        lbLastTap = 0;
        lbLastTouch = null;
        return;
      }

      if (touchStartPt && !touchHasMoved) {
        const tappedTarget = e.target;
        lbLastTap = now;

        if (pendingTapTimer) clearTimeout(pendingTapTimer);
        pendingTapTimer = setTimeout(() => {
          pendingTapTimer = null;
          if (tappedTarget === vp || tappedTarget === lbEl) {
            closeLightbox(true);
          }
        }, 300);
      } else if (touchStartPt && touchHasMoved && lbScale === 1) {
        const endT = e.changedTouches[0];
        const dx = endT.clientX - touchStartPt.x;
        const dy = endT.clientY - touchStartPt.y;
        
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) {
            showLbPhoto(lb.i + 1);
          } else {
            showLbPhoto(lb.i - 1);
          }
        }
      }

      touchStartPt = null;
    });
  }

  function initSheetGestures() {
    const sheet = $('sheet');
    const sheetBody = $('sheet-body');
    let startY = 0, curDeltaY = 0, isDraggingSheet = false;

    function isEligibleDragTarget(target) {
      if (target.closest('.icon-btn, button, a, input, select, textarea, .coords-card, .photo-grid img, .chip, .lang-chip, .tab-btn')) {
        return false;
      }
      if (target.closest('#sheet-head') || target.id === 'sheet-title') {
        return true;
      }
      if (sheet.classList.contains('full') && sheetBody && sheetBody.scrollTop > 5) {
        return false;
      }
      const textNode = target.closest('.desc, .comment, .row, .msg, .meta, .tag');
      if (textNode) {
        return false;
      }

      return true;
    }

    sheet.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      if (!isEligibleDragTarget(e.target)) return;

      startY = e.touches[0].clientY;
      curDeltaY = 0;
      isDraggingSheet = true;
      sheet.style.transition = 'none';
    }, { passive: true });

    window.addEventListener('touchmove', e => {
      if (!isDraggingSheet) return;
      const dy = e.touches[0].clientY - startY;
      curDeltaY = dy;
      const isFull = sheet.classList.contains('full');

      if (isFull) {
        if (dy < 0) {
          sheet.style.transform = `translateY(${dy * 0.18}px)`;
        } else {
          sheet.style.transform = `translateY(${dy}px)`;
        }
      } else {
        sheet.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      sheet.style.transition = '';

      const isFull = sheet.classList.contains('full');
      const expandBtn = $('sheet-expand');
      const winH = window.innerHeight;

      if (isFull) {
        if (curDeltaY > Math.max(220, winH * 0.35)) {
          closeSheet(true);
        } else if (curDeltaY > 70) {
          sheet.style.transform = '';
          sheet.classList.remove('full');
          if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
        } else {
          sheet.style.transform = '';
        }
      } else {
        if (curDeltaY < -60) {
          sheet.style.transform = '';
          sheet.classList.add('full');
          if (expandBtn) { expandBtn.textContent = '⤡'; expandBtn.title = 'Свернуть'; }
        } else if (curDeltaY > 70) {
          closeSheet(true);
        } else {
          sheet.style.transform = '';
        }
      }
      curDeltaY = 0;
    }, { passive: true });

    window.addEventListener('touchcancel', () => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      curDeltaY = 0;
    });
  }

  let searchSource = 'all';
  let searchDebounceTimer = null;

  async function executeSearch(query) {
    const listEl = $('search-results');
    const q = (query || '').trim();
    if (q.length < 2) {
      listEl.textContent = '';
      listEl.append(el('div', { class: 'muted', text: 'Введите минимум 2 символа для поиска…' }));
      return;
    }

    listEl.textContent = '';
    listEl.append(el('div', { class: 'muted', text: '🔍 Поиск…' }));

    const center = WM.map ? WM.map.getCenter() : { lat: 55.75, lng: 37.61 };
    const qLower = q.toLowerCase();

    const localMatches = [];
    if (searchSource === 'all' || searchSource === 'wm') {
      for (const obj of WM.cache.objects.values()) {
        const titleMatch = obj.title && obj.title.toLowerCase().includes(qLower);
        const idMatch = String(obj.id) === q;
        if (titleMatch || idMatch) {
          const coords = getCentroidCoords(obj);
          localMatches.push({
            id: obj.id,
            title: obj.title || ('Объект #' + obj.id),
            subtitle: `Wikimapia ID: ${obj.id} · в памяти`,
            lat: parseFloat(coords.lat),
            lon: parseFloat(coords.lon),
            source: 'wm',
            inCache: true,
            obj
          });
          if (localMatches.length >= 10) break;
        }
      }
    }

    const promises = [];
    if (searchSource === 'all' || searchSource === 'osm') {
      promises.push(WM.api.geocodeOSM(q, center.lat, center.lng));
    } else {
      promises.push(Promise.resolve([]));
    }

    if (searchSource === 'all' || searchSource === 'wm') {
      promises.push(WM.api.search(q, center.lat, center.lng));
    } else {
      promises.push(Promise.resolve([]));
    }

    let results = [...localMatches];

    try {
      const [osmRes, wmRaw] = await Promise.all(promises);

      const wmRes = [];
      const seenIds = new Set(localMatches.map(m => String(m.id)));

      for (const it of (wmRaw || [])) {
        if (!it || it.id == null || seenIds.has(String(it.id))) continue;
        seenIds.add(String(it.id));

        let lat = null, lon = null;
        if (it.lat != null && it.lon != null) {
          lat = parseFloat(it.lat);
          lon = parseFloat(it.lon);
        } else if (it.location) {
          if (it.location.lat != null && it.location.lon != null) {
            lat = parseFloat(it.location.lat);
            lon = parseFloat(it.location.lon);
          } else if (it.location.north != null && it.location.south != null) {
            lat = (parseFloat(it.location.north) + parseFloat(it.location.south)) / 2;
            lon = (parseFloat(it.location.east) + parseFloat(it.location.west)) / 2;
          }
        } else if (Array.isArray(it.polygon) && it.polygon.length) {
          lat = it.polygon.reduce((acc, p) => acc + parseFloat(p.y), 0) / it.polygon.length;
          lon = it.polygon.reduce((acc, p) => acc + parseFloat(p.x), 0) / it.polygon.length;
        }

        if (lat == null || isNaN(lat)) lat = center.lat;
        if (lon == null || isNaN(lon)) lon = center.lng;

        wmRes.push({
          id: it.id,
          title: it.title || it.name || ('Объект #' + it.id),
          subtitle: `Wikimapia ID: ${it.id}`,
          lat,
          lon,
          source: 'wm',
          inCache: false,
          raw: it
        });
      }

      results = [...results, ...wmRes, ...(osmRes || [])];
    } catch (e) {
      console.warn('Ошибка при поиске:', e);
    }

    listEl.textContent = '';
    if (!results.length) {
      listEl.append(el('div', { class: 'muted', text: 'Ничего не найдено' }));
      return;
    }

    results.forEach(res => {
      const isWm = res.source === 'wm';
      const itemEl = el('div', {
        class: 'search-result-item',
        onclick: async () => {
          $('modal-search').classList.remove('open');
          if (isWm) {
            let targetObj = WM.cache.objects.get(res.id);

            if (!targetObj && res.raw && (res.raw.polygon || (res.raw.location && res.raw.location.polygon))) {
              const added = WM.cache.addItems(null, [res.raw]);
              targetObj = added[0] || WM.cache.objects.get(res.id);
            }

            if (!targetObj) {
              WM.ui.setStatus('🔍 Загрузка геометрии объекта…');
              try {
                const detail = await WM.api.place(res.id);
                if (detail) {
                  const poly = detail.polygon || (detail.location && detail.location.polygon);
                  if (Array.isArray(poly) && poly.length >= 3) {
                    const pts = poly.map(p => [+p.y, +p.x]).filter(p => isFinite(p[0]) && isFinite(p[1]));
                    if (pts.length >= 3) {
                      targetObj = {
                        id: res.id,
                        title: detail.title || res.title,
                        url: detail.urlhtml || detail.url || '',
                        pts,
                        bbox: WM.geo.bboxOf(pts),
                        area: WM.geo.areaOf(pts),
                        refs: 1
                      };
                      WM.cache.objects.set(targetObj.id, targetObj);
                      WM.cache.updateObject(targetObj); 
                    }
                  }
                }
              } catch (e) {
                console.warn('Не удалось догрузить геометрию объекта:', e);
              } finally {
                WM.ui.updateStatusFromLoader();
              }
            }

            if (targetObj) {
              const c = targetObj.bbox;
              const centerLat = (c.s + c.n) / 2;
              const centerLng = (c.w + c.e) / 2;
              WM.view.render();
              WM.map.flyTo([centerLat, centerLng], Math.max(WM.map.getZoom(), 16), { animate: true });
              setTimeout(() => {
                WM.picker.select(targetObj, [targetObj]);
              }, 300);
            } else {
              WM.map.flyTo([res.lat, res.lon], Math.max(WM.map.getZoom(), 16), { animate: true });
              const dummyObj = { id: res.id, title: res.title, bbox: { s: res.lat, n: res.lat, w: res.lon, e: res.lon }, pts: [] };
              setTimeout(() => {
                WM.picker.select(dummyObj, [dummyObj]);
              }, 300);
            }
          } else {
            WM.map.flyTo([res.lat, res.lon], 16, { animate: true });
          }
        }
      },
        el('div', { class: 'search-res-top' },
          el('span', { class: 'search-res-title', text: res.title }),
          el('span', {
            class: 'search-badge ' + (isWm ? 'search-badge-wm' : 'search-badge-osm'),
            text: isWm ? (res.inCache ? 'Wikimapia (кэш)' : 'Wikimapia') : 'Адрес / OSM'
          })
        ),
        res.subtitle ? el('div', { class: 'search-res-subtitle', text: res.subtitle }) : null
      );
      listEl.append(itemEl);
    });
  }

  function initSearchUI() {
    const btnSearch = $('btn-search');
    const modalSearch = $('modal-search');
    const inputSearch = $('search-input');
    const btnClear = $('search-clear-btn');

    if (btnSearch) {
      btnSearch.onclick = () => {
        pushHistoryState('search');
        modalSearch.classList.add('open');
        setTimeout(() => inputSearch.focus(), 100);
      };
    }

    $('search-x').onclick = () => modalSearch.classList.remove('open');

    inputSearch.oninput = () => {
      const val = inputSearch.value;
      btnClear.hidden = !val;
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => executeSearch(val), 350);
    };

    btnClear.onclick = () => {
      inputSearch.value = '';
      btnClear.hidden = true;
      executeSearch('');
      inputSearch.focus();
    };

    document.querySelectorAll('.search-tab-btn').forEach(tabBtn => {
      tabBtn.onclick = () => {
        document.querySelectorAll('.search-tab-btn').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        searchSource = tabBtn.dataset.source;
        executeSearch(inputSearch.value);
      };
    });
  }

  function populateStyleInputs() {
    const v = WM.view.getVectorStyle();
    $('vec-stroke-color').value = v.color;
    $('vec-stroke-color-val').textContent = v.color;
    $('vec-stroke-width').value = v.weight;
    $('vec-stroke-width-val').textContent = v.weight + ' px';
    $('vec-fill-color').value = v.fillColor;
    $('vec-fill-color-val').textContent = v.fillColor;
    $('vec-fill-opacity').value = Math.round(v.fillOpacity * 100);
    $('vec-fill-opacity-val').textContent = Math.round(v.fillOpacity * 100) + '%';
    $('vec-hover-color').value = v.hoverColor;
    $('vec-hover-color-val').textContent = v.hoverColor;
    $('vec-sel-color').value = v.selectedColor;
    $('vec-sel-color-val').textContent = v.selectedColor;

    $('rast-opacity').value = rasterStyle.opacity;
    $('rast-opacity-val').textContent = rasterStyle.opacity + '%';
    $('rast-contrast').value = rasterStyle.contrast;
    $('rast-contrast-val').textContent = rasterStyle.contrast + '%';
    $('rast-saturate').value = rasterStyle.saturate;
    $('rast-saturate-val').textContent = rasterStyle.saturate + '%';
    $('rast-brightness').value = rasterStyle.brightness;
    $('rast-brightness-val').textContent = rasterStyle.brightness + '%';
    $('rast-shadow').checked = rasterStyle.shadow;
    $('rast-invert').checked = rasterStyle.invert;
  }

  function readVectorInputs() {
    return {
      color: $('vec-stroke-color').value,
      weight: parseFloat($('vec-stroke-width').value),
      fillColor: $('vec-fill-color').value,
      fillOpacity: parseFloat($('vec-fill-opacity').value) / 100,
      hoverColor: $('vec-hover-color').value,
      selectedColor: $('vec-sel-color').value
    };
  }

  function readRasterInputs() {
    return {
      opacity: parseInt($('rast-opacity').value, 10),
      contrast: parseInt($('rast-contrast').value, 10),
      saturate: parseInt($('rast-saturate').value, 10),
      brightness: parseInt($('rast-brightness').value, 10),
      shadow: $('rast-shadow').checked,
      invert: $('rast-invert').checked
    };
  }

  // =========================================================================
  // МОБИЛЬНЫЕ ПОДСКАЗКИ ПРИ ДОЛГОМ НАЖАТИИ (LONG-PRESS TOOLTIP)
  // =========================================================================
  function initMobileTooltips() {
    const tooltipEl = $('ui-tooltip');
    let holdTimer = null;
    let targetEl = null;
    let touchStartPt = null;
    let longPressTriggered = false;
    let hideTimer = null;

    const TOOLTIPS = {
      'btn-mode-toggle': () => {
        const isCross = WM.picker && WM.picker.getMode() === 'cross';
        return isCross 
          ? '🎯 Режим «Перекрестие»\nНаведите прицел в центре экрана для выбора объекта (тапните для смены на палец)' 
          : '👆 Режим «Палец»\nВыбирайте объекты прямым нажатием на карту (тапните для смены на прицел)';
      },
      'btn-measure': () => '📏 Линейка: измерение расстояний на карте, добавление узлов и нескольких треков',
      'btn-add-marker': () => '📍 Добавить метку: создать заметку с эмодзи в центре экрана с возможностью перемещения',
      'btn-download-area': () => '📥 Скачать область: сохранить контуры и описания видимой области для автономной работы',
      'btn-location': () => '🛰️ Моя геопозиция: определить и показать текущие координаты по GPS',
      'btn-theme-toggle': () => '🌙/☀️ Смена темы: переключение между тёмной и светлой темой оформления',
      'btn-settings': () => '⚙️ Настройки: режимы расхода API, управление ключами, оформление контуров и экспорт',
      'btn-search': () => '🔍 Поиск: поиск по названию, адресу, координатам или ID Wikimapia',
      'limit-badge': () => '🔑 Лимит API: число обращений к сайту Wikimapia за сутки (сброс в полночь по времени PT)',
      'limit-row': () => '🔑 Лимит API: состояние квоты текущего ключа и кнопка принудительного обновления',
      'btn-force-refresh': () => '🔄 Обновить: сбросить ограничения и принудительно догрузить недостающие полигоны на экране',
      'btn-get-key-top': () => '🔑 Добавить ключ: открыть настройки для добавления API-ключа Wikimapia',
      'status': () => 'ℹ️ Статус системы: текущий режим загрузки, число объектов в памяти и состояние сети',
      'tag-filter-badge': () => '🏷️ Фильтр тега: подсвечены только объекты выбранной категории',
      'tag-filter-refresh': () => '🔄 Искать тег: найти объекты данной категории на текущем видимом экране',
      'tag-filter-clear': () => '✕ Сбросить тег: вернуть стандартное отображение всех объектов',
      'hover-pill': () => '📑 Карточка объекта: нажмите, чтобы открыть полное описание, фотографии и отзывы',
      'crosshair': () => '✛ Прицел: центр экрана для точечного выбора и загрузки объектов',
      'btn-measure-undo': () => '↩ Отменить узел: удалить последнюю поставленную точку измерения',
      'btn-measure-finish': () => '✓ Фиксация: зафиксировать измерение или продолжить добавление узлов',
      'btn-measure-clear': () => '🗑️ Удалить измерение: стереть текущую линию с карты',
      'btn-measure-close': () => '✕ Закрыть линейку: скрыть панель измерений с экрана',
      'btn-measure-new': () => '＋ Новое измерение: начать рисовать ещё одну независимую линию',
      'btn-measure-rename': () => '✏️ Переименовать: изменить название текущего измерения'
    };

    function getTooltipText(elem) {
      if (!elem) return '';
      if (elem.id && TOOLTIPS[elem.id]) {
        return typeof TOOLTIPS[elem.id] === 'function' ? TOOLTIPS[elem.id]() : TOOLTIPS[elem.id];
      }

      if (elem.classList.contains('leaflet-control-zoom-in')) {
        return '➕ Приблизить: увеличить масштаб карты';
      }
      if (elem.classList.contains('leaflet-control-zoom-out')) {
        return '➖ Отдалить: уменьшить масштаб карты';
      }
      if (elem.classList.contains('leaflet-control-layers-toggle')) {
        return '🗺️ Слои карты: выбор спутников, топокарт, схем и Ж/Д сетей';
      }

      const parentKey = Object.keys(TOOLTIPS).find(k => elem.closest && elem.closest('#' + k));
      if (parentKey) {
        return typeof TOOLTIPS[parentKey] === 'function' ? TOOLTIPS[parentKey]() : TOOLTIPS[parentKey];
      }

      const title = elem.getAttribute('title') || elem.getAttribute('aria-label');
      if (title) return title;

      return '';
    }

    function showTooltipNear(elem, text) {
      if (!tooltipEl || !text) return;
      clearTimeout(hideTimer);
      tooltipEl.textContent = text;
      tooltipEl.hidden = false;
      tooltipEl.classList.add('visible');

      const rect = elem.getBoundingClientRect();
      const ttW = tooltipEl.offsetWidth || 240;
      const ttH = tooltipEl.offsetHeight || 60;
      const winW = window.innerWidth;

      let top = rect.top - ttH - 12;
      let left = rect.left + rect.width / 2 - ttW / 2;

      if (top < 12) {
        top = rect.bottom + 12;
      }
      if (left < 12) left = 12;
      if (left + ttW > winW - 12) left = winW - ttW - 12;

      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${left}px`;

      hideTimer = setTimeout(hideTooltip, 3000);
    }

    function hideTooltip() {
      clearTimeout(hideTimer);
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
        tooltipEl.hidden = true;
      }
    }

    function onTouchStart(e) {
      if (e.touches.length !== 1) {
        cancelHold();
        return;
      }

      const target = e.target.closest('button, a, .limit-badge, .limit-row, .status-bar, .tag-filter-badge, .hover-pill, .leaflet-control-zoom-in, .leaflet-control-zoom-out, .leaflet-control-layers-toggle');
      if (!target) return;

      const text = getTooltipText(target);
      if (!text) return;

      targetEl = target;
      touchStartPt = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      longPressTriggered = false;

      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(35);
        showTooltipNear(targetEl, text);
      }, 420);
    }

    function onTouchMove(e) {
      if (!touchStartPt) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > 10) {
        cancelHold();
      }
    }

    function onTouchEnd() {
      if (longPressTriggered && targetEl) {
        const suppressTarget = targetEl;
        const suppressClick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          suppressTarget.removeEventListener('click', suppressClick, true);
        };
        suppressTarget.addEventListener('click', suppressClick, true);
        setTimeout(() => suppressTarget.removeEventListener('click', suppressClick, true), 350);
      }
      cancelHold();
    }

    function cancelHold() {
      clearTimeout(holdTimer);
      holdTimer = null;
      touchStartPt = null;
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', cancelHold, { passive: true });

    window.addEventListener('contextmenu', (e) => {
      const target = e.target.closest && e.target.closest('button, a, .floating-btn, .square-btn-top, .limit-badge, .status-bar');
      if (target) {
        e.preventDefault();
      }
    });
  }

  WM.ui = {
    openPlace(obj, alts) {
      cur = { obj, detail: null, error: null, lang: 'ru', loadingLang: 'ru' }; 
      tab = 'info';
      $('sheet-title').textContent = obj.title || 'Безымянный объект';
      
      const a = $('sheet-alts'); a.textContent = '';
      if (alts.length > 1) alts.forEach(x => a.append(el('button', {
        class: 'chip' + (x.id === obj.id ? ' active' : ''), 
        text: x.title || ('#' + x.id), 
        onclick: () => WM.picker.select(x, alts)
      })));

      renderLangsUI();

      $('sheet-body').scrollTop = 0;
      $('sheet').style.transform = '';
      $('sheet').classList.remove('full');
      const expandBtn = $('sheet-expand');
      if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
      $('sheet').classList.add('open'); 
      document.body.classList.add('sheet-open');
      pushHistoryState('sheet');
      load(obj, 'ru');
    },
    closeSheet,
    showToast,
    setPill(obj, count) {
      const p = $('hover-pill');
      if (!obj || !uiVis.pill) { p.hidden = true; return; }
      p.hidden = false;

      const rawTitle = obj.title || 'Безымянный объект';
      const safeTitle = escapeHtml(rawTitle) + (count > 1 ? ` (+${count - 1})` : '') + '  ›';
      if (obj.hasDetail) {
        const ph = Number(obj.photosCount) || 0;
        const cm = Number(obj.commentsCount) || 0;
        p.innerHTML = `<span class="pill-title">${safeTitle}</span><span class="pill-meta">📷 ${ph} · 💬 ${cm} · просмотрено</span>`;
      } else {
        p.innerHTML = `<span class="pill-title">${safeTitle}</span>`;
      }
    },
    updateTagFilterHUD(tag, count = 0) {
      const badge = $('tag-filter-badge');
      if (!badge) return;
      if (!tag) {
        badge.hidden = true;
        return;
      }
      badge.hidden = false;
      const textEl = $('tag-filter-text');
      if (textEl) textEl.textContent = `🏷️ «${tag.title}» (${count})`;
    },
    setStatus(text, warn) {
      const s = $('status');
      if (s) {
        s.textContent = text;
        s.classList.toggle('warn', !!warn);
      }
    },
    updateStatusFromLoader() {
      if (window.refreshAppStatus) window.refreshAppStatus();
    },
    getWorkMode() { return workMode; },
    isAutoHoverEnabled() { return autoHoverEnabled; },
    fmtTimer,
    openKeysSettings,
    toggleTopGetKeyBtn,
    init() {
      const savedTheme = WM.api.store.get('wm_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(savedTheme);
      $('btn-theme-toggle').onclick = toggleTheme;

      try {
        const savedVis = JSON.parse(WM.api.store.get('wm_ui_vis') || '{}');
        uiVis = { ...UI_VIS_DEFAULT, ...savedVis };
      } catch (e) {}

      VIS_KEYS.forEach(k => {
        const chk = $('toggle-ui-' + k);
        if (chk) chk.checked = uiVis[k] !== false;
      });
      applyUIVisibility();

      $('toggle-auto-hover').checked = autoHoverEnabled;

      const radios = document.querySelectorAll('input[name="app-work-mode"]');
      radios.forEach(r => {
        if (r.value === workMode) r.checked = true;
      });

      setInterval(updateLimitHUD, 1000);
      updateLimitHUD(); 

      const btnGetKeyTop = $('btn-get-key-top');
      if (btnGetKeyTop) {
        btnGetKeyTop.onclick = openKeysSettings;
      }

      const clearTagBtn = $('tag-filter-clear');
      if (clearTagBtn) {
        clearTagBtn.onclick = () => {
          if (WM.view && WM.view.clearTagFilter) {
            WM.view.clearTagFilter();
          }
        };
      }
      const refreshTagBtn = $('tag-filter-refresh');
      if (refreshTagBtn) {
        refreshTagBtn.onclick = async () => {
          refreshTagBtn.classList.remove('spinning');
          void refreshTagBtn.offsetWidth;
          refreshTagBtn.classList.add('spinning');

          const curTag = WM.view.getActiveTag();
          if (curTag && WM.loader && WM.loader.fetchCategoryInBounds) {
            showToast(`🏷️ Поиск «${curTag.title}» в текущей области…`, 1300);
            await WM.loader.fetchCategoryInBounds(curTag);
          }
        };
      }

      const btnForceRefresh = $('btn-force-refresh');
      if (btnForceRefresh) {
        btnForceRefresh.onclick = async () => {
          btnForceRefresh.classList.remove('spinning');
          void btnForceRefresh.offsetWidth;
          btnForceRefresh.classList.add('spinning');

          WM.api.resetAllLimits();
          updateLimitHUD();

          const pickerMode = WM.picker.getMode();
          if (pickerMode === 'cross') {
            showToast('🎯 Загрузка объектов в центре…', 1400);
            await WM.picker.fetchAtCrosshair();
          } else {
            const zoom = WM.map ? WM.map.getZoom() : 0;
            if (zoom >= WM.config.VECTOR_ZOOM) {
              showToast('📥 Загрузка недостающих объектов…', 1400);
              WM.loader.loadVisibleNow();
            } else {
              showToast('🔍 Карта отдалена — приблизьте для загрузки', 2000);
            }
          }
        };
      }

      $('tabs').onclick = e => { const t = e.target.dataset.tab; if (t) { tab = t; renderBody(); } };
      $('sheet-close').onclick = closeSheet;
      $('sheet-expand').onclick = () => {
        const isFull = $('sheet').classList.toggle('full');
        $('sheet-expand').textContent = isFull ? '⤡' : '⤢';
        $('sheet-expand').title = isFull ? 'Свернуть' : 'Развернуть';
      };
      $('hover-pill').onclick = () => WM.picker.openHover();
      $('lb-close').onclick = () => closeLightbox(true);

      window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('lightbox').hidden) {
          $('lightbox').hidden = true;
          resetLbTransform();
        }
      });

      $('btn-mode-toggle').onclick = () => WM.picker.toggleMode();

      initSearchUI();
      initLightboxGestures();
      initSheetGestures();
      initMobileTooltips();

      const onVecInput = () => {
        const cfg = readVectorInputs();
        $('vec-stroke-color-val').textContent = cfg.color;
        $('vec-stroke-width-val').textContent = cfg.weight + ' px';
        $('vec-fill-color-val').textContent = cfg.fillColor;
        $('vec-fill-opacity-val').textContent = Math.round(cfg.fillOpacity * 100) + '%';
        $('vec-hover-color-val').textContent = cfg.hoverColor;
        $('vec-sel-color-val').textContent = cfg.selectedColor;
        WM.view.applyVectorStyle(cfg);
      };

      ['vec-stroke-color', 'vec-stroke-width', 'vec-fill-color', 'vec-fill-opacity', 'vec-hover-color', 'vec-sel-color']
        .forEach(id => { $(id).oninput = onVecInput; });

      const onRastInput = () => {
        const cfg = readRasterInputs();
        $('rast-opacity-val').textContent = cfg.opacity + '%';
        $('rast-contrast-val').textContent = cfg.contrast + '%';
        $('rast-saturate-val').textContent = cfg.saturate + '%';
        $('rast-brightness-val').textContent = cfg.brightness + '%';
        applyRasterCSS(cfg);
      };

      ['rast-opacity', 'rast-contrast', 'rast-saturate', 'rast-brightness', 'rast-shadow', 'rast-invert']
        .forEach(id => {
          $(id).oninput = onRastInput;
          $(id).onchange = onRastInput;
        });

      $('btn-reset-vector-style').onclick = () => {
        const def = WM.view.getDefaultVectorStyle();
        $('vec-stroke-color').value = def.color;
        $('vec-stroke-width').value = def.weight;
        $('vec-fill-color').value = def.fillColor;
        $('vec-fill-opacity').value = Math.round(def.fillOpacity * 100);
        $('vec-hover-color').value = def.hoverColor;
        $('vec-sel-color').value = def.selectedColor;
        onVecInput();
      };

      $('btn-reset-raster-style').onclick = () => {
        $('rast-opacity').value = DEFAULT_RASTER_STYLE.opacity;
        $('rast-contrast').value = DEFAULT_RASTER_STYLE.contrast;
        $('rast-saturate').value = DEFAULT_RASTER_STYLE.saturate;
        $('rast-brightness').value = DEFAULT_RASTER_STYLE.brightness;
        $('rast-shadow').checked = DEFAULT_RASTER_STYLE.shadow;
        $('rast-invert').checked = DEFAULT_RASTER_STYLE.invert;
        onRastInput();
      };

      let snapshotVector = null, snapshotRaster = null;

      $('btn-settings').onclick = () => {
        editingKeys = [...WM.api.keys];
        editingActiveIndex = WM.api.activeIndex;
        renderKeysUI();
        $('net-mode').value = WM.api.netMode;

        VIS_KEYS.forEach(k => {
          const chk = $('toggle-ui-' + k);
          if (chk) chk.checked = uiVis[k] !== false;
        });

        const currentRadios = document.querySelectorAll('input[name="app-work-mode"]');
        currentRadios.forEach(r => { r.checked = (r.value === workMode); });
        $('toggle-auto-hover').checked = autoHoverEnabled;

        populateStyleInputs();
        snapshotVector = WM.view.getVectorStyle();
        snapshotRaster = { ...rasterStyle };

        pushHistoryState('modal');
        $('modal').classList.add('open');
      };

      const inputNewKey = $('new-key-input');
      const handleAddKeyInput = () => {
        const val = inputNewKey.value.trim();
        if (val) {
          const extracted = extractWikimapiaKeys(val);
          if (extracted.length > 0) {
            addDiscoveredKeys(extracted);
            inputNewKey.value = '';
          } else {
            const trimmed = val.replace(/[^0-9a-fA-F\-]/g, '').toUpperCase();
            if (trimmed.length >= 60) {
              addDiscoveredKeys([trimmed]);
              inputNewKey.value = '';
            } else {
              alert('Некорректный формат ключа Wikimapia (ожидается 8 групп по 8 символов через дефис).');
            }
          }
        }
      };

      $('btn-add-key').onclick = handleAddKeyInput;
      inputNewKey.onkeydown = (e) => {
        if (e.key === 'Enter') handleAddKeyInput();
      };

      $('btn-paste-keys').onclick = async () => {
        let clipText = '';
        let readSuccess = false;

        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            clipText = await navigator.clipboard.readText();
            readSuccess = true;
          }
        } catch (e) {
          readSuccess = false;
        }

        if (readSuccess && clipText && clipText.trim()) {
          const keys = extractWikimapiaKeys(clipText);
          if (keys.length > 0) {
            addDiscoveredKeys(keys);
            return;
          }
        }

        const pasteModal = $('modal-paste-keys');
        const pasteTextarea = $('paste-keys-textarea');
        if (pasteModal && pasteTextarea) {
          pasteTextarea.value = (readSuccess && clipText) ? clipText : '';
          pasteModal.classList.add('open');
          setTimeout(() => pasteTextarea.focus(), 100);
        }
      };

      $('paste-keys-submit').onclick = () => {
        const val = $('paste-keys-textarea').value;
        const keys = extractWikimapiaKeys(val);
        if (!keys.length) {
          alert('Ключи Wikimapia в тексте не обнаружены.\nУбедитесь, что скопировали страницу со своими ключами на сайте wikimapia.org и повторите попытку.');
          return;
        }
        addDiscoveredKeys(keys);
        $('modal-paste-keys').classList.remove('open');
        $('paste-keys-textarea').value = '';
      };
      $('paste-keys-cancel').onclick = () => $('modal-paste-keys').classList.remove('open');
      $('paste-keys-x').onclick = () => $('modal-paste-keys').classList.remove('open');

      $('btn-keys-guide').onclick = () => $('modal-keys-guide').classList.add('open');
      $('keys-guide-close').onclick = () => $('modal-keys-guide').classList.remove('open');
      $('keys-guide-x').onclick = () => $('modal-keys-guide').classList.remove('open');

      $('btn-export-db').onclick = async () => {
        try {
          const count = await WM.cache.exportDump();
          showToast(`Экспортировано объектов: ${count}`);
        } catch (e) {
          alert('Ошибка экспорта: ' + e.message);
        }
      };

      const fileInput = $('input-import-file');
      $('btn-import-db-trigger').onclick = () => fileInput.click();

      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const count = await WM.cache.importDump(e.target.result);
            showToast(`Успешно импортировано объектов: ${count}`, 1500);
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          } catch (err) {
            alert('Ошибка импорта базы: ' + err.message);
          } finally {
            fileInput.value = '';
          }
        };
        reader.readAsText(file);
      };

      $('btn-clear-tiles').onclick = async () => {
        if (confirm('Очистить сохраненные подложки карт? Это освободит память смартфона, сохранив все загруженные полигоны и описания объектов Wikimapia.')) {
          await WM.cache.clearRasterTiles();
          alert('Кэш карт успешно очищен. Память освобождена, полигоны сохранены.');
        }
      };

      $('btn-clear-all').onclick = async () => {
        if (confirm('Очистить ВСЁ (кэш базы полигонов, сохраненные тайлы карт, все пользовательские метки и измерения линейки)?')) {
          await WM.cache.clearAllStorage();
          WM.view.render();
          WM.ui.updateStatusFromLoader();
          alert('Полная очистка выполнена: база объектов, карты, метки и измерения удалены.');
        }
      };

      const closeModal = () => {
        if (snapshotVector) WM.view.applyVectorStyle(snapshotVector);
        if (snapshotRaster) applyRasterCSS(snapshotRaster);
        $('modal').classList.remove('open');
      };

      $('modal-cancel').onclick = closeModal;
      $('modal-x').onclick = closeModal;

      $('modal-save').onclick = () => {
        VIS_KEYS.forEach(k => {
          const chk = $('toggle-ui-' + k);
          if (chk) uiVis[k] = chk.checked;
        });
        applyUIVisibility();

        autoHoverEnabled = $('toggle-auto-hover').checked;
        WM.api.store.set('wm_auto_hover', autoHoverEnabled ? 'true' : 'false');

        const checkedMode = document.querySelector('input[name="app-work-mode"]:checked');
        if (checkedMode) {
          workMode = checkedMode.value;
          WM.api.store.set('wm_work_mode', workMode);
        }

        const newVec = readVectorInputs();
        WM.api.store.set('wm_style_vector', JSON.stringify(newVec));
        WM.view.applyVectorStyle(newVec);

        rasterStyle = readRasterInputs();
        WM.api.store.set('wm_style_raster', JSON.stringify(rasterStyle));
        applyRasterCSS(rasterStyle);

        snapshotVector = null;
        snapshotRaster = null;

        WM.api.save(editingKeys, $('net-mode').value, editingActiveIndex);
        $('modal').classList.remove('open');

        if (window.syncRasterOverlay) window.syncRasterOverlay();
        WM.loader.reset();
        WM.view.render();
      };

      $('btn-download-area').onclick = () => $('modal-precache').classList.add('open');
      const closePrecache = () => {
        WM.loader.stopPrecache();
        $('modal-precache').classList.remove('open');
        $('precache-progress-wrap').hidden = true;
        $('precache-start').disabled = false;
      };
      $('precache-cancel').onclick = closePrecache;
      $('precache-x').onclick = closePrecache;

      $('precache-start').onclick = () => {
        const b = WM.map.getBounds();
        const z = +$('precache-zoom').value;
        const pWrap = $('precache-progress-wrap');
        const pBar = $('precache-progress-bar');
        const pStatus = $('precache-status');

        pWrap.hidden = false;
        $('precache-start').disabled = true;

        WM.loader.precacheArea({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }, z, (done, total) => {
          pStatus.textContent = `Скачано тайлов: ${done} из ${total}`;
          pBar.style.width = Math.round((done / total) * 100) + '%';
          if (done >= total) {
            setTimeout(() => {
              closePrecache();
              alert('Предзагрузка завершена!');
            }, 500);
          }
        });
      };
    }
  };
})();
