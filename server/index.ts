import http from 'node:http';
import { loadEnv } from './env';
import { getDb, closeDb } from './db/connection';
import { runMigrations } from './db/migrate';
import { createApp } from './app';
import { setupWss } from './ws';
import { ScheduledTaskService } from './services/scheduled-task-service';
import { createGoalService } from './services/goal-service';
import { Scheduler } from './scheduler';
import { createScheduledRouter } from './routes/scheduled';
import { createGoalsRouter } from './routes/goals';
import { ApprovalCoordinator } from './approval-coordinator';
import { HookIngest } from './hook-ingest';
import { createHooksRouter } from './routes/hooks';
import { createApprovalsRouter } from './routes/approvals';
import { processRegistry } from './process-registry';
import { hookInstallerService } from './services/hook-installer-service';
import { SessionRunner } from './session-runner';
import type { MessageService as RunnerMessageService, GoalService as RunnerGoalService, TraceWriter as RunnerTraceWriter } from './session-runner';
import { PtyManager } from './pty-manager';
import { SessionService } from './services/session-service';
import { MessageService } from './services/message-service';
import { createSessionsRouter } from './routes/sessions';
import systemRouter from './routes/system';
import { broadcast, setTerminalHandler } from './ws';
import logger from './logger';

const env = loadEnv();

// Initialize database
const db = getDb(env.dataDir);
runMigrations(db);
logger.info({ dataDir: env.dataDir }, 'Database initialized');

// Close orphaned sessions (active for >4 hours with no recent events)
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;
const staleCutoff = Date.now() - STALE_THRESHOLD_MS;
const staleResult = db.prepare(`
  UPDATE sessions
  SET ended_at = COALESCE(
    (SELECT MAX(created_at) FROM hook_events WHERE session_id = sessions.id),
    ?
  )
  WHERE ended_at IS NULL AND started_at < ?
`).run(Date.now(), staleCutoff);
if (staleResult.changes > 0) {
  logger.info({ closedCount: staleResult.changes }, 'Closed orphaned sessions on startup');
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
const approvalCoordinator = new ApprovalCoordinator(db);
const hookIngest = new HookIngest(db, approvalCoordinator);

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

/**
 * Spawns or resumes a Claude CLI session for a goal.
 * Called by the goals route POST /goals/:id/messages.
 */
function spawnGoalSession(goalId: string, prompt: string): string {
  const goal = goalService.get(goalId);
  if (!goal) throw new Error('Goal not found');

  // Check for existing runner
  const existing = processRegistry.get(goalId);
  if (existing) {
    const runner = existing as SessionRunner;
    void runner.sendFollowup(prompt);
    return runner.getSessionId() ?? 'resuming';
  }

  // Create adapter for SessionRunner dependencies
  const noopTraceWriter: RunnerTraceWriter = {
    appendStream() {},
    appendStderr() {},
    async close() {},
  };

  const msgAdapter: RunnerMessageService = {
    createSession(session) {
      sessionService.create({
        id: session.id,
        origin: session.origin as 'dashboard' | 'external',
        cwd: session.cwd ?? undefined,
        model: session.model ?? undefined,
        started_at: session.started_at ?? Date.now(),
        goal_id: session.goal_id,
      });
    },
    saveMessage(message) {
      messageService.add({
        session_id: message.session_id,
        role: message.role,
        content: message.content,
        tool_name: message.tool_name,
        tool_args: message.tool_args,
        tool_result: message.tool_result,
        tool_use_id: message.tool_use_id,
      });
    },
    endSession(sessionId) {
      sessionService.end(sessionId);
    },
    incrementStreamEventCount(sessionId) {
      sessionService.incrementCounters(sessionId, { stream: 1 });
    },
  };

  const goalAdapter: RunnerGoalService = {
    setCurrentSession(gId, sId) {
      goalService.setCurrentSession(gId, sId);
    },
    setStatus(gId, status) {
      goalService.update(gId, { status });
    },
  };

  const runner = new SessionRunner(goal, {
    traceWriter: noopTraceWriter,
    messageService: msgAdapter,
    goalService: goalAdapter,
    broadcast,
  });

  void runner.start(prompt);
  return runner.getSessionId() ?? 'starting';
}

/**
 * Spawns a PTY-based terminal session for a goal.
 * The terminal runs `claude` interactively — the user types directly.
 */
function spawnTerminalSession(goalId: string, initialPrompt?: string): string {
  const goal = goalService.get(goalId);
  if (!goal) throw new Error('Goal not found');

  const existing = processRegistry.get(goalId);
  if (existing && existing instanceof PtyManager && existing.isAlive()) {
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
      goalService.update(gId, { status: exitCode === 0 ? 'waiting' : 'waiting' });
    },
  });

  processRegistry.set(goalId, ptyMgr);
  goalService.update(goalId, { status: 'active' });
  goalService.setCurrentSession(goalId, ptyMgr.getSessionId());
  ptyMgr.start(initialPrompt);

  return ptyMgr.getSessionId();
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
const goalsRouter = createGoalsRouter(goalService, spawnGoalSession, spawnTerminalSession);
const sessionsRouter = createSessionsRouter(sessionService, messageService);
const hooksRouter = createHooksRouter(hookIngest);
const approvalsRouter = createApprovalsRouter(db, approvalCoordinator);

// Create Express app and HTTP server
const app = createApp({ apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouter] });
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
