<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { createSrpProof as srpProofFor } from '../auth-srp.js';
import { t } from '../i18n.ts';

let currentPassword = $state('');
let newEmail = $state('');
let message = $state('');
let tone = $state<'accent' | 'danger'>('accent');
let saving = $state(false);

async function save(): Promise<void> {
  const current = currentPassword.trim();
  const email = newEmail.trim();

  if (!current || !email) {
    message = t('settings.email_fill_all');
    tone = 'danger';
    return;
  }

  message = '';
  saving = true;
  try {
    const proof = await srpProofFor(current);
    if (!proof) {
      message = t('settings.current_password_incorrect');
      tone = 'danger';
      return;
    }

    const response = await fetch('/api/users/me/email', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_srp: proof, new_email: email }),
    });

    if (response.ok) {
      message = t('settings.email_saved');
      tone = 'accent';
      currentPassword = '';
      newEmail = '';
    } else {
      const errorData = (await response.json()) as { error?: string };
      message = errorData.error || t('settings.email_save_failed');
      tone = 'danger';
    }
  } catch {
    message = t('settings.email_network_error');
    tone = 'danger';
  } finally {
    saving = false;
  }
}
</script>

<h2>{t('settings.change_email')}</h2>
<label class="settings-label" for="settings-email-current-password">{t('settings.email_current_password')}</label>
<input
  class="settings-input"
  id="settings-email-current-password"
  type="password"
  autocomplete="current-password"
  placeholder={t('settings.email_current_password_placeholder')}
  bind:value={currentPassword}
/>
<label class="settings-label" for="settings-new-email">{t('settings.email_new_email')}</label>
<input
  class="settings-input"
  id="settings-new-email"
  type="email"
  autocomplete="email"
  placeholder={t('settings.email_new_email_placeholder')}
  bind:value={newEmail}
/>
<button class="settings-save" disabled={saving} style:opacity={saving ? '0.6' : undefined} onclick={() => void save()}>
  {t('common.save')}
</button>
<div
  class="settings-status"
  role="status"
  style:color={message ? (tone === 'accent' ? 'var(--accent-text)' : 'var(--danger-text)') : undefined}
>
  {message}
</div>
