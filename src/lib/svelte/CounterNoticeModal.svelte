<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { buildCounterNoticePayload, isCounterNoticeValid } from '../modals/dialog-logic.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';
import { showToast } from '../toast.ts';

interface Props {
  postId: string;
  onClose: () => void;
}

let { postId, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let name = $state('');
let email = $state('');
let address = $state('');
let phone = $state('');
let statement = $state(false);
let consent = $state(false);

const valid = $derived(isCounterNoticeValid({ name, email, address, phone, statement, consent }));

const fieldStyle =
  'width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;';
const labelStyle = 'display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);';

async function submitCounterNotice(): Promise<void> {
  const payload = buildCounterNoticePayload({ name, email, address, phone, statement, consent });
  try {
    const response = await fetch(`/api/posts/${postId}/counter-notice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    if (response.status === 409) {
      showToast(t('post.counter_notice_already'));
      return;
    }

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData?.error || 'Failed to submit counter-notice');
    }

    showToast(t('post.counter_notice_submitted'));
  } catch (error) {
    console.error('Counter-notice error:', error);
    showToast(t('post.counter_notice_failed'), true);
  }
}

function handleSubmit(): void {
  if (!valid) return;
  controller?.close();
  void submitCounterNotice();
}

onMount(() => {
  controller = attachModalBehavior({
    overlay: overlayEl,
    dialog: dialogEl,
    onClose,
    animated: true,
  });
  return () => controller?.destroy();
});
</script>

<div
  class="fx-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) controller?.close();
  }}
>
  <div
    class="fx-dialog"
    bind:this={dialogEl}
    style="--fx-dialog-max-width: 520px;"
    role="dialog"
    aria-modal="true"
    aria-labelledby="counter-notice-title"
    tabindex="-1"
  >
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 id="counter-notice-title" style="margin: 0; font-size: 18px; color: var(--text-primary);">
        {t('post.counter_notice_title')}
      </h3>
      <button
        class="close-btn"
        style="background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer;"
        onclick={() => controller?.close()}>✕</button
      >
    </div>
    <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">
      {t('post.counter_notice_explanation')}
    </p>
    <div style="margin-bottom: 16px;">
      <label for="cn-name" style={labelStyle}>{t('post.counter_notice_name_label')}</label>
      <input
        id="cn-name"
        type="text"
        class="cn-name"
        style={fieldStyle}
        placeholder={t('post.counter_notice_name_placeholder')}
        bind:value={name}
      />
    </div>
    <div style="margin-bottom: 16px;">
      <label for="cn-email" style={labelStyle}>{t('post.counter_notice_email_label')}</label>
      <input
        id="cn-email"
        type="email"
        class="cn-email"
        style={fieldStyle}
        placeholder={t('post.counter_notice_email_placeholder')}
        bind:value={email}
      />
    </div>
    <div style="margin-bottom: 16px;">
      <label for="cn-address" style={labelStyle}>{t('post.counter_notice_address_label')}</label>
      <input
        id="cn-address"
        type="text"
        class="cn-address"
        style={fieldStyle}
        placeholder={t('post.counter_notice_address_placeholder')}
        bind:value={address}
      />
    </div>
    <div style="margin-bottom: 16px;">
      <label for="cn-phone" style={labelStyle}>{t('post.counter_notice_phone_label')}</label>
      <input
        id="cn-phone"
        type="tel"
        class="cn-phone"
        style={fieldStyle}
        placeholder={t('post.counter_notice_phone_placeholder')}
        bind:value={phone}
      />
    </div>
    <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer;">
      <input type="checkbox" class="cn-statement" style="margin-top: 2px;" bind:checked={statement} />
      <span style="font-size: 12px; color: var(--text-muted);">{t('post.counter_notice_statement')}</span>
    </label>
    <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; cursor: pointer;">
      <input type="checkbox" class="cn-consent" style="margin-top: 2px;" bind:checked={consent} />
      <span style="font-size: 12px; color: var(--text-muted);">{t('post.counter_notice_consent')}</span>
    </label>
    <div style="display: flex; justify-content: flex-end;">
      <button
        class="submit-btn"
        disabled={!valid}
        style="padding: 10px 24px; background: var(--accent); border: none; border-radius: 9999px; color: #000; font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; cursor: pointer;"
        style:opacity={valid ? '1' : '0.5'}
        onclick={handleSubmit}
      >
        {t('common.submit')}
      </button>
    </div>
  </div>
</div>
