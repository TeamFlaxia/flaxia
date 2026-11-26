-- A private reply must be readable by the followers of the original thread
-- author, not by the followers of whoever happened to write the reply.
--
-- replies.ts stores the parent author id here when a reply inherits
-- `private`; legacy rows keep NULL and therefore keep the old rule (the
-- poster's own followers) via COALESCE in visibilityFilter().
ALTER TABLE posts ADD COLUMN visibility_root_author_id TEXT;
