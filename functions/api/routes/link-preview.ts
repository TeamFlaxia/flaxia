import { Hono } from 'hono';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { fetchWithSsrfGuard, SsrfError } from '../../lib/url-guard';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const link = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Helper functions for link preview
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function parseMetaTags(html: string, baseUrl: string) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    url: baseUrl,
    type: '',
    video: {
      url: '',
      secureUrl: '',
      type: '',
      width: 0,
      height: 0,
    },
  };

  const matchMeta = (property: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const matchMetaName = (name: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const resolveUrl = (url: string): string => {
    if (url.startsWith('//')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    } else if (url.startsWith('/') || url.startsWith('.')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    }
    return url;
  };

  // 1. Title
  const ogTitle = matchMeta('og:title') || matchMetaName('twitter:title');
  if (ogTitle) {
    result.title = decodeHtmlEntities(ogTitle);
  } else {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) {
      result.title = decodeHtmlEntities(titleTag[1].trim());
    }
  }

  // 2. Description
  const ogDesc = matchMeta('og:description') || matchMetaName('description') || matchMetaName('twitter:description');
  if (ogDesc) {
    result.description = decodeHtmlEntities(ogDesc);
  }

  // 3. Image
  const ogImage = matchMeta('og:image') || matchMetaName('twitter:image');
  if (ogImage) {
    result.image = resolveUrl(ogImage);
  }

  // 4. Site Name
  const ogSiteName = matchMeta('og:site_name');
  if (ogSiteName) {
    result.siteName = decodeHtmlEntities(ogSiteName);
  } else {
    try {
      result.siteName = new URL(baseUrl).hostname;
    } catch {}
  }

  // 5. og:type
  const ogType = matchMeta('og:type');
  if (ogType) {
    result.type = ogType;
  }

  // 6. Video embed info
  const ogVideoUrl = matchMeta('og:video:url') || matchMeta('og:video');
  const ogVideoSecureUrl = matchMeta('og:video:secure_url');
  const ogVideoType = matchMeta('og:video:type');
  const ogVideoWidth = matchMeta('og:video:width');
  const ogVideoHeight = matchMeta('og:video:height');

  if (ogVideoUrl) {
    result.video.url = resolveUrl(ogVideoUrl);
  }
  if (ogVideoSecureUrl) {
    result.video.secureUrl = ogVideoSecureUrl;
  }
  if (ogVideoType) {
    result.video.type = ogVideoType;
  }
  if (ogVideoWidth) {
    result.video.width = parseInt(ogVideoWidth, 10) || 0;
  }
  if (ogVideoHeight) {
    result.video.height = parseInt(ogVideoHeight, 10) || 0;
  }

  return result;
}

// SSRF validation and redirect handling live in ../../lib/url-guard so every
// server-side fetch of a user-supplied URL shares one policy (see
// fetchWithSsrfGuard below). The previous local checks only inspected the
// first URL and let a redirect hop to a private address.

// GET /api/link-preview - Scrape OpenGraph meta tags of a URL (authenticated:
// PoC confirmed an unauthenticated fetch oracle on production, so this route
// now requires a session).
link.get('/link-preview', requireAuth, async (c) => {
  // Authenticated endpoint, but still rate-limited per user: each call makes
  // the Worker fetch an arbitrary remote URL, so it must not be callable
  // in a tight loop to turn the backend into a fetch oracle.
  const limited = await checkRateLimit(c.env.CACHE, `linkpreview:${c.get('user')?.id ?? getClientIp(c.req.raw)}`, {
    maxRequests: 30,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  const urlString = c.req.query('url');
  if (!urlString) {
    return c.json({ error: 'Missing url parameter' }, 400);
  }

  try {
    const targetUrl = new URL(urlString);

    let response: Response;
    try {
      // Validates the URL and every redirect hop before it is requested, so a
      // public link cannot bounce the Worker to localhost or a private range.
      response = await fetchWithSsrfGuard(targetUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FlaxiaPreviewBot/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });
    } catch (error: unknown) {
      if (error instanceof SsrfError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    if (!response.ok) {
      return c.json({
        title: targetUrl.hostname,
        description: '',
        image: '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return c.json({
        title: targetUrl.pathname.split('/').pop() || targetUrl.hostname,
        description: '',
        image: contentType.startsWith('image/') ? targetUrl.toString() : '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const reader = response.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let bytesRead = 0;
      const maxBytes = 256 * 1024; // 256KB

      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.length;
          html += decoder.decode(value, { stream: true });
        }
      }
      html += decoder.decode();
    } else {
      html = await response.text();
    }

    const previewData = parseMetaTags(html, targetUrl.toString());
    return c.json(previewData);
  } catch (error: unknown) {
    console.error('Link preview error:', error);
    return c.json({ error: 'Failed to fetch link preview' }, 500);
  }
});

export default link;
