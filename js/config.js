window.WM = window.WM || {};
WM.config = {
  MIN_ZOOM: 10,            // ниже этого масштаба векторные плитки не запрашиваются
  
  // Динамический порог зума для гибридного режима (сохраняется в настройках)
  get VECTOR_ZOOM() {
    try {
      const v = localStorage.getItem('wm_hybrid_zoom');
      return v !== null ? parseFloat(v) : 13;
    } catch (e) {
      return 13;
    }
  },
  set VECTOR_ZOOM(val) {
    try {
      localStorage.setItem('wm_hybrid_zoom', val);
    } catch (e) {}
  },

  PAGE_SIZE: 100,
  
  // Детализированная сетка LOD
  LOD: [
    { z: 16, tz: 15, pages: 1 },
    { z: 15, tz: 14, pages: 1 },
    { z: 14, tz: 13, pages: 1 },
    { z: 13, tz: 12, pages: 1 }
  ],
  MAX_TILES_PER_VIEW: 6,
  CONCURRENCY: 2,
  MAX_TRIES: 3,
  MAX_OBJECTS: 30000,      // Увеличено с 6000 до 30 000 объектов
  MAX_RENDERED: 1500,
  MIN_PX: 6,
  VIEW_PAD: 0.3,
  HIT_TOLERANCE_PX: 10,
  TIMEOUT_MS: 15000,
  DETAIL_CACHE_MAX: 200,

  HOVER_HOLD_DELAY_MS: 1000,
  HOVER_JITTER_PX: 18,

  PICKER_MIN_PX: 10,
  PICKER_MAX_SCREEN_RATIO: 1.15,

  TAP_MAX_DELAY_MS: 260,
  TAP_MAX_MOVE_PX: 8,
  DOUBLE_TAP_MAX_DELAY_MS: 320,
  DOUBLE_TAP_MAX_DIST_PX: 28,
  DOUBLE_TAP_ZOOM_SENSITIVITY: 160
};