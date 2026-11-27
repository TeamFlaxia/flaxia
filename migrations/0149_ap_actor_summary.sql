-- Plain-text bio of a remote actor, taken from the untrusted ActivityPub
-- `summary` field. Only escaped text is stored here (see normalizeActorSummary).
ALTER TABLE ap_actors ADD COLUMN summary TEXT;
