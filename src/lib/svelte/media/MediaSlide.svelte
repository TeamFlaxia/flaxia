<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onDestroy } from 'svelte';
import type { MediaCue } from '../../../../shared/post-cues.ts';
import { attachDocumentViewer } from '../../../components/DocumentViewer.js';
import { type MediaCueOverlay, mountMediaCueOverlay } from '../../../components/MediaCues.js';
import { t } from '../../../lib/i18n.ts';
import { isAbsoluteMediaUrl, mediaBaseName } from '../../../lib/media/attachments.ts';
import { openImageLightbox } from '../../../lib/media/image-lightbox.ts';
import { nativeApiHref } from '../../../lib/native-api.ts';
import { isDataSaverEnabled } from '../../../lib/settings.js';
import AudioPlayer from '../AudioPlayer.svelte';
import ImagePreview from '../ImagePreview.svelte';
import VideoPlayer from '../VideoPlayer.svelte';
import DataSaverPlaceholder from './DataSaverPlaceholder.svelte';

interface Props {
  kind: 'image' | 'audio' | 'video' | 'document';
  postId: string;
  /** Direct URL (attachments / remote ActivityPub media). */
  src?: string;
  /** R2 key for the media proxy routes. */
  gifKey?: string;
  isThumbnail?: boolean;
  ratio?: '16:9';
  fit?: string;
  cues?: MediaCue[];
  gallery?: string[];
  galleryIndex?: number;
}

let { kind, postId, src, gifKey, isThumbnail, ratio, fit, cues, gallery, galleryIndex }: Props = $props();

const remote = $derived(isAbsoluteMediaUrl(src ?? gifKey ?? ''));
const dataSaver = typeof window !== 'undefined' && isDataSaverEnabled();
let confirmed = $state(false);

let mediaUrl = $derived(
  src ??
    (kind === 'image'
      ? nativeApiHref(isThumbnail ? `/api/thumbnail/${postId}` : `/api/images/${gifKey}`)
      : nativeApiHref(`/api/${kind}/${gifKey}`)),
);
let gated = $derived(dataSaver && !confirmed && (kind === 'video' || !src));

const cueOverlay: MediaCueOverlay | null = kind === 'audio' || kind === 'video' ? mountMediaCueOverlay(cues) : null;
onDestroy(() => cueOverlay?.destroy());

function documentHost(
  node: HTMLElement,
  options: { r2Key: string },
): { update: (next: { r2Key: string }) => void; destroy: () => void } {
  let current = options;
  let handle = attachDocumentViewer(node, current);
  return {
    update(next) {
      if (next.r2Key === current.r2Key) return;
      handle.destroy();
      current = next;
      handle = attachDocumentViewer(node, next);
    },
    destroy: () => handle.destroy(),
  };
}

function openOverlay(): void {
  openImageLightbox(mediaUrl, postId, gallery, galleryIndex ?? 0);
}

function onCueTime(time: number): void {
  cueOverlay?.update(time);
}
</script>

{#if kind === 'image'}
  {#if gated}
    <div class="image-preview">
      <DataSaverPlaceholder label={t('media.data_saver_load_image')} onLoad={() => (confirmed = true)} />
    </div>
  {:else}
    <ImagePreview
      imageUrl={mediaUrl}
      baseImageUrl={mediaUrl}
      {postId}
      alt={t('image_preview.post_preview', { id: postId })}
      {ratio}
      {fit}
      {isThumbnail}
      simple={!!src}
      onOpenOverlay={openOverlay}
    />
  {/if}
{:else if kind === 'audio'}
  {#if gated}
    <DataSaverPlaceholder
      label={t('media.data_saver_load_audio')}
      extraClass="audio-player"
      onLoad={() => (confirmed = true)}
    />
  {:else}
    <AudioPlayer audioUrl={mediaUrl} cueElement={cueOverlay?.element ?? null} onCueTime={onCueTime} />
  {/if}
{:else if kind === 'video'}
  {#if gated}
    <DataSaverPlaceholder
      label={t('media.data_saver_load_video')}
      extraClass="video-player"
      onLoad={() => (confirmed = true)}
    />
  {:else}
    <VideoPlayer videoUrl={mediaUrl} cueElement={cueOverlay?.element ?? null} onCueTime={onCueTime} />
  {/if}
{:else if kind === 'document'}
  {#if !remote && (gifKey ?? '').toLowerCase().endsWith('.pdf')}
    <div use:documentHost={{ r2Key: gifKey ?? '' }}></div>
  {:else}
    <a
      class="file-preview-doc-chip"
      href={mediaUrl}
      target={remote ? '_blank' : undefined}
      rel={remote ? 'noopener noreferrer' : undefined}
      download={remote ? undefined : true}
    >
      ▤ {mediaBaseName(gifKey ?? mediaUrl)} · {t(
        remote ? 'composer.preview_open_document' : 'composer.download_file',
      )}
    </a>
  {/if}
{/if}
