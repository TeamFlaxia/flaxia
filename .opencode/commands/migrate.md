---
description: Create and apply a D1 migration
---

Create a new Cloudflare D1 migration for: $ARGUMENTS

1. Add the SQL to `migrations/` using the next sequence number.
2. Apply it locally with `npm run migrate:local`.
3. Ensure `npm run typecheck` still passes.

Follow the existing migration style, including table-recreation patterns when a
CHECK constraint must change.
