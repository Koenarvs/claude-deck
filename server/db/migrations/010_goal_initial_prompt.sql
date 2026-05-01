-- Migration 010: Add initial_prompt column to goals.
-- Stores the initial prompt for goals so the terminal can send it
-- when the user first opens the goal.

INSERT OR IGNORE INTO schema_migrations (version) VALUES (10);
