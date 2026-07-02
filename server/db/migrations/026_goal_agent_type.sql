-- Add agent_type column to goals table.
-- Nullable: most goals use default session behavior (no agent override).
-- Values match Claude CLI --agent names (e.g. 'orchestrator', 'dev-looker').

ALTER TABLE goals ADD COLUMN agent_type TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (26, strftime('%s', 'now'));
