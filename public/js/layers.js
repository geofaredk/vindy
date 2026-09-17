// Layer definitions and colour scales.

const WIND = [
  [0, [98, 113, 183]], [1, [57, 97, 159]], [3, [74, 148, 169]], [5, [77, 141, 123]], [7, [83, 165, 83]],
  [9, [53, 159, 53]], [11, [167, 157, 81]], [13, [159, 127, 58]], [15, [161, 108, 92]], [17, [129, 58, 78]],
  [19, [175, 80, 136]], [21, [117, 74, 147]], [24, [109, 97, 163]], [27, [68, 105, 141]], [29, [92, 144, 152]],
  [36, [125, 68, 165]],
];
const TEMP = [
  [-25, [120, 60, 150]], [-15, [95, 90, 200]], [-8, [60, 130, 220]], [-3, [70, 175, 225]], [0, [110, 205, 225]],
  [3, [100, 200, 170]], [7, [110, 195, 110]], [11, [175, 205, 85]], [15, [235, 205, 75]], [19, [240, 160, 60]],
  [23, [230, 110, 55]], [27, [205, 60, 65]], [32, [160, 35, 85]], [38, [100, 20, 70]],
];
const RAIN = [
  [0, [60, 70, 90, 0]], [0.1, [120, 170, 230, 90]], [0.4, [90, 150, 235, 170]], [1, [55, 115, 220, 200]],
  [2, [40, 175, 110, 215]], [4, [225, 210, 60, 230]], [7, [240, 140, 40, 240]], [10, [225, 60, 45, 245]],
  [20, [175, 30, 140, 250]], [40, [250, 230, 255, 255]],
];
const RAIN_ACC = [
  [0, [60, 70, 90, 0]], [0.3, [120, 170, 230, 90]], [1, [90, 150, 235, 170]], [2, [55, 115, 220, 200]],
  [5, [40, 175, 110, 215]], [10, [150, 205, 60, 225]], [15, [225, 210, 60, 235]], [25, [240, 140, 40, 240]],
  [40, [225, 60, 45, 245]], [60, [175, 30, 140, 250]], [100, [250, 230, 255, 255]],
];
const CLOUDS = [
  [0, [40, 70, 115]], [20, [70, 95, 130]], [50, [120, 135, 155]], [80, [180, 188, 198]], [100, [228, 232, 238]],
];
const PRESSURE = [
  [970, [120, 50, 140]], [985, [70, 80, 185]], [995, [55, 135, 200]], [1003, [60, 165, 165]], [1009, [85, 170, 110]],
  [1015, [150, 180, 80]], [1021, [210, 185, 70]], [1028, [220, 135, 60]], [1040, [185, 60, 70]],
];
const HUMIDITY = [
  [0, [160, 100, 50]], [30, [190, 150, 80]], [50, [150, 175, 110]], [70, [80, 160, 160]], [85, [60, 120, 190]], [100, [45, 70, 170]],
];
const VIS = [
  [0, [230, 230, 240]], [0.5, [190, 170, 215]], [1, [150, 120, 190]], [3, [110, 110, 170]], [8, [70, 100, 140]], [20, [45, 80, 110]], [50, [35, 60, 90]],
];
const CAPE = [
  [0, [40, 50, 70, 0]], [50, [70, 110, 160, 100]], [200, [80, 170, 120, 170]], [500, [220, 210, 70, 210]],
  [1000, [240, 140, 40, 230]], [2000, [220, 50, 50, 245]], [3500, [180, 40, 170, 255]],
];
const WAVES = [
  [0, [40, 70, 130]], [0.3, [50, 110, 170]], [0.7, [60, 160, 180]], [1.2, [90, 185, 120]], [2, [215, 200, 70]],
  [3, [235, 130, 50]], [4.5, [215, 55, 60]], [7, [160, 50, 160]],
];
const RADAR = [
  [7, [90, 160, 255]], [12, [60, 130, 245]], [18, [30, 170, 200]], [23, [40, 190, 90]], [28, [150, 210, 40]],
  [33, [250, 225, 40]], [38, [255, 160, 30]], [43, [245, 70, 40]], [48, [205, 25, 90]], [53, [190, 60, 200]], [60, [255, 230, 255]],
];

export const LAYERS = {
  // Combined view: temperature forecast with the observed radar composite on top.
  overview: { name: 'Oversigt', group: 'combined', base: 'temp', radar: true, unit: '°C', scale: TEMP, icon: 'overview', digits: 1, ticks: [-10, -5, 0, 5, 10, 15, 20, 25, 30] },
  wind: { name: 'Vind', group: 'forecast', unit: 'm/s', scale: WIND, vector: true, icon: 'wind', digits: 1, ticks: [0, 5, 10, 15, 20, 25, 30] },
  gust: { name: 'Vindstød', group: 'forecast', unit: 'm/s', scale: WIND, icon: 'gust', digits: 1, ticks: [0, 5, 10, 15, 20, 25, 30] },
  rain: { name: 'Regn', group: 'forecast', unit: 'mm/t', scale: RAIN, icon: 'rain', digits: 1, ticks: [0.1, 1, 2, 4, 7, 10, 20], log: true },
  // Accumulated between two hours chosen with the range handles on the timeline.
  rainacc: { name: 'Regn akkumuleret', group: 'forecast', unit: 'mm', scale: RAIN_ACC, icon: 'rainacc', digits: 1, ticks: [1, 2, 5, 10, 25, 50, 100], log: true, range: true },
  temp: { name: 'Temperatur', group: 'forecast', unit: '°C', scale: TEMP, icon: 'temp', digits: 1, ticks: [-10, -5, 0, 5, 10, 15, 20, 25, 30] },
  dewpoint: { name: 'Dugpunkt', group: 'forecast', unit: '°C', scale: TEMP, icon: 'dew', digits: 1, ticks: [-10, -5, 0, 5, 10, 15, 20, 25] },
  clouds: { name: 'Skydække', group: 'forecast', unit: '%', scale: CLOUDS, icon: 'cloud', digits: 0, ticks: [0, 25, 50, 75, 100] },
  lowclouds: { name: 'Lave skyer', group: 'forecast', unit: '%', scale: CLOUDS, icon: 'lowcloud', digits: 0, ticks: [0, 25, 50, 75, 100] },
  pressure: { name: 'Lufttryk', group: 'forecast', unit: 'hPa', scale: PRESSURE, icon: 'pressure', digits: 1, ticks: [980, 995, 1005, 1015, 1025, 1035], isobars: true },
  humidity: { name: 'Luftfugtighed', group: 'forecast', unit: '%', scale: HUMIDITY, icon: 'humidity', digits: 0, ticks: [20, 40, 60, 80, 100] },
  visibility: { name: 'Sigtbarhed', group: 'forecast', unit: 'km', scale: VIS, icon: 'fog', digits: 1, ticks: [0.5, 1, 3, 8, 20, 50], log: true },
  cape: { name: 'Tordenvejr (CAPE)', group: 'forecast', unit: 'J/kg', scale: CAPE, icon: 'storm', digits: 0, ticks: [50, 200, 500, 1000, 2000, 3500], log: true },
  waves: { name: 'Bølger', group: 'forecast', unit: 'm', scale: WAVES, icon: 'waves', digits: 1, ticks: [0, 0.5, 1, 2, 3, 5] },
  satellite: { name: 'Satellit', group: 'observed', observed: true, icon: 'satellite', noLegend: true },
  radar: { name: 'Radar', group: 'observed', observed: true, unit: 'dBZ', scale: RADAR, icon: 'radar', digits: 0, ticks: [10, 20, 30, 40, 50, 60] },
};

// Build a 1024-entry RGBA lookup table over the scale's domain.
export function buildLut(layer) {
  const stops = layer.scale;
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  const tf = layer.log ? v => Math.log1p(Math.max(0, v)) : v => v;
  const tlo = tf(lo), thi = tf(hi);
  const N = 1024, lut = new Uint8ClampedArray(N * 4);
  for (let k = 0; k < N; k++) {
    const t = tlo + (thi - tlo) * k / (N - 1);
    let i = 0;
    while (i < stops.length - 2 && t > tf(stops[i + 1][0])) i++;
    const a = stops[i], b = stops[i + 1];
    const f = Math.max(0, Math.min(1, (t - tf(a[0])) / (tf(b[0]) - tf(a[0]))));
    for (let c = 0; c < 4; c++) {
      const ca = a[1][c] ?? 255, cb = b[1][c] ?? 255;
      lut[k * 4 + c] = ca + (cb - ca) * f;
    }
  }
  return { lut, N, index: v => Math.round((tf(v) - tlo) / (thi - tlo) * (N - 1)) };
}

export function colorFor(layer, v) {
  if (!layer._lut) layer._lut = buildLut(layer);
  const { lut, N, index } = layer._lut;
  const k = Math.max(0, Math.min(N - 1, index(v))) * 4;
  return `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
}

export const ICONS = {
  wind: '<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>',
  gust: '<path d="M3 7h9a2.5 2.5 0 1 0-2.5-2.5M3 11h14a3 3 0 1 1-3 3M3 15h6M13 18l2 3M17 17l2 3"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 7a4 4 0 0 1 1 8"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  rainacc: '<path d="M7 13a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 5a3.5 3.5 0 0 1 .5 7"/><path d="M6 16h12M6 20h12M9 16v4M15 16v4"/>',
  temp: '<path d="M10 14V4a2 2 0 1 1 4 0v10a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  dew: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.7-9.95A6.5 6.5 0 0 1 19 9a4.5 4.5 0 0 1-.5 9z"/>',
  lowcloud: '<path d="M7 14a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 6a3.5 3.5 0 0 1-.5 8z"/><path d="M3 18h18M5 21h14"/>',
  pressure: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-4M8 16h8"/>',
  humidity: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/><path d="M9 15l6-4M9.5 11.5h.01M14.5 15.5h.01"/>',
  fog: '<path d="M4 8h16M3 12h18M5 16h14M7 20h10"/>',
  storm: '<path d="M7 14a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 6a3.5 3.5 0 0 1-.5 8"/><path d="M13 12l-3 5h4l-3 5"/>',
  waves: '<path d="M2 10c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1"/>',
  satellite: '<path d="M13 7l4-4 4 4-4 4zM7 13l-4 4 4 4 4-4zM9 9l6 6M8.5 15.5l7-7"/><path d="M16 16a5 5 0 0 1-3 3"/>',
  legend: '<rect x="3" y="9" width="18" height="6" rx="2"/><path d="M7 9v6M11 9v6M15 9v6M5 19h2M11 19h2M17 19h2"/>',
  hideui: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.8M6.1 6.1C3.9 7.6 2.6 9.8 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 5-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  overview: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  particles: '<path d="M3 7c4-2 8 2 12 0M5 12c4-2 8 2 14 0M3 17c4-2 8 2 12 0"/>',
  values: '<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  grid: '<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>',
  fronts: '<path d="M3 17c4 0 5-10 9-10s5 10 9 10"/><path d="M6 12.5l2.5-1.5.3 2.8zM16.5 10.5a1.8 1.8 0 0 1 3 1.8"/>',
  stations: '<path d="M12 21s-7-6.5-7-12a7 7 0 1 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  isobars: '<path d="M3 16c3-6 6-8 9-8s6 2 9 8M6 20c2-4 4-6 6-6s4 2 6 6"/>',
};

export const icon = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
