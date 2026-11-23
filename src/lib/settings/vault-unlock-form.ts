// Mount adapter for the compact vault unlock form. The UI is owned by
// `src/lib/svelte/VaultUnlockForm.svelte`; callers keep the factory API.
import { mount, unmount } from 'svelte';
import VaultUnlockForm from '../svelte/VaultUnlockForm.svelte';

export interface VaultUnlockFormOptions {
  onUnlocked: () => void;
}

export interface VaultUnlockFormHandle {
  getElement: () => HTMLElement;
  destroy: () => void;
}

export function createVaultUnlockForm(options: VaultUnlockFormOptions): VaultUnlockFormHandle {
  const element = document.createElement('div');
  const instance = mount(VaultUnlockForm, {
    target: element,
    props: { onUnlocked: options.onUnlocked },
  });
  return {
    getElement: () => element,
    destroy: () => {
      void unmount(instance);
      element.remove();
    },
  };
}
