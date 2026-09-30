import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// file_scans.status is declared twice — in the migration that creates the
// table and in the runtime bootstrap in functions/lib/scan/db.ts. The two
// copies drifted once already: `setScanTask` wrote 'submitted', which the
// CHECK rejected, so in production every ClamAV submission threw, the row was
// marked failed and the video pHash task never ran. Both copies are checked
// against each other and against the TS status union here.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/0097_file_scans_blocklist.sql');
const DB_MODULE = join(ROOT, 'functions/lib/scan/db.ts');

const STATUS_CHECK = /status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'[^']*'\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i;

function statusValues(sql: string, label: string): string[] {
  const match = sql.match(STATUS_CHECK);
  assert.ok(match, `no status CHECK found in ${label}`);
  return (match[1] as string)
    .split(',')
    .map((value) => value.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

describe('file_scans status schema', () => {
  it('the migration and the runtime bootstrap declare the same status values', () => {
    const fromMigration = statusValues(readFileSync(MIGRATION, 'utf8'), 'migrations/0097_file_scans_blocklist.sql');
    const fromModule = statusValues(readFileSync(DB_MODULE, 'utf8'), 'functions/lib/scan/db.ts');
    assert.deepEqual(fromModule, fromMigration, 'the two copies of file_scans.status must not drift');
  });

  it("accepts 'submitted', which setScanTask writes", () => {
    const values = statusValues(readFileSync(MIGRATION, 'utf8'), 'migrations/0097_file_scans_blocklist.sql');
    assert.ok(values.includes('submitted'), `status CHECK must allow 'submitted': got ${values.join(', ')}`);
  });

  it('the ScanStatus union matches the CHECK', () => {
    const src = readFileSync(DB_MODULE, 'utf8');
    const union = src.match(/export type ScanStatus = ([^;]+);/);
    assert.ok(union, 'ScanStatus must be exported from functions/lib/scan/db.ts');
    const declared = [...(union[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    const values = statusValues(src, 'functions/lib/scan/db.ts');
    assert.deepEqual(declared.sort(), [...values].sort(), 'ScanStatus and the CHECK must list the same values');
  });
});
