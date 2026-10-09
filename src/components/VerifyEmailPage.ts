import { clearMeCache } from '../lib/auth-cache.js';
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
  card.appendChild(loginLink);
  container.appendChild(card);

  if (!token) {
    message.textContent = t('verify.invalid');
    message.style.color = 'var(--danger)';
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
        if (data.purpose === 'email_change') {
          // The active address changed on the server; refresh it before Settings renders again.
          clearMeCache();
        }
        message.textContent =
          data.purpose === 'email_change' ? t('verify.success_email_change') : t('verify.success_registration');
        message.style.color = 'var(--success, #10b981)';
      })
      .catch(() => {
        message.textContent = t('verify.invalid');
        message.style.color = 'var(--danger)';
      });
  }

  return {
    getElement: () => container,
    destroy: () => undefined,
  };
}
