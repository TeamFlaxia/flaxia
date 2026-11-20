<script lang="ts">
import { onMount } from 'svelte';
import { t } from '../../lib/i18n.ts';
import { setOfflineImage } from '../../lib/offline-image.ts';

interface Props {
  imageUrl: string;
  baseImageUrl: string;
  postId: string;
  alt: string;
  ratio?: '16:9';
  fit?: string;
  isThumbnail?: boolean;
  /** Pre-fetched blob URL: legacy path renders a bare image with no placeholder. */
  simple?: boolean;
  onOpenOverlay: () => void;
}

let { imageUrl, baseImageUrl, alt, ratio, fit, isThumbnail, simple, onOpenOverlay }: Props = $props();

let root: HTMLDivElement;
let img: HTMLImageElement;
let failed = $state(false);
let loading = $state(true);
let resizeObserver: ResizeObserver | null = null;

const MAX_IMG_HEIGHT = 700;

function fitImage(): void {
  if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0 || !root) return;
  const naturalRatio = img.naturalHeight / img.naturalWidth;
  const containerW = root.clientWidth || img.parentElement?.clientWidth || 0;
  if (containerW <= 0) return;
  let w = containerW;
  let h = w * naturalRatio;
  if (h > MAX_IMG_HEIGHT) {
    h = MAX_IMG_HEIGHT;
    w = h / naturalRatio;
  }
  w = Math.min(w, img.naturalWidth);
  h = w * naturalRatio;
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
}

onMount(() => {
  setOfflineImage(img, isThumbnail ? baseImageUrl : imageUrl);
  if (img.complete && img.naturalWidth > 0) onLoad();

  if (!ratio && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(fitImage);
    resizeObserver.observe(root);
  }
  return () => resizeObserver?.disconnect();
});

function onLoad(): void {
  loading = false;
  if (!ratio) fitImage();
}

function onError(): void {
  loading = false;
  failed = true;
}

function open(): void {
  onOpenOverlay();
}
</script>

<div
  bind:this={root}
  class="image-preview"
  class:fx-box={ratio === '16:9'}
  class:image-preview--thumbnail={isThumbnail}
  style={ratio === '16:9'
    ? `--fx-ratio: 16 / 9; --fx-min: 0px; background: var(--bg-input); ${isThumbnail ? '' : 'border-radius: var(--radius-md);'}`
    : `position: relative; width: 100%; height: auto; display: flex; flex-direction: column; align-items: center; ${isThumbnail ? '' : 'background: var(--bg-input); border-radius: var(--radius-md);'}`}
>
  {#if loading && !isThumbnail && !simple}
    <div
      class="image-preview-loading"
      style={ratio === '16:9'
        ? 'position:absolute;inset:0;background:var(--bg-input);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-family:monospace;font-size:0.875rem;'
        : 'width:100%;padding-bottom:56.25%;background:var(--bg-input);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-family:monospace;font-size:0.875rem;'}
    >
      {t('common.loading')}
    </div>
  {/if}

  {#if failed && !simple}
    <div
      class="image-preview-error"
      style={ratio === '16:9'
        ? 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);color:var(--text-muted);font-size:0.875rem;text-align:center;padding:2rem;border-radius:var(--radius-md);'
        : 'width:100%;padding-bottom:56.25%;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);color:var(--text-muted);font-size:0.875rem;text-align:center;padding:2rem;border-radius:var(--radius-md);'}
    >
      {t('image_preview.load_failed')}
    </div>
  {/if}

  <img
    bind:this={img}
    class="image-preview-img"
    {alt}
    loading="lazy"
    decoding="async"
    draggable="false"
    oncontextmenu={(e) => e.preventDefault()}
    onload={onLoad}
    onerror={onError}
    onclick={(e) => { e.stopPropagation(); open(); }}
    style={ratio === '16:9'
      ? `width:100%;height:100%;object-fit:${fit ?? 'cover'};object-position:center;cursor:pointer;display:block;${isThumbnail ? '' : 'border-radius:var(--radius-md);'}`
      : `width:100%;height:auto;max-height:700px;cursor:pointer;display:block;${isThumbnail ? '' : 'border-radius:var(--radius-md);'}`}
  />
</div>
