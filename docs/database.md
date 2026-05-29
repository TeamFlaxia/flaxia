# Database Schema

## Overview

Flaxia uses Cloudflare D1 (SQLite-compatible) with migrations in `migrations/`.

## Core Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | nanoid, PK |
| email | TEXT | Unique |
| username | TEXT | Unique, used in URLs |
| display_name | TEXT | |
| bio | TEXT | |
| avatar_key | TEXT | R2 key for avatar |
| password_hash | TEXT | bcrypt |
| created_at | TEXT | ISO 8601 |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| token | TEXT | Session token (hashed) |
| expires_at | TEXT | |
| created_at | TEXT | |

### `posts`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | nanoid, PK |
| user_id | TEXT | FK → users(id) |
| text | TEXT | ≤ 200 chars |
| hashtags | TEXT | JSON array |
| payload_key | TEXT | R2 key for ZIP/SWF |
| payload_type | TEXT | 'zip', 'swf', 'image', 'audio' |
| gif_key | TEXT | R2 key for GIF preview |
| parent_id | TEXT | For replies, FK → posts(id) |
| fresh_count | INTEGER | Denormalized like count |
| share_count | INTEGER | Denormalized share count |
| created_at | TEXT | ISO 8601 |

### `freshs` (Likes)
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| user_id | TEXT | FK → users(id) |
| PRIMARY KEY | (post_id, user_id) | |

### `follows`
| Column | Type | Notes |
|---|---|---|
| follower_id | TEXT | FK → users(id) |
| followee_id | TEXT | FK → users(id) |
| PRIMARY KEY | (follower_id, followee_id) | |

### `shares`
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| user_id | TEXT | FK → users(id) |
| PRIMARY KEY | (post_id, user_id) | |

### `bookmarks`
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| user_id | TEXT | FK → users(id) |
| PRIMARY KEY | (post_id, user_id) | |

### `notifications`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK |
| user_id | TEXT | Recipient |
| actor_id | TEXT | Who performed action |
| type | TEXT | 'fresh', 'follow', 'reply', 'share' |
| post_id | TEXT | Related post (nullable) |
| read | INTEGER | 0/1 |
| created_at | TEXT | |

### `mentions`
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| user_id | TEXT | FK → users(id) |
| PRIMARY KEY | (post_id, user_id) | |

## ActivityPub Tables

### `ap_actor_keys`
| Column | Type | Notes |
|---|---|---|
| user_id | TEXT | FK → users(id), PK |
| private_key | TEXT | RSA private key |
| public_key | TEXT | RSA public key |

### `ap_followers`
| Column | Type | Notes |
|---|---|---|
| user_id | TEXT | Local user |
| actor_url | TEXT | Remote actor URL |
| inbox_url | TEXT | Remote inbox |
| status | TEXT | 'pending', 'accepted' |
| created_at | TEXT | |

### `ap_liked`
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| actor_url | TEXT | Remote actor URL |
| PRIMARY KEY | (post_id, actor_url) | |

### `ap_shares`
| Column | Type | Notes |
|---|---|---|
| post_id | TEXT | FK → posts(id) |
| actor_url | TEXT | Remote actor URL |
| PRIMARY KEY | (post_id, actor_url) | |

## Ads Tables

### `ads`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | nanoid, PK |
| title | TEXT | Admin label |
| body_text | TEXT | ≤ 200 chars |
| payload_key | TEXT | R2 key |
| payload_type | TEXT | 'zip', 'swf', 'gif', 'image' |
| click_url | TEXT | Destination URL |
| active | INTEGER | 0/1 |
| impressions | INTEGER | Counter |
| clicks | INTEGER | Counter |
| created_at | TEXT | |

### `ad_interactions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK |
| ad_id | TEXT | FK → ads(id) |
| duration_ms | INTEGER | |
| created_at | TEXT | |

### `ad_config`
| Column | Type | Notes |
|---|---|---|
| key | TEXT | PK (e.g., 'every_n') |
| value | TEXT | |

## Other Tables

- `reports` — User reports with reason and status
- `ng_words` — Filtered words
- `hidden_posts` — Hidden/moderated posts
- `post_thumbnails` — Generated thumbnails for ZIP/SWF posts
- `polls` — Poll options and votes
