import { t } from '../lib/i18n.js';

interface RegisterProps {
  onSuccess: () => void;
}

export function createRegisterPage({ onSuccess }: RegisterProps) {
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
  logo.textContent = t('register.title');

  // Heading
  const heading = document.createElement('h1');
  heading.className = 'auth-heading';
  heading.textContent = t('register.heading');

  // Form
  const form = document.createElement('form');
  form.className = 'auth-form';

  // Email input
  const emailGroup = document.createElement('div');
  emailGroup.className = 'form-group';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = t('register.email_placeholder');
  emailInput.className = 'auth-input';
  emailInput.required = true;

  const emailError = document.createElement('div');
  emailError.className = 'field-error';

  // Username input
  const usernameGroup = document.createElement('div');
  usernameGroup.className = 'form-group';

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.placeholder = t('register.username_placeholder');
  usernameInput.className = 'auth-input';
  usernameInput.required = true;

  const usernameHint = document.createElement('div');
  usernameHint.className = 'field-hint';
  usernameHint.textContent = t('register.username_hint');

  const usernameError = document.createElement('div');
  usernameError.className = 'field-error';

  // Display name input
  const displayNameGroup = document.createElement('div');
  displayNameGroup.className = 'form-group';

  const displayNameInput = document.createElement('input');
  displayNameInput.type = 'text';
  displayNameInput.placeholder = t('register.display_name_placeholder');
  displayNameInput.className = 'auth-input';
  displayNameInput.required = true;

  const displayNameError = document.createElement('div');
  displayNameError.className = 'field-error';

  // Password input
  const passwordGroup = document.createElement('div');
  passwordGroup.className = 'form-group';

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = t('register.password_placeholder');
  passwordInput.className = 'auth-input';
  passwordInput.required = true;

  const passwordError = document.createElement('div');
  passwordError.className = 'field-error';

  // Confirm password input
  const confirmPasswordGroup = document.createElement('div');
  confirmPasswordGroup.className = 'form-group';

  const confirmPasswordInput = document.createElement('input');
  confirmPasswordInput.type = 'password';
  confirmPasswordInput.placeholder = t('register.confirm_password_placeholder');
  confirmPasswordInput.className = 'auth-input';
  confirmPasswordInput.required = true;

  const confirmPasswordError = document.createElement('div');
  confirmPasswordError.className = 'field-error';

  // Consent checkbox
  const consentGroup = document.createElement('div');
  consentGroup.className = 'form-group consent-group';

  const consentLabel = document.createElement('label');
  consentLabel.className = 'consent-label';

  const consentCheckbox = document.createElement('input');
  consentCheckbox.type = 'checkbox';
  consentCheckbox.className = 'consent-checkbox';
  consentCheckbox.required = true;

  const consentText = document.createElement('span');
  consentText.className = 'consent-text';
  consentText.innerHTML = t('register.agree_terms');

  consentLabel.appendChild(consentCheckbox);
  consentLabel.appendChild(consentText);
  consentGroup.appendChild(consentLabel);

  // Submit button
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'auth-button';
  submitButton.textContent = t('register.submit');
  submitButton.disabled = true;

  // Login link
  const loginLink = document.createElement('div');
  loginLink.className = 'auth-link';
  loginLink.innerHTML = t('register.login_link');

  // Validation
  const validateForm = () => {
    // Clear all errors
    emailError.style.display = 'none';
    usernameError.style.display = 'none';
    displayNameError.style.display = 'none';
    passwordError.style.display = 'none';
    confirmPasswordError.style.display = 'none';

    const email = emailInput.value.trim();
    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const password = passwordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

    let isValid = true;

    // Email validation
    if (!email) {
      emailError.textContent = t('register.error_email_required');
      emailError.style.display = 'block';
      isValid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailError.textContent = t('register.error_email_invalid');
      emailError.style.display = 'block';
      isValid = false;
    }

    // Username validation
    if (!username) {
      usernameError.textContent = t('register.error_username_required');
      usernameError.style.display = 'block';
      isValid = false;
    } else if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) {
      usernameError.textContent = t('register.error_username_invalid');
      usernameError.style.display = 'block';
      isValid = false;
    }

    // Display name validation
    if (!displayName) {
      displayNameError.textContent = t('register.error_display_name_required');
      displayNameError.style.display = 'block';
      isValid = false;
    } else if (displayName.length > 50) {
      displayNameError.textContent = t('register.error_display_name_length');
      displayNameError.style.display = 'block';
      isValid = false;
    }

    // Password validation
    if (!password) {
      passwordError.textContent = t('register.error_password_required');
      passwordError.style.display = 'block';
      isValid = false;
    } else if (password.length < 8 || password.length > 128) {
      passwordError.textContent = t('register.error_password_length');
      passwordError.style.display = 'block';
      isValid = false;
    }

    // Confirm password validation
    if (!confirmPassword) {
      confirmPasswordError.textContent = t('register.error_confirm_password');
      confirmPasswordError.style.display = 'block';
      isValid = false;
    } else if (password !== confirmPassword) {
      confirmPasswordError.textContent = t('register.error_password_mismatch');
      confirmPasswordError.style.display = 'block';
      isValid = false;
    }

    // Consent checkbox validation
    if (!consentCheckbox.checked) {
      isValid = false;
    }

    submitButton.disabled = !isValid;
  };

  emailInput.addEventListener('input', validateForm);
  usernameInput.addEventListener('input', validateForm);
  displayNameInput.addEventListener('input', validateForm);
  passwordInput.addEventListener('input', validateForm);
  confirmPasswordInput.addEventListener('input', validateForm);
  consentCheckbox.addEventListener('change', validateForm);

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const password = passwordInput.value.trim();

    submitButton.disabled = true;
    submitButton.textContent = t('register.submitting');

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          username,
          display_name: displayName,
        }),
      });

      const data = (await response.json()) as { error?: string; user?: any };

      if (response.ok) {
        onSuccess();
      } else {
        // Show specific field errors based on the error message
        if (data.error?.includes('Email')) {
          emailError.textContent = data.error;
          emailError.style.display = 'block';
        } else if (data.error?.includes('Username')) {
          usernameError.textContent = data.error;
          usernameError.style.display = 'block';
        } else {
          // General error - show on first field
          emailError.textContent = data.error || t('register.error_general');
          emailError.style.display = 'block';
        }
      }
    } catch (error) {
      console.error('Registration error:', error);
      emailError.textContent = t('register.error_network');
      emailError.style.display = 'block';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = t('register.submit');
    }
  });

  // Assemble form
  emailGroup.appendChild(emailInput);
  emailGroup.appendChild(emailError);

  usernameGroup.appendChild(usernameInput);
  usernameGroup.appendChild(usernameHint);
  usernameGroup.appendChild(usernameError);

  displayNameGroup.appendChild(displayNameInput);
  displayNameGroup.appendChild(displayNameError);

  passwordGroup.appendChild(passwordInput);
  passwordGroup.appendChild(passwordError);

  confirmPasswordGroup.appendChild(confirmPasswordInput);
  confirmPasswordGroup.appendChild(confirmPasswordError);

  form.appendChild(emailGroup);
  form.appendChild(usernameGroup);
  form.appendChild(displayNameGroup);
  form.appendChild(passwordGroup);
  form.appendChild(confirmPasswordGroup);
  form.appendChild(consentGroup);
  form.appendChild(submitButton);

  // Assemble card
  card.appendChild(backButton);
  card.appendChild(logo);
  card.appendChild(heading);
  card.appendChild(form);
  card.appendChild(loginLink);

  // Assemble container
  container.appendChild(card);

  // Handle login link click
  const loginAnchor = loginLink.querySelector('a');
  if (loginAnchor) {
    loginAnchor.addEventListener('click', (e) => {
      e.preventDefault();
      window.history.pushState({}, '', '/login');
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
