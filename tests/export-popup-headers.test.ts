// Cloudflare Pages redirects /export-popup.html (308) to the clean URL
// /export-popup, so cross-origin isolation must be granted to both paths.
// Without COOP/COEP on the served document, SharedArrayBuffer is unavailable
// and the multithreaded ffmpeg core cannot start.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Parse the indented header lines under each top-level path in Cloudflare `_headers`. */
function parseHeaderBlocks(source: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^\/\S*$/.test(line)) {
      path = line.trim();
      blocks.set(path, []);
    } else if (path && /^[ \t]+\S/.test(line)) {
      blocks.get(path)?.push(line.trim());
    }
  }
  return blocks;
}

test('both export popup paths get COOP and COEP in _headers', async () => {
  const blocks = parseHeaderBlocks(await read('_headers'));
  for (const path of ['/export-popup.html', '/export-popup']) {
    const headers = blocks.get(path);
    assert.ok(headers, `${path} needs its own _headers block`);
    assert.ok(
      headers?.some((line) => /^Cross-Origin-Opener-Policy:\s*same-origin\s*$/.test(line)),
      `${path} must send Cross-Origin-Opener-Policy: same-origin`,
    );
    assert.ok(
      headers?.some((line) => /^Cross-Origin-Embedder-Policy:\s*require-corp\s*$/.test(line)),
      `${path} must send Cross-Origin-Embedder-Policy: require-corp`,
    );
  }
});

test('nosniff is declared once site-wide, not repeated in per-path blocks', async () => {
  const headers = await read('_headers');
  const count = headers.match(/X-Content-Type-Options:\s*nosniff/gi)?.length ?? 0;
  assert.equal(count, 1, 'keep only the site-wide /* nosniff header');
  const blocks = parseHeaderBlocks(headers);
  assert.ok(
    blocks.get('/*')?.some((line) => /^X-Content-Type-Options: nosniff$/.test(line)),
    'the remaining nosniff must be in the site-wide /* block',
  );
});

test('the vite dev middleware applies isolation headers to both export popup paths', async () => {
  const config = await read('vite.config.ts');
  const start = config.indexOf("name: 'export-popup-dev-headers'");
  assert.notEqual(start, -1, 'the export popup dev plugin must exist');
  const plugin = config.slice(start, config.indexOf("name: 'pdf-viewer-dev'", start));
  assert.match(plugin, /Cross-Origin-Opener-Policy', 'same-origin'/);
  assert.match(plugin, /Cross-Origin-Embedder-Policy', 'require-corp'/);

  const condition = plugin.match(/if \(([\s\S]*?)\)\s*\{/)?.[1] ?? '';
  assert.match(condition, /['"]\/export-popup\.html['"]/, 'the dev matcher must include /export-popup.html');
  assert.match(condition, /['"]\/export-popup['"]/, 'the dev matcher must include /export-popup');
});
