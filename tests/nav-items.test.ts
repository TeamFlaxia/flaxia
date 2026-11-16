// Primary navigation model: guests get the public sections only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCOUNT_ONLY_NAV_IDS, navItemsFor } from '../src/lib/nav-items.ts';

const ids = (signedIn: boolean) => navItemsFor(signedIn).map((item) => item.id);

describe('navItemsFor', () => {
  it('starts every rail with home, explore and arcade', () => {
    assert.deepEqual(ids(false).slice(0, 3), ['home', 'explore', 'arcade']);
    assert.deepEqual(ids(true).slice(0, 3), ['home', 'explore', 'arcade']);
  });

  it('keeps account-only sections out of the guest rail', () => {
    const guest = ids(false);
    for (const accountOnly of ACCOUNT_ONLY_NAV_IDS) {
      assert.equal(guest.includes(accountOnly), false, `${accountOnly} leaked into the guest rail`);
    }
  });

  it('adds notifications and bookmarks once signed in', () => {
    assert.deepEqual(ids(true), ['home', 'explore', 'arcade', 'notifications', 'bookmarks']);
  });

  it('never returns duplicate ids', () => {
    for (const signedIn of [false, true]) {
      const list = ids(signedIn);
      assert.equal(new Set(list).size, list.length);
    }
  });
});
