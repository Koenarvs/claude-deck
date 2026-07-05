import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test data ────────────────────────────────────────────────────────────────

const sampleSkills = [
  { name: 'goodmorning', description: 'Daily planning workflow', path: '/skills/goodmorning', source: 'local', scope: 'user', type: 'skills' },
  { name: 'goodnight', description: 'Session close-out', path: '/skills/goodnight', source: 'local', scope: 'user', type: 'skills' },
  { name: 'validate-model', description: 'Validate measures against BQ', path: '/skills/validate', source: 'plugin', scope: 'custom', type: 'skills' },
];

const sampleAgents = [
  { name: 'code-reviewer', description: 'Reviews code for quality', path: '/agents/code-reviewer/SKILL.md', scope: 'user', type: 'agents' },
  { name: 'test-writer', description: 'Writes unit tests', path: '/agents/test-writer/SKILL.md', scope: 'project', type: 'agents' },
];

const sampleRoutines = [
  { id: '1', name: 'Daily Backup', cron_expr: '0 3 * * *', enabled: true, last_run_at: 1700000000000, next_run_at: 1700100000000, created_at: 1699000000000 },
  { id: '2', name: 'Weekly Report', cron_expr: '0 9 * * 1', enabled: false, last_run_at: null, next_run_at: null, created_at: 1699000000000 },
];

const sampleExtensions = {
  mcp: [{ name: 'bigquery', type: 'mcp' }],
  plugins: [{ name: 'atlassian', type: 'plugin' }],
  hooks: { PreToolUse: {}, PostToolUse: {} },
};

const sampleDirs = [
  { id: 1, path: '/home/user/skills', label: null, enabled: true, created_at: '2025-01-01' },
];

function setupDefaultMocks() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/skill-directories')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleDirs),
      });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleAgents),
      });
    }
    if (url.includes('/api/scheduled-tasks')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleRoutines),
      });
    }
    if (url.includes('/api/skills')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleSkills),
      });
    }
    if (url.includes('/api/extensions')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleExtensions),
      });
    }
    if (url.includes('/api/skill-content')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: '# Test Skill\n\nThis is a test skill.', path: '/skills/test' }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function setupEmptyMocks() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/skill-directories')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes('/api/scheduled-tasks')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes('/api/skills')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes('/api/extensions')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ mcp: [], plugins: [], hooks: {} }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SkillsPage', () => {
  it('renders page title and description', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });
    expect(screen.getByText(/Installed Claude Code skills/)).toBeInTheDocument();
  });

  it('renders all four tabs', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const tabs = screen.getAllByRole('button');
    const tabLabels = tabs.map((t) => t.textContent);
    expect(tabLabels).toContain('Skills');
    expect(tabLabels).toContain('Agents');
    expect(tabLabels).toContain('Routines');
    expect(tabLabels).toContain('Extensions');
  });

  it('renders refresh button', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Refresh')).toBeInTheDocument();
    });
  });

  it('renders skills in a grid when loaded', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    expect(screen.getByText('goodnight')).toBeInTheDocument();
    expect(screen.getByText('validate-model')).toBeInTheDocument();
    expect(screen.getByText('Daily planning workflow')).toBeInTheDocument();
    expect(screen.getByText('Session close-out')).toBeInTheDocument();
  });

  it('shows skill source badges', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Source labels
    const localBadges = screen.getAllByText('local');
    expect(localBadges.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('plugin')).toBeInTheDocument();
  });

  it('shows empty state when no skills found', async () => {
    setupEmptyMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('No skills found.')).toBeInTheDocument();
    });
  });

  it('renders Scan Directories section with input on Skills tab', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Scan Directories')).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText(/e\.g\./)).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  it('renders existing skill directories as chips', async () => {
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('/home/user/skills')).toBeInTheDocument();
    });
  });

  it('switches to Extensions tab and shows MCP servers, plugins, hooks', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    // Click Extensions tab
    const extTab = screen.getAllByRole('button').find((b) => b.textContent === 'Extensions');
    expect(extTab).toBeDefined();
    await user.click(extTab!);

    await waitFor(() => {
      expect(screen.getByText('MCP Servers (1)')).toBeInTheDocument();
    });

    expect(screen.getByText('Plugins (1)')).toBeInTheDocument();
    expect(screen.getByText('Hook Types (2)')).toBeInTheDocument();
    expect(screen.getByText('PreToolUse')).toBeInTheDocument();
    expect(screen.getByText('PostToolUse')).toBeInTheDocument();
  });

  it('shows empty extension state', async () => {
    const user = userEvent.setup();
    setupEmptyMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const extTab = screen.getAllByRole('button').find((b) => b.textContent === 'Extensions');
    await user.click(extTab!);

    await waitFor(() => {
      expect(screen.getByText('No MCP servers configured.')).toBeInTheDocument();
    });
    expect(screen.getByText('No plugins installed.')).toBeInTheDocument();
    expect(screen.getByText('No hooks registered.')).toBeInTheDocument();
  });

  it('calls add directory API when Add button clicked', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Scan Directories')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/e\.g\./);
    await user.type(input, '/new/skills/dir');
    await user.click(screen.getByText('Add'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/skill-directories',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/new/skills/dir' }),
        }),
      );
    });
  });

  it('shows error when API returns an error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/skill-directories')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.reject(new Error('Network error'));
    });

    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', async () => {
    // Make fetch never resolve
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('switches to Agents tab and shows agent cards', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const agentsTab = screen.getAllByRole('button').find((b) => b.textContent === 'Agents');
    expect(agentsTab).toBeDefined();
    await user.click(agentsTab!);

    await waitFor(() => {
      expect(screen.getByText('code-reviewer')).toBeInTheDocument();
    });
    expect(screen.getByText('test-writer')).toBeInTheDocument();
    expect(screen.getByText('Reviews code for quality')).toBeInTheDocument();
  });

  it('shows empty agents state', async () => {
    const user = userEvent.setup();
    setupEmptyMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const agentsTab = screen.getAllByRole('button').find((b) => b.textContent === 'Agents');
    await user.click(agentsTab!);

    await waitFor(() => {
      expect(screen.getByText('No agents found.')).toBeInTheDocument();
    });
  });

  it('switches to Routines tab and shows routine cards', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const routinesTab = screen.getAllByRole('button').find((b) => b.textContent === 'Routines');
    expect(routinesTab).toBeDefined();
    await user.click(routinesTab!);

    await waitFor(() => {
      expect(screen.getByText('Daily Backup')).toBeInTheDocument();
    });
    expect(screen.getByText('Weekly Report')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('shows empty routines state', async () => {
    const user = userEvent.setup();
    setupEmptyMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('Skills & Extensions')).toBeInTheDocument();
    });

    const routinesTab = screen.getAllByRole('button').find((b) => b.textContent === 'Routines');
    await user.click(routinesTab!);

    await waitFor(() => {
      expect(screen.getByText('No routines configured.')).toBeInTheDocument();
    });
  });

  it('opens skill viewer modal when skill card is clicked', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Click on the skill card
    await user.click(screen.getByText('goodmorning'));

    // Verify the modal appears with the skill name and content
    await waitFor(() => {
      expect(screen.getByTestId('skill-viewer-modal')).toBeInTheDocument();
    });

    // Should have fetched skill content
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/skill-content'),
      expect.anything(),
    );

    // Close button should be present
    expect(screen.getByLabelText('Close viewer')).toBeInTheDocument();
  });

  it('closes skill viewer modal when close button is clicked', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { default: SkillsPage } = await import('../../../src/pages/SkillsPage');

    render(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Open the modal
    await user.click(screen.getByText('goodmorning'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-viewer-modal')).toBeInTheDocument();
    });

    // Close the modal
    await user.click(screen.getByLabelText('Close viewer'));

    await waitFor(() => {
      expect(screen.queryByTestId('skill-viewer-modal')).not.toBeInTheDocument();
    });
  });
});
