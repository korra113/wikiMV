/**
 * demPresets.js — Менеджер 3D-пресетов и профилей оформления карты
 */
(function () {
  const WM = window.WM = window.WM || {};

  // =========================================================================
  // БАЗА ВСТРОЕННЫХ ПРЕСЕТОВ (сюда можно вставлять экспортированные JSON)
  // =========================================================================
  const BUILTIN_3D_PRESETS = [
    {
  "id": "profile_1795356122148_598",
  "name": "Стандартный стиль",
  "version": 2,
  "createdAt": "2026-11-22T14:02:02.148Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": false,
    "demDeblockSigmaM": 60,
    "sunMode": "manual",
    "sunAzimuth": 235,
    "sunAltitude": 40,
    "manualScaleMode": "fixed",
    "manualElevMin": 0,
    "manualElevMax": 2500,
    "manualPeakColor": "#e9e0ff",
    "manualMidColor": "#b5844f",
    "manualValleyColor": "#837e72",
    "manualShadowColor": "#4c98d6",
    "manualLightBlend": 0.29,
    "manualLightSoftness": 0.24,
    "manualLightBlend2": 0.58,
    "manualLightSoftness2": 0.4,
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.5,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 2.1,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.4,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": true,
    "roadTintColor": "#8b654b",
    "roadTintOpacity": 0.35,
    "roadTintZone": 25,
    "roadTintSoftness": 1,
    "roadTintBlendMode": "overlay",
    "roadTintTypes": "drive",
    "edgeTintEnabled": true,
    "edgeTintColor": "#436562",
    "edgeTintOpacity": 0.6,
    "edgeTintZone": 12,
    "edgeTintSoftness": 1,
    "edgeTintBlendMode": "overlay",
    "edgeTintSide": "inside",
    "waterlining": true,
    "waterlineColor": "#152f56",
    "waterlineWidth": 6,
    "waterlineOpacity": 0.45,
    "waterTintEnabled": true,
    "waterTintColor": "#4399e5",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": true,
    "bounceStrength": 1.1,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "stipple",
    "ditherBlendMode": "normal",
    "ditherScale": 1.9,
    "ditherDensity": 0.55,
    "ditherThreshold": 0.3,
    "ditherLowCut": 0.35,
    "ditherSoftness": 0.95,
    "ditherZone": "shadows",
    "ditherStrength": 1.8,
    "ditherColor": "#3d2e0a",
    "ditherAngle": 62,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "lehmann",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.6,
    "hachureLength": 1,
    "hachureThinning": 0.6,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "ambientOcclusion": true,
    "aoStrength": 0.4,
    "aoRadius": 0.7,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.75,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.7,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.95,
    "outlineThreshold": 0.2,
    "outlineOpacity": 1,
    "outlineLightMod": 0.4
  },
  "terrainDecor": {
    "enabled": true,
    "color": "#44554d",
    "blendMode": "multiply",
    "opacity": 0.65,
    "lineWidth": 1,
    "size": 1.3,
    "sizeSpread": 1,
    "frequency": 0.1
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "enabled": false
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#898fa9",
        "width": 5,
        "casing": true,
        "casingColor": "#645e59",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#a59d93",
        "width": 3.5,
        "casing": true,
        "casingColor": "#494141",
        "casingWidth": 1.1
      },
      "path": {
        "enabled": true,
        "color": "#5c5957",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#436684",
        "fillOpacity": 1,
        "strokeColor": "#182f44",
        "strokeWidth": 1.2
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},


   {
  "id": "profile_1795356293599_109",
  "name": "Стандартный стиль (+Лес)",
  "version": 2,
  "createdAt": "2026-11-22T14:04:53.599Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": false,
    "demDeblockSigmaM": 60,
    "sunMode": "manual",
    "sunAzimuth": 235,
    "sunAltitude": 40,
    "manualScaleMode": "fixed",
    "manualElevMin": 0,
    "manualElevMax": 2500,
    "manualPeakColor": "#e9e0ff",
    "manualMidColor": "#b5844f",
    "manualValleyColor": "#837e72",
    "manualShadowColor": "#4c98d6",
    "manualLightBlend": 0.29,
    "manualLightSoftness": 0.24,
    "manualLightBlend2": 0.58,
    "manualLightSoftness2": 0.4,
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.5,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 2.1,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.4,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": true,
    "roadTintColor": "#8b654b",
    "roadTintOpacity": 0.35,
    "roadTintZone": 25,
    "roadTintSoftness": 1,
    "roadTintBlendMode": "overlay",
    "roadTintTypes": "drive",
    "edgeTintEnabled": true,
    "edgeTintColor": "#436562",
    "edgeTintOpacity": 0.6,
    "edgeTintZone": 12,
    "edgeTintSoftness": 1,
    "edgeTintBlendMode": "overlay",
    "edgeTintSide": "inside",
    "waterlining": true,
    "waterlineColor": "#152f56",
    "waterlineWidth": 6,
    "waterlineOpacity": 0.45,
    "waterTintEnabled": true,
    "waterTintColor": "#4399e5",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": true,
    "bounceStrength": 1.1,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "stipple",
    "ditherBlendMode": "normal",
    "ditherScale": 1.9,
    "ditherDensity": 0.55,
    "ditherThreshold": 0.3,
    "ditherLowCut": 0.35,
    "ditherSoftness": 0.95,
    "ditherZone": "shadows",
    "ditherStrength": 1.8,
    "ditherColor": "#3d2e0a",
    "ditherAngle": 62,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "lehmann",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.6,
    "hachureLength": 1,
    "hachureThinning": 0.6,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "ambientOcclusion": true,
    "aoStrength": 0.4,
    "aoRadius": 0.7,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.75,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.7,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.95,
    "outlineThreshold": 0.2,
    "outlineOpacity": 1,
    "outlineLightMod": 0.4
  },
  "terrainDecor": {
    "enabled": true,
    "color": "#44554d",
    "blendMode": "multiply",
    "opacity": 0.65,
    "lineWidth": 1,
    "size": 1.3,
    "sizeSpread": 1,
    "frequency": 0.1
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "settings": {
      "heightEnabled": false,
      "maskEnabled": false,
      "treesEnabled": true,
      "treeStyle": "real",
      "treeDensity": 1.25,
      "treeScale": 1.7,
      "treeColor": "#0d0a07",
      "treeStrokeColor": "#0d0a07",
      "treeOpacity": 0.95,
      "treeBlendMode": "darken",
      "canopyFantasyForest": true,
      "treeMinH": 2,
      "forestOnlyThreshold": 0.85,
      "treeVolumetric": 0.35,
      "treePaperBleed": 0.8,
      "treeVariety": 0.6,
      "treeTerrainLight": true,
      "treeShadows": true,
      "treeOpaqueFill": true,
      "treeFillWarmth": 0.66,
      "treeFillBrightness": 0.9,
      "treeFillSaturation": 0.8,
      "colorScatter": 0.4,
      "treeNightTint": "#939feb",
      "treeNightStrength": 0.24,
      "treeNightBrightness": 2.5,
      "treeNightContrast": 0.9,
      "treeShadeOpacity": 0.44,
      "treeShadeDarkness": 0.38,
      "treeGroundShadowCustom": false,
      "treeContactShadowOpacity": 0.62,
      "treeMassifBaseDarkness": 0.48,
      "treeClustering": true,
      "treeClearRoads": true,
      "treeAutoDense": true,
      "treeSlopeSuppression": 0.9,
      "treeTerrainShadows": true,
      "treeShadowStrength": 1.34,
      "treeClearRoadsDist": 1.2,
      "treeClearRoadsOpacity": 0.95,
      "treeClearRoadsSoftness": 0.7,
      "treeAutoDenseScale": 2.5,
      "treeAutoDenseThinning": 0.3,
      "treeEdgeScale": 0.7,
      "treeMassifScale": 0.9,
      "customColors": true,
      "decidColor1": "#83703a",
      "decidColor2": "#5b6a2f",
      "coniferColor": "#4a5550",
      "decidRatio": 0.64,
      "treeSlopeTolerance": 0.05
    }
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#898fa9",
        "width": 5,
        "casing": true,
        "casingColor": "#645e59",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#a59d93",
        "width": 3.5,
        "casing": true,
        "casingColor": "#494141",
        "casingWidth": 1.1
      },
      "path": {
        "enabled": true,
        "color": "#5c5957",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#436684",
        "fillOpacity": 1,
        "strokeColor": "#182f44",
        "strokeWidth": 1.2
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795355970087_126",
  "name": "Старинная карта",
  "version": 2,
  "createdAt": "2026-11-22T13:59:30.086Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": false,
    "demDeblockSigmaM": 60,
    "sunMode": "manual",
    "sunAzimuth": 260,
    "sunAltitude": 40,
    "manualScaleMode": "relative",
    "manualElevMin": 0,
    "manualElevMax": 1500,
    "manualPeakColor": "#ffc7c7",
    "manualMidColor": "#978878",
    "manualValleyColor": "#806e47",
    "manualShadowColor": "#6bc6ff",
    "manualLightBlend": 0.33,
    "manualLightSoftness": 0.38,
    "manualLightBlend2": 0.73,
    "manualLightSoftness2": 0.78,
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.5,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 1.85,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.65,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": false,
    "edgeTintEnabled": false,
    "waterlining": true,
    "waterlineColor": "#080a0d",
    "waterlineWidth": 4,
    "waterlineOpacity": 0.6,
    "waterTintEnabled": true,
    "waterTintColor": "#f0f8ff",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": true,
    "bounceStrength": 1.1,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "stipple",
    "ditherBlendMode": "normal",
    "ditherScale": 1.9,
    "ditherDensity": 0.55,
    "ditherThreshold": 0.3,
    "ditherLowCut": 0.35,
    "ditherSoftness": 0.95,
    "ditherZone": "shadows",
    "ditherStrength": 1.8,
    "ditherColor": "#3d2e0a",
    "ditherAngle": 62,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "flow",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.6,
    "hachureLength": 1.6,
    "hachureThinning": 0.6,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "ambientOcclusion": true,
    "aoStrength": 0.3,
    "aoRadius": 0.7,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.95,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 2,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.95,
    "outlineThreshold": 0.2,
    "outlineOpacity": 1,
    "outlineLightMod": 0.4
  },
  "terrainDecor": {
    "enabled": false
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "settings": {
      "heightEnabled": false,
      "maskEnabled": false,
      "treesEnabled": true,
      "treeStyle": "real",
      "treeDensity": 0.45,
      "treeScale": 1.3,
      "treeColor": "#0d0a07",
      "treeStrokeColor": "#0d0a07",
      "treeOpacity": 1,
      "treeBlendMode": "darken",
      "canopyFantasyForest": true,
      "treeMinH": 2,
      "forestOnlyThreshold": 0.85,
      "treeVolumetric": 0.25,
      "treePaperBleed": 0.85,
      "treeVariety": 0.6,
      "treeTerrainLight": true,
      "treeShadows": true,
      "treeOpaqueFill": true,
      "treeFillWarmth": 0.66,
      "treeFillBrightness": 0.9,
      "treeFillSaturation": 0.8,
      "colorScatter": 0.15,
      "treeNightTint": "#939feb",
      "treeNightStrength": 0.24,
      "treeNightBrightness": 2.5,
      "treeNightContrast": 0.9,
      "treeShadeOpacity": 0.44,
      "treeShadeDarkness": 0.38,
      "treeGroundShadowCustom": false,
      "treeContactShadowOpacity": 0.62,
      "treeMassifBaseDarkness": 0.48,
      "treeClustering": true,
      "treeClearRoads": true,
      "treeAutoDense": true,
      "treeSlopeSuppression": 0.25,
      "treeTerrainShadows": true,
      "treeShadowStrength": 1.34,
      "treeClearRoadsDist": 1.2,
      "treeClearRoadsOpacity": 0.95,
      "treeClearRoadsSoftness": 0.7,
      "treeAutoDenseScale": 2.5,
      "treeAutoDenseThinning": 0.1,
      "treeEdgeScale": 0.95,
      "treeMassifScale": 1.35,
      "customColors": true,
      "decidColor1": "#7c6e46",
      "decidColor2": "#797539",
      "coniferColor": "#515b49",
      "decidRatio": 0.64,
      "treeSlopeTolerance": 0.15
    }
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#3f424a",
        "width": 5,
        "casing": true,
        "casingColor": "#aba39b",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#bcb6ae",
        "width": 3.5,
        "casing": true,
        "casingColor": "#514d4d",
        "casingWidth": 2
      },
      "path": {
        "enabled": true,
        "color": "#625e5b",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#7c858d",
        "fillOpacity": 1,
        "strokeColor": "#2f444b",
        "strokeWidth": 3
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795126911401_733",
  "name": "Фэнтези(выс нагрузка)",
  "version": 2,
  "createdAt": "2026-11-19T22:21:51.401Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": false,
    "demDeblockSigmaM": 60,
    "sunMode": "time",
    "manualTimeHour": 11.328625159057992,
    "manualDateStr": "2026-06-22",
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.6,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 1.65,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.7,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 5.5,
    "waterlining": true,
    "waterlineColor": "#080a0d",
    "waterlineWidth": 4,
    "waterlineOpacity": 0.6,
    "waterTintEnabled": true,
    "waterTintColor": "#0088ff",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.5,
    "bounceEnabled": false,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "cross",
    "ditherBlendMode": "normal",
    "ditherScale": 1.5,
    "ditherDensity": 0.65,
    "ditherThreshold": 0.35,
    "ditherLowCut": 0.35,
    "ditherSoftness": 1.3,
    "ditherZone": "shadows",
    "ditherStrength": 2,
    "ditherColor": "#251b04",
    "ditherAngle": 94,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "contour",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.5,
    "hachureLength": 1.3,
    "hachureThinning": 0.1,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "ambientOcclusion": false,
    "svfEnabled": true,
    "svfStrength": 1.75,
    "castShadows": true,
    "shadowReach": 0.8,
    "shadowOpacity": 1.05,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 3.1,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.9,
    "outlineThreshold": 0.15,
    "outlineOpacity": 1,
    "outlineLightMod": 0.3
  },
  "clouds": {
    "enabled": true,
    "config": {
      "scale": 0.85,
      "coverage": 0.86,
      "coverageFromWeather": false,
      "density": 2.85,
      "billowDetail": 0.9,
      "stretch": 3,
      "mixCumulus": 2,
      "mixRolls": 4,
      "mixArcs": 1,
      "mixStreaks": 2,
      "mixSheets": 1,
      "fractus": 0.5,
      "translucency": 0.1,
      "curl": 0.3,
      "edgeRagged": -2,
      "cumulusMode": true,
      "clusterIsolation": 6,
      "smoothBlend": 3,
      "sunBlendBoost": 8,
      "creviceDarkness": 0,
      "volumeDepth": 1.1,
      "shadowCoverage": 0.46,
      "shadowSoftness": 0.6,
      "atmTintStrength": 1.5,
      "sunsetWarmth": 1.5,
      "shadowBrightness": 0.45,
      "shadowColorSat": 1,
      "bodyColorInfluence": 1,
      "cloudBrightness": 1.8,
      "cloudContrast": 0.85,
      "cloudTempLight": 0.2,
      "cloudTempShadow": 0.7,
      "hatchStyle": "woodcut",
      "hatchCurvature": 0.75,
      "hatchSpacing": 3.6,
      "hatchThickness": 0.75,
      "hatchLength": 4.8,
      "hatchThinning": 0.52,
      "hatchLight": 1,
      "creaseOutlines": 0.2,
      "creaseBlur": 0.6,
      "outlineWidth": 2.5,
      "outlineColor": "#271f1b",
      "bodyColor": "#ff5e24",
      "inkColor": "#15130e",
      "opacity": 0.9,
      "inkOpacity": 0.84,
      "shadowOpacity": 0.28,
      "shadowHeight": 3,
      "shadowBlur": 6,
      "terrain": true,
      "mountainDeflection": 2.5,
      "peakPiercing": 0.6,
      "cloudBase": 1.5,
      "cloudThickness": 0.5,
      "wakeSplit": 1,
      "orographicLift": 0.08,
      "foehnDissipation": 0.85,
      "speed": 1,
      "windSource": "manual",
      "windDir": 196,
      "windSpeed": 16,
      "volumeSmooth": 0.55,
      "toneRamp": 1,
      "paperShading": 1.1,
      "paperGrain": 1.5,
      "paperGrainScale": 1,
      "paperGrainContrast": 3,
      "innerAnim": true,
      "innerSpeed": 1.15,
      "innerWobble": 0.8,
      "innerWarp": 0.1,
      "hatchBoil": 0,
      "animFps": 30,
      "darkCover": 0.28,
      "darkAmount": 1.1,
      "darkSoft": 0.44,
      "darkScale": 2.7,
      "fadeIn": 1.4,
      "fadeOut": 0.6,
      "reorientDeg": 25,
      "fps": 60,
      "adaptiveFps": true,
      "resolution": 0.9,
      "fieldRes": 0.5,
      "autoQuality": true,
      "zIndex": 460
    }
  },
  "canopy": {
    "settings": {
      "heightEnabled": false,
      "maskEnabled": false,
      "treesEnabled": true,
      "treeStyle": "real",
      "treeDensity": 0.95,
      "treeScale": 1.6,
      "treeColor": "#0d0a07",
      "treeStrokeColor": "#0d0a07",
      "treeOpacity": 0.95,
      "treeBlendMode": "darken",
      "canopyFantasyForest": true,
      "treeMinH": 2,
      "forestOnlyThreshold": 0.85,
      "treeVolumetric": 0.3,
      "treePaperBleed": 0.75,
      "treeVariety": 0.6,
      "treeTerrainLight": true,
      "treeShadows": true,
      "treeOpaqueFill": true,
      "treeFillWarmth": 0.66,
      "treeFillBrightness": 0.9,
      "treeFillSaturation": 0.8,
      "colorScatter": 0.4,
      "treeNightTint": "#939feb",
      "treeNightStrength": 0.24,
      "treeNightBrightness": 2.5,
      "treeNightContrast": 0.9,
      "treeShadeOpacity": 0.44,
      "treeShadeDarkness": 0.38,
      "treeGroundShadowCustom": false,
      "treeContactShadowOpacity": 0.62,
      "treeMassifBaseDarkness": 0.48,
      "treeClustering": true,
      "treeClearRoads": true,
      "treeAutoDense": true,
      "treeSlopeSuppression": 0.9,
      "treeTerrainShadows": true,
      "treeShadowStrength": 1.34,
      "treeClearRoadsDist": 1.2,
      "treeClearRoadsOpacity": 0.95,
      "treeClearRoadsSoftness": 0.7,
      "treeAutoDenseScale": 2.5,
      "treeAutoDenseThinning": 0.1,
      "treeEdgeScale": 0.7,
      "treeMassifScale": 2.15,
      "customColors": true,
      "decidColor1": "#cce166",
      "decidColor2": "#9eaf4b",
      "coniferColor": "#415d42",
      "decidRatio": 0.64,
      "treeSlopeTolerance": 0.05
    }
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#32401c",
      "fillOpacity": 0.9,
      "strokeColor": "#373e09",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#b19110",
      "fillOpacity": 0.48,
      "strokeColor": "#5e4403",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#3f424a",
        "width": 5,
        "casing": true,
        "casingColor": "#aba39b",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#afa79d",
        "width": 3.5,
        "casing": true,
        "casingColor": "#514d4d",
        "casingWidth": 2
      },
      "path": {
        "enabled": true,
        "color": "#625e5b",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#7c858d",
        "fillOpacity": 1,
        "strokeColor": "#2f444b",
        "strokeWidth": 3
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795127909971_689",
  "name": "Гравюра",
  "version": 2,
  "createdAt": "2026-11-19T22:38:29.971Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": true,
    "demDeblockSigmaM": 60,
    "sunMode": "time",
    "manualTimeHour": 13.347233040407446,
    "manualDateStr": "2026-06-22",
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.45,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 1.15,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 1.05,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "waterlining": true,
    "waterlineColor": "#080a0d",
    "waterlineWidth": 4,
    "waterlineOpacity": 0.6,
    "waterTintEnabled": true,
    "waterTintColor": "#55626d",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": false,
    "bounceEnabled": false,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "wavy",
    "ditherBlendMode": "normal",
    "ditherScale": 1.8,
    "ditherDensity": 2.2,
    "ditherThreshold": 0.35,
    "ditherLowCut": 0.45,
    "ditherSoftness": 1.3,
    "ditherZone": "shadows",
    "ditherStrength": 2,
    "ditherColor": "#251b04",
    "ditherAngle": 45,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "rock",
    "hachureBlendMode": "normal",
    "hachureDensity": 1.3,
    "hachureLength": 1.3,
    "hachureThinning": 0.25,
    "hachureOpacity": 0.7,
    "hachureSlope": 0.02,
    "hachureColor": "#251103",
    "hachureLightMod": 1,
    "ambientOcclusion": true,
    "aoStrength": 0.4,
    "aoRadius": 1.6,
    "aoSlopeBleed": 0.3,
    "svfEnabled": true,
    "svfStrength": 1.65,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.75,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 0.95,
    "outlineDensity": 1,
    "outlineThreshold": 0.15,
    "outlineOpacity": 1,
    "outlineLightMod": 0.15,
    "contourStep": 20,
    "contourBlendMode": "normal",
    "contourOpacity": 0.6,
    "contourWidth": 3.5,
    "contourStyle": "standard",
    "contourSmoothing": "chaikin",
    "contourRoughness": 0.65,
    "contourHandPressure": 0.3,
    "cliffHairlines": true,
    "showLabels": true,
    "contourPalette": "custom",
    "contourColor": "#442504",
    "contourMajorColor": "#4a2c17",
    "taperWithElevation": true,
    "taperDirection": "crests",
    "taperStrength": 1.25,
    "formLinesEnabled": true,
    "formLinesSlopeMax": 0.035
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "enabled": false
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#1f3828",
      "fillOpacity": 0.9,
      "strokeColor": "#373e09",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#46390c",
      "fillOpacity": 0.48,
      "strokeColor": "#2b230d",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#3f424a",
        "width": 5,
        "casing": true,
        "casingColor": "#aba39b",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#afa79d",
        "width": 3.5,
        "casing": true,
        "casingColor": "#514d4d",
        "casingWidth": 2
      },
      "path": {
        "enabled": true,
        "color": "#625e5b",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#7c858d",
        "fillOpacity": 1,
        "strokeColor": "#2f444b",
        "strokeWidth": 3
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#c4bcab",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14.5,
        "bold": true
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795200132916_550",
  "name": "Ручное время",
  "version": 2,
  "createdAt": "2026-11-20T18:42:12.916Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": true,
    "demDeblockSigmaM": 60,
    "sunMode": "time",
    "manualTimeHour": 15.44611439079381,
    "manualDateStr": "2026-10-27",
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.55,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 2.1,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.5,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": true,
    "roadTintColor": "#8b654b",
    "roadTintOpacity": 0.35,
    "roadTintZone": 25,
    "roadTintSoftness": 1,
    "roadTintBlendMode": "overlay",
    "roadTintTypes": "drive",
    "edgeTintEnabled": true,
    "edgeTintColor": "#436562",
    "edgeTintOpacity": 0.6,
    "edgeTintZone": 12,
    "edgeTintSoftness": 1,
    "edgeTintBlendMode": "overlay",
    "edgeTintSide": "inside",
    "waterlining": true,
    "waterlineColor": "#152f56",
    "waterlineWidth": 6,
    "waterlineOpacity": 0.45,
    "waterTintEnabled": true,
    "waterTintColor": "#4399e5",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": false,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "stipple",
    "ditherBlendMode": "normal",
    "ditherScale": 1.9,
    "ditherDensity": 0.55,
    "ditherThreshold": 0.3,
    "ditherLowCut": 0.35,
    "ditherSoftness": 0.95,
    "ditherZone": "shadows",
    "ditherStrength": 1.8,
    "ditherColor": "#3d2e0a",
    "ditherAngle": 62,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "hybrid",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.9,
    "hachureLength": 1.1,
    "hachureThinning": 0.6,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "hachureHybridThresh": 0.31,
    "hachureHybridSharpness": 0.5,
    "ambientOcclusion": true,
    "aoStrength": 0.2,
    "aoRadius": 0.6,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.75,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.7,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.95,
    "outlineThreshold": 0.2,
    "outlineOpacity": 1,
    "outlineLightMod": 0.4,
    "contourStep": 50,
    "contourBlendMode": "multiply",
    "contourOpacity": 0.6,
    "contourWidth": 3.5,
    "contourStyle": "standard",
    "contourSmoothing": "chaikin",
    "contourRoughness": 0.45,
    "contourHandPressure": 0.1,
    "cliffHairlines": true,
    "showLabels": true,
    "contourPalette": "custom",
    "contourColor": "#47370a",
    "contourMajorColor": "#4a2c17",
    "taperWithElevation": true,
    "taperDirection": "crests",
    "taperStrength": 1.7,
    "formLinesEnabled": true,
    "formLinesSlopeMax": 0.035
  },
  "terrainDecor": {
    "enabled": true,
    "color": "#44554d",
    "blendMode": "multiply",
    "opacity": 0.65,
    "lineWidth": 1,
    "size": 1.3,
    "sizeSpread": 1,
    "frequency": 0.1
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "enabled": false
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#898fa9",
        "width": 5,
        "casing": true,
        "casingColor": "#645e59",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#a59d93",
        "width": 3.5,
        "casing": true,
        "casingColor": "#494141",
        "casingWidth": 1.1
      },
      "path": {
        "enabled": true,
        "color": "#5c5957",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#436684",
        "fillOpacity": 1,
        "strokeColor": "#182f44",
        "strokeWidth": 1.2
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795200090600_123",
  "name": "По времени суток",
  "version": 2,
  "createdAt": "2026-11-20T18:41:30.600Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": true,
    "demDeblockSigmaM": 60,
    "sunMode": "suncalc",
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.55,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 2.1,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.5,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": true,
    "roadTintColor": "#8b654b",
    "roadTintOpacity": 0.35,
    "roadTintZone": 25,
    "roadTintSoftness": 1,
    "roadTintBlendMode": "overlay",
    "roadTintTypes": "drive",
    "edgeTintEnabled": true,
    "edgeTintColor": "#436562",
    "edgeTintOpacity": 0.6,
    "edgeTintZone": 12,
    "edgeTintSoftness": 1,
    "edgeTintBlendMode": "overlay",
    "edgeTintSide": "inside",
    "waterlining": true,
    "waterlineColor": "#152f56",
    "waterlineWidth": 6,
    "waterlineOpacity": 0.45,
    "waterTintEnabled": true,
    "waterTintColor": "#4399e5",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": false,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": true,
    "ditherType": "stipple",
    "ditherBlendMode": "normal",
    "ditherScale": 1.9,
    "ditherDensity": 0.55,
    "ditherThreshold": 0.3,
    "ditherLowCut": 0.35,
    "ditherSoftness": 0.95,
    "ditherZone": "shadows",
    "ditherStrength": 1.8,
    "ditherColor": "#3d2e0a",
    "ditherAngle": 62,
    "mdowEnabled": false,
    "hachureEnabled": true,
    "hachureType": "hybrid",
    "hachureBlendMode": "overlay",
    "hachureDensity": 1.9,
    "hachureLength": 1.1,
    "hachureThinning": 0.6,
    "hachureOpacity": 0.8,
    "hachureSlope": 0.02,
    "hachureColor": "#31302f",
    "hachureLightMod": 1,
    "hachureHybridThresh": 0.31,
    "hachureHybridSharpness": 0.5,
    "ambientOcclusion": true,
    "aoStrength": 0.2,
    "aoRadius": 0.6,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.75,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.7,
    "outlineEnabled": true,
    "outlineType": "all",
    "outlineBlendMode": "multiply",
    "outlineColor": "#836767",
    "outlineWidth": 2.5,
    "outlineRoughness": 1,
    "outlineTexture": 1,
    "outlineDensity": 0.95,
    "outlineThreshold": 0.2,
    "outlineOpacity": 1,
    "outlineLightMod": 0.4,
    "contourStep": 50,
    "contourBlendMode": "multiply",
    "contourOpacity": 0.6,
    "contourWidth": 3.5,
    "contourStyle": "standard",
    "contourSmoothing": "chaikin",
    "contourRoughness": 0.45,
    "contourHandPressure": 0.1,
    "cliffHairlines": true,
    "showLabels": true,
    "contourPalette": "custom",
    "contourColor": "#47370a",
    "contourMajorColor": "#4a2c17",
    "taperWithElevation": true,
    "taperDirection": "crests",
    "taperStrength": 1.7,
    "formLinesEnabled": true,
    "formLinesSlopeMax": 0.035
  },
  "terrainDecor": {
    "enabled": true,
    "color": "#44554d",
    "blendMode": "multiply",
    "opacity": 0.65,
    "lineWidth": 1,
    "size": 1.3,
    "sizeSpread": 1,
    "frequency": 0.1
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "enabled": false
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#898fa9",
        "width": 5,
        "casing": true,
        "casingColor": "#645e59",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#a59d93",
        "width": 3.5,
        "casing": true,
        "casingColor": "#494141",
        "casingWidth": 1.1
      },
      "path": {
        "enabled": true,
        "color": "#5c5957",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#436684",
        "fillOpacity": 1,
        "strokeColor": "#182f44",
        "strokeWidth": 1.2
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},
{
  "id": "profile_1795201097641_869",
  "name": "CG Отмывка",
  "version": 2,
  "createdAt": "2026-11-20T18:58:17.641Z",
  "demRelief": {
    "demSource": "fabdem",
    "demDeblock": true,
    "hillshadeEnabled": true,
    "contoursEnabled": true,
    "demDeblockSigmaM": 60,
    "sunMode": "time",
    "manualTimeHour": 15.44611439079381,
    "manualDateStr": "2026-10-27",
    "blendMode": "normal",
    "hillshadeOpacity": 1,
    "colorTone": "none",
    "smoothMode": "gauss",
    "hypsoMode": "atlas",
    "orenNayarRoughness": 0.45,
    "specularDamp": 2.7,
    "inkBleed": true,
    "lightBoost": 2.1,
    "imhofDeflection": 0.95,
    "imhofWarmCool": 0.8,
    "lightWrap": 0.6,
    "paperGrain": 1.15,
    "zFactorAuto": false,
    "zFactor": 2,
    "roadTintEnabled": true,
    "roadTintColor": "#8b654b",
    "roadTintOpacity": 0.35,
    "roadTintZone": 25,
    "roadTintSoftness": 1,
    "roadTintBlendMode": "overlay",
    "roadTintTypes": "drive",
    "edgeTintEnabled": true,
    "edgeTintColor": "#436562",
    "edgeTintOpacity": 0.6,
    "edgeTintZone": 12,
    "edgeTintSoftness": 1,
    "edgeTintBlendMode": "overlay",
    "edgeTintSide": "inside",
    "waterlining": true,
    "waterlineColor": "#152f56",
    "waterlineWidth": 6,
    "waterlineOpacity": 0.45,
    "waterTintEnabled": true,
    "waterTintColor": "#4399e5",
    "waterTintOpacity": 0.5,
    "waterTintCoverage": 0.8,
    "waterTintBlendMode": "multiply",
    "seaWavesEnabled": true,
    "seaWaveStyle": "ripples",
    "seaWaveScale": 80,
    "seaWaveSpacing": 5.5,
    "seaWaveUndulation": 8.8,
    "seaWaveThickness": 2.5,
    "seaWaveRoughness": 1,
    "seaWaveOpacity": 0.4,
    "seaWaveColor": "#272e3a",
    "seaWaveShoreFade": 1,
    "seaWaveBlendMode": "multiply",
    "seaWaveFillEnabled": false,
    "opennessEnabled": true,
    "opennessRadius": 0.65,
    "opennessStrength": 1.1,
    "opennessDiff": 0.6,
    "bounceEnabled": false,
    "contactShadowsEnabled": true,
    "penumbraScale": 0.6,
    "ditherEnabled": false,
    "mdowEnabled": false,
    "hachureEnabled": false,
    "ambientOcclusion": true,
    "aoStrength": 0.2,
    "aoRadius": 0.6,
    "aoSlopeBleed": 0,
    "svfEnabled": true,
    "svfStrength": 0.75,
    "castShadows": true,
    "shadowReach": 1,
    "shadowOpacity": 1.2,
    "outlineEnabled": false,
    "contourStep": 50,
    "contourBlendMode": "normal",
    "contourOpacity": 0.6,
    "contourWidth": 3.5,
    "contourStyle": "tanaka",
    "contourSmoothing": "chaikin",
    "contourRoughness": 0.45,
    "contourHandPressure": 0.1,
    "cliffHairlines": true,
    "showLabels": true,
    "contourPalette": "custom",
    "contourColor": "#261d03",
    "contourMajorColor": "#4a2c17",
    "taperWithElevation": true,
    "taperDirection": "crests",
    "taperStrength": 1.7,
    "formLinesEnabled": true,
    "formLinesSlopeMax": 0.035,
    "tanakaHighlightColor": "#ffffff",
    "tanakaShadowColor": "#3c1806"
  },
  "terrainDecor": {
    "enabled": true,
    "color": "#44554d",
    "blendMode": "multiply",
    "opacity": 0.65,
    "lineWidth": 1,
    "size": 1.3,
    "sizeSpread": 1,
    "frequency": 0.1
  },
  "clouds": {
    "enabled": false
  },
  "canopy": {
    "enabled": false
  },
  "vectorRoads": {
    "enabled": true,
    "blendMode": "hard-light",
    "opacity": 0.75,
    "forest": {
      "enabled": true,
      "fillColor": "#596742",
      "fillOpacity": 0.9,
      "strokeColor": "#253b16",
      "strokeWidth": 1.4,
      "strokeDash": false
    },
    "farmland": {
      "enabled": true,
      "fillColor": "#645207",
      "fillOpacity": 0.48,
      "strokeColor": "#48380f",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "cemeteries": {
      "enabled": true,
      "fillColor": "#3f4546",
      "fillOpacity": 0.42,
      "strokeColor": "#373d34",
      "strokeWidth": 2.5,
      "pattern": true
    },
    "piers": {
      "enabled": true,
      "fillColor": "#9c7a54",
      "strokeColor": "#2e1f12",
      "width": 2,
      "opacity": 0.85,
      "woodcut": true
    },
    "buildings": {
      "enabled": true,
      "fillColor": "#92755d",
      "fillOpacity": 0.35,
      "strokeColor": "#0c0704",
      "strokeWidth": 1
    },
    "transport": {
      "enabled": true,
      "color": "#241811",
      "haloColor": "#f2e7d5",
      "size": 1.5,
      "airEnabled": true,
      "railEnabled": true,
      "busEnabled": true,
      "labelsEnabled": true
    },
    "pois": {
      "enabled": true,
      "color": "#3a2110",
      "haloColor": "#f4ead5",
      "scale": 1,
      "historicEnabled": true,
      "tourismEnabled": true,
      "manmadeEnabled": true,
      "amenityEnabled": true,
      "labelsEnabled": true
    },
    "peaks": {
      "enabled": true,
      "color": "#413934",
      "iconColor": "#2b190d",
      "haloColor": "#b7b0a4",
      "iconStyle": "classic",
      "iconScale": 1.3,
      "size": 10.5,
      "opacity": 0.75,
      "bold": false,
      "italic": false,
      "showElevation": true,
      "elePosition": "below",
      "showVolcanoes": true,
      "showPasses": true,
      "unnamedAtHighZoom": true
    },
    "parks": {
      "enabled": true,
      "borders": true,
      "borderStyle": "dashdot",
      "borderGlow": true,
      "fillColor": "#173116",
      "fillOpacity": 0.16,
      "fillPattern": "dots",
      "strokeColor": "#0f1f0f",
      "strokeWidth": 1.8,
      "strokeOpacity": 0.85,
      "labelColor": "#333e32",
      "haloColor": "#a8b299",
      "size": 15.5,
      "opacity": 1,
      "labelStyle": "arch",
      "letterSpacing": 4,
      "ornament": "leaves",
      "uppercase": true,
      "bold": true,
      "italic": true,
      "archCurve": 8
    },
    "roads": {
      "major": {
        "enabled": true,
        "color": "#898fa9",
        "width": 5,
        "casing": true,
        "casingColor": "#645e59",
        "casingWidth": 1.6
      },
      "track": {
        "enabled": true,
        "color": "#a59d93",
        "width": 3.5,
        "casing": true,
        "casingColor": "#494141",
        "casingWidth": 1.1
      },
      "path": {
        "enabled": true,
        "color": "#5c5957",
        "width": 2.8,
        "dashed": true
      },
      "minor": {
        "enabled": true,
        "color": "#a99b93",
        "width": 3.5
      }
    },
    "railways": {
      "enabled": true,
      "style": "ties",
      "color": "#2b1e16",
      "tieColor": "#f2e7d5",
      "width": 4,
      "opacity": 0.8,
      "minorEnabled": true,
      "stations": {
        "enabled": true,
        "labelsEnabled": true,
        "showIcon": true,
        "showHalts": true,
        "minZoom": 13,
        "labelStyle": "halo",
        "color": "#24160d",
        "haloColor": "#f4ead5",
        "iconColor": "#24160d",
        "size": 11,
        "iconScale": 1.8,
        "opacity": 1,
        "bold": true,
        "italic": true
      }
    },
    "water": {
      "rivers": {
        "enabled": true,
        "color": "#264a6e",
        "width": 3,
        "opacity": 1
      },
      "lakes": {
        "enabled": true,
        "fillColor": "#436684",
        "fillOpacity": 1,
        "strokeColor": "#182f44",
        "strokeWidth": 1.2
      },
      "oceans": {
        "enabled": true,
        "fillColor": "#88b3bf",
        "fillOpacity": 0.6,
        "strokeColor": "#1d3842",
        "strokeWidth": 1.2
      },
      "marshes": {
        "enabled": true,
        "fillColor": "#506c71",
        "fillOpacity": 0.75,
        "strokeColor": "#25413b",
        "strokeWidth": 2.5,
        "pattern": true
      }
    },
    "labels": {
      "blendMode": "normal",
      "opacity": 1,
      "banners": {
        "enabled": true,
        "bannerColor": "#dbd7cc",
        "bannerStrokeColor": "#2c1c0f",
        "bannerStrokeWidth": 1.2,
        "washColor": "#bbb6aa",
        "washOpacity": 0.6,
        "paddingX": 8,
        "paddingY": 3,
        "scale": 1
      },
      "major": {
        "enabled": true,
        "color": "#4d4d4d",
        "haloColor": "#373434",
        "size": 22,
        "bold": true
      },
      "minor": {
        "enabled": true,
        "color": "#413c3a",
        "haloColor": "#a39595",
        "size": 14,
        "bold": false
      },
      "localities": {
        "enabled": true,
        "color": "#453835",
        "haloColor": "#b0a6a6",
        "size": 12,
        "italic": true
      },
      "water": {
        "enabled": true,
        "color": "#222c4e",
        "haloColor": "#8a92a8",
        "size": 14,
        "italic": true
      }
    }
  },
  "terrainOverlays": {
    "enabled": false
  },
  "viewshed": {
    "active": false
  }
},

  ];

  // =========================================================================
  // КОМПАКТНАЯ СЕРИАЛИЗАЦИЯ (без параметров от выключенных функций)
  // =========================================================================
  function pickKeys(src, keys, dst = {}) {
    if (!src) return dst;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (src[k] !== undefined) dst[k] = src[k];
    }
    return dst;
  }

  function compactDemRelief(c) {
    if (!c) return { hillshadeEnabled: false, contoursEnabled: false };
    const hsOn = !!c.hillshadeEnabled;
    const ctOn = !!c.contoursEnabled;
    if (!hsOn && !ctOn) {
      return { hillshadeEnabled: false, contoursEnabled: false };
    }



    const out = {
      demSource: c.demSource,
      demDeblock: !!c.demDeblock,
      hillshadeEnabled: hsOn,
      contoursEnabled: ctOn
    };
    if (c.demDeblock) out.demDeblockSigmaM = c.demDeblockSigmaM;

    const needSun = hsOn || (ctOn && c.contourStyle === 'tanaka');
    if (needSun) {
      out.sunMode = c.sunMode;
      if (c.sunMode === 'time') {
        pickKeys(c, ['manualTimeHour', 'manualDateStr'], out);
      } else if (c.sunMode === 'manual') {
        pickKeys(c, [
          'sunAzimuth', 'sunAltitude',
          'manualScaleMode', 'manualElevMin', 'manualElevMax',
          'manualPeakColor', 'manualMidColor', 'manualValleyColor', 'manualShadowColor',
          'manualLightBlend', 'manualLightSoftness', 'manualLightBlend2', 'manualLightSoftness2'
        ], out);
      }
    }

    if (hsOn) {
      pickKeys(c, [
        'blendMode', 'hillshadeOpacity', 'colorTone', 'smoothMode', 'hypsoMode',
        'orenNayarRoughness', 'specularDamp', 'inkBleed', 'lightBoost',
        'imhofDeflection', 'imhofWarmCool', 'lightWrap', 'paperGrain',
        'zFactorAuto'
      ], out);
      if (!c.zFactorAuto) out.zFactor = c.zFactor;

      out.roadTintEnabled = !!c.roadTintEnabled;
      if (c.roadTintEnabled) {
        pickKeys(c, [
          'roadTintColor', 'roadTintOpacity', 'roadTintZone',
          'roadTintSoftness', 'roadTintBlendMode', 'roadTintTypes'
        ], out);
      }

      out.edgeTintEnabled = !!c.edgeTintEnabled;
      if (c.edgeTintEnabled) {
        pickKeys(c, [
          'edgeTintColor', 'edgeTintOpacity', 'edgeTintZone',
          'edgeTintSoftness', 'edgeTintBlendMode', 'edgeTintSide'
        ], out);
      }

      out.waterlining = !!c.waterlining;
      if (c.waterlining) pickKeys(c, ['waterlineColor', 'waterlineWidth', 'waterlineOpacity'], out);

      out.waterTintEnabled = !!c.waterTintEnabled;
      if (c.waterTintEnabled) pickKeys(c, ['waterTintColor', 'waterTintOpacity', 'waterTintCoverage', 'waterTintBlendMode'], out);

      out.seaWavesEnabled = !!c.seaWavesEnabled;
      if (c.seaWavesEnabled) {
        pickKeys(c, [
          'seaWaveStyle', 'seaWaveScale', 'seaWaveSpacing', 'seaWaveUndulation',
          'seaWaveThickness', 'seaWaveRoughness', 'seaWaveOpacity', 'seaWaveColor',
          'seaWaveShoreFade', 'seaWaveBlendMode', 'seaWaveFillEnabled'
        ], out);
        if (c.seaWaveFillEnabled) pickKeys(c, ['seaWaveFillColor', 'seaWaveFillOpacity'], out);
      }

      out.opennessEnabled = !!c.opennessEnabled;
      if (c.opennessEnabled) pickKeys(c, ['opennessRadius', 'opennessStrength', 'opennessDiff'], out);

      out.bounceEnabled = !!c.bounceEnabled;
      if (c.bounceEnabled) out.bounceStrength = c.bounceStrength;

      out.contactShadowsEnabled = !!c.contactShadowsEnabled;
      if (c.contactShadowsEnabled) out.penumbraScale = c.penumbraScale;

      out.ditherEnabled = !!c.ditherEnabled;
      if (c.ditherEnabled) {
        pickKeys(c, [
          'ditherType', 'ditherBlendMode', 'ditherScale', 'ditherDensity',
          'ditherThreshold', 'ditherLowCut', 'ditherSoftness', 'ditherZone',
          'ditherStrength', 'ditherColor'
        ], out);
        if (c.ditherType !== 'blue') out.ditherAngle = c.ditherAngle;
      }

      out.mdowEnabled = !!c.mdowEnabled;
      if (c.mdowEnabled && c.mdowStrength !== undefined) out.mdowStrength = c.mdowStrength;

      out.hachureEnabled = !!c.hachureEnabled;
      if (c.hachureEnabled) {
        pickKeys(c, [
          'hachureType', 'hachureBlendMode', 'hachureDensity', 'hachureLength',
          'hachureThinning', 'hachureOpacity', 'hachureSlope', 'hachureColor',
          'hachureLightMod'
        ], out);
        if (c.hachureType === 'hybrid') pickKeys(c, ['hachureHybridThresh', 'hachureHybridSharpness'], out);
      }

      out.ambientOcclusion = !!c.ambientOcclusion;
      if (c.ambientOcclusion) pickKeys(c, ['aoStrength', 'aoRadius', 'aoSlopeBleed'], out);

      out.svfEnabled = !!c.svfEnabled;
      if (c.svfEnabled) out.svfStrength = c.svfStrength;

      out.castShadows = !!c.castShadows;
      if (c.castShadows) pickKeys(c, ['shadowReach', 'shadowOpacity'], out);

      out.outlineEnabled = !!c.outlineEnabled;
      if (c.outlineEnabled) {
        pickKeys(c, [
          'outlineType', 'outlineBlendMode', 'outlineColor', 'outlineWidth',
          'outlineRoughness', 'outlineTexture', 'outlineDensity', 'outlineThreshold',
          'outlineOpacity', 'outlineLightMod'
        ], out);
      }

      if (c.debugValley) out.debugValley = true;
    }

    if (ctOn) {
      pickKeys(c, [
        'contourStep', 'contourBlendMode', 'contourOpacity', 'contourWidth',
        'contourStyle', 'contourSmoothing', 'contourRoughness', 'contourHandPressure',
        'cliffHairlines', 'showLabels', 'contourPalette'
      ], out);
      if (c.contourPalette === 'custom') pickKeys(c, ['contourColor', 'contourMajorColor'], out);

      out.taperWithElevation = !!c.taperWithElevation;
      if (c.taperWithElevation) pickKeys(c, ['taperDirection', 'taperStrength'], out);

      out.formLinesEnabled = !!c.formLinesEnabled;
      if (c.formLinesEnabled) out.formLinesSlopeMax = c.formLinesSlopeMax;

      if (c.contourStyle === 'tanaka') pickKeys(c, ['tanakaHighlightColor', 'tanakaShadowColor'], out);
    }

    return out;
  }

  function compactClouds(enabled, c) {
    if (!enabled) return { enabled: false };
    const cfgCopy = { ...(c || {}) };
    delete cfgCopy.enabled;

    if (!cfgCopy.terrain) {
      ['mountainDeflection', 'peakPiercing', 'cloudBase', 'cloudThickness', 'wakeSplit', 'orographicLift', 'foehnDissipation']
        .forEach(k => delete cfgCopy[k]);
    }
    if (!cfgCopy.innerAnim) {
      ['innerSpeed', 'innerWobble', 'innerWarp', 'hatchBoil', 'animFps']
        .forEach(k => delete cfgCopy[k]);
    }
    if (cfgCopy.windSource === 'auto') {
      delete cfgCopy.windDir;
      delete cfgCopy.windSpeed;
    }
    if ((cfgCopy.shadowOpacity || 0) <= 0) {
      delete cfgCopy.shadowHeight;
      delete cfgCopy.shadowBlur;
    }
    if ((cfgCopy.darkAmount || 0) <= 0 || (cfgCopy.darkCover || 0) <= 0) {
      delete cfgCopy.darkSoft;
      delete cfgCopy.darkScale;
    }
    if (!cfgCopy.cumulusMode) {
      delete cfgCopy.clusterIsolation;
      delete cfgCopy.smoothBlend;
      delete cfgCopy.sunBlendBoost;
    }

    return { enabled: true, config: cfgCopy };
  }

  function compactCanopy(s) {
    if (!s || (!s.heightEnabled && !s.maskEnabled && !s.treesEnabled)) {
      return { enabled: false };
    }
    const out = {
      heightEnabled: !!s.heightEnabled,
      maskEnabled: !!s.maskEnabled,
      treesEnabled: !!s.treesEnabled
    };
    if (s.heightEnabled) out.heightOpacity = s.heightOpacity;
    if (s.maskEnabled) {
      out.maskOpacity = s.maskOpacity;
      out.maskTint = s.maskTint;
    }
    if (s.heightEnabled || s.maskEnabled) out.blendMode = s.blendMode;

    if (s.treesEnabled) {
      pickKeys(s, [
        'treeStyle', 'treeDensity', 'treeScale', 'treeColor', 'treeStrokeColor',
        'treeOpacity', 'treeBlendMode', 'canopyFantasyForest', 'treeMinH',
        'forestOnlyThreshold', 'treeVolumetric', 'treePaperBleed', 'treeVariety',
        'treeTerrainLight', 'treeShadows', 'treeOpaqueFill', 'treeFillWarmth',
        'treeFillBrightness', 'treeFillSaturation', 'colorScatter',
        'treeNightTint', 'treeNightStrength', 'treeNightBrightness', 'treeNightContrast',
        'treeShadeOpacity', 'treeShadeDarkness', 'treeGroundShadowCustom',
        'treeContactShadowOpacity', 'treeMassifBaseDarkness', 'treeClustering',
        'treeClearRoads', 'treeAutoDense', 'treeSlopeSuppression'
      ], out);

      if (s.treeGroundShadowCustom) out.treeGroundShadowColor = s.treeGroundShadowColor;
      if (s.treeTerrainLight) out.treeTerrainShadows = s.treeTerrainShadows;
      if (s.treeShadows) out.treeShadowStrength = s.treeShadowStrength;
      if (s.treeClearRoads) {
        pickKeys(s, ['treeClearRoadsDist', 'treeClearRoadsOpacity', 'treeClearRoadsSoftness'], out);
      }
      if (s.treeAutoDense) {
        pickKeys(s, ['treeAutoDenseScale', 'treeAutoDenseThinning', 'treeEdgeScale', 'treeMassifScale'], out);
      }
      if (s.treeOpaqueFill && s.customColors) {
        out.customColors = true;
        pickKeys(s, ['decidColor1', 'decidColor2', 'coniferColor', 'decidRatio'], out);
      } else {
        out.customColors = false;
      }
      if ((s.treeSlopeSuppression || 0) > 0) out.treeSlopeTolerance = s.treeSlopeTolerance;
    }

    return { settings: out };
  }

  function compactVectorRoads(c) {
    if (!c || !c.enabled) return { enabled: false };

    const out = {
      enabled: true,
      blendMode: c.blendMode,
      opacity: c.opacity
    };

    const simpleBlocks = ['forest', 'farmland', 'cemeteries', 'piers', 'buildings', 'transport', 'pois'];
    simpleBlocks.forEach(k => {
      out[k] = (c[k] && c[k].enabled) ? { ...c[k] } : { enabled: false };
    });

    if (c.peaks && c.peaks.enabled) {
      out.peaks = { ...c.peaks };
      if (!c.peaks.showElevation) delete out.peaks.elePosition;
    } else {
      out.peaks = { enabled: false };
    }

    if (c.parks && c.parks.enabled) {
      out.parks = {
        enabled: true,
        borders: !!c.parks.borders
      };
      if (c.parks.borders) {
        pickKeys(c.parks, [
          'borderStyle', 'borderGlow', 'fillColor', 'fillOpacity',
          'fillPattern', 'strokeColor', 'strokeWidth', 'strokeOpacity'
        ], out.parks);
      }
      pickKeys(c.parks, ['labelColor', 'haloColor', 'size', 'opacity', 'labelStyle', 'letterSpacing', 'ornament', 'uppercase', 'bold', 'italic'], out.parks);
      if (c.parks.labelStyle === 'arch') out.parks.archCurve = c.parks.archCurve;
    } else {
      out.parks = { enabled: false };
    }

    if (c.roads) {
      out.roads = {};
      ['major', 'track'].forEach(rk => {
        if (c.roads[rk] && c.roads[rk].enabled) {
          out.roads[rk] = { ...c.roads[rk] };
          if (!c.roads[rk].casing) {
            delete out.roads[rk].casingColor;
            delete out.roads[rk].casingWidth;
          }
        } else {
          out.roads[rk] = { enabled: false };
        }
      });
      ['path', 'minor'].forEach(rk => {
        out.roads[rk] = (c.roads[rk] && c.roads[rk].enabled) ? { ...c.roads[rk] } : { enabled: false };
      });
    }

    if (c.railways) {
      const railOn = !!c.railways.enabled;
      const stOn = !!(c.railways.stations && c.railways.stations.enabled);
      out.railways = railOn
        ? {
            enabled: true,
            style: c.railways.style,
            color: c.railways.color,
            tieColor: c.railways.tieColor,
            width: c.railways.width,
            opacity: c.railways.opacity,
            minorEnabled: c.railways.minorEnabled
          }
        : { enabled: false };
      out.railways.stations = stOn ? { ...c.railways.stations } : { enabled: false };
    }

    if (c.water) {
      out.water = {};
      ['rivers', 'lakes', 'oceans', 'marshes'].forEach(wk => {
        out.water[wk] = (c.water[wk] && c.water[wk].enabled) ? { ...c.water[wk] } : { enabled: false };
      });
    }

    if (c.labels) {
      out.labels = {
        blendMode: c.labels.blendMode,
        opacity: c.labels.opacity
      };
      out.labels.banners = (c.labels.banners && c.labels.banners.enabled)
        ? { ...c.labels.banners }
        : { enabled: false };
      ['major', 'minor', 'localities', 'water'].forEach(lk => {
        out.labels[lk] = (c.labels[lk] && c.labels[lk].enabled) ? { ...c.labels[lk] } : { enabled: false };
      });
    }

    return out;
  }

  function compactTerrainOverlays(c) {
    if (!c) return { enabled: false };
    const keys = ['steep', 'camp', 'windShelter', 'solar', 'flood'];
    const anyEnabled = keys.some(k => c[k] && c[k].enabled);
    if (!anyEnabled) return { enabled: false };

    const out = {};
    keys.forEach(k => {
      if (!c[k] || !c[k].enabled) {
        out[k] = { enabled: false };
        return;
      }
      const copy = { ...c[k] };
      if (k === 'windShelter' && copy.windSource !== 'manual') {
        delete copy.windDir;
        delete copy.windSpeed;
      }
      if (k === 'solar' && copy.dateMode !== 'custom') {
        delete copy.dateStr;
      }
      out[k] = copy;
    });
    return out;
  }

  function compactViewshed(active, settings) {
    if (!active) return { active: false };
    return { active: true, settings: { ...(settings || {}) } };
  }

  // =========================================================================
  // МЕНЕДЖЕР ПРОФИЛЕЙ И ПРЕСЕТОВ
  // =========================================================================

  function compactTerrainDecor(c) {
    if (!c || !c.enabled) return { enabled: false };
    return { ...c };
  }
  const DemPresetManager = {
    CUSTOM_STORAGE_KEY: 'wm_custom_3d_presets',
    DEFAULT_PRESET_ID: 'profile_1795198313316_931',
    ACTIVE_PRESET_KEY: 'wm_active_3d_preset',

    getCustomPresets() {
      try {
        const raw = localStorage.getItem(this.CUSTOM_STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        return [];
      }
    },

    saveCustomPreset(presetObj) {
      const list = this.getCustomPresets();
      const idx = list.findIndex(p => p.id === presetObj.id);
      if (idx !== -1) list[idx] = presetObj;
      else list.push(presetObj);
      try {
        localStorage.setItem(this.CUSTOM_STORAGE_KEY, JSON.stringify(list));
      } catch (e) {}
    },

    getAllPresets() {
      const custom = this.getCustomPresets();
      const builtinIds = new Set(BUILTIN_3D_PRESETS.map(p => p.id));
      return [...BUILTIN_3D_PRESETS, ...custom.filter(p => !builtinIds.has(p.id))];
    },

    buildCurrentProfile(name) {
      const now = new Date();
      const profileName = (name && name.trim())
        ? name.trim()
        : `3D Профиль (${now.toLocaleDateString('ru')} ${now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })})`;

      return {
        id: 'profile_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: profileName,
        version: 2,
        createdAt: now.toISOString(),
        demRelief: (WM.demRelief && WM.demRelief.getConfig)
          ? compactDemRelief(WM.demRelief.getConfig())
          : { hillshadeEnabled: false, contoursEnabled: false },
        terrainDecor: (WM.terrainDecor && WM.terrainDecor.getConfig)
          ? compactTerrainDecor(WM.terrainDecor.getConfig())
          : { enabled: false },
        clouds: WM.clouds
          ? compactClouds(WM.clouds.isEnabled(), WM.clouds.getConfig())
          : { enabled: false },
        canopy: (WM.canopy && WM.canopy.getSettings)
          ? compactCanopy(WM.canopy.getSettings())
          : { enabled: false },
        vectorRoads: (WM.vectorRoads && WM.vectorRoads.getConfig)
          ? compactVectorRoads(WM.vectorRoads.getConfig())
          : { enabled: false },
        terrainOverlays: (WM.terrainOverlays && WM.terrainOverlays.getConfig)
          ? compactTerrainOverlays(WM.terrainOverlays.getConfig())
          : { enabled: false },
        viewshed: WM.viewshed
          ? compactViewshed(WM.viewshed.isActive(), WM.viewshed.getSettings ? WM.viewshed.getSettings() : {})
          : { active: false }
      };
    },

    applyProfile(profile, opts = {}) {
      if (!profile || typeof profile !== 'object') return false;
      try {
        if (profile.id) localStorage.setItem(this.ACTIVE_PRESET_KEY, profile.id);
      } catch (e) {}

      // 1. Рельеф и горизонтали (сброс к дефолтам + настройки пресета)
      if (WM.demRelief) {
        if (typeof WM.demRelief.applyProfile === 'function') {
          WM.demRelief.applyProfile(profile.demRelief || { hillshadeEnabled: false, contoursEnabled: false });
        } else if (profile.demRelief) {
          WM.demRelief.setConfig(profile.demRelief);
          if (typeof WM.demRelief.applyLayerVisibility === 'function') WM.demRelief.applyLayerVisibility();
        }
      }
      if (WM.terrainDecor && typeof WM.terrainDecor.applyProfile === 'function') {
        WM.terrainDecor.applyProfile(profile.terrainDecor || { enabled: false });
      }

      // 2. 3D-облака
      if (WM.clouds) {
        if (typeof WM.clouds.applyProfile === 'function') {
          WM.clouds.applyProfile(profile.clouds || { enabled: false });
        } else if (profile.clouds) {
          if (profile.clouds.config) WM.clouds.setConfig(profile.clouds.config);
          if (profile.clouds.enabled !== undefined) WM.clouds.setEnabled(profile.clouds.enabled);
        }
      }

      // 3. Лес и растительность
      if (WM.canopy && typeof WM.canopy.applyProfile === 'function') {
        WM.canopy.applyProfile(profile.canopy || { enabled: false });
      }

      // 4. Векторный слой OSM (дороги, вода, подписи, пики, парки)
      if (WM.vectorRoads && typeof WM.vectorRoads.applyProfile === 'function' && profile.vectorRoads !== undefined) {
        WM.vectorRoads.applyProfile(profile.vectorRoads);
      }

      // 5. Слои наложения и анализа (склоны, палатка, ветер, свет, паводок)
      if (WM.terrainOverlays && typeof WM.terrainOverlays.applyProfile === 'function') {
        WM.terrainOverlays.applyProfile(profile.terrainOverlays || { enabled: false });
      }

      // 6. Зона видимости (Viewshed)
      if (WM.viewshed) {
        const vs = profile.viewshed || { active: false };
        if (typeof WM.viewshed.applyProfile === 'function') {
          WM.viewshed.applyProfile(vs);
        } else {
          if (vs.settings) {
            if (vs.settings.radiusKm !== undefined && WM.viewshed.setRadiusKm) WM.viewshed.setRadiusKm(vs.settings.radiusKm);
            if (vs.settings.targetHeight !== undefined && WM.viewshed.setTargetHeight) WM.viewshed.setTargetHeight(vs.settings.targetHeight);
            if (vs.settings.eyeHeight !== undefined && WM.viewshed.setEyeHeight) WM.viewshed.setEyeHeight(vs.settings.eyeHeight);
            if (vs.settings.opacity !== undefined && WM.viewshed.setOpacity) WM.viewshed.setOpacity(vs.settings.opacity);
            if (vs.settings.color !== undefined && WM.viewshed.setColor) WM.viewshed.setColor(vs.settings.color);
            if (vs.settings.followCompass !== undefined && WM.viewshed.setFollowCompass) WM.viewshed.setFollowCompass(vs.settings.followCompass);
            if (vs.settings.originMode !== undefined && WM.viewshed.setOriginMode) WM.viewshed.setOriginMode(vs.settings.originMode);
          }
          if (typeof vs.active === 'boolean' && WM.viewshed.isActive && WM.viewshed.isActive() !== vs.active) {
            WM.viewshed.toggle();
          }
        }
      }

      try {
        if (profile.id) localStorage.setItem(this.ACTIVE_PRESET_KEY, profile.id);
      } catch (e) {}
      this.syncSelectUI(profile.id);


      if (WM.demRelief) {
        if (typeof WM.demRelief.renderHud === 'function') WM.demRelief.renderHud();
        if (typeof WM.demRelief.scheduleUpdate === 'function') WM.demRelief.scheduleUpdate(true);
      }
      if (window.syncLayersControlExtras) window.syncLayersControlExtras();
      if (window.syncDemSpoilerQuickToggles) window.syncDemSpoilerQuickToggles();

      if (!opts.silent && WM.ui && WM.ui.showToast) {
        WM.ui.showToast(`⭐ Применён пресет: «${profile.name}»`);
      }
      return true;
    },

    deleteCustomPreset(presetId) {
      const builtinIds = new Set(BUILTIN_3D_PRESETS.map(p => p.id));
      // Встроенные пресеты из кода удалить нельзя
      if (!presetId || builtinIds.has(presetId)) return false;

      const list = this.getCustomPresets().filter(p => p.id !== presetId);
      try {
        localStorage.setItem(this.CUSTOM_STORAGE_KEY, JSON.stringify(list));
      } catch (e) {}
      return true;
    },

    ensureDropdownStyles() {
      if (document.getElementById('wm-dem-preset-dd-style')) return;
      const st = document.createElement('style');
      st.id = 'wm-dem-preset-dd-style';
      st.textContent = `
        .dem-preset-dd {
          position: relative;
          width: 100%;
        }
        .dem-preset-trigger {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          text-align: left;
          cursor: pointer;
          font-size: 11.5px;
          font-weight: 600;
          padding-right: 10px;
        }
        .dem-preset-trigger-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .dem-preset-arrow {
          font-size: 12px;
          opacity: 0.75;
          flex-shrink: 0;
          transition: transform 0.15s ease;
        }
        .dem-preset-trigger[aria-expanded="true"] .dem-preset-arrow {
          transform: rotate(180deg);
        }
        .dem-preset-menu {
          position: absolute;
          left: 0;
          right: 0;
          top: calc(100% + 4px);
          z-index: 60;
          max-height: min(220px, 38vh);
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          background: var(--bg-primary, #131c2e);
          border: 1px solid var(--accent, #38bdf8);
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
          padding: 4px;
        }
        .dem-preset-item {
          display: flex;
          align-items: center;
          gap: 4px;
          border-radius: 6px;
          transition: background 0.12s ease;
        }
        .dem-preset-item:hover {
          background: rgba(56, 189, 248, 0.14);
        }
        .dem-preset-item.active {
          background: rgba(56, 189, 248, 0.24);
        }
        .dem-preset-item-btn {
          flex: 1;
          min-width: 0;
          background: none;
          border: none;
          color: var(--text-main, #f1f5f9);
          font-size: 11.5px;
          font-weight: 600;
          text-align: left;
          padding: 7px 8px;
          cursor: pointer;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dem-preset-item.active .dem-preset-item-btn {
          color: var(--accent, #38bdf8);
          font-weight: 700;
        }
        .dem-preset-del-btn {
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          margin-right: 3px;
          border: none;
          border-radius: 5px;
          background: transparent;
          color: var(--text-muted, #94a3b8);
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .dem-preset-del-btn:hover {
          background: rgba(239, 68, 68, 0.22);
          color: #ef4444;
        }
      `;
      document.head.appendChild(st);
    },

    initDropdownUI() {
      this.ensureDropdownStyles();
      const dd = document.getElementById('dem-hud-preset-dd');
      const trigger = document.getElementById('dem-hud-preset-trigger');
      const menu = document.getElementById('dem-hud-preset-menu');
      if (!dd || !trigger || !menu || dd._inited) return;
      dd._inited = true;

      const closeMenu = () => {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      };

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        menu.hidden = !willOpen;
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });

      menu.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

      document.addEventListener('click', (e) => {
        if (!menu.hidden && !dd.contains(e.target)) {
          closeMenu();
        }
      });
    },

    syncSelectUI(activePresetId) {
      this.initDropdownUI();

      const sel = document.getElementById('dem-hud-preset-select');
      const badge = document.getElementById('dem-hud-preset-badge');
      const trigger = document.getElementById('dem-hud-preset-trigger');
      const triggerText = document.getElementById('dem-hud-preset-trigger-text');
      const menu = document.getElementById('dem-hud-preset-menu');
      if (!sel) return;

      const builtinIds = new Set(BUILTIN_3D_PRESETS.map(p => p.id));
      const all = this.getAllPresets();

      if (activePresetId === undefined) {
        activePresetId = localStorage.getItem(this.ACTIVE_PRESET_KEY) || '';
      }

      const active = all.find(p => p.id === activePresetId);


      // 1. Синхронизация скрытого <select> (для совместимости)
      sel.innerHTML = '<option value="">(Пользовательские настройки)</option>';
      all.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const isCustom = !builtinIds.has(p.id);
        opt.textContent = p.name + (isCustom ? ' 📁' : '');
        if (active && p.id === active.id) opt.selected = true;
        sel.appendChild(opt);
      });

      // 2. Текст кнопки-триггера и бейдж
      if (triggerText) {
        triggerText.textContent = active
          ? active.name + (!builtinIds.has(active.id) ? ' 📁' : '')
          : '(Пользовательские настройки)';
      }
      if (badge) {
        badge.textContent = active ? active.name.split(' ')[0] : 'кастом';
        badge.classList.toggle('active', !!active);
      }

      // 3. Отрисовка кастомного скроллируемого меню с крестиками для своих пресетов
      if (!menu) return;
      menu.innerHTML = '';

      const choosePreset = (id) => {
        sel.value = id;
        menu.hidden = true;
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const addRow = (id, label, isCustom) => {
        const row = document.createElement('div');
        row.className = 'dem-preset-item' + ((active ? active.id === id : id === '') ? ' active' : '');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dem-preset-item-btn';
        btn.textContent = label;
        btn.title = label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          choosePreset(id);
        });
        row.appendChild(btn);

        if (isCustom) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'dem-preset-del-btn';
          del.textContent = '✕';
          del.title = 'Удалить сохранённый пресет';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            const cleanName = label.replace(/\s*📁$/, '');
            if (!confirm(`Удалить пресет «${cleanName}»?`)) return;

            if (this.deleteCustomPreset(id)) {
              const nextActiveId = (sel.value === id) ? '' : sel.value;
              sel.value = nextActiveId;
              this.syncSelectUI(nextActiveId);
              if (WM.ui && WM.ui.showToast) {
                WM.ui.showToast(`🗑️ Пресет «${cleanName}» удалён`);
              }
            }
          });
          row.appendChild(del);
        }

        menu.appendChild(row);
      };

      addRow('', '(Пользовательские настройки)', false);
      all.forEach((p) => {
        const isCustom = !builtinIds.has(p.id);
        addRow(p.id, p.name + (isCustom ? ' 📁' : ''), isCustom);
      });
    }
  };

  WM.demPresets = DemPresetManager;
})();