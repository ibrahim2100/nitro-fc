// Nitro brand: one geometry definition, rendered both as SVG and as PNG icons.
const zlib = require('zlib');

const C = {
  bg1: '#0b1220', bg2: '#1a2f55',
  ring1: '#5cffb0', ring2: '#2bd4ff',
  bolt1: '#ffe45c', bolt2: '#ff8a2b',
};
const BG = { x: 4, y: 4, size: 120, r: 28, g: [4, 4, 124, 124] };
const HEX = { cx: 64, cy: 64, R: 44, w: 6, g: [26, 20, 102, 108] };
const BOLT = { pts: [[73, 32], [47, 68], [60, 68], [53, 96], [81, 58], [68, 58]], g: [64, 32, 64, 96] };

const hexPoints = () =>
  [0, 1, 2, 3, 4, 5].map((k) => {
    const a = ((-90 + 60 * k) * Math.PI) / 180;
    return [HEX.cx + HEX.R * Math.cos(a), HEX.cy + HEX.R * Math.sin(a)];
  });
const f = (n) => +n.toFixed(3);

function grad(id, g, c1, c2) {
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g[0]}" y1="${g[1]}" x2="${g[2]}" y2="${g[3]}"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`;
}

function logoInner() {
  const hex = hexPoints().map((p) => p.map(f).join(',')).join(' ');
  const bolt = BOLT.pts.map((p) => p.join(',')).join(' ');
  return (
    `<defs>${grad('nb', BG.g, C.bg1, C.bg2)}${grad('nr', HEX.g, C.ring1, C.ring2)}${grad('nz', BOLT.g, C.bolt1, C.bolt2)}</defs>` +
    `<rect x="${BG.x}" y="${BG.y}" width="${BG.size}" height="${BG.size}" rx="${BG.r}" fill="url(#nb)"/>` +
    `<polygon points="${hex}" fill="none" stroke="url(#nr)" stroke-width="${HEX.w}" stroke-linejoin="miter"/>` +
    `<polygon points="${bolt}" fill="url(#nz)"/>`
  );
}

const logoSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${logoInner()}</svg>`;

const wordmarkSvg = (text = 'NITRO') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 128" width="400" height="128">${logoInner()}` +
  `<text x="140" y="86" font-family="Helvetica Neue, Arial Black, Arial, sans-serif" font-weight="900" font-size="66" letter-spacing="4" fill="#ffffff">${text}</text></svg>`;

const dataUri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

// ---------- PNG rasteriser (same geometry, 4x4 supersampling) ----------
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const gradT = (x, y, g) => {
  const dx = g[2] - g[0], dy = g[3] - g[1];
  return Math.min(1, Math.max(0, ((x - g[0]) * dx + (y - g[1]) * dy) / (dx * dx + dy * dy)));
};
const inPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const rgb = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, hexToRgb(v)]));
const HEX_A = HEX.R * Math.cos(Math.PI / 6);

function samplePixel(x, y, gray) {
  // returns [r,g,b,a]
  const qx = Math.abs(x - 64) - (BG.size / 2 - BG.r);
  const qy = Math.abs(y - 64) - (BG.size / 2 - BG.r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - BG.r;
  if (d > 0) return [0, 0, 0, 0];
  let col = lerp(rgb.bg1, rgb.bg2, gradT(x, y, BG.g));
  let hd = -Infinity;
  for (let k = 0; k < 6; k++) {
    const a = (k * 60 * Math.PI) / 180;
    hd = Math.max(hd, (x - HEX.cx) * Math.cos(a) + (y - HEX.cy) * Math.sin(a));
  }
  if (Math.abs(hd - HEX_A) <= HEX.w / 2) col = lerp(rgb.ring1, rgb.ring2, gradT(x, y, HEX.g));
  if (inPoly(x, y, BOLT.pts)) col = lerp(rgb.bolt1, rgb.bolt2, gradT(x, y, BOLT.g));
  if (gray) { const l = 0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2]; col = [l, l, l]; }
  return [col[0], col[1], col[2], 1];
}

function renderRGBA(size, ss = 4, gray = false) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = samplePixel((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale, gray);
          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }
      const n = ss * ss, o = (py * size + px) * 4;
      buf[o] = a ? Math.round(r / a) : 0;
      buf[o + 1] = a ? Math.round(g / a) : 0;
      buf[o + 2] = a ? Math.round(b / a) : 0;
      buf[o + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, gray = false) {
  const raw = renderRGBA(size, 4, gray);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { rows[y * (size * 4 + 1)] = 0; raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { logoSvg, wordmarkSvg, dataUri, png };
