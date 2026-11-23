// Fullscreen helpers for the Arcade player. Browsers without the API (or a
// rejected request) fall back to the page's immersive overlay.

export type FullscreenAction = 'entered' | 'exited' | 'fake';

export function isDocumentFullscreen(): boolean {
  return Boolean(
    document.fullscreenElement ||
      (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement,
  );
}

export async function toggleElementFullscreen(element: HTMLElement, active: boolean): Promise<FullscreenAction> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
    return 'exited';
  }
  // Fake fullscreen has no document element to exit.
  if (active) return 'exited';

  const request =
    element.requestFullscreen?.bind(element) ??
    (element as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(element);
  if (!request) return 'fake';
  try {
    await request();
    return 'entered';
  } catch {
    return 'fake';
  }
}
