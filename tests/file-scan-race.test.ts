import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { handleCrowdWebhook } from '../functions/lib/crowd.ts';
import {
  ensureFileScansTable,
  getFileScan,
  isKeyBlocked,
  recordInfection,
  setScanStatus,
  upsertFileScan,
} from '../functions/lib/scan/db.ts';

// D1 shim. The functions use prepared statements; the hooks interleave
// callbacks before a batch and during a blocklist read to pin race behavior.
function testDb(pause?: () => Promise<void>, beforeBatch?: () => Promise<void>) {
  const sqlite = new DatabaseSync(':memory:');
  let pauseOnce = pause;
  let pauseBatchOnce = beforeBatch;
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...(binds as never[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async first() {
          return sqlite.prepare(sql).get(...(binds as never[])) ?? null;
        },
        async all() {
          const results = sqlite.prepare(sql).all(...(binds as never[]));
          if (pauseOnce && sql.includes('FROM file_blocklist')) {
            const runPause = pauseOnce;
            pauseOnce = undefined;
            await runPause();
          }
          return { results };
        },
      };
    },
    async batch(statements: { run(): Promise<{ success: boolean; meta: { changes: number } }> }[]) {
      const runPause = pauseBatchOnce;
      pauseBatchOnce = undefined;
      if (runPause) await runPause();
      sqlite.exec('BEGIN');
      try {
        const results = await Promise.all(statements.map((statement) => statement.run()));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

function memoryCache() {
  const values = new Map<string, string>();
  return {
    values,
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async delete(key: string) {
      values.delete(key);
    },
  } as unknown as KVNamespace & { values: Map<string, string> };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function features(data: Uint8Array) {
  return { sha256: bytesToHex(sha256(data)), kind: 'image' as const };
}

const CROWD_SECRET = 'test-callback-secret';

function crowdEnv(cache: unknown) {
  return {
    CACHE: cache,
    CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
    CROWD_API_KEY: 'test-api-key',
    CROWD_WEBHOOK_SECRET: CROWD_SECRET,
    BASE_URL: 'https://flaxia.app',
  };
}

function cleanCallback(key: string, sha: string): Request {
  // The webhook rejects unconfigured/unsigned callers: sign like the
  // orchestrator would (HMAC-SHA256 over path + sorted query).
  const params = new URLSearchParams({ key, kind: 'clamav', sha, type: 'file-scan' });
  params.sort();
  const sig = createHmac('sha256', CROWD_SECRET).update(`/api/crowd/webhook?${params}`).digest('hex');
  params.set('sig', sig);
  return new Request(`https://flaxia.app/api/crowd/webhook?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: 'task-clean',
      status: 'done',
      result: { output: { exitCode: 0, stdout: '', stderr: '' } },
    }),
  });
}

function infectedCallback(key: string, sha: string): Request {
  const params = new URLSearchParams({ key, kind: 'clamav', sha, type: 'file-scan' });
  params.sort();
  const sig = createHmac('sha256', CROWD_SECRET).update(`/api/crowd/webhook?${params}`).digest('hex');
  params.set('sig', sig);
  return new Request(`https://flaxia.app/api/crowd/webhook?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: 'task-infected',
      status: 'done',
      result: { output: { exitCode: 1, stdout: 'input.bin: Eicar-Test-Signature FOUND', stderr: '' } },
    }),
  });
}

describe('file scan verdict races', () => {
  it('a clean verdict cannot unblock bytes another task just marked infected', async () => {
    const key = 'gif/race/0.png';
    const data = bytes('same bytes');
    const sha = features(data).sha256;
    const cache = memoryCache();
    const { db } = testDb(async () => {
      // Runs after the clean path has read the blocklist and before it writes
      // `clean`. The pHash task finds a matching entry for the same bytes.
      await recordInfection(db, cache, key, 'phash-blocklist', 'phash_blocklist', sha.slice(0, 16));
    });

    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features(data));
    const res = await handleCrowdWebhook(cleanCallback(key, sha.slice(0, 16)), crowdEnv(cache), db);
    assert.equal(res.status, 200);

    assert.equal((await getFileScan(db, key))?.status, 'infected', 'the infection must stay sticky');
    assert.equal(await cache.get(`fileblk:${key}`), '1', 'the serve marker must survive the clean callback');
    assert.equal(await isKeyBlocked(cache, key, db), true, 'the key must still be withheld');
  });

  it('a stale marker is cleared once the row is no longer infected', async () => {
    const key = 'gif/reused/0.png';
    const oldBytes = bytes('old infected bytes');
    const newBytes = bytes('new clean bytes');
    const cache = memoryCache();
    const { db } = testDb();

    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features(oldBytes));
    await recordInfection(db, cache, key, 'sig', 'clamav', features(oldBytes).sha256.slice(0, 16));

    // Re-uploading different bytes resets the row to pending; the marker from
    // the old bytes must not outlive the verdict it belonged to.
    await upsertFileScan(db, key, features(newBytes));
    assert.equal((await getFileScan(db, key))?.status, 'pending');
    assert.equal(await isKeyBlocked(cache, key, db), false, 'stale markers must clear against the current row');
    assert.equal(await cache.get(`fileblk:${key}`), null, 'the KV marker must be deleted');
  });

  it('a marker without a verifiable row still fails closed', async () => {
    const key = 'gif/orphan/0.png';
    const cache = memoryCache();
    const { db } = testDb();
    await ensureFileScansTable(db);
    await cache.put(`fileblk:${key}`, '1');
    assert.equal(await isKeyBlocked(cache, key, db), true);
  });

  it('fails closed when the verdict cannot be verified (#81)', async () => {
    const { db } = testDb();
    await ensureFileScansTable(db);
    assert.equal(await isKeyBlocked(undefined, 'gif/x/0.png', db), true, 'missing KV binding must withhold');
    const brokenCache = {
      async get() {
        throw new Error('kv down');
      },
    } as unknown as KVNamespace;
    assert.equal(await isKeyBlocked(brokenCache, 'gif/x/0.png', db), true, 'KV read error must withhold');
  });

  it('blocklists the submitted SHA when an overwrite wins the status-update race', async () => {
    const key = 'uploads/race.bin';
    const oldBytes = bytes('infected bytes A');
    const newBytes = bytes('replacement bytes B');
    const oldSha = features(oldBytes).sha256;
    const cache = memoryCache();
    const holder: { db?: D1Database } = {};
    const setup = testDb(undefined, async () => {
      const raceDb = holder.db;
      if (!raceDb) throw new Error('database was not initialized');
      // B replaces A after the verdict callback arrives but before its D1 update.
      await upsertFileScan(raceDb, key, features(newBytes));
    });
    holder.db = setup.db;
    await ensureFileScansTable(setup.db);
    await upsertFileScan(setup.db, key, features(oldBytes));

    const res = await handleCrowdWebhook(infectedCallback(key, oldSha), crowdEnv(cache), setup.db);
    assert.equal(res.status, 200);
    const row = await getFileScan(setup.db, key);
    assert.equal(row?.sha256, features(newBytes).sha256);
    assert.equal(row?.status, 'pending');
    const blocked = setup.sqlite.prepare('SELECT value FROM file_blocklist WHERE kind = ?').all('sha256') as {
      value: string;
    }[];
    assert.deepEqual(
      blocked.map((entry) => entry.value),
      [oldSha],
    );
    assert.equal(await cache.get('fileblk:' + key), null, 'the replacement must not inherit A infection');
    assert.equal(await isKeyBlocked(cache, key, setup.db), false);
  });

  it('blocklists old bytes when the callback arrives after the key already changed', async () => {
    const key = 'uploads/already-replaced.bin';
    const oldBytes = bytes('infected bytes A');
    const newBytes = bytes('replacement bytes B');
    const oldSha = features(oldBytes).sha256;
    const cache = memoryCache();
    const { db, sqlite } = testDb();
    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features(oldBytes));
    await upsertFileScan(db, key, features(newBytes));

    const res = await handleCrowdWebhook(infectedCallback(key, oldSha), crowdEnv(cache), db);
    assert.equal(res.status, 200);
    const blocked = sqlite.prepare('SELECT value FROM file_blocklist WHERE kind = ?').all('sha256') as {
      value: string;
    }[];
    assert.deepEqual(
      blocked.map((entry) => entry.value),
      [oldSha],
    );
    assert.equal((await getFileScan(db, key))?.status, 'pending');
    assert.equal(await isKeyBlocked(cache, key, db), false);
  });

  it('withholds payloads skipped as too large until the content is replaced', async () => {
    const key = 'uploads/oversized.bin';
    const oversized = bytes('oversized payload');
    const replacement = bytes('replacement payload');
    const cache = memoryCache();
    const { db } = testDb();
    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features(oversized));
    await setScanStatus(db, key, 'skipped', { detail: 'too_large', sha256: features(oversized).sha256 });

    assert.equal(await cache.get('fileblk:' + key), null, 'the D1 status alone must enforce quarantine');
    assert.equal(await isKeyBlocked(cache, key, db), true);

    await upsertFileScan(db, key, features(replacement));
    assert.equal((await getFileScan(db, key))?.status, 'pending');
    assert.equal(await isKeyBlocked(cache, key, db), false, 'new content is evaluated independently');

    await setScanStatus(db, key, 'skipped', {
      detail: 'orchestrator_unconfigured',
      sha256: features(replacement).sha256,
    });
    assert.equal(await isKeyBlocked(cache, key, db), false, 'other explicit skips keep existing behavior');
  });
  it('rejects unsigned callbacks on a non-local instance (no fail-open)', async () => {
    const cache = memoryCache();
    const { db } = testDb();
    await ensureFileScansTable(db);
    const unsigned = new Request('https://flaxia.app/api/crowd/webhook?type=file-scan&key=gif/x/0.png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 't-nosig', status: 'done', result: {} }),
    });
    const res = await handleCrowdWebhook(unsigned, { CACHE: cache }, db);
    assert.equal(res.status, 401);
  });
});
