import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundary, resource } from '../../src/lib/render/async.ts';
import { html, mount } from '../../src/lib/render/index.ts';
import { createOwner, disposeOwner, runInOwner } from '../../src/lib/render/owner.ts';

function createRoot(): HTMLElement {
  return document.createElement('div');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('render/async', () => {
  it('lets only the newest resource request commit', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;

    const owner = createOwner();
    const result = runInOwner(owner, () =>
      resource<string>(() => {
        calls++;
        return calls === 1 ? first.promise : second.promise;
      }),
    );

    assert.equal(result.loading(), true);
    assert.equal(calls, 1);

    result.refetch();
    assert.equal(calls, 2);

    second.resolve('second');
    await tick();
    assert.equal(result.data(), 'second');
    assert.equal(result.loading(), false);

    first.resolve('first');
    await tick();
    assert.equal(result.data(), 'second');

    disposeOwner(owner);
  });

  it('aborts an in-flight resource when its owner is disposed', () => {
    let received: AbortSignal | null = null;
    const owner = createOwner();

    runInOwner(owner, () =>
      resource<string>((signal) => {
        received = signal;
        return new Promise<string>(() => {});
      }),
    );

    assert.ok(received);
    assert.equal(received.aborted, false);
    disposeOwner(owner);
    assert.equal(received.aborted, true);
  });

  it('does not start a lazy resource until refetch()', () => {
    let calls = 0;
    const owner = createOwner();
    const result = runInOwner(owner, () =>
      resource<string>(
        () => {
          calls++;
          return Promise.resolve('value');
        },
        { lazy: true },
      ),
    );

    assert.equal(calls, 0);
    assert.equal(result.loading(), false);
    result.refetch();
    assert.equal(calls, 1);
    disposeOwner(owner);
  });

  it('renders the boundary fallback when the initial render throws', () => {
    const root = createRoot();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      mount(
        root,
        () =>
          html`<main>
            ${boundary(
              () => {
                throw new Error('boom');
              },
              () => html`<p class="fallback">failed</p>`,
            )}
          </main>`,
      );
    } finally {
      console.error = original;
    }

    assert.equal(root.querySelector('.fallback')?.textContent, 'failed');
    assert.equal(errors.length, 1);
  });
});
