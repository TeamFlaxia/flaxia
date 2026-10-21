import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { Connect, Plugin } from 'vite';

interface DocEntry {
  slug: string;
  title: Record<string, string>;
  files: Record<string, string>;
}

interface DocsManifest {
  docs: DocEntry[];
}

function scanMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
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

function extractTitle(file: string): string {
  const content = readFileSync(file, 'utf-8');
  const match = content.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim() : basename(file, '.md');
}

export function buildDocsManifest(): DocsManifest {
  const docsDir = join(process.cwd(), 'public/docs');
  const files = scanMarkdownFiles(docsDir);
  const bySlug = new Map<string, { title: Record<string, string>; files: Record<string, string> }>();

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

export function docsManifestPlugin(): Plugin {
  const serveJson = (req: Connect.IncomingMessage, res: ServerResponse) => {
    const manifest = buildDocsManifest();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(manifest));
  };

  return {
    name: 'flaxia-docs-manifest',
    configureServer(server) {
      server.middlewares.use('/docs/index.json', serveJson);
    },
    closeBundle() {
      const manifest = buildDocsManifest();
      const outDir = join(process.cwd(), 'dist/docs');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.json'), JSON.stringify(manifest));
    },
  };
}
