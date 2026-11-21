
/**
 * js/treeEditor.js — Интерактивный 3D-редактор и процедурный генератор стилизованных деревьев для Slice3D (v2).
 *
 * Что внутри:
 *  • TreeCore — чистое (без DOM/GL) ядро геометрии. Его же исходник встраивается в экспортируемый JS-код,
 *    поэтому результат в slice3d.js ВСЕГДА совпадает с превью (в v1 экспорт терял вращение, droop, lobes и т.д.).
 *  • Типы кроны: blob, tier, cluster (пухлые шапки), fronds (пальмы/агавы/пряди), lathe (тело вращения по профилю).
 *  • Стволы: гладкие трубы (Catmull-Rom), раздвоенные доп. стволы, корневые наплывы, скрутка, шероховатость коры.
 *  • Ветки: плавные трубы с настраиваемой конусностью/гранями, листва на концах, радиальный массив.
 *  • Процедурный генератор ствола и ветвления (уровни, гравитация, фототропизм, листва на кончиках).
 *  • Стиль: плоские (low-poly) нормали, смешивание нормалей к центру кроны, цвета превью.
 *  • Экспорт: автономный JS для buildTreeMeshes(), JSON, OBJ; API WM.slice3d.treeRecipeToMeshData().
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  // ===========================================================================
  // 1. TREE CORE — ЧИСТАЯ ГЕОМЕТРИЯ (самодостаточная функция: toString() попадает в экспорт)
  // ===========================================================================
  function createTreeCore() {
    const TAU = Math.PI * 2;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const hsh = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

    // Детерминированный ГСЧ (mulberry32)
    function rng(seed) {
      let a = (Math.floor((seed || 0) * 1000) + 0x6D2B79F5) | 0;
      return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Эйлеровы повороты X -> Y -> Z
    function rotatePoint(p, rx, ry, rz) {
      let x = p[0], y = p[1], z = p[2];
      if (rx) { const c = Math.cos(rx), s = Math.sin(rx); const y1 = y * c - z * s, z1 = y * s + z * c; y = y1; z = z1; }
      if (ry) { const c = Math.cos(ry), s = Math.sin(ry); const x1 = x * c + z * s, z1 = -x * s + z * c; x = x1; z = z1; }
      if (rz) { const c = Math.cos(rz), s = Math.sin(rz); const x1 = x * c - y * s, y1 = x * s + y * c; x = x1; y = y1; }
      return [x, y, z];
    }

    // Поддержка старого 2-точечного формата веток
    function normalizeBranch(b) {
      b.r = b.r || 0.025;
      if (b.nodes && Array.isArray(b.nodes)) {
        b.nodes = b.nodes.map(n => Array.isArray(n) ? { x: n[0] || 0, y: n[1] || 0, z: n[2] || 0 } : n);
        return b;
      }
      b.nodes = [
        { x: b.ax || 0, y: b.ay || 0.4, z: b.az || 0 },
        { x: b.bx || 0.3, y: b.by || 0.6, z: b.bz || 0.2 }
      ];
      return b;
    }

    // Catmull-Rom сглаживание цепочки точек и радиусов
    function smoothPath(pts, rad, subdiv) {
      subdiv = subdiv | 0;
      if (subdiv <= 0 || pts.length < 2) return { pts, rad };
      const outP = [], outR = [], n = pts.length;
      const cr = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      for (let i = 0; i < n - 1; i++) {
        const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
        const r0 = rad[Math.max(i - 1, 0)], r1 = rad[i], r2 = rad[i + 1], r3 = rad[Math.min(i + 2, n - 1)];
        for (let k = 0; k <= subdiv; k++) {
          const t = k / (subdiv + 1);
          outP.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t), cr(p0[2], p1[2], p2[2], p3[2], t)]);
          outR.push(Math.max(0.002, cr(r0, r1, r2, r3, t)));
        }
      }
      outP.push(pts[n - 1].slice()); outR.push(rad[n - 1]);
      return { pts: outP, rad: outR };
    }

    // Нормализация рецепта (значения по умолчанию, не мутирует вход)
    function prepare(recipe) {
      const r = JSON.parse(JSON.stringify(recipe));
      r.trunk = r.trunk || { seg: 8, rings: [{ x: 0, y: 0, z: 0, r: 0.1 }, { x: 0, y: 0.5, z: 0, r: 0.05 }] };
      if (r.trunk.rings) {
        r.trunk.rings = r.trunk.rings.map(pt => Array.isArray(pt) ? { x: pt[0] || 0, y: pt[1] || 0, z: pt[2] || 0, r: pt[3] != null ? pt[3] : 0.05 } : pt);
      }
      r.stems = (r.stems || []).map(s => {
        if (s.rings) s.rings = s.rings.map(pt => Array.isArray(pt) ? { x: pt[0] || 0, y: pt[1] || 0, z: pt[2] || 0, r: pt[3] != null ? pt[3] : 0.05 } : pt);
        return s;
      });
      r.branches = (r.branches || []).map(normalizeBranch);
      r.foliage = r.foliage || [];
      r.style = r.style || {};
      return r;
    }

    // Главная функция: рецепт -> Float32Array (9 float на вершину: pos3 nrm3 part grad hl)
    function generate(recipeIn, lod, sel) {
      lod = lod || 0;
      const R = prepare(recipeIn);
      const ST = R.style;
      const isSnagModel = !R.foliage || R.foliage.length === 0;
      const lf = lod === 0 ? 1 : (lod === 1 ? 0.5 : 0.35);
      const v = [];
      let yaw = 0, cy = 1, sy = 0;

      const setYaw = a => { yaw = a; cy = Math.cos(a); sy = Math.sin(a); };
      const push = (p, n, part, grad, hl) => {
        let x = p[0], z = p[2], nx = n[0], nz = n[2];
        if (yaw) {
          const X = x * cy + z * sy, Z = -x * sy + z * cy; x = X; z = Z;
          const NX = nx * cy + nz * sy, NZ = -nx * sy + nz * cy; nx = NX; nz = NZ;
        }
        v.push(x, p[1], z, nx, n[1], nz, part, grad, hl ? 1 : 0);
      };
      const tri = (a, b, c, part, hl, flat) => {
        let na = a.n, nb = b.n, nc = c.n;
        if (flat) {
          let fn = nrm(cross(sub(b.p, a.p), sub(c.p, a.p)));
          if (dot(fn, [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]]) < 0) fn = [-fn[0], -fn[1], -fn[2]];
          na = nb = nc = fn;
        }
        push(a.p, na, part, a.g, hl); push(b.p, nb, part, b.g, hl); push(c.p, nc, part, c.g, hl);
      };

      function makeXf(f) {
        const ox = f.x || 0, oy = f.y || 0, oz = f.z || 0;
        const rx = f.rotX || 0, ry = f.rotY || 0, rz = f.rotZ || 0, sc = f.sc || 1;
        return (lp, ln) => {
          const q = rotatePoint([lp[0] * sc, lp[1] * sc, lp[2] * sc], rx, ry, rz);
          const p = [ox + q[0], oy + q[1], oz + q[2]];
          const n = rotatePoint(nrm(ln), rx, ry, rz);
          return { p, n: nb > 0 ? blendN(p, n) : n };
        };
      }

      const radial = (count, phase, fn) => {
        count = Math.max(1, Math.round(count || 1));
        for (let i = 0; i < count; i++) { setYaw(i === 0 && !phase ? 0 : (i / count) * TAU + (phase || 0)); fn(); }
        setYaw(0);
      };

      const nb = ST.normalBlend || 0;
      let crown = [0, 0.6, 0];
      if (nb > 0) {
        const pts = R.foliage.map(f => [f.x || f.ox || 0, f.y || 0, f.z || f.oz || 0]);
        R.branches.forEach(b => { if (b.leaf && b.leaf.kind !== 'none') { const n = b.nodes[b.nodes.length - 1]; pts.push([n.x, n.y, n.z]); } });
        if (pts.length) { crown = [0, 0, 0]; pts.forEach(p => { crown[0] += p[0] / pts.length; crown[1] += p[1] / pts.length; crown[2] += p[2] / pts.length; }); }
      }
      const blendN = (p, n) => { if (!(nb > 0)) return n; const d = nrm(sub(p, crown)); return nrm([lerp(n[0], d[0], nb), lerp(n[1], d[1], nb), lerp(n[2], d[2], nb)]); };

      function tube(P, Rr, sides, part, o) {
        const n = P.length; if (n < 2) return;
        const T = [];
        for (let i = 0; i < n; i++) T.push(nrm(sub(P[Math.min(i + 1, n - 1)], P[Math.max(i - 1, 0)])));
        let u = nrm(cross(T[0], Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const U = [], W = [];
        for (let i = 0; i < n; i++) {
          if (i > 0) { const d = dot(u, T[i]); u = nrm([u[0] - T[i][0] * d, u[1] - T[i][1] * d, u[2] - T[i][2] * d]); }
          U.push(u); W.push(cross(T[i], u));
        }
        const rings = [];
        for (let i = 0; i < n; i++) {
          const tGrad = n > 1 ? (i / (n - 1)) : 0.0;
          const a0 = Math.max(i - 1, 0), a1 = Math.min(i + 1, n - 1);
          const ds = Math.hypot(...sub(P[a1], P[a0])) || 1;
          const drds = (Rr[a1] - Rr[a0]) / ds;
          const ring = [];
          const yRel = P[i][1] - (o.y0 || 0);
          for (let s = 0; s <= sides; s++) {
            const uFrac = s / sides;
            const a = (s % sides) / sides * TAU + (o.twist || 0) * i / (n - 1);
            const ca = Math.cos(a), sa = Math.sin(a);
            const dv = [U[i][0] * ca + W[i][0] * sa, U[i][1] * ca + W[i][1] * sa, U[i][2] * ca + W[i][2] * sa];
            let m = 1;
            if (o.rough && i > 0 && i < n - 1) m *= 1 + o.rough * (hsh(i * 5.3 + (o.seed || 0), s % sides) - 0.5) * 1.2;
            if (o.flare) {
              const h = Math.max(0, 1 - yRel / (o.flareH || 0.12));
              m *= 1 + o.flare * h * h * ((o.roots | 0) > 0 ? (0.55 + 0.45 * Math.cos(a * (o.roots | 0))) : 1);
            }
            const rr = Rr[i] * m;
            ring.push({
              p: [P[i][0] + dv[0] * rr, o.floorY != null ? Math.max(o.floorY, P[i][1] + dv[1] * rr) : P[i][1] + dv[1] * rr, P[i][2] + dv[2] * rr],
              n: nrm([dv[0] - T[i][0] * drds, dv[1] - T[i][1] * drds, dv[2] - T[i][2] * drds]),
              g: tGrad,
              part: part + uFrac * 0.999
            });
          }
          rings.push(ring);
        }
        for (let i = 0; i < n - 1; i++) {
          const hl = o.hl ? o.hl(i) : false;
          for (let s = 0; s < sides; s++) {
            tri(rings[i][s], rings[i][s + 1], rings[i + 1][s], rings[i][s].part, hl, o.flat);
            tri(rings[i][s + 1], rings[i + 1][s + 1], rings[i + 1][s], rings[i][s + 1].part, hl, o.flat);
          }
        }
        if (o.cap !== false) {
          const hl = o.hl ? o.hl(n - 2) : false;
          const c = { p: P[n - 1], n: T[n - 1], g: 1.0 };
          for (let s = 0; s < sides; s++) tri(c, rings[n - 1][s], rings[n - 1][s + 1], part, hl, o.flat);
        }
      }

      function emitStem(st, stemIdx) {
        const sides = lod === 2 ? 3 : Math.max(3, Math.round((st.seg || 8) * lf));
        const rings = st.rings || [];
        if (rings.length < 2) return;
        let pts = rings.map(r => [r.x || 0, r.y || 0, r.z || 0]);
        let rad = rings.map(r => r.r);
        if (lod === 2 && pts.length > 3) {
          const mid = pts.length >> 1;
          pts = [pts[0], pts[mid], pts[pts.length - 1]];
          rad = [rad[0], rad[mid], rad[rad.length - 1]];
        }
        const sm = lod === 0 ? (st.smooth | 0) : 0;
        const sp = smoothPath(pts, rad, sm);
        const hlFn = (ringIdx) => {
          if (!sel || sel.type !== 'trunk') return false;
          const curStem = sel.stem == null ? -1 : sel.stem;
          if (curStem !== stemIdx) return false;
          return sel.idx === ringIdx || sel.idx === ringIdx + 1;
        };
        tube(sp.pts, sp.rad, sides, 0, {
          flat: !!ST.flatTrunk,
          rough: lod === 0 ? (st.rough || 0) : 0,
          flare: lod === 2 ? 0 : (st.flare || 0),
          flareH: st.flareH || 0.12,
          roots: lod === 2 ? 0 : (st.roots || 0),
          twist: lod === 2 ? 0 : (st.twist || 0),
          seed: st.seed || 0,
          y0: rings[0].y,
          floorY: rings[0].y,
          cap: lod < 2 || isSnagModel,
          hl: hlFn
        });
      }

      if (R.trunk) emitStem(R.trunk, -1);
      (R.stems || []).forEach((s, sIdx) => radial(s.radial, s.radialPhase, () => emitStem(s, sIdx)));

      function blobCore(xf, cx, cy_, cz, rx, ry, rz, seg, rings, lump, taper, seed, hl, flat, isRadial) {
        seg = Math.max(4, seg | 0); rings = Math.max(2, rings | 0);
        const V = (r, s) => {
          const poleTop = r === 0, poleBot = r === rings;
          const t = r / rings, th = t * Math.PI;
          const ph = (s % seg) / seg * TAU + seed;
          const tf = Math.max(0.15, 1 + (0.5 - t) * taper * 1.5);
          const k = (poleTop || poleBot) ? 1 : 1 + lump * (hsh(r * 13.1 + seed, s % seg) - 0.5) * 1.8;
          const ly = Math.cos(th) * ry * (poleTop ? 0.94 : (poleBot ? 0.90 : 1));
          const lx = Math.sin(th) * Math.cos(ph) * rx * k * tf, lz = Math.sin(th) * Math.sin(ph) * rz * k * tf;
          const res = xf([cx + lx, cy_ + ly, cz + lz], [lx / rx, (ly / ry) * 1.3, lz / rz]);
          res.g = isRadial ? clamp(Math.hypot(lx / rx, lz / rz), 0, 1) : clamp(1.0 - t, 0, 1);
          return res;
        };
        for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
          const a = V(r, s), b = V(r, s + 1), c = V(r + 1, s), d = V(r + 1, s + 1);
          if (r === 0) tri(a, c, d, 1, hl, flat);
          else if (r === rings - 1) tri(a, c, b, 1, hl, flat);
          else { tri(a, c, b, 1, hl, flat); tri(b, c, d, 1, hl, flat); }
        }
      }

      function emitBlob(f, hl) {
        const k = lod === 0 ? 1 : lf;
        const rx = f.rx || 0.3, rz = f.rz || rx, ry = f.ry || 0.3;
        const isRad = (f.grad || ST.leafGrad) === 'radial';
        const seg = lod === 2 ? 4 : Math.max(5, Math.round((f.seg || 10) * k));
        const rings = lod === 2 ? 2 : Math.max(3, Math.round((f.rings || 5) * k));
        blobCore(makeXf(f), 0, 0, 0, rx, ry, rz, seg, rings,
          lod === 0 ? (f.lump || 0) : 0, f.taper || 0, f.seed || 0, hl, !!f.flat, isRad);
      }

      function emitTier(f, hl) {
        const tSeg = lod === 2
          ? Math.max(4, Math.round((f.seg || 10) * 0.4))
          : Math.max(6, Math.round((f.seg || 10) * lf));
        const rawRc = Math.max(1, f.rings || 1);
        const rc = lod === 2
          ? (((f.tuck || 0) > 0.15 || (f.arch || 0) > 0.35) ? Math.min(2, rawRc) : 1)
          : rawRc;
        const droop = f.droop || 0, curve = f.curve || 0, lobes = f.lobes || 0, scallop = f.scallop || 0;
        const arch = f.arch || 0, tuck = f.tuck || 0;
        const H = f.h || 0.35, baseR = f.r || 0.5, jag = f.jag != null ? f.jag : 1;
        const isRad = (f.grad || ST.leafGrad) === 'radial';
        const xf = makeXf(f);
        const curvePow = curve >= 0 ? (1.0 - curve * 0.72) : (1.0 - curve * 1.55);

        const G = (ri, si) => {
          const vf = ri / rc, a = (si % tSeg) / tSeg * TAU;
          let lobeF = 1;
          if (lobes > 0 && scallop > 0) lobeF -= Math.abs(Math.sin(a * lobes * 0.5)) * scallop * vf;
          const odd = (si & 1) && jag < 1 && lod === 0;
          let cr = baseR * Math.pow(vf, Math.max(0.15, curvePow)) * lobeF * (odd ? jag : 1);
          const baseRelDist = cr / Math.max(0.001, baseR);
          if (tuck !== 0) {
            const relDistNorm = clamp(baseRelDist, 0.0, 1.8);
            cr *= Math.max(0.05, 1.0 - tuck * Math.pow(relDistNorm, 2.2));
          }
          const archOffset = (Math.pow(vf, 2) * droop + Math.pow(baseRelDist, 1.6) * arch) * H;
          const curY = H * (1 - vf) - archOffset;
          const res = xf([Math.cos(a) * cr, curY, Math.sin(a) * cr], [Math.cos(a), (baseR / Math.max(0.01, H)) * 0.7, Math.sin(a)]);
          res.g = isRad ? vf : (1.0 - vf);
          return res;
        };

        const sk = [];
        for (let i = 0; i < tSeg; i++) sk.push(G(rc, i));

        if (rc === 1) {
          const apex = xf([0, H, 0], [0, 1, 0]); apex.g = isRad ? 0.0 : 1.0;
          for (let i = 0; i < tSeg; i++) tri(apex, sk[i], sk[(i + 1) % tSeg], 1, hl, !!f.flat);
        } else {
          for (let r = 0; r < rc; r++) for (let s = 0; s < tSeg; s++) {
            const a = G(r, s), b = G(r, s + 1), c = G(r + 1, s), d = G(r + 1, s + 1);
            if (r === 0) tri(a, c, d, 1, hl, !!f.flat);
            else { tri(a, c, b, 1, hl, !!f.flat); tri(b, c, d, 1, hl, !!f.flat); }
          }
        }

        if (f.capBottom && lod < 2) {
          const botCenterY = -droop * H + arch * H * 0.65;
          const botCenter = xf([0, botCenterY, 0], [0, -1, 0]);
          botCenter.g = 0.0;
          const bsk = sk.map(pt => ({
            p: pt.p,
            n: xf([0, -1, 0], [pt.n[0] * 0.25, -0.95, pt.n[2] * 0.25]).n,
            g: pt.g
          }));
          for (let s = 0; s < tSeg; s++) tri(botCenter, bsk[(s + 1) % tSeg], bsk[s], 1, hl, !!f.flat);
        }
      }

      function emitCluster(f, hl) {
        const rnd = rng(f.seed || 0);
        const cnt = Math.max(1, Math.round((f.count || 7) * (lod === 0 ? 1 : (lod === 1 ? 0.55 : 0.35))));
        const rx = f.rx || 0.5, ry = f.ry || 0.35, rz = f.rz || rx;
        const smin = f.smin || 0.18, smax = Math.max(smin, f.smax || 0.3);
        const seg = lod === 0 ? (f.seg || 8) : (lod === 1 ? 5 : 4);
        const rings = lod === 0 ? (f.rings || 4) : (lod === 1 ? 3 : 2);
        const lump = lod === 0 ? (f.lump || 0.05) : 0;
        const sMul = (lod === 2 && cnt < (f.count || 7)) ? 1.15 : 1.0;
        const isRad = (f.grad || ST.leafGrad) === 'radial';
        const xf = makeXf(f);
        for (let i = 0; i < cnt; i++) {
          const th = rnd() * TAU, ph = Math.acos(2 * rnd() - 1), rr = Math.cbrt(rnd()) * 0.85 + (i === 0 ? 0 : 0.15 * rnd());
          const cx = Math.sin(ph) * Math.cos(th) * rx * rr, cy_ = Math.cos(ph) * ry * rr * (f.flatTop ? Math.sign(Math.cos(ph) || 1) * 0.5 : 1), cz = Math.sin(ph) * Math.sin(th) * rz * rr;
          const s = lerp(smin, smax, rnd()) * sMul;
          blobCore(xf, cx, cy_, cz, s, s * (f.puffY || 0.85), s, seg, rings, lump, 0, rnd() * 6, hl, !!f.flat, isRad);
        }
      }

      function emitFronds(f, hl) {
        const rnd = rng(f.seed || 0);
        const cnt = Math.max(lod === 2 ? 2 : 1, Math.round((f.count || 8) * (lod === 0 ? 1 : (lod === 1 ? 0.6 : 0.4))));
        const segs = lod === 2 ? Math.max(1, Math.floor((f.segs || 5) * 0.4)) : Math.max(2, Math.round((f.segs || 5) * lf));
        const cols = lod === 2 ? 1 : 2;
        const xf = makeXf(f), jit = f.jitter != null ? f.jitter : 0.25;
        const len0 = f.len || 0.5, wid = f.width || 0.1, fold = f.fold != null ? f.fold : 0.4;
        const isRad = (f.grad || ST.leafGrad) === 'radial';
        for (let i = 0; i < cnt; i++) {
          const phi = i / cnt * TAU + (rnd() - 0.5) * jit * 1.2;
          const tilt = (f.tilt != null ? f.tilt : 0.9) + (rnd() - 0.5) * jit;
          const len = len0 * (1 - jit * 0.35 * rnd());
          const arch = (f.arch != null ? f.arch : 0.8) * (0.85 + 0.3 * rnd());
          const d = [Math.cos(phi), 0, Math.sin(phi)], side = [-Math.sin(phi), 0, Math.cos(phi)];
          let pos = [0, 0, 0];
          const rows = [];
          for (let k = 0; k <= segs; k++) {
            const s = k / segs;
            const th = tilt + arch * s * 1.2;
            const t = [Math.sin(th) * d[0], Math.cos(th), Math.sin(th) * d[2]];
            if (k > 0) { const st = len / segs; pos = [pos[0] + t[0] * st, pos[1] + t[1] * st, pos[2] + t[2] * st]; }
            const w = k === segs ? 0 : wid * Math.pow(1 - s, 0.7) * Math.min(1, 0.35 + s * 4);
            const n = nrm(cross(side, t));
            const up = n;
            const mk = (off, fl, nn) => {
              const res = xf([pos[0] + side[0] * off + up[0] * fl, pos[1] + side[1] * off + up[1] * fl, pos[2] + side[2] * off + up[2] * fl], nn);
              res.g = isRad ? s : clamp((pos[1] + len0 * 0.5) / len0, 0, 1);
              return res;
            };
            if (cols === 1) {
              rows.push([mk(-w, 0, n), mk(w, 0, n)]);
            } else {
              rows.push([
                mk(-w, w * fold, nrm([n[0] - side[0] * fold, n[1] - side[1] * fold, n[2] - side[2] * fold])),
                mk(0, 0, n),
                mk(w, w * fold, nrm([n[0] + side[0] * fold, n[1] + side[1] * fold, n[2] + side[2] * fold]))
              ]);
            }
          }
          const flip = q => ({ p: q.p, n: [-q.n[0], -q.n[1], -q.n[2]], g: q.g });
          for (let k = 0; k < segs; k++) {
            const A = rows[k], B = rows[k + 1];
            for (let c = 0; c < cols; c++) {
              tri(A[c], A[c + 1], B[c], 1, hl, !!f.flat); tri(A[c + 1], B[c + 1], B[c], 1, hl, !!f.flat);
              tri(flip(A[c]), flip(B[c]), flip(A[c + 1]), 1, hl, !!f.flat); tri(flip(A[c + 1]), flip(B[c]), flip(B[c + 1]), 1, hl, !!f.flat);
            }
          }
        }
      }

      function emitLathe(f, hl) {
        let prof = (f.profile && f.profile.length >= 2) ? f.profile : [[0.0, 0], [0.3, 0.1], [0.2, 0.4], [0, 0.5]];
        if (lod === 2 && prof.length > 4) {
          const mid1 = Math.floor((prof.length - 2) / 2);
          let b1 = prof[1], b2 = prof[1 + mid1];
          for (let i = 1; i < 1 + mid1; i++) if (prof[i][0] > b1[0]) b1 = prof[i];
          for (let i = 1 + mid1; i < prof.length - 1; i++) if (prof[i][0] > b2[0]) b2 = prof[i];
          prof = [prof[0], b1, b2, prof[prof.length - 1]];
        }
        const seg = lod === 2 ? 4 : Math.max(5, Math.round((f.seg || 12) * lf));
        const sm = lod === 0 ? (f.smooth | 0) : 0;
        const sp = smoothPath(prof.map(p => [p[0], p[1], 0]), prof.map(() => 0.01), sm);
        const P = sp.pts;
        const lump = lod === 0 ? (f.lump || 0) : 0, lobes = f.lobes | 0, scallop = f.scallop || 0, seed = f.seed || 0;
        const isRad = (f.grad || ST.leafGrad) === 'radial';
        const xf = makeXf(f);
        const m = P.length;
        let maxR = 0.01;
        P.forEach(pt => { if (pt[0] > maxR) maxR = pt[0]; });

        const Vx = (j, s) => {
          const a = (s % seg) / seg * TAU;
          const p0 = P[Math.max(j - 1, 0)], p1 = P[Math.min(j + 1, m - 1)];
          const tr = p1[0] - p0[0], ty = p1[1] - p0[1];
          const nl = Math.hypot(tr, ty) || 1;
          const nr = ty / nl, ny = -tr / nl;
          let k = 1 + (j > 0 && j < m - 1 ? lump * (hsh(j * 13.1 + seed, s % seg) - 0.5) * 1.8 : 0);
          if (lobes > 0 && scallop > 0) k -= Math.abs(Math.sin(a * lobes * 0.5)) * scallop * (j / (m - 1));
          const r = Math.max(0, P[j][0] * k);
          const res = xf([Math.cos(a) * r, P[j][1], Math.sin(a) * r], [Math.cos(a) * nr, ny, Math.sin(a) * nr]);
          res.g = isRad ? clamp(r / maxR, 0, 1) : (j / (m - 1));
          return res;
        };
        for (let j = 0; j < m - 1; j++) for (let s = 0; s < seg; s++) {
          const a = Vx(j, s), b = Vx(j, s + 1), c = Vx(j + 1, s), d = Vx(j + 1, s + 1);
          tri(a, b, c, 1, hl, !!f.flat); tri(b, d, c, 1, hl, !!f.flat);
        }
        if (lod < 2 && f.capBottom !== false && P[0][0] > 0.001) { const c = xf([0, P[0][1], 0], [0, -1, 0]); c.g = 0; for (let s = 0; s < seg; s++) tri(c, Vx(0, s + 1), Vx(0, s), 1, hl, !!f.flat); }
        if (f.capTop !== false && P[m - 1][0] > 0.001) { const c = xf([0, P[m - 1][1], 0], [0, 1, 0]); c.g = 1; for (let s = 0; s < seg; s++) tri(c, Vx(m - 1, s), Vx(m - 1, s + 1), 1, hl, !!f.flat); }
      }

      const EMIT = { blob: emitBlob, tier: emitTier, cluster: emitCluster, fronds: emitFronds, lathe: emitLathe };

      const hasThickBranches = R.branches.some(br => (br.r || 0.025) >= 0.015);
      if (lod === 0 || isSnagModel) {
        R.branches.forEach((b, bIdx) => {
          if (lod === 2 && hasThickBranches && (b.r || 0.025) < 0.015) return;
          const hl = !!(sel && sel.type === 'branch' && sel.idx === bIdx);
          const nodes = b.nodes; if (!nodes || nodes.length < 2) return;
          radial(b.radial, b.radialPhase, () => {
            let pts = nodes.map(n => [n.x, n.y, n.z]);
            if (lod === 2 && pts.length > 2) pts = [pts[0], pts[pts.length - 1]];
            let total = 0; const cum = [0];
            for (let i = 1; i < pts.length; i++) { total += Math.hypot(...sub(pts[i], pts[i - 1])); cum.push(total); }
            const tip = b.taper != null ? b.taper : 0.35;
            const rad = cum.map(c => Math.max(0.003, b.r * (1 - (1 - tip) * (total ? c / total : 0))));
            const sm = lod === 0 ? (b.smooth | 0) : 0;
            const sp = smoothPath(pts, rad, sm);
            tube(sp.pts, sp.rad, lod === 0 ? Math.max(3, b.sides || 4) : 3, 2, { flat: !!ST.flatTrunk, cap: lod < 2, hl: hl ? () => true : null });
          });
        });
      }

      R.branches.forEach((b, bIdx) => {
        const L = b.leaf; if (!L || L.kind === 'none' || !EMIT[L.kind]) return;
        const hl = !!(sel && sel.type === 'branch' && sel.idx === bIdx);
        const n = b.nodes[b.nodes.length - 1];
        const f = Object.assign({}, L, { x: n.x + (L.dx || 0), y: n.y + (L.dy || 0), z: n.z + (L.dz || 0) });
        radial(b.radial, b.radialPhase, () => EMIT[L.kind](f, hl));
      });

      R.foliage.forEach((f, fIdx) => {
        const fn = EMIT[f.type]; if (!fn) return;
        const hl = !!(sel && sel.type === 'foliage' && sel.idx === fIdx);
        radial(f.radial, f.radialPhase, () => fn(f, hl));
      });

      return new Float32Array(v);
    }


    function toMesh(recipe, lod) {
      const d = generate(recipe, lod, null), out = [];
      for (let i = 0; i < d.length; i += 9) {
        out.push(d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
      }
      return { v: out };
    }
    return { generate, toMesh, rng, hsh, nrm, rotatePoint, smoothPath, normalizeBranch, prepare, lerp };
  }

  const Core = createTreeCore();
  const { nrm, hsh, rotatePoint, normalizeBranch } = Core;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s / 100, 0, 1);
    l = clamp(l / 100, 0, 1);
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = t => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    return [hue2rgb(h + 1/3), hue2rgb(h), hue2rgb(h - 1/3)];
  }

  // ===========================================================================
  // 2. ПРОЦЕДУРНЫЙ ГЕНЕРАТОР
  // ===========================================================================
  const DEFAULT_GEN = {
    seed: 3, levels: 2, count: 6, startH: 0.35, endH: 0.92, spread: 62, spreadVar: 0.25,
    len: 0.45, lenDecay: 0.62, thick: 0.55, thickDecay: 0.6, nodes: 3, up: 0.35, grav: 0.2, curl: 0.35,
    kids: 2, leaf: 'blob', leafSize: 0.2, leafFlat: false, replaceFoliage: true, smooth: 1,
    tHeight: 0.62, tBase: 0.12, tTop: 0.35, tBend: 0.06, tWiggle: 0.4, tRings: 4, tFlare: 0.35
  };

  function trunkPointAt(recipe, y) {
    const rg = recipe.trunk.rings;
    if (y <= rg[0].y) return { x: rg[0].x, y, z: rg[0].z, r: rg[0].r };
    for (let i = 0; i < rg.length - 1; i++) {
      const a = rg[i], b = rg[i + 1];
      if (y <= b.y) { const t = (y - a.y) / Math.max(1e-6, b.y - a.y); return { x: Core.lerp(a.x, b.x, t), y, z: Core.lerp(a.z, b.z, t), r: Core.lerp(a.r, b.r, t) }; }
    }
    const l = rg[rg.length - 1]; return { x: l.x, y, z: l.z, r: l.r };
  }

  function generateTrunk(recipe, g) {
    const rnd = Core.rng(g.seed * 7.7 + 1), n = Math.max(2, g.tRings | 0), rings = [];
    const bd = rnd() * Math.PI * 2;
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      if (i > 0) { x += (Math.cos(bd) * g.tBend + (rnd() - 0.5) * g.tWiggle * 0.12) / (n - 1) * 2; z += (Math.sin(bd) * g.tBend + (rnd() - 0.5) * g.tWiggle * 0.12) / (n - 1) * 2; }
      rings.push({ x: +x.toFixed(3), y: +(t * g.tHeight).toFixed(3), z: +z.toFixed(3), r: +Math.max(0.006, Core.lerp(g.tBase, g.tBase * g.tTop, Math.pow(t, 0.85))).toFixed(3) });
    }
    recipe.trunk = Object.assign({}, recipe.trunk, { rings, flare: g.tFlare, flareH: 0.12, roots: 5, smooth: 1 });
  }

  function generateBranches(recipe, g) {
    const rnd = Core.rng(g.seed), rg = recipe.trunk.rings;
    const topY = rg[rg.length - 1].y, botY = rg[0].y, H = Math.max(0.1, topY - botY);
    const out = [], MAX = 140;
    const nodesN = Math.max(2, g.nodes | 0);

    const grow = (start, dir, len, r0, level, azBase) => {
      if (out.length >= MAX) return;
      const nodes = [{ x: start[0], y: start[1], z: start[2] }];
      let p = start.slice(), d = dir.slice();
      const step = len / (nodesN - 1), dirs = [d.slice()];
      for (let j = 1; j < nodesN; j++) {
        d = nrm([
          d[0] + g.curl * (rnd() - 0.5) * 0.7,
          d[1] + g.up * 0.28 - g.grav * 0.22 * (j / nodesN) + g.curl * (rnd() - 0.5) * 0.4,
          d[2] + g.curl * (rnd() - 0.5) * 0.7
        ]);
        p = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step];
        if (p[1] < 0.05) p[1] = 0.05;
        nodes.push({ x: +p[0].toFixed(3), y: +p[1].toFixed(3), z: +p[2].toFixed(3) });
        dirs.push(d.slice());
      }
      const isLast = level >= g.levels;
      const b = { r: +Math.max(0.006, Math.min(0.08, r0)).toFixed(3), taper: 0.3, sides: 4, smooth: g.smooth | 0, nodes };
      if (isLast && g.leaf !== 'none') {
        const sz = g.leafSize * (0.8 + 0.4 * rnd());
        const base = { kind: g.leaf, flat: !!g.leafFlat, seed: +(rnd() * 6).toFixed(2), rotY: +(rnd() * 6.28).toFixed(2) };
        if (g.leaf === 'blob') Object.assign(base, { rx: +sz.toFixed(3), ry: +(sz * 0.75).toFixed(3), rz: +sz.toFixed(3), seg: 8, rings: 4, lump: 0.06, taper: 0, dy: +(sz * 0.2).toFixed(3) });
        else if (g.leaf === 'cluster') Object.assign(base, { count: 4, rx: +(sz * 0.8).toFixed(3), ry: +(sz * 0.5).toFixed(3), smin: +(sz * 0.45).toFixed(3), smax: +(sz * 0.7).toFixed(3), seg: 7, rings: 3, lump: 0.05 });
        else if (g.leaf === 'tier') Object.assign(base, { h: +(sz * 1.2).toFixed(3), r: +(sz * 1.1).toFixed(3), seg: 8, rings: 1, jag: 0.7 });
        else if (g.leaf === 'fronds') Object.assign(base, { count: 5, len: +(sz * 1.6).toFixed(3), width: +(sz * 0.3).toFixed(3), tilt: 0.7, arch: 0.8, segs: 4 });
        b.leaf = base;
      }
      out.push(b);
      if (!isLast) {
        const kids = Math.max(1, g.kids | 0);
        for (let k = 0; k < kids; k++) {
          const ni = Math.min(nodesN - 1, 1 + Math.floor(((k + rnd() * 0.6) / kids) * (nodesN - 1)));
          const nd = nodes[ni], pd = dirs[ni];
          const az = (azBase || 0) + (k / kids) * 6.283 + rnd() * 1.2;
          const cd = nrm([pd[0] * 0.5 + Math.cos(az) * 0.9, pd[1] * 0.5 + 0.35 + (rnd() - 0.5) * 0.4, pd[2] * 0.5 + Math.sin(az) * 0.9]);
          grow([nd.x, nd.y, nd.z], cd, len * g.lenDecay * (0.85 + 0.3 * rnd()), r0 * g.thickDecay, level + 1, az);
        }
      }
    };

    const cnt = Math.max(1, g.count | 0);
    for (let i = 0; i < cnt; i++) {
      const t = Core.lerp(g.startH, g.endH, cnt === 1 ? 0.5 : i / (cnt - 1));
      const y = botY + H * t, tp = trunkPointAt(recipe, y);
      const az = i * 2.399963 + rnd() * 0.5;
      const el = (g.spread * Math.PI / 180) * (1 + (rnd() - 0.5) * 2 * g.spreadVar) * (0.75 + 0.35 * (1 - t));
      const dir = [Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az)];
      grow([tp.x, y, tp.z], dir, g.len * (1.05 - 0.4 * t) * (0.9 + 0.2 * rnd()), tp.r * g.thick, 1, az);
    }
    recipe.branches = out;
    if (g.replaceFoliage && g.leaf !== 'none') recipe.foliage = [];
  }

  // ===========================================================================
  // 3. ПРЕСЕТЫ И ЭКОЛОГИЯ
  // ===========================================================================
  const DEFAULT_TREE_ECO = {
    kind: 'deciduous',
    baseWeight: 1.0,
    seasons: 'all',
    deciduousWinter: true,
    colorShift: {
      enabled: false,
      earlySpring: { h: 82,  s: 65, l: 45 },
      spring:      { h: 105, s: 70, l: 38 },
      autumn:      { h: 38,  s: 88, l: 50 },
      lateAutumn:  { h: 20,  s: 78, l: 32 },
      winter:      { h: 160, s: 35, l: 24 }
    },
    weights: {
      nearWater: 0.0,
      waterDistM: 35.0,
      steepSlope: 0.0,
      slopeThresholdDeg: 28.0,
      shadeLove: 0.0,
      sunLove: 0.0,
      urban: 0.0,
      urbanDistM: 45.0
    }
  };

  const BASE_STYLE = {
    leaf: '#2d6e1e', leaf2: '#86c14a', leafGrad: 'y',
    wood: '#4d3322', wood2: '#2a1a10',
    branch: '#5c3d28', branch2: '#7d5638'
  };

  function extractJsonTreePack(text) {
    if (!text || typeof text !== 'string') return [];
    const results = [];
    let depth = 0, startIdx = -1, inString = false, escape = false;
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          const candidate = cleaned.slice(startIdx, i + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && (obj.trunk || obj.foliage || obj.name)) {
              results.push(cleanSparseRecipe(ensureRecipe(obj)));
            }
          } catch (e) {}
          startIdx = -1;
        }
      }
    }
    return results;
  }
  Core.extractJsonTreePack = extractJsonTreePack;

  function ensureRecipe(r) {
    r = r || {};
    r.name = r.name || 'Моё дерево';
    r.eco = Object.assign({}, DEFAULT_TREE_ECO, r.eco || {});
    r.eco.weights = Object.assign({}, DEFAULT_TREE_ECO.weights, r.eco.weights || {});
    r.eco.colorShift = Object.assign({}, DEFAULT_TREE_ECO.colorShift, r.eco.colorShift || {});
    r.trunk = r.trunk || { seg: 8, rings: [{ x: 0, y: 0, z: 0, r: 0.1 }, { x: 0, y: 0.5, z: 0, r: 0.05 }] };
    if (r.trunk.rings) {
      r.trunk.rings = r.trunk.rings.map(pt => Array.isArray(pt) 
        ? { x: pt[0] != null ? pt[0] : 0, y: pt[1] != null ? pt[1] : 0, z: pt[2] != null ? pt[2] : 0, r: pt[3] != null ? pt[3] : 0.05 } 
        : pt);
    }
    r.stems = (r.stems || []).map(s => {
      if (s.rings) {
        s.rings = s.rings.map(pt => Array.isArray(pt) 
          ? { x: pt[0] != null ? pt[0] : 0, y: pt[1] != null ? pt[1] : 0, z: pt[2] != null ? pt[2] : 0, r: pt[3] != null ? pt[3] : 0.05 } 
          : pt);
      }
      return s;
    });
    r.branches = (r.branches || []).map(normalizeBranch);
    r.foliage = r.foliage || [];
    r.style = Object.assign({}, BASE_STYLE, r.style || {});
    return r;
  }

  const DEFAULT_PRESETS = {};
  if (Array.isArray(WM.defaultTreePresets) && WM.defaultTreePresets.length) {
    WM.defaultTreePresets.forEach((preset, idx) => {
      DEFAULT_PRESETS['preset_' + idx] = preset;
    });
  } else {
    DEFAULT_PRESETS.default_oak = {
      name: '🌳 Дуб по умолчанию',
      trunk: { seg: 8, rings: [[0, 0, 0, 0.14], [0.02, 0.26, 0.01, 0.1], [0, 0.52, 0, 0.07]] },
      foliage: [{ type: 'blob', y: 0.7, rx: 0.74, ry: 0.48 }]
    };
  }

  DEFAULT_PRESETS.palm = {
    name: '🌴 Пальма (fronds)',
    trunk: { seg: 7, smooth: 2, flare: 0.5, flareH: 0.1, roots: 0, rough: 0.12, rings: [
      { x: 0, y: 0, z: 0, r: 0.07 }, { x: 0.04, y: 0.3, z: 0.00, r: 0.045 }, { x: 0.10, y: 0.58, z: 0.03, r: 0.04 }, { x: 0.12, y: 0.82, z: 0.05, r: 0.038 }] },
    branches: [],
    foliage: [
      { type: 'fronds', x: 0.12, y: 0.82, z: 0.05, count: 10, len: 0.7, width: 0.12, tilt: 0.55, arch: 1.0, segs: 5, fold: 0.5, jitter: 0.3, seed: 2.1, rotX: 0, rotY: 0, rotZ: 0 },
      { type: 'fronds', x: 0.12, y: 0.84, z: 0.05, count: 6, len: 0.46, width: 0.09, tilt: 0.2, arch: 0.7, segs: 4, fold: 0.5, jitter: 0.3, seed: 5.3 },
      { type: 'blob', x: 0.12, y: 0.78, z: 0.05, rx: 0.05, ry: 0.05, rz: 0.05, seg: 6, rings: 3, lump: 0.1, taper: 0, seed: 1 }
    ],
    style: { leaf: '#2f8f3a', leaf2: '#8bc34a', wood: '#7a5a3a', branch: '#6b4526' }
  };

  DEFAULT_PRESETS.acacia = {
    name: '🦒 Акация-зонтик (lathe)',
    trunk: { seg: 7, smooth: 2, flare: 0.3, flareH: 0.1, roots: 4, rings: [
      { x: 0, y: 0, z: 0, r: 0.07 }, { x: 0.03, y: 0.25, z: 0.0, r: 0.05 }, { x: -0.02, y: 0.5, z: 0.02, r: 0.04 }] },
    branches: [
      { r: 0.03, taper: 0.4, sides: 5, smooth: 2, nodes: [{ x: -0.02, y: 0.46, z: 0.02 }, { x: -0.22, y: 0.6, z: 0.05 }, { x: -0.4, y: 0.66, z: 0.08 }] },
      { r: 0.03, taper: 0.4, sides: 5, smooth: 2, nodes: [{ x: -0.02, y: 0.48, z: 0.02 }, { x: 0.24, y: 0.62, z: -0.04 }, { x: 0.42, y: 0.68, z: -0.08 }] }
    ],
    foliage: [
      { type: 'lathe', x: 0, y: 0.66, z: 0, seg: 14, smooth: 1, lump: 0.05, lobes: 7, scallop: 0.12, seed: 1.4, rotX: 0, rotY: 0, rotZ: 0,
        profile: [[0, 0.0], [0.3, -0.03], [0.62, 0.0], [0.74, 0.06], [0.58, 0.13], [0.25, 0.17], [0, 0.17]] },
      { type: 'lathe', x: -0.4, y: 0.62, z: 0.08, seg: 10, smooth: 1, lump: 0.05, seed: 2.4, sc: 0.6, profile: [[0, 0.0], [0.4, -0.03], [0.7, 0.05], [0.5, 0.13], [0, 0.16]] }
    ],
    style: { leaf: '#6f9a2b', leaf2: '#b5c64a', wood: '#5d4630', branch: '#5d4630', normalBlend: 0.35 }
  };

  DEFAULT_PRESETS.lowpoly = {
    name: '🔷 Low-poly дерево (flat)',
    trunk: { seg: 5, rings: [{ x: 0, y: 0, z: 0, r: 0.07 }, { x: 0.01, y: 0.3, z: 0, r: 0.05 }, { x: 0, y: 0.5, z: 0, r: 0.04 }] },
    branches: [],
    foliage: [
      { type: 'cluster', x: 0, y: 0.72, z: 0, count: 6, rx: 0.32, ry: 0.26, rz: 0.32, smin: 0.2, smax: 0.32, seg: 5, rings: 3, lump: 0.12, seed: 3.3, flat: true, puffY: 0.9 }
    ],
    style: { flatTrunk: true, leaf: '#4caf50', leaf2: '#a5d66a', wood: '#7b5a3c', branch: '#7b5a3c' }
  };

  DEFAULT_PRESETS.cherry = {
    name: '🌸 Сакура (cluster, мягкие нормали)',
    trunk: { seg: 8, smooth: 2, flare: 0.25, roots: 4, rough: 0.1, rings: [
      { x: 0, y: 0, z: 0, r: 0.08 }, { x: -0.05, y: 0.22, z: 0.02, r: 0.06 }, { x: 0.02, y: 0.42, z: -0.02, r: 0.045 }, { x: 0.05, y: 0.55, z: 0, r: 0.035 }] },
    branches: [
      { r: 0.032, taper: 0.35, sides: 5, smooth: 2, nodes: [{ x: 0.0, y: 0.42, z: 0 }, { x: -0.26, y: 0.58, z: 0.1 }, { x: -0.46, y: 0.62, z: 0.18 }] },
      { r: 0.03, taper: 0.35, sides: 5, smooth: 2, nodes: [{ x: 0.03, y: 0.48, z: 0 }, { x: 0.28, y: 0.64, z: -0.1 }, { x: 0.48, y: 0.7, z: -0.16 }] }
    ],
    foliage: [
      { type: 'cluster', x: 0, y: 0.78, z: 0, count: 9, rx: 0.5, ry: 0.28, rz: 0.5, smin: 0.2, smax: 0.34, seg: 8, rings: 4, lump: 0.08, seed: 4.2, rotX: 0, rotY: 0, rotZ: 0 },
      { type: 'cluster', x: -0.46, y: 0.62, z: 0.18, count: 4, rx: 0.2, ry: 0.12, rz: 0.2, smin: 0.14, smax: 0.2, seg: 7, rings: 3, lump: 0.08, seed: 1.1 },
      { type: 'cluster', x: 0.48, y: 0.7, z: -0.16, count: 4, rx: 0.2, ry: 0.12, rz: 0.2, smin: 0.14, smax: 0.2, seg: 7, rings: 3, lump: 0.08, seed: 6.1 }
    ],
    style: { leaf: '#f08fb4', leaf2: '#ffd6e4', wood: '#4a3328', branch: '#4a3328', normalBlend: 0.6 }
  };

  DEFAULT_PRESETS.baobab = {
    name: '🐘 Баобаб (толстый ствол + корни)',
    trunk: { seg: 12, smooth: 2, flare: 0.5, flareH: 0.16, roots: 6, rough: 0.1, rings: [
      { x: 0, y: 0, z: 0, r: 0.2 }, { x: 0, y: 0.2, z: 0, r: 0.17 }, { x: 0, y: 0.42, z: 0, r: 0.15 }, { x: 0, y: 0.58, z: 0, r: 0.1 }] },
    branches: [
      { r: 0.04, taper: 0.3, sides: 5, smooth: 2, radial: 5, nodes: [{ x: 0, y: 0.56, z: 0 }, { x: 0.18, y: 0.7, z: 0.0 }, { x: 0.34, y: 0.8, z: 0.0 }],
        leaf: { kind: 'cluster', count: 3, rx: 0.12, ry: 0.07, smin: 0.12, smax: 0.17, seg: 7, rings: 3, lump: 0.06, seed: 1.3, dy: 0.04 } }
    ],
    foliage: [],
    style: { leaf: '#5d9a35', leaf2: '#9ccc58', wood: '#8a6d52', branch: '#7a5c44', normalBlend: 0.3 }
  };

  DEFAULT_PRESETS.mushroom = {
    name: '🍄 Гриб-дерево (lathe, фэнтези)',
    trunk: { seg: 9, smooth: 2, flare: 0.4, roots: 0, rings: [{ x: 0, y: 0, z: 0, r: 0.09 }, { x: 0.02, y: 0.3, z: 0, r: 0.055 }, { x: 0, y: 0.55, z: 0, r: 0.05 }] },
    branches: [],
    foliage: [
      { type: 'lathe', x: 0, y: 0.52, z: 0, seg: 16, smooth: 1, lump: 0.03, seed: 0.5, capBottom: true,
        profile: [[0, 0.0], [0.2, -0.02], [0.55, 0.0], [0.72, 0.1], [0.62, 0.22], [0.3, 0.3], [0, 0.32]] }
    ],
    style: { leaf: '#d6402b', leaf2: '#f08a5d', wood: '#e8dcc4', branch: '#e8dcc4', normalBlend: 0.2 }
  };

  DEFAULT_PRESETS.spiral_fantasy = {
    name: '🌀 Спиральное фэнтези (twist + radial)',
    trunk: { seg: 6, smooth: 3, twist: 2.2, flare: 0.3, roots: 3, rings: [{ x: 0, y: 0, z: 0, r: 0.1 }, { x: 0.04, y: 0.3, z: 0, r: 0.07 }, { x: -0.03, y: 0.6, z: 0.03, r: 0.045 }, { x: 0, y: 0.9, z: 0, r: 0.02 }] },
    branches: [],
    foliage: [
      { type: 'tier', x: 0, y: 0.55, z: 0, h: 0.28, r: 0.4, seg: 10, rings: 2, droop: 0.4, curve: 0.3, lobes: 6, scallop: 0.3, jag: 1, radial: 3, radialPhase: 0.4, rotX: 0.35, rotY: 0.2, rotZ: 0, flat: true },
      { type: 'blob', x: 0, y: 0.98, z: 0, rx: 0.16, ry: 0.16, rz: 0.16, seg: 6, rings: 4, lump: 0.1, taper: 0, seed: 2, flat: true }
    ],
    style: { flatTrunk: true, leaf: '#8f5be8', leaf2: '#5ee0d0', wood: '#3b2a4a', branch: '#3b2a4a' }
  };

  (function () {
    const r = {
      name: '⚙️ Процедурный дуб (генератор)',
      trunk: { seg: 9, rings: [{ x: 0, y: 0, z: 0, r: 0.1 }, { x: 0, y: 0.5, z: 0, r: 0.04 }] },
      branches: [], foliage: [],
      style: { leaf: '#3f8f2a', leaf2: '#86bf4a', wood: '#4d3322', branch: '#5e4029', normalBlend: 0.45 },
      gen: Object.assign({}, DEFAULT_GEN, { seed: 7, count: 7, leaf: 'cluster', leafSize: 0.22, levels: 2, kids: 2, len: 0.5 })
    };
    generateTrunk(r, r.gen); generateBranches(r, r.gen);
    DEFAULT_PRESETS.proc_oak = r;
  })();

  // ===========================================================================
  // 4. ЭКСПОРТ
  // ===========================================================================
  function cleanSparseRecipe(r) {
    const out = {};
    if (r.name) out.name = r.name;
    if (r.eco) out.eco = JSON.parse(JSON.stringify(r.eco));

    if (r.trunk && r.trunk.rings) {
      out.trunk = {
        rings: r.trunk.rings.map(pt => Array.isArray(pt) ? pt : [
          +(pt.x || 0).toFixed(3),
          +(pt.y || 0).toFixed(3),
          +(pt.z || 0).toFixed(3),
          +(pt.r || 0.05).toFixed(3)
        ])
      };
      if (r.trunk.bark && r.trunk.bark.type && r.trunk.bark.type !== 'none') {
        const bk = Object.assign({}, r.trunk.bark);
        delete bk.col1;
        out.trunk.bark = bk;
      }
      if (r.trunk.seg && r.trunk.seg !== 7) out.trunk.seg = r.trunk.seg;
      if (r.trunk.smooth) out.trunk.smooth = r.trunk.smooth;
      if (r.trunk.flare) out.trunk.flare = +r.trunk.flare.toFixed(2);
      if (r.trunk.flareH) out.trunk.flareH = +r.trunk.flareH.toFixed(2);
      if (r.trunk.roots) out.trunk.roots = r.trunk.roots;
      if (r.trunk.rough) out.trunk.rough = +r.trunk.rough.toFixed(2);
      if (r.trunk.twist) out.trunk.twist = +r.trunk.twist.toFixed(2);
      if (r.trunk.flat) out.trunk.flat = true;
    }

    if (r.stems && r.stems.length) {
      out.stems = JSON.parse(JSON.stringify(r.stems));
    }

    if (r.branches && r.branches.length) {
      out.branches = r.branches.map(b => {
        const nb = { r: +b.r.toFixed(3) };
        if (b.smooth) nb.smooth = b.smooth;
        if (b.sides && b.sides !== 4) nb.sides = b.sides;
        if (b.taper != null && b.taper !== 0.35) nb.taper = +b.taper.toFixed(2);
        if (b.radial && b.radial > 1) nb.radial = b.radial;
        if (b.radialPhase) nb.radialPhase = +b.radialPhase.toFixed(2);
        nb.nodes = b.nodes.map(n => Array.isArray(n) ? n : [+(n.x || 0).toFixed(3), +(n.y || 0).toFixed(3), +(n.z || 0).toFixed(3)]);
        if (b.leaf && b.leaf.kind && b.leaf.kind !== 'none') nb.leaf = JSON.parse(JSON.stringify(b.leaf));
        return nb;
      });
    }

    if (r.foliage && r.foliage.length) {
      out.foliage = r.foliage.map(f => {
        const nf = { type: f.type || 'blob' };
        if (f.x) nf.x = +f.x.toFixed(3);
        if (f.y) nf.y = +f.y.toFixed(3);
        if (f.z) nf.z = +f.z.toFixed(3);
        if (f.rotX) nf.rotX = +f.rotX.toFixed(2);
        if (f.rotY) nf.rotY = +f.rotY.toFixed(2);
        if (f.rotZ) nf.rotZ = +f.rotZ.toFixed(2);
        if (f.sc && f.sc !== 1) nf.sc = +f.sc.toFixed(2);

        if (f.type === 'tier') {
          if (f.h) nf.h = +f.h.toFixed(2);
          if (f.r) nf.r = +f.r.toFixed(2);
          if (f.droop) nf.droop = +f.droop.toFixed(2);
          if (f.curve) nf.curve = +f.curve.toFixed(2);
          if (f.arch) nf.arch = +f.arch.toFixed(2);
          if (f.tuck) nf.tuck = +f.tuck.toFixed(2);
          if (f.capBottom) nf.capBottom = true;
          if (f.lobes) nf.lobes = f.lobes;
          if (f.scallop) nf.scallop = +f.scallop.toFixed(2);
          if (f.jag != null && f.jag !== 1) nf.jag = +f.jag.toFixed(2);
          if (f.seg) nf.seg = f.seg;
          if (f.rings) nf.rings = f.rings;
        } else if (f.type === 'fronds') {
          if (f.count) nf.count = f.count;
          if (f.len) nf.len = +f.len.toFixed(2);
          if (f.width) nf.width = +f.width.toFixed(2);
          if (f.tilt != null) nf.tilt = +f.tilt.toFixed(2);
          if (f.arch != null) nf.arch = +f.arch.toFixed(2);
          if (f.segs) nf.segs = f.segs;
          if (f.fold != null) nf.fold = +f.fold.toFixed(2);
          if (f.jitter != null) nf.jitter = +f.jitter.toFixed(2);
          if (f.seed) nf.seed = +f.seed.toFixed(2);
        } else if (f.type === 'lathe') {
          if (f.profile) nf.profile = f.profile;
          if (f.seg) nf.seg = f.seg;
          if (f.smooth) nf.smooth = f.smooth;
          if (f.lump) nf.lump = +f.lump.toFixed(2);
          if (f.lobes) nf.lobes = f.lobes;
          if (f.scallop) nf.scallop = +f.scallop.toFixed(2);
          if (f.seed) nf.seed = +f.seed.toFixed(2);
          if (f.capBottom !== false) nf.capBottom = f.capBottom;
          if (f.capTop !== false) nf.capTop = f.capTop;
        } else if (f.type === 'cluster') {
          if (f.count) nf.count = f.count;
          if (f.rx) nf.rx = +f.rx.toFixed(2);
          if (f.ry) nf.ry = +f.ry.toFixed(2);
          if (f.rz) nf.rz = +f.rz.toFixed(2);
          if (f.smin) nf.smin = +f.smin.toFixed(2);
          if (f.smax) nf.smax = +f.smax.toFixed(2);
          if (f.puffY) nf.puffY = +f.puffY.toFixed(2);
          if (f.lump) nf.lump = +f.lump.toFixed(2);
          if (f.seg) nf.seg = f.seg;
          if (f.rings) nf.rings = f.rings;
          if (f.seed) nf.seed = +f.seed.toFixed(2);
        } else {
          if (f.rx) nf.rx = +f.rx.toFixed(2);
          if (f.ry && f.ry !== f.rx) nf.ry = +f.ry.toFixed(2);
          if (f.rz && f.rz !== f.rx) nf.rz = +f.rz.toFixed(2);
          if (f.taper) nf.taper = +f.taper.toFixed(2);
          if (f.lump) nf.lump = +f.lump.toFixed(2);
          if (f.seg) nf.seg = f.seg;
          if (f.rings) nf.rings = f.rings;
          if (f.seed) nf.seed = +f.seed.toFixed(2);
        }
        if (f.radial && f.radial > 1) nf.radial = f.radial;
        if (f.radialPhase) nf.radialPhase = +f.radialPhase.toFixed(2);
        if (f.flat) nf.flat = true;
        return nf;
      });
    }

    if (r.style) {
      out.style = {
        wood: r.style.wood || '#4d3322',
        wood2: r.style.wood2 || r.style.wood || '#2a1a10',
        branch: r.style.branch || r.style.wood || '#5c3d28',
        branch2: r.style.branch2 || r.style.branch || '#7d5638',
        leaf: r.style.leaf || '#2d6e1e',
        leaf2: r.style.leaf2 || '#86c14a',
        leafGrad: r.style.leafGrad || 'y'
      };
      if (r.style.normalBlend) out.style.normalBlend = +r.style.normalBlend.toFixed(2);
      if (r.style.flatTrunk) out.style.flatTrunk = true;
    }

    return out;
  }

  function generateJsCode(recipe) {
    const sparse = cleanSparseRecipe(recipe);
    return `// --- ${recipe.name || 'Пользовательское дерево'} ---
// Скопируйте или сохраните этот код. Вы можете собрать много деревьев в один файл и использовать их как пресет
${JSON.stringify(sparse, null, 2)}`;
  }

  function generateObj(recipe, scale) {
    const d = Core.toMesh(recipe, 0).v, names = ['trunk', 'leaves', 'branches'];
    const groups = [[], [], []];
    for (let i = 0; i < d.length; i += 24) groups[Math.max(0, Math.min(2, Math.round(d[i + 6])))].push(i);
    let out = '# Tree exported from Slice3D tree editor\n', vi = 1;
    groups.forEach((g, gi) => {
      if (!g.length) return;
      out += `o ${names[gi]}\ng ${names[gi]}\n`;
      let vs = '', ns = '', fs = '';
      g.forEach(i => {
        for (let k = 0; k < 3; k++) {
          const o = i + k * 8;
          vs += `v ${(d[o] * scale).toFixed(5)} ${(d[o + 1] * scale).toFixed(5)} ${(d[o + 2] * scale).toFixed(5)}\n`;
          ns += `vn ${d[o + 3].toFixed(4)} ${d[o + 4].toFixed(4)} ${d[o + 5].toFixed(4)}\n`;
        }
        fs += `f ${vi}//${vi} ${vi + 1}//${vi + 1} ${vi + 2}//${vi + 2}\n`; vi += 3;
      });
      out += vs + ns + fs;
    });
    return out;
  }

  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ===========================================================================
  // 5. HELPERS И CSS
  // ===========================================================================
  function generateHelpersMesh() {
    const v = [];
    const pushL = (x, y, z, r, g, b) => v.push(x, y, z, r, g, b);

    for (let i = -6; i <= 6; i++) {
      const coord = i * 0.2, isMain = (i === 0);
      const r = isMain ? 0.35 : 0.18, g = isMain ? 0.45 : 0.22, b = isMain ? 0.55 : 0.28;
      pushL(coord, 0, -1.2, r, g, b); pushL(coord, 0, 1.2, r, g, b);
      pushL(-1.2, 0, coord, r, g, b); pushL(1.2, 0, coord, r, g, b);
    }

    const hx = 0.95, hz = 0.0, bodyH = 0.15, hr = 0.38, hg = 0.72, hb = 0.95;
    pushL(hx, 0, hz, hr, hg, hb); pushL(hx, bodyH * 0.5, hz, hr, hg, hb);
    pushL(hx, bodyH * 0.5, hz, hr, hg, hb); pushL(hx, bodyH * 0.85, hz, hr, hg, hb);
    pushL(hx - 0.025, bodyH * 0.75, hz, hr, hg, hb); pushL(hx + 0.025, bodyH * 0.75, hz, hr, hg, hb);
    pushL(hx, bodyH * 0.85, hz, hr, hg, hb); pushL(hx - 0.015, bodyH * 0.92, hz, hr, hg, hb);
    pushL(hx - 0.015, bodyH * 0.92, hz, hr, hg, hb); pushL(hx, bodyH, hz, hr, hg, hb);
    pushL(hx, bodyH, hz, hr, hg, hb); pushL(hx + 0.015, bodyH * 0.92, hz, hr, hg, hb);
    pushL(hx + 0.015, bodyH * 0.92, hz, hr, hg, hb); pushL(hx, bodyH * 0.85, hz, hr, hg, hb);

    return new Float32Array(v);
  }

  const CSS = `
.te-modal{position:fixed;inset:20px;background:#0d1117;border:1px solid #30363d;border-radius:12px;box-shadow:0 30px 90px rgba(0,0,0,.9);z-index:99999;display:flex;flex-direction:column;font:13px/1.4 system-ui,-apple-system,sans-serif;color:#c9d1d9;overflow:hidden}
.te-head{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;gap:8px}
.te-head-left{display:flex;align-items:center;gap:6px;flex-shrink:0}
.te-head-left b{font-size:13px;color:#f0f6fc;display:flex;align-items:center;gap:6px;white-space:nowrap}
.te-head-center{display:flex;align-items:center;gap:6px;flex:1;justify-content:center;min-width:0}
.te-head-right{display:flex;align-items:center;gap:5px;flex-shrink:0}
.te-body{flex:1;min-height:0;display:flex}
.te-viewport{flex:1;position:relative;background:#090d13}
.te-viewport canvas{width:100%;height:100%;display:block;touch-action:none}
.te-side{width:440px;background:#161b22;border-left:1px solid #30363d;display:flex;flex-direction:column}
.te-tabs{display:flex;background:#0d1117;border-bottom:1px solid #30363d}
.te-tab{flex:1;padding:10px 4px;text-align:center;cursor:pointer;color:#8b949e;font-weight:600;font-size:12.5px;border-bottom:2px solid transparent}
.te-tab.act{color:#58a6ff;border-bottom-color:#58a6ff;background:#161b22}
.te-content{flex:1;overflow-y:auto;padding:12px}
.te-sec{background:#21262d;border:1px solid #30363d;border-radius:8px;padding:10px;margin-bottom:10px}
.te-sec.active-item{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff}
.te-sec-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.te-sec-head b{font-size:12px;text-transform:uppercase;color:#58a6ff;letter-spacing:.04em}
.te-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.te-row label{flex:0 0 115px;font-size:12px;color:#8b949e}
.te-row input[type=range]{flex:1;accent-color:#58a6ff;height:5px}
.te-val{flex:0 0 46px;text-align:right;font-family:monospace;font-size:12px;color:#f0f6fc}
.te-badge{position:absolute;left:12px;bottom:12px;background:rgba(13,17,23,.85);backdrop-filter:blur(8px);border:1px solid #30363d;padding:6px 14px;border-radius:8px;font-family:monospace;font-size:11.5px;pointer-events:none;color:#8b949e}
.te-badge b{color:#58a6ff}
.te-sim-bar{position:absolute;left:12px;top:12px;background:rgba(22,27,34,.9);backdrop-filter:blur(8px);border:1px solid #30363d;padding:8px 12px;border-radius:8px;display:flex;flex-direction:column;gap:6px;width:240px}
.te-sim-bar h5{margin:0;font-size:11px;text-transform:uppercase;color:#8b949e;letter-spacing:.05em}
.te-btn{background:#238636;color:#fff;border:1px solid rgba(240,246,252,.1);padding:5px 10px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap}
.te-btn:hover{background:#2ea043}
.te-btn.sm{padding:2px 7px;font-size:11px;height:24px}
.te-btn.danger{background:#da3633}.te-btn.danger:hover{background:#f85149}
.te-btn.sec{background:#30363d;color:#c9d1d9}.te-btn.sec:hover{background:#3c444d}
.te-btn.act{background:#1f6feb;color:#fff;border-color:#58a6ff}
.te-code{width:100%;height:320px;background:#090d13;color:#79c0ff;border:1px solid #30363d;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;padding:8px;resize:none;box-sizing:border-box}
.te-sub-node{border-left:2px solid #388bfd;padding-left:8px;margin:6px 0 6px 4px;background:rgba(56,139,253,0.04);border-radius:0 6px 6px 0}
.te-row select,.te-sec select{flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;padding:3px 6px;font-size:12px}
.te-num{flex:0 0 58px;width:58px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;border-radius:4px;padding:2px 4px;font:12px monospace;text-align:right;box-sizing:border-box}
.te-row input[type=color]{flex:0 0 40px;height:22px;padding:0;border:1px solid #30363d;background:none;border-radius:4px}
.te-row input[type=checkbox]{accent-color:#58a6ff}
.te-sec.collapsed{cursor:pointer;padding:6px 10px}
.te-sec.collapsed .te-sec-head{margin-bottom:0}
.te-sec.collapsed:hover{border-color:#484f58}
.te-cam{position:absolute;right:12px;top:12px;display:flex;gap:4px;background:rgba(22,27,34,.9);border:1px solid #30363d;padding:5px;border-radius:8px}
.te-hint{font-size:11px;color:#8b949e;margin:0 0 8px;line-height:1.45}
.te-warn{color:#f0883e}
.te-sec textarea.te-code.json{height:150px;color:#a5d6ff}
.te-grp{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8b949e;margin:10px 0 6px}
.te-source-badge{font-size:11px;padding:2px 7px;border-radius:5px;font-weight:600;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;cursor:help}
.te-source-badge.on-map{background:rgba(63,185,80,0.15);border:1px solid rgba(63,185,80,0.4);color:#3fb950}
.te-source-badge.not-on-map{background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.4);color:#e3b341}
.te-dropdown{position:relative;display:inline-block}
.te-dropdown-menu{display:none;position:absolute;top:100%;left:0;margin-top:4px;background:#161b22;border:1px solid #30363d;border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,0.7);z-index:1000;min-width:230px;padding:4px;flex-direction:column;gap:2px}
.te-dropdown.open .te-dropdown-menu{display:flex}
.te-dropdown-item{background:none;border:none;color:#c9d1d9;text-align:left;padding:6px 10px;font-size:12px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box}
.te-dropdown-item:hover:not(:disabled){background:#21262d;color:#58a6ff}
.te-dropdown-item:disabled{opacity:0.4;cursor:not-allowed}
.te-toast{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(13,17,23,0.95);border:1px solid #3fb950;color:#3fb950;padding:8px 16px;border-radius:8px;font-weight:600;font-size:12.5px;z-index:100;opacity:0;pointer-events:none;transition:opacity 0.25s,transform 0.25s;box-shadow:0 8px 24px rgba(0,0,0,0.6)}
.te-toast.on{opacity:1;transform:translateX(-50%) translateY(4px)}
`;

  // ===========================================================================
  // 6. СОСТОЯНИЕ РЕДАКТОРА
  // ===========================================================================
  const clone = o => JSON.parse(JSON.stringify(o));

  let currentRecipe = ensureRecipe(clone(
    (Array.isArray(WM.defaultTreePresets) && WM.defaultTreePresets[0]) ||
    Object.values(DEFAULT_PRESETS)[0]
  ));
  let history = [JSON.stringify(currentRecipe)];
  let historyIdx = 0;

  let activeTab = 'trunk';
  let activeSelection = null;
  let liveGen = true;
  let codeMode = 'standalone';
  let objScale = 12;
  let currentTarget = { mode: 'slot', slot: 0 };
  let activeSyncToSlice3D = null;

  let editorWin = null, onKey = null, resizeObs = null, autoRotId = 0, autoRotate = false;
  let gl, prog, uVP, uWire, uLightDir, uSeason, uLeaf1, uLeaf2, uWood1, uWood2, uBranch1, uBranch2, uMaxH;
  let uBarkType, uBarkParams, uBarkCol2, uBarkColBase;
  let helperProg, uHelperVP;

  let vao, vbo, hVao, hVbo;
  let camYaw = 0.6, camPitch = 0.35, camDist = 2.4, camTarget = [0.0, 0.55, 0.0];
  let isWireframe = false, showHelpers = true, curLOD = 0;
  let vertCount = 0, drawCount = 0, helperVertCount = 0, lastMaxH = 1, updQueued = false;
  let lastBBox = { mn: [-0.5, 0, -0.5], mx: [0.5, 1, 0.5] };

  const sim = {
    leaf: 1.0,
    autumn: 0.0,
    snow: 0.0,
    seasonMode: 'summer',
    seasonProgress: 1.0
  };

  function recalcSimState() {
    const mode = sim.seasonMode;
    const k = sim.seasonProgress;
    const eco = (currentRecipe && currentRecipe.eco) || DEFAULT_TREE_ECO;
    const isAllSeasons = (eco.seasons === 'all' || !eco.seasons);
    const shouldDropLeaves = isAllSeasons ? (eco.deciduousWinter !== false) : true;

    if (mode === 'earlySpring') {
      sim.leaf = shouldDropLeaves ? lerp(1.0, 0.35, k) : 1.0;
      sim.autumn = 0.0;
    } else if (mode === 'spring') {
      sim.leaf = 1.0;
      sim.autumn = 0.0;
    } else if (mode === 'autumn') {
      sim.leaf = 1.0;
      sim.autumn = k;
    } else if (mode === 'lateAutumn') {
      sim.leaf = shouldDropLeaves ? lerp(1.0, 0.25, k) : 1.0;
      sim.autumn = k;
    } else if (mode === 'winter') {
      sim.leaf = shouldDropLeaves ? lerp(1.0, 0.0, k) : 1.0;
      sim.autumn = 0.0;
    } else {
      sim.leaf = 1.0;
      sim.autumn = 0.0;
    }

    if (editorWin) {
      const v = editorWin.querySelector('#sim-season-v');
      if (v) v.textContent = Math.round(k * 100) + '%';
    }
    renderFrame();
  }

  function pushHistory() {
    const s = JSON.stringify(currentRecipe);
    if (history[historyIdx] === s) return;
    history = history.slice(0, historyIdx + 1);
    history.push(s);
    if (history.length > 60) history.shift();
    historyIdx = history.length - 1;
    updateUndoRedoBtns();
  }

  function restoreHistory() {
    currentRecipe = ensureRecipe(JSON.parse(history[historyIdx]));
    activeSelection = null;
    renderInspector(activeTab); updateMesh(); updateUndoRedoBtns();
  }

  function undo() { if (historyIdx > 0) { historyIdx--; restoreHistory(); } }
  function redo() { if (historyIdx < history.length - 1) { historyIdx++; restoreHistory(); } }

  function updateUndoRedoBtns() {
    if (!editorWin) return;
    const bu = editorWin.querySelector('#te-btn-undo'), br = editorWin.querySelector('#te-btn-redo');
    if (bu) bu.disabled = historyIdx <= 0;
    if (br) br.disabled = historyIdx >= history.length - 1;
  }

  function parseTreeJson(text) {
    if (!text || typeof text !== 'string') throw new Error('Пустой ввод');
    let cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').trim();
    const firstBrace = cleaned.indexOf('{'), lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Не найден JSON-объект { ... }');
    }
    return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
  }

  function loadRecipe(r, targetObj) {
    currentRecipe = ensureRecipe(clone(r));
    activeSelection = null;
    if (targetObj) currentTarget = targetObj;
    pushHistory();
    renderInspector(activeTab);
    updateMesh();
    frameCamera();
    updateActionBar();
  }

  const hex3 = h => { const n = parseInt((h || '#888888').replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

  // ===========================================================================
  // 7. WEBGL
  // ===========================================================================
  function initGL(canvas) {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) return false;

    const compile = (src, type) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[TreeEditor] shader:', gl.getShaderInfoLog(s));
      return s;
    };
    const link = (vsSrc, fsSrc) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(vsSrc, gl.VERTEX_SHADER)); gl.attachShader(p, compile(fsSrc, gl.FRAGMENT_SHADER));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('[TreeEditor] link:', gl.getProgramInfoLog(p));
      return p;
    };

    const vs = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPos;
    layout(location=1) in vec3 aNrm;
    layout(location=2) in float aPart;
    layout(location=3) in float aGrad;
    layout(location=4) in float aHl;
    uniform mat4 uVP;
    uniform vec4 uSeason;
    out vec3 vN; out float vPart; out float vGrad; out vec3 vPos; out float vHl; out vec2 vBarkUV;
    void main(){
      float rawPart = floor(aPart);
      float uCoord = (aPart - rawPart) * (1.0 / 0.999);
      vN = aNrm; vPart = rawPart; vGrad = aGrad; vHl = aHl;
      vBarkUV = vec2(uCoord, aGrad);
      vec3 p = aPos;
      if (vPart > 0.5 && vPart < 1.5 && uSeason.z > 0.05) {
        float up = max(0.0, aNrm.y);
        p += aNrm * (up * uSeason.z * 0.04);
        p.y += up * uSeason.z * 0.04;
      }
      vPos = p;
      gl_Position = uVP * vec4(p, 1.0);
    }`;

    const fs = `#version 300 es
    precision highp float;
    in vec3 vN; in float vPart; in float vGrad; in vec3 vPos; in float vHl; in vec2 vBarkUV;
    uniform bool uWire;
    uniform vec3 uLightDir;
    uniform vec4 uSeason;
    uniform vec3 uLeaf1, uLeaf2, uWood1, uWood2, uBranch1, uBranch2;

    uniform int uBarkType;
    uniform vec4 uBarkParams;
    uniform vec3 uBarkCol2, uBarkColBase;

    out vec4 fragColor;

    float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    vec3 calcBarkColor(vec3 baseCol) {
      if (uBarkType == 0) return baseCol;
      float scaleX = max(0.1, uBarkParams.x);
      float scaleY = max(0.1, uBarkParams.y);
      float density = clamp(uBarkParams.z, 0.05, 0.98);
      float baseDark = uBarkParams.w;

      if (uBarkType == 1) {
        float numCols = max(3.0, floor(scaleX * 6.0 + 0.5));
        float numRows = max(10.0, scaleY * 42.0);
        float uWarp = vBarkUV.x + sin(vBarkUV.y * 32.0) * 0.018;
        float rowId = floor(vBarkUV.y * numRows);
        float rowF = fract(vBarkUV.y * numRows) - 0.5;

        float colCoord = uWarp * numCols + bHash(vec2(rowId, 1.3)) * 3.5;
        float colId = floor(mod(colCoord, numCols));
        float colF = fract(colCoord) - 0.5;

        float rnd = bHash(vec2(colId, rowId));
        float lLen = mix(0.18, 0.48, bHash(vec2(rowId, colId * 2.1)));
        float dist = sqrt(pow(abs(colF) / lLen, 2.0) + pow(abs(rowF) * 3.0, 2.0));
        float lenticel = step(rnd, density) * (1.0 - smoothstep(0.4, 0.95, dist));

        float stripes = sin(vBarkUV.y * numRows * 3.1415 * 3.0) * 0.5 + 0.5;
        float grain = smoothstep(0.8, 0.98, stripes * bHash(vec2(floor(vBarkUV.x * 24.0), rowId)));

        vec3 bark = mix(baseCol, uBarkCol2, clamp(lenticel + grain * 0.5, 0.0, 1.0));

        if (baseDark > 0.01) {
          float crackNoise = sin(vBarkUV.x * 32.0) * 0.08 + sin(vBarkUV.x * 12.0 + vBarkUV.y * 10.0) * 0.05;
          float craggy = smoothstep(baseDark + crackNoise, 0.02, vBarkUV.y);
          float fissure = smoothstep(0.4, 0.85, abs(sin(vBarkUV.x * 22.0 + vBarkUV.y * 8.0)));
          bark = mix(bark, mix(uBarkColBase, uBarkCol2 * 0.7, fissure * 0.6), craggy);
        }
        return bark;
      }
      if (uBarkType == 2) {
        float rep = max(4.0, floor(scaleX * 16.0 + 0.5));
        float uW = vBarkUV.x * rep + sin(vBarkUV.y * 22.0 * scaleY) * 0.35;
        float crack = smoothstep(1.0 - density * 0.75, 1.0, abs(fract(uW) - 0.5) * 2.0);
        return mix(baseCol, uBarkCol2, crack);
      }
      if (uBarkType == 3) {
        float ring = abs(sin(vBarkUV.y * scaleY * 45.0 + sin(vBarkUV.x * 6.28) * 0.4));
        return mix(baseCol, uBarkCol2, smoothstep(1.0 - density * 0.5, 1.0, ring));
      }
      return baseCol;
    }

    void main(){
      if (vPart > 0.5 && vPart < 1.5 && uSeason.x < 0.05) discard;
      if (uWire) { fragColor = (vHl > 0.5) ? vec4(1.0,0.85,0.2,1.0) : vec4(0.35,0.75,1.0,1.0); return; }
      vec3 N = normalize(vN);
      vec3 L = normalize(uLightDir);
      float d = dot(N, L);
      float diff = max(d, 0.0);
      float wrap = clamp(d * 0.5 + 0.5, 0.0, 1.0);
      float t = clamp(vGrad, 0.0, 1.0);
      vec3 col;
      if (vPart > 0.5 && vPart < 1.5) {
        vec3 leafCol = mix(uLeaf1, uLeaf2, t);
        if (uSeason.z > 0.05) leafCol = mix(leafCol, vec3(0.92, 0.95, 1.0), smoothstep(0.2, 0.8, N.y) * uSeason.z);
        col = leafCol;
      } else if (vPart > 1.5) {
        col = mix(uBranch1, uBranch2, t);
      } else {
        col = calcBarkColor(mix(uWood1, uWood2, t));
      }
      if (vHl > 0.5) col = mix(col, vec3(1.0,0.85,0.2), 0.55);
      vec3 amb = col * mix(0.28, 0.42, N.y * 0.5 + 0.5);
      fragColor = vec4(col * (diff * 0.72 + wrap * 0.28) + amb, 1.0);
    }`;

    prog = link(vs, fs);
    uVP = gl.getUniformLocation(prog, 'uVP'); uWire = gl.getUniformLocation(prog, 'uWire');
    uLightDir = gl.getUniformLocation(prog, 'uLightDir'); uSeason = gl.getUniformLocation(prog, 'uSeason');
    uLeaf1 = gl.getUniformLocation(prog, 'uLeaf1'); uLeaf2 = gl.getUniformLocation(prog, 'uLeaf2');
    uMaxH = gl.getUniformLocation(prog, 'uMaxH');
    uWood1 = gl.getUniformLocation(prog, 'uWood1'); uWood2 = gl.getUniformLocation(prog, 'uWood2');
    uBranch1 = gl.getUniformLocation(prog, 'uBranch1'); uBranch2 = gl.getUniformLocation(prog, 'uBranch2');
    uBarkType = gl.getUniformLocation(prog, 'uBarkType'); uBarkParams = gl.getUniformLocation(prog, 'uBarkParams');
    uBarkCol2 = gl.getUniformLocation(prog, 'uBarkCol2'); uBarkColBase = gl.getUniformLocation(prog, 'uBarkColBase');

    vao = gl.createVertexArray(); vbo = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 36, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 28);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 36, 32);
    gl.bindVertexArray(null);

    helperProg = link(`#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPos; layout(location=1) in vec3 aCol;
    uniform mat4 uVP; out vec3 vCol;
    void main(){ vCol = aCol; gl_Position = uVP * vec4(aPos, 1.0); }`, `#version 300 es
    precision highp float;
    in vec3 vCol; out vec4 fragColor;
    void main(){ fragColor = vec4(vCol, 0.85); }`);
    uHelperVP = gl.getUniformLocation(helperProg, 'uVP');

    hVao = gl.createVertexArray(); hVbo = gl.createBuffer();
    gl.bindVertexArray(hVao); gl.bindBuffer(gl.ARRAY_BUFFER, hVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    const hData = generateHelpersMesh();
    helperVertCount = hData.length / 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, hVbo); gl.bufferData(gl.ARRAY_BUFFER, hData, gl.STATIC_DRAW);

    gl.enable(gl.DEPTH_TEST);
    return true;
  }

  function countUniqueVerts(d7) {
    const map = new Set(), n = d7.length / 7;
    for (let i = 0; i < n; i++) {
      let key = ''; const o = i * 7;
      for (let k = 0; k < 7; k++) key += Math.round(d7[o + k] * 1e5) + ',';
      map.add(key);
    }
    return map.size;
  }

  function updateMesh() {
    if (!gl || updQueued) return;
    updQueued = true;
    requestAnimationFrame(() => { updQueued = false; if (gl && editorWin) rebuildNow(); });
  }

  function rebuildNow() {
    const data = Core.generate(currentRecipe, curLOD, activeSelection);
    vertCount = data.length / 9;
    let drawData = data;
    if (isWireframe) {
      drawData = new Float32Array(vertCount * 2 * 9);
      for (let t = 0; t < vertCount; t += 3) for (let e = 0; e < 3; e++) {
        const a = (t + e) * 9, b = (t + (e + 1) % 3) * 9, o = (t * 2 + e * 2) * 9;
        for (let k = 0; k < 9; k++) { drawData[o + k] = data[a + k]; drawData[o + 9 + k] = data[b + k]; }
      }
    }
    drawCount = drawData.length / 9;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, drawData, gl.DYNAMIC_DRAW);

    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < data.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        if (data[i + k] < mn[k]) mn[k] = data[i + k];
        if (data[i + k] > mx[k]) mx[k] = data[i + k];
      }
    }
    if (!vertCount) { mn = [0, 0, 0]; mx = [0, 0.1, 0]; }
    lastMaxH = Math.max(0.2, mx[1]);
    lastBBox = { mn, mx };

    const badge = editorWin.querySelector('#te-stats');
    if (badge) {
      let uniq = '', warn = '';
      if (vertCount < 150000) {
        const d7 = new Float32Array(vertCount * 7);
        for (let i = 0; i < vertCount; i++) {
          for (let k = 0; k < 7; k++) d7[i * 7 + k] = data[i * 9 + k];
        }
        const u = countUniqueVerts(d7);
        if (u > 65535) warn = ' <span class="te-warn">⚠ >65535 вершин</span>';
        uniq = ` &bull; Вершин: <b>${u.toLocaleString()}</b>`;
      }
      badge.innerHTML = `LOD ${curLOD} &bull; Треугольников: <b>${(vertCount / 3).toLocaleString()}</b>${uniq} &bull; Высота: <b>${(mx[1] * 12).toFixed(1)} м</b> &bull; Ширина: <b>${(Math.max(mx[0] - mn[0], mx[2] - mn[2]) * 12).toFixed(1)} м</b>${warn}`;
    }
    syncCodeBoxes();
    renderFrame();

    if (typeof activeSyncToSlice3D === 'function') {
      activeSyncToSlice3D();
    }
  }

  function frameCamera() {
    const { mn, mx } = lastBBox;
    camTarget = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    camDist = Math.max(1.2, Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 2.1);
    renderFrame();
  }

  function renderFrame() {
    if (!gl || !editorWin) return;
    const cv = gl.canvas, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.06, 0.08, 0.11, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = [
      camTarget[0] + camDist * Math.cos(camPitch) * Math.sin(camYaw),
      camTarget[1] + camDist * Math.sin(camPitch),
      camTarget[2] + camDist * Math.cos(camPitch) * Math.cos(camYaw)
    ];
    const vp = new Float32Array(16), proj = new Float32Array(16), view = new Float32Array(16);
    const M4 = (WM.slice3d && WM.slice3d._internals && WM.slice3d._internals.M4) || {
      persp: (fovy, aspect, near, far, out) => {
        const f = 1.0 / Math.tan(fovy / 2), nf = 1 / (near - far);
        out.fill(0); out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = (2 * far * near) * nf;
      },
      lookAt: (eye, center, up, out) => {
        let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
        let len = 1 / (Math.hypot(z0, z1, z2) || 1); z0 *= len; z1 *= len; z2 *= len;
        let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
        len = 1 / (Math.hypot(x0, x1, x2) || 1); x0 *= len; x1 *= len; x2 *= len;
        let y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
        out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
        out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
        out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
        out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
        out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
        out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
        out[15] = 1;
      },
      mul: (a, b, out) => {
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            out[i * 4 + j] = a[j] * b[i * 4] + a[4 + j] * b[i * 4 + 1] + a[8 + j] * b[i * 4 + 2] + a[12 + j] * b[i * 4 + 3];
          }
        }
      }
    };

    M4.persp(45 * Math.PI / 180, w / h, 0.05, 50.0, proj);
    M4.lookAt(eye, camTarget, [0, 1, 0], view);
    M4.mul(proj, view, vp);

    if (showHelpers) {
      gl.useProgram(helperProg);
      gl.uniformMatrix4fv(uHelperVP, false, vp);
      gl.bindVertexArray(hVao);
      gl.drawArrays(gl.LINES, 0, helperVertCount);
    }

    const st = currentRecipe.style || BASE_STYLE;
    const eco = currentRecipe.eco || DEFAULT_TREE_ECO;
    const isAllSeasons = (eco.seasons === 'all' || !eco.seasons);
    const shouldDropLeaves = isAllSeasons ? (eco.deciduousWinter !== false) : true;
    const isWinterMode = (sim.seasonMode === 'winter');
    const csAll = eco.colorShift || DEFAULT_TREE_ECO.colorShift;
    const isColorShiftEnabled = !!(eco.colorShift && eco.colorShift.enabled);
    const cs = csAll[sim.seasonMode];

    let l1 = hex3(st.leaf);
    let l2 = hex3(st.leaf2 || st.leaf);

    if (isColorShiftEnabled && sim.seasonMode !== 'summer' && sim.seasonProgress > 0.001 && cs) {
      if (!isWinterMode || !shouldDropLeaves) {
        const targetRgb = hslToRgb(cs.h, cs.s, cs.l);
        l1 = mix3(l1, targetRgb, sim.seasonProgress * 0.95);
        l2 = mix3(l2, targetRgb, sim.seasonProgress * 0.85);
      }
    }

    gl.useProgram(prog);

    const bk = (currentRecipe.trunk && currentRecipe.trunk.bark) || {};
    const bTypeMap = { none: 0, birch: 1, fissured: 2, ringed: 3 };
    gl.uniform1i(uBarkType, bTypeMap[bk.type] || 0);
    gl.uniform4f(uBarkParams, bk.scaleX || 1.0, bk.scaleY || 1.0, bk.density != null ? bk.density : 0.7, bk.baseDark || 0.0);
    gl.uniform3fv(uBarkCol2, hex3(bk.col2 || '#1e1a17'));
    gl.uniform3fv(uBarkColBase, hex3(bk.colBase || '#120f0d'));

    gl.uniformMatrix4fv(uVP, false, vp);
    gl.uniform1i(uWire, isWireframe);
    gl.uniform3f(uLightDir, 0.6, 0.85, 0.4);

    const effLeaf = (isWinterMode && shouldDropLeaves) ? (1.0 - sim.seasonProgress) : sim.leaf;
    gl.uniform4f(uSeason, effLeaf, sim.autumn, sim.snow, 0.0);
    gl.uniform3fv(uLeaf1, l1);
    gl.uniform3fv(uLeaf2, l2);
    gl.uniform3fv(uWood1, hex3(st.wood));
    gl.uniform3fv(uWood2, hex3(st.wood2 || st.wood));
    gl.uniform3fv(uBranch1, hex3(st.branch || st.wood));
    gl.uniform3fv(uBranch2, hex3(st.branch2 || st.branch || st.wood));
    gl.uniform1f(uMaxH, lastMaxH);

    gl.bindVertexArray(vao);
    gl.drawArrays(isWireframe ? gl.LINES : gl.TRIANGLES, 0, drawCount);
    gl.bindVertexArray(null);
  }

  // ===========================================================================
  // 8. ИНСПЕКТОР
  // ===========================================================================
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const DEG = Math.PI / 180;

  function newFoliage(type, leafMode) {
    const pos = leafMode ? {} : { x: 0, y: 0.7, z: 0 };
    const rot = { rotX: 0, rotY: 0, rotZ: 0 };
    let o;
    switch (type) {
      case 'tier': o = { h: 0.45, r: 0.65, seg: 12, rings: 4, droop: 0.35, curve: 0.25, arch: 0.0, tuck: 0.0, capBottom: false, lobes: 6, scallop: 0.35, jag: 1.0 }; break;
      case 'cluster': o = { count: 7, rx: 0.5, ry: 0.35, rz: 0.5, smin: 0.18, smax: 0.3, puffY: 0.85, lump: 0.05, seg: 8, rings: 4, seed: 1.0 }; break;
      case 'fronds': o = { count: 8, len: 0.5, width: 0.1, tilt: 0.8, arch: 0.9, segs: 5, fold: 0.4, jitter: 0.25, seed: 1.0 }; break;
      case 'lathe': o = { seg: 12, smooth: 1, lump: 0.04, lobes: 0, scallop: 0, seed: 0, capBottom: true, capTop: true, profile: [[0, 0], [0.3, 0.04], [0.42, 0.2], [0.28, 0.4], [0, 0.46]] }; break;
      default: type = 'blob'; o = { rx: 0.55, ry: 0.42, rz: 0.55, seg: 10, rings: 5, lump: 0.06, taper: 0, seed: 1.0 };
    }
    return Object.assign({ [leafMode ? 'kind' : 'type']: type }, pos, rot, o);
  }

  const FIELDS = {
    blob: [['rx', 'Радиус X', 0.05, 1.4, 0.02], ['ry', 'Радиус Y', 0.05, 1.2, 0.02], ['rz', 'Радиус Z', 0.05, 1.4, 0.02], ['taper', 'Конусность', -0.8, 0.8, 0.02, 'taper'], ['lump', 'Бугристость', 0, 0.3, 0.01], ['seg', 'Сегменты', 5, 20, 1], ['rings', 'Кольца', 3, 10, 1], ['seed', 'Seed', 0, 12, 0.1]],
    tier: [['h', 'Высота (H)', 0.05, 1.2, 0.02], ['r', 'Радиус юбки', 0.05, 1.5, 0.02], ['droop', 'Свисание', 0, 0.9, 0.02, 'pct'], ['curve', 'Выпуклость', -0.8, 0.8, 0.02, 'curve'], ['arch', 'Изгиб дугой', -0.8, 1.2, 0.02], ['tuck', 'Сведение к центру', -0.4, 0.9, 0.02, 'pct'], ['lobes', 'Фестоны', 0, 14, 1, 'int'], ['scallop', 'Глубина вырезов', 0, 0.8, 0.02], ['jag', 'Зубчатость хвои', 0.3, 1, 0.02], ['seg', 'Сегменты', 6, 24, 1], ['rings', 'Кольца', 1, 8, 1]],
    cluster: [['count', 'Число шапок', 1, 24, 1], ['rx', 'Разброс X', 0.05, 1.3, 0.02], ['ry', 'Разброс Y', 0.03, 1.0, 0.02], ['rz', 'Разброс Z', 0.05, 1.3, 0.02], ['smin', 'Размер мин', 0.04, 0.6, 0.01], ['smax', 'Размер макс', 0.04, 0.8, 0.01], ['puffY', 'Приплюснутость', 0.4, 1.3, 0.02], ['lump', 'Бугристость', 0, 0.3, 0.01], ['seg', 'Сегменты', 5, 14, 1], ['rings', 'Кольца', 3, 8, 1], ['seed', 'Seed', 0, 40, 0.1]],
    fronds: [['count', 'Число листьев', 1, 24, 1], ['len', 'Длина', 0.05, 1.6, 0.02], ['width', 'Ширина', 0.01, 0.4, 0.005], ['tilt', 'Наклон', 0, 2.0, 0.02, 'deg'], ['arch', 'Изгиб вниз', -0.5, 2.2, 0.02], ['segs', 'Звенья', 2, 8, 1], ['fold', 'Желобок', 0, 1, 0.02], ['jitter', 'Хаотичность', 0, 1, 0.02], ['seed', 'Seed', 0, 40, 0.1]],
    lathe: [['seg', 'Сегменты', 5, 28, 1], ['smooth', 'Сглаживание', 0, 3, 1, 'int'], ['lump', 'Бугристость', 0, 0.3, 0.01], ['lobes', 'Фестоны', 0, 14, 1, 'int'], ['scallop', 'Глубина вырезов', 0, 0.6, 0.02], ['seed', 'Seed', 0, 12, 0.1]]
  };
  const TYPE_LABEL = { blob: '🍃 Шар (blob)', tier: '🌲 Ярус (tier)', cluster: '☁️ Облако шапок (cluster)', fronds: '🌴 Листья/опахала (fronds)', lathe: '🔔 Тело вращения (lathe)' };

  function isSel(s) {
    const a = activeSelection; if (!a || !s) return false;
    return a.type === s.type && a.idx === s.idx && ((a.stem == null ? -1 : a.stem) === (s.stem == null ? -1 : s.stem));
  }

  function renderInspector(tab) {
    if (!editorWin) return;
    const pane = editorWin.querySelector('#te-pane');
    const keepScroll = pane.scrollTop;
    pane.innerHTML = '';

    const makeSliderRow = (label, obj, key, min, max, step, onDirect, fmtFn, deg) => {
      const row = el('div', 'te-row');
      const cur = obj[key] != null ? obj[key] : 0;
      const isInt = step >= 1;
      const dispNum = v => deg ? Math.round(v / DEG) : (isInt ? Math.round(v) : +Number(v).toFixed(3));
      row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${cur}">` +
        (fmtFn ? `<span class="te-val"></span>` : `<input type="number" class="te-num" step="${deg ? 1 : step}">`);
      const rng = row.querySelector('input[type=range]');
      const num = row.querySelector('.te-num'), span = row.querySelector('.te-val');
      const show = v => { if (span) span.textContent = fmtFn(v); if (num) num.value = dispNum(v); };
      show(cur);
      rng.oninput = () => { const v = +rng.value; obj[key] = v; show(v); if (onDirect) onDirect(v); updateMesh(); };
      rng.onchange = () => pushHistory();
      if (num) num.onchange = () => {
        let v = parseFloat(num.value); if (!isFinite(v)) { show(obj[key] || 0); return; }
        if (deg) v *= DEG; if (isInt) v = Math.round(v);
        obj[key] = v; rng.value = v; if (onDirect) onDirect(v); updateMesh(); pushHistory();
      };
      return row;
    };
    const rowFor = (obj, f, onDirect) => {
      const [k, label, mn, mx, st, sp] = f;
      const fmt = sp === 'taper' ? (v => v < 0 ? `Груша ${v.toFixed(2)}` : (v > 0 ? `Чаша +${v.toFixed(2)}` : '0'))
        : sp === 'curve' ? (v => v < 0 ? `Вогнутая ${v.toFixed(2)}` : (v > 0 ? `Выпуклая +${v.toFixed(2)}` : 'Прямая'))
        : sp === 'pct' ? (v => Math.round(v * 100) + '%') : null;
      return makeSliderRow(label, obj, k, mn, mx, st, onDirect, fmt, sp === 'deg');
    };
    const angleRow = (label, obj, key, onDirect) => makeSliderRow(label, obj, key, -3.1416, 3.1416, 0.02, onDirect, null, true);
    const makeSelectRow = (label, obj, key, options, onChange) => {
      const row = el('div', 'te-row');
      row.innerHTML = `<label>${label}</label><select>${options.map(o => `<option value="${o[0]}"${obj[key] === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select>`;
      row.querySelector('select').onchange = e => { obj[key] = e.target.value; if (onChange) onChange(e.target.value); pushHistory(); };
      return row;
    };
    const makeCheckRow = (label, obj, key, onChange, dflt) => {
      const row = el('div', 'te-row');
      const cur = obj[key] != null ? !!obj[key] : !!dflt;
      row.innerHTML = `<label>${label}</label><input type="checkbox" ${cur ? 'checked' : ''}>`;
      row.querySelector('input').onchange = e => { obj[key] = e.target.checked; if (onChange) onChange(e.target.checked); updateMesh(); pushHistory(); };
      return row;
    };
    const makeColorRow = (label, obj, key) => {
      const row = el('div', 'te-row');
      row.innerHTML = `<label>${label}</label><input type="color" value="${obj[key]}"><span class="te-val" style="flex:1;text-align:left">${obj[key]}</span>`;
      const inp = row.querySelector('input');
      inp.oninput = () => { obj[key] = inp.value; row.querySelector('.te-val').textContent = inp.value; updateMesh(); };
      inp.onchange = () => pushHistory();
      return row;
    };
    const button = (text, cls, fn, style) => { const b = el('button', 'te-btn ' + (cls || ''), text); if (style) b.style.cssText = style; b.onclick = fn; return b; };
    const commit = () => { pushHistory(); renderInspector(activeTab); updateMesh(); };

    const itemBox = (title, selObj, buttons, total) => {
      const selected = isSel(selObj);
      const expanded = selected || (!activeSelection && total <= 3) || !selObj;
      const box = el('div', 'te-sec' + (selected ? ' active-item' : '') + (expanded ? '' : ' collapsed'));
      if (selObj) box.onclick = e => {
        if (e.target.closest('input,button,select,textarea')) return;
        if (!selected) { activeSelection = { type: selObj.type, idx: selObj.idx, stem: selObj.stem }; renderInspector(activeTab); updateMesh(); }
      };
      const head = el('div', 'te-sec-head', `<b>${title}</b>`);
      const bw = el('div'); bw.style.cssText = 'display:flex;gap:4px';
      (buttons || []).forEach(b => { const x = button(b.t, b.cls || 'sec sm', b.fn); if (b.title) x.title = b.title; bw.append(x); });
      head.append(bw); box.append(head);
      return { box, expanded };
    };

    const foliageControls = (host, f, leafMode) => {
      const type = leafMode ? f.kind : f.type;
      if (leafMode) {
        host.append(makeSliderRow('Смещение X', f, 'dx', -0.5, 0.5, 0.01));
        host.append(makeSliderRow('Смещение Y', f, 'dy', -0.5, 0.5, 0.01));
        host.append(makeSliderRow('Смещение Z', f, 'dz', -0.5, 0.5, 0.01));
      } else {
        host.append(makeSliderRow('Позиция Y (высота)', f, 'y', -0.2, 1.8, 0.01));
        host.append(makeSliderRow('Позиция X', f, 'x', -1.5, 1.5, 0.01));
        host.append(makeSliderRow('Позиция Z', f, 'z', -1.5, 1.5, 0.01));
      }
      host.append(angleRow('Вращение X', f, 'rotX'), angleRow('Вращение Y', f, 'rotY'), angleRow('Вращение Z', f, 'rotZ'));
      if (f.sc == null) f.sc = 1;
      host.append(makeSliderRow('Масштаб', f, 'sc', 0.2, 3, 0.02));
      if (type === 'blob' && f.rz == null) f.rz = f.rx;
      (FIELDS[type] || []).forEach(fd => host.append(rowFor(f, fd)));
      if (type === 'lathe') lathe(host, f);
      host.append(makeCheckRow('Плоские грани (low-poly)', f, 'flat'));
      if (type === 'tier') host.append(makeCheckRow('Закрыть низ (дно)', f, 'capBottom'));
      if (!leafMode) {
        host.append(makeSliderRow('Радиальный массив ×', f, 'radial', 1, 12, 1, null, v => Math.round(v) <= 1 ? 'Выкл' : '×' + Math.round(v)));
        if ((f.radial || 1) > 1) host.append(makeSliderRow('Сдвиг фазы массива', f, 'radialPhase', -3.1416, 3.1416, 0.02, null, null, true));
      }
    };

    const lathe = (host, f) => {
      host.append(makeCheckRow('Дно закрыто', f, 'capBottom', null, true), makeCheckRow('Верх закрыт', f, 'capTop', null, true));
      host.append(el('div', 'te-grp', 'Профиль снизу вверх'));
      f.profile = f.profile || [[0, 0], [0.3, 0.1], [0, 0.3]];
      f.profile.forEach((pt, i) => {
        const sub = el('div', 'te-sub-node');
        const o = { r: pt[0], y: pt[1] };
        const head = el('div', null, `<div style="display:flex;justify-content:space-between;font-size:11px;color:#79c0ff;margin-bottom:3px"><span><b>Точка #${i + 1}</b></span></div>`);
        if (f.profile.length > 2) {
          const del = button('✕', 'danger sm', () => { f.profile.splice(i, 1); commit(); }, 'height:18px;padding:0 4px');
          head.firstChild.append(del);
        }
        sub.append(head);
        sub.append(makeSliderRow('Радиус', o, 'r', 0, 1.4, 0.01, v => { pt[0] = v; }));
        sub.append(makeSliderRow('Высота', o, 'y', -0.3, 1.2, 0.01, v => { pt[1] = v; }));
        host.append(sub);
      });
      host.append(button('+ Точка профиля', 'sec sm', () => {
        const a = f.profile[f.profile.length - 2], b = f.profile[f.profile.length - 1];
        f.profile.splice(f.profile.length - 1, 0, [(a[0] + b[0]) / 2 + 0.05, (a[1] + b[1]) / 2]); commit();
      }, 'width:100%;margin-top:4px'));
    };

    const trunkEditor = (st, stemIdx) => {
      const isMain = stemIdx < 0;
      const p = itemBox(isMain ? 'Параметры ствола' : `Доп. ствол #${stemIdx + 1}`, null, isMain ? [] : [
        { t: '⎘', title: 'Дублировать', fn: () => { const c = clone(st); c.rings.forEach(r => { r.x += 0.12; }); currentRecipe.stems.push(c); commit(); } },
        { t: '✕', cls: 'danger sm', fn: () => { currentRecipe.stems.splice(stemIdx, 1); activeSelection = null; commit(); } }
      ]);
      p.box.append(makeSliderRow('Гранёность', st, 'seg', 3, 16, 1));
      p.box.append(makeSliderRow('Сглаживание', st, 'smooth', 0, 4, 1));
      p.box.append(makeSliderRow('Корневой наплыв', st, 'flare', 0, 1.5, 0.02));
      p.box.append(makeSliderRow('Высота наплыва', st, 'flareH', 0.03, 0.5, 0.01));
      p.box.append(makeSliderRow('Число корней', st, 'roots', 0, 12, 1, null, v => Math.round(v) === 0 ? 'Круг' : Math.round(v)));
      p.box.append(makeSliderRow('Скрутка', st, 'twist', -12.57, 12.57, 0.05, null, null, true));
      p.box.append(makeSliderRow('Шероховатость коры', st, 'rough', 0, 0.6, 0.01));
      if (!isMain) {
        p.box.append(makeSliderRow('Радиальный массив ×', st, 'radial', 1, 12, 1, null, v => Math.round(v) <= 1 ? 'Выкл' : '×' + Math.round(v)));
        if ((st.radial || 1) > 1) p.box.append(makeSliderRow('Сдвиг фазы', st, 'radialPhase', -3.1416, 3.1416, 0.02, null, null, true));
      }
      pane.append(p.box);

      if (isMain) {
        const styleBox = el('div', 'te-sec');
        const rStyle = currentRecipe.style = currentRecipe.style || {};
        styleBox.innerHTML = `<div class="te-sec-head"><b>🎨 Цвет древесины ствола</b></div>`;
        styleBox.append(makeColorRow('Основание ствола', rStyle, 'wood'));
        styleBox.append(makeColorRow('Вершина ствола', rStyle, 'wood2'));
        styleBox.append(makeCheckRow('Плоские грани ствола и веток (low-poly)', rStyle, 'flatTrunk'));
        pane.append(styleBox);
      }

      st.rings.forEach((r, idx) => {
        const s = { type: 'trunk', idx, stem: stemIdx };
        const b = itemBox(`Кольцо #${idx + 1}${idx === 0 ? ' (основание)' : ''}`, s, [
          { t: '⎘', title: 'Вставить кольцо после этого', fn: () => { st.rings.splice(idx + 1, 0, { y: r.y + 0.08, r: Math.max(0.01, r.r * 0.85), x: r.x, z: r.z }); activeSelection = { type: 'trunk', idx: idx + 1, stem: stemIdx }; commit(); } },
          ...(st.rings.length > 2 ? [{ t: '✕', cls: 'danger sm', fn: () => { st.rings.splice(idx, 1); activeSelection = null; commit(); } }] : [])
        ], st.rings.length);
        if (b.expanded) {
          b.box.append(makeSliderRow('Высота (Y)', r, 'y', 0, 1.6, 0.01));
          b.box.append(makeSliderRow('Радиус (R)', r, 'r', 0.004, 0.4, 0.002, null, v => v.toFixed(3)));
          b.box.append(makeSliderRow('Сдвиг по X', r, 'x', -1, 1, 0.01));
          b.box.append(makeSliderRow('Сдвиг по Z', r, 'z', -1, 1, 0.01));
        }
        pane.append(b.box);
      });
      pane.append(button('+ Кольцо вверх', 'sec', () => {
        const last = st.rings[st.rings.length - 1];
        st.rings.push({ y: last.y + 0.15, r: Math.max(0.006, last.r * 0.75), x: last.x, z: last.z });
        activeSelection = { type: 'trunk', idx: st.rings.length - 1, stem: stemIdx }; commit();
      }, 'width:100%;margin:2px 0 10px'));

      const barkBox = el('div', 'te-sec');
      const bk = st.bark = Object.assign({
        type: 'none', scaleX: 1.0, scaleY: 1.0, density: 0.7, baseDark: 0.22,
        col2: '#201b17', colBase: '#120f0c'
      }, st.bark || {});

      barkBox.innerHTML = `<div class="te-sec-head"><b>🪵 Текстурный узор коры</b></div>`;
      barkBox.append(makeSelectRow('Тип узора', bk, 'type', [
        ['none', '— Только чистый градиент древесины'],
        ['birch', '⚪ Чечевички берёзы и комель'],
        ['fissured', '🌲 Продольные трещины (сосна/дуб)'],
        ['ringed', '🪐 Поперечные кольца']
      ], () => { commit(); }));

      if (bk.type !== 'none') {
        barkBox.append(makeColorRow('Цвет трещин / чечевичек', bk, 'col2'));
        if (bk.type === 'birch') {
          barkBox.append(makeColorRow('Цвет прикорневого комля', bk, 'colBase'));
          barkBox.append(makeSliderRow('Высота комля (база)', bk, 'baseDark', 0.0, 0.6, 0.02, null, v => Math.round(v * 100) + '%'));
        }
        barkBox.append(makeSliderRow('Частота по окружности X', bk, 'scaleX', 0.3, 3.5, 0.1));
        barkBox.append(makeSliderRow('Частота по высоте Y', bk, 'scaleY', 0.3, 3.5, 0.1));
        barkBox.append(makeSliderRow('Плотность / выраженность', bk, 'density', 0.1, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      }
      pane.append(barkBox);
    };

    if (tab === 'trunk') {
      trunkEditor(currentRecipe.trunk, -1);
      pane.append(el('div', 'te-grp', 'Дополнительные стволы'));
      currentRecipe.stems.forEach((s, i) => trunkEditor(s, i));
      pane.append(button('+ Добавить доп. ствол', 'sec', () => {
        currentRecipe.stems.push({ seg: 6, smooth: 1, radial: 1, rings: [{ x: 0.12, y: 0, z: 0.04, r: 0.05 }, { x: 0.18, y: 0.35, z: 0.06, r: 0.03 }, { x: 0.24, y: 0.62, z: 0.08, r: 0.012 }] });
        commit();
      }, 'width:100%'));

    } else if (tab === 'branches') {
      const bStyleBox = el('div', 'te-sec');
      const rStyle = currentRecipe.style = currentRecipe.style || {};
      bStyleBox.innerHTML = `<div class="te-sec-head"><b>🎨 Цвет веток (градиент)</b></div>`;
      bStyleBox.append(makeColorRow('Основание ветки', rStyle, 'branch'));
      bStyleBox.append(makeColorRow('Кончик ветки', rStyle, 'branch2'));
      pane.append(bStyleBox);

      pane.append(button('+ Создать новую ветку', '', () => {
        currentRecipe.branches.push({ r: 0.03, taper: 0.35, sides: 4, smooth: 1, nodes: [{ x: 0, y: 0.45, z: 0 }, { x: 0.25, y: 0.58, z: 0.18 }, { x: 0.42, y: 0.68, z: 0.28 }] });
        activeSelection = { type: 'branch', idx: currentRecipe.branches.length - 1 }; commit();
      }, 'width:100%;margin-bottom:10px'));
      if (!currentRecipe.branches.length) pane.append(el('div', 'te-sec', '<div style="text-align:center;color:#8b949e">У дерева пока нет веток.</div>'));
      currentRecipe.branches.forEach((b, idx) => {
        const s = { type: 'branch', idx };
        const bx = itemBox(`Ветка #${idx + 1} (${b.nodes.length - 1} сегм.${b.leaf && b.leaf.kind !== 'none' ? ', 🍃' : ''})`, s, [
          { t: '⎘', title: 'Дублировать', fn: () => { const c = clone(b); c.nodes.forEach(n => { n.x = -n.x; n.z = -n.z; }); currentRecipe.branches.push(c); activeSelection = { type: 'branch', idx: currentRecipe.branches.length - 1 }; commit(); } },
          { t: '✕', cls: 'danger sm', fn: () => { currentRecipe.branches.splice(idx, 1); activeSelection = null; commit(); } }
        ], currentRecipe.branches.length);
        if (bx.expanded) {
          const B = bx.box;
          B.append(makeSliderRow('Толщина основания', b, 'r', 0.004, 0.1, 0.002, null, v => v.toFixed(3)));
          B.append(makeSliderRow('Толщина кончика', b, 'taper', 0.05, 1.2, 0.02, null, v => '×' + v.toFixed(2)));
          B.append(makeSliderRow('Грани', b, 'sides', 3, 8, 1));
          B.append(makeSliderRow('Сглаживание', b, 'smooth', 0, 4, 1));
          B.append(makeSliderRow('Радиальный массив ×', b, 'radial', 1, 12, 1, null, v => Math.round(v) <= 1 ? 'Выкл' : '×' + Math.round(v)));
          if ((b.radial || 1) > 1) B.append(makeSliderRow('Сдвиг фазы', b, 'radialPhase', -3.1416, 3.1416, 0.02, null, null, true));
          b.nodes.forEach((nd, ni) => {
            const nb = el('div', 'te-sub-node', `<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;color:#79c0ff"><span><b>${ni === 0 ? '⚓ Крепление к стволу' : 'Сустав #' + ni}</b></span></div>`);
            if (b.nodes.length > 2 && ni > 0) nb.firstChild.append(button('✕', 'danger sm', () => { b.nodes.splice(ni, 1); commit(); }, 'height:18px;padding:0 4px'));
            nb.append(makeSliderRow('Высота (Y)', nd, 'y', 0, 1.6, 0.01));
            nb.append(makeSliderRow('Смещение X', nd, 'x', -1.5, 1.5, 0.01));
            nb.append(makeSliderRow('Смещение Z', nd, 'z', -1.5, 1.5, 0.01));
            B.append(nb);
          });
          B.append(button('+ Добавить звено', 'sec sm', () => {
            const l = b.nodes[b.nodes.length - 1], pv = b.nodes[b.nodes.length - 2] || { x: 0, y: l.y - 0.1, z: 0 };
            b.nodes.push({ x: +(l.x + (l.x - pv.x) * 0.8).toFixed(3), y: +(l.y + Math.max(0.04, (l.y - pv.y) * 0.8)).toFixed(3), z: +(l.z + (l.z - pv.z) * 0.8).toFixed(3) }); commit();
          }, 'width:100%;margin-top:6px'));
          B.append(el('div', 'te-grp', 'Листва на конце ветки'));
          const kinds = [['none', 'Нет'], ['blob', 'Шар'], ['cluster', 'Облако шапок'], ['tier', 'Ярус / конус'], ['fronds', 'Листья-опахала']];
          const cur = b.leaf && b.leaf.kind ? b.leaf.kind : 'none';
          B.append(makeSelectRow('Тип', { k: cur }, 'k', kinds, v => {
            b.leaf = v === 'none' ? { kind: 'none' } : newFoliage(v, true);
            if (v === 'blob') Object.assign(b.leaf, { rx: 0.2, ry: 0.16, rz: 0.2 });
            if (v === 'cluster') Object.assign(b.leaf, { count: 4, rx: 0.15, ry: 0.1, smin: 0.1, smax: 0.16 });
            if (v === 'tier') Object.assign(b.leaf, { h: 0.25, r: 0.22, rings: 1, seg: 8, jag: 0.7 });
            if (v === 'fronds') Object.assign(b.leaf, { len: 0.25, width: 0.06, count: 5 });
            renderInspector('branches'); updateMesh();
          }));
          if (b.leaf && b.leaf.kind !== 'none') foliageControls(B, b.leaf, true);
        }
        pane.append(bx.box);
      });

    } else if (tab === 'foliage') {
      const fStyleBox = el('div', 'te-sec');
      const rStyle = currentRecipe.style = currentRecipe.style || {};
      fStyleBox.innerHTML = `<div class="te-sec-head"><b>🍃 Палитра и стиль кроны</b></div>`;
      fStyleBox.append(makeColorRow('Цвет 1 (основа)', rStyle, 'leaf'));
      fStyleBox.append(makeColorRow('Цвет 2 (верхушка)', rStyle, 'leaf2'));
      fStyleBox.append(makeSelectRow('Режим градиента', rStyle, 'leafGrad', [
        ['y', '↕ Снизу вверх (по высоте Y)'],
        ['radial', '⦿ От центра к краям (радиальный)']
      ], () => { updateMesh(); }));
      fStyleBox.append(makeSliderRow('Мягкие нормали (шар)', rStyle, 'normalBlend', 0, 1, 0.02, null, v => Math.round(v * 100) + '%'));
      pane.append(fStyleBox);

      const wrap = el('div'); wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px';
      ['blob', 'tier', 'cluster', 'fronds', 'lathe'].forEach((t, i) => {
        const bt = button('+ ' + TYPE_LABEL[t], i === 0 ? '' : 'sec', () => {
          currentRecipe.foliage.push(newFoliage(t));
          activeSelection = { type: 'foliage', idx: currentRecipe.foliage.length - 1 }; commit();
        });
        if (i === 4) bt.style.gridColumn = '1 / 3';
        wrap.append(bt);
      });
      pane.append(wrap);
      if (!currentRecipe.foliage.length) pane.append(el('div', 'te-sec', '<div style="text-align:center;color:#8b949e">Крона пуста. Добавьте элемент выше.</div>'));
      currentRecipe.foliage.forEach((f, idx) => {
        const fb = itemBox(`${TYPE_LABEL[f.type] || f.type} #${idx + 1}`, { type: 'foliage', idx }, [
          { t: '↑', title: 'Выше в списке', fn: () => { if (idx > 0) { const a = currentRecipe.foliage; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; activeSelection = { type: 'foliage', idx: idx - 1 }; commit(); } } },
          { t: '⎘', title: 'Дублировать', fn: () => { const c = clone(f); c.y += 0.1; c.seed = (c.seed || 0) + 1.7; currentRecipe.foliage.push(c); activeSelection = { type: 'foliage', idx: currentRecipe.foliage.length - 1 }; commit(); } },
          { t: '✕', cls: 'danger sm', fn: () => { currentRecipe.foliage.splice(idx, 1); activeSelection = null; commit(); } }
        ], currentRecipe.foliage.length);
        if (fb.expanded) foliageControls(fb.box, f, false);
        pane.append(fb.box);
      });

    } else if (tab === 'eco') {
      const eco = currentRecipe.eco = Object.assign({}, DEFAULT_TREE_ECO, currentRecipe.eco || {});
      eco.weights = Object.assign({}, DEFAULT_TREE_ECO.weights, eco.weights || {});
      eco.colorShift = Object.assign({}, DEFAULT_TREE_ECO.colorShift, eco.colorShift || {});

      const nameBox = el('div', 'te-sec');
      nameBox.innerHTML = `
        <div class="te-sec-head"><b>🏷 Название растения</b></div>
        <div class="te-row">
          <input type="text" id="te-tree-name" value="${currentRecipe.name || 'Моё дерево'}" 
                 style="width:100%;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;border-radius:5px;padding:5px 8px;font-size:12.5px">
        </div>`;
      nameBox.querySelector('#te-tree-name').oninput = e => { currentRecipe.name = e.target.value; };
      nameBox.querySelector('#te-tree-name').onchange = () => pushHistory();
      pane.append(nameBox);

      const s1 = el('div', 'te-sec', '<div class="te-sec-head"><b>🌲 Биологический тип и частота</b></div>');
      s1.append(makeSelectRow('Тип растения', eco, 'kind', [['deciduous', '🌳 Лиственное'], ['conifer', '🌲 Хвойное']], () => commit()));
      s1.append(makeSliderRow('Частота встречи', eco, 'baseWeight', 0.05, 5.0, 0.05, null, v => v.toFixed(1) + 'x'));

      const isAllSeasons = (eco.seasons === 'all' || !eco.seasons);
      s1.append(makeSelectRow('Сезонность', eco, 'seasons', [
        ['all', 'Круглый год (своя модель зимой)'],
        ['spring_to_autumn', 'С весны по осень (зимой сухостой)'],
        ['early_spring_to_late_autumn', 'С ранней весны до поздней осени (зимой сухостой)'],
        ['winter_only', 'Только зима (модель сухостоя)']
      ], () => { commit(); renderInspector('eco'); renderFrame(); }));

      const chkWinter = makeCheckRow('Сбрасывать листву зимой', eco, 'deciduousWinter', () => {
        renderInspector('eco');
        recalcSimState();
      });

      if (!isAllSeasons) {
        chkWinter.style.opacity = '0.38'; chkWinter.style.pointerEvents = 'none';
        const inp = chkWinter.querySelector('input'); if (inp) inp.disabled = true;
      }
      s1.append(chkWinter);
      pane.append(s1);

      const sHsl = el('div', 'te-sec', '<div class="te-sec-head"><b>🎨 Сезонные оттенки листвы (HSL)</b></div>');
      sHsl.append(makeCheckRow('Включить сезонную смену цвета', eco.colorShift, 'enabled', () => { commit(); renderFrame(); }));

      if (eco.colorShift.enabled) {
        const renderHslGroup = (title, key, isDisabled) => {
          const conf = eco.colorShift[key] = eco.colorShift[key] || { h: 90, s: 70, l: 40 };
          const wrap = el('div', 'te-sub-node');
          if (isDisabled) { wrap.style.opacity = '0.35'; wrap.style.pointerEvents = 'none'; wrap.style.filter = 'grayscale(1)'; }
          const swatch = el('div', null, `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:11px;color:#79c0ff">
            <span><b>${title}</b></span>
            <span class="hsl-swatch" style="width:20px;height:12px;border-radius:3px;border:1px solid #58a6ff;background:hsl(${conf.h}, ${conf.s}%, ${conf.l}%)"></span>
          </div>`);
          wrap.append(swatch);
          const updateSwatch = () => {
            const sw = wrap.querySelector('.hsl-swatch');
            if (sw) sw.style.background = `hsl(${conf.h}, ${conf.s}%, ${conf.l}%)`;
            renderFrame();
          };
          wrap.append(
            makeSliderRow('Цвет (Hue)', conf, 'h', 0, 360, 1, updateSwatch, v => Math.round(v) + '°'),
            makeSliderRow('Насыщенность', conf, 's', 0, 100, 1, updateSwatch, v => Math.round(v) + '%'),
            makeSliderRow('Яркость', conf, 'l', 5, 95, 1, updateSwatch, v => Math.round(v) + '%')
          );
          return wrap;
        };

        sHsl.append(renderHslGroup('🌱 Ранняя весна', 'earlySpring', false));
        sHsl.append(renderHslGroup('🌿 Весна', 'spring', false));
        sHsl.append(renderHslGroup('🍁 Золотая осень', 'autumn', false));
        sHsl.append(renderHslGroup('🍂 Поздняя осень', 'lateAutumn', false));
        sHsl.append(renderHslGroup('❄️ Зима', 'winter', !isAllSeasons || !!eco.deciduousWinter));
      }
      pane.append(sHsl);

      const s2 = el('div', 'te-sec', '<div class="te-sec-head"><b>📍 Экологические зоны произрастания</b></div>');
      const ew = eco.weights;
      s2.append(makeSliderRow('Только у воды', ew, 'nearWater', 0, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      s2.append(makeSliderRow('Только на крутых склонах', ew, 'steepSlope', 0, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      s2.append(makeSliderRow('Тенелюбивое', ew, 'shadeLove', 0, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      s2.append(makeSliderRow('Светолюбивое', ew, 'sunLove', 0, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      s2.append(makeSliderRow('Городские зоны', ew, 'urban', 0, 1.0, 0.05, null, v => Math.round(v * 100) + '%'));
      pane.append(s2);

    } else if (tab === 'gen') {
      const g = currentRecipe.gen = Object.assign({}, DEFAULT_GEN, currentRecipe.gen || {});
      const regen = what => {
        if (!liveGen) return;
        if (what === 'trunk') generateTrunk(currentRecipe, g);
        generateBranches(currentRecipe, g);
      };
      const rB = () => () => regen('branches'), rT = () => () => regen('trunk');
      const S = (label, key, mn, mx, st, hook, fmt) => makeSliderRow(label, g, key, mn, mx, st, hook, fmt);
      const sec = (title, ...rows) => { const s = el('div', 'te-sec', `<div class="te-sec-head"><b>${title}</b></div>`); rows.forEach(r => s.append(r)); pane.append(s); };

      const top = el('div'); top.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap';
      top.append(
        button('🎲 Случайный seed', '', () => { g.seed = Math.floor(Math.random() * 999); generateBranches(currentRecipe, g); commit(); }, 'flex:1'),
        button('Ствол', 'sec', () => { generateTrunk(currentRecipe, g); generateBranches(currentRecipe, g); commit(); }, 'flex:1'),
        button('Ветви', 'sec', () => { generateBranches(currentRecipe, g); commit(); }, 'flex:1')
      );
      pane.append(top);
      pane.append(makeCheckRow('Живой пересчёт при движении слайдеров', { v: liveGen }, 'v', v => { liveGen = v; }, true));

      sec('Ствол', S('Высота', 'tHeight', 0.25, 1.4, 0.01, rT()), S('Радиус основания', 'tBase', 0.02, 0.3, 0.005, rT(), v => v.toFixed(3)),
        S('Сужение к верху', 'tTop', 0.05, 1, 0.01, rT()), S('Наклон', 'tBend', 0, 0.5, 0.01, rT()), S('Кривизна', 'tWiggle', 0, 1.5, 0.02, rT()),
        S('Колец', 'tRings', 2, 8, 1, rT()), S('Корневой наплыв', 'tFlare', 0, 1.2, 0.02, rT()));
      sec('Ветвление', S('Seed', 'seed', 0, 999, 1, rB()), S('Уровней', 'levels', 1, 3, 1, rB()), S('Веток 1-го уровня', 'count', 1, 14, 1, rB()),
        S('Потомков на ветку', 'kids', 1, 4, 1, rB()), S('Нижняя граница (по высоте)', 'startH', 0, 1, 0.01, rB()), S('Верхняя граница', 'endH', 0.1, 1, 0.01, rB()),
        S('Угол от вертикали', 'spread', 5, 120, 1, rB(), v => Math.round(v) + '°'), S('Разброс угла', 'spreadVar', 0, 0.8, 0.02, rB()));
      sec('Форма веток', S('Длина', 'len', 0.08, 1.2, 0.01, rB()), S('Укорочение потомков', 'lenDecay', 0.2, 1, 0.01, rB()),
        S('Толщина (от ствола)', 'thick', 0.1, 1.2, 0.01, rB()), S('Утоньшение потомков', 'thickDecay', 0.2, 1, 0.01, rB()),
        S('Звеньев', 'nodes', 2, 6, 1, rB()), S('Стремление вверх', 'up', 0, 1.2, 0.02, rB()), S('Провисание', 'grav', 0, 1.2, 0.02, rB()),
        S('Извилистость', 'curl', 0, 1.2, 0.02, rB()), S('Сглаживание', 'smooth', 0, 3, 1, rB()));
      const leafSel = makeSelectRow('Листва на концах', g, 'leaf', [['none', 'Нет'], ['blob', 'Шары'], ['cluster', 'Облака шапок'], ['tier', 'Конусы'], ['fronds', 'Опахала']], () => { regen('branches'); renderInspector('gen'); updateMesh(); });
      sec('Листва', leafSel, S('Размер', 'leafSize', 0.05, 0.6, 0.01, rB()), makeCheckRow('Плоские грани', g, 'leafFlat', () => regen('branches')), makeCheckRow('Очищать общую крону при генерации', g, 'replaceFoliage'));

    } else if (tab === 'code') {
      // Получаем активный каталог из slice3d (или локального хранилища)
      const S3D = WM.slice3d;
      const allActive = (S3D && S3D.getRawActiveCatalog) ? S3D.getRawActiveCatalog() : [];
      const disabledMap = (S3D && S3D.getDisabledTreesMap) ? S3D.getDisabledTreesMap() : {};
      const isReplaced = localStorage.getItem('wm_tree_replace_default') === 'true';

      pane.innerHTML = `
        <!-- 1. МЕНЕДЖЕР ДЕРЕВЬЕВ В СЦЕНЕ -->
        <div class="te-sec" style="border-color:#58a6ff">
          <div class="te-sec-head">
            <b>🌲 Деревья в сцене (${allActive.length})</b>
            <span style="font-size:11px;color:#8b949e">${isReplaced ? 'Пак заменяет стандартные' : 'Стандартные + кастом'}</span>
          </div>

          <!-- Скролл-список деревьев -->
          <div id="te-tree-list-box" style="max-height:210px;overflow-y:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:4px;margin-bottom:8px">
            ${allActive.length === 0 ? '<div style="padding:10px;text-align:center;color:#8b949e">Нет активных деревьев</div>' : ''}
            ${allActive.map((t, idx) => {
              const isDisabled = !!disabledMap[idx];
              const isCur = currentRecipe && currentRecipe.name === t.name;
              const kindIcon = (t.eco && t.eco.kind === 'conifer') ? '🌲' : '🌳';
              return `
                <div class="te-tree-item" data-idx="${idx}" style="display:flex;align-items:center;gap:8px;padding:4px 6px;margin:2px 0;background:${isCur ? '#1f3b5c' : '#161b22'};border-radius:5px;cursor:pointer;user-select:none;border:1px solid ${isCur ? '#58a6ff' : 'transparent'}">
                  <input type="checkbox" class="te-tree-chk" data-idx="${idx}" ${isDisabled ? '' : 'checked'} title="Включить / исключить из генерации на карте" style="cursor:pointer">
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:${isDisabled ? '#6e7681' : '#c9d1d9'}">
                    ${kindIcon} ${t.name || ('Дерево #' + (idx + 1))}
                  </span>
                  <span style="font-size:10.5px;color:#8b949e;padding:1px 4px;background:#21262d;border-radius:3px">#${idx}</span>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Кнопки управления текущим деревом -->
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <button class="te-btn" style="flex:1" id="te-add-new-btn">➕ Добавить текущее как новое</button>
            <button class="te-btn sec" style="flex:1" id="te-update-cur-btn" title="Обновить выбранное в списке дерево текущим из редактора">🔄 Обновить выбранное</button>
          </div>

          <!-- Импорт пака -->
          <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #30363d">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <label style="font-size:11.5px;font-weight:600;color:#c9d1d9;display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="te-replace-orig-chk" ${isReplaced ? 'checked' : ''}> Заменить оригинальные
              </label>
              <button class="te-btn danger sm" id="te-reset-all-trees" title="Сбросить все деревья к исходным 11 из кода">↺ Сброс к дефолту</button>
            </div>
            
            <textarea class="te-code" id="te-pack-input" style="height:70px;margin-bottom:6px" placeholder="Вставьте сюда один или несколько JSON рецептов пака..."></textarea>
            
            <div style="display:flex;gap:6px">
              <button class="te-btn sec" style="flex:1" id="te-import-pack-btn">📦 Импортировать из поля</button>
              <label class="te-btn sec" style="flex:1;cursor:pointer;margin:0;text-align:center">
                📁 Из файла (.txt/.json)
                <input type="file" id="te-import-pack-file" accept=".txt,.json" style="display:none">
              </label>
            </div>
            <p class="te-hint" id="te-pack-status" style="margin-top:5px;min-height:16px"></p>
          </div>
        </div>

        <!-- 2. ЭКСПОРТ КОДА И JSON -->
        <div class="te-sec">
          <div class="te-sec-head"><b>JS для slice3d.js</b></div>
          <div class="te-row"><label style="flex:0 0 70px">Вариант</label><select id="te-code-mode"><option value="standalone">Автономный (рекомендуется)</option><option value="short">Короткий (нужен treeEditor.js)</option></select></div>
          <textarea class="te-code" id="te-code-box" readonly></textarea>
          <button class="te-btn" style="width:100%;margin-top:8px" id="te-copy-btn">📋 Скопировать JS-код</button>
        </div>

        <div class="te-sec">
          <div class="te-sec-head"><b>JSON / OBJ</b></div>
          <textarea class="te-code json" id="te-json-box" spellcheck="false"></textarea>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="te-btn sec" style="flex:1" id="te-json-apply">Применить JSON</button>
            <button class="te-btn sec" style="flex:1" id="te-json-copy">Копировать</button>
          </div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="te-btn sec" style="flex:1" id="te-json-dl">⬇ .json</button>
            <button class="te-btn sec" style="flex:1" id="te-obj-dl">⬇ .obj</button>
            <input type="number" class="te-num" id="te-obj-scale" value="${objScale}" title="Масштаб OBJ" style="flex:0 0 52px">
          </div>
        </div>
      `;

      const $ = s => pane.querySelector(s);
      let selectedTreeIdx = allActive.length > 0 ? 0 : -1;

      // Клик по строке дерева: загрузка его в редактор для правки
      pane.querySelectorAll('.te-tree-item').forEach(item => {
        item.onclick = e => {
          if (e.target.tagName === 'INPUT') return;
          const idx = +item.dataset.idx;
          selectedTreeIdx = idx;
          if (allActive[idx]) {
            loadRecipe(allActive[idx], { mode: 'slot', slot: idx });
          }
        };
      });

      // Чекбоксы включения/выключения деревьев
      pane.querySelectorAll('.te-tree-chk').forEach(chk => {
        chk.onchange = () => {
          const idx = +chk.dataset.idx;
          if (WM.slice3d && WM.slice3d.toggleTreeEnabled) {
            WM.slice3d.toggleTreeEnabled(idx, chk.checked);
            renderInspector('code');
          }
        };
      });

      // Кнопка «Добавить текущее как новое»
      $('#te-add-new-btn').onclick = () => {
        if (WM.slice3d && WM.slice3d.addNewTree) {
          WM.slice3d.addNewTree(currentRecipe);
          $('#te-pack-status').innerHTML = `<span style="color:#3fb950">✓ Дерево «${currentRecipe.name || 'Новое'}» добавлено на сцену!</span>`;
          renderInspector('code');
          refreshTreePicker();
        }
      };

      // Кнопка «Обновить выбранное»
      $('#te-update-cur-btn').onclick = () => {
        if (selectedTreeIdx >= 0 && WM.slice3d && WM.slice3d.updateTreeSlot) {
          WM.slice3d.updateTreeSlot(selectedTreeIdx, currentRecipe);
          $('#te-pack-status').innerHTML = `<span style="color:#3fb950">✓ Слот #${selectedTreeIdx} обновлён текущим рецептом.</span>`;
          renderInspector('code');
          refreshTreePicker();
        }
      };

      // Применение пака деревьев (общая функция для текста и файла)
      const applyPackText = (txt) => {
        const replaceOrig = $('#te-replace-orig-chk').checked;
        const pack = extractJsonTreePack(txt);
        if (!pack.length) {
          $('#te-pack-status').innerHTML = '<span style="color:#f85149">✕ Не найдено ни одного рецепта дерева { ... } в тексте</span>';
          return;
        }

        if (WM.slice3d && WM.slice3d.importTreePack) {
          WM.slice3d.importTreePack(pack, replaceOrig);
          $('#te-pack-status').innerHTML = `<span style="color:#3fb950">✓ Успешно импортировано деревьев: ${pack.length} (${replaceOrig ? 'заменили старые' : 'добавлены к текущим'})</span>`;
          renderInspector('code');
          refreshTreePicker();
        }
      };

      $('#te-import-pack-btn').onclick = () => applyPackText($('#te-pack-input').value);

      $('#te-import-pack-file').onchange = e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => applyPackText(ev.target.result);
        reader.readAsText(file);
      };

      // Кнопка сброса к базовым деревьям
      $('#te-reset-all-trees').onclick = () => {
        if (!confirm('Сбросить все деревья к исходным базовым видам? Кастомные паки будут удалены.')) return;
        if (WM.slice3d && WM.slice3d.resetAllTreesToDefault) {
          WM.slice3d.resetAllTreesToDefault();
          
          // ПЕРЕЗАГРУЖАЕМ ТЕКУЩИЙ РЕЦЕПТ ИЗ СВЕЖЕГО ДЕФОЛТНОГО КАТАЛОГА:
          const freshCat = WM.slice3d.getRawActiveCatalog();
          const curIdx = (currentTarget && currentTarget.slot != null) ? currentTarget.slot : 0;
          if (freshCat[curIdx]) {
            loadRecipe(freshCat[curIdx], { mode: 'slot', slot: curIdx });
          }

          $('#te-pack-status').innerHTML = '<span style="color:#3fb950">✓ Деревья сброшены к стандартным.</span>';
          renderInspector('code');
          refreshTreePicker();
        }
      };


      $('#te-replace-orig-chk').onchange = e => {
        localStorage.setItem('wm_tree_replace_default', e.target.checked ? 'true' : 'false');
        if (WM.slice3d && WM.slice3d.reloadTreeMeshes) WM.slice3d.reloadTreeMeshes();
        renderInspector('code');
      };

      // Экспорт в JS / JSON
      $('#te-code-mode').value = codeMode;
      $('#te-code-mode').onchange = e => { codeMode = e.target.value; syncCodeBoxes(true); };
      $('#te-copy-btn').onclick = () => {
        navigator.clipboard.writeText($('#te-code-box').value);
        $('#te-copy-btn').textContent = '✓ Скопировано';
        setTimeout(() => { const b = $('#te-copy-btn'); if (b) b.textContent = '📋 Скопировать JS-код'; }, 1800);
      };

      $('#te-json-apply').onclick = () => {
        try {
          const raw = $('#te-json-box').value;
          const parsed = parseTreeJson(raw);
          if (!parsed.trunk || !parsed.trunk.rings) throw new Error('Нет trunk.rings');
          loadRecipe(parsed);
        } catch (e) {
          alert('Ошибка импорта: ' + e.message);
        }
      };
      $('#te-json-copy').onclick = () => navigator.clipboard.writeText(JSON.stringify(currentRecipe, null, 2));
      $('#te-json-dl').onclick = () => download((currentRecipe.name || 'tree').replace(/[^\w\-а-яА-Я]+/g, '_') + '.json', JSON.stringify(currentRecipe, null, 2), 'application/json');
      $('#te-obj-scale').onchange = e => { objScale = +e.target.value || 1; };
      $('#te-obj-dl').onclick = () => download((currentRecipe.name || 'tree').replace(/[^\w\-а-яА-Я]+/g, '_') + '.obj', generateObj(currentRecipe, objScale));
      syncCodeBoxes(true);
    }

    pane.scrollTop = keepScroll;
  }

  function syncCodeBoxes(force) {
    if (!editorWin || activeTab !== 'code') return;
    const cb = editorWin.querySelector('#te-code-box'), jb = editorWin.querySelector('#te-json-box');
    if (cb) cb.value = generateJsCode(currentRecipe, codeMode === 'short' ? 'short' : 'standalone');
    if (jb && (force || document.activeElement !== jb)) jb.value = JSON.stringify(currentRecipe, null, 1);
  }

  // ===========================================================================
  // 9. ПРЕСЕТЫ, ГЛАВНОЕ ОКНО, ПУБЛИЧНОЕ API
  // ===========================================================================
  const overrides = {};
  try { Object.assign(overrides, JSON.parse(localStorage.getItem('wm_tree_overrides') || '{}')); } catch (e) { }
  const loadCustom = () => { try { return JSON.parse(localStorage.getItem('wm_custom_tree_presets') || '{}'); } catch (e) { return {}; } };

  function recipeToMeshData(recipe, lod) {
    const v = Core.toMesh(recipe, lod || 0).v;
    return { data: new Float32Array(v), count: v.length / 8 };
  }

  function refreshPresetsSelect(selectKey) {
    if (!editorWin) return;
    const pSel = editorWin.querySelector('#te-preset-sel');
    if (!pSel) return;
    pSel.innerHTML = '';
    const grp = document.createElement('optgroup'); grp.label = 'Базовые деревья';
    for (const k in DEFAULT_PRESETS) { const o = document.createElement('option'); o.value = 'def:' + k; o.textContent = DEFAULT_PRESETS[k].name; grp.append(o); }
    pSel.append(grp);
    const custom = loadCustom(), keys = Object.keys(custom);
    if (keys.length) {
      const g2 = document.createElement('optgroup'); g2.label = 'Мои сохранённые';
      keys.forEach(k => { const o = document.createElement('option'); o.value = 'cust:' + k; o.textContent = custom[k].name; g2.append(o); });
      pSel.append(g2);
    }
    if (selectKey) pSel.value = selectKey.startsWith('cust:') ? selectKey : 'cust:' + selectKey;
    const delBtn = editorWin.querySelector('#te-del-preset');
    const sync = () => { if (delBtn) delBtn.disabled = !pSel.value.startsWith('cust:'); };
    pSel.onchange = () => {
      const val = pSel.value;
      if (val.startsWith('def:')) loadRecipe(DEFAULT_PRESETS[val.slice(4)]);
      else { const c = loadCustom()[val.slice(5)]; if (c) loadRecipe(c); }
      sync();
    };
    sync();
  }

  function closeEditor() {
    activeSyncToSlice3D = null;
    if (WM.slice3d && WM.slice3d.resetTreePreview) {
      WM.slice3d.resetTreePreview();
    }
    if (!editorWin) return;
    cancelAnimationFrame(autoRotId); autoRotate = false;
    if (onKey) window.removeEventListener('keydown', onKey);
    if (resizeObs) resizeObs.disconnect();
    try { const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { }
    gl = null; onKey = null; resizeObs = null;
    editorWin.remove(); editorWin = null;
  }

  function showToast(text) {
    if (!editorWin) return;
    const t = editorWin.querySelector('#te-toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 2600);
  }

  function updateActionBar() {
    if (!editorWin) return;
    const badge = editorWin.querySelector('#te-source-badge');
    const actUpdate = editorWin.querySelector('#te-act-update-slot');
    const actAdd = editorWin.querySelector('#te-act-add-new');
    const sel = editorWin.querySelector('#te-tree-picker');
    const mapBtn = editorWin.querySelector('#te-map-drop-btn');

    const name = currentRecipe.name || 'Без названия';

    if (currentTarget.mode === 'slot' && currentTarget.slot != null) {
      const slotNum = currentTarget.slot + 1;
      if (badge) {
        badge.className = 'te-source-badge on-map';
        badge.innerHTML = `🟢 Слот #${slotNum}`;
        badge.title = `Модель привязана к карте: Слот #${slotNum} (${name})`;
      }
      if (actUpdate) {
        actUpdate.disabled = false;
        actUpdate.innerHTML = `💾 Обновить слот #${slotNum} на карте`;
        actUpdate.title = `Перезаписать параметры дерева в слоте #${slotNum}`;
      }
      if (mapBtn) {
        mapBtn.className = 'te-btn sm';
      }
    } else {
      if (badge) {
        badge.className = 'te-source-badge not-on-map';
        badge.innerHTML = `📦 Шаблон`;
        badge.title = `Заготовка «${name}» (ещё не добавлена на карту)`;
      }
      if (actUpdate) {
        actUpdate.disabled = true;
        actUpdate.innerHTML = `💾 Обновить слот (нет на карте)`;
        actUpdate.title = `Дерево пока не добавлено на карту`;
      }
      if (mapBtn) {
        mapBtn.className = 'te-btn sec sm';
      }
    }

    if (actAdd) {
      actAdd.innerHTML = `➕ Добавить как новое на карту`;
    }

    if (sel) {
      if (currentTarget.mode === 'slot' && currentTarget.slot != null) {
        sel.value = 'slot:' + currentTarget.slot;
      } else if (currentTarget.mode === 'template' && currentTarget.key) {
        sel.value = 'tpl:' + currentTarget.key;
      } else if (currentTarget.mode === 'custom' && currentTarget.key) {
        sel.value = 'cust:' + currentTarget.key;
      }
    }
  }

  function refreshTreePicker() {
    if (!editorWin) return;
    const sel = editorWin.querySelector('#te-tree-picker');
    if (!sel) return;
    sel.innerHTML = '';

    const S3D = WM.slice3d;
    const activeTrees = (S3D && S3D.getRawActiveCatalog) ? S3D.getRawActiveCatalog() : [];

    // 1. Деревья на карте
    if (activeTrees.length) {
      const grpScene = document.createElement('optgroup');
      grpScene.label = '🌲 Деревья на карте (в сцене)';
      activeTrees.forEach((t, idx) => {
        const opt = document.createElement('option');
        opt.value = 'slot:' + idx;
        const icon = (t.eco && t.eco.kind === 'conifer') ? '🌲' : '🌳';
        opt.textContent = `${icon} #${idx + 1}. ${t.name || 'Дерево'}`;
        grpScene.appendChild(opt);
      });
      sel.appendChild(grpScene);
    }

    // 2. Шаблоны и заготовки
    const grpTpl = document.createElement('optgroup');
    grpTpl.label = '📦 Библиотека заготовок (нет на карте)';
    for (const k in DEFAULT_PRESETS) {
      const opt = document.createElement('option');
      opt.value = 'tpl:' + k;
      opt.textContent = DEFAULT_PRESETS[k].name;
      grpTpl.appendChild(opt);
    }
    sel.appendChild(grpTpl);

    // 3. Пользовательские шаблоны
    const custom = loadCustom();
    const customKeys = Object.keys(custom);
    if (customKeys.length) {
      const grpCust = document.createElement('optgroup');
      grpCust.label = '💾 Мои сохранённые шаблоны';
      customKeys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = 'cust:' + k;
        opt.textContent = custom[k].name;
        grpCust.appendChild(opt);
      });
      sel.appendChild(grpCust);
    }

    updateActionBar();
  }

  function openEditor(startRecipe, options) {
    options = options || {};
    if (editorWin) {
      if (startRecipe && typeof startRecipe === 'object') {
        const target = (options.slot != null) ? { mode: 'slot', slot: options.slot } : { mode: 'new' };
        loadRecipe(startRecipe, target);
      }
      return;
    }
    if (!document.getElementById('te-style')) {
      const s = document.createElement('style'); s.id = 'te-style'; s.textContent = CSS; document.head.append(s);
    }
    editorWin = document.createElement('div');
    editorWin.className = 'te-modal';
    editorWin.innerHTML = `
      <div class="te-head">
        <div class="te-head-left">
          <b>🌲 Конструктор 3D</b>
        </div>

        <div class="te-head-center">
          <select id="te-tree-picker" class="te-btn sec sm" style="padding:3px 6px;font-size:12px;max-width:210px;text-overflow:ellipsis" title="Выбор дерева для редактирования"></select>
          <span id="te-source-badge" class="te-source-badge on-map">...</span>
          <button class="te-btn sec sm" id="te-new-btn" title="Создать новое дерево с чистого листа">＋</button>

          <div style="width:1px;height:16px;background:#30363d;margin:0 2px"></div>

          <div class="te-dropdown" id="te-map-dropdown">
            <button class="te-btn sm" id="te-map-drop-btn" title="Действия с картой (обновить слот или добавить новое)">
              🗺️ На карту ▾
            </button>
            <div class="te-dropdown-menu">
              <button class="te-dropdown-item" id="te-act-update-slot">💾 Обновить текущий слот</button>
              <button class="te-dropdown-item" id="te-act-add-new">➕ Добавить как новое дерево</button>
            </div>
          </div>

          <button class="te-btn sec sm" id="te-save-preset" title="Сохранить в шаблоны браузера (localStorage)">
            💾 Шаблон
          </button>
        </div>

        <div class="te-head-right">
          <button class="te-btn sec sm" id="te-btn-undo" title="Отменить (Ctrl+Z)" disabled>↶</button>
          <button class="te-btn sec sm" id="te-btn-redo" title="Повторить (Ctrl+Y)" disabled>↷</button>
          <div style="width:1px;height:16px;background:#30363d;margin:0 2px"></div>
          <button class="te-btn sec sm" id="te-helpers-btn" title="Сетка и силуэт человека">📐</button>
          <button class="te-btn sec sm" id="te-wire-btn" title="Сетка каркаса">Каркас</button>
          <button class="te-btn sec sm" id="te-lod-btn" title="Уровень детализации">LOD: 0</button>
          <button class="te-btn danger sm" id="te-close-btn" title="Закрыть редактор">✕</button>
        </div>
      </div>

      <div class="te-body">
        <div class="te-viewport">
          <canvas id="te-canvas"></canvas>
          <div class="te-toast" id="te-toast"></div>
          <div class="te-badge" id="te-stats">...</div>
          <div class="te-cam">
            <button class="te-btn sec sm" id="cam-front" title="Вид спереди">Перед</button>
            <button class="te-btn sec sm" id="cam-side" title="Вид сбоку">Бок</button>
            <button class="te-btn sec sm" id="cam-top" title="Вид сверху">Верх</button>
            <button class="te-btn sec sm" id="te-focus-btn" title="Показать всё (F)">🎯</button>
            <button class="te-btn sec sm" id="te-auto-btn" title="Вращение">⟳</button>
            <button class="te-btn sec sm" id="te-png-btn" title="Скриншот PNG">📷</button>
          </div>
          <div class="te-sim-bar">
            <h5>🍂 Превью сезонов и снега</h5>
            <div class="te-row" style="margin-bottom:2px">
              <label style="flex:0 0 55px">Сезон</label>
              <select id="sim-season-mode" style="flex:1;font-size:11px;padding:1px 4px">
                <option value="summer">☀️ Лето (базовый)</option>
                <option value="earlySpring">🌱 Ранняя весна</option>
                <option value="spring">🌿 Весна</option>
                <option value="autumn">🍁 Золотая осень</option>
                <option value="lateAutumn">🍂 Поздняя осень</option>
                <option value="winter">❄️ Зима (листопад)</option>
              </select>
            </div>
            <div class="te-row">
              <label style="flex:0 0 55px" id="sim-season-lbl">Прогресс</label>
              <input type="range" min="0" max="1" step="0.05" value="1" id="sim-season-progress">
              <span class="te-val" id="sim-season-v">100%</span>
            </div>
            <div class="te-row" style="margin-top:4px">
              <label style="flex:0 0 55px">Снег</label>
              <input type="range" min="0" max="1" step="0.05" value="0" id="sim-snow">
              <span class="te-val" id="sim-snow-v">0%</span>
            </div>
          </div>
        </div>
        <div class="te-side">
          <div class="te-tabs">
            <div class="te-tab act" data-t="trunk">Ствол</div>
            <div class="te-tab" data-t="branches">Ветки</div>
            <div class="te-tab" data-t="foliage">Крона</div>
            <div class="te-tab" data-t="gen">Генератор</div>
            <div class="te-tab" data-t="eco">Экология</div>
            <div class="te-tab" data-t="code">Экспорт</div>
          </div>
          <div class="te-content" id="te-pane"></div>
        </div>
      </div>`;
    document.body.append(editorWin);
    activeTab = 'trunk'; activeSelection = null;

    if (startRecipe && typeof startRecipe === 'object') {
      currentRecipe = ensureRecipe(clone(startRecipe));
      currentTarget = (options.slot != null) ? { mode: 'slot', slot: options.slot } : { mode: 'new' };
    } else {
      const activeCat = (WM.slice3d && WM.slice3d.getRawActiveCatalog) ? WM.slice3d.getRawActiveCatalog() : [];
      if (activeCat.length) {
        currentRecipe = ensureRecipe(clone(activeCat[0]));
        currentTarget = { mode: 'slot', slot: 0 };
      } else {
        currentRecipe = ensureRecipe(clone(Object.values(DEFAULT_PRESETS)[0]));
        currentTarget = { mode: 'template', key: Object.keys(DEFAULT_PRESETS)[0] };
      }
    }

    const $ = s => editorWin.querySelector(s);

    $('#sim-season-mode').onchange = e => { 
      sim.seasonMode = e.target.value; 
      recalcSimState(); 
    };

    $('#sim-season-progress').oninput = e => { 
      sim.seasonProgress = +e.target.value; 
      recalcSimState(); 
    };

    $('#sim-snow').oninput = e => {
      sim.snow = +e.target.value;
      $('#sim-snow-v').textContent = Math.round(sim.snow * 100) + '%';
      renderFrame();
    };

    // Автоматическая передача изменений в Slice3D при редактировании слота карты
    activeSyncToSlice3D = () => {
      if (!WM.slice3d || !WM.slice3d.livePreviewTree) return;
      if (currentTarget.mode === 'slot' && currentTarget.slot != null) {
        WM.slice3d.livePreviewTree(currentTarget.slot, currentRecipe, false);
      }
    };

    $('#te-btn-undo').onclick = undo;
    $('#te-btn-redo').onclick = redo;
    history = [JSON.stringify(currentRecipe)];
    historyIdx = 0;

    refreshTreePicker();

    $('#te-tree-picker').onchange = e => {
      const val = e.target.value;
      if (val.startsWith('slot:')) {
        const slotIdx = parseInt(val.slice(5), 10);
        const cat = WM.slice3d ? WM.slice3d.getRawActiveCatalog() : [];
        if (cat[slotIdx]) {
          loadRecipe(cat[slotIdx], { mode: 'slot', slot: slotIdx });
        }
      } else if (val.startsWith('tpl:')) {
        const key = val.slice(4);
        if (DEFAULT_PRESETS[key]) {
          loadRecipe(DEFAULT_PRESETS[key], { mode: 'template', key: key });
        }
      } else if (val.startsWith('cust:')) {
        const key = val.slice(5);
        const custom = loadCustom();
        if (custom[key]) {
          loadRecipe(custom[key], { mode: 'custom', key: key });
        }
      }
    };

    const mapDropdown = $('#te-map-dropdown');
    $('#te-map-drop-btn').onclick = (e) => {
      e.stopPropagation();
      mapDropdown.classList.toggle('open');
    };

    window.addEventListener('click', () => {
      if (mapDropdown) mapDropdown.classList.remove('open');
    });

    $('#te-act-update-slot').onclick = () => {
      mapDropdown.classList.remove('open');
      if (currentTarget.mode === 'slot' && currentTarget.slot != null) {
        if (WM.slice3d && WM.slice3d.updateTreeSlot) {
          WM.slice3d.updateTreeSlot(currentTarget.slot, currentRecipe);
          showToast(`✓ Слот #${currentTarget.slot + 1} обновлён на карте!`);
          if (WM.treePalette && WM.treePalette.refresh) WM.treePalette.refresh();
          refreshTreePicker();
        }
      }
    };

    $('#te-act-add-new').onclick = () => {
      mapDropdown.classList.remove('open');
      if (WM.slice3d && WM.slice3d.addNewTree) {
        WM.slice3d.addNewTree(currentRecipe);
        const newCat = WM.slice3d.getRawActiveCatalog();
        const newIdx = newCat.length - 1;
        currentTarget = { mode: 'slot', slot: newIdx };
        showToast(`✓ Добавлено на карту в Слот #${newIdx + 1}!`);
        if (WM.treePalette && WM.treePalette.refresh) WM.treePalette.refresh();
        refreshTreePicker();
      }
    };

    $('#te-save-preset').onclick = () => {
      const name = prompt('Название для шаблона:', currentRecipe.name || 'Моё дерево');
      if (!name) return;
      currentRecipe.name = name;
      const key = 'custom_' + Date.now(), c = loadCustom();
      c[key] = clone(currentRecipe);
      try { localStorage.setItem('wm_custom_tree_presets', JSON.stringify(c)); } catch (e) {}
      showToast('✓ Сохранено в шаблоны');
      refreshTreePicker();
    };

    $('#te-new-btn').onclick = () => {
      loadRecipe({
        name: 'Новое дерево',
        trunk: { seg: 7, smooth: 1, rings: [{ x: 0, y: 0, z: 0, r: 0.08 }, { x: 0, y: 0.5, z: 0, r: 0.04 }] },
        branches: [],
        foliage: [newFoliage('blob')]
      }, { mode: 'new' });
    };

    $('#te-focus-btn').onclick = () => frameCamera();
    $('#te-helpers-btn').onclick = e => { showHelpers = !showHelpers; e.target.classList.toggle('act', showHelpers); renderFrame(); };
    $('#te-wire-btn').onclick = e => { isWireframe = !isWireframe; e.target.classList.toggle('act', isWireframe); rebuildNow(); };
    $('#te-lod-btn').onclick = e => { curLOD = (curLOD + 1) % 3; e.target.textContent = 'LOD: ' + curLOD; updateMesh(); };
    $('#te-close-btn').onclick = closeEditor;
    const view = (yaw, pitch) => { camYaw = yaw; camPitch = pitch; renderFrame(); };
    $('#cam-front').onclick = () => view(0, 0.05);
    $('#cam-side').onclick = () => view(Math.PI / 2, 0.05);
    $('#cam-top').onclick = () => view(0, 1.5);
    $('#te-auto-btn').onclick = e => {
      autoRotate = !autoRotate; e.target.classList.toggle('act', autoRotate);
      cancelAnimationFrame(autoRotId);
      const loop = () => { if (!autoRotate || !editorWin) return; camYaw += 0.012; renderFrame(); autoRotId = requestAnimationFrame(loop); };
      if (autoRotate) loop();
    };
    $('#te-png-btn').onclick = () => {
      renderFrame();
      const a = document.createElement('a'); a.href = gl.canvas.toDataURL('image/png');
      a.download = (currentRecipe.name || 'tree').replace(/[^\w\-а-яА-Я]+/g, '_') + '.png'; document.body.append(a); a.click(); a.remove();
    };

    const tabs = editorWin.querySelectorAll('.te-tab');
    tabs.forEach(t => t.onclick = () => {
      tabs.forEach(x => x.classList.remove('act')); t.classList.add('act');
      activeTab = t.dataset.t; activeSelection = null;
      renderInspector(activeTab); updateMesh();
    });

    const cv = $('#te-canvas');
    if (!initGL(cv)) { cv.replaceWith(el('div', null, '<p style="padding:20px;color:#f85149">WebGL2 недоступен</p>')); return; }

    let dragMode = 0, lx = 0, ly = 0;
    cv.oncontextmenu = e => e.preventDefault();
    cv.onpointerdown = e => { dragMode = (e.button === 2 || e.shiftKey) ? 2 : 1; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => {
      if (!dragMode) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (dragMode === 1) { camYaw -= dx * 0.008; camPitch = Math.max(-0.2, Math.min(1.55, camPitch + dy * 0.008)); }
      else {
        const sp = camDist * 0.0018;
        camTarget[0] -= Math.cos(camYaw) * dx * sp; camTarget[2] += Math.sin(camYaw) * dx * sp; camTarget[1] += dy * sp;
      }
      renderFrame();
    };
    cv.onpointerup = cv.onpointercancel = () => { dragMode = 0; };
    cv.onwheel = e => { e.preventDefault(); camDist = Math.max(0.4, Math.min(10, camDist * (e.deltaY > 0 ? 1.08 : 0.92))); renderFrame(); };

    onKey = e => {
      if (!editorWin) return;
      const tg = e.target && e.target.tagName;
      if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
      if (e.ctrlKey && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'я')) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (e.ctrlKey && (e.code === 'KeyY' || e.key === 'y' || e.key === 'н')) { e.preventDefault(); redo(); }
      else if (e.code === 'KeyF' || e.key === 'f' || e.key === 'а') frameCamera();
      else if (e.key === 'Escape') { activeSelection = null; renderInspector(activeTab); updateMesh(); }
    };
    window.addEventListener('keydown', onKey);

    if (window.ResizeObserver) { resizeObs = new ResizeObserver(() => renderFrame()); resizeObs.observe($('.te-viewport')); }

    renderInspector('trunk');
    rebuildNow();
    frameCamera();
    updateUndoRedoBtns();
  }

  // Публичное API
  const api = {
    open: openEditor, core: Core, presets: DEFAULT_PRESETS, overrides,
    recipeToMeshData, generateJsCode, generateObj,
    generateTrunk, generateBranches, defaultGen: DEFAULT_GEN
  };
  WM.treeEditor = api;
  WM.slice3d = WM.slice3d || {};
  WM.slice3d.openTreeEditor = openEditor;
  WM.slice3d.treeRecipeToMeshData = recipeToMeshData;
  WM.slice3d.treeOverrides = overrides;
})();