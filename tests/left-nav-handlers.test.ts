// leftNavCallbacks: deps-driven nav callbacks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leftNavCallbacks } from '../src/lib/left-nav-handlers.ts';

function setup(username: string | null) {
  const navigated: string[] = [];
  const handlers = leftNavCallbacks({
    navigate: (view, _postId, uname) => {
      navigated.push(uname ? `${view}:${uname}` : view);
    },
    getCurrentUsername: () => username,
  });
  return { handlers, navigated };
}

describe('leftNavCallbacks', () => {
  it('maps items to views and history entries', () => {
    const { handlers, navigated } = setup('alice');
    handlers.onNavigate('home');
    handlers.onNavigate('explore');
    handlers.onNavigate('arcade');
    handlers.onNavigate('notifications');
    handlers.onNavigate('bookmarks');
    handlers.onNavigate('settings');
    // The SPA router owns the URL; handlers only dispatch the view.
    assert.deepEqual(navigated, ['timeline', 'explore', 'arcade', 'notifications', 'bookmarks', 'settings']);
  });

  it('routes profile to the current user', () => {
    const { handlers, navigated } = setup('alice');
    handlers.onNavigate('profile');
    assert.deepEqual(navigated, ['profile:alice']);
  });

  it('routes profile to arcade for guests', () => {
    const { handlers, navigated } = setup(null);
    handlers.onNavigate('profile');
    assert.deepEqual(navigated, ['arcade']);
  });

  it('routes sign-in/up to auth pages', () => {
    const { handlers, navigated } = setup(null);
    handlers.onSignIn();
    handlers.onSignUp();
    assert.deepEqual(navigated, ['login', 'register']);
  });
});
