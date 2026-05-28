/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', async (c) => {
  try {
    const username = c.req.param('username')

    const user = await c.env.DB.prepare(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username).first() as { id: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    const totalItems = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?'
    ).bind(user.id).first() as any).count || 0

    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/following`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/following?page=1`
    }, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Following endpoint error:', error)
    return c.json({ error: 'Following endpoint failed' }, 500)
  }
})

export default app
