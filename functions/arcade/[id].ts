import { escapeHtml, renderHtmlShell, renderJsonLd } from '../../src/lib/render-html';

type Env = {
  DB: D1Database;
  BASE_URL?: string;
  SANDBOX_ORIGIN?: string;
};

type RawPost = Record<string, unknown>;

interface PostRow {
  id: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  text: string;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
  gif_key: string | null;
  fresh_count: number;
  reply_count: number;
  bookmark_count: number;
  created_at: string;
}

const assetUrl = (baseUrl: string, key: string) => `${baseUrl}/api/images/${key}`;

function toPost(row: RawPost): PostRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    username: String(row.username),
    display_name: row.display_name ? String(row.display_name) : null,
    avatar_key: row.avatar_key ? String(row.avatar_key) : null,
    text: String(row.text),
    payload_key: row.payload_key ? String(row.payload_key) : null,
    swf_key: row.swf_key ? String(row.swf_key) : null,
    thumbnail_key: row.thumbnail_key ? String(row.thumbnail_key) : null,
    gif_key: row.gif_key ? String(row.gif_key) : null,
    fresh_count: Number(row.fresh_count),
    reply_count: Number(row.reply_count),
    bookmark_count: Number(row.bookmark_count),
    created_at: String(row.created_at),
  };
}

function detectGameType(post: PostRow): string {
  if (post.swf_key) return 'flash';
  if (post.payload_key?.startsWith('dos/')) return 'dos';
  if (post.payload_key) return 'zip';
  return 'html5';
}

function getGameTitle(post: PostRow): string {
  const firstLine = post.text.split('\n')[0].trim();
  return firstLine || 'Untitled Game';
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

export async function onRequest(context: { request: Request; env: Env; params: { id: string } }): Promise<Response> {
  const { env, params } = context;
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  const sandboxOrigin = env.SANDBOX_ORIGIN ?? 'https://sandbox.flaxia.app';
  const defaultImage = `${baseUrl}/og-default-v2.png`;

  const gameId = params.id;
  const canonicalUrl = `${baseUrl}/arcade/${gameId || ''}`;

  if (!gameId) {
    return new Response(
      renderHtmlShell(`<div class="ssr-empty"><h1>Game not found</h1></div>`, {
        title: 'Game not found',
        description: 'Game not found',
        canonicalUrl,
        image: defaultImage,
      }),
      { status: 404, headers: { 'Content-Type': 'text/html' } },
    );
  }

  try {
    const mainRow = (await env.DB.prepare(`
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key,
        p.text, p.payload_key, p.swf_key, p.thumbnail_key, p.gif_key,
        p.fresh_count, COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.bookmark_count, 0) as bookmark_count,
        p.created_at
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0
        AND (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL)
    `)
      .bind(gameId)
      .first()) as RawPost | null;

    if (!mainRow) {
      return new Response(
        renderHtmlShell(
          `<div class="ssr-empty"><h1>Game not found</h1><p>This game does not exist or has been removed.</p></div>`,
          {
            title: 'Game not found',
            description: 'Game not found',
            canonicalUrl,
            image: defaultImage,
          },
        ),
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const post = toPost(mainRow);
    const title = getGameTitle(post);
    const gameType = detectGameType(post);
    const typeLabels: Record<string, string> = { flash: 'Flash', dos: 'DOS', zip: 'ZIP', html5: 'HTML5' };

    // Build OG image
    const ogImage = post.thumbnail_key
      ? assetUrl(baseUrl, post.thumbnail_key)
      : post.gif_key && !post.gif_key.startsWith('audio/')
        ? assetUrl(baseUrl, post.gif_key)
        : defaultImage;

    const additionalHead = `
    <style>
      .ssr-game-detail { max-width: 600px; margin: 0 auto; }
      .ssr-game-embed {
        width: 100%;
        aspect-ratio: 16 / 10;
        background: #000;
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 16px;
      }
      .ssr-game-embed iframe {
        width: 100%;
        height: 100%;
        border: none;
      }
      .ssr-game-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .ssr-game-author-img {
        width: 40px; height: 40px; border-radius: 50%; object-fit: cover;
        background: #e9ecef;
      }
      .ssr-game-author-name { font-weight: 600; color: #1a1a1a; text-decoration: none; }
      .ssr-game-author-name:hover { text-decoration: underline; }
      .ssr-game-username { font-size: 13px; color: #888; }
      .ssr-game-stats { display: flex; gap: 16px; font-size: 14px; color: #888; margin-bottom: 16px; }
      .ssr-game-text {
        font-size: 15px;
        line-height: 1.6;
        color: #333;
        white-space: pre-wrap;
        word-break: break-word;
        margin-bottom: 16px;
      }
      .ssr-game-play-btn {
        display: inline-block;
        background: #007bff;
        color: white;
        text-decoration: none;
        padding: 10px 24px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 15px;
      }
      .ssr-game-play-btn:hover { background: #0056b3; }
    </style>`;

    const description = post.text.slice(0, 200);
    const profileUrl = `${baseUrl}/users/${post.username}`;
    const avatarSrc = post.avatar_key ? assetUrl(baseUrl, post.avatar_key) : `${baseUrl}/default-avatar.png`;

    const jsonLd = renderJsonLd({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: `${title} - ${post.display_name || post.username} on Flaxia`,
      description,
      url: canonicalUrl,
      image: ogImage,
      datePublished: post.created_at,
      author: {
        '@type': 'Person',
        name: post.display_name || post.username,
        url: profileUrl,
      },
    });

    const content = `
      <div class="ssr-game-detail">
        <header class="ssr-header">
          <a href="${escapeHtml(baseUrl)}" class="ssr-logo">Flaxia</a>
          <a href="${escapeHtml(baseUrl)}/arcade" style="color:#007bff;text-decoration:none;font-size:14px">← Arcade</a>
        </header>
        <main>
          <div class="ssr-game-embed">
            <iframe src="${escapeHtml(baseUrl)}/api/ogp-player/${gameId}"
              sandbox="allow-scripts allow-pointer-lock allow-fullscreen allow-same-origin"
              allow="fullscreen"
              referrerpolicy="no-referrer"
              title="${escapeHtml(title)}"></iframe>
          </div>
          <h1 style="font-size:20px;font-weight:700;margin:0 0 12px 0;color:#1a1a1a">${escapeHtml(title)}</h1>
          <div class="ssr-game-meta">
            <a href="${escapeHtml(profileUrl)}">
              <img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(post.display_name || post.username)}" class="ssr-game-author-img">
            </a>
            <div>
              <a href="${escapeHtml(profileUrl)}" class="ssr-game-author-name">${escapeHtml(post.display_name || post.username)}</a>
              <div class="ssr-game-username">@${escapeHtml(post.username)}</div>
            </div>
          </div>
          <div class="ssr-game-stats">
            <span>❤️ ${post.fresh_count}</span>
            <span>💬 ${post.reply_count}</span>
            <span>🔖 ${post.bookmark_count}</span>
            <span>🏷️ ${typeLabels[gameType] || 'Game'}</span>
            <span>📅 ${formatDate(post.created_at)}</span>
          </div>
          <div class="ssr-game-text">${escapeHtml(post.text)}</div>
          <a href="${escapeHtml(canonicalUrl)}" class="ssr-game-play-btn">Play this game</a>
        </main>
        <footer class="ssr-footer">
          <a href="${escapeHtml(baseUrl)}/arcade">← Back to Arcade</a>
        </footer>
      </div>`;

    return new Response(
      renderHtmlShell(content, {
        title: `Flaxia Arcade - ${title}`,
        description,
        canonicalUrl,
        image: ogImage,

        jsonLd,
        additionalHead,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  } catch (error) {
    console.error('SSR arcade game error:', error);
    return new Response(
      renderHtmlShell(`<div class="ssr-empty"><h1>Error</h1><p>Failed to load this game.</p></div>`, {
        title: 'Error',
        description: 'Failed to load game',
        canonicalUrl,
        image: defaultImage,
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    );
  }
}
