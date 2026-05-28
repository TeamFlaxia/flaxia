/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { generateKeyPair, exportPublicKey, exportPrivateKey } from '../../../lib/activitypub/crypto'

type Bindings = {
  DB: D1Database
  BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', async (c) => {
  const username = c.req.param('username')
  const user = await c.env.DB.prepare(`SELECT id, username, display_name, bio, avatar_key FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const keyRecord = await c.env.DB.prepare(`SELECT public_key_pem FROM actor_keys WHERE user_id = ?`).bind(user.id).first() as any
  let publicKeyPem = keyRecord?.public_key_pem
  if (!publicKeyPem) {
    const keyPair = await generateKeyPair()
    publicKeyPem = await exportPublicKey(keyPair.publicKey)
    await c.env.DB.prepare(`INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(user.id, publicKeyPem, await exportPrivateKey(keyPair.privateKey)).run()
  }

  return c.json({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    "type": "Person",
    "id": `${c.env.BASE_URL}/api/actors/${username}`,
    "preferredUsername": user.username,
    "name": user.display_name,
    "summary": user.bio || "",
    "inbox": `${c.env.BASE_URL}/api/actors/${username}/inbox`,
    "outbox": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "followers": `${c.env.BASE_URL}/api/actors/${username}/followers`,
    "following": `${c.env.BASE_URL}/api/actors/${username}/following`,
    "publicKey": {
      "id": `${c.env.BASE_URL}/api/actors/${username}#main-key`,
      "owner": `${c.env.BASE_URL}/api/actors/${username}`,
      "publicKeyPem": publicKeyPem
    }
  }, 200, { 'Content-Type': 'application/activity+json' })
})

export default app
