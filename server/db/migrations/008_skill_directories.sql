-- Migration 008: Skill directories for session-time skill injection.
-- Moves custom skill directory config from browser localStorage to the DB
-- so the server can read them at session spawn time.

CREATE TABLE IF NOT EXISTS skill_directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version) VALUES (8);
