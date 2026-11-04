// Installs the lightweight Studio host and connects vault rotation to Studio's
// encrypted local project store before any Studio UI is opened.
import { configureStudioHost } from '@flaxia/studio/host';
import { rewrapStudioProjectKey } from '@flaxia/studio/vault';
import { createStudioVaultHost } from './studio-vault-host.js';
import { onVaultRekey } from './vault/session.js';

configureStudioHost(createStudioVaultHost());
onVaultRekey((oldVaultKey, newVaultKey) => rewrapStudioProjectKey(oldVaultKey, newVaultKey));
