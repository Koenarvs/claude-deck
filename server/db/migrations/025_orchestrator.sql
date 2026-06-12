-- Always-on orchestrator: chat thread + singleton lifecycle/config state.

CREATE TABLE IF NOT EXISTS orchestrator_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'orchestrator', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('app', 'discord', 'internal')),
  content TEXT NOT NULL,
  tool_calls_json TEXT,
  trigger_kind TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_created ON orchestrator_messages (created_at);

CREATE TABLE IF NOT EXISTS orchestrator_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'waking', 'active', 'cooling')),
  last_wake_at INTEGER,
  last_active_at INTEGER,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO orchestrator_state (id, status, config_json, updated_at)
VALUES (
  1,
  'idle',
  '{"enabled":false,"persona_name":"Hawat","model":"haiku","idle_timeout_ms":600000,"max_concurrent_children":3,"max_depth":2}',
  0
);
