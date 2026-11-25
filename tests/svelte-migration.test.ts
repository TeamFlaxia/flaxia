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
  const root = await read('src/routes/+page.ts');
  assert.match(root, /redirect\(308, '\/home'\)/);
  const layout = await read('src/routes/+layout.ts');
  assert.match(layout, /bootShell/);
  // Shell side effects moved to a non-blocking helper.
  const boot = await read('src/lib/svelte/shell-boot.ts');
  assert.match(boot, /initShellBootstrap/);
});

test('explore route renders the Svelte component directly', async () => {
  const route = await read('src/routes/explore/+page.svelte');
  assert.match(route, /lib\/svelte\/ExplorePage\.svelte/);
  const component = await read('src/lib/svelte/ExplorePage.svelte');
  assert.match(component, /explore-filter-bar/);
  assert.match(component, /CardHost/);
});

test('profile routes render the Svelte component directly', async () => {
  for (const route of ['profile/[username]', 'users/[username]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /lib\/svelte\/ProfilePage\.svelte/);
  }
  const component = await read('src/lib/svelte/ProfilePage.svelte');
  assert.match(component, /profile-topbar/);
  assert.match(component, /profile-tabs/);
});

test('search route renders the Svelte component directly', async () => {
  const route = await read('src/routes/search/+page.svelte');
  assert.match(route, /lib\/svelte\/SearchPage\.svelte/);
  const component = await read('src/lib/svelte/SearchPage.svelte');
  assert.match(component, /search-page-content/);
  assert.match(component, /search-filter-bar/);
});

test('translate route renders the Svelte component directly', async () => {
  const route = await read('src/routes/translate/+page.svelte');
  assert.match(route, /lib\/svelte\/TranslatePage\.svelte/);
  const component = await read('src/lib/svelte/TranslatePage.svelte');
  assert.match(component, /translate-panes/);
  assert.match(component, /translate-mode-button/);
});

test('bookmarks route uses the standalone shell', async () => {
  const route = await read('src/routes/bookmarks/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /lib\/svelte\/BookmarksPage\.svelte/);
  assert.match(route, /getSessionUser/);
  const component = await read('src/lib/svelte/BookmarksPage.svelte');
  assert.match(component, /bookmarks-posts/);
  assert.match(component, /CardHost/);
});

test('notifications route wires data fetching and shell', async () => {
  const route = await read('src/routes/notifications/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /fetchNotifications/);
  assert.match(route, /lib\/svelte\/NotificationsPage\.svelte/);
  assert.match(route, /onMarkAllRead/);
  assert.match(route, /onNavigateToPost/);
  const component = await read('src/lib/svelte/NotificationsPage.svelte');
  assert.match(component, /notification-row/);
});

test('auth-gated routes read currentUser from getMe().user', async () => {
  for (const route of ['bookmarks', 'notifications', 'settings']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /getSessionUser/, `${route} must use the shared session snapshot`);
    assert.match(source, /ShellLayout/);
  }
});

test('settings route renders the Svelte settings page', async () => {
  const route = await read('src/routes/settings/+page.svelte');
  assert.match(route, /lib\/svelte\/SettingsPage\.svelte/);
  const component = await read('src/lib/svelte/SettingsPage.svelte');
  assert.match(component, /loadSettingsCategories/);
  assert.doesNotMatch(component, /createSettingsPage/);
});

test('mail routes share the shell-backed mail view', async () => {
  const view = await read('src/lib/svelte/MailView.svelte');
  assert.match(view, /ShellLayout/);
  assert.match(view, /MailPage/);
  assert.match(view, /MailSettingsPage/);
  assert.match(view, /MailThreadPage/);
  assert.match(view, /MailComposePage/);
  assert.match(view, /getSessionUser/);
  for (const route of ['mail', 'mail/settings', 'mail/compose', 'mail/thread/[id]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /MailView/);
  }
});

test('thread route renders the Svelte page directly', async () => {
  const route = await read('src/routes/thread/[id]/+page.svelte');
  assert.match(route, /lib\/svelte\/ThreadPage\.svelte/);
});
test('timeline feed is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/Timeline.svelte');
  assert.match(component, /CardHost/);
  assert.match(component, /loadInitial/);
  assert.match(component, /<Composer \/>/);
  const cards = await read('src/lib/timeline/cards.ts');
  assert.match(cards, /mountPostCard/);
  assert.match(cards, /mountAdCard/);
});

test('home feed route renders the Svelte timeline', async () => {
  const route = await read('src/routes/home/+page.svelte');
  assert.match(route, /ShellLayout/);
  assert.match(route, /lib\/svelte\/Timeline\.svelte/);
  assert.match(route, /getSessionUser/);
  const timeline = await read('src/lib/svelte/Timeline.svelte');
  assert.match(timeline, /openLeftNav/);
  assert.match(timeline, /post-list/);
});

test('home feed owns the composer through a Svelte mount point', async () => {
  const composer = await read('src/lib/svelte/Composer.svelte');
  assert.match(composer, /PostComposer/);
  const implementation = await read('src/lib/svelte/PostComposer.svelte');
  assert.match(implementation, /composer-textarea/);
  assert.match(implementation, /submitPost/);
  assert.match(implementation, /composer-poll-section/);
  const modal = await read('src/lib/svelte/PostModal.svelte');
  assert.match(modal, /post-modal-overlay/);
  assert.match(modal, /ComposerDraftsPanel/);
  assert.match(modal, /getModalCount\(\) > 1/);
  const adapter = await read('src/lib/post-modal.ts');
  assert.match(adapter, /mount\(PostModalView/);
  assert.doesNotMatch(adapter, /document\.createElement\('div'\)[\s\S]*createElement/, 'the modal DOM lives in Svelte');
  const timeline = await read('src/lib/svelte/Timeline.svelte');
  assert.match(timeline, /<Composer \/>/);
  assert.match(timeline, /CardHost/);
});

test('thread route renders the Svelte component directly', async () => {
  const route = await read('src/routes/thread/[id]/+page.svelte');
  assert.match(route, /lib\/svelte\/ThreadPage\.svelte/);
  const component = await read('src/lib/svelte/ThreadPage.svelte');
  assert.match(component, /thread-root-post-container/);
  const adapters = await read('src/lib/thread/adapters.ts');
  assert.match(adapters, /createReplyNode/);
});

test('mailbox list is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/MailPage.svelte');
  assert.match(component, /mail-folder-tabs/);
  assert.match(component, /mail-thread-row/);
  const adapter = await read('src/lib/mail/vault-unlock.ts');
  assert.match(adapter, /createVaultUnlockForm/);
});

test('arcade route renders the Svelte player directly', async () => {
  const view = await read('src/lib/svelte/ArcadeView.svelte');
  assert.match(view, /ArcadePage\.svelte/);
  const page = await read('src/lib/svelte/arcade/ArcadePage.svelte');
  assert.match(page, /ArcadeStage/);
  assert.match(page, /ArcadeModals/);
  assert.doesNotMatch(page, /document\.createElement\('div'\)/);
  const stage = await read('src/lib/svelte/arcade/ArcadeStage.svelte');
  assert.match(stage, /arcade-game-container/);
  assert.match(stage, /ArcadeGameViewport/);
  const viewport = await read('src/lib/svelte/arcade/ArcadeGameViewport.svelte');
  assert.match(viewport, /mountZipPlayer/);
  const feed = await read('src/lib/arcade/feed.ts');
  assert.match(feed, /findAvailableArcadeGame/);
});

test('admin routes render the standalone admin layout', async () => {
  for (const route of ['admin', 'admin/[tab]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /AdminView/);
  }
  const view = await read('src/lib/svelte/AdminView.svelte');
  assert.match(view, /mountAdminTab/);
  assert.match(view, /admin_layout.access_denied/);
  assert.doesNotMatch(view, /createAdmin/);
  const adapter = await read('src/lib/admin/tab-adapters.ts');
  assert.match(adapter, /AdminAnalyticsTab\.svelte/);
  assert.doesNotMatch(adapter, /createAdmin/);
  for (const tab of ['Analytics', 'Alerts', 'Counter', 'Hidden', 'Users', 'Ads']) {
    const component = await read(`src/lib/svelte/Admin${tab}Tab.svelte`);
    assert.ok(component.length > 0);
  }
});

test('F8 routes use the shell with correct rails', async () => {
  const arcade = await read('src/lib/svelte/ArcadeView.svelte');
  assert.match(arcade, /ArcadePage/);
  assert.match(arcade, /initialGameId/);
  for (const route of ['arcade', 'arcade/[id]']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /ArcadeView/);
  }
  const maps = await read('src/routes/maps/+page.svelte');
  assert.match(maps, /<MapsPage \/>/);
  assert.match(maps, /showRightPanel=\{false\}/);
  const mapsPage = await read('src/lib/svelte/MapsPage.svelte');
  assert.match(mapsPage, /import\('maplibre-gl'\)/);
  assert.doesNotMatch(maps, /createMapsPage/);
});

test('docs routes cover the index and article slugs', async () => {
  // Docs content is resolved in universal loads now, so it exists in SSR HTML.
  const content = await read('src/lib/docs/ssr-content.ts');
  assert.match(content, /fetchDocsManifest/);
  assert.match(content, /markdown-it/);
  const component = await read('src/lib/svelte/DocsPage.svelte');
  assert.doesNotMatch(component, /\$effect/, 'the docs component must not fetch during render');
  const index = await read('src/routes/docs/+page.svelte');
  const article = await read('src/routes/docs/[slug]/+page.svelte');
  assert.match(index, /lib\/svelte\/DocsPage\.svelte/);
  assert.match(article, /lib\/svelte\/DocsPage\.svelte/);
});

test('remote profile route renders the Svelte component directly', async () => {
  const route = await read('src/routes/@[domain]/[username]/+page.svelte');
  assert.match(route, /lib\/svelte\/RemoteProfilePage\.svelte/);
  assert.match(route, /ShellLayout/);
  const component = await read('src/lib/svelte/RemoteProfilePage.svelte');
  assert.match(component, /remote-profile-page/);
  assert.match(component, /profile-follow-button/);
});

test('legal pages render the Svelte component directly', async () => {
  const content = await read('src/lib/docs/ssr-content.ts');
  assert.match(content, /markdownToHtml/, 'legal markdown is rendered in the SSR load');
  const component = await read('src/lib/svelte/LegalPage.svelte');
  assert.doesNotMatch(component, /\$effect/, 'the legal component must not fetch during render');
  assert.match(component, /legal-footer-links/);
  for (const route of ['terms', 'privacy', 'child-safety', 'about']) {
    const source = await read(`src/routes/${route}/+page.svelte`);
    assert.match(source, /lib\/svelte\/LegalPage\.svelte/);
    assert.ok(source.includes(`type="${route}"`), `${route} must use its legal page type`);
  }
});

test('download route renders the Svelte page directly', async () => {
  const route = await read('src/routes/download/+page.svelte');
  assert.match(route, /lib\/svelte\/DownloadPage\.svelte/);
  const component = await read('src/lib/svelte/DownloadPage.svelte');
  assert.match(component, /download-card/);
  assert.match(component, /download-chip/);
});

test('billing result keeps its legacy classes and copy in Svelte', async () => {
  const svelte = await read('src/lib/svelte/BillingResult.svelte');
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
    assert.ok(svelte.includes(token), `Svelte component lost ${token}`);
  }
});

test('SvelteKit body renders inside #app so legacy CSS selectors apply', async () => {
  const app = await read('src/app.html');
  assert.match(app, /<div id="app">[\s\S]*%sveltekit\.body%[\s\S]*<\/div>/);
  // SSR sends real content, so the client-only spinner/skeleton must be gone.
  assert.doesNotMatch(app, /id="initial-loader"|id="initial-feed-skeleton"/);
});

test('legacy entry points use the unified navigation function', async () => {
  const nav = await read('src/lib/navigation.ts');
  assert.match(nav, /\$app\/navigation/);
  assert.match(nav, /goto\(/);
  // SvelteKit 3 throws on the removed options in dev, so navigation must not
  // pass them; `replace` is the supported spelling of `replaceState`.
  assert.doesNotMatch(nav, /^\s*(noScroll|keepFocus):/m);
  assert.match(nav, /replace: options\.replaceState/);
  for (const file of ['src/lib/svelte/RightPanel.svelte', 'src/lib/svelte/LeftNav.svelte']) {
    const source = await read(file);
    assert.match(source, /from '[^']*navigation\.ts'/);
    assert.doesNotMatch(source, /history\.pushState/);
    assert.doesNotMatch(source, /new CustomEvent\('spaNavigate'/);
  }
});

test('nav handlers leave the URL to the SPA router', async () => {
  for (const file of ['src/lib/left-nav-handlers.ts', 'src/lib/bottom-nav-setup.ts']) {
    const source = await read(file);
    assert.doesNotMatch(source, /history\.(pushState|replaceState)/);
    assert.doesNotMatch(source, /pushSpaHistory/);
  }
  const shell = await read('src/lib/svelte/ShellLayout.svelte');
  assert.doesNotMatch(shell, /window\.location\.assign/);
});

test('docs manifest is written after the adapter finishes', async () => {
  const postbuild = await read('scripts/postbuild.mjs');
  assert.match(postbuild, /writeDocsManifest/);
  const docs = await read('src/lib/docs/manifest.ts');
  assert.match(docs, /\/docs\/index\.json/);
});

test('feed game cards start playing when the preview is clicked', async () => {
  const card = await read('src/lib/svelte/PostCard.svelte');
  assert.match(card, /onModeChange: handleStageModeChange/);
  assert.match(card, /stage\?\.update\(props\.post, mode/);
  assert.doesNotMatch(card, /onModeChange: \(\) => \{\}/);
});

test('the mobile nav drawer closes on every client navigation', async () => {
  const layout = await read('src/routes/+layout.svelte');
  assert.match(layout, /beforeNavigate\(\(\) => closeLeftNav\(\)\)/);
});

test('icon-only nav rails narrow the sidebar too', async () => {
  const overrides = await read('src/styles/legacy/overrides.css');
  assert.match(
    overrides,
    /@media \(min-width: 769px\) and \(max-width: 1024px\)[\s\S]*#app \.left-nav \{\s*width: 72px/,
  );
  assert.match(overrides, /#app \.left-nav\.left-nav--icons \{\s*width: 72px/);
});

test('thread page keeps the styled back button and flat reply composers', async () => {
  const thread = await read('src/lib/svelte/ThreadPage.svelte');
  assert.match(thread, /class="thread-back-button"/);
  assert.match(thread, /onReplyCreated: \(reply\) => addReply\(reply\)/);
  const adapters = await read('src/lib/thread/adapters.ts');
  assert.match(adapters, /disableReplyComposer: options\.disableReplyComposer \?\? false/);
  const styles = await read('src/styles/redesign/timeline.css');
  assert.match(styles, /\.thread-back-button \{/);
});

test('remote media URLs are rendered directly and archives stay links', async () => {
  const carousel = await read('src/components/MediaCarousel.ts');
  assert.match(carousel, /isAbsoluteMediaUrl/);
  assert.match(carousel, /src: attachmentUrl\(att\)/);
  const remote = await read('src/lib/svelte/RemoteProfilePage.svelte');
  assert.match(remote, /remote-post-attachments/);
  assert.match(remote, /attachmentUrl\(att\)/);
});

test('post counters stay in sync across every mounted card', async () => {
  const card = await read('src/lib/svelte/PostCard.svelte');
  assert.match(card, /new CustomEvent\('postUpdated'/);
  assert.match(card, /window\.addEventListener\('postUpdated'/);
  assert.match(card, /broadcast\(\{ reply_count: replyCount \}\)/);
  for (const file of [
    'src/lib/svelte/Timeline.svelte',
    'src/lib/svelte/ExplorePage.svelte',
    'src/lib/svelte/BookmarksPage.svelte',
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /createPostUpdatedHandler/);
  }
});

test('game updates reload the stage and logout clears the session snapshot', async () => {
  const card = await read('src/lib/svelte/PostCard.svelte');
  assert.match(card, /openGameUpdate\(props\.post, props\.sandboxOrigin, \(\) => playVersion\(null\)\)/);
  const session = await read('src/lib/svelte/session.ts');
  assert.match(session, /export function clearSessionUser/);
  const cache = await read('src/lib/auth-cache.ts');
  assert.match(cache, /clearSessionUser\(\)/);
});

test('guests are redirected away from /settings instead of seeing an empty shell', async () => {
  const route = await read('src/routes/settings/+page.svelte');
  assert.match(route, /resolveAuthRedirect\('\/settings'/);
  assert.match(route, /navigate\(redirect\.path, \{ replaceState: true \}\)/);
});

test('avatars and action states stay visible without coloured halos', async () => {
  const composer = await read('src/styles/redesign/composer.css');
  assert.match(composer, /\.composer-avatar-img \{[^}]*width: 100%/);
  assert.match(composer, /\.composer-avatar-img \{[^}]*background-size: cover/);
  const shell = await read('src/styles/redesign/shell.css');
  assert.match(shell, /\.bottom-nav \.bottom-nav-avatar \{[^}]*background-size: cover/);
  const timeline = await read('src/styles/redesign/timeline.css');
  assert.match(timeline, /\.action-button--reload\.action-button--active \{[^}]*background: transparent/);
  assert.doesNotMatch(timeline, /\.action-button--fresh:hover \{[^}]*background:/);
});

test('Crowd can fetch its data: WASM while the centre column grows without a rail', async () => {
  const config = await read('vite.config.ts');
  assert.match(config, /'connect-src': \['self', 'https:', 'wss:', 'blob:', 'data:'\]/);
  const overrides = await read('src/styles/legacy/overrides.css');
  assert.match(overrides, /#app \.main-content \{[^}]*max-width: 600px/);
  assert.match(overrides, /#app \.right-panel \{[^}]*width: 350px/);
  assert.match(overrides, /#app \.main-container \{[^}]*margin: 0 auto/);
});

test('the document title follows the route', async () => {
  const layout = await read('src/routes/+layout.svelte');
  assert.match(layout, /pageTitle\(page\.url\.pathname\)/);
  assert.match(layout, /<svelte:head>[\s\S]*<title>\{routeTitle\(\)\}<\/title>/);
  const titles = await read('src/lib/page-title.ts');
  assert.match(titles, /thread\.title/);
  assert.match(titles, /nav\.settings/);
});

test('image previews always open the fullscreen viewer', async () => {
  const adapter = await read('src/components/ImagePreview.ts');
  assert.doesNotMatch(adapter, /props\.src\s*\?\s*\(\)\s*=>\s*\{\}/);
  assert.match(adapter, /onOpenOverlay: \(\) => \{\s*createImageOverlay/);
});

test('the dev crowd node bundle is served same-origin', async () => {
  const config = await read('vite.config.ts');
  assert.match(config, /crowd-node-dev/);
  assert.ok(config.includes('node_modules/@flaxia/node/dist'));
  const devPlugin = config.slice(config.indexOf('crowd-node-dev'));
  assert.doesNotMatch(devPlugin, /unpkg\.com/, 'the crowd node must load from node_modules, not a CDN');
});

test('client error hook is safe against patched console methods', async () => {
  const hook = await read('src/hooks.client.ts');
  assert.match(hook, /typeof console\.error === 'function'/);
  assert.match(hook, /__flaxiaLastError/);
  assert.match(hook, /source\.error/, 'log the real error, not the removed message/status properties');
  assert.match(hook, /source\.kind/, 'keep the SvelteKit error kind');
  const config = await read('vite.config.ts');
  assert.doesNotMatch(config, /script-src-elem/);
  assert.match(config, /inlineScriptHash\(/);
  assert.match(config, /static\.cloudflareinsights\.com/);
});

test('engagement endpoints expose canonical is_* fields for the Svelte cards', async () => {
  const engagement = await read('functions/api/routes/posts/engagement.ts');
  for (const field of ['is_freshed', 'is_reloaded', 'is_bookmarked']) {
    assert.match(engagement, new RegExp(field), `${field} must be in the toggle response`);
  }
  const card = await read('src/lib/svelte/PostCard.svelte');
  assert.match(card, /data\.is_freshed \?\? data\.freshed/);
  assert.match(card, /data\.is_reloaded \?\? data\.reloaded/);
  assert.match(card, /data\.is_bookmarked \?\? data\.bookmarked/);
});

test('post card edits use the server PUT endpoint', async () => {
  const card = await read('src/lib/svelte/PostCard.svelte');
  assert.match(card, /fetch\(`\/api\/posts\/\$\{props\.post\.id\}`[\s\S]{0,160}?method: 'PUT'/);
  assert.doesNotMatch(card, /method: 'PATCH'/, 'there is no PATCH /api/posts/:id route');
  const route = await read('functions/api/routes/posts/manage.ts');
  assert.match(route, /manage\.put\('\/posts\/:id'/);
});

test('trending tags are fetched through one shared loader', async () => {
  for (const file of [
    'src/lib/svelte/LeftNav.svelte',
    'src/lib/svelte/RightPanel.svelte',
    'src/lib/svelte/ExplorePage.svelte',
  ]) {
    assert.doesNotMatch(await read(file), /fetch\('\/api\/tags\/trending'\)/, `${file} must use the shared loader`);
  }
  const loader = await read('src/lib/tags/trending.ts');
  assert.match(loader, /pending/, 'concurrent mounts must share an in-flight request');
});

test('mail page tears down its unlock adapter safely on navigation', async () => {
  const mail = await read('src/lib/svelte/MailPage.svelte');
  assert.doesNotMatch(mail, /unmount\(unlockInstance\)/, 'mountVaultUnlock returns a destroy handle, not a mount');
  assert.match(mail, /unlockInstance\?\.destroy\(\)/);
  assert.match(mail, /if \(destroyed\) return;/, 'async setup must stop after the page is destroyed');
});

test('legacy main entrypoint is gone', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../src/main.ts', import.meta.url).pathname), false);
});

test('stamp picker UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/StampPicker.svelte');
  assert.match(component, /emoji-picker-element/);
  assert.match(component, /stamp-picker-tabs/);
  const bridge = await read('src/components/StampPicker.ts');
  assert.match(bridge, /mount\(StampPicker/);
  assert.doesNotMatch(bridge, /stamp-picker-tabs/, 'DOM construction must live in the Svelte component');
});

test('audio player UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/AudioPlayer.svelte');
  assert.match(component, /audio-player-visualizer|audio-visualizer-canvas/);
  assert.match(component, /AudioVisualizer/);
  const bridge = await read('src/components/AudioPlayer.ts');
  assert.match(bridge, /mount\(AudioPlayer/);
  assert.doesNotMatch(bridge, /audio-player-controls/, 'DOM construction must live in the Svelte component');
});

test('post card display is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/PostCard.svelte');
  assert.match(component, /post-card--media/);
  assert.match(component, /CardHost|mountStage/);
  assert.match(component, /PostHeader/);
  const adapters = await read('src/lib/post/card-adapters.ts');
  assert.match(adapters, /createPostActions/);
  const bridge = await read('src/components/PostCard.ts');
  assert.match(bridge, /mount\(PostCardView/);
});

test('quoted post card is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/QuotedPostCard.svelte');
  assert.match(component, /quoted-post-card/);
  assert.match(component, /mountQuotedAttachment/);
  const media = await read('src/lib/post/quoted-media.ts');
  assert.match(media, /createMediaCarousel/);
});

test('post card sub-components are owned by Svelte', async () => {
  const header = await read('src/lib/svelte/PostHeader.svelte');
  assert.ok(header.includes('post-avatar'), 'PostHeader must render post-avatar');
  const menu = await read('src/lib/svelte/PostMenu.svelte');
  assert.ok(menu.includes('post-menu-dropdown'), 'PostMenu must render post-menu-dropdown');
  const bridge = await read('src/components/PostMenu.ts');
  assert.match(bridge, /mount\(/, 'PostMenu bridge must mount Svelte');
});

test('reply composer UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/ReplyComposer.svelte');
  assert.match(component, /reply-composer-textarea/);
  assert.match(component, /submitReply/);
  assert.match(component, /mention-dropdown/);
  const submit = await read('src/lib/composer/reply-submit.ts');
  assert.match(submit, /replies\/prepare/);
  assert.match(submit, /replies\/commit/);
  const bridge = await read('src/components/ReplyComposer.ts');
  assert.match(bridge, /mount\(ReplyComposerView/);
  assert.doesNotMatch(bridge, /className = 'reply-composer'/, 'DOM construction must live in Svelte');
});

test('image preview UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/ImagePreview.svelte');
  assert.match(component, /image-preview-img/);
  assert.match(component, /image-preview-loading/);
  const bridge = await read('src/components/ImagePreview.ts');
  assert.match(bridge, /mount\(ImagePreview/);
  assert.doesNotMatch(bridge, /className = 'image-preview-img'/, 'DOM construction must live in the Svelte component');
});

test('video player UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/VideoPlayer.svelte');
  assert.match(component, /video-player-controls/);
  assert.match(component, /video-player-seekbar/);
  const bridge = await read('src/components/VideoPlayer.ts');
  assert.match(bridge, /mount\(VideoPlayer/);
  assert.doesNotMatch(bridge, /video-player-controls/, 'DOM construction must live in the Svelte component');
});

test('sign-in prompt UI is owned by Svelte', async () => {
  const component = await read('src/lib/svelte/SignInPrompt.svelte');
  assert.match(component, /signin-prompt-dialog/);
  const bridge = await read('src/components/SignInPrompt.ts');
  assert.match(bridge, /mount\(SignInPrompt/);
  assert.doesNotMatch(bridge, /signin-prompt-dialog/, 'DOM construction must live in the Svelte component');
});

test('login and register routes start the external auth flow', async () => {
  const login = await read('src/routes/login/+page.svelte');
  assert.match(login, /AuthRedirectPage mode="login"/);
  const register = await read('src/routes/register/+page.svelte');
  assert.match(register, /AuthRedirectPage mode="register"/);
  const page = await read('src/lib/svelte/AuthRedirectPage.svelte');
  assert.match(page, /startAuthRedirect\(mode\)/);
  assert.match(page, /searchParams\.get\('error'\)/);
  const helper = await read('src/lib/svelte/auth-start.ts');
  assert.match(helper, /beginNativeAuthRedirect/);
  assert.match(helper, /\/api\/auth\/start/);
});
