// Compact wire format for post embeddings used by the client-side recommender.
//
// The server never needs to understand a user's preference vector: it only
// ships public post embeddings to the browser, where the decrypted profile and
// the cosine similarity live. Embeddings are quantized to int8 with one scale
// per vector, which keeps a 1024-d candidate under 1.4 KB of JSON.

export const RECOMMENDATION_VECTOR_DIM = 1024;
export const RECOMMENDATION_VECTOR_ENCODING = 'int8';
const MAX_VECTOR_DIM = 4096;

export interface EncodedVector {
  scale: number;
  data: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Quantize a vector to int8 bytes plus one scale. Invalid values fail closed. */
export function encodeVector(vector: readonly number[]): EncodedVector | null {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_VECTOR_DIM) return null;
  let maxAbs = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    if (abs > maxAbs) maxAbs = abs;
  }
  if (!Number.isFinite(maxAbs)) return null;
  if (maxAbs === 0) return { scale: 0, data: bytesToB64(new Uint8Array(vector.length)) };

  const scale = maxAbs / 127;
  const bytes = new Uint8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const quantized = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)));
    bytes[i] = quantized & 0xff;
  }
  return { scale, data: bytesToB64(bytes) };
}

/** Decode int8 bytes back to floats. Returns null for a malformed/oversized value. */
export function decodeVector(encoded: EncodedVector | null | undefined, dim?: number): number[] | null {
  if (!encoded || typeof encoded.scale !== 'number' || typeof encoded.data !== 'string') return null;
  if (!Number.isFinite(encoded.scale) || encoded.scale < 0) return null;
  const bytes = b64ToBytes(encoded.data);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_VECTOR_DIM) return null;
  if (dim !== undefined && bytes.length !== dim) return null;

  const vector = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const signed = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
    vector[i] = signed * encoded.scale;
  }
  return vector;
}
