// Docs manifest shared by the dev middleware, the build plugin and postbuild.
// The Vite plugin's closeBundle can run before adapter-cloudflare finishes
// writing .svelte-kit/cloudflare, so `scripts/postbuild.mjs` writes the same
// file again afterwards.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function scanMarkdownFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractTitle(file) {
  const content = readFileSync(file, 'utf-8');
  const match = content.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim() : basename(file, '.md');
}

export function buildDocsManifest(docsDir = join(process.cwd(), 'public/docs')) {
  const files = scanMarkdownFiles(docsDir);
  const bySlug = new Map();

  for (const file of files) {
    const name = basename(file, '.md');
    const localeMatch = name.match(/_(ja|en)$/);
    const locale = localeMatch ? localeMatch[1] : '';
    const slug = localeMatch ? name.slice(0, -locale.length - 1) : name;
    const title = extractTitle(file);

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = { title: {}, files: {} };
      bySlug.set(slug, entry);
    }
    entry.title[locale] = title;
    entry.files[locale] = basename(file);
  }

  return {
    docs: [...bySlug.entries()].map(([slug, entry]) => ({ slug, title: entry.title, files: entry.files })),
  };
}

export function writeDocsManifest(outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(buildDocsManifest()));
}

// Generate before `vite build` so SvelteKit's manifest.assets includes the file;
// SSR's event.fetch() only serves assets known at build time.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeDocsManifest(join(process.cwd(), 'public/docs'));
}
