import { validateZipLegacy } from './zip-executor'
import { getMimeType } from './file-extensions'

// Server-side WVFS functions (to be used in Workers)
export async function extractZipToWvfs(zipData: ArrayBuffer, postId: string): Promise<void> {
  // This function runs in Worker with node:fs access
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  // Create temporary directory for this post
  const extractDir = `/tmp/wvfs-zip-${postId}`
  
  try {
    // Clean up any existing directory
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    
    // Create directory
    fs.mkdirSync(extractDir, { recursive: true })
    
    // Validate ZIP structure first, before extracting
    await validateZipLegacy(zipData)

    // Then extract using fflate (server-compatible)
    const fflate = await import('fflate')
    const zip = fflate.unzipSync(new Uint8Array(zipData))
    
    // Write files to WVFS
    for (const [filename, fileData] of Object.entries(zip)) {
      if (filename.endsWith('/')) continue // skip directories
      
      const filePath = path.join(extractDir, filename)
      const fileDir = path.dirname(filePath)
      
      // Create directory if needed
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true })
      }
      
      // Write file
      fs.writeFileSync(filePath, fileData)
    }
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    throw error
  }
}

export async function serveFileFromWvfs(postId: string, filePath: string): Promise<Response | null> {
  // This function runs in Worker to serve files
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  const extractDir = `/tmp/wvfs-zip-${postId}`
  const fullPath = path.join(extractDir, filePath)
  
  // Security: ensure path is within extractDir and validate path components
  if (!fullPath.startsWith(extractDir)) {
    console.warn('Path traversal attempt detected:', filePath)
    return null
  }
  
  // Additional path validation
  const relativePath = filePath.replace(/^\//, '')
  const segments = relativePath.split('/')
  
  for (const segment of segments) {
    // Check for path traversal attempts
    if (segment === '..') {
      console.warn('Path traversal attempt detected:', filePath)
      return null
    }
    // Check for invalid characters
    if (segment.includes('\0') || /[<>:"|?*]/.test(segment)) {
      console.warn('Invalid path segment detected:', segment)
      return null
    }
    // Check for empty segments (which could indicate //)
    if (segment === '') {
      console.warn('Empty path segment detected:', filePath)
      return null
    }
  }
  
  // Check path depth
  if (segments.length > 10) {
    console.warn('Path too deep:', filePath)
    return null
  }
  
  try {
    if (!fs.existsSync(fullPath)) {
      return null
    }
    
    const fileData = fs.readFileSync(fullPath)
    const ext = path.extname(filePath).toLowerCase()
    
    // Determine content type using unified MIME type validation
    const contentType = getMimeType(filePath)
    
    return new Response(fileData, {
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

export async function cleanupWvfsZip(postId: string): Promise<void> {
  // Clean up WVFS directory for this post
  const fs = await import('node:fs')
  const extractDir = `/tmp/wvfs-zip-${postId}`
  
  try {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.error('Error cleaning up WVFS:', error)
  }
}
