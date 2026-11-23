// SvelteKit's default client handleError calls console.error() unconditionally.
// Some browser extensions (notably wallet inpage scripts) replace console
// methods with non-callable values; when an app error then reaches handleError,
// that secondary failure masks the original error with
// "(intermediate value)(...) is not a function".
//
// Keep the original error observable without ever assuming console.error is a
// function. SvelteKit 3 removed the top-level `message`/`status` properties in
// production, so read `kind` and `error` (with a legacy fallback) instead.
import type { HandleClientError } from '@sveltejs/kit/hooks';

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function field(value: object, name: string): unknown {
  return name in value ? (value as Record<string, unknown>)[name] : undefined;
}

export const handleError: HandleClientError = (input) => {
  const source = input as unknown as {
    kind?: string;
    error?: unknown;
    message?: unknown;
    status?: unknown;
    event: { url: URL | string };
  };
  const error = source.error;
  const errorObject = error !== null && typeof error === 'object' ? (error as object) : null;

  const message =
    (errorObject && typeof field(errorObject, 'message') === 'string' ? field(errorObject, 'message') : undefined) ??
    (source.kind === 'unknown' ? 'Internal Error' : undefined) ??
    (typeof source.message === 'string' ? source.message : undefined);
  const status =
    (errorObject && typeof field(errorObject, 'status') === 'number' ? field(errorObject, 'status') : undefined) ??
    (source.kind === 'unknown' ? 500 : undefined) ??
    (typeof source.status === 'number' ? source.status : undefined);

  const detail = {
    kind: source.kind ?? 'legacy',
    message,
    status,
    url: String(source.event.url),
    name: error instanceof Error ? error.name : typeof error,
    stack: error instanceof Error ? error.stack : safeStringify(error),
  };

  const scope = globalThis as unknown as { __flaxiaLastError?: typeof detail };
  scope.__flaxiaLastError = detail;

  if (typeof console.error === 'function') {
    console.error('[flaxia] handleError', detail);
  } else if (typeof console.log === 'function') {
    console.log('[flaxia] handleError', detail);
  }
};
