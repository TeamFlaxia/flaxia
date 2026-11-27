-- Arcade display title extracted from a game's index.html <title>.
-- NULL means "not extracted yet"; '' means "no HTML title" (use post text).
ALTER TABLE posts ADD COLUMN game_title TEXT;
