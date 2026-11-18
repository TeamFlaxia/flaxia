import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBillingResultPage } from '../../src/components/BillingResultPage.ts';

describe('BillingResultPage', () => {
  it('renders the success state', () => {
    const page = createBillingResultPage({ success: true });
    const element = page.getElement();

    assert.ok(element.classList.contains('billing-result-page--success'));
    assert.equal(element.querySelector('.billing-result-icon')?.textContent, '✓');
    assert.equal(element.querySelector('.billing-result-title')?.textContent, 'Payment Successful!');
    assert.match(element.querySelector('.billing-result-message')?.textContent ?? '', /purchase/);
    assert.equal(element.querySelector('.billing-result-cta')?.textContent?.trim(), 'Back to Home');

    page.destroy();
    assert.equal(element.childNodes.length, 0);
  });

  it('renders the canceled state', () => {
    const page = createBillingResultPage({ success: false });
    const element = page.getElement();

    assert.ok(element.classList.contains('billing-result-page--canceled'));
    assert.equal(element.querySelector('.billing-result-icon')?.textContent, '✕');
    assert.equal(element.querySelector('.billing-result-title')?.textContent, 'Payment Canceled');
    assert.match(element.querySelector('.billing-result-message')?.textContent ?? '', /No charges/);

    page.destroy();
  });
});
