export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PostRow {
  id: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  text: string;
  hashtags: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
  fresh_count: number;
  bookmark_count: number;
  reply_count: number;
  impressions: number;
  parent_id: string | null;
  root_id: string | null;
  depth: number;
  status: string;
  hidden: number;
  created_at: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_key: string | null;
  created_at: string;
}

export interface HtmlShellOptions {
  title: string;
  description: string;
  canonicalUrl: string;
  image?: string;
  type?: string;
  twitterCard?: string;
  jsonLd?: string;
  additionalHead?: string;
}

export function assetUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/api/images/${key}`;
}

export function renderJsonLd(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

export function renderBlogPostingJsonLd(post: PostRow, authorName: string, authorUrl: string, postUrl: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: `${authorName} on Flaxia`,
    description: post.text.slice(0, 200),
    url: postUrl,
    datePublished: post.created_at,
    author: {
      '@type': 'Person',
      name: authorName,
      url: authorUrl,
    },
  });
}

export function renderPersonJsonLd(user: UserRow, profileUrl: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: user.display_name,
    alternateName: `@${user.username}`,
    description: user.bio ? user.bio.slice(0, 200) : undefined,
    url: profileUrl,
  });
}

export function renderWebSiteJsonLd(siteName: string, url: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url,
  });
}

export function renderHtmlShell(content: string, options: HtmlShellOptions): string {
  const {
    title,
    description,
    canonicalUrl,
    image,
    type = 'website',
    twitterCard = 'summary_large_image',
    jsonLd,
    additionalHead,
  } = options;

  const ogImage = image
    ? `<meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">

  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="${escapeHtml(type)}">
  <meta property="og:site_name" content="Flaxia">
  ${ogImage}

  <meta name="twitter:card" content="${escapeHtml(twitterCard)}">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">

  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${jsonLd ? `\n  ${jsonLd}` : ''}
  ${additionalHead ? `\n  ${additionalHead}` : ''}

  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', sans-serif;
      background: #f8f9fa;
      color: #1a1a1a;
      line-height: 1.5;
    }
    .ssr-container {
      max-width: 640px;
      margin: 0 auto;
      padding: 16px;
    }
    .ssr-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid #e0e0e0;
      margin-bottom: 16px;
    }
    .ssr-logo {
      font-size: 20px;
      font-weight: 700;
      color: #007bff;
      text-decoration: none;
    }
    .ssr-logo:hover { text-decoration: underline; }
    .ssr-post {
      background: white;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .ssr-post-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .ssr-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      background: #e9ecef;
    }
    .ssr-avatar-large {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      object-fit: cover;
      background: #e9ecef;
    }
    .ssr-display-name {
      font-weight: 600;
      color: #1a1a1a;
      text-decoration: none;
    }
    .ssr-display-name:hover { text-decoration: underline; }
    .ssr-username {
      color: #666;
      font-size: 14px;
    }
    .ssr-post-body {
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 10px;
      word-break: break-word;
    }
    .ssr-post-body p { margin: 0 0 8px 0; }
    .ssr-post-body img {
      max-width: 100%;
      border-radius: 8px;
      margin-top: 8px;
    }
    .ssr-post-meta {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: #888;
    }
    .ssr-post-meta time { color: #888; }
    .ssr-post-stats { display: flex; gap: 12px; font-size: 13px; color: #888; margin-top: 8px; }
    .ssr-replies { margin-top: 24px; }
    .ssr-replies h2 {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      border-bottom: 1px solid #e0e0e0;
      padding-bottom: 8px;
    }
    .ssr-reply { margin-left: 24px; }
    .ssr-profile-header {
      text-align: center;
      padding: 32px 16px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      margin-bottom: 16px;
    }
    .ssr-profile-header h1 { margin: 12px 0 4px 0; font-size: 22px; }
    .ssr-bio { color: #555; font-size: 14px; margin: 8px 0; }
    .ssr-stats {
      display: flex;
      justify-content: center;
      gap: 24px;
      font-size: 14px;
      color: #666;
      margin-top: 12px;
    }
    .ssr-stats span { display: inline-block; }
    .ssr-footer {
      text-align: center;
      padding: 24px 0;
      color: #888;
      font-size: 13px;
    }
    .ssr-footer a { color: #007bff; text-decoration: none; }
    .ssr-footer a:hover { text-decoration: underline; }
    .ssr-hashtag { color: #007bff; }
    .ssr-section-title {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      border-bottom: 1px solid #e0e0e0;
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    .ssr-empty { color: #888; text-align: center; padding: 32px; }
  </style>
</head>
<body>
  <div class="ssr-container">
    ${content}
  </div>
</body>
</html>`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function renderPostContent(text: string, hashtags: string): string {
  let html = escapeHtml(text);

  // Link hashtags
  html = html.replace(/#([\w\u3000-\u9fff\-_]+)/g, (_m, tag: string) => {
    const encoded = encodeURIComponent(tag);
    return `<a href="/explore?tag=${encoded}" class="ssr-hashtag">#${escapeHtml(tag)}</a>`;
  });

  return `<p>${html.replace(/\n/g, '<br>')}</p>`;
}

function renderPostMedia(
  gifKey: string | null,
  thumbnailKey: string | null,
  payloadKey: string | null,
  swfKey: string | null,
  baseUrl: string,
): string {
  const parts: string[] = [];
  if (gifKey && !gifKey.startsWith('audio/')) {
    parts.push(`<img src="${escapeHtml(assetUrl(baseUrl, gifKey))}" alt="Post image" loading="lazy">`);
  } else if (thumbnailKey) {
    parts.push(`<img src="${escapeHtml(assetUrl(baseUrl, thumbnailKey))}" alt="Post thumbnail" loading="lazy">`);
  }
  if (payloadKey || swfKey) {
    parts.push(`<p>🎮 Interactive content available</p>`);
  }
  return parts.join('\n    ');
}

export function renderPostArticle(post: PostRow, baseUrl: string, isReply = false): string {
  const postUrl = `${baseUrl}/thread/${post.id}`;
  const profileUrl = `${baseUrl}/users/${post.username}`;
  const avatarSrc = post.avatar_key ? assetUrl(baseUrl, post.avatar_key) : `${baseUrl}/default-avatar.png`;

  const replyClass = isReply ? ' ssr-reply' : '';

  return `<article class="ssr-post${replyClass}">
    <div class="ssr-post-header">
      <a href="${escapeHtml(profileUrl)}">
        <img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(post.display_name || post.username)}" class="ssr-avatar" width="40" height="40">
      </a>
      <div>
        <a href="${escapeHtml(profileUrl)}" class="ssr-display-name">${escapeHtml(post.display_name || post.username)}</a>
        <div class="ssr-username">@${escapeHtml(post.username)}</div>
      </div>
    </div>
    <div class="ssr-post-body">
      ${renderPostContent(post.text, post.hashtags)}
      ${renderPostMedia(post.gif_key, post.thumbnail_key, post.payload_key, post.swf_key, baseUrl)}
    </div>
    <div class="ssr-post-meta">
      <time datetime="${escapeHtml(post.created_at)}">${formatDate(post.created_at)}</time>
      <a href="${escapeHtml(postUrl)}">View post</a>
    </div>
    <div class="ssr-post-stats">
      <span>❤️ ${post.fresh_count}</span>
      <span>💬 ${post.reply_count}</span>
      <span>🔖 ${post.bookmark_count}</span>
    </div>
  </article>`;
}

export function renderPostList(posts: PostRow[], baseUrl: string): string {
  if (posts.length === 0) {
    return '<div class="ssr-empty">No posts yet.</div>';
  }
  return posts.map((p) => renderPostArticle(p, baseUrl)).join('\n');
}

export function renderProfileHeader(user: UserRow, baseUrl: string, postCount: number, followerCount: number): string {
  const avatarSrc = user.avatar_key ? assetUrl(baseUrl, user.avatar_key) : `${baseUrl}/default-avatar.png`;

  return `<header class="ssr-profile-header">
    <img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(user.display_name)}" class="ssr-avatar-large" width="72" height="72">
    <h1>${escapeHtml(user.display_name)}</h1>
    <div class="ssr-username">@${escapeHtml(user.username)}</div>
    ${user.bio ? `<p class="ssr-bio">${escapeHtml(user.bio)}</p>` : ''}
    <div class="ssr-stats">
      <span>📝 ${postCount} posts</span>
      <span>👥 ${followerCount} followers</span>
    </div>
    <div class="ssr-post-meta" style="margin-top:8px;justify-content:center">
      Joined <time datetime="${escapeHtml(user.created_at)}">${formatDate(user.created_at)}</time>
    </div>
  </header>`;
}
