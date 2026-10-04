import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampLimit } from '../functions/lib/pagination.ts';

describe('clampLimit', () => {
  it('floors negative limits to 1 (SQLite treats them as unlimited)', () => {
    assert.equal(clampLimit('-1', 20, 50), 1);
    assert.equal(clampLimit('-99999', 20, 50), 1);
  });

  it('caps above the max and falls back on garbage', () => {
    assert.equal(clampLimit('500', 20, 50), 50);
    assert.equal(clampLimit('abc', 20, 50), 20);
    assert.equal(clampLimit(null, 20, 50), 20);
    assert.equal(clampLimit('10', 20, 50), 10);
  });
});
