# B1 — SessionRunner (CLI Subprocess Wrapper)

**Burst:** Backend | **Depends on:** F0 merged to main | **Branch:** `feat/B1-session-runner`

## Goal
Spawn the `claude` CLI as a subprocess per goal, stream-json over stdin/stdout, parse events into domain messages, and write raw events to the trace.

## Spec references
- §2.2 subprocess-per-turn design
- §7 full wrapper contract (spawn flags, stdin/stdout protocols, lifecycle, parser edge cases)
- §14.2 B1 scope line

## Scope (files owned)
- Create: `server/session-runner.ts` — `SessionRunner` class per spec §7.4
- Create: `server/stream-parser.ts` — line-delimited JSON parser + typed event router
- Create: `server/process-registry.ts` — `Map<goalId, SessionRunner>` singleton with `get`, `set`, `remove`, `killAll()` for SIGTERM handler
- Create: `tests/server/session-runner.test.ts` — integration tests against a mock CLI script
- Create: `tests/server/stream-parser.test.ts` — unit tests for the parser
- Modify: `server/index.ts` — call `processRegistry.killAll()` in shutdown sequence

## Contracts consumed (from F0)
- `src/shared/types.ts`: `Goal`, `Session`, `Message`, `StreamJsonEvent`, `AssistantContentBlock`
- `src/shared/schemas.ts`: `StreamJsonEventSchema` for parsing validation
- `server/ws.ts`: `broadcast(event)` for `subprocess:error` and `session:ended`

## Contracts produced (consumed by B3/B4/B5)
- `SessionRunner` constructor signature: `(goal, deps: { traceWriter, messageService, goalService, broadcast })`
- Methods: `start(initialPrompt): Promise<void>`, `sendFollowup(prompt): Promise<void>`, `interrupt(): Promise<void>`, `cleanup(): Promise<void>`
- `processRegistry` singleton with methods above

## Recommended task order
1. Write a mock `claude` script (bash or node) that emits canned stream-json events to stdout given a stdin prompt. Used by tests.
2. TDD `stream-parser.ts`: given a stream of line-delimited JSON, yield validated events. Tests: valid lines parse; malformed lines are logged + skipped; unknown event types ignored.
3. TDD `process-registry.ts`: get/set/remove/killAll. Use `child_process.ChildProcess` mock.
4. TDD `session-runner.ts`: spawn the mock CLI, pipe a prompt in, receive parsed events, verify `traceWriter.appendStream` called per line, verify `messageService.save` called per normalized message, verify `broadcast` called appropriately.
5. Write SIGTERM integration: assert all registered runners are killed on shutdown.

## Spawn command (exact)
Build argv from spec §7.1:
```
claude --output-format stream-json --input-format stream-json --session-id <id>
       --permission-mode default --model <model> [--append-system-prompt ...] [--resume <id>]
```
Set working directory via the spawn options' `cwd` field — NOT as a CLI flag.

## stdin protocol
One JSON object per line, exactly the shape from spec §7.2.

## stdout protocol
Line-delimited JSON. Use `readline.createInterface({ input: proc.stdout })` for robust line handling.

## Edge cases (must be tested)
From spec §7.5:
| Case | Behavior |
|---|---|
| Malformed JSON | Log + parser error, continue |
| Unknown event type | Log debug, ignore |
| Stderr output | Appended to `<trace_dir>/stderr.log`; surface only on non-zero exit |
| Exit non-zero mid-turn | Goal → `error`, broadcast `subprocess:error` |
| stdin write after process exit | Swallow EPIPE, surface as "goal needs restart" |

## Acceptance criteria (spec §13 + §14.2 B1)
Functional:
- [ ] Spawns CLI binary (via mock in tests, real `claude` in manual smoke) and receives first `assistant` event within 5s on a simple prompt
- [ ] `interrupt()` sends SIGTERM to the child and returns within 1s
- [ ] New `start()` on an existing goal ID kills the previous subprocess first (registry enforces singleton)
- [ ] On server SIGTERM, all child processes are killed
- [ ] Parser handles a stream with one malformed line surrounded by valid ones — valid events still propagate

Observability:
- [ ] Every raw stdout line passes through to `traceWriter.appendStream` before any parsing decision
- [ ] stderr output is captured to `traceWriter.appendStderr` regardless of exit code

Quality:
- [ ] No `any` types
- [ ] Public methods have JSDoc
- [ ] Unit tests cover parser edge cases; integration test uses a real child_process.spawn against a node script

## QA Checklist (for QA agent)
Each item is a pass/fail test. If any fail, send back to dev.

- [ ] **QA-1:** A fixture mock CLI script emitting a canned stream of `system:init → assistant(text) → result:success` results in: a session row created via `messageService`, one assistant message row, final status `needs_input` on goal, and all raw lines appended to trace.
- [ ] **QA-2:** A mock CLI that emits a malformed line mid-stream does not crash the runner; the valid lines before and after are processed normally.
- [ ] **QA-3:** A mock CLI that exits with code 1 after emitting partial events causes the goal to transition to `error` status with a `subprocess:error` broadcast.
- [ ] **QA-4:** Calling `interrupt()` on an active runner causes the child to die within 1 second (verified via `child.exitCode` or `child.killed`).
- [ ] **QA-5:** Calling `start()` on a goal that already has a running runner causes the previous child to be killed and a new one spawned.
- [ ] **QA-6:** `processRegistry.killAll()` kills all registered children; registry is empty afterward.
- [ ] **QA-7:** No `any` types in any B1-owned file (grep check).

## Quality bar
- Zero `any`
- All public methods JSDoc'd
- Tests isolate via a mock CLI fixture (node script emitting canned JSON)
- PR description lists each AC pass/fail
