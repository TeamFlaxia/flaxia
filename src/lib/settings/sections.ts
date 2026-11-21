// Adapter around the legacy settings-page factory. Keeps the huge legacy DOM
// construction behind a .ts boundary while the route owns the Svelte shell.
import { createSettingsPage } from '../../components/SettingsPage.ts';

export type SettingsCategory = {
  id: string;
  titleKey: string;
  iconName: string;
  groupKey: string;
  descriptionKey: string;
};

export async function createSettingsSections(options: {
  currentUser?: Record<string, unknown> | null;
  initialCategory?: string | null;
}): Promise<{ categories: SettingsCategory[]; panels: HTMLElement[]; destroy: () => void }> {
  const handle = createSettingsPage(options as never);
  const root = handle.getElement();
  const panels = [...root.querySelectorAll<HTMLElement>('.settings-panel')];
  const categories: SettingsCategory[] = [...root.querySelectorAll<HTMLElement>('.settings-nav-item')].map((el, i) => ({
    id: el.dataset.category ?? String(i),
    titleKey: el.textContent?.trim() ?? '',
    iconName: 'settings',
    groupKey: 'settings.group_preferences',
    descriptionKey: 'settings.title',
  }));
  return { categories, panels, destroy: handle.destroy };
}
