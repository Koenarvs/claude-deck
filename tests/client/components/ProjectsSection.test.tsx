import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectsSection from '../../../src/components/settings/ProjectsSection';
import type { Project } from '../../../src/shared/types';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Deck',
    root_path: 'C:/github/claude-deck',
    allowed_models: [],
    default_permission_mode: 'supervised',
    done_command: null,
    worktree_root: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectsSection', () => {
  it('lists registered projects from /api/projects', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [project()] });
    render(<ProjectsSection />);
    expect(await screen.findByText('Deck')).toBeInTheDocument();
    expect(screen.getByText('C:/github/claude-deck')).toBeInTheDocument();
  });

  it('shows an empty state when there are no projects', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    render(<ProjectsSection />);
    expect(await screen.findByText(/No projects registered/i)).toBeInTheDocument();
  });

  it('POSTs a new project and reloads', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => project() }) // POST
      .mockResolvedValueOnce({ ok: true, json: async () => [project()] }); // reload
    render(<ProjectsSection />);
    await screen.findByText(/No projects registered/i);

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Deck' } });
    fireEvent.change(screen.getByLabelText('Project root path'), {
      target: { value: 'C:/github/claude-deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('Deck')).toBeInTheDocument();
  });

  it('surfaces a 409 duplicate-root error', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // The api.ts helper reads error bodies via res.text()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: 'A project is already registered at C:/repo' }),
        json: async () => ({ error: 'A project is already registered at C:/repo' }),
      });
    render(<ProjectsSection />);
    await screen.findByText(/No projects registered/i);

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'B' } });
    fireEvent.change(screen.getByLabelText('Project root path'), { target: { value: 'C:/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already registered/i);
  });
});
