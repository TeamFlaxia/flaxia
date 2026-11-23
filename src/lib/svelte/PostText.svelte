<script lang="ts">
import { onDestroy } from 'svelte';
import { canUsePostColors } from '../../../shared/entitlements.ts';
import { stripPostColors } from '../../../shared/post-colors.ts';
import { stripMediaCues } from '../../../shared/post-cues.ts';
import type { PostTextProps } from '../../../shared/types/post.ts';
import { applyPostText } from '../../components/PostText.ts';

let { text, mentions, enablePostRefs = false, authorId, badgeType = null }: PostTextProps = $props();

let host: HTMLDivElement;
let rich = $state(false);
let generation = 0;

const enableColors = $derived(canUsePostColors({ badge_type: badgeType }));

onDestroy(() => {
  // Invalidate any in-flight render before the host element goes away.
  generation++;
});

$effect(() => {
  const value = text;
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

<div bind:this={host} class="post-text" class:post-text--rich={rich}></div>
