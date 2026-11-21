// Adapter for the legacy offline-downloads section used by the Svelte page.
import { createOfflineDownloads } from '../../components/OfflineDownloads.ts';

export function mountOfflineDownloads(host: HTMLElement): { destroy: () => void } {
  const section = createOfflineDownloads();
  host.replaceChildren(section.element);
  return { destroy: () => section.destroy() };
}
