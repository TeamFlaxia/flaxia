<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { AdminTab } from '../admin/tab-adapters.ts';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';

let { tab }: { tab: AdminTab } = $props();

const tabs: Array<{ id: AdminTab; labelKey: string }> = [
  { id: 'analytics', labelKey: 'admin_analytics.title' },
  { id: 'alerts', labelKey: 'admin_layout.tab_alerts' },
  { id: 'counter', labelKey: 'admin_layout.tab_counter' },
  { id: 'hidden', labelKey: 'admin_layout.tab_hidden' },
  { id: 'users', labelKey: 'admin_layout.tab_users' },
  { id: 'ads', labelKey: 'admin_layout.tab_ads' },
];

let contentHost: HTMLDivElement;
let denied = $state(false);

onMount(() => {
  let cancelled = false;
  let disposeTab = () => undefined;
  void (async () => {
    const access = await fetch('/api/admin/access', { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (cancelled) return;
    if (!access?.ok) {
      denied = true;
      return;
    }
    const { mountAdminTab } = await import('../admin/tab-adapters.ts');
    if (cancelled || !contentHost) return;
    const dispose = await mountAdminTab(tab, contentHost, (next) => void navigate(`/admin/${next}`));
    if (cancelled) {
      dispose();
      return;
    }
    disposeTab = dispose;
  })();
  return () => {
    cancelled = true;
    disposeTab();
  };
});
</script>

<div class="admin-layout">
  <div class="admin-header">
    <div class="admin-logo"><a href="/home">{t('admin_layout.title')}</a></div>
    <a class="admin-back" href="/home">{t('admin_layout.back')}</a>
  </div>
  <div class="admin-body">
    <div class="admin-sidebar">
      {#each tabs as item (item.id)}
        <button
          type="button"
          class="admin-tab"
          class:admin-tab--active={tab === item.id}
          onclick={() => void navigate(`/admin/${item.id}`)}
        >
          {t(item.labelKey)}
        </button>
      {/each}
    </div>
    <div class="admin-main" bind:this={contentHost}>
      {#if denied}
        <div class="admin-denied">{@html t('admin_layout.access_denied')}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .admin-layout {
    min-height: 100vh;
    background: #0f172a;
    color: #f1f5f9;
    font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .admin-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid #1e293b;
  }

  .admin-logo a {
    color: #22c55e;
    text-decoration: none;
    font-size: 20px;
    font-weight: 600;
  }

  .admin-back {
    color: #94a3b8;
    text-decoration: none;
    font-size: 14px;
    transition: color 0.2s;
  }

  .admin-back:hover {
    color: #f1f5f9;
  }

  .admin-body {
    display: flex;
    min-height: calc(100vh - 65px);
  }

  .admin-sidebar {
    width: 200px;
    border-right: 1px solid #1e293b;
    padding: 16px 0;
  }

  .admin-tab {
    width: 100%;
    padding: 12px 24px;
    background: transparent;
    color: #94a3b8;
    font-weight: 400;
    font-size: 14px;
    text-align: left;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
  }

  .admin-tab--active {
    color: #22c55e;
    font-weight: 600;
  }

  .admin-main {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
  }

  .admin-denied {
    color: #f1f5f9;
    font-size: 18px;
    text-align: center;
    padding: 48px;
  }
</style>
