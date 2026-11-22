// Adapters around legacy DOM card factories. Kept in a .ts module so the
// Svelte timeline never calls a create* factory directly.

import { mount, unmount } from 'svelte';
import { type Ad, type Post, PostCardMode } from '../../../shared/types/post.ts';
import { createPostCard, type PostCard } from '../../components/PostCard.js';
import AdCard from '../svelte/AdCard.svelte';

export interface CardHandle {
  element: HTMLElement;
  update: (post: Partial<Post>) => void;
  destroy: () => void;
}

export interface CardOptions {
  sandboxOrigin: string;
  currentUser: PostCardPropsUser | null;
  onDelete: (postId: string) => void;
}

type PostCardPropsUser = {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
};

export function mountPostCard(host: HTMLElement, post: Post, options: CardOptions): CardHandle {
  const card: PostCard = createPostCard({
    post,
    currentUser: options.currentUser,
    sandboxOrigin: options.sandboxOrigin,
    initialMode: PostCardMode.PREVIEW,
    depth: post.depth,
    onDelete: options.onDelete,
  });
  host.replaceChildren(card.getElement());
  return {
    element: host,
    update: (next) => card.updatePost(next),
    destroy: () => card.destroy(),
  };
}

export function mountAdCard(host: HTMLElement, ad: Ad): CardHandle {
  host.replaceChildren();
  const instance = mount(AdCard, { target: host, props: { ad } });
  return {
    element: host,
    update: () => undefined,
    destroy: () => {
      void unmount(instance);
    },
  };
}
