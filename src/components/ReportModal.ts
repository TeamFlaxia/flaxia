// Legacy-compatible bridge: ReportModal.svelte owns the dialog; this adapter
// keeps `openReportModal` for the post card adapters and Arcade.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import ReportModalView from '../lib/svelte/ReportModal.svelte';

export function openReportModal(postId: string): void {
  mountSvelteModal(
    ReportModalView,
    (destroy) => ({
      postId,
      onClose: destroy,
    }),
    { appendToBody: true },
  );
}
