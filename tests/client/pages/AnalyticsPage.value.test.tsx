import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); });

function mockWith(value: unknown, util: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/value')) return Promise.resolve({ ok: true, json: () => Promise.resolve(value) });
    if (url.includes('/window-utilization')) return Promise.resolve({ ok: true, json: () => Promise.resolve(util) });
    if (url.includes('/model-breakdown')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', models: [] }) });
    if (url.includes('/model-mix')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/cost-per-goal')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/totals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: 1, cost: 1, tokensIn: 1, tokensOut: 1 }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe('AnalyticsPage — Subscription Value (seat)', () => {
  it('shows a value multiplier card with the replacement-value caveat', async () => {
    mockWith(
      { providers: [{ provider: 'claude', label: 'equivalent_value', equivalentUsd: 6000, seatPriceUsdMonthly: 200, valueMultiplier: 30 }] },
      { rows: [{ provider: 'claude', weightedUnits: 500000, estimatedWindowCap: 2000000, utilizationPct: 25, isEstimate: true }] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Subscription Value')).toBeInTheDocument());
    expect(screen.getByText(/30x/)).toBeInTheDocument();
    expect(screen.getAllByText(/replacement value/i).length).toBeGreaterThan(0);
  });

  it('shows window utilization gauges labeled as estimate', async () => {
    mockWith(
      { providers: [{ provider: 'claude', label: 'equivalent_value', equivalentUsd: 6000, seatPriceUsdMonthly: 200, valueMultiplier: 30 }] },
      { rows: [{ provider: 'claude', weightedUnits: 500000, estimatedWindowCap: 2000000, utilizationPct: 25, isEstimate: true }] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Window Utilization')).toBeInTheDocument());
    expect(screen.getByText(/estimate/i)).toBeInTheDocument();
    expect(screen.getByText(/25%/)).toBeInTheDocument();
  });
});

describe('AnalyticsPage — Budget vs Spend (metered)', () => {
  it('renders budget vs spend for a metered provider (no multiplier)', async () => {
    mockWith(
      { providers: [{ provider: 'antigravity', label: 'cost', equivalentUsd: 250, budgetUsd: 500 }] },
      { rows: [] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Budget vs Spend')).toBeInTheDocument());
    expect(screen.getByText(/antigravity/)).toBeInTheDocument();
    expect(screen.queryByText(/^\d+x$/)).not.toBeInTheDocument(); // no multiplier card
  });
});
