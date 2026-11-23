// Legacy-compatible bridge: the dropdown UI is owned by PostMenu.svelte and the
// trigger by MenuButton.svelte.
import { type Component, mount, unmount } from 'svelte';
import MenuButton from '../lib/svelte/MenuButton.svelte';
import PostMenuView from '../lib/svelte/PostMenu.svelte';

export interface PostMenuActions {
  onVersionHistory: () => void;
  onTogglePin?: () => void;
  onCounterNotice: () => void;
  onEdit: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onReport: () => void;
}

export interface PostMenuProps {
  isOwnPost: boolean;
  isRemote?: boolean;
  showPinOption?: boolean;
  pinned?: boolean;
  payloadKey?: string | null;
  currentUser?: { username: string; id: string } | null;
  actions: PostMenuActions;
}

export function createPostMenuDropdown(props: PostMenuProps): HTMLElement {
  const target = document.createElement('div');
  const instance = mount(PostMenuView as Component, { target, props });
  const dropdown = target.firstElementChild as HTMLElement;
  dropdown.remove();
  (dropdown as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return dropdown;
}

export function createMenuButton(onClick: () => void): HTMLElement {
  const target = document.createElement('div');
  const instance = mount(MenuButton as Component, { target, props: { onclick: onClick } });
  const button = target.firstElementChild as HTMLElement;
  button.remove();
  (button as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return button;
}

export function setupMenuCloseHandler(dropdown: HTMLElement, onClose: () => void): void {
  const closeMenu = (e: MouseEvent) => {
    if (!dropdown.contains(e.target as Node)) {
      onClose();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}
