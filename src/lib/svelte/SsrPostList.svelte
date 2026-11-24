<script lang="ts">
import { onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import SsrPostCard from './SsrPostCard.svelte';

// Server-rendered fallback content. `hydrated` starts false on both the server
// and the first client render (so hydration matches), then flips in onMount to
// hand the page over to the interactive components.
let { posts, label = 'Posts' }: { posts: Post[]; label?: string } = $props();

let hydrated = $state(false);
onMount(() => {
  hydrated = true;
});
</script>

{#if !hydrated && posts.length > 0}
  <section class="ssr-feed" aria-label={label}>
    {#each posts as post, index (post.id)}
      <SsrPostCard {post} isReply={index > 0} />
    {/each}
  </section>
{/if}
