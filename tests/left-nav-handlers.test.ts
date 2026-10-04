// createLeftNavHandlers: deps-driven nav callbacks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLeftNavHandlers } from '../src/lib/left-nav-handlers.ts';

const pushed: string[] = [];
(globalThis as unknown as Record<string, unknown>).window = {
  history: { pushState: (_s: unknown, _t: string, url: string) => pushed.push(url) },
};

function setup(username: string | null) {
  pushed.length = 0;
  const navigated: string[] = [];
  const handlers = createLeftNavHandlers({
    navigate: (view, _postId, uname) => {
      navigated.push(uname ? `${view}:${uname}` : view);
    },
    getCurrentUsername: () => username,
  });
  return { handlers, navigated };
}

describe('createLeftNavHandlers', () => {
  it('maps items to views and history entries', () => {
    const { handlers, navigated } = setup('alice');
    handlers.onNavigate('home');
    handlers.onNavigate('explore');
    handlers.onNavigate('arcade');
    handlers.onNavigate('notifications');
    handlers.onNavigate('bookmarks');
    handlers.onNavigate('settings');
    assert.deepEqual(navigated, ['timeline', 'explore', 'arcade', 'notifications', 'bookmarks', 'settings']);
    assert.deepEqual(pushed, ['/home', '/explore', '/arcade', '/notifications', '/bookmarks', '/settings']);
  });

  it('routes profile to the current user', () => {
    const { handlers, navigated } = setup('alice');
    handlers.onNavigate('profile');
    assert.deepEqual(navigated, ['profile:alice']);
    assert.deepEqual(pushed, ['/profile/alice']);
  });

  it('routes profile to arcade for guests', () => {
    const { handlers, navigated } = setup(null);
    handlers.onNavigate('profile');
    assert.deepEqual(navigated, ['arcade']);
    assert.deepEqual(pushed, ['/arcade']);
  });

  it('routes sign-in/up to auth pages', () => {
    const { handlers, navigated } = setup(null);
    handlers.onSignIn();
    handlers.onSignUp();
    assert.deepEqual(navigated, ['login', 'register']);
    assert.deepEqual(pushed, ['/login', '/register']);
  });
});
