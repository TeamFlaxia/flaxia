import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';

export interface CounterNotice {
  id: string;
  post_id: string;
  user_id: string;
  name: string;
  email: string;
  address: string;
  phone: string;
  statement: number;
  consent_jurisdiction: number;
  status: string;
  submitted_at: string;
  restore_at: string;
  username: string;
  display_name: string;
}

export interface AdminCounterTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads' | 'counter') => void;
}

export function createAdminCounterTab({ onNavigateToTab }: AdminCounterTabProps) {
  let element: HTMLElement;
  let counterNotices: CounterNotice[] = [];

  element = document.createElement('div');
  element.style.cssText = 'max-width: 800px;';

  const fetchCounterNotices = async () => {
    try {
      const response = await fetch('/api/admin/counter/pending', { credentials: 'include' });
      if (response.status === 403) return null;
      if (!response.ok) throw new Error('Failed to fetch counter-notices');
      const data = (await response.json()) as { counter_notices: CounterNotice[] };
      return data.counter_notices;
    } catch (error) {
      console.error('Fetch counter-notices error:', error);
      return [];
    }
  };

  const rejectCounter = async (counterId: string) => {
    try {
      const response = await fetch(`/api/admin/counter/${counterId}/reject`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to reject counter-notice');
      return true;
    } catch (error) {
      console.error('Reject counter-notice error:', error);
      return false;
    }
  };

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleDateString();
  };

  const createRow = (cn: CounterNotice) => {
    const row = document.createElement('div');
    row.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    `;

    const badge = document.createElement('span');
    badge.style.cssText = 'color: #f59e0b; font-weight: 600; font-size: 14px;';
    badge.textContent = '⚠ COUNTER';
    header.appendChild(badge);

    const user = document.createElement('span');
    user.style.cssText = 'color: #22c55e; font-size: 14px;';
    user.textContent = `@${cn.username}`;
    header.appendChild(user);

    const submitted = document.createElement('span');
    submitted.style.cssText = 'color: #94a3b8; font-size: 14px;';
    submitted.textContent = `${t('admin_counter.submitted')}: ${formatDate(cn.submitted_at)}`;
    header.appendChild(submitted);

    const restore = document.createElement('span');
    restore.style.cssText = 'color: #64748b; font-size: 14px; margin-left: auto;';
    restore.textContent = `${t('admin_counter.restore_at')}: ${formatDate(cn.restore_at)}`;
    header.appendChild(restore);

    row.appendChild(header);

    const details = document.createElement('div');
    details.style.cssText = `
      background: #0f172a;
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
      font-size: 13px;
      color: #94a3b8;
    `;
    details.innerHTML = `
      <div><strong style="color: #cbd5e1;">${t('admin_counter.name')}:</strong> ${cn.name}</div>
      <div><strong style="color: #cbd5e1;">${t('admin_counter.email')}:</strong> ${cn.email}</div>
      <div><strong style="color: #cbd5e1;">${t('admin_counter.address')}:</strong> ${cn.address}</div>
      <div><strong style="color: #cbd5e1;">${t('admin_counter.phone')}:</strong> ${cn.phone}</div>
      <div style="margin-top: 8px; color: ${cn.statement ? '#22c55e' : '#ef4444'};">
        ${cn.statement ? '✓' : '✗'} ${t('admin_counter.statement')}
      </div>
      <div style="color: ${cn.consent_jurisdiction ? '#22c55e' : '#ef4444'};">
        ${cn.consent_jurisdiction ? '✓' : '✗'} ${t('admin_counter.consent')}
      </div>
    `;
    row.appendChild(details);

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

    const viewBtn = document.createElement('button');
    viewBtn.textContent = t('admin_counter.view_post');
    viewBtn.style.cssText = `
      background: #334155; color: #f1f5f9; border: none;
      padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
      transition: background 0.2s;
    `;
    viewBtn.addEventListener('click', () => {
      window.open(`/posts/${cn.post_id}`, '_blank');
    });
    actions.appendChild(viewBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = t('admin_counter.reject');
    rejectBtn.style.cssText = `
      background: #991b1b; color: #f1f5f9; border: none;
      padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
      transition: background 0.2s;
    `;
    rejectBtn.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(t('admin_counter.reject_confirm'));
      if (!confirmed) return;
      const success = await rejectCounter(cn.id);
      if (success) {
        counterNotices = counterNotices.filter((c) => c.id !== cn.id);
        render();
      }
    });
    actions.appendChild(rejectBtn);

    row.appendChild(actions);

    return row;
  };

  const render = async () => {
    element.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = t('admin_counter.title');
    title.style.cssText = `
      color: #f1f5f9; font-size: 24px; font-weight: 600; margin-bottom: 24px;
    `;
    element.appendChild(title);

    if (counterNotices.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('admin_counter.empty');
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;';
      element.appendChild(empty);
    } else {
      counterNotices.forEach((cn) => {
        element.appendChild(createRow(cn));
      });
    }
  };

  const init = async () => {
    counterNotices = (await fetchCounterNotices()) || [];
    await render();
  };

  init();

  return {
    getElement: () => element,
    refresh: async () => {
      counterNotices = (await fetchCounterNotices()) || [];
      await render();
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element);
      }
    },
  };
}
