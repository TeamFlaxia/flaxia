// Pure state machine for the compact vault unlock form used outside Settings.
// The Svelte component owns focus, password input and network calls.

export type VaultUnlockView = 'loading' | 'error' | 'unavailable' | 'locked';
export type VaultUnlockFailure = 'wrong' | 'network' | 'error';

/**
 * `enabled` is the server's vault flag; `null` means the status request has not
 * resolved yet. A failed request wins so the form can offer a retry.
 */
export function vaultUnlockView(enabled: boolean | null, loadError: boolean): VaultUnlockView {
  if (loadError) return 'error';
  if (enabled === null) return 'loading';
  return enabled ? 'locked' : 'unavailable';
}

/** Failure copy keys reused from the full vault section. */
export function vaultUnlockFailureKey(failure: VaultUnlockFailure): string {
  if (failure === 'wrong') return 'settings.vault_wrong_password';
  if (failure === 'network') return 'settings.network_error';
  return 'settings.vault_error';
}
