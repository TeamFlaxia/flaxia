import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAcceptActivity,
  buildAnnounceActivity,
  buildBlockActivity,
  buildDeleteActivity,
  buildFollowActivity,
  buildLikeActivity,
  buildRejectActivity,
  buildUndoActivity,
  buildUpdateActivity,
} from '../functions/lib/activitypub/activities.ts';
import { buildActorDocument, localActorUsername, parseWebfingerResource } from '../functions/lib/activitypub/actor.ts';
import { activityContentType, activityContext, PUBLIC_COLLECTION } from '../functions/lib/activitypub/context.ts';
import { audienceFor, buildCreateActivity, buildNoteObject } from '../functions/lib/activitypub/note.ts';
import { decodeHtmlEntities, extractHashtags, htmlToText, textToHtml } from '../functions/lib/activitypub/text.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const USER = { id: 'u1', username: 'alice', display_name: 'Alice' };
const FOLLOWERS = `${BASE}/api/actors/alice/followers`;

describe('ActivityPub text helpers', () => {
  it('strips remote markup and decodes entities', () => {
    const html = '<p>Hello &amp; welcome</p><script>alert(1)</script><p>bye</p>';
    assert.equal(htmlToText(html), 'Hello & welcome\nbye');
    assert.equal(decodeHtmlEntities('a &lt; b &#39;c&#39; &#x41;'), "a < b 'c' A");
  });

  it('escapes outbound text so remote markup can never be injected', () => {
    const html = textToHtml('<script>alert(1)</script> & "quotes"', BASE);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
  });

  it('extracts hashtags and mentions from plain text', () => {
    assert.deepEqual(extractHashtags('hello #flaxia and #日本語'), ['flaxia', '日本語']);
    assert.deepEqual(extractHashtags('#one #one'), ['one']);
  });
});

describe('ActivityPub audience mapping', () => {
  it('sends public posts to the public collection and cc the followers', () => {
    const audience = audienceFor('public', { followersUrl: FOLLOWERS });
    assert.deepEqual(audience.to, [PUBLIC_COLLECTION]);
    assert.deepEqual(audience.cc, [FOLLOWERS]);
  });

  it('sends unlisted posts to the followers and cc the public collection', () => {
    const audience = audienceFor('unlisted', { followersUrl: FOLLOWERS });
    assert.deepEqual(audience.to, [FOLLOWERS]);
    assert.deepEqual(audience.cc, [PUBLIC_COLLECTION]);
  });

  it('sends direct posts to the mentioned actors only', () => {
    const audience = audienceFor('direct', {
      followersUrl: FOLLOWERS,
      mentionUrls: ['https://remote.example/users/bob'],
    });
    assert.deepEqual(audience.to, ['https://remote.example/users/bob']);
    assert.deepEqual(audience.cc, []);
  });
});

describe('ActivityPub Note builder', () => {
  it('builds a Note with mention and hashtag tags', () => {
    const note = buildNoteObject(
      {
        id: 'post-1',
        text: 'hi @bob #flaxia',
        created_at: '2026-01-01T00:00:00.000Z',
        mentions: [{ username: 'bob', url: 'https://remote.example/users/bob' }],
      },
      USER,
      BASE,
      { followersUrl: FOLLOWERS },
    );

    assert.equal(note.type, 'Note');
    assert.equal(note.id, `${BASE}/api/notes/post-1`);
    assert.equal(note.attributedTo, `${BASE}/api/actors/alice`);
    assert.deepEqual(note.to, [PUBLIC_COLLECTION]);
    assert.deepEqual(note.cc, [FOLLOWERS, 'https://remote.example/users/bob']);
    assert.ok(note.content.includes('href="https://remote.example/users/bob"'));

    const tags = note.tag ?? [];
    assert.ok(tags.some((tag) => tag.type === 'Mention' && tag.href === 'https://remote.example/users/bob'));
    assert.ok(tags.some((tag) => tag.type === 'Hashtag' && tag.name === '#flaxia'));
  });

  it('links a reply to its parent', () => {
    const note = buildNoteObject(
      { id: 'post-2', text: 'reply', created_at: '2026-01-01T00:00:00.000Z', parent_id: 'post-1' },
      USER,
      BASE,
      { followersUrl: FOLLOWERS },
    );
    assert.equal(note.inReplyTo, `${BASE}/api/notes/post-1`);
    assert.ok(note.replies);
  });

  it('wraps a Note in a Create activity', () => {
    const note = buildNoteObject({ id: 'post-3', text: 'hello', created_at: '2026-01-01T00:00:00.000Z' }, USER, BASE, {
      followersUrl: FOLLOWERS,
    });
    const activity = buildCreateActivity(note, USER, BASE);
    assert.equal(activity.type, 'Create');
    assert.equal(activity.id, `${BASE}/activities/create-post-3`);
    assert.equal(activity.actor, `${BASE}/api/actors/alice`);
    assert.deepEqual(activity.to, [PUBLIC_COLLECTION]);
    // The Create must not be timestamped at outbox-request time.
    assert.equal(activity.published, note.published);
  });
});

describe('ActivityPub activity builders', () => {
  const FOLLOW = {
    id: `${BASE}/activities/follow-remote-1`,
    type: 'Follow',
    actor: `${REMOTE}/users/bob`,
    object: `${BASE}/api/actors/alice`,
  };

  it('builds a Follow addressed only to its target', () => {
    const activity = buildFollowActivity(BASE, 'alice', `${REMOTE}/users/bob`, 'remote-1');
    assert.deepEqual(activity['@context'], activityContext());
    assert.equal(activity.id, `${BASE}/activities/follow-remote-1`);
    assert.equal(activity.type, 'Follow');
    assert.equal(activity.actor, `${BASE}/api/actors/alice`);
    assert.equal(activity.object, `${REMOTE}/users/bob`);
    assert.deepEqual(activity.to, [`${REMOTE}/users/bob`]);
    assert.equal(activity.cc, undefined);
  });

  it('wraps the original Follow in Accept and Reject, addressed to its actor', () => {
    for (const [type, build] of [
      ['Accept', buildAcceptActivity],
      ['Reject', buildRejectActivity],
    ] as const) {
      const activity = build(BASE, 'alice', FOLLOW, `${type.toLowerCase()}-1`);
      assert.deepEqual(activity['@context'], activityContext());
      assert.equal(activity.id, `${BASE}/activities/${type.toLowerCase()}-${type.toLowerCase()}-1`);
      assert.equal(activity.type, type);
      assert.equal(activity.actor, `${BASE}/api/actors/alice`);
      assert.deepEqual(activity.object, FOLLOW);
      assert.deepEqual(activity.to, [`${REMOTE}/users/bob`]);
    }
  });

  it('builds a Like and an Announce with the requested audience', () => {
    const object = `${REMOTE}/notes/1`;
    const like = buildLikeActivity(BASE, 'alice', object, 'like-1', { cc: [FOLLOWERS] });
    assert.equal(like.id, `${BASE}/activities/like-like-1`);
    assert.equal(like.type, 'Like');
    assert.equal(like.actor, `${BASE}/api/actors/alice`);
    assert.equal(like.object, object);
    assert.deepEqual(like.to, [object]);
    assert.deepEqual(like.cc, [FOLLOWERS]);
    assert.deepEqual(like['@context'], activityContext());

    const announce = buildAnnounceActivity(BASE, 'alice', object, 'announce-1', { to: [PUBLIC_COLLECTION] });
    assert.equal(announce.id, `${BASE}/activities/announce-announce-1`);
    assert.equal(announce.type, 'Announce');
    assert.equal(announce.actor, `${BASE}/api/actors/alice`);
    assert.equal(announce.object, object);
    assert.deepEqual(announce.to, [PUBLIC_COLLECTION]);
    assert.deepEqual(announce.cc, []);
    assert.equal(typeof announce.published, 'string');
    assert.deepEqual(announce['@context'], activityContext());
  });

  it('wraps the retracted activity in an Undo addressed to its object', () => {
    const like = buildLikeActivity(BASE, 'alice', `${REMOTE}/notes/1`, 'like-1');
    const undo = buildUndoActivity(BASE, 'alice', like, 'undo-1');
    assert.deepEqual(undo['@context'], activityContext());
    assert.equal(undo.id, `${BASE}/activities/undo-undo-1`);
    assert.equal(undo.type, 'Undo');
    assert.equal(undo.actor, `${BASE}/api/actors/alice`);
    assert.deepEqual(undo.object, like);
    // The target of the retracted activity is the address of the Undo.
    assert.deepEqual(undo.to, [`${REMOTE}/notes/1`]);
    assert.deepEqual(undo.cc, []);
  });

  it('builds a Delete as a Tombstone that names the former type', () => {
    const activity = buildDeleteActivity(BASE, 'alice', `${BASE}/api/notes/post-1`, 'delete-1', { cc: [FOLLOWERS] });
    assert.deepEqual(activity['@context'], activityContext());
    assert.equal(activity.id, `${BASE}/activities/delete-delete-1`);
    assert.equal(activity.type, 'Delete');
    assert.equal(activity.actor, `${BASE}/api/actors/alice`);
    assert.deepEqual(activity.object, {
      id: `${BASE}/api/notes/post-1`,
      type: 'Tombstone',
      formerType: 'Note',
    });
    assert.deepEqual(activity.to, [PUBLIC_COLLECTION]);
    assert.deepEqual(activity.cc, [FOLLOWERS]);
  });

  it('builds an Update of the actor document', () => {
    const profile = { id: `${BASE}/api/actors/alice`, type: 'Person', name: 'Alice Renamed' };
    const activity = buildUpdateActivity(BASE, 'alice', profile, 'update-1');
    assert.deepEqual(activity['@context'], activityContext());
    assert.equal(activity.id, `${BASE}/activities/update-update-1`);
    assert.equal(activity.type, 'Update');
    assert.equal(activity.actor, `${BASE}/api/actors/alice`);
    assert.deepEqual(activity.object, profile);
    assert.deepEqual(activity.to, [PUBLIC_COLLECTION]);
    assert.deepEqual(activity.cc, []);
  });

  it('builds a Block addressed to the blocked actor', () => {
    const activity = buildBlockActivity(BASE, 'alice', `${REMOTE}/users/mallory`, 'block-1');
    assert.deepEqual(activity['@context'], activityContext());
    assert.equal(activity.id, `${BASE}/activities/block-block-1`);
    assert.equal(activity.type, 'Block');
    assert.equal(activity.actor, `${BASE}/api/actors/alice`);
    assert.equal(activity.object, `${REMOTE}/users/mallory`);
    assert.deepEqual(activity.to, [`${REMOTE}/users/mallory`]);
  });
});

describe('ActivityPub actor helpers', () => {
  it('resolves local actor usernames from both actor URL spellings', () => {
    assert.equal(localActorUsername(`${BASE}/api/actors/alice`, BASE), 'alice');
    assert.equal(localActorUsername(`${BASE}/actors/alice`, BASE), 'alice');
    assert.equal(localActorUsername('https://evil.example/api/actors/alice', BASE), null);
    assert.equal(localActorUsername('https://flaxia.app@evil.example/api/actors/alice', BASE), null);
    assert.equal(localActorUsername(`${BASE}/api/users/alice`, BASE), null);
    assert.equal(localActorUsername(undefined, BASE), null);
  });

  it('parses acct: and URL WebFinger resources of this instance', () => {
    assert.deepEqual(parseWebfingerResource('acct:alice@flaxia.app', BASE), { username: 'alice' });
    assert.deepEqual(parseWebfingerResource(`https://flaxia.app/users/alice`, BASE), { username: 'alice' });
    assert.deepEqual(parseWebfingerResource(`https://flaxia.app/@alice`, BASE), null);
    assert.equal(parseWebfingerResource('acct:alice@other.example', BASE), null);
    assert.equal(parseWebfingerResource('not a resource', BASE), null);
  });

  it('publishes an actor document with every property a peer needs', () => {
    const document = buildActorDocument({
      baseUrl: BASE,
      user: { username: 'alice', display_name: 'Alice', bio: 'hi', avatar_key: null },
      publicKeyPem: '-----BEGIN PUBLIC KEY-----',
    });

    assert.equal(document.type, 'Person');
    assert.equal(document.id, `${BASE}/api/actors/alice`);
    assert.equal(document.inbox, `${BASE}/api/actors/alice/inbox`);
    assert.equal(document.outbox, `${BASE}/api/actors/alice/outbox`);
    assert.equal(document.followers, `${BASE}/api/actors/alice/followers`);
    assert.equal(document.following, `${BASE}/api/actors/alice/following`);
    assert.equal(document.liked, `${BASE}/api/actors/alice/liked`);
    assert.equal(document.featured, `${BASE}/api/actors/alice/featured`);
    assert.equal(document.manuallyApprovesFollowers, false);
    assert.equal(document.discoverable, true);
    assert.deepEqual((document as { endpoints: { sharedInbox: string } }).endpoints.sharedInbox, `${BASE}/api/inbox`);
    assert.equal(
      (document as { publicKey: { id: string; publicKeyPem: string } }).publicKey.id,
      `${BASE}/api/actors/alice#main-key`,
    );
  });
});

describe('ActivityPub content negotiation', () => {
  it('answers with activity+json unless the peer asks only for ld+json', () => {
    assert.equal(activityContentType('application/activity+json, application/ld+json'), 'application/activity+json');
    assert.equal(
      activityContentType('application/ld+json'),
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    );
    assert.equal(activityContentType(null), 'application/activity+json');
  });
});
