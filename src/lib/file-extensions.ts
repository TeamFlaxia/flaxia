// Unified file extension and MIME type validation for ZIP execution

export const ALLOWED_EXTENSIONS: Record<string, string> = {
  // Web content
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  
  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  
  // WebAssembly and binary
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.wasm.code': 'application/wasm',
  '.wasm.framework': 'application/octet-stream',
  
  // Text and shaders
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
  '.rsp': 'text/plain',

  // DOS executables and support files
  '.exe': 'application/x-msdos-program',
  '.com': 'application/x-msdos-program',
  '.bat': 'text/plain',
  '.conf': 'text/plain',
  '.img': 'application/octet-stream',
  '.iso': 'application/x-iso9660',
  '.dosz': 'application/octet-stream',
  '.jsdos': 'application/zip',
  '.ovl': 'application/octet-stream',
  '.cfg': 'text/plain'
}

export function isExtensionAllowed(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return ext in ALLOWED_EXTENSIONS
}

export function getMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return ALLOWED_EXTENSIONS[ext] || 'text/plain'
}

export function validateFileType(filename: string): { allowed: boolean; mimeType: string } {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  const mimeType = ALLOWED_EXTENSIONS[ext] || 'text/plain'
  const allowed = ext in ALLOWED_EXTENSIONS
  
  return { allowed, mimeType }
}
