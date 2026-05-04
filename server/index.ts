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
import { SessionRunner } from './session-runner';
import type { MessageService as RunnerMessageService, GoalService as RunnerGoalService, TraceWriter as RunnerTraceWriter, SkillProvider } from './session-runner';
import { createSkillDirectoryService } from './services/skill-directory-service';
import { scanSkillsForInjection } from './skill-scanner';
import { PtyManager } from './pty-manager';
import { SessionService } from './services/session-service';
import { MessageService } from './services/message-service';
import { createSessionsRouter } from './routes/sessions';
import { createSystemRouter } from './routes/system';
import { broadcast, setTerminalHandler } from './ws';
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
 * SkillProvider that reads enabled skill directories from the DB
 * and scans them for skills not under the goal's cwd.
 */
const skillProvider: SkillProvider = {
  getExternalSkills(cwd: string): Array<{ name: string; content: string }> {
    const enabledDirs = skillDirectoryService.listEnabled();
    if (enabledDirs.length === 0) return [];

    const dirPaths = enabledDirs.map((d) => d.path);
    const skills = scanSkillsForInjection(dirPaths, cwd);

    return skills
      .filter((s) => s.content != null)
      .map((s) => ({ name: s.name, content: s.content! }));
  },
};

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
    if (existing instanceof SessionRunner) {
      if (existing.hasExited()) {
        void existing.cleanup();
        processRegistry.remove(goalId);
      } else {
        void existing.sendFollowup(prompt);
        return existing.getSessionId() ?? 'resuming';
      }
    } else {
      // PtyManager or other — kill it before spawning a SessionRunner
      void existing.interrupt().then(() => existing.cleanup());
      processRegistry.remove(goalId);
    }
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
    skillProvider,
  });

  void runner.start(prompt);
  return runner.getSessionId() ?? 'starting';
}

/**
 * Spawns or resumes a PTY-based terminal session for a goal.
 * If the goal has a previous session that was never ended (ended_at IS NULL),
 * resumes it with --resume instead of creating a new session.
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

  // Check for a resumable session (ended_at IS NULL = never properly closed)
  const resumableSession = goal.current_session_id
    ? db.prepare(
        `SELECT id FROM sessions WHERE id = ? AND ended_at IS NULL`,
      ).get(goal.current_session_id) as { id: string } | undefined
    : undefined;

  processRegistry.set(goalId, ptyMgr);
  goalService.update(goalId, { status: 'active' });

  if (resumableSession) {
    logger.info({ goalId, sessionId: resumableSession.id }, 'Resuming previous session');
    goalService.setCurrentSession(goalId, resumableSession.id);
    ptyMgr.resume(resumableSession.id);
    return resumableSession.id;
  } else {
    // Don't pre-create session or set current_session_id here.
    // Claude Code generates its own session ID; the SessionStart hook
    // will create the session row and link it to this goal via cwd match.
    ptyMgr.start(initialPrompt);
    return goalId;
  }
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
const goalsRouter = createGoalsRouter(goalService, spawnGoalSession, spawnTerminalSession, interGoalMessageService);
const sessionsRouter = createSessionsRouter(sessionService, messageService);
const hooksRouter = createHooksRouter(hookIngest);
const approvalsRouter = createApprovalsRouter(db, approvalCoordinator);
const systemRouterWithSkills = createSystemRouter(skillDirectoryService);

// Create Express app and HTTP server
const app = createApp({ apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills] });
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
