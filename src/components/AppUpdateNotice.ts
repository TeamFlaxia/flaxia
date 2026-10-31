import { type AppUpdateInfo, detectAppUpdatePlatform } from '../lib/app-update.js';
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';

const NOTICE_ID = 'app-update-notice';

function removeNotice(onDismiss: () => void): void {
  onDismiss();
  document.getElementById(NOTICE_ID)?.remove();
}

/** Dismissible card recommending an app update; desktop Windows/Linux only. */
export function showAppUpdateNotice(update: AppUpdateInfo, onDismiss: () => void): void {
  if (document.getElementById(NOTICE_ID)) return;

  const notice = document.createElement('aside');
  notice.id = NOTICE_ID;
  notice.className = 'app-update-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'app-update-notice-icon';
  iconWrap.appendChild(icon('reload', { width: '20', height: '20' }));

  const body = document.createElement('div');
  body.className = 'app-update-notice-body';

  const title = document.createElement('strong');
  title.className = 'app-update-notice-title';
  title.textContent = t('app_update.title');

  const message = document.createElement('span');
  message.className = 'app-update-notice-message';
  message.textContent = t('app_update.message', {
    version: update.latestVersion,
    current: update.currentVersion,
  });

  body.appendChild(title);
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'app-update-notice-actions';

  const action = document.createElement('a');
  action.className = 'app-update-notice-action';
  action.href =
    detectAppUpdatePlatform() === 'windows' && update.windowsMsiUrl ? update.windowsMsiUrl : update.releaseUrl;
  action.target = '_blank';
  action.rel = 'noopener noreferrer';
  action.textContent = t('app_update.action');

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'app-update-notice-dismiss';
  dismiss.textContent = t('app_update.dismiss');
  dismiss.addEventListener('click', () => removeNotice(onDismiss));

  actions.appendChild(action);
  actions.appendChild(dismiss);

  notice.appendChild(iconWrap);
  notice.appendChild(body);
  notice.appendChild(actions);
  document.body.appendChild(notice);
}
