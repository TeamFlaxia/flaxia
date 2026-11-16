// Global app header: brand on the left, account actions on the right.
//
// It replaces the brand row and the guest auth buttons that used to live in
// the left rail, so the rail is navigation only. The header is a fixed bar;
// `body.has-app-header` moves the sticky rails and page headers below it.
import { t } from '../lib/i18n.js';

export interface AppHeaderProps {
  currentUser: { username: string } | null;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
}

const HEADER_ID = 'app-header';

/** Render (or re-render) the singleton header. Idempotent. */
export function renderAppHeader(props: AppHeaderProps): void {
  const existing = document.getElementById(HEADER_ID);
  const header = (existing as HTMLElement | null) ?? document.createElement('header');
  header.id = HEADER_ID;
  header.className = 'app-header';
  header.replaceChildren();

  const inner = document.createElement('div');
  inner.className = 'app-header-inner';

  const brand = document.createElement('button');
  brand.type = 'button';
  brand.className = 'app-header-brand';
  brand.setAttribute('aria-label', t('nav.logo'));

  const mark = document.createElement('img');
  mark.className = 'app-header-mark';
  mark.src = '/favicon.ico';
  mark.alt = '';

  const name = document.createElement('span');
  name.className = 'app-header-name';
  name.textContent = t('nav.logo');

  brand.appendChild(mark);
  brand.appendChild(name);
  brand.addEventListener('click', () => props.onNavigate?.('home'));
  inner.appendChild(brand);

  const actions = document.createElement('div');
  actions.className = 'app-header-actions';

  if (!props.currentUser) {
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'app-header-button app-header-button--ghost';
    signIn.textContent = t('nav.login');
    signIn.addEventListener('click', () => props.onSignIn?.());

    const signUp = document.createElement('button');
    signUp.type = 'button';
    signUp.className = 'app-header-button app-header-button--primary';
    signUp.textContent = t('nav.register');
    signUp.addEventListener('click', () => props.onSignUp?.());

    actions.appendChild(signIn);
    actions.appendChild(signUp);
  }

  inner.appendChild(actions);
  header.appendChild(inner);

  if (!existing) document.body.insertBefore(header, document.body.firstChild);
  document.body.classList.add('has-app-header');
}

/** Remove the header on views that own the whole viewport (auth, legal, admin). */
export function hideAppHeader(): void {
  document.getElementById(HEADER_ID)?.remove();
  document.body.classList.remove('has-app-header');
}
