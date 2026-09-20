// DMI open data: HARMONIE DINI forecast grids (GRIB via S3 range requests),
// WAM wave model, point forecasts (EDR) and station observations (metObs).
import { indexFile, readHead, readWindow, readBlockAverage, fetchRange, pool } from './grib.js';
import { detectFronts, joinSegments, simplify } from './fronts.js';
import { inBackground, whenIdle } from './net.js';
import { makeProjector, isolines, extrema } from '../public/js/field.js';
import { decodeMessages } from './grib1.js';
import { makeLcc } from '../public/js/lcc.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Lru, once, diskGet, diskPut, getJson, encodeField, decodeField, CACHE_DIR } from './util.js';

const API = 'https://opendataapi.dmi.dk';
const DK_BOUNDS = { west: 3.0, east: 18.2, south: 53.2, north: 59.3 }; // full 2 km detail
// Wider area (same as the fronts) served block-averaged to 6 km around the detailed core.
const OUTER_BOUNDS = { west: -6, east: 28, south: 48, north: 65 };
const OUTER_BLOCK = 3;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// PREFETCH controls how much of each new model run is prepared before anyone asks:
//   off  – only isobars, fronts, accumulated rain (all hours) and wind/temperature near now
//   24h  – additionally every layer for the next 24 hours (default)
//   all  – every layer for every hour of the run
const PREFETCH = (process.env.PREFETCH || '24h').toLowerCase();
const PREFETCH_LAYERS = ['pressure', 'wind', 'windp', 'temp', 'rain', 'gust', 'clouds', 'lowclouds', 'humidity', 'dewpoint', 'visibility', 'cape']; // waves: see warmWam

// ---------------------------------------------------------------------------
// Model run discovery

async function listRunFiles(collection, run) {
  const d = await getJson(`${API}/v1/forecastdata/collections/${collection}/items?limit=300&modelRun=${run}`);
  return d.features
    .map(f => ({ id: f.id, url: f.asset.data.href, time: f.properties.datetime }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function findLatestRun(collection, stepHours, minFiles) {
  const now = Date.now();
  let t = Math.floor(now / (stepHours * 3600e3)) * stepHours * 3600e3;
  for (let k = 0; k < 6; k++, t -= stepHours * 3600e3) {
    const run = new Date(t).toISOString().replace('.000Z', 'Z');
    const files = await listRunFiles(collection, run).catch(() => []);
    if (files.length >= minFiles) return { run, files };
  }
  throw new Error(`No complete run found for ${collection}`);
}

// ---------------------------------------------------------------------------
// HARMONIE DINI surface model

// Message selectors (GRIB2 discipline/category/number, surface type, level).
const M = {
  t2m: { d: 0, c: 0, n: 0, s: 103, l: 2 },
  td2m: { d: 0, c: 0, n: 6, s: 103, l: 2 },
  u10: { d: 0, c: 2, n: 2, s: 103, l: 10 },
  v10: { d: 0, c: 2, n: 3, s: 103, l: 10 },
  ws10: { d: 0, c: 2, n: 1, s: 103, l: 10 },
  wd10: { d: 0, c: 2, n: 0, s: 103, l: 10 },
  gust: { d: 0, c: 2, n: 22, s: 103, l: 10 },
  mslp: { d: 0, c: 3, n: 0, s: 102, l: 0 },
  rh2m: { d: 0, c: 1, n: 1, s: 103, l: 2 },
  tcc: { d: 0, c: 6, n: 32, s: 103, l: 0 },
  lcc: { d: 0, c: 6, n: 3, s: 103, l: 0 },
  tp: { d: 0, c: 1, n: 52, s: 1 },
  vis: { d: 0, c: 19, n: 0, s: 103, l: 0 },
  cape: { d: 0, c: 7, n: 6, s: 1 },
  thw850: { d: 0, c: 0, n: 3, s: 100, l: 85000 },
  u850: { d: 0, c: 2, n: 2, s: 100, l: 85000 },
  v850: { d: 0, c: 2, n: 3, s: 100, l: 85000 },
};
const findMsg = (idx, sel) => idx.find(m => m.discipline === sel.d && m.category === sel.c && m.number === sel.n && m.surface === sel.s && (sel.l === undefined || m.level === sel.l));

const state = {
  dini: null, // HARMONIE surface: { run, files:[{url,time,index}], grid, win, outer, complete }
  pl: null, // HARMONIE pressure levels (fronts)
  wam: null, // WAM waves: { run, files }
};

// A rectangular index window of the model grid covering `bounds`, optionally
// block-averaged by `block` cells. Also precomputes the per-cell rotation from
// grid-relative to earth-relative wind.
function computeWindow(grid, bounds, block = 1) {
  const P = makeLcc(grid);
  const [gx0, gy0] = P.forward(grid.lo1, grid.la1);
  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  const { west, east, south, north } = bounds;
  for (let k = 0; k <= 40; k++) {
    const f = k / 40;
    for (const [lon, lat] of [[west + f * (east - west), south], [west + f * (east - west), north], [west, south + f * (north - south)], [east, south + f * (north - south)]]) {
      const [x, y] = P.forward(lon, lat);
      const i = (x - gx0) / grid.dx, j = (y - gy0) / grid.dy;
      imin = Math.min(imin, i); imax = Math.max(imax, i); jmin = Math.min(jmin, j); jmax = Math.max(jmax, j);
    }
  }
  const i0 = Math.max(0, Math.floor(imin)), j0 = Math.max(0, Math.floor(jmin));
  const w = Math.floor((Math.min(grid.nx - 1, Math.ceil(imax)) - i0 + 1) / block);
  const h = Math.floor((Math.min(grid.ny - 1, Math.ceil(jmax)) - j0 + 1) / block);
  const i1 = i0 + w * block - 1, j1 = j0 + h * block - 1;
  const dx = grid.dx * block, dy = grid.dy * block;
  const x0 = gx0 + (i0 + (block - 1) / 2) * grid.dx, y0 = gy0 + (j0 + (block - 1) / 2) * grid.dy;
  const cos = new Float32Array(w * h), sin = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [lon] = P.inverse(x0 + i * dx, y0 + j * dy);
    const a = P.rotation(lon);
    cos[j * w + i] = Math.cos(a); sin[j * w + i] = Math.sin(a);
  }
  return { i0, i1, j0, j1, w, h, block, x0, y0, dx, dy, cos, sin };
}

const gridMeta = (d, win) => ({ type: 'lcc', latin1: d.grid.latin1, latin2: d.grid.latin2, lov: d.grid.lov, radius: d.grid.radius, x0: win.x0, y0: win.y0, dx: win.dx, dy: win.dy, w: win.w, h: win.h });

async function indexWithCache(file) {
  const key = `idx/${file.id}.json`;
  const cached = await diskGet(key);
  if (cached) return JSON.parse(cached);
  const idx = await indexFile(file.url);
  await diskPut(key, JSON.stringify(idx));
  return idx;
}

const sameVar = (m, sel) => m && m.discipline === sel.d && m.category === sel.c && m.number === sel.n && m.surface === sel.s && (sel.l === undefined || m.level === sel.l);

// Locate a variable's GRIB message inside a forecast file. Files of one run share
// their layout, so we probe the offset from the reference index first (1 request)
// and only walk the whole file when that guess is wrong.
async function getMsg(file, name) {
  const sel = M[name];
  if (file.msgs[name] !== undefined) return file.msgs[name];
  if (!file.index) {
    const h = await locateMsg(file, sel).catch(() => null);
    if (h) return (file.msgs[name] = h);
    file.index = await once(`index:${file.id}`, () => indexWithCache(file));
  }
  return (file.msgs[name] = findMsg(file.index, sel) || null);
}

// Files of one run share their message order, but a few messages carry a bitmap
// (e.g. cloud base/top, precipitation type) whose size changes from hour to hour and
// shifts everything after it. Read just those variable-size headers to work out the
// shift, then read the wanted header at its corrected offset.
async function locateMsg(file, sel) {
  const ref = file.ref;
  const ti = ref.findIndex(m => sameVar(m, sel));
  if (ti < 0) return null;
  let delta = 0;
  for (let k = 0; k < ti; k++) {
    const m = ref[k];
    if (m.bitmap === 255) continue;
    const h = await headAt(file, m.offset + delta);
    if (!h || h.category !== m.category || h.number !== m.number) return null;
    delta += h.totalLength - m.totalLength;
  }
  const h = await headAt(file, ref[ti].offset + delta);
  return sameVar(h, sel) ? h : null;
}

function headAt(file, offset) {
  file.heads ??= new Map();
  if (!file.heads.has(offset)) {
    const p = readHead(file.url, offset).catch(() => null);
    file.heads.set(offset, p);
  }
  return file.heads.get(offset);
}

// Drop in-memory data of a replaced run right away (disk files go in pruneCache).
function forgetRun(kind, run) {
  const prefix = `field/${{ dini: '', pl: 'pl_', wam: 'wam_' }[kind]}${run.replace(/:/g, '')}/`;
  for (const key of [...fieldMem.map.keys()]) if (key.startsWith(prefix)) fieldMem.delete(key);
}

// ---------------------------------------------------------------------------
// Model run updates
//
// A timer (not visitors) looks for new model runs every 10 minutes. A new run is prepared
// completely in the background while visitors keep getting the previous run; only when
// every prepared step succeeded does the server switch over and delete the old run. If
// something fails (e.g. a network hiccup), the old run stays active and the next check
// retries just the missing pieces. The active runs are remembered on disk, so a restart
// serves them immediately instead of starting from scratch.

const pending = { dini: null, pl: null, wam: null }; // runs being prepared, not yet served
const STATE_FILE = 'state.json';

async function buildRun(run, files) {
  const ref = files[Math.min(6, files.length - 1)];
  const refIdx = await indexWithCache(ref);
  const grid = refIdx[0].grid;
  return { run, grid, refIdx, files: files.map(f => ({ ...f, msgs: {}, ref: refIdx, index: f === ref ? refIdx : null })) };
}
async function buildDini(run, files) {
  const d = await buildRun(run, files);
  return { ...d, win: computeWindow(d.grid, DK_BOUNDS, 1), outer: computeWindow(d.grid, OUTER_BOUNDS, OUTER_BLOCK) };
}
async function buildPl(run, files) {
  const d = await buildRun(run, files);
  return { ...d, win: computeFrontWindow(d.grid) };
}

async function saveState() {
  const pick = m => m && { run: m.run, files: m.files.map(({ id, url, time }) => ({ id, url, time })) };
  await diskPut(STATE_FILE, JSON.stringify({ dini: pick(state.dini), pl: pick(state.pl), wam: pick(state.wam) }))
    .catch(e => log('saving state failed:', e.message));
}

// Called once at startup, before the first refresh.
export async function restore() {
  let saved;
  try { saved = JSON.parse(await diskGet(STATE_FILE)); } catch { return; }
  if (!saved) return;
  // DMI keeps runs for about 1.5 days; older ones can no longer be read on demand.
  const usable = m => m?.run && m.files?.length && Date.now() - Date.parse(m.run) < 30 * 3600e3;
  const t0 = Date.now();
  await Promise.all([
    usable(saved.dini) && buildDini(saved.dini.run, saved.dini.files).then(d => { state.dini = d; }),
    usable(saved.pl) && buildPl(saved.pl.run, saved.pl.files).then(d => { state.pl = d; }),
  ].map(p => p && p.catch(e => log('restoring cached run failed:', e.message))));
  if (usable(saved.wam)) state.wam = { run: saved.wam.run, files: saved.wam.files };
  log('restored cached runs in', Date.now() - t0, 'ms:', `DINI ${state.dini?.run ?? '–'}, PL ${state.pl?.run ?? '–'}, WAM ${state.wam?.run ?? '–'}`);
}

// Shared update flow for the three models.
async function updateModel(kind, label, latest, build, warm) {
  const { run, files } = latest;
  const cur = state[kind];
  if (cur?.run === run && cur.complete) return;
  let next = cur?.run === run ? cur : pending[kind]?.run === run ? pending[kind] : null;
  if (!next) {
    next = await build(run, files);
    if (!cur) {
      // Very first start: nothing older to serve, so serve this run while it is prepared.
      state[kind] = next;
      await saveState();
      log(label, run, 'active (first start, preparing in the background)');
    } else {
      pending[kind] = next;
      log(label, run, 'found; preparing it in the background, visitors still get', cur.run);
    }
  }
  const { failed, total } = await inBackground(() => warm(next));
  const old = state[kind];
  const oldAgeH = old ? (Date.now() - Date.parse(old.run)) / 3600e3 : 0;
  // Only switch to a complete run. As a safety valve, accept a few gaps (filled in on
  // demand) once the served run is more than 12 hours old.
  if (failed && !(oldAgeH > 12 && failed / total < 0.05)) {
    log(label, run, `${failed} of ${total} steps failed; keeping ${old.run === run ? 'it' : old.run} and retrying in 10 min`);
    return;
  }
  next.complete = true;
  if (old === next) return;
  state[kind] = next;
  pending[kind] = null;
  if (kind === 'dini') { warmSeen.clear(); warmQueue.length = 0; }
  forgetRun(kind, old.run);
  await saveState();
  log(label, run, 'active; replaced', old.run);
}

const refreshDini = async () => updateModel('dini', 'DINI', await findLatestRun('harmonie_dini_sf', 3, 61), buildDini, warmDini);
const refreshPl = async () => updateModel('pl', 'DINI pressure levels', await findLatestRun('harmonie_dini_pl', 3, 61), buildPl, warmPl);
const refreshWam = async () => updateModel('wam', 'WAM', await findLatestRun('wam_dw', 6, 60), async (run, files) => ({ run, files }), warmWam);

// Drop cached indexes and fields of runs that are neither served nor being prepared.
async function pruneCache() {
  const runs = kind => [state[kind]?.run, pending[kind]?.run].filter(Boolean);
  const tag = run => `${run.slice(0, 10)}T${run.slice(11, 13)}0000Z`;
  const keepIdx = [...runs('dini').map(r => `HARMONIE_DINI_SF_${tag(r)}`), ...runs('pl').map(r => `HARMONIE_DINI_PL_${tag(r)}`)];
  for (const f of await fs.readdir(path.join(CACHE_DIR, 'idx')).catch(() => [])) {
    if (!keepIdx.some(k => f.startsWith(k))) await fs.rm(path.join(CACHE_DIR, 'idx', f), { force: true });
  }
  const dir = r => r.replace(/:/g, '');
  const keepDirs = [...runs('dini').map(dir), ...runs('pl').map(r => `pl_${dir(r)}`), ...runs('wam').map(r => `wam_${dir(r)}`)];
  for (const d of await fs.readdir(path.join(CACHE_DIR, 'field')).catch(() => [])) {
    if (!keepDirs.includes(d)) await fs.rm(path.join(CACHE_DIR, 'field', d), { recursive: true, force: true });
  }
  // Files written by older versions of the cache format.
  for (const d of await fs.readdir(path.join(CACHE_DIR, 'field')).catch(() => [])) {
    for (const f of await fs.readdir(path.join(CACHE_DIR, 'field', d)).catch(() => [])) {
      if (/^(waves_|v2_waves_|(?!fronts_)[a-z]+_\d{4}-)/.test(f)) await fs.rm(path.join(CACHE_DIR, 'field', d, f), { force: true });
    }
  }
}

const byDistanceToNow = files => {
  const now = Date.now();
  return files.map(f => f.time).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now));
};

// The hours whose layers are prepared ahead: see PREFETCH.
function prefetchWindow(d) {
  const times = byDistanceToNow(d.files);
  if (PREFETCH === 'all') return times;
  if (PREFETCH === 'off') return times.slice(0, 12);
  const now = Date.now();
  const inWindow = times.filter(t => Date.parse(t) >= now - 3600e3 && Date.parse(t) <= now + 24 * 3600e3);
  return inWindow.length ? inWindow : times.slice(0, 25);
}

// Runs warm-up steps two at a time, visitors first. A step whose result is already on
// disk is skipped without loading it, so re-checking a prepared run takes seconds.
// Parameters that simply don't exist at some forecast step don't count as failures.
async function runSteps(steps) {
  let failed = 0;
  await pool(steps.map(({ key, label, fn }) => async () => {
    if (key && await onDisk(key)) return;
    await whenIdle();
    try { await fn(); } catch (e) {
      if (e.missing) return;
      failed++;
      log('warm', label, e.message);
    }
  }), 2);
  return { failed, total: steps.length };
}
const onDisk = key => fs.access(path.join(CACHE_DIR, key)).then(() => true, () => false);

async function warmDini(d) {
  const t0 = Date.now();
  const times = byDistanceToNow(d.files);
  const window = prefetchWindow(d);
  const layers = PREFETCH === 'off' ? ['wind', 'temp'] : PREFETCH_LAYERS.filter(l => l !== 'pressure');
  const step = (layer, t) => ({ key: fieldKey(d, layer, t), label: `${layer} ${t}`, fn: () => getField(layer, t, d) });
  const steps = [
    // What a first visitor sees (Oversigt with particles) near now comes first.
    ...times.slice(0, 3).flatMap(t => [step('temp', t), step('windp', t)]),
    // Locate the point-forecast variables in every file (headers only), so clicking the
    // map never has to search 61 files first when DMI's EDR service is unavailable.
    ...d.files.map(f => ({ label: `locate ${f.time}`, fn: () => Promise.all(POINT_VARS.map(n => getMsg(f, n))) })),
    // Accumulated precipitation for every hour, so any range on the timeline is instant
    // (hourly rain is derived from these without further downloads).
    ...times.map(t => step('tpacc', t)),
    // Pressure first inside the prefetch window: isobars for those hours reuse it.
    ...window.map(t => step('pressure', t)),
    ...times.map(t => ({ key: fieldKey(d, 'isobars', t, 'json'), label: `isobars ${t}`, fn: () => getIsobars(t, d) })),
    ...window.flatMap(t => layers.map(l => step(l, t))),
  ];
  const result = await runSteps(steps);
  log('prepared DINI', d.run, `(prefetch ${PREFETCH}: ${window.length} h × ${layers.length} layers)`, 'in', ((Date.now() - t0) / 1000).toFixed(0), 's', result.failed ? `, ${result.failed} failed` : '');
  return result;
}

async function warmPl(pl) {
  const t0 = Date.now();
  const result = await runSteps(byDistanceToNow(pl.files).map(t => ({ key: frontsKey(pl, t), label: `fronts ${t}`, fn: () => getFronts(t, pl) })));
  log('prepared fronts', pl.run, 'in', ((Date.now() - t0) / 1000).toFixed(0), 's', result.failed ? `, ${result.failed} failed` : '');
  return result;
}

async function warmWam(w) {
  const t0 = Date.now();
  // Wave fields are small (two messages per hour), so every hour is prepared: the map
  // and the point forecasts then never have to wait for WAM data.
  const window = PREFETCH === 'off' ? byDistanceToNow(w.files).slice(0, 12) : byDistanceToNow(w.files);
  const result = await runSteps(window.map(t => ({ key: wavesKey(w, t), label: `waves ${t}`, fn: () => getWaves(t, w) })));
  log('prepared WAM', w.run, 'in', ((Date.now() - t0) / 1000).toFixed(0), 's', result.failed ? `, ${result.failed} failed` : '');
  return result;
}

const runDir = d => `field/${d.run.replace(/:/g, '')}`;
const fieldKey = (d, layer, time, ext = 'bin') => `${runDir(d)}/v2_${layer}_${time.replace(/:/g, '')}.${ext}`;
const frontsKey = (pl, time) => `field/pl_${pl.run.replace(/:/g, '')}/fronts_${time.replace(/:/g, '')}.json`;
const wavesKey = (w, time) => `field/wam_${w.run.replace(/:/g, '')}/v3_waves_${time.replace(/:/g, '')}.bin`;

const FRONT_BOUNDS = OUTER_BOUNDS;
const FRONT_BLOCK = 4;
function computeFrontWindow(grid) {
  const P = makeLcc(grid);
  const [x0, y0] = P.forward(grid.lo1, grid.la1);
  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  const { west, east, south, north } = FRONT_BOUNDS;
  for (let k = 0; k <= 20; k++) {
    const f = k / 20;
    for (const [lon, lat] of [[west + f * (east - west), south], [west + f * (east - west), north], [west, south + f * (north - south)], [east, south + f * (north - south)]]) {
      const [x, y] = P.forward(lon, lat);
      const i = (x - x0) / grid.dx, j = (y - y0) / grid.dy;
      imin = Math.min(imin, i); imax = Math.max(imax, i); jmin = Math.min(jmin, j); jmax = Math.max(jmax, j);
    }
  }
  return {
    i0: Math.max(0, Math.floor(imin)), i1: Math.min(grid.nx - 1, Math.ceil(imax)),
    j0: Math.max(0, Math.floor(jmin)), j1: Math.min(grid.ny - 1, Math.ceil(jmax)),
    toLonLat: (fi, fj, i0, j0) => P.inverse(x0 + (i0 + fi * FRONT_BLOCK + FRONT_BLOCK / 2) * grid.dx, y0 + (j0 + fj * FRONT_BLOCK + FRONT_BLOCK / 2) * grid.dy),
  };
}

export async function getFronts(time, pl = state.pl) {
  if (!pl) throw new Error('Trykniveaudata er ikke klar endnu');
  const f = pl.files.find(x => x.time === time) || nearestFile(pl.files, time);
  if (!f) throw new Error('Ukendt tidspunkt');
  const key = frontsKey(pl, f.time);
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      const { i0, i1, j0, j1, toLonLat } = pl.win;
      const [th, u, v] = await Promise.all(['thw850', 'u850', 'v850'].map(async n => {
        const msg = await getMsg(f, n);
        if (!msg) throw Object.assign(new Error(`${n} missing`), { missing: true });
        return readBlockAverage(f.url, msg, i0, i1, j0, j1, FRONT_BLOCK);
      }));
      const fronts = detectFronts({
        theta: th.data, u: u.data, v: v.data, w: th.w, h: th.h,
        ds: pl.grid.dx * FRONT_BLOCK / 1000, toLonLat: (fi, fj) => toLonLat(fi, fj, i0, j0),
      });
      buf = Buffer.from(JSON.stringify({ time: f.time, run: pl.run, source: 'Beregnet ud fra DMI HARMONIE DINI 850 hPa θw og vind', fronts }));
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

let refreshing = false;
export async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await Promise.all([
      refreshDini().catch(e => log('DINI refresh failed:', e.message)),
      refreshWam().catch(e => log('WAM refresh failed:', e.message)),
      refreshPl().catch(e => log('DINI PL refresh failed:', e.message)),
    ]);
    if (state.dini && state.pl) await pruneCache().catch(e => log('pruning cache failed:', e.message));
  } finally {
    refreshing = false;
  }
}

export function meta() {
  const d = state.dini, w = state.wam;
  return {
    bounds: DK_BOUNDS,
    outerBounds: OUTER_BOUNDS,
    dini: d && {
      run: d.run,
      times: d.files.map(f => f.time),
      grids: { fine: gridMeta(d, d.win), coarse: gridMeta(d, d.outer) },
    },
    wam: w && { run: w.run, times: w.files.map(f => f.time) },
  };
}

// ---------------------------------------------------------------------------
// Field extraction

const fieldMem = new Lru(500, 256 * 1024 * 1024); // at most ~256 MB of decoded fields in RAM

async function readVar(file, win, name) {
  const msg = await getMsg(file, name);
  if (!msg) return null;
  const { i0, i1, j0, j1, block } = win;
  if (block === 1) return readWindow(file.url, msg, i0, i1, j0, j1);
  return (await readBlockAverage(file.url, msg, i0, i1, j0, j1, block)).data;
}

const DINI_LAYERS = {
  wind: async (f, i, d, win) => windBands(win, ...(await Promise.all([readVar(f, win, 'u10'), readVar(f, win, 'v10')]))),
  temp: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 't2m'), v => v - 273.15), scale: 0.05 }],
  dewpoint: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'td2m'), v => v - 273.15), scale: 0.05 }],
  gust: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'gust'), v => v), scale: 0.05 }],
  pressure: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'mslp'), v => v / 100), scale: 0.05 }],
  humidity: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'rh2m'), v => Math.min(100, v)), scale: 0.5 }],
  clouds: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'tcc'), v => v * 100), scale: 0.5 }],
  lowclouds: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'lcc'), v => v * 100), scale: 0.5 }],
  visibility: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'vis'), v => v / 1000), scale: 0.05 }],
  cape: async (f, i, d, win) => [{ name: 'v', data: map(await readVar(f, win, 'cape'), v => v), scale: 5 }],
  rain: null, // hourly rain is derived from 'tpacc' in getHourlyRain
  // Total precipitation accumulated since the model run started (mm). The browser
  // subtracts two of these to get the amount between any two hours.
  tpacc: async (f, i, d, win) => {
    const cur = await readVar(f, win, 'tp');
    return [{ name: 'v', data: cur ? map(cur, v => Math.max(0, v)) : new Float32Array(win.w * win.h), scale: 0.02 }];
  },
};

function map(arr, fn) {
  if (!arr) throw Object.assign(new Error('Parameteren mangler i dette prognosetidspunkt'), { missing: true });
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = fn(arr[i]);
  return out;
}

function windBands(win, u, v) {
  if (!u || !v) throw new Error('Vind mangler i dette prognosetidspunkt');
  const { cos, sin } = win;
  const ue = new Float32Array(u.length), ve = new Float32Array(u.length);
  for (let k = 0; k < u.length; k++) {
    ue[k] = u[k] * cos[k] + v[k] * sin[k];
    ve[k] = -u[k] * sin[k] + v[k] * cos[k];
  }
  return [{ name: 'u', data: ue, scale: 0.05 }, { name: 'v', data: ve, scale: 0.05 }];
}

export const LAYER_NAMES = [...Object.keys(DINI_LAYERS), 'waves'];

export async function getField(layer, time, d = state.dini) {
  if (layer === 'waves') return getWaves(time);
  if (layer === 'windp') return getParticleWind(time, d);
  if (layer === 'rain') return getHourlyRain(time, d);
  if (!d) throw new Error('Prognosen er ikke klar endnu');
  const builder = DINI_LAYERS[layer];
  if (!builder) throw new Error('Ukendt lag');
  const i = d.files.findIndex(f => f.time === time);
  if (i < 0) throw new Error('Ukendt tidspunkt');
  const key = fieldKey(d, layer, time);
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      // Two nested grids: 2 km over Denmark and 6 km over the wider area.
      const [fine, coarse] = await Promise.all([builder(d.files[i], i, d, d.win), builder(d.files[i], i, d, d.outer)]);
      buf = encodeField(
        { layer, time, run: d.run, grids: { fine: gridMeta(d, d.win), coarse: gridMeta(d, d.outer) } },
        [...fine.map(b => ({ ...b, grid: 'fine' })), ...coarse.map(b => ({ ...b, grid: 'coarse' }))],
      );
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

// On-demand warming: when a layer-hour is viewed, pre-compute the same layer (and the
// particle wind) for the surrounding hours in the background, nearest first, so scrubbing
// the timeline is instant without downloading every layer for every hour up front.
const warmQueue = [];
const warmSeen = new Set();
let warmWorkers = 0;
export function warmAround(layer, time, radius = 12) {
  const d = state.dini;
  if (!d || !(layer in DINI_LAYERS) || layer === 'tpacc') return;
  const i = d.files.findIndex(f => f.time === time);
  if (i < 0) return;
  const jobs = [];
  for (let k = 1; k <= radius; k++) {
    for (const j of [i + k, i - k]) {
      const f = d.files[j];
      if (!f) continue;
      for (const l of layer === 'wind' ? ['wind'] : [layer, 'windp']) {
        const key = `${d.run}|${l}|${f.time}`;
        if (warmSeen.has(key)) continue;
        warmSeen.add(key);
        jobs.push({ run: d.run, layer: l, time: f.time });
      }
    }
  }
  warmQueue.unshift(...jobs); // the most recent view goes first
  while (warmWorkers < 2 && warmQueue.length) {
    warmWorkers++;
    inBackground(async () => {
      while (warmQueue.length) {
        const job = warmQueue.shift();
        await whenIdle();
        if (job.run !== state.dini?.run) continue; // the run was replaced while waiting
        await getField(job.layer, job.time).catch(() => {});
      }
    }).finally(() => { warmWorkers--; });
  }
}

// Hourly rain = accumulated precipitation at this hour minus the previous hour. Built from
// the (always prepared) accumulation fields, so it needs no downloads of its own.
async function getHourlyRain(time, d = state.dini) {
  if (!d) throw new Error('Prognosen er ikke klar endnu');
  const i = d.files.findIndex(f => f.time === time);
  if (i < 0) throw new Error('Ukendt tidspunkt');
  const key = fieldKey(d, 'rain', time);
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      const cur = decodeField(await getField('tpacc', time, d));
      const prev = i > 0 ? decodeField(await getField('tpacc', d.files[i - 1].time, d)) : null;
      const bands = cur.bands.map((b, k) => {
        const p = prev?.bands[k].data;
        const data = new Float32Array(b.data.length);
        for (let n = 0; n < data.length; n++) data[n] = Math.max(0, b.data[n] - (p ? p[n] : b.data[n]));
        return { name: 'v', grid: b.grid, data, scale: 0.01 };
      });
      buf = encodeField({ layer: 'rain', time, run: d.run, grids: cur.header.grids }, bands);
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

// Light wind field for particle animation on non-wind layers: both grids halved in each
// direction (4 km / 12 km) at 0.1 m/s precision. Derived from the cached wind field, so it
// costs no extra DMI downloads, and is about a quarter of the size.
async function getParticleWind(time, d = state.dini) {
  if (!d) throw new Error('Prognosen er ikke klar endnu');
  if (!d.files.some(f => f.time === time)) throw new Error('Ukendt tidspunkt');
  const key = fieldKey(d, 'windp', time);
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      const { header, bands } = decodeField(await getField('wind', time, d));
      const grids = {};
      for (const [name, g] of Object.entries(header.grids)) {
        grids[name] = { ...g, w: Math.floor(g.w / 2), h: Math.floor(g.h / 2), dx: g.dx * 2, dy: g.dy * 2, x0: g.x0 + g.dx / 2, y0: g.y0 + g.dy / 2 };
      }
      const out = bands.map(b => {
        const g = header.grids[b.grid], G = grids[b.grid];
        const data = new Float32Array(G.w * G.h);
        for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
          const k = 2 * j * g.w + 2 * i;
          data[j * G.w + i] = (b.data[k] + b.data[k + 1] + b.data[k + g.w] + b.data[k + g.w + 1]) / 4;
        }
        return { name: b.name, grid: b.grid, data, scale: 0.1 };
      });
      buf = encodeField({ layer: 'windp', time, run: d.run, grids }, out);
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

// Isobars (2 hPa) and pressure highs/lows as compact polylines, computed on the
// server so the browser only has to draw them.
export async function getIsobars(time, d = state.dini) {
  if (!d) throw new Error('Prognosen er ikke klar endnu');
  const i = d.files.findIndex(f => f.time === time);
  if (i < 0) throw new Error('Ukendt tidspunkt');
  const key = fieldKey(d, 'isobars', time, 'json');
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      const grid = gridMeta(d, d.outer);
      // Reuse the pressure layer's 6 km grid when it has already been prepared.
      const pressureKey = fieldKey(d, 'pressure', time);
      const pressureBuf = fieldMem.get(pressureKey) || await diskGet(pressureKey);
      let hpa = pressureBuf ? decodeField(pressureBuf).bands.find(b => b.grid === 'coarse')?.data : null;
      if (!hpa) {
        const mslp = await readVar(d.files[i], d.outer, 'mslp');
        if (!mslp) throw new Error('Lufttryk mangler i dette prognosetidspunkt');
        hpa = map(mslp, v => v / 100);
      }
      const field = { grid, bands: { v: hpa }, projector: makeProjector(grid) };
      const round = p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
      const lines = isolines(field, 2, 'v', 1).flatMap(({ level, segs }) =>
        joinSegments(segs).map(line => ({ level: Math.round(level), coords: simplify(line, 0.004).map(round) })));
      const ext = extrema(field, { radius: 24, stride: 2, prominence: 1.5 }).map(e => ({ type: e.type, value: Math.round(e.value * 10) / 10, lon: Math.round(e.lon * 1000) / 1000, lat: Math.round(e.lat * 1000) / 1000 }));
      buf = Buffer.from(JSON.stringify({ time, run: d.run, lines, extrema: ext }));
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

// ---------------------------------------------------------------------------
// WAM Danish waters: significant wave height + mean direction

async function getWaves(time, w = state.wam) {
  if (!w) throw new Error('Bølgemodellen er ikke klar endnu');
  const f = w.files.find(x => x.time === time) || nearestFile(w.files, time);
  if (!f) throw new Error('Ukendt tidspunkt');
  const key = wavesKey(w, f.time);
  const hit = fieldMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    let buf = await diskGet(key);
    if (!buf) {
      const { swh, mwd } = await readWaveMessages(f.url);
      if (!swh || !mwd) throw new Error('Bølgeparametre mangler');
      const g = swh.grid;
      const dlon = (g.lo2 - g.lo1) / (g.nx - 1), dlat = (g.la2 - g.la1) / (g.ny - 1);
      // Only height (cm precision) and direction (1°) are sent; the browser derives the
      // propagation vector for the wave-crest animation from them.
      buf = encodeField(
        { layer: 'waves', time: f.time, run: w.run, grid: { type: 'll', lon0: g.lo1, lat0: g.la1, dlon, dlat, w: g.nx, h: g.ny } },
        [{ name: 'v', data: swh.values, scale: 0.01 }, { name: 'dir', data: mwd.values, scale: 1 }],
      );
      await diskPut(key, buf);
    }
    fieldMem.set(key, buf);
    return buf;
  });
}

// WAM files hold 14 equally sized GRIB1 messages; only significant wave height (param
// 229, 3rd message) and mean direction (230, 7th) are needed. Read just those two by
// range (~0.5 MB instead of 3.6 MB) and fall back to the whole file if the layout differs.
async function readWaveMessages(url) {
  const head = await fetchRange(url, 0, 7);
  const len = (head[4] << 16) | (head[5] << 8) | head[6];
  const pick = async k => decodeMessages(await fetchRange(url, k * len, (k + 1) * len - 1))[0];
  try {
    const [swh, mwd] = await Promise.all([pick(2), pick(6)]);
    if (swh?.param === 229 && mwd?.param === 230) return { swh, mwd };
  } catch { /* fall through */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WAM HTTP ${res.status}`);
  const msgs = decodeMessages(Buffer.from(await res.arrayBuffer()));
  return { swh: msgs.find(m => m.param === 229), mwd: msgs.find(m => m.param === 230) };
}

function nearestFile(files, time) {
  const t = Date.parse(time);
  let best = null, bd = Infinity;
  for (const f of files) { const d = Math.abs(Date.parse(f.time) - t); if (d < bd) { bd = d; best = f; } }
  return bd <= 3 * 3600e3 ? best : null;
}

// ---------------------------------------------------------------------------
// Point forecast

const pointMem = new Lru(300);
// Point forecasts (the meteogram when clicking the map). Values come from the fields the
// server has already prepared for the map (next 24 hours, accumulated rain for every
// hour), read a few bytes at a time straight from the cache files. Only hours that aren't
// prepared are read from DMI's GRIB files. Waves come from the prepared WAM fields. This
// uses the same model run as the map and doesn't depend on DMI's rate-limited EDR service.
const POINT_VARS = ['t2m', 'u10', 'v10', 'gust', 'tp', 'tcc', 'mslp', 'rh2m'];
// Prepared layer -> the GRIB variables it replaces.
const POINT_LAYERS = { temp: ['t2m'], wind: ['u10', 'v10'], gust: ['gust'], tpacc: ['tp'], clouds: ['tcc'], pressure: ['mslp'], humidity: ['rh2m'] };

export async function pointForecast(lat, lon) {
  lat = Math.round(lat * 50) / 50; lon = Math.round(lon * 50) / 50;
  const key = `${state.dini?.run}|${state.wam?.run}/${lat},${lon}`;
  const hit = pointMem.get(key);
  if (hit) return hit;
  return once(key, async () => {
    const [out, waves] = await Promise.all([pointWeather(lat, lon), pointWaves(lat, lon).catch(() => null)]);
    out.waves = waves;
    pointMem.set(key, out);
    return out;
  });
}

// Grid cell of the prepared fields (2 km over Denmark, 6 km around it) for a location.
function pointCell(d, lon, lat) {
  const [x, y] = makeLcc(d.grid).forward(lon, lat);
  for (const [grid, win] of [['fine', d.win], ['coarse', d.outer]]) {
    const i = Math.round((x - win.x0) / win.dx), j = Math.round((y - win.y0) / win.dy);
    if (i >= 0 && j >= 0 && i < win.w && j < win.h) return { grid, index: j * win.w + i };
  }
  return null;
}

async function pointWeather(lat, lon) {
  const d = state.dini;
  if (!d) throw new Error('Prognosen er ikke klar endnu');
  const cell = pointCell(d, lon, lat);
  const rows = d.files.map(f => ({ time: f.time }));
  const grib = []; // [file index, variable] still to read from DMI
  await Promise.all(d.files.map(async (f, fi) => {
    const r = rows[fi];
    await Promise.all(Object.entries(POINT_LAYERS).map(async ([layer, vars]) => {
      const names = layer === 'wind' ? ['u', 'v'] : ['v'];
      const vals = cell && await readPrepared(fieldKey(d, layer, f.time), () => names.map(name => ({ name, grid: cell.grid, index: cell.index })));
      if (!vals || vals.some(v => Number.isNaN(v))) { for (const n of vars) grib.push([fi, n]); return; }
      if (layer === 'wind') { r.ue = vals[0]; r.ve = vals[1]; } else r[layer] = vals[0];
    }));
  }));

  if (grib.length) {
    const P = makeLcc(d.grid);
    const [x0, y0] = P.forward(d.grid.lo1, d.grid.la1);
    const [x, y] = P.forward(lon, lat);
    const i = Math.round((x - x0) / d.grid.dx), j = Math.round((y - y0) / d.grid.dy);
    const a = P.rotation(lon), c = Math.cos(a), sn = Math.sin(a);
    const raw = await pool(grib.map(([fi, n]) => async () => {
      const msg = await getMsg(d.files[fi], n);
      return [fi, n, msg ? (await readWindow(d.files[fi].url, msg, i, i, j, j))[0] : NaN];
    }), 64);
    const got = rows.map(() => ({}));
    for (const [fi, n, v] of raw) got[fi][n] = v;
    got.forEach((g, fi) => {
      const r = rows[fi];
      if ('t2m' in g) r.temp = g.t2m - 273.15;
      if ('u10' in g) { r.ue = g.u10 * c + g.v10 * sn; r.ve = -g.u10 * sn + g.v10 * c; }
      if ('gust' in g) r.gust = g.gust;
      if ('tp' in g) r.tpacc = g.tp;
      if ('tcc' in g) r.clouds = g.tcc * 100;
      if ('mslp' in g) r.pressure = g.mslp / 100;
      if ('rh2m' in g) r.humidity = g.rh2m;
    });
  }
  return shapePoint(lat, lon, 'DMI HARMONIE DINI', rows.map(r => ({
    time: r.time, temp: r.temp, wind: Math.hypot(r.ue, r.ve),
    dir: (Math.atan2(-r.ue, -r.ve) * 180 / Math.PI + 360) % 360, gust: r.gust,
    tp: Number.isFinite(r.tpacc) ? r.tpacc : 0, clouds: r.clouds, pressure: r.pressure, rh: r.humidity,
  })));
}

// Read single values from a prepared field without loading the whole file: from memory
// if it's there, otherwise a few small reads from the cache file. pick(header) returns
// [{ name, grid, index }]. Resolves to null when the field isn't prepared.
const headerMem = new Lru(2000);
async function readPrepared(key, pick) {
  const buf = fieldMem.get(key);
  if (buf) {
    const hlen = buf.readUInt32LE(0);
    const header = headerMem.get(key) || JSON.parse(buf.toString('utf8', 4, 4 + hlen));
    return pick(header).map(r => valueAt(header, 4 + hlen, r, (off) => buf.readInt16LE(off)));
  }
  let fh;
  try { fh = await fs.open(path.join(CACHE_DIR, key)); } catch { return null; }
  try {
    const small = Buffer.alloc(4);
    await fh.read(small, 0, 4, 0);
    const hlen = small.readUInt32LE(0);
    let header = headerMem.get(key);
    if (!header) {
      const hb = Buffer.alloc(hlen);
      await fh.read(hb, 0, hlen, 4);
      header = JSON.parse(hb.toString('utf8'));
      headerMem.set(key, header);
    }
    const reads = pick(header);
    const out = [];
    for (const r of reads) {
      out.push(await valueAtAsync(header, 4 + hlen, r, async off => { await fh.read(small, 0, 2, off); return small.readInt16LE(0); }));
    }
    return out;
  } finally {
    await fh.close();
  }
}
function bandOffset(header, base, { name, grid }) {
  let off = base;
  for (const b of header.bands) {
    if (b.name === name && (grid == null || b.grid === grid)) return { b, off };
    off += b.n * 2;
  }
  return null;
}
function valueAt(header, base, r, read) {
  const hit = bandOffset(header, base, r);
  if (!hit || r.index < 0 || r.index >= hit.b.n) return NaN;
  const raw = read(hit.off + r.index * 2);
  return raw === -32768 ? NaN : raw * hit.b.scale + hit.b.offset;
}
async function valueAtAsync(header, base, r, read) {
  const hit = bandOffset(header, base, r);
  if (!hit || r.index < 0 || r.index >= hit.b.n) return NaN;
  const raw = await read(hit.off + r.index * 2);
  return raw === -32768 ? NaN : raw * hit.b.scale + hit.b.offset;
}

// precip is the rain during that hour, acc the total since the run started. Both are
// derived from the accumulation the model reports, so prev has to be kept around.
function shapePoint(lat, lon, source, rows) {
  let prev = 0;
  for (const r of rows) {
    const tp = Number.isFinite(r.tp) ? r.tp : prev;
    r.precip = Math.max(0, tp - prev);
    r.acc = tp;
    prev = tp;
    delete r.tp;
  }
  return { lat, lon, source, run: state.dini?.run, rows };
}

// Wave height and direction from the prepared WAM fields (all hours are prepared). For a
// point on land close to the coast, the nearest sea cell within about 3 km is used.
async function pointWaves(lat, lon) {
  const w = state.wam;
  if (!w?.files.length) return null;
  const cell = await waveCell(w, lat, lon);
  if (cell == null) return null;
  const rows = await Promise.all(w.files.map(async f => {
    const vals = await readPrepared(wavesKey(w, f.time), () => [{ name: 'v', index: cell }, { name: 'dir', index: cell }]);
    if (!vals || !Number.isFinite(vals[0]) || !Number.isFinite(vals[1])) return null;
    return { time: f.time, height: vals[0], dir: vals[1] };
  }));
  const found = rows.filter(Boolean);
  return found.length ? found : null;
}

async function waveCell(w, lat, lon) {
  const key = wavesKey(w, w.files[0].time);
  let grid = null;
  const candidates = [];
  const centre = await readPrepared(key, h => {
    grid = h.grid;
    const i0 = Math.round((lon - grid.lon0) / grid.dlon), j0 = Math.round((lat - grid.lat0) / grid.dlat);
    const kmX = Math.abs(grid.dlon) * 111 * Math.cos(lat * Math.PI / 180), kmY = Math.abs(grid.dlat) * 111;
    const ri = Math.ceil(3 / kmX), rj = Math.ceil(3 / kmY);
    for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) {
      const i = i0 + di, j = j0 + dj, km = Math.hypot(di * kmX, dj * kmY);
      if (i >= 0 && j >= 0 && i < grid.w && j < grid.h && km <= 3) candidates.push({ index: j * grid.w + i, km });
    }
    candidates.sort((a, b) => a.km - b.km);
    return candidates.map(c => ({ name: 'v', index: c.index }));
  });
  if (!centre) return null;
  const k = centre.findIndex(Number.isFinite);
  return k < 0 ? null : candidates[k].index;
}

// ---------------------------------------------------------------------------
// Observations

let stations = null, stationsAt = 0;
let obsCache = null, obsAt = 0;
const OBS_PARAMS = new Set(['temp_dry', 'wind_speed', 'wind_dir', 'wind_max', 'precip_past1h', 'humidity', 'pressure_at_sea', 'visibility', 'cloud_cover', 'temp_dew']);

async function loadStations() {
  if (stations && Date.now() - stationsAt < 24 * 3600e3) return stations;
  const d = await getJson(`${API}/v2/metObs/collections/station/items?status=Active&limit=10000`);
  const m = new Map();
  for (const f of d.features) {
    const p = f.properties;
    const [lon, lat] = f.geometry?.coordinates || [];
    if (lon < DK_BOUNDS.west || lon > DK_BOUNDS.east || lat < 54.4 || lat > 58) continue;
    if (p.country !== 'DNK') continue;
    m.set(p.stationId, { id: p.stationId, name: p.name, lat, lon, type: p.type });
  }
  stations = m; stationsAt = Date.now();
  return m;
}

export async function observations() {
  if (obsCache && Date.now() - obsAt < 5 * 60e3) return obsCache;
  return once('obs', async () => {
    const st = await loadStations();
    const d = await getJson(`${API}/v2/metObs/collections/observation/items?period=latest-hour&limit=300000`);
    const by = new Map();
    for (const f of d.features) {
      const p = f.properties;
      if (!OBS_PARAMS.has(p.parameterId) || !st.has(p.stationId)) continue;
      let o = by.get(p.stationId);
      if (!o) by.set(p.stationId, (o = { ...st.get(p.stationId), obs: {}, observed: {} }));
      if (!o.observed[p.parameterId] || p.observed > o.observed[p.parameterId]) {
        o.obs[p.parameterId] = p.value;
        o.observed[p.parameterId] = p.observed;
      }
    }
    const list = [...by.values()].map(o => {
      const time = Object.values(o.observed).sort().pop();
      delete o.observed;
      return { ...o, time };
    });
    obsCache = { updated: new Date().toISOString(), stations: list };
    obsAt = Date.now();
    return obsCache;
  });
}
