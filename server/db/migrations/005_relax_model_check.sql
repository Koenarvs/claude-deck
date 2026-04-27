-- Relax the model CHECK constraint on goals to allow arbitrary model strings.
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.

DROP TABLE IF EXISTS goals_new;

CREATE TABLE goals_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'waiting', 'complete', 'archived')),
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  current_session_id TEXT,
  model TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'supervised' CHECK (permission_mode IN ('autonomous', 'supervised')),
  plan_json TEXT,
  kanban_order REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

INSERT INTO goals_new SELECT * FROM goals;
DROP TABLE goals;
ALTER TABLE goals_new RENAME TO goals;

CREATE INDEX IF NOT EXISTS idx_goals_status_kanban ON goals (status, kanban_order);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, strftime('%s', 'now'));
