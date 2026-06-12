import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OrchestratorPage from '../../../src/pages/OrchestratorPage';
import { useOrchestratorStore } from '../../../src/stores/useOrchestratorStore';

const getResponse = {
  state: {
    status: 'idle',
    last_wake_at: null,
    last_active_at: null,
    config: {
      enabled: true, persona_name: 'Hawat', model: 'haiku', idle_timeout_ms: 600000,
      max_concurrent_children: 3, max_depth: 2, discord_owner_id: null,
    },
  },
  messages: [
    { id: 'm1', role: 'owner', channel: 'app', content: 'status?', tool_calls_json: null, trigger_kind: 'owner_message', created_at: 1 },
    { id: 'm2', role: 'orchestrator', channel: 'app', content: 'All green.', tool_calls_json: '[{"tool":"list_goals","summary":"{}"}]', trigger_kind: 'owner_message', created_at: 2 },
  ],
};

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = impl(url, init);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
  }));
}

describe('OrchestratorPage', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({ messages: [], status: 'idle', toolLog: [], loaded: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hydrates from GET /api/orchestrator and renders the persona title + thread', async () => {
    mockFetch((url) => (url.endsWith('/api/orchestrator') ? getResponse : {}));
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);

    expect(await screen.findByText('Hawat')).toBeInTheDocument();
    expect(await screen.findByText('status?')).toBeInTheDocument();
    expect(screen.getByText('All green.')).toBeInTheDocument();
    // transparency: the persisted tool call is visible in the thread
    expect(screen.getByText(/list_goals/)).toBeInTheDocument();
  });

  it('posts an owner message to POST /api/orchestrator/messages', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return url.endsWith('/api/orchestrator') ? getResponse : { accepted: true };
    });
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);
    await screen.findByText('Hawat');

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'what now?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/api/orchestrator/messages') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.init!.body as string)).toEqual({ text: 'what now?' });
    });
  });

  it('renders live WS messages added to the store', async () => {
    mockFetch((url) => (url.endsWith('/api/orchestrator') ? getResponse : {}));
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);
    await screen.findByText('Hawat');

    useOrchestratorStore.getState().addMessage({
      id: 'm3', role: 'orchestrator', channel: 'discord', content: 'From Discord.',
      tool_calls_json: null, trigger_kind: 'owner_message', created_at: 3,
    });
    expect(await screen.findByText('From Discord.')).toBeInTheDocument();
  });
});
