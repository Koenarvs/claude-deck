# Communication & Orchestration Flows

This document details the communication patterns in Claude Deck: how goals talk to each other, how external Claude Code sessions invoke MCP tools, how the WebSocket layer propagates real-time updates, and how multi-agent orchestration works end-to-end.

---

## 1. Inter-Goal Communication Flow

Goals communicate asynchronously via the `send_goal_instruction` MCP tool. Messages are persisted in the `inter_goal_messages` SQLite table with a lifecycle of `pending → delivered → acknowledged`. If the target goal has an active session, the message is auto-delivered as a follow-up prompt; otherwise it queues until the goal's next session starts.

```mermaid
sequenceDiagram
    participant CG as Control Goal<br/>(Claude Session)
    participant MCP as MCP Server<br/>(stdio)
    participant API as Dashboard API<br/>(Express)
    participant SVC as InterGoalMessageService
    participant DB as SQLite<br/>(inter_goal_messages)
    participant WS as WebSocket Server
    participant UI as Dashboard UI
    participant WG as Worker Goal<br/>(Claude Session)

    Note over CG: Goal A wants to send<br/>an instruction to Goal B

    CG->>MCP: tool_call: send_goal_instruction<br/>{target_goal_id, content, message_type, from_goal_id}
    MCP->>MCP: Validate input via Zod schema
    MCP->>API: POST /api/goals/{fromId}/instruct/{targetId}<br/>{content, message_type}

    API->>API: Validate both goals exist via goalService.get()
    API->>SVC: sendInstruction(fromId, toId, content, type)
    SVC->>DB: INSERT (id, from_goal_id, to_goal_id,<br/>content, message_type, status='pending')
    DB-->>SVC: Row inserted
    SVC->>WS: broadcast({type: 'goal:instruction', message})
    WS-->>UI: goal:instruction event
    UI->>UI: useGoalsStore.addInstruction()<br/>→ pendingInstructions Map

    SVC-->>API: InterGoalMessage (status: pending)

    alt Target goal has active session (current_session_id exists)
        API->>WG: spawnSession(toGoalId, content)<br/>→ writes to PTY stdin
        API->>SVC: markDelivered(message.id)
        SVC->>DB: UPDATE status='delivered',<br/>delivered_at=now()
        API-->>MCP: 201 {message with status: 'delivered'}
    else Target goal has no active session
        API-->>MCP: 201 {message with status: 'pending'}
        Note over DB: Message queued until<br/>target goal starts a session
    end

    MCP-->>CG: Tool result (JSON)

    Note over WG: Later: target goal starts session
    opt Pending messages delivered at session start
        WG->>API: Session spawned for goal B
        API->>SVC: getInstructions(goalId)
        SVC->>DB: SELECT WHERE to_goal_id=? AND status='pending'
        DB-->>SVC: Pending messages
        loop Each pending message
            SVC->>SVC: markDelivered(msg.id)
            SVC->>DB: UPDATE status='delivered'
        end
        Note over WG: Messages injected as<br/>follow-up prompts
    end
```

### Message Types

| Type | Purpose | Direction |
|------|---------|-----------|
| `instruction` | Delegate work or send a command | Control → Worker |
| `result` | Return completed work or data | Worker → Control |
| `status_update` | Report progress or state changes | Either direction |
| `context` | Share background information | Either direction |

### Message Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: sendInstruction()
    pending --> delivered: markDelivered()<br/>Session receives message
    delivered --> acknowledged: acknowledgeInstruction()<br/>POST /goals/:id/instructions/:msgId/acknowledge
    pending --> delivered: Auto-delivery at session start
```

---

## 2. MCP Tool Request Flow

External Claude Code sessions interact with Claude Deck through an MCP server that runs as a child process. The MCP server communicates via stdio transport with Claude CLI, and proxies all operations to the Dashboard HTTP API. This ensures every mutation flows through the same validation and WebSocket broadcast path as the UI.

```mermaid
sequenceDiagram
    participant CC as Claude Code<br/>(External Session)
    participant CLI as Claude CLI
    participant MCP as MCP Server<br/>(Node.js subprocess)
    participant HTTP as API Client<br/>(mcp/src/api-client.ts)
    participant API as Express Server<br/>(:4100)
    participant SVC as Service Layer
    participant DB as SQLite
    participant WS as WebSocket Server
    participant UI as Dashboard UI<br/>(React)

    Note over CC,CLI: Claude CLI spawns MCP server as subprocess<br/>with --mcp-config pointing to mcp/dist/index.js

    CC->>CLI: Tool call (e.g., create_goal)
    CLI->>MCP: JSON-RPC over stdio<br/>{method: 'tools/call', params: {name, arguments}}

    MCP->>MCP: Validate input with Zod schema
    MCP->>HTTP: Call DashboardApiClient method
    HTTP->>API: HTTP request (POST/GET/PATCH)<br/>e.g., POST /api/goals

    API->>API: validateBody() middleware<br/>(Zod schema validation)
    API->>SVC: Service method call<br/>e.g., goalService.create()
    SVC->>DB: SQL operation<br/>(prepared statement)
    DB-->>SVC: Result
    SVC->>WS: broadcast(serverEvent)
    WS-->>UI: WebSocket message<br/>(filtered by subscription)
    UI->>UI: Store update<br/>(useGoalsStore / useSessionStore)
    SVC-->>API: Domain object
    API-->>HTTP: JSON response
    HTTP->>HTTP: Validate response with Zod
    HTTP-->>MCP: Typed result
    MCP->>MCP: JSON.stringify(result)
    MCP-->>CLI: JSON-RPC response<br/>{content: [{type: 'text', text: '...'}]}
    CLI-->>CC: Tool result

    Note over MCP,API: MCP server knows the dashboard URL<br/>via CLAUDE_DECK_URL env var<br/>(default: http://127.0.0.1:4100)
```

### MCP Server Architecture

The MCP server (`mcp/src/index.ts`) registers 10 tools that map 1:1 to Dashboard API endpoints:

| MCP Tool | HTTP Method | API Endpoint | Purpose |
|----------|-------------|--------------|---------|
| `list_goals` | GET | `/api/goals` | List goals with optional filters |
| `get_goal` | GET | `/api/goals/:id` | Get goal detail with messages/plan |
| `create_goal` | POST | `/api/goals` | Create goal, optionally spawn session |
| `update_goal` | PATCH | `/api/goals/:id` | Update goal fields |
| `send_message` | POST | `/api/goals/:id/messages` | Send prompt to active session |
| `list_sessions` | GET | `/api/sessions` | List sessions with filters |
| `get_session_messages` | GET | `/api/sessions/:id/messages` | Get session message history |
| `schedule_task` | POST | `/api/scheduled-tasks` | Create cron-based goal template |
| `send_goal_instruction` | POST | `/api/goals/:id/instruct/:targetId` | Inter-goal messaging |
| `create_goal_and_instruct` | POST | `/api/goals/create-and-instruct` | Atomic create + instruct + spawn |

### Error Handling Chain

```mermaid
flowchart LR
    A[Tool Handler] -->|throws| B{Error Type}
    B -->|ApiConnectionError| C["Dashboard unreachable.<br/>Is claude-deck running?"]
    B -->|ApiError| D["HTTP status + body<br/>(e.g., 404 Goal not found)"]
    B -->|Error| E[error.message]
    B -->|unknown| F[String(err)]
    C --> G["MCP response<br/>{isError: true, content: [...]}"]
    D --> G
    E --> G
    F --> G
```

---

## 3. send_message vs send_goal_instruction

These are the two communication mechanisms for interacting with goals. They serve different purposes and have different semantics.

```mermaid
flowchart TB
    subgraph send_message["send_message"]
        SM1[Input: goal_id + prompt] --> SM2[POST /api/goals/:id/messages]
        SM2 --> SM3{Goal has<br/>active PTY?}
        SM3 -->|Yes| SM4[Write prompt to<br/>PTY stdin as follow-up]
        SM3 -->|No| SM5[Spawn new PTY session<br/>with prompt as initial input]
        SM4 --> SM6[Return session_id]
        SM5 --> SM6
    end

    subgraph send_goal_instruction["send_goal_instruction"]
        SGI1["Input: from_goal_id + target_goal_id<br/>+ content + message_type"] --> SGI2["POST /api/goals/:fromId/instruct/:targetId"]
        SGI2 --> SGI3[Create inter_goal_messages<br/>row with status=pending]
        SGI3 --> SGI4[Broadcast goal:instruction<br/>WebSocket event]
        SGI4 --> SGI5{Target has<br/>active session?}
        SGI5 -->|Yes| SGI6[Auto-deliver: spawnSession<br/>+ markDelivered]
        SGI5 -->|No| SGI7[Message queued as<br/>pending in DB]
        SGI6 --> SGI8[Return message<br/>status=delivered]
        SGI7 --> SGI8B[Return message<br/>status=pending]
    end

    style send_message fill:#e1f5fe
    style send_goal_instruction fill:#f3e5f5
```

### Comparison Table

| Aspect | `send_message` | `send_goal_instruction` |
|--------|----------------|-------------------------|
| **Purpose** | User/UI sends prompt to a goal | Goal-to-goal orchestration |
| **Sender identity** | None (implicit: user/UI) | Explicit `from_goal_id` required |
| **Persistence** | No message record created | Persistent `inter_goal_messages` row |
| **Message types** | N/A (always a prompt) | `instruction`, `result`, `status_update`, `context` |
| **Queuing** | No — spawns session immediately | Yes — queues if no active session |
| **Status tracking** | None | `pending → delivered → acknowledged` |
| **WebSocket events** | None specific | `goal:instruction` broadcast |
| **Use case** | Dashboard UI "Send" button, direct interaction | Multi-agent delegation and result reporting |
| **API endpoint** | `POST /goals/:id/messages` | `POST /goals/:fromId/instruct/:targetId` |

### When to Use Each

- **`send_message`**: When a user (via the dashboard UI) or an external agent wants to start or continue a conversation with a specific goal. It always results in an active session.

- **`send_goal_instruction`**: When one goal needs to delegate work to another goal, report results back, or share context. Messages persist and queue, enabling asynchronous orchestration patterns where goals may not be running simultaneously.

---

## 4. WebSocket Event Flow

The WebSocket server (`server/ws.ts`) provides real-time event propagation from the server to all connected dashboard clients. Clients subscribe to specific goal IDs or to `'all'` events. The server filters outgoing events based on these subscriptions.

### Connection Lifecycle

```mermaid
sequenceDiagram
    participant Client as Dashboard UI<br/>(ws-manager.ts)
    participant WS as WebSocket Server<br/>(server/ws.ts)

    Client->>WS: Connect to ws://localhost:4100/ws
    WS->>WS: clients.set(ws, {subscribed: new Set()})
    Client->>WS: {type: 'subscribe', goals: 'all'}
    WS->>WS: state.subscribed = 'all'

    loop Real-time updates
        WS->>Client: ServerEvent (filtered by subscription)
    end

    Client->>WS: {type: 'ping'}
    WS->>Client: {type: 'ping'}

    Client->>WS: {type: 'unsubscribe'}
    WS->>WS: state.subscribed = new Set()

    Client->>WS: Connection close
    WS->>WS: clients.delete(ws)
```

### Event Routing Logic

```mermaid
flowchart TB
    E[ServerEvent to broadcast] --> G{Extract goal_id<br/>from event}

    G -->|"goal:created/updated<br/>→ event.goal.id"| GID[goal_id found]
    G -->|"goal:status/plan-updated<br/>→ event.id"| GID
    G -->|"message:added/approval:pending<br/>terminal:*/subprocess:error<br/>conversation:updated<br/>→ event.goal_id"| GID
    G -->|"goal:instruction<br/>→ event.message.to_goal_id"| GID
    G -->|"session:*/approval:resolved<br/>hook:event/ping"| NGID[No goal_id]

    GID --> LOOP[For each connected client]
    NGID --> LOOP

    LOOP --> SUB{Client subscription?}
    SUB -->|"subscribed = 'all'"| SEND[Send event]
    SUB -->|"subscribed = Set(ids)<br/>AND goal_id in Set"| SEND
    SUB -->|"No goal_id AND<br/>subscribed.size > 0"| SEND
    SUB -->|"goal_id NOT in Set"| SKIP[Skip client]
```

### All WebSocket Message Types

#### Server → Client Events

| Event Type | Key Payload Fields | Triggered By |
|------------|-------------------|--------------|
| `goal:created` | `goal` (full Goal object) | `goalService.create()` |
| `goal:updated` | `goal` (full Goal object) | `goalService.update()` |
| `goal:status` | `id`, `status`, `current_session_id` | Session start/end transitions |
| `goal:plan-updated` | `id`, `plan_json` | Plan file parsing |
| `message:added` | `goal_id`, `session_id`, `message` | `messageService.save()` |
| `approval:pending` | `approval`, `goal_id` | Permission request from CLI |
| `approval:resolved` | `id`, `decision` | User approves/denies in UI |
| `session:observed` | `session` (full Session object) | `sessionService.create()` |
| `session:ended` | `id` | Session runner exit |
| `hook:event` | `event` (HookEvent object) | Hook ingestion pipeline |
| `subprocess:error` | `goal_id`, `error` | CLI exits with non-zero code |
| `terminal:data` | `goal_id`, `data` | PTY stdout/stderr output |
| `terminal:started` | `goal_id` | PTY process spawned |
| `terminal:exited` | `goal_id`, `exitCode` | PTY process exits |
| `goal:instruction` | `message` (InterGoalMessage) | `interGoalMessageService.sendInstruction()` |
| `conversation:updated` | `goal_id` | Conversation markdown rebuilt |
| `ping` | (empty) | Client ping echo |

#### Client → Server Messages

| Message Type | Key Payload Fields | Purpose |
|--------------|--------------------|---------|
| `subscribe` | `goals: string[] \| 'all'` | Register interest in goal events |
| `unsubscribe` | (none) | Clear all subscriptions |
| `ping` | (none) | Keepalive check |
| `terminal:input` | `goal_id`, `data` | Send keystrokes to PTY |
| `terminal:resize` | `goal_id`, `cols`, `rows` | Resize PTY dimensions |

---

## 5. Multi-Agent Orchestration Pattern

The `create_goal_and_instruct` tool enables a parent goal to atomically create a child goal, send it an instruction, and spawn a session — all in one operation. This is the foundation for multi-agent orchestration where a control goal dispatches work to specialized worker goals.

### Atomic Delegation Flow

```mermaid
sequenceDiagram
    participant PG as Parent Goal<br/>(Control Session)
    participant MCP as MCP Server
    participant API as Dashboard API
    participant GS as GoalService
    participant IGM as InterGoalMessage<br/>Service
    participant DB as SQLite
    participant WS as WebSocket
    participant UI as Dashboard UI
    participant CG as Child Goal<br/>(Worker Session)

    Note over PG: Parent decides to delegate<br/>a subtask to a new goal

    PG->>MCP: create_goal_and_instruct<br/>{title, cwd, instruction,<br/>source_goal_id, spawn_session: true}
    MCP->>API: POST /api/goals/create-and-instruct

    Note over API: Step 1: Validate source goal
    API->>GS: get(source_goal_id)
    GS-->>API: Source goal exists ✓

    Note over API: Step 2: Create child goal
    API->>GS: create({title, cwd, model, tags})
    GS->>DB: INSERT INTO goals
    GS->>WS: broadcast(goal:created)
    WS-->>UI: goal:created
    GS-->>API: New Goal object

    Note over API: Step 3: Send instruction
    API->>IGM: sendInstruction(sourceId, newGoalId,<br/>instruction, 'instruction')
    IGM->>DB: INSERT INTO inter_goal_messages<br/>(status: 'pending')
    IGM->>WS: broadcast(goal:instruction)
    WS-->>UI: goal:instruction
    IGM-->>API: InterGoalMessage

    alt Instruction send fails
        API->>GS: archive(goal.id)
        Note over API: Rollback: archive orphaned goal
        API-->>MCP: 500 error
    end

    Note over API: Step 4: Spawn session
    API->>CG: spawnSession(goalId, instruction)
    Note over CG: Claude CLI starts with<br/>instruction as initial prompt
    API->>IGM: markDelivered(message.id)
    IGM->>DB: UPDATE status='delivered'

    API-->>MCP: 201 {goal, instruction, session_id}
    MCP-->>PG: Tool result (JSON)

    Note over CG: Child processes the task autonomously

    rect rgb(240, 248, 255)
        Note over CG,PG: Worker reports results back
        CG->>MCP: send_goal_instruction<br/>{from_goal_id: childId,<br/>target_goal_id: parentId,<br/>content: "results...",<br/>message_type: 'result'}
        MCP->>API: POST /api/goals/{childId}/instruct/{parentId}
        API->>IGM: sendInstruction(childId, parentId,<br/>content, 'result')
        IGM->>DB: INSERT (type: 'result', status: 'pending')
        IGM->>WS: broadcast(goal:instruction)

        alt Parent has active session
            API->>PG: Auto-deliver result as follow-up prompt
            API->>IGM: markDelivered(message.id)
        end
    end

    Note over PG: Parent receives result,<br/>may dispatch more work<br/>or aggregate results
```

### Orchestration Lifecycle

```mermaid
stateDiagram-v2
    state "Parent Goal (Control)" as PG {
        [*] --> Planning: Analyze task
        Planning --> Delegating: Identify subtasks
        Delegating --> Waiting: create_goal_and_instruct<br/>for each subtask
        Waiting --> Aggregating: Receive results via<br/>goal:instruction (type=result)
        Aggregating --> Delegating: More work needed
        Aggregating --> Complete: All results collected
    }

    state "Child Goal (Worker)" as CG {
        [*] --> Receiving: Session starts with<br/>instruction as prompt
        Receiving --> Working: Process the task
        Working --> Reporting: send_goal_instruction<br/>(type=result)
        Working --> StatusUpdate: send_goal_instruction<br/>(type=status_update)
        StatusUpdate --> Working: Continue processing
        Reporting --> [*]: Task complete
    }

    PG --> CG: create_goal_and_instruct
    CG --> PG: send_goal_instruction\n(type=result)
```

### Fan-Out / Fan-In Pattern

A common orchestration pattern: the parent goal fans out work to multiple child goals, then fans in the results.

```mermaid
flowchart TB
    PG["Parent Goal<br/>(Orchestrator)"]

    PG -->|"create_goal_and_instruct<br/>task: 'Analyze module A'"| CG1["Child Goal 1<br/>(Worker)"]
    PG -->|"create_goal_and_instruct<br/>task: 'Analyze module B'"| CG2["Child Goal 2<br/>(Worker)"]
    PG -->|"create_goal_and_instruct<br/>task: 'Analyze module C'"| CG3["Child Goal 3<br/>(Worker)"]

    CG1 -->|"send_goal_instruction<br/>type: result"| PG
    CG2 -->|"send_goal_instruction<br/>type: result"| PG
    CG3 -->|"send_goal_instruction<br/>type: result"| PG

    PG -->|"Aggregated results"| DONE["Final Output"]

    style PG fill:#fff3e0
    style CG1 fill:#e8f5e9
    style CG2 fill:#e8f5e9
    style CG3 fill:#e8f5e9
    style DONE fill:#e1f5fe
```

### Failure Handling

The `create_goal_and_instruct` endpoint implements a rollback strategy for partial failures:

| Step | Failure Mode | Recovery |
|------|-------------|----------|
| Validate source goal | Source goal not found | Return 404, no state change |
| Create child goal | DB error | Return 500, no state change |
| Send instruction | DB error or broadcast failure | Archive orphaned goal, return 500 |
| Spawn session | PTY/CLI error | Log warning; goal + instruction still exist (can retry manually) |

The operation is not fully transactional — step 4 (session spawn) is best-effort. If it fails, the goal and instruction are preserved so the user can manually start the session later.
