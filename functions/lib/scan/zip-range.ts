/**
 * Read a ZIP's central directory with R2 range requests and hash its entry
 * list, without buffering the whole archive. Used for chunked uploads that are
 * too large for the Worker's 128MB isolate but still need structure-hash
 * blocklist coverage.
 */

import type { BlobStore } from '../ports/index.ts';
import { findEocd, zipStructureHashFromCentralDirectory } from './zip-list.ts';

/** Maximum EOCD search window (22-byte record + 64KiB comment). */
export const ZIP_EOCD_SCAN_BYTES = 22 + 0xffff;
/** The central directory itself is small; refuse a hostile oversized value. */
export const ZIP_MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

async function readBytes(store: BlobStore, key: string, offset: number, length: number): Promise<Uint8Array | null> {
  const object = await store.get(key, { range: { offset, length } });
  if (!object) return null;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  return bytes.byteLength === length ? bytes : null;
}

/**
 * Compute the same structure hash as `zipStructureHash()` for an object in
 * storage. Returns null when the object is not a ZIP, uses ZIP64 markers, or
 * the ranges cannot be read; callers fall back to sha256-only matching.
 */
export async function readZipStructureHash(store: BlobStore, key: string, knownSize?: number): Promise<string | null> {
  const total = knownSize ?? (await store.head(key))?.size ?? 0;
  if (total < 22) return null;

  const tailLength = Math.min(total, ZIP_EOCD_SCAN_BYTES);
  const tail = await readBytes(store, key, total - tailLength, tailLength);
  if (!tail) return null;

  const eocd = findEocd(tail);
  if (!eocd) return null;

  // ZIP64 is rejected by the archive policy elsewhere; do not guess here.
  if (eocd.cdEntries === 0xffff || eocd.cdSize === 0xffffffff || eocd.cdOffset === 0xffffffff) {
    return null;
  }
  if (eocd.cdSize === 0 || eocd.cdSize > ZIP_MAX_CENTRAL_DIRECTORY_BYTES) return null;
  if (eocd.cdOffset + eocd.cdSize > total) return null;

  const directory = await readBytes(store, key, eocd.cdOffset, eocd.cdSize);
  if (!directory) return null;

  return zipStructureHashFromCentralDirectory(directory, eocd.cdEntries);
}
