import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleCrowdScanFileRequest } from '../functions/api/routes/crowd-scan-file.ts';
import type { Bindings } from '../functions/api/types.ts';
import { createFileScanTicket, crowdConfig, verifyFileScanTicket } from '../functions/lib/crowd.ts';
import type { FileScanRow } from '../functions/lib/scan/db.ts';

const KEY = 'uploads/scan-file.bin';
const SHA = 'a'.repeat(64);

function makeRow(overrides: Partial<FileScanRow> = {}): FileScanRow {
  return {
    r2_key: KEY,
    sha256: SHA,
    kind: 'other',
    structure_hash: null,
    text_hash: null,
    phash: null,
    status: 'submitted',
    detail: null,
    task_id: 'task-1',
    created_at: new Date().toISOString(),
    scanned_at: null,
    ...overrides,
  };
}

function makeEnv(
  options: { row?: FileScanRow | null; bytes?: Uint8Array; missingObject?: boolean; nodeOrigins?: string } = {},
) {
  const bytes = options.bytes ?? new Uint8Array([1, 2, 3, 4]);
  let objectGets = 0;
  const db = {
    prepare() {
      return {
        bind(key: string) {
          return {
            async first() {
              return options.row !== undefined && options.row?.r2_key === key ? options.row : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const bucket = {
    async get(key: string) {
      objectGets++;
      if (key !== KEY || options.missingObject) return null;
      return { size: bytes.byteLength, body: new Response(bytes).body };
    },
  } as unknown as R2Bucket;
  const env = {
    DB: db,
    BUCKET: bucket,
    BASE_URL: 'https://flaxia.app',
    CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
    CROWD_API_KEY: 'test-api-key',
    CROWD_WEBHOOK_SECRET: 'test-webhook-secret',
    CROWD_NODE_ORIGINS: options.nodeOrigins ?? 'https://node.example',
  } as unknown as Bindings;
  return { env, bytes, getObjectGets: () => objectGets };
}

async function makeTicket(env: Bindings, key = KEY, sha256 = SHA, size = 4): Promise<string> {
  return createFileScanTicket(crowdConfig(env), { key, sha256, size });
}

function request(token: string, options: { origin?: string; path?: string } = {}): Request {
  return new Request(`https://flaxia.app${options.path ?? '/api/crowd/scan-file'}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.origin ? { Origin: options.origin } : {}),
    },
  });
}

describe('Crowd scan-file ticket endpoint', () => {
  it('streams the exact pending R2 object with private, no-sniff headers', async () => {
    const { env, bytes } = makeEnv({ row: makeRow() });
    const token = await makeTicket(env);
    const response = await handleCrowdScanFileRequest(request(token, { origin: 'https://node.example' }), env);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="scan-input"');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://node.example');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  });

  it('rejects a tampered ticket before touching the bucket', async () => {
    const { env, getObjectGets } = makeEnv({ row: makeRow() });
    const token = await makeTicket(env);
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    const response = await handleCrowdScanFileRequest(request(tampered), env);
    assert.equal(response.status, 404);
    assert.equal(getObjectGets(), 0);
  });

  it('rejects expired tickets', async () => {
    const { env } = makeEnv({ row: makeRow() });
    const token = await makeTicket(env);
    assert.equal(await verifyFileScanTicket(env, token, Date.now() + 31 * 60 * 1000), null);
  });

  it('rejects a stale ticket when the current scan row hashes different bytes', async () => {
    const { env, getObjectGets } = makeEnv({ row: makeRow({ sha256: 'b'.repeat(64) }) });
    const token = await makeTicket(env);
    const response = await handleCrowdScanFileRequest(request(token), env);
    assert.equal(response.status, 404);
    assert.equal(getObjectGets(), 0);
  });

  it('allows an already-queued secondary scan after a clean verdict, but blocks terminal failures', async () => {
    const cleanRow = makeRow();
    const clean = makeEnv({ row: cleanRow });
    const cleanTicket = await makeTicket(clean.env);
    cleanRow.status = 'clean';
    assert.equal((await handleCrowdScanFileRequest(request(cleanTicket), clean.env)).status, 200);

    for (const status of ['infected', 'failed', 'skipped'] as const) {
      const terminal = makeEnv({ row: makeRow({ status }) });
      const token = await makeTicket(terminal.env);
      assert.equal((await handleCrowdScanFileRequest(request(token), terminal.env)).status, 404);
      assert.equal(terminal.getObjectGets(), 0);
    }

    const missing = makeEnv({ row: makeRow(), missingObject: true });
    const missingTicket = await makeTicket(missing.env);
    assert.equal((await handleCrowdScanFileRequest(request(missingTicket), missing.env)).status, 404);

    const wrongSize = makeEnv({ row: makeRow(), bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    const sizeTicket = await makeTicket(wrongSize.env);
    assert.equal((await handleCrowdScanFileRequest(request(sizeTicket), wrongSize.env)).status, 404);
  });

  it('requires an allowed node origin for browser access and supports Authorization preflight', async () => {
    const { env, getObjectGets } = makeEnv({ row: makeRow() });
    const token = await makeTicket(env);
    const denied = await handleCrowdScanFileRequest(request(token, { origin: 'https://evil.example' }), env);
    assert.equal(denied.status, 403);
    assert.equal(getObjectGets(), 0);

    const preflight = await handleCrowdScanFileRequest(
      new Request('https://flaxia.app/api/crowd/scan-file', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://node.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      }),
      env,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization');
  });
});
