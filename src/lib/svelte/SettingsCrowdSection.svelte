<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import {
  CROWD_CONSENT_CHANGE_EVENT,
  canRunFlaxiaNode,
  denyCrowdConsent,
  getCrowdConsentState,
  getCrowdNodeController,
  grantCrowdConsent,
  initCrowdNode,
  resolveCrowdConsentState,
  startCrowdNode,
  stopCrowdNode,
} from '../crowd-node.js';
import { t } from '../i18n.ts';

const available = canRunFlaxiaNode();
let checked = $state(getCrowdConsentState() === 'granted');
let granted = $state(getCrowdConsentState() === 'granted');
let status = $state('');
let message = $state('');
let messageTone = $state<'accent' | 'danger'>('accent');

function updateStatus(): void {
  if (!available) {
    status = t('settings.crowd_unavailable');
    return;
  }
  const state = getCrowdConsentState();
  granted = state === 'granted';
  status =
    state === 'granted'
      ? t('settings.crowd_running')
      : state === 'denied'
        ? t('settings.crowd_denied')
        : t('settings.crowd_unset');
}

async function toggle(next: boolean): Promise<void> {
  if (!available) return;
  if (!getCrowdNodeController()) {
    try {
      await initCrowdNode();
    } catch {
      // fall through to the availability check below
    }
  }
  if (!getCrowdNodeController()) {
    message = t('settings.crowd_unavailable');
    messageTone = 'danger';
    checked = false;
    return;
  }
  checked = next;
  if (next) {
    grantCrowdConsent();
    startCrowdNode();
  } else {
    denyCrowdConsent();
    stopCrowdNode();
  }
  updateStatus();
  message = t('settings.crowd_saved');
  messageTone = 'accent';
}

function onConsentChange(): void {
  checked = getCrowdConsentState() === 'granted';
  updateStatus();
}

onMount(() => {
  updateStatus();
  window.addEventListener(CROWD_CONSENT_CHANGE_EVENT, onConsentChange);
  void resolveCrowdConsentState().then(onConsentChange);
  return () => window.removeEventListener(CROWD_CONSENT_CHANGE_EVENT, onConsentChange);
});
</script>

<h2>{t('settings.crowd')}</h2>
<label class:settings-switch-row={available} class:settings-switch-row--disabled={!available}>
  <div class="settings-switch-text">
    <span class="settings-switch-name">{t('settings.crowd')}</span>
    <span class="settings-switch-desc">{t('settings.crowd_desc')}</span>
  </div>
  <input
    class="settings-switch"
    type="checkbox"
    checked={checked}
    disabled={!available}
    onchange={(event) => void toggle(event.currentTarget.checked)}
  />
</label>
<div class="settings-status settings-status--sm" style:color={granted ? 'var(--accent-text)' : 'var(--text-muted)'}>
  {status}
</div>
<div
  class="settings-status"
  role="status"
  style:color={message ? (messageTone === 'accent' ? 'var(--accent-text)' : 'var(--danger-text)') : undefined}
>
  {message}
</div>
