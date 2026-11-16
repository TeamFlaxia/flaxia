import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, effect, flushEffects, html, legacy, mount, onMount, signal, when } from '../src/index.ts';

function createRoot(): HTMLElement {
  return document.createElement('div');
}

describe('render/lifecycle', () => {
  it('disposes effects created during mount', () => {
    const root = createRoot();
    const value = signal(0);
    let runs = 0;

    const mounted = mount(root, () => {
      effect(() => {
        value();
        runs++;
      });
      return html`<p>${() => value()}</p>`;
    });

    assert.equal(runs, 1);
    mounted.dispose();

    value.set(1);
    flushEffects();
    assert.equal(runs, 1);
  });

  it('calls the legacy component teardown on dispose', () => {
    const root = createRoot();
    const node = document.createElement('span');
    let disposed = false;

    const mounted = mount(root, () =>
      legacy(node, () => {
        disposed = true;
      }),
    );

    assert.equal(root.contains(node), true);
    mounted.dispose();
    assert.equal(disposed, true);
    assert.equal(root.childNodes.length, 0);
  });

  it('runs onMount after the render is attached', async () => {
    const root = createRoot();
    let mountedFlag = false;

    mount(root, () => {
      onMount(() => {
        mountedFlag = true;
      });
      return html`<p>content</p>`;
    });

    assert.equal(mountedFlag, false);
    await Promise.resolve();
    assert.equal(mountedFlag, true);
  });

  it('disposes a when() branch and its effects on toggle', () => {
    const root = createRoot();
    const show = signal(true);
    const trigger = signal(0);
    let runs = 0;

    mount(
      root,
      () =>
        html`<div>
          ${when(
            show,
            () => {
              effect(() => {
                trigger();
                runs++;
              });
              return html`<p class="on">on</p>`;
            },
            () => html`<p class="off">off</p>`,
          )}
        </div>`,
    );

    assert.equal(runs, 1);
    show.set(false);
    flushEffects();
    assert.equal(root.querySelector('.off')?.textContent, 'off');

    trigger.set(1);
    flushEffects();
    assert.equal(runs, 1, 'the branch effect must not survive the toggle');
  });

  it('disposes effects owned by a removed each() item', () => {
    const root = createRoot();
    const rows = signal([1, 2, 3]);
    const trigger = signal(0);
    const runs: number[] = [];

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row,
            (row) => {
              effect(() => {
                trigger();
                runs.push(row());
              });
              return html`<li>${() => row()}</li>`;
            },
          )}
        </ul>`,
    );

    assert.equal(runs.length, 3);

    rows.set([1]);
    flushEffects();

    runs.length = 0;
    trigger.set(1);
    flushEffects();
    assert.deepEqual(runs, [1], 'removed item effects must not survive');
  });
});
