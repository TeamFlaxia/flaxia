// Keep vault cryptography out of the main entry bundle. Most page loads never
// touch VK, so the session module is loaded only after authentication.
export function autoUnlockVault(): void {
  void import('./session.js')
    .then(({ isVaultUnlocked, tryDeviceUnlock }) => {
      if (!isVaultUnlocked()) void tryDeviceUnlock();
    })
    .catch(() => {
      // No vault support in this environment: the inline unlock form still
      // offers the password path on pages that need VK.
    });
}

export function lockVaultSession(): void {
  void import('./session.js').then(({ lockVault }) => lockVault()).catch(() => {});
}
