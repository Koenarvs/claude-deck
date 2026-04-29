-- Migration 009: Backfill delivered_at/acknowledged_at on inter_goal_messages.
-- On existing installs, migration 007 ran before these columns were added to its
-- CREATE TABLE. On fresh installs they already exist. This is a no-op placeholder
-- so the version is recorded; the actual column check runs in migrate.ts.

INSERT OR IGNORE INTO schema_migrations (version) VALUES (9);
