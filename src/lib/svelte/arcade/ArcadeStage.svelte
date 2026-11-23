<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import type { Game } from '../../../types/game.js';
import type { ArcadeViewportApi } from '../../arcade/player.ts';
import { t } from '../../i18n.ts';
import { iconHtml } from '../../post/icon-html.ts';
import ArcadeGameViewport from './ArcadeGameViewport.svelte';

interface Props {
  game: Game | undefined;
  sandboxOrigin: string;
  fullscreen: boolean;
  loading: boolean;
  gameLoading: boolean;
  loadingType: 'zip' | 'html5';
  empty: boolean;
  dragY: number;
  dragging: boolean;
  viewportOpacity: number;
  storageSnapshot?: Promise<Record<string, string>>;
  wheelEnabled: boolean;
  onNavigate: (direction: 1 | -1) => void;
  onRefs: (container: HTMLDivElement, viewport: HTMLDivElement | undefined) => void;
  onFresh: () => void;
  onFullscreen: () => void;
  onShare: () => void;
  onComments: () => void;
  onBookmark: () => void;
  onReport: () => void;
  onPostScore: (score: number, label: string) => void;
  onApi: (api: ArcadeViewportApi | null) => void;
}

let {
  game,
  sandboxOrigin,
  fullscreen,
  loading,
  gameLoading,
  loadingType,
  empty,
  dragY,
  dragging,
  viewportOpacity,
  storageSnapshot,
  wheelEnabled,
  onNavigate,
  onRefs,
  onFresh,
  onFullscreen,
  onShare,
  onComments,
  onBookmark,
  onReport,
  onPostScore,
  onApi,
}: Props = $props();

let container: HTMLDivElement;
let viewport: HTMLDivElement | undefined = $state();
let wheelTimer: number | null = null;

$effect(() => {
  onRefs(container, viewport);
});

$effect(() => {
  return () => {
    if (wheelTimer !== null) {
      window.clearTimeout(wheelTimer);
      wheelTimer = null;
    }
  };
});

function handleWheel(event: WheelEvent): void {
  if (!wheelEnabled) return;
  event.preventDefault();
  if (wheelTimer !== null) window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => {
    wheelTimer = null;
    if (event.deltaY > 0) onNavigate(1);
    else if (event.deltaY < 0) onNavigate(-1);
  }, 50);
}
</script>

<div class="arcade-game-container" bind:this={container} onwheel={handleWheel}>
  {#if !fullscreen}
    <button
      type="button"
      class="arcade-nav arcade-nav-up"
      aria-label="Previous game"
      onclick={() => onNavigate(-1)}
    >
      {@html iconHtml('chevron-up', 20)}
    </button>
    <button type="button" class="arcade-nav arcade-nav-down" aria-label="Next game" onclick={() => onNavigate(1)}>
      {@html iconHtml('chevron-down', 20)}
    </button>
  {/if}

  {#if loading}
    <div class="arcade-loading" aria-live="polite">
      <div class="arcade-spinner"></div>
      <div class="arcade-loading-label">{t('arcade.loading')}</div>
    </div>
  {:else if gameLoading}
    <div class="arcade-game-loading" aria-live="polite">
      <div class="arcade-spinner"></div>
      <div class="arcade-loading-label">
        {loadingType === 'html5' ? t('arcade.loading_html5') : t('arcade.loading_zip')}
      </div>
    </div>
  {/if}

  {#if empty && !loading && !gameLoading}
    <div class="arcade-empty">
      <div class="arcade-empty-icon">{@html iconHtml('game', 64)}</div>
      <div class="arcade-empty-title">{t('arcade.no_games_title')}</div>
      <div class="arcade-empty-sub">{t('arcade.no_games_subtitle')}</div>
    </div>
  {/if}

  {#if game}
    <div
      class="arcade-viewport"
      bind:this={viewport}
      style:transform="translateY({dragY}px)"
      style:opacity={viewportOpacity}
      style:transition={dragging ? 'none' : 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease'}
    >
      {#key game.postId}
        <div class="arcade-viewport-inner">
          <ArcadeGameViewport
            {game}
            {sandboxOrigin}
            {fullscreen}
            {storageSnapshot}
            {onFresh}
            {onFullscreen}
            {onShare}
            {onComments}
            {onBookmark}
            {onReport}
            {onPostScore}
            {onApi}
          />
        </div>
      {/key}
    </div>
  {/if}
</div>

<style>
  .arcade-game-container {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .arcade-viewport {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
  }

  .arcade-viewport-inner {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    animation: arcade-viewport-in 320ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
  }

  .arcade-loading,
  .arcade-game-loading {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    transform: translate(-50%, -50%);
    color: var(--text-muted);
  }

  .arcade-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--text-muted);
    border-radius: 50%;
    animation: arcade-spin 0.8s linear infinite;
  }

  .arcade-loading-label {
    font-size: 1.1rem;
  }

  .arcade-empty {
    position: absolute;
    top: 50%;
    left: 50%;
    color: var(--text-muted);
    text-align: center;
    transform: translate(-50%, -50%);
  }

  .arcade-empty-icon {
    margin-bottom: 1rem;
    opacity: 0.6;
  }

  .arcade-empty-title {
    margin-bottom: 0.5rem;
    font-size: 1.25rem;
  }

  .arcade-empty-sub {
    font-size: 0.875rem;
  }

  .arcade-nav {
    position: absolute;
    left: 50%;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--bg-primary);
    box-shadow: var(--shadow-sm);
    color: var(--text-primary);
    cursor: pointer;
    opacity: 0.85;
    transform: translateX(-50%);
  }

  .arcade-nav-up {
    top: 1rem;
  }

  .arcade-nav-down {
    bottom: 1rem;
  }

  .arcade-nav:hover {
    opacity: 1;
  }

  @keyframes arcade-viewport-in {
    from {
      opacity: 0;
      transform: translateY(40px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
