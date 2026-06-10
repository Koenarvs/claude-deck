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
import { ingestAllSessions } from './services/ingestion-service';
import { createCwdValidator } from './security/path-allow';
import { createModelValidator } from './security/model-allow';
import { createConfigService } from './services/config-service';
import { adapterForModel } from './agents/registry';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from './logger';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const env = loadEnv();

// Initialize database
const db = getDb(env.dataDir);
runMigrations(db);
logger.info({ dataDir: env.dataDir }, 'Database initialized');

// Ingest JSONL session files into session_usage table (async, non-blocking)
logger.info({ projectsDir: CLAUDE_PROJECTS_DIR }, 'Starting JSONL ingestion');
const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM session_usage').get() as { c: number }).c;
logger.info({ beforeCount }, 'session_usage rows before ingestion');
ingestAllSessions(db, CLAUDE_PROJECTS_DIR).then(() => {
  const afterCount = (db.prepare('SELECT COUNT(*) as c FROM session_usage').get() as { c: number }).c;
  logger.info({ afterCount }, 'Initial JSONL ingestion complete');
}).catch((err) => {
  logger.error({ err }, 'Initial JSONL ingestion failed');
});

// Periodic re-ingestion every 5 minutes
const ingestionInterval = setInterval(() => {
  ingestAllSessions(db, CLAUDE_PROJECTS_DIR).catch((err) => {
    logger.error({ err }, 'Periodic JSONL ingestion failed');
  });
}, 5 * 60 * 1000);

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
const configService = createConfigService(db);
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

  // Session ID = Goal ID. Check Claude Code's own session storage
  // (the JSONL file) to decide resume vs new — it's the source of truth.
  const hasExistingSession = findJsonlFile(goalId) !== null;

  // Update status before spawning PTY — throws DuplicateGoalTitleError
  // if an archived goal's title conflicts with a non-archived goal
  goalService.update(goalId, { status: 'active' });
  goalService.setCurrentSession(goalId, goalId);

  const enabledIds = configService.getPersisted().providers.filter((p) => p.enabled).map((p) => p.id);
  const adapter = adapterForModel(goal.model ?? 'default', enabledIds);
  const ptyMgr = new PtyManager(goal, adapter, {
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
    onReady() {
      const pending = interGoalMessageService.getInstructions(goalId);
      const toDeliver = pending.filter(m => m.status === 'pending');
      if (toDeliver.length === 0) return;
      logger.info({ goalId, count: toDeliver.length }, 'Notifying goal of pending instructions');
      const runner = processRegistry.get(goalId);
      if (runner instanceof PtyManager && runner.isAlive()) {
        runner.write('You have ' + toDeliver.length + ' pending inter-goal instruction(s). '
          + 'Use the check_instructions tool to retrieve and process them.');
        setTimeout(() => runner.write('\r'), 200);
      }
    },
  });

  processRegistry.set(goalId, ptyMgr);

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
const validateCwd = createCwdValidator({ allowedRoots: env.allowedRoots });
const validateModel = createModelValidator();
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService, { validateCwd, validateModel });
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

  // Restore goal to the board if it was archived — do this before spawning
  // the PTY so a DuplicateGoalTitleError bails out without orphaned processes
  goalService.update(goalId, { status: 'active' });
  goalService.setCurrentSession(goalId, goalId);

  // Re-activate the session so it shows as active on the Sessions tab
  db.prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`).run(sessionId);
  broadcast({ type: 'session:started', session: { id: sessionId, goal_id: goalId, ended_at: null } });

  const enabledIds = configService.getPersisted().providers.filter((p) => p.enabled).map((p) => p.id);
  const adapter = adapterForModel(goal.model ?? 'default', enabledIds);
  const ptyMgr = new PtyManager(goal, adapter, {
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
    onReady() {
      const pending = interGoalMessageService.getInstructions(goalId);
      const toDeliver = pending.filter(m => m.status === 'pending');
      if (toDeliver.length === 0) return;
      logger.info({ goalId, count: toDeliver.length }, 'Notifying restarted goal of pending instructions');
      const runner = processRegistry.get(goalId);
      if (runner instanceof PtyManager && runner.isAlive()) {
        runner.write('You have ' + toDeliver.length + ' pending inter-goal instruction(s). '
          + 'Use the check_instructions tool to retrieve and process them.');
        setTimeout(() => runner.write('\r'), 200);
      }
    },
  });

  processRegistry.set(goalId, ptyMgr);

  const convLogger = new ConversationLogger(goalId, broadcast);
  conversationLoggers.set(goalId, convLogger);
  convLogger.rebuild();

  ptyMgr.resume(sessionId);
}

const sessionsRouter = createSessionsRouter(sessionService, messageService, restartSession);
const hooksRouter = createHooksRouter(hookIngest);
const approvalsRouter = createApprovalsRouter(db, approvalCoordinator);
const customSkillDirs = skillDirectoryService.list().map((d) => d.path);
const systemRouterWithSkills = createSystemRouter(skillDirectoryService, {
  configService,
  skillRoots: [
    ...customSkillDirs,
    ...['skills', 'agents', 'hooks', 'commands'].flatMap((s) => [
      join(process.cwd(), '.claude', s),
      join(homedir(), '.claude', s),
    ]),
  ],
});
const skillsRouter = createSkillsRouter(skillExecutionService, skillAnalysisService, skillFileService);

// Create Express app and HTTP server
const app = createApp({
  apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills, skillsRouter],
  auth: { token: env.token },
});
// Make db available to routes that need it (analytics, hook-events)
(app as unknown as Record<string, unknown>).locals = { ...(app as unknown as { locals: Record<string, unknown> }).locals, db };
const server = http.createServer(app);

// Attach WebSocket server. Origin allow-list mirrors the CORS list in app.ts;
// the token is the primary gate on LAN (Origin is CSRF defense-in-depth).
const wsAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4100',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4100',
  // SSH-tunnel alt port (a remote client whose local 5173 is taken forwards 5273 → 5173).
  'http://localhost:5273',
  'http://127.0.0.1:5273',
];
setupWss(server, { token: env.token, allowedOrigins: wsAllowedOrigins });

// Start scheduler
scheduler.start();

// Start listening — bind to loopback by default; LAN exposure requires
// CLAUDE_DECK_BIND. loadEnv() already fail-closes a non-loopback bind with
// no token.
server.listen(env.port, env.bindHost, () => {
  logger.info({ port: env.port, host: env.bindHost, lan: !env.isLoopback }, 'claude-deck server listening');
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop the scheduler first — no more cron fires
  scheduler.stop();
  clearInterval(ingestionInterval);
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
