import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('POST /api/multiplayer/rooms', () => {
  beforeEach(resetDb);

  it('creates a room → 201', async () => {
    const { cookie } = await seedUserAndLogin('mp1');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'test-game', maxPlayers: 4, isPublic: true }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(data.roomId);
    assert.equal(data.gameId, 'test-game');
    assert.equal(data.maxPlayers, 4);
    assert.equal(data.isPublic, true);
  });

  it('creates a room with defaults → 201', async () => {
    const { cookie } = await seedUserAndLogin('mp2');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'default-game' }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.maxPlayers, 2);
    assert.equal(data.isPublic, true);
  });

  it('rejects missing gameId → 400', async () => {
    const { cookie } = await seedUserAndLogin('mp3');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: 'test' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid JSON → 400', async () => {
    const { cookie } = await seedUserAndLogin('mp4');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: 'not-json',
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/multiplayer/rooms', () => {
  beforeEach(resetDb);

  it('lists public rooms → 200', async () => {
    const { cookie } = await seedUserAndLogin('mp5');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(data.rooms));
  });

  it('filters by gameId', async () => {
    const { cookie } = await seedUserAndLogin('mp6');
    await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'filter-test' }),
    });
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms?gameId=filter-test`, {
      headers: { Cookie: cookie },
    });
    const data = (await res.json()) as Record<string, unknown>;
    const rooms = data.rooms as Array<Record<string, unknown>>;
    assert.ok(rooms.length >= 1);
    for (const room of rooms) {
      assert.equal(room.game_id, 'filter-test');
    }
  });

  it('filters by status', async () => {
    const { cookie } = await seedUserAndLogin('mp7');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms?status=playing`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms`);
    assert.equal(res.status, 401);
  });
});

describe('GET /api/multiplayer/rooms/:id', () => {
  beforeEach(resetDb);

  it('returns room details → 200', async () => {
    const { cookie } = await seedUserAndLogin('mp8');
    const createRes = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'detail-test' }),
    });
    const { roomId } = (await createRes.json()) as { roomId: string };

    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(data.room);
    assert.equal((data.room as Record<string, unknown>).id, roomId);
    assert.ok(Array.isArray(data.participants));
  });

  it('returns 404 for non-existent room', async () => {
    const { cookie } = await seedUserAndLogin('mp9');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/nonexistent`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/fake`);
    assert.equal(res.status, 401);
  });
});

describe('POST /api/multiplayer/rooms/:id/join', () => {
  beforeEach(resetDb);

  it('joins an existing room → 200', async () => {
    const { cookie: hostCookie } = await seedUserAndLogin('host');
    const createRes = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hostCookie },
      body: JSON.stringify({ gameId: 'join-test' }),
    });
    const { roomId } = (await createRes.json()) as { roomId: string };

    const { cookie: joinerCookie } = await seedUserAndLogin('joiner');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: joinerCookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(data.success);
    assert.equal(data.roomId, roomId);
    assert.ok(typeof data.wsUrl === 'string');
  });

  it('returns 404 for non-existent room', async () => {
    const { cookie } = await seedUserAndLogin('mp10');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/nonexistent/join`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/fake/join`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('allows multiple players to join', async () => {
    const { cookie: hostCookie } = await seedUserAndLogin('mhost');
    const createRes = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hostCookie },
      body: JSON.stringify({ gameId: 'multi-join', maxPlayers: 3 }),
    });
    const { roomId } = (await createRes.json()) as { roomId: string };

    const { cookie: p2 } = await seedUserAndLogin('mp2nd');
    const res2 = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: p2 },
    });
    assert.equal(res2.status, 200);

    const { cookie: p3 } = await seedUserAndLogin('mp3rd');
    const res3 = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: p3 },
    });
    assert.equal(res3.status, 200);
  });
});

describe('POST /api/multiplayer/rooms/:id/leave', () => {
  beforeEach(resetDb);

  it('leaves a room → 200', async () => {
    const { cookie } = await seedUserAndLogin('mp11');
    const createRes = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'leave-test' }),
    });
    const { roomId } = (await createRes.json()) as { roomId: string };

    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(data.success);
  });
});

describe('POST /api/multiplayer/scores', () => {
  beforeEach(resetDb);

  it('submits a score → 201', async () => {
    const { cookie } = await seedUserAndLogin('mp12');
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'score-game', score: 1000, label: 'Level 1' }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.score, 1000);
    assert.equal(data.label, 'Level 1');
  });

  it('submits score with metadata → 201', async () => {
    const { cookie } = await seedUserAndLogin('mp13');
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'meta-game', score: 500, metadata: { level: 3, time: 120 } }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects invalid score (NaN) → 400', async () => {
    const { cookie } = await seedUserAndLogin('mp14');
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'bad', score: 'abc' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing gameId → 400', async () => {
    const { cookie } = await seedUserAndLogin('mp15');
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ score: 100 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: 'g', score: 100 }),
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/multiplayer/scores/:gameId', () => {
  beforeEach(resetDb);

  it('returns leaderboard → 200', async () => {
    const { cookie } = await seedUserAndLogin('mp16');
    await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'lb-game', score: 100 }),
    });

    const res = await fetch(`${BASE_URL}/api/multiplayer/scores/lb-game`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(data.scores));
  });

  it('returns empty list for game with no scores', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/scores/nonexistent-game`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { scores: unknown[] };
    assert.deepStrictEqual(data.scores, []);
  });

  it('filters by userId', async () => {
    const { cookie } = await seedUserAndLogin('mp17');
    await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'filter-lb', score: 200 }),
    });

    const res = await fetch(`${BASE_URL}/api/multiplayer/scores/filter-lb?userId=mp17`);
    assert.equal(res.status, 200);
  });

  it('scores are ordered descending', async () => {
    const { cookie: c1 } = await seedUserAndLogin('ms1');
    const { cookie: c2 } = await seedUserAndLogin('ms2');

    await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: c1 },
      body: JSON.stringify({ gameId: 'order-game', score: 50 }),
    });
    await fetch(`${BASE_URL}/api/multiplayer/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: c2 },
      body: JSON.stringify({ gameId: 'order-game', score: 200 }),
    });

    const res = await fetch(`${BASE_URL}/api/multiplayer/scores/order-game`);
    const data = (await res.json()) as { scores: Array<{ score: number }> };
    assert.ok(data.scores[0].score >= data.scores[1].score);
  });
});

describe('POST /api/multiplayer/matchmaking', () => {
  beforeEach(resetDb);

  it('joins matchmaking queue → 200', async () => {
    const { cookie } = await seedUserAndLogin('mm1');
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'mm-game', action: 'join' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(data.status === 'queued' || data.status === 'already_in_queue');
  });

  it('leaves matchmaking queue → 200', async () => {
    const { cookie } = await seedUserAndLogin('mm2');
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'mm-game2', action: 'leave' }),
    });
    assert.equal(res.status, 200);
  });

  it('checks matchmaking → 200', async () => {
    const { cookie } = await seedUserAndLogin('mm3');
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'mm-game3', action: 'check' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    // With only one player in queue, should not match
    assert.equal(data.matched, false);
  });

  it('rejects missing gameId → 400', async () => {
    const { cookie } = await seedUserAndLogin('mm4');
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'join' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unknown action → 400', async () => {
    const { cookie } = await seedUserAndLogin('mm5');
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'mm-game5', action: 'unknown' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/multiplayer/matchmaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: 'g', action: 'join' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/multiplayer/rooms/:id/join — error cases', () => {
  beforeEach(resetDb);

  it('returns 400 when joining a room that is playing', async () => {
    const { cookie } = await seedUserAndLogin('err1');
    const createRes = await fetch(`${BASE_URL}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ gameId: 'err-game', maxPlayers: 1 }),
    });
    const { roomId } = (await createRes.json()) as { roomId: string };

    // When maxPlayers=1, second join would be rejected
    const { cookie: err2 } = await seedUserAndLogin('err2');
    const res = await fetch(`${BASE_URL}/api/multiplayer/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: err2 },
    });
    assert.equal(res.status, 400);
  });
});
