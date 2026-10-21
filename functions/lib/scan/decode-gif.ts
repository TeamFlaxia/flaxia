// GIF87a/89a luma decoder for pHash. Decodes only the first frame; palette
// images are converted to luma. Returns null for malformed or oversized GIFs.

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export const MAX_GIF_PIXELS = 16_000_000;

function grayFromPalette(palette: Uint8Array, index: number): number {
  const p = index * 3;
  if (p + 2 >= palette.length) return 0;
  return (palette[p] * 77 + palette[p + 1] * 150 + palette[p + 2] * 29) >> 8;
}

/** Decode the GIF LZW bitstream into indices (LSB-first, clear-code aware). */
function lzwDecode(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array | null {
  if (minCodeSize < 2 || minCodeSize > 8) return null;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  // Dictionary as prefix/suffix chains: code -> prefix code + trailing byte.
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const stack: number[] = [];

  const out = new Uint8Array(expected + 1);
  let outPos = 0;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let prev = -1;

  let bitPos = 0;
  const bitLength = data.length * 8;

  const readCode = (): number => {
    if (bitPos + codeSize > bitLength) return -1;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    return code;
  };

  /** First byte of a dictionary entry without writing it; -1 when invalid. */
  const firstByteOf = (code: number): number => {
    let c = code;
    for (let guard = 0; guard < 4096; guard++) {
      if (c < clearCode) return c;
      if (c >= nextCode || prefix[c] < 0) return -1;
      c = prefix[c];
    }
    return -1;
  };

  /** Write every byte of an entry; returns its first byte or -1 on error. */
  const writeEntry = (code: number): number => {
    if (code < clearCode) {
      if (outPos >= out.length) return -1;
      out[outPos++] = code;
      return code;
    }
    stack.length = 0;
    let c = code;
    for (let guard = 0; guard < 4096; guard++) {
      if (c < clearCode) break;
      if (c >= nextCode || prefix[c] < 0) return -1;
      stack.push(suffix[c]);
      c = prefix[c];
    }
    if (c >= clearCode) return -1;
    if (outPos + stack.length + 1 > out.length) return -1;
    out[outPos++] = c;
    for (let i = stack.length - 1; i >= 0; i--) out[outPos++] = stack[i];
    return c;
  };

  for (;;) {
    const code = readCode();
    if (code < 0 || code === endCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      prev = -1;
      continue;
    }

    if (prev < 0) {
      // The first code after a clear (or at stream start) must be a literal.
      if (code >= clearCode) return null;
      if (outPos >= out.length) return null;
      out[outPos++] = code;
      prev = code;
      continue;
    }

    let firstChar: number;
    if (code < nextCode) {
      firstChar = writeEntry(code);
      if (firstChar < 0) return null;
    } else if (code === nextCode) {
      // KwKwK: the entry currently being defined is prev + firstByte(prev).
      const root = firstByteOf(prev);
      if (root < 0) return null;
      firstChar = writeEntry(prev);
      if (firstChar < 0) return null;
      if (outPos >= out.length) return null;
      out[outPos++] = root;
    } else {
      return null; // code never defined
    }

    // dict[next] = prev + firstByte(current entry)
    if (nextCode < 4096) {
      prefix[nextCode] = prev;
      suffix[nextCode] = firstChar;
      nextCode++;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }

    prev = code;
    if (outPos > expected) return null; // overproduced: malformed stream
  }

  if (outPos !== expected) return null;
  return out;
}

/** Parse a GIF and decode the first frame to a luma plane, or null. */
export function decodeGifLuma(bytes: Uint8Array): GrayImage | null {
  try {
    if (bytes.length < 13) return null;
    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;

    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (width <= 0 || height <= 0) return null;
    if (width * height > MAX_GIF_PIXELS) return null;

    const packed = bytes[10];
    let offset = 13;
    let palette: Uint8Array | null = null;

    if (packed & 0x80) {
      const tableSize = 2 << (packed & 0x07);
      palette = bytes.subarray(offset, offset + tableSize * 3);
      offset += tableSize * 3;
    }

    let imageSet = false;
    let outWidth = 0;
    let outHeight = 0;
    let indices: Uint8Array | null = null;
    let interlaced = false;
    let localPalette: Uint8Array | null = null;

    while (offset < bytes.length) {
      const block = bytes[offset];

      if (block === 0x3b) break; // trailer

      if (block === 0x21) {
        // Extension: label + sub-blocks.
        offset += 2;
        while (offset < bytes.length && bytes[offset] !== 0) {
          offset += 1 + bytes[offset];
        }
        offset++;
        continue;
      }

      if (block === 0x2c) {
        if (imageSet) {
          // Only the first frame matters; stop here.
          break;
        }
        const left = bytes[offset + 1] | (bytes[offset + 2] << 8);
        const top = bytes[offset + 3] | (bytes[offset + 4] << 8);
        const iw = bytes[offset + 5] | (bytes[offset + 6] << 8);
        const ih = bytes[offset + 7] | (bytes[offset + 8] << 8);
        const ipacked = bytes[offset + 9];
        offset += 10;

        if (iw <= 0 || ih <= 0) return null;
        if (left + iw > width || top + ih > height) return null;
        if (iw * ih > MAX_GIF_PIXELS) return null;

        if (ipacked & 0x80) {
          const tableSize = 2 << (ipacked & 0x07);
          localPalette = bytes.subarray(offset, offset + tableSize * 3);
          offset += tableSize * 3;
        }
        interlaced = (ipacked & 0x40) !== 0;

        const minCodeSize = bytes[offset];
        offset++;
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (offset < bytes.length && bytes[offset] !== 0) {
          const len = bytes[offset];
          chunks.push(bytes.subarray(offset + 1, offset + 1 + len));
          total += len;
          offset += 1 + len;
        }
        offset++; // block terminator

        let compressed: Uint8Array;
        if (chunks.length === 1) {
          compressed = chunks[0];
        } else {
          compressed = new Uint8Array(total);
          let pos = 0;
          for (const chunk of chunks) {
            compressed.set(chunk, pos);
            pos += chunk.length;
          }
        }

        indices = lzwDecode(compressed, minCodeSize, iw * ih);
        if (!indices) return null;
        outWidth = iw;
        outHeight = ih;
        imageSet = true;
        continue;
      }

      return null; // unknown block
    }

    if (!imageSet || !indices) return null;
    const activePalette = localPalette ?? palette;
    if (!activePalette) return null;

    const gray = new Uint8Array(outWidth * outHeight);
    const passes = interlaced ? [0, 4, 2, 1] : null;
    const deltas = interlaced ? [8, 8, 4, 2] : null;
    for (let y = 0; y < outHeight; y++) {
      let srcRow = y;
      if (passes && deltas) {
        // GIF interlace: rows come in four passes.
        if (y < (outHeight + 7) >> 3) srcRow = y * 8;
        else if (y < ((outHeight + 3) >> 3) + ((outHeight + 7) >> 3)) srcRow = 4 + (y - ((outHeight + 7) >> 3)) * 8;
        else if (y < ((outHeight + 1) >> 1) + ((outHeight + 3) >> 3) + ((outHeight + 7) >> 3)) {
          srcRow = 2 + (y - (((outHeight + 3) >> 3) + ((outHeight + 7) >> 3))) * 4;
        } else {
          srcRow = 1 + (y - (((outHeight + 1) >> 1) + ((outHeight + 3) >> 3) + ((outHeight + 7) >> 3))) * 2;
        }
        srcRow = Math.min(srcRow, outHeight - 1);
      }
      for (let x = 0; x < outWidth; x++) {
        gray[y * outWidth + x] = grayFromPalette(activePalette, indices[srcRow * outWidth + x]);
      }
    }

    return { data: gray, width: outWidth, height: outHeight };
  } catch {
    return null;
  }
}
