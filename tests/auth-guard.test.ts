// resolveAuthRedirect / isPublicRoute: guest access decisions.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicRoute, resolveAuthRedirect } from '../src/lib/auth-guard.ts';

describe('isPublicRoute', () => {
  it('allows landing, explore, arcade, profiles, threads, legal, docs, auth', () => {
    for (const p of [
      '/',
      '/home',
      '/explore',
      '/search',
      '/arcade',
      '/arcade/game1',
      '/users/alice',
      '/profile/bob',
      '/thread/abc',
      '/terms',
      '/privacy',
      '/about',
      '/docs',
      '/docs/hello',
      '/login',
      '/register',
      '/verify-email',
      '/home/',
    ]) {
      assert.equal(isPublicRoute(p), true, p);
    }
  });

  it('protects app routes', () => {
    for (const p of ['/notifications', '/bookmarks', '/settings', '/admin', '/admin/users']) {
      assert.equal(isPublicRoute(p), false, p);
    }
  });
});

describe('resolveAuthRedirect', () => {
  it('returns null when allowed', () => {
    assert.equal(resolveAuthRedirect('/home', false), null);
    assert.equal(resolveAuthRedirect('/settings', true), null);
    assert.equal(resolveAuthRedirect('/notifications', true), null);
  });

  it('sends guests on /notifications to arcade', () => {
    assert.deepEqual(resolveAuthRedirect('/notifications', false), { path: '/arcade', view: 'arcade' });
  });

  it('sends guests on other protected routes to login', () => {
    assert.deepEqual(resolveAuthRedirect('/settings', false), { path: '/login', view: 'login' });
    assert.deepEqual(resolveAuthRedirect('/admin/users', false), { path: '/login', view: 'login' });
  });
});
