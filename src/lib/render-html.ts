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
  badge_type?: string | null;
  text: string;
  hashtags: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
  game_description?: string | null;
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
  badge_type?: string | null;
  created_at: string;
}

export interface HtmlShellOptions {
  title: string;
  description: string;
  canonicalUrl: string;
  image?: string;
  twitterCard?: string;
  jsonLd?: string;
  additionalHead?: string;
  spaHeadTags?: string;
}

export function assetUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/api/images/${key}`;
}

export function renderJsonLd(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

export function renderBlogPostingJsonLd(
  post: PostRow,
  authorName: string,
  authorUrl: string,
  postUrl: string,
  description?: string,
  image?: string,
): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: `${authorName} on Flaxia`,
    description: description || post.game_description || post.text.slice(0, 200),
    image: image || undefined,
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
    twitterCard = 'summary_large_image',
    jsonLd,
    additionalHead,
    spaHeadTags,
  } = options;

  const ogImage = image
    ? `<meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">`
    : '';

  const head = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#ffffff">

  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Flaxia">
  ${ogImage}

  <meta name="twitter:card" content="${escapeHtml(twitterCard)}">
  <meta name="twitter:site" content="@flaxia_app">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">

  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${jsonLd ? `\n  ${jsonLd}` : ''}
  ${additionalHead ? `\n  ${additionalHead}` : ''}
  ${spaHeadTags || '<script type="module" src="/src/main.ts"></script>'}

  <script>
    (function () {
      var theme;
      var meta;
      try {
        theme = localStorage.getItem('flaxia_theme');
        if (theme === 'system' || theme === null) {
          theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        if (theme === 'dark' || theme === 'light') {
          document.documentElement.dataset.theme = theme;
          meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.content = theme === 'dark' ? '#0f172a' : '#ffffff';
        }
      } catch (_e) {}
    })();
  </script>

  <link rel="preconnect" href="https://flaxia.app">
  <link rel="dns-prefetch" href="/api">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" media="print" onload="this.media='all';this.onload=null">

  <meta name="google-adsense-account" content="ca-pub-8703789531673358">

  <style>
    :root {
      color-scheme: light;
      --bg-primary:    #ffffff;
      --bg-secondary:  #f0fdf4;
      --bg-input:      #f1f5f9;
      --bg-tertiary:   #f0f0f0;
      --bg-hover:      rgba(0, 0, 0, 0.04);
      --border:        #e2e8f0;
      --text-primary:  #0f172a;
      --text-muted:    #64748b;
      --accent:        #22c55e;
      --accent-dark:   #16a34a;
      --danger:        #ef4444;
      --link:          #3b82f6;
    }
    :root[data-theme='dark'] {
      color-scheme: dark;
      --bg-primary:    #0f172a;
      --bg-secondary:  #1e293b;
      --bg-input:      #1e293b;
      --bg-tertiary:   #1f2937;
      --bg-hover:      rgba(255, 255, 255, 0.06);
      --border:        #334155;
      --text-primary:  #f1f5f9;
      --text-muted:    #94a3b8;
      --accent:        #22c55e;
      --accent-dark:   #16a34a;
      --danger:        #ef4444;
      --link:          #60a5fa;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
    }
    #app {
      display: flex;
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      padding: 0;
    }
    .main-container {
      display: flex;
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
    }
    .left-nav {
      width: 240px; flex-shrink: 0; padding: 1rem;
      border-right: 1px solid var(--border); background: var(--bg-primary);
      position: sticky; top: 0; height: 100vh; overflow-y: auto;
    }
    .main-content {
      flex: 1; max-width: 600px; padding: 1rem;
      border-right: 1px solid var(--border);
    }
    .right-panel {
      width: 350px; flex-shrink: 0; padding: 1rem;
      position: sticky; top: 0; height: 100vh; overflow-y: auto;
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
      border-bottom: 1px solid var(--border);
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
      background: var(--bg-primary);
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
    .ssr-avatar-wrap {
      position: relative;
      display: inline-block;
      line-height: 0;
    }
    .ssr-avatar-badge {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #22c55e;
      color: #ffffff;
      border: 2px solid var(--bg-primary, #ffffff);
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    .ssr-avatar-wrap--large .ssr-avatar-badge {
      width: 22px;
      height: 22px;
      border-width: 3px;
    }
    .ssr-avatar-wrap--mini .ssr-avatar-badge {
      width: 9px;
      height: 9px;
      border-width: 1px;
      right: -1px;
      bottom: -1px;
    }
    .ssr-avatar-wrap--mini .ssr-avatar-badge svg {
      width: 5px;
      height: 5px;
    }
    .ssr-avatar-badge svg {
      width: 9px;
      height: 9px;
      display: block;
    }
    .ssr-avatar-wrap--large .ssr-avatar-badge svg {
      width: 12px;
      height: 12px;
    }
    .ssr-display-name {
      font-weight: 600;
      color: var(--text-primary);
      text-decoration: none;
    }
    .ssr-display-name:hover { text-decoration: underline; }
    .ssr-username {
      color: var(--text-muted);
      font-size: 14px;
    }
    .ssr-post-body {
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 10px;
      word-break: break-word;
    }
    .ssr-post-body p { margin: 0 0 8px 0; }
    .ssr-post-body img,
    .ssr-post-body video {
      width: 100%;
      height: auto;
      border-radius: 8px;
      margin-top: 8px;
      display: block;
    }
    .ssr-post-body video { background: #000; }
    .ssr-post-meta {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .ssr-post-meta time { color: var(--text-muted); }
    .ssr-post-stats { display: flex; gap: 12px; font-size: 13px; color: var(--text-muted); margin-top: 8px; }
    .ssr-replies { margin-top: 24px; }
    .ssr-replies h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .ssr-reply { margin-left: 24px; }
    .ssr-profile-header {
      text-align: center;
      padding: 32px 16px;
      background: var(--bg-primary);
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      margin-bottom: 16px;
    }
    .ssr-profile-header h1 { margin: 12px 0 4px 0; font-size: 22px; }
    .ssr-bio { color: var(--text-muted); font-size: 14px; margin: 8px 0; }
    .ssr-stats {
      display: flex;
      justify-content: center;
      gap: 24px;
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 12px;
    }
    .ssr-stats span { display: inline-block; }
    .ssr-footer {
      text-align: center;
      padding: 24px 0;
      color: var(--text-muted);
      font-size: 13px;
    }
    .ssr-footer a { color: #007bff; text-decoration: none; }
    .ssr-footer a:hover { text-decoration: underline; }
    .ssr-nav {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ssr-nav-link {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 13px;
      color: var(--text-muted);
      text-decoration: none;
    }
    .ssr-nav-link:hover { color: var(--text-primary); background: var(--bg-input); }
    .ssr-nav-link.active {
      color: #fff;
      background: #007bff;
      font-weight: 600;
    }
    .ssr-breadcrumb ol {
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .ssr-breadcrumb li { display: inline-flex; align-items: center; }
    .ssr-breadcrumb li:not(:last-child)::after { content: '›'; margin-left: 6px; color: #bbb; }
    .ssr-breadcrumb a { color: #007bff; text-decoration: none; }
    .ssr-breadcrumb a:hover { text-decoration: underline; }
    .ssr-breadcrumb li[aria-current="page"] { color: var(--text-primary); font-weight: 600; }
    .ssr-footer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 24px;
      max-width: 720px;
      margin: 0 auto 16px;
      text-align: left;
    }
    .ssr-footer-col h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 8px 0;
    }
    .ssr-footer-col ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .ssr-footer-col li { margin-bottom: 4px; }
    .ssr-footer-col a { color: #007bff; text-decoration: none; font-size: 13px; }
    .ssr-footer-col a:hover { text-decoration: underline; }
    .ssr-footer-bottom { margin-top: 8px; }
    .ssr-hashtag { color: #007bff; }
    .ssr-section-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    .ssr-empty { color: var(--text-muted); text-align: center; padding: 32px; }
    @media (max-width: 1024px) {
      .right-panel { display: none; }
      .main-container { max-width: 840px; }
    }
    @media (max-width: 768px) {
      .left-nav { display: none; }
      .main-content { max-width: 100%; border-right: none; }
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="main-container">
      <div class="ssr-container">
        ${content}
      </div>
    </div>
  </div>
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8703789531673358" crossorigin="anonymous"></script>
</body>
</html>`;

  return head;
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
  text?: string,
): string {
  const parts: string[] = [];
  const alt = text ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

  if (gifKey?.startsWith('video/')) {
    const videoUrl = `${baseUrl}/api/video/${escapeHtml(gifKey)}`;
    const poster = thumbnailKey ? ` poster="${escapeHtml(assetUrl(baseUrl, thumbnailKey))}"` : '';
    const mime = gifKey.endsWith('.webm') ? 'video/webm' : gifKey.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const label = escapeHtml(alt || 'Post video');
    parts.push(
      `<video controls preload="metadata" playsinline width="640" height="360"${poster}>\n    <source src="${videoUrl}" type="${mime}">\n    ${label}\n  </video>`,
    );
  } else if (gifKey && !gifKey.startsWith('audio/')) {
    parts.push(
      `<img src="${escapeHtml(assetUrl(baseUrl, gifKey))}" alt="${escapeHtml(alt || 'Post image')}" width="1200" height="675" loading="lazy">`,
    );
  } else if (thumbnailKey) {
    parts.push(
      `<img src="${escapeHtml(assetUrl(baseUrl, thumbnailKey))}" alt="${escapeHtml(alt || 'Post thumbnail')}" width="800" height="600" loading="lazy">`,
    );
  }
  if (payloadKey || swfKey) {
    parts.push(`<p>🎮 Interactive content available</p>`);
  }
  return parts.join('\n    ');
}

export function renderAvatarBadge(badgeType?: string | null): string {
  if (badgeType !== 'flaxia_plus') return '';
  return `<span class="ssr-avatar-badge" title="Flaxia+" aria-label="Flaxia+"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></span>`;
}

export function renderPostArticle(post: PostRow, baseUrl: string, isReply = false): string {
  const postUrl = `${baseUrl}/thread/${post.id}`;
  const profileUrl = `${baseUrl}/users/${post.username}`;
  const avatarSrc = post.avatar_key ? assetUrl(baseUrl, post.avatar_key) : `${baseUrl}/default-avatar.png`;

  const replyClass = isReply ? ' ssr-reply' : '';

  return `<article class="ssr-post${replyClass}">
    <div class="ssr-post-header">
      <a href="${escapeHtml(profileUrl)}">
        <span class="ssr-avatar-wrap"><img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(post.display_name || post.username)}" class="ssr-avatar" width="40" height="40">${renderAvatarBadge(post.badge_type)}</span>
      </a>
      <div>
        <a href="${escapeHtml(profileUrl)}" class="ssr-display-name">${escapeHtml(post.display_name || post.username)}</a>
        <div class="ssr-username">@${escapeHtml(post.username)}</div>
      </div>
    </div>
    <div class="ssr-post-body">
      ${renderPostContent(post.text, post.hashtags)}
      ${renderPostMedia(post.gif_key, post.thumbnail_key, post.payload_key, post.swf_key, baseUrl, post.text)}
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
    <span class="ssr-avatar-wrap ssr-avatar-wrap--large"><img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(user.display_name)}" class="ssr-avatar-large" width="72" height="72">${renderAvatarBadge(user.badge_type)}</span>
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
