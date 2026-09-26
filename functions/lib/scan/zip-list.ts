// Step 3 (ZIP): read the central directory without decompressing anything, so
// the archive's structure — entry names, sizes, CRCs — becomes a stable hash.
// Two archives whose payloads are re-compressed differently still share a
// structure hash; payloads that differ change their CRCs.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Mirrors the game ZIP limits in src/lib/zip-constants.ts (defensive cap). */
export const MAX_ZIP_ENTRIES = 4096;
export const MAX_ZIP_PATH = 255;

export interface ZipListEntry {
  name: string;
  size: number;
  compressedSize: number;
  crc32: number;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Locate the end-of-central-directory record (searching the comment area). */
function findEocd(bytes: Uint8Array): { cdOffset: number; cdSize: number; cdEntries: number } | null {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i);
      return {
        cdEntries: readU16(view, 8),
        cdSize: readU32(view, 12),
        cdOffset: readU32(view, 16),
      };
    }
  }
  return null;
}

/**
 * Parse the central directory of a ZIP. Returns null when the archive is not
 * parseable (the caller keeps sha256-only features in that case).
 */
export function listZipEntries(bytes: Uint8Array): ZipListEntry[] | null {
  const eocd = findEocd(bytes);
  if (!eocd) return null;
  const cdEnd = eocd.cdOffset + eocd.cdSize;
  if (eocd.cdOffset >= bytes.length || cdEnd > bytes.length) return null;
  if (eocd.cdEntries > MAX_ZIP_ENTRIES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const entries: ZipListEntry[] = [];
  let offset = eocd.cdOffset;

  for (let i = 0; i < eocd.cdEntries; i++) {
    if (offset + 46 > bytes.length) return null;
    if (readU32(view, offset) !== 0x02014b50) return null;

    const crc32 = readU32(view, offset + 16);
    const compressedSize = readU32(view, offset + 20);
    const size = readU32(view, offset + 24);
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    if (offset + 46 + nameLen > bytes.length) return null;

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    if (name.length > MAX_ZIP_PATH) return null;

    entries.push({ name, size, compressedSize, crc32 });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Stable hash of an archive's entry list. Records are length-prefixed so entry
 * names containing separators cannot forge the same canonical string.
 * Returns null when the ZIP cannot be parsed.
 */
export function zipStructureHash(bytes: Uint8Array): string | null {
  const entries = listZipEntries(bytes);
  if (!entries) return null;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let canonical = '';
  for (const entry of entries) {
    canonical += `${entry.name.length}:${entry.name}:${entry.size}:${entry.crc32}\n`;
  }
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}
