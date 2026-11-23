import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { CROWD_NODE_VERSION } from './shared/crowd-node.ts';
import { pdfViewerAssetBody, pdfViewerAssetHeaders } from './src/lib/pdf-viewer-page';
import { docsManifestPlugin } from './vite-docs-manifest';

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const gitCommit = (process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || 'unknown').slice(0, 40);

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: (id) => id.startsWith('/crowd/'),
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/katex/')) return 'katex';
          if (id.includes('/jszip/')) return 'jszip';
          if (id.includes('/markdown-it/')) return 'markdown';
          if (['dompurify', 'fflate', 'lucide', 'nanoid'].some((pkg) => id.includes(`/node_modules/${pkg}/`))) {
            return 'vendor';
          }
        },
      },
    },
  },
  optimizeDeps: {
    // Pre-bundling @ffmpeg/ffmpeg breaks its module worker in dev (worker.js
    // 504 → load() hangs forever; 0.12.15 has no worker.onerror).
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    port: 3000,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
      '/sw.js': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  define: {
    'import.meta.env.VITE_SANDBOX_ORIGIN': JSON.stringify(process.env.SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'),
    'import.meta.env.VITE_CONTENT_ORIGIN': JSON.stringify(process.env.CONTENT_ORIGIN || ''),
    'import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID': JSON.stringify(process.env.CLOUDFLARE_ACCOUNT_ID || ''),
    'import.meta.env.VITE_CF_TEAM_DOMAIN': JSON.stringify(
      process.env.CF_TEAM_DOMAIN || 'yourteam.cloudflareaccess.com',
    ),
    'import.meta.env.VITE_CF_ACCESS_AUD': JSON.stringify(process.env.CF_ACCESS_AUD || 'your-aud-tag-here'),
    'import.meta.env.VITE_CF_ACCESS_LOGIN_URL': JSON.stringify(
      `https://${process.env.CF_TEAM_DOMAIN || 'yourteam.cloudflareaccess.com'}/cdn-cgi/access/login/${process.env.CF_ACCESS_AUD || 'your-aud-tag-here'}`,
    ),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageVersion),
    'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
  },
  ssr: {
    noExternal: ['hono'],
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter({ pages: 'dist', assets: 'dist', fallback: 'index.html' }),
      files: { assets: 'public' },
      version: { name: 'f1-static-shell' },
    }),
    docsManifestPlugin(),
    {
      // vite dev has no _headers — apply the isolation headers the export
      // popup needs (SharedArrayBuffer / core-mt) only on that path.
      name: 'export-popup-dev-headers',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/export-popup.html')) {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          }
          next();
        });
      },
    },
    {
      // The PDF viewer normally lives on the sandbox origin (Worker route in
      // src/sandbox-worker.ts). In dev, SANDBOX_ORIGIN=http://localhost:3000
      // points at this server, so mirror the Worker's /pdf/* routes here.
      name: 'pdf-viewer-dev',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? '').split('?')[0];
          if (!path.startsWith('/pdf/')) return next();
          const body = pdfViewerAssetBody(path.slice('/pdf/'.length));
          const headers = pdfViewerAssetHeaders(path.slice('/pdf/'.length));
          if (body === null || headers === null) return next();
          for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
          res.end(body);
        });
      },
    },
    {
      // Dev has no static copy step: serve the same versioned path directly
      // from node_modules so the runtime import resolves in `npm run dev`.
      name: 'crowd-node-dev',
      apply: 'serve',
      configureServer(server) {
        const crowdRoot = 'node_modules/@flaxia/node/dist';
        const prefix = `/crowd/v${CROWD_NODE_VERSION}-0/`;
        const types: Record<string, string> = {
          js: 'application/javascript',
          mjs: 'application/javascript',
          wasm: 'application/wasm',
          json: 'application/json',
          map: 'application/json',
          css: 'text/css',
          html: 'text/html',
          png: 'image/png',
          svg: 'image/svg+xml',
        };
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? '').split('?')[0];
          if (!pathname.startsWith(prefix)) return next();
          const relative = pathname.slice(prefix.length);
          if (!relative || relative.includes('..')) return next();
          const file = join(crowdRoot, relative);
          if (!existsSync(file) || !statSync(file).isFile()) return next();
          res.setHeader('Content-Type', types[relative.split('.').pop() ?? ''] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(file));
        });
      },
    },
    {
      // The export popup is a legacy standalone HTML entry kept outside the
      // SvelteKit router; copy it into the static output unchanged.
      name: 'copy-export-popup',
      apply: 'build',
      enforce: 'post',
      writeBundle() {
        if (existsSync('export-popup.html')) {
          mkdirSync('dist', { recursive: true });
          copyFileSync('export-popup.html', 'dist/export-popup.html');
        }
      },
    },
  ],
});
