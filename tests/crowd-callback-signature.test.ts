import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { crowdConfig, handleCrowdWebhook } from '../functions/lib/crowd.ts';

// `/api/crowd/webhook` is a standalone Pages Function, so the Hono auth
// middleware never runs on it. Crowd authenticates every delivery with
// `X-Flaxia-Signature/Timestamp/Nonce`; the retired `?sig=` query contract must
// not be accepted.

const WITH_HEADER_SECRET = {
  CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
  CROWD_API_KEY: 'api-key-value',
  CROWD_WEBHOOK_SIGNING_SECRET: 'webhook-signing-secret',
  BASE_URL: 'https://flaxia.app',
};

const WITH_ROTATED_TICKET_SECRET = {
  CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
  CROWD_API_KEY: 'api-key-value',
  CROWD_WEBHOOK_SECRET: 'rotated-ticket-secret',
  BASE_URL: 'https://flaxia.app',
};

const UNCONFIGURED_LOCAL = { BASE_URL: 'http://localhost:8787' };

// Minimal D1 surface for the nonce replay guard. Other tables are never touched
// by the unknown-workload callbacks used here.
function nonceDb(): D1Database {
  const seen = new Set<string>();
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO crowd_webhook_nonces')) {
            const nonce = String(binds[0]);
            if (seen.has(nonce)) return { success: true, meta: { changes: 0 } };
            seen.add(nonce);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [], success: true };
        },
      };
    },
  } as unknown as D1Database;
}

function headerSignedRequest(
  body: Record<string, unknown>,
  opts: { secret?: string; timestamp?: string; nonce?: string; signBody?: string; rawBody?: string } = {},
): Request {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomUUID();
  const mac = createHmac('sha256', opts.secret ?? 'webhook-signing-secret')
    .update(`${timestamp}.${nonce}.${opts.signBody ?? raw}`)
    .digest('base64url');
  return new Request('https://flaxia.app/api/crowd/webhook?type=unknown-workload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Flaxia-Signature': `sha256=${mac}`,
      'X-Flaxia-Timestamp': timestamp,
      'X-Flaxia-Nonce': nonce,
    },
    body: raw,
  });
}

const FAILED_BODY = { taskId: 't-header', status: 'failed', error: 'boom' };

describe('Crowd webhook configuration', () => {
  it('derives the scan-file ticket secret from the environment', () => {
    assert.equal(
      crowdConfig(WITH_HEADER_SECRET).fileScanTicketSecret,
      'api-key-value',
      'falls back to the API key so nothing extra must be provisioned',
    );
    assert.equal(
      crowdConfig(WITH_ROTATED_TICKET_SECRET).fileScanTicketSecret,
      'rotated-ticket-secret',
      'CROWD_WEBHOOK_SECRET wins when set',
    );
    assert.equal(crowdConfig(UNCONFIGURED_LOCAL).fileScanTicketSecret, '', 'an unconfigured Crowd never signs');
    assert.equal(
      crowdConfig({ CROWD_ORCHESTRATOR_URL: 'https://crowd.example' }).fileScanTicketSecret,
      '',
      'a missing API key means no secret, not a half-configured one',
    );
  });

  it('keeps webhook signing opt-in until Crowd provides the dedicated secret', () => {
    assert.equal(crowdConfig(WITH_HEADER_SECRET).webhookSigningSecret, 'webhook-signing-secret');
    assert.equal(crowdConfig(WITH_ROTATED_TICKET_SECRET).webhookSigningSecret, '');
  });
});

describe('Crowd header-signed webhook', () => {
  it('accepts a valid X-Flaxia signature', async () => {
    const res = await handleCrowdWebhook(headerSignedRequest(FAILED_BODY), WITH_HEADER_SECRET, nonceDb());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });

  it('rejects a body that does not match the signature', async () => {
    const res = await handleCrowdWebhook(
      headerSignedRequest(FAILED_BODY, { signBody: JSON.stringify({ ...FAILED_BODY, error: 'other' }) }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 401);
  });

  it('rejects a signature made with a different secret', async () => {
    const res = await handleCrowdWebhook(
      headerSignedRequest(FAILED_BODY, { secret: 'not-the-signing-secret' }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 401);
  });

  it('rejects a stale timestamp', async () => {
    const res = await handleCrowdWebhook(
      headerSignedRequest(FAILED_BODY, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 401);
  });

  it('rejects a replayed nonce', async () => {
    const db = nonceDb();
    const nonce = crypto.randomUUID();
    const first = await handleCrowdWebhook(headerSignedRequest(FAILED_BODY, { nonce }), WITH_HEADER_SECRET, db);
    assert.equal(first.status, 200);
    const replay = await handleCrowdWebhook(headerSignedRequest(FAILED_BODY, { nonce }), WITH_HEADER_SECRET, db);
    assert.equal(replay.status, 401);
  });

  it('acks a signed body that can never parse instead of asking for a retry', async () => {
    const res = await handleCrowdWebhook(
      headerSignedRequest({}, { rawBody: 'not-json{{{' }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });

  it('rejects the retired ?sig= query signature even when it is valid', async () => {
    // A configured Crowd must never fall back to the body-independent token.
    const params = new URLSearchParams({ type: 'unknown-workload' });
    params.sort();
    const legacySig = createHmac('sha256', 'api-key-value').update(`/api/crowd/webhook?${params}`).digest('hex');
    params.set('sig', legacySig);
    const res = await handleCrowdWebhook(
      new Request(`https://flaxia.app/api/crowd/webhook?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FAILED_BODY),
      }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 401);
  });

  it('rejects a callback without a signature when the secret is configured', async () => {
    const res = await handleCrowdWebhook(
      new Request('https://flaxia.app/api/crowd/webhook?type=unknown-workload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FAILED_BODY),
      }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 401);
  });

  it('keeps unsigned callbacks working only on an unconfigured local dev server', async () => {
    const local = new Request('http://localhost:8787/api/crowd/webhook?type=unknown-workload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FAILED_BODY),
    });
    assert.equal((await handleCrowdWebhook(local, UNCONFIGURED_LOCAL, nonceDb())).status, 200);

    const production = new Request('https://flaxia.app/api/crowd/webhook?type=unknown-workload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FAILED_BODY),
    });
    assert.equal(
      (await handleCrowdWebhook(production, { BASE_URL: 'https://flaxia.app' }, nonceDb())).status,
      401,
      'production must never accept unsigned callbacks',
    );
  });
});
