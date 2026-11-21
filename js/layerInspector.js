/**
 * js/layerInspector.js
 * Инспектор слоёв экрана и сетевой журнал (Рельеф DEM, Вода/Волны, OSM, Лес Canopy).
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const MAX_LOGS = 350;
  const logs = [];
  let logSeq = 0;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[m]));

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function fmtBytes(b) {
    if (!b || b <= 0) return '0 Б';
    if (b < 1024) return b + ' Б';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ';
    return (b / 1048576).toFixed(2) + ' МБ';
  }

  function shortUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      let path = u.pathname + u.search;
      if (path.length > 52) path = path.slice(0, 26) + '…' + path.slice(-22);
      return u.host + path;
    } catch (e) {
      return url.length > 72 ? url.slice(0, 72) + '…' : url;
    }
  }

  // =========================================================================
  // 1. ЖУРНАЛ СОБЫТИЙ (WM.layerDiag)
  // =========================================================================
  const layerDiag = {
    log(channel, stage, info = {}) {
      const entry = {
        id: ++logSeq,
        ts: Date.now(),
        channel, // 'dem' | 'water' | 'osm' | 'canopy'
        stage,   // 'net' | 'cache-idb' | 'fallback' | 'token' | 'render' | 'skip' | 'error'
        ...info
      };
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.shift();
      if (isOpen && autoRefresh) scheduleUiRefresh();
    },
    getLogs(filterChannel = 'all', onlyErrors = false) {
      return logs.filter(e => {
        if (filterChannel !== 'all' && e.channel !== filterChannel) return false;
        if (onlyErrors) {
          return e.outcome === 'error' || e.outcome === 'failed' || e.outcome === 'circuit-open' || e.outcome === 'empty-cleared';
        }
        return true;
      });
    },
    clear() {
      logs.length = 0;
      renderBody();
    }
  };
  WM.layerDiag = layerDiag;

  // =========================================================================
  // 2. СБОР ЖИВОГО СОСТОЯНИЯ ЭКРАНА И АВТОДИАГНОСТИКА
  // =========================================================================
  function getViewportTileBounds(map, z) {
    if (!map || typeof z !== 'number') return null;
    const b = map.getBounds();
    const nw = map.project(b.getNorthWest(), z);
    const se = map.project(b.getSouthEast(), z);
    return {
      minX: Math.floor(nw.x / 256),
      maxX: Math.floor(se.x / 256),
      minY: Math.floor(nw.y / 256),
      maxY: Math.floor(se.y / 256)
    };
  }

  function isInVp(c, vp) {
    if (!vp || !c) return false;
    return c.x >= vp.minX && c.x <= vp.maxX && c.y >= vp.minY && c.y <= vp.maxY;
  }

  function countMissingGridTiles(tilesArr, vp, z) {
    if (!vp) return [];
    const present = new Set(tilesArr.filter(t => t.coords && t.coords.z === z && !t.removed).map(t => `${t.coords.x}:${t.coords.y}`));
    const missing = [];
    for (let y = vp.minY; y <= vp.maxY; y++) {
      for (let x = vp.minX; x <= vp.maxX; x++) {
        if (!present.has(`${x}:${y}`)) missing.push(`${z}/${x}/${y}`);
      }
    }
    return missing;
  }

  async function collectFullDiagnostics() {
    const map = WM.map;
    const center = map ? map.getCenter() : null;
    const zoom = map ? map.getZoom() : null;

    const demSnap = WM.demRelief?.getDebugSnapshot ? WM.demRelief.getDebugSnapshot() : null;
    const osmSnap = WM.vectorRoads?.getDebugSnapshot ? WM.vectorRoads.getDebugSnapshot() : null;
    const canSnap = WM.canopy?.getDebugSnapshot ? WM.canopy.getDebugSnapshot() : null;

    let quota = null;
    if (navigator.storage?.estimate) {
      try { quota = await navigator.storage.estimate(); } catch (e) {}
    }

    // Разметка попадания тайлов в текущий экран
    const vpInfo = {};
    if (map) {
      if (demSnap) {
        const vp = getViewportTileBounds(map, demSnap.hillshadeTileZoom);
        demSnap.vp = vp;
        demSnap.tiles.forEach(t => { t.inVp = isInVp(t.coords, vp) && t.coords.z === demSnap.hillshadeTileZoom; });
        demSnap.missingTiles = demSnap.cfg.hillshadeEnabled ? countMissingGridTiles(demSnap.tiles, vp, demSnap.hillshadeTileZoom) : [];
        vpInfo.demZoom = demSnap.hillshadeTileZoom;
      }
      if (osmSnap) {
        const vpR = getViewportTileBounds(map, osmSnap.roadsTileZoom);
        const vpL = getViewportTileBounds(map, osmSnap.labelsTileZoom);
        osmSnap.vp = vpR;
        osmSnap.roadTiles.forEach(t => { t.inVp = isInVp(t.coords, vpR) && t.coords.z === osmSnap.roadsTileZoom; });
        osmSnap.labelTiles.forEach(t => { t.inVp = isInVp(t.coords, vpL) && t.coords.z === osmSnap.labelsTileZoom; });
        osmSnap.missingRoadTiles = (osmSnap.cfg.enabled && Math.round(zoom) >= 9)
          ? countMissingGridTiles(osmSnap.roadTiles, vpR, osmSnap.roadsTileZoom) : [];
      }
      if (canSnap) {
        const vp = getViewportTileBounds(map, canSnap.treesTileZoom);
        canSnap.vp = vp;
        canSnap.tiles.forEach(t => { t.inVp = isInVp(t.coords, vp) && t.coords.z === canSnap.treesTileZoom; });
        canSnap.missingTiles = (canSnap.settings.treesEnabled && Math.round(zoom) >= 11)
          ? countMissingGridTiles(canSnap.tiles, vp, canSnap.treesTileZoom) : [];
      }
    }

    // Авто-диагноз проблем (почему экран может быть пустым)
    const issues = [];
    if (navigator.onLine === false) {
      issues.push({ level: 'warn', ch: 'net', text: 'Устройство в офлайн-режиме (navigator.onLine = false) — берутся только кэшированные тайлы и родительские зумы.' });
    }

    if (demSnap) {
      if (!demSnap.cfg.hillshadeEnabled) {
        issues.push({ level: 'info', ch: 'dem', text: 'Слой 3D-рельефа (hillshadeEnabled) выключен.' });
      } else if (!demSnap.layerOnMap) {
        issues.push({ level: 'err', ch: 'dem', text: 'hillshadeEnabled = true, но слой не добавлен на карту Leaflet!' });
      }
      if (demSnap.cfg.hillshadeEnabled && (!demSnap.webgl.ok || demSnap.webgl.contextLost)) {
        issues.push({ level: 'err', ch: 'dem', text: 'WebGL2 контекст отсутствует или потерян — GPU-отмывка не может отрисоваться!' });
      }
      const vpDem = demSnap.tiles.filter(t => t.inVp);
      const emptyDem = vpDem.filter(t => t.dem.emptyFallback);
      const degDem = vpDem.filter(t => t.dem.degraded);
      if (emptyDem.length > 0) {
        issues.push({ level: 'err', ch: 'dem', text: `На экране ${emptyDem.length}/${vpDem.length} тайлов DEM пустые (emptyFallback) — холст очищен!` });
      }
      if (degDem.length > 0) {
        issues.push({ level: 'warn', ch: 'dem', text: `На экране ${degDem.length}/${vpDem.length} тайлов DEM в деградации (ошибка сети/соседа/зум-фоллбэк).` });
      }
      const openEps = demSnap.circuitBreakers.filter(e => e.isOpen);
      if (openEps.length > 0) {
        issues.push({ level: 'warn', ch: 'dem', text: `Заблокированы провайдеры DEM (Circuit Breaker): ${openEps.map(e => e.label).join(', ')}` });
      }
      if (demSnap.caches.paddedWeight >= demSnap.caches.paddedMaxWeight) {
        issues.push({ level: 'warn', ch: 'dem', text: `Кэш склеенных DEM тайлов заполнен (${demSnap.caches.paddedWeight}/${demSnap.caches.paddedMaxWeight}) — старые тайлы вытесняются.` });
      }

      // Вода
      if (demSnap.cfg.seaWavesEnabled && !demSnap.cfg.hillshadeEnabled) {
        issues.push({ level: 'warn', ch: 'water', text: 'Гравюрные волны включены, но выключен 3D-рельеф — волны рендерятся внутри шейдера рельефа!' });
      }
      if (demSnap.cfg.hillshadeEnabled) {
        const vpW = vpDem;
        const wFailed = vpW.filter(t => t.water.failed);
        const wFb = vpW.filter(t => t.water.isFallback);
        const wNoMask = vpW.filter(t => !t.water.hasMask);
        if (wFailed.length > 0 || wFb.length > 0) {
          issues.push({ level: 'warn', ch: 'water', text: `Маска воды (ESA 10м): ${wFailed.length} тайлов с ошибкой, ${wFb.length} на родительском фоллбэке (включён резерв по DEM ≤0.25м).` });
        } else if (vpW.length > 0 && wNoMask.length === vpW.length) {
          issues.push({ level: 'warn', ch: 'water', text: 'Маска воды ещё не загружена ни на одном тайле экрана.' });
        }
        const openW = demSnap.waterNet.states.filter(s => s.isOpen);
        if (openW.length === demSnap.waterNet.states.length) {
          issues.push({ level: 'err', ch: 'water', text: 'Все 4 зеркала маски воды (WaterNet) заблокированы по сбоям!' });
        } else if (openW.length > 0) {
          issues.push({ level: 'info', ch: 'water', text: `Отключённые зеркала воды: ${openW.map(s => s.name).join(', ')}` });
        }
      }
    }

    if (osmSnap) {
      if (!osmSnap.cfg.enabled) {
        issues.push({ level: 'info', ch: 'osm', text: 'Слой векторной графики OSM выключен.' });
      } else if (zoom !== null && Math.round(zoom) < 9) {
        issues.push({ level: 'info', ch: 'osm', text: `Текущий зум (${zoom.toFixed(1)}) < minZoom 9 — слой OSM скрыт по масштабу.` });
      } else {
        const vpR = osmSnap.roadTiles.filter(t => t.inVp);
        const failR = vpR.filter(t => !t.mvtOk);
        if (failR.length > 0) {
          issues.push({ level: 'err', ch: 'osm', text: `Вектор OSM: не загрузились данные MVT для ${failR.length}/${vpR.length} видимых тайлов.` });
        }
        if (osmSnap.omt.skipped) {
          issues.push({ level: 'warn', ch: 'osm', text: 'Источник OpenFreeMap (пики/парки) временно пропущен после серии ошибок — используется VersaTiles.' });
        }
      }
    }

    if (canSnap) {
      if (!canSnap.settings.treesEnabled && !canSnap.settings.heightEnabled && !canSnap.settings.maskEnabled) {
        issues.push({ level: 'info', ch: 'canopy', text: 'Все слои растительности (2D Лес, Высота, Маска) выключены.' });
      } else if (canSnap.settings.treesEnabled && zoom !== null && Math.round(zoom) < 11) {
        issues.push({ level: 'info', ch: 'canopy', text: `Текущий зум (${zoom.toFixed(1)}) < minZoom 11 — 2D Лес отображается начиная с 11 зума.` });
      } else if (canSnap.settings.treesEnabled) {
        const vpC = canSnap.tiles.filter(t => t.inVp);
        const failC = vpC.filter(t => t.diag?.state === 'cooldown' || t.diag?.state === 'missing');
        const zeroC = vpC.filter(t => t.isZero);
        const degC = vpC.filter(t => t.isDegraded);
        if (failC.length > 0) {
          issues.push({ level: 'err', ch: 'canopy', text: `Лес: ${failC.length}/${vpC.length} тайлов без данных высот (ошибка/кулдаун 30с).` });
        }
        if (degC.length > 0) {
          issues.push({ level: 'warn', ch: 'canopy', text: `Лес: ${degC.length} тайлов перерисованы по кэшу родительского зума.` });
        }
        if (vpC.length > 0 && zeroC.length === vpC.length) {
          issues.push({ level: 'info', ch: 'canopy', text: 'Все видимые тайлы леса вернули ZERO (пусто/вода/нет данных крон в этом районе).' });
        }
        if (canSnap.caches.spriteBytes >= canSnap.caches.spriteBytesLimit * 0.9 || canSnap.caches.spriteCount >= canSnap.caches.maxSprites * 0.9) {
          issues.push({ level: 'warn', ch: 'canopy', text: `Кэш спрайтов деревьев близок к лимиту (${fmtBytes(canSnap.caches.spriteBytes)} / ${fmtBytes(canSnap.caches.spriteBytesLimit)}, ${canSnap.caches.spriteCount}/${canSnap.caches.maxSprites} шт.).` });
        }
        if (canSnap.caches.dataCacheSize >= canSnap.caches.dataCacheLimit) {
          issues.push({ level: 'warn', ch: 'canopy', text: `RAM-кэш высот деревьев заполнен (${canSnap.caches.dataCacheSize}/${canSnap.caches.dataCacheLimit}) — идёт вытеснение старых тайлов.` });
        }
        const deadCan = canSnap.net.states.filter(s => !s.alive);
        if (deadCan.length === canSnap.net.states.length) {
          issues.push({ level: 'err', ch: 'canopy', text: 'Все 3 зеркала Canopy (GEE / Cloudflare / Yandex) в блокировке!' });
        }
      }
    }

    return {
      ts: Date.now(),
      online: navigator.onLine !== false,
      env: {
        zoom: zoom !== null ? +zoom.toFixed(2) : null,
        center: center ? { lat: +center.lat.toFixed(5), lng: +center.lng.toFixed(5) } : null,
        dpr: window.devicePixelRatio || 1,
        memGB: navigator.deviceMemory || null,
        cores: navigator.hardwareConcurrency || null,
        storageUsage: quota?.usage || null,
        storageQuota: quota?.quota || null
      },
      issues,
      dem: demSnap,
      osm: osmSnap,
      canopy: canSnap,
      logs: logs.slice(-150)
    };
  }

  // =========================================================================
  // 3. ГЕНЕРАЦИЯ ТЕКСТОВОГО ОТЧЁТА ДЛЯ КОПИРОВАНИЯ
  // =========================================================================
  async function buildReportText() {
    const d = await collectFullDiagnostics();
    const lines = [];
    lines.push(`=== WIKIMAPIA VIEWER: ОТЧЁТ ДИАГНОСТИКИ СЛОЁВ ===`);
    lines.push(`Время: ${new Date(d.ts).toLocaleString('ru-RU')}`);
    lines.push(`Сеть: ${d.online ? 'ONLINE' : 'OFFLINE'} | Зум: ${d.env.zoom} | Центр: ${d.env.center ? `${d.env.center.lat}, ${d.env.center.lng}` : '--'}`);
    lines.push(`Устройство: DPR=${d.env.dpr}, RAM~${d.env.memGB || '?'}GB, CPU=${d.env.cores || '?'} | Storage: ${fmtBytes(d.env.storageUsage)} / ${fmtBytes(d.env.storageQuota)}`);
    lines.push('');

    lines.push(`[АВТОДИАГНОЗ / ПРЕДУПРЕЖДЕНИЯ]`);
    if (!d.issues.length) lines.push(`✅ Критических проблем не обнаружено.`);
    else d.issues.forEach(it => lines.push(`- [${it.level.toUpperCase()}][${it.ch}] ${it.text}`));
    lines.push('');

    if (d.dem) {
      const vpDem = d.dem.tiles.filter(t => t.inVp);
      lines.push(`[1. СЛОЙ РЕЛЬЕФА (DEM)]`);
      lines.push(`Включён: ${d.dem.cfg.hillshadeEnabled} (на карте: ${d.dem.layerOnMap}) | Источник: ${d.dem.cfg.demSource} | WebGL2: ${d.dem.webgl.ok ? (d.dem.webgl.contextLost ? 'LOST' : 'OK') : 'NO'}`);
      lines.push(`Тайлы на экране (z${d.dem.hillshadeTileZoom}): всего=${vpDem.length}, пропущено=${d.dem.missingTiles.length}, пустых=${vpDem.filter(t => t.dem.emptyFallback).length}, деград.=${vpDem.filter(t => t.dem.degraded).length}`);
      lines.push(`Кэши DEM: raw=${d.dem.caches.rawSize}/${d.dem.caches.rawMax}, paddedWeight=${d.dem.caches.paddedWeight}/${d.dem.caches.paddedMaxWeight}, inFlight=${d.dem.caches.demInFlight}/${d.dem.caches.paddedInFlight}, slots=${d.dem.parallel.demActive}/${d.dem.parallel.demMax} (wait=${d.dem.parallel.demWaiters})`);
      lines.push(`Очереди рендера: asm=${d.dem.queues.asm}, incoming=${d.dem.queues.incoming}`);
      lines.push(`Circuit Breakers DEM: ${d.dem.circuitBreakers.map(c => `${c.label}:${c.isOpen ? 'OPEN' : 'OK'}(f=${c.fails})`).join(' | ')}`);
      vpDem.forEach(t => {
        lines.push(`  • ${t.key}: prov=${t.dem.provider || 'none'} src=${t.dem.fromCache ? 'cache' : (t.dem.fromParentCrop ? 'parent' : 'net')} empty=${t.dem.emptyFallback} deg=${t.dem.degraded} size=${t.dem.tileSize || 0} glTex=${t.dem.hasDemTex && t.dem.hasGBuf}`);
      });
      lines.push('');

      lines.push(`[2. СЛОЙ ВОДЫ (МАСКА ВОЛН)]`);
      lines.push(`Волны: ${d.dem.cfg.seaWavesEnabled} | Заливка: ${d.dem.cfg.waterTintEnabled} | Берег: ${d.dem.cfg.waterlining} | Токен GEE: ${d.dem.waterNet.hasToken}`);
      lines.push(`Кэш масок: ${d.dem.caches.waterSize}/64 | Slots: ${d.dem.parallel.waterActive}/${d.dem.parallel.waterMax} (wait=${d.dem.parallel.waterWaiters}) | Ретраи: ${d.dem.waterNet.retryAttempt}/5`);
      lines.push(`Зеркала WaterNet: ${d.dem.waterNet.states.map(s => `${s.name}:${s.isOpen ? 'OPEN' : 'OK'}(f=${s.fails})`).join(' | ')}`);
      vpDem.forEach(t => {
        lines.push(`  • ${t.key}: hasMask=${t.water.hasMask} hasWater=${t.water.hasWater} empty404=${t.water.isEmpty404} fallback=${t.water.isFallback} failed=${t.water.failed} tex=${t.water.hasTex}`);
      });
      lines.push('');
    }

    if (d.osm) {
      const vpR = d.osm.roadTiles.filter(t => t.inVp);
      const vpL = d.osm.labelTiles.filter(t => t.inVp);
      lines.push(`[3. СЛОЙ OSM (ВЕКТОР И ПОДПИСИ)]`);
      lines.push(`Включён: ${d.osm.cfg.enabled} | На карте: ${d.osm.layerOnMap} | Зум: roads=${d.osm.roadsTileZoom}, labels=${d.osm.labelsTileZoom}`);
      lines.push(`Тайлы на экране: roads=${vpR.length} (ok=${vpR.filter(t => t.mvtOk).length}, miss=${d.osm.missingRoadTiles.length}), labels=${vpL.length} (ok=${vpL.filter(t => t.mvtOk).length})`);
      lines.push(`Кэши OSM: MVT=${d.osm.caches.mvtSize}/${d.osm.caches.mvtMax}, OMT=${d.osm.caches.omtSize}/${d.osm.caches.omtMax}, segs=${d.osm.caches.roadSegs}, rivers=${d.osm.caches.rivers}, featMask=${d.osm.caches.featMask}`);
      lines.push(`Очередь рендера: ${d.osm.renderQueue}, moving=${d.osm.cameraMoving} | Коллизии подписей: names=${d.osm.labelsMgr.names}, boxesTiles=${d.osm.labelsMgr.tiles} | OFM skip=${d.osm.omt.skipped} (streak=${d.osm.omt.failStreak})`);
      vpR.forEach(t => {
        lines.push(`  • road ${t.key}: mvtOk=${t.mvtOk} omtDone=${t.omtDone} cv=${t.canvasSize}`);
      });
      lines.push('');
    }

    if (d.canopy) {
      const vpC = d.canopy.tiles.filter(t => t.inVp);
      lines.push(`[4. СЛОЙ ЛЕСОВ (CANOPY)]`);
      lines.push(`Trees: ${d.canopy.settings.treesEnabled} | Height: ${d.canopy.settings.heightEnabled} | Mask: ${d.canopy.settings.maskEnabled} | Ver: ${d.canopy.settings.canopyVersion} | Style: ${d.canopy.settings.treeStyle}`);
      lines.push(`Токены GEE: loaded=${d.canopy.tokens.isLoaded} (h=${d.canopy.tokens.hasHeight}, m=${d.canopy.tokens.hasMask}, sp=${d.canopy.tokens.hasSpecies})`);
      lines.push(`Зеркала CanopyNet: ${d.canopy.net.states.map(s => `${s.name}:${s.alive ? 'OK' : 'OPEN'}(f=${s.fails}${s.lastError ? ', ' + s.lastError : ''})`).join(' | ')}`);
      lines.push(`Кэши: data=${d.canopy.caches.dataCacheSize}/${d.canopy.caches.dataCacheLimit}, species=${d.canopy.caches.speciesCacheSize}/${d.canopy.caches.dataCacheLimit}, trees=${d.canopy.caches.tileTreesCacheSize}/64, sprites=${d.canopy.caches.spriteCount}/${d.canopy.caches.maxSprites} (${fmtBytes(d.canopy.caches.spriteBytes)}/${fmtBytes(d.canopy.caches.spriteBytesLimit)})`);
      lines.push(`Slots: ${d.canopy.parallel.active}/${d.canopy.parallel.max} (wait=${d.canopy.parallel.waiting}) | Cooldowns: h=${d.canopy.caches.failedHeightCooldown}, sp=${d.canopy.caches.failedSpeciesCooldown} | Queue: ${d.canopy.caches.renderQueue}`);
      vpC.forEach(t => {
        lines.push(`  • ${t.key}: state=${t.diag?.state || '?'} drawn=${t.diag?.drawn ?? 0}/${t.diag?.planned ?? 0} inRam=${t.hasGridInRam} zero=${t.isZero} deg=${t.isDegraded} cooldown=${t.inCooldown} needsDem=${t.needsDem}`);
      });
      lines.push('');
    }

    lines.push(`[ПОСЛЕДНИЕ СОБЫТИЯ ЖУРНАЛА (${d.logs.length})]`);
    d.logs.slice(-80).forEach(e => {
      const coord = (e.z != null) ? `${e.z}/${e.x}/${e.y}` : '';
      const meta = [
        coord,
        e.mirror || e.provider || '',
        e.status ? `HTTP ${e.status}` : '',
        e.bytes ? fmtBytes(e.bytes) : '',
        e.ms != null ? `${e.ms}ms` : '',
        e.error || e.note || '',
        e.url ? shortUrl(e.url) : ''
      ].filter(Boolean).join(' | ');
      lines.push(`${fmtTime(e.ts)} [${e.channel.toUpperCase()}][${e.stage}][${e.outcome || ''}] ${meta}`);
    });

    return lines.join('\n');
  }

  // =========================================================================
  // 4. UI МОДАЛЬНОГО ОКНА ИНСПЕКТОРА
  // =========================================================================
  let modalEl = null;
  let isOpen = false;
  let activeTab = 'overview';
  let logFilter = 'all';
  let logOnlyErrors = false;
  let autoRefresh = false;
  let autoTimer = 0;
  let refreshRaf = 0;

  function ensureStyles() {
    if (document.getElementById('wm-li-style')) return;
    const st = document.createElement('style');
    st.id = 'wm-li-style';
    st.textContent = `
.li-box{max-width:740px;width:96%;max-height:90vh;display:flex;flex-direction:column}
.li-tabs{display:flex;gap:4px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--bg-secondary);overflow-x:auto;flex-shrink:0}
.li-tab{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);color:var(--text-main);font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;transition:.15s}
.li-tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.li-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;background:var(--bg-primary);border-bottom:1px solid var(--border);font-size:11.5px;flex-wrap:wrap}
.li-body{padding:10px 12px;overflow-y:auto;flex:1;font-size:12px}
.li-card{border:1px solid var(--border);border-radius:10px;padding:9px 11px;margin-bottom:9px;background:var(--bg-primary)}
.li-card-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-weight:800;font-size:13px}
.li-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:700;border:1px solid transparent}
.li-b-ok{background:rgba(16,185,129,.15);color:#10b981;border-color:rgba(16,185,129,.35)}
.li-b-warn{background:rgba(245,158,11,.15);color:#d97706;border-color:rgba(245,158,11,.35)}
.li-b-err{background:rgba(239,68,68,.15);color:#ef4444;border-color:rgba(239,68,68,.35)}
.li-b-off{background:var(--bg-secondary);color:var(--text-muted);border-color:var(--border)}
.li-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-top:6px}
.li-stat{background:var(--bg-secondary);border:1px solid var(--border);border-radius:7px;padding:5px 8px}
.li-stat small{display:block;font-size:10px;color:var(--text-muted)}
.li-stat b{font-size:12px;color:var(--text-main);font-family:ui-monospace,monospace}
.li-issue{padding:6px 9px;border-radius:8px;margin-bottom:5px;font-size:11.5px;line-height:1.35;border:1px solid var(--border)}
.li-issue.err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#ef4444}
.li-issue.warn{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.4);color:#d97706}
.li-issue.info{background:var(--bg-secondary);color:var(--text-muted)}
.li-tbl-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;margin-top:6px}
.li-tbl{width:100%;border-collapse:collapse;font-size:11px;font-family:ui-monospace,monospace}
.li-tbl th,.li-tbl td{padding:4px 7px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
.li-tbl th{background:var(--bg-secondary);color:var(--text-muted);font-weight:700}
.li-tbl tr:last-child td{border-bottom:none}
.li-log-list{display:flex;flex-direction:column;gap:4px;font-family:ui-monospace,monospace;font-size:10.8px}
.li-log-row{padding:5px 8px;border-radius:7px;background:var(--bg-secondary);border-left:3px solid var(--border);word-break:break-word;line-height:1.35}
.li-log-row.ok{border-left-color:#10b981}
.li-log-row.warn{border-left-color:#f59e0b}
.li-log-row.err{border-left-color:#ef4444;background:rgba(239,68,68,.08)}
.li-chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.li-chip{padding:3px 9px;border-radius:999px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-main);font-size:11px;cursor:pointer}
.li-chip.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.li-progress-bar{height:6px;border-radius:4px;background:var(--bg-secondary);overflow:hidden;margin-top:4px;border:1px solid var(--border)}
.li-progress-bar>div{height:100%;background:var(--accent)}
`;
    document.head.appendChild(st);
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    ensureStyles();
    const div = document.createElement('div');
    div.id = 'wm-layer-inspector';
    div.className = 'modal-overlay';
    div.style.zIndex = '10050';
    div.innerHTML = `
      <div class="modal-box li-box">
        <div class="modal-header">
          <h3 style="margin:0;font-size:15px;">🛰️ Инспектор слоёв экрана и журнал сети</h3>
          <button type="button" class="modal-close-x" id="wm-li-close-x" title="Закрыть">✕</button>
        </div>
        <div class="li-tabs">
          <button type="button" class="li-tab active" data-li-tab="overview">📊 Сводка</button>
          <button type="button" class="li-tab" data-li-tab="dem">⛰️ Рельеф</button>
          <button type="button" class="li-tab" data-li-tab="water">🌊 Вода</button>
          <button type="button" class="li-tab" data-li-tab="osm">🛤️ OSM</button>
          <button type="button" class="li-tab" data-li-tab="canopy">🌲 Лес</button>
          <button type="button" class="li-tab" data-li-tab="logs">📜 Журнал</button>
        </div>
        <div class="li-toolbar">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span id="wm-li-env-line" style="font-family:ui-monospace,monospace;color:var(--text-muted);">--</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" id="wm-li-auto"> <span>Авто (1с)</span>
            </label>
            <button type="button" class="btn btn-secondary" id="wm-li-refresh" style="font-size:11px;padding:4px 8px;">🔄 Обновить</button>
            <button type="button" class="btn btn-secondary" id="wm-li-clear" style="font-size:11px;padding:4px 8px;">🧹 Очистить лог</button>
          </div>
        </div>
        <div class="li-body" id="wm-li-body"></div>
        <div class="modal-footer" style="display:flex;justify-content:space-between;gap:8px;">
          <button type="button" class="btn btn-secondary" id="wm-li-copy">📋 Скопировать отчёт</button>
          <button type="button" class="btn btn-primary" id="wm-li-close-btn">Закрыть</button>
        </div>
      </div>
    `;
    document.body.appendChild(div);
    modalEl = div;

    div.addEventListener('click', e => {
      if (e.target === div) close();
    });
    div.querySelector('#wm-li-close-x').onclick = close;
    div.querySelector('#wm-li-close-btn').onclick = close;
    div.querySelector('#wm-li-refresh').onclick = () => renderBody();
    div.querySelector('#wm-li-clear').onclick = () => layerDiag.clear();
    div.querySelector('#wm-li-auto').onchange = e => {
      autoRefresh = e.target.checked;
      clearInterval(autoTimer);
      if (autoRefresh && isOpen) {
        autoTimer = setInterval(() => renderBody(), 1000);
      }
    };
    div.querySelector('#wm-li-copy').onclick = copyReport;

    div.querySelectorAll('.li-tab').forEach(btn => {
      btn.onclick = () => {
        activeTab = btn.dataset.liTab;
        div.querySelectorAll('.li-tab').forEach(b => b.classList.toggle('active', b.dataset.liTab === activeTab));
        renderBody();
      };
    });

    return div;
  }

  function scheduleUiRefresh() {
    if (refreshRaf) return;
    refreshRaf = requestAnimationFrame(() => {
      refreshRaf = 0;
      if (isOpen) renderBody();
    });
  }

  function renderLogRows(list) {
    if (!list.length) return `<div style="color:var(--text-muted);padding:10px 0;">Записей пока нет. Сдвиньте карту или нажмите 🔄 на панели рельефа.</div>`;
    return `<div class="li-log-list">${list.slice().reverse().map(e => {
      const isErr = e.outcome === 'error' || e.outcome === 'failed' || e.outcome === 'circuit-open';
      const isWarn = e.outcome === 'fallback-parent' || e.outcome === 'empty-404' || e.outcome === 'empty-cleared' || e.outcome === 'token-404' || e.outcome === 'absent-skip' || e.outcome === 'cell-miss-limit';
      const cls = isErr ? 'err' : (isWarn ? 'warn' : 'ok');
      const coord = (e.z != null) ? `<b>${e.z}/${e.x}/${e.y}</b>` : '';
      const info = [
        coord,
        e.mirror || e.provider || '',
        e.status ? `HTTP ${e.status}` : '',
        e.bytes ? fmtBytes(e.bytes) : '',
        e.ms != null ? `${e.ms}ms` : '',
        e.hasWater !== undefined ? (e.hasWater ? '💧вода' : 'суша') : '',
        e.error || e.note || ''
      ].filter(Boolean).join(' · ');
      return `
        <div class="li-log-row ${cls}">
          <div><span style="color:var(--text-muted);">${fmtTime(e.ts)}</span> <b>[${esc(e.channel.toUpperCase())}]</b> [${esc(e.stage)} → ${esc(e.outcome || '')}] ${info}</div>
          ${e.url ? `<div style="color:var(--text-muted);font-size:10px;">${esc(shortUrl(e.url))}</div>` : ''}
        </div>`;
    }).join('')}</div>`;
  }

  function statusBadge(label, kind) {
    const cls = kind === 'ok' ? 'li-b-ok' : (kind === 'warn' ? 'li-b-warn' : (kind === 'err' ? 'li-b-err' : 'li-b-off'));
    return `<span class="li-badge ${cls}">${esc(label)}</span>`;
  }

  function renderMemMeter(label, cur, max, unit = '') {
    const pct = max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0;
    const color = pct >= 90 ? '#ef4444' : (pct >= 70 ? '#f59e0b' : '#10b981');
    return `
      <div class="li-stat">
        <small>${esc(label)}</small>
        <b>${esc(cur)}${unit} / ${esc(max)}${unit} (${pct}%)</b>
        <div class="li-progress-bar"><div style="width:${pct}%;background:${color};"></div></div>
      </div>`;
  }

  async function renderBody() {
    if (!modalEl || !isOpen) return;
    const body = document.getElementById('wm-li-body');
    const envLine = document.getElementById('wm-li-env-line');
    if (!body) return;

    const prevScroll = body.scrollTop;
    const d = await collectFullDiagnostics();

    if (envLine) {
      envLine.innerHTML = `${d.online ? '🟢 Онлайн' : '🔴 Офлайн'} · z<b>${d.env.zoom ?? '?'}</b> · ${d.env.center ? `${d.env.center.lat}, ${d.env.center.lng}` : ''} · RAM ${d.env.storageUsage ? fmtBytes(d.env.storageUsage) : '?'}`;
    }

    if (activeTab === 'overview') {
      const vpDem = d.dem ? d.dem.tiles.filter(t => t.inVp) : [];
      const vpR = d.osm ? d.osm.roadTiles.filter(t => t.inVp) : [];
      const vpC = d.canopy ? d.canopy.tiles.filter(t => t.inVp) : [];

      const demOk = vpDem.filter(t => t.dem.hasImg && !t.dem.emptyFallback && !t.dem.degraded).length;
      const watOk = vpDem.filter(t => t.water.hasMask && !t.water.isFallback && !t.water.failed).length;
      const osmOk = vpR.filter(t => t.mvtOk).length;
      const canOk = vpC.filter(t => t.diag?.state === 'ok').length;

      body.innerHTML = `
        <div class="li-card">
          <div class="li-card-h"><span>🩺 Диагностика текущего экрана</span>${statusBadge(d.issues.some(i => i.level === 'err') ? 'Есть ошибки' : (d.issues.some(i => i.level === 'warn') ? 'Внимание' : 'Норма'), d.issues.some(i => i.level === 'err') ? 'err' : (d.issues.some(i => i.level === 'warn') ? 'warn' : 'ok'))}</div>
          ${d.issues.length
            ? d.issues.map(i => `<div class="li-issue ${i.level}"><b>[${esc(i.ch.toUpperCase())}]</b> ${esc(i.text)}</div>`).join('')
            : '<div style="color:#10b981;font-weight:600;">✅ Все активные слои на экране загружены и отображаются корректно.</div>'}
        </div>

        <div class="li-kv">
          <div class="li-card" style="margin:0;">
            <div class="li-card-h"><span>⛰️ Рельеф</span>${statusBadge(d.dem?.cfg.hillshadeEnabled ? `${demOk}/${vpDem.length}` : 'Выкл', d.dem?.cfg.hillshadeEnabled ? (demOk === vpDem.length && vpDem.length ? 'ok' : 'warn') : 'off')}</div>
            <div>Источник: <b>${esc(d.dem?.cfg.demSource || '--')}</b></div>
            <div>WebGL2: <b>${d.dem?.webgl.ok ? (d.dem.webgl.contextLost ? '🔴 Потерян' : '🟢 OK') : '🔴 Нет'}</b></div>
            <div>Пропущено тайлов: <b>${d.dem?.missingTiles?.length || 0}</b></div>
          </div>

          <div class="li-card" style="margin:0;">
            <div class="li-card-h"><span>🌊 Вода / Волны</span>${statusBadge(d.dem?.cfg.hillshadeEnabled ? `${watOk}/${vpDem.length}` : 'Нет рельефа', d.dem?.cfg.hillshadeEnabled ? (watOk === vpDem.length && vpDem.length ? 'ok' : 'warn') : 'off')}</div>
            <div>Волны: <b>${d.dem?.cfg.seaWavesEnabled ? 'Вкл' : 'Выкл'}</b> · Токен: <b>${d.dem?.waterNet.hasToken ? 'Есть' : 'Нет'}</b></div>
            <div>С водой: <b>${vpDem.filter(t => t.water.hasWater).length}</b> · Фолбэк: <b>${vpDem.filter(t => t.water.isFallback).length}</b></div>
            <div>Ошибок: <b>${vpDem.filter(t => t.water.failed).length}</b></div>
          </div>

          <div class="li-card" style="margin:0;">
            <div class="li-card-h"><span>🛤️ OSM</span>${statusBadge(d.osm?.cfg.enabled ? `${osmOk}/${vpR.length}` : 'Выкл', d.osm?.cfg.enabled ? (osmOk === vpR.length && vpR.length ? 'ok' : 'warn') : 'off')}</div>
            <div>Зум слоя: <b>z${d.osm?.roadsTileZoom ?? '--'}</b> (min 9)</div>
            <div>Очередь рендера: <b>${d.osm?.renderQueue ?? 0}</b></div>
            <div>Кэш MVT: <b>${d.osm?.caches.mvtSize ?? 0}/${d.osm?.caches.mvtMax ?? 0}</b></div>
          </div>

          <div class="li-card" style="margin:0;">
            <div class="li-card-h"><span>🌲 Лес</span>${statusBadge(d.canopy?.settings.treesEnabled ? `${canOk}/${vpC.length}` : 'Выкл', d.canopy?.settings.treesEnabled ? (canOk > 0 ? 'ok' : 'warn') : 'off')}</div>
            <div>Версия: <b>${esc(d.canopy?.settings.canopyVersion || 'v1')}</b> · Стиль: <b>${esc(d.canopy?.settings.treeStyle || '--')}</b></div>
            <div>Кэш высот: <b>${d.canopy?.caches.dataCacheSize ?? 0}/${d.canopy?.caches.dataCacheLimit ?? 128}</b></div>
            <div>Спрайты: <b>${fmtBytes(d.canopy?.caches.spriteBytes || 0)}</b></div>
          </div>
        </div>
      `;
    } else if (activeTab === 'dem' && d.dem) {
      const vpDem = d.dem.tiles.filter(t => t.inVp);
      body.innerHTML = `
        <div class="li-card">
          <div class="li-card-h"><span>⛰️ Ресурсы, лимиты и WebGL2</span>${statusBadge(d.dem.webgl.ok ? 'WebGL2 OK' : 'WebGL2 ERROR', d.dem.webgl.ok ? 'ok' : 'err')}</div>
          <div class="li-kv">
            ${renderMemMeter('RAM Padded кэш (вес)', d.dem.caches.paddedWeight, d.dem.caches.paddedMaxWeight)}
            ${renderMemMeter('RAM Raw тайлы', d.dem.caches.rawSize, d.dem.caches.rawMax)}
            ${renderMemMeter('Сетевые слоты DEM', d.dem.parallel.demActive, d.dem.parallel.demMax)}
            <div class="li-stat"><small>Очереди (wait / asm / in)</small><b>${d.dem.parallel.demWaiters} / ${d.dem.queues.asm} / ${d.dem.queues.incoming}</b></div>
          </div>
          <div style="margin-top:8px;font-weight:700;">Провайдеры (Circuit Breakers):</div>
          <div class="li-tbl-wrap"><table class="li-tbl"><thead><tr><th>Провайдер / Хост</th><th>Статус</th><th>Сбоев</th></tr></thead><tbody>
            ${d.dem.circuitBreakers.map(c => `<tr><td>${esc(c.label)}</td><td>${c.isOpen ? '🔴 Открыт (пауза)' : '🟢 Готов'}</td><td>${c.fails}</td></tr>`).join('')}
          </tbody></table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>🧩 Тайлы рельефа на экране (z${d.dem.hillshadeTileZoom}, всего ${vpDem.length})</span></div>
          ${d.dem.missingTiles.length ? `<div class="li-issue warn">Нет в Leaflet DOM: ${esc(d.dem.missingTiles.join(', '))}</div>` : ''}
          <div class="li-tbl-wrap"><table class="li-tbl">
            <thead><tr><th>Тайл</th><th>Источник</th><th>Статус</th><th>Высоты (м)</th><th>WebGL</th></tr></thead>
            <tbody>
              ${vpDem.map(t => {
                const src = t.dem.fromCache ? 'IDB/RAM' : (t.dem.fromParentCrop ? 'ParentCrop' : 'Сеть');
                const st = t.dem.emptyFallback ? '🔴 Пустой' : (t.dem.degraded ? '🟡 Деград.' : (t.dem.hasImg ? '🟢 OK' : '⏳ Грузится'));
                const hh = (t.dem.minH != null && t.dem.maxH != null) ? `${Math.round(t.dem.minH)}…${Math.round(t.dem.maxH)}` : '--';
                return `<tr><td>${esc(t.key)}</td><td>${esc(t.dem.provider || '--')} (${src})</td><td>${st}</td><td>${hh}</td><td>${t.dem.hasDemTex && t.dem.hasGBuf ? 'OK' : 'NO'}</td></tr>`;
              }).join('') || '<tr><td colspan="5">Нет тайлов на экране</td></tr>'}
            </tbody>
          </table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>📜 Журнал DEM</span></div>
          ${renderLogRows(layerDiag.getLogs('dem', false).slice(-40))}
        </div>
      `;
    } else if (activeTab === 'water' && d.dem) {
      const vpDem = d.dem.tiles.filter(t => t.inVp);
      body.innerHTML = `
        <div class="li-card">
          <div class="li-card-h"><span>🌊 Зеркала маски воды (ESA WorldCover 10м)</span>${statusBadge(d.dem.cfg.seaWavesEnabled ? 'Волны Вкл' : 'Волны Выкл', d.dem.cfg.seaWavesEnabled ? 'ok' : 'off')}</div>
          <div class="li-kv">
            ${renderMemMeter('RAM кэш масок воды', d.dem.caches.waterSize, 64)}
            ${renderMemMeter('Сетевые слоты воды', d.dem.parallel.waterActive, d.dem.parallel.waterMax)}
            <div class="li-stat"><small>Очередь / Ретраи</small><b>wait ${d.dem.parallel.waterWaiters} · retry ${d.dem.waterNet.retryAttempt}/5</b></div>
            <div class="li-stat"><small>Токен GEE Water</small><b>${d.dem.waterNet.hasToken ? '🟢 Есть' : '⚪ Нет'}</b></div>
          </div>
          <div class="li-tbl-wrap"><table class="li-tbl"><thead><tr><th>Зеркало</th><th>Статус</th><th>Сбоев</th><th>Активное</th></tr></thead><tbody>
            ${d.dem.waterNet.states.map((s, idx) => `<tr><td>${esc(s.name)}</td><td>${s.isOpen ? '🔴 Пауза' : '🟢 Готово'}</td><td>${s.fails}</td><td>${idx === d.dem.waterNet.lastSuccessfulIdx ? '⭐ Да' : ''}</td></tr>`).join('')}
          </tbody></table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>🧩 Состояние маски воды на тайлах экрана (${vpDem.length})</span></div>
          <div class="li-tbl-wrap"><table class="li-tbl">
            <thead><tr><th>Тайл</th><th>Маска</th><th>Содержимое</th><th>WebGL R8</th></tr></thead>
            <tbody>
              ${vpDem.map(t => {
                const w = t.water;
                const mSt = w.failed ? '🔴 Ошибка' : (!w.hasMask ? '⏳ Нет' : (w.isFallback ? '🟡 Parent-Фолбэк' : '🟢 Нативная'));
                const cSt = w.isEmpty404 ? '404 (нет воды)' : (w.hasWater ? '💧 Есть вода' : 'Суша (0 px)');
                return `<tr><td>${esc(t.key)}</td><td>${mSt}</td><td>${cSt}</td><td>${w.hasTex ? 'OK' : (w.hasMask && !w.isFallback ? 'Pending' : 'DEM резерв')}</td></tr>`;
              }).join('') || '<tr><td colspan="4">Нет тайлов</td></tr>'}
            </tbody>
          </table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>📜 Журнал воды</span></div>
          ${renderLogRows(layerDiag.getLogs('water', false).slice(-40))}
        </div>
      `;
    } else if (activeTab === 'osm' && d.osm) {
      const vpR = d.osm.roadTiles.filter(t => t.inVp);
      const vpL = d.osm.labelTiles.filter(t => t.inVp);
      body.innerHTML = `
        <div class="li-card">
          <div class="li-card-h"><span>🛤️ Векторный слой OSM (Shortbread + OpenMapTiles)</span>${statusBadge(d.osm.cfg.enabled ? 'Включён' : 'Выкл', d.osm.cfg.enabled ? 'ok' : 'off')}</div>
          <div class="li-kv">
            ${renderMemMeter('Кэш MVT тайлов', d.osm.caches.mvtSize, d.osm.caches.mvtMax)}
            ${renderMemMeter('Кэш OMT (пики/парки)', d.osm.caches.omtSize, d.osm.caches.omtMax)}
            <div class="li-stat"><small>Очередь рендера / Камера</small><b>${d.osm.renderQueue} · ${d.osm.cameraMoving ? 'Движ.' : 'Стоит'}</b></div>
            <div class="li-stat"><small>Менеджер подписей</small><b>${d.osm.labelsMgr.names} имён (${d.osm.labelsMgr.tiles} т.)</b></div>
            <div class="li-stat"><small>OpenFreeMap</small><b>${d.osm.omt.skipped ? '🟡 Пауза (VersaTiles)' : '🟢 OK'} (s=${d.osm.omt.failStreak})</b></div>
            <div class="li-stat"><small>Вспом. кэши</small><b>дор:${d.osm.caches.roadSegs} рек:${d.osm.caches.rivers} маск:${d.osm.caches.featMask}</b></div>
          </div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>🧩 Тайлы OSM на экране (Геометрия: ${vpR.length}, Подписи: ${vpL.length})</span></div>
          ${d.osm.missingRoadTiles.length ? `<div class="li-issue warn">Отсутствуют тайлы дорог: ${esc(d.osm.missingRoadTiles.join(', '))}</div>` : ''}
          <div class="li-tbl-wrap"><table class="li-tbl">
            <thead><tr><th>Тайл</th><th>MVT</th><th>OMT</th><th>Холст геом.</th><th>Холст подписей</th></tr></thead>
            <tbody>
              ${vpR.map(t => {
                const lbl = vpL.find(l => l.key === t.key);
                return `<tr><td>${esc(t.key)}</td><td>${t.mvtOk ? '🟢 OK' : '🔴 Нет'}</td><td>${t.omtDone ? '🟢' : '⏳'}</td><td>${esc(t.canvasSize)}</td><td>${lbl ? esc(lbl.canvasSize) : '--'}</td></tr>`;
              }).join('') || '<tr><td colspan="5">Нет тайлов (проверьте зум ≥ 9)</td></tr>'}
            </tbody>
          </table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>📜 Журнал OSM</span></div>
          ${renderLogRows(layerDiag.getLogs('osm', false).slice(-40))}
        </div>
      `;
    } else if (activeTab === 'canopy' && d.canopy) {
      const vpC = d.canopy.tiles.filter(t => t.inVp);
      body.innerHTML = `
        <div class="li-card">
          <div class="li-card-h"><span>🌲 Леса и высоты крон (Meta Canopy ${esc(d.canopy.settings.canopyVersion)})</span>${statusBadge(d.canopy.settings.treesEnabled ? '2D Лес Вкл' : 'Выкл', d.canopy.settings.treesEnabled ? 'ok' : 'off')}</div>
          <div class="li-kv">
            ${renderMemMeter('RAM кэш высот крон', d.canopy.caches.dataCacheSize, d.canopy.caches.dataCacheLimit)}
            ${renderMemMeter('Кэш спрайтов (шт)', d.canopy.caches.spriteCount, d.canopy.caches.maxSprites)}
            ${renderMemMeter('Память спрайтов', +(d.canopy.caches.spriteBytes / 1048576).toFixed(1), +(d.canopy.caches.spriteBytesLimit / 1048576).toFixed(1), ' МБ')}
            ${renderMemMeter('Сетевые слоты', d.canopy.parallel.active, d.canopy.parallel.max)}
            <div class="li-stat"><small>Очередь / Cooldown</small><b>q=${d.canopy.caches.renderQueue} · cd h:${d.canopy.caches.failedHeightCooldown} sp:${d.canopy.caches.failedSpeciesCooldown}</b></div>
            <div class="li-stat"><small>Токены GEE</small><b>h:${d.canopy.tokens.hasHeight ? '✓' : '×'} m:${d.canopy.tokens.hasMask ? '✓' : '×'} sp:${d.canopy.tokens.hasSpecies ? '✓' : '×'}</b></div>
          </div>
          <div class="li-tbl-wrap"><table class="li-tbl"><thead><tr><th>Зеркало CanopyNet</th><th>Статус</th><th>Сбоев</th><th>Последняя ошибка</th></tr></thead><tbody>
            ${d.canopy.net.states.map((s, idx) => `<tr><td>${idx === d.canopy.net.lastSuccessfulIdx ? '⭐ ' : ''}${esc(s.name)}</td><td>${s.alive ? '🟢 Готово' : '🔴 Пауза'}</td><td>${s.fails}</td><td>${esc(s.lastError || '—')}</td></tr>`).join('')}
          </tbody></table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>🧩 Тайлы леса на экране (z${d.canopy.treesTileZoom}, всего ${vpC.length})</span></div>
          ${d.canopy.missingTiles.length ? `<div class="li-issue warn">Нет в Leaflet DOM: ${esc(d.canopy.missingTiles.join(', '))}</div>` : ''}
          <div class="li-tbl-wrap"><table class="li-tbl">
            <thead><tr><th>Тайл</th><th>Состояние</th><th>Деревьев (рисов./план.)</th><th>Кэш / Флаги</th></tr></thead>
            <tbody>
              ${vpC.map(t => {
                const st = t.diag?.state || (t.queued ? 'в очереди' : 'не ренд.');
                const flags = [
                  t.hasGridInRam ? 'RAM' : 'нет RAM',
                  t.isZero ? 'ZERO' : '',
                  t.isDegraded ? 'Degraded' : '',
                  t.inCooldown ? 'Cooldown30s' : '',
                  t.needsDem ? 'Ждёт DEM' : ''
                ].filter(Boolean).join(', ');
                return `<tr><td>${esc(t.key)}</td><td>${esc(st)}</td><td>${t.diag ? `${t.diag.drawn}/${t.diag.planned}` : '--'}</td><td>${esc(flags)}</td></tr>`;
              }).join('') || '<tr><td colspan="4">Нет тайлов (проверьте зум ≥ 11 и включение леса)</td></tr>'}
            </tbody>
          </table></div>
        </div>

        <div class="li-card">
          <div class="li-card-h"><span>📜 Журнал леса</span></div>
          ${renderLogRows(layerDiag.getLogs('canopy', false).slice(-40))}
        </div>
      `;
    } else if (activeTab === 'logs') {
      const list = layerDiag.getLogs(logFilter, logOnlyErrors);
      body.innerHTML = `
        <div class="li-chips">
          ${[
            ['all', 'Все'],
            ['dem', '⛰️ Рельеф'],
            ['water', '🌊 Вода'],
            ['osm', '🛤️ OSM'],
            ['canopy', '🌲 Лес']
          ].map(([k, lbl]) => `<button type="button" class="li-chip ${logFilter === k ? 'active' : ''}" data-li-f="${k}">${lbl}</button>`).join('')}
          <button type="button" class="li-chip ${logOnlyErrors ? 'active' : ''}" id="wm-li-err-only">⚠️ Только ошибки/сбои</button>
        </div>
        ${renderLogRows(list)}
      `;
      body.querySelectorAll('[data-li-f]').forEach(btn => {
        btn.onclick = () => { logFilter = btn.dataset.liF; renderBody(); };
      });
      const errBtn = body.querySelector('#wm-li-err-only');
      if (errBtn) errBtn.onclick = () => { logOnlyErrors = !logOnlyErrors; renderBody(); };
    }

    body.scrollTop = prevScroll;
  }

  async function copyReport() {
    const text = await buildReportText();
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {}

    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) {}
    }

    if (WM.ui && WM.ui.showToast) {
      WM.ui.showToast(ok ? '📋 Диагностический отчёт скопирован!' : '⚠️ Не удалось скопировать (см. консоль)');
    }
    if (!ok) console.log(text);
  }

  function open(tab) {
    ensureModal();
    if (tab) {
      activeTab = tab;
      modalEl.querySelectorAll('.li-tab').forEach(b => b.classList.toggle('active', b.dataset.liTab === activeTab));
    }
    isOpen = true;
    modalEl.classList.add('open');
    renderBody();
    if (autoRefresh) {
      clearInterval(autoTimer);
      autoTimer = setInterval(() => renderBody(), 1000);
    }
    if (WM.ui?.pushHistoryState) WM.ui.pushHistoryState('layerInspector');
  }

  function close() {
    isOpen = false;
    clearInterval(autoTimer);
    autoTimer = 0;
    if (modalEl) modalEl.classList.remove('open');
    if (WM.ui?.clearHistoryState) WM.ui.clearHistoryState('layerInspector');
  }

  document.addEventListener('click', e => {
    if (e.target && e.target.closest && e.target.closest('#btn-open-layer-inspector')) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });

  WM.layerInspector = {
    open,
    close,
    isOpen: () => isOpen,
    refresh: renderBody,
    buildReportText
  };
})();