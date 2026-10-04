import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { getLocale, t } from '../lib/i18n.js';
import { deleteVaultItem, listVaultItems, newVaultItemId, saveVaultItem } from '../lib/vault/items.js';

interface PrivateNote {
  text: string;
  savedAt: number;
}

interface NoteRow extends PrivateNote {
  id: string;
}

const NOTE_INPUT_CSS = `
  box-sizing:border-box;width:100%;min-height:7rem;padding:0.65rem;
  border:1px solid var(--border);border-radius:6px;background:var(--bg-input);
  color:var(--text-primary);font:inherit;resize:vertical;
`;

export function createPrivateNotesSection(): HTMLElement {
  const section = document.createElement('section');
  section.style.cssText = 'margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border);';
  const title = document.createElement('h3');
  title.textContent = t('settings.vault_notes');
  title.style.cssText = 'font-size:0.95rem;margin:0 0 0.35rem;color:var(--text-primary);';
  const description = document.createElement('p');
  description.textContent = t('settings.vault_notes_desc');
  description.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);line-height:1.45;margin:0 0 0.75rem;';

  const editor = document.createElement('textarea');
  editor.maxLength = 20_000;
  editor.placeholder = t('settings.vault_note_placeholder');
  editor.style.cssText = NOTE_INPUT_CSS;
  const message = document.createElement('p');
  message.style.cssText = 'min-height:1.1rem;font-size:0.8rem;color:var(--danger);margin:0.35rem 0;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:0.5rem;margin:0.35rem 0 0.75rem;';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.textContent = t('settings.vault_note_save');
  saveButton.style.cssText =
    'padding:0.4rem 0.75rem;border:0;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;';
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.textContent = t('settings.vault_note_new');
  newButton.style.cssText =
    'padding:0.4rem 0.75rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;';
  actions.appendChild(saveButton);
  actions.appendChild(newButton);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;';
  section.appendChild(title);
  section.appendChild(description);
  section.appendChild(editor);
  section.appendChild(message);
  section.appendChild(actions);
  section.appendChild(list);

  let notes: NoteRow[] = [];
  let editingId: string | null = null;

  const setMessage = (text: string) => {
    message.textContent = text;
  };
  const render = () => {
    list.replaceChildren();
    if (notes.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('settings.vault_note_empty');
      empty.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);margin:0.25rem 0;';
      list.appendChild(empty);
      return;
    }
    for (const note of notes) {
      const card = document.createElement('article');
      card.style.cssText =
        'padding:0.65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);';
      const text = document.createElement('p');
      text.textContent = note.text;
      text.style.cssText =
        'white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--text-primary);font-size:0.85rem;';
      const footer = document.createElement('div');
      footer.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-top:0.5rem;';
      const date = document.createElement('time');
      date.dateTime = new Date(note.savedAt).toISOString();
      date.textContent = new Date(note.savedAt).toLocaleString(getLocale());
      date.style.cssText = 'font-size:0.7rem;color:var(--text-secondary);';
      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:0.5rem;';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = t('settings.vault_note_edit');
      edit.style.cssText =
        'border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;font-size:0.75rem;';
      edit.addEventListener('click', () => {
        editingId = note.id;
        editor.value = note.text;
        saveButton.textContent = t('settings.vault_note_save');
        setMessage('');
        editor.focus();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = t('common.delete');
      remove.style.cssText =
        'border:0;background:none;color:var(--danger);cursor:pointer;font:inherit;font-size:0.75rem;';
      remove.addEventListener('click', () => {
        void (async () => {
          if (!(await createConfirmDialog(t('settings.vault_note_delete_confirm')))) return;
          try {
            await deleteVaultItem(note.id);
            notes = notes.filter((candidate) => candidate.id !== note.id);
            if (editingId === note.id) {
              editingId = null;
              editor.value = '';
            }
            setMessage('');
            render();
          } catch {
            setMessage(t('settings.vault_note_failed'));
          }
        })();
      });
      buttons.appendChild(edit);
      buttons.appendChild(remove);
      footer.appendChild(date);
      footer.appendChild(buttons);
      card.appendChild(text);
      card.appendChild(footer);
      list.appendChild(card);
    }
  };

  const reload = async () => {
    try {
      const stored = await listVaultItems<PrivateNote>('private_note');
      notes = stored
        .filter(({ value }) => typeof value.text === 'string' && Number.isFinite(value.savedAt))
        .map(({ id, value }) => ({ id, ...value }))
        .sort((a, b) => b.savedAt - a.savedAt);
      render();
    } catch {
      setMessage(t('settings.vault_note_load_failed'));
    }
  };

  saveButton.addEventListener('click', () => {
    void (async () => {
      const text = editor.value.trim();
      if (!text) {
        setMessage(t('settings.vault_note_empty_text'));
        return;
      }
      saveButton.disabled = true;
      try {
        const note: NoteRow = { id: editingId ?? newVaultItemId(), text, savedAt: Date.now() };
        await saveVaultItem(note.id, 'private_note', { text: note.text, savedAt: note.savedAt });
        notes = [note, ...notes.filter((item) => item.id !== note.id)].sort((a, b) => b.savedAt - a.savedAt);
        editingId = null;
        editor.value = '';
        setMessage('');
        render();
      } catch {
        setMessage(t('settings.vault_note_failed'));
      } finally {
        saveButton.disabled = false;
      }
    })();
  });

  newButton.addEventListener('click', () => {
    editingId = null;
    editor.value = '';
    setMessage('');
    editor.focus();
  });

  void reload();
  return section;
}
