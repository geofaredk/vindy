// EUMETNET OPERA European radar composite (EURADCOM), maximum reflectivity (DBZH),
// read as cloud-optimized GeoTIFF from the public Open Radar Data S3 bucket and
// reprojected to Web Mercator PNG tiles covering Denmark.
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Lru, once, diskGet, diskPut, CACHE_DIR } from './util.js';

const BUCKET = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
// Output image extent (lon/lat) — a bit wider than the forecast window.
export const RADAR_BOUNDS = { west: -1.5, east: 23.5, south: 51.3, north: 61.2 };
const OUT_W = 2000;

const laea = '+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84 +units=m +no_defs';
const toLaea = proj4('EPSG:4326', laea);

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
const OUT_H = Math.round(OUT_W * (mercY(RADAR_BOUNDS.north) - mercY(RADAR_BOUNDS.south)) / ((RADAR_BOUNDS.east - RADAR_BOUNDS.west) * Math.PI / 180));

// Composite grid: origin (-500, 500) m, 1000 m pixels, see GeoTIFF tags.
const ORIGIN_X = -500, ORIGIN_Y = 500, RES = 1000;

let mapping = null;
function buildMapping() {
  if (mapping) return mapping;
  const src = new Int32Array(OUT_W * OUT_H * 2);
  let cmin = Infinity, cmax = -Infinity, rmin = Infinity, rmax = -Infinity;
  const y0 = mercY(RADAR_BOUNDS.north), y1 = mercY(RADAR_BOUNDS.south);
  for (let r = 0; r < OUT_H; r++) {
    const lat = invMercY(y0 + (y1 - y0) * (r + 0.5) / OUT_H);
    for (let c = 0; c < OUT_W; c++) {
      const lon = RADAR_BOUNDS.west + (RADAR_BOUNDS.east - RADAR_BOUNDS.west) * (c + 0.5) / OUT_W;
      const [x, y] = toLaea.forward([lon, lat]);
      const col = Math.floor((x - ORIGIN_X) / RES), row = Math.floor((ORIGIN_Y - y) / RES);
      src[(r * OUT_W + c) * 2] = col; src[(r * OUT_W + c) * 2 + 1] = row;
      cmin = Math.min(cmin, col); cmax = Math.max(cmax, col); rmin = Math.min(rmin, row); rmax = Math.max(rmax, row);
    }
  }
  mapping = { src, win: [cmin, rmin, cmax + 1, rmax + 1] };
  return mapping;
}

// dBZ colour ramp (value, r, g, b, a)
const STOPS = [
  [4, 80, 150, 255, 0], [7, 90, 160, 255, 110], [12, 60, 130, 245, 170], [18, 30, 170, 200, 200],
  [23, 40, 190, 90, 215], [28, 150, 210, 40, 225], [33, 250, 225, 40, 235], [38, 255, 160, 30, 245],
  [43, 245, 70, 40, 250], [48, 205, 25, 90, 255], [53, 190, 60, 200, 255], [60, 255, 230, 255, 255],
];
const LUT = (() => {
  const lut = new Uint8Array(256 * 4); // index: (dBZ + 10) * 3, i.e. -10..75 dBZ
  for (let k = 0; k < 256; k++) {
    const z = k / 3 - 10;
    let i = 0;
    while (i < STOPS.length - 2 && z > STOPS[i + 1][0]) i++;
    const a = STOPS[i], b = STOPS[i + 1];
    const t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
    for (let ch = 0; ch < 4; ch++) lut[k * 4 + ch] = Math.round(a[ch + 1] + (b[ch + 1] - a[ch + 1]) * (z < a[0] ? 0 : t));
    if (z < STOPS[0][0]) lut[k * 4 + 3] = 0;
  }
  return lut;
})();

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

const PALETTE = Buffer.alloc(256 * 3), ALPHA = Buffer.alloc(256);
for (let k = 0; k < 256; k++) {
  PALETTE[k * 3] = LUT[k * 4]; PALETTE[k * 3 + 1] = LUT[k * 4 + 1]; PALETTE[k * 3 + 2] = LUT[k * 4 + 2];
  ALPHA[k] = k === 0 ? 0 : LUT[k * 4 + 3];
}

function encodePalettePng(width, height, indices) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit, palette
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('PLTE', PALETTE), pngChunk('tRNS', ALPHA),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let frameList = null, frameListAt = 0;

async function listDay(date) {
  const y = date.getUTCFullYear(), m = String(date.getUTCMonth() + 1).padStart(2, '0'), d = String(date.getUTCDate()).padStart(2, '0');
  const prefix = `${y}/${m}/${d}/OPERA/COMP/`;
  const since = new Date(Date.now() - 3.2 * 3600e3);
  const startAfter = `${prefix}OPERA@${stamp(since)}`;
  const keys = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) qs.set('continuation-token', token); else qs.set('start-after', startAfter);
    const res = await fetch(`${BUCKET}/?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`OPERA listing HTTP ${res.status}`);
    const xml = await res.text();
    for (const mm of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(mm[1]);
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!t) break;
    token = t[1];
  }
  return keys;
}

const stamp = d => d.toISOString().replace(/[-:]/g, '').slice(0, 13); // YYYYMMDDTHHMM

export async function radarFrames() {
  if (frameList && Date.now() - frameListAt < 60e3) return frameList;
  return once('radar-frames', async () => {
    const now = new Date();
    const days = [now];
    if (now.getUTCHours() < 4) days.unshift(new Date(now.getTime() - 86400e3));
    const keys = (await Promise.all(days.map(listDay))).flat();
    const frames = keys
      .map(k => k.match(/OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$/))
      .filter(Boolean)
      .map(m => m[1])
      .sort()
      .slice(-37);
    frameList = {
      bounds: RADAR_BOUNDS,
      source: 'EUMETNET OPERA radarkomposit (EURADCOM), CC BY 4.0',
      frames: frames.map(s => ({ id: s, time: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00Z` })),
    };
    frameListAt = Date.now();
    pruneRadarCache(new Set(frames)).catch(() => {});
    return frameList;
  });
}

// Keep only the frames that can still be shown (plus a small margin).
async function pruneRadarCache(current) {
  const dir = path.join(CACHE_DIR, 'radar');
  const oldest = [...current].sort()[0];
  for (const f of await fs.readdir(dir).catch(() => [])) {
    const id = f.replace(/\.png$/, '');
    if (!current.has(id) && id < oldest) await fs.rm(path.join(dir, f), { force: true });
  }
}

// Render new frames as soon as they appear so the radar layer never waits for them.
export async function warmRadar() {
  const { frames } = await radarFrames();
  for (const f of [...frames].reverse()) {
    try { await radarImage(f.id); } catch { /* retried on the next round */ }
  }
}

const pngMem = new Lru(60);

export async function radarImage(id) {
  if (!/^\d{8}T\d{4}$/.test(id)) throw new Error('Ugyldigt radarbillede');
  const hit = pngMem.get(id);
  if (hit) return hit;
  return once(`radar:${id}`, async () => {
    const key = `radar/${id}.png`;
    let buf = await diskGet(key);
    if (!buf) {
      const url = `${BUCKET}/${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)}/OPERA/COMP/OPERA@${id}@0@DBZH.tiff`;
      const { src, win } = buildMapping();
      let raster;
      for (let attempt = 0; ; attempt++) {
        try {
          const tiff = await fromUrl(url, { allowFullFile: false });
          const img = await tiff.getImage(0);
          [raster] = await img.readRasters({ window: win });
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      const ww = win[2] - win[0];
      // One palette index per pixel (index 0 = transparent): a paletted PNG is roughly
      // ten times smaller than RGBA and much cheaper to encode.
      const indices = new Uint8Array(OUT_W * OUT_H);
      for (let p = 0; p < OUT_W * OUT_H; p++) {
        const c = src[p * 2] - win[0], r = src[p * 2 + 1] - win[1];
        const z = raster[r * ww + c];
        if (!(z > 4) || z > 100) continue;
        const k = Math.min(255, Math.max(0, Math.round((z + 10) * 3)));
        indices[p] = LUT[k * 4 + 3] ? k : 0;
      }
      buf = encodePalettePng(OUT_W, OUT_H, indices);
      await diskPut(key, buf);
    }
    pngMem.set(id, buf);
    return buf;
  });
}

export const RADAR_LEGEND = STOPS.map(s => ({ dbz: s[0], color: `rgba(${s[1]},${s[2]},${s[3]},${(s[4] / 255).toFixed(2)})` }));
