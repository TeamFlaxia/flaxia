<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onDestroy, onMount } from 'svelte';
import type { AdminAd } from '../admin/ads-types.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.js';
import { showToast } from '../toast.ts';

let ads = $state<AdminAd[]>([]);
let everyN = $state(8);
let configMessage = $state<{ text: string; type: 'success' | 'error' } | null>(null);
let modalOpen = $state(false);
let editingAd = $state<AdminAd | null>(null);
let saving = $state(false);
let payloadFile = $state<File | null>(null);
let thumbnailFile = $state<File | null>(null);

let form = $state({
  adType: 'self_hosted' as 'self_hosted' | 'admax',
  title: '',
  body: '',
  clickUrl: '',
});

let configTimer: ReturnType<typeof setTimeout> | undefined;

const isAdmax = $derived(form.adType === 'admax');
const titleLength = $derived(form.title.length);
const bodyLength = $derived(form.body.length);

$effect(() => {
  if (!modalOpen) return;
  return registerModal();
});

function getFormatLabel(payloadType: string | null, adType?: string): string {
  if (adType === 'admax') return t('admin_ads.format_admax');
  switch (payloadType) {
    case 'zip':
      return t('admin_ads.format_zip');
    case 'swf':
      return t('admin_ads.format_swf');
    case 'gif':
      return t('admin_ads.format_gif');
    case 'image':
      return t('admin_ads.format_image');
    default:
      return t('admin_ads.format_default');
  }
}

function ctrText(ad: AdminAd): string {
  return ad.impressions > 0 ? `${((ad.clicks / ad.impressions) * 100).toFixed(2)}%` : '—';
}

function ageDays(createdAt: string): number {
  const created = new Date(createdAt);
  const now = new Date();
  const createdUTC = Date.UTC(created.getFullYear(), created.getMonth(), created.getDate());
  const nowUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((nowUTC - createdUTC) / (1000 * 60 * 60 * 24));
}

function showConfigMessage(text: string, type: 'success' | 'error'): void {
  configMessage = { text, type };
  if (configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(() => {
    configMessage = null;
  }, 3000);
}

async function fetchAds(): Promise<AdminAd[]> {
  try {
    const response = await fetch('/api/admin/ads', { credentials: 'include' });
    if (response.status === 403) {
      console.error('Admin access denied - check if user has admin privileges');
      alert(t('admin_ads.access_denied'));
      return [];
    }
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to fetch ads:', response.status, errorText);
      throw new Error(`Failed to fetch ads: ${response.status}`);
    }
    const data = (await response.json()) as { ads: AdminAd[] };
    return data.ads || [];
  } catch (error) {
    console.error('Fetch ads error:', error);
    alert(t('admin_ads.load_failed', { error: error instanceof Error ? error.message : t('common.error') }));
    return [];
  }
}

async function fetchConfig(): Promise<number> {
  try {
    const response = await fetch('/api/admin/ads/config', { credentials: 'include' });
    if (response.status === 403) return 8;
    if (!response.ok) throw new Error(`Failed to fetch config: ${response.status}`);
    const data = (await response.json()) as { every_n: number };
    return data.every_n || 8;
  } catch (error) {
    console.error('Fetch config error:', error);
    return 8;
  }
}

async function saveConfig(): Promise<void> {
  const next = Number.parseInt(String(everyN), 10);
  if (!(next >= 1)) {
    showConfigMessage(t('admin_ads.every_n_validation'), 'error');
    return;
  }
  try {
    const response = await fetch('/api/admin/ads/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ every_n: next }),
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to save config');
    everyN = next;
    showConfigMessage(t('admin_ads.settings_saved'), 'success');
  } catch (error) {
    console.error('Save config error:', error);
    showConfigMessage(t('admin_ads.settings_save_failed'), 'error');
  }
}

async function updateAdActive(ad: AdminAd): Promise<void> {
  const next = !ad.active;
  try {
    const response = await fetch(`/api/admin/ads/${ad.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: next ? 1 : 0 }),
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to update ad');
    ad.active = next ? 1 : 0;
  } catch (error) {
    console.error('Update ad error:', error);
  }
}

async function deleteAd(ad: AdminAd): Promise<void> {
  if (!(await confirmDialog(t('admin_ads.delete_confirm', { title: ad.title })))) return;
  try {
    const response = await fetch(`/api/admin/ads/${ad.id}`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok) throw new Error('Failed to delete ad');
    ads = ads.filter((entry) => entry.id !== ad.id);
  } catch (error) {
    console.error('Delete ad error:', error);
  }
}

function openCreate(): void {
  editingAd = null;
  form = { adType: 'self_hosted', title: '', body: '', clickUrl: '' };
  payloadFile = null;
  thumbnailFile = null;
  modalOpen = true;
}

function openEdit(ad: AdminAd): void {
  editingAd = ad;
  form = {
    adType: ad.ad_type,
    title: ad.title,
    body: ad.body_text,
    clickUrl: ad.click_url ?? '',
  };
  payloadFile = null;
  thumbnailFile = null;
  modalOpen = true;
}

function closeModal(): void {
  modalOpen = false;
  editingAd = null;
  payloadFile = null;
  thumbnailFile = null;
}

async function submitAd(): Promise<void> {
  const title = form.title.trim();
  const bodyText = form.body.trim();
  const clickUrl = form.clickUrl.trim() || null;
  const adType = form.adType;

  if (!title || !bodyText) {
    showToast(t('admin_ads.validation_title_body'), true);
    return;
  }
  if (adType === 'admax' && payloadFile) {
    showToast(t('admin_ads.validation_admax_no_payload'), true);
    return;
  }

  const maxFileSize = 100 * 1024 * 1024;
  if (payloadFile && payloadFile.size > maxFileSize) {
    showToast(t('admin_ads.validation_file_size', { size: (payloadFile.size / 1024 / 1024).toFixed(1) }), true);
    return;
  }
  if (thumbnailFile && thumbnailFile.size > 1024 * 1024) {
    showToast(t('admin_ads.validation_thumbnail_size', { size: (thumbnailFile.size / 1024 / 1024).toFixed(1) }), true);
    return;
  }

  saving = true;
  try {
    if (editingAd) {
      const response = await fetch(`/api/admin/ads/${editingAd.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body_text: bodyText, click_url: clickUrl, ad_type: adType }),
      });
      if (!response.ok) throw new Error('Failed to update ad');
    } else {
      const formData = new FormData();
      formData.append('title', title);
      formData.append('body_text', bodyText);
      formData.append('ad_type', adType);
      if (clickUrl) formData.append('click_url', clickUrl);
      if (payloadFile) formData.append('payload', payloadFile);
      if (thumbnailFile) formData.append('thumbnail', thumbnailFile);

      const response = await fetch('/api/admin/ads', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errorData.error || `Failed to create ad (${response.status})`);
      }
    }

    closeModal();
    ads = await fetchAds();
  } catch (error: unknown) {
    const err = error as { error?: string; message?: string; limit?: number; actualSize?: number };
    console.error('Submit ad error:', err);
    if (err.error && err.limit && err.actualSize) {
      showToast(t('admin_ads.validation_file_size', { size: (err.actualSize / 1024 / 1024).toFixed(1) }), true);
    } else {
      showToast(t('admin_ads.save_error', { error: err?.error || err?.message || t('common.error') }), true);
    }
  } finally {
    saving = false;
  }
}

onMount(() => {
  void (async () => {
    everyN = await fetchConfig();
    ads = await fetchAds();
  })();
});

onDestroy(() => {
  if (configTimer) clearTimeout(configTimer);
});
</script>

<div class="admin-ads">
  <div class="ads-card ads-settings">
    <h3>{t('admin_ads.global_settings')}</h3>
    <div class="ads-settings-row">
      <label for="ads-every-n">{t('admin_ads.every_n_label')}</label>
      <input id="ads-every-n" type="number" min="1" bind:value={everyN} />
      <button type="button" class="ads-btn ads-btn--primary" onclick={() => void saveConfig()}>
        {t('common.save')}
      </button>
    </div>
    {#if configMessage}
      <div class="ads-message" class:ads-message--error={configMessage.type === 'error'}>
        {configMessage.text}
      </div>
    {/if}
  </div>

  <div class="ads-list">
    <h3 class="ads-list-title">
      <span>{t('admin_ads.ad_list')}</span>
      <button type="button" class="ads-btn ads-btn--primary" onclick={openCreate}>
        {t('admin_ads.new_ad')}
      </button>
    </h3>

    <div class="ads-table" hidden={ads.length === 0}>
      <div class="ads-row ads-row--header">
        <div>{t('admin_ads.header_title')}</div>
        <div>{t('admin_ads.header_type')}</div>
        <div>{t('admin_ads.header_format')}</div>
        <div>{t('admin_ads.header_active')}</div>
        <div>{t('admin_ads.header_impressions')}</div>
        <div>{t('admin_ads.header_clicks')}</div>
        <div>{t('admin_ads.header_ctr')}</div>
        <div>{t('admin_ads.header_plays')}</div>
        <div>{t('admin_ads.header_age')}</div>
        <div>{t('admin_ads.header_actions')}</div>
      </div>
      {#each ads as ad (ad.id)}
        <div class="ads-row">
          <div class="ads-title" title={ad.title}>{ad.title}</div>
          <div class:ads-type--admax={ad.ad_type === 'admax'} class:ads-type--self={ad.ad_type !== 'admax'}>
            {ad.ad_type === 'admax' ? t('admin_ads.type_admax') : t('admin_ads.type_self')}
          </div>
          <div class="ads-muted">{getFormatLabel(ad.payload_type, ad.ad_type)}</div>
          <div>
            <button
              type="button"
              class="ads-active"
              class:ads-active--on={!!ad.active}
              onclick={() => void updateAdActive(ad)}
            >
              {ad.active ? t('admin_ads.active_yes') : t('admin_ads.active_no')}
            </button>
          </div>
          <div class="ads-muted">{formatCount(ad.impressions)}</div>
          <div class="ads-muted">{formatCount(ad.clicks)}</div>
          <div class="ads-muted">{ctrText(ad)}</div>
          <div class="ads-muted ads-plays">
            {#if ad.payload_type === 'zip' || ad.payload_type === 'swf'}
              <div class="ads-plays-count">
                {t('admin_ads.plays_count', { count: formatCount(ad.interaction_count || 0) })}
              </div>
            {:else}
              —
            {/if}
          </div>
          <div class="ads-muted ads-age">{t('admin_ads.age_days', { days: ageDays(ad.created_at) })}</div>
          <div class="ads-actions">
            <button type="button" class="ads-btn ads-btn--small" onclick={() => openEdit(ad)}>
              {t('admin_ads.edit')}
            </button>
            <button type="button" class="ads-btn ads-btn--small ads-btn--danger" onclick={() => void deleteAd(ad)}>
              {t('admin_ads.delete')}
            </button>
          </div>
        </div>
      {/each}
    </div>

    {#if ads.length === 0}
      <div class="ads-empty">{t('admin_ads.no_ads')}</div>
    {/if}
  </div>
</div>

{#if modalOpen}
  <div
    class="ads-modal"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}
  >
    <div class="ads-modal-content">
      <div class="ads-modal-header">
        <h3>{editingAd ? t('admin_ads.modal_edit_title') : t('admin_ads.modal_create_title')}</h3>
        <button type="button" class="ads-modal-close" onclick={closeModal}>
          {t('admin_ads.modal_close')}
        </button>
      </div>

      <div class="ads-form">
        <label class="ads-field">
          <span>{t('admin_ads.form_ad_type')}</span>
          <select bind:value={form.adType}>
            <option value="self_hosted">{t('admin_ads.form_self_hosted')}</option>
            <option value="admax">{t('admin_ads.form_admax')}</option>
          </select>
        </label>

        <label class="ads-field">
          <span>{t('admin_ads.form_title')}</span>
          <input type="text" required bind:value={form.title} />
          <small>{titleLength}/200</small>
        </label>

        <label class="ads-field">
          <span>{t('admin_ads.form_body')}</span>
          <textarea rows="4" maxlength="200" bind:value={form.body}></textarea>
          <small>{bodyLength}/200</small>
        </label>

        <label class="ads-field">
          <span>{t('admin_ads.form_click_url')}</span>
          <input type="url" placeholder={t('admin_ads.form_click_url_placeholder')} bind:value={form.clickUrl} />
        </label>

        {#if !isAdmax}
          <label class="ads-field">
            <span>{t('admin_ads.form_payload')}</span>
            {#if editingAd?.payload_key}
              <small>{t('admin_ads.form_current_file', { key: editingAd.payload_key })}</small>
            {/if}
            <input
              type="file"
              accept=".zip,.swf,.gif,.png,.jpg,.jpeg"
              onchange={(event) => {
                payloadFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
              }}
            />
          </label>

          <label class="ads-field">
            <span>{t('admin_ads.form_thumbnail')}</span>
            {#if editingAd?.thumbnail_key}
              <small>{t('admin_ads.form_current_thumbnail', { key: editingAd.thumbnail_key })}</small>
            {/if}
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.gif"
              onchange={(event) => {
                thumbnailFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
              }}
            />
            <small>{t('admin_ads.form_thumbnail_hint')}</small>
          </label>
        {/if}

        {#if editingAd}
          <div class="ads-stats">
            <div>Impressions: <strong>{formatCount(editingAd.impressions)}</strong></div>
            <div>Clicks: <strong>{formatCount(editingAd.clicks)}</strong></div>
            <div>CTR: <strong>{ctrText(editingAd)}</strong></div>
            {#if editingAd.payload_type === 'zip' || editingAd.payload_type === 'swf'}
              <div>Plays: <strong>{formatCount(editingAd.interaction_count || 0)}</strong></div>
            {:else}
              <div>Type: <strong>{getFormatLabel(editingAd.payload_type)}</strong></div>
            {/if}
          </div>
        {/if}
      </div>

      <button type="button" class="ads-btn ads-btn--primary ads-submit" disabled={saving} onclick={() => void submitAd()}>
        {editingAd ? t('admin_ads.form_submit_update') : t('admin_ads.form_submit_create')}
      </button>
    </div>
  </div>
{/if}

<style>
  .admin-ads {
    max-width: 1200px;
  }

  .ads-card {
    background: #1e293b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }

  .ads-settings h3,
  .ads-list-title {
    color: #f1f5f9;
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .ads-settings-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .ads-settings-row label {
    color: #94a3b8;
    font-size: 14px;
  }

  .ads-settings-row input {
    background: #0f172a;
    border: 1px solid #334155;
    color: #f1f5f9;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 14px;
    width: 80px;
  }

  .ads-message {
    margin-top: 12px;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 14px;
    background: #065f46;
    color: #f1f5f9;
  }

  .ads-message--error {
    background: #dc2626;
  }

  .ads-list-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .ads-table {
    background: #1e293b;
    border-radius: 8px;
    overflow: hidden;
  }

  .ads-table[hidden] {
    display: none;
  }

  .ads-row {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 80px 100px 100px 80px 120px 120px 80px;
    gap: 1px;
    background: #1e293b;
    padding: 12px 16px;
    font-size: 14px;
    align-items: center;
  }

  .ads-row--header {
    background: #0f172a;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .ads-title {
    color: #f1f5f9;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ads-type--admax {
    color: #8b5cf6;
    font-weight: 500;
  }

  .ads-type--self {
    color: #22c55e;
    font-weight: 500;
  }

  .ads-muted {
    color: #94a3b8;
  }

  .ads-age,
  .ads-plays-count {
    font-size: 12px;
  }

  .ads-plays-count {
    color: #f1f5f9;
  }

  .ads-active {
    background: #dc2626;
    color: #f1f5f9;
    border: none;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.2s;
  }

  .ads-active--on {
    background: #065f46;
  }

  .ads-actions {
    display: flex;
    gap: 8px;
  }

  .ads-btn {
    background: #334155;
    color: #f1f5f9;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.2s;
  }

  .ads-btn--primary {
    background: #22c55e;
    font-weight: 500;
  }

  .ads-btn--small {
    padding: 4px 8px;
    font-size: 12px;
  }

  .ads-btn--danger {
    background: #dc2626;
  }

  .ads-empty {
    color: #64748b;
    font-size: 14px;
    padding: 24px;
    text-align: center;
    background: #1e293b;
    border-radius: 8px;
  }

  .ads-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .ads-modal-content {
    background: #1e293b;
    border-radius: 8px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  }

  .ads-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .ads-modal-header h3 {
    color: #f1f5f9;
    font-size: 20px;
    font-weight: 600;
    margin: 0;
  }

  .ads-modal-close {
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
  }

  .ads-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .ads-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ads-field > span {
    color: #f1f5f9;
    font-size: 14px;
    font-weight: 500;
  }

  .ads-field input,
  .ads-field select,
  .ads-field textarea {
    background: #0f172a;
    border: 1px solid #334155;
    color: #f1f5f9;
    padding: 12px;
    border-radius: 4px;
    font-size: 14px;
    font-family: inherit;
  }

  .ads-field textarea {
    resize: vertical;
  }

  .ads-field small {
    color: #64748b;
    font-size: 12px;
  }

  .ads-stats {
    background: #0f172a;
    border-radius: 4px;
    padding: 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 16px;
    font-size: 13px;
    color: #94a3b8;
  }

  .ads-stats strong {
    color: #f1f5f9;
  }

  .ads-submit {
    margin-top: 8px;
    padding: 12px 24px;
  }
</style>
