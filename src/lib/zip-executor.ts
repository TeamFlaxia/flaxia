import { ALLOWED_EXTENSIONS, validateFileType } from './file-extensions'
import { t } from './i18n.js'

export interface ZipExecutorHandle {
  destroy: () => void
}

const SANDBOX_ORIGIN = ''
const SANDBOX_API_ORIGIN = ''

// Global execution manager
let activeHandle: ZipExecutorHandle | null = null

// Cache for dynamic imports
let jszipPromise: Promise<any> | null = null

async function getJSZip() {
  if (!jszipPromise) {
    jszipPromise = import('jszip')
  }
  const JSZipModule = await jszipPromise
  return (JSZipModule as any).default
}


export async function executeZip(
  postId: string,
  containerEl: HTMLElement,
  url?: string  // if provided, fetch from this URL instead of /api/zip/${postId}
): Promise<ZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    // JSZip方式: ZIPデータをフェッチしてJSZipで展開
    const zipUrl = url || `/api/zip/${postId}`
    const response = await fetch(zipUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch ZIP: ${response.status}`)
    }
    const zipData = await response.arrayBuffer()
    
    // JSZipで展開
    const JSZip = await getJSZip()
    const zip = await JSZip.loadAsync(zipData)
    validateZip(zip)
    
    // Blob URLマップを生成
    const blobUrlMap = await generateBlobUrlMap(zip)
    
    // index.htmlを書き換えてBlob URLに置換
    const htmlContent = await rewriteIndexHtml(zip, blobUrlMap)
    
    // Blob URLを生成
    const htmlBlob = new Blob([htmlContent], { type: 'text/html' })
    const htmlBlobUrl = URL.createObjectURL(htmlBlob)
    
    // iframeを作成してBlob URLを読み込む
    const { iframe, cleanup } = await createSandboxIframe(postId, containerEl, htmlBlobUrl)

    // Create handle with cleanup
    const handle: ZipExecutorHandle = {
      destroy: () => {
        cleanup()
        
        // Blob URLを解放
        blobUrlMap.forEach(url => URL.revokeObjectURL(url))
        URL.revokeObjectURL(htmlBlobUrl)
        
        // Remove fullscreen button if it exists
        const fullscreenBtn = containerEl.querySelector('.zip-fullscreen-btn')
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn)
        }
      }
    }

    activeHandle = handle
    return handle

  } catch (error) {
    // Clean up on error
    if (activeHandle) {
      activeHandle.destroy()
      activeHandle = null
    }
    throw error
  }
}

async function createSandboxIframe(postId: string, containerEl: HTMLElement, blobUrl?: string): Promise<{ iframe: HTMLIFrameElement, cleanup: () => void }> {
  // JSZip方式: Blob URLを使用
  const iframeUrl = blobUrl || `/sandbox/?postId=${postId}`
  
  // Create iframe container
  const iframeContainer = document.createElement('div')
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `
  
  // Create iframe pointing to sandbox domain
  const iframe = document.createElement('iframe')
  iframe.src = iframeUrl
  // JSZip方式ではallow-same-originは不要
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen'
  iframe.setAttribute('allow', 'fullscreen')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  `
  
  // Add fullscreen button
  const fullscreenBtn = document.createElement('button')
  fullscreenBtn.textContent = t('fullscreen.button')
  fullscreenBtn.className = 'zip-fullscreen-btn'
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid #ccc;
    background: #f0f0f0;
    cursor: pointer;
    border-radius: 4px;
    align-self: center;
  `
  fullscreenBtn.onclick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    
    try {
      if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch(err => {
          console.warn('Container fullscreen failed:', err)
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch(err2 => {
              console.warn('Iframe fullscreen failed:', err2)
            })
          }
        })
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch(err => {
          console.warn('Iframe fullscreen failed:', err)
        })
      }
    } catch (error) {
      console.error('Fullscreen error:', error)
    }
  }
  
  // Clear container and add iframe container
  containerEl.innerHTML = ''
  containerEl.appendChild(iframeContainer)
  iframeContainer.appendChild(iframe)
  iframeContainer.appendChild(fullscreenBtn)
  
  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe)
    }
  }

  return { iframe, cleanup }
}

export async function rewriteIndexHtmlLegacy(zipData: ArrayBuffer, blobUrlMap: Map<string, string>): Promise<string> {
  const JSZip = await getJSZip()
  const zip = await JSZip.loadAsync(zipData)
  return rewriteIndexHtml(zip, blobUrlMap)
}

// Private helper functions (used by legacy functions)
function validateZip(zip: any): void {
  const files = Object.entries(zip.files)

  if (files.length > 255) {
    throw new Error('Too many files (max 255)')
  }

  let totalSize = 0
  let hasIndexHtml = false

  for (const [path, file] of files) {
    if ((file as any).dir) continue

    if (path.length > 255) {
      throw new Error(`Path too long: ${path}`)
    }

    const depth = (path.match(/\//g) || []).length
    if (depth > 10) {
      throw new Error(`Directory too deep: ${path}`)
    }

    const fileSize = (file as any)._data?.uncompressedSize || 0
    totalSize += fileSize
    if (totalSize > 100 * 1024 * 1024) {
      throw new Error('Extracted size too large (max 100MB)')
    }

    if (path.toLowerCase().endsWith('.zip')) {
      throw new Error('Nested ZIP files are not allowed')
    }

    const unixPermissions = (file as any).unixPermissions
    if (unixPermissions && (unixPermissions & 0xF000) === 0xA000) {
      throw new Error('Symbolic links are not allowed')
    }

    if (path.includes('../')) {
      throw new Error(`Path traversal detected: ${path}`)
    }

    if (path.startsWith('/')) {
      throw new Error(`Absolute paths are not allowed: ${path}`)
    }

    if (path === 'index.html') {
      hasIndexHtml = true
    }

    const { allowed } = validateFileType(path)
    if (!allowed) {
      throw new Error(`File type not allowed: ${path}`)
    }
  }

  if (!hasIndexHtml) {
    throw new Error('index.html not found at root')
  }
}

// Legacy functions kept for backward compatibility (used by tests)
export async function validateZipLegacy(zipData: ArrayBuffer): Promise<void> {
  const JSZip = await getJSZip()
  const zip = await JSZip.loadAsync(zipData)
  validateZip(zip)
}

async function generateBlobUrlMap(zip: any): Promise<Map<string, string>> {
  const blobUrlMap = new Map<string, string>()

  for (const [path, file] of Object.entries(zip.files)) {
    if ((file as any).dir) continue

    const normalizedPath = path.replace(/^\.\//, '')
    const { mimeType } = validateFileType(path)

    if (mimeType) {
      const content = await (file as any).async('uint8array')
      const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
      const blob = new Blob([arrayBuffer], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      blobUrlMap.set(normalizedPath, blobUrl)
    }
  }

  return blobUrlMap
}

async function rewriteIndexHtml(zip: any, blobUrlMap: Map<string, string>): Promise<string> {
  const indexFile = zip.files['index.html']
  if (!indexFile || indexFile.dir) {
    throw new Error('index.html not found at root')
  }

  let htmlContent = await (indexFile as any).async('string')
  htmlContent = rewriteHtmlString(htmlContent, blobUrlMap)

  return htmlContent
}

function rewriteHtmlString(htmlContent: string, blobUrlMap: Map<string, string>): string {
  htmlContent = htmlContent.replace(/<(?!script)([^>]+)\s+src\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, src) => {
    if (shouldRewritePath(src)) {
      const normalizedPath = src.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `<${tagAttrs} src="${blobUrl}"`
      }
    }
    return match
  })

  htmlContent = htmlContent.replace(/<([^>]+)\s+href\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, href) => {
    if (shouldRewritePath(href)) {
      const normalizedPath = href.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `<${tagAttrs} href="${blobUrl}"`
      }
    }
    return match
  })

  htmlContent = htmlContent.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, cssContent) => {
    const rewrittenCss = rewriteCssUrls(cssContent, blobUrlMap)
    return match.replace(cssContent, rewrittenCss)
  })

  htmlContent = htmlContent.replace(/style\s*=\s*['"]([^'"]+)['"]/gi, (match, styleContent) => {
    const rewrittenStyle = rewriteCssUrls(styleContent, blobUrlMap)
    return `style="${rewrittenStyle}"`
  })

  return htmlContent
}

function rewriteCssUrls(cssText: string, blobUrlMap: Map<string, string>): string {
  return cssText.replace(/url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, path) => {
    if (shouldRewritePath(path)) {
      const normalizedPath = path.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `url("${blobUrl}")`
      }
    }
    return match
  })
}

function shouldRewritePath(path: string): boolean {
  return !path.startsWith('https://') &&
         !path.startsWith('http://') &&
         !path.startsWith('data:') &&
         !path.startsWith('blob:')
}
