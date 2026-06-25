import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '../../../src/stores/useConfigStore';
import type { AppConfig } from '../../../src/shared/types';
import type { AgentCatalogEntry } from '../../../src/shared/agents/types';

const caps = { canObserveHooks: false, canResume: true, canMcp: false, canApprove: false, canStream: true };
const catalogThreeProviders: AgentCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', enabled: true, capabilities: caps, models: [{ value: 'default', label: 'Default' }] },
  { id: 'codex', label: 'OpenAI Codex', enabled: false, capabilities: caps, models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
  { id: 'antigravity', label: 'Antigravity', enabled: false, capabilities: caps, models: [{ value: 'gemini-3-pro', label: 'Gemini 3 Pro' }] },
];

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

const defaultConfig: AppConfig = {
  homeRoute: '/board',
  dataDir: '/home/user/.claude-deck',
  hooksInstalled: false,
  tracePruneDays: 30,
  defaultModel: 'sonnet',
  defaultPermissionMode: 'supervised',
  providers: [{ id: 'claude', enabled: true, billingMode: 'seat' }],
  headroom: {
    enabled: true,
    baseUrl: 'http://localhost:8787',
    launchOnStartup: true,
    command: 'headroom proxy --port 8787',
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  useConfigStore.setState({ config: null, catalog: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockConfigFetch(config: AppConfig = defaultConfig) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(config),
      });
    }
    if (url === '/api/extensions') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hooks: {} }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  it('shows loading state initially', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    expect(screen.getByText('Loading settings...')).toBeInTheDocument();
  });

  it('renders page title after config loads', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByText(/Application configuration and hook management/)).toBeInTheDocument();
  });

  it('renders Hook Installation section', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Global Hooks')).toBeInTheDocument();
    });
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });

  it('renders Hook section as installed when hooksInstalled is true', async () => {
    mockConfigFetch({ ...defaultConfig, hooksInstalled: true });
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Installed')).toBeInTheDocument();
    });
  });

  it('renders Home Route toggle section', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Home Route')).toBeInTheDocument();
    });
    expect(screen.getByText('Kanban Board')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders Data Directory section', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Data Directory')).toBeInTheDocument();
    });
    expect(screen.getByText('/home/user/.claude-deck')).toBeInTheDocument();
  });

  it('renders Defaults section with model picker', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Defaults')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Default Model')).toBeInTheDocument();

    // Model options should be available
    const select = screen.getByLabelText('Default Model');
    expect(select).toHaveValue('sonnet');
  });

  it('renders Defaults section with permission mode buttons', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Default Permission Mode')).toBeInTheDocument();
    });

    expect(screen.getByText('Supervised')).toBeInTheDocument();
    expect(screen.getByText('Autonomous')).toBeInTheDocument();
    expect(screen.getByText('Tools require approval via the dashboard')).toBeInTheDocument();
    expect(screen.getByText('Tools are auto-approved')).toBeInTheDocument();
  });

  it('supervised mode button is pressed by default', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Supervised')).toBeInTheDocument();
    });

    const supervised = screen.getByText('Supervised').closest('button');
    expect(supervised).toHaveAttribute('aria-pressed', 'true');

    const autonomous = screen.getByText('Autonomous').closest('button');
    expect(autonomous).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders Trace Retention section', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Trace Retention')).toBeInTheDocument();
    });
    expect(screen.getByText('days')).toBeInTheDocument();
  });

  it('renders Headroom Compression section', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Headroom Compression')).toBeInTheDocument();
    });
    expect(screen.getByRole('switch', { name: 'Enable headroom compression' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Headroom Base URL')).toHaveValue('http://localhost:8787');
    expect(screen.getByRole('switch', { name: 'Auto-start managed Headroom proxy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Launch Command')).toHaveValue('headroom proxy --port 8787');
  });

  it('sends PUT when model is changed', async () => {
    const user = userEvent.setup();
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Default Model')).toBeInTheDocument();
    });

    // Reset mock to track the PUT
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...defaultConfig, defaultModel: 'opus' }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    const select = screen.getByLabelText('Default Model');
    await user.selectOptions(select, 'opus');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ defaultModel: 'opus' }),
        }),
      );
    });
  });

  it('shows Saved indicator after successful config update', async () => {
    const user = userEvent.setup();
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Default Model')).toBeInTheDocument();
    });

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...defaultConfig, defaultModel: 'haiku' }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    await user.selectOptions(screen.getByLabelText('Default Model'), 'haiku');

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });
  });

  it('sends PUT when headroom compression is toggled', async () => {
    const user = userEvent.setup();
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable headroom compression' })).toBeInTheDocument();
    });

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...defaultConfig, headroom: { ...defaultConfig.headroom, enabled: false } }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    await user.click(screen.getByRole('switch', { name: 'Enable headroom compression' }));

    await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            headroom: {
              enabled: false,
              baseUrl: 'http://localhost:8787',
              launchOnStartup: true,
              command: 'headroom proxy --port 8787',
            },
          }),
        }),
      );
    });
  });

  it('sends PUT when the headroom base URL is changed and blurred', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    const updatedUrl = 'http://localhost:9999';
    await waitFor(() => {
      expect(screen.getByLabelText('Headroom Base URL')).toHaveValue('http://localhost:8787');
    });

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ...defaultConfig,
              headroom: { ...defaultConfig.headroom, baseUrl: updatedUrl },
            }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    const input = screen.getByLabelText('Headroom Base URL');
    fireEvent.change(input, { target: { value: updatedUrl } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, opts]) =>
            url === '/api/config' &&
            opts?.method === 'PUT' &&
            opts?.body === JSON.stringify({
              headroom: {
                enabled: true,
                baseUrl: updatedUrl,
                launchOnStartup: true,
                command: 'headroom proxy --port 8787',
              },
            }),
        ),
      ).toBe(true);
    });
  });

  it('sends PUT when auto-start is toggled', async () => {
    const user = userEvent.setup();
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Auto-start managed Headroom proxy' })).toBeInTheDocument();
    });

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ...defaultConfig,
              headroom: { ...defaultConfig.headroom, launchOnStartup: false },
            }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    await user.click(screen.getByRole('switch', { name: 'Auto-start managed Headroom proxy' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            headroom: {
              enabled: true,
              baseUrl: 'http://localhost:8787',
              launchOnStartup: false,
              command: 'headroom proxy --port 8787',
            },
          }),
        }),
      );
    });
  });

  it('sends PUT when the headroom command is changed and blurred', async () => {
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    const updatedCommand = 'headroom proxy --port 9999';
    await waitFor(() => {
      expect(screen.getByLabelText('Launch Command')).toHaveValue('headroom proxy --port 8787');
    });

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/config' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ...defaultConfig,
              headroom: { ...defaultConfig.headroom, command: updatedCommand },
            }),
        });
      }
      if (url === '/api/extensions') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultConfig) });
    });

    const input = screen.getByLabelText('Launch Command');
    fireEvent.change(input, { target: { value: updatedCommand } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, opts]) =>
            url === '/api/config' &&
            opts?.method === 'PUT' &&
            opts?.body === JSON.stringify({
              headroom: {
                enabled: true,
                baseUrl: 'http://localhost:8787',
                launchOnStartup: true,
                command: updatedCommand,
              },
            }),
        ),
      ).toBe(true);
    });
  });

  it('shows error when config fetch fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    });

    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch config/)).toBeInTheDocument();
    });
  });

  it('uses config from store when already loaded', async () => {
    useConfigStore.setState({ config: defaultConfig });
    mockConfigFetch();
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    // Should render immediately without loading state since config exists
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument();
  });

  // Regression: the Agents section (provider enable toggles) disappeared whenever
  // config was already cached in the store, because the catalog lived in local
  // state filled only by a fetch that the cached-config path skipped. The catalog
  // now comes from the store + the effect fetches when it is empty.
  it('renders the Agents section with every provider even when config is preloaded', async () => {
    useConfigStore.setState({ config: defaultConfig, catalog: [] });
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/config') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...defaultConfig, catalog: catalogThreeProviders }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: {} }) });
    });
    const { default: SettingsPage } = await import('../../../src/pages/SettingsPage');

    render(<SettingsPage />);

    // The Agents section and a toggle for each provider must appear.
    await waitFor(() => {
      expect(screen.getByText('Agents')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Claude Code')).toBeInTheDocument();
    expect(screen.getByLabelText('OpenAI Codex')).toBeInTheDocument();
    expect(screen.getByLabelText('Antigravity')).toBeInTheDocument();
    // Codex starts disabled and is toggleable (not the always-on Claude).
    expect(screen.getByLabelText('OpenAI Codex')).not.toBeChecked();
    expect(screen.getByLabelText('OpenAI Codex')).toBeEnabled();
  });
});
