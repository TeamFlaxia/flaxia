import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { clientStep1, clientStep2, computeVerifier, generateSalt, verifyServerProof } from '../../src/lib/srp.ts';
import {
  createVaultEnvelope,
  generateVaultSalt,
  rewrapVaultKeyForPassword,
  unlockVaultWithPassword,
  unlockVaultWithRecovery,
} from '../../src/lib/vault/primitives.ts';

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

test('local SRP account can provision Auth idempotently with password proof', {
  skip: !authBase || !appBase,
  timeout: 60000,
}, async () => {
  assert.ok(authBase && appBase);
  const username = `pr${randomBytes(6).toString('hex')}`;
  const password = 'provision test password';
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = appBase) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'CF-Connecting-IP': '192.0.2.231',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const registration = await post(appBase, '/api/auth/register', {
    email: `${username}@example.test`,
    username,
    display_name: username,
    srp_salt: enc(salt),
    srp_verifier: enc(verifier),
    srp_group: '2048',
    srp_kdf: 'pbkdf2-600k-v2',
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const cookie = registration.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal((await post(appBase, '/api/auth/flaxia/provision', {}, cookie)).status, 400);
  const makeProof = async (guess: string) => {
    const start = await post(appBase, '/api/auth/reauth/start', {}, cookie);
    assert.equal(start.status, 200);
    const hs = (await start.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: 'pbkdf2-600k-v2' };
    const first = await clientStep1(guess, dec(hs.salt));
    const proof = await clientStep2(guess, dec(hs.salt), first.a, dec(hs.B), hs.srp_kdf);
    return { challenge_id: hs.challenge_id, A: enc(proof.A), M1: enc(proof.M1) };
  };
  assert.equal(
    (await post(appBase, '/api/auth/flaxia/provision', await makeProof('wrong password'), cookie)).status,
    401,
  );
  const first = await post(appBase, '/api/auth/flaxia/provision', await makeProof(password), cookie);
  assert.equal(first.status, 200, await first.clone().text());
  const guardedChange = await fetch(`${appBase}/api/users/me/password`, {
    method: 'PATCH',
    headers: { Origin: appBase, Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(guardedChange.status, 409);
  const guardedDelete = await fetch(`${appBase}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: appBase, Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(guardedDelete.status, 409);
  assert.equal((await post(appBase, '/api/auth/flaxia/provision', await makeProof(password), cookie)).status, 200);
  const authLogin = await post(authBase, '/api/auth/login/start', { username }, undefined, 'https://flaxia.app');
  assert.equal(authLogin.status, 200, await authLogin.clone().text());
  const authHs = (await authLogin.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const authFirst = await clientStep1(password, dec(authHs.salt));
  const authProof = await clientStep2(password, dec(authHs.salt), authFirst.a, dec(authHs.B), authHs.srp_kdf);
  const loggedIn = await post(
    authBase,
    '/api/auth/login/verify',
    { challenge_id: authHs.challenge_id, A: enc(authProof.A), M1: enc(authProof.M1) },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(loggedIn.status, 200);
  const authCookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  const pkce = randomBytes(32).toString('base64url');
  const authorized = await post(
    authBase,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorized.status, 200);
  const code = ((await authorized.json()) as { code: string }).code;
  const exchanged = await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: pkce }, undefined, appBase);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const linkedCookie = exchanged.headers.get('set-cookie')?.split(';')[0];
  assert.ok(linkedCookie);
  // Recovery enrollment must be available while the account is only linked,
  // before AUTH_AUTHORITY_MODE is enabled (a documented rollout prerequisite).
  const recoveryStatus = await fetch(`${appBase}/api/auth/recovery/status`, {
    headers: { Cookie: linkedCookie },
  });
  assert.equal(recoveryStatus.status, 200, await recoveryStatus.clone().text());
  assert.equal(((await recoveryStatus.json()) as { enrolled: boolean }).enrolled, false);
  const linkedProof = async (guess: string) => {
    const response = await post(appBase, '/api/auth/reauth/start', {}, linkedCookie, appBase);
    assert.equal(response.status, 200);
    const hs = (await response.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: 'pbkdf2-600k-v2' };
    const first = await clientStep1(guess, dec(hs.salt));
    const proof = await clientStep2(guess, dec(hs.salt), first.a, dec(hs.B), hs.srp_kdf);
    return { challenge_id: hs.challenge_id, A: enc(proof.A), M1: enc(proof.M1) };
  };
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const vault = await createVaultEnvelope(password, phrase);
  const vaultCreated = await post(
    appBase,
    '/api/vault/keys',
    { ...vault.envelope, current_srp: await linkedProof(password) },
    linkedCookie,
    appBase,
  );
  assert.equal(vaultCreated.status, 201, await vaultCreated.clone().text());
  const newPassword = 'replacement integration password';
  const newSrpSalt = generateSalt(),
    newSrpVerifier = await computeVerifier(newPassword, newSrpSalt);
  const newVaultSalt = generateVaultSalt();
  const newWrappedVk = await rewrapVaultKeyForPassword(vault.vk, newPassword, newVaultSalt, vault.envelope.kdf_params);
  const credentialOperation = randomBytes(32).toString('base64url');
  const changeBody = {
    operation: credentialOperation,
    srp_salt: enc(newSrpSalt),
    srp_verifier: enc(newSrpVerifier),
    srp_group: '2048',
    srp_kdf: 'pbkdf2-600k-v2',
    vault_kek: {
      salt: enc(newVaultSalt),
      wrapped_vk: newWrappedVk,
      kdf_params: vault.envelope.kdf_params,
      vk_version: 1,
    },
    current_srp: await linkedProof(password),
  };
  const wrongCredentialOperation = randomBytes(32).toString('base64url');
  const wrongChange = await fetch(`${appBase}/api/users/me/password`, {
    method: 'PATCH',
    headers: { Origin: appBase, Cookie: linkedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...changeBody,
      operation: wrongCredentialOperation,
      current_srp: await linkedProof('incorrect password'),
    }),
  });
  assert.equal(wrongChange.status, 401, await wrongChange.clone().text());
  assert.equal(((await wrongChange.json()) as { cancelled?: boolean }).cancelled, true);
  const change = await fetch(`${appBase}/api/users/me/password`, {
    method: 'PATCH',
    headers: { Origin: appBase, Cookie: linkedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(changeBody),
  });
  assert.equal(change.status, 200, await change.clone().text());
  assert.equal(
    (await post(appBase, '/api/users/me/credentials/retry', { operation: credentialOperation })).status,
    200,
  );
  const vaultAfter = await fetch(`${appBase}/api/vault/keys`, { headers: { Cookie: linkedCookie } });
  assert.equal(vaultAfter.status, 200);
  const savedVault = (await vaultAfter.json()) as typeof vault.envelope;
  assert.deepEqual(await unlockVaultWithPassword(newPassword, savedVault), vault.vk);
  assert.deepEqual(await unlockVaultWithRecovery(phrase, savedVault), vault.vk);
  await assert.rejects(unlockVaultWithPassword(password, savedVault));
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: linkedCookie } })).status, 200);
  const operation = randomBytes(32).toString('base64url');
  const wrongStart = await post(appBase, '/api/auth/reauth/start', {}, linkedCookie, appBase);
  const wrongHs = (await wrongStart.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const wrongFirst = await clientStep1('wrong password', dec(wrongHs.salt));
  const wrongProof = await clientStep2(
    'wrong password',
    dec(wrongHs.salt),
    wrongFirst.a,
    dec(wrongHs.B),
    wrongHs.srp_kdf,
  );
  const wrongDeletion = await fetch(`${appBase}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: appBase, Cookie: linkedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation,
      current_srp: { challenge_id: wrongHs.challenge_id, A: enc(wrongProof.A), M1: enc(wrongProof.M1) },
    }),
  });
  assert.equal(wrongDeletion.status, 401);
  assert.equal((await post(appBase, '/api/users/me/deletion/retry', { operation })).status, 401);
  const deleteStart = await post(appBase, '/api/auth/reauth/start', {}, linkedCookie, appBase);
  assert.equal(deleteStart.status, 200);
  const deleteHs = (await deleteStart.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const deleteFirst = await clientStep1(newPassword, dec(deleteHs.salt));
  const deleteProof = await clientStep2(
    newPassword,
    dec(deleteHs.salt),
    deleteFirst.a,
    dec(deleteHs.B),
    deleteHs.srp_kdf,
  );
  const deletion = await fetch(`${appBase}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: appBase, Cookie: linkedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation,
      current_srp: { challenge_id: deleteHs.challenge_id, A: enc(deleteProof.A), M1: enc(deleteProof.M1) },
    }),
  });
  assert.equal(deletion.status, 200, await deletion.clone().text());
  assert.equal((await post(appBase, '/api/users/me/deletion/retry', { operation })).status, 200);
  assert.equal(
    (await post(appBase, '/api/users/me/deletion/retry', { operation: randomBytes(32).toString('base64url') })).status,
    404,
  );
  assert.equal((await fetch(`${appBase}/api/me`, { headers: { Cookie: linkedCookie } })).status, 401);
  assert.equal(
    (
      await fetch(`${authBase}/api/auth/me`, {
        headers: { Origin: 'https://flaxia.app', Cookie: authCookie, 'CF-Connecting-IP': '192.0.2.231' },
      })
    ).status,
    401,
  );
});

test('linking refuses a local profile whose copied credentials changed', {
  skip: !authBase || !appBase,
  timeout: 60000,
}, async () => {
  assert.ok(authBase && appBase);
  const username = `mm${randomBytes(6).toString('hex')}`;
  const password = 'Auth copy password';
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = 'https://flaxia.app') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'CF-Connecting-IP': '192.0.2.241',
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
  const authCookie = registration.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);

  // The local copy still opens a different password, so copying must not link.
  const localSalt = generateSalt();
  const localVerifier = await computeVerifier('different local password', localSalt);
  const seed = `INSERT INTO users (id, email, username, display_name, password_hash, srp_salt, srp_verifier, srp_group, srp_kdf) VALUES ('${user.id}', '${username}@example.test', '${username}', '${username}', '', '${enc(localSalt)}', '${enc(localVerifier)}', '2048', 'pbkdf2-600k-v2')`;
  const db = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--command', seed],
    { encoding: 'utf8' },
  );
  assert.equal(db.status, 0, db.stderr);

  const pkce = randomBytes(32).toString('base64url');
  const authorize = await post(
    authBase,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorize.status, 200, await authorize.clone().text());
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: pkce }, undefined, appBase);
  assert.equal(exchange.status, 409, await exchange.clone().text());
  assert.equal(exchange.headers.get('set-cookie'), null, 'a failed credential comparison must not issue a session');
});

test('an opt-in linked session updates the authoritative Auth email', {
  skip: !authBase || !appBase,
  timeout: 60000,
}, async () => {
  assert.ok(authBase && appBase);
  const username = `em${randomBytes(6).toString('hex')}`;
  const password = 'email authority password';
  const originalEmail = `${username}@example.test`;
  const updatedEmail = `${username}@updated.test`;
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'CF-Connecting-IP': '192.0.2.242',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const registration = await post(
    authBase,
    '/api/auth/register',
    {
      email: originalEmail,
      username,
      srp_salt: enc(salt),
      srp_verifier: enc(verifier),
      srp_group: '2048',
      srp_kdf: 'pbkdf2-600k-v2',
    },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(registration.status, 201, await registration.clone().text());
  const { user } = (await registration.json()) as { user: { id: string } };
  const authCookie = registration.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  const seed = `INSERT INTO users (id, email, username, display_name, password_hash, srp_salt, srp_verifier, srp_group, srp_kdf) VALUES ('${user.id}', '${originalEmail}', '${username}', '${username}', '', '${enc(salt)}', '${enc(verifier)}', '2048', 'pbkdf2-600k-v2')`;
  const seedResult = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--command', seed],
    { encoding: 'utf8' },
  );
  assert.equal(seedResult.status, 0, seedResult.stderr);
  const pkce = randomBytes(32).toString('base64url');
  const authorize = await post(
    authBase,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorize.status, 200, await authorize.clone().text());
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(appBase, '/api/auth/flaxia/exchange', { code, verifier: pkce }, undefined, appBase);
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const linkedCookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(linkedCookie);
  assert.match(linkedCookie, /^session=[A-Za-z0-9_-]{32}$/, 'opt-in linking keeps a local session mapped to the grant');

  const proof = async () => {
    const start = await post(appBase, '/api/auth/reauth/start', {}, linkedCookie, appBase);
    assert.equal(start.status, 200, await start.clone().text());
    const hs = (await start.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: 'pbkdf2-600k-v2' };
    const first = await clientStep1(password, dec(hs.salt));
    const value = await clientStep2(password, dec(hs.salt), first.a, dec(hs.B), hs.srp_kdf);
    return { challenge_id: hs.challenge_id, A: enc(value.A), M1: enc(value.M1) };
  };
  const changed = await fetch(`${appBase}/api/users/me/email`, {
    method: 'PATCH',
    headers: { Origin: appBase, Cookie: linkedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_email: updatedEmail, current_srp: await proof() }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const me = await fetch(`${appBase}/api/me`, { headers: { Cookie: linkedCookie } });
  assert.equal(((await me.json()) as { user: { email: string } }).user.email, updatedEmail);

  const authDir = join(process.cwd(), '.integration/flaxia-auth');
  const authQuery = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'flaxia-auth-prod',
      '--local',
      '--json',
      '--command',
      `SELECT email FROM users WHERE id = '${user.id}'`,
    ],
    { cwd: authDir, encoding: 'utf8' },
  );
  assert.equal(authQuery.status, 0, authQuery.stderr);
  const rows = (JSON.parse(authQuery.stdout) as { results: { email: string | null }[] }[])[0].results;
  assert.equal(rows[0]?.email, updatedEmail, 'Flaxia must update the Auth email authority');
});
