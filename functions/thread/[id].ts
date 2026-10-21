import { buildGameDescription, buildGameTitle } from '../../src/lib/game-seo';
import { isCrawler } from '../../src/lib/is-crawler';
import { type PostRow, renderBlogPostingJsonLd, renderHtmlShell, renderPostArticle } from '../../src/lib/render-html';
import { SPA_HEAD_TAGS } from '../lib/ssr-head.generated';
import { renderBreadcrumbJsonLd, renderSsrFooter, renderSsrHeader, renderSsrLayoutCss } from '../lib/ssr-layout';

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
    badge_type: row.badge_type ? String(row.badge_type) : null,
    text: String(row.text),
    hashtags: String(row.hashtags),
    gif_key: row.gif_key ? String(row.gif_key) : null,
    payload_key: row.payload_key ? String(row.payload_key) : null,
    swf_key: row.swf_key ? String(row.swf_key) : null,
    thumbnail_key: row.thumbnail_key ? String(row.thumbnail_key) : null,
    game_description: row.game_description ? String(row.game_description) : null,
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
  SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type,
    p.text, p.hashtags, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key,
    p.game_description,
    p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
    COALESCE(p.reply_count, 0) as reply_count,
    COALESCE(p.impressions, 0) as impressions,
    p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth,
    COALESCE(p.status, 'published') as status,
    COALESCE(p.hidden, 0) as hidden, p.created_at
  FROM posts p
  LEFT JOIN users u ON p.user_id = u.id
`;

function detectGameType(post: PostRow): string {
  if (post.swf_key) return 'flash';
  if (post.payload_key) return 'zip';
  return 'html5';
}

export async function onRequest(context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const { request, env } = context;

  const userAgent = request.headers.get('User-Agent') || '';
  if (!isCrawler(userAgent)) {
    return context.next();
  }

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
        spaHeadTags: SPA_HEAD_TAGS,
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
          {
            title: 'Post not found',
            description: 'Post not found',
            canonicalUrl,
            image: defaultImage,
            spaHeadTags: SPA_HEAD_TAGS,
          },
        ),
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const post = toPost(mainRow);
    const isGame = !!(post.payload_key || post.swf_key);
    const authorName = post.display_name || post.username;

    // Fetch replies
    const { results: replyRows } = await env.DB.prepare(
      `${POST_SELECT} WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ORDER BY p.created_at ASC LIMIT 50`,
    )
      .bind(id)
      .all<RawPost>();

    const replies = (replyRows || []).map(toPost);

    // Build OG image: use the actual image for image posts, thumbnail for
    // video/audio/game posts, fall back to the default image.
    const gifKey = post.gif_key;
    const isImage = !!gifKey && !gifKey.startsWith('audio/') && !gifKey.startsWith('video/');
    let ogImage: string;
    if (isImage && gifKey) {
      ogImage = assetUrl(baseUrl, gifKey);
    } else if (post.thumbnail_key) {
      ogImage = assetUrl(baseUrl, post.thumbnail_key);
    } else {
      ogImage = defaultImage;
    }

    // Build description: prefer game SEO description for game posts
    let description = post.game_description || post.text.slice(0, 200);
    let jsonLdExtra = '';
    let breadcrumb: Array<{ label: string; url: string }> = [];
    let footerSections: Array<{ title: string; links: Array<{ label: string; url: string }> }> = [];

    if (isGame) {
      const title = buildGameTitle(post.text);
      const typeLabel = detectGameType(post);
      description = buildGameDescription({
        gameDescription: post.game_description,
        title,
        typeLabel,
        authorName,
        text: post.text,
      });
      const gameUrl = `${baseUrl}/arcade/${post.id}`;
      breadcrumb = [
        { label: 'Home', url: `${baseUrl}/home` },
        { label: 'Arcade', url: `${baseUrl}/arcade` },
        { label: title, url: gameUrl },
      ];
      jsonLdExtra = renderBreadcrumbJsonLd(breadcrumb, baseUrl);
      footerSections = [
        {
          title: 'Play this game',
          links: [{ label: title, url: gameUrl }],
        },
      ];
    } else {
      breadcrumb = [
        { label: 'Home', url: `${baseUrl}/home` },
        { label: post.id, url: canonicalUrl },
      ];
      jsonLdExtra = renderBreadcrumbJsonLd(breadcrumb, baseUrl);
    }

    // Build JSON-LD
    const profileUrl = `${baseUrl}/users/${post.username}`;
    const jsonLd = [
      renderBlogPostingJsonLd(post, authorName, profileUrl, canonicalUrl, description, ogImage),
      jsonLdExtra,
    ].join('\n');

    // Build main content
    const mainPostHtml = renderPostArticle(post, baseUrl);
    const repliesHtml =
      replies.length > 0
        ? `<section class="ssr-replies"><h2>${replies.length} Replies</h2>${replies.map((r) => renderPostArticle(r, baseUrl)).join('\n')}</section>`
        : '';

    const header = renderSsrHeader({ baseUrl, breadcrumb });
    const footer = renderSsrFooter({ baseUrl, sections: footerSections });

    const content = `
      ${header}
      ${mainPostHtml}
      ${repliesHtml}
      ${footer}
    `;

    return new Response(
      renderHtmlShell(content, {
        title: `Flaxia - ${authorName}`,
        description,
        canonicalUrl,
        image: ogImage,

        jsonLd,
        additionalHead: renderSsrLayoutCss(),
        spaHeadTags: SPA_HEAD_TAGS,
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
        spaHeadTags: SPA_HEAD_TAGS,
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    );
  }
}
