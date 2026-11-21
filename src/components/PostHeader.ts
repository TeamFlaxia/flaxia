// Legacy-compatible bridge: Svelte owns the header DOM, this keeps the factory API.
import { type Component, mount, unmount } from 'svelte';
import type { PostHeaderProps } from '../../shared/types/post.ts';
import PostHeaderView from '../lib/svelte/PostHeader.svelte';

export function createPostHeader(props: PostHeaderProps & { editedAt?: string }): HTMLElement {
  const target = document.createElement('div');
  const instance = mount(PostHeaderView as Component, { target, props });
  // The component root IS the header; return it directly so callers get the
  // same element shape as the legacy factory.
  const header = target.firstElementChild as HTMLElement;
  header.remove();
  // Removing the node does not unmount Svelte; callers can release effects.
  (header as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return header;
}
