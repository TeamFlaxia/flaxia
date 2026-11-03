import { loginWithSrp } from '../lib/auth-srp.js';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import {
  enrollRecoveryCode,
  flaxiaAuthIsAuthoritative,
  loginWithFlaxiaAuth,
  loginWithFlaxiaAuthRecovery,
} from '../lib/flaxia-auth-login.js';
import { t } from '../lib/i18n.js';

interface LoginProps {
  onSuccess: () => void;
}

export function createLoginPage({ onSuccess }: LoginProps) {
  // An explicit opt-in keeps the existing login available during migration.
  let useFlaxiaAuth =
    window.location.origin === 'https://flaxia.app' && new URLSearchParams(window.location.search).get('auth') === '1';
  let modeReady = false;
  let recoveryAvailable = false;
  // Create main container
  const container = document.createElement('div');
  container.className = 'auth-page';
  container.setAttribute('role', 'main');

  // Create card
  const card = document.createElement('div');
  card.className = 'auth-card';

  // Back button
  const backButton = document.createElement('button');
  backButton.className = 'auth-back';
  backButton.innerHTML = '← ' + t('auth.back');
  backButton.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  // Logo
  const logo = document.createElement('div');
  logo.className = 'auth-logo';
  logo.textContent = t('login.title');

  // Heading
  const heading = document.createElement('h1');
  heading.className = 'auth-heading fx-display';
  heading.textContent = t('login.heading');

  // Form
  const form = document.createElement('form');
  form.className = 'auth-form';

  // Username input — Flaxia accounts sign in by username, never by email.
  const usernameGroup = document.createElement('div');
  usernameGroup.className = 'form-group';

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.placeholder = t('login.username_placeholder');
  usernameInput.className = 'auth-input';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;

  const usernameHint = document.createElement('div');
  usernameHint.className = 'field-hint';
  usernameHint.textContent = t('login.username_hint');

  const usernameError = document.createElement('div');
  usernameError.className = 'field-error';

  // Password input
  const passwordGroup = document.createElement('div');
  passwordGroup.className = 'form-group';

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = t('login.password_placeholder');
  passwordInput.className = 'auth-input';
  passwordInput.required = true;

  const recoveryLabel = document.createElement('label');
  recoveryLabel.className = 'auth-link';
  recoveryLabel.hidden = true;
  const recoveryCheckbox = document.createElement('input');
  recoveryCheckbox.type = 'checkbox';
  recoveryLabel.appendChild(recoveryCheckbox);
  recoveryLabel.appendChild(document.createTextNode(` ${t('login.use_recovery_code')}`));
  recoveryCheckbox.addEventListener('change', () => {
    passwordInput.placeholder = recoveryCheckbox.checked
      ? t('login.recovery_code_placeholder')
      : t('login.password_placeholder');
  });

  // Error message
  const errorDiv = document.createElement('div');
  errorDiv.className = 'auth-error';
  errorDiv.style.display = 'none';

  // Submit button
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'auth-button';
  submitButton.textContent = t('login.submit');
  submitButton.classList.add('fx-display');
  submitButton.disabled = true;

  // Register link
  const registerLink = document.createElement('div');
  registerLink.className = 'auth-link';
  registerLink.innerHTML = t('login.register_link');

  // Legal notice
  const legalNotice = document.createElement('div');
  legalNotice.className = 'legal-notice';
  legalNotice.innerHTML = t('login.agree_terms');

  // Validation
  const identifierValue = () => usernameInput.value.trim();
  const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const validateForm = () => {
    const identifier = identifierValue();
    if (looksLikeEmail(identifier)) {
      usernameError.textContent = t('login.error_email_not_username');
      usernameError.style.display = 'block';
    } else {
      usernameError.style.display = 'none';
    }
    const usernameValid = /^[a-zA-Z0-9_]{1,20}$/.test(identifier);
    const passwordValid = passwordInput.value.trim() !== '';
    submitButton.disabled = !modeReady || !(usernameValid && passwordValid);
  };

  let modeInFlight = false;
  let destroyed = false;
  let modeRetry: ReturnType<typeof setTimeout> | undefined;
  let modeRetryDelay = 1000;
  const clearModeRetry = () => {
    if (modeRetry !== undefined) {
      clearTimeout(modeRetry);
      modeRetry = undefined;
    }
  };
  const loadAuthMode = () => {
    if (destroyed || modeReady || modeInFlight) return;
    modeInFlight = true;
    void flaxiaAuthIsAuthoritative()
      .then((authoritative) => {
        if (destroyed) return;
        useFlaxiaAuth ||= authoritative;
        // Auth-backed logins can enroll a recovery code before the authority
        // cutover, so the opt-in flow exposes recovery too.
        recoveryAvailable = useFlaxiaAuth;
        recoveryLabel.hidden = !recoveryAvailable;
        modeReady = true;
        clearModeRetry();
        errorDiv.style.display = 'none';
        validateForm();
      })
      .catch(() => {
        if (destroyed) return;
        // A connectivity false positive must not disable sign-in forever.
        errorDiv.textContent = t('login.error_network');
        errorDiv.style.display = 'block';
        if (modeRetry === undefined) {
          modeRetry = setTimeout(() => {
            modeRetry = undefined;
            modeRetryDelay = Math.min(modeRetryDelay * 2, 15000);
            loadAuthMode();
          }, modeRetryDelay);
        }
      })
      .finally(() => {
        modeInFlight = false;
      });
  };
  const retryAuthModeNow = () => {
    if (modeReady) return;
    clearModeRetry();
    modeRetryDelay = 1000;
    loadAuthMode();
  };
  window.addEventListener('online', retryAuthModeNow);
  window.addEventListener('flaxiaConnectivityChange', retryAuthModeNow);
  loadAuthMode();

  usernameInput.addEventListener('input', validateForm);
  passwordInput.addEventListener('input', validateForm);

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = identifierValue();
    const password = passwordInput.value.trim();

    if (!username || !password) {
      errorDiv.textContent = t('login.error_fill_all');
      errorDiv.style.display = 'block';
      return;
    }

    if (looksLikeEmail(username)) {
      usernameError.textContent = t('login.error_email_not_username');
      usernameError.style.display = 'block';
      return;
    }

    if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) {
      errorDiv.textContent = t('login.error_username_invalid');
      errorDiv.style.display = 'block';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = t('login.submitting');

    try {
      const result = await (recoveryAvailable && recoveryCheckbox.checked
        ? loginWithFlaxiaAuthRecovery(username, password)
        : useFlaxiaAuth
          ? loginWithFlaxiaAuth(username, password)
          : loginWithSrp(username, password));

      if (result === true) {
        if (recoveryAvailable && !recoveryCheckbox.checked) {
          try {
            const status = await fetch('/api/auth/recovery/status', { credentials: 'include', cache: 'no-store' });
            const data = (await status.json()) as { enrolled?: boolean };
            if (status.ok && data.enrolled === false) {
              const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
                .replaceAll('+', '-')
                .replaceAll('/', '_')
                .replaceAll('=', '');
              if (await createConfirmDialog(`${t('settings.recovery_save_code')}\n\n${code}`)) {
                if (!(await enrollRecoveryCode(password, code))) window.alert(t('settings.recovery_failed'));
              }
            }
          } catch {
            window.alert(t('settings.recovery_failed'));
          }
        }
        onSuccess();
      } else if (result && result.frozen) {
        window.history.pushState({}, '', `/users/${encodeURIComponent(result.username)}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } else {
        errorDiv.textContent = t(
          recoveryAvailable && recoveryCheckbox.checked
            ? 'login.error_recovery_invalid'
            : 'login.error_username_or_password',
        );
        errorDiv.style.display = 'block';
      }
    } catch (error) {
      console.error('Login error:', error);
      errorDiv.textContent = t('login.error_network');
      errorDiv.style.display = 'block';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = t('login.submit');
    }
  });

  // Assemble form
  usernameGroup.appendChild(usernameInput);
  usernameGroup.appendChild(usernameHint);
  usernameGroup.appendChild(usernameError);
  passwordGroup.appendChild(passwordInput);
  form.appendChild(usernameGroup);
  form.appendChild(passwordGroup);
  form.appendChild(recoveryLabel);
  form.appendChild(errorDiv);
  form.appendChild(submitButton);

  // Assemble card
  card.appendChild(backButton);
  card.appendChild(logo);
  card.appendChild(heading);
  card.appendChild(form);
  card.appendChild(legalNotice);
  card.appendChild(registerLink);

  // Assemble container
  container.appendChild(card);

  // Handle register link click
  const registerAnchor = registerLink.querySelector('a');
  if (registerAnchor) {
    registerAnchor.addEventListener('click', (e) => {
      e.preventDefault();
      window.history.pushState({}, '', '/register');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  }

  return {
    getElement: () => container,
    destroy: () => {
      destroyed = true;
      clearModeRetry();
      window.removeEventListener('online', retryAuthModeNow);
      window.removeEventListener('flaxiaConnectivityChange', retryAuthModeNow);
    },
  };
}
