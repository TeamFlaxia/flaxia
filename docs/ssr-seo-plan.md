# SSR SEO Implementation Plan

## Overview

Flaxia is a vanilla TypeScript SPA with server-side Hono API on Cloudflare Pages.
The goal is to serve rich, semantic HTML to search engine crawlers (Googlebot, Twitterbot, etc.)
while keeping the SPA experience for real users.

## Architecture

```
Browser/Crawler → Cloudflare Pages
  ├── Crawler (isCrawler UA check) → Pages Function queries D1 → Returns full HTML with JSON-LD
  └── Browser (not crawler)        → next() → SPA (dist/index.html)
```

## Principle

- We use the existing `isCrawler(userAgent)` check in Pages Functions
- Crawlers get a complete HTML document with:
  - Semantic HTML5 elements (`<article>`, `<header>`, `<main>`, `<section>`)
  - Open Graph / Twitter Card meta tags
  - JSON-LD structured data (Schema.org)
  - Actual content visible in HTML (posts, profiles, timelines)
  - Links to other pages for crawler discovery
- Real users always get the SPA via `next()`

## Files to Create

### 1. `src/lib/render-html.ts` — Shared HTML rendering utilities

Core utilities used by all SSR Pages Functions.

**Exports:**
- `escapeHtml(text: string): string` — HTML-escape text (moved from `og-html.ts`)
- `renderHtmlShell(title, description, canonicalUrl, content, options?): string` — complete HTML5 document shell
- `renderJsonLd(data: object): string` — wraps JSON in `<script type="application/ld+json">`
- `renderBlogPostingJsonLd(post, author, url): string` — Schema.org BlogPosting
- `renderPersonJsonLd(user, url): string` — Schema.org Person
- `renderWebSiteJsonLd(siteName, url): string` — Schema.org WebSite
- `renderPostArticle(post): string` — renders a post as `<article>` HTML block
- `renderPostList(posts): string` — renders list of `<article>` blocks
- `renderProfileHeader(user): string` — renders user profile header
- `assetUrl(baseUrl, key): string` — builds R2 asset URL

### 2. `src/lib/is-crawler.ts` — Already exists, no changes needed

## Files to Modify

### 3. `functions/thread/[id].ts` — Post thread SSR

**Changes:**
- Import `renderHtmlShell`, `renderBlogPostingJsonLd`, `renderPostArticle`, `renderPostList`, `escapeHtml` from shared module
- After D1 query for the post, also query replies
- Build richer HTML with:
  - Main post as `<article>` with full content, author, timestamp, stats
  - Replies listed below as `<article>` elements
  - JSON-LD BlogPosting structured data
  - OG/Twitter tags (keep existing)
  - Canonical URL
  - Link to author profile for crawler discovery

### 4. `functions/users/[username].ts` — User profile SSR

**Changes:**
- Import `isCrawler`, `renderHtmlShell`, `renderPersonJsonLd`, `renderProfileHeader`, `renderPostList`, `escapeHtml`
- In the `GET /` handler, check `isCrawler(userAgent)` before the ActivityPub/browser redirect logic
- If crawler:
  - Query user info (already done) + recent posts (new query)
  - Render full HTML with profile header + post list
  - Include JSON-LD Person structured data
- If not crawler: fall through to existing logic (ActivityPub or browser redirect)

### 5. `functions/pages/_index.ts` — Root page SSR

**Changes:**
- Import shared render utilities
- Query recent 20 public posts from D1 (`WHERE status='published' AND hidden=0 AND parent_id IS NULL ORDER BY created_at DESC LIMIT 20`)
- Render full HTML with site title, post feed, JSON-LD WebSite
- Keep existing crawler check pattern

### 6. `functions/pages/home.ts` — Home page SSR

**Changes:**
- Same as `_index.ts` (mirror the timeline rendering)

## HTML Structure Examples

### Thread Page
```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Post by @username | Flaxia</title>
  <meta name="description" content="post text...">
  <meta property="og:title" content="...">
  <!-- ... other OG/Twitter tags ... -->
  <link rel="canonical" href="https://flaxia.app/thread/:id">
  <script type="application/ld+json">{ " @context": "https://schema.org", "@type": "BlogPosting", ... }</script>
  <link rel="stylesheet" href="/src/styles/main.css">
</head>
<body>
  <div class="ssr-container">
    <header class="ssr-header">
      <a href="/" class="ssr-logo">Flaxia</a>
    </header>
    <main class="ssr-main">
      <article class="ssr-post">
        <div class="ssr-post-header">
          <img src="..." alt="" class="ssr-avatar" width="40" height="40">
          <div>
            <span class="ssr-display-name">Display Name</span>
            <span class="ssr-username">@username</span>
          </div>
        </div>
        <div class="ssr-post-body">
          <p>post text with hashtags...</p>
        </div>
        <div class="ssr-post-meta">
          <time datetime="...">2024-01-01</time>
          <span>❤️ N freshes</span>
          <span>💬 N replies</span>
        </div>
      </article>
      <section class="ssr-replies">
        <h2>Replies</h2>
        ...reply articles...
      </section>
    </main>
    <footer class="ssr-footer">
      <a href="/">Back to Flaxia</a>
    </footer>
  </div>
</body>
</html>
```

### Profile Page
```html
<!DOCTYPE html>
<html lang="ja">
<head>
  ...
  <script type="application/ld+json">{ "@type": "Person", "name": "Display Name", ... }</script>
</head>
<body>
  <div class="ssr-container">
    <header class="ssr-profile-header">
      <img src="avatar_url" alt="" class="ssr-avatar-large">
      <h1>Display Name</h1>
      <p class="ssr-username">@username</p>
      <p class="ssr-bio">bio text...</p>
      <div class="ssr-stats">
        <span>N posts</span>
        <span>N followers</span>
      </div>
    </header>
    <main>
      <h2>Posts</h2>
      ...post articles...
    </main>
  </div>
</body>
</html>
```

### Timeline Page
```html
<!DOCTYPE html>
<html lang="ja">
<head>
  ...
  <script type="application/ld+json">{ "@type": "WebSite", ... }</script>
</head>
<body>
  <div class="ssr-container">
    <header><h1>Flaxia</h1></header>
    <main>
      <h2>Latest Posts</h2>
      ...post articles...
    </main>
    <footer><a href="/explore">Explore</a></footer>
  </div>
</body>
</html>
```

## CSS

The SSR pages need minimal styling to look presentable in search engine previews
and for text-based browsers. A small inline `<style>` block covers:
- `.ssr-container` — centered max-width container
- `.ssr-post` — card-like post display
- `.ssr-avatar` — circular avatar
- `.ssr-post-body` — text content
- `.ssr-post-meta` — timestamp and stats
- `.ssr-profile-header` — profile header layout
- `.ssr-replies` — reply section

These styles are NOT part of the SPA styles to avoid conflicts. They're prefixed with `ssr-`.

## Testing

```bash
pnpm build  # Vite build for SPA
pnpm test   # Run existing tests
```

Manual testing:
- Set browser user-agent to "Googlebot" to verify SSR is served
- Visit `/thread/:id`, `/users/:username`, `/`, `/home` as crawler
- Verify HTML content, meta tags, JSON-LD
- Visit the same pages as normal browser → should get SPA

## Data Flow

### Thread Page
1. Request → `functions/thread/[id].ts`
2. `isCrawler(UA)` check
3. If crawler: DB query `SELECT posts.*, users.* WHERE posts.id = ?`
4. DB query `SELECT replies.*, users.* WHERE parent_id = ? ORDER BY created_at ASC`
5. Build JSON-LD + HTML
6. Return `new Response(html, { headers: { 'Content-Type': 'text/html' } })`
7. If not crawler: `return next()` → serves SPA

### Profile Page
1. Request → `functions/users/[username].ts`
2. `isCrawler(UA)` check in `app.get('/')`
3. If crawler: DB query user + recent posts
4. Build HTML + JSON-LD
5. If not crawler: existing redirect/ActivityPub logic

### Timeline Pages (/, /home)
1. Request → `functions/pages/_index.ts` or `functions/pages/home.ts`
2. `isCrawler(UA)` check
3. If crawler: DB query recent 20 public posts
4. Build HTML + JSON-LD WebSite
5. If not crawler: `return next()` → SPA

## Implementation Order

1. Create `src/lib/render-html.ts` (shared utilities)
2. Update `src/lib/og-html.ts` to import `escapeHtml` from shared module (or keep internal copy for backward compat)
3. Modify `functions/thread/[id].ts`
4. Modify `functions/users/[username].ts`
5. Modify `functions/pages/_index.ts`
6. Modify `functions/pages/home.ts`
7. Build and test
