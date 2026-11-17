import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { hideNavigationSpinner, isNavigationSpinnerMounted, showNavigationSpinner } from '../../src/lib/nav-loading.ts';

describe('navigation loading spinner', () => {
  afterEach(() => {
    hideNavigationSpinner();
  });

  it('mounts a single status element into the app root', () => {
    const root = document.createElement('div');
    showNavigationSpinner(root);
    showNavigationSpinner(root);

    const spinners = root.querySelectorAll('#nav-loading');
    assert.equal(spinners.length, 1);
    assert.equal(spinners[0]?.getAttribute('role'), 'status');
    assert.ok(spinners[0]?.querySelector('.nav-loading-spinner'));
    assert.ok(isNavigationSpinnerMounted());
  });

  it('removes the spinner on commit or failure', () => {
    const root = document.createElement('div');
    showNavigationSpinner(root);
    hideNavigationSpinner();
    hideNavigationSpinner();

    assert.equal(root.querySelector('#nav-loading'), null);
    assert.equal(isNavigationSpinnerMounted(), false);
  });
});
