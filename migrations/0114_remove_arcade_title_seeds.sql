-- The first revision of 0113 seeded five Arcade titles with emoji icons. The
-- catalog is now image-based and only the account-creation title is seeded.
-- Remove the old rows (ownership cascades; equipped references become NULL) so
-- databases that already applied the original migration converge with fresh
-- installs.
DELETE FROM user_titles
WHERE title_id IN (
  'arcade_first_clear',
  'arcade_perfect',
  'arcade_speedster',
  'arcade_collector',
  'arcade_legend'
);

UPDATE users
SET equipped_title_id = NULL
WHERE equipped_title_id IN (
  'arcade_first_clear',
  'arcade_perfect',
  'arcade_speedster',
  'arcade_collector',
  'arcade_legend'
);

DELETE FROM titles
WHERE id IN (
  'arcade_first_clear',
  'arcade_perfect',
  'arcade_speedster',
  'arcade_collector',
  'arcade_legend'
);

-- Older installations never had this row, and an intermediate revision used an
-- emoji glyph. Normalize the icon to the image used by the current catalog.
UPDATE titles SET icon = '/icons/flaxian.png' WHERE id = 'flaxian_newcomer';

INSERT OR IGNORE INTO titles (id, icon, name, name_ja, description, description_ja, sort_order) VALUES
  ('flaxian_newcomer', '/icons/flaxian.png', 'Budding Flaxian', '駆け出しのFlaxian', 'Created a Flaxia account.', 'Flaxiaにアカウント作成をした。', 10);
