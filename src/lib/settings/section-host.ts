import { type Component, mount, unmount } from 'svelte';

/**
 * Mount a Svelte settings section into a `.settings-section` host and return
 * the element plus a disposer. The settings adapter composes these into
 * categories; the Svelte shell renders the page chrome.
 */
export function mountSettingsSection<P extends Record<string, unknown> = Record<string, never>>(
  component: Component<P>,
  props: P = {} as P,
): { element: HTMLElement; destroy: () => void } {
  const element = document.createElement('div');
  element.className = 'settings-section';
  const instance = mount(component, { target: element, props });
  return {
    element,
    destroy: () => {
      void unmount(instance);
    },
  };
}
