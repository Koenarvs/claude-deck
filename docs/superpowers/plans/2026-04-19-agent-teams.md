# Agent Teams Protocol for claude-deck v1

Use this doc when dispatching the 16 burst agents with Claude Code's agent-teams feature (dev + QA per burst).

## Pairing

Each burst unit (B1-B6, F1-F6, S1-S4) gets exactly two agents:

- **Dev agent** — implements the module per its plan brief
- **QA agent** — executes the QA Checklist from the brief and reports results

They work on the same branch (`feat/<agent-id>`). Dev commits implementation; QA commits test additions and reviews dev's tests.

## Dev agent protocol

1. Read the assigned brief (e.g., `2026-04-19-B1-session-runner.md`).
2. Read `docs/superpowers/specs/2026-04-19-claude-deck-v1-design.md` sections referenced in the brief.
3. Check out branch `feat/<agent-id>` from `main` after F0 is merged.
4. Use `superpowers:test-driven-development` skill to decompose into bite-sized tasks.
5. Write failing tests first derived from the brief's QA Checklist.
6. Implement until tests green.
7. Run `npm run typecheck && npm test` — must be clean.
8. Push branch. Signal "ready for QA."

## QA agent protocol

1. Read the same brief + spec sections.
2. Check out the dev agent's branch.
3. For each QA Checklist item in the brief:
   - Write an executable test (unit, integration, or E2E as appropriate)
   - Run the test against the dev agent's implementation
   - Record pass/fail
4. If any checklist item fails:
   - Commit the failing test with a clear failure message
   - Signal "send back to dev" with a summary of failures
5. If all items pass:
   - Commit the test additions (even if duplicative of dev tests — QA tests are a separate layer)
   - Signal "QA pass" — ready to merge
6. QA must NOT modify implementation code. Implementation fixes are dev's responsibility.

## Send-back loop

- Dev reads QA's failing tests, fixes implementation, re-runs, signals ready.
- QA re-runs its full checklist (not just the failed items — regressions matter).
- Loop until QA pass.
- Hard limit: 3 send-back cycles. On the 4th cycle, escalate to orchestrator (Jerry) for human review.

## Escalation criteria — QA surfaces to orchestrator rather than sending back

- Spec ambiguity: the checklist item's expected behavior isn't fully specified
- Contract drift: dev's implementation doesn't match `src/shared/types.ts` / `schemas.ts` and the correct answer isn't obvious
- Dependency gap: a promised artifact from F0 or another burst is missing
- Test flakiness that isn't an implementation bug

Escalation format:
```
[<agent-id>] QA escalation: <one-line summary>

Context: <what was expected vs observed>
Artifact: <path, line, commit>
Proposed resolutions: <A, B, C with tradeoffs>
```

## What both agents must check before signaling done

- `npm run typecheck` clean
- `npm test` all green
- No `any` types in new code
- zod validation on all inbound HTTP/WS payloads the module handles
- Public functions have JSDoc describing contract
- PR description lists each QA Checklist item with pass/fail
