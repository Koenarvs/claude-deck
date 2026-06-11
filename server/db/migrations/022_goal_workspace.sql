-- 5B Workspace isolation: one provisioned workspace per goal.
CREATE TABLE IF NOT EXISTS goal_workspace (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  branch TEXT NOT NULL,            -- e.g. 'goal/<short-id>-<slug>'
  worktree_path TEXT NOT NULL,     -- absolute path the PTY runs in
  base_ref TEXT NOT NULL,          -- ref the diff is computed against (e.g. 'main' or a SHA)
  mode TEXT NOT NULL DEFAULT 'worktree'
    CHECK (mode IN ('worktree', 'branch')),
  created_at INTEGER NOT NULL
);

-- 5D survivability: durable resume state on the session row.
ALTER TABLE sessions ADD COLUMN provider_session_id TEXT; -- provider's own resume id (Claude: == session id)
ALTER TABLE sessions ADD COLUMN workspace_path TEXT;      -- cwd to resume in across restarts
