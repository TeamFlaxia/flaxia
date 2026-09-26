// D1 state for the file scanning pipeline: schema bootstrap plus the
// file_scans row lifecycle (pending -> submitted -> clean|infected|failed|
// skipped). Mirrors functions/lib/crowd.ts's ensure* helpers.

import type { FileFeatures } from './features.ts';

const FILE_SCANS_SCHEMA = `r2_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('image', 'zip', 'pdf', 'video', 'audio', 'other')),
  structure_hash TEXT,
  text_hash TEXT,
  phash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'clean', 'infected', 'failed', 'skipped')),
  detail TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scanned_at TEXT`;

const BLOCKLIST_SCHEMA = `id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('sha256', 'structure_hash', 'text_hash', 'phash', 'signature')),
  value TEXT NOT NULL,
  signature TEXT,
  reason TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, value)`;

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'failed' | 'skipped' | 'submitted';

export interface FileScanRow {
  r2_key: string;
  sha256: string;
  kind: string;
  structure_hash: string | null;
  text_hash: string | null;
  phash: string | null;
  status: string;
  detail: string | null;
  task_id: string | null;
  created_at: string;
  scanned_at: string | null;
}

// One bootstrap per isolate; cleared on failure so a transient D1 error does
// not disable the table for the isolate's lifetime.
let ensurePromise: Promise<void> | null = null;

export async function ensureFileScansTable(db: D1Database): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    try {
      await db.prepare(`CREATE TABLE IF NOT EXISTS file_scans (${FILE_SCANS_SCHEMA})`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_scans_sha256 ON file_scans(sha256)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_scans_status ON file_scans(status, created_at)').run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS file_blocklist (${BLOCKLIST_SCHEMA})`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_blocklist_kind ON file_blocklist(kind)').run();
    } catch (e) {
      ensurePromise = null;
      throw e;
    }
  })();
  return ensurePromise;
}

/**
 * Insert (or refresh) the scan row for an upload with the synchronous
 * features. Only new content (a changed sha256) resets the row to `pending`;
 * re-referencing identical bytes keeps the existing verdict, so a clean row is
 * not re-submitted and an infected row can never be downgraded by a re-upload.
 */
export async function upsertFileScan(db: D1Database, r2Key: string, features: FileFeatures): Promise<void> {
  await ensureFileScansTable(db);
  await db
    .prepare(
      `INSERT INTO file_scans (r2_key, sha256, kind, structure_hash, text_hash, phash, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(r2_key) DO UPDATE SET
         sha256 = excluded.sha256,
         kind = excluded.kind,
         structure_hash = excluded.structure_hash,
         text_hash = excluded.text_hash,
         phash = CASE WHEN file_scans.sha256 = excluded.sha256
                      THEN COALESCE(file_scans.phash, excluded.phash)
                      ELSE excluded.phash END,
         status = CASE WHEN file_scans.sha256 = excluded.sha256
                       THEN file_scans.status
                       ELSE 'pending' END,
         detail = CASE WHEN file_scans.sha256 = excluded.sha256 THEN file_scans.detail ELSE NULL END,
         task_id = CASE WHEN file_scans.sha256 = excluded.sha256 THEN file_scans.task_id ELSE NULL END,
         scanned_at = CASE WHEN file_scans.sha256 = excluded.sha256 THEN file_scans.scanned_at ELSE NULL END`,
    )
    .bind(
      r2Key,
      features.sha256,
      features.kind,
      features.structureHash ?? null,
      features.textHash ?? null,
      features.phash ?? null,
    )
    .run();
}

export async function getFileScan(db: D1Database, r2Key: string): Promise<FileScanRow | null> {
  const row = await db.prepare('SELECT * FROM file_scans WHERE r2_key = ?').bind(r2Key).first<FileScanRow>();
  return row ?? null;
}

export interface StatusOptions {
  detail?: string;
  /**
   * When set, the update only applies if the row still hashes to this prefix.
   * Callbacks carry the first hex chars of the sha they were submitted for, so
   * a slow callback cannot mark re-uploaded content with a stale verdict.
   */
  shaPrefix?: string;
}

export async function setScanStatus(
  db: D1Database,
  r2Key: string,
  status: ScanStatus,
  opts: StatusOptions = {},
): Promise<void> {
  const now = new Date().toISOString();
  const stamped = status === 'pending' || status === 'submitted';
  let sql = 'UPDATE file_scans SET status = ?, detail = ?, scanned_at = ? WHERE r2_key = ?';
  const binds: unknown[] = [status, opts.detail ?? null, stamped ? null : now, r2Key];
  // An infected verdict is sticky: a late `clean` callback (or a failed task)
  // must not clear it. Only a re-upload (upsert) resets the row.
  if (status !== 'infected') {
    sql += ' AND status != ?';
    binds.push('infected');
  }
  if (opts.shaPrefix) {
    sql += ' AND sha256 LIKE ?';
    binds.push(`${opts.shaPrefix}%`);
  }
  await db
    .prepare(sql)
    .bind(...(binds as [string, string | null, string | null, string, ...string[]]))
    .run();
}

/** Attach the async orchestrator task id to a pending scan. */
export async function setScanTask(db: D1Database, r2Key: string, taskId: string): Promise<void> {
  await db
    .prepare('UPDATE file_scans SET task_id = ?, status = ? WHERE r2_key = ?')
    .bind(taskId, 'submitted', r2Key)
    .run();
}

/** Store video keyframe hashes delivered by the orchestrator. */
export async function setScanPhash(db: D1Database, r2Key: string, phash: string): Promise<void> {
  await db.prepare('UPDATE file_scans SET phash = ? WHERE r2_key = ?').bind(phash, r2Key).run();
}

/**
 * Record a confirmed malicious file: mark the row infected, add its sha256 to
 * the blocklist (so re-uploads are rejected synchronously) and flag the key in
 * KV so the media routes stop serving it.
 */
export async function recordInfection(
  db: D1Database,
  cache: KVNamespace | undefined,
  r2Key: string,
  signature: string | null,
  reason: string,
): Promise<void> {
  const row = await getFileScan(db, r2Key);
  await setScanStatus(db, r2Key, 'infected', { detail: signature ?? reason });
  if (row) {
    await db
      .prepare(
        `INSERT INTO file_blocklist (kind, value, signature, reason, added_by)
         VALUES ('sha256', ?, ?, ?, 'system')
         ON CONFLICT(kind, value) DO UPDATE SET signature = excluded.signature, reason = excluded.reason`,
      )
      .bind(row.sha256, signature, reason)
      .run();
  }
  await markKeyBlocked(cache, r2Key);
}

/** Flag an R2 key as blocked in KV. Permanent until explicitly cleared. */
export async function markKeyBlocked(cache: KVNamespace | undefined, r2Key: string): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(`fileblk:${r2Key}`, '1');
  } catch (e) {
    console.warn('KV block marker write failed:', e);
  }
}

/**
 * Serve-time gate: has this key been flagged by an async verdict? One KV read
 * (the media routes already hit KV for rate limiting); a missing binding fails
 * open because uploads are already gated synchronously.
 */
export async function isKeyBlocked(cache: KVNamespace | undefined, r2Key: string): Promise<boolean> {
  if (!cache) return false;
  try {
    return (await cache.get(`fileblk:${r2Key}`)) !== null;
  } catch (e) {
    console.warn('KV block marker read failed:', e);
    return false;
  }
}

export async function clearKeyBlocked(cache: KVNamespace | undefined, r2Key: string): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(`fileblk:${r2Key}`);
  } catch (e) {
    console.warn('KV block marker delete failed:', e);
  }
}
