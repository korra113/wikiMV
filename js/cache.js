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

      const [savedTiles, savedObjs, savedDetails] = await Promise.all([
        dbGetAll('tiles'), 
        dbGetAll('objects'),
        dbGetAll('details')
      ]);
      
      // Формируем список ID просмотренных объектов из сохранённых карточек
      const visitedIds = new Set();
      for (const d of savedDetails) {
        if (d && d.id) {
          const rawId = String(d.id).split(':')[0];
          if (rawId) visitedIds.add(+rawId);
        }
      }

      for (const o of savedObjs) {
        o.refs = 0;
        if (visitedIds.has(o.id)) o.hasDetail = true;
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
    setCustomColor(id, color) {
      const o = objects.get(id);
      if (o) {
        if (color) {
          o.customColor = color;
        } else {
          delete o.customColor;
        }
        dbPut('objects', o);
      }
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


    markVisited(id, detail) {
      const o = objects.get(id);
      if (o) {
        o.hasDetail = true;
        if (detail) {
          const ph = detail.photos;
          o.photosCount = Array.isArray(ph) ? ph.length : (ph && typeof ph === 'object' ? Object.keys(ph).length : 0);
          
          const cm = detail.comments;
          o.commentsCount = Array.isArray(cm) ? cm.length : (cm && typeof cm === 'object' ? Object.keys(cm).length : 0);

          if (detail.tags) {
            const raw = Array.isArray(detail.tags) ? detail.tags : Object.values(detail.tags);
            o.tags = raw.map(t => ({
              id: t && t.id ? t.id : null,
              title: t && (t.title || t.name || '')
            })).filter(t => t.title);
          }
        }
        dbPut('objects', o);
      }
    },

    updateObject(o) {
      if (!o || !o.id) return;
      objects.set(o.id, o);
      dbPut('objects', o);
    },

    saveDetail(id, data, lang = 'ru') { 
      const key = `${id}:${lang}`;
      dbPut('details', { id: key, data });
      this.markVisited(id, data);
    },
    getDetail(id, lang = 'ru') {
      const key = `${id}:${lang}`;
      return new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = db.transaction('details', 'readonly').objectStore('details').get(key);
          req.onsuccess = () => {
            if (req.result) {
              resolve(req.result.data);
            } else if (lang === 'ru') {
              // Обратная совместимость для старых записей, сохранённых только по id
              const fallbackReq = db.transaction('details', 'readonly').objectStore('details').get(id);
              fallbackReq.onsuccess = () => resolve(fallbackReq.result ? fallbackReq.result.data : null);
              fallbackReq.onerror = () => resolve(null);
            } else {
              resolve(null);
            }
          };
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

      // Очистка меток
      if (WM.markers && WM.markers.clearAll) {
        WM.markers.clearAll();
      } else {
        try { localStorage.removeItem('wm_user_markers'); } catch (e) {}
      }

      // Очистка измерений линейки
      if (WM.measure && WM.measure.clearAll) {
        WM.measure.clearAll();
      } else {
        try {
          localStorage.removeItem('wm_ruler_tracks');
          localStorage.removeItem('wm_ruler_points');
        } catch (e) {}
      }
    },

    // 4. ЭКСПОРТ БАЗЫ ОБЪЕКТОВ
    async exportDump() {
      const [allObjs, allTiles, allDetails] = await Promise.all([
        dbGetAll('objects'),
        dbGetAll('tiles'),
        dbGetAll('details')
      ]);

      // Объединяем объекты из IndexedDB и RAM, чтобы не потерять то, что в памяти
      const objMap = new Map();
      allObjs.forEach(o => objMap.set(o.id, o));
      for (const [id, o] of objects) {
        if (!objMap.has(id)) {
          objMap.set(id, o);
        } else {
          objMap.set(id, { ...objMap.get(id), ...o });
        }
      }
      const finalObjs = Array.from(objMap.values());

      // Объединяем тайлы из IndexedDB и RAM
      const tileMap = new Map();
      allTiles.forEach(t => tileMap.set(t.key, t));
      for (const [k, t] of tiles) {
        if (!tileMap.has(k)) {
          tileMap.set(k, {
            key: t.key, x: t.x, y: t.y, z: t.z,
            state: t.state === 'done' ? 'done' : 'idle',
            ids: Array.from(t.ids || [])
          });
        }
      }
      const finalTiles = Array.from(tileMap.values());

      // Собираем ВСЕ настройки приложения (любые ключи wm_*)
      const settings = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wm_')) {
          // Исключаем маркеры и линейку — они идут в свои структурированные разделы
          if (k === 'wm_user_markers' || k === 'wm_ruler_points' || k === 'wm_ruler_tracks') continue;
          settings[k] = localStorage.getItem(k);
        }
      }

      const dump = {
        version: 2,
        exportedAt: new Date().toISOString(),
        settings,
        markers: WM.markers ? WM.markers.exportData() : JSON.parse(localStorage.getItem('wm_user_markers') || '[]'),
        measure: WM.measure ? WM.measure.exportData() : JSON.parse(localStorage.getItem('wm_ruler_tracks') || localStorage.getItem('wm_ruler_points') || '[]'),
        objects: finalObjs,
        tiles: finalTiles,
        details: allDetails
      };

      // Без лишних пробелов для экономии места и скорости
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

      return finalObjs.length;
    },

    // ИМПОРТ: Полное восстановление
    async importDump(jsonStr) {
      const data = JSON.parse(jsonStr);
      if (!data || (!Array.isArray(data.objects) && !Array.isArray(data.tiles))) {
        throw new Error('Некорректный формат файла бэкапа');
      }

      // Собираем множество просмотренных объектов заранее
      const visitedIds = new Set();
      if (Array.isArray(data.details)) {
        for (const d of data.details) {
          if (d && d.id) visitedIds.add(+String(d.id).split(':')[0]);
        }
      }

      // 1. Очистка и запись в IndexedDB
      if (db) {
        const tx = db.transaction(['objects', 'tiles', 'details'], 'readwrite');
        const sObj = tx.objectStore('objects');
        const sTile = tx.objectStore('tiles');
        const sDet = tx.objectStore('details');

        sObj.clear();
        sTile.clear();
        sDet.clear();

        if (Array.isArray(data.objects)) {
          for (const o of data.objects) {
            if (visitedIds.has(o.id)) o.hasDetail = true;
            sObj.put(o);
          }
        }
        if (Array.isArray(data.tiles)) {
          for (const t of data.tiles) {
            sTile.put({
              ...t,
              ids: Array.isArray(t.ids) ? t.ids : (t.ids && typeof t.ids === 'object' ? Object.values(t.ids) : [])
            });
          }
        }
        if (Array.isArray(data.details)) {
          for (const d of data.details) sDet.put(d);
        }

        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = rej;
        });
      }

      // 2. Обновление оперативной памяти
      objects.clear();
      tiles.clear();

      if (Array.isArray(data.objects)) {
        for (const o of data.objects) {
          if (visitedIds.has(o.id)) o.hasDetail = true;
          o.refs = o.refs || 0;
          objects.set(o.id, o);
        }
      }

      if (Array.isArray(data.tiles)) {
        for (const t of data.tiles) {
          t.ids = new Set(Array.isArray(t.ids) ? t.ids : []);
          tiles.set(t.key, t);
          for (const id of t.ids) {
            const o = objects.get(id);
            if (o) o.refs++;
          }
        }
      }

      // 3. Восстановление меток пользователя
      if (Array.isArray(data.markers)) {
        if (WM.markers && WM.markers.importData) {
          WM.markers.importData(data.markers);
        } else {
          localStorage.setItem('wm_user_markers', JSON.stringify(data.markers));
        }
      }

      // 4. Восстановление измерений линейки
      if (Array.isArray(data.measure)) {
        if (WM.measure && WM.measure.importData) {
          WM.measure.importData(data.measure);
        } else {
          localStorage.setItem('wm_ruler_tracks', JSON.stringify(data.measure));
        }
      }

      // 5. Восстановление всех настроек (поддерживает и строки, и объекты)
      if (data.settings && typeof data.settings === 'object') {
        for (const [k, v] of Object.entries(data.settings)) {
          localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
      }

      return (data.objects && data.objects.length) || 0;
    }
  };
})();