import { validateZipLegacy } from './zip-executor'
import { getMimeType } from './file-extensions'

const WVFS_TTL = 5 * 60 * 1000 // 5 minutes

interface WvfsEntry {
  data: Map<string, Uint8Array>
  createdAt: number
}

// In-memory WVFS storage for Cloudflare Workers
const wvfsStorage = new Map<string, WvfsEntry>()

function cleanupExpiredEntries(): void {
  const now = Date.now()
  for (const [postId, entry] of wvfsStorage) {
    if (now - entry.createdAt > WVFS_TTL) {
      wvfsStorage.delete(postId)
    }
  }
}

// Path normalization utility for handling relative paths
function normalizePath(path: string): string {
  if (!path) return 'index.html'
  
  // Remove leading slash and split into segments
  const segments = path.replace(/^\//, '').split('/')
  const normalized: string[] = []
  
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      // Skip empty segments and current directory references
      continue
    } else if (segment === '..') {
      // Prevent path traversal beyond root directory
      if (normalized.length === 0) {
        throw new Error('Path traversal detected: attempt to go beyond root directory')
      }
      normalized.pop()
    } else {
      // Validate for invalid characters
      if (segment.includes('\0') || /[<>:"|?*]/.test(segment)) {
        throw new Error(`Invalid path segment: ${segment}`)
      }
      // Check for path length
      if (segment.length > 255) {
        throw new Error(`Path segment too long: ${segment}`)
      }
      normalized.push(segment)
    }
  }
  
  // Check total path depth
  if (normalized.length > 10) {
    throw new Error(`Path too deep: ${normalized.join('/')}`)
  }
  
  // If result is empty, return index.html
  const result = normalized.join('/')
  return result || 'index.html'
}

// Enhanced file search with multiple fallback patterns
function findFileInMap(fileMap: Map<string, Uint8Array>, filePath: string): Uint8Array | null {
  // Try exact match first
  let fileData = fileMap.get(filePath)
  if (fileData) return fileData
  
  // Try with index.html for directory requests
  if (filePath.endsWith('/')) {
    fileData = fileMap.get(filePath + 'index.html')
    if (fileData) return fileData
  }
  
  // Try without leading slash
  if (filePath.startsWith('/')) {
    fileData = fileMap.get(filePath.substring(1))
    if (fileData) return fileData
  }
  
  // Try common fallbacks
  const fallbacks = [
    filePath + '/index.html',
    'index.html',
    filePath.replace(/\/$/, '')
  ]
  
  for (const fallback of fallbacks) {
    fileData = fileMap.get(fallback)
    if (fileData) return fileData
  }
  
  return null
}

// Server-side WVFS functions (to be used in Workers)
export async function extractZipToWvfs(zipData: ArrayBuffer, postId: string): Promise<void> {
  try {
    cleanupExpiredEntries()

    // Validate ZIP structure first, before extracting
    await validateZipLegacy(zipData)

    // Then extract using fflate
    const fflate = await import('fflate')
    const zip = fflate.unzipSync(new Uint8Array(zipData))
    
    // Store files in memory
    const fileMap = new Map<string, Uint8Array>()
    for (const [filename, fileData] of Object.entries(zip)) {
      if (filename.endsWith('/')) continue // skip directories
      fileMap.set(filename, fileData)
    }
    
    // Store in global WVFS storage with timestamp
    wvfsStorage.set(postId, { data: fileMap, createdAt: Date.now() })
    
  } catch (error) {
    // Clean up on error
    wvfsStorage.delete(postId)
    throw error
  }
}

export async function serveFileFromWvfs(postId: string, filePath: string): Promise<Response | null> {
  cleanupExpiredEntries()

  // This function runs in the Worker to serve files from memory
  const entry = wvfsStorage.get(postId)

  if (!entry) {
    console.log(`WVFS: No file map found for postId: ${postId}`)
    return null
  }

  const fileMap = entry.data
  
  try {
    // Normalize the file path to handle relative paths
    const normalizedPath = normalizePath(filePath)
    console.log(`WVFS: Serving ${filePath} -> normalized to ${normalizedPath}`)
    
    // Use enhanced file search
    let fileData = findFileInMap(fileMap, normalizedPath)
    
    if (!fileData) {
      console.log(`WVFS: File not found: ${normalizedPath} (original: ${filePath})`)
      // List available files for debugging
      const availableFiles = Array.from(fileMap.keys()).slice(0, 10)
      console.log(`WVFS: Available files: ${availableFiles.join(', ')}`)
      return null
    }
    
    const ext = normalizedPath.split('.').pop()?.toLowerCase()
    
    // For HTML files, inject base tag to fix relative paths
    if (ext === 'html') {
      const htmlContent = new TextDecoder().decode(fileData)
      const modifiedHtml = injectBaseTag(htmlContent, postId)
      fileData = new TextEncoder().encode(modifiedHtml)
    }
    
    // Determine content type using unified MIME type validation
    const contentType = getMimeType(normalizedPath)
    
    return new Response(new Uint8Array(fileData), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error) {
    // Log detailed error for debugging, but return generic error to user
    console.error('Error serving file from WVFS:', error)
    
    // Don't expose internal error details to prevent information leakage
    if (error instanceof Error && error.message.includes('Path traversal')) {
      console.warn('Security violation: Path traversal attempt detected')
    }
    
    return null
  }
}

// Inject base tag into HTML to fix relative paths
function injectBaseTag(htmlContent: string, postId: string): string {
  const baseUrl = `/api/wvfs-zip/${postId}/`
  
  // Try to insert after <head> or after <meta charset> if present
  if (htmlContent.includes('<head>')) {
    return htmlContent.replace(
      /<head>/i,
      `<head>\n  <base href="${baseUrl}">`
    )
  } else if (htmlContent.includes('<meta charset')) {
    return htmlContent.replace(
      /(<meta charset[^>]*>)/i,
      `$1\n  <base href="${baseUrl}">`
    )
  } else {
    // Fallback: insert at the beginning
    return `<base href="${baseUrl}">\n${htmlContent}`
  }
}

export async function cleanupWvfsZip(postId: string): Promise<void> {
  // Clean up WVFS memory storage for this post
  cleanupExpiredEntries()
  try {
    wvfsStorage.delete(postId)
  } catch (error) {
    console.error('Error cleaning up WVFS:', error)
  }
}
