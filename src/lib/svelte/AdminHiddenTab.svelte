<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { HiddenPost } from '../admin/hidden-types.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';

let posts = $state<HiddenPost[]>([]);
let loaded = $state(false);

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

function quotedText(text: string): string {
  return text.length > 50 ? `${text.substring(0, 50)}...` : text;
}

async function fetchHiddenPosts(): Promise<HiddenPost[]> {
  try {
    const response = await fetch('/api/admin/posts/hidden', { credentials: 'include' });
    if (response.status === 403) return [];
    if (!response.ok) throw new Error('Failed to fetch hidden posts');
    const data = (await response.json()) as { posts: HiddenPost[] };
    return data.posts;
  } catch (error) {
    console.error('Fetch hidden posts error:', error);
    return [];
  }
}

async function unhide(post: HiddenPost): Promise<void> {
  if (!(await confirmDialog(t('admin_hidden.restore_confirm')))) return;
  try {
    const response = await fetch(`/api/admin/posts/${post.id}/unhide`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to unhide post');
    posts = posts.filter((entry) => entry.id !== post.id);
  } catch (error) {
    console.error('Unhide post error:', error);
  }
}

onMount(() => {
  void (async () => {
    posts = await fetchHiddenPosts();
    loaded = true;
  })();
});
</script>

<div class="hidden">
  <h2>{t('admin_hidden.title')}</h2>

  {#each posts as post (post.id)}
    <div class="hidden-card">
      <div class="hidden-header">
        <span class="hidden-id">post_id: {post.id}</span>
        <span class="hidden-user">@{post.username}</span>
        <span class="hidden-muted">{post.category || 'unknown'}</span>
        <span class="hidden-time">{formatTimeAgo(post.created_at)}</span>
      </div>
      <div class="hidden-text">{t('admin_hidden.quoted_text', { text: quotedText(post.text) })}</div>
      <div class="hidden-actions">
        <button type="button" class="hidden-btn" onclick={() => window.open(`/posts/${post.id}`, '_blank')}>
          {t('admin_hidden.view')}
        </button>
        <button type="button" class="hidden-btn" onclick={() => void unhide(post)}>
          {t('admin_hidden.unhide')}
        </button>
      </div>
    </div>
  {/each}

  {#if loaded && posts.length === 0}
    <div class="hidden-empty">{t('admin_hidden.empty')}</div>
  {/if}
</div>

<style>
  .hidden {
    max-width: 800px;
  }

  h2 {
    color: var(--text-muted);
    font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 0.875rem;
  }

  .hidden-card {
    background: #1e293b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .hidden-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .hidden-id {
    color: #94a3b8;
    font-size: 13px;
    font-family: monospace;
  }

  .hidden-user {
    color: #22c55e;
    font-size: 14px;
    font-weight: 500;
  }

  .hidden-muted {
    color: #94a3b8;
    font-size: 14px;
  }

  .hidden-time {
    color: #64748b;
    font-size: 13px;
    margin-left: auto;
  }

  .hidden-text {
    color: #cbd5e1;
    font-size: 14px;
    margin-bottom: 12px;
    line-height: 1.5;
  }

  .hidden-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .hidden-btn {
    background: #334155;
    color: #f1f5f9;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }

  .hidden-empty {
    color: #64748b;
    font-size: 14px;
    padding: 24px;
    text-align: center;
  }
</style>
