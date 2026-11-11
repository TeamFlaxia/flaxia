/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { webfingerResponse } from '../../lib/activitypub/webfinger';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub
app.get('/', async (c) => {
  const result = await webfingerResponse(c.env, c.req.query('resource'));
  return c.json(result.body, result.status as 200, result.contentType ? { 'Content-Type': result.contentType } : {});
});

export default app;
