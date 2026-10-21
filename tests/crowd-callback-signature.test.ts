import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CrowdConfig, crowdConfig, signedCallbackUrl, verifyCallbackSignature } from '../functions/lib/crowd.ts';

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

async function signedWith(config: CrowdConfig): Promise<URL> {
  return new URL(await signedCallbackUrl(config, OPTS));
}

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
