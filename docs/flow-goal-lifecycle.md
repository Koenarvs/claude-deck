# Goal Lifecycle Flows

This document describes the core lifecycle processes in Claude Deck: how goals are created, how they transition between states, how sessions are spawned and linked, and how scheduled tasks instantiate goals on a cron schedule.

All diagrams are based on the server-side implementation in `server/`.

---

## 1. Goal Creation Flow

Goals can be created through two paths: simple creation via `POST /goals` (used by the UI and the `create_goal` MCP tool), and atomic create-and-instruct via `POST /goals/create-and-instruct` (used by the `create_goal_and_instruct` MCP tool for goal orchestration). Both paths share the same core creation logic in `goal-service.ts` but differ in what happens after the goal row is inserted.

Simple creation optionally spawns a PTY terminal session when an `initialPrompt` is provided. Create-and-instruct always sends an inter-goal message and optionally spawns a SessionRunner (stream-json mode) to process the instruction.

```mermaid
flowchart TD
    subgraph "Entry Points"
        UI["UI: Create Goal Form"]
        MCP1["MCP Tool: create_goal"]
        MCP2["MCP Tool: create_goal_and_instruct"]
    end

    UI --> POST_GOALS["POST /goals"]
    MCP1 --> POST_GOALS
    MCP2 --> POST_CAI["POST /goals/create-and-instruct"]

    subgraph "Shared Creation Logic (goal-service.ts)"
        VALIDATE_TITLE["Check title uniqueness\n(case-insensitive, excludes archived)"]
        GEN_ID["Generate UUID"]
        KANBAN["Compute kanban_order\nMAX(kanban_order) + 1 in 'planning'"]
        INSERT["INSERT INTO goals\nstatus = 'planning'\npermission_mode = input or 'supervised'"]
        WS_CREATED["Broadcast WS: goal:created"]
    end

    POST_GOALS --> VALIDATE_TITLE
    POST_CAI --> VALIDATE_SRC["Validate source_goal_id exists"]
    VALIDATE_SRC -->|Not found| ERR_404["404: Source goal not found"]
    VALIDATE_SRC -->|Found| VALIDATE_TITLE

    VALIDATE_TITLE -->|Duplicate| ERR_DUP["Throw DuplicateGoalTitleError"]
    VALIDATE_TITLE -->|Unique| GEN_ID --> KANBAN --> INSERT --> WS_CREATED

    subgraph "Simple Creation Path"
        CHECK_PROMPT{"initialPrompt\nprovided?"}
        SPAWN_PTY["spawnTerminalSession(goalId, prompt)\n(PtyManager)"]
        RES_201A["201: { goal, session_id }"]
    end

    WS_CREATED -->|"POST /goals"| CHECK_PROMPT
    CHECK_PROMPT -->|Yes| SPAWN_PTY --> RES_201A
    CHECK_PROMPT -->|No| RES_201A

    subgraph "Create-and-Instruct Path"
        SEND_IGM["interGoalMessageService\n.sendInstruction(\nsource_goal_id, goal.id,\ninstruction, 'instruction')"]
        IGM_FAIL{"Instruction\nsend failed?"}
        ROLLBACK["goalService.archive(goal.id)\n(best-effort cleanup)"]
        CHECK_SPAWN{"spawn_session\n!== false?"}
        SPAWN_SR["spawnGoalSession(goalId, instruction)\n(SessionRunner, stream-json)"]
        MARK_DELIVERED["interGoalMessageService\n.markDelivered(message.id)"]
        RES_201B["201: { goal, instruction, session_id }"]
    end

    WS_CREATED -->|"POST /create-and-instruct"| SEND_IGM
    SEND_IGM --> IGM_FAIL
    IGM_FAIL -->|Yes| ROLLBACK --> ERR_500["500: Failed to send instruction"]
    IGM_FAIL -->|No| CHECK_SPAWN
    CHECK_SPAWN -->|Yes| SPAWN_SR --> MARK_DELIVERED --> RES_201B
    CHECK_SPAWN -->|No| RES_201B
```

**Key differences between the two paths:**

| Aspect | `create_goal` | `create_goal_and_instruct` |
|--------|---------------|----------------------------|
| Session type | PtyManager (terminal) | SessionRunner (stream-json) |
| Inter-goal message | None | Always created |
| Source goal required | No | Yes (`source_goal_id`) |
| Rollback on failure | None (goal persists) | Archives goal if instruction fails |
| Session spawn | Only if `initialPrompt` set | Default true (`spawn_session`) |

---

## 2. Goal State Machine

Goals progress through five statuses. The state machine is defined in `server/state-machine/goal-status.ts`. The `archived` status is terminal -- no transitions out of it are permitted. Most transitions are triggered by session lifecycle events (spawn, exit, follow-up), though manual transitions via the API are also supported.

```mermaid
stateDiagram-v2
    [*] --> planning : Goal created\n(goalService.create)

    planning --> active : Session spawned\n(spawnTerminalSession / spawnGoalSession)
    planning --> complete : Manual\n(PATCH /goals/:id)
    planning --> archived : Manual or delete\n(DELETE /goals/:id)

    active --> waiting : Session process exits\n(PtyManager.onExit / SessionRunner result event)
    active --> planning : Manual\n(PATCH /goals/:id)
    active --> complete : Manual\n(PATCH /goals/:id)
    active --> archived : Manual\n(DELETE /goals/:id)

    waiting --> active : Follow-up prompt sent\n(spawnTerminalSession / sendFollowup)
    waiting --> planning : Manual\n(PATCH /goals/:id)
    waiting --> complete : Manual\n(PATCH /goals/:id)
    waiting --> archived : Manual\n(DELETE /goals/:id)

    complete --> active : Reopen + send message\n(spawnTerminalSession)
    complete --> archived : Manual\n(DELETE /goals/:id)

    archived --> [*] : Terminal state\n(no transitions out)
```

### Transition trigger details

| From | To | Triggered By | Code Location |
|------|----|-------------|---------------|
| `planning` | `active` | `spawnTerminalSession()` or `spawnGoalSession()` sets `status: 'active'` | `index.ts:239`, `session-runner.ts:189-190` |
| `active` | `waiting` | PTY exit callback or SessionRunner `result` event | `index.ts:228`, `session-runner.ts:634` |
| `waiting` | `active` | User sends follow-up message, re-spawning the session | `index.ts:239` |
| `complete` | `active` | User reopens goal and sends a message | `index.ts:239` |
| any | `complete` | User manually marks goal complete via PATCH | `goal-service.ts:316-319` (sets `completed_at`) |
| any (except archived) | `archived` | DELETE endpoint or manual status update | `goal-service.ts:382-408` (sets `completed_at`) |

---

## 3. Session Spawn Flow

When a goal session is started, the system decides between spawning a new session or resuming an existing one. This decision is based on whether a Claude Code JSONL transcript file exists for the goal ID. The PtyManager wraps `node-pty` to create a pseudo-terminal running the `claude` CLI with appropriate flags.

### 3a. PTY Session Spawn (Terminal Mode)

Used by: `POST /goals/:id/messages` (terminal endpoint), `POST /goals` (with `initialPrompt`).

```mermaid
flowchart TD
    START["spawnTerminalSession(goalId, initialPrompt?)"]

    GET_GOAL["goalService.get(goalId)"]
    CHECK_EXISTING{"Existing process\nin registry?"}
    IS_ALIVE{"PtyManager\nand alive?"}
    RETURN_RUNNING["Return 'already_running'"]
    KILL_OLD["interrupt() + cleanup()\nprocessRegistry.remove()"]

    CREATE_PTY["new PtyManager(goal, { broadcast, onExit })"]
    CHECK_JSONL{"findJsonlFile(goalId)\n~/.claude/projects/*/<goalId>.jsonl"}

    subgraph "Register & Activate"
        REGISTER["processRegistry.set(goalId, ptyMgr)"]
        SET_ACTIVE["goalService.update(goalId, { status: 'active' })"]
        SET_SESSION["goalService.setCurrentSession(goalId, goalId)"]
        CREATE_LOGGER["new ConversationLogger(goalId, cwd, broadcast)"]
    end

    subgraph "Resume Path"
        LOG_RESUME["Log: Resuming previous session"]
        REBUILD["convLogger.rebuild()\nRegenerate conversation.md from JSONL"]
        CALL_RESUME["ptyMgr.resume(goalId)"]
    end

    subgraph "New Session Path"
        LOG_NEW["Log: Starting new session"]
        LOGGER_START["convLogger.start()\nBegin polling for JSONL creation"]
        CALL_START["ptyMgr.start(initialPrompt)"]
    end

    DELIVER_PENDING["Deliver pending inter-goal messages\n(mark 'pending' -> 'delivered')"]
    RETURN_ID["Return goalId as session_id"]

    START --> GET_GOAL --> CHECK_EXISTING
    CHECK_EXISTING -->|Yes| IS_ALIVE
    CHECK_EXISTING -->|No| CREATE_PTY
    IS_ALIVE -->|Yes| RETURN_RUNNING
    IS_ALIVE -->|No| KILL_OLD --> CREATE_PTY

    CREATE_PTY --> CHECK_JSONL
    CHECK_JSONL --> REGISTER --> SET_ACTIVE --> SET_SESSION --> CREATE_LOGGER

    CHECK_JSONL -->|"JSONL exists"| LOG_RESUME --> REBUILD --> CALL_RESUME
    CHECK_JSONL -->|"No JSONL"| LOG_NEW --> LOGGER_START --> CALL_START

    CALL_RESUME --> DELIVER_PENDING
    CALL_START --> DELIVER_PENDING
    DELIVER_PENDING --> RETURN_ID
```

### 3b. PtyManager Internal Spawn

The PtyManager resolves the `claude` CLI path, builds the argument list with session management and MCP flags, and spawns a PTY process via `node-pty`. On Windows, a workaround is applied because Git Bash sets `process.execPath` to a stub path that `node-pty`'s conpty agent cannot use.

```mermaid
flowchart TD
    subgraph "PtyManager.start(initialPrompt?)"
        RESOLVE["resolveClaudePath()\nResolve 'claude' binary location"]
        BUILD_ARGS["Build CLI args:\n--session-id <goalId>"]

        CHECK_PERM{"goal.permission_mode\n=== 'autonomous'?"}
        ADD_PERM["Add: --permission-mode bypassPermissions"]

        CHECK_MODEL{"goal.model set\nand !== 'default'?"}
        ADD_MODEL["Add: --model <model>"]

        BUILD_MCP["buildMcpConfig()\nGenerate JSON config pointing to\nmcp/dist/index.js with CLAUDE_DECK_URL"]
        ADD_MCP["Add: --mcp-config <json>"]

        SETUP_ENV["Clone process.env\nSet TERM=xterm-256color"]

        WIN_FIX{"Windows platform?"}
        FIND_NODE["findRealNodePath()\n'where node' to find real node.exe"]
        OVERRIDE["Override process.execPath\ntemporarily"]

        SPAWN["pty.spawn(claudePath, args, {\n  name: 'xterm-256color',\n  cols: 120, rows: 30,\n  cwd: goal.cwd, env\n})"]

        RESTORE["Restore original process.execPath"]

        ATTACH_DATA["Attach onData handler:\n- Broadcast terminal:data via WS\n- Reset idle timer\n- Detect prompt via regex"]

        ATTACH_EXIT["Attach onExit handler:\n- Set exited = true\n- Broadcast terminal:exited\n- Remove from processRegistry\n- Call onExitCallback"]

        BROADCAST_START["Broadcast WS: terminal:started"]

        CHECK_IP{"initialPrompt\nprovided?"}

        subgraph "Prompt Delivery"
            IDLE_TIMER["Start 5s idle timer\n(reset on each data chunk)"]
            FALLBACK_TIMER["Start 45s fallback timer"]
            REGEX_DETECT["Regex detect prompt:\nStrip ANSI, match /(?:>{1,2}|❯) \\s*$/"]
            WAIT_500["Wait 500ms"]
            WRITE_PROMPT["Write prompt text to PTY"]
            WAIT_200["Wait 200ms"]
            SEND_CR["Write \\r (carriage return)"]
        end
    end

    RESOLVE --> BUILD_ARGS --> CHECK_PERM
    CHECK_PERM -->|Yes| ADD_PERM --> CHECK_MODEL
    CHECK_PERM -->|No| CHECK_MODEL
    CHECK_MODEL -->|Yes| ADD_MODEL --> BUILD_MCP
    CHECK_MODEL -->|No| BUILD_MCP
    BUILD_MCP --> ADD_MCP --> SETUP_ENV --> WIN_FIX
    WIN_FIX -->|Yes| FIND_NODE --> OVERRIDE --> SPAWN --> RESTORE
    WIN_FIX -->|No| SPAWN
    SPAWN --> ATTACH_DATA --> ATTACH_EXIT --> BROADCAST_START --> CHECK_IP
    RESTORE --> ATTACH_DATA
    CHECK_IP -->|Yes| IDLE_TIMER
    CHECK_IP -->|No| BROADCAST_START
    IDLE_TIMER --> FALLBACK_TIMER
    REGEX_DETECT -.->|"On match"| WAIT_500
    IDLE_TIMER -.->|"On timeout"| WAIT_500
    FALLBACK_TIMER -.->|"On timeout"| WAIT_500
    WAIT_500 --> WRITE_PROMPT --> WAIT_200 --> SEND_CR
```

### 3c. SessionRunner Spawn (Stream-JSON Mode)

Used by `create_goal_and_instruct` and `POST /goals/:id/messages` (API mode). The SessionRunner spawns `claude` with `--output-format stream-json --input-format stream-json` and parses structured events from stdout.

```mermaid
flowchart TD
    subgraph "spawnGoalSession(goalId, prompt)"
        GET_GOAL["goalService.get(goalId)"]
        CHECK_REG{"Existing process\nin registry?"}

        IS_SR{"Is SessionRunner?"}
        SR_EXITED{"Has exited?"}
        FOLLOWUP["existing.sendFollowup(prompt)\nReturn 'resuming'"]
        CLEANUP["cleanup() + remove from registry"]

        IS_OTHER["Is PtyManager or other"]
        KILL_OTHER["interrupt() + cleanup()\nremove from registry"]

        CREATE_ADAPTERS["Create service adapters:\n- RunnerMessageService\n- RunnerGoalService\n- RunnerTraceWriter"]

        CREATE_SR["new SessionRunner(goal, {\n  traceWriter, messageService,\n  goalService, broadcast, skillProvider\n})"]

        CALL_START["runner.start(prompt)"]
        RETURN_SID["Return sessionId or 'starting'"]
    end

    subgraph "SessionRunner.start(prompt)"
        GEN_UUID["Generate session UUID"]
        CREATE_SESSION["messageService.createSession({\n  id, origin: 'dashboard',\n  goal_id, cwd, model\n})"]
        SAVE_USER_MSG["messageService.saveMessage(\n  role: 'user', content: prompt)"]
        SET_CURRENT["goalService.setCurrentSession(goalId, sessionId)"]
        SET_STATUS["goalService.setStatus(goalId, 'active')"]
        REG_PROCESS["processRegistry.set(goalId, runner)"]
        BUILD_CLI["Build CLI args:\n--output-format stream-json\n--input-format stream-json\n--session-id <uuid>\n+ permission, model, mcp flags"]
        ENRICH["Enrich prompt with:\n- External skills (from skill directories)\n- Project memory (MEMORY.md)"]
        SPAWN_PROC["Spawn child_process with claude CLI"]
        WRITE_STDIN["Write enriched prompt to stdin"]
        PARSE_EVENTS["Parse line-delimited JSON events from stdout"]
    end

    GET_GOAL --> CHECK_REG
    CHECK_REG -->|Yes| IS_SR
    CHECK_REG -->|No| CREATE_ADAPTERS
    IS_SR -->|Yes| SR_EXITED
    IS_SR -->|No| IS_OTHER --> KILL_OTHER --> CREATE_ADAPTERS
    SR_EXITED -->|Yes| CLEANUP --> CREATE_ADAPTERS
    SR_EXITED -->|No| FOLLOWUP
    CREATE_ADAPTERS --> CREATE_SR --> CALL_START --> RETURN_SID

    CALL_START --> GEN_UUID --> CREATE_SESSION --> SAVE_USER_MSG
    SAVE_USER_MSG --> SET_CURRENT --> SET_STATUS --> REG_PROCESS
    REG_PROCESS --> BUILD_CLI --> ENRICH --> SPAWN_PROC --> WRITE_STDIN --> PARSE_EVENTS
```

---

## 4. Goal-to-Session Linking

Sessions are linked to goals through the `goal_id` column on the `sessions` table and the `current_session_id` column on the `goals` table. Dashboard-spawned sessions are linked automatically at creation time. External sessions (detected by the hook-based session observer) can be manually adopted by a goal.

For PTY sessions, the session ID is always equal to the goal ID, creating a 1:1 mapping. For SessionRunner sessions, a new UUID is generated per invocation.

```mermaid
flowchart TD
    subgraph "Automatic Linking (Dashboard Sessions)"
        direction TB
        PTY_SPAWN["spawnTerminalSession(goalId)"]
        PTY_LINK["goalService.setCurrentSession(\n  goalId, goalId)\nsession_id = goal_id"]
        SR_SPAWN["spawnGoalSession(goalId, prompt)"]
        SR_CREATE["sessionService.create({\n  id: uuid, goal_id: goalId, origin: 'dashboard'\n})"]
        SR_LINK["goalService.setCurrentSession(\n  goalId, sessionId)"]
    end

    PTY_SPAWN --> PTY_LINK
    SR_SPAWN --> SR_CREATE --> SR_LINK

    subgraph "Manual Adoption (External Sessions)"
        direction TB
        OBSERVE["SessionObserver detects external\nClaude Code process (hook events)"]
        CREATE_EXT["sessionService.create({\n  id: sessionId,\n  origin: 'external',\n  goal_id: null\n})"]
        WS_OBSERVED["Broadcast: session:observed"]
        UI_ADOPT["User clicks 'Adopt' in UI"]
        POST_ADOPT["POST /goals/:id/adopt-session\n{ session_id }"]
        UPDATE_SESSION["UPDATE sessions\nSET goal_id = ?\nWHERE id = ?"]
        UPDATE_GOAL["UPDATE goals\nSET current_session_id = ?\nWHERE id = ?"]
        WS_UPDATED["Broadcast: goal:updated"]
    end

    OBSERVE --> CREATE_EXT --> WS_OBSERVED
    WS_OBSERVED --> UI_ADOPT --> POST_ADOPT --> UPDATE_SESSION --> UPDATE_GOAL --> WS_UPDATED

    subgraph "Querying the Relationship"
        direction TB
        Q1["GET /sessions?goal_id=X\nAll sessions for a goal\n(ORDER BY started_at)"]
        Q2["GET /goals/:id\nReturns goal + all messages\nfrom all linked sessions\n(JOIN sessions ON goal_id)"]
        Q3["goal.current_session_id\nPoints to the most recent\nor currently active session"]
    end

    subgraph "Session ID Strategies"
        direction TB
        S1["PTY Sessions:\nsession_id = goal_id\n(1:1 mapping, resume by ID)"]
        S2["SessionRunner Sessions:\nsession_id = new UUID per invocation\n(multiple sessions per goal)"]
    end
```

### Linking data model

```mermaid
erDiagram
    goals ||--o{ sessions : "goal_id"
    goals {
        text id PK
        text title
        text status
        text current_session_id FK
        text cwd
        text model
        text permission_mode
    }
    sessions {
        text id PK
        text goal_id FK
        text origin "dashboard | external"
        text cwd
        integer started_at
        integer ended_at
    }
    sessions ||--o{ messages : "session_id"
    messages {
        text id PK
        text session_id FK
        text role
        text content
    }
    goals ||--o{ inter_goal_messages : "to_goal_id"
    goals ||--o{ inter_goal_messages : "from_goal_id"
    inter_goal_messages {
        text id PK
        text from_goal_id FK
        text to_goal_id FK
        text content
        text message_type
        text status "pending | delivered | acknowledged"
    }
```

---

## 5. Scheduled Task Flow

Scheduled tasks use `node-cron` to fire goal creation on a recurring schedule. Each task stores a goal template as JSON. When the cron expression matches, the scheduler instantiates the template into a new goal with a timestamped title to avoid duplicate-name conflicts. Goals created by scheduled tasks start in `planning` status and are not auto-executed -- the user must manually start them.

### 5a. Scheduled task lifecycle

```mermaid
flowchart TD
    subgraph "Server Startup"
        BOOT["Server starts"]
        LOAD["scheduler.start()\nLoad all tasks from DB"]
        FILTER{"Task enabled?"}
        REGISTER["cron.schedule(task.cron_expr, callback)\nStore in jobs Map"]
        SKIP["Skip (not registered)"]
        LOG["Log: Scheduler started, N jobs"]
    end

    BOOT --> LOAD --> FILTER
    FILTER -->|Yes| REGISTER --> LOG
    FILTER -->|No| SKIP --> LOG

    subgraph "Task CRUD"
        CREATE["POST /api/scheduled-tasks"]
        VALIDATE_CRON{"cron.validate(expr)"}
        INVALID["400: Invalid cron expression"]
        SAVE_DB["scheduledTaskService.create(input)\nINSERT INTO scheduled_tasks"]
        REFRESH["scheduler.refresh(id)\nStop old job, re-read DB, re-register"]

        UPDATE["PATCH /api/scheduled-tasks/:id"]
        UPDATE_DB["scheduledTaskService.update(id, input)"]

        DELETE["DELETE /api/scheduled-tasks/:id"]
        DELETE_DB["scheduledTaskService.delete(id)\nDELETE FROM scheduled_tasks"]
        STOP_JOB["scheduler.refresh(id)\nStop job, task gone from DB"]
    end

    CREATE --> VALIDATE_CRON
    VALIDATE_CRON -->|Invalid| INVALID
    VALIDATE_CRON -->|Valid| SAVE_DB --> REFRESH

    UPDATE --> VALIDATE_CRON
    UPDATE_DB --> REFRESH

    DELETE --> DELETE_DB --> STOP_JOB

    subgraph "Manual Trigger"
        RUN_NOW["POST /api/scheduled-tasks/:id/run-now"]
        GET_TASK["scheduledTaskService.get(id)"]
        NOT_FOUND["Throw: Task not found"]
        FIRE_DIRECT["fireTask(task)\n(bypasses cron schedule)"]
        RETURN_GID["Return { goal_id }"]
    end

    RUN_NOW --> GET_TASK
    GET_TASK -->|Not found| NOT_FOUND
    GET_TASK -->|Found| FIRE_DIRECT --> RETURN_GID
```

### 5b. Cron fire and goal instantiation

```mermaid
flowchart TD
    subgraph "Cron Tick"
        TICK["node-cron detects\ncron expression match"]
        CALLBACK["Execute registered callback"]
        TRY_FIRE["Try: fireTask(task)"]
        CATCH_ERR["Catch: Log error\n(scheduler continues)"]
    end

    subgraph "fireTask(task)"
        PARSE["taskService.parseTemplate(task)\nJSON.parse(goal_template_json)"]
        TIMESTAMP["Generate ISO timestamp\nnew Date(now).toISOString()"]
        BUILD["Build CreateGoalInput:\ntitle: template.title + ' (timestamp)'\ncwd: template.cwd\nmodel: template.model\ninitialPrompt: template.initialPrompt\ntags: template.tags"]
        CREATE_GOAL["createGoal(goalInput)\n-> goalService.create(input)"]
        RECORD["taskService.recordRun(task.id, now)\nUPDATE last_run_at"]
        LOG_FIRE["Log: Scheduled task fired, goal created"]
        RETURN["Return goal.id"]
    end

    subgraph "Created Goal"
        GOAL_ROW["Goal in DB:\nstatus = 'planning'\ntitle = 'Daily backup (2026-05-12T14:30:00.000Z)'\ncwd, model, tags from template"]
        WS_EVENT["WS broadcast: goal:created"]
        USER_ACTION["User manually starts goal\nfrom dashboard UI"]
        SPAWN["spawnTerminalSession(goalId)\nor spawnGoalSession(goalId, prompt)"]
    end

    TICK --> CALLBACK --> TRY_FIRE
    TRY_FIRE -->|Error| CATCH_ERR
    TRY_FIRE -->|Success| PARSE --> TIMESTAMP --> BUILD --> CREATE_GOAL
    CREATE_GOAL --> RECORD --> LOG_FIRE --> RETURN

    CREATE_GOAL --> GOAL_ROW --> WS_EVENT --> USER_ACTION --> SPAWN
```

### 5c. Goal template structure

The `goal_template_json` column stores a serialized `GoalTemplate` object. The scheduler deserializes it, appends a timestamp to the title, and passes the result to `goalService.create()`.

```mermaid
flowchart LR
    subgraph "Stored Template (DB)"
        TEMPLATE["{
            title: 'Daily backup',
            cwd: '/home/user/project',
            model: 'sonnet',
            initialPrompt: 'Run backup.sh',
            tags: ['automation']
        }"]
    end

    subgraph "Instantiated Goal"
        GOAL["{
            title: 'Daily backup (2026-05-12T14:30:00.000Z)',
            cwd: '/home/user/project',
            model: 'sonnet',
            initialPrompt: 'Run backup.sh',
            tags: ['automation'],
            status: 'planning',
            kanban_order: MAX + 1
        }"]
    end

    TEMPLATE -->|"parseTemplate() +\ntimestamp append"| GOAL
```

### Scheduler state management

The scheduler keeps an in-memory `Map<string, RegisteredJob>` that mirrors enabled tasks in the database. Every mutating operation (create, update, delete) calls `scheduler.refresh(id)` to synchronize the in-memory cron registry with the DB state:

| DB State | In-Memory Result |
|----------|-----------------|
| Task exists, enabled | Cron job registered and ticking |
| Task exists, disabled | No cron job (stopped if previously registered) |
| Task deleted | No cron job (stopped if previously registered) |

On server shutdown, `scheduler.stop()` calls `job.stop()` on all registered jobs and clears the map.
