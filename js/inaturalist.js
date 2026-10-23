(function () {
  const WM = window.WM = window.WM || {};

  const DEFAULT_CONFIG = {
    enabled: false,
    showBadge: true,
    selectMode: 'both',
    badgeDisplayMode: 'full', // 'full' | 'auto-hide' | 'center-bubble' | 'manual'
    zoomOutMode: 'grid',
    taxa: 'Plantae,Fungi',
    query: '',
    season: 'any',
    month: 'any',
    quality: 'any',
    sort: 'random',
    wildOnly: true,
    nativeOnly: false,
    threatenedOnly: false,
    photosOnly: true,
    phenology: 'any',
    lifestageInsects: 'any',
    lifestageAnimals: 'any',
    limit: 100
  };

  const PHENOLOGY_TERMS = {
    // Plant Phenology (term_id: 12)
    '12_13': { text: 'Цветёт', icon: '🌸', color: '#ec4899', bg: 'rgba(236, 72, 153, 0.14)' },
    '12_14': { text: 'Плодоносит', icon: '🍓', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)' },
    '12_15': { text: 'Бутонизация', icon: '🌿', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
    '12_21': { text: 'Вегетация (без цветков)', icon: '🌱', color: '#64748b', bg: 'rgba(100, 116, 139, 0.14)' },
    // Life Stage (term_id: 1)
    '1_2': { text: 'Взрослая особь (Имаго)', icon: '🦋', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.14)' },
    '1_3': { text: 'Линька', icon: '🔄', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.14)' },
    '1_4': { text: 'Куколка', icon: '🪺', color: '#d97706', bg: 'rgba(217, 119, 6, 0.14)' },
    '1_5': { text: 'Нимфа', icon: '🦗', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.14)' },
    '1_6': { text: 'Личинка / Гусеница', icon: '🐛', color: '#84cc16', bg: 'rgba(132, 204, 22, 0.14)' },
    '1_7': { text: 'Яйцо / Икра', icon: '🥚', color: '#eab308', bg: 'rgba(234, 179, 8, 0.14)' },
    // Sex (term_id: 9)
    '9_10': { text: 'Самка ♀', icon: '♀', color: '#ec4899', bg: 'rgba(236, 72, 153, 0.14)' },
    '9_11': { text: 'Самец ♂', icon: '♂', color: '#0284c7', bg: 'rgba(2, 132, 199, 0.14)' },
    // Alive or Dead (term_id: 17)
    '17_19': { text: 'Живой', icon: '🟢', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
    '17_20': { text: 'Погибший', icon: '☠️', color: '#64748b', bg: 'rgba(100, 116, 139, 0.14)' }
  };

   const GEOMODEL_MODES = {
    geomodel: { title: '🤖 Модель ИИ (Geomodel)', desc: 'Биоклиматическая пригодность среды', icon: '🧠' },
    taxon_ranges: { title: '📐 Научный ареал (Range)', desc: 'Официальные границы биологов и Красных книг', icon: '📐' },
    geomodel_taxon_range: { title: '🧬 ИИ + Научный ареал', desc: 'Модель ИИ, ограниченная официальным ареалом', icon: '🧬' },
    geomodel_comparison: { title: '📊 Сравнение с находками', desc: 'Сопоставление прогноза с реальными точками', icon: '📊' }
  };

  // Кэши данных для карточек
  const mapLayersCache = new Map();
  const similarSpeciesCache = new Map();
  const histogramCache = new Map();
  let lastTraitsDebugData = null;

  // =========================================================================
  // КЭШ И СЛУЖБЫ ИНТЕГРАЦИИ WIKIPEDIA REST API И WIKIDATA SPARQL
  // =========================================================================
  const wikiSummaryCache = new Map();     // title/latin -> { extract, description, thumbnail }
  const wikidataEdibilityCache = new Map(); // latin -> { edibility, edibleParts, isMedicinal }


  const LANG_NAMES_RU = {
    ru: 'Русский', en: 'Английский', de: 'Немецкий', fr: 'Французский',
    es: 'Испанский', it: 'Итальянский', zh: 'Китайский', ja: 'Японский',
    nl: 'Нидерландский', sv: 'Шведский', fi: 'Финский', no: 'Норвежский',
    nb: 'Норвежский (букмол)', nn: 'Норвежский (нюнорск)', be: 'Белорусский',
    'be-tarask': 'Белорусский (классический)', uk: 'Украинский', pl: 'Польский',
    pt: 'Португальский', ar: 'Арабский', sl: 'Словенский', ro: 'Румынский',
    tr: 'Турецкий', cs: 'Чешский', da: 'Датский', et: 'Эстонский',
    lv: 'Латышский', lt: 'Литовский', bg: 'Болгарский', sr: 'Сербский',
    hr: 'Хорватский', hu: 'Венгерский', el: 'Греческий', se: 'Северносаамский',
    ast: 'Астурийский', la: 'Латынь'
  };

  // Словарь характерных качеств и поведения животных (P1552)
  const WIKIDATA_QUALITIES_MAP = {
    'Q120446': { text: 'Территориальное животное (охраняет участок)', icon: '🛡️', pill: '🛡️ Территориальный' },
    'Q503798': { text: 'Эхолокация', icon: '🦇', pill: '🦇 Эхолокация' },
    'Q189578': { text: 'Биолюминесценция', icon: '✨', pill: '✨ Биолюминесценция' },
    'Q188902': { text: 'Ядовитый организм', icon: '☠️', pill: '☠️ Ядовитый' },
    'Q13410520': { text: 'Стайный / колониальный образ жизни', icon: '🐾', pill: '🐾 Стайный' },
    'Q118742': { text: 'Одиночный образ жизни', icon: '🦊', pill: '🦊 Одиночка' },
    'Q136395': { text: 'Яйцекладущий', icon: '🥚', pill: '🥚 Яйцекладущий' },
    'Q136423': { text: 'Живородящий', icon: '🐣', pill: '🐣 Живородящий' }
  };



  // --- КЭШИ И ДАННЫЕ ДЛЯ РАСТЕНИЙ И ГРИБОВ ---
  const plantTraitsCache = new Map();
  const fungiTraitsCache = new Map();
  let lastPlantTraitsDebugData = null;
  let lastFungiTraitsDebugData = null;

  // Жизненные формы растений (P5283 / P1552 / EOL)
  const WIKIDATA_PLANT_FORMS = {
    'Q10884': { text: 'Дерево', icon: '🌳' },
    'Q42295': { text: 'Кустарник', icon: '🪴' },
    'Q190901': { text: 'Травянистое растение (трава)', icon: '🌱' },
    'Q121404': { text: 'Лиана / вьющееся', icon: '🌿' },
    'Q1364': { text: 'Суккулент', icon: '🌵' },
    'Q145564': { text: 'Полукустарник', icon: '🌾' },
    'Q214733': { text: 'Водное растение (гидрофит)', icon: '🪷' }
  };

  // Типы опыления (P1552 / P1034)
  const WIKIDATA_POLLINATION_MAP = {
    'Q134063': { text: 'Насекомоопыляемое (энтомофилия)', icon: '🐝' },
    'Q161541': { text: 'Ветроопыляемое (анемофилия)', icon: '💨' },
    'Q1067272': { text: 'Самоопыляемое (автогамия)', icon: '🌸' },
    'Q844123': { text: 'Птицеопыляемое (орнитофилия)', icon: '🐦' }
  };

  // Функции выгрузки JSON
  function downloadPlantTraitsDebugJson() {
    if (!lastPlantTraitsDebugData) {
      if (WM.ui?.showToast) WM.ui.showToast('⚠️ Нет данных о растении для скачивания');
      return;
    }
    const str = JSON.stringify(lastPlantTraitsDebugData, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plant_traits_${lastPlantTraitsDebugData.scientificName.replace(/\s+/g, '_')}_debug.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadFungiTraitsDebugJson() {
    if (!lastFungiTraitsDebugData) {
      if (WM.ui?.showToast) WM.ui.showToast('⚠️ Нет данных о грибе для скачивания');
      return;
    }
    const str = JSON.stringify(lastFungiTraitsDebugData, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fungi_traits_${lastFungiTraitsDebugData.scientificName.replace(/\s+/g, '_')}_debug.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // БЫСТРОЕ ОКНО УПРАВЛЕНИЯ ФЛОРОЙ И ФАУНОЙ (INAT QUICK HUB)
  // =========================================================================
  function updateQuickHubTokenNotice() {
    const noticeEl = document.getElementById('inat-qhub-token-notice');
    if (!noticeEl) return;
    const info = getTokenInfo();

    if (!info.exists) {
      noticeEl.className = 'inat-qhub-token-notice warn';
      noticeEl.innerHTML = `
        <span>🔑 Токен iNat не задан (нужен для ИИ-определения фото)</span>
        <button type="button" class="btn-link" id="btn-qhub-goto-token">Ввести ›</button>
      `;
      noticeEl.hidden = false;
    } else if (info.isExpired) {
      noticeEl.className = 'inat-qhub-token-notice danger';
      noticeEl.innerHTML = `
        <span>⚠️ Срок действия токена истёк (24 ч)</span>
        <button type="button" class="btn-link" id="btn-qhub-goto-token">Обновить ›</button>
      `;
      noticeEl.hidden = false;
    } else {
      noticeEl.hidden = true;
    }

    document.getElementById('btn-qhub-goto-token')?.addEventListener('click', () => {
      closeQuickHubModal();
      openAndFocusTokenInput();
    });
  }

  function syncQuickHubInputs() {
    const chkLayer = document.getElementById('inat-qhub-toggle-layer');
    if (chkLayer) chkLayer.checked = !!config.enabled;

    // Синхронизация чипов царств
    const curTaxa = config.taxa || 'Plantae,Fungi';
    document.querySelectorAll('#inat-qhub-taxa-chips .inat-qhub-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.taxa === curTaxa);
    });

    // Поле поиска
    const searchInp = document.getElementById('inat-qhub-search-input');
    const clearBtn = document.getElementById('inat-qhub-search-clear');
    if (searchInp) {
      const qVal = selectedTaxon ? (selectedTaxon.preferred_common_name || selectedTaxon.name) : (config.query || '');
      searchInp.value = qVal;
      if (clearBtn) clearBtn.hidden = !qVal;
    }

    // Вложенные селекторы
    const selPheno = document.getElementById('inat-qhub-select-phenology');
    if (selPheno) selPheno.value = config.phenology || 'any';

    const selSeason = document.getElementById('inat-qhub-select-season');
    if (selSeason) selSeason.value = config.season || 'any';

    const chkWild = document.getElementById('inat-qhub-toggle-wild');
    if (chkWild) chkWild.checked = config.wildOnly !== false;

    const chkResearch = document.getElementById('inat-qhub-toggle-research');
    if (chkResearch) chkResearch.checked = (config.quality === 'research');

    const chkThreatened = document.getElementById('inat-qhub-toggle-threatened');
    if (chkThreatened) chkThreatened.checked = !!config.threatenedOnly;

    const selBadge = document.getElementById('inat-qhub-select-badge-mode');
    if (selBadge) selBadge.value = config.badgeDisplayMode || 'full';

    const selZoomOut = document.getElementById('inat-qhub-select-zoomout');
    if (selZoomOut) selZoomOut.value = config.zoomOutMode || 'grid';

    updateQuickHubTokenNotice();
  }

  function openQuickHubModal() {
    const modal = document.getElementById('modal-inat-quick');
    if (!modal) return;

    initQuickHubUI();
    syncQuickHubInputs();

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('inatQuick');
  }

  function closeQuickHubModal(syncHistory = true) {
    const modal = document.getElementById('modal-inat-quick');
    if (modal) modal.classList.remove('open');
    const autoWrap = document.getElementById('inat-qhub-autocomplete-wrap');
    if (autoWrap) autoWrap.hidden = true;
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('inatQuick');
    }
  }

  function initQuickHubUI() {
    const modal = document.getElementById('modal-inat-quick');
    if (!modal || modal._qhubInited) return;
    modal._qhubInited = true;

    // Закрытие
    document.getElementById('inat-qhub-close-x')?.addEventListener('click', () => closeQuickHubModal());
    document.getElementById('btn-inat-qhub-close')?.addEventListener('click', () => closeQuickHubModal());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeQuickHubModal();
    });

    // Тумблер слоя
    document.getElementById('inat-qhub-toggle-layer')?.addEventListener('change', (e) => {
      if (e.target.checked) enable();
      else disable();
    });

    // Кнопка вызова Радара видов
    document.getElementById('btn-inat-qhub-open-suggest')?.addEventListener('click', () => {
      closeQuickHubModal();
      openSmartSuggestionsModal(config.taxa || 'all');
    });

    // Кнопка распознавания фото
    const fileInput = document.getElementById('inat-qhub-vision-file');
    document.getElementById('btn-inat-qhub-vision')?.addEventListener('click', () => {
      const tokenInfo = getTokenInfo();
      if (!tokenInfo.exists || tokenInfo.isExpired) {
        if (WM.ui?.showToast) WM.ui.showToast('⚠️ Требуется действующий API токен iNat (24 ч)');
        closeQuickHubModal();
        openAndFocusTokenInput();
        return;
      }
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        closeQuickHubModal();
        handleVisionFile(fileInput.files[0]);
        // Открываем основной раздел с результатами
        document.getElementById('modal')?.classList.add('open');
        const spoiler = document.getElementById('spoiler-inaturalist');
        if (spoiler) spoiler.open = true;
      }
    });

    // Чипы царств
    document.querySelectorAll('#inat-qhub-taxa-chips .inat-qhub-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#inat-qhub-taxa-chips .inat-qhub-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const val = chip.dataset.taxa;
        setConfig({ taxa: val });
        if (WM.ui?.showToast) WM.ui.showToast(`🌿 Выбрана группа: ${chip.textContent.trim()}`);
      });
    });

    // Поиск и подсказки
    const searchInp = document.getElementById('inat-qhub-search-input');
    const searchClear = document.getElementById('inat-qhub-search-clear');
    const autoWrap = document.getElementById('inat-qhub-autocomplete-wrap');
    const autoList = document.getElementById('inat-qhub-autocomplete-list');

    let qhubAutoTimer = null;

    searchInp?.addEventListener('input', () => {
      const val = searchInp.value;
      if (searchClear) searchClear.hidden = !val.trim();
      clearTimeout(qhubAutoTimer);

      if (val.trim().length < 2) {
        if (autoWrap) autoWrap.hidden = true;
        return;
      }

      qhubAutoTimer = setTimeout(async () => {
        const taxa = await fetchTaxaAutocomplete(val);
        if (!taxa.length || !autoList || !autoWrap) {
          if (autoWrap) autoWrap.hidden = true;
          return;
        }
        autoList.innerHTML = '';
        taxa.forEach(t => {
          const icon = getTaxonIcon(t);
          const meta = getTaxonMeta(t);
          const ru = t.preferred_common_name || t.name;
          const la = t.name || '';
          const item = document.createElement('div');
          item.className = 'inat-autocomplete-item';
          item.innerHTML = `
            <span class="inat-ac-icon">${icon}</span>
            <div class="inat-ac-meta">
              <span class="inat-ac-ru">${escapeHtml(ru)}</span>
              <span class="inat-ac-la">${escapeHtml(la)}</span>
            </div>
            <span class="inat-ac-badge" style="color:${meta.color};">${meta.name}</span>
          `;
          item.onclick = (ev) => {
            ev.stopPropagation();
            selectedTaxon = t;
            searchInp.value = ru;
            if (autoWrap) autoWrap.hidden = true;
            closeQuickHubModal();
            applyFilterToMap(ru, t);
          };
          autoList.appendChild(item);
        });
        autoWrap.hidden = false;
      }, 180);
    });

    searchClear?.addEventListener('click', () => {
      if (searchInp) searchInp.value = '';
      if (searchClear) searchClear.hidden = true;
      if (autoWrap) autoWrap.hidden = true;
      selectedTaxon = null;
      clearMapFilter();
    });

    document.getElementById('btn-inat-qhub-apply-map')?.addEventListener('click', () => {
      const val = searchInp ? searchInp.value.trim() : '';
      closeQuickHubModal();
      applyFilterToMap(val, selectedTaxon);
    });

    // Спойлеры и селекторы
    document.getElementById('inat-qhub-select-phenology')?.addEventListener('change', (e) => {
      setConfig({ phenology: e.target.value });
    });
    document.getElementById('inat-qhub-select-season')?.addEventListener('change', (e) => {
      setConfig({ season: e.target.value });
    });
    document.getElementById('inat-qhub-toggle-wild')?.addEventListener('change', (e) => {
      setConfig({ wildOnly: e.target.checked });
    });
    document.getElementById('inat-qhub-toggle-research')?.addEventListener('change', (e) => {
      setConfig({ quality: e.target.checked ? 'research' : 'any' });
    });
    document.getElementById('inat-qhub-toggle-threatened')?.addEventListener('change', (e) => {
      setConfig({ threatenedOnly: e.target.checked });
    });
    document.getElementById('inat-qhub-select-badge-mode')?.addEventListener('change', (e) => {
      setConfig({ badgeDisplayMode: e.target.value });
    });
    document.getElementById('inat-qhub-select-zoomout')?.addEventListener('change', (e) => {
      setConfig({ zoomOutMode: e.target.value });
    });
  }


 // =========================================================================
  // БОТАНИЧЕСКИЕ СПРАВОЧНИКИ (ТИПЫ ПЛОДОВ, ПРИЗНАКИ, ОРГАНЫ РАСТЕНИЙ)
  // =========================================================================

  // Типы плодов (P4000)
  const WIKIDATA_FRUIT_MAP = {
    'Q14714': { text: 'Вислоплодник (двусемянка / схизокарпий)', icon: '🌾' },
    'Q147768': { text: 'Коробочка', icon: '🌰' },
    'Q131877': { text: 'Ягода', icon: '🫐' },
    'Q193135': { text: 'Орех / орешек', icon: '🌰' },
    'Q28183': { text: 'Семянка / зерновка', icon: '🌾' },
    'Q158408': { text: 'Костянка', icon: '🍒' },
    'Q147754': { text: 'Стручок / боб', icon: '🫛' },
    'Q147774': { text: 'Яблоко (плод)', icon: '🍎' },
    'Q147770': { text: 'Шишка (стробил)', icon: '🌲' },
    'Q147760': { text: 'Крылатка', icon: '🍁' },
    'Q147752': { text: 'Листовка', icon: '🍂' }
  };

  // Биологические характеристики и свойства растений (P1672 / P1552 / P279)
  const WIKIDATA_PLANT_CHARACTERISTICS_MAP = {
    'Q19705425': { text: 'Вечнозелёное растение', icon: '🌲', pill: '🌲 Вечнозелёное' },
    'Q1131303': { text: 'Листопадное растение', icon: '🍂', pill: '🍂 Листопадное' },
    'Q7820900': { text: 'Однодомное растение', icon: '⚧', pill: '⚧ Однодомное' },
    'Q149759': { text: 'Двудомное растение', icon: '🚻', pill: '🚻 Двудомное' },
    'Q107607982': { text: 'Голосеменные / Хвойные', icon: '🌲', pill: '🌲 Хвойное' },
    'Q25314': { text: 'Покрытосеменные (цветковые)', icon: '🌸', pill: '🌸 Цветковое' },
    'Q2483861': { text: 'Однолетнее растение', icon: '⏳', pill: '⏳ Однолетник' },
    'Q152535': { text: 'Двулетнее растение', icon: '⏳', pill: '⏳ Двулетник' },
    'Q157957': { text: 'Многолетнее растение', icon: '⏳', pill: '⏳ Многолетник' },
    'Q9323487': { text: 'Дикорастущее полезное / пищевое', icon: '🥗', pill: '🥗 Пищевое' },
    'Q188902': { text: 'Ядовитое растение', icon: '☠️', pill: '☠️ Ядовитое' },
    'Q188840': { text: 'Лекарственное сырьё', icon: '💊', pill: '💊 Лекарственное' },
    'Q190489': { text: 'Древесинное сырьё', icon: '🪵', pill: '🪵 Древесина' }
  };

  // Органы / части растений на фото (квалификатор P5961 у P18)
  const WIKIDATA_PLANT_PARTS_MAP = {
    'Q33971': 'Кора / ствол',
    'Q22710': 'Хвоя / листья',
    'Q11422': 'Листья',
    'Q506': 'Цветок',
    'Q106574': 'Соцветие',
    'Q1364': 'Плод',
    'Q3314483': 'Плод',
    'Q147770': 'Шишка',
    'Q147768': 'Коробочка',
    'Q28183': 'Семена',
    'Q34442': 'Корень / корневище',
    'Q149955': 'Побеги / ветви'
  };

  /**
   * Сбор морфологии и ботанических черт растений
   */
  async function fetchPlantTraits(scientificName, wikiExtract = '') {
    if (!scientificName || scientificName === 'Не определено') return null;
    const cleanLatin = scientificName.trim();
    if (plantTraitsCache.has(cleanLatin)) return plantTraitsCache.get(cleanLatin);

    const result = {
      growthForm: null,
      lifeCycle: null,
      height: null,
      longevity: null,
      pollination: null,
      fruitType: null,
      edibleParts: [],
      isMedicinal: false,
      toxicity: null,
      hardinessZone: null,
      characteristics: [],
      bloomTime: null,
      shortName: null,
      awards: [],
      rangeMapFile: null,
      taxonAuthor: null,
      wikiPhotos: [],
      commonNames: []
    };

    try {
      const ctl = new AbortController();
      const tmr = setTimeout(() => ctl.abort(), 4500);

      // Запрос сущности Wikidata
      const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(cleanLatin)}&language=en&type=item&limit=3&format=json&origin=*`;
      const sRes = await fetch(sUrl, { signal: ctl.signal });
      const sData = await sRes.json();
      const entity = sData?.search?.[0];

      let wdClaims = null;
      if (entity?.id) {
        const eUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json&origin=*`;
        const eRes = await fetch(eUrl, { signal: ctl.signal });
        const eData = await eRes.json();
        wdClaims = eData?.entities?.[entity.id]?.claims || null;
      }
      clearTimeout(tmr);

      if (wdClaims) {
        const idsToResolve = new Set();

        // 1. Автор таксона и год (P225 квалификаторы P405 и P574)
        let authorQId = wdClaims.P225?.[0]?.qualifiers?.P405?.[0]?.datavalue?.value?.id || wdClaims.P405?.[0]?.mainsnak?.datavalue?.value?.id;
        let pubYear = null;
        const yearSnak = wdClaims.P225?.[0]?.qualifiers?.P574?.[0] || wdClaims.P574?.[0];
        if (yearSnak?.datavalue?.value?.time) {
          const m = yearSnak.datavalue.value.time.match(/^[+-]?(\d{1,4})/);
          if (m) pubYear = parseInt(m[1], 10);
        }
        if (authorQId) idsToResolve.add(authorQId);

        // Сокращенное название (P1813)
        if (wdClaims.P1813?.[0]?.mainsnak?.datavalue?.value?.text) {
          result.shortName = wdClaims.P1813[0].mainsnak.datavalue.value.text;
        }

        // Жизненная форма (P5283 / P1552)
        const formClaims = [...(wdClaims.P5283 || []), ...(wdClaims.P1552 || [])];
        for (const c of formClaims) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_PLANT_FORMS[qId]) {
            result.growthForm = WIKIDATA_PLANT_FORMS[qId];
            break;
          }
        }

        // Высота растения (P2043)
        if (wdClaims.P2043?.[0]) {
          result.height = parseWikidataQuantity(wdClaims.P2043[0]);
        }

        // А. Максимальный возраст / долголетие (P4214)
        if (wdClaims.P4214?.[0]) {
          result.longevity = parseWikidataQuantity(wdClaims.P4214[0]);
        }

        // Б. Тип плода (P4000)
        let fruitQId = wdClaims.P4000?.[0]?.mainsnak?.datavalue?.value?.id;
        if (fruitQId) {
          if (WIKIDATA_FRUIT_MAP[fruitQId]) {
            result.fruitType = WIKIDATA_FRUIT_MAP[fruitQId];
          } else {
            idsToResolve.add(fruitQId);
          }
        }

        // Тип опыления (P1552 / P1034)
        for (const c of [...(wdClaims.P1552 || []), ...(wdClaims.P1034 || [])]) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_POLLINATION_MAP[qId]) {
            result.pollination = WIKIDATA_POLLINATION_MAP[qId];
            break;
          }
        }

        // В. Ключевые биологические признаки (P1672 / P1552 / P279)
        const charClaims = [...(wdClaims.P1672 || []), ...(wdClaims.P1552 || []), ...(wdClaims.P279 || [])];
        const rawCharIds = [];
        for (const c of charClaims) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (qId && !rawCharIds.includes(qId)) rawCharIds.push(qId);
        }
        rawCharIds.forEach(id => idsToResolve.add(id));

        // Ж. Части растения на фотографиях (P18 + квалификаторы P5961)
        if (wdClaims.P18?.length) {
          for (const c of wdClaims.P18) {
            const parts = c.qualifiers?.P5961 || [];
            parts.forEach(p => {
              const pId = p.datavalue?.value?.id;
              if (pId) idsToResolve.add(pId);
            });
          }
        }

        // Награды / Статусы (P166), например «Дерево года»
        if (wdClaims.P166?.length) {
          for (const c of wdClaims.P166) {
            const aId = c.mainsnak?.datavalue?.value?.id;
            if (aId) idsToResolve.add(aId);
          }
        }

        // Карта ареала (P181)
        if (wdClaims.P181?.[0]?.mainsnak?.datavalue?.value) {
          result.rangeMapFile = wdClaims.P181[0].mainsnak.datavalue.value;
        }

        // Съедобные части (P3489)
        if (wdClaims.P3489?.length) {
          result.edibleParts = wdClaims.P3489
            .map(c => EDIBLE_PARTS_RU[c.mainsnak?.datavalue?.value?.id])
            .filter(Boolean);
        }

        // Лекарственное (P2176 / P366)
        if (wdClaims.P2176?.length || wdClaims.P366?.some(c => c.mainsnak?.datavalue?.value?.id === 'Q188840')) {
          result.isMedicinal = true;
        }

        // Зона зимостойкости USDA (P7912)
        if (wdClaims.P7912?.[0]?.mainsnak?.datavalue?.value) {
          result.hardinessZone = `Зона USDA: ${wdClaims.P7912[0].mainsnak.datavalue.value}`;
        }

        // =====================================================================
        // ДИНАМИЧЕСКИЙ РЕЗОЛВ ВСЕХ СОБРАННЫХ Q-ID ИЗ WIKIDATA
        // =====================================================================
        if (idsToResolve.size > 0) {
          await resolveWikidataLabels(Array.from(idsToResolve));

          if (authorQId) {
            const aName = wdLabelsCache.get(authorQId) || authorQId;
            result.taxonAuthor = pubYear ? `${aName}, ${pubYear}` : aName;
          } else if (pubYear) {
            result.taxonAuthor = `${pubYear} г.`;
          }

          // Если тип плода не был найден в локальном словаре
          if (fruitQId && !result.fruitType) {
            const fLabel = wdLabelsCache.get(fruitQId);
            if (fLabel) {
              const capFruit = fLabel.charAt(0).toUpperCase() + fLabel.slice(1);
              result.fruitType = { text: capFruit, icon: '🌰' };
            }
          }

          // Разбор признаков (P1672 / P1552)
          const charResults = [];
          for (const qId of rawCharIds) {
            if (WIKIDATA_PLANT_CHARACTERISTICS_MAP[qId]) {
              const item = WIKIDATA_PLANT_CHARACTERISTICS_MAP[qId];
              // Жизненный цикл уже выводится в lifeCycle — исключаем дубликат
              if (['Q2483861', 'Q152535', 'Q157957'].includes(qId)) {
                result.lifeCycle = item.text;
                continue;
              }
              // Лекарственное свойство уже выводится в isMedicinal
              if (qId === 'Q188840') {
                result.isMedicinal = true;
                continue;
              }
              // Ядовитость уже выводится в toxicity
              if (qId === 'Q188902') {
                result.toxicity = { text: 'Ядовитое растение', icon: '🔴', color: '#ef4444' };
                continue;
              }
              charResults.push(item);
            } else {
              const label = wdLabelsCache.get(qId);
              if (label && label !== qId) {
                const cap = label.charAt(0).toUpperCase() + label.slice(1);
                charResults.push({ text: cap, icon: '🌿', pill: `🌿 ${cap}` });
              }
            }
          }
          result.characteristics = charResults;

          // Разбор наград (P166)
          if (wdClaims.P166?.length) {
            const awardsList = [];
            for (const c of wdClaims.P166) {
              const aId = c.mainsnak?.datavalue?.value?.id;
              const aLabel = wdLabelsCache.get(aId);
              let aYear = null;
              const yTime = c.qualifiers?.P585?.[0]?.datavalue?.value?.time;
              if (yTime) {
                const m = yTime.match(/^[+-]?(\d{1,4})/);
                if (m) aYear = m[1];
              }
              if (aLabel) {
                awardsList.push(aYear ? `${aLabel} (${aYear} г.)` : aLabel);
              }
            }
            result.awards = awardsList;
          }
        }

        // Фотографии с частями растений (P18 + P5961)
        if (wdClaims.P18?.length) {
          result.wikiPhotos = wdClaims.P18.map(c => {
            const file = c.mainsnak?.datavalue?.value;
            if (!file) return null;
            const caption = c.qualifiers?.P2096?.[0]?.datavalue?.value?.text || '';
            const parts = (c.qualifiers?.P5961 || []).map(p => {
              const pId = p.datavalue?.value?.id;
              return WIKIDATA_PLANT_PARTS_MAP[pId] || wdLabelsCache.get(pId) || null;
            }).filter(Boolean);

            return { file, caption, parts };
          }).filter(Boolean);
        }

        // Названия на языках (P1843)
        if (wdClaims.P1843?.length) {
          const names = [];
          const seen = new Set();
          for (const c of wdClaims.P1843) {
            const val = c.mainsnak?.datavalue?.value;
            if (!val || !val.text) continue;
            const text = val.text.trim();
            const lang = (val.language || 'mul').toLowerCase();
            const key = `${lang}:${text.toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              names.push({ text, lang, langName: LANG_NAMES_RU[lang] || lang.toUpperCase() });
            }
          }
          result.commonNames = names;
        }
      }

      // Фоллбэк из текста статьи Википедии
      if (wikiExtract) {
        const low = wikiExtract.toLowerCase();
        if (!result.growthForm) {
          if (low.includes('дерево')) result.growthForm = { text: 'Дерево', icon: '🌳' };
          else if (low.includes('кустарник')) result.growthForm = { text: 'Кустарник', icon: '🪴' };
          else if (low.includes('травянистое растение') || low.includes('трава')) {
            result.growthForm = { text: 'Травянистое растение', icon: '🌱' };
          }
        }

        if (!result.lifeCycle) {
          if (low.includes('однолетн')) result.lifeCycle = 'Однолетнее растение';
          else if (low.includes('двулетн')) result.lifeCycle = 'Двулетнее растение';
          else if (low.includes('многолетн')) result.lifeCycle = 'Многолетнее растение';
        }

        if (!result.toxicity) {
          if (low.includes('смертельно ядовит')) result.toxicity = { text: 'Смертельно ядовито!', icon: '☠️', color: '#dc2626' };
          else if (low.includes('ядовит')) result.toxicity = { text: 'Ядовитое растение', icon: '🔴', color: '#ef4444' };
        }

        if (low.includes('вечнозелён') && !result.characteristics.some(c => c.text.includes('Вечнозелёное'))) {
          result.characteristics.push(WIKIDATA_PLANT_CHARACTERISTICS_MAP['Q19705425']);
        }
        if (low.includes('однодомн') && !result.characteristics.some(c => c.text.includes('Однодомное'))) {
          result.characteristics.push(WIKIDATA_PLANT_CHARACTERISTICS_MAP['Q7820900']);
        }
      }

      const hasAny = Object.values(result).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));
      const finalRes = hasAny ? result : null;

      lastPlantTraitsDebugData = {
        scientificName: cleanLatin,
        timestamp: new Date().toISOString(),
        parsedTraits: finalRes,
        rawWikidataClaims: wdClaims,
        wikiExtractUsed: wikiExtract || null
      };

      plantTraitsCache.set(cleanLatin, finalRes);
      return finalRes;
    } catch (e) {
      plantTraitsCache.set(cleanLatin, null);
      return null;
    }
  }

  /**
   * Отрисовка детализированной панели ботанических свойств растения
   */
  function renderPlantTraitsSection(traits) {
    if (!traits) {
      return `<div class="muted inat-card-empty-note" style="padding: 10px 4px;">ℹ️ В базах Wikidata пока нет детальных морфологических характеристик этого растения.</div>`;
    }

    const items = [];
    if (traits.taxonAuthor) items.push({ icon: '📜', label: 'Автор таксона:', val: traits.taxonAuthor, wide: false });
    if (traits.growthForm) items.push({ icon: traits.growthForm.icon, label: 'Жизненная форма:', val: traits.growthForm.text, wide: false });
    if (traits.lifeCycle) items.push({ icon: '⏳', label: 'Жизненный цикл:', val: traits.lifeCycle, wide: false });
    if (traits.height) items.push({ icon: '📐', label: 'Высота:', val: traits.height, wide: false });
    if (traits.longevity) items.push({ icon: '⏳', label: 'Срок жизни:', val: `до ${traits.longevity}`, wide: false });
    if (traits.pollination) items.push({ icon: traits.pollination.icon, label: 'Опыление:', val: traits.pollination.text, wide: false });
    if (traits.fruitType) items.push({ icon: traits.fruitType.icon || '🌰', label: 'Тип плода:', val: traits.fruitType.text, wide: false });
    if (traits.hardinessZone) items.push({ icon: '❄️', label: 'Зимостойкость:', val: traits.hardinessZone, wide: false });
    if (traits.shortName) items.push({ icon: '🏷️', label: 'Сокращение:', val: traits.shortName, wide: false });

    if (traits.toxicity) items.push({ icon: traits.toxicity.icon, label: 'Токсичность:', val: traits.toxicity.text, wide: true });
    if (traits.edibleParts?.length) items.push({ icon: '🍓', label: 'Съедобные части:', val: traits.edibleParts.join(', '), wide: true });
    if (traits.isMedicinal) items.push({ icon: '💊', label: 'Применение:', val: 'Лекарственное растение', wide: true });
    if (traits.awards?.length) items.push({ icon: '🏆', label: 'Статус / премия:', val: traits.awards.join('; '), wide: true });

    // Характеристики и особенности растения
    if (traits.characteristics?.length) {
      traits.characteristics.forEach(ch => {
        items.push({ icon: ch.icon || '🌿', label: 'Особенность:', val: ch.text, wide: false });
      });
    }

    // Фотографии с бейджами частей растений
    let photosHtml = '';
    if (traits.wikiPhotos?.length) {
      photosHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>📷 Фотографии образцов (${traits.wikiPhotos.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div class="inat-footprints-gallery" style="display:flex; gap:8px; overflow-x:auto; padding:6px 0;">
              ${traits.wikiPhotos.map(item => `
                <a href="${getCommonsMediaUrl(item.file, 1400)}" target="_blank" rel="noopener noreferrer" style="flex:0 0 auto; text-align:center; max-width:160px; text-decoration:none;">
                  <div style="position:relative;">
                    <img src="${getCommonsMediaUrl(item.file, 320)}" alt="" style="height:115px; width:100%; border-radius:6px; object-fit:cover; border:1px solid var(--border-color); display:block;">
                    ${item.parts?.length ? `
                      <span style="position:absolute; bottom:4px; left:4px; right:4px; background:rgba(0,0,0,0.72); color:#fff; font-size:9.5px; border-radius:4px; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; display:block;">
                        ${escapeHtml(item.parts.join(', '))}
                      </span>` : ''}
                  </div>
                  ${item.caption ? `<small style="font-size:10.5px; color:var(--text-main); display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:3px;">${escapeHtml(item.caption)}</small>` : ''}
                  <small style="font-size:10px; color:var(--text-muted); display:block;">Увеличить ↗</small>
                </a>
              `).join('')}
            </div>
          </div>
        </details>`;
    }

    // Карта ареала обитания вида (P181)
    let rangeMapHtml = '';
    if (traits.rangeMapFile) {
      rangeMapHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🗺️ Научная карта ареала вида (Wikimedia Commons)</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body" style="text-align:center; padding:6px 0;">
            <a href="${getCommonsMediaUrl(traits.rangeMapFile, 1600)}" target="_blank" rel="noopener noreferrer">
              <img src="${getCommonsMediaUrl(traits.rangeMapFile, 600)}" alt="Карта ареала" style="max-height:160px; max-width:100%; border-radius:6px; border:1px solid var(--border-color); object-fit:contain;">
              <small style="font-size:10px; color:var(--text-muted); display:block; margin-top:3px;">Открыть полную схему ареала ↗</small>
            </a>
          </div>
        </details>
      `;
    }

    // Названия на других языках
    let commonNamesHtml = '';
    if (traits.commonNames?.length) {
      commonNamesHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🌍 Народные названия (${traits.commonNames.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div style="display:flex; flex-wrap:wrap; gap:6px; padding:6px 0; max-height:180px; overflow-y:auto;">
              ${traits.commonNames.map(item => `
                <span class="inat-pill" style="font-size:11px; background:rgba(0,0,0,0.04); border:1px solid var(--border-color);">
                  <span style="color:var(--text-muted); font-size:10px;">${escapeHtml(item.langName)}:</span> <b>${escapeHtml(item.text)}</b>
                </span>
              `).join('')}
            </div>
          </div>
        </details>`;
    }

    return `
      <div class="inat-traits-grid">
        ${items.map(it => `
          <div class="inat-trait-card ${it.wide ? 'span-2' : ''}">
            <span class="inat-trait-icon">${it.icon}</span>
            <div class="inat-trait-info">
              <span class="inat-trait-lbl">${escapeHtml(it.label)}</span>
              <b class="inat-trait-val">${escapeHtml(it.val)}</b>
            </div>
          </div>
        `).join('')}
      </div>

      ${rangeMapHtml}
      ${photosHtml}
      ${commonNamesHtml}

      <div class="inat-traits-source-note" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
        <span style="font-size:11px; color:var(--text-muted);">📚 Источники: <b>Wikidata</b>, <b>Wikipedia</b></span>
        <button type="button" class="btn-link" onclick="window.WM.inat.downloadPlantTraitsDebug()" style="font-size:11px; font-weight:600;">💾 Скачать JSON</button>
      </div>
    `;
  }

  /**
   * Сбор микологических характеристик грибов
   */
  // =========================================================================
  // МИКОЛОГИЧЕСКИЕ СПРАВОЧНИКИ (MYCOMORPHBOX & WIKIDATA P783-P789)
  // =========================================================================

  // Статусы съедобности грибов (P789 и P199)
  const WIKIDATA_EDIBILITY_MAP = {
    'Q214190': { text: 'Съедобный гриб', class: 'inat-pill-edible', icon: '🟢', rank: 1 },
    'Q1143890': { text: 'Деликатесный съедобный гриб', class: 'inat-pill-edible', icon: '🟢', rank: 1 },
    'Q1474558': { text: 'Условно-съедобный гриб', class: 'inat-pill-cond-edible', icon: '🟡', rank: 2 },
    'Q1474560': { text: 'Несъедобный гриб', class: 'inat-pill-inedible', icon: '⚪', rank: 3 },
    'Q1474564': { text: 'Ядовитый гриб', class: 'inat-pill-poisonous', icon: '🔴', rank: 4 },
    'Q359511': { text: 'Ядовитый / токсичный гриб', class: 'inat-pill-poisonous', icon: '🔴', rank: 4 },
    'Q6555909': { text: 'Смертельно ядовитый гриб', class: 'inat-pill-deadly', icon: '☠️', rank: 5 },
    'Q19888591': { text: 'Смертельно ядовитый гриб', class: 'inat-pill-deadly', icon: '☠️', rank: 5 },
    // Особые свойства (P789)
    'Q1686195': { text: 'Целебный / лекарственный гриб', isMedicinal: true, icon: '💊' },
    'Q1169875': { text: 'Психоактивный / галлюциногенный гриб', isPsychoactive: true, icon: '🍄✨' },
    'Q548398': { text: 'Психоактивный гриб', isPsychoactive: true, icon: '🍄✨' }
  };

  // Типы гименофора (P783 / P1552 / P10056)
  const WIKIDATA_HYMENIUM_MAP = {
    'Q1474540': { text: 'Пластинчатый', icon: '🍄' },
    'Q1474544': { text: 'Трубчатый (пористый)', icon: '🧽' },
    'Q1474548': { text: 'Складчатый', icon: '🥟' },
    'Q1474550': { text: 'Игольчатый / шиповатый', icon: '🦔' },
    'Q1474552': { text: 'Гладкий', icon: '⚪' },
    'Q1474554': { text: 'Глеба (дождевиковый)', icon: '💨' }
  };

  // Форма шляпки гриба (P784)
  const WIKIDATA_CAP_SHAPE_MAP = {
    'Q1474516': { text: 'Выпуклая (полушаровидная)', icon: '🧢' },
    'Q1474518': { text: 'Плоская (распростёртая)', icon: '🥞' },
    'Q1474520': { text: 'Вдавленная в центре', icon: '🥣' },
    'Q1474522': { text: 'Коническая (конусовидная)', icon: '⛺' },
    'Q1474524': { text: 'Колокольчатая', icon: '🔔' },
    'Q1474526': { text: 'С выраженным бугорком', icon: '⛰️' },
    'Q1474528': { text: 'Воронковидная', icon: '🌪️' },
    'Q1474530': { text: 'Эксцентрическая (асимметричная)', icon: '🥐' }
  };

  // Прикрепление гименофора к ножке (P785)
  const WIKIDATA_ATTACHMENT_MAP = {
    'Q1474532': { text: 'Приросшие пластинки (adnate)', icon: '🔗' },
    'Q1474534': { text: 'Нисходящие по ножке (decurrent)', icon: '↘️' },
    'Q1474536': { text: 'Выемчатые пластинки (sinuate)', icon: '〰️' },
    'Q1474538': { text: 'Свободные пластинки (free)', icon: '🕊️' },
    'Q188904': { text: 'Узкоприросшие (adnexed)', icon: '🖇️' },
    'Q188905': { text: 'Отделяющиеся (seceding)', icon: '✂️' }
  };

  // Особенности ножки: кольцо, вольва (P786)
  const WIKIDATA_STIPE_MAP = {
    'Q1474508': { text: 'Голая ножка (без кольца и вольвы)', icon: '🦯' },
    'Q1474510': { text: 'С кольцом (юбочка на ножке)', icon: '💍' },
    'Q1474512': { text: 'С вольвой (мешковидное основание)', icon: '🥾' },
    'Q1474514': { text: 'С кольцом и вольвой (признак мухоморовых)', icon: '👑' },
    'Q188906': { text: 'С кортиной (паутинистое покрывало)', icon: '🕸️' }
  };

  // Цвет спорового порошка (P787)
  const WIKIDATA_SPORE_MAP = {
    'Q1474500': { text: 'Белый споровый отпечаток', icon: '⚪' },
    'Q1474502': { text: 'Чёрный споровый отпечаток', icon: '⚫' },
    'Q1474504': { text: 'Коричневый / ржаво-бурый', icon: '🟤' },
    'Q1474506': { text: 'Розовый споровый отпечаток', icon: '🌸' },
    'Q188908': { text: 'Кремовый / охристо-жёлтый', icon: '🟡' },
    'Q188909': { text: 'Оливковый отпечаток', icon: '🫒' },
    'Q188910': { text: 'Фиолетово-коричневый', icon: '🟣' }
  };

  // Эколого-трофические группы (P788 / P1034 / P1552)
  const WIKIDATA_FUNGAL_TROPHIC_MAP = {
    'Q11181655': { text: 'Микоризообразователь (симбиот деревьев)', icon: '🌲' },
    'Q174782': { text: 'Микоризообразователь (симбиот деревьев)', icon: '🌲' },
    'Q178309': { text: 'Сапротроф (разрушитель подстилки/древесины)', icon: '🍂' },
    'Q128011': { text: 'Гриб-паразит (на живых деревьях/растениях)', icon: '🪵' }
  };

  /**
   * Сбор полной микологической информации о грибе из Wikidata и Википедии
   */
  async function fetchFungiTraits(scientificName, wikiExtract = '') {
    if (!scientificName || scientificName === 'Не определено') return null;
    const cleanLatin = scientificName.trim();
    if (fungiTraitsCache.has(cleanLatin)) return fungiTraitsCache.get(cleanLatin);

    const result = {
      edibility: null,
      isMedicinal: false,
      isPsychoactive: false,
      hymeniumType: null,
      capShape: null,
      hymeniumAttachment: null,
      stipeCharacter: null,
      sporePrintColor: null,
      trophicGroup: null,
      capDiameter: null,
      stemHeight: null,
      symbionts: [],
      habitatTags: [],
      parentTaxon: null,
      typeSpecies: null,
      differentFrom: [],
      synonyms: [],
      vernacularNamesRu: [],
      shortName: null,
      taxonAuthor: null,
      wikiPhotos: [],
      commonNames: []
    };

    try {
      const ctl = new AbortController();
      const tmr = setTimeout(() => ctl.abort(), 4500);

      const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(cleanLatin)}&language=en&type=item&limit=3&format=json&origin=*`;
      const sRes = await fetch(sUrl, { signal: ctl.signal });
      const sData = await sRes.json();
      const entity = sData?.search?.[0];

      let wdClaims = null;
      if (entity?.id) {
        const eUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json&origin=*`;
        const eRes = await fetch(eUrl, { signal: ctl.signal });
        const eData = await eRes.json();
        wdClaims = eData?.entities?.[entity.id]?.claims || null;
      }
      clearTimeout(tmr);

      if (wdClaims) {
        const idsToResolve = new Set();

        // 1. Автор таксона и год (P225 квалификаторы P405 и P574)
        let authorQId = wdClaims.P225?.[0]?.qualifiers?.P405?.[0]?.datavalue?.value?.id || wdClaims.P405?.[0]?.mainsnak?.datavalue?.value?.id;
        let pubYear = null;
        const yearSnak = wdClaims.P225?.[0]?.qualifiers?.P574?.[0] || wdClaims.P574?.[0];
        if (yearSnak?.datavalue?.value?.time) {
          const m = yearSnak.datavalue.value.time.match(/^[+-]?(\d{1,4})/);
          if (m) pubYear = parseInt(m[1], 10);
        }
        if (authorQId) idsToResolve.add(authorQId);

        // Сокращенное название (P1813)
        if (wdClaims.P1813?.[0]?.mainsnak?.datavalue?.value?.text) {
          result.shortName = wdClaims.P1813[0].mainsnak.datavalue.value.text;
        }

        // 2. Съедобность и лекарственные/психоактивные свойства (P789 + P199)
        const edibilityClaims = [...(wdClaims.P789 || []), ...(wdClaims.P199 || [])];
        let bestEdibility = null;
        for (const c of edibilityClaims) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (!qId) continue;
          const mapItem = WIKIDATA_EDIBILITY_MAP[qId];
          if (mapItem) {
            if (mapItem.isMedicinal) result.isMedicinal = true;
            if (mapItem.isPsychoactive) result.isPsychoactive = true;
            if (mapItem.rank && (!bestEdibility || mapItem.rank > bestEdibility.rank)) {
              bestEdibility = mapItem;
            }
          }
        }
        if (bestEdibility) result.edibility = bestEdibility;

        // 3. Строение гриба (Mycomorphbox)
        // Гименофор (P783 / P1552 / P10056)
        for (const c of [...(wdClaims.P783 || []), ...(wdClaims.P1552 || []), ...(wdClaims.P10056 || [])]) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_HYMENIUM_MAP[qId]) {
            result.hymeniumType = WIKIDATA_HYMENIUM_MAP[qId];
            break;
          }
        }

        // Форма шляпки (P784)
        if (wdClaims.P784?.length) {
          const qId = wdClaims.P784[0].mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_CAP_SHAPE_MAP[qId]) result.capShape = WIKIDATA_CAP_SHAPE_MAP[qId];
        }

        // Прикрепление гименофора (P785)
        if (wdClaims.P785?.length) {
          const qId = wdClaims.P785[0].mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_ATTACHMENT_MAP[qId]) result.hymeniumAttachment = WIKIDATA_ATTACHMENT_MAP[qId];
        }

        // Особенности ножки (P786)
        if (wdClaims.P786?.length) {
          const qId = wdClaims.P786[0].mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_STIPE_MAP[qId]) result.stipeCharacter = WIKIDATA_STIPE_MAP[qId];
        }

        // Споровый порошок (P787)
        if (wdClaims.P787?.length) {
          const qId = wdClaims.P787[0].mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_SPORE_MAP[qId]) result.sporePrintColor = WIKIDATA_SPORE_MAP[qId];
        }

        // Экологическая группа / роль (P788 / P1034 / P1552)
        for (const c of [...(wdClaims.P788 || []), ...(wdClaims.P1034 || []), ...(wdClaims.P1552 || [])]) {
          const qId = c.mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_FUNGAL_TROPHIC_MAP[qId]) {
            result.trophicGroup = WIKIDATA_FUNGAL_TROPHIC_MAP[qId];
            break;
          }
        }

        // Размеры (P2043)
        if (wdClaims.P2043?.[0]) result.capDiameter = parseWikidataQuantity(wdClaims.P2043[0]);

        // 4. Типовой вид рода (P427) — например, Мухомор красный для рода Amanita
        const typeSpeciesQId = wdClaims.P427?.[0]?.mainsnak?.datavalue?.value?.id;
        if (typeSpeciesQId) idsToResolve.add(typeSpeciesQId);

        // 5. «Не путать с» (P1889) — важные морфологические двойники
        const diffQIds = (wdClaims.P1889 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
        diffQIds.forEach(id => idsToResolve.add(id));

        // 6. Вышестоящий таксон / Род / Семейство (P171)
        const parentQId = wdClaims.P171?.[0]?.mainsnak?.datavalue?.value?.id;
        if (parentQId) idsToResolve.add(parentQId);

        // 7. Научные синонимы (P1420)
        const synQIds = (wdClaims.P1420 || []).slice(0, 4).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
        synQIds.forEach(id => idsToResolve.add(id));

        // 8. Деревья-партнеры (P1034)
        const treeQIds = (wdClaims.P1034 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
        treeQIds.forEach(id => idsToResolve.add(id));

        // 9. Русские народные названия из энциклопедий (квалификаторы P1810 в P2924 / P11514)
        const vernacSet = new Set();
        const bseName = wdClaims.P2924?.[0]?.qualifiers?.P1810?.[0]?.datavalue?.value;
        if (bseName) {
          const cap = bseName.charAt(0).toUpperCase() + bseName.slice(1).toLowerCase();
          vernacSet.add(cap);
        }
        result.vernacularNamesRu = Array.from(vernacSet);

        // 10. Разрешаем пачкой все собранные Q-ID
        if (idsToResolve.size > 0) {
          await resolveWikidataLabels(Array.from(idsToResolve));

          if (authorQId) {
            const aName = wdLabelsCache.get(authorQId) || authorQId;
            result.taxonAuthor = pubYear ? `${aName}, ${pubYear}` : aName;
          } else if (pubYear) {
            result.taxonAuthor = `${pubYear} г.`;
          }

          if (typeSpeciesQId) {
            result.typeSpecies = wdLabelsCache.get(typeSpeciesQId) || typeSpeciesQId;
          }

          if (diffQIds.length > 0) {
            result.differentFrom = diffQIds.map(id => wdLabelsCache.get(id)).filter(Boolean);
          }

          if (parentQId) {
            result.parentTaxon = wdLabelsCache.get(parentQId) || parentQId;
          }

          if (synQIds.length > 0) {
            result.synonyms = synQIds.map(id => wdLabelsCache.get(id)).filter(Boolean);
          }

          if (treeQIds.length > 0) {
            result.symbionts = treeQIds.map(id => wdLabelsCache.get(id)).filter(Boolean);
          }
        }

        // 11. Фотографии (P18)
        if (wdClaims.P18?.length) {
          result.wikiPhotos = wdClaims.P18.map(c => ({
            file: c.mainsnak?.datavalue?.value,
            caption: c.qualifiers?.P2096?.[0]?.datavalue?.value?.text || ''
          })).filter(x => x.file);
        }

        // 12. Названия на других языках (P1843 + P2347.P14457 + P8189.P14457)
        const namesList = [];
        const seenNames = new Set();

        const addLangName = (text, lang) => {
          if (!text || !lang) return;
          const cleanText = text.trim();
          const cleanLang = lang.toLowerCase();
          const k = `${cleanLang}:${cleanText.toLowerCase()}`;
          if (!seenNames.has(k)) {
            seenNames.add(k);
            namesList.push({
              text: cleanText,
              lang: cleanLang,
              langName: LANG_NAMES_RU[cleanLang] || cleanLang.toUpperCase()
            });
          }
        };

        if (wdClaims.P1843?.length) {
          for (const c of wdClaims.P1843) {
            const val = c.mainsnak?.datavalue?.value;
            if (val?.text) addLangName(val.text, val.language || 'mul');
          }
        }
        // Извлечение квалификаторов P14457 (Artsdatabanken P2347 / Израиль P8189)
        for (const prop of ['P2347', 'P8189']) {
          if (wdClaims[prop]?.length) {
            for (const c of wdClaims[prop]) {
              const quals = c.qualifiers?.P14457 || [];
              for (const q of quals) {
                const val = q.datavalue?.value;
                if (val?.text) addLangName(val.text, val.language);
              }
            }
          }
        }
        result.commonNames = namesList;
      }

      // =====================================================================
      // ТЕКСТОВЫЙ АНАЛИЗ СТАТЬИ ВИКИПЕДИИ (УМНЫЙ ФОЛЛБЭК И ДОПОЛНЕНИЕ)
      // =====================================================================
      if (wikiExtract) {
        const low = wikiExtract.toLowerCase();

        // Съедобность
        if (!result.edibility) {
          if (low.includes('смертельно ядовит')) {
            result.edibility = WIKIDATA_EDIBILITY_MAP['Q6555909'];
          } else if (low.includes('ядовит')) {
            result.edibility = WIKIDATA_EDIBILITY_MAP['Q359511'];
          } else if (low.includes('условно-съедоб') || low.includes('условно съедоб')) {
            result.edibility = WIKIDATA_EDIBILITY_MAP['Q1474558'];
          } else if (low.includes('несъедоб')) {
            result.edibility = WIKIDATA_EDIBILITY_MAP['Q1474560'];
          } else if (low.includes('съедобн') || low.includes('употребляется в пищу')) {
            result.edibility = WIKIDATA_EDIBILITY_MAP['Q214190'];
          }
        }

        if (low.includes('лекарственн') || low.includes('целебн') || low.includes('фармакол')) {
          result.isMedicinal = true;
        }
        if (low.includes('галлюциноген') || low.includes('психоактивн') || low.includes('псилоциб')) {
          result.isPsychoactive = true;
        }

        // Гименофор
        if (!result.hymeniumType) {
          if (low.includes('пластинчат')) {
            result.hymeniumType = { text: 'Пластинчатый', icon: '🍄' };
          } else if (low.includes('трубчат') || low.includes('порист')) {
            result.hymeniumType = { text: 'Трубчатый (пористый)', icon: '🧽' };
          } else if (low.includes('складчат')) {
            result.hymeniumType = { text: 'Складчатый', icon: '🥟' };
          } else if (low.includes('шиповат') || low.includes('игольчат')) {
            result.hymeniumType = { text: 'Игольчатый / шиповатый', icon: '🦔' };
          } else if (low.includes('дождевик') || low.includes('глеб')) {
            result.hymeniumType = { text: 'Глеба (дождевиковый)', icon: '💨' };
          } else if (cleanLatin.includes('Russula') || cleanLatin.includes('Amanita') || cleanLatin.includes('Lactarius')) {
            result.hymeniumType = { text: 'Пластинчатый (по роду)', icon: '🍄' };
          } else if (cleanLatin.includes('Boletus') || cleanLatin.includes('Suillus') || cleanLatin.includes('Leccinum')) {
            result.hymeniumType = { text: 'Трубчатый (по роду)', icon: '🧽' };
          }
        }

        // Трофика
        if (!result.trophicGroup) {
          if (low.includes('микориз') || low.includes('симбиоз')) {
            result.trophicGroup = { text: 'Микоризообразователь (симбиот)', icon: '🌲' };
          } else if (low.includes('сапротроф') || low.includes('разрушител') || low.includes('подстилк')) {
            result.trophicGroup = { text: 'Сапротроф (разрушитель подстилки/древесины)', icon: '🍂' };
          } else if (low.includes('паразит') || low.includes('трутовик')) {
            result.trophicGroup = { text: 'Гриб-паразит', icon: '🪵' };
          } else if (cleanLatin.includes('Russula') || cleanLatin.includes('Amanita') || cleanLatin.includes('Boletus')) {
            result.trophicGroup = { text: 'Микоризообразователь (симбиот деревьев)', icon: '🌲' };
          }
        }

        // Размеры шляпки и ножки из текста статьи
        if (!result.capDiameter) {
          const capMatch = wikiExtract.match(/(?:шляпк\w*|диаметр(?:ом)?\s*(?:шляпки)?)[^.]{0,50}?(\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*см)/i);
          if (capMatch) result.capDiameter = capMatch[1].replace(/\s+/g, ' ');
        }
        if (!result.stemHeight) {
          const stemMatch = wikiExtract.match(/(?:ножк\w*|высот(?:а|ой)\s*(?:ножки)?)[^.]{0,50}?(\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*см)/i);
          if (stemMatch) result.stemHeight = stemMatch[1].replace(/\s+/g, ' ');
        }

        // Биотоп и деревья-симбионты из описания статьи
        const habitats = [];
        if (low.includes('хвойн')) habitats.push('🌲 Хвойные леса');
        if (low.includes('лиственн')) habitats.push('🌳 Лиственные леса');
        if (low.includes('смешанн')) habitats.push('🌲🌳 Смешанные леса');
        if (low.includes('берёз')) habitats.push('🌿 Берёза');
        if (low.includes('сосн')) habitats.push('🌲 Сосна');
        if (low.includes('ел[ьи]')) habitats.push('🌲 Ель');
        if (low.includes('дуб')) habitats.push('🌳 Дуб');
        if (low.includes('бук')) habitats.push('🌳 Бук');
        if (low.includes('осин')) habitats.push('🌿 Осина');
        if (low.includes('мх') || low.includes('сфагн')) habitats.push('🟢 Моховой покров');
        result.habitatTags = Array.from(new Set(habitats));
      }

      const hasAny = Object.values(result).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));
      const finalRes = hasAny ? result : null;

      lastFungiTraitsDebugData = {
        scientificName: cleanLatin,
        timestamp: new Date().toISOString(),
        parsedTraits: finalRes,
        rawWikidataClaims: wdClaims,
        wikiExtractUsed: wikiExtract || null
      };

      fungiTraitsCache.set(cleanLatin, finalRes);
      return finalRes;
    } catch (e) {
      fungiTraitsCache.set(cleanLatin, null);
      return null;
    }
  }

  /**
   * Отрисовка детализированной панели микологических свойств гриба
   */
  function renderFungiTraitsSection(traits) {
    if (!traits) {
      return `<div class="muted inat-card-empty-note" style="padding: 10px 4px;">ℹ️ В базах Wikidata пока нет детальных микологических характеристик этого гриба.</div>`;
    }

    const items = [];

    // 1. Статус съедобности (главная строка)
    if (traits.edibility) {
      items.push({ icon: traits.edibility.icon, label: 'Съедобность:', val: traits.edibility.text, wide: true });
    }

    // 2. Особые свойства
    if (traits.isMedicinal) {
      items.push({ icon: '💊', label: 'Целебные свойства:', val: 'Лекарственный гриб (фунготерапия)', wide: false });
    }
    if (traits.isPsychoactive) {
      items.push({ icon: '🍄✨', label: 'Специфика:', val: 'Психоактивный / галлюциногенный вид', wide: false });
    }

    // 3. Строение и микоморфология
    if (traits.hymeniumType) {
      items.push({ icon: traits.hymeniumType.icon, label: 'Тип гименофора:', val: traits.hymeniumType.text, wide: false });
    }
    if (traits.capShape) {
      items.push({ icon: traits.capShape.icon, label: 'Форма шляпки:', val: traits.capShape.text, wide: false });
    }
    if (traits.hymeniumAttachment) {
      items.push({ icon: traits.hymeniumAttachment.icon, label: 'Пластинки/ножка:', val: traits.hymeniumAttachment.text, wide: false });
    }
    if (traits.stipeCharacter) {
      items.push({ icon: traits.stipeCharacter.icon, label: 'Особенности ножки:', val: traits.stipeCharacter.text, wide: false });
    }
    if (traits.sporePrintColor) {
      items.push({ icon: traits.sporePrintColor.icon, label: 'Споровый отпечаток:', val: traits.sporePrintColor.text, wide: false });
    }
    if (traits.trophicGroup) {
      items.push({ icon: traits.trophicGroup.icon, label: 'Экологическая роль:', val: traits.trophicGroup.text, wide: false });
    }
    if (traits.capDiameter) {
      items.push({ icon: '📐', label: 'Диаметр шляпки:', val: traits.capDiameter, wide: false });
    }
    if (traits.stemHeight) {
      items.push({ icon: '📏', label: 'Высота ножки:', val: traits.stemHeight, wide: false });
    }

    // 4. Таксономия и типовые виды
    if (traits.parentTaxon) {
      items.push({ icon: '🏛️', label: 'Род / семейство:', val: traits.parentTaxon, wide: false });
    }
    if (traits.taxonAuthor) {
      items.push({ icon: '📜', label: 'Автор таксона:', val: traits.taxonAuthor, wide: false });
    }
    if (traits.typeSpecies) {
      items.push({ icon: '🧬', label: 'Типовой вид рода:', val: traits.typeSpecies, wide: true });
    }
    if (traits.shortName) {
      items.push({ icon: '🏷️', label: 'Сокращение:', val: traits.shortName, wide: false });
    }

    // Интерактивные спойлеры
    // А) Предупреждение о двойниках (P1889)
    let lookalikesHtml = '';
    if (traits.differentFrom && traits.differentFrom.length > 0) {
      lookalikesHtml = `
        <div class="inat-lookalike-warning-banner" style="margin-top: 8px;">
          <span class="warn-icon">🛡️</span>
          <span><b>Не путать с:</b> ${escapeHtml(traits.differentFrom.join(', '))}. Обращайте внимание на цвет млечного сока и ломкость мякоти!</span>
        </div>
      `;
    }

    // Б) Биотоп и деревья-партнеры
    let habitatsHtml = '';
    const allHabitats = [...(traits.symbionts || []), ...(traits.habitatTags || [])];
    if (allHabitats.length > 0) {
      habitatsHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;" open>
          <summary class="inat-sub-spoiler-summary">
            <span>🌲 Биотоп и деревья-партнёры (${allHabitats.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div style="display:flex; flex-wrap:wrap; gap:5px; padding:6px 0;">
              ${allHabitats.map(item => `
                <span class="inat-pill" style="font-size:11px; background:rgba(16, 185, 129, 0.08); border:1px solid rgba(16, 185, 129, 0.3);">
                  ${escapeHtml(item)}
                </span>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    // В) Русские народные названия из энциклопедий (P1810)
    let vernacularHtml = '';
    if (traits.vernacularNamesRu && traits.vernacularNamesRu.length > 0) {
      vernacularHtml = `
        <div style="margin-top: 8px; font-size:11.5px; color:var(--text-muted);">
          📖 <b>Народные названия (из БСЭ/БРЭ):</b> <span style="color:var(--text-main); font-weight:600;">${escapeHtml(traits.vernacularNamesRu.join(', '))}</span>
        </div>
      `;
    }

    // Г) Научные синонимы вида (P1420)
    let synHtml = '';
    if (traits.synonyms && traits.synonyms.length > 0) {
      synHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>📑 Научные синонимы таксона (${traits.synonyms.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <ul style="margin:4px 0 4px 18px; padding:0; font-size:11.5px; font-style:italic; color:var(--text-muted);">
              ${traits.synonyms.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
            </ul>
          </div>
        </details>
      `;
    }

    // Д) Фотографии особи (P18)
    let photosHtml = '';
    if (traits.wikiPhotos?.length) {
      photosHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>📷 Каталожные фото гриба (${traits.wikiPhotos.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div class="inat-footprints-gallery" style="display:flex; gap:8px; overflow-x:auto; padding:6px 0;">
              ${traits.wikiPhotos.map(item => `
                <a href="${getCommonsMediaUrl(item.file, 1400)}" target="_blank" rel="noopener noreferrer" style="flex:0 0 auto; text-align:center; max-width:160px; text-decoration:none;">
                  <img src="${getCommonsMediaUrl(item.file, 320)}" alt="" style="height:115px; width:100%; border-radius:6px; object-fit:cover; border:1px solid var(--border-color); display:block;">
                  ${item.caption ? `<small style="font-size:10.5px; color:var(--text-main); display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.caption)}</small>` : ''}
                  <small style="font-size:10px; color:var(--text-muted); display:block;">Увеличить ↗</small>
                </a>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    // Е) Названия на других языках
    let commonNamesHtml = '';
    if (traits.commonNames?.length) {
      commonNamesHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🌍 Названия на других языках (${traits.commonNames.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div style="display:flex; flex-wrap:wrap; gap:6px; padding:6px 0; max-height:180px; overflow-y:auto;">
              ${traits.commonNames.map(item => `
                <span class="inat-pill" style="font-size:11px; background:rgba(0,0,0,0.04); border:1px solid var(--border-color);">
                  <span style="color:var(--text-muted); font-size:10px;">${escapeHtml(item.langName)}:</span> <b>${escapeHtml(item.text)}</b>
                </span>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    return `
      <div class="inat-traits-grid">
        ${items.map(it => `
          <div class="inat-trait-card ${it.wide ? 'span-2' : ''}">
            <span class="inat-trait-icon">${it.icon}</span>
            <div class="inat-trait-info">
              <span class="inat-trait-lbl">${escapeHtml(it.label)}</span>
              <b class="inat-trait-val">${escapeHtml(it.val)}</b>
            </div>
          </div>
        `).join('')}
      </div>

      ${lookalikesHtml}
      ${habitatsHtml}
      ${vernacularHtml}
      ${synHtml}
      ${photosHtml}
      ${commonNamesHtml}

      <div class="inat-traits-source-note" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
        <span style="font-size:11px; color:var(--text-muted);">📚 Источники: <b>Wikidata (Mycomorphbox)</b>, <b>Wikipedia</b>, <b>БСЭ</b></span>
        <button type="button" class="btn-link" onclick="window.WM.inat.downloadFungiTraitsDebug()" style="font-size:11px; font-weight:600;">💾 Скачать JSON</button>
      </div>
    `;
  }

  /**
   * Парсинг размера выводка / помёта (P7725)
   */
  function parseWikidataLitterSize(claim) {
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== 'value') return null;
    const val = snak.datavalue?.value;
    if (!val || typeof val !== 'object') return null;

    const amount = parseFloat(val.amount);
    if (isNaN(amount)) return null;

    const low = val.lowerBound != null ? parseFloat(val.lowerBound) : null;
    const high = val.upperBound != null ? parseFloat(val.upperBound) : null;
    const fmtAmount = Number.isInteger(amount) ? amount : amount.toFixed(1);

    if (low != null && high != null && !isNaN(low) && !isNaN(high) && low !== high) {
      const fmtLow = Number.isInteger(low) ? low : low.toFixed(1);
      const fmtHigh = Number.isInteger(high) ? high : high.toFixed(1);
      return `${fmtLow}–${fmtHigh} детёнышей (в среднем ${fmtAmount})`;
    }

    return `${fmtAmount} детёнышей`;
  }

  /**
   * Запрос лаконичного описания статьи (REST API Summary)
   */
  async function fetchWikiSummary(titleOrLatin) {
    if (!titleOrLatin) return null;
    const cleanKey = titleOrLatin.trim();
    if (wikiSummaryCache.has(cleanKey)) return wikiSummaryCache.get(cleanKey);

    const tryFetch = async (query) => {
      try {
        const ctl = new AbortController();
        const tmr = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(`https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
          signal: ctl.signal,
          headers: { 'Accept': 'application/json' }
        });
        clearTimeout(tmr);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.type === 'disambiguation' || !data.extract) return null;
        return {
          extract: data.extract,
          description: data.description || '',
          thumbnail: data.thumbnail?.source || null
        };
      } catch (e) {
        return null;
      }
    };

    let result = await tryFetch(cleanKey);
    // Если по русскому названию не нашлось, пробуем по нормализованному с подчёркиваниями
    if (!result && cleanKey.includes(' ')) {
      result = await tryFetch(cleanKey.replace(/\s+/g, '_'));
    }

    wikiSummaryCache.set(cleanKey, result);
    return result;
  }

  /**
   * Запрос съедобности, съедобных частей и лекарственных свойств из Wikidata по латинскому названию (P225)
   */
  // Словарь русских названий съедобных частей растений (P3489)
  const EDIBLE_PARTS_RU = {
    'Q131877': 'ягоды',
    'Q3314483': 'плоды',
    'Q1364': 'плоды',
    'Q10998': 'губка/мякоть',
    'Q28183': 'семена',
    'Q3405': 'листья',
    'Q34442': 'корень / корневище',
    'Q506': 'цветки / соцветия',
    'Q193135': 'орехи',
    'Q188920': 'клубни',
    'Q149955': 'побеги'
  };

  /**
   * Запрос съедобности, съедобных частей и лекарственных свойств из Wikidata
   * Использует прямой Action API (wbsearchentities + wbgetentities) с 100% CORS и кэшированием
   */
  async function fetchWikidataEdibility(latinName) {
    if (!latinName || latinName === 'Не определено') return null;
    const cleanLatin = latinName.trim();
    if (wikidataEdibilityCache.has(cleanLatin)) return wikidataEdibilityCache.get(cleanLatin);

    try {
      const ctl = new AbortController();
      const tmr = setTimeout(() => ctl.abort(), 4500);

      // Шаг 1: Быстрый поиск сущности в Wikidata по научному названию
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(cleanLatin)}&language=en&type=item&limit=3&format=json&origin=*`;
      const sRes = await fetch(searchUrl, { signal: ctl.signal });
      if (!sRes.ok) throw new Error('Search HTTP ' + sRes.status);
      const sData = await sRes.json();
      const entity = sData?.search?.[0];

      if (!entity || !entity.id) {
        wikidataEdibilityCache.set(cleanLatin, null);
        clearTimeout(tmr);
        return null;
      }

      // Шаг 2: Извлечение свойств P199 (съедобность гриба), P3489 (съедобные части) и P2176 (лекарственное)
      const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json&origin=*`;
      const eRes = await fetch(entityUrl, { signal: ctl.signal });
      clearTimeout(tmr);
      if (!eRes.ok) throw new Error('Entity HTTP ' + eRes.status);
      const eData = await eRes.json();
      const claims = eData?.entities?.[entity.id]?.claims || {};

      let edibilityInfo = null;
      const ediblePartsSet = new Set();
      let hasMedicinal = false;

      // P199 — Статус съедобности гриба
      if (claims.P199 && claims.P199.length > 0) {
        for (const claim of claims.P199) {
          const qId = claim.mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_EDIBILITY_MAP[qId]) {
            edibilityInfo = WIKIDATA_EDIBILITY_MAP[qId];
            break;
          }
        }
      }

      // P3489 — Съедобные части растения
      if (claims.P3489 && claims.P3489.length > 0) {
        for (const claim of claims.P3489) {
          const qId = claim.mainsnak?.datavalue?.value?.id;
          if (qId && EDIBLE_PARTS_RU[qId]) {
            ediblePartsSet.add(EDIBLE_PARTS_RU[qId]);
          }
        }
      }

      // P2176 — Лекарственное применение / сырьё
      if (claims.P2176 && claims.P2176.length > 0) {
        hasMedicinal = true;
      }

      const result = {
        edibility: edibilityInfo,
        edibleParts: Array.from(ediblePartsSet),
        isMedicinal: hasMedicinal
      };

      wikidataEdibilityCache.set(cleanLatin, result);
      return result;
    } catch (e) {
      wikidataEdibilityCache.set(cleanLatin, null);
      return null;
    }
  }

  function downloadTraitsDebugJson() {
    if (!lastTraitsDebugData) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Нет данных для скачивания');
      return;
    }
    const str = JSON.stringify(lastTraitsDebugData, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `traits_${lastTraitsDebugData.scientificName.replace(/\s+/g, '_')}_debug.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Запрос записей голосов птиц и звуков природы из Xeno-canto API
   */
  /**
   * Запрос эталонных голосов и звуков птиц/животных из открытой базы iNaturalist
   */
  async function fetchBirdSounds(scientificName) {
    if (!scientificName || scientificName === 'Не определено') return [];
    const cleanName = scientificName.trim();
    if (birdSoundsCache.has(cleanName)) return birdSoundsCache.get(cleanName);

    try {
      const ctl = new AbortController();
      const tmr = setTimeout(() => ctl.abort(), 5000);

      // Ищем подтвержденные исследовательские наблюдения с аудиозаписями
      const url = `https://api.inaturalist.org/v1/observations?taxon_name=${encodeURIComponent(cleanName)}&sounds=true&quality_grade=research&order_by=votes&per_page=4`;
      const res = await fetch(url, { 
        signal: ctl.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(tmr);

      if (!res.ok) {
        birdSoundsCache.set(cleanName, []);
        return [];
      }

      const data = await res.json();
      const results = [];

      (data.results || []).forEach(obsItem => {
        (obsItem.sounds || []).forEach(snd => {
          if (snd.file_url && results.length < 3) {
            let fileUrl = snd.file_url;
            if (fileUrl.startsWith('//')) fileUrl = 'https:' + fileUrl;
            
            results.push({
              id: snd.id,
              file: fileUrl,
              type: 'Голос / Песня 🎵',
              quality: 'A',
              recordist: snd.attribution || obsItem.user?.name || obsItem.user?.login || 'Наблюдатель',
              location: obsItem.place_guess || 'Природный ареал',
              source: 'inat',
              url: `https://www.inaturalist.org/observations/${obsItem.id}`
            });
          }
        });
      });

      birdSoundsCache.set(cleanName, results);
      return results;
    } catch (e) {
      birdSoundsCache.set(cleanName, []);
      return [];
    }
  }

  /**
   * Извлечение числовых биометрических величин из Wikidata
   */
  // Кэш для русских названий сущностей и свойств Wikidata
  const wdLabelsCache = new Map();

  async function resolveWikidataLabels(ids) {
    const toFetch = ids.filter(id => id && !wdLabelsCache.has(id));
    if (!toFetch.length) return;

    try {
      // Запрашиваем пачкой до 50 id за один HTTP-запрос
      const chunk = toFetch.slice(0, 50).join('|');
      const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${chunk}&props=labels&languages=ru|en&format=json&origin=*`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const entities = data?.entities || {};

      for (const id of toFetch) {
        const ent = entities[id];
        const ru = ent?.labels?.ru?.value;
        const en = ent?.labels?.en?.value;
        wdLabelsCache.set(id, ru || en || id);
      }
    } catch (e) {
      console.warn('[Wikidata Labels]', e);
    }
  }

  function parseWikidataQuantity(claim) {
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== 'value') return null;
    const val = snak.datavalue?.value;
    if (!val || typeof val !== 'object') return null;

    let amount = parseFloat(val.amount);
    if (isNaN(amount)) return null;

    const unitUri = val.unit || '';
    let unitStr = '';

    // Масса
    if (unitUri.includes('Q11570')) { // кг
      unitStr = 'кг';
    } else if (unitUri.includes('Q208045')) { // граммы
      if (amount >= 1000) { amount = Math.round((amount / 1000) * 10) / 10; unitStr = 'кг'; }
      else { unitStr = 'г'; }
    } else if (unitUri.includes('Q482798')) { // фунты
      amount = Math.round(amount * 0.453592 * 10) / 10; unitStr = 'кг';
    }
    // Длина / Размеры
    else if (unitUri.includes('Q11573')) { // метры
      if (amount < 1) { amount = Math.round(amount * 100); unitStr = 'см'; }
      else { unitStr = 'м'; }
    } else if (unitUri.includes('Q174728')) { // см
      unitStr = 'см';
    } else if (unitUri.includes('Q174789')) { // мм
      if (amount >= 10) { amount = Math.round((amount / 10) * 10) / 10; unitStr = 'см'; }
      else { unitStr = 'мм'; }
    }
    // Временные интервалы (беременность, срок жизни)
    else if (unitUri.includes('Q573')) { // дни
      unitStr = 'дн.';
    } else if (unitUri.includes('Q577')) { // годы
      unitStr = 'лет';
    } else if (unitUri.includes('Q89')) { // месяцы
      unitStr = 'мес.';
    }

    const fmtAmount = Number.isInteger(amount) ? amount : amount.toFixed(1);

    // Если есть диапазон допустимых значений (например, 112–130 дней)
    if (val.lowerBound && val.upperBound && val.lowerBound !== val.amount) {
      const low = parseFloat(val.lowerBound);
      const high = parseFloat(val.upperBound);
      if (!isNaN(low) && !isNaN(high) && low !== high) {
        return `${Math.round(low)}–${Math.round(high)} ${unitStr} (в среднем ${fmtAmount})`.trim();
      }
    }

    return `${fmtAmount} ${unitStr}`.trim();
  }

  function getCommonsMediaUrl(filename, width = 600) {
    if (!filename) return '';
    const clean = filename.trim().replace(/\s+/g, '_');
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=${width}`;
  }

  /**
   * Комплексный запрос повадок, рациона и биометрии животных (EOL TraitBank + Wikidata + Wikipedia)
   */
  async function fetchAnimalTraits(scientificName, wikiExtract = '') {
    if (!scientificName || scientificName === 'Не определено') return null;
    const cleanLatin = scientificName.trim();
    if (animalTraitsCache.has(cleanLatin)) return animalTraitsCache.get(cleanLatin);

    const result = {
      dielCycle: null,
      diet: null,
      gestation: null,
      weaning: null,     // <-- NEW: Период лактации (P7862)
      litterSize: null,  // <-- NEW: Размер помёта (P7725)
      longevity: null,
      mass: null,
      wingspan: null,
      length: null,
      hibernation: null,
      migration: null,
      qualities: [],     // <-- NEW: Поведение и качества (P1552)
      footprints: [],
      audioFiles: [],
      foodSources: [],
      taxonAuthor: null,
      wikiPhotos: [],
      commonNames: []
    };

    try {
      const ctl = new AbortController();
      const tmr = setTimeout(() => ctl.abort(), 4500);

      // 1. Запрос к Wikidata
      const wdPromise = (async () => {
        try {
          const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(cleanLatin)}&language=en&type=item&limit=3&format=json&origin=*`;
          const sRes = await fetch(sUrl, { signal: ctl.signal });
          if (!sRes.ok) return null;
          const sData = await sRes.json();
          const entity = sData?.search?.[0];
          if (!entity || !entity.id) return null;

          const eUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json&origin=*`;
          const eRes = await fetch(eUrl, { signal: ctl.signal });
          if (!eRes.ok) return null;
          const eData = await eRes.json();
          return eData?.entities?.[entity.id]?.claims || null;
        } catch (e) { return null; }
      })();

      // 2. Запрос в EOL TraitBank
      const eolPromise = (async () => {
        try {
          const searchUrl = `https://eol.org/api/search/1.0.json?q=${encodeURIComponent(cleanLatin)}&page=1&exact=true`;
          const res = await fetch(searchUrl, { signal: ctl.signal });
          if (!res.ok) return null;
          const data = await res.json();
          const pageId = data?.results?.[0]?.id;
          if (!pageId) return null;

          const pUrl = `https://eol.org/api/pages/1.0/${pageId}.json?traits=true&cache_ttl=3600`;
          const pRes = await fetch(pUrl, { signal: ctl.signal });
          if (!pRes.ok) return null;
          const pData = await pRes.json();
          return pData?.traits || [];
        } catch (e) { return null; }
      })();

      const [wdClaims, eolTraits] = await Promise.all([wdPromise, eolPromise]);
      clearTimeout(tmr);

      // --- Разбор Wikidata Claims ---
      if (wdClaims) {
        // Автор таксона и год описания (P225 квалификаторы P405 и P574)
        let authorQId = null;
        let pubYear = null;

        const p225Claim = wdClaims.P225?.[0];
        if (p225Claim?.qualifiers?.P405?.[0]) {
          authorQId = p225Claim.qualifiers.P405[0].datavalue?.value?.id;
        } else if (wdClaims.P405?.[0]) {
          authorQId = wdClaims.P405[0].mainsnak?.datavalue?.value?.id;
        }

        const yearTimeSnak = p225Claim?.qualifiers?.P574?.[0] || wdClaims.P574?.[0];
        if (yearTimeSnak) {
          const rawTime = yearTimeSnak.datavalue?.value?.time;
          if (rawTime) {
            const m = rawTime.match(/^[+-]?(\d{1,4})/);
            if (m) pubYear = parseInt(m[1], 10);
          }
        }

        if (authorQId) {
          await resolveWikidataLabels([authorQId]);
          const authorName = wdLabelsCache.get(authorQId) || authorQId;
          result.taxonAuthor = pubYear ? `${authorName}, ${pubYear}` : authorName;
        } else if (pubYear) {
          result.taxonAuthor = `${pubYear} г.`;
        }

         if (wdClaims.P7862?.[0]) {
          result.weaning = parseWikidataQuantity(wdClaims.P7862[0]);
        }

        // Размер помёта / выводка (P7725)
        if (wdClaims.P7725?.[0]) {
          result.litterSize = parseWikidataLitterSize(wdClaims.P7725[0]);
        }

        // Характерное поведение и качества (P1552) с авто-поиском русских названий
        if (wdClaims.P1552?.length) {
          const qualityQIds = Array.from(new Set(
            wdClaims.P1552
              .map(c => c.mainsnak?.datavalue?.value?.id)
              .filter(Boolean)
          ));

          if (qualityQIds.length) {
            await resolveWikidataLabels(qualityQIds);
            result.qualities = qualityQIds.map(id => {
              if (WIKIDATA_QUALITIES_MAP[id]) {
                return WIKIDATA_QUALITIES_MAP[id];
              }
              const rawLabel = wdLabelsCache.get(id) || id;
              const capLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);
              return {
                text: capLabel,
                icon: '🏷️',
                pill: `🏷️ ${capLabel}`
              };
            });
          }
        }

        // Фотографии особи (P18)
        if (wdClaims.P18?.length) {
          result.wikiPhotos = wdClaims.P18.map(c => {
            const file = c.mainsnak?.datavalue?.value;
            if (!file) return null;
            const caption = c.qualifiers?.P2096?.[0]?.datavalue?.value?.text || '';
            return { file, caption };
          }).filter(Boolean);
        }

        // Народные и национальные названия на разных языках (P1843)
        if (wdClaims.P1843?.length) {
          const names = [];
          const seen = new Set();
          for (const c of wdClaims.P1843) {
            const val = c.mainsnak?.datavalue?.value;
            if (!val || !val.text) continue;
            const text = val.text.trim();
            const lang = (val.language || 'mul').toLowerCase();
            const key = `${lang}:${text.toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              names.push({
                text,
                lang,
                langName: LANG_NAMES_RU[lang] || lang.toUpperCase()
              });
            }
          }
          result.commonNames = names;
        }

        // Суточная активность (P9566)
        if (wdClaims.P9566?.[0]) {
          const qId = wdClaims.P9566[0].mainsnak?.datavalue?.value?.id;
          if (qId && WIKIDATA_DIEL_MAP[qId]) result.dielCycle = WIKIDATA_DIEL_MAP[qId];
        }

        // Период беременности (P3063)
        if (wdClaims.P3063?.[0]) {
          result.gestation = parseWikidataQuantity(wdClaims.P3063[0]);
        }

        // Продолжительность жизни (P4214)
        if (wdClaims.P4214?.[0]) {
          result.longevity = parseWikidataQuantity(wdClaims.P4214[0]);
        }

        // Масса тела (P2067)
        if (wdClaims.P2067?.[0]) {
          result.mass = parseWikidataQuantity(wdClaims.P2067[0]);
        }

        // Длина тела (P2043)
        if (wdClaims.P2043?.[0]) {
          result.length = parseWikidataQuantity(wdClaims.P2043[0]);
        }

        // Размах крыльев (P2050)
        if (wdClaims.P2050?.[0]) {
          result.wingspan = parseWikidataQuantity(wdClaims.P2050[0]);
        }

        // Следы и отпечатки (P14635)
        if (wdClaims.P14635?.length) {
          result.footprints = wdClaims.P14635
            .map(c => c.mainsnak?.datavalue?.value)
            .filter(Boolean);
        }

        // Звуки с Commons (P51)
        if (wdClaims.P51?.length) {
          result.audioFiles = wdClaims.P51
            .map(c => c.mainsnak?.datavalue?.value)
            .filter(Boolean);
        }

        // Кормовая база (P1034)
        if (wdClaims.P1034?.length) {
          const foodQIds = wdClaims.P1034
            .map(c => c.mainsnak?.datavalue?.value?.id)
            .filter(Boolean);

          if (foodQIds.length) {
            await resolveWikidataLabels(foodQIds);
            result.foodSources = foodQIds
              .map(id => wdLabelsCache.get(id))
              .filter(Boolean);
          }
        }
      }

      // --- Разбор данных EOL TraitBank ---
      if (Array.isArray(eolTraits) && eolTraits.length > 0) {
        for (const t of eolTraits) {
          const pred = (t.predicate || t.predicate_label || t.name || '').toLowerCase();
          const val = (t.value || t.object_term || t.value_label || t.literal || '').toLowerCase();
          if (!pred || !val) continue;

          if (!result.dielCycle && (pred.includes('diel') || pred.includes('activity'))) {
            if (val.includes('nocturnal')) result.dielCycle = { text: 'Ночной образ жизни', icon: '🌙', pill: '🌙 Ночной' };
            else if (val.includes('diurnal')) result.dielCycle = { text: 'Дневной образ жизни', icon: '☀️', pill: '☀️ Дневной' };
            else if (val.includes('crepuscular')) result.dielCycle = { text: 'Сумеречный образ жизни', icon: '🌅', pill: '🌅 Сумеречный' };
            else if (val.includes('cathemeral')) result.dielCycle = { text: 'Круглосуточная активность', icon: '🌓', pill: '🌓 Днём и ночью' };
          }

          if (!result.diet && (pred.includes('trophic') || pred.includes('diet') || pred.includes('guild'))) {
            for (const [key, term] of Object.entries(DIET_TERMS_MAP)) {
              if (val.includes(key)) { result.diet = term; break; }
            }
          }

          if (!result.mass && (pred.includes('body mass') || pred.includes('weight'))) {
            result.mass = `${t.value || t.literal || ''} ${t.units || t.unit_label || ''}`.trim();
          }

          if (!result.hibernation && (pred.includes('hibernat') || val.includes('torpor'))) {
            result.hibernation = { text: 'Впадает в зимнюю спячку', icon: '❄️', pill: '❄️ Спячка' };
          }

          if (!result.migration && pred.includes('migrat')) {
            result.migration = { text: 'Перелётный / мигрирующий вид', icon: '🛫', pill: '🛫 Перелётный' };
          }
        }
      }

      // --- Фоллбэк из текста статьи Википедии ---
      if (wikiExtract) {
        const low = wikiExtract.toLowerCase();
        if (!result.diet) {
          if (low.includes('хищн') || low.includes('плотоядн')) {
            result.diet = { text: 'Хищник (плотоядный)', icon: '🥩', pill: '🥩 Хищник' };
          } else if (low.includes('растительноядн') || low.includes('травоядн')) {
            result.diet = { text: 'Травоядный', icon: '🌿', pill: '🌿 Травоядный' };
          } else if (low.includes('всеядн') || low.includes('дикая свинья') || low.includes('кабан')) {
            result.diet = { text: 'Всеядный организм', icon: '🦝', pill: '🦝 Всеядный' };
          } else if (low.includes('насекомоядн')) {
            result.diet = { text: 'Насекомоядный', icon: '🐛', pill: '🐛 Насекомоядный' };
          }
        }

        if (!result.hibernation && (low.includes('зимнюю спячку') || low.includes('впадает в спячку'))) {
          result.hibernation = { text: 'Впадает в зимнюю спячку', icon: '❄️', pill: '❄️ Спячка' };
        }
      }

      const hasAny = Object.values(result).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));
      const finalRes = hasAny ? result : null;

      lastTraitsDebugData = {
        scientificName: cleanLatin,
        timestamp: new Date().toISOString(),
        parsedTraits: finalRes,
        rawWikidataClaims: wdClaims,
        rawEolTraits: eolTraits,
        wikiExtractUsed: wikiExtract || null
      };

      animalTraitsCache.set(cleanLatin, finalRes);
      return finalRes;
    } catch (err) {
      animalTraitsCache.set(cleanLatin, null);
      return null;
    }
  }
  /**
   * Отрисовка интерактивной панели повадок и биометрии животных
   */
  function renderTraitsSection(traits) {
    if (!traits) {
      return `
        <div class="muted inat-card-empty-note" style="padding: 10px 4px;">
          ℹ️ В базах Wikidata и EOL пока нет данных о повадках и биометрии данного вида.
        </div>
      `;
    }
    const items = [];

    if (traits.taxonAuthor) {
      items.push({ icon: '📜', label: 'Автор таксона:', val: traits.taxonAuthor, wide: false });
    }
    if (traits.dielCycle) {
      items.push({ icon: traits.dielCycle.icon, label: 'Активность:', val: traits.dielCycle.text, wide: false });
    }
    if (traits.diet) {
      items.push({ icon: traits.diet.icon, label: 'Тип питания:', val: traits.diet.text, wide: false });
    }
    if (traits.mass) {
      items.push({ icon: '⚖️', label: 'Масса тела:', val: traits.mass, wide: false });
    }
    if (traits.length) {
      items.push({ icon: '📐', label: 'Длина тела:', val: traits.length, wide: false });
    }
    if (traits.wingspan) {
      items.push({ icon: '📏', label: 'Размах крыльев:', val: traits.wingspan, wide: false });
    }
    if (traits.hibernation) {
      items.push({ icon: traits.hibernation.icon, label: 'Зимовка:', val: traits.hibernation.text, wide: false });
    }
    if (traits.migration) {
      items.push({ icon: traits.migration.icon, label: 'Миграции:', val: traits.migration.text, wide: false });
    }
    if (traits.gestation) {
      items.push({ icon: '🤰', label: 'Беременность:', val: traits.gestation, wide: false });
    }
    if (traits.weaning) {
      items.push({ icon: '🥛', label: 'Вскармливание:', val: traits.weaning, wide: false });
    }
    if (traits.litterSize) {
      items.push({ icon: '🍼', label: 'Помёт / выводок:', val: traits.litterSize, wide: false });
    }
    if (traits.longevity) {
      items.push({ icon: '⏳', label: 'Срок жизни:', val: traits.longevity, wide: false });
    }
    if (traits.qualities && traits.qualities.length > 0) {
      traits.qualities.forEach(q => {
        // Поведение и качества обычно длинные — выводим на всю ширину (span-2)
        items.push({ icon: q.icon || '🏷️', label: 'Поведение:', val: q.text, wide: true });
      });
    }

    let photosHtml = '';
    if (traits.wikiPhotos && traits.wikiPhotos.length > 0) {
      photosHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>📷 Фотографии особи из каталога (${traits.wikiPhotos.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div class="inat-footprints-gallery" style="display:flex; gap:8px; overflow-x:auto; padding:6px 0;">
              ${traits.wikiPhotos.map(item => `
                <a href="${getCommonsMediaUrl(item.file, 1400)}" target="_blank" rel="noopener noreferrer" class="inat-footprint-card" style="flex:0 0 auto; text-align:center; text-decoration:none; max-width:180px;">
                  <img src="${getCommonsMediaUrl(item.file, 320)}" alt="${escapeHtml(item.caption || 'Фото особи')}" style="height:120px; width:100%; border-radius:6px; object-fit:cover; border:1px solid var(--border-color); display:block;">
                  ${item.caption ? `<small style="font-size:10.5px; color:var(--text-main); margin-top:4px; display:block; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.caption)}">${escapeHtml(item.caption)}</small>` : ''}
                  <small style="font-size:10px; color:var(--text-muted); display:block;">Оригинал ↗</small>
                </a>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    let commonNamesHtml = '';
    if (traits.commonNames && traits.commonNames.length > 0) {
      commonNamesHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🌍 Названия на других языках (${traits.commonNames.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div style="display:flex; flex-wrap:wrap; gap:6px; padding:6px 0; max-height:220px; overflow-y:auto;">
              ${traits.commonNames.map(item => `
                <span class="inat-pill" style="font-size:11px; background:rgba(0,0,0,0.04); border:1px solid var(--border-color); display:inline-flex; align-items:center; gap:4px;">
                  <span style="color:var(--text-muted); font-size:10px; font-weight:700;">${escapeHtml(item.langName)}:</span>
                  <b>${escapeHtml(item.text)}</b>
                </span>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    let footprintsHtml = '';
    if (traits.footprints && traits.footprints.length > 0) {
      footprintsHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🐾 Отпечатки лап и следы (${traits.footprints.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div class="inat-footprints-gallery" style="display:flex; gap:8px; overflow-x:auto; padding:6px 0;">
              ${traits.footprints.map(file => `
                <a href="${getCommonsMediaUrl(file, 1200)}" target="_blank" rel="noopener noreferrer" class="inat-footprint-card" style="flex:0 0 auto; text-align:center; text-decoration:none;">
                  <img src="${getCommonsMediaUrl(file, 260)}" alt="След животного" style="height:110px; border-radius:6px; object-fit:cover; border:1px solid var(--border-color); display:block;">
                  <small style="font-size:10px; color:var(--text-muted); margin-top:3px; display:block;">Увеличить ↗</small>
                </a>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    let audioHtml = '';
    if (traits.audioFiles && traits.audioFiles.length > 0) {
      audioHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🔊 Голос вида (Wikimedia Commons)</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body" style="padding: 6px 0;">
            ${traits.audioFiles.map(file => `
              <div class="inat-sound-item-card" style="margin-bottom:6px;">
                <div style="font-size:11.5px; margin-bottom:4px; font-weight:600; color:var(--text-main);">
                  🎵 ${escapeHtml(file.replace(/\.[^/.]+$/, ''))}
                </div>
                <audio controls src="${getCommonsMediaUrl(file)}" preload="none" style="width:100%; height:32px;"></audio>
              </div>
            `).join('')}
          </div>
        </details>
      `;
    }

    let foodSourcesHtml = '';
    if (traits.foodSources && traits.foodSources.length > 0) {
      foodSourcesHtml = `
        <details class="inat-sub-spoiler" style="margin-top: 8px;">
          <summary class="inat-sub-spoiler-summary">
            <span>🍽️ Кормовая база (${traits.foodSources.length} наим.)</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-sub-spoiler-body">
            <div class="inat-food-pills-wrap" style="display:flex; flex-wrap:wrap; gap:5px; padding:6px 0;">
              ${traits.foodSources.map(name => `
                <span class="inat-pill" style="font-size:11px; background:rgba(0,0,0,0.05); border:1px solid var(--border-color);">
                  🌿 ${escapeHtml(name)}
                </span>
              `).join('')}
            </div>
          </div>
        </details>
      `;
    }

    return `
      <div class="inat-traits-grid">
        ${items.map(it => `
          <div class="inat-trait-card ${it.wide ? 'span-2' : ''}">
            <span class="inat-trait-icon">${it.icon}</span>
            <div class="inat-trait-info">
              <span class="inat-trait-lbl">${escapeHtml(it.label)}</span>
              <b class="inat-trait-val">${escapeHtml(it.val)}</b>
            </div>
          </div>
        `).join('')}
      </div>

      ${photosHtml}
      ${commonNamesHtml}
      ${foodSourcesHtml}
      ${footprintsHtml}
      ${audioHtml}

      <div class="inat-traits-source-note" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
        <span style="font-size:11px; color:var(--text-muted);">📚 Источники: <b>Wikidata</b>, <b>EOL</b>, <b>Commons</b></span>
        <button type="button" class="btn-link" onclick="window.WM.inat.downloadTraitsDebug()" style="font-size:11px; font-weight:600;">
          💾 Скачать JSON
        </button>
      </div>
    `;
  }

  /**
   * Отрисовка аудиоплееров голосов и звуков птиц
   */
  function renderSoundsSection(soundsList, inatSounds = []) {
    const allSounds = [];

    // Звуки непосредственно этого наблюдения iNaturalist
    inatSounds.forEach((s, idx) => {
      if (s.file_url) {
        allSounds.push({
          file: s.file_url,
          type: `Запись наблюдателя #${idx + 1} 📍`,
          recordist: s.attribution || 'Наблюдатель iNat',
          source: 'inat',
          location: 'Эта точка наблюдения'
        });
      }
    });

    // Звуки из библиотеки Xeno-canto
    soundsList.forEach(s => allSounds.push(s));

    if (!allSounds.length) return '';

    return `
      <details class="inat-card-spoiler" id="spoiler-inat-sounds" style="margin-bottom: 10px;">
        <summary class="inat-card-spoiler-summary">
          <span>🎵 Голоса и звуки природы (${allSounds.length})</span>
          <span class="chevron">▼</span>
        </summary>
        <div class="inat-card-spoiler-body">
          <div class="inat-sounds-list">
            ${allSounds.map(s => `
              <div class="inat-sound-item-card">
                <div class="inat-sound-head-row">
                  <div class="inat-sound-title-wrap">
                    <span class="inat-sound-badge-type">${escapeHtml(s.type || 'Запись')}</span>
                    ${s.quality ? `<span class="inat-sound-badge-quality q-${s.quality.toLowerCase()}">Класс ${escapeHtml(s.quality)}</span>` : ''}
                    ${s.source === 'inat' ? '<span class="inat-sound-badge-source inat">iNaturalist</span>' : '<span class="inat-sound-badge-source xc">Xeno-canto</span>'}
                  </div>
                  ${s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="inat-sound-ext-link">↗ Xeno-canto</a>` : ''}
                </div>
                <audio controls src="${escapeHtml(s.file)}" preload="none" class="inat-sound-player"></audio>
                <div class="inat-sound-meta-row">
                  ${s.location ? `<span class="inat-sound-loc" title="${escapeHtml(s.location)}">📍 ${escapeHtml(s.location)}</span>` : ''}
                  ${s.recordist ? `<span class="inat-sound-author" title="${escapeHtml(s.recordist)}">👤 ${escapeHtml(s.recordist)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </details>
    `;
  }

  function applyControlledTermFilter(params) {
    const taxa = config.taxa || '';

    // 1. Для растений — Plant Phenology (term_id=12)
    if (taxa.includes('Plantae')) {
      if (config.phenology && config.phenology !== 'any') {
        params.set('term_id', '12');
        if (config.phenology === 'flowering') params.set('term_value_id', '13');
        else if (config.phenology === 'fruiting') params.set('term_value_id', '14');
        else if (config.phenology === 'budding') params.set('term_value_id', '15');
        else if (config.phenology === 'vegetative') params.set('term_value_id', '21');
      }
      return;
    }

    // 2. Для насекомых — Life Stage (term_id=1)
    if (taxa === 'Insecta') {
      if (config.lifestageInsects && config.lifestageInsects !== 'any') {
        params.set('term_id', '1');
        if (config.lifestageInsects === 'adult') params.set('term_value_id', '2');
        else if (config.lifestageInsects === 'larva') params.set('term_value_id', '6');
        else if (config.lifestageInsects === 'pupa') params.set('term_value_id', '4');
        else if (config.lifestageInsects === 'nymph') params.set('term_value_id', '5');
        else if (config.lifestageInsects === 'egg') params.set('term_value_id', '7');
      }
      return;
    }

    // 3. Для птиц и животных — Life Stage (term_id=1)
    if (taxa === 'Aves' || taxa === 'Mammalia' || taxa === 'Amphibia,Reptilia') {
      if (config.lifestageAnimals && config.lifestageAnimals !== 'any') {
        params.set('term_id', '1');
        if (config.lifestageAnimals === 'adult') params.set('term_value_id', '2');
        else if (config.lifestageAnimals === 'juvenile') params.set('term_value_id', '8');
      }
      return;
    }
  }

  let hoveredCluster = null;
  let lastCardOpenTime = 0;

  function openHovered() {
    if (!hoveredCluster) return false;
    const now = Date.now();
    if (now - lastCardOpenTime < 400) return true;
    lastCardOpenTime = now;

    if (hoveredCluster.isSingle) {
      openObservationCard(hoveredCluster.primaryObs);
    } else {
      highlightObservationZone(hoveredCluster.primaryObs);
      openClusterModal(hoveredCluster.items);
    }
    return true;
  }

  function isCrosshairSelectable() {
    if (!config.enabled) return false;
    const mode = config.selectMode || 'crosshair';
    if (mode === 'click') return false;
    return !!hoveredCluster;
  }

  const MIN_VIEW_ZOOM = 11; // <-- Сетка активна при зуме < 11, детальные метки — на зуме 11+
  const MIN_FILTER_ZOOM = 6;

  // ---- Sparse Fieldsets (v2 RISON format) ----
  // Сокращает вес ответа со 800 КБ до ~35-45 КБ
  const OBSERVATION_FIELDS_LIGHT = '(id:!t,geojson:!t,location:!t,positional_accuracy:!t,quality_grade:!t,observed_on:!t,time_observed_at:!t,species_guess:!t,taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,rank:!t,default_photo:(square_url:!t)),photos:(url:!t))';

  const MIN_REQUEST_GAP_MS = 1100;
  const BBOX_PAD = 0.08;
  const FETCH_DEBOUNCE_MS = 400;
  const CACHE_MAX = 2000;
  const COVERAGE_TTL_MS = 5 * 60 * 1000;

  const manualExpandedClusters = new Set();

  const obsCache = new Map();
  const fullDetailsCache = new Map(); // id -> full observation
  let cacheKey = null;
  let coverage = null;
  let inflight = null;
  let fetchSeq = 0;
  let lastRequestAt = 0;
  let cooldownUntil = 0;
  let failCount = 0;
  let announceFilter = false;
  let crossRaf = 0;

  let config = { ...DEFAULT_CONFIG };
  try {
    const saved = localStorage.getItem('wm_inat_config');
    if (saved) config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
  } catch (e) {}

  let map = null;
  let overviewTileLayer = null;
  let layer = null;
  const activeObservations = new Map();
  const markerInstances = new Map();
  let fetchTimer = null;
  let accuracyCircle = null;

  // Динамическая подсветка зоны произрастания под перекрестием
  let hoverZoneLayer = null;
  let hoveredObsId = null;

  // Поиск и фильтрация на карте
  let searchType = 'global';
  let activeMapFilter = null;
  let searchDebounceTimer = null;
  let autocompleteDebounceTimer = null;
  let autocompleteAbortCtl = null;
  let selectedTaxon = null;

  // Список в модальном окне
  let lastInatSearchQuery = '';
  let inatSnapshotList = null;
  let currentRenderZoom = 13;

  // =========================================================================
  // НЕЙРОСЕТЕВЫЕ АРЕАЛЫ ОБИТАНИЯ (GEOMODEL TILES v2)
  // =========================================================================
  let geomodelTileLayer = null;
  let activeGeomodelTaxon = null;
  let geomodelType = 'geomodel'; // 'geomodel' | 'geomodel_comparison'
  let geomodelOpacity = 0.65;

  const RANKS_RU = {
    kingdom: 'царство',
    phylum: 'отдел / тип',
    subphylum: 'подотдел',
    class: 'класс',
    subclass: 'подкласс',
    order: 'порядок',
    suborder: 'подпорядок',
    family: 'семейство',
    subfamily: 'подсемейство',
    tribe: 'триба',
    genus: 'род',
    subgenus: 'подрод',
    species: 'вид',
    subspecies: 'подвид',
    variety: 'разновидность',
    form: 'форма',
    hybrid: 'гибрид',
    complex: 'комплекс видов'
  };

  const TAXA_CONFIG = {
    Plantae: { name: 'Растение', groupName: 'Растения', icon: '🌿', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
    Fungi: { name: 'Гриб', groupName: 'Грибы и лишайники', icon: '🍄', color: '#d97706', bg: 'rgba(217, 119, 6, 0.14)' },
    Insecta: { name: 'Насекомое', groupName: 'Насекомые', icon: '🐞', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)' },
    Arachnida: { name: 'Паукообразное', groupName: 'Паукообразные', icon: '🕷️', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.14)' },
    Mollusca: { name: 'Моллюск', groupName: 'Моллюски', icon: '🐌', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.14)' },
    Aves: { name: 'Птица', groupName: 'Птицы', icon: '🦅', color: '#0284c7', bg: 'rgba(2, 132, 199, 0.14)' },
    Mammalia: { name: 'Млекопитающее', groupName: 'Млекопитающие', icon: '🦊', color: '#ea580c', bg: 'rgba(234, 88, 12, 0.14)' },
    Amphibia: { name: 'Земноводное', groupName: 'Земноводные', icon: '🐸', color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.14)' },
    Reptilia: { name: 'Пресмыкающееся', groupName: 'Пресмыкающиеся', icon: '🦎', color: '#84cc16', bg: 'rgba(132, 204, 22, 0.14)' },
    Actinopterygii: { name: 'Рыба', groupName: 'Рыбы', icon: '🐟', color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.14)' },
    Animalia: { name: 'Животное', groupName: 'Животные', icon: '🐾', color: '#f97316', bg: 'rgba(249, 115, 22, 0.14)' },
    Chromista: { name: 'Водоросль', groupName: 'Хромисты / Водоросли', icon: '🪸', color: '#0d9488', bg: 'rgba(13, 148, 136, 0.14)' },
    Protozoa: { name: 'Простейшее', groupName: 'Простейшие', icon: '🔬', color: '#6366f1', bg: 'rgba(99, 102, 241, 0.14)' },
    default: { name: 'Организм', groupName: 'Живой организм', icon: '🌱', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' }
  };

  const IUCN_MAP = {
    EX: 'Исчезнувший (EX)',
    EW: 'Исчезнувший в дикой природе (EW)',
    CR: 'На грани исчезновения (CR)',
    EN: 'Вымирающий (EN)',
    VU: 'Уязвимый (VU)',
    NT: 'Близкий к угрожаемому (NT)',
    LC: 'Наименьший риск (LC)',
    DD: 'Недостаток данных (DD)'
  };

  // =========================================================================
  // КЭШИ ЗВУКОВ (XENO-CANTO) И ЧЕРТ ЖИВОТНЫХ (EOL TRAITBANK & WIKIDATA)
  // =========================================================================
  const birdSoundsCache = new Map();   // latin -> [ { file, type, quality, recordist, location, url } ]
  const animalTraitsCache = new Map(); // latin -> { dielCycle, diet, hibernation, migration, mass, wingspan, length }

  // Соответствие суточной активности животных (Wikidata P9566)
  const WIKIDATA_DIEL_MAP = {
    'Q101029366': { text: 'Ночной образ жизни', icon: '🌙', pill: '🌙 Ночной' },
    'Q4284186': { text: 'Дневной образ жизни', icon: '☀️', pill: '☀️ Дневной' },
    'Q1147576': { text: 'Сумеречный образ жизни', icon: '🌅', pill: '🌅 Сумеречный' },
    'Q5051419': { text: 'Круглосуточная активность', icon: '🌓', pill: '🌓 Днём и ночью' },
    'Q1900130': { text: 'Утренняя активность', icon: '🌄', pill: '🌄 Утренний' },
    'Q17013876': { text: 'Вечерняя активность', icon: '🌇', pill: '🌇 Вечерний' }
  };

  // Словарь типов питания и трофических групп (EOL & Wikidata P1034)
  const DIET_TERMS_MAP = {
    'carnivore': { text: 'Хищник (плотоядный)', icon: '🥩', pill: '🥩 Хищник' },
    'carnivorous': { text: 'Хищник (плотоядный)', icon: '🥩', pill: '🥩 Хищник' },
    'predator': { text: 'Хищник', icon: '🥩', pill: '🥩 Хищник' },
    'q1053008': { text: 'Хищник (плотоядный)', icon: '🥩', pill: '🥩 Хищник' },
    'q59199': { text: 'Хищник', icon: '🥩', pill: '🥩 Хищник' },

    'herbivore': { text: 'Травоядный (растительноядный)', icon: '🌿', pill: '🌿 Травоядный' },
    'herbivorous': { text: 'Травоядный', icon: '🌿', pill: '🌿 Травоядный' },
    'q164509': { text: 'Травоядный', icon: '🌿', pill: '🌿 Травоядный' },
    'q59203': { text: 'Травоядный', icon: '🌿', pill: '🌿 Травоядный' },

    'omnivore': { text: 'Всеядный', icon: '🦝', pill: '🦝 Всеядный' },
    'omnivorous': { text: 'Всеядный', icon: '🦝', pill: '🦝 Всеядный' },
    'q59207': { text: 'Всеядный', icon: '🦝', pill: '🦝 Всеядный' },
    'q12806437': { text: 'Всеядный', icon: '🦝', pill: '🦝 Всеядный' },

    'insectivore': { text: 'Насекомоядный', icon: '🐛', pill: '🐛 Насекомоядный' },
    'insectivorous': { text: 'Насекомоядный', icon: '🐛', pill: '🐛 Насекомоядный' },
    'q139045': { text: 'Насекомоядный', icon: '🐛', pill: '🐛 Насекомоядный' },
    'q677088': { text: 'Насекомоядный', icon: '🐛', pill: '🐛 Насекомоядный' },

    'piscivore': { text: 'Рыбоядный', icon: '🐟', pill: '🐟 Рыбоядный' },
    'piscivorous': { text: 'Рыбоядный', icon: '🐟', pill: '🐟 Рыбоядный' },
    'q139047': { text: 'Рыбоядный', icon: '🐟', pill: '🐟 Рыбоядный' },

    'frugivore': { text: 'Плодоядный', icon: '🍓', pill: '🍓 Плодоядный' },
    'frugivorous': { text: 'Плодоядный', icon: '🍓', pill: '🍓 Плодоядный' },
    'q147137': { text: 'Плодоядный', icon: '🍓', pill: '🍓 Плодоядный' },

    'granivore': { text: 'Зерноядный', icon: '🌾', pill: '🌾 Зерноядный' },
    'granivorous': { text: 'Зерноядный', icon: '🌾', pill: '🌾 Зерноядный' },

    'nectarivore': { text: 'Нектароядный', icon: '🌸', pill: '🌸 Нектароядный' },
    'nectarivorous': { text: 'Нектароядный', icon: '🌸', pill: '🌸 Нектароядный' }
  };

  // Кэш для русских названий видов
const ruTaxaNamesCache = new Map();

async function resolveRussianTaxonName(latinName, onResolved) {
  if (!latinName) return;
  if (ruTaxaNamesCache.has(latinName)) {
    const cached = ruTaxaNamesCache.get(latinName);
    if (cached) onResolved(cached);
    return;
  }

  try {
    // Бесплатный запрос к API Википедии с автоматическим следованием по редиректам (redirects=1)
    const url = `https://ru.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(latinName)}&redirects=1&format=json&origin=*`;
    const res = await fetch(url);
    const data = await res.json();
    const pages = data?.query?.pages;
    if (pages) {
      const page = Object.values(pages)[0];
      if (page && page.title && !page.missing) {
        // Если статья найдена на русском языке
        const ruTitle = page.title;
        ruTaxaNamesCache.set(latinName, ruTitle);
        onResolved(ruTitle);
        return;
      }
    }
  } catch (e) {}
  ruTaxaNamesCache.set(latinName, null);
}

  function saveConfig() {
    try { localStorage.setItem('wm_inat_config', JSON.stringify(config)); } catch (e) {}
  }

  function parseJwt(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      const parts = token.trim().split('.');
      if (parts.length < 2) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      const jsonStr = decodeURIComponent(escape(atob(base64)));
      return JSON.parse(jsonStr);
    } catch (e) { return null; }
  }

  function getTokenInfo() {
    const raw = getToken();
    if (!raw) return { exists: false, isValid: false, isExpired: false, expDate: null, timeLeftMs: 0 };
    const payload = parseJwt(raw);
    if (!payload || !payload.exp) {
      return { exists: true, isValid: true, isExpired: false, expDate: null, timeLeftMs: Infinity };
    }
    const expDate = new Date(payload.exp * 1000);
    const timeLeftMs = expDate.getTime() - Date.now();
    const isExpired = timeLeftMs <= 0;
    return {
      exists: true,
      isValid: !isExpired,
      isExpired,
      expDate,
      timeLeftMs: Math.max(0, timeLeftMs),
      userId: payload.user_id
    };
  }

  // Проверка: входит ли текущий месяц в Топ-5 месяцев активности вида по гистограмме
  async function isTaxonInSeasonTop5(taxonId, targetMonth = null) {
    if (!taxonId) return true; // Если таксон не определен, не скрываем
    
    const curM = targetMonth || (new Date().getMonth() + 1);
    let moy = histogramCache.get(taxonId);

    if (!moy) {
      moy = await fetchSeasonalityHistogram(taxonId);
    }
    if (!moy) return true; // При ошибке сети не скрываем точку

    // Преобразуем объект { "1": 12, "2": 45, ... } в массив пар [месяц, кол-во]
    const monthsData = [];
    for (let m = 1; m <= 12; m++) {
      monthsData.push({ month: m, count: Number(moy[String(m)]) || 0 });
    }

    // Сортируем по убыванию количества находок
    monthsData.sort((a, b) => b.count - a.count);

    // Берём топ-5 месяцев
    const top5Months = monthsData.slice(0, 5).map(item => item.month);

    return top5Months.includes(curM);
  }

  function formatTimeLeft(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h} ч ${pad(m)} мин ${pad(s)} с`;
    if (m > 0) return `${m} мин ${pad(s)} с`;
    return `${s} с`;
  }

  function getToken() { return localStorage.getItem('wm_inat_key') || ''; }

  // 1. Умное извлечение JWT токена (включая JSON {"api_token":"..."})
  function extractRawToken(input) {
    if (!input || typeof input !== 'string') return '';
    let str = input.trim();

    // Если вставлен сырой JSON вида {"api_token":"..."}
    if (str.startsWith('{') && str.endsWith('}')) {
      try {
        const parsed = JSON.parse(str);
        if (parsed.api_token && typeof parsed.api_token === 'string') {
          str = parsed.api_token.trim();
        }
      } catch (e) {
        // Резервный regex если JSON повреждён
        const match = str.match(/"api_token"\s*:\s*"([^"]+)"/i);
        if (match && match[1]) str = match[1].trim();
      }
    }

    // Если скопировано с префиксом Bearer
    if (str.startsWith('Bearer ')) {
      str = str.replace(/^Bearer\s+/i, '').trim();
    }

    // Снятие внешних случайных кавычек
    str = str.replace(/^["']|["']$/g, '');

    return str;
  }

  function setToken(token) {
    const cleanToken = extractRawToken(token);
    if (cleanToken) {
      localStorage.setItem('wm_inat_key', cleanToken);
    } else {
      localStorage.removeItem('wm_inat_key');
    }
    syncTokenUI();
    updateVisionTokenNotice();
    updateQuickHubTokenNotice();
  }

  function removeToken() {
    localStorage.removeItem('wm_inat_key');
    syncTokenUI();
    updateVisionTokenNotice();
    updateQuickHubTokenNotice();
  }

  let tokenCountdownTimer = null;
  function syncTokenUI() {
    const inp = document.getElementById('inat-token-input');
    const statusEl = document.getElementById('inat-token-status');
    const btnClear = document.getElementById('btn-inat-token-clear');
    const curToken = getToken();

    if (inp && document.activeElement !== inp) inp.value = curToken;
    if (btnClear) btnClear.hidden = !curToken;

    if (tokenCountdownTimer) {
      clearInterval(tokenCountdownTimer);
      tokenCountdownTimer = null;
    }

    if (!statusEl) return;
    if (!curToken) {
      statusEl.innerHTML = '<span style="color: var(--text-muted);">⚪ Токен не введён. Для просмотра карты и умных подсказок он не требуется.</span>';
      return;
    }

    const updateCountdown = () => {
      const info = getTokenInfo();
      if (!info.exists) {
        statusEl.innerHTML = '<span style="color: var(--text-muted);">⚪ Используется открытый гостевой доступ</span>';
        return;
      }
      if (info.isExpired) {
        statusEl.innerHTML = '<span style="color: #ef4444; font-weight: 700;">🔴 Срок действия токена истёк (прошло 24 ч)! Обновите токен на inaturalist.org</span>';
        updateVisionTokenNotice();
      } else if (info.expDate) {
        const timeStr = formatTimeLeft(info.timeLeftMs);
        const expClock = info.expDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        statusEl.innerHTML = `
          <div style="color: #10b981; font-weight: 700;">🟢 Токен активен</div>
          <div style="font-size: 11.5px; margin-top: 2px;">⏳ До окончания: <b>${timeStr}</b> (до ${expClock})</div>
        `;
      } else {
        statusEl.innerHTML = '<span style="color: #10b981;">🟢 Личный токен сохранён</span>';
      }
    };

    updateCountdown();
    tokenCountdownTimer = setInterval(updateCountdown, 1000);
  }

  function updateVisionTokenNotice() {
    const alertBox = document.getElementById('inat-vision-token-warning');
    const titleEl = document.getElementById('inat-vision-token-warning-title');
    const descEl = document.getElementById('inat-vision-token-warning-desc');
    const btnPick = document.getElementById('btn-inat-vision-pick');
    if (!alertBox) return;

    const info = getTokenInfo();
    if (!info.exists) {
      alertBox.hidden = false;
      if (titleEl) titleEl.textContent = '🔑 Требуется API токен iNaturalist';
      if (descEl) descEl.innerHTML = 'Нейросеть распознавания фото требует 24-часовой токен. Введите его в настройках выше.';
      if (btnPick && !isVisionLoading) {
        btnPick.classList.add('btn-secondary');
        btnPick.classList.remove('btn-primary');
      }
    } else if (info.isExpired) {
      alertBox.hidden = false;
      if (titleEl) titleEl.textContent = '⚠️ Срок действия токена истёк (24 ч)';
      if (descEl) descEl.innerHTML = 'Срок жизни токена подошёл к концу. Обновите его на inaturalist.org/users/api_token.';
      if (btnPick && !isVisionLoading) {
        btnPick.classList.add('btn-secondary');
        btnPick.classList.remove('btn-primary');
      }
    } else {
      alertBox.hidden = true;
      if (btnPick && !isVisionLoading) {
        btnPick.classList.remove('btn-secondary');
        btnPick.classList.add('btn-primary');
      }
    }
  }

  function getMonthsForSeason(season) {
    if (season === 'current') {
      const curMonth = new Date().getMonth() + 1;
      if ([12, 1, 2].includes(curMonth)) return '12,1,2';
      if ([3, 4, 5].includes(curMonth)) return '3,4,5';
      if ([6, 7, 8].includes(curMonth)) return '6,7,8';
      return '9,10,11';
    }
    const seasonsMap = { spring: '3,4,5', summer: '6,7,8', autumn: '9,10,11', winter: '12,1,2' };
    return seasonsMap[season] || '';
  }

  function getTaxonMeta(taxon) {
    const iconic = taxon?.iconic_taxon_name || '';
    return TAXA_CONFIG[iconic] || TAXA_CONFIG.default;
  }

  function getTaxonIcon(taxon) { return getTaxonMeta(taxon).icon; }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  function clearAccuracyCircle() {
    if (accuracyCircle && map) {
      map.removeLayer(accuracyCircle);
      accuracyCircle = null;
    }
  }

  function clearHoverHighlight(retainId = false) {
    if (!retainId) hoveredObsId = null;
    if (hoverZoneLayer && map) {
      map.removeLayer(hoverZoneLayer);
      hoverZoneLayer = null;
    }
    document.querySelectorAll('.inat-crosshair-hovered').forEach(el => el.classList.remove('inat-crosshair-hovered'));
  }

  // =========================================================================
  // СЕТЬ: ЕДИНАЯ ТОЧКА ДОСТУПА К API (v2 С ПОДДЕРЖКОЙ SPARSE FIELDSETS)
  // =========================================================================
  function getAuthHeader() {
    const info = getTokenInfo();
    if (!info.exists || info.isExpired) return null;
    const raw = getToken();
    return raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  }

  async function inatGet(path, params, signal, apiVersion = 'v2') {
    if (Date.now() < cooldownUntil) {
      const e = new Error('rate-limit cooldown');
      e.status = 429;
      e.retryAfterMs = cooldownUntil - Date.now();
      throw e;
    }
    const queryString = params ? `?${params.toString()}` : '';
    const url = `https://api.inaturalist.org/${apiVersion}/${path}${queryString}`;

    const doFetch = (withAuth) => {
      const headers = { 
        'Accept': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' // <-- ГАРАНТИРУЕТ РУССКИЙ ЯЗЫК В WEBVIEW И APK
      };
      if (withAuth) {
        const h = getAuthHeader();
        if (h) headers['Authorization'] = h;
      }
      return fetch(url, { headers, signal });
    };

    lastRequestAt = Date.now();
    let res = await doFetch(true);
    if (res.status === 401 && getAuthHeader()) {
      lastRequestAt = Date.now();
      res = await doFetch(false);
    }
    if (res.status === 429) {
      const ra = parseInt(res.headers.get('Retry-After') || '', 10);
      const e = new Error('HTTP 429');
      e.status = 429;
      e.retryAfterMs = ra > 0 ? ra * 1000 : 60000;
      throw e;
    }
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  function extractLatLng(obs) {
    let lat = null, lng = null;
    if (obs.geojson && obs.geojson.coordinates) {
      lng = obs.geojson.coordinates[0];
      lat = obs.geojson.coordinates[1];
    } else if (obs.location) {
      const p = String(obs.location).split(',');
      lat = parseFloat(p[0]);
      lng = parseFloat(p[1]);
    }
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  }

  // =========================================================================
  // АДАПТИВНАЯ ЭКРАННАЯ КЛАСТЕРИЗАЦИЯ
  // =========================================================================
  function getClusterRadiusPx(zoom, mode) {
    if (mode === 'compact') {
      if (zoom <= 9) return 56;
      if (zoom <= 11) return 48;
      return 38;
    }
    // Для режима карточек-плашек (bubble):
    // Учитывает габариты карточки (~180px шириной), чтобы плашки не слипались
    if (zoom <= 13) return 76;
    if (zoom === 14) return 66;
    if (zoom === 15) return 54;
    if (zoom === 16) return 44;
    if (zoom === 17) return 34;
    if (zoom === 18) return 24;
    return 16;
  }

  function createClusterData(items) {
    const taxonCounts = new Map();
    for (const obs of items) {
      const t = obs.taxon;
      const tid = t?.id || ('guess_' + (obs.species_guess || 'unknown'));
      let entry = taxonCounts.get(tid);
      if (!entry) {
        entry = { taxon: t, count: 0, items: [] };
        taxonCounts.set(tid, entry);
      }
      entry.count++;
      entry.items.push(obs);
    }

    // Сортировка таксонов: по числу находок, при равенстве — по id (для детерминизма)
    const sortedTaxa = Array.from(taxonCounts.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (b.taxon?.id || 0) - (a.taxon?.id || 0);
    });
    const dominant = sortedTaxa[0];

    // Выбираем ведущее наблюдение (с фото и Research Grade в приоритете)
    let primaryObs = dominant.items[0];
    for (const o of dominant.items) {
      if (o.photos && o.photos.length > 0) {
        primaryObs = o;
        if (o.quality_grade === 'research') break;
      }
    }

    const photos = [];
    const seenPhotos = new Set();
    for (const o of items) {
      if (o.photos && o.photos.length > 0) {
        for (const p of o.photos) {
          const u = p.url || '';
          if (u && !seenPhotos.has(u)) {
            seenPhotos.add(u);
            photos.push(u);
            if (photos.length >= 3) break;
          }
        }
      }
      if (photos.length >= 3) break;
    }

    const otherTaxa = sortedTaxa.slice(1);

    // СТАБИЛЬНЫЙ ID: привязан к ведущему наблюдению (не меняется от соседей)
    const clusterId = items.length === 1
      ? String(items[0].id)
      : 'cl_' + primaryObs.id;

    // СТАБИЛЬНЫЕ КООРДИНАТЫ: фиксируются на ведущем объекте, маркер не прыгает
    return {
      id: clusterId,
      lat: primaryObs._lat,
      lng: primaryObs._lng,
      items,
      count: items.length,
      isSingle: items.length === 1,
      primaryObs,
      dominantTaxon: dominant.taxon,
      dominantCount: dominant.count,
      sortedTaxa,
      otherTaxa,
      photos
    };
  }

  function clusterVisibleObservations(visibleObs, zoom, mode) {
    if (!visibleObs.length) return [];
    const radius = getClusterRadiusPx(zoom, mode);
    const radiusSq = radius * radius;

    // Быстрый отбор по качеству без тяжелых аллокаций
    const sortedObs = [...visibleObs].sort((a, b) => {
      const scoreA = (a.quality_grade === 'research' ? 4 : 0) + (a.photos?.length ? 2 : 0);
      const scoreB = (b.quality_grade === 'research' ? 4 : 0) + (b.photos?.length ? 2 : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.id - a.id;
    });

    const len = sortedObs.length;
    // Предрассчитываем пиксели один раз плоским типизированным массивом для ускорения CPU
    const ptsX = new Float64Array(len);
    const ptsY = new Float64Array(len);
    const clustered = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      const pt = map.latLngToContainerPoint([sortedObs[i]._lat, sortedObs[i]._lng]);
      ptsX[i] = pt.x;
      ptsY[i] = pt.y;
    }

    const clusters = [];
    for (let i = 0; i < len; i++) {
      if (clustered[i]) continue;
      clustered[i] = 1;

      const clusterItems = [sortedObs[i]];
      const p1x = ptsX[i];
      const p1y = ptsY[i];
      const t1Id = sortedObs[i].taxon?.id;

      for (let j = i + 1; j < len; j++) {
        if (clustered[j]) continue;

        const dx = p1x - ptsX[j];
        const dy = (p1y - ptsY[j]) * 1.15;
        let dSq = dx * dx + dy * dy;

        // Если один вид — объединяем охотнее
        if (t1Id && sortedObs[j].taxon?.id === t1Id) {
          dSq *= 0.82;
        }

        if (dSq <= radiusSq) {
          clustered[j] = 1;
          clusterItems.push(sortedObs[j]);
        }
      }

      clusters.push(createClusterData(clusterItems));
    }
    return clusters;
  }

  function buildClusterMarkerIcon(cluster, mode) {
    const isSingle = cluster.isSingle;
    const obs = cluster.primaryObs;
    const taxon = obs.taxon || {};
    const meta = getTaxonMeta(taxon);
    const icon = meta.icon;
    const color = meta.color;
    const isResearch = cluster.items.some(o => o.quality_grade === 'research');

    if (mode === 'bubble') {
      const displayMode = config.badgeDisplayMode || 'full';
      const isManualExpanded = manualExpandedClusters.has(cluster.id);
      const isCollapsed = (displayMode === 'manual' && !isManualExpanded) ||
                          (displayMode === 'auto-hide') ||
                          (displayMode === 'center-bubble');

      const arrowBtnHtml = `<button type="button" class="wm-inat-toggle-arrow-btn" title="${isManualExpanded ? 'Свернуть' : 'Развернуть'}">${isManualExpanded ? '‹' : '›'}</button>`;

      if (isSingle) {
        const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
        const latinName = taxon.name || '';
        const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
        const html = `
          <div class="wm-inat-pin-anchor" data-id="${cluster.id}" style="--inat-color: ${color};">
            <div class="wm-inat-bubble ${isResearch ? 'research' : ''}">
              <div class="wm-inat-badge-card ${isCollapsed ? 'is-collapsed' : 'is-expanded'}">
                <div class="wm-inat-thumb-wrap">
                  ${photoUrl ? `<img src="${photoUrl}" class="wm-inat-img" alt="" loading="lazy">` : `<span class="wm-inat-badge-icon">${icon}</span>`}
                  ${photoUrl ? `<span class="wm-inat-corner-emoji" title="${meta.name}">${icon}</span>` : ''}
                </div>
                <div class="wm-inat-badge-texts">
                  <span class="wm-inat-badge-ru">${escapeHtml(ruName)}</span>
                  <span class="wm-inat-badge-la">${escapeHtml(latinName)}</span>
                </div>
                ${displayMode !== 'full' ? arrowBtnHtml : ''}
              </div>
              <svg class="wm-inat-badge-tail" width="12" height="7" viewBox="0 0 12 7"><path d="M 0 0 L 6 7 L 12 0 Z" /></svg>
            </div>
            <div class="wm-inat-target-dot"></div>
          </div>`;
        return L.divIcon({ className: 'wm-inat-div-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] });
      }

      // Кластерная общая плашка
      const primaryName = cluster.dominantTaxon?.preferred_common_name || cluster.dominantTaxon?.name || obs.species_guess || meta.name;
      const latinName = cluster.dominantTaxon?.name || '';
      const sameSpeciesAll = cluster.sortedTaxa.length === 1;

      let subText = '';
      if (sameSpeciesAll) {
        subText = `${latinName ? latinName + ' · ' : ''}${cluster.count} находок`;
      } else {
        const otherNames = cluster.otherTaxa
          .map(t => t.taxon?.preferred_common_name || t.taxon?.name)
          .filter(Boolean);
        const remainingCount = cluster.count - cluster.dominantCount;
        if (otherNames.length <= 2) {
          subText = `+ ${otherNames.join(', ')} (${remainingCount})`;
        } else {
          subText = `+ ${otherNames[0]}, ${otherNames[1]} (+${remainingCount - 2})`;
        }
      }

      const photos = cluster.photos || [];
      let fanHtml = '';
      if (photos.length >= 3) {
        fanHtml = `
          <div class="wm-inat-fan-stack fan-3">
            <img src="${photos[2]}" class="wm-inat-fan-photo fan-3-left" alt="" loading="lazy">
            <img src="${photos[1]}" class="wm-inat-fan-photo fan-3-right" alt="" loading="lazy">
            <img src="${photos[0]}" class="wm-inat-fan-photo fan-3-center" alt="" loading="lazy">
          </div>`;
      } else if (photos.length === 2) {
        fanHtml = `
          <div class="wm-inat-fan-stack fan-2">
            <img src="${photos[1]}" class="wm-inat-fan-photo fan-2-back" alt="" loading="lazy">
            <img src="${photos[0]}" class="wm-inat-fan-photo fan-2-front" alt="" loading="lazy">
          </div>`;
      } else if (photos.length === 1) {
        fanHtml = `
          <div class="wm-inat-thumb-wrap">
            <img src="${photos[0]}" class="wm-inat-img" alt="" loading="lazy">
          </div>`;
      } else {
        fanHtml = `
          <div class="wm-inat-thumb-wrap">
            <span class="wm-inat-badge-icon">${icon}</span>
          </div>`;
      }

      const html = `
        <div class="wm-inat-pin-anchor is-cluster" data-id="${cluster.id}" style="--inat-color: ${color};">
          <div class="wm-inat-bubble ${isResearch ? 'research' : ''} is-cluster">
            <div class="wm-inat-badge-card wm-inat-cluster-card ${isCollapsed ? 'is-collapsed' : 'is-expanded'}">
              <div class="wm-inat-fan-wrapper">
                ${fanHtml}
                <span class="wm-inat-corner-emoji" title="${meta.name}">${icon}</span>
              </div>
              <div class="wm-inat-badge-texts">
                <div class="wm-inat-badge-ru-row">
                  <span class="wm-inat-badge-ru">${escapeHtml(primaryName)}</span>
                  ${sameSpeciesAll ? '' : `<span class="wm-inat-cluster-species-count">×${cluster.dominantCount}</span>`}
                </div>
                <span class="wm-inat-badge-cluster-sub">${escapeHtml(subText)}</span>
              </div>
              <div class="wm-inat-cluster-count-pill" title="${cluster.count} находок в этой зоне">${cluster.count}</div>
              ${displayMode !== 'full' ? arrowBtnHtml : ''}
            </div>
            <svg class="wm-inat-badge-tail" width="12" height="7" viewBox="0 0 12 7"><path d="M 0 0 L 6 7 L 12 0 Z" /></svg>
          </div>
          <div class="wm-inat-target-dot is-cluster"></div>
        </div>`;
      return L.divIcon({ className: 'wm-inat-div-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] });
    }

    // Компактный режим
    if (isSingle) {
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const html = `
        <div class="wm-inat-pin-compact" data-id="${cluster.id}" title="${escapeHtml(ruName)} (${meta.name})" style="--inat-color: ${color};">
          <span class="wm-inat-compact-dot">${icon}</span>
        </div>`;
      return L.divIcon({ className: 'wm-inat-div-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] });
    }

    const primaryName = cluster.dominantTaxon?.preferred_common_name || cluster.dominantTaxon?.name || meta.name;
    const html = `
      <div class="wm-inat-pin-compact is-cluster" data-id="${cluster.id}" title="${escapeHtml(primaryName)} (${cluster.count} находок)" style="--inat-color: ${color};">
        <span class="wm-inat-compact-dot">${icon}</span>
        <span class="wm-inat-compact-cluster-badge">${cluster.count}</span>
      </div>`;
    return L.divIcon({ className: 'wm-inat-div-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }



  function createClusterMarker(cluster, mode) {
    const marker = L.marker([cluster.lat, cluster.lng], {
      icon: buildClusterMarkerIcon(cluster, mode),
      zIndexOffset: 850
    });

    const toggleCollapseState = (forceExpand) => {
      const card = marker._cardEl;
      const arrowBtn = marker._arrowBtn;
      if (!card) return;

      const shouldExpand = forceExpand !== undefined ? forceExpand : card.classList.contains('is-collapsed');
      card.classList.toggle('is-collapsed', !shouldExpand);
      card.classList.toggle('is-expanded', shouldExpand);
      if (arrowBtn) {
        arrowBtn.textContent = shouldExpand ? '‹' : '›';
        arrowBtn.title = shouldExpand ? 'Свернуть' : 'Развернуть';
      }
      if (config.badgeDisplayMode === 'manual') {
        if (shouldExpand) manualExpandedClusters.add(cluster.id);
        else manualExpandedClusters.delete(cluster.id);
      }
    };

    const handler = (e) => {
      if (map && map.dragging && map.dragging.moving()) return;

      if (e && e.target && e.target.closest('.wm-inat-toggle-arrow-btn')) {
        L.DomEvent.stopPropagation(e);
        if (e.preventDefault) e.preventDefault();
        toggleCollapseState();
        return;
      }

      const selMode = config.selectMode || 'crosshair';
      if (selMode === 'crosshair' && (!hoveredCluster || hoveredCluster.id !== cluster.id)) {
        return;
      }

      if (e) {
        L.DomEvent.stopPropagation(e);
        if (e.preventDefault) e.preventDefault();
      }

      const now = Date.now();
      if (marker._lastClick && now - marker._lastClick < 350) return;
      marker._lastClick = now;

      if (cluster.isSingle) {
        openObservationCard(cluster.primaryObs);
      } else {
        highlightObservationZone(cluster.primaryObs);
        openClusterModal(cluster.items);
      }
    };

    marker._wmBind = () => {
      const el = marker.getElement();
      if (el) {
        el.style.pointerEvents = 'auto';
        // Кэшируем внутренние ноды прямо на маркере, чтобы избежать повторных querySelector
        marker._rootEl = el;
        marker._cardEl = el.querySelector('.wm-inat-badge-card');
        marker._bubbleEl = el.querySelector('.wm-inat-bubble');
        marker._arrowBtn = el.querySelector('.wm-inat-toggle-arrow-btn');

        el.onclick = handler;

        // Легкий hover для десктопа
        el.onmouseenter = () => {
          highlightObservationZone(cluster.primaryObs);
          el.classList.add('inat-crosshair-hovered');
          if (config.badgeDisplayMode === 'auto-hide') toggleCollapseState(true);
        };
        el.onmouseleave = () => {
          if (!hoveredCluster || hoveredCluster.id !== cluster.id) {
            clearHoverHighlight();
          }
          if (config.badgeDisplayMode === 'auto-hide' && (!hoveredCluster || hoveredCluster.id !== cluster.id)) {
            toggleCollapseState(false);
          }
        };
      }
    };

    marker.addTo(layer);
    marker._wmMode = mode;
    marker._wmDisplayMode = config.badgeDisplayMode || 'full'; // <-- ДОБАВИТЬ ЭТУ СТРОКУ
    marker._wmCount = cluster.count;
    marker._wmCluster = cluster;
    marker._wmBind();
    markerInstances.set(cluster.id, marker);
  }
  function buildTileLayerUrl(mode) {
    const p = new URLSearchParams();
    const f = activeMapFilter;
    if (f) {
      if (f.taxonId) p.set('taxon_id', String(f.taxonId));
      else if (f.query) p.set('q', f.query);
    }
    if (config.taxa && config.taxa !== 'all' && !(f && f.taxonId)) {
      p.set('iconic_taxa', config.taxa);
    }
    if (config.quality && config.quality !== 'any') p.set('quality_grade', config.quality);
    if (config.wildOnly) p.set('captive', 'false');
    if (config.photosOnly) p.set('photos', 'true');
    if (config.nativeOnly) p.set('native', 'true');
    if (config.threatenedOnly) p.set('threatened', 'true');
    applyControlledTermFilter(p);
    if (config.month && config.month !== 'any') {
      params.set('month', config.month);
    } else if (config.season && config.season !== 'any' && config.season !== 'current') {
      // Для обычных сезонов (весна/лето/зима/осень) оставляем календарные месяцы
      const m = getMonthsForSeason(config.season);
      if (m) params.set('month', m);
    }
    const qStr = p.toString();
    return `https://api.inaturalist.org/v2/${mode}/{z}/{x}/{y}.png${qStr ? '?' + qStr : ''}`;
  }

  function clearOverviewTileLayer() {
    if (overviewTileLayer && map) {
      map.removeLayer(overviewTileLayer);
      overviewTileLayer = null;
    }
  }

  function updateOverviewTileLayer() {
    // Если модуль выключен ИЛИ отображается ареал Geomodel/Range — полностью скрываем фоновую сетку/теплокарту
    if (!map || !config.enabled || activeGeomodelTaxon) {
      clearOverviewTileLayer();
      return;
    }

    const mode = config.zoomOutMode || 'markers';
    const isZoomedOut = map.getZoom() < minZoomNow();

    // Если выбран стандартный режим или зум достаточен для интерактивных точек — убираем растровые тайлы
    if (mode === 'markers' || !isZoomedOut) {
      clearOverviewTileLayer();
      return;
    }

    const tileUrl = buildTileLayerUrl(mode);

    if (overviewTileLayer) {
      if (overviewTileLayer._currentMode !== mode) {
        clearOverviewTileLayer();
      } else {
        overviewTileLayer.setUrl(tileUrl);
        if (!map.hasLayer(overviewTileLayer)) {
          overviewTileLayer.addTo(map);
        }
        return;
      }
    }

    overviewTileLayer = L.tileLayer(tileUrl, {
      maxZoom: 20,
      pane: 'wm-inaturalist',
      opacity: 0.82,
      className: 'wm-inat-overview-tile',
      attribution: '© iNaturalist'
    });
    overviewTileLayer._currentMode = mode;
    overviewTileLayer.addTo(map);
  }


  function renderVisible() {
    if (!map || !layer) return;
    if (!config.enabled || map.getZoom() < minZoomNow()) {
      clearAllMarkers();
      updateOverviewTileLayer();
      updateTopBadge();
      return;
    }

    updateOverviewTileLayer();

    const zoom = map.getZoom();
    currentRenderZoom = zoom;
    const mode = zoom >= 13 ? 'bubble' : 'compact';
    
    // Берём чуть больший буфер видимости (0.28 вместо 0.15),
    // чтобы при небольших сдвигах точки на границах экрана не распадались
    // В renderVisible() заменяем цикл отбора:
    const view = map.getBounds().pad(0.28);
    const currentMonthNum = new Date().getMonth() + 1;

    let visible = [];
    for (const obs of obsCache.values()) {
      if (view.contains([obs._lat, obs._lng])) {
        visible.push(obs);
      }
    }

    // Если включен режим сезонности "Сейчас" — оставляем только виды из Топ-5
    if (config.season === 'current' && (!config.month || config.month === 'any')) {
      visible = visible.filter(obs => {
        // 1. Если само наблюдение было сделано в текущем месяце — гарантированно показываем
        const obsDateStr = obs.observed_on || obs.time_observed_at;
        if (obsDateStr) {
          const obsMonth = new Date(obsDateStr).getMonth() + 1;
          if (obsMonth === currentMonthNum) return true;
        }

        const tid = obs.taxon?.id;
        if (!tid) return true;

        // 2. Если гистограмма УЖЕ есть в кэше — проверяем попадание в топ-5
        if (histogramCache.has(tid)) {
          const moy = histogramCache.get(tid);
          if (!moy || moy._failed || Object.keys(moy).length === 0) return true;
          const top5 = Object.entries(moy)
            .filter(([k]) => !k.startsWith('_'))
            .map(([m, c]) => ({ m: Number(m), c: Number(c) || 0 }))
            .sort((a, b) => b.c - a.c)
            .slice(0, 5)
            .map(x => x.m);
          return top5.includes(currentMonthNum);
        }

        // 3. Если кэша нет — НЕ спамим сеть пачками запросов на каждый чих! Оставляем точку на экране
        return true;
      });
    }
    const baseLimit = config.limit || 100;
    const cap = activeMapFilter ? Math.max(120, baseLimit) : Math.max(10, baseLimit);



    // Кластеризуем сначала ВСЕ точки в видимой зоне
    let clusters = clusterVisibleObservations(visible, zoom, mode);

    // Если кластеров получилось больше лимита экрана — ограничиваем уже ГОТОВЫЕ кластеры
    // (в приоритете те, где больше находок или выше статус)
    if (clusters.length > cap) {
      clusters.sort((a, b) => b.count - a.count);
      clusters = clusters.slice(0, cap);
    }

    const keep = new Set(clusters.map(c => c.id));
    for (const [id, m] of markerInstances) {
      if (!keep.has(id)) {
        m.off();
        layer.removeLayer(m);
        markerInstances.delete(id);
      }
    }

    activeObservations.clear();
    const allItemsList = [];
    for (const cluster of clusters) {
      for (const o of cluster.items) {
        activeObservations.set(o.id, o);
        allItemsList.push(o);
      }

      const m = markerInstances.get(cluster.id);
      if (!m) {
        createClusterMarker(cluster, mode);
      } else {
        // Если маркер уже был — плавно обновляем положение и иконку без пересоздания
        if (m.getLatLng().lat !== cluster.lat || m.getLatLng().lng !== cluster.lng) {
          m.setLatLng([cluster.lat, cluster.lng]);
        }
        const curDisplayMode = config.badgeDisplayMode || 'full';
        if (m._wmMode !== mode || m._wmCount !== cluster.count || m._wmDisplayMode !== curDisplayMode) {
          m.setIcon(buildClusterMarkerIcon(cluster, mode));
          m._wmMode = mode;
          m._wmDisplayMode = curDisplayMode;
          m._wmCount = cluster.count;
          m._wmCluster = cluster;
          m._wmBind();
        }
      }
    }

    if (activeMapFilter) activeMapFilter.results = allItemsList;
    if (hoveredObsId != null && !activeObservations.has(hoveredObsId)) clearHoverHighlight();
    updateTopBadge();
    checkCrosshairProximity();
  }

  function highlightObservationZone(obs) {
    if (hoveredObsId === obs.id && hoverZoneLayer && map && map.hasLayer(hoverZoneLayer)) return;
    hoveredObsId = obs.id;
    clearHoverHighlight(true);

    if (!map || obs._lat == null || obs._lng == null) return;
    const meta = getTaxonMeta(obs.taxon);
    const radius = Math.max(12, Math.min(2500, Math.round(obs.positional_accuracy || 25)));

    hoverZoneLayer = L.circle([obs._lat, obs._lng], {
      pane: 'wm-inaturalist', // <-- гарантия видимости над полигонами и растром
      radius,
      color: meta.color,
      weight: 2.5,
      fillColor: meta.color,
      fillOpacity: 0.24,
      dashArray: '6, 6',
      interactive: false,
      className: 'wm-inat-hover-zone'
    }).addTo(map);

    for (const [id, marker] of markerInstances) {
      if (marker._wmCluster && marker._wmCluster.items.some(o => o.id === obs.id)) {
        const el = marker.getElement();
        if (el) el.classList.add('inat-crosshair-hovered');
        break;
      }
    }
  }

  function checkCrosshairProximity() {
    if (!config.enabled || !map || activeObservations.size === 0) {
      hoveredCluster = null;
      clearHoverHighlight();
      return;
    }

    const displayMode = config.badgeDisplayMode || 'full';
    const center = map.getCenter();
    const centerPt = map.latLngToContainerPoint(center);
    const mapSize = map.getSize();
    const bubbleRadius = Math.min(mapSize.x, mapSize.y) * 0.38;

    // Быстрый фильтр по градусам: ~0.05 градуса вокруг центра
    const degBound = 360 / (256 * Math.pow(2, map.getZoom())) * (bubbleRadius * 1.2);

    let bestCluster = null;
    let minDistancePx = Infinity;

    for (const marker of markerInstances.values()) {
      const cluster = marker._wmCluster;
      if (!cluster) continue;

      // Быстрый отсев точек далеко за пределами радиуса без тригонометрии
      if (Math.abs(cluster.lat - center.lat) > degBound || Math.abs(cluster.lng - center.lng) > degBound) {
        // Если маркер был раскрыт через линзу, плавно сбрасываем
        if (displayMode === 'center-bubble' && marker._cardEl && !marker._cardEl.classList.contains('is-collapsed')) {
          marker._cardEl.classList.add('is-collapsed');
          marker._cardEl.style.removeProperty('--lens-progress');
          if (marker._bubbleEl) {
            marker._bubbleEl.style.transform = '';
            marker._bubbleEl.style.zIndex = '';
          }
        }
        continue;
      }

      const pt = map.latLngToContainerPoint([cluster.lat, cluster.lng]);
      const isBubble = marker._wmMode === 'bubble';
      
      let d;
      if (isBubble) {
        const dx = Math.abs(centerPt.x - pt.x);
        const dy = Math.abs(centerPt.y - (pt.y - 20));
        d = Math.hypot(dx * 0.7, dy * 1.2);
      } else {
        d = centerPt.distanceTo(pt);
      }

      // Линза по центру (без querySelector, используем закэшированные ноды)
      if (displayMode === 'center-bubble' && isBubble) {
        const card = marker._cardEl;
        const bubbleContainer = marker._bubbleEl;
        
        if (card && bubbleContainer) {
          const distToCenter = centerPt.distanceTo(pt);
          if (distToCenter <= bubbleRadius) {
            const factor = Math.max(0, Math.min(1, 1 - (distToCenter / bubbleRadius)));
            const easedProgress = Math.pow(factor, 0.85);

            card.classList.remove('is-collapsed');
            card.style.setProperty('--lens-progress', easedProgress.toFixed(2));
            const scale = (1.0 + factor * 0.14).toFixed(2);
            bubbleContainer.style.transform = `translate3d(-50%, 0, 0) scale(${scale})`;
            bubbleContainer.style.zIndex = Math.round(500 + factor * 500);
          } else if (!card.classList.contains('is-collapsed')) {
            card.classList.add('is-collapsed');
            card.style.removeProperty('--lens-progress');
            bubbleContainer.style.transform = '';
            bubbleContainer.style.zIndex = '';
          }
        }
      }

      const threshold = isBubble ? 46 : 34;
      if (d < threshold && d < minDistancePx) {
        minDistancePx = d;
        bestCluster = cluster;
      }
    }

    const prevHoveredCluster = hoveredCluster;

    if (bestCluster) {
      hoveredCluster = bestCluster;
      hoveredObsId = bestCluster.primaryObs.id;
      highlightObservationZone(bestCluster.primaryObs);

      if (displayMode === 'auto-hide') {
        const marker = markerInstances.get(bestCluster.id);
        if (marker && marker._cardEl) {
          marker._cardEl.classList.remove('is-collapsed');
          marker._cardEl.classList.add('is-expanded');
        }
      }

      if (WM.picker && WM.picker.getMode() === 'cross' && WM.ui && WM.ui.setPill) {
        const taxon = bestCluster.dominantTaxon || bestCluster.primaryObs.taxon || {};
        const meta = getTaxonMeta(taxon);
        const ruName = taxon.preferred_common_name || bestCluster.primaryObs.species_guess || taxon.name || meta.name;
        const subtitle = bestCluster.isSingle
          ? `${meta.icon} ${meta.name} (iNaturalist)`
          : `🌿 ${bestCluster.count} находок в этой точке`;
        
        WM.ui.setPill({
          title: `${meta.icon} ${ruName}`,
          isInat: true
        }, bestCluster.count, subtitle);
      }
    } else {
      hoveredCluster = null;
      clearHoverHighlight();
      const p = document.getElementById('hover-pill');
      if (p && p.dataset.source === 'inat') {
        p.hidden = true;
        delete p.dataset.source;
      }
    }

    if (displayMode === 'auto-hide' && prevHoveredCluster && (!bestCluster || bestCluster.id !== prevHoveredCluster.id)) {
      const prevMarker = markerInstances.get(prevHoveredCluster.id);
      if (prevMarker && prevMarker._cardEl && prevMarker._rootEl && !prevMarker._rootEl.matches(':hover')) {
        prevMarker._cardEl.classList.add('is-collapsed');
        prevMarker._cardEl.classList.remove('is-expanded');
      }
    }
  }

  function updateTopBadge(isLoadingNow = false) {
    const badge = document.getElementById('inat-count-badge');
    const badgeText = document.getElementById('inat-count-badge-text');
    const badgeRefresh = document.getElementById('inat-count-badge-refresh');
    const badgeClear = document.getElementById('inat-count-badge-clear');
    if (!badge || !badgeText) return;

    if (!config.enabled || config.showBadge === false) {
      badge.hidden = true;
      return;
    }

    badge.hidden = false;

    if (activeMapFilter) {
      if (isLoadingNow) {
        badgeText.textContent = `🌿 Поиск «${activeMapFilter.query}»…`;
      } else {
        badgeText.textContent = `🌿 «${activeMapFilter.query}» (${activeMapFilter.results.length})  ›`;
      }
      badge.title = `Нажмите для списка «${activeMapFilter.query}»`;
      if (badgeRefresh) badgeRefresh.hidden = false;
      if (badgeClear) badgeClear.hidden = false;
      badge.classList.add('filtered');
    } else {
      let icon = '🌿';
      let label = 'Растения';
      if (config.taxa === 'Fungi') { icon = '🍄'; label = 'Грибы'; }
      else if (config.taxa === 'Aves') { icon = '🦅'; label = 'Птицы'; }
      else if (config.taxa === 'Insecta') { icon = '🐞'; label = 'Насекомые'; }
      else if (config.taxa && config.taxa.includes('Fungi')) { icon = '🌿/🍄'; label = 'Флора/Грибы'; }
      else if (config.taxa === 'all') { icon = '🐾'; label = 'Организмы'; }

      if (map && map.getZoom() < MIN_VIEW_ZOOM) {
        if (config.zoomOutMode && config.zoomOutMode !== 'markers') {
          const modeTitles = {
            heatmap: 'Тепловая карта',
            points: 'Точки плотности',
            grid: 'Сетка плотности'
          };
          const title = modeTitles[config.zoomOutMode] || 'Обзор';
          badgeText.textContent = `${icon} ${label}: ${title} (зум < ${MIN_VIEW_ZOOM})  ›`;
        } else {
          badgeText.textContent = `${icon} Приблизьте карту (зум ${MIN_VIEW_ZOOM}+)  ›`;
        }
        if (badgeRefresh) badgeRefresh.hidden = true;
        if (badgeClear) badgeClear.hidden = !activeMapFilter;
        badge.classList.toggle('filtered', !!activeMapFilter);
        return;
      }

      if (isLoadingNow) {
        badgeText.textContent = `${icon} ${label}: загрузка (v2)…`;
      } else {
        badgeText.textContent = `${icon} ${label}: ${activeObservations.size}  ›`;
      }
      badge.title = 'Нажмите для открытия списка наблюдений на экране';
      if (badgeRefresh) badgeRefresh.hidden = true;
      if (badgeClear) badgeClear.hidden = true;
      badge.classList.remove('filtered');
    }
  }

  function openClusterModal(clusterList) {
    let modal = document.getElementById('modal-inat-cluster');
    let listEl = document.getElementById('inat-cluster-items-list');
    let titleEl = document.getElementById('inat-cluster-title');
    let closeX = document.getElementById('inat-cluster-close-x');
    let cancelBtn = document.getElementById('inat-cluster-cancel-btn');

    if (!modal || !listEl) return;
    if (titleEl) titleEl.textContent = `🌿 Наблюдения в этой точке (${clusterList.length})`;

    listEl.innerHTML = '';
    clusterList.forEach((obs) => {
      const taxon = obs.taxon || {};
      const meta = getTaxonMeta(taxon);
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
      const isResearch = obs.quality_grade === 'research';
      const dateStr = obs.observed_on || (obs.created_at ? obs.created_at.slice(0, 10) : '');

      const card = document.createElement('div');
      card.className = 'inat-cluster-item-card';
      card.style.borderLeftColor = meta.color;
      card.innerHTML = `
        <div class="inat-cluster-item-thumb-wrap">
          ${photoUrl ? `<img src="${photoUrl}" class="inat-cluster-item-thumb" alt="">` : `<span class="inat-cluster-item-icon">${meta.icon}</span>`}
        </div>
        <div class="inat-cluster-item-info">
          <div class="inat-cluster-item-top">
            <span class="inat-cluster-item-ru">${escapeHtml(ruName)}</span>
            ${isResearch ? '<span class="inat-cluster-item-badge rg" title="Research Grade">✓ RG</span>' : ''}
          </div>
          <span class="inat-cluster-item-la">${escapeHtml(latinName)} · ${meta.name}</span>
          ${dateStr ? `<span class="inat-cluster-item-date">📅 ${dateStr}</span>` : ''}
        </div>
        <span class="inat-cluster-item-arrow">›</span>
      `;

      card.onclick = (e) => {
        if (e) {
          e.stopPropagation();
          if (e.preventDefault) e.preventDefault();
        }
        // Передаем false, чтобы не вызывать history.back()
        closeClusterModal(false);

        // Безопасно заменяем состояние в истории на карточку деталей
        if (!window.Capacitor && window.history && history.replaceState) {
          history.replaceState({ wmView: 'inatDetails' }, '');
        }

        highlightObservationZone(obs);
        openObservationCard(obs);
      };
      listEl.appendChild(card);
    });

    const closeHandler = () => closeClusterModal();
    if (closeX) closeX.onclick = closeHandler;
    if (cancelBtn) cancelBtn.onclick = closeHandler;
    modal.onclick = (e) => { if (e.target === modal) closeClusterModal(); };
    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('inatCluster');
  }

  function closeClusterModal(syncHistory = true) {
    const modal = document.getElementById('modal-inat-cluster');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('inatCluster');
    }
    renderVisible();
  }

  // =========================================================================
  // РАСПОЗНАВАНИЕ ВИДОВ ПО ФОТО (COMPUTER VISION)
  // =========================================================================
  const VISION_RATE_LIMIT = 3;
  const VISION_RATE_WINDOW_MS = 60000;
  let visionTimestamps = [];
  let visionCooldownTimer = null;
  let isVisionLoading = false;

  function checkVisionRateLimit() {
    const now = Date.now();
    visionTimestamps = visionTimestamps.filter(t => now - t < VISION_RATE_WINDOW_MS);
    if (visionTimestamps.length >= VISION_RATE_LIMIT) {
      const waitSec = Math.ceil((visionTimestamps[0] + VISION_RATE_WINDOW_MS - now) / 1000);
      return { allowed: false, waitSec };
    }
    return { allowed: true, remaining: VISION_RATE_LIMIT - visionTimestamps.length };
  }

  function updateVisionLimitUI() {
    const badge = document.getElementById('inat-vision-limit-badge');
    const btnPick = document.getElementById('btn-inat-vision-pick');
    if (!badge) return;

    const limitStatus = checkVisionRateLimit();
    if (!limitStatus.allowed) {
      badge.textContent = `⏳ ${limitStatus.waitSec} с`;
      badge.classList.add('limit-reached');
      if (btnPick && !isVisionLoading) btnPick.disabled = true;
      if (!visionCooldownTimer) {
        visionCooldownTimer = setInterval(() => {
          const check = checkVisionRateLimit();
          if (!check.allowed) {
            badge.textContent = `⏳ ${check.waitSec} с`;
          } else {
            clearInterval(visionCooldownTimer);
            visionCooldownTimer = null;
            updateVisionLimitUI();
          }
        }, 1000);
      }
    } else {
      badge.textContent = `${limitStatus.remaining} / ${VISION_RATE_LIMIT}`;
      badge.classList.remove('limit-reached');
      if (btnPick && !isVisionLoading) btnPick.disabled = false;
    }
  }

  function resizeImageForVision(file, maxDimension = 1200) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.88);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  async function scoreObservationImage(blob) {
    const formData = new FormData();
    formData.append('image', blob, 'observation.jpg');

    const coords = (WM.gpsState && WM.gpsState.lat) ? WM.gpsState : (map ? map.getCenter() : null);
    if (coords && coords.lat != null && coords.lng != null) {
      formData.append('lat', coords.lat.toFixed(5));
      formData.append('lng', coords.lng.toFixed(5));
    }

    const headers = { 'Accept': 'application/json' };
    const userKey = getToken();
    if (userKey) headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;

    const res = await fetch('https://api.inaturalist.org/v1/computervision/score_image', {
      method: 'POST',
      headers,
      body: formData
    });
    if (res.status === 429) throw new Error('Превышен лимит запросов iNaturalist.');
    if (!res.ok) throw new Error(`Ошибка сервера (${res.status})`);
    return await res.json();
  }

  function renderVisionResults(data) {
    const wrap = document.getElementById('inat-vision-results');
    const listEl = document.getElementById('inat-vision-results-list');
    const ancestorBanner = document.getElementById('inat-vision-ancestor-banner');
    if (!wrap || !listEl) return;

    listEl.innerHTML = '';
    wrap.hidden = false;

    if (data.common_ancestor && data.common_ancestor.taxon) {
      const anc = data.common_ancestor.taxon;
      const ancRank = RANKS_RU[anc.rank] || anc.rank || 'род';
      const ancName = anc.preferred_common_name ? `${anc.preferred_common_name} (${anc.name})` : anc.name;
      ancestorBanner.innerHTML = `🧬 Высокая вероятность: <b>${escapeHtml(ancName)}</b> [${escapeHtml(ancRank)}]`;
      ancestorBanner.hidden = false;
    } else {
      ancestorBanner.hidden = true;
    }

    const results = data.results || [];
    if (!results.length) {
      listEl.innerHTML = '<div class="muted" style="padding: 10px 0;">Вид не распознан. Сделайте более чёткий снимок листа или цветка крупным планом.</div>';
      return;
    }

    results.slice(0, 5).forEach((item, idx) => {
      const taxon = item.taxon || {};
      const meta = getTaxonMeta(taxon);
      const ruName = taxon.preferred_common_name || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const photoUrl = taxon.default_photo?.square_url || '';
      const score = item.combined_score || item.vision_score || 0;
      const scorePct = Math.round(score);
      const isTop = idx === 0;

      const card = document.createElement('div');
      card.className = `inat-vision-result-card ${isTop ? 'top-match' : ''}`;
      card.style.borderLeftColor = meta.color;
      card.innerHTML = `
        ${photoUrl ? `<img src="${photoUrl}" class="inat-vision-thumb" alt="">` : `<span class="inat-vision-icon-ph">${meta.icon}</span>`}
        <div class="inat-vision-meta">
          <div class="inat-vision-title-line">
            <span class="inat-vision-ru">${escapeHtml(ruName)}</span>
            <span class="inat-vision-score ${isTop ? 'high' : ''}">${scorePct}%</span>
          </div>
          <span class="inat-vision-la">${escapeHtml(latinName)} · ${meta.name}</span>
          <div class="inat-vision-item-actions">
            <button type="button" class="inat-vision-act-btn btn-show-map">👁️ На карте</button>
            <button type="button" class="inat-vision-act-btn btn-show-geomodel" title="Включить тепловую карту ареала Geomodel AI">🧠 Ареал</button>
            <button type="button" class="inat-vision-act-btn btn-copy-name" title="Скопировать">📋</button>
            <a href="https://www.inaturalist.org/taxa/${taxon.id}" target="_blank" rel="noopener noreferrer" class="inat-vision-act-btn">↗ iNat</a>
          </div>
        </div>
      `;

      card.querySelector('.btn-show-map')?.addEventListener('click', (e) => {
        e.stopPropagation();
        applyFilterToMap(ruName, taxon);
      });

      card.querySelector('.btn-show-geomodel')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showGeomodelForTaxon(taxon);
        document.getElementById('modal')?.classList.remove('open');
      });

      card.querySelector('.btn-copy-name')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const copyText = (latinName && latinName !== ruName) ? `${ruName} (${latinName})` : ruName;
        navigator.clipboard.writeText(copyText).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📋 Скопировано: ${copyText}`);
        });
      });

      listEl.appendChild(card);
    });
  }

  function handleVisionFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Пожалуйста, выберите файл изображения');
      return;
    }

    const tokenInfo = getTokenInfo();
    if (!tokenInfo.exists || tokenInfo.isExpired) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Токен iNaturalist отсутствует или истёк!', 3000);
      updateVisionTokenNotice();
      return;
    }

    const rateStatus = checkVisionRateLimit();
    if (!rateStatus.allowed) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast(`⏳ Лимит: не более 3 фото в минуту. Подождите ещё ${rateStatus.waitSec} сек.`);
      return;
    }

    const previewWrap = document.getElementById('inat-vision-preview-wrap');
    const previewImg = document.getElementById('inat-vision-preview-img');
    const previewName = document.getElementById('inat-vision-preview-name');
    const statusLine = document.getElementById('inat-vision-status-line');
    const resultsWrap = document.getElementById('inat-vision-results');
    const btnPick = document.getElementById('btn-inat-vision-pick');

    if (resultsWrap) resultsWrap.hidden = true;
    if (previewWrap) previewWrap.hidden = false;
    if (previewName) previewName.textContent = file.name || 'Снимок';
    if (statusLine) statusLine.textContent = '⏳ Оптимизация снимка…';

    const reader = new FileReader();
    reader.onload = (e) => { if (previewImg) previewImg.src = e.target.result; };
    reader.readAsDataURL(file);

    isVisionLoading = true;
    if (btnPick) btnPick.disabled = true;

    resizeImageForVision(file).then(async (optimizedBlob) => {
      if (statusLine) statusLine.textContent = '🧠 Анализ нейросетью iNaturalist…';
      try {
        visionTimestamps.push(Date.now());
        updateVisionLimitUI();
        const data = await scoreObservationImage(optimizedBlob);
        if (statusLine) statusLine.textContent = '✅ Анализ завершён';
        renderVisionResults(data);
      } catch (err) {
        console.warn('[iNaturalist Vision]', err);
        if (statusLine) statusLine.textContent = `❌ ${err.message}`;
      } finally {
        isVisionLoading = false;
        updateVisionLimitUI();
      }
    });
  }

  function initVisionUI() {
    const box = document.getElementById('inat-vision-box');
    const fileInput = document.getElementById('inat-vision-file-input');
    const btnPick = document.getElementById('btn-inat-vision-pick');
    const btnClear = document.getElementById('btn-inat-vision-clear');
    const previewWrap = document.getElementById('inat-vision-preview-wrap');
    const resultsWrap = document.getElementById('inat-vision-results');
    const btnGotoAuth = document.getElementById('btn-inat-vision-goto-auth');


    if (!box || box._inited) return;
    box._inited = true;

    updateVisionLimitUI();
    updateVisionTokenNotice();

    btnGotoAuth?.addEventListener('click', openAndFocusTokenInput);

    btnPick?.addEventListener('click', () => {
      const tokenInfo = getTokenInfo();
      if (!tokenInfo.exists || tokenInfo.isExpired) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Для распознавания по фото необходим действующий токен (24 ч)', 3200);
        const spoilerAuth = document.getElementById('spoiler-inat-auth');
        const inputToken = document.getElementById('inat-token-input');
        if (spoilerAuth) {
          spoilerAuth.open = true;
          spoilerAuth.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setTimeout(() => inputToken?.focus(), 250);
        return;
      }

      const rate = checkVisionRateLimit();
      if (!rate.allowed) {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`⏳ Лимит: не более 3 фото в минуту. Подождите ещё ${rate.waitSec} сек.`);
        return;
      }
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) handleVisionFile(fileInput.files[0]);
    });

    btnClear?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
      if (previewWrap) previewWrap.hidden = true;
      if (resultsWrap) resultsWrap.hidden = true;
    });

    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dragover'); });
    box.addEventListener('dragleave', () => box.classList.remove('dragover'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('dragover');
      if (e.dataTransfer?.files?.[0]) handleVisionFile(e.dataTransfer.files[0]);
    });
  }

  // =========================================================================
  // ГЕОМЕТРИЯ И ЗАГРУЗКА ДАННЫХ
  // =========================================================================
  function toBounds(lb) {
    return {
      s: Math.max(-90, lb.getSouth()), n: Math.min(90, lb.getNorth()),
      w: Math.max(-180, lb.getWest()), e: Math.min(180, lb.getEast())
    };
  }
  function containsBounds(o, i) {
    return i.w >= o.w && i.e <= o.e && i.s >= o.s && i.n <= o.n;
  }
  function pointIn(b, lat, lng) {
    return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
  }

  function needFetch(viewB, force) {
    if (force || !coverage) return true;
    if (Date.now() - coverage.time > COVERAGE_TTL_MS) return true;
    if (!containsBounds(coverage.bounds, viewB)) return true;

    if (coverage.truncated) {
      const cLat = (viewB.s + viewB.n) / 2;
      const cLng = (viewB.w + viewB.e) / 2;

      let visibleCount = 0;
      for (const o of obsCache.values()) {
        if (pointIn(viewB, o._lat, o._lng)) {
          visibleCount++;
          if (visibleCount >= 25) break;
        }
      }
      if (visibleCount < 15) return true;

      const coreCenterLat = (coverage.core.s + coverage.core.n) / 2;
      const coreCenterLng = (coverage.core.w + coverage.core.e) / 2;
      if (Math.abs(cLat - coreCenterLat) > (viewB.n - viewB.s) * 0.25 ||
          Math.abs(cLng - coreCenterLng) > (viewB.e - viewB.w) * 0.25) {
        return true;
      }
    }
    return false;
  }

  function getQueryKey() {
    const f = activeMapFilter;
    return JSON.stringify([
      config.taxa, config.quality, config.wildOnly, config.photosOnly,
      config.nativeOnly, config.threatenedOnly, config.month, config.season,
      config.sort, config.limit,
      f ? [f.taxonId || null, f.taxonId ? '' : f.query] : null
    ]);
  }

  // Сборка запроса к API v2 с параметром fields (Sparse Fieldsets)
  function buildQueryParams(b, sortOverride, limitOverride) {
    const f = activeMapFilter;
    const limit = limitOverride !== undefined ? limitOverride : (config.limit || 100);
    const sortVal = sortOverride || config.sort || 'random';
    const isRandom = sortVal === 'random' || sortVal === 'random_votes';

    let perPage;
    if (limitOverride !== undefined) {
      perPage = Math.min(200, Math.max(1, limitOverride));
    } else if (f) {
      perPage = Math.min(200, Math.max(100, limit));
    } else if (isRandom) {
      perPage = Math.min(200, Math.max(20, Math.round(limit * 1.15)));
    } else {
      perPage = Math.min(200, Math.max(60, limit * 2));
    }

    const actualOrderBy = (sortVal === 'random_votes' ? 'random' : sortVal);

    const params = new URLSearchParams({
      swlat: b.s.toFixed(4), swlng: b.w.toFixed(4),
      nelat: b.n.toFixed(4), nelng: b.e.toFixed(4),
      per_page: String(perPage),
      order: 'desc',
      order_by: actualOrderBy,
      locale: 'ru',
      preferred_place_id: '6986', // <-- ID 6986 задаёт приоритет русскоязычных названий в iNat
      fields: OBSERVATION_FIELDS_LIGHT
    });

    if (f) {
      if (f.taxonId) params.set('taxon_id', String(f.taxonId));
      else if (f.query) params.set('q', f.query);
    }
    if (config.taxa && config.taxa !== 'all' && !(f && f.taxonId)) params.set('iconic_taxa', config.taxa);
    if (config.quality && config.quality !== 'any') params.set('quality_grade', config.quality);
    if (config.wildOnly) params.set('captive', 'false');
    if (config.photosOnly) params.set('photos', 'true');
    if (config.nativeOnly) params.set('native', 'true');
    if (config.threatenedOnly) params.set('threatened', 'true');
    applyControlledTermFilter(params);

    if (config.month && config.month !== 'any') {
      params.set('month', config.month);
    } else if (config.season && config.season !== 'any' && config.season !== 'current') {
      // Для обычных сезонов (весна/лето/зима/осень) оставляем календарные месяцы
      const m = getMonthsForSeason(config.season);
      if (m) params.set('month', m);
    }
    return params;
  }

  async function fetchTaxonMapLayers(taxonId) {
    if (!taxonId) return { ranges: false, geomodel: false, geomodel_comparison: false, geomodel_taxon_range: false };
    if (mapLayersCache.has(taxonId)) return mapLayersCache.get(taxonId);
    try {
      const data = await inatGet(`taxa/${taxonId}/map_layers`, null, null, 'v2');
      const res = data?.results?.[0] || data || {};
      const info = {
        ranges: !!(res.ranges || res.has_range || res.taxon_ranges),
        geomodel: !!(res.geomodel || res.has_geomodel !== false),
        geomodel_comparison: !!(res.geomodel_comparison || res.geomodel || res.has_geomodel !== false),
        geomodel_taxon_range: !!(res.geomodel_taxon_range || (res.ranges && res.geomodel))
      };
      mapLayersCache.set(taxonId, info);
      return info;
    } catch (e) {
      const fallback = { ranges: true, geomodel: true, geomodel_comparison: true, geomodel_taxon_range: true };
      return fallback;
    }
  }

  async function fetchSimilarSpecies(taxonId) {
    if (!taxonId) return [];
    if (similarSpeciesCache.has(taxonId)) return similarSpeciesCache.get(taxonId);
    try {
      const params = new URLSearchParams({
        taxon_id: String(taxonId),
        locale: 'ru',
        fields: '(count:!t,taxon:(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t,default_photo:(square_url:!t)))'
      });
      const data = await inatGet('identifications/similar_species', params, null, 'v2');
      const results = data.results || [];
      similarSpeciesCache.set(taxonId, results);
      return results;
    } catch (e) {
      return [];
    }
  }

  const histogramInflight = new Map();
  const failedHistograms = new Map(); // id -> timestamp ошибки

  async function fetchSeasonalityHistogram(taxonId, forceFresh = false) {
    if (!taxonId) return null;

    // Если этот таксон недавно завершился ошибкой (429/CORS) — ждём минимум 45 сек перед повтором
    if (!forceFresh && failedHistograms.has(taxonId)) {
      if (Date.now() - failedHistograms.get(taxonId) < 45000) {
        return null;
      }
      failedHistograms.delete(taxonId);
    }

    // Если уже есть данные в кэше
    if (!forceFresh && histogramCache.has(taxonId)) {
      const cached = histogramCache.get(taxonId);
      if (cached && !cached._failed) return cached;
    }

    if (histogramInflight.has(taxonId)) return histogramInflight.get(taxonId);

    // Если действует глобальная пауза rate-limit iNaturalist
    if (Date.now() < cooldownUntil) {
      return null;
    }

    const promise = (async () => {
      try {
        const url = `https://api.inaturalist.org/v1/observations/histogram?taxon_id=${encodeURIComponent(taxonId)}&date_field=observed&interval=month_of_year`;
        
        lastRequestAt = Date.now();
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

        if (res.status === 429) {
          const ra = parseInt(res.headers.get('Retry-After') || '', 10);
          const waitMs = ra > 0 ? ra * 1000 : 30000;
          cooldownUntil = Date.now() + waitMs;
          failedHistograms.set(taxonId, Date.now());
          console.warn(`[iNat] 429 Throttling! Пауза запросов на ${Math.ceil(waitMs / 1000)} сек.`);
          return null;
        }

        if (!res.ok) throw new Error('HTTP ' + res.status);
        
        const json = await res.json();
        const moy = json?.results?.month_of_year || null;

        if (moy && typeof moy === 'object') {
          const sum = Object.entries(moy)
            .filter(([k]) => !k.startsWith('_'))
            .reduce((acc, [, v]) => acc + (Number(v) || 0), 0);
          moy._total = sum;
          histogramCache.set(taxonId, moy);
          return moy;
        }

        return null;
      } catch (err) {
        failedHistograms.set(taxonId, Date.now());
        console.warn(`[iNat] Не удалось загрузить сезонность для таксона #${taxonId}:`, err.message);
        return null;
      } finally {
        histogramInflight.delete(taxonId);
      }
    })();

    histogramInflight.set(taxonId, promise);
    return promise;
  }

  // =========================================================================
  // РЕНДЕР ГРАФИКА СЕЗОННОСТИ И ФЕНОЛОГИИ (OBSERVATIONS HISTOGRAM)
  // =========================================================================
  function renderSeasonalityChart(moy, taxonId = null) {
    if (!moy) {
      return `
        <div class="inat-seasonality-card">
          <div class="inat-seasonality-header">
            <span class="inat-seasonality-title">📅 Сезонность и активность по месяцам:</span>
          </div>
          <div class="muted inat-card-empty-note" style="display:flex; justify-content:space-between; align-items:center;">
            <span>⚠️ Данные сезонности временно недоступны.</span>
            ${taxonId ? `<button type="button" class="btn-link" onclick="window.WM.inat.retrySeasonality(${taxonId})">↺ Повторить</button>` : ''}
          </div>
        </div>
      `;
    }

    const monthKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    const monthLabels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    const currentMonthNum = new Date().getMonth() + 1;

    const values = monthKeys.map(k => Number(moy[k]) || 0);
    const maxVal = Math.max(...values, 1);
    const totalYear = values.reduce((a, b) => a + b, 0);

    const peakMonths = [];
    values.forEach((v, idx) => {
      if (v >= maxVal * 0.6 && v > 0) peakMonths.push(monthLabels[idx]);
    });

    const curMonthVal = values[currentMonthNum - 1];
    const curMonthPct = totalYear > 0 ? Math.round((curMonthVal / totalYear) * 100) : 0;
    const isPeakNow = curMonthVal >= maxVal * 0.6 && curMonthVal > 0;

    let barsHtml = '';
    for (let i = 0; i < 12; i++) {
      const v = values[i];
      const hPct = totalYear > 0 ? Math.max(6, Math.round((v / maxVal) * 100)) : 6;
      const isCur = (i + 1) === currentMonthNum;
      const isPeak = v >= maxVal * 0.6 && v > 0;
      const countFmt = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v;

      barsHtml += `
        <div class="inat-hist-col ${isCur ? 'is-current' : ''} ${isPeak ? 'is-peak' : ''}" title="${monthLabels[i]}: ${v.toLocaleString('ru-RU')} находок">
          <span class="inat-hist-val">${v > 0 ? countFmt : ''}</span>
          <div class="inat-hist-bar-track">
            <div class="inat-hist-bar" style="height: ${hPct}%;"></div>
          </div>
          <span class="inat-hist-label">${monthLabels[i]}</span>
        </div>
      `;
    }

    let summaryText = 'Находок этого вида в базе пока мало для построения календаря.';
    if (totalYear > 0) {
      const peakStr = peakMonths.length ? peakMonths.join('–') : 'Равномерно';
      summaryText = `Пик активности: <b>${peakStr}</b>. Сейчас: <b>${curMonthPct}%</b> от года (${isPeakNow ? '🔥 в сезоне' : '❄️ спад'}).`;
    }

    return `
      <div class="inat-seasonality-card">
        <div class="inat-seasonality-header">
          <span class="inat-seasonality-title">📅 Сезонность и активность по месяцам:</span>
          <span class="inat-seasonality-tag ${isPeakNow ? 'peak-tag' : ''}">${isPeakNow ? '🔥 Сезон в разгаре' : '❄️ Межсезонье'}</span>
        </div>
        <div class="inat-hist-bars-wrap">${barsHtml}</div>
        <div class="inat-seasonality-summary">${summaryText}</div>
      </div>
    `;
  }





  // =========================================================================
  // РЕНДЕР ОПАСНЫХ ДВОЙНИКОВ / ПОХОЖИХ ВИДОВ (SIMILAR SPECIES)
  // =========================================================================
  function renderSimilarSpeciesSection(speciesList, currentTaxon) {
    if (!speciesList) return '<div class="muted inat-card-loading-sub">⏳ Поиск двойников…</div>';
    if (!speciesList.length) {
      return '<div class="muted inat-card-empty-note">🛡️ Эксперты редко путают этот вид с другими таксонами.</div>';
    }

    const totalConfusions = speciesList.reduce((acc, s) => acc + (s.count || 0), 0) || 1;
    const isFungiOrPlant = currentTaxon?.iconic_taxon_name === 'Fungi' || currentTaxon?.iconic_taxon_name === 'Plantae';

    let cardsHtml = '';
    speciesList.slice(0, 4).forEach(item => {
      const t = item.taxon || {};
      const meta = getTaxonMeta(t);
      const ruName = t.preferred_common_name || t.name || meta.name;
      const latinName = t.name || '';
      const photoUrl = t.default_photo?.square_url || '';
      const count = item.count || 0;
      const pct = Math.round((count / totalConfusions) * 100);

      cardsHtml += `
        <div class="inat-similar-item-card" data-taxon-id="${t.id}" data-name="${escapeHtml(ruName)}">
          <div class="inat-similar-thumb-box">
            ${photoUrl ? `<img src="${photoUrl}" class="inat-similar-thumb" alt="" loading="lazy">` : `<span class="inat-similar-icon">${meta.icon}</span>`}
          </div>
          <div class="inat-similar-info">
            <div class="inat-similar-name-row">
              <span class="inat-similar-ru">${escapeHtml(ruName)}</span>
              <span class="inat-similar-pct-badge" title="${count} случаев путаницы">${pct}% путаниц</span>
            </div>
            <span class="inat-similar-la">${escapeHtml(latinName)} · ${meta.name}</span>
            <div class="inat-similar-bar-track">
              <div class="inat-similar-bar-fill" style="width: ${Math.max(8, pct)}%; background: ${meta.color};"></div>
            </div>
          </div>
          <button type="button" class="btn btn-secondary inat-similar-btn-find" title="Искать «${escapeHtml(ruName)}» на карте">
            👁️ Найти
          </button>
        </div>
      `;
    });

    return `
      <div class="inat-similar-wrapper">
        ${isFungiOrPlant ? `
          <div class="inat-lookalike-warning-banner">
            <span class="warn-icon">⚠️</span>
            <span><b>Внимание!</b> При сборе грибов и ягод обязательно сверяйте отличительные признаки со схожими видами.</span>
          </div>
        ` : ''}
        <div class="inat-similar-list">${cardsHtml}</div>
      </div>
    `;
  }

  // =========================================================================
  // РЕНДЕР СЛОЕВ АРЕАЛА ОБИТАНИЯ (RANGE MAPS & GEOMODEL)
  // =========================================================================
  function renderRangeLayersSection(layersInfo, taxon) {
    if (!layersInfo) return '<div class="muted inat-card-loading-sub">⏳ Проверка ареалов…</div>';

    const taxonId = taxon?.id;
    const isCurActive = activeGeomodelTaxon?.id === taxonId;

    const modes = [
      { key: 'taxon_ranges', title: '📐 Научный ареал (Range Map)', desc: 'Официальные границы биологов и Красных книг', avail: layersInfo.ranges },
      { key: 'geomodel_taxon_range', title: '🧬 ИИ + Научный ареал', desc: 'Модель ИИ, ограниченная научным ареалом', avail: layersInfo.geomodel_taxon_range },
      { key: 'geomodel', title: '🤖 Модель ИИ (Geomodel)', desc: 'Биоклиматическая пригодность среды', avail: layersInfo.geomodel },
      { key: 'geomodel_comparison', title: '📊 Сравнение с находками', desc: 'Модель в сравнении с реальными точками', avail: layersInfo.geomodel_comparison }
    ];

    let buttonsHtml = '';
    modes.forEach(m => {
      const isSelected = isCurActive && geomodelType === m.key;
      buttonsHtml += `
        <button type="button" class="inat-range-layer-btn ${isSelected ? 'active' : ''} ${!m.avail ? 'disabled' : ''}" 
                data-layer-type="${m.key}" ${!m.avail ? 'disabled title="Для данного вида слой не составлен"' : ''}>
          <div class="inat-layer-btn-texts">
            <div class="inat-layer-btn-title-row">
              <span class="inat-layer-btn-title">${escapeHtml(m.title)}</span>
              <span class="inat-layer-avail-badge ${m.avail ? 'yes' : 'no'}">${m.avail ? (isSelected ? '✓ Включён' : 'Доступен') : 'Нет данных'}</span>
            </div>
            <span class="inat-layer-btn-desc">${escapeHtml(m.desc)}</span>
          </div>
        </button>
      `;
    });

    return `
      <div class="inat-range-layers-box">
        <p class="inat-layer-section-hint">Нажмите на любой доступный слой, чтобы включить его отображение на карте:</p>
        <div class="inat-range-layers-list">${buttonsHtml}</div>
      </div>
    `;
  }

  // =========================================================================
  // ПОЛНОСТЬЮ ОБНОВЛЕННАЯ, ЛАКОНИЧНАЯ И КРАСИВАЯ КАРТОЧКА НАБЛЮДЕНИЯ
  // =========================================================================
  let cardRenderSeq = 0; // На уровне модуля
  function openObservationCard(obs, syncHistory = true) {
    stopAllAudio(); 
    const currentCardToken = ++cardRenderSeq; 

    const lat = obs._lat;
    const lng = obs._lng;
    clearAccuracyCircle();

    const taxon = obs.taxon || {};
    const meta = getTaxonMeta(taxon);
    const icon = meta.icon;
    const categoryName = meta.name;
    const color = meta.color;

    if (lat !== null && lng !== null && obs.positional_accuracy && map) {
      accuracyCircle = L.circle([lat, lng], {
        radius: obs.positional_accuracy,
        color: color,
        weight: 1.8,
        fillColor: color,
        fillOpacity: 0.16,
        dashArray: '5, 5'
      }).addTo(map);
    }

    let modal = document.getElementById('modal-inat-details');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-inat-details';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }

    const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
    const latinName = taxon.name || 'Не определено';
    const enName = taxon.english_common_name || '';
    const rankKey = taxon.rank || '';
    const rankRu = RANKS_RU[rankKey] || rankKey;

    let dateStr = 'Не указана';
    let timeStr = '';
    const rawTime = obs.time_observed_at || obs.observed_on;
    if (rawTime) {
      const d = new Date(rawTime);
      if (!isNaN(d.getTime())) {
        dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        if (obs.time_observed_at) timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      } else if (obs.observed_on) {
        dateStr = obs.observed_on;
      }
    }

    let accuracy = obs.positional_accuracy ? `±${Math.round(obs.positional_accuracy)} м` : 'Не указана';
    if (obs.obscured) accuracy += ' (огрублено ради защиты)';

    const observerName = obs.user?.name || obs.user?.login || 'Наблюдатель iNaturalist';
    const observerLogin = obs.user?.login || '';
    const observerIcon = obs.user?.icon_url || obs.user?.icon || '';
    const observerObsCount = obs.user?.observations_count != null ? `${obs.user.observations_count.toLocaleString('ru-RU')} находок` : '';

    const isResearch = obs.quality_grade === 'research';
    const isNeedsId = obs.quality_grade === 'needs_id';
    let qualityClass = isResearch ? 'research' : (isNeedsId ? 'need-id' : 'casual');
    let qualityText = isResearch ? '✓ Research Grade' : (isNeedsId ? '🔍 На определении' : '⚪ Любительский');

    const agreements = obs.num_identification_agreements || 0;
    const favesCount = obs.faves_count || 0;
    const wikiUrl = taxon.wikipedia_url || '';
    const inatUrl = obs.uri || `https://www.inaturalist.org/observations/${obs.id}`;
    const placeGuess = obs.place_guess || '';

    // Бейджи статусов
    let conservationHtml = '';
    const cs = obs.conservation_status || taxon.conservation_status;
    if (cs || taxon.threatened) {
      const statusTitle = cs?.status_name || (cs?.iucn ? IUCN_MAP[cs.iucn] : null) || 'Редкий / Охраняемый вид';
      conservationHtml = `<span class="inat-pill threatened" title="Охраняемый статус вида">⚠️ ${escapeHtml(statusTitle)}</span>`;
    }

    let originHtml = '';
    if (taxon.endemic) originHtml = '<span class="inat-pill endemic">🏝️ Эндемик</span>';
    else if (taxon.native) originHtml = '<span class="inat-pill native">🌿 Аборигенный</span>';
    else if (taxon.introduced) originHtml = '<span class="inat-pill introduced">🌍 Интродуцент</span>';

    const captiveHtml = obs.captive
      ? '<span class="inat-pill captive">🏡 Неволя / Сад</span>'
      : '<span class="inat-pill wild">🐾 Дикая природа</span>';

    const privacyHtml = obs.obscured
      ? '<span class="inat-pill obscured" title="Точные координаты огрублены iNaturalist">🔒 Координаты огрублены</span>'
      : '';

    // Фенологические бейджи
    const phenologyHtml = extractPhenologyPills(obs);

    // Фотогалерея
    let photosHtml = '';
    const photos = obs.photos || [];
    let formattedLbPhotos = [];
    if (photos.length > 0) {
      formattedLbPhotos = photos.map(p => {
        let fullUrl = p.url || '';
        if (fullUrl) fullUrl = fullUrl.replace(/\/(square|small|medium|thumb)\./i, '/large.');
        return {
          large_url: fullUrl,
          big_url: fullUrl,
          url: fullUrl,
          user_name: observerName,
          time_str: dateStr,
          attribution: p.attribution || ''
        };
      });

      photosHtml = `
        <div class="inat-photos-box">
          <div class="inat-photos-scroll">
            ${photos.map((p, idx) => `
              <div class="inat-photo-card" data-photo-idx="${idx}" title="Полноэкранный просмотр фото">
                <img src="${(p.url || '').replace('square', 'medium')}" loading="lazy" alt="Фото ${idx + 1}">
                <span class="inat-photo-counter">${idx + 1}/${photos.length}</span>
                ${p.attribution ? `<span class="inat-photo-attr">${escapeHtml(p.attribution)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>`;
    }

    // Звуки природы
    let soundsHtml = '';
    const sounds = obs.sounds || [];
    if (sounds.length > 0) {
      soundsHtml = `
        <details class="inat-card-spoiler" style="margin-bottom: 10px;">
          <summary class="inat-card-spoiler-summary">
            <span>🔊 Звукозаписи (${sounds.length})</span>
            <span class="chevron">▼</span>
          </summary>
          <div class="inat-card-spoiler-body">
            ${sounds.map(s => s.file_url ? `
              <div class="inat-sound-item">
                <audio controls src="${escapeHtml(s.file_url)}" preload="none"></audio>
                ${s.attribution ? `<span class="inat-sound-attr">${escapeHtml(s.attribution)}</span>` : ''}
              </div>` : '').join('')}
          </div>
        </details>`;
    }

    // Иерархия (таксономия)
    let ancestorsHtml = '';
    if (taxon.ancestors && Array.isArray(taxon.ancestors)) {
      const fullHierarchy = [...taxon.ancestors];
      if (!fullHierarchy.some(a => a.id === taxon.id)) fullHierarchy.push(taxon);
      ancestorsHtml = fullHierarchy.map((a) => {
        const isCurrent = a.id === taxon.id;
        const rTitle = RANKS_RU[a.rank] || a.rank || '';
        const nameRu = a.preferred_common_name ? `${a.preferred_common_name} (${a.name})` : a.name;
        return `
          <span class="inat-tree-node ${isCurrent ? 'current' : ''}">
            <small class="inat-tree-rank">${escapeHtml(rTitle)}</small>
            <b>${escapeHtml(nameRu)}</b>
          </span>`;
      }).join('<span class="inat-tree-arrow">➔</span>');
    }

    // Определения сообщества и комментарии
    const idents = obs.identifications || [];
    const comments = obs.comments || [];
    const totalCommunity = [...idents, ...comments];

    let communityHtml = '';
    if (totalCommunity.length > 0) {
      communityHtml = `
        <div class="inat-idents-list">
          ${idents.map(id => {
            const uName = id.user?.name || id.user?.login || 'Эксперт';
            const uLogin = id.user?.login ? `@${id.user.login}` : '';
            const uAvatar = id.user?.icon_url || id.user?.icon || '';
            const idTaxon = id.taxon || {};
            const idNameRu = idTaxon.preferred_common_name || idTaxon.name || '';
            const idNameLa = idTaxon.name || '';
            const createdDate = id.created_at ? id.created_at.slice(0, 10) : '';
            const isAgreed = id.category === 'supporting' || id.current;
            return `
              <div class="inat-ident-item">
                <div class="inat-ident-head">
                  <div style="display:flex; align-items:center; gap:6px;">
                    ${uAvatar ? `<img src="${uAvatar}" class="inat-ident-avatar" alt="">` : `<span class="inat-ident-avatar placeholder">${escapeHtml(uName[0])}</span>`}
                    <div><b>${escapeHtml(uName)}</b> <small style="color:var(--text-muted);">${escapeHtml(uLogin)}</small></div>
                  </div>
                  <small style="color:var(--text-muted);">${createdDate}</small>
                </div>
                <div class="inat-ident-taxon-row">
                  <span class="inat-ident-badge ${isAgreed ? 'agreed' : 'proposed'}">${isAgreed ? '✓ Подтвердил' : '💡 Предложил'}</span>
                  <span class="inat-ident-taxon-name"><b>${escapeHtml(idNameRu)}</b> <i>(${escapeHtml(idNameLa)})</i></span>
                </div>
                ${id.body ? `<div class="inat-ident-body">${escapeHtml(id.body)}</div>` : ''}
              </div>`;
          }).join('')}
          ${comments.map(c => `
            <div class="inat-comment-item">
              <div class="inat-comment-head">
                <b>${escapeHtml(c.user?.name || c.user?.login || 'Участник')}</b>
                <small>${c.created_at ? c.created_at.slice(0, 10) : ''}</small>
              </div>
              <div class="inat-comment-body">${escapeHtml(c.body)}</div>
            </div>`).join('')}
        </div>`;
    }

    const hasFullDetails = obs._isFullDetail || (obs.identifications && obs.identifications.length > 0) || obs.description;

    const isAnimalGroup = ['Aves', 'Mammalia', 'Amphibia', 'Reptilia', 'Insecta', 'Animalia', 'Actinopterygii', 'Arachnida'].includes(taxon.iconic_taxon_name);
    const isPlantGroup = taxon.iconic_taxon_name === 'Plantae';
    const isFungiGroup = taxon.iconic_taxon_name === 'Fungi';

    modal.innerHTML = `
      <div class="modal-box modal-box-large inat-details-box">
        <!-- ШАПКА КАРТОЧКИ -->
        <div class="modal-header inat-card-modal-header">
          <div class="inat-modal-title-row">
            <div class="inat-card-badge-line">
              <span class="inat-type-tag" style="--tag-color: ${color}; background: ${meta.bg}; color: ${color};">
                ${icon} ${categoryName}${rankRu ? ` · ${rankRu.toUpperCase()}` : ''}
              </span>
              <span class="inat-pill ${qualityClass}">${qualityText}</span>
            </div>
            <div class="inat-header-titles">
              <h3 class="inat-header-ru">${escapeHtml(ruName)}</h3>
              <div class="inat-header-la">
                <i>${escapeHtml(latinName)}</i>${enName && enName !== ruName ? ` · <span class="inat-en-name">${escapeHtml(enName)}</span>` : ''}
              </div>
            </div>
          </div>
          <button class="modal-close-x" id="inat-modal-close-x" title="Закрыть карточку">✕</button>
        </div>

        <div class="modal-content-scroll" style="max-height: 68vh;">
          ${photosHtml}

          <!-- БЫСТРАЯ ЛЕНТА ПИЛЮЛЬ -->
          <div class="inat-meta-pills-row" id="inat-meta-pills-row">
            ${phenologyHtml}
            ${conservationHtml}
            ${originHtml}
            ${captiveHtml}
            ${privacyHtml}
            ${agreements > 0 ? `<span class="inat-pill" title="Подтверждений определения">👍 ${agreements}</span>` : ''}
            ${favesCount > 0 ? `<span class="inat-pill faves" title="В избранном">❤️ ${favesCount}</span>` : ''}
          </div>

          <!-- СВОДКА WIKIPEDIA (Сразу создана с плейсхолдером) -->
          <div id="inat-wiki-summary-slot" style="margin-bottom: 10px;">
            <div class="inat-skeleton-placeholder">
              <span>📖 Загрузка статьи Википедии…</span>
            </div>
          </div>

          <!-- БЫСТРЫЕ ДЕЙСТВИЯ -->
          <div class="nav-actions-grid inat-actions-grid" style="margin-bottom: 12px;">
            <button type="button" class="action-card-btn primary" id="btn-inat-set-target">🎯 Вести к организму</button>
            <button type="button" class="action-card-btn filter-taxon-btn" id="btn-inat-filter-this-taxon" title="Найти все такие же на карте">
              🔍 Все такие же
            </button>
            <a href="geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(ruName)})" class="action-card-btn" id="btn-inat-geo-nav">🧭 Навигатор</a>
            <button type="button" class="action-card-btn" id="btn-inat-copy-coords">📋 Координаты</button>
          </div>

          <!-- ГРАФИК СЕЗОННОСТИ (Зарезервированная высота 140px) -->
          <div id="inat-seasonality-container" style="margin-bottom: 12px;">
            <div class="inat-seasonality-card" style="min-height: 130px; display:flex; align-items:center; justify-content:center;">
              <span class="muted inat-card-loading-sub">📅 Загрузка фенологического календаря…</span>
            </div>
          </div>

          <!-- СПОЙЛЕР: ПОХОЖИЕ ВИДЫ / ДВОЙНИКИ -->
          <details class="inat-card-spoiler" id="spoiler-inat-similar" style="margin-bottom: 10px;">
            <summary class="inat-card-spoiler-summary">
              <span>⚠️ С чем часто путают / Двойники</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body" id="inat-similar-container">
              <div class="muted inat-card-loading-sub">⏳ Поиск видов-двойников…</div>
            </div>
          </details>

          <!-- СПОЙЛЕР: АРЕАЛЫ ОБИТАНИЯ -->
          <details class="inat-card-spoiler" id="spoiler-inat-ranges" style="margin-bottom: 10px;">
            <summary class="inat-card-spoiler-summary">
              <span>🗺️ Научные и прогнозные ареалы обитания</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body" id="inat-ranges-container">
              <div class="muted inat-card-loading-sub">⏳ Проверка слоёв карт…</div>
            </div>
          </details>

          <!-- СПОЙЛЕР: ДАННЫЕ О НАБЛЮДАТЕЛЕ И КООРДИНАТАХ -->
          <details class="inat-card-spoiler" style="margin-bottom: 10px;">
            <summary class="inat-card-spoiler-summary">
              <span>📍 Наблюдатель, дата и координаты</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body">
              <div class="inat-card-grid" style="margin-bottom: 0;">
                <div class="inat-cell">
                  <span class="inat-lbl">📅 Дата находки:</span>
                  <b>${dateStr}${timeStr ? ` · ${timeStr}` : ''}</b>
                </div>
                <div class="inat-cell">
                  <span class="inat-lbl">🎯 Точность GPS:</span>
                  <b>${accuracy}</b>
                </div>
                <div class="inat-cell" style="grid-column: span 2;">
                  <span class="inat-lbl">👤 Наблюдатель iNaturalist:</span>
                  <div class="inat-observer-row">
                    ${observerIcon ? `<img src="${observerIcon}" class="inat-observer-avatar" alt="">` : `<span class="inat-observer-avatar placeholder">👤</span>`}
                    <div style="min-width:0;">
                      <b class="inat-observer-name">${escapeHtml(observerName)}</b>
                      ${observerLogin ? `<small class="inat-observer-login">(@${escapeHtml(observerLogin)})</small>` : ''}
                      ${observerObsCount ? `<span class="inat-observer-count"> · ${observerObsCount}</span>` : ''}
                    </div>
                  </div>
                </div>
                ${placeGuess ? `
                  <div class="inat-cell" style="grid-column: span 2;">
                    <span class="inat-lbl">🏡 Местность:</span>
                    <b>${escapeHtml(placeGuess)}</b>
                  </div>` : ''}
                <div class="inat-cell" style="grid-column: span 2;">
                  <span class="inat-lbl">📍 Координаты центра:</span>
                  <div class="inat-coords-row">
                    <b class="inat-coords-val">${lat != null ? lat.toFixed(6) : '--'}, ${lng != null ? lng.toFixed(6) : '--'}</b>
                    <button type="button" class="btn-link inat-coords-copy-mini" id="btn-inat-copy-coords-mini">Копировать</button>
                  </div>
                </div>
              </div>
            </div>
          </details>

          <!-- СПОЙЛЕР ДЛЯ ЖИВОТНЫХ (свёрнут по умолчанию) -->
         ${isAnimalGroup ? `
            <details class="inat-card-spoiler" id="spoiler-inat-traits" style="margin-bottom: 10px;">
              <summary class="inat-card-spoiler-summary">
                <span>🐾 Повадки, рацион и биометрия</span>
                <span class="chevron">▼</span>
              </summary>
              <div class="inat-card-spoiler-body" id="inat-traits-body">
                <div class="muted inat-card-loading-sub" style="min-height: 48px; display:flex; align-items:center;">
                  ⏳ Загрузка биометрии и повадок (Wikidata & EOL)…
                </div>
              </div>
            </details>
          ` : ''}

          <!-- СПОЙЛЕР ДЛЯ РАСТЕНИЙ (свёрнут по умолчанию) -->
          ${isPlantGroup ? `
            <details class="inat-card-spoiler" id="spoiler-inat-plant-traits" style="margin-bottom: 10px;">
              <summary class="inat-card-spoiler-summary">
                <span>🌿 Ботанические свойства и морфология</span>
                <span class="chevron">▼</span>
              </summary>
              <div class="inat-card-spoiler-body" id="inat-plant-traits-body">
                <div class="muted inat-card-loading-sub" style="min-height: 48px; display:flex; align-items:center;">
                  ⏳ Загрузка характеристик растения (Wikidata)…
                </div>
              </div>
            </details>
          ` : ''}

          <!-- СПОЙЛЕР ДЛЯ ГРИБОВ (свёрнут по умолчанию) -->
          ${isFungiGroup ? `
            <details class="inat-card-spoiler" id="spoiler-inat-fungi-traits" style="margin-bottom: 10px;">
              <summary class="inat-card-spoiler-summary">
                <span>🍄 Микологические характеристики и гименофор</span>
                <span class="chevron">▼</span>
              </summary>
              <div class="inat-card-spoiler-body" id="inat-fungi-traits-body">
                <div class="muted inat-card-loading-sub" style="min-height: 48px; display:flex; align-items:center;">
                  ⏳ Загрузка характеристик гриба (Wikidata)…
                </div>
              </div>
            </details>
          ` : ''}

          <!-- СПОЙЛЕР: ЗВУКИ ПРИРОДЫ -->
          <div id="inat-sounds-slot" style="margin-bottom: 10px;">
            ${soundsHtml}
          </div>

          <!-- ЗАМЕТКА НАБЛЮДАТЕЛЯ -->
          ${obs.description ? `
            <details class="inat-card-spoiler" style="margin-bottom: 10px;">
              <summary class="inat-card-spoiler-summary">
                <span>📝 Заметка наблюдателя</span>
                <span class="chevron">▼</span>
              </summary>
              <div class="inat-card-spoiler-body">
                <p class="inat-desc-text">${escapeHtml(obs.description)}</p>
              </div>
            </details>` : ''}

          <!-- ТАКСОНОМИЯ -->
          ${ancestorsHtml ? `
            <details class="inat-card-spoiler" style="margin-bottom: 10px;">
              <summary class="inat-card-spoiler-summary">
                <span>🧬 Таксономия (иерархия вида)</span>
                <span class="chevron">▼</span>
              </summary>
              <div class="inat-card-spoiler-body">
                <div class="inat-tree-content">${ancestorsHtml}</div>
              </div>
            </details>` : ''}

          <!-- ОБСУЖДЕНИЕ СООБЩЕСТВА -->
          <details class="inat-card-spoiler" id="spoiler-inat-community" style="margin-bottom: 12px;">
            <summary class="inat-card-spoiler-summary">
              <span>👥 Консенсус и комментарии (${totalCommunity.length})</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body" id="inat-community-container">
              ${communityHtml || '<div class="muted inat-card-empty-note">Комментариев пока нет.</div>'}
              ${!hasFullDetails ? `<div class="muted inat-card-loading-sub">⏳ Загрузка обсуждения v2…</div>` : ''}
            </div>
          </details>

          <!-- ССЫЛКИ -->
          <div class="nav-actions-grid inat-actions-grid" style="margin-top: 4px;">
            ${wikiUrl ? `<a href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener noreferrer" class="action-card-btn wiki-btn">📖 Статья в Википедии ↗</a>` : ''}
            <a href="${escapeHtml(inatUrl)}" target="_blank" rel="noopener noreferrer" class="action-card-btn inat-link-btn" style="grid-column: span 2;">
              🌐 Страница на iNaturalist.org ↗
            </a>
          </div>
        </div>
      </div>
    `;

    modal.classList.add('open');
    if (syncHistory && WM.ui && WM.ui.pushHistoryState) {
      WM.ui.pushHistoryState('inatDetails');
    }
    // 1. Асинхронная подгрузка сезонности (передаем taxon.id для кнопки повтора при ошибке)
    if (taxon && taxon.id) {
      // 1. Сезонность загружаем сразу
      fetchSeasonalityHistogram(taxon.id).then(moy => {
        const el = document.getElementById('inat-seasonality-container');
        if (el) el.innerHTML = renderSeasonalityChart(moy, taxon.id);
      });

      // 2. Двойников запрашиваем через 150 мс
      setTimeout(() => {
        fetchSimilarSpecies(taxon.id).then(simList => {
          const el = document.getElementById('inat-similar-container');
          if (el) {
            el.innerHTML = renderSimilarSpeciesSection(simList, taxon);
            el.querySelectorAll('.inat-similar-item-card').forEach(card => {
              const btn = card.querySelector('.inat-similar-btn-find');
              btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const tid = parseInt(card.dataset.taxonId, 10);
                const name = card.dataset.name;
                closeModal();
                applyFilterToMap(name, { id: tid, name });
              });
            });
          }
        });
      }, 150);

      // 3. Проверку слоёв ареала запрашиваем через 300 мс
      setTimeout(() => {
        fetchTaxonMapLayers(taxon.id).then(layersInfo => {
          const el = document.getElementById('inat-ranges-container');
          if (el) {
            el.innerHTML = renderRangeLayersSection(layersInfo, taxon);
            el.querySelectorAll('.inat-range-layer-btn:not(.disabled)').forEach(btn => {
              btn.addEventListener('click', () => {
                const lType = btn.dataset.layerType;
                showGeomodelForTaxon(taxon, lType);
                closeModal();
              });
            });
          }
        });
      }, 300);
    }

    // 4. Полные детали наблюдения запрашиваем через 450 мс
    if (!hasFullDetails && obs.id) {
      setTimeout(() => {
        fetchObservationFullDetails(obs.id).then(fullData => {
          if (!fullData) return;
          Object.assign(obs, fullData);
          obs._isFullDetail = true;

          const curModal = document.getElementById('modal-inat-details');
          if (curModal && curModal.classList.contains('open')) {
            openObservationCard(obs, false);
          }
        });
      }, 450);
    }

    // =========================================================================
    // 5. ФОНОВАЯ ИНТЕГРАЦИЯ WIKIPEDIA REST API + WIKIDATA
    // =========================================================================
    (async () => {
      const queryCandidates = Array.from(new Set([
        taxon.preferred_common_name,
        ruName !== latinName ? ruName : null,
        taxon.name,
        latinName
      ].filter(Boolean)));

      // 1. Асинхронно запрашиваем сводку Википедии
      let wikiData = null;
      for (const query of queryCandidates) {
        wikiData = await fetchWikiSummary(query);
        if (wikiData && wikiData.extract) break;
      }

      const wikiSlot = document.getElementById('inat-wiki-summary-slot');
      if (wikiSlot) {
        if (wikiData && wikiData.extract) {
          wikiSlot.innerHTML = `
            <div class="inat-wiki-summary-box">
              <div class="inat-wiki-summary-head">
                <span class="inat-wiki-summary-title">📖 Википедия</span>
                ${wikiData.description ? `<span class="inat-wiki-desc-badge">${escapeHtml(wikiData.description)}</span>` : ''}
              </div>
              <div class="inat-wiki-summary-body">
                ${wikiData.thumbnail ? `<img src="${escapeHtml(wikiData.thumbnail)}" class="inat-wiki-thumb" alt="" loading="lazy">` : ''}
                <p class="inat-wiki-extract-text">${escapeHtml(wikiData.extract)}</p>
              </div>
            </div>
          `;
        } else {
          wikiSlot.innerHTML = `
            <div class="muted inat-card-empty-note" style="padding: 6px 0; font-size: 11px;">
              📖 Краткая справка в Википедии отсутствует.
            </div>
          `;
        }
      }

      // 2. Для птиц и животных подгружаем библиотеку звуков
      const hasSounds = ['Aves', 'Amphibia', 'Mammalia', 'Insecta'].includes(taxon.iconic_taxon_name);
      if (hasSounds && latinName && latinName !== 'Не определено') {
        fetchBirdSounds(latinName).then(xcSounds => {
          const soundsSlot = document.getElementById('inat-sounds-slot');
          if (soundsSlot && (xcSounds.length > 0 || (obs.sounds && obs.sounds.length > 0))) {
            soundsSlot.innerHTML = renderSoundsSection(xcSounds, obs.sounds || []);
          }
        });
      }

      // 3. Запрашиваем съедобность для растений/грибов
      const wdData = (latinName && latinName !== 'Не определено')
        ? await fetchWikidataEdibility(latinName)
        : null;

      let animalTraits = null;
      let plantTraits = null;
      let fungiTraits = null;

      // 4.1. Повадки и биометрия животных
      if (isAnimalGroup && latinName && latinName !== 'Не определено') {
        animalTraits = await fetchAnimalTraits(latinName, wikiData?.extract || '');
        const traitsBody = document.getElementById('inat-traits-body');
        if (traitsBody) traitsBody.innerHTML = renderTraitsSection(animalTraits);
      }

      // 4.2. Ботанические признаки растений (ИСПРАВЛЕНО!)
      if (isPlantGroup && latinName && latinName !== 'Не определено') {
        plantTraits = await fetchPlantTraits(latinName, wikiData?.extract || '');
        const plantBody = document.getElementById('inat-plant-traits-body');
        if (plantBody) plantBody.innerHTML = renderPlantTraitsSection(plantTraits);
      }

      // 4.3. Микологические признаки грибов
      if (isFungiGroup && latinName && latinName !== 'Не определено') {
        fungiTraits = await fetchFungiTraits(latinName, wikiData?.extract || '');
        const fungiBody = document.getElementById('inat-fungi-traits-body');
        if (fungiBody) fungiBody.innerHTML = renderFungiTraitsSection(fungiTraits);
      }



      // 5. Динамические пилюли в шапке карточки
      if (currentCardToken !== cardRenderSeq) return;

      const pillsRow = document.getElementById('inat-meta-pills-row');
      if (pillsRow) {
        const extraPills = [];
        const seenKeys = new Set();

        // Считываем уже имеющиеся теги
        pillsRow.querySelectorAll('.inat-pill').forEach(el => {
          seenKeys.add(el.textContent.replace(/[\s\-_]+/g, '').toLowerCase());
        });

        function pushPill(html, label) {
          if (!html) return;
          const clean = (label || html.replace(/<[^>]+>/g, '')).replace(/[\s\-_]+/g, '').toLowerCase();
          for (const k of seenKeys) {
            if (k.includes(clean) || clean.includes(k)) return; // Исключает дублирование «многолетник» и «многолетнее растение»
          }
          seenKeys.add(clean);
          extraPills.push(html);
        }

        if (fungiTraits) {
          if (fungiTraits.edibility) {
            pushPill(`
              <span class="inat-pill ${fungiTraits.edibility.class}" title="Статус съедобности гриба">
                ${fungiTraits.edibility.icon} ${escapeHtml(fungiTraits.edibility.text)}
              </span>`, fungiTraits.edibility.text);
          }
          if (fungiTraits.isMedicinal) pushPill('<span class="inat-pill inat-pill-medicinal" title="Используется в медицине">💊 Целебный</span>', 'целебный');
          if (fungiTraits.isPsychoactive) pushPill('<span class="inat-pill inat-pill-trait" title="Психоактивный вид">🍄✨ Психоактивный</span>', 'психоактивный');
          if (fungiTraits.hymeniumType) pushPill(`<span class="inat-pill inat-pill-trait">${fungiTraits.hymeniumType.icon} ${escapeHtml(fungiTraits.hymeniumType.text)}</span>`, fungiTraits.hymeniumType.text);
        }

        if (plantTraits) {
          if (plantTraits.growthForm) pushPill(`<span class="inat-pill inat-pill-trait" title="Жизненная форма">${plantTraits.growthForm.icon} ${escapeHtml(plantTraits.growthForm.text)}</span>`, plantTraits.growthForm.text);
          if (plantTraits.lifeCycle) pushPill(`<span class="inat-pill inat-pill-trait" title="Жизненный цикл">⏳ ${escapeHtml(plantTraits.lifeCycle)}</span>`, plantTraits.lifeCycle);
          if (plantTraits.longevity) pushPill(`<span class="inat-pill inat-pill-trait" title="Срок жизни">⏳ До ${escapeHtml(plantTraits.longevity)}</span>`, plantTraits.longevity);
          if (plantTraits.fruitType) pushPill(`<span class="inat-pill inat-pill-trait" title="Тип плода">${plantTraits.fruitType.icon || '🌰'} ${escapeHtml(plantTraits.fruitType.text)}</span>`, plantTraits.fruitType.text);
          if (plantTraits.characteristics?.length) {
            plantTraits.characteristics.forEach(ch => {
              if (ch.pill) pushPill(`<span class="inat-pill inat-pill-trait">${escapeHtml(ch.pill)}</span>`, ch.text);
            });
          }
          if (plantTraits.toxicity) {
            pushPill(`<span class="inat-pill" style="background:rgba(239,68,68,0.15); color:${plantTraits.toxicity.color}; border:1px solid ${plantTraits.toxicity.color};">${plantTraits.toxicity.icon} ${escapeHtml(plantTraits.toxicity.text)}</span>`, plantTraits.toxicity.text);
          }
        }

        if (wdData && wdData.edibleParts && wdData.edibleParts.length > 0) {
          pushPill(`
            <span class="inat-pill inat-pill-edible" title="Съедобные части">
              🍓 Съедобно: ${escapeHtml(wdData.edibleParts.join(', '))}
            </span>`, 'съедобно');
        }

        if ((wdData && wdData.isMedicinal) || plantTraits?.isMedicinal) {
          pushPill('<span class="inat-pill inat-pill-medicinal" title="Лекарственное растение">💊 Лекарственное</span>', 'лекарственное');
        }

        if (extraPills.length > 0) {
          pillsRow.insertAdjacentHTML('afterbegin', extraPills.join(''));
        }
      }
    })();

    // Фото-лайтбокс
    modal.querySelectorAll('.inat-photo-card').forEach(card => {
      card.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(card.dataset.photoIdx, 10) || 0;
        if (formattedLbPhotos.length > 0 && WM.ui && WM.ui.openLightbox) {
          WM.ui.openLightbox(formattedLbPhotos, idx);
        }
      };
    });

    document.getElementById('inat-modal-close-x')?.addEventListener('click', closeModal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    document.getElementById('btn-inat-set-target')?.addEventListener('click', () => {
      if (WM.navTarget) {
        WM.navTarget.set({
          id: 'inat_' + obs.id,
          title: `${icon} ${ruName}`,
          lat, lng
        });
        closeModal();
      }
    });

    document.getElementById('btn-inat-filter-this-taxon')?.addEventListener('click', () => {
      if (obs.taxon) filterByTaxon(obs.taxon);
    });

    const copyCoords = () => {
      if (lat != null && lng != null) {
        const cStr = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        navigator.clipboard.writeText(cStr).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📋 Скопировано: ${cStr}`);
        });
      }
    };
    document.getElementById('btn-inat-copy-coords')?.addEventListener('click', copyCoords);
    document.getElementById('btn-inat-copy-coords-mini')?.addEventListener('click', copyCoords);
  }

  function extractPhenologyPills(obs) {
    const pills = [];
    const annotations = obs.annotations || [];
    for (const ann of annotations) {
      const attrId = ann.controlled_attribute_id || ann.controlled_attribute?.id;
      const valId = ann.controlled_value_id || ann.controlled_value?.id;
      const key = `${attrId}_${valId}`;
      let term = PHENOLOGY_TERMS[key];
      if (!term && ann.controlled_value?.label) {
        const lbl = ann.controlled_value.label.toLowerCase();
        if (lbl.includes('flower')) term = PHENOLOGY_TERMS['12_13'];
        else if (lbl.includes('fruit')) term = PHENOLOGY_TERMS['12_14'];
        else if (lbl.includes('bud')) term = PHENOLOGY_TERMS['12_15'];
        else if (lbl.includes('adult')) term = PHENOLOGY_TERMS['1_2'];
        else if (lbl.includes('larva')) term = PHENOLOGY_TERMS['1_6'];
      }
      if (term) {
        pills.push(`
          <span class="inat-pill inat-pill-pheno" style="--pheno-color: ${term.color}; --pheno-bg: ${term.bg};" title="Подтвержденная аннотация iNaturalist">
            ${term.icon} ${escapeHtml(term.text)}
          </span>
        `);
      }
    }
    return pills.join('');
  }

  function setLoading(on) {
    const badge = document.getElementById('inat-count-badge');
    const spinner = document.getElementById('inat-count-badge-spinner');
    const btn = document.getElementById('inat-count-badge-refresh');
    if (badge) badge.classList.toggle('loading', !!on);
    if (spinner) spinner.hidden = !on;
    if (btn) btn.classList.toggle('spinning', !!on);
    updateTopBadge(!!on);
  }

  function abortInflight() {
    fetchSeq++;
    if (inflight) {
      try { inflight.ctl.abort(); } catch (e) {}
      inflight = null;
    }
    setLoading(false);
  }

  function clearAllMarkers() {
    for (const m of markerInstances.values()) m.off();
    if (layer) layer.clearLayers();
    markerInstances.clear();
    activeObservations.clear();
    if (activeMapFilter) activeMapFilter.results = [];
    clearHoverHighlight();
  }

  function resetCache(newKey) {
    abortInflight();
    obsCache.clear();
    coverage = null;
    cacheKey = newKey;
    clearAllMarkers();
    updateOverviewTileLayer();
  }

  function minZoomNow() { return activeMapFilter ? MIN_FILTER_ZOOM : MIN_VIEW_ZOOM; }

  function ingest(data, bounds, viewB) {
    const items = data.results || [];
    const total = +data.total_results || 0;
    const truncated = total > items.length;

    const seen = new Set();
    for (const obs of items) {
      const ll = extractLatLng(obs);
      if (!ll) continue;
      obs._lat = ll.lat;
      obs._lng = ll.lng;
      seen.add(obs.id);
      obsCache.delete(obs.id);
      obsCache.set(obs.id, obs);
    }

    if (!truncated) {
      for (const [id, o] of obsCache) {
        if (!seen.has(id) && pointIn(bounds, o._lat, o._lng)) obsCache.delete(id);
      }
    }

    if (obsCache.size > CACHE_MAX) {
      const c = map.getCenter();
      const arr = [...obsCache.values()].map(o => ({
        id: o.id, d: (o._lat - c.lat) ** 2 + (o._lng - c.lng) ** 2
      }));
      arr.sort((a, b) => b.d - a.d);
      const toDrop = obsCache.size - Math.floor(CACHE_MAX * 0.8);
      for (let i = 0; i < toDrop; i++) obsCache.delete(arr[i].id);
    }

    coverage = { bounds, core: viewB, truncated, time: Date.now() };
    failCount = 0;
    renderVisible();

    if (announceFilter && activeMapFilter) {
      announceFilter = false;
      const n = activeMapFilter.results.length;
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(n > 0
          ? `🌿 Найдено на экране: «${activeMapFilter.query}» (${n} шт.)`
          : `В видимой области «${activeMapFilter.query}» не обнаружено`);
      }
    }
  }

  function scheduleFetch(force = false, delay = FETCH_DEBOUNCE_MS) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => runFetch(force), delay);
  }

  async function runFetch(force = false) {
    if (!map || !layer || !config.enabled) return;
    if (document.hidden) return;

    const key = getQueryKey();
    if (key !== cacheKey) resetCache(key);

    if (map.getZoom() < minZoomNow()) {
      abortInflight();
      renderVisible();
      return;
    }

    const lb = map.getBounds();
    const viewB = toBounds(lb);

    if (!force && inflight && inflight.key === key && containsBounds(inflight.bounds, viewB)) return;
    if (!needFetch(viewB, force)) {
      renderVisible();
      return;
    }

    const now = Date.now();
    const wait = Math.max(cooldownUntil - now, lastRequestAt + MIN_REQUEST_GAP_MS - now, 0);
    if (wait > 0) {
      scheduleFetch(force, wait + 50);
      return;
    }

    abortInflight();
    const seq = ++fetchSeq;
    const ctl = new AbortController();
    const bounds = toBounds(lb.pad(BBOX_PAD));
    inflight = { ctl, key, bounds };
    setLoading(true);

    try {
      let data;
      if (config.sort === 'random_votes') {
        const targetLimit = config.limit || 100;
        const count70 = Math.max(1, Math.round(targetLimit * 0.7));
        const paramsRandom = buildQueryParams(bounds, 'random', count70);
        const paramsVotes = buildQueryParams(bounds, 'votes', count70);

        const resRandom = await inatGet('observations', paramsRandom, ctl.signal, 'v2');
        if (seq !== fetchSeq || key !== cacheKey) return;

        await new Promise(r => setTimeout(r, 150));
        if (seq !== fetchSeq || key !== cacheKey) return;

        const resVotes = await inatGet('observations', paramsVotes, ctl.signal, 'v2');
        if (seq !== fetchSeq || key !== cacheKey) return;

        const combinedItems = [];
        const seen = new Set();
        for (const item of (resRandom.results || [])) {
          if (!seen.has(item.id)) { seen.add(item.id); combinedItems.push(item); }
        }
        for (const item of (resVotes.results || [])) {
          if (!seen.has(item.id)) { seen.add(item.id); combinedItems.push(item); }
        }

        data = {
          total_results: Math.max(resRandom.total_results || 0, resVotes.total_results || 0),
          results: combinedItems
        };
      } else {
        data = await inatGet('observations', buildQueryParams(bounds), ctl.signal, 'v2');
      }

      if (seq !== fetchSeq || key !== cacheKey) return;
      ingest(data, bounds, viewB);
    } catch (err) {
      if (err.name === 'AbortError' || seq !== fetchSeq) return;
      if (err.status === 429) {
        const ms = err.retryAfterMs || 60000;
        const first = Date.now() >= cooldownUntil;
        cooldownUntil = Date.now() + ms;
        if (first && WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`⏳ iNaturalist ограничил частоту запросов. Пауза ${Math.ceil(ms / 1000)} с`, 3000);
        }
        scheduleFetch(false, ms + 100);
      } else {
        failCount++;
        console.warn('[iNaturalist v2] Ошибка загрузки точек:', err.message);
        if (failCount <= 4) {
          const backoff = Math.min(30000, 2000 * 2 ** (failCount - 1));
          cooldownUntil = Date.now() + backoff;
          scheduleFetch(false, backoff + 100);
        }
      }
    } finally {
      if (seq === fetchSeq) {
        inflight = null;
        setLoading(false);
        updateTopBadge();
      }
    }
  }

  function onViewChanged() {
    if (!config.enabled) return;
    renderVisible();
    scheduleFetch(false);
  }

  let lastCrosshairCheckTime = 0;

  function scheduleCrosshairCheck() {
    // Если палец прямо сейчас тянет карту — не пересчитываем стили и не грузим CPU
    if (map && map.dragging && map.dragging.moving()) return;

    if (crossRaf) return;
    crossRaf = requestAnimationFrame(() => {
      crossRaf = 0;
      const now = performance.now();
      // Троттлинг не чаще раза в 60 мс
      if (now - lastCrosshairCheckTime < 60) return;
      lastCrosshairCheckTime = now;
      checkCrosshairProximity();
    });
  }

  function stopAllAudio() {
    const modal = document.getElementById('modal-inat-details');
    if (modal) {
      modal.querySelectorAll('audio').forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.removeAttribute('src'); // освобождает сетевой буфер браузера
          audio.load();
        } catch (e) {}
      });
    }
  }

  function closeModal(syncHistory = true) {
    stopAllAudio(); // <--- ОСТАНАВЛИВАЕТ ЗВУКИ ПРИ ЗАКРЫТИИ КАРТОЧКИ
    const modal = document.getElementById('modal-inat-details');
    if (modal) modal.classList.remove('open');
    clearAccuracyCircle();
    clearHoverHighlight();
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('inatDetails');
    }
    renderVisible();
  }



  // =========================================================================
  // КАРТОЧКА НАБЛЮДЕНИЯ: МГНОВЕННЫЙ ПОКАЗ + ФОНОВАЯ ДОГРУЗКА v2 FULL DETAILS
  // =========================================================================
  async function fetchObservationFullDetails(obsId) {
    if (fullDetailsCache.has(obsId)) return fullDetailsCache.get(obsId);
    try {
      const params = new URLSearchParams({ fields: 'all', locale: 'ru' });
      const data = await inatGet(`observations/${obsId}`, params, null, 'v2');
      if (data?.results?.[0]) {
        fullDetailsCache.set(obsId, data.results[0]);
        return data.results[0];
      }
    } catch (e) {
      try {
        const v1Res = await fetch(`https://api.inaturalist.org/v1/observations/${obsId}?locale=ru`);
        const v1Data = await v1Res.json();
        if (v1Data?.results?.[0]) {
          fullDetailsCache.set(obsId, v1Data.results[0]);
          return v1Data.results[0];
        }
      } catch (e2) {}
    }
    return null;
  }

  function filterByTaxon(taxon) {
    if (!taxon) return;
    closeModal();
    selectedTaxon = taxon;
    const input = document.getElementById('inat-filter-query');
    const displayName = taxon.preferred_common_name || taxon.name;
    if (input) {
      input.value = displayName;
      const clearBtn = document.getElementById('inat-filter-query-clear');
      if (clearBtn) clearBtn.hidden = false;
    }
    applyFilterToMap();
  }

  

  // =========================================================================
  // ТАКСОНОМИЧЕСКИЙ АВТОДОПОЛНИТЕЛЬ (v2 С SPARSE FIELDSETS)
  // =========================================================================
  async function fetchTaxaAutocomplete(query, signal = null) {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    const params = new URLSearchParams({
      q,
      locale: 'ru',
      preferred_place_id: '6986',
      per_page: '8',
      fields: '(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t,default_photo:(square_url:!t))'
    });

    if (config.taxa && config.taxa !== 'all') params.set('iconic_taxa', config.taxa);

    try {
      const data = await inatGet('taxa/autocomplete', params, signal, 'v2');
      return data.results || [];
    } catch (e) {
      // Резервный вызов v1 в случае сбоя прокси
      try {
        const res = await fetch(`https://api.inaturalist.org/v1/taxa/autocomplete?q=${encodeURIComponent(q)}&locale=ru&per_page=8`);
        const d = await res.json();
        return d.results || [];
      } catch (err2) { return []; }
    }
  }

  async function searchObservations(query, type = 'screen', taxon = null) {
    const q = (query || '').trim();
    if (!q && !taxon) return { results: [], total: 0 };

    if (type === 'screen') {
      const qLower = q.toLowerCase();
      const matches = [];
      for (const obs of activeObservations.values()) {
        const t = obs.taxon || {};
        const ru = (t.preferred_common_name || obs.species_guess || '').toLowerCase();
        const la = (t.name || '').toLowerCase();
        if ((qLower && (ru.includes(qLower) || la.includes(qLower))) || (taxon && t.id === taxon.id)) {
          matches.push(obs);
        }
      }
      return { results: matches, total: matches.length };
    } else {
      const center = map ? map.getCenter() : { lat: 55.75, lng: 37.62 };
      const params = new URLSearchParams({
        lat: center.lat.toFixed(4),
        lng: center.lng.toFixed(4),
        radius: '500',
        per_page: '100',
        order: 'desc',
        order_by: 'votes',
        locale: 'ru',
        preferred_place_id: '6986',
        fields: OBSERVATION_FIELDS_LIGHT
      });

      if (taxon) params.set('taxon_id', String(taxon.id));
      else params.set('q', q);

      if (config.taxa && config.taxa !== 'all' && !taxon) params.set('iconic_taxa', config.taxa);
      if (config.wildOnly) params.set('captive', 'false');

      try {
        let data = await inatGet('observations', params, null, 'v2');
        if (!data.results || data.results.length === 0) {
          params.delete('lat');
          params.delete('lng');
          params.delete('radius');
          data = await inatGet('observations', params, null, 'v2');
        }

        const validResults = [];
        (data.results || []).forEach(obs => {
          const ll = extractLatLng(obs);
          if (ll) {
            obs._lat = ll.lat;
            obs._lng = ll.lng;
            validResults.push(obs);
          }
        });
        return { results: validResults, total: data.total_results || validResults.length };
      } catch (e) {
        return { results: [], total: 0 };
      }
    }
  }

  // =========================================================================
  // НЕЙРОСЕТЕВЫЕ АРЕАЛЫ ОБИТАНИЯ (GEOMODEL TILES v2)
  // =========================================================================
  function updateGeomodelHUD() {
    let hud = document.getElementById('inat-geomodel-hud');
    if (!hud) return;

    if (!activeGeomodelTaxon || !map) {
      hud.hidden = true;
      return;
    }

    hud.hidden = false;
    const nameEl = document.getElementById('inat-geomodel-hud-name');
    const opacityVal = document.getElementById('inat-geomodel-opacity-val');
    const opacitySlider = document.getElementById('inat-geomodel-opacity-slider');
    const selLayer = document.getElementById('inat-geomodel-layer-select');

    const meta = getTaxonMeta(activeGeomodelTaxon);
    const ruName = activeGeomodelTaxon.preferred_common_name || activeGeomodelTaxon.name;
    const latinName = activeGeomodelTaxon.name || '';
    const modeInfo = GEOMODEL_MODES[geomodelType] || GEOMODEL_MODES.geomodel;

    if (nameEl) {
      nameEl.innerHTML = `
        <span style="color:${meta.color};">${meta.icon}</span> 
        <b>${escapeHtml(ruName)}</b> <i>(${escapeHtml(latinName)})</i>
        <small style="color:var(--accent); display:block; font-size:10px;">${modeInfo.title}</small>
      `;
    }

    if (selLayer) selLayer.value = geomodelType;
    if (opacityVal) opacityVal.textContent = Math.round(geomodelOpacity * 100) + '%';
    if (opacitySlider) opacitySlider.value = Math.round(geomodelOpacity * 100);
  }

  function showGeomodelForTaxon(taxon, type = 'geomodel') {
    if (!map || !taxon || !taxon.id) return;
    activeGeomodelTaxon = taxon;
    geomodelType = type;

    clearOverviewTileLayer(); // <-- Скрываем обзорную сетку/точки/heatmap

    if (geomodelTileLayer) {
      map.removeLayer(geomodelTileLayer);
      geomodelTileLayer = null;
    }

    const tileUrl = `https://api.inaturalist.org/v2/${geomodelType}/${taxon.id}/{z}/{x}/{y}.png`;
    const modeInfo = GEOMODEL_MODES[geomodelType] || GEOMODEL_MODES.geomodel;

    geomodelTileLayer = L.tileLayer(tileUrl, {
      maxZoom: 20,
      opacity: geomodelOpacity,
      pane: 'wm-base',
      zIndex: 425,
      attribution: `© iNaturalist ${modeInfo.title}`
    });

    geomodelTileLayer.addTo(map);
    updateGeomodelHUD();

    if (WM.ui && WM.ui.showToast) {
      const name = taxon.preferred_common_name || taxon.name;
      WM.ui.showToast(`${modeInfo.icon} Слой «${modeInfo.title}» загружен для ${name}`, 2400);
    }
  }

  function initGeomodelUI() {
    const hud = document.getElementById('inat-geomodel-hud');
    const closeBtn = document.getElementById('btn-inat-geomodel-close');
    const selLayer = document.getElementById('inat-geomodel-layer-select');
    const opacitySlider = document.getElementById('inat-geomodel-opacity-slider');
    const btnFindObs = document.getElementById('btn-inat-geomodel-find-obs');

    if (closeBtn) closeBtn.onclick = clearGeomodel;
    if (selLayer) {
      selLayer.onchange = (e) => {
        if (activeGeomodelTaxon) showGeomodelForTaxon(activeGeomodelTaxon, e.target.value);
      };
    }
    if (opacitySlider) {
      opacitySlider.oninput = (e) => setGeomodelOpacity(parseFloat(e.target.value) / 100);
    }
    if (btnFindObs) {
      btnFindObs.onclick = () => {
        if (activeGeomodelTaxon) {
          applyFilterToMap(activeGeomodelTaxon.preferred_common_name || activeGeomodelTaxon.name, activeGeomodelTaxon);
        }
      };
    }
  }

  function clearGeomodel() {
    if (geomodelTileLayer && map) {
      map.removeLayer(geomodelTileLayer);
      geomodelTileLayer = null;
    }
    activeGeomodelTaxon = null;
    updateGeomodelHUD();
    updateOverviewTileLayer(); // <-- Восстанавливаем фоновую сетку/точки
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('Слой ареала Geomodel отключён');
  }

  function toggleGeomodelMode() {
    if (!activeGeomodelTaxon) return;
    const nextType = geomodelType === 'geomodel' ? 'geomodel_comparison' : 'geomodel';
    showGeomodelForTaxon(activeGeomodelTaxon, nextType);
  }

  function setGeomodelOpacity(val) {
    geomodelOpacity = Math.max(0.1, Math.min(1.0, val));
    if (geomodelTileLayer) geomodelTileLayer.setOpacity(geomodelOpacity);
    updateGeomodelHUD();
  }



  // =========================================================================
  // ЭНДПОИНТ «УМНЫХ ПОДСКАЗОК» (/v2/taxa/suggest) — «ЧТО ИСКАТЬ ВОКРУГ?»
  // =========================================================================
  let isSuggestionsLoading = false;
  let activeSuggestCategory = 'all';

  const SUGGEST_PAGE_SIZE = 15;
  const SUGGEST_MIN_AI_SCORE = 0.04;

  let isAiForecastEnabled = localStorage.getItem('wm_inat_suggest_ai_on') === 'true';
  let suggestAiPool = [];        // Пул видов нейросети
  let suggestItems = [];         // Отображённые в данный момент элементы
  let suggestHasMore = true;
  let suggestIsLoadingMore = false;
  let suggestCoords = null;
  let suggestMonth = null;
  let suggestFallbackPage = 1;   // Страница пагинации реальных находок
  const suggestSeenTaxonIds = new Set();

  function openAndFocusTokenInput() {
    // 1. Закрываем модалку подсказок, если она была открыта
    if (typeof closeSmartSuggestionsModal === 'function') {
      closeSmartSuggestionsModal();
    }

    // 2. Открываем модальное окно основных настроек
    const modalSettings = document.getElementById('modal');
    if (modalSettings) modalSettings.classList.add('open');

    const tokenInput = document.getElementById('inat-token-input');
    if (!tokenInput) return;

    // 3. Рекурсивно раскрываем ВСЕ спойлеры <details>, в которые вложено поле ввода
    let parent = tokenInput.closest('details');
    while (parent) {
      parent.open = true;
      parent = parent.parentElement ? parent.parentElement.closest('details') : null;
    }

    // 4. Плавно прокручиваем к центру экрана и ставим курсор в инпут
    setTimeout(() => {
      tokenInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      tokenInput.focus();

      // Подсветка поля ввода зеленым импульсом на 1.5 секунды
      tokenInput.style.transition = 'box-shadow 0.3s ease, border-color 0.3s ease';
      tokenInput.style.borderColor = '#10b981';
      tokenInput.style.boxShadow = '0 0 0 4px rgba(16, 185, 129, 0.35)';
      setTimeout(() => {
        tokenInput.style.borderColor = '';
        tokenInput.style.boxShadow = '';
      }, 1500);
    }, 220);
  }

  function showSuggestNotice(text, isError = false, showAuthLink = false) {
    const noticeEl = document.getElementById('inat-suggest-ai-notice');
    if (!noticeEl) return;
    noticeEl.hidden = false;
    noticeEl.className = 'inat-suggest-ai-notice' + (isError ? ' is-error' : '');
    noticeEl.innerHTML = `
      <div class="inat-suggest-notice-text">${text}</div>
      ${showAuthLink ? '<button type="button" class="btn-link inat-suggest-notice-btn" id="btn-suggest-goto-token">🔑 Ввести токен в настройках ›</button>' : ''}
    `;

    document.getElementById('btn-suggest-goto-token')?.addEventListener('click', openAndFocusTokenInput);
  }

  function hideSuggestNotice() {
    const noticeEl = document.getElementById('inat-suggest-ai-notice');
    if (noticeEl) {
      noticeEl.hidden = true;
      noticeEl.innerHTML = '';
    }
  }

  function updateAiToggleButtonUI() {
    const btn = document.getElementById('btn-inat-suggest-toggle-ai');
    if (!btn) return;
    btn.classList.toggle('active', isAiForecastEnabled);
    btn.innerHTML = isAiForecastEnabled
      ? '<span>🤖 Прогноз нейросети: <b>ВКЛЮЧЁН</b></span>'
      : '<span>🤖 Включить прогноз от нейросети</span>';
  }

  async function fetchAiSuggestionsOnly(c, curMonth, iconic) {
    const params = new URLSearchParams({
      lat: c.lat.toFixed(5),
      lng: c.lng.toFixed(5),
      months: String(curMonth),
      source: 'observations',
      order_by: 'default',
      limit: '50',
      locale: 'ru',
      fields: '(score:!t,taxon:(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t,default_photo:(square_url:!t)))'
    });

    if (iconic && iconic !== 'all' && ICONIC_TAXON_IDS[iconic]) {
      params.set('taxon_id', String(ICONIC_TAXON_IDS[iconic]));
    }

    const data = await inatGet('taxa/suggest', params, null, 'v2');
    return (data.results || []).map(r => {
      r._source = 'ai';
      return r;
    });
  }

  async function activateAiForecast() {
    const tokenInfo = getTokenInfo();
    if (!tokenInfo.exists || tokenInfo.isExpired) {
      showSuggestNotice(
        '⚠️ Для работы прогноза нейросети iNaturalist требуется действующий API-токен (24 ч).',
        true,
        true
      );
      return;
    }

    hideSuggestNotice();
    const btn = document.getElementById('btn-inat-suggest-toggle-ai');
    if (btn) btn.classList.add('is-loading');

    try {
      const results = await fetchAiSuggestionsOnly(suggestCoords, suggestMonth, activeSuggestCategory);
      suggestAiPool = results.filter(r => (r.score || r.combined_score || 0) >= SUGGEST_MIN_AI_SCORE);

      if (!suggestAiPool.length) {
        showSuggestNotice('ℹ️ Нейросеть не сформировала прогнозов для этого биома и месяца.');
        return;
      }

      prependAiSuggestions(suggestAiPool);
      showSuggestNotice(`✅ Нейросеть добавила ${suggestAiPool.length} вероятных видов наверх выдачи`);
    } catch (err) {
      showSuggestNotice(
        '❌ Ошибка запроса к нейросети. Возможно, срок действия токена истёк или превышен лимит.',
        true,
        true
      );
    } finally {
      if (btn) btn.classList.remove('is-loading');
    }
  }

  function prependAiSuggestions(aiList) {
    const listEl = document.getElementById('inat-suggest-items-list');
    const countEl = document.getElementById('inat-suggest-count');
    if (!listEl) return;

    const validToAdd = [];
    for (const it of aiList) {
      const t = it.taxon || it;
      if (!t || !t.id || suggestSeenTaxonIds.has(t.id)) continue;
      suggestSeenTaxonIds.add(t.id);
      validToAdd.push(it);
    }

    if (!validToAdd.length) return;

    suggestItems.unshift(...validToAdd);

    const fragment = document.createDocumentFragment();
    validToAdd.forEach(it => {
      fragment.appendChild(createSuggestionCard(it));
    });

    listEl.insertBefore(fragment, listEl.firstChild);
    if (countEl) countEl.textContent = `${suggestItems.length}`;
  }

  function initSmartSuggestionsUI() {
    const modal = document.getElementById('modal-inat-suggest');
    const closeX = document.getElementById('inat-suggest-close-x');
    const closeBtn = document.getElementById('inat-suggest-close-btn');
    const btnRecenter = document.getElementById('btn-inat-suggest-recenter');
    const btnToggleAi = document.getElementById('btn-inat-suggest-toggle-ai');
    const listEl = document.getElementById('inat-suggest-items-list');

    if (closeX) closeX.onclick = closeSmartSuggestionsModal;
    if (closeBtn) closeBtn.onclick = closeSmartSuggestionsModal;
    if (modal) {
      modal.onclick = (e) => { if (e.target === modal) closeSmartSuggestionsModal(); };
    }

    if (btnRecenter) {
      btnRecenter.onclick = () => openSmartSuggestionsModal(activeSuggestCategory);
    }

    // Слушатель кнопки включения нейросети
    if (btnToggleAi) {
      btnToggleAi.onclick = async () => {
        isAiForecastEnabled = !isAiForecastEnabled;
        localStorage.setItem('wm_inat_suggest_ai_on', isAiForecastEnabled ? 'true' : 'false');
        updateAiToggleButtonUI();

        if (isAiForecastEnabled) {
          await activateAiForecast();
        } else {
          hideSuggestNotice();
          // Откатываемся к стандартной выдаче реальных находок
          openSmartSuggestionsModal(activeSuggestCategory);
        }
      };
    }

    // Слушатель бесконечного скролла
    if (listEl && !listEl._scrollBound) {
      listEl._scrollBound = true;
      listEl.addEventListener('scroll', () => {
        if (suggestIsLoadingMore || !suggestHasMore) return;
        if (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 90) {
          loadMoreSuggestions();
        }
      }, { passive: true });
    }

    // Переключение категорий организмов
    document.querySelectorAll('#inat-suggest-category-chips .inat-suggest-chip').forEach(btn => {
      btn.onclick = async () => {
        document.querySelectorAll('#inat-suggest-category-chips .inat-suggest-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSuggestCategory = btn.dataset.taxa;

        const list = document.getElementById('inat-suggest-items-list');
        if (list) {
          list.scrollTop = 0;
          list.innerHTML = '<div class="muted" style="padding: 24px 0;">⏳ Загрузка находок вокруг…</div>';
        }

        hideSuggestNotice();
        suggestFallbackPage = 1;
        suggestHasMore = true;

        const c = suggestCoords || ((WM.gpsState && WM.gpsState.lat) ? WM.gpsState : (map ? map.getCenter() : { lat: 55.75, lng: 37.62 }));
        const res = await fetchFallbackSpeciesCounts(c, suggestMonth, activeSuggestCategory, 1);
        suggestSourceType = 'fallback';
        renderSuggestionsList(res.results);

        if (isAiForecastEnabled) {
          await activateAiForecast();
        }
      };
    });
  }

  async function openSmartSuggestionsModal(category = 'all') {
    const modal = document.getElementById('modal-inat-suggest');
    if (!modal) return;

    activeSuggestCategory = category;
    document.querySelectorAll('#inat-suggest-category-chips .inat-suggest-chip').forEach(b => {
      b.classList.toggle('active', b.dataset.taxa === category);
    });

    const listEl = document.getElementById('inat-suggest-items-list');
    const subTitleEl = document.getElementById('inat-suggest-loc-sub');
    const monthEl = document.getElementById('inat-suggest-month-label');

    const c = (WM.gpsState && WM.gpsState.lat) ? WM.gpsState : (map ? map.getCenter() : { lat: 55.75, lng: 37.62 });
    const monthsRu = ['', 'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
    const curMonth = new Date().getMonth() + 1;

    suggestCoords = c;
    suggestMonth = curMonth;
    suggestFallbackPage = 1;
    suggestHasMore = true;

    if (subTitleEl) subTitleEl.textContent = `📍 ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
    if (monthEl) monthEl.textContent = `Сезон: в ${monthsRu[curMonth]}`;

    updateAiToggleButtonUI();
    hideSuggestNotice();

    if (listEl) {
      listEl.scrollTop = 0;
      listEl.innerHTML = '<div class="muted" style="padding: 24px 0;">📊 Загрузка реальных находок вокруг…</div>';
    }

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('inatSuggest');
    isSuggestionsLoading = true;

    try {
      // 1. ПО УМОЛЧАНИЮ ВСЕГДА ЗАГРУЖАЕМ РЕАЛЬНЫЕ НАХОДКИ ВОКРУГ
      const res = await fetchFallbackSpeciesCounts(c, curMonth, activeSuggestCategory, 1);
      suggestSourceType = 'fallback';
      renderSuggestionsList(res.results);

      // 2. ЕСЛИ ВКЛЮЧЕНА КНОПКА НЕЙРОСЕТИ — ПЛЮСУЕМ ЕЁ ВЫДАЧУ СВЕРХУ
      if (isAiForecastEnabled) {
        await activateAiForecast();
      }
    } catch (e) {
      if (listEl) listEl.innerHTML = `<div class="muted" style="color:var(--danger); padding:20px 0;">Ошибка загрузки находок: ${escapeHtml(e.message)}</div>`;
    } finally {
      isSuggestionsLoading = false;
    }
  }

  const ICONIC_TAXON_IDS = {
    Plantae: 47126,
    Fungi: 47170,
    Insecta: 47158,
    Aves: 3,
    Mammalia: 40151,
    Animalia: 1,
    Amphibia: 20978,
    Reptilia: 26036
  };

  async function fetchSmartSuggestions(coords = null, month = null, iconic = null) {
    const c = coords || (WM.gpsState && WM.gpsState.lat ? WM.gpsState : (map ? map.getCenter() : { lat: 55.75, lng: 37.62 }));
    const curMonth = month || (new Date().getMonth() + 1);

    const params = new URLSearchParams({
      lat: c.lat.toFixed(5),
      lng: c.lng.toFixed(5),
      months: String(curMonth),
      source: 'observations',
      order_by: 'default',
      limit: '50',
      locale: 'ru',
      fields: '(score:!t,taxon:(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t,default_photo:(square_url:!t)))'
    });

    if (iconic && iconic !== 'all' && ICONIC_TAXON_IDS[iconic]) {
      params.set('taxon_id', String(ICONIC_TAXON_IDS[iconic]));
    }

    try {
      const data = await inatGet('taxa/suggest', params, null, 'v2');
      const results = (data.results || []).map(r => {
        r._source = 'ai';
        return r;
      });
      return { results, source: 'ai', total: results.length };
    } catch (e) {
      console.warn('[iNat] Fallback to species_counts due to:', e);
      return await fetchFallbackSpeciesCounts(c, curMonth, iconic, 1);
    }
  }

  function createSuggestionCard(it) {
    const t = it.taxon || it;
    const meta = getTaxonMeta(t);

    // 1. Проверяем, есть ли уже полноценное русское имя (содержит кириллицу)
    const rawCommon = t.preferred_common_name;
    const isAlreadyRussian = rawCommon && /[а-яё]/i.test(rawCommon);

    let ruName = isAlreadyRussian 
      ? rawCommon 
      : (t.preferred_common_name || t.name || 'Неизвестный организм');

    const latinName = (t.name && t.name !== ruName) ? t.name : (t.name || '');
    const rank = RANKS_RU[t.rank] || t.rank || 'вид';
    const photoUrl = t.default_photo?.square_url || '';

    const isAi = it._source === 'ai';
    let scoreBadgeHtml = '';

    if (isAi) {
      const rawScore = it.score || it.combined_score || 0;
      const scorePct = typeof rawScore === 'number' && rawScore <= 1 
        ? Math.round(rawScore * 100) 
        : Math.min(100, Math.round(rawScore));
      if (scorePct > 0) {
        scoreBadgeHtml = `
          <span class="inat-suggest-score-badge ai" title="🤖 Прогноз нейросети Geo-Prior по климату и сезону (вероятность ${scorePct}%)">
            🤖 ${scorePct}%
          </span>`;
      }
    } else {
      const count = it.count || it.score || 0;
      if (count > 0) {
        scoreBadgeHtml = `
          <span class="inat-suggest-score-badge fallback" title="📊 Реальные находки вокруг (база данных iNat: ${count} шт.)">
            📊 ${count} шт.
          </span>`;
      }
    }

    const subLine = latinName ? `${escapeHtml(latinName)} · ${escapeHtml(rank)}` : escapeHtml(rank);

    const card = document.createElement('div');
    card.className = 'inat-suggest-card';
    card.style.borderLeftColor = meta.color;

    card.innerHTML = `
      ${photoUrl ? `<img src="${photoUrl}" class="inat-suggest-thumb" alt="" loading="lazy">` : `<span class="inat-suggest-icon-ph">${meta.icon}</span>`}
      <div class="inat-suggest-info">
        <div class="inat-suggest-title-row">
          <span class="inat-suggest-ru">${escapeHtml(ruName)}</span>
          ${scoreBadgeHtml}
        </div>
        <span class="inat-suggest-la">${subLine}</span>
        <div class="inat-suggest-actions">
          <button type="button" class="inat-suggest-btn btn-show-map">👁️ Искать на карте</button>
          <button type="button" class="inat-suggest-btn btn-show-geomodel" style="color:#0284c7; border-color:#0284c7;">🧠 Ареал (AI)</button>
          <a href="https://www.inaturalist.org/taxa/${t.id}" target="_blank" rel="noopener noreferrer" class="inat-suggest-btn">↗ iNat</a>
        </div>
      </div>
    `;

    card.querySelector('.btn-show-map')?.addEventListener('click', () => {
      closeSmartSuggestionsModal();
      applyFilterToMap(card.querySelector('.inat-suggest-ru')?.textContent || ruName, t);
    });

    card.querySelector('.btn-show-geomodel')?.addEventListener('click', () => {
      closeSmartSuggestionsModal();
      showGeomodelForTaxon(t);
    });

    // 2. Если заголовок остался на латыни — асинхронно запрашиваем русский перевод из Википедии
    if (!isAlreadyRussian && t.name) {
      const ruEl = card.querySelector('.inat-suggest-ru');
      const laEl = card.querySelector('.inat-suggest-la');
      resolveRussianTaxonName(t.name, (resolvedRu) => {
        if (ruEl && resolvedRu) {
          ruEl.textContent = resolvedRu;
          if (laEl) laEl.textContent = `${t.name} · ${escapeHtml(rank)}`;
        }
      });
    }

    return card;
  }

  function updateSuggestHeaderNotice() {
    const hintEl = document.getElementById('inat-suggest-source-hint') || 
                   document.querySelector('.inat-suggest-count-row .hint-text');
    if (!hintEl) return;
    if (suggestSourceType === 'ai') {
      hintEl.innerHTML = '🤖 Оценка нейросети Geo-Prior и сезонности iNat v2';
      hintEl.style.color = '#10b981';
    } else {
      hintEl.innerHTML = '📊 Частота реальных находок вокруг (фоллбэк базы iNat)';
      hintEl.style.color = '#0284c7';
    }
  }

   // Запрос реальных находок с сервера с поддержкой пагинации (page)
  async function fetchFallbackSpeciesCounts(c, curMonth, iconic, page = 1) {
    try {
      const fbParams = new URLSearchParams({
        lat: c.lat.toFixed(4),
        lng: c.lng.toFixed(4),
        radius: '60',
        month: String(curMonth),
        page: String(page),
        per_page: String(SUGGEST_PAGE_SIZE),
        locale: 'ru',
        fields: '(taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,rank:!t,default_photo:(square_url:!t)),count:!t)'
      });
      if (iconic && iconic !== 'all') fbParams.set('iconic_taxa', iconic);

      const fbData = await inatGet('observations/species_counts', fbParams, null, 'v2');
      const results = (fbData.results || []).map(r => ({
        taxon: r.taxon,
        score: r.count,
        count: r.count,
        _source: 'fallback'
      }));
      return { results, source: 'fallback', total: fbData.total_results || results.length };
    } catch (err) {
      return { results: [], source: 'fallback', total: 0 };
    }
  }

  function appendSuggestionsChunk(chunk) {
    const listEl = document.getElementById('inat-suggest-items-list');
    const countEl = document.getElementById('inat-suggest-count');
    if (!listEl) return;

    const validToAdd = [];
    for (const it of chunk) {
      const t = it.taxon || it;
      if (!t || !t.id || suggestSeenTaxonIds.has(t.id)) continue;

      if (it._source === 'ai') {
        const rawScore = it.score || it.combined_score || 0;
        if (rawScore < SUGGEST_MIN_AI_SCORE) continue;
      }

      suggestSeenTaxonIds.add(t.id);
      validToAdd.push(it);
      suggestItems.push(it);
    }

    const fragment = document.createDocumentFragment();
    validToAdd.forEach(it => {
      fragment.appendChild(createSuggestionCard(it));
    });
    listEl.appendChild(fragment);

    if (countEl) countEl.textContent = `${suggestItems.length}`;
    updateSuggestEndNotice(listEl);
  }

  function renderSuggestionsList(items) {
    const listEl = document.getElementById('inat-suggest-items-list');
    const countEl = document.getElementById('inat-suggest-count');
    if (!listEl) return;

    listEl.innerHTML = '';
    suggestItems = [];
    suggestSeenTaxonIds.clear();
    suggestAllPool = items || [];
    suggestFallbackPage = 1;
    suggestHasMore = true;

    updateSuggestHeaderNotice();

    if (!suggestAllPool.length) {
      listEl.innerHTML = '<div class="muted" style="padding: 24px 0;">Для выбранной категории в текущей локации подсказок не найдено.</div>';
      if (countEl) countEl.textContent = '0';
      return;
    }

    // Выводим только первую порцию (15 шт.)
    const initialChunk = suggestAllPool.slice(0, SUGGEST_PAGE_SIZE);
    appendSuggestionsChunk(initialChunk);
  }

  async function loadMoreSuggestions() {
    if (suggestIsLoadingMore || !suggestHasMore) return;
    const listEl = document.getElementById('inat-suggest-items-list');
    if (!listEl) return;

    suggestIsLoadingMore = true;

    const loaderEl = document.createElement('div');
    loaderEl.id = 'inat-suggest-loading-more-pill';
    loaderEl.className = 'inat-suggest-loading-more';
    loaderEl.textContent = '⏳ Загрузка других видов…';
    listEl.appendChild(loaderEl);

    try {
      const currentCount = suggestItems.length;

      // 1. Если в пуле нейросети ещё остались неотображённые виды — берём их порцией
      if (currentCount < suggestAllPool.length) {
        await new Promise(r => setTimeout(r, 200)); // небольшая пауза для плавности UI
        loaderEl.remove();
        const nextChunk = suggestAllPool.slice(currentCount, currentCount + SUGGEST_PAGE_SIZE);
        appendSuggestionsChunk(nextChunk);
      } 
      // 2. Виды нейросети закончились — догружаем реальные наблюдения вокруг через species_counts
      else {
        suggestFallbackPage++;
        const res = await fetchFallbackSpeciesCounts(
          suggestCoords, 
          suggestMonth, 
          activeSuggestCategory, 
          suggestFallbackPage
        );

        loaderEl.remove();

        if (!res.results || res.results.length === 0) {
          suggestHasMore = false;
          updateSuggestEndNotice(listEl);
        } else {
          appendSuggestionsChunk(res.results);
          if (res.results.length < SUGGEST_PAGE_SIZE) {
            suggestHasMore = false;
            updateSuggestEndNotice(listEl);
          }
        }
      }
    } catch (e) {
      loaderEl.remove();
      suggestHasMore = false;
    } finally {
      suggestIsLoadingMore = false;
    }
  }

  function updateSuggestEndNotice(listEl) {
    const oldNotice = listEl.querySelector('.inat-suggest-end-notice');
    if (oldNotice) oldNotice.remove();

    if (!suggestHasMore && suggestItems.length > 0) {
      const endNotice = document.createElement('div');
      endNotice.className = 'inat-suggest-end-notice';
      endNotice.textContent = `✓ Показаны все наиболее вероятные виды (${suggestItems.length} шт.)`;
      listEl.appendChild(endNotice);
    }
  }

  

  

  function closeSmartSuggestionsModal(syncHistory = true) {
    const modal = document.getElementById('modal-inat-suggest');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('inatSuggest');
    }
  }

  // =========================================================================
  // ФИЛЬТРАЦИЯ НА КАРТЕ
  // =========================================================================
  async function applyFilterToMap(customQuery = null, customTaxon = null) {
    if (customTaxon !== null && customTaxon !== undefined) selectedTaxon = customTaxon;
    const input = document.getElementById('inat-filter-query');
    const q = customQuery !== null ? customQuery : (input ? input.value.trim() : '');

    if (!q && !selectedTaxon) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Введите название растения или выберите вид');
      return;
    }

    if (!config.enabled) enable();

    const center = map.getCenter();
    map.setView(center, Math.max(map.getZoom(), 9), { animate: false });

    const filterTitle = selectedTaxon ? (selectedTaxon.preferred_common_name || selectedTaxon.name) : (q || 'Фильтр');
    activeMapFilter = {
      query: filterTitle,
      taxonId: selectedTaxon ? selectedTaxon.id : null,
      results: []
    };
    announceFilter = true;
    resetCache(getQueryKey());

    updateTopBadge();
    document.getElementById('modal')?.classList.remove('open');
    document.getElementById('modal-search')?.classList.remove('open');

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`🌿 Поиск «${filterTitle}» (v2 API)…`, 1800);
    }
    scheduleFetch(true, 0);
  }

  function clearMapFilter() {
    activeMapFilter = null;
    selectedTaxon = null;
    announceFilter = false;
    resetCache(getQueryKey());
    updateTopBadge();
    scheduleFetch(true, 0);
    if (WM.ui && WM.ui.showToast) WM.ui.showToast('🌿 Фильтр снят: показаны все наблюдения');
  }

  // =========================================================================
  // ИНИЦИАЛИЗАЦИЯ И СЛУШАТЕЛИ
  // =========================================================================
  function init(m, l) {
    map = m;
    layer = l;

    map.on('moveend', onViewChanged);
    map.on('move', scheduleCrosshairCheck);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && config.enabled) scheduleFetch(false, 300);
    });

    document.addEventListener('play', (e) => {
      if (e.target && e.target.tagName === 'AUDIO') {
        document.querySelectorAll('audio').forEach(audio => {
          if (audio !== e.target && !audio.paused) {
            audio.pause();
            audio.currentTime = 0; // Сбрасывает на начало (или удалите эту строку, если хотите ставить на паузу без сброса)
          }
        });
      }
    }, true); // КЛЮЧЕВОЙ МОМЕНТ: true (useCapture) обязателен, так как событие 'play' не всплывает

    initGeomodelUI();
    initSmartSuggestionsUI();
    initListModal(); // <-- ДОБАВИТЬ ЭТУ СТРОКУ

    document.getElementById('inat-count-badge-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearMapFilter();
    });

    document.getElementById('inat-count-badge-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      runFetch(true);
    });

    document.getElementById('inat-count-badge')?.addEventListener('click', (e) => {
      if (e.target.closest('#inat-count-badge-clear, #inat-count-badge-refresh')) return;
      openListModal();
    });

    const isLayerSaved = localStorage.getItem('wm_overlay_inat') === 'true';
    if (isLayerSaved || config.enabled) enable();
    if (config.enabled) scheduleFetch(false, 0);
  }

  function enable() {
    config.enabled = true;
    saveConfig();
    syncSettingsInputs();
    if (layer && map && !map.hasLayer(layer)) layer.addTo(map);
    scheduleFetch(false, 0);
    updateTopBadge();
    updateOverviewTileLayer();
  }

  function disable() {
    config.enabled = false;
    saveConfig();
    syncSettingsInputs();
    clearTimeout(fetchTimer);
    resetCache(null);
    clearAccuracyCircle();
    clearGeomodel();
    closeListModal();
    updateTopBadge();
    clearOverviewTileLayer();
  }

  function setConfig(newCfg) {
    config = { ...config, ...newCfg };
    saveConfig();
    syncSettingsInputs();
    updateOverviewTileLayer();

    if (newCfg.taxa !== undefined) activeMapFilter = null;
    if (!config.enabled) { disable(); return; }
    if (layer && map && !map.hasLayer(layer)) layer.addTo(map);

    // При смене режима отображения карточек — сбрасываем раскрытые вручную и мгновенно перерисовываем
    if (newCfg.badgeDisplayMode !== undefined) {
      manualExpandedClusters.clear();
      const newDisplayMode = newCfg.badgeDisplayMode;
      for (const m of markerInstances.values()) {
        if (m._wmCluster && m._wmMode) {
          m._wmDisplayMode = newDisplayMode;
          m.setIcon(buildClusterMarkerIcon(m._wmCluster, m._wmMode));
          m._wmBind();
        }
      }
      renderVisible();
    }

    scheduleFetch(false, 250);
    updateTopBadge();
  }

  function syncSettingsInputs() {
    const chkLayer = document.getElementById('toggle-inat-layer-enable');
    if (chkLayer) chkLayer.checked = !!config.enabled;
    const chkBadge = document.getElementById('toggle-inat-show-badge');
    if (chkBadge) chkBadge.checked = config.showBadge !== false;
    const selTaxa = document.getElementById('inat-filter-taxa');
    if (selTaxa) selTaxa.value = config.taxa || 'Plantae,Fungi';
    const selSeason = document.getElementById('inat-filter-season');
    if (selSeason) selSeason.value = config.season || 'any';
    const selZoomOut = document.getElementById('inat-zoom-out-mode');
    if (selZoomOut) selZoomOut.value = config.zoomOutMode || 'grid';
    const selMonth = document.getElementById('inat-filter-month');
    if (selMonth) selMonth.value = config.month || 'any';
    const selQuality = document.getElementById('inat-filter-quality');
    if (selQuality) selQuality.value = config.quality || 'any';
    const selSort = document.getElementById('inat-filter-sort');
    if (selSort) selSort.value = config.sort || 'random';
    const chkWild = document.getElementById('toggle-inat-wild');
    if (chkWild) chkWild.checked = config.wildOnly !== false;
    const chkNative = document.getElementById('toggle-inat-native');
    if (chkNative) chkNative.checked = !!config.nativeOnly;
    const chkThreatened = document.getElementById('toggle-inat-threatened');
    if (chkThreatened) chkThreatened.checked = !!config.threatenedOnly;
    const chkPhotos = document.getElementById('toggle-inat-photos');
    if (chkPhotos) chkPhotos.checked = config.photosOnly !== false;

    const selBadgeMode = document.getElementById('inat-badge-display-mode');
    if (selBadgeMode) selBadgeMode.value = config.badgeDisplayMode || 'full';

    const selSelectMode = document.getElementById('inat-select-mode');
    if (selSelectMode) selSelectMode.value = config.selectMode || 'crosshair';

    // Биологические стадии
    const selPheno = document.getElementById('inat-filter-phenology');
    if (selPheno) selPheno.value = config.phenology || 'any';

    const selInsects = document.getElementById('inat-filter-lifestage-insects');
    if (selInsects) selInsects.value = config.lifestageInsects || 'any';

    const selAnimals = document.getElementById('inat-filter-lifestage-animals');
    if (selAnimals) selAnimals.value = config.lifestageAnimals || 'any';

    // Адаптивное переключение видимости блоков биологических стадий
    updateAdaptiveTraitsUI(config.taxa);

    const sliderLimit = document.getElementById('inat-filter-limit');
    const valLimit = document.getElementById('inat-filter-limit-val');
    if (sliderLimit && valLimit && document.activeElement !== sliderLimit) {
      sliderLimit.value = config.limit || 100;
      valLimit.textContent = sliderLimit.value;
    }
    syncTokenUI();
    updateTopBadge();
  }

  function updateAdaptiveTraitsUI(taxaValue) {
    const card = document.getElementById('inat-dynamic-traits-card');
    const secPlants = document.getElementById('inat-trait-plants');
    const secInsects = document.getElementById('inat-trait-insects');
    const secAnimals = document.getElementById('inat-trait-animals');
    const secFungiNote = document.getElementById('inat-trait-fungi-note');
    if (!card) return;

    const t = taxaValue || 'Plantae,Fungi';

    if (secPlants) secPlants.hidden = true;
    if (secInsects) secInsects.hidden = true;
    if (secAnimals) secAnimals.hidden = true;
    if (secFungiNote) secFungiNote.hidden = true;

    if (t.includes('Plantae')) {
      card.hidden = false;
      if (secPlants) secPlants.hidden = false;
    } else if (t === 'Insecta') {
      card.hidden = false;
      if (secInsects) secInsects.hidden = false;
    } else if (t === 'Aves' || t === 'Mammalia' || t === 'Amphibia,Reptilia') {
      card.hidden = false;
      if (secAnimals) secAnimals.hidden = false;
    } else if (t === 'Fungi') {
      card.hidden = false;
      if (secFungiNote) secFungiNote.hidden = false;
    } else {
      // Для 'all' прячем блок, так как критерии универсально не применимы
      card.hidden = true;
    }
  }


  function setSearchType(type) { searchType = type; }

  function triggerSearchInput(val) {
    clearTimeout(searchDebounceTimer);
    clearTimeout(autocompleteDebounceTimer);

    if (selectedTaxon && val.trim() !== (selectedTaxon.preferred_common_name || selectedTaxon.name)) {
      selectedTaxon = null;
    }

    autocompleteDebounceTimer = setTimeout(() => {
      fetchTaxaAutocomplete(val).then(renderTaxaAutocomplete);
    }, 180);
  }

  async function executeSettingsSearch() {
    const input = document.getElementById('inat-filter-query');
    const wrapResults = document.getElementById('inat-search-results-wrap');
    const listResults = document.getElementById('inat-search-results-list');
    const countLabel = document.getElementById('inat-search-count-label');
    const btnApply = document.getElementById('btn-inat-filter-apply-map');

    const q = (input ? input.value : '').trim();
    if (!q && !selectedTaxon) {
      if (wrapResults) wrapResults.hidden = true;
      return;
    }

    if (wrapResults) wrapResults.hidden = false;
    if (listResults) listResults.innerHTML = '<div class="muted" style="padding: 12px 0;">⏳ Поиск наблюдений…</div>';
    if (countLabel) countLabel.textContent = 'Поиск…';

    try {
      const data = await searchObservations(q, searchType, selectedTaxon);
      const items = data.results || [];

      if (!items.length) {
        if (listResults) listResults.innerHTML = '<div class="muted" style="padding: 12px 0;">Наблюдений не найдено. Попробуйте сменить режим на «Общий».</div>';
        if (countLabel) countLabel.textContent = 'Найдено: 0';
        if (btnApply) btnApply.hidden = true;
        return;
      }

      if (countLabel) countLabel.textContent = `Найдено: ${items.length} (всего ${data.total || items.length})`;
      if (btnApply) btnApply.hidden = false;
      if (listResults) listResults.innerHTML = '';

      items.slice(0, 30).forEach(obs => {
        const taxon = obs.taxon || {};
        const meta = getTaxonMeta(taxon);
        const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
        const latinName = taxon.name || '';
        const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
        const dateStr = obs.observed_on || (obs.created_at ? obs.created_at.slice(0, 10) : '');

        const itemEl = document.createElement('div');
        itemEl.className = 'inat-search-item';
        itemEl.style.borderLeft = `3.5px solid ${meta.color}`;
        itemEl.innerHTML = `
          ${photoUrl ? `<img src="${photoUrl}" class="inat-search-thumb" alt="">` : `<span class="inat-search-icon">${meta.icon}</span>`}
          <div class="inat-search-meta">
            <span class="inat-search-ru">${escapeHtml(ruName)}</span>
            <span class="inat-search-la">${escapeHtml(latinName)} · ${meta.name}</span>
            ${dateStr ? `<span class="inat-search-extra">📅 ${dateStr}</span>` : ''}
          </div>
          <span class="inat-search-goto-btn" title="Перейти к точке на карте">🎯</span>
        `;

        itemEl.onclick = () => {
          document.getElementById('modal')?.classList.remove('open');
          if (obs._lat != null && obs._lng != null && map) {
            map.flyTo([obs._lat, obs._lng], Math.max(map.getZoom(), 16), { animate: true });
            highlightObservationZone(obs);
            setTimeout(() => openObservationCard(obs), 350);
          }
        };

        listResults.appendChild(itemEl);
      });
    } catch (err) {
      if (listResults) listResults.innerHTML = `<div class="muted" style="color:var(--danger);">Ошибка: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderTaxaAutocomplete(taxa) {
    const wrap = document.getElementById('inat-autocomplete-wrap');
    const list = document.getElementById('inat-autocomplete-list');
    if (!wrap || !list) return;

    list.innerHTML = '';
    if (!taxa || !taxa.length) {
      wrap.hidden = true;
      return;
    }

    taxa.forEach(t => {
      const icon = getTaxonIcon(t);
      const meta = getTaxonMeta(t);
      const ruName = t.preferred_common_name || t.name;
      const latinName = t.name || '';
      const rank = RANKS_RU[t.rank] || t.rank || '';
      const photoUrl = t.default_photo?.square_url || '';

      const item = document.createElement('div');
      item.className = 'inat-autocomplete-item';
      item.innerHTML = `
        ${photoUrl ? `<img src="${photoUrl}" class="inat-ac-thumb" alt="">` : `<span class="inat-ac-icon">${icon}</span>`}
        <div class="inat-ac-meta">
          <span class="inat-ac-ru">${escapeHtml(ruName)}</span>
          <span class="inat-ac-la">${escapeHtml(latinName)}</span>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <span class="inat-ac-category" style="color: ${meta.color};">${meta.name}</span>
          ${rank ? `<span class="inat-ac-badge">${escapeHtml(rank)}</span>` : ''}
        </div>
      `;

      item.onclick = (e) => {
        e.stopPropagation();
        selectedTaxon = t;
        const input = document.getElementById('inat-filter-query');
        if (input) {
          input.value = ruName;
          document.getElementById('inat-filter-query-clear')?.removeAttribute('hidden');
        }
        wrap.hidden = true;
        // Запуск поиска наблюдений выбранного таксона
        executeSettingsSearch();
      };
      list.appendChild(item);
    });
    wrap.hidden = false;
  }

  function initListModal() {
    const modal = document.getElementById('modal-inat-list');
    const closeBtn = document.getElementById('inat-list-x');
    const input = document.getElementById('inat-list-search-input');
    const clearBtn = document.getElementById('inat-list-search-clear-btn');
    if (!modal || modal._inited) return;
    modal._inited = true;

    // 1. Закрытие по крестику
    if (closeBtn) closeBtn.onclick = closeListModal;

    // 2. Закрытие по клику в пустоту (фон оверлея)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeListModal();
    });

    // 3. Поиск по списку объектов в окне
    if (input) {
      input.addEventListener('input', () => {
        lastInatSearchQuery = input.value;
        if (clearBtn) clearBtn.hidden = !input.value;
        renderInatList(lastInatSearchQuery);
      });
    }

    // 4. Очистка поиска
    if (clearBtn) {
      clearBtn.onclick = () => {
        input.value = '';
        lastInatSearchQuery = '';
        clearBtn.hidden = true;
        renderInatList('');
        input.focus();
      };
    }
  }

  function openListModal() {
    initListModal(); // <-- гарантирует регистрацию слушателей
    const modal = document.getElementById('modal-inat-list');
    const input = document.getElementById('inat-list-search-input');
    const clearBtn = document.getElementById('inat-list-search-clear-btn');
    if (!modal) return;

    lastInatSearchQuery = '';
    if (input) input.value = '';
    if (clearBtn) clearBtn.hidden = true;

    inatSnapshotList = activeMapFilter ? activeMapFilter.results : Array.from(activeObservations.values());
    renderInatList('');
    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('inatList');
    if (input) setTimeout(() => input.focus(), 120);
  }

  function closeListModal(syncHistory = true) {
    const modal = document.getElementById('modal-inat-list');
    if (modal) modal.classList.remove('open');
    inatSnapshotList = null;
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) {
      WM.ui.clearHistoryState('inatList');
    }
  }

  function renderInatList(filterText = '') {
    const listEl = document.getElementById('inat-list-items');
    const countEl = document.getElementById('inat-list-count');
    if (!listEl) return;
    listEl.innerHTML = '';

    const allObs = inatSnapshotList || (activeMapFilter ? activeMapFilter.results : Array.from(activeObservations.values()));
    const q = (filterText || '').trim().toLowerCase();

    const mapCenter = map ? map.getCenter() : null;
    allObs.forEach(obs => {
      if (mapCenter && obs._lat != null && obs._lng != null) {
        obs._distMeters = map.distance(mapCenter, [obs._lat, obs._lng]);
      }
    });

    let list = allObs;
    if (q) {
      list = allObs.filter(obs => {
        const taxon = obs.taxon || {};
        const ru = (taxon.preferred_common_name || obs.species_guess || '').toLowerCase();
        const la = (taxon.name || '').toLowerCase();
        const id = String(obs.id);
        return ru.includes(q) || la.includes(q) || id.includes(q);
      });
    }

    if (countEl) countEl.textContent = q ? `${list.length}/${allObs.length}` : `${allObs.length}`;
    if (!allObs.length) {
      listEl.innerHTML = '<div class="muted" style="width: 100%; padding: 24px 8px;">Наблюдений в видимой области не найдено.</div>';
      return;
    }

    list.sort((a, b) => (a._distMeters || 0) - (b._distMeters || 0));

    list.forEach(obs => {
      const taxon = obs.taxon || {};
      const meta = getTaxonMeta(taxon);
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const isResearch = obs.quality_grade === 'research';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'inat-tag-chip';
      chip.style.borderLeft = `4px solid ${meta.color}`;
      chip.innerHTML = `
        <span class="inat-tag-chip-icon">${meta.icon}</span>
        <span class="inat-tag-chip-ru">${escapeHtml(ruName)}</span>
        ${latinName && latinName !== ruName ? `<span class="inat-tag-chip-la">${escapeHtml(latinName)}</span>` : ''}
        ${isResearch ? '<span class="inat-chip-stat rg">✓ RG</span>' : ''}
      `;

      chip.onclick = () => {
        closeListModal();
        if (obs._lat != null && obs._lng != null && map) {
          map.flyTo([obs._lat, obs._lng], Math.max(map.getZoom(), 16), { animate: true });
          highlightObservationZone(obs);
          setTimeout(() => openObservationCard(obs), 350);
        }
      };
      listEl.appendChild(chip);
    });
  }

  WM.inat = {
    init,
    renderVisible, // <-- Добавьте эту строчку
    initVisionUI,
    enable,
    disable,
    setConfig,
    getConfig: () => config,
    refresh: () => runFetch(true),
    syncSettingsInputs,
    clearAccuracyCircle,
    clearHoverHighlight,
    closeModal,
    setToken,
    removeToken,
    getToken,
    setSearchType,
    triggerSearchInput,
    applyFilterToMap,
    clearMapFilter,
    checkCrosshairProximity,
    openListModal,
    closeListModal,
    openObservationCard,
    filterByTaxon,
    fetchTaxaAutocomplete,
    searchObservations,
    openQuickHubModal,
    closeQuickHubModal,
    updateQuickHubTokenNotice,
    getTaxonMeta,
    getTaxonIcon,
    highlightObservationZone,
    closeClusterModal,
    openClusterModal,
    getSelectMode: () => config.selectMode || 'crosshair',
    isCrosshairSelectable,
    openHovered,

    downloadTraitsDebug: downloadTraitsDebugJson,
    getLastTraitsDebug: () => lastTraitsDebugData,

    downloadTraitsDebug: downloadTraitsDebugJson,
    getLastTraitsDebug: () => lastTraitsDebugData,

    downloadPlantTraitsDebug: downloadPlantTraitsDebugJson,
    getLastPlantTraitsDebug: () => lastPlantTraitsDebugData,

    downloadFungiTraitsDebug: downloadFungiTraitsDebugJson,
    getLastFungiTraitsDebug: () => lastFungiTraitsDebugData,

    // Новые возможности v2 API:
    showGeomodelForTaxon,
    clearGeomodel,
    getActiveGeomodelTaxon: () => activeGeomodelTaxon,
    fetchSmartSuggestions,
    openSmartSuggestionsModal,
    closeSmartSuggestionsModal,
    fetchTaxonMapLayers,
    fetchSimilarSpecies,
    fetchSeasonalityHistogram,
    retrySeasonality: (taxonId) => {
      const el = document.getElementById('inat-seasonality-container');
      if (el) el.innerHTML = '<div class="muted inat-card-loading-sub">⏳ Загрузка фенологического календаря…</div>';
      fetchSeasonalityHistogram(taxonId, true).then(moy => {
        if (el) el.innerHTML = renderSeasonalityChart(moy, taxonId);
      });
    }
  };
})();
