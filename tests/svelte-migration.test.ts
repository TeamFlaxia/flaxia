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

test('root route redirects to the home feed', async () => {
  const root = await read('src/routes/+page.svelte');
  assert.match(root, /location\.replace\('\/home'\)/);
  const layout = await read('src/routes/+layout.ts');
  assert.match(layout, /initShellBootstrap/);
});

test('bookmarks route uses the standalone shell', async () => {
  const route = await read('src/routes/bookmarks/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /createBookmarksPage/);
  assert.match(route, /getSessionUser/);
  assert.match(route, /createLeftNavHandlers/);
});

test('notifications route wires data fetching and shell', async () => {
  const route = await read('src/routes/notifications/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /fetchNotifications/);
  assert.match(route, /createNotificationsPage/);
  assert.match(route, /onMarkAllRead/);
  assert.match(route, /onNavigateToPost/);
});

test('auth-gated routes read currentUser from getMe().user', async () => {
  for (const route of ['bookmarks', 'notifications', 'settings']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /getSessionUser/, `${route} must use the shared session snapshot`);
    assert.match(source, /ShellLayout/);
  }
});

test('settings route mounts the legacy settings page', async () => {
  const route = await read('src/routes/settings/+page.svelte');
  assert.match(route, /createSettingsPage/);
});

test('mail routes share the shell-backed mail view', async () => {
  const view = await read('src/lib/svelte/MailView.svelte');
  assert.match(view, /ShellLayout/);
  assert.match(view, /createMailPage/);
  assert.match(view, /createMailSettingsPage/);
  assert.match(view, /createMailThreadPage/);
  assert.match(view, /createMailComposePage/);
  assert.match(view, /getSessionUser/);
  for (const route of ['mail', 'mail/settings', 'mail/compose', 'mail/thread/[id]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /MailView/);
  }
});

test('thread route owns its three-column page', async () => {
  const route = await read('src/routes/thread/[id]/+page.svelte');
  assert.match(route, /createThreadPage/);
  assert.match(route, /page\.params\.id/);
  assert.match(route, /sandboxOrigin/);
  assert.match(route, /onBack/);
  assert.doesNotMatch(route, /ShellLayout/, 'ThreadPage already renders its own shell');
});

test('home feed route keeps the iframe-safe timeline', async () => {
  const route = await read('src/routes/home/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /createTimeline/);
  assert.match(route, /openLeftNav/);
  assert.match(route, /getSessionUser/);
});

test('remaining legacy views now have Svelte routes', async () => {
  const cases = [
    ['explore', 'createExplorePage'],
    ['search', 'createSearchPage'],
    ['translate', 'createTranslatePage'],
    ['profile/[username]', 'createProfilePage'],
    ['users/[username]', 'createProfilePage'],
    ['@[domain]/[username]', 'createRemoteProfilePage'],
  ] as const;
  for (const [route, component] of cases) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /LegacyShellPage/);
    assert.ok(source.includes(component), `${route} must mount ${component}`);
  }
});

test('home feed owns the composer through a Svelte mount point', async () => {
  const composer = await read('src/lib/svelte/Composer.svelte');
  assert.match(composer, /createPostComposer/);
  const home = await read('src/routes/home/+page.svelte');
  assert.match(home, /composerHost/);
  assert.match(home, /mount\(Composer/);
  const timeline = await read('src/components/Timeline.ts');
  assert.match(timeline, /composerHost/);
  const types = await read('shared/types/post.ts');
  assert.match(types, /composerHost\?: HTMLElement/);
});

test('admin routes render the standalone admin layout', async () => {
  for (const route of ['admin', 'admin/[tab]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /AdminView/);
  }
  const view = await read('src/lib/svelte/AdminView.svelte');
  assert.match(view, /createAdminLayout/);
  assert.match(view, /setAccessDenied/);
  assert.match(view, /createAdminAnalyticsTab/);
});

test('F8 routes use the shell with correct rails', async () => {
  const arcade = await read('src/lib/svelte/ArcadeView.svelte');
  assert.match(arcade, /createArcadePage/);
  assert.match(arcade, /initialGameId/);
  for (const route of ['arcade', 'arcade/[id]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /ArcadeView/);
  }
  const maps = await read('src/routes/maps/+page.svelte');
  assert.match(maps, /createMapsPage/);
  assert.match(maps, /showRightPanel=\{false\}/);
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
  assert.doesNotMatch(route, /:global\(#app\)/, 'Svelte shell must render inside #app');
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

test('SvelteKit body renders inside #app so legacy CSS selectors apply', async () => {
  const app = await read('src/app.html');
  assert.match(app, /<div id="app">%sveltekit\.body%<\/div>/);
});

test('legacy main entrypoint is gone', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../src/main.ts', import.meta.url).pathname), false);
});
