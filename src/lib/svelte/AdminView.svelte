<script lang="ts">
import { onMount } from 'svelte';

type AdminTab = 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter';
let { tab }: { tab: AdminTab } = $props();
let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { createAdminLayout } = await import('../../components/AdminLayout.ts');
    const layout = createAdminLayout({
      activeTab: tab,
      onTabChange: (next: AdminTab) => window.location.assign(`/admin/${next}`),
    });
    host.appendChild(layout.getElement());
    dispose = layout.destroy;

    const access = await fetch('/api/admin/access', { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (!access?.ok) {
      layout.setAccessDenied();
      return;
    }

    const tabDisposers: Array<() => void> = [];
    const previousDispose = dispose;
    dispose = () => {
      tabDisposers.forEach((fn) => {
        fn();
      });
      previousDispose();
    };
    const show = (element: HTMLElement, destroy?: () => void) => {
      layout.updateMainContent(element);
      if (destroy) tabDisposers.push(destroy);
    };

    if (tab === 'analytics') {
      const { createAdminAnalyticsTab } = await import('../../components/AdminAnalyticsTab.ts');
      show(createAdminAnalyticsTab().getElement());
    } else if (tab === 'alerts') {
      const { createAdminAlertsTab } = await import('../../components/AdminAlertsTab.ts');
      const t = createAdminAlertsTab({ onNavigateToTab: (next: AdminTab) => window.location.assign(`/admin/${next}`) });
      show(t.getElement(), t.destroy);
    } else if (tab === 'hidden') {
      const { createAdminHiddenTab } = await import('../../components/AdminHiddenTab.ts');
      const t = createAdminHiddenTab({ onNavigateToTab: (next: AdminTab) => window.location.assign(`/admin/${next}`) });
      show(t.getElement(), t.destroy);
    } else if (tab === 'users') {
      const { createAdminUsersTab } = await import('../../components/AdminUsersTab.ts');
      const t = createAdminUsersTab({ onNavigateToTab: (next: AdminTab) => window.location.assign(`/admin/${next}`) });
      show(t.getElement(), t.destroy);
    } else if (tab === 'ads') {
      const { createAdminAdsTab } = await import('../../components/AdminAdsTab.ts');
      const t = createAdminAdsTab({ onNavigateToTab: (next: AdminTab) => window.location.assign(`/admin/${next}`) });
      show(t.getElement(), t.destroy);
    } else {
      const { createAdminCounterTab } = await import('../../components/AdminCounterTab.ts');
      const t = createAdminCounterTab({
        onNavigateToTab: (next: AdminTab) => window.location.assign(`/admin/${next}`),
      });
      show(t.getElement(), t.destroy);
    }
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
