import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { HeadroomService } from '../../../server/services/headroom-service';
import type { HeadroomConfig } from '../../../src/shared/types';

class MockChild extends EventEmitter {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

const config: HeadroomConfig = {
  enabled: true,
  baseUrl: 'http://localhost:8787',
  launchOnStartup: true,
  command: 'headroom proxy --port 8787',
};

async function flushReconcile(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('HeadroomService', () => {
  let children: MockChild[];
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    children = [];
    spawnFn = vi.fn((_command: string, _options: SpawnOptions) => {
      const child = new MockChild();
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    });
  });

  it('starts a managed proxy when enabled and auto-start is on', () => {
    const svc = new HeadroomService(spawnFn);
    svc.sync(config);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith(
      'headroom proxy --port 8787',
      expect.objectContaining({ shell: true, stdio: 'ignore', windowsHide: true }),
    );
  });

  it('does not start when auto-start is disabled', () => {
    const svc = new HeadroomService(spawnFn);
    svc.sync({ ...config, launchOnStartup: false });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('restarts the managed proxy when command or base URL changes', async () => {
    const svc = new HeadroomService(spawnFn);
    svc.sync(config);
    await flushReconcile();
    svc.sync({ ...config, command: 'headroom proxy --port 9999' });
    await flushReconcile();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(children[0]?.killed).toBe(true);
  });

  it('stops the managed proxy when disabled', async () => {
    const svc = new HeadroomService(spawnFn);
    svc.sync(config);
    await flushReconcile();
    svc.sync({ ...config, enabled: false });
    await flushReconcile();
    expect(children[0]?.killed).toBe(true);
  });

  it('stops the managed proxy on shutdown', async () => {
    const svc = new HeadroomService(spawnFn);
    svc.sync(config);
    await flushReconcile();
    await svc.shutdown();
    expect(children[0]?.killed).toBe(true);
  });
});
