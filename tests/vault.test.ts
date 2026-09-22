// Vault key storage API (docs/e2ee.md).
//
// The invariant under test: the server stores wrapped blobs, and no password
// change can strand one. Every path that would leave `wrapped_vk` derived from
// a password the user no longer has must fail before it writes.
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  createVaultEnvelope,
  DEFAULT_VAULT_KDF_PARAMS,
  encodeB64,
  generateVaultSalt,
  rewrapVaultKeyForPassword,
  unlockVaultWithPassword,
} from '../src/lib/vault/primitives.ts';
import { BASE_URL, createSrpProof, loginUser, resetDb, seedUserAndLogin, srpVerifierPayload } from './helpers/setup.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'password123';
const NEW_PASSWORD = 'brandnewpass1';

function headers(cookie: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Cookie: cookie };
}

function getKeys(cookie: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/vault/keys`, { headers: headers(cookie) });
}

async function enableVault(
  cookie: string,
  password: string,
): Promise<{ res: Response; vk: Uint8Array; envelope: Awaited<ReturnType<typeof createVaultEnvelope>>['envelope'] }> {
  const { envelope, vk } = await createVaultEnvelope(password, PHRASE);
  const proof = await createSrpProof(cookie, password);
  assert.ok(proof, 'should be able to prove the current password');
  const res = await fetch(`${BASE_URL}/api/vault/keys`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({ current_srp: proof, ...envelope }),
  });
  return { res, vk, envelope };
}

async function changePassword(
  cookie: string,
  proofPassword: string,
  newPassword: string,
  vaultFields?: { salt: string; kdf_params: unknown; wrapped_vk: string },
): Promise<Response> {
  const proof = await createSrpProof(cookie, proofPassword);
  assert.ok(proof, 'should be able to prove the current password');
  return fetch(`${BASE_URL}/api/users/me/password`, {
    method: 'PATCH',
    headers: headers(cookie),
    body: JSON.stringify({
      ...(await srpVerifierPayload(newPassword)),
      current_srp: proof,
      ...(vaultFields ? { vault_kek: vaultFields } : {}),
    }),
  });
}

describe('GET /api/vault/keys', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated requests → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/vault/keys`);
    assert.equal(res.status, 401);
  });

  it('reports enabled: false before the vault exists → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await getKeys(cookie);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { enabled: boolean };
    assert.equal(data.enabled, false);
  });
});

describe('POST /api/vault/keys', () => {
  beforeEach(resetDb);

  it('rejects an envelope without a password proof → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
    const res = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify(envelope),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a wrong-password proof → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
    const proof = await createSrpProof(cookie, 'wrongpassword');
    assert.ok(proof);
    const res = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({ current_srp: proof, ...envelope }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects malformed key material → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
    const proof = await createSrpProof(cookie, PASSWORD);
    const res = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({ current_srp: proof, ...envelope, wrapped_vk: 'not-a-wrapped-key' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a cheap KDF → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
    const proof = await createSrpProof(cookie, PASSWORD);
    const res = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({
        current_srp: proof,
        ...envelope,
        kdf_params: { alg: 'PBKDF2-SHA256', iterations: 1000 },
      }),
    });
    assert.equal(res.status, 400);
  });

  it('stores an envelope and returns it on read → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);

    const created = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({ current_srp: await createSrpProof(cookie, PASSWORD), ...envelope }),
    });
    assert.equal(created.status, 201);

    const read = (await (await getKeys(cookie)).json()) as {
      enabled: boolean;
      salt: string;
      recovery_salt: string;
      kdf_params: unknown;
      wrapped_vk: string;
      recovery_blob: string;
      vk_version: number;
    };
    assert.equal(read.enabled, true);
    assert.equal(read.salt, envelope.salt);
    assert.equal(read.recovery_blob, envelope.recovery_blob);
    assert.equal(read.vk_version, 1);

    // The bytes round-trip unchanged, so the client can still open its own vault.
    const reopened = await unlockVaultWithPassword(PASSWORD, read as never);
    assert.deepEqual(reopened, vk);
  });

  it('refuses to overwrite an existing vault → 409', async () => {
    const { cookie } = await seedUserAndLogin('1');
    assert.equal((await enableVault(cookie, PASSWORD)).res.status, 201);
    const second = await enableVault(cookie, PASSWORD);
    assert.equal(second.res.status, 409);
  });
});

describe('PUT /api/vault/keys — envelope rotation', () => {
  beforeEach(resetDb);

  it('bumps vk_version and refuses a stale client → 409', async () => {
    const { cookie } = await seedUserAndLogin('1');
    assert.equal((await enableVault(cookie, PASSWORD)).res.status, 201);

    const fresh = await createVaultEnvelope(PASSWORD, PHRASE);
    const proof = await createSrpProof(cookie, PASSWORD);
    const stale = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'PUT',
      headers: headers(cookie),
      body: JSON.stringify({
        current_srp: proof,
        ...fresh.envelope,
        vk_version: 99,
      }),
    });
    assert.equal(stale.status, 409);

    const current = (await (await getKeys(cookie)).json()) as { vk_version: number };
    const updated = await fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'PUT',
      headers: headers(cookie),
      body: JSON.stringify({
        current_srp: await createSrpProof(cookie, PASSWORD),
        ...fresh.envelope,
        vk_version: current.vk_version,
      }),
    });
    assert.equal(updated.status, 200);

    const after = (await (await getKeys(cookie)).json()) as { vk_version: number };
    assert.equal(after.vk_version, current.vk_version + 1);
  });
});

describe('password change with a vault', () => {
  beforeEach(resetDb);

  it('refuses to change the password without re-wrapping the vault → 409', async () => {
    // Otherwise the stored wrapped_vk would keep expecting the old password.
    const { cookie } = await seedUserAndLogin('1');
    assert.equal((await enableVault(cookie, PASSWORD)).res.status, 201);

    const res = await changePassword(cookie, PASSWORD, NEW_PASSWORD);
    assert.equal(res.status, 409);
    const data = (await res.json()) as { error?: string };
    assert.equal(data.error, 'vault_rewrap_required');

    // Nothing was written: the old password still unlocks both login and vault.
    const login = await loginUser('user1@test.com', PASSWORD);
    assert.equal(login.res.status, 200);
    const keys = (await (await getKeys(cookie)).json()) as {
      salt: string;
      kdf_params: Parameters<typeof unlockVaultWithPassword>[1]['kdf_params'];
      wrapped_vk: string;
    };
    assert.ok(await unlockVaultWithPassword(PASSWORD, keys), 'old password must still open the vault');
  });

  it('rejects a malformed re-wrap → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    assert.equal((await enableVault(cookie, PASSWORD)).res.status, 201);
    const res = await changePassword(cookie, PASSWORD, NEW_PASSWORD, {
      salt: encodeB64(generateVaultSalt()),
      kdf_params: { alg: 'PBKDF2-SHA256', iterations: 1000 },
      wrapped_vk: 'bogus',
    });
    assert.equal(res.status, 400);
  });

  it('rejects re-wrapping a vault that does not exist → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const salt = encodeB64(generateVaultSalt());
    const res = await changePassword(cookie, PASSWORD, NEW_PASSWORD, {
      salt,
      kdf_params: DEFAULT_VAULT_KDF_PARAMS,
      wrapped_vk: `${salt}.${salt}`,
    });
    assert.equal(res.status, 400);
  });

  it('swaps login and vault keys together → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const enabled = await enableVault(cookie, PASSWORD);
    assert.equal(enabled.res.status, 201);
    const before = (await (await getKeys(cookie)).json()) as { wrapped_vk: string };

    // The client holds both passwords during the change, so it re-wraps here.
    const salt = generateVaultSalt();
    const wrapped = await rewrapVaultKeyForPassword(enabled.vk, NEW_PASSWORD, salt, DEFAULT_VAULT_KDF_PARAMS);
    const res = await changePassword(cookie, PASSWORD, NEW_PASSWORD, {
      salt: encodeB64(salt),
      kdf_params: DEFAULT_VAULT_KDF_PARAMS,
      wrapped_vk: wrapped,
    });
    assert.equal(res.status, 200);

    const after = (await (await getKeys(cookie)).json()) as {
      salt: string;
      kdf_params: Parameters<typeof unlockVaultWithPassword>[1]['kdf_params'];
      wrapped_vk: string;
    };
    assert.notEqual(after.wrapped_vk, before.wrapped_vk);
    assert.deepEqual(
      await unlockVaultWithPassword(NEW_PASSWORD, after),
      enabled.vk,
      'the vault must open with the new password',
    );
    await assert.rejects(unlockVaultWithPassword(PASSWORD, after), 'the old password must stop opening it');

    const oldLogin = await loginUser('user1@test.com', PASSWORD);
    assert.equal(oldLogin.res.status, 401, 'old password must stop working');
    const newLogin = await loginUser('user1@test.com', NEW_PASSWORD);
    assert.equal(newLogin.res.status, 200, 'new password must work');
  });
});
