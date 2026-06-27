import http from 'node:http';
import { loadEnv } from './env';
import { getDb, closeDb } from './db/connection';
import { runMigrations } from './db/migrate';
import { createApp } from './app';
import { setupWss } from './ws';
import { ScheduledTaskService } from './services/scheduled-task-service';
import { antigravityModelsService } from './services/antigravity-models-service';
import { claudeModelsService } from './services/claude-models-service';
import { codexModelsService } from './services/codex-models-service';
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
import { createTraceRouter } from './routes/trace';
import { createFileRouter } from './routes/file';
import { createProjectService } from './services/project-service';
import { createProjectsRouter } from './routes/projects';
import { createWorkspaceService } from './services/workspace-service';
import { createVerificationService } from './services/verification-service';
import { createVerificationRouter } from './routes/verification';
import { createBudgetService } from './services/budget-service';
import { createBudgetRouter } from './routes/budget';
import { resolveModel } from '../src/shared/agents/model-registry';
import { createReconciliationService } from './services/reconciliation-service';
import { resumeOrphans } from './resume-driver';
import { drainSessions } from './drain';
import { startTracePruneJob } from './trace-prune-job';
import type { ServerEvent } from '../src/shared/events';
import { broadcast, setTerminalHandler } from './ws';
import { ConversationLogger } from './services/conversation-logger';
import { findJsonlFile } from './services/transcript-service';
import { ingestAllSessions } from './services/ingestion-service';
import { createModelValidator } from './security/model-allow';
import { createConfigService } from './services/config-service';
import { HeadroomService } from './services/headroom-service';
import { headroomEnvFragment } from './headroom-env';
import { adapterForModel, getAdapter } from './agents/registry';
import type { AgentAdapter } from './agents/agent-adapter';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { OrchestratorStateService } from './services/orchestrator-state-service';
import { OrchestratorMessageService } from './services/orchestrator-message-service';
import { MemoryStore } from './orchestrator/memory-store';
import { buildSnapshot } from './orchestrator/snapshot';
import { BrainRunner } from './orchestrator/brain-runner';
import { ClaudeBrainProvider } from './orchestrator/brain-provider';
import { OrchestratorService } from './orchestrator/orchestrator-service';
import { createOrchestratorRouter } from './routes/orchestrator';
import { createOrchestratorChannelsRouter } from './routes/orchestrator-channels';
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
const projectService = createProjectService(db);
const goalService = createGoalService(db, projectService);
const workspaceService = createWorkspaceService(db, projectService);
const verificationService = createVerificationService(db, {
  // doneCommand comes from the goal's registered project (5A); none → 'skipped'.
  resolveDoneCommand: (goal) => {
    const proj = goal.project_id
      ? projectService.get(goal.project_id)
      : projectService.findByCwd(goal.cwd);
    return proj?.done_command ?? null;
  },
  // run in the isolated worktree (5B) when present, else the goal cwd.
  resolveWorkspace: (goal) => workspaceService.get(goal.id)?.worktree_path ?? goal.cwd,
});

// 5E: budget/quota guardrails. Reads live persisted config each call.
const readBudgetCfg = (): unknown => configService.getPersisted();
const budgetService = createBudgetService(db, readBudgetCfg);

/** Goal ids with a live runner in the process registry. */
function listRunningGoalIds(): string[] {
  return goalService
    .list({ status: 'active' })
    .filter((g) => processRegistry.has(g.id))
    .map((g) => g.id);
}

/** Live active-session counts per provider, attributed by each running goal's model. */
function activeSessionsByProvider(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const goalId of listRunningGoalIds()) {
    const g = goalService.get(goalId);
    const provider = resolveModel(g?.model ?? 'claude')?.provider ?? 'claude';
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}
const interGoalMessageService = createInterGoalMessageService(db);
const skillDirectoryService = createSkillDirectoryService(db);
const configService = createConfigService(db);

/** Manages the local Headroom proxy lifecycle and tracks its health. */
const headroomService = new HeadroomService();

/**
 * Headroom env fragment for a spawned session/brain. Returns { headroomBaseUrl }
 * only for the 'claude' provider AND when compression is enabled AND the proxy is
 * actually reachable; otherwise {} (launch normally). Headroom speaks the Anthropic
 * API, so non-Claude providers (Codex/Antigravity) never get the env. Fail-closed:
 * because the Vertex override is honored by the CLI, pointing a session at a dead
 * proxy would break it. Read live each spawn so toggling config / proxy state
 * takes effect without a restart.
 */
function headroomOpts(providerId: string): { headroomBaseUrl?: string } {
  if (providerId !== 'claude') return {};
  const h = configService.getPersisted().headroom;
  return h.enabled && headroomService.isHealthy() ? { headroomBaseUrl: h.baseUrl } : {};
}

// Phase 6: declared early so the approval/scheduler observers can reference it; the
// instance is assigned below once its deps (brain runner etc.) are constructed.
let orchestrator: OrchestratorService | undefined;
const approvalCoordinator = new ApprovalCoordinator(db, undefined, (approval) => {
  void orchestrator?.trigger({
    kind: 'approval',
    approvalId: approval.id,
    ...(approval.goal_id ? { goalId: approval.goal_id } : {}),
  });
});
const skillExecutionService = createSkillExecutionService(db);
const skillAnalysisService = createSkillAnalysisService(db);
const skillFileService = createSkillFileService(db);
const hookIngest = new HookIngest(db, approvalCoordinator, skillExecutionService, join(env.dataDir, 'traces'));

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

  // 5E: budget guardrail — block a new spawn that would breach a cap or the kill switch.
  const budgetDecision = budgetService.evaluateSpawn({
    goalId,
    model: goal.model ?? 'claude',
    activeForProvider:
      activeSessionsByProvider()[resolveModel(goal.model ?? 'claude')?.provider ?? 'claude'] ?? 0,
  });
  if (!budgetDecision.allowed) {
    logger.warn({ goalId, reason: budgetDecision.reason }, 'Spawn blocked by budget guardrail');
    throw new Error(`Spawn blocked: ${budgetDecision.reason}`);
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
  const adapter = resolveAdapterForModel(goal.model ?? 'default', enabledIds);

  // 5B: if the goal is in a registered project, provision/reuse an isolated git
  // worktree and run the PTY there (registration is the opt-in; idempotent so
  // resume lands in the same worktree). Unregistered cwds run in-place.
  let workspaceCwd: string | undefined;
  try {
    const ws = workspaceService.provision(goalId);
    if (ws) workspaceCwd = ws.worktree_path;
  } catch (err) {
    logger.warn({ err, goalId }, 'workspace provision failed — running in-place');
  }

  const ptyMgr = new PtyManager(goal, adapter, {
    broadcast,
    traceDir: join(env.dataDir, 'traces', goalId),
    ...(workspaceCwd ? { cwdOverride: workspaceCwd } : {}),
    ...headroomOpts(adapter.id),
    onExit(gId, exitCode) {
      logger.info({ goalId: gId, exitCode }, 'Terminal session ended');
      goalService.update(gId, { status: 'waiting' });
      sessionService.end(gId);
      goalService.setCurrentSession(gId, null);
      processRegistry.remove(gId);
      broadcast({ type: 'conversation:updated', goal_id: gId } as ServerEvent);
      const cl = conversationLoggers.get(gId);
      if (cl) { cl.stop(); conversationLoggers.delete(gId); }
      // 5C: run the verification gate (project doneCommand) on completion. Records
      // pass/fail/error/skipped + broadcasts; 'skipped' when no doneCommand is set.
      const exitedGoal = goalService.get(gId);
      if (exitedGoal) {
        void verificationService
          .runForGoal(exitedGoal, gId)
          .catch((err) => logger.error({ err, goalId: gId }, 'verification: run failed'));
      }
      // Phase 6: wake the orchestrator on a session ending (it may react/recommend).
      void orchestrator?.trigger({ kind: 'session_ended', sessionId: gId, goalId: gId });
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

const scheduler = new Scheduler(scheduledTaskService, createGoal, (info) => {
  void orchestrator?.trigger({ kind: 'scheduled', taskId: info.taskId, goalId: info.goalId });
});
const scheduledRouter = createScheduledRouter(scheduledTaskService, scheduler);
// cwd containment reverted for open home/LAN use — goals can run in any directory
// again (the validator restricted them to the repo dir). Re-add `validateCwd`
// (see ./security/path-allow) to lock this down. validateModel stays — it blocks
// arg-injection at near-zero cost and all real Claude models pass it.
/**
 * Routes a goal's model to its owning provider's adapter. Live model values (Claude
 * API ids, Codex slugs, Antigravity display names) are NOT in the adapters' static
 * models[], so registry.adapterForModel() can't match them and would fall back to
 * Claude — spawning Claude Code for, e.g., a Gemini goal. We first map the value to
 * its provider via the model-list service caches, then defer to the registry.
 */
function resolveAdapterForModel(model: string, enabledIds: string[]): AgentAdapter {
  if (model && model !== 'default') {
    const owners: Array<[string, () => string[]]> = [
      ['antigravity', () => antigravityModelsService.cachedValues()],
      ['codex', () => codexModelsService.cachedValues()],
      ['claude', () => claudeModelsService.cachedValues()],
    ];
    for (const [id, values] of owners) {
      if (enabledIds.includes(id) && values().includes(model)) {
        const adapter = getAdapter(id);
        if (adapter) return adapter;
      }
    }
  }
  return adapterForModel(model, enabledIds);
}

// Also accept the live catalog values the enabled providers currently offer (Claude
// API versions, Codex slugs like gpt-5.2, Antigravity display names) — these come from
// the providers' own model lists and the static registry's matchers don't recognize them.
const validateModel = createModelValidator(() => [
  ...claudeModelsService.cachedValues(),
  ...codexModelsService.cachedValues(),
  ...antigravityModelsService.cachedValues(),
]);
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService, { validateModel }, workspaceService);
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
  const adapter = resolveAdapterForModel(goal.model ?? 'default', enabledIds);

  // 5B: if the goal is in a registered project, provision/reuse an isolated git
  // worktree and run the PTY there (registration is the opt-in; idempotent so
  // resume lands in the same worktree). Unregistered cwds run in-place.
  let workspaceCwd: string | undefined;
  try {
    const ws = workspaceService.provision(goalId);
    if (ws) workspaceCwd = ws.worktree_path;
  } catch (err) {
    logger.warn({ err, goalId }, 'workspace provision failed — running in-place');
  }

  const ptyMgr = new PtyManager(goal, adapter, {
    broadcast,
    traceDir: join(env.dataDir, 'traces', goalId),
    ...(workspaceCwd ? { cwdOverride: workspaceCwd } : {}),
    ...headroomOpts(adapter.id),
    onExit(gId, exitCode) {
      logger.info({ goalId: gId, exitCode }, 'Restarted session ended');
      goalService.update(gId, { status: 'waiting' });
      sessionService.end(gId);
      goalService.setCurrentSession(gId, null);
      processRegistry.remove(gId);
      broadcast({ type: 'conversation:updated', goal_id: gId } as ServerEvent);
      const cl = conversationLoggers.get(gId);
      if (cl) { cl.stop(); conversationLoggers.delete(gId); }
      // 5C: run the verification gate (project doneCommand) on completion. Records
      // pass/fail/error/skipped + broadcasts; 'skipped' when no doneCommand is set.
      const exitedGoal = goalService.get(gId);
      if (exitedGoal) {
        void verificationService
          .runForGoal(exitedGoal, gId)
          .catch((err) => logger.error({ err, goalId: gId }, 'verification: run failed'));
      }
      // Phase 6: wake the orchestrator on a session ending (it may react/recommend).
      void orchestrator?.trigger({ kind: 'session_ended', sessionId: gId, goalId: gId });
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
  onConfigUpdated: (updated) => {
    headroomService.sync(updated.headroom);
  },
  skillRoots: [
    ...customSkillDirs,
    ...['skills', 'agents', 'hooks', 'commands'].flatMap((s) => [
      join(process.cwd(), '.claude', s),
      join(homedir(), '.claude', s),
    ]),
  ],
});
const skillsRouter = createSkillsRouter(skillExecutionService, skillAnalysisService, skillFileService);
const traceRouter = createTraceRouter(db, env.dataDir);
const fileRouter = createFileRouter();
const projectsRouter = createProjectsRouter(projectService);
const verificationRouter = createVerificationRouter(verificationService);

// Phase 6: orchestrator "Hawat" — disabled by default; enable via Settings/config.
const orchestratorStateService = new OrchestratorStateService(db);
const orchestratorMessageService = new OrchestratorMessageService(db);
const orchestratorMemory = new MemoryStore(env.dataDir);
const brainRunner = new BrainRunner(
  new ClaudeBrainProvider(adapterForModel('haiku', ['claude']).resolveBinary(), () => {
    const h = headroomOpts('claude');
    return h.headroomBaseUrl ? headroomEnvFragment(h.headroomBaseUrl) : {};
  }),
);
function orchestratorMcpConfigJson(): string {
  const mcpEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'dist', 'index.js');
  const mcpEnv: Record<string, string> = { CLAUDE_DECK_URL: `http://127.0.0.1:${env.port}` };
  const token = process.env['CLAUDE_DECK_TOKEN'];
  if (token && token.trim().length > 0) mcpEnv['CLAUDE_DECK_TOKEN'] = token;
  return JSON.stringify({
    mcpServers: { 'claude-deck': { command: 'node', args: [mcpEntry], env: mcpEnv } },
  });
}
orchestrator = new OrchestratorService({
  stateService: orchestratorStateService,
  messageService: orchestratorMessageService,
  memoryStore: orchestratorMemory,
  snapshotMd: () => buildSnapshot(db).toMarkdown(),
  mcpConfigJson: orchestratorMcpConfigJson,
  runFn: (prompt, onEvent) =>
    brainRunner.run(
      {
        prompt,
        model: orchestratorStateService.get().config.model,
        mcpConfigJson: orchestratorMcpConfigJson(),
        // recommend-not-act: the orchestrator brain runs SUPERVISED (--permission-mode
        // default), never bypassPermissions. Tool calls go through native handling.
        permissionMode: 'supervised',
      },
      onEvent,
    ),
  broadcast,
});
const orchestratorRouter = createOrchestratorRouter({
  stateService: orchestratorStateService,
  messageService: orchestratorMessageService,
  trigger: (t) => orchestrator!.trigger(t),
  ratifyApproval: (id, decision, reason) => approvalCoordinator.resolve(id, decision, reason),
});
const orchestratorChannelsRouter = createOrchestratorChannelsRouter({
  stateService: orchestratorStateService,
  trigger: (t) => orchestrator!.trigger(t),
});
const budgetRouter = createBudgetRouter(budgetService, {
  activeSessionsByProvider,
  fetchWindowUtilization: async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${env.port}/api/analytics/window-utilization`);
      if (!r.ok) return [];
      const body = (await r.json()) as { rows?: Array<{ provider: string; utilizationPct: number }> };
      return body.rows ?? [];
    } catch {
      return [];
    }
  },
  enabledProviders: () =>
    configService.getPersisted().providers.filter((p) => p.enabled).map((p) => p.id),
  routingConfig: () => ({ hotThresholdPct: 85, autoRoute: false }),
  readConfig: readBudgetCfg,
});

// Create Express app and HTTP server
const app = createApp({
  apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills, skillsRouter, traceRouter, fileRouter, projectsRouter, verificationRouter, budgetRouter, orchestratorRouter, orchestratorChannelsRouter],
  auth: { token: env.token },
});
// Make db available to routes that need it (analytics, hook-events)
(app as unknown as Record<string, unknown>).locals = { ...(app as unknown as { locals: Record<string, unknown> }).locals, db };
const server = http.createServer(app);

// WebSocket server. Empty allow-list = accept any Origin (restores pre-hardening
// behavior for open LAN access from personal devices on a trusted home network).
// Re-populate this list (or set CLAUDE_DECK_TOKEN) to lock the WS down again.
const wsAllowedOrigins: string[] = [];
setupWss(server, { token: env.token, allowedOrigins: wsAllowedOrigins });

// Start scheduler
scheduler.start();

// Schedule daily trace pruning (reads config.tracePruneDays fresh each run).
const tracePruneTask = startTracePruneJob(db, env.dataDir, () => configService.getPersisted().tracePruneDays);

// Phase 6: heartbeat sweep — every 3 minutes, only fires a trigger when the
// orchestrator is enabled (trigger() itself no-ops when disabled).
const heartbeatJob = cron.schedule('*/3 * * * *', () => {
  void orchestrator?.trigger({ kind: 'heartbeat' });
});

// 5E: every 30s, pause any running goal the budget guardrails flag (metered over-cap
// or the global kill switch). Inert unless a provider is metered with caps configured.
const budgetMonitor = setInterval(() => {
  try {
    for (const goalId of budgetService.evaluateRunningGoals(listRunningGoalIds())) {
      const runner = processRegistry.get(goalId);
      if (runner) {
        logger.warn({ goalId }, 'Budget guardrail: pausing running goal (over cap / kill switch)');
        void runner.interrupt();
        goalService.update(goalId, { status: 'waiting' });
      }
    }
  } catch (err) {
    logger.error({ err }, 'Budget monitor failed');
  }
}, 30_000);
budgetMonitor.unref();

// Start listening — bind to loopback by default; LAN exposure requires
// CLAUDE_DECK_BIND. loadEnv() already fail-closes a non-loopback bind with
// no token.
const reconciliationService = createReconciliationService(db);

server.listen(env.port, env.bindHost, () => {
  logger.info({ port: env.port, host: env.bindHost, lan: !env.isLoopback }, 'claude-deck server listening');

  // Start (or attach to) the Headroom compression proxy per persisted config.
  headroomService.sync(configService.getPersisted().headroom);

  // 5D: resume sessions orphaned by a previous shutdown/crash. A goal the DB still
  // believes is active/waiting, with an open session and no live process, is resumed
  // in its workspace (capability-gated; failures are isolated per orphan).
  try {
    const orphans = reconciliationService.findOrphans((goalId) => processRegistry.has(goalId));
    if (orphans.length > 0) {
      const enabledIds = configService.getPersisted().providers.filter((p) => p.enabled).map((p) => p.id);
      resumeOrphans(orphans, {
        canResume: (model) => resolveAdapterForModel(model ?? 'default', enabledIds).capabilities.canResume,
        resume: (o) => restartSession(o.sessionId, o.goalId),
      });
    }
  } catch (err) {
    logger.error({ err }, '5D: resume-on-boot reconciliation failed');
  }

  // Warm the Antigravity live-model cache (running `agy models` via PTY takes a few
  // seconds) so its picker is populated before the UI loads. Only when the provider
  // is enabled, and best-effort — failure just leaves the static fallback in place.
  try {
    const enabled = configService.getPersisted().providers.filter((p) => p.enabled).map((p) => p.id);
    if (enabled.includes('antigravity')) {
      void antigravityModelsService.warm();
    }
  } catch (err) {
    logger.warn({ err }, 'Antigravity model warm-up skipped');
  }
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop the scheduler first — no more cron fires
  scheduler.stop();
  clearInterval(ingestionInterval);
  clearInterval(budgetMonitor);
  heartbeatJob.stop();
  orchestrator?.shutdown();
  tracePruneTask.stop();
  logger.info('Scheduler stopped');

  // Stop the managed Headroom proxy
  void headroomService.shutdown().catch((err) => {
    logger.error({ err }, 'Failed to stop managed Headroom proxy');
  });

  // Deny all pending approvals so blocked hooks unblock
  approvalCoordinator.shutdown();
  logger.info('ApprovalCoordinator shut down');

  // Stop all conversation loggers
  for (const [, cl] of conversationLoggers) cl.stop();
  conversationLoggers.clear();

  // 5D: graceful drain — persist resume state for every live goal and mark it
  // 'waiting' BEFORE killing the PTYs, so the next boot resumes them.
  try {
    drainSessions(processRegistry.liveGoalIds(), (goalId) => {
      const ws = workspaceService.get(goalId);
      const goal = goalService.get(goalId);
      sessionService.recordResumeState(goalId, {
        providerSessionId: goalId, // Claude: provider session id == goal id
        workspacePath: ws?.worktree_path ?? goal?.cwd ?? null,
      });
      goalService.update(goalId, { status: 'waiting' });
    });
  } catch (err) {
    logger.error({ err }, '5D: drain failed');
  }

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
