-- Performance: index hook_events for session-scoped queries.
-- Without this, /api/sessions's per-session currentTool subquery scans the
-- full hook_events table for every session in the list (was 18s+ at 22k rows;
-- drops to ~30ms with the index). Also speeds up GET /sessions/:id/events.

CREATE INDEX IF NOT EXISTS idx_hook_events_session_event_created
  ON hook_events (session_id, event_type, created_at);
