import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); });

const modelBreakdown = {
  label: 'equivalent_value',
  models: [
    { model: 'claude-opus-4-8', tier: 'frontier', provider: 'claude', tokensIn: 1500, tokensOut: 500, equivalentUsd: 6000, effectiveRatePerMTok: 30, share: 0.9, unpriced: false },
    { model: 'gemini-3-pro', tier: 'frontier', provider: 'antigravity', tokensIn: 9000, tokensOut: 0, equivalentUsd: 0, effectiveRatePerMTok: 0, share: 0, unpriced: true },
  ],
};
const modelMix = { label: 'equivalent_value', series: [
  { date: '2026-06-01', models: { 'claude-opus-4-8': 1500, 'claude-sonnet-4-6': 6000 }, topTierShare: 0.2 },
] };

function mockAll() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/model-breakdown')) return Promise.resolve({ ok: true, json: () => Promise.resolve(modelBreakdown) });
    if (url.includes('/model-mix')) return Promise.resolve({ ok: true, json: () => Promise.resolve(modelMix) });
    if (url.includes('/value')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ providers: [] }) });
    if (url.includes('/window-utilization')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
    if (url.includes('/cost-per-goal')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/totals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: 1, cost: 1, tokensIn: 1, tokensOut: 1 }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe('AnalyticsPage — Model Breakdown + Mix', () => {
  it('renders the Model Breakdown table with rows', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Breakdown')).toBeInTheDocument());
    // Model names appear in both the Breakdown and Scorecard tables.
    expect(screen.getAllByText('claude-opus-4-8').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gemini-3-pro').length).toBeGreaterThan(0);
  });

  it('shows an unpriced badge on unpriced models (not hidden)', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('gemini-3-pro').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/unpriced/i).length).toBeGreaterThan(0);
  });

  it('renders the Model Mix chart with a top-tier-share callout', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Mix')).toBeInTheDocument());
    expect(screen.getByText(/top-tier/i)).toBeInTheDocument();
  });

  it('fetches the new endpoints on load', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Breakdown')).toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u) => u.includes('/model-breakdown'))).toBe(true);
    expect(urls.some((u) => u.includes('/model-mix'))).toBe(true);
  });
});

describe('AnalyticsPage — Model Scorecard', () => {
  it('renders a scorecard with quota weight and a pending verification column', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Scorecard')).toBeInTheDocument());
    expect(screen.getByText(/Quota Weight/i)).toBeInTheDocument();
    // "Verification" appears in both the column header and the note line.
    expect(screen.getAllByText(/Verification/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
