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
export function buildNoteObject(post: Post, user: User, baseUrl: string): object {
  const noteId = `${baseUrl}/notes/${post.id}`
  const actorUrl = `${baseUrl}/actors/${user.username}`

  const note: any = {
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    content: post.text,
    published: post.created_at,
    url: noteId,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${baseUrl}/actors/${user.username}/followers`]
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
