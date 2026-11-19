// F5 first wave: billing result pages render from SvelteKit while the legacy
// component remains the source of truth for markup until the final cleanup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('billing result routes render the Svelte component', async () => {
  const success = await read('src/routes/billing/success/+page.svelte');
  const canceled = await read('src/routes/billing/canceled/+page.svelte');
  assert.match(success, /BillingResult success=\{true\}/);
  assert.match(canceled, /BillingResult success=\{false\}/);
});

test('legacy shell skips routes owned by SvelteKit', async () => {
  const main = await read('src/main.ts');
  assert.match(main, /SVELTE_ROUTES/);
  assert.match(main, /billing\\?\/\(success\|canceled\)/);
  assert.match(main, /\/download/);
  assert.match(main, /\(terms\|privacy\|child-safety\|about\)/);
  assert.match(main, /docs/);
});

test('docs routes cover the index and article slugs', async () => {
  const index = await read('src/routes/docs/+page.svelte');
  const article = await read('src/routes/docs/[slug]/+page.svelte');
  assert.match(index, /createDocsPage\(\{\}/);
  assert.match(article, /createDocsPage\(\{ slug:/);
  assert.match(article, /page\.params\.slug/);
});

test('legal pages use the shared legacy page wrapper', async () => {
  const wrapper = await read('src/lib/svelte/LegacyPage.svelte');
  assert.match(wrapper, /initI18n/);
  assert.match(wrapper, /host\.appendChild/);
  for (const route of ['terms', 'privacy', 'child-safety', 'about']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /createLegalPage/);
    assert.ok(source.includes(`type: '${route}'`), `${route} must use its legal page type`);
  }
});

test('download route mounts the legacy page declaratively', async () => {
  const route = await read('src/routes/download/+page.svelte');
  assert.match(route, /createDownloadPage/);
  assert.match(route, /initI18n/);
  assert.match(route, /host\.appendChild/);
  assert.match(route, /:global\(#app\)/);
});

test('Svelte markup keeps the legacy classes and copy', async () => {
  const svelte = await read('src/lib/svelte/BillingResult.svelte');
  const legacy = await read('src/components/BillingResultPage.ts');
  for (const token of [
    'billing-result-page--success',
    'billing-result-page--canceled',
    'billing-result-card',
    'billing-result-icon',
    'billing-result-title fx-display',
    'billing-result-message',
    'billing-result-cta',
    'Payment Successful!',
    'Payment Canceled',
    'Back to Home',
  ]) {
    assert.ok(legacy.includes(token), `legacy component lost ${token}`);
    assert.ok(svelte.includes(token), `Svelte component lost ${token}`);
  }
});
