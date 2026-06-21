export interface OgHtmlOptions {
  title: string;
  description: string;
  image: string;
  url: string;
  twitterCard?: string;
}

export function renderOgHtml(options: OgHtmlOptions, baseUrl: string): string {
  const { title, description, image, url, twitterCard = 'summary_large_image' } = options;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  
  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Flaxia">
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="${escapeHtml(twitterCard)}">
  <meta name="twitter:site" content="@flaxia_app">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  
  <!-- Basic meta -->
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(url)}">
  
  <!-- Basic styling -->
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 600px;
      margin: 20px;
      overflow: hidden;
    }
    .image {
      width: 100%;
      height: 300px;
      object-fit: cover;
      background: #e9ecef;
    }
    .content {
      padding: 24px;
    }
    .title {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 12px 0;
      color: #1a1a1a;
    }
    .description {
      font-size: 16px;
      line-height: 1.5;
      color: #666;
      margin: 0;
    }
    .footer {
      padding: 16px 24px;
      background: #f8f9fa;
      font-size: 14px;
      color: #666;
    }
    .footer a {
      color: #007bff;
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="card">
    <img class="image" src="${escapeHtml(image)}" alt="${escapeHtml(title)}" onerror="this.style.background='#e9ecef'">
    <div class="content">
      <h1 class="title">${escapeHtml(title)}</h1>
      <p class="description">${escapeHtml(description)}</p>
    </div>
    <div class="footer">
      <a href="${escapeHtml(baseUrl)}" target="_blank">Flaxia</a> でこの投稿を見る
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
