import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('BillingResult Svelte markup', () => {
  const source = readFileSync(join(ROOT, 'src/lib/svelte/BillingResult.svelte'), 'utf8');

  it('renders both success and canceled states', () => {
    assert.match(source, /billing-result-page--success/);
    assert.match(source, /billing-result-page--canceled/);
    assert.match(source, /Payment Successful!/);
    assert.match(source, /Payment Canceled/);
    assert.match(source, /No charges were made/);
  });

  it('keeps the call-to-action', () => {
    assert.match(source, /billing-result-cta/);
    assert.match(source, /Back to Home/);
  });
});
