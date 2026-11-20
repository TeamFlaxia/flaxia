<script lang="ts">
import { onMount } from 'svelte';
import type { Ad, Post } from '../../../shared/types/post.ts';
import { isAd } from '../../../shared/types/post.ts';
import { type CardHandle, type CardOptions, mountAdCard, mountPostCard } from './cards.ts';

let { item, options }: { item: Post | Ad; options: CardOptions } = $props();

let host: HTMLDivElement;
let handle: CardHandle | null = null;
let adMounted = false;

onMount(() => {
  if (isAd(item)) {
    mountAdCard(host, item);
    adMounted = true;
  } else {
    handle = mountPostCard(host, item, options);
  }
  return () => handle?.destroy();
});

$effect(() => {
  if (!isAd(item) && handle) handle.update(item);
});
</script>

<div bind:this={host} class="timeline-item-host" data-item-id={item.id}></div>
