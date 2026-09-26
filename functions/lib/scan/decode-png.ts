// Baseline PNG luma decoder for pHash. Supports non-interlaced 8-bit
// gray(0)/RGB(2)/gray+alpha(4)/RGBA(6); anything else returns null and the
// caller falls back to sha256-only matching.
import { unzlibSync } from 'fflate';

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

// Cap on the raw (pre-unfilter) image size: the inflate output and the luma
// plane are both held in memory at once inside a 128MB Worker.
export const MAX_PNG_RAW_BYTES = 32 * 1024 * 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo the per-scanline filters in place. */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): void {
  const stride = width * channels;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = rowStart + 1;
    const prev = line - (stride + 1);
    for (let x = 0; x < stride; x++) {
      const i = line + x;
      const left = x >= channels ? raw[i - channels] : 0;
      const up = y > 0 ? raw[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? raw[prev + x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw[i];
          break;
        case 1:
          value = (raw[i] + left) & 0xff;
          break;
        case 2:
          value = (raw[i] + up) & 0xff;
          break;
        case 3:
          value = (raw[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (raw[i] + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter ${filter}`);
      }
      raw[i] = value;
    }
  }
}

/**
 * Decode a PNG to a luma plane, or null when the format is unsupported or the
 * image exceeds the memory budget for scanning.
 */
export function decodePngLuma(bytes: Uint8Array): GrayImage | null {
  try {
    if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) return null;

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let sawIhdr = false;
    const idat: Uint8Array[] = [];
    let idatLength = 0;

    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = readU32(bytes, offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const dataStart = offset + 8;
      if (dataStart + length + 4 > bytes.length) return null;

      if (type === 'IHDR') {
        width = readU32(bytes, dataStart);
        height = readU32(bytes, dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlace = bytes[dataStart + 12];
        sawIhdr = true;
      } else if (type === 'IDAT') {
        idat.push(bytes.subarray(dataStart, dataStart + length));
        idatLength += length;
      } else if (type === 'IEND') {
        break;
      }

      offset = dataStart + length + 4;
    }

    if (!sawIhdr || width <= 0 || height <= 0) return null;
    if (bitDepth !== 8) return null;
    const channels = CHANNELS[colorType];
    if (!channels) return null;
    if (interlace !== 0) return null;

    const rawSize = height * (width * channels + 1);
    if (rawSize <= 0 || rawSize > MAX_PNG_RAW_BYTES || idatLength === 0) return null;

    // Concatenate IDAT chunks, then inflate with a hard output ceiling.
    let compressed: Uint8Array;
    if (idat.length === 1) {
      compressed = idat[0];
    } else {
      compressed = new Uint8Array(idatLength);
      let pos = 0;
      for (const chunk of idat) {
        compressed.set(chunk, pos);
        pos += chunk.length;
      }
    }

    const raw = inflateChecked(compressed, rawSize);
    if (!raw || raw.length < rawSize) return null;
    unfilter(raw, width, height, channels);

    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += channels) {
      if (channels === 1 || channels === 2) {
        gray[i] = raw[p];
      } else {
        gray[i] = (raw[p] * 77 + raw[p + 1] * 150 + raw[p + 2] * 29) >> 8;
      }
    }
    return { data: gray, width, height };
  } catch {
    return null;
  }
}

/**
 * inflateSync with a fixed output buffer: the allocation is exactly the size a
 * valid PNG scan requires, so a decompression bomb can never grow past it
 * (fflate truncates to the provided buffer).
 */
function inflateChecked(compressed: Uint8Array, outSize: number): Uint8Array | null {
  try {
    return unzlibSync(compressed, { out: new Uint8Array(outSize) });
  } catch {
    return null;
  }
}
