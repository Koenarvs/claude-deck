import { describe, it, expect } from 'vitest';
import {
  ClaudeBrainProvider,
  parseStreamLine,
  extractMemoryUpdate,
} from '../../../server/orchestrator/brain-provider';

describe('ClaudeBrainProvider.buildInvocation', () => {
  it('builds headless print-mode args with model, mcp config, and output format', () => {
    const p = new ClaudeBrainProvider('/usr/bin/claude');
    const inv = p.buildInvocation({
      prompt: 'hello',
      model: 'haiku',
      mcpConfigJson: '{"mcpServers":{}}',
      permissionMode: 'supervised',
    });
    expect(inv.command).toBe('/usr/bin/claude');
    expect(inv.args).toContain('-p');
    expect(inv.args).toContain('hello');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('haiku');
    expect(inv.args).toContain('--output-format');
    expect(inv.args).toContain('stream-json');
  });

  it('passes through extra env overrides for headroom', () => {
    const p = new ClaudeBrainProvider('/usr/bin/claude', () => ({
      ANTHROPIC_BASE_URL: 'http://localhost:8787',
    }));
    const inv = p.buildInvocation({
      prompt: 'hello',
      model: 'haiku',
      mcpConfigJson: '{"mcpServers":{}}',
      permissionMode: 'supervised',
    });
    expect(inv.env).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:8787' });
  });
});

describe('parseStreamLine', () => {
  it('extracts assistant text', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } });
    expect(parseStreamLine(line)).toEqual([{ kind: 'text', text: 'hi there' }]);
  });
  it('extracts tool_use as a tool event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'create_goal', input: { title: 'X' } }] },
    });
    expect(parseStreamLine(line)).toEqual([
      { kind: 'tool', tool: 'create_goal', summary: expect.stringContaining('X') },
    ]);
  });
  it('returns [] for non-JSON or irrelevant lines', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'result', result: 'done' }))).toEqual([]);
  });
});

describe('extractMemoryUpdate', () => {
  it('pulls the memory block out of the full transcript text', () => {
    const full = 'All good.\n<memory-update>\n# Orchestrator Memory\nWatching g1.\n</memory-update>';
    expect(extractMemoryUpdate(full)).toBe('# Orchestrator Memory\nWatching g1.');
  });
  it('returns null when no block is present', () => {
    expect(extractMemoryUpdate('no block here')).toBeNull();
  });
});
