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

  // OGP for root path
  return new Response(
    renderOgHtml(
      {
        title: 'Flaxia - クリエイティブな投稿プラットフォーム',
        description:
          'Flaxiaは、クリエイティブな投稿を共有できるプラットフォームです。テキスト、画像、音声、ZIPファイルなど、様々な形式のコンテンツを投稿して、コミュニティと繋がりましょう。',
        image: defaultImage,
        url: baseUrl,
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
