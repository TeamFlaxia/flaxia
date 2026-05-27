import { Hono } from 'hono'

interface Env {
  BUCKET: R2Bucket
}

type Bindings = Env

const app = new Hono<{ Bindings: Bindings }>()

app.get('/:postId', async (c) => {
  console.log('Sandbox POST function called for:', c.req.url)
  const postId = c.req.param('postId')
  
  console.log('Extracted postId:', postId)
  
  if (!postId) {
    return c.json({ error: 'postId is required' }, 400)
  }

  try {
    console.log('POST endpoint called for postId:', postId)
    
    if (!c.env.BUCKET) {
      console.log('R2 bucket not available')
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // R2 から ZIP を取得確認
    const zipKey = `zip/${postId}.zip`
    const object = await c.env.BUCKET.get(zipKey)

    console.log('R2 result for POST:', object ? 'found' : 'not found')

    if (!object) {
      return c.json({ error: 'ZIP not found' }, 404)
    }
    
    // Service Worker を使用した sandbox HTML
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Flaxia Sandbox</title>
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'self';
    connect-src 'self' /api/zip/* /api/wvfs-zip/* /api/wvfs/* https://sandbox.flaxia.app;
    style-src 'self';
    img-src 'self' data: blob:;
    media-src 'self' blob:;
    font-src 'self';
    frame-src 'none';
    object-src 'none';
    base-uri 'self';
    form-action 'none';
  ">
  <style>
    body { margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    #loading { display: flex; align-items: center; justify-content: center; height: 100vh; }
    #error { display: none; padding: 20px; color: #c00; text-align: center; }
    #content { width: 100%; height: 100vh; border: none; }
  </style>
</head>
<body>
  <div id="loading">Loading ZIP content...</div>
  <div id="error"></div>
  <iframe id="content" style="display:none;" sandbox="allow-scripts allow-modals"></iframe>
  
<script>
  const postId = location.pathname.split('/')[3]

  // セキュリティ: 親ページとの通信を制限
  const ALLOWED_ORIGINS = [
    'https://flaxia.app',
    'https://*.flaxia.app',
    'https://*.pages.dev'  // Cloudflare Pages preview
  ];

  function isOriginAllowed(origin) {
    return ALLOWED_ORIGINS.some(allowed => {
      if (allowed.includes('*')) {
        const pattern = allowed.replace('*', '.*')
        return new RegExp('^' + pattern + '$').test(origin)
      }
      return origin === allowed
    })
  }

  function validateMessageOrigin(event) {
    if (!event.origin || !isOriginAllowed(event.origin)) {
      console.warn('Blocked message from unauthorized origin:', event.origin)
      return false
    }
    return true
  }
  
  async function init() {
    // 1. SW登録 (iframe内では実行しない)
    if (!('serviceWorker' in navigator)) {
      return showError('Service Worker 非対応ブラウザです')
    }

    
    const reg = await navigator.serviceWorker.register('/api/sandbox/sw.js', { scope: '/api/sandbox/post/' })
    await reg.update()

    // 2. SW制御権を確実に取得
    await waitForController()

    // 3. ZIP取得
    const res = await fetch('/api/zip/' + postId)
    if (!res.ok) return showError('ZIP not found')
    const zipData = await res.arrayBuffer()

    // 4. ZIPサイズ検証 (50MB制限)
    if (zipData.byteLength > 50 * 1024 * 1024) {
      return showError('ZIPファイルが大きすぎます (最大50MB)')
    }

    // 5. SWにZIPを送信 → ZIP_READYを待つ
    navigator.serviceWorker.controller.postMessage({ type: 'SETUP_ZIP', zipData })

    // ウォッチドッグタイマー: 5秒でタイムアウト
    const watchdogTimer = setTimeout(() => {
      showError('ZIP展開がタイムアウトしました');
      // iframeを停止
      const iframe = document.getElementById('content');
      if (iframe) iframe.src = 'about:blank';
    }, 5000);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ZIP展開タイムアウト')), 10000)
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'ZIP_READY') { 
          clearTimeout(timer)
          clearTimeout(watchdogTimer);
          // iframe用にフラグを設定
          window.virtualFSReady = true
          resolve(e.data) 
        }
        if (e.data?.type === 'ZIP_ERROR') { 
          clearTimeout(timer);
          clearTimeout(watchdogTimer);
          reject(new Error(e.data.error)) 
        }
      }, { once: true })
    })

    // 5. iframeで読み込み（SWがインターセプト）
    const iframe = document.getElementById('content')
    document.getElementById('loading').style.display = 'none'
    iframe.style.display = 'block'
    iframe.src = '/api/sandbox/post/' + postId + '/index.html'
  }

  async function waitForController() {
    console.log('Waiting for Service Worker controller...')
    
    // すでにコントローラーがある場合は即時リターン
    if (navigator.serviceWorker.controller) {
      console.log('Controller already available')
      return
    }
    
    // コントローラーを待つ（最大10秒）
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('Controller wait timeout')
        reject(new Error('Service Worker controller timeout'))
      }, 10000)
      
      const handler = () => {
        console.log('Controller changed - now available')
        clearTimeout(timeout)
        navigator.serviceWorker.removeEventListener('controllerchange', handler)
        resolve()
      }
      
      navigator.serviceWorker.addEventListener('controllerchange', handler)
      
      // 定期的にコントローラーをチェック
      const checkInterval = setInterval(() => {
        if (navigator.serviceWorker.controller) {
          console.log('Controller found via polling')
          clearTimeout(timeout)
          clearInterval(checkInterval)
          navigator.serviceWorker.removeEventListener('controllerchange', handler)
          resolve()
        }
      }, 100)
    })
  }
  
  
  function showError(msg) {
    document.getElementById('loading').style.display = 'none'
    const err = document.getElementById('error')
    err.style.display = 'block'
    err.textContent = msg
  }

  init().catch(e => showError(e.message))
</script>
</body>
</html>
    `
    
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN'
      }
    })
  } catch (error) {
    console.error('Error in POST endpoint:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx)
  }
}
