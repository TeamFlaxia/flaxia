// Regression test for realtime chat polling. `pollMessages` passes the newest
// message's timestamp and expects everything NEWER. The history-pagination
// `cursor` previously returned OLDER messages, so new messages never arrived
// (and older pages could be appended at the bottom, jumbling the view).
//
// Requires a running `npm run dev:test` server on http://localhost:8788.
import assert from 'node:assert';
import { before, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let aCookie = '';
let bId = '';
let convId = '';

interface ApiMsg {
  id: string;
  content: string;
  created_at: string;
  sender_id: string;
  is_mine: boolean;
}

async function meId(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
  return ((await res.json()) as { user: { id: string } }).user.id;
}

async function send(cookie: string, content: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200, `send ${content}`);
}

async function fetchMessages(cookie: string, query: string): Promise<ApiMsg[]> {
  const res = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages?${query}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { messages: ApiMsg[] }).messages;
}

before(async () => {
  await resetDb();
  const a = await seedUserAndLogin('pollA');
  const b = await seedUserAndLogin('pollB');
  aCookie = a.cookie;
  bId = await meId(b.cookie);

  const conv = await fetch(`${BASE_URL}/api/dm/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: aCookie },
    body: JSON.stringify({ userId: bId }),
  });
  convId = ((await conv.json()) as { id: string }).id;

  await send(aCookie, 'one');
  await sleep(5);
  await send(aCookie, 'two');
  await sleep(5);
  await send(aCookie, 'three');
});

describe('DM realtime polling', () => {
  it('history cursor returns older messages, newest first', async () => {
    const all = await fetchMessages(aCookie, 'limit=50');
    assert.deepEqual(
      all.map((m) => m.content),
      ['three', 'two', 'one'],
      'initial history is newest-first',
    );
  });

  it('after= returns only messages at-or-newer than the boundary, oldest first', async () => {
    const all = await fetchMessages(aCookie, 'limit=50');
    const boundary = all.find((m) => m.content === 'two')!;
    const newer = await fetchMessages(aCookie, `limit=10&after=${encodeURIComponent(boundary.created_at)}`);
    assert.deepEqual(
      newer.map((m) => m.content),
      ['two', 'three'],
      'poll returns newer messages in ascending order',
    );
  });

  it('after= excludes distinctly older messages', async () => {
    const all = await fetchMessages(aCookie, 'limit=50');
    const newest = all[0];
    const newer = await fetchMessages(aCookie, `limit=10&after=${encodeURIComponent(newest.created_at)}`);
    assert.ok(
      newer.every((m) => m.content !== 'one'),
      'older messages are not returned by a poll',
    );
    assert.ok(
      newer.some((m) => m.content === 'three'),
      'the boundary message is included so a shared millisecond is not missed',
    );
  });
});
