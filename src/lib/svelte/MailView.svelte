<script lang="ts">
import { onMount } from 'svelte';
import { getSessionUser } from './session.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';

type MailViewKind = 'mail' | 'settings' | 'thread' | 'compose';
let { view, threadId = '' }: { view: MailViewKind; threadId?: string } = $props();

let host: HTMLDivElement;
// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

const pathFor = (target: string, postId?: string, username?: string): string => {
  if (target === 'timeline') return '/home';
  if (target === 'profile') return `/profile/${username ?? ''}`;
  return `/${target}`;
};

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { createLeftNavHandlers } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as { id: string; username: string } | undefined;
    if (!user) {
      window.location.replace('/explore');
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
      const { createMailPage } = await import('../../components/MailPage.ts');
      page = createMailPage({ currentUser });
    }
    host.appendChild(page.getElement());
    dispose = page.destroy;
    navProps = {
      activeItem: 'mail',
      currentUser,
      ...createLeftNavHandlers({
        navigate: (target, postId, username) => window.location.assign(pathFor(target, postId, username)),
        getCurrentUsername: () => currentUser.username,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
