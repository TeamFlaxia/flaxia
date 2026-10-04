// fetchNotifications: TTL cache + graceful fallback (fetch is stubbed,
// since these suites run in Node without a browser).
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let calls = 0;
let ok = true;
let payload = { notifications: [], unread_count: 3 };

(globalThis as unknown as Record<string, unknown>).fetch = async () => {
  calls++;
  return {
    ok,
    json: async () => payload,
  };
};

const mod = await import('../src/lib/notifications-api.ts');

describe('fetchNotifications', () => {
  beforeEach(() => {
    mod.invalidateNotificationsCache();
    calls = 0;
    ok = true;
    payload = { notifications: [], unread_count: 3 };
  });

  it('returns the payload and caches within TTL', async () => {
    const first = await mod.fetchNotifications();
    assert.equal(first.unread_count, 3);
    const second = await mod.fetchNotifications();
    assert.equal(second.unread_count, 3);
    assert.equal(calls, 1);
  });

  it('refetches after invalidation', async () => {
    await mod.fetchNotifications();
    mod.invalidateNotificationsCache();
    payload = { notifications: [], unread_count: 7 };
    const data = await mod.fetchNotifications();
    assert.equal(data.unread_count, 7);
    assert.equal(calls, 2);
  });

  it('falls back to empty on HTTP error', async () => {
    ok = false;
    const data = await mod.fetchNotifications();
    assert.deepEqual(data, { notifications: [], unread_count: 0 });
  });

  it('falls back to empty on network failure', async () => {
    (globalThis as unknown as Record<string, unknown>).fetch = async () => {
      throw new Error('down');
    };
    try {
      const data = await mod.fetchNotifications();
      assert.deepEqual(data, { notifications: [], unread_count: 0 });
    } finally {
      (globalThis as unknown as Record<string, unknown>).fetch = async () => {
        calls++;
        return { ok, json: async () => payload };
      };
    }
  });
});
