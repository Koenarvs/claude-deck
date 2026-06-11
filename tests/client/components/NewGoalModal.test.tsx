import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import NewGoalModal from '../../../src/components/kanban/NewGoalModal';
import { useConfigStore } from '../../../src/stores/useConfigStore';
import type { AgentCatalogEntry } from '../../../src/shared/agents/types';

const CAPS = {
  canObserveHooks: false,
  canResume: true,
  canMcp: false,
  canApprove: false,
  canStream: true,
};

function claudeEntry(enabled = true): AgentCatalogEntry {
  return {
    id: 'claude',
    label: 'Claude Code',
    enabled,
    capabilities: { ...CAPS, canObserveHooks: true, canApprove: true, canMcp: true },
    models: [
      { value: 'default', label: 'Default' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ],
  };
}

function codexEntry(enabled: boolean): AgentCatalogEntry {
  return {
    id: 'codex',
    label: 'Codex',
    enabled,
    capabilities: CAPS,
    models: [
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    ],
  };
}

function renderModal() {
  render(
    <MemoryRouter>
      <NewGoalModal open onClose={() => {}} />
    </MemoryRouter>,
  );
  return screen.getByLabelText('Model') as HTMLSelectElement;
}

describe('NewGoalModal — catalog-driven model picker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    useConfigStore.setState({ config: null, catalog: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useConfigStore.setState({ config: null, catalog: [] });
  });

  it('falls back to Claude defaults when the catalog has not loaded', () => {
    const select = renderModal();
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['Default', 'Opus', 'Sonnet', 'Haiku']);
  });

  it('surfaces an enabled Codex provider’s models', () => {
    useConfigStore.setState({ catalog: [claudeEntry(true), codexEntry(true)] });
    const select = renderModal();
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('GPT-5.4');
    expect(labels).toContain('GPT-5.4 Mini');
    expect(labels[0]).toBe('Default');
  });

  it('hides a disabled provider’s models', () => {
    useConfigStore.setState({ catalog: [claudeEntry(true), codexEntry(false)] });
    const select = renderModal();
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).not.toContain('GPT-5.4');
    expect(labels).toContain('Opus');
  });
});
