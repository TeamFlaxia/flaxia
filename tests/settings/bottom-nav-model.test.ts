import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOTTOM_NAV_ITEMS, bottomNavAvatarKey, bottomNavInitial } from '../../src/lib/svelte/bottom-nav-model.ts';

describe('svelte/bottom-nav-model', () => {
  it('keeps the four fixed tabs in order', () => {
    assert.deepEqual(
      BOTTOM_NAV_ITEMS.map((item) => [item.id, item.labelKey, item.iconName]),
      [
        ['home', 'nav.home', 'home'],
        ['explore', 'nav.explore', 'search'],
        ['arcade', 'nav.arcade', 'game'],
        ['notifications', 'nav.notifications', 'notifications'],
      ],
    );
  });

  it('accepts only the server avatar key shape', () => {
    assert.equal(bottomNavAvatarKey('avatar/abc123'), 'avatar/abc123');
    assert.equal(bottomNavAvatarKey('avatar/ABC_def-9'), 'avatar/ABC_def-9');
    assert.equal(bottomNavAvatarKey('avatar/../../etc/passwd'), null);
    assert.equal(bottomNavAvatarKey('avatar/a"b'), null);
    assert.equal(bottomNavAvatarKey(''), null);
    assert.equal(bottomNavAvatarKey(null), null);
  });

  it('renders the first grapheme upper-cased for the initial avatar', () => {
    assert.equal(bottomNavInitial('alice'), 'A');
    assert.equal(bottomNavInitial('😀 friend'), '😀');
    assert.equal(bottomNavInitial(''), '?');
    assert.equal(bottomNavInitial(undefined), '?');
  });
});
