-- Add type column to chat_servers for DM support
ALTER TABLE chat_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'server' CHECK(type IN ('server', 'dm'));
