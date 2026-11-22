<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { getLocale, t } from '../i18n.ts';

interface Plan {
  plan: string | null;
  planName?: string | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd: boolean;
}

interface HistoryRow {
  key: string;
  left: string;
  right: string;
}

const planNames: Record<string, string> = {
  flaxia_plus: 'Flaxia+ (¥300/mo)',
  flaxia_plus_plus: 'Flaxia++ (¥500/mo)',
  flaxia_sharp: 'Flaxia# (¥1000/mo)',
};

const plusFeatures = [
  t('settings.plan_plus_f1') || 'Unlimited custom stamps',
  t('settings.plan_plus_f2') || 'GIF & MP4 stamps/icons/intro',
  t('settings.plan_plus_f3') || 'Flaxia+ avatar checkmark badge',
];

let plan = $state<Plan>({
  plan: null,
  status: null,
  expiresAt: null,
  cancelAtPeriodEnd: false,
});
let history = $state<HistoryRow[]>([]);
let loaded = $state(false);
let busy = $state(false);

const hasSubscription = $derived(Boolean(plan.plan) && ['active', 'trialing', 'past_due'].includes(plan.status ?? ''));
const planLabel = $derived(plan.plan ? planNames[plan.plan] || plan.plan : t('settings.free_plan') || 'Flaxia Free');
const planMeta = $derived.by(() => {
  if (!hasSubscription) return '';
  const date = formatDate(plan.expiresAt);
  if (plan.status === 'past_due') return t('settings.past_due_notice') || 'Payment past due.';
  if (plan.cancelAtPeriodEnd) {
    return date
      ? t('settings.cancels_on', { date }) || `Cancels on ${date}`
      : t('settings.status_canceled') || 'Canceled';
  }
  const label = statusLabel(plan.status);
  return date ? `${label} · ${t('settings.renews_on', { date }) || `Renews on ${date}`}` : label;
});
const actionLabel = $derived(
  hasSubscription ? t('settings.manage_subscription') || 'Manage / Cancel' : t('settings.subscribe') || 'Subscribe',
);

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(getLocale());
  } catch {
    return iso;
  }
}

function statusLabel(status: string | null): string {
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
}

function transactionRows(transactions: Array<Record<string, unknown>>): HistoryRow[] {
  return transactions.slice(0, 10).map((tx) => {
    const datePart = formatDate((tx.createdAt as string) || null);
    const namePart = (tx.planName as string) || (tx.type as string) || '';
    const amount = Number(tx.amount ?? 0);
    const statusKey = `settings.status_${String(tx.status)}`;
    const translated = t(statusKey);
    const status = translated !== statusKey ? translated : String(tx.status);
    const left = [datePart, namePart].filter(Boolean).join(' · ');
    const right = `${amount.toLocaleString()} ${String(tx.currency || 'jpy').toUpperCase()} · ${status}`;
    return { key: `${left}|${right}`, left, right };
  });
}

async function load(): Promise<void> {
  try {
    const [planResponse, txResponse] = await Promise.all([
      fetch('/api/billing/plan', { credentials: 'include' }),
      fetch('/api/billing/transactions', { credentials: 'include' }),
    ]);
    if (planResponse.ok) {
      plan = (await planResponse.json()) as Plan;
    }
    if (txResponse.ok) {
      const data = (await txResponse.json()) as { transactions?: Array<Record<string, unknown>> };
      history = transactionRows(data.transactions ?? []);
    } else {
      history = [];
    }
  } catch {
    history = [];
  } finally {
    loaded = true;
  }
}

async function manage(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const endpoint = hasSubscription ? '/api/billing/portal' : '/api/billing/checkout';
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (!hasSubscription) init.body = JSON.stringify({ planId: 'flaxia_plus' });
    const response = await fetch(endpoint, init);
    const data = (await response.json()) as { url?: string; error?: string };
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    alert(data.error || t('settings.billing_error') || 'Failed to start billing');
  } catch {
    alert(t('settings.network_error') || 'Network error');
  } finally {
    busy = false;
  }
}

onMount(() => {
  void load();
});
</script>

<h2>{t('settings.billing') || 'Billing & Plans'}</h2>

<div class="billing-plan">
  <div class="billing-plan-label">{t('settings.current_plan') || 'Current Plan'}</div>
  <div class="billing-plan-name">{planLabel}</div>
  <div class="billing-plan-meta">{planMeta}</div>
</div>

<div class="billing-plus">
  <div class="billing-plus-title">Flaxia+</div>
  <div class="billing-price">
    <span class="billing-price-amount">¥300</span>
    <span class="billing-price-period">/mo</span>
  </div>
  <ul class="billing-features">
    {#each plusFeatures as feature (feature)}
      <li>✓ {feature}</li>
    {/each}
  </ul>
  <button
    type="button"
    class="billing-action"
    class:billing-action--manage={hasSubscription}
    disabled={busy}
    onclick={() => void manage()}
  >
    {busy ? t('settings.redirecting') || 'Redirecting...' : actionLabel}
  </button>
</div>

<div class="billing-history">
  <div class="billing-history-title">{t('settings.billing_history') || 'Billing History'}</div>
  {#each history as row (row.key)}
    <div class="billing-history-row">
      <div>{row.left}</div>
      <div>{row.right}</div>
    </div>
  {/each}
  {#if loaded && history.length === 0}
    <div class="billing-history-empty">{t('settings.no_billing_history') || 'No payments yet'}</div>
  {/if}
</div>

<style>
  .billing-plan {
    padding: 1rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .billing-plan-label {
    margin-bottom: 0.5rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .billing-plan-name {
    color: var(--text-primary);
    font-size: 1.125rem;
    font-weight: 600;
  }

  .billing-plan-meta {
    margin-top: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .billing-plus {
    padding: 1rem;
    margin-bottom: 1rem;
    border: 2px solid var(--border);
    border-radius: 8px;
  }

  .billing-plus-title {
    margin-bottom: 0.25rem;
    color: #8b5cf6;
    font-size: 1rem;
    font-weight: 700;
  }

  .billing-price {
    margin-bottom: 0.75rem;
  }

  .billing-price-amount {
    color: var(--text-primary);
    font-size: 1.5rem;
    font-weight: 700;
  }

  .billing-price-period {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .billing-features {
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
  }

  .billing-features li {
    padding: 0.25rem 0;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .billing-action {
    width: 100%;
    padding: 0.5rem;
    border: 0;
    border-radius: 6px;
    background: #8b5cf6;
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .billing-action--manage {
    background: var(--accent);
  }

  .billing-action:hover {
    opacity: 0.85;
  }

  .billing-history-title {
    margin: 0.5rem 0;
    color: var(--text-primary);
    font-size: 0.9375rem;
    font-weight: 600;
  }

  .billing-history-row {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .billing-history-empty {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
</style>
