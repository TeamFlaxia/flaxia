<script lang="ts">
import { onMount } from 'svelte';
import { takePendingDraftId } from '../mail/navigation.ts';
import { navigate } from '../navigation.ts';
import { viewToPath } from '../view-nav.ts';
import MailComposePage from './MailComposePage.svelte';
import MailPage from './MailPage.svelte';
import MailSettingsPage from './MailSettingsPage.svelte';
import MailThreadPage from './MailThreadPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';
import { getSessionUser } from './session.ts';
import '../../styles/redesign/mail.css';

type MailViewKind = 'mail' | 'settings' | 'thread' | 'compose';
let { view, threadId = '' }: { view: MailViewKind; threadId?: string } = $props();

// Draft ids ride in memory; consume once when the compose route mounts.
let pendingDraftId = view === 'compose' ? takePendingDraftId() || undefined : undefined;

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps = $state<Record<string, unknown>>({});

// The session only exists in the browser. Starting from null keeps SSR and
// the first client render identical; onMount adopts the real session.
let currentUser = $state<{ id: string; username: string } | null>(null);

onMount(() => {
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as { id: string; username: string } | undefined;
    if (!user) {
      void navigate('/explore', { replaceState: true });
      return;
    }
    currentUser = user;
    navProps = {
      activeItem: 'mail',
      currentUser: user,
      ...leftNavCallbacks({
        navigate: (target, postId, username) => void navigate(viewToPath(target, postId, username)),
        getCurrentUsername: () => user.username,
      }),
    };
  })();
});
</script>

<ShellLayout {navProps} showRightPanel={false}>
  {#if view === 'mail'}
    <MailPage {currentUser} />
  {:else if view === 'settings'}
    <MailSettingsPage {currentUser} />
  {:else if view === 'thread'}
    <MailThreadPage {currentUser} {threadId} />
  {:else}
    <MailComposePage {currentUser} draftId={pendingDraftId} />
  {/if}
</ShellLayout>
