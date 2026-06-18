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
    const body = (await res.json()) as { sessionId?: string };
    assert.ok(body.sessionId, 'response should include sessionId for WebSocket auth');
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

  it('rejects missing email → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123', username: 'usera', display_name: 'User A' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing password → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com', username: 'usera', display_name: 'User A' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing username → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com', password: 'password123', display_name: 'User A' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing display_name → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com', password: 'password123', username: 'usera' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing all fields → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty email → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '', password: 'password123', username: 'usera', display_name: 'User A' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects email without @ symbol → 400', async () => {
    const res = await registerUser({
      email: 'invalid-email',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects email without domain → 400', async () => {
    const res = await registerUser({
      email: 'user@',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects email without TLD → 400', async () => {
    const res = await registerUser({
      email: 'user@domain',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects email with spaces → 400', async () => {
    const res = await registerUser({
      email: 'user @test.com',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects password of length 7 → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: '1234567',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('rejects password of length 129 → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'a'.repeat(129),
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('accepts password of length 128 → 201', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'a'.repeat(128),
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('rejects username longer than 20 chars → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'a'.repeat(21),
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('accepts username of exactly 20 chars → 201', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'a'.repeat(20),
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('rejects empty username → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com', password: 'password123', username: '', display_name: 'User A' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects username with Japanese characters → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'ユーザー名',
      display_name: 'User A',
    });
    assert.equal(res.status, 400);
  });

  it('accepts username with underscores → 201', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'user_name',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('accepts username starting with underscore → 201', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: '_username',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('rejects display_name longer than 50 chars → 400', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'usera',
      display_name: 'a'.repeat(51),
    });
    assert.equal(res.status, 400);
  });

  it('accepts display_name of exactly 50 chars → 201', async () => {
    const res = await registerUser({
      email: 'a@test.com',
      password: 'password123',
      username: 'usera',
      display_name: 'a'.repeat(50),
    });
    assert.equal(res.status, 201);
  });

  it('accepts email with subdomain → 201', async () => {
    const res = await registerUser({
      email: 'user@sub.example.com',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
  });

  it('accepts email with plus addressing → 201', async () => {
    const res = await registerUser({
      email: 'user+tag@example.com',
      password: 'password123',
      username: 'usera',
      display_name: 'User A',
    });
    assert.equal(res.status, 201);
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

  it('rejects missing email → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing password → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty body → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
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

  it('rejects logout with invalid session cookie → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: 'session=invalid-session-token' },
    });
    assert.equal(res.status, 401);
  });
});
