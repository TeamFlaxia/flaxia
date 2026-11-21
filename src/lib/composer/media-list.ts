// Composer multi-media list (kept out of Svelte: it builds legacy preview DOM).

import { type AttachPreviewHandle, renderFilePreview } from '../file-preview.ts';
import { attachIcons } from '../icons.ts';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mountMediaList(
  host: HTMLElement,
  options: {
    files: File[];
    removeLabel: string;
    onRemove: (index: number) => void;
  },
): AttachPreviewHandle[] {
  const handles: AttachPreviewHandle[] = [];
  host.replaceChildren();
  options.files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'composer-media-item';

    const body = document.createElement('div');
    body.className = 'composer-media-item-body';
    handles.push(renderFilePreview(file, body));
    item.appendChild(body);

    const name = document.createElement('div');
    name.className = 'media-item-name';
    name.textContent = `${file.name} (${formatFileSize(file.size)})`;
    item.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'media-item-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'media-item-remove';
    remove.title = options.removeLabel;
    remove.innerHTML = '<span class="action-icon" data-icon="close"></span>';
    remove.addEventListener('click', () => options.onRemove(index));
    actions.appendChild(remove);
    item.appendChild(actions);

    attachIcons(item);
    host.appendChild(item);
  });
  return handles;
}
