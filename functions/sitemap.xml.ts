import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Helper function to escape XML special characters
const escapeXml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// Helper function to format date for sitemap
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toISOString().split('.')[0] + 'Z';
};

// Generate sitemap XML
const generateSitemap = async (env: Bindings): Promise<string> => {
  const baseUrl = env.BASE_URL.replace(/\/$/, ''); // Remove trailing slash

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  // Add static pages
  const staticPages = [
    { loc: `${baseUrl}/home`, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl}/arcade`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${baseUrl}/explore`, changefreq: 'weekly', priority: '0.5' },
    { loc: `${baseUrl}/legal`, changefreq: 'monthly', priority: '0.5' },
  ];

  // Get current timestamp for static pages
  const now = new Date().toISOString().split('.')[0] + 'Z';

  staticPages.forEach((page) => {
    xml += `
  <url>
    <loc>${escapeXml(page.loc)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`;
  });

  // Add user profiles (limit to 5000 for performance)
  if (env.DB) {
    try {
      const users = (await env.DB.prepare(`
        SELECT username, created_at 
        FROM users 
        ORDER BY created_at DESC 
        LIMIT 5000
      `).all()) as { results: Array<{ username: string; created_at: string }> };

      users.results.forEach((user) => {
        const userUrl = `${baseUrl}/users/${escapeXml(user.username)}`;
        xml += `
  <url>
    <loc>${userUrl}</loc>
    <lastmod>${formatDate(user.created_at)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      });
    } catch (error) {
      console.error('Error fetching users for sitemap:', error);
    }

    // Add public posts (limit to 10000 for performance)
    try {
      const posts = (await env.DB.prepare(`
        SELECT id, created_at 
        FROM posts 
        WHERE text != '' 
        ORDER BY created_at DESC 
        LIMIT 10000
      `).all()) as { results: Array<{ id: string; created_at: string }> };

      posts.results.forEach((post) => {
        const postUrl = `${baseUrl}/thread/${escapeXml(post.id)}`;
        xml += `
  <url>
    <loc>${postUrl}</loc>
    <lastmod>${formatDate(post.created_at)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
      });
    } catch (error) {
      console.error('Error fetching posts for sitemap:', error);
    }

    // Add game posts (for arcade pages, limit to 5000)
    try {
      const games = (await env.DB.prepare(`
        SELECT id, created_at
        FROM posts
        WHERE payload_key IS NOT NULL AND swf_key IS NULL
          AND status = 'published'
          AND hidden = 0
          AND parent_id IS NULL
        ORDER BY created_at DESC
        LIMIT 5000
      `).all()) as { results: Array<{ id: string; created_at: string }> };

      games.results.forEach((game) => {
        const gameUrl = `${baseUrl}/arcade/${escapeXml(game.id)}`;
        xml += `
  <url>
    <loc>${gameUrl}</loc>
    <lastmod>${formatDate(game.created_at)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
      });
    } catch (error) {
      console.error('Error fetching games for sitemap:', error);
    }
  }

  xml += `
</urlset>`;

  return xml;
};

// GET /sitemap.xml - sitemap endpoint
app.get('/sitemap.xml', async (c) => {
  try {
    const sitemapXml = await generateSitemap(c.env);

    return new Response(sitemapXml, {
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error: unknown) {
    console.error('Sitemap generation error:', error);
    return c.text('Internal Server Error', 500);
  }
});

// Export for Cloudflare Pages Functions
export async function onRequest(context: {
  request: Request;
  env: { DB: D1Database; BUCKET?: R2Bucket; [key: string]: unknown };
  waitUntil: (p: Promise<unknown>) => void;
}) {
  return app.fetch(context.request, context.env, context as unknown as ExecutionContext);
}
