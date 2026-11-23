// Mail crypto (docs/mail.md §6.2).
//
// The implementation lives in `@flaxia/mail-contract`, which the Mail Worker
// consumes too. Keeping one implementation is what guarantees the wrap/unwrap
// and seal/decrypt envelopes stay byte-compatible.
//
// WebCrypto only; no ad-hoc constructions.

export * from '@flaxia/mail-contract';
