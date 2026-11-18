/// <reference types="@cloudflare/workers-types" />

import { PUBLIC_COLLECTION } from './context.ts';
import { fetchActivityPubJson } from './fetch.ts';
import { actorSignOptions } from './keys.ts';
import { extractHashtags, htmlToText } from './text.ts';

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

/** Flaxia's own post length limit; remote text is clamped to it. */
const MAX_TEXT_LENGTH = 200;

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
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

  const actor = await fetchActivityPubJson(options.actorUrl, env, signOptions);
  const actorId = stringValue(actor?.id) ?? options.actorUrl;
  let actorOrigin: string;
  try {
    actorOrigin = new URL(actorId).origin;
  } catch {
    throw new Error('Actor URL is not a valid URL');
  }

  const preferredUsername = stringValue(actor?.preferredUsername);
  const domain = new URL(actorId).hostname;
  const author = preferredUsername ? `${preferredUsername}@${domain}` : actorId;

  const outboxUrl = stringValue(actor?.outbox);
  if (!outboxUrl) throw new Error('Actor has no outbox');
  try {
    if (new URL(outboxUrl).origin !== actorOrigin) throw new Error('Outbox is not on the actor origin');
  } catch {
    throw new Error('Actor outbox is not a valid URL');
  }

  const collection = await fetchActivityPubJson(outboxUrl, env, signOptions);
  let pageUrl: string | null = stringValue(collection?.first) ?? `${outboxUrl}?page=true`;

  const result: OutboxImportResult = {
    actorUrl: actorId,
    scanned: 0,
    imported: 0,
    skipped: 0,
    pages: 0,
  };
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES && pageUrl && result.scanned < limit; page++) {
    const document = await fetchActivityPubJson(pageUrl, env, signOptions);
    if (!document) break;
    result.pages++;

    const items = Array.isArray(document.orderedItems) ? document.orderedItems : [];
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
      if (stringValue(object.attributedTo) !== actorId) {
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
      const text = htmlToText(content).slice(0, MAX_TEXT_LENGTH);
      if (!text) {
        result.skipped++;
        continue;
      }

      const existing = await env.DB.prepare('SELECT id FROM posts WHERE ap_object_id = ? LIMIT 1')
        .bind(objectId)
        .first();
      if (existing) {
        result.skipped++;
        continue;
      }

      await env.DB.prepare(`
        INSERT INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, actor_id, ap_object_id, created_at)
        VALUES (?, '', ?, ?, ?, 'published', NULL, NULL, 0, ?, ?, ?)
      `)
        .bind(
          crypto.randomUUID(),
          author,
          text,
          JSON.stringify(extractHashtags(text)),
          actorId,
          objectId,
          publishedAt(object.published),
        )
        .run();
      result.imported++;
    }

    pageUrl = stringValue(document.next);
  }

  return result;
}
