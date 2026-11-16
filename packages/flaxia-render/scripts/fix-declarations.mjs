/**
 * Rewrite declaration import specifiers from `.ts` to `.js`.
 *
 * The source imports carry `.ts` so Node's strip-types test runner can resolve
 * them without a loader. Published declarations must use `.js` so consumers on
 * `node16`/`nodenext` resolution can find the sibling `.d.ts` files.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const files = await readdir(dist);

await Promise.all(
  files
    .filter((file) => file.endsWith('.d.ts'))
    .map(async (file) => {
      const path = join(dist, file);
      const source = await readFile(path, 'utf8');
      const rewritten = source
        .replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
        .replace(/(import\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');

      if (rewritten !== source) await writeFile(path, rewritten);
    }),
);
