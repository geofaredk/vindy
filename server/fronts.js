// Objective front detection from DMI HARMONIE DINI 850 hPa wet-bulb potential
// temperature (θw) and wind, using the thermal front parameter (Renard & Clarke 1965,
// Hewson 1998). Fronts are lines of maximum θw gradient inside strong baroclinic zones;
// cold/warm/stationary is decided by the wind component across the front.

// Separable box blur, repeated passes approximate a Gaussian. NaN-free input assumed.
function blur(src, w, h, r, passes) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) {
      let s = 0, n = 0;
      for (let i = -r; i <= r; i++) { const x = Math.min(w - 1, Math.max(0, i)); s += a[j * w + x]; n++; }
      for (let i = 0; i < w; i++) {
        b[j * w + i] = s / n;
        const add = Math.min(w - 1, i + r + 1), rem = Math.max(0, i - r);
        s += a[j * w + add] - a[j * w + rem];
      }
    }
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let j = -r; j <= r; j++) { const y = Math.min(h - 1, Math.max(0, j)); s += b[y * w + i]; n++; }
      for (let j = 0; j < h; j++) {
        a[j * w + i] = s / n;
        const add = Math.min(h - 1, j + r + 1), rem = Math.max(0, j - r);
        s += b[add * w + i] - b[rem * w + i];
      }
    }
  }
  return a;
}

function grad(f, w, h, ds) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    const il = Math.max(0, i - 1), ir = Math.min(w - 1, i + 1), jd = Math.max(0, j - 1), ju = Math.min(h - 1, j + 1);
    gx[k] = (f[j * w + ir] - f[j * w + il]) / ((ir - il) * ds);
    gy[k] = (f[ju * w + i] - f[jd * w + i]) / ((ju - jd) * ds);
  }
  return [gx, gy];
}

export const FRONT_PARAMS = {
  smoothRadius: 3, smoothPasses: 3, // cells of the averaged grid
  minGradient: 0.025, // K/km (2.5 K per 100 km) of smoothed θw
  minSpeed: 1.2, // m/s cross-front wind to call a front cold or warm
  minLengthKm: 300,
};

// theta, u, v: Float32Array on a regular grid with spacing ds (km), grid-relative winds.
// toLonLat(fi, fj) maps averaged-grid indices to geographic coordinates.
export function detectFronts({ theta, u, v, w, h, ds, toLonLat }, P = FRONT_PARAMS) {
  const th = blur(theta, w, h, P.smoothRadius, P.smoothPasses);
  const us = blur(u, w, h, 2, 2), vs = blur(v, w, h, 2, 2);
  const [gx, gy] = grad(th, w, h, ds);
  const mag = new Float32Array(w * h);
  for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(gx[k], gy[k]);
  const [mx, my] = grad(mag, w, h, ds);
  const tfp = new Float32Array(w * h), nx = new Float32Array(w * h), ny = new Float32Array(w * h);
  for (let k = 0; k < tfp.length; k++) {
    const m = mag[k] || 1e-9;
    nx[k] = gx[k] / m; ny[k] = gy[k] / m;
    tfp[k] = -(mx[k] * nx[k] + my[k] * ny[k]);
  }
  const [tx, ty] = grad(tfp, w, h, ds);

  // Marching squares on TFP = 0, restricted to strong-gradient maxima.
  const segs = [];
  const interp = (a, b, va, vb) => a + (b - a) * (va / (va - vb));
  for (let j = 1; j < h - 2; j++) {
    for (let i = 1; i < w - 2; i++) {
      const k0 = j * w + i, k1 = k0 + 1, k2 = k0 + w + 1, k3 = k0 + w;
      const mMean = (mag[k0] + mag[k1] + mag[k2] + mag[k3]) / 4;
      if (mMean < P.minGradient) continue;
      // |∇θ| must be a maximum across the front: TFP increases along ĝ.
      const loc = ((tx[k0] + tx[k2]) * (nx[k0] + nx[k2]) + (ty[k0] + ty[k2]) * (ny[k0] + ny[k2])) / 4;
      if (loc <= 0) continue;
      const v0 = tfp[k0], v1 = tfp[k1], v2 = tfp[k2], v3 = tfp[k3];
      const c = (v0 > 0 ? 1 : 0) | (v1 > 0 ? 2 : 0) | (v2 > 0 ? 4 : 0) | (v3 > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const e = [
        [interp(i, i + 1, v0, v1), j], [i + 1, interp(j, j + 1, v1, v2)],
        [interp(i, i + 1, v3, v2), j + 1], [i, interp(j, j + 1, v0, v3)],
      ];
      const pairs = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] }[c];
      for (const [a, b] of pairs) segs.push([e[a], e[b]]);
    }
  }

  const lines = joinSegments(segs);
  const sample = (arr, x, y) => {
    const i = Math.min(w - 2, Math.max(0, Math.floor(x))), j = Math.min(h - 2, Math.max(0, Math.floor(y)));
    const a = x - i, b = y - j, k = j * w + i;
    return (arr[k] * (1 - a) + arr[k + 1] * a) * (1 - b) + (arr[k + w] * (1 - a) + arr[k + w + 1] * a) * b;
  };

  const fronts = [];
  for (let line of lines) {
    line = chaikin(line, 2);
    // Classify each vertex by the wind blowing across the front towards warm air.
    const cls = line.map(([x, y]) => {
      const c = sample(us, x, y) * sample(nx, x, y) + sample(vs, x, y) * sample(ny, x, y);
      return c > P.minSpeed ? 'cold' : c < -P.minSpeed ? 'warm' : 'stationary';
    });
    // Majority filter to avoid flickering classes along the line.
    const smooth = cls.map((_, k) => {
      const cnt = {};
      for (let d = -4; d <= 4; d++) { const c = cls[k + d]; if (c) cnt[c] = (cnt[c] || 0) + 1; }
      return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    });
    let start = 0;
    for (let k = 1; k <= line.length; k++) {
      if (k < line.length && smooth[k] === smooth[start]) continue;
      const run = line.slice(Math.max(0, start - 1), k);
      start = k;
      if (run.length < 2) continue;
      let len = 0;
      for (let q = 1; q < run.length; q++) len += Math.hypot(run[q][0] - run[q - 1][0], run[q][1] - run[q - 1][1]) * ds;
      if (len < P.minLengthKm) continue;
      const type = smooth[k - 1] ?? smooth[line.length - 1];
      // Orient so that symbols (on the left of the direction of travel) face the way
      // the front moves: towards warm air for cold fronts, towards cold air for warm.
      let dot = 0;
      for (let q = 1; q < run.length; q++) {
        const [x0, y0] = run[q - 1], [x1, y1] = run[q];
        const lx = -(y1 - y0), ly = x1 - x0;
        const gxq = sample(nx, x0, y0), gyq = sample(ny, x0, y0);
        dot += (lx * gxq + ly * gyq) * (type === 'warm' ? -1 : 1);
      }
      if (dot < 0) run.reverse();
      fronts.push({ type, coords: simplify(run, 0.25).map(([x, y]) => toLonLat(x, y).map(n => Math.round(n * 1000) / 1000)) });
    }
  }
  return fronts;
}

export function joinSegments(segs) {
  const key = p => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const ends = new Map();
  const used = new Uint8Array(segs.length);
  segs.forEach((s, idx) => {
    for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(idx); }
  });
  const lines = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s][0], segs[s][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find(n => !used[n]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segs[next];
        const other = key(a) === key(tip) ? b : a;
        if (dir) line.push(other); else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

// Douglas-Peucker simplification (tolerance in grid cells).
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let idx = -1, max = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function chaikin(pts, iterations) {
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
