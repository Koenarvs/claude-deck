import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  InterGoalMessage,
  InterGoalMessageType,
  InterGoalMessageStatus,
} from '../../src/shared/types';
import { broadcast } from '../ws';
import logger from '../logger';

// ── Row ↔ Domain Conversion ──────────────────────────────────────────────────

interface InterGoalMessageRow {
  id: string;
  from_goal_id: string;
  to_goal_id: string;
  content: string;
  message_type: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
}

/**
 * Converts a raw SQLite row into a typed InterGoalMessage domain object.
 */
function rowToMessage(row: InterGoalMessageRow): InterGoalMessage {
  return {
    id: row.id,
    from_goal_id: row.from_goal_id,
    to_goal_id: row.to_goal_id,
    content: row.content,
    message_type: row.message_type as InterGoalMessageType,
    status: row.status as InterGoalMessageStatus,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    acknowledged_at: row.acknowledged_at,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Creates an InterGoalMessageService bound to the given database instance.
 * Manages inter-goal communication: sending instructions, querying, and acknowledging.
 *
 * @param db - better-sqlite3 database instance (production or :memory: for tests)
 */
export function createInterGoalMessageService(db: Database.Database) {
  // ── Prepared Statements ──────────────────────────────────────────────────

  const insertStmt = db.prepare<
    [string, string, string, string, string, string, number]
  >(`INSERT INTO inter_goal_messages (id, from_goal_id, to_goal_id, content, message_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const getByIdStmt = db.prepare<[string], InterGoalMessageRow>(
    'SELECT * FROM inter_goal_messages WHERE id = ?',
  );

  const listForGoalStmt = db.prepare<[string], InterGoalMessageRow>(
    `SELECT * FROM inter_goal_messages
     WHERE to_goal_id = ? AND status IN ('pending', 'delivered')
     ORDER BY created_at ASC`,
  );

  const updateStatusStmt = db.prepare<[string, number, string]>(
    'UPDATE inter_goal_messages SET status = ?, delivered_at = ? WHERE id = ?',
  );

  const acknowledgeStmt = db.prepare<[number, string]>(
    "UPDATE inter_goal_messages SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?",
  );

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Sends an instruction (or other message type) from one goal to another.
   * Creates the message in 'pending' status and broadcasts a `goal:instruction` WS event.
   *
   * @param fromGoalId - The sending goal's UUID
   * @param toGoalId - The receiving goal's UUID
   * @param content - The message content
   * @param messageType - Type of message (default: 'instruction')
   * @returns The created InterGoalMessage
   */
  function sendInstruction(
    fromGoalId: string,
    toGoalId: string,
    content: string,
    messageType: InterGoalMessageType = 'instruction',
  ): InterGoalMessage {
    const id = uuidv4();
    const now = Date.now();

    insertStmt.run(id, fromGoalId, toGoalId, content, messageType, 'pending', now);

    const message = get(id);
    if (!message) {
      throw new Error(`Failed to create inter-goal message: row not found after insert (id=${id})`);
    }

    broadcast({ type: 'goal:instruction', message });
    logger.info(
      { messageId: id, from: fromGoalId, to: toGoalId, messageType },
      'Inter-goal instruction sent',
    );

    return message;
  }

  /**
   * Retrieves a single inter-goal message by ID.
   *
   * @param id - Message UUID
   * @returns The InterGoalMessage, or null if not found
   */
  function get(id: string): InterGoalMessage | null {
    const row = getByIdStmt.get(id);
    return row ? rowToMessage(row) : null;
  }

  /**
   * Returns pending and delivered messages for a goal, ordered by created_at.
   *
   * @param goalId - The target goal's UUID
   * @returns Array of InterGoalMessage
   */
  function getInstructions(goalId: string): InterGoalMessage[] {
    const rows = listForGoalStmt.all(goalId);
    return rows.map(rowToMessage);
  }

  /**
   * Marks a message as delivered. Called when the instruction is forwarded
   * to an active session as a follow-up prompt.
   *
   * @param messageId - Message UUID
   * @returns The updated InterGoalMessage
   * @throws Error if the message is not found
   */
  function markDelivered(messageId: string): InterGoalMessage {
    const existing = get(messageId);
    if (!existing) {
      throw new InterGoalMessageNotFoundError(messageId);
    }

    // Acknowledged is terminal — regressing it to 'delivered' would put the
    // message back in the delivered queue and re-deliver an instruction the
    // recipient already processed.
    if (existing.status === 'acknowledged') {
      logger.warn({ messageId }, 'markDelivered ignored: message already acknowledged');
      return existing;
    }

    const now = Date.now();
    updateStatusStmt.run('delivered', now, messageId);

    const updated = get(messageId);
    if (!updated) {
      throw new Error(`Message disappeared after update (id=${messageId})`);
    }

    logger.info({ messageId }, 'Inter-goal message marked as delivered');
    return updated;
  }

  /**
   * Marks a message as acknowledged.
   *
   * @param messageId - Message UUID
   * @returns The updated InterGoalMessage
   * @throws InterGoalMessageNotFoundError if the message is not found
   */
  function acknowledgeInstruction(messageId: string): InterGoalMessage {
    const existing = get(messageId);
    if (!existing) {
      throw new InterGoalMessageNotFoundError(messageId);
    }

    const now = Date.now();
    acknowledgeStmt.run(now, messageId);

    const updated = get(messageId);
    if (!updated) {
      throw new Error(`Message disappeared after acknowledge (id=${messageId})`);
    }

    logger.info({ messageId }, 'Inter-goal message acknowledged');
    return updated;
  }

  return {
    sendInstruction,
    get,
    getInstructions,
    markDelivered,
    acknowledgeInstruction,
  };
}

// ── Error Types ──────────────────────────────────────────────────────────────

/**
 * Error thrown when an inter-goal message is not found by ID.
 */
export class InterGoalMessageNotFoundError extends Error {
  public readonly messageId: string;

  constructor(messageId: string) {
    super(`Inter-goal message not found: ${messageId}`);
    this.name = 'InterGoalMessageNotFoundError';
    this.messageId = messageId;
  }
}

export type InterGoalMessageService = ReturnType<typeof createInterGoalMessageService>;
