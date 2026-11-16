import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { batch, computed, effect, flushEffects, signal, untrack } from '../src/signal.ts';

describe('render/signal', () => {
  it('reads, writes and peeks a signal', () => {
    const count = signal(1);
    assert.equal(count(), 1);
    count.set(2);
    assert.equal(count(), 2);
    count.set((previous) => previous + 1);
    assert.equal(count(), 3);
    assert.equal(count.peek(), 3);
  });

  it('does not notify when the value is unchanged', () => {
    const count = signal(1);
    let runs = 0;
    effect(() => {
      count();
      runs++;
    });
    count.set(1);
    flushEffects();
    assert.equal(runs, 1);
  });

  it('runs an effect immediately and again after a write', () => {
    const count = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(count());
    });
    count.set(1);
    flushEffects();
    assert.deepEqual(seen, [0, 1]);
  });

  it('batches multiple writes into one effect run', () => {
    const left = signal(1);
    const right = signal(1);
    let runs = 0;
    effect(() => {
      left();
      right();
      runs++;
    });

    batch(() => {
      left.set(2);
      right.set(2);
    });

    assert.equal(runs, 2);
  });

  it('runs the previous cleanup before re-running and on dispose', () => {
    const count = signal(0);
    const log: string[] = [];
    const dispose = effect(() => {
      log.push(`run:${count()}`);
      return () => log.push('cleanup');
    });

    count.set(1);
    flushEffects();
    dispose();

    assert.deepEqual(log, ['run:0', 'cleanup', 'run:1', 'cleanup']);
  });

  it('caches computed values until a dependency changes', () => {
    const count = signal(1);
    let calls = 0;
    const doubled = computed(() => {
      calls++;
      return count() * 2;
    });

    assert.equal(doubled(), 2);
    assert.equal(doubled(), 2);
    assert.equal(calls, 1);

    count.set(2);
    assert.equal(doubled(), 4);
    assert.equal(calls, 2);
  });

  it('propagates changes through a computed chain', () => {
    const count = signal(1);
    const doubled = computed(() => count() * 2);
    const seen: number[] = [];
    effect(() => {
      seen.push(doubled());
    });

    count.set(2);
    flushEffects();
    assert.deepEqual(seen, [2, 4]);
  });

  it('does not track reads inside untrack()', () => {
    const tracked = signal(1);
    const ignored = signal(1);
    let runs = 0;
    effect(() => {
      tracked();
      untrack(() => ignored());
      runs++;
    });

    ignored.set(2);
    flushEffects();
    assert.equal(runs, 1);

    tracked.set(2);
    flushEffects();
    assert.equal(runs, 2);
  });

  it('detects computed cycles', () => {
    const first = computed((): number => second());
    const second = computed((): number => first());
    assert.throws(() => first(), /cycle/);
  });
});
