<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount, tick } from 'svelte';
import { loadSettingsCategories, type SettingsCategory } from '../../components/SettingsPage.ts';
import { t } from '../i18n.ts';
import { attachIcons } from '../icons.ts';

interface Props {
  currentUser?: Record<string, unknown> | null;
  initialCategory?: string | null;
}
let { currentUser = null, initialCategory = null }: Props = $props();

let root: HTMLDivElement;
let categories = $state<SettingsCategory[]>([]);
let active = $state<string | null>(null);
let content: { categories: SettingsCategory[]; destroy: () => void } | null = null;
const panels = new Map<string, HTMLElement>();

const groups = $derived.by(() => {
  const order: Array<{ key: string; items: SettingsCategory[] }> = [];
  for (const category of categories) {
    let group = order.find((entry) => entry.key === category.groupKey);
    if (!group) {
      group = { key: category.groupKey, items: [] };
      order.push(group);
    }
    group.items.push(category);
  }
  return order;
});

function showCategory(id: string, moveFocus = true): void {
  if (!categories.some((category) => category.id === id)) return;
  active = id;
  if (moveFocus) void tick().then(() => panels.get(id)?.focus({ preventScroll: false }));
}

function registerPanel(node: HTMLElement, id: string) {
  panels.set(id, node);
  return {
    destroy() {
      panels.delete(id);
    },
  };
}

/** Adopt the section DOM the settings adapter built for this category. */
function appendSections(node: HTMLElement, sections: HTMLElement[]) {
  for (const section of sections) node.appendChild(section);
  return {
    destroy() {
      for (const section of sections) section.remove();
    },
  };
}

onMount(() => {
  content = loadSettingsCategories({ currentUser } as never);
  const loaded = content.categories;
  categories = loaded;
  const requested =
    initialCategory && loaded.some((category) => category.id === initialCategory) ? initialCategory : null;
  active = requested ?? loaded[0]?.id ?? null;
  void tick().then(() => {
    if (root) attachIcons(root);
  });
  return () => {
    content?.destroy();
    content = null;
    panels.clear();
  };
});
</script>

<div class="settings-page" bind:this={root}>
  <header class="settings-header">
    <button type="button" class="settings-back" aria-label={t('common.back')} onclick={() => window.history.back()}>
      ←
    </button>
    <h1 tabindex="-1">
      <span class="settings-title-icon" data-icon="settings" aria-hidden="true"></span>
      {t('settings.title')}
    </h1>
  </header>

  <div class="settings-two-pane">
    <nav class="settings-nav" aria-label={t('settings.title')}>
      {#each groups as group (group.key)}
        <section class="settings-nav-group">
          <h2 class="settings-nav-group-title">{t(group.key)}</h2>
          <div class="settings-nav-list">
            {#each group.items as category (category.id)}
              <button
                type="button"
                class="settings-nav-item"
                class:settings-nav-item--active={active === category.id}
                aria-current={active === category.id ? 'page' : undefined}
                onclick={() => showCategory(category.id)}
              >
                <span class="settings-nav-icon" data-icon={category.iconName} aria-hidden="true"></span>
                <span class="settings-nav-label">{t(category.titleKey)}</span>
              </button>
            {/each}
          </div>
        </section>
      {/each}
    </nav>

    <div class="settings-content">
      {#each categories as category (category.id)}
        <section
          class="settings-panel"
          aria-label={t(category.titleKey)}
          tabindex="-1"
          hidden={active !== category.id}
          use:registerPanel={category.id}
          use:appendSections={category.sections}
        >
          <p class="settings-panel-description">{t(category.descriptionKey)}</p>
        </section>
      {/each}
    </div>
  </div>
</div>
