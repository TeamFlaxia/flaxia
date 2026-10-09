// parseRoute: URL -> route mapping (pure, no browser needed).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRoute } from '../src/lib/router.ts';

describe('parseRoute', () => {
  it('maps auth and legal pages', () => {
    assert.equal(parseRoute('/login', '')?.view, 'login');
    assert.equal(parseRoute('/register', '')?.view, 'register');
    assert.equal(parseRoute('/verify-email', '?token=secret')?.view, 'verify-email');
    assert.equal(parseRoute('/terms', '')?.view, 'terms');
    assert.equal(parseRoute('/privacy', '')?.view, 'privacy');
    assert.equal(parseRoute('/about', '')?.view, 'about');
  });

  it('maps home and root to timeline', () => {
    assert.equal(parseRoute('/home', '')?.view, 'timeline');
    assert.equal(parseRoute('/', '')?.view, 'timeline');
    assert.equal(parseRoute('/nope', '')?.view, 'timeline');
  });

  it('parses thread, profile, and arcade routes', () => {
    assert.deepEqual(parseRoute('/thread/abc', ''), {
      view: 'thread',
      postId: 'abc',
      username: null,
      tag: null,
    });
    assert.equal(parseRoute('/users/alice', '')?.username, 'alice');
    assert.equal(parseRoute('/profile/bob', '')?.username, 'bob');
    assert.equal(parseRoute('/arcade/game1', '')?.postId, 'game1');
    assert.equal(parseRoute('/arcade', '')?.view, 'arcade');
  });

  it('parses explore tag and search query from the query string', () => {
    assert.equal(parseRoute('/explore', '?tag=cats')?.tag, 'cats');
    const search = parseRoute('/search', '?q=hello&type=users');
    assert.equal(search?.searchQuery, 'hello');
    assert.equal(search?.searchType, 'users');
  });

  it('parses admin tabs with alerts as default', () => {
    assert.equal(parseRoute('/admin', '')?.adminTab, 'alerts');
    assert.equal(parseRoute('/admin/users', '')?.adminTab, 'users');
  });

  it('returns null for sandbox routes', () => {
    assert.equal(parseRoute('/sandbox/post/abc', ''), null);
  });

  it('parses docs slugs and billing routes', () => {
    assert.equal(parseRoute('/docs/hello', '')?.postId, 'hello');
    assert.equal(parseRoute('/billing/success', '')?.view, 'billing-success');
    assert.equal(parseRoute('/billing/canceled', '')?.view, 'billing-canceled');
  });
});
