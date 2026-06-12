import { describe, it, expect, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import {
  OrchestratorService,
  type OrchestratorServiceDeps,
} from '../../../server/orchestrator/orchestrator-service';
import type { BrainStreamEvent } from '../../../server/orchestrator/brain-provider';
import type { BrainResult } from '../../../server/orchestrator/brain-runner';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeService(overrides: Partial<OrchestratorServiceDeps> = {}) {
  const db = makeMigratedDb();
  const stateSvc = new OrchestratorStateService(db);
  stateSvc.updateConfig({ enabled: true, idle_timeout_ms: 50, model: 'haiku' });
  const msgSvc = new OrchestratorMessageService(db);

  const runFn = vi.fn(
    async (_prompt: string, onEvent: (e: BrainStreamEvent) => void): Promise<BrainResult> => {
      onEvent({ kind: 'text', text: 'Done. ' });
      return { ok: true, exitCode: 0, fullText: 'Done.', memory: '# Orchestrator Memory\nUpdated.', aborted: false };
    },
  );

  const svc = new OrchestratorService({
    stateService: stateSvc,
    messageService: msgSvc,
    memoryStore: { read: () => '# Orchestrator Memory\nold', write: vi.fn() },
    snapshotMd: () => '### Active goals\n- (none)',
    mcpConfigJson: () => '{}',
    runFn,
    broadcast: () => {},
    ...overrides,
  });
  return { svc, stateSvc, msgSvc, runFn };
}

describe('OrchestratorService', () => {
  it('processes an owner_message: persists owner + orchestrator turns', async () => {
    const { svc, msgSvc } = makeService();
    await svc.trigger({ kind: 'owner_message', text: 'status?', channel: 'app' });
    await svc.drain();
    const msgs = msgSvc.list(10);
    expect(msgs[0]?.role).toBe('owner');
    expect(msgs[0]?.content).toBe('status?');
    expect(msgs.some((m) => m.role === 'orchestrator' && m.content.includes('Done'))).toBe(true);
  });

  it('writes the extracted memory on a clean run', async () => {
    const writeMock = vi.fn();
    const { svc } = makeService({ memoryStore: { read: () => 'old', write: writeMock } });
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    expect(writeMock).toHaveBeenCalledWith('# Orchestrator Memory\nUpdated.');
  });

  it('does nothing when disabled', async () => {
    const { svc, stateSvc, runFn } = makeService();
    stateSvc.updateConfig({ enabled: false });
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    expect(runFn).not.toHaveBeenCalled();
  });

  it('serializes concurrent triggers (one run at a time)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runFn = vi.fn(
      async (_p: string, onEvent: (e: BrainStreamEvent) => void): Promise<BrainResult> => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        onEvent({ kind: 'text', text: 'x' });
        return { ok: true, exitCode: 0, fullText: 'x', memory: null, aborted: false };
      },
    );
    const { svc } = makeService({ runFn });
    await Promise.all([svc.trigger({ kind: 'heartbeat' }), svc.trigger({ kind: 'heartbeat' })]);
    await svc.drain();
    expect(maxConcurrent).toBe(1);
  });

  it('returns to idle after the idle timeout', async () => {
    const { svc, stateSvc } = makeService();
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    await new Promise((r) => setTimeout(r, 90));
    expect(stateSvc.get().status).toBe('idle');
  });
});
