/**
 * js/treePresets.js — Каталог встроенных пресетов деревьев по умолчанию.
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};
  WM.defaultTreePresets = [
  {
    "name": "🌿 Берёза бородавчатая (Birch)",
    "trunk": {
      "rings": [
        {
          "x": 0,
          "y": 0,
          "z": 0,
          "r": 0.096
        },
        {
          "x": 0,
          "y": 0.32,
          "z": 0.01,
          "r": 0.07
        },
        {
          "x": 0,
          "y": 1.04,
          "z": 0,
          "r": 0.03
        }
      ],
      "bark": {
        "type": "birch",
        "scaleX": 1,
        "scaleY": 1,
        "density": 0.7,
        "baseDark": 0.32,
        "col2": "#2f2013",
        "colBase": "#000000"
      }
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1,
      "seasons": "early_spring_to_late_autumn",
      "deciduousWinter": true,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 98,
          "s": 77,
          "l": 27,
          "h2": 98,
          "s2": 71,
          "l2": 42
        },
        "spring": {
          "h": 105,
          "s": 70,
          "l": 26
        },
        "autumn": {
          "h": 0,
          "s": 87,
          "l": 35,
          "h2": 4,
          "s2": 100,
          "l2": 59
        },
        "lateAutumn": {
          "h": 47,
          "s": 90,
          "l": 32,
          "h2": 47,
          "s2": 84,
          "l2": 42
        },
        "winter": {
          "h": 160,
          "s": 35,
          "l": 24
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0.3,
        "urban": 0,
        "urbanDistM": 45
      }
    },
    "branches": [
      {
        "r": 0.032,
        "sides": 3,
        "nodes": [
          {
            "x": 0,
            "y": 0.45,
            "z": 0
          },
          {
            "x": 0,
            "y": 0.63,
            "z": 0.18
          },
          {
            "x": -0.05,
            "y": 0.49,
            "z": 0.24
          }
        ],
        "radial": 1,
        "taper": 0.43
      },
      {
        "r": 0.038,
        "sides": 3,
        "taper": 0.37,
        "nodes": [
          {
            "x": 0,
            "y": 0.64,
            "z": 0
          },
          {
            "x": -0.03,
            "y": 0.65,
            "z": -0.18
          },
          {
            "x": -0.07,
            "y": 0.54,
            "z": -0.24
          }
        ]
      }
    ],
    "foliage": [
      {
        "type": "blob",
        "y": 1.55,
        "rx": 0.43,
        "ry": 0.79,
        "rz": 0.41,
        "taper": 0.14,
        "lump": 0.3,
        "seg": 7,
        "rings": 7,
        "seed": 3.4,
        "sc": 1.06
      }
    ],
    "style": {
      "leaf": "#183711",
      "leaf2": "#4a751f",
      "leafGrad": "y",
      "wood": "#0e0b0b",
      "wood2": "#ffefe5",
      "branch": "#fff3eb",
      "branch2": "#422c1a"
    },
    "disabled": false,
    "stems": []
  },
  {
    "name": "🌳 Дуб мощный",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.228
        ],
        [
          0.01,
          0.26,
          0.01,
          0.276
        ],
        [
          -0.27,
          0.57,
          0.03,
          0.196
        ],
        [
          -0.36,
          0.91,
          -0.22,
          0.24
        ],
        [
          -0.25,
          1.2,
          0.03,
          0.095
        ]
      ],
      "bark": {
        "type": "fissured",
        "scaleX": 0.3,
        "scaleY": 0.5,
        "density": 1,
        "baseDark": 0.22,
        "col2": "#261508",
        "colBase": "#120f0c"
      },
      "seg": 4,
      "flare": 0.88,
      "flareH": 0.5,
      "rough": 0.6,
      "twist": -3.22
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1,
      "seasons": "spring_to_autumn",
      "deciduousWinter": true,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 97,
          "s": 71,
          "l": 27
        },
        "spring": {
          "h": 92,
          "s": 68,
          "l": 36,
          "h2": 92,
          "s2": 62,
          "l2": 46
        },
        "autumn": {
          "h": 13,
          "s": 72,
          "l": 37,
          "h2": 30,
          "s2": 100,
          "l2": 55
        },
        "lateAutumn": {
          "h": 45,
          "s": 70,
          "l": 25,
          "h2": 3,
          "s2": 100,
          "l2": 64
        },
        "winter": {
          "h": 148,
          "s": 50,
          "l": 30
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0,
        "urban": 0,
        "urbanDistM": 45
      }
    },
    "stems": [
      {
        "seg": 3,
        "smooth": 0,
        "radial": 1,
        "rings": [
          {
            "x": 0.12,
            "y": 0,
            "z": 0.04,
            "r": 0.182
          },
          {
            "x": 0.18,
            "y": 0.35,
            "z": 0.06,
            "r": 0.142
          },
          {
            "x": 0.35,
            "y": 0.62,
            "z": 0.17,
            "r": 0.084
          },
          {
            "y": 0.77,
            "r": 0.063,
            "x": 0.37,
            "z": 0.08
          }
        ],
        "bark": {
          "type": "fissured",
          "scaleX": 0.8,
          "scaleY": 1,
          "density": 0.7,
          "baseDark": 0.22,
          "col2": "#201b17",
          "colBase": "#120f0c"
        },
        "flareH": 0.03,
        "roots": 0,
        "rough": 0,
        "twist": -1.17
      }
    ],
    "foliage": [
      {
        "type": "blob",
        "x": -0.43,
        "y": 1.8,
        "sc": 2,
        "rx": 0.65,
        "ry": 0.41,
        "rz": 0.59,
        "taper": -0.8,
        "lump": 0.3,
        "seg": 5,
        "rings": 5,
        "seed": 4.3
      },
      {
        "type": "blob",
        "x": 0.6,
        "y": 0.89,
        "rotX": 0.08,
        "rotY": 0.1,
        "rotZ": -0.28,
        "sc": 0.78,
        "rx": 0.65,
        "ry": 0.41,
        "rz": 0.59,
        "taper": -0.8,
        "lump": 0.3,
        "seg": 5,
        "rings": 5,
        "seed": 4.9
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#21300d",
      "leaf2": "#5b8118",
      "leafGrad": "y"
    },
    "disabled": false
  },
  {
  "name": "🌾 Плакучая стилизованная ива (Арт справа вверху)",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 1,
    "seasons": "all",
    "deciduousWinter": true,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 150,
        "s": 57,
        "l": 27
      },
      "spring": {
        "h": 141,
        "s": 49,
        "l": 38
      },
      "autumn": {
        "h": 55,
        "s": 46,
        "l": 38
      },
      "lateAutumn": {
        "h": 45,
        "s": 70,
        "l": 25
      },
      "winter": {
        "h": 148,
        "s": 50,
        "l": 30
      }
    },
    "weights": {
      "nearWater": 0.95,
      "waterDistM": 110,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0.04,
        0,
        -0.01,
        0.324
      ],
      [
        0.04,
        0.18,
        0,
        0.194
      ],
      [
        0.02,
        0.56,
        -0.02,
        0.09
      ],
      [
        -0.01,
        1.22,
        0.01,
        0.052
      ]
    ],
    "seg": 3,
    "flareH": 0.03,
    "rough": 0.41,
    "twist": 1.63
  },
  "branches": [
    {
      "r": 0.032,
      "nodes": [
        [
          0.02,
          0.62,
          -0.02
        ],
        [
          -0.14,
          0.85,
          0.12
        ],
        [
          -0.13,
          1.15,
          0.2
        ]
      ]
    },
    {
      "r": 0.045,
      "nodes": [
        [
          0.01,
          0.42,
          0
        ],
        [
          0.23,
          0.56,
          0.13
        ],
        [
          0.1,
          0.8,
          0.05
        ]
      ]
    }
  ],
  "foliage": [
    {
      "type": "tier",
      "y": 1.61,
      "rotX": 0.05,
      "rotY": 0.2,
      "rotZ": -0.05,
      "sc": 1.54,
      "h": 0.47,
      "r": 1.17,
      "droop": 0.54,
      "curve": 0.54,
      "arch": 1.2,
      "tuck": 0.66,
      "lobes": 5,
      "scallop": 0.8,
      "seg": 12,
      "rings": 3
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#0e2a22",
    "leaf2": "#23583f",
    "leafGrad": "y"
  }
},
  {
  "name": "🌾 Ива 2",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 0.55,
    "seasons": "spring_to_autumn",
    "deciduousWinter": true,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 97,
        "s": 57,
        "l": 27
      },
      "spring": {
        "h": 141,
        "s": 49,
        "l": 38
      },
      "autumn": {
        "h": 55,
        "s": 46,
        "l": 38
      },
      "lateAutumn": {
        "h": 45,
        "s": 70,
        "l": 25
      },
      "winter": {
        "h": 148,
        "s": 50,
        "l": 30
      }
    },
    "weights": {
      "nearWater": 0.95,
      "waterDistM": 110,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0.04,
        0,
        -0.01,
        0.142
      ],
      [
        0.04,
        0.18,
        0,
        0.088
      ],
      [
        0.02,
        0.38,
        -0.02,
        0.09
      ],
      [
        -0.01,
        0.86,
        0.01,
        0.052
      ]
    ],
    "seg": 3,
    "flareH": 0.03,
    "rough": 0.41,
    "twist": 1.63
  },
  "branches": [
    {
      "r": 0.032,
      "nodes": [
        [
          0.02,
          0.28,
          -0.02
        ],
        [
          -0.14,
          0.47,
          0.12
        ],
        [
          -0.13,
          0.74,
          0.2
        ]
      ]
    }
  ],
  "foliage": [
    {
      "type": "fronds",
      "x": -0.07,
      "y": 1.8,
      "rotX": 0.06,
      "rotY": -0.16,
      "rotZ": -0.12,
      "sc": 2.16,
      "count": 9,
      "len": 0.77,
      "width": 0.13,
      "tilt": 1.74,
      "arch": 1.22,
      "segs": 2,
      "fold": 0,
      "jitter": 0.14,
      "seed": 4.5
    },
    {
      "type": "tier",
      "x": -0.08,
      "y": 1.42,
      "rotX": 0.28,
      "rotY": 0.06,
      "rotZ": -0.28,
      "sc": 1.66,
      "h": 0.37,
      "r": 0.55,
      "droop": 0.42,
      "curve": 0.8,
      "arch": 0.68,
      "tuck": 0.04,
      "lobes": 8,
      "scallop": 0.44,
      "jag": 0.66,
      "seg": 10,
      "rings": 3
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#056652",
    "leaf2": "#1d905b",
    "leafGrad": "y"
  }
},
  {
  "name": "🌲 Изогнутая сосна / Бонсай (Арт по центру)",
  "eco": {
    "kind": "conifer",
    "baseWeight": 1,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 143,
        "s": 58,
        "l": 14,
        "h2": 144,
        "s2": 64,
        "l2": 22
      },
      "spring": {
        "h": 154,
        "s": 68,
        "l": 16,
        "h2": 154,
        "s2": 63,
        "l2": 19
      },
      "autumn": {
        "h": 163,
        "s": 14,
        "l": 10,
        "h2": 146,
        "s2": 16,
        "l2": 20
      },
      "lateAutumn": {
        "h": 156,
        "s": 10,
        "l": 10,
        "h2": 160,
        "s2": 5,
        "l2": 12
      },
      "winter": {
        "h": 150,
        "s": 16,
        "l": 37,
        "h2": 149,
        "s2": 43,
        "l2": 18
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0.9,
      "slopeThresholdDeg": 13,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.204
      ],
      [
        -0.06,
        0.24,
        0,
        0.11
      ],
      [
        -0.14,
        0.58,
        0.04,
        0.084
      ],
      [
        0.04,
        0.71,
        0.08,
        0.06
      ],
      [
        0.21,
        1.1,
        0.06,
        0.04
      ],
      [
        0.02,
        1.38,
        0,
        0.025
      ]
    ],
    "seg": 6,
    "twist": -7.37
  },
  "branches": [
    {
      "r": 0.034,
      "sides": 3,
      "taper": 0.27,
      "nodes": [
        [
          -0.04,
          0.65,
          0.06
        ],
        [
          -0.28,
          0.87,
          0.12
        ],
        [
          -0.26,
          1.04,
          0.16
        ]
      ]
    },
    {
      "r": 0.01,
      "sides": 3,
      "taper": 0.37,
      "nodes": [
        [
          0.27,
          0.74,
          0.18
        ],
        [
          0.47,
          0.86,
          0.15
        ]
      ]
    },
    {
      "r": 0.03,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [
          -0.14,
          0.33,
          0.04
        ],
        [
          -0.31,
          0.39,
          -0.04
        ],
        [
          -0.39,
          0.47,
          -0.18
        ]
      ]
    }
  ],
  "foliage": [
    {
      "type": "blob",
      "x": -0.28,
      "y": 1.13,
      "z": 0.18,
      "rotX": 0.1,
      "rotY": 0.4,
      "rotZ": 0.15,
      "sc": 0.96,
      "rx": 0.46,
      "ry": 0.16,
      "rz": 0.42,
      "taper": -0.8,
      "lump": 0.25,
      "seg": 5,
      "rings": 3,
      "seed": 1.2
    },
    {
      "type": "blob",
      "x": 0.26,
      "y": 0.81,
      "z": 0.13,
      "rotX": -0.1,
      "rotY": 1.1,
      "rotZ": -0.15,
      "sc": 1.42,
      "rx": 0.33,
      "ry": 0.13,
      "rz": 0.38,
      "taper": -0.8,
      "lump": 0.12,
      "seg": 5,
      "rings": 3,
      "seed": 2.8
    },
    {
      "type": "blob",
      "x": 0.02,
      "y": 1.5,
      "rotX": 0.05,
      "rotZ": 0.05,
      "sc": 0.88,
      "rx": 0.54,
      "ry": 0.2,
      "rz": 0.5,
      "taper": -0.8,
      "lump": 0.1,
      "seg": 5,
      "rings": 3,
      "seed": 4.5
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#113224",
    "leaf2": "#0c2217",
    "leafGrad": "y"
  }
},
  {
  "name": "🌲 Прямая сосна",
  "eco": {
    "kind": "conifer",
    "baseWeight": 1,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 144,
        "s": 61,
        "l": 15,
        "h2": 144,
        "s2": 52,
        "l2": 17
      },
      "spring": {
        "h": 154,
        "s": 67,
        "l": 18,
        "h2": 154,
        "s2": 73,
        "l2": 13
      },
      "autumn": {
        "h": 110,
        "s": 11,
        "l": 11,
        "h2": 160,
        "s2": 14,
        "l2": 25
      },
      "lateAutumn": {
        "h": 96,
        "s": 10,
        "l": 10,
        "h2": 160,
        "s2": 15,
        "l2": 16
      },
      "winter": {
        "h": 146,
        "s": 16,
        "l": 28,
        "h2": 147,
        "s2": 36,
        "l2": 19
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.086
      ],
      [
        -0.01,
        0.48,
        0,
        0.054
      ],
      [
        -0.01,
        1.6,
        0,
        0.046
      ]
    ],
    "seg": 3,
    "twist": -12.57
  },
  "foliage": [
    {
      "type": "blob",
      "y": 1.74,
      "sc": 0.54,
      "rx": 0.51,
      "ry": 0.67,
      "rz": 0.55,
      "taper": -0.8,
      "lump": 0.14,
      "seg": 5,
      "rings": 4,
      "seed": 1
    },
    {
      "type": "blob",
      "x": 0.17,
      "y": 1.2,
      "z": 0.18,
      "rotX": -0.16,
      "sc": 0.38,
      "rx": 0.55,
      "ry": 0.67,
      "taper": -0.8,
      "lump": 0.21,
      "seg": 5,
      "rings": 4,
      "seed": 2.7
    },
    {
      "type": "blob",
      "x": -0.17,
      "y": 1.03,
      "z": -0.14,
      "sc": 0.38,
      "rx": 0.55,
      "ry": 0.67,
      "taper": -0.8,
      "lump": 0.26,
      "seg": 5,
      "rings": 4,
      "seed": 2.2
    },
    {
      "type": "blob",
      "x": -0.17,
      "y": 1.27,
      "z": 0.2,
      "rotZ": 0.18,
      "sc": 0.28,
      "rx": 0.55,
      "ry": 0.67,
      "taper": -0.8,
      "lump": 0.23,
      "seg": 5,
      "rings": 4,
      "seed": 6.1
    },
    {
      "type": "blob",
      "x": 0.19,
      "y": 0.82,
      "z": -0.16,
      "rotZ": 0.18,
      "sc": 0.28,
      "rx": 0.55,
      "ry": 0.67,
      "taper": -0.8,
      "lump": 0.1,
      "seg": 5,
      "rings": 4,
      "seed": 7.8
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#091608",
    "leaf2": "#091b0d",
    "leafGrad": "y"
  }
},
  {
    "name": "🌲 Кипарис пирамидальный",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.06
        ],
        [
          0,
          0.39,
          0,
          0.015
        ]
      ],
      "seg": 3,
      "twist": -1.77
    },
    "eco": {
      "kind": "conifer",
      "baseWeight": 1,
      "seasons": "all",
      "deciduousWinter": false,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 82,
          "s": 70,
          "l": 33,
          "h2": 82,
          "s2": 57,
          "l2": 36
        },
        "spring": {
          "h": 105,
          "s": 70,
          "l": 38
        },
        "autumn": {
          "h": 84,
          "s": 56,
          "l": 44,
          "h2": 82,
          "s2": 68,
          "l2": 64
        },
        "lateAutumn": {
          "h": 98,
          "s": 31,
          "l": 30,
          "h2": 98,
          "s2": 34,
          "l2": 31
        },
        "winter": {
          "h": 148,
          "s": 39,
          "l": 30
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0,
        "urban": 0.7,
        "urbanDistM": 150
      }
    },
    "foliage": [
      {
        "type": "blob",
        "x": 0.01,
        "y": 0.62,
        "rx": 0.17,
        "ry": 0.55,
        "taper": -0.8,
        "lump": 0.15,
        "seg": 5,
        "rings": 6
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#2d6e1e",
      "leaf2": "#57842a",
      "leafGrad": "y"
    },
    "disabled": false
  },
  {
  "name": "🌿 Берёза бородавчатая (Birch)",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 1,
    "seasons": "spring_to_autumn",
    "deciduousWinter": true,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 98,
        "s": 84,
        "l": 35,
        "h2": 98,
        "s2": 74,
        "l2": 41
      },
      "spring": {
        "h": 105,
        "s": 74,
        "l": 26
      },
      "autumn": {
        "h": 9,
        "s": 88,
        "l": 50,
        "h2": 7,
        "s2": 65,
        "l2": 37
      },
      "lateAutumn": {
        "h": 47,
        "s": 90,
        "l": 32
      },
      "winter": {
        "h": 160,
        "s": 35,
        "l": 24
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0.3,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.065
      ],
      [
        0,
        0.32,
        0.01,
        0.045
      ],
      [
        0,
        1.04,
        0,
        0.03
      ]
    ],
    "bark": {
      "type": "birch",
      "scaleX": 1,
      "scaleY": 1,
      "density": 0.7,
      "baseDark": 0.32,
      "col2": "#2f2013",
      "colBase": "#000000"
    }
  },
  "branches": [
    {
      "r": 0.016,
      "sides": 3,
      "nodes": [
        [
          0,
          0.45,
          0
        ],
        [
          0,
          0.63,
          0.18
        ],
        [
          -0.05,
          0.49,
          0.24
        ]
      ]
    },
    {
      "r": 0.016,
      "sides": 3,
      "taper": 0.37,
      "nodes": [
        [
          0,
          0.64,
          0
        ],
        [
          -0.03,
          0.57,
          -0.18
        ],
        [
          -0.07,
          0.42,
          -0.24
        ]
      ]
    }
  ],
  "foliage": [
    {
      "type": "blob",
      "y": 1.34,
      "sc": 1.2,
      "rx": 0.43,
      "ry": 0.61,
      "rz": 0.41,
      "taper": 0.14,
      "lump": 0.3,
      "seg": 7,
      "rings": 7,
      "seed": 3.4
    }
  ],
  "style": {
    "wood": "#0e0b0b",
    "wood2": "#ffefe5",
    "branch": "#fff3eb",
    "branch2": "#422c1a",
    "leaf": "#183711",
    "leaf2": "#385a16",
    "leafGrad": "y"
  }
},
  {
 "name": "🌿 Берёза 2",
 "eco": {
  "kind": "deciduous",
  "baseWeight": 0.5,
  "seasons": "spring_to_autumn",
  "deciduousWinter": true,
  "colorShift": {
   "enabled": true,
   "earlySpring": {
    "h": 98,
    "s": 77,
    "l": 33,
    "h2": 98,
    "s2": 79,
    "l2": 26
   },
   "spring": {
    "h": 105,
    "s": 78,
    "l": 21,
    "h2": 83,
    "s2": 64,
    "l2": 48
   },
   "autumn": {
    "h": 38,
    "s": 88,
    "l": 50
   },
   "lateAutumn": {
    "h": 47,
    "s": 90,
    "l": 32,
    "h2": 47,
    "s2": 84,
    "l2": 42
   },
   "winter": {
    "h": 160,
    "s": 35,
    "l": 24
   }
  },
  "weights": {
   "nearWater": 0,
   "waterDistM": 35,
   "steepSlope": 0,
   "slopeThresholdDeg": 28,
   "shadeLove": 0,
   "sunLove": 0.4,
   "urban": 0,
   "urbanDistM": 45
  }
 },
 "trunk": {
  "rings": [
   {
    "x": 0,
    "y": 0,
    "z": 0,
    "r": 0.065
   },
   {
    "x": 0.12,
    "y": 0.29,
    "z": 0.01,
    "r": 0.026
   },
   {
    "x": 0.21,
    "y": 1.04,
    "z": 0,
    "r": 0.03
   }
  ],
  "bark": {
   "type": "birch",
   "scaleX": 1,
   "scaleY": 1,
   "density": 0.7,
   "baseDark": 0.32,
   "col2": "#2f2013",
   "colBase": "#000000"
  }
 },
 "stems": [
  {
   "seg": 6,
   "smooth": 1,
   "radial": 1,
   "rings": [
    {
     "x": -0.12,
     "y": 0,
     "z": -0.04,
     "r": 0.068
    },
    {
     "x": -0.12,
     "y": 0.35,
     "z": 0.06,
     "r": 0.052
    },
    {
     "x": -0.29,
     "y": 0.62,
     "z": 0.08,
     "r": 0.042
    },
    {
     "y": 0.91,
     "r": 0.0225,
     "x": -0.32,
     "z": 0.08
    }
   ],
   "bark": {
    "type": "none",
    "scaleX": 1,
    "scaleY": 1,
    "density": 0.7,
    "baseDark": 0.22,
    "col2": "#201b17",
    "colBase": "#120f0c"
   }
  }
 ],
 "foliage": [
  {
   "type": "blob",
   "x": 0.22,
   "y": 1.12,
   "rotZ": -0.36,
   "sc": 0.94,
   "rx": 0.43,
   "ry": 0.61,
   "rz": 0.41,
   "taper": 0.14,
   "lump": 0.3,
   "seg": 7,
   "rings": 7,
   "seed": 3.4
  },
  {
   "type": "blob",
   "x": -0.5,
   "y": 1.51,
   "rotZ": 0.06,
   "sc": 1.06,
   "rx": 0.43,
   "ry": 0.73,
   "rz": 0.41,
   "taper": 0.14,
   "lump": 0.3,
   "seg": 7,
   "rings": 7,
   "seed": 5.1
  }
 ],
 "style": {
  "leaf": "#1a4012",
  "leaf2": "#365615",
  "leafGrad": "y",
  "wood": "#0e0b0b",
  "wood2": "#ffefe5",
  "branch": "#fff3eb",
  "branch2": "#422c1a"
 },
 "disabled": false,
 "branches": []
},
  {
  "name": "Ель стройная",
  "eco": {
    "kind": "conifer",
    "baseWeight": 1,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 99,
        "s": 74,
        "l": 9,
        "h2": 98,
        "s2": 78,
        "l2": 9
      },
      "spring": {
        "h": 134,
        "s": 57,
        "l": 10,
        "h2": 135,
        "s2": 63,
        "l2": 17
      },
      "autumn": {
        "h": 120,
        "s": 17,
        "l": 18,
        "h2": 117,
        "s2": 12,
        "l2": 35
      },
      "lateAutumn": {
        "h": 159,
        "s": 25,
        "l": 11,
        "h2": 157,
        "s2": 28,
        "l2": 18
      },
      "winter": {
        "h": 159,
        "s": 24,
        "l": 16,
        "h2": 161,
        "s2": 35,
        "l2": 9
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0.5,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.186
      ],
      [
        0,
        0.68,
        0,
        0.09
      ]
    ],
    "seg": 3
  },
  "foliage": [
    {
      "type": "tier",
      "y": 0.9,
      "rotY": 0.48,
      "sc": 1.1,
      "h": 0.27,
      "r": 0.89,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    },
    {
      "type": "tier",
      "y": 1.19,
      "sc": 1.08,
      "h": 0.21,
      "r": 0.81,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    },
    {
      "type": "tier",
      "y": 1.5,
      "rotX": -0.16,
      "rotY": -0.58,
      "rotZ": 0.16,
      "sc": 1.22,
      "h": 0.25,
      "r": 0.61,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    },
    {
      "type": "tier",
      "y": 1.8,
      "rotX": -0.1,
      "rotY": -0.1,
      "sc": 0.94,
      "h": 0.19,
      "r": 0.43,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    },
    {
      "type": "tier",
      "y": 2,
      "rotY": -0.8,
      "sc": 0.64,
      "h": 0.33,
      "r": 0.43,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    },
    {
      "type": "tier",
      "y": 0.65,
      "rotX": 0.16,
      "rotY": -0.38,
      "rotZ": -0.02,
      "sc": 1.1,
      "h": 0.27,
      "r": 0.89,
      "droop": 0.35,
      "curve": 0.25,
      "arch": 0.2,
      "tuck": 0.3,
      "lobes": 9,
      "scallop": 0.35,
      "jag": 0.3,
      "seg": 8,
      "rings": 2
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#0e2f23",
    "leaf2": "#06230b",
    "leafGrad": "y"
  }
},
  {
  "name": "Ель 2",
  "eco": {
    "kind": "conifer",
    "baseWeight": 0.6,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 129,
        "s": 61,
        "l": 15,
        "h2": 127,
        "s2": 66,
        "l2": 8
      },
      "spring": {
        "h": 100,
        "s": 66,
        "l": 8,
        "h2": 100,
        "s2": 63,
        "l2": 16
      },
      "autumn": {
        "h": 126,
        "s": 44,
        "l": 14,
        "h2": 91,
        "s2": 26,
        "l2": 33
      },
      "lateAutumn": {
        "h": 165,
        "s": 11,
        "l": 7,
        "h2": 164,
        "s2": 14,
        "l2": 21
      },
      "winter": {
        "h": 159,
        "s": 19,
        "l": 14,
        "h2": 158,
        "s2": 14,
        "l2": 11
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0.7,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.178
      ],
      [
        0,
        0.94,
        0,
        0.108
      ]
    ]
  },
  "foliage": [
    {
      "type": "tier",
      "y": 0.68,
      "sc": 0.94,
      "h": 0.93,
      "r": 0.84,
      "jag": 0.78
    },
    {
      "type": "tier",
      "y": 1.05,
      "rotY": 0.5,
      "sc": 1.08,
      "h": 0.77,
      "r": 0.72,
      "jag": 0.78
    },
    {
      "type": "tier",
      "y": 1.28,
      "rotY": 1,
      "sc": 1.1,
      "h": 0.57,
      "r": 0.58,
      "jag": 0.78
    },
    {
      "type": "tier",
      "y": 1.53,
      "rotY": 1.5,
      "sc": 1.3,
      "h": 0.41,
      "r": 0.44,
      "jag": 0.78
    },
    {
      "type": "tier",
      "y": 1.8,
      "rotY": 2,
      "sc": 1.18,
      "h": 0.3,
      "r": 0.3,
      "jag": 0.78
    },
    {
      "type": "tier",
      "y": 2.01,
      "rotY": 2.5,
      "sc": 1.24,
      "h": 0.37,
      "r": 0.16,
      "jag": 0.78
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#0a3e25",
    "leaf2": "#071d11",
    "leafGrad": "y"
  }
},
  {
  "name": "Ель 3",
  "eco": {
    "kind": "conifer",
    "baseWeight": 0.4,
    "seasons": "all",
    "deciduousWinter": true,
    "colorShift": {
      "enabled": true,
      "earlySpring": {
        "h": 104,
        "s": 47,
        "l": 45
      },
      "spring": {
        "h": 100,
        "s": 84,
        "l": 31,
        "h2": 100,
        "s2": 73,
        "l2": 22
      },
      "autumn": {
        "h": 136,
        "s": 17,
        "l": 17,
        "h2": 92,
        "s2": 14,
        "l2": 24
      },
      "lateAutumn": {
        "h": 39,
        "s": 53,
        "l": 35,
        "h2": 39,
        "s2": 83,
        "l2": 59
      },
      "winter": {
        "h": 160,
        "s": 35,
        "l": 24
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0.5,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.164
      ],
      [
        0,
        0.48,
        0,
        0.07
      ]
    ]
  },
  "foliage": [
    {
      "type": "lathe",
      "y": 0.97,
      "sc": 1.92,
      "profile": [
        [
          0,
          -0.17
        ],
        [
          0.55,
          -0.25
        ],
        [
          0.12,
          0.01
        ],
        [
          0.47,
          -0.01
        ],
        [
          0.13,
          0.25
        ],
        [
          0.3,
          0.27
        ],
        [
          0.06,
          0.51
        ],
        [
          0.19,
          0.51
        ],
        [
          0,
          0.78
        ]
      ],
      "seg": 7,
      "lump": 0.3,
      "lobes": 8,
      "scallop": 0.54,
      "seed": 1.8,
      "capBottom": true,
      "capTop": true
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#184e30",
    "leaf2": "#0a241a",
    "leafGrad": "y"
  }
},
  {
    "name": "Клён остролистный",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.1
        ],
        [
          -0.07,
          0.25,
          0,
          0.074
        ],
        [
          0.04,
          0.52,
          0,
          0.04
        ]
      ],
      "seg": 3
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1.4,
      "seasons": "spring_to_autumn",
      "deciduousWinter": true,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 85,
          "s": 60,
          "l": 45,
          "h2": 85,
          "s2": 61,
          "l2": 41
        },
        "spring": {
          "h": 100,
          "s": 70,
          "l": 38
        },
        "autumn": {
          "h": 15,
          "s": 100,
          "l": 42
        },
        "lateAutumn": {
          "h": 22,
          "s": 75,
          "l": 35,
          "h2": 22,
          "s2": 69,
          "l2": 45
        },
        "winter": {
          "h": 160,
          "s": 35,
          "l": 24
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0,
        "urban": 0,
        "urbanDistM": 45
      }
    },
    "foliage": [
      {
        "type": "blob",
        "y": 1.16,
        "rx": 0.56,
        "ry": 0.77,
        "lump": 0.3,
        "seg": 5,
        "rings": 4
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#304413",
      "leaf2": "#88a636",
      "leafGrad": "y"
    },
    "disabled": false
  },
  {
    "name": "Кустарник подлеска",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.035
        ],
        [
          0,
          0.2,
          0,
          0.018
        ]
      ],
      "seg": 3,
      "flareH": 0.03,
      "twist": -12.57
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1.3,
      "seasons": "early_spring_to_late_autumn",
      "deciduousWinter": true,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 85,
          "s": 60,
          "l": 45
        },
        "spring": {
          "h": 100,
          "s": 70,
          "l": 38
        },
        "autumn": {
          "h": 22,
          "s": 85,
          "l": 44
        },
        "lateAutumn": {
          "h": 25,
          "s": 75,
          "l": 35
        },
        "winter": {
          "h": 160,
          "s": 35,
          "l": 24
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0,
        "urban": 0,
        "urbanDistM": 45
      }
    },
    "foliage": [
      {
        "type": "cluster",
        "y": 0.13,
        "rotX": 0.3,
        "rotY": 2.46,
        "rotZ": -0.54,
        "count": 6,
        "rx": 0.19,
        "ry": 0.19,
        "rz": 0.29,
        "smin": 0.04,
        "smax": 0.17,
        "puffY": 0.7,
        "lump": 0.21,
        "seg": 5,
        "rings": 3,
        "seed": 6
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#1e4e13",
      "leaf2": "#456b1e",
      "leafGrad": "y",
      "flatTrunk": true
    },
    "disabled": false
  },
  {
    "name": "Кустарник подлеска 2",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.016
        ],
        [
          0,
          0,
          0,
          0.018
        ]
      ],
      "flareH": 0.03,
      "twist": -12.57
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1.45,
      "seasons": "early_spring_to_late_autumn",
      "deciduousWinter": true,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 85,
          "s": 60,
          "l": 45
        },
        "spring": {
          "h": 100,
          "s": 70,
          "l": 38
        },
        "autumn": {
          "h": 47,
          "s": 85,
          "l": 44
        },
        "lateAutumn": {
          "h": 25,
          "s": 75,
          "l": 35
        },
        "winter": {
          "h": 160,
          "s": 35,
          "l": 24
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0.25,
        "sunLove": 0,
        "urban": 0,
        "urbanDistM": 45
      }
    },
    "foliage": [
      {
        "type": "fronds",
        "sc": 0.005,
        "count": 5,
        "len": 0.41,
        "width": 0.13,
        "tilt": 0.26,
        "arch": 1.54,
        "segs": 2,
        "fold": 0,
        "jitter": 0.25,
        "seed": 1
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#1f4c15",
      "leaf2": "#5c9027",
      "leafGrad": "y",
      "flatTrunk": true
    },
    "disabled": false
  },
  {
  "name": "Пень",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 0.35,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": {
        "h": 85,
        "s": 60,
        "l": 45
      },
      "spring": {
        "h": 100,
        "s": 70,
        "l": 38
      },
      "autumn": {
        "h": 22,
        "s": 85,
        "l": 44
      },
      "lateAutumn": {
        "h": 25,
        "s": 75,
        "l": 35
      },
      "winter": {
        "h": 160,
        "s": 35,
        "l": 24
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.06
      ],
      [
        0,
        0.11,
        0,
        0.05
      ]
    ],
    "seg": 8,
    "smooth": 1,
    "flare": 1.16,
    "flareH": 0.08,
    "roots": 4,
    "rough": 0.14,
    "twist": -0.47
  },
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#1c4413",
    "leaf2": "#5c8f28",
    "leafGrad": "y",
    "flatTrunk": true
  }
},
  {
  "name": "Сухостой 2",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 0.95,
    "seasons": "winter_only",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": { "h": 85, "s": 60, "l": 45 },
      "spring": { "h": 100, "s": 70, "l": 38 },
      "autumn": { "h": 38, "s": 85, "l": 48 },
      "lateAutumn": { "h": 22, "s": 75, "l": 35 },
      "winter": { "h": 160, "s": 35, "l": 24 }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [0, 0, 0, 0.2175],
      [-0.0795, 0.81, -0.036, 0.1545],
      [-0.165, 1.275, -0.0825, 0.1035],
      [-0.2775, 1.785, -0.255, 0.0555],
      [-0.345, 2.4, -0.2385, 0.0105]
    ],
    "seg": 3,
    "flare": 1.2,
    "flareH": 0.18,
    "roots": 5,
    "rough": 0.19
  },
  "branches": [
    {
      "r": 0.0765,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0735, 0.93, -0.033],
        [0.423, 1.515, 0.045]
      ]
    },
    {
      "r": 0.015,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.423, 1.53, 0.045],
        [0.708, 1.485, 0.2805]
      ]
    },
    {
      "r": 0.0645,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1125, 0.6225, -0.054],
        [-0.609, 1.3305, 0.057]
      ]
    },
    {
      "r": 0.0135,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.609, 1.3305, 0.057],
        [-0.42, 1.6785, 0.3255]
      ]
    },
    {
      "r": 0.054,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1515, 0.831, -0.075],
        [-0.12, 1.3995, -0.5925]
      ]
    },
    {
      "r": 0.0105,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.12, 1.3995, -0.5925],
        [-0.03, 1.6545, -0.8985]
      ]
    },
    {
      "r": 0.0105,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.12, 1.3995, -0.5925],
        [-0.3615, 1.716, -0.486]
      ]
    },
    {
      "r": 0.042,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1995, 1.041, -0.114],
        [-0.0885, 1.563, 0.2835]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0885, 1.563, 0.2835],
        [0.1335, 1.914, 0.1365]
      ]
    },
    {
      "r": 0.0315,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.252, 1.2495, -0.159],
        [-0.585, 1.845, -0.228]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.585, 1.845, -0.228],
        [-0.4995, 2.1435, -0.0075]
      ]
    },
    {
      "r": 0.021,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.294, 1.458, -0.195],
        [0.1875, 1.8975, -0.2925]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.1875, 1.8975, -0.2925],
        [0.4275, 2.1975, -0.0795]
      ]
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#2d6e1e",
    "leaf2": "#61942e",
    "leafGrad": "y"
  }
},
 {
  "name": "Сухостой круглогодичный",
  "eco": {
    "kind": "deciduous",
    "baseWeight": 0.15,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": { "h": 85, "s": 60, "l": 45 },
      "spring": { "h": 100, "s": 70, "l": 38 },
      "autumn": { "h": 38, "s": 85, "l": 48 },
      "lateAutumn": { "h": 22, "s": 75, "l": 35 },
      "winter": { "h": 160, "s": 35, "l": 24 }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [0, 0, 0, 0.1875],
      [-0.0825, 0.5655, -0.0165, 0.063],
      [-0.045, 1.1295, -0.0495, 0.0615],
      [-0.33, 1.725, -0.12, 0.009]
    ],
    "seg": 3,
    "smooth": 1,
    "flare": 0.96,
    "flareH": 0.18,
    "roots": 5,
    "rough": 0.19
  },
  "branches": [
    {
      "r": 0.054,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [-0.057, 0.39, -0.012],
        [0.09, 0.5205, 0.0075],
        [0.219, 0.6705, 0],
        [0.327, 0.8175, -0.0765],
        [0.4545, 0.942, -0.162]
      ]
    },
    {
      "r": 0.051,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [-0.0945, 0.636, -0.021],
        [-0.255, 0.6915, 0.036],
        [-0.405, 0.7905, 0.054],
        [-0.5505, 0.882, 0.1035],
        [-0.654, 1.0305, 0.1065]
      ]
    },
    {
      "r": 0.012,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.255, 0.6915, 0.036],
        [-0.525, 0.975, -0.075]
      ]
    },
    {
      "r": 0.012,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.5505, 0.882, 0.1035],
        [-0.507, 0.9585, 0.159]
      ]
    },
    {
      "r": 0.048,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [-0.06, 0.882, -0.0345],
        [-0.0405, 0.936, -0.1695],
        [0.066, 1.0365, -0.264],
        [0.186, 1.1355, -0.339],
        [0.291, 1.2495, -0.4185]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0405, 0.936, -0.1695],
        [-0.27, 1.155, -0.273]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.186, 1.1355, -0.339],
        [0.075, 1.425, -0.39]
      ]
    },
    {
      "r": 0.0345,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [-0.075, 1.14, -0.075],
        [0.09, 1.263, 0.0585],
        [-0.1335, 1.4355, 0.102],
        [-0.1485, 1.593, 0.1815],
        [-0.0975, 1.761, 0.207]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1485, 1.593, 0.1815],
        [0.09, 1.74, 0.195]
      ]
    },
    {
      "r": 0.0225,
      "sides": 3,
      "taper": 0.05,
      "nodes": [
        [-0.105, 1.29, -0.075],
        [-0.327, 1.425, -0.1965],
        [-0.414, 1.542, -0.2715],
        [-0.459, 1.6575, -0.354],
        [-0.525, 1.758, -0.441]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.327, 1.4475, -0.1965],
        [-0.315, 1.635, -0.465]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.459, 1.6575, -0.354],
        [-0.4575, 1.95, -0.291]
      ]
    }
  ],
  "style": {
    "wood": "#4d3322",
    "wood2": "#2a1a10",
    "branch": "#5c3d28",
    "branch2": "#7d5638",
    "leaf": "#2d6e1e",
    "leaf2": "#619130",
    "leafGrad": "y"
  }
},
 {
  "name": "Сухостой 3",
  "trunk": {
    "rings": [
      [0, 0, 0, 0.126],
      [0, 0.369, 0.0105, 0.087],
      [-0.0015, 0.738, 0.0165, 0.078],
      [-0.0075, 1.476, 0.0105, 0.0405],
      [0, 1.845, 0.0015, 0.009]
    ],
    "bark": {
      "type": "birch",
      "scaleX": 1,
      "scaleY": 1,
      "density": 0.7,
      "baseDark": 0.22,
      "col2": "#201b17",
      "colBase": "#120f0c"
    },
    "seg": 3,
    "flare": 0.58,
    "flareH": 0.135,
    "roots": 4,
    "rough": 0.19
  },
  "eco": {
    "kind": "deciduous",
    "baseWeight": 0.95,
    "seasons": "winter_only",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": { "h": 85, "s": 60, "l": 45 },
      "spring": { "h": 100, "s": 70, "l": 38 },
      "autumn": { "h": 38, "s": 85, "l": 48 },
      "lateAutumn": { "h": 22, "s": 75, "l": 35 },
      "winter": { "h": 160, "s": 35, "l": 24 }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "branches": [
    {
      "r": 0.0435,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0, 0.498, 0.012],
        [0.21, 0.831, 0.0525]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.21, 0.831, 0.0525],
        [0.3285, 0.894, 0.1245]
      ]
    },
    {
      "r": 0.039,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 0.621, 0.015],
        [-0.168, 0.9375, 0.1605]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.168, 0.9375, 0.1605],
        [-0.3315, 0.9975, 0.198]
      ]
    },
    {
      "r": 0.0345,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 0.7425, 0.0165],
        [0.0675, 1.029, -0.201]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.0675, 1.029, -0.201],
        [0.165, 1.101, -0.2475]
      ]
    },
    {
      "r": 0.0315,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0045, 0.8655, 0.0135],
        [0.072, 1.1985, 0.1905]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.072, 1.1985, 0.1905],
        [0.0135, 1.2735, 0.3315]
      ]
    },
    {
      "r": 0.027,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.009, 0.9885, 0.0105],
        [-0.2235, 1.302, -0.0495]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.2235, 1.302, -0.0495],
        [-0.2925, 1.38, -0.1425]
      ]
    },
    {
      "r": 0.024,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.012, 1.11, 0.0075],
        [0.2115, 1.38, -0.015]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.2115, 1.38, -0.015],
        [0.3195, 1.4505, 0.0555]
      ]
    },
    {
      "r": 0.0195,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0105, 1.233, 0.009],
        [-0.1185, 1.509, 0.195]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1185, 1.509, 0.195],
        [-0.258, 1.581, 0.222]
      ]
    },
    {
      "r": 0.0165,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.009, 1.3545, 0.009],
        [-0.0585, 1.6275, -0.1305]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0585, 1.6275, -0.1305],
        [-0.084, 1.692, -0.24]
      ]
    },
    {
      "r": 0.0135,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0075, 1.4775, 0.0105],
        [0.15, 1.77, 0.096]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.15, 1.77, 0.096],
        [0.1635, 1.8345, 0.1965]
      ]
    },
    {
      "r": 0.0105,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0045, 1.6005, 0.0075],
        [-0.1725, 1.8735, 0.0525]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.1725, 1.8735, 0.0525],
        [-0.3045, 1.938, 0.0735]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.003, 1.722, 0.0045],
        [0.096, 1.962, -0.1065]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0.096, 1.962, -0.1065],
        [0.1785, 2.019, -0.147]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0, 1.845, 0.0015],
        [-0.0015, 2.1255, 0.1245]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 2.1255, 0.1245],
        [-0.042, 2.1945, 0.2355]
      ]
    }
  ],
  "style": {
    "wood": "#efddd2",
    "wood2": "#160e09",
    "branch": "#626160",
    "branch2": "#ab7a54",
    "leaf": "#2d6e1e",
    "leaf2": "#63982f",
    "leafGrad": "y"
  },
  "disabled": false
},
 {
  "name": "Еловый сухостой круглогодичный",
  "eco": {
    "kind": "conifer",
    "baseWeight": 0.25,
    "seasons": "all",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": {
        "h": 85,
        "s": 60,
        "l": 45
      },
      "spring": {
        "h": 100,
        "s": 70,
        "l": 38
      },
      "autumn": {
        "h": 38,
        "s": 85,
        "l": 48
      },
      "lateAutumn": {
        "h": 22,
        "s": 75,
        "l": 35
      },
      "winter": {
        "h": 160,
        "s": 35,
        "l": 24
      }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "trunk": {
    "rings": [
      [
        0,
        0,
        0,
        0.126
      ],
      [
        0,
        0.369,
        0.011,
        0.087
      ],
      [
        -0.002,
        0.738,
        0.017,
        0.078
      ],
      [
        -0.007,
        1.476,
        0.011,
        0.041
      ],
      [
        0,
        2.11,
        0.002,
        0.009
      ]
    ],
    "seg": 3,
    "flare": 0.58,
    "flareH": 0.14,
    "roots": 4,
    "rough": 0.19
  },
  "branches": [
    {
      "r": 0.032,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.002,
          0.664,
          0.015
        ],
        [
          0.282,
          0.33,
          0.066
        ]
      ]
    },
    {
      "r": 0.03,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.002,
          0.771,
          0.017
        ],
        [
          -0.237,
          0.525,
          0.164
        ]
      ]
    },
    {
      "r": 0.029,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.003,
          0.879,
          0.015
        ],
        [
          0.141,
          0.615,
          -0.251
        ]
      ]
    },
    {
      "r": 0.025,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.003,
          0.986,
          0.015
        ],
        [
          0.375,
          0.54,
          0.278
        ]
      ]
    },
    {
      "r": 0.024,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.004,
          1.093,
          0.013
        ],
        [
          -0.264,
          0.735,
          -0.05
        ]
      ]
    },
    {
      "r": 0.022,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.006,
          1.202,
          0.012
        ],
        [
          0.225,
          0.93,
          -0.06
        ]
      ]
    },
    {
      "r": 0.019,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.006,
          1.308,
          0.012
        ],
        [
          -0.135,
          0.915,
          0.221
        ],
        [
          -0.03,
          0.555,
          0.195
        ]
      ]
    },
    {
      "r": 0.018,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.007,
          1.416,
          0.011
        ],
        [
          -0.015,
          0.825,
          -0.254
        ]
      ]
    },
    {
      "r": 0.015,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.006,
          1.522,
          0.009
        ],
        [
          0.186,
          1.05,
          0.18
        ]
      ]
    },
    {
      "r": 0.011,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.004,
          1.631,
          0.006
        ],
        [
          -0.251,
          0.975,
          0.068
        ]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          -0.002,
          1.737,
          0.004
        ],
        [
          0.175,
          1.305,
          -0.135
        ]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [
          0,
          1.845,
          0.002
        ],
        [
          0.004,
          1.32,
          0.241
        ]
      ]
    }
  ],
  "style": {
    "wood": "#714a33",
    "wood2": "#160e09",
    "branch": "#626160",
    "branch2": "#ab7a54",
    "leaf": "#2d6e1e",
    "leaf2": "#4f7b24",
    "leafGrad": "y"
  }
},
  {
  "name": "Еловый сухостой",
  "trunk": {
    "rings": [
      [0, 0, 0, 0.126],
      [0, 0.369, 0.0105, 0.087],
      [-0.0015, 0.738, 0.0165, 0.078],
      [-0.0075, 1.476, 0.0105, 0.0405],
      [0, 1.845, 0.0015, 0.009]
    ],
    "seg": 3,
    "flare": 0.58,
    "flareH": 0.135,
    "roots": 4,
    "rough": 0.19
  },
  "eco": {
    "kind": "conifer",
    "baseWeight": 1.15,
    "seasons": "winter_only",
    "deciduousWinter": false,
    "colorShift": {
      "enabled": false,
      "earlySpring": { "h": 85, "s": 60, "l": 45 },
      "spring": { "h": 100, "s": 70, "l": 38 },
      "autumn": { "h": 38, "s": 85, "l": 48 },
      "lateAutumn": { "h": 22, "s": 75, "l": 35 },
      "winter": { "h": 160, "s": 35, "l": 24 }
    },
    "weights": {
      "nearWater": 0,
      "waterDistM": 35,
      "steepSlope": 0,
      "slopeThresholdDeg": 28,
      "shadeLove": 0,
      "sunLove": 0,
      "urban": 0,
      "urbanDistM": 45
    }
  },
  "branches": [
    {
      "r": 0.0315,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 0.6645, 0.015],
        [0.282, 0.33, 0.066]
      ]
    },
    {
      "r": 0.03,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 0.771, 0.0165],
        [-0.237, 0.525, 0.1635]
      ]
    },
    {
      "r": 0.0285,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.003, 0.879, 0.015],
        [0.141, 0.615, -0.2505]
      ]
    },
    {
      "r": 0.0255,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.003, 0.9855, 0.015],
        [0.375, 0.54, 0.2775]
      ]
    },
    {
      "r": 0.024,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0045, 1.0935, 0.0135],
        [-0.264, 0.735, -0.0495]
      ]
    },
    {
      "r": 0.0225,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.006, 1.2015, 0.012],
        [0.225, 0.93, -0.06]
      ]
    },
    {
      "r": 0.0195,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.006, 1.308, 0.012],
        [-0.135, 1.11, 0.2205],
        [-0.258, 0.84, 0.429]
      ]
    },
    {
      "r": 0.018,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0075, 1.416, 0.0105],
        [-0.015, 0.825, -0.2535]
      ]
    },
    {
      "r": 0.015,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.006, 1.5225, 0.009],
        [0.186, 1.05, 0.18]
      ]
    },
    {
      "r": 0.0105,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0045, 1.6305, 0.006],
        [-0.2505, 0.975, 0.0675]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [-0.0015, 1.737, 0.0045],
        [0.1755, 1.305, -0.135]
      ]
    },
    {
      "r": 0.009,
      "sides": 3,
      "taper": 0.3,
      "nodes": [
        [0, 1.845, 0.0015],
        [0.0045, 1.32, 0.2415]
      ]
    }
  ],
  "style": {
    "wood": "#714a33",
    "wood2": "#160e09",
    "branch": "#626160",
    "branch2": "#ab7a54",
    "leaf": "#2d6e1e",
    "leaf2": "#86c14a",
    "leafGrad": "y"
  },
  "disabled": false
},
  {
    "name": "Яблоня",
    "trunk": {
      "rings": [
        [
          0,
          0,
          0,
          0.14
        ],
        [
          0.01,
          0.29,
          0.01,
          0.1
        ],
        [
          -0.15,
          0.52,
          -0.14,
          0.07
        ],
        [
          -0.19,
          0.82,
          -0.14,
          0.053
        ]
      ],
      "seg": 3
    },
    "eco": {
      "kind": "deciduous",
      "baseWeight": 1,
      "seasons": "early_spring_to_late_autumn",
      "deciduousWinter": false,
      "colorShift": {
        "enabled": true,
        "earlySpring": {
          "h": 259,
          "s": 100,
          "l": 71,
          "h2": 315,
          "s2": 100,
          "l2": 79
        },
        "spring": {
          "h": 274,
          "s": 100,
          "l": 84
        },
        "autumn": {
          "h": 41,
          "s": 87,
          "l": 38,
          "h2": 24,
          "s2": 81,
          "l2": 48
        },
        "lateAutumn": {
          "h": 45,
          "s": 70,
          "l": 25
        },
        "winter": {
          "h": 148,
          "s": 50,
          "l": 30
        }
      },
      "weights": {
        "nearWater": 0,
        "waterDistM": 35,
        "steepSlope": 0,
        "slopeThresholdDeg": 28,
        "shadeLove": 0,
        "sunLove": 0,
        "urban": 0.5,
        "urbanDistM": 150
      }
    },
    "branches": [
      {
        "r": 0.04,
        "nodes": [
          [
            0,
            0.33,
            0
          ],
          [
            0.23,
            0.52,
            -0.08
          ],
          [
            0.18,
            0.84,
            -0.23
          ]
        ]
      },
      {
        "r": 0.018,
        "sides": 3,
        "taper": 0.05,
        "nodes": [
          [
            0.22,
            0.52,
            -0.05
          ],
          [
            0.25,
            0.78,
            0.18
          ]
        ]
      }
    ],
    "foliage": [
      {
        "type": "blob",
        "y": 1.07,
        "rotX": 0.18,
        "rotY": -0.02,
        "rotZ": -0.18,
        "rx": 0.74,
        "ry": 0.48,
        "taper": -0.8,
        "lump": 0.3,
        "seg": 10,
        "rings": 5,
        "seed": 0.5
      }
    ],
    "style": {
      "wood": "#4d3322",
      "wood2": "#2a1a10",
      "branch": "#5c3d28",
      "branch2": "#7d5638",
      "leaf": "#2d6e1e",
      "leaf2": "#4f7b23",
      "leafGrad": "y"
    },
    "disabled": false
  }
];
})();