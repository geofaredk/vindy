// Location search: Danish official place names and addresses (Dataforsyningen / DAWA),
// supplemented by OpenStreetMap Photon for places outside Denmark.
import { Lru } from './util.js';

const cache = new Lru(500);
const UA = { 'User-Agent': 'Vindy weather map' };

async function json(url, timeout = 5000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const TYPE_NAME = { spredtBebyggelse: 'spredt bebyggelse', privatskoleFriskole: 'privatskole', kraftvarmeværk: 'kraftvarmeværk' };
const OSM_TYPE = { city: 'by', town: 'by', village: 'landsby', hamlet: 'bebyggelse', suburb: 'bydel', sea: 'hav', island: 'ø', beach: 'strand', harbour: 'havn', peak: 'bjerg', lake: 'sø', river: 'å', forest: 'skov', airport: 'lufthavn', station: 'station', school: 'skole', hotel: 'hotel' };
const TYPE_RANK = { by: 0, bydel: 1, landsby: 1, ø: 2, 'øgruppe': 2, havn: 3, strand: 3 };

async function danishPlaces(q) {
  const d = await json(`https://api.dataforsyningen.dk/stednavne2?q=${encodeURIComponent(q)}*&per_side=25`);
  return d
    .filter(x => x.sted?.visueltcenter)
    .map(x => ({
      name: x.navn,
      detail: [TYPE_NAME[x.sted.undertype] || x.sted.undertype, x.sted.kommuner?.[0]?.navn && `${x.sted.kommuner[0].navn} Kommune`].filter(Boolean).join(' · '),
      lon: x.sted.visueltcenter[0], lat: x.sted.visueltcenter[1],
      rank: (x.navn.toLowerCase() === q.toLowerCase() ? -5 : 0) + (TYPE_RANK[x.sted.undertype] ?? (x.sted.hovedtype === 'Bebyggelse' ? 1 : 6)),
      kind: x.sted.hovedtype === 'Bebyggelse' ? 'town' : 'place',
    }));
}

async function danishAddresses(q) {
  const d = await json(`https://api.dataforsyningen.dk/autocomplete?q=${encodeURIComponent(q)}&type=adresse&per_side=6`);
  return d.filter(x => x.data?.x).map(x => ({ name: x.tekst, detail: 'Adresse', lon: x.data.x, lat: x.data.y, rank: 2, kind: 'address' }));
}

async function photon(q) {
  const d = await json(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&bbox=-8,47,31,66&lat=56&lon=10.5`);
  return d.features.map(f => {
    const p = f.properties;
    return {
      name: p.name || p.street || q,
      detail: [OSM_TYPE[p.osm_value], p.city && p.city !== p.name ? p.city : null, p.country].filter(Boolean).join(' · '),
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      rank: (p.countrycode === 'DK' ? 4 : 7) + (['city', 'town', 'village'].includes(p.osm_value) ? -2 : 0),
      kind: ['city', 'town', 'village', 'hamlet', 'suburb'].includes(p.osm_value) ? 'town' : 'place',
    };
  });
}

export async function geocode(q) {
  q = (q || '').trim().slice(0, 100);
  if (q.length < 2) return [];
  const hit = cache.get(q.toLowerCase());
  if (hit) return hit;
  const tasks = [danishPlaces(q), photon(q)];
  if (/\d/.test(q)) tasks.push(danishAddresses(q));
  const settled = await Promise.allSettled(tasks);
  const all = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  all.sort((a, b) => a.rank - b.rank);
  const out = [];
  for (const r of all) {
    // Drop near-duplicates (same name within ~3 km).
    if (out.some(o => (o.name.toLowerCase() === r.name.toLowerCase() && Math.abs(o.lat - r.lat) < 0.03 && Math.abs(o.lon - r.lon) < 0.05)
      || (o.kind === 'address' && r.kind === 'address' && Math.abs(o.lat - r.lat) < 0.0002 && Math.abs(o.lon - r.lon) < 0.0003))) continue;
    out.push({ name: r.name, detail: r.detail, lat: Math.round(r.lat * 1e5) / 1e5, lon: Math.round(r.lon * 1e5) / 1e5, kind: r.kind });
    if (out.length >= 8) break;
  }
  if (settled.some(r => r.status === 'fulfilled')) cache.set(q.toLowerCase(), out);
  return out;
}
