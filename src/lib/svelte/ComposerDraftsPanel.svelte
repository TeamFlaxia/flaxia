<script lang="ts">
import { confirmDeleteAllDrafts } from '../composer/drafts-confirm.ts';
import { t } from '../i18n.ts';
import { iconHtml } from '../post/icon-html.ts';

export interface Draft {
  id: string;
  text: string;
  savedAt: number;
}

let {
  drafts = [],
  onSave,
  onLoad,
  onDelete,
  onDeleteAll,
}: {
  drafts?: Draft[];
  onSave: () => void;
  onLoad: (draft: Draft) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
} = $props();

function ageLabel(savedAt: number): string {
  const minutes = Math.floor((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return t('time.just_now');
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d` : `${hours}h`;
}

async function confirmDeleteAll(): Promise<void> {
  const confirmed = await confirmDeleteAllDrafts();
  if (confirmed) onDeleteAll();
}
</script>

<div class="post-modal-drafts">
  <div class="post-modal-drafts-head">
    <div class="post-modal-drafts-title">
      {t('composer.list_drafts')}{drafts.length > 0 ? ` (${drafts.length})` : ''}
    </div>
    <div class="post-modal-drafts-actions">
      <button
        type="button"
        class="post-modal-drafts-save"
        onmousedown={(event) => event.preventDefault()}
        onclick={onSave}
      >
        {t('composer.save_draft')}
      </button>
      <button
        type="button"
        class="post-modal-drafts-delete-all"
        onmousedown={(event) => event.preventDefault()}
        onclick={() => void confirmDeleteAll()}
      >
        {t('composer.draft_delete_all')}
      </button>
    </div>
  </div>

  {#if drafts.length === 0}
    <div class="post-modal-drafts-empty">{t('composer.no_drafts')}</div>
  {:else}
    <div class="post-modal-drafts-items">
      {#each drafts as draft (draft.id)}
        <div class="post-modal-draft-item">
          <button
            type="button"
            class="post-modal-draft-text"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => onLoad(draft)}
          >
            {draft.text}
          </button>
          <div class="post-modal-draft-meta">
            <span class="post-modal-draft-time">{ageLabel(draft.savedAt)}</span>
            <button
              type="button"
              class="post-modal-draft-del"
              aria-label={t('composer.draft_deleted')}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => onDelete(draft.id)}
            >
              {@html iconHtml('close', 12)}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
