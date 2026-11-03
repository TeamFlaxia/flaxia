export const EXACT_DUPLICATE_CONDITION = `(
  trim(p.text) = '' OR NOT EXISTS (
    SELECT 1 FROM posts dup
    WHERE dup.user_id = p.user_id
      AND dup.text = p.text
      AND dup.status = 'published'
      AND dup.hidden = 0
      AND dup.parent_id IS p.parent_id
      AND (dup.created_at > p.created_at OR (dup.created_at = p.created_at AND dup.rowid > p.rowid))
  )
)`;

export const EXACT_DUPLICATE_FILTER = `AND ${EXACT_DUPLICATE_CONDITION}`;
