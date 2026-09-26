// Step 3: feature extraction. One pass over the bytes produces everything the
// blocklist (step 4) and the scan row need:
//
//   sha256          — every file
//   structure_hash  — ZIP entry list (central directory, no decompression)
//   text_hash       — PDF text operators
//   phash           — PNG/GIF/baseline-JPEG luma (video keyframes arrive from
//                     the orchestrator callback instead)
//
// Extractors are best-effort: an unsupported or malformed file keeps the
// sha256-only feature set instead of failing the upload.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeGifLuma } from './decode-gif.ts';
import { decodeJpegLuma } from './decode-jpeg.ts';
import { decodePngLuma } from './decode-png.ts';
import { extractPdfText } from './pdf.ts';
import { computePhash } from './phash.ts';
import { zipStructureHash } from './zip-list.ts';

export type FileKind = 'image' | 'zip' | 'pdf' | 'video' | 'audio' | 'other';

export interface FileFeatures {
  sha256: string;
  kind: FileKind;
  /** ZIP: hash of the sorted entry list. */
  structureHash?: string;
  /** PDF: hash of the normalized extracted text. */
  textHash?: string;
  /** 16-hex pHash; comma-separated for multi-keyframe video results. */
  phash?: string;
  /** Why no perceptual hash could be computed (when `phash` is absent). */
  phashNote?: string;
}

function kindForMime(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/zip') return 'zip';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

/**
 * Compute every synchronous feature for one file. Deterministic: identical
 * bytes always yield identical features.
 */
export async function extractFileFeatures(bytes: Uint8Array, mime: string): Promise<FileFeatures> {
  const features: FileFeatures = {
    sha256: bytesToHex(sha256(bytes)),
    kind: kindForMime(mime),
  };

  if (features.kind === 'zip') {
    const structureHash = zipStructureHash(bytes);
    if (structureHash) features.structureHash = structureHash;
    return features;
  }

  if (features.kind === 'pdf') {
    const text = extractPdfText(bytes);
    if (text !== null && text.length > 0) {
      features.textHash = bytesToHex(sha256(new TextEncoder().encode(text)));
    }
    return features;
  }

  if (features.kind === 'image') {
    const image =
      mime === 'image/png'
        ? decodePngLuma(bytes)
        : mime === 'image/gif'
          ? decodeGifLuma(bytes)
          : mime === 'image/jpeg'
            ? decodeJpegLuma(bytes)
            : null;
    if (image) {
      try {
        features.phash = computePhash(image.data, image.width, image.height);
      } catch {
        features.phashNote = 'phash_failed';
      }
    } else {
      features.phashNote = mime === 'image/webp' ? 'unsupported_format' : 'decode_failed';
    }
    return features;
  }

  if (features.kind === 'video') {
    // Keyframe extraction needs ffmpeg; the orchestrator callback fills phash.
    features.phashNote = 'deferred_to_orchestrator';
  }

  return features;
}
