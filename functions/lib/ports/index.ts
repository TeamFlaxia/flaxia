/**
 * Platform-neutral ports.
 *
 * Feature code depends on these interfaces, never on a hosting provider's
 * binding types. The only code allowed to know about Cloudflare is
 * `functions/lib/adapters/cloudflare/`.
 *
 * The shapes intentionally mirror the Cloudflare bindings we use today so the
 * first migration can be a pure adapter change with no behaviour difference.
 * See docs/architecture/platform-neutrality.md.
 */

export interface DbResult<T = unknown> {
  results: T[];
  success: boolean;
  meta?: { changes?: number; rows_read?: number; rows_written?: number; [key: string]: unknown };
  error?: string;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  run<T = unknown>(): Promise<DbResult<T>>;
  all<T = unknown>(): Promise<DbResult<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

/** D1-shaped SQL database: prepare / bind / all / first / run / batch. */
export interface Db {
  prepare(query: string): DbStatement;
  batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface KvListKey<Metadata = unknown> {
  name: string;
  metadata?: Metadata;
}

export interface KvListResult<Metadata = unknown> {
  keys: KvListKey<Metadata>[];
  list_complete: boolean;
  cursor?: string;
}

export interface Kv {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list<Metadata = unknown>(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KvListResult<Metadata>>;
}

export interface BlobMetadata {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: {
    contentType?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface BlobObject extends BlobMetadata {
  body: ReadableStream;
}

export interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  head(key: string): Promise<BlobMetadata | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: {
      httpMetadata?: BlobMetadata['httpMetadata'];
      customMetadata?: Record<string, string>;
    },
  ): Promise<BlobMetadata | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: BlobMetadata[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export type QueueContentType = 'json' | 'text' | 'bytes' | 'v8';

export interface QueueSendOptions {
  contentType?: QueueContentType;
  delaySeconds?: number;
}

export interface QueueMessage {
  body: unknown;
  contentType?: QueueContentType;
  delaySeconds?: number;
}

export interface Queue {
  send(message: unknown, options?: QueueSendOptions): Promise<unknown>;
  sendBatch(messages: Iterable<QueueMessage>, options?: { delaySeconds?: number }): Promise<unknown>;
}

export type VectorMetadataScalar = string | number | boolean;
export type VectorMetadataValue = VectorMetadataScalar | string[];
export type VectorMetadata = Record<string, VectorMetadataValue | Record<string, VectorMetadataValue>>;

export interface VectorMetadataFilterOperators {
  $eq?: VectorMetadataScalar | null;
  $ne?: VectorMetadataScalar | null;
  $gt?: VectorMetadataScalar | null;
  $gte?: VectorMetadataScalar | null;
  $lt?: VectorMetadataScalar | null;
  $lte?: VectorMetadataScalar | null;
  $in?: VectorMetadataScalar[];
  $nin?: VectorMetadataScalar[];
}

export type VectorMetadataFilter = Record<string, VectorMetadataScalar | VectorMetadataFilterOperators>;

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: VectorMetadata;
  values?: number[] | Float32Array | Float64Array;
}

export interface VectorQueryOptions {
  topK?: number;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  filter?: VectorMetadataFilter;
}

export interface VectorVector {
  id: string;
  values: number[] | Float32Array | Float64Array;
  metadata?: VectorMetadata;
}

export interface Vector {
  query(
    vector: number[] | Float32Array | Float64Array,
    options?: VectorQueryOptions,
  ): Promise<{ matches: VectorMatch[] }>;
  upsert(vectors: VectorVector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface RealtimeChannel {
  fetch(request: Request): Promise<Response>;
}

/** Durable-object-like fanout surface (notification streams, rooms, ...). */
export interface Realtime {
  get(id: string): Promise<RealtimeChannel>;
}

/** Abstraction for `ExecutionContext.waitUntil`. */
export interface Tasks {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Services {
  db: Db;
  kv: Kv;
  blobs: BlobStore;
  queue?: Queue;
  vector?: Vector;
  realtime?: Realtime;
  tasks: Tasks;
}
