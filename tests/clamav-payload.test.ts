import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CrowdEnv } from '../functions/lib/crowd.ts';
import { CLAMAV_MAX_BYTES, clamavMaxBytes, submitFileScans } from '../functions/lib/scan/clamav.ts';
import { ensureFileScansTable, getFileScan, upsertFileScan } from '../functions/lib/scan/db.ts';

const DEFAULT_CROWD_BODY_CAP = 1_048_576;
const PAYLOAD_SCAFFOLD_BYTES = 4_096;

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
      };
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

function fileFeatures(bytes: Uint8Array) {
  return { sha256: bytesToHex(sha256(bytes)), kind: 'other' as const };
}

function crowdEnv(bodyCap = DEFAULT_CROWD_BODY_CAP): CrowdEnv {
  return {
    CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
    CROWD_API_KEY: 'test-api-key',
    CROWD_WEBHOOK_SECRET: 'test-webhook-secret',
    BASE_URL: 'https://flaxia.app',
    CROWD_MAX_PAYLOAD_BYTES: String(bodyCap),
    FILE_SCAN_CLAMAV_IMAGE: 'https://scanner.example/clamav.wasm',
  };
}

describe('ClamAV payload sizing and Crowd contract', () => {
  it('accounts for base64 block rounding at configured Crowd limits', () => {
    assert.equal(CLAMAV_MAX_BYTES, 783_360);
    assert.equal(clamavMaxBytes(), CLAMAV_MAX_BYTES);

    const cap = 10_001;
    const rawLimit = clamavMaxBytes({ CROWD_MAX_PAYLOAD_BYTES: String(cap) });
    const currentBodyBytes = Math.ceil(rawLimit / 3) * 4 + PAYLOAD_SCAFFOLD_BYTES;
    const nextBodyBytes = Math.ceil((rawLimit + 1) / 3) * 4 + PAYLOAD_SCAFFOLD_BYTES;
    assert.ok(currentBodyBytes <= cap);
    assert.ok(nextBodyBytes > cap);
  });

  it('submits an at-limit raw file within Crowd MAX_PAYLOAD_SIZE and signs its full SHA', async () => {
    const cap = DEFAULT_CROWD_BODY_CAP;
    const env = crowdEnv(cap);
    const raw = new Uint8Array(clamavMaxBytes(env));
    const features = fileFeatures(raw);
    const key = 'uploads/clamav.bin';
    const { db } = testDb();
    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features);

    const originalFetch = globalThis.fetch;
    let requestBody: BodyInit | null | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = init?.body;
      return new Response(JSON.stringify({ taskId: 'crowd-task-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await submitFileScans(db, env, key, 'application/octet-stream', raw);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(typeof requestBody, 'string');
    const bodyText = requestBody as string;
    assert.ok(new TextEncoder().encode(bodyText).byteLength <= cap);
    const task = JSON.parse(bodyText) as {
      payload: { files: Record<string, string> };
      callbackUrl: string;
    };
    const encodedFile = Object.values(task.payload.files)[0];
    assert.equal(encodedFile.length, Math.ceil(raw.byteLength / 3) * 4);
    assert.equal(new URL(task.callbackUrl).searchParams.get('sha'), features.sha256);
    assert.equal((await getFileScan(db, key))?.status, 'submitted');
  });

  it('does not mark a newer key too_large from a stale background upload', async () => {
    const env = crowdEnv();
    const staleBytes = new Uint8Array(clamavMaxBytes(env) + 1);
    const currentBytes = new TextEncoder().encode('new smaller content');
    const key = 'uploads/replaced-before-scan.bin';
    const { db } = testDb();
    await ensureFileScansTable(db);
    await upsertFileScan(db, key, fileFeatures(currentBytes));

    const originalFetch = globalThis.fetch;
    let submitted = false;
    globalThis.fetch = async () => {
      submitted = true;
      return new Response(JSON.stringify({ taskId: 'unexpected' }), { status: 201 });
    };
    try {
      await submitFileScans(db, env, key, 'application/octet-stream', staleBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = await getFileScan(db, key);
    assert.equal(row?.sha256, fileFeatures(currentBytes).sha256);
    assert.equal(row?.status, 'pending');
    assert.equal(submitted, false);
  });

  it('records over-cap bytes as too_large without submitting them to Crowd', async () => {
    const env = crowdEnv();
    const raw = new Uint8Array(clamavMaxBytes(env) + 1);
    const features = fileFeatures(raw);
    const key = 'uploads/too-large.bin';
    const { db } = testDb();
    await ensureFileScansTable(db);
    await upsertFileScan(db, key, features);

    const originalFetch = globalThis.fetch;
    let submitted = false;
    globalThis.fetch = async () => {
      submitted = true;
      return new Response(JSON.stringify({ taskId: 'unexpected' }), { status: 201 });
    };
    try {
      await submitFileScans(db, env, key, 'application/octet-stream', raw);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(submitted, false);
    const row = await getFileScan(db, key);
    assert.equal(row?.status, 'skipped');
    assert.equal(row?.detail, 'too_large');
  });
});
