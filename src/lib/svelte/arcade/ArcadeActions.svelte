<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { formatCount } from '../../format.ts';
import { t } from '../../i18n.ts';
import { iconHtml } from '../../post/icon-html.ts';

interface Props {
  freshCount: number;
  replyCount: number;
  bookmarkCount: number;
  isFreshed: boolean;
  isBookmarked: boolean;
  fullscreen: boolean;
  onFresh: () => void;
  onFullscreen: () => void;
  onShare: () => void;
  onComments: () => void;
  onBookmark: () => void;
  onReport: () => void;
}

let {
  freshCount,
  replyCount,
  bookmarkCount,
  isFreshed,
  isBookmarked,
  fullscreen,
  onFresh,
  onFullscreen,
  onShare,
  onComments,
  onBookmark,
  onReport,
}: Props = $props();
</script>

<div class="arcade-floating-actions">
  <button
    type="button"
    class="arcade-action-btn"
    class:is-active={isFreshed}
    data-action="fresh"
    data-tutorial="fresh"
    aria-label="Fresh"
    title="Fresh"
    hidden={fullscreen}
    onclick={onFresh}
  >
    <span class="arcade-action-icon">{@html iconHtml('fresh', 22)}</span>
    <span class="arcade-action-label">{formatCount(freshCount)}</span>
  </button>

  <button
    type="button"
    class="arcade-action-btn"
    data-action="fullscreen"
    data-tutorial="fullscreen"
    aria-label={t('arcade.fullscreen')}
    title={t('arcade.fullscreen')}
    onclick={onFullscreen}
  >
    <span class="arcade-action-icon">{@html iconHtml('maximize', 22)}</span>
  </button>

  <button
    type="button"
    class="arcade-action-btn"
    data-action="share"
    data-tutorial="share"
    aria-label="Share"
    title="Share"
    hidden={fullscreen}
    onclick={onShare}
  >
    <span class="arcade-action-icon">{@html iconHtml('share', 22)}</span>
  </button>

  <button
    type="button"
    class="arcade-action-btn"
    data-action="comments"
    data-tutorial="comments"
    aria-label={t('thread_view.title')}
    title={t('thread_view.title')}
    hidden={fullscreen}
    onclick={onComments}
  >
    <span class="arcade-action-icon">{@html iconHtml('reply', 22)}</span>
    <span class="arcade-action-label">{formatCount(replyCount)}</span>
  </button>

  <button
    type="button"
    class="arcade-action-btn"
    class:is-active={isBookmarked}
    data-action="bookmark"
    data-tutorial="bookmark"
    aria-label={t('arcade.bookmark')}
    title={t('arcade.bookmark')}
    hidden={fullscreen}
    onclick={onBookmark}
  >
    <span class="arcade-action-icon">{@html iconHtml('bookmark', 22)}</span>
    <span class="arcade-action-label">{formatCount(bookmarkCount)}</span>
  </button>

  <button
    type="button"
    class="arcade-action-btn"
    data-action="report"
    data-tutorial="report"
    aria-label={t('arcade.report')}
    title={t('arcade.report')}
    hidden={fullscreen}
    onclick={onReport}
  >
    <span class="arcade-action-icon">{@html iconHtml('flag', 22)}</span>
  </button>
</div>

<style>
  .arcade-floating-actions {
    position: absolute;
    right: 1rem;
    bottom: 1.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .arcade-action-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 52px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.15);
    color: rgba(255, 255, 255, 0.8);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .arcade-action-btn[hidden] {
    display: none;
  }

  .arcade-action-btn:hover {
    border-color: rgba(255, 255, 255, 0.4);
    background: rgba(255, 255, 255, 0.2);
  }

  .arcade-action-btn.is-active {
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.1);
    color: var(--accent);
  }

  .arcade-action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .arcade-action-label {
    margin-top: -1px;
    font-size: 0.6rem;
    font-weight: 600;
    color: inherit;
  }
</style>
