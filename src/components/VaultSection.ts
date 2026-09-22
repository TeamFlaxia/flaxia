// Personal vault section for Settings (docs/e2ee.md).
//
// Three states a user can be in: no vault yet (setup + recovery phrase), a
// locked vault (password, or pair this device via QR), and an unlocked vault
// (device list, scanner, revoke). Every piece of key handling lives in
// lib/vault/session — this file arranges text boxes and calls it, so there is
// no second place where VK could leak into storage.
//
// QR scanning uses BarcodeDetector where the browser has it (Chromium,
// Safari); everywhere else the code can be pasted, which is also the fallback
// for desktops without a camera. Reading the code IS the second factor
// (docs/e2ee.md, "Pairing a second device").
import { toDataURL } from 'qrcode';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { getLocale, t } from '../lib/i18n.js';
import { passwordLengthError } from '../lib/password-policy.js';
import {
  approvePairing,
  cancelPairing,
  type DeviceSummary,
  fetchVaultKeys,
  listDevices,
  pollPairing,
  revokeDevice,
  startPairing,
} from '../lib/vault/client.js';
import { detectDeviceLabel, getCurrentDeviceId } from '../lib/vault/device.js';
import {
  buildPairingUri,
  generateEphemeralKeyPair,
  PAIRING_URI_PREFIX,
  parsePairingUri,
  wrapVaultKeyForPairing,
} from '../lib/vault/pairing.js';
import { encodeB64 } from '../lib/vault/primitives.js';
import {
  adoptPairedVaultKey,
  enableVault,
  generateRecoveryPhrase,
  getVaultKey,
  isVaultUnlocked,
  lockVault,
  tryDeviceUnlock,
  unlockVault,
} from '../lib/vault/session.js';

type View = 'loading' | 'setup' | 'phrase' | 'locked' | 'pairJoin' | 'unlocked' | 'scan';

interface QrDetection {
  rawValue?: string;
}
interface QrDetector {
  detect(source: HTMLVideoElement): Promise<QrDetection[]>;
}
type QrDetectorCtor = new (options: { formats: string[] }) => QrDetector;

const SECTION_CSS = `
  margin-bottom: 2rem;
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
`;
const TITLE_CSS = `
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 1rem;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.5rem;
`;
const SUBTITLE_CSS = `
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 1rem 0 0.5rem 0;
`;
const LABEL_CSS = `display:block;margin-bottom:0.5rem;font-weight:500;color:var(--text-primary);`;
const INPUT_CSS = `
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 1rem;
  border-radius: 4px;
  box-sizing: border-box;
`;
const BUTTON_CSS = `
  padding: 0.6rem 1.25rem;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-size: 0.9rem;
`;
const SECONDARY_CSS = `
  padding: 0.6rem 1.25rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.9rem;
`;
const DANGER_CSS = `
  padding: 0.35rem 0.75rem;
  border: none;
  border-radius: 4px;
  background: var(--danger);
  color: #fff;
  cursor: pointer;
  font-size: 0.8rem;
`;
const MUTED_CSS = `font-size:0.85rem;color:var(--text-secondary);line-height:1.5;margin:0.5rem 0;`;
const MESSAGE_CSS = `font-size:0.85rem;margin-top:0.75rem;min-height:1.1em;line-height:1.4;`;
const BUTTON_ROW_CSS = `display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:1rem;align-items:center;`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function messageElement(kind: 'error' | 'info', text: string): HTMLElement {
  return el('div', `${MESSAGE_CSS}color:${kind === 'error' ? 'var(--danger)' : 'var(--accent)'};`, text);
}

export function createVaultSection() {
  const container = el('div', SECTION_CSS);
  container.className = 'settings-section';

  const title = el('h2', TITLE_CSS, t('settings.vault'));
  const desc = el('p', MUTED_CSS, t('settings.vault_desc'));
  const badge = el('span', '');
  const body = el('div');
  container.appendChild(title);
  container.appendChild(desc);
  container.appendChild(badge);
  container.appendChild(body);

  let view: View = 'loading';
  let message = '';
  let messageKind: 'error' | 'info' = 'error';

  // Setup flow. The password lives only in this closure between the two
  // steps; it is proven to the server (SRP) and never stored or sent as-is.
  let pendingPassword = '';
  let pendingPhrase = '';
  let phraseSaved = false;

  // Joiner side: our ephemeral private half, kept until the QR is approved.
  let pairingId: string | null = null;
  let pairingSecret: Uint8Array | null = null;
  let pairingPub: Uint8Array | null = null;
  let pollTimer: number | null = null;

  // Approver side: the camera stream and its detection loop.
  let mediaStream: MediaStream | null = null;
  let scanTimer: number | null = null;
  let scanning = false;
  let scanMsg: HTMLElement | null = null;

  let devices: DeviceSummary[] = [];
  let currentDeviceId: string | null = null;

  function updateBadge(): void {
    const state =
      view === 'unlocked' || view === 'scan'
        ? { text: t('settings.vault_status_unlocked'), color: 'var(--accent)' }
        : view === 'setup' || view === 'phrase' || view === 'loading'
          ? { text: t('settings.vault_status_disabled'), color: 'var(--text-secondary)' }
          : { text: t('settings.vault_status_locked'), color: 'var(--danger)' };
    badge.textContent = state.text;
    badge.style.cssText = `
      display:inline-block;
      font-size:0.75rem;
      font-weight:600;
      padding:0.2rem 0.6rem;
      border:1px solid ${state.color};
      border-radius:999px;
      color:${state.color};
      margin-bottom:1rem;
    `;
  }

  function trailingMessage(): HTMLElement {
    return messageElement(messageKind, message);
  }

  // ── View: no vault yet ──────────────────────────────────────────────────
  function renderSetup(): void {
    const label = el('label', LABEL_CSS, t('settings.vault_password'));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = t('settings.vault_password_ph');
    input.style.cssText = `${INPUT_CSS}margin-bottom:1rem;`;

    const button = el('button', BUTTON_CSS, t('settings.vault_setup'));
    const msg = trailingMessage();
    button.addEventListener('click', () => {
      if (passwordLengthError(input.value)) {
        msg.textContent = t('settings.password_length');
        msg.style.color = 'var(--danger)';
        return;
      }
      pendingPassword = input.value;
      pendingPhrase = generateRecoveryPhrase();
      phraseSaved = false;
      message = '';
      view = 'phrase';
      render();
    });

    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(button);
    body.appendChild(msg);
  }

  // ── View: show the recovery phrase, then enable ─────────────────────────
  function renderPhrase(): void {
    body.appendChild(el('h3', SUBTITLE_CSS, t('settings.vault_phrase_title')));
    body.appendChild(el('p', `${MESSAGE_CSS}color:var(--danger);font-weight:500;`, t('settings.vault_phrase_warning')));

    const words = pendingPhrase.split(' ');
    const grid = el('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:0.4rem;margin:0.75rem 0;');
    words.forEach((word, index) => {
      const cell = el(
        'span',
        `padding:0.4rem 0.2rem;background:var(--bg-secondary);border:1px solid var(--border);
         border-radius:4px;font-family:monospace;font-size:0.78rem;text-align:center;
         color:var(--text-primary);overflow-wrap:anywhere;`,
        `${index + 1}. ${word}`,
      );
      grid.appendChild(cell);
    });
    body.appendChild(grid);

    const copyButton = el('button', SECONDARY_CSS, t('settings.vault_phrase_copy'));
    copyButton.addEventListener('click', () => {
      void navigator.clipboard
        ?.writeText(pendingPhrase)
        .then(() => {
          copyButton.textContent = t('settings.vault_phrase_copied');
        })
        .catch(() => {
          copyButton.textContent = t('settings.vault_error');
        });
    });

    const confirmRow = el('div', 'display:flex;align-items:center;gap:0.5rem;margin-top:1rem;');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      phraseSaved = checkbox.checked;
      enableButton.disabled = !phraseSaved;
    });
    const confirmLabel = el('label', 'font-size:0.9rem;color:var(--text-primary);cursor:pointer;');
    confirmLabel.appendChild(checkbox);
    confirmLabel.appendChild(document.createTextNode(` ${t('settings.vault_phrase_confirm')}`));
    confirmRow.appendChild(confirmLabel);

    const buttons = el('div', BUTTON_ROW_CSS);
    const backButton = el('button', SECONDARY_CSS, t('settings.vault_phrase_back'));
    backButton.addEventListener('click', () => {
      pendingPhrase = '';
      pendingPassword = '';
      view = 'setup';
      message = '';
      render();
    });

    const enableButton = el('button', BUTTON_CSS, t('settings.vault_enable')) as HTMLButtonElement;
    enableButton.disabled = true;
    const msg = trailingMessage();
    enableButton.addEventListener('click', () => {
      enableButton.disabled = true;
      enableButton.textContent = t('settings.vault_working');
      void (async () => {
        const result = await enableVault(pendingPassword, pendingPhrase);
        enableButton.textContent = t('settings.vault_enable');
        if (result.ok) {
          pendingPassword = '';
          pendingPhrase = '';
          currentDeviceId = getCurrentDeviceId();
          devices = await listDevices();
          view = 'unlocked';
          messageKind = 'info';
          message = t('settings.vault_enabled');
          render();
          return;
        }
        enableButton.disabled = !phraseSaved;
        if (result.error === 'already_exists') {
          // Someone (possibly us, on another device) already enabled it:
          // fall through to the unlock path instead of fighting over rows.
          pendingPassword = '';
          pendingPhrase = '';
          view = 'locked';
          messageKind = 'error';
          message = t('settings.vault_enable_exists');
          render();
          return;
        }
        msg.textContent = result.error === 'network' ? t('settings.network_error') : t('settings.vault_enable_failed');
      })();
    });

    buttons.appendChild(backButton);
    buttons.appendChild(enableButton);
    body.appendChild(copyButton);
    body.appendChild(confirmRow);
    body.appendChild(buttons);
    body.appendChild(msg);
  }

  // ── View: vault exists, VK is not in memory ─────────────────────────────
  function renderLocked(): void {
    body.appendChild(el('p', MUTED_CSS, t('settings.vault_locked_hint')));

    const label = el('label', LABEL_CSS, t('settings.vault_password'));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = t('settings.vault_password_ph');
    input.style.cssText = `${INPUT_CSS}margin-bottom:1rem;`;

    const msg = trailingMessage();
    const unlockButton = el('button', BUTTON_CSS, t('settings.vault_unlock')) as HTMLButtonElement;
    const doUnlock = () => {
      const password = input.value;
      if (!password || unlockButton.disabled) return;
      unlockButton.disabled = true;
      unlockButton.textContent = t('settings.vault_working');
      void (async () => {
        const outcome = await unlockVault(password);
        unlockButton.disabled = false;
        unlockButton.textContent = t('settings.vault_unlock');
        if (outcome === 'ok') {
          currentDeviceId = getCurrentDeviceId();
          devices = await listDevices();
          view = 'unlocked';
          message = '';
          render();
          return;
        }
        // Deriving takes ~600k PBKDF2 iterations either way; failures return
        // the input box untouched so the password can be retyped.
        msg.textContent = outcome === 'wrong' ? t('settings.vault_wrong_password') : t('settings.network_error');
        msg.style.color = 'var(--danger)';
      })();
    };
    unlockButton.addEventListener('click', doUnlock);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doUnlock();
    });

    const buttons = el('div', BUTTON_ROW_CSS);
    const pairButton = el('button', SECONDARY_CSS, t('settings.vault_pair_this'));
    pairButton.addEventListener('click', () => void startJoinPairing());

    buttons.appendChild(pairButton);
    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(unlockButton);
    body.appendChild(buttons);
    body.appendChild(msg);
  }

  // ── Joiner: show the QR until an approved device scans it ───────────────
  async function startJoinPairing(): Promise<void> {
    stopPoll();
    discardPairingSecret();
    const eph = generateEphemeralKeyPair();
    pairingSecret = eph.secretKey;
    pairingPub = eph.publicKey;

    const started = await startPairing(detectDeviceLabel(), encodeB64(eph.publicKey));
    if (!started) {
      discardPairingSecret();
      messageKind = 'error';
      message = t('settings.network_error');
      render();
      return;
    }
    pairingId = started.id;
    message = '';
    view = 'pairJoin';
    render();
    pollTimer = window.setInterval(() => void pollJoin(), 2000);
  }

  async function pollJoin(): Promise<void> {
    if (!pairingId) return;
    const state = await pollPairing(pairingId);
    if (!state) return; // transient network hiccup: keep waiting out the TTL
    if (state.state === 'active' && state.wrapped_vk) {
      stopPoll();
      const adopted = await adoptPairedVaultKey(state.wrapped_vk, state.id);
      discardPairingSecret();
      pairingId = null;
      currentDeviceId = getCurrentDeviceId();
      if (adopted) {
        devices = await listDevices();
        view = 'unlocked';
        messageKind = 'info';
        message = t('settings.vault_pair_approved');
      } else {
        view = 'locked';
        messageKind = 'error';
        message = t('settings.vault_error');
      }
      render();
      return;
    }
    if (state.state === 'expired') {
      stopPoll();
      discardPairingSecret();
      pairingId = null;
      view = 'locked';
      messageKind = 'error';
      message = t('settings.vault_pair_expired');
      render();
    }
  }

  function stopPoll(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** Burn the ephemeral private half: after this the stored blob is unopenable. */
  function discardPairingSecret(): void {
    pairingSecret?.fill(0);
    pairingSecret = null;
    pairingPub = null;
  }

  function renderPairJoin(): void {
    body.appendChild(el('h3', SUBTITLE_CSS, t('settings.vault_pair_join_title')));
    body.appendChild(el('p', MUTED_CSS, t('settings.vault_pair_join_hint')));

    const img = el('img');
    img.alt = 'pairing QR code';
    img.style.cssText =
      'display:block;width:220px;height:220px;background:#fff;padding:10px;border-radius:8px;margin:0.75rem auto;';
    body.appendChild(img);

    if (pairingId && pairingPub) {
      const uri = buildPairingUri(pairingId, pairingPub);
      const code = el(
        'code',
        'display:block;font-size:0.7rem;overflow-wrap:anywhere;color:var(--text-secondary);',
        uri,
      );
      body.appendChild(code);
      void toDataURL(uri, { margin: 1, width: 256 })
        .then((src) => {
          img.src = src;
        })
        .catch(() => {
          // QR rendering failed (rare): the text code above still pairs.
          img.remove();
        });
    }

    body.appendChild(el('p', `${MESSAGE_CSS}color:var(--accent);`, t('settings.vault_pair_waiting')));

    const buttons = el('div', BUTTON_ROW_CSS);
    const cancelButton = el('button', SECONDARY_CSS, t('settings.vault_pair_cancel'));
    cancelButton.addEventListener('click', () => {
      if (pairingId) void cancelPairing(pairingId);
      stopPoll();
      discardPairingSecret();
      pairingId = null;
      view = 'locked';
      message = '';
      render();
    });
    buttons.appendChild(cancelButton);
    body.appendChild(buttons);
  }

  // ── View: unlocked — device list, scanner, lock ─────────────────────────
  function renderUnlocked(): void {
    body.appendChild(el('h3', SUBTITLE_CSS, t('settings.vault_devices')));

    const list = el('div');
    if (devices.length === 0) {
      list.appendChild(el('p', MUTED_CSS, t('settings.vault_no_devices')));
    }
    for (const device of devices) {
      const row = el(
        'div',
        'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.6rem 0;border-bottom:1px solid var(--border);',
      );
      const isCurrent = device.id === currentDeviceId;
      const left = el('div');
      const name = el(
        'div',
        'font-size:0.9rem;font-weight:500;color:var(--text-primary);',
        isCurrent ? `${device.label} · ${t('settings.vault_device_this')}` : device.label,
      );
      const meta = el('div', `${MUTED_CSS}margin:0.15rem 0 0 0;`);
      const added = new Date(device.created_at).toLocaleDateString(getLocale());
      meta.textContent =
        device.state === 'pending'
          ? `${t('settings.vault_device_pending')} · ${t('settings.vault_device_added')} ${added}`
          : `${t('settings.vault_device_added')} ${added}`;
      left.appendChild(name);
      left.appendChild(meta);
      row.appendChild(left);

      if (!isCurrent) {
        const revoke = el('button', DANGER_CSS, t('settings.vault_revoke')) as HTMLButtonElement;
        revoke.addEventListener('click', () => {
          void (async () => {
            if (!(await createConfirmDialog(t('settings.vault_revoke_confirm')))) return;
            revoke.disabled = true;
            if (await revokeDevice(device.id)) {
              devices = await listDevices();
              render();
            } else {
              revoke.disabled = false;
            }
          })();
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
    body.appendChild(list);

    const buttons = el('div', BUTTON_ROW_CSS);
    const scanButton = el('button', BUTTON_CSS, t('settings.vault_add_device'));
    scanButton.addEventListener('click', () => {
      view = 'scan';
      message = '';
      render(); // renderScan starts the camera itself
    });
    const lockButton = el('button', SECONDARY_CSS, t('settings.vault_lock'));
    lockButton.addEventListener('click', () => {
      lockVault();
      view = 'locked';
      message = '';
      render();
    });
    buttons.appendChild(scanButton);
    buttons.appendChild(lockButton);
    body.appendChild(buttons);
    body.appendChild(trailingMessage());
  }

  // ── Approver: scan the joiner's QR (or paste the code) ──────────────────
  function renderScan(): void {
    body.appendChild(el('h3', SUBTITLE_CSS, t('settings.vault_pair_scan_title')));
    body.appendChild(el('p', MUTED_CSS, t('settings.vault_pair_scan_hint')));

    const video = el('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText =
      'display:none;width:100%;max-width:340px;aspect-ratio:4/3;background:#000;border-radius:8px;margin:0.5rem 0;';
    body.appendChild(video);

    const note = el('p', MUTED_CSS, '');
    body.appendChild(note);

    const manualRow = el('div', 'display:flex;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap;');
    const manual = el('input');
    manual.placeholder = t('settings.vault_pair_manual_ph');
    manual.style.cssText = `${INPUT_CSS}flex:1;min-width:200px;`;
    const approveButton = el('button', BUTTON_CSS, t('settings.vault_pair_approve')) as HTMLButtonElement;
    scanMsg = trailingMessage();
    const scanMessage = scanMsg;
    approveButton.addEventListener('click', () => {
      approveButton.disabled = true;
      void approveFromText(manual.value, scanMessage).finally(() => {
        approveButton.disabled = false;
      });
    });
    manualRow.appendChild(manual);
    manualRow.appendChild(approveButton);

    const buttons = el('div', BUTTON_ROW_CSS);
    const cancelButton = el('button', SECONDARY_CSS, t('settings.vault_pair_cancel'));
    cancelButton.addEventListener('click', () => {
      stopCamera();
      scanMsg = null;
      view = 'unlocked';
      render();
    });
    buttons.appendChild(cancelButton);

    body.appendChild(manualRow);
    body.appendChild(buttons);
    body.appendChild(scanMessage);
    void startCamera(video, note);
  }

  async function approveFromText(text: string, msg: HTMLElement): Promise<void> {
    const parsed = parsePairingUri(text);
    if (!parsed) {
      msg.textContent = t('settings.vault_pair_invalid');
      msg.style.color = 'var(--danger)';
      return;
    }
    const vk = getVaultKey();
    if (!vk) {
      stopCamera();
      view = 'locked';
      messageKind = 'error';
      message = t('settings.vault_error');
      render();
      return;
    }

    const eph = generateEphemeralKeyPair();
    try {
      const wrapped = await wrapVaultKeyForPairing(vk, eph.secretKey, parsed.publicKey, parsed.pairingId);
      const result = await approvePairing(parsed.pairingId, encodeB64(eph.publicKey), wrapped);
      if (result === 'ok') {
        stopCamera();
        devices = await listDevices();
        view = 'unlocked';
        messageKind = 'info';
        message = t('settings.vault_pair_scan_done');
        render();
        return;
      }
      msg.textContent =
        result === 'reused'
          ? t('settings.vault_pair_reused')
          : result === 'expired'
            ? t('settings.vault_pair_expired')
            : t('settings.vault_error');
      msg.style.color = 'var(--danger)';
    } finally {
      // The approver's ephemeral half dies here too: only the joiner's blob
      // survives, and it is already unreachable without both secrets.
      eph.secretKey.fill(0);
    }
  }

  async function startCamera(video: HTMLVideoElement, note: HTMLElement): Promise<void> {
    const Detector = (window as unknown as { BarcodeDetector?: QrDetectorCtor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      note.textContent = t('settings.vault_camera_unavailable');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      note.textContent = t('settings.vault_camera_unavailable');
      return;
    }
    video.srcObject = mediaStream;
    video.style.display = 'block';
    try {
      await video.play();
    } catch {
      stopCamera();
      note.textContent = t('settings.vault_camera_unavailable');
      return;
    }

    const detector = new Detector({ formats: ['qr_code'] });
    scanTimer = window.setInterval(() => {
      if (scanning || !mediaStream) return;
      scanning = true;
      detector
        .detect(video)
        .then((found) => {
          const hit = found.find(
            (candidate) => typeof candidate.rawValue === 'string' && candidate.rawValue.startsWith(PAIRING_URI_PREFIX),
          );
          if (hit?.rawValue) {
            stopCamera();
            const msg = scanMsg;
            if (msg) void approveFromText(hit.rawValue, msg);
          }
        })
        .catch(() => {
          // A frame the decoder didn't like — keep trying while the QR is up.
        })
        .finally(() => {
          scanning = false;
        });
    }, 400);
  }

  function stopCamera(): void {
    if (scanTimer !== null) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    scanning = false;
  }

  function render(): void {
    body.replaceChildren();
    updateBadge();
    if (view === 'loading') {
      body.appendChild(el('p', MUTED_CSS, t('settings.vault_awaiting')));
      return;
    }
    if (view === 'setup') renderSetup();
    else if (view === 'phrase') renderPhrase();
    else if (view === 'locked') renderLocked();
    else if (view === 'pairJoin') renderPairJoin();
    else if (view === 'unlocked') renderUnlocked();
    else renderScan();
  }

  render();

  // Resolve the actual state once: enable? unlocked already? device key?
  void (async () => {
    const keys = await fetchVaultKeys();
    currentDeviceId = getCurrentDeviceId();
    if (!keys?.enabled) {
      view = 'setup';
      render();
      return;
    }
    if (isVaultUnlocked()) {
      devices = await listDevices();
      view = 'unlocked';
      render();
      return;
    }
    view = 'locked';
    render();
    if (await tryDeviceUnlock()) {
      currentDeviceId = getCurrentDeviceId();
      devices = await listDevices();
      view = 'unlocked';
      render();
    }
  })();

  return {
    getElement: () => container,
    destroy: () => {
      stopPoll();
      stopCamera();
      discardPairingSecret();
      container.remove();
    },
  };
}
