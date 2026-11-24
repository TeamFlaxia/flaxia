// SvelteKit owns the page CSP: `csp.mode = 'hash'` emits a hash for every
// inline script, so the same policy works for SSR and the static native build.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { appHtmlInlineScriptHashes } from '../scripts/app-html-hashes.mjs';

test('SvelteKit CSP is hash-based and covers app.html inline scripts', async () => {
  const config = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /csp:\s*\{[\s\S]*?mode:\s*'hash'/, 'hash mode works for SSR and prerender');
  assert.ok(config.includes('appHtmlInlineScriptHashes()'), 'app.html scripts must be hashed');
  assert.ok(config.includes('inlineScriptHash(ADSENSE_INLINE_BOOTSTRAP)'));
  assert.ok(config.includes('inlineScriptHash(FLASH_PLAYER_BOOTSTRAP)'));

  const hashes = appHtmlInlineScriptHashes(new URL('../src/app.html', import.meta.url).pathname);
  assert.ok(hashes.length > 0, 'app.html should keep the theme boot script');
  for (const hash of hashes) assert.match(hash, /^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test('the static _headers file does not shadow the SvelteKit CSP', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  assert.doesNotMatch(
    headers,
    /^\s*Content-Security-Policy:/m,
    'a static CSP header would intersect with the per-request hash policy',
  );
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Strict-Transport-Security/);
});

test('app.html inline scripts do not depend on a prerender-unsafe nonce', async () => {
  const html = await readFile(new URL('../src/app.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /%sveltekit\.nonce%/, 'nonce placeholders break adapter-static fallbacks');
});
