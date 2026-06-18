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

  it('rejects empty username → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/users/`);
    assert.equal(res.status, 404);
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

  it('accepts display_name of exactly 50 chars → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ display_name: 'a'.repeat(50) }),
    });
    assert.equal(res.status, 200);
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

  it('accepts bio of exactly 200 chars → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ bio: 'a'.repeat(200) }),
    });
    assert.equal(res.status, 200);
  });

  it('updates language to "en" → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ language: 'en' }),
    });
    assert.equal(res.status, 200);
  });

  it('updates language to "ja" → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ language: 'ja' }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects invalid language code → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ language: 'fr' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects language as empty string → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ language: '' }),
    });
    assert.equal(res.status, 400);
  });

  it('updates ng_words successfully → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: ['badword1', 'badword2'] }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects ng_words that is not an array → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: 'not-an-array' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects ng_words with non-string items → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: ['valid', 123] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects ng_words with items longer than 50 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: ['a'.repeat(51)] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects ng_words array with more than 100 items → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: Array.from({ length: 101 }, (_, i) => `word${i}`) }),
    });
    assert.equal(res.status, 400);
  });

  it('accepts ng_words with exactly 100 items → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ ng_words: Array.from({ length: 100 }, (_, i) => `word${i}`) }),
    });
    assert.equal(res.status, 200);
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

describe('PATCH /api/users/me/email — validation', () => {
  beforeEach(resetDb);

  it('rejects missing current_password → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing new_email → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'password123' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid email format → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'password123', new_email: 'invalid-email' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects wrong current password → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'wrongpassword', new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'password123', new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('PATCH /api/users/me/password — validation', () => {
  beforeEach(resetDb);

  it('rejects missing current_password → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ new_password: 'newpassword123' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing new_password → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'password123' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects new password shorter than 8 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'password123', new_password: 'short' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects new password of length 129 → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'password123', new_password: 'a'.repeat(129) }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects wrong current password → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ current_password: 'wrongpassword', new_password: 'newpassword123' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'password123', new_password: 'newpassword123' }),
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

  it('rejects unauthenticated delete → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 401);
  });
});
