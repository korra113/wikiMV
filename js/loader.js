(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  const queue = [];
  let running = 0, wanted = new Set(), blocked = null, rateWaitUntil = 0, map = null, cb = {}, retryTimer = null;
  let precacheAbort = false, isPrecaching = false;

  const lodFor = z => C.LOD.find(l => z >= l.z) || null;

  function update() {
    if (!map || isPrecaching) return;
    const zoom = Math.round(map.getZoom());
    const mode = WM.ui ? WM.ui.getWorkMode() : 'hybrid';

    // 1. Полностью ручной режим: автоматические запросы полигонов не отправляются
    if (mode === 'manual') {
      WM.loader.lod = null;
      wanted = new Set();
      queue.length = 0;
      cb.onStatus && cb.onStatus();
      return;
    }

    // 2. Гибридный режим: векторные тайлы грузятся только при приближении >= VECTOR_ZOOM
    if (mode === 'hybrid' && zoom < C.VECTOR_ZOOM) {
      WM.loader.lod = null;
      wanted = new Set();
      queue.length = 0;
      cb.onStatus && cb.onStatus();
      return;
    }

    // 3. Автоматический режим или гибридный в крупном масштабе
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
      if (e.state === 'done') continue;
      if (e.state === 'idle' || (e.state === 'error' && e.tries < C.MAX_TRIES && now >= e.retryAt)) {
        e.state = 'queued'; e.lod = lod; queue.push(e);
      } else if (e.state === 'error' && e.tries < C.MAX_TRIES) {
        nextRetry = Math.min(nextRetry, e.retryAt);
      }
    }

    clearTimeout(retryTimer);
    if (nextRetry < Infinity) retryTimer = setTimeout(update, Math.max(100, nextRetry - now + 50));
    pump(); cb.onStatus && cb.onStatus();
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
    e.state = 'loading'; running++; cb.onStatus && cb.onStatus();
    try {
      const bb = G.tileBBox(e.x, e.y, e.z);
      for (let page = 1; page <= e.lod.pages; page++) {
        const data = await WM.api.box(bb, page);
        const items = Array.isArray(data.folder) ? data.folder : [];
        WM.cache.addItems(e, items);
        const found = +data.found || 0;
        if (items.length < C.PAGE_SIZE || page * C.PAGE_SIZE >= found) break;
      }
      e.state = 'done'; e.tries = 0;
      WM.cache.saveTileMeta(e);
    } catch (err) {
      if (err.rateLimit) {
        e.state = 'queued';
        queue.unshift(e);
        const wait = err.retryAfterMs || 5000;
        rateWaitUntil = Date.now() + wait;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(update, wait + 200);
      } else if (err.fatal) {
        blocked = err.message;
        e.state = 'idle';
      } else {
        e.tries++;
        e.state = 'error';
        e.retryAt = Date.now() + Math.min(30000, 1500 * 2 ** e.tries);
      }
    } finally {
      running--;
      WM.cache.evict(wanted);
      cb.onChange && cb.onChange();
      cb.onStatus && cb.onStatus();
      pump();
    }
  }

  // Принудительная загрузка недостающих объектов на текущем видимом экране
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

  // Загрузка объектов по тегу/категории в видимой области карты
  async function fetchCategoryInBounds(tag) {
    if (!map || !tag) return 0;
    const b = map.getBounds().pad(0.1);
    const bbox = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
    try {
      WM.ui.setStatus(`🏷️ Поиск объектов «${tag.title}»…`);
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
        WM.ui.showToast(`🏷️ Найдено «${tag.title}»: ${items.length}`);
        return items.length;
      } else {
        WM.ui.showToast(`В этой области объекты «${tag.title}» не найдены`);
      }
    } catch (err) {
      console.warn('[WM Loader] Поиск по категории не удался:', err.message);
    } finally {
      WM.ui.updateStatusFromLoader();
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

    // Этап 1: Загрузка векторных тайлов (полигонов)
    for (const t of tiles) {
      if (precacheAbort) break;
      const e = WM.cache.tile(t);
      if (e.state !== 'done') {
        try {
          const bb = G.tileBBox(e.x, e.y, e.z);
          const data = await WM.api.box(bb, 1);
          WM.cache.addItems(e, Array.isArray(data.folder) ? data.folder : []);
          e.state = 'done';
          WM.cache.saveTileMeta(e);
        } catch (err) {
          if (err.rateLimit) {
            await new Promise(r => setTimeout(r, err.retryAfterMs || 5000));
            continue;
          }
        }
        await new Promise(r => setTimeout(r, 1200));
      }
      done++;
      onProgress && onProgress({ stage: 'tiles', done, total });
    }

    // Этап 2: Загрузка полных описаний, фото и отзывов (если включен чекбокс)
    if (withDetails && !precacheAbort) {
      // Собираем уникальные объекты, попавшие в область bounds, у которых ещё нет деталей
      const targetObjects = [];
      for (const o of WM.cache.objects.values()) {
        if (G.intersects(o.bbox, bounds)) {
          if (!o.hasDetail) {
            targetObjects.push(o);
          }
        }
      }

      let objDone = 0;
      const objTotal = targetObjects.length;

      onProgress && onProgress({ stage: 'details', done: 0, total: objTotal });

      for (const obj of targetObjects) {
        if (precacheAbort) break;
        try {
          // WM.api.place автоматически сохраняет карточку в IndexedDB
          // и вызывает WM.cache.markVisited, сохраняя кол-во фото и комментариев
          await WM.api.place(obj.id, 'ru');
          objDone++;
          onProgress && onProgress({ stage: 'details', done: objDone, total: objTotal });
        } catch (err) {
          if (err.rateLimit) {
            const wait = err.retryAfterMs || 5000;
            onProgress && onProgress({ stage: 'waiting', waitMs: wait });
            await new Promise(r => setTimeout(r, wait));
            continue;
          }
        }
        // Небольшая задержка между запросами к API для стабильности
        await new Promise(r => setTimeout(r, 700));
      }
    }

    isPrecaching = false;
    cb.onChange && cb.onChange();
    if (WM.view) WM.view.render();
    update();
  }

  WM.loader = {
    lod: null,
    init(m, callbacks) { map = m; cb = callbacks; },
    update,
    fetchPoint,
    fetchCategoryInBounds,
    loadVisibleNow,
    precacheArea,
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
        errors,
        failed
      };
    }
  };
})();
