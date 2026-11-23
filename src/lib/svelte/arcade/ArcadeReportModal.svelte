<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import { submitArcadeReport } from '../../arcade/actions.ts';
import { t } from '../../i18n.ts';
import { registerModal } from '../../modal-state.ts';
import { iconHtml } from '../../post/icon-html.ts';
import { showToast } from '../../toast.ts';

interface Props {
  postId: string;
  onClose: () => void;
}

let { postId, onClose }: Props = $props();

const categories = $derived([
  { value: 'spam', label: t('post.report_category_spam') },
  { value: 'harassment', label: t('post.report_category_harassment') },
  { value: 'hate_speech', label: t('post.report_category_hate_speech') },
  { value: 'inappropriate', label: t('post.report_category_inappropriate') },
  { value: 'misinformation', label: t('post.report_category_misinformation') },
  { value: 'privacy', label: t('post.report_category_privacy') },
  { value: 'copyright', label: t('post.report_category_copyright') },
  { value: 'malware', label: t('post.report_category_malware') },
  { value: 'csam', label: t('post.report_category_csam') },
  { value: 'nsfw_untagged', label: t('post.report_category_nsfw_untagged') },
  { value: 'other', label: t('post.report_category_other') },
]);

let selected = $state<string | null>(null);
let dmcaWork = $state('');
let dmcaEmail = $state('');
let dmcaSworn = $state(false);
let submitting = $state(false);

const isCopyright = $derived(selected === 'copyright');
const canSubmit = $derived(
  Boolean(selected) && (!isCopyright || (dmcaWork.trim().length > 0 && dmcaEmail.trim().length > 0 && dmcaSworn)),
);

let unregister: (() => void) | null = null;

onMount(() => {
  unregister = registerModal();
  return () => {
    unregister?.();
    unregister = null;
  };
});

async function submit(): Promise<void> {
  if (!selected || !canSubmit || submitting) return;
  submitting = true;
  try {
    const result = await submitArcadeReport(
      postId,
      selected,
      isCopyright
        ? {
            work_description: dmcaWork.trim(),
            reporter_email: dmcaEmail.trim(),
            sworn: dmcaSworn,
          }
        : undefined,
    );
    if (result === 'duplicate') {
      showToast(t('post.report_already'));
      onClose();
      return;
    }
    showToast(t('post.report_submitted'));
    onClose();
  } catch (error) {
    console.error('Report error:', error);
    showToast(t('post.report_failed'), true);
  } finally {
    submitting = false;
  }
}
</script>

<div
  class="arcade-report-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="arcade-report-dialog" role="dialog" aria-modal="true" aria-labelledby="arcade-report-title">
    <div class="arcade-report-header">
      <h3 id="arcade-report-title">{t('arcade.report_title')}</h3>
      <button type="button" class="arcade-report-close" aria-label={t('common.close')} onclick={onClose}>
        {@html iconHtml('close', 18)}
      </button>
    </div>
    <p class="arcade-report-question">{t('post.report_question')}</p>

    <div class="arcade-report-categories">
      {#each categories as category (category.value)}
        <label class="arcade-report-category">
          <input type="radio" name="report-category" value={category.value} bind:group={selected} />
          <span>{category.label}</span>
        </label>
      {/each}
    </div>

    {#if isCopyright}
      <div class="arcade-dmca">
        <h4>{t('post.report_dmca_title')}</h4>
        <label class="arcade-dmca-field">
          <span>{t('post.report_dmca_work_label')}</span>
          <input
            type="text"
            bind:value={dmcaWork}
            placeholder={t('post.report_dmca_work_placeholder')}
          />
        </label>
        <label class="arcade-dmca-field">
          <span>{t('post.report_dmca_email_label')}</span>
          <input
            type="email"
            bind:value={dmcaEmail}
            placeholder={t('post.report_dmca_email_placeholder')}
          />
        </label>
        <label class="arcade-dmca-sworn">
          <input type="checkbox" bind:checked={dmcaSworn} />
          <span>{t('post.report_dmca_swear')}</span>
        </label>
      </div>
    {/if}

    <div class="arcade-report-footer">
      <button type="button" class="arcade-report-submit" disabled={!canSubmit || submitting} onclick={submit}>
        {t('common.submit')}
      </button>
    </div>
  </div>
</div>

<style>
  .arcade-report-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .arcade-report-dialog {
    box-sizing: border-box;
    width: 90%;
    max-width: 420px;
    max-height: 80vh;
    padding: 24px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .arcade-report-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .arcade-report-header h3 {
    margin: 0;
    font-size: 18px;
  }

  .arcade-report-close {
    display: inline-flex;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .arcade-report-question {
    margin: 0 0 16px;
    color: var(--text-muted);
    font-size: 14px;
  }

  .arcade-report-categories {
    margin-bottom: 24px;
  }

  .arcade-report-category {
    display: flex;
    align-items: center;
    padding: 10px 0;
    color: var(--text-primary);
    cursor: pointer;
  }

  .arcade-report-category input {
    margin-right: 12px;
  }

  .arcade-dmca {
    margin-bottom: 24px;
    padding: 16px;
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .arcade-dmca h4 {
    margin: 0 0 12px;
    font-size: 14px;
  }

  .arcade-dmca-field {
    display: block;
    margin-bottom: 12px;
    color: var(--text-muted);
    font-size: 12px;
  }

  .arcade-dmca-field span {
    display: block;
    margin-bottom: 4px;
  }

  .arcade-dmca-field input {
    box-sizing: border-box;
    width: 100%;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 14px;
  }

  .arcade-dmca-sworn {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .arcade-report-footer {
    display: flex;
    justify-content: flex-end;
  }

  .arcade-report-submit {
    padding: 10px 24px;
    border: 0;
    border-radius: 9999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 14px;
    cursor: pointer;
  }

  .arcade-report-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
