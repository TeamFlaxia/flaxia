<script lang="ts">
import { onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { hasSsrHandover, SSR_HANDOVER_EVENT } from '../ssr-handover.ts';
import SsrPostCard from './SsrPostCard.svelte';

// Server-rendered fallback content. `handover` starts false on both the server
// and the first client render (so hydration matches), then flips when the
// interactive timeline/thread view has rendered its own posts.
let { posts, label = 'Posts' }: { posts: Post[]; label?: string } = $props();

let handover = $state(false);
onMount(() => {
  if (hasSsrHandover()) {
    handover = true;
    return;
  }
  const onHandover = () => {
    handover = true;
  };
  window.addEventListener(SSR_HANDOVER_EVENT, onHandover);
  return () => window.removeEventListener(SSR_HANDOVER_EVENT, onHandover);
});
</script>

{#if !handover && posts.length > 0}
  <section class="ssr-feed" aria-label={label}>
    {#each posts as post, index (post.id)}
      <SsrPostCard {post} isReply={index > 0} />
    {/each}
  </section>
{/if}
