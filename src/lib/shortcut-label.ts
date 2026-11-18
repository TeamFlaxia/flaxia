/** Apple laptops/tablets use ⌘; everything else uses Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** Human-readable hint for the search shortcut (⌘K / Ctrl-K). */
export function commandShortcutLabel(): string {
  return isApplePlatform() ? '⌘K' : 'Ctrl K';
}
