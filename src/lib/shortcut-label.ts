/** Apple laptops/tablets use ⌘; everything else uses Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** Human-readable shortcut hint for the command palette. */
export function commandShortcutLabel(): string {
  return isApplePlatform() ? '⌘K' : 'Ctrl K';
}
