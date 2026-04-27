-- Migration 006: Drop dead token/cost columns from sessions and messages.
-- These columns were never reliably populated and token/cost data is now
-- sourced from Claude Code JSONL log files via usage-service.ts.
--
-- Dropped from sessions: total_cost_usd, total_tokens_in, total_tokens_out
-- Dropped from messages:  token_in, token_out

-- ── Recreate sessions without dead columns ──────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions_v6 (
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
  started_at INTEGER,
  ended_at INTEGER
);

INSERT OR IGNORE INTO sessions_v6
  SELECT id, goal_id, origin, cwd, model, display_name, parent_session_id, trace_dir,
         stream_event_count, hook_event_count, stderr_bytes, started_at, ended_at
  FROM sessions;

DROP TABLE IF EXISTS sessions;
ALTER TABLE sessions_v6 RENAME TO sessions;

-- Recreate indexes (from migrations 001 + 003)
CREATE INDEX IF NOT EXISTS idx_sessions_status_kanban ON sessions (origin, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_goal ON sessions (goal_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id);

-- ── Recreate messages without dead columns ──────────────────────────────────

CREATE TABLE IF NOT EXISTS messages_v6 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT CHECK (role IN ('user', 'assistant', 'system', 'tool_use', 'tool_result')),
  content TEXT,
  tool_name TEXT,
  tool_args TEXT,
  tool_result TEXT,
  tool_use_id TEXT,
  created_at INTEGER
);

INSERT OR IGNORE INTO messages_v6
  SELECT id, session_id, role, content, tool_name, tool_args, tool_result, tool_use_id, created_at
  FROM messages;

DROP TABLE IF EXISTS messages;
ALTER TABLE messages_v6 RENAME TO messages;

-- Recreate index (from migration 001)
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages (session_id, created_at);

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, strftime('%s', 'now'));
