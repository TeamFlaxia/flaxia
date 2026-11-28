import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterStatic from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { appHtmlInlineScriptHashes } from './scripts/app-html-hashes.mjs';
import { CROWD_NODE_VERSION } from './shared/crowd-node.ts';
import { ADSENSE_INLINE_BOOTSTRAP } from './src/lib/adsense-bootstrap.ts';
import { FLASH_PLAYER_BOOTSTRAP } from './src/lib/flash-player-document.ts';
import { pdfViewerAssetBody, pdfViewerAssetHeaders } from './src/lib/pdf-viewer-page';
import { docsManifestPlugin } from './vite-docs-manifest';

// Inline scripts that run inside sandboxed/blob iframes inherit this page's
// CSP, so their stable bodies must stay in the allowlist.
const inlineScriptHash = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const gitCommit = (process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || 'unknown').slice(0, 40);
// Native shells (Tauri/Capacitor) cannot run a Worker, so they get the static
// SPA build. The web deploy always uses adapter-cloudflare.
const nativeBuild = process.env.BUILD_TARGET === 'native';

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
    'import.meta.env.BUILD_TARGET': JSON.stringify(process.env.BUILD_TARGET ?? 'web'),
  },
  ssr: {
    noExternal: ['hono'],
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      // Every mutation is a /api/* request guarded by the Hono `csrfProtection`
      // middleware (and per-endpoint origin checks). SvelteKit's built-in check
      // rejects non-browser clients that omit Origin (mobile app, ActivityPub
      // peers), so trust every origin and keep the API as the single gate.
      csrf: { trustedOrigins: ['*'] },
      adapter: nativeBuild
        ? adapterStatic({ pages: 'dist', assets: 'dist', fallback: 'index.html' })
        : adapterCloudflare(),
      files: { assets: 'public' },
      version: { name: 'f1-ssr' },
      // Hash mode works for SSR and the prerendered native fallback. SvelteKit
      // hashes its own scripts; app.html scripts are hashed by the build helper.
      csp: {
        mode: 'hash',
        directives: {
          'default-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'worker-src': ['self', 'blob:', 'https://flaxia.app'],
          'connect-src': ['self', 'https:', 'wss:', 'blob:', 'data:'],
          'img-src': ['*', 'blob:', 'data:'],
          'style-src': ['self', "'unsafe-inline'", 'https://fonts.googleapis.com', 'blob:'],
          'font-src': ['self', 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com', 'blob:'],
          'script-src': [
            'self',
            "'wasm-unsafe-eval'",
            'blob:',
            inlineScriptHash(ADSENSE_INLINE_BOOTSTRAP),
            inlineScriptHash(FLASH_PLAYER_BOOTSTRAP),
            ...appHtmlInlineScriptHashes(),
            'https://cdn.jsdelivr.net',
            'https://unpkg.com',
            'https://static.cloudflareinsights.com',
            'https://pagead2.googlesyndication.com',
            'https://googleads.g.doubleclick.net',
            'https://www.google.com',
          ],
          'script-src-attr': ['none'],
          // Remote ActivityPub media can be served over http as well as https.
          'media-src': ['self', 'http:', 'https:', 'blob:'],
          'frame-src': [
            'self',
            'blob:',
            'https://*.flaxia.app',
            'https://googleads.g.doubleclick.net',
            'https://www.youtube.com',
            'https://ep2.adtrafficquality.google',
            'https://www.google.com',
          ],
          'frame-ancestors': ['self'],
        },
      },
    }),
    docsManifestPlugin(),
    {
      // vite dev has no _headers — apply the isolation headers the export
      // popup needs (SharedArrayBuffer / core-mt) to both the clean URL and
      // the .html document Pages redirects away from.
      name: 'export-popup-dev-headers',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? '').split('?')[0];
          if (path === '/export-popup' || path.startsWith('/export-popup.html')) {
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
  ],
});
