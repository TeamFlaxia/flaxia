/**
 * Tiny fine-grained reactivity core.
 *
 * - `signal()` stores a value and notifies dependents on write.
 * - `computed()` is lazy and cached; a global clock plus per-dependency versions
 *   keeps chains glitch-free without a topological sort.
 * - `effect()` runs now, then again in a microtask after any dependency changes.
 *   All writes in the same task are batched into one flush.
 *
 * The API is intentionally the smallest set needed by the renderer. It has no
 * relation to `AbortSignal`; the name is local to this module's exports.
 */

import { onCleanup } from './owner.ts';

export type Accessor<T> = () => T;

export interface Signal<T> {
  (): T;
  set(next: T | ((previous: T) => T)): void;
  peek(): T;
}

type DependencyKind = 'signal' | 'computed' | 'effect';

interface Dependency {
  kind: DependencyKind;
  version: number;
  subscribers: Set<Subscriber>;
}

interface SignalNode<T> extends Dependency {
  kind: 'signal';
  value: T;
}

interface Subscriber extends Dependency {
  kind: 'effect' | 'computed';
  deps: Set<Dependency>;
  depVersions: Map<Dependency, number>;
  fn: () => unknown;
  value: unknown;
  cleanup: (() => void) | null;
  lastChecked: number;
  initialized: boolean;
  computing: boolean;
  scheduled: boolean;
  disposed: boolean;
}

const MAX_FLUSH_ITERATIONS = 1000;

let activeSubscriber: Subscriber | null = null;
let clock = 0;
let batchDepth = 0;
let flushScheduled = false;
let flushing = false;

const pending = new Set<Subscriber>();

function createSubscriber(kind: 'effect' | 'computed', fn: () => unknown): Subscriber {
  return {
    kind,
    version: 0,
    subscribers: new Set(),
    deps: new Set(),
    depVersions: new Map(),
    fn,
    value: undefined,
    cleanup: null,
    lastChecked: -1,
    initialized: false,
    computing: false,
    scheduled: false,
    disposed: false,
  };
}

function track(dep: Dependency): void {
  const subscriber = activeSubscriber;
  if (!subscriber || subscriber.disposed) return;
  subscriber.deps.add(dep);
  dep.subscribers.add(subscriber);
  subscriber.depVersions.set(dep, dep.version);
}

function enqueue(subscriber: Subscriber): void {
  if (subscriber.disposed || subscriber.scheduled) return;
  subscriber.scheduled = true;
  pending.add(subscriber);
  scheduleFlush();
}

function notify(dep: Dependency, visiting: Set<Dependency>): void {
  if (visiting.has(dep)) return;
  visiting.add(dep);

  // Copy so a subscriber that unsubscribes during propagation cannot mutate
  // the set we are iterating.
  for (const subscriber of [...dep.subscribers]) {
    if (subscriber.disposed) continue;
    if (subscriber.kind === 'effect') {
      enqueue(subscriber);
    } else {
      notify(subscriber, visiting);
    }
  }
}

function scheduleFlush(): void {
  if (batchDepth > 0 || flushScheduled || flushing) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    flushEffects();
  });
}

function runEffect(subscriber: Subscriber): void {
  if (subscriber.disposed) return;

  // Clear the flag before running: a write inside the effect must be able to
  // enqueue the effect again (the flush loop bounds the resulting cycles).
  subscriber.scheduled = false;

  subscriber.cleanup?.();
  subscriber.cleanup = null;

  for (const dep of subscriber.deps) dep.subscribers.delete(subscriber);
  subscriber.deps.clear();
  subscriber.depVersions.clear();

  const previous = activeSubscriber;
  activeSubscriber = subscriber;
  try {
    const cleanup = subscriber.fn();
    if (typeof cleanup === 'function') subscriber.cleanup = cleanup as () => void;
  } catch (error) {
    console.error('[render] effect failed', error);
  } finally {
    activeSubscriber = previous;
  }
}

function runComputed(subscriber: Subscriber): void {
  if (subscriber.computing) throw new Error('[render] cycle detected in computed()');

  subscriber.computing = true;
  try {
    for (const dep of subscriber.deps) dep.subscribers.delete(subscriber);
    subscriber.deps.clear();
    subscriber.depVersions.clear();

    const previous = activeSubscriber;
    activeSubscriber = subscriber;
    try {
      subscriber.value = subscriber.fn();
    } finally {
      activeSubscriber = previous;
    }

    subscriber.initialized = true;
    subscriber.version++;
    subscriber.lastChecked = clock;
  } finally {
    subscriber.computing = false;
  }
}

function ensureFresh(subscriber: Subscriber): void {
  if (!subscriber.initialized) {
    runComputed(subscriber);
    return;
  }
  if (subscriber.lastChecked === clock) return;

  let changed = false;
  for (const dep of subscriber.deps) {
    if (dep.kind === 'computed') ensureFresh(dep as Subscriber);
    if (subscriber.depVersions.get(dep) !== dep.version) changed = true;
  }

  if (changed) runComputed(subscriber);
  else subscriber.lastChecked = clock;
}

export function signal<T>(initial: T): Signal<T> {
  const node: SignalNode<T> = {
    kind: 'signal',
    value: initial,
    version: 0,
    subscribers: new Set(),
  };

  const accessor = (() => {
    track(node);
    return node.value;
  }) as Signal<T>;

  accessor.set = (next: T | ((previous: T) => T)): void => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(node.value) : next;
    if (Object.is(value, node.value)) return;
    node.value = value;
    node.version++;
    clock++;
    notify(node, new Set());
    scheduleFlush();
  };

  accessor.peek = (): T => node.value;

  return accessor;
}

export function computed<T>(fn: () => T): Accessor<T> {
  const subscriber = createSubscriber('computed', fn);
  return () => {
    ensureFresh(subscriber);
    track(subscriber);
    return subscriber.value as T;
  };
}

// biome-ignore lint/suspicious/noConfusingVoidType: cleanup-or-nothing is the effect contract
export function effect(fn: () => void | (() => void)): () => void {
  const subscriber = createSubscriber('effect', fn);
  runEffect(subscriber);

  const dispose = (): void => {
    if (subscriber.disposed) return;
    subscriber.disposed = true;
    subscriber.cleanup?.();
    subscriber.cleanup = null;
    for (const dep of subscriber.deps) dep.subscribers.delete(subscriber);
    subscriber.deps.clear();
    pending.delete(subscriber);
  };

  // Auto-dispose with the surrounding render tree. Outside a render this is a
  // no-op and the caller keeps the returned disposer.
  onCleanup(dispose);

  return dispose;
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushEffects();
  }
}

export function untrack<T>(fn: () => T): T {
  const previous = activeSubscriber;
  activeSubscriber = null;
  try {
    return fn();
  } finally {
    activeSubscriber = previous;
  }
}

/** Run pending effects now. Intended for tests and synchronous hand-off points. */
export function flushEffects(): void {
  if (batchDepth > 0 || flushing) return;

  flushing = true;
  flushScheduled = false;
  let iterations = 0;

  try {
    while (pending.size > 0) {
      if (++iterations > MAX_FLUSH_ITERATIONS) {
        console.error('[render] effect cycle limit reached; dropping pending work');
        pending.clear();
        break;
      }

      const current = [...pending];
      pending.clear();
      for (const subscriber of current) {
        if (!subscriber.disposed) runEffect(subscriber);
      }
    }
  } finally {
    flushing = false;
  }
}
