// Map export: rasterise exactly what the map shows (tiles, weather canvases, radar and
// satellite images, labels) into a canvas, optionally with a metadata footer, and save
// it as PNG (with the metadata also embedded as PNG text chunks).

// Vindy logo (public/img/vindy-light.svg), drawn in its 240x240 coordinate space.
const LOGO = {
  background: '#F4EFE8',
  bars: { color: '#D96C4F', width: 13, path: 'M124 130 H185 M110 160 H164 M97 188 H141' },
  mark: { color: '#233044', width: 24, path: 'M46 84 L98 190 L136 112 Q147 88 172 88 H204' },
};
const ACCENT = '#D96C4F';

function effectiveOpacity(el, stop) {
  let o = 1;
  for (let n = el; n && n !== stop; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
    o *= Number(cs.opacity);
  }
  return o;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Station / forecast value labels are HTML; redraw them from their computed styles.
function drawLabel(ctx, el, ox, oy) {
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const cs = getComputedStyle(el);
  const x = r.left - ox, y = r.top - oy;
  roundRect(ctx, x, y, r.width, r.height, parseFloat(cs.borderTopLeftRadius) || 0);
  ctx.fillStyle = cs.backgroundColor;
  ctx.fill();
  const bw = parseFloat(cs.borderTopWidth) || 0;
  if (bw) { ctx.lineWidth = bw; ctx.strokeStyle = cs.borderTopColor; ctx.stroke(); }
  const shadow = cs.textShadow && cs.textShadow !== 'none';
  for (const node of el.childNodes) {
    let rect, text, style = cs, rotate = 0;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      rect = range.getBoundingClientRect(); text = node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      style = getComputedStyle(node); text = node.textContent;
      if (node.classList.contains('st-arrow')) {
        const m = (node.style.transform || '').match(/rotate\(([-\d.]+)deg\)/);
        rotate = m ? Number(m[1]) : 0;
        // Bounding rect of a rotated element grows; use its centre only.
        const br = node.getBoundingClientRect();
        rect = { left: br.left + br.width / 2, top: br.top + br.height / 2, center: true };
      } else rect = node.getBoundingClientRect();
    } else continue;
    ctx.save();
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'middle';
    if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 2; }
    if (rect.center) {
      ctx.translate(rect.left - ox, rect.top - oy);
      ctx.rotate(rotate * Math.PI / 180);
      ctx.textAlign = 'center';
      ctx.fillText(text, 0, 1);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(text, rect.left - ox, rect.top - oy + rect.height / 2 + 0.5);
    }
    ctx.restore();
  }
}

export function captureMap(map, scale = Math.min(2, window.devicePixelRatio || 1)) {
  const container = map.getContainer();
  const box = container.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(box.width * scale);
  canvas.height = Math.round(box.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(container).backgroundColor || '#0b0e14';
  ctx.fillRect(0, 0, box.width, box.height);

  const mapPane = map.getPane('mapPane');
  const panes = [...mapPane.children]
    .filter(p => p.classList.contains('leaflet-pane'))
    .map((p, i) => ({ p, i, z: Number(getComputedStyle(p).zIndex) || 0 }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map(x => x.p);

  for (const pane of panes) {
    if (pane.classList.contains('leaflet-popup-pane') || pane.classList.contains('leaflet-tooltip-pane') || pane.classList.contains('leaflet-shadow-pane')) continue;
    if (pane.classList.contains('leaflet-marker-pane')) {
      for (const el of pane.querySelectorAll('.st-label, .fv-label')) {
        if (effectiveOpacity(el, container) > 0) drawLabel(ctx, el, box.left, box.top);
      }
      for (const dot of pane.querySelectorAll('.pin-dot')) {
        const r = dot.getBoundingClientRect();
        const cx = r.left - box.left + r.width / 2, cy = r.top - box.top + r.height / 2;
        ctx.beginPath(); ctx.arc(cx, cy, r.width / 2 + 6, 0, Math.PI * 2); ctx.fillStyle = 'rgba(217,108,79,.3)'; ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, r.width / 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, r.width / 2 - 3, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
      }
      continue;
    }
    // Apply pane CSS filters (e.g. the brightened place names) to the export as well.
    const filter = getComputedStyle(pane).filter;
    ctx.filter = filter && filter !== 'none' ? filter : 'none';
    for (const el of pane.querySelectorAll('img, canvas')) {
      const opacity = effectiveOpacity(el, container);
      if (opacity <= 0) continue;
      if (el.tagName === 'IMG' && !(el.complete && el.naturalWidth)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right < box.left || r.bottom < box.top || r.left > box.right || r.top > box.bottom) continue;
      ctx.globalAlpha = opacity;
      try {
        ctx.drawImage(el, r.left - box.left, r.top - box.top, r.width, r.height);
      } catch { /* skip anything that can't be drawn */ }
      ctx.globalAlpha = 1;
    }
    ctx.filter = 'none';
  }
  return canvas;
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawLegend(ctx, legend, x, y, width) {
  const rowH = 16, gap = 6;
  legend.forEach((row, k) => {
    const yy = y + k * (rowH + gap);
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#8f9aad';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(row.unit, x, yy + rowH / 2);
    const bx = x + 36, bw = width - 36;
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    for (const [p, color] of row.stops) grad.addColorStop(Math.min(1, Math.max(0, p)), color);
    ctx.fillStyle = grad;
    roundRect(ctx, bx, yy, bw, rowH, 3); ctx.fill();
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    let lastRight = -Infinity;
    for (const [p, label] of row.ticks) {
      const tx = Math.min(bx + bw - 8, Math.max(bx + 8, bx + p * bw));
      // Leave out numbers that would run into the previous one on a short scale.
      const half = ctx.measureText(label).width / 2;
      if (tx - half < lastRight + 4) continue;
      lastRight = tx + half;
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(label, tx, yy + rowH / 2 + 0.5);
      ctx.fillStyle = '#fff'; ctx.fillText(label, tx, yy + rowH / 2 + 0.5);
    }
  });
  return legend.length ? legend.length * rowH + (legend.length - 1) * gap : 0;
}

function drawLogoMark(ctx, x, y, size, radius) {
  ctx.save();
  ctx.translate(x, y);
  roundRect(ctx, 0, 0, size, size, radius); ctx.clip();
  ctx.scale(size / 240, size / 240);
  ctx.fillStyle = LOGO.background; ctx.fillRect(0, 0, 240, 240);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const part of [LOGO.bars, LOGO.mark]) {
    ctx.strokeStyle = part.color; ctx.lineWidth = part.width;
    ctx.stroke(new Path2D(part.path));
  }
  ctx.restore();
}

// A dark rounded "pill" floating on the map.
function pill(ctx, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 1;
  roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = 'rgba(16,20,29,.82)';
  ctx.fill();
  ctx.restore();
  roundRect(ctx, x, y, w, h, 10);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
}

const FONT = 'Inter, system-ui, sans-serif';

// The exported picture: the map, optionally the Vindy logo floating top left and the
// time floating top right (always in animations), optionally one metadata line under the map (layer,
// time, model run, colour scale), and always a strip with the sources.
// info: { subtitle, lines: [[label, value]], timeLabel, sources, legend: [{unit, stops, ticks}] }
export function composeExport(mapCanvas, info, { logo = true, meta = true, time = false } = {}, scale = Math.min(2, window.devicePixelRatio || 1)) {
  const W = mapCanvas.width / scale, MH = mapCanvas.height / scale;
  const pad = 12;
  const measure = document.createElement('canvas').getContext('2d');

  // Metadata line: "Layer · Label: value · …" on the left, colour scales on the right.
  // With the time floating on the map (animations) it is left out of the line.
  const lines = time ? info.lines.slice(1) : info.lines;
  const legendW = 170, legendGap = 14;
  const legendsW = info.legend.length ? info.legend.length * (legendW + 34) + (info.legend.length - 1) * legendGap : 0;
  measure.font = `400 11px ${FONT}`;
  const textW = () => {
    measure.font = `700 12px ${FONT}`;
    let w = measure.measureText(info.subtitle).width;
    for (const [label, value] of lines) {
      measure.font = `400 11px ${FONT}`; w += measure.measureText(` · ${label}: `).width;
      measure.font = `600 11px ${FONT}`; w += measure.measureText(value).width;
    }
    return w;
  };
  const oneLine = textW() + legendsW + 24 <= W - pad * 2;
  const metaH = !meta ? 0 : oneLine ? 34 : 34 + (legendsW ? 26 : 0);

  measure.font = `400 10px ${FONT}`;
  const sourceLines = wrap(measure, info.sources, W - pad * 2);
  const sourcesH = 8 + sourceLines.length * 13 + 5;

  const out = document.createElement('canvas');
  out.width = mapCanvas.width;
  out.height = mapCanvas.height + Math.round((metaH + sourcesH) * scale);
  const ctx = out.getContext('2d');
  ctx.drawImage(mapCanvas, 0, 0);
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';

  if (logo) {
    ctx.font = `700 13px ${FONT}`;
    const label = 'vindy.dk', lw = ctx.measureText(label).width;
    const w = 8 + 26 + 8 + lw + 12, h = 42, x = pad, y = pad;
    pill(ctx, x, y, w, h);
    drawLogoMark(ctx, x + 8, y + 8, 26, 6);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(label, x + 42, y + h / 2 + 0.5);
  }

  if (time && info.timeLabel) {
    ctx.font = `700 15px ${FONT}`;
    const tw = ctx.measureText(info.timeLabel).width;
    ctx.font = `500 11px ${FONT}`;
    const sw = ctx.measureText(info.subtitle).width;
    const w = 14 + Math.max(tw, sw) + 14, h = 46, x = W - pad - w, y = pad;
    pill(ctx, x, y, w, h);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff'; ctx.font = `700 15px ${FONT}`;
    ctx.fillText(info.timeLabel, x + w - 14, y + 17);
    ctx.fillStyle = '#aab3c2'; ctx.font = `500 11px ${FONT}`;
    ctx.fillText(info.subtitle, x + w - 14, y + 33);
  }

  let y = MH;
  if (meta) {
    ctx.fillStyle = '#10141d'; ctx.fillRect(0, y, W, metaH);
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, y, W, 1);
    const cy = y + 17;
    let x = pad;
    ctx.textAlign = 'left';
    ctx.font = `700 12px ${FONT}`; ctx.fillStyle = '#fff';
    ctx.fillText(info.subtitle, x, cy); x += ctx.measureText(info.subtitle).width;
    for (const [label, value] of lines) {
      ctx.font = `400 11px ${FONT}`; ctx.fillStyle = '#8f9aad';
      const l = ` · ${label}: `; ctx.fillText(l, x, cy); x += ctx.measureText(l).width;
      ctx.font = `600 11px ${FONT}`; ctx.fillStyle = '#e9edf3';
      ctx.fillText(value, x, cy); x += ctx.measureText(value).width;
    }
    if (legendsW) {
      let lx = oneLine ? W - pad - legendsW : pad;
      const ly = oneLine ? y + 9 : y + 34;
      for (const row of info.legend) {
        drawLegend(ctx, [row], lx, ly, legendW + 34);
        lx += legendW + 34 + legendGap;
      }
    }
    y += metaH;
  }

  ctx.fillStyle = '#0c1017'; ctx.fillRect(0, y, W, sourcesH);
  ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(0, y, W, 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `400 10px ${FONT}`; ctx.fillStyle = '#8f9aad';
  sourceLines.forEach((line, k) => ctx.fillText(line, pad, y + 8 + 9 + k * 13));
  return out;
}

// ---- PNG with tEXt chunks ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// iTXt chunks carry UTF-8 (Danish characters) where tEXt would be Latin-1 only.
function itxtChunk(keyword, text) {
  const enc = new TextEncoder();
  const data = new Uint8Array([...enc.encode(keyword), 0, 0, 0, 0, 0, ...enc.encode(text)]);
  const type = enc.encode('iTXt');
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(type, 4); chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

export async function canvasToPng(canvas, textEntries = {}) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const entries = Object.entries(textEntries).filter(([, v]) => v);
  if (!entries.length) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Insert right after IHDR (8-byte signature + 25-byte IHDR chunk).
  const head = bytes.subarray(0, 33), rest = bytes.subarray(33);
  const chunks = entries.map(([k, v]) => itxtChunk(k, v));
  return new Blob([head, ...chunks, rest], { type: 'image/png' });
}
