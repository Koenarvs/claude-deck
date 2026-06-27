import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HeadroomConfig } from '../../../src/shared/types';

// Mock isVertex so we can test both Vertex and non-Vertex command building.
const isVertexMock = vi.fn(() => true);
vi.mock('../../../server/headroom-env', () => ({
  isVertex: (...args: unknown[]) => isVertexMock(...args),
}));

const { buildHeadroomCommand } = await import('../../../server/services/headroom-service');

const base: HeadroomConfig = {
  enabled: true,
  baseUrl: 'http://localhost:8787',
  launchOnStartup: true,
  compressionDegree: 'balanced',
  interceptToolResults: false,
  memory: false,
  vertexApiUrl: 'https://aiplatform.googleapis.com',
};

beforeEach(() => {
  isVertexMock.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildHeadroomCommand', () => {
  it('builds the balanced command with port + vertex upstream on Vertex', () => {
    expect(buildHeadroomCommand(base)).toBe(
      'headroom proxy --port 8787 --vertex-api-url https://aiplatform.googleapis.com --target-ratio 0.4',
    );
  });

  it('omits --vertex-api-url on non-Vertex stacks', () => {
    isVertexMock.mockReturnValue(false);
    expect(buildHeadroomCommand(base)).toBe(
      'headroom proxy --port 8787 --target-ratio 0.4',
    );
  });

  it('maps each compression degree to the right flag', () => {
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'off' })).toContain('--no-optimize');
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'light' })).toContain('--target-ratio 0.6');
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'aggressive' })).toContain('--target-ratio 0.3');
  });

  it('appends feature flags only when enabled', () => {
    const cmd = buildHeadroomCommand({ ...base, interceptToolResults: true, memory: true });
    expect(cmd).toContain('--intercept-tool-results');
    expect(cmd).toContain('--memory');
    const none = buildHeadroomCommand(base);
    expect(none).not.toContain('--intercept-tool-results');
    expect(none).not.toContain('--memory');
  });

  it('derives the port from baseUrl', () => {
    expect(buildHeadroomCommand({ ...base, baseUrl: 'http://localhost:9001' })).toContain('--port 9001');
  });

  it('uses the advanced command override verbatim when set', () => {
    expect(buildHeadroomCommand({ ...base, command: 'headroom proxy --custom' })).toBe('headroom proxy --custom');
  });
});
