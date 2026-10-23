import { unzipSync } from 'fflate';
import {
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MAX_ZIP_BYTES,
  mimeType,
  validateFiles,
  validatePath,
} from '../../sandbox/game-loader/protocol.js';

self.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
  try {
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_ZIP_BYTES)
      throw new Error('ZIP exceeds 25 MB');
    let total = 0;
    let count = 0;
    const seen = new Set<string>();
    const unpacked = unzipSync(new Uint8Array(event.data), {
      filter(file) {
        if (++count > MAX_FILES) throw new Error('Too many ZIP entries');
        if (file.name.endsWith('/')) {
          if (!validatePath(file.name.slice(0, -1))) throw new Error('Invalid ZIP directory');
          return false;
        }
        if (!validatePath(file.name) || !mimeType(file.name)) throw new Error('Unsupported ZIP path or file type');
        if (seen.has(file.name)) throw new Error('Duplicate ZIP entry');
        seen.add(file.name);
        total += file.originalSize;
        if (total > MAX_TOTAL_BYTES) throw new Error('Expanded ZIP exceeds 100 MB');
        return true;
      },
    });
    const files = Object.entries(unpacked).map(([path, bytes]) => ({ path, bytes: new Uint8Array(bytes).buffer }));
    const entry = validateFiles(files);
    self.postMessage({ ok: true, files, entry }, { transfer: files.map((file) => file.bytes) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'ZIP extraction failed' });
  }
});
