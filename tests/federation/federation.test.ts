// The differential test against a real ActivityPub implementation.
//
// The instance under test federates with a peer that really implements
// ActivityPub (GoToSocial or Mastodon). Every scenario checks the same
// behaviour from both sides: what the instance publishes is compared with
// what the peer publishes, and what the instance delivers is checked against
// what the peer understands.
//
// The test needs a server that delivers without a queue (the local queue has
// no consumer) and the addresses of the private peers:
//   AP_DIRECT_DELIVERY=1 AP_ALLOWED_PRIVATE_PEERS=localhost,127.0.0.1
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BASE_URL, seedUserAndLogin } from '../helpers/setup.ts';
import { actorShape, diffShapes, formatDifferences, noteShape, webfingerShape } from './diff.ts';
import { createPeer, type FederationPeer } from './peer.ts';
import { RemoteInstance } from './remote.ts';

const PEER_KIND = process.env.FLAXIA_FEDERATION_PEER ?? '';
const BASE = process.env.FLAXIA_FEDERATION_BASE_URL ?? BASE_URL;
const PEER_DOMAIN = new URL(BASE).host;

const describeFederation = PEER_KIND ? describe : describe.skip;

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

describeFederation(`federation with ${PEER_KIND || 'a peer'}`, () => {
  let peer: FederationPeer;
  let remote: RemoteInstance;
  let account: { username: string; password: string; email: string; cookie: string };

  before(async () => {
    peer = createPeer(PEER_KIND);
    remote = new RemoteInstance();
    await remote.start();
    await peer.start();

    // A fresh account for every run: the account of the instance under test
    // may not follow the peer yet.
    const user = await seedUserAndLogin(`federation${Date.now().toString(36).slice(-6)}`);
    account = {
      username: user.username,
      password: user.password,
      email: user.email,
      cookie: user.cookie,
    };
  });

  after(async () => {
    await remote?.stop();
    await peer?.stop();
  });

  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: account.cookie,
        ...(init.headers ?? {}),
      },
    });
  }

  async function posts(): Promise<Array<{ id: string; text: string }>> {
    const response = await fetch(`${BASE}/api/posts`);
    const body = (await response.json()) as { posts?: Array<{ id: string; text: string }> };
    return body.posts ?? [];
  }

  it('answers WebFinger with the same shape as the peer', async () => {
    const ours = await fetch(`${BASE}/api/.well-known/webfinger?resource=acct:${account.username}@${PEER_DOMAIN}`);
    assert.equal(ours.status, 200);
    const ourDocument = (await ours.json()) as Record<string, unknown>;

    const peerAccount = await peer.account();
    const theirs = await fetch(
      `${peer.origin}/.well-known/webfinger?resource=acct:${peerAccount.username}@${new URL(peer.origin).host}`,
    );
    assert.equal(theirs.status, 200);
    const theirDocument = (await theirs.json()) as Record<string, unknown>;

    const differences = diffShapes(webfingerShape(ourDocument), webfingerShape(theirDocument));
    assert.deepEqual(differences, [], `the WebFinger documents differ:\n${formatDifferences(differences)}`);
  });

  it('publishes an actor document with the same shape as the peer', async () => {
    const ours = await fetch(`${BASE}/api/actors/${account.username}`, {
      headers: { Accept: 'application/activity+json' },
    });
    assert.equal(ours.status, 200);
    const ourDocument = (await ours.json()) as Record<string, unknown>;

    // An instance that runs in secure mode only answers a signed request.
    const peerAccount = await peer.account();
    const theirDocument = await remote.signedGet(peerAccount.actorUrl);

    // The liked collection and the shared inbox are optional: some
    // implementations publish neither of them.
    const differences = diffShapes(actorShape(ourDocument), actorShape(theirDocument), {
      ignore: ['hasLiked', 'hasSharedInbox'],
    });
    assert.deepEqual(differences, [], `the actor documents differ:\n${formatDifferences(differences)}`);
  });

  it('follows the account of the peer', async () => {
    const peerAccount = await peer.account();
    const response = await api('/api/remote-follow', {
      method: 'POST',
      body: JSON.stringify({ target: `${peerAccount.username}@${new URL(peer.origin).host}` }),
    });
    assert.ok(response.ok, `the follow failed: ${await response.text()}`);

    // The peer shows the instance in its followers, so it received the
    // follow and understood it.
    const followed = await waitFor(async () => {
      const followers = await peer.followers();
      return followers.some((follower) => follower.includes(account.username));
    }, 60_000);
    const followers = await peer.followers();
    assert.ok(followed, `the peer does not know the follower: ${followers.join(', ')}`);
  });

  it('is followed back by the peer', async () => {
    // The peer knows the account now, so it can look it up by its handle.
    let known = false;
    const looked = await waitFor(async () => {
      const found = await peer.lookup(`${account.username}@${PEER_DOMAIN}`);
      known = Boolean(found);
      return known;
    }, 30_000);
    assert.ok(looked, 'the peer does not know the account of the instance');

    const peerAccount = await peer.account();
    // The peer may still be busy with the follow of the instance, so the
    // request is repeated for a while.
    let lastError = 'unknown';
    const followed = await waitFor(async () => {
      try {
        // The account of the instance is looked up again for every attempt:
        // the peer may still be busy with the follow of the instance.
        const target = await peer.lookup(`${account.username}@${PEER_DOMAIN}`);
        if (!target) {
          lastError = 'the peer does not know the account yet';
          return false;
        }
        await peer.follow(target.id);
        return true;
      } catch (error) {
        lastError = (error as Error).message;
        return false;
      }
    }, 60_000);
    assert.ok(followed, `the peer refused to follow the account of the instance: ${lastError}`);

    // The instance accepts the follow, so the peer shows the instance in the
    // accounts it follows.
    const following = await waitFor(async () => {
      const entries = await peer.following();
      return entries.some((entry) => entry.includes(account.username));
    }, 60_000);
    const entries = await peer.following();
    assert.ok(following, `the peer does not follow the instance: ${entries.join(', ')}`);
  });

  it('delivers a note of this instance to the peer', async () => {
    const text = `a note of the instance under test ${Date.now()}`;
    // The commit endpoint is the one the composer uses: it publishes the
    // post and delivers it to the followers.
    const response = await api('/api/posts/commit', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    assert.ok(response.ok, `the post failed: ${await response.text()}`);

    const delivered = await waitFor(async () => {
      const timeline = await peer.timeline();
      return timeline.some((status) => status.content.includes(text));
    }, 90_000);
    const timeline = await peer.timeline();
    assert.ok(delivered, `the peer did not receive the note: ${timeline.map((status) => status.content).join(' | ')}`);
  });

  it('receives a note of the peer', async () => {
    const text = `a note of the peer ${Date.now()}`;
    await peer.post(text);

    const received = await waitFor(async () => {
      const list = await posts();
      return list.some((post) => post.text.includes(text));
    }, 90_000);
    assert.ok(received, 'the note of the peer did not arrive');
  });

  it('signs the activities it delivers', async () => {
    // The remote instance follows the account of the instance under test, so
    // it receives everything the instance publishes. The key of the instance
    // is fetched before the delivery: the instance waits for the answer.
    await remote.primeSenderKey(`${BASE}/api/actors/${account.username}`);
    await remote.deliver(`${BASE}/api/inbox`, {
      id: `${remote.origin}/activities/follow-1`,
      type: 'Follow',
      actor: remote.actor.actorUrl,
      to: [`${BASE}/api/actors/${account.username}`],
      object: `${BASE}/api/actors/${account.username}`,
    });

    const delivered = await waitFor(async () => remote.deliveries.length > 0, 60_000);
    assert.ok(delivered, 'the instance did not deliver anything to the remote instance');

    for (const delivery of remote.deliveries) {
      assert.equal(delivery.signatureValid, true, 'a delivered activity carried an invalid signature');
      assert.equal(delivery.digestValid, true, 'a delivered activity carried an invalid digest');
    }
  });

  it('publishes a note with the same shape as the note of the peer', async () => {
    const text = `a note to compare ${Date.now()}`;
    const response = await api('/api/posts/commit', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const created = (await response.json()) as { post?: { id?: string } };
    const postId = created.post?.id ?? '';

    const ourDocument = (await (
      await fetch(`${BASE}/api/notes/${postId}`, { headers: { Accept: 'application/activity+json' } })
    ).json()) as Record<string, unknown>;

    const peerStatus = await peer.post(`a note of the peer to compare ${Date.now()}`);
    const peerAccount = await peer.account();
    const peerDocument = await remote.signedGet(
      `${peer.origin}/users/${peerAccount.username}/statuses/${peerStatus.id}`,
    );
    assert.ok(peerDocument, 'the peer did not serve its note');

    const differences = diffShapes(noteShape(ourDocument), noteShape(peerDocument));
    assert.deepEqual(differences, [], `the notes differ:\n${formatDifferences(differences)}`);
  });
});
