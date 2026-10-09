import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type CrowdEnv, FILE_SCAN_SOURCE_MAX_BYTES } from '../crowd.ts';
import { clamavMaxBytes, submitFileScans } from './clamav.ts';
import { ensureFileScansTable, getFileScan } from './db.ts';
import { extractFileFeatures } from './features.ts';
import { detectMimeType } from './mime.ts';

export type RescreenResult = 'submitted' | 'missing' | 'unsupported' | 'too_large' | 'not_eligible' | 'failed';

/**
 * Rescreen a still-matching quarantined object, then submit its current R2
 * bytes for ClamAV. Never clears infected rows or opens access before a fresh
 * clean verdict is received.
 */
export async function rescreenQuarantinedObject(
  db: D1Database,
  bucket: R2Bucket | undefined,
  env: CrowdEnv & { CROWD_MAX_PAYLOAD_BYTES?: string },
  key: string,
): Promise<RescreenResult> {
  if (!bucket || !/^[-a-zA-Z0-9_./]+$/.test(key) || key.includes('..')) return 'failed';

  try {
    await ensureFileScansTable(db);
    const row = await getFileScan(db, key);
    if (!row || row.status !== 'skipped' || !['too_large', 'orchestrator_unconfigured'].includes(row.detail ?? '')) {
      return 'not_eligible';
    }

    const object = await bucket.get(key);
    if (!object) return 'missing';
    const usesFileSource = env.CROWD_SCAN_FILE_SOURCES === '1';
    const maxBytes = usesFileSource ? Math.min(FILE_SCAN_SOURCE_MAX_BYTES, 25 * 1024 * 1024) : clamavMaxBytes(env);
    if (object.size > maxBytes) return 'too_large';

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== object.size) return 'too_large';
    const sha = bytesToHex(sha256(bytes));
    if (sha !== row.sha256) return 'not_eligible';

    const mime = detectMimeType(bytes);
    if (!mime || !mime.startsWith('image/')) return 'unsupported';
    const features = await extractFileFeatures(bytes, mime);
    if (features.sha256 !== row.sha256) return 'not_eligible';

    // A narrow state transition reopens only the same quarantined bytes.
    const reopened = await db
      .prepare(`UPDATE file_scans
                SET kind = ?, structure_hash = ?, text_hash = ?, phash = ?, status = 'pending',
                    detail = NULL, task_id = NULL, scanned_at = NULL
                WHERE r2_key = ? AND sha256 = ? AND status = 'skipped'
                  AND detail IN ('too_large', 'orchestrator_unconfigured')`)
      .bind(features.kind, features.structureHash ?? null, features.textHash ?? null, features.phash ?? null, key, sha)
      .run();
    if ((reopened.meta.changes ?? 0) !== 1) return 'not_eligible';
    const refreshed = await getFileScan(db, key);
    if (!refreshed || refreshed.sha256 !== sha || refreshed.status !== 'pending') return 'not_eligible';

    await submitFileScans(db, { ...env, BUCKET: bucket }, key, mime, bytes);
    const afterSubmit = await getFileScan(db, key);
    if (afterSubmit?.status === 'submitted') return 'submitted';
    if (afterSubmit?.status === 'skipped' && afterSubmit.detail === 'too_large') return 'too_large';
    if (afterSubmit?.status === 'skipped' || afterSubmit?.status === 'failed') return 'failed';
    return 'failed';
  } catch (error) {
    console.error(`Admin rescreen failed for ${key}:`, error);
    // Do not overwrite a newer scan or an infected verdict after an asynchronous
    // failure. In particular, an unguarded status write here could undo a
    // quarantine row that another request just established.
    return 'failed';
  }
}
