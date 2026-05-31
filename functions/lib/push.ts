export interface PushPayload {
  title: string
  body: string
  data?: Record<string, string>
}

/**
 * Send push notification to a specific device token via FCM HTTP v1 API.
 * Requires FCM_SERVER_KEY secret to be set in Cloudflare.
 */
export async function sendPushToToken(
  token: string,
  platform: 'android' | 'ios',
  payload: PushPayload,
  fcmServerKey: string,
): Promise<boolean> {
  const message: Record<string, any> = {
    to: token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data || {},
  }

  if (platform === 'ios') {
    message.notification!.sound = 'default'
    message.priority = 'high'
  } else {
    message.priority = 'high'
  }

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${fcmServerKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('FCM send failed', res.status, body)
      return false
    }

    return true
  } catch (err) {
    console.error('FCM send error', err)
    return false
  }
}

/**
 * Send push notification to all devices of a user.
 * Fetches device tokens from DB and sends to each.
 */
export async function sendPushToUser(
  db: D1Database,
  userId: string,
  payload: PushPayload,
  fcmServerKey: string,
): Promise<void> {
  const { results } = await db.prepare(
    'SELECT token, platform FROM device_tokens WHERE user_id = ?'
  ).bind(userId).all() as { results: { token: string; platform: string }[] }

  for (const device of results) {
    sendPushToToken(
      device.token,
      device.platform as 'android' | 'ios',
      payload,
      fcmServerKey,
    )
  }
}

/**
 * FCM notification type mapping for user-facing strings.
 */
export function getPushPayload(
  type: string,
  actorName?: string,
  postPreview?: string,
): PushPayload {
  const name = actorName || 'Someone'
  const preview = postPreview ? `: ${postPreview.slice(0, 50)}` : ''

  switch (type) {
    case 'fresh':
      return { title: 'Flaxia', body: `${name} liked your post${preview}` }
    case 'reply':
      return { title: 'Flaxia', body: `${name} replied to your post${preview}` }
    case 'mention':
      return { title: 'Flaxia', body: `${name} mentioned you${preview}` }
    case 'ap_follow':
      return { title: 'Flaxia', body: `${name} followed you` }
    case 'ap_like':
      return { title: 'Flaxia', body: `${name} liked your post from the Fediverse${preview}` }
    case 'ap_announce':
      return { title: 'Flaxia', body: `${name} boosted your post${preview}` }
    case 'poll_ended':
      return { title: 'Flaxia', body: `A poll you voted on has ended${preview}` }
    case 'bookmark':
      return { title: 'Flaxia', body: `${name} bookmarked your post${preview}` }
    default:
      return { title: 'Flaxia', body: `New notification${preview}` }
  }
}
