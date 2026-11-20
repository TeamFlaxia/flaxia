<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import { t } from '../../lib/i18n.ts';

let {
  // biome-ignore lint/correctness/noUnusedVariables: used in markup
  subtitle,
  // biome-ignore lint/correctness/noUnusedVariables: used in markup
  onSignIn,
  // biome-ignore lint/correctness/noUnusedVariables: used in markup
  onSignUp,
  onClose,
}: {
  subtitle: string;
  onSignIn: () => void;
  onSignUp: () => void;
  onClose: () => void;
} = $props();

// biome-ignore lint/correctness/noUnusedVariables: used in markup
function close(): void {
  onClose();
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="signin-prompt-overlay"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div class="signin-prompt-dialog" role="dialog" aria-modal="true">
    <div class="signin-prompt-badge" aria-hidden="true">
      <img src="/favicon.ico" alt="" width="40" height="40" />
    </div>
    <h3 class="signin-prompt-title fx-display">{t('auth.sign_up_title')}</h3>
    <p class="signin-prompt-subtitle">{subtitle}</p>
    <div class="signin-prompt-actions">
      <button class="signin-btn signin-prompt-primary" type="button" onclick={onSignUp}>
        {t('auth.sign_up')}
      </button>
      <button class="signup-btn signin-prompt-secondary" type="button" onclick={onSignIn}>
        {t('auth.sign_in')}
      </button>
    </div>
  </div>
</div>
