import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Clicking fresh / bookmark / share re-reads the caller's own list with
// `WHERE user_id = ? ORDER BY created_at DESC`. The indexes that exist today
// either omit created_at (0050, 0015) or lead with post_id (0048, 0109), so
// SQLite has to sort every row for that user on each click. 0145 adds three
// covering indexes for those hot paths. It must stay strictly additive —
// CREATE INDEX IF NOT EXISTS plus comments only — so re-running it is a no-op.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/0145_click_latency_indexes.sql');

type IndexDef = { name: string; table: string; columns: string };

// Drop line comments, then split on ';'. Every remaining statement must be a
// plain (non-unique) CREATE INDEX IF NOT EXISTS — no DDL that can mutate data.
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const CREATE_INDEX = /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\S+)\s+ON\s+(\w+)\s*\(([^)]*)\)$/is;

function indexes(sql: string): IndexDef[] {
  return statements(sql).map((statement) => {
    const match = statement.match(CREATE_INDEX);
    assert.ok(
      match,
      `0145 must contain only "CREATE INDEX IF NOT EXISTS ... ON ... (...)" statements, got: ${statement}`,
    );
    return {
      name: match[1] as string,
      table: (match[2] as string).toLowerCase(),
      columns: (match[3] as string).replace(/\s+/g, ' ').trim().toLowerCase(),
    };
  });
}

function hasIndex(defs: IndexDef[], table: string, columns: string): boolean {
  return defs.some((def) => def.table === table && def.columns === columns);
}

describe('migrations/0145_click_latency_indexes.sql', () => {
  it('exists', () => {
    assert.ok(existsSync(MIGRATION), 'missing migrations/0145_click_latency_indexes.sql');
  });

  it('is additive and no-op-safe (only CREATE INDEX IF NOT EXISTS statements plus comments)', () => {
    const defs = indexes(readFileSync(MIGRATION, 'utf8'));
    assert.ok(defs.length > 0, 'expected at least one CREATE INDEX IF NOT EXISTS statement');
  });

  it('adds freshs(user_id, created_at DESC)', () => {
    const defs = indexes(readFileSync(MIGRATION, 'utf8'));
    assert.ok(
      hasIndex(defs, 'freshs', 'user_id, created_at desc'),
      'freshs needs (user_id, created_at DESC) for WHERE user_id=? ORDER BY created_at DESC',
    );
  });

  it('adds bookmarks(user_id, created_at DESC)', () => {
    const defs = indexes(readFileSync(MIGRATION, 'utf8'));
    assert.ok(
      hasIndex(defs, 'bookmarks', 'user_id, created_at desc'),
      'the (user_id, post_id) index cannot serve ORDER BY created_at DESC',
    );
  });

  it('adds shares(user_id, created_at DESC)', () => {
    const defs = indexes(readFileSync(MIGRATION, 'utf8'));
    assert.ok(
      hasIndex(defs, 'shares', 'user_id, created_at desc'),
      'shares indexes (0015/0109) have no created_at column',
    );
  });

  it('adds exactly the three hot-path indexes', () => {
    const defs = indexes(readFileSync(MIGRATION, 'utf8'));
    assert.equal(defs.length, 3, `expected 3 indexes, got ${defs.map((d) => d.name).join(', ')}`);
  });

  it('documents that For You trending cannot use a plain index', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /0052/, 'must reference the now-unusable 0052 index');
    assert.match(sql, /For You|trending/i, 'must name the For You trending query');
    assert.match(sql, /computed|expression|EXP\s*\(|LN\s*\(|MAX\s*\(/i, 'must explain the computed ORDER BY');
  });

  it('documents (without creating) the skipped case-insensitive username unique index', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /0049/, 'must reference the 0049 index name collision');
    assert.match(sql, /0101/, 'must reference the 0101 UNIQUE attempt');
    assert.match(sql, /nocase|lower\s*\(\s*username\s*\)/i, 'must mention the case-insensitive username index');
    assert.doesNotMatch(
      sql,
      /CREATE\s+UNIQUE\s+INDEX/i,
      'must not create the UNIQUE index while duplicate usernames are possible',
    );
  });
});
