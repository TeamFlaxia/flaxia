import { primaryAddressForUsername } from '../../../shared/mail-address.ts';
import { ensureVaultUnlocked, provisionMailIdentity } from '../vault/mail-identity.js';
import { isVaultUnlocked } from '../vault/session.js';

export async function activateMailAddress(username: string): Promise<string> {
  const unlocked = await ensureVaultUnlocked();
  if (!unlocked || !isVaultUnlocked()) throw new Error('mail_vault_required');
  const identity = await provisionMailIdentity(1);
  const { activateAddress } = await import('./api.js');
  await activateAddress({ publicKey: identity.publicKeySpkiB64, keyVersion: 1, vaultUnlocked: true });
  return primaryAddressForUsername(username);
}
