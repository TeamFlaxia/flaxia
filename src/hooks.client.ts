// SvelteKit's default client handleError calls console.error() unconditionally.
// Some browser extensions (notably wallet inpage scripts) replace console
// methods with non-callable values; when an app error then reaches handleError,
// that secondary failure masks the original error with
// "(intermediate value)(...) is not a function".
//
// Keep the original error observable without ever assuming console.error is a
// function.
export function handleError(input: {
  error: unknown;
  status: number;
  message: string;
  event: { url: URL | string };
}): void {
  const detail = {
    message: input.message,
    status: input.status,
    url: String(input.event.url),
    stack: input.error instanceof Error ? input.error.stack : String(input.error),
  };

  const scope = globalThis as unknown as { __flaxiaLastError?: typeof detail };
  scope.__flaxiaLastError = detail;

  if (typeof console.error === 'function') {
    console.error('[flaxia] handleError', detail);
  } else if (typeof console.log === 'function') {
    console.log('[flaxia] handleError', detail);
  }
}
