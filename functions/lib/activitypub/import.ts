/// <reference types="@cloudflare/workers-types" />

import { nanoid } from 'nanoid';
import { parsePublicHttpUrl } from '../url-guard.ts';
import { cacheRemoteActor } from './actor-cache.ts';
import { PUBLIC_COLLECTION } from './context.ts';
import { canonicalActorUrl, fetchActivityPubJson, resolveRemoteActor } from './fetch.ts';
import { actorSignOptions } from './keys.ts';
import { extractHashtags, htmlToText, MAX_POST_TEXT_LENGTH } from './text.ts';

/**
 * Import the public outbox of a remote actor.
 *
 * Mastodon and friends only push new posts to followers; the outbox is the
 * one place where an actor's public history is still readable. Importing it
 * gives the recommendation feed something to rank without waiting for every
 * remote post to be delivered through an inbox.
 *
 * Only public, top-level Notes are stored. Replies, boosts, followers-only
 * posts and anything not attributed to the actor are skipped, and an already
 * imported Note is never inserted twice (`ap_object_id` is the identity).
 */

/** Upper bound of pages fetched from one outbox. */
const MAX_PAGES = 10;

/** Upper bound of Notes considered in one import run. */
const MAX_POSTS = 100;

/** D1 batches stay well below the per-request statement ceiling. */
const INSERT_CHUNK_SIZE = 50;

export interface OutboxImportEnv {
  DB: D1Database;
  BASE_URL: string;
  CACHE?: KVNamespace;
  ENVIRONMENT?: string;
  AP_ALLOWED_PRIVATE_PEERS?: string;
}

export interface OutboxImportOptions {
  /** Canonical actor URL (`https://instance/users/name`). */
  actorUrl: string;
  /** Local account that signs the outbox requests. */
  username: string;
  /** Maximum number of Notes to inspect. */
  limit?: number;
}

export interface OutboxImportResult {
  actorUrl: string;
  scanned: number;
  imported: number;
  skipped: number;
  pages: number;
  /** True when a later page could not be read or left the actor origin. */
  truncated: boolean;
}

export type OutboxImportErrorStatus = 400 | 404 | 422 | 502;

/** A failure the HTTP route can report without turning it into a generic 502. */
export class OutboxImportError extends Error {
  readonly status: OutboxImportErrorStatus;

  constructor(message: string, status: OutboxImportErrorStatus = 502) {
    super(message);
    this.name = 'OutboxImportError';
    this.status = status;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isPublicAudience(value: unknown): boolean {
  const audience = Array.isArray(value) ? value : [value];
  return audience.includes(PUBLIC_COLLECTION);
}

function publishedAt(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    // A remote Note may claim a future timestamp; never pin it above the feed
    // window or let it outrank everything until that date arrives.
    if (Number.isFinite(parsed)) return new Date(Math.min(parsed, Date.now())).toISOString();
  }
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Keep a page URL only when it stays on the actor's origin. */
function sameOriginUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `attributedTo` is a string or an array of actor URLs in the wild. */
function isAttributedTo(value: unknown, actorId: string): boolean {
  const target = canonicalActorUrl(actorId);
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.some((candidate) => typeof candidate === 'string' && canonicalActorUrl(candidate) === target);
}

function truncateText(text: string): string {
  const characters = Array.from(text);
  return characters.length > MAX_POST_TEXT_LENGTH ? characters.slice(0, MAX_POST_TEXT_LENGTH).join('') : text;
}

interface PendingNote {
  objectId: string;
  text: string;
  createdAt: string;
}

/**
 * Insert a page's Notes, skipping anything already stored.
 *
 * The lookup is one query per page instead of one per Note, and the inserts run
 * as a batch. `INSERT OR IGNORE` keeps a concurrent inbox delivery (or a second
 * import) from failing the whole run on the `ap_object_id` unique index.
 */
async function storeNotes(
  db: D1Database,
  notes: PendingNote[],
  actorId: string,
  author: string,
  result: OutboxImportResult,
): Promise<void> {
  if (notes.length === 0) return;

  const existing = new Set<string>();
  const rows = await db
    .prepare('SELECT ap_object_id FROM posts WHERE ap_object_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(notes.map((note) => note.objectId)))
    .all<{ ap_object_id: string }>();
  for (const row of rows.results ?? []) existing.add(row.ap_object_id);

  const pending = notes.filter((note) => !existing.has(note.objectId));
  result.skipped += notes.length - pending.length;

  for (let offset = 0; offset < pending.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = pending.slice(offset, offset + INSERT_CHUNK_SIZE);
    const statements = chunk.map((note) =>
      db
        .prepare(`
          INSERT OR IGNORE INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, actor_id, ap_object_id, created_at)
          VALUES (?, '', ?, ?, ?, 'published', NULL, NULL, 0, ?, ?, ?)
        `)
        .bind(
          nanoid(),
          author,
          note.text,
          JSON.stringify(extractHashtags(note.text)),
          actorId,
          note.objectId,
          note.createdAt,
        ),
    );
    const inserted = await db.batch(statements);
    for (const entry of inserted) {
      if ((entry.meta?.changes ?? 0) > 0) result.imported++;
      else result.skipped++;
    }
  }
}

/**
 * Fetch an actor's public outbox and store its Notes as remote posts.
 */
export async function importRemoteOutbox(
  env: OutboxImportEnv,
  options: OutboxImportOptions,
): Promise<OutboxImportResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 40), 1), MAX_POSTS);
  const signOptions = await actorSignOptions(env.DB, env.BASE_URL, options.username);

  // `resolveRemoteActor` is the same validation the follow flow uses: only a
  // document whose canonical id matches the requested actor and whose inbox is
  // on that origin is trusted.
  const actor = await resolveRemoteActor(options.actorUrl, env, signOptions);
  if (!actor) throw new OutboxImportError('Actor could not be fetched', 502);

  const actorId = actor.actorUrl;
  let actorOrigin: string;
  try {
    actorOrigin = new URL(actorId).origin;
  } catch {
    throw new OutboxImportError('Actor URL is not a valid URL', 422);
  }

  if (!actor.outbox) throw new OutboxImportError('Actor has no outbox', 422);
  let outboxUrl: URL;
  try {
    outboxUrl = parsePublicHttpUrl(actor.outbox);
  } catch {
    throw new OutboxImportError('Actor outbox is not a public URL', 422);
  }
  if (outboxUrl.origin !== actorOrigin) {
    throw new OutboxImportError('Actor outbox is not on the actor origin', 422);
  }

  // The imported posts are presented through `ap_actors`; without this row the
  // author link would fall back to a guessed handle and the remote profile
  // endpoint would return 404.
  await cacheRemoteActor(env.DB, actor);

  const domain = actor.domain || new URL(actorId).hostname;
  const author = actor.preferredUsername ? `${actor.preferredUsername}@${domain}` : actorId;

  const collection = await fetchActivityPubJson(outboxUrl.toString(), env, { ...signOptions, sameOrigin: true });
  if (!collection) throw new OutboxImportError('Could not fetch the outbox', 502);

  // Mastodon returns an OrderedCollection whose `first` is a page URL. Some
  // implementations inline the first page or even the items in the collection.
  let pageUrl: string | null = null;
  let inlinePage: Record<string, unknown> | null = null;
  const first = collection.first;
  if (typeof first === 'string') {
    pageUrl = sameOriginUrl(first, actorOrigin);
    if (!pageUrl) throw new OutboxImportError('Outbox page is not on the actor origin', 502);
  } else {
    const firstPage = asRecord(first);
    if (firstPage) inlinePage = firstPage;
    else if (Array.isArray(collection.orderedItems) || Array.isArray(collection.items)) inlinePage = collection;
    else {
      const fallback = new URL(outboxUrl);
      fallback.searchParams.set('page', 'true');
      pageUrl = fallback.toString();
    }
  }

  const result: OutboxImportResult = {
    actorUrl: actorId,
    scanned: 0,
    imported: 0,
    skipped: 0,
    pages: 0,
    truncated: false,
  };
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES && (inlinePage || pageUrl) && result.scanned < limit; page++) {
    let document: Record<string, unknown> | null;
    if (inlinePage) {
      document = inlinePage;
      inlinePage = null;
    } else {
      document = await fetchActivityPubJson(pageUrl as string, env, { ...signOptions, sameOrigin: true });
    }

    if (!document) {
      // The first page is the contract with the caller; a later page can fail
      // after posts were already stored, so report the partial result.
      if (page === 0) throw new OutboxImportError('Could not fetch the first outbox page', 502);
      result.truncated = true;
      break;
    }
    result.pages++;

    const items = Array.isArray(document.orderedItems)
      ? document.orderedItems
      : Array.isArray(document.items)
        ? document.items
        : [];
    const pending: PendingNote[] = [];

    for (const item of items) {
      if (result.scanned >= limit) break;

      const activity = asRecord(item);
      if (!activity) continue;
      const object = activity.type === 'Create' ? asRecord(activity.object) : activity;
      if (!object || object.type !== 'Note') continue;

      const objectId = stringValue(object.id);
      if (!objectId || seen.has(objectId)) continue;
      seen.add(objectId);
      result.scanned++;

      if (!isPublicAudience(object.to) && !isPublicAudience(object.cc)) {
        result.skipped++;
        continue;
      }
      if (object.inReplyTo) {
        result.skipped++;
        continue;
      }
      if (!isAttributedTo(object.attributedTo, actorId)) {
        result.skipped++;
        continue;
      }
      try {
        if (new URL(objectId).origin !== actorOrigin) {
          result.skipped++;
          continue;
        }
      } catch {
        result.skipped++;
        continue;
      }

      const content = stringValue(object.content);
      if (!content) {
        result.skipped++;
        continue;
      }
      const text = truncateText(htmlToText(content));
      if (!text) {
        result.skipped++;
        continue;
      }

      pending.push({
        objectId,
        text,
        createdAt: publishedAt(object.published),
      });
    }

    await storeNotes(env.DB, pending, actorId, author, result);

    pageUrl = stringValue(document.next);
    if (!pageUrl) break;
    pageUrl = sameOriginUrl(pageUrl, actorOrigin);
    if (!pageUrl) {
      // A page may not send the signed request to another origin.
      result.truncated = true;
      break;
    }
  }

  return result;
}
