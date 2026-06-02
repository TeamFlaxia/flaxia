import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, loginUser, registerUser, resetDb } from './helpers/setup.ts';

describe('POST /api/auth/register', () => {
  beforeEach(resetDb);

  it('registers successfully', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('rejects duplicate email → 409', async () => {
    await registerUser({ email: 'a@test.com', password: 'password123', username: 'usera', display_name: 'User A' });
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'userb',
      display_name: 'User B',
    });
    assert.equal(res.status, 409);
  });

  it('rejects duplicate username (case-insensitive) → 409', async () => {
    await registerUser({ email: 'a@test.com', password: 'password123', username: 'usera', display_name: 'User A' });
    const res = await registerUser({
      email: 'b@test.com',
      password: 'password123',
      username: 'UserA',
      display_name: 'User B',
    });
    assert.equal(res.status, 409);
  });

  it('rejects password shorter than 8 chars → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'short',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid username characters → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'user a!',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await resetDb();
    await registerUser({ email: 'a@test.com', password: 'password123', username: 'usera', display_name: 'User A' });
  });

  it('logs in successfully and returns session cookie', async () => {
    const { res, cookie } = await loginUser('a@test.com', 'password123');
    assert.equal(res.status, 200);
    assert.ok(cookie.length > 0);
  });

  it('rejects unknown email → 401', async () => {
    const { res } = await loginUser('nobody@test.com', 'password123');
    assert.equal(res.status, 401);
  });

  it('rejects wrong password → 401', async () => {
    const { res } = await loginUser('a@test.com', 'wrongpass');
    assert.equal(res.status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  beforeEach(async () => {
    await resetDb();
    await registerUser({ email: 'a@test.com', password: 'password123', username: 'usera', display_name: 'User A' });
  });

  it('logs out successfully', async () => {
    const { cookie } = await loginUser('a@test.com', 'password123');
    const res = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it('rejects unauthenticated logout → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});
