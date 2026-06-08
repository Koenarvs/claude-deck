CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT PRIMARY KEY,
  project_dir TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  session_date TEXT NOT NULL,
  first_message_at INTEGER NOT NULL,
  last_message_at INTEGER,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_usage_date ON session_usage (session_date);
CREATE INDEX IF NOT EXISTS idx_session_usage_first_msg ON session_usage (first_message_at);
