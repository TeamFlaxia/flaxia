-- User titles (称号): small badges shown after a username. Titles are awarded
-- by future systems (for example Arcade achievements); this migration only
-- defines the catalog, ownership, and the single equipped title per user.

CREATE TABLE titles (
  id TEXT PRIMARY KEY,
  icon TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ja TEXT NOT NULL,
  description TEXT NOT NULL,
  description_ja TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE user_titles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  awarded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, title_id)
);

CREATE INDEX idx_user_titles_user ON user_titles(user_id);

ALTER TABLE users ADD COLUMN equipped_title_id TEXT REFERENCES titles(id) ON DELETE SET NULL;

INSERT INTO titles (id, icon, name, name_ja, description, description_ja, sort_order) VALUES
  ('arcade_first_clear', '🎮', 'First Clear', '初クリア', 'Cleared an Arcade game for the first time.', 'アーケードゲームを初めてクリアしました。', 10),
  ('arcade_perfect', '🌟', 'Perfect Run', 'パーフェクトラン', 'Cleared an Arcade game without taking damage.', 'ノーダメージでアーケードゲームをクリアしました。', 20),
  ('arcade_speedster', '⚡', 'Speedster', 'スピードスター', 'Finished an Arcade game under its target time.', 'アーケードゲームを目標タイム以内にクリアしました。', 30),
  ('arcade_collector', '🏆', 'Collector', 'コレクター', 'Earned every achievement in a single Arcade game.', 'ひとつのアーケードゲームの実績をすべて解除しました。', 40),
  ('arcade_legend', '👑', 'Arcade Legend', 'アーケードの伝説', 'Cleared a large collection of Arcade games.', '数多くのアーケードゲームをクリアしました。', 50);
