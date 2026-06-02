/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// GET /nodeinfo/2.1 - NodeInfo endpoint
app.get('/', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get basic stats
    const userCount = (await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first()) as { count: number };
    const postCount = (await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM posts WHERE status = 'published'",
    ).first()) as { count: number };

    const nodeInfo = {
      version: '2.1',
      software: {
        name: 'flexia',
        version: '1.0.0',
        repository: 'https://github.com/RemydreScarlet/flexia',
        homepage: 'https://github.com/RemydreScarlet/flexia',
      },
      protocols: ['activitypub'],
      services: {
        outbound: [],
        inbound: [],
      },
      usage: {
        users: {
          total: userCount?.count || 0,
          activeMonth: userCount?.count || 0, // Simplified - all users considered active
          activeHalfyear: userCount?.count || 0,
        },
        localPosts: postCount?.count || 0,
        localComments: 0, // Flexia doesn't have separate comments
      },
      openRegistrations: true, // Assuming registration is open
      metadata: {
        nodeName: 'Flexia Instance',
        nodeDescription: 'A Flexia ActivityPub instance',
        maintainer: {
          name: 'Flexia Admin',
          email: 'admin@flexia.example',
        },
      },
    };

    return c.json(nodeInfo, 200, {
      'Content-Type': 'application/json; profile=http://nodeinfo.diaspora.software/ns/schema/2.1#',
    });
  } catch (error: any) {
    console.error('NodeInfo error:', error);
    return c.json({ error: 'NodeInfo failed', details: error?.message || 'Unknown error' }, 500);
  }
});

export default app;
