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

/** Map a compression degree to headroom proxy flags (mutually exclusive). */
const DEGREE_FLAGS: Record<HeadroomConfig['compressionDegree'], string[]> = {
  off: ['--no-optimize'],
  light: ['--target-ratio', '0.6'],
  balanced: ['--target-ratio', '0.4'],
  aggressive: ['--target-ratio', '0.3'],
};

/**
 * Build the `headroom proxy ...` command from the structured config. When the
 * advanced `command` override is set it wins verbatim; otherwise we derive the
 * port from baseUrl and append the Vertex upstream, compression degree, and
 * per-feature flags. Spawned with shell:true, so a joined string is fine.
 */
export function buildHeadroomCommand(config: HeadroomConfig): string {
  if (config.command && config.command.trim() !== '') return config.command;

  let port = '8787';
  try {
    const p = new URL(config.baseUrl).port;
    if (p) port = p;
  } catch {
    /* keep default */
  }

  const args = ['headroom', 'proxy', '--port', port];
  if (isVertex()) {
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

  static readonly MAX_CRASH_RESTARTS = 5;
  static readonly RESTART_DELAY_MS = 3_000;

  // Health polling
  private healthy = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthBaseUrl: string | null = null;
  private healthPath: '/livez' | '/readyz' = '/livez';

  constructor(private readonly spawnFn: SpawnFn = nodeSpawn) {}

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

    const command = buildHeadroomCommand(config);
    const nextSignature = `${command}\n${config.baseUrl}`;

    if (this.isRunning() && this.signature === nextSignature) return;

    if (this.child) await this.stop('config changed');
    this.start(command, config.baseUrl);
  }

  private start(command: string, baseUrl: string): void {
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
      this.crashCount = 0;
    });

    child.once('error', (err) => {
      logger.error({ err, command }, 'Managed Headroom proxy failed to start');
      if (this.child === child) {
        this.child = null;
        this.signature = null;
        this.scheduleRestart('spawn error');
      }
    });

    child.once('exit', (code, signal) => {
      logger.info({ pid: child.pid, code, signal }, 'Managed Headroom proxy exited');
      if (this.child === child) {
        this.child = null;
        this.signature = null;
        if (this.desiredConfig?.enabled) this.scheduleRestart('unexpected exit');
      }
    });
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
