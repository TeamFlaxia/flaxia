function isTauri(): boolean {
  try {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
  } catch {
    return false
  }
}

let permissionGranted = false
let seenIds = new Set<string>()
let initPromise: Promise<void> | null = null

async function requestTauriPermission(): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
    if (await isPermissionGranted()) return true
    const perm = await requestPermission()
    return perm === 'granted'
  } catch {
    return false
  }
}

function formatNotificationText(n: {
  type: string
  actor?: { username: string; display_name?: string } | null
  actors?: Array<{ username: string; display_name?: string } | null>
  post_text_preview?: string | null
}): string {
  const name = n.actor?.display_name || (n.actor ? `@${n.actor.username}` : '')
  const actorLabel = name ? `${name} ` : ''

  let text: string
  switch (n.type) {
    case 'fresh':
      text = `${actorLabel}freshed your post`
      break
    case 'ap_like':
      text = `${actorLabel}liked your post`
      break
    case 'reply':
      text = `${actorLabel}replied to you`
      break
    case 'mention':
      text = `${actorLabel}mentioned you`
      break
    case 'ap_follow':
      text = `${actorLabel}followed you`
      break
    case 'ap_announce':
      text = `${actorLabel}boosted your post`
      break
    case 'poll_ended':
      text = 'Your poll has ended'
      break
    case 'reported':
    case 'warned':
    case 'hidden':
      text = 'Your post has been reported'
      break
    default:
      text = 'New notification'
  }

  if (n.post_text_preview && (n.type === 'reply' || n.type === 'mention')) {
    text += `: ${n.post_text_preview}`
  }

  return text
}

export async function initTauriNotifications(): Promise<void> {
  if (!isTauri()) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    permissionGranted = await requestTauriPermission()
  })()

  return initPromise
}

export function processNewNotifications(
  notifications: Array<{
    id: string
    type: string
    actor?: { username: string; display_name?: string } | null
    actors?: Array<{ username: string; display_name?: string } | null>
    post_text_preview?: string | null
    read: boolean
    created_at: string
  }>,
): void {
  if (!permissionGranted || !isTauri()) return

  const unread = notifications.filter(n => !n.read && !seenIds.has(n.id))
  if (unread.length === 0) return

  for (const n of unread) seenIds.add(n.id)

  if (unread.length === 1) {
    const n = unread[0]
    const body = formatNotificationText(n)
    sendNotification({ title: 'Flaxia', body })
    return
  }

  sendNotification({ title: 'Flaxia', body: `${unread.length} new notifications` })
}

async function sendNotification(options: { title: string; body: string }): Promise<void> {
  try {
    const { sendNotification: send } = await import('@tauri-apps/plugin-notification')
    send(options)
  } catch {
    const { default: send } = await import('@tauri-apps/plugin-notification')
    send(options)
  }
}
