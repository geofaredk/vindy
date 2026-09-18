import './net.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as dmi from './dmi.js';
import { radarFrames, radarImage, warmRadar, RADAR_LEGEND } from './radar.js';
import { inBackground, trackRequest } from './net.js';
import { geocode } from './geocode.js';
import { satelliteFrames } from './satellite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const STATIC = [
  ['/vendor/leaflet/', path.join(ROOT, 'node_modules/leaflet/dist/')],
  ['/', path.join(ROOT, 'public/')],
];

// Cached payloads (fields, isobars, fronts, static files) are the same Buffer objects on
// every request, so compress each one only once.
const gzipped = new WeakMap();
function gzipOnce(body) {
  let gz = gzipped.get(body);
  if (!gz) { gz = zlib.gzipSync(body, { level: 6 }); gzipped.set(body, gz); }
  return gz;
}

function send(req, res, status, body, type, extra = {}) {
  const headers = { 'Content-Type': type, Vary: 'Accept-Encoding', ...extra };
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (accepts && body.length > 1024 && !type.startsWith('image/png')) {
    body = gzipOnce(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}
const json = (req, res, obj, maxAge = 0) => send(req, res, 200, Buffer.from(JSON.stringify(obj)), 'application/json', { 'Cache-Control': `max-age=${maxAge}` });

// Static files: kept in memory and revalidated by mtime, served with an ETag so browsers
// get a 304 instead of downloading unchanged scripts, styles and coastline tiles again.
const staticCache = new Map();
async function readStatic(file) {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error('not a file');
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const hit = staticCache.get(file);
  if (hit && hit.etag === etag) return hit;
  const entry = { body: await fs.readFile(file), etag };
  staticCache.set(file, entry);
  return entry;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p.startsWith('/api/')) trackRequest(res);
  try {
    if (p === '/api/meta') return json(req, res, { ...dmi.meta(), radarLegend: RADAR_LEGEND });
    if (p === '/api/field') {
      const layer = url.searchParams.get('layer'), time = url.searchParams.get('time');
      const buf = await dmi.getField(layer, time);
      dmi.warmAround(layer, time);
      return send(req, res, 200, buf, 'application/octet-stream', { 'Cache-Control': 'max-age=3600' });
    }
    if (p === '/api/point') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw Object.assign(new Error('lat/lon mangler'), { status: 400 });
      return json(req, res, await dmi.pointForecast(lat, lon), 600);
    }
    if (p === '/api/isobars') {
      const buf = await dmi.getIsobars(url.searchParams.get('time'));
      return send(req, res, 200, buf, 'application/json', { 'Cache-Control': 'max-age=600' });
    }
    if (p === '/api/fronts') {
      const buf = await dmi.getFronts(url.searchParams.get('time'));
      return send(req, res, 200, buf, 'application/json', { 'Cache-Control': 'max-age=600' });
    }
    if (p === '/api/geocode') return json(req, res, await geocode(url.searchParams.get('q')), 3600);
    if (p === '/api/obs') return json(req, res, await dmi.observations(), 60);
    if (p === '/api/radar/frames') return json(req, res, await radarFrames());
    if (p === '/api/satellite/frames') return json(req, res, await satelliteFrames());
    if (p === '/api/radar/image') {
      const buf = await radarImage(url.searchParams.get('id') || '');
      return send(req, res, 200, buf, 'image/png', { 'Cache-Control': 'max-age=86400' });
    }
    if (p.startsWith('/api/')) throw Object.assign(new Error('Ikke fundet'), { status: 404 });
    for (const [prefix, dir] of STATIC) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length) || 'index.html';
      const file = path.join(dir, path.normalize(rel));
      if (!file.startsWith(dir)) break;
      try {
        const { body, etag } = await readStatic(file);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
        return send(req, res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache', ETag: etag });
      } catch { /* try next */ }
    }
    if (p === '/kolofon' || p === '/imprint') {
      const { body, etag } = await readStatic(path.join(ROOT, 'public/kolofon.html'));
      return send(req, res, 200, body, TYPES['.html'], { 'Cache-Control': 'no-cache', ETag: etag });
    }
    // App routes such as /overview/56.10,11.00,7 or /radar are handled in the browser:
    // anything that isn't a known asset type gets the app page.
    if (req.method === 'GET' && !TYPES[path.extname(p)]) {
      const { body, etag } = await readStatic(path.join(ROOT, 'public/index.html'));
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      return send(req, res, 200, body, TYPES['.html'], { 'Cache-Control': 'no-cache', ETag: etag });
    }
    throw Object.assign(new Error('Ikke fundet'), { status: 404 });
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) console.error(req.url, e.message);
    send(req, res, status, Buffer.from(JSON.stringify({ error: e.message })), 'application/json');
  }
}

http.createServer(handle).listen(PORT, () => console.log(`Vindy running at http://localhost:${PORT}`));

// Exit promptly on `docker stop` (SIGTERM) and Ctrl+C.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { console.log(`${signal} received, shutting down`); process.exit(0); });

// Serve the model runs that were active before a restart right away; newer runs are
// prepared in the background by the timer and only switched to once they are complete.
await dmi.restore();
dmi.refresh();
setInterval(() => dmi.refresh(), 10 * 60e3);

// Keep the latest radar frames rendered ahead of time.
const radarLoop = () => inBackground(() => warmRadar()).catch(e => console.log('radar warm failed:', e.message));
radarLoop();
setInterval(radarLoop, 60e3);
