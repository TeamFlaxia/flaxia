// Adapter for one profile post card. The card UI is owned by PostCard.svelte;
// keeping the mount in a .ts module means the Svelte list never builds DOM.
import type { Post } from '../../../shared/types/post.ts';
import { createPostCard } from '../../components/PostCard.js';

export interface UserPostCardUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
}

export interface UserPostCardOptions {
  sandboxOrigin: string;
  currentUser: UserPostCardUser | null;
  showPinOption?: boolean;
  pinnedPostId?: string | null;
  onTogglePin?: (postId: string) => void;
  onDelete?: (postId: string) => void;
}

export interface UserPostCardHandle {
  updatePost: (update: Partial<Post>) => void;
  destroy: () => void;
}

export function mountUserPostCard(host: HTMLElement, post: Post, options: UserPostCardOptions): UserPostCardHandle {
  const card = createPostCard({
    post,
    sandboxOrigin: options.sandboxOrigin,
    currentUser: options.currentUser,
    depth: post.depth,
    enablePostRefs: true,
    showPinOption: options.showPinOption,
    pinned: options.showPinOption ? post.id === (options.pinnedPostId ?? '') : undefined,
    onTogglePin: options.onTogglePin,
    onDelete: options.onDelete,
  });
  host.replaceChildren(card.getElement());
  return {
    updatePost: (update) => card.updatePost(update),
    destroy: () => card.destroy(),
  };
}
