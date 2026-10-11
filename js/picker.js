(function () {
  const WM = window.WM, C = WM.config, G = WM.geo;
  let map, mode = 'cross', raf = 0, hoverObj = null, hoverAlts = [];
  let isFetchingPoint = false;

  let holdTimer = null;
  let touchPreviewTimer = null;
  let lastAnchorPix = null;
  let lastAnchorLatLng = null;

  let lastTouchTime = 0;
  let suppressClickUntil = 0;

  const DOUBLE_TAP_MAX_DELAY_MS = 320;
  const DOUBLE_TAP_MAX_DIST_PX = 36;
  const ZOOM_SENSITIVITY = 120;

  let pendingTapTimer = null;
  let lastTapTime = 0;
  let lastTapPt = null;

  let isDoubleTapDragging = false;
  let hasMovedZoom = false;
  let doubleTapAnchorPt = null;
  let doubleTapAnchorLatLng = null;
  let doubleTapStartZoom = 0;
  let currentZoom = 0;
  let currentCenter = null;
  let animFrameId = 0;

  let crosshairDetailTimer = null;
  let crosshairDetailTargetId = null;

  let touchStartPos = null;
  let touchMoved = false;

  // Вспомогательная функция (внутри WM.picker.init или в начале файла picker.js):
  function isInteractiveMarker(target) {
    return !!(target && target.closest && target.closest(
      '.wm-ruler-vertex-icon, .wm-ruler-vertex-wrap, .wm-ruler-midpoint-icon, .wm-ruler-track-badge, .wm-custom-marker-icon, .leaflet-popup, .leaflet-control'
    ));
  }


  function isScaleAppropriate(o, zoom, mapSize, strictScreenFit = false) {
    const p1 = map.project([o.bbox.n, o.bbox.w], zoom);
    const p2 = map.project([o.bbox.s, o.bbox.e], zoom);
    const wPx = Math.abs(p2.x - p1.x);
    const hPx = Math.abs(p2.y - p1.y);

    if (Math.max(wPx, hPx) < (C.PICKER_MIN_PX || 10)) return false;

    if (strictScreenFit) {
      const maxW = mapSize.x * (C.PICKER_MAX_SCREEN_RATIO || 1.15);
      const maxH = mapSize.y * (C.PICKER_MAX_SCREEN_RATIO || 1.15);
      if (wPx > maxW || hPx > maxH) return false;
    } else {
      if (wPx > mapSize.x * 2.2 && hPx > mapSize.y * 2.2) return false;
    }

    return true;
  }

  function hitTest(latlng, options = {}) {
    const { strictScreenFit = false } = options;
    const zoom = map.getZoom();
    const tolDeg = C.HIT_TOLERANCE_PX * 360 / (256 * 2 ** zoom);
    const p = map.project(latlng, zoom);
    const proj = c => map.project(c, zoom);
    const mapSize = map.getSize();

    const inside = [], near = [];
    const pool = WM.cache ? WM.cache.objects.values() : [];

    for (const o of pool) {
      // Игнорируем скрытые типы объектов
      if (WM.view && WM.view.isObjectAllowed && !WM.view.isObjectAllowed(o)) continue;

      const b = o.bbox;
      if (latlng.lng < b.w - tolDeg || latlng.lng > b.e + tolDeg || 
          latlng.lat < b.s - tolDeg || latlng.lat > b.n + tolDeg) continue;

      if (!isScaleAppropriate(o, zoom, mapSize, strictScreenFit)) continue;

      if (G.pointInPoly(latlng.lat, latlng.lng, o.pts)) {
        inside.push(o);
      } else if (!strictScreenFit) {
        const d = G.distToEdge(p, o.pts, proj);
        if (d <= C.HIT_TOLERANCE_PX) near.push({ o, d });
      }
    }

    inside.sort((a, b) => (a.area || 0) - (b.area || 0));
    near.sort((a, b) => a.d - b.d);

    return inside.concat(near.map(n => n.o));
  }

  function checkCrosshairDetailLoad(obj) {
    const isAutoDetails = WM.ui && WM.ui.isAutoDetailsEnabled();
    const isCrossOnly = WM.ui && WM.ui.isAutoDetailsCrosshairOnly();

    if (!isAutoDetails || !isCrossOnly || mode !== 'cross' || !obj || obj.hasDetail || obj.detailFailed || obj.detailLoading) {
      if (crosshairDetailTimer) {
        clearTimeout(crosshairDetailTimer);
        crosshairDetailTimer = null;
      }
      crosshairDetailTargetId = null;
      return;
    }

    // Если перекрестие уже отсчитывает время для этого же объекта
    if (crosshairDetailTargetId === obj.id) return;

    if (crosshairDetailTimer) {
      clearTimeout(crosshairDetailTimer);
    }

    crosshairDetailTargetId = obj.id;
    crosshairDetailTimer = setTimeout(async () => {
      crosshairDetailTimer = null;
      if (mode === 'cross' && hoverObj && hoverObj.id === obj.id && !obj.hasDetail && !obj.detailLoading) {
        if (WM.loader && WM.loader.loadObjectDetails) {
          await WM.loader.loadObjectDetails(obj);
        }
      }
    }, 200);
  }

  function select(obj, alts) {
    if (WM.view) WM.view.setSelected(obj);
    if (WM.ui && WM.ui.openPlace) WM.ui.openPlace(obj, alts || [obj]);
  }

  function updateCross() {
    raf = 0;
    if (mode !== 'cross') {
      checkCrosshairDetailLoad(null);
      return;
    }
    const center = map.getCenter();
    hoverAlts = hitTest(center, { strictScreenFit: true });
    hoverObj = hoverAlts[0] || null;
    if (WM.view) WM.view.setHover(hoverObj);
    if (WM.ui && WM.ui.setPill) WM.ui.setPill(hoverObj, hoverAlts.length);

    // Запуск таймера 200 мс для загрузки карточки под перекрестием
    checkCrosshairDetailLoad(hoverObj);
  }

  function scheduleCross() {
    if (mode === 'cross' && !raf) raf = requestAnimationFrame(updateCross);
  }

  async function ensurePointLoaded(latlng, autoOpen = false, strictScreenFit = false) {
    if (isFetchingPoint) return [];
    let hits = hitTest(latlng, { strictScreenFit });
    if (hits.length) {
      if (autoOpen) select(hits[0], hits.slice(0, 8));
      return hits;
    }

    isFetchingPoint = true;
    if (WM.ui && WM.ui.setStatus) WM.ui.setStatus('🔍 Загрузка объекта…');
    try {
      const added = (WM.loader && WM.loader.fetchPoint) ? await WM.loader.fetchPoint(latlng.lat, latlng.lng) : [];
      if (WM.view) WM.view.render();
      hits = hitTest(latlng, { strictScreenFit });
      if (!hits.length && added && added.length) {
        hits = added.filter(o => isScaleAppropriate(o, map.getZoom(), map.getSize(), strictScreenFit));
        hits.sort((a, b) => (a.area || 0) - (b.area || 0));
      }

      if (hits.length) {
        if (autoOpen) {
          select(hits[0], hits.slice(0, 8));
        } else if (mode === 'cross') {
          updateCross();
        } else {
          hoverAlts = hits;
          hoverObj = hits[0];
          if (WM.view) WM.view.setHover(hoverObj);
          if (WM.ui && WM.ui.setPill) WM.ui.setPill(hoverObj, hits.length);
        }
      } else if (autoOpen) {
        if (WM.ui && WM.ui.closeSheet) WM.ui.closeSheet();
      }
      return hits;
    } finally {
      isFetchingPoint = false;
      if (WM.ui && WM.ui.updateStatusFromLoader) WM.ui.updateStatusFromLoader();
    }
  }

  function resetHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function onPointerMoveCheck(curPointPix, latlng) {
    if (WM.ui && !WM.ui.isAutoHoverEnabled()) {
      resetHoldTimer();
      return;
    }

    if (!lastAnchorPix) {
      lastAnchorPix = curPointPix;
      lastAnchorLatLng = latlng;
      startHoldTimer(latlng);
      return;
    }

    const dist = Math.hypot(curPointPix.x - lastAnchorPix.x, curPointPix.y - lastAnchorPix.y);
    if (dist > (C.HOVER_JITTER_PX || 18)) {
      lastAnchorPix = curPointPix;
      lastAnchorLatLng = latlng;
      resetHoldTimer();
      startHoldTimer(latlng);
    }
  }

  function startHoldTimer(latlng) {
    resetHoldTimer();
    if ((WM.ui && !WM.ui.isAutoHoverEnabled()) || isDoubleTapDragging) return;

    holdTimer = setTimeout(async () => {
      const hits = hitTest(latlng, { strictScreenFit: (mode === 'cross') });
      if (!hits.length) {
        await ensurePointLoaded(latlng, false, (mode === 'cross'));
      }
    }, C.HOVER_HOLD_DELAY_MS || 1000);
  }

  async function handleIntentionalTap(clickedLatLng) {
    if (Date.now() < suppressClickUntil) return;

    // ПЕРЕХВАТ КЛИКА ЛИНЕЙКОЙ
    if (WM.measure && WM.measure.isActive()) {
      // Если включено перекрестие — ставим точку в центр карты, иначе — по месту клика/тапа
      const targetLatLng = (mode === 'cross') ? map.getCenter() : clickedLatLng;
      WM.measure.onMapClick(targetLatLng);
      return;
    }

    // Если шторка открыта в половинчатом виде — одиночный тап по карте закрывает её
    const sheet = document.getElementById('sheet');
    if (sheet && sheet.classList.contains('open') && !sheet.classList.contains('full')) {
      if (WM.ui && WM.ui.closeSheet) WM.ui.closeSheet();
      return;
    }

    if (mode === 'cross') {
      const center = map.getCenter();
      const hits = hitTest(center, { strictScreenFit: true });

      if (hits.length) {
        select(hits[0], hits.slice(0, 8));
      } else {
        await ensurePointLoaded(center, false, true);
      }
      return;
    }

    const hits = await ensurePointLoaded(clickedLatLng, false, false);
    if (hits && hits.length) {
      select(hits[0], hits.slice(0, 8));
    }
  }

  WM.picker = {
    init(m) {
      map = m;
      const container = map.getContainer();

      container.addEventListener('touchstart', e => {
        if (isInteractiveMarker(e.target)) {
          resetHoldTimer();
          if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
          return;
        }

        lastTouchTime = Date.now();
        if (touchPreviewTimer) { clearTimeout(touchPreviewTimer); touchPreviewTimer = null; }

        if (e.touches.length !== 1) {
          if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
          if (isDoubleTapDragging) {
            isDoubleTapDragging = false;
            map.dragging.enable();
          }
          resetHoldTimer();
          touchMoved = true;
          suppressClickUntil = Date.now() + 400;
          return;
        }


        const t = e.touches[0];
        const pt = L.point(t.clientX, t.clientY);
        const now = Date.now();
        touchStartPos = pt;
        touchMoved = false;

        const isSecondTap = lastTapPt && 
                            (now - lastTapTime < DOUBLE_TAP_MAX_DELAY_MS) && 
                            (pt.distanceTo(lastTapPt) < DOUBLE_TAP_MAX_DIST_PX);

        if (isSecondTap) {
          if (pendingTapTimer) {
            clearTimeout(pendingTapTimer);
            pendingTapTimer = null;
          }
          resetHoldTimer();
          suppressClickUntil = now + 600;

          isDoubleTapDragging = true;
          hasMovedZoom = false;
          doubleTapAnchorPt = pt;
          doubleTapAnchorLatLng = map.containerPointToLatLng(pt);
          doubleTapStartZoom = map.getZoom();
          currentZoom = doubleTapStartZoom;
          currentCenter = map.getCenter();

          map._stop();
          map.dragging.disable();
          e.preventDefault();
          return;
        }

        lastAnchorPix = pt;
        lastAnchorLatLng = map.containerPointToLatLng(pt);

        // Интерактивная подсветка и вывод подсказки при удержании пальца на прогруженном объекте
        if (mode !== 'cross') {
          const hits = hitTest(lastAnchorLatLng, { strictScreenFit: false });
          if (hits.length > 0) {
            touchPreviewTimer = setTimeout(() => {
              if (!touchMoved) {
                hoverAlts = hits;
                hoverObj = hits[0];
                if (WM.view) WM.view.setHover(hoverObj);
                if (WM.ui && WM.ui.setPill) WM.ui.setPill(hoverObj, hits.length);
              }
            }, 180);
          }
          startHoldTimer(lastAnchorLatLng);
        }
      }, { passive: false });

      container.addEventListener('touchmove', e => {
        lastTouchTime = Date.now();
        if (e.touches.length !== 1) return;

        const t = e.touches[0];
        const pt = L.point(t.clientX, t.clientY);

        if (isDoubleTapDragging && doubleTapAnchorPt) {
          e.preventDefault();
          const deltaY = pt.y - doubleTapAnchorPt.y;

          if (Math.abs(deltaY) > 5) {
            hasMovedZoom = true;
          }

          const zoomChange = deltaY / ZOOM_SENSITIVITY;
          currentZoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), doubleTapStartZoom + zoomChange));

          const halfSize = map.getSize().divideBy(2);
          const anchorOffset = doubleTapAnchorPt.subtract(halfSize);
          currentCenter = map.unproject(
            map.project(doubleTapAnchorLatLng, currentZoom).subtract(anchorOffset),
            currentZoom
          );

          if (!animFrameId) {
            animFrameId = requestAnimationFrame(() => {
              animFrameId = 0;
              if (!isDoubleTapDragging) return;
              map._move(currentCenter, currentZoom, { pinch: true, round: false });
            });
          }
          return;
        }

        if (touchStartPos && pt.distanceTo(touchStartPos) > (C.TAP_MAX_MOVE_PX || 8)) {
          touchMoved = true;
          if (touchPreviewTimer) { clearTimeout(touchPreviewTimer); touchPreviewTimer = null; }
          resetHoldTimer();
          if (pendingTapTimer) {
            clearTimeout(pendingTapTimer);
            pendingTapTimer = null;
          }
          // При сдвиге карты сбрасываем подсветку
          if (mode !== 'cross' && hoverObj) {
            hoverObj = null;
            hoverAlts = [];
            if (WM.view) WM.view.setHover(null);
            if (WM.ui && WM.ui.setPill) WM.ui.setPill(null);
          }
        }

        if (mode !== 'cross') {
          onPointerMoveCheck(pt, map.containerPointToLatLng(pt));
        }
      }, { passive: false });

      container.addEventListener('touchend', e => {
        // Если тап пришёлся по узлу линейки или маркеру — прерываем логику клика по карте
        if (isInteractiveMarker(e.target)) {
          resetHoldTimer();
          if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
          return;
        }

        lastTouchTime = Date.now();
        if (touchPreviewTimer) { clearTimeout(touchPreviewTimer); touchPreviewTimer = null; }
        resetHoldTimer();
        lastAnchorPix = null;

        if (animFrameId) {
          cancelAnimationFrame(animFrameId);
          animFrameId = 0;
        }

        if (isDoubleTapDragging) {
          isDoubleTapDragging = false;
          map.dragging.enable();
          suppressClickUntil = Date.now() + 500;
          lastTapTime = 0;
          lastTapPt = null;

          if (hasMovedZoom) {
            const finalZoom = map._limitZoom(currentZoom);
            if (map.options.zoomAnimation) {
              map._animateZoom(currentCenter, finalZoom, true, map.options.zoomSnap);
            } else {
              map._resetView(currentCenter, finalZoom);
            }
          } else {
            if (doubleTapAnchorPt) {
              const targetZoom = Math.min(map.getMaxZoom(), Math.round(map.getZoom() + 1));
              map.setZoomAround(doubleTapAnchorPt, targetZoom, { animate: true });
            }
          }

          doubleTapAnchorPt = null;
          doubleTapAnchorLatLng = null;
          return;
        }

        if (!touchMoved) {
          const t = e.changedTouches[0];
          const pt = L.point(t.clientX, t.clientY);
          const latlng = map.containerPointToLatLng(pt);

          lastTapTime = Date.now();
          lastTapPt = pt;

          if (pendingTapTimer) clearTimeout(pendingTapTimer);
          pendingTapTimer = setTimeout(() => {
            pendingTapTimer = null;
            lastTapTime = 0;
            lastTapPt = null;
            if (isInteractiveMarker(e.target)) {
              if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
              return;
            }
            handleIntentionalTap(latlng);
          }, DOUBLE_TAP_MAX_DELAY_MS + 20);
        } else {
          lastTapTime = 0;
          lastTapPt = null;
        }
      });

      container.addEventListener('touchcancel', () => {
        lastTouchTime = Date.now();
        if (touchPreviewTimer) { clearTimeout(touchPreviewTimer); touchPreviewTimer = null; }
        if (isDoubleTapDragging) {
          isDoubleTapDragging = false;
          map.dragging.enable();
        }
        if (pendingTapTimer) {
          clearTimeout(pendingTapTimer);
          pendingTapTimer = null;
        }
        if (animFrameId) {
          cancelAnimationFrame(animFrameId);
          animFrameId = 0;
        }
        resetHoldTimer();
        lastTapTime = 0;
        lastTapPt = null;
        lastAnchorPix = null;
      });

      let mouseDownInfo = null;

      container.addEventListener('mousedown', e => {
        if (Date.now() - lastTouchTime < 700) return;
        if (e.button !== 0) return;
        if (isInteractiveMarker(e.target)) return; // <-- Добавлено

        mouseDownInfo = {
          time: Date.now(),
          pt: L.point(e.clientX, e.clientY),
          hasMoved: false
        };
      });

      container.addEventListener('mousemove', e => {
        if (Date.now() - lastTouchTime < 700) return;
        if (mouseDownInfo) {
          const pt = L.point(e.clientX, e.clientY);
          if (pt.distanceTo(mouseDownInfo.pt) > (C.TAP_MAX_MOVE_PX || 8)) {
            mouseDownInfo.hasMoved = true;
          }
        }

        // Подсветка курсором мыши в режиме свободного перемещения
        if (mode !== 'cross') {
          const rect = container.getBoundingClientRect();
          const localPt = L.point(e.clientX - rect.left, e.clientY - rect.top);
          const latlng = map.containerPointToLatLng(localPt);

          const hits = hitTest(latlng, { strictScreenFit: false });
          if (hits.length > 0) {
            hoverAlts = hits;
            hoverObj = hits[0];
            if (WM.view) WM.view.setHover(hoverObj);
            if (WM.ui && WM.ui.setPill) WM.ui.setPill(hoverObj, hits.length);
            container.style.cursor = 'pointer';
          } else {
            if (hoverObj) {
              hoverObj = null;
              hoverAlts = [];
              if (WM.view) WM.view.setHover(null);
              if (WM.ui && WM.ui.setPill) WM.ui.setPill(null);
              container.style.cursor = '';
            }
          }

          onPointerMoveCheck(localPt, latlng);
        }
      });

      container.addEventListener('mouseup', e => {
        if (Date.now() - lastTouchTime < 700) return;
        if (e.button !== 0 || !mouseDownInfo) return;
        const duration = Date.now() - mouseDownInfo.time;
        const wasClick = !mouseDownInfo.hasMoved && duration <= 400;
        mouseDownInfo = null;

        if (isInteractiveMarker(e.target)) return; // <-- Добавлено

        if (wasClick && Date.now() > suppressClickUntil) {
          const rect = container.getBoundingClientRect();
          const localPt = L.point(e.clientX - rect.left, e.clientY - rect.top);
          handleIntentionalTap(map.containerPointToLatLng(localPt));
        }
      });

      map.on('movestart', () => {
        resetHoldTimer();
        lastAnchorPix = null;
      });

      map.on('move', scheduleCross);

      map.on('moveend', () => {
        scheduleCross();
        if (mode === 'cross' && WM.ui && WM.ui.isAutoHoverEnabled() && !isDoubleTapDragging) {
          const center = map.getCenter();
          const hits = hitTest(center, { strictScreenFit: true });
          if (!hits.length) {
            resetHoldTimer();
            holdTimer = setTimeout(() => {
              ensurePointLoaded(map.getCenter(), false, true);
            }, C.HOVER_HOLD_DELAY_MS || 1000);
          }
        }
      });

      container.addEventListener('mouseleave', () => {
        resetHoldTimer();
        lastAnchorPix = null;
        if (mode !== 'cross' && hoverObj) {
          hoverObj = null;
          hoverAlts = [];
          if (WM.view) WM.view.setHover(null);
          if (WM.ui && WM.ui.setPill) WM.ui.setPill(null);
          container.style.cursor = '';
        }
      });
    },
    select,
    refresh: scheduleCross,
    getMode() { return mode; },
    toggleMode() {
      this.setMode(mode === 'tap' ? 'cross' : 'tap');
    },
    setMode(m) {
      mode = m;
      resetHoldTimer();
      lastAnchorPix = null;
      hoverObj = null;
      hoverAlts = [];
      if (WM.view) WM.view.setHover(null);
      if (WM.ui && WM.ui.setPill) WM.ui.setPill(null);
      if (map) map.getContainer().style.cursor = '';

      const ch = document.getElementById('crosshair');
      if (ch) ch.hidden = m !== 'cross';

      const btn = document.getElementById('btn-mode-toggle');
      if (btn) {
        btn.textContent = m === 'cross' ? '✛' : '👆';
        btn.title = m === 'cross' ? 'Режим: Перекрестие (нажмите для смены)' : 'Режим: Палец (нажмите для смены)';
        btn.classList.toggle('active', m === 'cross');
      }

      if (WM.api && WM.api.store) WM.api.store.set('wm_mode', m);
      scheduleCross();
    },
    openHover() {
      if (hoverObj) {
        select(hoverObj, hoverAlts.slice(0, 8));
      } else if (mode === 'cross') {
        ensurePointLoaded(map.getCenter(), true, true);
      }
    },
    async fetchAtCrosshair() {
      const center = map.getCenter();
      return await ensurePointLoaded(center, false, true);
    }
  };
})();