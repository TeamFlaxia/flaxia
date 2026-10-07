import { CAPTURE_BRIDGE_IIFE } from './capture-bridge.generated.ts';
import { getMimeType, validateFileType } from './file-extensions.ts';
import { createWvfsImageCorsCompatScript } from './wvfs-image-cors.ts';
import { ZIP_MAX_PATH_DEPTH, ZIP_MAX_PATH_LENGTH, ZIP_MAX_TOTAL_SIZE, ZIP_TTL } from './zip-constants.ts';

const WVFS_TTL = ZIP_TTL;
const WVFS_R2_PREFIX = 'wvfs/';

// Compute the R2 base prefix for a post (or a specific game version of it).
// Versions are isolated under wvfs/<postId>/<versionId>/ so multiple releases
// of the same game can coexist without clobbering each other's extracted files.
function wvfsBase(postId: string, versionId?: string | null): string {
  return versionId ? `${WVFS_R2_PREFIX}${postId}/${versionId}` : `${WVFS_R2_PREFIX}${postId}`;
}

// Maximum files to persist to R2 in a single invocation. Keeps the number of
// subrequests under the Workers Free plan limit (50 per invocation):
// 1 head + 1 tail + 1 central dir + 1 manifest get + 3 * files + 1 manifest put.
const DEFAULT_EXTRACT_BUDGET = 14;

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

// Cache of rewritten HTML (base tag + CSP removal) to avoid re-running the
// rewrite regexes on every request. Keyed by `postId:resolvedPath`.
const HTML_CACHE_MAX = 512;
const htmlCache = new Map<string, Uint8Array>();

function cacheHtml(key: string, data: Uint8Array): Uint8Array {
  if (htmlCache.size >= HTML_CACHE_MAX) {
    htmlCache.clear();
  }
  htmlCache.set(key, data);
  return data;
}

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
    const normalizedName = fileName.replace(/^(\.\/)+/, '');

    if (normalizedName && !normalizedName.endsWith('/')) {
      index.set(normalizedName, {
        fileName: normalizedName,
        localHeaderOffset: readUint32(view, offset + 42),
        compressedSize: readUint32(view, offset + 20),
        uncompressedSize: readUint32(view, offset + 24),
        compressionMethod: readUint16(view, offset + 10),
      });
    }

    offset += 46 + fileNameLen + extraLen + commentLen;
  }

  return index;
}

// Validate a ZIP using only its central directory (no decompression).
// Keeps the same security rules as validateZipLegacy but avoids inflating the
// entire archive just to validate it.
function validateZipCentralDirectory(cdData: Uint8Array, cdEntries: number): void {
  const view = new DataView(cdData.buffer, cdData.byteOffset);
  let offset = 0;
  let totalSize = 0;
  let hasIndexHtml = false;
  let entryCount = 0;

  while (offset + 46 <= cdData.length && entryCount < cdEntries) {
    if (readUint32(view, offset) !== 0x02014b50) break;

    const fileNameLen = readUint16(view, offset + 28);
    const extraLen = readUint16(view, offset + 30);
    const commentLen = readUint16(view, offset + 32);

    entryCount++;
    if (entryCount > 255) {
      throw new Error('Too many files (max 255)');
    }

    const fileNameBytes = cdData.slice(offset + 46, offset + 46 + fileNameLen);
    const fileName = new TextDecoder().decode(fileNameBytes);

    if (!fileName.endsWith('/')) {
      if (fileName.length > ZIP_MAX_PATH_LENGTH) {
        throw new Error(`Path too long: ${fileName}`);
      }

      const depth = (fileName.match(/\//g) || []).length;
      if (depth > ZIP_MAX_PATH_DEPTH) {
        throw new Error(`Directory too deep: ${fileName}`);
      }

      if (fileName.includes('../')) {
        throw new Error(`Path traversal detected: ${fileName}`);
      }

      // #94: backslashes are separators on Windows extractors. A name like
      // `..\evil.html` passes the slash check above but escapes elsewhere.
      if (fileName.includes('\\')) {
        throw new Error(`Backslash in entry name: ${fileName}`);
      }

      if (fileName.startsWith('/')) {
        throw new Error(`Absolute paths are not allowed: ${fileName}`);
      }

      const uncompressedSize = readUint32(view, offset + 24);
      if (uncompressedSize === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
      }

      const externalAttrs = readUint32(view, offset + 38);
      if (((externalAttrs >>> 16) & 0xf000) === 0xa000) {
        throw new Error('Symbolic links are not allowed');
      }

      const normalizedName = fileName.replace(/^(\.\/)+/, '');

      if (normalizedName.toLowerCase().endsWith('.zip')) {
        throw new Error('Nested ZIP files are not allowed');
      }

      const { allowed } = validateFileType(normalizedName);
      if (!allowed) {
        throw new Error(`File type not allowed: ${normalizedName}`);
      }

      const fileNamePart = normalizedName.split('/').pop()?.toLowerCase();
      if (fileNamePart === 'index.html' || fileNamePart === 'index.htm') {
        hasIndexHtml = true;
      }

      totalSize += uncompressedSize;
      if (totalSize > ZIP_MAX_TOTAL_SIZE) {
        throw new Error('Extracted size too large (max 100MB)');
      }
    }

    offset += 46 + fileNameLen + extraLen + commentLen;
  }

  if (!hasIndexHtml) {
    throw new Error('index.html not found in zip');
  }
}

// Locate the EOCD in a fully-downloaded ZIP and validate it via the central
// directory. No decompression is performed here.
export function validateZipStructure(zipData: Uint8Array): void {
  const eocd = findEocd(zipData);
  if (!eocd) {
    throw new Error('Invalid ZIP: end of central directory not found');
  }
  const cdEnd = eocd.cdOffset + eocd.cdSize;
  if (cdEnd > zipData.length) {
    throw new Error('Invalid ZIP: central directory out of bounds');
  }
  const cdData = zipData.slice(eocd.cdOffset, cdEnd);
  validateZipCentralDirectory(cdData, eocd.cdEntries);
}

// Extract a single file from a ZIP stored in R2 using range requests.
// Avoids downloading and decompressing the entire archive.
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
      // A decompression bomb must not exhaust the isolate: reject a declared
      // size above the archive budget and pass an output buffer as well, so
      // fflate cannot allocate past the cap even if the declared size lies.
      if (entry.uncompressedSize > ZIP_MAX_TOTAL_SIZE) {
        console.warn(`ZIP entry exceeds size limit: ${entry.fileName} (${entry.uncompressedSize} bytes)`);
        return null;
      }
      const fflate = await import('fflate');
      return fflate.inflateSync(compressedData, { out: new Uint8Array(Math.max(entry.uncompressedSize, 1)) });
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
      // #91: dotfiles (e.g. .wvfs-manifest) are never game content. Refusing
      // them at normalization closes the anonymous manifest listing.
      if (segment.startsWith('.')) {
        throw new Error(`Dotfiles are not servable: ${segment}`);
      }
      if (segment.includes('\0') || /[<>:"|?*]/.test(segment)) {
        throw new Error(`Invalid path segment: ${segment}`);
      }
      if (segment.length > ZIP_MAX_PATH_LENGTH) {
        throw new Error(`Path segment too long: ${segment}`);
      }
      normalized.push(segment);
    }
  }

  if (normalized.length > ZIP_MAX_PATH_DEPTH) {
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

  const fallbacks = [filePath + '/index.html', filePath.replace(/\/$/, '')];

  for (const fallback of fallbacks) {
    fileData = fileMap.get(fallback);
    if (fileData) return fileData;
  }

  // Also try with ./ prefix in case stored paths weren't normalized
  if (!filePath.startsWith('./')) {
    fileData = fileMap.get('./' + filePath);
    if (fileData) return fileData;
  }

  return null;
}

function findSubdirIndexInMap(fileMap: Map<string, Uint8Array>): string | null {
  let bestKey: string | null = null;
  let bestDepth = Infinity;
  for (const key of fileMap.keys()) {
    const parts = key.split('/');
    const fileName = parts.pop()?.toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const depth = parts.length;
      if (depth < bestDepth) {
        bestDepth = depth;
        bestKey = key;
      }
    }
  }
  return bestKey;
}

function findSubdirIndexInIndex(index: Map<string, ZipIndexEntry>): string | null {
  let bestKey: string | null = null;
  let bestDepth = Infinity;
  for (const key of index.keys()) {
    const parts = key.split('/');
    const fileName = parts.pop()?.toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const depth = parts.length;
      if (depth < bestDepth) {
        bestDepth = depth;
        bestKey = key;
      }
    }
  }
  return bestKey;
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

  const fallbacks = [filePath + '/index.html', filePath.replace(/\/$/, '')];

  for (const fallback of fallbacks) {
    entry = index.get(fallback);
    if (entry) return entry;
  }

  // Also try with ./ prefix in case stored paths weren't normalized
  if (!filePath.startsWith('./')) {
    entry = index.get('./' + filePath);
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
  versionId?: string | null,
): Promise<boolean> {
  cleanupExpiredEntries();

  const entry = wvfsStorage.get(wvfsBase(postId, versionId));

  // Already fully extracted — just check if file exists
  if (entry && !entry.index) {
    const normalizedPath = normalizePath(filePath);
    return findFileInMap(entry.data, normalizedPath) !== null;
  }

  // Already have the index but file not yet extracted
  if (entry && entry.index && entry.zipKey === zipKey) {
    const normalizedPath = normalizePath(filePath);
    let indexEntry = findFileInIndex(entry.index, normalizedPath);
    let resolvedIndexPath = normalizedPath;

    if (!indexEntry) {
      const fileName = normalizedPath.split('/').pop()?.toLowerCase();
      if (fileName === 'index.html' || fileName === 'index.htm') {
        const foundPath = findSubdirIndexInIndex(entry.index);
        if (foundPath) {
          const found = entry.index.get(foundPath);
          if (found) {
            indexEntry = found;
            resolvedIndexPath = foundPath;
          }
        }
      }
    }

    if (!indexEntry) return false;

    const existing = findFileInMap(entry.data, resolvedIndexPath);
    if (existing) return true;

    const fileData = await extractFileFromR2(bucket, zipKey, indexEntry);
    if (!fileData) return false;

    entry.data.set(resolvedIndexPath, fileData);
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

  // #80: the serve path must enforce the same archive policy as the upload
  // and background-extract paths. Reject banned entries before indexing.
  try {
    validateZipCentralDirectory(cdData, eocd.cdEntries);
  } catch (error) {
    console.error(`ensureFileInWvfs: ZIP policy violation for post ${postId}:`, error);
    return false;
  }

  const index = parseCentralDirectory(cdData);
  const normalizedPath = normalizePath(filePath);
  let indexEntry = findFileInIndex(index, normalizedPath);
  let resolvedIndexPath = normalizedPath;

  if (!indexEntry) {
    const fileName = normalizedPath.split('/').pop()?.toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const foundPath = findSubdirIndexInIndex(index);
      if (foundPath) {
        const found = index.get(foundPath);
        if (found) {
          indexEntry = found;
          resolvedIndexPath = foundPath;
        }
      }
    }
  }

  if (!indexEntry) return false;

  const fileData = await extractFileFromR2(bucket, zipKey, indexEntry);
  if (!fileData) return false;

  const fileMap = new Map<string, Uint8Array>();
  fileMap.set(resolvedIndexPath, fileData);

  wvfsStorage.set(wvfsBase(postId, versionId), {
    data: fileMap,
    createdAt: Date.now(),
    index,
    zipKey,
  });

  return true;
}

// Lazily extract a single file from a ZIP in R2 without touching the WVFS cache.
// Parses the central directory via range requests, then inflates only the
// requested file. Returns null when the file is not present.
export async function extractFileFromZip(
  bucket: R2Bucket,
  zipKey: string,
  filePath: string,
): Promise<{ data: Uint8Array; resolvedPath: string } | null> {
  const head = await bucket.head(zipKey);
  if (!head) return null;

  const tailSize = Math.min(head.size, 65536);
  const tailObj = await bucket.get(zipKey, { range: { offset: head.size - tailSize, length: tailSize } });
  if (!tailObj) return null;
  const tailData = new Uint8Array(await tailObj.arrayBuffer());

  const eocd = findEocd(tailData);
  if (!eocd) return null;

  const cdObj = await bucket.get(zipKey, { range: { offset: eocd.cdOffset, length: eocd.cdSize } });
  if (!cdObj) return null;
  const cdData = new Uint8Array(await cdObj.arrayBuffer());

  // #80: same archive policy as every other ZIP entry point.
  try {
    validateZipCentralDirectory(cdData, eocd.cdEntries);
  } catch (error) {
    console.error(`extractFileFromZip: ZIP policy violation for ${zipKey}:`, error);
    return null;
  }

  const index = parseCentralDirectory(cdData);
  const normalizedPath = normalizePath(filePath);
  let indexEntry = findFileInIndex(index, normalizedPath);
  let resolvedIndexPath = normalizedPath;

  if (!indexEntry) {
    const fileName = normalizedPath.split('/').pop()?.toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const foundPath = findSubdirIndexInIndex(index);
      if (foundPath) {
        const found = index.get(foundPath);
        if (found) {
          indexEntry = found;
          resolvedIndexPath = foundPath;
        }
      }
    }
  }

  if (!indexEntry) return null;

  const data = await extractFileFromR2(bucket, zipKey, indexEntry);
  if (!data) return null;

  return { data, resolvedPath: resolvedIndexPath };
}

// Full extraction of all files from ZIP data (used for background preload)
export async function extractZipToWvfs(zipData: ArrayBuffer, postId: string): Promise<void> {
  try {
    cleanupExpiredEntries();

    const bytes = new Uint8Array(zipData);
    validateZipStructure(bytes);

    const fflate = await import('fflate');
    const zip = fflate.unzipSync(bytes);

    const fileMap = new Map<string, Uint8Array>();
    for (const [filename, fileData] of Object.entries(zip)) {
      if (filename.endsWith('/')) continue;
      const normalizedName = filename.replace(/^(\.\/)+/, '');
      if (normalizedName) fileMap.set(normalizedName, fileData);
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

export async function serveFileFromWvfs(
  postId: string,
  filePath: string,
  versionId?: string | null,
): Promise<Response | null> {
  cleanupExpiredEntries();

  const entry = wvfsStorage.get(wvfsBase(postId, versionId));
  if (!entry) {
    console.log(`WVFS: No file map found for postId: ${postId}`);
    return null;
  }

  const fileMap = entry.data;

  try {
    const normalizedPath = normalizePath(filePath);
    console.log(`WVFS: Serving ${filePath} -> normalized to ${normalizedPath}`);

    let fileData = findFileInMap(fileMap, normalizedPath);
    let resolvedPath = normalizedPath;

    if (!fileData) {
      const fileName = normalizedPath.split('/').pop()?.toLowerCase();
      if (fileName === 'index.html' || fileName === 'index.htm') {
        const foundPath = findSubdirIndexInMap(fileMap);
        if (foundPath) {
          const found = fileMap.get(foundPath);
          if (found) {
            fileData = found;
            resolvedPath = foundPath;
          }
        }
      }
    }

    if (!fileData) {
      console.log(`WVFS: File not found: ${normalizedPath} (original: ${filePath})`);
      const availableFiles = Array.from(fileMap.keys()).slice(0, 10);
      console.log(`WVFS: Available files: ${availableFiles.join(', ')}`);
      return null;
    }

    const ext = resolvedPath.split('.').pop()?.toLowerCase();

    if (ext === 'html') {
      const cacheKey = `${wvfsBase(postId, versionId)}:${resolvedPath}`;
      let cached = htmlCache.get(cacheKey);
      if (!cached) {
        const htmlContent = new TextDecoder().decode(fileData);
        const withoutCsp = htmlContent.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '');
        const baseSubPath = resolvedPath.includes('/')
          ? resolvedPath.substring(0, resolvedPath.lastIndexOf('/') + 1)
          : '';
        const modifiedHtml = injectBaseTag(withoutCsp, postId, baseSubPath);
        cached = cacheHtml(cacheKey, new TextEncoder().encode(modifiedHtml));
      }
      fileData = cached;
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

function rewriteLocalAbsolutePaths(htmlContent: string): string {
  htmlContent = htmlContent.replace(/(?:(?:src|href)\s*=\s*['"])(\/[^'"]+)(['"])/gi, (match, path, quote) => {
    if (
      path.startsWith('/') &&
      !path.startsWith('//') &&
      !path.startsWith('/https:') &&
      !path.startsWith('/http:') &&
      !path.startsWith('/data:') &&
      !path.startsWith('/blob:') &&
      !path.startsWith('/mailto:') &&
      !path.startsWith('/tel:')
    ) {
      return match.replace(path, path.substring(1));
    }
    return match;
  });

  htmlContent = htmlContent.replace(/srcset\s*=\s*['"]([^'"]+)['"]/gi, (match, value) => {
    const newValue = value.split(',').map((part: string) => {
      const trimmed = part.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (
        url.startsWith('/') &&
        !url.startsWith('//') &&
        !url.startsWith('/https:') &&
        !url.startsWith('/http:') &&
        !url.startsWith('/data:') &&
        !url.startsWith('/blob:')
      ) {
        return [url.substring(1), ...descriptor].join(' ');
      }
      return trimmed;
    });
    return `srcset="${newValue}"`;
  });

  htmlContent = htmlContent.replace(/url\(\s*['"]?\/([^'")\s]+)['"]?\s*\)/gi, (match, path) => {
    if (
      !path.startsWith('/') &&
      !path.startsWith('//') &&
      !path.startsWith('https:') &&
      !path.startsWith('http:') &&
      !path.startsWith('data:') &&
      !path.startsWith('blob:')
    ) {
      return `url("${path}")`;
    }
    return match;
  });

  return htmlContent;
}

export function injectBaseTag(htmlContent: string, postId: string, subPath: string = ''): string {
  // #92: postId/subPath land inside an HTML attribute. Identifiers are
  // server-minted, but a hostile value must never break out of the quote or
  // smuggle String.replace $-patterns into the replacement string.
  const safeId = /^[A-Za-z0-9_-]{1,128}$/.test(postId) ? postId : 'invalid';
  const safeSub = /^[A-Za-z0-9_.\/\-]{0,256}$/.test(subPath) ? subPath.replace(/\$+/g, '') : '';
  const baseUrl = `/api/wvfs-zip/${safeId}/${safeSub}`;
  // ZIP games run with an opaque origin, so storage getters throw and no-CORS
  // images taint canvases. Seed both compatibility shims before game scripts;
  // storage writes still relay to the trusted sandbox-origin broker.
  const storageCompatScript = `<script>(function(){var prefix='FLAXIA_STORAGE_V1:';var initial={};try{if(window.name.indexOf(prefix)===0)initial=JSON.parse(window.name.slice(prefix.length))||{}}catch{}try{window.name=''}catch{}function makeStorage(seed,persistent){var values=new Map(Object.entries(seed));function relay(operation,key,value){if(!persistent)return;try{window.parent.postMessage({type:'FLAXIA_GAME_STORAGE_WRITE',operation:operation,key:key,value:value},'*')}catch{}}return{get length(){return values.size},key:function(index){return Array.from(values.keys())[index]??null},getItem:function(key){key=String(key);return values.has(key)?values.get(key):null},setItem:function(key,value){key=String(key);value=String(value);values.set(key,value);relay('set',key,value)},removeItem:function(key){key=String(key);values.delete(key);relay('remove',key)},clear:function(){values.clear();relay('clear')}}}try{Object.defineProperty(window,'localStorage',{configurable:true,value:makeStorage(initial,true)})}catch{}try{Object.defineProperty(window,'sessionStorage',{configurable:true,value:makeStorage({},false)})}catch{}})();</script>`;
  const imageCorsCompatScript = `<script>${createWvfsImageCorsCompatScript(baseUrl)}</script>`;
  const captureScript = `<script>${CAPTURE_BRIDGE_IIFE}</script>`;
  const injectedScripts = `${storageCompatScript}\n  ${imageCorsCompatScript}\n  ${captureScript}`;

  htmlContent = rewriteLocalAbsolutePaths(htmlContent);

  if (htmlContent.includes('<head>')) {
    return htmlContent.replace(/<head>/i, `<head>\n  <base href="${baseUrl}">\n  ${injectedScripts}`);
  } else if (htmlContent.includes('<meta charset')) {
    return htmlContent.replace(/(<meta charset[^>]*>)/i, `$1\n  <base href="${baseUrl}">\n  ${injectedScripts}`);
  } else {
    return `<base href="${baseUrl}">\n${injectedScripts}\n${htmlContent}`;
  }
}

export async function cleanupWvfsZip(postId: string, versionId?: string | null): Promise<void> {
  cleanupExpiredEntries();
  try {
    wvfsStorage.delete(wvfsBase(postId, versionId));
    const prefix = `${wvfsBase(postId, versionId)}:`;
    for (const key of htmlCache.keys()) {
      if (key.startsWith(prefix)) {
        htmlCache.delete(key);
      }
    }
  } catch (error) {
    console.error('Error cleaning up WVFS:', error);
  }
}

// Extract files from a ZIP into R2 for persistent caching, using range reads
// instead of downloading and inflating the whole archive. Progress is tracked
// in the .wvfs-manifest, so repeated invocations pick up where they left off.
// At most `maxFiles` files are persisted per call to stay under the Workers
// Free plan subrequest limit (50 per invocation).
export async function extractZipToR2(
  bucket: R2Bucket,
  zipKey: string,
  postId: string,
  versionId?: string | null,
  maxFiles: number = DEFAULT_EXTRACT_BUDGET,
): Promise<number> {
  try {
    const head = await bucket.head(zipKey);
    if (!head) {
      console.error(`extractZipToR2: ZIP not found at ${zipKey}`);
      return 0;
    }

    const tailSize = Math.min(head.size, 65536);
    const tailObj = await bucket.get(zipKey, { range: { offset: head.size - tailSize, length: tailSize } });
    if (!tailObj) return 0;
    const tailData = new Uint8Array(await tailObj.arrayBuffer());

    const eocd = findEocd(tailData);
    if (!eocd) return 0;

    const cdObj = await bucket.get(zipKey, { range: { offset: eocd.cdOffset, length: eocd.cdSize } });
    if (!cdObj) return 0;
    const cdData = new Uint8Array(await cdObj.arrayBuffer());

    validateZipCentralDirectory(cdData, eocd.cdEntries);

    const index = parseCentralDirectory(cdData);
    const manifestKey = `${wvfsBase(postId, versionId)}/.wvfs-manifest`;
    const existing = new Set(await readWvfsManifest(bucket, postId, versionId));

    // Deterministic order: extract the earliest files first (index.html + core assets).
    const entries = [...index.entries()].sort((a, b) => a[1].localHeaderOffset - b[1].localHeaderOffset);

    const newFiles: string[] = [];
    const puts: Promise<void>[] = [];

    for (const [fileName, entry] of entries) {
      if (newFiles.length >= maxFiles) break;
      if (existing.has(fileName)) continue;

      const fileData = await extractFileFromR2(bucket, zipKey, entry);
      if (!fileData) continue;

      const r2Key = `${wvfsBase(postId, versionId)}/${fileName}`;
      const contentType = getMimeType(fileName);
      puts.push(
        bucket
          .put(r2Key, fileData, {
            httpMetadata: { contentType },
          })
          .then(() => {}),
      );
      newFiles.push(fileName);
    }

    if (newFiles.length > 0) {
      await Promise.all(puts);
      await bucket.put(manifestKey, JSON.stringify({ files: [...existing, ...newFiles] }), {
        httpMetadata: { contentType: 'application/json' },
      });
    }

    console.log(
      `extractZipToR2: Extracted ${newFiles.length} files for post ${postId} (${existing.size + newFiles.length}/${index.size})`,
    );
    return newFiles.length;
  } catch (error) {
    console.error(`extractZipToR2: Failed for post ${postId}:`, error);
    return 0;
  }
}

// Read the list of files already persisted under wvfs/{postId} (or a version).
async function readWvfsManifest(bucket: R2Bucket, postId: string, versionId?: string | null): Promise<string[]> {
  const manifestObj = await bucket.get(`${wvfsBase(postId, versionId)}/.wvfs-manifest`);
  if (!manifestObj) return [];
  try {
    const manifest = JSON.parse(await manifestObj.text()) as { files?: string[] };
    return Array.isArray(manifest.files) ? manifest.files : [];
  } catch {
    return [];
  }
}

// Copy a raw HTML file from R2 to the WVFS cache as index.html.
// Used for direct HTML uploads (non-ZIP).
export async function copyHtmlToWvfs(bucket: R2Bucket, htmlKey: string, postId: string): Promise<void> {
  try {
    const obj = await bucket.get(htmlKey);
    if (!obj) {
      console.error(`copyHtmlToWvfs: HTML not found at ${htmlKey}`);
      return;
    }
    const r2Key = `${WVFS_R2_PREFIX}${postId}/index.html`;
    const htmlContent = await obj.text();
    await bucket.put(r2Key, htmlContent, {
      httpMetadata: { contentType: 'text/html' },
    });
    await bucket.put(`${WVFS_R2_PREFIX}${postId}/.wvfs-manifest`, JSON.stringify({ files: ['index.html'] }), {
      httpMetadata: { contentType: 'application/json' },
    });
    console.log(`copyHtmlToWvfs: Copied HTML to ${r2Key} for post ${postId}`);
  } catch (error) {
    console.error(`copyHtmlToWvfs: Failed for post ${postId}:`, error);
  }
}

// Persist a single file from the in-memory WVFS cache to R2 (persist-on-access).
// Used after serving a lazily-extracted file so subsequent requests hit the fast
// R2 path without re-extraction. Only a handful of subrequests are needed.
export async function persistFileToWvfsR2(
  bucket: R2Bucket,
  postId: string,
  filePath: string,
  versionId?: string | null,
): Promise<void> {
  try {
    const entry = wvfsStorage.get(wvfsBase(postId, versionId));
    if (!entry) return;

    const normalizedPath = normalizePath(filePath);
    let fileData = findFileInMap(entry.data, normalizedPath);
    let resolvedPath = normalizedPath;

    if (!fileData) {
      const fileName = normalizedPath.split('/').pop()?.toLowerCase();
      if (fileName === 'index.html' || fileName === 'index.htm') {
        const foundPath = findSubdirIndexInMap(entry.data);
        if (foundPath) {
          const found = entry.data.get(foundPath);
          if (found) {
            fileData = found;
            resolvedPath = foundPath;
          }
        }
      }
    }

    if (!fileData) return;

    const r2Key = `${wvfsBase(postId, versionId)}/${resolvedPath}`;
    const contentType = getMimeType(resolvedPath);
    await bucket.put(r2Key, fileData, { httpMetadata: { contentType } });

    const existing = await readWvfsManifest(bucket, postId, versionId);
    if (!existing.includes(resolvedPath)) {
      existing.push(resolvedPath);
      await bucket.put(`${wvfsBase(postId, versionId)}/.wvfs-manifest`, JSON.stringify({ files: existing }), {
        httpMetadata: { contentType: 'application/json' },
      });
    }
  } catch (error) {
    console.error(`persistFileToWvfsR2: Failed for post ${postId}, path ${filePath}:`, error);
  }
}

// Serve a file from the pre-extracted R2 cache.
// Returns null if the file is not yet extracted (caller should fall back to on-the-fly).
export async function serveFileFromR2(
  bucket: R2Bucket,
  postId: string,
  filePath: string,
  versionId?: string | null,
): Promise<Response | null> {
  try {
    const normalizedPath = normalizePath(filePath);
    const baseKey = `${wvfsBase(postId, versionId)}/`;

    const r2Key = baseKey + normalizedPath;
    let obj = await bucket.get(r2Key);

    if (!obj && !normalizedPath.endsWith('/')) {
      obj = await bucket.get(baseKey + normalizedPath + '/index.html');
    }

    if (!obj) {
      obj = await bucket.get(baseKey + './' + normalizedPath);
    }

    let resolvedPath = normalizedPath;

    if (!obj) {
      const fileName = normalizedPath.split('/').pop()?.toLowerCase();
      if (fileName === 'index.html' || fileName === 'index.htm') {
        const manifestObj = await bucket.get(baseKey + '.wvfs-manifest');
        if (manifestObj) {
          try {
            const manifest = JSON.parse(await manifestObj.text()) as { files: string[] };
            const indexFiles = manifest.files.filter((f: string) => {
              const name = f.split('/').pop()?.toLowerCase();
              return name === 'index.html' || name === 'index.htm';
            });
            indexFiles.sort((a: string, b: string) => {
              const depthA = (a.match(/\//g) || []).length;
              const depthB = (b.match(/\//g) || []).length;
              return depthA - depthB;
            });
            if (indexFiles.length > 0) {
              obj = await bucket.get(baseKey + indexFiles[0]);
              resolvedPath = indexFiles[0];
            }
          } catch {
            // manifest parse failed, fall through
          }
        }
      }
    }

    if (!obj) return null;

    const contentType = getMimeType(resolvedPath);
    const ext = resolvedPath.split('.').pop()?.toLowerCase();

    if (ext === 'html') {
      const cacheKey = `${wvfsBase(postId, versionId)}:${resolvedPath}`;
      let cached = htmlCache.get(cacheKey);
      if (cached) {
        return new Response(new Uint8Array(cached), {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const htmlContent = await obj.text();
      const withoutCsp = htmlContent.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '');
      const baseSubPath = resolvedPath.includes('/')
        ? resolvedPath.substring(0, resolvedPath.lastIndexOf('/') + 1)
        : '';
      const modifiedHtml = injectBaseTag(withoutCsp, postId, baseSubPath);
      cached = cacheHtml(cacheKey, new TextEncoder().encode(modifiedHtml));
      return new Response(new Uint8Array(cached), {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return new Response(obj.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error(`serveFileFromR2: Error for post ${postId}, path ${filePath}:`, error);
    return null;
  }
}
