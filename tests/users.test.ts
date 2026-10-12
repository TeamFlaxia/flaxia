import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  BASE_URL,
  createSrpProof,
  loginUser,
  resetDb,
  seedUserAndLogin,
  srpVerifierPayload,
  takeVerificationToken,
  verifyEmailAddress,
} from './helpers/setup.ts';

describe('GET /api/users/:username', () => {
  beforeEach(resetDb);

  it('returns user profile → 200', async () => {
    await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/testuser1`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.username, 'testuser1');
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
    assert.equal(data.user.display_name, 'New Name');
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
    assert.equal(data.user.bio, 'My bio');
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

  it('rejects missing current-password proof → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing new_email → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid email format → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      // Shape-valid proof: format validation happens before it is verified.
      body: JSON.stringify({
        current_srp: { challenge_id: 'unused', A: 'unused', M1: 'unused' },
        new_email: 'invalid-email',
      }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a proof from the wrong password → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'wrongpassword');
    assert.ok(proof, 'proof should be produced for the wrong password');
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof, new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects an unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_srp: { challenge_id: 'x', A: 'y', M1: 'z' }, new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects an email address already reserved by another pending change', async () => {
    const first = await seedUserAndLogin('1');
    const firstProof = await createSrpProof(first.cookie, 'password123');
    const firstRequest = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ current_srp: firstProof, new_email: 'reserved@test.com' }),
    });
    assert.equal(firstRequest.status, 200);

    const second = await seedUserAndLogin('2');
    const secondProof = await createSrpProof(second.cookie, 'password123');
    const secondRequest = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ current_srp: secondProof, new_email: 'RESERVED@test.com' }),
    });
    assert.equal(secondRequest.status, 409);
  });

  it('invalidates a previous pending email-change link when a new request is made', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const firstProof = await createSrpProof(cookie, 'password123');
    const firstRequest = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: firstProof, new_email: 'first-pending@test.com' }),
    });
    assert.equal(firstRequest.status, 200);
    const firstToken = await takeVerificationToken('first-pending@test.com');

    const secondProof = await createSrpProof(cookie, 'password123');
    const secondRequest = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: secondProof, new_email: 'second-pending@test.com' }),
    });
    assert.equal(secondRequest.status, 200);
    const secondToken = await takeVerificationToken('second-pending@test.com');

    const stale = await fetch(`${BASE_URL}/api/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: firstToken }),
    });
    assert.equal(stale.status, 400);
    const latest = await fetch(`${BASE_URL}/api/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secondToken }),
    });
    assert.equal(latest.status, 200);
  });

  it('changes email only after the new address verifies', async () => {
    // SRP-only accounts have no password_hash, so this path is the only way
    // they can ever change email.
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    assert.ok(proof);
    const res = await fetch(`${BASE_URL}/api/users/me/email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof, new_email: 'new@test.com' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await loginUser('user1@test.com', 'password123')).res.status, 200);
    assert.equal((await loginUser('new@test.com', 'password123')).res.status, 401);
    const pendingMe = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(((await pendingMe.json()) as { user: { email: string } }).user.email, 'user1@test.com');

    const verified = await verifyEmailAddress('new@test.com');
    assert.equal(verified.status, 200);
    const updatedMe = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(((await updatedMe.json()) as { user: { email: string } }).user.email, 'new@test.com');
    assert.equal((await loginUser('user1@test.com', 'password123')).res.status, 401);
    assert.equal((await loginUser('new@test.com', 'password123')).res.status, 200);
  });
});

describe('PATCH /api/users/me/password — validation', () => {
  beforeEach(resetDb);

  it('rejects a request without a new verifier → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a request without a current-password proof → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const verifier = await srpVerifierPayload('newpassword123');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(verifier),
    });
    assert.equal(res.status, 400);
  });

  it('rejects the plaintext current_password/new_password shape → 400', async () => {
    // Both halves of the old request are gone: neither value may reach the
    // server in cleartext any more.
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_password: 'password123', new_password: 'newpassword123' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects an unsupported srp_kdf → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    const verifier = await srpVerifierPayload('newpassword123');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...verifier, srp_kdf: 'pbkdf2-1-v2', current_srp: proof }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a proof from the wrong password → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'wrongpassword');
    assert.ok(proof);
    const verifier = await srpVerifierPayload('newpassword123');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...verifier, current_srp: proof }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects an unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srp_salt: 'x',
        srp_verifier: 'y',
        srp_group: '2048',
        srp_kdf: 'pbkdf2-600k-v2',
        current_srp: { challenge_id: 'a', A: 'b', M1: 'c' },
      }),
    });
    assert.equal(res.status, 401);
  });

  it('changes password without sending either password, then both work → 200', async () => {
    const { cookie, email } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    assert.ok(proof);
    const verifier = await srpVerifierPayload('brandnewpass1');
    const res = await fetch(`${BASE_URL}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...verifier, current_srp: proof }),
    });
    assert.equal(res.status, 200);

    const wrong = await loginUser(email, 'password123');
    assert.equal(wrong.res.status, 401, 'old password must stop working');

    const right = await loginUser(email, 'brandnewpass1');
    assert.equal(right.res.status, 200, 'new password must work');
  });
});

describe('DELETE /api/users/me', () => {
  beforeEach(resetDb);

  it('rejects missing password proof → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a proof from the wrong password → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'wrongpassword');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof }),
    });
    assert.equal(res.status, 401);
  });

  it('deletes account → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof }),
    });
    assert.equal(res.status, 200);
  });

  it('login fails after deletion → 401', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const proof = await createSrpProof(cookie, 'password123');
    await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof }),
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

    const proof = await createSrpProof(cookie, 'password123');
    await fetch(`${BASE_URL}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_srp: proof }),
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
