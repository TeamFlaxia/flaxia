// Client-side envelope sealing for Mail send/draft (docs/mail.md §6.2, §9.2).
//
// The implementation lives in `@flaxia/mail-contract` because the wire format
// is shared with the Mail Worker's integration tests. Purely local: no network
// and no vault imports here.

export * from '@flaxia/mail-contract';
