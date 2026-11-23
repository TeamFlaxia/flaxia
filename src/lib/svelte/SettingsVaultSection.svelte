<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these

import { toDataURL } from 'qrcode';
import { onDestroy, onMount, tick } from 'svelte';
import { encodeB64 } from '../../../shared/vault/primitives.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { getLocale, t } from '../i18n.ts';
import { passwordLengthError } from '../password-policy.js';
import {
  approvePairing,
  cancelPairing,
  type DeviceSummary,
  fetchVaultKeys,
  listDevices,
  pollPairing,
  startPairing,
} from '../vault/client.js';
import { detectDeviceLabel, getCurrentDeviceId } from '../vault/device.js';
import {
  buildPairingUri,
  generateEphemeralKeyPair,
  PAIRING_URI_PREFIX,
  parsePairingUri,
  wrapVaultKeyForPairing,
} from '../vault/pairing.js';
import {
  adoptPairedVaultKey,
  enableVault,
  generateRecoveryPhrase,
  getVaultKey,
  isVaultUnlocked,
  lockVault,
  revokeDeviceWithRotation,
  tryDeviceUnlock,
  unlockVault,
} from '../vault/session.js';
import PrivateNotesSection from './PrivateNotesSection.svelte';

type View = 'loading' | 'setup' | 'phrase' | 'locked' | 'pairJoin' | 'unlocked' | 'scan';

interface QrDetection {
  rawValue?: string;
}
interface QrDetector {
  detect(source: HTMLVideoElement): Promise<QrDetection[]>;
}
type QrDetectorCtor = new (options: { formats: string[] }) => QrDetector;

let view = $state<View>('loading');
let message = $state('');
let messageKind = $state<'error' | 'info'>('error');
let setupPassword = $state('');
let unlockPassword = $state('');
let pendingPassword = '';
let pendingPhrase = $state('');
let phraseSaved = $state(false);
let copyLabel = $state('');
let pairingId = $state<string | null>(null);
let qrSrc = $state('');
let devices = $state<DeviceSummary[]>([]);
let currentDeviceId = $state<string | null>(null);
let manualCode = $state('');
let scanMessage = $state('');
let scanNote = $state('');
let scanningNote = $state('');
let busy = $state(false);
let video = $state<HTMLVideoElement>();
let stream: MediaStream | null = null;
let pollTimer: number | null = null;
let scanTimer: number | null = null;
let scanning = false;
let pairingSecret: Uint8Array | null = null;
let pairingPub: Uint8Array | null = null;

const badge = $derived(
  view === 'unlocked' || view === 'scan'
    ? { text: t('settings.vault_status_unlocked'), color: 'var(--accent)' }
    : view === 'setup' || view === 'phrase' || view === 'loading'
      ? { text: t('settings.vault_status_disabled'), color: 'var(--text-secondary)' }
      : { text: t('settings.vault_status_locked'), color: 'var(--danger)' },
);
const words = $derived(pendingPhrase ? pendingPhrase.split(' ') : []);
const pairingUri = $derived(pairingId && pairingPub ? buildPairingUri(pairingId, pairingPub) : '');

function msgColor(kind: 'error' | 'info'): string {
  return kind === 'error' ? 'var(--danger)' : 'var(--accent)';
}

function show(text: string, kind: 'error' | 'info' = 'error'): void {
  message = text;
  messageKind = kind;
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function discardPairingSecret(): void {
  pairingSecret?.fill(0);
  pairingSecret = null;
  pairingPub = null;
}

function stopCamera(): void {
  if (scanTimer !== null) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  scanning = false;
}

async function startJoinPairing(): Promise<void> {
  stopPoll();
  discardPairingSecret();
  const ephemeral = generateEphemeralKeyPair();
  pairingSecret = ephemeral.secretKey;
  pairingPub = ephemeral.publicKey;
  const started = await startPairing(detectDeviceLabel(), encodeB64(ephemeral.publicKey));
  if (!started) {
    discardPairingSecret();
    show(t('settings.network_error'));
    return;
  }
  pairingId = started.id;
  message = '';
  view = 'pairJoin';
  pollTimer = window.setInterval(() => void pollJoin(), 2000);
}

async function pollJoin(): Promise<void> {
  if (!pairingId) return;
  const state = await pollPairing(pairingId);
  if (!state) return;
  if (state.state === 'active' && state.wrapped_vk) {
    stopPoll();
    const secret = pairingSecret;
    const adopted =
      secret !== null && state.approved_pub !== undefined
        ? await adoptPairedVaultKey(state.wrapped_vk, state.id, secret, state.approved_pub)
        : false;
    discardPairingSecret();
    pairingId = null;
    currentDeviceId = getCurrentDeviceId();
    if (adopted) {
      devices = await listDevices();
      view = 'unlocked';
      show(t('settings.vault_pair_approved'), 'info');
    } else {
      view = 'locked';
      show(t('settings.vault_error'));
    }
    return;
  }
  if (state.state === 'expired') {
    stopPoll();
    discardPairingSecret();
    pairingId = null;
    view = 'locked';
    show(t('settings.vault_pair_expired'));
  }
}

async function cancelJoin(): Promise<void> {
  if (pairingId) void cancelPairing(pairingId);
  stopPoll();
  discardPairingSecret();
  pairingId = null;
  view = 'locked';
  message = '';
}

async function enable(): Promise<void> {
  busy = true;
  const result = await enableVault(pendingPassword, pendingPhrase);
  busy = false;
  if (result.ok) {
    pendingPassword = '';
    pendingPhrase = '';
    currentDeviceId = getCurrentDeviceId();
    devices = await listDevices();
    view = 'unlocked';
    show(t('settings.vault_enabled'), 'info');
    return;
  }
  if (result.error === 'already_exists') {
    pendingPassword = '';
    pendingPhrase = '';
    view = 'locked';
    show(t('settings.vault_enable_exists'));
    return;
  }
  show(result.error === 'network' ? t('settings.network_error') : t('settings.vault_enable_failed'));
}

async function unlock(): Promise<void> {
  const password = unlockPassword;
  if (!password || busy) return;
  busy = true;
  const outcome = await unlockVault(password);
  busy = false;
  if (outcome === 'ok') {
    currentDeviceId = getCurrentDeviceId();
    devices = await listDevices();
    view = 'unlocked';
    message = '';
    return;
  }
  show(
    outcome === 'wrong'
      ? t('settings.vault_wrong_password')
      : outcome === 'network'
        ? t('settings.network_error')
        : t('settings.vault_error'),
  );
}

async function revoke(device: DeviceSummary): Promise<void> {
  if (!(await confirmDialog(t('settings.vault_revoke_confirm')))) return;
  const password = window.prompt(t('settings.vault_password')) ?? '';
  if (!password) return;
  const phrase = window.prompt(t('settings.vault_phrase_title')) ?? '';
  if (!phrase) return;
  if (await revokeDeviceWithRotation(device.id, password, phrase)) {
    devices = await listDevices();
  } else {
    show(t('settings.vault_revoke_failed'));
  }
}

async function approveFromText(text: string): Promise<void> {
  const parsed = parsePairingUri(text);
  if (!parsed) {
    scanMessage = t('settings.vault_pair_invalid');
    return;
  }
  const vaultKey = getVaultKey();
  if (!vaultKey) {
    stopCamera();
    view = 'locked';
    show(t('settings.vault_error'));
    return;
  }
  const ephemeral = generateEphemeralKeyPair();
  try {
    const wrapped = await wrapVaultKeyForPairing(vaultKey, ephemeral.secretKey, parsed.publicKey, parsed.pairingId);
    const result = await approvePairing(
      parsed.pairingId,
      encodeB64(parsed.publicKey),
      encodeB64(ephemeral.publicKey),
      wrapped,
    );
    if (result === 'ok') {
      stopCamera();
      devices = await listDevices();
      view = 'unlocked';
      show(t('settings.vault_pair_scan_done'), 'info');
      return;
    }
    scanMessage =
      result === 'reused'
        ? t('settings.vault_pair_reused')
        : result === 'expired'
          ? t('settings.vault_pair_expired')
          : t('settings.vault_error');
  } finally {
    ephemeral.secretKey.fill(0);
  }
}

async function startCamera(): Promise<void> {
  const Detector = (window as unknown as { BarcodeDetector?: QrDetectorCtor }).BarcodeDetector;
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    scanningNote = t('settings.vault_camera_unavailable');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    scanningNote = t('settings.vault_camera_unavailable');
    return;
  }
  if (!video) return;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    stopCamera();
    scanningNote = t('settings.vault_camera_unavailable');
    return;
  }
  const detector = new Detector({ formats: ['qr_code'] });
  scanTimer = window.setInterval(() => {
    if (scanning || !stream || !video) return;
    scanning = true;
    detector
      .detect(video)
      .then((found) => {
        const hit = found.find(
          (candidate) => typeof candidate.rawValue === 'string' && candidate.rawValue.startsWith(PAIRING_URI_PREFIX),
        );
        if (hit?.rawValue) {
          stopCamera();
          void approveFromText(hit.rawValue);
        }
      })
      .catch(() => {
        // Ignore frames the decoder rejects.
      })
      .finally(() => {
        scanning = false;
      });
  }, 400);
}

$effect(() => {
  if (view !== 'pairJoin' || !pairingUri) {
    qrSrc = '';
    return;
  }
  let cancelled = false;
  void toDataURL(pairingUri, { margin: 1, width: 256 })
    .then((src) => {
      if (!cancelled) qrSrc = src;
    })
    .catch(() => {
      if (!cancelled) qrSrc = '';
    });
  return () => {
    cancelled = true;
  };
});

$effect(() => {
  if (view !== 'scan') return;
  void tick().then(() => void startCamera());
  return () => stopCamera();
});

onMount(() => {
  void (async () => {
    const keys = await fetchVaultKeys();
    currentDeviceId = getCurrentDeviceId();
    if (!keys?.enabled) {
      view = 'setup';
      return;
    }
    if (isVaultUnlocked()) {
      devices = await listDevices();
      view = 'unlocked';
      return;
    }
    view = 'locked';
    if (await tryDeviceUnlock()) {
      currentDeviceId = getCurrentDeviceId();
      devices = await listDevices();
      view = 'unlocked';
    }
  })();
});

onDestroy(() => {
  stopPoll();
  stopCamera();
  discardPairingSecret();
});
</script>

<div class="vault-section">
  <h2>{t('settings.vault')}</h2>
  <p class="vault-muted">{t('settings.vault_desc')}</p>
  <span class="vault-badge" style:color={badge.color} style:border-color={badge.color}>{badge.text}</span>

  {#if view === 'loading'}
    <p class="vault-muted">{t('settings.vault_awaiting')}</p>
  {:else if view === 'setup'}
    <label class="vault-label" for="vault-setup-password">{t('settings.vault_password')}</label>
    <input
      id="vault-setup-password"
      class="vault-input"
      type="password"
      autocomplete="current-password"
      placeholder={t('settings.vault_password_ph')}
      bind:value={setupPassword}
    />
    <button
      type="button"
      class="vault-button"
      onclick={() => {
        if (passwordLengthError(setupPassword)) {
          show(t('settings.password_length'));
          return;
        }
        pendingPassword = setupPassword;
        pendingPhrase = generateRecoveryPhrase();
        phraseSaved = false;
        message = '';
        view = 'phrase';
      }}
    >
      {t('settings.vault_setup')}
    </button>
  {:else if view === 'phrase'}
    <h3 class="vault-subtitle">{t('settings.vault_phrase_title')}</h3>
    <p class="vault-warning">{t('settings.vault_phrase_warning')}</p>
    <div class="vault-phrase">
      {#each words as word, index (index)}
        <span>{index + 1}. {word}</span>
      {/each}
    </div>
    <button
      type="button"
      class="vault-button vault-button--secondary"
      onclick={() => {
        void navigator.clipboard
          ?.writeText(pendingPhrase)
          .then(() => {
            copyLabel = t('settings.vault_phrase_copied');
          })
          .catch(() => {
            copyLabel = t('settings.vault_error');
          });
      }}
    >
      {copyLabel || t('settings.vault_phrase_copy')}
    </button>
    <label class="vault-confirm">
      <input type="checkbox" bind:checked={phraseSaved} />
      <span>{t('settings.vault_phrase_confirm')}</span>
    </label>
    <div class="vault-actions">
      <button
        type="button"
        class="vault-button vault-button--secondary"
        onclick={() => {
          pendingPhrase = '';
          pendingPassword = '';
          view = 'setup';
          message = '';
        }}
      >
        {t('settings.vault_phrase_back')}
      </button>
      <button type="button" class="vault-button" disabled={!phraseSaved || busy} onclick={() => void enable()}>
        {busy ? t('settings.vault_working') : t('settings.vault_enable')}
      </button>
    </div>
  {:else if view === 'locked'}
    <p class="vault-muted">{t('settings.vault_locked_hint')}</p>
    <label class="vault-label" for="vault-unlock-password">{t('settings.vault_password')}</label>
    <input
      id="vault-unlock-password"
      class="vault-input"
      type="password"
      autocomplete="current-password"
      placeholder={t('settings.vault_password_ph')}
      bind:value={unlockPassword}
      onkeydown={(event) => {
        if (event.key === 'Enter') void unlock();
      }}
    />
    <button type="button" class="vault-button" disabled={busy} onclick={() => void unlock()}>
      {busy ? t('settings.vault_working') : t('settings.vault_unlock')}
    </button>
    <div class="vault-actions">
      <button type="button" class="vault-button vault-button--secondary" onclick={() => void startJoinPairing()}>
        {t('settings.vault_pair_this')}
      </button>
    </div>
  {:else if view === 'pairJoin'}
    <h3 class="vault-subtitle">{t('settings.vault_pair_join_title')}</h3>
    <p class="vault-muted">{t('settings.vault_pair_join_hint')}</p>
    {#if qrSrc}
      <img class="vault-qr" src={qrSrc} alt="pairing QR code" />
    {/if}
    <code class="vault-pair-code">{pairingUri}</code>
    <p class="vault-info">{t('settings.vault_pair_waiting')}</p>
    <div class="vault-actions">
      <button type="button" class="vault-button vault-button--secondary" onclick={() => void cancelJoin()}>
        {t('settings.vault_pair_cancel')}
      </button>
    </div>
  {:else if view === 'unlocked'}
    <h3 class="vault-subtitle">{t('settings.vault_devices')}</h3>
    {#if devices.length === 0}
      <p class="vault-muted">{t('settings.vault_no_devices')}</p>
    {/if}
    {#each devices as device (device.id)}
      <div class="vault-device">
        <div>
          <div class="vault-device-name">
            {device.id === currentDeviceId
              ? `${device.label} · ${t('settings.vault_device_this')}`
              : device.label}
          </div>
          <div class="vault-device-meta">
            {device.state === 'pending'
              ? `${t('settings.vault_device_pending')} · ${t('settings.vault_device_added')} ${new Date(device.created_at).toLocaleDateString(getLocale())}`
              : `${t('settings.vault_device_added')} ${new Date(device.created_at).toLocaleDateString(getLocale())}`}
          </div>
        </div>
        {#if device.id !== currentDeviceId}
          <button type="button" class="vault-danger" onclick={() => void revoke(device)}>
            {t('settings.vault_revoke')}
          </button>
        {/if}
      </div>
    {/each}
    <div class="vault-actions">
      <button type="button" class="vault-button" onclick={() => (view = 'scan')}>
        {t('settings.vault_add_device')}
      </button>
      <button
        type="button"
        class="vault-button vault-button--secondary"
        onclick={() => {
          lockVault();
          view = 'locked';
          message = '';
        }}
      >
        {t('settings.vault_lock')}
      </button>
    </div>
    <PrivateNotesSection />
  {:else}
    <h3 class="vault-subtitle">{t('settings.vault_pair_scan_title')}</h3>
    <p class="vault-muted">{t('settings.vault_pair_scan_hint')}</p>
    <video class="vault-video" bind:this={video} muted playsinline></video>
    <p class="vault-muted">{scanningNote}</p>
    <div class="vault-manual">
      <input class="vault-input" placeholder={t('settings.vault_pair_manual_ph')} bind:value={manualCode} />
      <button type="button" class="vault-button" onclick={() => void approveFromText(manualCode)}>
        {t('settings.vault_pair_approve')}
      </button>
    </div>
    <div class="vault-actions">
      <button
        type="button"
        class="vault-button vault-button--secondary"
        onclick={() => {
          stopCamera();
          view = 'unlocked';
        }}
      >
        {t('settings.vault_pair_cancel')}
      </button>
    </div>
    {#if scanMessage}
      <div class="vault-message vault-message--error">{scanMessage}</div>
    {/if}
  {/if}

  {#if message && view !== 'scan'}
    <div class="vault-message" style:color={msgColor(messageKind)}>{message}</div>
  {/if}
</div>

<style>
  .vault-muted {
    margin: 0.5rem 0;
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .vault-badge {
    display: inline-block;
    margin-bottom: 1rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .vault-label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .vault-input {
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 1rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
  }

  .vault-button {
    padding: 0.6rem 1.25rem;
    border: 0;
    border-radius: 4px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.9rem;
    cursor: pointer;
  }

  .vault-button--secondary {
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .vault-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .vault-subtitle {
    margin: 1rem 0 0.5rem;
    color: var(--text-primary);
    font-size: 0.95rem;
    font-weight: 600;
  }

  .vault-warning {
    margin: 0.5rem 0;
    color: var(--danger);
    font-size: 0.85rem;
    font-weight: 500;
    line-height: 1.4;
  }

  .vault-info {
    margin: 0.75rem 0;
    color: var(--accent);
    font-size: 0.85rem;
  }

  .vault-message {
    margin-top: 0.75rem;
    min-height: 1.1em;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .vault-message--error {
    color: var(--danger);
  }

  .vault-phrase {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.4rem;
    margin: 0.75rem 0;
  }

  .vault-phrase span {
    padding: 0.4rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-family: monospace;
    font-size: 0.78rem;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .vault-confirm {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    color: var(--text-primary);
    font-size: 0.9rem;
    cursor: pointer;
  }

  .vault-qr {
    display: block;
    width: 220px;
    height: 220px;
    margin: 0.75rem auto;
    padding: 10px;
    border-radius: 8px;
    background: #fff;
  }

  .vault-pair-code {
    display: block;
    color: var(--text-secondary);
    font-size: 0.7rem;
    overflow-wrap: anywhere;
  }

  .vault-device {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--border);
  }

  .vault-device-name {
    color: var(--text-primary);
    font-size: 0.9rem;
    font-weight: 500;
  }

  .vault-device-meta {
    margin-top: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .vault-danger {
    padding: 0.35rem 0.75rem;
    border: 0;
    border-radius: 4px;
    background: var(--danger);
    color: #fff;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .vault-video {
    display: block;
    width: 100%;
    max-width: 340px;
    margin: 0.5rem 0;
    border-radius: 8px;
    aspect-ratio: 4 / 3;
    background: #000;
  }

  .vault-manual {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .vault-manual .vault-input {
    flex: 1;
    min-width: 200px;
    margin-bottom: 0;
  }
</style>
