// Step 4: blocklist matching. The pure matcher is separated from the D1
// fetch so it can be unit-tested without a database.
//
// Exact kinds (sha256 / structure_hash / text_hash) compare case-insensitively
// on hex; phash entries match by hamming distance against every hash the file
// carries (images have one, videos have a keyframe list). The table is
// admin-curated and small, so loading it whole beats a per-kind SQL dance —
// SQLite has no popcount and 64-bit hashes would lose precision as integers.

import { ensureFileScansTable } from './db.ts';
import type { FileFeatures } from './features.ts';
import { hammingDistance, normalizePhash } from './phash.ts';

export type BlockKind = 'sha256' | 'structure_hash' | 'text_hash' | 'phash' | 'signature';

const BLOCK_KINDS: BlockKind[] = ['sha256', 'structure_hash', 'text_hash', 'phash', 'signature'];

export interface BlocklistEntry {
  id: number;
  kind: BlockKind;
  value: string;
  signature: string | null;
  reason: string | null;
}

/** Maximum accepted hamming distance for a perceptual-hash match (64 bits). */
export const PHASH_MAX_DISTANCE = 8;

function hexEq(a: string, b: string | undefined | null): boolean {
  return !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Find the first blocklist entry a file's features match, or null. Pure: no
 * I/O, deterministic, safe to call from tests and callbacks alike.
 */
export function matchBlocklistEntries(features: FileFeatures, entries: BlocklistEntry[]): BlocklistEntry | null {
  for (const entry of entries) {
    switch (entry.kind) {
      case 'sha256':
        if (hexEq(entry.value, features.sha256)) return entry;
        break;
      case 'structure_hash':
        if (hexEq(entry.value, features.structureHash)) return entry;
        break;
      case 'text_hash':
        if (hexEq(entry.value, features.textHash)) return entry;
        break;
      case 'phash': {
        const target = normalizePhash(entry.value);
        if (!target || !features.phash) break;
        for (const candidate of features.phash.split(',')) {
          const current = normalizePhash(candidate);
          if (current && hammingDistance(target, current) <= PHASH_MAX_DISTANCE) return entry;
        }
        break;
      }
      case 'signature':
        // Reserved: signature entries only become meaningful once a file has
        // an AV verdict, which bypasses this synchronous matcher entirely.
        break;
    }
  }
  return null;
}

export async function loadBlocklist(db: D1Database): Promise<BlocklistEntry[]> {
  await ensureFileScansTable(db);
  const result = await db
    .prepare('SELECT id, kind, value, signature, reason FROM file_blocklist ORDER BY id')
    .all<BlocklistEntry>();
  return result.results || [];
}

/**
 * Step 4 in one call: load the blocklist and match the file's features.
 * Throws on storage errors — callers decide whether to fail closed (upload)
 * or fail open (a callback must not permanently block clean content on a
 * transient blip).
 */
export async function matchBlocklist(db: D1Database, features: FileFeatures): Promise<BlocklistEntry | null> {
  const entries = await loadBlocklist(db);
  if (entries.length === 0) return null;
  return matchBlocklistEntries(features, entries);
}

/**
 * Match a ClamAV verdict signature against admin-curated `signature` entries.
 * The entry value is a case-insensitive substring of the verdict name. This is
 * only meaningful after a scan produced a signature, so it runs at verdict time
 * rather than in the synchronous feature matcher.
 */
export function matchSignatureEntry(signature: string | null, entries: BlocklistEntry[]): BlocklistEntry | null {
  if (!signature) return null;
  const needle = signature.toLowerCase();
  for (const entry of entries) {
    if (entry.kind === 'signature' && needle.includes(entry.value.toLowerCase())) return entry;
  }
  return null;
}

// ─── Admin CRUD (mounted at /api/admin/file-blocklist) ───────────────────────

export interface BlocklistAdminRow extends BlocklistEntry {
  added_by: string | null;
  created_at: string;
}

export async function listBlocklist(db: D1Database): Promise<BlocklistAdminRow[]> {
  await ensureFileScansTable(db);
  const result = await db
    .prepare('SELECT id, kind, value, signature, reason, added_by, created_at FROM file_blocklist ORDER BY id')
    .all<BlocklistAdminRow>();
  return result.results || [];
}

/** Normalize and validate one admin-provided entry. */
export function validateBlocklistEntry(
  kind: unknown,
  value: unknown,
): { kind: BlockKind; value: string } | { error: string } {
  if (typeof kind !== 'string' || !BLOCK_KINDS.includes(kind as BlockKind)) {
    return { error: 'kind must be sha256, structure_hash, text_hash, phash, or signature' };
  }
  const k = kind as BlockKind;
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'value is required' };
  }
  const v = value.trim();
  if (k === 'signature') {
    if (v.length > 200) return { error: 'signature must be ≤200 chars' };
    return { kind: k, value: v };
  }
  if (k === 'phash') {
    if (!/^[0-9a-fA-F]{16}$/.test(v)) return { error: 'phash must be 16 hex chars' };
    return { kind: k, value: v.toLowerCase() };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) return { error: `${k} must be a 64-char hex digest` };
  return { kind: k, value: v.toLowerCase() };
}

export interface AddBlocklistInput {
  kind: BlockKind;
  value: string;
  signature?: string | null;
  reason?: string | null;
  addedBy?: string | null;
}

/** Insert an entry, refreshing signature/reason/added_by on an exact duplicate. */
export async function addBlocklistEntry(db: D1Database, input: AddBlocklistInput): Promise<void> {
  await ensureFileScansTable(db);
  await db
    .prepare(
      `INSERT INTO file_blocklist (kind, value, signature, reason, added_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET
         signature = excluded.signature,
         reason = excluded.reason,
         added_by = excluded.added_by`,
    )
    .bind(input.kind, input.value, input.signature ?? null, input.reason ?? null, input.addedBy ?? null)
    .run();
}

/** Remove an entry by id. Returns false when no row matched. */
export async function removeBlocklistEntry(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM file_blocklist WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
