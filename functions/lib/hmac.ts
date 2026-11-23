/**
 * Functions-facing entrypoint for the shared WebCrypto helpers.
 *
 * The implementation lives in `@flaxia/mail-contract` (via shared/webcrypto.ts)
 * so the mail Worker uses the same primitives. See
 * docs/architecture/platform-neutrality.md.
 */
export { hmacHex, signatureEquals } from '../../shared/webcrypto.ts';
