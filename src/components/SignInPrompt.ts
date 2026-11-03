import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

export interface SignInPromptProps {
  subtitle?: string;
  onSignIn?: () => void;
  onSignUp?: () => void;
  onClose?: () => void;
}

export function createSignInPrompt(props: SignInPromptProps = {}) {
  const unregister = registerModal();
  const subtitle = props.subtitle || t('auth.sign_up_subtitle');

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'signin-prompt-overlay';

  // Create dialog
  const dialog = document.createElement('div');
  dialog.className = 'signin-prompt-dialog';

  dialog.innerHTML = `
    <div class="signin-prompt-badge" aria-hidden="true"><img src="/favicon.ico" alt="" width="40" height="40"></div>
    <h3 class="signin-prompt-title fx-display">${t('auth.sign_up_title')}</h3>
    <p class="signin-prompt-subtitle">${subtitle}</p>
    <div class="signin-prompt-actions">
      <button class="signin-btn signin-prompt-primary" type="button">${t('auth.sign_up')}</button>
      <button class="signup-btn signin-prompt-secondary" type="button">${t('auth.sign_in')}</button>
    </div>
  `;

  const signInBtn = dialog.querySelector('.signin-btn') as HTMLButtonElement;
  const signUpBtn = dialog.querySelector('.signup-btn') as HTMLButtonElement;

  signInBtn.addEventListener('click', () => {
    destroy();
    props.onSignUp?.();
  });

  signUpBtn.addEventListener('click', () => {
    destroy();
    props.onSignIn?.();
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      unregister();
      destroy();
      props.onClose?.();
    }
  });

  function destroy() {
    unregister();
    if (overlay.parentNode) {
      overlay.remove();
    }
  }

  return {
    element: overlay,
    destroy,
  };
}

export type SignInPromptAction =
  | 'fresh'
  | 'reload'
  | 'reply'
  | 'follow'
  | 'report'
  | 'post'
  | 'bookmark'
  | 'block'
  | 'upload'
  | 'reaction';

const signInPromptSubtitles: Record<SignInPromptAction, string> = {
  fresh: 'auth.sign_in_to_fresh',
  reload: 'auth.sign_in_to_reload',
  reply: 'auth.sign_in_to_reply',
  follow: 'auth.sign_in_to_follow',
  report: 'auth.sign_in_to_report',
  post: 'auth.sign_in_to_post',
  bookmark: 'auth.sign_in_to_bookmark',
  block: 'auth.sign_in_to_block',
  upload: 'auth.sign_in_to_upload',
  reaction: 'auth.sign_in_to_reaction',
};

// Convenience function to show sign-in prompt with preset subtitle
export function showSignInPrompt(
  action: SignInPromptAction,
  onSignIn: () => void,
  onSignUp: () => void,
  onClose?: () => void,
) {
  return createSignInPrompt({
    subtitle: t(signInPromptSubtitles[action]),
    onSignIn,
    onSignUp,
    onClose,
  });
}
