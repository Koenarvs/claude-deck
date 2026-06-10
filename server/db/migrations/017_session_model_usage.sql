-- Migration 017: per-model usage breakdown (Phase 2 analytics overhaul).
-- One row per (session, model). The parent session_usage row stays as the
-- session-level rollup (back-compat); these rows attribute tokens/cost per model.
CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL DEFAULT 'claude',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0 CHECK (unpriced IN (0, 1)),
  message_count INTEGER NOT NULL DEFAULT 0,
  session_date TEXT NOT NULL,
  first_message_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, model)
);

CREATE INDEX IF NOT EXISTS idx_smu_model ON session_model_usage (model);
CREATE INDEX IF NOT EXISTS idx_smu_date_model ON session_model_usage (session_date, model);
CREATE INDEX IF NOT EXISTS idx_smu_session ON session_model_usage (session_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (17);
