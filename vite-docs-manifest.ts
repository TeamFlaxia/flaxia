import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { buildDocsManifest, writeDocsManifest } from './scripts/docs-manifest.mjs';

export { buildDocsManifest };

export function docsManifestPlugin(): Plugin {
  const serveJson = (_req: Connect.IncomingMessage, res: ServerResponse) => {
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
      writeDocsManifest(join(process.cwd(), 'dist/docs'));
    },
  };
}
