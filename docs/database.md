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
| password_hash | TEXT | Legacy only; always `''` on SRP accounts |
| srp_salt | TEXT | SRP salt; `NULL` = pre-SRP account |
| srp_verifier | TEXT | SRP verifier `v` (the server never computes `x`) |
| srp_group | TEXT | SRP group (`2048`) |
| srp_kdf | TEXT | `sha256-v1` or `pbkdf2-600k-v2` (migration 0090) |
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

### `post_attachments`
Multiple image/audio/video files per post (max 4). Game payloads (zip/swf/html)
keep using the legacy single-key columns on `posts`.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER | autoincrement, PK |
| post_id | TEXT | FK → posts(id), ON DELETE CASCADE |
| r2_key | TEXT | `gif\|audio\|video/{postId}/{position}{ext}` |
| kind | TEXT | 'image', 'audio', 'video' (CHECK) |
| position | INTEGER | 1..4 display order |
| created_at | INTEGER | unixepoch |

Index: `idx_post_attachments_post (post_id, position)`

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

### `subscriptions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| stripe_subscription_id | TEXT | UNIQUE |
| stripe_customer_id | TEXT | |
| plan_id | TEXT | `flaxia_plus`, `flaxia_plus_plus`, `flaxia_sharp` |
| status | TEXT | `active`, `canceled`, `past_due`, `incomplete`, `incomplete_expired`, `trialing`, `unpaid`, `paused` |
| cancel_at_period_end | INTEGER | 1 = 期間終了時に解約（migration 0088） |
| current_period_start | TEXT | ISO 8601 |
| current_period_end | TEXT | ISO 8601 |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### `transactions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| post_id | TEXT | FK → posts(id) (marketplace only) |
| stripe_session_id | TEXT | UNIQUE |
| stripe_payment_intent_id | TEXT | |
| stripe_invoice_id | TEXT | UNIQUE（継続課金の請求、migration 0088） |
| type | TEXT | `subscription` or `marketplace` |
| plan_id | TEXT | (subscription only) |
| amount | INTEGER | Amount in JPY |
| currency | TEXT | Default: `jpy` |
| status | TEXT | `pending`, `completed`, `failed`, `refunded` |
| metadata | TEXT | JSON (optional) |
| created_at | TEXT | ISO 8601 |

### `stripe_events`
Webhook の `event.id` を記録し、Stripe の再送を冪等に処理する（migration 0088）。

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK (Stripe event id) |
| type | TEXT | Event type |
| created_at | TEXT | ISO 8601 |

`users.stripe_customer_id` は Stripe Customer を保持し、checkout ごとの
Customer 二重作成を防ぐ（migration 0088）。

## Personal Vault (E2EE)

Encrypted personal storage (drafts, notes, settings) — threat model and key
hierarchy in `docs/e2ee.md`. Every value below is opaque ciphertext produced
in the browser; migrations `0091` (tables) and `0092` (device pairing).

The device that enables the vault is inserted into `device_keys` in the same
batch (active, empty pairing fields, id chosen by the client) so even the
first device has a row that can be revoked.

### `vault_keys`
| Column | Type | Notes |
|---|---|---|
| user_id | TEXT | PK → users(id) |
| salt | TEXT | 16 B, salts the password-derived KEK |
| recovery_salt | TEXT | 16 B, independent of `salt` |
| kdf_params | TEXT | JSON `{"alg":"PBKDF2-SHA256","iterations":600000}` |
| wrapped_vk | TEXT | `base64(iv).base64(ct)`, KEK-wrapped VK |
| recovery_blob | TEXT | `base64(iv).base64(ct)`, REK-wrapped VK |
| vk_version | INTEGER | incremented on rotation |

### `device_keys`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK, shown in the joiner's QR |
| user_id | TEXT | FK → users(id) |
| label | TEXT | user-visible device name |
| state | TEXT | `pending` → `active` (check-constrained) |
| peer_pub | TEXT | joiner's ephemeral X25519 public key (base64) |
| approved_pub | TEXT | approver's ephemeral X25519 public key (base64) |
| wrapped_vk | TEXT | VK wrapped under the pairing secret; `''` while pending |
| created_at | TEXT | |
| expires_at | TEXT | pending only; QR dies after this (default +10 min) |
| last_seen_at | TEXT | set when a pairing is approved |

### `vault_items`
| Column | Type | Notes |
|---|---|---|
| id | TEXT | client-generated, part of PK, also the AAD |
| user_id | TEXT | part of PK |
| item_key_wrapped | TEXT | VK-wrapped per-item key |
| payload | TEXT | AES-256-GCM ciphertext of the body |
| kind | TEXT | `draft` / `note` / `settings` |
| vk_version | INTEGER | VK version at wrap time |

## Other Tables

- `reports` — User reports with reason and status
- `ng_words` — Filtered words
- `hidden_posts` — Hidden/moderated posts
- `post_thumbnails` — Generated thumbnails for ZIP/SWF posts
- `polls` — Poll options and votes
