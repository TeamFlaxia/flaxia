import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vaultUnlockFailureKey, vaultUnlockView } from '../../src/lib/settings/vault-unlock-state.ts';

describe('settings/vault-unlock-state', () => {
  it('shows the waiting state until the key status resolves', () => {
    assert.equal(vaultUnlockView(null, false), 'loading');
  });

  it('shows a retry state when the key status request fails', () => {
    assert.equal(vaultUnlockView(null, true), 'error');
    assert.equal(vaultUnlockView(true, true), 'error');
  });

  it('shows the setup pointer when the vault is disabled', () => {
    assert.equal(vaultUnlockView(false, false), 'unavailable');
  });

  it('shows the password form when the vault is enabled', () => {
    assert.equal(vaultUnlockView(true, false), 'locked');
  });

  it('maps unlock failures onto the existing settings messages', () => {
    assert.equal(vaultUnlockFailureKey('wrong'), 'settings.vault_wrong_password');
    assert.equal(vaultUnlockFailureKey('network'), 'settings.network_error');
    assert.equal(vaultUnlockFailureKey('error'), 'settings.vault_error');
  });
});
