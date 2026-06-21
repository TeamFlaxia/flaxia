import {
  escapeHtml,
  type PostRow,
  renderBlogPostingJsonLd,
  renderHtmlShell,
  renderJsonLd,
  renderPostArticle,
} from '../../src/lib/render-html';

const assetUrl = (baseUrl: string, key: string) => `${baseUrl}/api/images/${key}`;

type Env = {
  DB: D1Database;
  BASE_URL?: string;
};

type RawPost = Record<string, unknown>;

function toPost(row: RawPost): PostRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    username: String(row.username),
    display_name: row.display_name ? String(row.display_name) : null,
    avatar_key: row.avatar_key ? String(row.avatar_key) : null,
    text: String(row.text),
    hashtags: String(row.hashtags),
    gif_key: row.gif_key ? String(row.gif_key) : null,
    payload_key: row.payload_key ? String(row.payload_key) : null,
    swf_key: row.swf_key ? String(row.swf_key) : null,
    thumbnail_key: row.thumbnail_key ? String(row.thumbnail_key) : null,
    fresh_count: Number(row.fresh_count),
    bookmark_count: Number(row.bookmark_count),
    reply_count: Number(row.reply_count),
    impressions: Number(row.impressions),
    parent_id: row.parent_id ? String(row.parent_id) : null,
    root_id: row.root_id ? String(row.root_id) : null,
    depth: Number(row.depth),
    status: String(row.status),
    hidden: Number(row.hidden),
    created_at: String(row.created_at),
  };
}

const POST_SELECT = `
  SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key,
    p.text, p.hashtags, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key,
    p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
    COALESCE(p.reply_count, 0) as reply_count,
    COALESCE(p.impressions, 0) as impressions,
    p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth,
    COALESCE(p.status, 'published') as status,
    COALESCE(p.hidden, 0) as hidden, p.created_at
  FROM posts p
  LEFT JOIN users u ON p.user_id = u.id
`;

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';

  const url = new URL(request.url);
  const id = url.pathname.split('/')[2];
  const canonicalUrl = `${baseUrl}/thread/${id || ''}`;
  const defaultImage = `${baseUrl}/og-default-v2.png`;

  if (!id) {
    return new Response(
      renderHtmlShell(`<div class="ssr-empty"><h1>Post not found</h1><p>The requested post does not exist.</p></div>`, {
        title: 'Post not found',
        description: 'Post not found',
        canonicalUrl,
        image: defaultImage,
      }),
      { status: 404, headers: { 'Content-Type': 'text/html' } },
    );
  }

  try {
    const mainRow = (await env.DB.prepare(`${POST_SELECT} WHERE p.id = ? AND p.status = 'published'`)
      .bind(id)
      .first()) as RawPost | null;

    if (!mainRow) {
      return new Response(
        renderHtmlShell(
          `<div class="ssr-empty"><h1>Post not found</h1><p>The requested post does not exist.</p></div>`,
          { title: 'Post not found', description: 'Post not found', canonicalUrl, image: defaultImage },
        ),
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const post = toPost(mainRow);

    // Fetch replies
    const { results: replyRows } = await env.DB.prepare(
      `${POST_SELECT} WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ORDER BY p.created_at ASC LIMIT 50`,
    )
      .bind(id)
      .all<RawPost>();

    const replies = (replyRows || []).map(toPost);

    // Build OG image
    const gifKey = post.gif_key;
    const isImage = gifKey && !gifKey.startsWith('audio/');
    const ogImage = isImage
      ? assetUrl(baseUrl, gifKey)
      : post.thumbnail_key
        ? assetUrl(baseUrl, post.thumbnail_key)
        : defaultImage;

    const additionalHead = '';

    // Build JSON-LD
    const profileUrl = `${baseUrl}/users/${post.username}`;
    const jsonLd = renderBlogPostingJsonLd(post, post.display_name || post.username, profileUrl, canonicalUrl);

    // Build main content
    const mainPostHtml = renderPostArticle(post, baseUrl);
    const repliesHtml =
      replies.length > 0
        ? `<section class="ssr-replies"><h2>${replies.length} Replies</h2>${replies.map((r) => renderPostArticle(r, baseUrl)).join('\n')}</section>`
        : '';

    const content = `
      ${mainPostHtml}
      ${repliesHtml}
      <footer class="ssr-footer">
        <a href="${escapeHtml(baseUrl)}">← Back to Flaxia</a>
      </footer>
    `;

    return new Response(
      renderHtmlShell(content, {
        title: `Flaxia - ${post.display_name || post.username}`,
        description: post.text.slice(0, 200),
        canonicalUrl,
        image: ogImage,

        jsonLd,
        additionalHead,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  } catch (error) {
    console.error('SSR thread error:', error);
    return new Response(
      renderHtmlShell(`<div class="ssr-empty"><h1>Error</h1><p>Failed to load this post.</p></div>`, {
        title: 'Error',
        description: 'Failed to load post',
        canonicalUrl,
        image: defaultImage,
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    );
  }
}
