// Guards for the two federation shortcuts that must never run in production:
// direct (queue-less) delivery, and the legacy note/inbox URL spellings.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DeliveryEnv, isDirectDelivery } from '../functions/lib/activitypub/delivery.ts';
import { localPostIdFromNoteUrl } from '../functions/lib/activitypub/handlers.ts';
import { legacyRedirect } from '../src/hooks.server.ts';

function envFor(environment?: string, flag?: string): DeliveryEnv {
  return {
    DB: {} as DeliveryEnv['DB'],
    BASE_URL: 'https://flaxia.app',
    ENVIRONMENT: environment,
    AP_DIRECT_DELIVERY: flag,
  };
}

describe('AP_DIRECT_DELIVERY is limited to test and development', () => {
  for (const environment of ['test', 'development', 'TEST', 'Development']) {
    it(`honours the flag in ${environment}`, () => {
      assert.equal(isDirectDelivery(envFor(environment, '1')), true);
      assert.equal(isDirectDelivery(envFor(environment, 'true')), true);
      assert.equal(isDirectDelivery(envFor(environment, '0')), false);
    });
  }

  for (const environment of [undefined, '', 'production', 'PRODUCTION', 'staging']) {
    it(`ignores the flag in ${environment ?? 'unset'}`, () => {
      assert.equal(isDirectDelivery(envFor(environment, '1')), false);
      assert.equal(isDirectDelivery(envFor(environment, 'true')), false);
    });
  }
});

describe('inbound note references accept canonical URLs', () => {
  it('resolves both the legacy and the canonical path', () => {
    for (const path of ['/notes/post-1', '/api/notes/post-1']) {
      assert.equal(localPostIdFromNoteUrl(`https://flaxia.app${path}`, 'https://flaxia.app'), 'post-1');
    }
  });

  it('still rejects other origins and unrelated paths', () => {
    assert.equal(localPostIdFromNoteUrl('https://example.com/notes/post-1', 'https://flaxia.app'), null);
    assert.equal(localPostIdFromNoteUrl('https://flaxia.app/api/actors/alice', 'https://flaxia.app'), null);
    assert.equal(localPostIdFromNoteUrl('not a url', 'https://flaxia.app'), null);
  });
});

describe('legacy actor inbox URLs', () => {
  it('redirects both /users and /actors inbox paths', () => {
    for (const path of ['/users/alice/inbox', '/actors/alice/inbox']) {
      assert.deepEqual(legacyRedirect(path), { location: '/api/actors/alice/inbox', status: 308 });
    }
  });
});
