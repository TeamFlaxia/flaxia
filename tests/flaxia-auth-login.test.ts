import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginWithFlaxiaAuth } from '../src/lib/flaxia-auth-login.ts';
import { computeVerifier, generateSalt, serverStep1, serverStep2 } from '../src/lib/srp.ts';

const enc = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const dec = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const token = 'A'.repeat(43);

test('SRP login uses Auth and exchanges a code bound to the browser verifier', async (t) => {
  const password = 'test password';
  const salt = generateSalt();
  const stored = await computeVerifier(password, salt);
  const server = await serverStep1(salt, stored);
  let challenge = '';
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body));
    assert.equal(init?.credentials, 'include');
    assert.equal('password' in body, false);
    if (path.endsWith('/api/auth/login/start'))
      return Response.json({
        srp: true,
        challenge_id: 'challenge',
        salt: enc(salt),
        B: enc(server.B),
        srp_kdf: 'pbkdf2-600k-v2',
      });
    if (path.endsWith('/api/auth/login/verify')) {
      const proof = await serverStep2(dec(body.A), server.B, server.b, stored, dec(body.M1));
      assert.ok(proof);
      return Response.json({ M2: enc(proof.M2) });
    }
    if (path.endsWith('/api/auth/flaxia/authorize')) {
      challenge = body.challenge;
      return Response.json({ code: token });
    }
    if (path === '/api/auth/flaxia/exchange') {
      assert.equal(body.code, token);
      assert.equal(
        Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier))).toString(
          'base64url',
        ),
        challenge,
      );
      return Response.json({ success: true });
    }
    throw new Error('unexpected request');
  };
  assert.equal(await loginWithFlaxiaAuth('example', password), true);
});

test('only the legacy endpoint receives the old password', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body));
    paths.push(path);
    if (path.endsWith('/api/auth/login/start')) return Response.json({ srp: false });
    if (path.endsWith('/api/auth/login/legacy')) {
      assert.equal(body.password, 'old-password');
      return Response.json({ user: { id: 'u' } });
    }
    assert.equal('password' in body, false);
    if (path.endsWith('/api/auth/flaxia/authorize')) return Response.json({ code: token });
    if (path === '/api/auth/flaxia/exchange') return Response.json({ success: true });
    throw new Error('unexpected request');
  };
  assert.equal(await loginWithFlaxiaAuth('legacy', 'old-password'), true);
  assert.equal(paths.length, 4);
});

test('does not create a Flaxia session when Auth denies login', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  };
  assert.equal(await loginWithFlaxiaAuth('example', 'wrong'), false);
  assert.equal(calls, 1);
});
