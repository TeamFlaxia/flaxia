import JSZip from 'jszip';
import { validateGameZipArchive } from '../zip-executor.ts';

const MAX_EDITABLE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_EDITABLE_GAME_BYTES = 200 * 1024 * 1024;
const EDITABLE_SOURCE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'glsl', 'wgsl', 'rsp']);

export interface EditableGameSource {
  path: string;
  source: string;
}

export interface EditableGameSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

function isEditableSource(path: string): boolean {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return EDITABLE_SOURCE_EXTENSIONS.has(extension);
}

/** Normalize and validate a source path that can safely be added to a game package. */
export function validateEditableGameSourcePath(requestedPath: string): string {
  const path = requestedPath.trim();
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  const segments = path.split('/');
  if (
    !path ||
    path.length > 255 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    hasControlCharacter ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments.length - 1 > 10 ||
    !isEditableSource(path)
  ) {
    throw new Error('Use a relative .html, .css, .js, .mjs, .json, .txt, .glsl, .wgsl, or .rsp source path');
  }
  return path;
}

/** Search project sources case-insensitively and return the first match on each line. */
export function searchEditableGameSources(
  sources: Iterable<EditableGameSource>,
  query: string,
  maxResults = 200,
): EditableGameSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !Number.isInteger(maxResults) || maxResults < 1) return [];
  const matches: EditableGameSearchMatch[] = [];
  search: for (const source of sources) {
    const lines = source.source.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const column = line.toLowerCase().indexOf(needle);
      if (column < 0) continue;
      matches.push({ path: source.path, line: index + 1, column: column + 1, preview: line.trim().slice(0, 180) });
      if (matches.length >= maxResults) break search;
    }
  }
  return matches;
}

/** List text sources in a validated ZIP game package for safe in-Studio editing. */
export async function listEditableGameSources(file: File): Promise<EditableGameSource[]> {
  const bytes = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  validateGameZipArchive(zip);
  const sources: EditableGameSource[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !isEditableSource(path)) continue;
    const source = await entry.async('string');
    if (new TextEncoder().encode(source).byteLength > MAX_EDITABLE_SOURCE_BYTES) continue;
    sources.push({ path, source });
  }
  return sources.sort((left, right) => {
    const leftIndex = /(^|\/)index\.html?$/i.test(left.path) ? 0 : 1;
    const rightIndex = /(^|\/)index\.html?$/i.test(right.path) ? 0 : 1;
    return leftIndex - rightIndex || left.path.localeCompare(right.path);
  });
}

/** Apply source edits to their original paths and return a replacement ZIP File. */
export async function updateEditableGameSources(
  file: File,
  edits: Map<string, string>,
  createdPaths: ReadonlySet<string> = new Set(),
): Promise<File> {
  if (edits.size === 0) return file;
  const bytes = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  validateGameZipArchive(zip);
  for (const [path, source] of edits) {
    let safePath: string;
    try {
      safePath = validateEditableGameSourcePath(path);
    } catch {
      throw new Error(`Cannot edit game file: ${path}`);
    }
    const entry = zip.file(safePath);
    if (entry?.dir || (createdPaths.has(safePath) && entry) || (!entry && !createdPaths.has(safePath))) {
      throw new Error(`Cannot edit game file: ${path}`);
    }
    if (new TextEncoder().encode(source).byteLength > MAX_EDITABLE_SOURCE_BYTES) {
      throw new Error(`${safePath} exceeds the 2 MB source file limit`);
    }
    zip.file(safePath, source);
  }
  validateGameZipArchive(zip);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (blob.size > MAX_EDITABLE_GAME_BYTES) throw new Error('The edited game package exceeds 200 MB');
  return new File([blob], file.name, { type: 'application/zip', lastModified: Date.now() });
}
