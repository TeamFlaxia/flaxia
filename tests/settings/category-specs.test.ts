import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  groupSettingsCategories,
  isSettingsCategoryVisible,
  resolveSettingsCategorySpecs,
  SETTINGS_CATEGORY_SPECS,
  type SettingsCategorySpec,
} from '../../src/lib/settings/categories.ts';

const ids = (specs: readonly SettingsCategorySpec[]) => specs.map((spec) => spec.id);

describe('settings/category-specs', () => {
  it('lists every category once, in navigation order', () => {
    assert.deepEqual(ids(SETTINGS_CATEGORY_SPECS), [
      'account',
      'security',
      'appearance',
      'emoji',
      'titles',
      'billing',
      'crowd',
      'maps',
      'bug-report',
    ]);
    assert.equal(new Set(ids(SETTINGS_CATEGORY_SPECS)).size, SETTINGS_CATEGORY_SPECS.length);
  });

  it('keeps the metadata keys and icon names the settings shell renders', () => {
    const account = SETTINGS_CATEGORY_SPECS.find((spec) => spec.id === 'account');
    assert.ok(account);
    assert.equal(account.groupKey, 'settings.group_account');
    assert.equal(account.titleKey, 'settings.account');
    assert.equal(account.descriptionKey, 'settings.account_description');
    assert.equal(account.iconName, 'user');
    assert.deepEqual(account.sections, ['account', 'email']);

    const security = SETTINGS_CATEGORY_SPECS.find((spec) => spec.id === 'security');
    assert.ok(security);
    assert.deepEqual(security.sections, ['password', 'vault']);

    const appearance = SETTINGS_CATEGORY_SPECS.find((spec) => spec.id === 'appearance');
    assert.ok(appearance);
    assert.deepEqual(appearance.sections, ['display', 'language']);
    assert.equal(appearance.groupKey, 'settings.group_preferences');

    const bug = SETTINGS_CATEGORY_SPECS.find((spec) => spec.id === 'bug-report');
    assert.ok(bug);
    assert.equal(bug.groupKey, 'settings.group_other');
  });

  it('drops account-owned categories for guests', () => {
    const guest = resolveSettingsCategorySpecs({ signedIn: false });
    assert.deepEqual(ids(guest), ['appearance', 'crowd', 'maps', 'bug-report']);
  });

  it('keeps every category for signed-in web users', () => {
    assert.deepEqual(
      ids(resolveSettingsCategorySpecs({ signedIn: true, isCapacitorApp: false })),
      ids(SETTINGS_CATEGORY_SPECS),
    );
  });

  it('hides billing inside the Capacitor app, where Play Billing owns purchases', () => {
    const native = resolveSettingsCategorySpecs({ signedIn: true, isCapacitorApp: true });
    assert.deepEqual(ids(native), [
      'account',
      'security',
      'appearance',
      'emoji',
      'titles',
      'crowd',
      'maps',
      'bug-report',
    ]);
  });

  it('exposes visibility as a predicate', () => {
    const billing = SETTINGS_CATEGORY_SPECS.find((spec) => spec.id === 'billing');
    assert.ok(billing);
    assert.equal(isSettingsCategoryVisible(billing, { signedIn: false }), false);
    assert.equal(isSettingsCategoryVisible(billing, { signedIn: true, isCapacitorApp: false }), true);
    assert.equal(isSettingsCategoryVisible(billing, { signedIn: true, isCapacitorApp: true }), false);
  });

  it('groups categories under their group key without reordering', () => {
    const groups = groupSettingsCategories(SETTINGS_CATEGORY_SPECS);
    assert.deepEqual(
      groups.map((group) => [group.key, ids(group.items)]),
      [
        ['settings.group_account', ['account', 'security']],
        ['settings.group_preferences', ['appearance', 'emoji', 'titles', 'maps']],
        ['settings.group_more', ['billing', 'crowd']],
        ['settings.group_other', ['bug-report']],
      ],
    );
  });
});
