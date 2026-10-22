# Admin DB analytics

Open `/admin` and select **DB analytics**, or open `/admin/analytics` directly.
The SPA checks `/api/admin/access` before rendering admin content. Both that
endpoint and `GET /api/admin/analytics?days=30` use the existing session and
admin authorization middleware. Anonymous requests receive 401; non-admins
(including reviewers) receive 403. Successful analytics responses use
`Cache-Control: private, no-store` and contain aggregates only.

The optional `days` parameter accepts exactly 7, 30, or 90 (default: 30).
Periods start at midnight UTC and include today up to the response's `end`
timestamp. Days with no activity have zero counts.

| Metric | Source / definition |
| --- | --- |
| Total users / posts | Currently retained local accounts and their posts, across all time |
| New users | `users.created_at` within the period |
| Posts | `posts.created_at`, joined to local `users`; includes replies and hidden posts |
| Freshs | Retained `freshs` rows by `created_at`; remote ActivityPub likes are excluded |
| Play records / duration | `user_game_plays` rows and sum of `dwell_ms`; not unique game launches |
| Engaged users | Distinct local user IDs with a post, Fresh, or play record, deduplicated separately for each day and the whole period |

These are operational DB metrics, not GA4 page views, visitors, or sessions.
Read-only visitors are not represented. Deleted records and undone Freshs change
historical counts. Migration 0106 backfilled older Fresh timestamps at migration
time, so those dates are not their original event dates. No GA4 history is
imported, and no new browser identifiers, URLs, IPs, or tracking events are stored.

## Rollout

Apply `0109_admin_analytics_indexes.sql` using the normal D1 migration workflow
before deploying. It adds only time-range indexes on existing tables (users,
freshs, user_game_plays); no data backfill or external analytics credentials are
required. Queries are bounded to at most 90 calendar days, with separate lifetime
counts. They run on demand rather than polling automatically.

The GA4 tag, its performance-metric sender, and its CSP script permissions have
been removed. Cloudflare infrastructure analytics and AdSense are separate
integrations and retain their existing configuration.
