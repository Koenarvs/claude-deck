import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type {
  OrchestratorMessage,
  OrchestratorRole,
  OrchestratorChannel,
  TriggerKind,
} from '../../src/shared/orchestrator';

export interface AppendMessageInput {
  role: OrchestratorRole;
  channel: OrchestratorChannel;
  content: string;
  tool_calls_json: string | null;
  trigger_kind: TriggerKind | null;
}

interface MessageRow {
  id: string;
  role: OrchestratorRole;
  channel: OrchestratorChannel;
  content: string;
  tool_calls_json: string | null;
  trigger_kind: TriggerKind | null;
  created_at: number;
}

function rowToMessage(row: MessageRow): OrchestratorMessage {
  return {
    id: row.id,
    role: row.role,
    channel: row.channel,
    content: row.content,
    tool_calls_json: row.tool_calls_json,
    trigger_kind: row.trigger_kind,
    created_at: row.created_at,
  };
}

/** Persistence for the single orchestrator conversation thread (shared across faces). */
export class OrchestratorMessageService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Appends a message and returns the persisted row. */
  append(input: AppendMessageInput): OrchestratorMessage {
    const id = uuid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO orchestrator_messages (id, role, channel, content, tool_calls_json, trigger_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.role, input.channel, input.content, input.tool_calls_json, input.trigger_kind, now);
    return { id, ...input, created_at: now };
  }

  /** Returns the most recent `limit` messages in chronological order (oldest first). */
  list(limit: number): OrchestratorMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestrator_messages ORDER BY created_at ASC, rowid ASC LIMIT ?')
      .all(limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /** Returns the last `n` messages in chronological order (for the context bundle). */
  recent(n: number): OrchestratorMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestrator_messages ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(n) as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }
}
