// server/agents/claude-adapter.ts
//
// The reference AgentAdapter implementation. Wraps the logic that exists today
// in pty-manager / hook-installer-service / usage-service so Claude behaves
// byte-for-byte identically after the Task 9 PtyManager refactor.

import { execSync } from 'node:child_process';
import type { AgentAdapter, PromptStrategy } from './agent-adapter';
import type {
  ModelOption,
  SpawnContext,
  RawUsage,
  ModelPricing,
  McpServerDescriptor,
  AgentCapabilities,
} from '../../src/shared/agents/types';
import { MODEL_REGISTRY } from '../../src/shared/agents/model-registry';
import { hookInstallerService } from '../services/hook-installer-service';
import {
  parseClaudeUsage,
  locateClaudeJsonl,
  listClaudeJsonl,
  claudePricingFor,
  claudeContextWindow,
} from '../services/usage-service';

let cachedPath: string | null = null;

/** Serialize the MCP descriptor exactly as pty-manager.buildMcpConfig does today. */
function serializeMcp(mcp: McpServerDescriptor): string {
  return JSON.stringify({
    mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: mcp.env } },
  });
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  // Derived from the shared registry (single source of truth) so the Claude picker
  // stays in sync with pricing/tier/quota — matching the codex + antigravity
  // adapters. The 'default' sentinel ("let the CLI choose") is Claude-specific and
  // not a registry model, so it is prepended. Values are registry ids, passed
  // verbatim as `--model` (opus/sonnet/haiku/fable-5).
  readonly models: ModelOption[] = [
    { value: 'default', label: 'Default' },
    ...MODEL_REGISTRY.filter((m) => m.provider === 'claude').map((m) => ({
      value: m.id,
      label: m.label,
    })),
  ];
  readonly capabilities: AgentCapabilities = {
    canObserveHooks: true,
    canResume: true,
    canMcp: true,
    canApprove: true,
    canStream: true,
  };
  // Matches today's inline prompt-readiness detection in pty-manager.start().
  readonly promptStrategy: PromptStrategy = {
    kind: 'regex',
    promptRegex: /(?:>{1,2}|❯) \s*$/,
    idleMs: 5000,
  };

  resolveBinary(): string {
    if (cachedPath) return cachedPath;
    try {
      let p = execSync('which claude', { encoding: 'utf-8' }).trim();
      if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
      if (process.platform === 'win32' && !p.endsWith('.exe')) p += '.exe';
      cachedPath = p;
    } catch {
      cachedPath = process.platform === 'win32' ? 'claude.exe' : 'claude';
    }
    return cachedPath;
  }

  buildStartArgs(ctx: SpawnContext): string[] {
    const args: string[] = ['--session-id', ctx.goalId];
    if (ctx.permissionMode === 'autonomous') args.push('--dangerously-skip-permissions');
    if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
    if (ctx.agentType) args.push('--agent', ctx.agentType);
    if (ctx.mcpServer) args.push('--mcp-config', serializeMcp(ctx.mcpServer));
    return args;
  }

  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
    // Note: resume does NOT pass --model (matches today's behavior).
    const args: string[] = ['--resume', sessionId];
    if (ctx.permissionMode === 'autonomous') args.push('--dangerously-skip-permissions');
    if (ctx.agentType) args.push('--agent', ctx.agentType);
    if (ctx.mcpServer) args.push('--mcp-config', serializeMcp(ctx.mcpServer));
    return args;
  }

  prepareContext(_ctx: SpawnContext): void {
    // Claude reads CLAUDE.md natively from the cwd; no staging needed today.
    // Phase 3 providers (Codex → AGENTS.md, Antigravity → GEMINI.md) override this.
  }

  async installHooks(): Promise<void> {
    await hookInstallerService.install();
  }
  async uninstallHooks(): Promise<void> {
    await hookInstallerService.uninstall();
  }
  async hooksInstalled(): Promise<boolean> {
    return (await hookInstallerService.status()).installed;
  }

  locateSessionLog(sessionId: string): string | null {
    return locateClaudeJsonl(sessionId);
  }
  parseUsage(logPath: string): RawUsage {
    return parseClaudeUsage(logPath);
  }
  listSessionLogs(sinceMs: number): string[] {
    return listClaudeJsonl(sinceMs);
  }
  pricingFor(model: string): ModelPricing {
    return claudePricingFor(model);
  }
  contextWindowFor(model: string, currentTokens: number): number {
    return claudeContextWindow(model, currentTokens);
  }
}
