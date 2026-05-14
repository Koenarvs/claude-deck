INSERT INTO schema_migrations (version) VALUES (11);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_title_active
  ON goals (title COLLATE NOCASE)
  WHERE status != 'archived';
