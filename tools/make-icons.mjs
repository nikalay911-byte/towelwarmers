/*
 * Генерация иконок расширения без внешних зависимостей и без растровых редакторов:
 * рисуем пикселями в 512×512, даунсемплим в 128/48/32/16, кодируем PNG (zlib + CRC32).
 *   node tools/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'icons');
fs.mkdirSync(outDir, { recursive: true });

const BASE = 512;
const SIZES = [128, 48, 32, 16];

// ---------- примитивы ----------
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
function aa(dist, w = 1.6) { return Math.min(1, Math.max(0, 0.5 - dist / w)); }

const C = {
  g1: [18, 163, 127], g2: [8, 88, 72], white: [255, 255, 255],
  ink: [255, 255, 255], amber: [255, 209, 102], dark: [6, 46, 38]
};
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

function paint(size) {
  const px = new Float64Array(size * size * 4);
  const k = size / BASE;
  const R = 0.23 * size, HW = 0.47 * size, HH = 0.47 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const tileA = aa(sdRoundRect(x + .5, y + .5, size / 2, size / 2, HW, HH, R), 1.2 * k);
      if (tileA <= 0) { px[i + 3] = 0; continue; }
      const t = (x + y) / (2 * size);
      let c = mix(C.g1, C.g2, Math.min(1, t * 1.2));

      const draw = (v) => v * k;
      // ---- таблица прайса: шапка + 2 строки по 3 ячейки
      const tx0 = draw(116), tx1 = draw(366);
      const cellA = aa(rect(x + .5 - (tx0 + tx1) / 2, y + .5 - (draw(120) + draw(152)) / 2, (tx1 - tx0) / 2, draw(30), draw(15)), 1.4 * k);
      c = mix(c, C.white, cellA * 0.97);
      const rowsY = [draw(214), draw(286)];
      const cols = [[draw(116), draw(214)], [draw(232), draw(292)], [draw(310), draw(366)]];
      for (let r = 0; r < rowsY.length; r++) {
        for (let cc = 0; cc < cols.length; cc++) {
          const last = r === 1 && cc === 2;
          const w = (cols[cc][1] - cols[cc][0]) / 2, hh = draw(21);
          const cx = (cols[cc][0] + cols[cc][1]) / 2, cy = rowsY[r];
          const a = aa(rect(x + .5 - cx, y + .5 - cy, w, hh, draw(9)), 1.4 * k);
          c = last ? mix(c, C.amber, a * 0.95) : mix(c, C.white, a * (r === 0 ? 0.72 : 0.5));
        }
      }
      // ---- лупа поверх таблицы (справа снизу)
      const mx = draw(348), my = draw(344), mr = draw(74), ringW = draw(15);
      const d = Math.hypot(x + .5 - mx, y + .5 - my);
      const ring = aa(Math.abs(d - mr) - ringW, 2.2 * k);
      const glass = aa(mr - ringW - d, 2.2 * k);
      // ручка: капсула под 45 градусов
      const hlx = (x + .5 - (mx + mr * 0.72)) * 0.7071 + (y + .5 - (my + mr * 0.72)) * 0.7071;
      const hly = (x + .5 - (mx + mr * 0.72)) * 0.7071 - (y + .5 - (my + mr * 0.72)) * 0.7071;
      const handle = aa(Math.max(Math.abs(hly) - draw(13), Math.abs(hlx) - draw(30)), 2.2 * k);
      c = mix(c, C.dark, glass * 0.45);                       // затемняем «стекло»
      c = mix(c, C.white, Math.max(ring, handle) * 0.99);     // белое кольцо и ручка

      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = tileA * 255;
    }
  }
  return px;
}
function rect(x, y, hw, hh, r) {
  return sdRoundRect(x, y, 0, 0, hw, hh, Math.min(r, hw, hh));
}

function downsample(src, size, target) {
  const out = new Uint8Array(target * target * 4);
  const f = size / target;
  for (let ty = 0; ty < target; ty++) {
    for (let tx = 0; tx < target; tx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(tx * f), x1 = Math.min(size, Math.ceil((tx + 1) * f));
      const y0 = Math.floor(ty * f), y1 = Math.min(size, Math.ceil((ty + 1) * f));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * size + x) * 4, al = src[i + 3] / 255;
        r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
      }
      const o = (ty * target + tx) * 4;
      if (a <= 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(255 * Math.min(1, a / n));
    }
  }
  return out;
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size * 4; x++) raw[p++] = rgba[y * size * 4 + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const big = paint(BASE);
for (const s of SIZES) {
  const buf = s === BASE ? big : downsample(big, BASE, s);
  const png = encodePNG(buf instanceof Uint8Array ? buf : new Uint8Array(buf), s);
  fs.writeFileSync(path.join(outDir, `icon-${s}.png`), Buffer.from(png));
  console.log(`icons/icon-${s}.png`, (png.length / 1024).toFixed(1) + ' КБ');
}
// favicon для веб-версии страницы
fs.writeFileSync(path.join(outDir, 'icon-180.png'), Buffer.from(encodePNG(downsample(big, BASE, 180), 180)));
console.log('готово');
