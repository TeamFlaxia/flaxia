/**
 * Lifetime ownership for renderer nodes.
 *
 * Every template instance, list item and mounted root gets an `Owner`. Effects,
 * DOM listeners and timers register a disposer with the owner that is current
 * while the node is created, so a single `disposeOwner()` releases the whole
 * subtree. Ownership is deliberately explicit: the renderer never relies on
 * garbage collection to unhook listeners or abort fetches.
 */

export interface Owner {
  readonly parent: Owner | null;
  readonly disposers: Set<() => void>;
  disposed: boolean;
}

let currentOwner: Owner | null = null;

export function createOwner(parent: Owner | null = null): Owner {
  return { parent, disposers: new Set(), disposed: false };
}

export function getCurrentOwner(): Owner | null {
  return currentOwner;
}

/** Run `fn` with `owner` as the active cleanup target. */
export function runInOwner<T>(owner: Owner | null, fn: () => T): T {
  const previous = currentOwner;
  currentOwner = owner;
  try {
    return fn();
  } finally {
    currentOwner = previous;
  }
}

/**
 * Register a cleanup for the currently active owner.
 *
 * Called outside a render (for example from an impromptu event handler) this is
 * a no-op; callers in that position must hold on to the disposer themselves.
 */
export function onCleanup(fn: () => void): void {
  const owner = currentOwner;
  if (!owner || owner.disposed) return;
  owner.disposers.add(fn);
}

export function disposeOwner(owner: Owner): void {
  if (owner.disposed) return;
  owner.disposed = true;

  // Reverse order matches the usual setup/teardown nesting: the most recently
  // registered cleanup runs first.
  const disposers = [...owner.disposers].reverse();
  owner.disposers.clear();

  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      console.error('[render] cleanup failed', error);
    }
  }
}
