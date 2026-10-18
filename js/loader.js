(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  const queue = [];
  let running = 0, wanted = new Set(), blocked = null, rateWaitUntil = 0, map = null, cb = {}, retryTimer = null;
  let precacheAbort = false, isPrecaching = false;

  let detailsQueue = [];
  let detailsRunning = false;
  let detailsAbortToken = 0;
  let totalPendingDetails = 0;

  let tagFetchTimer = null;
  let lastTagBboxKey = '';

  const lodFor = z => C.LOD.find(l => z >= l.z) || null;

  function stopDetailsQueue() {
    detailsAbortToken++;
    detailsQueue = [];
    detailsRunning = false;
    totalPendingDetails = 0;
  }

  function scheduleDetailsQueue() {
    if (!map || isPrecaching) return;
    const isAutoDetails = WM.ui && WM.ui.isAutoDetailsEnabled();
    const isCrosshairOnly = WM.ui && WM.ui.isAutoDetailsCrosshairOnly();
    
    if (!isAutoDetails || isCrosshairOnly) {
      stopDetailsQueue();
      return;
    }

    if (running > 0 || queue.length > 0) return;
    if (rateWaitUntil > Date.now()) return;

    const center = map.getCenter();
    const b = map.getBounds().pad(0.05);
    const vb = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };

    const candidates = [];
    // БЫЛО: for (const o of WM.cache.objects.values()) — перебор 30 000 объектов!
    // СТАЛО: выборка строго из ячеек видимого экрана (~30-60 объектов)
    const pool = WM.cache.queryBBox ? WM.cache.queryBBox(vb) : [];

    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      if (o.hasDetail || o.detailFailed) continue;
      if (WM.view && WM.view.isObjectAllowed && !WM.view.isObjectAllowed(o)) continue;
      if (!G.intersects(o.bbox, vb)) continue;

      const objCenterLat = (o.bbox.s + o.bbox.n) / 2;
      const objCenterLng = (o.bbox.w + o.bbox.e) / 2;
      const distSq = (objCenterLat - center.lat) ** 2 + (objCenterLng - center.lng) ** 2;
      candidates.push({ o, distSq });
    }

    totalPendingDetails = candidates.length;
    if (!candidates.length) {
      stopDetailsQueue();
      return;
    }

    candidates.sort((a, b) => a.distSq - b.distSq);
    detailsQueue = candidates.slice(0, 50).map(c => c.o);

    if (!detailsRunning) {
      pumpDetails();
    }
  }

  async function loadObjectDetails(obj) {
    if (!obj || obj.hasDetail || obj.detailLoading || obj.detailFailed) return;
    obj.detailLoading = true;
    try {
      const detail = await WM.api.place(obj.id, 'ru');
      if (detail) {
        WM.cache.applyDetail(obj.id, detail);
        if (WM.view && WM.view.updateObjectStyle) {
          WM.view.updateObjectStyle(obj.id);
        }
        if (WM.picker && WM.picker.refresh) {
          WM.picker.refresh();
        }
        cb.onChange && cb.onChange();
      }
    } catch (err) {
      if (err.rateLimit) {
        const wait = err.retryAfterMs || 3000;
        rateWaitUntil = Date.now() + wait;
      } else {
        obj.detailFailed = true;
      }
    } finally {
      obj.detailLoading = false;
      cb.onStatus && cb.onStatus();
    }
  }

  async function pumpDetails() {
    if (detailsRunning || !detailsQueue.length) return;
    const isAutoDetails = WM.ui && WM.ui.isAutoDetailsEnabled();
    if (!isAutoDetails) { stopDetailsQueue(); return; }

    detailsRunning = true;
    const currentToken = ++detailsAbortToken;

    try {
      while (detailsQueue.length > 0) {
        if (currentToken !== detailsAbortToken) break;
        if (running > 0 || queue.length > 0) break;
        if (rateWaitUntil > Date.now()) break;

        const obj = detailsQueue.shift();
        if (!obj || obj.hasDetail || obj.detailFailed) {
          totalPendingDetails = Math.max(0, totalPendingDetails - 1);
          continue;
        }

        try {
          const detail = await WM.api.place(obj.id, 'ru');
          if (currentToken !== detailsAbortToken) break;

          if (detail) {
            WM.cache.applyDetail(obj.id, detail);
            if (WM.view && WM.view.updateObjectStyle) {
              WM.view.updateObjectStyle(obj.id);
            }
            if (WM.picker && WM.picker.refresh) {
              WM.picker.refresh();
            }
            cb.onChange && cb.onChange();
          }
        } catch (err) {
          if (currentToken !== detailsAbortToken) break;

          if (err.rateLimit) {
            detailsQueue.unshift(obj);
            const wait = err.retryAfterMs || 3000;
            rateWaitUntil = Date.now() + wait;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(update, wait + 200);
            break;
          } else {
            obj.detailFailed = true;
          }
        } finally {
          totalPendingDetails = Math.max(0, totalPendingDetails - 1);
        }

        // Мягкая пауза: 150 мс не дает серверу повода для ограничения частоты
        await new Promise(r => setTimeout(r, 150));
      }
    } finally {
      if (currentToken === detailsAbortToken) {
        detailsRunning = false;
      }
      cb.onStatus && cb.onStatus();

      if (currentToken === detailsAbortToken && !detailsQueue.length && isAutoDetails) {
        scheduleDetailsQueue();
      }
    }
  }

  function scheduleTagFetch(tag) {
    if (!tag || !map || isPrecaching) return;
    clearTimeout(tagFetchTimer);
    tagFetchTimer = setTimeout(async () => {
      if (!map || isPrecaching) return;
      const b = map.getBounds().pad(0.1);
      const key = `${tag.id || tag.title}:${b.getWest().toFixed(2)},${b.getSouth().toFixed(2)},${b.getEast().toFixed(2)},${b.getNorth().toFixed(2)}`;
      if (key === lastTagBboxKey) return;
      lastTagBboxKey = key;
      await fetchCategoryInBounds(tag, true);
    }, 450);
  }

  function update() {
    if (!map || isPrecaching) return;
    const zoom = Math.round(map.getZoom());
    const mode = WM.ui ? WM.ui.getWorkMode() : 'hybrid';
    const activeTag = (WM.view && WM.view.getActiveTag) ? WM.view.getActiveTag() : null;

    // Было: if (activeTag && (mode === 'auto' || (mode === 'hybrid' && zoom >= C.VECTOR_ZOOM)))
    // Стало: ищем объекты тега всегда при наличии активного тега
    if (activeTag) {
      scheduleTagFetch(activeTag);
    }

    if (mode === 'manual' || (mode === 'hybrid' && zoom < C.VECTOR_ZOOM)) {
      WM.loader.lod = null;
      wanted = new Set();
      // Отменяем активные загрузки, ушедшие в ручной режим
      for (const t of WM.cache.tiles.values()) {
        if (t.state === 'loading' && t.abortCtl) {
          t.abortCtl.abort();
          t.state = 'idle';
        }
      }
      queue.length = 0;
      cb.onStatus && cb.onStatus();
      if (mode === 'manual') scheduleDetailsQueue();
      return;
    }

    let lod = lodFor(zoom);
    if (!lod && mode === 'auto' && zoom >= C.MIN_ZOOM) {
      lod = { z: zoom, tz: Math.max(C.MIN_ZOOM, zoom - 1), pages: 1 };
    }

    WM.loader.lod = lod;
    if (!lod) {
      wanted = new Set();
      cb.onStatus && cb.onStatus();
      return;
    }

    const b = map.getBounds().pad(0.1);
    const tiles = G.tilesFor({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }, lod.tz, C.MAX_TILES_PER_VIEW);
    wanted = new Set(tiles.map(t => t.key));
    const now = Date.now();
    let nextRetry = Infinity;

    // 1. МГНОВЕННО ОТМЕНЯЕМ ЗАГРУЗКУ ТАЙЛОВ, ВЫШЕДШИХ ЗА ГРАНИЦЫ ЭКРАНА ПРИ ПЕРЕМЕЩЕНИИ
    for (const t of WM.cache.tiles.values()) {
      if (t.state === 'loading' && !wanted.has(t.key)) {
        if (t.abortCtl) {
          t.abortCtl.abort();
          t.state = 'idle';
        }
      }
    }

    if (rateWaitUntil > now) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(update, rateWaitUntil - now + 150);
      cb.onStatus && cb.onStatus();
      return;
    } else {
      rateWaitUntil = 0;
    }

    for (const t of tiles) {
      const e = WM.cache.tile(t);
      e.used = now; e.d = t.d;
      if (blocked) continue;
      
      if (e.state === 'done') {
        let hasAliveObjects = false;
        if (e.ids && e.ids.size > 0) {
          for (const id of e.ids) {
            if (WM.cache.objects.has(id)) { hasAliveObjects = true; break; }
          }
        }
        if (e.ids && e.ids.size > 0 && !hasAliveObjects) {
          if (WM.cache.restoreTileObjects) {
            WM.cache.restoreTileObjects(e).then(restored => {
              if (!restored) {
                e.state = 'idle';
                update();
              } else {
                cb.onChange && cb.onChange();
              }
            });
            continue;
          } else {
            e.state = 'idle';
          }
        } else {
          continue;
        }
      }

      // 2. ИСПРАВЛЕНИЕ: НИКАКОЙ «ВЕЧНОЙ СМЕРТИ» ТАЙЛОВ ПРИ MAX_TRIES!
      // Если время retryAt наступило — тайл ОБЯЗАН попробовать загрузиться снова
      const isReadyRetry = (e.state === 'error' && now >= e.retryAt);
      
      if (e.state === 'idle' || isReadyRetry) {
        if (e.tries >= C.MAX_TRIES) {
          e.tries = 1; // Мягкий сброс счетчика для возобновления попыток
        }
        e.state = 'queued'; 
        e.lod = lod; 
        if (!queue.includes(e)) queue.push(e);
      } else if (e.state === 'error') {
        nextRetry = Math.min(nextRetry, e.retryAt);
      }
    }

    clearTimeout(retryTimer);
    if (nextRetry < Infinity) retryTimer = setTimeout(update, Math.max(200, nextRetry - now + 100));
    pump(); 
    cb.onStatus && cb.onStatus();
    if (running === 0 && queue.length === 0) {
      scheduleDetailsQueue();
    }
  }

  function pump() {
    if (rateWaitUntil > Date.now()) return;
    while (running < C.CONCURRENCY && queue.length) {
      queue.sort((a, b) => a.d - b.d);
      const e = queue.shift();
      if (!wanted.has(e.key)) { e.state = 'idle'; continue; }
      run(e);
    }
  }

  async function run(e) {
    e.state = 'loading'; 
    running++; 
    cb.onStatus && cb.onStatus();

    const ctl = new AbortController();
    e.abortCtl = ctl;

    try {
      const bb = G.tileBBox(e.x, e.y, e.z);
      for (let page = 1; page <= e.lod.pages; page++) {
        if (ctl.signal.aborted) throw new Error('Aborted');
        const data = await WM.api.box(bb, page, ctl.signal);
        const items = Array.isArray(data.folder) ? data.folder : [];
        WM.cache.addItems(e, items);
        const found = +data.found || 0;
        if (items.length < C.PAGE_SIZE || page * C.PAGE_SIZE >= found) break;
      }
      e.state = 'done'; 
      e.tries = 0;
      WM.cache.saveTileMeta(e);
    } catch (err) {
      if (ctl.signal.aborted) {
        e.state = 'idle';
        return;
      }
      if (err.rateLimit) {
        e.state = 'queued';
        queue.unshift(e);
        const wait = err.retryAfterMs || 3000;
        rateWaitUntil = Date.now() + wait;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(update, wait + 200);
      } else if (err.fatal) {
        blocked = err.message;
        e.state = 'idle';
      } else {
        e.tries++;
        e.state = 'error';
        // Мягкий экспоненциальный бэкофф с потолком 25 секунд
        const waitTime = Math.min(25000, 1500 * Math.pow(1.6, Math.min(e.tries, 5)));
        e.retryAt = Date.now() + waitTime;
      }
    } finally {
      e.abortCtl = null;
      running--;
      WM.cache.evict(wanted);
      cb.onChange && cb.onChange();
      cb.onStatus && cb.onStatus();
      pump();
      if (running === 0 && queue.length === 0) {
        scheduleDetailsQueue();
      }
    }
  }

  function loadVisibleNow() {
    if (!map) return;
    const zoom = Math.round(map.getZoom());
    if (zoom < C.VECTOR_ZOOM) return;

    let lod = lodFor(zoom) || { z: zoom, tz: Math.max(C.MIN_ZOOM, zoom - 1), pages: 1 };
    WM.loader.lod = lod;

    const b = map.getBounds().pad(0.1);
    const tiles = G.tilesFor({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }, lod.tz, C.MAX_TILES_PER_VIEW);
    wanted = new Set(tiles.map(t => t.key));
    const now = Date.now();

    for (const t of tiles) {
      const e = WM.cache.tile(t);
      e.used = now; e.d = t.d;
      if (e.state !== 'done') {
        e.state = 'queued';
        e.lod = lod;
        e.tries = 0;
        if (!queue.includes(e)) queue.push(e);
      }
    }
    pump();
    cb.onStatus && cb.onStatus();
  }

  async function fetchPoint(lat, lon) {
    try {
      const items = await WM.api.point(lat, lon);
      if (items && items.length) {
        const added = WM.cache.addItems(null, items);
        cb.onChange && cb.onChange();
        return added;
      }
    } catch (err) {
      console.warn('[WM Loader] Точечный запрос геометрии не удался:', err.message);
    }
    return [];
  }

  async function fetchCategoryInBounds(tag, silent = false) {
    if (!map || !tag) return 0;
    const b = map.getBounds().pad(0.1);
    const bbox = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
    try {
      if (!silent) WM.ui.setStatus(`🏷️ Поиск объектов «${tag.title}»…`);
      const catQuery = tag.id || tag.title;
      const data = await WM.api.categoryBox(bbox, catQuery, 1);
      const items = Array.isArray(data.folder) ? data.folder : [];
      if (items.length) {
        for (const it of items) {
          if (!it.tags) it.tags = [];
          it.tags.push({ id: tag.id, title: tag.title });
        }
        const added = WM.cache.addItems(null, items);
        for (const o of added) {
          if (!o.tags) o.tags = [];
          if (!o.tags.some(t => t.title === tag.title)) {
            o.tags.push({ id: tag.id, title: tag.title });
            WM.cache.updateObject(o);
          }
        }
        WM.view.render();
        if (!silent) WM.ui.showToast(`🏷️ Найдено «${tag.title}»: ${items.length}`);
        return items.length;
      } else if (!silent) {
        WM.ui.showToast(`В этой области объекты «${tag.title}» не найдены`);
      }
    } catch (err) {
      console.warn('[WM Loader] Поиск по категории не удался:', err.message);
    } finally {
      if (!silent) WM.ui.updateStatusFromLoader();
    }
    return 0;
  }

  async function precacheArea(bounds, zoom, withDetails, onProgress) {
    if (isPrecaching) return;
    isPrecaching = true;
    precacheAbort = false;
    const lod = lodFor(zoom) || { tz: zoom, pages: 1 };
    const tiles = G.tilesFor(bounds, lod.tz, 150);
    let done = 0, total = tiles.length;
    let savedTilesCount = 0;
    let savedDetailsCount = 0;

    try {
      for (const t of tiles) {
        if (precacheAbort) break;
        const e = WM.cache.tile(t);
        if (e.state !== 'done') {
          let attempts = 0;
          let success = false;

          while (!success && attempts < 4 && !precacheAbort) {
            attempts++;
            try {
              const bb = G.tileBBox(e.x, e.y, e.z);
              const data = await WM.api.box(bb, 1);
              WM.cache.addItems(e, Array.isArray(data.folder) ? data.folder : []);
              e.state = 'done';
              WM.cache.saveTileMeta(e);
              success = true;
              savedTilesCount++;
              // Немедленное появление полигонов на карте прямо во время скачивания!
              cb.onChange && cb.onChange();
              if (WM.view) WM.view.render();
            } catch (err) {
              const waitMs = err.retryAfterMs || (attempts * 2000);
              onProgress && onProgress({ 
                stage: 'retry', 
                message: `Пауза API. Повтор #${attempts} через ${Math.ceil(waitMs / 1000)}с...`,
                waitMs 
              });
              await new Promise(r => setTimeout(r, waitMs));
            }
          }
          await new Promise(r => setTimeout(r, 350));
        } else {
          savedTilesCount++;
        }
        done++;
        onProgress && onProgress({ stage: 'tiles', done, total });
      }

      if (withDetails && !precacheAbort) {
        const targetObjects = [];
        for (const o of WM.cache.objects.values()) {
          if (G.intersects(o.bbox, bounds) && !o.hasDetail) {
            targetObjects.push(o);
          }
        }

        let objDone = 0;
        const objTotal = targetObjects.length;
        onProgress && onProgress({ stage: 'details', done: 0, total: objTotal });

        for (const obj of targetObjects) {
          if (precacheAbort) break;
          let attempts = 0;
          let success = false;

          while (!success && attempts < 4 && !precacheAbort) {
            attempts++;
            try {
              await WM.api.place(obj.id, 'ru');
              success = true;
              objDone++;
              savedDetailsCount++;
              cb.onChange && cb.onChange();
              onProgress && onProgress({ stage: 'details', done: objDone, total: objTotal });
            } catch (err) {
              const waitMs = err.retryAfterMs || (attempts * 1500);
              onProgress && onProgress({ 
                stage: 'retry', 
                message: `Пауза API. Повтор #${attempts} через ${Math.ceil(waitMs / 1000)}с...`,
                waitMs 
              });
              await new Promise(r => setTimeout(r, waitMs));
            }
          }
          await new Promise(r => setTimeout(r, 350));
        }
      }
    } finally {
      isPrecaching = false;
      cb.onChange && cb.onChange();
      if (WM.view) WM.view.render();
      update();

      if (precacheAbort) {
        onProgress && onProgress({
          stage: 'aborted',
          savedTiles: savedTilesCount,
          savedDetails: savedDetailsCount
        });
      }
    }
  }

  WM.loader = {
    lod: null,
    init(m, callbacks) { map = m; cb = callbacks; },
    loadObjectDetails,
    update,
    fetchPoint,
    fetchCategoryInBounds,
    resetTagBbox() { lastTagBboxKey = ''; },
    loadVisibleNow,
    precacheArea,
    stopDetailsQueue,
    scheduleDetailsQueue,
    onSettingsChanged() {
      stopDetailsQueue();
      update();
    },
    stopPrecache() { precacheAbort = true; },
    get isPrecaching() { return isPrecaching; },
    reset() {
      blocked = null;
      rateWaitUntil = 0;
      for (const t of WM.cache.tiles.values()) {
        if (t.state === 'error') { t.tries = 0; t.retryAt = 0; }
      }
      update();
    },
    retryNow(forced = false) {
      rateWaitUntil = 0;
      clearTimeout(retryTimer);
      for (const t of WM.cache.tiles.values()) {
        if (t.state === 'error' || (forced && t.state !== 'done')) {
          t.state = 'idle'; t.tries = 0; t.retryAt = 0;
        }
      }
      update();
    },
    stats() {
      let errors = 0, failed = 0;
      for (const k of wanted) {
        const t = WM.cache.tiles.get(k);
        if (t && t.state === 'error') { errors++; if (t.tries >= C.MAX_TRIES) failed++; }
      }
      const pool = WM.api.getPoolStatus();
      return {
        blocked,
        isRateWaiting: pool.allBlocked,
        waitMs: pool.waitMs,
        lod: WM.loader.lod,
        active: running + queue.filter(q => wanted.has(q.key)).length,
        detailsQueueCount: totalPendingDetails || detailsQueue.length,
        errors,
        failed
      };
    }
  };
})();