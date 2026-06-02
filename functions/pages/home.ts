import { isCrawler } from '../../src/lib/is-crawler';
import { renderOgHtml } from '../../src/lib/og-html';

type Env = {
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

  // OGP for /home path
  return new Response(
    renderOgHtml(
      {
        title: 'Flaxia - ホーム',
        description:
          'Flaxiaのホームページ。最新の投稿や、コミュニティの活動をチェックして、新しいクリエイティブなコンテンツを発見しましょう。',
        image: defaultImage,
        url: `${baseUrl}/home`,
        type: 'website',
        twitterCard: 'summary_large_image',
      },
      baseUrl,
    ),
    {
      headers: { 'Content-Type': 'text/html' },
    },
  );
}
