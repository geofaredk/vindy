import fs from 'node:fs/promises';
import path from 'node:path';

export const CACHE_DIR = path.resolve(process.env.CACHE_DIR || '.cache');

// LRU cache limited by entry count and, for Buffers, total bytes.
export class Lru {
  constructor(max, maxBytes = Infinity) { this.max = max; this.maxBytes = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) {
    this.delete(k);
    this.map.set(k, v);
    this.bytes += v?.length ?? 0;
    while (this.map.size > 1 && (this.map.size > this.max || this.bytes > this.maxBytes)) this.delete(this.map.keys().next().value);
  }
  delete(k) {
    const v = this.map.get(k);
    if (v === undefined) return;
    this.bytes -= v?.length ?? 0;
    this.map.delete(k);
  }
}

// Deduplicate concurrent async work by key.
const inflight = new Map();
export function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

export async function diskGet(name) {
  try { return await fs.readFile(path.join(CACHE_DIR, name)); } catch { return null; }
}
export async function diskPut(name, buf) {
  const f = path.join(CACHE_DIR, name);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f + '.tmp', buf);
  await fs.rename(f + '.tmp', f);
}

export async function getJson(url, { tries = 3, timeout = 60000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

// Inverse of encodeField: { header, bands: [{ name, grid, data: Float32Array }] }.
export function decodeField(buf) {
  const hlen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.toString('utf8', 4, 4 + hlen));
  let off = 4 + hlen;
  const bands = header.bands.map(b => {
    const raw = new Int16Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + b.n * 2));
    off += b.n * 2;
    const data = new Float32Array(b.n);
    for (let i = 0; i < b.n; i++) data[i] = raw[i] === -32768 ? NaN : raw[i] * b.scale + b.offset;
    return { name: b.name, grid: b.grid, data };
  });
  return { header, bands };
}

// Encode float bands as Int16 with a JSON header. Layout:
// [uint32 LE header length][header JSON (padded to 4 bytes)][Int16 LE band 0][band 1]...
export function encodeField(header, bands) {
  const encBands = [];
  const metas = [];
  for (const { name, data, scale, grid } of bands) {
    let min = Infinity, max = -Infinity;
    for (const v of data) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    if (min === Infinity) { min = 0; max = 0; }
    const s = scale ?? Math.max((max - min) / 65000, 1e-6);
    const offset = (max + min) / 2;
    const arr = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      arr[i] = Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round((v - offset) / s))) : -32768;
    }
    encBands.push(arr);
    metas.push({ name, grid, n: data.length, scale: s, offset, min, max });
  }
  let json = Buffer.from(JSON.stringify({ ...header, bands: metas }));
  const pad = (4 - (json.length % 4)) % 4;
  json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(json.length);
  return Buffer.concat([len, json, ...encBands.map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength))]);
}
