<script lang="ts">
import { onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { navigate } from '../navigation.ts';
import { hasSsrHandover, SSR_HANDOVER_EVENT } from '../ssr-handover.ts';
import SsrPostCard from './SsrPostCard.svelte';

// Keep server-rendered posts mounted until the interactive timeline has its own
// data (no blank-feed flash), but make them clickable in the meantime: a click
// on the post body navigates to the thread just like the interactive card.
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

function onFeedClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('a, button')) return;
  const id = target.closest<HTMLElement>('[data-ssr-post-id]')?.dataset.ssrPostId;
  if (id) void navigate(`/thread/${encodeURIComponent(id)}`);
}
</script>

{#if !handover && posts.length > 0}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section class="ssr-feed" aria-label={label} onclick={onFeedClick}>
    {#each posts as post, index (post.id)}
      <div data-ssr-post-id={post.id}>
        <SsrPostCard {post} isReply={index > 0} />
      </div>
    {/each}
  </section>
{/if}
