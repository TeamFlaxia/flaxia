<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { AdminAlert } from '../admin/alerts-types.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';

let alerts = $state<AdminAlert[]>([]);
let loaded = $state(false);
let nsfwPostId = $state('');
let nsfwBusy = $state(false);
let nsfwStatus = $state('');
let backfillLimit = $state('5');
let backfillBusy = $state(false);
let backfillStatus = $state('');
let rowStatus = $state<Record<string, string>>({});
let rowBusy = $state<Record<string, boolean>>({});

function formatTimeAgo(value: string): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('time.just_now');
  if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
  if (diffHours < 24) return t('time.hours_ago', { n: diffHours });
  if (diffDays < 7) return t('time.days_ago', { n: diffDays });
  return date.toLocaleDateString();
}

function priorityStyle(priority: string): { color: string; prefix: string } {
  switch (priority) {
    case 'critical':
      return { color: '#ef4444', prefix: '🚨' };
    case 'high':
      return { color: '#f59e0b', prefix: '⚠' };
    default:
      return { color: '#94a3b8', prefix: '•' };
  }
}

async function fetchAlerts(): Promise<AdminAlert[]> {
  try {
    const response = await fetch('/api/admin/alerts', { credentials: 'include' });
    if (response.status === 403) return [];
    if (!response.ok) throw new Error('Failed to fetch alerts');
    const data = (await response.json()) as { alerts: AdminAlert[] };
    return data.alerts;
  } catch (error) {
    console.error('Fetch alerts error:', error);
    return [];
  }
}

async function resolveAlert(alertId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/admin/alerts/${alertId}/resolve`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to resolve alert');
    return true;
  } catch (error) {
    console.error('Resolve alert error:', error);
    return false;
  }
}

async function hidePost(postId: string, alertId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/admin/posts/${postId}/hide`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to hide post');
    await resolveAlert(alertId);
    return true;
  } catch (error) {
    console.error('Hide post error:', error);
    return false;
  }
}

async function markNsfw(postId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/admin/posts/${encodeURIComponent(postId)}/nsfw`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to mark post as NSFW');
    return true;
  } catch (error) {
    console.error('Mark post NSFW error:', error);
    return false;
  }
}

async function submitNsfw(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const postId = nsfwPostId.trim();
  if (!postId || nsfwBusy) return;
  nsfwBusy = true;
  nsfwStatus = '';
  try {
    if (!(await confirmDialog(t('admin_alerts.nsfw_confirm', { id: postId })))) return;
    const success = await markNsfw(postId);
    nsfwStatus = t(success ? 'admin_alerts.nsfw_success' : 'admin_alerts.nsfw_error');
  } finally {
    nsfwBusy = false;
  }
}

async function submitBackfill(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const limit = Number(backfillLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2147483647 || backfillBusy) return;
  backfillBusy = true;
  backfillStatus = t('common.loading');
  try {
    const response = await fetch(`/api/admin/backfill-embeddings?limit=${limit}`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      enqueued?: number;
    };
    if (!response.ok || data.success !== true) {
      backfillStatus = data.error || t('admin_alerts.embedding_backfill_error');
      return;
    }
    backfillStatus = t('admin_alerts.embedding_backfill_queued', { count: data.enqueued ?? 0 });
  } catch {
    backfillStatus = t('admin_alerts.embedding_backfill_error');
  } finally {
    backfillBusy = false;
  }
}

async function hideAlert(alert: AdminAlert): Promise<void> {
  if (!(await confirmDialog(t('admin_alerts.hide_confirm')))) return;
  if (await hidePost(alert.post_id, alert.id)) {
    alerts = alerts.filter((entry) => entry.id !== alert.id);
  }
}

async function markAlertNsfw(alert: AdminAlert): Promise<void> {
  if (rowBusy[alert.id]) return;
  rowBusy = { ...rowBusy, [alert.id]: true };
  rowStatus = { ...rowStatus, [alert.id]: '' };
  try {
    if (!(await confirmDialog(t('admin_alerts.nsfw_confirm', { id: alert.post_id })))) return;
    const success = await markNsfw(alert.post_id);
    rowStatus = { ...rowStatus, [alert.id]: t(success ? 'admin_alerts.nsfw_success' : 'admin_alerts.nsfw_error') };
  } finally {
    rowBusy = { ...rowBusy, [alert.id]: false };
  }
}

async function dismissAlert(alert: AdminAlert): Promise<void> {
  if (await resolveAlert(alert.id)) {
    alerts = alerts.filter((entry) => entry.id !== alert.id);
  }
}

onMount(() => {
  void (async () => {
    alerts = await fetchAlerts();
    loaded = true;
  })();
});
</script>

<div class="alerts">
  <h2>{t('admin_alerts.title')}</h2>

  <form class="alerts-nsfw" onsubmit={(event) => void submitNsfw(event)}>
    <label>
      {t('admin_alerts.nsfw_post_id')}
      <input type="text" required bind:value={nsfwPostId} />
    </label>
    <button type="submit" class="alerts-btn" disabled={nsfwBusy}>{t('admin_alerts.mark_nsfw')}</button>
    <span role="status">{nsfwStatus}</span>
  </form>

  <section class="alerts-backfill">
    <p>{t('admin_alerts.embedding_backfill_hint')}</p>
    <form onsubmit={(event) => void submitBackfill(event)}>
      <label>
        {t('admin_alerts.embedding_backfill_limit')}
        <input type="number" min="1" max="2147483647" step="1" required inputmode="numeric" bind:value={backfillLimit} />
      </label>
      <button type="submit" class="alerts-btn" disabled={backfillBusy}>
        {t('admin_alerts.embedding_backfill')}
      </button>
    </form>
    <span role="status" aria-live="polite">{backfillStatus}</span>
  </section>

  {#each alerts as alert (alert.id)}
    {@const priority = priorityStyle(alert.priority)}
    <div class="alerts-card">
      <div class="alerts-header">
        <span class="alerts-priority" style:color={priority.color}>
          {priority.prefix}
          {alert.priority.toUpperCase()}
        </span>
        <span class="alerts-muted">{alert.category}</span>
        <span class="alerts-muted">{t('admin_alerts.post_id', { id: alert.post_id })}</span>
        <span class="alerts-time">{formatTimeAgo(alert.created_at)}</span>
      </div>

      {#if alert.category === 'copyright' && alert.dmca_work_description}
        <div class="alerts-dmca">
          <div>{t('admin_alerts.dmca_work')}{alert.dmca_work_description}"</div>
          <div>{t('admin_alerts.dmca_email')}{alert.dmca_reporter_email}"</div>
          <div class="alerts-dmca-sworn">{t('admin_alerts.dmca_sworn')}{alert.dmca_sworn ? '✓' : '✗'}</div>
        </div>
      {/if}

      {#if alert.category === 'csam' || alert.category === 'malware'}
        <div class="alerts-warning">
          <div class="alerts-warning-line">{t('admin_alerts.warning_csam')}</div>
          <code>wrangler r2 object delete flaxia-content --key "{alert.payload_key || ''}"</code>
        </div>
      {/if}

      <div class="alerts-actions">
        {#if alert.category !== 'csam' && alert.category !== 'malware'}
          <button type="button" class="alerts-btn" onclick={() => window.open(`/posts/${alert.post_id}`, '_blank')}>
            {t('admin_alerts.view_post')}
          </button>
        {/if}
        <button type="button" class="alerts-btn" onclick={() => void hideAlert(alert)}>
          {t('admin_alerts.hide')}
        </button>
        {#if alert.category !== 'csam' && alert.category !== 'malware'}
          <button
            type="button"
            class="alerts-btn"
            disabled={rowBusy[alert.id]}
            onclick={() => void markAlertNsfw(alert)}
          >
            {t('admin_alerts.mark_nsfw')}
          </button>
          <span role="status">{rowStatus[alert.id] ?? ''}</span>
        {/if}
        <button type="button" class="alerts-btn" onclick={() => void dismissAlert(alert)}>
          {t('admin_alerts.dismiss')}
        </button>
      </div>
    </div>
  {/each}

  {#if loaded && alerts.length === 0}
    <div class="alerts-empty">{t('admin_alerts.empty')}</div>
  {/if}
</div>

<style>
  .alerts {
    max-width: 800px;
  }

  h2 {
    color: #f1f5f9;
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 24px;
  }

  .alerts-nsfw {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 24px;
    align-items: center;
  }

  .alerts-nsfw input {
    margin-left: 8px;
    padding: 8px;
    color: #f1f5f9;
    background: #1e293b;
    border: 1px solid #64748b;
  }

  .alerts-backfill {
    margin-bottom: 24px;
    padding: 16px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
  }

  .alerts-backfill p {
    margin: 0 0 12px;
    color: #94a3b8;
    font-size: 14px;
  }

  .alerts-backfill form {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .alerts-backfill input {
    width: 100px;
    padding: 8px;
    color: #f1f5f9;
    background: #1e293b;
    border: 1px solid #64748b;
    border-radius: 4px;
  }

  .alerts-backfill span {
    display: block;
    margin-top: 8px;
    color: #94a3b8;
    font-size: 13px;
  }

  .alerts-btn {
    background: #334155;
    color: #f1f5f9;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }

  .alerts-card {
    background: #1e293b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .alerts-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .alerts-priority {
    font-weight: 600;
    font-size: 14px;
  }

  .alerts-muted {
    color: #94a3b8;
    font-size: 14px;
  }

  .alerts-time {
    color: #64748b;
    font-size: 14px;
    margin-left: auto;
  }

  .alerts-dmca {
    background: #0f172a;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #94a3b8;
  }

  .alerts-dmca-sworn {
    margin-top: 4px;
  }

  .alerts-warning {
    background: #451a1a;
    border: 1px solid #ef4444;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #f1f5f9;
  }

  .alerts-warning-line {
    margin-bottom: 8px;
  }

  .alerts-warning code {
    background: #0f172a;
    padding: 8px;
    border-radius: 4px;
    display: block;
    overflow-x: auto;
  }

  .alerts-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  .alerts-empty {
    color: #64748b;
    font-size: 14px;
    padding: 24px;
    text-align: center;
  }
</style>
