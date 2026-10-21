import assert from 'node:assert';
import { describe, it } from 'node:test';
import { parseImageDimensions, validateImageDimensions } from '../functions/lib/image-dimensions.ts';

function toAB(bytes: number[] | Uint8Array): ArrayBuffer {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function setBE(b: Uint8Array, off: number, val: number, n: number): void {
  for (let i = 0; i < n; i++) b[off + i] = (val >> (8 * (n - 1 - i))) & 0xff;
}

function png(w: number, h: number): ArrayBuffer {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  setBE(b, 16, w, 4);
  setBE(b, 20, h, 4);
  return toAB(b);
}

function gif(w: number, h: number): ArrayBuffer {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  b[6] = w & 0xff;
  b[7] = (w >> 8) & 0xff;
  b[8] = h & 0xff;
  b[9] = (h >> 8) & 0xff;
  return toAB(b);
}

function jpeg(w: number, h: number): ArrayBuffer {
  // SOI, then APP0 segment (16-byte body), then SOF0.
  const b = new Uint8Array(22 + 14 + 11);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  b[4] = 0x00;
  b[5] = 0x10;
  for (let i = 0; i < 14; i++) b[6 + i] = 0x11;
  b[22] = 0xff;
  b[23] = 0xc0;
  b[24] = 0x00;
  b[25] = 0x11;
  b[26] = 8;
  setBE(b, 27, h, 2);
  setBE(b, 29, w, 2);
  return toAB(b);
}

function webp(chunkId: string, payload: Uint8Array): ArrayBuffer {
  // "RIFF"(4) + size(4) + "WEBP"(4) + chunkId(4) + chunkSize(4) + payload
  const b = new Uint8Array(20 + payload.length);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([chunkId.charCodeAt(0), chunkId.charCodeAt(1), chunkId.charCodeAt(2), chunkId.charCodeAt(3)], 12);
  b[16] = payload.length & 0xff;
  b[17] = (payload.length >> 8) & 0xff;
  b[18] = (payload.length >> 16) & 0xff;
  b[19] = (payload.length >> 24) & 0xff;
  b.set(payload, 20);
  return toAB(b);
}

function webpVp8x(w: number, h: number): ArrayBuffer {
  // VP8X payload: flags(1) + reserved(3) + canvas w(24 LE) + canvas h(24 LE)
  const payload = new Uint8Array(10);
  payload[0] = 0x80;
  payload[4] = (w - 1) & 0xff;
  payload[5] = ((w - 1) >> 8) & 0xff;
  payload[6] = ((w - 1) >> 16) & 0xff;
  payload[7] = (h - 1) & 0xff;
  payload[8] = ((h - 1) >> 8) & 0xff;
  payload[9] = ((h - 1) >> 16) & 0xff;
  return webp('VP8X', payload);
}

function webpVp8l(w: number, h: number): ArrayBuffer {
  // VP8L payload: signature 0x2f + 32-bit LE header byte where
  // bits 0-13 = width-1, bits 14-27 = height-1
  const wm1 = w - 1;
  const hm1 = h - 1;
  const val = (wm1 & 0x3fff) | ((hm1 & 0x3fff) << 14);
  const payload = new Uint8Array(5);
  payload[0] = 0x2f;
  payload[1] = val & 0xff;
  payload[2] = (val >> 8) & 0xff;
  payload[3] = (val >> 16) & 0xff;
  payload[4] = (val >> 24) & 0xff;
  return webp('VP8L', payload);
}

function webpVp8(w: number, h: number): ArrayBuffer {
  // VP8 payload: frame tag(3) + start code 0x9d 0x01 0x2a(3) + width(LE u16) + height(LE u16)
  const payload = new Uint8Array(10);
  payload[0] = 0x70;
  payload[1] = 0x6a;
  payload[2] = 0x00;
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload[6] = w & 0xff;
  payload[7] = (w >> 8) & 0xff;
  payload[8] = h & 0xff;
  payload[9] = (h >> 8) & 0xff;
  return webp('VP8 ', payload);
}

describe('parseImageDimensions', () => {
  it('parses PNG dimensions', () => {
    assert.deepEqual(parseImageDimensions(png(1234, 200), 'image/png'), { width: 1234, height: 200 });
  });

  it('parses GIF dimensions', () => {
    assert.deepEqual(parseImageDimensions(gif(64, 64), 'image/gif'), { width: 64, height: 64 });
  });

  it('parses JPEG dimensions by skipping non-SOF segments', () => {
    assert.deepEqual(parseImageDimensions(jpeg(320, 240), 'image/jpeg'), { width: 320, height: 240 });
  });

  it('parses WebP VP8X dimensions', () => {
    assert.deepEqual(parseImageDimensions(webpVp8x(6000, 2000), 'image/webp'), { width: 6000, height: 2000 });
  });

  it('parses WebP VP8L dimensions', () => {
    assert.deepEqual(parseImageDimensions(webpVp8l(800, 600), 'image/webp'), { width: 800, height: 600 });
  });

  it('parses WebP VP8 lossy dimensions', () => {
    assert.deepEqual(parseImageDimensions(webpVp8(1024, 768), 'image/webp'), { width: 1024, height: 768 });
  });

  it('returns null for empty buffers', () => {
    assert.strictEqual(parseImageDimensions(new ArrayBuffer(0), 'image/png'), null);
  });

  it('returns null for truncated JPEG headers instead of reading out of bounds', () => {
    const j = new Uint8Array(jpeg(100, 200));
    assert.strictEqual(parseImageDimensions(toAB(j.subarray(0, 6)), 'image/jpeg'), null);
  });

  it('returns null for non-WebP data passed as webp', () => {
    assert.strictEqual(parseImageDimensions(toAB(new Uint8Array(64).fill(1)), 'image/webp'), null);
  });
});

describe('validateImageDimensions', () => {
  it('accepts images within limits', () => {
    assert.strictEqual(validateImageDimensions(png(4000, 3000), 'image/png'), null);
  });

  it('rejects images exceeding per-edge dimension cap', () => {
    assert.match(validateImageDimensions(png(8000, 100), 'image/png') ?? '', /Image too large/);
  });

  it('rejects images exceeding total pixel cap', () => {
    // 5100x5100 = 26.0MP > 24MiP although each edge is within 6000px
    assert.match(validateImageDimensions(gif(5100, 5100), 'image/gif') ?? '', /Image too large/);
  });

  it('ignores non-image mime types', () => {
    assert.strictEqual(validateImageDimensions(png(8000, 8000), 'application/zip'), null);
  });

  it('ignores unparseable images', () => {
    assert.strictEqual(validateImageDimensions(new ArrayBuffer(0), 'image/png'), null);
  });
});
