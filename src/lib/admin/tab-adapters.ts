/**
 * Adapter for the legacy admin tab DOM.
 *
 * AdminView.svelte owns the layout (header, tab rail, content area). Each tab
 * still builds its own DOM, so keep those factory calls behind this .ts
 * boundary until the tab bodies are rewritten in Svelte.
 */

export type AdminTab = 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter';

export interface AdminTabHost {
  appendChild(node: HTMLElement): void;
}

export async function mountAdminTab(
  tab: AdminTab,
  host: AdminTabHost,
  onNavigateToTab: (tab: AdminTab) => void,
): Promise<() => void> {
  switch (tab) {
    case 'analytics': {
      const { createAdminAnalyticsTab } = await import('../../components/AdminAnalyticsTab.ts');
      host.appendChild(createAdminAnalyticsTab().getElement());
      return () => undefined;
    }
    case 'alerts': {
      const { createAdminAlertsTab } = await import('../../components/AdminAlertsTab.ts');
      const view = createAdminAlertsTab({ onNavigateToTab });
      host.appendChild(view.getElement());
      return () => view.destroy();
    }
    case 'hidden': {
      const { createAdminHiddenTab } = await import('../../components/AdminHiddenTab.ts');
      const view = createAdminHiddenTab({ onNavigateToTab });
      host.appendChild(view.getElement());
      return () => view.destroy();
    }
    case 'users': {
      const { createAdminUsersTab } = await import('../../components/AdminUsersTab.ts');
      const view = createAdminUsersTab({ onNavigateToTab });
      host.appendChild(view.getElement());
      return () => view.destroy();
    }
    case 'ads': {
      const { createAdminAdsTab } = await import('../../components/AdminAdsTab.ts');
      const view = createAdminAdsTab({ onNavigateToTab });
      host.appendChild(view.getElement());
      return () => view.destroy();
    }
    case 'counter': {
      const { createAdminCounterTab } = await import('../../components/AdminCounterTab.ts');
      const view = createAdminCounterTab({ onNavigateToTab });
      host.appendChild(view.getElement());
      return () => view.destroy();
    }
  }
}
