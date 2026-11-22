// =========================================================================
// tile-retry.js (v2) — устойчивая и плавная загрузка растровых тайлов Leaflet
// Рассчитан на Leaflet 1.9.x (патчатся приватные _initTile / _pruneTiles).
// Что исправлено относительно v1:
//  1. Нахлёст +1px теперь на ВСЕХ зумах (швы на z<10), но только для
//     непрозрачных базовых слоёв (у полупрозрачных оверлеев нахлёст даёт полосы).
//  2. Тайл показывается только после img.decode() — нет «пустого кадра»,
//     когда родительский тайл уже убран, а новый ещё не отрисован (моргание).
//  3. tileabort → forget(): тайлы, отменённые при смене уровня зума, больше не
//     уходят в сеть из офлайн-ветки и не забивают соединения.
//  4. Тайл с ошибкой больше не считается «active»: родительский тайл остаётся
//     под ним, вместо дыры, пока идут повторы.
//  5. Тайм-ауты не включают глобальную паузу повторов; пауза короче.
//  6. _pruneTiles склеивается в один вызов на кадр (раньше O(n²) на пачке тайлов).
//  7. Опциональная предзагрузка тайлов соседних уровней: WM.tileRetry.initPrefetch(map).
// =========================================================================
(function () {
  const LOAD_TIMEOUT_MS = 8000;      // тайл «завис» без ответа
  const BASE_DELAY_MS = 700;         // первый повтор ≈ 0.7 с
  const MAX_DELAY_MS = 20000;
  const MAX_PARALLEL_RETRY = 6;
  const SWEEP_MS = 2000;
  const GLOBAL_FAIL_LIMIT = 24;      // реальных ошибок подряд до глобальной паузы
  const GLOBAL_PAUSE_MAX_MS = 5000;
  // Панели с непрозрачными тайлами, где безопасен нахлёст +1px
  const OVERLAP_PANES = { tilePane: 1, 'wm-underlay': 1 };

  const pending = new Map();  // tile -> { t0, layer }          идёт загрузка
  const failed = new Map();   // tile -> { layer, n, due, busy } ждёт повтора
  let timer = 0;
  let globalFails = 0;
  let globalPauseUntil = 0;

  const delayFor = n =>
    Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(1.7, Math.max(0, n - 1))) * (0.75 + Math.random() * 0.5);

  const busyCount = () => {
    let c = 0;
    for (const f of failed.values()) if (f.busy) c++;
    return c;
  };

  const isDataSrc = tile => {
    const s = tile.getAttribute('src') || '';
    return s.startsWith('data:');
  };

  const isDead = (tile, layer) => {
    const src = tile._wmSrc || tile.getAttribute('src') || tile.src || '';
    return !tile.isConnected || !layer._map || !src || src.startsWith('data:');
  };

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!failed.size || document.hidden || navigator.onLine === false) return;
    let next = Infinity;
    for (const f of failed.values()) if (!f.busy && f.due < next) next = f.due;
    if (next === Infinity) return;
    const wait = Math.max(300, Math.max(next, globalPauseUntil) - Date.now());
    timer = setTimeout(pump, wait);
  }

  function pump() {
    timer = 0;
    const now = Date.now();
    if (now < globalPauseUntil) return schedule();

    const due = [];
    for (const [tile, f] of failed) {
      if (isDead(tile, f.layer)) { failed.delete(tile); pending.delete(tile); continue; }
      if (!f.busy && f.due <= now) due.push([tile, f]);
    }
    due.sort((a, b) => a[1].due - b[1].due);

    let slots = MAX_PARALLEL_RETRY - busyCount();
    for (const [tile, f] of due) {
      if (slots <= 0) break;
      if (!tile._wmSrc) { failed.delete(tile); continue; }
      f.busy = true;
      slots--;
      pending.set(tile, { t0: now, layer: f.layer });
      tile.src = tile._wmSrc;   // тот же URL → запрос уйдёт заново
    }
    schedule();
  }

  // countGlobal=false для тайм-аутов: медленный тайл ≠ «сеть умерла»
  function markFailed(tile, layer, countGlobal) {
    pending.delete(tile);
    let f = failed.get(tile);
    if (!f) { f = { layer, n: 0, due: 0, busy: false }; failed.set(tile, f); }
    f.busy = false;
    f.n++;
    if (countGlobal !== false) {
      globalFails++;
      if (globalFails >= GLOBAL_FAIL_LIMIT) {
        globalPauseUntil = Date.now() + Math.min(GLOBAL_PAUSE_MAX_MS, (globalFails - GLOBAL_FAIL_LIMIT + 1) * 800);
      }
    }
    f.due = Date.now() + delayFor(f.n);
    schedule();
  }

  function onTileOk(tile) {
    pending.delete(tile);
    if (failed.delete(tile)) schedule();
    globalFails = 0;
    globalPauseUntil = 0;
  }

  function forget(tile) {
    tile._wmCanceled = true;
    if (tile._wmBlobUrl) {
      try { URL.revokeObjectURL(tile._wmBlobUrl); } catch (e) {}
      tile._wmBlobUrl = null;
    }
    pending.delete(tile);
    failed.delete(tile);
  }

  // ---- Патч L.GridLayer / L.TileLayer ----
  const origCreate = L.TileLayer.prototype.createTile;
  const origOnLoad = L.TileLayer.prototype._tileOnLoad;
  const origOnError = L.TileLayer.prototype._tileOnError;
  const origInitTile = L.GridLayer.prototype._initTile;
  const origPrune = L.GridLayer.prototype._pruneTiles;

  L.GridLayer.include({
    // (1) Нахлёст на всех зумах для непрозрачных базовых слоёв
    _initTile(tile) {
      origInitTile.call(this, tile);
      const pane = this.options.pane || 'tilePane';
      if (OVERLAP_PANES[pane] && this.options.wmOverlap !== false) {
        const size = this.getTileSize();
        tile.style.width = (size.x + 1) + 'px';
        tile.style.height = (size.y + 1) + 'px';
      }
    },

    // (4)+(6) prune раз в кадр; тайл с ошибкой не считаем active,
    // чтобы родительский тайл не удалялся и не оставлял дыру
    _pruneTiles() {
      if (this._wmPruneRaf) return;
      this._wmPruneRaf = requestAnimationFrame(() => {
        this._wmPruneRaf = 0;
        if (!this._map) return;
        const hidden = [];
        for (const k in this._tiles) {
          const t = this._tiles[k];
          if (t.active && t.el && !t.el.classList.contains('leaflet-tile-loaded')) {
            t.active = false;
            hidden.push(t);
          }
        }
        origPrune.call(this);
        for (const t of hidden) t.active = true;
      });
    }
  });

  L.TileLayer.include({
    createTile(coords, done) {
      const url = this.getTileUrl(coords);
      const hasOffline = window.WM && WM.offlineArea && typeof WM.offlineArea.readCachedTileBlobUrl === 'function';

      if (!hasOffline || !url || url.startsWith('data:') || url.startsWith('blob:')) {
        const tile = origCreate.call(this, coords, done);
        tile._wmDone = done;
        tile._wmSrc = tile.src || tile.getAttribute('src');
        return tile;
      }

      const tile = document.createElement('img');
      L.DomEvent.on(tile, 'load', this._tileOnLoad.bind(this, done, tile));
      L.DomEvent.on(tile, 'error', this._tileOnError.bind(this, done, tile));

      if (this.options.crossOrigin || this.options.crossOrigin === '') {
        tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
      }
      if (typeof this.options.referrerPolicy === 'string') {
        tile.referrerPolicy = this.options.referrerPolicy;
      }
      tile.alt = '';
      tile.setAttribute('role', 'presentation');

      tile._wmDone = done;
      tile._wmSrc = url;
      tile._wmCanceled = false;

      // Сначала скачанный офлайн-кэш, в сеть идём только если там пусто
      WM.offlineArea.readCachedTileBlobUrl(url).then(hit => {
        // (3) тайл мог быть отменён/удалён, пока шли в кэш
        if (tile._wmCanceled || !this._map || !tile.isConnected) {
          if (hit && hit.blobUrl) {
            try { URL.revokeObjectURL(hit.blobUrl); } catch (e) {}
          }
          return;
        }
        if (hit && hit.blobUrl) {
          tile._wmBlobUrl = hit.blobUrl;
          tile.src = hit.blobUrl;
        } else {
          tile.src = url;
        }
      }).catch(() => {
        if (tile._wmCanceled || !this._map || !tile.isConnected) return;
        tile.src = url;
      });

      return tile;
    },

    _tileOnLoad(done, tile) {
      // Заглушка Leaflet при отмене (emptyImageUrl) — просто отдаём Leaflet'у
      if (isDataSrc(tile)) {
        if (tile._wmBlobUrl) {
          try { URL.revokeObjectURL(tile._wmBlobUrl); } catch (e) {}
          tile._wmBlobUrl = null;
        }
        return origOnLoad.call(this, done, tile);
      }

      const finish = () => {
        if (tile._wmBlobUrl) {
          try { URL.revokeObjectURL(tile._wmBlobUrl); } catch (e) {}
          tile._wmBlobUrl = null;
        }
        if (tile._wmCanceled) return;
        tile.classList.remove('leaflet-tile-retry', 'leaflet-tile-error');
        onTileOk(tile);
        origOnLoad.call(this, done, tile);
      };

      // (2) Сообщаем Leaflet «готово» только когда картинка декодирована,
      // иначе родитель убирается раньше, чем новый тайл попал на экран.
      if (typeof tile.decode === 'function') {
        tile.decode().then(finish, () => {
          if (tile.naturalWidth > 1) finish();
          else if (tile._wmCanceled) return;
          else this._tileOnError(done, tile, new Error('decode'));
        });
      } else {
        finish();
      }
    },

    _tileOnError(done, tile, e) {
      if (tile._wmBlobUrl) {
        try { URL.revokeObjectURL(tile._wmBlobUrl); } catch (err) {}
        tile._wmBlobUrl = null;
      }
      const src = tile.src || tile.getAttribute('src') || '';
      if (tile._wmCanceled || !this._map || !src || src.startsWith('data:')) {
        return origOnError.call(this, done, tile, e);
      }
      tile.classList.add('leaflet-tile-retry');
      origOnError.call(this, done, tile, e);   // освобождаем Leaflet сразу
      markFailed(tile, this, true);
    }
  });

  L.TileLayer.addInitHook(function () {
    this.on('tileloadstart', e => pending.set(e.tile, { t0: Date.now(), layer: this }));
    this.on('tileunload', e => forget(e.tile));
    this.on('tileabort', e => forget(e.tile));   // (3) Leaflet шлёт tileabort, а не tileunload
  });

  // Сторож зависших запросов
  setInterval(() => {
    if (document.hidden || !pending.size) return;
    const now = Date.now();
    for (const [tile, p] of pending) {
      if (now - p.t0 < LOAD_TIMEOUT_MS) continue;
      if (!tile.isConnected || !p.layer._map || tile._wmCanceled) { pending.delete(tile); continue; }
      if (!failed.has(tile) && tile._wmDone) {
        try { tile._wmDone(new Error('timeout'), tile); } catch (e) {}
      }
      markFailed(tile, p.layer, false);   // (5) тайм-аут не считается «сеть мертва»
    }
  }, SWEEP_MS);

  function retryAllNow() {
    const now = Date.now();
    let i = 0;
    globalFails = 0;
    globalPauseUntil = 0;
    for (const f of failed.values()) {
      if (f.busy) continue;
      f.n = Math.min(f.n, 2);
      f.due = now + (i++) * 100;
    }
    schedule();
    return failed.size;
  }

  // ---- (7) Предзагрузка соседних уровней зума вокруг центра ----
  // Греет HTTP-кэш, поэтому после зума тайлы «появляются мгновенно».
  function initPrefetch(map) {
    if (!map || map._wmPrefetch) return;
    map._wmPrefetch = true;
    const warm = new Set();
    let t = 0;

    const run = () => {
      t = 0;
      if (document.hidden || navigator.onLine === false) return;
      const conn = navigator.connection;
      if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
      // не конкурируем с видимыми тайлами
      if (pending.size > 4) { t = setTimeout(run, 600); return; }

      const c = map.getCenter();
      let budget = 18;
      map.eachLayer(layer => {
        if (budget <= 0) return;
        if (!(layer instanceof L.TileLayer) || !layer._url || layer._tileZoom === undefined) return;
        if ((layer.options.pane || 'tilePane') !== 'tilePane') return;
        if (layer.options.tms || layer._url.indexOf('{-y}') >= 0) return;
        if (layer._getTilePos !== L.GridLayer.prototype._getTilePos) return;   // Яндекс и т.п.
        const max = layer.options.maxNativeZoom !== undefined ? layer.options.maxNativeZoom : layer.options.maxZoom;
        const min = layer.options.minNativeZoom !== undefined ? layer.options.minNativeZoom : (layer.options.minZoom || 0);
        const ts = layer.getTileSize();
        for (const dz of [1, -1]) {
          const z = layer._tileZoom + dz;
          if (z > max || z < min) continue;
          const p = map.project(c, z);
          const cx = Math.floor(p.x / ts.x), cy = Math.floor(p.y / ts.y);
          const n = Math.pow(2, z);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const x = cx + dx, y = cy + dy;
              if (budget <= 0 || x < 0 || y < 0 || x >= n || y >= n) continue;
              const saved = layer._tileZoom;
              let url;
              layer._tileZoom = z;
              try { url = layer.getTileUrl({ x, y, z }); } catch (e) { url = null; }
              layer._tileZoom = saved;
              if (!url || warm.has(url)) continue;
              warm.add(url);
              budget--;
              const img = new Image();
              if (layer.options.crossOrigin || layer.options.crossOrigin === '') {
                img.crossOrigin = layer.options.crossOrigin === true ? '' : layer.options.crossOrigin;
              }
              img.decoding = 'async';
              img.src = url;
            }
          }
        }
      });
      if (warm.size > 600) warm.clear();
    };

    map.on('moveend zoomend', () => {
      clearTimeout(t);
      t = setTimeout(run, 400);
    });
  }

  window.WM = window.WM || {};
  WM.tileRetry = {
    retryAllNow,
    initPrefetch,
    stats: () => ({ failed: failed.size, pending: pending.size, busy: busyCount(), globalFails })
  };

  window.addEventListener('online', retryAllNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = 0; } else retryAllNow();
  });
})();
