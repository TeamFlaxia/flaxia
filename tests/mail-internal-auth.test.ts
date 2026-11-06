// Pages -> Mail Worker HMAC contract (docs/mail.md §5, §8).
//
// The signature must bind the user, timestamp, method, path+query, and body so
// a captured signature cannot be replayed against another endpoint.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signMailInternal } from '../functions/lib/mail-service.ts';
import { type MailEnv, verifyInternal } from '../mail-worker/src/index.ts';

const env = { MAIL_INTERNAL_SECRET: 'test-mail-internal-secret' } as unknown as MailEnv;

describe('mail internal HMAC', () => {
  it('accepts a signature for the exact request', async () => {
    const headers = await signMailInternal(env, 'user-1', 'GET', '/internal/quota');
    assert.ok(headers);
    const req = new Request('https://flaxia-mail/internal/quota', { headers });
    assert.equal(await verifyInternal(env, req, ''), 'user-1');
  });

  it('rejects a signature replayed against a different path', async () => {
    const headers = await signMailInternal(env, 'user-1', 'GET', '/internal/quota');
    assert.ok(headers);
    const req = new Request('https://flaxia-mail/internal/keys?addresses=a@flaxia.app', { headers });
    assert.equal(await verifyInternal(env, req, ''), null);
  });

  it('rejects a signature replayed with a different body', async () => {
    const original = '{"address":"alice@flaxia.app"}';
    const headers = await signMailInternal(env, 'user-1', 'POST', '/internal/addresses', original);
    assert.ok(headers);

    const ok = new Request('https://flaxia-mail/internal/addresses', {
      method: 'POST',
      headers,
      body: original,
    });
    assert.equal(await verifyInternal(env, ok, original), 'user-1');

    const tampered = new Request('https://flaxia-mail/internal/addresses', {
      method: 'POST',
      headers,
      body: '{"address":"bob@flaxia.app"}',
    });
    assert.equal(await verifyInternal(env, tampered, '{"address":"bob@flaxia.app"}'), null);
  });

  it('fails closed without a configured secret', async () => {
    const signed = await signMailInternal(env, 'user-1', 'GET', '/internal/quota');
    assert.ok(signed);
    const req = new Request('https://flaxia-mail/internal/quota', { headers: signed });
    assert.equal(await verifyInternal({} as MailEnv, req, ''), null);
  });
});
