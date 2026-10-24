import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CROWD_NODE_VERSION } from '../src/lib/crowd-node.ts';

// Desktop-only: preserve relative module/worker URLs without adding the large
// inference runtime to the Pages deployment or Capacitor bundles.
const source = resolve('node_modules/@flaxia/node');
const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (version !== CROWD_NODE_VERSION) throw new Error('Native Crowd package must match CROWD_NODE_VERSION');
const destination = resolve(`dist/native-crowd/v${version}-0`);
mkdirSync(destination, { recursive: true });
cpSync(join(source, 'dist'), destination, {
  recursive: true,
  filter: (path) => !path.endsWith('.d.ts') && !path.endsWith('.d.ts.map'),
});
