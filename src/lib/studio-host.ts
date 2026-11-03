// Full Studio host adapter. Imported only when /studio mounts, so the heavy
// media, Flash, and ZIP services stay out of the startup bundle.
import type { StudioHost } from '@flaxia/studio/host';
import { executeFlash } from '../components/FlashPlayer.js';
import { openMediaEditor } from '../components/MediaEditorModal.js';
import { saveStudioHandoff } from './editor/studio-handoff.js';
import { createStudioVaultHost } from './studio-vault-host.js';
import { previewZipFile, validateGameZipArchive } from './zip-executor.js';

export function createStudioHost(): StudioHost {
  const base = createStudioVaultHost();
  return {
    ...base,
    zip: {
      previewZipFile: (file, container, options) =>
        previewZipFile(file, container, options as Parameters<typeof previewZipFile>[2]),
      validateArchive: (zip) => validateGameZipArchive(zip as Parameters<typeof validateGameZipArchive>[0]),
    },
    flash: { executeFlash },
    media: { openEditor: openMediaEditor },
    handoff: { save: saveStudioHandoff },
  };
}
