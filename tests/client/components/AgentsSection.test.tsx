import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentsSection from '../../../src/components/settings/AgentsSection';
import type { AgentCatalogEntry } from '../../../src/shared/agents/types';

const CAPS = { canObserveHooks: true, canResume: true, canMcp: true, canApprove: true, canStream: true };

const providers: AgentCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', enabled: true, models: [{ value: 'opus', label: 'Opus' }], capabilities: CAPS },
  {
    id: 'antigravity',
    label: 'Antigravity',
    enabled: false,
    models: [{ value: 'antigravity', label: 'Antigravity' }],
    capabilities: { ...CAPS, canObserveHooks: false },
    authHint: 'Run agy once to sign in',
  },
];

describe('AgentsSection', () => {
  it('renders providers; the claude toggle is checked and disabled (always on)', () => {
    render(<AgentsSection providers={providers} onToggle={() => {}} />);
    const claude = screen.getByLabelText('Claude Code') as HTMLInputElement;
    expect(claude.checked).toBe(true);
    expect(claude.disabled).toBe(true);
  });

  it('toggling a non-claude provider calls onToggle with the new enabled list (claude retained)', () => {
    const onToggle = vi.fn();
    render(<AgentsSection providers={providers} onToggle={onToggle} />);
    fireEvent.click(screen.getByLabelText('Antigravity'));
    expect(onToggle).toHaveBeenCalledWith(['claude', 'antigravity']);
  });

  it('renders nothing when the catalog is empty', () => {
    const { container } = render(<AgentsSection providers={[]} onToggle={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
