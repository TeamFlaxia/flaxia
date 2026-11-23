<script module lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: instance markup reads this counter
let shareModalId = 0;
</script>

<script lang="ts">
  // biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
  // biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
  import { onMount } from 'svelte';
  import { t } from '../i18n.ts';
  import { iconHtml } from '../post/icon-html.ts';
  import {
    canUseWebShare,
    copyToClipboard,
    createShareData as buildShareData,
    type ShareData,
    sharePlatforms,
    shareViaWebShare,
    shareViaWebShareWithFile,
  } from '../share.ts';
  import { displayShareIcon, platformLabelKey } from '../modals/dialog-logic.ts';
  import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';

  export interface ShareMedia {
    blob: Blob;
    filename: string;
  }

  interface Props {
    post: {
      id: string;
      text: string;
      username: string;
      display_name?: string;
    };
    url?: string;
    media?: ShareMedia;
    onClose: () => void;
    onQuote?: () => void;
  }

  let { post, url: customUrl, media, onClose, onQuote }: Props = $props();

  shareModalId += 1;
  const titleId = `share-modal-title-${shareModalId}`;
  const nativeAvailable = canUseWebShare();

  const shareData = $derived.by((): ShareData => {
    const data = buildShareData(post);
    if (customUrl) data.url = customUrl;
    return data;
  });
  const shareUrl = $derived(shareData.url);

  let objectUrl = $state<string | null>(null);

  $effect.pre(() => {
    if (!media) return;
    const nextUrl = URL.createObjectURL(media.blob);
    objectUrl = nextUrl;
    return () => URL.revokeObjectURL(nextUrl);
  });

  let overlayEl: HTMLDivElement;
  let dialogEl: HTMLDivElement;
  let controller: ModalBehavior | null = null;
  let feedbackMessage = $state('');
  let feedbackVisible = $state(false);
  let feedbackTimer = 0;

  function showFeedback(message: string): void {
    feedbackMessage = message;
    feedbackVisible = true;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      feedbackVisible = false;
    }, 2200);
  }

  function requestClose(after?: () => void): void {
    controller?.close(after);
  }

  async function handleNativeShare(): Promise<void> {
    if (media && nativeAvailable) {
      const file = new File([media.blob], media.filename, { type: media.blob.type });
      const success = await shareViaWebShareWithFile(shareData, file);
      if (success) requestClose();
      else showFeedback(t('share.native_failed'));
      return;
    }
    const success = await shareViaWebShare(shareData);
    if (success) requestClose();
    else showFeedback(t('share.native_failed'));
  }

  async function handleCopy(): Promise<void> {
    const success = await copyToClipboard(shareUrl);
    showFeedback(success ? t('share.copy_success') : t('share.copy_failed'));
  }

  function platformName(name: string): string {
    return t(platformLabelKey(name));
  }

  onMount(() => {
    controller = attachModalBehavior({
      overlay: overlayEl,
      dialog: dialogEl,
      onClose,
      animated: true,
    });
    return () => {
      controller?.destroy();
      window.clearTimeout(feedbackTimer);
    };
  });
</script>

<div
  class="fx-overlay fx-share-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) requestClose();
  }}
>
  <div
    class="fx-dialog fx-share-modal"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
  >
    <header class="fx-share__head">
      <h3 class="fx-share__title" id={titleId}>{t('share.title')}</h3>
      <button type="button" class="fx-icon-btn fx-share__close" aria-label={t('common.close')} onclick={() => requestClose()}>
        <span class="action-icon">{@html iconHtml('close')}</span>
      </button>
    </header>
    <div class="fx-share__body">
      {#if media}
        <div class="fx-share__media">
          <img src={objectUrl ?? ''} alt={t('share.media_preview')} />
        </div>
        <p class="fx-share__hint">{t('share.save_hint')}</p>
      {/if}
      {#if nativeAvailable}
        <button type="button" class="fx-share__primary share-button--native" onclick={() => void handleNativeShare()}>
          <span class="action-icon">{@html iconHtml('send')}</span>
          <span>{t('share.native')}</span>
        </button>
      {/if}
      {#if onQuote}
        <button
          type="button"
          class="fx-share__secondary share-button--quote"
          onclick={() => {
            if (onQuote) requestClose(onQuote);
          }}
        >
          <span class="action-icon">{@html iconHtml('quote')}</span>
          <span>{t('share.quote')}</span>
        </button>
      {/if}
      <div class="fx-share__linkrow">
        <input
          class="fx-share__link"
          type="text"
          readonly
          aria-label={t('share.copy_link')}
          value={shareUrl}
          onfocus={(event) => event.currentTarget.select()}
        />
        <button type="button" class="fx-share__copy share-button--clipboard" onclick={() => void handleCopy()}>
          <span class="action-icon">{@html iconHtml('copy')}</span>
          <span>{t('share.copy_link')}</span>
        </button>
      </div>
      <div class="fx-share__divider">{t('share.share_to')}</div>
      <div class="fx-share__grid">
        {#each sharePlatforms as platform (platform.name)}
          <a
            class="fx-share__tile share-icon"
            href={platform.getUrl(shareData)}
            target="_blank"
            rel="noopener noreferrer"
            onclick={() => requestClose()}
          >
            <span class="fx-share__icon" aria-hidden="true">{displayShareIcon(platform.icon, platform.name)}</span>
            <span class="fx-share__name">{platformName(platform.name)}</span>
          </a>
        {/each}
      </div>
      <div class="fx-share__feedback" class:is-visible={feedbackVisible} role="status" aria-live="polite">
        {feedbackMessage}
      </div>
    </div>
  </div>
</div>
