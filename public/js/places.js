// A small gazetteer of Danish towns, used to name clicked points and for search.
export const PLACES = [
  ['København', 55.676, 12.568], ['Aarhus', 56.157, 10.211], ['Odense', 55.403, 10.402], ['Aalborg', 57.048, 9.919],
  ['Esbjerg', 55.476, 8.459], ['Randers', 56.461, 10.036], ['Kolding', 55.491, 9.472], ['Horsens', 55.861, 9.850],
  ['Vejle', 55.709, 9.536], ['Roskilde', 55.642, 12.080], ['Herning', 56.139, 8.974], ['Helsingør', 56.036, 12.614],
  ['Silkeborg', 56.170, 9.545], ['Næstved', 55.230, 11.760], ['Fredericia', 55.566, 9.753], ['Viborg', 56.453, 9.402],
  ['Køge', 55.458, 12.182], ['Holstebro', 56.360, 8.616], ['Taastrup', 55.650, 12.300], ['Slagelse', 55.403, 11.354],
  ['Hillerød', 55.927, 12.300], ['Sønderborg', 54.909, 9.792], ['Svendborg', 55.060, 10.607], ['Hjørring', 57.464, 9.982],
  ['Holbæk', 55.717, 11.713], ['Frederikshavn', 57.441, 10.537], ['Nørresundby', 57.058, 9.923], ['Ringsted', 55.443, 11.790],
  ['Haderslev', 55.249, 9.488], ['Skive', 56.567, 9.028], ['Nykøbing Falster', 54.769, 11.874], ['Skagen', 57.721, 10.584],
  ['Thisted', 56.957, 8.694], ['Ribe', 55.328, 8.762], ['Tønder', 54.933, 8.867], ['Rønne', 55.100, 14.706],
  ['Nexø', 55.060, 15.130], ['Grenaa', 56.416, 10.879], ['Ebeltoft', 56.194, 10.682], ['Hvide Sande', 56.004, 8.129],
  ['Ringkøbing', 56.090, 8.244], ['Lemvig', 56.549, 8.310], ['Hanstholm', 57.119, 8.620], ['Klitmøller', 57.037, 8.506],
  ['Løkken', 57.370, 9.713], ['Blåvand', 55.558, 8.083], ['Fanø', 55.420, 8.410], ['Rømø', 55.137, 8.557],
  ['Kalundborg', 55.681, 11.089], ['Nakskov', 54.831, 11.136], ['Nyborg', 55.312, 10.790], ['Middelfart', 55.506, 9.730],
  ['Faaborg', 55.095, 10.242], ['Ærøskøbing', 54.888, 10.412], ['Samsø', 55.870, 10.610], ['Læsø', 57.260, 11.000],
  ['Anholt', 56.705, 11.555], ['Mariager', 56.649, 9.975], ['Aabenraa', 55.044, 9.418], ['Vordingborg', 55.009, 11.911],
  ['Stege', 54.987, 12.286], ['Gedser', 54.575, 11.926], ['Odsherred', 55.880, 11.600], ['Hundested', 55.964, 11.853],
  ['Gilleleje', 56.121, 12.311], ['Dragør', 55.593, 12.672], ['Brøndby', 55.650, 12.420], ['Lyngby', 55.771, 12.503],
];

const dist = (lat1, lon1, lat2, lon2) => {
  const x = (lon2 - lon1) * Math.cos((lat1 + lat2) * Math.PI / 360);
  return Math.hypot(x, lat2 - lat1) * 111.2;
};

export function placeName(lat, lon) {
  let best = null, bd = Infinity;
  for (const [n, la, lo] of PLACES) { const d = dist(lat, lon, la, lo); if (d < bd) { bd = d; best = n; } }
  if (bd < 4) return { title: best, sub: 'Danmark' };
  if (lat > 57.9 || lat < 54.4 || lon < 7.5 || lon > 15.5) return { title: 'Valgt punkt', sub: `${Math.round(bd)} km fra ${best}` };
  if (bd < 40) return { title: `${Math.round(bd)} km fra ${best}`, sub: 'Danmark' };
  return { title: 'Valgt punkt', sub: `nærmeste by: ${best}` };
}

export function searchPlaces(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return PLACES.filter(([n]) => n.toLowerCase().includes(q)).slice(0, 7);
}
