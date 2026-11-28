import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audienceEntries, isPublicAddress, PUBLIC_COLLECTION } from '../functions/lib/activitypub/context.ts';
import { visibilityFromInboundAudience } from '../functions/lib/activitypub/handlers.ts';
import { legacyRedirect } from '../src/hooks.server.ts';

const ACTOR = 'https://remote.example/users/alice';
const FOLLOWERS = `${ACTOR}/followers`;

describe('ActivityPub public address aliases', () => {
  it('normalizes the three public spellings and both audience shapes', () => {
    for (const value of [
      PUBLIC_COLLECTION,
      'Public',
      'as:Public',
      { id: 'as:Public' },
      { href: 'Public' },
      { id: 'https://unrelated.example/', href: PUBLIC_COLLECTION },
      [FOLLOWERS, { id: 'as:Public' }],
    ]) {
      assert.equal(isPublicAddress(value), true, `must treat ${JSON.stringify(value)} as public`);
    }
    for (const value of [FOLLOWERS, 'public', 'https://www.w3.org/ns/activitystreams#People', null, 42]) {
      assert.equal(isPublicAddress(value), false, `must not treat ${JSON.stringify(value)} as public`);
    }
  });

  it('extracts ids and hrefs from string, Object and Link audience entries', () => {
    assert.deepEqual(audienceEntries('https://remote.example/users/bob'), ['https://remote.example/users/bob']);
    assert.deepEqual(
      audienceEntries([
        { id: ACTOR, type: 'Person' },
        { href: FOLLOWERS, type: 'Link' },
        'https://remote.example/users/carol',
        { id: ACTOR },
        { href: 42 },
        null,
      ]),
      [ACTOR, FOLLOWERS, 'https://remote.example/users/carol'],
    );
    assert.deepEqual(audienceEntries(undefined), []);
  });

  it('maps public aliases on the Create and/or Note to public/unlisted', () => {
    assert.equal(visibilityFromInboundAudience({ to: ['as:Public'] }, {}, ACTOR), 'public');
    assert.equal(visibilityFromInboundAudience({}, { to: [{ id: 'Public' }] }, ACTOR), 'public');
    assert.equal(visibilityFromInboundAudience({ cc: [{ href: 'as:Public' }] }, {}, ACTOR), 'unlisted');
  });

  it('maps only the signing actor’s followers collection to private', () => {
    assert.equal(visibilityFromInboundAudience({ to: [FOLLOWERS] }, {}, ACTOR), 'private');
    assert.equal(visibilityFromInboundAudience({ to: [`${FOLLOWERS}/?page=1`] }, {}, ACTOR), 'private');
    assert.equal(
      visibilityFromInboundAudience({ to: ['https://other.example/users/bob/followers'] }, {}, ACTOR),
      'direct',
      'a third party followers collection must not be mistaken for ours',
    );
  });

  it('never lets bto/bcc/audience widen a private delivery to public', () => {
    const onlyHidden = { bto: [PUBLIC_COLLECTION], bcc: ['as:Public'], audience: [{ href: 'Public' }] };
    assert.equal(visibilityFromInboundAudience(onlyHidden, {}, ACTOR), 'direct');
    assert.equal(visibilityFromInboundAudience({ to: [FOLLOWERS], cc: [], ...onlyHidden }, {}, ACTOR), 'private');
  });

  it('does not redirect a personal inbox through the handle hook', () => {
    // A 308 would make peers recompute (request-target) for /api/... and reject
    // the HTTP Signature. SvelteKit serves the legacy path directly instead.
    assert.equal(legacyRedirect('/actors/alice/inbox'), null);
    assert.equal(legacyRedirect('/users/alice/inbox'), null);
    assert.deepEqual(legacyRedirect('/actors/alice/outbox'), {
      location: '/api/actors/alice/outbox',
      status: 301,
    });
  });
});
