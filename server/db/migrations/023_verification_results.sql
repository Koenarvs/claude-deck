-- 5C Verification gate: per-goal/per-session doneCommand outcomes.
CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'skipped', 'running')),
  command TEXT,
  workspace TEXT,
  exit_code INTEGER,
  output TEXT,             -- captured stdout+stderr, truncated to 16k chars by the service
  duration_ms INTEGER,
  model TEXT,              -- per-goal model at completion (for the scorecard)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_goal_created ON verification_results (goal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_status_model ON verification_results (status, model);
