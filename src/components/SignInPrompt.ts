// Legacy-compatible bridge: the prompt UI is owned by SignInPrompt.svelte;
// this module only keeps modal registration and mount/unmount lifecycle.
import { mount, unmount } from 'svelte';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import SignInPrompt from '../lib/svelte/SignInPrompt.svelte';

export interface SignInPromptProps {
  subtitle?: string;
  onSignIn?: () => void;
  onSignUp?: () => void;
  onClose?: () => void;
}

export function createSignInPrompt(props: SignInPromptProps = {}) {
  const unregister = registerModal();
  const subtitle = props.subtitle || t('auth.sign_up_subtitle');
  const target = document.createElement('div');
  document.body.appendChild(target);

  let instance: Parameters<typeof unmount>[0] | null = null;

  const destroy = (): void => {
    if (instance) unmount(instance);
    instance = null;
    unregister();
    target.remove();
  };

  instance = mount(SignInPrompt, {
    target,
    props: {
      subtitle,
      onSignIn: () => {
        destroy();
        props.onSignIn?.();
      },
      onSignUp: () => {
        destroy();
        props.onSignUp?.();
      },
      onClose: () => {
        destroy();
        props.onClose?.();
      },
    },
  });

  return { element: target, destroy };
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
