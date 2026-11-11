/// <reference types="@cloudflare/workers-types" />

import { actorUrl, parseWebfingerResource, profileUrl } from './actor.ts';

/**
 * WebFinger discovery.
 *
 * Peers ask for an account either as `acct:user@domain` or as the URL of a
 * profile page. Both forms are answered with the actor of the account, so a
 * peer can start a federation with the URL it found in a profile link.
 */

export interface WebFingerEnv {
  DB: D1Database;
  BASE_URL: string;
}

export interface WebFingerResult {
  status: number;
  body: Record<string, unknown>;
  contentType?: string;
}

export async function webfingerResponse(env: WebFingerEnv, resource: string | undefined): Promise<WebFingerResult> {
  if (!resource) {
    return { status: 400, body: { error: 'Missing resource parameter' } };
  }

  const parsed = parseWebfingerResource(resource, env.BASE_URL);
  if (!parsed) {
    return { status: 400, body: { error: 'Invalid resource format' } };
  }

  const user = await env.DB.prepare(
    'SELECT username FROM users WHERE username = ? COLLATE NOCASE AND frozen_at IS NULL',
  )
    .bind(parsed.username)
    .first<{ username: string }>();
  if (!user) {
    return { status: 404, body: { error: 'User not found' } };
  }

  // The host carries the port of a local instance, so the subject matches
  // the address the peer used.
  const domain = new URL(env.BASE_URL).host;
  return {
    status: 200,
    contentType: 'application/jrd+json',
    body: {
      subject: `acct:${user.username}@${domain}`,
      aliases: [profileUrl(env.BASE_URL, user.username)],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl(env.BASE_URL, user.username),
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: profileUrl(env.BASE_URL, user.username),
        },
      ],
    },
  };
}
