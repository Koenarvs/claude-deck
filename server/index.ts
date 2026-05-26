import http from 'node:http';
import { loadEnv } from './env';
import { getDb, closeDb } from './db/connection';
import { runMigrations } from './db/migrate';
import { createApp } from './app';
import { setupWss } from './ws';
import { ScheduledTaskService } from './services/scheduled-task-service';
import { createGoalService } from './services/goal-service';
import { createInterGoalMessageService } from './services/inter-goal-message-service';
import { Scheduler } from './scheduler';
import { createScheduledRouter } from './routes/scheduled';
import { createGoalsRouter } from './routes/goals';
import { ApprovalCoordinator } from './approval-coordinator';
import { HookIngest } from './hook-ingest';
import { createHooksRouter } from './routes/hooks';
import { createApprovalsRouter } from './routes/approvals';
import { processRegistry } from './process-registry';
import { hookInstallerService } from './services/hook-installer-service';
import { createSkillDirectoryService } from './services/skill-directory-service';
import { createSkillExecutionService } from './services/skill-execution-service';
import { createSkillAnalysisService } from './services/skill-analysis-service';
import { createSkillFileService } from './services/skill-file-service';
import { createSkillsRouter } from './routes/skills';
import { PtyManager } from './pty-manager';
import { SessionService } from './services/session-service';
import { MessageService } from './services/message-service';
import { createSessionsRouter } from './routes/sessions';
import { createSystemRouter } from './routes/system';
import type { ServerEvent } from '../src/shared/events';
import { broadcast, setTerminalHandler } from './ws';
import { ConversationLogger } from './services/conversation-logger';
import { findJsonlFile } from './services/transcript-service';
import logger from './logger';

const env = loadEnv();

// Initialize database
const db = getDb(env.dataDir);
runMigrations(db);
logger.info({ dataDir: env.dataDir }, 'Database initialized');

// On startup, log resumable sessions (goals with ended_at IS NULL).
// These will be resumed when the user opens the goal in the UI.
// Only close truly abandoned sessions (older than 24 hours with no goal).
const ABANDONED_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const abandonedCutoff = Date.now() - ABANDONED_THRESHOLD_MS;
const abandonedResult = db.prepare(`
  UPDATE sessions
  SET ended_at = ?
  WHERE ended_at IS NULL AND goal_id IS NULL AND started_at < ?
`).run(Date.now(), abandonedCutoff);
if (abandonedResult.changes > 0) {
  logger.info({ closedCount: abandonedResult.changes }, 'Closed abandoned sessions (no goal, >24h old)');
}

const resumable = db.prepare(`
  SELECT s.id as session_id, s.goal_id, g.title as goal_title
  FROM sessions s
  JOIN goals g ON s.goal_id = g.id
  WHERE s.ended_at IS NULL AND g.status NOT IN ('complete', 'archived')
`).all() as Array<{ session_id: string; goal_id: string; goal_title: string }>;
if (resumable.length > 0) {
  logger.info({ count: resumable.length, goals: resumable.map(r => r.goal_title) }, 'Resumable sessions found — will resume when goals are opened');
}

// Auto-ensure hooks are installed in ~/.claude/settings.json
hookInstallerService.status().then(async (hookStatus) => {
  if (!hookStatus.installed) {
    logger.info('Hooks not found in settings.json — auto-installing');
    try {
      await hookInstallerService.install();
      logger.info('Hooks auto-installed successfully');
    } catch (err) {
      logger.error({ err }, 'Failed to auto-install hooks');
    }
  } else {
    logger.info('Hooks verified in settings.json');
  }
}).catch((err) => {
  logger.error({ err }, 'Failed to check hook status');
});

// Initialize services
const scheduledTaskService = new ScheduledTaskService(db);
const goalService = createGoalService(db);
const interGoalMessageService = createInterGoalMessageService(db);
const skillDirectoryService = createSkillDirectoryService(db);
const approvalCoordinator = new ApprovalCoordinator(db);
const skillExecutionService = createSkillExecutionService(db);
const skillAnalysisService = createSkillAnalysisService(db);
const skillFileService = createSkillFileService(db);
const hookIngest = new HookIngest(db, approvalCoordinator, skillExecutionService);

/**
 * Goal creator — delegates to the real goal service.
 * Scheduler calls this when a scheduled task fires.
 */
function createGoal(input: import('../src/shared/types').CreateGoalInput): { id: string } {
  const goal = goalService.create(input);
  return { id: goal.id };
}

const sessionService = new SessionService(db, broadcast);
const messageService = new MessageService(db, broadcast);

const conversationLoggers = new Map<string, ConversationLogger>();

/**
 * Spawns or resumes a PTY-based terminal session for a goal.
 * If a PTY is already running and a prompt is provided, delivers
 * the prompt to the running session instead of silently dropping it.
 */
function spawnTerminalSession(goalId: string, initialPrompt?: string): string {
  const goal = goalService.get(goalId);
  if (!goal) throw new Error('Goal not found');

  const existing = processRegistry.get(goalId);
  if (existing && existing instanceof PtyManager && existing.isAlive()) {
    if (initialPrompt) {
      existing.write(initialPrompt);
      setTimeout(() => existing.write('\r'), 200);
      logger.info({ goalId, promptLength: initialPrompt.length }, 'Delivered prompt to running PTY session');
    }
    return 'already_running';
  }

  if (existing) {
    void existing.interrupt().then(() => existing.cleanup());
    processRegistry.remove(goalId);
  }

  const ptyMgr = new PtyManager(goal, {
    broadcast,
    onExit(gId, exitCode) {
      logger.info({ goalId: gId, exitCode }, 'Terminal session ended');
      goalService.update(gId, { status: 'waiting' });
      sessionService.end(gId);
      goalService.setCurrentSession(gId, null);
      processRegistry.remove(gId);
      broadcast({ type: 'conversation:updated', goal_id: gId } as ServerEvent);
      const cl = conversationLoggers.get(gId);
      if (cl) { cl.stop(); conversationLoggers.delete(gId); }
    },
  });

  // Session ID = Goal ID. Check Claude Code's own session storage
  // (the JSONL file) to decide resume vs new — it's the source of truth.
  const hasExistingSession = findJsonlFile(goalId) !== null;

  processRegistry.set(goalId, ptyMgr);
  goalService.update(goalId, { status: 'active' });
  goalService.setCurrentSession(goalId, goalId);

  const convLogger = new ConversationLogger(goalId, broadcast);
  conversationLoggers.set(goalId, convLogger);

  if (hasExistingSession) {
    logger.info({ goalId }, 'Resuming previous session (JSONL exists)');
    convLogger.rebuild();
    ptyMgr.resume(goalId);
  } else {
    logger.info({ goalId }, 'Starting new session');
    convLogger.start();
    ptyMgr.start(initialPrompt);
  }

  // Deliver any pending inter-goal messages queued while this goal had no active session
  const pending = interGoalMessageService.getInstructions(goalId);
  if (pending.length > 0) {
    logger.info({ goalId, count: pending.length }, 'Delivering pending inter-goal messages');
    for (const msg of pending) {
      if (msg.status === 'pending') {
        interGoalMessageService.markDelivered(msg.id);
      }
    }
  }

  return goalId;
}

// Wire terminal input/resize from WS to PTY managers
setTerminalHandler({
  onInput(goalId, data) {
    const runner = processRegistry.get(goalId);
    if (runner && runner instanceof PtyManager) {
      runner.write(data);
    }
  },
  onResize(goalId, cols, rows) {
    const runner = processRegistry.get(goalId);
    if (runner && runner instanceof PtyManager) {
      runner.resize(cols, rows);
    }
  },
});

const scheduler = new Scheduler(scheduledTaskService, createGoal);
const scheduledRouter = createScheduledRouter(scheduledTaskService, scheduler);
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService);
/**
 * Restarts an ended session by spawning a new PTY with --resume.
 * Called by the sessions route POST /sessions/:id/restart.
 */
function restartSession(sessionId: string, goalId: string): void {
  const goal = goalService.get(goalId);
  if (!goal) throw new Error('Goal not found');

  const existing = processRegistry.get(goalId);
  if (existing && existing instanceof PtyManager && existing.isAlive()) {
    throw new Error('A session is already running for this goal');
  }

  if (existing) {
    void existing.interrupt().then(() => existing.cleanup());
    processRegistry.remove(goalId);
  }

  // Re-activate the session so it shows as active on the Sessions tab
  db.prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`).run(sessionId);
  broadcast({ type: 'session:started', session: { id: sessionId, goal_id: goalId, ended_at: null } });

  const ptyMgr = new PtyManager(goal, {
    broadcast,
    onExit(gId, exitCode) {
      logger.info({ goalId: gId, exitCode }, 'Restarted session ended');
      goalService.update(gId, { status: 'waiting' });
      sessionService.end(gId);
      goalService.setCurrentSession(gId, null);
      processRegistry.remove(gId);
      broadcast({ type: 'conversation:updated', goal_id: gId } as ServerEvent);
      const cl = conversationLoggers.get(gId);
      if (cl) { cl.stop(); conversationLoggers.delete(gId); }
    },
  });

  processRegistry.set(goalId, ptyMgr);
  // Restore goal to the board if it was archived
  goalService.update(goalId, { status: 'active' });
  goalService.setCurrentSession(goalId, goalId);

  const convLogger = new ConversationLogger(goalId, broadcast);
  conversationLoggers.set(goalId, convLogger);
  convLogger.rebuild();

  ptyMgr.resume(sessionId);
}

const sessionsRouter = createSessionsRouter(sessionService, messageService, restartSession);
const hooksRouter = createHooksRouter(hookIngest);
const approvalsRouter = createApprovalsRouter(db, approvalCoordinator);
const systemRouterWithSkills = createSystemRouter(skillDirectoryService);
const skillsRouter = createSkillsRouter(skillExecutionService, skillAnalysisService, skillFileService);

// Create Express app and HTTP server
const app = createApp({ apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills, skillsRouter] });
// Make db available to routes that need it (analytics, hook-events)
(app as unknown as Record<string, unknown>).locals = { ...(app as unknown as { locals: Record<string, unknown> }).locals, db };
const server = http.createServer(app);

// Attach WebSocket server
setupWss(server);

// Start scheduler
scheduler.start();

// Start listening
server.listen(env.port, () => {
  logger.info({ port: env.port }, 'claude-deck server listening');
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop the scheduler first — no more cron fires
  scheduler.stop();
  logger.info('Scheduler stopped');

  // Deny all pending approvals so blocked hooks unblock
  approvalCoordinator.shutdown();
  logger.info('ApprovalCoordinator shut down');

  // Stop all conversation loggers
  for (const [, cl] of conversationLoggers) cl.stop();
  conversationLoggers.clear();

  // Kill all CLI subprocesses managed by the process registry
  processRegistry
    .killAll()
    .then(() => {
      logger.info('All CLI subprocesses killed');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Error killing CLI subprocesses');
    });

  // Force-kill fallback after 5s
  const forceKillTimer = setTimeout(() => {
    logger.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 5000);
  forceKillTimer.unref();

  server.close(() => {
    logger.info('HTTP server closed');
    closeDb();
    logger.info('Database closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
