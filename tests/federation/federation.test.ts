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
import { PUBLIC_COLLECTION } from '../../functions/lib/activitypub/context.ts';
import { BASE_URL, seedUserAndLogin } from '../helpers/setup.ts';
import { activityShape, actorShape, diffShapes, formatDifferences, noteShape, webfingerShape } from './diff.ts';
import { createPeer, type FederationPeer } from './peer.ts';
import { RemoteInstance } from './remote.ts';

const PEER_KIND = process.env.FLAXIA_FEDERATION_PEER ?? '';
const BASE = process.env.FLAXIA_FEDERATION_BASE_URL ?? BASE_URL;
const PEER_DOMAIN = new URL(BASE).host;

const describeFederation = PEER_KIND ? describe : describe.skip;

// This check lives outside the skipped suite so it runs even when the peer
// name is missing. Without it, `describe.skip` would report a green run for a
// federation test that never actually talked to a peer.
it('requires FLAXIA_FEDERATION_PEER to name the peer under test', () => {
  assert.ok(PEER_KIND, 'FLAXIA_FEDERATION_PEER must be set to "gotosocial" or "mastodon" to run the federation suite');
});

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
    // A missing or misspelled peer name must fail loudly instead of silently
    // skipping the whole suite and reporting a green CI run.
    assert.ok(PEER_KIND, 'FLAXIA_FEDERATION_PEER must name the peer under test');
    peer = createPeer(PEER_KIND);
    assert.equal(peer.name, PEER_KIND, `the peer "${PEER_KIND}" must implement FederationPeer`);
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

  async function createPost(text: string): Promise<string> {
    const response = await api('/api/posts/commit', { method: 'POST', body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error(`the post failed: ${response.status} ${await response.text()}`);
    const created = (await response.json()) as { post?: { id?: string } };
    const id = created.post?.id ?? '';
    assert.ok(id, 'the committed post must have an id');
    return id;
  }

  async function postView(id: string): Promise<{ reload_count: number; hidden: number; status: string }> {
    const response = await api(`/api/posts/${id}`);
    return (await response.json()) as { reload_count: number; hidden: number; status: string };
  }

  async function notifications(): Promise<Array<{ type: string; post_id: string }>> {
    const response = await api('/api/notifications');
    const body = (await response.json()) as { notifications?: Array<{ type: string; post_id: string }> };
    return body.notifications ?? [];
  }

  it('names the peer under test', () => {
    assert.ok(PEER_KIND, 'FLAXIA_FEDERATION_PEER must be set to run the federation suite');
    assert.equal(peer.name, PEER_KIND);
  });

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

  it('publishes the profile of a remote account', async () => {
    const peerAccount = await peer.account();
    const response = await fetch(
      `${BASE}/api/remote/actors/${encodeURIComponent(new URL(peer.origin).hostname)}/${encodeURIComponent(peerAccount.username)}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      actor?: { actor_url?: string; preferred_username?: string | null };
      posts?: Array<{ id: string }>;
    };
    assert.equal(body.actor?.preferred_username, peerAccount.username);
    assert.ok(body.actor?.actor_url?.startsWith(peer.origin), 'the profile names the actor of the peer');
    assert.ok((body.posts ?? []).length > 0, 'the notes of the peer are listed');
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

  it('records a Like and removes it again on Undo-Like', async () => {
    const postId = await createPost(`a post to like ${Date.now()}`);
    const note = `${BASE}/api/notes/${postId}`;
    const like = {
      id: `${remote.origin}/activities/like-${Date.now()}`,
      type: 'Like',
      actor: remote.actor.actorUrl,
      object: note,
      to: [`${BASE}/api/actors/${account.username}`],
    };
    const delivered = await remote.deliver(`${BASE}/api/inbox`, like);
    assert.equal(delivered.status, 202);

    const liked = await waitFor(
      async () => (await notifications()).some((item) => item.type === 'ap_like' && item.post_id === postId),
      30_000,
    );
    assert.ok(liked, 'the Like of a local post must notify its author');

    const undo = {
      id: `${remote.origin}/activities/undo-like-${Date.now()}`,
      type: 'Undo',
      actor: remote.actor.actorUrl,
      object: like,
      to: [`${BASE}/api/actors/${account.username}`],
    };
    const undone = await remote.deliver(`${BASE}/api/inbox`, undo);
    assert.equal(undone.status, 202);

    // The instance has no public view of remote like rows. A fresh Like after
    // the Undo is the observable proof that the row was actually removed: an
    // undelivered Undo would make the second Like a no-op.
    const before = (await notifications()).filter((item) => item.type === 'ap_like' && item.post_id === postId).length;
    await remote.deliver(`${BASE}/api/inbox`, { ...like, id: `${like.id}-again` });
    const reLiked = await waitFor(
      async () =>
        (await notifications()).filter((item) => item.type === 'ap_like' && item.post_id === postId).length > before,
      30_000,
    );
    assert.ok(reLiked, 'Undo-Like must remove the like so a new Like can be recorded');
  });

  it('records an Announce and removes it again on Undo-Announce', async () => {
    const postId = await createPost(`a post to announce ${Date.now()}`);
    const note = `${BASE}/api/notes/${postId}`;
    const announce = {
      id: `${remote.origin}/activities/announce-${Date.now()}`,
      type: 'Announce',
      actor: remote.actor.actorUrl,
      object: note,
      to: [`${BASE}/api/actors/${account.username}`],
    };
    const delivered = await remote.deliver(`${BASE}/api/inbox`, announce);
    assert.equal(delivered.status, 202);

    const announced = await waitFor(async () => (await postView(postId)).reload_count >= 1, 30_000);
    assert.ok(announced, 'the Announce must count as a reload of the local post');

    const undo = {
      id: `${remote.origin}/activities/undo-announce-${Date.now()}`,
      type: 'Undo',
      actor: remote.actor.actorUrl,
      object: announce,
      to: [`${BASE}/api/actors/${account.username}`],
    };
    const undone = await remote.deliver(`${BASE}/api/inbox`, undo);
    assert.equal(undone.status, 202);
    const removed = await waitFor(async () => (await postView(postId)).reload_count === 0, 30_000);
    assert.ok(removed, 'Undo-Announce must undo the reload count');
  });

  it('delivers a Delete of a local post as a Tombstone', async () => {
    // The remote instance must follow the author to receive the Delete.
    await remote.primeSenderKey(`${BASE}/api/actors/${account.username}`);
    const follow = await remote.deliver(`${BASE}/api/inbox`, {
      id: `${remote.origin}/activities/follow-for-delete-${Date.now()}`,
      type: 'Follow',
      actor: remote.actor.actorUrl,
      to: [`${BASE}/api/actors/${account.username}`],
      object: `${BASE}/api/actors/${account.username}`,
    });
    assert.equal(follow.status, 202);

    const postId = await createPost(`a post to delete ${Date.now()}`);
    const deleted = await api(`/api/posts/${postId}`, { method: 'DELETE' });
    assert.ok(deleted.ok, `the delete failed: ${await deleted.text()}`);

    const arrived = await waitFor(
      async () =>
        remote.deliveries.some(
          (delivery) =>
            delivery.activity.type === 'Delete' && JSON.stringify(delivery.activity.object).includes(postId),
        ),
      60_000,
    );
    assert.ok(arrived, 'the remote instance did not receive the Delete');
    const delivery = [...remote.deliveries]
      .reverse()
      .find((entry) => entry.activity.type === 'Delete' && JSON.stringify(entry.activity.object).includes(postId));
    assert.ok(delivery);
    assert.equal(delivery.signatureValid, true);
    const object = delivery.activity.object as Record<string, unknown>;
    assert.equal(object.type, 'Tombstone');
    assert.equal(object.formerType, 'Note');

    const expected = {
      type: 'Delete',
      hasId: true,
      hasActor: true,
      hasObject: true,
      objectIsString: false,
      objectType: 'Tombstone',
      hasTo: true,
      hasCc: true,
      addressedToPublic: true,
      undoneType: null,
      undoneObjectIsString: false,
    };
    const differences = diffShapes(activityShape(delivery.activity), expected);
    assert.deepEqual(differences, [], `the Delete activity differs:\n${formatDifferences(differences)}`);
  });

  it('hides a remote post when its author deletes it', async () => {
    // The local account follows the remote instance, so it accepts its notes.
    const followed = await api('/api/remote-follow', {
      method: 'POST',
      body: JSON.stringify({ target: remote.handle }),
    });
    if (!followed.ok) {
      // A previous scenario may already have established the relation.
      assert.equal(followed.status, 409, `the follow failed: ${await followed.text()}`);
    }

    const text = `a remote post to delete ${Date.now()}`;
    const noteId = `${remote.origin}/notes/delete-${Date.now()}`;
    // This scenario checks the guest feed, so the Note must really be public.
    // A Note addressed only to one actor is correctly stored as direct and is
    // deliberately absent from that feed.
    const created = await remote.deliver(`${BASE}/api/inbox`, {
      id: `${remote.origin}/activities/create-for-delete-${Date.now()}`,
      type: 'Create',
      actor: remote.actor.actorUrl,
      // A shared inbox needs a local addressee to route to, and the guest feed
      // needs the Public collection to treat the Note as public.
      to: [`${BASE}/api/actors/${account.username}`, PUBLIC_COLLECTION],
      object: { id: noteId, type: 'Note', attributedTo: remote.actor.actorUrl, content: text },
    });
    assert.equal(created.status, 202);

    const received = await waitFor(async () => (await posts()).some((post) => post.text.includes(text)), 60_000);
    assert.ok(received, 'the remote note did not arrive');
    const postId = (await posts()).find((post) => post.text.includes(text))?.id ?? '';
    assert.ok(postId);

    const removed = await remote.deliver(`${BASE}/api/inbox`, {
      id: `${remote.origin}/activities/delete-${Date.now()}`,
      type: 'Delete',
      actor: remote.actor.actorUrl,
      to: [`${BASE}/api/actors/${account.username}`, PUBLIC_COLLECTION],
      object: { id: noteId, type: 'Tombstone' },
    });
    assert.equal(removed.status, 202);
    const hidden = await waitFor(async () => (await api(`/api/posts/${postId}`)).status === 410, 30_000);
    assert.ok(hidden, 'a post deleted by its author must no longer be served');
  });
});
