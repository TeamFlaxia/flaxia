import { clearMeCache } from '../lib/auth-cache';
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
import { passwordLengthError } from '../lib/password-policy.js';
import { getReplyStyle, getShowNsfw, ReplyStyle, setReplyStyle, setShowNsfw } from '../lib/settings.js';
import { computeVerifier, DEFAULT_SRP_KDF, generateSalt } from '../lib/srp.js';
import { getTheme, setTheme, Theme } from '../lib/theme.js';
import { prepareVaultRewrap } from '../lib/vault/client.js';
import { createAddStampModal } from './AddStampModal.js';
import { createVaultSection } from './VaultSection.js';

function b64(b: Uint8Array): string {
  let binary = '';
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary);
}

interface SettingsPageProps {
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    language?: string;
    email?: string;
  };
}

export function createSettingsPage({ currentUser }: SettingsPageProps) {
  const container = document.createElement('div');
  container.className = 'settings-page';
  container.style.cssText = `
    max-width: 600px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  `;

  const topBar = document.createElement('div');
  topBar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
    margin-bottom: 2rem;
  `;

  const backBtn = document.createElement('button');
  backBtn.textContent = '←';
  backBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: background 0.2s;
  `;
  backBtn.addEventListener('mouseenter', () => {
    backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
  });
  backBtn.addEventListener('mouseleave', () => {
    backBtn.style.background = 'none';
  });
  backBtn.addEventListener('click', () => window.history.back());

  const title = document.createElement('h1');
  title.textContent = t('settings.title');
  title.style.cssText = `
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  `;

  topBar.appendChild(backBtn);
  topBar.appendChild(title);
  container.appendChild(topBar);

  // Account Section
  if (currentUser) {
    const accountSection = document.createElement('div');
    accountSection.className = 'settings-section';
    accountSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const accountTitle = document.createElement('h2');
    accountTitle.textContent = t('settings.account');
    accountTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;

    const userChip = document.createElement('div');
    userChip.style.cssText = `
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    `;

    const avatarUrl = currentUser.avatar_key ? `/api/images/${currentUser.avatar_key}` : '/api/images/default-avatar';
    const displayName = currentUser.display_name || currentUser.username;

    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'position: relative; width: 60px; height: 60px; flex-shrink: 0;';
    const avatarEl = document.createElement('img');
    avatarEl.src = avatarUrl;
    avatarEl.alt = '';
    avatarEl.style.cssText =
      'width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border); display: block;';
    avatarEl.onerror = () => {
      avatarEl.src = '/api/images/default-avatar';
    };
    avatarWrap.appendChild(avatarEl);
    attachPlusBadge(avatarWrap, currentUser.badge_type);
    userChip.appendChild(avatarWrap);

    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'flex: 1; min-width: 0;';
    userChip.appendChild(infoDiv);

    const displayNameEl = document.createElement('div');
    displayNameEl.style.cssText =
      'font-size: 1.125rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    displayNameEl.textContent = displayName;
    infoDiv.appendChild(displayNameEl);

    const usernameEl = document.createElement('div');
    usernameEl.style.cssText =
      'color: var(--text-muted); font-family: monospace; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    usernameEl.textContent = `@${currentUser.username}`;
    infoDiv.appendChild(usernameEl);

    const logoutButton = document.createElement('button');
    logoutButton.textContent = t('auth.sign_out');
    logoutButton.style.cssText = `
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      padding: 0.75rem 1.5rem;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: all 0.2s;
    `;

    logoutButton.addEventListener('mouseenter', () => {
      logoutButton.style.backgroundColor = 'var(--bg-tertiary)';
    });
    logoutButton.addEventListener('mouseleave', () => {
      logoutButton.style.backgroundColor = 'var(--bg-secondary)';
    });

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
    deleteButton.style.cssText = `
      background: transparent;
      color: var(--danger);
      border: 1px solid var(--danger);
      padding: 0.75rem 1.5rem;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: all 0.2s;
      margin-top: 1.5rem;
    `;

    deleteButton.addEventListener('mouseenter', () => {
      deleteButton.style.backgroundColor = 'var(--danger)';
      deleteButton.style.color = '#fff';
    });
    deleteButton.addEventListener('mouseleave', () => {
      deleteButton.style.backgroundColor = 'transparent';
      deleteButton.style.color = 'var(--danger)';
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(
        t('settings.delete_account_confirm', { username: currentUser.username }),
      );
      if (!confirmed) return;
      try {
        const response = await fetch('/api/users/me', {
          method: 'DELETE',
          credentials: 'include',
        });

        if (response.ok) {
          clearMeCache();
          window.location.href = '/';
        } else {
          alert(t('settings.delete_account_failed'));
        }
      } catch (error) {
        console.error('Delete account error:', error);
        alert(t('settings.delete_account_error'));
      }
    });

    accountSection.appendChild(accountTitle);
    accountSection.appendChild(userChip);
    accountSection.appendChild(logoutButton);
    accountSection.appendChild(deleteButton);
    container.appendChild(accountSection);
  }

  // Display Section
  const displaySection = document.createElement('div');
  displaySection.className = 'settings-section';
  displaySection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const displayTitle = document.createElement('h2');
  displayTitle.textContent = t('settings.display');
  displayTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentStyle = getReplyStyle();

  const radioGroup = document.createElement('div');
  radioGroup.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  `;

  const styles: { value: ReplyStyle; labelKey: string; descKey: string }[] = [
    { value: 'twitter', labelKey: 'settings.reply_style_twitter', descKey: 'settings.reply_style_twitter_desc' },
    { value: '2ch', labelKey: 'settings.reply_style_2ch', descKey: 'settings.reply_style_2ch_desc' },
  ];

  styles.forEach((s) => {
    const label = document.createElement('label');
    label.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s;
      ${currentStyle === s.value ? 'border-color: var(--accent); background: var(--bg-secondary);' : ''}
    `;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'reply-style';
    radio.value = s.value;
    radio.checked = currentStyle === s.value;
    radio.style.cssText = 'accent-color: var(--accent);';

    const textDiv = document.createElement('div');
    textDiv.style.cssText = 'display: flex; flex-direction: column;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
    nameSpan.textContent = t(s.labelKey);

    const descSpan = document.createElement('span');
    descSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
    descSpan.textContent = t(s.descKey);

    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);
    label.appendChild(radio);
    label.appendChild(textDiv);
    radioGroup.appendChild(label);

    radio.addEventListener('change', () => {
      setReplyStyle(s.value);
      radioGroup.querySelectorAll('label').forEach((l) => {
        l.style.borderColor = 'var(--border)';
        l.style.background = 'none';
      });
      label.style.borderColor = 'var(--accent)';
      label.style.background = 'var(--bg-secondary)';
      displayMessage.textContent = t('settings.display_saved');
      displayMessage.style.color = 'var(--success, #10b981)';
    });
  });

  // NSFW toggle
  const nsfwLabel = document.createElement('label');
  nsfwLabel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.2s;
    margin-bottom: 1rem;
  `;

  const nsfwCheckbox = document.createElement('input');
  nsfwCheckbox.type = 'checkbox';
  nsfwCheckbox.checked = getShowNsfw();
  nsfwCheckbox.style.cssText = 'accent-color: var(--accent); width: 18px; height: 18px; cursor: pointer;';

  const nsfwTextDiv = document.createElement('div');
  nsfwTextDiv.style.cssText = 'display: flex; flex-direction: column;';

  const nsfwNameSpan = document.createElement('span');
  nsfwNameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
  nsfwNameSpan.textContent = t('settings.nsfw');

  const nsfwDescSpan = document.createElement('span');
  nsfwDescSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
  nsfwDescSpan.textContent = t('settings.nsfw_desc');

  nsfwTextDiv.appendChild(nsfwNameSpan);
  nsfwTextDiv.appendChild(nsfwDescSpan);
  nsfwLabel.appendChild(nsfwCheckbox);
  nsfwLabel.appendChild(nsfwTextDiv);

  nsfwCheckbox.addEventListener('change', () => {
    setShowNsfw(nsfwCheckbox.checked);
    displayMessage.textContent = t('settings.display_saved');
    displayMessage.style.color = 'var(--success, #10b981)';
  });

  // Theme selector
  const themeTitle = document.createElement('div');
  themeTitle.style.cssText = `
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.9375rem;
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
  `;
  themeTitle.textContent = t('settings.theme');

  const currentTheme = getTheme();
  const themeRadioGroup = document.createElement('div');
  themeRadioGroup.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  `;

  const themes: { value: Theme; labelKey: string; descKey: string }[] = [
    { value: 'light', labelKey: 'settings.theme_light', descKey: 'settings.theme_light_desc' },
    { value: 'dark', labelKey: 'settings.theme_dark', descKey: 'settings.theme_dark_desc' },
    { value: 'system', labelKey: 'settings.theme_system', descKey: 'settings.theme_system_desc' },
  ];

  themes.forEach((st) => {
    const label = document.createElement('label');
    label.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s;
      ${currentTheme === st.value ? 'border-color: var(--accent); background: var(--bg-secondary);' : ''}
    `;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'theme';
    radio.value = st.value;
    radio.checked = currentTheme === st.value;
    radio.style.cssText = 'accent-color: var(--accent);';

    const textDiv = document.createElement('div');
    textDiv.style.cssText = 'display: flex; flex-direction: column;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
    nameSpan.textContent = t(st.labelKey);

    const descSpan = document.createElement('span');
    descSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
    descSpan.textContent = t(st.descKey);

    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);
    label.appendChild(radio);
    label.appendChild(textDiv);
    themeRadioGroup.appendChild(label);

    radio.addEventListener('change', () => {
      setTheme(st.value);
      themeRadioGroup.querySelectorAll('label').forEach((l) => {
        l.style.borderColor = 'var(--border)';
        l.style.background = 'none';
      });
      label.style.borderColor = 'var(--accent)';
      label.style.background = 'var(--bg-secondary)';
      displayMessage.textContent = t('settings.display_saved');
      displayMessage.style.color = 'var(--success, #10b981)';
    });
  });

  const displayMessage = document.createElement('div');
  displayMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  displaySection.appendChild(displayTitle);
  displaySection.appendChild(radioGroup);
  displaySection.appendChild(nsfwLabel);
  displaySection.appendChild(themeTitle);
  displaySection.appendChild(themeRadioGroup);
  displaySection.appendChild(displayMessage);

  container.appendChild(displaySection);

  // Crowd Section (opt in/out of donating browser compute)
  const crowdSection = document.createElement('div');
  crowdSection.className = 'settings-section';
  crowdSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const crowdTitle = document.createElement('h2');
  crowdTitle.textContent = t('settings.crowd');
  crowdTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const nodeAvailable = canRunFlaxiaNode();

  const crowdLabel = document.createElement('label');
  crowdLabel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: ${nodeAvailable ? 'pointer' : 'not-allowed'};
    transition: border-color 0.2s;
    margin-bottom: 0.5rem;
    opacity: ${nodeAvailable ? '1' : '0.6'};
  `;

  const crowdCheckbox = document.createElement('input');
  crowdCheckbox.type = 'checkbox';
  crowdCheckbox.checked = getCrowdConsentState() === 'granted';
  crowdCheckbox.disabled = !nodeAvailable;
  crowdCheckbox.style.cssText = 'accent-color: var(--accent); width: 18px; height: 18px; cursor: pointer;';

  const crowdTextDiv = document.createElement('div');
  crowdTextDiv.style.cssText = 'display: flex; flex-direction: column;';

  const crowdNameSpan = document.createElement('span');
  crowdNameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
  crowdNameSpan.textContent = t('settings.crowd');

  const crowdDescSpan = document.createElement('span');
  crowdDescSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
  crowdDescSpan.textContent = t('settings.crowd_desc');

  crowdTextDiv.appendChild(crowdNameSpan);
  crowdTextDiv.appendChild(crowdDescSpan);
  crowdLabel.appendChild(crowdCheckbox);
  crowdLabel.appendChild(crowdTextDiv);

  const crowdStatus = document.createElement('div');
  crowdStatus.style.cssText = 'font-size: 0.8125rem; color: var(--text-muted);';

  const crowdMessage = document.createElement('div');
  crowdMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

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
    crowdStatus.style.color = state === 'granted' ? 'var(--success, #10b981)' : 'var(--text-muted)';
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
      crowdMessage.style.color = 'var(--danger, #ef4444)';
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
    crowdMessage.style.color = 'var(--success, #10b981)';
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

  crowdSection.appendChild(crowdTitle);
  crowdSection.appendChild(crowdLabel);
  crowdSection.appendChild(crowdStatus);
  crowdSection.appendChild(crowdMessage);

  container.appendChild(crowdSection);

  // Language Section
  const languageSection = document.createElement('div');
  languageSection.className = 'settings-section';
  languageSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const languageTitle = document.createElement('h2');
  languageTitle.textContent = t('settings.language');
  languageTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const languageSelect = document.createElement('select');
  languageSelect.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    cursor: pointer;
  `;

  fetch('/locales/index.json')
    .then((r) => r.json())
    .then((locales) => {
      languageSelect.innerHTML = '';
      (locales as { code: string; nativeName: string }[]).forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.nativeName;
        languageSelect.appendChild(opt);
      });
      if (currentUser?.language) {
        languageSelect.value = currentUser.language;
      } else {
        languageSelect.value = getLocale();
      }
    })
    .catch(() => {
      ['en', 'ja'].forEach((code) => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code;
        languageSelect.appendChild(opt);
      });
    });

  // Set current language
  if (currentUser?.language) {
    languageSelect.value = currentUser.language;
  }

  const languageSaveButton = document.createElement('button');
  languageSaveButton.textContent = t('common.save');
  languageSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const languageMessage = document.createElement('div');
  languageMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  languageSection.appendChild(languageTitle);
  languageSection.appendChild(languageSelect);
  languageSection.appendChild(languageSaveButton);
  languageSection.appendChild(languageMessage);

  // Email Section
  const emailSection = document.createElement('div');
  emailSection.className = 'settings-section';
  emailSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const emailTitle = document.createElement('h2');
  emailTitle.textContent = t('settings.change_email');
  emailTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentPasswordLabel = document.createElement('label');
  currentPasswordLabel.textContent = t('settings.email_current_password');
  currentPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const currentPasswordInput = document.createElement('input');
  currentPasswordInput.type = 'password';
  currentPasswordInput.placeholder = t('settings.email_current_password_placeholder');
  currentPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const newEmailLabel = document.createElement('label');
  newEmailLabel.textContent = t('settings.email_new_email');
  newEmailLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const newEmailInput = document.createElement('input');
  newEmailInput.type = 'email';
  newEmailInput.placeholder = t('settings.email_new_email_placeholder');
  newEmailInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const emailSaveButton = document.createElement('button');
  emailSaveButton.textContent = t('common.save');
  emailSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const emailMessage = document.createElement('div');
  emailMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  emailSection.appendChild(emailTitle);
  emailSection.appendChild(currentPasswordLabel);
  emailSection.appendChild(currentPasswordInput);
  emailSection.appendChild(newEmailLabel);
  emailSection.appendChild(newEmailInput);
  emailSection.appendChild(emailSaveButton);
  emailSection.appendChild(emailMessage);

  // Password Section
  const passwordSection = document.createElement('div');
  passwordSection.className = 'settings-section';
  passwordSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const passwordTitle = document.createElement('h2');
  passwordTitle.textContent = t('settings.change_password');
  passwordTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentPasswordLabel2 = document.createElement('label');
  currentPasswordLabel2.textContent = t('settings.password_current');
  currentPasswordLabel2.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const currentPasswordInput2 = document.createElement('input');
  currentPasswordInput2.type = 'password';
  currentPasswordInput2.placeholder = t('settings.password_current_placeholder');
  currentPasswordInput2.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const newPasswordLabel = document.createElement('label');
  newPasswordLabel.textContent = t('settings.password_new');
  newPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const newPasswordInput = document.createElement('input');
  newPasswordInput.type = 'password';
  newPasswordInput.placeholder = t('settings.password_new_placeholder');
  newPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const confirmPasswordLabel = document.createElement('label');
  confirmPasswordLabel.textContent = t('settings.password_confirm');
  confirmPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const confirmPasswordInput = document.createElement('input');
  confirmPasswordInput.type = 'password';
  confirmPasswordInput.placeholder = t('settings.password_confirm_placeholder');
  confirmPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const passwordSaveButton = document.createElement('button');
  passwordSaveButton.textContent = t('common.save');
  passwordSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const passwordMessage = document.createElement('div');
  passwordMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  passwordSection.appendChild(passwordTitle);
  passwordSection.appendChild(currentPasswordLabel2);
  passwordSection.appendChild(currentPasswordInput2);
  passwordSection.appendChild(newPasswordLabel);
  passwordSection.appendChild(newPasswordInput);
  passwordSection.appendChild(confirmPasswordLabel);
  passwordSection.appendChild(confirmPasswordInput);
  passwordSection.appendChild(passwordSaveButton);
  passwordSection.appendChild(passwordMessage);

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
        languageMessage.style.color = 'var(--success, #10b981)';
        await setLocale(language);
        location.reload();
      } else {
        const errorData = (await response.json()) as { error?: string };
        languageMessage.textContent = errorData.error || t('settings.language_save_failed');
        languageMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      languageMessage.textContent = t('settings.language_network_error');
      languageMessage.style.color = 'var(--danger)';
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
      emailMessage.style.color = 'var(--danger)';
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
        emailMessage.style.color = 'var(--danger)';
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
        emailMessage.style.color = 'var(--success, #10b981)';
        currentPasswordInput.value = '';
        newEmailInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string };
        emailMessage.textContent = errorData.error || t('settings.email_save_failed');
        emailMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      emailMessage.textContent = t('settings.email_network_error');
      emailMessage.style.color = 'var(--danger)';
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
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = t('settings.password_mismatch');
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    if (passwordLengthError(newPassword)) {
      passwordMessage.textContent = t('settings.password_length');
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    passwordMessage.textContent = '';
    passwordSaveButton.disabled = true;
    passwordSaveButton.style.opacity = '0.6';

    try {
      // Derive a fresh SRP verifier from the new password so the account
      // continues to authenticate via SRP after the change. Neither the
      // current nor the new password is sent to the server: the current one is
      // proven with an SRP handshake, the new one only as its verifier.
      const salt = generateSalt();
      const verifier = await computeVerifier(newPassword, salt, DEFAULT_SRP_KDF);

      const currentSrp = await createSrpProof(currentPassword);
      if (!currentSrp) {
        passwordMessage.textContent = t('settings.current_password_incorrect');
        passwordMessage.style.color = 'var(--danger)';
        return;
      }

      // Carry the vault across: VK is wrapped under a KEK derived from the OLD
      // password, so it must be re-wrapped inside this very request. Refusing
      // to proceed beats storing an envelope the new password cannot open.
      const vaultRewrap = await prepareVaultRewrap(currentPassword, newPassword);
      if (vaultRewrap.status === 'unlock_failed') {
        passwordMessage.textContent = t('settings.current_password_incorrect');
        passwordMessage.style.color = 'var(--danger)';
        return;
      }
      if (vaultRewrap.status === 'error') {
        passwordMessage.textContent = t('settings.password_save_failed');
        passwordMessage.style.color = 'var(--danger)';
        return;
      }

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
          ...(vaultRewrap.status === 'ok' ? { vault_kek: vaultRewrap.fields } : {}),
        }),
      });

      if (response.ok) {
        storeSrpSalt(salt);
        passwordMessage.textContent = t('settings.password_saved');
        passwordMessage.style.color = 'var(--success, #10b981)';
        currentPasswordInput2.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string };
        const message =
          errorData.error === 'vault_rewrap_required'
            ? t('settings.vault_rewrap_required')
            : errorData.error || t('settings.password_save_failed');
        passwordMessage.textContent = message;
        passwordMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      passwordMessage.textContent = t('settings.password_network_error');
      passwordMessage.style.color = 'var(--danger)';
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

  container.appendChild(languageSection);
  container.appendChild(emailSection);
  container.appendChild(passwordSection);

  // ─── Personal Vault Section ──────────────────────────────────────────────
  // Own component: it has three states of its own (setup / locked / unlocked)
  // and timers to clean up, which would drown the settings page otherwise.
  const vaultSection = createVaultSection();
  container.appendChild(vaultSection.getElement());

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
    const emojiSection = document.createElement('div');
    emojiSection.className = 'settings-section';
    emojiSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const emojiTitle = document.createElement('h2');
    emojiTitle.textContent = t('settings.custom_emoji') || 'Custom Emoji';
    emojiTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;

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

    function loadStamps() {
      fetch('/api/stamps', { credentials: 'include' })
        .then((r) => r.json() as Promise<{ stamps: Array<{ id: string; name: string; url: string }> }>)
        .then((data) => {
          stampsGrid.innerHTML = '';
          const unlimited = !!currentPlan.plan && ['active', 'trialing'].includes(currentPlan.status || '');
          emojiCountValue.textContent = unlimited ? `${data.stamps.length} / ∞` : `${data.stamps.length} / 5`;
          for (const stamp of data.stamps) {
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
            img.style.cssText =
              'width: 48px; height: 48px; object-fit: contain; margin-bottom: 0.25rem; flex-shrink: 0;';
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
              background: var(--danger, #ef4444);
              color: white;
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
              if (!confirm(t('settings.custom_emoji_delete_confirm', { name: stamp.name }) || `Delete ${stamp.name}?`))
                return;
              const res = await fetch(`/api/stamps/${stamp.id}`, { method: 'DELETE', credentials: 'include' });
              if (res.ok) loadStamps();
            });
            card.appendChild(delBtn);
            card.appendChild(img);
            card.appendChild(label);
            stampsGrid.appendChild(card);
          }

          // Add "add" card
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

          stampsGrid.appendChild(addCard);
        })
        .catch(() => {
          stampsGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:1rem;">${t('settings.custom_emoji_load_failed') || 'Failed to load stamps'}</div>`;
        });
    }

    emojiSection.appendChild(emojiTitle);
    emojiSection.appendChild(emojiDesc);
    emojiSection.appendChild(emojiCountRow);
    emojiSection.appendChild(stampsGrid);
    container.appendChild(emojiSection);

    refreshStamps = loadStamps;
    loadStamps();
  }

  // Billing Section (Flaxia+ only)
  if (currentUser) {
    const billingSection = document.createElement('div');
    billingSection.className = 'settings-section';
    billingSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const billingTitle = document.createElement('h2');
    billingTitle.textContent = t('settings.billing') || 'Billing & Plans';
    billingTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;
    billingSection.appendChild(billingTitle);

    // Current plan display
    const planInfo = document.createElement('div');
    planInfo.style.cssText = `
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 1rem;
      background: var(--bg-secondary);
    `;
    const planLabel = document.createElement('div');
    planLabel.style.cssText = 'font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;';
    planLabel.textContent = t('settings.current_plan') || 'Current Plan';
    const planName = document.createElement('div');
    planName.style.cssText = 'font-weight: 600; font-size: 1.125rem; color: var(--text-primary);';
    planName.textContent = t('settings.loading') || 'Loading...';
    const planMeta = document.createElement('div');
    planMeta.style.cssText = 'font-size: 0.8125rem; color: var(--text-secondary); margin-top: 0.35rem;';
    planInfo.appendChild(planLabel);
    planInfo.appendChild(planName);
    planInfo.appendChild(planMeta);
    billingSection.appendChild(planInfo);

    // Flaxia+ plan card
    const plusCard = document.createElement('div');
    plusCard.style.cssText = `
      border: 2px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    `;
    const plusName = document.createElement('div');
    plusName.style.cssText = 'font-weight: 700; font-size: 1rem; color: #8b5cf6; margin-bottom: 0.25rem;';
    plusName.textContent = 'Flaxia+';
    const plusPrice = document.createElement('div');
    plusPrice.style.cssText = 'margin-bottom: 0.75rem;';
    const plusPriceNum = document.createElement('span');
    plusPriceNum.style.cssText = 'font-size: 1.5rem; font-weight: 700; color: var(--text-primary);';
    plusPriceNum.textContent = '¥300';
    const plusPricePeriod = document.createElement('span');
    plusPricePeriod.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);';
    plusPricePeriod.textContent = '/mo';
    plusPrice.appendChild(plusPriceNum);
    plusPrice.appendChild(plusPricePeriod);

    const plusFeatures = document.createElement('ul');
    plusFeatures.style.cssText = 'list-style: none; padding: 0; margin: 0 0 0.5rem;';
    const plusFeatureLabels = [
      t('settings.plan_plus_f1') || 'Unlimited custom stamps',
      t('settings.plan_plus_f2') || 'GIF & MP4 stamps/icons/intro',
      t('settings.plan_plus_f3') || 'Flaxia+ avatar checkmark badge',
    ];
    plusFeatureLabels.forEach((feature) => {
      const li = document.createElement('li');
      li.style.cssText = 'font-size: 0.8125rem; color: var(--text-secondary); padding: 0.25rem 0;';
      li.textContent = `✓ ${feature}`;
      plusFeatures.appendChild(li);
    });

    const actionBtn = document.createElement('button');
    actionBtn.style.cssText = `
      width: 100%;
      padding: 0.5rem;
      border: none;
      border-radius: 6px;
      background: #8b5cf6;
      color: white;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      transition: opacity 0.2s;
    `;
    actionBtn.addEventListener('mouseenter', () => {
      if (!actionBtn.disabled) actionBtn.style.opacity = '0.85';
    });
    actionBtn.addEventListener('mouseleave', () => {
      if (!actionBtn.disabled) actionBtn.style.opacity = '1';
    });

    plusCard.appendChild(plusName);
    plusCard.appendChild(plusPrice);
    plusCard.appendChild(plusFeatures);
    plusCard.appendChild(actionBtn);
    billingSection.appendChild(plusCard);

    // Billing history
    const historySection = document.createElement('div');
    const historyTitle = document.createElement('div');
    historyTitle.style.cssText =
      'font-weight: 600; font-size: 0.9375rem; color: var(--text-primary); margin: 0.5rem 0;';
    historyTitle.textContent = t('settings.billing_history') || 'Billing History';
    const historyList = document.createElement('div');
    historyList.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
    historyList.textContent = t('settings.loading') || 'Loading...';
    historySection.appendChild(historyTitle);
    historySection.appendChild(historyList);
    billingSection.appendChild(historySection);

    container.appendChild(billingSection);

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
      historyList.textContent = '';
      if (transactions.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size: 0.8125rem; color: var(--text-muted);';
        empty.textContent = t('settings.no_billing_history') || 'No payments yet';
        historyList.appendChild(empty);
        return;
      }
      const txStatus = (status: unknown): string => {
        const key = `settings.status_${String(status)}`;
        const translated = t(key);
        return translated !== key ? translated : String(status);
      };
      transactions.slice(0, 10).forEach((tx) => {
        const row = document.createElement('div');
        row.style.cssText =
          'display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem; color: var(--text-secondary); border-bottom: 1px solid var(--border); padding-bottom: 0.35rem;';
        const left = document.createElement('div');
        const datePart = formatDate((tx.createdAt as string) || null);
        const namePart = (tx.planName as string) || (tx.type as string) || '';
        left.textContent = [datePart, namePart].filter(Boolean).join(' · ');
        const right = document.createElement('div');
        const amount = Number(tx.amount ?? 0);
        right.textContent = `${amount.toLocaleString()} ${String(tx.currency || 'jpy').toUpperCase()} · ${txStatus(tx.status)}`;
        row.appendChild(left);
        row.appendChild(right);
        historyList.appendChild(row);
      });
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

  return {
    getElement: () => container,
    destroy: () => {
      window.removeEventListener(CROWD_CONSENT_CHANGE_EVENT, onCrowdConsentChange);
      vaultSection.destroy();
      container.remove();
    },
  };
}
