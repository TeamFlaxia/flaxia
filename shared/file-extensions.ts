// Unified file extension and MIME type validation for ZIP execution

/** Executable post payloads use the sandbox flow instead of document attachments. */
export const GAME_FILE_EXTENSIONS = new Set(['zip', 'swf', 'html', 'htm', 'rsp', 'js', 'wasm']);

/**
 * Known MIME mappings for files commonly shipped inside game ZIPs.
 *
 * This is no longer an allowlist: an unrecognised extension is served as an
 * opaque download instead of aborting ZIP extraction. Only formats that can
 * execute code or wrap a native binary are blocked (see BLOCKED_EXTENSIONS).
 */
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
  // NOTE: '.svg' / '.svgz' are in BLOCKED_EXTENSIONS (H-4/M-5): scriptable SVG
  // inside game ZIPs is an XSS vector, so a blacklist keeps them out.

  '.ico': 'image/x-icon',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',

  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',

  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',

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
  '.cf': 'text/plain',
  '.zip': 'application/zip',
};

/**
 * Formats that can execute code or wrap a native binary. Everything else is
 * allowed as an opaque download, so new asset formats do not break games.
 * Nested ZIPs and symlinks are rejected separately by the ZIP validators.
 */
export const BLOCKED_EXTENSIONS = new Set([
  // Scriptable vector graphics (XSS inside the game origin).
  '.svg',
  '.svgz',
  // Server-side scripts (never interpreted here, but no reason to ship them).
  '.php',
  '.php3',
  '.php4',
  '.php5',
  '.phtml',
  '.jsp',
  '.jspx',
  '.asp',
  '.aspx',
  '.py',
  '.pyc',
  '.rb',
  '.pl',
  '.pm',
  // Shell / automation scripts.
  '.sh',
  '.bash',
  '.zsh',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.hta',
  // Native executables and libraries.
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.msi',
  '.deb',
  '.rpm',
  '.dmg',
  '.pkg',
  '.apk',
  '.ipa',
  '.app',
  '.scr',
  '.jar',
  '.war',
  '.class',
]);

function extensionOf(filename: string): string {
  return filename.substring(filename.lastIndexOf('.')).toLowerCase();
}

/** Blocked formats are rejected; every other extension is permitted. */
export function isExtensionAllowed(filename: string): boolean {
  return !BLOCKED_EXTENSIONS.has(extensionOf(filename));
}

/** Unknown extensions are served as opaque downloads, never as active content. */
export function getMimeType(filename: string): string {
  return ALLOWED_EXTENSIONS[extensionOf(filename)] || 'application/octet-stream';
}

export function validateFileType(filename: string): { allowed: boolean; mimeType: string } {
  return { allowed: isExtensionAllowed(filename), mimeType: getMimeType(filename) };
}

/**
 * MIME types for post attachments, used only as a fallback when the browser
 * reports an empty `File.type`.
 *
 * Deliberately separate from ALLOWED_EXTENSIONS: that map also drives the
 * sandbox's allowlist for files inside a game ZIP, which is not affected by
 * the post attachment feature.
 */
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
};

export function attachmentMimeType(filename: string): string | undefined {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return ATTACHMENT_MIME_TYPES[ext];
}
