// Adapter for the legacy vault-unlock form used by the Svelte mail page.
import { createVaultUnlockForm } from '../../components/VaultUnlockForm.ts';

export function mountVaultUnlock(host: HTMLElement, onUnlocked: () => void): { destroy: () => void } {
  const form = createVaultUnlockForm({ onUnlocked });
  host.replaceChildren(form.getElement());
  return { destroy: form.destroy };
}
