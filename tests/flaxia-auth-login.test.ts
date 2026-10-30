import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loginWithFlaxiaAuth,
  loginWithFlaxiaAuthRecovery,
  registerWithFlaxiaAuth,
} from '../src/lib/flaxia-auth-login.ts';
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

test('a frozen SRP account reports its username without exchanging a grant', async (t) => {
  const password = 'frozen account password';
  const salt = generateSalt();
  const stored = await computeVerifier(password, salt);
  const server = await serverStep1(salt, stored);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    paths.push(path);
    const body = JSON.parse(String(init?.body));
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
      return Response.json({ error: 'account_frozen', username: 'frozen_user', M2: enc(proof.M2) }, { status: 403 });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  assert.deepEqual(await loginWithFlaxiaAuth('frozen_user', password), {
    frozen: true,
    username: 'frozen_user',
  });
  assert.equal(
    paths.some((path) => path.includes('/flaxia/authorize')),
    false,
  );
  assert.equal(
    paths.some((path) => path.includes('/flaxia/exchange')),
    false,
  );
});

test('a frozen legacy account reports its username without exposing the password again', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    paths.push(path);
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/api/auth/login/start')) return Response.json({ srp: false });
    if (path.endsWith('/api/auth/login/legacy')) {
      assert.equal(body.password, 'legacy frozen password');
      return Response.json({ error: 'account_frozen', username: 'legacy_frozen' }, { status: 403 });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  assert.deepEqual(await loginWithFlaxiaAuth('legacy_frozen', 'legacy frozen password'), {
    frozen: true,
    username: 'legacy_frozen',
  });
  assert.equal(paths.length, 2);
});

test('recovery code is proven with SRP and never placed in a request', async (t) => {
  const recoveryCode = 'R'.repeat(43);
  const salt = generateSalt(),
    stored = await computeVerifier(recoveryCode, salt);
  const server = await serverStep1(salt, stored);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input),
      bodyText = init?.body === undefined ? '{}' : String(init.body),
      body = JSON.parse(bodyText);
    assert.equal(bodyText.includes(recoveryCode), false);
    if (path.endsWith('/api/auth/recovery/start'))
      return Response.json({ challenge_id: 'c', salt: enc(salt), B: enc(server.B), srp_kdf: 'pbkdf2-600k-v2' });
    if (path.endsWith('/api/auth/recovery/verify')) {
      const proof = await serverStep2(dec(body.A), server.B, server.b, stored, dec(body.M1));
      assert.ok(proof);
      return Response.json({ M2: enc(proof.M2) });
    }
    if (path.endsWith('/api/auth/flaxia/authorize')) return Response.json({ code: token });
    if (path === '/api/auth/flaxia/exchange') return Response.json({ success: true });
    throw new Error('unexpected request');
  };
  assert.equal(await loginWithFlaxiaAuthRecovery('example', recoveryCode), true);
});

test('registration enrolls the recovery verifier without sending the code or password', async (t) => {
  const password = 'registration password',
    recoveryCode = 'R'.repeat(43);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let passwordSalt = new Uint8Array(),
    passwordVerifier = new Uint8Array();
  let server: Awaited<ReturnType<typeof serverStep1>> | null = null;
  globalThis.fetch = async (input, init) => {
    const path = String(input),
      bodyText = init?.body === undefined ? '{}' : String(init.body),
      body = JSON.parse(bodyText);
    assert.equal(bodyText.includes(password), false);
    assert.equal(bodyText.includes(recoveryCode), false);
    if (path.endsWith('/api/auth/register')) {
      passwordSalt = dec(body.srp_salt);
      passwordVerifier = dec(body.srp_verifier);
      return Response.json({ user: { id: 'u' } });
    }
    if (path.endsWith('/api/auth/flaxia/authorize')) return Response.json({ code: token });
    if (path === '/api/auth/flaxia/exchange') return Response.json({ success: true });
    if (path === '/api/auth/reauth/start') {
      server = await serverStep1(passwordSalt, passwordVerifier);
      return Response.json({ challenge_id: 'c', salt: enc(passwordSalt), B: enc(server.B), srp_kdf: 'pbkdf2-600k-v2' });
    }
    if (path === '/api/auth/recovery/enroll') {
      assert.ok(server);
      assert.ok(
        await serverStep2(dec(body.current_srp.A), server.B, server.b, passwordVerifier, dec(body.current_srp.M1)),
      );
      assert.equal(body.verifier, enc(await computeVerifier(recoveryCode, dec(body.salt))));
      return Response.json({ success: true });
    }
    throw new Error('unexpected request');
  };
  assert.deepEqual(await registerWithFlaxiaAuth('user@example.test', 'user', 'User', password, recoveryCode), {
    ok: true,
  });
});
