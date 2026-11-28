<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onDestroy } from 'svelte';
import { canUsePostColors } from '../../../shared/entitlements.ts';
import { stripPostColors } from '../../../shared/post-colors.ts';
import { stripMediaCues } from '../../../shared/post-cues.ts';
import { foldRemoteText } from '../../../shared/post-text.ts';
import type { PostTextProps } from '../../../shared/types/post.ts';
import { applyPostText } from '../../components/PostText.ts';
import { t } from '../i18n.ts';

let {
  text,
  mentions,
  enablePostRefs = false,
  authorId,
  badgeType = null,
  foldRemote = false,
}: PostTextProps = $props();

let host: HTMLDivElement;
let rich = $state(false);
let expanded = $state(false);
let generation = 0;

const enableColors = $derived(canUsePostColors({ badge_type: badgeType }));
const fold = $derived(foldRemote ? foldRemoteText(text) : null);
const visibleText = $derived(fold && !expanded ? fold.preview : text);

onDestroy(() => {
  // Invalidate any in-flight render before the host element goes away.
  generation++;
});

$effect(() => {
  const value = visibleText;
  const mentionData = mentions;
  const refs = enablePostRefs;
  const author = authorId;
  const colors = enableColors;
  const node = host;
  const gen = ++generation;
  rich = false;
  if (!node) return;

  // Plain text is visible immediately; Markdown/KaTeX/linkifiers replace it
  // once the lazily imported chunks resolve.
  node.textContent = colors ? stripPostColors(value) : stripMediaCues(value);

  void applyPostText(
    node,
    {
      text: value,
      mentions: mentionData,
      enableColors: colors,
      enablePostRefs: refs,
      authorId: author,
    },
    () => gen === generation,
  )
    .then(() => {
      if (gen === generation) rich = true;
    })
    .catch(() => {
      // Keep the plain-text placeholder when a lazily imported chunk fails.
    });
});
</script>

<div class="post-text-fold">
  <div bind:this={host} class="post-text" class:post-text--rich={rich}></div>
  {#if fold}
    <button
      type="button"
      class="post-text-fold-toggle"
      aria-expanded={expanded}
      onclick={(event) => {
        event.stopPropagation();
        expanded = !expanded;
      }}
    >
      {expanded ? t('post_text_show_less') : t('post_text_continue')}
    </button>
  {/if}
</div>

<style>
  .post-text-fold {
    min-width: 0;
  }

  .post-text-fold-toggle {
    margin-top: 0.25rem;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .post-text-fold-toggle:hover,
  .post-text-fold-toggle:focus-visible {
    text-decoration: underline;
  }
</style>
