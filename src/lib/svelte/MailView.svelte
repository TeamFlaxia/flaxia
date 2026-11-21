<script lang="ts">
import { onMount } from 'svelte';
import { navigate } from '../navigation.ts';
import { viewToPath } from '../view-nav.ts';
import MailPage from './MailPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';
import { getSessionUser } from './session.ts';

type MailViewKind = 'mail' | 'settings' | 'thread' | 'compose';
let { view, threadId = '' }: { view: MailViewKind; threadId?: string } = $props();

let host: HTMLDivElement;
// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as { id: string; username: string } | undefined;
    if (!user) {
      void navigate('/explore', { replaceState: true });
      return;
    }
    const currentUser = { id: user.id, username: user.username };

    let page: { getElement: () => HTMLElement; destroy: () => void };
    if (view === 'settings') {
      const { createMailSettingsPage } = await import('../../components/MailSettingsPage.ts');
      page = createMailSettingsPage({ currentUser });
    } else if (view === 'thread') {
      const { createMailThreadPage } = await import('../../components/MailThreadPage.ts');
      page = createMailThreadPage({ currentUser, threadId });
    } else if (view === 'compose') {
      const { createMailComposePage } = await import('../../components/MailComposePage.ts');
      const { takePendingDraftId } = await import('../../lib/mail/navigation.ts');
      page = createMailComposePage({ currentUser, draftId: takePendingDraftId() || undefined });
    } else {
      // The mailbox list is Svelte-owned; the other Mail surfaces remain legacy.
      dispose = () => {};
    }
    if (page) {
      host.appendChild(page.getElement());
      dispose = () => page.destroy();
    }
    navProps = {
      activeItem: 'mail',
      currentUser,
      ...leftNavCallbacks({
        navigate: (target, postId, username) => void navigate(viewToPath(target, postId, username)),
        getCurrentUsername: () => currentUser.username,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  {#if view === 'mail'}
    <MailPage currentUser={(getSessionUser() ?? null) as { id: string; username: string } | null} />
  {:else}
    <div bind:this={host}></div>
  {/if}
</ShellLayout>
