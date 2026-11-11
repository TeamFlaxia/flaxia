import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const workerSource = readFileSync(new URL('../functions/queue-worker.ts', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../functions/lib/activitypub/handlers.ts', import.meta.url), 'utf8');
const inbox = readFileSync(new URL('../functions/lib/activitypub/inbox.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0103_remote_activity_identity.sql', import.meta.url), 'utf8');

test('the queue worker delegates the activity handling to the ActivityPub module', () => {
  assert.match(workerSource, /import\('\.\/lib\/activitypub\/handlers'\)/);
  assert.match(workerSource, /handleIncomingActivity\(/);
});

test('Undo may only remove records belonging to the verified outer actor', () => {
  assert.match(handlers, /activity\.actor !== actorId/);
  assert.match(handlers, /object\.actor !== actorId/);
  assert.match(handlers, /DELETE FROM ap_followers WHERE local_user_id = \? AND actor_url = \?/);
  assert.match(handlers, /\.bind\(userId, actorId\)/);
});

test('remote likes and announces must not impersonate a local user', () => {
  assert.match(handlers, /INSERT OR IGNORE INTO likes \(id, post_id, user_id, actor_id, created_at\)/);
  assert.match(handlers, /INSERT OR IGNORE INTO shares \(id, post_id, user_id, actor_id, created_at\)/);
  assert.match(handlers, /VALUES \(\?, \?, NULL, \?,/);
  assert.match(migration, /user_id TEXT,/);
});

test('the inbox verifies the signature and the digest before a delivery is queued', () => {
  assert.match(inbox, /verifyHttpSignature\(/);
  assert.match(inbox, /verifyDigest\(/);
  assert.match(inbox, /keyId\/actor origin mismatch/);
  assert.doesNotMatch(inbox, /console\.(?:log|info|warn|error)\([^\n]*(?:signature|digest)/i);
});

test('ActivityPub does not sign shared-inbox actor lookups using arbitrary local keys', () => {
  const api = readFileSync(new URL('../functions/api/routes/activitypub.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /SELECT ak\.private_key_pem, u\.username/);
  assert.match(api, /INSERT OR IGNORE INTO actor_keys/);
  assert.equal((api.match(/app\.get\('\/api\/\.well-known\/webfinger'/g) ?? []).length, 1);
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

test('delivery cannot follow an inbox redirect to an unchecked destination', async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const exported = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(exported).toString('base64')}\n-----END PRIVATE KEY-----`;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let retried = false;
  globalThis.fetch = async (_input, init) => {
    requests++;
    // A redirect is not followed: the signature is bound to the inbox.
    assert.equal(init?.redirect, 'manual');
    throw new TypeError('Redirect refused');
  };
  try {
    const env = {
      BASE_URL: 'https://flaxia.app',
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return { private_key_pem: pem };
            },
          };
        },
      },
    } as unknown as Parameters<typeof worker.queue>[1];
    const batch = {
      messages: [
        {
          id: 'redirect',
          attempts: 1,
          body: {
            type: 'delivery',
            inboxUrl: 'https://remote.example/inbox',
            senderUsername: 'local',
            activity: { type: 'Like' },
          },
          ack() {
            assert.fail('failed delivery must reach retry/DLQ');
          },
          retry() {
            retried = true;
          },
        },
      ],
    } as unknown as Parameters<typeof worker.queue>[0];
    await worker.queue(batch, env);
    assert.equal(requests, 1);
    assert.ok(retried);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
