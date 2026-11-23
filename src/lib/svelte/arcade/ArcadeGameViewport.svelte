<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import type { Game } from '../../../types/game.js';
import {
  type ArcadeCaptureApi,
  type ArcadePlayerHandle,
  type ArcadeViewportApi,
  mountZipPlayer,
  setupArcadeCapture,
} from '../../arcade/player.ts';
import { t } from '../../i18n.ts';
import { nativeApiHref } from '../../native-api.ts';
import { iconHtml } from '../../post/icon-html.ts';
import ArcadeActions from './ArcadeActions.svelte';

interface Props {
  game: Game;
  sandboxOrigin: string;
  fullscreen: boolean;
  storageSnapshot?: Promise<Record<string, string>>;
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
  storageSnapshot,
  onFresh,
  onFullscreen,
  onShare,
  onComments,
  onBookmark,
  onReport,
  onPostScore,
  onApi,
}: Props = $props();

let zipHost: HTMLDivElement;
let iframeEl: HTMLIFrameElement | undefined = $state();
let player: ArcadePlayerHandle | null = null;
let htmlCapture: ReturnType<typeof setupArcadeCapture> = null;
let loading = $state(true);
let errorMessage = $state('');
let captureApi = $state<ArcadeCaptureApi | null>(null);
let cancelled = false;

function focusGame(): void {
  if (player) player.focus();
  else iframeEl?.focus();
}

$effect(() => {
  onApi(captureApi ? { capture: captureApi, focus: focusGame } : null);
});

const loadingText = $derived(game.type === 'html5' ? t('arcade.loading_html5') : t('arcade.loading_zip'));

function captureHooks() {
  return {
    // The HUD shows a score card from the captured frame.
    onPostScore,
    onCaptureError: (message: string) => console.warn('Game capture unavailable:', message),
  };
}

async function startZip(): Promise<void> {
  try {
    const handle = await mountZipPlayer({
      game,
      host: zipHost,
      sandboxOrigin,
      storageSnapshot,
      ...captureHooks(),
    });
    if (cancelled) {
      handle.destroy();
      return;
    }
    player = handle;
    captureApi = handle.capture;
    loading = false;
  } catch (error) {
    if (cancelled) return;
    loading = false;
    const message = error instanceof Error ? error.message : '';
    errorMessage = message === t('offline_games.unsupported') ? message : t('arcade.load_failed');
    console.error('Failed to execute game:', error);
  }
}

function handleIframeLoad(): void {
  if (cancelled || game.type !== 'html5' || !iframeEl) return;
  htmlCapture?.destroy();
  htmlCapture = setupArcadeCapture(iframeEl, sandboxOrigin, captureHooks());
  captureApi = htmlCapture;
  loading = false;
}

onMount(() => {
  if (game.type === 'zip' && game.payloadKey) {
    void startZip();
  } else if (game.type !== 'html5') {
    loading = false;
    errorMessage = t('arcade.load_failed');
  }

  return () => {
    cancelled = true;
    player?.destroy();
    player = null;
    htmlCapture?.destroy();
    htmlCapture = null;
    captureApi = null;
    onApi(null);
  };
});
</script>

<div class="arcade-game-area">
  {#if game.type === 'html5'}
    <iframe
      bind:this={iframeEl}
      class="arcade-html5-frame"
      src={nativeApiHref(`/api/games/html5/${game.id}`)}
      title={game.title}
      onload={handleIframeLoad}
    ></iframe>
  {:else}
    <div class="arcade-zip-host" bind:this={zipHost}></div>
  {/if}

  {#if loading}
    <div class="arcade-game-loading" aria-live="polite">
      <div class="arcade-spinner"></div>
      <div class="arcade-loading-text">{loadingText}</div>
    </div>
  {/if}

  {#if errorMessage}
    <div class="arcade-game-error">
      <div class="arcade-error-icon">{@html iconHtml('warning', 48)}</div>
      <div>{errorMessage}</div>
    </div>
  {/if}
</div>

<div class="arcade-game-info" hidden={fullscreen}>
  <div class="arcade-game-title">{game.title || t('arcade.game_by', { username: game.username })}</div>
  <div class="arcade-game-author">{t('arcade.game_author', { username: game.username })}</div>
</div>

<ArcadeActions
  freshCount={game.freshCount ?? 0}
  replyCount={game.replyCount ?? 0}
  bookmarkCount={game.bookmarkCount ?? 0}
  isFreshed={Boolean(game.isFreshed)}
  isBookmarked={Boolean(game.isBookmarked)}
  {fullscreen}
  {onFresh}
  {onFullscreen}
  {onShare}
  {onComments}
  {onBookmark}
  {onReport}
/>

<style>
  .arcade-game-area {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .arcade-html5-frame {
    width: 100%;
    height: 100%;
    border: none;
  }

  .arcade-zip-host {
    width: 100%;
    height: 100%;
  }

  .arcade-game-info {
    position: absolute;
    right: 100px;
    bottom: 80px;
    left: 1rem;
    z-index: 5;
    color: white;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    pointer-events: none;
  }

  .arcade-game-info[hidden] {
    display: none;
  }

  .arcade-game-title {
    margin-bottom: 0.25rem;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .arcade-game-author {
    font-size: 0.875rem;
    opacity: 0.9;
  }

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
    pointer-events: none;
  }

  .arcade-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: arcade-spin 0.8s linear infinite;
  }

  .arcade-loading-text {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    font-weight: 500;
  }

  .arcade-game-error {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 2rem;
    color: white;
    text-align: center;
  }

  .arcade-error-icon {
    color: var(--text-muted);
  }
</style>
