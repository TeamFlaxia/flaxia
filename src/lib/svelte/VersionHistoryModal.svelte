<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { isCurrentVersion, versionsEndpoint } from '../modals/dialog-logic.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';

interface GameVersion {
  id: string;
  versionNumber: number;
  changelog: string | null;
  thumbnailKey: string | null;
  createdAt: string;
}

interface Props {
  postId: string;
  sandboxOrigin?: string;
  currentVersionId: string | null;
  onPlay: (versionId: string | null) => void;
  onClose: () => void;
}

let { postId, currentVersionId, onPlay, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let versions = $state<GameVersion[]>([]);
let loading = $state(true);
let failed = $state(false);

function accent(current: boolean): string {
  return current ? 'var(--accent, #22c55e)' : 'var(--border)';
}

function play(versionId: string | null): void {
  onPlay(versionId);
  controller?.close();
}

async function load(): Promise<void> {
  try {
    const response = await fetch(versionsEndpoint(postId));
    if (!response.ok) throw new Error('fetch failed');
    const data = (await response.json()) as { versions?: GameVersion[] };
    versions = data.versions || [];
  } catch {
    failed = true;
  } finally {
    loading = false;
  }
}

onMount(() => {
  controller = attachModalBehavior({
    overlay: overlayEl,
    dialog: dialogEl,
    onClose,
    animated: false,
  });
  void load();
  return () => controller?.destroy();
});
</script>

<div
  class="version-history-modal-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) controller?.close();
  }}
>
  <div
    class="version-history-modal"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-labelledby="version-history-title"
    tabindex="-1"
  >
    <h2 id="version-history-title">{t('game.version_history_title')}</h2>

    <div class="version-history-list">
      {#if loading}
        <div class="version-history-muted">{t('common.loading')}</div>
      {:else if failed}
        <div class="version-history-error">{t('game.version_history_error')}</div>
      {:else}
        <button
          type="button"
          class="version-history-latest"
          style:border-color={accent(isCurrentVersion(currentVersionId, null))}
          onclick={() => play(null)}
        >
          {t('game.play_latest')}
        </button>
        {#if versions.length === 0}
          <div class="version-history-muted">{t('game.no_versions')}</div>
        {:else}
          {#each versions as version (version.id)}
            <div class="version-history-item" style:border-color={accent(isCurrentVersion(currentVersionId, version.id))}>
              <div class="version-history-head">
                <span class="version-history-label">{t('game.version')} {version.versionNumber}</span>
                <span class="version-history-date">{new Date(version.createdAt).toLocaleString()}</span>
              </div>
              {#if version.changelog}
                <p class="version-history-changelog">{version.changelog}</p>
              {/if}
              <button type="button" class="version-history-play" onclick={() => play(version.id)}>
                {t('game.play_version')}
              </button>
            </div>
          {/each}
        {/if}
      {/if}
    </div>

    <div class="version-history-footer">
      <button type="button" class="version-history-close" onclick={() => controller?.close()}>
        {t('common.close')}
      </button>
    </div>
  </div>
</div>

<style>
  .version-history-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.5);
  }

  .version-history-modal {
    width: 100%;
    max-width: 480px;
    max-height: 85vh;
    padding: 1.25rem;
    overflow-y: auto;
    border-radius: 0.75rem;
    background: var(--bg-primary);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  }

  .version-history-modal h2 {
    margin: 0 0 1rem;
    color: var(--text-primary);
    font-size: 1.125rem;
  }

  .version-history-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .version-history-muted {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .version-history-error {
    color: var(--danger-text, #b91c1c);
    font-size: 0.875rem;
  }

  .version-history-latest {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 0.875rem;
    text-align: left;
    cursor: pointer;
  }

  .version-history-item {
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-input);
  }

  .version-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .version-history-label {
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .version-history-date {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .version-history-changelog {
    margin: 0.5rem 0 0;
    color: var(--text-primary);
    font-size: 0.8125rem;
    white-space: pre-wrap;
  }

  .version-history-play {
    margin-top: 0.75rem;
    padding: 0.4rem 0.9rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--accent, #22c55e);
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
  }

  .version-history-footer {
    margin-top: 1rem;
    text-align: right;
  }

  .version-history-close {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.875rem;
    cursor: pointer;
  }
</style>
