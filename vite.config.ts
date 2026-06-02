import { defineConfig } from 'vite'
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: ['/api/crowd/index.js'],
      input: {
        main: 'index.html'
      },
      output: {
        manualChunks: {
          // 大型ライブラリを個別チャンクに分割
          katex: ['katex'],
          jszip: ['jszip'],
          markdown: ['markdown-it'],
          // その他のvendorライブラリ
          vendor: ['dompurify', 'fflate', 'lucide', 'nanoid']
        }
      }
    },
    emptyOutDir: true
  },
  server: {
    port: 3000,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    proxy: {
      '/api/crowd': {
        target: 'https://unpkg.com/@flaxia/node@0.1.2/dist',
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
    'import.meta.env.VITE_SANDBOX_ORIGIN': JSON.stringify(process.env.SANDBOX_ORIGIN || 'https://flaxia.app'),
    'import.meta.env.VITE_CONTENT_ORIGIN': JSON.stringify(process.env.CONTENT_ORIGIN || ''),
    'import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID': JSON.stringify(process.env.CLOUDFLARE_ACCOUNT_ID || ''),
    'import.meta.env.VITE_CF_TEAM_DOMAIN': JSON.stringify(process.env.CF_TEAM_DOMAIN || 'yourteam.cloudflareaccess.com'),
    'import.meta.env.VITE_CF_ACCESS_AUD': JSON.stringify(process.env.CF_ACCESS_AUD || 'your-aud-tag-here'),
    'import.meta.env.VITE_CF_ACCESS_LOGIN_URL': JSON.stringify(
      `https://${process.env.CF_TEAM_DOMAIN || 'yourteam.cloudflareaccess.com'}/cdn-cgi/access/login/${process.env.CF_ACCESS_AUD || 'your-aud-tag-here'}`
    )
  },
  ssr: {
    noExternal: ['hono']
  },
  plugins: [
    {
      name: 'copy-jsdos',
      writeBundle() {
        function copyDirectory(src: string, dest: string) {
          if (!existsSync(dest)) {
            mkdirSync(dest, { recursive: true })
          }
          const entries = readdirSync(src, { withFileTypes: true })
          for (const entry of entries) {
            const srcPath = join(src, entry.name)
            const destPath = join(dest, entry.name)
            if (entry.isDirectory()) {
              copyDirectory(srcPath, destPath)
            } else {
              copyFileSync(srcPath, destPath)
            }
          }
        }

        const jsdosSrc = 'node_modules/js-dos/dist'
        const jsdosDest = 'dist/js-dos'
        if (existsSync(jsdosSrc)) {
          console.log('Copying js-dos files to dist...')
          copyDirectory(jsdosSrc, jsdosDest)
          console.log('js-dos files copied successfully!')
        }

        const crowdSrc = 'node_modules/@flaxia/node/dist/assets'
        const crowdDest = 'dist/assets'
        if (existsSync(crowdSrc)) {
          const entries = readdirSync(crowdSrc, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name.startsWith('transformers.web')) continue
            copyFileSync(join(crowdSrc, entry.name), join(crowdDest, entry.name))
          }
          console.log('Copied @flaxia/node assets (excluding transformers.web)')

          const aiFile = entries.find(e => e.name.startsWith('ai-inference'))
          if (aiFile) {
            const aiPath = join(crowdDest, aiFile.name)
            const src = readFileSync(aiPath, 'utf-8')
            const patched = src.replace(
              /"\.\/transformers\.web-[^"]+\.js"/,
              '"https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js"'
            )
            writeFileSync(aiPath, patched)
            console.log('Patched ai-inference import to use CDN')
          }
        }
      }
    }
  ]
})
