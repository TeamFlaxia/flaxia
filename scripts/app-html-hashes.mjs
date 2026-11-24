// Inline scripts authored in `src/app.html` run before the app boots (theme
// selection). SvelteKit's hash-mode CSP only hashes the scripts it injects, so
// the build computes these hashes and appends them to `script-src`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function inlineScriptHash(body) {
  return `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
}

export function appHtmlInlineScriptHashes(file = 'src/app.html') {
  const html = readFileSync(file, 'utf8');
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match;
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/application\/ld\+json/i.test(attrs)) continue;
    hashes.push(inlineScriptHash(body));
  }
  return hashes;
}
