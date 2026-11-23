/**
 * WebCrypto helpers shared by Pages Functions and the mail Worker.
 *
 * The implementation lives in `@flaxia/mail-contract` so both sides sign the
 * same `x-flaxia-sig` contract (docs/mail.md §5) and the primitives cannot
 * drift.
 */

export { hmacHex, sha256Hex, signatureEquals } from '@flaxia/mail-contract';
