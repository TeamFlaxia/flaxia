// SEO-origin and single-build guardrails for the SSR metadata components.
//
// `SEO_ORIGIN` (src/lib/seo-jsonld.ts) is the single production origin for
// canonical links, og:url and JSON-LD URLs. Hardcoding `https://flaxia.app`
// again in a component silently forks that configuration, so every owned
// metadata component must import the constant. The browser SSR suite must also
// reuse the build CI already produced instead of rebuilding it a second time.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const OWNED_METADATA_FILES = [
  'src/routes/+layout.svelte',
  'src/routes/+error.svelte',
  'src/lib/svelte/DownloadPage.svelte',
];

test('owned SSR metadata components import SEO_ORIGIN instead of hardcoding it', async () => {
  for (const path of OWNED_METADATA_FILES) {
    const source = await read(path);
    assert.match(
      source,
      /import\s*\{[^}]*\bSEO_ORIGIN\b[^}]*\}\s*from\s*['"][^'"]*seo-jsonld\.ts['"]/,
      `${path} must import SEO_ORIGIN from seo-jsonld.ts`,
    );
    assert.doesNotMatch(
      source,
      /https:\/\/flaxia\.app/,
      `${path} must not repeat the production origin literal — use SEO_ORIGIN`,
    );
  }
});

test('canonical links and og:url stay path-only/absolute on the shared origin', async () => {
  const layout = await read('src/routes/+layout.svelte');
  assert.match(
    layout,
    /const canonicalUrl\s*=\s*\$derived\(`\$\{SEO_ORIGIN\}\$\{page\.url\.pathname\}`\)/,
    'the layout canonical must be the shared origin plus a path only',
  );
  assert.match(layout, /<link rel="canonical" href=\{canonicalUrl\}\s*\/>/);
  assert.match(layout, /property="og:url" content=\{canonicalUrl\}/);
  assert.doesNotMatch(layout, /page\.url\.href/, 'query strings and the dev origin must not reach canonical/og:url');
  assert.match(layout, /const DEFAULT_OG_IMAGE\s*=\s*`\$\{SEO_ORIGIN\}\/og-default-v2\.png`/);

  const error = await read('src/routes/+error.svelte');
  assert.match(
    error,
    /const canonicalUrl\s*=\s*`\$\{SEO_ORIGIN\}\/home`/,
    'the error canonical must point at /home on the shared origin',
  );
  assert.match(error, /<link rel="canonical" href=\{canonicalUrl\}\s*\/>/);

  const download = await read('src/lib/svelte/DownloadPage.svelte');
  assert.match(download, /const canonicalUrl\s*=\s*`\$\{SEO_ORIGIN\}\/download`/);
  assert.match(download, /property="og:url" content=\{canonicalUrl\}/);
  assert.doesNotMatch(download, /window\.location\.origin/, 'og:url must stay absolute, not follow the request host');
});

test('test:ssr:browser reuses the CI build instead of rebuilding', async () => {
  const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
  const script = pkg.scripts['test:ssr:browser'];
  assert.ok(script, 'package.json must define test:ssr:browser');
  assert.doesNotMatch(script, /npm run build/, 'CI already builds once before invoking the browser suite');
  assert.match(script, /node --test tests\/ssr-hydration\.browser\.mjs/);

  const ci = await read('.github/workflows/ci.yml');
  const start = ci.indexOf('  ssr-browser:\n');
  const end = ci.indexOf('\n  lint:\n', start);
  assert.ok(start >= 0 && end > start, 'the ssr-browser job must exist');
  const job = ci.slice(start, end);
  const builds = [...job.matchAll(/^\s*- run: npm run build\s*$/gm)];
  assert.equal(builds.length, 1, 'the ssr-browser job must build exactly once');
  assert.ok(
    job.indexOf('npm run build') < job.indexOf('npm run test:ssr:browser'),
    'the build step must precede the browser suite',
  );
});

test('SSR plan documents the single-build contract and the /legal dev caveat', async () => {
  const doc = await read('docs/ssr-seo-plan.md');
  assert.match(doc, /npm run test:ssr:browser` does not build/, 'document that the browser suite needs a prior build');
  assert.match(doc, /SEO_ORIGIN/, 'document the single production origin');
  assert.match(doc, /\/legal/, 'document the /legal caveat');
  assert.match(doc, /_redirects/, 'the caveat must explain why /legal works in production');
  assert.match(doc, /vite dev/, 'the caveat must name the dev command where /legal 404s');
});
