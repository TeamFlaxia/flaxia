<script lang="ts">
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.ts';

export interface Props {
  onAccept: () => void;
  onReject: () => void;
  onDismiss?: () => void;
}

let { onAccept, onReject, onDismiss }: Props = $props();

let unregister: (() => void) | null = null;
let settled = false;

function close(): void {
  unregister?.();
  unregister = null;
  window.removeEventListener('keydown', onKeydown);
  onDismiss?.();
}

function finish(accepted: boolean): void {
  if (settled) return;
  settled = true;
  close();
  if (accepted) onAccept();
  else onReject();
}

function dismiss(): void {
  if (settled) return;
  settled = true;
  close();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') dismiss();
}

onMount(() => {
  unregister = registerModal();
  window.addEventListener('keydown', onKeydown);
  return () => {
    unregister?.();
    window.removeEventListener('keydown', onKeydown);
  };
});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="crowd-consent-overlay"
  style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1100;"
  onclick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
>
  <div
    class="crowd-consent-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="crowd-consent-title"
    style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:24px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;"
  >
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="crowd-consent-title" style="margin:0;font-size:18px;color:var(--text-primary);">{t('crowd.consent_title')}</h3>
      <button
        type="button"
        class="crowd-consent-close"
        aria-label={t('common.close')}
        style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;line-height:1;"
        onclick={dismiss}>✕</button>
    </div>
    <p style="margin:0 0 12px;color:var(--text-primary);font-size:14px;line-height:1.6;">{t('crowd.consent_body')}</p>
    <p style="margin:0 0 20px;color:var(--text-muted);font-size:12px;line-height:1.6;">
      {t('crowd.consent_note')}
      <a href="/privacy" target="_blank" rel="noopener noreferrer" style="color:var(--accent-text);">{t('crowd.consent_privacy_link')}</a>
    </p>
    <div style="display:flex;justify-content:flex-end;gap:12px;">
      <button
        type="button"
        class="crowd-consent-reject"
        style="padding:10px 20px;border-radius:9999px;font-size:14px;cursor:pointer;font-family:inherit;background:transparent;border:1px solid var(--border);color:var(--text-primary);"
        onclick={() => finish(false)}>{t('crowd.consent_reject')}</button>
      <button
        type="button"
        class="crowd-consent-accept"
        style="padding:10px 20px;border-radius:9999px;font-size:14px;cursor:pointer;font-family:inherit;background:var(--accent);border:none;color:var(--on-accent);font-weight:600;"
        onclick={() => finish(true)}>{t('crowd.consent_accept')}</button>
    </div>
  </div>
</div>
