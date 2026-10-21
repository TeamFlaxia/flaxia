import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

export interface VersionHistoryModalProps {
  postId: string;
  sandboxOrigin: string;
  currentVersionId: string | null;
  onPlay: (versionId: string | null) => void;
}

interface GameVersion {
  id: string;
  versionNumber: number;
  changelog: string | null;
  thumbnailKey: string | null;
  createdAt: string;
}

export function openVersionHistoryModal(props: VersionHistoryModalProps): void {
  const unregister = registerModal();
  const overlay = document.createElement('div');
  overlay.className = 'version-history-modal-overlay';
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
    z-index: 1000;
    padding: 1rem;
  `;

  const modal = document.createElement('div');
  modal.className = 'version-history-modal';
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.75rem;
    max-width: 480px;
    width: 100%;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    padding: 1.25rem;
  `;

  const title = document.createElement('h2');
  title.textContent = t('game.version_history_title');
  title.style.cssText = `
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    color: var(--text-primary);
  `;
  modal.appendChild(title);

  const list = document.createElement('div');
  list.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';
  modal.appendChild(list);

  const loading = document.createElement('div');
  loading.textContent = t('common.loading');
  loading.style.cssText = 'color: var(--text-muted); font-size: 0.875rem;';
  list.appendChild(loading);

  const close = () => {
    unregister();
    overlay.remove();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const renderVersions = (versions: GameVersion[]) => {
    list.innerHTML = '';

    const latestBtn = document.createElement('button');
    latestBtn.textContent = t('game.play_latest');
    latestBtn.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid ${props.currentVersionId === null ? 'var(--accent, #22c55e)' : 'var(--border)'};
      border-radius: 0.5rem;
      background: var(--bg-input);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.875rem;
      text-align: left;
    `;
    latestBtn.addEventListener('click', () => {
      props.onPlay(null);
      close();
    });
    list.appendChild(latestBtn);

    if (versions.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('game.no_versions');
      empty.style.cssText = 'color: var(--text-muted); font-size: 0.875rem;';
      list.appendChild(empty);
      return;
    }

    for (const v of versions) {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 0.75rem 1rem;
        border: 1px solid ${props.currentVersionId === v.id ? 'var(--accent, #22c55e)' : 'var(--border)'};
        border-radius: 0.5rem;
        background: var(--bg-input);
      `;

      const header = document.createElement('div');
      header.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';
      const versionLabel = document.createElement('span');
      versionLabel.textContent = `${t('game.version')} ${v.versionNumber}`;
      versionLabel.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.875rem;';
      const date = document.createElement('span');
      date.textContent = new Date(v.createdAt).toLocaleString();
      date.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
      header.appendChild(versionLabel);
      header.appendChild(date);
      item.appendChild(header);

      if (v.changelog) {
        const log = document.createElement('p');
        log.textContent = v.changelog;
        log.style.cssText =
          'margin: 0.5rem 0 0 0; font-size: 0.8125rem; color: var(--text-primary); white-space: pre-wrap;';
        item.appendChild(log);
      }

      const playBtn = document.createElement('button');
      playBtn.textContent = t('game.play_version');
      playBtn.style.cssText = `
        margin-top: 0.75rem;
        padding: 0.4rem 0.9rem;
        border: none;
        border-radius: 0.5rem;
        background: var(--accent, #22c55e);
        color: #fff;
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 600;
      `;
      playBtn.addEventListener('click', () => {
        props.onPlay(v.id);
        close();
      });
      item.appendChild(playBtn);

      list.appendChild(item);
    }
  };

  fetch(`/api/posts/${props.postId}/versions`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('fetch failed'))))
    .then((data: unknown) => renderVersions((data as { versions: GameVersion[] }).versions || []))
    .catch(() => {
      list.innerHTML = '';
      const err = document.createElement('div');
      err.textContent = t('game.version_history_error');
      err.style.cssText = 'color: var(--danger, #e74c3c); font-size: 0.875rem;';
      list.appendChild(err);
    });

  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top: 1rem; text-align: right;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = t('common.close');
  closeBtn.style.cssText = `
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.875rem;
  `;
  closeBtn.addEventListener('click', close);
  footer.appendChild(closeBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
