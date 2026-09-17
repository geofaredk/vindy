// EUMETSAT EUMETView (MTG-I FCI, 0° full disk) true-colour RGB. The images are
// fetched by the browser straight from EUMETView's WMS; the server only works out
// which 10-minute time steps are available from the WMS capabilities.
import { once } from './util.js';

export const SAT_WMS = 'https://view.eumetsat.int/geoserver/ows';
export const SAT_LAYER = 'mtg_fd:rgb_truecolour';
const CAPS = 'https://view.eumetsat.int/geoserver/mtg_fd/rgb_truecolour/ows?service=WMS&request=GetCapabilities&version=1.3.0';
const WINDOW_H = 3;

let cache = null, cachedAt = 0;

export async function satelliteFrames() {
  if (cache && Date.now() - cachedAt < 2 * 60e3) return cache;
  return once('sat-frames', async () => {
    const res = await fetch(CAPS, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`EUMETView HTTP ${res.status}`);
    const xml = await res.text();
    const dim = xml.match(/<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/);
    if (!dim) throw new Error('Ingen tidsdimension i EUMETView-lag');
    const [, end, period] = dim[1].trim().split('/');
    const stepMin = Number((period || 'PT10M').match(/PT(\d+)M/)?.[1] || 10);
    const last = Date.parse(end);
    const frames = [];
    for (let t = last - WINDOW_H * 3600e3; t <= last; t += stepMin * 60e3) {
      const iso = new Date(t).toISOString().replace('.000Z', 'Z');
      frames.push({ id: iso, time: iso });
    }
    cache = { wms: SAT_WMS, layer: SAT_LAYER, source: 'EUMETSAT EUMETView · MTG-I FCI True Colour RGB', frames };
    cachedAt = Date.now();
    return cache;
  });
}
