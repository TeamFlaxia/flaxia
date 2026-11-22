// F5 shell infrastructure: Svelte wrappers must mount/dispose the legacy nav
// so F6-F8 pages can adopt them without duplicating behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the left nav is owned by Svelte', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /class="left-nav"/);
  assert.match(source, /nav-item/);
  assert.match(source, /nav-user-area/);
  assert.match(source, /nav-legal-links/);
  assert.doesNotMatch(source, /createLeftNav/);
});

test('the right panel is owned by Svelte', async () => {
  const source = await read('src/lib/svelte/RightPanel.svelte');
  assert.match(source, /class="right-panel"/);
  assert.match(source, /trending-item/);
  assert.match(source, /games-list/);
  assert.match(source, /help-list/);
  assert.doesNotMatch(source, /createRightPanel/);
});

test('left nav follows auth props without rebuilding the DOM', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /\$derived\(props\.currentUser/);
  assert.match(source, /navItemsFor\(Boolean\(user\)\)/);
  assert.doesNotMatch(source, /replaceChildren/);
});

test('left nav installs mobile swipe handling', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /setupMobileLeftNav/);
});

test('bottom nav user state follows session props', async () => {
  const source = await read('src/lib/svelte/ShellLayout.svelte');
  assert.match(source, /updateUser/);
});

test('shell layout keeps the three-column landmark structure', async () => {
  const source = await read('src/lib/svelte/ShellLayout.svelte');
  assert.match(source, /class="main-container"/);
  assert.match(source, /role="main"/);
  assert.match(source, /<LeftNav/);
  assert.match(source, /<RightPanel/);
});

test('shell bootstrap restores the global Crowd node init', async () => {
  const source = await read('src/lib/svelte/bootstrap.ts');
  assert.match(source, /canRunFlaxiaNode\(\)/);
  assert.match(source, /initCrowdNode\(/);
  assert.match(source, /showCrowdConsentModal\(/);
  assert.match(source, /notifyCrowdConsentChanged\(\)/);
  // A missing node bundle must not break app init.
  assert.match(source, /Failed to initialize Crowd node/);
});
