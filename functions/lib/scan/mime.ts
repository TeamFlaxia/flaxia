// Step 2 of the file scanning pipeline: file type detection and masquerade
// checks. The magic-byte table moved here from functions/api/helpers.ts so the
// scan module is self-contained; helpers re-exports the two functions routes
// already import.

export const MAGIC_TYPES: { offset: number; bytes: number[]; mime: string }[] = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], mime: 'application/zip' },
  { offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08], mime: 'application/zip' },
  { offset: 0, bytes: [0x43, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x46, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x5a, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xfb], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xf3], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xf2], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xe3], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xe2], mime: 'audio/mpeg' },
  { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45], mime: 'audio/wav' },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' },
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
];

export function detectMimeType(data: ArrayBuffer | Uint8Array): string | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const header = bytes.subarray(0, 12);
  if (
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'image/webp';
  }
  // Markup sniff: after an optional BOM and whitespace, any '<' opens markup
  // (HTML/XML/SVG/<script>/<!DOCTYPE...>). None of the allowlisted formats
  // start with '<', so the rule cannot mask them.
  const head = bytes.subarray(0, Math.min(512, bytes.length));
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  if (head[i] === 0x3c) {
    return 'text/html';
  }
  for (const t of MAGIC_TYPES) {
    if (t.bytes.every((b, j) => header[t.offset + j] === b)) {
      return t.mime;
    }
  }
  return null;
}

export function isAllowedImageMime(
  mime: string | null,
): mime is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  return !!mime && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime);
}

// ── Extension ↔ detected MIME consistency ──

/** Extensions whose meaning is unambiguous, mapped to the MIME they must imply. */
const EXT_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  zip: 'application/zip',
  swf: 'application/x-shockwave-flash',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
};

/** Pull the extension off an R2 key or filename (`a/b/c.png` → `png`). */
export function extensionOf(name: string): string | null {
  const base = name.split('/').pop() ?? '';
  // Content-hash keys like `avatar/deadbeef` and `ad/payload/x` carry no
  // extension, and `postId.thumb.png` must read as `png`.
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

/**
 * Container families that magic-byte sniffing cannot tell apart: an `ftyp` box
 * is reported as `video/mp4` and an EBML header as `video/webm`, regardless of
 * whether the file carries audio or video tracks. All members of a family are
 * accepted for each other so `.m4a`, `.mov` and audio-only `.webm` uploads —
 * which the composer advertises — do not read as masquerades.
 */
const CONTAINER_FAMILIES: readonly (readonly string[])[] = [
  ['video/mp4', 'audio/mp4', 'video/quicktime'],
  ['video/webm', 'audio/webm'],
];

/** True when both MIME types denote the same bytes, container family aside. */
function mimesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  return CONTAINER_FAMILIES.some((family) => family.includes(a) && family.includes(b));
}

/**
 * Masquerade check: the extension on the storage key/filename must agree with
 * the magic-byte verdict. Returns an error message, or null when consistent.
 * Unknown or absent extensions are left for the caller's allowlist.
 */
export function checkExtensionMatchesMime(name: string, detectedMime: string): string | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  const expected = EXT_MIME_MAP[ext];
  if (!expected) return null;
  if (mimesCompatible(expected, detectedMime)) return null;
  return `File extension .${ext} does not match actual file content (${detectedMime})`;
}

// ── Declared Content-Type ↔ detected MIME consistency ──

/** Declarations that carry no information and never contradict the bytes. */
const GENERIC_DECLARED = new Set(['application/octet-stream', 'binary/octet-stream', 'application/binary', '']);

const DECLARED_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'application/x-shockwave-flash': 'application/x-shockwave-flash',
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'video/x-matroska': 'video/webm',
  'text/html; charset=utf-8': 'text/html',
};

function normalizeDeclared(declared: string): string {
  const base = declared.split(';')[0].trim().toLowerCase();
  return DECLARED_ALIASES[base] ?? base;
}

/**
 * Consistency check between the client-declared Content-Type and the bytes.
 * Stricter than the historical "top-level image/ vs not" rule: the declared
 * type must now equal the detected one (after alias normalization and within
 * the same container family), except for generic binary declarations. Returns
 * an error message or null.
 */
export function checkDeclaredType(declared: string | null | undefined, detectedMime: string): string | null {
  if (!declared) return null;
  const normalized = normalizeDeclared(declared);
  if (GENERIC_DECLARED.has(normalized)) return null;
  if (mimesCompatible(normalized, detectedMime)) return null;
  // ZIP games are routinely uploaded with a page's or form's content type.
  if (detectedMime === 'application/zip') return null;
  return `Declared Content-Type does not match actual file content`;
}

/** Map a detected MIME to the attachment kind it may occupy, or null if none. */
export function attachmentKindForMime(mime: string): 'image' | 'audio' | 'video' | null {
  if (isAllowedImageMime(mime)) return 'image';
  if (mime === 'application/zip' || mime === 'application/x-shockwave-flash' || mime === 'text/html') {
    return null;
  }
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}
