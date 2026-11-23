// Legacy-compatible bridge: BlockedUsersModal.svelte owns the dialog; this
// adapter keeps `createBlockedUsersModal` returning an element for callers
// that append it themselves.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import BlockedUsersModalView from '../lib/svelte/BlockedUsersModal.svelte';

interface BlockedUsersModalOptions {
  onUnblock?: (username: string) => void;
}

export function createBlockedUsersModal(options: BlockedUsersModalOptions = {}): HTMLElement {
  const { host } = mountSvelteModal(BlockedUsersModalView, (destroy) => ({
    onUnblock: options.onUnblock,
    onClose: destroy,
  }));
  return host;
}
