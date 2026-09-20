// Orchestrator callback endpoint. Kept separate from the asset proxy so the
// Crowd protocol boundary is explicit; all logic lives in functions/lib/crowd.
import { handleCrowdWebhook } from '../../lib/crowd';
import type { Bindings } from '../types';

export async function onRequest(context: { request: Request; env: Bindings }) {
  return handleCrowdWebhook(context.request, context.env, context.env.DB);
}
