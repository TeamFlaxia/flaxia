// Lightweight Studio host used before the Studio UI loads.
//
// Vault rotation must re-wrap Studio's local project keys even when the user
// never opened /studio this session, so this adapter intentionally pulls in
// only the vault and translations. Other Studio services are installed by the
// full adapter in studio-host.ts when the workspace mounts.
import type { StudioHost } from '@flaxia/studio/host';
import { t } from './i18n.js';
import {
  decryptVaultItem,
  deriveVaultKeBits,
  encryptVaultItem,
  rewrapItemKeyForVaultKey,
  VAULT_KDF_ITERATIONS,
  VAULT_SALT_BYTES,
} from './vault/primitives.js';
import { getVaultKey, tryDeviceUnlock } from './vault/session.js';

const unavailable = (): never => {
  throw new Error('Studio UI is not loaded');
};

export function createStudioVaultHost(): StudioHost {
  return {
    t,
    vault: {
      getKey: getVaultKey,
      tryUnlock: tryDeviceUnlock,
      encryptItem: encryptVaultItem,
      decryptItem: decryptVaultItem,
      rewrapItemKey: rewrapItemKeyForVaultKey,
      deriveKeyBits: (passphrase, salt) =>
        deriveVaultKeBits(passphrase, salt, { alg: 'PBKDF2-SHA256', iterations: VAULT_KDF_ITERATIONS }),
      saltBytes: VAULT_SALT_BYTES,
      kdfIterations: VAULT_KDF_ITERATIONS,
    },
    zip: {
      previewZipFile: async () => unavailable(),
      validateArchive: () => unavailable(),
    },
    flash: { executeFlash: async () => unavailable() },
    media: { openEditor: async () => unavailable() },
    handoff: { save: () => unavailable() },
  };
}
