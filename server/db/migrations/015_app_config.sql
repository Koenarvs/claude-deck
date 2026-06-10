-- Migration 015: single-row app configuration stored as a JSON blob.
-- The providers record shape lives entirely in the Zod PersistedConfigSchema;
-- config_json is an opaque TEXT blob, so no column change is ever needed for it.
CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (15);
