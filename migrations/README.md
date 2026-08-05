# Migrations

Flaxia uses Cloudflare D1 migrations applied in filename order (zero-padded numbers).

## Applying

```bash
npm run migrate:local   # local dev D1
npm run migrate:prod    # production D1
```

## Known duplicate numbers (history)

Two migration numbers are duplicated because they were created by different contributors
at different times. They are NOT renamed to avoid breaking existing deployed databases
that already recorded the hashes; new migrations simply continue from the highest number.

- `0021_add_post_impressions_only.sql` and `0021_fix_ad_type_constraint.sql`
- `0039_fix_reports_schema.sql` and `0039_vectorize_posts.sql`

The duplicates are order-independent (they touch disjoint tables), so the repeated number
does not cause schema conflicts.
