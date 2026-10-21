-- Multiplayer rooms
CREATE TABLE IF NOT EXISTS multiplayer_rooms (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  max_players INTEGER NOT NULL DEFAULT 2,
  is_public INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_multiplayer_rooms_game ON multiplayer_rooms(game_id, status);
CREATE INDEX IF NOT EXISTS idx_multiplayer_rooms_public ON multiplayer_rooms(is_public, status, created_at DESC);

-- Multiplayer room participants (persistent record)
CREATE TABLE IF NOT EXISTS multiplayer_room_participants (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_key TEXT,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  is_host INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

-- Multiplayer scores
CREATE TABLE IF NOT EXISTS multiplayer_scores (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score REAL NOT NULL,
  label TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multiplayer_scores_game ON multiplayer_scores(game_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_multiplayer_scores_user ON multiplayer_scores(game_id, user_id, score DESC);

-- Multiplayer invites
CREATE TABLE IF NOT EXISTS multiplayer_invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multiplayer_invites_to ON multiplayer_invites(to_user_id, status, created_at DESC);
