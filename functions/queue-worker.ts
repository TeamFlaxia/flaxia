
/// <reference types="@cloudflare/workers-types" />

interface DeliveryMessage {
  type: 'delivery'
  inboxUrl: string
  activity: object
  senderUsername: string
}

interface InboxMessage {
  type: 'inbox'
  username: string
  activity: object
  actorId: string
}

type QueueMessage = DeliveryMessage | InboxMessage

interface Env {
  DB: D1Database
  BASE_URL: string
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    console.log(`Processing batch of ${batch.messages.length} messages`)
    
    for (const message of batch.messages) {
      try {
        console.log(`Processing message type: ${(message.body as any).type}`)
        
        if (message.body.type === 'inbox') {
          await handleInboxActivity(message.body, env, message)
        } else if (message.body.type === 'delivery') {
          await handleDeliveryActivity(message.body, env, message)
        } else {
          console.error('Unknown message type:', (message.body as any).type)
          message.ack()
        }
      } catch (error: any) {
        console.error('Error processing message:', {
          error: error.message,
          stack: error.stack,
          messageType: (message.body as any).type,
          messageId: message.id
        })
        
        // Acknowledge the message to prevent retries for unhandled errors
        message.ack()
      }
    }
  }
}

async function handleDeliveryActivity(msg: DeliveryMessage, env: Env, message: any): Promise<void> {
  const { inboxUrl, activity, senderUsername } = msg
  const retryCount = message.retryCount || 0
  const maxRetries = 3
  let timeoutId: number | undefined

  try {
    // Get user's private and public keys for signing
    const keyResult = await env.DB.prepare(`
      SELECT ak.private_key_pem, ak.public_key_pem FROM actor_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE u.username = ?
    `).bind(senderUsername).first()

    if (!keyResult || !keyResult.private_key_pem) {
      console.error('No private key found for user:', senderUsername)
      message.ack()
      return
    }

    const privateKeyPem = keyResult.private_key_pem as string
    const publicKeyPem = keyResult.public_key_pem as string
    const keyId = `${env.BASE_URL}/actors/${senderUsername}#main-key`

    const { signRequest } = await import('./lib/activitypub/signature')
    const body = JSON.stringify(activity)
    const headers = await signRequest(inboxUrl, body, privateKeyPem, publicKeyPem, keyId)

    // Add timeout and better error handling
    const controller = new AbortController()
    timeoutId = setTimeout(() => controller.abort(), 30000) as any // 30 second timeout

    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: headers,
      body: body,
      signal: controller.signal
    })

    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    if (response.ok) {
      console.log('ActivityPub delivery successful:', inboxUrl, 'activity:', (activity as any).type)
      message.ack()
    } else {
      const responseText = await response.text()
      console.error('ActivityPub delivery failed:', {
        inboxUrl,
        status: response.status,
        statusText: response.statusText,
        responseText: responseText.substring(0, 500),
        activityType: (activity as any).type
      })

      // Retry on server errors (5xx) or network issues
      if (response.status >= 500 || response.status === 429) {
        if (retryCount < maxRetries) {
          console.log(`Retrying delivery to ${inboxUrl}, attempt ${retryCount + 1}/${maxRetries}`)
          message.retry({ delaySeconds: Math.pow(2, retryCount) * 30 }) // Exponential backoff
        } else {
          console.error(`Max retries exceeded for ${inboxUrl}, giving up`)
          message.ack()
        }
      } else {
        // Don't retry client errors (4xx except 429)
        message.ack()
      }
    }
  } catch (e: any) {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    
    console.error('ActivityPub delivery error:', {
      inboxUrl,
      error: e.message,
      name: e.name,
      retryCount,
      activityType: (activity as any).type
    })

    // Retry on network errors or timeouts
    if (retryCount < maxRetries && (e.name === 'AbortError' || e.name === 'TypeError')) {
      console.log(`Retrying delivery to ${inboxUrl} after error, attempt ${retryCount + 1}/${maxRetries}`)
      message.retry({ delaySeconds: Math.pow(2, retryCount) * 30 })
    } else {
      console.error(`Max retries exceeded or non-retryable error for ${inboxUrl}`)
      message.ack()
    }
  }
}

async function handleInboxActivity(msg: InboxMessage, env: Env, message: any): Promise<void> {
  const { username, activity, actorId } = msg

  try {
    const activityType = (activity as any).type

    switch (activityType) {
      case 'Create':
        await handleCreateActivity(activity, username, actorId, env)
        break
      case 'Follow':
        await handleFollowActivity(activity, username, actorId, env)
        break
      case 'Accept':
        await handleAcceptActivity(activity, username, actorId, env)
        break
      case 'Like':
        await handleLikeActivity(activity, username, actorId, env)
        break
      case 'Announce':
        await handleAnnounceActivity(activity, username, actorId, env)
        break
      case 'Delete':
        await handleDeleteActivity(activity, username, actorId, env)
        break
      case 'Undo':
        await handleUndoActivity(activity, username, actorId, env)
        break
      case 'Update':
        await handleUpdateActivity(activity, username, actorId, env)
        break
      default:
        console.warn('Unknown activity type:', activityType)
    }

    message.ack()
  } catch (e) {
    console.error('Inbox processing error:', e)
    message.retry()
  }
}

async function handleCreateActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object || object.type !== 'Note') {
    console.log('Ignoring Create activity with non-Note object')
    return
  }

  const content = object.content
  if (!content || typeof content !== 'string') {
    console.error('Note missing content')
    return
  }

  if (content.length > 200) {
    console.error('Note content too long:', content.length)
    return
  }

  const userResult = await env.DB.prepare(`
    SELECT id FROM users WHERE username = ? COLLATE NOCASE
  `).bind(username).first() as { id: string } | null

  if (!userResult) {
    console.error('User not found:', username)
    return
  }

  const userId = userResult.id
  const postId = activity.id ? activity.id.split('/create-')[1] : generatePostId()

  const hashtagSet = new Set<string>()
  const hashtagRegex = /#(\w+)/g
  let match
  while ((match = hashtagRegex.exec(content)) !== null) {
    hashtagSet.add(match[1])
  }
  const hashtags = Array.from(hashtagSet)

  // Extract mentions from content
  const mentionSet = new Set<string>()
  const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g
  let mentionMatch
  while ((mentionMatch = mentionRegex.exec(content)) !== null) {
    mentionSet.add(mentionMatch[1])
  }
  const mentionedUsernames = Array.from(mentionSet)

  let parentId: string | null = null
  let rootId: string | null = null
  let depth = 0

  if (object.inReplyTo) {
    const replyTo = object.inReplyTo
    const postIdMatch = replyTo.match(/\/notes\/([a-zA-Z0-9]+)/)
    if (postIdMatch) {
      parentId = postIdMatch[1]
    }
  }

  await env.DB.prepare(`
    INSERT INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, datetime('now'))
  `).bind(postId, userId, username, content, JSON.stringify(hashtags), parentId, rootId, depth, actorId).run()

  // Create mention notifications for mentioned users
  if (mentionedUsernames.length > 0) {
    try {
      for (const mentionedUsername of mentionedUsernames) {
        // Don't notify if mentioning yourself
        if (mentionedUsername.toLowerCase() === username.toLowerCase()) {
          continue
        }

        // Look up the mentioned user
        const mentionedUser = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_key FROM users WHERE username = ? COLLATE NOCASE'
        ).bind(mentionedUsername).first() as { id: string, username: string, display_name: string, avatar_key: string | null } | null

        if (mentionedUser) {
          // Create mention notification with actor_data for external actor
          const actorData = JSON.stringify({
            username: username,
            display_name: username,
            domain: new URL(actorId).hostname
          })

          await env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id, actor_data) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(generateId(), mentionedUser.id, 'mention', postId, actorId, actorData).run()
        }
      }
    } catch (e) {
      console.error('Failed to create mention notifications for ActivityPub post:', e)
      // Don't fail the post creation if mention notifications fail
    }
  }

  console.log('Note received and stored:', postId)
}

async function handleFollowActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const userResult = await env.DB.prepare(`
    SELECT id FROM users WHERE username = ? COLLATE NOCASE
  `).bind(username).first() as { id: string } | null

  if (!userResult) {
    console.error('User not found:', username)
    return
  }

  const localUserId = userResult.id

  const existingFollow = await env.DB.prepare(`
    SELECT id FROM ap_followers WHERE local_user_id = ? AND actor_url = ?
  `).bind(localUserId, actorId).first()

  if (existingFollow) {
    console.log('Follower already exists:', actorId)
    return
  }

  // Fetch actor's inbox URL and profile information
  let inboxUrl = activity.actor
  let actorData: any = null
  try {
    const actorResponse = await fetch(actorId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json'
      }
    })

    if (actorResponse.ok) {
      actorData = await actorResponse.json() as any
      inboxUrl = actorData.inbox || activity.actor
    }
  } catch (e) {
    console.error('Failed to fetch actor inbox:', e)
  }

  const followerId = generateId()
  await env.DB.prepare(`
    INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(followerId, localUserId, actorId, inboxUrl).run()

  console.log('Follow request recorded:', actorId)

  // Create notification for follow with actor information
  try {
    const { nanoid } = await import('nanoid')
    
    // Extract actor name for display
    let actorDisplayName = 'Unknown User'
    let actorUsername = 'unknown'
    let domain = 'unknown'
    
    if (actorData) {
      actorDisplayName = actorData.name || actorData.preferredUsername || 'Unknown User'
      actorUsername = actorData.preferredUsername || 'unknown'
      
      // Extract domain from actor URL for "MastodonのXXXさん" format
      try {
        const actorUrl = new URL(actorId)
        domain = actorUrl.hostname
      } catch {
        domain = actorId.includes('://') ? new URL(actorId).hostname : actorId
      }
    } else {
      // Fallback: extract domain from actor URL
      try {
        const actorUrl = new URL(actorId)
        domain = actorUrl.hostname
      } catch {
        domain = actorId.includes('://') ? new URL(actorId).hostname : actorId
      }
    }
    
    // Store actor information in the notification
    await env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, post_id, actor_id, actor_data) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      nanoid(), 
      localUserId, 
      'ap_follow', 
      null, 
      actorId,
      JSON.stringify({
        username: actorUsername,
        display_name: actorDisplayName,
        domain: domain,
        actor_url: actorId
      })
    ).run()
    
    console.log('Follow notification created for:', actorDisplayName, 'from domain:', domain)
  } catch (e) {
    console.error('Failed to create follow notification:', e)
  }

  // Send Accept activity automatically
  try {
    console.log('Preparing to send Accept activity for follow from:', actorId, 'to user:', username)
    
    const { signRequest } = await import('./lib/activitypub/signature')
    
    // Get user's private and public keys for signing
    const keyResult = await env.DB.prepare(`
      SELECT ak.private_key_pem, ak.public_key_pem FROM actor_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE u.username = ?
    `).bind(username).first()

    if (!keyResult || !keyResult.private_key_pem) {
      console.error('No private key found for user:', username)
      return
    }

    const privateKeyPem = keyResult.private_key_pem as string
    const publicKeyPem = keyResult.public_key_pem as string
    const keyId = `${env.BASE_URL}/actors/${username}#main-key`

    console.log('Using inbox URL:', inboxUrl)
    console.log('Key ID:', keyId)

    // Build Accept activity - use the original Follow activity as object
    const acceptActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${env.BASE_URL}/activities/accept-${followerId}`,
      type: 'Accept',
      actor: `${env.BASE_URL}/actors/${username}`,
      object: activity, // Use the entire original Follow activity
      to: [actorId],
      published: new Date().toISOString()
    }

    console.log('Accept activity:', JSON.stringify(acceptActivity, null, 2))

    const body = JSON.stringify(acceptActivity)
    const headers = await signRequest(inboxUrl, body, privateKeyPem, publicKeyPem, keyId)

    console.log('Sending Accept activity to:', inboxUrl)
    console.log('Headers:', Object.fromEntries(headers.entries()))

    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: headers,
      body: body
    })

    if (response.status === 200) {
      console.log('Accept activity sent successfully to:', actorId, 'status:', response.status)
    } else if (response.status === 202) {
      console.warn('Accept activity accepted but not processed yet (202) - this may cause follow approval issues:', actorId)
    } else {
      const responseText = await response.text()
      console.error('Failed to send Accept activity:', {
        inboxUrl,
        status: response.status,
        statusText: response.statusText,
        responseText: responseText.substring(0, 500)
      })
    }
  } catch (e: any) {
    console.error('Error sending Accept activity:', {
      error: e.message,
      stack: e.stack,
      actorId,
      username,
      inboxUrl
    })
  }
}

async function handleAcceptActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object || object.type !== 'Follow') {
    console.log('Ignoring Accept for non-Follow activity')
    return
  }

  const followActor = object.actor
  if (!followActor) {
    console.error('Accept activity missing object actor')
    return
  }

  // Update ap_following status to accepted
  const userResult = await env.DB.prepare(
    `SELECT id FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(username).first() as { id: string } | null

  if (userResult) {
    const result = await env.DB.prepare(
      `UPDATE ap_following SET status = ? WHERE local_user_id = ? AND target_actor_url = ? AND status = 'sent'`
    ).bind('accepted', userResult.id, followActor).run()
    console.log('Follow accepted from:', followActor, 'updated:', result.meta?.changes || 0, 'rows')
  } else {
    console.log('Follow accepted from:', followActor)
  }
}

async function handleLikeActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Like activity missing object')
    return
  }

  const postIdMatch = objectUrl.match(/\/notes\/([a-zA-Z0-9]+)/)
  if (!postIdMatch) {
    console.log('Like target is not a local post:', objectUrl)
    return
  }

  const postId = postIdMatch[1]

  const postResult = await env.DB.prepare(`
    SELECT id FROM posts WHERE id = ?
  `).bind(postId).first()

  if (!postResult) {
    console.log('Liked post not found:', postId)
    return
  }

  const existingLike = await env.DB.prepare(`
    SELECT id FROM likes WHERE post_id = ? AND actor_id = ?
  `).bind(postId, actorId).first()

  if (existingLike) {
    console.log('Like already exists:', postId, actorId)
    return
  }

  const likeId = generateId()
  await env.DB.prepare(`
    INSERT INTO likes (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(likeId, postId, 'unknown', actorId).run()

  console.log('Like recorded:', postId, actorId)
}

async function handleAnnounceActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Announce activity missing object')
    return
  }

  const postIdMatch = objectUrl.match(/\/notes\/([a-zA-Z0-9]+)/)
  if (!postIdMatch) {
    console.log('Announce target is not a local post:', objectUrl)
    return
  }

  const postId = postIdMatch[1]

  const postResult = await env.DB.prepare(`
    SELECT id FROM posts WHERE id = ?
  `).bind(postId).first()

  if (!postResult) {
    console.log('Announced post not found:', postId)
    return
  }

  const existingShare = await env.DB.prepare(`
    SELECT id FROM shares WHERE post_id = ? AND actor_id = ?
  `).bind(postId, actorId).first()

  if (existingShare) {
    console.log('Share already exists:', postId, actorId)
    return
  }

  const shareId = generateId()
  await env.DB.prepare(`
    INSERT INTO shares (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(shareId, postId, 'unknown', actorId).run()

  console.log('Share recorded:', postId, actorId)
}

async function handleDeleteActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Delete activity missing object')
    return
  }

  console.log('Delete activity received for:', objectUrl)
}

async function handleUndoActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object) {
    console.error('Undo activity missing object')
    return
  }

  const objectType = object.type
  switch (objectType) {
    case 'Like':
      const objectUrl = object.id || object
      const postIdMatch = objectUrl?.match(/\/notes\/([a-zA-Z0-9]+)/)
      if (postIdMatch) {
        await env.DB.prepare(`
          DELETE FROM likes WHERE post_id = ? AND actor_id = ?
        `).bind(postIdMatch[1], actorId).run()
        console.log('Like removed:', postIdMatch[1], actorId)
      }
      break
    case 'Announce':
      const announceUrl = object.id || object
      const sharePostIdMatch = announceUrl?.match(/\/notes\/([a-zA-Z0-9]+)/)
      if (sharePostIdMatch) {
        await env.DB.prepare(`
          DELETE FROM shares WHERE post_id = ? AND actor_id = ?
        `).bind(sharePostIdMatch[1], actorId).run()
        console.log('Share removed:', sharePostIdMatch[1], actorId)
      }
      break
    case 'Follow':
      const userResult = await env.DB.prepare(`
        SELECT id FROM users WHERE username = ? COLLATE NOCASE
      `).bind(username).first() as { id: string } | null

      if (userResult) {
        await env.DB.prepare(`
          DELETE FROM ap_followers WHERE local_user_id = ? AND actor_url = ?
        `).bind(userResult.id, object.actor).run()
        console.log('Follow removed:', object.actor)
      }
      break
    default:
      console.log('Unknown undo object type:', objectType)
  }
}

async function handleUpdateActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object) {
    console.error('Update activity missing object')
    return
  }

  if (object.type === 'Person') {
    // Remote user updated their profile - fetch latest info
    try {
      const actorResponse = await fetch(actorId, {
        headers: { 'Accept': 'application/activity+json, application/ld+json' }
      })
      if (actorResponse.ok) {
        console.log('Profile update received from:', actorId)
        // In the future, store remote actor info in a remote_actors table
      }
    } catch (e) {
      console.error('Failed to fetch updated actor:', e)
    }
  } else if (object.type === 'Note') {
    console.log('Note update received:', object.id)
  } else {
    console.log('Update activity for unknown type:', object.type)
  }
}

function generateId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function generatePostId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  const values = new Uint8Array(10)
  crypto.getRandomValues(values)
  for (let i = 0; i < 10; i++) {
    result += alphabet[values[i] % alphabet.length]
  }
  return result
}
