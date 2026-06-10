import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../server/env';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe('loadEnv — security fields', () => {
  it('defaults bindHost to 127.0.0.1 and token to null', () => {
    withEnv({ CLAUDE_DECK_BIND: undefined, CLAUDE_DECK_TOKEN: undefined, CLAUDE_DECK_ALLOWED_ROOTS: undefined }, () => {
      const env = loadEnv();
      expect(env.bindHost).toBe('127.0.0.1');
      expect(env.token).toBeNull();
      expect(env.isLoopback).toBe(true);
    });
  });

  it('marks ::1 and localhost as loopback', () => {
    withEnv({ CLAUDE_DECK_BIND: '::1' }, () => expect(loadEnv().isLoopback).toBe(true));
    withEnv({ CLAUDE_DECK_BIND: 'localhost' }, () => expect(loadEnv().isLoopback).toBe(true));
  });

  it('marks 0.0.0.0 / LAN IP as non-loopback', () => {
    withEnv({ CLAUDE_DECK_BIND: '0.0.0.0', CLAUDE_DECK_TOKEN: 'x' }, () =>
      expect(loadEnv().isLoopback).toBe(false),
    );
  });

  it('REFUSES to start when bound non-loopback with no token (fail-closed)', () => {
    withEnv({ CLAUDE_DECK_BIND: '0.0.0.0', CLAUDE_DECK_TOKEN: undefined }, () => {
      expect(() => loadEnv()).toThrow(/CLAUDE_DECK_TOKEN/);
    });
  });

  it('allows non-loopback bind when a token is set', () => {
    withEnv({ CLAUDE_DECK_BIND: '192.168.1.50', CLAUDE_DECK_TOKEN: 'secret' }, () => {
      const env = loadEnv();
      expect(env.bindHost).toBe('192.168.1.50');
      expect(env.token).toBe('secret');
    });
  });

  it('parses CLAUDE_DECK_ALLOWED_ROOTS into absolute resolved roots', () => {
    withEnv({ CLAUDE_DECK_ALLOWED_ROOTS: 'C:\\github\\claude-deck;C:\\github\\other' }, () => {
      const env = loadEnv();
      expect(env.allowedRoots.length).toBe(2);
      // resolved + normalized
      expect(env.allowedRoots[0].toLowerCase()).toContain('claude-deck');
    });
  });

  it('rejects a blank token (whitespace-only) as unset', () => {
    withEnv({ CLAUDE_DECK_BIND: '127.0.0.1', CLAUDE_DECK_TOKEN: '   ' }, () => {
      expect(loadEnv().token).toBeNull();
    });
  });
});
