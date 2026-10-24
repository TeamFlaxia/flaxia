import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMultiplayerTicket, resolveMultiplayerTicket } from '../functions/lib/multiplayer-ticket.ts';

test('socket tickets are opaque, room scoped, and expire without relying on KV eviction', async () => {
  const records = new Map<string, string>();
  const cache = {
    async put(key: string, value: string, options: { expirationTtl: number }) {
      assert.equal(options.expirationTtl, 60);
      records.set(key, value);
    },
    async get(key: string) {
      return JSON.parse(records.get(key) ?? 'null');
    },
  } as unknown as KVNamespace;
  const ticket = await createMultiplayerTicket(cache, 'private-session-cookie', 'room1');
  assert.equal(ticket.includes('private-session-cookie'), false);
  assert.equal(await resolveMultiplayerTicket(cache, ticket, 'room1'), 'private-session-cookie');
  assert.equal(await resolveMultiplayerTicket(cache, ticket, 'room2'), null);
  assert.equal(await resolveMultiplayerTicket(cache, 'invalid', 'room1'), null);
  const [key, raw] = [...records][0];
  records.set(key, JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 1 }));
  assert.equal(await resolveMultiplayerTicket(cache, ticket, 'room1'), null);
});
