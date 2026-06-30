# API Reference

All API endpoints are served from `functions/api/[[route]].ts` via Hono framework.

---

## Authentication

### Register
`POST /api/auth/register`
- Body: `{ email, password, username }`
- Returns session cookie

### Login
`POST /api/auth/login`
- Body: `{ email, password }`
- Returns session cookie

### Logout
`POST /api/auth/logout`

### Me
`GET /api/auth/me`
- Returns current user info

---

## Posts

### Create Post
`POST /api/posts`
- Multipart: `text` (≤200 chars), optional `files` (image/audio/zip/swf)
- Returns: `{ post: Post }`

### Get Timeline
`GET /api/posts?cursor=<created_at>&limit=20`
- Returns posts from followed users
- Cursor-based pagination

### Get Post Thread
`GET /api/posts/:id`

### Delete Post
`DELETE /api/posts/:id`

### Like (Fresh)
`POST /api/posts/:id/fresh`

### Share
`POST /api/posts/:id/share`

### Bookmark
`POST /api/posts/:id/bookmark`
`DELETE /api/posts/:id/bookmark`

---

## Upload

### Prepare Upload
`POST /api/posts/prepare`
- Body: `{ contentType }`
- Returns: `{ postId, uploadUrl, uploadKey }`

### Upload File
`PUT /api/upload/:type/:postId`
- Binary upload directly to R2

### Commit Post
`POST /api/posts/commit`
- Body: `{ postId }`

---

## Users

### Get Profile
`GET /api/users/:username`

### Follow
`POST /api/follows/:userId`
`DELETE /api/follows/:userId`

### Followers / Following
`GET /api/users/:username/followers`
`GET /api/users/:username/following`

### Update Profile
`PATCH /api/users/me`

---

## Search

`GET /api/search?q=<query>&type=<posts|users|hashtags>`

---

## Notifications

`GET /api/notifications`

---

## Arcade (Game Posts)

`GET /api/games?cursor=&limit=`

---

## Advertisements

### Public
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ads/active` | Active ads (randomized) |
| POST | `/api/ads/:id/impression` | Record impression |
| POST | `/api/ads/:id/click` | Record click |
| POST | `/api/ads/:id/interaction` | Record interaction duration |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/ads` | List all ads with stats |
| POST | `/api/admin/ads` | Create ad (multipart) |
| PATCH | `/api/admin/ads/:id` | Update ad |
| DELETE | `/api/admin/ads/:id` | Delete ad |
| GET | `/api/admin/ads/config` | Get ad config |
| PATCH | `/api/admin/ads/config` | Update ad config |

---

## ActivityPub

### WebFinger
`GET /.well-known/webfinger?resource=acct:user@domain`

### NodeInfo
`GET /.well-known/nodeinfo`
`GET /api/nodeinfo/2.1`

### Actor
`GET /api/actors/:username`

### Inbox (ActivityPub)
`POST /api/inbox`
- Receives federated activities (Follow, Like, Announce, Undo, Create)

### Outbox
`GET /api/actors/:username/outbox`

---

## Admin

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/alerts` | List moderation alerts |
| POST | `/api/admin/alerts/:id/resolve` | Resolve alert |
| GET | `/api/admin/hidden-posts` | List hidden posts |
| POST | `/api/admin/hidden-posts` | Hide a post |
| DELETE | `/api/admin/hidden-posts/:id` | Unhide post |
| GET | `/api/admin/users` | List all users |
| PATCH | `/api/admin/users/:id` | Update user status |

---

## Misc

### Sitemap
`GET /sitemap.xml`

### Avatar
`GET /api/avatar/:userId`

### Link Preview
`POST /api/link-preview`
- Body: `{ url }`
- Returns: `{ title, description, image, url }`
