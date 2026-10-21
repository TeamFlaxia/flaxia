// Helpers for in-app history entries.
//
// Entries created by SPA navigation are tagged so ← buttons can return to the
// previous in-app view instead of guessing from cached component state. A
// direct page load (deep link, external referrer) stays untagged, so its ←
// falls back to a safe in-app route rather than leaving Flaxia.

export const SPA_HISTORY_STATE_KEY = '__flaxiaSpa';

export function pushSpaHistory(url: string, state: Record<string, unknown> = {}): void {
  window.history.pushState({ ...state, [SPA_HISTORY_STATE_KEY]: true }, '', url);
}

export function isSpaHistoryEntry(state: unknown = window.history.state): boolean {
  return (
    typeof state === 'object' && state !== null && (state as Record<string, unknown>)[SPA_HISTORY_STATE_KEY] === true
  );
}

export function goBackInSpaOr(fallback: () => void): void {
  if (isSpaHistoryEntry()) {
    window.history.back();
    return;
  }
  fallback();
}
