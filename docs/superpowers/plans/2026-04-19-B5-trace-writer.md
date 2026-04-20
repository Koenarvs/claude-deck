# B5 — Trace Writer + Trace API

**Burst:** Backend | **Depends on:** F0 merged | **Branch:** `feat/B5-trace-writer`

## Goal
Append raw stream-json events, hook payloads, and stderr to per-session JSONL files on disk with byte-level fidelity. Expose download endpoints. Prune old traces on a schedule.

## Spec references
- §4 filesystem layout
- §9 trace capture (writer, fidelity, downstream enablement)
- §5 trace API endpoints
- §13.2 observability acceptance
- §14.2 B5

## Scope
- Create: `server/trace-writer.ts` — `TraceWriter` class per session
- Create: `server/services/trace-service.ts` — factory, get-or-create, close
- Create: `server/routes/trace.ts` — `/api/goals/:id/trace`, `/api/sessions/:id/trace/*`
- Create: `server/trace-pruner.ts` — cron-driven cleanup (>90 days configurable)
- Create: `tests/server/trace-writer.test.ts`
- Create: `tests/server/routes/trace.test.ts`

## Contracts consumed
- `src/shared/types.ts`: `Session`
- `server/services/session-service.ts` (B4): `updateTraceDir`, `incrementCounters`
- `server/env.ts`: dataDir

## Contracts produced (consumed by B1, B2, B6)
- `traceService.getOrCreate(sessionId): TraceWriter`
- `traceService.closeAll(): Promise<void>` (on server shutdown)
- `TraceWriter`:
  - `appendStream(rawLine: string): void` — adds newline if not present, increments `stream_event_count`
  - `appendHook(payload: object): void` — stringifies + newline, increments `hook_event_count`
  - `appendStderr(chunk: string): void` — increments `stderr_bytes`
  - `writeMeta(meta): Promise<void>` — writes `meta.json` on session end
  - `close(): Promise<void>` — fsync all streams, close handles

## Recommended task order
1. TDD `TraceWriter`: open three append streams; write + read back bytes-identical. Test `close()` fsyncs.
2. TDD counter increments: appendStream 100 times → `sessions.stream_event_count` = 100 in DB.
3. TDD fidelity: write 10 events including ones with embedded newlines in strings → read back → JSON.parse each line yields original objects.
4. TDD routes: GET stream.jsonl, GET hooks.jsonl, GET bundle.tar.gz (use `tar` npm pkg OR node's stdlib + simple tar writing).
5. TDD goal-trace bundle: concatenate all sessions' trace dirs for a goal into one tar stream.
6. TDD pruner: create fake 100-day-old and 30-day-old trace dirs → `prune(90)` removes only the old ones.

## Filesystem layout (spec §4)
```
<data_dir>/traces/
  <session_id>/
    stream.jsonl
    hooks.jsonl
    stderr.log
    meta.json
```

## Buffering / fsync
- Writes are append-mode with default OS buffering
- `close()` calls `fsync` on each stream handle before closing
- On server SIGTERM, `traceService.closeAll()` runs in the shutdown sequence (before DB close)

## Acceptance criteria (spec §13.2 + §14.2 B5)
- [ ] Every line written via `appendStream` is a valid JSONL entry (ends with `\n`)
- [ ] `sessions.stream_event_count` matches line count of `stream.jsonl`
- [ ] `sessions.hook_event_count` matches line count of `hooks.jsonl`
- [ ] Bundle tar extraction yields the exact session files
- [ ] Goal trace bundle contains every session's trace dir under that goal
- [ ] Pruner removes only sessions where `ended_at + pruneDays*86400000 < now`
- [ ] Fidelity test: write 100 synthetic events with unicode, embedded newlines (escaped), large tool_result strings → parse back → deep-equal to originals
- [ ] `trace_index` table is STRETCH GOAL (per spec §3.7) — skip unless time permits

## QA Checklist
- [ ] **QA-1:** Write 1000 events; file has 1000 lines; `sessions.stream_event_count == 1000`
- [ ] **QA-2:** Close + reopen handle; no data loss
- [ ] **QA-3:** Bundle download returns valid tar; extracting produces the 4 expected files
- [ ] **QA-4:** Goal with 3 sessions → goal trace bundle contains 3 subdirectories, each with stream/hooks/stderr/meta
- [ ] **QA-5:** Append throughput: 1MB/s sustained for 10s without blocking (use a test that times 1000 appends of 1KB each)
- [ ] **QA-6:** Server SIGTERM → closeAll waits for all streams to fsync before process exits
- [ ] **QA-7:** No `any` types

## Quality bar
- No `any`, JSDoc, fsync verified, error handling for EMFILE (too many open files — close oldest inactive writer when limit hit)
