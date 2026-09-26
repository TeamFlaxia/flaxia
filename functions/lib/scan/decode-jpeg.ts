// Baseline (SOF0/SOF1) JPEG luma decoder for pHash. Progressively coded,
// arithmetic-coded and 12-bit files return null and the caller falls back to
// sha256-only matching.
//
// Only the luma plane is materialized; chroma blocks are entropy-decoded to
// keep the bitstream in sync but never inverse-transformed.

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** zigzag scan position -> natural (row-major) index in an 8x8 block */
const ZZ_TO_NATURAL = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

const COS: Float64Array[] = (() => {
  const table: Float64Array[] = [];
  for (let u = 0; u < 8; u++) {
    const row = new Float64Array(8);
    for (let x = 0; x < 8; x++) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    table.push(row);
  }
  return table;
})();

const C_FACTOR = [Math.SQRT1_2, 1, 1, 1, 1, 1, 1, 1];

interface HuffTable {
  /** key: (length << 16) | code -> symbol */
  codes: Map<number, number>;
}

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  tq: number;
  dcTable: number;
  acTable: number;
  pred: number;
}

function buildHuffTable(counts: Uint8Array, symbols: Uint8Array): HuffTable {
  const codes = new Map<number, number>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1] && k < symbols.length; i++) {
      codes.set((len << 16) | code, symbols[k]);
      code++;
      k++;
    }
    code <<= 1;
  }
  return { codes };
}

class BitReader {
  private data: Uint8Array;
  pos: number;
  private bits = 0;
  private nbits = 0;
  /** set once a marker (rather than stuffed data) terminated the scan */
  ended = false;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.pos = start;
  }

  /** Read one entropy byte, handling FF00 stuffing and rejecting markers. */
  private readByte(): number {
    if (this.pos >= this.data.length) {
      this.ended = true;
      return 0;
    }
    const b = this.data[this.pos++];
    if (b !== 0xff) return b;
    while (this.pos < this.data.length && this.data[this.pos] === 0xff) this.pos++;
    if (this.pos >= this.data.length) {
      this.ended = true;
      return 0;
    }
    if (this.data[this.pos] === 0x00) {
      this.pos++;
      return 0xff;
    }
    this.ended = true;
    this.pos--; // leave the marker for the restart/end logic
    return 0;
  }

  readBit(): number {
    if (this.nbits === 0) {
      if (this.ended) return 0;
      this.bits = this.readByte();
      this.nbits = 8;
      if (this.ended) return 0;
    }
    this.nbits--;
    return (this.bits >> this.nbits) & 1;
  }

  receive(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | this.readBit();
    return value;
  }

  /** JPEG magnitude extension: map an n-bit value to its signed form. */
  extend(value: number, n: number): number {
    return value < 1 << (n - 1) ? value - (1 << n) + 1 : value;
  }

  align(): void {
    this.nbits = 0;
    this.bits = 0;
  }
}

function decodeHuff(reader: BitReader, table: HuffTable | undefined): number {
  if (!table) return -1;
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | reader.readBit();
    if (reader.ended) return -1;
    const symbol = table.codes.get((len << 16) | code);
    if (symbol !== undefined) return symbol;
  }
  return -1;
}

/** Orthonormal 8x8 IDCT into an 8x8 region of `out` (clamped, level-shifted). */
function idctBlock(
  natural: Float64Array,
  out: Uint8Array,
  stride: number,
  offset: number,
  availCols: number,
  availRows: number,
): void {
  const block = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum += natural[y * 8 + x] * COS[u][x] * COS[v][y];
        }
      }
      block[v * 8 + u] = 0.25 * C_FACTOR[u] * C_FACTOR[v] * sum;
    }
  }
  const cols = Math.min(8, availCols);
  const rows = Math.min(8, availRows);
  for (let y = 0; y < rows; y++) {
    const rowStart = offset + y * stride;
    for (let x = 0; x < cols; x++) {
      const value = block[y * 8 + x] + 128;
      out[rowStart + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

/**
 * Decode a baseline JPEG to a luma plane, or null when the encoding is
 * unsupported or the file is malformed.
 */
export function decodeJpegLuma(bytes: Uint8Array): GrayImage | null {
  try {
    return decode(bytes);
  } catch {
    return null;
  }
}

function decode(bytes: Uint8Array): GrayImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let width = 0;
  let height = 0;
  const quantTables: (Float64Array | null)[] = [null, null, null, null];
  const dcTables: (HuffTable | undefined)[] = [];
  const acTables: (HuffTable | undefined)[] = [];
  let components: FrameComponent[] = [];
  let restartInterval = 0;
  let pos = 2;

  const readU16 = (p: number): number => (bytes[p] << 8) | bytes[p + 1];

  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    let marker = bytes[pos + 1];
    while (marker === 0xff && pos + 2 < bytes.length) {
      pos++;
      marker = bytes[pos + 1];
    }
    pos += 2;

    if (marker === 0xd9) break; // EOI
    if (marker === 0xd8) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (pos + 2 > bytes.length) return null;
    const length = readU16(pos);
    if (length < 2 || pos + length > bytes.length) return null;
    const segStart = pos + 2;
    const segEnd = pos + length;

    if (marker === 0xc0 || marker === 0xc1) {
      if (bytes[segStart] !== 8) return null; // not 8-bit
      height = readU16(segStart + 1);
      width = readU16(segStart + 3);
      const ncomp = bytes[segStart + 5];
      if (width <= 0 || height <= 0 || ncomp < 1) return null;
      components = [];
      for (let i = 0; i < ncomp; i++) {
        const p = segStart + 6 + i * 3;
        components.push({
          id: bytes[p],
          h: bytes[p + 1] >> 4 || 1,
          v: bytes[p + 1] & 0xf || 1,
          tq: bytes[p + 2],
          dcTable: 0,
          acTable: 0,
          pred: 0,
        });
      }
    } else if (marker === 0xc2 || (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8)) {
      return null; // progressive / differential / lossless
    } else if (marker === 0xcc) {
      return null; // arithmetic coding
    } else if (marker === 0xdb) {
      let p = segStart;
      while (p < segEnd) {
        const pq = bytes[p] >> 4;
        const tq = bytes[p] & 0xf;
        p++;
        if (pq !== 0 || tq > 3 || p + 64 > segEnd) return null;
        const table = new Float64Array(64);
        for (let i = 0; i < 64; i++) table[i] = bytes[p + i];
        quantTables[tq] = table;
        p += 64;
      }
    } else if (marker === 0xc4) {
      let p = segStart;
      while (p < segEnd) {
        const tc = bytes[p] >> 4;
        const th = bytes[p] & 0xf;
        p++;
        if (th > 3 || p + 16 > segEnd) return null;
        const counts = bytes.slice(p, p + 16);
        p += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        if (p + total > segEnd) return null;
        const table = buildHuffTable(counts, bytes.slice(p, p + total));
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
        p += total;
      }
    } else if (marker === 0xdd) {
      restartInterval = readU16(segStart);
    } else if (marker === 0xda) {
      const ncompScan = bytes[segStart];
      if (ncompScan < 1) return null;
      const scanIds: number[] = [];
      for (let i = 0; i < ncompScan; i++) {
        const p = segStart + 1 + i * 2;
        const id = bytes[p];
        const tableIds = bytes[p + 1];
        const comp = components.find((c) => c.id === id);
        if (!comp) return null;
        comp.dcTable = tableIds >> 4;
        comp.acTable = tableIds & 0xf;
        scanIds.push(id);
      }
      if (!width || components.length !== ncompScan) return null;
      // Baseline frames carry a single scan covering every component.
      const ordered = scanIds.map((id) => components.find((c) => c.id === id)).filter((c): c is FrameComponent => !!c);
      if (ordered.length !== components.length) return null;
      return decodeScan(bytes, segEnd, ordered, quantTables, dcTables, acTables, width, height, restartInterval);
    }
    // APPn/COM/unknown parameterless markers: skip

    pos = segEnd;
  }

  return null;
}

function decodeScan(
  bytes: Uint8Array,
  scanStart: number,
  comps: FrameComponent[],
  quantTables: (Float64Array | null)[],
  dcTables: (HuffTable | undefined)[],
  acTables: (HuffTable | undefined)[],
  width: number,
  height: number,
  restartInterval: number,
): GrayImage | null {
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcuW = 8 * maxH;
  const mcuH = 8 * maxV;
  const mcusX = Math.ceil(width / mcuW);
  const mcusY = Math.ceil(height / mcuH);
  const luma = new Uint8Array(width * height);
  const lumaComp = comps[0];

  const reader = new BitReader(bytes, scanStart);
  const zz = new Float64Array(64); // zigzag-indexed, quantized
  const natural = new Float64Array(64);

  const readBlock = (comp: FrameComponent): boolean => {
    const qtab = quantTables[comp.tq];
    if (!qtab) return false;
    zz.fill(0);

    const dcSym = decodeHuff(reader, dcTables[comp.dcTable]);
    if (dcSym < 0 || dcSym > 11) return false;
    if (dcSym > 0) {
      const diff = reader.extend(reader.receive(dcSym), dcSym);
      comp.pred += diff;
    }
    zz[0] = comp.pred * qtab[0];

    const acTable = acTables[comp.acTable];
    if (!acTable) return false;
    let k = 1;
    while (k < 64) {
      const sym = decodeHuff(reader, acTable);
      if (sym < 0) return false;
      const run = sym >> 4;
      const size = sym & 15;
      if (size === 0) {
        if (run === 15) {
          k += 16;
          continue;
        }
        break; // end of block
      }
      k += run;
      if (k > 63) return false;
      zz[k] = reader.extend(reader.receive(size), size) * qtab[k];
      k++;
    }
    return true;
  };

  const resetPredictors = (): void => {
    for (const comp of comps) comp.pred = 0;
  };

  /** Consume a restart marker at a restart boundary; no-op when absent. */
  const consumeRestart = (): void => {
    reader.align();
    let guard = 0;
    while (reader.pos < bytes.length && bytes[reader.pos] !== 0xff && guard++ < 16) reader.pos++;
    // Skip FF fill bytes before the marker itself.
    while (reader.pos + 1 < bytes.length && bytes[reader.pos] === 0xff && bytes[reader.pos + 1] === 0xff) {
      reader.pos++;
    }
    if (reader.pos + 1 < bytes.length && bytes[reader.pos] === 0xff) {
      const m = bytes[reader.pos + 1];
      if (m >= 0xd0 && m <= 0xd7) {
        reader.pos += 2;
        resetPredictors();
      }
    }
  };

  let mcuIndex = 0;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && mcuIndex > 0 && mcuIndex % restartInterval === 0) {
        consumeRestart();
        if (reader.ended) return null;
      }

      for (const comp of comps) {
        for (let bv = 0; bv < comp.v; bv++) {
          for (let bh = 0; bh < comp.h; bh++) {
            if (!readBlock(comp)) return null;
            if (comp !== lumaComp) continue;

            natural.fill(0);
            for (let i = 0; i < 64; i++) natural[ZZ_TO_NATURAL[i]] = zz[i];
            const blockX = mx * comp.h + bh;
            const blockY = my * comp.v + bv;
            const x0 = blockX * 8;
            const y0 = blockY * 8;
            if (x0 >= width || y0 >= height) continue;
            idctBlock(natural, luma, width, y0 * width + x0, width - x0, height - y0);
          }
        }
      }
      mcuIndex++;
    }
  }

  return { data: luma, width, height };
}
