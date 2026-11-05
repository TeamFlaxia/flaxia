import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  type CrowdConfig,
  crowdConfig,
  handleCrowdWebhook,
  signedCallbackUrl,
  verifyCallbackSignature,
} from '../functions/lib/crowd.ts';

// `/api/crowd/webhook` is a standalone Pages Function, so the Hono auth
// middleware never runs on it. Without a signature on the callback URL anyone
// who knows a public media key could post an `infected` verdict and have the
// file blocklisted for good.

const OPTS = {
  baseUrl: 'https://flaxia.app',
  type: 'file-scan',
  params: { key: 'gif/abc123/0.png', kind: 'clamav', sha: 'deadbeefdeadbeef' },
} as const;

const WITH_API_KEY = crowdConfig({
  CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
  CROWD_API_KEY: 'api-key-value',
  BASE_URL: 'https://flaxia.app',
});

const WITH_ROTATED_SECRET = crowdConfig({
  CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
  CROWD_API_KEY: 'api-key-value',
  CROWD_WEBHOOK_SECRET: 'rotated-callback-secret',
  BASE_URL: 'https://flaxia.app',
});

const UNCONFIGURED = crowdConfig({ BASE_URL: 'http://localhost:8787' });

const WITH_HEADER_SECRET = {
  CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
  CROWD_API_KEY: 'api-key-value',
  CROWD_WEBHOOK_SIGNING_SECRET: 'webhook-signing-secret',
  BASE_URL: 'https://flaxia.app',
};

async function signedWith(config: CrowdConfig): Promise<URL> {
  return new URL(await signedCallbackUrl(config, OPTS));
}

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
  opts: { secret?: string; timestamp?: string; nonce?: string; signBody?: string } = {},
): Request {
  const raw = JSON.stringify(body);
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

describe('callback signing', () => {
  it('derives the signing secret from the environment', () => {
    assert.equal(
      WITH_API_KEY.webhookSecret,
      'api-key-value',
      'falls back to the API key so nothing must be provisioned',
    );
    assert.equal(WITH_ROTATED_SECRET.webhookSecret, 'rotated-callback-secret', 'CROWD_WEBHOOK_SECRET wins when set');
    assert.equal(UNCONFIGURED.webhookSecret, '', 'an unconfigured Crowd never signs');
    assert.equal(
      crowdConfig({ CROWD_ORCHESTRATOR_URL: 'https://crowd.example' }).webhookSecret,
      '',
      'a missing API key means no secret, not a half-configured one',
    );
    assert.equal(crowdConfig(WITH_HEADER_SECRET).webhookSigningSecret, 'webhook-signing-secret');
    assert.equal(WITH_API_KEY.webhookSigningSecret, '', 'the header secret is opt-in');
  });

  it('accepts a callback it signed', async () => {
    const url = await signedWith(WITH_API_KEY);
    assert.ok(url.searchParams.get('sig'), 'the signature must travel on the URL');
    assert.equal(await verifyCallbackSignature(url, WITH_API_KEY), true);
  });

  it('rejects a forged infected verdict', async () => {
    const url = await signedWith(WITH_API_KEY);
    // The attack from the review: same public key, attacker-chosen sha and
    // verdict. Only the `sha` param changes, so the signature must break.
    url.searchParams.set('sha', '0000000000000000');
    assert.equal(await verifyCallbackSignature(url, WITH_API_KEY), false);
  });

  it('rejects a callback with no signature at all', async () => {
    const url = await signedWith(WITH_API_KEY);
    url.searchParams.delete('sig');
    assert.equal(await verifyCallbackSignature(url, WITH_API_KEY), false);
  });

  it('rejects a signature made under a different secret', async () => {
    assert.equal(await verifyCallbackSignature(await signedWith(WITH_API_KEY), WITH_ROTATED_SECRET), false);
    assert.equal(await verifyCallbackSignature(await signedWith(WITH_ROTATED_SECRET), WITH_ROTATED_SECRET), true);
    assert.equal(await verifyCallbackSignature(await signedWith(WITH_ROTATED_SECRET), WITH_API_KEY), false);
  });

  it('is independent of query parameter order', async () => {
    const signed = await signedWith(WITH_API_KEY);
    const sig = signed.searchParams.get('sig');
    signed.searchParams.delete('sig');
    const reordered = new URL(signed.origin + signed.pathname);
    for (const [name, value] of [...signed.searchParams.entries()].reverse()) {
      reordered.searchParams.append(name, value);
    }
    reordered.searchParams.set('sig', sig as string);
    assert.equal(await verifyCallbackSignature(reordered, WITH_API_KEY), true);
  });

  it('leaves unsigned URLs alone only in local/test deployments', async () => {
    const unsigned = new URL('https://flaxia.app/api/crowd/webhook?type=file-scan&key=a');
    assert.equal(await verifyCallbackSignature(unsigned, UNCONFIGURED), true, 'local dev and tests stay usable');
    assert.equal(await verifyCallbackSignature(unsigned, WITH_API_KEY), false, 'a configured Crowd must verify');
    const unconfiguredProd = crowdConfig({ BASE_URL: 'https://flaxia.app' });
    assert.equal(
      await verifyCallbackSignature(unsigned, unconfiguredProd),
      false,
      'production must never accept unsigned callbacks',
    );
    assert.equal((await signedWith(UNCONFIGURED)).searchParams.get('sig'), null);
  });
});

// The Crowd worker signs webhook deliveries with its dedicated
// WEBHOOK_SIGNING_SECRET over `<timestamp>.<nonce>.<raw body>` and sends the
// values in X-Flaxia-* headers. This is the contract the SDK exposes as
// verifyCrowdWebhook(); the query-signature tests above cover the legacy path.
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

  it('still accepts the legacy query signature when no headers are present', async () => {
    const url = new URL(
      await signedCallbackUrl(crowdConfig(WITH_HEADER_SECRET), {
        baseUrl: 'https://flaxia.app',
        type: 'unknown-workload',
      }),
    );
    const res = await handleCrowdWebhook(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FAILED_BODY),
      }),
      WITH_HEADER_SECRET,
      nonceDb(),
    );
    assert.equal(res.status, 200);
  });
});
