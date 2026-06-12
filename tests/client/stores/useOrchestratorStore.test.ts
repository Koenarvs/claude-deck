import { describe, it, expect, beforeEach } from 'vitest';
import { useOrchestratorStore } from '../../../src/stores/useOrchestratorStore';
import type { OrchestratorMessage } from '../../../src/shared/orchestrator';

function msg(over: Partial<OrchestratorMessage> = {}): OrchestratorMessage {
  return {
    id: 'm1', role: 'orchestrator', channel: 'app', content: 'hi',
    tool_calls_json: null, trigger_kind: null, created_at: 1, ...over,
  };
}

describe('useOrchestratorStore', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({ messages: [], status: 'idle', toolLog: [], loaded: false });
  });

  it('hydrate replaces messages + status and marks loaded', () => {
    useOrchestratorStore.getState().hydrate([msg({ id: 'a' })], 'cooling');
    const s = useOrchestratorStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['a']);
    expect(s.status).toBe('cooling');
    expect(s.loaded).toBe(true);
  });

  it('addMessage appends, dedupes by id', () => {
    useOrchestratorStore.getState().addMessage(msg({ id: 'a' }));
    useOrchestratorStore.getState().addMessage(msg({ id: 'a' })); // duplicate
    useOrchestratorStore.getState().addMessage(msg({ id: 'b' }));
    expect(useOrchestratorStore.getState().messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('setStatus updates the lifecycle status', () => {
    useOrchestratorStore.getState().setStatus('active');
    expect(useOrchestratorStore.getState().status).toBe('active');
  });

  it('addTool appends a tool-call entry to the live log', () => {
    useOrchestratorStore.getState().addTool({ tool: 'create_goal', summary: '{"title":"X"}' });
    expect(useOrchestratorStore.getState().toolLog).toHaveLength(1);
    expect(useOrchestratorStore.getState().toolLog[0].tool).toBe('create_goal');
  });

  it('clearing the tool log on a fresh waking status keeps prior turns', () => {
    useOrchestratorStore.getState().addTool({ tool: 't', summary: 's' });
    useOrchestratorStore.getState().setStatus('waking'); // a new wake clears the live tool log
    expect(useOrchestratorStore.getState().toolLog).toHaveLength(0);
  });
});
