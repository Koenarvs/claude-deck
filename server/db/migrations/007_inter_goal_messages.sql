-- Migration 007: Inter-goal messaging for goal-to-goal orchestration.
-- Allows a "control" goal to send instructions to other goals.

CREATE TABLE IF NOT EXISTS inter_goal_messages (
  id TEXT PRIMARY KEY,
  from_goal_id TEXT NOT NULL REFERENCES goals(id),
  to_goal_id TEXT NOT NULL REFERENCES goals(id),
  content TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('instruction', 'result', 'status_update', 'context')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'acknowledged')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acknowledged_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_igm_to_goal ON inter_goal_messages(to_goal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_igm_from_goal ON inter_goal_messages(from_goal_id, created_at);

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version) VALUES (7);
