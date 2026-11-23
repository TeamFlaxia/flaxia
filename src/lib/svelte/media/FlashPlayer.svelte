<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import { buildFlashPlayerDocument } from '../../../lib/flash-player-document.ts';
import { t } from '../../../lib/i18n.ts';

interface Props {
  swf: Promise<ArrayBuffer>;
  hideFullscreen?: boolean;
  /** Resolves when the SWF bytes were transferred; rejects on timeout/load failure. */
  onSettled: (error?: Error) => void;
}

let { swf, hideFullscreen = false, onSettled }: Props = $props();

const LOADING_TIMEOUT = 30_000;
const loadingText = t('post_stage.loading_flash').replace(/<[^>]+>/g, '');

let iframe = $state<HTMLIFrameElement>();
let frameContainer = $state<HTMLDivElement>();
let ready = $state(false);
let errorMessage = $state<string | null>(null);
let iframeVisible = $state(false);
let loadingVisible = $state(true);

onMount(() => {
  let disposed = false;
  let finished = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;

  const htmlContent = buildFlashPlayerDocument(t('flash_player.title'), t('flash_player.load_failed'));
  const htmlBlobUrl = URL.createObjectURL(new Blob([htmlContent], { type: 'text/html' }));

  const onMessage = (event: MessageEvent) => {
    if (event.data === 'FLASH_IFRAME_READY') ready = true;
  };
  window.addEventListener('message', onMessage);

  if (iframe) iframe.src = htmlBlobUrl;

  const settle = (error?: Error): void => {
    if (finished) return;
    finished = true;
    onSettled(error);
  };

  const readyPromise = new Promise<void>((resolve, reject) => {
    timeoutTimer = setTimeout(() => {
      if (disposed || finished) return;
      reject(new Error('Flash iframe ready timeout'));
    }, LOADING_TIMEOUT);
    const check = () => {
      if (disposed || finished) return;
      if (ready) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = null;
        resolve();
        return;
      }
      pollTimer = setTimeout(check, 10);
    };
    check();
  });

  Promise.all([swf, readyPromise])
    .then(([data]) => {
      if (disposed) return;
      iframe?.contentWindow?.postMessage({ type: 'SWF_DATA', data }, '*', [data]);
      iframeVisible = true;
      removeTimer = setTimeout(() => {
        if (disposed) return;
        loadingVisible = false;
      }, 300);
      settle();
    })
    .catch((error: unknown) => {
      if (disposed) return;
      const err = error instanceof Error ? error : new Error(t('common.error'));
      errorMessage = err.message;
      loadingVisible = false;
      settle(err);
    });

  return () => {
    disposed = true;
    window.removeEventListener('message', onMessage);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (removeTimer) clearTimeout(removeTimer);
    URL.revokeObjectURL(htmlBlobUrl);
    // A removed player must not leave executeFlash() awaiting forever.
    settle();
  };
});

function toggleFullscreen(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err: Error) => console.warn('Exit fullscreen failed:', err));
    } else if (frameContainer?.requestFullscreen) {
      frameContainer.requestFullscreen().catch((err: Error) => {
        console.warn('Container fullscreen failed:', err);
        iframe?.requestFullscreen?.().catch((err2: Error) => console.warn('Iframe fullscreen failed:', err2));
      });
    } else if (iframe?.requestFullscreen) {
      iframe.requestFullscreen().catch((err: Error) => console.warn('Iframe fullscreen failed:', err));
    }
  } catch (error) {
    console.error('Fullscreen error:', error);
  }
}
</script>

<svelte:head>
  <style>
    @keyframes wvfs-spin {
      to {
        transform: rotate(360deg);
      }
    }
  </style>
</svelte:head>

{#if errorMessage !== null}
  <div
    style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 20px; text-align: center; color: var(--text-muted);"
  >
    <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
    <div style="font-weight: bold; margin-bottom: 8px;">{t('flash_player.error_heading')}</div>
    <div style="font-size: 14px;">{errorMessage}</div>
  </div>
{:else}
  <div
    class="flash-player-root"
    style="position: absolute; inset: 0; display: flex; flex-direction: column;"
  >
    {#if loadingVisible}
      <div
        class="flash-loading"
        style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--bg-primary, #ffffff); z-index: 10; transition: opacity 0.3s ease; border-radius: 8px; opacity: {iframeVisible ? 0 : 1};"
      >
        <div
          style="width: 32px; height: 32px; border: 3px solid var(--border, #e2e8f0); border-top-color: var(--accent, #22c55e); border-radius: 50%; animation: wvfs-spin 0.8s linear infinite; margin-bottom: 12px;"
        ></div>
        <div style="color: var(--text-muted, #64748b); font-size: 0.875rem; font-weight: 500;">{loadingText}</div>
      </div>
    {/if}

    <div
      bind:this={frameContainer}
      style="position: absolute; inset: 0; display: flex; flex-direction: column;"
    >
      <iframe
        bind:this={iframe}
        title={t('flash_player.title')}
        sandbox="allow-scripts allow-pointer-lock allow-forms allow-popups"
        allow="fullscreen"
        referrerpolicy="no-referrer"
        style="flex: 1; width: 100%; height: 100%; border: none; opacity: {iframeVisible ? 1 : 0}; transition: opacity 0.3s ease;"
      ></iframe>

      {#if !hideFullscreen}
        <button
          type="button"
          class="flash-fullscreen-btn"
          style="margin-top: 0; padding: 4px 8px; font-size: 12px; border: 1px solid var(--border); background: var(--bg-tertiary); cursor: pointer; border-radius: 4px; align-self: center;"
          onclick={toggleFullscreen}>{t('flash_player.fullscreen')}</button
        >
      {/if}
    </div>
  </div>
{/if}
