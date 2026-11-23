// F2 guard: CSP hashes are derived from the inline scripts, not hand-maintained.
// This recomputes the known sources and checks both CSP copies still allow them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SECURITY_HEADERS } from '../functions/lib/ssr-security-headers.ts';
import { ADSENSE_INLINE_BOOTSTRAP } from '../src/lib/adsense-bootstrap.ts';
import { FLASH_PLAYER_BOOTSTRAP } from '../src/lib/flash-player-document.ts';

const hashOf = (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;

const inlineBodies = (html) =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs) && !/application\/ld\+json/i.test(attrs))
    .map(([, , body]) => body);

test('generated CSP hashes cover every known inline script', async () => {
  const expected = new Set([hashOf(ADSENSE_INLINE_BOOTSTRAP), hashOf(FLASH_PLAYER_BOOTSTRAP)]);
  for (const file of ['index.html', 'export-popup.html']) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const body of inlineBodies(html)) expected.add(hashOf(body));
  }

  const csp = SECURITY_HEADERS.find(([name]) => name === 'Content-Security-Policy')?.[1];
  assert.ok(csp, 'Content-Security-Policy header missing');
  for (const hash of expected) {
    assert.ok(csp.includes(hash), `CSP is missing ${hash} — run npm run build to regenerate it`);
  }

  const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const staticCsp = headers.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
  assert.equal(staticCsp, csp, 'public/_headers and ssr-security-headers.ts must stay in sync');

  // The allowlist must be exactly the generated set plus the SvelteKit
  // bootstrap hash, which only exists in the built output. A stale hash left
  // behind by an earlier build must fail this check.
  const listed = [...csp.matchAll(/'sha256-[^']+'/g)].map((m) => m[0]);
  assert.ok(listed.length <= expected.size + 1, 'CSP hash allowlist must not accumulate stale entries');
});
