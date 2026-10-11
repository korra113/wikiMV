window.WM = window.WM || {};
WM.config = {
  MIN_ZOOM: 10,            // ниже этого масштаба векторные плитки не запрашиваются
  VECTOR_ZOOM: 14,         // порог гибридного режима
  PAGE_SIZE: 100,
  LOD: [
    { z: 14, tz: 13, pages: 1 }
  ],
  MAX_TILES_PER_VIEW: 4,
  CONCURRENCY: 2,
  MAX_TRIES: 3,
  MAX_OBJECTS: 6000,
  MAX_RENDERED: 1500,
  MIN_PX: 6,
  VIEW_PAD: 0.3,
  HIT_TOLERANCE_PX: 10,
  TIMEOUT_MS: 15000,
  DETAIL_CACHE_MAX: 200,

  // Параметры задержки и дрожания для автозагрузки
  HOVER_HOLD_DELAY_MS: 1000, // порог фиксации: 1 секунда
  HOVER_JITTER_PX: 18,       // радиус естественного тремора

  // --- Умная фильтрация объектов по масштабу экрана ---
  PICKER_MIN_PX: 10,         // объекты меньше 10px на экране игнорируются (нужно приблизить карту)
  PICKER_MAX_SCREEN_RATIO: 1.15, // в режиме прицела объект не должен превышать 115% ширины/высоты экрана

  // --- Защита от случайных кликов и Double-tap Zoom ---
  TAP_MAX_DELAY_MS: 260,     // максимальная длительность намеренного тапа
  TAP_MAX_MOVE_PX: 8,        // максимальный сдвиг пальца/курсора при клике (deadzone)
  DOUBLE_TAP_MAX_DELAY_MS: 320, // интервал между тапами для жеста масштабирования
  DOUBLE_TAP_MAX_DIST_PX: 28,   // допустимое расстояние между двумя тапами
  DOUBLE_TAP_ZOOM_SENSITIVITY: 160 // пикселей вертикального движения на 1 уровень зума
};