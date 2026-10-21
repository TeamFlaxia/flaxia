// Password length policy.
//
// The server cannot enforce this any more: registration, password change and
// vault unlock all carry a locally derived SRP verifier instead of the
// password, so there is nothing to measure server-side. This module is the
// single source of truth for the rule, shared by every form that takes a
// password, and is covered by tests/password-policy.test.ts.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordLengthError = 'too_short' | 'too_long' | null;

export function passwordLengthError(password: string): PasswordLengthError {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}
