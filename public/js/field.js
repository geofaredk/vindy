// Decoding of /api/field payloads and spatial sampling.
import { makeLcc } from './lcc.js';

// A decoded field has one or more `parts`, each a regular grid with its own bands.
// DINI layers come as [fine 2 km Denmark, coarse 6 km wider area]; sampling prefers
// the fine grid and blends into the coarse one near its edge.
export function decodeField(buffer) {
  const dv = new DataView(buffer);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
  const grids = header.grids || { main: header.grid };
  const parts = {};
  for (const [key, grid] of Object.entries(grids)) parts[key] = { key, grid, projector: makeProjector(grid), bands: {} };
  let off = 4 + hlen;
  for (const b of header.bands) {
    const part = parts[b.grid || Object.keys(parts)[0]];
    const n = b.n ?? part.grid.w * part.grid.h;
    const raw = new Int16Array(buffer.slice(off, off + n * 2));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = raw[i] === -32768 ? NaN : raw[i] * b.scale + b.offset;
    part.bands[b.name] = out;
    off += n * 2;
  }
  const ordered = ['fine', 'coarse', 'main'].map(k => parts[k]).filter(Boolean);
  return { layer: header.layer, time: header.time, run: header.run, parts: ordered };
}

// Same payload as decodeField, but keeps each band as Int16 + scale/offset. Used for
// accumulated precipitation, where every hour of the run is held in memory at once.
export function decodeFieldRaw(buffer) {
  const dv = new DataView(buffer);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
  const grids = header.grids || { main: header.grid };
  const parts = {};
  for (const [key, grid] of Object.entries(grids)) parts[key] = { key, grid, projector: makeProjector(grid), bands: {} };
  let off = 4 + hlen;
  for (const b of header.bands) {
    const part = parts[b.grid || Object.keys(parts)[0]];
    const n = b.n ?? part.grid.w * part.grid.h;
    part.bands[b.name] = { data: new Int16Array(buffer, off, n), scale: b.scale, offset: b.offset };
    off += n * 2;
  }
  return { time: header.time, run: header.run, parts: ['fine', 'coarse', 'main'].map(k => parts[k]).filter(Boolean) };
}

const BLEND = 10; // fine-grid cells over which fine fades into coarse

// Sample band `name` given grid coordinates for the first two parts.
export function sampleParts(parts, name, fi0, fj0, fi1, fj1) {
  const p0 = parts[0];
  const v0 = sample(p0.bands[name], p0.grid, fi0, fj0);
  const p1 = parts[1];
  if (!p1) return v0;
  const g = p0.grid;
  const edge = Math.min(fi0, fj0, g.w - 1 - fi0, g.h - 1 - fj0);
  if (edge >= BLEND && !Number.isNaN(v0)) return v0;
  const v1 = sample(p1.bands[name], p1.grid, fi1, fj1);
  if (Number.isNaN(v0)) return v1;
  if (Number.isNaN(v1)) return v0;
  const w = Math.max(0, edge) / BLEND;
  return v0 * w + v1 * (1 - w);
}

export function valueAt(field, lat, lon, name = 'v') {
  const [a0, b0] = field.parts[0].projector.toGrid(lon, lat);
  const [a1, b1] = field.parts[1] ? field.parts[1].projector.toGrid(lon, lat) : [0, 0];
  return sampleParts(field.parts, name, a0, b0, a1, b1);
}

// Returns fn(lon, lat) -> [fi, fj] fractional grid indices (or null outside).
export function makeProjector(grid) {
  if (grid.type === 'lcc') {
    const P = makeLcc(grid);
    return {
      key: `lcc:${grid.x0}:${grid.y0}:${grid.w}:${grid.h}`,
      toGrid(lon, lat) { const [x, y] = P.forward(lon, lat); return [(x - grid.x0) / grid.dx, (y - grid.y0) / grid.dy]; },
      toLonLat(fi, fj) { return P.inverse(grid.x0 + fi * grid.dx, grid.y0 + fj * grid.dy); },
    };
  }
  return {
    key: `ll:${grid.lon0}:${grid.lat0}:${grid.w}:${grid.h}`,
    toGrid(lon, lat) { return [(lon - grid.lon0) / grid.dlon, (lat - grid.lat0) / grid.dlat]; },
    toLonLat(fi, fj) { return [grid.lon0 + fi * grid.dlon, grid.lat0 + fj * grid.dlat]; },
  };
}

// Bilinear sample with NaN awareness.
export function sample(band, grid, fi, fj) {
  const { w, h } = grid;
  if (!(fi >= 0 && fj >= 0 && fi <= w - 1 && fj <= h - 1)) return NaN;
  const i = Math.min(Math.floor(fi), w - 2), j = Math.min(Math.floor(fj), h - 2);
  const a = fi - i, b = fj - j;
  const k = j * w + i;
  const v00 = band[k], v10 = band[k + 1], v01 = band[k + w], v11 = band[k + w + 1];
  if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) {
    const ni = Math.round(fi), nj = Math.round(fj);
    return band[nj * w + ni];
  }
  return (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
}


// Marching squares isolines -> array of [[lon,lat],[lon,lat]] segments per level.
export function isolines(field, step, name = 'v', stride = 3) {
  const { w, h } = field.grid;
  const band = field.bands[name];
  let min = Infinity, max = -Infinity;
  for (const v of band) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  const out = [];
  for (let level = Math.ceil(min / step) * step; level <= max; level += step) {
    const segs = [];
    for (let j = 0; j + stride < h; j += stride) {
      for (let i = 0; i + stride < w; i += stride) {
        const v0 = band[j * w + i], v1 = band[j * w + i + stride], v2 = band[(j + stride) * w + i + stride], v3 = band[(j + stride) * w + i];
        if (!(Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(v2) && Number.isFinite(v3))) continue;
        const c = (v0 > level ? 1 : 0) | (v1 > level ? 2 : 0) | (v2 > level ? 4 : 0) | (v3 > level ? 8 : 0);
        if (c === 0 || c === 15) continue;
        const e = [
          [i + stride * (level - v0) / (v1 - v0), j],
          [i + stride, j + stride * (level - v1) / (v2 - v1)],
          [i + stride * (level - v3) / (v2 - v3), j + stride],
          [i, j + stride * (level - v0) / (v3 - v0)],
        ];
        const pairs = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] }[c];
        for (const [a, b] of pairs) segs.push([field.projector.toLonLat(...e[a]), field.projector.toLonLat(...e[b])]);
      }
    }
    out.push({ level, segs });
  }
  return out;
}

// Local pressure highs/lows: grid points that are the extreme value within `radius`
// cells and differ from the surrounding ring mean by at least `prominence`.
export function extrema(field, { radius = 60, stride = 6, prominence = 1.2, name = 'v' } = {}) {
  const { w, h } = field.grid;
  const band = field.bands[name];
  const out = [];
  const r = Math.round(radius / stride);
  const W = Math.floor(w / stride), H = Math.floor(h / stride);
  const sub = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) sub[j * W + i] = band[j * stride * w + i * stride];
  for (let j = r; j < H - r; j++) {
    for (let i = r; i < W - r; i++) {
      const c = sub[j * W + i];
      if (!Number.isFinite(c)) continue;
      let isMax = true, isMin = true, sum = 0, n = 0;
      for (let dj = -r; dj <= r && (isMax || isMin); dj++) {
        for (let di = -r; di <= r; di++) {
          if (!di && !dj) continue;
          const v = sub[(j + dj) * W + i + di];
          if (v >= c) isMax = false;
          if (v <= c) isMin = false;
          if (Math.abs(di) === r || Math.abs(dj) === r) { sum += v; n++; }
        }
      }
      if (!isMax && !isMin) continue;
      if (Math.abs(c - sum / n) < prominence) continue;
      const [lon, lat] = field.projector.toLonLat(i * stride, j * stride);
      out.push({ type: isMax ? 'H' : 'L', value: c, lon, lat });
    }
  }
  return out;
}
