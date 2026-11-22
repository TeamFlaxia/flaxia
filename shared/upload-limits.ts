/**
 * Upload ceilings shared by the composer, the game uploader and the API.
 *
 * The API is authoritative; client values only drive the picker UI and pick
 * the transport (single request vs. chunked). Flaxia+ subscribers may send
 * files up to 128 MB, which is above Cloudflare's 100 MB request-body limit
 * on Free/Pro zones, so large files are split into 16 MB parts and assembled
 * in R2. Free accounts keep the historical 25 MB cap.
 */

import { type EntitlementUser, isPlusUser } from './entitlements.ts';

const MIB = 1024 * 1024;

/** Per-file ceiling for free accounts. */
export const FREE_UPLOAD_MAX_BYTES = 25 * MIB;
/** Per-file ceiling for active Flaxia+ subscribers. */
export const PLUS_UPLOAD_MAX_BYTES = 128 * MIB;

/** Media attachment budget for one post (free). */
export const FREE_MEDIA_TOTAL_BYTES = 50 * MIB;
/** Media attachment budget for one post (Flaxia+). */
export const PLUS_MEDIA_TOTAL_BYTES = 256 * MIB;

/**
 * Largest body handled by the synchronous single-request path. It matches the
 * historical 25 MB ceiling so full-buffer feature extraction (image decode,
 * ClamAV submission) never sees more bytes than it already did. Anything
 * larger is chunked: Cloudflare also rejects request bodies over 100 MB on
 * Free/Pro zones and a Worker only has 128 MB of memory.
 */
export const SINGLE_REQUEST_UPLOAD_MAX_BYTES = FREE_UPLOAD_MAX_BYTES;
/** Size of each part when a large file is chunked. */
export const UPLOAD_CHUNK_BYTES = 16 * MIB;
/** Hard part-count ceiling; keeps the client and server in lockstep. */
export const MAX_UPLOAD_CHUNKS = Math.ceil(PLUS_UPLOAD_MAX_BYTES / UPLOAD_CHUNK_BYTES);

export function maxUploadBytesForUser(user: EntitlementUser): number {
  return isPlusUser(user) ? PLUS_UPLOAD_MAX_BYTES : FREE_UPLOAD_MAX_BYTES;
}

export function maxMediaTotalBytesForUser(user: EntitlementUser): number {
  return isPlusUser(user) ? PLUS_MEDIA_TOTAL_BYTES : FREE_MEDIA_TOTAL_BYTES;
}

/** Files above the single-request ceiling must use the chunked transport. */
export function requiresChunkedUpload(bytes: number): boolean {
  return bytes > SINGLE_REQUEST_UPLOAD_MAX_BYTES;
}
