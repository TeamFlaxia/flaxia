import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, createSrpProof, registerUser, resetDb, srpLogin } from './helpers/setup.ts';

// Emails are case-insensitive identifiers. Before this suite, registration and
// email change compared them with SQLite's default BINARY collation, so
// `DevTest@flaxia.app` could coexist with `devtest@flaxia.app` and inherit the
// old email-keyed reviewer entitlement.
describe('email normalization', () => {
  beforeEach(resetDb);

  it('stores registration emails trimmed and lowercased', async () => {
    const res = await registerUser({
      email: '  MixedCase@Example.COM  ',
      password: 'password123',
      username: 'userfirst',
      display_name: 'First User',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: { email: string } };
    assert.equal(body.user.email, 'mixedcase@example.com');

    const me = await fetch(`${BASE_URL}/api/me`, {
      headers: { Cookie: res.headers.get('set-cookie') ?? '' },
    });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { user: { email: string } };
    assert.equal(meBody.user.email, 'mixedcase@example.com');
  });

  it('logs in with a different case for the same address', async () => {
    await registerUser({
      email: 'mixedcase@example.com',
      password: 'password123',
      username: 'userfirst',
      display_name: 'First User',
    });

    const { res, verified } = await srpLogin('MIXEDCASE@EXAMPLE.COM', 'password123');
    assert.equal(res.status, 200);
    assert.equal(verified, true, 'server proof should verify');
  });

  it('rejects a case-variant duplicate at registration → 409', async () => {
    await registerUser({
      email: 'taken@example.com',
      password: 'password123',
      username: 'userfirst',
      display_name: 'First User',
    });
    const res = await registerUser({
      email: 'TAKEN@EXAMPLE.COM',
      password: 'password123',
      username: 'usersecond',
      display_name: 'Second User',
    });
    assert.equal(res.status, 409);
  });

  it('rejects an email change that is a case variant of another account → 409', async () => {
    const first = await registerUser({
      email: 'first@example.com',
      password: 'password123',
      username: 'userfirst',
      display_name: 'First User',
    });
    assert.equal(first.status, 201);
    const cookie = first.headers.get('set-cookie') ?? '';

    await registerUser({
      email: 'taken@example.com',
      password: 'password123',
      username: 'usersecond',
      display_name: 'Second User',
    });

    const proof = await createSrpProof(cookie, 'password123');
    assert.ok(proof, 'reauth proof should be issued');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof, new_email: 'TAKEN@EXAMPLE.COM' }),
    });
    assert.equal(res.status, 409);
  });

  it('stores a changed email trimmed and lowercased', async () => {
    const first = await registerUser({
      email: 'first@example.com',
      password: 'password123',
      username: 'userfirst',
      display_name: 'First User',
    });
    assert.equal(first.status, 201);
    const cookie = first.headers.get('set-cookie') ?? '';

    const proof = await createSrpProof(cookie, 'password123');
    assert.ok(proof, 'reauth proof should be issued');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof, new_email: '  New.Address@Example.COM  ' }),
    });
    assert.equal(res.status, 200);

    const me = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
    const meBody = (await me.json()) as { user: { email: string } };
    assert.equal(meBody.user.email, 'new.address@example.com');
  });
});
