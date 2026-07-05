import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import type { HeadroomConfig } from '../../src/shared/types';
import {
  isVertex,
  vertexApiUrlForRegion,
  resolveVertexRegion,
  regionFromClaudeSettings,
} from '../headroom-env';
import logger from '../logger';

type SpawnFn = (
  command: string,
  options: SpawnOptions,
) => ChildProcess;

/**
 * Frees a TCP port before we (re)spawn the proxy. Injected into HeadroomService
 * so tests can supply a no-op instead of touching the real machine.
 */
export type PortReclaimer = (port: string, ownPid?: number) => void;

/** Map a compression degree to headroom proxy flags (mutually exclusive). */
const DEGREE_FLAGS: Record<HeadroomConfig['compressionDegree'], string[]> = {
  off: ['--no-optimize'],
  light: ['--target-ratio', '0.6'],
  balanced: ['--target-ratio', '0.4'],
  aggressive: ['--target-ratio', '0.3'],
};

/** Derive the proxy port from a baseUrl, falling back to 8787. */
export function portFromBaseUrl(baseUrl: string): string {
  try {
    const p = new URL(baseUrl).port;
    if (p) return p;
  } catch {
    /* keep default */
  }
  return '8787';
}

/** PIDs holding a LISTENING TCP socket on `port` (best-effort, per platform). */
function listenerPids(port: string): number[] {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
      if (out.status !== 0 || !out.stdout) return [];
      const pids = new Set<number>();
      for (const line of out.stdout.split(/\r?\n/)) {
        if (!/\bLISTENING\b/.test(line)) continue;
        // e.g.  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    16020
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && m[1] === port) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** True when the process's command line identifies it as a headroom proxy. */
function isHeadroomPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true },
      );
      return /headroom/i.test(out.stdout ?? '');
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /headroom/i.test(out.stdout ?? '');
  } catch {
    return false;
  }
}

/** Force-kill a process tree (Windows) or the process (POSIX). Best-effort. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Build a PortReclaimer from injectable IO seams so the decision logic is unit
 * testable without touching the machine. The policy is deliberately narrow: a
 * squatter is killed ONLY when it positively identifies as a headroom process
 * (a stale orphan from a Deck that exited uncleanly). A foreign, unrelated
 * process on the same port is logged and left untouched — we never kill
 * something we can't confirm is ours.
 */
export function makePortReclaimer(deps: {
  listenerPids: (port: string) => number[];
  isHeadroomPid: (pid: number) => boolean;
  killTree: (pid: number) => void;
}): PortReclaimer {
  return (port, ownPid) => {
    for (const pid of deps.listenerPids(port)) {
      if (ownPid && pid === ownPid) continue;
      if (deps.isHeadroomPid(pid)) {
        logger.warn({ pid, port }, 'Reclaiming port from stale Headroom process');
        deps.killTree(pid);
      } else {
        logger.error(
          { pid, port },
          'Port held by a non-Headroom process — leaving it alone; the proxy cannot start until the port is free',
        );
      }
    }
  };
}

/** Default reclaimer wired to the real per-platform IO helpers. */
export const reclaimStaleHeadroomPort: PortReclaimer = makePortReclaimer({
  listenerPids,
  isHeadroomPid,
  killTree,
});

/**
 * Build the `headroom proxy ...` command from the structured config. When the
 * advanced `command` override is set it wins verbatim; otherwise we derive the
 * port from baseUrl and append the Vertex upstream, compression degree, and
 * per-feature flags. Spawned with shell:true, so a joined string is fine.
 */
export function buildHeadroomCommand(config: HeadroomConfig, vertex: boolean = isVertex()): string {
  if (config.command && config.command.trim() !== '') return config.command;

  const args = ['headroom', 'proxy', '--port', portFromBaseUrl(config.baseUrl)];
  if (vertex) {
    // Vertex routes through headroom's DEDICATED Vertex passthrough, selected by
    // the `--vertex-api-url` + `--region` pair — NOT `--anthropic-api-url` (that
    // is the direct-Anthropic backend; pointing it at a Vertex host makes
    // headroom fall back to its default --region us-west-2, where the newer
    // models aren't deployed → 404 model_not_found).
    //
    // The region is resolved from the CLI's own ~/.claude settings first, then
    // the deck's process env, then the us-east5 default — so the proxy mirrors
    // whatever region the spawned `claude` sessions use and self-corrects when it
    // changes, even when the deck's launch shell never exported CLOUD_ML_REGION.
    // The host is derived from that same region unless an explicit override is
    // configured, and headroom fills the path's location from --region.
    const region = resolveVertexRegion(process.env, regionFromClaudeSettings());
    const override = config.vertexApiUrl?.trim();
    const url = override && override.length > 0 ? override : vertexApiUrlForRegion(region);
    args.push('--vertex-api-url', url, '--region', region);
  }
  args.push(...DEGREE_FLAGS[config.compressionDegree]);
  if (config.interceptToolResults) args.push('--intercept-tool-results');
  if (config.memory) args.push('--memory');
  return args.join(' ');
}

/**
 * Manages a locally-started Headroom proxy process and tracks its health. When
 * Headroom is enabled but auto-start is off, Claude Deck simply points clients at
 * the configured base URL and assumes some external service is already listening.
 *
 * `isHealthy()` is consulted before injecting the proxy into sessions: because the
 * Vertex override (ANTHROPIC_VERTEX_BASE_URL) IS honored by the CLI, pointing a
 * session at a dead proxy would break it — so injection is fail-closed.
 */
export class HeadroomService {
  private child: ChildProcess | null = null;
  private signature: string | null = null;
  private desiredConfig: HeadroomConfig | null = null;
  private reconciling = false;
  private pendingReconcile = false;
  private crashCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  static readonly MAX_CRASH_RESTARTS = 5;
  static readonly RESTART_DELAY_MS = 3_000;
  // A freshly-spawned proxy must stay up this long before we consider it stable
  // and reset the crash counter. Guards against a spawn-then-immediately-die loop
  // (e.g. it can't bind the port) resetting the counter on every spawn.
  static readonly STABLE_AFTER_MS = 15_000;

  // Health polling
  private healthy = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthBaseUrl: string | null = null;
  private healthPath: '/livez' | '/readyz' = '/livez';

  constructor(
    private readonly spawnFn: SpawnFn = nodeSpawn,
    private readonly reclaimPort: PortReclaimer = reclaimStaleHeadroomPort,
    /**
     * Resolves whether the proxy upstream should be Vertex at command-build time.
     * Injected so the persisted authMode setting (read fresh on each reconcile)
     * wins over the deck's ambient CLAUDE_CODE_USE_VERTEX.
     */
    private readonly resolveVertex: () => boolean = () => isVertex(),
  ) {}

  sync(config: HeadroomConfig): void {
    this.desiredConfig = { ...config };
    this.requestReconcile();
    if (config.enabled) this.startHealthLoop(config.baseUrl);
    else this.stopHealthLoop();
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async shutdown(): Promise<void> {
    this.desiredConfig = null;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.clearStableTimer();
    this.stopHealthLoop();
    await this.stop('shutdown');
  }

  /**
   * Synchronously kill the managed proxy AND its whole process tree. Safe to call
   * from a `process.on('exit')` / signal handler right before the deck exits: on
   * Windows the proxy is launched via `shell:true` (cmd.exe → python), so a normal
   * async `child.kill()` only reaps the cmd wrapper and orphans the python proxy —
   * which keeps holding port 8787 and answering with stale flags after the deck is
   * gone. `taskkill /T /F` reaps the entire tree; being synchronous, it completes
   * even when `process.exit()` races the async shutdown path.
   */
  killTreeSync(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.clearStableTimer();
    this.desiredConfig = null; // stop any restart from being scheduled
    const child = this.child;
    this.child = null;
    this.signature = null;
    const pid = child?.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch {
      /* best effort — nothing more we can do on the way out */
    }
  }

  // ── Health polling ──────────────────────────────────────────────────────────

  private startHealthLoop(baseUrl: string): void {
    if (this.healthTimer && this.healthBaseUrl === baseUrl) return; // already polling this URL
    this.stopHealthLoop();
    this.healthBaseUrl = baseUrl;
    this.healthPath = '/livez';
    void this.poll();
    this.healthTimer = setInterval(() => void this.poll(), 5000);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.healthBaseUrl = null;
    this.healthy = false;
  }

  private async poll(): Promise<void> {
    const baseUrl = this.healthBaseUrl;
    if (!baseUrl) return;
    try {
      let res = await fetch(`${baseUrl}${this.healthPath}`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 404 && this.healthPath === '/livez') {
        this.healthPath = '/readyz';
        res = await fetch(`${baseUrl}${this.healthPath}`, { signal: AbortSignal.timeout(1500) });
      }
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
  }

  // ── Process reconciliation ────────────────────────────────────────────────────

  private requestReconcile(): void {
    this.pendingReconcile = true;
    if (this.reconciling) return;

    this.reconciling = true;
    void this.reconcileLoop();
  }

  private async reconcileLoop(): Promise<void> {
    try {
      while (this.pendingReconcile) {
        this.pendingReconcile = false;
        await this.reconcile();
      }
    } finally {
      this.reconciling = false;
      if (this.pendingReconcile) this.requestReconcile();
    }
  }

  private async reconcile(): Promise<void> {
    const config = this.desiredConfig;
    const shouldRun = !!config?.enabled && !!config.launchOnStartup;

    if (!shouldRun || !config) {
      await this.stop('disabled');
      return;
    }

    const command = buildHeadroomCommand(config, this.resolveVertex());
    const nextSignature = `${command}\n${config.baseUrl}`;

    if (this.isRunning() && this.signature === nextSignature) return;

    if (this.child) await this.stop('config changed');
    this.start(command, config.baseUrl);
  }

  private start(command: string, baseUrl: string): void {
    // Reclaim the port from a STALE HEADROOM squatter (an orphan from a Deck that
    // exited uncleanly) so our spawn can bind. A foreign non-headroom process is
    // left alone by the reclaimer — see makePortReclaimer.
    this.reclaimPort(portFromBaseUrl(baseUrl));

    logger.info({ command, baseUrl }, 'Starting managed Headroom proxy');

    const child = this.spawnFn(command, {
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });

    this.child = child;
    this.signature = `${command}\n${baseUrl}`;

    child.once('spawn', () => {
      logger.info({ pid: child.pid, baseUrl }, 'Managed Headroom proxy started');
      // Reset the crash counter only after the proxy has stayed up for a grace
      // period — NOT on spawn. A process that spawns but dies within
      // STABLE_AFTER_MS (e.g. it can't bind the port) must keep counting toward
      // MAX_CRASH_RESTARTS instead of resetting on every spawn and looping forever.
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.child === child) this.crashCount = 0;
      }, HeadroomService.STABLE_AFTER_MS);
      this.stableTimer.unref?.();
    });

    child.once('error', (err) => {
      logger.error({ err, command }, 'Managed Headroom proxy failed to start');
      if (this.child === child) {
        this.clearStableTimer();
        this.child = null;
        this.signature = null;
        this.scheduleRestart('spawn error');
      }
    });

    child.once('exit', (code, signal) => {
      logger.info({ pid: child.pid, code, signal }, 'Managed Headroom proxy exited');
      if (this.child === child) {
        this.clearStableTimer();
        this.child = null;
        this.signature = null;
        if (this.desiredConfig?.enabled) this.scheduleRestart('unexpected exit');
      }
    });
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private scheduleRestart(reason: string): void {
    this.crashCount++;
    if (this.crashCount > HeadroomService.MAX_CRASH_RESTARTS) {
      logger.error({ crashCount: this.crashCount }, 'Headroom proxy exceeded max restarts, giving up');
      return;
    }
    logger.info({ reason, attempt: this.crashCount }, 'Scheduling Headroom proxy restart');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.requestReconcile();
    }, HeadroomService.RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  private async stop(reason: string): Promise<void> {
    this.clearStableTimer();
    const child = this.child;
    this.child = null;
    this.signature = null;
    if (!child) return;
    if (child.exitCode !== null || child.killed) return;

    const pid = child.pid;
    logger.info({ pid, reason }, 'Stopping managed Headroom proxy');

    // On Windows the proxy runs under `shell:true` (cmd.exe → python); a plain
    // child.kill() reaps only the shell and orphans the python proxy, which keeps
    // holding the port. taskkill /T kills the whole tree. See killTreeSync().
    if (process.platform === 'win32' && pid) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => { if (!settled) { settled = true; resolve(); } };
        const tk = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        tk.once('exit', finish);
        tk.once('error', finish);
        const guard = setTimeout(finish, 3000);
        guard.unref?.();
      });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };

      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      }, 3000);
      forceKillTimer.unref?.();

      child.once('exit', () => finish());
      child.once('error', () => finish());

      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
    });
  }
}
