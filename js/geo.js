(function () {
  const WM = window.WM, D = 180 / Math.PI;
  const lon2x = (lon, n) => Math.floor((lon + 180) / 360 * n);
  const lat2y = (lat, n) => {
    lat = Math.max(-85.05, Math.min(85.05, lat)); const r = lat / D;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  const x2lon = (x, n) => x / n * 360 - 180;
  const y2lat = (y, n) => D * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / n));

  WM.geo = {
    tileBBox(x, y, z) { const n = 2 ** z; return { w: x2lon(x, n), e: x2lon(x + 1, n), n: y2lat(y, n), s: y2lat(y + 1, n) }; },
    // Плитки, покрывающие bounds {w,s,e,n}, отсортированные от центра; не более max
    tilesFor(b, z, max) {
      const n = 2 ** z, cl = v => Math.max(0, Math.min(n - 1, v));
      const x0 = cl(lon2x(b.w, n)), x1 = cl(lon2x(b.e, n)), y0 = cl(lat2y(b.n, n)), y1 = cl(lat2y(b.s, n));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, out = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
        out.push({ x, y, z, key: z + '/' + x + '/' + y, d: (x - cx) ** 2 + (y - cy) ** 2 });
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, max);
    },
    bboxOf(pts) {
      let w = 180, e = -180, s = 90, n = -90;
      for (const p of pts) { if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; }
      return { w, s, e, n };
    },
    areaOf(pts) {
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][1] * pts[i][0] - pts[i][1] * pts[j][0];
      return Math.abs(a / 2);
    },
    intersects(a, b) { return a.w <= b.e && a.e >= b.w && a.s <= b.n && a.n >= b.s; },
    pointInPoly(lat, lng, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
        if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    // расстояние (в пикселях) от точки до контура; proj: [lat,lng] -> {x,y}
    distToEdge(p, pts, proj) {
      let best = Infinity, prev = proj(pts[pts.length - 1]);
      for (const q of pts) {
        const c = proj(q), dx = c.x - prev.x, dy = c.y - prev.y, l2 = dx * dx + dy * dy;
        let t = l2 ? ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p.x - (prev.x + t * dx), p.y - (prev.y + t * dy));
        if (d < best) best = d; prev = c;
      }
      return best;
    }
  };
})();
