// Settings composition root: category metadata lives in
// `src/lib/settings/categories.ts`; this adapter mounts the Svelte section for
// each category and exposes the panels the Svelte shell renders.
import { resolveSettingsCategorySpecs, type SettingsSectionId } from '../lib/settings/categories.ts';
import { mountSettingsSection } from '../lib/settings/section-host.ts';
import SettingsAccountSection from '../lib/svelte/SettingsAccountSection.svelte';
import SettingsBillingSection from '../lib/svelte/SettingsBillingSection.svelte';
import SettingsBugReportSection from '../lib/svelte/SettingsBugReportSection.svelte';
import SettingsCrowdSection from '../lib/svelte/SettingsCrowdSection.svelte';
import SettingsDisplaySection from '../lib/svelte/SettingsDisplaySection.svelte';
import SettingsEmailSection from '../lib/svelte/SettingsEmailSection.svelte';
import SettingsEmojiSection from '../lib/svelte/SettingsEmojiSection.svelte';
import SettingsLanguageSection from '../lib/svelte/SettingsLanguageSection.svelte';
import SettingsMapsSection from '../lib/svelte/SettingsMapsSection.svelte';
import SettingsPasswordSection from '../lib/svelte/SettingsPasswordSection.svelte';
import SettingsTitlesSection from '../lib/svelte/SettingsTitlesSection.svelte';
import SettingsVaultSection from '../lib/svelte/SettingsVaultSection.svelte';

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

type SettingsUser = NonNullable<SettingsPageProps['currentUser']>;
type MountedSection = { element: HTMLElement; destroy: () => void };

function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Capacitor?.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

/**
 * Section mount points. Categories only reference ids, so an id that is not
 * rendered (for example `billing` in the native app) is never mounted.
 */
const SECTION_MOUNTS: Record<SettingsSectionId, (currentUser?: SettingsUser) => MountedSection> = {
  account: (currentUser) => mountSettingsSection(SettingsAccountSection, { currentUser: currentUser as SettingsUser }),
  email: () => mountSettingsSection(SettingsEmailSection),
  password: (currentUser) => mountSettingsSection(SettingsPasswordSection, { currentUser: currentUser ?? null }),
  vault: () => mountSettingsSection(SettingsVaultSection),
  display: () => mountSettingsSection(SettingsDisplaySection),
  language: (currentUser) => mountSettingsSection(SettingsLanguageSection, { currentUser: currentUser ?? null }),
  emoji: () => mountSettingsSection(SettingsEmojiSection),
  titles: () => mountSettingsSection(SettingsTitlesSection),
  billing: () => mountSettingsSection(SettingsBillingSection),
  crowd: () => mountSettingsSection(SettingsCrowdSection),
  maps: () => mountSettingsSection(SettingsMapsSection),
  'bug-report': () => mountSettingsSection(SettingsBugReportSection),
};

/**
 * Build the settings section DOM. The Svelte shell owns the page chrome and
 * navigation; this adapter only produces the category content.
 */
export function loadSettingsCategories({ currentUser }: SettingsPageProps) {
  const specs = resolveSettingsCategorySpecs({
    signedIn: Boolean(currentUser),
    isCapacitorApp: isCapacitorNative(),
  });
  const mounted = new Map<SettingsSectionId, MountedSection>();

  const sectionFor = (id: SettingsSectionId): HTMLElement => {
    let section = mounted.get(id);
    if (!section) {
      section = SECTION_MOUNTS[id](currentUser);
      mounted.set(id, section);
    }
    return section.element;
  };

  const categories: SettingsCategory[] = specs.map((spec) => ({
    id: spec.id,
    groupKey: spec.groupKey,
    titleKey: spec.titleKey,
    descriptionKey: spec.descriptionKey,
    iconName: spec.iconName,
    sections: spec.sections.map(sectionFor),
  }));

  return {
    categories,
    destroy: () => {
      for (const section of mounted.values()) section.destroy();
      mounted.clear();
    },
  };
}
