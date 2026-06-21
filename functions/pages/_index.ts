import { type PostRow, renderHtmlShell, renderPostList, renderWebSiteJsonLd } from '../../src/lib/render-html';

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

export async function onRequest(context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const { request, env } = context;
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  const defaultImage = `${baseUrl}/og-default-v2.png`;

  const acceptHeader = request.headers.get('accept') || '';
  if (acceptHeader.includes('application/activity+json')) {
    return context.next();
  }

  try {
    let posts: PostRow[] = [];
    if (env.DB) {
      const { results } = await env.DB.prepare(
        `${POST_SELECT} WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT 20`,
      ).all<RawPost>();
      posts = (results || []).map(toPost);
    }

    const jsonLd = renderWebSiteJsonLd('Flaxia', baseUrl);

    const content = `
      <header class="ssr-header">
        <a href="${baseUrl}" class="ssr-logo">Flaxia</a>
        <a href="${baseUrl}/explore" style="color:#007bff;text-decoration:none;font-size:14px">Explore</a>
      </header>
      <main>
        <h1 style="font-size:18px;font-weight:600;margin:0 0 16px 0;color:var(--text-primary)">Latest Posts</h1>
        ${renderPostList(posts, baseUrl)}
      </main>
      <footer class="ssr-footer">
        <a href="${baseUrl}/explore">Explore</a> · <a href="${baseUrl}/arcade">Arcade</a> · <a href="${baseUrl}/about">About</a>
      </footer>
    `;

    return new Response(
      renderHtmlShell(content, {
        title: 'Flaxia - クリエイティブな投稿プラットフォーム',
        description:
          'Flaxiaは、クリエイティブな投稿を共有できるプラットフォームです。テキスト、画像、音声、ZIPファイルなど、様々な形式のコンテンツを投稿して、コミュニティと繋がりましょう。',
        canonicalUrl: baseUrl,
        image: defaultImage,
        jsonLd,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  } catch (error) {
    console.error('SSR timeline error:', error);
    return new Response(
      renderHtmlShell(`<p>Failed to load timeline.</p>`, {
        title: 'Flaxia',
        description: 'Creative post platform',
        canonicalUrl: baseUrl,
        image: defaultImage,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }
}
