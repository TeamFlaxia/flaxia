// Account connections in Settings.
//
// Flaxia is the management surface for the Auth keyring: it lists the services
// linked to the Auth account, runs the OpenCode device flow, and stores the
// sealed token as an encrypted `oauth_connection` item in the Personal Vault.
// Studio and other apps only consume what this section creates.
//
// The Vault key never leaves lib/vault/session. This file only arranges DOM
// and calls the existing unlock/items helpers.

import {
  type AuthConnection,
  AuthConnectionError,
  completeOpenCodeConnection,
  createSealKeyPair,
  type DeviceAuthorization,
  type DevicePollResult,
  deleteAuthConnection,
  listAuthConnections,
  type OpenCodeOrg,
  openSealed,
  pollOpenCodeDevice,
  randomToken,
  selectGrantedOrg,
  startOpenCodeDevice,
} from '../lib/auth-connections.js';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';
import { showToast } from '../lib/toast.js';
import { fetchVaultKeys, type VaultKeysResponse } from '../lib/vault/client.js';
import { deleteVaultItem, newVaultItemId, saveVaultItem } from '../lib/vault/items.js';
import { getVaultKey, isVaultUnlocked, unlockVault } from '../lib/vault/session.js';

interface ConnectionsSectionOptions {
  onOpenSecurity: () => void;
}

type View = 'loading' | 'signed-out' | 'vault-disabled' | 'locked' | 'ready' | 'error';

const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  google: 'Google',
  openai: 'OpenAI',
  microsoft: 'Microsoft',
  slack: 'Slack',
  discord: 'Discord',
  line: 'LINE',
  github: 'GitHub',
  x: 'X',
};

const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

const messageFor = (error: unknown): string => {
  if (error instanceof AuthConnectionError) {
    if (error.status === 401) return t('settings.connections_sign_in_desc');
    return error.message;
  }
  return error instanceof Error ? error.message : t('settings.connections_failed');
};

export function createConnectionsSection(options: ConnectionsSectionOptions): {
  getElement: () => HTMLElement;
  destroy: () => void;
} {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('h2');
  title.textContent = t('settings.connections');

  const body = document.createElement('div');

  section.appendChild(title);
  section.appendChild(body);

  let view: View = 'loading';
  let connections: AuthConnection[] = [];
  let vaultKeys: VaultKeysResponse | null = null;
  let errorMessage = '';
  let disposed = false;
  let flowGeneration = 0;
  let flowTimer: number | undefined;

  const paragraph = (text: string, className = ''): HTMLParagraphElement => {
    const element = document.createElement('p');
    if (className) element.className = className;
    element.textContent = text;
    return element;
  };

  const action = (label: string, onClick: () => void, primary = false, danger = false): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = primary
      ? 'settings-save'
      : danger
        ? 'settings-button settings-button--danger'
        : 'settings-button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  };

  const stopFlow = (): void => {
    flowGeneration += 1;
    if (flowTimer !== undefined) {
      window.clearTimeout(flowTimer);
      flowTimer = undefined;
    }
  };

  const render = (): void => {
    body.replaceChildren();

    if (view === 'loading') {
      body.appendChild(paragraph(t('settings.connections_loading')));
      return;
    }

    if (view === 'signed-out') {
      body.appendChild(paragraph(t('settings.connections_sign_in_desc'), 'settings-panel-description'));
      body.appendChild(
        action(
          t('settings.connections_sign_in'),
          () => {
            const here = `${window.location.pathname}${window.location.search}`;
            window.location.assign(`/api/auth/start?return_to=${encodeURIComponent(here)}`);
          },
          true,
        ),
      );
      return;
    }

    if (view === 'vault-disabled') {
      body.appendChild(paragraph(t('settings.connections_vault_required'), 'settings-panel-description'));
      body.appendChild(action(t('settings.connections_open_security'), options.onOpenSecurity, true));
      return;
    }

    if (view === 'locked') {
      renderUnlock();
      return;
    }

    if (view === 'error') {
      body.appendChild(paragraph(errorMessage || t('settings.connections_failed'), 'settings-panel-description'));
      body.appendChild(action(t('settings.connections_retry'), () => void refresh(), true));
      return;
    }

    renderReady();
  };

  const renderUnlock = (): void => {
    body.appendChild(paragraph(t('settings.connections_unlock_desc'), 'settings-panel-description'));

    const password = document.createElement('input');
    password.type = 'password';
    password.className = 'settings-input';
    password.autocomplete = 'current-password';
    password.placeholder = t('settings.connections_password');
    password.setAttribute('aria-label', t('settings.connections_password'));

    const status = paragraph('');
    const unlock = action(
      t('settings.connections_unlock'),
      () => {
        unlock.disabled = true;
        status.textContent = t('settings.connections_unlocking');
        void (async () => {
          const result = await unlockVault(password.value);
          if (disposed) return;
          if (result === 'ok') {
            password.value = '';
            await refresh();
            return;
          }
          unlock.disabled = false;
          status.textContent =
            result === 'wrong'
              ? t('settings.connections_unlock_wrong')
              : result === 'malformed'
                ? t('settings.connections_unlock_malformed')
                : t('settings.connections_unlock_network');
        })();
      },
      true,
    );

    body.appendChild(password);
    body.appendChild(status);
    body.appendChild(unlock);
  };

  const renderReady = (): void => {
    const active = connections.filter((connection) => connection.status === 'active');
    if (active.length === 0) {
      body.appendChild(paragraph(t('settings.connections_empty'), 'settings-panel-description'));
    } else {
      const list = document.createElement('div');
      list.className = 'connections-list';
      for (const connection of active) list.appendChild(connectionCard(connection));
      body.appendChild(list);
    }

    const hasOpenCode = active.some((connection) => connection.provider === 'opencode');
    if (!hasOpenCode) {
      body.appendChild(paragraph(t('settings.connections_opencode_desc'), 'settings-panel-description'));
      body.appendChild(action(t('settings.connections_connect_opencode'), () => void connectOpenCode(), true));
    }
  };

  const connectionCard = (connection: AuthConnection): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'connection-card';

    const head = document.createElement('div');
    head.className = 'connection-card-head';

    const name = document.createElement('span');
    name.className = 'connection-card-name';
    name.textContent = providerLabel(connection.provider);

    const status = document.createElement('span');
    status.className = 'connection-status';
    status.textContent = t('settings.connections_active');

    head.appendChild(name);
    head.appendChild(status);

    const meta = document.createElement('div');
    meta.className = 'connection-card-meta';
    const details: string[] = [];
    if (connection.scopes.length > 0) {
      details.push(t('settings.connections_scopes', { scopes: connection.scopes.join(', ') }));
    }
    if (connection.expires_at) {
      const date = new Date(connection.expires_at);
      details.push(
        Number.isFinite(date.getTime())
          ? t('settings.connections_expires', { date: date.toLocaleString() })
          : t('settings.connections_expires', { date: connection.expires_at }),
      );
    }
    meta.textContent = details.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'connection-actions';
    actions.appendChild(action(t('settings.connections_disconnect'), () => void disconnect(connection), false, true));

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  };

  const refresh = async (): Promise<void> => {
    view = 'loading';
    render();
    const [keysResult, connectionsResult] = await Promise.allSettled([fetchVaultKeys(), listAuthConnections()]);
    if (disposed) return;

    vaultKeys = keysResult.status === 'fulfilled' ? keysResult.value : null;

    if (connectionsResult.status === 'rejected') {
      const error = connectionsResult.reason;
      if (error instanceof AuthConnectionError && error.status === 401) {
        view = 'signed-out';
      } else {
        errorMessage = messageFor(error);
        view = 'error';
      }
      render();
      return;
    }

    connections = connectionsResult.value;

    if (!vaultKeys) {
      errorMessage = t('settings.connections_auth_unavailable');
      view = 'error';
    } else if (!vaultKeys.enabled) {
      view = 'vault-disabled';
    } else if (!isVaultUnlocked()) {
      view = 'locked';
    } else {
      view = 'ready';
    }
    render();
  };

  const connectOpenCode = async (): Promise<void> => {
    if (!getVaultKey()) {
      view = 'locked';
      render();
      return;
    }

    stopFlow();
    const generation = flowGeneration;
    const { pair, publicKey } = await createSealKeyPair();
    const state = randomToken();

    let start: DeviceAuthorization;
    try {
      start = await startOpenCodeDevice(state);
    } catch (error) {
      errorMessage = messageFor(error);
      view = 'error';
      render();
      return;
    }
    if (disposed || generation !== flowGeneration) return;

    renderDevice(start);
    await pollDevice(start, state, generation, pair, publicKey);
  };

  const renderDevice = (start: DeviceAuthorization): void => {
    const status = paragraph(t('settings.connections_waiting'));
    const link = start.verification_uri_complete ?? start.verification_uri;

    body.replaceChildren(
      paragraph(t('settings.connections_user_code'), 'settings-panel-description'),
      Object.assign(document.createElement('div'), {
        className: 'connection-code',
        textContent: start.user_code,
      }),
      action(t('settings.connections_open_console'), () => window.open(link, '_blank', 'noopener')),
      status,
      action(t('settings.connections_cancel'), () => {
        stopFlow();
        void refresh();
      }),
    );
  };

  const pollDevice = async (
    start: DeviceAuthorization,
    state: string,
    generation: number,
    pair: CryptoKeyPair,
    publicKey: string,
  ): Promise<void> => {
    let intervalMs = Math.max(1, start.interval) * 1000;
    const deadline = Date.now() + Math.max(1, start.expires_in) * 1000;

    const tick = async (): Promise<void> => {
      if (disposed || generation !== flowGeneration) return;
      if (Date.now() >= deadline) {
        errorMessage = t('settings.connections_expired');
        view = 'error';
        render();
        return;
      }

      let result: DevicePollResult;
      try {
        result = await pollOpenCodeDevice({
          transaction_id: start.transaction_id,
          state,
          device_code: start.device_code,
          client_public_key: publicKey,
          interval: Math.max(1, Math.min(60, Math.round(intervalMs / 1000))),
        });
      } catch (error) {
        if (disposed || generation !== flowGeneration) return;
        errorMessage = messageFor(error);
        view = 'error';
        render();
        return;
      }
      if (disposed || generation !== flowGeneration) return;

      if (result.status === 'pending') {
        flowTimer = window.setTimeout(() => void tick(), intervalMs);
        return;
      }
      if (result.status === 'slow_down') {
        intervalMs = Math.max(intervalMs, (result.interval || 10) * 1000);
        flowTimer = window.setTimeout(() => void tick(), intervalMs);
        return;
      }
      if (result.status === 'complete') {
        await finishDevice(start, state, pair, result.sealed, result.orgs, generation);
      }
    };

    flowTimer = window.setTimeout(() => void tick(), intervalMs);
  };

  const finishDevice = async (
    start: DeviceAuthorization,
    state: string,
    pair: CryptoKeyPair,
    sealed: Parameters<typeof openSealed>[0],
    orgs: OpenCodeOrg[],
    generation: number,
  ): Promise<void> => {
    let savedItemId: string | null = null;
    try {
      const plaintext = await openSealed(sealed, pair.privateKey);
      const token = JSON.parse(new TextDecoder().decode(plaintext)) as {
        access_token?: unknown;
        refresh_token?: unknown;
        token_type?: unknown;
        scope?: unknown;
        expires_in?: unknown;
        org_id?: unknown;
      };
      if (typeof token.access_token !== 'string') throw new Error(t('settings.connections_failed'));

      const grantedOrgId = typeof token.org_id === 'string' && token.org_id.length > 0 ? token.org_id : null;
      const org = await pickOrg(orgs, grantedOrgId);
      if (disposed || generation !== flowGeneration) return;

      const expiresIn =
        typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) ? token.expires_in : 3600;
      const expiresAt = new Date(Date.now() + Math.max(1, expiresIn) * 1000).toISOString();
      const itemId = `item_${newVaultItemId()}`;

      if (disposed || generation !== flowGeneration) return;
      await saveVaultItem(itemId, 'oauth_connection', {
        version: 1,
        provider: 'opencode',
        access_token: token.access_token,
        refresh_token: typeof token.refresh_token === 'string' ? token.refresh_token : null,
        token_type: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
        scope: typeof token.scope === 'string' ? token.scope : 'inference',
        expires_at: expiresAt,
        org: org ? { id: org.id, name: org.name } : null,
        orgs,
        connected_at: new Date().toISOString(),
      });
      savedItemId = itemId;

      if (disposed || generation !== flowGeneration) return;
      await completeOpenCodeConnection({
        transaction_id: start.transaction_id,
        state,
        vault_item_id: itemId,
        scopes: ['inference'],
        expires_at: expiresAt,
        refresh_expires_at: null,
      });
      savedItemId = null;

      showToast(t('settings.connections_connected'));
      await refresh();
    } catch (error) {
      if (savedItemId) {
        try {
          await deleteVaultItem(savedItemId);
        } catch {
          // The orphaned item is still encrypted and unlinked; leave it.
        }
      }
      if (disposed) return;
      errorMessage = messageFor(error);
      view = 'error';
      render();
    }
  };

  const pickOrg = (orgs: OpenCodeOrg[], grantedOrgId: string | null): Promise<OpenCodeOrg | null> => {
    // An org-scoped grant decides the workspace during Console approval, so
    // do not offer a conflicting choice here.
    const granted = selectGrantedOrg(orgs, grantedOrgId);
    if (granted) return Promise.resolve(granted);
    if (orgs.length === 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const select = document.createElement('select');
      select.className = 'settings-input';
      select.setAttribute('aria-label', t('settings.connections_choose_workspace'));
      for (const org of orgs) {
        const option = document.createElement('option');
        option.value = org.id;
        option.textContent = org.name;
        select.appendChild(option);
      }

      body.replaceChildren(
        paragraph(t('settings.connections_choose_workspace'), 'settings-panel-description'),
        select,
        action(
          t('settings.connections_use_workspace'),
          () => resolve(orgs.find((org) => org.id === select.value) ?? orgs[0] ?? null),
          true,
        ),
      );
    });
  };

  const disconnect = async (connection: AuthConnection): Promise<void> => {
    const label = providerLabel(connection.provider);
    if (
      !(await createConfirmDialog(t('settings.connections_disconnect_confirm', { provider: label }), {
        destructive: true,
      }))
    ) {
      return;
    }

    try {
      if (connection.vault_item_id) await deleteVaultItem(connection.vault_item_id);
      await deleteAuthConnection(connection.provider);
      showToast(t('settings.connections_disconnected', { provider: label }));
      await refresh();
    } catch (error) {
      errorMessage = messageFor(error);
      view = 'error';
      render();
    }
  };

  void refresh();

  return {
    getElement: () => section,
    destroy: () => {
      disposed = true;
      stopFlow();
      body.replaceChildren();
    },
  };
}
