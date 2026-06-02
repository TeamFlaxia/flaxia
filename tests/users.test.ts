import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, loginUser, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('GET /api/users/:username', () => {
  beforeEach(resetDb);

  it('returns user profile → 200', async () => {
    await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/testuser1`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.username, 'testuser1');
  });

  it('returns unknown user → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/users/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('accessible to guests', async () => {
    await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/testuser1`);
    assert.equal(res.status, 200);
  });
});

describe('PATCH /api/users/me', () => {
  beforeEach(resetDb);

  it('updates display_name successfully', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ display_name: 'New Name' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.display_name, 'New Name');
  });

  it('updates bio successfully', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ bio: 'My bio' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.bio, 'My bio');
  });

  it('rejects display_name > 50 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const longName = 'a'.repeat(51);
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ display_name: longName }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects bio > 200 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const longBio = 'a'.repeat(201);
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ bio: longBio }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'New Name' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('DELETE /api/users/me', () => {
  beforeEach(resetDb);

  it('deletes account → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it('login fails after deletion → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });

    const { res } = await loginUser('user1@test.com', 'password123');
    assert.equal(res.status, 401);
  });

  it('posts still exist after account deletion', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'My post' }),
    });
    const createData = await createRes.json();

    await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });

    const postsRes = await fetch(`${BASE_URL}/api/posts`);
    const postsData = await postsRes.json();
    const myPost = postsData.posts.find((p: any) => p.id === createData.id);
    assert.ok(myPost);
  });
});
