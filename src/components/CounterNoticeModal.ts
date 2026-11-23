// Legacy-compatible bridge: CounterNoticeModal.svelte owns the dialog; this
// adapter keeps `openCounterNoticeModal` for the post card adapters.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import CounterNoticeModalView from '../lib/svelte/CounterNoticeModal.svelte';

export function openCounterNoticeModal(postId: string): void {
  mountSvelteModal(
    CounterNoticeModalView,
    (destroy) => ({
      postId,
      onClose: destroy,
    }),
    { appendToBody: true },
  );
}
