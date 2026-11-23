// Mail address helpers (docs/mail.md §7, §11.2).
//
// The implementation lives in `@flaxia/mail-contract` so the SPA, Pages
// Functions and the Mail Worker share one reserved-local list and grammar.
// This module stays as the app-local import path.

export * from '@flaxia/mail-contract';
