-- Voice channel support for Discord-style chat servers.

-- Channel type: 'text' (default) or 'voice'.
ALTER TABLE server_channels ADD COLUMN type TEXT NOT NULL DEFAULT 'text';

-- Link calls to a server voice channel.
ALTER TABLE calls ADD COLUMN server_channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_calls_server_channel ON calls(server_channel_id);

-- Backfill a default #general text channel for servers created before this
-- migration. Channel keys are bootstrapped lazily by the owner/admin when the
-- channel is first opened (see ServerView.ensureChannelReady).
INSERT INTO server_channels (id, server_id, name, category, position, type, key_version)
SELECT 'general_' || s.id, s.id, 'general', NULL, 0, 'text', 1
FROM server_conversations s
WHERE NOT EXISTS (
  SELECT 1 FROM server_channels sc WHERE sc.server_id = s.id AND sc.name = 'general'
);
