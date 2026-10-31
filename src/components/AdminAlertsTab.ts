import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';

export interface AdminAlert {
  id: string;
  post_id: string;
  category: string;
  priority: 'critical' | 'high' | 'normal';
  resolved: number;
  created_at: string;
  dmca_work_description?: string;
  dmca_reporter_email?: string;
  dmca_sworn?: number;
  post_text?: string;
  payload_key?: string;
}

export interface AdminAlertsTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void;
}

export function createAdminAlertsTab({ onNavigateToTab }: AdminAlertsTabProps) {
  let element: HTMLElement;
  let alerts: AdminAlert[] = [];

  // Create container immediately
  element = document.createElement('div');
  element.style.cssText = 'max-width: 800px;';

  const fetchAlerts = async () => {
    try {
      const response = await fetch('/api/admin/alerts', { credentials: 'include' });
      if (response.status === 403) {
        return null;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch alerts');
      }
      const data = (await response.json()) as { alerts: AdminAlert[] };
      return data.alerts;
    } catch (error) {
      console.error('Fetch alerts error:', error);
      return [];
    }
  };

  const resolveAlert = async (alertId: string) => {
    try {
      const response = await fetch(`/api/admin/alerts/${alertId}/resolve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to resolve alert');
      }
      return true;
    } catch (error) {
      console.error('Resolve alert error:', error);
      return false;
    }
  };

  const hidePost = async (postId: string, alertId: string) => {
    try {
      const response = await fetch(`/api/admin/posts/${postId}/hide`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to hide post');
      }
      return true;
    } catch (error) {
      console.error('Hide post error:', error);
      return false;
    }
  };

  const markNsfw = async (postId: string): Promise<boolean> => {
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
  };

  // Available even when no reports have been submitted.
  const createNsfwForm = () => {
    const form = document.createElement('form');
    form.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px;';
    const label = document.createElement('label');
    label.textContent = t('admin_alerts.nsfw_post_id');
    const input = document.createElement('input');
    input.type = 'text';
    input.required = true;
    input.style.cssText =
      'margin-left: 8px; padding: 8px; color: #f1f5f9; background: #1e293b; border: 1px solid #64748b;';
    label.appendChild(input);
    form.appendChild(label);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('admin_alerts.mark_nsfw');
    submit.style.cssText =
      'background: #334155; color: #f1f5f9; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;';
    form.appendChild(submit);
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    form.appendChild(status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const postId = input.value.trim();
      if (!postId || submit.disabled) return;
      submit.disabled = true;
      status.textContent = '';
      try {
        if (!(await createConfirmDialog(t('admin_alerts.nsfw_confirm', { id: postId })))) return;
        const success = await markNsfw(postId);
        status.textContent = t(success ? 'admin_alerts.nsfw_success' : 'admin_alerts.nsfw_error');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  };

  const createEmbeddingBackfillControl = () => {
    const panel = document.createElement('section');
    panel.style.cssText =
      'margin-bottom: 24px; padding: 16px; background: #0f172a; border: 1px solid #334155; border-radius: 8px;';

    const description = document.createElement('p');
    description.textContent = t('admin_alerts.embedding_backfill_hint');
    description.style.cssText = 'margin: 0 0 12px; color: #94a3b8; font-size: 14px;';
    panel.appendChild(description);

    const form = document.createElement('form');
    form.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';
    const label = document.createElement('label');
    label.textContent = t('admin_alerts.embedding_backfill_limit');
    const input = document.createElement('input');
    input.type = 'number';
    input.name = 'limit';
    input.min = '1';
    input.max = '2147483647';
    input.step = '1';
    input.value = '5';
    input.required = true;
    input.inputMode = 'numeric';
    input.style.cssText =
      'width: 100px; padding: 8px; color: #f1f5f9; background: #1e293b; border: 1px solid #64748b; border-radius: 4px;';
    label.appendChild(input);
    form.appendChild(label);

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = t('admin_alerts.embedding_backfill');
    button.style.cssText =
      'background: #334155; color: #f1f5f9; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;';
    form.appendChild(button);
    panel.appendChild(form);

    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'display: block; margin-top: 8px; color: #94a3b8; font-size: 13px;';
    panel.appendChild(status);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const limit = Number(input.value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2147483647 || button.disabled) {
        input.reportValidity();
        return;
      }
      button.disabled = true;
      status.textContent = t('common.loading');
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
          status.textContent = data.error || t('admin_alerts.embedding_backfill_error');
          return;
        }
        status.textContent = t('admin_alerts.embedding_backfill_queued', { count: data.enqueued ?? 0 });
      } catch {
        status.textContent = t('admin_alerts.embedding_backfill_error');
      } finally {
        button.disabled = false;
      }
    });

    return panel;
  };

  const formatTimeAgo = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
    if (diffHours < 24) return t('time.hours_ago', { n: diffHours });
    if (diffDays < 7) return t('time.days_ago', { n: diffDays });
    return date.toLocaleDateString();
  };

  const getPriorityStyle = (priority: string) => {
    switch (priority) {
      case 'critical':
        return { color: '#ef4444', prefix: '🚨' };
      case 'high':
        return { color: '#f59e0b', prefix: '⚠' };
      default:
        return { color: '#94a3b8', prefix: '•' };
    }
  };

  const createAlertRow = (alert: AdminAlert) => {
    const row = document.createElement('div');
    row.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    `;

    const priorityStyle = getPriorityStyle(alert.priority);

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    `;

    const badge = document.createElement('span');
    badge.style.cssText = `color: ${priorityStyle.color}; font-weight: 600; font-size: 14px;`;
    badge.textContent = `${priorityStyle.prefix} ${alert.priority.toUpperCase()}`;
    header.appendChild(badge);

    const category = document.createElement('span');
    category.style.cssText = 'color: #94a3b8; font-size: 14px;';
    category.textContent = alert.category;
    header.appendChild(category);

    const postId = document.createElement('span');
    postId.style.cssText = 'color: #94a3b8; font-size: 14px;';
    postId.textContent = t('admin_alerts.post_id', { id: alert.post_id });
    header.appendChild(postId);

    const time = document.createElement('span');
    time.style.cssText = 'color: #64748b; font-size: 14px; margin-left: auto;';
    time.textContent = formatTimeAgo(alert.created_at);
    header.appendChild(time);

    row.appendChild(header);

    if (alert.category === 'copyright' && alert.dmca_work_description) {
      const dmcaInfo = document.createElement('div');
      dmcaInfo.style.cssText = `
        background: #0f172a;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 12px;
        font-size: 13px;
        color: #94a3b8;
      `;
      const workLine = document.createElement('div');
      workLine.textContent = `${t('admin_alerts.dmca_work')}${alert.dmca_work_description}"`;
      dmcaInfo.appendChild(workLine);
      const emailLine = document.createElement('div');
      emailLine.textContent = `${t('admin_alerts.dmca_email')}${alert.dmca_reporter_email}"`;
      dmcaInfo.appendChild(emailLine);
      const swornLine = document.createElement('div');
      swornLine.style.marginTop = '4px';
      swornLine.textContent = `${t('admin_alerts.dmca_sworn')}${alert.dmca_sworn ? '✓' : '✗'}`;
      dmcaInfo.appendChild(swornLine);
      row.appendChild(dmcaInfo);
    }

    if (alert.category === 'csam' || alert.category === 'malware') {
      const warning = document.createElement('div');
      warning.style.cssText = `
        background: #451a1a;
        border: 1px solid #ef4444;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 12px;
        font-size: 13px;
        color: #f1f5f9;
      `;
      const warningLine = document.createElement('div');
      warningLine.style.marginBottom = '8px';
      warningLine.textContent = t('admin_alerts.warning_csam');
      warning.appendChild(warningLine);
      const codeEl = document.createElement('code');
      codeEl.style.cssText = 'background: #0f172a; padding: 8px; border-radius: 4px; display: block; overflow-x: auto;';
      codeEl.textContent = `wrangler r2 object delete flaxia-content --key "${alert.payload_key || ''}"`;
      warning.appendChild(codeEl);
      row.appendChild(warning);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

    if (alert.category !== 'csam' && alert.category !== 'malware') {
      const viewBtn = document.createElement('button');
      viewBtn.textContent = t('admin_alerts.view_post');
      viewBtn.style.cssText = `
        background: #334155;
        color: #f1f5f9;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.2s;
      `;
      viewBtn.addEventListener('click', () => {
        window.open(`/posts/${alert.post_id}`, '_blank');
      });
      actions.appendChild(viewBtn);
    }

    const hideBtn = document.createElement('button');
    hideBtn.textContent = t('admin_alerts.hide');
    hideBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    hideBtn.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(t('admin_alerts.hide_confirm'));
      if (!confirmed) return;
      const success = await hidePost(alert.post_id, alert.id);
      if (success) {
        await resolveAlert(alert.id);
        alerts = alerts.filter((a) => a.id !== alert.id);
        render();
      }
    });
    actions.appendChild(hideBtn);

    if (alert.category !== 'csam' && alert.category !== 'malware') {
      const nsfwBtn = document.createElement('button');
      nsfwBtn.textContent = t('admin_alerts.mark_nsfw');
      nsfwBtn.style.cssText = hideBtn.style.cssText;
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      nsfwBtn.addEventListener('click', async () => {
        if (nsfwBtn.disabled) return;
        nsfwBtn.disabled = true;
        status.textContent = '';
        try {
          if (!(await createConfirmDialog(t('admin_alerts.nsfw_confirm', { id: alert.post_id })))) return;
          const success = await markNsfw(alert.post_id);
          status.textContent = t(success ? 'admin_alerts.nsfw_success' : 'admin_alerts.nsfw_error');
        } finally {
          nsfwBtn.disabled = false;
        }
      });
      actions.appendChild(nsfwBtn);
      actions.appendChild(status);
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = t('admin_alerts.dismiss');
    dismissBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    dismissBtn.addEventListener('click', async () => {
      const success = await resolveAlert(alert.id);
      if (success) {
        alerts = alerts.filter((a) => a.id !== alert.id);
        render();
      }
    });
    actions.appendChild(dismissBtn);

    row.appendChild(actions);

    return row;
  };

  const render = async () => {
    element.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = t('admin_alerts.title');
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 24px;
    `;
    element.appendChild(title);
    element.appendChild(createNsfwForm());
    element.appendChild(createEmbeddingBackfillControl());

    if (alerts.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('admin_alerts.empty');
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;';
      element.appendChild(empty);
    } else {
      alerts.forEach((alert) => {
        element.appendChild(createAlertRow(alert));
      });
    }
  };

  const init = async () => {
    alerts = (await fetchAlerts()) || [];
    await render();
  };

  // Start initialization but don't wait for it
  init();

  return {
    getElement: () => element,
    refresh: async () => {
      alerts = (await fetchAlerts()) || [];
      await render();
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element);
      }
    },
  };
}
