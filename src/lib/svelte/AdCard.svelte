<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onDestroy, onMount } from 'svelte';
import type { Ad } from '../../../shared/types/post.ts';
import { adImpressionTracker } from '../ad-impression-tracker.js';
import { ADSENSE_INLINE_BOOTSTRAP } from '../adsense-bootstrap.js';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { isDataSaverEnabled } from '../settings.js';
import { executeUniversalZip, type UniversalZipExecutorHandle } from '../zip-manager.js';
import { executeFlash, type FlashPlayerHandle } from '../../components/FlashPlayer.js';

let { ad }: { ad: Ad } = $props();

let root = $state<HTMLDivElement>();
let execHost = $state<HTMLDivElement>();
let stage = $state(false);
let loading = $state(false);
let running = $state(false);
let error = $state(false);
let dataSaver = isDataSaverEnabled();
let zipHandle: UniversalZipExecutorHandle | null = null;
let flashHandle: FlashPlayerHandle | null = null;
let observer: IntersectionObserver | null = null;

const hasStage = $derived(ad.ad_type === 'admax' || ad.payload_type !== null);
const gated = $derived(dataSaver && hasStage && !stage);
const aspectRatio = $derived(ad.payload_type === 'swf' ? '4 / 3' : '16 / 9');
const admaxHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;width:300px;height:250px;overflow:hidden}</style></head><body><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1628379583847546" crossorigin="anonymous"><\/script><ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1628379583847546" data-ad-slot="1386532572" data-ad-format="auto" data-full-width-responsive="true"></ins><script>${ADSENSE_INLINE_BOOTSTRAP}<\/script></body></html>`;

function destroyExecutors(): void {
  zipHandle?.destroy();
  zipHandle = null;
  flashHandle?.destroy();
  flashHandle = null;
}

function reveal(): void {
  if (stage) return;
  stage = true;
  adImpressionTracker.trackImpression(ad.id);
}

function directClick(): void {
  if (!ad.click_url) return;
  fetch(`/api/ads/${ad.id}/click`, { method: 'POST' }).catch(console.error);
  window.open(ad.click_url, '_blank', 'noopener');
}

function onLabelClick(event: MouseEvent): void {
  event.stopPropagation();
  fetch(`/api/ads/${ad.id}/click`, { method: 'POST' }).catch(console.error);
}

async function runZip(): Promise<void> {
  if (!execHost || loading) return;
  loading = true;
  error = false;
  fetch(`/api/ads/${ad.id}/play`, { method: 'POST' }).catch(console.error);
  destroyExecutors();
  try {
    zipHandle = await executeUniversalZip(ad.id, execHost, 'wvfs');
    running = true;
    root?.style.setProperty('pointer-events', 'none');
    execHost.style.pointerEvents = 'auto';
  } catch (err) {
    console.error('Failed to load ZIP:', err);
    error = true;
  } finally {
    loading = false;
  }
}

async function runSwf(): Promise<void> {
  if (!execHost || loading) return;
  loading = true;
  error = false;
  fetch(`/api/ads/${ad.id}/play`, { method: 'POST' }).catch(console.error);
  destroyExecutors();
  try {
    flashHandle = await executeFlash(ad.id, execHost, nativeApiHref(`/api/ads/${ad.id}/payload`));
    running = true;
    root?.style.setProperty('pointer-events', 'none');
    execHost.style.pointerEvents = 'auto';
  } catch (err) {
    console.error('Failed to load SWF:', err);
    error = true;
  } finally {
    loading = false;
  }
}

onMount(() => {
  if (!hasStage || dataSaver || !root) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal();
        observer?.unobserve(entry.target);
      }
    },
    { threshold: 0.5 },
  );
  observer.observe(root);
});

onDestroy(() => {
  observer?.disconnect();
  destroyExecutors();
});
</script>

<div
  class="ad-banner"
  bind:this={root}
  role={ad.payload_type === null && ad.click_url ? 'link' : undefined}
  tabindex={ad.payload_type === null && ad.click_url ? 0 : undefined}
  onclick={() => {
    if (ad.payload_type === null && ad.click_url) directClick();
  }}
  onkeydown={(event) => {
    if (ad.payload_type === null && ad.click_url && (event.key === 'Enter' || event.key === ' ')) directClick();
  }}
>
  <div class="ad-content">
    <a
      class="ad-label"
      href={ad.click_url || undefined}
      target={ad.click_url ? '_blank' : undefined}
      rel={ad.click_url ? 'noopener noreferrer' : undefined}
      onclick={ad.click_url ? onLabelClick : undefined}
    >
      {t('ad_card.sponsored')}
    </a>

    <div
      class="ad-placeholder"
      class:ad-placeholder--admax={ad.ad_type === 'admax'}
      style:aspect-ratio={ad.ad_type === 'admax' ? undefined : aspectRatio}
      style:height={ad.ad_type === 'admax' ? '250px' : undefined}
    >
      {#if gated}
        <div class="ad-gate-hint">{t('media.data_saver_placeholder')}</div>
        <button type="button" class="ad-gate" onclick={reveal}>{t('media.data_saver_load_ad')}</button>
      {:else if stage}
        {#if ad.ad_type === 'admax' || ad.payload_type === null}
          <iframe
            title={`Sponsored ad ${ad.id}`}
            sandbox="allow-scripts allow-popups"
            class="ad-admax"
            srcdoc={admaxHtml}
          ></iframe>
        {:else if ad.payload_type === 'gif' || ad.payload_type === 'image'}
          <img class="ad-image" src={nativeApiHref(`/api/ads/${ad.id}/payload`)} alt="" />
        {:else if ad.payload_type === 'zip' || ad.payload_type === 'swf'}
          <div bind:this={execHost} class="ad-exec-host"></div>
          {#if !running}
            <button
              type="button"
              class="ad-run"
              class:ad-run--loading={loading}
              disabled={loading}
              onclick={(event) => {
                event.stopPropagation();
                void (ad.payload_type === 'zip' ? runZip() : runSwf());
              }}
            >
              {#if ad.thumbnail_key}
                <span
                  class="ad-run-thumb"
                  style:background-image={`url(${nativeApiHref(`/api/thumbnail/${ad.id}`)})`}
                ></span>
              {/if}
              <span class="ad-run-icon">{ad.payload_type === 'zip' ? '📦' : '🎮'}</span>
              <span class="ad-run-label">
                {loading
                  ? t('ad_card.loading')
                  : ad.payload_type === 'zip'
                    ? t('ad_card.play_zip')
                    : t('ad_card.play_swf')}
              </span>
            </button>
          {/if}
          {#if error}
            <div class="ad-error">
              {ad.payload_type === 'zip' ? t('ad_card.load_zip_error') : t('ad_card.load_swf_error')}
            </div>
          {/if}
          {#if running && ad.click_url}
            <button
              type="button"
              class="ad-visit"
              onclick={(event) => {
                event.stopPropagation();
                directClick();
              }}
            >
              {t('ad_card.visit', { url: ad.click_url })}
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .ad-placeholder {
    position: relative;
    width: 100%;
    overflow: hidden;
    background: var(--bg-tertiary);
  }

  .ad-placeholder--admax {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .ad-admax {
    display: block;
    width: 100%;
    height: 250px;
    margin: 0 auto;
    border: 0;
  }

  .ad-image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .ad-exec-host,
  .ad-run {
    position: absolute;
    inset: 0;
  }

  .ad-run {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    border: 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    cursor: pointer;
  }

  .ad-run-thumb {
    position: absolute;
    inset: 0;
    background-position: center;
    background-size: cover;
    opacity: 0.7;
  }

  .ad-run-icon,
  .ad-run-label {
    position: relative;
    z-index: 1;
  }

  .ad-run-icon {
    font-size: 48px;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
  }

  .ad-run-label {
    padding: 8px 16px;
    border-radius: 20px;
    background: rgba(0, 0, 0, 0.65);
    font-size: 16px;
    font-weight: 600;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .ad-gate-hint {
    position: absolute;
    top: 18%;
    left: 50%;
    color: var(--text-muted);
    font-size: 0.8rem;
    text-align: center;
    transform: translateX(-50%);
  }

  .ad-gate {
    position: absolute;
    top: 50%;
    left: 50%;
    padding: 0.5rem 1.25rem;
    border: 1px solid #16a34a;
    border-radius: 9999px;
    background: #22c55e;
    color: #052e16;
    font-size: 0.875rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transform: translate(-50%, -50%);
  }

  .ad-error {
    position: absolute;
    inset: auto 8px 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--danger);
    color: #fff;
    font-size: 0.8rem;
    text-align: center;
  }

  .ad-visit {
    position: absolute;
    pointer-events: auto;
    right: 12px;
    bottom: 12px;
    padding: 8px 16px;
    border: 0;
    border-radius: 4px;
    background: #22c55e;
    color: white;
    font-size: 14px;
    cursor: pointer;
  }

  .ad-label:hover {
    text-decoration: underline;
  }
</style>
