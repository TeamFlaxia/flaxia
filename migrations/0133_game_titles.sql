-- Game titles (ゲーム称号): achievement badges a game authors and grants
-- through the Game API. `game_post_id` is NULL for platform titles (the
-- account-creation title and anything seeded by the platform). A non-NULL value
-- ties the title to the game post that authored it, so a game can only ever
-- create and grant titles scoped to itself — never a platform title and never
-- another game's title.

ALTER TABLE titles ADD COLUMN game_post_id TEXT;

CREATE INDEX idx_titles_game_post_id ON titles(game_post_id);
