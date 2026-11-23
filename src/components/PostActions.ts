// Legacy-compatible bridge: the action row UI and behaviour live in
// src/lib/svelte/PostActions.svelte; callers keep the old factory API.
import { type Component, mount, unmount } from 'svelte';
import type { PostActionsProps } from '../../shared/types/post.ts';
import PostActionsView from '../lib/svelte/PostActions.svelte';

/** Toggle actions that get a one-shot pop when they turn ON. */
export type ActionPop = 'fresh' | 'bookmark' | 'reload';

type PostActionsOptions = PostActionsProps & {
  /** Which toggle just turned ON — plays a 320ms spring pop once. */
  popAction?: ActionPop;
  /** Emoji of the reaction that just turned ON — pops that chip. */
  popReaction?: string;
};

export function createPostActions(props: PostActionsOptions): HTMLElement {
  const target = document.createElement('div');
  const instance = mount(PostActionsView as Component, { target, props });
  const element = target.firstElementChild as HTMLElement;
  element.remove();
  (element as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return element;
}
