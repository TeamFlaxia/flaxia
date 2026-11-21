// Post composer modal. The UI (overlay, drafts panel, Escape/overlay close and
// focus restoration) is owned by PostModal.svelte; this keeps the old factory
// API for callers.
import { type Component, mount, unmount } from 'svelte';
import type { Post, QuotedPost } from '../../shared/types/post.ts';
import PostModalView from './svelte/PostModal.svelte';

export function openPostModal(opts: {
  currentUser: { username: string; id?: string; display_name?: string; avatar_key?: string } | null | undefined;
  onPostCreated: (post: Post) => void;
  quotedPost?: QuotedPost | null;
}): void {
  const target = document.createElement('div');
  // Mount after attaching so the composer can focus its textarea.
  document.body.appendChild(target);

  let closed = false;
  let instance: Record<string, unknown> | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (instance) unmount(instance as never);
    instance = null;
    target.remove();
  };

  instance = mount(PostModalView as Component, {
    target,
    props: {
      currentUser: opts.currentUser ?? null,
      quotedPost: opts.quotedPost ?? null,
      onClose: close,
      onPostCreated: (post: Post) => {
        close();
        opts.onPostCreated(post);
      },
    },
  });
}
