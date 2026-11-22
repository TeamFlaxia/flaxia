// F8 guard: heavy UI libraries must stay out of the initial bundle. They are
// loaded only when the owning route/component is actually used.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../src/', import.meta.url).pathname;
const HEAVY = ['katex', 'maplibre-gl', '@ffmpeg/ffmpeg', 'pdfjs-dist'];

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (
      /\.(ts|svelte)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.generated.')
    ) {
      out.push(path);
    }
  }
  return out;
}

test('heavy libraries are never statically imported', async () => {
  const offenders: string[] = [];
  for (const file of await sources(ROOT)) {
    const source = await readFile(file, 'utf8');
    for (const line of source.split('\n')) {
      if (!/^import\b/.test(line.trim())) continue;
      const match = HEAVY.find((pkg) => line.includes(`'${pkg}'`) || line.includes(`"${pkg}"`));
      if (match && !line.includes('import type')) offenders.push(`${file.replace(ROOT, 'src/')}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'Use await import() inside the owning component instead');
});

test('heavy libraries are dynamically imported from their owning modules', async () => {
  const expectations = [
    ['src/components/PostText.ts', "import('katex')"],
    ['src/lib/svelte/MapsPage.svelte', "import('maplibre-gl')"],
    ['src/lib/editor/ffmpeg-client.ts', "import('@ffmpeg/ffmpeg')"],
  ] as const;
  for (const [file, snippet] of expectations) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(snippet), `${file} must lazily load ${snippet}`);
  }
});
