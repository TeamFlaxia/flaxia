// Adapter around the legacy user-post-list factory for the Svelte profile page.
import type { Post } from '../../../shared/types/post.ts';
import { type CurrentUser, createUserPostList } from '../../components/UserPostList.ts';

export interface UserPostListHandle {
  element: HTMLElement;
  addPost: (post: Post) => void;
  destroy: () => void;
}

export function mountUserPostList(
  host: HTMLElement,
  options: {
    username: string;
    sandboxOrigin: string;
    currentUser: CurrentUser | null;
    source?: 'posts' | 'freshs' | 'bookmarks';
    showPinOption?: boolean;
    onTogglePin?: (postId: string) => void;
  },
): UserPostListHandle {
  const list = createUserPostList(options);
  host.replaceChildren(list.getElement());
  return { element: host, addPost: list.addPost, destroy: list.destroy };
}
