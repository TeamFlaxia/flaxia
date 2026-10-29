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
  heading.className = 'auth-heading';
  heading.textContent = t('login.heading');

  // Form
  const form = document.createElement('form');
  form.className = 'auth-form';

  // Email input
  const emailGroup = document.createElement('div');
  emailGroup.className = 'form-group';

  const emailInput = document.createElement('input');
  emailInput.type = useFlaxiaAuth ? 'text' : 'email';
  emailInput.placeholder = useFlaxiaAuth ? t('login.username_placeholder') : t('login.email_placeholder');
  emailInput.className = 'auth-input';
  emailInput.required = true;

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
  const validateForm = () => {
    const emailValid = useFlaxiaAuth
      ? /^[a-zA-Z0-9_]{1,20}$/.test(emailInput.value.trim())
      : emailInput.value.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value);
    const passwordValid = passwordInput.value.trim() !== '';
    submitButton.disabled = !modeReady || !(emailValid && passwordValid);
  };

  void flaxiaAuthIsAuthoritative()
    .then((authoritative) => {
      useFlaxiaAuth ||= authoritative;
      recoveryAvailable = authoritative;
      recoveryLabel.hidden = !recoveryAvailable;
      modeReady = true;
      emailInput.type = useFlaxiaAuth ? 'text' : 'email';
      emailInput.placeholder = useFlaxiaAuth ? t('login.username_placeholder') : t('login.email_placeholder');
      validateForm();
    })
    .catch(() => {
      errorDiv.textContent = t('login.error_network');
      errorDiv.style.display = 'block';
    });

  emailInput.addEventListener('input', validateForm);
  passwordInput.addEventListener('input', validateForm);

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
      errorDiv.textContent = t('login.error_fill_all');
      errorDiv.style.display = 'block';
      return;
    }

    // Validate email format
    if (useFlaxiaAuth ? !/^[a-zA-Z0-9_]{1,20}$/.test(email) : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorDiv.textContent = t(useFlaxiaAuth ? 'login.error_username_invalid' : 'login.error_email_invalid');
      errorDiv.style.display = 'block';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = t('login.submitting');

    try {
      const result = await (recoveryAvailable && recoveryCheckbox.checked
        ? loginWithFlaxiaAuthRecovery(email, password)
        : useFlaxiaAuth
          ? loginWithFlaxiaAuth(email, password)
          : loginWithSrp(email, password));

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
            : useFlaxiaAuth
              ? 'login.error_username_or_password'
              : 'login.error_invalid',
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
  emailGroup.appendChild(emailInput);
  passwordGroup.appendChild(passwordInput);
  form.appendChild(emailGroup);
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
      // Cleanup if needed
    },
  };
}
