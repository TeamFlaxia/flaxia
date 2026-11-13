import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMailSearch } from '../src/lib/mail/search.ts';

describe('mail search parser', () => {
  it('parses operators and free text', () => {
    const q = parseMailSearch('from:alice@example.com has:attachment is:unread hello world');
    assert.equal(q.from, 'alice@example.com');
    assert.equal(q.hasAttachment, true);
    assert.equal(q.isUnread, true);
    assert.equal(q.text, 'hello world');
  });

  it('parses label/subject/date operators', () => {
    const q = parseMailSearch('label:work subject:invoice before:2026-01-01 after:2025-01-01');
    assert.equal(q.label, 'work');
    assert.equal(q.subject, 'invoice');
    assert.equal(q.before, '2026-01-01');
    assert.equal(q.after, '2025-01-01');
    assert.equal(q.text, '');
  });

  it('keeps unknown has:/is: values as free text', () => {
    const q = parseMailSearch('has:banana is:done');
    assert.equal(q.hasAttachment, undefined);
    assert.equal(q.isUnread, undefined);
    assert.equal(q.text, '');
  });

  it('handles empty input', () => {
    const q = parseMailSearch('   ');
    assert.equal(q.text, '');
    assert.equal(q.from, undefined);
  });
});
