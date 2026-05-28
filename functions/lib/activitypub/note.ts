/// <reference types="@cloudflare/workers-types" />

interface Post {
  id: string
  text: string
  created_at: string
}

interface User {
  id: string
  username: string
  display_name: string
}

/**
 * Build an ActivityPub Note object from a post
 */
interface PostWithExtras extends Post {
  visibility?: string
  parent_id?: string | null
  root_id?: string | null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textToHtml(text: string, baseUrl: string): string {
  const escaped = escapeHtml(text)
  // Convert URLs to links
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="nofollow noopener noreferrer">$1</a>'
  )
  // Convert @mentions to links
  const withMentions = withLinks.replace(
    /@([a-zA-Z0-9_]{1,20})/g,
    '<span class="h-card"><a href="' + baseUrl + '/actors/$1" class="u-url mention">@<span>$1</span></a></span>'
  )
  // Convert #hashtags to links
  const withHashtags = withMentions.replace(
    /#([^\s<]+)/g,
    '<a href="' + baseUrl + '/tags/$1" class="hashtag" rel="tag">#<span>$1</span></a>'
  )
  // Wrap in paragraph
  return `<p>${withHashtags}</p>`
}

export function buildNoteObject(post: PostWithExtras, user: User, baseUrl: string, mentionActorUrls?: string[]): object {
  const noteId = `${baseUrl}/notes/${post.id}`
  const actorUrl = `${baseUrl}/actors/${user.username}`

  const cc: string[] = [`${baseUrl}/actors/${user.username}/followers`]

  if (mentionActorUrls && mentionActorUrls.length > 0) {
    for (const url of mentionActorUrls) {
      if (!cc.includes(url)) {
        cc.push(url)
      }
    }
  }

  const note: any = {
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    content: textToHtml(post.text, baseUrl),
    published: post.created_at,
    url: noteId,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc
  }

  if (post.parent_id) {
    note.inReplyTo = `${baseUrl}/notes/${post.parent_id}`
  }

  return note
}

/**
 * Build a Create activity for a Note
 */
export function buildCreateActivity(note: object, user: User, baseUrl: string): object {
  const noteId = (note as any).id
  const actorUrl = `${baseUrl}/actors/${user.username}`

  // Extract post ID from note URL to create activity ID
  const postId = noteId.split('/notes/')[1]
  const activityId = `${baseUrl}/activities/create-${postId}`

  const to = (note as any).to || []
  const cc = (note as any).cc || []

  return {
    id: activityId,
    type: 'Create',
    actor: actorUrl,
    object: note,
    to: to,
    cc: cc,
    published: new Date().toISOString()
  }
}

/**
 * Build a Delete activity for a Note
 */
export function buildDeleteActivity(noteId: string, user: User, baseUrl: string): object {
  const actorUrl = `${baseUrl}/actors/${user.username}`
  const activityId = `${baseUrl}/activities/delete-${noteId}`

  return {
    id: activityId,
    type: 'Delete',
    actor: actorUrl,
    object: {
      id: noteId,
      type: 'Tombstone'
    },
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${baseUrl}/actors/${user.username}/followers`],
    published: new Date().toISOString()
  }
}
