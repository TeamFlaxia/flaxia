import { mountSettingsSection } from '../lib/settings/section-host.ts';
import SettingsAccountSection from '../lib/svelte/SettingsAccountSection.svelte';
import SettingsBillingSection from '../lib/svelte/SettingsBillingSection.svelte';
import SettingsCrowdSection from '../lib/svelte/SettingsCrowdSection.svelte';
import SettingsDisplaySection from '../lib/svelte/SettingsDisplaySection.svelte';
import SettingsEmailSection from '../lib/svelte/SettingsEmailSection.svelte';
import SettingsEmojiSection from '../lib/svelte/SettingsEmojiSection.svelte';
import SettingsLanguageSection from '../lib/svelte/SettingsLanguageSection.svelte';
import SettingsMapsSection from '../lib/svelte/SettingsMapsSection.svelte';
import SettingsPasswordSection from '../lib/svelte/SettingsPasswordSection.svelte';
import SettingsTitlesSection from '../lib/svelte/SettingsTitlesSection.svelte';
import { createBugReportForm } from './BugReportForm.js';
import { createVaultSection } from './VaultSection.js';

export interface SettingsPageProps {
  initialCategory?: string | null;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
    language?: string;
    email?: string;
  };
}

export interface SettingsCategory {
  id: string;
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
  iconName: string;
  sections: HTMLElement[];
}

/**
 * Build the settings section DOM. The Svelte shell owns the page chrome and
 * navigation; this adapter only produces the category content.
 */
export function loadSettingsCategories({ currentUser }: SettingsPageProps) {
  const categories: SettingsCategory[] = [];
  const addCategory = (category: SettingsCategory) => categories.push(category);
  const bugReportForm = createBugReportForm();

  // Account section (Svelte).
  const accountMount = currentUser ? mountSettingsSection(SettingsAccountSection, { currentUser }) : null;
  const accountSection = accountMount?.element;

  // Display section (Svelte): reply style, NSFW, data saver and theme.
  const displayMount = mountSettingsSection(SettingsDisplaySection);
  const displaySection = displayMount.element;

  // Crowd section (Svelte): opt in/out of donating browser compute.
  const crowdMount = mountSettingsSection(SettingsCrowdSection);
  const crowdSection = crowdMount.element;

  // Language section (Svelte).
  const languageMount = mountSettingsSection(SettingsLanguageSection, { currentUser });
  const languageSection = languageMount.element;

  // Email section (Svelte).
  const emailMount = mountSettingsSection(SettingsEmailSection);
  const emailSection = emailMount.element;

  // Password section (Svelte).
  const passwordMount = mountSettingsSection(SettingsPasswordSection, { currentUser });
  const passwordSection = passwordMount.element;

  // ─── Personal Vault Section ──────────────────────────────────────────────
  // Own component: it has three states of its own (setup / locked / unlocked)
  // and timers to clean up, which would drown the settings page otherwise.
  const vaultSection = currentUser ? createVaultSection() : null;

  // Titles section (Svelte).
  const titlesMount = currentUser ? mountSettingsSection(SettingsTitlesSection) : null;
  const titlesSection = titlesMount?.element;

  // Custom emoji section (Svelte): stamp grid and add/delete flows.
  const emojiMount = currentUser ? mountSettingsSection(SettingsEmojiSection) : null;
  const emojiSection = emojiMount?.element;

  // Billing section (Svelte): web-only; Play-distributed builds use Play Billing.
  const isCapacitorApp =
    typeof window !== 'undefined' &&
    typeof window.Capacitor?.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
  const billingMount = currentUser && !isCapacitorApp ? mountSettingsSection(SettingsBillingSection) : null;
  const billingSection = billingMount?.element;

  // Maps section (Svelte): on-device tile cache + city tile packs.
  const mapsMount = mountSettingsSection(SettingsMapsSection);
  const mapsSection = mapsMount.element;

  if (accountSection) {
    addCategory({
      id: 'account',
      groupKey: 'settings.group_account',
      titleKey: 'settings.account',
      descriptionKey: 'settings.account_description',
      iconName: 'user',
      sections: [accountSection, emailSection],
    });
  }
  if (vaultSection) {
    addCategory({
      id: 'security',
      groupKey: 'settings.group_account',
      titleKey: 'settings.security',
      descriptionKey: 'settings.security_description',
      iconName: 'key',
      sections: [passwordSection, vaultSection.getElement()],
    });
  }
  addCategory({
    id: 'appearance',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.appearance',
    descriptionKey: 'settings.appearance_description',
    iconName: 'settings',
    sections: [displaySection, languageSection],
  });
  if (emojiSection) {
    addCategory({
      id: 'emoji',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.custom_emoji',
      descriptionKey: 'settings.emoji_description',
      iconName: 'emoji',
      sections: [emojiSection],
    });
  }
  if (titlesSection) {
    addCategory({
      id: 'titles',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.titles',
      descriptionKey: 'settings.titles_description',
      iconName: 'game',
      sections: [titlesSection],
    });
  }
  if (billingSection) {
    addCategory({
      id: 'billing',
      groupKey: 'settings.group_more',
      titleKey: 'settings.billing',
      descriptionKey: 'settings.billing_description',
      iconName: 'fresh',
      sections: [billingSection],
    });
  }
  addCategory({
    id: 'crowd',
    groupKey: 'settings.group_more',
    titleKey: 'settings.crowd',
    descriptionKey: 'settings.crowd_description',
    iconName: 'poll',
    sections: [crowdSection],
  });
  addCategory({
    id: 'maps',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.maps',
    descriptionKey: 'settings.maps_description',
    iconName: 'maps',
    sections: [mapsSection],
  });
  addCategory({
    id: 'bug-report',
    groupKey: 'settings.group_other',
    titleKey: 'settings.bug_report',
    descriptionKey: 'settings.bug_report_description',
    iconName: 'flag',
    sections: [bugReportForm.getElement()],
  });
  return {
    categories,
    destroy: () => {
      titlesMount?.destroy();
      emojiMount?.destroy();
      billingMount?.destroy();
      vaultSection?.destroy();
      bugReportForm.destroy();
      mapsMount.destroy();
      crowdMount.destroy();
      accountMount?.destroy();
      emailMount.destroy();
      passwordMount.destroy();
      displayMount.destroy();
      languageMount.destroy();
    },
  };
}
