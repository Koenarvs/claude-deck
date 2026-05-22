/**
 * Eval tests for DW-32238: Unarchive regression fix
 *
 * These tests define the expected behavior when restoring archived goals
 * that have title collisions with existing active goals. The fix should
 * auto-suffix with "(restored)", "(restored 2)", etc. instead of throwing
 * DuplicateGoalTitleError.
 *
 * Tests are written BEFORE the fix — most should FAIL on the current code
 * and PASS after the dev implements the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import {
  createGoalService,
  DuplicateGoalTitleError,
} from '../../../server/services/goal-service';
import type { GoalService } from '../../../server/services/goal-service';
import type { CreateGoalInput } from '../../../src/shared/types';

vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../../server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let db: Database.Database;
let goalService: GoalService;

function makeInput(overrides?: Partial<CreateGoalInput>): CreateGoalInput {
  return {
    title: 'Test Goal',
    cwd: '/tmp/test',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  goalService = createGoalService(db);
});

afterEach(() => {
  db.close();
});

describe('GoalService — unarchive with auto-suffix', () => {
  // ── Core auto-suffix behavior ──────────────────────────────────────────

  it('auto-suffixes title when restoring archived goal with title collision', () => {
    // Create and archive a goal
    const original = goalService.create(makeInput({ title: 'My Goal' }));
    goalService.archive(original.id);

    // Create another goal with the same title (now allowed since original is archived)
    goalService.create(makeInput({ title: 'My Goal' }));

    // Restore the archived goal — should auto-suffix instead of throwing
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('My Goal (restored)');
  });

  it('increments suffix when "(restored)" already exists', () => {
    // Create "My Goal", archive it
    const original = goalService.create(makeInput({ title: 'My Goal' }));
    goalService.archive(original.id);

    // Create "My Goal" and "My Goal (restored)" as active goals
    goalService.create(makeInput({ title: 'My Goal' }));
    goalService.create(makeInput({ title: 'My Goal (restored)' }));

    // Restore — should become "My Goal (restored 2)"
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('My Goal (restored 2)');
  });

  it('increments suffix to 3 when "(restored)" and "(restored 2)" both exist', () => {
    const original = goalService.create(makeInput({ title: 'My Goal' }));
    goalService.archive(original.id);

    goalService.create(makeInput({ title: 'My Goal' }));
    goalService.create(makeInput({ title: 'My Goal (restored)' }));
    goalService.create(makeInput({ title: 'My Goal (restored 2)' }));

    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('My Goal (restored 3)');
  });

  // ── Case-insensitive collision ─────────────────────────────────────────

  it('detects case-insensitive title collision and auto-suffixes', () => {
    const original = goalService.create(makeInput({ title: 'Test Goal' }));
    goalService.archive(original.id);

    // Create a goal with different casing
    goalService.create(makeInput({ title: 'test goal' }));

    // Restore — case-insensitive collision should trigger auto-suffix
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('Test Goal (restored)');
  });

  // ── No collision (regression test) ─────────────────────────────────────

  it('keeps title unchanged when no collision exists', () => {
    const original = goalService.create(makeInput({ title: 'Unique Goal' }));
    goalService.archive(original.id);

    // No other goal with this title exists
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('Unique Goal');
  });

  // ── Nested suffix (restoring a previously-restored goal) ───────────────

  it('handles restoring a goal whose title already ends with "(restored)"', () => {
    // Create "Foo (restored)" and archive it
    const original = goalService.create(makeInput({ title: 'Foo (restored)' }));
    goalService.archive(original.id);

    // Create another "Foo (restored)" while original is archived
    goalService.create(makeInput({ title: 'Foo (restored)' }));

    // Restore — should become "Foo (restored) (restored)"
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('Foo (restored) (restored)');
  });

  // ── Suffix loop bounded ────────────────────────────────────────────────

  it('has a bounded suffix loop (does not infinite-loop on mass collisions)', () => {
    const original = goalService.create(makeInput({ title: 'Popular' }));
    goalService.archive(original.id);

    // Create the base title and suffixed versions up to (restored 10)
    goalService.create(makeInput({ title: 'Popular' }));
    goalService.create(makeInput({ title: 'Popular (restored)' }));
    for (let i = 2; i <= 10; i++) {
      goalService.create(makeInput({ title: `Popular (restored ${i})` }));
    }

    // Restore should still work — should find the next available suffix
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe('Popular (restored 11)');
  });

  // ── Restore end-to-end state ───────────────────────────────────────────

  it('goal is fully active and usable after auto-suffixed restore', () => {
    const original = goalService.create(makeInput({ title: 'Work Item' }));
    goalService.archive(original.id);

    goalService.create(makeInput({ title: 'Work Item' }));

    const restored = goalService.update(original.id, { status: 'active' });

    // Status is active
    expect(restored.status).toBe('active');
    // Title was renamed
    expect(restored.title).toBe('Work Item (restored)');
    // Goal is retrievable
    const fetched = goalService.get(original.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Work Item (restored)');
    expect(fetched!.status).toBe('active');
  });

  // ── Title collision on create still throws ─────────────────────────────

  it('still throws DuplicateGoalTitleError when creating a goal with existing title', () => {
    goalService.create(makeInput({ title: 'Existing' }));

    expect(() => goalService.create(makeInput({ title: 'Existing' }))).toThrow(
      DuplicateGoalTitleError,
    );
  });

  // ── Title collision on rename still throws ─────────────────────────────

  it('still throws when renaming to an existing active title', () => {
    goalService.create(makeInput({ title: 'Goal A' }));
    const goalB = goalService.create(makeInput({ title: 'Goal B' }));

    // Renaming should fail — either DuplicateGoalTitleError or DB constraint
    expect(() => goalService.update(goalB.id, { title: 'Goal A' })).toThrow();
  });

  // ── Long title handling ────────────────────────────────────────────────

  it('handles auto-suffix on a very long title (200 chars)', () => {
    const longTitle = 'A'.repeat(200);
    const original = goalService.create(makeInput({ title: longTitle }));
    goalService.archive(original.id);

    goalService.create(makeInput({ title: longTitle }));

    // Should not throw — the suffix is added even on long titles
    const restored = goalService.update(original.id, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.title).toBe(`${longTitle} (restored)`);
  });
});
