import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useApplyUIConfig } from '../../../src/hooks/useApplyUIConfig';
import { useUIConfigStore } from '../../../src/stores/useUIConfigStore';

// ── Test component ──────────────────────────────────────────────────────────

function TestHarness() {
  useApplyUIConfig();
  return <div data-testid="harness" />;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useApplyUIConfig', () => {
  beforeEach(() => {
    // Reset store to defaults
    useUIConfigStore.setState({
      aesthetic: 'mission',
      theme: 'dark',
      boardLayout: 'columns',
      liveActivity: 'on',
      tweaksOpen: false,
    });

    // Clean data attributes from previous tests
    const root = document.documentElement;
    root.removeAttribute('data-aesthetic');
    root.removeAttribute('data-theme');
    root.removeAttribute('data-live');
  });

  it('applies aesthetic to html data-aesthetic attribute', () => {
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-aesthetic')).toBe('mission');
  });

  it('applies theme to html data-theme attribute', () => {
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies liveActivity to html data-live attribute', () => {
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-live')).toBe('on');
  });

  it('applies studio aesthetic', () => {
    useUIConfigStore.setState({ aesthetic: 'studio' });
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-aesthetic')).toBe('studio');
  });

  it('applies console aesthetic', () => {
    useUIConfigStore.setState({ aesthetic: 'console' });
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-aesthetic')).toBe('console');
  });

  it('applies light theme', () => {
    useUIConfigStore.setState({ theme: 'light' });
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies subtle liveActivity', () => {
    useUIConfigStore.setState({ liveActivity: 'subtle' });
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-live')).toBe('subtle');
  });

  it('applies off liveActivity', () => {
    useUIConfigStore.setState({ liveActivity: 'off' });
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-live')).toBe('off');
  });

  it('updates attributes when store changes after render', () => {
    render(<TestHarness />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // Simulate store change after initial render — wrap in act() to flush React updates
    act(() => {
      useUIConfigStore.setState({ theme: 'light' });
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies all three attributes simultaneously', () => {
    useUIConfigStore.setState({
      aesthetic: 'console',
      theme: 'light',
      liveActivity: 'subtle',
    });
    render(<TestHarness />);

    const root = document.documentElement;
    expect(root.getAttribute('data-aesthetic')).toBe('console');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-live')).toBe('subtle');
  });
});
