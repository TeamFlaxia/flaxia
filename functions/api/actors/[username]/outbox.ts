/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { buildNoteObject, buildCreateActivity } from '../../../lib/activitypub/note'

type Bindings = {
  DB: D1Database
  BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', async (c) => {
  const username = c.req.param('username')
  const page = c.req.query('page')
  const pageSize = 20

  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const totalItems = (await c.env.DB.prepare(`SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 'published'`).bind(user.id).first() as any).count

  if (!page) {
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=1`,
      "last": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${Math.ceil(totalItems / pageSize) || 1}`
    }, 200, { 'Content-Type': 'application/activity+json' })
  }

  const currentPage = parseInt(page) || 1
  const posts = await c.env.DB.prepare(`SELECT id, text, created_at FROM posts WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(user.id, pageSize, (currentPage - 1) * pageSize).all() as any
  const activities = posts.results.map((post: any) => buildCreateActivity(buildNoteObject(post, user, c.env.BASE_URL), user, c.env.BASE_URL))

  const response: any = {
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "OrderedCollectionPage",
    "id": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage}`,
    "partOf": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "orderedItems": activities
  }
  if ((currentPage * pageSize) < totalItems) response.next = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage + 1}`
  if (currentPage > 1) response.prev = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage - 1}`

  return c.json(response, 200, { 'Content-Type': 'application/activity+json' })
})

export default app
