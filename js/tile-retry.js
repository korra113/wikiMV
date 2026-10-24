// =========================================================================
// tile-retry.js — устойчивая загрузка растровых тайлов Leaflet
// =========================================================================
(function () {
  const LOAD_TIMEOUT_MS = 10000;   // тайл «завис» без ответа
  const BASE_DELAY_MS = 1500;
  const MAX_DELAY_MS = 30000;
  const MAX_PARALLEL_RETRY = 4;
  const SWEEP_MS = 2500;

  const pending = new Map();  // tile -> { t0, layer }          идёт загрузка
  const failed = new Map();   // tile -> { layer, n, due, busy } ждёт повтора
  let timer = 0;
  let globalFails = 0;        // неудачи подряд без единого успеха
  let globalPauseUntil = 0;

  const delayFor = n =>
    Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(1.7, n)) * (0.75 + Math.random() * 0.5);

  const busyCount = () => {
    let c = 0;
    for (const f of failed.values()) if (f.busy) c++;
    return c;
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
    const wait = Math.max(400, Math.max(next, globalPauseUntil) - Date.now());
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
      tile.src = tile._wmSrc;   // тот же URL → запрос уйдёт заново, SW-кэш сохраняется
    }
    schedule();
  }

  function markFailed(tile, layer) {
    pending.delete(tile);
    let f = failed.get(tile);
    if (!f) { f = { layer, n: 0, due: 0, busy: false }; failed.set(tile, f); }
    f.busy = false;
    f.n++;
    globalFails++;
    if (globalFails >= 10) {
      // сеть явно плоха: даём ей передохнуть, а не долбим запросами
      globalPauseUntil = Date.now() + Math.min(20000, (globalFails - 9) * 1500);
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
    pending.delete(tile);
    failed.delete(tile);
  }

  // ---- Патч L.TileLayer ----
  const origCreate = L.TileLayer.prototype.createTile;
  const origOnLoad = L.TileLayer.prototype._tileOnLoad;
  const origOnError = L.TileLayer.prototype._tileOnError;
  const origInitTile = L.GridLayer.prototype._initTile;

  L.GridLayer.include({
    _initTile(tile) {
      origInitTile.call(this, tile);
      const size = this.getTileSize();
      // 1px нахлёста перекрывает субпиксельный зазор между тайлами
      tile.style.width = (size.x + 1) + 'px';
      tile.style.height = (size.y + 1) + 'px';
    }
  });

  L.TileLayer.include({
    createTile(coords, done) {
      const tile = origCreate.call(this, coords, done);
      tile._wmDone = done;
      tile._wmSrc = tile.src || tile.getAttribute('src');
      return tile;
    },

    _tileOnLoad(done, tile) {
      tile.classList.remove('leaflet-tile-retry', 'leaflet-tile-error');
      onTileOk(tile);
      origOnLoad.call(this, done, tile);
    },

    _tileOnError(done, tile, e) {
      const src = tile.src || tile.getAttribute('src') || '';
      if (!this._map || !src || src.startsWith('data:')) {
        return origOnError.call(this, done, tile, e);
      }
      tile.classList.add('leaflet-tile-retry');
      origOnError.call(this, done, tile, e);   // освобождаем Leaflet сразу
      markFailed(tile, this);
    }
  });

  L.TileLayer.addInitHook(function () {
    this.on('tileloadstart', e => pending.set(e.tile, { t0: Date.now(), layer: this }));
    this.on('tileunload', e => forget(e.tile));
  });

  // Сторож зависших запросов
  setInterval(() => {
    if (document.hidden || !pending.size) return;
    const now = Date.now();
    for (const [tile, p] of pending) {
      if (now - p.t0 < LOAD_TIMEOUT_MS) continue;
      if (!tile.isConnected || !p.layer._map) { pending.delete(tile); continue; }
      if (!failed.has(tile) && tile._wmDone) {
        try { tile._wmDone(new Error('timeout'), tile); } catch (e) {}
      }
      markFailed(tile, p.layer);
    }
  }, SWEEP_MS);

  function retryAllNow() {
    const now = Date.now();
    let i = 0;
    globalFails = 0;
    globalPauseUntil = 0;
    for (const f of failed.values()) {
      if (f.busy) continue;
      f.n = Math.min(f.n, 2);          // сбрасываем «разгон» паузы
      f.due = now + (i++) * 120;       // растягиваем, чтобы не устроить пик запросов
    }
    schedule();
    return failed.size;
  }

  window.WM = window.WM || {};
  WM.tileRetry = {
    retryAllNow,
    stats: () => ({ failed: failed.size, pending: pending.size, busy: busyCount(), globalFails })
  };

  window.addEventListener('online', retryAllNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = 0; } else retryAllNow();
  });
})();