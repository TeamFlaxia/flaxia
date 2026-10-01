import JSZip from 'jszip';
import { validateGameZipArchive } from '../zip-executor.ts';

const MAX_EDITABLE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_EDITABLE_GAME_BYTES = 200 * 1024 * 1024;
const EDITABLE_SOURCE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'glsl', 'wgsl', 'rsp']);

export interface EditableGameSource {
  path: string;
  source: string;
}

function isEditableSource(path: string): boolean {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return EDITABLE_SOURCE_EXTENSIONS.has(extension);
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
export async function updateEditableGameSources(file: File, edits: Map<string, string>): Promise<File> {
  if (edits.size === 0) return file;
  const bytes = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  validateGameZipArchive(zip);
  for (const [path, source] of edits) {
    const entry = zip.file(path);
    if (!entry || entry.dir || !isEditableSource(path)) throw new Error(`Cannot edit game file: ${path}`);
    if (new TextEncoder().encode(source).byteLength > MAX_EDITABLE_SOURCE_BYTES) {
      throw new Error(`${path} exceeds the 2 MB source file limit`);
    }
    zip.file(path, source);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (blob.size > MAX_EDITABLE_GAME_BYTES) throw new Error('The edited game package exceeds 200 MB');
  return new File([blob], file.name, { type: 'application/zip', lastModified: Date.now() });
}
