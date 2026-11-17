import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, html, mount, signal, when } from '../../src/lib/render/index.ts';

interface Tile {
  key: string;
  src: string;
}

type Weather = { status: 'loading' } | { status: 'error' } | { status: 'ready'; temp: number };

describe('maps/render', () => {
  it('reuses fallback tile images by z/x/y key', () => {
    const root = document.createElement('div');
    const tiles = signal<Tile[]>([
      { key: '12/1/1', src: 'https://tile/12/1/1.png' },
      { key: '12/2/1', src: 'https://tile/12/2/1.png' },
    ]);

    mount(root, () =>
      each(
        () => tiles(),
        (tile) => tile.key,
        (tile) => {
          const img = document.createElement('img');
          img.dataset.key = tile().key;
          img.src = tile().src;
          return img;
        },
      ),
    );

    const first = root.querySelector<HTMLImageElement>('[data-key="12/1/1"]');
    const second = root.querySelector<HTMLImageElement>('[data-key="12/2/1"]');
    assert.ok(first);
    assert.ok(second);

    tiles.set([
      { key: '12/1/1', src: 'https://tile/12/1/1.png' },
      { key: '12/3/1', src: 'https://tile/12/3/1.png' },
    ]);
    flushEffects();

    assert.equal(root.querySelector('[data-key="12/1/1"]'), first);
    assert.equal(root.querySelector('[data-key="12/2/1"]'), null);
    assert.ok(root.querySelector('[data-key="12/3/1"]'));
  });

  it('switches the weather overlay through loading and ready states', () => {
    const root = document.createElement('div');
    const weather = signal<Weather>({ status: 'loading' });

    mount(
      root,
      () =>
        html`
          ${() => (weather().status === 'loading' ? 'loading' : '')}
          ${() => (weather().status === 'error' ? 'error' : '')}
          ${when(
            () => weather().status === 'ready',
            () => html`<span class="temp">${() => String((weather() as { temp: number }).temp)}°</span>`,
          )}
        `,
    );

    assert.match(root.textContent ?? '', /loading/);
    weather.set({ status: 'ready', temp: 21 });
    flushEffects();
    assert.equal(root.querySelector('.temp')?.textContent, '21°');
    assert.doesNotMatch(root.textContent ?? '', /loading/);
    weather.set({ status: 'error' });
    flushEffects();
    assert.match(root.textContent ?? '', /error/);
    assert.equal(root.querySelector('.temp'), null);
  });
});
