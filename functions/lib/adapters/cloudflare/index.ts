/**
 * Cloudflare adapter for the platform-neutral ports.
 *
 * This is the only module allowed to know about Cloudflare binding types.
 * It converts existing bindings into the ports from `functions/lib/ports/`
 * without changing behaviour.
 *
 * See docs/architecture/platform-neutrality.md.
 */
import type { Realtime as RealtimePort, Services, Tasks } from '../../ports/index.js';

/**
 * The subset of the Pages/Workers environment this adapter needs. Keeping it
 * structural (instead of importing `functions/api/types.ts`) avoids a cycle
 * and lets worker entrypoints reuse the same adapter.
 */
export interface CloudflareBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  CACHE: KVNamespace;
  AP_DELIVERY_QUEUE?: Queue<unknown>;
  VECTORIZE?: Vectorize;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
}

/** Minimal shape of the Workers `ExecutionContext`. */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const missingTasks: Tasks = {
  waitUntil() {
    throw new Error('createCloudflareServices() requires an ExecutionContext to schedule background work');
  },
};

export function createCloudflareServices(env: CloudflareBindings, ctx?: CloudflareExecutionContext): Services {
  return {
    db: env.DB,
    kv: env.CACHE,
    blobs: env.BUCKET,
    queue: env.AP_DELIVERY_QUEUE,
    vector: env.VECTORIZE,
    realtime: env.NOTIFICATION_STREAM ? createRealtime(env.NOTIFICATION_STREAM) : undefined,
    tasks: ctx ?? missingTasks,
  };
}

function createRealtime(namespace: DurableObjectNamespace): RealtimePort {
  return {
    async get(id) {
      const stub = namespace.get(namespace.idFromName(id));
      return {
        fetch: (request: Request) => stub.fetch(request),
      };
    },
  };
}
