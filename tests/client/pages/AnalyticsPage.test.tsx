import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test data (matches existing endpoint response shapes) ────────────────────

const sampleToolUsage = [
  { name: 'Read', count: 150 },
  { name: 'Edit', count: 80 },
  { name: 'Bash', count: 60 },
  { name: 'Grep', count: 45 },
  { name: 'mcp__atlassian__search', count: 20 },
];

const sampleDailyCosts = [
  { date: '2026-05-17', cost: 1.25, sessions: 3 },
  { date: '2026-05-18', cost: 2.50, sessions: 5 },
  { date: '2026-05-19', cost: 0.75, sessions: 2 },
];

const sampleTotals = { sessions: 42, cost: 15.75, tokensIn: 500000, tokensOut: 150000 };

const sampleHeatmap = [
  { date: '2026-05-17', count: 3 },
  { date: '2026-05-18', count: 5 },
  { date: '2026-05-19', count: 2 },
];

const sampleSessionsPerDay = [
  { date: '2026-05-17', sessions: 3, dashboard: 2, external: 1 },
  { date: '2026-05-18', sessions: 5, dashboard: 3, external: 2 },
];

const sampleDurations = [
  { bucket: '< 5m', count: 10 },
  { bucket: '5-15m', count: 8 },
  { bucket: '15-30m', count: 5 },
];

// ── Mock setup ───────────────────────────────────────────────────────────────

function setupAnalyticsMocks() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/analytics/tool-usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleToolUsage) });
    }
    if (url.includes('/api/analytics/daily-costs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDailyCosts) });
    }
    if (url.includes('/api/analytics/totals')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleTotals) });
    }
    if (url.includes('/api/analytics/activity-heatmap')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleHeatmap) });
    }
    if (url.includes('/api/analytics/sessions-per-day')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleSessionsPerDay) });
    }
    if (url.includes('/api/analytics/session-durations')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDurations) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ── Phase 1 Evals: Tab Infrastructure ────────────────────────────────────────

describe('AnalyticsPage — Phase 1: Tab Infrastructure', () => {
  it('renders a tab bar with "Analytics" and "Context Management" tabs', async () => {
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Analytics')).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole('button');
    const tabLabels = buttons.map((b) => b.textContent?.trim());
    expect(tabLabels).toContain('Analytics');
    expect(tabLabels).toContain('Context Management');
  });

  it('defaults to the "Analytics" tab being active', async () => {
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    // The Analytics tab button should have the active styling (accent color class).
    // We verify the Analytics tab content is visible by checking for stat cards.
    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens In')).toBeInTheDocument();
    expect(screen.getByText('Tokens Out')).toBeInTheDocument();
  });

  it('clicking "Context Management" switches visible content', async () => {
    const user = userEvent.setup();
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Click the Context Management tab
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    expect(cmTab).toBeDefined();
    await user.click(cmTab!);

    // Analytics content should no longer be visible
    await waitFor(() => {
      expect(screen.queryByText('Total Sessions')).not.toBeInTheDocument();
    });

    // Context Management placeholder content should appear
    // (Phase 1 creates an empty placeholder — we just verify the analytics content is gone
    // and the tab switch occurred. The placeholder can show any text, e.g., "Context Management"
    // heading or a "Coming soon" message.)
  });

  it('clicking back to "Analytics" tab restores analytics content', async () => {
    const user = userEvent.setup();
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Switch to Context Management
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.queryByText('Total Sessions')).not.toBeInTheDocument();
    });

    // Switch back to Analytics
    const analyticsTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Analytics');
    await user.click(analyticsTab!);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    expect(screen.getByText('Total Cost')).toBeInTheDocument();
  });

  it('all 6 existing chart sections render in the Analytics tab (regression)', async () => {
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // 1. Summary stat cards (4 cards)
    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens In')).toBeInTheDocument();
    expect(screen.getByText('Tokens Out')).toBeInTheDocument();

    // 2. Activity heatmap
    expect(screen.getByText(/Activity/)).toBeInTheDocument();

    // 3. Daily Cost chart
    expect(screen.getByText('Daily Cost')).toBeInTheDocument();

    // 4. Sessions Per Day chart
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();

    // 5. Tool Usage by Category chart
    expect(screen.getByText('Tool Usage by Category')).toBeInTheDocument();

    // 6. Session Duration Distribution chart
    expect(screen.getByText('Session Duration Distribution')).toBeInTheDocument();
  });

  it('time range selector remains functional after tab refactor', async () => {
    const user = userEvent.setup();
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // All time range options should be present
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();

    // Click a different time range
    await user.click(screen.getByText('7 days'));

    // Verify fetch was called with the new time range
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const recentCalls = calls.filter((url: string) => url.includes('days=7'));
      expect(recentCalls.length).toBeGreaterThan(0);
    });
  });

  it('fetches all 6 existing analytics endpoints on load', async () => {
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/tool-usage'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/daily-costs'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/totals'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/activity-heatmap'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/sessions-per-day'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/session-durations'))).toBe(true);
  });

  it('renders correct stat values from totals endpoint', async () => {
    setupAnalyticsMocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  it('shows loading spinner before data loads', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    // Should show spinner/loading indicator while fetching
    const container = document.querySelector('.animate-spin');
    expect(container).toBeTruthy();
  });
});

// ── Phase 2 Evals: Error Handling & Output Trends ────────────────────────────

const sampleJiraStories = [
  { date: '2026-05-12', count: 3 },
  { date: '2026-05-19', count: 5 },
];

const samplePrsMerged = [
  { date: '2026-05-12', count: 2 },
  { date: '2026-05-19', count: 4 },
];

function setupPhase2Mocks() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/analytics/tool-usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleToolUsage) });
    }
    if (url.includes('/api/analytics/daily-costs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDailyCosts) });
    }
    if (url.includes('/api/analytics/totals')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleTotals) });
    }
    if (url.includes('/api/analytics/activity-heatmap')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleHeatmap) });
    }
    if (url.includes('/api/analytics/sessions-per-day')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleSessionsPerDay) });
    }
    if (url.includes('/api/analytics/session-durations')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDurations) });
    }
    if (url.includes('/api/analytics/jira-stories')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleJiraStories) });
    }
    if (url.includes('/api/analytics/prs-merged')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(samplePrsMerged) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function setupPhase2MocksWithFailure(failEndpoint: string) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes(failEndpoint)) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Server error' }) });
    }
    // All other endpoints work normally
    if (url.includes('/api/analytics/tool-usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleToolUsage) });
    }
    if (url.includes('/api/analytics/daily-costs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDailyCosts) });
    }
    if (url.includes('/api/analytics/totals')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleTotals) });
    }
    if (url.includes('/api/analytics/activity-heatmap')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleHeatmap) });
    }
    if (url.includes('/api/analytics/sessions-per-day')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleSessionsPerDay) });
    }
    if (url.includes('/api/analytics/session-durations')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDurations) });
    }
    if (url.includes('/api/analytics/jira-stories')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleJiraStories) });
    }
    if (url.includes('/api/analytics/prs-merged')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(samplePrsMerged) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('AnalyticsPage — Phase 2: Error Handling', () => {
  it('when daily-costs endpoint fails, other sections still render', async () => {
    setupPhase2MocksWithFailure('/api/analytics/daily-costs');
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Stat cards should still work (totals endpoint succeeded)
    expect(screen.getByText('42')).toBeInTheDocument();

    // Other chart sections should still render
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();
    expect(screen.getByText('Tool Usage by Category')).toBeInTheDocument();
    expect(screen.getByText('Session Duration Distribution')).toBeInTheDocument();
  });

  it('when tool-usage endpoint fails, other sections still render', async () => {
    setupPhase2MocksWithFailure('/api/analytics/tool-usage');
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Daily Cost and other sections should still render
    expect(screen.getByText('Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();
  });

  it('failed section shows an error message (not silent)', async () => {
    setupPhase2MocksWithFailure('/api/analytics/daily-costs');
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // The Daily Cost section should show some kind of error indicator
    // (not just silently disappear)
    const errorElements = document.querySelectorAll('[data-testid="chart-error"], .text-danger, .text-red-500, [role="alert"]');
    const errorTexts = screen.queryAllByText(/error|failed|unavailable/i);
    expect(errorElements.length + errorTexts.length).toBeGreaterThan(0);
  });
});

describe('AnalyticsPage — Phase 2: Output Trends Chart', () => {
  it('Output Trends section renders in the Analytics tab', async () => {
    setupPhase2Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    expect(screen.getByText('Output Trends')).toBeInTheDocument();
  });

  it('fetches jira-stories and prs-merged endpoints on load', async () => {
    setupPhase2Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/jira-stories'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/prs-merged'))).toBe(true);
  });

  it('shows empty state when Jira/GitHub data unavailable (no crash)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/analytics/jira-stories')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/api/analytics/prs-merged')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      // Other endpoints work normally
      if (url.includes('/api/analytics/tool-usage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleToolUsage) });
      }
      if (url.includes('/api/analytics/daily-costs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDailyCosts) });
      }
      if (url.includes('/api/analytics/totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleTotals) });
      }
      if (url.includes('/api/analytics/activity-heatmap')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleHeatmap) });
      }
      if (url.includes('/api/analytics/sessions-per-day')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleSessionsPerDay) });
      }
      if (url.includes('/api/analytics/session-durations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDurations) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Output Trends should still render (section header present) but with empty state
    expect(screen.getByText('Output Trends')).toBeInTheDocument();
  });

  it('all 6 original chart sections still render alongside Output Trends (regression)', async () => {
    setupPhase2Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    expect(screen.getByText('Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();
    expect(screen.getByText('Tool Usage by Category')).toBeInTheDocument();
    expect(screen.getByText('Session Duration Distribution')).toBeInTheDocument();
    expect(screen.getByText(/Activity/)).toBeInTheDocument();
    expect(screen.getByText('Output Trends')).toBeInTheDocument();
  });
});

// ── Phase 3 Evals: Context Management Tab ────────────────────────────────────

const sampleContextInventory = [
  { name: 'goodmorning', type: 'skill', usageCount: 12, lastUsed: 1779200000000, estimatedSize: 3500 },
  { name: 'goodnight', type: 'skill', usageCount: 8, lastUsed: 1779100000000, estimatedSize: 2800 },
  { name: 'atlassian', type: 'mcp', usageCount: 25, lastUsed: 1779220000000, estimatedSize: 0 },
  { name: 'hookify', type: 'plugin', usageCount: 3, lastUsed: 1779050000000, estimatedSize: 1200 },
  { name: 'PreToolUse', type: 'hook', usageCount: 0, lastUsed: null, estimatedSize: 500 },
  { name: 'validate-model', type: 'skill', usageCount: 0, lastUsed: null, estimatedSize: 4100 },
];

function setupPhase3Mocks() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/analytics/context-inventory')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleContextInventory) });
    }
    // All analytics endpoints still work
    if (url.includes('/api/analytics/tool-usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleToolUsage) });
    }
    if (url.includes('/api/analytics/daily-costs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDailyCosts) });
    }
    if (url.includes('/api/analytics/totals')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleTotals) });
    }
    if (url.includes('/api/analytics/activity-heatmap')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleHeatmap) });
    }
    if (url.includes('/api/analytics/sessions-per-day')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleSessionsPerDay) });
    }
    if (url.includes('/api/analytics/session-durations')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleDurations) });
    }
    if (url.includes('/api/analytics/jira-stories')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/analytics/prs-merged')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('AnalyticsPage — Phase 3: Context Management Tab', () => {
  it('Context Management tab renders a table with inventory items', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Switch to Context Management tab
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    // Table should render with item names from the inventory
    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });
    expect(screen.getByText('atlassian')).toBeInTheDocument();
    expect(screen.getByText('hookify')).toBeInTheDocument();
    expect(screen.getByText('PreToolUse')).toBeInTheDocument();
  });

  it('table has expected column headers', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Check for column headers (exact text may vary but must contain these concepts)
    expect(screen.getByText(/Name/i)).toBeInTheDocument();
    expect(screen.getByText(/Type/i)).toBeInTheDocument();
    expect(screen.getByText(/Usage/i)).toBeInTheDocument();
  });

  it('zero-usage items are visually distinct', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('PreToolUse')).toBeInTheDocument();
    });

    // Zero-usage items should have a distinguishing visual marker
    // Look for: data-zero-usage attribute, opacity class, warning color, or "unused" text
    const zeroUsageMarkers = document.querySelectorAll(
      '[data-zero-usage], .opacity-50, .text-warn, .text-yellow-500, .text-amber-500, .bg-warn\\/10, .bg-yellow-50'
    );
    const unusedTexts = screen.queryAllByText(/unused|no usage|never used/i);
    expect(zeroUsageMarkers.length + unusedTexts.length).toBeGreaterThan(0);
  });

  it('type filter pills filter the table correctly', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Should have filter pills — find and click the MCP filter
    const mcpFilter = screen.getAllByRole('button').find((b) => {
      const text = b.textContent?.trim().toLowerCase() ?? '';
      return text === 'mcp';
    });
    expect(mcpFilter).toBeDefined();
    await user.click(mcpFilter!);

    // After filtering to MCP, only MCP items should be visible
    await waitFor(() => {
      expect(screen.getByText('atlassian')).toBeInTheDocument();
    });

    // Non-MCP items should be hidden
    expect(screen.queryByText('goodmorning')).not.toBeInTheDocument();
    expect(screen.queryByText('hookify')).not.toBeInTheDocument();
    expect(screen.queryByText('PreToolUse')).not.toBeInTheDocument();
  });

  it('"All" filter shows all items', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Click MCP filter first
    const mcpFilter = screen.getAllByRole('button').find((b) => b.textContent?.trim().toLowerCase() === 'mcp');
    await user.click(mcpFilter!);

    await waitFor(() => {
      expect(screen.queryByText('goodmorning')).not.toBeInTheDocument();
    });

    // Click All filter to restore
    const allFilter = screen.getAllByRole('button').find((b) => b.textContent?.trim().toLowerCase() === 'all');
    expect(allFilter).toBeDefined();
    await user.click(allFilter!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });
    expect(screen.getByText('atlassian')).toBeInTheDocument();
    expect(screen.getByText('hookify')).toBeInTheDocument();
  });

  it('shows summary with total items count', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Summary should show total item count (6 items in test data)
    expect(screen.getByText(/6 items/)).toBeInTheDocument();
  });

  it('fetches context-inventory endpoint when Context Management tab is selected', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calledUrls.some((u: string) => u.includes('/api/analytics/context-inventory'))).toBe(true);
    });
  });

  it('Analytics tab still works after switching back from Context Management (regression)', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Go to CM tab
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Go back to Analytics
    const analyticsTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Analytics');
    await user.click(analyticsTab!);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });
    expect(screen.getByText('Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('Output Trends')).toBeInTheDocument();
  });
});

// ── Phase 4 Evals: URL State & Lazy Loading ──────────────────────────────────

describe('AnalyticsPage — Phase 4: URL State & Lazy Loading', () => {
  it('reads tab from URL query param on initial load (?tab=context)', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics?tab=context']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    // Should start on Context Management tab, not Analytics
    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Analytics content should NOT be visible
    expect(screen.queryByText('Total Sessions')).not.toBeInTheDocument();
  });

  it('defaults to analytics tab when no URL param', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Context Management content should NOT be visible
    expect(screen.queryByText('goodmorning')).not.toBeInTheDocument();
  });

  it('does NOT fetch context-inventory on initial load when analytics tab is active', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // context-inventory should NOT have been fetched since we're on the analytics tab
    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/context-inventory'))).toBe(false);
  });

  it('fetches context-inventory only after switching to context tab (lazy loading)', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Before switching: no context-inventory fetch
    let calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledUrls.some((u: string) => u.includes('/api/analytics/context-inventory'))).toBe(false);

    // Switch to context tab
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    // Now it should fetch
    await waitFor(() => {
      calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calledUrls.some((u: string) => u.includes('/api/analytics/context-inventory'))).toBe(true);
    });
  });

  it('full regression: all Phase 1-3 charts and features still work with router', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Phase 1: tab bar exists
    const buttons = screen.getAllByRole('button');
    const tabLabels = buttons.map((b) => b.textContent?.trim());
    expect(tabLabels).toContain('Analytics');
    expect(tabLabels).toContain('Context Management');

    // Phase 1: all 6 chart sections render
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();
    expect(screen.getByText('Tool Usage by Category')).toBeInTheDocument();
    expect(screen.getByText('Session Duration Distribution')).toBeInTheDocument();
    expect(screen.getByText(/Activity/)).toBeInTheDocument();

    // Phase 2: Output Trends
    expect(screen.getByText('Output Trends')).toBeInTheDocument();

    // Phase 1: time range selector
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();

    // Phase 3: switch to context tab and verify
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    expect(screen.getByText('atlassian')).toBeInTheDocument();
    expect(screen.getByText(/Name/i)).toBeInTheDocument();

    // Switch back — analytics restored
    const analyticsTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Analytics');
    await user.click(analyticsTab!);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });
  });
});

// ── Scroll Behavior Evals ────────────────────────────────────────────────────

describe('AnalyticsPage — Scroll Behavior', () => {
  it('analytics tab content is inside a scrollable container', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // Find the scrollable container wrapping the analytics content.
    // It should have overflow-y-auto (or overflow-auto) to enable vertical scrolling.
    const scrollContainer = document.querySelector('[data-testid="tab-content"], .overflow-y-auto, .overflow-auto');
    expect(scrollContainer).toBeTruthy();

    // The stat cards should be inside this scrollable area
    const statCard = screen.getByText('Total Sessions').closest('div');
    expect(statCard).toBeTruthy();
  });

  it('context management tab content is inside a scrollable container', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Context tab content should also be in a scrollable container
    const scrollContainer = document.querySelector('[data-testid="tab-content"], .overflow-y-auto, .overflow-auto');
    expect(scrollContainer).toBeTruthy();
  });

  it('tab bar and time range selector are outside the scroll container', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // The tab buttons ("Analytics", "Context Management") should NOT be
    // inside the scrollable container. They should be in a sticky/fixed header area.
    // We verify by checking the outermost page container uses flex-col layout
    // and the scroll area is a separate child from the header.
    const analyticsButton = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Analytics');
    const scrollContainer = document.querySelector('[data-testid="tab-content"], .overflow-y-auto, .overflow-auto');

    expect(analyticsButton).toBeTruthy();
    expect(scrollContainer).toBeTruthy();

    // Tab button should NOT be a descendant of the scroll container
    if (scrollContainer) {
      expect(scrollContainer.contains(analyticsButton!)).toBe(false);
    }
  });

  it('page uses flex column layout to separate header from scrollable content', async () => {
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // The root container should use flex + flex-col to stack header and content
    const flexColContainer = document.querySelector('.flex.flex-col');
    expect(flexColContainer).toBeTruthy();
  });

  it('all existing content still renders correctly with scroll layout (regression)', async () => {
    const user = userEvent.setup();
    setupPhase3Mocks();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });

    // All analytics sections present
    expect(screen.getByText('Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('Sessions Per Day')).toBeInTheDocument();
    expect(screen.getByText('Tool Usage by Category')).toBeInTheDocument();
    expect(screen.getByText('Session Duration Distribution')).toBeInTheDocument();
    expect(screen.getByText('Output Trends')).toBeInTheDocument();

    // Tab switching still works
    const cmTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Context Management');
    await user.click(cmTab!);

    await waitFor(() => {
      expect(screen.getByText('goodmorning')).toBeInTheDocument();
    });

    // Switch back
    const analyticsTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Analytics');
    await user.click(analyticsTab!);

    await waitFor(() => {
      expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    });
  });
});
