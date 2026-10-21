// Unit tests for the perceptual hash math in functions/lib/scan/phash.ts.
//
// The hash is the only sync feature that matches files "by likeness", so these
// tests pin the algorithm two ways: against an independent O(N^4) DCT-II
// reference (so a refactor cannot silently change every stored hash) and
// against perceptual properties (near-identical images stay inside the
// blocklist threshold, unrelated ones do not).
import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computePhash,
  dctLowFrequencies,
  hammingDistance,
  normalizePhash,
  resizeBox,
} from '../functions/lib/scan/phash.ts';

// ── independent reference implementations ────────────────────────────────────

/** Orthonormal 2D DCT-II, written the slow O(N^4) way on purpose. */
function referenceDct(plane: Float64Array, size: number, outSize = 8): Float64Array {
  const out = new Float64Array(outSize * outSize);
  const factor = (k: number) => (k === 0 ? Math.SQRT1_2 : 1);
  for (let v = 0; v < outSize; v++) {
    for (let u = 0; u < outSize; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          sum +=
            plane[y * size + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      out[v * outSize + u] = (2 / size) * factor(u) * factor(v) * sum;
    }
  }
  return out;
}

/** Box downscale to `size` x `size`, mirroring the documented cell bounds. */
function referenceResize(gray: Uint8Array, width: number, height: number, size: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor((ty * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / size));
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor((tx * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / size));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * width + x];
          count++;
        }
      }
      out[ty * size + tx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Coefficients below this fraction of the strongest are treated as zero. */
const NOISE_FLOOR = 1e-9;

/** The documented pHash pipeline, assembled from the references above. */
function referenceHash(gray: Uint8Array, width: number, height: number): string {
  const coeffs = referenceDct(referenceResize(gray, width, height, 32), 32);
  let strongest = 0;
  for (const value of coeffs) strongest = Math.max(strongest, Math.abs(value));
  const floor = strongest * NOISE_FLOOR;
  for (let i = 0; i < 64; i++) {
    if (Math.abs(coeffs[i]) <= floor) coeffs[i] = 0;
  }
  const sorted = Float64Array.from(coeffs).sort();
  const median = (sorted[31] + sorted[32]) / 2;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    if (coeffs[i] > median + floor) {
      if (i < 32) hi |= 1 << (31 - i);
      else lo |= 1 << (63 - i);
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

function assertClose(actual: Float64Array, expected: Float64Array, tolerance = 1e-9): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `coefficient ${i}: ${actual[i]} is not within ${tolerance} of ${expected[i]}`,
    );
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random plane (LCG), so failures reproduce. */
function pseudoRandom(length: number, seed = 1): Float64Array {
  const out = new Float64Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out[i] = state / 2147483648;
  }
  return out;
}

/** A smooth, photo-like plane: a bright radial blob on a dark field. */
function blob(width = 64, height = 64, cx = 32, cy = 32): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      out[y * width + x] = Math.max(0, Math.min(200, Math.round(180 - (dx * dx + dy * dy) / 6)));
    }
  }
  return out;
}

/** Diagonal stripes — high-frequency content, unrelated to a blob. */
function stripes(width = 64, height = 64): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = Math.round(128 + 100 * Math.sin((x + y) / 3));
  }
  return out;
}

/** Shift a plane by (dx, dy) with edge clamping. */
function translate(gray: Uint8Array, width: number, height: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(width - 1, x - dx));
      const sy = Math.max(0, Math.min(height - 1, y - dy));
      out[y * width + x] = gray[sy * width + sx];
    }
  }
  return out;
}

/** Nearest-neighbour resample by an integer factor. */
function scale(gray: Uint8Array, width: number, height: number, factor: number): Uint8Array {
  const out = new Uint8Array(width * factor * height * factor);
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < width * factor; x++) {
      out[y * width * factor + x] = gray[Math.floor(y / factor) * width + Math.floor(x / factor)];
    }
  }
  return out;
}

// ── resizeBox ────────────────────────────────────────────────────────────────

describe('resizeBox', () => {
  it('box-averages each source cell into the target grid', () => {
    const gray = new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0]);
    const out = resizeBox(gray, 4, 4, 2);
    assert.deepEqual(Array.from(out), [0, 255, 255, 0]);
  });

  it('assigns source pixels to target cells by floor boundaries', () => {
    // 3x1 → 2x1: the cells are [0] and [1,2] (floor-split, not an even split).
    const out = resizeBox(new Uint8Array([0, 1, 2]), 3, 1, 2);
    assert.equal(out.length, 4);
    assert.equal(out[0], 0);
    assert.equal(out[1], 1.5);
  });

  it('replicates cells when upscaling a smaller plane', () => {
    const out = resizeBox(new Uint8Array([10, 20, 30, 40]), 2, 2, 4);
    assert.deepEqual(Array.from(out), [10, 10, 20, 20, 10, 10, 20, 20, 30, 30, 40, 40, 30, 30, 40, 40]);
  });

  it('returns a zero plane for empty dimensions', () => {
    assert.deepEqual(Array.from(resizeBox(new Uint8Array(0), 0, 0, 2)), [0, 0, 0, 0]);
    assert.equal(resizeBox(new Uint8Array(4), 2, 2, 3).length, 9);
  });

  it('matches the independent reference for several shapes', () => {
    for (const [w, h] of [
      [32, 32],
      [64, 48],
      [7, 13],
    ]) {
      const gray = Uint8Array.from(pseudoRandom(w * h, w + h), (v) => Math.round(v * 255));
      assertClose(resizeBox(gray, w, h, 32), referenceResize(gray, w, h, 32), 1e-9);
    }
  });
});

// ── dctLowFrequencies ────────────────────────────────────────────────────────

describe('dctLowFrequencies', () => {
  it('matches the O(N^4) reference for 8x8 and 32x32 planes', () => {
    for (const size of [8, 32]) {
      const plane = pseudoRandom(size * size, size);
      assertClose(dctLowFrequencies(plane, size), referenceDct(plane, size), 1e-9);
    }
  });

  it('keeps only the requested number of low frequencies', () => {
    const plane = pseudoRandom(32 * 32, 7);
    assert.equal(dctLowFrequencies(plane, 32).length, 64);
    assert.equal(dctLowFrequencies(plane, 32, 4).length, 16);
    const four = dctLowFrequencies(plane, 32, 4);
    const eight = dctLowFrequencies(plane, 32, 8);
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        assert.ok(Math.abs(four[v * 4 + u] - eight[v * 8 + u]) < 1e-9, 'the top-left block must be shared');
      }
    }
  });

  it('reduces a constant plane to DC and numerical noise elsewhere', () => {
    const size = 32;
    const mean = 7.5;
    const coeffs = dctLowFrequencies(new Float64Array(size * size).fill(mean), size);
    // The orthonormal DC coefficient of a constant plane is size * mean.
    assert.ok(Math.abs(coeffs[0] - size * mean) < 1e-6, `DC should be ${size * mean}, got ${coeffs[0]}`);
    for (let i = 1; i < 64; i++) assert.ok(Math.abs(coeffs[i]) < 1e-6, `coefficient ${i} should be flat`);
  });

  it('isolates a single-frequency input into one coefficient', () => {
    const size = 32;
    const u0 = 3;
    const plane = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        plane[y * size + x] = Math.cos(((2 * x + 1) * u0 * Math.PI) / (2 * size));
      }
    }
    const coeffs = dctLowFrequencies(plane, size);
    // Horizontal frequency u0, vertical frequency 0: value N / sqrt(2).
    assert.ok(Math.abs(coeffs[u0] - size * Math.SQRT1_2) < 1e-6, `expected energy at [0][${u0}]`);
    for (let i = 0; i < 64; i++) {
      if (i !== u0) assert.ok(Math.abs(coeffs[i]) < 1e-6, `coefficient ${i} should stay empty`);
    }
  });

  it('reads the whole plane, not a corner of it', () => {
    // A block in the bottom-right must move a low-frequency coefficient.
    const size = 32;
    const flat = new Float64Array(size * size).fill(128);
    const withBlock = Float64Array.from(flat);
    for (let y = 24; y < 32; y++) {
      for (let x = 24; x < 32; x++) withBlock[y * size + x] = 0;
    }
    const flatCoeffs = dctLowFrequencies(flat, size);
    const blockCoeffs = dctLowFrequencies(withBlock, size);
    let moved = 0;
    for (let i = 0; i < 64; i++) if (Math.abs(flatCoeffs[i] - blockCoeffs[i]) > 1e-6) moved++;
    assert.ok(moved > 0, 'bottom-right content must reach the low-frequency block');
  });
});

// ── computePhash ─────────────────────────────────────────────────────────────

describe('computePhash', () => {
  it('produces the documented 16-hex format and is deterministic', () => {
    const gray = new Uint8Array(32 * 32);
    for (let i = 0; i < gray.length; i++) gray[i] = i % 256;
    const hash = computePhash(gray, 32, 32);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(hash, computePhash(gray, 32, 32));
  });

  it('matches the independent reference exactly', () => {
    // The reference shares the noise floor rule, which is what keeps the two
    // summation orders from disagreeing on a coefficient that lands on the
    // median (the stripes case below does exactly that).
    const cases: Array<[string, Uint8Array, number, number]> = [
      ['blob', blob(64, 64), 64, 64],
      ['stripes', stripes(64, 64), 64, 64],
      ['random', Uint8Array.from(pseudoRandom(48 * 40, 11), (v) => Math.round(v * 255)), 48, 40],
      ['flat', new Uint8Array(32 * 32).fill(128), 32, 32],
      ['black', new Uint8Array(32 * 32), 32, 32],
    ];
    for (const [name, gray, width, height] of cases) {
      assert.equal(computePhash(gray, width, height), referenceHash(gray, width, height), name);
    }
  });

  it('canonicalizes flat images', () => {
    // Without the noise floor the flat plane's rounding noise decided the bits.
    assert.equal(computePhash(new Uint8Array(32 * 32).fill(128), 32, 32), '8000000000000000');
    assert.equal(computePhash(new Uint8Array(32 * 32).fill(1), 32, 32), '8000000000000000');
    assert.equal(computePhash(new Uint8Array(32 * 32), 32, 32), '0000000000000000');
    // Only DC moves with brightness, so the hash is unchanged.
    assert.equal(
      hammingDistance(
        computePhash(new Uint8Array(32 * 32).fill(128), 32, 32),
        computePhash(new Uint8Array(32 * 32).fill(200), 32, 32),
      ),
      0,
    );
  });

  it('does not let a coefficient exactly on the median flip on rounding noise', () => {
    // Diagonal stripes produce a pair of coefficients equal to the median; the
    // hash must equal the independently computed one (see the reference test
    // above) and stay stable when the plane is recomputed.
    const photo = stripes(64, 64);
    const hash = computePhash(photo, 64, 64);
    assert.equal(hash, referenceHash(photo, 64, 64));
    assert.equal(hash, computePhash(stripes(64, 64), 64, 64));
  });

  it('reads the whole image, not only its top rows', () => {
    // Regression guard: the 8x8 block must come from a DCT over the full 32x32
    // plane. Two images sharing only a top band used to hash identically.
    const plane = (below: (x: number, y: number) => number): Uint8Array => {
      const out = new Uint8Array(256 * 256);
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) out[y * 256 + x] = y < 16 ? 255 : below(x, y);
      }
      return out;
    };
    const a = computePhash(
      plane((x, y) => (x + y) % 256),
      256,
      256,
    );
    const b = computePhash(
      plane((x, y) => (x * 7 + y * 13) % 256),
      256,
      256,
    );
    assert.notEqual(a, b);
    assert.ok(hammingDistance(a, b) > 8, 'unrelated content below a shared top band must not match');

    // Content confined to the lower half must move the hash too.
    const base = new Uint8Array(64 * 64);
    for (let i = 0; i < base.length; i++) base[i] = (i % 64) * 4;
    const bottomChanged = Uint8Array.from(base);
    for (let y = 32; y < 64; y++) {
      for (let x = 0; x < 64; x++) bottomChanged[y * 64 + x] = 255 - bottomChanged[y * 64 + x];
    }
    assert.notEqual(computePhash(base, 64, 64), computePhash(bottomChanged, 64, 64));
  });

  it('stays close for near-identical images', () => {
    const photo = blob(64, 64);
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const noisy = Uint8Array.from(photo, (v) => Math.max(0, Math.min(255, v + Math.round((random() - 0.5) * 8))));
    const brighter = Uint8Array.from(photo, (v) => v + 12);

    const hash = computePhash(photo, 64, 64);
    assert.ok(hammingDistance(hash, computePhash(noisy, 64, 64)) <= 8, 'noise must stay inside the threshold');
    assert.ok(hammingDistance(hash, computePhash(brighter, 64, 64)) <= 8, 'brightness shift must stay inside it');
  });

  it('ignores a uniform brightness shift exactly', () => {
    // DCT is linear, so a constant offset only moves DC — which stays the
    // largest coefficient, so no bit flips at all.
    const photo = blob(64, 64);
    const brighter = Uint8Array.from(photo, (v) => v + 12);
    assert.equal(hammingDistance(computePhash(photo, 64, 64), computePhash(brighter, 64, 64)), 0);
  });

  it('is stable under a small translation', () => {
    const photo = blob(64, 64);
    const shifted = translate(photo, 64, 64, 3, 2);
    assert.ok(
      hammingDistance(computePhash(photo, 64, 64), computePhash(shifted, 64, 64)) <= 8,
      'a few pixels of shift must not change the match',
    );
  });

  it('is stable under resampling', () => {
    const photo = blob(64, 64);
    const doubled = scale(photo, 64, 64, 2);
    assert.ok(
      hammingDistance(computePhash(photo, 64, 64), computePhash(doubled, 128, 128)) <= 8,
      'a 2x rescale must not change the match',
    );
  });

  it('separates unrelated images', () => {
    const a = computePhash(blob(64, 64), 64, 64);
    const b = computePhash(stripes(64, 64), 64, 64);
    assert.ok(hammingDistance(a, b) > 8, 'a blob and stripes must not collide');
  });

  it('handles tiny and non-square inputs without throwing', () => {
    for (const [w, h] of [
      [1, 1],
      [2, 9],
      [64, 1],
    ]) {
      const hash = computePhash(new Uint8Array(w * h).fill(90), w, h);
      assert.match(hash, /^[0-9a-f]{16}$/);
    }
  });
});

// ── hash string helpers ──────────────────────────────────────────────────────

describe('normalizePhash', () => {
  it('lowercases valid hashes and rejects anything else', () => {
    assert.equal(normalizePhash('ABCDEF0123456789'), 'abcdef0123456789');
    assert.equal(normalizePhash('abcdef0123456789'), 'abcdef0123456789');
    assert.equal(normalizePhash('abcdef012345678'), null, '15 chars');
    assert.equal(normalizePhash('abcdef01234567890'), null, '17 chars');
    assert.equal(normalizePhash('zzcdef0123456789'), null, 'non-hex');
    assert.equal(normalizePhash(''), null);
    assert.equal(normalizePhash('abcdef01-2345678'), null);
  });
});

describe('hammingDistance', () => {
  it('counts differing bits across the hex digits', () => {
    assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
    assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
    assert.equal(hammingDistance('0000000000000000', '8000000000000000'), 1);
    assert.equal(hammingDistance('0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'), 64);
    assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
  });

  it('is symmetric', () => {
    const a = '0123456789abcdef';
    const b = 'fedcba9876543210';
    assert.equal(hammingDistance(a, b), hammingDistance(b, a));
  });

  it('returns the maximum for malformed input', () => {
    assert.equal(hammingDistance('ffffffffffffffff', 'nothex0000000000'), 64);
    assert.equal(hammingDistance('short', 'ffffffffffffffff'), 64);
  });
});
