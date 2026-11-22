import { getLocale, t } from '../lib/i18n.js';
import { each, html, legacy, type Mounted, mount, signal } from '../lib/render/index.ts';
import { mountSettingsSection } from '../lib/settings/section-host.ts';
import SettingsAccountSection from '../lib/svelte/SettingsAccountSection.svelte';
import SettingsCrowdSection from '../lib/svelte/SettingsCrowdSection.svelte';
import SettingsDisplaySection from '../lib/svelte/SettingsDisplaySection.svelte';
import SettingsEmailSection from '../lib/svelte/SettingsEmailSection.svelte';
import SettingsLanguageSection from '../lib/svelte/SettingsLanguageSection.svelte';
import SettingsMapsSection from '../lib/svelte/SettingsMapsSection.svelte';
import SettingsPasswordSection from '../lib/svelte/SettingsPasswordSection.svelte';
import SettingsTitlesSection from '../lib/svelte/SettingsTitlesSection.svelte';
import { createAddStampModal } from './AddStampModal.js';
import { createBugReportForm } from './BugReportForm.js';
import { createVaultSection } from './VaultSection.js';

export interface SettingsPageProps {
  initialCategory?: string | null;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
    language?: string;
    email?: string;
  };
}

interface BillingHistoryRow {
  key: string;
  left: string;
  right: string;
}

interface SettingsStamp {
  id: string;
  name: string;
  url: string;
}

type StampEntry = { kind: 'stamp'; stamp: SettingsStamp } | { kind: 'add' } | { kind: 'error' };

export interface SettingsCategory {
  id: string;
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
  iconName: string;
  sections: HTMLElement[];
}

/**
 * Build the settings section DOM. The Svelte shell owns the page chrome and
 * navigation; this adapter only produces the category content.
 */
export function loadSettingsCategories({ currentUser }: SettingsPageProps) {
  const categories: SettingsCategory[] = [];
  const addCategory = (category: SettingsCategory) => categories.push(category);
  const bugReportForm = createBugReportForm();
  let emojiSection: HTMLDivElement | undefined;
  let billingSection: HTMLDivElement | undefined;
  let stampsMount: Mounted | undefined;
  let historyMount: Mounted | undefined;
  const displayMounts: Mounted[] = [];

  // Account section (Svelte).
  const accountMount = currentUser ? mountSettingsSection(SettingsAccountSection, { currentUser }) : null;
  const accountSection = accountMount?.element;

  // Display section (Svelte): reply style, NSFW, data saver and theme.
  const displayMount = mountSettingsSection(SettingsDisplaySection);
  const displaySection = displayMount.element;

  // Crowd section (Svelte): opt in/out of donating browser compute.
  const crowdMount = mountSettingsSection(SettingsCrowdSection);
  const crowdSection = crowdMount.element;

  // Language section (Svelte).
  const languageMount = mountSettingsSection(SettingsLanguageSection, { currentUser });
  const languageSection = languageMount.element;

  // Email section (Svelte).
  const emailMount = mountSettingsSection(SettingsEmailSection);
  const emailSection = emailMount.element;

  // Password section (Svelte).
  const passwordMount = mountSettingsSection(SettingsPasswordSection, { currentUser });
  const passwordSection = passwordMount.element;

  // ─── Personal Vault Section ──────────────────────────────────────────────
  // Own component: it has three states of its own (setup / locked / unlocked)
  // and timers to clean up, which would drown the settings page otherwise.
  const vaultSection = currentUser ? createVaultSection() : null;

  // Titles section (Svelte).
  const titlesMount = currentUser ? mountSettingsSection(SettingsTitlesSection) : null;
  const titlesSection = titlesMount?.element;

  // Shared billing state: populated by `loadBilling`, read by the stamp counter.
  let currentPlan: {
    plan: string | null;
    status: string | null;
    expiresAt: string | null;
    cancelAtPeriodEnd: boolean;
  } = { plan: null, status: null, expiresAt: null, cancelAtPeriodEnd: false };
  let refreshStamps: () => void = () => {};

  // ─── Custom Emoji Section ────────────────────────────────────────────────
  if (currentUser) {
    emojiSection = document.createElement('div');
    emojiSection.className = 'settings-section';

    const emojiTitle = document.createElement('h2');
    emojiTitle.textContent = t('settings.custom_emoji') || 'Custom Emoji';

    const emojiDesc = document.createElement('p');
    emojiDesc.textContent =
      t('settings.custom_emoji_desc') ||
      'Create custom emoji like :working_me: to use in reactions and messages. Only you can use your custom emoji, but others can see them.';
    emojiDesc.style.cssText = 'color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1rem;';

    const emojiCountRow = document.createElement('div');
    emojiCountRow.style.cssText = 'display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;';
    const emojiCountLabel = document.createElement('span');
    emojiCountLabel.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);';
    const emojiCountValue = document.createElement('span');
    emojiCountValue.style.cssText = 'font-weight: 600; color: var(--text-primary);';
    emojiCountLabel.textContent = t('settings.custom_emoji_count') || 'Emoji used:';
    emojiCountValue.textContent = '...';
    emojiCountRow.appendChild(emojiCountLabel);
    emojiCountRow.appendChild(emojiCountValue);

    // Stamps list
    const stampsGrid = document.createElement('div');
    stampsGrid.style.cssText =
      'display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.75rem; width: 100%;';

    const stampsSignal = signal<StampEntry[]>([]);

    const renderStampEntry = (entry: StampEntry): HTMLElement => {
      if (entry.kind === 'error') {
        const failed = document.createElement('div');
        failed.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--text-muted);padding:1rem;';
        failed.textContent = t('settings.custom_emoji_load_failed') || 'Failed to load stamps';
        return failed;
      }

      if (entry.kind === 'add') {
        const addCard = document.createElement('div');
        addCard.style.cssText = `
          border: 2px dashed var(--border);
          border-radius: 6px;
          padding: 0.5rem;
          text-align: center;
          background: var(--bg-secondary);
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          gap: 0.25rem;
          min-height: 80px;
          transition: border-color 0.2s, background 0.2s;
        `;
        const addIcon = document.createElement('div');
        addIcon.textContent = '+';
        addIcon.style.cssText = 'font-size: 1.5rem; line-height: 1; color: var(--text-muted);';
        const addLabel = document.createElement('div');
        addLabel.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
        addLabel.textContent = t('settings.add_stamp_tap_to_add') || 'Tap to add';
        addCard.appendChild(addIcon);
        addCard.appendChild(addLabel);

        addCard.addEventListener('mouseenter', () => {
          addCard.style.borderColor = 'var(--accent)';
          addCard.style.background = 'var(--bg-hover, rgba(0,0,0,0.02))';
        });
        addCard.addEventListener('mouseleave', () => {
          addCard.style.borderColor = 'var(--border)';
          addCard.style.background = 'var(--bg-secondary)';
        });
        addCard.addEventListener('click', () => {
          createAddStampModal({ onUploaded: loadStamps });
        });
        return addCard;
      }

      const stamp = entry.stamp;
      const card = document.createElement('div');
      card.style.cssText = `
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem;
        text-align: center;
        background: var(--bg-secondary);
        overflow: hidden;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        position: relative;
      `;
      const img = document.createElement('img');
      img.src = stamp.url;
      img.alt = stamp.name;
      img.style.cssText = 'width: 48px; height: 48px; object-fit: contain; margin-bottom: 0.25rem; flex-shrink: 0;';
      const label = document.createElement('div');
      label.style.cssText =
        'font-size: 0.75rem; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%;';
      label.textContent = stamp.name;
      label.title = stamp.name;
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.style.cssText = `
        position: absolute;
        top: 2px;
        right: 2px;
        background: var(--danger-strong, #b91c1c);
        color: #fff;
        border: none;
        border-radius: 50%;
        width: 16px;
        height: 16px;
        font-size: 9px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
        flex-shrink: 0;
      `;
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('settings.custom_emoji_delete_confirm', { name: stamp.name }) || `Delete ${stamp.name}?`)) {
          return;
        }
        const res = await fetch(`/api/stamps/${stamp.id}`, { method: 'DELETE', credentials: 'include' });
        if (res.ok) loadStamps();
      });
      card.appendChild(delBtn);
      card.appendChild(img);
      card.appendChild(label);
      return card;
    };

    stampsMount = mount(stampsGrid, () =>
      each(
        () => stampsSignal(),
        (entry) => (entry.kind === 'stamp' ? entry.stamp.id : entry.kind),
        (entry) => legacy(renderStampEntry(entry())),
      ),
    );

    function loadStamps() {
      fetch('/api/stamps', { credentials: 'include' })
        .then((r) => r.json() as Promise<{ stamps: SettingsStamp[] }>)
        .then((data) => {
          const unlimited = !!currentPlan.plan && ['active', 'trialing'].includes(currentPlan.status || '');
          emojiCountValue.textContent = unlimited ? `${data.stamps.length} / ∞` : `${data.stamps.length} / 5`;
          stampsSignal.set([
            ...data.stamps.map((stamp) => ({ kind: 'stamp' as const, stamp })),
            { kind: 'add' as const },
          ]);
        })
        .catch(() => {
          stampsSignal.set([{ kind: 'error' }]);
        });
    }

    emojiSection.appendChild(emojiTitle);
    emojiSection.appendChild(emojiDesc);
    emojiSection.appendChild(emojiCountRow);
    emojiSection.appendChild(stampsGrid);

    refreshStamps = loadStamps;
    loadStamps();
  }

  // Billing Section (Flaxia+ only). Play-distributed builds must use Play Billing
  // for digital subscriptions; keep the current Stripe flow web-only until that
  // integration and its purchase verification are implemented.
  const isCapacitorApp =
    typeof window !== 'undefined' &&
    typeof window.Capacitor?.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
  if (currentUser && !isCapacitorApp) {
    billingSection = document.createElement('div');
    billingSection.className = 'settings-section';

    const billingTitle = document.createElement('h2');
    billingTitle.textContent = t('settings.billing') || 'Billing & Plans';
    billingSection.appendChild(billingTitle);

    // Current plan + Flaxia+ card. `renderPlan()` writes the refs; the feature
    // list is static, so it renders once through `each`.
    let planName!: HTMLElement;
    let planMeta!: HTMLElement;
    let actionBtn!: HTMLButtonElement;

    const plusFeatures = signal<string[]>([
      t('settings.plan_plus_f1') || 'Unlimited custom stamps',
      t('settings.plan_plus_f2') || 'GIF & MP4 stamps/icons/intro',
      t('settings.plan_plus_f3') || 'Flaxia+ avatar checkmark badge',
    ]);

    displayMounts.push(
      mount(
        billingSection,
        () => html`
          <div
            style="padding: 1rem; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 1rem; background: var(--bg-secondary);"
          >
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;">
              ${t('settings.current_plan') || 'Current Plan'}
            </div>
            <div
              style="font-weight: 600; font-size: 1.125rem; color: var(--text-primary);"
              ref=${(element: Element | null) => {
                if (element) planName = element as HTMLElement;
              }}
            >
              ${t('settings.loading') || 'Loading...'}
            </div>
            <div
              style="font-size: 0.8125rem; color: var(--text-secondary); margin-top: 0.35rem;"
              ref=${(element: Element | null) => {
                if (element) planMeta = element as HTMLElement;
              }}
            ></div>
          </div>
          <div style="border: 2px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
            <div style="font-weight: 700; font-size: 1rem; color: #8b5cf6; margin-bottom: 0.25rem;">Flaxia+</div>
            <div style="margin-bottom: 0.75rem;">
              <span style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">¥300</span>
              <span style="font-size: 0.875rem; color: var(--text-muted);">/mo</span>
            </div>
            <ul style="list-style: none; padding: 0; margin: 0 0 0.5rem;">
              ${each(
                () => plusFeatures(),
                (feature) => feature,
                (feature) =>
                  html`<li style="font-size: 0.8125rem; color: var(--text-secondary); padding: 0.25rem 0;">
                    ${() => `✓ ${feature()}`}
                  </li>`,
              )}
            </ul>
            <button
              style="width: 100%; padding: 0.5rem; border: none; border-radius: 6px; background: #8b5cf6; color: white; font-weight: 600; font-size: 0.875rem; cursor: pointer; transition: opacity 0.2s;"
              ref=${(element: Element | null) => {
                if (element) actionBtn = element as unknown as HTMLButtonElement;
              }}
            ></button>
          </div>
        `,
      ),
    );

    actionBtn.addEventListener('mouseenter', () => {
      if (!actionBtn.disabled) actionBtn.style.opacity = '0.85';
    });
    actionBtn.addEventListener('mouseleave', () => {
      if (!actionBtn.disabled) actionBtn.style.opacity = '1';
    });

    // Billing history
    const historySection = document.createElement('div');
    const historyTitle = document.createElement('div');
    historyTitle.style.cssText =
      'font-weight: 600; font-size: 0.9375rem; color: var(--text-primary); margin: 0.5rem 0;';
    historyTitle.textContent = t('settings.billing_history') || 'Billing History';
    const historyList = document.createElement('div');
    historyList.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
    historySection.appendChild(historyTitle);
    historySection.appendChild(historyList);
    billingSection.appendChild(historySection);

    const historyStatus = document.createElement('div');
    historyStatus.style.cssText = 'font-size: 0.8125rem; color: var(--text-muted);';
    historyStatus.textContent = t('settings.loading') || 'Loading...';

    const historySignal = signal<BillingHistoryRow[]>([]);
    historyMount = mount(historyList, () =>
      each(
        () => historySignal(),
        (row) => row.key,
        (row) => {
          const value = row();
          const element = document.createElement('div');
          element.style.cssText =
            'display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem; color: var(--text-secondary); border-bottom: 1px solid var(--border); padding-bottom: 0.35rem;';
          const left = document.createElement('div');
          left.textContent = value.left;
          const right = document.createElement('div');
          right.textContent = value.right;
          element.appendChild(left);
          element.appendChild(right);
          return legacy(element);
        },
      ),
    );
    historyList.appendChild(historyStatus);

    const planNames: Record<string, string> = {
      flaxia_plus: 'Flaxia+ (¥300/mo)',
      flaxia_plus_plus: 'Flaxia++ (¥500/mo)',
      flaxia_sharp: 'Flaxia# (¥1000/mo)',
    };

    const formatDate = (iso: string | null): string => {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString(getLocale());
      } catch {
        return iso;
      }
    };

    const statusLabel = (status: string | null): string => {
      switch (status) {
        case 'active':
          return t('settings.status_active') || 'Active';
        case 'trialing':
          return t('settings.status_trialing') || 'Trial';
        case 'past_due':
          return t('settings.status_past_due') || 'Past due';
        case 'canceled':
          return t('settings.status_canceled') || 'Canceled';
        default:
          return status || '';
      }
    };

    actionBtn.addEventListener('click', async () => {
      actionBtn.disabled = true;
      const originalLabel = actionBtn.textContent || t('settings.subscribe') || 'Subscribe';
      actionBtn.textContent = t('settings.redirecting') || 'Redirecting...';
      try {
        const hasSubscription =
          !!currentPlan.plan && ['active', 'trialing', 'past_due'].includes(currentPlan.status || '');
        const endpoint = hasSubscription ? '/api/billing/portal' : '/api/billing/checkout';
        const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
        if (!hasSubscription) {
          init.body = JSON.stringify({ planId: 'flaxia_plus' });
        }
        const res = await fetch(endpoint, init);
        const data = (await res.json()) as { url?: string; error?: string };
        if (data.url) {
          window.location.href = data.url;
          return;
        }
        alert(data.error || t('settings.billing_error') || 'Failed to start billing');
      } catch {
        alert(t('settings.network_error') || 'Network error');
      }
      actionBtn.disabled = false;
      actionBtn.textContent = originalLabel;
    });

    const renderPlan = () => {
      const hasSubscription =
        !!currentPlan.plan && ['active', 'trialing', 'past_due'].includes(currentPlan.status || '');
      planName.textContent = currentPlan.plan
        ? planNames[currentPlan.plan] || currentPlan.plan
        : t('settings.free_plan') || 'Flaxia Free';

      if (!hasSubscription) {
        planMeta.textContent = '';
        actionBtn.textContent = t('settings.subscribe') || 'Subscribe';
        actionBtn.style.background = '#8b5cf6';
        return;
      }

      const date = formatDate(currentPlan.expiresAt);
      if (currentPlan.status === 'past_due') {
        planMeta.textContent = t('settings.past_due_notice') || 'Payment past due.';
      } else if (currentPlan.cancelAtPeriodEnd) {
        planMeta.textContent = date
          ? t('settings.cancels_on', { date }) || `Cancels on ${date}`
          : t('settings.status_canceled') || 'Canceled';
      } else {
        const label = statusLabel(currentPlan.status);
        planMeta.textContent = date ? `${label} · ${t('settings.renews_on', { date }) || `Renews on ${date}`}` : label;
      }
      actionBtn.textContent = t('settings.manage_subscription') || 'Manage / Cancel';
      actionBtn.style.background = 'var(--accent)';
    };

    const renderHistory = (transactions: Array<Record<string, unknown>>) => {
      const txStatus = (status: unknown): string => {
        const key = `settings.status_${String(status)}`;
        const translated = t(key);
        return translated !== key ? translated : String(status);
      };
      const rows: BillingHistoryRow[] = transactions.slice(0, 10).map((tx) => {
        const datePart = formatDate((tx.createdAt as string) || null);
        const namePart = (tx.planName as string) || (tx.type as string) || '';
        const amount = Number(tx.amount ?? 0);
        const left = [datePart, namePart].filter(Boolean).join(' · ');
        const right = `${amount.toLocaleString()} ${String(tx.currency || 'jpy').toUpperCase()} · ${txStatus(tx.status)}`;
        return { key: `${left}|${right}`, left, right };
      });

      historySignal.set(rows);
      historyStatus.hidden = rows.length > 0;
      if (rows.length === 0) historyStatus.textContent = t('settings.no_billing_history') || 'No payments yet';
    };

    const loadBilling = async () => {
      try {
        const [planRes, txRes] = await Promise.all([fetch('/api/billing/plan'), fetch('/api/billing/transactions')]);
        if (planRes.ok) {
          currentPlan = (await planRes.json()) as typeof currentPlan;
        }
        if (txRes.ok) {
          const data = (await txRes.json()) as { transactions?: Array<Record<string, unknown>> };
          renderHistory(data.transactions || []);
        } else {
          renderHistory([]);
        }
      } catch {
        renderHistory([]);
      }
      renderPlan();
      refreshStamps();
    };

    void loadBilling();
  }

  // Maps section (Svelte): on-device tile cache + city tile packs.
  const mapsMount = mountSettingsSection(SettingsMapsSection);
  const mapsSection = mapsMount.element;

  if (accountSection) {
    addCategory({
      id: 'account',
      groupKey: 'settings.group_account',
      titleKey: 'settings.account',
      descriptionKey: 'settings.account_description',
      iconName: 'user',
      sections: [accountSection, emailSection],
    });
  }
  if (vaultSection) {
    addCategory({
      id: 'security',
      groupKey: 'settings.group_account',
      titleKey: 'settings.security',
      descriptionKey: 'settings.security_description',
      iconName: 'key',
      sections: [passwordSection, vaultSection.getElement()],
    });
  }
  addCategory({
    id: 'appearance',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.appearance',
    descriptionKey: 'settings.appearance_description',
    iconName: 'settings',
    sections: [displaySection, languageSection],
  });
  if (emojiSection) {
    addCategory({
      id: 'emoji',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.custom_emoji',
      descriptionKey: 'settings.emoji_description',
      iconName: 'emoji',
      sections: [emojiSection],
    });
  }
  if (titlesSection) {
    addCategory({
      id: 'titles',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.titles',
      descriptionKey: 'settings.titles_description',
      iconName: 'game',
      sections: [titlesSection],
    });
  }
  if (billingSection) {
    addCategory({
      id: 'billing',
      groupKey: 'settings.group_more',
      titleKey: 'settings.billing',
      descriptionKey: 'settings.billing_description',
      iconName: 'fresh',
      sections: [billingSection],
    });
  }
  addCategory({
    id: 'crowd',
    groupKey: 'settings.group_more',
    titleKey: 'settings.crowd',
    descriptionKey: 'settings.crowd_description',
    iconName: 'poll',
    sections: [crowdSection],
  });
  addCategory({
    id: 'maps',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.maps',
    descriptionKey: 'settings.maps_description',
    iconName: 'maps',
    sections: [mapsSection],
  });
  addCategory({
    id: 'bug-report',
    groupKey: 'settings.group_other',
    titleKey: 'settings.bug_report',
    descriptionKey: 'settings.bug_report_description',
    iconName: 'flag',
    sections: [bugReportForm.getElement()],
  });
  return {
    categories,
    destroy: () => {
      titlesMount?.destroy();
      stampsMount?.dispose();
      historyMount?.dispose();
      for (const mounted of displayMounts) mounted.dispose();
      displayMounts.length = 0;
      vaultSection?.destroy();
      bugReportForm.destroy();
      mapsMount.destroy();
      crowdMount.destroy();
      accountMount?.destroy();
      emailMount.destroy();
      passwordMount.destroy();
      displayMount.destroy();
      languageMount.destroy();
    },
  };
}
