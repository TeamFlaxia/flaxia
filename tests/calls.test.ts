import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, loginUser, resetDb } from './helpers/setup.ts';

async function createGroup(cookie: string, name: string, memberIds: string[]): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name, memberIds }),
  });
  const data = (await res.json()) as { id?: string; error?: string };
  if (!data.id) throw new Error(`Failed to create group: ${JSON.stringify(data)}`);
  return data.id;
}

async function registerTestUser(
  email: string,
  password: string,
  username: string,
  displayName: string,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username, display_name: displayName }),
  });
}

async function authUserAndGetId(suffix: string): Promise<{ cookie: string; userId: string }> {
  await registerTestUser(`calltest${suffix}@test.com`, 'password123', `calluser${suffix}`, `Call User ${suffix}`);
  const { cookie } = await loginUser(`calltest${suffix}@test.com`, 'password123');
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie } });
  const meData = (await meRes.json()) as { id?: string };
  return { cookie, userId: meData.id || '' };
}

describe('POST /api/calls/start', () => {
  beforeEach(resetDb);

  it('starts a group call → 200', async () => {
    const u1 = await authUserAndGetId('1');
    const u2 = await authUserAndGetId('2');
    const groupId = await createGroup(u1.cookie, 'Test Group', [u2.userId]);

    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { id: string; roomId: string; type: string };
    assert.ok(typeof data.id === 'string');
    assert.equal(data.roomId, data.id);
    assert.equal(data.type, 'audio');
  });

  it('starts a video call → 200', async () => {
    const u1 = await authUserAndGetId('1');
    const u2 = await authUserAndGetId('2');
    const groupId = await createGroup(u1.cookie, 'Test Group', [u2.userId]);

    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId, type: 'video' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { type: string };
    assert.equal(data.type, 'video');
  });

  it('rejects missing groupId → 400', async () => {
    const u1 = await authUserAndGetId('1');
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ type: 'audio' }),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.ok(data.error);
  });

  it('rejects non-existent group → 403', async () => {
    const u1 = await authUserAndGetId('1');
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId: 'nonexistent-id', type: 'audio' }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects when user is not a group member → 403', async () => {
    const u1 = await authUserAndGetId('1');
    const u2 = await authUserAndGetId('2');
    const u3 = await authUserAndGetId('3');
    const groupId = await createGroup(u1.cookie, 'Test Group', [u2.userId]);
    // u3 tries to start a call in a group they're not in
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u3.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects starting a second call while already in one → 409', async () => {
    const u1 = await authUserAndGetId('1');
    const u2 = await authUserAndGetId('2');
    const u3 = await authUserAndGetId('3');
    const groupA = await createGroup(u1.cookie, 'Group A', [u2.userId]);
    const groupB = await createGroup(u1.cookie, 'Group B', [u3.userId]);
    // Start first call
    const firstRes = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId: groupA, type: 'audio' }),
    });
    assert.equal(firstRes.status, 200);
    // Try starting a second call
    const secondRes = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId: groupB, type: 'audio' }),
    });
    assert.equal(secondRes.status, 409);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: 'fake', type: 'audio' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/calls/:id/join', () => {
  let user1: { cookie: string; userId: string };
  let user2: { cookie: string; userId: string };
  let groupId: string;
  let callId: string;

  beforeEach(async () => {
    await resetDb();
    user1 = await authUserAndGetId('1');
    user2 = await authUserAndGetId('2');
    groupId = await createGroup(user1.cookie, 'Test Group', [user2.userId]);
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    const data = (await res.json()) as { id: string };
    callId = data.id;
  });

  it('joins an active call → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/join`, {
      method: 'POST',
      headers: { Cookie: user2.cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { id: string; roomId: string; type: string; wsUrl: string };
    assert.equal(data.id, callId);
    assert.equal(data.roomId, callId);
    assert.ok(data.wsUrl.includes('ws'));
  });

  it('rejects joining a non-existent call → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/nonexistent/join`, {
      method: 'POST',
      headers: { Cookie: user2.cookie },
    });
    assert.equal(res.status, 404);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/join`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects user not in group → 403', async () => {
    const user3 = await authUserAndGetId('3');
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/join`, {
      method: 'POST',
      headers: { Cookie: user3.cookie },
    });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/calls/:id/end', () => {
  let user1: { cookie: string; userId: string };
  let user2: { cookie: string; userId: string };
  let groupId: string;
  let callId: string;

  beforeEach(async () => {
    await resetDb();
    user1 = await authUserAndGetId('1');
    user2 = await authUserAndGetId('2');
    groupId = await createGroup(user1.cookie, 'Test Group', [user2.userId]);
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    const data = (await res.json()) as { id: string };
    callId = data.id;
  });

  it('ends a call → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/end`, {
      method: 'POST',
      headers: { Cookie: user1.cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { success: boolean };
    assert.equal(data.success, true);
  });

  it('allows any participant to end the call → 200', async () => {
    await fetch(`${BASE_URL}/api/calls/${callId}/join`, {
      method: 'POST',
      headers: { Cookie: user2.cookie },
    });
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/end`, {
      method: 'POST',
      headers: { Cookie: user2.cookie },
    });
    assert.equal(res.status, 200);
  });

  it('rejects non-participant → 403', async () => {
    const user3 = await authUserAndGetId('3');
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/end`, {
      method: 'POST',
      headers: { Cookie: user3.cookie },
    });
    assert.equal(res.status, 403);
  });

  it('rejects ending a non-existent call → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/nonexistent/end`, {
      method: 'POST',
      headers: { Cookie: user1.cookie },
    });
    assert.equal(res.status, 404);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/end`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/calls/:id/mute', () => {
  let user1: { cookie: string; userId: string };
  let callId: string;

  beforeEach(async () => {
    await resetDb();
    user1 = await authUserAndGetId('1');
    const user2 = await authUserAndGetId('2');
    const groupId = await createGroup(user1.cookie, 'Test Group', [user2.userId]);
    const res = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    const data = (await res.json()) as { id: string };
    callId = data.id;
  });

  it('toggles mute on → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ muted: true }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { success: boolean; muted: boolean };
    assert.equal(data.success, true);
    assert.equal(data.muted, true);
  });

  it('toggles mute off → 200', async () => {
    await fetch(`${BASE_URL}/api/calls/${callId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ muted: true }),
    });
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ muted: false }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { success: boolean; muted: boolean };
    assert.equal(data.muted, false);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/${callId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/calls/active', () => {
  let user1: { cookie: string; userId: string };
  let user2: { cookie: string; userId: string };

  beforeEach(async () => {
    await resetDb();
    user1 = await authUserAndGetId('1');
    user2 = await authUserAndGetId('2');
  });

  it('returns empty list when no active calls → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/active`, {
      headers: { Cookie: user1.cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { calls: unknown[] };
    assert.ok(Array.isArray(data.calls));
    assert.equal(data.calls.length, 0);
  });

  it('returns active calls → 200', async () => {
    const groupId = await createGroup(user1.cookie, 'Test Group', [user2.userId]);
    await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });

    const res = await fetch(`${BASE_URL}/api/calls/active`, {
      headers: { Cookie: user1.cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { calls: Record<string, unknown>[] };
    assert.ok(Array.isArray(data.calls));
    assert.ok(data.calls.length >= 1);
  });

  it('rejects unauthenticated → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/active`);
    assert.equal(res.status, 401);
  });
});

describe('Call lifecycle (start → join → end)', () => {
  beforeEach(resetDb);

  it('completes a full call lifecycle', async () => {
    const u1 = await authUserAndGetId('1');
    const u2 = await authUserAndGetId('2');
    const groupId = await createGroup(u1.cookie, 'Test Group', [u2.userId]);

    // Start
    const startRes = await fetch(`${BASE_URL}/api/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u1.cookie },
      body: JSON.stringify({ groupId, type: 'audio' }),
    });
    assert.equal(startRes.status, 200);
    const { id } = (await startRes.json()) as { id: string };
    assert.ok(id);

    // Join
    const joinRes = await fetch(`${BASE_URL}/api/calls/${id}/join`, {
      method: 'POST',
      headers: { Cookie: u2.cookie },
    });
    assert.equal(joinRes.status, 200);

    // Check active
    const activeRes = await fetch(`${BASE_URL}/api/calls/active`, {
      headers: { Cookie: u1.cookie },
    });
    assert.equal(activeRes.status, 200);
    const activeData = (await activeRes.json()) as { calls: { id: string }[] };
    assert.ok(activeData.calls.some((c: { id: string }) => c.id === id));

    // End
    const endRes = await fetch(`${BASE_URL}/api/calls/${id}/end`, {
      method: 'POST',
      headers: { Cookie: u1.cookie },
    });
    assert.equal(endRes.status, 200);

    // Join after end → 410
    const joinAfterEndRes = await fetch(`${BASE_URL}/api/calls/${id}/join`, {
      method: 'POST',
      headers: { Cookie: u2.cookie },
    });
    assert.equal(joinAfterEndRes.status, 410);
  });
});
