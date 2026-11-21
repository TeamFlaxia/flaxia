// Legacy-compatible bridge: the post card UI is owned by PostCard.svelte.
import { type Component, mount, unmount } from 'svelte';
import type { Post, PostCardProps } from '../../shared/types/post.ts';
import PostCardView from '../lib/svelte/PostCard.svelte';

export type { PostCardMode } from '../../shared/types/post.ts';

interface Instance {
  updatePost: (post: Partial<Post>) => void;
  handleReplyTogglePublic: () => void;
}

export class PostCard {
  private element: HTMLElement;
  private instance: Instance | null = null;

  constructor(props: PostCardProps) {
    this.element = document.createElement('div');
    this.instance = mount(PostCardView as Component, {
      target: this.element,
      props: props as never,
    }) as unknown as Instance;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  updatePost(post: Partial<Post>): void {
    this.instance?.updatePost(post);
  }

  handleReplyTogglePublic(): void {
    this.instance?.handleReplyTogglePublic();
  }

  destroy(): void {
    if (this.instance) unmount(this.instance as never);
    this.instance = null;
    this.element.remove();
  }
}

export function createPostCard(props: PostCardProps): PostCard {
  return new PostCard(props);
}
