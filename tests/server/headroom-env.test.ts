import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isVertex,
  headroomEnvFragment,
  vertexApiUrlForRegion,
  regionFromClaudeSettings,
  resolveVertexRegion,
  resolveVertexApiUrl,
} from '../../server/headroom-env';

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

  describe('vertexApiUrlForRegion', () => {
    it('maps global to the bare aiplatform host', () => {
      expect(vertexApiUrlForRegion('global')).toBe('https://aiplatform.googleapis.com');
    });
    it('maps us/eu to the multi-region rep host', () => {
      expect(vertexApiUrlForRegion('us')).toBe('https://aiplatform.us.rep.googleapis.com');
      expect(vertexApiUrlForRegion('eu')).toBe('https://aiplatform.eu.rep.googleapis.com');
    });
    it('maps a normal region to the regional host', () => {
      expect(vertexApiUrlForRegion('us-east5')).toBe('https://us-east5-aiplatform.googleapis.com');
    });
  });

  describe('regionFromClaudeSettings', () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'deck-settings-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('reads CLOUD_ML_REGION from settings.json env', () => {
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLOUD_ML_REGION: 'us' } }));
      expect(regionFromClaudeSettings(home)).toBe('us');
    });

    it('lets settings.local.json override settings.json', () => {
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLOUD_ML_REGION: 'us-east5' } }));
      writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLOUD_ML_REGION: 'eu' } }));
      expect(regionFromClaudeSettings(home)).toBe('eu');
    });

    it('returns undefined when no settings/env value exists', () => {
      expect(regionFromClaudeSettings(home)).toBeUndefined();
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      expect(regionFromClaudeSettings(home)).toBeUndefined();
    });

    it('ignores unreadable/invalid JSON', () => {
      writeFileSync(join(home, '.claude', 'settings.json'), '{ not valid json');
      expect(regionFromClaudeSettings(home)).toBeUndefined();
    });
  });

  describe('resolveVertexRegion', () => {
    it('prefers the settings region over a (possibly stale) process env region', () => {
      expect(resolveVertexRegion({ CLOUD_ML_REGION: 'us-east5' }, 'us')).toBe('us');
    });
    it('falls back to the process env region when settings is unset', () => {
      expect(resolveVertexRegion({ CLOUD_ML_REGION: 'us-east5' }, undefined)).toBe('us-east5');
    });
    it('falls back to us-east5 when neither settings nor env is set', () => {
      expect(resolveVertexRegion({}, undefined)).toBe('us-east5');
    });
  });

  describe('resolveVertexApiUrl', () => {
    it('prefers the settings region over a (possibly stale) process env CLOUD_ML_REGION', () => {
      // Mirrors the CLI: settings.json wins over an ambient/stale shell env.
      expect(resolveVertexApiUrl({ CLOUD_ML_REGION: 'us-east5' }, 'us')).toBe(
        'https://aiplatform.us.rep.googleapis.com',
      );
    });
    it('falls back to the process env region when settings is unset', () => {
      expect(resolveVertexApiUrl({ CLOUD_ML_REGION: 'us' }, undefined)).toBe(
        'https://aiplatform.us.rep.googleapis.com',
      );
    });
    it('falls back to us-east5 when neither settings nor env is set', () => {
      expect(resolveVertexApiUrl({}, undefined)).toBe('https://us-east5-aiplatform.googleapis.com');
    });
  });
});
