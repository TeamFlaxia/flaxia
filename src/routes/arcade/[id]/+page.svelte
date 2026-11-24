<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import ArcadeView from '../../../lib/svelte/ArcadeView.svelte';
import SsrOnly from '../../../lib/svelte/SsrOnly.svelte';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const ssrPosts = $derived(data.post ? [data.post, ...data.replies] : []);
</script>

{#key page.params.id}
  <ArcadeView gameId={page.params.id} />
  <SsrOnly>
    <section class="ssr-feed" aria-label="Game">
      <h1>{data.game?.title || 'Game'}</h1>
      {#if data.game?.username}<p>@{data.game.username}</p>{/if}
    </section>
  </SsrOnly>
  <SsrPostList posts={ssrPosts} label="Game post" />
{/key}
