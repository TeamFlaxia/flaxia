<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Personal Vault private notes: list, edit and delete encrypted notes. The
// vault item helpers own encryption; this component owns only the UI state.
import { onMount } from 'svelte';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { getLocale, t } from '../i18n.ts';
import {
  normalizeNoteText,
  PRIVATE_NOTE_KIND,
  PRIVATE_NOTE_MAX_LENGTH,
  type PrivateNoteRow,
  removeNote,
  toNoteRows,
  upsertNote,
} from '../settings/private-notes.ts';
import { deleteVaultItem, listVaultItems, newVaultItemId, saveVaultItem } from '../vault/items.js';

let notes = $state<PrivateNoteRow[]>([]);
let editingId = $state<string | null>(null);
let editor = $state<HTMLTextAreaElement>();
let text = $state('');
let message = $state('');
let saving = $state(false);

async function reload(): Promise<void> {
  try {
    notes = toNoteRows(await listVaultItems<unknown>(PRIVATE_NOTE_KIND));
  } catch {
    message = t('settings.vault_note_load_failed');
  }
}

function resetEditor(): void {
  editingId = null;
  text = '';
  message = '';
}

function edit(note: PrivateNoteRow): void {
  editingId = note.id;
  text = note.text;
  message = '';
  editor?.focus();
}

async function save(): Promise<void> {
  const value = normalizeNoteText(text);
  if (!value) {
    message = t('settings.vault_note_empty_text');
    return;
  }
  saving = true;
  try {
    const note: PrivateNoteRow = { id: editingId ?? newVaultItemId(), text: value, savedAt: Date.now() };
    await saveVaultItem(note.id, PRIVATE_NOTE_KIND, { text: note.text, savedAt: note.savedAt });
    notes = upsertNote(notes, note);
    resetEditor();
  } catch {
    message = t('settings.vault_note_failed');
  } finally {
    saving = false;
  }
}

async function remove(id: string): Promise<void> {
  if (!(await confirmDialog(t('settings.vault_note_delete_confirm')))) return;
  try {
    await deleteVaultItem(id);
    notes = removeNote(notes, id);
    if (editingId === id) {
      editingId = null;
      text = '';
    }
    message = '';
  } catch {
    message = t('settings.vault_note_failed');
  }
}

onMount(() => {
  void reload();
});
</script>

<section class="vault-notes">
  <h3>{t('settings.vault_notes')}</h3>
  <p class="vault-notes-description">{t('settings.vault_notes_desc')}</p>

  <textarea
    bind:this={editor}
    bind:value={text}
    maxlength={PRIVATE_NOTE_MAX_LENGTH}
    placeholder={t('settings.vault_note_placeholder')}
  ></textarea>

  <p class="vault-notes-message" role="status" aria-live="polite">{message}</p>

  <div class="vault-notes-actions">
    <button type="button" class="vault-notes-save" disabled={saving} onclick={() => void save()}>
      {t('settings.vault_note_save')}
    </button>
    <button type="button" class="vault-notes-new" onclick={resetEditor}>
      {t('settings.vault_note_new')}
    </button>
  </div>

  <div class="vault-notes-list">
    {#if notes.length === 0}
      <p class="vault-notes-empty">{t('settings.vault_note_empty')}</p>
    {:else}
      {#each notes as note (note.id)}
        <article class="vault-note">
          <p class="vault-note-text">{note.text}</p>
          <div class="vault-note-footer">
            <time class="vault-note-date" datetime={new Date(note.savedAt).toISOString()}>
              {new Date(note.savedAt).toLocaleString(getLocale())}
            </time>
            <div class="vault-note-buttons">
              <button type="button" class="vault-note-edit" onclick={() => edit(note)}>
                {t('settings.vault_note_edit')}
              </button>
              <button type="button" class="vault-note-delete" onclick={() => void remove(note.id)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .vault-notes {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .vault-notes h3 {
    margin: 0 0 0.35rem;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .vault-notes-description {
    margin: 0 0 0.75rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .vault-notes textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 7rem;
    padding: 0.65rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    resize: vertical;
  }

  .vault-notes-message {
    min-height: 1.1rem;
    margin: 0.35rem 0;
    color: var(--danger);
    font-size: 0.8rem;
  }

  .vault-notes-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.35rem 0 0.75rem;
  }

  .vault-notes-save {
    padding: 0.4rem 0.75rem;
    border: 0;
    border-radius: 4px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }

  .vault-notes-new {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    cursor: pointer;
  }

  .vault-notes-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .vault-notes-empty {
    margin: 0.25rem 0;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .vault-note {
    padding: 0.65rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .vault-note-text {
    margin: 0;
    color: var(--text-primary);
    font-size: 0.85rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .vault-note-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .vault-note-date {
    color: var(--text-secondary);
    font-size: 0.7rem;
  }

  .vault-note-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .vault-note-edit,
  .vault-note-delete {
    border: 0;
    background: none;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
  }

  .vault-note-edit {
    color: var(--accent);
  }

  .vault-note-delete {
    color: var(--danger);
  }
</style>
