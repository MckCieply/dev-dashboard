// Draws the toast icons into assets/toast/. Run with `npm run icons` after changing them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/toast');
const SIZE = 256;
const PAD = 3; // empty units around the 24x24 drawing grid
const SCALE = SIZE / (24 + 2 * PAD);

const RED = '#E61919';
const GREEN = '#3DD68C';
const PURPLE = '#8250DF';
const WHITE = '#FFFFFF';
const DARK = '#0A0A0A';

// Shapes return the distance from a point to their center line.
const line = (x1, y1, x2, y2) => (x, y) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
};
const path_ = (...pts) => pts.slice(1).map((p, i) => line(...pts[i], ...p));
const ring = (cx, cy, r) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r);
const upperArc = (cx, cy, r) => (x, y) => (y <= cy ? ring(cx, cy, r)(x, y) : Math.min(Math.hypot(x - cx + r, y - cy), Math.hypot(x - cx - r, y - cy)));
const curve = ([ax, ay], [bx, by], [cx, cy]) => path_(...Array.from({ length: 17 }, (_, i) => {
  const t = i / 16;
  return [(1 - t) ** 2 * ax + 2 * (1 - t) * t * bx + t * t * cx, (1 - t) ** 2 * ay + 2 * (1 - t) * t * by + t * t * cy];
}));
const box = (x1, y1, x2, y2) => path_([x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]);
const rack = [...box(3, 4, 21, 10), ...box(3, 14, 21, 20), line(7, 7, 8, 7), line(7, 17, 8, 17)];

// layer: [color, stroke width, shapes]
const ICONS = {
  'needs-human': [RED, [[WHITE, 2.4, [ring(9, 7, 3.6), upperArc(9, 21, 6.6), line(20, 5, 20, 13), line(20, 18, 20, 18.2)]]]],
  'checks-failed': [RED, [[WHITE, 3.2, [line(5, 5, 19, 19), line(19, 5, 5, 19)]]]],
  ready: [GREEN, [[DARK, 3.2, path_([3.5, 12.5], [9.5, 18.5], [20.5, 6])]]],
  merged: [PURPLE, [[WHITE, 2.4, [ring(6, 4.5, 2.6), ring(6, 19.5, 2.6), ring(18, 14, 2.6), line(6, 7.5, 6, 16.5), ...curve([6, 8], [8, 14], [15, 14])]]]],
  'runner-offline': [RED, [[WHITE, 2, rack], [RED, 6, [line(3, 22, 21, 2)]], [WHITE, 2.4, [line(3, 22, 21, 2)]]]],
  'runner-online': [GREEN, [[DARK, 2.2, rack]]],
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function pixels(bg, layers) {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4)); // each row starts with filter byte 0
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5) / SCALE - PAD;
      const y = (py + 0.5) / SCALE - PAD;
      let color = rgb(bg);
      for (const [fg, width, shapes] of layers) {
        const d = Math.min(...shapes.map((s) => s(x, y)));
        const a = Math.max(0, Math.min(1, 0.5 - (d - width / 2) * SCALE));
        if (a > 0) color = rgb(fg).map((c, i) => Math.round(c * a + color[i] * (1 - a)));
      }
      raw.set([...color, 255], py * (1 + SIZE * 4) + 1 + px * 4);
    }
  }
  return raw;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => (buf.reduce((c, b) => CRC[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};
const png = (raw) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', Buffer.concat([u32(SIZE), u32(SIZE), Buffer.from([8, 6, 0, 0, 0])])),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, [bg, layers]] of Object.entries(ICONS)) {
  fs.writeFileSync(path.join(OUT, `${name}.png`), png(pixels(bg, layers)));
}
console.log(`${Object.keys(ICONS).length} icons written to ${OUT}`);
