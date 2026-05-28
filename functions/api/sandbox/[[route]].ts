import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ALLOWED_EXTENSIONS } from '../../../src/lib/file-extensions'

interface Env {
  BUCKET: R2Bucket
}

type Bindings = Env

const app = new Hono<{ Bindings: Bindings }>()

// CORS for sandbox
app.use('/*', cors({
  origin: ['https://flaxia.app', 'https://*.pages.dev', 'https://sandbox.flaxia.app'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}))

// Service Worker script
app.get('/sw.js', async (c) => {
  const extConfigJson = JSON.stringify(ALLOWED_EXTENSIONS)
  const swContent = `console.log('Service Worker script loading...')

importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js')

console.log('fflate loaded:', typeof fflate !== 'undefined')

// --- セキュリティ設定 & リソース制限 ---
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_FILE_COUNT = 1000;
// Extension config from shared file-extensions.ts
const EXT_CONFIG = ${extConfigJson};
const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_CONFIG).map(k => k.replace('.', '')));

// 仮想ファイルシステム: path → Uint8Array
const virtualFS = new Map()
let fsReady = false

// --- セキュリティヘルパー関数 ---

// パス検証: ディレクトリトラバーサルを防止
function validatePath(path) {
  // null/undefined チェック
  if (!path || typeof path !== 'string') return false;
  
  // パス長の検証
  if (path.length > 255) {
    console.warn('Blocked path too long:', path);
    return false;
  }
  
  // ディレクトリトラバーサル攻撃の防止
  if (path.includes('..') || path.includes('//') || path.includes('\\\\')) {
    console.warn('Blocked path traversal attempt:', path);
    return false;
  }
  
  // 無効文字のチェック
  if (path.includes('\0') || /[<>:"|?*]/.test(path)) {
    console.warn('Blocked invalid characters in path:', path);
    return false;
  }
  
  // 先頭のスラッシュを正規化
  const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
  
  // パス深度のチェック
  const depth = (normalizedPath.match(/\//g) || []).length;
  if (depth > 10) {
    console.warn('Blocked path too deep:', path);
    return false;
  }
  
  // 拡張子の検証
  const ext = normalizedPath.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    console.warn('Blocked disallowed extension:', path);
    return false;
  }
  
  return true;
}

// ファイルサイズと数の検証
function validateZipContent(files) {
  let totalSize = 0;
  let fileCount = 0;
  
  for (const [path, data] of Object.entries(files)) {
    // ディレクトリエントリはスキップ
    if (path.endsWith('/')) continue;
    
    fileCount++;
    if (fileCount > MAX_FILE_COUNT) {
      throw new Error(\`Too many files: \${fileCount} (max: \${MAX_FILE_COUNT})\`);
    }
    
    totalSize += data.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error(\`Total size exceeds \${MAX_TOTAL_SIZE / 1024 / 1024}MB limit\`);
    }
  }
  
  return { totalSize, fileCount };
}

self.addEventListener('install', () => {
  console.log('Service Worker installing')
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  console.log('Service Worker activating')
  e.waitUntil(self.clients.claim())
})

// --- ZIP 受信 & 展開 ---
self.addEventListener('message', (event) => {
  console.log('Message received:', event.data?.type)
  
  if (event.data?.type !== 'SETUP_ZIP') return

  console.log('Processing ZIP data...')
  const zipData = new Uint8Array(event.data.zipData)
  console.log('ZIP data size:', zipData.byteLength)

  try {
    // ZIP Bomb 検出: 展開前にサイズチェック
    if (zipData.byteLength > MAX_TOTAL_SIZE) {
      throw new Error('ZIP file exceeds size limit');
    }

    // fflate で同期展開
    console.log('Starting ZIP extraction...')
    const files = fflate.unzipSync(zipData)
    console.log('ZIP extracted, files:', Object.keys(files).length)

    // リソース制限の検証
    const { totalSize, fileCount } = validateZipContent(files);
    console.log(\`Resource check: \${fileCount} files, \${(totalSize / 1024 / 1024).toFixed(2)}MB total\`);

    // 仮想ファイルシステムのクリアと再構築
    virtualFS.clear();
    for (const [path, data] of Object.entries(files)) {
      // ディレクトリエントリはスキップ
      if (!path.endsWith('/')) {
        const normalizedPath = '/' + path;
        if (validatePath(normalizedPath)) {
          virtualFS.set(normalizedPath, data);
        } else {
          console.warn('Skipping unsafe file:', path);
        }
      }
    }
    fsReady = true;

    // 全クライアントに通知
    self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({
        type: 'ZIP_READY',
        fileCount: virtualFS.size,
        files: [...virtualFS.keys()]
      }))
    )
  } catch (err) {
    console.error('ZIP processing error:', err);
    self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({
        type: 'ZIP_ERROR',
        error: err.message
      }))
    )
  }
})

// --- fetch インターセプト ---
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // /sandbox/post/* 配下のリクエストのみ仮想FSで処理
  const match = url.pathname.match(/^\/sandbox\/post\/[^\/]+(\/.*)?$/)
  if (!match) return  // 他はスルー

  // sandbox内パス: /sandbox/post/{id}/foo/bar → /foo/bar
  let filePath = match[1] || '/index.html'
  if (filePath === '/') filePath = '/index.html'
  
  // 親ページリクエスト (/sandbox/post/{id}) はスルーして Worker に処理させる
  if (!match[1]) return

  event.respondWith(serveFromFS(filePath))
})

async function serveFromFS(filePath) {
  // FSが未準備の場合は最大3秒待機
  if (!fsReady) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FS timeout')), 3000)
      const check = setInterval(() => {
        if (fsReady) { clearInterval(check); clearTimeout(timer); resolve() }
      }, 50)
    }).catch(() => {})
  }

  const data = virtualFS.get(filePath)
    ?? virtualFS.get(filePath.replace(/\/$/, '/index.html'))

  if (!data) {
    return new Response('404 Not Found: ' + filePath, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    })
  }

  return new Response(data, {
    headers: {
      'Content-Type': getMime(filePath),
      'Cache-Control': 'no-cache'
    }
  })
}

function getMime(path) {
  const ext = '.' + path.split('.').pop().toLowerCase()
  return EXT_CONFIG[ext] || 'application/octet-stream'
}`
  
  return new Response(swContent, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/sandbox/'
    }
  })
})

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx)
  }
}
