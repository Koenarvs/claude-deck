import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorkspaceDiff from '../../../src/components/goal/WorkspaceDiff';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.restoreAllMocks());

describe('WorkspaceDiff', () => {
  it('renders the branch, dirty state, and diff lines', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        branch: 'goal/abc123-feature',
        dirty: true,
        diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
      }),
    });
    render(<WorkspaceDiff goalId="g1" />);
    expect(await screen.findByText(/goal\/abc123-feature/)).toBeInTheDocument();
    expect(screen.getByText(/uncommitted changes/i)).toBeInTheDocument();
    expect(screen.getByText('+new')).toBeInTheDocument();
    expect(screen.getByText('-old')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/goals/g1/diff', expect.anything());
  });

  it('shows an empty-workspace message when the goal has no workspace', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ branch: null, dirty: false, diff: '' }),
    });
    render(<WorkspaceDiff goalId="g2" />);
    expect(await screen.findByText(/No isolated workspace/i)).toBeInTheDocument();
  });

  it('shows "No changes yet" for a clean provisioned workspace', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ branch: 'goal/x', dirty: false, diff: '' }),
    });
    render(<WorkspaceDiff goalId="g3" />);
    expect(await screen.findByText(/No changes yet/i)).toBeInTheDocument();
    expect(screen.getByText(/clean/i)).toBeInTheDocument();
  });
});
