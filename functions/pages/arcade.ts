import { escapeHtml, renderHtmlShell, renderJsonLd } from '../../src/lib/render-html';

type Env = {
  DB: D1Database;
  BASE_URL?: string;
};

type RawGame = Record<string, unknown>;

interface GameRow {
  id: string;
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
  created_at: string;
}

function toGame(row: RawGame): GameRow {
  return {
    id: String(row.id),
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
    created_at: String(row.created_at),
  };
}

function detectGameType(game: GameRow): string {
  if (game.swf_key) return 'flash';
  if (game.payload_key?.startsWith('dos/')) return 'dos';
  if (game.payload_key) return 'zip';
  return 'html5';
}

function getGameTitle(game: GameRow): string {
  const firstLine = game.text.split('\n')[0].trim();
  return firstLine || 'Untitled Game';
}

function assetUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/api/images/${key}`;
}

function renderGameCard(game: GameRow, baseUrl: string): string {
  const gameUrl = `${baseUrl}/arcade/${game.id}`;
  const profileUrl = `${baseUrl}/users/${game.username}`;
  const thumbnailSrc = game.thumbnail_key
    ? assetUrl(baseUrl, game.thumbnail_key)
    : game.gif_key && !game.gif_key.startsWith('audio/')
      ? assetUrl(baseUrl, game.gif_key)
      : `${baseUrl}/og-default-v2.png`;
  const avatarSrc = game.avatar_key ? assetUrl(baseUrl, game.avatar_key) : `${baseUrl}/default-avatar.png`;
  const gameType = detectGameType(game);
  const title = getGameTitle(game);

  const typeLabels: Record<string, string> = {
    flash: 'Flash',
    dos: 'DOS',
    zip: 'ZIP',
    html5: 'HTML5',
  };

  return `
    <a href="${escapeHtml(gameUrl)}" class="ssr-game-card">
      <div class="ssr-game-thumbnail">
        <img src="${escapeHtml(thumbnailSrc)}" alt="${escapeHtml(title)}" loading="lazy">
        <span class="ssr-game-type-badge">${typeLabels[gameType] || 'Game'}</span>
      </div>
      <div class="ssr-game-info">
        <div class="ssr-game-title">${escapeHtml(title)}</div>
        <div class="ssr-game-author">
          <img src="${escapeHtml(avatarSrc)}" alt="" class="ssr-mini-avatar" width="18" height="18">
          <span>${escapeHtml(game.display_name || game.username)}</span>
        </div>
        <div class="ssr-game-stats">
          <span>❤️ ${game.fresh_count}</span>
          <span>💬 ${game.reply_count}</span>
        </div>
      </div>
    </a>`;
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { env } = context;
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  const canonicalUrl = `${baseUrl}/arcade`;
  const defaultImage = `${baseUrl}/og-default-v2.png`;

  try {
    let games: GameRow[] = [];
    if (env.DB) {
      const { results } = await env.DB.prepare(`
        SELECT p.id, p.username, u.display_name, u.avatar_key,
          p.text, p.payload_key, p.swf_key, p.thumbnail_key, p.gif_key,
          p.fresh_count, COALESCE(p.reply_count, 0) as reply_count, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL)
          AND p.status = 'published'
          AND p.hidden = 0
          AND p.parent_id IS NULL
        ORDER BY p.created_at DESC
        LIMIT 50
      `).all<RawGame>();
      games = (results || []).map(toGame);
    }

    const jsonLd = renderJsonLd({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Flaxia Arcade',
      description:
        'ゲームやアプリをそのまま投稿できるSNS、Flaxiaのアーケード。Flash、DOS、ZIP、HTML5ゲームをブラウザで遊べます。',
      url: canonicalUrl,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: games.map((g, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${baseUrl}/arcade/${g.id}`,
        })),
      },
    });

    const gameCards = games.length
      ? `<div class="ssr-game-grid">${games.map((g) => renderGameCard(g, baseUrl)).join('\n')}</div>`
      : '<div class="ssr-empty">No games yet. Be the first to post a game!</div>';

    const content = `
      <header class="ssr-header">
        <a href="${baseUrl}" class="ssr-logo">Flaxia</a>
        <a href="${baseUrl}/explore" style="color:#007bff;text-decoration:none;font-size:14px">Explore</a>
      </header>
      <main>
        <h1 style="font-size:22px;font-weight:700;margin:0 0 4px 0;color:#1a1a1a">Flaxia Arcade</h1>
        <p style="font-size:14px;color:#666;margin:0 0 20px 0">投稿されたゲームで遊ぼう — スワイプして次のゲームへ</p>
        ${gameCards}
      </main>
      <footer class="ssr-footer">
        <a href="${baseUrl}">Home</a> · <a href="${baseUrl}/explore">Explore</a> · <a href="${baseUrl}/about">About</a>
      </footer>
    `;

    const additionalHead = `
    <style>
      .ssr-game-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 16px;
      }
      .ssr-game-card {
        display: block;
        background: white;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        text-decoration: none;
        color: inherit;
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .ssr-game-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      }
      .ssr-game-thumbnail {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 10;
        background: #e9ecef;
        overflow: hidden;
      }
      .ssr-game-thumbnail img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .ssr-game-type-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(0,0,0,0.65);
        color: white;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 4px;
        letter-spacing: 0.3px;
      }
      .ssr-game-info {
        padding: 10px 12px 12px;
      }
      .ssr-game-title {
        font-size: 14px;
        font-weight: 600;
        color: #1a1a1a;
        margin-bottom: 6px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ssr-game-author {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #666;
        margin-bottom: 6px;
      }
      .ssr-mini-avatar {
        border-radius: 50%;
        object-fit: cover;
        background: #e9ecef;
      }
      .ssr-game-stats {
        display: flex;
        gap: 12px;
        font-size: 12px;
        color: #888;
      }
      @media (max-width: 640px) {
        .ssr-game-grid {
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }
      }
    </style>`;

    return new Response(
      renderHtmlShell(content, {
        title: 'Flaxia Arcade - ゲームを遊べるSNS',
        description:
          'Flaxia Arcadeで、コミュニティが投稿したFlash、DOS、ZIP、HTML5ゲームをブラウザで直接遊ぼう。スワイプしてどんどん新しいゲームを発見。',
        canonicalUrl,
        image: defaultImage,
        jsonLd,
        additionalHead,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  } catch (error) {
    console.error('SSR arcade error:', error);
    return new Response(
      renderHtmlShell(`<p>Failed to load arcade page.</p>`, {
        title: 'Flaxia Arcade',
        description: 'Play games on Flaxia',
        canonicalUrl,
        image: defaultImage,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }
}
