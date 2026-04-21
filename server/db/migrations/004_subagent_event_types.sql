-- Migration 004: Add SubagentStart/SubagentStop to hook_events CHECK constraint

CREATE TABLE IF NOT EXISTS hook_events_v4 (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT CHECK (event_type IN ('SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop')),
  tool_name TEXT,
  payload_json TEXT,
  created_at INTEGER
);

INSERT OR IGNORE INTO hook_events_v4 SELECT * FROM hook_events;
DROP TABLE IF EXISTS hook_events;
ALTER TABLE hook_events_v4 RENAME TO hook_events;

CREATE INDEX IF NOT EXISTS idx_hook_events_type_created ON hook_events (event_type, created_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, strftime('%s', 'now'));
