import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('GET /api/notifications', () => {
  beforeEach(resetDb);

  it('returns notifications list → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.notifications));
  });

  it('returns unread_count', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.unread_count === 'number');
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications`);
    assert.equal(res.status, 401);
  });
});

describe('POST /api/notifications/read-all', () => {
  beforeEach(resetDb);

  it('marks all as read → unread_count becomes 0', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications/read-all`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);

    const notifRes = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    const notifData = await notifRes.json();
    assert.equal(notifData.unread_count, 0);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/read-all`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });
});
