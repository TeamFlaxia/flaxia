/**
 * Chunked upload assembly.
 *
 * Cloudflare rejects request bodies above 100 MB on Free/Pro zones, and a
 * Worker isolate only has 128 MB of memory, so a 128 MB upload cannot arrive
 * in one request or be buffered. The client slices the file into 16 MB parts;
 * each part is stored under a per-user temporary key, then finalization
 * streams the parts into the destination object while hashing them.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BlobStore } from './ports/index.ts';

/** Header bytes captured from the first part for magic/dimension checks. */
export const CHUNK_HEADER_BYTES = 64 * 1024;

export function chunkTempKey(userId: string, uploadId: string, part: number): string {
  // Ids are server-minted, but never let one smuggle path separators into a
  // temporary key prefix.
  const owner = userId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `tmp/uploads/${owner}/${uploadId}/${part}`;
}

export function isValidUploadId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

export interface AssembledUpload {
  size: number;
  sha256: string;
  header: Uint8Array;
}

export class ChunkAssemblyError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ChunkAssemblyError';
    this.status = status;
  }
}

/**
 * Concatenate `parts` (ordered 1..N) into `destKey`, streaming through the
 * Worker and hashing every byte. The temporary parts are deleted afterwards,
 * including when assembly fails.
 */
export async function assembleChunks(
  blobs: BlobStore,
  options: {
    parts: Array<{ key: string; size: number }>;
    destKey: string;
    contentType: string;
    maxBytes: number;
    headerBytes?: number;
  },
): Promise<AssembledUpload> {
  const { parts, destKey, contentType, maxBytes } = options;
  if (parts.length === 0) throw new ChunkAssemblyError('No chunks to assemble');

  const headerBytes = options.headerBytes ?? CHUNK_HEADER_BYTES;
  let total = 0;
  for (const part of parts) {
    if (part.size <= 0) throw new ChunkAssemblyError('Empty upload chunk');
    total += part.size;
  }
  if (total > maxBytes) {
    throw new ChunkAssemblyError(`File too large. Maximum size is ${Math.floor(maxBytes / (1024 * 1024))}MB`, 413);
  }

  const first = await blobs.get(parts[0].key, { range: { offset: 0, length: Math.min(headerBytes, parts[0].size) } });
  if (!first) throw new ChunkAssemblyError('Upload chunk missing', 404);
  const header = new Uint8Array(await new Response(first.body).arrayBuffer());

  const hasher = sha256.create();
  let partIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let written = 0;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            if (partIndex >= parts.length) {
              controller.close();
              return;
            }
            const object = await blobs.get(parts[partIndex].key);
            if (!object) throw new ChunkAssemblyError(`Upload chunk ${partIndex + 1} missing`, 404);
            reader = object.body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            partIndex += 1;
            continue;
          }
          written += value.byteLength;
          if (written > maxBytes) throw new ChunkAssemblyError('Upload exceeds the size limit', 413);
          hasher.update(value);
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader?.cancel(reason);
    },
  });

  try {
    await blobs.put(destKey, body, { httpMetadata: { contentType }, length: total });
  } finally {
    await blobs
      .delete(parts.map((part) => part.key))
      .catch((error) => console.error('Failed to delete upload chunks:', error));
  }

  if (written !== total) throw new ChunkAssemblyError('Upload size changed during assembly', 409);

  return { size: written, sha256: bytesToHex(hasher.digest()), header };
}
