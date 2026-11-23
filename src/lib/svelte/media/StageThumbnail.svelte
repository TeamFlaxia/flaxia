<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../../../lib/i18n.ts';
import { nativeApiHref } from '../../../lib/native-api.ts';
import { setOfflineImage } from '../../../lib/offline-image.ts';
import { isDataSaverEnabled } from '../../../lib/settings.js';

interface Props {
  postId: string;
  label: string;
  onActivate: () => void;
}

let { postId, label, onActivate }: Props = $props();

// Data-saver: skip thumbnail bytes for ZIP/SWF — the play overlay already
// requires a tap, so the poster is pure prefetch cost.
const skipThumbnail = isDataSaverEnabled();
let effectiveLabel = $derived(label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));

let img = $state<HTMLImageElement>();
let loaded = $state(false);
let failed = $state(false);

onMount(() => {
  if (skipThumbnail || !img) return;
  setOfflineImage(img, nativeApiHref(`/api/thumbnail/${postId}`));
});

function activate(event: Event): void {
  event.stopPropagation();
  onActivate();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onActivate();
}
</script>

<div
  class="thumbnail-overlay-container"
  role="button"
  tabindex="0"
  aria-label={effectiveLabel}
  data-data-saver={skipThumbnail ? '1' : undefined}
  style={skipThumbnail ? 'background: var(--bg-input);' : undefined}
  onclick={activate}
  onkeydown={onKeydown}
>
  <div class="thumbnail-media">
    {#if !skipThumbnail && !failed}
      <img
        bind:this={img}
        class:is-loaded={loaded}
        alt=""
        loading="lazy"
        decoding="async"
        onload={() => (loaded = true)}
        onerror={() => (failed = true)}
      />
    {/if}
    {#if failed}
      <div class="stage-fallback">{t('post_stage.thumbnail_unavailable')}</div>
    {/if}
    <div class="stage-play-overlay" aria-hidden="true">
      <span class="stage-play-icon">▶</span>
      <span class="stage-play-label">{effectiveLabel}</span>
    </div>
  </div>
</div>
