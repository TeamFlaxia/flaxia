/// <reference types="@cloudflare/workers-types" />

import { actorUrl } from './actor.ts';
import { activityContext, PUBLIC_COLLECTION } from './context.ts';

/**
 * Builders for the activities Flaxia sends.
 *
 * Every activity carries a stable, dereferenceable id and the same
 * `@context`, so peers can deduplicate deliveries and resolve the object of an
 * `Undo` (which references the activity it retracts).
 */

export interface ActivityAudience {
  to?: string[];
  cc?: string[];
}

export interface ActorIdentity {
  username: string;
}

function actorOf(baseUrl: string, username: string): string {
  return actorUrl(baseUrl, username);
}

function activityId(baseUrl: string, type: string, unique: string): string {
  return `${baseUrl}/activities/${type.toLowerCase()}-${unique}`;
}

/** Follow a remote actor. */
export function buildFollowActivity(
  baseUrl: string,
  username: string,
  targetActorUrl: string,
  unique: string,
): Record<string, unknown> {
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Follow', unique),
    type: 'Follow',
    actor: actorOf(baseUrl, username),
    object: targetActorUrl,
    to: [targetActorUrl],
  };
}

/** Accept an incoming follow request. */
export function buildAcceptActivity(
  baseUrl: string,
  username: string,
  followActivity: Record<string, unknown>,
  unique: string,
): Record<string, unknown> {
  const target = typeof followActivity.actor === 'string' ? followActivity.actor : '';
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Accept', unique),
    type: 'Accept',
    actor: actorOf(baseUrl, username),
    object: followActivity,
    to: target ? [target] : [],
  };
}

/** Reject an incoming follow request. */
export function buildRejectActivity(
  baseUrl: string,
  username: string,
  followActivity: Record<string, unknown>,
  unique: string,
): Record<string, unknown> {
  const target = typeof followActivity.actor === 'string' ? followActivity.actor : '';
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Reject', unique),
    type: 'Reject',
    actor: actorOf(baseUrl, username),
    object: followActivity,
    to: target ? [target] : [],
  };
}

/** Like an object (a post of another instance). */
export function buildLikeActivity(
  baseUrl: string,
  username: string,
  objectUrl: string,
  unique: string,
  audience: ActivityAudience = {},
): Record<string, unknown> {
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Like', unique),
    type: 'Like',
    actor: actorOf(baseUrl, username),
    object: objectUrl,
    to: [objectUrl],
    cc: audience.cc ?? [],
  };
}

/** Boost (announce) an object. */
export function buildAnnounceActivity(
  baseUrl: string,
  username: string,
  objectUrl: string,
  unique: string,
  audience: ActivityAudience = {},
): Record<string, unknown> {
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Announce', unique),
    type: 'Announce',
    actor: actorOf(baseUrl, username),
    object: objectUrl,
    published: new Date().toISOString(),
    to: audience.to ?? [PUBLIC_COLLECTION],
    cc: audience.cc ?? [],
  };
}

/** Retract a previous activity (follow, like, announce, block). */
export function buildUndoActivity(
  baseUrl: string,
  username: string,
  object: Record<string, unknown>,
  unique: string,
  audience: ActivityAudience = {},
): Record<string, unknown> {
  const target = typeof object.object === 'string' ? object.object : '';
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Undo', unique),
    type: 'Undo',
    actor: actorOf(baseUrl, username),
    object,
    to: target ? [target] : (audience.to ?? []),
    cc: audience.cc ?? [],
  };
}

/** Delete an object (a post of this instance). */
export function buildDeleteActivity(
  baseUrl: string,
  username: string,
  objectId: string,
  unique: string,
  audience: ActivityAudience = {},
): Record<string, unknown> {
  const actor = actorOf(baseUrl, username);
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Delete', unique),
    type: 'Delete',
    actor,
    object: {
      id: objectId,
      type: 'Tombstone',
      formerType: 'Note',
    },
    to: audience.to ?? [PUBLIC_COLLECTION],
    cc: audience.cc ?? [],
  };
}

/** Update the actor document (profile changes). */
export function buildUpdateActivity(
  baseUrl: string,
  username: string,
  object: Record<string, unknown>,
  unique: string,
  audience: ActivityAudience = {},
): Record<string, unknown> {
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Update', unique),
    type: 'Update',
    actor: actorOf(baseUrl, username),
    object,
    to: audience.to ?? [PUBLIC_COLLECTION],
    cc: audience.cc ?? [],
  };
}

/** Block a remote actor. */
export function buildBlockActivity(
  baseUrl: string,
  username: string,
  targetActorUrl: string,
  unique: string,
): Record<string, unknown> {
  return {
    '@context': activityContext(),
    id: activityId(baseUrl, 'Block', unique),
    type: 'Block',
    actor: actorOf(baseUrl, username),
    object: targetActorUrl,
    to: [targetActorUrl],
  };
}
