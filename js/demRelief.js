/**
 * demRelief.js — Клиентская WebGL-отмывка рельефа и генерация горизонталей (Canvas DEM Contours)
 * Источники: AWS Terrarium Elevation Tiles + Fallback Mirror (Nextzen)
 * Формат высот: height = (R * 256 + G + B / 256) - 32768
 */
(function () {
  const WM = window.WM = window.WM || {};

  const DEM_URL_TEMPLATES = [
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    'https://tile.nextzen.org/tilezen/elevation/v1/terrarium/{z}/{x}/{y}.png'
  ];

  const DEFAULT_CONFIG = {
    hillshadeEnabled: true,
    zFactor: 3.5,
    sunMode: 'time',     // 'time' | 'suncalc' | 'manual' | 'swiss'
    manualTimeHour: 15,  // 0..24 ч
    manualDateStr: '',   // YYYY-MM-DD
    sunAzimuth: 315,
    sunAltitude: 45,
    colorTone: 'day',
    smoothMode: 'gauss', // 'none' | 'gauss' | 'bilateral' | 'adaptive' | 'tangent' | 'median'
    hypsoMode: 'none',
    ambientOcclusion: true,
    aoStrength: 1.0,
    hillshadeOpacity: 0.65,
    aoStrength: 1.0,
    aoRadius: 1.0,        // <-- ДОБАВИТЬ
    paperGrain: 0.4,       // <-- ДОБАВИТЬ
    contourPalette: 'sepia', // <-- ДОБАВИТЬ

    contoursEnabled: false,
    contourStep: 20,
    contourColor: '#b45309',
    contourOpacity: 0.85,
    contourWidth: 1.5,
    taperWithElevation: true,
    taperDirection: 'crests',
    taperStrength: 0.60,
    showLabels: true
  };

  let cfg = { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(localStorage.getItem('wm_dem_relief') || '{}');
    cfg = { ...DEFAULT_CONFIG, ...saved };
  } catch (e) {}

  if (localStorage.getItem('wm_dem_hillshade_enabled') !== null) {
    cfg.hillshadeEnabled = localStorage.getItem('wm_dem_hillshade_enabled') === 'true';
  }
  if (localStorage.getItem('wm_dem_contours_enabled') !== null) {
    cfg.contoursEnabled = localStorage.getItem('wm_dem_contours_enabled') === 'true';
  }

  function saveConfig() {
    try {
      localStorage.setItem('wm_dem_relief', JSON.stringify(cfg));
      localStorage.setItem('wm_dem_hillshade_enabled', cfg.hillshadeEnabled ? 'true' : 'false');
      localStorage.setItem('wm_dem_contours_enabled', cfg.contoursEnabled ? 'true' : 'false');
    } catch (e) {}
  }

  function lerpVec3(a, b, t) {
    const s = Math.max(0, Math.min(1, t));
    return [
      a[0] + (b[0] - a[0]) * s,
      a[1] + (b[1] - a[1]) * s,
      a[2] + (b[2] - a[2]) * s
    ];
  }

  function normalizeVec3(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function getEffectiveSunDate() {
    let d = new Date();
    if (cfg.manualDateStr && /^\d{4}-\d{2}-\d{2}$/.test(cfg.manualDateStr)) {
      const parts = cfg.manualDateStr.split('-');
      d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    const h = cfg.manualTimeHour !== undefined ? cfg.manualTimeHour : 15;
    const totalMinutes = Math.floor(h * 60);
    d.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
    return d;
  }

  function getSunLighting(centerLat, centerLng) {
    if (cfg.sunMode === 'swiss') {
      return {
        sunVec: [0.5, -0.5, 0.7],
        lightColor: [1.0, 0.98, 0.94],
        shadowColor: [0.32, 0.35, 0.44],
        isSwiss: true
      };
    }

    if ((cfg.sunMode === 'time' || cfg.sunMode === 'suncalc') && window.SunCalc) {
      const dateForCalc = (cfg.sunMode === 'time') ? getEffectiveSunDate() : new Date();
      const sunPos = SunCalc.getPosition(dateForCalc, centerLat, centerLng);
      const sunAltDeg = sunPos.altitude * 180 / Math.PI;

      const sunAz = sunPos.azimuth + Math.PI;
      const sunAltClamped = Math.max(0.04, sunPos.altitude);
      const cosSunAlt = Math.cos(sunAltClamped);
      const sunV = [
        Math.sin(sunAz) * cosSunAlt,
        -Math.cos(sunAz) * cosSunAlt,
        Math.sin(sunAltClamped)
      ];

      const moonPos = SunCalc.getMoonPosition(dateForCalc, centerLat, centerLng);
      const moonIllum = SunCalc.getMoonIllumination(dateForCalc);
      const moonAz = moonPos.azimuth + Math.PI;
      const moonAltClamped = Math.max(0.08, moonPos.altitude);
      const cosMoonAlt = Math.cos(moonAltClamped);
      const moonV = [
        Math.sin(moonAz) * cosMoonAlt,
        -Math.cos(moonAz) * cosMoonAlt,
        Math.sin(moonAltClamped)
      ];

      const moonPower = 0.35 + 0.65 * (moonIllum.fraction || 0.5);
      const moonLightCol = [0.60 * moonPower, 0.72 * moonPower, 0.95 * moonPower];
      const moonShadowCol = [0.08, 0.11, 0.18];

      let dayLightCol, dayShadowCol;
      if (sunAltDeg > 20) {
        dayLightCol = [1.0, 0.98, 0.94];
        dayShadowCol = [0.30, 0.34, 0.42];
      } else if (sunAltDeg > 6) {
        const t = (sunAltDeg - 6) / 14;
        dayLightCol = lerpVec3([1.0, 0.78, 0.52], [1.0, 0.98, 0.94], t);
        dayShadowCol = lerpVec3([0.34, 0.26, 0.42], [0.30, 0.34, 0.42], t);
      } else {
        const t = Math.max(0, (sunAltDeg - (-2)) / 8);
        dayLightCol = lerpVec3([0.9, 0.45, 0.25], [1.0, 0.78, 0.52], t);
        dayShadowCol = lerpVec3([0.20, 0.16, 0.32], [0.34, 0.26, 0.42], t);
      }

      let finalVec, finalLight, finalShadow;
      if (sunAltDeg > -1.0) {
        finalVec = normalizeVec3(sunV);
        finalLight = dayLightCol;
        finalShadow = dayShadowCol;
      } else if (sunAltDeg < -9.0) {
        finalVec = normalizeVec3(moonV);
        finalLight = moonLightCol;
        finalShadow = moonShadowCol;
      } else {
        const blend = (sunAltDeg - (-9.0)) / 8.0;
        finalVec = normalizeVec3(lerpVec3(moonV, sunV, blend));
        finalLight = lerpVec3(moonLightCol, dayLightCol, blend);
        finalShadow = lerpVec3(moonShadowCol, dayShadowCol, blend);
      }

      return {
        sunVec: finalVec,
        lightColor: finalLight,
        shadowColor: finalShadow,
        isSwiss: false
      };
    } else {
      const azRad = ((cfg.sunAzimuth || 315) * Math.PI) / 180;
      const altRad = Math.max(0.08, ((cfg.sunAltitude || 45) * Math.PI) / 180);

      const tonePresets = {
        neutral: { light: [1.0, 1.0, 1.0], shadow: [0.30, 0.30, 0.30] },
        day: { light: [1.0, 0.98, 0.94], shadow: [0.32, 0.35, 0.42] },
        sunrise: { light: [1.0, 0.82, 0.68], shadow: [0.38, 0.28, 0.45] },
        sunset: { light: [1.0, 0.60, 0.38], shadow: [0.25, 0.22, 0.45] },
        moon: { light: [0.68, 0.82, 1.0], shadow: [0.10, 0.14, 0.24] }
      };
      const p = tonePresets[cfg.colorTone] || tonePresets.day;

      const cosAlt = Math.cos(altRad);
      const v = [
        Math.sin(azRad) * cosAlt,
        -Math.cos(azRad) * cosAlt,
        Math.sin(altRad)
      ];

      return {
        sunVec: normalizeVec3(v),
        lightColor: p.light,
        shadowColor: p.shadow,
        isSwiss: false
      };
    }
  }

  // =========================================================================
  // ШЕЙДЕР С МУЛЬТИРЕЖИМНОЙ ФИЛЬТРАЦИЕЙ ВЫСОТ
  // =========================================================================
  const VS_SOURCE = `
    attribute vec2 a_pos;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main() {
      v_uv = a_uv;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FS_SOURCE = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    uniform sampler2D u_dem;
    uniform vec2 u_res;
    uniform vec3 u_sunDir;
    uniform vec3 u_lightColor;
    uniform vec3 u_shadowColor;
    uniform float u_zFactor;
    uniform int u_mode;
    uniform int u_smooth;      // 0=none, 1=gauss, 2=bilateral, 3=adaptive, 4=tangent, 5=median
    uniform int u_hypso;
    uniform float u_useAO;
    uniform float u_aoStrength;
    uniform float u_metersPerPixel;
    uniform float u_aoRadius;
    uniform float u_paperGrain;
    varying vec2 v_uv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float ridgedNoise(vec2 p) {
      return 1.0 - abs(noise(p) * 2.0 - 1.0);
    }

    float decodeH(vec4 c) {
      if (c.a < 0.1) return -99999.0;
      return (c.r * 255.0 * 256.0 + c.g * 255.0 + c.b * 255.0 / 256.0) - 32768.0;
    }

    float getRawH(vec2 uv, float fallbackH) {
      vec4 c = texture2D(u_dem, clamp(uv, vec2(0.001), vec2(0.999)));
      float h = decodeH(c);
      if (h < -1000.0) return fallbackH;
      return h;
    }

    // 13-точечный взвешенный Гауссов фильтр из проверенной старой версии
    float getGaussianH(vec2 uv, float centerH, float radius) {
      vec2 d = (1.0 / u_res) * radius;
      float h = getRawH(uv, centerH) * 0.20;
      h += (getRawH(uv + vec2( d.x, 0.0), centerH) + getRawH(uv - vec2( d.x, 0.0), centerH)) * 0.12;
      h += (getRawH(uv + vec2(0.0,  d.y), centerH) + getRawH(uv - vec2(0.0,  d.y), centerH)) * 0.12;
      h += (getRawH(uv + vec2( d.x,  d.y), centerH) + getRawH(uv - vec2( d.x,  d.y), centerH)) * 0.08;
      h += (getRawH(uv + vec2(-d.x,  d.y), centerH) + getRawH(uv + vec2( d.x, -d.y), centerH)) * 0.08;
      // Внешнее кольцо
      h += (getRawH(uv + vec2( d.x * 2.0, 0.0), centerH) + getRawH(uv - vec2( d.x * 2.0, 0.0), centerH)) * 0.05;
      h += (getRawH(uv + vec2(0.0,  d.y * 2.0), centerH) + getRawH(uv - vec2(0.0,  d.y * 2.0), centerH)) * 0.05;
      return h;
    }

    // Двусторонний фильтр: сглаживает ступени DEM до 6м, но защищает обрывы
    float getBilateralH(vec2 uv, float centerH, float radius) {
      vec2 d = (1.0 / u_res) * radius;
      float totalWeight = 0.22;
      float sumH = centerH * 0.22;

      vec2 offsets[8];
      offsets[0] = vec2( d.x, 0.0); offsets[1] = vec2(-d.x, 0.0);
      offsets[2] = vec2(0.0,  d.y); offsets[3] = vec2(0.0, -d.y);
      offsets[4] = vec2( d.x,  d.y); offsets[5] = vec2(-d.x, -d.y);
      offsets[6] = vec2(-d.x,  d.y); offsets[7] = vec2( d.x, -d.y);

      for (int i = 0; i < 8; i++) {
        float sampleH = getRawH(uv + offsets[i], centerH);
        float diff = abs(sampleH - centerH);
        // Вес Гаусса в пространстве (0.12 для креста, 0.075 для диагоналей)
        float spatialW = (i < 4) ? 0.12 : 0.075;
        // Вес по разнице высот: не смешиваем перепады больше 14 метров
        float rangeW = exp(- (diff * diff) / 80.0);
        float w = spatialW * rangeW;
        sumH += sampleH * w;
        totalWeight += w;
      }
      return sumH / totalWeight;
    }

    // Медианный 9-точечный фильтр
    float getMedianH(vec2 uv, float centerH, float radius) {
      vec2 d = (1.0 / u_res) * radius;
      float hC = getRawH(uv, centerH);
      float hL = getRawH(uv - vec2(d.x, 0.0), centerH);
      float hR = getRawH(uv + vec2(d.x, 0.0), centerH);
      float hB = getRawH(uv - vec2(0.0, d.y), centerH);
      float hT = getRawH(uv + vec2(0.0, d.y), centerH);
      
      float minH = min(min(hL, hR), min(hB, hT));
      float maxH = max(max(hL, hR), max(hB, hT));
      float clampedC = clamp(hC, minH, maxH);
      return mix(hC, (clampedC + (hL + hR + hB + hT) * 0.25) * 0.5, 0.85);
    }

    // Универсальный селектор высоты с учётом выбранного режима
    float getSampleH(vec2 uv, float centerH, float radius, float localSlope) {
      if (u_smooth == 0) {
        // NONE: Сырые пиксели
        return getRawH(uv, centerH);
      } else if (u_smooth == 2) {
        // BILATERAL
        return getBilateralH(uv, centerH, radius);
      } else if (u_smooth == 3) {
        // ADAPTIVE: Чем более пологая равнина, тем шире радиус размытия ступеней
        float adaptRadius = mix(radius * 2.2, radius * 0.8, clamp(localSlope * 18.0, 0.0, 1.0));
        return getGaussianH(uv, centerH, adaptRadius);
      } else if (u_smooth == 5) {
        // MEDIAN
        return getMedianH(uv, centerH, radius);
      }
      // 1 (GAUSS) и fallback: старый Гаусс
      return getGaussianH(uv, centerH, radius);
    }

    vec3 getVintageHypso(float h) {
      float normH = clamp((h + 50.0) / 2500.0, 0.0, 1.0);
      vec3 cLow   = vec3(0.86, 0.88, 0.80);
      vec3 cMid   = vec3(0.92, 0.86, 0.73);
      vec3 cHigh  = vec3(0.78, 0.65, 0.52);
      vec3 cCrest = vec3(0.95, 0.93, 0.90);

      if (normH < 0.35) return mix(cLow, cMid, normH / 0.35);
      if (normH < 0.75) return mix(cMid, cHigh, (normH - 0.35) / 0.40);
      return mix(cHigh, cCrest, (normH - 0.75) / 0.25);
    }

    void main() {
      vec4 centerRaw = texture2D(u_dem, v_uv);
      float centerH = decodeH(centerRaw);

      if (centerRaw.a < 0.1 || centerH < -1000.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      // Базовый радиус апертуры для сглаживания 1м дискретизации
      float adaptiveBlurRadius = (u_zFactor > 4.0) ? 3.2 : 2.0;
      vec2 stepUv = (1.0 / u_res) * adaptiveBlurRadius;

      // Быстрая предварительная оценка уклона для адаптивного и тангенциального режимов
      vec2 quickStep = (1.0 / u_res) * 2.5;
      float qL = getRawH(v_uv - vec2(quickStep.x, 0.0), centerH);
      float qR = getRawH(v_uv + vec2(quickStep.x, 0.0), centerH);
      float qB = getRawH(v_uv - vec2(0.0, quickStep.y), centerH);
      float qT = getRawH(v_uv + vec2(0.0, quickStep.y), centerH);
      vec2 roughGrad = vec2((qR - qL), (qT - qB));
      float roughSlope = length(roughGrad) / (5.0 * u_metersPerPixel);

      // Вычисляем производные Собеля на основе предварительно сглаженного поля DEM
      float subRadius = (u_smooth == 0) ? 0.0 : 1.25;

      float z00 = getSampleH(v_uv + vec2(-stepUv.x, -stepUv.y), centerH, subRadius, roughSlope);
      float z10 = getSampleH(v_uv + vec2(0.0,       -stepUv.y), centerH, subRadius, roughSlope);
      float z20 = getSampleH(v_uv + vec2( stepUv.x, -stepUv.y), centerH, subRadius, roughSlope);
      float z01 = getSampleH(v_uv + vec2(-stepUv.x, 0.0),       centerH, subRadius, roughSlope);
      float z21 = getSampleH(v_uv + vec2( stepUv.x, 0.0),       centerH, subRadius, roughSlope);
      float z02 = getSampleH(v_uv + vec2(-stepUv.x,  stepUv.y), centerH, subRadius, roughSlope);
      float z12 = getSampleH(v_uv + vec2(0.0,        stepUv.y), centerH, subRadius, roughSlope);
      float z22 = getSampleH(v_uv + vec2( stepUv.x,  stepUv.y), centerH, subRadius, roughSlope);

      // TANGENT: дополнительная анизотропная подтяжка вдоль изолиний
      if (u_smooth == 4 && roughSlope > 0.005) {
        vec2 tangentDir = normalize(vec2(-roughGrad.y, roughGrad.x)) * stepUv * 1.5;
        float zT1 = getGaussianH(v_uv + tangentDir, centerH, 1.2);
        float zT2 = getGaussianH(v_uv - tangentDir, centerH, 1.2);
        float smoothVal = (zT1 + zT2) * 0.5;
        z01 = mix(z01, smoothVal, 0.35);
        z21 = mix(z21, smoothVal, 0.35);
      }

      float deltaMeters = 8.0 * u_metersPerPixel * adaptiveBlurRadius;
      float dzdx = ((z20 + 2.0 * z21 + z22) - (z00 + 2.0 * z01 + z02)) / deltaMeters * u_zFactor;
      float dzdy = ((z02 + 2.0 * z12 + z22) - (z00 + 2.0 * z10 + z20)) / deltaMeters * u_zFactor;

      float slope = length(vec2(dzdx, dzdy));

      // Подавление шума дискретизации на почти плоских равнинах
      float slopeThreshold = 0.008;
      float antiStepFactor = smoothstep(0.0, slopeThreshold, slope);
      dzdx *= antiStepFactor;
      dzdy *= antiStepFactor;

      // === ДЕНДРИТНАЯ ВОДНАЯ ЭРОЗИЯ (Тальвеги и овраги) ===
      if (u_metersPerPixel < 65.0 && slope > 0.004) {
        vec2 flow = normalize(vec2(dzdx, dzdy) + vec2(0.0001));
        vec2 pCoord = v_uv * u_res * 0.15;
        vec2 warped = pCoord + flow * 2.2;
        float river1 = ridgedNoise(warped * 2.0);
        float river2 = ridgedNoise(warped * 4.5 + vec2(1.7, 9.2)) * 0.5;

        float erosionMultiplier = (u_smooth == 3) ? 1.30 : 1.0;
        float gullyIndent = pow(river1 + river2, 2.8) * clamp(slope * 0.5, 0.0, 0.45) * erosionMultiplier;

        dzdx += flow.x * gullyIndent * 0.35;
        dzdy += flow.y * gullyIndent * 0.35;
      }

      vec3 norm = normalize(vec3(-dzdx, -dzdy, 1.0));

      // === ШВЕЙЦАРСКОЕ ОСВЕЩЕНИЕ (SWISS MDOW) ===
      float NdotL = max(0.0, dot(norm, u_sunDir));
      vec3 skyLightDir = normalize(vec3(-u_sunDir.x * 0.8, -u_sunDir.y * 0.8, 0.6));
      float skyFill = max(0.0, dot(norm, skyLightDir)) * 0.30;

      // Блеск гребней
      float curvature = ((z10 + z01 + z21 + z12) * 0.25) - centerH;
      float crestGlint = clamp(-curvature * 0.15 * u_zFactor, 0.0, 0.35);

      float diffuse = clamp(0.20 + 0.75 * NdotL + skyFill + crestGlint, 0.0, 1.0);

      vec3 warmSunCol = u_lightColor * vec3(1.02, 0.98, 0.91);
      vec3 coolShaCol = u_shadowColor * vec3(0.85, 0.92, 1.05);
      vec3 terrainCol = mix(coolShaCol, warmSunCol, diffuse);

      // === АТМОСФЕРНАЯ ДЫМКА ИМХОФА ===
      float altitudeHaze = clamp((centerH - 50.0) / 1200.0, 0.0, 1.0);
      terrainCol = mix(mix(terrainCol, vec3(0.90, 0.89, 0.85), 0.22), terrainCol, altitudeHaze);

      // === ГРАВЮРНАЯ ШТРИХОВКА СКЛОНОВ (Hachuring) ===
      if (slope > 0.45 && u_metersPerPixel < 25.0) {
        vec2 hatchCoord = v_uv * u_res * 1.8;
        float hatchPattern = sin(dot(hatchCoord, vec2(-dzdy, dzdx)) * 12.0);
        float hatchMask = smoothstep(0.45, 0.85, slope);
        float inkHatch = smoothstep(0.2, 0.8, hatchPattern) * hatchMask * 0.18;
        terrainCol -= vec3(inkHatch);
      }

      // === АО (Окклюзия долин) ===
      if (u_useAO > 0.5) {
        float wideR = adaptiveBlurRadius * (3.8 * u_aoRadius);
        vec2 dW = (1.0 / u_res) * wideR;
        float avgH = (getRawH(v_uv + vec2(-dW.x,  0.0), centerH) +
                      getRawH(v_uv + vec2( dW.x,  0.0), centerH) +
                      getRawH(v_uv + vec2( 0.0, -dW.y), centerH) +
                      getRawH(v_uv + vec2( 0.0,  dW.y), centerH)) * 0.25;
        float valley = clamp((avgH - centerH) / max(1.5, u_metersPerPixel * 0.2), 0.0, 3.0);
        terrainCol *= clamp(1.0 - valley * 0.18 * u_aoStrength, 0.55, 1.0);
      }

      if (u_hypso > 0) {
        vec3 hypsoCol = getVintageHypso(centerH);
        terrainCol = mix(terrainCol, terrainCol * hypsoCol, 0.70);
      }

      // Текстура бумаги
      float paperGrain = (hash(v_uv * u_res * 2.5) - 0.5) * (u_paperGrain * 0.1);
      terrainCol += vec3(paperGrain);

      gl_FragColor = vec4(clamp(terrainCol, 0.0, 1.0), 1.0);
    }
  `;

  let sharedGl = null;
  let sharedTex = null;
  let sharedProgram = null;
  let glLocations = null;

  function initSharedGl() {
    if (sharedGl) return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) return;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('DEM WebGL Shader Error:', gl.getShaderInfoLog(s));
      }
      return s;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS_SOURCE));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS_SOURCE));
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('DEM WebGL Link Error:', gl.getProgramInfoLog(prog));
      return;
    }

    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
      -1,  1, 0, 0,
       1, -1, 1, 1,
       1,  1, 1, 0
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    const aUv = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    sharedGl = gl;
    sharedProgram = prog;
    glLocations = {
      dem: gl.getUniformLocation(prog, 'u_dem'),
      res: gl.getUniformLocation(prog, 'u_res'),
      sunDir: gl.getUniformLocation(prog, 'u_sunDir'),
      lightColor: gl.getUniformLocation(prog, 'u_lightColor'),
      shadowColor: gl.getUniformLocation(prog, 'u_shadowColor'),
      zFactor: gl.getUniformLocation(prog, 'u_zFactor'),
      mode: gl.getUniformLocation(prog, 'u_mode'),
      smooth: gl.getUniformLocation(prog, 'u_smooth'),
      hypso: gl.getUniformLocation(prog, 'u_hypso'),
      useAO: gl.getUniformLocation(prog, 'u_useAO'),
      aoStrength: gl.getUniformLocation(prog, 'u_aoStrength'),
      aoRadius: gl.getUniformLocation(prog, 'u_aoRadius'),       // <-- ДОБАВИТЬ
      paperGrain: gl.getUniformLocation(prog, 'u_paperGrain'),   // <-- ДОБАВИТЬ
      mpp: gl.getUniformLocation(prog, 'u_metersPerPixel')
    };
  }

  function renderTileHillshade(img, lat, zoom, lighting) {
    initSharedGl();
    if (!sharedGl) return null;
    const gl = sharedGl;

    if (!sharedTex) {
      sharedTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sharedTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, sharedTex);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    gl.uniform2f(glLocations.res, 256, 256);
    gl.uniform1f(glLocations.zFactor, cfg.zFactor);
    gl.uniform1i(glLocations.mode, lighting.isSwiss ? 1 : 0);
    gl.uniform1f(glLocations.aoRadius, cfg.aoRadius !== undefined ? cfg.aoRadius : 1.0);
    gl.uniform1f(glLocations.paperGrain, cfg.paperGrain !== undefined ? cfg.paperGrain : 0.4);

    const smoothModesMap = {
      none: 0,
      gauss: 1,
      bilateral: 2,
      adaptive: 3,
      tangent: 4,
      median: 5
    };
    const smoothVal = smoothModesMap[cfg.smoothMode] !== undefined ? smoothModesMap[cfg.smoothMode] : 1;
    gl.uniform1i(glLocations.smooth, smoothVal);

    const hypsoVal = { none: 0, atlas: 1, warm: 2, cool: 3 }[cfg.hypsoMode] || 0;
    gl.uniform1i(glLocations.hypso, hypsoVal);

    gl.uniform1f(glLocations.useAO, cfg.ambientOcclusion ? 1.0 : 0.0);
    gl.uniform1f(glLocations.aoStrength, cfg.aoStrength || 1.0);

    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    gl.uniform1f(glLocations.mpp, mpp);

    gl.uniform3f(glLocations.sunDir, lighting.sunVec[0], lighting.sunVec[1], lighting.sunVec[2]);
    gl.uniform3f(glLocations.lightColor, lighting.lightColor[0], lighting.lightColor[1], lighting.lightColor[2]);
    gl.uniform3f(glLocations.shadowColor, lighting.shadowColor[0], lighting.shadowColor[1], lighting.shadowColor[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = 256;
    outCanvas.height = 256;
    const ctx = outCanvas.getContext('2d');
    ctx.drawImage(gl.canvas, 0, 0);
    return outCanvas;
  }

  // =========================================================================
  // БЕСШОВНЫЕ ИЗОЛИНИИ С АДАПТИВНЫМ ШАГОМ
  // =========================================================================
  function renderTileContours(img) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const strokeColor = (cfg.contourPalette === 'sepia') ? '#78350f' : (cfg.contourColor || '#b45309');
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;

    const imgData = ctx.getImageData(0, 0, 256, 256);
    const data = imgData.data;
    ctx.clearRect(0, 0, 256, 256);

    const COLS = 64;
    const ROWS = 64;
    const cellW = 256.0 / COLS;
    const cellH = 256.0 / ROWS;

    const heights = new Float32Array((COLS + 1) * (ROWS + 1));
    let validPixels = 0;
    let minH = Infinity, maxH = -Infinity;

    for (let r = 0; r <= ROWS; r++) {
      const py = Math.min(255, Math.round(r * (255.0 / ROWS)));
      for (let c = 0; c <= COLS; c++) {
        const px = Math.min(255, Math.round(c * (255.0 / COLS)));
        const idx = (py * 256 + px) * 4;

        if (data[idx + 3] < 30) {
          heights[r * (COLS + 1) + c] = -99999;
          continue;
        }

        const h = (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
        if (h < -1000) {
          heights[r * (COLS + 1) + c] = -99999;
          continue;
        }

        heights[r * (COLS + 1) + c] = h;
        validPixels++;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    if (validPixels < 16 || minH === Infinity || (maxH - minH) < 0.5) {
      return canvas;
    }

    let step = Math.max(2, cfg.contourStep || 20);
    const totalSpan = maxH - minH;
    while ((totalSpan / step) > 120) {
      step *= 2;
    }

    const firstContour = Math.ceil(minH / step) * step;
    if (firstContour > maxH) return canvas;

    ctx.strokeStyle = cfg.contourColor || '#b45309';
    ctx.fillStyle = cfg.contourColor || '#b45309';
    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const labeledIso = new Set();
    const baseW = Math.min(5.0, Math.max(0.5, cfg.contourWidth || 1.5));
    const heightRange = Math.max(25.0, maxH - minH);
    const taperStrength = cfg.taperStrength !== undefined ? cfg.taperStrength : 0.60;
    const taperDir = cfg.taperDirection || 'crests';

    for (let iso = firstContour; iso <= maxH; iso += step) {
      const isMajor = (Math.round(iso) % (step * 5) === 0);

      let currentWidth = isMajor ? (baseW * 1.55) : baseW;
      if (cfg.taperWithElevation && taperStrength > 0.01) {
        const progress = Math.max(0, Math.min(1, (iso - minH) / heightRange));
        let factor = (taperDir === 'crests')
          ? Math.max(0.20, 1.0 - progress * taperStrength)
          : Math.max(0.20, (1.0 - taperStrength) + progress * taperStrength);
        currentWidth = Math.max(0.35, currentWidth * factor);
      }

      ctx.lineWidth = currentWidth;
      ctx.beginPath();
      let labelPlaced = false;

      for (let r = 0; r < ROWS; r++) {
        const y0 = r * cellH;
        const y1 = (r + 1) * cellH;

        for (let c = 0; c < COLS; c++) {
          const x0 = c * cellW;
          const x1 = (c + 1) * cellW;

          const tl = heights[r * (COLS + 1) + c];
          const tr = heights[r * (COLS + 1) + (c + 1)];
          const bl = heights[(r + 1) * (COLS + 1) + c];
          const br = heights[(r + 1) * (COLS + 1) + (c + 1)];

          if (tl < -1000 || tr < -1000 || bl < -1000 || br < -1000) continue;

          let mask = 0;
          if (tl >= iso) mask |= 8;
          if (tr >= iso) mask |= 4;
          if (br >= iso) mask |= 2;
          if (bl >= iso) mask |= 1;

          if (mask === 0 || mask === 15) continue;

          const topX = x0 + ((iso - tl) / (tr - tl || 1)) * cellW;
          const botX = x0 + ((iso - bl) / (br - bl || 1)) * cellW;
          const leftY = y0 + ((iso - tl) / (bl - tl || 1)) * cellH;
          const rightY = y0 + ((iso - tr) / (br - tr || 1)) * cellH;

          switch (mask) {
            case 1: case 14: ctx.moveTo(x0, leftY); ctx.lineTo(botX, y1); break;
            case 2: case 13: ctx.moveTo(botX, y1); ctx.lineTo(x1, rightY); break;
            case 3: case 12: ctx.moveTo(x0, leftY); ctx.lineTo(x1, rightY); break;
            case 4: case 11: ctx.moveTo(topX, y0); ctx.lineTo(x1, rightY); break;
            case 5:
              ctx.moveTo(x0, leftY); ctx.lineTo(topX, y0);
              ctx.moveTo(botX, y1); ctx.lineTo(x1, rightY); break;
            case 6: case 9: ctx.moveTo(topX, y0); ctx.lineTo(botX, y1); break;
            case 7: case 8: ctx.moveTo(x0, leftY); ctx.lineTo(topX, y0); break;
            case 10:
              ctx.moveTo(topX, y0); ctx.lineTo(x1, rightY);
              ctx.moveTo(x0, leftY); ctx.lineTo(botX, y1); break;
          }

          if (cfg.showLabels && isMajor && !labelPlaced && !labeledIso.has(iso) && c > 12 && c < 50 && r > 12 && r < 50) {
            ctx.stroke();
            ctx.beginPath();
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.fillRect(x0 - 2, y0 - 5, 26, 11);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(Math.round(iso).toString(), x0 + 11, y0);
            ctx.restore();
            labelPlaced = true;
            labeledIso.add(iso);
          }
        }
      }
      ctx.stroke();
    }

    return canvas;
  }

  function loadDemTileImage(coords, attempt = 0) {
    return new Promise((resolve, reject) => {
      const templateIdx = attempt % DEM_URL_TEMPLATES.length;
      const url = L.Util.template(DEM_URL_TEMPLATES[templateIdx], coords);

      const img = new Image();
      img.crossOrigin = 'anonymous';

      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        img.onload = null;
        img.onerror = null;
        img.src = '';
        if (attempt < 2) {
          setTimeout(() => {
            loadDemTileImage(coords, attempt + 1).then(resolve).catch(reject);
          }, 350 * (attempt + 1));
        } else {
          reject(new Error('DEM Tile Timeout'));
        }
      }, 7000);

      img.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(img);
      };

      img.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (attempt < 2) {
          setTimeout(() => {
            loadDemTileImage(coords, attempt + 1).then(resolve).catch(reject);
          }, 350 * (attempt + 1));
        } else {
          reject(new Error('DEM Tile Network Error'));
        }
      };

      img.src = url;
    });
  }

  const WebGLHillshadeLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;

      const nwPoint = coords.scaleBy(this.getTileSize());
      const centerLatLng = this._map.unproject(nwPoint.add([128, 128]), coords.z);
      tile._demCoords = coords;
      tile._demLat = centerLatLng.lat;
      tile._demLng = centerLatLng.lng;

      loadDemTileImage(coords)
        .then(img => {
          tile._demImg = img;
          const lighting = getSunLighting(centerLatLng.lat, centerLatLng.lng);
          const rendered = renderTileHillshade(img, centerLatLng.lat, coords.z, lighting);
          if (rendered) {
            const ctx = tile.getContext('2d');
            ctx.drawImage(rendered, 0, 0);
          }
          done(null, tile);
        })
        .catch(err => {
          done(err, tile);
        });

      return tile;
    }
  });

  const DEMContoursLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;

      if (coords.z < 10) {
        setTimeout(() => done(null, tile), 0);
        return tile;
      }

      loadDemTileImage(coords)
        .then(img => {
          tile._demImg = img;
          const rendered = renderTileContours(img);
          if (rendered) {
            const ctx = tile.getContext('2d');
            ctx.drawImage(rendered, 0, 0);
          }
          done(null, tile);
        })
        .catch(err => {
          done(err, tile);
        });

      return tile;
    }
  });

  let hillshadeLayerInstance = null;
  let contoursLayerInstance = null;
  let contoursRedrawTimer = null;
  let liveHillshadeRaf = 0;

  function updateLiveHillshade() {
    if (!hillshadeLayerInstance || !WM.map || !cfg.hillshadeEnabled) return;
    const tiles = hillshadeLayerInstance._tiles;
    if (!tiles) return;

    for (const key in tiles) {
      const tileData = tiles[key];
      const canvas = tileData.el;
      if (canvas && canvas._demImg && canvas._demImg.complete) {
        const lighting = getSunLighting(canvas._demLat || 55.75, canvas._demLng || 37.62);
        const rendered = renderTileHillshade(canvas._demImg, canvas._demLat || 55.75, canvas._demCoords.z, lighting);
        if (rendered) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, 256, 256);
          ctx.drawImage(rendered, 0, 0);
        }
      }
    }
  }

  function scheduleLiveHillshade() {
    if (liveHillshadeRaf) return;
    liveHillshadeRaf = requestAnimationFrame(() => {
      liveHillshadeRaf = 0;
      updateLiveHillshade();
    });
  }

  function applyLayerVisibility() {
    if (!WM.map) return;
    const map = WM.map;

    if (hillshadeLayerInstance) {
      if (cfg.hillshadeEnabled) {
        if (!map.hasLayer(hillshadeLayerInstance)) map.addLayer(hillshadeLayerInstance);
      } else {
        if (map.hasLayer(hillshadeLayerInstance)) map.removeLayer(hillshadeLayerInstance);
      }
    }

    if (contoursLayerInstance) {
      if (cfg.contoursEnabled) {
        if (!map.hasLayer(contoursLayerInstance)) map.addLayer(contoursLayerInstance);
      } else {
        if (map.hasLayer(contoursLayerInstance)) map.removeLayer(contoursLayerInstance);
      }
    }
  }

  // =========================================================================
  // ПЛАВАЮЩИЙ HUD ДЛЯ НАСТРОЙКИ С КАРТЫ
  // =========================================================================
  let isHudOpen = false;
  let activeTab = 'light';

  function formatHourString(hourVal) {
    const totalMinutes = Math.round(hourVal * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function renderHudUI() {
    const hud = document.getElementById('dem-relief-hud');
    if (!hud) return;

    const btnHs = document.getElementById('dem-hud-toggle-hs');
    const btnCt = document.getElementById('dem-hud-toggle-ct');
    if (btnHs) btnHs.classList.toggle('active', !!cfg.hillshadeEnabled);
    if (btnCt) btnCt.classList.toggle('active', !!cfg.contoursEnabled);

    hud.querySelectorAll('.dem-hud-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });

    const bodyLight = document.getElementById('dem-hud-body-light');
    const bodyTerrain = document.getElementById('dem-hud-body-terrain');
    const bodyContours = document.getElementById('dem-hud-body-contours');
    if (bodyLight) bodyLight.hidden = (activeTab !== 'light');
    if (bodyTerrain) bodyTerrain.hidden = (activeTab !== 'terrain');
    if (bodyContours) bodyContours.hidden = (activeTab !== 'contours');

    const sliderTime = document.getElementById('dem-hud-time-slider');
    const valTime = document.getElementById('dem-hud-time-val');
    if (sliderTime && valTime) {
      const curH = cfg.manualTimeHour !== undefined ? cfg.manualTimeHour : 15;
      sliderTime.value = curH;
      valTime.textContent = formatHourString(curH);
    }

    const inputDate = document.getElementById('dem-hud-date-input');
    if (inputDate) {
      if (!cfg.manualDateStr) {
        const today = new Date();
        const pad = n => String(n).padStart(2, '0');
        inputDate.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      } else {
        inputDate.value = cfg.manualDateStr;
      }
    }

    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.classList.toggle('active', ch.dataset.tone === cfg.colorTone && cfg.sunMode === 'manual');
    });

    const sliderAz = document.getElementById('dem-hud-azimuth-slider');
    const valAz = document.getElementById('dem-hud-azimuth-val');
    if (sliderAz && valAz) {
      sliderAz.value = cfg.sunAzimuth || 315;
      valAz.textContent = (cfg.sunAzimuth || 315) + '°';
    }

    const sliderAlt = document.getElementById('dem-hud-altitude-slider');
    const valAlt = document.getElementById('dem-hud-altitude-val');
    if (sliderAlt && valAlt) {
      sliderAlt.value = cfg.sunAltitude || 45;
      valAlt.textContent = (cfg.sunAltitude || 45) + '°';
    }

    const selSunMode = document.getElementById('dem-hud-sunmode-select');
    if (selSunMode) selSunMode.value = cfg.sunMode || 'time';

    const wrapManualAng = document.getElementById('dem-hud-manual-angles-wrap');
    if (wrapManualAng) wrapManualAng.hidden = (cfg.sunMode !== 'manual');

    const wrapTimeRow = document.getElementById('dem-hud-time-row');
    if (wrapTimeRow) wrapTimeRow.hidden = (cfg.sunMode === 'swiss');

    const sliderHsOp = document.getElementById('dem-hud-hs-opacity');
    const valHsOp = document.getElementById('dem-hud-hs-opacity-val');
    if (sliderHsOp && valHsOp) {
      sliderHsOp.value = Math.round(cfg.hillshadeOpacity * 100);
      valHsOp.textContent = sliderHsOp.value + '%';
    }

    const sliderZ = document.getElementById('dem-hud-zfactor-slider');
    const valZ = document.getElementById('dem-hud-zfactor-val');
    if (sliderZ && valZ) {
      sliderZ.value = cfg.zFactor;
      valZ.textContent = '×' + parseFloat(cfg.zFactor).toFixed(1);
    }

    hud.querySelectorAll('.dem-smooth-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.smooth === (cfg.smoothMode || 'gauss'));
    });

    const selHypso = document.getElementById('dem-hud-hypso-select');
    if (selHypso) selHypso.value = cfg.hypsoMode || 'none';

    const chkAO = document.getElementById('dem-hud-toggle-ao');
    if (chkAO) chkAO.checked = !!cfg.ambientOcclusion;

    const sliderAoStr = document.getElementById('dem-hud-ao-strength-slider');
    const valAoStr = document.getElementById('dem-hud-ao-strength-val');
    if (sliderAoStr && valAoStr) {
      sliderAoStr.value = Math.round((cfg.aoStrength || 1.0) * 100);
      valAoStr.textContent = Math.round((cfg.aoStrength || 1.0) * 100) + '%';
    }

    const selStep = document.getElementById('dem-hud-step-select');
    if (selStep) selStep.value = cfg.contourStep || 20;

    const colCont = document.getElementById('dem-hud-contour-color');
    const valCont = document.getElementById('dem-hud-contour-color-val');
    if (colCont && valCont) {
      colCont.value = cfg.contourColor || '#b45309';
      valCont.textContent = colCont.value;
    }

    const sliderWidth = document.getElementById('dem-hud-width-slider');
    const valWidth = document.getElementById('dem-hud-width-val');
    if (sliderWidth && valWidth) {
      sliderWidth.value = cfg.contourWidth || 1.5;
      valWidth.textContent = parseFloat(cfg.contourWidth || 1.5).toFixed(1) + ' px';
    }

    const sliderTaperStr = document.getElementById('dem-hud-taper-strength-slider');
    const valTaperStr = document.getElementById('dem-hud-taper-strength-val');
    if (sliderTaperStr && valTaperStr) {
      const strPct = Math.round((cfg.taperStrength !== undefined ? cfg.taperStrength : 0.60) * 100);
      sliderTaperStr.value = strPct;
      valTaperStr.textContent = strPct + '%';
    }

    const chkTaper = document.getElementById('dem-hud-toggle-taper');
    if (chkTaper) chkTaper.checked = !!cfg.taperWithElevation;

    const selTaperDir = document.getElementById('dem-hud-taper-dir-select');
    if (selTaperDir) selTaperDir.value = cfg.taperDirection || 'crests';

    const wrapTaperStr = document.getElementById('dem-hud-taper-strength-wrap');
    if (wrapTaperStr) wrapTaperStr.hidden = !cfg.taperWithElevation;

    const sliderCtOp = document.getElementById('dem-hud-ct-opacity');
    const valCtOp = document.getElementById('dem-hud-ct-opacity-val');
    if (sliderCtOp && valCtOp) {
      sliderCtOp.value = Math.round(cfg.contourOpacity * 100);
      valCtOp.textContent = sliderCtOp.value + '%';
    }

    const chkLabels = document.getElementById('dem-hud-toggle-labels');
    if (chkLabels) chkLabels.checked = cfg.showLabels !== false;
  }

  function initHudEvents() {
    const hud = document.getElementById('dem-relief-hud');
    if (!hud || hud._inited) return;
    hud._inited = true;

    document.getElementById('btn-dem-hud-close')?.addEventListener('click', () => {
      WM.demRelief.closeHud();
    });

    const minBtn = document.getElementById('btn-dem-hud-minimize');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        hud.classList.toggle('collapsed');
        minBtn.textContent = hud.classList.contains('collapsed') ? '▲' : '▼';
      });
    }

    document.getElementById('dem-hud-toggle-hs')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ hillshadeEnabled: !cfg.hillshadeEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.hillshadeEnabled ? '⛰️ 3D Отмывка включена' : '⛰️ 3D Отмывка скрыта');
      }
    });

    document.getElementById('dem-hud-toggle-ct')?.addEventListener('click', () => {
      WM.demRelief.setConfig({ contoursEnabled: !cfg.contoursEnabled });
      applyLayerVisibility();
      renderHudUI();
      if (WM.ui && WM.ui.showToast) {
        WM.ui.showToast(cfg.contoursEnabled ? '〰️ Горизонтали включены' : '〰️ Горизонтали скрыты');
      }
    });

    const sliderAoRad = document.getElementById('dem-hud-ao-radius-slider');
    if (sliderAoRad) {
      sliderAoRad.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const lbl = document.getElementById('dem-hud-ao-radius-val');
        if (lbl) lbl.textContent = val + '%';
        cfg.aoRadius = val / 100;
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    // Зернистость пергамента
    const sliderGrain = document.getElementById('dem-hud-paper-grain-slider');
    if (sliderGrain) {
      sliderGrain.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const lbl = document.getElementById('dem-hud-paper-grain-val');
        if (lbl) lbl.textContent = val + '%';
        cfg.paperGrain = val / 100;
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    // Выбор палитры и собственного цвета
    const selPalette = document.getElementById('dem-hud-contour-palette');
    const customColorWrap = document.getElementById('dem-hud-custom-color-wrap');
    if (selPalette) {
      selPalette.addEventListener('change', (e) => {
        const val = e.target.value;
        if (customColorWrap) customColorWrap.hidden = (val !== 'custom');
        WM.demRelief.setConfig({ contourPalette: val });
      });
    }

    const inputCustomColor = document.getElementById('dem-hud-contour-color');
    if (inputCustomColor) {
      inputCustomColor.addEventListener('input', (e) => {
        WM.demRelief.setConfig({ contourColor: e.target.value });
      });
    }



    hud.querySelectorAll('.dem-hud-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderHudUI();
      });
    });

    const sliderTime = document.getElementById('dem-hud-time-slider');
    if (sliderTime) {
      sliderTime.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('dem-hud-time-val').textContent = formatHourString(val);
        cfg.manualTimeHour = val;
        cfg.sunMode = 'time';
        document.getElementById('dem-hud-sunmode-select').value = 'time';
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    const inputDate = document.getElementById('dem-hud-date-input');
    if (inputDate) {
      inputDate.addEventListener('change', (e) => {
        cfg.manualDateStr = e.target.value;
        cfg.sunMode = 'time';
        document.getElementById('dem-hud-sunmode-select').value = 'time';
        saveConfig();
        scheduleLiveHillshade();
        if (WM.ui && WM.ui.showToast) {
          WM.ui.showToast(`📅 Дата освещения: ${cfg.manualDateStr}`);
        }
      });
    }

    hud.querySelectorAll('.dem-season-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const season = btn.dataset.season;
        const curYear = new Date().getFullYear();
        let targetDate = '';
        if (season === 'summer') targetDate = `${curYear}-06-22`;
        else if (season === 'winter') targetDate = `${curYear}-12-22`;
        else if (season === 'equinox') targetDate = `${curYear}-03-21`;
        else {
          const t = new Date();
          const pad = n => String(n).padStart(2, '0');
          targetDate = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
        }
        cfg.manualDateStr = targetDate;
        if (inputDate) inputDate.value = targetDate;
        cfg.sunMode = 'time';
        saveConfig();
        scheduleLiveHillshade();
      });
    });

    hud.querySelectorAll('.dem-tone-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        const tone = ch.dataset.tone;
        const timePresets = { day: 14.0, sunrise: 6.5, sunset: 19.5, moon: 23.5 };
        const targetH = timePresets[tone] !== undefined ? timePresets[tone] : 14.0;
        WM.demRelief.setConfig({ manualTimeHour: targetH, sunMode: 'time', colorTone: tone });
        renderHudUI();
      });
    });

    const sliderAz = document.getElementById('dem-hud-azimuth-slider');
    if (sliderAz) {
      sliderAz.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById('dem-hud-azimuth-val').textContent = val + '°';
        cfg.sunAzimuth = val;
        cfg.sunMode = 'manual';
        document.getElementById('dem-hud-sunmode-select').value = 'manual';
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    const sliderAlt = document.getElementById('dem-hud-altitude-slider');
    if (sliderAlt) {
      sliderAlt.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById('dem-hud-altitude-val').textContent = val + '°';
        cfg.sunAltitude = val;
        cfg.sunMode = 'manual';
        document.getElementById('dem-hud-sunmode-select').value = 'manual';
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    document.getElementById('dem-hud-sunmode-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ sunMode: e.target.value });
      renderHudUI();
    });

    document.getElementById('dem-hud-hs-opacity')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-hs-opacity-val').textContent = val + '%';
      WM.demRelief.setConfig({ hillshadeOpacity: val / 100 });
    });

    document.getElementById('dem-hud-zfactor-slider')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('dem-hud-zfactor-val').textContent = '×' + val.toFixed(1);
      cfg.zFactor = val;
      saveConfig();
      scheduleLiveHillshade();
    });

    hud.querySelectorAll('.dem-smooth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        WM.demRelief.setConfig({ smoothMode: btn.dataset.smooth });
        renderHudUI();
        scheduleLiveHillshade();
      });
    });

    document.getElementById('dem-hud-hypso-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ hypsoMode: e.target.value });
    });

    document.getElementById('dem-hud-toggle-ao')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ ambientOcclusion: e.target.checked });
      scheduleLiveHillshade();
    });

    const sliderAoStr = document.getElementById('dem-hud-ao-strength-slider');
    if (sliderAoStr) {
      sliderAoStr.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById('dem-hud-ao-strength-val').textContent = val + '%';
        cfg.aoStrength = val / 100;
        saveConfig();
        scheduleLiveHillshade();
      });
    }

    document.getElementById('dem-hud-step-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ contourStep: parseInt(e.target.value, 10) });
    });

    const colCont = document.getElementById('dem-hud-contour-color');
    if (colCont) {
      colCont.addEventListener('input', (e) => {
        document.getElementById('dem-hud-contour-color-val').textContent = e.target.value;
        WM.demRelief.setConfig({ contourColor: e.target.value });
      });
    }

    const sliderW = document.getElementById('dem-hud-width-slider');
    if (sliderW) {
      sliderW.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('dem-hud-width-val').textContent = val.toFixed(1) + ' px';
        WM.demRelief.setConfig({ contourWidth: val });
      });
    }

    document.getElementById('dem-hud-toggle-taper')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ taperWithElevation: e.target.checked });
      renderHudUI();
    });

    document.getElementById('dem-hud-taper-dir-select')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ taperDirection: e.target.value });
    });

    // Безопасное обновление taperStrength (с проверкой на null для предотвращения падения)
    const sliderTaperStr = document.getElementById('dem-hud-taper-strength-slider');
    if (sliderTaperStr) {
      sliderTaperStr.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const valEl = document.getElementById('dem-hud-taper-strength-val');
        if (valEl) valEl.textContent = val + '%';
        WM.demRelief.setConfig({ taperStrength: val / 100 });
      });
    }

    document.getElementById('dem-hud-ct-opacity')?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('dem-hud-ct-opacity-val').textContent = val + '%';
      WM.demRelief.setConfig({ contourOpacity: val / 100 });
    });

    document.getElementById('dem-hud-toggle-labels')?.addEventListener('change', (e) => {
      WM.demRelief.setConfig({ showLabels: e.target.checked });
    });
  }

  // =========================================================================
  // ПУБЛИЧНЫЙ API
  // =========================================================================
  WM.demRelief = {
    getConfig: () => ({ ...cfg }),

    getLayers() {
      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    },

    openHud() {
      const hud = document.getElementById('dem-relief-hud');
      if (!hud) return;
      initHudEvents();
      renderHudUI();
      hud.hidden = false;
      isHudOpen = true;
      if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('demReliefHud');
    },

    closeHud() {
      const hud = document.getElementById('dem-relief-hud');
      if (hud) hud.hidden = true;
      isHudOpen = false;
      if (WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('demReliefHud');
    },

    isHudOpen: () => isHudOpen,

    setConfig(newCfg) {
      const oldCfg = { ...cfg };
      Object.assign(cfg, newCfg);
      saveConfig();

      if (newCfg.hillshadeEnabled !== undefined || newCfg.contoursEnabled !== undefined) {
        applyLayerVisibility();
      }

      if (newCfg.hillshadeOpacity !== undefined && hillshadeLayerInstance) {
        hillshadeLayerInstance.setOpacity(cfg.hillshadeOpacity);
      }
      if (newCfg.contourOpacity !== undefined && contoursLayerInstance) {
        contoursLayerInstance.setOpacity(cfg.contourOpacity);
      }

      const needLightUpdate = (
        newCfg.manualTimeHour !== undefined && newCfg.manualTimeHour !== oldCfg.manualTimeHour ||
        newCfg.manualDateStr !== undefined && newCfg.manualDateStr !== oldCfg.manualDateStr ||
        newCfg.sunMode !== undefined && newCfg.sunMode !== oldCfg.sunMode ||
        newCfg.sunAzimuth !== undefined && newCfg.sunAzimuth !== oldCfg.sunAzimuth ||
        newCfg.sunAltitude !== undefined && newCfg.sunAltitude !== oldCfg.sunAltitude ||
        newCfg.colorTone !== undefined && newCfg.colorTone !== oldCfg.colorTone ||
        newCfg.zFactor !== undefined && newCfg.zFactor !== oldCfg.zFactor ||
        newCfg.ambientOcclusion !== undefined && newCfg.ambientOcclusion !== oldCfg.ambientOcclusion ||
        newCfg.aoStrength !== undefined && newCfg.aoStrength !== oldCfg.aoStrength ||
        newCfg.aoRadius !== undefined && newCfg.aoRadius !== oldCfg.aoRadius ||
        newCfg.paperGrain !== undefined && newCfg.paperGrain !== oldCfg.paperGrain ||
        newCfg.smoothMode !== undefined && newCfg.smoothMode !== oldCfg.smoothMode ||
        newCfg.hypsoMode !== undefined && newCfg.hypsoMode !== oldCfg.hypsoMode
      );

      if (needLightUpdate && cfg.hillshadeEnabled) {
        scheduleLiveHillshade();
      }

      const needContoursRedraw = (
        newCfg.contourStep !== undefined && newCfg.contourStep !== oldCfg.contourStep ||
        newCfg.contourColor !== undefined && newCfg.contourColor !== oldCfg.contourColor ||
        newCfg.contourWidth !== undefined && newCfg.contourWidth !== oldCfg.contourWidth ||
        newCfg.taperWithElevation !== undefined && newCfg.taperWithElevation !== oldCfg.taperWithElevation ||
        newCfg.taperDirection !== undefined && newCfg.taperDirection !== oldCfg.taperDirection ||
        newCfg.taperStrength !== undefined && newCfg.taperStrength !== oldCfg.taperStrength ||
        newCfg.contourPalette !== undefined && newCfg.contourPalette !== oldCfg.contourPalette ||
        newCfg.showLabels !== undefined && newCfg.showLabels !== oldCfg.showLabels
      );

      if (needContoursRedraw && contoursLayerInstance && cfg.contoursEnabled) {
        clearTimeout(contoursRedrawTimer);
        contoursRedrawTimer = setTimeout(() => {
          contoursLayerInstance.redraw();
        }, 100);
      }

      renderHudUI();
    },

    initLayers(map) {
      if (hillshadeLayerInstance && contoursLayerInstance) {
        return {
          hillshadeLayer: hillshadeLayerInstance,
          contoursLayer: contoursLayerInstance
        };
      }

      if (!map.getPane('wm-dem-hillshade-pane')) {
        map.createPane('wm-dem-hillshade-pane');
        map.getPane('wm-dem-hillshade-pane').style.zIndex = 260;
        map.getPane('wm-dem-hillshade-pane').style.mixBlendMode = 'multiply';
      }

      if (!map.getPane('wm-dem-contours-pane')) {
        map.createPane('wm-dem-contours-pane');
        map.getPane('wm-dem-contours-pane').style.zIndex = 470;
      }

      hillshadeLayerInstance = new WebGLHillshadeLayer({
        pane: 'wm-dem-hillshade-pane',
        maxNativeZoom: 15,
        maxZoom: 20,
        opacity: cfg.hillshadeOpacity,
        updateWhenIdle: true
      });

      contoursLayerInstance = new DEMContoursLayer({
        pane: 'wm-dem-contours-pane',
        minZoom: 10,
        maxNativeZoom: 15,
        maxZoom: 20,
        opacity: cfg.contourOpacity,
        updateWhenIdle: true
      });

      applyLayerVisibility();

      return {
        hillshadeLayer: hillshadeLayerInstance,
        contoursLayer: contoursLayerInstance
      };
    }
  };
})();