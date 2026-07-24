/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub
app.get('/', async (c) => {
  try {
    const resource = c.req.query('resource');

    if (!resource) {
      return c.json({ error: 'Missing resource parameter' }, 400);
    }

    // Parse resource parameter: acct:username@domain
    const match = resource.match(/^acct:([^@]+)@(.+)$/);
    if (!match) {
      return c.json({ error: 'Invalid resource format' }, 400);
    }

    const [, username, domain] = match;
    if (!username) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Verify domain matches our BASE_URL
    const baseUrl = new URL(c.env.BASE_URL);
    if (domain !== baseUrl.hostname) {
      return c.json({ error: 'Domain mismatch' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Return WebFinger response
    const webfingerResponse = {
      subject: `acct:${username}@${domain}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `${c.env.BASE_URL}/actors/${username}`,
        },
      ],
    };

    return c.json(webfingerResponse, 200, {
      'Content-Type': 'application/jrd+json',
    });
  } catch (error: unknown) {
    console.error('WebFinger error:', error);
    return c.json({ error: 'WebFinger failed' }, 500);
  }
});

export default app;
