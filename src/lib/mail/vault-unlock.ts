// Adapter for the vault-unlock form used by the Svelte mail page.
import { createVaultUnlockForm } from '../settings/vault-unlock-form.ts';

export function mountVaultUnlock(host: HTMLElement, onUnlocked: () => void): { destroy: () => void } {
  const form = createVaultUnlockForm({ onUnlocked });
  host.replaceChildren(form.getElement());
  return { destroy: form.destroy };
}
