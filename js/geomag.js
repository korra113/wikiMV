// =========================================================================
// WMM (World Magnetic Model) — Расчёт геомагнитного склонения для любой точки мира
// =========================================================================
(function () {
  window.WM = window.WM || {};

  // Коэффициенты WMM (n=1..4 с вековым дрейфом)
  const COEFFS = [
    // n, m, g, h, dg, dh (нТл / нТл в год)
    [1, 0, -29404.5, 0.0, 6.7, 0.0],
    [1, 1, -1450.7, 4652.9, 7.7, -25.1],
    [2, 0, -2500.0, 0.0, -11.5, 0.0],
    [2, 1, 2982.0, -2991.6, -7.1, -30.2],
    [2, 2, 1676.8, -734.8, -2.2, -23.9],
    [3, 0, 1363.9, 0.0, 2.8, 0.0],
    [3, 1, -2381.0, -82.2, -6.2, 5.7],
    [3, 2, 1236.2, 241.8, 3.4, -1.0],
    [3, 3, 525.7, -542.9, -12.2, 1.1],
    [4, 0, 903.1, 0.0, -1.1, 0.0],
    [4, 1, 802.4, 282.0, -1.6, 0.2],
    [4, 2, 86.2, -266.8, -6.0, 0.5],
    [4, 3, -309.4, 119.8, 5.4, 3.5],
    [4, 4, 47.9, -322.2, -5.5, -4.5]
  ];

  function getDeclination(lat, lon, date) {
    if (!isFinite(lat) || !isFinite(lon)) return 0;

    const d = date || new Date();
    const year = d.getFullYear() + (d.getMonth() + d.getDate() / 31) / 12;
    const dt = year - 2020.0;
    const rad = Math.PI / 180.0;

    // Геоцентрические координаты (WGS-84 эллипсоид)
    const phi = lat * rad;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    // Нормализация широты
    const a = 6378.137;
    const b = 6356.7523142;
    const a2 = a * a, b2 = b * b;
    const e2 = (a2 - b2) / a2;
    const chi = Math.sqrt(1.0 - e2 * sinPhi * sinPhi);
    const r = Math.sqrt(a2 * cosPhi * cosPhi + b2 * sinPhi * sinPhi);
    const latGc = Math.atan2((1.0 - e2) * sinPhi, cosPhi);
    const colat = (Math.PI / 2.0) - latGc;

    const lam = lon * rad;
    const cosLatGc = Math.cos(latGc);
    const sinLatGc = Math.sin(latGc);
    const cosColat = Math.cos(colat);
    const sinColat = Math.sin(colat);

    // Расчет присоединенных полиномов Лежандра P(n,m) и dP(n,m)
    const P = {}, dP = {};
    for (let n = 0; n <= 4; n++) {
      P[n] = {}; dP[n] = {};
      for (let m = 0; m <= n; m++) {
        P[n][m] = 0; dP[n][m] = 0;
      }
    }

    P[0][0] = 1.0;
    P[1][0] = cosColat;
    P[1][1] = sinColat;
    dP[1][0] = -sinColat;
    dP[1][1] = cosColat;

    for (let n = 2; n <= 4; n++) {
      P[n][0] = ((2 * n - 1) * cosColat * P[n - 1][0] - (n - 1) * P[n - 2][0]) / n;
      dP[n][0] = -n * sinColat * P[n - 1][0] + cosColat * dP[n - 1][0];

      for (let m = 1; m < n; m++) {
        P[n][m] = P[n - 2][m] + (2 * n - 1) * sinColat * P[n - 1][m - 1];
        dP[n][m] = dP[n - 2][m] + (2 * n - 1) * (cosColat * P[n - 1][m - 1] + sinColat * dP[n - 1][m - 1]);
      }
      P[n][n] = (2 * n - 1) * sinColat * P[n - 1][n - 1];
      dP[n][n] = (2 * n - 1) * (cosColat * P[n - 1][n - 1] + sinColat * dP[n - 1][n - 1]);
    }

    // Синусы и косинусы долгот m * lambda
    const sinMLam = [0], cosMLam = [1];
    for (let m = 1; m <= 4; m++) {
      sinMLam[m] = Math.sin(m * lam);
      cosMLam[m] = Math.cos(m * lam);
    }

    // Компоненты геомагнитного поля
    let X_gc = 0, Y_gc = 0;
    const a_r = a / r;
    let ratio = a_r * a_r;

    for (let n = 1; n <= 4; n++) {
      ratio *= a_r;
      for (let m = 0; m <= n; m++) {
        const item = COEFFS.find(c => c[0] === n && c[1] === m);
        if (!item) continue;
        const g = item[2] + item[4] * dt;
        const h = item[3] + item[5] * dt;

        const gcos_hsin = g * cosMLam[m] + h * sinMLam[m];
        const gsin_hcos = g * sinMLam[m] - h * cosMLam[m];

        // X (северная геоцентрическая) = -1/r * dV/d(colat)
        X_gc += ratio * gcos_hsin * dP[n][m];

        // Y (восточная геоцентрическая) = -1/(r*sin(colat)) * dV/d(lam)
        if (sinColat > 1e-5) {
          Y_gc += (ratio / sinColat) * m * gsin_hcos * P[n][m];
        }
      }
    }

    // Перевод геоцентрических компонент в местный горизонт (X = Север, Y = Восток)
    const X = -X_gc;
    const Y = Y_gc;

    let declination = Math.atan2(Y, X) * (180.0 / Math.PI);
    return Math.round(declination * 10) / 10;
  }

  WM.geoMag = { getDeclination };
})();