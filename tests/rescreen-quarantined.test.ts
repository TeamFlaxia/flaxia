import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ensureFileScansTable, upsertFileScan } from '../functions/lib/scan/db.ts';
import { extractFileFeatures } from '../functions/lib/scan/features.ts';
import { rescreenQuarantinedObject } from '../functions/lib/scan/rescreen.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=',
  'base64',
);

function testDb() {
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
  return { db, sqlite };
}

function bucket(bytes: Uint8Array) {
  return {
    async get() {
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
    },
  } as unknown as R2Bucket;
}

function crowdEnv(fileSources = true) {
  return {
    CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
    CROWD_API_KEY: 'test-key',
    BASE_URL: 'https://flaxia.app',
    FILE_SCAN_CLAMAV_IMAGE: 'https://example.com/clamav.wasm',
    CROWD_MAX_PAYLOAD_BYTES: '1048576',
    CROWD_SCAN_FILE_SOURCES: fileSources ? '1' : '0',
  };
}

async function seedSkipped(db: D1Database, sqlite: DatabaseSync, key: string, bytes = PNG, detail = 'too_large') {
  await ensureFileScansTable(db);
  const features = await extractFileFeatures(bytes, 'image/png');
  await upsertFileScan(db, key, features);
  sqlite.prepare("UPDATE file_scans SET status = 'skipped', detail = ? WHERE r2_key = ?").run(detail, key);
  return features.sha256;
}

describe('rescreenQuarantinedObject', () => {
  it('submits a previously too_large file-source image without unblocking it', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen/0.png';
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set(PNG);
    await seedSkipped(db, sqlite, key, bytes);
    const originalFetch = globalThis.fetch;
    let submittedPayload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      submittedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ taskId: 'rescreen-task' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      assert.equal(await rescreenQuarantinedObject(db, bucket(bytes), crowdEnv(), key), 'submitted');
      assert.ok(submittedPayload);
      const payload = submittedPayload as {
        payload?: { files?: Record<string, string>; fileSources?: Record<string, unknown> };
      };
      assert.deepEqual(payload.payload?.files, {});
      assert.ok(payload.payload?.fileSources?.['input.png'], 'large rescreens use signed file-source tickets');
      const row = sqlite.prepare('SELECT status, task_id, detail FROM file_scans WHERE r2_key = ?').get(key) as {
        status: string;
        task_id: string;
        detail: string | null;
      };
      assert.equal(row.status, 'submitted');
      assert.equal(row.task_id, 'rescreen-task');
      assert.equal(row.detail, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not rescreen bytes that differ from the quarantined SHA', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen-mismatch/0.png';
    await seedSkipped(db, sqlite, key);
    const other = Uint8Array.from(PNG);
    other[other.length - 1] ^= 1;
    assert.equal(await rescreenQuarantinedObject(db, bucket(other), crowdEnv(), key), 'not_eligible');
    const row = sqlite.prepare('SELECT status, detail FROM file_scans WHERE r2_key = ?').get(key) as {
      status: string;
      detail: string;
    };
    assert.equal(row.status, 'skipped');
    assert.equal(row.detail, 'too_large');
  });

  it('does not rescreen beyond the inline payload limit when sources are disabled', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen-disabled/0.png';
    const bytes = new Uint8Array(800_000);
    bytes.set(PNG);
    await seedSkipped(db, sqlite, key, bytes);
    const largeFile = new Uint8Array(2 * 1024 * 1024);
    largeFile.set(PNG);
    const limitedEnv = { ...crowdEnv(false), CROWD_MAX_PAYLOAD_BYTES: '100000' };
    assert.equal(await rescreenQuarantinedObject(db, bucket(largeFile), limitedEnv, key), 'too_large');
    const row = sqlite.prepare('SELECT status, detail FROM file_scans WHERE r2_key = ?').get(key) as {
      status: string;
      detail: string;
    };
    assert.equal(row.status, 'skipped');
    assert.equal(row.detail, 'too_large');
  });

  it('retries unconfigured skips once Crowd and the ClamAV image are configured', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen-configured/0.png';
    const bytes = new Uint8Array(100_000);
    bytes.set(PNG);
    await seedSkipped(db, sqlite, key, bytes, 'orchestrator_unconfigured');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ taskId: 'configured-task' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      assert.equal(await rescreenQuarantinedObject(db, bucket(bytes), crowdEnv(false), key), 'submitted');
      const row = sqlite.prepare('SELECT status, task_id FROM file_scans WHERE r2_key = ?').get(key) as {
        status: string;
        task_id: string;
      };
      assert.equal(row.status, 'submitted');
      assert.equal(row.task_id, 'configured-task');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not overwrite a newer quarantine verdict if R2 fails while opening an object', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen-race/0.png';
    await seedSkipped(db, sqlite, key);
    const unavailableBucket = {
      async get() {
        sqlite.prepare("UPDATE file_scans SET status = 'skipped', detail = 'too_large' WHERE r2_key = ?").run(key);
        throw new Error('temporary R2 outage');
      },
    } as unknown as R2Bucket;
    assert.equal(await rescreenQuarantinedObject(db, unavailableBucket, crowdEnv(), key), 'failed');
    const row = sqlite.prepare('SELECT status, detail FROM file_scans WHERE r2_key = ?').get(key) as {
      status: string;
      detail: string;
    };
    assert.equal(row.status, 'skipped');
    assert.equal(row.detail, 'too_large');
  });

  it('does not modify clean or infected scan rows', async () => {
    const { db, sqlite } = testDb();
    const key = 'gif/rescreen-ineligible/0.png';
    await seedSkipped(db, sqlite, key);
    sqlite.prepare("UPDATE file_scans SET status = 'infected', detail = 'test' WHERE r2_key = ?").run(key);
    assert.equal(await rescreenQuarantinedObject(db, bucket(PNG), crowdEnv(), key), 'not_eligible');
    const row = sqlite.prepare('SELECT status, detail FROM file_scans WHERE r2_key = ?').get(key) as {
      status: string;
      detail: string;
    };
    assert.equal(row.status, 'infected');
    assert.equal(row.detail, 'test');
  });
});
