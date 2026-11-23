<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onDestroy, untrack } from 'svelte';
import { parseMediaCues } from '../../../../shared/post-cues.ts';
import { type Post, PostCardMode } from '../../../../shared/types/post.ts';
import { buildMediaSlides } from '../../../components/MediaCarousel.js';
import { t } from '../../../lib/i18n.ts';
import { canExecuteStage, hasStageMedia, isZipGame, stageBoxRatio, stageClassFor } from '../../../lib/media/stage.ts';
import { runStageExecution, type StageExecutionHandle } from '../../../lib/media/stage-execution.ts';
import { setMediaMuted } from '../../../lib/media-mute.ts';
import MediaCarousel from './MediaCarousel.svelte';
import MediaSlide from './MediaSlide.svelte';
import StageLaunchButton from './StageLaunchButton.svelte';
import StageThumbnail from './StageThumbnail.svelte';

interface Props {
  post: Post;
  mode: PostCardMode;
  sandboxOrigin: string;
  versionId?: string;
  onModeChange: (mode: PostCardMode) => void;
}

let { post, mode, sandboxOrigin, versionId, onModeChange }: Props = $props();

let currentPost = $state(post);
let currentMode = $state(mode);
let currentVersionId = $state(versionId);

export function update(next: { post: Post; mode: PostCardMode; versionId?: string }): void {
  currentPost = next.post;
  currentMode = next.mode;
  currentVersionId = next.versionId;
}

let stageClass = $derived(stageClassFor(currentPost));
let boxRatio = $derived(stageBoxRatio(currentPost));
let media = $derived(hasStageMedia(currentPost));
let canExecute = $derived(canExecuteStage(currentPost));
let executing = $derived(canExecute && currentMode === PostCardMode.EXECUTING);
let attachments = $derived(currentPost.attachments ?? []);
let cueList = $derived(parseMediaCues(currentPost.text).cues);
let isZip = $derived(isZipGame(currentPost.payload_key));
let isSwf = $derived(!!currentPost.swf_key?.startsWith('swf/'));
let previewKey = $derived(
  [
    currentPost.id,
    currentPost.gif_key ?? '',
    currentPost.payload_key ?? '',
    currentPost.swf_key ?? '',
    currentPost.thumbnail_key ?? '',
    attachments.map((a) => `${a.kind}:${a.r2_key}`).join(','),
  ].join('|'),
);
let showHint = $derived(attachments.length === 0 && !isZip && !isSwf && !currentPost.gif_key);

let execHost = $state<HTMLDivElement>();
let errorMessage = $state<string | null>(null);
let handle: StageExecutionHandle | null = null;
let execVersion: string | null = null;
let execPostId: string | null = null;
let executionToken = 0;
let disposed = false;

function requestToggle(): void {
  if (attachments.length > 0) return;
  if (!currentPost.payload_key && !currentPost.swf_key) return;
  onModeChange(currentMode === PostCardMode.PREVIEW ? PostCardMode.EXECUTING : PostCardMode.PREVIEW);
}

function onRootClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('.zip-execution-button')) return;
  if (target.closest('.video-player, .audio-player, .image-preview')) return;
  if (isZip) event.stopPropagation();
  requestToggle();
}

function destroyExecution(): void {
  executionToken++;
  handle?.destroy();
  handle = null;
  execVersion = null;
  execPostId = null;
  if (execHost) execHost.replaceChildren();
}

async function ensureExecution(postToRun: Post, version: string | null): Promise<void> {
  if (!execHost) return;

  if (handle && execPostId === postToRun.id && execVersion === version && execHost.querySelector('iframe')) {
    setMediaMuted(execHost, false);
    return;
  }

  executionToken++;
  handle?.destroy();
  handle = null;
  execHost.replaceChildren();
  errorMessage = null;
  execVersion = version;
  execPostId = postToRun.id;

  const token = executionToken;
  try {
    const next = await runStageExecution(postToRun, execHost, sandboxOrigin, version);
    if (disposed || token !== executionToken) {
      next.destroy();
      return;
    }
    handle = next;
    setMediaMuted(execHost, currentMode !== PostCardMode.EXECUTING);
  } catch (error) {
    if (disposed || token !== executionToken) return;
    console.error('Failed to execute post content:', error);
    execHost.replaceChildren();
    errorMessage = isZipGame(postToRun.payload_key)
      ? t('post_stage.zip_load_error')
      : postToRun.swf_key
        ? t('post_stage.flash_load_error')
        : t('common.error');
  }
}

$effect(() => {
  const postId = currentPost.id;
  const shouldExecute = executing;
  const version = currentVersionId ?? null;
  if (!shouldExecute) {
    if (execHost) setMediaMuted(execHost, true);
    return;
  }
  if (!execHost) return;
  untrack(() => {
    void ensureExecution(currentPost, version);
  });
  void postId;
});

$effect(() => {
  if (!media) untrack(destroyExecution);
});

onDestroy(() => {
  disposed = true;
  destroyExecution();
});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="post-stage {stageClass ?? ''}"
  class:fx-box={boxRatio !== null}
  style={boxRatio ? `--fx-ratio: ${boxRatio}` : undefined}
  onclick={onRootClick}
>
  {#if media}
    <div class="post-stage-layer post-stage-layer--preview" hidden={executing}>
      {#key previewKey}
        {#if attachments.length > 0}
          <MediaCarousel postId={currentPost.id} slides={buildMediaSlides({ postId: currentPost.id, attachments, cues: cueList })} cues={cueList} />
        {:else if isZip}
          {#if currentPost.thumbnail_key}
            <StageThumbnail
              postId={currentPost.id}
              label={t('post_stage.run_zip')}
              onActivate={() => onModeChange(PostCardMode.EXECUTING)}
            />
          {:else}
            <StageLaunchButton
              variant="zip"
              label={t('post_stage.click_execute_zip')}
              icon="▶"
              onActivate={() => onModeChange(PostCardMode.EXECUTING)}
            />
          {/if}
        {:else if isSwf}
          {#if currentPost.thumbnail_key}
            <StageThumbnail
              postId={currentPost.id}
              label={t('post_stage.play_flash')}
              onActivate={() => onModeChange(PostCardMode.EXECUTING)}
            />
          {:else}
            <StageLaunchButton
              variant="flash"
              label={t('post_stage.click_play_flash')}
              icon="▶"
              onActivate={() => onModeChange(PostCardMode.EXECUTING)}
            />
          {/if}
        {:else if currentPost.gif_key?.startsWith('audio/')}
          <MediaSlide kind="audio" postId={currentPost.id} gifKey={currentPost.gif_key} cues={cueList} />
        {:else if currentPost.gif_key?.startsWith('video/')}
          <MediaSlide kind="video" postId={currentPost.id} gifKey={currentPost.gif_key} cues={cueList} />
        {:else if currentPost.gif_key}
          <MediaSlide kind="image" postId={currentPost.id} gifKey={currentPost.gif_key} ratio="16:9" />
        {:else if currentPost.thumbnail_key}
          <MediaSlide kind="image" postId={currentPost.id} gifKey={currentPost.thumbnail_key} isThumbnail ratio="16:9" />
        {/if}
      {/key}
      {#if showHint}
        <div class="stage-hint">{t('post_stage.click_to_run')}</div>
      {/if}
    </div>

    <div class="post-stage-layer post-stage-layer--execution" hidden={!executing}>
      <div bind:this={execHost} class="post-stage-execution-host" style="display: contents;"></div>
      {#if errorMessage !== null}
        <div class="stage-error">{errorMessage}</div>
      {/if}
    </div>
  {/if}
</div>
