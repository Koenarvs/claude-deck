import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '../../../src/stores/useConfigStore';
import type { AppConfig } from '../../../src/shared/types';

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
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  useConfigStore.setState({ config: null });
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
});
