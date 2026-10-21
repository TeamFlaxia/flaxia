# Post Translation Feature (M2M100-418M)

## Goal
Translate post content using a small language model (M2M100-418M) running on Crowd Worker (Transformers.js in browser nodes).

## License
MIT (M2M100-418M) — compatible with commercial use.

---

## Tasks

### 1. Database Migration
- [ ] Create `migrations/0038_add_post_translations.sql`

```sql
CREATE TABLE IF NOT EXISTS post_translations (
  post_id TEXT NOT NULL,
  language TEXT NOT NULL,         -- target language code (e.g. 'en', 'ja')
  translated_text TEXT NOT NULL DEFAULT '',
  task_id TEXT,                   -- Crowd Worker task ID (non-null = in progress)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, language)
);
```

### 2. Type Definitions
- [ ] Add `author_language?: string` to `Post` interface in `src/types/post.ts`

### 3. Backend API — Post Queries
- [ ] Add `u.language as author_language` to every post SELECT query in `functions/api/[[route]].ts`:
  - Timeline (`GET /api/posts`)
  - Single post (`GET /api/posts/:id`)
  - Thread (`GET /api/posts/:id/thread`)
  - Trending (`GET /api/posts/trending`)
  - Recommended (`GET /api/posts/recommended`)
  - Search results
  - User profile posts
  - Replies (`GET /api/posts/:id/replies`)

### 4. Backend API — Translation Endpoints
- [ ] Add `POST /api/posts/:id/translate?target=<lang>` endpoint
  - Auth required
  - Look up post + author's language
  - Check `post_translations` cache → return immediately if done
  - Submit translation task to Crowd Worker
  - Store `task_id` in `post_translations`
  - Return `{ status: 'processing' }` (202)

- [ ] Add `GET /api/posts/:id/translate?target=<lang>` endpoint
  - Check `post_translations` for completed translation
  - Return `{ status: 'done', translated_text }` or `{ status: 'processing' }`

### 5. Backend — WebHook
- [ ] Update `functions/api/crowd/[[route]].ts` POST handler
  - Parse `?type=translation&postId=xxx&lang=ja` from callback URL
  - Extract `output[0].translation_text` from result
  - Store in `post_translations` table via `UPDATE`
  - Existing sentiment analysis path unchanged

### 6. Frontend — PostCard Translation UI
- [ ] Modify `src/components/PostCard.ts`
  - Read `authorLanguage` from post data
  - Get current UI locale via `getLocale()`
  - Show **"Translate to XXX"** button below post text (only when `authorLanguage !== currentLocale`)
  - On click:
    1. `POST /api/posts/:id/translate?target=<locale>`
    2. Poll via `GET /api/posts/:id/translate?target=<locale>` every 2s
    3. Replace post text with translated text on completion
    4. Add **"Show original"** link to toggle back
  - Listen for `localechange` event → re-translate automatically

### 7. Verification
- [ ] Run `pnpm run lint`
- [ ] Run `pnpm run typecheck`
- [ ] Test translation flow end-to-end

---

## Architecture

```
PostCard (translate button)
  │ POST /api/posts/:id/translate?target=en
  ▼
[[route]].ts → Crowd Worker
  │ model: Xenova/m2m100_418M (int8)
  │ src_lang: author_language (from users table)
  │ tgt_lang: viewer's UI locale
  ▼
Orchestrator → Browser Node (Transformers.js)
  ▼
WebHook → post_translations table
  ▼
PostCard polls GET endpoint → display translated text
```
