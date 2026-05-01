import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionsStore } from '../../../src/stores/useSessionsStore';
import type { Session, SessionOrigin } from '../../../src/shared/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-001',
    goal_id: null,
    origin: 'external' as SessionOrigin,
    cwd: '/home/user/project',
    model: 'sonnet',
    trace_dir: null,
    display_name: null,
    parent_session_id: null,
    stream_event_count: 0,
    hook_event_count: 0,
    stderr_bytes: 0,
    started_at: 1700000000000,
    ended_at: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useSessionsStore', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [] });
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty sessions array', () => {
    expect(useSessionsStore.getState().sessions).toEqual([]);
  });

  // ── setSessions ────────────────────────────────────────────────────────────

  describe('setSessions', () => {
    it('replaces the sessions array', () => {
      const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })];
      useSessionsStore.getState().setSessions(sessions);
      expect(useSessionsStore.getState().sessions).toEqual(sessions);
    });

    it('clears sessions when set to empty array', () => {
      useSessionsStore.getState().setSessions([makeSession()]);
      useSessionsStore.getState().setSessions([]);
      expect(useSessionsStore.getState().sessions).toEqual([]);
    });

    it('overwrites previous sessions completely', () => {
      useSessionsStore.getState().setSessions([makeSession({ id: 'old' })]);
      useSessionsStore.getState().setSessions([makeSession({ id: 'new' })]);
      expect(useSessionsStore.getState().sessions).toHaveLength(1);
      expect(useSessionsStore.getState().sessions[0].id).toBe('new');
    });
  });

  // ── upsertSession ─────────────────────────────────────────────────────────

  describe('upsertSession', () => {
    it('inserts a new session when id does not exist', () => {
      const session = makeSession({ id: 'new-session' });
      useSessionsStore.getState().upsertSession(session);
      expect(useSessionsStore.getState().sessions).toHaveLength(1);
      expect(useSessionsStore.getState().sessions[0].id).toBe('new-session');
    });

    it('updates an existing session by id', () => {
      const original = makeSession({ id: 's1', model: 'sonnet' });
      useSessionsStore.getState().setSessions([original]);

      const updated = makeSession({ id: 's1', model: 'opus' });
      useSessionsStore.getState().upsertSession(updated);

      expect(useSessionsStore.getState().sessions).toHaveLength(1);
      expect(useSessionsStore.getState().sessions[0].model).toBe('opus');
    });

    it('preserves other sessions when upserting', () => {
      useSessionsStore.getState().setSessions([
        makeSession({ id: 's1' }),
        makeSession({ id: 's2' }),
      ]);

      useSessionsStore.getState().upsertSession(makeSession({ id: 's1', model: 'opus' }));

      const sessions = useSessionsStore.getState().sessions;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].model).toBe('opus');
      expect(sessions[1].id).toBe('s2');
    });

    it('appends to end when inserting new session', () => {
      useSessionsStore.getState().setSessions([makeSession({ id: 's1' })]);
      useSessionsStore.getState().upsertSession(makeSession({ id: 's2' }));

      const sessions = useSessionsStore.getState().sessions;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('s1');
      expect(sessions[1].id).toBe('s2');
    });

    it('replaces the exact index position on update', () => {
      useSessionsStore.getState().setSessions([
        makeSession({ id: 's1' }),
        makeSession({ id: 's2' }),
        makeSession({ id: 's3' }),
      ]);

      useSessionsStore.getState().upsertSession(
        makeSession({ id: 's2', ended_at: 1700003600000 }),
      );

      const sessions = useSessionsStore.getState().sessions;
      expect(sessions[1].ended_at).toBe(1700003600000);
      expect(sessions[0].id).toBe('s1');
      expect(sessions[2].id).toBe('s3');
    });

    it('handles upserting into empty store', () => {
      useSessionsStore.getState().upsertSession(makeSession({ id: 's1' }));
      expect(useSessionsStore.getState().sessions).toHaveLength(1);
    });

    it('updates session with ended_at marking completion', () => {
      useSessionsStore.getState().setSessions([
        makeSession({ id: 's1', ended_at: null }),
      ]);

      useSessionsStore.getState().upsertSession(
        makeSession({ id: 's1', ended_at: 1700003600000 }),
      );

      expect(useSessionsStore.getState().sessions[0].ended_at).toBe(1700003600000);
    });
  });
});
