// Minimal GRIB edition 1 decoder (simple packing, optional bitmap) for DMI WAM files.

const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const s24 = (b, o) => { const v = u24(b, o); return v & 0x800000 ? -(v & 0x7fffff) : v; };
const s16 = (b, o) => { const v = b.readUInt16BE(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const ibm = (b, o) => {
  const s = b[o] & 0x80 ? -1 : 1, e = (b[o] & 0x7f) - 64, m = u24(b, o + 1);
  return s * (m / 16777216) * Math.pow(16, e);
};

export function decodeMessages(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length && buf.toString('latin1', off, off + 4) === 'GRIB') {
    const total = u24(buf, off + 4);
    out.push(decodeOne(buf.subarray(off, off + total)));
    off += total;
  }
  return out;
}

function decodeOne(b) {
  let p = 8;
  const pdsLen = u24(b, p);
  const flags = b[p + 7];
  const param = b[p + 8];
  const D = s16(b, p + 26);
  p += pdsLen;
  const g = {};
  if (flags & 0x80) {
    const len = u24(b, p);
    g.nx = b.readUInt16BE(p + 6); g.ny = b.readUInt16BE(p + 8);
    g.la1 = s24(b, p + 10) / 1000; g.lo1 = s24(b, p + 13) / 1000;
    g.la2 = s24(b, p + 17) / 1000; g.lo2 = s24(b, p + 20) / 1000;
    g.scan = b[p + 27];
    p += len;
  }
  let bitmap = null;
  if (flags & 0x40) {
    const len = u24(b, p);
    bitmap = b.subarray(p + 6, p + len);
    p += len;
  }
  const bdsFlags = b[p + 3];
  const E = s16(b, p + 4);
  const R = ibm(b, p + 6);
  const bits = b[p + 10];
  const data = b.subarray(p + 11);
  const n = g.nx * g.ny;
  const values = new Float32Array(n);
  const bscale = Math.pow(2, E), dscale = Math.pow(10, -D);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (bitmap && !((bitmap[i >> 3] >> (7 - (i & 7))) & 1)) { values[i] = NaN; continue; }
    let x = 0;
    const bit = k * bits;
    for (let t = 0; t < bits; t++) {
      const bb = bit + t;
      x = x * 2 + ((data[bb >> 3] >> (7 - (bb & 7))) & 1);
    }
    values[i] = (R + x * bscale) * dscale;
    k++;
  }
  void bdsFlags;
  return { param, grid: g, values };
}
