import { resendVerificationEmail } from '../lib/auth-srp.js';
import { t } from '../lib/i18n.js';

export function createVerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get('token');
  // Remove bearer material before any asynchronous work or further navigation.
  window.history.replaceState({}, document.title, '/verify-email');

  const container = document.createElement('div');
  container.className = 'auth-page';
  const card = document.createElement('div');
  card.className = 'auth-card';
  const logo = document.createElement('div');
  logo.className = 'auth-logo';
  logo.textContent = 'Flaxia';
  const heading = document.createElement('h1');
  heading.className = 'auth-heading';
  heading.textContent = t('verify.title');
  const message = document.createElement('p');
  message.className = 'field-hint';
  message.style.display = 'block';
  message.style.textAlign = 'center';
  message.setAttribute('aria-live', 'polite');

  const resendForm = document.createElement('form');
  resendForm.className = 'auth-form';
  resendForm.style.display = 'none';
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.required = true;
  emailInput.maxLength = 254;
  emailInput.className = 'auth-input';
  emailInput.placeholder = t('verify.email_placeholder');
  emailInput.autocomplete = 'email';
  const resendButton = document.createElement('button');
  resendButton.type = 'submit';
  resendButton.className = 'auth-button';
  resendButton.textContent = t('verify.resend');
  const resendMessage = document.createElement('p');
  resendMessage.className = 'field-hint';
  resendMessage.style.display = 'none';
  resendMessage.setAttribute('aria-live', 'polite');
  resendForm.appendChild(emailInput);
  resendForm.appendChild(resendButton);
  resendForm.appendChild(resendMessage);

  resendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    resendButton.disabled = true;
    resendMessage.textContent = '';
    const sent = await resendVerificationEmail(emailInput.value.trim());
    resendMessage.textContent = sent ? t('verify.resend_sent') : t('verify.resend_failed');
    resendMessage.style.display = 'block';
    resendButton.disabled = false;
  });

  const loginLink = document.createElement('div');
  loginLink.className = 'auth-link';
  loginLink.innerHTML = `<a href="/login">${t('verify.login_link')}</a>`;
  loginLink.querySelector('a')?.addEventListener('click', (event) => {
    event.preventDefault();
    window.history.pushState({}, '', '/login');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  card.appendChild(logo);
  card.appendChild(heading);
  card.appendChild(message);
  card.appendChild(resendForm);
  card.appendChild(loginLink);
  container.appendChild(card);

  if (!token) {
    message.textContent = t('verify.invalid');
    message.style.color = 'var(--danger)';
    resendForm.style.display = 'block';
  } else {
    message.textContent = t('verify.working');
    void fetch('/api/auth/email/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('invalid');
        const data = (await response.json()) as { purpose?: string };
        message.textContent =
          data.purpose === 'email_change' ? t('verify.success_email_change') : t('verify.success_registration');
        message.style.color = 'var(--success, #10b981)';
      })
      .catch(() => {
        message.textContent = t('verify.invalid');
        message.style.color = 'var(--danger)';
        resendForm.style.display = 'block';
      });
  }

  return {
    getElement: () => container,
    destroy: () => undefined,
  };
}
