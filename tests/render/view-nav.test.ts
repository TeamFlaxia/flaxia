import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewToBottomNavId } from '../../src/lib/view-nav.ts';

describe('view-nav/bottom-tab mapping', () => {
  it('maps the tabbed views to their tab', () => {
    assert.equal(viewToBottomNavId('timeline'), 'home');
    assert.equal(viewToBottomNavId('thread'), 'home');
    assert.equal(viewToBottomNavId('explore'), 'explore');
    assert.equal(viewToBottomNavId('search'), 'explore');
    assert.equal(viewToBottomNavId('arcade'), 'arcade');
    assert.equal(viewToBottomNavId('notifications'), 'notifications');
    assert.equal(viewToBottomNavId('profile'), 'account');
    assert.equal(viewToBottomNavId('settings'), 'account');
    assert.equal(viewToBottomNavId('bookmarks'), 'account');
  });

  it('clears the tab for views that have no bottom-nav destination', () => {
    // Regression: returning a falsy id used to make main.ts skip the sync
    // entirely, so leaving Arcade for Maps kept "Arcade" highlighted.
    for (const view of [
      'maps',
      'translate',
      'mail',
      'mail-thread',
      'mail-compose',
      'mail-settings',
      'admin',
      'docs',
      'legal',
      'download',
      'login',
      'register',
      'not-a-view',
    ]) {
      assert.equal(viewToBottomNavId(view), '', `${view} must not own a tab`);
    }
  });
});
