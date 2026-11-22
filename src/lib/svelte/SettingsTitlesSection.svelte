<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import type { SettingsTitle } from '../settings/title-types.ts';
import { titleDescription, createTitleIcon as titleIcon, titleName } from '../user-title.js';

type TitleEntry = { kind: 'title'; title: SettingsTitle } | { kind: 'empty' } | { kind: 'error' };

let entries = $state<TitleEntry[]>([]);

function mountTitleIcon(node: HTMLElement, icon: string): void {
  const element = titleIcon(icon, 'settings-title-icon');
  if (element) node.appendChild(element);
}

onMount(() => {
  fetch('/api/titles/me', { credentials: 'include' })
    .then((response) =>
      response.ok
        ? (response.json() as Promise<{ titles?: SettingsTitle[] }>)
        : Promise.reject(new Error(String(response.status))),
    )
    .then((data) => {
      const titles = data.titles ?? [];
      entries = titles.length === 0 ? [{ kind: 'empty' }] : titles.map((title) => ({ kind: 'title', title }));
    })
    .catch(() => {
      entries = [{ kind: 'error' }];
    });
});
</script>

<h2>{t('settings.titles') || 'Titles'}</h2>
<p class="settings-section-desc">
  {t('settings.titles_desc') || 'Titles you have earned. Choose one to show after your username from Edit profile.'}
</p>

<div class="settings-titles">
  {#each entries as entry, index (entry.kind === 'title' ? entry.title.id : `${entry.kind}-${index}`)}
    {#if entry.kind === 'title'}
      <div
        class="settings-title-card"
        class:settings-title-card--equipped={entry.title.equipped}
      >
        {#if entry.title.icon}
          <span use:mountTitleIcon={entry.title.icon}></span>
        {/if}
        <div class="settings-title-text">
          <div class="settings-title-name-row">
            <strong>{titleName(entry.title)}</strong>
            {#if entry.title.equipped}
              <span class="settings-title-equipped">{t('settings.titles_equipped') || 'Equipped'}</span>
            {/if}
          </div>
          <div class="settings-title-description">{titleDescription(entry.title)}</div>
        </div>
      </div>
    {:else}
      <p class="settings-titles-empty">
        {entry.kind === 'empty'
          ? t('settings.titles_empty') || 'You have not earned any titles yet.'
          : t('settings.titles_load_failed') || 'Failed to load titles.'}
      </p>
    {/if}
  {/each}
</div>

<style>
  .settings-section-desc {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .settings-titles {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .settings-title-card {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .settings-title-card--equipped {
    border-color: var(--accent);
  }

  .settings-title-text {
    min-width: 0;
    flex: 1;
  }

  .settings-title-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .settings-title-name-row strong {
    color: var(--text-primary);
  }

  .settings-title-equipped {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 9999px;
    padding: 0.0625rem 0.5rem;
  }

  .settings-title-description {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }

  .settings-titles-empty {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
