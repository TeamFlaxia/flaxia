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
  upsertFileScan,
} from '../functions/lib/scan/db.ts';

// D1 shim. The functions only use prepare/bind/run/first/all; `all` can pause
// once so a test can interleave a second callback inside the clean path.
function testDb(pause?: () => Promise<void>) {
  const sqlite = new DatabaseSync(':memory:');
  let pauseOnce = pause;
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
