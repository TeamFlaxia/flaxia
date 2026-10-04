import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type CrowdEnv, ensureNsfwScansTable, handleCrowdWebhook, submitDetectNsfw } from '../functions/lib/crowd.ts';

// NudeNet verdict binding.
//
// Media keys are stable across overwrites (gif/{postId}/{position}.{ext}), so a
// verdict keyed only on (post, key) would keep vouching for an image that was
// swapped in later — the NSFW interstitials in the timeline read that verdict.
// These tests drive functions/lib/crowd.ts directly against an in-memory D1
// shim (same surface as tests/file-scan-race.test.ts) plus a fake R2 bucket, so
// they do not need the dev server or a real orchestrator.

const encoder = new TextEncoder();

/** D1 shim. Only the surface the crowd helpers use: prepare/bind/run/first/all. */
function testDb(failOn?: string) {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        async run() {
          if (failOn && sql.includes(failOn)) throw new Error('simulated D1 failure');
          const result = sqlite.prepare(sql).run(...(binds as never[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async first() {
          return sqlite.prepare(sql).get(...(binds as never[])) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(binds as never[])) };
        },
      };
    },
  } as unknown as D1Database;
  sqlite.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, hashtags TEXT)');
  return { db, sqlite };
}

function memoryBucket(objects: Map<string, Uint8Array>) {
  return {
    async get(key: string) {
      const data = objects.get(key);
      if (!data) return null;
      return { arrayBuffer: async () => data.slice().buffer };
    },
  } as unknown as R2Bucket;
}

/** Environment for submitDetectNsfw; Crowd must look "configured" to submit. */
function crowdEnv(bucket?: R2Bucket): CrowdEnv {
  return {
    CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
    CROWD_API_KEY: 'test-key',
    BASE_URL: 'https://flaxia.app',
    ...(bucket ? { BUCKET: bucket } : {}),
  };
}

/** Environment for handleCrowdWebhook: local dev accepts unsigned callbacks. */
const WEBHOOK_ENV: CrowdEnv = { BASE_URL: 'http://localhost' };

const POST_ID = 'post-nsfw-binding';
const MEDIA_KEY = 'gif/post-nsfw-binding/0.png';
const EXPLICIT = { label: 'FEMALE_GENITALIA_EXPOSED', score: 0.98, box: [0, 0, 10, 10] };

function webhook(taskId: string, result: Record<string, unknown>, key = MEDIA_KEY): Request {
  const query = new URLSearchParams({ type: 'nsfw', postId: POST_ID, key });
  return new Request(`https://flaxia.app/api/crowd/webhook?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, status: 'done', result }),
  });
}

function seedPost(sqlite: DatabaseSync) {
  sqlite.prepare('INSERT INTO posts (id, hashtags) VALUES (?, ?)').run(POST_ID, '[]');
}

function hashtags(sqlite: DatabaseSync): string[] {
  const row = sqlite.prepare('SELECT hashtags FROM posts WHERE id = ?').get(POST_ID) as { hashtags: string };
  return JSON.parse(row.hashtags);
}

function scanRow(sqlite: DatabaseSync) {
  return sqlite
    .prepare('SELECT status, task_id, content_sha FROM post_nsfw_scans WHERE post_id = ? AND media_key = ?')
    .get(POST_ID, MEDIA_KEY) as { status: string; task_id: string | null; content_sha: string | null };
}

/** Stub the orchestrator: one accepted submission returning `task-1`. */
async function withSubmitStub<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ taskId: 'task-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe('NSFW verdict binding', () => {
  it('re-screens when the stored object changed under the same key', async () => {
    const oldBytes = encoder.encode('clean image bytes');
    const newBytes = encoder.encode('swapped explicit image bytes');
    const bucket = memoryBucket(new Map([[MEDIA_KEY, newBytes]]));
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);
    sqlite
      .prepare('INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id, content_sha) VALUES (?, ?, ?, ?, ?)')
      .run(POST_ID, MEDIA_KEY, 'done', 'task-old', bytesToHex(sha256(oldBytes)));

    const submitted = await withSubmitStub(() =>
      submitDetectNsfw(db, crowdEnv(bucket), POST_ID, MEDIA_KEY, { respectThrottle: false }),
    );

    assert.equal(submitted, true, 'a verdict for the previous bytes must not be reused');
    const row = scanRow(sqlite);
    assert.equal(row.status, 'submitted');
    assert.equal(row.task_id, 'task-1', 'the row must follow the new task');
    assert.equal(row.content_sha, bytesToHex(sha256(newBytes)), 'the row must follow the new bytes');
  });

  it('skips when the stored object still matches the verdict', async () => {
    const bytes = encoder.encode('unchanged image bytes');
    const bucket = memoryBucket(new Map([[MEDIA_KEY, bytes]]));
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);
    sqlite
      .prepare('INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id, content_sha) VALUES (?, ?, ?, ?, ?)')
      .run(POST_ID, MEDIA_KEY, 'done', 'task-old', bytesToHex(sha256(bytes)));

    const submitted = await withSubmitStub(() =>
      submitDetectNsfw(db, crowdEnv(bucket), POST_ID, MEDIA_KEY, { respectThrottle: false }),
    );

    assert.equal(submitted, false);
    assert.equal(scanRow(sqlite).task_id, 'task-old', 'an unchanged image keeps its verdict');
  });

  it('re-screens a legacy verdict that has no content hash', async () => {
    const bytes = encoder.encode('legacy scanned bytes');
    const bucket = memoryBucket(new Map([[MEDIA_KEY, bytes]]));
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);
    sqlite
      .prepare('INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id) VALUES (?, ?, ?, ?)')
      .run(POST_ID, MEDIA_KEY, 'done', 'task-legacy');

    const submitted = await withSubmitStub(() =>
      submitDetectNsfw(db, crowdEnv(bucket), POST_ID, MEDIA_KEY, { respectThrottle: false }),
    );

    assert.equal(submitted, true, 'rows written before content_sha existed cannot prove what was screened');
    assert.equal(scanRow(sqlite).content_sha, bytesToHex(sha256(bytes)));
  });

  it('keeps the previous skip behaviour when no bucket is bound', async () => {
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);
    sqlite
      .prepare('INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id) VALUES (?, ?, ?, ?)')
      .run(POST_ID, MEDIA_KEY, 'done', 'task-legacy');

    const submitted = await withSubmitStub(() =>
      submitDetectNsfw(db, crowdEnv(), POST_ID, MEDIA_KEY, { respectThrottle: false }),
    );

    assert.equal(submitted, false, 'without a hash to compare there is nothing to re-screen against');
  });

  it('adds content_sha to a database that predates the column', async () => {
    const { db, sqlite } = testDb();
    sqlite.exec(
      `CREATE TABLE post_nsfw_scans (
         post_id TEXT NOT NULL, media_key TEXT NOT NULL DEFAULT '', task_id TEXT,
         status TEXT NOT NULL DEFAULT 'submitted', created_at TEXT, scanned_at TEXT,
         PRIMARY KEY (post_id, media_key))`,
    );

    await ensureNsfwScansTable(db);

    const columns = sqlite.prepare('PRAGMA table_info(post_nsfw_scans)').all() as Array<{ name: string }>;
    assert.ok(
      columns.some((c) => c.name === 'content_sha'),
      'the bootstrap must add the column',
    );
  });

  it('ignores a verdict whose task id is not the one being tracked', async () => {
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);
    sqlite
      .prepare('INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id) VALUES (?, ?, ?, ?)')
      .run(POST_ID, MEDIA_KEY, 'submitted', 'task-current');

    const stale = await handleCrowdWebhook(webhook('task-replaced', { detections: [EXPLICIT] }), WEBHOOK_ENV, db);
    assert.equal(stale.status, 200, 'a callback we deliberately drop is still observed');
    assert.deepEqual(hashtags(sqlite), [], 'a replaced task must not tag the post');
    assert.equal(scanRow(sqlite).status, 'submitted');

    const current = await handleCrowdWebhook(webhook('task-current', { detections: [EXPLICIT] }), WEBHOOK_ENV, db);
    assert.equal(current.status, 200);
    assert.ok(hashtags(sqlite).includes('nsfw'), 'the tracked task still applies its verdict');
    assert.equal(scanRow(sqlite).status, 'done');
  });

  it('reads detections from a nested workload output too', async () => {
    const { db, sqlite } = testDb();
    seedPost(sqlite);
    await ensureNsfwScansTable(db);

    const res = await handleCrowdWebhook(
      webhook('task-nested', { output: { detections: [EXPLICIT] } }),
      WEBHOOK_ENV,
      db,
    );

    assert.equal(res.status, 200);
    assert.ok(hashtags(sqlite).includes('nsfw'), 'both {result} and {result:{output}} shapes must be read');
  });

  it('answers 500 when the row could not be written', async () => {
    const { db, sqlite } = testDb('INSERT INTO post_nsfw_scans');
    seedPost(sqlite);
    await ensureNsfwScansTable(db);

    const res = await handleCrowdWebhook(webhook('task-1', { detections: [EXPLICIT] }), WEBHOOK_ENV, db);

    assert.equal(res.status, 500, 'a lost verdict must be retryable by the orchestrator');
  });
});
