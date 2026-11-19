<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';

let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../../lib/i18n.ts');
    const { getMe } = await import('../../../lib/auth-cache.ts');
    await initI18n();
    const me = await getMe();
    const user = me?.user as { id: string; username: string; display_name?: string; avatar_key?: string } | undefined;
    const { createThreadPage } = await import('../../../components/ThreadPage.ts');
    const thread = createThreadPage({
      postId: page.params.id,
      sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
      currentUser: user ?? null,
      unreadCount: 0,
      onBack: () => window.location.assign('/home'),
    });
    host.appendChild(thread.getElement());
    dispose = thread.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>

<style>
  :global(#app) {
    display: none;
  }
</style>
