import assert from 'node:assert';
import { describe, it } from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { zlibSync } from 'fflate';
import JSZip from 'jszip';
import { decodeGifLuma } from '../functions/lib/scan/decode-gif.ts';
import { decodeJpegLuma } from '../functions/lib/scan/decode-jpeg.ts';
import { decodePngLuma } from '../functions/lib/scan/decode-png.ts';
import { extractFileFeatures } from '../functions/lib/scan/features.ts';
import { extractPdfText } from '../functions/lib/scan/pdf.ts';
import { hammingDistance } from '../functions/lib/scan/phash.ts';

const encoder = new TextEncoder();

// ── fixtures ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** 2x1 GIF89a, 2-color palette, pixels [black, white]. */
function makeGif(): Uint8Array {
  // LZW: minCodeSize=2, codes CLEAR(4), PIXEL0(0), PIXEL1(1), EOI(5),
  // packed LSB-first at code size 3 → bytes 0x44 0x0A.
  return concat([
    encoder.encode('GIF89a'),
    new Uint8Array([
      0x02,
      0x00, // width
      0x01,
      0x00, // height
      0x80, // GCT present, 2 entries
      0x00, // background
      0x00, // aspect
      0x00,
      0x00,
      0x00, // color 0: black
      0xff,
      0xff,
      0xff, // color 1: white
      0x2c, // image descriptor
      0x00,
      0x00,
      0x00,
      0x00, // left, top
      0x02,
      0x00,
      0x01,
      0x00, // 2x1
      0x00, // no local table, not interlaced
      0x02, // LZW minimum code size
      0x02,
      0x44,
      0x0a, // data sub-block
      0x00, // block terminator
      0x3b, // trailer
    ]),
  ]);
}

/**
 * Minimal baseline JPEG: 8x8, one component, minimal Huffman tables
 * (DC cat0 = "00", AC EOB = "0000") and a single all-zero DC block, so the
 * decoded frame is flat.
 */
function makeBaselineJpeg(): Uint8Array {
  const dqt = new Uint8Array([0x00, ...new Array(64).fill(1)]); // table 0, all quantizers = 1

  // SOF0: precision 8, 8x8, one component, sampling 1x1, quant table 0.
  const sof = new Uint8Array([0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00]);

  const dhtDc = concat([
    new Uint8Array([0x00]), // class 0 (DC), table 0
    new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // 1 code of len 2
    new Uint8Array([0x00]), // category 0
  ]);
  const dhtAc = concat([
    new Uint8Array([0x10]), // class 1 (AC), table 0
    new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // 1 code of len 4
    new Uint8Array([0x00]), // EOB
  ]);

  const sos = new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  // Entropy: "00" (DC cat0) + "0000" (EOB), padded with 1-bits → 0x03.
  const scan = new Uint8Array([0x03]);

  return concat([
    new Uint8Array([0xff, 0xd8]), // SOI
    new Uint8Array([0xff, 0xdb]),
    u16be(dqt.length + 2),
    dqt,
    new Uint8Array([0xff, 0xc0]),
    u16be(sof.length + 2),
    sof,
    new Uint8Array([0xff, 0xc4]),
    u16be(dhtDc.length + 2),
    dhtDc,
    new Uint8Array([0xff, 0xc4]),
    u16be(dhtAc.length + 2),
    dhtAc,
    new Uint8Array([0xff, 0xda]),
    u16be(sos.length + 2),
    sos,
    scan,
    new Uint8Array([0xff, 0xd9]), // EOI
  ]);
}

function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function makePdf(text: string, opts: { flate?: boolean } = {}): Uint8Array {
  const content = `BT (${text}) Tj ET`;
  let streamBytes = encoder.encode(content);
  let filter = '';
  if (opts.flate) {
    streamBytes = zlibSync(streamBytes);
    filter = ' /Filter /FlateDecode';
  }
  // Assembled as bytes, not string interpolation — a deflated stream is
  // binary and would be mangled by UTF-8 re-encoding.
  return concat([
    encoder.encode(
      `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length ${streamBytes.length}${filter} >> stream
`,
    ),
    streamBytes,
    encoder.encode(`
endstream endobj
trailer << /Root 1 0 R >>
%%EOF
`),
  ]);
}

async function zipBytes(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('extractFileFeatures', () => {
  it('hashes every file with sha256 and derives kind from the MIME', async () => {
    const features = await extractFileFeatures(encoder.encode('abc'), 'text/plain');
    assert.equal(features.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(features.kind, 'other');
    assert.equal(features.structureHash, undefined);
    assert.equal(features.textHash, undefined);
    assert.equal(features.phash, undefined);
  });

  it('is deterministic for identical bytes', async () => {
    const bytes = makePng(8, 8, (x, y) => [x * 8, y * 8, 128]);
    const a = await extractFileFeatures(bytes, 'image/png');
    const b = await extractFileFeatures(bytes, 'image/png');
    assert.deepEqual(a, b);
  });

  it('extracts a ZIP structure hash independent of entry order', async () => {
    const one = await zipBytes({ 'index.html': '<html>x</html>', 'style.css': 'a{}' });
    const two = await zipBytes({ 'style.css': 'a{}', 'index.html': '<html>x</html>' });
    const a = await extractFileFeatures(one, 'application/zip');
    const b = await extractFileFeatures(two, 'application/zip');
    assert.equal(a.kind, 'zip');
    assert.ok(a.structureHash, 'structureHash expected');
    assert.equal(a.structureHash, b.structureHash);
    assert.equal(a.phash, undefined);
  });

  it('changes the ZIP structure hash when a payload changes', async () => {
    const one = await zipBytes({ 'index.html': '<html>x</html>' });
    const two = await zipBytes({ 'index.html': '<html>y</html>' });
    const a = await extractFileFeatures(one, 'application/zip');
    const b = await extractFileFeatures(two, 'application/zip');
    assert.ok(a.structureHash && b.structureHash);
    assert.notEqual(a.structureHash, b.structureHash);
  });

  it('extracts a PDF text hash that ignores metadata-only byte changes', async () => {
    const plain = await extractFileFeatures(makePdf('Hello Flaxia'), 'application/pdf');
    const flate = await extractFileFeatures(makePdf('Hello Flaxia', { flate: true }), 'application/pdf');
    const other = await extractFileFeatures(makePdf('Goodbye Flaxia'), 'application/pdf');
    assert.equal(plain.kind, 'pdf');
    assert.ok(plain.textHash, 'textHash expected');
    assert.equal(plain.textHash, flate.textHash, 'FlateDecode must not change the text hash');
    assert.notEqual(plain.textHash, other.textHash);
    assert.equal(plain.phash, undefined);
  });

  it('computes a deterministic pHash for PNG images', async () => {
    const gradient = makePng(32, 32, (x, y) => [x * 8, y * 8, 64]);
    const inverted = makePng(32, 32, (x, y) => [255 - x * 8, 255 - y * 8, 192]);
    const a = await extractFileFeatures(gradient, 'image/png');
    const b = await extractFileFeatures(gradient, 'image/png');
    const c = await extractFileFeatures(inverted, 'image/png');
    assert.match(a.phash ?? '', /^[0-9a-f]{16}$/);
    assert.equal(a.phash, b.phash);
    assert.ok(c.phash);
    assert.ok(
      hammingDistance(a.phash as string, c.phash as string) > 8,
      'inverted gradients should fall outside the match threshold',
    );
  });

  it('leaves video pHash extraction to the orchestrator callback', async () => {
    const features = await extractFileFeatures(encoder.encode('not really a video'), 'video/mp4');
    assert.equal(features.kind, 'video');
    assert.equal(features.phash, undefined);
    assert.equal(features.phashNote, 'deferred_to_orchestrator');
  });

  it('never throws on unsupported or malformed images', async () => {
    const webp = new Uint8Array(32);
    webp.set(encoder.encode('RIFF'), 0);
    webp.set(encoder.encode('WEBP'), 8);
    const webpFeatures = await extractFileFeatures(webp, 'image/webp');
    assert.equal(webpFeatures.phash, undefined);
    assert.equal(webpFeatures.phashNote, 'unsupported_format');

    const corruptPng = makePng(8, 8, () => [1, 2, 3]).subarray(0, 40);
    const corruptFeatures = await extractFileFeatures(corruptPng, 'image/png');
    assert.equal(corruptFeatures.phash, undefined);
    assert.equal(corruptFeatures.phashNote, 'decode_failed');
    assert.ok(corruptFeatures.sha256);
  });
});

describe('image decoders', () => {
  it('decodes non-interlaced 8-bit RGB PNG luma', () => {
    const png = makePng(4, 2, (x) => [x === 0 ? 0 : 255, x === 0 ? 0 : 255, x === 0 ? 0 : 255]);
    const image = decodePngLuma(png);
    assert.ok(image);
    assert.equal(image.width, 4);
    assert.equal(image.height, 2);
    assert.equal(image.data.length, 8);
    assert.equal(image.data[0], 0);
    assert.equal(image.data[3], 255);
  });

  it('decodes the first frame of a GIF', () => {
    const image = decodeGifLuma(makeGif());
    assert.ok(image, 'GIF must decode');
    assert.equal(image.width, 2);
    assert.equal(image.height, 1);
    assert.deepEqual(Array.from(image.data), [0, 255]);
  });

  it('decodes a baseline JPEG into a flat frame', () => {
    const image = decodeJpegLuma(makeBaselineJpeg());
    assert.ok(image, 'baseline JPEG must decode');
    assert.equal(image.width, 8);
    assert.equal(image.height, 8);
    for (const value of image.data) {
      assert.equal(value, image.data[0], 'DC-only frame must be flat');
    }
  });

  it('returns null for progressive JPEGs and truncated data', () => {
    const progressive = makeBaselineJpeg();
    // SOF0 (0xC0) → SOF2 (0xC2): progressive, intentionally unsupported.
    for (let i = 0; i < progressive.length - 1; i++) {
      if (progressive[i] === 0xff && progressive[i + 1] === 0xc0) {
        progressive[i + 1] = 0xc2;
        break;
      }
    }
    assert.equal(decodeJpegLuma(progressive), null);
    assert.equal(decodeJpegLuma(new Uint8Array([0xff, 0xd8, 0xff])), null);
  });

  it('rejects JPEGs whose declared dimensions exceed the pixel cap', () => {
    const jpeg = makeBaselineJpeg();
    let sof = -1;
    for (let i = 0; i < jpeg.length - 1; i++) {
      if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) {
        sof = i;
        break;
      }
    }
    assert.ok(sof >= 0, 'SOF0 marker expected');
    const segStart = sof + 4; // marker (2) + segment length (2)
    jpeg[segStart + 1] = 0xff; // height hi
    jpeg[segStart + 2] = 0xff; // height lo
    jpeg[segStart + 3] = 0xff; // width hi
    jpeg[segStart + 4] = 0xff; // width lo
    assert.equal(decodeJpegLuma(jpeg), null);
  });
});

describe('extractPdfText', () => {
  it('normalizes extracted text to lowercase with collapsed whitespace', () => {
    const text = extractPdfText(makePdf('Hello    Flaxia'));
    assert.equal(text, 'hello flaxia');
  });

  it('returns null for non-PDF bytes and empty string for PDFs without text', () => {
    assert.equal(extractPdfText(encoder.encode('just text')), null);
    const empty = makePdf('x');
    assert.ok(extractPdfText(empty) !== null);
  });

  it('terminates when a backtick appears outside a string', () => {
    const text = extractPdfText(makePdf('a) Tj ` (b'));
    assert.equal(text, 'a b');
  });
});

describe('sha256 utility sanity', () => {
  it('noble sha256 agrees with the known vector used above', () => {
    assert.equal(
      bytesToHex(sha256(encoder.encode('abc'))),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
