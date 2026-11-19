/** SHA-256 of a UTF-8 string as lowercase hex. Shared by Crowd ingest, web search indexing, dataset export and mail signing. */

export { sha256Hex } from '../../shared/webcrypto.ts';
