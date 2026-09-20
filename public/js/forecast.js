// Point forecast panel (hourly meteogram table).
import { LAYERS, colorFor } from './layers.js';
import { placeName } from './places.js';

const TZ = 'Europe/Copenhagen';
const fmtDay = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtHour = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

const COL = 44;

export function renderForecast(el, data, { onClose, onSelectTime, currentTime }) {
  const rows = data.rows;
  const name = data.name ? { title: esc(data.name), sub: placeName(data.lat, data.lon).sub } : placeName(data.lat, data.lon);
  const waves = new Map((data.waves || []).map(w => [w.time, w]));
  const hasWaves = waves.size > 0;

  // Day groups
  const days = [];
  for (const r of rows) {
    const k = dayKey.format(new Date(r.time));
    if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, label: fmtDay.format(new Date(r.time)), n: 0 });
    days[days.length - 1].n++;
  }

  const temps = rows.map(r => r.temp);
  const tmin = Math.floor(Math.min(...temps)) - 1, tmax = Math.ceil(Math.max(...temps)) + 1;
  const H = 64;
  const tx = i => i * COL + COL / 2;
  const ty = v => 8 + (H - 16) * (1 - (v - tmin) / Math.max(1, tmax - tmin));
  const path = rows.map((r, i) => `${i ? 'L' : 'M'}${tx(i).toFixed(1)},${ty(r.temp).toFixed(1)}`).join('');
  const area = `${path}L${tx(rows.length - 1)},${H}L${tx(0)},${H}Z`;
  const width = rows.length * COL;

  const maxP = Math.max(2, ...rows.map(r => r.precip));

  const cell = (content, style = '', cls = '') => `<div class="fc-cell ${cls}" style="${style}">${content}</div>`;
  const now = Date.now();

  el.innerHTML = `
    <div class="fc-head">
      <div>
        <div class="fc-title">${name.title}</div>
        <div class="fc-sub">${name.sub} · ${data.lat.toFixed(2)}°N ${data.lon.toFixed(2)}°E · ${data.source} · kørsel kl. ${fmtRun(data.run)}</div>
      </div>
      <button class="icon-btn fc-close" aria-label="Luk prognose">✕</button>
    </div>
    <div class="fc-body">
      <div class="fc-labels">
        <div class="fc-l fc-l-day"></div>
        <div class="fc-l">Kl.</div>
        <div class="fc-l fc-l-temp">Temp. °C</div>
        <div class="fc-l fc-l-rain">Regn mm/t</div>
        <div class="fc-l" title="Hvor stor en del af DMI's ensemble der giver mindst 0,1 mm regn i timen">Regnrisiko</div>
        <div class="fc-l fc-l-cloud">Skyer</div>
        <div class="fc-l">Vind m/s</div>
        <div class="fc-l">Vindstød</div>
        <div class="fc-l">Lufttryk</div>
        <div class="fc-l">Fugtighed</div>
        ${hasWaves ? '<div class="fc-l">Bølger m</div>' : ''}
      </div>
      <div class="fc-scroll">
        <div class="fc-grid" style="width:${width}px">
          <div class="fc-row fc-days">${days.map(d => `<div class="fc-day" style="width:${d.n * COL}px"><span>${d.n >= 3 ? d.label : ''}</span></div>`).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(fmtHour.format(new Date(r.time)), '', `fc-hour${r.time === currentTime ? ' is-current' : ''}${Date.parse(r.time) < now - 3600e3 ? ' is-past' : ''}" data-time="${r.time}`)).join('')}</div>
          <div class="fc-row fc-temp" style="height:${H + 18}px">
            <svg width="${width}" height="${H + 18}" class="fc-svg">
              <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f2b84b" stop-opacity=".35"/><stop offset="1" stop-color="#f2b84b" stop-opacity="0"/></linearGradient></defs>
              <path d="${area}" fill="url(#tg)"/>
              <path d="${path}" fill="none" stroke="#f2b84b" stroke-width="2"/>
              ${rows.map((r, i) => i % 3 === 0 ? `<text x="${tx(i)}" y="${Math.max(12, ty(r.temp) - 7)}" text-anchor="middle">${Math.round(r.temp)}°</text>` : '').join('')}
            </svg>
          </div>
          <div class="fc-row">${rows.map(r => cell(`<div class="fc-bar" style="height:${Math.round(22 * r.precip / maxP)}px"></div><span>${r.precip >= 0.05 ? r.precip.toFixed(1) : ''}</span>`, '', 'fc-rain')).join('')}</div>
          <div class="fc-row fc-probs">${rows.map(r => cell('', '', `fc-prob" data-time="${r.time}`)).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(cloudIcon(r.clouds, r.precip, r.time), '', 'fc-cloud')).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(`<span class="arrow" style="transform:rotate(${r.dir + 180}deg)">↑</span>${r.wind.toFixed(0)}`, `background:${colorFor(LAYERS.wind, r.wind)}`, 'fc-wind')).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(r.gust != null && Number.isFinite(r.gust) ? r.gust.toFixed(0) : '–', r.gust ? `color:${colorFor(LAYERS.gust, r.gust + 6)}` : '', 'fc-gust')).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(Math.round(r.pressure), '', 'fc-small')).join('')}</div>
          <div class="fc-row">${rows.map(r => cell(`${Math.round(r.rh)}%`, '', 'fc-small')).join('')}</div>
          ${hasWaves ? `<div class="fc-row">${rows.map(r => { const w = waves.get(r.time); return cell(w ? `<span class="arrow" style="transform:rotate(${w.dir + 180}deg)">↑</span>${w.height.toFixed(1)}` : '', w ? `background:${colorFor(LAYERS.waves, w.height)}` : '', 'fc-wind'); }).join('')}</div>` : ''}
        </div>
      </div>
    </div>`;

  el.querySelector('.fc-close').onclick = onClose;
  el.querySelectorAll('.fc-hour').forEach(h => h.onclick = () => onSelectTime(h.dataset.time));
  const scroller = el.querySelector('.fc-scroll');
  const idx = Math.max(0, rows.findIndex(r => Date.parse(r.time) >= now - 3600e3));
  scroller.scrollLeft = Math.max(0, idx * COL - COL);
}

// The rain probability comes from the ensemble, which is read a grid cell at a time and
// arrives after the meteogram is already on screen. Fill in the row it left empty.
export function setRainProb(el, rows) {
  const by = new Map(rows.map(r => [r.time, r.prob]));
  for (const cell of el.querySelectorAll('.fc-prob')) {
    const p = by.get(cell.dataset.time);
    if (p == null) { cell.textContent = ''; continue; }
    cell.textContent = `${Math.round(p / 5) * 5}%`;
    cell.style.opacity = (0.3 + 0.7 * p / 100).toFixed(2);
  }
  el.querySelector('.fc-probs')?.classList.add('is-ready');
}

export function renderForecastLoading(el, lat, lon, error, title) {
  const name = title ? { title: esc(title) } : placeName(lat, lon);
  el.innerHTML = `<div class="fc-head"><div><div class="fc-title">${name.title}</div><div class="fc-sub">${lat.toFixed(2)}°N ${lon.toFixed(2)}°E</div></div><button class="icon-btn fc-close" aria-label="Luk prognose">✕</button></div>
  <div class="fc-loading">${error ? `Kunne ikke hente prognosen: ${error}` : '<span class="spinner"></span> Henter DMI-prognose…'}</div>`;
  return el.querySelector('.fc-close');
}

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtRun(run) {
  if (!run) return '';
  return `${run.slice(11, 13)} UTC`;
}

function cloudIcon(cc, precip, time) {
  const h = Number(fmtHour.format(new Date(time)));
  const night = h < 6 || h >= 21;
  const sun = night
    ? '<path d="M15 4a6 6 0 1 0 5 9 7 7 0 0 1-5-9z" fill="#c9d3e6"/>'
    : '<circle cx="12" cy="9" r="4.2" fill="#f5c542"/>';
  const cloud = o => `<path d="M7 20a4 4 0 0 1-.5-7.97A5 5 0 0 1 16 11.5a3.5 3.5 0 0 1 1 8.5z" fill="rgba(215,222,232,${o})"/>`;
  let body = '';
  if (cc < 20) body = sun;
  else if (cc < 60) body = sun + cloud(0.8);
  else body = cloud(cc < 85 ? 0.85 : 1).replace('rgba(215,222,232', 'rgba(170,180,195');
  if (precip >= 0.1) body += `<path d="M9 21l-1 2.5M13 21l-1 2.5M17 21l-1 2.5" stroke="#5aa6ff" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 24 25" width="26" height="26">${body}</svg>`;
}
