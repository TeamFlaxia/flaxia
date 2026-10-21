-- Remove the Lounge: direct messages, group chats, chat servers, voice/video
-- calls, and the E2EE messenger key material that backed them. The E2EE
-- implementation was incomplete and is being removed wholesale.
--
-- Historical migrations that created these tables are intentionally left in
-- place (they are already applied in existing databases and later migrations
-- reference them); this migration drops the resulting schema.
--
-- Children are dropped before parents to satisfy foreign keys.

-- --- Direct messages ---------------------------------------------------------
DROP TABLE IF EXISTS dm_message_plaintext;
DROP TABLE IF EXISTS dm_messages;
DROP TABLE IF EXISTS dm_conversations;

-- --- Group chats -------------------------------------------------------------
DROP TABLE IF EXISTS group_channel_keys;
DROP TABLE IF EXISTS group_read_states;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS group_conversations;

-- --- Chat servers ------------------------------------------------------------
DROP TABLE IF EXISTS server_read_states;
DROP TABLE IF EXISTS server_channel_keys;
DROP TABLE IF EXISTS server_messages;
DROP TABLE IF EXISTS server_channels;
DROP TABLE IF EXISTS server_invites;
DROP TABLE IF EXISTS server_members;
DROP TABLE IF EXISTS server_conversations;

-- --- Calls -------------------------------------------------------------------
DROP TABLE IF EXISTS call_participants;
DROP TABLE IF EXISTS calls;

-- --- E2EE messenger key material --------------------------------------------
DROP TABLE IF EXISTS messenger_ratchet_reset_requests;
DROP TABLE IF EXISTS messenger_ratchet_sessions;
DROP TABLE IF EXISTS messenger_opks;
DROP TABLE IF EXISTS messenger_identity_v2;
DROP TABLE IF EXISTS messenger_keys;

-- --- Legacy chat tables (already dropped by 0043; harmless belt-and-braces) --
DROP TABLE IF EXISTS chat_message_reactions;
DROP TABLE IF EXISTS chat_read_states;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_channels;
DROP TABLE IF EXISTS chat_server_members;
DROP TABLE IF EXISTS chat_servers;