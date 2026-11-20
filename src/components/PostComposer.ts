// Legacy-compatible bridge. The composer UI and behaviour now live in
// src/lib/svelte/PostComposer.svelte; callers only need the old factory API.
import { type Component, mount, unmount } from 'svelte';
import type { Post, QuotedPost } from '../../shared/types/post.ts';
import Composer from '../lib/svelte/PostComposer.svelte';

export interface PostComposerProps {
  onPostCreated?: (post: Post) => void;
  currentUser?: {
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    id?: string;
  } | null;
  onDraftSaved?: () => void;
  quotedPost?: QuotedPost | null;
}

interface ComposerInstance {
  setText: (value: string) => void;
  focus: () => void;
  getSavedDrafts: () => Array<{ id: string; text: string; savedAt: number }>;
  deleteDraftPublic: (id: string) => void;
  saveDraftPublic: () => void;
  deleteAllDraftsPublic: () => void;
  updateCurrentUser: (user: PostComposerProps['currentUser']) => void;
}

export class PostComposer {
  private instance: ComposerInstance;

  constructor(instance: ComposerInstance) {
    this.instance = instance;
  }

  setText(text: string): void {
    this.instance.setText(text);
  }

  getSavedDrafts(): Array<{ id: string; text: string; savedAt: number }> {
    return this.instance.getSavedDrafts();
  }

  deleteDraft(id: string): void {
    this.instance.deleteDraftPublic(id);
  }

  saveDraftPublic(): void {
    this.instance.saveDraftPublic();
  }

  deleteAllDraftsPublic(): void {
    this.instance.deleteAllDraftsPublic();
  }

  focus(): void {
    this.instance.focus();
  }

  updateCurrentUser(user: PostComposerProps['currentUser']): void {
    this.instance.updateCurrentUser(user);
  }

  getElement(): HTMLElement {
    throw new Error('PostComposer.getElement() must be accessed through createPostComposer');
  }

  destroy(): void {
    // handled by the factory
  }
}

export function createPostComposer(props: PostComposerProps): PostComposer & { element: HTMLElement } {
  const target = document.createElement('div');
  const instance = mount(Composer as Component, {
    target,
    props: {
      onPostCreated: props.onPostCreated,
      currentUser: props.currentUser,
      onDraftSaved: props.onDraftSaved,
      quotedPost: props.quotedPost,
    },
  }) as unknown as ComposerInstance;

  const facade = new PostComposer(instance) as PostComposer & { element: HTMLElement };
  Object.defineProperty(facade, 'element', { value: target, enumerable: true });
  facade.getElement = () => target;
  facade.destroy = () => unmount(instance as never);
  return facade;
}
