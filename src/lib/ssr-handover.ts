// The SSR fallback markup (SsrOnly / SsrPostList) is removed only once the
// interactive Svelte view has rendered its own content. This keeps the first
// paint readable while JS boots and avoids a blank-feed flash / layout shift.
export const SSR_HANDOVER_EVENT = 'flaxia:ssr-handover';

let handoverSignaled = false;

/** True after an interactive view has taken over the page in this document. */
export function hasSsrHandover(): boolean {
  return handoverSignaled;
}

/** Call from the interactive view once its initial data has been rendered. */
export function signalSsrHandover(): void {
  handoverSignaled = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SSR_HANDOVER_EVENT));
}
