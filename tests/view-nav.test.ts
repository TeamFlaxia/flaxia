// viewToBottomNavId: router view -> bottom-bar tab mapping.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewToBottomNavId } from '../src/lib/view-nav.ts';

describe('viewToBottomNavId', () => {
  it('maps timeline views to home', () => {
    assert.equal(viewToBottomNavId('timeline'), 'home');
    assert.equal(viewToBottomNavId('thread'), 'home');
  });

  it('maps discovery views to explore', () => {
    assert.equal(viewToBottomNavId('explore'), 'explore');
    assert.equal(viewToBottomNavId('search'), 'explore');
  });

  it('maps single views to their own tabs', () => {
    assert.equal(viewToBottomNavId('arcade'), 'arcade');
    assert.equal(viewToBottomNavId('notifications'), 'notifications');
  });

  it('maps account views to account', () => {
    assert.equal(viewToBottomNavId('profile'), 'account');
    assert.equal(viewToBottomNavId('settings'), 'account');
    assert.equal(viewToBottomNavId('bookmarks'), 'account');
  });

  it('returns empty for unknown views', () => {
    assert.equal(viewToBottomNavId('nope'), '');
  });
});
