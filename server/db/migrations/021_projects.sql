-- 5A Project Registry: known repos with per-project defaults.
-- Doubles as the cwd allow-list consumed by the path-containment guards.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,          -- absolute repo root; the allow-list anchor
  allowed_models TEXT NOT NULL DEFAULT '[]', -- JSON string[] of model ids; [] = any
  default_permission_mode TEXT NOT NULL DEFAULT 'supervised'
    CHECK (default_permission_mode IN ('autonomous', 'supervised')),
  done_command TEXT,                        -- e.g. 'npm run typecheck && npm test' (5C consumer)
  worktree_root TEXT,                       -- where 5B provisions worktrees; NULL = sibling dir
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects (root_path);

-- Link goals to a registered project (nullable: legacy goals + ad-hoc cwds).
ALTER TABLE goals ADD COLUMN project_id TEXT REFERENCES projects(id);
