import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Alert {
  id: string;
  category: string;
}

function createRow(alert: Alert): HTMLElement {
  const row = document.createElement('div');
  row.className = 'admin-alert-row';
  row.dataset.id = alert.id;
  row.textContent = alert.category;
  return row;
}

describe('admin/alerts-list', () => {
  it('dismisses one alert without rebuilding the rest', () => {
    const root = document.createElement('div');
    const alerts = signal<Alert[]>([
      { id: 'a1', category: 'spam' },
      { id: 'a2', category: 'malware' },
      { id: 'a3', category: 'copyright' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => alerts(),
        (alert) => alert.id,
        (alert) => {
          const value = alert();
          return legacy(createRow(value), () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="a1"]');
    const third = root.querySelector<HTMLElement>('[data-id="a3"]');
    assert.ok(first);
    assert.ok(third);

    alerts.set(alerts().filter((alert) => alert.id !== 'a2'));
    flushEffects();

    assert.equal(root.querySelector('[data-id="a1"]'), first);
    assert.equal(root.querySelector('[data-id="a3"]'), third);
    assert.equal(root.querySelector('[data-id="a2"]'), null);
    assert.deepEqual(disposed, ['a2']);
  });
});
