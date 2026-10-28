import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { clientStep1, clientStep2, computeVerifier, generateSalt, verifyServerProof } from '../../src/lib/srp.ts';

const authBase = process.env.FLAXIA_AUTH_TEST_URL;
const appBase = process.env.FLAXIA_APP_TEST_URL;
const enc = (value: Uint8Array) => Buffer.from(value).toString('base64');
const dec = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

test('real Workers exchange and revoke a session through the service binding', {
  skip: !authBase || !appBase,
  timeout: 60000,
}, async () => {
  assert.ok(authBase && appBase);
  const username = `it${randomBytes(6).toString('hex')}`;
  const password = 'integration-test password';
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = 'https://flaxia.app') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'CF-Connecting-IP': '192.0.2.222',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const registration = await post(authBase, '/api/auth/register', {
    username,
    srp_salt: enc(salt),
    srp_verifier: enc(verifier),
    srp_group: '2048',
    srp_kdf: 'pbkdf2-600k-v2',
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { user } = (await registration.json()) as { user: { id: string } };
  const start = await post(authBase, '/api/auth/login/start', { username });
  assert.equal(start.status, 200);
  const handshake = (await start.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const { a: loginScalar } = await clientStep1(password, dec(handshake.salt));
  const loginProof = await clientStep2(password, dec(handshake.salt), loginScalar, dec(handshake.B), handshake.srp_kdf);
  const login = await post(authBase, '/api/auth/login/verify', {
    challenge_id: handshake.challenge_id,
    A: enc(loginProof.A),
    M1: enc(loginProof.M1),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const { M2 } = (await login.json()) as { M2: string };
  assert.equal(await verifyServerProof(loginProof.A, loginProof.M1, loginProof.K, dec(M2)), true);
  const authCookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  // Only generated values are interpolated; use an isolated local D1 database.
  const seed = `INSERT INTO users (id, email, username, display_name, password_hash, srp_salt, srp_verifier, srp_group, srp_kdf) VALUES ('${user.id}', '${username}@example.test', '${username}', '${username}', '', '${enc(salt)}', '${enc(verifier)}', '2048', 'pbkdf2-600k-v2')`;
  const db = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--command', seed],
    { encoding: 'utf8' },
  );
  assert.equal(db.status, 0, db.stderr);
  const makeCode = async () => {
    const secret = randomBytes(32).toString('base64url');
    const response = await post(authBase, '/api/auth/flaxia/authorize', { challenge: digest(secret) }, authCookie);
    assert.equal(response.status, 200, await response.clone().text());
    return { secret, code: ((await response.json()) as { code: string }).code };
  };
  const { secret, code } = await makeCode();
  assert.equal(
    (await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: secret }, undefined, 'https://evil.example'))
      .status,
    403,
  );
  const incorrectVerifier = randomBytes(32).toString('base64url');
  assert.equal(
    (await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: incorrectVerifier }, undefined, appBase))
      .status,
    401,
  );
  const exchange = await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: secret }, undefined, appBase);
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const session = exchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(session);
  assert.equal(
    (await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: secret }, undefined, appBase)).status,
    401,
  );
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: session } })).status, 200);
  const challengeResponse = await post(appBase, '/api/auth/reauth/start', {}, session, appBase);
  assert.equal(challengeResponse.status, 200, await challengeResponse.clone().text());
  const challenge = (await challengeResponse.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const { a } = await clientStep1(password, dec(challenge.salt));
  const proof = await clientStep2(password, dec(challenge.salt), a, dec(challenge.B), challenge.srp_kdf);
  const reauth = await post(
    appBase,
    '/api/auth/reauth/verify',
    { challenge_id: challenge.challenge_id, A: enc(proof.A), M1: enc(proof.M1) },
    session,
    appBase,
  );
  assert.equal(reauth.status, 200);
  assert.equal(((await reauth.json()) as { valid: boolean }).valid, true);
  const second = await makeCode();
  const secondExchange = await post(
    appBase,
    '/api/auth/flaxia/exchange',
    { code: second.code, verifier: second.secret },
    undefined,
    appBase,
  );
  assert.equal(secondExchange.status, 200);
  const secondSession = secondExchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(secondSession);
  assert.equal((await post(appBase, '/api/auth/logout', {}, secondSession, appBase)).status, 200);
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: secondSession } })).status, 401);
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: session } })).status, 200);
  const loggedOut = await post(authBase, '/api/auth/logout', {}, authCookie);
  assert.equal(loggedOut.status, 200);
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: session } })).status, 401);
});
