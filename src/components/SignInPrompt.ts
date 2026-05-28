import { t } from '../lib/i18n.js'
import { registerModal } from '../lib/modal-state.js'

export interface SignInPromptProps {
  subtitle?: string
  onSignIn?: () => void
  onSignUp?: () => void
  onClose?: () => void
}

export function createSignInPrompt(props: SignInPromptProps = {}) {
  const unregister = registerModal()
  const subtitle = props.subtitle || t('auth.sign_up_subtitle')

  // Create overlay
  const overlay = document.createElement('div')
  overlay.className = 'signin-prompt-overlay'
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
  `

  // Create dialog
  const dialog = document.createElement('div')
  dialog.className = 'signin-prompt-dialog'
  dialog.style.cssText = `
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2rem;
    max-width: 400px;
    width: 90%;
    text-align: center;
  `

  dialog.innerHTML = `
    <h3 style="margin: 0 0 0.5rem 0; color: var(--text-primary); font-size: 1.25rem; font-weight: 600;">${t('auth.sign_up_title')}</h3>
    <p style="margin: 0 0 1.5rem 0; color: var(--text-muted); font-size: 0.875rem; line-height: 1.5;">${subtitle}</p>
    <div style="display: flex; gap: 1rem; justify-content: center;">
      <button class="signin-btn" style="
        padding: 0.75rem 1.5rem;
        background: var(--text-primary);
        color: var(--bg-primary);
        border: none;
        border-radius: 9999px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        transition: opacity 0.2s;
      ">${t('auth.sign_up')}</button>
      <button class="signup-btn" style="
        padding: 0.75rem 1.5rem;
        background: transparent;
        color: var(--accent);
        border: 1px solid var(--accent);
        border-radius: 9999px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        transition: all 0.2s;
      ">${t('auth.sign_in')}</button>
    </div>
  `

  const signInBtn = dialog.querySelector('.signin-btn') as HTMLButtonElement
  const signUpBtn = dialog.querySelector('.signup-btn') as HTMLButtonElement

  // Hover effects for primary sign up button (was sign in button)
  signInBtn.addEventListener('mouseenter', () => {
    signInBtn.style.opacity = '0.8'
  })
  signInBtn.addEventListener('mouseleave', () => {
    signInBtn.style.opacity = '1'
  })
  signInBtn.addEventListener('click', () => {
    destroy()
    props.onSignUp?.()
  })

  // Hover effects for secondary sign in button (was sign up button)
  signUpBtn.addEventListener('mouseenter', () => {
    signUpBtn.style.background = 'var(--accent)'
    signUpBtn.style.color = '#000'
  })
  signUpBtn.addEventListener('mouseleave', () => {
    signUpBtn.style.background = 'transparent'
    signUpBtn.style.color = 'var(--accent)'
  })
  signUpBtn.addEventListener('click', () => {
    destroy()
    props.onSignIn?.()
  })

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      unregister()
      destroy()
      props.onClose?.()
    }
  })

  function destroy() {
    unregister()
    if (overlay.parentNode) {
      overlay.remove()
    }
  }

  return {
    element: overlay,
    destroy
  }
}

export type SignInPromptAction = 'fresh' | 'reply' | 'follow' | 'report' | 'post' | 'bookmark'

const signInPromptSubtitles: Record<SignInPromptAction, string> = {
  fresh: 'auth.sign_in_to_fresh',
  reply: 'auth.sign_in_to_reply',
  follow: 'auth.sign_in_to_follow',
  report: 'auth.sign_in_to_report',
  post: 'auth.sign_in_to_post',
  bookmark: 'auth.sign_in_to_bookmark'
}

// Convenience function to show sign-in prompt with preset subtitle
export function showSignInPrompt(
  action: SignInPromptAction,
  onSignIn: () => void,
  onSignUp: () => void,
  onClose?: () => void
) {
  return createSignInPrompt({
    subtitle: t(signInPromptSubtitles[action]),
    onSignIn,
    onSignUp,
    onClose
  })
}
