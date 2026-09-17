// Leaflet layer that paints a colour-mapped scalar field, map annotations (isobars,
// fronts, value grid) and animated particles (wind streaks or wave crests).
import { sampleParts } from './field.js';
import { buildLut } from './layers.js';

const L = window.L;
const STEP = 2; // colour raster resolution in CSS px

export class WeatherLayer {
  constructor(map) {
    this.map = map;
    this.pane = map.createPane('weather');
    this.pane.style.zIndex = 350;
    this.pane.style.pointerEvents = 'none';
    this.colorCanvas = this._canvas();
    this.particleCanvas = this._canvas();
    this.annotationPane = map.createPane('annotations');
    this.annotationPane.style.zIndex = 430;
    this.annotationPane.style.pointerEvents = 'none';
    this.annoCanvas = this._canvas(this.annotationPane);
    this.field = null; // scalar field
    this.layerDef = null;
    this.vectorField = null; // field with u/v (or pu/pv) bands
    this.vectorNames = ['u', 'v'];
    this.particleMode = 'wind';
    this.showParticles = true;
    this.isobars = null; // { lines, extrema }
    this.fronts = null;
    this.grid = null; // { field, def } when the value grid is enabled
    this.gridCache = new Map();
    this.particles = [];
    this.opacity = 0.82;
    this._frame = this._frame.bind(this);

    map.on('movestart zoomstart', () => { this.moving = true; this._clearParticles(); this.particleCanvas.style.opacity = 0; });
    map.on('zoomstart', () => { this.colorCanvas.style.opacity = 0; this.annoCanvas.style.opacity = 0; });
    map.on('moveend zoomend resize', () => { this.moving = false; this.redraw(); });
    requestAnimationFrame(this._frame);
  }

  _canvas(parent = this.pane) {
    const c = L.DomUtil.create('canvas', 'weather-canvas', parent);
    c.style.position = 'absolute';
    c.style.transition = 'opacity .25s';
    return c;
  }

  setField(field, layerDef) {
    this.field = field;
    this.layerDef = layerDef;
    if (layerDef && !layerDef._lutObj) layerDef._lutObj = buildLut(layerDef);
    this.drawColors();
  }

  setVectorField(field, names = ['u', 'v'], mode = 'wind') {
    const changed = !this.vectorField || !field || field.parts[0].projector.key !== this.vectorField.parts[0].projector.key || mode !== this.particleMode;
    this.vectorField = field;
    this.vectorNames = names;
    this.particleMode = mode;
    if (changed) this._seedParticles();
  }

  setIsobars(isobars) { this.isobars = isobars; this.drawAnnotations(); }
  setFronts(fronts) { this.fronts = fronts; this.drawAnnotations(); }
  setGrid(grid) { this.grid = grid; this.drawAnnotations(); }

  redraw() {
    const size = this.map.getSize();
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.colorCanvas, this.particleCanvas, this.annoCanvas]) {
      L.DomUtil.setPosition(c, topLeft);
      c.style.width = size.x + 'px';
      c.style.height = size.y + 'px';
    }
    this.colorCanvas.width = size.x; this.colorCanvas.height = size.y;
    for (const c of [this.particleCanvas, this.annoCanvas]) { c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr); }
    this.view = this._viewKey();
    this.gridCache.clear();
    this.drawColors();
    this.drawAnnotations();
    this._seedParticles();
    this.particleCanvas.style.opacity = 1;
  }

  _viewKey() {
    const s = this.map.getSize();
    const a = this.map.containerPointToLatLng([0, 0]), b = this.map.containerPointToLatLng([s.x, s.y]);
    return { w: s.x, h: s.y, lon0: a.lng, lon1: b.lng, my0: mercY(a.lat), my1: mercY(b.lat) };
  }

  // Screen pixel -> [lon, lat] for the current view.
  _lonLat(x, y) {
    const v = this.view;
    return [v.lon0 + (v.lon1 - v.lon0) * x / v.w, invMercY(v.my0 + (v.my1 - v.my0) * y / v.h)];
  }

  // Grid indices of every raster cell for each part of a field.
  _partIndices(field) {
    return field.parts.map(p => this._gridIndices(p.projector));
  }

  // Fractional grid indices for every raster cell of the current view.
  _gridIndices(projector) {
    let g = this.gridCache.get(projector.key);
    if (g) return g;
    const v = this.view;
    const cw = Math.ceil(v.w / STEP), ch = Math.ceil(v.h / STEP);
    const gi = new Float32Array(cw * ch), gj = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) {
      const lat = invMercY(v.my0 + (v.my1 - v.my0) * (r * STEP + STEP / 2) / v.h);
      for (let c = 0; c < cw; c++) {
        const lon = v.lon0 + (v.lon1 - v.lon0) * (c * STEP + STEP / 2) / v.w;
        const [fi, fj] = projector.toGrid(lon, lat);
        gi[r * cw + c] = fi; gj[r * cw + c] = fj;
      }
    }
    g = { gi, gj, cw, ch };
    this.gridCache.set(projector.key, g);
    return g;
  }

  drawColors() {
    if (!this.view || !this.view.w || !this.view.h) return;
    const ctx = this.colorCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.colorCanvas.width, this.colorCanvas.height);
    const f = this.field, def = this.layerDef;
    if (!f || !def) { this.colorCanvas.style.opacity = 0; return; }
    const idx = this._partIndices(f);
    const { cw, ch } = idx[0];
    const gi0 = idx[0].gi, gj0 = idx[0].gj, gi1 = idx[1]?.gi, gj1 = idx[1]?.gj;
    if (!this.off) this.off = document.createElement('canvas');
    this.off.width = cw; this.off.height = ch;
    const octx = this.off.getContext('2d');
    const img = octx.createImageData(cw, ch);
    const px = img.data, parts = f.parts, two = parts.length > 1;
    const { lut, N, index } = def._lutObj;
    const alpha = this.opacity;
    for (let k = 0; k < cw * ch; k++) {
      const val = sampleParts(parts, 'v', gi0[k], gj0[k], two ? gi1[k] : 0, two ? gj1[k] : 0);
      if (Number.isNaN(val)) continue;
      const li = Math.max(0, Math.min(N - 1, index(val))) * 4;
      px[k * 4] = lut[li]; px[k * 4 + 1] = lut[li + 1]; px[k * 4 + 2] = lut[li + 2];
      px[k * 4 + 3] = lut[li + 3] * alpha;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, 0, 0, this.view.w, this.view.h);
    this.colorCanvas.style.opacity = 1;
  }

  // ---- annotations: isobars, H/L, fronts, value grid ----
  drawAnnotations() {
    if (!this.view || !this.view.w) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.annoCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.annoCanvas.width, this.annoCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.isobars) this._drawIsobars(ctx);
    if (this.fronts) this._drawFronts(ctx);
    if (this.grid) this._drawGrid(ctx);
    this.annoCanvas.style.opacity = 1;
  }

  _project(lon, lat) { const p = this.map.latLngToContainerPoint([lat, lon]); return [p.x, p.y]; }

  _drawIsobars(ctx) {
    const { lines, extrema } = this.isobars;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labels = [];
    for (const major of [false, true]) {
      ctx.beginPath();
      ctx.strokeStyle = major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.45)';
      ctx.lineWidth = major ? 1.5 : 1;
      for (const { level, coords } of lines) {
        if ((level % 4 === 0) !== major) continue;
        let px = 0, py = 0, run = 0;
        for (let k = 0; k < coords.length; k++) {
          const [x, y] = this._project(coords[k][0], coords[k][1]);
          if (k) { ctx.lineTo(x, y); run += Math.hypot(x - px, y - py); } else ctx.moveTo(x, y);
          px = x; py = y;
          if (major && run > 260 && x > 40 && y > 60 && x < this.view.w - 40 && y < this.view.h - 60) { labels.push([x, y, level]); run = 0; }
        }
      }
      ctx.stroke();
    }
    for (const [x, y, t] of labels) {
      ctx.fillStyle = 'rgba(14,18,26,.8)';
      roundRect(ctx, x - 17, y - 8, 34, 16, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(t, x, y + 0.5);
    }
    for (const e of extrema) {
      const [x, y] = this._project(e.lon, e.lat);
      if (x < 0 || y < 0 || x > this.view.w || y > this.view.h) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,12,18,.8)';
      ctx.font = '800 22px Inter, system-ui, sans-serif';
      ctx.strokeText(e.type, x, y);
      ctx.fillStyle = e.type === 'H' ? '#6fb1ff' : '#ff6b6b';
      ctx.fillText(e.type, x, y);
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.strokeText(Math.round(e.value), x, y + 17);
      ctx.fillStyle = '#fff'; ctx.fillText(Math.round(e.value), x, y + 17);
    }
    ctx.restore();
  }

  _drawFronts(ctx) {
    const COLD = '#2f7bff', WARM = '#ff3b3b', SPACING = 42;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const f of this.fronts) {
      const pts = f.coords.map(([lon, lat]) => this._project(lon, lat));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = cum[cum.length - 1];
      if (total < 30) continue;
      const at = d => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, tx: (x1 - x0) / len, ty: (y1 - y0) / len };
      };
      const stroke = (color, d0, d1) => {
        ctx.beginPath();
        const s = at(d0); ctx.moveTo(s.x, s.y);
        for (let i = 0; i < pts.length; i++) if (cum[i] > d0 && cum[i] < d1) ctx.lineTo(pts[i][0], pts[i][1]);
        const e = at(d1); ctx.lineTo(e.x, e.y);
        ctx.strokeStyle = color; ctx.lineWidth = 2.6; ctx.stroke();
      };
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = 'rgba(10,12,18,.55)'; ctx.lineWidth = 5; ctx.stroke();

      if (f.type === 'stationary') {
        for (let d = 0, k = 0; d < total; d += SPACING, k++) stroke(k % 2 ? WARM : COLD, d, Math.min(total, d + SPACING));
      } else {
        stroke(f.type === 'cold' ? COLD : WARM, 0, total);
      }
      let k = 0;
      for (let d = SPACING / 2; d < total - 8; d += SPACING, k++) {
        const p = at(d);
        // Symbols sit on the left of the direction of travel (see server/fronts.js);
        // with screen y pointing down that normal is (ty, -tx).
        let nx = p.ty, ny = -p.tx;
        let type = f.type;
        if (type === 'stationary') { type = k % 2 ? 'warm' : 'cold'; if (type === 'warm') { nx = -nx; ny = -ny; } }
        ctx.fillStyle = type === 'cold' ? COLD : WARM;
        ctx.beginPath();
        if (type === 'cold') {
          ctx.moveTo(p.x - p.tx * 7, p.y - p.ty * 7);
          ctx.lineTo(p.x + p.tx * 7, p.y + p.ty * 7);
          ctx.lineTo(p.x + nx * 10, p.y + ny * 10);
        } else {
          const ang = Math.atan2(ny, nx);
          ctx.arc(p.x, p.y, 6.5, ang - Math.PI / 2, ang + Math.PI / 2);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawGrid(ctx) {
    const { field, def } = this.grid;
    if (!field) return;
    const spacing = this.view.w < 700 ? 23 : 28;
    ctx.save();
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Anchor the lattice to the map so the values don't jump while panning.
    const origin = this.map.containerPointToLayerPoint([0, 0]);
    const ox = ((-origin.x % spacing) + spacing) % spacing, oy = ((-origin.y % spacing) + spacing) % spacing;
    for (let y = oy + spacing / 2; y < this.view.h; y += spacing) {
      for (let x = ox + spacing / 2; x < this.view.w; x += spacing) {
        const [lon, lat] = this._lonLat(x, y);
        const [a0, b0] = field.parts[0].projector.toGrid(lon, lat);
        const [a1, b1] = field.parts[1] ? field.parts[1].projector.toGrid(lon, lat) : [0, 0];
        const v = sampleParts(field.parts, 'v', a0, b0, a1, b1);
        if (!Number.isFinite(v)) continue;
        const text = v.toFixed(Math.abs(v) >= 100 || def.digits === 0 ? 0 : 1);
        ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(10,12,18,.85)';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
  }

  // ---- particles ----
  _seedParticles() {
    if (!this.view || !this.view.w) return;
    const density = this.particleMode === 'waves' ? 1700 : 320;
    const count = Math.min(5000, Math.round(this.view.w * this.view.h / density));
    this.particles = Array.from({ length: count }, () => this._newParticle(true));
    this._clearParticles();
  }

  _newParticle(randomAge) {
    const life = this.particleMode === 'waves' ? 70 + Math.random() * 90 : 90;
    return { x: Math.random() * this.view.w, y: Math.random() * this.view.h, age: randomAge ? Math.floor(Math.random() * life) : 0, life };
  }

  _clearParticles() {
    const ctx = this.particleCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.particleCanvas.width, this.particleCanvas.height);
  }

  _sampleAt(x, y, g, name) {
    const c = Math.floor(x / STEP), r = Math.floor(y / STEP);
    const g0 = g[0];
    if (c < 0 || r < 0 || c >= g0.cw || r >= g0.ch) return NaN;
    const k = r * g0.cw + c;
    return sampleParts(this.vectorField.parts, name, g0.gi[k], g0.gj[k], g[1] ? g[1].gi[k] : 0, g[1] ? g[1].gj[k] : 0);
  }

  _frame(ts) {
    requestAnimationFrame(this._frame);
    if (this.moving || !this.view?.w || !this.vectorField || !this.showParticles) {
      if (!this.showParticles && this._hadParticles) { this._clearParticles(); this._hadParticles = false; }
      return;
    }
    if (this._last && ts - this._last < 30) return; // ~33 fps is plenty
    this._last = ts;
    this._hadParticles = true;
    const g = this._partIndices(this.vectorField);
    if (this.particleMode === 'waves') this._frameWaves(g); else this._frameWind(g);
  }

  _frameWind(g) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.particleCanvas.getContext('2d');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, this.particleCanvas.width, this.particleCanvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    ctx.lineWidth = 1.05 * dpr;
    const speedFactor = 0.055 * Math.pow(1.45, this.map.getZoom() - 6);
    const [un, vn] = this.vectorNames;
    ctx.beginPath();
    for (const p of this.particles) {
      if (p.age++ > p.life) { Object.assign(p, this._newParticle()); continue; }
      const u = this._sampleAt(p.x, p.y, g, un);
      if (Number.isNaN(u)) { Object.assign(p, this._newParticle(true)); continue; }
      const v = this._sampleAt(p.x, p.y, g, vn);
      const nx = p.x + u * speedFactor, ny = p.y - v * speedFactor;
      ctx.moveTo(p.x * dpr, p.y * dpr);
      ctx.lineTo(nx * dpr, ny * dpr);
      p.x = nx; p.y = ny;
      if (nx < 0 || ny < 0 || nx > this.view.w || ny > this.view.h) Object.assign(p, this._newParticle());
    }
    ctx.stroke();
  }

  // Wave crests: short arcs perpendicular to the propagation direction that drift
  // along it and fade in and out; size and speed grow with wave height.
  _frameWaves(g) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.particleCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.particleCanvas.width, this.particleCanvas.height);
    const zoom = this.map.getZoom();
    const zoomScale = Math.min(1.15, Math.pow(1.25, zoom - 7));
    const speedScale = Math.pow(1.4, zoom - 7);
    const [un, vn] = this.vectorNames;
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      if (p.age++ > p.life) { Object.assign(p, this._newParticle()); continue; }
      const u = this._sampleAt(p.x, p.y, g, un);
      if (Number.isNaN(u)) { Object.assign(p, this._newParticle(true)); continue; }
      const v = this._sampleAt(p.x, p.y, g, vn);
      const h = Math.max(0, this._sampleAt(p.x, p.y, g, 'v')) || 0;
      const len = Math.hypot(u, v) || 1;
      const dx = u / len, dy = -v / len; // screen direction of travel
      const speed = (0.18 + 0.16 * Math.min(h, 5)) * speedScale;
      p.x += dx * speed; p.y += dy * speed;
      const half = (4 + 3.5 * Math.min(h, 4)) * zoomScale;
      const qx = -dy, qy = dx;
      const a = Math.sin(Math.PI * p.age / p.life);
      ctx.strokeStyle = `rgba(255,255,255,${(0.2 + 0.65 * a).toFixed(3)})`;
      ctx.lineWidth = (1 + Math.min(h, 3) * 0.35) * dpr;
      ctx.beginPath();
      ctx.moveTo((p.x - qx * half - dx * half * 0.35) * dpr, (p.y - qy * half - dy * half * 0.35) * dpr);
      ctx.quadraticCurveTo((p.x + dx * half * 0.3) * dpr, (p.y + dy * half * 0.3) * dpr, (p.x + qx * half - dx * half * 0.35) * dpr, (p.y + qy * half - dy * half * 0.35) * dpr);
      ctx.stroke();
      if (p.x < 0 || p.y < 0 || p.x > this.view.w || p.y > this.view.h) Object.assign(p, this._newParticle());
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
