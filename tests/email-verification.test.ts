import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, registerUnverifiedUser, resetDb, srpLogin, takeVerificationToken } from './helpers/setup.ts';

async function verifyToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/email/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function resend(email: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/verification/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

describe('email verification', () => {
  beforeEach(resetDb);

  it('requires a single-use email link before SRP login creates a session', async () => {
    const registration = await registerUnverifiedUser({
      email: 'New.User@Example.com',
      password: 'correct horse battery staple',
      username: 'newuser',
      display_name: 'New User',
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.headers.get('set-cookie'), null);

    const unverifiedLogin = await srpLogin('new.user@example.com', 'correct horse battery staple');
    assert.equal(unverifiedLogin.res.status, 403);
    assert.equal(unverifiedLogin.cookie, '');

    const token = await takeVerificationToken('new.user@example.com');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const results = await Promise.all([verifyToken(token), verifyToken(token)]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 400]);

    const login = await srpLogin('new.user@example.com', 'correct horse battery staple');
    assert.equal(login.res.status, 200);
    assert.equal(login.verified, true);
    assert.ok(login.cookie.includes('session='));
    const me = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: login.cookie } });
    assert.equal(me.status, 200);
  });

  it('also blocks the deprecated password login for an unverified legacy-shaped account', async () => {
    const seeded = await fetch(`${BASE_URL}/api/test/seed-legacy-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unverified-legacy@example.com',
        password: 'legacy-password-123',
        username: 'legacyunverified',
        unverified: true,
      }),
    });
    assert.equal(seeded.status, 201);

    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unverified-legacy@example.com', password: 'legacy-password-123' }),
    });
    assert.equal(login.status, 403);
    assert.equal(login.headers.get('set-cookie'), null);
    assert.equal(((await login.json()) as { error: string }).error, 'email_verification_required');
  });

  it('expires old links, permits resend without account enumeration, and accepts the replacement', async () => {
    const email = 'expired@example.com';
    const registration = await registerUnverifiedUser({
      email,
      password: 'correct horse battery staple',
      username: 'expireduser',
      display_name: 'Expired User',
    });
    assert.equal(registration.status, 201);
    const oldToken = await takeVerificationToken(email);
    assert.equal((await resend(email)).status, 202);
    const replacedToken = await takeVerificationToken(email);
    assert.equal((await verifyToken(oldToken)).status, 400);

    const expire = await fetch(`${BASE_URL}/api/test/expire-email-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(expire.status, 200);
    assert.equal((await verifyToken(replacedToken)).status, 400);

    const unknown = await resend('unknown@example.com');
    const pending = await resend(email);
    assert.equal(unknown.status, 202);
    assert.equal(pending.status, 202);
    assert.deepEqual(await unknown.json(), await pending.json());

    const replacement = await takeVerificationToken(email);
    assert.equal((await verifyToken(replacement)).status, 200);
    assert.equal((await verifyToken(replacement)).status, 400);
  });
});
