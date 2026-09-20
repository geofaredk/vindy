import { LAYERS, icon, colorFor } from './layers.js';
import { CoastLayer } from './coast-layer.js';
import { decodeField, decodeFieldRaw, valueAt } from './field.js';
import { WeatherLayer } from './weather-layer.js';
import { renderForecast, renderForecastLoading, setRainProb } from './forecast.js';
import { PLACES, searchPlaces } from './places.js';
import { SatelliteView } from './satellite.js';
import { captureMap, composeExport, canvasToPng } from './export.js';
import { mp4Codec, createMp4Encoder, createGifEncoder } from './animation.js';

const L = window.L;
// Bump when the /api/field or overlay payload format changes (defeats stale HTTP caches).
const DATA_VERSION = 3;
const TZ = 'Europe/Copenhagen';
const $ = s => document.querySelector(s);
const fmtDate = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtWeekday = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, weekday: 'short' });
const fmtDayNum = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, day: 'numeric' });

const fmtHourOnly = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const fmtHM = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// "ons. 16. sep. kl. 14.00" and "ons. 16."
const fmtStamp = { format: d => `${fmtDate.format(d)} kl. ${fmtHM.format(d)}` };
const fmtDayShort = { format: d => `${fmtWeekday.format(d)} ${fmtDayNum.format(d)}` };

const state = {
  meta: null,
  layer: 'overview',
  time: null,
  radarFrames: [],
  satFrames: [],
  obsIndex: 0, // position on the timeline of an observed layer (radar/satellite)
  range: null, // { start, end } ISO times for accumulated layers
  playing: false,
  particles: true,
  stations: true,
  values: true,
  grid: false,
  isobars: false,
  fronts: false,
  legend: false,
  point: null,
};
const SETTINGS = ['particles', 'stations', 'values', 'grid', 'isobars', 'fronts', 'legend'];
try {
  // Settings were stored under the app's former name; read those once as a fallback.
  const saved = JSON.parse(localStorage.getItem('vindy.settings') || localStorage.getItem('vindue.settings') || '{}');
  for (const k of SETTINGS) if (typeof saved[k] === 'boolean') state[k] = saved[k];
} catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem('vindy.settings', JSON.stringify(Object.fromEntries(SETTINGS.map(k => [k, state[k]])))); } catch { /* ignore */ } };

// ---------------------------------------------------------------------------
// Map

// Default view; phones get a view centred on Jutland/Funen that fits a portrait screen.
const DEFAULT_VIEW = window.innerWidth < 700 ? [[55.93, 9.46], 7] : [[56.1, 11.0], 7];
const map = L.map('map', { zoomControl: false, minZoom: 5, maxZoom: 12, worldCopyJump: false, attributionControl: false })
  .setView(...DEFAULT_VIEW);
L.control.zoom({ position: 'bottomright', zoomInTitle: 'Zoom ind', zoomOutTitle: 'Zoom ud' }).addTo(map);
// Download button (bottom corners stack upwards, so this sits above the zoom buttons).
const DownloadControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const b = L.DomUtil.create('button', 'square-btn map-download');
    b.type = 'button';
    b.title = 'Download kortet som billede';
    b.setAttribute('aria-label', 'Download kortet som billede');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, 'click', () => openExport());
    return b;
  },
});
new DownloadControl().addTo(map);

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  crossOrigin: 'anonymous', // CORS-enabled so the map can be exported as an image
  maxZoom: 16, attribution: 'Baggrundskort © Esri, HERE, Garmin, © OpenStreetMap-bidragydere',
}).addTo(map);
map.createPane('labels');
map.getPane('labels').style.zIndex = 450;
map.getPane('labels').style.pointerEvents = 'none';
L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { pane: 'labels', maxZoom: 16, crossOrigin: 'anonymous' }).addTo(map);

const weather = new WeatherLayer(map);

// Coastlines and borders drawn above the weather data (dark, with a shadow on the water
// side). Overview zooms use a simplified GSHHG shoreline; from zoom 8 the full-resolution
// one is loaded in 1° tiles for the visible area (both built with tools/build_coast_tiles.py).
map.createPane('coast');
map.getPane('coast').style.zIndex = 440;
map.getPane('coast').style.pointerEvents = 'none';
const coast = new CoastLayer({ pane: 'coast' }).addTo(map);
const HIRES_ZOOM = 8;
const TILED = { west: -6, east: 28, south: 48, north: 65 };
const coastTiles = new Map(); // "x_y" -> Promise<data|null>
let coastOverview = null;
let coastIndex = null;
let adminLoaded = false;
const ADMIN_ZOOM = 7; // Danish region and municipality borders

fetch('/data/coast.json').then(r => r.json()).then(data => { coastOverview = data; updateCoast(); }).catch(() => {});
fetch('/data/coast/index.json').then(r => r.json()).then(list => { coastIndex = new Set(list); updateCoast(); }).catch(() => {});

function loadCoastTile(key) {
  if (!coastTiles.has(key)) coastTiles.set(key, fetch(`/data/coast/${key}.json`).then(r => r.json()).catch(() => null));
  return coastTiles.get(key);
}

function updateCoast() {
  // Danish region/municipality borders; fetched the first time the map is zoomed in enough.
  if (map.getZoom() >= ADMIN_ZOOM && !adminLoaded) {
    adminLoaded = true;
    fetch('/data/admin.json').then(r => r.json()).then(data => coast.setData('admin', data)).catch(() => { adminLoaded = false; });
  }
  const high = map.getZoom() >= HIRES_ZOOM && coastIndex;
  const b = map.getBounds().pad(0.3);
  const wanted = new Set();
  if (high) {
    for (let x = Math.floor(b.getWest()); x <= Math.floor(b.getEast()); x++) {
      for (let y = Math.floor(b.getSouth()); y <= Math.floor(b.getNorth()); y++) {
        if (coastIndex.has(`${x}_${y}`)) wanted.add(`tile:${x}_${y}`);
      }
    }
  }
  // Areas outside the tiled region keep the overview lines.
  const covered = high && b.getWest() >= TILED.west && b.getEast() <= TILED.east && b.getSouth() >= TILED.south && b.getNorth() <= TILED.north;
  if (!covered && coastOverview) wanted.add('overview');
  wanted.add('admin');
  for (const id of [...coast.sets.keys()]) if (!wanted.has(id)) coast.removeData(id);
  if (wanted.has('overview') && !coast.hasData('overview')) coast.setData('overview', coastOverview);
  for (const id of wanted) {
    if (id === 'overview' || coast.hasData(id)) continue;
    const [x, y] = id.slice(5).split('_').map(Number);
    loadCoastTile(id.slice(5)).then(data => {
      // Skip tiles the view has already left while loading.
      if (data && map.getZoom() >= HIRES_ZOOM && map.getBounds().pad(0.3).intersects([[y, x], [y + 1, x + 1]])) coast.setData(id, data);
    });
  }
}
map.on('zoomend moveend', updateCoast);

map.createPane('radar');
map.getPane('radar').style.zIndex = 360;
map.createPane('satellite');
map.getPane('satellite').style.zIndex = 340;
const satellite = new SatelliteView(map, { pane: 'satellite' });
// Observed layers use their own image frames on the timeline instead of forecast hours.
const isObserved = layer => !!LAYERS[layer]?.observed;
const isRange = layer => !!LAYERS[layer]?.range;
const obsFrames = () => (state.layer === 'satellite' ? state.satFrames : state.radarFrames);
let radarOverlay = null;
const stationLayer = L.layerGroup().addTo(map);
let pointMarker = null;

// ---------------------------------------------------------------------------
// Data loading

// Waves arrive as height + direction; add the propagation vector used by the wave-crest
// animation (direction the waves travel, scaled by height).
function withWaveVectors(field) {
  if (field.layer !== 'waves') return field;
  for (const part of field.parts) {
    const { v: h, dir } = part.bands;
    const n = h.length, pu = new Float32Array(n), pv = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(h[k])) { pu[k] = NaN; pv[k] = NaN; continue; }
      const a = dir[k] * Math.PI / 180, s = 1.5 + h[k] * 3;
      pu[k] = -Math.sin(a) * s; pv[k] = -Math.cos(a) * s;
    }
    part.bands.pu = pu; part.bands.pv = pv;
  }
  return field;
}

const fieldCache = new Map();
const fieldReady = (layer, time) => fieldCache.get(`${layer}|${time}`)?.ready === true;
async function loadField(layer, time) {
  const key = `${layer}|${time}`;
  if (!fieldCache.has(key)) {
    const p = fetch(`/api/field?layer=${layer}&time=${encodeURIComponent(time)}&v=${DATA_VERSION}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.arrayBuffer(); })
      .then(buf => withWaveVectors(decodeField(buf)));
    p.then(() => { p.ready = true; }, () => {});
    fieldCache.set(key, p);
    p.catch(() => fieldCache.delete(key));
    if (fieldCache.size > 40) fieldCache.delete(fieldCache.keys().next().value);
  }
  return fieldCache.get(key);
}

let loadSeq = 0;
let current = { scalar: null, vector: null, layer: null };

async function update() {
  const seq = ++loadSeq;
  const def = LAYERS[state.layer];
  renderLegend();
  renderTimelineLabel();
  updateUrl();

  if (isObserved(state.layer)) {
    weather.setField(null, null);
    setOverviewRain(null);
    if (state.layer === 'radar') satellite.hide(); else hideRadar();
    showObservedFrame();
    // Keep wind particles from the nearest forecast hour on top of the observation.
    const t = nearestForecastTime(obsFrames()[state.obsIndex]?.time || new Date().toISOString());
    if (t) loadField('windp', t).then(f => { if (seq === loadSeq) { current.vector = f; weather.setVectorField(f); } }).catch(() => {});
    current.scalar = null;
    weather.setGrid(null);
    renderStations();
    updateOverlays(t);
    return;
  }
  satellite.hide();
  if (def.radar) overviewPrecip(state.time); else { hideRadar(); setOverviewRain(null); }
  setBusy(true);
  try {
    if (def.range) state.time = rangeTimes()[1];
    const time = state.time;
    const scalarP = def.range ? loadAccumulation(...rangeTimes()) : loadField(dataLayer(state.layer), time);
    if (!rangeDrag) updateOverlays(time);
    // Particles on non-wind layers use the light 'windp' field (4 km, 0.1 m/s).
    const vectorLayer = def.vector ? state.layer : state.layer === 'waves' ? 'waves' : 'windp';
    const vectorP = vectorLayer === state.layer ? scalarP : loadField(vectorLayer, time);
    const scalar = await scalarP;
    if (seq !== loadSeq) return;
    const display = def.vector ? withSpeed(scalar) : scalar;
    current.scalar = display;
    current.layer = state.layer;
    weather.setField(display, def);
    if (rangeDrag) { setBusy(false); return; } // dragging: labels, grid and wind follow on release
    weather.setGrid(state.grid ? { field: display, def, vector: def.vector ? ['u', 'vv'] : state.layer === 'waves' ? ['pu', 'pv'] : null } : null);
    renderStations();
    const vector = await vectorP;
    if (seq !== loadSeq) return;
    current.vector = vector;
    weather.setVectorField(vector, vectorLayer === 'waves' ? ['pu', 'pv'] : ['u', 'v'], vectorLayer === 'waves' ? 'waves' : 'wind');
    $('#error').hidden = true;
    prefetch();
  } catch (e) {
    if (seq !== loadSeq) return;
    showError(`Kunne ikke hente ${def.name.toLowerCase()} for denne time: ${e.message}`);
  } finally {
    if (seq === loadSeq) setBusy(false);
  }
}

// Isobars and fronts are independent overlays that follow the forecast hour. Both are
// precomputed on the server; the browser fetches small JSON files and prefetches all
// hours once so scrubbing the timeline only redraws.
let overlaySeq = 0;
function updateOverlays(time) {
  const seq = ++overlaySeq;
  if (!time) return;
  for (const kind of ['isobars', 'fronts']) {
    if (!state[kind]) { kind === 'isobars' ? weather.setIsobars(null) : weather.setFronts(null); continue; }
    const cached = overlayCache.get(`${kind}|${time}`);
    const apply = d => {
      if (seq !== overlaySeq || !state[kind]) return;
      if (kind === 'isobars') weather.setIsobars(d); else weather.setFronts(d.fronts);
    };
    if (cached?.value) apply(cached.value);
    else loadOverlay(kind, time).then(apply).catch(e => showError(`${kind === 'isobars' ? 'Isobarer' : 'Fronter'} er ikke tilgængelige: ${e.message}`));
    prefetchOverlay(kind);
  }
}

const overlayCache = new Map();
function loadOverlay(kind, time) {
  const key = `${kind}|${time}`;
  let entry = overlayCache.get(key);
  if (!entry) {
    entry = {};
    entry.promise = fetch(`/api/${kind}?time=${encodeURIComponent(time)}&v=${DATA_VERSION}`).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      entry.value = d;
      return d;
    });
    entry.promise.catch(() => overlayCache.delete(key));
    overlayCache.set(key, entry);
  }
  return entry.promise;
}

const prefetched = new Set();
async function prefetchOverlay(kind) {
  const run = state.meta?.dini?.run;
  if (!run || prefetched.has(`${kind}|${run}`)) return;
  prefetched.add(`${kind}|${run}`);
  const cur = Date.parse(state.time || new Date().toISOString());
  const queue = [...state.meta.dini.times].sort((a, b) => Math.abs(Date.parse(a) - cur) - Math.abs(Date.parse(b) - cur));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length && state[kind]) await loadOverlay(kind, queue.shift()).catch(() => {});
  }));
}

// The server layer behind a UI layer (combined views reuse an existing field).
const dataLayer = layer => LAYERS[layer]?.base || layer;

function withSpeed(field) {
  if (!field.speed) {
    field.speed = {
      ...field,
      parts: field.parts.map(p => {
        const { u, v } = p.bands;
        const sp = new Float32Array(u.length);
        for (let i = 0; i < u.length; i++) sp[i] = Math.hypot(u[i], v[i]);
        return { ...p, bands: { v: sp, u, vv: v } };
      }),
    };
  }
  return field.speed;
}

// Accumulated precipitation between two forecast hours = tp(end) - tp(start).
// Every hour of the run is kept as compact Int16 data (about 0.8 MB each) so any
// range can be computed without waiting for the network.
const tpCache = new Map(); // time -> Promise<raw field>
function loadTp(time) {
  if (!tpCache.has(time)) {
    const p = fetch(`/api/field?layer=tpacc&time=${encodeURIComponent(time)}&v=${DATA_VERSION}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.arrayBuffer(); })
      .then(decodeFieldRaw);
    tpCache.set(time, p);
    p.catch(() => tpCache.delete(time));
  }
  return tpCache.get(time);
}

const accCache = new Map();
function loadAccumulation(startT, endT) {
  const key = `${startT}|${endT}`;
  if (!accCache.has(key)) {
    const p = Promise.all([loadTp(startT), loadTp(endT)]).then(([a, b]) => ({
      ...b,
      parts: b.parts.map((part, k) => {
        const A = a.parts[k].bands.v, B = part.bands.v;
        const ad = A.data, bd = B.data, n = bd.length, out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          if (ad[i] === -32768 || bd[i] === -32768) { out[i] = NaN; continue; }
          const x = (bd[i] * B.scale + B.offset) - (ad[i] * A.scale + A.offset);
          out[i] = x > 0 ? x : 0;
        }
        return { key: part.key, grid: part.grid, projector: part.projector, bands: { v: out } };
      }),
    }));
    accCache.set(key, p);
    p.catch(() => accCache.delete(key));
    if (accCache.size > 6) accCache.delete(accCache.keys().next().value);
  }
  return accCache.get(key);
}

// Load every hour's accumulation in the background (nearest to the current range first).
const tpPrefetched = new Set();
function prefetchAllTp() {
  const run = state.meta?.dini?.run;
  if (!run || tpPrefetched.has(run)) return;
  tpPrefetched.add(run);
  const [s, e] = rangeIdx();
  const times = state.meta.dini.times;
  const queue = times.map((t, i) => [t, Math.min(Math.abs(i - s), Math.abs(i - e))]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
  Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length && isRange(state.layer)) await loadTp(queue.shift()).catch(() => {});
  })).then(() => { if (queue.length) tpPrefetched.delete(run); });
}

// Range as [startIndex, endIndex] into the forecast hours (created on demand).
function rangeIdx() {
  const times = state.meta?.dini?.times || [];
  const n = times.length;
  const nearest = iso => { let best = 0, bd = Infinity; times.forEach((t, i) => { const d = Math.abs(Date.parse(t) - Date.parse(iso)); if (d < bd) { bd = d; best = i; } }); return best; };
  if (!state.range) {
    let s = nearest(state.time || new Date().toISOString());
    let e = Math.min(n - 1, s + 24);
    if (e - s < 24) s = Math.max(0, e - 24);
    state.range = { start: times[s], end: times[e] };
  }
  let s = nearest(state.range.start), e = nearest(state.range.end);
  if (e <= s) e = Math.min(n - 1, s + 1);
  if (e <= s) s = Math.max(0, e - 1);
  return [s, e];
}
function rangeTimes() { const [s, e] = rangeIdx(); const t = state.meta.dini.times; return [t[s], t[e]]; }

function setRange(s, e) {
  const times = state.meta.dini.times;
  const n = times.length;
  s = Math.max(0, Math.min(n - 2, s));
  e = Math.max(s + 1, Math.min(n - 1, e));
  const [cs, ce] = rangeIdx();
  if (s === cs && e === ce) return;
  state.range = { start: times[s], end: times[e] };
  state.time = times[e];
  queueUpdate();
}

// Coalesce rapid range changes (dragging) into one update per turn of the event loop.
let updateQueued = false;
function queueUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  setTimeout(() => { updateQueued = false; update(); }, 0);
}

function prefetch() {
  const times = state.meta.dini.times;
  if (isRange(state.layer)) { prefetchAllTp(); return; }
  const i = times.indexOf(state.time);
  for (const k of [1, 2]) {
    const t = times[i + k];
    if (!t) continue;
    loadField(dataLayer(state.layer), t).catch(() => {});
    if (!LAYERS[state.layer].vector && state.layer !== 'waves') loadField('windp', t).catch(() => {});
    if (LAYERS[state.layer].radar && Date.parse(t) > Date.now()) loadField('rain', t).catch(() => {});
  }
}

function nearestForecastTime(iso) {
  const times = state.meta?.dini?.times || [];
  let best = null, bd = Infinity;
  for (const t of times) { const d = Math.abs(Date.parse(t) - Date.parse(iso)); if (d < bd) { bd = d; best = t; } }
  return best;
}

// ---------------------------------------------------------------------------
// Radar

async function loadRadarFrames() {
  const r = await fetch('/api/radar/frames').then(r => r.json());
  const firstBefore = state.radarFrames[0]?.time;
  state.radarFrames = r.frames;
  state.radarFramesAt = Date.now();
  state.radarBounds = r.bounds;
  // The radar history moves on; Oversigt's timeline starts with it.
  if (LAYERS[state.layer].radar && r.frames[0]?.time !== firstBefore) clampToTimeline();
  if (state.layer === 'radar' && (state.obsIndex >= r.frames.length || !state.playing)) state.obsIndex = r.frames.length - 1;
}

async function loadSatFrames() {
  const r = await fetch('/api/satellite/frames').then(async res => { const d = await res.json(); if (!res.ok) throw new Error(d.error || res.statusText); return d; });
  state.satFrames = r.frames;
  satellite.setMeta(r);
  if (state.layer === 'satellite' && (state.obsIndex >= r.frames.length || !state.playing)) state.obsIndex = r.frames.length - 1;
}

const loadObsFrames = layer => (layer === 'satellite' ? loadSatFrames() : loadRadarFrames().then(preloadRadar));

function showObservedFrame() {
  if (state.layer === 'satellite') {
    const frame = state.satFrames[state.obsIndex];
    if (frame) satellite.show(frame.time);
    renderTimelineLabel();
  } else showRadarFrame();
}

const radarImgs = new Map();
function radarUrl(frame) { return `/api/radar/image?id=${frame.id}`; }
function preloadRadar() {
  for (const f of state.radarFrames) {
    if (radarImgs.has(f.id)) continue;
    const img = new Image();
    img.src = radarUrl(f);
    radarImgs.set(f.id, img);
  }
}

function showRadarFrame() {
  const frame = state.radarFrames[state.obsIndex];
  if (!frame) return;
  const b = state.radarBounds;
  const url = radarUrl(frame);
  if (!radarOverlay) {
    radarOverlay = L.imageOverlay(url, [[b.south, b.west], [b.north, b.east]], { pane: 'radar', opacity: 0.9, className: 'radar-img' }).addTo(map);
  } else {
    radarOverlay.setUrl(url);
    if (!map.hasLayer(radarOverlay)) radarOverlay.addTo(map);
  }
  renderTimelineLabel();
}
function hideRadar() { if (radarOverlay && map.hasLayer(radarOverlay)) map.removeLayer(radarOverlay); }

// Combined view: show the radar frame closest to the selected forecast hour, but only
// when one exists within 35 minutes (radar is observed, so there is none for the future).
let overviewRadar = null;
async function showRadarForTime(time) {
  const age = Date.now() - (state.radarFramesAt || 0);
  if (!state.radarFrames.length || age > 60e3) {
    // Only the frame for the selected hour is shown here, so don't preload them all.
    await loadRadarFrames().catch(() => {});
  }
  if (!LAYERS[state.layer].radar || state.time !== time) return;
  let best = null, bd = Infinity;
  for (const f of state.radarFrames) { const d = Math.abs(Date.parse(f.time) - Date.parse(time)); if (d < bd) { bd = d; best = f; } }
  overviewRadar = best && bd <= 35 * 60e3 ? best : null;
  if (overviewRadar) {
    const b = state.radarBounds;
    const url = radarUrl(overviewRadar);
    if (!radarOverlay) radarOverlay = L.imageOverlay(url, [[b.south, b.west], [b.north, b.east]], { pane: 'radar', opacity: 0.9, className: 'radar-img' }).addTo(map);
    else { radarOverlay.setUrl(url); if (!map.hasLayer(radarOverlay)) radarOverlay.addTo(map); }
  } else hideRadar();
  renderTimelineLabel();
}

// Keep the selected hour inside the timeline (Oversigt's starts with the radar history).
function clampToTimeline() {
  const times = timelineDomain();
  if (times.length && Date.parse(state.time) < Date.parse(times[0])) { state.time = times[0]; update(); }
  renderTimeline();
}

// Oversigt: observed radar where a frame exists (up to now), forecast rain after that.
let overviewRain = null;
async function overviewPrecip(time) {
  await showRadarForTime(time);
  if (!LAYERS[state.layer].radar || state.time !== time) return;
  // Forecast rain only continues the radar forward in time; hours before the radar
  // history get no precipitation at all.
  const lastRadar = state.radarFrames.length ? Date.parse(state.radarFrames[state.radarFrames.length - 1].time) : Date.now();
  const afterRadar = Date.parse(time) > lastRadar;
  const rain = overviewRadar || !afterRadar ? null : await loadField('rain', time).catch(() => null);
  if (!LAYERS[state.layer].radar || state.time !== time) return;
  setOverviewRain(rain);
}
function setOverviewRain(field) {
  const changed = !!field !== !!overviewRain;
  overviewRain = field;
  weather.setOverlay(field ? { field, def: LAYERS.rain, opacity: 0.9 } : null);
  if (changed) renderLegend();
  renderTimelineLabel();
}

// ---------------------------------------------------------------------------
// Stations

let obsData = null;
async function loadStations() {
  try {
    obsData = await fetch('/api/obs').then(r => r.json());
    renderStations();
  } catch { /* observations are optional */ }
}

function stationLabel(s) {
  const o = s.obs;
  const layer = state.layer;
  if (['wind', 'gust', 'waves'].includes(layer) && o.wind_speed != null) {
    const val = layer === 'gust' ? o.wind_max ?? o.wind_speed : o.wind_speed;
    return `<span class="st-arrow" style="transform:rotate(${(o.wind_dir ?? 0) + 180}deg)">↑</span>${val.toFixed(0)}`;
  }
  if (layer === 'rainacc') return null;
  if (layer === 'rain' || layer === 'radar') return o.precip_past1h > 0 ? `${o.precip_past1h.toFixed(1)}<small>mm</small>` : null;
  if (layer === 'pressure') return o.pressure_at_sea != null ? `${Math.round(o.pressure_at_sea)}` : null;
  if (layer === 'humidity') return o.humidity != null ? `${Math.round(o.humidity)}%` : null;
  if (layer === 'dewpoint') return o.temp_dew != null ? `${o.temp_dew.toFixed(0)}°` : null;
  if (layer === 'visibility') return o.visibility != null ? `${(o.visibility / 1000).toFixed(0)}<small>km</small>` : null;
  if (layer === 'clouds' || layer === 'lowclouds') return o.cloud_cover != null ? `${Math.round(o.cloud_cover)}%` : null;
  return o.temp_dry != null ? `${o.temp_dry.toFixed(0)}°` : null;
}

function renderStations() {
  stationLayer.clearLayers();
  // Greedy declutter in screen space: synoptic stations first, then the other
  // stations, then forecast values at towns.
  const placed = [];
  const free = p => !placed.some(q => Math.abs(q.x - p.x) < 46 && Math.abs(q.y - p.y) < 24);
  if (state.stations && obsData) {
    const ordered = [...obsData.stations].sort((a, b) => (a.type === 'Synop' ? 0 : 1) - (b.type === 'Synop' ? 0 : 1));
    for (const s of ordered) {
      const label = stationLabel(s);
      if (label == null) continue;
      const p = map.latLngToLayerPoint([s.lat, s.lon]);
      if (!free(p)) continue;
      placed.push(p);
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: 'st-icon', html: `<div class="st-label" title="${s.name} · observeret">${label}</div>`, iconSize: null }),
        keyboard: false,
      });
      m.bindPopup(() => stationPopup(s), { className: 'dark-popup', maxWidth: 260 });
      m.addTo(stationLayer);
    }
  }
  if (state.values && current.scalar && current.layer === state.layer) {
    const def = LAYERS[current.layer];
    const vf = current.scalar;
    for (const [name, lat, lon] of PLACES) {
      const v = valueAt(vf, lat, lon);
      if (!Number.isFinite(v)) continue;
      const p = map.latLngToLayerPoint([lat, lon]).add([0, 17]); // the bubble sits below the town
      if (!free(p)) continue;
      placed.push(p);
      let html = `${v.toFixed(Math.abs(v) >= 100 || def.digits === 0 ? 0 : def.unit === '°C' ? 0 : 1)}${def.unit === '°C' ? '°' : ''}`;
      if (def.vector) {
        const u = valueAt(vf, lat, lon, 'u'), vv = valueAt(vf, lat, lon, 'vv');
        const dir = (Math.atan2(-u, -vv) * 180 / Math.PI + 360) % 360;
        html = `<span class="st-arrow" style="transform:rotate(${dir + 180}deg)">↑</span>${v.toFixed(0)}`;
      } else if (current.layer === 'waves') {
        const d = valueAt(vf, lat, lon, 'dir');
        html = `<span class="st-arrow" style="transform:rotate(${d + 180}deg)">↑</span>${v.toFixed(1)}`;
      }
      const m = L.marker([lat, lon], {
        icon: L.divIcon({ className: 'st-icon', html: `<div class="fv-label" style="--sw:${colorFor(def, v)}" title="${name} · prognose for ${def.name.toLowerCase()}">${html}</div>`, iconSize: null }),
        keyboard: false,
      });
      m.on('click', () => openPoint(lat, lon));
      m.addTo(stationLayer);
    }
  }
}

function stationPopup(s) {
  const o = s.obs;
  const row = (k, v) => v == null ? '' : `<tr><th>${k}</th><td>${v}</td></tr>`;
  return `<div class="st-pop"><div class="st-name">${s.name}</div><div class="st-meta">DMI-station ${s.id} · observeret kl. ${fmtHM.format(new Date(s.time))}</div>
  <table>
    ${row('Temperatur', o.temp_dry != null ? `${o.temp_dry.toFixed(1)} °C` : null)}
    ${row('Dugpunkt', o.temp_dew != null ? `${o.temp_dew.toFixed(1)} °C` : null)}
    ${row('Vind', o.wind_speed != null ? `${o.wind_speed.toFixed(1)} m/s ${o.wind_dir != null ? compass(o.wind_dir) : ''}` : null)}
    ${row('Maks. vindstød (10 min)', o.wind_max != null ? `${o.wind_max.toFixed(1)} m/s` : null)}
    ${row('Regn seneste time', o.precip_past1h != null ? `${o.precip_past1h.toFixed(1)} mm` : null)}
    ${row('Luftfugtighed', o.humidity != null ? `${Math.round(o.humidity)} %` : null)}
    ${row('Lufttryk (havniveau)', o.pressure_at_sea != null ? `${o.pressure_at_sea.toFixed(1)} hPa` : null)}
    ${row('Sigtbarhed', o.visibility != null ? `${(o.visibility / 1000).toFixed(1)} km` : null)}
    ${row('Skydække', o.cloud_cover != null ? `${Math.round(o.cloud_cover)} %` : null)}
  </table>
  <button class="st-fc" data-lat="${s.lat}" data-lon="${s.lon}">Prognose her →</button></div>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('.st-fc');
  if (b) { map.closePopup(); openPoint(Number(b.dataset.lat), Number(b.dataset.lon)); }
});

const compass = d => ['N', 'NNØ', 'NØ', 'ØNØ', 'Ø', 'ØSØ', 'SØ', 'SSØ', 'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV'][Math.round(d / 22.5) % 16];

// ---------------------------------------------------------------------------
// Point forecast

async function openPoint(lat, lon, name) {
  state.point = { lat, lon, name };
  if (pointMarker) pointMarker.remove();
  pointMarker = L.marker([lat, lon], { icon: L.divIcon({ className: 'pin', html: '<div class="pin-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
  const panel = $('#forecast');
  panel.hidden = false;
  document.body.classList.add('has-forecast');
  renderForecastLoading(panel, lat, lon, null, name).onclick = closePoint;
  try {
    const r = await fetch(`/api/point?lat=${lat}&lon=${lon}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    if (state.point?.lat !== lat || state.point?.lon !== lon) return;
    renderForecast(panel, { ...data, name }, {
      onClose: closePoint,
      currentTime: state.time,
      onSelectTime: t => { if (isObserved(state.layer)) selectLayer('overview'); setTime(t); },
    });
    // The ensemble is read a grid cell at a time and takes a moment longer, so the rain
    // probability fills its row in once the meteogram is already on screen.
    fetch(`/api/pointprob?lat=${lat}&lon=${lon}`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null)
      // Without the ensemble the row stays empty; the rest of the meteogram is unaffected.
      .then(prob => { if (state.point?.lat === lat && state.point?.lon === lon) setRainProb(panel, prob?.rows || []); });
  } catch (e) {
    if (state.point?.lat === lat) renderForecastLoading(panel, lat, lon, e.message, name).onclick = closePoint;
  }
}

function closePoint() {
  state.point = null;
  $('#forecast').hidden = true;
  document.body.classList.remove('has-forecast');
  if (pointMarker) { pointMarker.remove(); pointMarker = null; }
}

map.on('click', e => openPoint(Number(e.latlng.lat.toFixed(3)), Number(e.latlng.lng.toFixed(3))));

// ---------------------------------------------------------------------------
// Hover readout

const readout = $('#readout');
map.on('mousemove', e => {
  const def = LAYERS[state.layer];
  let text = null;
  if (!isObserved(state.layer) && current.scalar) {
    const v = valueAt(current.scalar, e.latlng.lat, e.latlng.lng);
    if (Number.isFinite(v)) {
      text = `${v.toFixed(def.digits)} ${def.unit}`;
      if (def.vector) {
        const u = valueAt(current.scalar, e.latlng.lat, e.latlng.lng, 'u'), vv = valueAt(current.scalar, e.latlng.lat, e.latlng.lng, 'vv');
        const dir = (Math.atan2(-u, -vv) * 180 / Math.PI + 360) % 360;
        text += ` <span class="ro-dir">${compass(dir)}</span>`;
      }
      if (state.layer === 'waves') {
        const d = valueAt(current.scalar, e.latlng.lat, e.latlng.lng, 'dir');
        if (Number.isFinite(d)) text += ` <span class="ro-dir">fra ${compass(d)}</span>`;
      }
      readout.style.setProperty('--sw', colorFor(def, v));
    }
  }
  if (!text) { readout.hidden = true; return; }
  readout.innerHTML = text;
  readout.hidden = false;
  readout.style.transform = `translate(${e.containerPoint.x + 14}px, ${e.containerPoint.y - 30}px)`;
});
map.on('mouseout', () => { readout.hidden = true; });

// ---------------------------------------------------------------------------
// UI: layer menu

const TOGGLES = [
  ['particles', 'Partikler'], ['stations', 'Observeret (DMI-stationer)'], ['values', 'Prognose i byer'],
  ['grid', 'Værdigitter'], ['isobars', 'Isobarer'], ['fronts', 'Vejrfronter'], ['legend', 'Signaturforklaring'], ['hideui', 'Skjul brugerflade'],
];

function renderMenu() {
  const def = LAYERS[state.layer];
  $('#menu-current').innerHTML = `${icon(def.icon, 16)}<span>${def.name}</span>`;
  const groups = [['combined', 'Kombineret'], ['forecast', 'DMI prognose'], ['observed', 'Observeret']];
  $('#menu-layers').innerHTML = groups.map(([g, title]) => `
    <div class="menu-group"><div class="menu-title">${title}</div>
    ${Object.entries(LAYERS).filter(([, d]) => d.group === g).map(([k, d]) => `
      <button class="menu-item${k === state.layer ? ' active' : ''}" data-layer="${k}">${icon(d.icon)}<span>${d.name}</span></button>`).join('')}
    </div>`).join('');
  $('#menu-toggles').innerHTML = TOGGLES.map(([k, n]) => `
    <button class="toggle${state[k] ? ' on' : ''}" data-toggle="${k}" aria-pressed="${state[k]}">${icon(k)}<span>${n}</span><i></i></button>`).join('');
}

$('#menu').addEventListener('click', e => {
  const item = e.target.closest('[data-layer]');
  if (item) { selectLayer(item.dataset.layer); if (window.innerWidth < 700) setMenuOpen(false); return; }
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const k = t.dataset.toggle;
    if (k === 'hideui') { setUiHidden(true); return; }
    state[k] = !state[k];
    saveSettings();
    if (k === 'particles') weather.showParticles = state.particles;
    if (k === 'stations' || k === 'values') renderStations();
    if (k === 'grid' || k === 'isobars' || k === 'fronts') update();
    if (k === 'legend') { renderLegend(); renderTimelineLabel(); }
    renderMenu();
  }
});

function setMenuOpen(open, persist = true) {
  document.body.classList.toggle('menu-open', open);
  $('#menu-tab').setAttribute('aria-expanded', String(open));
  if (persist) try { localStorage.setItem('vindy.menuOpen', open ? '1' : '0'); } catch { /* ignore */ }
}
$('#menu-tab').onclick = () => setMenuOpen(true);

// Hide every control so only the map is visible; Esc (or the restore button on
// touch screens) brings the interface back.
let hintTimer = null;
function setUiHidden(hidden) {
  state.hideui = hidden;
  document.body.classList.toggle('ui-hidden', hidden);
  map.closePopup();
  $('#ui-hint').hidden = !hidden;
  clearTimeout(hintTimer);
  if (hidden) hintTimer = setTimeout(() => { $('#ui-hint').hidden = true; }, 3000);
  renderMenu();
}
$('#ui-restore').onclick = () => setUiHidden(false);
$('#menu-close').onclick = () => setMenuOpen(false);

// ---------------------------------------------------------------------------
// Info dialog

function openInfo() {
  const fmtRun = iso => iso ? `${fmtDate.format(new Date(iso))} kl. ${fmtHM.format(new Date(iso))}` : '–';
  const m = state.meta || {};
  const lastRadar = state.radarFrames[state.radarFrames.length - 1];
  const rows = [
    ['HARMONIE-modelkørsel', fmtRun(m.dini?.run)],
    ['Prognose til', fmtRun(m.dini?.times?.[m.dini.times.length - 1])],
    ['WAM-bølgemodel', fmtRun(m.wam?.run)],
    ['Stationsdata', obsData ? `opdateret kl. ${fmtHM.format(new Date(obsData.updated))} (${obsData.stations.length} stationer)` : '–'],
    ['Seneste radarbillede', lastRadar ? `kl. ${fmtHM.format(new Date(lastRadar.time))}` : 'hentes når radarlaget vælges'],
    ['Seneste satellitbillede', state.satFrames.length ? `kl. ${fmtHM.format(new Date(state.satFrames[state.satFrames.length - 1].time))}` : 'hentes når satellitlaget vælges'],
  ];
  $('#info-status').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#info').hidden = false;
  $('#info-close').focus();
}
function closeInfo() { $('#info').hidden = true; $('#info-btn').focus(); }
$('#info-btn').onclick = openInfo;
$('#info-close').onclick = closeInfo;
$('#info').addEventListener('click', e => { if (e.target.id === 'info') closeInfo(); });

async function selectLayer(layer) {
  if (!LAYERS[layer]) return;
  const wasObserved = isObserved(state.layer);
  state.layer = layer;
  stopPlay();
  if (isObserved(layer)) {
    await loadObsFrames(layer).catch(e => showError(`${LAYERS[layer].name} er ikke tilgængelig: ${e.message}`));
    state.obsIndex = obsFrames().length - 1;
  } else if (wasObserved && !state.time) {
    state.time = nearestForecastTime(new Date().toISOString());
  }
  if (LAYERS[layer].radar) {
    // Oversigt starts with the radar history: move an earlier hour up to its start.
    if (!state.radarFrames.length) await loadRadarFrames().catch(() => {});
    const times = timelineDomain();
    if (times.length && Date.parse(state.time) < Date.parse(times[0])) state.time = times[0];
  }
  renderMenu();
  renderTimeline();
  renderStations();
  update();
}

// ---------------------------------------------------------------------------
// Legend

// ---------------------------------------------------------------------------
// Export

// kind: 'image' (PNG of the current view) or 'video' (MP4/GIF over a period).
const exportState = { kind: 'image', logo: true, meta: true, time: true, mapCanvas: null, still: null, info: null, anim: null, rendering: false, abort: false };
try { Object.assign(exportState, JSON.parse(localStorage.getItem('vindy.export') || '{}')); } catch { /* ignore */ }
const saveExportPrefs = () => { try { localStorage.setItem('vindy.export', JSON.stringify({ kind: exportState.kind, logo: exportState.logo, meta: exportState.meta, time: exportState.time })); } catch { /* ignore */ } };
// Logo, metadata line and the floating time (always in animations); the sources are always drawn.
const composeFor = (mapCanvas, info, video, scale) => composeExport(mapCanvas, info, { logo: exportState.logo, meta: exportState.meta, time: video || exportState.time }, scale);

function legendSpec(def) {
  const stops = def.scale;
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  const tf = def.log ? v => Math.log1p(Math.max(0, v)) : v => v;
  const pos = v => (tf(v) - tf(lo)) / (tf(hi) - tf(lo));
  return {
    unit: def.unit,
    stops: stops.map(([v, c]) => [pos(v), `rgba(${c[0]},${c[1]},${c[2]},${c[3] != null ? Math.max(0.35, c[3] / 255) : 1})`]),
    ticks: def.ticks.filter(t => t >= lo && t <= hi).map(t => [pos(t), String(t)]),
  };
}

function exportInfo() {
  const def = LAYERS[state.layer];
  const stamp = iso => `${fmtDate.format(new Date(iso))} kl. ${fmtHM.format(new Date(iso))}`;
  const lines = [];
  const sources = new Set();
  let validIso;
  const usesForecast = state.isobars || state.fronts || state.values || state.grid || state.particles;
  if (isObserved(state.layer)) {
    const frame = obsFrames()[state.obsIndex];
    validIso = frame?.time;
    lines.push(['Observeret', frame ? stamp(frame.time) : '–']);
    sources.add(state.layer === 'radar' ? 'EUMETNET OPERA radarkomposit (CC BY 4.0)' : 'EUMETSAT MTG-I FCI via EUMETView');
    if (usesForecast && state.meta?.dini) {
      lines.push(['Overlag fra modelkørsel', `${stamp(state.meta.dini.run)} (DMI HARMONIE DINI)`]);
      sources.add('DMI HARMONIE DINI');
    }
  } else {
    validIso = state.time;
    if (def.range) {
      const [a, b] = rangeTimes();
      lines.push(['Periode', `${stamp(a)} – ${stamp(b)} (${Math.round((Date.parse(b) - Date.parse(a)) / 3600e3)} t)`]);
    } else lines.push(['Gyldig', stamp(state.time)]);
    if (state.layer === 'waves') {
      lines.push(['Modelkørsel', `${stamp(state.meta.wam.run)} (DMI WAM)`]);
      sources.add('DMI WAM');
      if (usesForecast) sources.add('DMI HARMONIE DINI');
    } else {
      lines.push(['Modelkørsel', `${stamp(state.meta.dini.run)} (DMI HARMONIE DINI)`]);
      sources.add('DMI HARMONIE DINI');
    }
    if (def.radar) {
      lines.push(['Nedbør', overviewRadar ? `radar kl. ${fmtHM.format(new Date(overviewRadar.time))}` : overviewRain ? 'regnprognose (DMI HARMONIE DINI)' : 'ingen for dette tidspunkt']);
      if (overviewRadar) sources.add('EUMETNET OPERA radarkomposit (CC BY 4.0)');
    }
  }
  if (state.stations) sources.add('DMI målestationer');
  if (state.fronts) sources.add('vejrfronter beregnet af Vindy');
  const legend = def.noLegend ? [] : [legendSpec(def), ...(def.radar ? [legendSpec(overviewRain ? LAYERS.rain : LAYERS.radar)] : [])];
  const sourceText = `Kort lavet af vindy.dk · Kilder: ${[...sources].join(', ')} · Baggrundskort © Esri, HERE, Garmin, © OpenStreetMap-bidragydere · Kystlinjer: GSHHG · Tider i dansk tid`;
  const d = validIso ? new Date(validIso) : new Date();
  const p = n => String(n).padStart(2, '0');
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const fileStamp = `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}_${p(local.getHours())}${p(local.getMinutes())}`;
  return {
    title: 'Vindy',
    subtitle: def.name,
    timeLabel: lines[0]?.[1],
    lines,
    legend,
    sources: sourceText,
    filename: `vindy_${state.layer}_${fileStamp}`,
    text: {
      Title: `Vindy – ${def.name}`,
      Description: lines.map(([k, v]) => `${k}: ${v}`).join('; '),
      Source: [...sources].join(', '),
      Copyright: 'Vejrdata © DMI; radar © EUMETNET OPERA (CC BY 4.0); satellit © EUMETSAT; baggrundskort © Esri, HERE, Garmin, © OpenStreetMap-bidragydere',
      Software: 'Vindy',
      'Creation Time': new Date().toISOString(),
    },
  };
}

async function openExport() {
  map.closePopup();
  stopPlay();
  $('#export').hidden = false;
  clearAnimation();
  exportState.mapCanvas = exportState.still = null;
  $('#export-img').removeAttribute('src');
  fillAnimationOptions();
  renderExportPreview();
  setExportStatus('Laver billede…');
  await new Promise(r => setTimeout(r, 30)); // let the dialog paint before the heavy work
  try {
    exportState.mapCanvas = captureMap(map);
    exportState.info = exportInfo();
  } catch (e) {
    setExportStatus(`Billedet kunne ikke laves: ${e.message}`);
  }
  renderExportPreview();
  $('#export-close').focus();
}

const setExportStatus = text => { $('#export-status').textContent = text; };

function renderExportPreview() {
  const { kind, anim, rendering } = exportState;
  const mark = (sel, key, value) => document.querySelectorAll(`#export [${sel}]`).forEach(b => {
    const on = b.dataset[key] === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  mark('data-kind', 'kind', kind);
  $('#exp-logo').checked = exportState.logo;
  $('#exp-meta').checked = exportState.meta;
  $('#exp-time').checked = exportState.time;
  const video = kind === 'video';
  $('#exp-time-switch').hidden = video; // animations always show the time
  $('#export-note').textContent = video
    ? 'Tidspunktet vises altid øverst til højre på kortet, og kilderne altid nederst.'
    : 'Kilderne vises altid nederst på billedet.';
  $('#anim-options').hidden = !video;
  $('#anim-render').hidden = !video;
  $('#anim-render').textContent = rendering ? 'Stop' : 'Forhåndsvis animation';
  document.querySelectorAll('#anim-options select, #export [data-kind], #export .switch input').forEach(el => { el.disabled = rendering; });
  const img = $('#export-img'), vid = $('#export-video');
  // Preview of the current view with the chosen extras (as the first animation frame for video).
  const still = exportState.mapCanvas && exportState.info ? composeFor(exportState.mapCanvas, exportState.info, video) : null;
  exportState.still = video ? null : still;

  if (video && anim) {
    const isMp4 = anim.format === 'mp4';
    vid.hidden = !isMp4;
    img.hidden = isMp4;
    if (isMp4) { if (vid.src !== anim.url) vid.src = anim.url; vid.play().catch(() => {}); } else img.src = anim.url;
    const mb = (anim.blob.size / 1e6).toFixed(1).replace('.', ',');
    setExportStatus(`${anim.width} × ${anim.height} px · ${anim.steps} ${anim.unit} · ${anim.seconds} sek. · ${mb} MB · ${isMp4 ? 'MP4' : 'GIF'}`);
    $('#export-download-label').textContent = `Download ${isMp4 ? 'MP4' : 'GIF'}`;
    $('#export-download').disabled = false;
    return;
  }
  vid.hidden = true;
  vid.removeAttribute('src');
  img.hidden = false;
  if (still) img.src = still.toDataURL('image/png');
  if (video) {
    $('#export-download-label').textContent = `Download ${$('#anim-format').value === 'mp4' ? 'MP4' : 'GIF'}`;
    // Download works without a preview first: it makes the animation and then saves it.
    $('#export-download').disabled = rendering;
    if (!rendering) setExportStatus(animationPlan());
  } else {
    $('#export-download-label').textContent = 'Download PNG';
    $('#export-download').disabled = !still;
    if (still) setExportStatus(`${still.width} × ${still.height} px · PNG`);
  }
}

function closeExport() {
  $('#export').hidden = true;
  if (exportState.rendering) exportState.abort = true;
  exportState.mapCanvas = exportState.still = null;
  clearAnimation();
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#export-close').onclick = closeExport;
$('#export').addEventListener('click', e => {
  if (e.target.id === 'export') return closeExport();
  if (exportState.rendering) return;
  const k = e.target.closest('[data-kind]');
  if (k) { exportState.kind = k.dataset.kind; saveExportPrefs(); renderExportPreview(); }
});
for (const [id, key] of [['#exp-logo', 'logo'], ['#exp-time', 'time'], ['#exp-meta', 'meta']]) {
  $(id).addEventListener('change', e => { exportState[key] = e.target.checked; saveExportPrefs(); clearAnimation(); renderExportPreview(); });
}
$('#anim-options').addEventListener('change', e => {
  if (e.target.id === 'anim-format') fillSizeOptions();
  clearAnimation();
  renderExportPreview();
});
$('#anim-render').onclick = () => {
  if (exportState.rendering) exportState.abort = true;
  else renderAnimation();
};
$('#export-download').onclick = async () => {
  const { still, info, kind, anim } = exportState;
  if (kind === 'video') {
    if (exportState.rendering) return;
    if (!anim) await renderAnimation();
    if (exportState.anim && !$('#export').hidden) saveBlob(exportState.anim.blob, exportState.anim.filename);
    return;
  }
  if (!still) return;
  saveBlob(await canvasToPng(still, info.text), `${info.filename}.png`);
};

// ---------------------------------------------------------------------------
// Animation export: step through a period on the real map, capture every frame exactly as
// the image export does, and encode the frames in the browser (MP4 via WebCodecs, or GIF).

const ANIM_FPS = 20;
const MP4_SIZES = [[1280, 'HD · 1280'], [1920, 'Full HD · 1920']];
const GIF_SIZES = [[640, 'Lille · 640'], [960, 'Mellem · 960']];

// The frames an animation can use: forecast hours (Oversigt from the radar history on),
// radar/satellite frames, or for accumulated rain the end of a window of fixed length.
function animationDomain() {
  if (isObserved(state.layer)) return obsFrames().map(f => f.time);
  if (isRange(state.layer)) { const [s, e] = rangeIdx(); return state.meta.dini.times.slice(e - s); }
  return timelineDomain();
}

function fillAnimationOptions() {
  const domain = animationDomain();
  const observed = isObserved(state.layer);
  const label = t => observed ? `kl. ${fmtHM.format(new Date(t))}` : `${fmtDayShort.format(new Date(t))} kl. ${fmtHM.format(new Date(t))}`;
  const options = domain.map((t, i) => `<option value="${i}">${label(t)}</option>`).join('');
  $('#anim-from').innerHTML = options;
  $('#anim-to').innerHTML = options;
  let from = 0, to = domain.length - 1;
  if (!observed) {
    const cur = domain.indexOf(isRange(state.layer) ? rangeTimes()[1] : state.time);
    from = Math.max(0, cur);
    to = Math.min(domain.length - 1, from + 24);
  }
  $('#anim-from').value = String(from);
  $('#anim-to').value = String(to);
  const mp4 = $('#anim-format').querySelector('[value="mp4"]');
  mp4.disabled = typeof VideoEncoder === 'undefined';
  if (mp4.disabled) { mp4.textContent = 'MP4-video (ikke understøttet i denne browser)'; $('#anim-format').value = 'gif'; }
  fillSizeOptions();
}

function fillSizeOptions() {
  const sizes = $('#anim-format').value === 'mp4' ? MP4_SIZES : GIF_SIZES;
  $('#anim-size').innerHTML = sizes.map(([w, name]) => `<option value="${w}">${name}</option>`).join('');
}

function animationSettings() {
  let from = Number($('#anim-from').value), to = Number($('#anim-to').value);
  if (to < from) [from, to] = [to, from];
  const speed = Number($('#anim-speed').value);
  const steps = to - from + 1;
  return { from, to, steps, speed, format: $('#anim-format').value, maxWidth: Number($('#anim-size').value), seconds: Math.round(steps / speed + 1) };
}

function animationPlan() {
  const { steps, seconds } = animationSettings();
  const unit = isObserved(state.layer) ? 'billeder' : 'timer';
  return `${steps} ${unit} → ca. ${seconds} sek.`;
}

function clearAnimation() {
  if (exportState.anim) URL.revokeObjectURL(exportState.anim.url);
  exportState.anim = null;
}

// Next paint, with a timer fallback: hidden tabs pause requestAnimationFrame, and the
// recording should keep going (particles just don't move while the tab is hidden).
const nextFrame = () => new Promise(r => { requestAnimationFrame(() => r()); setTimeout(r, 80); });

// Wait until everything for the current step is drawn: overlays, radar/rain in Oversigt,
// and radar or satellite images.
async function settleMap() {
  const def = LAYERS[state.layer];
  const jobs = [];
  if (!isObserved(state.layer)) for (const k of ['isobars', 'fronts']) if (state[k]) jobs.push(loadOverlay(k, state.time).catch(() => {}));
  if (def.radar) jobs.push(overviewPrecip(state.time));
  if (state.layer === 'satellite') { const f = obsFrames()[state.obsIndex]; if (f) jobs.push(satellite.show(f.time)); }
  await Promise.all(jobs);
  const imgs = ['radar', 'satellite'].flatMap(p => [...map.getPane(p).querySelectorAll('img')]);
  await Promise.all(imgs.map(img => img.complete
    ? null
    : new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 10000); })));
  await nextFrame();
}

async function gotoAnimationStep(domain, i) {
  const t = domain[i];
  if (isObserved(state.layer)) {
    state.obsIndex = obsFrames().findIndex(f => f.time === t);
  } else if (isRange(state.layer)) {
    const [s, e] = rangeIdx();
    const times = state.meta.dini.times, j = times.indexOf(t);
    state.range = { start: times[j - (e - s)], end: t };
    state.time = t;
  } else {
    state.time = t;
  }
  await update();
  await settleMap();
}

async function renderAnimation() {
  const opts = animationSettings();
  const domain = animationDomain();
  const perStep = opts.format === 'mp4' ? Math.max(1, Math.round(ANIM_FPS / opts.speed)) : 1;
  const saved = { time: state.time, obsIndex: state.obsIndex, range: state.range && { ...state.range } };
  const scale = Math.min(2, opts.maxWidth / map.getSize().x);
  const progress = $('#export-progress');
  clearAnimation();
  Object.assign(exportState, { rendering: true, abort: false });
  renderExportPreview();
  progress.hidden = false;
  progress.value = 0;
  let enc = null, frame = null, fctx = null, filename = '', failure = '';
  try {
    for (let i = opts.from; i <= opts.to; i++) {
      if (exportState.abort) throw new Error('aborted');
      const n = i - opts.from + 1;
      setExportStatus(`Tegner ${n} af ${opts.steps}…`);
      await gotoAnimationStep(domain, i);
      const info = exportInfo();
      if (!filename) filename = `${info.filename}_animation.${opts.format}`;
      for (let k = 0; k < perStep; k++) {
        await nextFrame(); // wind and wave particles move between the frames of one step
        const cap = captureMap(map, scale);
        const src = composeFor(cap, info, true, scale);
        if (!enc) {
          // Video sizes must be even; every later frame is drawn into this same canvas.
          frame = document.createElement('canvas');
          frame.width = src.width & ~1;
          frame.height = src.height & ~1;
          fctx = frame.getContext('2d', { willReadFrequently: opts.format === 'gif' });
          if (opts.format === 'mp4') {
            const codec = await mp4Codec(frame.width, frame.height, ANIM_FPS);
            if (!codec) throw new Error('din browser kan ikke lave MP4-video i denne størrelse – vælg GIF eller en mindre størrelse');
            enc = await createMp4Encoder({ width: frame.width, height: frame.height, fps: ANIM_FPS, codec });
          } else {
            enc = await createGifEncoder({ width: frame.width, height: frame.height });
          }
        }
        fctx.fillStyle = '#10141d';
        fctx.fillRect(0, 0, frame.width, frame.height);
        fctx.drawImage(src, 0, 0);
        await enc.addFrame(frame, Math.round(1000 / opts.speed));
      }
      progress.value = n / opts.steps;
    }
    // Hold the last frame for a second so the loop doesn't jump straight back.
    if (opts.format === 'mp4') for (let k = 0; k < ANIM_FPS; k++) await enc.addFrame(frame);
    else await enc.addFrame(frame, 1000);
    setExportStatus(opts.format === 'mp4' ? 'Koder video…' : 'Gemmer GIF…');
    const blob = await enc.finish();
    exportState.anim = {
      blob, url: URL.createObjectURL(blob), format: opts.format, filename,
      width: frame.width, height: frame.height, steps: opts.steps, seconds: opts.seconds,
      unit: isObserved(state.layer) ? 'billeder' : 'timer',
    };
  } catch (e) {
    enc?.cancel();
    failure = e.message === 'aborted' ? 'Animationen blev stoppet.' : `Animationen kunne ikke laves: ${e.message}`;
  } finally {
    // Put the map back where the user left it.
    Object.assign(state, saved);
    exportState.rendering = false;
    progress.hidden = true;
    await update();
    if (!$('#export').hidden) { renderExportPreview(); if (failure) setExportStatus(failure); }
  }
}

function legendRow(def) {
  const stops = def.scale;
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  const tf = def.log ? v => Math.log1p(Math.max(0, v)) : v => v;
  const pos = v => ((tf(v) - tf(lo)) / (tf(hi) - tf(lo))) * 100;
  const grad = stops.map(([v, c]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] != null ? Math.max(0.35, c[3] / 255) : 1}) ${pos(v).toFixed(1)}%`).join(',');
  return `<div class="lg-row"><span class="lg-unit">${def.unit}</span><div class="lg-bar" style="background:linear-gradient(90deg,${grad})">
    ${def.ticks.filter(t => t >= lo && t <= hi).map(t => `<span style="left:${pos(t)}%">${t}</span>`).join('')}</div></div>`;
}

function renderLegend() {
  const def = LAYERS[state.layer];
  const legend = $('#legend');
  const hide = !!def.noLegend || !state.legend;
  legend.hidden = hide;
  document.body.classList.toggle('no-legend', hide);
  legend.classList.toggle('multi', !!def.radar);
  legend.innerHTML = def.noLegend ? '' : legendRow(def) + (def.radar ? legendRow(overviewRain ? LAYERS.rain : LAYERS.radar) : '');
}

// ---------------------------------------------------------------------------
// Timeline

function timelineDomain() {
  if (isObserved(state.layer)) return obsFrames().map(f => f.time);
  const times = state.meta?.dini?.times || [];
  // Oversigt starts where the radar history starts (the first hour with a radar frame).
  if (LAYERS[state.layer].radar && state.radarFrames.length) {
    const first = Date.parse(state.radarFrames[0].time);
    const fromRadar = times.filter(t => Date.parse(t) + 35 * 60e3 >= first);
    if (fromRadar.length) return fromRadar;
  }
  return times;
}

function renderTimeline() {
  const times = timelineDomain();
  const track = $('#tl-track');
  if (!times.length) { track.innerHTML = ''; return; }
  const radar = isObserved(state.layer);
  const days = [];
  times.forEach((t, i) => {
    const d = fmtDayShort.format(new Date(t));
    if (!days.length || days[days.length - 1].label !== d) days.push({ label: d, start: i, n: 0 });
    days[days.length - 1].n++;
  });
  const n = times.length;
  const nowIdx = radar ? n - 1 : times.findIndex(t => Date.parse(t) > Date.now()) - 1;
  track.innerHTML = `
    <div class="tl-days">${days.map(d => `<div class="tl-day" style="left:${(d.start / n) * 100}%;width:${(d.n / n) * 100}%"><span>${radar ? `${LAYERS[state.layer].name} · seneste ${String(Math.round((Date.parse(times[n - 1]) - Date.parse(times[0])) / 360e3) / 10).replace('.', ',')} t` : d.label}</span></div>`).join('')}</div>
    <div class="tl-ticks">${times.map((t, i) => {
      const h = Number(fmtHourOnly.format(new Date(t)));
      const major = radar ? new Date(t).getUTCMinutes() === 0 : h % 6 === 0;
      return `<i class="${major ? 'major' : ''}" style="left:${((i + 0.5) / n) * 100}%">${major ? `<b>${radar ? fmtHM.format(new Date(t)) : String(h).padStart(2, '0')}</b>` : ''}</i>`;
    }).join('')}</div>
    ${nowIdx >= 0 && !radar ? `<div class="tl-now" style="left:${((nowIdx + 0.5 + (Date.now() - Date.parse(times[nowIdx])) / 3600e3) / n) * 100}%"></div>` : ''}
    ${isRange(state.layer)
      ? '<div class="tl-range"></div><div class="tl-handle tl-start"></div><div class="tl-handle tl-end"></div><span class="tl-bubble tl-range-bubble"></span>'
      : '<div class="tl-progress"></div><div class="tl-handle"><span class="tl-bubble"></span></div>'}`;
  renderTimelineLabel();
}

function currentIndex() {
  if (isRange(state.layer) && state.meta?.dini) return rangeIdx()[1];
  return isObserved(state.layer) ? state.obsIndex : Math.max(0, timelineDomain().indexOf(state.time));
}

function renderRangeLabel(times) {
  const [s, e] = rangeIdx();
  const n = times.length;
  const ps = ((s + 0.5) / n) * 100, pe = ((e + 0.5) / n) * 100;
  const band = $('.tl-range');
  if (!band) return;
  band.style.left = `${ps}%`;
  band.style.width = `${pe - ps}%`;
  $('.tl-start').style.left = `${ps}%`;
  $('.tl-end').style.left = `${pe}%`;
  const bubble = $('.tl-range-bubble');
  const short = iso => `${fmtDayShort.format(new Date(iso))} ${fmtHM.format(new Date(iso))}`;
  const hours = Math.round((Date.parse(times[e]) - Date.parse(times[s])) / 3600e3);
  bubble.textContent = `${short(times[s])} → ${short(times[e])} · ${hours} t`;
  const trackW = $('#tl-track').clientWidth, bw = bubble.offsetWidth;
  const x = Math.max(bw / 2, Math.min(trackW - bw / 2, trackW * (ps + pe) / 200));
  bubble.style.left = `${x}px`;
}

function renderTimelineLabel() {
  const times = timelineDomain();
  const i = currentIndex();
  const t = times[i];
  if (!t) return;
  if (isRange(state.layer) && state.meta?.dini) {
    renderRangeLabel(times);
    document.querySelectorAll('.fc-hour').forEach(h => h.classList.toggle('is-current', h.dataset.time === state.time));
    return;
  }
  const pct = ((i + 0.5) / times.length) * 100;
  const handle = $('.tl-handle'), prog = $('.tl-progress');
  if (handle) {
    handle.style.left = `${pct}%`;
    prog.style.width = `${pct}%`;
    const radar = isObserved(state.layer);
    const ago = Math.round((Date.now() - Date.parse(t)) / 60000);
    const bubble = handle.querySelector('.tl-bubble');
    bubble.textContent = radar ? `kl. ${fmtHM.format(new Date(t))} · for ${ago} min. siden`
      : fmtStamp.format(new Date(t)) + (LAYERS[state.layer].radar ? (overviewRadar ? ` · radar kl. ${fmtHM.format(new Date(overviewRadar.time))}` : overviewRain ? ' · regnprognose' : '') : '');
    const trackW = $('#tl-track').clientWidth, bw = bubble.offsetWidth, x = trackW * pct / 100;
    const shift = Math.max(bw / 2 - x, Math.min(0, trackW - x - bw / 2));
    bubble.style.transform = `translateX(calc(-50% + ${shift}px))`;
  }
  document.querySelectorAll('.fc-hour').forEach(h => h.classList.toggle('is-current', h.dataset.time === state.time));
}

function setTime(t) {
  if (isObserved(state.layer)) return;
  if (dragging && !isRange(state.layer)) {
    // While dragging, show hours that are already loaded at once; wait for the pointer
    // to rest briefly before requesting ones that still have to be fetched.
    if (t === state.time) return;
    state.time = t;
    renderTimelineLabel();
    clearTimeout(dragTimer);
    if (fieldReady(dataLayer(state.layer), t)) queueUpdate();
    else dragTimer = setTimeout(queueUpdate, 140);
    return;
  }
  if (isRange(state.layer)) {
    // Keep the duration and move the window so it ends at t.
    const [s, e] = rangeIdx();
    const i = state.meta.dini.times.indexOf(t);
    if (i >= 0) setRange(i - (e - s), i);
    return;
  }
  if (t === state.time) return;
  state.time = t;
  update();
}

function indexFromEvent(e) {
  const rect = $('#tl-track').getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const n = timelineDomain().length;
  return Math.max(0, Math.min(n - 1, Math.floor((x / rect.width) * n)));
}

function setIndex(i) {
  if (isObserved(state.layer)) {
    if (i === state.obsIndex) return;
    state.obsIndex = i;
    showObservedFrame();
  } else {
    setTime(timelineDomain()[i]);
  }
}

let dragging = false;
let dragTimer = null;
// Range layers: grab the start or end handle, or the band between them to move the
// whole window; clicking outside the band moves the nearest end there.
let rangeDrag = null;
$('#tl-track').addEventListener('pointerdown', e => {
  dragging = true; stopPlay();
  try { $('#tl-track').setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
  if (isRange(state.layer)) {
    const rect = $('#tl-track').getBoundingClientRect();
    const n = timelineDomain().length;
    const [s, en] = rangeIdx();
    const x = e.clientX - rect.left;
    const sx = ((s + 0.5) / n) * rect.width, ex = ((en + 0.5) / n) * rect.width;
    const idx = indexFromEvent(e);
    if (Math.abs(x - sx) <= 12 && Math.abs(x - sx) <= Math.abs(x - ex)) rangeDrag = { mode: 'start' };
    else if (Math.abs(x - ex) <= 12) rangeDrag = { mode: 'end' };
    else if (x > sx && x < ex) rangeDrag = { mode: 'move', grab: idx - s, duration: en - s };
    else if (x < sx) { rangeDrag = { mode: 'start' }; setRange(idx, en); }
    else { rangeDrag = { mode: 'end' }; setRange(s, idx); }
    return;
  }
  setIndex(indexFromEvent(e));
});
$('#tl-track').addEventListener('pointermove', e => {
  if (!dragging) return;
  if (isRange(state.layer) && rangeDrag) {
    const idx = indexFromEvent(e);
    const [s, en] = rangeIdx();
    if (rangeDrag.mode === 'start') setRange(Math.min(idx, en - 1), en);
    else if (rangeDrag.mode === 'end') setRange(s, Math.max(idx, s + 1));
    else {
      const n = timelineDomain().length;
      const ns = Math.max(0, Math.min(n - 1 - rangeDrag.duration, idx - rangeDrag.grab));
      setRange(ns, ns + rangeDrag.duration);
    }
    return;
  }
  setIndex(indexFromEvent(e));
});
$('#tl-track').addEventListener('pointerup', () => {
  dragging = false;
  if (rangeDrag) { rangeDrag = null; queueUpdate(); } // full update: labels, grid, wind, overlays
});

let playTimer = null;
function stopPlay() {
  state.playing = false;
  clearTimeout(playTimer);
  $('#play').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  $('#play').setAttribute('aria-label', 'Afspil');
}
function startPlay() {
  state.playing = true;
  $('#play').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
  $('#play').setAttribute('aria-label', 'Pause');
  const tick = async () => {
    if (!state.playing) return;
    const n = timelineDomain().length;
    const i = currentIndex();
    if (isRange(state.layer)) {
      const [s, en] = rangeIdx();
      const d = en - s;
      if (en >= n - 1) setRange(0, d); else setRange(s + 1, en + 1);
      await update.lastPromise;
      playTimer = setTimeout(tick, 600);
    } else if (isObserved(state.layer)) {
      const next = (i + 1) % n;
      setIndex(next);
      playTimer = setTimeout(tick, next === n - 1 ? 1400 : state.layer === 'satellite' ? 400 : 220);
    } else {
      setIndex((i + 1) % n);
      await update.lastPromise;
      playTimer = setTimeout(tick, 700);
    }
  };
  tick();
}
$('#play').onclick = () => (state.playing ? stopPlay() : startPlay());

document.addEventListener('keydown', e => {
  if (state.hideui) { if (e.key === 'Escape') { setUiHidden(false); e.preventDefault(); } return; }
  if (!$('#export').hidden) { if (e.key === 'Escape') closeExport(); return; }
  if (!$('#info').hidden) { if (e.key === 'Escape') closeInfo(); return; }
  if (e.target.closest?.('input')) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    stopPlay();
    const n = timelineDomain().length;
    const step = e.key === 'ArrowRight' ? 1 : -1;
    if (isRange(state.layer)) {
      const [s, en] = rangeIdx();
      if (s + step >= 0 && en + step <= n - 1) setRange(s + step, en + step);
    } else setIndex(Math.max(0, Math.min(n - 1, currentIndex() + step)));
    e.preventDefault();
  } else if (e.key === ' ') { state.playing ? stopPlay() : startPlay(); e.preventDefault(); }
  else if (e.key === 'Escape') closePoint();
});

// ---------------------------------------------------------------------------
// Search

const search = $('#search');
const results = $('#search-results');
let searchTimer = null, searchSeq = 0, activeResult = -1, lastResults = [];

function renderResults(items, loading) {
  lastResults = items;
  activeResult = items.length ? 0 : -1;
  results.hidden = !items.length && !loading;
  results.innerHTML = items.map((r, i) => `
    <button data-i="${i}" class="${i === activeResult ? 'active' : ''}">
      <span class="sr-ico">${r.kind === 'address' ? '⌂' : r.kind === 'town' ? '●' : '◆'}</span>
      <span class="sr-text"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.detail || '')}</small></span>
    </button>`).join('') + (loading ? '<div class="sr-loading"><span class="spinner"></span> Søger…</div>' : '');
}

search.addEventListener('input', () => {
  const q = search.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { renderResults([]); return; }
  const local = searchPlaces(q).map(([name, lat, lon]) => ({ name, lat, lon, detail: 'Danmark', kind: 'town' }));
  renderResults(local, true);
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const remote = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then(r => r.json());
      if (seq !== searchSeq) return;
      const merged = [...remote];
      for (const l of local) if (!merged.some(m => m.name.toLowerCase() === l.name.toLowerCase())) merged.push(l);
      renderResults(merged.slice(0, 8));
    } catch {
      if (seq === searchSeq) renderResults(local);
    }
  }, 220);
});

function chooseResult(r) {
  if (!r) return;
  map.setView([r.lat, r.lon], 12);
  openPoint(r.lat, r.lon, r.name);
  results.hidden = true;
  search.value = r.name;
  search.blur();
}
results.addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (b) chooseResult(lastResults[Number(b.dataset.i)]);
});
search.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!lastResults.length) return;
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + lastResults.length) % lastResults.length;
    results.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === activeResult));
    e.preventDefault();
  } else if (e.key === 'Enter') {
    chooseResult(lastResults[Math.max(0, activeResult)]);
  } else if (e.key === 'Escape') {
    results.hidden = true; search.blur();
  }
});
search.addEventListener('focus', () => { if (lastResults.length) results.hidden = false; });
document.addEventListener('pointerdown', e => { if (!e.target.closest('.search-wrap')) results.hidden = true; });

const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Misc

function setBusy(b) { $('#busy').hidden = !b; }
function showError(msg) { const el = $('#error'); el.textContent = msg; el.hidden = false; setTimeout(() => { el.hidden = true; }, 6000); }

// URLs look like /overview/56.10,11.00,7 (layer, then lat,lon,zoom).
function updateUrl() {
  const c = map.getCenter();
  const url = `/${state.layer}/${c.lat.toFixed(2)},${c.lng.toFixed(2)},${map.getZoom()}${location.search}`;
  if (url !== location.pathname + location.search || location.hash) history.replaceState(null, '', url);
}
map.on('moveend', updateUrl);
map.on('zoomend', () => renderStations());

function readUrl() {
  // Old links used the hash: #overview,56.10,11.00,7
  const [layer, view] = location.hash.length > 1
    ? (h => [h[0], h.slice(1).join(',')])(location.hash.slice(1).split(','))
    : location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (Object.hasOwn(LAYERS, layer)) state.layer = layer;
  const [lat, lon, z] = (view || '').split(',').map(Number);
  if ([lat, lon, z].every(Number.isFinite) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    map.setView([lat, lon], Math.round(z), { animate: false });
  }
}

// Wrap update to expose the in-flight promise for the play loop.
const _update = update;
update = function () { update.lastPromise = _update(); return update.lastPromise; };

async function boot() {
  readUrl();
  let open = window.innerWidth >= 1000;
  try { const v = localStorage.getItem('vindy.menuOpen') ?? localStorage.getItem('vindue.menuOpen'); if (v != null && window.innerWidth >= 700) open = v === '1'; } catch { /* ignore */ }
  setMenuOpen(open, false);
  renderMenu();
  renderLegend();
  for (let attempt = 0; ; attempt++) {
    state.meta = await fetch('/api/meta').then(r => r.json()).catch(() => null);
    if (state.meta?.dini) break;
    // Say what is actually happening — and only after a first quick retry, so a restarting
    // server or a moment without network doesn't flash a message.
    if (attempt > 0) {
      const reachable = !!state.meta && navigator.onLine !== false;
      $('#boot').innerHTML = `<span class="spinner"></span> ${reachable
        ? 'Henter den seneste DMI-modelkørsel… (kun ved allerførste start)'
        : 'Ingen forbindelse til serveren — prøver igen…'}`;
      $('#boot').hidden = false;
    }
    await new Promise(r => setTimeout(r, attempt ? 2000 : 500));
  }
  $('#boot').hidden = true;
  state.time = nearestForecastTime(new Date().toISOString());
  if (isObserved(state.layer)) { await loadObsFrames(state.layer).catch(() => {}); state.obsIndex = obsFrames().length - 1; }
  weather.showParticles = state.particles;
  weather.redraw();
  renderTimeline();
  update();
  loadStations();
  setInterval(loadStations, 5 * 60e3);
  setInterval(async () => {
    if (exportState.rendering) return; // don't switch data while an animation is recorded
    if (LAYERS[state.layer].radar && !state.playing) { state.radarFramesAt = 0; overviewPrecip(state.time); }
    if (isObserved(state.layer) && !state.playing) {
      const last = state.obsIndex === obsFrames().length - 1;
      await loadObsFrames(state.layer).catch(() => {});
      if (last) state.obsIndex = obsFrames().length - 1;
      renderTimeline(); showObservedFrame();
    }
    const m = await fetch('/api/meta').then(r => r.json()).catch(() => null);
    if (m?.dini && m.dini.run !== state.meta.dini.run && !state.playing) {
      state.meta = m; fieldCache.clear(); overlayCache.clear(); accCache.clear(); tpCache.clear();
      if (!m.dini.times.includes(state.time)) state.time = nearestForecastTime(new Date().toISOString());
      renderTimeline(); update();
    }
  }, 60e3);
}

window.vindy = { map, state, weather };
// ---------------------------------------------------------------------------
// Installable app (PWA)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install-group').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-group').hidden = true; });
$('#install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#install-group').hidden = true;
});

boot();
