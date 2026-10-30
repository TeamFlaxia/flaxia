import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { clientStep1, clientStep2, computeVerifier, generateSalt, verifyServerProof } from '../../src/lib/srp.ts';
import {
  createVaultEnvelope,
  generateVaultSalt,
  rewrapVaultKeyForPassword,
  unlockVaultWithPassword,
  unlockVaultWithRecovery,
} from '../../src/lib/vault/primitives.ts';

const auth = process.env.FLAXIA_AUTH_TEST_URL;
const app = process.env.FLAXIA_APP_TEST_URL;
const enabled = process.env.FLAXIA_DIRECT_AUTH_TEST === '1' && auth && app;
const enc = (value: Uint8Array) => Buffer.from(value).toString('base64');
const dec = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

test('new Auth identity cannot take over an existing Flaxia profile with the same username', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  assert.ok(auth && app);
  const username = `collision${randomBytes(4).toString('hex')}`;
  const existingId = random();
  const sql = `INSERT INTO users (id, email, username, display_name, password_hash) VALUES ('${existingId}', '${username}@existing.test', '${username}', 'Existing', '')`;
  const seed = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--command', sql],
    { encoding: 'utf8' },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const salt = generateSalt(),
    verifier = await computeVerifier('collision password', salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  const registered = await post(
    auth,
    '/api/auth/register',
    {
      email: `${username}@new.test`,
      username,
      srp_salt: enc(salt),
      srp_verifier: enc(verifier),
      srp_group: '2048',
      srp_kdf: 'pbkdf2-600k-v2',
    },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(registered.status, 201, await registered.clone().text());
  const authCookie = registered.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  const pkce = random();
  const authorize = await post(
    auth,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(app, '/api/auth/flaxia/exchange', { code, verifier: pkce });
  assert.equal(exchange.status, 409, await exchange.clone().text());
  assert.equal(exchange.headers.get('set-cookie'), null);
});

test('new Auth registration creates an identity-bound Flaxia profile without copying credentials', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  assert.ok(auth && app);
  const username = `new${randomBytes(6).toString('hex')}`;
  const email = `${username}@example.test`;
  const salt = generateSalt(),
    verifier = await computeVerifier('new user password', salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  const registration = await post(
    auth,
    '/api/auth/register',
    {
      email,
      username,
      display_name: username,
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
  const pkce = random();
  const authorize = await post(
    auth,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorize.status, 200);
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(app, '/api/auth/flaxia/exchange', { code, verifier: pkce });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const me = await fetch(`${app}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200, await me.clone().text());
  const data = (await me.json()) as { user: { id: string; email: string } };
  assert.equal(data.user.id, user.id);
  assert.equal(data.user.email, email);
  const query = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'flaxia',
      '--local',
      '--json',
      '--command',
      `SELECT password_hash, srp_salt, srp_verifier FROM users WHERE id = '${user.id}'`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(query.status, 0, query.stderr);
  assert.deepEqual((JSON.parse(query.stdout) as { results: unknown[] }[])[0].results[0], {
    password_hash: '',
    srp_salt: null,
    srp_verifier: null,
  });
});

test('direct Auth mode migrates credentials, changes Vault password and deletes both accounts', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  assert.ok(auth && app);
  const username = `dr${randomBytes(6).toString('hex')}`;
  const password = 'direct integration old password';
  const salt = generateSalt(),
    verifier = await computeVerifier(password, salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  const registered = await post(
    auth,
    '/api/auth/register',
    { username, srp_salt: enc(salt), srp_verifier: enc(verifier), srp_group: '2048', srp_kdf: 'pbkdf2-600k-v2' },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(registered.status, 201, await registered.clone().text());
  const { user } = (await registered.json()) as { user: { id: string } };
  const authCookie = registered.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  const seed = `INSERT INTO users (id, email, username, display_name, password_hash, srp_salt, srp_verifier, srp_group, srp_kdf) VALUES ('${user.id}', '${username}@example.test', '${username}', '${username}', '', '${enc(salt)}', '${enc(verifier)}', '2048', 'pbkdf2-600k-v2')`;
  const db = (sql: string) =>
    spawnSync(
      process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--json', '--command', sql],
      { encoding: 'utf8' },
    );
  assert.equal(db(seed).status, 0);
  const pkce = random();
  const authorize = await post(
    auth,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorize.status, 200);
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(app, '/api/auth/flaxia/exchange', { code, verifier: pkce });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  let cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  assert.match(cookie, /^session=[A-Za-z0-9_-]{43}$/);
  const query = db(
    `SELECT password_hash, srp_salt, srp_verifier, (SELECT count(*) FROM sessions WHERE user_id = users.id) AS sessions FROM users WHERE id = '${user.id}'`,
  );
  assert.equal(query.status, 0, query.stderr);
  const result = JSON.parse(query.stdout) as {
    results: { password_hash: string; srp_salt: string | null; srp_verifier: string | null; sessions: number }[];
  }[];
  assert.deepEqual(result[0].results[0], { password_hash: '', srp_salt: null, srp_verifier: null, sessions: 0 });
  const proof = async (passwordValue: string) => {
    const start = await post(app, '/api/auth/reauth/start', {}, cookie);
    assert.equal(start.status, 200, await start.clone().text());
    const hs = (await start.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: 'pbkdf2-600k-v2' };
    const first = await clientStep1(passwordValue, dec(hs.salt));
    const p = await clientStep2(passwordValue, dec(hs.salt), first.a, dec(hs.B), hs.srp_kdf);
    return { challenge_id: hs.challenge_id, A: enc(p.A), M1: enc(p.M1) };
  };
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const vault = await createVaultEnvelope(password, phrase);
  const created = await post(app, '/api/vault/keys', { ...vault.envelope, current_srp: await proof(password) }, cookie);
  assert.equal(created.status, 201, await created.clone().text());
  const nextPassword = 'direct integration new password';
  const nextSalt = generateSalt(),
    nextVerifier = await computeVerifier(nextPassword, nextSalt),
    vaultSalt = generateVaultSalt();
  const wrapped = await rewrapVaultKeyForPassword(vault.vk, nextPassword, vaultSalt, vault.envelope.kdf_params);
  const operation = random();
  const changed = await fetch(`${app}/api/users/me/password`, {
    method: 'PATCH',
    headers: { Origin: app, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation,
      srp_salt: enc(nextSalt),
      srp_verifier: enc(nextVerifier),
      srp_group: '2048',
      srp_kdf: 'pbkdf2-600k-v2',
      current_srp: await proof(password),
      vault_kek: { salt: enc(vaultSalt), wrapped_vk: wrapped, kdf_params: vault.envelope.kdf_params, vk_version: 1 },
    }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const fetched = await fetch(`${app}/api/vault/keys`, { headers: { Cookie: cookie } });
  assert.equal(fetched.status, 200, await fetched.clone().text());
  const envelope = (await fetched.json()) as typeof vault.envelope;
  assert.deepEqual(await unlockVaultWithPassword(nextPassword, envelope), vault.vk);
  assert.deepEqual(await unlockVaultWithRecovery(phrase, envelope), vault.vk);
  await assert.rejects(unlockVaultWithPassword(password, envelope));
  const changedEmail = `${username}@updated.example`;
  const emailChange = await fetch(`${app}/api/users/me/email`, {
    method: 'PATCH',
    headers: { Origin: app, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_email: changedEmail, current_srp: await proof(nextPassword) }),
  });
  assert.equal(emailChange.status, 200, await emailChange.clone().text());
  const current = await fetch(`${app}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(((await current.json()) as { user: { email: string } }).user.email, changedEmail);
  const recoveryCode = random(),
    recoverySalt = generateSalt(),
    recoveryVerifier = await computeVerifier(recoveryCode, recoverySalt);
  const initially = await fetch(`${app}/api/auth/recovery/status`, { headers: { Cookie: cookie } });
  assert.equal(((await initially.json()) as { enrolled: boolean }).enrolled, false);
  const deniedEnrollment = await post(
    app,
    '/api/auth/recovery/enroll',
    {
      salt: enc(recoverySalt),
      verifier: enc(recoveryVerifier),
      kdf: 'pbkdf2-600k-v2',
      current_srp: await proof('wrong password'),
    },
    cookie,
  );
  assert.equal(deniedEnrollment.status, 401, await deniedEnrollment.clone().text());
  assert.equal(
    (
      (await (await fetch(`${app}/api/auth/recovery/status`, { headers: { Cookie: cookie } })).json()) as {
        enrolled: boolean;
      }
    ).enrolled,
    false,
  );
  const enrolled = await post(
    app,
    '/api/auth/recovery/enroll',
    {
      salt: enc(recoverySalt),
      verifier: enc(recoveryVerifier),
      kdf: 'pbkdf2-600k-v2',
      current_srp: await proof(nextPassword),
    },
    cookie,
  );
  assert.equal(enrolled.status, 200, await enrolled.clone().text());
  assert.equal(
    (
      (await (await fetch(`${app}/api/auth/recovery/status`, { headers: { Cookie: cookie } })).json()) as {
        enrolled: boolean;
      }
    ).enrolled,
    true,
  );
  const oldFactorStart = await post(auth, '/api/auth/recovery/start', { username }, undefined, 'https://flaxia.app');
  const oldFactorHs = (await oldFactorStart.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const oldFactorFirst = await clientStep1(recoveryCode, dec(oldFactorHs.salt));
  const oldFactorProof = await clientStep2(
    recoveryCode,
    dec(oldFactorHs.salt),
    oldFactorFirst.a,
    dec(oldFactorHs.B),
    oldFactorHs.srp_kdf,
  );
  const replacementCode = random(),
    replacementSalt = generateSalt(),
    replacementVerifier = await computeVerifier(replacementCode, replacementSalt);
  const replaced = await post(
    app,
    '/api/auth/recovery/enroll',
    {
      salt: enc(replacementSalt),
      verifier: enc(replacementVerifier),
      kdf: 'pbkdf2-600k-v2',
      current_srp: await proof(nextPassword),
    },
    cookie,
  );
  assert.equal(replaced.status, 200, await replaced.clone().text());
  assert.equal(
    (
      await post(
        auth,
        '/api/auth/recovery/verify',
        { challenge_id: oldFactorHs.challenge_id, A: enc(oldFactorProof.A), M1: enc(oldFactorProof.M1) },
        undefined,
        'https://flaxia.app',
      )
    ).status,
    401,
  );
  const badStart = await post(auth, '/api/auth/recovery/start', { username }, undefined, 'https://flaxia.app');
  const badHs = (await badStart.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: 'pbkdf2-600k-v2' };
  const badFirst = await clientStep1('incorrect recovery code', dec(badHs.salt));
  const badProof = await clientStep2(
    'incorrect recovery code',
    dec(badHs.salt),
    badFirst.a,
    dec(badHs.B),
    badHs.srp_kdf,
  );
  assert.equal(
    (
      await post(
        auth,
        '/api/auth/recovery/verify',
        { challenge_id: badHs.challenge_id, A: enc(badProof.A), M1: enc(badProof.M1) },
        undefined,
        'https://flaxia.app',
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await post(
        auth,
        '/api/auth/recovery/verify',
        { challenge_id: badHs.challenge_id, A: enc(badProof.A), M1: enc(badProof.M1) },
        undefined,
        'https://flaxia.app',
      )
    ).status,
    401,
  );
  assert.equal((await post(app, '/api/auth/logout', {}, cookie)).status, 200);
  const concurrentLogin = await post(auth, '/api/auth/login/start', { username }, undefined, 'https://flaxia.app');
  assert.equal(concurrentLogin.status, 200, await concurrentLogin.clone().text());
  const concurrentHs = (await concurrentLogin.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const concurrentFirst = await clientStep1(nextPassword, dec(concurrentHs.salt));
  const concurrentProof = await clientStep2(
    nextPassword,
    dec(concurrentHs.salt),
    concurrentFirst.a,
    dec(concurrentHs.B),
    concurrentHs.srp_kdf,
  );
  const concurrentSession = await post(
    auth,
    '/api/auth/login/verify',
    { challenge_id: concurrentHs.challenge_id, A: enc(concurrentProof.A), M1: enc(concurrentProof.M1) },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(concurrentSession.status, 200, await concurrentSession.clone().text());
  const concurrentCookie = concurrentSession.headers.get('set-cookie')?.split(';')[0];
  assert.ok(concurrentCookie);
  const recoveryStart = await post(auth, '/api/auth/recovery/start', { username }, undefined, 'https://flaxia.app');
  assert.equal(recoveryStart.status, 200, await recoveryStart.clone().text());
  const recoveryHs = (await recoveryStart.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const recoveryFirst = await clientStep1(replacementCode, dec(recoveryHs.salt));
  const recoveryProof = await clientStep2(
    replacementCode,
    dec(recoveryHs.salt),
    recoveryFirst.a,
    dec(recoveryHs.B),
    recoveryHs.srp_kdf,
  );
  const recoveryLogin = await post(
    auth,
    '/api/auth/recovery/verify',
    { challenge_id: recoveryHs.challenge_id, A: enc(recoveryProof.A), M1: enc(recoveryProof.M1) },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(recoveryLogin.status, 200, await recoveryLogin.clone().text());
  const recoveryResult = (await recoveryLogin.json()) as { M2: string };
  assert.equal(
    await verifyServerProof(recoveryProof.A, recoveryProof.M1, recoveryProof.K, dec(recoveryResult.M2)),
    true,
  );
  const recoveryCookie = recoveryLogin.headers.get('set-cookie')?.split(';')[0];
  assert.ok(recoveryCookie);
  assert.equal(
    (await fetch(`${auth}/api/auth/me`, { headers: { Cookie: concurrentCookie } })).status,
    401,
    'successful recovery revokes sessions authenticated by the old password',
  );
  const recoveryPkce = random();
  const recoveryAuthorize = await post(
    auth,
    '/api/auth/flaxia/authorize',
    { challenge: digest(recoveryPkce) },
    recoveryCookie,
    'https://flaxia.app',
  );
  assert.equal(recoveryAuthorize.status, 200);
  const recoveryCodeGrant = ((await recoveryAuthorize.json()) as { code: string }).code;
  const recoveryExchange = await post(app, '/api/auth/flaxia/exchange', {
    code: recoveryCodeGrant,
    verifier: recoveryPkce,
  });
  assert.equal(recoveryExchange.status, 200, await recoveryExchange.clone().text());
  cookie = recoveryExchange.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  const recoveryReauth = await post(app, '/api/auth/recovery/reauth/start', {}, cookie);
  assert.equal(recoveryReauth.status, 200, await recoveryReauth.clone().text());
  const resetHs = (await recoveryReauth.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const resetFirst = await clientStep1(replacementCode, dec(resetHs.salt));
  const resetProof = await clientStep2(
    replacementCode,
    dec(resetHs.salt),
    resetFirst.a,
    dec(resetHs.B),
    resetHs.srp_kdf,
  );
  const finalPassword = 'recovered integration password',
    finalSalt = generateSalt(),
    finalVerifier = await computeVerifier(finalPassword, finalSalt),
    finalVaultSalt = generateVaultSalt();
  const finalWrapped = await rewrapVaultKeyForPassword(
    await unlockVaultWithRecovery(phrase, envelope),
    finalPassword,
    finalVaultSalt,
    vault.envelope.kdf_params,
  );
  const reset = await fetch(`${app}/api/users/me/password`, {
    method: 'PATCH',
    headers: { Origin: app, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: random(),
      recovery: true,
      srp_salt: enc(finalSalt),
      srp_verifier: enc(finalVerifier),
      srp_group: '2048',
      srp_kdf: 'pbkdf2-600k-v2',
      current_srp: { challenge_id: resetHs.challenge_id, A: enc(resetProof.A), M1: enc(resetProof.M1) },
      vault_kek: {
        salt: enc(finalVaultSalt),
        wrapped_vk: finalWrapped,
        kdf_params: vault.envelope.kdf_params,
        vk_version: 1,
      },
    }),
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  const recoveredVault = (await (
    await fetch(`${app}/api/vault/keys`, { headers: { Cookie: cookie } })
  ).json()) as typeof vault.envelope;
  assert.deepEqual(await unlockVaultWithPassword(finalPassword, recoveredVault), vault.vk);
  const mediaOwner = random(),
    sharedAvatar = `avatar/${random()}`,
    privateHeader = `header/${random()}`;
  const mediaSeed = db(
    `INSERT INTO users (id, email, username, display_name, password_hash, avatar_key) VALUES ('${mediaOwner}', '${username}@media.test', '${username}m', 'Media', '', '${sharedAvatar}'); UPDATE users SET avatar_key = '${sharedAvatar}', header_key = '${privateHeader}' WHERE id = '${user.id}'`,
  );
  assert.equal(mediaSeed.status, 0, mediaSeed.stderr);
  const wrongDeletion = await fetch(`${app}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: app, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: random(), current_srp: await proof('wrong password') }),
  });
  assert.equal(wrongDeletion.status, 401, await wrongDeletion.clone().text());
  assert.equal(((await wrongDeletion.json()) as { cancelled?: boolean }).cancelled, true);
  const deletion = random();
  const removed = await fetch(`${app}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: app, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: deletion, current_srp: await proof(finalPassword) }),
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await post(app, '/api/users/me/deletion/retry', { operation: deletion })).status, 200);
  assert.equal((await fetch(`${app}/api/me`, { headers: { Cookie: cookie } })).status, 401);
  const deletedStart = await post(auth, '/api/auth/recovery/start', { username }, undefined, 'https://flaxia.app');
  assert.equal(deletedStart.status, 200);
  const deletedHs = (await deletedStart.json()) as {
    challenge_id: string;
    salt: string;
    B: string;
    srp_kdf: 'pbkdf2-600k-v2';
  };
  const deletedFirst = await clientStep1(replacementCode, dec(deletedHs.salt));
  const deletedProof = await clientStep2(
    replacementCode,
    dec(deletedHs.salt),
    deletedFirst.a,
    dec(deletedHs.B),
    deletedHs.srp_kdf,
  );
  assert.equal(
    (
      await post(
        auth,
        '/api/auth/recovery/verify',
        { challenge_id: deletedHs.challenge_id, A: enc(deletedProof.A), M1: enc(deletedProof.M1) },
        undefined,
        'https://flaxia.app',
      )
    ).status,
    401,
  );
  const remaining = db(`SELECT count(*) AS count FROM users WHERE id = '${user.id}'`);
  assert.equal((JSON.parse(remaining.stdout) as { results: { count: number }[] }[])[0].results[0].count, 0);
  const mediaOutbox = db(
    `SELECT object_key FROM profile_media_deletion_outbox WHERE object_key IN ('${sharedAvatar}', '${privateHeader}')`,
  );
  assert.deepEqual((JSON.parse(mediaOutbox.stdout) as { results: { object_key: string }[] }[])[0].results, [
    { object_key: privateHeader },
  ]);
});

test('admin can delete a linked Auth user', { skip: !enabled, timeout: 60000 }, async () => {
  assert.ok(auth && app);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  async function createLinkedUser() {
    const username = `ad${randomBytes(6).toString('hex')}`;
    const salt = generateSalt();
    const verifier = await computeVerifier('admin deletion integration password', salt);
    const registration = await post(
      auth!,
      '/api/auth/register',
      {
        username,
        email: `${username}@example.test`,
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
    const pkce = random();
    const authorization = await post(
      auth!,
      '/api/auth/flaxia/authorize',
      { challenge: digest(pkce) },
      authCookie,
      'https://flaxia.app',
    );
    assert.equal(authorization.status, 200, await authorization.clone().text());
    const { code } = (await authorization.json()) as { code: string };
    const exchange = await post(app!, '/api/auth/flaxia/exchange', { code, verifier: pkce });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return { id: user.id, cookie, authCookie, username };
  }
  const admin = await createLinkedUser();
  const target = await createLinkedUser();
  const update = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'flaxia',
      '--local',
      '--command',
      `UPDATE users SET role = 'admin' WHERE id = '${admin.id}'`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(update.status, 0, update.stderr);
  const deletion = await fetch(`${app}/api/admin/users/${target.id}`, {
    method: 'DELETE',
    headers: { Origin: app!, Cookie: admin.cookie },
  });
  assert.equal(deletion.status, 200, await deletion.clone().text());
  const targetMe = await fetch(`${app}/api/me`, { headers: { Cookie: target.cookie } });
  assert.equal(targetMe.status, 401);
  const authMe = await fetch(`${auth}/api/auth/me`, { headers: { Cookie: target.authCookie } });
  assert.equal(authMe.status, 401, 'Deleting a linked user must revoke the Auth session');
  const login = await post(
    auth!,
    '/api/auth/login/start',
    { username: target.username },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(login.status, 401, 'Deleting a linked user must delete the Auth account');
});

test('authorization started before a freeze cannot create a session after unfreeze', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  assert.ok(auth && app);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  async function createLinkedUser() {
    const username = `ad${randomBytes(6).toString('hex')}`;
    const salt = generateSalt();
    const verifier = await computeVerifier('admin deletion integration password', salt);
    const registration = await post(
      auth!,
      '/api/auth/register',
      {
        username,
        email: `${username}@example.test`,
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
    const pkce = random();
    const authorization = await post(
      auth!,
      '/api/auth/flaxia/authorize',
      { challenge: digest(pkce) },
      authCookie,
      'https://flaxia.app',
    );
    assert.equal(authorization.status, 200, await authorization.clone().text());
    const { code } = (await authorization.json()) as { code: string };
    const exchange = await post(app!, '/api/auth/flaxia/exchange', { code, verifier: pkce });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return { id: user.id, cookie, authCookie, username };
  }
  const admin = await createLinkedUser();
  const target = await createLinkedUser();
  const update = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'flaxia',
      '--local',
      '--command',
      `UPDATE users SET role = 'admin' WHERE id = '${admin.id}'`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(update.status, 0, update.stderr);
  const verifier = random();
  const authorization = await post(
    auth!,
    '/api/auth/flaxia/authorize',
    { challenge: digest(verifier) },
    target.authCookie,
    'https://flaxia.app',
  );
  assert.equal(authorization.status, 200, await authorization.clone().text());
  const { code } = (await authorization.json()) as { code: string };

  const freeze = await post(app!, `/api/admin/users/${target.id}/freeze`, { reason: 'test freeze' }, admin.cookie);
  assert.equal(freeze.status, 200, await freeze.clone().text());
  const authMe = await fetch(`${auth}/api/auth/me`, { headers: { Cookie: target.authCookie } });
  assert.equal(authMe.status, 401, 'Freeze must revoke the Auth session');
  const loginStart = await post(
    auth!,
    '/api/auth/login/start',
    { username: target.username },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(loginStart.status, 200, await loginStart.clone().text());
  const hs = (await loginStart.json()) as { challenge_id: string; salt: string; B: string; srp_kdf: string };
  const password = 'admin deletion integration password';
  const client = await clientStep1(password, dec(hs.salt));
  const proof = await clientStep2(password, dec(hs.salt), client.a, dec(hs.B), hs.srp_kdf);
  const frozenLogin = await post(
    auth!,
    '/api/auth/login/verify',
    { challenge_id: hs.challenge_id, A: enc(proof.A), M1: enc(proof.M1) },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(frozenLogin.status, 403, 'Frozen Auth account must reject a valid login');
  assert.equal(frozenLogin.headers.get('set-cookie'), null);
  const unfreeze = await post(app!, `/api/admin/users/${target.id}/unfreeze`, {}, admin.cookie);
  assert.equal(unfreeze.status, 200, await unfreeze.clone().text());

  const exchange = await post(app!, '/api/auth/flaxia/exchange', { code, verifier });
  assert.notEqual(exchange.status, 200, 'A pre-freeze authorization must not issue a post-unfreeze session');
  assert.equal(exchange.headers.get('set-cookie'), null);
});

test('new Auth identity cannot take over an existing Flaxia profile with the same email', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  assert.ok(auth && app);
  const username = `mail${randomBytes(4).toString('hex')}`;
  const email = `${username}@existing.test`;
  const existingId = random();
  const sql = `INSERT INTO users (id, email, username, display_name, password_hash) VALUES ('${existingId}', '${email}', '${username}old', 'Existing', '')`;
  const seed = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flaxia', '--local', '--command', sql],
    { encoding: 'utf8' },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const salt = generateSalt(),
    verifier = await computeVerifier('email collision password', salt);
  const post = (base: string, path: string, body: unknown, cookie?: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  const registered = await post(
    auth,
    '/api/auth/register',
    {
      email: email.toUpperCase(),
      username,
      srp_salt: enc(salt),
      srp_verifier: enc(verifier),
      srp_group: '2048',
      srp_kdf: 'pbkdf2-600k-v2',
    },
    undefined,
    'https://flaxia.app',
  );
  assert.equal(registered.status, 201, await registered.clone().text());
  const authCookie = registered.headers.get('set-cookie')?.split(';')[0];
  assert.ok(authCookie);
  const pkce = random();
  const authorize = await post(
    auth,
    '/api/auth/flaxia/authorize',
    { challenge: digest(pkce) },
    authCookie,
    'https://flaxia.app',
  );
  const { code } = (await authorize.json()) as { code: string };
  const exchange = await post(app, '/api/auth/flaxia/exchange', { code, verifier: pkce });
  assert.equal(exchange.status, 409, await exchange.clone().text());
  assert.equal(exchange.headers.get('set-cookie'), null);
});
