(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  const objects = new Map(), tiles = new Map();
  let db = null;

  function openDB() {
    return new Promise((resolve) => {
      const req = indexedDB.open('WM_Offline_DB', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('objects')) d.createObjectStore('objects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('tiles')) d.createObjectStore('tiles', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('details')) d.createObjectStore('details', { keyPath: 'id' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { console.warn('IndexedDB unavailable, fallback to RAM'); resolve(null); };
    });
  }

  function dbPut(storeName, item) {
    if (!db) return;
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(item);
    } catch (e) {}
  }

  function dbGetAll(storeName) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }

  WM.cache = {
    objects, tiles,
    async init() {
      if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch (e) {}
      }

      await openDB();

      const [savedTiles, savedObjs] = await Promise.all([dbGetAll('tiles'), dbGetAll('objects')]);
      
      for (const o of savedObjs) {
        o.refs = 0;
        objects.set(o.id, o);
      }

      for (const t of savedTiles) {
        t.ids = new Set(t.ids || []);
        tiles.set(t.key, t);
        for (const id of t.ids) {
          const o = objects.get(id);
          if (o) o.refs++;
        }
      }
    },
    tile(t) {
      let e = tiles.get(t.key);
      if (!e) {
        e = { key: t.key, x: t.x, y: t.y, z: t.z, d: t.d, state: 'idle', tries: 0, retryAt: 0, ids: new Set(), used: 0 };
        tiles.set(t.key, e);
      }
      return e;
    },
    saveTileMeta(tile) {
      dbPut('tiles', {
        key: tile.key, x: tile.x, y: tile.y, z: tile.z,
        state: tile.state === 'done' ? 'done' : 'idle',
        ids: Array.from(tile.ids)
      });
    },
    addItems(tile, items) {
      if (!Array.isArray(items)) return [];
      const added = [];
      for (const it of items) {
        const poly = it && (it.polygon || (it.location && it.location.polygon));
        if (!it || it.id == null || !Array.isArray(poly) || poly.length < 3) continue;
        if (tile && tile.ids.has(it.id)) continue;
        let o = objects.get(it.id);
        if (!o) {
          const pts = poly.map(p => [+p.y, +p.x]).filter(p => isFinite(p[0]) && isFinite(p[1]));
          if (pts.length < 3) continue;
          o = { id: it.id, title: it.title || it.name || '', url: it.urlhtml || it.url || '', pts, bbox: G.bboxOf(pts), area: G.areaOf(pts), refs: 0 };
          objects.set(o.id, o);
          dbPut('objects', o);
        }
        if (tile) {
          o.refs++;
          tile.ids.add(o.id);
        } else {
          o.refs = Math.max(o.refs, 1);
        }
        added.push(o);
      }
      if (tile) this.saveTileMeta(tile);
      return added;
    },
    saveDetail(id, data) { dbPut('details', { id, data }); },
    getDetail(id) {
      return new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = db.transaction('details', 'readonly').objectStore('details').get(id);
          req.onsuccess = () => resolve(req.result ? req.result.data : null);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    evict(protectedKeys) {
      if (objects.size <= C.MAX_OBJECTS) return;
      const cand = [...tiles.values()].filter(t => !protectedKeys.has(t.key) && t.state !== 'loading' && t.state !== 'queued')
        .sort((a, b) => a.used - b.used);
      for (const t of cand) {
        if (objects.size <= C.MAX_OBJECTS * 0.85) break;
        for (const id of t.ids) {
          const o = objects.get(id);
          if (o && --o.refs <= 0) objects.delete(id);
        }
        if (t.state !== 'done') tiles.delete(t.key);
      }
    },
    async clearObjects() {
      if (!db) {
        objects.clear();
        tiles.clear();
        return;
      }
      try {
        const tx = db.transaction(['objects', 'tiles', 'details'], 'readwrite');
        tx.objectStore('objects').clear();
        tx.objectStore('tiles').clear();
        tx.objectStore('details').clear();
      } catch (e) {
        console.warn('Ошибка очистки IndexedDB:', e);
      }
      objects.clear();
      tiles.clear();
    },

    async clearRasterTiles() {
      if (window.caches) {
        try {
          await caches.delete('wm-tiles-v1');
          return true;
        } catch (e) {
          console.warn('Ошибка очистки кэша тайлов:', e);
        }
      }
      return false;
    },

    async clearAllStorage() {
      await this.clearObjects();
      await this.clearRasterTiles();
    },

    // 4. ЭКСПОРТ БАЗЫ ОБЪЕКТОВ
    async exportDump() {
      const [allObjs, allTiles, allDetails] = await Promise.all([
        dbGetAll('objects'),
        dbGetAll('tiles'),
        dbGetAll('details')
      ]);

      const dump = {
        version: 1,
        exportedAt: new Date().toISOString(),
        objects: allObjs,
        tiles: allTiles,
        details: allDetails
      };

      const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wikimapia_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
      return allObjs.length;
    },

    // 4. ИМПОРТ БАЗЫ ОБЪЕКТОВ
    async importDump(jsonStr) {
      const data = JSON.parse(jsonStr);
      if (!data || (!Array.isArray(data.objects) && !Array.isArray(data.tiles))) {
        throw new Error('Некорректный формат файла бэкапа');
      }

      if (db) {
        const tx = db.transaction(['objects', 'tiles', 'details'], 'readwrite');
        const sObj = tx.objectStore('objects');
        const sTile = tx.objectStore('tiles');
        const sDet = tx.objectStore('details');

        if (Array.isArray(data.objects)) {
          for (const o of data.objects) sObj.put(o);
        }
        if (Array.isArray(data.tiles)) {
          for (const t of data.tiles) sTile.put(t);
        }
        if (Array.isArray(data.details)) {
          for (const d of data.details) sDet.put(d);
        }

        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = rej;
        });
      }

      // Обновляем состояние в оперативной памяти
      if (Array.isArray(data.objects)) {
        for (const o of data.objects) objects.set(o.id, o);
      }
      if (Array.isArray(data.tiles)) {
        for (const t of data.tiles) {
          t.ids = new Set(t.ids || []);
          tiles.set(t.key, t);
        }
      }

      return (data.objects && data.objects.length) || 0;
    }
  };
})();