/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { verifyHttpSignature, verifyDigest, fetchActorPublicKey } from '../../../lib/activitypub/signature'

type Bindings = {
  DB: D1Database
  BASE_URL: string
  AP_DELIVERY_QUEUE: Queue
}

const app = new Hono<{ Bindings: Bindings }>()

app.post('/', async (c) => {
  try {
    const username = c.req.param('username')
    const contentType = c.req.header('content-type') || ''

    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400)
    }

    const targetUser = await c.env.DB.prepare(
      'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username).first() as { id: string, username: string } | null

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    const body = await c.req.text()
    let activity: any
    try {
      activity = JSON.parse(body)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const actorId = activity.actor
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400)
    }

    const publicKeyPem = await fetchActorPublicKey(actorId)
    if (!publicKeyPem) {
      return c.json({ error: 'Could not fetch actor public key' }, 401)
    }

    const sigValid = await verifyHttpSignature(c.req.raw, publicKeyPem)
    if (!sigValid) {
      return c.json({ error: 'Invalid HTTP Signature' }, 401)
    }

    const digestValid = await verifyDigest(c.req.raw, body)
    if (!digestValid) {
      return c.json({ error: 'Invalid Digest' }, 401)
    }

    if (c.env.AP_DELIVERY_QUEUE) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'inbox' as const,
        username,
        activity,
        actorId
      })
    }

    return c.json({ ok: true }, 202)
  } catch (error: any) {
    console.error('Inbox error:', error)
    return c.json({ error: 'Inbox processing failed', details: error?.message }, 500)
  }
})

export default app
