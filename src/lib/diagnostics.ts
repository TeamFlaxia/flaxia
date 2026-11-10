// Bounded, in-memory diagnostics for the native connectivity/auth layers.
//
// The offline and auth code has no telemetry channel; the only traces were
// the visible offline toast and HTTP status codes. When a field report says
// "online but offline", the first question is whether the offline layer
// gated a read or a probe failed — this ring buffer answers it without any
// network reporting: entries live in memory, are exposed as
// `window.__flaxiaDiagnostics` for WebView/CDP inspection, and nothing here
// ever leaves the device.

export interface DiagnosticEvent {
  at: number;
  component: string;
  event: string;
  fields?: Record<string, string | number | boolean | undefined>;
}

const MAX_EVENTS = 200;
const events: DiagnosticEvent[] = [];

function exposeGlobal(): void {
  try {
    const w = window as unknown as { __flaxiaDiagnostics?: DiagnosticEvent[] };
    if (Object.hasOwn(w, '__flaxiaDiagnostics')) return;
    // Expose a fresh snapshot on every read so page scripts (or the WebView
    // console) can inspect events without being able to mutate the ring.
    Object.defineProperty(w, '__flaxiaDiagnostics', {
      configurable: true,
      get: () => getDiagnostics(),
    });
  } catch {
    // Non-browser environments (node tests) have no window to expose on.
  }
}

export function logEvent(
  component: string,
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
): void {
  exposeGlobal();
  events.push({ at: Date.now(), component, event, fields });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  try {
    console.debug(`[flaxia:${component}] ${event}`, fields ?? {});
  } catch {
    // console unavailable: the ring buffer still captured the event.
  }
}

export function getDiagnostics(): DiagnosticEvent[] {
  return events.slice();
}

export function clearDiagnostics(): void {
  events.length = 0;
}

exposeGlobal();
