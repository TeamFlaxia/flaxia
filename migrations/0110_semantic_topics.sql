-- Automatic topics come from Crowd's multilingual embedding model, not text rules.
ALTER TABLE posts ADD COLUMN auto_topic_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN auto_topic_version TEXT;
ALTER TABLE post_embeddings ADD COLUMN source_sha TEXT;

CREATE TABLE topic_prototypes (
  tag TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  embedding TEXT,
  model TEXT,
  token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);

-- Every publishing path, including replies and federation, gets queued.
CREATE TRIGGER posts_queue_topic_embedding_insert AFTER INSERT ON posts
WHEN NEW.status = 'published' AND NEW.hidden = 0 AND trim(NEW.text) != ''
BEGIN
  INSERT INTO pending_embeddings (post_id, text) VALUES (NEW.id, NEW.text)
  ON CONFLICT(post_id) DO UPDATE SET text = excluded.text, attempts = 0, last_error = NULL;
END;

CREATE TRIGGER posts_invalidate_topics AFTER UPDATE OF text, status ON posts
WHEN NEW.text != OLD.text OR (NEW.status = 'published' AND OLD.status != 'published')
BEGIN
  UPDATE posts SET auto_topic_tags = '[]', auto_topic_version = NULL WHERE id = NEW.id;
  DELETE FROM post_embeddings WHERE post_id = NEW.id;
  INSERT INTO pending_embeddings (post_id, text)
    SELECT NEW.id, NEW.text WHERE NEW.status = 'published' AND NEW.hidden = 0 AND trim(NEW.text) != ''
  ON CONFLICT(post_id) DO UPDATE SET text = excluded.text, attempts = 0, last_error = NULL;
END;

CREATE TRIGGER posts_delete_topic_embedding AFTER DELETE ON posts
BEGIN
  DELETE FROM post_embeddings WHERE post_id = OLD.id;
  DELETE FROM pending_embeddings WHERE post_id = OLD.id;
END;
