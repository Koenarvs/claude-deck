// A fake second provider used to test the multi-provider registry, picker union,
// and capability-gated UI without a real CLI. Deliberately declares some
// capabilities false to exercise honest UI degradation.

import type { AgentAdapter, PromptStrategy } from '../../server/agents/agent-adapter';
import type {
  ModelOption,
  SpawnContext,
  RawUsage,
  ModelPricing,
  AgentCapabilities,
} from '../../src/shared/agents/types';

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly label = 'Mock Agent';
  readonly models: ModelOption[] = [{ value: 'mock', label: 'Mock' }];
  readonly capabilities: AgentCapabilities = {
    canObserveHooks: false,
    canResume: false,
    canMcp: false,
    canApprove: false,
    canStream: true,
  };
  readonly authHint = 'set MOCK_API_KEY';
  readonly promptStrategy: PromptStrategy = { kind: 'idle', idleMs: 1000 };

  resolveBinary(): string {
    return 'mock';
  }
  buildStartArgs(ctx: SpawnContext): string[] {
    return ['--mock', ctx.goalId];
  }
  buildResumeArgs(sessionId: string): string[] {
    return ['--mock-resume', sessionId];
  }
  prepareContext(): void {}

  async installHooks(): Promise<void> {}
  async uninstallHooks(): Promise<void> {}
  async hooksInstalled(): Promise<boolean> {
    return false;
  }

  locateSessionLog(): string | null {
    return null;
  }
  parseUsage(): RawUsage {
    return {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      messageCount: 0, model: 'mock', byModel: [],
    };
  }
  listSessionLogs(): string[] {
    return [];
  }
  pricingFor(): ModelPricing {
    return { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
  }
  contextWindowFor(): number {
    return 200_000;
  }
}
