// Legacy-compatible bridge. The reply composer UI and behaviour live in
// src/lib/svelte/ReplyComposer.svelte; callers keep the old factory API.
import { type Component, mount, unmount } from 'svelte';
import type { Post } from '../../shared/types/post.ts';
import ReplyComposerView from '../lib/svelte/ReplyComposer.svelte';

export interface ReplyComposerProps {
  postId: string;
  sandboxOrigin: string;
  onReplyCreated: (newReply: Post) => void;
  onCancel: () => void;
  prefillText?: string;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
}

interface Instance {
  focus: () => void;
  insertText: (value: string) => void;
}

export class ReplyComposer {
  private element: HTMLElement;
  private instance: Instance | null = null;

  constructor(props: ReplyComposerProps) {
    this.element = document.createElement('div');
    this.instance = mount(ReplyComposerView as Component, {
      target: this.element,
      props: {
        postId: props.postId,
        sandboxOrigin: props.sandboxOrigin,
        onReplyCreated: props.onReplyCreated,
        onCancel: props.onCancel,
        prefillText: props.prefillText,
        currentUser: props.currentUser,
      },
    }) as unknown as Instance;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  focus(): void {
    this.instance?.focus();
  }

  insertText(text: string): void {
    this.instance?.insertText(text);
  }

  destroy(): void {
    if (this.instance) unmount(this.instance as never);
    this.instance = null;
    this.element.remove();
  }
}

export function createReplyComposer(props: ReplyComposerProps): ReplyComposer {
  return new ReplyComposer(props);
}
