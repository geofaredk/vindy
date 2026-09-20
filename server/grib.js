import { dispatcher } from './net.js';
// Minimal GRIB2 reader for DMI open data files, using HTTP range requests.
// Supports grid templates 3.0 (regular lat/lon) and 3.30 (Lambert conformal)
// with data representation template 5.0 (simple packing), no bitmap or bitmap 0.

const HEAD_BYTES = 1400;

export async function fetchRange(url, start, end, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, dispatcher: dispatcher() });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} for range ${start}-${end}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return res.status === 200 ? buf.subarray(start, end + 1) : buf;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// GRIB2 signed integers use sign-and-magnitude.
const sInt32 = (b, o) => { const v = b.readUInt32BE(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const sInt16 = (b, o) => { const v = b.readUInt16BE(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const sInt8 = (b, o) => { const v = b[o]; return v & 0x80 ? -(v & 0x7f) : v; };

// Parse sections 0..6 (and the header of 7) from the head of a message.
export function parseHead(buf, offset) {
  if (buf.toString('latin1', 0, 4) !== 'GRIB') throw new Error(`No GRIB marker at ${offset}`);
  const msg = { offset, discipline: buf[6], totalLength: Number(buf.readBigUInt64BE(8)) };
  let p = 16;
  while (p + 5 <= buf.length) {
    const len = buf.readUInt32BE(p), num = buf[p + 4];
    if (buf.toString('latin1', p, p + 4) === '7777') break;
    const s = buf.subarray(p, Math.min(p + len, buf.length));
    if (num === 1) {
      msg.refTime = new Date(Date.UTC(s.readUInt16BE(12), s[14] - 1, s[15], s[16], s[17], s[18]));
    } else if (num === 3) {
      const tpl = s.readUInt16BE(12);
      const g = (msg.grid = { template: tpl });
      if (tpl === 30) {
        g.nx = s.readUInt32BE(30); g.ny = s.readUInt32BE(34);
        g.la1 = sInt32(s, 38) / 1e6; g.lo1 = sInt32(s, 42) / 1e6;
        g.resFlags = s[46];
        g.lad = sInt32(s, 47) / 1e6; g.lov = sInt32(s, 51) / 1e6;
        g.dx = s.readUInt32BE(55) / 1000; g.dy = s.readUInt32BE(59) / 1000;
        g.scan = s[64];
        g.latin1 = sInt32(s, 65) / 1e6; g.latin2 = sInt32(s, 69) / 1e6;
        g.radius = s[14] === 6 ? 6371229 : s[14] === 1 ? s.readUInt32BE(16) * Math.pow(10, -s[15]) : 6371229;
      } else if (tpl === 0) {
        g.nx = s.readUInt32BE(30); g.ny = s.readUInt32BE(34);
        g.la1 = sInt32(s, 46) / 1e6; g.lo1 = sInt32(s, 50) / 1e6;
        g.resFlags = s[54];
        g.la2 = sInt32(s, 55) / 1e6; g.lo2 = sInt32(s, 59) / 1e6;
        g.dlon = s.readUInt32BE(63) / 1e6; g.dlat = s.readUInt32BE(67) / 1e6;
        g.scan = s[71];
      }
    } else if (num === 4) {
      msg.pdt = s.readUInt16BE(7);
      msg.category = s[9]; msg.number = s[10];
      msg.forecastTime = sInt32(s, 18);
      msg.surface = s[22];
      const scale = sInt8(s, 23), val = sInt32(s, 24);
      msg.level = s[22] === 255 ? 0 : val * Math.pow(10, -scale);
      if (msg.pdt === 8 && s.length > 58) msg.statProc = s[46];
    } else if (num === 5) {
      msg.npoints = s.readUInt32BE(5);
      msg.drt = s.readUInt16BE(9);
      msg.R = s.readFloatBE(11);
      msg.E = sInt16(s, 15);
      msg.D = sInt16(s, 17);
      msg.bits = s[19];
    } else if (num === 6) {
      msg.bitmap = s[5];
    } else if (num === 7) {
      msg.dataOffset = offset + p + 5;
      break;
    }
    p += len;
  }
  return msg;
}

export async function readHead(url, offset) {
  const buf = await fetchRange(url, offset, offset + HEAD_BYTES - 1);
  return parseHead(buf, offset);
}

// Walk the whole file message by message. If a template index (from another file
// with the same layout) is given, verify its offsets in parallel instead.
export async function indexFile(url, template) {
  if (template) {
    try {
      const heads = await pool(template.map(t => () => readHead(url, t.offset)), 12);
      const ok = heads.every((h, i) => h.totalLength === template[i].totalLength && h.category === template[i].category && h.number === template[i].number && h.surface === template[i].surface && h.level === template[i].level);
      if (ok) {
        const last = heads[heads.length - 1];
        const tail = await fetchRange(url, last.offset + last.totalLength, last.offset + last.totalLength + 3).catch(() => null);
        if (!tail || tail.length < 4 || tail.toString('latin1', 0, 4) !== 'GRIB') return heads;
      }
    } catch { /* fall through to full scan */ }
  }
  const out = [];
  let off = 0;
  for (;;) {
    let h;
    try { h = await readHead(url, off); } catch (e) { if (out.length) break; throw e; }
    out.push(h);
    off += h.totalLength;
  }
  return out;
}

// Decode a row window [j0, j1] x [i0, i1] (grid index space, as stored) into Float32Array.
export async function readWindow(url, msg, i0, i1, j0, j1) {
  if (msg.drt !== 0) throw new Error(`Unsupported data template ${msg.drt}`);
  if (msg.bitmap !== 255) throw new Error('Bitmap not supported');
  const { nx } = msg.grid, bits = msg.bits;
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  const out = new Float32Array(w * h);
  const ref = msg.R, bscale = Math.pow(2, msg.E), dscale = Math.pow(10, -msg.D);
  if (bits === 0) { out.fill(ref * dscale); return out; }
  const startBit = j0 * nx * bits;
  const endBit = (j1 + 1) * nx * bits;
  const b0 = Math.floor(startBit / 8), b1 = Math.ceil(endBit / 8);
  const buf = await fetchRange(url, msg.dataOffset + b0, msg.dataOffset + b1);
  const baseBit = b0 * 8;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const bit = ((j0 + j) * nx + (i0 + i)) * bits - baseBit;
      let x;
      if (bits % 8 === 0 && bit % 8 === 0) {
        const o = bit / 8;
        x = bits === 16 ? buf.readUInt16BE(o) : bits === 8 ? buf[o] : bits === 24 ? buf.readUIntBE(o, 3) : buf.readUInt32BE(o);
      } else {
        x = 0;
        for (let k = 0; k < bits; k++) {
          const bb = bit + k;
          x = x * 2 + ((buf[bb >> 3] >> (7 - (bb & 7))) & 1);
        }
      }
      out[j * w + i] = (ref + x * bscale) * dscale;
    }
  }
  return out;
}

export async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

// Read [i0,i1]x[j0,j1] and block-average it by `block` cells in each direction.
// Rows are fetched in parallel chunks. Returns { data, w, h }.
export async function readBlockAverage(url, msg, i0, i1, j0, j1, block) {
  const w = Math.floor((i1 - i0 + 1) / block), h = Math.floor((j1 - j0 + 1) / block);
  const out = new Float32Array(w * h);
  const rowsPerChunk = block * 24;
  const chunks = [];
  for (let b = 0; b < h; b += 24) chunks.push(b);
  await pool(chunks.map(b0 => async () => {
    const b1 = Math.min(h, b0 + 24);
    const ja = j0 + b0 * block, jb = j0 + b1 * block - 1;
    const win = await readWindow(url, msg, i0, i0 + w * block - 1, ja, jb);
    const ww = w * block;
    for (let bj = b0; bj < b1; bj++) {
      for (let bi = 0; bi < w; bi++) {
        let s = 0;
        for (let dj = 0; dj < block; dj++) {
          const row = ((bj - b0) * block + dj) * ww;
          for (let di = 0; di < block; di++) s += win[row + bi * block + di];
        }
        out[bj * w + bi] = s / (block * block);
      }
    }
    void rowsPerChunk;
  }), 8);
  return { data: out, w, h };
}
