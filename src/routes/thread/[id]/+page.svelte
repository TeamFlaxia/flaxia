<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { getSessionUser } from '../../../lib/svelte/session.ts';

let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../../lib/i18n.ts');
    await initI18n();
    const user = getSessionUser() as
      | { id: string; username: string; display_name?: string; avatar_key?: string }
      | undefined;
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
