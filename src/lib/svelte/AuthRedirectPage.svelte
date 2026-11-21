<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { startAuthRedirect } from './auth-start.ts';

let { mode }: { mode: 'login' | 'register' } = $props();

// auth-redirect.ts sends failures back here as `/login?error=…`. Redirecting
// again would loop through auth.flaxia.app, so show the failure instead.
const error = $derived(page.url.searchParams.get('error'));
let started = false;

onMount(() => {
  if (error) return;
  started = true;
  void startAuthRedirect(mode);
});

function retry(): void {
  void startAuthRedirect(mode);
}
</script>

{#if error}
  <div class="auth-redirect-page">
    <p class="auth-redirect-message">{t('auth.sign_in_failed')}</p>
    <div class="auth-redirect-actions">
      <button type="button" class="mail-button mail-button--primary" onclick={retry}>
        {t('auth.try_again')}
      </button>
      <button type="button" class="mail-button" onclick={() => void navigate('/home')}>
        {t('auth.back_home')}
      </button>
    </div>
  </div>
{:else if !started}
  <div class="auth-redirect-page">
    <p class="auth-redirect-message">{t('common.loading')}</p>
  </div>
{/if}
