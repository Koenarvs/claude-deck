-- Migration 003: Add display_name and parent_session_id to sessions
-- Uses CREATE TABLE + copy approach since SQLite ALTER TABLE ADD COLUMN
-- fails if column already exists (no IF NOT EXISTS for columns)

CREATE TABLE IF NOT EXISTS sessions_v3 (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  origin TEXT CHECK (origin IN ('dashboard', 'external')),
  cwd TEXT,
  model TEXT,
  display_name TEXT,
  parent_session_id TEXT,
  trace_dir TEXT,
  stream_event_count INTEGER DEFAULT 0,
  hook_event_count INTEGER DEFAULT 0,
  stderr_bytes INTEGER DEFAULT 0,
  total_cost_usd REAL,
  total_tokens_in INTEGER,
  total_tokens_out INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);

INSERT OR IGNORE INTO sessions_v3 SELECT id, goal_id, origin, cwd, model, NULL, NULL, trace_dir, stream_event_count, hook_event_count, stderr_bytes, total_cost_usd, total_tokens_in, total_tokens_out, started_at, ended_at FROM sessions;
DROP TABLE IF EXISTS sessions;
ALTER TABLE sessions_v3 RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status_kanban ON sessions (origin, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_goal ON sessions (goal_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, strftime('%s', 'now'));
