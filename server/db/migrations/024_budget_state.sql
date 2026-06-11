-- 5E Budget/quota guardrails: non-derivable state (kill switch, alarm log).
CREATE TABLE IF NOT EXISTS budget_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Global kill switch (off by default).
INSERT OR IGNORE INTO budget_state (key, value_json, updated_at)
VALUES ('kill_switch', '{"active":false}', unixepoch() * 1000);
