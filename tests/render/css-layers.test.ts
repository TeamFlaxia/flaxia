import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('styles/css-entry', () => {
  it('loads the app through one stylesheet entry', () => {
    // The single stylesheet entry moved from legacy main.ts into the Svelte
    // root layout when main.ts was removed (#420).
    const layout = read('src/routes/+layout.svelte');
    assert.match(layout, /import '\.\.\/styles\/index\.css';/);
    assert.doesNotMatch(layout, /styles\/redesign\//);
    assert.doesNotMatch(layout, /styles\/render\/primitives\.css/);
  });

  it('imports the app CSS in cascade order and never in @layer', () => {
    const entry = read('src/styles/index.css');
    // Regression guard: `index.html` inlines unlayered critical CSS, and
    // unlayered declarations always beat layered ones. Wrapping the app CSS in
    // `@layer` silently drops the skin back to the critical CSS values, so the
    // entry must stay unlayered.
    assert.doesNotMatch(entry, /@layer\s+legacy/);
    assert.doesNotMatch(entry, /layer\(legacy\)|layer\(primitives\)/);
    assert.match(entry, /@import ['"]\.\/main\.css['"];/);
    assert.match(entry, /@import ['"]\.\/redesign\/foundation\.css['"];/);
    assert.match(entry, /@import ['"]\.\/legacy\/theme\.css['"];/);
    assert.match(entry, /@import ['"]\.\/legacy\/overrides\.css['"];/);
    assert.match(entry, /@import ['"]\.\/render\/primitives\.css['"];/);
    assert.doesNotMatch(entry, /redesign\/(mail|maps)\.css/, 'route-only CSS must stay out of the global entry');

    const foundation = entry.indexOf('./redesign/foundation.css');
    const main = entry.indexOf('./main.css');
    const theme = entry.indexOf('./legacy/theme.css');
    const overrides = entry.indexOf('./legacy/overrides.css');
    const primitives = entry.indexOf('./render/primitives.css');

    assert.ok(foundation < main, 'redesign feature CSS must load before the legacy skin');
    assert.ok(main < theme, 'legacy tokens must load after main.css');
    assert.ok(theme < overrides, 'legacy overrides must follow the token layer');
    assert.ok(overrides < primitives, 'primitives must load last so they can override legacy rules in source order');
  });

  it('loads route-only stylesheets from their route components', () => {
    assert.match(read('src/lib/svelte/MailView.svelte'), /import ['"]\.\.\/\.\.\/styles\/redesign\/mail\.css['"]/);
    assert.match(read('src/lib/svelte/MapsPage.svelte'), /import ['"]\.\.\/\.\.\/styles\/redesign\/maps\.css['"]/);
  });

  it('neutralizes the legacy avatar overlap only when the profile banner is empty', () => {
    const pages = read('src/styles/redesign/pages.css');
    // A real `header_key` must keep its image, so only the empty placeholder
    // marker added by ProfilePage.svelte may be hidden.
    assert.match(pages, /\.main-container:has\(\.profile-page\) \.profile-banner--empty\s*\{\s*display:\s*none/);
    assert.doesNotMatch(
      pages,
      /\.main-container:has\(\.profile-page\) \.profile-banner\s*\{\s*display:\s*none/,
      'an unconditional hide would also remove uploaded header images',
    );
    const avatar = pages.match(
      /\.main-container:has\(\.profile-page \.profile-banner--empty\) \.profile-avatar\s*\{[^}]+\}/,
    );
    assert.ok(avatar, 'profile avatar needs a banner-hidden offset override scoped to the empty banner');
    assert.match(avatar[0], /top:\s*0/);
    assert.match(avatar[0], /margin-bottom:\s*0/);
    const header = pages.match(
      /\.main-container:has\(\.profile-page \.profile-banner--empty\) \.profile-header\s*\{[^}]+\}/,
    );
    assert.ok(header, 'profile header needs a banner-hidden padding override scoped to the empty banner');
    assert.match(header[0], /padding-top:\s*16px/);
  });

  it('marks the profile banner empty without a header image but still applies that image', () => {
    const page = read('src/lib/svelte/ProfilePage.svelte');
    assert.match(page, /class:profile-banner--empty=\{!data\?\.header_key\}/);
    const applyBanner = page.match(/function applyBanner\(\): void \{[\s\S]*?\n\}/);
    assert.ok(applyBanner, 'applyBanner must still be present');
    assert.match(applyBanner[0], /data\.header_key/);
  });

  it('keeps the mobile banner height above the later legacy main.css rule', () => {
    const pages = read('src/styles/redesign/pages.css');
    const blocks = [...pages.matchAll(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]);
    const bannerBlock = blocks.find((block) => /\.profile-banner\s*\{/.test(block));
    assert.ok(bannerBlock, 'the profile banner needs a height override inside @media (max-width: 480px)');
    assert.match(
      bannerBlock,
      /\.main-container:has\(\.profile-page\) \.profile-banner\s*\{\s*height:\s*72px;/,
      'main.css is imported later with height:160px, so the mobile override needs a higher-specificity selector',
    );
  });

  it('applies a frozen profile header image and hides an empty frozen banner', () => {
    const page = read('src/lib/svelte/ProfilePage.svelte');
    assert.match(
      page,
      /\{:else if frozen\}\s*<div bind:this=\{banner\} class="profile-banner"[^>]*class:profile-banner--empty=\{!data\?\.header_key\}/,
      'the frozen banner needs the same binding and empty marker as the editable banner',
    );
    const loadUser = page.match(/async function loadUser\(\): Promise<void> \{[\s\S]*?\n\}/);
    assert.ok(loadUser, 'loadUser must still be present');
    assert.match(
      loadUser[0],
      /if \(frozen\) \{[\s\S]*?queueMicrotask\(\(\) => applyBanner\(\)\);\s*return;\s*\}/,
      'a frozen user still needs applyBanner() after Svelte binds the frozen banner',
    );
  });

  it('makes the editable banner keyboard accessible without changing its role', () => {
    const page = read('src/lib/svelte/ProfilePage.svelte');
    const banner = page.match(
      /<div bind:this=\{banner\} class="profile-banner" class:profile-banner--editable=\{own\}[\s\S]*?role=\{own \? 'button' : undefined\}>/,
    );
    assert.ok(banner, 'editable banner markup must keep its role and click handler');
    assert.match(banner[0], /tabindex=\{own \? 0 : undefined\}/);
    assert.match(banner[0], /aria-label=\{own \? t\('profile\.change_header'\) : undefined\}/);
    assert.match(banner[0], /onclick=\{\(\) => \{ if \(own\) editProfile\(\); \}\}/);
    assert.match(banner[0], /onkeydown=/);
    assert.match(banner[0], /e\.key === 'Enter'/);
    assert.match(banner[0], /e\.key === ' '/);
    assert.match(banner[0], /editProfile\(\)/);
  });
});
