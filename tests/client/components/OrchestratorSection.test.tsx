import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrchestratorSection from '../../../src/components/settings/OrchestratorSection';

const config = {
  enabled: false, persona_name: 'Hawat', model: 'haiku', idle_timeout_ms: 600000,
  max_concurrent_children: 3, max_depth: 2, discord_owner_id: null,
};
const state = { status: 'idle', last_wake_at: null, last_active_at: null, config };

const modelOptions = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
];

function mockFetch(capture: (url: string, init?: RequestInit) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    capture(url, init);
    if (url.endsWith('/api/orchestrator')) return { ok: true, json: async () => ({ state, messages: [] }) } as Response;
    return { ok: true, json: async () => ({ ...config, persona_name: 'Thufir' }) } as Response;
  }));
}

describe('OrchestratorSection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('loads config and renders the persona name + model options from the catalog', async () => {
    mockFetch(() => {});
    render(<OrchestratorSection modelOptions={modelOptions} />);
    expect((await screen.findByLabelText(/persona name/i)) as HTMLInputElement).toHaveValue('Hawat');
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument();
  });

  it('PUTs an updated persona name to /api/orchestrator/config', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    mockFetch((url, init) => calls.push({ url, init }));
    render(<OrchestratorSection modelOptions={modelOptions} />);

    const input = await screen.findByLabelText(/persona name/i);
    fireEvent.change(input, { target: { value: 'Thufir' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/api/orchestrator/config') && c.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.init!.body as string).persona_name).toBe('Thufir');
    });
  });

  it('converts the idle-timeout minutes input to idle_timeout_ms', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    mockFetch((url, init) => calls.push({ url, init }));
    render(<OrchestratorSection modelOptions={modelOptions} />);

    const minutes = await screen.findByLabelText(/idle timeout/i);
    fireEvent.change(minutes, { target: { value: '5' } });
    fireEvent.blur(minutes);

    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/api/orchestrator/config') && c.init?.method === 'PUT');
      expect(JSON.parse(put!.init!.body as string).idle_timeout_ms).toBe(300000);
    });
  });
});
