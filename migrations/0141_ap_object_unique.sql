-- A remote Note is stored once per instance, not once per local recipient.
-- The object id is its identity, so a second delivery of the same Note (for
-- another local follower) must not create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_ap_object_id_unique
  ON posts(ap_object_id)
  WHERE ap_object_id IS NOT NULL;
