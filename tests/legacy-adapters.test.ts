// Ratchet for the legacy DOM removal program: see LEGACY_ADAPTERS.md.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname;
// Ignore DOM methods such as document.createElement(); this ratchet is about
// bare legacy factory calls, which are never preceded by a dot.
const FACTORY = /(?<!\.)\b(create[A-Z][A-Za-z0-9]*)\s*\(/g;

async function svelteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await svelteFiles(path)));
    else if (entry.name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

const registry = await readFile(join(ROOT, 'LEGACY_ADAPTERS.md'), 'utf8');
const listed = [...registry.matchAll(/^- `([^`]+)`: `([^`]+)`$/gm)].map((m) => `${m[1]} ${m[2]}`);

test('legacy adapter registry has no duplicate entries', () => {
  assert.equal(new Set(listed).size, listed.length, 'LEGACY_ADAPTERS.md contains duplicates');
});

test('every registered adapter still exists', async () => {
  const stale: string[] = [];
  for (const line of listed) {
    const [file, symbol] = line.split(' ');
    const source = await readFile(join(ROOT, file), 'utf8');
    if (!source.includes(symbol)) stale.push(line);
  }
  assert.deepEqual(stale, [], 'Remove these lines from LEGACY_ADAPTERS.md after the DOM is rewritten');
});

test('no new legacy DOM factory is mounted from Svelte', async () => {
  const unregistered: string[] = [];
  for (const dir of ['src/routes', 'src/lib/svelte']) {
    for (const file of await svelteFiles(join(ROOT, dir))) {
      const source = await readFile(file, 'utf8');
      const relative = file.replace(ROOT, '');
      for (const match of source.matchAll(FACTORY)) {
        const entry = `${relative} ${match[1]}`;
        if (!listed.includes(entry)) unregistered.push(entry);
      }
    }
  }
  assert.deepEqual(unregistered, [], 'Rewrite in Svelte or add a reviewed removal plan to LEGACY_ADAPTERS.md');
});
