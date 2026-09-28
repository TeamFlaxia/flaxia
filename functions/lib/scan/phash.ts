// Perceptual hash (pHash) for step 3: a 64-bit DCT hash over the 8x8
// low-frequency coefficients of the DCT of a 32x32 grayscale downscale.
//
// The transform runs over the whole 32x32 plane — the low-frequency block is
// selected *after* the DCT, so every region of the image contributes. Taking
// an 8x8 corner of the plane instead would hash only the top rows.
//
// Decoders in this folder produce plain luma planes; everything here is pure
// math so it is unit-testable without fixtures.

/** Downscale a grayscale plane to `size` x `size` by box averaging. */
export function resizeBox(gray: Uint8Array, width: number, height: number, size: number): Float64Array {
  const out = new Float64Array(size * size);
  if (width <= 0 || height <= 0) return out;
  for (let ty = 0; ty < size; ty++) {
    const sy0 = Math.floor((ty * height) / size);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / size));
    for (let tx = 0; tx < size; tx++) {
      const sx0 = Math.floor((tx * width) / size);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / size));
      let sum = 0;
      let count = 0;
      for (let y = sy0; y < sy1; y++) {
        const row = y * width;
        for (let x = sx0; x < sx1; x++) {
          sum += gray[row + x];
          count++;
        }
      }
      out[ty * size + tx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Cosine table for an N-point DCT-II: `table[u][x] = cos((2x+1)uπ / 2N)`. */
const COS_TABLES = new Map<number, Float64Array[]>();

function cosTable(size: number): Float64Array[] {
  const cached = COS_TABLES.get(size);
  if (cached) return cached;
  const table: Float64Array[] = [];
  for (let u = 0; u < size; u++) {
    const row = new Float64Array(size);
    for (let x = 0; x < size; x++) {
      row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
    }
    table.push(row);
  }
  COS_TABLES.set(size, table);
  return table;
}

function cFactor(u: number): number {
  return u === 0 ? Math.SQRT1_2 : 1;
}

/**
 * Top-left `outSize` x `outSize` coefficients of the orthonormal 2D DCT-II of
 * a `size` x `size` row-major plane. Separable: an N-point transform across
 * each row, then the same across each column, so the 32x32 → 8x8 case costs
 * 2 * N * outSize * N adds instead of N^4.
 */
export function dctLowFrequencies(plane: Float64Array, size: number, outSize = 8): Float64Array {
  const cos = cosTable(size);
  const rows = new Float64Array(size * outSize);
  for (let y = 0; y < size; y++) {
    const src = y * size;
    const dst = y * outSize;
    for (let u = 0; u < outSize; u++) {
      const kernel = cos[u];
      let sum = 0;
      for (let x = 0; x < size; x++) sum += plane[src + x] * kernel[x];
      rows[dst + u] = sum;
    }
  }
  const out = new Float64Array(outSize * outSize);
  const scale = 2 / size;
  for (let v = 0; v < outSize; v++) {
    const kernel = cos[v];
    for (let u = 0; u < outSize; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) sum += rows[y * outSize + u] * kernel[y];
      out[v * outSize + u] = scale * cFactor(u) * cFactor(v) * sum;
    }
  }
  return out;
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute the 64-bit pHash of a grayscale image. The plane is box-downscaled
 * to 32x32, transformed with a 2D DCT, and the top-left 8x8 low-frequency
 * coefficients are kept. Returns 16 lowercase hex chars: bit i is set when
 * coefficient i exceeds the median of those 64 coefficients (DC included).
 * Deterministic and self-consistent — only hashes produced by this function
 * should be compared against each other.
 */
export function computePhash(gray: Uint8Array, width: number, height: number): string {
  const small = resizeBox(gray, width, height, 32);
  const coeffs = dctLowFrequencies(small, 32);
  const threshold = median(coeffs);
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    if (coeffs[i] > threshold) {
      if (i < 32) hi |= 1 << (31 - i);
      else lo |= 1 << (63 - i);
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

/** Parse a 16-hex-char hash. Returns null for anything malformed. */
export function normalizePhash(value: string): string | null {
  return /^[0-9a-f]{16}$/i.test(value) ? value.toLowerCase() : null;
}

/** Hamming distance between two 16-hex-char hashes; 64 when malformed. */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let distance = 0;
  for (let i = 0; i < 16; i += 2) {
    const x = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
    distance += POPCOUNT[x];
  }
  return distance;
}

const POPCOUNT = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i;
    let count = 0;
    while (n) {
      count += n & 1;
      n >>= 1;
    }
    table[i] = count;
  }
  return table;
})();
