import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { HeadroomConfig } from '../../src/shared/types';
import logger from '../logger';

type SpawnFn = (
  command: string,
  options: SpawnOptions,
) => ChildProcess;

/**
 * Manages a locally-started Headroom proxy process. When Headroom is enabled but
 * auto-start is off, Claude Deck simply points clients at the configured base URL
 * and assumes some external service is already listening there.
 */
export class HeadroomService {
  private child: ChildProcess | null = null;
  private signature: string | null = null;
  private desiredConfig: HeadroomConfig | null = null;
  private reconciling = false;
  private pendingReconcile = false;

  constructor(private readonly spawnFn: SpawnFn = nodeSpawn) {}

  sync(config: HeadroomConfig): void {
    this.desiredConfig = { ...config };
    this.requestReconcile();
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async shutdown(): Promise<void> {
    this.desiredConfig = null;
    await this.stop('shutdown');
  }

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
    const nextSignature = config ? `${config.command}\n${config.baseUrl}` : null;

    if (!shouldRun || !config) {
      await this.stop('disabled');
      return;
    }

    if (this.isRunning() && this.signature === nextSignature) return;

    if (this.child) await this.stop('config changed');
    this.start(config);
  }

  private start(config: HeadroomConfig): void {
    logger.info({ command: config.command, baseUrl: config.baseUrl }, 'Starting managed Headroom proxy');

    const child = this.spawnFn(config.command, {
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });

    this.child = child;
    this.signature = `${config.command}\n${config.baseUrl}`;

    child.once('spawn', () => {
      logger.info({ pid: child.pid, baseUrl: config.baseUrl }, 'Managed Headroom proxy started');
    });

    child.once('error', (err) => {
      logger.error({ err, command: config.command }, 'Managed Headroom proxy failed to start');
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
