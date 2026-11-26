import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { BASE_URL, registerUser, seedUserAndLogin } from './helpers/setup.ts';

const USER = { email: 'apdiscovery@test.com', password: 'password123', username: 'apdiscovery', display_name: 'AP' };

describe('ActivityPub discovery endpoints', () => {
  before(async () => {
    await registerUser(USER);
  });

  it('answers WebFinger with the actor of the account', async () => {
    const response = await fetch(`${BASE_URL}/api/.well-known/webfinger?resource=acct:${USER.username}@localhost:8788`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /jrd\+json/);

    const body = (await response.json()) as {
      subject: string;
      links: Array<{ rel: string; type?: string; href: string }>;
    };
    assert.equal(body.subject, `acct:${USER.username}@localhost:8788`);
    const self = body.links.find((link) => link.rel === 'self');
    assert.equal(self?.type, 'application/activity+json');
    assert.equal(self?.href, `${BASE_URL}/api/actors/${USER.username}`);
  });

  it('answers WebFinger for the URL of a profile page', async () => {
    const response = await fetch(
      `${BASE_URL}/api/.well-known/webfinger?resource=${encodeURIComponent(`${BASE_URL}/users/${USER.username}`)}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { links: Array<{ rel: string; href: string }> };
    assert.equal(body.links.find((link) => link.rel === 'self')?.href, `${BASE_URL}/api/actors/${USER.username}`);
  });

  it('refuses a WebFinger request for another domain', async () => {
    const response = await fetch(`${BASE_URL}/api/.well-known/webfinger?resource=acct:someone@other.example`);
    assert.equal(response.status, 400);
  });

  it('publishes an actor document', async () => {
    const response = await fetch(`${BASE_URL}/api/actors/${USER.username}`, {
      headers: { Accept: 'application/activity+json' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /activity\+json/);

    const actor = (await response.json()) as Record<string, unknown>;
    assert.equal(actor.type, 'Person');
    assert.equal(actor.id, `${BASE_URL}/api/actors/${USER.username}`);
    assert.equal(actor.inbox, `${BASE_URL}/api/actors/${USER.username}/inbox`);
    assert.equal(actor.outbox, `${BASE_URL}/api/actors/${USER.username}/outbox`);
    assert.equal(actor.liked, `${BASE_URL}/api/actors/${USER.username}/liked`);
    assert.equal(actor.featured, `${BASE_URL}/api/actors/${USER.username}/featured`);
    assert.equal(actor.manuallyApprovesFollowers, false);
    const key = actor.publicKey as { id: string; publicKeyPem: string };
    assert.equal(key.id, `${BASE_URL}/api/actors/${USER.username}#main-key`);
    assert.match(key.publicKeyPem, /BEGIN PUBLIC KEY/);
  });

  it('publishes the collections of an actor', async () => {
    for (const name of ['followers', 'following', 'liked', 'featured', 'outbox']) {
      const response = await fetch(`${BASE_URL}/api/actors/${USER.username}/${name}`);
      assert.equal(response.status, 200, `${name} must be served`);
      const collection = (await response.json()) as { type: string; totalItems: number; id: string };
      assert.equal(collection.type, 'OrderedCollection');
      assert.equal(typeof collection.totalItems, 'number');
      assert.equal(collection.id, `${BASE_URL}/api/actors/${USER.username}/${name}`);
    }
  });

  it('publishes a host meta document', async () => {
    const response = await fetch(`${BASE_URL}/api/host-meta`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /xrd\+xml/);
    const body = await response.text();
    assert.match(body, /rel="lrdd"/);
    assert.match(body, /\.well-known\/webfinger\?resource=\{uri\}/);
  });

  it('serves WebFinger at the canonical root path', async () => {
    const response = await fetch(`${BASE_URL}/.well-known/webfinger?resource=acct:${USER.username}@localhost:8788`, {
      headers: { Accept: 'application/jrd+json' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /jrd\+json/);
    const body = (await response.json()) as { subject: string };
    assert.equal(body.subject, `acct:${USER.username}@localhost:8788`);
  });

  it('serves host-meta at the canonical root path', async () => {
    const response = await fetch(`${BASE_URL}/host-meta`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /xrd\+xml/);
    assert.match(await response.text(), /rel="lrdd"/);
  });

  it('serves nodeinfo discovery at the canonical root path', async () => {
    const response = await fetch(`${BASE_URL}/.well-known/nodeinfo`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { links: Array<{ href: string }> };
    assert.equal(body.links[0]?.href, `${BASE_URL}/api/nodeinfo/2.1`);
  });

  it('publishes the node info discovery document', async () => {
    const response = await fetch(`${BASE_URL}/api/.well-known/nodeinfo`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { links: Array<{ rel: string; href: string }> };
    assert.equal(body.links[0]?.href, `${BASE_URL}/api/nodeinfo/2.1`);
  });

  it('publishes the node info document of the instance', async () => {
    const response = await fetch(`${BASE_URL}/api/nodeinfo/2.1`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { software: { name: string }; protocols: string[] };
    assert.equal(body.software.name, 'flaxia');
    assert.deepEqual(body.protocols, ['activitypub']);
  });

  it('rejects an inbox delivery without a signature', async () => {
    const response = await fetch(`${BASE_URL}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Create', actor: 'https://remote.example/users/alice' }),
    });
    assert.equal(response.status, 401);
  });

  it('rejects an inbox delivery of another content type', async () => {
    const response = await fetch(`${BASE_URL}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(response.status, 400);
  });

  describe('outbox pagination', () => {
    let user: Awaited<ReturnType<typeof seedUserAndLogin>>;
    let outbox: string;
    let postId = '';
    const text = `outbox note ${Date.now()}`;

    before(async () => {
      user = await seedUserAndLogin(`apoutbox${Date.now().toString(36).slice(-5)}`);
      outbox = `${BASE_URL}/api/actors/${user.username}/outbox`;
      const created = await fetch(`${BASE_URL}/api/posts/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
        body: JSON.stringify({ text }),
      });
      if (!created.ok) throw new Error(`the post failed: ${created.status} ${await created.text()}`);
      const body = (await created.json()) as { post?: { id?: string } };
      postId = body.post?.id ?? '';
      assert.ok(postId, 'the committed post has an id');
    });

    it('serves the collection root with a total but no items', async () => {
      const response = await fetch(outbox, { headers: { Accept: 'application/activity+json' } });
      assert.equal(response.status, 200);
      const document = (await response.json()) as {
        type: string;
        id: string;
        totalItems: number;
        orderedItems?: unknown[];
      };
      assert.equal(document.type, 'OrderedCollection');
      assert.equal(document.id, outbox);
      assert.ok(document.totalItems >= 1);
      assert.equal(document.orderedItems, undefined);
    });

    it('serves ?page=1 as an OrderedCollectionPage with the Create activity', async () => {
      const response = await fetch(`${outbox}?page=1`, { headers: { Accept: 'application/activity+json' } });
      assert.equal(response.status, 200);
      const document = (await response.json()) as {
        type: string;
        id: string;
        partOf: string;
        totalItems: number;
        orderedItems: Array<{
          type: string;
          id: string;
          actor: string;
          object: { type: string; attributedTo: string; content: string };
        }>;
      };
      assert.equal(document.type, 'OrderedCollectionPage');
      assert.equal(document.id, `${outbox}?page=1`);
      assert.equal(document.partOf, outbox);
      const create = document.orderedItems.find((item) => item.type === 'Create');
      assert.ok(create, 'the published note must appear in the outbox');
      assert.equal(create.actor, `${BASE_URL}/api/actors/${user.username}`);
      assert.equal(create.object.type, 'Note');
      assert.equal(create.object.attributedTo, `${BASE_URL}/api/actors/${user.username}`);
      assert.ok(create.object.content.includes(text));
    });

    it('falls back to page 1 for a non-numeric page', async () => {
      const response = await fetch(`${outbox}?page=abc`, { headers: { Accept: 'application/activity+json' } });
      assert.equal(response.status, 200);
      const document = (await response.json()) as { type: string; id: string; prev?: string };
      assert.equal(document.type, 'OrderedCollectionPage');
      assert.equal(document.id, `${outbox}?page=1`);
      assert.equal(document.prev, undefined);
    });

    it('excludes a deleted (hidden) post from the page', async () => {
      const deleted = await fetch(`${BASE_URL}/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { Cookie: user.cookie },
      });
      assert.ok(deleted.ok, `the delete failed: ${await deleted.text()}`);

      const response = await fetch(`${outbox}?page=1`, { headers: { Accept: 'application/activity+json' } });
      const document = (await response.json()) as {
        totalItems: number;
        orderedItems: Array<{ object?: { content?: string } }>;
      };
      assert.ok(!document.orderedItems.some((item) => item.object?.content?.includes(text)));
    });
  });
});
