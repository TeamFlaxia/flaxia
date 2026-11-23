// Adapters around the Svelte post-card surfaces. The stage/mountStage helpers
// stay on the legacy factory until the media stage is migrated; everything
// else mounts a Svelte component or reuses a thin Svelte bridge.
import { mount, unmount } from 'svelte';
import type { Post, PostCardMode, PostTextProps } from '../../../shared/types/post.ts';
import { openCounterNoticeModal } from '../../components/CounterNoticeModal.js';
import { openGameUpdateModal } from '../../components/GameUpdateModal.js';
import { createPostActions } from '../../components/PostActions.js';
import { createMenuButton, createPostMenuDropdown, setupMenuCloseHandler } from '../../components/PostMenu.js';
import { createPostStage, destroyPostStage, updatePostStage } from '../../components/PostStage.js';
import { createReplyComposer, type ReplyComposer } from '../../components/ReplyComposer.js';
import { openReportModal } from '../../components/ReportModal.js';
import { createShareModal } from '../../components/ShareModal.js';
import { openVersionHistoryModal } from '../../components/VersionHistoryModal.js';
import { createConfirmDialog } from '../confirm-dialog.ts';
import { loadLinkPreview } from '../link-preview.js';
import PostTextSurface from '../svelte/PostText.svelte';

export interface StageHandle {
  element: HTMLElement;
  update: (post: Post, mode: PostCardMode, versionId?: string) => void;
  destroy: () => void;
}

export function mountStage(
  host: HTMLElement,
  options: {
    post: Post;
    mode: PostCardMode;
    sandboxOrigin: string;
    versionId?: string;
    onModeChange: (mode: PostCardMode) => void;
  },
): StageHandle {
  const element = createPostStage(options);
  host.replaceChildren(element);
  return {
    element,
    update: (post, mode, versionId) => updatePostStage(element, { ...options, post, mode, versionId }),
    destroy: () => destroyPostStage(element),
  };
}

type Destroyable = HTMLElement & { destroy?: () => void };

const textInstances = new WeakMap<HTMLElement, ReturnType<typeof mount>>();

export async function mountPostText(host: HTMLElement, props: PostTextProps): Promise<void> {
  unmountPostText(host);
  host.replaceChildren();
  const instance = mount(PostTextSurface, { target: host, props });
  textInstances.set(host, instance);
}

export function unmountPostText(host: HTMLElement | undefined): void {
  if (!host) return;
  const instance = textInstances.get(host);
  if (!instance) return;
  unmount(instance);
  textInstances.delete(host);
}

const actionDestroyers = new WeakMap<HTMLElement, () => void>();

export function mountActions(host: HTMLElement, options: Parameters<typeof createPostActions>[0]): void {
  unmountActions(host);
  const element = createPostActions(options) as Destroyable;
  const destroy = element.destroy;
  if (destroy) actionDestroyers.set(host, destroy);
  host.replaceChildren(element);
}

export function unmountActions(host: HTMLElement | undefined): void {
  if (!host) return;
  const destroy = actionDestroyers.get(host);
  if (!destroy) return;
  actionDestroyers.delete(host);
  destroy();
}

export function mountReply(host: HTMLElement, options: Parameters<typeof createReplyComposer>[0]): ReplyComposer {
  const composer = createReplyComposer(options);
  host.replaceChildren(composer.getElement());
  return composer;
}

export function mountLinkPreview(host: HTMLElement, text: string): void {
  loadLinkPreview(text, host, true);
}

export function openShare(post: Post, onQuote: () => void): void {
  document.body.appendChild(
    createShareModal({
      post: { id: post.id, text: post.text, username: post.username, display_name: post.display_name },
      onClose: () => {},
      onQuote,
    }),
  );
}

export function openReport(post: Post): void {
  openReportModal(post.id);
}

export function openCounterNotice(post: Post): void {
  openCounterNoticeModal(post.id);
}

export function openVersionHistory(
  post: Post,
  sandboxOrigin: string,
  currentVersionId: string | null,
  onPlay: (id: string | null) => void,
): void {
  openVersionHistoryModal({ postId: post.id, sandboxOrigin, currentVersionId, onPlay });
}

export function openGameUpdate(post: Post, sandboxOrigin: string, onUpdated: () => void): void {
  openGameUpdateModal({ postId: post.id, sandboxOrigin, onUpdated });
}

const menuDestroyers = new WeakMap<HTMLElement, Array<() => void>>();

function destroyMenuInstances(host: HTMLElement): void {
  const destroyers = menuDestroyers.get(host);
  if (!destroyers) return;
  menuDestroyers.delete(host);
  for (const destroy of destroyers) destroy();
}

export function unmountMenu(host: HTMLElement | undefined): void {
  if (!host) return;
  destroyMenuInstances(host);
  host.replaceChildren();
}

export function mountMenu(
  host: HTMLElement,
  options: Parameters<typeof createPostMenuDropdown>[0],
  onClose: () => void,
): void {
  unmountMenu(host);

  let closed = false;
  const closeMenu = () => {
    if (closed) return;
    closed = true;
    destroyMenuInstances(host);
    host.replaceChildren();
    onClose();
  };

  const button = createMenuButton(closeMenu) as Destroyable;
  const dropdown = createPostMenuDropdown(options) as Destroyable;
  const destroyers: Array<() => void> = [];
  if (button.destroy) destroyers.push(button.destroy);
  if (dropdown.destroy) destroyers.push(dropdown.destroy);
  menuDestroyers.set(host, destroyers);

  host.replaceChildren(button, dropdown);
  setupMenuCloseHandler(dropdown, closeMenu);
}

export function confirmDelete(): Promise<boolean> {
  return createConfirmDialog('post.delete_confirm');
}

export function mountMenuButton(host: HTMLElement, onClick: () => void): void {
  destroyMenuInstances(host);
  const button = createMenuButton(onClick) as Destroyable;
  if (button.destroy) menuDestroyers.set(host, [button.destroy]);
  host.replaceChildren(button);
}
