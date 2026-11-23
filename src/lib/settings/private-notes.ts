// Pure model for the Personal Vault private-notes section. The Svelte
// component owns the editor and rendering; these helpers keep the encrypted
// item shape, ordering and validation testable without a DOM.

export const PRIVATE_NOTE_KIND = 'private_note';
export const PRIVATE_NOTE_MAX_LENGTH = 20_000;

export interface PrivateNoteValue {
  text: string;
  savedAt: number;
}

export interface PrivateNoteRow extends PrivateNoteValue {
  id: string;
}

/** Decrypted items arrive from the network, so validate before trusting them. */
export function isPrivateNoteValue(value: unknown): value is PrivateNoteValue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { text?: unknown; savedAt?: unknown };
  return (
    typeof candidate.text === 'string' && typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
  );
}

export function sortNotes(notes: readonly PrivateNoteRow[]): PrivateNoteRow[] {
  return [...notes].sort((a, b) => b.savedAt - a.savedAt);
}

/** Drop damaged rows and normalize the rest into newest-first cards. */
export function toNoteRows(stored: ReadonlyArray<{ id: string; value?: unknown }>): PrivateNoteRow[] {
  const rows: PrivateNoteRow[] = [];
  for (const item of stored) {
    if (!isPrivateNoteValue(item.value)) continue;
    rows.push({ id: item.id, text: item.value.text, savedAt: item.value.savedAt });
  }
  return sortNotes(rows);
}

/** Saving an edited note replaces it and moves it to the top. */
export function upsertNote(notes: readonly PrivateNoteRow[], note: PrivateNoteRow): PrivateNoteRow[] {
  return sortNotes([note, ...notes.filter((candidate) => candidate.id !== note.id)]);
}

export function removeNote(notes: readonly PrivateNoteRow[], id: string): PrivateNoteRow[] {
  return notes.filter((candidate) => candidate.id !== id);
}

/** Blank notes are not saved; surrounding whitespace is not part of the text. */
export function normalizeNoteText(raw: string): string | null {
  const text = raw.trim();
  return text ? text : null;
}
