import { describe, it, expect } from 'vitest';
import { isVertex, headroomEnvFragment } from '../../server/headroom-env';

describe('headroom-env', () => {
  describe('isVertex', () => {
    it('is true for truthy CLAUDE_CODE_USE_VERTEX values', () => {
      expect(isVertex({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe(true);
      expect(isVertex({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe(true);
    });
    it('is false when unset/empty/0/false', () => {
      expect(isVertex({})).toBe(false);
      expect(isVertex({ CLAUDE_CODE_USE_VERTEX: '' })).toBe(false);
      expect(isVertex({ CLAUDE_CODE_USE_VERTEX: '0' })).toBe(false);
      expect(isVertex({ CLAUDE_CODE_USE_VERTEX: 'false' })).toBe(false);
    });
  });

  describe('headroomEnvFragment', () => {
    it('on Vertex sets ANTHROPIC_VERTEX_BASE_URL with a /v1 suffix', () => {
      const env = { CLAUDE_CODE_USE_VERTEX: '1' };
      expect(headroomEnvFragment('http://localhost:8787', env)).toEqual({
        ANTHROPIC_VERTEX_BASE_URL: 'http://localhost:8787/v1',
      });
    });
    it('does not double-append /v1 and strips trailing slashes', () => {
      const env = { CLAUDE_CODE_USE_VERTEX: '1' };
      expect(headroomEnvFragment('http://localhost:8787/v1', env)).toEqual({
        ANTHROPIC_VERTEX_BASE_URL: 'http://localhost:8787/v1',
      });
      expect(headroomEnvFragment('http://localhost:8787/', env)).toEqual({
        ANTHROPIC_VERTEX_BASE_URL: 'http://localhost:8787/v1',
      });
    });
    it('off Vertex sets ANTHROPIC_BASE_URL verbatim', () => {
      expect(headroomEnvFragment('http://localhost:8787', {})).toEqual({
        ANTHROPIC_BASE_URL: 'http://localhost:8787',
      });
    });
  });
});
