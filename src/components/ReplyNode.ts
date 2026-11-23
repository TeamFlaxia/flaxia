// Legacy-compatible bridge: the reply-tree UI lives in
// src/lib/svelte/ReplyNode.svelte; callers keep the old factory API.
import { type Component, mount, unmount } from 'svelte';
import type { Post } from '../../shared/types/post.ts';
import ReplyNodeView from '../lib/svelte/ReplyNode.svelte';
import type { PostNode } from '../lib/thread.ts';

export interface ReplyNodeProps {
  node: PostNode;
  sandboxOrigin: string;
  onReplyCreated: (newReply: Post) => void;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
  postIndexMap?: Map<string, number>;
}

export class ReplyNode {
  private element: HTMLElement;
  private instance: ReturnType<typeof mount> | null = null;

  constructor(props: ReplyNodeProps) {
    this.element = document.createElement('div');
    this.instance = mount(ReplyNodeView as Component, {
      target: this.element,
      props: props as never,
    });
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    if (this.instance) unmount(this.instance);
    this.instance = null;
    this.element.remove();
  }
}

// Factory function for easier usage
export function createReplyNode(props: ReplyNodeProps): ReplyNode {
  return new ReplyNode(props);
}
