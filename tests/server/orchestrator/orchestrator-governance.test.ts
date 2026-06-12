import { describe, it, expect, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { OrchestratorService } from '../../../server/orchestrator/orchestrator-service';
import type { BrainResult } from '../../../server/orchestrator/brain-runner';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeSvc() {
  const db = makeMigratedDb();
  const stateSvc = new OrchestratorStateService(db);
  stateSvc.updateConfig({ enabled: true, max_concurrent_children: 2, max_depth: 1 });
  return new OrchestratorService({
    stateService: stateSvc,
    messageService: new OrchestratorMessageService(db),
    memoryStore: { read: () => '', write: vi.fn() },
    snapshotMd: () => '',
    mcpConfigJson: () => '{}',
    runFn: async (): Promise<BrainResult> => ({ ok: true, exitCode: 0, fullText: '', memory: null, aborted: false }),
    broadcast: () => {},
  });
}

describe('OrchestratorService governance', () => {
  it('allows spawning under the concurrency cap', () => {
    expect(makeSvc().canSpawnChild({ liveChildren: 1, depth: 0 }).allowed).toBe(true);
  });
  it('blocks spawning at the concurrency cap', () => {
    const v = makeSvc().canSpawnChild({ liveChildren: 2, depth: 0 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('concurrent');
  });
  it('blocks spawning beyond the depth cap', () => {
    const v = makeSvc().canSpawnChild({ liveChildren: 0, depth: 1 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('depth');
  });
});
