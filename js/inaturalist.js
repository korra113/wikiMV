(function () {
  const WM = window.WM = window.WM || {};

  const DEFAULT_CONFIG = {
    enabled: false,
    showBadge: true,
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

  function setToken(token) {
    if (token && token.trim()) {
      localStorage.setItem('wm_inat_key', token.trim());
    } else {
      localStorage.removeItem('wm_inat_key');
    }
    syncTokenUI();
    updateVisionTokenNotice();
  }

  function removeToken() {
    localStorage.removeItem('wm_inat_key');
    syncTokenUI();
    updateVisionTokenNotice();
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
      const headers = { 'Accept': 'application/json' };
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

    // СТАБИЛЬНАЯ СОРТИРОВКА:
    // Точки обходятся не по удалению от центра экрана, а по постоянному рангу
    // (качество -> наличие фото -> стабильный id). Ядра кластеров будут всегда одними и теми же!
    const sortedObs = [...visibleObs].sort((a, b) => {
      const scoreA = (a.quality_grade === 'research' ? 4 : 0) + (a.photos?.length ? 2 : 0);
      const scoreB = (b.quality_grade === 'research' ? 4 : 0) + (b.photos?.length ? 2 : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.id - a.id;
    });

    const points = sortedObs.map(obs => ({
      obs,
      pt: map.latLngToContainerPoint([obs._lat, obs._lng]),
      clustered: false
    }));

    const clusters = [];
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      if (p1.clustered) continue;
      p1.clustered = true;

      const clusterItems = [p1.obs];

      for (let j = i + 1; j < points.length; j++) {
        const p2 = points[j];
        if (p2.clustered) continue;

        const dx = p1.pt.x - p2.pt.x;
        // Мягкий вертикальный коэффициент (плашки шире, чем выше)
        const dy = (p1.pt.y - p2.pt.y) * 1.15;
        let distSq = dx * dx + dy * dy;

        // Облегчаем объединение организмов одного вида
        const sameTaxon = (p1.obs.taxon && p2.obs.taxon && p1.obs.taxon.id === p2.obs.taxon.id);
        if (sameTaxon) distSq *= 0.82;

        if (distSq <= radiusSq) {
          p2.clustered = true;
          clusterItems.push(p2.obs);
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
      if (isSingle) {
        const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
        const latinName = taxon.name || '';
        const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
        const html = `
          <div class="wm-inat-pin-anchor" data-id="${cluster.id}" style="--inat-color: ${color};">
            <div class="wm-inat-bubble ${isResearch ? 'research' : ''}">
              <div class="wm-inat-badge-card">
                <div class="wm-inat-thumb-wrap">
                  ${photoUrl ? `<img src="${photoUrl}" class="wm-inat-img" alt="" loading="lazy">` : `<span class="wm-inat-badge-icon">${icon}</span>`}
                  ${photoUrl ? `<span class="wm-inat-corner-emoji" title="${meta.name}">${icon}</span>` : ''}
                </div>
                <div class="wm-inat-badge-texts">
                  <span class="wm-inat-badge-ru">${escapeHtml(ruName)}</span>
                  <span class="wm-inat-badge-la">${escapeHtml(latinName)}</span>
                </div>
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
            <div class="wm-inat-badge-card wm-inat-cluster-card">
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

    let downPos = null;
    let hasMoved = false;

    const onDown = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      downPos = { x: pt.clientX, y: pt.clientY };
      hasMoved = false;
    };

    const onMove = (e) => {
      if (!downPos) return;
      const pt = e.touches ? e.touches[0] : e;
      if (Math.hypot(pt.x - downPos.x, pt.y - downPos.y) > 7) {
        hasMoved = true;
      }
    };

    const handler = (e) => {
      // Если было перемещение мыши (навигация/перетаскивание карты) — отменяем клик
      if (hasMoved || (map && map.dragging && map.dragging.moving())) {
        downPos = null;
        hasMoved = false;
        return;
      }
      downPos = null;

      if (e) {
        L.DomEvent.stopPropagation(e);
        if (e.preventDefault) e.preventDefault();
      }
      const now = Date.now();
      if (marker._lastClick && now - marker._lastClick < 400) return;
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
        el.removeEventListener('mousedown', onDown);
        el.removeEventListener('mousemove', onMove);
        el.removeEventListener('touchstart', onDown);
        el.removeEventListener('touchmove', onMove);
        el.onclick = null;

        el.addEventListener('mousedown', onDown, { passive: true });
        el.addEventListener('mousemove', onMove, { passive: true });
        el.addEventListener('touchstart', onDown, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: true });
        el.onclick = handler;
      }
    };

    marker.on('click', handler);
    marker.addTo(layer);
    marker._wmMode = mode;
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
      p.set('month', config.month);
    } else {
      const m = getMonthsForSeason(config.season);
      if (m) p.set('month', m);
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
    const view = map.getBounds().pad(0.28);
    const baseLimit = config.limit || 100;
    const cap = activeMapFilter ? Math.max(120, baseLimit) : Math.max(10, baseLimit);

    const visible = [];
    for (const obs of obsCache.values()) {
      if (view.contains([obs._lat, obs._lng])) {
        visible.push(obs);
      }
    }

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
        if (m._wmMode !== mode || m._wmCount !== cluster.count) {
          m.setIcon(buildClusterMarkerIcon(cluster, mode));
          m._wmMode = mode;
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
    if (hoveredObsId === obs.id) return;
    hoveredObsId = obs.id;
    clearHoverHighlight(true);

    if (!map || obs._lat == null || obs._lng == null) return;
    const meta = getTaxonMeta(obs.taxon);
    const radius = Math.max(12, Math.min(2500, Math.round(obs.positional_accuracy || 25)));

    hoverZoneLayer = L.circle([obs._lat, obs._lng], {
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
      clearHoverHighlight();
      return;
    }

    const center = map.getCenter();
    const centerPt = map.latLngToContainerPoint(center);
    let closestObs = null;
    let minDistancePx = Infinity;
    const HIT_RADIUS_PX = 34;

    for (const obs of activeObservations.values()) {
      if (obs._lat == null || obs._lng == null) continue;
      const pt = map.latLngToContainerPoint([obs._lat, obs._lng]);
      const d = centerPt.distanceTo(pt);
      if (d < HIT_RADIUS_PX && d < minDistancePx) {
        minDistancePx = d;
        closestObs = obs;
      }
    }

    if (closestObs) {
      highlightObservationZone(closestObs);
    } else {
      clearHoverHighlight();
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

      card.onclick = () => {
        closeClusterModal();
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
  }

  function closeClusterModal() {
    const modal = document.getElementById('modal-inat-cluster');
    if (modal) modal.classList.remove('open');
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

    btnGotoAuth?.addEventListener('click', () => {
      const spoilerAuth = document.getElementById('spoiler-inat-auth');
      const inputToken = document.getElementById('inat-token-input');
      if (spoilerAuth) {
        spoilerAuth.open = true;
        spoilerAuth.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setTimeout(() => inputToken?.focus(), 250);
    });

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
    } else {
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

  async function fetchSeasonalityHistogram(taxonId) {
    if (!taxonId) return null;
    if (histogramCache.has(taxonId)) return histogramCache.get(taxonId);
    try {
      const params = new URLSearchParams({
        taxon_id: String(taxonId),
        date_field: 'observed',
        interval: 'month_of_year',
        captive: 'false'
      });
      const data = await inatGet('observations/histogram', params, null, 'v2');
      const moy = data?.results?.month_of_year || null;
      if (moy) histogramCache.set(taxonId, moy);
      return moy;
    } catch (e) {
      return null;
    }
  }

  // =========================================================================
  // РЕНДЕР ГРАФИКА СЕЗОННОСТИ И ФЕНОЛОГИИ (OBSERVATIONS HISTOGRAM)
  // =========================================================================
  function renderSeasonalityChart(moy, curMonth = null) {
    if (!moy) return '<div class="muted inat-card-loading-sub">⏳ Анализ сезонности по месяцам…</div>';

    const monthKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    const monthLabels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    const currentMonthNum = curMonth || (new Date().getMonth() + 1);

    const values = monthKeys.map(k => Number(moy[k]) || 0);
    const maxVal = Math.max(...values, 1);
    const totalYear = values.reduce((a, b) => a + b, 0);

    // Определение пиковых месяцев (>= 60% от максимального)
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
      const hPct = Math.max(6, Math.round((v / maxVal) * 100));
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

    let summaryText = 'Данных о сезонности недостаточно.';
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
  function openObservationCard(obs) {
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

          <!-- БЫСТРАЯ ЛЕНТА ПИЛЮЛЬ И ФЕНОФАЗ -->
          <div class="inat-meta-pills-row">
            ${phenologyHtml}
            ${conservationHtml}
            ${originHtml}
            ${captiveHtml}
            ${privacyHtml}
            ${agreements > 0 ? `<span class="inat-pill" title="Подтверждений определения сообществом">👍 ${agreements}</span>` : ''}
            ${favesCount > 0 ? `<span class="inat-pill faves" title="В избранном">❤️ ${favesCount}</span>` : ''}
          </div>

          <!-- ГРАФИК СЕЗОННОСТИ И ФЕНОЛОГИИ (АКТИВНОСТЬ ПО МЕСЯЦАМ) -->
          <div id="inat-seasonality-container" style="margin-bottom: 12px;">
            <div class="muted inat-card-loading-sub">⏳ Загрузка фенологического календаря…</div>
          </div>

          <!-- БЫСТРЫЕ ДЕЙСТВИЯ (ОСНОВНЫЕ) -->
          <div class="nav-actions-grid inat-actions-grid" style="margin-bottom: 12px;">
            <button type="button" class="action-card-btn primary" id="btn-inat-set-target">🎯 Вести к организму</button>
            <button type="button" class="action-card-btn filter-taxon-btn" id="btn-inat-filter-this-taxon" title="Найти все такие же на карте">
              🔍 Все такие же
            </button>
            <a href="geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(ruName)})" class="action-card-btn" id="btn-inat-geo-nav">🧭 Навигатор</a>
            <button type="button" class="action-card-btn" id="btn-inat-copy-coords">📋 Координаты</button>
          </div>

          <!-- СПОЙЛЕР 1: ⚠️ ПОХОЖИЕ ВИДЫ И ОПАСНЫЕ ДВОЙНИКИ (SIMILAR SPECIES) -->
          <details class="inat-card-spoiler" id="spoiler-inat-similar" open style="margin-bottom: 10px;">
            <summary class="inat-card-spoiler-summary">
              <span>⚠️ С чем часто путают / Двойники</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body" id="inat-similar-container">
              <div class="muted inat-card-loading-sub">⏳ Поиск видов-двойников…</div>
            </div>
          </details>

          <!-- СПОЙЛЕР 2: 🗺️ НАУЧНЫЕ И НЕЙРОСЕТЕВЫЕ АРЕАЛЫ (RANGE MAPS) -->
          <details class="inat-card-spoiler" id="spoiler-inat-ranges" style="margin-bottom: 10px;">
            <summary class="inat-card-spoiler-summary">
              <span>🗺️ Научные и прогнозные ареалы обитания</span>
              <span class="chevron">▼</span>
            </summary>
            <div class="inat-card-spoiler-body" id="inat-ranges-container">
              <div class="muted inat-card-loading-sub">⏳ Проверка слоёв карт…</div>
            </div>
          </details>

          <!-- СПОЙЛЕР 3: 📍 МЕСТО, ДАТА И НАБЛЮДАТЕЛЬ -->
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

          ${soundsHtml}

          <!-- ЗАМЕТКА НАБЛЮДАТЕЛЯ (ЕСЛИ ЕСТЬ) -->
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

          <!-- СПОЙЛЕР 4: 🧬 ТАКСОНОМИЧЕСКАЯ ИЕРАРХИЯ -->
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

          <!-- СПОЙЛЕР 5: 👥 ОПРЕДЕЛЕНИЯ И КОММЕНТАРИИ СООБЩЕСТВА -->
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

          <!-- ССЫЛКИ НА ВНЕШНИЕ РЕСУРСЫ -->
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

    // 1. Асинхронная подгрузка сезонности
    fetchSeasonalityHistogram(taxon.id).then(moy => {
      const el = document.getElementById('inat-seasonality-container');
      if (el) el.innerHTML = renderSeasonalityChart(moy);
    });

    // 2. Асинхронная подгрузка двойников (Similar Species)
    fetchSimilarSpecies(taxon.id).then(simList => {
      const el = document.getElementById('inat-similar-container');
      if (el) {
        el.innerHTML = renderSimilarSpeciesSection(simList, taxon);
        // Привязываем клики по двойникам
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

    // 3. Асинхронная проверка слоев ареала (Polygon Ranges & Geomodel)
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

    // 4. Догрузка полных деталей наблюдения (аннотации, комменты)
    if (!hasFullDetails && obs.id) {
      fetchObservationFullDetails(obs.id).then(fullData => {
        if (!fullData) return;
        Object.assign(obs, fullData);
        obs._isFullDetail = true;
        const curModal = document.getElementById('modal-inat-details');
        if (curModal && curModal.classList.contains('open')) {
          openObservationCard(obs);
        }
      });
    }

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

  function scheduleCrosshairCheck() {
    if (crossRaf) return;
    crossRaf = requestAnimationFrame(() => { crossRaf = 0; checkCrosshairProximity(); });
  }

  function closeModal() {
    const modal = document.getElementById('modal-inat-details');
    if (modal) modal.classList.remove('open');
    clearAccuracyCircle();
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

  async function fetchSmartSuggestions(coords = null, month = null, iconic = null) {
    const c = coords || (WM.gpsState && WM.gpsState.lat ? WM.gpsState : (map ? map.getCenter() : { lat: 55.75, lng: 37.62 }));
    const curMonth = month || (new Date().getMonth() + 1);

    const params = new URLSearchParams({
      lat: c.lat.toFixed(5),
      lng: c.lng.toFixed(5),
      month: String(curMonth),
      locale: 'ru',
      fields: '(taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,rank:!t,default_photo:(square_url:!t,medium_url:!t),wikipedia_url:!t),score:!t,source:!t)'
    });

    const targetTaxa = iconic || (config.taxa && config.taxa !== 'all' ? config.taxa : null);
    if (targetTaxa) params.set('iconic_taxa', targetTaxa);

    try {
      const data = await inatGet('taxa/suggest', params, null, 'v2');
      return data.results || [];
    } catch (e) {
      // Резервный вызов через species_counts
      try {
        const fallbackParams = new URLSearchParams({
          lat: c.lat.toFixed(4),
          lng: c.lng.toFixed(4),
          radius: '50',
          month: String(curMonth),
          per_page: '20',
          locale: 'ru',
          fields: '(taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,rank:!t,default_photo:(square_url:!t)),count:!t)'
        });
        if (targetTaxa) fallbackParams.set('iconic_taxa', targetTaxa);
        const fbData = await inatGet('observations/species_counts', fallbackParams, null, 'v2');
        return (fbData.results || []).map(r => ({ taxon: r.taxon, score: r.count }));
      } catch (err2) {
        return [];
      }
    }
  }

  function renderSuggestionsList(items) {
    const listEl = document.getElementById('inat-suggest-items-list');
    const countEl = document.getElementById('inat-suggest-count');
    if (!listEl) return;
    listEl.innerHTML = '';

    let filtered = items;
    if (activeSuggestCategory !== 'all') {
      filtered = items.filter(it => {
        const t = it.taxon || it;
        return t.iconic_taxon_name === activeSuggestCategory;
      });
    }

    if (countEl) countEl.textContent = `${filtered.length}`;

    if (!filtered.length) {
      listEl.innerHTML = '<div class="muted" style="padding: 24px 0;">Для выбранной категории в текущей локации подсказок не найдено.</div>';
      return;
    }

    filtered.forEach(it => {
      const t = it.taxon || it;
      const meta = getTaxonMeta(t);
      const ruName = t.preferred_common_name || t.name;
      const latinName = t.name || '';
      const rank = RANKS_RU[t.rank] || t.rank || 'вид';
      const photoUrl = t.default_photo?.square_url || '';
      const score = it.score || it.combined_score || 0;
      const scorePct = typeof score === 'number' && score <= 1 ? Math.round(score * 100) : Math.min(100, Math.round(score));

      const card = document.createElement('div');
      card.className = 'inat-suggest-card';
      card.style.borderLeftColor = meta.color;

      card.innerHTML = `
        ${photoUrl ? `<img src="${photoUrl}" class="inat-suggest-thumb" alt="" loading="lazy">` : `<span class="inat-suggest-icon-ph">${meta.icon}</span>`}
        <div class="inat-suggest-info">
          <div class="inat-suggest-title-row">
            <span class="inat-suggest-ru">${escapeHtml(ruName)}</span>
            ${scorePct > 0 ? `<span class="inat-suggest-score-badge" title="Вероятность биоклиматической приуроченности">${scorePct}%</span>` : ''}
          </div>
          <span class="inat-suggest-la">${escapeHtml(latinName)} · ${escapeHtml(rank)}</span>
          <div class="inat-suggest-actions">
            <button type="button" class="inat-suggest-btn btn-show-map">👁️ Искать на карте</button>
            <button type="button" class="inat-suggest-btn btn-show-geomodel" style="color:#0284c7; border-color:#0284c7;">🧠 Ареал (AI)</button>
            <a href="https://www.inaturalist.org/taxa/${t.id}" target="_blank" rel="noopener noreferrer" class="inat-suggest-btn">↗ iNat</a>
          </div>
        </div>
      `;

      card.querySelector('.btn-show-map')?.addEventListener('click', () => {
        closeSmartSuggestionsModal();
        applyFilterToMap(ruName, t);
      });

      card.querySelector('.btn-show-geomodel')?.addEventListener('click', () => {
        closeSmartSuggestionsModal();
        showGeomodelForTaxon(t);
      });

      listEl.appendChild(card);
    });
  }

  async function openSmartSuggestionsModal() {
    let modal = document.getElementById('modal-inat-suggest');
    if (!modal) return;

    const listEl = document.getElementById('inat-suggest-items-list');
    const subTitleEl = document.getElementById('inat-suggest-loc-sub');
    const monthEl = document.getElementById('inat-suggest-month-label');

    const c = (WM.gpsState && WM.gpsState.lat) ? WM.gpsState : (map ? map.getCenter() : { lat: 55.75, lng: 37.62 });
    const monthsRu = ['', 'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
    const curMonth = new Date().getMonth() + 1;

    if (subTitleEl) subTitleEl.textContent = `📍 ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
    if (monthEl) monthEl.textContent = `Сезон: в ${monthsRu[curMonth]}`;

    if (listEl) listEl.innerHTML = '<div class="muted" style="padding: 24px 0;">🧠 Опрос нейросети Geo-Prior iNaturalist v2…</div>';

    modal.classList.add('open');
    isSuggestionsLoading = true;

    try {
      const items = await fetchSmartSuggestions(c, curMonth);
      modal._lastSuggestions = items;
      renderSuggestionsList(items);
    } catch (e) {
      if (listEl) listEl.innerHTML = `<div class="muted" style="color:var(--danger); padding:20px 0;">Ошибка загрузки подсказок: ${escapeHtml(e.message)}</div>`;
    } finally {
      isSuggestionsLoading = false;
    }
  }

  function closeSmartSuggestionsModal() {
    const modal = document.getElementById('modal-inat-suggest');
    if (modal) modal.classList.remove('open');
  }

  function initSmartSuggestionsUI() {
    const modal = document.getElementById('modal-inat-suggest');
    const closeX = document.getElementById('inat-suggest-close-x');
    const closeBtn = document.getElementById('inat-suggest-close-btn');
    const btnRecenter = document.getElementById('btn-inat-suggest-recenter');

    if (closeX) closeX.onclick = closeSmartSuggestionsModal;
    if (closeBtn) closeBtn.onclick = closeSmartSuggestionsModal;
    if (modal) {
      modal.onclick = (e) => { if (e.target === modal) closeSmartSuggestionsModal(); };
    }

    if (btnRecenter) {
      btnRecenter.onclick = () => openSmartSuggestionsModal();
    }

    // Фильтрация категорий внутри модалки
    document.querySelectorAll('#inat-suggest-category-chips .inat-suggest-chip').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#inat-suggest-category-chips .inat-suggest-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSuggestCategory = btn.dataset.taxa;
        if (modal?._lastSuggestions) {
          renderSuggestionsList(modal._lastSuggestions);
        }
      };
    });
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
    if (input) setTimeout(() => input.focus(), 120);
  }

  function closeListModal() {
    const modal = document.getElementById('modal-inat-list');
    if (modal) modal.classList.remove('open');
    inatSnapshotList = null;
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
    getTaxonMeta,
    getTaxonIcon,
    highlightObservationZone,
    closeClusterModal,
    openClusterModal,

    // Новые возможности v2 API:
    showGeomodelForTaxon,
    clearGeomodel,
    getActiveGeomodelTaxon: () => activeGeomodelTaxon,
    fetchSmartSuggestions,
    openSmartSuggestionsModal,
    closeSmartSuggestionsModal,
    fetchTaxonMapLayers,
    fetchSimilarSpecies,
    fetchSeasonalityHistogram
  };
})();
