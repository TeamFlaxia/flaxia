<script lang="ts">
import { onMount } from 'svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import { t } from '../../lib/i18n.ts';

interface StampItem {
  id: string;
  name: string;
  url: string;
  user_id: string;
}

let {
  // biome-ignore lint/correctness/noUnusedVariables: used in markup
  top,
  // biome-ignore lint/correctness/noUnusedVariables: used in markup
  left,
  onSelect,
  onClose,
}: {
  top: string;
  left: string;
  onSelect: (emoji: string, stampId?: string) => void;
  onClose: () => void;
} = $props();

type Tab = 'unicode' | 'custom';
// biome-ignore lint/correctness/noUnusedVariables: used in markup
let tab = $state<Tab>('unicode');
let stamps = $state<StampItem[]>([]);
let customState = $state<'idle' | 'loading' | 'loaded' | 'error'>('idle');
let emojiHost: HTMLDivElement | undefined = $state();
let active = true;

function choose(emoji: string, stampId?: string): void {
  if (!active) return;
  onSelect(emoji, stampId);
  onClose();
}

onMount(() => {
  let picker: HTMLElement | undefined;
  let handler: EventListener | undefined;

  void import('emoji-picker-element').then((mod) => {
    if (!active || !emojiHost || !mod.Picker) return;
    picker = new mod.Picker({
      dataSource: '/emoji-data.json',
      locale: document.documentElement.lang || undefined,
    });
    picker.style.width = '100%';
    picker.style.maxHeight = '340px';
    handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { emoji?: { unicode?: string } };
      const unicode = detail?.emoji?.unicode;
      if (unicode) choose(unicode);
    };
    picker.addEventListener('emoji-click', handler);
    emojiHost.appendChild(picker);
  });

  return () => {
    active = false;
    if (picker && handler) picker.removeEventListener('emoji-click', handler);
  };
});

async function loadCustom(): Promise<void> {
  if (customState === 'loading' || customState === 'loaded') return;
  customState = 'loading';
  try {
    const response = await fetch('/api/stamps', { credentials: 'include' });
    const data = (await response.json()) as { stamps: StampItem[] };
    if (!active) return;
    stamps = data.stamps ?? [];
    customState = 'loaded';
  } catch {
    if (active) customState = 'error';
  }
}

function selectTab(next: Tab): void {
  tab = next;
  if (next === 'custom') void loadCustom();
}
</script>

<div
  class="stamp-picker"
  style="position:fixed;z-index:1000;width:340px;max-height:400px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:flex;flex-direction:column;overflow:hidden;top:{top};left:{left};"
>
  <div class="stamp-picker-tabs" style="display:flex;border-bottom:1px solid var(--border);">
    <button
      type="button"
      class="stamp-picker-tab"
      class:stamp-picker-tab--active={tab === 'unicode'}
      style="flex:1;padding:8px;border:none;background:none;cursor:pointer;font-size:0.875rem;border-bottom:2px solid {tab ===
      'unicode'
        ? 'var(--accent)'
        : 'transparent'};color:{tab === 'unicode' ? 'var(--text-primary)' : 'var(--text-muted)'};"
      onclick={() => selectTab('unicode')}
    >
      Unicode
    </button>
    <button
      type="button"
      class="stamp-picker-tab"
      class:stamp-picker-tab--active={tab === 'custom'}
      style="flex:1;padding:8px;border:none;background:none;cursor:pointer;font-size:0.875rem;border-bottom:2px solid {tab ===
      'custom'
        ? 'var(--accent)'
        : 'transparent'};color:{tab === 'custom' ? 'var(--text-primary)' : 'var(--text-muted)'};"
      onclick={() => selectTab('custom')}
    >
      {t('settings.custom_emoji') || 'Custom'}
    </button>
  </div>

  <div class="stamp-picker-content" style="flex:1;overflow-y:auto;padding:8px;min-height:200px;">
    <div bind:this={emojiHost} style="display:{tab === 'unicode' ? '' : 'none'};"></div>

    {#if tab === 'custom'}
      <div>
        {#if customState === 'loading'}
          <div style="text-align:center;padding:16px;color:var(--text-muted);">Loading...</div>
        {:else if customState === 'error'}
          <div style="text-align:center;padding:16px;color:var(--text-muted);">Failed to load</div>
        {:else if stamps.length === 0}
          <div style="text-align:center;padding:16px;color:var(--text-muted);">
            {t('settings.custom_emoji_empty') || 'No custom emoji yet. Create some in Settings!'}
          </div>
        {:else}
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
            {#each stamps as stamp (stamp.id)}
              <button
                type="button"
                title={stamp.name}
                style="padding:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;"
                onclick={() => choose(stamp.name, stamp.id)}
              >
                <img
                  src={stamp.url}
                  alt={stamp.name}
                  style="width:32px;height:32px;object-fit:contain;"
                />
                <span
                  style="font-size:0.625rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:64px;"
                >
                  {stamp.name}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
