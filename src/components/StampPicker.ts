import { t } from '../lib/i18n.js';

export interface StampItem {
  id: string;
  name: string;
  url: string;
  user_id: string;
}

interface StampPickerProps {
  onSelect: (emoji: string, stampId?: string) => void;
  currentUser?: { id: string } | null;
}

let activeStampPicker: HTMLElement | null = null;
let activeStampCleanup: (() => void) | null = null;
let stampPickerToken = 0;

export function closeStampPicker(): void {
  stampPickerToken++;
  if (activeStampPicker) {
    activeStampPicker.remove();
    activeStampPicker = null;
  }
  if (activeStampCleanup) {
    activeStampCleanup();
    activeStampCleanup = null;
  }
}

export function openStampPicker(anchor: HTMLElement, props: StampPickerProps): void {
  closeStampPicker();
  const token = stampPickerToken;

  const container = document.createElement('div');
  container.className = 'stamp-picker';
  container.style.cssText = `
    position: fixed;
    z-index: 1000;
    width: 340px;
    max-height: 400px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;

  const rect = anchor.getBoundingClientRect();
  const fitsBelow = rect.bottom + 400 + 8 <= window.innerHeight;
  container.style.top = `${fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - 400)}px`;
  container.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340 - 8))}px`;

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'stamp-picker-tabs';
  tabBar.style.cssText = `
    display: flex;
    border-bottom: 1px solid var(--border);
  `;

  const emojiTab = document.createElement('button');
  emojiTab.className = 'stamp-picker-tab stamp-picker-tab--active';
  emojiTab.textContent = 'Unicode';
  emojiTab.style.cssText = `
    flex: 1;
    padding: 8px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-primary);
    border-bottom: 2px solid var(--accent);
  `;

  const customTab = document.createElement('button');
  customTab.className = 'stamp-picker-tab';
  customTab.textContent = t('settings.custom_emoji') || 'Custom';
  customTab.style.cssText = `
    flex: 1;
    padding: 8px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
  `;

  tabBar.appendChild(emojiTab);
  tabBar.appendChild(customTab);
  container.appendChild(tabBar);

  // Content area
  const contentArea = document.createElement('div');
  contentArea.className = 'stamp-picker-content';
  contentArea.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    min-height: 200px;
  `;
  container.appendChild(contentArea);

  document.body.appendChild(container);
  activeStampPicker = container;

  // Unicode emoji picker
  let unicodePickerLoaded = false;
  const emojiContent = document.createElement('div');

  // Custom stamps picker
  const customContent = document.createElement('div');
  customContent.style.display = 'none';

  contentArea.appendChild(emojiContent);
  contentArea.appendChild(customContent);

  function showUnicode() {
    emojiTab.style.borderBottomColor = 'var(--accent)';
    emojiTab.style.color = 'var(--text-primary)';
    customTab.style.borderBottomColor = 'transparent';
    customTab.style.color = 'var(--text-muted)';
    emojiContent.style.display = '';
    customContent.style.display = 'none';

    if (!unicodePickerLoaded) {
      unicodePickerLoaded = true;
      void import('emoji-picker-element').then((mod) => {
        if (token !== stampPickerToken) return;
        const { Picker } = mod;
        if (!Picker) return;
        const picker = new Picker({
          dataSource: '/emoji-data.json',
          locale: document.documentElement.lang || undefined,
        });
        picker.style.width = '100%';
        picker.style.maxHeight = '340px';
        const onEmojiClick = (e: Event) => {
          const detail = (e as CustomEvent).detail as { emoji?: { unicode?: string } };
          const unicode = detail?.emoji?.unicode;
          if (unicode) props.onSelect(unicode);
          closeStampPicker();
        };
        picker.addEventListener('emoji-click', onEmojiClick);
        emojiContent.appendChild(picker);
        activeStampCleanup = () => {
          picker.removeEventListener('emoji-click', onEmojiClick);
        };
      });
    }
  }

  function showCustom() {
    customTab.style.borderBottomColor = 'var(--accent)';
    customTab.style.color = 'var(--text-primary)';
    emojiTab.style.borderBottomColor = 'transparent';
    emojiTab.style.color = 'var(--text-muted)';
    customContent.style.display = '';
    emojiContent.style.display = 'none';

    // Fetch user's custom stamps
    customContent.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);">Loading...</div>';
    fetch('/api/stamps', { credentials: 'include' })
      .then((r) => r.json() as Promise<{ stamps: StampItem[] }>)
      .then((data) => {
        if (token !== stampPickerToken) return;
        customContent.innerHTML = '';

        if (data.stamps.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'text-align:center;padding:16px;color:var(--text-muted);';
          empty.textContent = t('settings.custom_emoji_empty') || 'No custom emoji yet. Create some in Settings!';
          customContent.appendChild(empty);
          return;
        }

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;';
        for (const stamp of data.stamps) {
          const btn = document.createElement('button');
          btn.style.cssText = `
            padding: 4px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--bg-secondary);
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
          `;
          btn.title = stamp.name;
          const img = document.createElement('img');
          img.src = stamp.url;
          img.alt = stamp.name;
          img.style.cssText = 'width:32px;height:32px;object-fit:contain;';
          const label = document.createElement('span');
          label.style.cssText =
            'font-size:0.625rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:64px;';
          label.textContent = stamp.name;
          btn.appendChild(img);
          btn.appendChild(label);
          btn.addEventListener('click', () => {
            props.onSelect(stamp.name, stamp.id);
            closeStampPicker();
          });
          grid.appendChild(btn);
        }
        customContent.appendChild(grid);
      })
      .catch(() => {
        customContent.innerHTML =
          '<div style="text-align:center;padding:16px;color:var(--text-muted);">Failed to load</div>';
      });
  }

  emojiTab.addEventListener('click', showUnicode);
  customTab.addEventListener('click', showCustom);

  // Default to Unicode tab
  showUnicode();

  // Close on outside click or Escape
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeStampPicker();
  };
  const onOutsideClick = (e: MouseEvent) => {
    if (!activeStampPicker) return;
    if (!activeStampPicker.contains(e.target as Node)) closeStampPicker();
  };
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onOutsideClick);

  const origCleanup = activeStampCleanup;
  activeStampCleanup = () => {
    origCleanup?.();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onOutsideClick);
  };
}
