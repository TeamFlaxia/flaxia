<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import ArcadeView from '../../lib/svelte/ArcadeView.svelte';
import SsrOnly from '../../lib/svelte/SsrOnly.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<ArcadeView />
<SsrOnly>
  <section class="ssr-feed" aria-label="Arcade games">
    <h1>Arcade</h1>
    {#each data.games as game (game.postId)}
      <article class="ssr-post">
        <h2><a href={`/arcade/${game.postId}`}>{game.title || 'Game'}</a></h2>
        {#if game.username}<p>@{game.username}</p>{/if}
        {#if game.thumbnailKey}
          <img class="ssr-post__media" src={`/api/thumbnail/${game.postId}`} alt="" loading="lazy" />
        {/if}
      </article>
    {/each}
  </section>
</SsrOnly>
