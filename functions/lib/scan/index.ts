// Steps 2-4 of the file scanning pipeline, synchronously, for one upload:
//
//   2. MIME masquerade checks (declared type + extension vs magic bytes)
//   3. Feature extraction (sha256 / structure / text / pHash)
//   4. Blocklist matching — a hit rejects the upload before it reaches R2
//
// Step 1 (ClamAV) is submitted asynchronously after the response via
// `runInBackground` + submitFileScans in ./clamav.ts.

import { matchBlocklist } from './blocklist.ts';
import { upsertFileScan } from './db.ts';
import { extractFileFeatures, type FileFeatures } from './features.ts';
import { checkDeclaredType, checkExtensionMatchesMime, detectMimeType } from './mime.ts';

export interface SyncScanInput {
  bytes: ArrayBuffer | Uint8Array;
  /** Content-Type the client declared; null/undefined/generic never mismatch. */
  declaredType?: string | null;
  /** R2 key or original filename; drives the extension ↔ MIME check. */
  name?: string | null;
  /** When given, the scan row is written as part of the sync scan. */
  r2Key?: string | null;
  /** Skip re-sniffing when the caller already ran detectMimeType. */
  detectedMime?: string | null;
}

export type SyncScanVerdict =
  | { ok: true; detectedMime: string; features: FileFeatures }
  | {
      ok: false;
      status: 400;
      code: 'unrecognized_type' | 'type_mismatch' | 'file_blocked';
      error: string;
    };

/**
 * Run steps 2-4 for one upload. Never throws: extraction failures degrade to
 * sha256-only features, and matcher errors fail closed.
 */
export async function scanUploadSync(db: D1Database, input: SyncScanInput): Promise<SyncScanVerdict> {
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);

  // Step 2: file type detection + masquerade checks.
  const detectedMime = input.detectedMime ?? detectMimeType(bytes);
  if (!detectedMime) {
    return {
      ok: false,
      status: 400,
      code: 'unrecognized_type',
      error: 'Unrecognized file format. Magic bytes do not match any allowed type.',
    };
  }

  const declaredError = checkDeclaredType(input.declaredType, detectedMime);
  if (declaredError) {
    return { ok: false, status: 400, code: 'type_mismatch', error: declaredError };
  }

  if (input.name) {
    const extError = checkExtensionMatchesMime(input.name, detectedMime);
    if (extError) {
      return { ok: false, status: 400, code: 'type_mismatch', error: extError };
    }
  }

  // Step 3: features.
  const features = await extractFileFeatures(bytes, detectedMime);

  // Step 4: blocklist. A storage error fails closed: a blocklist outage must
  // not open the upload gate.
  let blocked = false;
  try {
    blocked = (await matchBlocklist(db, features)) !== null;
  } catch (e) {
    console.error('Blocklist lookup failed:', e);
    blocked = true;
  }
  if (blocked) {
    return {
      ok: false,
      status: 400,
      code: 'file_blocked',
      error: 'File blocked by security policy',
    };
  }

  if (input.r2Key) {
    try {
      await upsertFileScan(db, input.r2Key, features);
    } catch (e) {
      // The scan row is bookkeeping; losing it skips the async verdict but
      // must not fail an upload that already passed the sync checks.
      console.error('file_scans upsert failed:', e);
    }
  }

  return { ok: true, detectedMime, features };
}

/**
 * Run work after the response is sent (ClamAV submission). Best-effort: the
 * upload has already succeeded when this is called.
 */
export function runInBackground(c: unknown, task: () => Promise<void>): void {
  const execCtx = (c as { executionCtx?: { waitUntil(promise: Promise<unknown>): void } }).executionCtx;
  const promise = task().catch((e) => console.error('background file scan failed:', e));
  if (execCtx?.waitUntil) {
    execCtx.waitUntil(promise);
  }
}
