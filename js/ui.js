(function () {
  const WM = window.WM, $ = id => document.getElementById(id);
  let cur = null, tab = 'info', lb = { list: [], i: 0 };
  let editingKeys = [], editingActiveIndex = 0;

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
    precache: true,
    location: true,
    theme: true
  };
  let uiVis = { ...UI_VIS_DEFAULT };
  const VIS_KEYS = ['status', 'limit', 'pill', 'zoom', 'layers', 'search', 'mode', 'precache', 'location', 'theme'];

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

  // Извлечение списка доступных языков из ответа объекта Wikimapia
  function extractAvailableLanguages(detail, selectedLang = 'ru') {
    const res = new Map();

    // Базовые языки, которые доступны для принудительного переключения ВСЕГДА
    const defaultIsos = ['ru', 'en'];
    for (const iso of defaultIsos) {
      const meta = LANG_NAMES[iso];
      res.set(iso, {
        iso,
        name: meta ? `${meta.flag} ${meta.name}` : iso.toUpperCase()
      });
    }

    // Если текущий выбранный язык не ru и не en — добавляем его
    if (selectedLang && !res.has(selectedLang.toLowerCase())) {
      const iso = selectedLang.toLowerCase();
      const meta = LANG_NAMES[iso];
      res.set(iso, {
        iso,
        name: meta ? `${meta.flag} ${meta.name}` : iso.toUpperCase()
      });
    }

    if (!detail) return Array.from(res.values());

    // Язык самой карточки из ответа сервера (если объект исходно на другом языке)
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

    // Дополнительные переводы из блока API
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
    cur.detail = null; // сбрасываем текущее тело карточки на время загрузки
    renderLangsUI();
    load(cur.obj, targetLang);
  }

  function renderInfo(body, o, d) {
    body.append(el('p', { class: 'desc', text: (d && d.description) || (d ? 'Описание отсутствует.' : 'Загрузка…') }));
    
    const tags = list(d && d.tags).map(t => t && (t.title || t.name)).filter(Boolean);
    if (tags.length) body.append(el('div', { class: 'tags' }, tags.map(t => el('span', { class: 'tag', text: t }))));

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
  }

  function renderPhotos(body, d) {
    const photos = list(d.photos).filter(p => p && (p.thumbnail_url || p['1280_url'] || p.big_url));
    if (!photos.length) return body.append(el('div', { class: 'muted', text: 'Фотографий нет' }));
    lb.list = photos;
    body.append(el('div', { class: 'photo-grid' }, photos.map((p, i) =>
      el('img', { src: safeUrl(p.thumbnail_url || p['1280_url']), loading: 'lazy', onclick: () => {
        lb.i = i;
        resetLbTransform();
        $('lightbox').hidden = false;
        $('lb-img').src = safeUrl(p['1280_url'] || p.big_url || p.thumbnail_url);
        $('lb-cap').textContent = `${i + 1} / ${photos.length}`;
      }}))));
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
        renderLangsUI();
        renderBody(); 

        // Проверяем, вернул ли сервер текст на запрошенном языке
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
  function closeSheet() {
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
    WM.view.setSelected(null);
    WM.picker.refresh();
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
    if (!vp) return;

    const btnIn = $('lb-zoom-in');
    const btnOut = $('lb-zoom-out');
    const btnReset = $('lb-zoom-reset');
    const range = $('lb-zoom-range');

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

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      lbScale = Math.min(5, Math.max(1, Math.round((lbScale + delta) * 100) / 100));
      if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
      updateLbImgTransform();
    }, { passive: false });

    let isMouseDown = false, mouseStart = null;
    vp.addEventListener('mousedown', e => {
      if (e.target.closest('.lb-zoom-controls') || e.target.closest('.lb-btn')) return;
      if (lbScale > 1) {
        isMouseDown = true;
        mouseStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mousemove', e => {
      if (isMouseDown && mouseStart) {
        lbPanX += e.clientX - mouseStart.x;
        lbPanY += e.clientY - mouseStart.y;
        mouseStart = { x: e.clientX, y: e.clientY };
        updateLbImgTransform();
      }
    });

    window.addEventListener('mouseup', () => {
      isMouseDown = false;
      mouseStart = null;
    });

    vp.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        lbStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        lbStartScale = lbScale;
      } else if (e.touches.length === 1) {
        lbLastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });

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
      } else if (e.touches.length === 1 && lbScale > 1 && lbLastTouch) {
        const dx = e.touches[0].clientX - lbLastTouch.x;
        const dy = e.touches[0].clientY - lbLastTouch.y;
        lbPanX += dx;
        lbPanY += dy;
        lbLastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        updateLbImgTransform();
      }
    }, { passive: true });

    vp.addEventListener('touchend', e => {
      if (e.touches.length === 0) {
        lbLastTouch = null;
        lbStartDist = 0;
        const now = Date.now();
        if (now - lbLastTap < 300) {
          if (lbScale > 1) {
            resetLbTransform();
          } else {
            lbScale = 2.5;
            updateLbImgTransform();
          }
          lbLastTap = 0;
        } else {
          lbLastTap = now;
        }
      }
    }, { passive: true });
  }

  function initSheetGestures() {
    const sheet = $('sheet');
    const handleArea = $('sheet-head');
    let startY = 0, curDeltaY = 0, isDraggingSheet = false;

    handleArea.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      if (e.target.closest('.icon-btn')) return;
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
        if (curDeltaY > Math.max(240, winH * 0.38)) {
          closeSheet();
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
          closeSheet();
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

      // Рисуем кнопки языков сразу, не дожидаясь ответа сервера
      renderLangsUI();

      $('sheet-body').scrollTop = 0;
      $('sheet').style.transform = '';
      $('sheet').classList.remove('full');
      const expandBtn = $('sheet-expand');
      if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = 'Развернуть'; }
      $('sheet').classList.add('open'); 
      document.body.classList.add('sheet-open');
      load(obj, 'ru');
    },
    closeSheet,
    showToast,
    setPill(obj, count) {
      const p = $('hover-pill');
      if (!obj || !uiVis.pill) { p.hidden = true; return; }
      p.hidden = false;
      p.textContent = (obj.title || 'Безымянный объект') + (count > 1 ? ` (+${count - 1})` : '') + '  ›';
    },
    setStatus(text, warn) {
      const s = $('status');
      s.textContent = text;
      s.classList.toggle('warn', !!warn);
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
      $('lb-close').onclick = () => { $('lightbox').hidden = true; resetLbTransform(); };

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
            WM.view.render();
            WM.ui.updateStatusFromLoader();
            showToast(`Успешно импортировано объектов: ${count}`);
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
        if (confirm('Очистить ВЕСЬ кэш приложения (включая базу полигонов и скачанные тайлы карт)?')) {
          await WM.cache.clearAllStorage();
          WM.view.render();
          WM.ui.updateStatusFromLoader();
          alert('Полный кэш успешно сброшен.');
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
