<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { openAddStampModal } from '../settings/stamp-modal.ts';

interface Stamp {
  id: string;
  name: string;
  url: string;
}

let stamps = $state<Stamp[]>([]);
let unlimited = $state(false);
let loaded = $state(false);
let failed = $state(false);

const limitLabel = $derived(unlimited ? '∞' : '5');

async function loadPlan(): Promise<void> {
  try {
    const response = await fetch('/api/billing/plan', { credentials: 'include' });
    if (!response.ok) return;
    const data = (await response.json()) as { plan?: string | null; status?: string | null };
    unlimited = Boolean(data.plan) && ['active', 'trialing'].includes(data.status ?? '');
  } catch {
    unlimited = false;
  }
}

async function loadStamps(): Promise<void> {
  try {
    const response = await fetch('/api/stamps', { credentials: 'include' });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as { stamps?: Stamp[] };
    stamps = data.stamps ?? [];
    failed = false;
  } catch {
    failed = true;
  } finally {
    loaded = true;
  }
}

async function remove(stamp: Stamp): Promise<void> {
  if (!confirm(t('settings.custom_emoji_delete_confirm', { name: stamp.name }) || `Delete ${stamp.name}?`)) return;
  const response = await fetch(`/api/stamps/${stamp.id}`, { method: 'DELETE', credentials: 'include' });
  if (response.ok) await loadStamps();
}

function openPicker(): void {
  openAddStampModal(() => void loadStamps());
}

onMount(() => {
  void loadPlan();
  void loadStamps();
});
</script>

<h2>{t('settings.custom_emoji') || 'Custom Emoji'}</h2>
<p class="emoji-desc">
  {t('settings.custom_emoji_desc') ||
    'Create custom emoji like :working_me: to use in reactions and messages. Only you can use your custom emoji, but others can see them.'}
</p>

<div class="emoji-count">
  <span>{t('settings.custom_emoji_count') || 'Emoji used:'}</span>
  <strong>{stamps.length} / {limitLabel}</strong>
</div>

{#if failed}
  <div class="emoji-error">{t('settings.custom_emoji_load_failed') || 'Failed to load stamps'}</div>
{:else}
  <div class="emoji-grid">
    {#each stamps as stamp (stamp.id)}
      <div class="emoji-card">
        <button
          type="button"
          class="emoji-delete"
          aria-label={t('common.delete') || 'Delete'}
          onclick={() => void remove(stamp)}
        >
          ✕
        </button>
        <img src={stamp.url} alt={stamp.name} />
        <div class="emoji-name" title={stamp.name}>{stamp.name}</div>
      </div>
    {/each}
    <button type="button" class="emoji-add" onclick={openPicker}>
      <span class="emoji-add-icon">+</span>
      <span>{t('settings.add_stamp_tap_to_add') || 'Tap to add'}</span>
    </button>
  </div>
{/if}

{#if loaded && stamps.length === 0 && !failed}
  <p class="emoji-hint">{t('settings.custom_emoji_empty') || 'No custom emoji yet.'}</p>
{/if}

<style>
  .emoji-desc {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .emoji-count {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .emoji-count strong {
    color: var(--text-primary);
  }

  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.75rem;
    width: 100%;
  }

  .emoji-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
    overflow: hidden;
    text-align: center;
  }

  .emoji-card img {
    width: 48px;
    height: 48px;
    margin-bottom: 0.25rem;
    object-fit: contain;
    flex-shrink: 0;
  }

  .emoji-name {
    width: 100%;
    overflow: hidden;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .emoji-delete {
    position: absolute;
    top: 2px;
    right: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--danger-strong, #b91c1c);
    color: #fff;
    font-size: 9px;
    line-height: 1;
    cursor: pointer;
  }

  .emoji-add {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-width: 0;
    min-height: 80px;
    padding: 0.5rem;
    border: 2px dashed var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: pointer;
    transition:
      border-color 0.2s,
      background 0.2s;
  }

  .emoji-add:hover {
    border-color: var(--accent);
    background: var(--bg-hover, rgba(0, 0, 0, 0.02));
  }

  .emoji-add-icon {
    font-size: 1.5rem;
    line-height: 1;
  }

  .emoji-error,
  .emoji-hint {
    color: var(--text-muted);
    font-size: 0.875rem;
    padding: 0.5rem 0;
  }
</style>
