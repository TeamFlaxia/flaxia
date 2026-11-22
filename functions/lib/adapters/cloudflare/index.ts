/**
 * Cloudflare adapter for the platform-neutral ports.
 *
 * This is the only module allowed to know about Cloudflare binding types.
 * It converts existing bindings into the ports from `functions/lib/ports/`
 * without changing behaviour.
 *
 * See docs/architecture/platform-neutrality.md.
 */
import type { BlobMetadata, BlobStore, Realtime as RealtimePort, Services, Tasks } from '../../ports/index.js';

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
    blobs: createBlobStore(env.BUCKET),
    queue: env.AP_DELIVERY_QUEUE,
    vector: env.VECTORIZE,
    realtime: env.NOTIFICATION_STREAM ? createRealtime(env.NOTIFICATION_STREAM) : undefined,
    tasks: ctx ?? missingTasks,
  };
}

/**
 * R2 refuses a `ReadableStream` body unless its length is known. Chunked
 * uploads assemble a stream of unknown length, so wrap it in a
 * `FixedLengthStream` before handing it to the binding.
 */
function createBlobStore(bucket: CloudflareBindings['BUCKET']): BlobStore {
  return {
    get(key, options) {
      return bucket.get(key, options?.range ? { range: options.range } : undefined) as ReturnType<BlobStore['get']>;
    },
    head(key) {
      return bucket.head(key) as ReturnType<BlobStore['head']>;
    },
    async put(key, value, options) {
      if (value instanceof ReadableStream && typeof options?.length === 'number') {
        const fixed = new FixedLengthStream(options.length);
        const pumping = value.pipeTo(fixed.writable).catch((error) => {
          console.error('Streaming upload failed:', error);
        });
        try {
          return (await bucket.put(key, fixed.readable, {
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata,
          })) as BlobMetadata | null;
        } finally {
          await pumping;
        }
      }
      const { length: _length, ...rest } = options ?? {};
      return bucket.put(key, value as Parameters<typeof bucket.put>[1], rest) as Promise<BlobMetadata | null>;
    },
    async delete(keys) {
      await bucket.delete(keys);
    },
    async list(options) {
      const result = await bucket.list(options);
      return {
        objects: result.objects as BlobMetadata[],
        truncated: result.truncated,
        cursor: 'cursor' in result ? result.cursor : undefined,
      };
    },
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
