import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLengthError } from '../src/lib/password-policy.ts';

test('accepts a password at the minimum length', () => {
  assert.equal(passwordLengthError('a'.repeat(PASSWORD_MIN_LENGTH)), null);
});

test('accepts a password at the maximum length', () => {
  assert.equal(passwordLengthError('a'.repeat(PASSWORD_MAX_LENGTH)), null);
});

test('rejects a password below the minimum length', () => {
  assert.equal(passwordLengthError('a'.repeat(PASSWORD_MIN_LENGTH - 1)), 'too_short');
});

test('rejects a password above the maximum length', () => {
  assert.equal(passwordLengthError('a'.repeat(PASSWORD_MAX_LENGTH + 1)), 'too_long');
});

test('rejects an empty password', () => {
  assert.equal(passwordLengthError(''), 'too_short');
});

test('boundaries are exactly 8 and 128', () => {
  // The API contract these constants stand in for.
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(PASSWORD_MAX_LENGTH, 128);
});
