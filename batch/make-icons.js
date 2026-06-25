// batch/make-icons.js
// PWA用アイコンを生成（依存ゼロ。Node標準のzlibでPNGエンコード）。
// 図柄: アプリの寒色→暖色ヒートマップ・ランプを5×5グリッドで配置（少=青→多=赤の世界観）。
// 出力: web/icons/ に icon-192 / icon-512 / maskable-512 / apple-touch-180 / favicon-32

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "web", "icons");

const RAMP = [
  [69, 117, 180], [116, 173, 209], [171, 217, 233],
  [253, 174, 97], [244, 109, 67], [215, 48, 39],
]; // #4575b4 … #d73027（アプリと同じ）
const BRAND = [46, 80, 144];   // #2e5090
const WHITE = [255, 255, 255];

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

// --- PNG エンコード（RGBA, color type 6） ---
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(S, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  const raw = Buffer.alloc(S * (1 + S * 4));
  for (let y = 0; y < S; y++) {
    raw[y * (1 + S * 4)] = 0; // filter none
    px.copy(raw, y * (1 + S * 4) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- 描画 ---
function drawIcon(S, { bg, innerFrac }) {
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, c) => { const i = (y * S + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < S && y < S) set(x, y, c);
  };
  rect(0, 0, S, S, bg);
  const g = 5;                       // 5×5
  const inner = Math.round(S * innerFrac);
  const off = Math.round((S - inner) / 2);
  const gap = Math.max(2, Math.round(inner * 0.03));
  const cell = Math.round((inner - gap * (g + 1)) / g);
  for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) {
    const v = (r + c) / (2 * (g - 1));          // 左上=青 → 右下=赤
    const col = RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))];
    rect(off + gap + c * (cell + gap), off + gap + r * (cell + gap), cell, cell, col);
  }
  return encodePNG(S, px);
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ["icon-192.png", 192, { bg: WHITE, innerFrac: 0.9 }],
  ["icon-512.png", 512, { bg: WHITE, innerFrac: 0.9 }],
  ["maskable-512.png", 512, { bg: BRAND, innerFrac: 0.62 }],
  ["apple-touch-180.png", 180, { bg: WHITE, innerFrac: 0.9 }],
  ["favicon-32.png", 32, { bg: WHITE, innerFrac: 0.92 }],
];
for (const [name, S, opt] of files) {
  fs.writeFileSync(path.join(OUT, name), drawIcon(S, opt));
  console.log(`  ${name} (${S}px)`);
}
console.log(`生成: ${path.relative(process.cwd(), OUT)} に ${files.length} 個`);
