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
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'submitted', 'clean', 'infected', 'failed', 'skipped')),
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

// One bootstrap per database connection; cleared on failure so a transient D1
// error does not disable the table for the isolate's lifetime.
const ensurePromises = new WeakMap<D1Database, Promise<void>>();

export async function ensureFileScansTable(db: D1Database): Promise<void> {
  const existing = ensurePromises.get(db);
  if (existing) return existing;
  const promise = (async () => {
    try {
      await db.prepare(`CREATE TABLE IF NOT EXISTS file_scans (${FILE_SCANS_SCHEMA})`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_scans_sha256 ON file_scans(sha256)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_scans_status ON file_scans(status, created_at)').run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS file_blocklist (${BLOCKLIST_SCHEMA})`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_file_blocklist_kind ON file_blocklist(kind)').run();
    } catch (e) {
      ensurePromises.delete(db);
      throw e;
    }
  })();
  ensurePromises.set(db, promise);
  return promise;
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
  /**
   * Only apply when the row still holds the exact sha, not just a prefix.
   * Used by the submission path so a task id can never attach to re-uploaded
   * bytes.
   */
  sha256?: string;
}

/**
 * Apply a status transition. Returns true only when a row was actually
 * updated, so callers can tell a stale callback from an applied verdict
 * without a second read.
 */
export async function setScanStatus(
  db: D1Database,
  r2Key: string,
  status: ScanStatus,
  opts: StatusOptions = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const stamped = status === 'pending' || status === 'submitted';
  let sql = 'UPDATE file_scans SET status = ?, detail = ?, scanned_at = ? WHERE r2_key = ?';
  const binds: unknown[] = [status, opts.detail ?? null, stamped ? null : now, r2Key];
  // An infected verdict is sticky for the same content: a late `clean` or
  // `failed` callback (or a task failure) must not clear it. Only a re-upload
  // of different bytes resets the row.
  if (status !== 'infected') {
    sql += ' AND status != ?';
    binds.push('infected');
  }
  if (opts.shaPrefix) {
    sql += ' AND sha256 LIKE ?';
    binds.push(`${opts.shaPrefix}%`);
  }
  if (opts.sha256) {
    sql += ' AND sha256 = ?';
    binds.push(opts.sha256);
  }
  const result = await db
    .prepare(sql)
    .bind(...(binds as [string, string | null, string | null, string, ...string[]]))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Attach the async orchestrator task id to the exact bytes that were
 * submitted. The sha guard matters because the orchestrator request is
 * asynchronous: without it, a task submitted for an older upload of the same
 * key could mark newer bytes as `submitted`.
 */
export async function setScanTask(db: D1Database, r2Key: string, taskId: string, sha256: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE file_scans SET task_id = ?, status = ? WHERE r2_key = ? AND sha256 = ?')
    .bind(taskId, 'submitted', r2Key, sha256)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Store video keyframe hashes delivered by the orchestrator. Only applies when
 * the row still hashes to `shaPrefix`, so a late callback for bytes A cannot
 * overwrite the hashes of re-uploaded bytes B.
 */
export async function setScanPhash(db: D1Database, r2Key: string, phash: string, shaPrefix?: string): Promise<void> {
  let sql = 'UPDATE file_scans SET phash = ? WHERE r2_key = ?';
  const binds: unknown[] = [phash, r2Key];
  if (shaPrefix) {
    sql += ' AND sha256 LIKE ?';
    binds.push(`${shaPrefix}%`);
  }
  await db
    .prepare(sql)
    .bind(...(binds as [string, string, ...string[]]))
    .run();
}

/**
 * Record a confirmed malicious file: mark the row infected, add its sha256 to
 * the blocklist (so re-uploads are rejected synchronously) and flag the key in
 * KV so the media routes stop serving it.
 *
 * `shaPrefix` ties the callback to the content it was issued for. The row is
 * read first and re-checked by `setScanStatus`, so a stale or forged callback
 * for different bytes neither blocklists the current sha nor marks the row.
 */
export async function recordInfection(
  db: D1Database,
  cache: KVNamespace | undefined,
  r2Key: string,
  signature: string | null,
  reason: string,
  shaPrefix?: string,
): Promise<void> {
  // The row read is only used to learn which sha this callback refers to. The
  // conditional update below is the authority: a stale callback for bytes that
  // were replaced no longer matches, so its sha is never blocklisted.
  const row = await getFileScan(db, r2Key);
  if (!row) return;
  if (shaPrefix && !row.sha256.startsWith(shaPrefix)) return;
  const applied = await setScanStatus(db, r2Key, 'infected', { detail: signature ?? reason, shaPrefix });
  if (!applied) return;
  await db
    .prepare(
      `INSERT INTO file_blocklist (kind, value, signature, reason, added_by)
       VALUES ('sha256', ?, ?, ?, 'system')
       ON CONFLICT(kind, value) DO UPDATE SET signature = excluded.signature, reason = excluded.reason`,
    )
    .bind(row.sha256, signature, reason)
    .run();
  await markKeyBlocked(cache, r2Key);
}

/** Flag an R2 key as blocked in KV. Replaced bytes are cleared lazily below. */
export async function markKeyBlocked(cache: KVNamespace | undefined, r2Key: string): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(`fileblk:${r2Key}`, '1');
  } catch (e) {
    console.warn('KV block marker write failed:', e);
  }
}

/**
 * Serve-time gate: has this key been flagged by an async verdict?
 *
 * One KV read is the common path. The D1 check runs only after a marker is
 * present, so a key reused with fresh bytes recovers as soon as that upload's
 * scan row leaves `infected` — while a marker whose row cannot be verified
 * still fails closed.
 */
export async function isKeyBlocked(cache: KVNamespace | undefined, r2Key: string, db?: D1Database): Promise<boolean> {
  if (!cache) return false;
  try {
    if ((await cache.get(`fileblk:${r2Key}`)) === null) return false;
    if (!db) return true;
    const row = await getFileScan(db, r2Key).catch(() => null);
    if (row && row.status !== 'infected') {
      await clearKeyBlocked(cache, r2Key);
      return false;
    }
    return true;
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
