import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeNoteText,
  PRIVATE_NOTE_KIND,
  PRIVATE_NOTE_MAX_LENGTH,
  type PrivateNoteRow,
  removeNote,
  sortNotes,
  toNoteRows,
  upsertNote,
} from '../../src/lib/settings/private-notes.ts';

const note = (id: string, savedAt: number, text = id): PrivateNoteRow => ({ id, savedAt, text });

describe('settings/private-notes', () => {
  it('uses the vault kind and the 20k editor limit', () => {
    assert.equal(PRIVATE_NOTE_KIND, 'private_note');
    assert.equal(PRIVATE_NOTE_MAX_LENGTH, 20_000);
  });

  it('keeps only well-formed notes, newest first', () => {
    const rows = toNoteRows([
      { id: 'old', value: { text: 'old', savedAt: 10 } },
      { id: 'new', value: { text: 'new', savedAt: 30 } },
      { id: 'broken', value: { text: 42, savedAt: 20 } as never },
      { id: 'nan', value: { text: 'nan', savedAt: Number.NaN } },
      { id: 'missing' },
    ]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['new', 'old'],
    );
  });

  it('sorts a stable copy without mutating the input', () => {
    const input = [note('a', 1), note('b', 3), note('c', 2)];
    const sorted = sortNotes(input);
    assert.deepEqual(
      sorted.map((row) => row.id),
      ['b', 'c', 'a'],
    );
    assert.deepEqual(
      input.map((row) => row.id),
      ['a', 'b', 'c'],
    );
  });

  it('replaces an edited note instead of duplicating it', () => {
    const notes = [note('b', 3), note('a', 1)];
    const updated = upsertNote(notes, note('a', 5, 'edited'));
    assert.deepEqual(
      updated.map((row) => row.id),
      ['a', 'b'],
    );
    assert.equal(updated[0].text, 'edited');
  });

  it('removes a note by id', () => {
    assert.deepEqual(
      removeNote([note('a', 1), note('b', 2)], 'a').map((row) => row.id),
      ['b'],
    );
  });

  it('trims note text and rejects blank input', () => {
    assert.equal(normalizeNoteText('  hello \n'), 'hello');
    assert.equal(normalizeNoteText('   '), null);
    assert.equal(normalizeNoteText('\n\t'), null);
  });
});
