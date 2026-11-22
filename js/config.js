// Динамический лимит объектов на основе доступной памяти устройства (RAM)
function computeDeviceMaxObjects() {
  const ram = navigator.deviceMemory || 4; // Значение в ГБ
  if (ram <= 2) return 5000;
  if (ram <= 3) return 8000;
  if (ram <= 4) return 14000;
  return 25000;
}

window.WM = window.WM || {};
WM.config = {
  MIN_ZOOM: 10,
  MAX_OBJECTS: computeDeviceMaxObjects(),
  // Ограничиваем количество одновременных векторных полигонов на экране
  MAX_RENDERED: (L.Browser.mobile || (navigator.deviceMemory && navigator.deviceMemory <= 3)) ? 450 : 900,
  
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
  LOD: [
    { z: 16, tz: 15, pages: 1 },
    { z: 15, tz: 14, pages: 1 },
    { z: 14, tz: 13, pages: 1 },
    { z: 13, tz: 12, pages: 1 }
  ],
  MAX_TILES_PER_VIEW: 6,
  CONCURRENCY: 2,
  MAX_TRIES: 3,
  MIN_PX: 6,
  VIEW_PAD: 0.25,
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