// Legacy-compatible bridge. The picker UI now lives in StampPicker.svelte;
// this module only owns popover lifecycle (single active instance, positioning,
// outside-click/Escape) so existing DOM callers don't need to change.
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

const PICKER_WIDTH = 340;
const PICKER_HEIGHT = 400;

let activeTarget: HTMLElement | null = null;
let activeInstance: Parameters<typeof unmount>[0] | null = null;
let stampPickerToken = 0;

const onKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') closeStampPicker();
};

const onOutsideClick = (e: MouseEvent): void => {
  if (activeTarget && !activeTarget.contains(e.target as Node)) closeStampPicker();
};

export function closeStampPicker(): void {
  stampPickerToken++;
  if (activeInstance) {
    unmount(activeInstance);
    activeInstance = null;
  }
  if (activeTarget) {
    activeTarget.remove();
    activeTarget = null;
  }
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', onOutsideClick);
}

export function openStampPicker(anchor: HTMLElement, props: StampPickerProps): void {
  closeStampPicker();
  const token = stampPickerToken;

  const target = document.createElement('div');
  const rect = anchor.getBoundingClientRect();
  const fitsBelow = rect.bottom + PICKER_HEIGHT + 8 <= window.innerHeight;
  const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - PICKER_HEIGHT);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - PICKER_WIDTH - 8));

  document.body.appendChild(target);
  activeTarget = target;
  activeInstance = mount(StampPicker, {
    target,
    props: {
      top: `${top}px`,
      left: `${left}px`,
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

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onOutsideClick);
}
