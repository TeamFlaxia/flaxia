import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { CROWD_NODE_VERSION } from './src/lib/crowd-node';
import { pdfViewerAssetBody, pdfViewerAssetHeaders } from './src/lib/pdf-viewer-page';
import { docsManifestPlugin } from './vite-docs-manifest';

/** html file → entry chunk name (shared by rollup input and the preload plugin). */
const ENTRY_INPUTS: Record<string, string> = {
  main: 'index.html',
  exportPopup: 'export-popup.html',
};
const HTML_ENTRY: Record<string, string> = Object.fromEntries(
  Object.entries(ENTRY_INPUTS).map(([entry, html]) => [html, entry]),
);

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: (id) => id.startsWith('/api/crowd/'),
      input: ENTRY_INPUTS,
      output: {
        manualChunks: {
          // 大型ライブラリを個別チャンクに分割
          katex: ['katex'],
          jszip: ['jszip'],
          markdown: ['markdown-it'],
          // その他のvendorライブラリ
          vendor: ['dompurify', 'fflate', 'lucide', 'nanoid'],
        },
      },
    },
    emptyOutDir: true,
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
      '/api/crowd': {
        target: `https://unpkg.com/@flaxia/node@${CROWD_NODE_VERSION}/dist`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/crowd/, ''),
      },
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
  },
  ssr: {
    noExternal: ['hono'],
  },
  plugins: [
    docsManifestPlugin(),
    {
      name: 'modulepreload',
      enforce: 'post',
      apply: 'build',
      generateBundle(_opts, bundle) {
        const chunksByName = new Map(
          Object.entries(bundle)
            .filter(([, info]) => info.type === 'chunk' && info.isEntry)
            .map(([file, info]) => [info.name, file]),
        );
        for (const [file, info] of Object.entries(bundle)) {
          if (info.type !== 'asset' || !file.endsWith('.html') || !('source' in info)) continue;
          const entryName = HTML_ENTRY[file];
          if (!entryName) continue;
          const entryFile = chunksByName.get(entryName);
          if (!entryFile) continue;
          const link = `<link rel="modulepreload" crossorigin href="/${entryFile}">`;
          info.source = (info.source as string).replace('</head>', `  ${link}\n</head>`);
        }
      },
    },
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
      name: 'copy-crowd-assets',
      writeBundle() {
        const crowdSrc = 'node_modules/@flaxia/node/dist/assets';
        const crowdDest = 'dist/assets';
        if (existsSync(crowdSrc)) {
          const entries = readdirSync(crowdSrc, { withFileTypes: true });
          for (const entry of entries) {
            const excluded = entry.name.startsWith('transformers.web') || entry.name === 'nudenet.js';
            if (excluded) continue;
            copyFileSync(join(crowdSrc, entry.name), join(crowdDest, entry.name));
          }
          console.log('Copied @flaxia/node assets (excluding transformers.web and nudenet.js)');

          const aiFile = entries.find((e) => e.name.startsWith('ai-inference'));
          if (aiFile) {
            const aiPath = join(crowdDest, aiFile.name);
            const src = readFileSync(aiPath, 'utf-8');
            const patched = src.replace(
              /"\.\/transformers\.web-[^"]+\.js"/,
              '"https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js"',
            );
            writeFileSync(aiPath, patched);
            console.log('Patched ai-inference import to use CDN');
          }
        }
      },
    },
    {
      name: 'ssr-assets',
      closeBundle() {
        const distIndex = join(process.cwd(), 'dist/index.html');
        if (!existsSync(distIndex)) return;
        const html = readFileSync(distIndex, 'utf-8');
        const headEnd = html.indexOf('</head>');
        if (headEnd === -1) return;
        const headContent = html.slice(0, headEnd);
        const scripts = headContent.match(/<script[\s\S]*?<\/script>/g) || [];
        const links = headContent.match(/<link[\s\S]*?>/g) || [];
        const spaAssets = [...links, ...scripts].filter((tag) => tag.includes('/assets/')).join('\n  ');
        const outPath = join(process.cwd(), 'functions/lib/ssr-head.generated.ts');
        writeFileSync(
          outPath,
          `// Auto-generated by Vite build — do not edit manually
export const SPA_HEAD_TAGS: string = ${JSON.stringify(spaAssets)};
`,
        );
        console.log('Generated functions/lib/ssr-head.generated.ts');
      },
    },
  ],
});
