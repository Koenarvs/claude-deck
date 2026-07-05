import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthMode, vertexFromClaudeSettings } from '../../server/auth-mode';
import { headroomEnvFragment } from '../../server/headroom-env';

describe('vertexFromClaudeSettings', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'auth-mode-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeSettings = (file: string, env: Record<string, string>) =>
    writeFileSync(join(home, '.claude', file), JSON.stringify({ env }), 'utf8');

  it('returns undefined when no settings files exist', () => {
    expect(vertexFromClaudeSettings(home)).toBeUndefined();
  });

  it('returns undefined when settings exist but do not pin the var', () => {
    writeSettings('settings.json', { CLOUD_ML_REGION: 'us-east5' });
    expect(vertexFromClaudeSettings(home)).toBeUndefined();
  });

  it('reads a truthy CLAUDE_CODE_USE_VERTEX from settings.json', () => {
    writeSettings('settings.json', { CLAUDE_CODE_USE_VERTEX: '1' });
    expect(vertexFromClaudeSettings(home)).toBe(true);
  });

  it('treats explicit 0/false as a pinned non-vertex answer', () => {
    writeSettings('settings.json', { CLAUDE_CODE_USE_VERTEX: '0' });
    expect(vertexFromClaudeSettings(home)).toBe(false);
    writeSettings('settings.json', { CLAUDE_CODE_USE_VERTEX: 'false' });
    expect(vertexFromClaudeSettings(home)).toBe(false);
  });

  it('settings.local.json wins over settings.json', () => {
    writeSettings('settings.json', { CLAUDE_CODE_USE_VERTEX: '1' });
    writeSettings('settings.local.json', { CLAUDE_CODE_USE_VERTEX: '0' });
    expect(vertexFromClaudeSettings(home)).toBe(false);
  });

  it('ignores malformed json and falls through', () => {
    writeFileSync(join(home, '.claude', 'settings.local.json'), '{not json', 'utf8');
    writeSettings('settings.json', { CLAUDE_CODE_USE_VERTEX: 'true' });
    expect(vertexFromClaudeSettings(home)).toBe(true);
  });
});

describe('resolveAuthMode', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'auth-mode-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('explicit vertex/oauth win over any ambient env', () => {
    expect(resolveAuthMode('vertex', {}, home)).toBe('vertex');
    expect(resolveAuthMode('oauth', { CLAUDE_CODE_USE_VERTEX: '1' }, home)).toBe('oauth');
    expect(resolveAuthMode('vertex', { CLAUDE_CODE_USE_VERTEX: '0' }, home)).toBe('vertex');
  });

  it('auto: truthy env var → vertex', () => {
    expect(resolveAuthMode('auto', { CLAUDE_CODE_USE_VERTEX: '1' }, home)).toBe('vertex');
    expect(resolveAuthMode('auto', { CLAUDE_CODE_USE_VERTEX: 'true' }, home)).toBe('vertex');
  });

  it('auto: explicit falsy env var → oauth without consulting settings', () => {
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }),
      'utf8',
    );
    expect(resolveAuthMode('auto', { CLAUDE_CODE_USE_VERTEX: '0' }, home)).toBe('oauth');
  });

  it('auto: unset env falls back to ~/.claude settings', () => {
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }),
      'utf8',
    );
    expect(resolveAuthMode('auto', {}, home)).toBe('vertex');
  });

  it('auto: nothing anywhere → oauth', () => {
    expect(resolveAuthMode('auto', {}, home)).toBe('oauth');
  });
});

describe('headroomEnvFragment with explicit mode', () => {
  it('mode=vertex emits ANTHROPIC_VERTEX_BASE_URL with /v1 even when env says otherwise', () => {
    expect(headroomEnvFragment('http://localhost:8787', {}, 'vertex')).toEqual({
      ANTHROPIC_VERTEX_BASE_URL: 'http://localhost:8787/v1',
    });
  });

  it('mode=oauth emits ANTHROPIC_BASE_URL even when env says vertex', () => {
    expect(
      headroomEnvFragment('http://localhost:8787', { CLAUDE_CODE_USE_VERTEX: '1' }, 'oauth'),
    ).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:8787' });
  });

  it('no mode preserves env-based behavior', () => {
    expect(
      headroomEnvFragment('http://localhost:8787', { CLAUDE_CODE_USE_VERTEX: '1' }),
    ).toEqual({ ANTHROPIC_VERTEX_BASE_URL: 'http://localhost:8787/v1' });
    expect(headroomEnvFragment('http://localhost:8787', {})).toEqual({
      ANTHROPIC_BASE_URL: 'http://localhost:8787',
    });
  });
});
