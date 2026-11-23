// Legacy-compatible bridge. The picker UI, positioning and outside-click /
// Escape handling live in StampPicker.svelte; this module only owns the
// single-active-instance lifecycle so existing callers stay unchanged.
import { mount, unmount } from 'svelte';
import StampPicker from '../lib/svelte/StampPicker.svelte';

export interface StampItem {
  id: string;
  name: string;
  url: string;
  user_id: string;
}

interface StampPickerProps {
  onSelect: (emoji: string, stampId?: string) => void;
  currentUser?: { id: string } | null;
}

let activeInstance: Parameters<typeof unmount>[0] | null = null;
let stampPickerToken = 0;

export function closeStampPicker(): void {
  stampPickerToken++;
  if (activeInstance) {
    void unmount(activeInstance);
    activeInstance = null;
  }
}

export function openStampPicker(anchor: HTMLElement, props: StampPickerProps): void {
  closeStampPicker();
  const token = stampPickerToken;

  activeInstance = mount(StampPicker, {
    target: document.body,
    props: {
      anchor,
      onSelect: (emoji: string, stampId?: string) => {
        if (token !== stampPickerToken) return;
        props.onSelect(emoji, stampId);
        closeStampPicker();
      },
      onClose: () => {
        if (token === stampPickerToken) closeStampPicker();
      },
    },
  });
}
