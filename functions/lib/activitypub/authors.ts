/// <reference types="@cloudflare/workers-types" />

/**
 * Author presentation for remote ActivityPub posts.
 *
 * Remote posts are stored once with `user_id = ''`; the author is the actor in
 * `ap_actors`. The feed queries stay on `posts` and this helper fills the
 * display fields after the rows are fetched.
 */
/**
 * Present a remote post with the author of the remote actor.
 */
export async function enrichPostsWithRemoteAuthors(
  posts: Array<Record<string, unknown>>,
  db: D1Database,
): Promise<void> {
  const nested: Array<Record<string, unknown>> = [];
  for (const post of posts) {
    const quoted = post.quoted_post;
    if (quoted && typeof quoted === 'object' && !Array.isArray(quoted)) {
      nested.push(quoted as Record<string, unknown>);
    }
  }
  const rows = [...posts, ...nested];
  const ids = [...new Set(rows.map((row) => (typeof row.id === 'string' ? row.id : '')).filter(Boolean))];
  if (ids.length === 0) return;
  const actorRows = await db
    .prepare(`SELECT id, actor_id FROM posts WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ id: string; actor_id: string | null }>();
  const actorByPost = new Map((actorRows.results ?? []).map((row) => [row.id, row.actor_id]));
  const actorUrls = [...new Set([...actorByPost.values()].filter((value): value is string => Boolean(value)))];
  if (actorUrls.length === 0) return;
  const actors = await db
    .prepare(
      `SELECT actor_url, preferred_username, display_name, icon_url, domain FROM ap_actors WHERE actor_url IN (${actorUrls.map(() => '?').join(',')})`,
    )
    .bind(...actorUrls)
    .all<{
      actor_url: string;
      preferred_username: string | null;
      display_name: string | null;
      icon_url: string | null;
      domain: string | null;
    }>();
  const actorByUrl = new Map((actors.results ?? []).map((row) => [row.actor_url, row]));

  for (const row of rows) {
    const actorUrl = actorByPost.get(String(row.id));
    if (!actorUrl) continue;
    const actor = actorByUrl.get(actorUrl);
    let domain = actor?.domain ?? '';
    let username = actor?.preferred_username ?? '';
    if (!domain || !username) {
      try {
        const parsed = new URL(actorUrl);
        if (!domain) domain = parsed.hostname;
        if (!username) username = parsed.pathname.split('/').filter(Boolean).pop() ?? actorUrl;
      } catch {
        if (!username) username = actorUrl;
      }
    }
    row.actor_id = actorUrl;
    row.user_id = actorUrl;
    row.username = domain ? `${username}@${domain}` : username;
    row.display_name = actor?.display_name ?? username;
    row.avatar_url = actor?.icon_url ?? null;
    row.avatar_key = null;
    row.badge_type = null;
    row.name_color = null;
    row.equipped_title_id = null;
    row.title_name = null;
    row.title_name_ja = null;
    row.title_description = null;
    row.title_description_ja = null;
    row.title_icon = null;
    row.author_language = null;
    row.is_remote = true;
    row.profile_path = domain
      ? `/@${encodeURIComponent(domain)}/${encodeURIComponent(username)}`
      : `/@${encodeURIComponent(actorUrl)}/`;
  }
}
