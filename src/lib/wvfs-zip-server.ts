import { getMimeType } from './file-extensions';
import { validateZipLegacy } from './zip-executor';

const WVFS_TTL = 5 * 60 * 1000; // 5 minutes

interface ZipIndexEntry {
  fileName: string;
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

interface WvfsEntry {
  data: Map<string, Uint8Array>;
  createdAt: number;
  index: Map<string, ZipIndexEntry> | null;
  zipKey: string | null;
}

// In-memory WVFS storage for Cloudflare Workers
const wvfsStorage = new Map<string, WvfsEntry>();

function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [postId, entry] of wvfsStorage) {
    if (now - entry.createdAt > WVFS_TTL) {
      wvfsStorage.delete(postId);
    }
  }
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEocd(data: Uint8Array): { cdOffset: number; cdSize: number; cdEntries: number } | null {
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      const view = new DataView(data.buffer, data.byteOffset + i);
      return {
        cdEntries: readUint16(view, 8),
        cdSize: readUint32(view, 12),
        cdOffset: readUint32(view, 16),
      };
    }
  }
  return null;
}

function parseCentralDirectory(data: Uint8Array): Map<string, ZipIndexEntry> {
  const index = new Map<string, ZipIndexEntry>();
  let offset = 0;
  const view = new DataView(data.buffer, data.byteOffset);

  while (offset + 46 <= data.length) {
    if (readUint32(view, offset) !== 0x02014b50) break;

    const fileNameLen = readUint16(view, offset + 28);
    const extraLen = readUint16(view, offset + 30);
    const commentLen = readUint16(view, offset + 32);

    const fileNameBytes = data.slice(offset + 46, offset + 46 + fileNameLen);
    const fileName = new TextDecoder().decode(fileNameBytes);

    if (!fileName.endsWith('/')) {
      index.set(fileName, {
        fileName,
        localHeaderOffset: readUint32(view, offset + 42),
        compressedSize: readUint32(view, offset + 20),
        uncompressedSize: readUint32(view, offset + 22),
        compressionMethod: readUint16(view, offset + 10),
      });
    }

    offset += 46 + fileNameLen + extraLen + commentLen;
  }

  return index;
}

// Extract a single file from a ZIP by reading from R2 using range requests.
// This avoids downloading the entire ZIP before serving the first file.
async function extractFileFromR2(bucket: R2Bucket, zipKey: string, entry: ZipIndexEntry): Promise<Uint8Array | null> {
  try {
    // Read local file header (30 bytes) to get filename length and extra field length
    const headerBuf = await bucket.get(zipKey, { range: { offset: entry.localHeaderOffset, length: 30 } });
    if (!headerBuf) return null;
    const headerArr = new Uint8Array(await headerBuf.arrayBuffer());
    const headerView = new DataView(headerArr.buffer, headerArr.byteOffset);

    if (readUint32(headerView, 0) !== 0x04034b50) return null;

    const fileNameLen = readUint16(headerView, 26);
    const extraLen = readUint16(headerView, 28);

    // Read the compressed data portion
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLen + extraLen;
    const dataChunk = await bucket.get(zipKey, { range: { offset: dataOffset, length: entry.compressedSize } });
    if (!dataChunk) return null;
    const compressedData = new Uint8Array(await dataChunk.arrayBuffer());

    if (entry.compressionMethod === 0) {
      return compressedData;
    }

    if (entry.compressionMethod === 8) {
      const fflate = await import('fflate');
      return fflate.inflateSync(compressedData);
    }

    console.warn(`Unsupported compression method: ${entry.compressionMethod} for ${entry.fileName}`);
    return null;
  } catch (err) {
    console.error(`Error extracting ${entry.fileName} from ZIP:`, err);
    return null;
  }
}

function normalizePath(path: string): string {
  if (!path) return 'index.html';

  const segments = path.replace(/^\//, '').split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
    } else if (segment === '..') {
      if (normalized.length === 0) {
        throw new Error('Path traversal detected: attempt to go beyond root directory');
      }
      normalized.pop();
    } else {
      if (segment.includes('\0') || /[<>:"|?*]/.test(segment)) {
        throw new Error(`Invalid path segment: ${segment}`);
      }
      if (segment.length > 255) {
        throw new Error(`Path segment too long: ${segment}`);
      }
      normalized.push(segment);
    }
  }

  if (normalized.length > 10) {
    throw new Error(`Path too deep: ${normalized.join('/')}`);
  }

  const result = normalized.join('/');
  return result || 'index.html';
}

function findFileInMap(fileMap: Map<string, Uint8Array>, filePath: string): Uint8Array | null {
  let fileData = fileMap.get(filePath);
  if (fileData) return fileData;

  if (filePath.endsWith('/')) {
    fileData = fileMap.get(filePath + 'index.html');
    if (fileData) return fileData;
  }

  if (filePath.startsWith('/')) {
    fileData = fileMap.get(filePath.substring(1));
    if (fileData) return fileData;
  }

  const fallbacks = [filePath + '/index.html', 'index.html', filePath.replace(/\/$/, '')];

  for (const fallback of fallbacks) {
    fileData = fileMap.get(fallback);
    if (fileData) return fileData;
  }

  return null;
}

function findFileInIndex(index: Map<string, ZipIndexEntry>, filePath: string): ZipIndexEntry | null {
  let entry = index.get(filePath);
  if (entry) return entry;

  if (filePath.endsWith('/')) {
    entry = index.get(filePath + 'index.html');
    if (entry) return entry;
  }

  if (filePath.startsWith('/')) {
    entry = index.get(filePath.substring(1));
    if (entry) return entry;
  }

  const fallbacks = [filePath + '/index.html', 'index.html', filePath.replace(/\/$/, '')];

  for (const fallback of fallbacks) {
    entry = index.get(fallback);
    if (entry) return entry;
  }

  return null;
}

// Lazy-load a single file from R2 into the WVFS cache.
// Parses the central directory (last ~64KB of ZIP) first, then uses R2 range
// reads to fetch and decompress only the requested file.
export async function ensureFileInWvfs(
  bucket: R2Bucket,
  zipKey: string,
  postId: string,
  filePath: string,
): Promise<boolean> {
  cleanupExpiredEntries();

  const entry = wvfsStorage.get(postId);

  // Already fully extracted — just check if file exists
  if (entry && !entry.index) {
    const normalizedPath = normalizePath(filePath);
    return findFileInMap(entry.data, normalizedPath) !== null;
  }

  // Already have the index but file not yet extracted
  if (entry && entry.index && entry.zipKey === zipKey) {
    const normalizedPath = normalizePath(filePath);
    const indexEntry = findFileInIndex(entry.index, normalizedPath);
    if (!indexEntry) return false;

    const existing = findFileInMap(entry.data, normalizedPath);
    if (existing) return true;

    const fileData = await extractFileFromR2(bucket, zipKey, indexEntry);
    if (!fileData) return false;

    entry.data.set(normalizedPath, fileData);
    return true;
  }

  // No entry at all — parse central directory first
  const head = await bucket.head(zipKey);
  if (!head) return false;

  // Read last 64KB (or entire file if smaller) to find EOCD + central directory
  const tailSize = Math.min(head.size, 65536);
  const tailObj = await bucket.get(zipKey, { range: { offset: head.size - tailSize, length: tailSize } });
  if (!tailObj) return false;
  const tailData = new Uint8Array(await tailObj.arrayBuffer());

  const eocd = findEocd(tailData);
  if (!eocd) return false;

  const cdObj = await bucket.get(zipKey, { range: { offset: eocd.cdOffset, length: eocd.cdSize } });
  if (!cdObj) return false;
  const cdData = new Uint8Array(await cdObj.arrayBuffer());

  const index = parseCentralDirectory(cdData);
  const normalizedPath = normalizePath(filePath);
  const indexEntry = findFileInIndex(index, normalizedPath);
  if (!indexEntry) return false;

  const fileData = await extractFileFromR2(bucket, zipKey, indexEntry);
  if (!fileData) return false;

  const fileMap = new Map<string, Uint8Array>();
  fileMap.set(normalizedPath, fileData);

  wvfsStorage.set(postId, {
    data: fileMap,
    createdAt: Date.now(),
    index,
    zipKey,
  });

  return true;
}

// Full extraction of all files from ZIP data (used for background preload)
export async function extractZipToWvfs(zipData: ArrayBuffer, postId: string): Promise<void> {
  try {
    cleanupExpiredEntries();

    await validateZipLegacy(zipData);

    const fflate = await import('fflate');
    const zip = fflate.unzipSync(new Uint8Array(zipData));

    const fileMap = new Map<string, Uint8Array>();
    for (const [filename, fileData] of Object.entries(zip)) {
      if (filename.endsWith('/')) continue;
      fileMap.set(filename, fileData);
    }

    wvfsStorage.set(postId, {
      data: fileMap,
      createdAt: Date.now(),
      index: null,
      zipKey: null,
    });
  } catch (error) {
    wvfsStorage.delete(postId);
    throw error;
  }
}

export async function serveFileFromWvfs(postId: string, filePath: string): Promise<Response | null> {
  cleanupExpiredEntries();

  const entry = wvfsStorage.get(postId);
  if (!entry) {
    console.log(`WVFS: No file map found for postId: ${postId}`);
    return null;
  }

  const fileMap = entry.data;

  try {
    const normalizedPath = normalizePath(filePath);
    console.log(`WVFS: Serving ${filePath} -> normalized to ${normalizedPath}`);

    let fileData = findFileInMap(fileMap, normalizedPath);
    if (!fileData) {
      console.log(`WVFS: File not found: ${normalizedPath} (original: ${filePath})`);
      const availableFiles = Array.from(fileMap.keys()).slice(0, 10);
      console.log(`WVFS: Available files: ${availableFiles.join(', ')}`);
      return null;
    }

    const ext = normalizedPath.split('.').pop()?.toLowerCase();

    if (ext === 'html') {
      const htmlContent = new TextDecoder().decode(fileData);
      const modifiedHtml = injectBaseTag(htmlContent, postId);
      fileData = new TextEncoder().encode(modifiedHtml);
    }

    const contentType = getMimeType(normalizedPath);

    return new Response(new Uint8Array(fileData), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Error serving file from WVFS:', error);
    if (error instanceof Error && error.message.includes('Path traversal')) {
      console.warn('Security violation: Path traversal attempt detected');
    }
    return null;
  }
}

function injectBaseTag(htmlContent: string, postId: string): string {
  const baseUrl = `/api/wvfs-zip/${postId}/`;

  if (htmlContent.includes('<head>')) {
    return htmlContent.replace(/<head>/i, `<head>\n  <base href="${baseUrl}">`);
  } else if (htmlContent.includes('<meta charset')) {
    return htmlContent.replace(/(<meta charset[^>]*>)/i, `$1\n  <base href="${baseUrl}">`);
  } else {
    return `<base href="${baseUrl}">\n${htmlContent}`;
  }
}

export async function cleanupWvfsZip(postId: string): Promise<void> {
  cleanupExpiredEntries();
  try {
    wvfsStorage.delete(postId);
  } catch (error) {
    console.error('Error cleaning up WVFS:', error);
  }
}
