(function () {
  const WM = window.WM = window.WM || {};

  const DEFAULT_CONFIG = {
    enabled: false,
    showBadge: true,
    taxa: 'Plantae,Fungi',
    query: '',
    season: 'any',
    month: 'any',
    quality: 'research',
    sort: 'votes',
    wildOnly: true,
    nativeOnly: false,
    threatenedOnly: false,
    photosOnly: true,
    limit: 50
  };

  let config = { ...DEFAULT_CONFIG };
  try {
    const saved = localStorage.getItem('wm_inat_config');
    if (saved) config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
  } catch (e) {}

  let map = null;
  let layer = null;
  const activeObservations = new Map();
  const markerInstances = new Map();
  let isFetching = false;
  let fetchTimer = null;
  let lastBboxKey = '';
  let accuracyCircle = null;

  // Динамическая подсветка зоны произрастания под перекрестием
  let hoverZoneLayer = null;
  let hoveredObsId = null;

  // Поиск и фильтрация на карте
  let searchType = 'screen'; // 'screen' | 'global'
  let activeMapFilter = null; // null | { query: string, taxonId: number|null, results: Array }
  let searchDebounceTimer = null;
  let autocompleteDebounceTimer = null;
  let autocompleteAbortCtl = null;
  let selectedTaxon = null;

  // Список/поиск в модальном окне
  let lastInatSearchQuery = '';
  let inatSnapshotList = null;
  let currentRenderZoom = 13;

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
    try {
      localStorage.setItem('wm_inat_config', JSON.stringify(config));
    } catch (e) {}
  }

  let tokenCountdownTimer = null;

  function parseJwt(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      const parts = token.trim().split('.');
      if (parts.length < 2) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      const jsonStr = decodeURIComponent(escape(atob(base64)));
      return JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }
  }

  function getTokenInfo() {
    const raw = getToken();
    if (!raw) return { exists: false, isValid: false, isExpired: false, expDate: null, timeLeftMs: 0 };
    const payload = parseJwt(raw);
    if (!payload || !payload.exp) {
      // Если токен не в формате JWT или не содержит exp
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

  function getToken() {
    return localStorage.getItem('wm_inat_key') || '';
  }

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
      statusEl.innerHTML = '<span style="color: var(--text-muted);">⚪ Токен не введён. Распознавание видов по фото требует токен.</span>';
      return;
    }

    const updateCountdown = () => {
      const info = getTokenInfo();
      if (!info.exists) {
        statusEl.innerHTML = '<span style="color: var(--text-muted);">⚪ Используется открытый гостевой доступ</span>';
        return;
      }
      if (info.isExpired) {
        statusEl.innerHTML = '<span style="color: #ef4444; font-weight: 700;">🔴 Срок действия токена истёк (прошло 24 часа)! Скопируйте свежий токен на inaturalist.org</span>';
        updateVisionTokenNotice();
      } else if (info.expDate) {
        const timeStr = formatTimeLeft(info.timeLeftMs);
        const expClock = info.expDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        statusEl.innerHTML = `
          <div style="color: #10b981; font-weight: 700;">🟢 Токен активен</div>
          <div style="font-size: 11.5px; margin-top: 2px;">
            ⏳ До окончания действия: <b>${timeStr}</b> (до ${expClock})
          </div>
        `;
      } else {
        statusEl.innerHTML = '<span style="color: #10b981;">🟢 Личный токен сохранён в памяти</span>';
      }
    };

    updateCountdown();
    // Обновляем таймер каждую секунду
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
      if (descEl) descEl.innerHTML = 'Нейросеть распознавания видов работает только при наличии авторизационного токена. Введите его в настройках выше.';
      if (btnPick && !isVisionLoading) {
        btnPick.classList.add('btn-secondary');
        btnPick.classList.remove('btn-primary');
      }
    } else if (info.isExpired) {
      alertBox.hidden = false;
      if (titleEl) titleEl.textContent = '⚠️ Срок действия токена истёк (24 ч)';
      if (descEl) descEl.innerHTML = 'Срок жизни предыдущего токена подошёл к концу. Пожалуйста, обновите токен для использования нейросети.';
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

  function getTaxonIcon(taxon) {
    return getTaxonMeta(taxon).icon;
  }

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

    const marker = markerInstances.get(obs.id);
    if (marker) {
      const el = marker.getElement();
      if (el) el.classList.add('inat-crosshair-hovered');
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

    const list = activeMapFilter ? activeMapFilter.results : Array.from(activeObservations.values());

    for (const obs of list) {
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

  // =========================================================================
  // АДАПТИВНАЯ ВЕРХНЯЯ ПЛАШКА С ЧИСЛОМ ОРГАНИЗМОВ
  // =========================================================================
  function updateTopBadge() {
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
      badgeText.textContent = `🌿 «${activeMapFilter.query}» (${activeMapFilter.results.length})  ›`;
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

      badgeText.textContent = `${icon} ${label}: ${activeObservations.size}  ›`;
      badge.title = 'Нажмите для открытия списка наблюдений на экране';
      if (badgeRefresh) badgeRefresh.hidden = true;
      if (badgeClear) badgeClear.hidden = true;
      badge.classList.remove('filtered');
    }
  }

  // =========================================================================
  // ЗАГРУЗКА НАБЛЮДЕНИЙ ДЛЯ ВИДИМОГО ЭКРАНА (МИН. ЗУМ 8)
  // =========================================================================
  async function loadObservationsForView(force = false) {
    if (activeMapFilter) {
      return;
    }
    if (!map || !layer || !config.enabled) return;
    if (map.getZoom() < 8) {
      layer.clearLayers();
      markerInstances.clear();
      activeObservations.clear();
      clearHoverHighlight();
      updateTopBadge();
      return;
    }

    const bounds = map.getBounds().pad(0.08);
    const swlat = bounds.getSouth().toFixed(4);
    const swlng = bounds.getWest().toFixed(4);
    const nelat = bounds.getNorth().toFixed(4);
    const nelng = bounds.getEast().toFixed(4);
    const bboxKey = `${swlat}_${swlng}_${nelat}_${nelng}_${JSON.stringify(config)}`;

    if (!force && bboxKey === lastBboxKey && !activeMapFilter) return;
    lastBboxKey = bboxKey;

    if (isFetching) return;
    isFetching = true;

    const params = new URLSearchParams({
      swlat,
      swlng,
      nelat,
      nelng,
      per_page: String(config.limit || 50),
      order: 'desc',
      order_by: config.sort || 'votes',
      locale: 'ru'
    });

    if (config.taxa && config.taxa !== 'all') params.set('iconic_taxa', config.taxa);
    if (config.quality && config.quality !== 'any') params.set('quality_grade', config.quality);
    if (config.wildOnly) params.set('captive', 'false');
    if (config.photosOnly) params.set('photos', 'true');
    if (config.nativeOnly) params.set('native', 'true');
    if (config.threatenedOnly) params.set('threatened', 'true');

    if (config.month && config.month !== 'any') {
      params.set('month', config.month);
    } else {
      const seasonMonths = getMonthsForSeason(config.season);
      if (seasonMonths) params.set('month', seasonMonths);
    }

    const userKey = getToken();
    const url = `https://api.inaturalist.org/v1/observations?${params.toString()}`;

    try {
      const headers = { 'Accept': 'application/json' };
      if (userKey) {
        headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      const items = data.results || [];
      activeObservations.clear();
      items.forEach(obs => {
        let lat = null, lng = null;
        if (obs.geojson && obs.geojson.coordinates) {
          lng = obs.geojson.coordinates[0];
          lat = obs.geojson.coordinates[1];
        } else if (obs.location) {
          const parts = obs.location.split(',');
          lat = parseFloat(parts[0]);
          lng = parseFloat(parts[1]);
        }
        if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
          obs._lat = lat;
          obs._lng = lng;
          activeObservations.set(obs.id, obs);
        }
      });

      renderMarkers(Array.from(activeObservations.values()));
    } catch (err) {
      console.warn('[iNaturalist] Ошибка загрузки точек:', err.message);
    } finally {
      isFetching = false;
      updateTopBadge();
      checkCrosshairProximity();
    }
  }

  // =========================================================================
  // РАСПОЗНАВАНИЕ ВИДОВ ПО ФОТО (iNaturalist Computer Vision API)
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
      if (btnPick && !isVisionLoading) {
        btnPick.disabled = true;
      }
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
      if (btnPick && !isVisionLoading) {
        btnPick.disabled = false;
      }
    }
  }

  // Сжатие фотографии через Canvas (до 1200px) для экономии трафика и мгновенной загрузки
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
        canvas.toBlob((blob) => {
          resolve(blob || file);
        }, 'image/jpeg', 0.88);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  // Запрос к Computer Vision эндпоинту
  async function scoreObservationImage(blob) {
    const formData = new FormData();
    formData.append('image', blob, 'observation.jpg');

    // Передаем координаты для учета географического ареала вида (Geo-Prior)
    const coords = (WM.gpsState && WM.gpsState.lat) 
      ? WM.gpsState 
      : (map ? map.getCenter() : null);

    if (coords && coords.lat != null && coords.lng != null) {
      formData.append('lat', coords.lat.toFixed(5));
      formData.append('lng', coords.lng.toFixed(5));
    }

    const headers = { 'Accept': 'application/json' };
    const userKey = getToken();
    if (userKey) {
      headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
    }

    const res = await fetch('https://api.inaturalist.org/v1/computervision/score_image', {
      method: 'POST',
      headers,
      body: formData
    });

    if (res.status === 429) {
      throw new Error('Превышен лимит запросов iNaturalist. Повторите позже.');
    }
    if (!res.ok) {
      throw new Error(`Ошибка сервера iNaturalist (${res.status})`);
    }

    return await res.json();
  }

  function renderVisionResults(data) {
    const wrap = document.getElementById('inat-vision-results');
    const listEl = document.getElementById('inat-vision-results-list');
    const ancestorBanner = document.getElementById('inat-vision-ancestor-banner');
    if (!wrap || !listEl) return;

    listEl.innerHTML = '';
    wrap.hidden = false;

    // Баннер общего предка/рода (если модель уверена в группе)
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
      listEl.innerHTML = '<div class="muted" style="padding: 10px 0;">Вид не распознан. Попробуйте сделать более чёткий снимок листа, цветка или шляпки крупным планом.</div>';
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
            <button type="button" class="inat-vision-act-btn btn-show-map">👁️ Найти на карте</button>
            <a href="https://www.inaturalist.org/taxa/${taxon.id}" target="_blank" rel="noopener noreferrer" class="inat-vision-act-btn">↗ iNat</a>
          </div>
        </div>
      `;

      card.querySelector('.btn-show-map')?.addEventListener('click', (e) => {
        e.stopPropagation();
        applyFilterToMap(ruName, taxon);
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
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast('⚠️ Токен iNaturalist отсутствует или истёк!', 3000);
      }
      updateVisionTokenNotice();
      return;
    }

    const rateStatus = checkVisionRateLimit();
    if (!rateStatus.allowed) {
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`⏳ Лимит: не более 3 фото в минуту. Подождите ещё ${rateStatus.waitSec} сек.`);
      }
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
    reader.onload = (e) => {
      if (previewImg) previewImg.src = e.target.result;
    };
    reader.readAsDataURL(file);

    isVisionLoading = true;
    if (btnPick) btnPick.disabled = true;

    // Сжатие + отправка
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

    // Кнопка быстрого перехода к настройкам токена
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
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast('⚠️ Для распознавания по фото необходим действующий токен iNaturalist (24 ч)', 3200);
        }
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
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`⏳ Лимит: не более 3 фото в минуту. Подождите ещё ${rate.waitSec} сек.`);
        }
        return;
      }
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        handleVisionFile(fileInput.files[0]);
      }
    });

    btnClear?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
      if (previewWrap) previewWrap.hidden = true;
      if (resultsWrap) resultsWrap.hidden = true;
    });

    // Drag-and-drop на ПК
    box.addEventListener('dragover', (e) => {
      e.preventDefault();
      box.classList.add('dragover');
    });
    box.addEventListener('dragleave', () => {
      box.classList.remove('dragover');
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleVisionFile(e.dataTransfer.files[0]);
      }
    });
  }

  // =========================================================================
  // ПОВТОРНАЯ ЗАГРУЗКА ДЛЯ ТЕКУЩЕГО ЭКРАНА С АКТИВНЫМ ФИЛЬТРОМ
  // =========================================================================
  async function fetchFilterObservationsForCurrentView(silent = false) {
    if (!map || !layer || !config.enabled || !activeMapFilter) return;

    const bounds = map.getBounds().pad(0.08);
    const swlat = bounds.getSouth().toFixed(4);
    const swlng = bounds.getWest().toFixed(4);
    const nelat = bounds.getNorth().toFixed(4);
    const nelng = bounds.getEast().toFixed(4);

    const params = new URLSearchParams({
      swlat,
      swlng,
      nelat,
      nelng,
      per_page: String(Math.max(100, config.limit || 50)),
      order: 'desc',
      order_by: config.sort || 'votes',
      locale: 'ru'
    });

    if (activeMapFilter.taxonId) {
      params.set('taxon_id', String(activeMapFilter.taxonId));
    } else if (activeMapFilter.query) {
      params.set('q', activeMapFilter.query);
    }

    if (config.taxa && config.taxa !== 'all' && !activeMapFilter.taxonId) {
      params.set('iconic_taxa', config.taxa);
    }
    if (config.quality && config.quality !== 'any') params.set('quality_grade', config.quality);
    if (config.wildOnly) params.set('captive', 'false');
    if (config.photosOnly) params.set('photos', 'true');
    if (config.nativeOnly) params.set('native', 'true');
    if (config.threatenedOnly) params.set('threatened', 'true');

    if (config.month && config.month !== 'any') {
      params.set('month', config.month);
    } else {
      const seasonMonths = getMonthsForSeason(config.season);
      if (seasonMonths) params.set('month', seasonMonths);
    }

    const refreshBtn = document.getElementById('inat-count-badge-refresh');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    const userKey = getToken();
    const url = `https://api.inaturalist.org/v1/observations?${params.toString()}`;

    try {
      const headers = { 'Accept': 'application/json' };
      if (userKey) {
        headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      const items = data.results || [];
      const validResults = [];
      items.forEach(obs => {
        let lat = null, lng = null;
        if (obs.geojson && obs.geojson.coordinates) {
          lng = obs.geojson.coordinates[0];
          lat = obs.geojson.coordinates[1];
        } else if (obs.location) {
          const parts = obs.location.split(',');
          lat = parseFloat(parts[0]);
          lng = parseFloat(parts[1]);
        }
        if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
          obs._lat = lat;
          obs._lng = lng;
          validResults.push(obs);
        }
      });

      activeMapFilter.results = validResults;
      renderMarkers(validResults);
      updateTopBadge();

      if (!silent && WM.ui && WM.ui.showToast) {
        if (validResults.length > 0) {
          WM.ui.showToast(`🌿 Найдено на экране: «${activeMapFilter.query}» (${validResults.length} шт.)`);
        } else {
          WM.ui.showToast(`В видимой области «${activeMapFilter.query}» не обнаружено`);
        }
      }
    } catch (err) {
      console.warn('[iNaturalist] Ошибка загрузки точек фильтра:', err.message);
      if (!silent && WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`⚠️ Ошибка: ${err.message}`);
      }
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  }

  // =========================================================================
  // ОТРИСОВКА МАРКЕРОВ НА КАРТЕ
  // =========================================================================
  function renderMarkers(items) {
    if (!layer || !map) return;
    layer.clearLayers();
    markerInstances.clear();
    clearHoverHighlight();

    const zoom = map.getZoom();
    currentRenderZoom = zoom;

    items.forEach(obs => {
      const lat = obs._lat;
      const lng = obs._lng;
      if (lat == null || lng == null) return;

      const taxon = obs.taxon || {};
      const meta = getTaxonMeta(taxon);
      const icon = meta.icon;
      const color = meta.color;
      
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
      const isResearch = obs.quality_grade === 'research';

      let html = '';

      if (zoom >= 13) {
        html = `
          <div class="wm-inat-pin-anchor" data-id="${obs.id}" style="--inat-color: ${color};">
            <div class="wm-inat-bubble ${isResearch ? 'research' : ''}">
              <div class="wm-inat-badge-card">
                <div class="wm-inat-thumb-wrap">
                  ${photoUrl ? `<img src="${photoUrl}" class="wm-inat-img" alt="">` : `<span class="wm-inat-badge-icon">${icon}</span>`}
                  ${photoUrl ? `<span class="wm-inat-corner-emoji" title="${meta.name}">${icon}</span>` : ''}
                </div>
                <div class="wm-inat-badge-texts">
                  <span class="wm-inat-badge-ru">${escapeHtml(ruName)}</span>
                  <span class="wm-inat-badge-la">${escapeHtml(latinName)}</span>
                </div>
              </div>
              <svg class="wm-inat-badge-tail" width="12" height="7" viewBox="0 0 12 7">
                <path d="M 0 0 L 6 7 L 12 0 Z" />
              </svg>
            </div>
            <div class="wm-inat-target-dot"></div>
          </div>
        `;
      } else {
        html = `
          <div class="wm-inat-pin-compact" data-id="${obs.id}" title="${escapeHtml(ruName)} (${meta.name})" style="--inat-color: ${color};">
            <span class="wm-inat-compact-dot">${icon}</span>
          </div>
        `;
      }

      const markerIcon = L.divIcon({
        className: 'wm-inat-div-icon',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });

      const marker = L.marker([lat, lng], {
        icon: markerIcon,
        zIndexOffset: 850
      }).addTo(layer);

      markerInstances.set(obs.id, marker);

      const handleMarkerClick = (e) => {
        if (e) {
          L.DomEvent.stopPropagation(e);
          if (e.preventDefault) e.preventDefault();
        }
        openObservationCard(obs);
      };

      marker.on('click', handleMarkerClick);
      marker.on('add', () => {
        const el = marker.getElement();
        if (el) {
          el.style.pointerEvents = 'auto';
          el.onclick = handleMarkerClick;
        }
      });
    });

    updateTopBadge();
  }

  function closeModal() {
    const modal = document.getElementById('modal-inat-details');
    if (modal) modal.classList.remove('open');
    clearAccuracyCircle();
  }

  // =========================================================================
  // МОДАЛЬНОЕ ОКНО ПОИСКА И СПИСКА ОРГАНИЗМОВ НА ЭКРАНЕ
  // =========================================================================
  function getObservationsForList() {
    return activeMapFilter ? activeMapFilter.results : Array.from(activeObservations.values());
  }

  function updateListModalHeader() {
    const titleEl = document.getElementById('inat-list-modal-title');
    if (!titleEl) return;
    if (activeMapFilter) {
      titleEl.innerHTML = `🌿 «${escapeHtml(activeMapFilter.query)}» (<span id="inat-list-count">0</span>)`;
    } else {
      titleEl.innerHTML = `🌿 Наблюдения на карте (<span id="inat-list-count">0</span>)`;
    }
  }

  function renderInatList(filterText = '') {
    const listEl = document.getElementById('inat-list-items');
    const countEl = document.getElementById('inat-list-count');
    if (!listEl) return;
    listEl.innerHTML = '';

    const allObs = inatSnapshotList || getObservationsForList();
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
        const user = (obs.user?.name || obs.user?.login || '').toLowerCase();
        return ru.includes(q) || la.includes(q) || id.includes(q) || user.includes(q);
      });
    }

    if (countEl) {
      countEl.textContent = q ? `${list.length}/${allObs.length}` : `${allObs.length}`;
    }

    if (!allObs.length) {
      const emptyText = activeMapFilter
        ? `В видимой области карты не найдено наблюдений по фильтру «${activeMapFilter.query}».`
        : 'На экране пока нет загруженных наблюдений. Приблизьте карту (зум 8+) или дождитесь загрузки.';
      listEl.innerHTML = `<div class="muted" style="width: 100%; padding: 24px 8px;">${emptyText}</div>`;
      return;
    }

    if (!list.length) {
      listEl.innerHTML = '<div class="muted" style="width: 100%; padding: 20px 8px;">Наблюдений по вашему запросу не найдено</div>';
      return;
    }

    // Сортируем: сначала ближе к центру карты
    list.sort((a, b) => (a._distMeters || 0) - (b._distMeters || 0));

    list.forEach(obs => {
      const taxon = obs.taxon || {};
      const meta = getTaxonMeta(taxon);
      const color = meta.color;
      const icon = meta.icon;
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const isResearch = obs.quality_grade === 'research';
      const photosCount = obs.photos ? obs.photos.length : 0;

      const statsKids = [];
      statsKids.push(`<span class="inat-chip-stat category-pill" style="color: ${color};">${meta.name}</span>`);
      if (isResearch) statsKids.push('<span class="inat-chip-stat rg" title="Research Grade">✓ RG</span>');
      if (photosCount > 0) statsKids.push(`<span class="inat-chip-stat">📷 ${photosCount}</span>`);
      if (obs._distMeters != null) {
        const distStr = obs._distMeters >= 1000 
          ? (obs._distMeters / 1000).toFixed(1) + ' км' 
          : Math.round(obs._distMeters) + ' м';
        statsKids.push(`<span class="inat-chip-stat">📍 ${distStr}</span>`);
      }
      if (obs.observed_on) {
        statsKids.push(`<span class="inat-chip-stat">📅 ${obs.observed_on.slice(5)}</span>`);
      }

      const statsHtml = statsKids.length ? `<span class="object-chip-stats">${statsKids.join('')}</span>` : '';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'inat-tag-chip';
      chip.style.borderLeft = `4px solid ${color}`;
      chip.title = `Перейти к «${ruName}» (${meta.name})`;
      chip.innerHTML = `
        <span class="inat-tag-chip-icon">${icon}</span>
        <span class="inat-tag-chip-ru">${escapeHtml(ruName)}</span>
        ${latinName && latinName !== ruName ? `<span class="inat-tag-chip-la">${escapeHtml(latinName)}</span>` : ''}
        ${statsHtml}
      `;

      chip.onclick = () => {
        closeListModal();
        if (obs._lat != null && obs._lng != null && map) {
          map.flyTo([obs._lat, obs._lng], Math.max(map.getZoom(), 16), { animate: true });
          highlightObservationZone(obs);
          setTimeout(() => {
            openObservationCard(obs);
          }, 350);
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`🎯 ${icon} ${ruName}`);
          }
        }
      };

      listEl.appendChild(chip);
    });
  }

  function openListModal() {
    const modal = document.getElementById('modal-inat-list');
    const input = document.getElementById('inat-list-search-input');
    const clearBtn = document.getElementById('inat-list-search-clear-btn');
    if (!modal) return;

    lastInatSearchQuery = '';
    if (input) input.value = '';
    if (clearBtn) clearBtn.hidden = true;

    inatSnapshotList = getObservationsForList();

    updateListModalHeader();
    renderInatList('');

    modal.classList.add('open');
    if (input) setTimeout(() => input.focus(), 120);
  }

  function closeListModal() {
    const modal = document.getElementById('modal-inat-list');
    if (modal) modal.classList.remove('open');
    inatSnapshotList = null;
  }

  function initListModal() {
    const modal = document.getElementById('modal-inat-list');
    const closeBtn = document.getElementById('inat-list-x');
    const input = document.getElementById('inat-list-search-input');
    const clearBtn = document.getElementById('inat-list-search-clear-btn');

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeListModal();
      });
    }

    if (closeBtn) closeBtn.onclick = closeListModal;

    if (input) {
      input.addEventListener('input', () => {
        lastInatSearchQuery = input.value;
        if (clearBtn) clearBtn.hidden = !input.value;
        renderInatList(lastInatSearchQuery);
      });
    }

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

  // =========================================================================
  // КРАСИВАЯ И ПОДРОБНАЯ КАРТОЧКА НАБЛЮДЕНИЯ (MODAL)
  // =========================================================================
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

    // Форматирование даты и времени
    let dateStr = 'Не указана';
    let timeStr = '';
    const rawTime = obs.time_observed_at || obs.observed_on;
    if (rawTime) {
      const d = new Date(rawTime);
      if (!isNaN(d.getTime())) {
        dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        if (obs.time_observed_at) {
          timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }
      } else if (obs.observed_on) {
        dateStr = obs.observed_on;
      }
    }

    let accuracy = obs.positional_accuracy ? `±${Math.round(obs.positional_accuracy)} м` : 'Не указана';
    if (obs.obscured) accuracy += ' (огрублено)';

    const observerName = obs.user?.name || obs.user?.login || 'Наблюдатель';
    const observerLogin = obs.user?.login || '';
    const observerIcon = obs.user?.icon_url || obs.user?.icon || '';
    const observerObsCount = obs.user?.observations_count != null ? `${obs.user.observations_count.toLocaleString('ru-RU')} находок` : '';

    const isResearch = obs.quality_grade === 'research';
    const isNeedsId = obs.quality_grade === 'needs_id';

    let qualityClass = 'casual';
    let qualityText = '⚪ Любительский уровень (Casual)';
    if (isResearch) {
      qualityClass = 'research';
      qualityText = '✓ Исследовательский уровень (RG)';
    } else if (isNeedsId) {
      qualityClass = 'needs-id';
      qualityText = '🔍 Требует определения (Needs ID)';
    }

    const agreements = obs.num_identification_agreements || 0;
    const favesCount = obs.faves_count || 0;
    const wikiUrl = taxon.wikipedia_url || '';
    const inatUrl = obs.uri || `https://www.inaturalist.org/observations/${obs.id}`;
    const placeGuess = obs.place_guess || '';

    // Охранный статус и Красная книга
    let conservationHtml = '';
    const cs = obs.conservation_status || taxon.conservation_status;
    if (cs || taxon.threatened) {
      const statusTitle = cs?.status_name || (cs?.iucn ? IUCN_MAP[cs.iucn] : null) || 'Охраняемый / Редкий вид';
      const authority = cs?.authority ? ` · ${cs.authority}` : '';
      conservationHtml = `<span class="inat-pill threatened" title="${escapeHtml(statusTitle + authority)}">⚠️ ${escapeHtml(statusTitle)}</span>`;
    }

    // Природный статус
    let originHtml = '';
    if (taxon.endemic) {
      originHtml = '<span class="inat-pill endemic" title="Встречается только в данном регионе">🏝️ Эндемик</span>';
    } else if (taxon.native) {
      originHtml = '<span class="inat-pill native" title="Естественный природный ареал">🌿 Аборигенный вид</span>';
    } else if (taxon.introduced) {
      originHtml = '<span class="inat-pill introduced" title="Завезен человеком (чужеродный вид)">🌍 Интродуцирован</span>';
    }

    const captiveHtml = obs.captive
      ? '<span class="inat-pill captive" title="Выращено человеком / в неволе">🏡 Культурное / Неволя</span>'
      : '<span class="inat-pill wild" title="Дикорастущий организм в естественной среде">🐾 Дикая природа</span>';

    const privacyHtml = obs.obscured
      ? '<span class="inat-pill obscured" title="Точные координаты скрыты iNaturalist ради защиты редкого вида">🔒 Координаты огрублены</span>'
      : '';

    // Таксономия в виде цепочки рангов
    let ancestorsHtml = '';
    if (taxon.ancestors && Array.isArray(taxon.ancestors)) {
      const fullHierarchy = [...taxon.ancestors];
      if (!fullHierarchy.some(a => a.id === taxon.id)) {
        fullHierarchy.push(taxon);
      }
      ancestorsHtml = fullHierarchy.map((a, idx) => {
        const isCurrent = a.id === taxon.id;
        const rTitle = RANKS_RU[a.rank] || a.rank || '';
        const nameRu = a.preferred_common_name ? `${a.preferred_common_name} (${a.name})` : a.name;
        return `
          <span class="inat-tree-node ${isCurrent ? 'current' : ''}">
            <small class="inat-tree-rank">${escapeHtml(rTitle)}</small>
            <b>${escapeHtml(nameRu)}</b>
          </span>
        `;
      }).join('<span class="inat-tree-arrow">➔</span>');
    }

    // Фотогалерея
    let photosHtml = '';
    const photos = obs.photos || [];
    let formattedLbPhotos = [];

    if (photos.length > 0) {
      formattedLbPhotos = photos.map(p => {
        let fullUrl = p.url || '';
        if (fullUrl) {
          fullUrl = fullUrl.replace(/\/(square|small|medium|thumb)\./i, '/large.');
        }
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
              <div class="inat-photo-card" data-photo-idx="${idx}" title="Нажмите для полноэкранного просмотра">
                <img src="${p.url.replace('square', 'medium')}" loading="lazy" alt="Фото ${idx + 1}">
                <span class="inat-photo-counter">${idx + 1}/${photos.length}</span>
                ${p.attribution ? `<span class="inat-photo-attr">${escapeHtml(p.attribution)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Аудиозаписи
    let soundsHtml = '';
    const sounds = obs.sounds || [];
    if (sounds.length > 0) {
      soundsHtml = `
        <div class="inat-sounds-box">
          <div class="inat-section-title">🔊 Звуковая запись (${sounds.length}):</div>
          ${sounds.map(s => {
            const soundUrl = s.file_url || '';
            return soundUrl ? `
              <div class="inat-sound-item">
                <audio controls src="${escapeHtml(soundUrl)}" preload="none"></audio>
                ${s.attribution ? `<span class="inat-sound-attr">${escapeHtml(s.attribution)}</span>` : ''}
              </div>
            ` : '';
          }).join('')}
        </div>
      `;
    }

    // Опознания сообществом и комментарии
    let identsHtml = '';
    const idents = obs.identifications || [];
    const comments = obs.comments || [];
    const totalCommunity = [...idents, ...comments];

    if (totalCommunity.length > 0) {
      identsHtml = `
        <div class="inat-idents-box">
          <div class="inat-section-title">👥 Консенсус и комментарии сообщества (${totalCommunity.length}):</div>
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
                      <div>
                        <b>${escapeHtml(uName)}</b> <small style="color:var(--text-muted);">${escapeHtml(uLogin)}</small>
                      </div>
                    </div>
                    <small style="color:var(--text-muted);">${createdDate}</small>
                  </div>
                  <div class="inat-ident-taxon-row">
                    <span class="inat-ident-badge ${isAgreed ? 'agreed' : 'proposed'}">${isAgreed ? '✓ Подтвердил вид' : '💡 Предложил вид'}</span>
                    <span class="inat-ident-taxon-name"><b>${escapeHtml(idNameRu)}</b> <i>(${escapeHtml(idNameLa)})</i></span>
                  </div>
                  ${id.body ? `<div class="inat-ident-body">${escapeHtml(id.body)}</div>` : ''}
                </div>
              `;
            }).join('')}

            ${comments.map(c => `
              <div class="inat-comment-item">
                <div class="inat-comment-head">
                  <b>${escapeHtml(c.user?.name || c.user?.login || 'Участник')}</b>
                  <small>${c.created_at ? c.created_at.slice(0, 10) : ''}</small>
                </div>
                <div class="inat-comment-body">${escapeHtml(c.body)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    modal.innerHTML = `
      <div class="modal-box modal-box-large inat-details-box">
        <div class="modal-header">
          <div class="inat-modal-title-row">
            <span class="inat-type-tag" style="--tag-color: ${color}; background: ${meta.bg}; color: ${color};">
              ${icon} ${categoryName}${rankRu ? ` · ${rankRu.toUpperCase()}` : ''}
            </span>
            <div class="inat-header-titles">
              <h3 class="inat-header-ru">${escapeHtml(ruName)}</h3>
              <div class="inat-header-la">
                <i>${escapeHtml(latinName)}</i>${enName && enName !== ruName ? ` · <span class="inat-en-name">${escapeHtml(enName)}</span>` : ''}
              </div>
            </div>
          </div>
          <button class="modal-close-x" id="inat-modal-close-x">✕</button>
        </div>

        <div class="modal-content-scroll" style="max-height: 65vh;">
          ${photosHtml}

          <!-- БЕЙДЖИ СТАТУСА НАХОДКИ -->
          <div class="inat-meta-pills-row">
            <span class="inat-pill ${qualityClass}">
              ${qualityText}
            </span>
            ${conservationHtml}
            ${originHtml}
            ${captiveHtml}
            ${privacyHtml}
            <span class="inat-pill">👍 Подтверждений: ${agreements}</span>
            ${favesCount > 0 ? `<span class="inat-pill faves">❤️ ${favesCount}</span>` : ''}
          </div>

          <!-- СЕТКА КЛЮЧЕВЫХ ДАННЫХ -->
          <div class="inat-card-grid">
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
              </div>
            ` : ''}
            <div class="inat-cell" style="grid-column: span 2;">
              <span class="inat-lbl">📍 Координаты центра:</span>
              <div class="inat-coords-row">
                <b class="inat-coords-val">${lat != null ? lat.toFixed(6) : '--'}, ${lng != null ? lng.toFixed(6) : '--'}</b>
                <button type="button" class="btn-link inat-coords-copy-mini" id="btn-inat-copy-coords-mini">Копировать</button>
              </div>
            </div>
          </div>

          ${soundsHtml}

          ${obs.description ? `
            <div class="inat-desc-box">
              <div class="inat-section-title">📝 Заметка наблюдателя:</div>
              <p class="inat-desc-text">${escapeHtml(obs.description)}</p>
            </div>
          ` : ''}

          ${ancestorsHtml ? `
            <div class="inat-tree-box">
              <div class="inat-section-title">🧬 Таксономия (иерархия):</div>
              <div class="inat-tree-content">${ancestorsHtml}</div>
            </div>
          ` : ''}

          ${identsHtml}

          <!-- ПАНЕЛЬ БЫСТРЫХ ДЕЙСТВИЙ -->
          <div class="nav-actions-grid inat-actions-grid" style="margin-top: 14px;">
            <button type="button" class="action-card-btn primary" id="btn-inat-set-target">🎯 Вести к организму</button>
            <button type="button" class="action-card-btn filter-taxon-btn" id="btn-inat-filter-this-taxon" title="Найти и показать все такие же на карте">
              🔍 Все такие же на карте
            </button>
            <a href="geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(ruName)})" class="action-card-btn" id="btn-inat-geo-nav">🧭 В Навигатор</a>
            <button type="button" class="action-card-btn" id="btn-inat-copy-coords">📋 Координаты</button>
            ${wikiUrl ? `<a href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener noreferrer" class="action-card-btn wiki-btn">📖 Статья в Википедии ↗</a>` : ''}
            <a href="${escapeHtml(inatUrl)}" target="_blank" rel="noopener noreferrer" class="action-card-btn inat-link-btn" style="grid-column: span 2;">
              🌐 Карточка на iNaturalist.org ↗
            </a>
          </div>
        </div>
      </div>
    `;

    modal.classList.add('open');

    modal.querySelectorAll('.inat-photo-card').forEach(card => {
      card.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(card.dataset.photoIdx, 10) || 0;
        if (formattedLbPhotos.length > 0 && WM.ui && WM.ui.openLightbox) {
          WM.ui.openLightbox(formattedLbPhotos, idx);
        }
      };
    });

    const closeBtn = document.getElementById('inat-modal-close-x');
    if (closeBtn) closeBtn.onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };

    // Навигация к организму через навигационный модуль приложения
    const btnTarget = document.getElementById('btn-inat-set-target');
    if (btnTarget && WM.navTarget) {
      btnTarget.onclick = () => {
        WM.navTarget.set({
          id: 'inat_' + obs.id,
          title: `${icon} ${ruName}`,
          lat,
          lng
        });
        closeModal();
      };
    }

    // Быстрый поиск всех таких же организмов
    const btnFilterThis = document.getElementById('btn-inat-filter-this-taxon');
    if (btnFilterThis && obs.taxon) {
      btnFilterThis.onclick = () => {
        filterByTaxon(obs.taxon);
      };
    }

    // Копирование координат
    const copyCoordsHandler = () => {
      if (lat != null && lng != null) {
        const cStr = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        navigator.clipboard.writeText(cStr).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast(`📋 Скопировано: ${cStr}`);
        });
      }
    };

    const btnCopy = document.getElementById('btn-inat-copy-coords');
    if (btnCopy) btnCopy.onclick = copyCoordsHandler;

    const btnCopyMini = document.getElementById('btn-inat-copy-coords-mini');
    if (btnCopyMini) btnCopyMini.onclick = copyCoordsHandler;
  }

  // =========================================================================
  // ТАКСОНОМИЧЕСКИЙ АВТОДОПОЛНИТЕЛЬ (AUTOCOMPLETE)
  // =========================================================================
  async function fetchTaxaAutocomplete(query, signal = null) {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    const params = new URLSearchParams({
      q,
      locale: 'ru',
      per_page: '8'
    });

    if (config.taxa && config.taxa !== 'all') {
      params.set('iconic_taxa', config.taxa);
    }

    try {
      const res = await fetch(`https://api.inaturalist.org/v1/taxa/autocomplete?${params.toString()}`, {
        signal: signal || undefined,
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      return [];
    }
  }

  async function triggerTaxaAutocompleteSettings(query) {
    const wrap = document.getElementById('inat-autocomplete-wrap');
    const list = document.getElementById('inat-autocomplete-list');
    if (!wrap || !list) return;

    if (autocompleteAbortCtl) autocompleteAbortCtl.abort();
    autocompleteAbortCtl = new AbortController();

    const items = await fetchTaxaAutocomplete(query, autocompleteAbortCtl.signal);
    renderTaxaAutocomplete(items);
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
        locale: 'ru'
      });

      if (taxon) {
        params.set('taxon_id', String(taxon.id));
      } else {
        params.set('q', q);
      }

      if (config.taxa && config.taxa !== 'all' && !taxon) {
        params.set('iconic_taxa', config.taxa);
      }
      if (config.wildOnly) params.set('captive', 'false');

      const userKey = getToken();
      const headers = { 'Accept': 'application/json' };
      if (userKey) {
        headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
      }

      let res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, { headers });
      let data = await res.json();

      if (!data.results || data.results.length === 0) {
        params.delete('lat');
        params.delete('lng');
        params.delete('radius');
        res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, { headers });
        data = await res.json();
      }

      const validResults = [];
      (data.results || []).forEach(obs => {
        let lat = null, lng = null;
        if (obs.geojson && obs.geojson.coordinates) {
          lng = obs.geojson.coordinates[0];
          lat = obs.geojson.coordinates[1];
        } else if (obs.location) {
          const parts = obs.location.split(',');
          lat = parseFloat(parts[0]);
          lng = parseFloat(parts[1]);
        }
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
          obs._lat = lat;
          obs._lng = lng;
          validResults.push(obs);
        }
      });

      return { results: validResults, total: data.total_results || validResults.length };
    }
  }

  function renderTaxaAutocomplete(taxa) {
    const wrap = document.getElementById('inat-autocomplete-wrap');
    const list = document.getElementById('inat-autocomplete-list');
    if (!wrap || !list) return;

    list.innerHTML = '';
    if (!taxa.length) {
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
        selectTaxonSuggestion(t);
      };

      list.appendChild(item);
    });

    wrap.hidden = false;
  }

  function selectTaxonSuggestion(taxon) {
    selectedTaxon = taxon;
    const input = document.getElementById('inat-filter-query');
    const wrap = document.getElementById('inat-autocomplete-wrap');
    if (wrap) wrap.hidden = true;

    const displayName = taxon.preferred_common_name || taxon.name;
    if (input) {
      input.value = displayName;
      const clearBtn = document.getElementById('inat-filter-query-clear');
      if (clearBtn) clearBtn.hidden = false;
    }

    executePlantSearch(displayName);
  }

  // =========================================================================
  // ПОИСК ОРГАНИЗМОВ
  // =========================================================================
  let currentSearchResults = [];

  function renderSearchResults(items, totalCount = null) {
    const listEl = document.getElementById('inat-search-results-list');
    const wrapEl = document.getElementById('inat-search-results-wrap');
    const countEl = document.getElementById('inat-search-count-label');
    if (!listEl || !wrapEl || !countEl) return;

    listEl.innerHTML = '';

    if (!items || items.length === 0) {
      countEl.textContent = 'Найдено: 0';
      listEl.innerHTML = '<div class="muted" style="padding: 12px 0;">Ничего не найдено</div>';
      wrapEl.hidden = false;
      return;
    }

    const totalText = totalCount !== null ? totalCount.toLocaleString('ru-RU') : items.length;
    countEl.textContent = `Всего: ${totalText} (показано ${items.length} шт.)`;
    wrapEl.hidden = false;

    const mapCenter = map ? map.getCenter() : null;
    if (mapCenter) {
      items.forEach(obs => {
        obs._distMeters = map.distance(mapCenter, [obs._lat, obs._lng]);
      });
      items.sort((a, b) => a._distMeters - b._distMeters);
    }

    items.forEach(obs => {
      const taxon = obs.taxon || {};
      const meta = getTaxonMeta(taxon);
      const icon = meta.icon;
      const ruName = taxon.preferred_common_name || obs.species_guess || taxon.name || meta.name;
      const latinName = taxon.name || '';
      const photoUrl = obs.photos?.[0]?.url || taxon.default_photo?.square_url || '';
      const dateStr = obs.observed_on || (obs.created_at ? obs.created_at.slice(0, 10) : '');

      let distStr = '';
      if (obs._distMeters != null) {
        distStr = obs._distMeters >= 1000 
          ? ` · ~${(obs._distMeters / 1000).toFixed(1)} км` 
          : ` · ~${Math.round(obs._distMeters)} м`;
      }

      const itemEl = document.createElement('div');
      itemEl.className = 'inat-search-item';
      itemEl.dataset.id = obs.id;
      
      itemEl.innerHTML = `
        ${photoUrl ? `<img src="${photoUrl}" class="inat-search-thumb" alt="">` : `<span class="inat-search-icon">${icon}</span>`}
        <div class="inat-search-meta">
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="inat-search-ru">${escapeHtml(ruName)}</span>
            <span class="inat-search-type-sub" style="color:${meta.color};">${meta.name}</span>
          </div>
          <span class="inat-search-la">${escapeHtml(latinName)}</span>
          <span class="inat-search-extra">📅 ${dateStr}${distStr}</span>
        </div>
        <span class="inat-search-goto-btn" title="Перейти к точке на карте">🎯</span>
      `;

      itemEl.onclick = () => {
        if (obs._lat != null && obs._lng != null && map) {
          map.flyTo([obs._lat, obs._lng], Math.max(map.getZoom(), 16), { animate: true });
          document.getElementById('modal')?.classList.remove('open');
          highlightObservationZone(obs);
          setTimeout(clearHoverHighlight, 3500);
          if (WM.ui && WM.ui.showToast) {
            WM.ui.showToast(`🎯 Найдено: ${ruName}`);
          }
        }
      };

      listEl.appendChild(itemEl);
    });
  }

  async function executePlantSearch(query) {
    const q = (query || '').trim();
    const wrapEl = document.getElementById('inat-search-results-wrap');

    if (!q) {
      if (wrapEl) wrapEl.hidden = true;
      currentSearchResults = [];
      return;
    }

    if (searchType === 'screen') {
      const qLower = q.toLowerCase();
      const matches = [];
      for (const obs of activeObservations.values()) {
        const taxon = obs.taxon || {};
        const ru = (taxon.preferred_common_name || obs.species_guess || '').toLowerCase();
        const la = (taxon.name || '').toLowerCase();
        if (ru.includes(qLower) || la.includes(qLower)) {
          matches.push(obs);
        }
      }
      currentSearchResults = matches;
      renderSearchResults(matches, matches.length);
    } else {
      const listEl = document.getElementById('inat-search-results-list');
      if (listEl) listEl.innerHTML = '<div class="muted" style="padding: 12px 0;">⏳ Запрос к iNaturalist…</div>';
      if (wrapEl) wrapEl.hidden = false;

      try {
        const center = map ? map.getCenter() : { lat: 55.75, lng: 37.62 };
        
        const params = new URLSearchParams({
          lat: center.lat.toFixed(4),
          lng: center.lng.toFixed(4),
          radius: '500',
          per_page: '100',
          order: 'desc',
          order_by: 'votes',
          locale: 'ru'
        });

        if (selectedTaxon) {
          params.set('taxon_id', String(selectedTaxon.id));
        } else {
          params.set('q', q);
        }

        if (config.taxa && config.taxa !== 'all' && !selectedTaxon) {
          params.set('iconic_taxa', config.taxa);
        }
        if (config.wildOnly) params.set('captive', 'false');

        const userKey = getToken();
        const headers = { 'Accept': 'application/json' };
        if (userKey) {
          headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
        }

        let res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, { headers });
        let data = await res.json();

        if (!data.results || data.results.length === 0) {
          params.delete('lat');
          params.delete('lng');
          params.delete('radius');
          res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, { headers });
          data = await res.json();
        }

        const validResults = [];
        (data.results || []).forEach(obs => {
          let lat = null, lng = null;
          if (obs.geojson && obs.geojson.coordinates) {
            lng = obs.geojson.coordinates[0];
            lat = obs.geojson.coordinates[1];
          } else if (obs.location) {
            const parts = obs.location.split(',');
            lat = parseFloat(parts[0]);
            lng = parseFloat(parts[1]);
          }
          if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            obs._lat = lat;
            obs._lng = lng;
            validResults.push(obs);
          }
        });

        currentSearchResults = validResults;
        renderSearchResults(validResults, data.total_results);
      } catch (err) {
        console.warn('[iNaturalist] Ошибка глобального поиска:', err);
        if (listEl) listEl.innerHTML = `<div class="muted" style="padding: 12px 0; color: var(--danger);">Ошибка: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  // =========================================================================
  // ПОКАЗАТЬ НА КАРТЕ
  // =========================================================================
  async function applyFilterToMap(customQuery = null, customTaxon = null) {
    if (customTaxon !== null && customTaxon !== undefined) selectedTaxon = customTaxon;
    const input = document.getElementById('inat-filter-query');
    const q = customQuery !== null ? customQuery : (input ? input.value.trim() : '');

    if (!q && !selectedTaxon && !currentSearchResults.length) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('Введите название растения или выберите из списка');
      return;
    }

    if (!config.enabled) {
      enable();
    }

    const center = map.getCenter();
    map.setView(center, 9, { animate: false });

    const filterTitle = selectedTaxon ? (selectedTaxon.preferred_common_name || selectedTaxon.name) : (q || 'Результаты поиска');
    activeMapFilter = { 
      query: filterTitle, 
      taxonId: selectedTaxon ? selectedTaxon.id : null,
      results: [] 
    };

    updateTopBadge();
    document.getElementById('modal')?.classList.remove('open');
    document.getElementById('modal-search')?.classList.remove('open');

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`🌿 Загрузка «${filterTitle}» в зоне экрана (зум 9)…`, 1800);
    }

    await fetchFilterObservationsForCurrentView();
  }

  function clearMapFilter() {
    activeMapFilter = null;
    selectedTaxon = null;
    updateTopBadge();
    loadObservationsForView(true);
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast('🌿 Фильтр снят: показаны все наблюдения');
    }
  }

  // =========================================================================
  // ИНИЦИАЛИЗАЦИЯ И СЛУШАТЕЛИ
  // =========================================================================
  function init(m, l) {
    map = m;
    layer = l;

    const scheduleUpdate = () => {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(() => {
        if (config.enabled) {
          if (!activeMapFilter) {
            loadObservationsForView();
          }
        }
      }, 500);
    };

    map.on('moveend', scheduleUpdate);
    map.on('move', checkCrosshairProximity);

    map.on('zoomend', () => {
      const z = map.getZoom();
      const wasBubble = currentRenderZoom >= 13;
      const isBubble = z >= 13;
      currentRenderZoom = z;
      if (wasBubble !== isBubble) {
        const items = activeMapFilter ? activeMapFilter.results : Array.from(activeObservations.values());
        if (items.length > 0) {
          renderMarkers(items);
        }
      }
      scheduleUpdate();
    });

    initListModal();

    document.getElementById('inat-count-badge-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearMapFilter();
    });

    document.getElementById('inat-count-badge-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchFilterObservationsForCurrentView();
    });

    document.getElementById('inat-count-badge')?.addEventListener('click', (e) => {
      if (e.target.closest('#inat-count-badge-clear, #inat-count-badge-refresh')) return;
      openListModal();
    });

    if (config.enabled) {
      loadObservationsForView(true);
    }
  }

  function enable() {
    config.enabled = true;
    saveConfig();
    syncSettingsInputs();
    if (layer && map && !map.hasLayer(layer)) {
      layer.addTo(map);
    }
    loadObservationsForView(true);
    updateTopBadge();
  }

  function disable() {
    config.enabled = false;
    saveConfig();
    syncSettingsInputs();
    if (layer) layer.clearLayers();
    activeObservations.clear();
    markerInstances.clear();
    clearAccuracyCircle();
    clearHoverHighlight();
    closeListModal();
    updateTopBadge();
  }

  function setConfig(newCfg) {
    config = { ...config, ...newCfg };
    saveConfig();
    syncSettingsInputs();
    if (config.enabled) {
      loadObservationsForView(true);
    }
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

    const selMonth = document.getElementById('inat-filter-month');
    if (selMonth) selMonth.value = config.month || 'any';

    const selQuality = document.getElementById('inat-filter-quality');
    if (selQuality) selQuality.value = config.quality || 'research';

    const selSort = document.getElementById('inat-filter-sort');
    if (selSort) selSort.value = config.sort || 'votes';

    const chkWild = document.getElementById('toggle-inat-wild');
    if (chkWild) chkWild.checked = config.wildOnly !== false;

    const chkNative = document.getElementById('toggle-inat-native');
    if (chkNative) chkNative.checked = !!config.nativeOnly;

    const chkThreatened = document.getElementById('toggle-inat-threatened');
    if (chkThreatened) chkThreatened.checked = !!config.threatenedOnly;

    const chkPhotos = document.getElementById('toggle-inat-photos');
    if (chkPhotos) chkPhotos.checked = config.photosOnly !== false;

    const sliderLimit = document.getElementById('inat-filter-limit');
    const valLimit = document.getElementById('inat-filter-limit-val');
    if (sliderLimit && valLimit && document.activeElement !== sliderLimit) {
      sliderLimit.value = config.limit || 50;
      valLimit.textContent = sliderLimit.value;
    }

    syncTokenUI();
    updateTopBadge();
  }

  async function exportCurrentViewJson() {
    if (!map) return;
    if (map.getZoom() < 8) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('⚠️ Приблизьте карту (зум 8+), чтобы получить данные области');
      return;
    }

    if (WM.ui && WM.ui.showToast) WM.ui.showToast('⏳ Запрос полного JSON с iNaturalist…', 2000);

    const bounds = map.getBounds().pad(0.05);
    const swlat = bounds.getSouth().toFixed(5);
    const swlng = bounds.getWest().toFixed(5);
    const nelat = bounds.getNorth().toFixed(5);
    const nelng = bounds.getEast().toFixed(5);

    const params = new URLSearchParams({
      swlat,
      swlng,
      nelat,
      nelng,
      per_page: '200',
      order: 'desc',
      order_by: config.sort || 'votes',
      locale: 'ru'
    });

    if (config.taxa && config.taxa !== 'all') params.set('iconic_taxa', config.taxa);
    if (config.quality && config.quality !== 'any') params.set('quality_grade', config.quality);
    if (config.wildOnly) params.set('captive', 'false');
    if (config.photosOnly) params.set('photos', 'true');
    if (config.nativeOnly) params.set('native', 'true');
    if (config.threatenedOnly) params.set('threatened', 'true');

    if (config.month && config.month !== 'any') params.set('month', config.month);
    else {
      const seasonMonths = getMonthsForSeason(config.season);
      if (seasonMonths) params.set('month', seasonMonths);
    }

    const userKey = getToken();
    const url = `https://api.inaturalist.org/v1/observations?${params.toString()}`;
    let payload = null;

    try {
      const headers = { 'Accept': 'application/json' };
      if (userKey) {
        headers['Authorization'] = userKey.startsWith('Bearer ') ? userKey : `Bearer ${userKey}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      payload = {
        api_source: 'https://api.inaturalist.org/v1/observations',
        exported_at: new Date().toISOString(),
        screen_viewport: {
          zoom: map.getZoom(),
          center: map.getCenter(),
          bbox: { swlat: +swlat, swlng: +swlng, nelat: +nelat, nelng: +nelng }
        },
        applied_filters: Object.fromEntries(params.entries()),
        total_results_in_area: data.total_results,
        returned_count: (data.results || []).length,
        results: data.results || []
      };
    } catch (err) {
      if (activeObservations.size > 0) {
        const cachedList = Array.from(activeObservations.values());
        payload = {
          api_source: 'iNaturalist (локальный кэш маркеров)',
          exported_at: new Date().toISOString(),
          screen_viewport: {
            zoom: map.getZoom(),
            center: map.getCenter(),
            bbox: { swlat: +swlat, swlng: +swlng, nelat: +nelat, nelng: +nelng }
          },
          returned_count: cachedList.length,
          results: cachedList
        };
      } else {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(`❌ Ошибка загрузки: ${err.message}`);
        return;
      }
    }

    if (!payload || !payload.results || payload.results.length === 0) {
      if (WM.ui && WM.ui.showToast) WM.ui.showToast('ℹ️ В текущей области наблюдений не обнаружено');
      return;
    }

    const jsonStr = JSON.stringify(payload, null, 2);
    const dateStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `inaturalist_raw_${dateStamp}.json`;

    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(dlUrl);
    }, 500);

    const sizeKb = (jsonStr.length / 1024).toFixed(0);
    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(`💾 Сохранён JSON (${payload.returned_count} объектов, ~${sizeKb} КБ)`);
    }
  }

  function setSearchType(type) {
    searchType = type;
    const input = document.getElementById('inat-filter-query');
    if (input && input.value.trim()) {
      executePlantSearch(input.value.trim());
    }
  }

  function triggerSearchInput(val) {
    clearTimeout(searchDebounceTimer);
    clearTimeout(autocompleteDebounceTimer);

    if (selectedTaxon && val.trim() !== (selectedTaxon.preferred_common_name || selectedTaxon.name)) {
      selectedTaxon = null;
    }

    autocompleteDebounceTimer = setTimeout(() => {
      fetchTaxaAutocomplete(val);
    }, 180);

    searchDebounceTimer = setTimeout(() => {
      executePlantSearch(val);
    }, 380);
  }

  WM.inat = {
    init,
    initVisionUI,
    enable,
    disable,
    setConfig,
    getConfig: () => config,
    refresh: () => loadObservationsForView(true),
    exportCurrentViewJson,
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
    fetchFilterObservationsForCurrentView,
    openListModal,
    closeListModal,
    openObservationCard,
    filterByTaxon,
    // Экспортируемые функции для основного поиска:
    fetchTaxaAutocomplete,
    searchObservations,
    getTaxonMeta,
    getTaxonIcon,
    highlightObservationZone
  };
})();