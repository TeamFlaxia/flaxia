// Adapters around legacy DOM card factories. Kept in a .ts module so the
// Svelte timeline never calls a create* factory directly.
import { type Ad, type Post, PostCardMode } from '../../../shared/types/post.ts';
import { createAdCard } from '../../components/AdCard.js';
import { createPostCard, type PostCard } from '../../components/PostCard.js';

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

export function mountAdCard(host: HTMLElement, ad: Ad): void {
  host.replaceChildren(createAdCard(ad));
}
