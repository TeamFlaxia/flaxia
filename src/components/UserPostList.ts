// Legacy-compatible bridge: the profile post list UI is owned by
// UserPostList.svelte; this keeps the factory API and mounts it.
import { type Component, mount, unmount } from 'svelte';
import type { Post } from '../../shared/types/post.ts';
import UserPostListView from '../lib/svelte/UserPostList.svelte';

export interface CurrentUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
}

interface Instance {
  addPost: (post: Post) => void;
}

export function createUserPostList(props: {
  username: string;
  sandboxOrigin: string;
  currentUser: CurrentUser | null;
  source?: 'posts' | 'freshs' | 'bookmarks';
  showPinOption?: boolean;
  pinnedPostId?: string | null;
  onTogglePin?: (postId: string) => void;
}): { getElement: () => HTMLElement; addPost: (post: Post) => void; destroy: () => void } {
  const element = document.createElement('div');
  element.className = 'user-post-list';
  const instance = mount(UserPostListView as Component, {
    target: element,
    props: props as never,
  }) as unknown as Instance & Parameters<typeof unmount>[0];

  return {
    getElement: () => element,
    addPost: (post) => instance.addPost(post),
    destroy: () => {
      void unmount(instance);
      element.remove();
    },
  };
}
