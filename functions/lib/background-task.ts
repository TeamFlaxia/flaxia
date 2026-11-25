interface WaitUntilContext {
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Run a side effect after the HTTP response has been returned.
 *
 * The platform's `waitUntil` hook keeps the task alive beyond the
 * response so the work is never silently dropped. When no execution context
 * exists (e.g. Hono `app.request` in unit tests) the task still runs and its
 * errors are logged instead of failing the request.
 */
export function waitUntil(c: unknown, task: () => Promise<unknown>, label: string): void {
  let execCtx: WaitUntilContext['executionCtx'];
  try {
    execCtx = (c as WaitUntilContext).executionCtx;
  } catch {
    // Hono throws when invoked without a platform execution context; there is no
    // post-response lifetime to attach to in that case.
  }
  const promise = Promise.resolve()
    .then(task)
    .catch((e: unknown) => console.error(`${label}:`, e));
  if (execCtx?.waitUntil) execCtx.waitUntil(promise);
}
