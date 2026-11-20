<script lang="ts">
import { mount, unmount } from 'svelte';
import PostComposer from './PostComposer.svelte';
import { getSessionUser } from './session.ts';

let host: HTMLDivElement;

$effect(() => {
  if (!host) return;
  const instance = mount(PostComposer, { target: host, props: { currentUser: getSessionUser() ?? undefined } });
  return () => unmount(instance);
});
</script>

<div bind:this={host}></div>
