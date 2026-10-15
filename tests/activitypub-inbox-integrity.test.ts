import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../functions/queue-worker.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../functions/api/routes/activitypub.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0103_remote_activity_identity.sql', import.meta.url), 'utf8');

test('Undo may only remove records belonging to the verified outer actor', () => {
  assert.match(src, /activity\.actor !== actorId/);
  assert.match(src, /object\.actor !== actorId/);
  assert.match(src, /bind\(userResult\.id, actorId\)/);
});

test('remote likes and announces must not impersonate a local user', () => {
  assert.match(src, /bind\(likeId, postId, null, actorId\)/);
  assert.match(src, /bind\(shareId, postId, null, actorId\)/);
  assert.match(migration, /user_id TEXT,/);
});

test('ActivityPub does not sign shared-inbox actor lookups using arbitrary local keys', () => {
  assert.doesNotMatch(api, /SELECT ak\.private_key_pem, u\.username/);
  assert.match(api, /INSERT OR IGNORE INTO actor_keys/);
  assert.equal((api.match(/app\.get\('\/.well-known\/webfinger'/g) ?? []).length, 1);
});
