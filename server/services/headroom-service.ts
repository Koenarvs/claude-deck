import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { HeadroomConfig } from '../../src/shared/types';
import { isVertex } from '../headroom-env';
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
  if (isVertex()) args.push('--vertex-api-url', config.vertexApiUrl);
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
    this.stopHealthLoop();
    await this.stop('shutdown');
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
    });

    child.once('error', (err) => {
      logger.error({ err, command }, 'Managed Headroom proxy failed to start');
      if (this.child === child) {
        this.child = null;
        this.signature = null;
      }
    });

    child.once('exit', (code, signal) => {
      logger.info({ pid: child.pid, code, signal }, 'Managed Headroom proxy exited');
      if (this.child === child) {
        this.child = null;
        this.signature = null;
      }
    });
  }

  private async stop(reason: string): Promise<void> {
    const child = this.child;
    this.child = null;
    this.signature = null;
    if (!child) return;
    if (child.exitCode !== null || child.killed) return;

    logger.info({ pid: child.pid, reason }, 'Stopping managed Headroom proxy');

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
