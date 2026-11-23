// Pure settings metadata: the navigation order, group, copy keys, icon and the
// sections each category hosts. Mounting stays in `src/components/SettingsPage.ts`
// so this module can be unit-tested without Svelte or a DOM.

export type SettingsCategoryId =
  | 'account'
  | 'security'
  | 'appearance'
  | 'emoji'
  | 'titles'
  | 'billing'
  | 'crowd'
  | 'maps'
  | 'bug-report';

export type SettingsSectionId =
  | 'account'
  | 'email'
  | 'password'
  | 'vault'
  | 'display'
  | 'language'
  | 'emoji'
  | 'titles'
  | 'billing'
  | 'crowd'
  | 'maps'
  | 'bug-report';

/**
 * `always` renders for guests too; `signed-in` needs an account; `signed-in-web`
 * is also hidden in the Capacitor app where the store owns billing.
 */
export type SettingsCategoryVisibility = 'always' | 'signed-in' | 'signed-in-web';

export interface SettingsCategorySpec {
  id: SettingsCategoryId;
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
  iconName: string;
  sections: readonly SettingsSectionId[];
  visibility: SettingsCategoryVisibility;
}

export interface SettingsCategoryAvailability {
  signedIn: boolean;
  isCapacitorApp?: boolean;
}

export const SETTINGS_CATEGORY_SPECS = [
  {
    id: 'account',
    groupKey: 'settings.group_account',
    titleKey: 'settings.account',
    descriptionKey: 'settings.account_description',
    iconName: 'user',
    sections: ['account', 'email'],
    visibility: 'signed-in',
  },
  {
    id: 'security',
    groupKey: 'settings.group_account',
    titleKey: 'settings.security',
    descriptionKey: 'settings.security_description',
    iconName: 'key',
    sections: ['password', 'vault'],
    visibility: 'signed-in',
  },
  {
    id: 'appearance',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.appearance',
    descriptionKey: 'settings.appearance_description',
    iconName: 'settings',
    sections: ['display', 'language'],
    visibility: 'always',
  },
  {
    id: 'emoji',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.custom_emoji',
    descriptionKey: 'settings.emoji_description',
    iconName: 'emoji',
    sections: ['emoji'],
    visibility: 'signed-in',
  },
  {
    id: 'titles',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.titles',
    descriptionKey: 'settings.titles_description',
    iconName: 'game',
    sections: ['titles'],
    visibility: 'signed-in',
  },
  {
    id: 'billing',
    groupKey: 'settings.group_more',
    titleKey: 'settings.billing',
    descriptionKey: 'settings.billing_description',
    iconName: 'fresh',
    sections: ['billing'],
    visibility: 'signed-in-web',
  },
  {
    id: 'crowd',
    groupKey: 'settings.group_more',
    titleKey: 'settings.crowd',
    descriptionKey: 'settings.crowd_description',
    iconName: 'poll',
    sections: ['crowd'],
    visibility: 'always',
  },
  {
    id: 'maps',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.maps',
    descriptionKey: 'settings.maps_description',
    iconName: 'maps',
    sections: ['maps'],
    visibility: 'always',
  },
  {
    id: 'bug-report',
    groupKey: 'settings.group_other',
    titleKey: 'settings.bug_report',
    descriptionKey: 'settings.bug_report_description',
    iconName: 'flag',
    sections: ['bug-report'],
    visibility: 'always',
  },
] as const satisfies readonly SettingsCategorySpec[];

export function isSettingsCategoryVisible(
  spec: SettingsCategorySpec,
  { signedIn, isCapacitorApp = false }: SettingsCategoryAvailability,
): boolean {
  if (spec.visibility === 'always') return true;
  if (!signedIn) return false;
  return spec.visibility !== 'signed-in-web' || !isCapacitorApp;
}

/** Categories available to this visitor, in the order the settings rail shows. */
export function resolveSettingsCategorySpecs(availability: SettingsCategoryAvailability): SettingsCategorySpec[] {
  return SETTINGS_CATEGORY_SPECS.filter((spec) => isSettingsCategoryVisible(spec, availability));
}

/** Group in first-seen order; a later category joins its existing group. */
export function groupSettingsCategories<T extends { groupKey: string }>(
  categories: readonly T[],
): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = [];
  for (const category of categories) {
    let group = groups.find((entry) => entry.key === category.groupKey);
    if (!group) {
      group = { key: category.groupKey, items: [] };
      groups.push(group);
    }
    group.items.push(category);
  }
  return groups;
}
