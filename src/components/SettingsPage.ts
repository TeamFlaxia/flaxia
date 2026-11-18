import { clearMeCache } from '../lib/auth-cache';
import {
  clearCredentialOperation,
  credentialOperationFor,
  retryPendingCredentialChange,
} from '../lib/auth-credential-operation';
import { clearDeletionOperation, deletionOperationFor } from '../lib/auth-deletion';
import { createSrpProof, storeSrpSalt } from '../lib/auth-srp.js';
import { attachPlusBadge } from '../lib/avatar.js';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
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
} from '../lib/crowd-node.js';
import { getLocale, setLocale, t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { clearTileCache, getTileCacheStats, requestStoragePersistence } from '../lib/maps/cache.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { passwordLengthError } from '../lib/password-policy.js';
import { each, html, legacy, type Mounted, mount, signal } from '../lib/render/index.ts';
import {
  getDataSaverMode,
  getReplyStyle,
  getShowNsfw,
  isBrowserSaveDataEnabled,
  ReplyStyle,
  setDataSaverMode,
  setReplyStyle,
  setShowNsfw,
} from '../lib/settings.js';
import { computeVerifier, DEFAULT_SRP_KDF, generateSalt } from '../lib/srp.js';
import { getTheme, setTheme, Theme } from '../lib/theme.js';
import { createTitleIcon, titleDescription, titleName } from '../lib/user-title.js';
import { fetchVaultKeys, prepareVaultRewrap } from '../lib/vault/client.js';
import { syncVaultVersionAfterRewrap } from '../lib/vault/session.js';
import { createAddStampModal } from './AddStampModal.js';
import { createBugReportForm } from './BugReportForm.js';
import { createVaultSection } from './VaultSection.js';

function b64(b: Uint8Array): string {
  let binary = '';
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary);
}

interface SettingsPageProps {
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

interface SettingsTitle {
  id: string;
  icon: string;
  name: string;
  name_ja?: string | null;
  description: string;
  description_ja?: string | null;
  equipped?: boolean;
}

interface BillingHistoryRow {
  key: string;
  left: string;
  right: string;
}

type TitleEntry = { kind: 'title'; title: SettingsTitle } | { kind: 'empty' } | { kind: 'error' };

interface SettingsStamp {
  id: string;
  name: string;
  url: string;
}

type StampEntry = { kind: 'stamp'; stamp: SettingsStamp } | { kind: 'add' } | { kind: 'error' };

interface SettingsCategory {
  id: string;
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
  iconName: string;
  sections: HTMLElement[];
}

/**
 * v5 two-pane settings shell: a dense category rail (Obsidian-style) on the
 * left, one bordered panel per category on the right. Replaces the previous
 * overview/back-navigation flow while keeping the same public surface.
 */
function createSettingsTwoPane() {
  const container = document.createElement('div');
  container.className = 'settings-page';

  const header = document.createElement('header');
  header.className = 'settings-header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'settings-back';
  back.textContent = '←';
  back.setAttribute('aria-label', t('common.back'));
  const heading = document.createElement('h1');
  heading.textContent = t('settings.title');
  heading.tabIndex = -1;
  const titleIcon = document.createElement('span');
  titleIcon.className = 'settings-title-icon';
  titleIcon.setAttribute('aria-hidden', 'true');
  titleIcon.appendChild(icon('settings', { width: '18', height: '18' }));
  heading.insertBefore(titleIcon, heading.firstChild);
  header.appendChild(back);
  header.appendChild(heading);
  container.appendChild(header);

  const pane = document.createElement('div');
  pane.className = 'settings-two-pane';
  const nav = document.createElement('nav');
  nav.className = 'settings-nav';
  nav.setAttribute('aria-label', t('settings.title'));
  const content = document.createElement('div');
  content.className = 'settings-content';
  pane.appendChild(nav);
  pane.appendChild(content);
  container.appendChild(pane);

  const groups = new Map<string, HTMLElement>();
  const items = new Map<string, HTMLButtonElement>();
  const panels = new Map<string, HTMLElement>();
  let active: string | null = null;

  back.addEventListener('click', () => window.history.back());

  function showCategory(id: string | null, moveFocus = true): void {
    const nextId = id && items.has(id) ? id : (items.keys().next().value ?? null);
    if (!nextId) return;
    active = nextId;
    for (const [key, button] of items) {
      const isActive = key === nextId;
      button.classList.toggle('settings-nav-item--active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const [key, panel] of panels) panel.hidden = key !== nextId;
    if (moveFocus) panels.get(nextId)?.focus({ preventScroll: false });
  }

  function addCategory(category: SettingsCategory): void {
    let group = groups.get(category.groupKey);
    if (!group) {
      const section = document.createElement('section');
      section.className = 'settings-nav-group';
      const title = document.createElement('h2');
      title.className = 'settings-nav-group-title';
      title.textContent = t(category.groupKey);
      const list = document.createElement('div');
      list.className = 'settings-nav-list';
      section.appendChild(title);
      section.appendChild(list);
      nav.appendChild(section);
      group = list;
      groups.set(category.groupKey, group);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-nav-item';
    const navIcon = document.createElement('span');
    navIcon.className = 'settings-nav-icon';
    navIcon.setAttribute('aria-hidden', 'true');
    navIcon.appendChild(icon(category.iconName as Parameters<typeof icon>[0], { width: '16', height: '16' }));
    const navLabel = document.createElement('span');
    navLabel.className = 'settings-nav-label';
    navLabel.textContent = t(category.titleKey);
    button.appendChild(navIcon);
    button.appendChild(navLabel);
    button.addEventListener('click', () => showCategory(category.id));
    group.appendChild(button);
    items.set(category.id, button);

    const panel = document.createElement('section');
    panel.className = 'settings-panel';
    panel.setAttribute('aria-label', t(category.titleKey));
    panel.tabIndex = -1;
    panel.hidden = true;
    const intro = document.createElement('p');
    intro.className = 'settings-panel-description';
    intro.textContent = t(category.descriptionKey);
    panel.appendChild(intro);
    for (const section of category.sections) panel.appendChild(section);
    content.appendChild(panel);
    panels.set(category.id, panel);
  }

  return {
    getElement: () => container,
    addCategory,
    showCategory,
    getActiveCategory: () => active,
  };
}

export function createSettingsPage({ currentUser, initialCategory }: SettingsPageProps) {
  const navigation = createSettingsTwoPane();
  const container = navigation.getElement();
  const bugReportForm = createBugReportForm();
  let accountSection: HTMLDivElement | undefined;
  let emojiSection: HTMLDivElement | undefined;
  let titlesSection: HTMLDivElement | undefined;
  let billingSection: HTMLDivElement | undefined;
  let titlesMount: Mounted | undefined;
  let stampsMount: Mounted | undefined;
  let historyMount: Mounted | undefined;
  const displayMounts: Mounted[] = [];

  // Account Section
  if (currentUser) {
    accountSection = document.createElement('div');
    accountSection.className = 'settings-section';

    const accountTitle = document.createElement('h2');
    accountTitle.textContent = t('settings.account');

    const userChip = document.createElement('div');
    userChip.className = 'settings-user';

    const avatarUrl = nativeApiHref(
      currentUser.avatar_key ? `/api/images/${currentUser.avatar_key}` : '/api/images/default-avatar',
    );
    const displayName = currentUser.display_name || currentUser.username;

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'settings-user-avatar';
    const avatarEl = document.createElement('img');
    avatarEl.src = avatarUrl;
    avatarEl.alt = '';
    avatarEl.className = 'settings-user-avatar-img';
    avatarEl.onerror = () => {
      avatarEl.src = nativeApiHref('/api/images/default-avatar');
    };
    avatarWrap.appendChild(avatarEl);
    attachPlusBadge(avatarWrap, currentUser.badge_type);
    userChip.appendChild(avatarWrap);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'settings-user-info';
    userChip.appendChild(infoDiv);

    const displayNameEl = document.createElement('div');
    displayNameEl.className = 'settings-user-name';
    displayNameEl.textContent = displayName;
    applyNameColor(displayNameEl, currentUser.name_color, currentUser.badge_type);
    infoDiv.appendChild(displayNameEl);

    const usernameEl = document.createElement('div');
    usernameEl.className = 'settings-user-username';
    usernameEl.textContent = `@${currentUser.username}`;
    infoDiv.appendChild(usernameEl);

    const logoutButton = document.createElement('button');
    logoutButton.textContent = t('auth.sign_out');
    logoutButton.className = 'settings-button';

    logoutButton.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(t('auth.logout_confirm', { username: currentUser.username }));
      if (!confirmed) return;
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
        });

        if (response.ok) {
          clearMeCache();
          window.location.href = '/';
        } else {
          alert(t('auth.logout_failed'));
        }
      } catch (error) {
        console.error('Logout error:', error);
        alert(t('auth.logout_error'));
      }
    });

    const deleteButton = document.createElement('button');
    deleteButton.textContent = t('settings.delete_account');
    deleteButton.className = 'settings-button settings-button--danger';

    deleteButton.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(
        t('settings.delete_account_confirm', { username: currentUser.username }),
      );
      if (!confirmed) return;
      const password = window.prompt(
        t('settings.current_password') || 'Enter your current password to confirm deletion',
      );
      if (!password) return;
      try {
        const current_srp = await createSrpProof(password);
        if (!current_srp) {
          alert(t('settings.password_proof_failed') || 'Could not verify your password');
          return;
        }
        const operation = deletionOperationFor(currentUser.id);
        const response = await fetch('/api/users/me', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ current_srp, operation }),
        });

        if (response.ok) {
          clearDeletionOperation();
          clearMeCache();
          window.location.href = '/';
        } else {
          const data = (await response.json().catch(() => ({}))) as { cancelled?: boolean };
          if (data.cancelled) clearDeletionOperation();
          alert(t('settings.delete_account_failed'));
        }
      } catch (error) {
        console.error('Delete account error:', error);
        alert(t('settings.delete_account_error'));
      }
    });

    accountSection.appendChild(accountTitle);
    accountSection.appendChild(userChip);
    const accountActions = document.createElement('div');
    accountActions.className = 'settings-account-actions';
    accountActions.appendChild(logoutButton);
    accountActions.appendChild(deleteButton);
    accountSection.appendChild(accountActions);
  }

  // Display Section
  const displaySection = document.createElement('div');
  displaySection.className = 'settings-section';

  const displayTitle = document.createElement('h2');
  displayTitle.textContent = t('settings.display');

  const currentStyle = getReplyStyle();

  const radioGroup = document.createElement('div');
  radioGroup.className = 'settings-choice-list';

  const styles: { value: ReplyStyle; labelKey: string; descKey: string }[] = [
    { value: 'twitter', labelKey: 'settings.reply_style_twitter', descKey: 'settings.reply_style_twitter_desc' },
    { value: '2ch', labelKey: 'settings.reply_style_2ch', descKey: 'settings.reply_style_2ch_desc' },
  ];

  const createChoiceCard = (options: {
    name: string;
    value: string;
    checked: boolean;
    labelKey: string;
    descKey: string;
    onChange: () => void;
  }): HTMLElement => {
    const label = document.createElement('label');
    label.className = 'settings-radio-card';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = options.name;
    radio.value = options.value;
    radio.checked = options.checked;
    radio.className = 'settings-radio';

    const textDiv = document.createElement('div');
    textDiv.className = 'settings-radio-text';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'settings-radio-name';
    nameSpan.textContent = t(options.labelKey);

    const descSpan = document.createElement('span');
    descSpan.className = 'settings-radio-desc';
    descSpan.textContent = t(options.descKey);

    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);
    label.appendChild(radio);
    label.appendChild(textDiv);
    radio.addEventListener('change', options.onChange);
    return label;
  };

  displayMounts.push(
    mount(radioGroup, () =>
      each(
        () => styles,
        (style) => style.value,
        (style) =>
          legacy(
            createChoiceCard({
              name: 'reply-style',
              value: style().value,
              checked: currentStyle === style().value,
              labelKey: style().labelKey,
              descKey: style().descKey,
              onChange: () => {
                setReplyStyle(style().value);
                displayMessage.textContent = t('settings.display_saved');
                displayMessage.style.color = 'var(--accent-text)';
              },
            }),
          ),
      ),
    ),
  );

  // NSFW toggle
  const nsfwLabel = document.createElement('label');
  nsfwLabel.className = 'settings-switch-row';

  const nsfwCheckbox = document.createElement('input');
  nsfwCheckbox.type = 'checkbox';
  nsfwCheckbox.checked = getShowNsfw();
  nsfwCheckbox.className = 'settings-switch';

  const nsfwTextDiv = document.createElement('div');
  nsfwTextDiv.className = 'settings-switch-text';

  const nsfwNameSpan = document.createElement('span');
  nsfwNameSpan.className = 'settings-switch-name';
  nsfwNameSpan.textContent = t('settings.nsfw');

  const nsfwDescSpan = document.createElement('span');
  nsfwDescSpan.className = 'settings-switch-desc';
  nsfwDescSpan.textContent = t('settings.nsfw_desc');

  nsfwTextDiv.appendChild(nsfwNameSpan);
  nsfwTextDiv.appendChild(nsfwDescSpan);
  nsfwLabel.appendChild(nsfwTextDiv);
  nsfwLabel.appendChild(nsfwCheckbox);

  nsfwCheckbox.addEventListener('change', () => {
    setShowNsfw(nsfwCheckbox.checked);
    displayMessage.textContent = t('settings.display_saved');
    displayMessage.style.color = 'var(--accent-text)';
  });

  // Data saver toggle (traffic-priority mode, device-local only)
  const dataSaverLabel = document.createElement('label');
  dataSaverLabel.className = 'settings-switch-row';

  const dataSaverCheckbox = document.createElement('input');
  dataSaverCheckbox.type = 'checkbox';
  // Reflect the browser Save-Data hint on first paint so the toggle is
  // already on when the OS/browser requests reduced data usage.
  dataSaverCheckbox.checked = getDataSaverMode() || isBrowserSaveDataEnabled();
  dataSaverCheckbox.className = 'settings-switch';

  const dataSaverTextDiv = document.createElement('div');
  dataSaverTextDiv.className = 'settings-switch-text';

  const dataSaverNameSpan = document.createElement('span');
  dataSaverNameSpan.className = 'settings-switch-name';
  dataSaverNameSpan.textContent = t('settings.data_saver');

  const dataSaverDescSpan = document.createElement('span');
  dataSaverDescSpan.className = 'settings-switch-desc';
  dataSaverDescSpan.textContent = t('settings.data_saver_desc');

  dataSaverTextDiv.appendChild(dataSaverNameSpan);
  dataSaverTextDiv.appendChild(dataSaverDescSpan);
  dataSaverLabel.appendChild(dataSaverTextDiv);
  dataSaverLabel.appendChild(dataSaverCheckbox);

  dataSaverCheckbox.addEventListener('change', () => {
    setDataSaverMode(dataSaverCheckbox.checked);
    displayMessage.textContent = t('settings.display_saved');
    displayMessage.style.color = 'var(--accent-text)';
  });

  // Theme selector
  const themeTitle = document.createElement('div');
  themeTitle.className = 'fx-label settings-subheading';
  themeTitle.textContent = t('settings.theme');

  const currentTheme = getTheme();
  const themeRadioGroup = document.createElement('div');
  themeRadioGroup.className = 'settings-choice-list';

  const themes: { value: Theme; labelKey: string; descKey: string }[] = [
    { value: 'light', labelKey: 'settings.theme_light', descKey: 'settings.theme_light_desc' },
    { value: 'dark', labelKey: 'settings.theme_dark', descKey: 'settings.theme_dark_desc' },
    { value: 'system', labelKey: 'settings.theme_system', descKey: 'settings.theme_system_desc' },
  ];

  displayMounts.push(
    mount(themeRadioGroup, () =>
      each(
        () => themes,
        (theme) => theme.value,
        (theme) =>
          legacy(
            createChoiceCard({
              name: 'theme',
              value: theme().value,
              checked: currentTheme === theme().value,
              labelKey: theme().labelKey,
              descKey: theme().descKey,
              onChange: () => {
                setTheme(theme().value);
                displayMessage.textContent = t('settings.display_saved');
                displayMessage.style.color = 'var(--accent-text)';
              },
            }),
          ),
      ),
    ),
  );

  const displayMessage = document.createElement('div');
  displayMessage.setAttribute('role', 'status');
  displayMessage.className = 'settings-status';

  displaySection.appendChild(displayTitle);
  displaySection.appendChild(radioGroup);
  displaySection.appendChild(nsfwLabel);
  displaySection.appendChild(dataSaverLabel);
  displaySection.appendChild(themeTitle);
  displaySection.appendChild(themeRadioGroup);
  displaySection.appendChild(displayMessage);

  // Crowd Section (opt in/out of donating browser compute)
  const crowdSection = document.createElement('div');
  crowdSection.className = 'settings-section';

  const nodeAvailable = canRunFlaxiaNode();

  let crowdCheckbox!: HTMLInputElement;
  let crowdStatus!: HTMLElement;
  let crowdMessage!: HTMLElement;

  displayMounts.push(
    mount(
      crowdSection,
      () => html`
        <h2>${t('settings.crowd')}</h2>
        <label class=${nodeAvailable ? 'settings-switch-row' : 'settings-switch-row settings-switch-row--disabled'}>
          <div class="settings-switch-text">
            <span class="settings-switch-name">${t('settings.crowd')}</span>
            <span class="settings-switch-desc">${t('settings.crowd_desc')}</span>
          </div>
          <input
            class="settings-switch"
            type="checkbox"
            ?checked=${getCrowdConsentState() === 'granted'}
            ?disabled=${!nodeAvailable}
            ref=${(element: Element | null) => {
              if (element) crowdCheckbox = element as HTMLInputElement;
            }}
          />
        </label>
        <div
          class="settings-status settings-status--sm"
          ref=${(element: Element | null) => {
            if (element) crowdStatus = element as HTMLElement;
          }}
        ></div>
        <div
          class="settings-status"
          role="status"
          ref=${(element: Element | null) => {
            if (element) crowdMessage = element as HTMLElement;
          }}
        ></div>
      `,
    ),
  );

  const updateCrowdStatus = () => {
    if (!nodeAvailable) {
      crowdStatus.textContent = t('settings.crowd_unavailable');
      return;
    }
    const state = getCrowdConsentState();
    crowdStatus.textContent =
      state === 'granted'
        ? t('settings.crowd_running')
        : state === 'denied'
          ? t('settings.crowd_denied')
          : t('settings.crowd_unset');
    crowdStatus.style.color = state === 'granted' ? 'var(--accent-text)' : 'var(--text-muted)';
  };
  updateCrowdStatus();

  crowdCheckbox.addEventListener('change', async () => {
    if (!nodeAvailable) return;
    // The node controller is created during deferred app init; make sure it
    // exists before mutating state so a fast navigation never loses the toggle.
    if (!getCrowdNodeController()) {
      try {
        await initCrowdNode();
      } catch {
        // fall through to the availability check below
      }
    }
    if (!getCrowdNodeController()) {
      crowdMessage.textContent = t('settings.crowd_unavailable');
      crowdMessage.style.color = 'var(--danger-text)';
      crowdCheckbox.checked = false;
      return;
    }
    if (crowdCheckbox.checked) {
      grantCrowdConsent();
      startCrowdNode();
    } else {
      denyCrowdConsent();
      stopCrowdNode();
    }
    updateCrowdStatus();
    crowdMessage.textContent = t('settings.crowd_saved');
    crowdMessage.style.color = 'var(--accent-text)';
  });

  // Stay in sync if consent is changed elsewhere (e.g. the consent modal).
  const onCrowdConsentChange = () => {
    crowdCheckbox.checked = getCrowdConsentState() === 'granted';
    updateCrowdStatus();
  };
  window.addEventListener(CROWD_CONSENT_CHANGE_EVENT, onCrowdConsentChange);

  // The node bundle is loaded during deferred app init, which may run after this
  // screen renders (e.g. a direct /settings reload). Load its persisted consent
  // state through the public API so the toggle is correct on first paint.
  void resolveCrowdConsentState().then(onCrowdConsentChange);

  // Language Section
  const languageSection = document.createElement('div');
  languageSection.className = 'settings-section';

  let languageSelect!: HTMLSelectElement;
  let languageSaveButton!: HTMLButtonElement;
  let languageMessage!: HTMLElement;
  const languageLocales = signal<Array<{ code: string; nativeName: string }>>([]);

  displayMounts.push(
    mount(
      languageSection,
      () => html`
        <h2>${t('settings.language')}</h2>
        <select
          class="settings-input"
          aria-label=${t('settings.language')}
          ref=${(element: Element | null) => {
            if (element) languageSelect = element as unknown as HTMLSelectElement;
          }}
        >
          ${each(
            () => languageLocales(),
            (locale) => locale.code,
            (locale) => html`<option value=${locale().code}>${locale().nativeName}</option>`,
          )}
        </select>
        <button
          class="settings-save"
          ref=${(element: Element | null) => {
            if (element) languageSaveButton = element as HTMLButtonElement;
          }}
        >
          ${t('common.save')}
        </button>
        <div
          class="settings-status"
          role="status"
          ref=${(element: Element | null) => {
            if (element) languageMessage = element as HTMLElement;
          }}
        ></div>
      `,
    ),
  );

  const applyLanguageSelection = () => {
    const desired = currentUser?.language || getLocale();
    if ([...languageSelect.options].some((option) => option.value === desired)) {
      languageSelect.value = desired;
    }
  };

  fetch('/locales/index.json')
    .then((r) => r.json())
    .then((locales) => {
      languageLocales.set(locales as { code: string; nativeName: string }[]);
      applyLanguageSelection();
    })
    .catch(() => {
      languageLocales.set([
        { code: 'en', nativeName: 'en' },
        { code: 'ja', nativeName: 'ja' },
      ]);
      applyLanguageSelection();
    });

  // Email Section
  const emailSection = document.createElement('div');
  emailSection.className = 'settings-section';

  let currentPasswordInput!: HTMLInputElement;
  let newEmailInput!: HTMLInputElement;
  let emailSaveButton!: HTMLButtonElement;
  let emailMessage!: HTMLElement;

  displayMounts.push(
    mount(
      emailSection,
      () => html`
        <h2>${t('settings.change_email')}</h2>
        <label class="settings-label" for="settings-email-current-password">
          ${t('settings.email_current_password')}
        </label>
        <input
          class="settings-input"
          id="settings-email-current-password"
          type="password"
          autocomplete="current-password"
          placeholder=${t('settings.email_current_password_placeholder')}
          ref=${(element: Element | null) => {
            if (element) currentPasswordInput = element as unknown as HTMLInputElement;
          }}
        />
        <label class="settings-label" for="settings-new-email">${t('settings.email_new_email')}</label>
        <input
          class="settings-input"
          id="settings-new-email"
          type="email"
          autocomplete="email"
          placeholder=${t('settings.email_new_email_placeholder')}
          ref=${(element: Element | null) => {
            if (element) newEmailInput = element as unknown as HTMLInputElement;
          }}
        />
        <button
          class="settings-save"
          ref=${(element: Element | null) => {
            if (element) emailSaveButton = element as unknown as HTMLButtonElement;
          }}
        >
          ${t('common.save')}
        </button>
        <div
          class="settings-status"
          role="status"
          ref=${(element: Element | null) => {
            if (element) emailMessage = element as HTMLElement;
          }}
        ></div>
      `,
    ),
  );

  // Password Section
  const passwordSection = document.createElement('div');
  passwordSection.className = 'settings-section';

  const recoveryMode = sessionStorage.getItem('flaxia.recovery-login') === '1';

  let currentPasswordInput2!: HTMLInputElement;
  let newPasswordInput!: HTMLInputElement;
  let confirmPasswordInput!: HTMLInputElement;
  let passwordSaveButton!: HTMLButtonElement;
  let passwordMessage!: HTMLElement;

  displayMounts.push(
    mount(
      passwordSection,
      () => html`
        <h2>${t('settings.change_password')}</h2>
        <label class="settings-label" for="settings-password-current">
          ${recoveryMode ? t('settings.recovery_code_label') : t('settings.password_current')}
        </label>
        <input
          class="settings-input"
          id="settings-password-current"
          type="password"
          autocomplete="current-password"
          placeholder=${
            recoveryMode ? t('login.recovery_code_placeholder') : t('settings.password_current_placeholder')
          }
          ref=${(element: Element | null) => {
            if (element) currentPasswordInput2 = element as unknown as HTMLInputElement;
          }}
        />
        <label class="settings-label" for="settings-new-password">${t('settings.password_new')}</label>
        <input
          class="settings-input"
          id="settings-new-password"
          type="password"
          autocomplete="new-password"
          placeholder=${t('settings.password_new_placeholder')}
          ref=${(element: Element | null) => {
            if (element) newPasswordInput = element as unknown as HTMLInputElement;
          }}
        />
        <label class="settings-label" for="settings-confirm-password">
          ${t('settings.password_confirm')}
        </label>
        <input
          class="settings-input"
          id="settings-confirm-password"
          type="password"
          autocomplete="new-password"
          placeholder=${t('settings.password_confirm_placeholder')}
          ref=${(element: Element | null) => {
            if (element) confirmPasswordInput = element as unknown as HTMLInputElement;
          }}
        />
        <button
          class="settings-save"
          ref=${(element: Element | null) => {
            if (element) passwordSaveButton = element as unknown as HTMLButtonElement;
          }}
        >
          ${t('common.save')}
        </button>
        <div
          class="settings-status"
          role="status"
          ref=${(element: Element | null) => {
            if (element) passwordMessage = element as HTMLElement;
          }}
        ></div>
      `,
    ),
  );

  const recoveryButton = document.createElement('button');
  recoveryButton.type = 'button';
  recoveryButton.className = 'settings-save';
  recoveryButton.textContent = t('settings.recovery_create');
  recoveryButton.hidden = true;
  // Enrollment is available for every Auth-linked session, including the
  // opt-in linking phase before AUTH_AUTHORITY_MODE is enabled.
  void fetch('/api/auth/recovery/status', { credentials: 'include', cache: 'no-store' })
    .then((response) => {
      recoveryButton.hidden = !response.ok;
    })
    .catch(() => {});
  passwordSection.appendChild(recoveryButton);
  recoveryButton.addEventListener('click', async () => {
    const password = window.prompt(t('settings.recovery_current_password'));
    if (!password) return;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const code = b64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    if (!(await createConfirmDialog(`${t('settings.recovery_save_code')}\n\n${code}`))) return;
    recoveryButton.disabled = true;
    try {
      const salt = generateSalt();
      const verifier = await computeVerifier(code, salt, DEFAULT_SRP_KDF);
      const proof = await createSrpProof(password);
      if (!proof) throw new Error('Recovery proof unavailable');
      const response = await fetch('/api/auth/recovery/enroll', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt: b64(salt), verifier: b64(verifier), kdf: DEFAULT_SRP_KDF, current_srp: proof }),
      });
      window.alert(t(response.ok ? 'settings.recovery_enabled' : 'settings.recovery_failed'));
    } catch {
      window.alert(t('settings.recovery_failed'));
    } finally {
      recoveryButton.disabled = false;
    }
  });

  // Event handlers
  languageSaveButton.addEventListener('click', async () => {
    const language = languageSelect.value;
    languageMessage.textContent = '';
    languageSaveButton.disabled = true;
    languageSaveButton.style.opacity = '0.6';

    try {
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language }),
      });

      if (response.ok) {
        languageMessage.textContent = t('settings.language_saved');
        languageMessage.style.color = 'var(--accent-text)';
        await setLocale(language);
        location.reload();
      } else {
        const errorData = (await response.json()) as { error?: string };
        languageMessage.textContent = errorData.error || t('settings.language_save_failed');
        languageMessage.style.color = 'var(--danger-text)';
      }
    } catch (_error: unknown) {
      languageMessage.textContent = t('settings.language_network_error');
      languageMessage.style.color = 'var(--danger-text)';
    } finally {
      languageSaveButton.disabled = false;
      languageSaveButton.style.opacity = '1';
    }
  });

  emailSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput.value.trim();
    const newEmail = newEmailInput.value.trim();

    if (!currentPassword || !newEmail) {
      emailMessage.textContent = t('settings.email_fill_all');
      emailMessage.style.color = 'var(--danger-text)';
      return;
    }

    emailMessage.textContent = '';
    emailSaveButton.disabled = true;
    emailSaveButton.style.opacity = '0.6';

    try {
      // Re-authenticate with an SRP proof: the server verifies knowledge of
      // the current password without ever receiving it.
      const proof = await createSrpProof(currentPassword);
      if (!proof) {
        emailMessage.textContent = t('settings.current_password_incorrect');
        emailMessage.style.color = 'var(--danger-text)';
        return;
      }

      const response = await fetch('/api/users/me/email', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ current_srp: proof, new_email: newEmail }),
      });

      if (response.ok) {
        emailMessage.textContent = t('settings.email_saved');
        emailMessage.style.color = 'var(--accent-text)';
        currentPasswordInput.value = '';
        newEmailInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string };
        emailMessage.textContent = errorData.error || t('settings.email_save_failed');
        emailMessage.style.color = 'var(--danger-text)';
      }
    } catch (_error: unknown) {
      emailMessage.textContent = t('settings.email_network_error');
      emailMessage.style.color = 'var(--danger-text)';
    } finally {
      emailSaveButton.disabled = false;
      emailSaveButton.style.opacity = '1';
    }
  });

  passwordSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput2.value.trim();
    const newPassword = newPasswordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordMessage.textContent = t('settings.password_fill_all');
      passwordMessage.style.color = 'var(--danger-text)';
      return;
    }

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = t('settings.password_mismatch');
      passwordMessage.style.color = 'var(--danger-text)';
      return;
    }

    if (passwordLengthError(newPassword)) {
      passwordMessage.textContent = t('settings.password_length');
      passwordMessage.style.color = 'var(--danger-text)';
      return;
    }

    passwordMessage.textContent = '';
    passwordSaveButton.disabled = true;
    passwordSaveButton.style.opacity = '0.6';

    try {
      if (!currentUser) return;
      const previous = await retryPendingCredentialChange();
      if (previous === 'committed') {
        // A different, earlier submission was completed. The password in this
        // form was never sent, so do not claim it was saved.
        passwordMessage.textContent = t('settings.password_previous_completed');
        passwordMessage.style.color = 'var(--success, #10b981)';
        currentPasswordInput2.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        return;
      }
      if (previous === 'pending') {
        passwordMessage.textContent = t('settings.password_change_pending');
        passwordMessage.style.color = 'var(--danger)';
        return;
      }
      // Derive a fresh SRP verifier from the new password so the account
      // continues to authenticate via SRP after the change. Neither the
      // current nor the new password is sent to the server: the current one is
      // proven with an SRP handshake, the new one only as its verifier.
      const salt = generateSalt();
      const verifier = await computeVerifier(newPassword, salt, DEFAULT_SRP_KDF);

      const recovering = sessionStorage.getItem('flaxia.recovery-login') === '1';
      const currentSrp = await createSrpProof(currentPassword, recovering);
      if (!currentSrp) {
        passwordMessage.textContent = t('settings.current_password_incorrect');
        passwordMessage.style.color = 'var(--danger-text)';
        return;
      }

      // Carry the vault across: VK is wrapped under a KEK derived from the OLD
      // password, so it must be re-wrapped inside this very request. Refusing
      // to proceed beats storing an envelope the new password cannot open.
      let vaultSecret = currentPassword;
      if (recovering) {
        const keys = await fetchVaultKeys();
        if (!keys) throw new Error('Vault unavailable');
        if (keys.enabled) {
          const phrase = window.prompt(t('settings.recovery_vault_phrase'));
          if (!phrase) return;
          vaultSecret = phrase;
        }
      }
      const vaultRewrap = await prepareVaultRewrap(vaultSecret, newPassword, recovering);
      if (vaultRewrap.status === 'unlock_failed') {
        passwordMessage.textContent = t('settings.current_password_incorrect');
        passwordMessage.style.color = 'var(--danger-text)';
        return;
      }
      if (vaultRewrap.status === 'error') {
        passwordMessage.textContent = t('settings.password_save_failed');
        passwordMessage.style.color = 'var(--danger-text)';
        return;
      }

      const operation = credentialOperationFor(currentUser.id);

      const response = await fetch('/api/users/me/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          srp_salt: b64(salt),
          srp_verifier: b64(verifier),
          srp_group: '2048',
          srp_kdf: DEFAULT_SRP_KDF,
          current_srp: currentSrp,
          operation,
          ...(recovering ? { recovery: true } : {}),
          ...(vaultRewrap.status === 'ok' ? { vault_kek: vaultRewrap.fields } : {}),
        }),
      });

      if (response.ok) {
        clearCredentialOperation();
        if (recovering) sessionStorage.removeItem('flaxia.recovery-login');
        storeSrpSalt(salt);
        if (vaultRewrap.status === 'ok') await syncVaultVersionAfterRewrap();
        passwordMessage.textContent = t('settings.password_saved');
        passwordMessage.style.color = 'var(--accent-text)';
        currentPasswordInput2.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string; cancelled?: boolean };
        if (errorData.cancelled) clearCredentialOperation();
        const message =
          errorData.error === 'vault_rewrap_required'
            ? t('settings.vault_rewrap_required')
            : errorData.error === 'vault_key_version_conflict'
              ? t('settings.vault_changed')
              : errorData.error || t('settings.password_save_failed');
        passwordMessage.textContent = message;
        passwordMessage.style.color = 'var(--danger-text)';
      }
    } catch (_error: unknown) {
      passwordMessage.textContent = t('settings.password_network_error');
      passwordMessage.style.color = 'var(--danger-text)';
    } finally {
      passwordSaveButton.disabled = false;
      passwordSaveButton.style.opacity = '1';
    }
  });

  // Add hover effects
  const buttons = [languageSaveButton, emailSaveButton, passwordSaveButton];
  buttons.forEach((button: HTMLButtonElement) => {
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) {
        button.style.opacity = '0.8';
      }
    });
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) {
        button.style.opacity = '1';
      }
    });
  });

  // ─── Personal Vault Section ──────────────────────────────────────────────
  // Own component: it has three states of its own (setup / locked / unlocked)
  // and timers to clean up, which would drown the settings page otherwise.
  const vaultSection = currentUser ? createVaultSection() : null;

  // ─── Titles Section ───────────────────────────────────────────────────────
  // Titles are awarded by other systems (for example Arcade achievements).
  // Settings only lists what the user owns; equipping happens in the profile
  // editor.
  if (currentUser) {
    titlesSection = document.createElement('div');
    titlesSection.className = 'settings-section';

    const titlesTitle = document.createElement('h2');
    titlesTitle.textContent = t('settings.titles') || 'Titles';

    const titlesDesc = document.createElement('p');
    titlesDesc.textContent =
      t('settings.titles_desc') || 'Titles you have earned. Choose one to show after your username from Edit profile.';
    titlesDesc.style.cssText = 'color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1rem;';

    const titlesGrid = document.createElement('div');
    titlesGrid.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';

    titlesSection.appendChild(titlesTitle);
    titlesSection.appendChild(titlesDesc);
    titlesSection.appendChild(titlesGrid);

    const titlesSignal = signal<TitleEntry[]>([]);

    const renderTitleEntry = (entry: TitleEntry): HTMLElement => {
      if (entry.kind === 'empty' || entry.kind === 'error') {
        const message = document.createElement('p');
        message.textContent =
          entry.kind === 'empty'
            ? t('settings.titles_empty') || 'You have not earned any titles yet.'
            : t('settings.titles_load_failed') || 'Failed to load titles.';
        message.style.cssText = 'color: var(--text-muted); font-size: 0.875rem;';
        return message;
      }

      const title = entry.title;
      const card = document.createElement('div');
      card.style.cssText = `
        display: flex;
        align-items: flex-start;
        gap: 0.875rem;
        padding: 0.875rem 1rem;
        border: 1px solid ${title.equipped ? 'var(--accent)' : 'var(--border)'};
        border-radius: 8px;
        background: var(--bg-secondary);
      `;

      const iconEl = createTitleIcon(title.icon, 'settings-title-icon');

      const text = document.createElement('div');
      text.style.cssText = 'min-width: 0; flex: 1;';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;';

      const name = document.createElement('strong');
      name.textContent = titleName(title);
      name.style.cssText = 'color: var(--text-primary);';
      nameRow.appendChild(name);

      if (title.equipped) {
        const equipped = document.createElement('span');
        equipped.textContent = t('settings.titles_equipped') || 'Equipped';
        equipped.style.cssText =
          'font-size: 0.6875rem; font-weight: 600; color: var(--accent); border: 1px solid var(--accent); border-radius: 9999px; padding: 0.0625rem 0.5rem;';
        nameRow.appendChild(equipped);
      }

      const description = document.createElement('div');
      description.textContent = titleDescription(title);
      description.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem; margin-top: 0.25rem;';

      text.appendChild(nameRow);
      text.appendChild(description);
      if (iconEl) card.appendChild(iconEl);
      card.appendChild(text);
      return card;
    };

    titlesMount = mount(titlesGrid, () =>
      each(
        () => titlesSignal(),
        (entry) => (entry.kind === 'title' ? entry.title.id : entry.kind),
        (entry) => legacy(renderTitleEntry(entry())),
      ),
    );

    fetch('/api/titles/me', { credentials: 'include' })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ titles?: SettingsTitle[] }>)
          : Promise.reject(new Error(String(response.status))),
      )
      .then((data) => {
        const titles = data.titles ?? [];
        titlesSignal.set(titles.length === 0 ? [{ kind: 'empty' }] : titles.map((title) => ({ kind: 'title', title })));
      })
      .catch(() => {
        titlesSignal.set([{ kind: 'error' }]);
      });
  }

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

  // Maps section: on-device tile cache + city tile packs.
  const mapsSection = document.createElement('div');
  mapsSection.className = 'settings-section';

  const mapsTitle = document.createElement('h2');
  mapsTitle.textContent = 'Maps';
  mapsSection.appendChild(mapsTitle);

  const cacheStatus = document.createElement('p');
  cacheStatus.className = 'settings-row-label';
  cacheStatus.textContent = '確認中…';
  mapsSection.appendChild(cacheStatus);

  const cacheActions = document.createElement('div');
  cacheActions.className = 'settings-choice-list';
  const persistBtn = document.createElement('button');
  persistBtn.type = 'button';
  persistBtn.className = 'settings-radio-card';
  persistBtn.textContent = 'オフライン保存を許可';
  persistBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await requestStoragePersistence();
      cacheStatus.textContent = ok ? '保存が許可されました' : 'このブラウザでは許可できませんでした';
    })();
  });
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'settings-radio-card';
  clearBtn.textContent = 'キャッシュ削除';
  clearBtn.addEventListener('click', () => {
    void (async () => {
      await clearTileCache();
      await refreshCacheStatus();
    })();
  });
  cacheActions.appendChild(persistBtn);
  cacheActions.appendChild(clearBtn);
  mapsSection.appendChild(cacheActions);

  async function refreshCacheStatus(): Promise<void> {
    try {
      const stats = await getTileCacheStats();
      cacheStatus.textContent =
        stats.count === 0
          ? 'キャッシュなし（表示すると保存されます）'
          : `${stats.count}件 / ${(stats.bytes / 1024 / 1024).toFixed(1)}MB`;
    } catch {
      cacheStatus.textContent = 'キャッシュ状態を取得できませんでした';
    }
  }
  void refreshCacheStatus();

  // City tile packs
  const packTitle = document.createElement('h3');
  packTitle.textContent = '都市タイル / City pack';
  mapsSection.appendChild(packTitle);

  const cities: { id: string; name: string }[] = [
    { id: 'tokyo', name: '東京' },
    { id: 'osaka', name: '大阪' },
    { id: 'nagoya', name: '名古屋' },
  ];
  const citySelect = document.createElement('select');
  citySelect.className = 'settings-radio';
  for (const c of cities) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    citySelect.appendChild(opt);
  }
  mapsSection.appendChild(citySelect);

  const packStatus = document.createElement('p');
  packStatus.className = 'settings-row-label';
  packStatus.textContent = '未取得';
  mapsSection.appendChild(packStatus);

  const fetchBtn = document.createElement('button');
  fetchBtn.type = 'button';
  fetchBtn.className = 'settings-radio-card';
  fetchBtn.textContent = '地図タイル取得 / Fetch';
  fetchBtn.addEventListener('click', () => {
    void (async () => {
      const cityId = citySelect.value;
      const packPath = `/api/maps/packs/${encodeURIComponent(cityId)}/pmtiles`;
      try {
        const res = await fetch(packPath);
        if (!res.ok || !res.body) {
          packStatus.textContent = `${cityId}: 未配信（ライブ表示中）`;
          return;
        }
        let received = 0;
        const counting = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, encoder) {
            received += chunk.byteLength;
            if (received > 100 * 1024 * 1024) {
              encoder.error(new Error('pack too large'));
              return;
            }
            encoder.enqueue(chunk);
          },
        });
        const streamed = res.body.pipeThrough(counting);
        const cache = await caches.open('flaxia-maps-packs');
        await cache.put(packPath, new Response(streamed, { headers: { 'Content-Type': 'application/octet-stream' } }));
        packStatus.textContent = `${cityId}: 取得済み (${Math.round(received / 1024 / 1024)}MB)`;
      } catch (_error) {
        packStatus.textContent = `${cityId}: 取得に失敗しました`;
      }
    })();
  });
  mapsSection.appendChild(fetchBtn);

  if (accountSection) {
    navigation.addCategory({
      id: 'account',
      groupKey: 'settings.group_account',
      titleKey: 'settings.account',
      descriptionKey: 'settings.account_description',
      iconName: 'user',
      sections: [accountSection, emailSection],
    });
  }
  if (vaultSection) {
    navigation.addCategory({
      id: 'security',
      groupKey: 'settings.group_account',
      titleKey: 'settings.security',
      descriptionKey: 'settings.security_description',
      iconName: 'key',
      sections: [passwordSection, vaultSection.getElement()],
    });
  }
  navigation.addCategory({
    id: 'appearance',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.appearance',
    descriptionKey: 'settings.appearance_description',
    iconName: 'settings',
    sections: [displaySection, languageSection],
  });
  if (emojiSection) {
    navigation.addCategory({
      id: 'emoji',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.custom_emoji',
      descriptionKey: 'settings.emoji_description',
      iconName: 'emoji',
      sections: [emojiSection],
    });
  }
  if (titlesSection) {
    navigation.addCategory({
      id: 'titles',
      groupKey: 'settings.group_preferences',
      titleKey: 'settings.titles',
      descriptionKey: 'settings.titles_description',
      iconName: 'game',
      sections: [titlesSection],
    });
  }
  if (billingSection) {
    navigation.addCategory({
      id: 'billing',
      groupKey: 'settings.group_more',
      titleKey: 'settings.billing',
      descriptionKey: 'settings.billing_description',
      iconName: 'fresh',
      sections: [billingSection],
    });
  }
  navigation.addCategory({
    id: 'crowd',
    groupKey: 'settings.group_more',
    titleKey: 'settings.crowd',
    descriptionKey: 'settings.crowd_description',
    iconName: 'poll',
    sections: [crowdSection],
  });
  navigation.addCategory({
    id: 'maps',
    groupKey: 'settings.group_preferences',
    titleKey: 'settings.maps',
    descriptionKey: 'settings.maps_description',
    iconName: 'maps',
    sections: [mapsSection],
  });
  navigation.addCategory({
    id: 'bug-report',
    groupKey: 'settings.group_other',
    titleKey: 'settings.bug_report',
    descriptionKey: 'settings.bug_report_description',
    iconName: 'flag',
    sections: [bugReportForm.getElement()],
  });
  navigation.showCategory(initialCategory ?? null, false);

  return {
    getActiveCategory: navigation.getActiveCategory,
    getElement: () => container,
    destroy: () => {
      window.removeEventListener(CROWD_CONSENT_CHANGE_EVENT, onCrowdConsentChange);
      titlesMount?.dispose();
      stampsMount?.dispose();
      historyMount?.dispose();
      for (const mounted of displayMounts) mounted.dispose();
      displayMounts.length = 0;
      vaultSection?.destroy();
      bugReportForm.destroy();
      container.remove();
    },
  };
}
