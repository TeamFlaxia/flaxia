<script lang="ts">
import { onMount } from 'svelte';
import { getSessionUser } from './session.ts';

let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { createPostComposer } = await import('../../components/PostComposer.ts');
    const composer = createPostComposer({ currentUser: getSessionUser() ?? undefined });
    host.appendChild(composer.getElement());
    dispose = composer.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
