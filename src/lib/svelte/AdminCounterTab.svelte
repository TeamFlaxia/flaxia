<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { CounterNotice } from '../admin/counter-types.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';

let notices = $state<CounterNotice[]>([]);
let loaded = $state(false);

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

async function fetchNotices(): Promise<CounterNotice[]> {
  try {
    const response = await fetch('/api/admin/counter/pending', { credentials: 'include' });
    if (response.status === 403) return [];
    if (!response.ok) throw new Error('Failed to fetch counter-notices');
    const data = (await response.json()) as { counter_notices: CounterNotice[] };
    return data.counter_notices;
  } catch (error) {
    console.error('Fetch counter-notices error:', error);
    return [];
  }
}

async function reject(notice: CounterNotice): Promise<void> {
  if (!(await confirmDialog(t('admin_counter.reject_confirm')))) return;
  try {
    const response = await fetch(`/api/admin/counter/${notice.id}/reject`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to reject counter-notice');
    notices = notices.filter((entry) => entry.id !== notice.id);
  } catch (error) {
    console.error('Reject counter-notice error:', error);
  }
}

onMount(() => {
  void (async () => {
    notices = await fetchNotices();
    loaded = true;
  })();
});
</script>

<div class="counter">
  <h2>{t('admin_counter.title')}</h2>

  {#if loaded && notices.length === 0}
    <div class="counter-empty">{t('admin_counter.empty')}</div>
  {:else}
    {#each notices as notice (notice.id)}
      <div class="counter-card">
        <div class="counter-header">
          <span class="counter-badge">⚠ COUNTER</span>
          <span class="counter-user">@{notice.username}</span>
          <span class="counter-muted">{t('admin_counter.submitted')}: {formatDate(notice.submitted_at)}</span>
          <span class="counter-restore">{t('admin_counter.restore_at')}: {formatDate(notice.restore_at)}</span>
        </div>

        <div class="counter-details">
          <div><strong>{t('admin_counter.name')}:</strong> {notice.name}</div>
          <div><strong>{t('admin_counter.email')}:</strong> {notice.email}</div>
          <div><strong>{t('admin_counter.address')}:</strong> {notice.address}</div>
          <div><strong>{t('admin_counter.phone')}:</strong> {notice.phone}</div>
          <div class:counter-ok={!!notice.statement} class:counter-fail={!notice.statement}>
            {notice.statement ? '✓' : '✗'} {t('admin_counter.statement')}
          </div>
          <div class:counter-ok={!!notice.consent_jurisdiction} class:counter-fail={!notice.consent_jurisdiction}>
            {notice.consent_jurisdiction ? '✓' : '✗'} {t('admin_counter.consent')}
          </div>
        </div>

        <div class="counter-actions">
          <button type="button" class="counter-btn" onclick={() => window.open(`/posts/${notice.post_id}`, '_blank')}>
            {t('admin_counter.view_post')}
          </button>
          <button type="button" class="counter-btn counter-btn--danger" onclick={() => void reject(notice)}>
            {t('admin_counter.reject')}
          </button>
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .counter {
    max-width: 800px;
  }

  h2 {
    color: #f1f5f9;
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 24px;
  }

  .counter-empty {
    color: #64748b;
    font-size: 14px;
    padding: 24px;
    text-align: center;
  }

  .counter-card {
    background: #1e293b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .counter-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .counter-badge {
    color: #f59e0b;
    font-weight: 600;
    font-size: 14px;
  }

  .counter-user {
    color: #22c55e;
    font-size: 14px;
  }

  .counter-muted {
    color: #94a3b8;
    font-size: 14px;
  }

  .counter-restore {
    color: #64748b;
    font-size: 14px;
    margin-left: auto;
  }

  .counter-details {
    background: #0f172a;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #94a3b8;
  }

  .counter-details strong {
    color: #cbd5e1;
  }

  .counter-details > div:last-child,
  .counter-details > div:nth-last-child(2) {
    margin-top: 8px;
    color: #ef4444;
  }

  .counter-details .counter-ok {
    color: #22c55e;
  }

  .counter-details .counter-fail {
    color: #ef4444;
  }

  .counter-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .counter-btn {
    background: #334155;
    color: #f1f5f9;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }

  .counter-btn--danger {
    background: #991b1b;
  }
</style>
