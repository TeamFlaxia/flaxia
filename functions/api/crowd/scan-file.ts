/** Standalone Pages endpoint; authorization is the short-lived bearer ticket, not a session cookie. */
import { handleCrowdScanFileRequest } from '../routes/crowd-scan-file.ts';
import type { Bindings } from '../types.ts';

export async function onRequest(context: { request: Request; env: Bindings }) {
  return handleCrowdScanFileRequest(context.request, context.env);
}
