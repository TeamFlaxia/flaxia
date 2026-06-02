/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// GET /.well-known/nodeinfo - NodeInfo discovery
app.get('/', async (c) => {
  const nodeInfo = {
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: `${c.env.BASE_URL}/nodeinfo/2.1`,
      },
    ],
  };

  return c.json(nodeInfo, 200, {
    'Content-Type': 'application/json',
  });
});

export default app;
