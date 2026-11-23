// Ratchet for the legacy-DOM leaves migrated to Svelte. The UI markup lives in
// src/lib/svelte; the src/components files that remain only mount a component
// and expose the caller-facing API.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../../${path}`, import.meta.url));

const isGone = (path: string) => assert.equal(exists(path), false, `${path} must be deleted after the Svelte rewrite`);

const ownsMarkup = async (path: string, tokens: string[]) => {
  const source = await read(path);
  for (const token of tokens) assert.ok(source.includes(token), `${path} must render ${token}`);
  assert.doesNotMatch(source, /innerHTML/, `${path} must not build markup through innerHTML`);
};

test('settings categories are pure metadata and the adapter only mounts Svelte', async () => {
  const metadata = await read('src/lib/settings/categories.ts');
  assert.match(metadata, /SETTINGS_CATEGORY_SPECS/);
  assert.match(metadata, /resolveSettingsCategorySpecs/);
  assert.doesNotMatch(metadata, /document\.|mount\(|\.svelte/);

  const settings = await read('src/components/SettingsPage.ts');
  assert.match(settings, /resolveSettingsCategorySpecs/);
  assert.match(settings, /mountSettingsSection/);
  assert.doesNotMatch(settings, /innerHTML|document\.createElement/);

  const page = await read('src/lib/svelte/SettingsPage.svelte');
  assert.match(page, /groupSettingsCategories/);
});

test('Private Notes are a Svelte section mounted by the vault section', async () => {
  isGone('src/components/PrivateNotesSection.ts');
  await ownsMarkup('src/lib/svelte/PrivateNotesSection.svelte', ['vault-notes', 'settings.vault_note_save']);

  const vault = await read('src/lib/svelte/SettingsVaultSection.svelte');
  assert.match(vault, /from '\.\/PrivateNotesSection\.svelte'/);
  assert.match(vault, /<PrivateNotesSection \/>/);
  assert.doesNotMatch(vault, /components\/PrivateNotesSection/);
});

test('the vault unlock form is a Svelte component behind a mount adapter', async () => {
  isGone('src/components/VaultUnlockForm.ts');
  await ownsMarkup('src/lib/svelte/VaultUnlockForm.svelte', ['vault-unlock-form', 'settings.vault_unlock']);
  const adapter = await read('src/lib/settings/vault-unlock-form.ts');
  assert.match(adapter, /mount\(VaultUnlockForm/);
  assert.doesNotMatch(adapter, /innerHTML/);
  const mail = await read('src/lib/mail/vault-unlock.ts');
  assert.match(mail, /createVaultUnlockForm/);
});

test('the profile user post list is owned by Svelte', async () => {
  await ownsMarkup('src/lib/svelte/UserPostList.svelte', ['user-post-list', 'post-list']);
  const bridge = await read('src/components/UserPostList.ts');
  assert.match(bridge, /mount\(UserPostList/);
  assert.doesNotMatch(bridge, /innerHTML|className = 'post-list'/);
});

test('the mobile bottom nav is owned by Svelte', async () => {
  await ownsMarkup('src/lib/svelte/BottomNav.svelte', ['bottom-nav', 'bottom-nav-item']);
  const bridge = await read('src/components/BottomNav.ts');
  assert.match(bridge, /mount\(BottomNav/);
  assert.doesNotMatch(bridge, /innerHTML|createElement\('nav'\)/);
});

test('the app update notice is owned by Svelte', async () => {
  await ownsMarkup('src/lib/svelte/AppUpdateNotice.svelte', ['app-update-notice', 'app_update.dismiss']);
  const bridge = await read('src/components/AppUpdateNotice.ts');
  assert.match(bridge, /mount\(AppUpdateNotice/);
  assert.doesNotMatch(bridge, /innerHTML|createElement\('aside'\)/);
});

test('offline downloads are owned by Svelte', async () => {
  await ownsMarkup('src/lib/svelte/OfflineDownloads.svelte', ['offline_games.status', 'offline_games.retry']);
  const bridge = await read('src/components/OfflineDownloads.ts');
  assert.match(bridge, /mount\(OfflineDownloads/);
  assert.doesNotMatch(bridge, /innerHTML/);
});

test('dead skeleton helpers are gone instead of rebuilt in Svelte', async () => {
  for (const path of [
    'src/components/SkeletonCard.ts',
    'src/lib/svelte/SkeletonCard.svelte',
    'src/lib/loading-ui.ts',
  ]) {
    isGone(path);
  }
});

test('overlay bridges mount Svelte without building a wrapper DOM', async () => {
  for (const [file, component] of [
    ['src/components/StampPicker.ts', 'StampPicker'],
    ['src/components/SignInPrompt.ts', 'SignInPrompt'],
    ['src/components/CrowdConsentModal.ts', 'CrowdConsentModal'],
  ] as const) {
    const bridge = await read(file);
    assert.match(bridge, new RegExp(`mount\\(${component}`), `${file} must mount ${component}.svelte`);
    assert.doesNotMatch(bridge, /innerHTML/, `${file} must not build markup`);
    assert.doesNotMatch(bridge, /document\.createElement/, `${file} must not create a mount target`);
  }
});
