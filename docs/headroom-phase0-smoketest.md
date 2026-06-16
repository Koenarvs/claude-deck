# Headroom Integration — Phase 0 Smoke Test

**Goal:** Decide whether Headroom's compression proxy is safe and worthwhile for Claude Deck *before* relying on the wiring added in this branch. Headroom sits between the Claude Code CLI and Anthropic, compressing request bodies. We use **proxy mode** (`ANTHROPIC_BASE_URL`), which is Headroom's documented Claude Code path and preserves subscription auth (the proxy relays the client's existing token untouched).

Run every check below against a **real** Claude Code session on your normal workload. If any of checks 2–4 fail, stop — the downstream phases (Settings toggle, Analytics panel) are not worth building.

> Reframe before you start: on subscription auth you are **not** billed per token. The win here is **context-window headroom** — smaller requests mean more work fits before auto-compaction, longer coherent sessions. Judge results by tokens-per-request and compaction frequency, not dollars.

---

## Setup

1. Install Headroom and start the proxy (separate terminal, leave running):
   ```bash
   pip install "headroom-ai[all]"        # or: pip install "headroom-ai[proxy]"
   headroom proxy --port 8787
   ```
2. Confirm the proxy is up:
   ```bash
   curl -s http://localhost:8787/stats
   # expect JSON with requests_total / tokens_saved_total
   ```

---

## Checks

### 1. Auth survives (subscription/OAuth)
```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```
- [ ] Claude Code starts and authenticates with **no** `ANTHROPIC_API_KEY` set (subscription login intact).
- [ ] A simple prompt ("say hi") returns a normal response.

**If this fails:** the proxy isn't forwarding the auth header. Hard stop — nothing else matters.

### 2. Streaming is intact  ⚠️ most likely failure
- [ ] Ask for a long answer (e.g. "write a 300-word explanation of TCP"). Output **streams token-by-token**, not all-at-once after a long pause, and doesn't truncate.

**Why it matters:** Claude Code is fully streaming (SSE). Proxies that buffer or break SSE will make sessions hang or feel frozen.

### 3. Tool calls + MCP fidelity
- [ ] In a real repo, ask Claude to read a file, run a command, and edit something — tool calls execute correctly.
- [ ] If a session has an MCP server attached (e.g. claude-deck's own), its tools still list and invoke.

**Why it matters:** compression must be lossless enough to preserve tool-call structure. Headroom claims ~97% on tool benchmarks — verify on *your* traffic, not the benchmark.

### 4. Prompt caching isn't wrecked
- [ ] Run a multi-turn session. Watch cache behavior via `/stats` and (if visible) Claude Code's own usage — compare cache-read tokens with and without the proxy.

**Why it matters:** compressing request bodies changes the bytes Anthropic hashes for its prompt cache. If cache hits collapse, part of the context win reverses. This is the subtlest risk; spend real time here.

### 5. Savings are real
```bash
curl -s http://localhost:8787/stats
```
- [ ] `tokens_saved_total` is materially > 0 after a working session.
- [ ] Note the average per-request reduction — this is the number the future Analytics panel will surface.

---

## Decision

| Outcome | Action |
|---------|--------|
| Checks 1–4 pass, 5 shows real savings | Proceed: enable the toggle (Phase 1/2 below), build the Analytics panel (Phase 3). |
| Streaming or tool fidelity fails | Stop. Proxy mode is unusable for Claude Code as-is. |
| Caching collapses, net win marginal | Reassess — the context benefit may not justify the dependency. |

**ToS note (non-technical):** routing subscription traffic through a third-party body-modifying proxy works mechanically; whether it's *permitted* on a Claude subscription is a separate judgment call. Decide before adopting in normal workflow.

---

## What this branch already wired (inert until enabled)

`feat/headroom-compression` adds the integration, **off by default** (`headroom.enabled = false`):

- `src/shared/schemas.ts` — `HeadroomConfigSchema` (`enabled`, `baseUrl`) on app config.
- `server/services/config-service.ts` — default `{ enabled: false, baseUrl: 'http://localhost:8787' }`.
- `server/pty-manager.ts` — `buildEnv()` injects `ANTHROPIC_BASE_URL` into every spawned/resumed session when a `headroomBaseUrl` is provided.
- `server/index.ts` — `headroomOpts()` reads config live each spawn and passes `headroomBaseUrl` to both PtyManager sites and the orchestrator brain.
- `server/orchestrator/brain-provider.ts` — `ClaudeBrainProvider` accepts a lazy env provider so headless `claude -p` runs are compressed too.

**To enable after Phase 0 passes:** set `headroom.enabled = true` in persisted app config (a Settings UI toggle is the remaining Phase 2 task — backend already honors it). Reads are live, so no restart needed to flip it.

**Not yet built:** the Settings toggle control and the Analytics "context tokens saved" panel (Phase 3, fed by `/stats`).
