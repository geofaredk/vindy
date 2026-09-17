// Coastlines and national borders drawn on one canvas above the weather data: dark lines
// with a soft shadow cast onto the water side, so land stands out on any colour scale.
// Coast lines must be oriented with water on the left (see tools/build_coast_tiles.py).

const PAD = 0.3; // extra canvas around the view so panning doesn't show empty edges
const SHADOW = { offset: 2, width: 2.5, blur: 5, color: 'rgba(0, 0, 0, 0.42)' };
// Drawn in this order, so the coastline ends up on top. minZoom keeps the finer detail
// out of the way until the map is zoomed in.
const KINDS = [
  { name: 'municipalities', width: 0.7, color: 'rgba(8, 10, 16, 0.35)', minZoom: 9 },
  { name: 'regions', width: 1, color: 'rgba(8, 10, 16, 0.45)', dash: [5, 4], minZoom: 7 },
  { name: 'borders', width: 1, color: 'rgba(8, 10, 16, 0.5)', dash: [4, 3] },
  { name: 'coast', width: 1, color: 'rgba(8, 10, 16, 0.6)' },
];

export class CoastLayer extends L.Layer {
  constructor(options = {}) {
    super();
    this.pane = options.pane || 'overlayPane';
    this.sets = new Map(); // id -> { coast, borders } with lines as [[lon, lat], ...]
    this.projected = new Map(); // `${id}|${zoom}` -> projected lines with bounding boxes
  }

  setData(id, data) {
    this.sets.set(id, data);
    this._schedule();
  }

  removeData(id) {
    if (!this.sets.delete(id)) return;
    for (const key of this.projected.keys()) if (key.startsWith(`${id}|`)) this.projected.delete(key);
    this._schedule();
  }

  hasData(id) { return this.sets.has(id); }

  onAdd(map) {
    this.canvas = L.DomUtil.create('canvas', 'coast-canvas leaflet-zoom-animated');
    this.canvas.style.pointerEvents = 'none';
    map.getPane(this.pane).appendChild(this.canvas);
    map.on('moveend zoomend viewreset resize', this._schedule, this);
    map.on('zoomanim', this._animateZoom, this);
    this._redraw();
  }

  onRemove(map) {
    map.off('moveend zoomend viewreset resize', this._schedule, this);
    map.off('zoomanim', this._animateZoom, this);
    this.canvas.remove();
  }

  _schedule() {
    if (this._frame || !this._map) return;
    this._frame = requestAnimationFrame(() => { this._frame = null; this._redraw(); });
  }

  // Scale and shift the last drawing along with Leaflet's zoom animation (as L.Renderer does).
  _animateZoom(e) {
    const map = this._map;
    const scale = map.getZoomScale(e.zoom, this._zoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + PAD);
    const offset = viewHalf.multiplyBy(-scale).add(map.project(this._center, e.zoom)).subtract(map._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  _lines(id, kind, zoom) {
    const key = `${id}|${zoom}`;
    let p = this.projected.get(key);
    if (!p) {
      const project = lines => lines.map(line => {
        const xy = new Float64Array(line.length * 2);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        line.forEach(([lon, lat], k) => {
          const pt = this._map.project([lat, lon], zoom);
          xy[2 * k] = pt.x; xy[2 * k + 1] = pt.y;
          if (pt.x < x0) x0 = pt.x; if (pt.x > x1) x1 = pt.x;
          if (pt.y < y0) y0 = pt.y; if (pt.y > y1) y1 = pt.y;
        });
        return { xy, x0, y0, x1, y1 };
      });
      const data = this.sets.get(id);
      p = Object.fromEntries(KINDS.map(k => [k.name, project(data[k.name] || [])]));
      this.projected.set(key, p);
    }
    return p[kind];
  }

  _redraw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(size.x * (1 + 2 * PAD)), h = Math.round(size.y * (1 + 2 * PAD));
    const c = this.canvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    this._center = map.getCenter();
    this._zoom = map.getZoom();
    const topLeft = map.containerPointToLayerPoint([-size.x * PAD, -size.y * PAD]).round();
    L.DomUtil.setPosition(c, topLeft);
    // World pixel of the canvas' top-left corner.
    const ox = topLeft.x + map.getPixelOrigin().x, oy = topLeft.y + map.getPixelOrigin().y;
    const zoom = this._zoom;

    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const inView = kind => {
      const out = [];
      for (const id of this.sets.keys()) {
        for (const l of this._lines(id, kind, zoom)) {
          if (l.x1 < ox || l.y1 < oy || l.x0 > ox + w || l.y0 > oy + h) continue;
          out.push(l);
        }
      }
      return out;
    };

    const coastLines = inView('coast');
    // Shadow: the coastline shifted a little towards the water, blurred. Drawn far off-canvas
    // with a matching shadow offset so only the blurred shadow lands in view.
    const FAR = 10000;
    ctx.save();
    ctx.shadowColor = SHADOW.color;
    ctx.shadowBlur = SHADOW.blur * dpr;
    ctx.shadowOffsetX = FAR * dpr;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = SHADOW.width;
    ctx.beginPath();
    for (const l of coastLines) this._offsetPath(ctx, l.xy, ox + FAR, oy, SHADOW.offset);
    ctx.stroke();
    ctx.restore();

    for (const kind of KINDS) {
      if (kind.minZoom && zoom < kind.minZoom) continue;
      const lines = kind.name === 'coast' ? coastLines : inView(kind.name);
      if (!lines.length) continue;
      ctx.strokeStyle = kind.color;
      ctx.lineWidth = kind.width;
      ctx.setLineDash(kind.dash || []);
      ctx.beginPath();
      for (const l of lines) this._path(ctx, l.xy, ox, oy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _path(ctx, xy, ox, oy) {
    ctx.moveTo(xy[0] - ox, xy[1] - oy);
    for (let k = 2; k < xy.length; k += 2) ctx.lineTo(xy[k] - ox, xy[k + 1] - oy);
  }

  // Path shifted perpendicular to the left of travel in map coordinates (north up), which
  // is the water side. In screen coordinates (y down) that normal is (dy, -dx).
  _offsetPath(ctx, xy, ox, oy, d) {
    const n = xy.length / 2;
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
      const dx = xy[2 * b] - xy[2 * a], dy = xy[2 * b + 1] - xy[2 * a + 1];
      const len = Math.hypot(dx, dy) || 1;
      const x = xy[2 * k] - ox + (dy / len) * d, y = xy[2 * k + 1] - oy - (dx / len) * d;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
}
