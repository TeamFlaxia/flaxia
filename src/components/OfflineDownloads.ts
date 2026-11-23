// Legacy-compatible bridge: the offline downloads section is owned by
// OfflineDownloads.svelte; this keeps the factory API used by the page adapter.
import { type Component, mount, unmount } from 'svelte';
import OfflineDownloads from '../lib/svelte/OfflineDownloads.svelte';

export function createOfflineDownloads() {
  const element = document.createElement('div');
  const instance = mount(OfflineDownloads as Component, { target: element });
  return {
    element,
    destroy: () => {
      void unmount(instance);
      element.remove();
    },
  };
}
