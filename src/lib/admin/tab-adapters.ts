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

/** Mount host for Svelte tab bodies that have already been migrated. */
type SvelteTabHost = HTMLElement;

export async function mountAdminTab(
  tab: AdminTab,
  host: AdminTabHost,
  onNavigateToTab: (tab: AdminTab) => void,
): Promise<() => void> {
  switch (tab) {
    case 'analytics': {
      const [{ default: AdminAnalyticsTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminAnalyticsTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminAnalyticsTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
    case 'alerts': {
      const [{ default: AdminAlertsTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminAlertsTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminAlertsTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
    case 'hidden': {
      const [{ default: AdminHiddenTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminHiddenTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminHiddenTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
    case 'users': {
      const [{ default: AdminUsersTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminUsersTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminUsersTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
    case 'ads': {
      const [{ default: AdminAdsTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminAdsTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminAdsTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
    case 'counter': {
      const [{ default: AdminCounterTab }, { mount, unmount }] = await Promise.all([
        import('../svelte/AdminCounterTab.svelte'),
        import('svelte'),
      ]);
      const component = mount(AdminCounterTab, { target: host as SvelteTabHost });
      return () => {
        void unmount(component);
      };
    }
  }
}
