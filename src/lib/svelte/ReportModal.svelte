<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { ReportCategory } from '../../../shared/types/post.ts';
import { t } from '../i18n.ts';
import {
  buildReportPayload,
  isReportSubmitEnabled,
  plainReportLabel,
  REPORT_CATEGORIES,
} from '../modals/dialog-logic.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';
import { iconHtml } from '../post/icon-html.ts';
import { showToast } from '../toast.ts';

interface Props {
  postId: string;
  onClose: () => void;
}

let { postId, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let selectedCategory = $state<ReportCategory | null>(null);
let dmcaWork = $state('');
let dmcaEmail = $state('');
let dmcaSworn = $state(false);

const submitEnabled = $derived(
  isReportSubmitEnabled(selectedCategory, { work: dmcaWork, email: dmcaEmail, sworn: dmcaSworn }),
);
const showDmca = $derived(selectedCategory === 'copyright');

async function submitReport(category: ReportCategory): Promise<void> {
  const body = buildReportPayload(postId, category, {
    work: dmcaWork,
    email: dmcaEmail,
    sworn: dmcaSworn,
  });
  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (response.status === 409) {
      showToast(t('post.report_already'));
      return;
    }

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData?.error || 'Failed to submit report');
    }

    showToast(t('post.report_submitted'));
  } catch (error) {
    console.error('Report error:', error);
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : 'No stack trace',
      post_id: postId,
      category,
    });
    showToast(t('post.report_failed'), true);
  }
}

function handleSubmit(): void {
  if (!selectedCategory || !submitEnabled) return;
  const category = selectedCategory;
  controller?.close();
  void submitReport(category);
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
    aria-labelledby="report-modal-title"
    tabindex="-1"
  >
    <div class="fx-report">
      <div class="fx-report__head">
        <div>
          <h3 class="fx-report__title" id="report-modal-title">{plainReportLabel(t('post.report_title'))}</h3>
          <p class="fx-report__question">{t('post.report_question')}</p>
        </div>
        <button
          type="button"
          class="fx-icon-btn fx-report__close"
          aria-label={t('common.close')}
          onclick={() => controller?.close()}
        >
          <span class="action-icon">{@html iconHtml('close')}</span>
        </button>
      </div>
      <fieldset class="fx-report__cats">
        <legend class="fx-visually-hidden">{t('post.report_question')}</legend>
        {#each REPORT_CATEGORIES as category (category.value)}
          <label class="fx-report__card" class:is-selected={selectedCategory === category.value}>
            <input
              class="fx-report__radio"
              type="radio"
              name="report-category"
              value={category.value}
              bind:group={selectedCategory}
            />
            <span class="fx-report__card-label">{t(category.labelKey)}</span>
            <span class="fx-report__card-check" aria-hidden="true"></span>
          </label>
        {/each}
      </fieldset>
      <div class="fx-report__dmca" hidden={!showDmca}>
        <h4 class="fx-report__title" style="font-size: 0.875rem;">{t('post.report_dmca_title')}</h4>
        <div class="fx-report__field">
          <label for="report-dmca-work">{t('post.report_dmca_work_label')}</label>
          <textarea
            id="report-dmca-work"
            class="fx-report__textarea dmca-work"
            rows="3"
            placeholder={t('post.report_dmca_work_placeholder')}
            bind:value={dmcaWork}
          ></textarea>
        </div>
        <div class="fx-report__field">
          <label for="report-dmca-email">{t('post.report_dmca_email_label')}</label>
          <input
            id="report-dmca-email"
            class="fx-report__input dmca-email"
            type="email"
            placeholder={t('post.report_dmca_email_placeholder')}
            bind:value={dmcaEmail}
          />
        </div>
        <label class="fx-report__check">
          <input class="fx-report__checkbox dmca-sworn" type="checkbox" bind:checked={dmcaSworn} />
          <span>{t('post.report_dmca_swear')}</span>
        </label>
      </div>
      <div class="fx-report__actions">
        <button
          type="button"
          class="fx-btn fx-btn--primary fx-report__submit submit-btn"
          disabled={!submitEnabled}
          onclick={handleSubmit}
        >
          {t('common.submit')}
        </button>
      </div>
    </div>
  </div>
</div>
