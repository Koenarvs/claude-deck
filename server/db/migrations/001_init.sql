-- Enable WAL mode and foreign keys
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema migrations metadata
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Goals: user-curated objectives
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planning', 'active', 'waiting', 'complete', 'archived')),
  priority INTEGER DEFAULT 0,
  tags TEXT, -- JSON array of strings
  current_session_id TEXT,
  model TEXT CHECK (model IS NULL OR model IN ('opus', 'sonnet', 'haiku', 'default')),
  permission_mode TEXT NOT NULL DEFAULT 'supervised' CHECK (permission_mode IN ('autonomous', 'supervised')),
  plan_json TEXT, -- JSON: PlanJson
  kanban_order REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_goals_status_kanban ON goals (status, kanban_order);

-- Sessions: every claude invocation
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id),
  origin TEXT NOT NULL CHECK (origin IN ('dashboard', 'external')),
  cwd TEXT,
  model TEXT,
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

CREATE INDEX IF NOT EXISTS idx_sessions_goal_started ON sessions (goal_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_origin_started ON sessions (origin, started_at);

-- Messages: per-session chat log
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT CHECK (role IN ('user', 'assistant', 'system', 'tool_use', 'tool_result')),
  content TEXT,
  tool_name TEXT,
  tool_args TEXT, -- JSON
  tool_result TEXT, -- truncated to 4000 chars
  tool_use_id TEXT,
  token_in INTEGER,
  token_out INTEGER,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages (session_id, created_at);

-- Hook events: raw log of every hook fire
CREATE TABLE IF NOT EXISTS hook_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT CHECK (event_type IN ('SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop')),
  tool_name TEXT,
  payload_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hook_events_session_created ON hook_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_type_created ON hook_events (event_type, created_at);

-- Approvals: pending/resolved tool approvals
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  goal_id TEXT,
  tool_name TEXT,
  tool_args TEXT, -- JSON
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'timeout')),
  decided_reason TEXT,
  requested_at INTEGER,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals (status, requested_at);

-- Scheduled tasks: cron-driven goal templates
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  goal_template_json TEXT NOT NULL, -- JSON: GoalTemplate
  enabled INTEGER DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER
);

-- Record migration version
INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
