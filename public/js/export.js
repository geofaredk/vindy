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
    for (const [p, label] of row.ticks) {
      const tx = Math.min(bx + bw - 8, Math.max(bx + 8, bx + p * bw));
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(label, tx, yy + rowH / 2 + 0.5);
      ctx.fillStyle = '#fff'; ctx.fillText(label, tx, yy + rowH / 2 + 0.5);
    }
  });
  return legend.length ? legend.length * rowH + (legend.length - 1) * gap : 0;
}

// meta: { title, subtitle, lines: [[label, value]], sources: string, legend: [{unit, stops, ticks}] }
export function composeWithMeta(mapCanvas, meta, scale = Math.min(2, window.devicePixelRatio || 1)) {
  const W = mapCanvas.width / scale;
  const narrow = W < 640;
  const pad = 16;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '400 10px Inter, system-ui, sans-serif';
  const sourceLines = wrap(measure, meta.sources, W - pad * 2);
  const legendW = narrow ? W - pad * 2 : Math.min(300, W * 0.3);
  const legendH = meta.legend.length ? meta.legend.length * 22 - 6 : 0;
  const topH = narrow ? 44 + 8 + meta.lines.length * 17 + (legendH ? legendH + 12 : 0) : Math.max(44, meta.lines.length * 17, legendH);
  const H = pad + topH + 12 + sourceLines.length * 14 + pad;

  const out = document.createElement('canvas');
  out.width = mapCanvas.width;
  out.height = mapCanvas.height + Math.round(H * scale);
  const ctx = out.getContext('2d');
  ctx.drawImage(mapCanvas, 0, 0);
  ctx.scale(scale, scale);
  const y0 = mapCanvas.height / scale;
  ctx.fillStyle = '#10141d';
  ctx.fillRect(0, y0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.fillRect(0, y0, W, 1);

  // Logo + title
  ctx.save();
  ctx.translate(pad, y0 + pad + 2);
  roundRect(ctx, 0, 0, 40, 40, 9); ctx.clip();
  ctx.scale(40 / 240, 40 / 240);
  ctx.fillStyle = LOGO.background; ctx.fillRect(0, 0, 240, 240);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const part of [LOGO.bars, LOGO.mark]) {
    ctx.strokeStyle = part.color; ctx.lineWidth = part.width;
    ctx.stroke(new Path2D(part.path));
  }
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff'; ctx.font = '700 17px Inter, system-ui, sans-serif';
  ctx.fillText(meta.title, pad + 52, y0 + pad + 19);
  ctx.fillStyle = '#cfd6e2'; ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillText(meta.subtitle, pad + 52, y0 + pad + 37);

  // Time / run lines
  const linesX = narrow ? pad : pad + 52 + Math.max(150, measure.measureText(meta.subtitle).width * 1.25 + 24);
  const linesY = narrow ? y0 + pad + 56 : y0 + pad + 12;
  meta.lines.forEach(([label, value], k) => {
    const yy = linesY + k * 17;
    ctx.font = '400 12px Inter, system-ui, sans-serif'; ctx.fillStyle = '#8f9aad';
    ctx.fillText(`${label}:`, linesX, yy);
    const lw = ctx.measureText(`${label}: `).width;
    ctx.font = '600 12px Inter, system-ui, sans-serif'; ctx.fillStyle = '#fff';
    ctx.fillText(value, linesX + lw, yy);
  });

  // Legend
  if (meta.legend.length) {
    const lx = narrow ? pad : W - pad - legendW;
    const ly = narrow ? linesY + meta.lines.length * 17 + 2 : y0 + pad + (topH - legendH) / 2;
    drawLegend(ctx, meta.legend, lx, ly, legendW);
  }

  // Sources
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '400 10px Inter, system-ui, sans-serif'; ctx.fillStyle = '#8f9aad';
  sourceLines.forEach((line, k) => ctx.fillText(line, pad, y0 + pad + topH + 12 + 10 + k * 14));
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
