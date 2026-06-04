/**
 * Generates Android notification small icon as a white leaf silhouette PNG.
 * Uses only Node.js built-ins (zlib for PNG compression).
 * Run: node scripts/generate-notification-icon.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 96;
const cx = SIZE / 2;
const leafTop = 8;
const leafBottom = 88;
const leafHeight = leafBottom - leafTop;
const maxHalfWidth = 26;

// RGBA pixel array (4 bytes per pixel)
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

for (let y = 0; y < SIZE; y++) {
  const relY = (y - leafTop) / leafHeight;
  if (relY < 0 || relY > 1) continue;

  // Leaf shape: smooth teardrop, wider near bottom
  const t = relY ** 0.65;
  const halfWidth = Math.sin(Math.PI * t) * maxHalfWidth;

  for (let x = 0; x < SIZE; x++) {
    const dx = Math.abs(x - cx);
    if (dx <= halfWidth) {
      const idx = (y * SIZE + x) * 4;
      pixels[idx] = 0xff; // R
      pixels[idx + 1] = 0xff; // G
      pixels[idx + 2] = 0xff; // B
      pixels[idx + 3] = 0xff; // A
    }
  }
}

// Build PNG manually
function crc32(buf) {
  let crc = 0xffffffff;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeB, data, crc]);
}

// IHDR: 96x96, 8-bit RGBA
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// IDAT: raw pixel data with filter byte per row
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: None
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const compressed = deflateSync(raw);

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);

const outDir = resolve('android/app/src/main/res/drawable');
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const outPath = resolve(outDir, 'ic_stat_flaxia.png');
writeFileSync(outPath, png);
console.log(`Generated notification icon: ${outPath} (${png.length} bytes)`);
