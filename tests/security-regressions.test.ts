import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function createPendingPost(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'post.txt' }),
  });
  const data = (await res.json()) as { postId: string };
  return data.postId;
}

async function commitPost(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe('IDOR: /api/posts/commit ownership', () => {
  beforeEach(resetDb);

  it("blocks committing another user's post → 403", async () => {
    const u1 = await seedUserAndLogin('1');
    const postId = await createPendingPost(u1.cookie);
    const ownRes = await commitPost(u1.cookie, { postId, text: 'owned by user1' });
    assert.equal(ownRes.status, 200);

    const u2 = await seedUserAndLogin('2');
    const res = await commitPost(u2.cookie, { postId, text: 'stolen by user2' });
    assert.equal(res.status, 403);
  });

  it('allows committing an unknown postId → 201', async () => {
    const u1 = await seedUserAndLogin('1');
    const postId = await createPendingPost(u1.cookie);
    const res = await commitPost(u1.cookie, { postId, text: 'brand new' });
    assert.equal(res.status, 200);
  });
});

describe('SSRF: link-preview rejects internal hosts', () => {
  beforeEach(resetDb);

  it('rejects private IP literal → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/link-preview?url=${encodeURIComponent('http://127.0.0.1/')}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error);
  });

  it('rejects localhost hostname → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/link-preview?url=${encodeURIComponent('http://localhost:8080/secret')}`);
    assert.equal(res.status, 400);
  });
});

describe('Polls: single-choice vote', () => {
  beforeEach(resetDb);

  it('replaces a previous single-choice vote', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const commitRes = await commitPost(cookie, {
      postId,
      text: 'single poll post',
      poll: { question: 'Pick one', options: ['A', 'B', 'C'], multipleChoice: false },
    });
    assert.equal(commitRes.status, 200);

    const pollRes = await fetch(`${BASE_URL}/api/polls/${postId}`);
    assert.equal(pollRes.status, 200);
    const { poll, options } = (await pollRes.json()) as {
      poll: { id: string; multiple_choice: number };
      options: Array<{ id: string; votes_count: number }>;
    };
    assert.equal(poll.multiple_choice, 0);
    assert.equal(options.length, 3);

    const voteA = await fetch(`${BASE_URL}/api/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionId: options[0].id }),
    });
    assert.equal(voteA.status, 200);

    const voteB = await fetch(`${BASE_URL}/api/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionId: options[1].id }),
    });
    assert.equal(voteB.status, 200);

    const afterRes = await fetch(`${BASE_URL}/api/polls/${postId}`, { headers: { Cookie: cookie } });
    const after = (await afterRes.json()) as {
      options: Array<{ id: string; votes_count: number }>;
      userVotes: string[];
      userVote: string | null;
    };
    assert.deepEqual(after.userVotes, [options[1].id]);
    assert.equal(after.userVote, options[1].id);
    assert.equal(after.options.find((o) => o.id === options[0].id)?.votes_count, 0);
    assert.equal(after.options.find((o) => o.id === options[1].id)?.votes_count, 1);
  });
});

describe('Polls: multiple-choice vote', () => {
  beforeEach(resetDb);

  it('records votes for multiple options for a multiple_choice poll', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const commitRes = await commitPost(cookie, {
      postId,
      text: 'multi poll post',
      poll: { question: 'Pick several', options: ['X', 'Y', 'Z'], multipleChoice: true },
    });
    assert.equal(commitRes.status, 200);

    const pollRes = await fetch(`${BASE_URL}/api/polls/${postId}`);
    const { poll, options } = (await pollRes.json()) as {
      poll: { id: string; multiple_choice: number };
      options: Array<{ id: string; votes_count: number }>;
    };
    assert.equal(poll.multiple_choice, 1);

    const voteRes = await fetch(`${BASE_URL}/api/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionIds: [options[0].id, options[1].id] }),
    });
    assert.equal(voteRes.status, 200);

    const afterRes = await fetch(`${BASE_URL}/api/polls/${postId}`, { headers: { Cookie: cookie } });
    const after = (await afterRes.json()) as {
      options: Array<{ id: string; votes_count: number }>;
      userVotes: string[];
    };
    assert.deepEqual(after.userVotes.sort(), [options[0].id, options[1].id].sort());
    assert.equal(after.options.find((o) => o.id === options[0].id)?.votes_count, 1);
    assert.equal(after.options.find((o) => o.id === options[1].id)?.votes_count, 1);
    assert.equal(after.options.find((o) => o.id === options[2].id)?.votes_count, 0);

    // De-selecting one option updates the vote set
    const updateRes = await fetch(`${BASE_URL}/api/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionIds: [options[0].id] }),
    });
    assert.equal(updateRes.status, 200);

    const finalRes = await fetch(`${BASE_URL}/api/polls/${postId}`, { headers: { Cookie: cookie } });
    const final = (await finalRes.json()) as {
      options: Array<{ id: string; votes_count: number }>;
      userVotes: string[];
    };
    assert.deepEqual(final.userVotes, [options[0].id]);
    assert.equal(final.options.find((o) => o.id === options[0].id)?.votes_count, 1);
    assert.equal(final.options.find((o) => o.id === options[1].id)?.votes_count, 0);
  });

  it('rejects an option that does not belong to the poll → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    await commitPost(cookie, {
      postId,
      text: 'multi poll post',
      poll: { question: 'Pick several', options: ['X', 'Y'], multipleChoice: true },
    });

    const pollRes = await fetch(`${BASE_URL}/api/polls/${postId}`);
    const { poll } = (await pollRes.json()) as { poll: { id: string } };
    const res = await fetch(`${BASE_URL}/api/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionIds: ['bogus-option-id'] }),
    });
    assert.equal(res.status, 404);
  });
});
