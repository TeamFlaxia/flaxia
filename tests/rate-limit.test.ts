import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, registerUser, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('POST /api/auth/login rate limit', () => {
  beforeEach(resetDb);

  it('21st request within 1 hour → 429', async () => {
    await registerUser({ email: 'a@test.com', password: 'password123', username: 'usera', display_name: 'User A' });

    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@test.com', password: 'password123' }),
      });
      if (res.status === 429) {
        assert.ok(true, 'Rate limited at request ' + (i + 1));
        return;
      }
    }

    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.com', password: 'password123' }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
  });
});

describe('POST /api/auth/register rate limit', () => {
  beforeEach(resetDb);

  it('4th request within 1 hour → 429', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `user${i}@test.com`,
          password: 'password123',
          username: `user${i}`,
          display_name: `User ${i}`,
        }),
      });
      if (res.status === 429) {
        assert.ok(true, 'Rate limited at request ' + (i + 1));
        return;
      }
    }

    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user3@test.com',
        password: 'password123',
        username: 'user3',
        display_name: 'User 3',
      }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
  });
});

describe('POST /api/posts rate limit', () => {
  beforeEach(resetDb);

  it('6th request within 1 minute → 429', async () => {
    const { cookie } = await seedUserAndLogin('1');

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE_URL}/api/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ text: `Post ${i}` }),
      });
      if (res.status === 429) {
        assert.ok(true, 'Rate limited at request ' + (i + 1));
        return;
      }
    }

    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post 5' }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
  });
});

describe('POST /api/posts/:id/fresh rate limit', () => {
  beforeEach(resetDb);

  it('11th request within 1 minute → 429', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      if (res.status === 429) {
        assert.ok(true, 'Rate limited at request ' + (i + 1));
        return;
      }
    }

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
  });
});
