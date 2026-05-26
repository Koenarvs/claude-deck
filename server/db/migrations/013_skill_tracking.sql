-- Skill execution tracking, improvement suggestions, and version history

CREATE TABLE IF NOT EXISTS skill_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  skill_name TEXT NOT NULL,
  skill_path TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_s REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  tool_call_count INTEGER DEFAULT 0,
  tool_error_count INTEGER DEFAULT 0,
  goal_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'success', 'failure', 'partial')),
  user_rating INTEGER CHECK (user_rating IS NULL OR (user_rating >= 1 AND user_rating <= 5)),
  user_notes TEXT,
  created_at INTEGER NOT NULL,
  content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_executions_session ON skill_executions (session_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_skill ON skill_executions (skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_executions_goal ON skill_executions (goal_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_started ON skill_executions (started_at);

CREATE TABLE IF NOT EXISTS skill_suggestions (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  skill_path TEXT,
  execution_id TEXT,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('description', 'instruction', 'parameter', 'structure')),
  title TEXT NOT NULL,
  description TEXT,
  diff_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_suggestions_skill ON skill_suggestions (skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_status ON skill_suggestions (status);
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_execution ON skill_suggestions (execution_id);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  content_snapshot TEXT NOT NULL,
  change_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions (skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_versions_number ON skill_versions (skill_name, version_number);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (13);
