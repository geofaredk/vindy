// EUMETView satellite imagery as a single WMS image covering the current view.
// Frames for the view are preloaded so animating the timeline doesn't flicker.
const L = window.L;

const mercX = lon => lon * 20037508.34 / 180;
const mercY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI;

export class SatelliteView {
  constructor(map, { pane }) {
    this.map = map;
    this.pane = pane;
    this.overlay = null;
    this.meta = null; // { wms, layer, frames }
    this.time = null;
    this.active = false;
    this.cache = new Map(); // url -> Promise<url>
    this.viewKey = null;
    map.on('moveend', () => { if (this.active) this._render(true); });
  }

  setMeta(meta) { this.meta = meta; }

  // Resolves once the image for `time` is on the map (used by the animation export).
  show(time) {
    this.active = true;
    this.time = time;
    return this._render(false);
  }

  hide() {
    this.active = false;
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
  }

  // Current view, padded, in Web Mercator.
  _view() {
    const b = this.map.getBounds().pad(0.15);
    const size = this.map.getSize();
    const scale = Math.min(1, 2048 / Math.max(size.x * 1.3, size.y * 1.3));
    const south = Math.max(-70, b.getSouth()), north = Math.min(70, b.getNorth());
    return {
      bounds: L.latLngBounds([south, b.getWest()], [north, b.getEast()]),
      bbox: [mercX(b.getWest()), mercY(south), mercX(b.getEast()), mercY(north)].map(v => v.toFixed(0)).join(','),
      width: Math.round(size.x * 1.3 * scale),
      height: Math.round(size.x * 1.3 * scale * (mercY(north) - mercY(south)) / (mercX(b.getEast()) - mercX(b.getWest()))),
    };
  }

  _url(view, time) {
    const q = new URLSearchParams({
      service: 'WMS', version: '1.3.0', request: 'GetMap', layers: this.meta.layer, styles: '',
      format: 'image/jpeg', crs: 'EPSG:3857', bbox: view.bbox, width: view.width, height: view.height, time,
    });
    return `${this.meta.wms}?${q}`;
  }

  _load(url) {
    if (!this.cache.has(url)) {
      const p = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => reject(new Error('Satellitbillede kunne ikke hentes'));
        img.crossOrigin = 'anonymous'; // lets the map export draw it into a canvas
        img.src = url;
      });
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
      if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(url);
  }

  async _render(viewChanged) {
    if (!this.meta || !this.time) return;
    const view = this._view();
    const url = this._url(view, this.time);
    const time = this.time;
    try {
      await this._load(url);
    } catch { return; }
    if (!this.active || this.time !== time) return;
    if (!this.overlay) {
      this.overlay = L.imageOverlay(url, view.bounds, { pane: this.pane, className: 'sat-img', crossOrigin: 'anonymous' }).addTo(this.map);
    } else {
      this.overlay.setUrl(url);
      this.overlay.setBounds(view.bounds);
    }
    if (viewChanged || this.viewKey !== view.bbox) {
      this.viewKey = view.bbox;
      this._preload(view);
    }
  }

  // Warm all frames for this view, newest first, two at a time.
  async _preload(view) {
    const key = view.bbox;
    const queue = [...this.meta.frames].reverse().map(f => this._url(view, f.time));
    await Promise.all([0, 1].map(async () => {
      while (queue.length && this.active && this.viewKey === key) await this._load(queue.shift()).catch(() => {});
    }));
  }
}
