import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import HomeRedirect from '../../../src/components/HomeRedirect';
import { useConfigStore } from '../../../src/stores/useConfigStore';
import type { AppConfig } from '../../../src/shared/types';

function renderAt(home: string | null) {
  if (home) useConfigStore.setState({ config: { homeRoute: home } as AppConfig });
  else useConfigStore.setState({ config: null });
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/board" element={<div>BOARD</div>} />
        <Route path="/dashboard" element={<div>DASH</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomeRedirect', () => {
  beforeEach(() => useConfigStore.setState({ config: null }));
  it('falls back to /board when config is null', () => {
    renderAt(null);
    expect(screen.getByText('BOARD')).toBeInTheDocument();
  });
  it('redirects to /dashboard when configured', () => {
    renderAt('/dashboard');
    expect(screen.getByText('DASH')).toBeInTheDocument();
  });
});
