import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Message, MessageRole } from '../../src/shared/types';
import type { ServerEvent } from '../../src/shared/events';
import logger from '../logger';

/** Maximum character length for content and tool_result stored in the database. */
const DB_CONTENT_CAP = 4000;

/** Truncation suffix appended when content exceeds the cap. */
const TRUNCATION_SUFFIX = '\u2026 [truncated; see trace]';

/**
 * Input for creating a new message. The `id` field is optional;
 * one will be generated if not provided.
 */
export interface AddMessageInput {
  id?: string | undefined;
  session_id: string;
  role: MessageRole;
  content?: string | null | undefined;
  tool_name?: string | null | undefined;
  tool_args?: string | null | undefined;
  tool_result?: string | null | undefined;
  tool_use_id?: string | null | undefined;
  token_in?: number | null | undefined;
  token_out?: number | null | undefined;
  created_at?: number | undefined;
}

/** Options for listing messages by session. */
export interface ListMessagesOptions {
  limit?: number | undefined;
  before?: number | undefined;
}

/**
 * Service for persisting and retrieving chat messages.
 *
 * Messages are stored per-session in the `messages` table.
 * Content and tool_result fields are truncated to 4000 characters
 * for database storage; full content lives in trace files.
 */
export class MessageService {
  private readonly insertStmt: Database.Statement;
  private readonly listBySessionStmt: Database.Statement;
  private readonly listBySessionBeforeStmt: Database.Statement;
  private readonly getSessionGoalIdStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly broadcastFn: (event: ServerEvent) => void,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_name, tool_args, tool_result, tool_use_id, token_in, token_out, created_at)
      VALUES (@id, @session_id, @role, @content, @tool_name, @tool_args, @tool_result, @tool_use_id, @token_in, @token_out, @created_at)
    `);

    this.listBySessionStmt = db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `);

    this.listBySessionBeforeStmt = db.prepare(`
      SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?
    `);

    this.getSessionGoalIdStmt = db.prepare(`
      SELECT goal_id FROM sessions WHERE id = ?
    `);
  }

  /**
   * Truncates a string to the database content cap (4000 chars).
   * If the string exceeds the cap, it is truncated and a suffix is appended.
   * Returns the original string if it is within the cap or null/undefined.
   */
  truncateForDb(content: string | null | undefined): string | null {
    if (content == null) return null;
    if (content.length <= DB_CONTENT_CAP) return content;
    return content.slice(0, DB_CONTENT_CAP - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }

  /**
   * Inserts a message into the database and broadcasts a `message:added` event.
   * Content and tool_result are truncated to 4000 chars for DB storage.
   * The broadcast includes the truncated content.
   * The goal_id for the broadcast is derived from the session's current goal_id.
   */
  add(input: AddMessageInput): Message {
    const now = Date.now();
    const message: Message = {
      id: input.id ?? uuidv4(),
      session_id: input.session_id,
      role: input.role,
      content: this.truncateForDb(input.content ?? null),
      tool_name: input.tool_name ?? null,
      tool_args: input.tool_args ?? null,
      tool_result: this.truncateForDb(input.tool_result ?? null),
      tool_use_id: input.tool_use_id ?? null,
      token_in: input.token_in ?? null,
      token_out: input.token_out ?? null,
      created_at: input.created_at ?? now,
    };

    this.insertStmt.run(message);
    logger.debug({ messageId: message.id, sessionId: message.session_id }, 'Message added');

    // Derive goal_id from the session for the broadcast
    const sessionRow = this.getSessionGoalIdStmt.get(input.session_id) as
      | { goal_id: string | null }
      | undefined;
    const goalId = sessionRow?.goal_id ?? null;

    this.broadcastFn({
      type: 'message:added',
      goal_id: goalId,
      session_id: message.session_id,
      message,
    });

    return message;
  }

  /**
   * Lists messages for a given session, ordered by created_at ascending.
   * Supports pagination via `limit` and `before` (created_at cursor).
   */
  listBySession(sessionId: string, opts?: ListMessagesOptions): Message[] {
    const limit = opts?.limit ?? 100;
    const before = opts?.before;

    let rows: unknown[];
    if (before != null) {
      rows = this.listBySessionBeforeStmt.all(sessionId, before, limit);
    } else {
      rows = this.listBySessionStmt.all(sessionId, limit);
    }

    return rows as Message[];
  }
}
