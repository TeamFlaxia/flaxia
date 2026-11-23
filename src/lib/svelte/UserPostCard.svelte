<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { mountUserPostCard, type UserPostCardHandle, type UserPostCardOptions } from './user-post-card.ts';

let { post, options }: { post: Post; options: UserPostCardOptions } = $props();

let host: HTMLDivElement;
let handle: UserPostCardHandle | null = null;
let lastPost: Post | null = null;

onMount(() => {
  handle = mountUserPostCard(host, post, options);
  return () => {
    handle?.destroy();
    handle = null;
  };
});

$effect(() => {
  // Re-render only when the row is replaced; the card keeps its own action
  // state, and mounting already rendered the first value.
  if (post === lastPost) return;
  const firstRender = lastPost === null;
  lastPost = post;
  if (!firstRender) handle?.updatePost(post);
});
</script>

<div bind:this={host} class="user-post-card-host"></div>
