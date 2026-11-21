<script lang="ts">
import { mount, onDestroy, onMount, unmount } from 'svelte';
import type { Post, QuotedPost } from '../../../shared/types/post.ts';
import { t } from '../i18n.ts';
import { getModalCount, registerModal } from '../modal-state.ts';
import { iconHtml } from '../post/icon-html.ts';
import type { Draft } from './ComposerDraftsPanel.svelte';
import ComposerDraftsPanel from './ComposerDraftsPanel.svelte';
import PostComposer from './PostComposer.svelte';

interface CurrentUser {
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  id?: string;
}

interface ComposerApi {
  focus: () => void;
  setText: (value: string) => void;
  getSavedDrafts: () => Draft[];
  deleteDraftPublic: (id: string) => void;
  saveDraftPublic: () => void;
  deleteAllDraftsPublic: () => void;
}

let {
  currentUser = null,
  quotedPost = null,
  onPostCreated,
  onClose,
}: {
  currentUser?: CurrentUser | null;
  quotedPost?: QuotedPost | null;
  onPostCreated: (post: Post) => void;
  onClose: () => void;
} = $props();

let composerHost: HTMLDivElement;
let composer: ComposerApi | null = null;
let drafts = $state<Draft[]>([]);
let closed = false;
let previouslyFocused: HTMLElement | null = null;
let unregister: (() => void) | null = null;

function refreshDrafts(): void {
  drafts = composer?.getSavedDrafts() ?? [];
}

function close(): void {
  if (closed) return;
  closed = true;
  onClose();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // A confirm dialog (or any stacked modal) owns Escape while it is on top.
  if (getModalCount() > 1) return;
  event.preventDefault();
  close();
}

onMount(() => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  unregister = registerModal();
  composer = mount(PostComposer, {
    target: composerHost,
    props: {
      currentUser: currentUser ?? undefined,
      quotedPost,
      onPostCreated: (post: Post) => onPostCreated(post),
      onDraftSaved: refreshDrafts,
    },
  }) as unknown as ComposerApi;
  refreshDrafts();
  composer.focus();
  document.addEventListener('keydown', onKeyDown);
});

onDestroy(() => {
  document.removeEventListener('keydown', onKeyDown);
  if (composer) {
    unmount(composer as never);
    composer = null;
  }
  unregister?.();
  unregister = null;
  if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
  previouslyFocused = null;
});
</script>

<div
  class="post-modal-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) close();
  }}
>
  <div class="post-modal-dialog" role="dialog" aria-modal="true" aria-label={t('composer.post_button')}>
    <button type="button" class="post-modal-close" aria-label={t('common.cancel')} onclick={close}>
      {@html iconHtml('close', 16)}
    </button>
    <div bind:this={composerHost}></div>
    <ComposerDraftsPanel
      {drafts}
      onSave={() => {
        composer?.saveDraftPublic();
        refreshDrafts();
      }}
      onLoad={(draft) => {
        composer?.setText(draft.text);
        composer?.focus();
      }}
      onDelete={(id) => {
        composer?.deleteDraftPublic(id);
        refreshDrafts();
      }}
      onDeleteAll={() => {
        composer?.deleteAllDraftsPublic();
        refreshDrafts();
      }}
    />
  </div>
</div>
