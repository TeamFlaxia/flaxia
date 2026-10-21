import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
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

test('remote activity migration preserves local shares and permits remote identities with foreign keys enabled', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE posts (id TEXT PRIMARY KEY);',
  );
  db.exec(readFileSync(new URL('../migrations/0015_add_likes_shares_tables.sql', import.meta.url), 'utf8'));
  db.exec(
    "INSERT INTO users VALUES ('owner'); INSERT INTO posts VALUES ('post'); INSERT INTO shares (id, post_id, user_id, actor_id) VALUES ('local', 'post', 'owner', 'local-actor');",
  );
  db.exec(migration);
  db.exec("INSERT INTO likes (id, post_id, user_id, actor_id) VALUES ('remote', 'post', NULL, 'remote-actor');");
  assert.equal(db.prepare('SELECT user_id FROM shares').get()?.user_id, 'owner');
  assert.equal(db.prepare('SELECT user_id FROM likes').get()?.user_id, null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { default: worker } = await import('../functions/queue-worker.ts');
for (const type of ['Like', 'Announce', 'Follow']) {
  test(`Undo ${type} uses the signed actor and target object`, async () => {
    const queries: unknown[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              queries.push([sql, ...values]);
              return this;
            },
            async first() {
              return { id: 'local-user' };
            },
            async run() {},
          };
        },
      },
    } as unknown as Parameters<typeof worker.queue>[1];
    for (const embeddedActor of ['https://remote.example/alice', 'https://remote.example/bob']) {
      queries.length = 0;
      let acknowledged = false;
      const batch = {
        messages: [
          {
            id: 'message',
            body: {
              type: 'inbox',
              username: 'local-user',
              actorId: 'https://remote.example/alice',
              activity: {
                type: 'Undo',
                actor: 'https://remote.example/alice',
                object: {
                  type,
                  actor: embeddedActor,
                  id: 'https://remote.example/activities/123',
                  object: 'https://flaxia.app/notes/post_-123',
                },
              },
            },
            ack() {
              acknowledged = true;
            },
            retry() {
              assert.fail('must not retry');
            },
          },
        ],
      } as unknown as Parameters<typeof worker.queue>[0];
      await worker.queue(batch, env);
      assert.ok(acknowledged);
      if (embeddedActor.endsWith('/bob')) assert.equal(queries.length, 0);
      else {
        const deletion = queries.find(([sql]) => String(sql).includes('DELETE'));
        assert.ok(deletion, 'valid Undo must delete the recorded activity');
        assert.equal(deletion[2], 'https://remote.example/alice');
        if (type !== 'Follow') assert.equal(deletion[1], 'post_-123');
      }
    }
  });
}
