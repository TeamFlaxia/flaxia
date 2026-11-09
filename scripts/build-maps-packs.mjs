#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const DEFAULT_CITIES = [
  { id: 'tokyo', bbox: '139.25,35.45,140.05,35.85', maxZoom: 15 },
  { id: 'osaka', bbox: '135.15,34.45,135.85,34.85', maxZoom: 15 },
  { id: 'nagoya', bbox: '136.55,35.0,137.25,35.35', maxZoom: 15 },
  { id: 'world', bbox: '-180,-90,180,90', maxZoom: 10 },
];

function parseArgs(argv) {
  let outDir = join(root, 'maps-packs');
  let cities = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      outDir = argv[++i] || outDir;
    } else if (arg === '--city') {
      const id = String(argv[++i] || '').trim();
      const bbox = String(argv[++i] || '').trim();
      const maxZoom = Number(argv[++i] || 15);
      if (!id || !bbox) {
        console.error(
          'usage: node scripts/build-maps-packs.mjs [--out <dir>] [--city <slug> "<lonMin,latMin,lonMax,latMax>" <maxZoom>]',
        );
        process.exit(1);
      }
      cities = [{ id, bbox, maxZoom: Number.isFinite(maxZoom) ? maxZoom : 15 }];
      break;
    } else if (!arg.startsWith('--')) {
      outDir = arg;
    }
  }
  return { outDir, cities: cities ?? DEFAULT_CITIES };
}

const { outDir, cities } = parseArgs(process.argv);

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const city of cities) {
    const cityDir = join(outDir, city.id);
    await mkdir(cityDir, { recursive: true });
    const buildSh = join(cityDir, 'build.sh');
    const script = `#!/bin/bash
set -euo pipefail
CITY=${city.id}
BBOX=${city.bbox}
MAXZOOM=${city.maxZoom}
planetiler --bbox=$BBOX --maxzoom=$MAXZOOM --output=map.pmtiles
valhalla_build_config --inline-config '{"type":"json","layers":[{"id":"auto","name":"auto"}]}' > valhalla.json
valhalla_build_tiles --inline-config valhalla.json -c tile_extract.txt
valhalla_build_extract --inline-config valhalla.json --input valhalla_tiles --output valhalla.tar
`;
    await writeFile(buildSh, script, 'utf8');
    const manifest = join(cityDir, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({ city: city.id, bbox: city.bbox, maxzoom: city.maxZoom }, null, 2),
      'utf8',
    );
    console.log(`wrote ${buildSh}`);
  }
  console.log(`done: ${cities.map((c) => c.id).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
