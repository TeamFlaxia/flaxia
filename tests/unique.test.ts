import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendUniqueBy, uniqueBy } from '../src/lib/unique.ts';

interface Row {
  id: string;
  value: number;
}

describe('uniqueBy', () => {
  it('keeps the first occurrence and preserves order', () => {
    const rows: Row[] = [
      { id: 'b', value: 1 },
      { id: 'a', value: 2 },
      { id: 'b', value: 3 },
    ];
    assert.deepEqual(
      uniqueBy(rows, (row) => row.id),
      [
        { id: 'b', value: 1 },
        { id: 'a', value: 2 },
      ],
    );
  });
});

describe('appendUniqueBy', () => {
  it('appends only rows whose key is new', () => {
    const existing: Row[] = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ];
    const incoming: Row[] = [
      { id: 'b', value: 20 },
      { id: 'c', value: 3 },
      { id: 'c', value: 30 },
    ];

    assert.deepEqual(
      appendUniqueBy(existing, incoming, (row) => row.id),
      [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
        { id: 'c', value: 3 },
      ],
    );
  });

  it('also deduplicates the existing list', () => {
    const existing: Row[] = [
      { id: 'a', value: 1 },
      { id: 'a', value: 2 },
    ];
    assert.deepEqual(
      appendUniqueBy(existing, [], (row) => row.id),
      [{ id: 'a', value: 1 }],
    );
  });
});
