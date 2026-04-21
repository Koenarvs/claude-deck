-- Migration 003: Add display_name and parent_session_id to sessions
-- Enables user-friendly session naming and parent-child hierarchy tracking

ALTER TABLE sessions ADD COLUMN display_name TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id);

CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, strftime('%s', 'now'));
