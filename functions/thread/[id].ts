import { isCrawler } from '../../src/lib/is-crawler';
import { renderOgHtml } from '../../src/lib/og-html';

const assetUrl = (baseUrl: string, key: string) => `${baseUrl}/api/images/${key}`;

type Env = {
  DB: D1Database;
  BASE_URL?: string;
};

export async function onRequest(context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const { request, env, next } = context;
  const userAgent = request.headers.get('user-agent') || '';
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  const defaultImage = `${baseUrl}/og-default-v2.png`;

  if (!isCrawler(userAgent)) {
    return next();
  }

  const url = new URL(request.url);
  const id = url.pathname.split('/')[2];

  if (!id) {
    return new Response(
      renderOgHtml(
        {
          title: 'Post not found',
          description: 'Post not found',
          image: defaultImage,
          url: `${baseUrl}/thread/`,
          type: 'article',
          twitterCard: 'summary_large_image',
        },
        baseUrl,
      ),
      {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      },
    );
  }

  try {
    const stmt = env.DB.prepare(`
      SELECT posts.*, users.display_name, users.username
      FROM posts
      JOIN users ON posts.user_id = users.id
      WHERE posts.id = ?
    `);
    const result: Record<string, unknown> | null = (await stmt.bind(id).first()) as Record<string, unknown> | null;

    if (!result) {
      return new Response(
        renderOgHtml(
          {
            title: 'Post not found',
            description: 'Post not found',
            image: defaultImage,
            url: `${baseUrl}/thread/${id}`,
            type: 'article',
            twitterCard: 'summary_large_image',
          },
          baseUrl,
        ),
        {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        },
      );
    }

    const gifKey = String(result.gif_key || '');
    const isImage = result.gif_key && !gifKey.startsWith('audio/');
    const image = isImage
      ? assetUrl(baseUrl, gifKey)
      : result.thumbnail_key
        ? assetUrl(baseUrl, String(result.thumbnail_key))
        : defaultImage;

    const hasGame = result.payload_key || result.swf_key;
    const playerUrl = hasGame ? `${baseUrl}/api/ogp-player/${id}` : undefined;
    const twitterCard = hasGame ? 'player' : 'summary_large_image';

    return new Response(
      renderOgHtml(
        {
          title: String(result.display_name),
          description: String(result.text),
          image,
          url: `${baseUrl}/thread/${id}`,
          type: 'article',
          twitterCard,
          playerUrl,
        },
        baseUrl,
      ),
      {
        headers: { 'Content-Type': 'text/html' },
      },
    );
  } catch (error) {
    console.error('OGP fetch error:', error);
    return new Response(
      renderOgHtml(
        {
          title: 'Post not found',
          description: 'Post not found',
          image: defaultImage,
          url: `${baseUrl}/thread/${id}`,
          type: 'article',
          twitterCard: 'summary_large_image',
        },
        baseUrl,
      ),
      {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      },
    );
  }
}
