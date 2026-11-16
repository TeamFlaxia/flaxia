/**
 * Cross-origin-safe helpers for async data and error isolation.
 */

import { onCleanup } from './owner.ts';
import { type Accessor, signal } from './signal.ts';
import type { Directive, Renderable } from './template.ts';

export interface Resource<T> {
  data: Accessor<T | undefined>;
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
  refetch(): void;
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Run a fetch-like function with a generation token and an AbortController.
 *
 * Only the newest request may commit. A response that resolves after a refetch
 * or after disposal is ignored, so a slow feed cannot overwrite a newer view.
 */
export function resource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { initial?: T; lazy?: boolean } = {},
): Resource<T> {
  const data = signal<T | undefined>(options.initial);
  const error = signal<unknown>(null);
  const loading = signal(false);

  let generation = 0;
  let controller: AbortController | null = null;
  let disposed = false;

  const run = (): void => {
    if (disposed) return;

    controller?.abort();
    const current = new AbortController();
    controller = current;
    const requested = ++generation;

    loading.set(true);
    error.set(null);

    let promise: Promise<T>;
    try {
      promise = fetcher(current.signal);
    } catch (syncError) {
      if (requested === generation && !disposed) {
        error.set(syncError);
        loading.set(false);
      }
      return;
    }

    void promise.then(
      (value) => {
        if (requested !== generation || disposed) return;
        data.set(value);
        loading.set(false);
      },
      (reason: unknown) => {
        if (requested !== generation || disposed || isAbort(reason)) return;
        error.set(reason);
        loading.set(false);
      },
    );
  };

  if (!options.lazy) run();

  onCleanup(() => {
    disposed = true;
    controller?.abort();
  });

  return { data, error, loading, refetch: run };
}

/**
 * Render `fallback` if the initial render throws. Errors thrown later (from an
 * effect) are reported by the scheduler and leave the boundary in place.
 */
export function boundary(render: () => Renderable, fallback: (error: unknown) => Renderable): Directive {
  return {
    __flxDirective: true,
    render(part) {
      try {
        part.renderContent(render);
      } catch (error) {
        console.error('[render] boundary caught an error', error);
        part.renderContent(() => fallback(error));
      }
    },
  };
}
